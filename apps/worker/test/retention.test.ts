import { encode } from "@auth/core/jwt";
import * as dagPb from "@ipld/dag-pb";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { completeDag, importFile, key, type Dag } from "../src/content.js";
import type { Bindings } from "../src/env.js";
import app from "../src/index.js";
import { accountForGoogle, type Principal } from "../src/identity.js";
import {
  CONTENT_RETENTION_MS as WEEK,
  runRetention,
  TOKEN_RETENTION_MS as MONTH,
} from "../src/retention.js";
import { PinService } from "../src/service.js";
import { getCar, readBlock, storeDag, writeGuard } from "../src/storage.js";
import { createToken, listTokens, revokeToken } from "../src/tokens.js";
import { migrate } from "./migrations.js";

const BASE = Date.parse("2030-01-01T00:00:00.000Z");
const DAY = 86400000;
const origin = "http://example.test";
const text = (value: string) => new TextEncoder().encode(value);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2026-10-14",
    d1Databases: ["DB", "MIGRATION"],
    r2Buckets: ["BLOCKS"],
  }),
);
let env: Bindings;
let alice: Principal;
let bob: Principal;
let service: PinService;
let cookie: string;
const at = (time: number) => vi.setSystemTime(new Date(time));
const sweep = async (time: number) => {
  at(time);
  return runRetention(env);
};
const objectKey = async (cid: string) =>
  (await env.DB.prepare("SELECT object_key FROM car_dags WHERE root = ?")
    .bind(cid)
    .first<{ object_key: string }>())!.object_key;
const objects = async () => (await env.BLOCKS.list()).objects;
async function parent(child: Dag, label: string) {
  const bytes = dagPb.encode({
    Data: text(label),
    Links: [{ Hash: child.root }],
  });
  const root = CID.createV1(dagPb.code, await sha256.digest(bytes));
  return completeDag(root, (cid) =>
    key(cid) === key(root) ? bytes : child.blocks.get(key(cid)),
  );
}
async function legacyPin(dag: Dag, owner = alice) {
  for (const [cid, bytes] of dag.blocks) await env.BLOCKS.put(cid, bytes);
  await env.DB.prepare(
    "INSERT INTO pins (account_id, cid, name, size, blocks) VALUES (?, ?, 'legacy', ?, ?)",
  )
    .bind(owner.accountId, key(dag.root), dag.size, dag.blocks.size)
    .run();
}

beforeAll(async () => {
  const bindings = await mf.getBindings<Bindings>();
  const db = bindings.DB;
  const bucket = bindings.BLOCKS;
  env = {
    ...bindings,
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
      put: bucket.put.bind(bucket),
      get: bucket.get.bind(bucket),
      head: bucket.head.bind(bucket),
      list: bucket.list.bind(bucket),
      delete: bucket.delete.bind(bucket),
    },
    APP_NAME: "Pinboard",
    PUBLIC_ORIGIN: origin,
    AUTH_URL: origin + "/api/auth",
    AUTH_SECRET: "retention-test-auth-secret-that-is-long-enough",
  };
  await migrate(env.DB);
  alice = {
    accountId: await accountForGoogle(env.DB, "retention-alice"),
    kind: "session",
    scopes: ["pins:read", "pins:write", "pins:delete"],
  };
  bob = {
    ...alice,
    accountId: await accountForGoogle(env.DB, "retention-bob"),
  };
  service = new PinService(env, alice);
}, 30000);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(BASE);
  cookie = `authjs.session-token=${await encode({
    token: { accountId: alice.accountId },
    secret: env.AUTH_SECRET,
    salt: "authjs.session-token",
    maxAge: 365 * 86400,
  })}`;
  const keys = (await objects()).map((o) => o.key);
  if (keys.length) await env.BLOCKS.delete(keys);
  await env.DB.batch([
    ...[
      "pins",
      "agent_tokens",
      "car_blocks",
      "car_dags",
      "dag_roots",
      "storage_objects",
      "retained_blocks",
      "retention_backfill",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    env.DB.prepare(
      "UPDATE retention_state SET scan_cursor = NULL, safe_after = '2000'",
    ),
  ]);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => mf.dispose());

describe("content retention", () => {
  it("migrates existing shared CAR indexes without losing mappings or declaring old pins verified", async () => {
    const db = await mf.getD1Database("MIGRATION");
    await migrate(db, { through: "0002_car_storage.sql" });
    await db.batch([
      db.prepare(
        "INSERT INTO accounts (id, provider, subject) VALUES ('old', 'google', 'old')",
      ),
      db.prepare(
        "INSERT INTO pins (account_id, cid, name, size, blocks) VALUES ('old', 'root-a', 'old pin', 1, 1)",
      ),
      db.prepare(
        "INSERT INTO car_dags VALUES ('root-a', 'cars/old-a.car', 100), ('root-b', 'cars/old-b.car', 100)",
      ),
      db.prepare(
        "INSERT INTO car_blocks VALUES ('shared-block', 'cars/old-a.car', 42, 4)",
      ),
    ]);
    await migrate(db, { after: "0002_car_storage.sql" });
    expect(
      await db
        .prepare("SELECT object_key FROM car_blocks WHERE cid = 'shared-block'")
        .first(),
    ).toEqual({ object_key: "cars/old-a.car" });
    expect(
      (await db
        .prepare("SELECT count(*) AS n FROM storage_objects")
        .first<{ n: number }>())!.n,
    ).toBe(2);
    expect(
      (await db
        .prepare("SELECT count(*) AS n FROM object_blocks")
        .first<{ n: number }>())!.n,
    ).toBe(3);
    expect(await db.prepare("SELECT root FROM dag_roots").first()).toBeNull();
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    expect(
      await db.prepare("SELECT scan_cursor FROM retention_state").first(),
    ).toEqual({ scan_cursor: null });
  });

  it("counts seven days from the last account reference, not archive creation, and removes all indexes", async () => {
    const pin = await service.upload(text("accounts"), "file", "Alice");
    const other = new PinService(env, bob);
    await other.pin(pin.cid, "Bob");
    at(BASE + 20 * DAY);
    await service.unpin(pin.cid);
    expect((await service.list()).pins).toEqual([]);
    expect((await sweep(BASE + 40 * DAY)).objectsDeleted).toBe(0);
    expect(await readBlock(env, pin.cid)).toEqual(text("accounts"));
    await other.unpin(pin.cid);
    expect((await sweep(BASE + 47 * DAY - 1)).objectsDeleted).toBe(0);
    expect(await getCar(env, pin.cid)).not.toBeNull();
    expect((await sweep(BASE + 47 * DAY)).objectsDeleted).toBe(2);
    expect(await getCar(env, pin.cid)).toBeNull();
    for (const table of [
      "storage_objects",
      "object_blocks",
      "car_dags",
      "car_blocks",
      "dag_roots",
      "dag_members",
      "retained_blocks",
    ]) {
      expect(
        (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{
          n: number;
        }>())!.n,
      ).toBe(0);
    }
  });

  it("protects shared CAR providers, nested DAG children and independently pinned sub-DAGs", async () => {
    const leaf = await importFile(text("shared-leaf"));
    const first = await parent(leaf, "first");
    const second = await parent(first, "second");
    const firstKey = await storeDag(env, first);
    const secondKey = await storeDag(env, second);
    const other = new PinService(env, bob);
    await other.pin(key(second.root), "nested");
    await service.pin(key(leaf.root), "child");
    expect((await sweep(BASE + 20 * DAY)).objectsDeleted).toBe(0);
    expect(await env.BLOCKS.head(firstKey)).not.toBeNull();
    expect(await env.BLOCKS.head(secondKey)).not.toBeNull();
    await other.unpin(key(second.root));
    await sweep(BASE + 27 * DAY);
    expect(await readBlock(env, key(leaf.root))).toEqual(text("shared-leaf"));
    expect(await getCar(env, key(second.root))).not.toBeNull();
    await service.unpin(key(leaf.root));
    await sweep(BASE + 34 * DAY);
    expect(await objects()).toEqual([]);
  });

  it("resets the grace period after repinning", async () => {
    const pin = await service.upload(text("repin"), "file", "first");
    await service.unpin(pin.cid);
    at(BASE + WEEK - 1);
    await service.pin(pin.cid, "again");
    expect((await sweep(BASE + 2 * WEEK)).objectsDeleted).toBe(0);
    await service.unpin(pin.cid);
    expect((await sweep(BASE + 3 * WEEK - 1)).objectsDeleted).toBe(0);
    expect((await sweep(BASE + 3 * WEEK)).objectsDeleted).toBe(2);
  });

  it("lets a concurrent repin publish fresh bytes after GC claims the old archive", async () => {
    const pin = await service.upload(text("concurrent-repin"), "file", "first");
    const oldKey = await objectKey(pin.cid);
    await service.unpin(pin.cid);
    at(BASE + WEEK);
    let started!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const put = env.BLOCKS.put.bind(env.BLOCKS);
    vi.spyOn(env.BLOCKS, "put").mockImplementationOnce(async (...args) => {
      started();
      await paused;
      return put(...args);
    });
    const repin = service.pin(pin.cid, "repinned");
    await entered;
    expect((await runRetention(env)).objectsDeleted).toBe(1);
    expect(await env.BLOCKS.head(oldKey)).toBeNull();
    resume();
    expect((await repin).cid).toBe(pin.cid);
    expect(await objectKey(pin.cid)).not.toBe(oldKey);
    await sweep(BASE + 3 * WEEK);
    expect(await readBlock(env, pin.cid)).toEqual(text("concurrent-repin"));
  });

  it("fences an expired in-flight PUT, then discovers and cleans its late orphan", async () => {
    let started!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const put = env.BLOCKS.put.bind(env.BLOCKS);
    vi.spyOn(env.BLOCKS, "put").mockImplementationOnce(async (...args) => {
      started();
      await paused;
      return put(...args);
    });
    const upload = service.upload(text("stale-writer"), "file", "late");
    const failed = expect(upload).rejects.toThrow();
    await entered;
    expect((await sweep(BASE + WEEK)).objectsDeleted).toBe(1);
    resume();
    await failed;
    expect((await service.list()).pins).toEqual([]);
    expect(await objects()).toHaveLength(1);
    expect((await sweep(BASE + 2 * WEEK)).discovered).toBe(1);
    expect((await sweep(BASE + 3 * WEEK)).objectsDeleted).toBe(1);
  });

  it("rechecks liveness after selection and rolls back a pin publication on a claimed object", async () => {
    const pin = await service.upload(text("claim-race"), "file", "first");
    const archive = await objectKey(pin.cid);
    await service.unpin(pin.cid);
    at(BASE + WEEK);
    const batch = env.DB.batch.bind(env.DB);
    let protectedOnce = false;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      // Publication and discovery use other batch sizes; GC's claim has three.
      if (!protectedOnce && statements.length === 3) {
        protectedOnce = true;
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO pins (account_id, cid, name, size, blocks) VALUES (?, ?, 'raced', 1, 1)",
          ).bind(bob.accountId, pin.cid),
          env.DB.prepare(
            "UPDATE retained_blocks SET unreferenced_at = NULL WHERE cid = ?",
          ).bind(pin.cid),
        ]);
      }
      return batch(statements);
    });
    expect((await runRetention(env)).objectsDeleted).toBe(0);
    expect(protectedOnce).toBe(true);
    await new PinService(env, bob).unpin(pin.cid);
    at(BASE + 2 * WEEK);
    const remove = vi
      .spyOn(env.BLOCKS, "delete")
      .mockRejectedValueOnce(new Error("R2 unavailable"));
    expect((await runRetention(env)).objectsFailed).toBe(1);
    await expect(
      env.DB.batch([
        writeGuard(env.DB, archive, "ready"),
        env.DB.prepare(
          "INSERT INTO pins (account_id, cid, name, size, blocks) VALUES (?, ?, 'unsafe', 1, 1)",
        ).bind(alice.accountId, pin.cid),
      ]),
    ).rejects.toThrow();
    expect((await service.list()).pins).toEqual([]);
    expect((await runRetention(env)).objectsDeleted).toBe(0);
    remove.mockRestore();
    expect((await sweep(BASE + 2 * WEEK + 60000)).objectsDeleted).toBe(1);
    expect(await objects()).toHaveLength(0);
  });

  it("discovers CAR/legacy orphans from observation time, ignores unknown keys and bounds each pass", async () => {
    for (let n = 0; n < 55; n++)
      await env.BLOCKS.put(`cars/orphan-${n}.car`, text("unpublished"));
    const legacy = await importFile(text("legacy-orphan"));
    await env.BLOCKS.put(key(legacy.root), text("legacy-orphan"));
    await env.BLOCKS.put("operator-owned", text("keep"));
    const first = await sweep(BASE + 100 * DAY);
    expect(first.discovered).toBe(50);
    expect(first.objectsDeleted).toBe(0);
    const second = await runRetention(env);
    expect(second.discovered).toBe(6);
    expect(second.unknownObjects).toBe(1);
    expect((await sweep(BASE + 107 * DAY - 1)).objectsDeleted).toBe(0);
    expect((await sweep(BASE + 107 * DAY)).objectsDeleted).toBe(20);
    expect((await runRetention(env)).objectsDeleted).toBe(20);
    expect((await runRetention(env)).objectsDeleted).toBe(16);
    expect((await objects()).map((o) => o.key)).toEqual(["operator-owned"]);
  }, 30000);

  it("backfills legacy closures and pauses deletion when an existing pin cannot be verified", async () => {
    const leaf = await importFile(text("legacy-child"));
    const dag = await parent(leaf, "legacy-root");
    await legacyPin(dag);
    const missing = await importFile(text("missing-legacy"));
    await legacyPin(missing, bob);
    await env.BLOCKS.delete(key(missing.root));
    await env.BLOCKS.put("cars/old-orphan.car", text("orphan"));
    for (let n = 0; n < 3; n++) await runRetention(env);
    const blocked = await sweep(BASE + 2 * WEEK);
    expect(blocked.blockedPins).toBe(1);
    expect(blocked.objectsDeleted).toBe(0);
    expect(await env.BLOCKS.head("cars/old-orphan.car")).not.toBeNull();
    expect(await readBlock(env, key(leaf.root))).toEqual(text("legacy-child"));
    await new PinService(env, bob).unpin(key(missing.root));
    expect((await runRetention(env)).objectsDeleted).toBe(0);
    await service.unpin(key(dag.root));
    expect((await sweep(BASE + 3 * WEEK - 1)).objectsDeleted).toBe(0);
    expect((await sweep(BASE + 3 * WEEK)).objectsDeleted).toBe(3);
  });

  it("reports fatal cleanup errors and permits an idempotent retry", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(env.BLOCKS, "list").mockRejectedValueOnce(
      new Error("listing failed"),
    );
    await expect(runRetention(env)).rejects.toThrow("listing failed");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"event":"retention_failed"'),
    );
    expect((await runRetention(env)).objectsFailed).toBe(0);
  });

  it("rolls back a failed claim and retries a lost metadata-finalization response after R2 deletion", async () => {
    const pin = await service.upload(text("gc-sql-failure"), "file", "first");
    const archive = await objectKey(pin.cid);
    await service.unpin(pin.cid);
    at(BASE + WEEK);
    const batch = env.DB.batch.bind(env.DB);
    let injected = false;
    vi.spyOn(env.DB, "batch").mockImplementation((statements) => {
      if (!injected && statements.length === 3) {
        injected = true;
        return batch([
          statements[0]!,
          env.DB.prepare("INSERT INTO nonexistent VALUES (1)"),
        ]);
      }
      return batch(statements);
    });
    expect((await runRetention(env)).objectsFailed).toBe(1);
    expect(await readBlock(env, pin.cid)).toEqual(text("gc-sql-failure"));
    expect(await objectKey(pin.cid)).toBe(archive);
    const remove = env.BLOCKS.delete.bind(env.BLOCKS);
    const prepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.BLOCKS, "delete").mockImplementationOnce(async (keys) => {
      await remove(keys);
      vi.spyOn(env.DB, "prepare").mockImplementationOnce(() =>
        prepare("DELETE FROM nonexistent"),
      );
    });
    expect((await sweep(BASE + WEEK + 60000)).objectsFailed).toBe(1);
    expect(await env.BLOCKS.head(archive)).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT state FROM storage_objects WHERE object_key = ?",
      )
        .bind(archive)
        .first(),
    ).toEqual({ state: "deleting" });
    expect((await sweep(BASE + WEEK + 180000)).objectsDeleted).toBe(1);
    expect(await objects()).toEqual([]);
  });
});

describe("token retention and authenticated views", () => {
  it("uses the earlier invalidation instant, preserves first revocation, and deletes at the exact 30-day boundary", async () => {
    const token = await createToken(env, alice, {
      name: "revoked",
      scopes: ["pins:read"],
      expiresInDays: 365,
    });
    const expired = await createToken(env, alice, {
      name: "expired",
      scopes: ["pins:read"],
      expiresInDays: 1,
    });
    await revokeToken(env, alice, token.id);
    at(BASE + 2 * DAY);
    await revokeToken(env, alice, token.id);
    await revokeToken(env, alice, expired.id);
    expect(
      (await listTokens(env, alice, true)).find((t) => t.id === token.id)!
        .revokedAt,
    ).toBe(new Date(BASE).toISOString());
    expect((await sweep(BASE + MONTH - 1)).tokensDeleted).toBe(0);
    expect((await sweep(BASE + MONTH)).tokensDeleted).toBe(1);
    expect((await sweep(BASE + MONTH + DAY - 1)).tokensDeleted).toBe(0);
    expect((await sweep(BASE + MONTH + DAY)).tokensDeleted).toBe(1);
  });

  it("defaults to active tokens, isolates history, rejects invalid credentials immediately, and requires a browser session", async () => {
    const active = await createToken(env, alice, {
      name: "active",
      scopes: ["pins:read"],
      expiresInDays: 365,
    });
    const revoked = await createToken(env, alice, {
      name: "revoked",
      scopes: ["pins:read"],
      expiresInDays: 365,
    });
    const expired = await createToken(env, alice, {
      name: "expired",
      scopes: ["pins:read"],
      expiresInDays: 1,
    });
    await createToken(env, bob, {
      name: "Bob",
      scopes: ["pins:read"],
      expiresInDays: 365,
    });
    await revokeToken(env, alice, revoked.id);
    at(BASE + DAY);
    const request = (path: string, token?: string) =>
      app.request(
        origin + path,
        { headers: token ? { authorization: `Bearer ${token}` } : { cookie } },
        env,
      );
    const list = await (
      await request("/api/tokens")
    ).json<{ tokens: { id: string }[] }>();
    expect(list.tokens.map((t) => t.id)).toEqual([active.id]);
    const history = await (
      await request("/api/tokens?view=history")
    ).json<{ tokens: { id: string }[] }>();
    expect(history.tokens.map((t) => t.id).sort()).toEqual(
      [revoked.id, expired.id].sort(),
    );
    expect((await request("/api/pins", active.token)).status).toBe(200);
    expect((await request("/api/pins", revoked.token)).status).toBe(401);
    expect((await request("/api/pins", expired.token)).status).toBe(401);
    expect(
      (await request("/api/tokens?view=history", active.token)).status,
    ).toBe(403);
    expect((await request("/api/tokens?view=all")).status).toBe(400);
    await expect(
      listTokens(env, { ...alice, kind: "agent" }, true),
    ).rejects.toMatchObject({ status: 403 });
    await expect(revokeToken(env, bob, active.id)).rejects.toMatchObject({
      status: 404,
    });
    await sweep(BASE + MONTH + DAY);
    expect((await listTokens(env, alice)).map((t) => t.id)).toEqual([
      active.id,
    ]);
    expect(await listTokens(env, alice, true)).toEqual([]);
    expect((await request("/api/pins", revoked.token)).status).toBe(401);
  });

  it("bounds token deletion and exposes the scheduled entrypoint without changing HTTP handling", async () => {
    const scopes = JSON.stringify(["pins:read"]);
    await env.DB.prepare(
      "INSERT INTO agent_tokens (id, account_id, name, prefix, token_hash, scopes, expires_at) SELECT CAST(value AS TEXT), ?, 'old', 'pb_old', CAST(value AS TEXT), ?, '2000' FROM json_each(?)",
    )
      .bind(
        alice.accountId,
        scopes,
        JSON.stringify(Array.from({ length: 105 }, (_, n) => n)),
      )
      .run();
    expect((await runRetention(env)).tokensDeleted).toBe(100);
    await app.scheduled({} as ScheduledController, env);
    expect(
      (await env.DB.prepare("SELECT count(*) AS n FROM agent_tokens").first<{
        n: number;
      }>())!.n,
    ).toBe(0);
    expect((await app.request(origin + "/api/health", {}, env)).status).toBe(
      200,
    );
  });
});
