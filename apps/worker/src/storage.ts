import { CarIndexer } from "@ipld/car";
import { HTTPException } from "hono/http-exception";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
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

export async function storeDag(env: Storage, dag: Dag): Promise<void> {
  const bytes = await encodeCar(dag);
  const objectKey = `cars/${CID.createV1(0x55, await sha256.digest(bytes)).toString()}.car`;
  const index = await CarIndexer.fromBytes(bytes);
  const rows: [string, number, number][] = [];
  for await (const block of index)
    rows.push([key(block.cid), block.blockOffset, block.blockLength]);
  // Content-addressed retries are safe even if a previous D1 commit's response
  // was lost. Never delete on error: another writer may reference this object.
  await env.BLOCKS.put(objectKey, bytes, {
    httpMetadata: { contentType: "application/vnd.ipld.car; version=1" },
  });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO car_dags (root, object_key, size) VALUES (?, ?, ?) ON CONFLICT(root) DO NOTHING",
    ).bind(key(dag.root), objectKey, bytes.length),
    env.DB.prepare(
      "INSERT INTO car_blocks (cid, object_key, byte_offset, byte_length) SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?) WHERE true ON CONFLICT(cid) DO NOTHING",
    ).bind(objectKey, JSON.stringify(rows)),
  ]);
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
  const dag = await completeDag(root, (link) => readBlock(env, key(link)));
  const bytes = await encodeCar(dag);
  return { body: bytes, size: bytes.length };
}
