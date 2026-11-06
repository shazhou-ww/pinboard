import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrations.js";
import type { Bindings } from "../src/env.js";
import { accountForGoogle, type Principal } from "../src/identity.js";
import { PinService } from "../src/service.js";
import { PublicationService } from "../src/publications.js";
import { matchesItemFilter } from "../src/item-filter.js";
import { scopes } from "../src/schemas.js";
import app from "../src/index.js";
import { createToken } from "../src/tokens.js";

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
beforeAll(async () => {
  env = {
    ...(await mf.getBindings<Bindings>()),
    PUBLIC_ORIGIN: "http://localhost",
    AUTH_URL: "http://localhost/api/auth",
    AUTH_SECRET: "item-filter-test-secret-long-enough",
  };
  await migrate(env.DB);
  owner = {
    accountId: await accountForGoogle(env.DB, "filter-owner"),
    kind: "session",
    scopes,
  };
  pins = new PinService(env, owner);
  publications = new PublicationService(env, owner);
  const other = await accountForGoogle(env.DB, "other-filter-owner");
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < 105; index++) {
    const id = String(index).padStart(3, "0");
    const cid = `cid-${id}`;
    const name = index === 104 ? "ÉCOLE 中文  literal%_" : "ordinary";
    statements.push(
      env.DB.prepare(
        "INSERT INTO pins (account_id, cid, name, size, blocks) VALUES (?, ?, ?, 1, 1)",
      ).bind(owner.accountId, cid, name),
      env.DB.prepare(
        "INSERT INTO node_descriptions (account_id, root_cid, node_cid, text, version) VALUES (?, ?, ?, ?, 1)",
      ).bind(owner.accountId, cid, cid, index === 103 ? "Root ÉTÉ" : "common"),
      env.DB.prepare(
        "INSERT INTO publications (id, account_id, title, current_revision, sequence, created_at, updated_at) VALUES (?, ?, ?, 1, 1, '2026-01-01', '2026-01-01')",
      ).bind(id, owner.accountId, name),
      env.DB.prepare(
        "INSERT INTO publication_revisions (publication_id, revision, cid, size, blocks, descriptions, created_at) VALUES (?, 1, ?, 1, 1, ?, '2026-01-01')",
      ).bind(
        id,
        cid,
        JSON.stringify({
          [cid]: index === 103 ? "Root ÉTÉ" : "common",
          child: "excluded-child",
        }),
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      "INSERT INTO publications (id, account_id, title, current_revision, sequence, created_at, updated_at) VALUES ('foreign', ?, 'foreign-secret', 1, 1, '2026-01-01', '2026-01-01')",
    ).bind(other),
    env.DB.prepare(
      "INSERT INTO publication_revisions (publication_id, revision, cid, size, blocks, descriptions, created_at) VALUES ('foreign', 1, 'cid-104', 1, 1, '{\"cid-104\":\"foreign-root\"}', '2026-01-01')",
    ),
    env.DB.prepare(
      "INSERT INTO pins (account_id, cid, name, size, blocks) VALUES (?, 'foreign', 'foreign-secret', 1, 1)",
    ).bind(other),
    env.DB.prepare(
      "INSERT INTO node_descriptions (account_id, root_cid, node_cid, text, version) VALUES (?, 'cid-104', 'child', 'excluded-child', 1)",
    ).bind(owner.accountId),
    env.DB.prepare(
      "INSERT INTO publication_revisions (publication_id, revision, cid, size, blocks, descriptions, created_at) VALUES ('104', 2, 'old', 1, 1, '{\"old\":\"excluded-old\"}', '2026-01-01')",
    ),
  );
  for (let index = 0; index < statements.length; index += 50)
    await env.DB.batch(statements.slice(index, index + 50));
}, 30000);
afterAll(() => mf.dispose());

describe("server-side item filtering", () => {
  it("finds Unicode title and root description beyond the ordinary first page", async () => {
    expect((await pins.list()).pins).toHaveLength(50);
    expect((await publications.list()).publications).toHaveLength(50);
    for (const query of [" éCoLe ", "中文", "literal%_", "ÉTÉ"]) {
      expect((await pins.list(undefined, query)).pins).toHaveLength(1);
      expect((await publications.list("", query)).publications).toHaveLength(1);
    }
    expect((await pins.list(undefined, "école")).pins[0]?.cid).toBe("cid-104");
    expect((await publications.list("", "été")).publications[0]?.id).toBe(
      "103",
    );
  });
  it("preserves order and the 50-result cursor across matching pages", async () => {
    const first = await pins.list(undefined, "common");
    const second = await pins.list(first.nextCursor!, "common");
    const third = await pins.list(second.nextCursor!, "common");
    expect([first.pins.length, second.pins.length, third.pins.length]).toEqual([
      50, 50, 4,
    ]);
    expect(
      new Set(
        [...first.pins, ...second.pins, ...third.pins].map((pin) => pin.cid),
      ).size,
    ).toBe(104);
    expect(third.nextCursor).toBeNull();
    const a = await publications.list("", "common");
    const b = await publications.list(a.nextCursor!, "common");
    const c = await publications.list(b.nextCursor!, "common");
    expect([
      a.publications.length,
      b.publications.length,
      c.publications.length,
    ]).toEqual([50, 50, 4]);
    expect(c.nextCursor).toBeNull();
  });
  it("excludes CID, children, old revisions, other accounts and cross-field joins", async () => {
    for (const query of [
      "cid-104",
      "excluded-child",
      "excluded-old",
      "foreign-secret",
      "foreign-root",
      "école 中文 literal",
      "ordinarycommon",
    ]) {
      expect((await pins.list(undefined, query)).pins).toEqual([]);
      expect((await publications.list("", query)).publications).toEqual([]);
    }
    expect(await pins.list(undefined, " \t ")).toEqual(await pins.list());
    expect(await publications.list("", " \n ")).toEqual(
      await publications.list(),
    );
    expect((await pins.list(undefined, "école")).pins[0]).not.toHaveProperty(
      "rootDescription",
    );
  });
  it("matches literal punctuation, internal spaces, missing descriptions and Unicode without accent folding", () => {
    expect(matchesItemFilter("%_", "100%_done", null)).toBe(true);
    expect(matchesItemFilter("a  b", "a b", null)).toBe(false);
    expect(matchesItemFilter("é", "É", null)).toBe(true);
    expect(matchesItemFilter("e", "É", null)).toBe(false);
    expect(matchesItemFilter("中文", "", "中文")).toBe(true);
    expect(matchesItemFilter("name", "Name", null)).toBe(true);
  });
  it("validates HTTP q, preserves authentication and scopes", async () => {
    const { token } = await createToken(env, owner, {
      name: "test",
      scopes: [...scopes],
      expiresInDays: 1,
    });
    const headers = { authorization: `Bearer ${token}` };
    for (const path of ["/api/pins", "/api/publications"]) {
      expect(
        (
          await app.request(
            `http://localhost${path}?q=${"a".repeat(201)}`,
            { headers },
            env,
          )
        ).status,
      ).toBe(400);
      expect(
        (await app.request(`http://localhost${path}?q=common`, {}, env)).status,
      ).toBe(401);
      const response = await app.request(
        `http://localhost${path}?q=%C3%A9cole`,
        { headers },
        env,
      );
      expect(response.status).toBe(200);
      const body = await response.json<{
        pins?: unknown[];
        publications?: unknown[];
      }>();
      expect(body.pins ?? body.publications).toHaveLength(1);
    }
    await expect(
      new PinService(env, { ...owner, scopes: [] }).list(undefined, "x"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      new PublicationService(env, { ...owner, scopes: [] }).list("", "x"),
    ).rejects.toMatchObject({ status: 403 });
  });
});
