import { HTTPException } from "hono/http-exception";
import type { Bindings } from "./env.js";
import { hashToken, type Principal } from "./identity.js";
import { tokenSchema, validate } from "./schemas.js";
import type { AgentToken } from "@shazhou/pinboard-contracts";

function browserOnly(principal: Principal): void {
  if (principal.kind !== "session")
    throw new HTTPException(403, { message: "Browser session required" });
}

export async function createToken(
  env: Bindings,
  principal: Principal,
  input: unknown,
): Promise<AgentToken & { token: string }> {
  browserOnly(principal);
  const data = validate(tokenSchema, input);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token =
    "pb_" +
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const id = crypto.randomUUID();
  const expiresAt = new Date(
    Date.now() + data.expiresInDays * 86400000,
  ).toISOString();
  const prefix = token.slice(0, 11);
  const result = await env.DB.prepare(
    "INSERT INTO agent_tokens (id, account_id, name, prefix, token_hash, scopes, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, name, prefix, scopes, expires_at AS expiresAt, created_at AS createdAt, revoked_at AS revokedAt",
  )
    .bind(
      id,
      principal.accountId,
      data.name,
      prefix,
      await hashToken(token),
      JSON.stringify([...new Set(data.scopes)]),
      expiresAt,
    )
    .first<AgentToken>();
  if (!result) throw new Error("Failed to save Agent token");
  return { ...result, token };
}

export async function listTokens(
  env: Bindings,
  principal: Principal,
  history = false,
): Promise<AgentToken[]> {
  browserOnly(principal);
  return (
    await env.DB.prepare(
      `SELECT id, name, prefix, scopes, expires_at AS expiresAt, created_at AS createdAt, revoked_at AS revokedAt FROM agent_tokens WHERE account_id = ? AND ${history ? "(revoked_at IS NOT NULL OR expires_at <= ?)" : "revoked_at IS NULL AND expires_at > ?"} ORDER BY created_at DESC`,
    )
      .bind(principal.accountId, new Date().toISOString())
      .all<AgentToken>()
  ).results;
}

export async function revokeToken(
  env: Bindings,
  principal: Principal,
  id: string,
): Promise<void> {
  browserOnly(principal);
  const result = await env.DB.prepare(
    "UPDATE agent_tokens SET revoked_at = coalesce(revoked_at, ?) WHERE id = ? AND account_id = ?",
  )
    .bind(new Date().toISOString(), id, principal.accountId)
    .run();
  if (!result.meta.changes)
    throw new HTTPException(404, { message: "Agent token not found" });
}
