import { encode } from "@auth/core/jwt";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { migrate } from "./migrations.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env.js";
import app, { toSessionResponse } from "../src/index.js";
import { createAuthConfig } from "../src/auth.js";
import {
  accountForGoogle,
  hashToken,
  type Principal,
} from "../src/identity.js";
import { PinService } from "../src/service.js";
import { createToken, revokeToken } from "../src/tokens.js";
import { importFile } from "../src/content.js";
import { encodeCar } from "../src/car.js";
import { handleMcp } from "../src/mcp.js";
import { MAX_UPLOAD } from "../src/content.js";
import type { Pin } from "@workspace/contracts";

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } };",
    compatibilityDate: "2026-10-14",
    d1Databases: ["DB"],
    r2Buckets: ["BLOCKS"],
    serviceBindings: { ASSETS: () => new Response("test assets") },
  }),
);
let env: Bindings;
let alice: Principal;
let bob: Principal;
let cookie: string;
let token: string;
let tokenId: string;
let cid: string;
const bytes = new TextEncoder().encode(
  "<script>globalThis.pwned=true</script>",
);
const origin = "http://example.test";
const request = (path: string, init?: RequestInit) =>
  app.request(origin + path, init, env);
const sessionHeaders = () => ({
  cookie,
  origin,
  "content-type": "application/json",
});
const bearer = () => ({ authorization: `Bearer ${token}` });
type McpResult = { result: { content: { text: string }[]; isError?: boolean } };
const rpcText = async (response: Response) =>
  (await response.json<McpResult>()).result.content[0]!.text;
const rpc = (name: string, args: Record<string, unknown> = {}) =>
  request("/mcp", {
    method: "POST",
    headers: {
      ...bearer(),
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

beforeAll(async () => {
  const db = await mf.getD1Database("DB");
  await migrate(db);
  env = {
    ...(await mf.getBindings<Pick<Bindings, "DB" | "BLOCKS" | "ASSETS">>()),
    APP_NAME: "Pinboard",
    AUTH_SECRET: "test-secret-that-is-long-enough-for-auth",
    AUTH_URL: origin + "/api/auth",
    PUBLIC_ORIGIN: origin,
    PROVIDER_ID: "12D3KooWCjfPiojcCUmv78Wd1NJzi4Mraj1moxigp7AfQVQvGLwH",
    PROVIDER_MULTIADDR: "/dns4/pinboard.shazhou.work/tcp/443/tls/http",
  };
  alice = {
    accountId: await accountForGoogle(env.DB, "alice-google-subject"),
    scopes: ["pins:read", "pins:write", "pins:delete"],
    kind: "session",
  };
  bob = {
    ...alice,
    accountId: await accountForGoogle(env.DB, "bob-google-subject"),
  };
  cookie = `authjs.session-token=${await encode({ token: { accountId: alice.accountId, name: "Alice" }, secret: env.AUTH_SECRET, salt: "authjs.session-token" })}`;
}, 30000);
afterAll(async () => {
  await mf.dispose();
});

describe("identity and HTTP boundaries", () => {
  it("reports health and only enables Google", async () => {
    expect(await (await request("/api/health")).json()).toEqual({
      service: "Pinboard",
      status: "ok",
    });
    expect(await (await request("/api/bootstrap")).json()).toMatchObject({
      providers: [],
    });
    const config = createAuthConfig({
      ...env,
      AUTH_GOOGLE_ID: "id",
      AUTH_GOOGLE_SECRET: "secret",
    });
    expect(config.providers).toHaveLength(1);
    expect(
      createAuthConfig({ ...env, AUTH_GOOGLE_ID: " " }).providers,
    ).toHaveLength(0);
    expect(
      await (
        await app.request(
          origin + "/api/bootstrap",
          {},
          { ...env, AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "secret" },
        )
      ).json(),
    ).toMatchObject({ providers: [{ id: "google", label: "Google" }] });
    expect(await accountForGoogle(env.DB, "alice-google-subject")).toBe(
      alice.accountId,
    );
    expect(bob.accountId).not.toBe(alice.accountId);
  });
  it("serves Google's native CSRF-protected form through the supported sign-in page", async () => {
    const response = await app.request(
      origin + "/api/auth/signin?callbackUrl=/",
      {},
      {
        ...env,
        AUTH_GOOGLE_ID: "google-id",
        AUTH_GOOGLE_SECRET: "google-secret",
      },
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`action="${origin}/api/auth/signin/google"`);
    expect(html).toMatch(/method="post"/i);
    expect(html).toContain('name="csrfToken"');
    expect(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith("authjs.csrf-token=")),
    ).toBe(true);
  });

  it("starts Google OAuth using a CSRF-protected POST rather than a provider GET", async () => {
    const bindings = {
      ...env,
      AUTH_GOOGLE_ID: "google-id",
      AUTH_GOOGLE_SECRET: "google-secret",
    };
    const csrf = await app.request(origin + "/api/auth/csrf", {}, bindings);
    const { csrfToken } = await csrf.json<{ csrfToken: string }>();
    const cookies = csrf.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        if (
          url.href !==
          "https://accounts.google.com/.well-known/openid-configuration"
        ) {
          throw new Error("Unexpected OAuth metadata request");
        }
        return Promise.resolve(
          Response.json({
            issuer: "https://accounts.google.com",
            authorization_endpoint:
              "https://accounts.google.com/o/oauth2/v2/auth",
            token_endpoint: "https://oauth2.googleapis.com/token",
            userinfo_endpoint:
              "https://openidconnect.googleapis.com/v1/userinfo",
            jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            token_endpoint_auth_methods_supported: [
              "client_secret_post",
              "client_secret_basic",
            ],
            code_challenge_methods_supported: ["S256"],
          }),
        );
      });
    try {
      const response = await app.request(
        origin + "/api/auth/signin/google",
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: cookies,
          },
          body: new URLSearchParams({
            csrfToken,
            callbackUrl: origin + "/",
          }).toString(),
        },
        bindings,
      );
      expect(response.status).toBe(302);
      const redirect = new URL(response.headers.get("location")!);
      expect(redirect.origin).toBe("https://accounts.google.com");
      expect(redirect.searchParams.get("client_id")).toBe("google-id");
      expect(redirect.searchParams.get("redirect_uri")).toBe(
        origin + "/api/auth/callback/google",
      );
      expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
      expect(redirect.searchParams.get("code_challenge")).toBeTruthy();
      expect(redirect.searchParams.get("prompt")).toBe("select_account");
      expect(redirect.searchParams.has("client_secret")).toBe(false);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("clears the browser session with a CSRF-protected logout POST without a confirmation page", async () => {
    const csrf = await request("/api/auth/csrf", { headers: { cookie } });
    const { csrfToken } = await csrf.json<{ csrfToken: string }>();
    const cookies = [
      cookie,
      ...csrf.headers.getSetCookie().map((value) => value.split(";")[0]),
    ].join("; ");
    const response = await request("/api/auth/signout", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-auth-return-redirect": "1",
        cookie: cookies,
      },
      body: new URLSearchParams({
        csrfToken,
        callbackUrl: origin + "/",
      }).toString(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: origin + "/" });
    const cleared = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("authjs.session-token="));
    expect(cleared).toMatch(/max-age=0/i);
    const signedOutCookies = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    expect(
      await (
        await request("/api/auth/session", {
          headers: { cookie: signedOutCookies },
        })
      ).json(),
    ).toBeNull();
    expect(
      (await request("/api/pins", { headers: { cookie: signedOutCookies } }))
        .status,
    ).toBe(401);
  });

  it("does not allow logout without CSRF protection", async () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await request("/api/auth/signout", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-auth-return-redirect": "1",
          cookie,
        },
        body: new URLSearchParams({ callbackUrl: origin + "/" }).toString(),
      });
      expect(response.status).toBe(200);
      const result = await response.json<{ url: string }>();
      expect(new URL(result.url).searchParams.get("error")).toBe("MissingCSRF");
      expect(
        response.headers
          .getSetCookie()
          .some((value) => value.startsWith("authjs.session-token=;")),
      ).toBe(false);
      expect(logger).toHaveBeenCalled();
    } finally {
      logger.mockRestore();
    }
  });

  it("uses a signed session carrying an internal accountId", async () => {
    const response = await request("/api/me", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { id: alice.accountId },
    });
    expect(toSessionResponse({ expires: "2099" })).toEqual({ expires: "2099" });
  });
  it("binds Google provider subjects, not email or labels, in the JWT callback", async () => {
    const jwt = createAuthConfig(env).callbacks!.jwt!;
    const result = await jwt({
      token: {},
      user: { id: "ignored" },
      account: {
        provider: "google",
        providerAccountId: "alice-google-subject",
        type: "oidc",
      },
    });
    expect(result?.accountId).toBe(alice.accountId);
    await expect(
      jwt({
        token: {},
        user: { id: "ignored" },
        account: {
          provider: "github",
          providerAccountId: "alice-google-subject",
          type: "oauth",
        },
      }),
    ).rejects.toThrow("Unsupported");
  });
  it.each(["/api/me", "/api/pins", "/api/tokens", "/mcp"])(
    "requires authentication at %s",
    async (path) => {
      expect((await request(path)).status).toBe(401);
    },
  );
  it("rejects foreign origins, missing browser mutation origins and malformed JSON", async () => {
    expect(
      (
        await request("/api/pins", {
          method: "POST",
          headers: { cookie, origin: "https://evil.test" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/pins", {
          method: "POST",
          headers: { cookie },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/api/pins", {
          method: "POST",
          headers: sessionHeaders(),
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/pins", {
          method: "POST",
          headers: sessionHeaders(),
          body: JSON.stringify({ cid: "x", public: false }),
        })
      ).status,
    ).toBe(400);
    expect((await request("/api/unknown")).status).toBe(404);
  });
  it("does not grant access to signed sessions without account identity", async () => {
    const invalid = await encode({
      token: { sub: "google-subject" },
      secret: env.AUTH_SECRET,
      salt: "authjs.session-token",
    });
    expect(
      (
        await request("/api/pins", {
          headers: { cookie: `authjs.session-token=${invalid}` },
        })
      ).status,
    ).toBe(401);
  });
});

describe("pins and immutable public reads", () => {
  it("requires explicit public consent, then imports a file", async () => {
    expect(
      (
        await request("/api/pins/upload?kind=file", {
          method: "POST",
          headers: sessionHeaders(),
          body: bytes,
        })
      ).status,
    ).toBe(400);
    const response = await request(
      "/api/pins/upload?kind=file&name=page.html",
      {
        method: "POST",
        headers: { ...sessionHeaders(), "x-pinboard-public": "true" },
        body: bytes,
      },
    );
    expect(response.status).toBe(201);
    const pin = await response.json<{ cid: string; blocks: number }>();
    cid = pin.cid;
    expect(pin.blocks).toBe(1);
  });
  it("provides raw HEAD/GET, probe and routing in both standard formats", async () => {
    const raw = await request(`/ipfs/${cid}?format=raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-disposition")).toContain("attachment");
    expect(raw.headers.get("content-security-policy")).toContain("sandbox");
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(bytes);
    const head = await request(`/ipfs/${cid}`, {
      method: "HEAD",
      headers: { accept: "application/vnd.ipld.raw" },
    });
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    expect(await head.text()).toBe("");
    expect((await request(`/ipfs/${cid}`)).status).toBe(400);
    expect((await request(`/ipfs/${cid}?format=html`)).status).toBe(406);
    const probe = await request("/ipfs/bafkqaaa?format=raw", {
      method: "HEAD",
    });
    expect(probe.status).toBe(200);
    expect(probe.headers.get("content-length")).toBe("0");
    const route = await (await request(`/routing/v1/providers/${cid}`)).json();
    expect(route).toMatchObject({
      Providers: [{ Schema: "peer", Addrs: [env.PROVIDER_MULTIADDR] }],
    });
    const ndjson = await request(`/routing/v1/providers/${cid}`, {
      headers: { accept: "application/x-ndjson" },
    });
    expect(ndjson.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    expect(JSON.parse((await ndjson.text()).trim())).toMatchObject({
      Schema: "peer",
    });
    const missing = (await importFile(new Uint8Array([99]))).root.toString();
    expect((await request(`/ipfs/${missing}?format=raw`)).status).toBe(404);
    expect(
      (await request(`/ipfs/${missing}?format=raw`, { method: "HEAD" })).status,
    ).toBe(404);
    expect(
      await (await request(`/routing/v1/providers/${missing}`)).json(),
    ).toEqual({ Providers: [] });
    expect((await request(`/api/public/${missing}/car`)).status).toBe(404);
    expect((await request("/ipfs/not-a-cid?format=raw")).status).toBe(400);
  });
  it("lists and returns details only for the current account", async () => {
    expect(
      await (await request("/api/pins", { headers: { cookie } })).json(),
    ).toMatchObject({ pins: [{ cid, name: "page.html" }], nextCursor: null });
    expect(
      (await request(`/api/pins/${cid}`, { headers: { cookie } })).status,
    ).toBe(200);
    expect(await new PinService(env, bob).list()).toEqual({
      pins: [],
      nextCursor: null,
    });
    await expect(new PinService(env, bob).detail(cid)).rejects.toMatchObject({
      status: 404,
    });
    await expect(new PinService(env, bob).unpin(cid)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("validates complete CAR import/export and account-safe shared references", async () => {
    const car = await request(`/api/public/${cid}/car`);
    expect(car.headers.get("content-type")).toContain(
      "application/vnd.ipld.car",
    );
    const receipt = await new PinService(env, bob).upload(
      new Uint8Array(await car.arrayBuffer()),
      "car",
      "Bob's pin",
    );
    expect(receipt.cid).toBe(cid);
    await new PinService(env, alice).pin(cid, "renamed");
    await new PinService(env, alice).unpin(cid);
    expect((await new PinService(env, bob).detail(cid)).name).toBe("Bob's pin");
    expect((await request(`/ipfs/${cid}?format=raw`)).status).toBe(200);
    const response = await request("/api/pins", {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({ cid, name: "Restored", public: true }),
    });
    expect(response.status).toBe(201);
  });
  it("never fetches a missing CID from the public network", async () => {
    const missing = (await importFile(new Uint8Array([100]))).root.toString();
    await expect(
      new PinService(env, alice).pin(missing, "Missing"),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("supports raw block uploads and denies missing or mismatched CIDs", async () => {
    const service = new PinService(env, alice);
    expect((await service.upload(bytes, "block", "block", cid)).cid).toBe(cid);
    await expect(service.upload(bytes, "block", "block")).rejects.toMatchObject(
      { status: 400 },
    );
    await expect(
      service.upload(new Uint8Array([1]), "block", "block", cid),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.upload(new Uint8Array(MAX_UPLOAD + 1), "file", "too large"),
    ).rejects.toMatchObject({ status: 413 });
  });
  it("paginates without hiding pins and deletes only a reference", async () => {
    const rows = Array.from({ length: 51 }, (_, n) =>
      env.DB.prepare(
        "INSERT INTO pins (account_id,cid,name,size,blocks) VALUES (?, ?, 'test', 1, 1)",
      ).bind(bob.accountId, `z-test-${String(n).padStart(3, "0")}`),
    );
    await env.DB.batch(rows);
    const service = new PinService(env, bob);
    const page = await service.list();
    expect(page.pins).toHaveLength(50);
    expect(page.nextCursor).not.toBeNull();
    expect((await service.list(page.nextCursor!)).pins).toHaveLength(2);
    const deleted = await request(`/api/pins/${cid}`, {
      method: "DELETE",
      headers: sessionHeaders(),
    });
    expect(deleted.status).toBe(204);
    expect(
      (await request(`/api/pins/${cid}`, { headers: { cookie } })).status,
    ).toBe(404);
    expect((await request(`/ipfs/${cid}?format=raw`)).status).toBe(200);
  });
});

describe("independent account-scoped pin rename API", () => {
  let original: Pin;
  const content = new TextEncoder().encode("rename-without-changing-content");
  beforeAll(async () => {
    original = await new PinService(env, alice).upload(
      content,
      "file",
      "Original",
    );
    await new PinService(env, bob).pin(original.cid, "Bob's independent name");
  });
  const rename = (
    body: unknown,
    headers: HeadersInit = sessionHeaders(),
    target = original.cid,
  ) =>
    request(`/api/pins/${target}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });

  it("renames only the account label and preserves immutable metadata and public bytes", async () => {
    const response = await rename({ name: "  Renamed file  " });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...original,
      name: "Renamed file",
    });
    expect((await new PinService(env, bob).detail(original.cid)).name).toBe(
      "Bob's independent name",
    );
    expect(
      new Uint8Array(
        await (await request(`/ipfs/${original.cid}?format=raw`)).arrayBuffer(),
      ),
    ).toEqual(content);
    const repeated = await rename({ name: "Renamed file" });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({
      ...original,
      name: "Renamed file",
    });
  });
  it.each([
    { name: "" },
    { name: "  " },
    { name: "x".repeat(201) },
    { name: 1 },
    {},
    { name: "valid", cid: "other" },
  ])(
    "rejects invalid rename input %j without changing the existing pin",
    async (body) => {
      const before = await new PinService(env, alice).detail(original.cid);
      expect((await rename(body)).status).toBe(400);
      expect(await new PinService(env, alice).detail(original.cid)).toEqual(
        before,
      );
    },
  );
  it("requires authentication and same-origin protection for browser mutations", async () => {
    expect(
      (
        await rename(
          { name: "Denied" },
          { origin, "content-type": "application/json" },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await rename(
          { name: "Denied" },
          {
            cookie,
            origin: "https://evil.test",
            "content-type": "application/json",
          },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await rename(
          { name: "Denied" },
          { cookie, "content-type": "application/json" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/pins/${original.cid}`, {
          method: "PATCH",
          headers: sessionHeaders(),
          body: "{",
        })
      ).status,
    ).toBe(400);
  });
  it("requires pins:write but not pins:read, and honors revocation", async () => {
    const writer = await createToken(env, alice, {
      name: "rename-writer",
      scopes: ["pins:write"],
      expiresInDays: 1,
    });
    const reader = await createToken(env, alice, {
      name: "rename-reader",
      scopes: ["pins:read"],
      expiresInDays: 1,
    });
    const headers = {
      authorization: `Bearer ${writer.token}`,
      "content-type": "application/json",
    };
    expect((await rename({ name: "Write-only rename" }, headers)).status).toBe(
      200,
    );
    expect(
      (await request(`/api/pins/${original.cid}`, { headers })).status,
    ).toBe(403);
    expect(
      (
        await rename(
          { name: "Denied" },
          { ...headers, authorization: `Bearer ${reader.token}` },
        )
      ).status,
    ).toBe(403);
    await revokeToken(env, alice, writer.id);
    expect((await rename({ name: "Revoked" }, headers)).status).toBe(401);
  });
  it("never creates pins or changes another account's pin", async () => {
    const onlyAlice = await new PinService(env, alice).upload(
      new Uint8Array([77, 12, 14]),
      "file",
      "Alice only",
    );
    const bobToken = await createToken(env, bob, {
      name: "bob-rename",
      scopes: ["pins:write"],
      expiresInDays: 1,
    });
    expect(
      (
        await rename(
          { name: "Denied" },
          {
            authorization: `Bearer ${bobToken.token}`,
            "content-type": "application/json",
          },
          onlyAlice.cid,
        )
      ).status,
    ).toBe(404);
    expect((await new PinService(env, alice).detail(onlyAlice.cid)).name).toBe(
      "Alice only",
    );
    const missing = (
      await importFile(new Uint8Array([31, 41, 59]))
    ).root.toString();
    expect(
      (await rename({ name: "Missing" }, sessionHeaders(), missing)).status,
    ).toBe(404);
    expect(
      (await rename({ name: "Invalid" }, sessionHeaders(), "not-a-cid")).status,
    ).toBe(400);
  });
});

describe("Agent credentials and MCP share account authorization", () => {
  it("issues only scoped expiring tokens, stores a hash and lists no secret", async () => {
    const response = await request("/api/tokens", {
      method: "POST",
      headers: sessionHeaders(),
      body: JSON.stringify({ name: "test agent", scopes: alice.scopes }),
    });
    expect(response.status).toBe(201);
    const issued = await response.json<{ token: string; id: string }>();
    token = issued.token;
    tokenId = issued.id;
    expect(token).toMatch(/^pb_[\w-]{43}$/);
    const row = await env.DB.prepare(
      "SELECT token_hash FROM agent_tokens WHERE id = ?",
    )
      .bind(tokenId)
      .first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(await hashToken(token));
    const list = await request("/api/tokens", { headers: { cookie } });
    expect(await list.text()).not.toContain(token);
    expect((await request("/api/pins", { headers: bearer() })).status).toBe(
      200,
    );
    expect((await request("/api/tokens", { headers: bearer() })).status).toBe(
      403,
    );
    expect(
      (
        await request("/api/pins", {
          headers: { authorization: "Bearer Agent-name" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request("/api/pins", {
          headers: { authorization: "Bearer pb_" + "a".repeat(43) },
        })
      ).status,
    ).toBe(401);
  });
  it("supports MCP initialize, discovery and upload/pin/detail/list/unpin", async () => {
    const init = await request("/mcp", {
      method: "POST",
      headers: {
        ...bearer(),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
    expect(await init.json()).toMatchObject({
      result: { serverInfo: { name: "pinboard" } },
    });
    const listing = await request("/mcp", {
      method: "POST",
      headers: {
        ...bearer(),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(
      (
        await listing.json<{ result: { tools: { name: string }[] } }>()
      ).result.tools.map((tool) => tool.name),
    ).toContain("upload");
    const uploaded = await rpc("upload", {
      name: "from MCP",
      kind: "file",
      contentBase64: btoa("MCP data"),
      public: true,
    });
    const result = await uploaded.json<{
      result: { content: { text: string }[] };
    }>();
    const pin = JSON.parse(result.result.content[0]!.text) as { cid: string };
    expect(await rpcText(await rpc("detail", { cid: pin.cid }))).toContain(
      "from MCP",
    );
    expect(await rpcText(await rpc("list"))).toContain(pin.cid);
    expect(await (await rpc("unpin", { cid: pin.cid })).json()).toMatchObject({
      result: { content: [{ text: '{"unpinned":true}' }] },
    });
    expect(
      await rpcText(
        await rpc("pin", { cid: pin.cid, name: "repinned", public: true }),
      ),
    ).toContain(pin.cid);
    expect((await new PinService(env, alice).detail(pin.cid)).name).toBe(
      "repinned",
    );
    expect(
      await (
        await rpc("upload", {
          name: "bad",
          kind: "file",
          contentBase64: "!!!",
          public: true,
        })
      ).json(),
    ).toMatchObject({ result: { isError: true } });
    expect(
      await (
        await rpc("upload", {
          name: "big",
          kind: "file",
          contentBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
          public: true,
        })
      ).json(),
    ).toMatchObject({ result: { isError: true } });
    expect(
      await (
        await rpc("pin", { cid: "bad", name: "bad", public: true })
      ).json(),
    ).toMatchObject({ result: { isError: true } });
    expect((await request("/mcp", { headers: bearer() })).status).toBe(405);
    expect(
      (
        await request("/mcp", {
          headers: { ...bearer(), accept: "text/event-stream" },
        })
      ).status,
    ).toBe(405);
  });
  it("enforces read-only scopes on HTTP and MCP", async () => {
    const readOnly = await createToken(env, alice, {
      name: "read-only",
      scopes: ["pins:read"],
    });
    const original = token;
    token = readOnly.token;
    const response = await request("/api/pins", {
      method: "POST",
      headers: { ...bearer(), "content-type": "application/json" },
      body: JSON.stringify({ cid, public: true }),
    });
    expect(response.status).toBe(403);
    const denied = await (await rpc("unpin", { cid })).json<McpResult>();
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]!.text).toContain("403");
    await expect(
      createToken(
        env,
        { ...alice, kind: "agent" },
        { name: "no", scopes: ["pins:read"] },
      ),
    ).rejects.toMatchObject({ status: 403 });
    token = original;
  });
  it("enforces token ownership, expiry and immediate revocation", async () => {
    await expect(revokeToken(env, bob, tokenId)).rejects.toMatchObject({
      status: 404,
    });
    const expired = await createToken(env, alice, {
      name: "expires",
      scopes: ["pins:read"],
    });
    await env.DB.prepare(
      "UPDATE agent_tokens SET expires_at = '2000' WHERE id = ?",
    )
      .bind(expired.id)
      .run();
    expect(
      (
        await request("/api/pins", {
          headers: { authorization: `Bearer ${expired.token}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(`/api/tokens/${tokenId}`, {
          method: "DELETE",
          headers: sessionHeaders(),
        })
      ).status,
    ).toBe(204);
    expect((await request("/api/pins", { headers: bearer() })).status).toBe(
      401,
    );
    expect(
      (await request("/mcp", { method: "POST", headers: bearer(), body: "{}" }))
        .status,
    ).toBe(401);
  });
});

describe("explicit unexpected errors", () => {
  it("does not expose internal exceptions as success or reveal stack traces", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = env.DB;
    env = {
      ...env,
      DB: new Proxy(original, {
        get(target, property) {
          if (property === "prepare")
            return () => {
              throw new Error("database unavailable");
            };
          const value: unknown = Reflect.get(target, property);
          return value;
        },
      }),
    };
    const response = await request("/api/pins", { headers: { cookie } });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
    expect(spy).toHaveBeenCalled();
    const mcpResponse = await handleMcp(
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
          params: { name: "list", arguments: {} },
        }),
      }),
      env,
      alice,
    );
    expect(await mcpResponse.json()).toMatchObject({
      result: { isError: true, content: [{ text: "Internal server error" }] },
    });
    env = { ...env, DB: original };
    spy.mockRestore();
  });
  it("round trips a non-trivial complete DAG", async () => {
    const dag = await importFile(new Uint8Array(600000).fill(5));
    expect(dag.blocks.size).toBeGreaterThan(1);
    const car = await encodeCar(dag);
    expect(car.length).toBeGreaterThan(dag.size);
  });
});
