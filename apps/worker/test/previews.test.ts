import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildDirectoryCar } from "@shazhou/pinboard-encoding";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { readFile } from "node:fs/promises";
import { PinService } from "../src/service.js";
import { accountForGoogle, type Principal } from "../src/identity.js";
import type { Bindings } from "../src/env.js";
import {
  enqueuePreview,
  getPreview,
  PREVIEW_VERSION,
  processPreview,
  refreshPreviewReferences,
  runPreviews,
  textDescription,
} from "../src/previews.js";
import { getBlock, readBlock, storeDag } from "../src/storage.js";
import { key, readCar } from "../src/content.js";
import { gateway } from "../src/gateway.js";
import { thumbnail } from "../src/preview-image.js";
import { migrate } from "./migrations.js";
import app from "../src/index.js";
import { createToken } from "../src/tokens.js";
import { expireDeleted } from "../src/recently-deleted.js";

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
let owner: Principal;
let other: Principal;
let service: PinService;
const text = (value: string) => new TextEncoder().encode(value);
beforeAll(async () => {
  const bindings = await mf.getBindings<Bindings>();
  const bucket = bindings.BLOCKS;
  const db = bindings.DB;
  env = {
    ...bindings,
    APP_NAME: "Preview tests",
    PUBLIC_ORIGIN: "https://preview.test",
    AUTH_SECRET: "synthetic-preview-node-only-not-a-real-secret",
    DB: {
      ...db,
      prepare: db.prepare.bind(db),
      batch: db.batch.bind(db),
      exec: db.exec.bind(db),
      dump: db.dump.bind(db),
      withSession: db.withSession.bind(db),
    },
    BLOCKS: {
      ...bucket,
      get: bucket.get.bind(bucket),
      head: bucket.head.bind(bucket),
      put: bucket.put.bind(bucket),
      delete: bucket.delete.bind(bucket),
      list: bucket.list.bind(bucket),
    },
  };
  await migrate(env.DB);
  owner = {
    accountId: await accountForGoogle(env.DB, "preview-owner"),
    kind: "session",
    scopes: ["pins:read", "pins:write", "pins:delete"],
  };
  other = {
    ...owner,
    accountId: await accountForGoogle(env.DB, "preview-other"),
  };
  service = new PinService(env, owner);
}, 30000);
afterAll(() => mf.dispose());

async function preview(value: Uint8Array, name = "private label.png") {
  const pin = await service.upload(value, "file", name);
  await processPreview(env, pin.cid);
  return { pin, value: await getPreview(env, pin.cid) };
}
async function count(sql: string, ...args: (string | number)[]) {
  return (await env.DB.prepare(sql)
    .bind(...args)
    .first<{ n: number }>())!.n;
}
// Exercise physical preview-GC after recovery has expired. Real recovery
// timing is covered separately in publications.test.ts.
async function releasePin(service: PinService, cid: string) {
  await service.unpin(cid);
  await env.DB.prepare("UPDATE deleted_pins SET expires_at = ? WHERE cid = ?")
    .bind(new Date().toISOString(), cid)
    .run();
  await expireDeleted(env, Date.now());
}

describe("bounded source-derived previews", () => {
  it("batches only owned previews, deduplicates CIDs and reports denied items without leaking shared metadata", async () => {
    const ownPin = await service.upload(
      text("batch owned excerpt"),
      "file",
      "private batch name",
    );
    const foreign = await new PinService(env, other).upload(
      text("foreign batch excerpt"),
      "file",
      "foreign private name",
    );
    await processPreview(env, ownPin.cid);
    const missing = CID.createV1(
      0x55,
      await sha256.digest(text("batch missing")),
    ).toString();
    const token = (
      await createToken(env, owner, {
        name: "batch-read",
        scopes: ["pins:read"],
        expiresInDays: 1,
      })
    ).token;
    const response = await app.request(
      "https://preview.test/api/pins/previews",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          cids: [ownPin.cid, foreign.cid, missing, ownPin.cid],
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result: unknown = await response.json();
    expect(result).toMatchObject({
      previews: [
        {
          cid: ownPin.cid,
          preview: {
            status: "ready",
            content: "batch owned excerpt",
          },
        },
        {
          cid: foreign.cid,
          error: { status: 404, message: "Pin not found in your account" },
        },
        {
          cid: missing,
          error: { status: 404, message: "Pin not found in your account" },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private batch name|foreign batch excerpt|foreign private name|bytes|Base64/,
    );
    expect(
      await count(
        "SELECT attempts AS n FROM content_previews WHERE source_cid = ?",
        foreign.cid,
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM content_previews WHERE source_cid = ?",
        missing,
      ),
    ).toBe(0);
    await releasePin(service, ownPin.cid);
    await releasePin(new PinService(env, other), foreign.cid);
  });

  it("bounds batch input, enforces scope/origin and limits eager generation to two jobs", async () => {
    const pins = await Promise.all(
      [0, 1, 2].map((i) =>
        service.upload(text(`batch queued ${i}`), "file", `batch ${i}`),
      ),
    );
    const exhausted = await Promise.all(
      [0, 1].map((i) =>
        service.upload(text(`batch exhausted ${i}`), "file", `failed ${i}`),
      ),
    );
    await env.DB.batch(
      exhausted.map((pin) =>
        env.DB.prepare(
          "UPDATE content_previews SET status='failed', attempts=3, descriptor=json_set(descriptor, '$.status', 'failed') WHERE source_cid=?",
        ).bind(pin.cid),
      ),
    );
    const token = (
      await createToken(env, owner, {
        name: "batch scope",
        scopes: ["pins:read"],
        expiresInDays: 1,
      })
    ).token;
    const writeOnly = (
      await createToken(env, owner, {
        name: "batch write only",
        scopes: ["pins:write"],
        expiresInDays: 1,
      })
    ).token;
    const request = (body: unknown, credential = token, origin?: string) =>
      app.request(
        "https://preview.test/api/pins/previews",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "content-type": "application/json",
            ...(origin ? { origin } : {}),
          },
          body: JSON.stringify(body),
        },
        env,
      );
    for (const body of [
      { cids: [] },
      { cids: Array(33).fill(pins[0]!.cid) },
      { cids: ["not-a-cid"] },
      { cids: [pins[0]!.cid], extra: true },
    ])
      expect((await request(body)).status).toBe(400);
    expect((await request({ cids: ["x".repeat(20000)] })).status).toBe(413);
    expect((await request({ cids: [pins[0]!.cid] }, writeOnly)).status).toBe(
      403,
    );
    expect(
      (await request({ cids: [pins[0]!.cid] }, token, "https://evil.test"))
        .status,
    ).toBe(403);
    expect(
      (
        await app.request(
          "https://preview.test/api/pins/previews",
          {
            method: "POST",
            headers: { origin: "https://preview.test" },
            body: JSON.stringify({ cids: [pins[0]!.cid] }),
          },
          env,
        )
      ).status,
    ).toBe(401);
    const pending: Promise<unknown>[] = [];
    const response = await app.request(
      "https://preview.test/api/pins/previews",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          cids: [...exhausted, ...pins].map((pin) => pin.cid),
        }),
      },
      env,
      {
        waitUntil(work) {
          pending.push(work);
        },
        passThroughOnException() {},
        props: {},
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("previews.length", 5);
    await Promise.all(pending);
    const states = await Promise.all(
      pins.map((pin) => getPreview(env, pin.cid)),
    );
    expect(states.filter((state) => state.status === "ready")).toHaveLength(2);
    expect(states.filter((state) => state.status === "pending")).toHaveLength(
      1,
    );
    await Promise.all(
      [...pins, ...exhausted].map((pin) => releasePin(service, pin.cid)),
    );
  });

  it("authorizes the lazy endpoint before accessing shared metadata and returns a typed, private description", async () => {
    const pin = await service.upload(
      text("authorized endpoint excerpt"),
      "file",
      "private endpoint name",
    );
    const token = (
      await createToken(env, owner, {
        name: "test",
        scopes: owner.scopes,
        expiresInDays: 1,
      })
    ).token;
    const otherToken = (
      await createToken(env, other, {
        name: "test",
        scopes: other.scopes,
        expiresInDays: 1,
      })
    ).token;
    const writeOnly = (
      await createToken(env, owner, {
        name: "write",
        scopes: ["pins:write"],
        expiresInDays: 1,
      })
    ).token;
    const path = `https://preview.test/api/pins/${pin.cid}/preview`;
    const pending: Promise<unknown>[] = [];
    const response = await app.request(
      path,
      { headers: { authorization: `Bearer ${token}` } },
      env,
      {
        waitUntil(work) {
          pending.push(work);
        },
        passThroughOnException() {},
        props: {},
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      status: "pending",
      contentType: "application/vnd.pinboard.file+json",
    });
    await Promise.all(pending);
    const ready = await app.request(
      path,
      { headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(await ready.json()).toMatchObject({
      status: "ready",
      contentType: "text/markdown",
      content: "authorized endpoint excerpt",
    });
    expect(
      (
        await app.request(
          path,
          { headers: { authorization: `Bearer ${otherToken}` } },
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          path,
          { headers: { authorization: `Bearer ${writeOnly}` } },
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          path,
          {
            headers: {
              authorization: `Bearer ${token}`,
              origin: "https://evil.test",
            },
          },
          env,
        )
      ).status,
    ).toBe(403);
    expect((await app.request(path, {}, env)).status).toBe(401);
  });
  it("keeps a successful pin when enqueueing fails, logs the error and lets bounded backfill recover", async () => {
    const original = env.DB.prepare.bind(env.DB);
    const prepare = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      if (sql.includes("INSERT OR IGNORE INTO content_previews"))
        throw new Error("synthetic enqueue failure");
      return original(sql);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let cid: string;
    try {
      cid = (
        await service.upload(
          text("persist despite enqueue failure"),
          "file",
          "saved independently",
        )
      ).cid;
      expect((await service.detail(cid)).cid).toBe(cid);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("preview_scheduling_failed"),
      );
    } finally {
      prepare.mockRestore();
      log.mockRestore();
    }
    await runPreviews(env);
    expect((await getPreview(env, cid!)).status).toBe("ready");
  });
  it("uses display Markdown without interpreting ordinary punctuation or links", async () => {
    const source =
      "# not an invented heading\n*literal* [link](https://bad.test)\n<img src='https://bad.test/x'>";
    const { pin, value } = await preview(
      text(source),
      "private-markdown-label",
    );
    expect(value.status).toBe("ready");
    expect(value.contentType).toBe("text/markdown");
    expect(value.content).toContain("\\# not an invented heading");
    expect(value.content).toContain("\\*literal\\*");
    expect(JSON.stringify(value)).not.toContain("private-markdown-label");
    const raw = await env.DB.prepare(
      "SELECT descriptor FROM content_previews WHERE source_cid = ?",
    )
      .bind(pin.cid)
      .first<{ descriptor: string }>();
    expect(raw!.descriptor).not.toContain("private-markdown-label");
    expect(JSON.stringify(await service.list())).not.toMatch(
      /descriptor|bytes|base64/iu,
    );
  });
  it("preserves structured code and bounds excerpts including UTF-8 boundaries", () => {
    const source = '{ "code": "```", "html": "<script>alert(1)</script>" }';
    const result = textDescription(text(source), BigInt(text(source).length))!;
    expect(result.content).toBe("````\n" + source + "\n````");
    const long = textDescription(text("文".repeat(9000)), 27000n)!;
    expect(long.truncated).toBe(true);
    expect(Array.from(long.content as string)).toHaveLength(2400);
    const emoji = "😀".repeat(1500);
    expect(
      textDescription(text(emoji), BigInt(text(emoji).length)),
    ).toMatchObject({
      truncated: false,
      content: emoji,
    });
    expect(textDescription(new Uint8Array([0xc3]), 1n)).toBeNull();
    expect(textDescription(new Uint8Array([0xc3]), 2n)).not.toBeNull();
  });
  it.each([
    ["%PDF-1.7\nactual document", "application/pdf"],
    ["GIF89a\u0000", "image/gif"],
    ["<svg><script>alert(1)</script></svg>", undefined],
    ["<!doctype html><html><img src='https://bad.test'></html>", undefined],
    ["\u0000binary", undefined],
  ])(
    "returns an explicit unsupported placeholder for %s",
    async (source, type) => {
      const { value } = await preview(text(source), "deceptive.jpg");
      expect(value.status).toBe("unsupported");
      expect(value.contentType).toBe("application/vnd.pinboard.file+json");
      expect(value.content).toMatchObject({
        size: text(source).length,
        ...(type ? { mediaType: type } : {}),
      });
    },
  );
  it("classifies imported UnixFS directories, bounds actual names/layers and does not reimport ordinary .car files", async () => {
    const files = [
      {
        path: "photos/portrait.jpg",
        content: await readFile(
          new URL("fixtures/portrait.jpg", import.meta.url),
        ),
      },
      { path: "notes/readme.txt", content: text("real contents") },
      ...Array.from({ length: 28 }, (_, n) => ({
        path: `docs/item-${n}.txt`,
        content: text(String(n)),
      })),
    ];
    const car = await buildDirectoryCar(
      files.map((file) => ({
        path: file.path,
        size: file.content.length,
        content: (async function* () {
          yield await Promise.resolve(file.content);
        })(),
      })),
    );
    const imported = await service.upload(
      car.bytes,
      "car",
      "not-a-directory.exe",
    );
    await processPreview(env, imported.cid);
    const value = await getPreview(env, imported.cid);
    expect(value.status).toBe("ready");
    expect(value.contentType).toBe("application/vnd.pinboard.directory+json");
    if (value.contentType !== "application/vnd.pinboard.directory+json")
      throw new Error("not directory");
    expect(value.content.entries.length).toBeLessThanOrEqual(24);
    expect(
      value.content.entries.some((entry) => entry.kind === "directory"),
    ).toBe(true);
    expect(value.content.entries.some((entry) => entry.depth === 1)).toBe(true);
    expect(value.content.total).toBeUndefined();
    expect(value.truncated).toBe(true);
    const ordinary = await service.upload(car.bytes, "file", "archive.car");
    await processPreview(env, ordinary.cid);
    expect(ordinary.cid).not.toBe(imported.cid);
    expect((await getPreview(env, ordinary.cid)).contentType).toBe(
      "application/vnd.pinboard.file+json",
    );
  });
  it("reports a verified complete directory total and never confuses chunked files with folders", async () => {
    const bytes = text("file".repeat(100000));
    const pin = await service.upload(bytes, "file", "large.dat");
    expect(pin.blocks).toBeGreaterThan(1);
    await processPreview(env, pin.cid);
    expect((await getPreview(env, pin.cid)).contentType).toBe("text/markdown");
    const car = await buildDirectoryCar([
      {
        path: "readme.txt",
        size: 2,
        content: (async function* () {
          yield await Promise.resolve(text("hi"));
        })(),
      },
    ]);
    const dir = await service.upload(car.bytes, "car", "folder");
    await processPreview(env, dir.cid);
    expect(await getPreview(env, dir.cid)).toMatchObject({
      truncated: false,
      content: {
        total: 1,
        entries: [{ name: "readme.txt", kind: "file", depth: 0 }],
      },
    });
  });
  it("logs failures, leaves pins saved and bounds retries with an atomic lease", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { pin, value } = await preview(
        new Uint8Array([255, 216, 255, 0, 0, 0]),
      );
      expect(value.status).toBe("failed");
      expect(await service.detail(pin.cid)).toMatchObject({ cid: pin.cid });
      const start = Date.now();
      await Promise.all([
        processPreview(env, pin.cid, start + 3600000),
        processPreview(env, pin.cid, start + 3600000),
      ]);
      await processPreview(env, pin.cid, start + 7200000);
      await processPreview(env, pin.cid, start + 10800000);
      expect(
        await count(
          "SELECT attempts AS n FROM content_previews WHERE source_cid = ?",
          pin.cid,
        ),
      ).toBe(3);
      expect(spy).toHaveBeenCalledTimes(3);
      expect((await getPreview(env, pin.cid)).reason).toContain("3 attempts");
    } finally {
      spy.mockRestore();
    }
  });
  it("lazily backfills existing pins and recovers abandoned last-attempt leases", async () => {
    const pin = await service.upload(text("legacy backfill"), "file", "legacy");
    await env.DB.prepare("DELETE FROM content_previews WHERE source_cid = ?")
      .bind(pin.cid)
      .run();
    await runPreviews(env);
    expect((await getPreview(env, pin.cid)).status).toBe("ready");
    await env.DB.prepare(
      "UPDATE content_previews SET status = 'pending', attempts = 3, lease = 'lost', lease_until = '2000-01-01' WHERE source_cid = ?",
    )
      .bind(pin.cid)
      .run();
    await runPreviews(env);
    expect(await getPreview(env, pin.cid)).toMatchObject({
      status: "failed",
      reason: "Preview worker exhausted 3 attempts",
    });
  });
});

describe("real images, CID delivery and retention references", () => {
  it("stores actual BLOB bytes under their raw CID and delivers cacheable images and verified raw blocks", async () => {
    const { pin, value } = await preview(
      await readFile(new URL("fixtures/photo.jpg", import.meta.url)),
    );
    expect(value.status).toBe("ready");
    if (value.contentType !== "image/webp") throw new Error("not image");
    const cid = value.content.cid;
    const stored = await env.DB.prepare(
      "SELECT typeof(bytes) AS kind, length(bytes) AS n FROM preview_images WHERE cid = ?",
    )
      .bind(cid)
      .first<{ kind: string; n: number }>();
    expect(stored!.kind).toBe("blob");
    expect(stored!.n).toBeLessThanOrEqual(65536);
    const image = await gateway.request(
      `http://local/ipfs/${cid}`,
      { headers: { accept: "image/avif,image/webp,*/*" } },
      env,
    );
    const bytes = new Uint8Array(await image.arrayBuffer());
    expect(image.headers.get("content-type")).toBe("image/webp");
    expect(image.headers.get("cache-control")).toContain("immutable");
    expect(CID.createV1(0x55, await sha256.digest(bytes)).toString()).toBe(cid);
    expect(cid).not.toBe(pin.cid);
    expect(value.content.url).toBe(`/ipfs/${cid}`);
    const etag = image.headers.get("etag")!;
    expect(
      (
        await gateway.request(
          `http://local/ipfs/${cid}`,
          { headers: { accept: "image/webp", "if-none-match": etag } },
          env,
        )
      ).status,
    ).toBe(304);
    const head = await gateway.request(
      `http://local/ipfs/${cid}`,
      { method: "HEAD" },
      env,
    );
    expect(await head.text()).toBe("");
    expect(Number(head.headers.get("content-length"))).toBe(bytes.length);
    const raw = await gateway.request(
      `http://local/ipfs/${cid}?format=raw`,
      {},
      env,
    );
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);
    expect(await readBlock(env, cid)).toEqual(bytes);
    expect(await getBlock(env, cid)).not.toBeNull();
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM pins WHERE cid = ?")
        .bind(cid)
        .first<{ n: number }>())!.n,
    ).toBe(0);
  });
  it("allows distinct originals to share a thumbnail; protects accounts, direct pins, version swaps and racing repins", async () => {
    // Trailing JPEG bytes change source identity but not decoded pixels.
    const source = await readFile(
      new URL("fixtures/portrait.jpg", import.meta.url),
    );
    const a = await preview(source);
    const altered = new Uint8Array(source.length + 1);
    altered.set(source);
    const b = await preview(altered);
    if (
      a.value.contentType !== "image/webp" ||
      b.value.contentType !== "image/webp"
    )
      throw new Error("not images");
    const cid = a.value.content.cid;
    expect(a.pin.cid).not.toBe(b.pin.cid);
    expect(b.value.content.cid).toBe(cid);
    const second = new PinService(env, other);
    await second.pin(a.pin.cid, "account two secret");
    await releasePin(service, a.pin.cid);
    await releasePin(service, b.pin.cid);
    const future = Date.now() + 8 * 86400000;
    await runPreviews(env, future);
    expect(await readBlock(env, cid)).toBeDefined();
    const direct = await second.pin(cid, "direct thumbnail");
    expect(direct.cid).toBe(cid);
    await releasePin(second, a.pin.cid);
    await runPreviews(env, future + 8 * 86400000);
    expect(await readBlock(env, cid)).toBeDefined();
    await releasePin(second, cid);
    // Simulate an old generation retained in the same schema.
    await env.DB.prepare(
      "UPDATE content_previews SET version = ? WHERE source_cid = ?",
    )
      .bind(PREVIEW_VERSION - 1, a.pin.cid)
      .run();
    await env.DB.prepare(
      "UPDATE preview_images SET unreferenced_at = '2000-01-01' WHERE cid = ?",
    )
      .bind(cid)
      .run();
    // A repin concurrent with collection must win a serializable D1 recheck.
    await Promise.all([
      second.pin(a.pin.cid, "racing reference"),
      runPreviews(env, future + 16 * 86400000),
    ]);
    await enqueuePreview(env, a.pin.cid);
    await processPreview(env, a.pin.cid);
    const regenerated = await getPreview(env, a.pin.cid);
    expect(regenerated.status).toBe("ready");
    expect(await readBlock(env, cid)).toBeDefined();
    await releasePin(second, a.pin.cid);
    await env.DB.prepare(
      "UPDATE preview_images SET unreferenced_at = ? WHERE cid = ?",
    )
      .bind(new Date(Date.now() - 6 * 86400000).toISOString(), cid)
      .run();
    await runPreviews(env);
    expect(
      await env.DB.prepare("SELECT cid FROM preview_images WHERE cid = ?")
        .bind(cid)
        .first(),
    ).not.toBeNull();
    await env.DB.prepare(
      "UPDATE preview_images SET unreferenced_at = '2000-01-01' WHERE cid = ?",
    )
      .bind(cid)
      .run();
    await runPreviews(env);
    expect(
      await env.DB.prepare("SELECT cid FROM preview_images WHERE cid = ?")
        .bind(cid)
        .first(),
    ).toBeNull();
  });
  it("resets liveness in the same transaction as references rather than deleting on Unpin", async () => {
    const { pin, value } = await preview(
      await readFile(new URL("fixtures/transparent.png", import.meta.url)),
    );
    if (value.contentType !== "image/webp") throw new Error("not image");
    await releasePin(service, pin.cid);
    const cid = value.content.cid;
    const orphan = await env.DB.prepare(
      "SELECT unreferenced_at FROM preview_images WHERE cid = ?",
    )
      .bind(cid)
      .first<{ unreferenced_at: string }>();
    expect(typeof orphan!.unreferenced_at).toBe("string");
    await service.pin(pin.cid, "new private name");
    expect(
      await env.DB.prepare(
        "SELECT unreferenced_at FROM preview_images WHERE cid = ?",
      )
        .bind(cid)
        .first(),
    ).toMatchObject({ unreferenced_at: null });
    await env.DB.batch([refreshPreviewReferences(env.DB)]);
    expect(
      (
        await thumbnail(
          await readFile(new URL("fixtures/transparent.png", import.meta.url)),
        )
      ).bytes.length,
    ).toBeLessThanOrEqual(65536);
  });
  it("atomically republishes a directly pinned thumbnail if GC wins while its R2 PUT is suspended", async () => {
    const { pin, value } = await preview(
      await readFile(new URL("fixtures/photo.png", import.meta.url)),
    );
    if (value.contentType !== "image/webp") throw new Error("not image");
    const cid = value.content.cid;
    await releasePin(service, pin.cid);
    await env.DB.prepare(
      "UPDATE preview_images SET unreferenced_at = '2000-01-01' WHERE cid = ?",
    )
      .bind(cid)
      .run();
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalPut = env.BLOCKS.put.bind(env.BLOCKS);
    const spy = vi
      .spyOn(env.BLOCKS, "put")
      .mockImplementation(async (...args) => {
        started();
        await blocked;
        return originalPut(...args);
      });
    try {
      const pinning = new PinService(env, other).pin(
        cid,
        "direct pin during collection",
      );
      await entered;
      await runPreviews(env);
      expect(
        await env.DB.prepare("SELECT cid FROM preview_images WHERE cid = ?")
          .bind(cid)
          .first(),
      ).toBeNull();
      release();
      await pinning;
      expect(
        await env.DB.prepare(
          "SELECT unreferenced_at FROM preview_images WHERE cid = ?",
        )
          .bind(cid)
          .first(),
      ).toMatchObject({ unreferenced_at: null });
      const image = await gateway.request(
        `http://local/ipfs/${cid}`,
        { headers: { accept: "image/webp" } },
        env,
      );
      expect(image.headers.get("content-type")).toBe("image/webp");
      expect(
        CID.createV1(
          0x55,
          await sha256.digest(new Uint8Array(await image.arrayBuffer())),
        ).toString(),
      ).toBe(cid);
    } finally {
      release();
      spy.mockRestore();
    }
  });
  it.each(["car", "block", "pin"] as const)(
    "republishes a thumbnail DAG member when GC wins during %s's suspended R2 PUT",
    async (kind) => {
      const { pin, value } = await preview(
        await readFile(new URL("fixtures/transparent.png", import.meta.url)),
      );
      if (value.contentType !== "image/webp") throw new Error("not image");
      const cid = value.content.cid;
      const bytes = (await readBlock(env, cid))!;
      const car = await buildDirectoryCar([
        {
          path: "nested/thumbnail.webp",
          size: bytes.length,
          content: (async function* () {
            yield await Promise.resolve(bytes);
          })(),
        },
      ]);
      const dag = await readCar(car.bytes);
      if (kind !== "car") await storeDag(env, dag);
      await releasePin(service, pin.cid);
      await env.DB.prepare(
        "UPDATE preview_images SET unreferenced_at = '2000-01-01' WHERE cid = ?",
      )
        .bind(cid)
        .run();
      let started!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalPut = env.BLOCKS.put.bind(env.BLOCKS);
      const spy = vi
        .spyOn(env.BLOCKS, "put")
        .mockImplementation(async (...args) => {
          started();
          await blocked;
          return originalPut(...args);
        });
      const second = new PinService(env, other);
      let directoryCid: string | undefined;
      try {
        const importing =
          kind === "pin"
            ? second.pin(key(dag.root), "indirect thumbnail reference")
            : second.upload(
                kind === "car" ? car.bytes : dag.blocks.get(key(dag.root))!,
                kind,
                "indirect thumbnail reference",
                kind === "block" ? key(dag.root) : undefined,
              );
        await entered;
        await runPreviews(env);
        expect(
          await env.DB.prepare("SELECT cid FROM preview_images WHERE cid = ?")
            .bind(cid)
            .first(),
        ).toBeNull();
        release();
        directoryCid = (await importing).cid;
        expect(
          await count(
            "SELECT count(*) AS n FROM dag_members WHERE root = ? AND cid = ?",
            directoryCid,
            cid,
          ),
        ).toBe(1);
        const image = await gateway.request(
          `http://local/ipfs/${cid}`,
          { headers: { accept: "image/webp" } },
          env,
        );
        expect(image.status, await image.clone().text()).toBe(200);
        expect(image.headers.get("content-type")).toBe("image/webp");
        expect(
          CID.createV1(
            0x55,
            await sha256.digest(new Uint8Array(await image.arrayBuffer())),
          ).toString(),
        ).toBe(cid);
        expect(
          await env.DB.prepare(
            "SELECT unreferenced_at FROM preview_images WHERE cid = ?",
          )
            .bind(cid)
            .first(),
        ).toMatchObject({ unreferenced_at: null });
        expect(
          await count("SELECT count(*) AS n FROM pins WHERE cid = ?", cid),
        ).toBe(0);
      } finally {
        release();
        spy.mockRestore();
        if (directoryCid) await releasePin(second, directoryCid);
      }
    },
  );
  it("treats a pinned DAG containing thumbnail bytes as a reference and grants a fresh grace period after its removal", async () => {
    const { pin, value } = await preview(
      await readFile(new URL("fixtures/transparent.png", import.meta.url)),
    );
    if (value.contentType !== "image/webp") throw new Error("not image");
    const cid = value.content.cid;
    const bytes = (await readBlock(env, cid))!;
    const car = await buildDirectoryCar([
      {
        path: "thumbnail.webp",
        size: bytes.length,
        content: (async function* () {
          yield await Promise.resolve(bytes);
        })(),
      },
    ]);
    const folder = await new PinService(env, other).upload(
      car.bytes,
      "car",
      "folder containing image bytes",
    );
    await releasePin(service, pin.cid);
    await runPreviews(env, Date.now() + 8 * 86400000);
    expect(
      await env.DB.prepare(
        "SELECT unreferenced_at FROM preview_images WHERE cid = ?",
      )
        .bind(cid)
        .first(),
    ).toMatchObject({ unreferenced_at: null });
    await releasePin(new PinService(env, other), folder.cid);
    const row = await env.DB.prepare(
      "SELECT unreferenced_at FROM preview_images WHERE cid = ?",
    )
      .bind(cid)
      .first<{ unreferenced_at: string }>();
    expect(Date.now() - Date.parse(row!.unreferenced_at)).toBeLessThan(5000);
    await runPreviews(env);
    expect(
      await env.DB.prepare("SELECT cid FROM preview_images WHERE cid = ?")
        .bind(cid)
        .first(),
    ).not.toBeNull();
  });
  it("retains the last published version while the replacement is pending or failed, and switches the active reference atomically", async () => {
    const { pin, value } = await preview(
      await readFile(new URL("fixtures/photo.jpg", import.meta.url)),
    );
    if (value.contentType !== "image/webp") throw new Error("not image");
    await env.DB.prepare(
      "UPDATE content_previews SET version = 0, descriptor = json_set(descriptor, '$.version', 0) WHERE source_cid = ? AND version = 1",
    )
      .bind(pin.cid)
      .run();
    await enqueuePreview(env, pin.cid);
    await env.DB.prepare(
      "UPDATE content_previews SET status = 'failed', attempts = 3 WHERE source_cid = ? AND version = 1",
    )
      .bind(pin.cid)
      .run();
    await runPreviews(env, Date.now() + 8 * 86400000);
    expect(
      await env.DB.prepare(
        "SELECT active FROM content_previews WHERE source_cid = ? AND version = 0",
      )
        .bind(pin.cid)
        .first(),
    ).toMatchObject({ active: 1 });
    expect(
      await env.DB.prepare("SELECT cid FROM preview_images WHERE cid = ?")
        .bind(value.content.cid)
        .first(),
    ).not.toBeNull();
    await env.DB.prepare(
      "UPDATE content_previews SET status = 'pending', attempts = 0, retry_at = '2000-01-01' WHERE source_cid = ? AND version = 1",
    )
      .bind(pin.cid)
      .run();
    await processPreview(env, pin.cid);
    expect(
      await env.DB.prepare(
        "SELECT active FROM content_previews WHERE source_cid = ? AND version = 0",
      )
        .bind(pin.cid)
        .first(),
    ).toMatchObject({ active: 0 });
    expect(
      await env.DB.prepare(
        "SELECT active FROM content_previews WHERE source_cid = ? AND version = 1",
      )
        .bind(pin.cid)
        .first(),
    ).toMatchObject({ active: 1 });
  });
  it("retires a previous version's different resource only after grace, without treating its still-pinned source as a current image reference", async () => {
    const old = await preview(
      await readFile(new URL("fixtures/transparent.png", import.meta.url)),
    );
    const current = await preview(
      await readFile(new URL("fixtures/portrait.jpg", import.meta.url)),
    );
    if (
      old.value.contentType !== "image/webp" ||
      current.value.contentType !== "image/webp"
    )
      throw new Error("not images");
    const oldCid = old.value.content.cid;
    const currentCid = current.value.content.cid;
    expect(oldCid).not.toBe(currentCid);
    await releasePin(service, old.pin.cid);
    // Reference-only version-swap fixture using two genuinely encoded BLOBs;
    // source fidelity is tested by the actual decoder/encoder cases separately.
    await env.DB.prepare(
      "INSERT INTO content_previews (source_cid, version, status, descriptor, thumbnail_cid, retry_at) VALUES (?, 0, 'ready', ?, ?, ?)",
    )
      .bind(
        current.pin.cid,
        JSON.stringify({ ...old.value, version: 0 }),
        oldCid,
        new Date().toISOString(),
      )
      .run();
    const start = Date.now();
    await runPreviews(env, start);
    await runPreviews(env, start + 6 * 86400000);
    expect(
      await env.DB.prepare("SELECT cid FROM preview_images WHERE cid = ?")
        .bind(oldCid)
        .first(),
    ).not.toBeNull();
    await runPreviews(env, start + 8 * 86400000);
    expect(
      await env.DB.prepare("SELECT cid FROM preview_images WHERE cid = ?")
        .bind(oldCid)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT cid FROM preview_images WHERE cid = ?")
        .bind(currentCid)
        .first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT source_cid FROM content_previews WHERE source_cid = ? AND version = 0",
      )
        .bind(current.pin.cid)
        .first(),
    ).toBeNull();
    expect((await getPreview(env, current.pin.cid)).status).toBe("ready");
  });
});
