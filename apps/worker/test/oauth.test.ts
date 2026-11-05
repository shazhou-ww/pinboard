import { encode } from "@auth/core/jwt";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import type { Bindings } from "../src/env.js";
import { accountForGoogle, hashToken } from "../src/identity.js";
import { ACCESS_TTL, s256, validRedirect } from "../src/oauth.js";
import { createToken } from "../src/tokens.js";
import { migrate } from "./migrations.js";

const origin = "http://example.test";
const callback = "http://127.0.0.1:49152/callback?application=mcp";
const verifier = "a".repeat(43);
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
let alice: string;
let bob: string;
let aliceCookie: string;
let bobCookie: string;
let apiToken: string;
const request = async (path: string, init?: RequestInit) => {
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
};
const sessionHeaders = (cookie = aliceCookie) => ({
  cookie,
  origin,
  "content-type": "application/json",
});
async function register(redirects = [callback]) {
  const response = await request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "<unverified client>",
      redirect_uris: redirects,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json<{ client_id: string }>()).client_id;
}
async function start(overrides: Record<string, string> = {}) {
  const client = overrides.client_id ?? (await register());
  const params = new URLSearchParams({
    client_id: client,
    redirect_uri: callback,
    resource: `${origin}/mcp`,
    response_type: "code",
    code_challenge_method: "S256",
    code_challenge: await s256(verifier),
    scope: "pins:read pins:write pins:delete",
    state: "client-state",
    ...overrides,
  });
  const response = await request(`/oauth/authorize?${params}`);
  const location = response.headers.get("location");
  const id = location
    ? new URL(location, origin).searchParams.get("request")!
    : "";
  const browserCookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  return { response, id, client, browserCookie, params };
}
type Flow = Awaited<ReturnType<typeof start>>;
async function preview(flow: Flow, session = aliceCookie) {
  return request(`/api/oauth/requests/${flow.id}`, {
    headers: { cookie: `${session}; ${flow.browserCookie}` },
  });
}
async function decide(
  flow: Flow,
  approve = true,
  scope = ["pins:read"],
  session = aliceCookie,
  accountId = alice,
) {
  return request(`/api/oauth/requests/${flow.id}`, {
    method: "POST",
    headers: sessionHeaders(`${session}; ${flow.browserCookie}`),
    body: JSON.stringify({ approve, scopes: scope, accountId }),
  });
}
async function authorize(scope = ["pins:read"]) {
  const flow = await start();
  expect((await preview(flow)).status).toBe(200);
  const response = await decide(flow, true, scope);
  expect(response.status).toBe(200);
  const redirect = new URL(
    (await response.json<{ redirect: string }>()).redirect,
  );
  expect(redirect.searchParams.get("state")).toBe("client-state");
  expect(redirect.searchParams.get("application")).toBe("mcp");
  return {
    ...flow,
    code: redirect.searchParams.get("code")!,
    consentResponse: response,
  };
}
async function exchange(
  flow: Flow & { code: string },
  overrides: Record<string, string> = {},
) {
  return request("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: flow.client,
      code: flow.code,
      redirect_uri: callback,
      resource: `${origin}/mcp`,
      code_verifier: verifier,
      ...overrides,
    }).toString(),
  });
}
async function credential(scope = ["pins:read"]) {
  const flow = await authorize(scope);
  const response = await exchange(flow);
  expect(response.status).toBe(200);
  const token = (await response.json<{ access_token: string }>()).access_token;
  return { ...flow, token };
}
async function rpc(
  token: string,
  name = "list",
  args: Record<string, unknown> = {},
) {
  return request("/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}

beforeAll(async () => {
  const db = await mf.getD1Database("DB");
  await migrate(db);
  env = {
    ...(await mf.getBindings<Pick<Bindings, "DB" | "BLOCKS" | "ASSETS">>()),
    APP_NAME: "Pinboard",
    PUBLIC_ORIGIN: origin,
    AUTH_URL: `${origin}/api/auth`,
    AUTH_SECRET: "test-secret-that-is-long-enough-for-auth",
    PROVIDER_ID: "unused",
    PROVIDER_MULTIADDR: "unused",
  };
  alice = await accountForGoogle(db, "oauth-alice");
  bob = await accountForGoogle(db, "oauth-bob");
  const cookie = async (accountId: string) =>
    `authjs.session-token=${await encode({
      token: { accountId },
      secret: env.AUTH_SECRET,
      salt: "authjs.session-token",
    })}`;
  aliceCookie = await cookie(alice);
  bobCookie = await cookie(bob);
  apiToken = (
    await createToken(
      env,
      { accountId: alice, scopes: ["pins:read"], kind: "session" },
      {
        name: "existing",
        scopes: ["pins:read"],
      },
    )
  ).token;
}, 30000);
afterAll(() => mf.dispose());

describe("OAuth discovery and public registration", () => {
  it.each(["POST", "GET", "DELETE"])(
    "challenges unauthenticated MCP %s requests without accepting browser cookies",
    async (method) => {
      for (const cookie of ["", aliceCookie]) {
        const response = await request("/mcp", {
          method,
          headers: {
            ...(cookie ? { cookie } : {}),
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          ...(method === "POST"
            ? {
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "initialize",
                  params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: { name: "test-client", version: "1.0.0" },
                  },
                }),
              }
            : {}),
        });
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain(
          `${origin}/.well-known/oauth-protected-resource/mcp`,
        );
        privateResponse(response);
      }
    },
  );
  it("still rejects foreign MCP origins and cookie mutations without a same-origin header", async () => {
    const foreign = await request("/mcp", {
      method: "POST",
      headers: { origin: "https://evil.test" },
    });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({
      error: "Origin not allowed",
    });
    for (const path of ["/api/pins", "/api/tokens"]) {
      const response = await request(path, {
        method: "POST",
        headers: { cookie: aliceCookie },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: "Same-origin browser request required",
      });
    }
  });
  it("advertises resource metadata and S256 on the same origin; no cookie authentication for MCP", async () => {
    for (const token of ["", "unknown", "po_unknown"]) {
      const response = await request("/mcp", {
        headers: {
          cookie: aliceCookie,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        `${origin}/.well-known/oauth-protected-resource/mcp`,
      );
      privateResponse(response);
    }
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await request(path);
      expect(await response.json()).toMatchObject({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
      });
    }
    expect(
      await (await request("/.well-known/oauth-authorization-server")).json(),
    ).toMatchObject({
      issuer: origin,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    expect((await request("/oauth/token", { method: "OPTIONS" })).status).toBe(
      204,
    );
    expect(
      (await request("/oauth/register", { method: "OPTIONS" })).headers.get(
        "access-control-allow-origin",
      ),
    ).toBe("*");
  });
  it("registers public clients without a secret and preserves exact HTTPS / numeric loopback callbacks", async () => {
    await register([
      "https://vscode.dev/redirect",
      callback,
      "http://[::1]:49152/callback",
    ]);
    for (const redirect of [
      "javascript:alert(1)",
      "//evil.test/cb",
      "http://evil.test/cb",
      "http://localhost:49152/cb",
      "https://good.test/#",
      "https://good.test/#fragment",
      " https://good.test/cb",
      "https://good.test/cb\n",
      "https://good.test\\@evil.test/cb",
      "https://user:pass@good.test/cb",
      "not a URL",
    ]) {
      expect(validRedirect(redirect)).toBe(false);
      expect(
        (
          await request("/oauth/register", {
            method: "POST",
            body: JSON.stringify({ redirect_uris: [redirect] }),
          })
        ).status,
      ).toBe(400);
    }
    const response = await request("/oauth/register", {
      method: "POST",
      body: JSON.stringify({ redirect_uris: ["https://vscode.dev/redirect"] }),
    });
    const registered = await response.json<Record<string, unknown>>();
    expect(registered).toMatchObject({
      client_name: "MCP client",
      token_endpoint_auth_method: "none",
    });
    expect(registered).not.toHaveProperty("client_secret");
    const broader = await request("/oauth/register", {
      method: "POST",
      body: JSON.stringify({
        redirect_uris: [callback],
        grant_types: ["authorization_code", "refresh_token"],
      }),
    });
    expect(await broader.json()).toMatchObject({
      grant_types: ["authorization_code"],
    });
    for (const extra of [
      { token_endpoint_auth_method: "client_secret_basic" },
      { grant_types: ["refresh_token"] },
      { redirect_uris: [] },
    ]) {
      expect(
        (
          await request("/oauth/register", {
            method: "POST",
            body: JSON.stringify({ redirect_uris: [callback], ...extra }),
          })
        ).status,
      ).toBe(400);
    }
  });
  it("rejects unsafe authorization requests locally without redirecting", async () => {
    for (const overrides of [
      { client_id: "unknown" },
      { redirect_uri: "https://evil.test/cb" },
      { resource: `${origin}/api/pins` },
      { scope: "admin" },
      { scope: "" },
      { code_challenge_method: "plain" },
      { code_challenge: "short" },
      { response_type: "token" },
    ]) {
      const flow = await start(overrides);
      expect(flow.response.status).toBe(400);
      expect(flow.response.headers.has("location")).toBe(false);
      privateResponse(flow.response);
    }
    const flow = await start();
    expect(
      (await request(`/oauth/authorize?${flow.params}&client_id=other`)).status,
    ).toBe(400);
    flow.params.delete("resource");
    expect((await request(`/oauth/authorize?${flow.params}`)).status).toBe(400);
  });
});

describe("browser login, explicit consent and CSRF", () => {
  it("requires fresh Google sign-in instead of failing consent when a signed session references a deleted account", async () => {
    const removed = await accountForGoogle(env.DB, "oauth-removed-account");
    const staleCookie = `authjs.session-token=${await encode({
      token: { accountId: removed },
      secret: env.AUTH_SECRET,
      salt: "authjs.session-token",
    })}`;
    await env.DB.prepare("DELETE FROM accounts WHERE id = ?")
      .bind(removed)
      .run();
    const flow = await start();
    expect((await preview(flow, staleCookie)).status).toBe(401);
    expect(
      (await decide(flow, true, ["pins:read"], staleCookie, removed)).status,
    ).toBe(401);
    expect(
      await env.DB.prepare(
        "SELECT account_id, used_at FROM oauth_requests WHERE id = ?",
      )
        .bind(flow.id)
        .first(),
    ).toMatchObject({ account_id: null, used_at: null });
    const replacement = await accountForGoogle(env.DB, "oauth-removed-account");
    expect(replacement).not.toBe(removed);
    const freshCookie = `authjs.session-token=${await encode({
      token: { accountId: replacement },
      secret: env.AUTH_SECRET,
      salt: "authjs.session-token",
    })}`;
    expect((await preview(flow, freshCookie)).status).toBe(200);
    expect(
      (await decide(flow, true, ["pins:read"], freshCookie, replacement))
        .status,
    ).toBe(200);
    expect(
      await env.DB.prepare("SELECT account_id FROM oauth_grants WHERE id = ?")
        .bind(flow.id)
        .first(),
    ).toMatchObject({ account_id: replacement });
  });
  it("requires the same browser and Google session, binds the consent to one account and never auto-approves", async () => {
    const flow = await start();
    expect(flow.response.status).toBe(302);
    privateResponse(flow.response);
    expect(flow.response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(flow.response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect((await preview(flow, "")).status).toBe(401);
    expect(
      (
        await request(`/api/oauth/requests/${flow.id}`, {
          headers: { cookie: aliceCookie },
        })
      ).status,
    ).toBe(400);
    expect((await request("/api/oauth/requests/not-a-request")).status).toBe(
      400,
    );
    expect(
      (
        await request(`/api/oauth/requests/${flow.id}`, {
          headers: { cookie: `${aliceCookie}; ${flow.browserCookie}wrong` },
        })
      ).status,
    ).toBe(400);
    const response = await preview(flow);
    privateResponse(response);
    expect(await response.json()).toMatchObject({
      accountId: alice,
      clientName: "<unverified client>",
      redirectUri: callback,
    });
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM oauth_grants WHERE id = ?",
      )
        .bind(flow.id)
        .first<{ n: number }>())!.n,
    ).toBe(0);
    expect((await preview(flow, bobCookie)).status).toBe(403);
    expect(
      (await decide(flow, true, ["pins:read"], aliceCookie, bob)).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/oauth/requests/${flow.id}`, {
          method: "POST",
          headers: {
            cookie: `${aliceCookie}; ${flow.browserCookie}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            accountId: alice,
            approve: true,
            scopes: ["pins:read"],
          }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/oauth/requests/${flow.id}`, {
          method: "POST",
          headers: {
            ...sessionHeaders(`${aliceCookie}; ${flow.browserCookie}`),
            origin: "https://evil.test",
          },
          body: JSON.stringify({
            accountId: alice,
            approve: true,
            scopes: ["pins:read"],
          }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/oauth/requests/${flow.id}`, {
          headers: {
            cookie: `${aliceCookie}; ${flow.browserCookie}`,
            authorization: `Bearer ${apiToken}`,
          },
        })
      ).status,
    ).toBe(403);
    expect((await decide(flow, true, [])).status).toBe(400);
  });
  it("uses a secure host cookie on HTTPS and does not issue access on denial or abandoned requests", async () => {
    const flow = await start();
    const httpsEnv = { ...env, AUTH_URL: "https://secure.test/api/auth" };
    flow.params.set("resource", "https://secure.test/mcp");
    const secure = await app.request(
      `https://secure.test/oauth/authorize?${flow.params}`,
      {},
      httpsEnv,
    );
    expect(secure.headers.get("set-cookie")).toContain("__Host-pb_oauth_");
    expect(secure.headers.get("set-cookie")).toContain("Secure");
    const denied = await decide(flow, false);
    privateResponse(denied);
    const redirect = new URL(
      (await denied.json<{ redirect: string }>()).redirect,
    );
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.has("code")).toBe(false);
    expect((await preview(flow)).status).toBe(400);
    expect((await decide(flow)).status).toBe(400);
    const abandoned = await start();
    await env.DB.prepare(
      "UPDATE oauth_requests SET expires_at = 0 WHERE id = ?",
    )
      .bind(abandoned.id)
      .run();
    expect((await preview(abandoned)).status).toBe(400);
  });
  it("cannot widen requested scopes; defaults to read and supports missing state", async () => {
    const flow = await start({ scope: "pins:read" });
    expect((await decide(flow, true, ["pins:write"])).status).toBe(400);
    const defaults = await start();
    defaults.params.delete("scope");
    defaults.params.delete("state");
    const response = await request(`/oauth/authorize?${defaults.params}`);
    const id = new URL(
      response.headers.get("location")!,
      origin,
    ).searchParams.get("request")!;
    const browserCookie = response.headers.getSetCookie()[0]!.split(";")[0]!;
    const result = await decide({ ...defaults, id, browserCookie });
    expect(
      new URL(
        (await result.json<{ redirect: string }>()).redirect,
      ).searchParams.has("state"),
    ).toBe(false);
  });
  it("consumes consent atomically under concurrent submissions", async () => {
    const flow = await start();
    const responses = await Promise.all([decide(flow), decide(flow)]);
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(1);
    expect(
      (await env.DB.prepare(
        "SELECT count(*) AS n FROM oauth_grants WHERE id = ?",
      )
        .bind(flow.id)
        .first<{ n: number }>())!.n,
    ).toBe(1);
  });
});

describe("PKCE, resource binding and one-use code exchange", () => {
  it("issues only a hashed, scoped one-hour Pinboard credential; no Google or refresh token", async () => {
    const flow = await authorize();
    privateResponse(flow.consentResponse);
    const response = await exchange(flow);
    privateResponse(response);
    const data = await response.json<{
      access_token: string;
      expires_in: number;
      scope: string;
      token_type: string;
    }>();
    expect(data).toMatchObject({
      expires_in: ACCESS_TTL,
      scope: "pins:read",
      token_type: "Bearer",
    });
    expect(data.access_token).toMatch(/^po_[A-Za-z0-9_-]{43}$/);
    expect(data).not.toHaveProperty("refresh_token");
    const row = await env.DB.prepare("SELECT * FROM oauth_grants WHERE id = ?")
      .bind(flow.id)
      .first<{ token_hash: string; code_hash: string | null }>();
    expect(row!.token_hash).toBe(await hashToken(data.access_token));
    expect(row!.code_hash).toBeNull();
    expect((await exchange(flow)).status).toBe(400);
    expect(await (await rpc(data.access_token)).json()).toMatchObject({
      result: { content: [{ type: "text" }] },
    });
    expect(
      (await request(`/mcp?access_token=${data.access_token}`)).status,
    ).toBe(401);
    await env.DB.prepare("UPDATE oauth_grants SET resource = ? WHERE id = ?")
      .bind(`${origin}/other-resource`, flow.id)
      .run();
    expect((await rpc(data.access_token)).status).toBe(401);
  });
  it("rejects wrong verifier/client/callback/resource; failed attempts cannot redeem or consume a valid code", async () => {
    const flow = await authorize();
    for (const override of [
      { code_verifier: "b".repeat(43) },
      { client_id: await register() },
      { redirect_uri: callback + "&extra=1" },
      { resource: `${origin}/api/pins` },
      { code: "z".repeat(43) },
      { code_verifier: "short" },
      { grant_type: "refresh_token" },
    ]) {
      const response = await exchange(flow, override);
      expect(response.status).toBe(400);
      privateResponse(response);
    }
    expect((await exchange(flow)).status).toBe(200);
  });
  it("permits exactly one simultaneous redemption, rejects code expiry and pre-exchange revocation", async () => {
    const flow = await authorize();
    const responses = await Promise.all([
      exchange(flow),
      exchange(flow),
      exchange(flow),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 400, 400,
    ]);
    const expired = await authorize();
    await env.DB.prepare(
      "UPDATE oauth_grants SET code_expires_at = 0 WHERE id = ?",
    )
      .bind(expired.id)
      .run();
    expect((await exchange(expired)).status).toBe(400);
    const revoked = await authorize();
    expect(
      (
        await request(`/api/oauth/grants/${revoked.id}`, {
          method: "DELETE",
          headers: sessionHeaders(),
        })
      ).status,
    ).toBe(204);
    expect((await exchange(revoked)).status).toBe(400);
  });
  it("rejects unsupported token encoding, duplicate fields and client authentication", async () => {
    expect(
      (await request("/oauth/token", { method: "POST", body: "{}" })).status,
    ).toBe(400);
    expect(
      (
        await request("/oauth/token", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: "Basic invalid",
          },
          body: "grant_type=authorization_code",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "code=one&code=two",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "x".repeat(16385),
        })
      ).status,
    ).toBe(413);
  });
});

describe("shared tool boundaries and session-only grant management", () => {
  it("limits scopes and confines the OAuth audience to /mcp, not any private HTTP API", async () => {
    const flow = await credential();
    const upload = await rpc(flow.token, "upload", {
      kind: "file",
      name: "test",
      contentBase64: "aGk=",
      public: true,
    });
    expect(await upload.json()).toMatchObject({
      result: {
        isError: true,
        content: [{ text: "403: Missing permission: pins:write" }],
      },
    });
    for (const path of [
      "/api/pins",
      "/api/pins/upload",
      "/api/tokens",
      "/api/oauth/grants",
    ]) {
      const response = await request(path, {
        headers: { authorization: `Bearer ${flow.token}` },
      });
      expect(response.status).toBe(403);
    }
    for (const token of [apiToken, flow.token]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        expect(
          (
            await request(
              `/api/oauth/grants${method === "DELETE" ? `/${flow.id}` : ""}`,
              {
                method,
                headers: { authorization: `Bearer ${token}` },
              },
            )
          ).status,
        ).toBe(403);
      }
    }
    expect(
      (
        await request("/api/pins", {
          headers: { authorization: `Bearer ${apiToken}` },
        })
      ).status,
    ).toBe(200);
    expect((await rpc(apiToken)).status).toBe(200);
  });
  it("lists only the session account's grants; cross-account revoke is 404; revocation blocks subsequent MCP calls", async () => {
    const flow = await credential();
    const response = await request("/api/oauth/grants", {
      headers: sessionHeaders(),
    });
    privateResponse(response);
    expect(
      (await response.json<{ grants: { id: string }[] }>()).grants.some(
        (grant) => grant.id === flow.id,
      ),
    ).toBe(true);
    expect(
      (
        await (
          await request("/api/oauth/grants", {
            headers: sessionHeaders(bobCookie),
          })
        ).json<{ grants: unknown[] }>()
      ).grants,
    ).toEqual([]);
    expect(
      (
        await request(`/api/oauth/grants/${flow.id}`, {
          method: "DELETE",
          headers: sessionHeaders(bobCookie),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/api/oauth/grants/${flow.id}`, {
          method: "DELETE",
          headers: { cookie: aliceCookie },
        })
      ).status,
    ).toBe(403);
    expect((await request("/api/oauth/grants")).status).toBe(401);
    expect((await rpc(flow.token)).status).toBe(200);
    expect(
      (
        await request(`/api/oauth/grants/${flow.id}`, {
          method: "DELETE",
          headers: sessionHeaders(),
        })
      ).status,
    ).toBe(204);
    expect((await rpc(flow.token)).status).toBe(401);
    expect(
      (
        await request(`/api/oauth/grants/${flow.id}`, {
          method: "DELETE",
          headers: sessionHeaders(),
        })
      ).status,
    ).toBe(204);
    const expired = await credential();
    await env.DB.prepare("UPDATE oauth_grants SET expires_at = 0 WHERE id = ?")
      .bind(expired.id)
      .run();
    expect((await rpc(expired.token)).status).toBe(401);
  });
  it("reuses account-scoped services; another account cannot read or unpin an OAuth upload", async () => {
    const aliceFlow = await credential([
      "pins:read",
      "pins:write",
      "pins:delete",
    ]);
    const upload = await rpc(aliceFlow.token, "upload", {
      kind: "file",
      name: "alice public bytes",
      contentBase64: "aGVsbG8=",
      public: true,
    });
    const result = await upload.json<{
      result: { content: { text: string }[] };
    }>();
    const pin = JSON.parse(result.result.content[0]!.text) as { cid: string };
    const flow = await start();
    const approved = await decide(
      flow,
      true,
      ["pins:read", "pins:delete"],
      bobCookie,
      bob,
    );
    const code = new URL(
      (await approved.json<{ redirect: string }>()).redirect,
    ).searchParams.get("code")!;
    const exchanged = await exchange({ ...flow, code });
    const token = (await exchanged.json<{ access_token: string }>())
      .access_token;
    for (const name of ["detail", "unpin"]) {
      const response = await rpc(token, name, { cid: pin.cid });
      expect(await response.json()).toMatchObject({
        result: {
          isError: true,
          content: [{ text: "404: Pin not found in your account" }],
        },
      });
    }
    expect(
      await (await rpc(aliceFlow.token, "detail", { cid: pin.cid })).json(),
    ).toMatchObject({ result: { content: [{ type: "text" }] } });
  });
  it("fails closed without logging protocol values on an unexpected storage failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const db = env.DB;
      const failing: Bindings = {
        ...env,
        DB: {
          prepare: () => {
            throw new Error("sensitive-code");
          },
          batch: db.batch.bind(db),
          exec: db.exec.bind(db),
          dump: db.dump.bind(db),
          withSession: db.withSession.bind(db),
        },
      };
      const response = await app.request(
        `${origin}/oauth/register`,
        { method: "POST", body: JSON.stringify({ redirect_uris: [callback] }) },
        failing,
      );
      expect(response.status).toBe(500);
      expect(spy).toHaveBeenCalledWith(
        JSON.stringify({ event: "oauth_request_failed" }),
      );
      expect(JSON.stringify(spy.mock.calls)).not.toContain("sensitive-code");
    } finally {
      spy.mockRestore();
    }
  });
});
