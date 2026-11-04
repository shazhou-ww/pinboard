import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { boundedBody } from "./content.js";
import {
  authenticate,
  checkOrigin,
  hashToken,
  type AppEnv,
} from "./identity.js";
import { jsonBody, scopes, scopeSchema } from "./schemas.js";
import type { Bindings } from "./env.js";

const REQUEST_TTL = 10 * 60 * 1000;
const CODE_TTL = 60 * 1000;
export const ACCESS_TTL = 60 * 60;

export function oauthOrigin(env: Bindings): string {
  return new URL(env.AUTH_URL ?? env.PUBLIC_ORIGIN).origin;
}

function randomSecret(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function s256(verifier: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
}

function fail(error = "invalid_request"): never {
  throw new HTTPException(400, { message: error });
}

// Only numeric loopback HTTP callbacks are allowed by RFC 8252 §7.3.
export function validRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      !Array.from(value).some(
        (char) =>
          char.charCodeAt(0) <= 32 ||
          char.charCodeAt(0) === 127 ||
          char === "\\",
      ) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !value.includes("#") &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

function parse<Output, Input>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  input: unknown,
): Output {
  const parsed = schema.safeParse(input);
  if (!parsed.success) fail();
  return parsed.data;
}

function singleParams(params: URLSearchParams): Record<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of params) {
    if (result.has(key)) fail();
    result.set(key, value);
  }
  return Object.fromEntries(result);
}

function parseScopes(value: string): string[] {
  const requested = [...new Set(value.split(" "))];
  if (
    !requested.length ||
    requested.some(
      (scope) => !scopes.includes(scope as (typeof scopes)[number]),
    )
  )
    fail("invalid_scope");
  return requested;
}

type AuthorizationRequest = {
  id: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scopes: string;
  state: string | null;
  challenge: string;
  browser_hash: string;
  account_id: string | null;
  expires_at: number;
};

function cookieName(c: Context<AppEnv>, id: string): string {
  return `${oauthOrigin(c.env).startsWith("https:") ? "__Host-" : ""}pb_oauth_${id}`;
}

async function browserRequest(
  c: Context<AppEnv>,
): Promise<AuthorizationRequest> {
  const id = c.req.param("id");
  if (!id || !/^[a-f0-9-]{36}$/.test(id)) fail();
  const secret = getCookie(c, cookieName(c, id));
  if (!secret) fail();
  const row = await c.env.DB.prepare(
    "SELECT * FROM oauth_requests WHERE id = ? AND browser_hash = ? AND expires_at > ? AND used_at IS NULL",
  )
    .bind(id, await hashToken(secret), Date.now())
    .first<AuthorizationRequest>();
  if (!row) fail();
  const principal = await authenticate(c, true);
  const bound = await c.env.DB.prepare(
    "UPDATE oauth_requests SET account_id = ? WHERE id = ? AND (account_id IS NULL OR account_id = ?) AND used_at IS NULL AND expires_at > ? RETURNING id",
  )
    .bind(principal.accountId, id, principal.accountId, Date.now())
    .first();
  if (!bound)
    throw new HTTPException(403, {
      message: "Account changed; restart authorization",
    });
  return { ...row, account_id: principal.accountId };
}

export const oauth = new Hono<AppEnv>();
oauth.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  c.header("Referrer-Policy", "no-referrer");
  if (
    c.req.path.startsWith("/.well-known/") ||
    ["/oauth/token", "/oauth/register"].includes(c.req.path)
  ) {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (c.req.method === "OPTIONS") return c.body(null, 204);
  }
  return next();
});
oauth.onError((error, c) => {
  if (error instanceof HTTPException)
    return c.json({ error: error.message }, error.status);
  // Never log a request body, authorization code, verifier or credential.
  console.error(JSON.stringify({ event: "oauth_request_failed" }));
  return c.json({ error: "server_error" }, 500);
});

const resourceMetadata = (c: Context<AppEnv>) =>
  c.json({
    resource: `${oauthOrigin(c.env)}/mcp`,
    authorization_servers: [oauthOrigin(c.env)],
    scopes_supported: scopes,
    bearer_methods_supported: ["header"],
    resource_name: "Pinboard MCP",
  });
oauth.get("/.well-known/oauth-protected-resource", resourceMetadata);
oauth.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata);
oauth.get("/.well-known/oauth-authorization-server", (c) => {
  const issuer = oauthOrigin(c.env);
  return c.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: scopes,
  });
});

oauth.post("/oauth/register", async (c) => {
  const input = parse(
    z.object({
      client_name: z.string().trim().min(1).max(100).default("MCP client"),
      redirect_uris: z.array(z.string().refine(validRedirect)).min(1).max(10),
      token_endpoint_auth_method: z.literal("none").default("none"),
      grant_types: z
        .array(z.string().max(100))
        .min(1)
        .max(5)
        .refine((values) => values.includes("authorization_code"))
        .default(["authorization_code"]),
      response_types: z.array(z.literal("code")).length(1).default(["code"]),
    }),
    await jsonBody(c.req.raw),
  );
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)",
  )
    .bind(
      id,
      input.client_name,
      JSON.stringify(input.redirect_uris),
      Date.now(),
    )
    .run();
  return c.json(
    {
      ...input,
      grant_types: ["authorization_code"],
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    201,
  );
});

oauth.get("/oauth/authorize", async (c) => {
  const input = parse(
    z.object({
      response_type: z.literal("code"),
      client_id: z.string().min(1).max(100),
      redirect_uri: z.string().max(2048),
      resource: z.string().max(2048),
      scope: z.string().max(100).default("pins:read"),
      state: z.string().max(1024).optional(),
      code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: z.literal("S256"),
    }),
    singleParams(new URL(c.req.url).searchParams),
  );
  if (input.resource !== `${oauthOrigin(c.env)}/mcp`) fail("invalid_target");
  const client = await c.env.DB.prepare(
    "SELECT redirect_uris FROM oauth_clients WHERE id = ?",
  )
    .bind(input.client_id)
    .first<{ redirect_uris: string }>();
  if (
    !client ||
    !(JSON.parse(client.redirect_uris) as string[]).includes(input.redirect_uri)
  )
    fail();
  const requested = parseScopes(input.scope);
  const id = crypto.randomUUID();
  const secret = randomSecret();
  await c.env.DB.prepare(
    "INSERT INTO oauth_requests (id, client_id, redirect_uri, resource, scopes, state, challenge, browser_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      input.client_id,
      input.redirect_uri,
      input.resource,
      requested.join(" "),
      input.state ?? null,
      input.code_challenge,
      await hashToken(secret),
      Date.now() + REQUEST_TTL,
    )
    .run();
  setCookie(c, cookieName(c, id), secret, {
    httpOnly: true,
    secure: oauthOrigin(c.env).startsWith("https:"),
    sameSite: "Lax",
    path: "/",
    maxAge: REQUEST_TTL / 1000,
  });
  return c.redirect(`/connect/mcp?request=${id}`, 302);
});

oauth.get("/api/oauth/requests/:id", async (c) => {
  checkOrigin(c);
  const row = await browserRequest(c);
  const client = await c.env.DB.prepare(
    "SELECT name FROM oauth_clients WHERE id = ?",
  )
    .bind(row.client_id)
    .first<{ name: string }>();
  return c.json({
    accountId: row.account_id,
    clientId: row.client_id,
    clientName: client!.name,
    redirectUri: row.redirect_uri,
    resource: row.resource,
    scopes: row.scopes.split(" "),
    expiresAt: row.expires_at,
  });
});

oauth.post("/api/oauth/requests/:id", async (c) => {
  checkOrigin(c);
  const row = await browserRequest(c);
  const input = parse(
    z.object({
      accountId: z.string(),
      approve: z.boolean(),
      scopes: z.array(scopeSchema).max(3),
    }),
    await jsonBody(c.req.raw),
  );
  if (input.accountId !== row.account_id)
    throw new HTTPException(403, {
      message: "Account changed; restart authorization",
    });
  const selected = [...new Set(input.scopes)];
  if (
    input.approve &&
    (!selected.length ||
      selected.some((scope) => !row.scopes.split(" ").includes(scope)))
  )
    fail("invalid_scope");
  const now = Date.now();
  const code = randomSecret();
  // The INSERT is conditional on the still-unused request. Both operations are
  // one D1 transaction, so concurrent consent submissions cannot issue two codes.
  const [inserted, consumed] = await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO oauth_grants (id, client_id, account_id, redirect_uri, resource, scopes, code_hash, challenge, code_expires_at, created_at) SELECT id, client_id, account_id, redirect_uri, resource, ?, ?, challenge, ?, ? FROM oauth_requests WHERE id = ? AND used_at IS NULL AND expires_at > ? AND ? = 1",
    ).bind(
      selected.join(" "),
      await hashToken(code),
      now + CODE_TTL,
      now,
      row.id,
      now,
      input.approve ? 1 : 0,
    ),
    c.env.DB.prepare(
      "UPDATE oauth_requests SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ? RETURNING id",
    ).bind(now, row.id, now),
  ]);
  if (!consumed?.meta.changes || (input.approve && !inserted?.meta.changes))
    fail();
  setCookie(c, cookieName(c, row.id), "", {
    httpOnly: true,
    secure: oauthOrigin(c.env).startsWith("https:"),
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
  });
  const redirect = new URL(row.redirect_uri);
  redirect.searchParams.set("iss", oauthOrigin(c.env));
  if (input.approve) redirect.searchParams.set("code", code);
  else redirect.searchParams.set("error", "access_denied");
  if (row.state !== null) redirect.searchParams.set("state", row.state);
  return c.json({ redirect: redirect.href });
});

oauth.post("/oauth/token", async (c) => {
  if (
    !c.req
      .header("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    fail();
  if (c.req.header("authorization")) fail("invalid_client");
  const body = await boundedBody(c.req.raw, 16384);
  const input = parse(
    z
      .object({
        grant_type: z.literal("authorization_code"),
        client_id: z.string().min(1).max(100),
        code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
        redirect_uri: z.string().max(2048),
        resource: z.string().max(2048),
      })
      .strict(),
    singleParams(new URLSearchParams(new TextDecoder().decode(body))),
  );
  if (input.resource !== `${oauthOrigin(c.env)}/mcp`) fail("invalid_target");
  const token = `po_${randomSecret()}`;
  const row = await c.env.DB.prepare(
    "UPDATE oauth_grants SET token_hash = ?, expires_at = ?, code_hash = NULL WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND resource = ? AND challenge = ? AND code_expires_at > ? AND revoked_at IS NULL AND token_hash IS NULL RETURNING scopes",
  )
    .bind(
      await hashToken(token),
      Date.now() + ACCESS_TTL * 1000,
      await hashToken(input.code),
      input.client_id,
      input.redirect_uri,
      input.resource,
      await s256(input.code_verifier),
      Date.now(),
    )
    .first<{ scopes: string }>();
  if (!row) fail("invalid_grant");
  return c.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: ACCESS_TTL,
    scope: row.scopes,
  });
});

const grantIdentity: MiddlewareHandler<AppEnv> = async (c, next) => {
  checkOrigin(c);
  c.set("principal", await authenticate(c, true));
  await next();
};
oauth.use("/api/oauth/grants", grantIdentity);
oauth.use("/api/oauth/grants/*", grantIdentity);
oauth.get("/api/oauth/grants", async (c) => {
  const grants = await c.env.DB.prepare(
    "SELECT g.id, g.client_id AS clientId, c.name AS clientName, g.scopes, g.created_at AS createdAt, g.code_expires_at AS codeExpiresAt, g.expires_at AS expiresAt, g.revoked_at AS revokedAt FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id WHERE g.account_id = ? ORDER BY g.created_at DESC",
  )
    .bind(c.get("principal").accountId)
    .all();
  return c.json({ grants: grants.results });
});
oauth.delete("/api/oauth/grants/:id", async (c) => {
  const result = await c.env.DB.prepare(
    "UPDATE oauth_grants SET revoked_at = coalesce(revoked_at, ?), code_hash = NULL, token_hash = NULL WHERE id = ? AND account_id = ?",
  )
    .bind(Date.now(), c.req.param("id"), c.get("principal").accountId)
    .run();
  if (!result.meta.changes)
    throw new HTTPException(404, { message: "Grant not found" });
  return c.body(null, 204);
});
