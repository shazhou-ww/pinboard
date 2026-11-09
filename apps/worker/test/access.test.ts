import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import app from "../src/index.js";
import type { Bindings } from "../src/env.js";
import { accountForGoogle, type Principal } from "../src/identity.js";
import { scopes } from "../src/schemas.js";
import { createToken } from "../src/tokens.js";
import { PinService } from "../src/service.js";
import { PublicationService } from "../src/publications.js";
import { DescriptionService } from "../src/descriptions.js";
import { completeDag, importFile, key } from "../src/content.js";
import { encodeCar } from "../src/car.js";
import { storeDag } from "../src/storage.js";
import { restorePin } from "../src/recently-deleted.js";
import { handleMcp } from "../src/mcp.js";
import { migrate } from "./migrations.js";
import { encode } from "@auth/core/jwt";
import { HTTPException } from "hono/http-exception";

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2026-10-14",
    d1Databases: ["DB"],
    r2Buckets: ["BLOCKS"],
  }),
);
const origin = "http://access.test";
let env: Bindings, alice: Principal, bob: Principal;
let ownerToken: string,
  otherToken: string,
  readToken: string,
  uploadToken: string,
  publicationToken: string;
const text = (value: string) => new TextEncoder().encode(value);
const request = (path: string, token?: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return app.request(origin + path, { ...init, headers }, env, {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
  });
};
const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const write = (sequence: number, exposure = false) => ({
  expectedSequence: sequence,
  requestId: crypto.randomUUID(),
  acknowledgePublicExposure: exposure,
});
const pins = () => new PinService(env, alice);
const publications = () => new PublicationService(env, alice);

beforeAll(async () => {
  const bindings = await mf.getBindings<Bindings>();
  const bucket = bindings.BLOCKS;
  env = {
    ...bindings,
    BLOCKS: {
      ...bucket,
      get: bucket.get.bind(bucket),
      head: bucket.head.bind(bucket),
      put: bucket.put.bind(bucket),
      delete: bucket.delete.bind(bucket),
      list: bucket.list.bind(bucket),
    },
    AUTH_SECRET: "unit-access-test-secret-not-production",
    AUTH_URL: origin + "/api/auth",
    PUBLIC_ORIGIN: origin,
    APP_NAME: "Access test",
    PROVIDER_ID: "test-provider",
    PROVIDER_MULTIADDR: "/dns4/access.test/tcp/443/tls/http",
  };
  await migrate(env.DB);
  alice = {
    accountId: await accountForGoogle(env.DB, "access-alice"),
    kind: "session",
    scopes,
  };
  bob = { ...alice, accountId: await accountForGoogle(env.DB, "access-bob") };
  const token = async (principal: Principal, allowed: readonly string[]) =>
    (
      await createToken(env, principal, {
        name: "Unit fixture",
        scopes: allowed,
        expiresInDays: 1,
      })
    ).token;
  [ownerToken, otherToken, readToken, uploadToken, publicationToken] =
    await Promise.all([
      token(alice, scopes),
      token(bob, scopes),
      token(alice, ["pins:read"]),
      token(alice, ["pins:write"]),
      token(alice, ["publications:read"]),
    ]);
}, 30000);
afterAll(() => mf.dispose());
afterEach(() => vi.restoreAllMocks());

describe("live root access, not CID knowledge or retention", () => {
  it("checks share access, refuses OAuth outside MCP and treats invalid sessions as anonymous only", async () => {
    const pin = await pins().upload(
      text("share check " + crypto.randomUUID()),
      "file",
      "Share check",
    );
    expect((await request(`/api/public/${pin.cid}/access`)).status).toBe(404);
    expect(
      (await request(`/api/public/${pin.cid}/access`, ownerToken)).status,
    ).toBe(204);
    const oauth = "po_" + "a".repeat(43);
    expect((await request(`/ipfs/${pin.cid}?format=raw`, oauth)).status).toBe(
      403,
    );
    expect((await request(`/api/public/${pin.cid}/access`, oauth)).status).toBe(
      403,
    );
    await pins().setVisibility(pin.cid, "public");
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const stale = await request(`/api/public/${pin.cid}/access`, undefined, {
      headers: { cookie: "authjs.session-token=invalid" },
    });
    expect(stale.status).toBe(204);
    logger.mockRestore();
    expect(
      (await request(`/api/public/${pin.cid}/access`, "invalid-token")).status,
    ).toBe(401);
    const unavailable = await importFile(
      text("live metadata but missing storage " + crypto.randomUUID()),
    );
    await env.DB.prepare(
      "INSERT INTO pins (account_id, cid, name, size, blocks, visibility) VALUES (?, ?, 'Missing content fixture', ?, 1, 'public')",
    )
      .bind(alice.accountId, key(unavailable.root), unavailable.size)
      .run();
    expect(
      (await request(`/api/public/${key(unavailable.root)}/car`)).status,
    ).toBe(404);
    for (const method of ["GET", "HEAD"]) {
      expect(
        (
          await request(
            `/ipfs/${key(unavailable.root)}?format=raw`,
            undefined,
            { method, headers: { "cache-control": "only-if-cached" } },
          )
        ).status,
      ).toBe(412);
      expect(
        (
          await request(
            `/ipfs/${key(unavailable.root)}?format=raw`,
            undefined,
            { method },
          )
        ).status,
      ).toBe(404);
    }
  });

  it("does not turn session/database failures into anonymous authorization or storage reads", async () => {
    const cookie =
      "authjs.session-token=" +
      (await encode({
        token: { accountId: alice.accountId },
        secret: env.AUTH_SECRET,
        salt: "authjs.session-token",
      }));
    const before = env;
    const get = vi.spyOn(env.BLOCKS, "get"),
      head = vi.spyOn(env.BLOCKS, "head");
    const cid = key(
      (await importFile(text("unavailable authentication"))).root,
    );
    try {
      for (const error of [
        new Error("Account storage failed"),
        new HTTPException(503, { message: "Account storage unavailable" }),
      ]) {
        env = {
          ...before,
          DB: {
            prepare: () => {
              throw error;
            },
            batch: before.DB.batch.bind(before.DB),
            exec: before.DB.exec.bind(before.DB),
            dump: before.DB.dump.bind(before.DB),
            withSession: before.DB.withSession.bind(before.DB),
          },
        };
        const logger = vi.spyOn(console, "error").mockImplementation(() => {});
        const response = await request(`/ipfs/${cid}?format=raw`, undefined, {
          headers: { cookie },
        });
        expect(response.status).toBe(
          error instanceof HTTPException ? 503 : 500,
        );
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        logger.mockRestore();
      }
      expect(get).not.toHaveBeenCalled();
      expect(head).not.toHaveBeenCalled();
    } finally {
      env = before;
    }
  });

  it("keeps failed public-target HTTP uploads private and requires explicit byte/description exposure", async () => {
    const source = await pins().upload(
      text("HTTP publication source " + crypto.randomUUID()),
      "file",
      "HTTP source",
    );
    const id = (
      await publications().create(
        "HTTP public destination",
        source.cid,
        crypto.randomUUID(),
      )
    ).publication.id;
    const publication = await publications().setVisibility(id, "public");
    const failed = await request(
      `/api/publications/${id}/upload?kind=file&name=Failed-private`,
      ownerToken,
      {
        method: "POST",
        headers: {
          "idempotency-key": crypto.randomUUID(),
          "if-publication-sequence": String(publication.sequence),
        },
        body: text("failed exposure " + crypto.randomUUID()),
      },
    );
    expect(failed.status).toBe(207);
    const partial = await failed.json<{
      pin: { cid: string; visibility: string };
      publicationError: { status: number };
    }>();
    expect(partial.pin.visibility).toBe("private");
    expect(partial.publicationError.status).toBe(400);
    expect((await request(`/ipfs/${partial.pin.cid}?format=raw`)).status).toBe(
      404,
    );
    const success = await request(
      `/api/publications/${id}/upload?kind=file&name=Confirmed-private`,
      ownerToken,
      {
        method: "POST",
        headers: {
          "idempotency-key": crypto.randomUUID(),
          "if-publication-sequence": String(publication.sequence),
          "x-pinboard-public-exposure": "true",
        },
        body: text("confirmed exposure " + crypto.randomUUID()),
      },
    );
    expect(success.status).toBe(201);
    const saved = await success.json<{
      pin: { visibility: string };
      publication: {
        publication: { visibility: string; currentRevision: number };
      };
    }>();
    expect(saved.pin.visibility).toBe("private");
    expect(saved.publication.publication.visibility).toBe("public");
    expect(saved.publication.publication.currentRevision).toBe(2);
  });

  it("filters by item visibility independently and exposes publication access changes only to scoped owners", async () => {
    const a = await pins().upload(
      text("private filter " + crypto.randomUUID()),
      "file",
      "Filter private",
    );
    const b = await pins().upload(
      text("public filter " + crypto.randomUUID()),
      "file",
      "Filter public",
    );
    await pins().setVisibility(b.cid, "public");
    const publication = (
      await publications().create(
        "Filter publication",
        a.cid,
        crypto.randomUUID(),
      )
    ).publication;
    const path = `/api/publications/${publication.id}/visibility`;
    expect(
      (
        await request(
          path,
          otherToken,
          json({ visibility: "public", acknowledge: true }, "PATCH"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          path,
          ownerToken,
          json({ visibility: "public", acknowledge: false }, "PATCH"),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          path,
          ownerToken,
          json({ visibility: "public", acknowledge: true }, "PATCH"),
        )
      ).status,
    ).toBe(200);
    const pinsPrivate = await (
      await request("/api/pins?visibility=private&q=Filter", ownerToken)
    ).json<{ pins: { cid: string }[] }>();
    const pinsPublic = await (
      await request("/api/pins?visibility=public&q=Filter", ownerToken)
    ).json<{ pins: { cid: string }[] }>();
    expect(pinsPrivate.pins.some((item) => item.cid === a.cid)).toBe(true);
    expect(pinsPrivate.pins.some((item) => item.cid === b.cid)).toBe(false);
    expect(pinsPublic.pins.some((item) => item.cid === b.cid)).toBe(true);
    expect(pinsPublic.pins.some((item) => item.cid === a.cid)).toBe(false);
    const pubs = await (
      await request("/api/publications?visibility=public&q=Filter", ownerToken)
    ).json<{ publications: { id: string }[] }>();
    expect(pubs.publications.some((item) => item.id === publication.id)).toBe(
      true,
    );
    expect(
      (
        await request(
          path,
          ownerToken,
          json({ visibility: "private", acknowledge: true }, "PATCH"),
        )
      ).status,
    ).toBe(200);
    expect(
      (await request(`/api/public/publications/${publication.id}/history`))
        .status,
    ).toBe(404);
    await expect(publications().restore("not-owned")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("defaults new Pins/private publications to private and authorizes before storage, HEAD and validators", async () => {
    const pin = await pins().upload(
      text("private byte matrix " + crypto.randomUUID()),
      "file",
      "Secret title",
    );
    const created = await publications().create(
      "Secret publication",
      pin.cid,
      crypto.randomUUID(),
    );
    expect(pin.visibility).toBe("private");
    expect(created.publication.visibility).toBe("private");
    const get = vi.spyOn(env.BLOCKS, "get"),
      head = vi.spyOn(env.BLOCKS, "head");
    for (const path of [
      `/ipfs/${pin.cid}?format=raw`,
      `/api/public/${pin.cid}/car`,
      `/api/public/${pin.cid}/download`,
      `/api/public/publications/${created.publication.id}`,
      `/api/public/publications/${created.publication.id}/history`,
      `/api/public/publications/${created.publication.id}/preview/1`,
      `/api/public/publications/${created.publication.id}/versions/1/nodes/${pin.cid}/description`,
      `/api/public/publications/${created.publication.id}/download/1?format=original`,
    ]) {
      for (const token of [undefined, otherToken, uploadToken]) {
        for (const method of ["GET", "HEAD"]) {
          const denied = await request(path, token, {
            method,
            headers: { "if-none-match": "*" },
          });
          expect(denied.status, path).toBe(404);
          expect(denied.headers.get("etag")).toBeNull();
          expect(denied.headers.get("cache-control")).toBe("private, no-store");
          expect(await denied.text()).not.toContain("Secret");
        }
      }
    }
    expect(get).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
    for (const token of [ownerToken, readToken, publicationToken]) {
      const response = await request(`/ipfs/${pin.cid}?format=raw`, token);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("private byte matrix");
    }
    expect(
      (
        await request(
          `/api/public/publications/${created.publication.id}`,
          readToken,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/api/public/publications/${created.publication.id}`,
          publicationToken,
        )
      ).status,
    ).toBe(200);
    const providers = await request(`/routing/v1/providers/${pin.cid}`);
    expect(await providers.json()).toEqual({ Providers: [] });
  });

  it("blocks pin-by-CID, omitted DAG blocks, unauthorized publication references and orphaned writes", async () => {
    const child = await importFile(
      text("private child " + crypto.randomUUID()),
    );
    const bytes = dagCbor.encode({ child: child.root });
    const root = CID.createV1(dagCbor.code, await sha256.digest(bytes));
    const dag = await completeDag(root, (cid) =>
      cid.equals(root) ? bytes : child.blocks.get(key(cid)),
    );
    const pin = await pins().upload(await encodeCar(dag), "car", "Private DAG");
    const stranger = new PinService(env, bob);
    await expect(stranger.pin(pin.cid, "Stolen")).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      stranger.upload(bytes, "block", "Completion attack", pin.cid),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      new PinService(env, { ...alice, scopes: ["pins:write"] }).pin(
        pin.cid,
        "Scope escalation",
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      new PublicationService(env, bob).create(
        "Stolen",
        pin.cid,
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    for (const cid of dag.blocks.keys())
      expect((await request(`/ipfs/${cid}?format=raw`)).status).toBe(404);
    const orphan = await importFile(
      text("unreferenced completed write " + crypto.randomUUID()),
    );
    await storeDag(env, orphan);
    expect((await request(`/ipfs/${key(orphan.root)}?format=raw`)).status).toBe(
      404,
    );
    await expect(
      stranger.pin(key(orphan.root), "Unreferenced"),
    ).rejects.toMatchObject({ status: 404 });
    const supplied = await stranger.upload(
      await encodeCar(dag),
      "car",
      "Supplied complete bytes",
    );
    expect(supplied.visibility).toBe("private");
    expect((await request(`/ipfs/${supplied.cid}?format=raw`)).status).toBe(
      404,
    );
  });

  it("revokes the last public DAG/thumbnail reference without leaking overlapping private metadata", async () => {
    const child = await importFile(text("shared child " + crypto.randomUUID()));
    const bytes = dagCbor.encode({ child: child.root });
    const root = CID.createV1(dagCbor.code, await sha256.digest(bytes));
    const dag = await completeDag(root, (cid) =>
      cid.equals(root) ? bytes : child.blocks.get(key(cid)),
    );
    const pin = await pins().upload(
      await encodeCar(dag),
      "car",
      "Private root label",
    );
    const imageBytes = text("unit thumbnail " + crypto.randomUUID());
    const image = CID.createV1(
      0x55,
      await sha256.digest(imageBytes),
    ).toString();
    await env.DB.prepare(
      "INSERT INTO preview_images (cid, bytes, width, height) VALUES (?, ?, 1, 1)",
    )
      .bind(image, imageBytes)
      .run();
    await env.DB.prepare(
      "INSERT INTO content_previews (source_cid, version, status, descriptor, thumbnail_cid, retry_at) VALUES (?, 3, 'ready', '{}', ?, '') ON CONFLICT(source_cid, version) DO UPDATE SET thumbnail_cid = excluded.thumbnail_cid",
    )
      .bind(key(child.root), image)
      .run();
    expect((await request(`/ipfs/${image}`)).status).toBe(404);
    await pins().setVisibility(pin.cid, "public");
    const privateCopy = await new PinService(env, bob).pin(
      pin.cid,
      "Bob secret metadata",
    );
    expect(privateCopy.visibility).toBe("private");
    for (const cid of [...dag.blocks.keys(), image]) {
      const path = `/ipfs/${cid}?${cid === image ? "access=v1" : "format=raw"}`;
      const publicRead = await request(path);
      expect(publicRead.status).toBe(200);
      const etag = publicRead.headers.get("etag")!;
      await publicRead.body?.cancel();
      await pins().setVisibility(pin.cid, "private");
      expect(
        (
          await request(path, undefined, {
            method: "HEAD",
            headers: { "if-none-match": etag },
          })
        ).status,
      ).toBe(404);
      expect((await request(path, otherToken)).status).toBe(200);
      await pins().setVisibility(pin.cid, "public");
    }
    await pins().setVisibility(pin.cid, "private");
    expect((await request(`/api/pins/${pin.cid}`, otherToken)).status).toBe(
      200,
    );
    expect((await request(`/api/pins/${pin.cid}`)).status).toBe(401);
    await pins().unpin(pin.cid);
    await new PinService(env, bob).unpin(pin.cid);
    expect(
      (await request(`/ipfs/${key(child.root)}?format=raw`, ownerToken)).status,
    ).toBe(404);
    await restorePin(env, alice, pin.cid);
    expect((await pins().detail(pin.cid)).visibility).toBe("private");
    expect((await request(`/ipfs/${key(child.root)}?format=raw`)).status).toBe(
      404,
    );
  });

  it("publication visibility covers all snapshots, survives rollback/restore and requires explicit private-source exposure", async () => {
    const source = await pins().upload(
      text("publication v1 " + crypto.randomUUID()),
      "file",
      "Private source",
    );
    await new DescriptionService(env, alice).write(source.cid, source.cid, {
      text: "Private description",
      expectedVersion: 0,
    });
    const created = await publications().create(
      "Private all-history title",
      source.cid,
      crypto.randomUUID(),
    );
    const id = created.publication.id;
    let current = await publications().setVisibility(id, "public");
    expect((await pins().detail(source.cid)).visibility).toBe("private");
    const next = await pins().upload(
      text("publication v2 " + crypto.randomUUID()),
      "file",
      "Private v2",
    );
    await expect(
      publications().publish(id, next.cid, write(current.sequence)),
    ).rejects.toMatchObject({ status: 400 });
    current = (
      await publications().publish(id, next.cid, write(current.sequence, true))
    ).publication;
    expect(current.visibility).toBe("public");
    expect((await pins().detail(next.cid)).visibility).toBe("private");
    const old = await request(`/api/public/publications/${id}/versions/1`);
    expect(await old.text()).toContain("Private description");
    current = (await publications().rollback(id, 1, write(current.sequence)))
      .publication;
    expect(current.currentRevision).toBe(1);
    expect(current.revisionCount).toBe(2);
    await publications().setVisibility(id, "private");
    for (const suffix of [
      "",
      "/history",
      "/versions/1",
      "/versions/2",
      "/download/1",
      "/download/2",
      "/preview/1",
    ])
      expect(
        (
          await request(`/api/public/publications/${id}${suffix}`, undefined, {
            headers: { "if-none-match": "*" },
          })
        ).status,
      ).toBe(404);
    expect((await request(`/ipfs/${next.cid}?format=raw`)).status).toBe(404);
    await publications().delete(id);
    const restored = await publications().restore(id);
    expect(restored.visibility).toBe("private");
    expect(restored.currentRevision).toBe(1);
    expect(
      (await request(`/api/public/publications/${id}/history`)).status,
    ).toBe(404);
    const converted = await publications().create(
      "Converted privately",
      next.cid,
      crypto.randomUUID(),
      true,
    );
    expect(converted.publication.visibility).toBe("private");
  });

  it("HTTP and MCP visibility mutations preserve read/write credential boundaries", async () => {
    const pin = await pins().upload(
      text("scoped mutation " + crypto.randomUUID()),
      "file",
      "Scoped Pin",
    );
    const path = `/api/pins/${pin.cid}/visibility`;
    for (const token of [otherToken, readToken, uploadToken]) {
      expect(
        (
          await request(
            path,
            token,
            json({ visibility: "public", acknowledge: true }, "PATCH"),
          )
        ).status,
      ).toBe(token === otherToken ? 404 : 403);
    }
    expect(
      (await request(path, ownerToken, json({ visibility: "public" }, "PATCH")))
        .status,
    ).toBe(400);
    expect((await pins().detail(pin.cid)).visibility).toBe("private");
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
            name: "access_set",
            arguments: {
              kind: "pin",
              id: pin.cid,
              visibility: "public",
              acknowledge: true,
            },
          },
        }),
      }),
      env,
      { ...alice, kind: "oauth", scopes: ["pins:read"] },
    );
    expect(await response.text()).toContain("Missing permission: pins:write");
    expect((await pins().detail(pin.cid)).visibility).toBe("private");
    const changed = await request(
      path,
      ownerToken,
      json({ visibility: "public", acknowledge: true }, "PATCH"),
    );
    expect(changed.status).toBe(200);
    expect((await request(`/ipfs/${pin.cid}?format=raw`)).status).toBe(200);
  });
  it("does not use idempotent publication responses to bypass private-read scopes or deletion", async () => {
    const source = await pins().upload(
      text("replay scope " + crypto.randomUUID()),
      "file",
      "Replay source",
    );
    const requestId = crypto.randomUUID();
    const created = await publications().create(
      "Private replay title",
      source.cid,
      requestId,
    );
    await env.DB.prepare(
      "UPDATE publication_requests SET result = json_remove(result, '$.publication.visibility') WHERE account_id = ? AND request_id = ?",
    )
      .bind(alice.accountId, requestId)
      .run();
    expect(
      (
        await publications().create(
          "Private replay title",
          source.cid,
          requestId,
        )
      ).publication.visibility,
    ).toBe("private");
    await publications().setVisibility(created.publication.id, "public");
    expect(
      (
        await publications().create(
          "Private replay title",
          source.cid,
          requestId,
        )
      ).publication.visibility,
    ).toBe("public");
    await publications().setVisibility(created.publication.id, "private");
    const limited = new PublicationService(env, {
      ...alice,
      scopes: ["pins:read", "publications:write"],
    });
    await expect(
      limited.create("Private replay title", source.cid, requestId),
    ).rejects.toMatchObject({ status: 403 });
    await publications().delete(created.publication.id);
    await expect(
      publications().create("Private replay title", source.cid, requestId),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await request(
          `/api/public/publications/${created.publication.id}/history`,
          ownerToken,
        )
      ).status,
    ).toBe(404);
  });
  it("lets scoped MCP OAuth Agents read complete private DAG blocks without using HTTP credentials", async () => {
    const data = text(
      ("MCP private bytes " + crypto.randomUUID()).repeat(7000),
    );
    const dag = await importFile(data);
    const pin = await pins().upload(data, "file", "MCP private file");
    const call = async (cid: string, principal: Principal) => {
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
            params: { name: "block_get", arguments: { cid } },
          }),
        }),
        env,
        principal,
      );
      return response.json<{
        result: { isError?: boolean; content: { text: string }[] };
      }>();
    };
    for (const [cid, bytes] of dag.blocks) {
      const response = await call(cid, {
        ...alice,
        kind: "oauth",
        scopes: ["pins:read"],
      });
      expect(response.result.isError).not.toBe(true);
      const block = JSON.parse(response.result.content[0]!.text) as {
        contentBase64: string;
        byteAccess: string;
      };
      expect(
        new Uint8Array(Buffer.from(block.contentBase64, "base64")),
      ).toEqual(bytes);
      expect(block.byteAccess).toBe("private");
      expect((await call(cid, bob)).result.isError).toBe(true);
    }
    const publication = (
      await publications().create(
        "MCP private publication",
        pin.cid,
        crypto.randomUUID(),
      )
    ).publication;
    await pins().unpin(pin.cid);
    expect(
      (await call(pin.cid, { ...alice, kind: "oauth", scopes: ["pins:read"] }))
        .result.isError,
    ).toBe(true);
    expect(
      (
        await call(pin.cid, {
          ...alice,
          kind: "oauth",
          scopes: ["publications:read"],
        })
      ).result.isError,
    ).not.toBe(true);
    await publications().setVisibility(publication.id, "public");
    const shared = JSON.parse(
      (await call(pin.cid, bob)).result.content[0]!.text,
    ) as { byteAccess: string };
    expect(shared.byteAccess).toBe("public");
    const empty = await pins().upload(
      new Uint8Array(),
      "file",
      "MCP empty file",
    );
    const emptyBlock = JSON.parse(
      (await call(empty.cid, alice)).result.content[0]!.text,
    ) as { size: number; contentBase64: string };
    expect(emptyBlock).toMatchObject({ size: 0, contentBase64: "" });
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1).fill(17);
    const legacyCid = CID.createV1(
      0x55,
      await sha256.digest(oversized),
    ).toString();
    await env.BLOCKS.put(legacyCid, oversized);
    await env.DB.prepare(
      "INSERT INTO pins (account_id, cid, name, size, blocks, visibility) VALUES (?, ?, 'Legacy large block', ?, 1, 'public')",
    )
      .bind(alice.accountId, legacyCid, oversized.length)
      .run();
    expect((await call(legacyCid, alice)).result.content[0]!.text).toContain(
      "413",
    );
    const missing = key((await importFile(text("missing MCP storage"))).root);
    await env.DB.prepare(
      "INSERT INTO pins (account_id, cid, name, size, blocks, visibility) VALUES (?, ?, 'Missing MCP block', 19, 1, 'public')",
    )
      .bind(alice.accountId, missing)
      .run();
    expect((await call(missing, alice)).result.content[0]!.text).toContain(
      "404",
    );
    const truncated = text("truncated MCP legacy block");
    const truncatedCid = CID.createV1(
      0x55,
      await sha256.digest(truncated),
    ).toString();
    await env.BLOCKS.put(truncatedCid, truncated);
    await env.DB.prepare(
      "INSERT INTO pins (account_id, cid, name, size, blocks, visibility) VALUES (?, ?, 'Truncated MCP block', ?, 1, 'public')",
    )
      .bind(alice.accountId, truncatedCid, truncated.length)
      .run();
    const original = (await env.BLOCKS.get(truncatedCid))!;
    const truncatedObject = new Proxy(original, {
      get(target, property) {
        if (property === "body")
          return new Blob([new Uint8Array([1])]).stream();
        return Reflect.get(target, property, target) as unknown;
      },
    });
    const spy = vi
      .spyOn(env.BLOCKS, "get")
      .mockResolvedValueOnce(truncatedObject);
    expect((await call(truncatedCid, alice)).result.content[0]!.text).toContain(
      "503",
    );
    spy.mockRestore();
  });
});
