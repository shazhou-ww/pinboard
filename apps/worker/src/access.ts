import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Bindings } from "./env.js";
import { authenticate, type AppEnv, type Principal } from "./identity.js";
import { key, parseCid } from "./content.js";
import type { Visibility } from "@shazhou/pinboard-contracts";

export async function optionalIdentity(
  c: Context<AppEnv>,
): Promise<Principal | undefined> {
  if (!c.req.header("authorization") && !c.req.header("cookie"))
    return undefined;
  try {
    return await authenticate(c);
  } catch (error) {
    if (
      !c.req.header("authorization") &&
      error instanceof HTTPException &&
      error.status === 401
    )
      return undefined;
    throw error;
  }
}

// Retention is not access. Only live items authorize bytes; thumbnails inherit
// their source's roots, never the uploader of a globally deduplicated CID.
export async function canReadBlock(
  env: Pick<Bindings, "DB">,
  cid: string,
  principal?: Principal,
): Promise<boolean> {
  const canonical = key(parseCid(cid));
  const row = await env.DB.prepare(
    `
    WITH sources(cid) AS (
      SELECT ? UNION SELECT source_cid FROM content_previews WHERE thumbnail_cid = ?
    ), roots(root) AS (
      SELECT cid FROM sources UNION
      SELECT dm.root FROM dag_members dm JOIN sources s ON s.cid = dm.cid
    )
    SELECT 1 FROM roots r WHERE
      EXISTS (SELECT 1 FROM pins p WHERE p.cid = r.root
        AND NOT EXISTS (SELECT 1 FROM deleted_pins d WHERE d.account_id = p.account_id AND d.cid = p.cid)
        AND (p.visibility = 'public' OR (p.account_id = ? AND ?)))
      OR EXISTS (SELECT 1 FROM publication_revisions v JOIN publications p ON p.id = v.publication_id
        WHERE v.cid = r.root AND p.deleted_at IS NULL
        AND (p.visibility = 'public' OR (p.account_id = ? AND ?)))
    LIMIT 1`,
  )
    .bind(
      canonical,
      canonical,
      principal?.accountId ?? "",
      principal?.scopes.includes("pins:read") ? 1 : 0,
      principal?.accountId ?? "",
      principal?.scopes.includes("publications:read") ? 1 : 0,
    )
    .first();
  return !!row;
}

export async function authorizeBlock(
  env: Pick<Bindings, "DB">,
  cid: string,
  principal?: Principal,
): Promise<void> {
  if (!(await canReadBlock(env, cid, principal)))
    throw new HTTPException(404, { message: "Content unavailable" });
}

export async function authorizePublication(
  env: Pick<Bindings, "DB">,
  id: string,
  principal?: Principal,
): Promise<Visibility> {
  const row = await env.DB.prepare(
    "SELECT visibility FROM publications WHERE id = ? AND deleted_at IS NULL AND (visibility = 'public' OR (account_id = ? AND ?))",
  )
    .bind(
      id,
      principal?.accountId ?? "",
      principal?.scopes.includes("publications:read") ? 1 : 0,
    )
    .first<{ visibility: Visibility }>();
  if (!row) throw new HTTPException(404, { message: "Content unavailable" });
  return row.visibility;
}
