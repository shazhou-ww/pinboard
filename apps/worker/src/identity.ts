import { getAuthUser } from "@hono/auth-js";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Bindings } from "./env.js";
import { scopes, scopeSchema, type Scope } from "./schemas.js";
import { z } from "zod";

export interface Principal {
  accountId: string;
  scopes: readonly Scope[];
  kind: "session" | "agent" | "oauth";
}
export type AppEnv = {
  Bindings: Bindings;
  Variables: { principal: Principal };
};
type IdentityContext = Pick<
  Context<AppEnv>,
  "env" | "req" | "get" | "set" | "var"
>;

export async function accountForGoogle(
  db: D1Database,
  subject: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO accounts (id, provider, subject) VALUES (?, 'google', ?) ON CONFLICT(provider, subject) DO NOTHING",
    )
    .bind(id, subject)
    .run();
  const account = await db
    .prepare(
      "SELECT id FROM accounts WHERE provider = 'google' AND subject = ?",
    )
    .bind(subject)
    .first<{ id: string }>();
  if (!account) throw new Error("Failed to persist Google account");
  return account.id;
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function requireSessionAccount(
  db: D1Database,
  accountId: unknown,
): Promise<string> {
  if (typeof accountId !== "string" || !accountId)
    throw new HTTPException(401, { message: "Sign in with Google" });
  const account = await db
    .prepare("SELECT id FROM accounts WHERE id = ?")
    .bind(accountId)
    .first<{ id: string }>();
  if (!account) {
    console.warn(JSON.stringify({ event: "session_account_missing" }));
    throw new HTTPException(401, {
      message: "Session account no longer exists. Sign in with Google again",
    });
  }
  return account.id;
}

export async function authenticate(
  c: Context<AppEnv>,
  sessionOnly = false,
): Promise<Principal> {
  const authorization = c.req.header("authorization");
  if (authorization) {
    if (sessionOnly)
      throw new HTTPException(403, {
        message: "Browser session required to manage Agent tokens",
      });
    const oauthToken = /^bearer (po_[A-Za-z0-9_-]{43})$/i.exec(
      authorization,
    )?.[1];
    if (oauthToken) return authenticateOAuth(c, oauthToken);
    const match = /^Bearer (pb_[A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match?.[1])
      throw new HTTPException(401, { message: "Invalid Agent token" });
    const row = await c.env.DB.prepare(
      "SELECT account_id, scopes FROM agent_tokens WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
    )
      .bind(await hashToken(match[1]), new Date().toISOString())
      .first<{ account_id: string; scopes: string }>();
    if (!row)
      throw new HTTPException(401, {
        message: "Agent token expired, revoked or unknown",
      });
    const parsed: unknown = JSON.parse(row.scopes);
    return {
      accountId: row.account_id,
      scopes: z.array(scopeSchema).parse(parsed),
      kind: "agent",
    };
  }
  const user = await getAuthUser(c);
  const accountId = await requireSessionAccount(
    c.env.DB,
    user?.token?.accountId,
  );
  return { accountId, scopes, kind: "session" };
}

export const requireIdentity: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("principal", await authenticate(c));
  await next();
};

async function authenticateOAuth(
  c: Context<AppEnv>,
  token: string,
): Promise<Principal> {
  if (c.req.path !== "/mcp")
    throw new HTTPException(403, {
      message: "OAuth credential is restricted to /mcp",
    });
  const resource = `${new URL(c.env.AUTH_URL ?? c.env.PUBLIC_ORIGIN).origin}/mcp`;
  const grant = await c.env.DB.prepare(
    "SELECT account_id, scopes FROM oauth_grants WHERE token_hash = ? AND resource = ? AND revoked_at IS NULL AND expires_at > ?",
  )
    .bind(await hashToken(token), resource, Date.now())
    .first<{ account_id: string; scopes: string }>();
  if (!grant)
    throw new HTTPException(401, {
      message: "OAuth credential expired, revoked or unknown",
    });
  return {
    accountId: grant.account_id,
    scopes: z.array(scopeSchema).parse(grant.scopes.split(" ")),
    kind: "oauth",
  };
}

export function requireScope(principal: Principal, scope: Scope): void {
  if (!principal.scopes.includes(scope))
    throw new HTTPException(403, { message: `Missing permission: ${scope}` });
}

export function checkOrigin(c: Pick<IdentityContext, "env" | "req">): void {
  const origin = c.req.header("origin");
  const allowed = new URL(c.env.AUTH_URL ?? c.env.PUBLIC_ORIGIN).origin;
  if (origin && origin !== allowed)
    throw new HTTPException(403, { message: "Origin not allowed" });
  if (
    !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
    !c.req.header("authorization") &&
    origin !== allowed
  ) {
    throw new HTTPException(403, {
      message: "Same-origin browser request required",
    });
  }
}
