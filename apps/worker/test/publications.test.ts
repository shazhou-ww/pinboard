import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { migrate } from "./migrations.js";
import type { Bindings } from "../src/env.js";
import { accountForGoogle, type Principal } from "../src/identity.js";
import { PublicationService, publicationHistory } from "../src/publications.js";
import { PinService } from "../src/service.js";
import {
  expireDeleted,
  listDeleted,
  RECOVERY_MS,
  restorePin,
} from "../src/recently-deleted.js";
import { runRetention, CONTENT_RETENTION_MS } from "../src/retention.js";
import { readBlock, getCar } from "../src/storage.js";
import app from "../src/index.js";
import { handleMcp } from "../src/mcp.js";
import { scopes, type Scope } from "../src/schemas.js";
import { getPreview, processPreview, runPreviews } from "../src/previews.js";
import { readFile } from "node:fs/promises";
import { createToken } from "../src/tokens.js";
import type {
  DeletedItem,
  Publication,
  PublicationResult,
} from "@shazhou/pinboard-contracts";
import { CID } from "multiformats/cid";
import { CarReader } from "@ipld/car";
import { completeDag, importFile, key } from "../src/content.js";
import * as dagCbor from "@ipld/dag-cbor";
import { sha256 } from "multiformats/hashes/sha2";
import { DescriptionService } from "../src/descriptions.js";

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
let pins: PinService;
let publications: PublicationService;
let counter = 0;
const write = (expectedSequence: number) => ({
  expectedSequence,
  requestId: `request-${++counter}`,
});
const upload = async () =>
  pins.upload(
    new TextEncoder().encode(`publication content ${++counter}`),
    "file",
    "Private label",
  );
async function legacyPin() {
  const child = await importFile(
    new TextEncoder().encode(`legacy publication ${++counter}`),
  );
  const bytes = dagCbor.encode({ child: child.root });
  const root = CID.createV1(dagCbor.code, await sha256.digest(bytes));
  const dag = await completeDag(root, (cid) =>
    cid.equals(root) ? bytes : child.blocks.get(key(cid)),
  );
  for (const [cid, bytes] of dag.blocks) await env.BLOCKS.put(cid, bytes);
  const cid = key(dag.root);
  await env.DB.prepare(
    "INSERT INTO pins (account_id, cid, name, size, blocks) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(
      owner.accountId,
      cid,
      "Private legacy label",
      dag.size,
      dag.blocks.size,
    )
    .run();
  return { dag, pin: await pins.detail(cid) };
}
async function httpRequest(path: string, init?: RequestInit) {
  const pending: Promise<unknown>[] = [];
  const response = await app.request(origin + path, init, env, {
    waitUntil(work) {
      pending.push(work);
    },
    passThroughOnException() {},
    props: {},
  });
  await Promise.all(pending);
  return response;
}
async function client(principal = owner, allowed: readonly Scope[] = scopes) {
  const { token } = await createToken(env, principal, {
    name: "publication HTTP boundary tests",
    scopes: allowed,
    expiresInDays: 1,
  });
  return (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    return httpRequest(path, { ...init, headers });
  };
}
const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const origin = "http://example.test";
beforeAll(async () => {
  const bindings = await mf.getBindings<Bindings>();
  const db = bindings.DB;
  const bucket = bindings.BLOCKS;
  env = {
    ...bindings,
    BLOCKS: {
      ...bucket,
      put: bucket.put.bind(bucket),
      get: bucket.get.bind(bucket),
      head: bucket.head.bind(bucket),
      list: bucket.list.bind(bucket),
      delete: bucket.delete.bind(bucket),
    },
    DB: {
      ...db,
      prepare: db.prepare.bind(db),
      batch: db.batch.bind(db),
      exec: db.exec.bind(db),
      dump: db.dump.bind(db),
      withSession: db.withSession.bind(db),
    },
    APP_NAME: "Pinboard",
    PUBLIC_ORIGIN: origin,
    AUTH_URL: origin + "/api/auth",
    AUTH_SECRET: "publication-test-secret-long-enough",
  };
  await migrate(env.DB);
  owner = {
    accountId: await accountForGoogle(env.DB, "publication-owner"),
    kind: "session",
    scopes,
  };
  pins = new PinService(env, owner);
  publications = new PublicationService(env, owner);
}, 30000);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => mf.dispose());

describe("scoped node descriptions and conversion", () => {
  it("migrates existing Pins and publication revisions additively without rewriting their data", async () => {
    const old = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: "export default { fetch() { return new Response('ok'); } };",
        compatibilityDate: "2026-10-14",
        d1Databases: ["DB"],
        r2Buckets: ["BLOCKS"],
      }),
    );
    try {
      const bindings = await old.getBindings<Bindings>();
      const local = { ...env, DB: bindings.DB, BLOCKS: bindings.BLOCKS };
      await migrate(local.DB, { through: "0006_publications.sql" });
      const principal = {
        ...owner,
        accountId: await accountForGoogle(local.DB, "old-migration-account"),
      };
      const pin = await new PinService(local, principal).upload(
        new TextEncoder().encode("Legacy bytes stay fixed"),
        "file",
        "Old private name",
      );
      const now = new Date().toISOString();
      await local.DB.batch([
        local.DB.prepare(
          "INSERT INTO publications (id, account_id, title, current_revision, sequence, created_at, updated_at) VALUES ('old-publication', ?, 'Old public title', 1, 1, ?, ?)",
        ).bind(principal.accountId, now, now),
        local.DB.prepare(
          "INSERT INTO publication_revisions (publication_id, revision, cid, size, blocks, created_at) VALUES ('old-publication', 1, ?, ?, ?, ?)",
        ).bind(pin.cid, pin.size, pin.blocks, now),
        local.DB.prepare(
          "INSERT INTO publication_retention (publication_id, cid) VALUES ('old-publication', ?)",
        ).bind(pin.cid),
      ]);
      await migrate(local.DB, { after: "0006_publications.sql" });
      expect(
        (await publicationHistory(local, "old-publication")).revisions[0]!
          .descriptions,
      ).toEqual({});
      expect(await new PinService(local, principal).detail(pin.cid)).toEqual(
        pin,
      );
      const descriptions = new DescriptionService(local, principal);
      await descriptions.write(pin.cid, pin.cid, {
        text: "New private sidecar",
        expectedVersion: 0,
      });
      expect(
        (await publicationHistory(local, "old-publication")).revisions[0]!
          .descriptions,
      ).toEqual({});
      expect(await readBlock(local, pin.cid)).toEqual(
        new TextEncoder().encode("Legacy bytes stay fixed"),
      );
    } finally {
      await old.dispose();
    }
  }, 30000);

  it("persists root and reachable child metadata with CAS, clear tombstones, isolation and pure-text limits", async () => {
    const { pin, dag } = await legacyPin();
    const node = [...dag.blocks.keys()].find((cid) => cid !== pin.cid)!;
    const service = new DescriptionService(env, owner);
    expect((await service.read(pin.cid, node)).description.user).toEqual({
      text: null,
      version: 0,
    });
    expect(
      (
        await service.write(pin.cid, node, {
          text: "<b>plain text</b>\nchild",
          expectedVersion: 0,
        })
      ).description.user.version,
    ).toBe(1);
    await processPreview(env, node);
    const generatedChild = await service.read(pin.cid, node);
    expect(generatedChild.description.preview.status).toBe("ready");
    expect(generatedChild.description.user.text).toBe(
      "<b>plain text</b>\nchild",
    );
    await service.write(pin.cid, pin.cid, { text: "root", expectedVersion: 0 });
    expect((await service.export(pin.cid)).descriptions).toEqual({
      [node]: "<b>plain text</b>\nchild",
      [pin.cid]: "root",
    });
    await expect(
      service.write(pin.cid, node, { text: "lost update", expectedVersion: 0 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.write(pin.cid, node, { text: "lost update", expectedVersion: 8 }),
    ).rejects.toMatchObject({ status: 409 });
    const results = await Promise.allSettled([
      service.write(pin.cid, node, { text: "winner A", expectedVersion: 1 }),
      service.write(pin.cid, node, { text: "winner B", expectedVersion: 1 }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const cleared = await service.write(pin.cid, node, {
      text: null,
      expectedVersion: 2,
    });
    expect(cleared.description.user).toEqual({ text: null, version: 3 });
    expect((await service.export(pin.cid)).descriptions).toEqual({
      [pin.cid]: "root",
    });
    await service.write(pin.cid, node, { text: "", expectedVersion: 3 });
    expect((await service.export(pin.cid)).descriptions[node]).toBe("");
    await expect(
      service.write(pin.cid, node, {
        text: "x".repeat(8001),
        expectedVersion: 4,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.write(pin.cid, node, { text: "\0", expectedVersion: 4 }),
    ).rejects.toMatchObject({ status: 400 });
    const otherPin = await upload();
    await expect(service.read(otherPin.cid, node)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.write(otherPin.cid, node, {
        text: "unreachable",
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const other: Principal = {
      ...owner,
      accountId: await accountForGoogle(env.DB, "description-other"),
    };
    const otherService = new DescriptionService(env, other);
    await expect(otherService.read(pin.cid, node)).rejects.toMatchObject({
      status: 404,
    });
    await new PinService(env, other).pin(pin.cid, "Different private label");
    expect(
      (await otherService.read(pin.cid, node)).description.user.text,
    ).toBeNull();
    await otherService.write(pin.cid, node, {
      text: "other account",
      expectedVersion: 0,
    });
    expect((await service.read(pin.cid, node)).description.user.text).toBe("");
    const childPin = await pins.pin(node, "Shared child as root");
    await service.write(childPin.cid, node, {
      text: "other root",
      expectedVersion: 0,
    });
    expect((await service.read(pin.cid, node)).description.user.text).toBe("");
    const limited = new DescriptionService(env, {
      ...owner,
      scopes: ["pins:read"],
    });
    await expect(
      limited.write(pin.cid, node, { text: "forbidden", expectedVersion: 4 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      new DescriptionService(env, { ...owner, scopes: [] }).read(pin.cid, node),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("publishes immutable per-revision maps, leaves names and bytes untouched, and keeps same-CID NOP honest", async () => {
    const first = await upload();
    const second = await upload();
    const service = new DescriptionService(env, owner);
    await service.write(first.cid, first.cid, {
      text: "original",
      expectedVersion: 0,
    });
    const before = await getCar(env, first.cid);
    const bytes = new Uint8Array(
      await new Response(before!.body).arrayBuffer(),
    );
    const created = await publications.create(
      "Explicit public title",
      first.cid,
      write(1).requestId,
    );
    expect(created.publication.current.descriptions).toEqual({
      [first.cid]: "original",
    });
    expect((await pins.detail(first.cid)).name).toBe("Private label");
    await service.write(first.cid, first.cid, {
      text: "draft only",
      expectedVersion: 1,
    });
    const nop = await publications.publish(
      created.publication.id,
      first.cid,
      write(1),
    );
    expect(nop.status).toBe("nop");
    expect(nop.publication.current.descriptions).toEqual({
      [first.cid]: "original",
    });
    const next = await publications.publish(
      created.publication.id,
      second.cid,
      write(1),
    );
    const republished = await publications.publish(
      created.publication.id,
      first.cid,
      write(next.publication.sequence),
    );
    expect(republished.publication.current.descriptions).toEqual({
      [first.cid]: "draft only",
    });
    const independent = await publications.create(
      "Different publication",
      first.cid,
      write(1).requestId,
    );
    await service.write(first.cid, first.cid, {
      text: "future",
      expectedVersion: 2,
    });
    expect(independent.publication.current.descriptions).toEqual({
      [first.cid]: "draft only",
    });
    const history = await publicationHistory(env, created.publication.id);
    expect(history.revisions.at(-1)!.descriptions).toEqual({
      [first.cid]: "original",
    });
    expect(
      new Uint8Array(
        await new Response((await getCar(env, first.cid))!.body).arrayBuffer(),
      ),
    ).toEqual(bytes);
    await pins.unpin(first.cid);
    await expect(service.read(first.cid, first.cid)).rejects.toMatchObject({
      status: 404,
    });
    await restorePin(env, owner, first.cid);
    expect(
      (await service.read(first.cid, first.cid)).description.user.text,
    ).toBe("future");
    const otherOwner: Principal = {
      ...owner,
      accountId: await accountForGoogle(env.DB, "expiry-isolated-owner"),
    };
    await new PinService(env, otherOwner).pin(
      first.cid,
      "Another owner retains this root",
    );
    const otherDescriptions = new DescriptionService(env, otherOwner);
    await otherDescriptions.write(first.cid, first.cid, {
      text: "Independent retained text",
      expectedVersion: 0,
    });
    await pins.unpin(first.cid);
    await env.DB.prepare(
      "UPDATE deleted_pins SET expires_at = ? WHERE account_id = ? AND cid = ?",
    )
      .bind("2000-01-01", owner.accountId, first.cid)
      .run();
    await expireDeleted(env, Date.now());
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM node_descriptions WHERE account_id = ? AND root_cid = ?",
      )
        .bind(owner.accountId, first.cid)
        .first(),
    ).toBeNull();
    expect(
      (await publicationHistory(env, created.publication.id)).revisions.at(-1)!
        .descriptions,
    ).toEqual({ [first.cid]: "original" });
    expect(
      (await otherDescriptions.read(first.cid, first.cid)).description.user
        .text,
    ).toBe("Independent retained text");
    expect(await readBlock(env, first.cid)).toBeDefined();
  });

  it("converts atomically and idempotently without trash, duplicate cards, lost CID retention or metadata", async () => {
    const pin = await upload();
    const descriptions = new DescriptionService(env, owner);
    await descriptions.write(pin.cid, pin.cid, {
      text: "v1 text",
      expectedVersion: 0,
    });
    const requestId = write(1).requestId;
    const attempts = await Promise.all([
      publications.create("Public conversion", pin.cid, requestId, true),
      publications.create("Public conversion", pin.cid, requestId, true),
    ]);
    expect(attempts[0]).toEqual(attempts[1]);
    const result = attempts[0];
    expect(result.status).toBe("converted");
    expect(result.publication.id).not.toBe(pin.cid);
    expect(result.publication.current.descriptions).toEqual({
      [pin.cid]: "v1 text",
    });
    expect(
      (await publications.publish(result.publication.id, pin.cid, write(1)))
        .status,
    ).toBe("nop");
    expect((await pins.list()).pins.some((item) => item.cid === pin.cid)).toBe(
      false,
    );
    await expect(pins.detail(pin.cid)).rejects.toMatchObject({ status: 404 });
    await expect(descriptions.read(pin.cid, pin.cid)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await listDeleted(env, owner)).items.some((item) => item.id === pin.cid),
    ).toBe(false);
    await expect(
      publications.create("Different", pin.cid, requestId, true),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      publications.create("Different", pin.cid, write(1).requestId, true),
    ).rejects.toMatchObject({ status: 404 });
    await expect(restorePin(env, owner, pin.cid)).rejects.toMatchObject({
      status: 404,
    });
    const id = result.publication.id;
    await publications.delete(id);
    await runRetention(env);
    expect(await readBlock(env, pin.cid)).toBeDefined();
    await publications.restore(id);
    expect((await pins.list()).pins.some((item) => item.cid === pin.cid)).toBe(
      false,
    );
    expect(
      (await publicationHistory(env, id)).revisions[0]!.descriptions,
    ).toEqual({ [pin.cid]: "v1 text" });
    await publications.delete(id);
    await env.DB.prepare("UPDATE publications SET expires_at = ? WHERE id = ?")
      .bind("2000-01-01", id)
      .run();
    await expireDeleted(env, Date.now());
    await expect(publicationHistory(env, id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("lets only one of competing conversion identities win and checks existing scopes", async () => {
    const pin = await upload();
    const results = await Promise.allSettled([
      publications.create("A", pin.cid, write(1).requestId, true),
      publications.create("B", pin.cid, write(1).requestId, true),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    const remaining = await upload();
    await expect(
      new PublicationService(env, {
        ...owner,
        scopes: ["pins:read", "publications:write"],
      }).create("No delete scope", remaining.cid, write(1).requestId, true),
    ).rejects.toMatchObject({ status: 403 });
    expect((await pins.detail(remaining.cid)).cid).toBe(remaining.cid);
  });

  it("rolls back the complete conversion handoff on source-removal failure and retries the same identity safely", async () => {
    const pin = await upload();
    const service = new DescriptionService(env, owner);
    await service.write(pin.cid, pin.cid, {
      text: "Must not lose",
      expectedVersion: 0,
    });
    const requestId = write(1).requestId;
    await env.DB.prepare(
      `CREATE TRIGGER reject_conversion BEFORE DELETE ON pins WHEN OLD.cid = '${pin.cid}' BEGIN SELECT RAISE(ABORT, 'conversion failure fixture'); END`,
    ).run();
    try {
      await expect(
        publications.create("Atomic conversion", pin.cid, requestId, true),
      ).rejects.toThrow();
      expect(await pins.detail(pin.cid)).toEqual(pin);
      expect((await service.read(pin.cid, pin.cid)).description.user.text).toBe(
        "Must not lose",
      );
      expect(
        await env.DB.prepare(
          "SELECT 1 FROM publication_requests WHERE account_id = ? AND request_id = ?",
        )
          .bind(owner.accountId, requestId)
          .first(),
      ).toBeNull();
      expect(
        await env.DB.prepare(
          "SELECT 1 FROM publications WHERE account_id = ? AND title = ?",
        )
          .bind(owner.accountId, "Atomic conversion")
          .first(),
      ).toBeNull();
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_conversion").run();
    }
    expect(
      (await publications.create("Atomic conversion", pin.cid, requestId, true))
        .publication.current.descriptions,
    ).toEqual({ [pin.cid]: "Must not lose" });
  });

  it("snapshots the actual transaction-time description map, not a stale client pre-read", async () => {
    const pin = await upload();
    const service = new DescriptionService(env, owner);
    await service.write(pin.cid, pin.cid, {
      text: "Before race",
      expectedVersion: 0,
    });
    const batch = env.DB.batch.bind(env.DB);
    let updated = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (!updated && statements.length === 8) {
        updated = true;
        await service.write(pin.cid, pin.cid, {
          text: "Commit-time snapshot",
          expectedVersion: 1,
        });
      }
      return batch(statements);
    });
    const result = await publications.create(
      "Snapshot race",
      pin.cid,
      write(1).requestId,
    );
    expect(updated).toBe(true);
    expect(result.publication.current.descriptions).toEqual({
      [pin.cid]: "Commit-time snapshot",
    });
    expect(
      (await publicationHistory(env, result.publication.id)).revisions[0]!
        .descriptions,
    ).toEqual({ [pin.cid]: "Commit-time snapshot" });
  });

  it("keeps descriptions independent of preview retries and cleanup", async () => {
    const pin = await upload();
    const service = new DescriptionService(env, owner);
    await service.write(pin.cid, pin.cid, {
      text: "Do not replace",
      expectedVersion: 0,
    });
    await processPreview(env, pin.cid);
    await env.DB.prepare(
      "UPDATE content_previews SET status = 'failed' WHERE source_cid = ?",
    )
      .bind(pin.cid)
      .run();
    await processPreview(env, pin.cid);
    await runPreviews(env);
    await env.DB.prepare("DELETE FROM content_previews WHERE source_cid = ?")
      .bind(pin.cid)
      .run();
    expect((await service.read(pin.cid, pin.cid)).description.user).toEqual({
      text: "Do not replace",
      version: 1,
    });
  });

  it("uses MCP tools for scoped reads, CAS writes, explicit export and conversion, without extending old token permissions", async () => {
    const call = await client();
    const invoke = async (
      name: string,
      args: Record<string, unknown>,
      request = call,
    ) => {
      const response = await request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      expect(response.status).toBe(200);
      return (
        await response.json<{
          result: { content: { text: string }[]; isError?: boolean };
        }>()
      ).result;
    };
    const pin = await upload();
    const context = { rootCid: pin.cid, nodeCid: pin.cid };
    const saved = await invoke("description_set", {
      ...context,
      text: "MCP user text",
      expectedVersion: 0,
    });
    expect(saved.isError).not.toBe(true);
    expect(JSON.parse(saved.content[0]!.text)).toMatchObject({
      description: { user: { text: "MCP user text", version: 1 } },
    });
    const read = await invoke("description_get", context);
    expect(JSON.parse(read.content[0]!.text)).toMatchObject({
      description: { user: { text: "MCP user text" } },
    });
    const exported = await invoke("description_export", { rootCid: pin.cid });
    expect(JSON.parse(exported.content[0]!.text)).toEqual({
      rootCid: pin.cid,
      descriptions: { [pin.cid]: "MCP user text" },
    });
    expect(
      (
        await invoke("description_set", {
          ...context,
          text: "stale",
          expectedVersion: 0,
        })
      ).isError,
    ).toBe(true);
    expect(
      (await invoke("description_set", { ...context, text: "missing version" }))
        .isError,
    ).toBe(true);
    const old = await client(owner, ["pins:read", "pins:write", "pins:delete"]);
    expect(
      (
        await invoke(
          "publication_convert",
          {
            cid: pin.cid,
            title: "Not allowed",
            public: true,
            requestId: write(1).requestId,
          },
          old,
        )
      ).isError,
    ).toBe(true);
    const converted = await invoke("publication_convert", {
      cid: pin.cid,
      title: "MCP convert",
      public: true,
      requestId: write(1).requestId,
    });
    expect(converted.isError).not.toBe(true);
    const result = JSON.parse(converted.content[0]!.text) as PublicationResult;
    expect(result.status).toBe("converted");
    const fixed = await invoke("publication_get", {
      id: result.publication.id,
      revision: 1,
    });
    expect(JSON.parse(fixed.content[0]!.text)).toMatchObject({
      revision: { descriptions: { [pin.cid]: "MCP user text" } },
    });
    const nodeRead = await invoke("publication_description", {
      id: result.publication.id,
      revision: 1,
      nodeCid: pin.cid,
    });
    expect(JSON.parse(nodeRead.content[0]!.text)).toMatchObject({
      description: { user: { text: "MCP user text", version: 1 } },
    });
    expect((await invoke("description_get", context)).isError).toBe(true);
  });

  it("serves real HTTP node metadata and public snapshots with reachability, ETags, deleted-before-304 and strict writes", async () => {
    const call = await client();
    const { pin, dag } = await legacyPin();
    await pins.pin(pin.cid, pin.name);
    const node = [...dag.blocks.keys()].find((cid) => cid !== pin.cid)!;
    const path = `/api/pins/${pin.cid}/nodes/${node}/description`;
    const saved = await call(
      path,
      json({ text: "HTTP child", expectedVersion: 0 }, "PUT"),
    );
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("private, no-store");
    expect(
      (
        await saved.json<{
          description: { user: { text: string }; preview: unknown };
        }>()
      ).description,
    ).toMatchObject({
      user: { text: "HTTP child" },
      preview: { status: expect.any(String) as unknown },
    });
    expect((await call(path)).status).toBe(200);
    const failPreview = async () => {
      const preview = await getPreview(env, node);
      await env.DB.prepare(
        "UPDATE content_previews SET status = 'failed', descriptor = ?, retry_at = ?, lease_until = NULL WHERE source_cid = ?",
      )
        .bind(
          JSON.stringify({ ...preview, status: "failed" }),
          new Date(0).toISOString(),
          node,
        )
        .run();
    };
    await failPreview();
    expect((await call(path)).status).toBe(200);
    await failPreview();
    expect(
      (
        await call(
          path,
          json({ text: "HTTP child", expectedVersion: 1 }, "PUT"),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          path,
          json({ text: "HTTP child", expectedVersion: 2 }, "PUT"),
        )
      ).status,
    ).toBe(200);
    await env.DB.prepare("DELETE FROM content_previews WHERE source_cid = ?")
      .bind(node)
      .run();
    expect((await call(path)).status).toBe(200);
    expect(
      (await new DescriptionService(env, owner).read(pin.cid, node)).description
        .user.text,
    ).toBe("HTTP child");
    expect((await call(`/api/pins/${pin.cid}/descriptions`)).status).toBe(200);
    expect(
      (
        await call(
          path,
          json({ text: "x", expectedVersion: 1, extra: true }, "PUT"),
        )
      ).status,
    ).toBe(400);
    expect((await call(path, json({ text: "x" }, "PUT"))).status).toBe(400);
    const converted = await call(
      `/api/pins/${pin.cid}/convert`,
      json({
        title: "HTTP convert",
        public: true,
        requestId: write(1).requestId,
      }),
    );
    expect(converted.status).toBe(201);
    const { publication } = await converted.json<PublicationResult>();
    const publicRoot = await httpRequest(
      `/api/public/publications/${publication.id}/versions/1/nodes/${pin.cid}/description`,
    );
    expect(
      (
        await publicRoot.json<{
          description: { user: { text: string | null } };
        }>()
      ).description.user.text,
    ).toBeNull();
    const publicPath = `/api/public/publications/${publication.id}/versions/1/nodes/${node}/description`;
    const response = await httpRequest(publicPath);
    expect(response.status).toBe(200);
    const publishedNode = await response.json<{
      description: { user: { text: string }; preview: { status: string } };
    }>();
    expect(publishedNode.description.user.text).toBe("HTTP child");
    expect(publishedNode.description.preview.status).toBe("ready");
    const etag = response.headers.get("etag")!;
    expect(
      (
        await httpRequest(publicPath, {
          headers: { "if-none-match": `W/${etag}` },
        })
      ).status,
    ).toBe(304);
    const unrelated = await upload();
    expect(
      (await httpRequest(publicPath.replace(node, unrelated.cid))).status,
    ).toBe(404);
    expect((await call(path)).status).toBe(404);
    await publications.delete(publication.id);
    expect(
      (await httpRequest(publicPath, { headers: { "if-none-match": etag } }))
        .status,
    ).toBe(404);
    await publications.restore(publication.id);
    expect(
      (await httpRequest(publicPath, { headers: { "if-none-match": "*" } }))
        .status,
    ).toBe(304);
    expect(
      (
        await httpRequest(
          `/api/pins/${unrelated.cid}/convert`,
          json({
            title: "Anonymous",
            public: true,
            requestId: write(1).requestId,
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(`/api/pins/${unrelated.cid}/convert`, {
          ...json({
            title: "Cross origin",
            public: true,
            requestId: write(1).requestId,
          }),
          headers: {
            "content-type": "application/json",
            Origin: "https://evil.example",
          },
        })
      ).status,
    ).toBe(403);
  });
});

describe("publication HTTP boundaries", () => {
  it("uses authenticated management routes for publish, owned reads, rollback, delete and original-ID restore", async () => {
    const call = await client();
    const pin = await upload();
    expect(
      (
        await call(
          "/api/publications",
          json({
            title: "Not consented",
            cid: pin.cid,
            public: false,
            requestId: write(1).requestId,
          }),
        )
      ).status,
    ).toBe(400);
    const created = await call(
      "/api/publications",
      json({
        title: "HTTP lifecycle",
        cid: pin.cid,
        public: true,
        requestId: write(1).requestId,
      }),
    );
    expect(created.status).toBe(201);
    const { publication } = await created.json<PublicationResult>();
    const path = `/api/publications/${publication.id}`;
    const owned = await call(path);
    expect(owned.headers.get("cache-control")).toBe("private, no-store");
    expect(await owned.json()).toEqual(publication);
    expect((await httpRequest(path)).status).toBe(401);
    const second = await upload();
    const published = await call(
      path + "/publish",
      json({
        cid: second.cid,
        ...write(1),
      }),
    );
    expect(
      (await published.json<PublicationResult>()).publication,
    ).toMatchObject({
      sequence: 2,
      currentRevision: 2,
    });
    const rollback = await call(
      path + "/rollback",
      json({
        revision: 1,
        ...write(2),
      }),
    );
    expect(await rollback.json()).toMatchObject({
      status: "rolled-back",
      publication: { id: publication.id, sequence: 3, revisionCount: 2 },
    });
    const nop = write(3);
    expect(
      await (
        await call(path + "/rollback", json({ revision: 1, ...nop }))
      ).json(),
    ).toMatchObject({ status: "nop", publication: { sequence: 3 } });
    expect(
      (await call(path + "/rollback", json({ revision: 99, ...write(3) })))
        .status,
    ).toBe(404);
    expect((await call(path, { method: "DELETE" })).status).toBe(204);
    expect((await call(path)).status).toBe(404);
    expect(
      (await call(path + "/publish", json({ cid: second.cid, ...write(3) })))
        .status,
    ).toBe(404);
    const restored = await call(path + "/restore", { method: "POST" });
    expect(await restored.json()).toMatchObject({
      id: publication.id,
      sequence: 4,
      currentRevision: 1,
      revisionCount: 2,
    });
    expect((await call(path + "/restore", { method: "POST" })).status).toBe(
      404,
    );
    expect(
      (await call("/api/publications?cursor=" + "x".repeat(257))).status,
    ).toBe(400);
    const list = await call("/api/publications?cursor=" + publication.id);
    expect(list.headers.get("cache-control")).toBe("private, no-store");
    expect(
      (await list.json<{ publications: Publication[] }>()).publications.every(
        (item) => item.id > publication.id,
      ),
    ).toBe(true);
  });

  it("validates binary upload consent, CAS headers, kind, name and body before reporting complete or partial success", async () => {
    const call = await client();
    const pin = await upload();
    const { publication } = await publications.create(
      "HTTP upload boundaries",
      pin.cid,
      write(1).requestId,
    );
    const path = `/api/publications/${publication.id}/upload`;
    const bytes = new TextEncoder().encode(`HTTP binary upload ${++counter}`);
    const headers = () => ({
      "x-pinboard-public": "true",
      "idempotency-key": write(1).requestId,
      "if-publication-sequence": "1",
    });
    const send = (
      query: string,
      input: Record<string, string>,
      body: Uint8Array<ArrayBuffer> | undefined = bytes,
    ) => call(path + query, { method: "POST", headers: input, body });
    expect((await send("?kind=file", {})).status).toBe(400);
    expect(
      (
        await send("?kind=file", {
          "x-pinboard-public": "true",
          "if-publication-sequence": "1",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send("?kind=file", {
          "x-pinboard-public": "true",
          "idempotency-key": write(1).requestId,
        })
      ).status,
    ).toBe(400);
    expect((await send("?kind=html", headers())).status).toBe(400);
    expect((await send("?kind=file&name=%20", headers())).status).toBe(400);
    expect((await send("?kind=block", headers())).status).toBe(400);
    expect(
      (
        await send("?kind=file", {
          ...headers(),
          "content-length": String(32 * 1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await call(path + "?kind=file", {
          method: "POST",
          headers: headers(),
        })
      ).status,
    ).toBe(400);
    const partial = await send("?kind=file&name=Preserved", {
      ...headers(),
      "if-publication-sequence": "999",
    });
    expect(partial.status).toBe(207);
    const receipt = await partial.json<{
      pin: { cid: string };
      partialSuccess: boolean;
    }>();
    expect(receipt.partialSuccess).toBe(true);
    expect((await pins.detail(receipt.pin.cid)).name).toBe("Preserved");
    const dag = await importFile(bytes);
    const complete = await send("?kind=block&cid=" + key(dag.root), headers());
    expect(complete.status).toBe(201);
    expect(await complete.json()).toMatchObject({
      pin: { cid: key(dag.root), name: "Untitled" },
      publication: { status: "published", publication: { sequence: 2 } },
    });
    const car = (await getCar(env, key(dag.root)))!;
    const archive = new Uint8Array(await new Response(car.body).arrayBuffer());
    const nop = await send(
      "?kind=car&name=CAR",
      {
        ...headers(),
        "if-publication-sequence": "2",
      },
      archive,
    );
    expect(nop.status).toBe(201);
    expect(await nop.json()).toMatchObject({
      publication: { status: "nop", publication: { sequence: 2 } },
    });
    const readOnly = await client(owner, ["pins:read", "publications:read"]);
    expect(
      (
        await readOnly(path + "?kind=file", {
          method: "POST",
          headers: headers(),
          body: bytes,
        })
      ).status,
    ).toBe(403);
  });

  it("honors weak, wildcard and nonmatching public validators while rejecting invalid versions before 304", async () => {
    const a = await upload(),
      b = await upload();
    const { publication } = await publications.create(
      "Conditional HTTP",
      a.cid,
      write(1).requestId,
    );
    await publications.publish(publication.id, b.cid, write(1));
    const path = `/api/public/publications/${publication.id}`;
    for (const suffix of ["", "/history", "/versions/1"]) {
      const current = await httpRequest(path + suffix);
      expect(current.status).toBe(200);
      expect(current.headers.get("cache-control")).toBe("public, no-cache");
      const etag = current.headers.get("etag")!;
      for (const value of [`"unrelated", W/${etag}`, "*"]) {
        const cached = await httpRequest(path + suffix, {
          headers: { "if-none-match": value },
        });
        expect(cached.status).toBe(304);
        expect(await cached.text()).toBe("");
      }
      expect(
        (
          await httpRequest(path + suffix, {
            headers: { "if-none-match": '"unrelated"' },
          })
        ).status,
      ).toBe(200);
    }
    const download = await httpRequest(path + "/download/1");
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain(a.cid);
    const carTag = download.headers.get("etag")!;
    await download.body?.cancel();
    for (const value of [`W/${carTag}`, "*"]) {
      expect(
        (
          await httpRequest(path + "/download/1", {
            headers: { "if-none-match": value },
          })
        ).status,
      ).toBe(304);
    }
    for (const version of ["0", "-1", "1.5", "bad", "9007199254740992", "99"]) {
      for (const suffix of ["versions", "preview", "download"]) {
        expect(
          (
            await httpRequest(`${path}/${suffix}/${version}`, {
              headers: { "if-none-match": "*" },
            })
          ).status,
        ).toBe(404);
      }
    }
    expect((await httpRequest(path + "/unknown-view")).status).toBe(404);
    expect(
      (await httpRequest("/api/public/publications/missing/history")).status,
    ).toBe(404);
    await publications.delete(publication.id);
    for (const suffix of [
      "",
      "/history",
      "/versions/1",
      "/preview/1",
      "/download/1",
    ]) {
      const deleted = await httpRequest(path + suffix, {
        headers: { "if-none-match": "*" },
      });
      expect(deleted.status).toBe(404);
      expect(deleted.headers.get("cache-control")).toBe("public, no-cache");
    }
  });

  it("serves pending, ready and failed safe previews through HTTP and revalidates the actual descriptor", async () => {
    const pin = await upload();
    const { publication } = await publications.create(
      "HTTP previews",
      pin.cid,
      write(1).requestId,
    );
    const path = `/api/public/publications/${publication.id}/preview/1`;
    const initial = await httpRequest(path);
    expect(await initial.json()).toMatchObject({ status: "pending" });
    const ready = await httpRequest(path);
    expect(await ready.json()).toMatchObject({
      status: "ready",
      contentType: "text/markdown",
    });
    const etag = ready.headers.get("etag")!;
    expect(etag).not.toBe(initial.headers.get("etag"));
    for (const value of [`"miss", W/${etag}`, "*"]) {
      expect(
        (
          await httpRequest(path, {
            headers: { "if-none-match": value },
          })
        ).status,
      ).toBe(304);
    }
    expect(
      (
        await httpRequest(path, {
          headers: { "if-none-match": '"miss"' },
        })
      ).status,
    ).toBe(200);
    const broken = await upload();
    const second = await publications.create(
      "Unavailable preview",
      broken.cid,
      write(1).requestId,
    );
    const archive = (await env.DB.prepare(
      "SELECT object_key FROM car_dags WHERE root = ?",
    )
      .bind(broken.cid)
      .first<{ object_key: string }>())!.object_key;
    const bytes = await (await env.BLOCKS.get(archive))!.arrayBuffer();
    await env.BLOCKS.delete(archive);
    try {
      const failedPath = `/api/public/publications/${second.publication.id}/preview/1`;
      expect((await httpRequest(failedPath)).status).toBe(200);
      const failed = await httpRequest(failedPath);
      expect(await failed.json()).toMatchObject({ status: "failed" });
      expect(
        (
          await httpRequest(
            `/api/public/publications/${second.publication.id}/download/1`,
          )
        ).status,
      ).toBe(503);
    } finally {
      await env.BLOCKS.put(archive, bytes);
    }
    await publications.delete(publication.id);
    expect(
      (
        await httpRequest(path, {
          headers: { "if-none-match": etag },
        })
      ).status,
    ).toBe(404);
  });

  it("paginates independent same-CID publications and scoped recovery without leaking another account", async () => {
    const principal: Principal = {
      ...owner,
      accountId: await accountForGoogle(env.DB, `HTTP-pagination-${++counter}`),
    };
    const source = await upload();
    await new PinService(env, principal).pin(
      source.cid,
      "Private pagination label",
    );
    const call = await client(principal);
    const created = await Promise.all(
      Array.from({ length: 51 }, async (_, index) => {
        const response = await call(
          "/api/publications",
          json({
            title: `HTTP page ${index}`,
            cid: source.cid,
            public: true,
            requestId: `page-${index}`,
          }),
        );
        expect(response.status).toBe(201);
        return (await response.json<PublicationResult>()).publication;
      }),
    );
    const first = await (
      await call("/api/publications")
    ).json<{
      publications: Publication[];
      nextCursor: string | null;
    }>();
    expect(first.publications).toHaveLength(50);
    expect(first.nextCursor).toBe(first.publications.at(-1)!.id);
    const last = await (
      await call("/api/publications?cursor=" + first.nextCursor)
    ).json<{
      publications: Publication[];
      nextCursor: string | null;
    }>();
    expect(last.publications).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
    expect(
      new Set([...first.publications, ...last.publications].map((p) => p.id))
        .size,
    ).toBe(51);
    const other = await client();
    expect((await other("/api/publications/" + created[0]!.id)).status).toBe(
      404,
    );
    await Promise.all(
      created.map(async ({ id }) => {
        expect(
          (await call("/api/publications/" + id, { method: "DELETE" })).status,
        ).toBe(204);
      }),
    );
    expect(
      (await call("/api/pins/" + source.cid, { method: "DELETE" })).status,
    ).toBe(204);
    type RecoveryPage = { items: DeletedItem[]; nextCursor: string | null };
    const deleted = await call("/api/recently-deleted");
    expect(deleted.headers.get("cache-control")).toBe("private, no-store");
    const page = await deleted.json<RecoveryPage>();
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBeTruthy();
    const tail = await (
      await call("/api/recently-deleted?cursor=" + page.nextCursor)
    ).json<RecoveryPage>();
    expect(tail.items).toHaveLength(2);
    expect(tail.nextCursor).toBeNull();
    expect(
      new Set(
        [...page.items, ...tail.items].map((item) => `${item.kind}:${item.id}`),
      ).size,
    ).toBe(52);
    const pinsOnly = await client(principal, ["pins:read"]);
    expect(
      (await (await pinsOnly("/api/recently-deleted")).json<RecoveryPage>())
        .items,
    ).toEqual([
      {
        kind: "pin",
        id: source.cid,
        title: "Private pagination label",
        deletedAt: page.items[0]!.deletedAt,
        expiresAt: page.items[0]!.expiresAt,
      },
    ]);
    const publicationsOnly = await client(principal, ["publications:read"]);
    const publicationsPage = await (
      await publicationsOnly("/api/recently-deleted")
    ).json<RecoveryPage>();
    expect(publicationsPage.items).toHaveLength(50);
    expect(
      publicationsPage.items.every((item) => item.kind === "publication"),
    ).toBe(true);
    const noRead = await client(principal, ["pins:write"]);
    expect((await noRead("/api/recently-deleted")).status).toBe(403);
    expect(
      (await call("/api/recently-deleted?cursor=" + "x".repeat(513))).status,
    ).toBe(400);
    expect(
      (await call("/api/pins/" + source.cid + "/restore", { method: "POST" }))
        .status,
    ).toBe(200);
    expect(
      (await call("/api/pins/" + source.cid + "/restore", { method: "POST" }))
        .status,
    ).toBe(404);
    const target = created[0]!;
    expect(
      (
        await call("/api/publications/" + target.id + "/restore", {
          method: "POST",
        })
      ).status,
    ).toBe(200);
    expect(
      (await httpRequest(`/api/public/publications/${target.id}`)).status,
    ).toBe(200);
    await call("/api/publications/" + target.id, { method: "DELETE" });
    await env.DB.prepare("UPDATE publications SET expires_at = ? WHERE id = ?")
      .bind(new Date(0).toISOString(), target.id)
      .run();
    expect(
      (
        await call("/api/publications/" + target.id + "/restore", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
  }, 30000);

  it("preserves HTTP uploads and sanitizes unexpected publication failures after the pin is committed", async () => {
    const call = await client();
    const pin = await upload();
    const { publication } = await publications.create(
      "Unexpected publication failure",
      pin.cid,
      write(1).requestId,
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const batch = env.DB.batch.bind(env.DB);
    const failures: unknown[] = [
      new Error("private D1 failure detail"),
      "private non-Error failure detail",
    ];
    const reject = vi.fn<() => Promise<never>>();
    for (const failure of failures) reject.mockRejectedValueOnce(failure);
    let injected = 0;
    vi.spyOn(env.DB, "batch").mockImplementation((statements) => {
      if (statements.length === 8 && injected < failures.length) {
        injected++;
        return reject();
      }
      return batch(statements);
    });
    for (let index = 0; index < failures.length; index++) {
      const requestId = write(1).requestId;
      const response = await call(
        `/api/publications/${publication.id}/upload?kind=file&name=Keep%20uploaded%20pin`,
        {
          method: "POST",
          headers: {
            "x-pinboard-public": "true",
            "idempotency-key": requestId,
            "if-publication-sequence": "1",
          },
          body: new TextEncoder().encode(
            `unexpected failure upload ${++counter}`,
          ),
        },
      );
      expect(response.status).toBe(207);
      const text = await response.text();
      expect(text).not.toContain("private D1");
      expect(text).not.toContain("private non-Error");
      const result = JSON.parse(text) as {
        pin: { cid: string };
        partialSuccess: boolean;
        publicationError: { status: number; message: string };
      };
      expect(result.partialSuccess).toBe(true);
      expect(result.publicationError).toEqual({
        status: 500,
        message:
          "Publication failed after successful upload. Retry the same publication request ID and payload.",
      });
      expect((await pins.detail(result.pin.cid)).name).toBe(
        "Keep uploaded pin",
      );
      expect(
        await env.DB.prepare(
          "SELECT request_id FROM publication_requests WHERE account_id = ? AND request_id = ?",
        )
          .bind(owner.accountId, requestId)
          .first(),
      ).toBeNull();
    }
    expect(injected).toBe(2);
    expect(log).toHaveBeenCalledTimes(2);
    expect((await publicationHistory(env, publication.id)).publication).toEqual(
      publication,
    );
  });

  it("exposes MCP creation, listing and pin recovery with schema boundaries and safe unexpected-error reporting", async () => {
    const call = await client();
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const response = await call("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      expect(response.status).toBe(200);
      return (
        await response.json<{
          result: { content: { text: string }[]; isError?: boolean };
        }>()
      ).result;
    };
    const pin = await upload();
    const created = await invoke("publication_create", {
      title: "MCP HTTP boundary",
      cid: pin.cid,
      public: true,
      requestId: write(1).requestId,
    });
    expect(created.isError).not.toBe(true);
    const { publication } = JSON.parse(
      created.content[0]!.text,
    ) as PublicationResult;
    const current = await invoke("publication_get", { id: publication.id });
    expect(JSON.parse(current.content[0]!.text)).toEqual(publication);
    const listed = await invoke("publication_list", { cursor: "" });
    expect(
      (
        JSON.parse(listed.content[0]!.text) as {
          publications: Publication[];
        }
      ).publications.some((item) => item.id === publication.id),
    ).toBe(true);
    const missing = await invoke("publication_get", {
      id: publication.id,
      revision: 99,
    });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.content[0]!.text).toContain("404");
    const noWrite = await invoke("upload", {
      kind: "file",
      name: "Missing write metadata",
      contentBase64: btoa("missing publication write"),
      public: true,
      publicationId: publication.id,
    });
    expect(noWrite.isError).toBe(true);
    expect(noWrite.content[0]!.text).toContain("publicationWrite required");
    const oversized = await invoke("upload", {
      kind: "file",
      name: "Inline boundary",
      contentBase64: btoa("x".repeat(2 * 1024 * 1024 + 1)),
      public: true,
    });
    expect(oversized.isError).toBe(true);
    expect(oversized.content[0]!.text).toContain("413");
    expect((await invoke("unpin", { cid: pin.cid })).isError).not.toBe(true);
    expect(
      (await invoke("restore", { kind: "pin", id: pin.cid })).isError,
    ).not.toBe(true);
    expect(await pins.detail(pin.cid)).toEqual(pin);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(PublicationService.prototype, "list").mockRejectedValueOnce(
      "private unexpected storage failure",
    );
    const failed = await invoke("publication_list", {});
    expect(failed.isError).toBe(true);
    expect(failed.content[0]!.text).toBe("Internal server error");
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("publications and recovery", () => {
  it("uses shared HTTP and MCP lifecycle services, explicit scopes, Origin checks and upload partial-success responses", async () => {
    const token = (
      await createToken(env, owner, {
        name: "publication API test",
        scopes,
        expiresInDays: 1,
      })
    ).token;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const call = (
      path: string,
      method: string,
      body?: unknown,
      extra?: Record<string, string>,
    ) =>
      app.request(
        origin + path,
        {
          method,
          headers: { ...headers, ...extra },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      );
    const a = await upload();
    const create = {
      title: "HTTP publication",
      cid: a.cid,
      public: true,
      requestId: "http-create",
    };
    expect(
      (
        await call("/api/publications", "POST", create, {
          origin: "https://evil.test",
        })
      ).status,
    ).toBe(403);
    const initial = await (
      await call("/api/publications", "POST", create)
    ).json<PublicationResult>();
    const id = initial.publication.id;
    expect(
      (
        await (
          await call("/api/publications", "GET")
        ).json<{ publications: { id: string }[] }>()
      ).publications.some((item) => item.id === id),
    ).toBe(true);
    const uploadResult = await app.request(
      origin + `/api/publications/${id}/upload?kind=file&name=partial-http`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-pinboard-public": "true",
          "idempotency-key": "http-partial",
          "if-publication-sequence": "999",
        },
        body: new TextEncoder().encode("HTTP partial success"),
      },
      env,
    );
    expect(uploadResult.status).toBe(207);
    const partial = await uploadResult.json<{
      partialSuccess: true;
      pin: { cid: string };
    }>();
    expect(partial.partialSuccess).toBe(true);
    expect(await pins.detail(partial.pin.cid)).toBeDefined();
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const response = await handleMcp(
        new Request(origin + "/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        }),
        env,
        owner,
      );
      const result = await response.json<{
        result: { content: { text: string }[]; isError?: boolean };
      }>();
      expect(result.result.isError).not.toBe(true);
      return JSON.parse(result.result.content[0]!.text) as unknown;
    };
    expect(
      await invoke("publication_publish", {
        id,
        cid: partial.pin.cid,
        expectedSequence: 1,
        requestId: "mcp-publish",
      }),
    ).toMatchObject({
      status: "published",
      publication: { currentRevision: 2 },
    });
    expect(
      await invoke("publication_rollback", {
        id,
        revision: 1,
        expectedSequence: 2,
        requestId: "mcp-rollback",
      }),
    ).toMatchObject({
      status: "rolled-back",
      publication: { currentRevision: 1, revisionCount: 2 },
    });
    expect(await invoke("publication_get", { id, revision: 2 })).toMatchObject({
      revision: { cid: partial.pin.cid },
    });
    const mcpUpload = (await invoke("upload", {
      kind: "file",
      name: "Keep MCP upload",
      contentBase64: btoa("MCP partial success"),
      public: true,
      publicationId: id,
      publicationWrite: { expectedSequence: 999, requestId: "mcp-partial" },
    })) as {
      pin: { cid: string };
      partialSuccess: boolean;
      publicationError: { status: number };
    };
    expect(mcpUpload.partialSuccess).toBe(true);
    expect(mcpUpload.publicationError.status).toBe(409);
    expect((await pins.detail(mcpUpload.pin.cid)).name).toBe("Keep MCP upload");
    const mcpHistory = (await invoke("publication_history", { id })) as {
      revisions: unknown[];
    };
    expect(mcpHistory.revisions).toHaveLength(2);
    await invoke("publication_delete", { id });
    const deleted = (await invoke("recently_deleted", {})) as {
      items: { id: string; kind: string }[];
    };
    expect(
      deleted.items.some(
        (item) => item.id === id && item.kind === "publication",
      ),
    ).toBe(true);
    await invoke("restore", { kind: "publication", id });
    expect((await call(`/api/publications/${id}`, "GET")).status).toBe(200);
    await call(`/api/pins/${a.cid}`, "DELETE");
    expect((await call(`/api/pins/${a.cid}`, "GET")).status).toBe(404);
    expect((await call(`/api/pins/${a.cid}/restore`, "POST", {})).status).toBe(
      200,
    );
  });

  it("persists immutable revisions, canonical NOP results and historical CID republishing separately from rollback", async () => {
    const a = await upload();
    const b = await upload();
    const createRequest = write(1).requestId;
    const created = await publications.create(
      "Public title",
      a.cid,
      createRequest,
    );
    const { id } = created.publication;
    const nopWrite = write(1);
    const nop = await publications.publish(id, a.cid, nopWrite);
    expect(nop).toEqual({ status: "nop", publication: created.publication });
    const second = await publications.publish(id, b.cid, write(1));
    expect(
      await publications.create("Public title", a.cid, createRequest),
    ).toEqual(created);
    await expect(
      publications.create("Different public title", a.cid, createRequest),
    ).rejects.toMatchObject({ status: 409 });
    expect(second.publication).toMatchObject({
      sequence: 2,
      currentRevision: 2,
      revisionCount: 2,
    });
    expect(await publications.publish(id, a.cid, nopWrite)).toEqual(nop);
    await expect(
      publications.publish(id, a.cid, { ...nopWrite, expectedSequence: 2 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      publications.publish(id, b.cid, write(1)),
    ).rejects.toMatchObject({ status: 409 });
    const third = await publications.publish(id, a.cid, write(2));
    expect(third.publication).toMatchObject({
      sequence: 3,
      currentRevision: 3,
      revisionCount: 3,
    });
    const rollback = await publications.rollback(id, 1, write(3));
    expect(rollback.publication).toMatchObject({
      sequence: 4,
      currentRevision: 1,
      revisionCount: 3,
    });
    expect(
      (await publicationHistory(env, id)).revisions.map((r) => r.cid),
    ).toEqual([a.cid, b.cid, a.cid]);
    const other = new PublicationService(env, {
      ...owner,
      accountId: await accountForGoogle(env.DB, "other"),
    });
    await expect(other.publish(id, a.cid, write(4))).rejects.toMatchObject({
      status: 404,
    });
  });

  it("serializes concurrent writers and concurrent identical idempotency keys", async () => {
    const a = await upload(),
      b = await upload(),
      c = await upload();
    const createRequest = write(1).requestId;
    const created = await Promise.all([
      publications.create("Race", a.cid, createRequest),
      publications.create("Race", a.cid, createRequest),
    ]);
    expect(created[0]).toEqual(created[1]);
    const initial = created[0].publication;
    const outcomes = await Promise.allSettled([
      publications.publish(initial.id, b.cid, write(1)),
      publications.publish(initial.id, c.cid, write(1)),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((r) => r.status === "rejected")).toMatchObject({
      reason: { status: 409 },
    });
    const retry = write(2);
    const results = await Promise.all([
      publications.publish(initial.id, a.cid, retry),
      publications.publish(initial.id, a.cid, retry),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect((await publicationHistory(env, initial.id)).revisions).toHaveLength(
      3,
    );
  });

  it("has identical public metadata, response-specific ETags and checks deletion before 304; restores original history and links", async () => {
    const a = await upload(),
      b = await upload();
    const { publication: initial } = await publications.create(
      "Only this title is public",
      a.cid,
      write(1).requestId,
    );
    const path = `/api/public/publications/${initial.id}`;
    const get = (suffix = "", headers?: HeadersInit) =>
      app.request(origin + path + suffix, headers ? { headers } : {}, env);
    const current = await get();
    expect(current.headers.get("cache-control")).toBe("public, no-cache");
    const etag = current.headers.get("etag")!;
    const body = await current.text();
    expect(body).not.toContain(owner.accountId);
    expect(body).not.toContain("Private label");
    expect(
      await (
        await get("", { authorization: "Bearer deliberately-invalid" })
      ).text(),
    ).toBe(body);
    expect((await get("", { "if-none-match": etag })).status).toBe(304);
    expect((await get("/history")).headers.get("etag")).not.toBe(etag);
    expect((await get("/versions/1")).headers.get("etag")).not.toBe(etag);
    expect(
      (await get("/download")).headers.get("content-disposition"),
    ).toContain(a.cid);
    await publications.publish(initial.id, b.cid, write(1));
    expect((await get("", { "if-none-match": etag })).status).toBe(200);
    expect(
      (await (await get("/versions/1")).json<{ revision: { cid: string } }>())
        .revision.cid,
    ).toBe(a.cid);
    await publications.delete(initial.id);
    for (const suffix of ["", "/history", "/versions/1", "/download"]) {
      expect((await get(suffix, { "if-none-match": etag })).status).toBe(404);
    }
    await expect(
      publications.publish(initial.id, a.cid, write(2)),
    ).rejects.toMatchObject({ status: 404 });
    const restored = await publications.restore(initial.id);
    expect(restored).toMatchObject({
      id: initial.id,
      currentRevision: 2,
      revisionCount: 2,
    });
    expect((await get()).status).toBe(200);
  });

  it("locks a complete current download to one resolved CID even when current changes during the R2 read", async () => {
    const a = await upload(),
      b = await upload();
    const { publication } = await publications.create(
      "Download snapshot",
      a.cid,
      write(1).requestId,
    );
    const archive = await env.DB.prepare(
      "SELECT object_key FROM car_dags WHERE root = ?",
    )
      .bind(a.cid)
      .first<{ object_key: string }>();
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const suspended = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = env.BLOCKS.get.bind(env.BLOCKS);
    let intercepted = false;
    vi.spyOn(env.BLOCKS, "get").mockImplementation(async (...args) => {
      if (!intercepted && args[0] === archive!.object_key) {
        intercepted = true;
        entered();
        await suspended;
      }
      return original(...args);
    });
    const path = origin + `/api/public/publications/${publication.id}/download`;
    const pending = app.request(path, {}, env);
    await started;
    try {
      await publications.publish(publication.id, b.cid, write(1));
    } finally {
      resume();
    }
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain(a.cid);
    const reader = await CarReader.fromBytes(
      new Uint8Array(await response.arrayBuffer()),
    );
    expect((await reader.getRoots())[0]!.toV1().toString()).toBe(a.cid);
    const next = await app.request(path, {}, env);
    const etag = next.headers.get("etag")!;
    expect(etag).not.toBe(response.headers.get("etag"));
    await next.body?.cancel();
    const cached = await app.request(
      path,
      { headers: { "if-none-match": etag } },
      env,
    );
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
    await publications.delete(publication.id);
    const deleted = await app.request(
      path,
      { headers: { "if-none-match": etag } },
      env,
    );
    expect(deleted.status).toBe(404);
    expect(deleted.headers.get("cache-control")).toBe("public, no-cache");
  });

  it("keeps successful upload and explicitly reports a failed publication", async () => {
    const a = await upload();
    const { publication } = await publications.create(
      "Partial",
      a.cid,
      write(1).requestId,
    );
    const result = await publications.upload(
      publication.id,
      write(999),
      new TextEncoder().encode("partial upload"),
      "file",
      "Keep me",
    );
    expect(result).toMatchObject({
      partialSuccess: true,
      publicationError: { status: 409 },
    });

    expect(await pins.detail(result.pin.cid)).toMatchObject({
      name: "Keep me",
    });
    expect(
      (await publicationHistory(env, publication.id)).publication.current.cid,
    ).toBe(a.cid);
  });

  it("fails closed without moving current when the target's ready metadata has missing physical content", async () => {
    const a = await upload(),
      b = await upload();
    const { publication } = await publications.create(
      "Physical availability",
      a.cid,
      write(1).requestId,
    );
    const archive = await env.DB.prepare(
      "SELECT object_key FROM car_dags WHERE root = ?",
    )
      .bind(b.cid)
      .first<{ object_key: string }>();
    const bytes = await (await env.BLOCKS.get(
      archive!.object_key,
    ))!.arrayBuffer();
    await env.BLOCKS.delete(archive!.object_key);
    try {
      await expect(
        publications.publish(publication.id, b.cid, write(1)),
      ).rejects.toMatchObject({ status: 503 });
      expect(
        (await publicationHistory(env, publication.id)).publication.current.cid,
      ).toBe(a.cid);
    } finally {
      await env.BLOCKS.put(archive!.object_key, bytes);
    }
  });

  it("creates and publishes complete legacy pins without changing their identities or private metadata", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.parse("2033-01-01T00:00:00Z");
    vi.setSystemTime(base);
    const first = await legacyPin(),
      second = await legacyPin();
    expect(first.dag.blocks.size).toBeGreaterThan(1);
    for (const { pin } of [first, second]) {
      expect(
        await env.DB.prepare("SELECT root FROM car_dags WHERE root = ?")
          .bind(pin.cid)
          .first(),
      ).toBeNull();
      expect((await getCar(env, pin.cid))!.body).toBeInstanceOf(Uint8Array);
    }
    const { publication } = await publications.create(
      "Legacy publication",
      first.pin.cid,
      write(1).requestId,
    );
    const published = await publications.publish(
      publication.id,
      second.pin.cid,
      write(1),
    );
    expect(published).toMatchObject({
      status: "published",
      publication: { currentRevision: 2, sequence: 2, revisionCount: 2 },
    });
    for (const { dag, pin } of [first, second]) {
      expect(await pins.detail(pin.cid)).toEqual(pin);
      expect(
        await env.DB.prepare(
          "SELECT so.state FROM car_dags cd JOIN storage_objects so ON so.object_key = cd.object_key WHERE cd.root = ?",
        )
          .bind(pin.cid)
          .first(),
      ).toEqual({ state: "ready" });
      expect(
        (await env.DB.prepare(
          "SELECT count(*) AS count FROM dag_members dm JOIN car_blocks cb ON cb.cid = dm.cid JOIN storage_objects so ON so.object_key = cb.object_key AND so.state = 'ready' WHERE dm.root = ?",
        )
          .bind(pin.cid)
          .first<{ count: number }>())!.count,
      ).toBe(dag.blocks.size);
      await env.BLOCKS.delete([...dag.blocks.keys()]);
      await pins.unpin(pin.cid);
    }
    vi.setSystemTime(base + RECOVERY_MS + CONTENT_RETENTION_MS + 1);
    await runRetention(env);
    for (const { dag, pin } of [first, second]) {
      for (const [cid, bytes] of dag.blocks)
        expect(await readBlock(env, cid)).toEqual(bytes);
      const car = (await getCar(env, pin.cid))!;
      const reader = await CarReader.fromBytes(
        new Uint8Array(await new Response(car.body).arrayBuffer()),
      );
      expect(key((await reader.getRoots())[0]!)).toBe(pin.cid);
      for (const [cid, bytes] of dag.blocks)
        expect((await reader.get(CID.parse(cid)))!.bytes).toEqual(bytes);
    }
    expect(
      (await publicationHistory(env, publication.id)).revisions.map(
        (r) => r.cid,
      ),
    ).toEqual([second.pin.cid, first.pin.cid]);
  });

  it("fences legacy promotion against GC claiming the suspended fresh CAR and permits a safe retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.parse("2034-01-01T00:00:00Z");
    vi.setSystemTime(base);
    const { dag, pin } = await legacyPin();
    const requestId = write(1).requestId;
    let entered!: () => void, resume!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const suspended = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const put = env.BLOCKS.put.bind(env.BLOCKS);
    let archive: string | undefined;
    vi.spyOn(env.BLOCKS, "put").mockImplementation(async (...args) => {
      const result = await put(...args);
      if (!archive && args[0].startsWith("cars/")) {
        archive = args[0];
        entered();
        await suspended;
      }
      return result;
    });
    const pending = publications.create("Legacy GC race", pin.cid, requestId);
    await started;
    try {
      expect(
        await env.DB.prepare(
          "SELECT state FROM storage_objects WHERE object_key = ?",
        )
          .bind(archive!)
          .first(),
      ).toEqual({ state: "writing" });
      vi.setSystemTime(base + CONTENT_RETENTION_MS + 1);
      expect((await runRetention(env)).objectsDeleted).toBeGreaterThan(0);
      expect(await env.BLOCKS.head(archive!)).toBeNull();
    } finally {
      resume();
    }
    await expect(pending).rejects.toThrow("CHECK constraint");
    expect(
      await env.DB.prepare(
        "SELECT request_id FROM publication_requests WHERE account_id = ? AND request_id = ?",
      )
        .bind(owner.accountId, requestId)
        .first(),
    ).toBeNull();
    expect(await pins.detail(pin.cid)).toEqual(pin);
    for (const [cid, bytes] of dag.blocks)
      expect(await readBlock(env, cid)).toEqual(bytes);
    const retry = await publications.create(
      "Legacy GC race",
      pin.cid,
      requestId,
    );
    expect(retry.status).toBe("created");
    const saved = await env.DB.prepare(
      "SELECT object_key FROM car_dags WHERE root = ?",
    )
      .bind(pin.cid)
      .first<{ object_key: string }>();
    expect(saved!.object_key).not.toBe(archive);
    expect(await env.BLOCKS.head(saved!.object_key)).not.toBeNull();
  });

  it("does not promote incomplete or corrupt legacy DAGs", async () => {
    const { dag, pin } = await legacyPin();
    const [cid, bytes] = [...dag.blocks].find(
      ([member]) => member !== pin.cid,
    )!;
    const requestId = write(1).requestId;
    await env.BLOCKS.delete(cid);
    try {
      await expect(
        publications.create("Incomplete legacy", pin.cid, requestId),
      ).rejects.toThrow("Incomplete DAG");
      await env.BLOCKS.put(
        cid,
        new TextEncoder().encode("corrupt legacy block"),
      );
      await expect(
        publications.create("Incomplete legacy", pin.cid, requestId),
      ).rejects.toThrow("do not match CID");
      expect(
        await env.DB.prepare("SELECT root FROM car_dags WHERE root = ?")
          .bind(pin.cid)
          .first(),
      ).toBeNull();
      expect(
        await env.DB.prepare(
          "SELECT request_id FROM publication_requests WHERE account_id = ? AND request_id = ?",
        )
          .bind(owner.accountId, requestId)
          .first(),
      ).toBeNull();
      expect(await pins.detail(pin.cid)).toEqual(pin);
    } finally {
      await env.BLOCKS.put(cid, bytes);
    }
    expect(
      (await publications.create("Incomplete legacy", pin.cid, requestId))
        .status,
    ).toBe("created");
  });

  it("rechecks promoted legacy pin ownership and ready storage after expiry and GC win the publication race", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.parse("2035-01-01T00:00:00Z");
    vi.setSystemTime(base);
    const initial = await upload();
    const { publication } = await publications.create(
      "Legacy commit race",
      initial.cid,
      write(1).requestId,
    );
    const { pin } = await legacyPin();
    const batch = env.DB.batch.bind(env.DB);
    let intercepted = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (!intercepted && statements.length === 8) {
        intercepted = true;
        const archive = await env.DB.prepare(
          "SELECT cd.object_key, so.state FROM car_dags cd JOIN storage_objects so ON so.object_key = cd.object_key WHERE cd.root = ?",
        )
          .bind(pin.cid)
          .first<{ object_key: string; state: string }>();
        expect(archive!.state).toBe("ready");
        await pins.unpin(pin.cid);
        vi.setSystemTime(base + RECOVERY_MS);
        await expireDeleted(env, Date.now());
        vi.setSystemTime(base + RECOVERY_MS + CONTENT_RETENTION_MS);
        await runRetention(env);
        expect(await env.BLOCKS.head(archive!.object_key)).toBeNull();
      }
      return batch(statements);
    });
    const writeRequest = write(1);
    await expect(
      publications.publish(publication.id, pin.cid, writeRequest),
    ).rejects.toMatchObject({ status: 409 });
    expect(intercepted).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT request_id FROM publication_requests WHERE account_id = ? AND request_id = ?",
      )
        .bind(owner.accountId, writeRequest.requestId)
        .first(),
    ).toBeNull();
    expect(await publicationHistory(env, publication.id)).toMatchObject({
      publication: { currentRevision: 1, revisionCount: 1, sequence: 1 },
      revisions: [{ cid: initial.cid }],
    });
  });

  it("does not grant publication writes to old pin tokens, including MCP", async () => {
    const a = await upload();
    const old = {
      ...owner,
      kind: "agent" as const,
      scopes: ["pins:read", "pins:write", "pins:delete"] as const,
    };
    await expect(
      new PublicationService(env, old).create("No", a.cid, write(1).requestId),
    ).rejects.toMatchObject({ status: 403 });
    const response = await handleMcp(
      new Request(origin + "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "publication_create",
            arguments: {
              title: "No",
              cid: a.cid,
              requestId: "old-token",
              public: true,
            },
          },
        }),
      }),
      env,
      old,
    );
    expect(await response.text()).toContain(
      "Missing permission: publications:write",
    );
  });

  it("retains pins for 30 days, does not extend repeated deletion, and starts seven-day grace only after expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.parse("2035-01-01T00:00:00Z");
    vi.setSystemTime(base);
    const a = await upload();
    await pins.unpin(a.cid);
    const first = (await listDeleted(env, owner)).items.find(
      (item) => item.id === a.cid,
    )!;
    expect((await pins.list()).pins.some((pin) => pin.cid === a.cid)).toBe(
      false,
    );
    vi.setSystemTime(base + RECOVERY_MS - 1);
    await pins.unpin(a.cid);
    expect(
      (await listDeleted(env, owner)).items.find((item) => item.id === a.cid),
    ).toEqual(first);
    await runRetention(env);
    expect(await readBlock(env, a.cid)).toBeDefined();
    await restorePin(env, owner, a.cid);
    expect(await pins.detail(a.cid)).toMatchObject({
      name: a.name,
      createdAt: a.createdAt,
    });
    await pins.unpin(a.cid);
    vi.setSystemTime(base + RECOVERY_MS * 2);
    await expect(restorePin(env, owner, a.cid)).rejects.toMatchObject({
      status: 404,
    });
    await runRetention(env);
    expect(await readBlock(env, a.cid)).toBeDefined();
    const grace = await env.DB.prepare(
      "SELECT unreferenced_at FROM retained_blocks WHERE cid = ?",
    )
      .bind(a.cid)
      .first<{ unreferenced_at: string }>();
    expect(grace!.unreferenced_at).toBe(
      new Date(base + RECOVERY_MS * 2).toISOString(),
    );
    vi.setSystemTime(base + RECOVERY_MS * 2 + CONTENT_RETENTION_MS + 1);
    await runRetention(env);
    expect(await readBlock(env, a.cid)).toBeUndefined();
  });

  it("publication references outlive source-pin expiry and retain CAR, DAG and previews until the publication's own expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.parse("2036-01-01T00:00:00Z");
    vi.setSystemTime(base);
    const a = await upload();
    const { publication } = await publications.create(
      "Independent",
      a.cid,
      write(1).requestId,
    );
    await pins.unpin(a.cid);
    vi.setSystemTime(base + RECOVERY_MS + CONTENT_RETENTION_MS + 1);
    await runRetention(env);
    expect(await readBlock(env, a.cid)).toBeDefined();
    expect(await getCar(env, a.cid)).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT unreferenced_at FROM retained_blocks WHERE cid = ?",
      )
        .bind(a.cid)
        .first(),
    ).toMatchObject({ unreferenced_at: null });
    await publications.delete(publication.id);
    const expiry = Date.now() + RECOVERY_MS;
    vi.setSystemTime(expiry);
    await expect(publications.restore(publication.id)).rejects.toMatchObject({
      status: 404,
    });
    await expireDeleted(env, Date.now());
    expect(await readBlock(env, a.cid)).toBeDefined();
    expect(
      (await listDeleted(env, owner)).items.find(
        (item) => item.id === publication.id,
      ),
    ).toBeUndefined();
    vi.setSystemTime(expiry + CONTENT_RETENTION_MS + 1);
    await runRetention(env);
    expect(await readBlock(env, a.cid)).toBeUndefined();
  });

  it("protects the full multiblock DAG, all revision CARs and generated image resources after source pins expire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.parse("2037-01-01T00:00:00Z");
    vi.setSystemTime(base);
    const image = await pins.upload(
      await readFile(new URL("fixtures/transparent.png", import.meta.url)),
      "file",
      "Private image label",
    );
    await processPreview(env, image.cid);
    const descriptor = await getPreview(env, image.cid);
    expect(descriptor.contentType).toBe("image/webp");
    if (descriptor.contentType !== "image/webp")
      throw new Error("Missing test thumbnail");
    const thumbnail = descriptor.content.cid;
    const large = await pins.upload(
      new TextEncoder().encode("large publication content ".repeat(30000)),
      "file",
      "Large document",
    );
    expect(large.blocks).toBeGreaterThan(1);
    const { publication } = await publications.create(
      "Full retention",
      image.cid,
      write(1).requestId,
    );
    await publications.publish(publication.id, large.cid, write(1));
    const aliasNop = await publications.publish(
      publication.id,
      CID.parse(large.cid).toV0().toString(),
      write(2),
    );
    expect(aliasNop).toMatchObject({
      status: "nop",
      publication: { sequence: 2, revisionCount: 2 },
    });
    const members = await env.DB.prepare(
      "SELECT cid FROM dag_members WHERE root = ?",
    )
      .bind(large.cid)
      .all<{ cid: string }>();
    await pins.unpin(image.cid);
    await pins.unpin(large.cid);
    vi.setSystemTime(base + RECOVERY_MS + CONTENT_RETENTION_MS + 1);
    await runRetention(env);
    await runPreviews(env);
    for (const { cid } of members.results)
      expect(await readBlock(env, cid)).toBeDefined();
    expect(await getCar(env, image.cid)).not.toBeNull();
    expect(await getCar(env, large.cid)).not.toBeNull();
    expect(await readBlock(env, thumbnail)).toBeDefined();
    expect(
      await env.DB.prepare(
        "SELECT unreferenced_at FROM preview_images WHERE cid = ?",
      )
        .bind(thumbnail)
        .first(),
    ).toMatchObject({ unreferenced_at: null });
  });

  it("rechecks source pin liveness inside the publication transaction after a concurrent Unpin", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.parse("2039-01-01T00:00:00Z");
    vi.setSystemTime(base);
    const a = await upload(),
      b = await upload();
    const { publication } = await publications.create(
      "Publish versus Unpin",
      a.cid,
      write(1).requestId,
    );
    const original = env.DB.batch.bind(env.DB);
    let intercepted = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (!intercepted && statements.length > 3) {
        intercepted = true;
        await pins.unpin(b.cid);
        vi.setSystemTime(base + RECOVERY_MS);
        await expireDeleted(env, Date.now());
        vi.setSystemTime(base + RECOVERY_MS + CONTENT_RETENTION_MS);
        await runRetention(env);
      }
      return original(statements);
    });
    await expect(
      publications.publish(publication.id, b.cid, write(1)),
    ).rejects.toMatchObject({ status: 409 });
    expect(intercepted).toBe(true);
    expect(await readBlock(env, b.cid)).toBeUndefined();
    expect(
      (await publicationHistory(env, publication.id)).publication.current.cid,
    ).toBe(a.cid);
    expect(
      (await publicationHistory(env, publication.id)).revisions,
    ).toHaveLength(1);
  });

  it("serializes restore versus expiry and does not release another publication's retention", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.parse("2038-01-01T00:00:00Z");
    vi.setSystemTime(base);
    const a = await upload();
    const first = (
      await publications.create("First reference", a.cid, write(1).requestId)
    ).publication;
    const second = (
      await publications.create("Second reference", a.cid, write(1).requestId)
    ).publication;
    await pins.unpin(a.cid);
    await publications.delete(first.id);
    const deletedBefore = (await listDeleted(env, owner)).items.find(
      (item) => item.id === first.id,
    );
    vi.setSystemTime(base + RECOVERY_MS - 1);
    await publications.delete(first.id);
    expect(
      (await listDeleted(env, owner)).items.find(
        (item) => item.id === first.id,
      ),
    ).toEqual(deletedBefore);
    await Promise.all([
      publications.restore(first.id),
      expireDeleted(env, Date.now()),
    ]);
    expect((await publicationHistory(env, first.id)).publication.id).toBe(
      first.id,
    );
    await publications.delete(first.id);
    vi.setSystemTime(base + RECOVERY_MS * 2);
    const outcomes = await Promise.allSettled([
      publications.restore(first.id),
      expireDeleted(env, Date.now()),
    ]);
    expect(outcomes[0]).toMatchObject({
      status: "rejected",
      reason: { status: 404 },
    });
    expect(
      await env.DB.prepare(
        "SELECT cid FROM publication_retention WHERE publication_id = ?",
      )
        .bind(first.id)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT cid FROM publication_retention WHERE publication_id = ?",
      )
        .bind(second.id)
        .first(),
    ).toEqual({ cid: a.cid });
    await runRetention(env);
    expect(await readBlock(env, a.cid)).toBeDefined();
    expect(
      (await publicationHistory(env, second.id)).publication.current.cid,
    ).toBe(a.cid);
  });
});
