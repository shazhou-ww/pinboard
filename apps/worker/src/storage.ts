import { CarIndexer } from "@ipld/car";
import { HTTPException } from "hono/http-exception";
import { encodeCar } from "./car.js";
import { completeDag, key, parseCid, type Dag } from "./content.js";
import type { Bindings } from "./env.js";

type Storage = Pick<Bindings, "DB" | "BLOCKS">;
interface Location {
  object_key: string;
  byte_offset: number;
  byte_length: number;
}

function unavailable(): never {
  throw new HTTPException(503, { message: "Stored CAR is unavailable" });
}

export async function storeDag(env: Storage, dag: Dag): Promise<string> {
  const bytes = await encodeCar(dag);
  // Never reuse a key: a delayed GC delete or abandoned PUT must not touch a
  // concurrent repin's archive.
  const objectKey = `cars/${crypto.randomUUID()}.car`;
  const index = await CarIndexer.fromBytes(bytes);
  const rows: [string, number, number][] = [];
  for await (const block of index)
    rows.push([key(block.cid), block.blockOffset, block.blockLength]);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO storage_objects (object_key, state, unreferenced_at, retry_at) VALUES (?, 'writing', ?, ?)",
  )
    .bind(objectKey, now, now)
    .run();
  await env.BLOCKS.put(objectKey, bytes, {
    httpMetadata: { contentType: "application/vnd.ipld.car; version=1" },
  });
  await env.DB.batch([
    writeGuard(env.DB, objectKey, "writing"),
    env.DB.prepare(
      "INSERT INTO car_dags (root, object_key, size) VALUES (?, ?, ?) ON CONFLICT(root) DO UPDATE SET object_key = excluded.object_key, size = excluded.size",
    ).bind(key(dag.root), objectKey, bytes.length),
    env.DB.prepare(
      "INSERT INTO car_blocks (cid, object_key, byte_offset, byte_length) SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?) WHERE true ON CONFLICT(cid) DO UPDATE SET object_key = excluded.object_key, byte_offset = excluded.byte_offset, byte_length = excluded.byte_length",
    ).bind(objectKey, JSON.stringify(rows)),
    env.DB.prepare(
      "INSERT INTO object_blocks (object_key, cid) SELECT ?, json_extract(value, '$[0]') FROM json_each(?)",
    ).bind(objectKey, JSON.stringify(rows)),
    ...dagStatements(env.DB, dag, now),
    env.DB.prepare(
      "UPDATE storage_objects SET state = 'ready' WHERE object_key = ?",
    ).bind(objectKey),
  ]);
  return objectKey;
}

export function writeGuard(
  db: D1Database,
  objectKey: string,
  state: "writing" | "ready",
): D1PreparedStatement {
  // A CHECK constraint aborts the entire publication transaction if GC has
  // claimed the object while a writer was suspended outside D1.
  return db
    .prepare(
      "INSERT OR REPLACE INTO retention_write_guard (id) VALUES (CASE WHEN EXISTS (SELECT 1 FROM storage_objects WHERE object_key = ? AND state = ?) THEN 1 ELSE 0 END)",
    )
    .bind(objectKey, state);
}

export function dagStatements(
  db: D1Database,
  dag: Dag,
  now: string,
): D1PreparedStatement[] {
  const root = key(dag.root);
  const members = JSON.stringify([...dag.blocks.keys()]);
  return [
    db.prepare("INSERT OR IGNORE INTO dag_roots (root) VALUES (?)").bind(root),
    db
      .prepare(
        "INSERT OR IGNORE INTO dag_members (root, cid) SELECT ?, value FROM json_each(?)",
      )
      .bind(root, members),
    db
      .prepare(
        "INSERT OR IGNORE INTO retained_blocks (cid, unreferenced_at) SELECT value, ? FROM json_each(?)",
      )
      .bind(now, members),
    db
      .prepare(
        "UPDATE retained_blocks SET unreferenced_at = NULL WHERE cid IN (SELECT cid FROM dag_members WHERE root = ?) AND EXISTS (SELECT 1 FROM pins WHERE cid = ?)",
      )
      .bind(root, root),
  ];
}

async function locate(env: Storage, cid: string): Promise<Location | null> {
  return env.DB.prepare(
    "SELECT object_key, byte_offset, byte_length FROM car_blocks WHERE cid = ?",
  )
    .bind(key(parseCid(cid)))
    .first<Location>();
}

export async function headBlock(
  env: Storage,
  cid: string,
): Promise<{ size: number } | null> {
  const location = await locate(env, cid);
  if (!location) return env.BLOCKS.head(key(parseCid(cid)));
  const object = await env.BLOCKS.head(location.object_key);
  if (!object || object.size < location.byte_offset + location.byte_length)
    unavailable();
  return { size: location.byte_length };
}

export async function getBlock(
  env: Storage,
  cid: string,
): Promise<{ size: number; body: ReadableStream } | null> {
  const location = await locate(env, cid);
  if (!location) return env.BLOCKS.get(key(parseCid(cid)));
  if (location.byte_length === 0) {
    await headBlock(env, cid);
    return { size: 0, body: new Blob([]).stream() };
  }
  const object = await env.BLOCKS.get(location.object_key, {
    range: { offset: location.byte_offset, length: location.byte_length },
  });
  if (
    !object ||
    !object.range ||
    !("offset" in object.range) ||
    object.range.offset !== location.byte_offset ||
    object.range.length !== location.byte_length
  )
    unavailable();
  return { size: location.byte_length, body: object.body };
}

export async function readBlock(
  env: Storage,
  cid: string,
): Promise<Uint8Array | undefined> {
  const object = await getBlock(env, cid);
  return object
    ? new Uint8Array(await new Response(object.body).arrayBuffer())
    : undefined;
}

export async function getCar(
  env: Storage,
  cid: string,
): Promise<{
  body: ReadableStream | Uint8Array<ArrayBuffer>;
  size: number;
} | null> {
  const root = parseCid(cid);
  const manifest = await env.DB.prepare(
    "SELECT object_key, size FROM car_dags WHERE root = ?",
  )
    .bind(key(root))
    .first<{ object_key: string; size: number }>();
  if (manifest) {
    const object = await env.BLOCKS.get(manifest.object_key);
    if (!object || object.size !== manifest.size) unavailable();
    return { body: object.body, size: manifest.size };
  }
  if (!(await headBlock(env, key(root)))) return null;
  const dag = await completeDag(root, async (link) => {
    const legacy = await env.BLOCKS.get(key(link));
    return legacy
      ? new Uint8Array(await legacy.arrayBuffer())
      : readBlock(env, key(link));
  });
  const bytes = await encodeCar(dag);
  return { body: bytes, size: bytes.length };
}
