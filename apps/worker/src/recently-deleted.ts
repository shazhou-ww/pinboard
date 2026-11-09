import { HTTPException } from "hono/http-exception";
import {
  normalizeItemFilter,
  recentlyDeletedPageSize,
  type DeletedItem,
  type DeletedPage,
  type Visibility,
} from "@shazhou/pinboard-contracts";
import type { Bindings } from "./env.js";
import { requireScope, type Principal } from "./identity.js";
import { key, parseCid } from "./content.js";
import { previewSourceLive, refreshPreviewReferences } from "./previews.js";

export const RECOVERY_MS = 30 * 86400000;

export async function listDeleted(
  env: Bindings,
  principal: Principal,
  cursor = "",
  query = "",
): Promise<DeletedPage> {
  const kinds = [
    ...(principal.scopes.includes("pins:read") ? ["pin"] : []),
    ...(principal.scopes.includes("publications:read") ? ["publication"] : []),
  ];
  if (!kinds.length) requireScope(principal, "pins:read");
  const now = new Date().toISOString();
  const source = `(
    SELECT 'pin' AS kind, p.cid AS id, p.name AS title, p.visibility, d.deleted_at AS deletedAt, d.expires_at AS expiresAt
    FROM deleted_pins d JOIN pins p ON p.account_id = d.account_id AND p.cid = d.cid WHERE d.account_id = ?
    UNION ALL SELECT 'publication', id, title, visibility, deleted_at, expires_at FROM publications WHERE account_id = ? AND deleted_at IS NOT NULL
  ) WHERE expiresAt > ? AND kind IN (SELECT value FROM json_each(?))`;
  const bindings = [
    principal.accountId,
    principal.accountId,
    now,
    JSON.stringify(kinds),
  ];
  const filter = normalizeItemFilter(query);
  const [rows, counts] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM ${source} AND instr(lower(title || ' ' || kind), ?) > 0
       AND kind || ':' || id > ? ORDER BY kind, id LIMIT ?`,
    )
      .bind(...bindings, filter, cursor, recentlyDeletedPageSize + 1)
      .all<DeletedItem>(),
    env.DB.prepare(
      `SELECT count(*) AS total,
       count(CASE WHEN instr(lower(title || ' ' || kind), ?) > 0 THEN 1 END) AS matchedTotal
       FROM ${source}`,
    )
      .bind(filter, ...bindings)
      .first<{ total: number; matchedTotal: number }>(),
  ]);
  if (!counts) throw new Error("Could not count recoverable items");
  const items = rows.results.slice(0, recentlyDeletedPageSize);
  return {
    items,
    ...counts,
    nextCursor:
      rows.results.length > recentlyDeletedPageSize
        ? `${items.at(-1)!.kind}:${items.at(-1)!.id}`
        : null,
  };
}

export async function restorePin(
  env: Bindings,
  principal: Principal,
  cid: string,
): Promise<{ restored: true; visibility: Visibility }> {
  requireScope(principal, "pins:delete");
  const result = await env.DB.prepare(
    "DELETE FROM deleted_pins WHERE account_id = ? AND cid = ? AND expires_at > ? RETURNING (SELECT visibility FROM pins p WHERE p.account_id = deleted_pins.account_id AND p.cid = deleted_pins.cid) AS visibility",
  )
    .bind(principal.accountId, key(parseCid(cid)), new Date().toISOString())
    .first<{ visibility: Visibility }>();
  if (!result)
    throw new HTTPException(404, { message: "Recoverable pin not found" });
  return { restored: true, visibility: result.visibility };
}

export async function expireDeleted(
  env: Bindings,
  time: number,
): Promise<void> {
  const now = new Date(time).toISOString();
  await env.DB.batch([
    // Restore and expiry serialize on these rows. Once expired, restore cannot
    // revive a reference even when physical cleanup has not run yet.
    env.DB.prepare(
      `UPDATE retention_state SET safe_after = max(safe_after, ?)
      WHERE EXISTS (SELECT 1 FROM deleted_pins d WHERE expires_at <= ? AND NOT EXISTS (SELECT 1 FROM dag_roots WHERE root = d.cid))`,
    ).bind(new Date(time + 7 * 86400000).toISOString(), now),
    env.DB.prepare(
      `DELETE FROM pins WHERE (account_id, cid) IN (
      SELECT account_id, cid FROM deleted_pins WHERE expires_at <= ? ORDER BY expires_at LIMIT 50)`,
    ).bind(now),
    env.DB.prepare(
      `DELETE FROM publication_retention WHERE publication_id IN (
      SELECT id FROM publications WHERE expires_at <= ? AND EXISTS (SELECT 1 FROM publication_retention r WHERE r.publication_id = publications.id) ORDER BY expires_at LIMIT 50)`,
    ).bind(now),
    env.DB.prepare(
      `UPDATE retained_blocks SET unreferenced_at = ? WHERE unreferenced_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM dag_members dm JOIN retained_roots r ON r.cid = dm.root WHERE dm.cid = retained_blocks.cid)`,
    ).bind(now),
    env.DB.prepare(
      `UPDATE content_previews SET unreferenced_at = ? WHERE unreferenced_at IS NULL
      AND NOT ${previewSourceLive}`,
    ).bind(now),
    refreshPreviewReferences(env.DB, time),
  ]);
}
