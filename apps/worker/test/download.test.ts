import * as dagCbor from "@ipld/dag-cbor";
import * as dagPb from "@ipld/dag-pb";
import { CarReader } from "@ipld/car";
import { unzipSync } from "fflate";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import { completeDag, importFile, key, type Dag } from "../src/content.js";
import type { Bindings } from "../src/env.js";
import { storeDag } from "../src/storage.js";
import { migrate } from "./migrations.js";
import { accountForGoogle } from "../src/identity.js";
import { PinService } from "../src/service.js";
import { PublicationService } from "../src/publications.js";

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2026-10-14",
    d1Databases: ["DB"],
    r2Buckets: ["BLOCKS"],
  }),
);
let env: Bindings;
const text = (value: string) => new TextEncoder().encode(value);
const get = (cid: string, query = "") =>
  app.request(
    `http://example.test/api/public/${cid}/download${query}`,
    undefined,
    env,
  );

beforeAll(async () => {
  env = await mf.getBindings<Bindings>();
  env = { ...env, PUBLIC_ORIGIN: "http://example.test" };
  await migrate(env.DB);
}, 30000);
afterAll(() => mf.dispose());

async function save(dag: Dag) {
  await storeDag(env, dag);
  return key(dag.root);
}

async function directory(children: { name: string; dag: Dag }[]): Promise<Dag> {
  const bytes = dagPb.encode(
    dagPb.prepare({
      Data: new Uint8Array([8, 1]),
      Links: children.map(({ name, dag }) => ({ Name: name, Hash: dag.root })),
    }),
  );
  const root = CID.createV1(dagPb.code, await sha256.digest(bytes));
  const blocks = new Map(children.flatMap(({ dag }) => [...dag.blocks]));
  blocks.set(key(root), bytes);
  return completeDag(root, (cid) => blocks.get(key(cid)));
}

describe("original content downloads", () => {
  it("reconstructs chunked UnixFS files byte-for-byte rather than serving their root block", async () => {
    const bytes = Uint8Array.from(
      { length: 1024 * 1024 },
      (_, index) => index % 256,
    );
    const dag = await importFile(bytes);
    expect(dag.blocks.size).toBeGreaterThan(1);
    const cid = await save(dag);
    const response = await get(cid, "?name=photo.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    expect(response.headers.get("content-disposition")).toContain(
      'filename="photo.png"',
    );
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(
      Buffer.compare(
        Buffer.from(await response.arrayBuffer()),
        Buffer.from(bytes),
      ),
    ).toBe(0);
    const car = await app.request(
      `http://example.test/api/public/${cid}/car`,
      undefined,
      env,
    );
    expect(car.status).toBe(200);
    const reader = await CarReader.fromBytes(
      new Uint8Array(await car.arrayBuffer()),
    );
    expect((await reader.getRoots())[0]!.toString()).toBe(cid);
  });

  it.each(["", "original bytes"])(
    "downloads raw and empty files (%s) with a CID fallback filename",
    async (value) => {
      const bytes = text(value);
      const cid = await save(await importFile(bytes));
      const response = await get(cid);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain(
        `filename="${cid}.bin"`,
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    },
  );

  it("preserves a UTF-8 filename in the attachment header", async () => {
    const cid = await save(await importFile(text("unicode")));
    const response = await get(cid, `?name=${encodeURIComponent("资料.txt")}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(
      `filename*=UTF-8''${encodeURIComponent("资料.txt")}`,
    );
    await response.body!.cancel();
  });

  it("creates a ZIP with nested paths, binary bytes, repeated content and empty files/directories", async () => {
    const binary = await importFile(new Uint8Array([0, 255, 1, 128]));
    const nested = await directory([
      { name: "资料.bin", dag: binary },
      { name: "empty.txt", dag: await importFile(new Uint8Array()) },
      { name: "empty-folder", dag: await directory([]) },
    ]);
    const cid = await save(
      await directory([
        { name: "nested", dag: nested },
        { name: "copy.bin", dag: binary },
      ]),
    );
    const response = await get(cid, "?name=photos");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain(
      'filename="photos.zip"',
    );
    expect(response.headers.has("content-length")).toBe(false);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(
      [
        "copy.bin",
        "nested/",
        "nested/empty-folder/",
        "nested/empty.txt",
        "nested/资料.bin",
      ].sort(),
    );
    expect(files["nested/资料.bin"]).toEqual(new Uint8Array([0, 255, 1, 128]));
    expect(files["copy.bin"]).toEqual(files["nested/资料.bin"]);
    expect(files["nested/empty.txt"]).toEqual(new Uint8Array());
    expect(files["nested/empty-folder/"]).toEqual(new Uint8Array());
  });

  it("creates a valid ZIP for an empty root directory", async () => {
    const cid = await save(await directory([]));
    const response = await get(cid);
    expect(response.headers.get("content-disposition")).toContain(
      `filename="${cid}.zip"`,
    );
    expect(unzipSync(new Uint8Array(await response.arrayBuffer()))).toEqual({});
  });

  it("reads legacy independent blocks and normalizes CIDv0 links", async () => {
    const dag = await importFile(text("legacy"));
    const root = await directory([{ name: "legacy.txt", dag }]);
    for (const [cid, bytes] of root.blocks) await env.BLOCKS.put(cid, bytes);
    const legacy = CID.createV0(
      await sha256.digest(root.blocks.get(key(root.root))!),
    ).toString();
    const response = await get(legacy);
    expect(response.status).toBe(200);
    expect(
      unzipSync(new Uint8Array(await response.arrayBuffer()))["legacy.txt"],
    ).toEqual(text("legacy"));
  });

  it.each(["../escape", "a/b", "a\\b", ".", "CON", "trailing."])(
    "rejects unsafe ZIP paths: %s",
    async (name) => {
      const cid = await save(
        await directory([{ name, dag: await importFile(text("unsafe")) }]),
      );
      const response = await get(cid);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "Unsafe archive path. Export CAR instead.",
      });
    },
  );

  it("rejects conflicting portable archive names", async () => {
    const dag = await importFile(text("duplicate"));
    const cid = await save(
      await directory([
        { name: "File.txt", dag },
        { name: "file.txt", dag },
      ]),
    );
    expect((await get(cid)).status).toBe(422);
  });

  it("limits logical output size even when repeated DAG links expand a small upload", async () => {
    const dag = await importFile(new Uint8Array(1024 * 1024));
    const cid = await save(
      await directory(
        Array.from({ length: 33 }, (_, index) => ({
          name: `${index}.bin`,
          dag,
        })),
      ),
    );
    const response = await get(cid);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: "Restored content exceeds 32 MiB",
    });
  });

  it.each(["../file", 'bad"name', "a\\b", "NUL", "x".repeat(241)])(
    "rejects unsafe attachment names: %s",
    async (name) => {
      const cid = await save(await importFile(text("filename")));
      expect((await get(cid, `?name=${encodeURIComponent(name)}`)).status).toBe(
        400,
      );
    },
  );

  it("reports invalid and missing CIDs explicitly", async () => {
    expect((await get("invalid")).status).toBe(400);
    const missing = CID.createV1(0x55, await sha256.digest(text("missing")));
    expect((await get(missing.toString())).status).toBe(404);
  });

  it("keeps arbitrary IPLD DAGs exportable as CAR but not as original files", async () => {
    const bytes = dagCbor.encode({ value: "not UnixFS" });
    const root = CID.createV1(dagCbor.code, await sha256.digest(bytes));
    const cid = await save(await completeDag(root, () => bytes));
    expect((await get(cid)).status).toBe(422);
    const car = await app.request(
      `http://example.test/api/public/${cid}/car`,
      undefined,
      env,
    );
    expect(car.status).toBe(200);
    await car.body!.cancel();
  });

  it("fails closed when an indexed CAR object is missing", async () => {
    const cid = await save(await importFile(text("lost object")));
    const row = await env.DB.prepare(
      "SELECT object_key FROM car_dags WHERE root = ?",
    )
      .bind(cid)
      .first<{ object_key: string }>();
    await env.BLOCKS.delete(row!.object_key);
    expect((await get(cid)).status).toBe(503);
  });

  it("surfaces malformed file lengths as a stream error rather than a successful truncated download", async () => {
    const child = await importFile(text("a"));
    const bytes = dagPb.encode({
      Data: new Uint8Array([8, 2, 32, 2]),
      Links: [{ Hash: child.root }],
    });
    const root = CID.createV1(dagPb.code, await sha256.digest(bytes));
    const cid = await save(
      await completeDag(root, (link) =>
        link.equals(root) ? bytes : child.blocks.get(key(link)),
      ),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await get(cid);
      await expect(response.arrayBuffer()).rejects.toThrow(
        "Traversed entire DAG but did not read enough bytes",
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("download_failed"),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("resolves publication revisions for original downloads without changing default CAR exports", async () => {
    const principal = {
      accountId: await accountForGoogle(env.DB, "download-owner"),
      scopes: [
        "pins:read",
        "pins:write",
        "pins:delete",
        "publications:read",
        "publications:write",
        "publications:delete",
      ] as const,
      kind: "session" as const,
    };
    const pins = new PinService(env, principal);
    const first = await pins.upload(
      text("first version"),
      "file",
      "private.txt",
    );
    const service = new PublicationService(env, principal);
    const created = await service.create(
      "Public title",
      first.cid,
      "download-create",
    );
    const second = await pins.upload(
      text("second version"),
      "file",
      "other.txt",
    );
    await service.publish(created.publication.id, second.cid, {
      expectedSequence: created.publication.sequence,
      requestId: "download-publish",
    });
    const path = `http://example.test/api/public/publications/${created.publication.id}/download`;
    const fixed = await app.request(
      path + "/1?format=original&name=first.txt",
      undefined,
      env,
    );
    expect(fixed.status).toBe(200);
    expect(await fixed.text()).toBe("first version");
    const current = await app.request(
      path + "?format=original",
      undefined,
      env,
    );
    expect(await current.text()).toBe("second version");
    const car = await app.request(path + "/1", undefined, env);
    expect(car.headers.get("content-type")).toContain(
      "application/vnd.ipld.car",
    );
    await car.body!.cancel();
    expect(
      (await app.request(path + "?format=wrong", undefined, env)).status,
    ).toBe(400);
    await service.delete(created.publication.id);
    expect(
      (await app.request(path + "?format=original", undefined, env)).status,
    ).toBe(404);
  });
});
