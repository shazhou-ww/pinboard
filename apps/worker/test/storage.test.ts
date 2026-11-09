import { CarReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import { buildDirectoryCar } from "@shazhou/pinboard-encoding";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as encoding from "../src/car.js";
import {
  completeDag,
  importFile,
  key,
  readCar,
  type Dag,
} from "../src/content.js";
import type { Bindings } from "../src/env.js";
import {
  getBlock,
  getCar,
  headBlock,
  readBlock,
  storeDag,
} from "../src/storage.js";
import { PinService } from "../src/service.js";
import { accountForGoogle, type Principal } from "../src/identity.js";
import app from "../src/index.js";
import { migrate } from "./migrations.js";

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2026-10-14",
    d1Databases: ["DB"],
    r2Buckets: ["BLOCKS", "LEGACY"],
  }),
);
let env: Bindings;
let principal: Principal;
const text = (value: string) => new TextEncoder().encode(value);
async function file(value: string) {
  return importFile(text(value));
}
async function publicReference(cid: string, size: number, blocks: number) {
  await env.DB.prepare(
    "INSERT INTO pins (account_id, cid, name, size, blocks, visibility) VALUES (?, ?, 'Public storage fixture', ?, ?, 'public') ON CONFLICT(account_id, cid) DO UPDATE SET visibility = 'public'",
  )
    .bind(principal.accountId, cid, size, blocks)
    .run();
}
async function* fileContent(bytes: Uint8Array) {
  yield await Promise.resolve(bytes);
}
async function directory(count: number, label: string) {
  return readCar(
    (
      await buildDirectoryCar(
        Array.from({ length: count }, (_, n) => {
          const bytes = text(`${label}-${n}`);
          return {
            path: `${n}.txt`,
            size: bytes.length,
            content: fileContent(bytes),
          };
        }),
      )
    ).bytes,
  );
}
async function responseBytes(body: ReadableStream | Uint8Array<ArrayBuffer>) {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function legacyBaseline(dag: Dag) {
  const bucket = await mf.getR2Bucket("LEGACY");
  let dataPut = 0;
  let carDataGet = 0;
  let bytes = 0;
  for (const [cid, block] of dag.blocks) {
    bytes += (await bucket.put(cid, block))!.size;
    dataPut++;
  }
  expect(await bucket.head(key(dag.root))).not.toBeNull();
  const restored = await completeDag(dag.root, async (cid) => {
    const block = await bucket.get(key(cid));
    carDataGet++;
    return block ? new Uint8Array(await block.arrayBuffer()) : undefined;
  });
  const exported = await encoding.encodeCar(restored);
  return { dataPut, carDataGet, head: 1, bytes, exported };
}

beforeAll(async () => {
  const bindings = await mf.getBindings<Bindings>();
  const bucket = bindings.BLOCKS;
  const db = bindings.DB;
  env = {
    ...bindings,
    BLOCKS: {
      ...bucket,
      get: bucket.get.bind(bucket),
      put: bucket.put.bind(bucket),
      head: bucket.head.bind(bucket),
      delete: bucket.delete.bind(bucket),
      list: bucket.list.bind(bucket),
    },
    DB: {
      ...db,
      prepare: db.prepare.bind(db),
      batch: db.batch.bind(db),
      exec: db.exec.bind(db),
      dump: db.dump.bind(db),
      withSession: db.withSession.bind(db),
    },
  };
  await migrate(env.DB);
  principal = {
    accountId: await accountForGoogle(env.DB, "storage-tests"),
    kind: "session",
    scopes: ["pins:read", "pins:write", "pins:delete"],
  };
}, 30000);
afterEach(() => vi.restoreAllMocks());
afterAll(() => mf.dispose());

describe("CAR primary storage", () => {
  it("uses one data PUT and atomic SQL publication, with independently verified offsets", async () => {
    const dag = await directory(64, "small-files");
    const baseline = await legacyBaseline(dag);
    const beforeSize = (
      await env.DB.prepare("SELECT count(*) FROM car_blocks").all()
    ).meta.size_after;
    const put = vi.spyOn(env.BLOCKS, "put");
    const batch = vi.spyOn(env.DB, "batch");
    await storeDag(env, dag);
    expect(put).toHaveBeenCalledTimes(1);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0].length).toBe(9);
    const objects = await env.BLOCKS.list();
    expect(objects.objects).toHaveLength(1);
    expect(objects.objects[0]!.key).toMatch(/^cars\//);
    const get = vi.spyOn(env.BLOCKS, "get");
    const encode = vi.spyOn(encoding, "encodeCar");
    const car = (await getCar(env, key(dag.root)))!;
    const bytes = await responseBytes(car.body);
    expect(bytes).toEqual(baseline.exported);
    expect(bytes.length).toBe(car.size);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![1]).toBeUndefined();
    expect(encode).not.toHaveBeenCalled();
    const reader = await CarReader.fromBytes(bytes);
    expect((await reader.getRoots())[0]!.equals(dag.root)).toBe(true);
    const locations = await env.DB.prepare(
      "SELECT cid, object_key, byte_offset, byte_length FROM car_blocks",
    ).all<{
      cid: string;
      object_key: string;
      byte_offset: number;
      byte_length: number;
    }>();
    for (const row of locations.results) {
      const extracted = bytes.slice(
        row.byte_offset,
        row.byte_offset + row.byte_length,
      );
      expect(extracted).toEqual(dag.blocks.get(row.cid));
      const block = await reader.get(CID.parse(row.cid));
      expect(block!.bytes).toEqual(extracted);
    }
    for (const [cid, expected] of dag.blocks) {
      get.mockClear();
      expect(await readBlock(env, cid)).toEqual(expected);
      expect(get).toHaveBeenCalledTimes(1);
      expect(get.mock.calls[0]![1]).toHaveProperty(
        "range.length",
        expected.length,
      );
      expect((await headBlock(env, cid))!.size).toBe(expected.length);
    }
    console.log(
      "CAR_STORAGE_MEASUREMENT",
      JSON.stringify({
        sample: "64-small-files",
        blocks: dag.blocks.size,
        rawBytes: dag.size,
        legacy: {
          dataPut: baseline.dataPut,
          carDataGet: baseline.carDataGet,
          head: baseline.head,
          bytes: baseline.bytes,
        },
        indexed: {
          dataPut: 1,
          carDataGet: 1,
          head: 0,
          bytes: bytes.length,
          sqlPublicationStatements: 9,
          blockRows: locations.results.length,
          indexJsonBytes: Buffer.byteLength(JSON.stringify(locations.results)),
          localD1BytesDelta: locations.meta.size_after - beforeSize,
        },
      }),
    );
  }, 30000);

  it("normalizes CARv2 and CIDv0 input without retaining independent blocks", async () => {
    const pb = dagPb.encode({ Data: text("cidv0"), Links: [] });
    const root = CID.createV0(await sha256.digest(pb));
    const v1 = await encoding.encodeCar({
      root,
      blocks: new Map([[root.toString(), pb]]),
      size: pb.length,
    });
    const v2 = new Uint8Array(51 + v1.length);
    v2.set([10, 161, 103, 118, 101, 114, 115, 105, 111, 110, 2]);
    const view = new DataView(v2.buffer);
    view.setBigUint64(27, 51n, true);
    view.setBigUint64(35, BigInt(v1.length), true);
    v2.set(v1, 51);
    const service = new PinService(env, principal);
    const pin = await service.upload(v2, "car", "v2");
    expect(pin.cid).toBe(root.toV1().toString());
    expect(await readBlock(env, root.toString())).toEqual(pb);
    expect(await env.BLOCKS.head(pin.cid)).toBeNull();
    const car = (await getCar(env, root.toString()))!;
    expect(
      (await CarReader.fromBytes(await responseBytes(car.body))).version,
    ).toBe(1);
  });

  it("reconstructs a multi-block UnixFS file using an independent reader and raw-leaf traversal", async () => {
    const bytes = Uint8Array.from(
      { length: 3 * 1024 * 1024 + 137 },
      (_, n) => (n * 31 + (n >>> 15)) % 251,
    );
    const service = new PinService(env, principal);
    const pin = await service.upload(bytes, "file", "large.bin");
    expect(pin.blocks).toBeGreaterThan(3);
    const baseline = await legacyBaseline(await importFile(bytes));
    const get = vi.spyOn(env.BLOCKS, "get");
    const car = (await getCar(env, pin.cid))!;
    const packed = await responseBytes(car.body);
    expect(get).toHaveBeenCalledTimes(1);
    const reader = await CarReader.fromBytes(packed);
    const chunks: Uint8Array[] = [];
    async function walk(cid: CID): Promise<void> {
      const block = (await reader.get(cid))!;
      expect(
        CID.createV1(cid.code, await sha256.digest(block.bytes)).equals(
          cid.toV1(),
        ),
      ).toBe(true);
      if (cid.code === 0x55) chunks.push(block.bytes);
      else
        for (const link of dagPb.decode(block.bytes).Links)
          await walk(link.Hash);
    }
    await walk(CID.parse(pin.cid));
    expect(Buffer.concat(chunks).equals(Buffer.from(bytes))).toBe(true);
    console.log(
      "CAR_STORAGE_MEASUREMENT",
      JSON.stringify({
        sample: "3MiB-plus-137-file",
        blocks: pin.blocks,
        payloadBytes: bytes.length,
        dagBytes: pin.size,
        legacyCarDataGet: baseline.carDataGet,
        indexedCarDataGet: get.mock.calls.length,
        carBytes: packed.length,
      }),
    );
  }, 30000);

  it("deduplicates within a DAG, fences retries with fresh objects, and quantifies cross-CAR duplication", async () => {
    const leaf = await file("shared-content");
    const roots: Dag[] = [];
    for (const name of ["first", "second"]) {
      const bytes = dagPb.encode({
        Data: text(name),
        Links: [{ Hash: leaf.root }, { Hash: leaf.root }],
      });
      const root = CID.createV1(dagPb.code, await sha256.digest(bytes));
      roots.push(
        await completeDag(root, (cid) =>
          key(cid) === key(root) ? bytes : leaf.blocks.get(key(cid)),
        ),
      );
    }
    for (const dag of roots) await storeDag(env, dag);
    const before = (await env.BLOCKS.list({ prefix: "cars/" })).objects.length;
    await storeDag(env, roots[0]!);
    await storeDag(env, roots[0]!);
    expect((await env.BLOCKS.list({ prefix: "cars/" })).objects).toHaveLength(
      before + 2,
    );
    const rows = await env.DB.prepare(
      "SELECT count(*) AS count FROM car_blocks WHERE cid = ?",
    )
      .bind(key(leaf.root))
      .first<{ count: number }>();
    expect(rows!.count).toBe(1);
    const cars = await Promise.all(
      roots.map(async (dag) => {
        const car = (await getCar(env, key(dag.root)))!;
        const bytes = await responseBytes(car.body);
        await expect(
          (await CarReader.fromBytes(bytes)).get(leaf.root),
        ).resolves.toMatchObject({ bytes: leaf.blocks.get(key(leaf.root)) });
        return bytes.length;
      }),
    );
    console.log(
      "CAR_STORAGE_MEASUREMENT",
      JSON.stringify({
        sample: "two-overlapping-dags",
        uniqueBlocks: 3,
        legacyBytes: roots.reduce((n, dag) => n + dag.size, 0) - leaf.size,
        carBytes: cars.reduce((n, size) => n + size, 0),
        duplicatedPayloadBytes: leaf.size,
        indexedRows: 3,
      }),
    );
  });

  it("exports legacy DAGs without a D1 lookup for every block", async () => {
    const dag = await directory(64, "legacy-query-regression");
    for (const [cid, bytes] of dag.blocks) await env.BLOCKS.put(cid, bytes);
    const prepare = vi.spyOn(env.DB, "prepare");
    const get = vi.spyOn(env.BLOCKS, "get");
    const car = (await getCar(env, key(dag.root)))!;
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledTimes(dag.blocks.size);
    const restored = await readCar(await responseBytes(car.body));
    expect(restored.blocks).toEqual(dag.blocks);
  });

  it("reads legacy and mixed DAGs, then repacks on pin without deleting legacy objects", async () => {
    const legacy = await file("legacy-only");
    for (const [cid, bytes] of legacy.blocks) await env.BLOCKS.put(cid, bytes);
    expect(await readBlock(env, key(legacy.root))).toEqual(text("legacy-only"));
    expect((await getCar(env, key(legacy.root)))!.size).toBeGreaterThan(
      legacy.size,
    );
    const child = await file("new-child");
    await storeDag(env, child);
    const bytes = dagPb.encode({
      Links: [{ Hash: legacy.root }, { Hash: child.root }],
    });
    const root = CID.createV1(dagPb.code, await sha256.digest(bytes));
    await env.BLOCKS.put(key(root), bytes);
    const mixed = (await getCar(env, key(root)))!;
    expect((await readCar(await responseBytes(mixed.body))).blocks.size).toBe(
      3,
    );
    const service = new PinService(env, principal);
    await publicReference(key(root), legacy.size + child.size, 3);
    await service.pin(key(root), "mixed");
    const get = vi.spyOn(env.BLOCKS, "get");
    await responseBytes((await getCar(env, key(root)))!.body);
    expect(get).toHaveBeenCalledTimes(1);
    await service.unpin(key(root));
    expect(await getCar(env, key(root))).not.toBeNull();
    expect(await env.BLOCKS.head(key(legacy.root))).not.toBeNull();
    await env.DB.prepare(
      "DELETE FROM deleted_pins WHERE account_id = ? AND cid = ?",
    )
      .bind(principal.accountId, key(root))
      .run();
    const uploaded = await service.upload(
      bytes,
      "block",
      "raw-parent",
      root.toString(),
    );
    expect(uploaded.blocks).toBe(3);
  });

  it("handles empty blocks, missing blocks and legacy missing roots", async () => {
    const empty = await importFile(new Uint8Array());
    await storeDag(env, empty);
    expect(await readBlock(env, key(empty.root))).toEqual(new Uint8Array());
    expect((await getBlock(env, key(empty.root)))!.size).toBe(0);
    const missing = key((await file("never-stored")).root);
    expect(await readBlock(env, missing)).toBeUndefined();
    expect(await headBlock(env, missing)).toBeNull();
    expect(await getCar(env, missing)).toBeNull();
  });

  it("publishes the maximum 256-block DAG in one transaction and streams its CAR", async () => {
    const dag = await directory(255, "maximum");
    expect(dag.blocks.size).toBe(256);
    const batch = vi.spyOn(env.DB, "batch");
    await storeDag(env, dag);
    expect(batch).toHaveBeenCalledTimes(1);
    const get = vi.spyOn(env.BLOCKS, "get");
    const car = (await getCar(env, key(dag.root)))!;
    const restored = await readCar(await responseBytes(car.body));
    expect(restored.blocks.size).toBe(256);
    expect(get).toHaveBeenCalledTimes(1);
  }, 30000);

  it("preserves indexed raw GET/HEAD, conditional validators and provider semantics", async () => {
    const dag = await file("indexed-gateway");
    await storeDag(env, dag);
    const cid = key(dag.root);
    await publicReference(cid, dag.size, dag.blocks.size);
    for (const method of ["GET", "HEAD"]) {
      const request = (headers: Record<string, string> = {}) =>
        app.request(
          `http://x/ipfs/${cid}?format=raw`,
          { method, headers },
          env,
        );
      const response = await request();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe(String(dag.size));
      expect(response.headers.get("content-disposition")).toContain(
        "attachment",
      );
      expect(response.headers.get("content-security-policy")).toContain(
        "sandbox",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.text()).toBe(
        method === "GET" ? "indexed-gateway" : "",
      );
      const get = vi.spyOn(env.BLOCKS, "get");
      const conditional = await request({ "if-none-match": `W/"${cid}.raw"` });
      expect(conditional.status).toBe(304);
      expect(conditional.body).toBeNull();
      expect(get).not.toHaveBeenCalled();
      get.mockRestore();
    }
    const routing = await app.request(
      `http://x/routing/v1/providers/${cid}`,
      {},
      env,
    );
    expect(await routing.json()).toMatchObject({ Providers: [{}] });
  });

  it("never publishes a failed R2 write or a rolled-back SQL batch, and safely retries orphans", async () => {
    const dag = await file("failure-recovery");
    const service = new PinService(env, principal);
    vi.spyOn(env.BLOCKS, "put").mockRejectedValueOnce(new Error("R2 failed"));
    await expect(
      service.upload(text("failure-recovery"), "file", "failure"),
    ).rejects.toThrow("R2 failed");
    expect(await headBlock(env, key(dag.root))).toBeNull();
    const realBatch = env.DB.batch.bind(env.DB);
    const batch = vi.spyOn(env.DB, "batch");
    // Fail the second statement inside the actual D1 transaction, not before it.
    batch.mockImplementationOnce((statements) =>
      realBatch([
        statements[0]!,
        env.DB.prepare("INSERT INTO nonexistent VALUES (1)"),
      ]),
    );
    await expect(
      service.upload(text("failure-recovery"), "file", "failure"),
    ).rejects.toThrow();
    expect(await getCar(env, key(dag.root))).toBeNull();
    expect(await headBlock(env, key(dag.root))).toBeNull();
    await expect(service.detail(key(dag.root))).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await env.DB.prepare("SELECT root FROM car_dags WHERE root = ?")
        .bind(key(dag.root))
        .first(),
    ).toBeNull();
    const count = (await env.BLOCKS.list({ prefix: "cars/" })).objects.length;
    await service.upload(text("failure-recovery"), "file", "recovered");
    expect((await env.BLOCKS.list({ prefix: "cars/" })).objects).toHaveLength(
      count + 1,
    );
    expect(await readBlock(env, key(dag.root))).toEqual(
      text("failure-recovery"),
    );
    // Simulate an ambiguous response after the database has committed.
    batch.mockImplementationOnce(async (statements) => {
      await realBatch(statements);
      throw new Error("response lost after commit");
    });
    await expect(storeDag(env, dag)).rejects.toThrow("response lost");
    await storeDag(env, dag);
    expect(await readBlock(env, key(dag.root))).toEqual(
      text("failure-recovery"),
    );
  });

  it("fails closed on missing/truncated CARs and invalid range responses", async () => {
    const dag = await file("external-corruption");
    await storeDag(env, dag);
    await publicReference(key(dag.root), dag.size, dag.blocks.size);
    const location = await env.DB.prepare(
      "SELECT object_key FROM car_blocks WHERE cid = ?",
    )
      .bind(key(dag.root))
      .first<{ object_key: string }>();
    await env.BLOCKS.delete(location!.object_key);
    for (const read of [
      () => getCar(env, key(dag.root)),
      () => headBlock(env, key(dag.root)),
      () => getBlock(env, key(dag.root)),
    ])
      await expect(read()).rejects.toMatchObject({ status: 503 });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      (await app.request(`http://x/ipfs/${key(dag.root)}?format=raw`, {}, env))
        .status,
    ).toBe(503);
    expect(
      (
        await app.request(
          `http://x/routing/v1/providers/${key(dag.root)}`,
          {},
          env,
        )
      ).status,
    ).toBe(503);
    log.mockRestore();
    await env.BLOCKS.put(location!.object_key, new Uint8Array([0]));
    await expect(headBlock(env, key(dag.root))).rejects.toMatchObject({
      status: 503,
    });

    await expect(getCar(env, key(dag.root))).rejects.toMatchObject({
      status: 503,
    });
    await storeDag(env, dag);
    const full = (await env.BLOCKS.get(location!.object_key))!;
    vi.spyOn(env.BLOCKS, "get").mockResolvedValueOnce(full);
    await expect(getBlock(env, key(dag.root))).rejects.toMatchObject({
      status: 503,
    });
  });

  it("supports concurrent identical uploads and retains correct cross-account pin boundaries", async () => {
    const bytes = text("concurrent");
    const service = new PinService(env, principal);
    const pins = await Promise.all(
      Array.from({ length: 4 }, (_, n) =>
        service.upload(bytes, "file", `copy-${n}`),
      ),
    );
    expect(new Set(pins.map((pin) => pin.cid)).size).toBe(1);
    const other = new PinService(env, {
      ...principal,
      accountId: await accountForGoogle(env.DB, "other-storage-account"),
    });
    await expect(other.detail(pins[0]!.cid)).rejects.toMatchObject({
      status: 404,
    });
    await expect(other.pin(pins[0]!.cid, "denied")).rejects.toMatchObject({
      status: 404,
    });
    await service.setVisibility(pins[0]!.cid, "public");
    await other.pin(pins[0]!.cid, "mine");
    await service.unpin(pins[0]!.cid);
    expect((await other.detail(pins[0]!.cid)).name).toBe("mine");
    expect(await readBlock(env, pins[0]!.cid)).toEqual(bytes);
  });

  it("reports failed pin saves without deleting published content and recovers on retry", async () => {
    const bytes = text("pin-save-recovery");
    const dag = await importFile(bytes);
    const service = new PinService(env, principal);
    await env.DB.prepare(
      "CREATE TRIGGER reject_storage_pin BEFORE INSERT ON pins WHEN NEW.name = 'reject-pin' BEGIN SELECT RAISE(FAIL, 'pin-save-failed'); END",
    ).run();
    try {
      await expect(service.upload(bytes, "file", "reject-pin")).rejects.toThrow(
        "pin-save-failed",
      );
      await expect(service.detail(key(dag.root))).rejects.toMatchObject({
        status: 404,
      });
      expect(await getCar(env, key(dag.root))).not.toBeNull();
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_storage_pin").run();
    }
    const recovered = await service.upload(bytes, "file", "pin-recovered");
    expect((await service.detail(recovered.cid)).name).toBe("pin-recovered");
  });

  it.runIf(process.env.PINBOARD_TEST_KUBO === "1")(
    "reconstructs a directory and multi-block file in offline Kubo",
    async () => {
      const folder = resolve(".car-storage-kubo");
      await mkdir(folder, { recursive: true });
      const bytes = Uint8Array.from(
        { length: 1024 * 1024 + 31 },
        (_, n) => (n * 17 + (n >>> 12)) % 251,
      );
      const fixture = [
        { path: "nested/payload.bin", bytes },
        { path: "empty", bytes: new Uint8Array() },
        { path: "note.txt", bytes: text("independent reconstruction") },
      ];
      try {
        const archive = await buildDirectoryCar(
          fixture.map(({ path, bytes }) => ({
            path,
            size: bytes.length,
            content: fileContent(bytes),
          })),
        );
        const service = new PinService(env, principal);
        const pin = await service.upload(archive.bytes, "car", "kubo");
        const car = (await getCar(env, pin.cid))!;
        const path = join(folder, "stored.car");
        await writeFile(path, await responseBytes(car.body));
        const run = (args: string[]) =>
          promisify(execFile)(process.env.IPFS_BIN ?? "ipfs", args, {
            env: { ...process.env, IPFS_PATH: join(folder, "repo") },
            encoding: "buffer",
            maxBuffer: 8 * 1024 * 1024,
            timeout: 30000,
          });
        await run(["init", "--profile=test", "--empty-repo"]);
        await run(["dag", "import", "--offline", path]);
        for (const file of fixture) {
          const { stdout } = await run([
            "cat",
            "--offline",
            `${pin.cid}/${file.path}`,
          ]);
          expect(stdout.equals(Buffer.from(file.bytes))).toBe(true);
        }
        console.log(
          "CAR_KUBO_RECONSTRUCTION",
          JSON.stringify({
            root: pin.cid,
            blocks: pin.blocks,
            files: fixture.length,
            bytes: fixture.reduce((n, file) => n + file.bytes.length, 0),
          }),
        );
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    60000,
  );
});
