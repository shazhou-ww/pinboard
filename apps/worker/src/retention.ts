import { completeDag, key, parseCid } from "./content.js";
import type { Bindings } from "./env.js";
import { dagStatements, readBlock } from "./storage.js";
import { expireDeleted } from "./recently-deleted.js";

export const CONTENT_RETENTION_MS = 7 * 86400000;
export const TOKEN_RETENTION_MS = 30 * 86400000;
const OBJECT_BATCH = 20;
const SCAN_BATCH = 50;
const BACKFILL_BATCH = 1;

const invalidAt =
  "CASE WHEN revoked_at IS NULL OR expires_at < revoked_at THEN expires_at ELSE revoked_at END";
const knownPins =
  "NOT EXISTS (SELECT 1 FROM retained_roots p WHERE NOT EXISTS (SELECT 1 FROM dag_roots d WHERE d.root = p.cid))";
const collectible = `
  unreferenced_at <= ? AND
  NOT EXISTS (
    SELECT 1 FROM object_blocks ob
    LEFT JOIN retained_blocks b ON b.cid = ob.cid
    WHERE ob.object_key = storage_objects.object_key
      AND (b.cid IS NULL OR b.unreferenced_at IS NULL OR b.unreferenced_at > ?)
  ) AND
  NOT EXISTS (SELECT 1 FROM car_dags d JOIN retained_roots p ON p.cid = d.root
              WHERE d.object_key = storage_objects.object_key) AND
  ${knownPins} AND (SELECT safe_after FROM retention_state WHERE id = 1) <= ?`;

export interface RetentionReport {
  tokensDeleted: number;
  backfilled: number;
  backfillFailed: number;
  discovered: number;
  unknownObjects: number;
  objectsDeleted: number;
  objectsFailed: number;
  blockedPins: number;
}

async function backfill(
  env: Bindings,
  now: string,
  report: RetentionReport,
): Promise<void> {
  const roots = await env.DB.prepare(
    `SELECT DISTINCT p.cid FROM retained_roots p
     LEFT JOIN retention_backfill a ON a.root = p.cid
     WHERE NOT EXISTS (SELECT 1 FROM dag_roots d WHERE d.root = p.cid)
     ORDER BY coalesce(a.attempted_at, ''), p.cid LIMIT ?`,
  )
    .bind(BACKFILL_BATCH)
    .all<{ cid: string }>();
  for (const { cid } of roots.results) {
    await env.DB.prepare(
      "INSERT INTO retention_backfill (root, attempted_at) VALUES (?, ?) ON CONFLICT(root) DO UPDATE SET attempted_at = excluded.attempted_at",
    )
      .bind(cid, now)
      .run();
    try {
      const dag = await completeDag(parseCid(cid), (link) =>
        readBlock(env, key(link)),
      );
      await env.DB.batch([
        ...dagStatements(env.DB, dag, now),
        env.DB.prepare("DELETE FROM retention_backfill WHERE root = ?").bind(
          cid,
        ),
      ]);
      report.backfilled++;
    } catch (error) {
      report.backfillFailed++;
      console.error(
        JSON.stringify({
          event: "retention_backfill_failed",
          cid,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  report.blockedPins = (await env.DB.prepare(
    "SELECT count(DISTINCT cid) AS count FROM retained_roots WHERE NOT EXISTS (SELECT 1 FROM dag_roots WHERE root = retained_roots.cid)",
  ).first<{ count: number }>())!.count;
}

async function discover(
  env: Bindings,
  now: string,
  report: RetentionReport,
): Promise<void> {
  const state = await env.DB.prepare(
    "SELECT scan_cursor FROM retention_state WHERE id = 1",
  ).first<{ scan_cursor: string | null }>();
  const page = await env.BLOCKS.list({
    limit: SCAN_BATCH,
    ...(state?.scan_cursor ? { cursor: state.scan_cursor } : {}),
  });
  for (const object of page.objects) {
    let cid: string | null = null;
    if (!/^cars\/[^/]+\.car$/.test(object.key)) {
      try {
        cid = key(parseCid(object.key));
        if (cid !== object.key) throw new Error("Noncanonical object key");
      } catch {
        report.unknownObjects++;
        continue;
      }
    }
    const statements = [
      env.DB.prepare(
        "INSERT OR IGNORE INTO storage_objects (object_key, state, unreferenced_at, retry_at) VALUES (?, 'ready', ?, ?)",
      ).bind(object.key, now, now),
    ];
    if (cid)
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO retained_blocks (cid, unreferenced_at) VALUES (?, ?)",
        ).bind(cid, now),
        env.DB.prepare(
          "INSERT OR IGNORE INTO object_blocks (object_key, cid) VALUES (?, ?)",
        ).bind(object.key, cid),
      );
    const results = await env.DB.batch(statements);
    report.discovered += results[0]!.meta.changes;
  }
  await env.DB.prepare(
    "UPDATE retention_state SET scan_cursor = ? WHERE id = 1",
  )
    .bind(page.truncated ? page.cursor : null)
    .run();
}

async function collect(
  env: Bindings,
  now: string,
  cutoff: string,
  report: RetentionReport,
): Promise<void> {
  const objects = await env.DB.prepare(
    `SELECT object_key, attempts FROM storage_objects WHERE retry_at <= ?
     AND (state = 'deleting' OR (${collectible}))
     ORDER BY retry_at, object_key LIMIT ?`,
  )
    .bind(now, cutoff, cutoff, now, OBJECT_BATCH)
    .all<{ object_key: string; attempts: number }>();
  for (const object of objects.results) {
    try {
      // Recheck liveness atomically with detaching the indexes. Every writer
      // publishes a fresh archive and is fenced by this persistent state.
      const claimed = await env.DB.batch([
        env.DB.prepare(
          `UPDATE storage_objects SET state = 'deleting'
           WHERE object_key = ? AND (state = 'deleting' OR (${collectible}))
           RETURNING object_key`,
        ).bind(object.object_key, cutoff, cutoff, now),
        env.DB.prepare(
          "DELETE FROM car_blocks WHERE object_key = ? AND EXISTS (SELECT 1 FROM storage_objects WHERE object_key = ? AND state = 'deleting')",
        ).bind(object.object_key, object.object_key),
        env.DB.prepare(
          "DELETE FROM car_dags WHERE object_key = ? AND EXISTS (SELECT 1 FROM storage_objects WHERE object_key = ? AND state = 'deleting')",
        ).bind(object.object_key, object.object_key),
      ]);
      if (!claimed[0]!.results.length) continue;
      await env.BLOCKS.delete(object.object_key);
      await env.DB.prepare(
        "DELETE FROM storage_objects WHERE object_key = ? AND state = 'deleting'",
      )
        .bind(object.object_key)
        .run();
      report.objectsDeleted++;
    } catch (error) {
      report.objectsFailed++;
      console.error(
        JSON.stringify({
          event: "retention_object_failed",
          objectKey: object.object_key,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      const delay = Math.min(
        24 * 3600000,
        60000 * 2 ** Math.min(object.attempts, 10),
      );
      await env.DB.prepare(
        "UPDATE storage_objects SET attempts = attempts + 1, retry_at = ? WHERE object_key = ?",
      )
        .bind(
          new Date(Date.parse(now) + delay).toISOString(),
          object.object_key,
        )
        .run();
    }
  }
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM dag_roots WHERE root IN (
        SELECT root FROM dag_roots d WHERE
        NOT EXISTS (SELECT 1 FROM retained_roots p WHERE p.cid = d.root) AND
        NOT EXISTS (SELECT 1 FROM car_dags c WHERE c.root = d.root) AND
        NOT EXISTS (SELECT 1 FROM object_blocks b WHERE b.cid = d.root)
        LIMIT 50)`,
    ),
    env.DB.prepare(
      `DELETE FROM retained_blocks WHERE cid IN (
        SELECT cid FROM retained_blocks b WHERE
        NOT EXISTS (SELECT 1 FROM object_blocks o WHERE o.cid = b.cid) AND
        NOT EXISTS (SELECT 1 FROM dag_members m WHERE m.cid = b.cid)
        LIMIT 256)`,
    ),
    env.DB.prepare(
      "DELETE FROM retention_backfill WHERE root IN (SELECT root FROM retention_backfill a WHERE NOT EXISTS (SELECT 1 FROM retained_roots p WHERE p.cid = a.root) LIMIT 50)",
    ),
  ]);
}

export async function runRetention(
  env: Bindings,
  time = Date.now(),
): Promise<RetentionReport> {
  const now = new Date(time).toISOString();
  const report: RetentionReport = {
    tokensDeleted: 0,
    backfilled: 0,
    backfillFailed: 0,
    discovered: 0,
    unknownObjects: 0,
    objectsDeleted: 0,
    objectsFailed: 0,
    blockedPins: 0,
  };
  try {
    await expireDeleted(env, time);
    report.tokensDeleted = (
      await env.DB.prepare(
        `DELETE FROM agent_tokens WHERE id IN (SELECT id FROM agent_tokens
       WHERE ${invalidAt} <= ? ORDER BY ${invalidAt}, id LIMIT 100)`,
      )
        .bind(new Date(time - TOKEN_RETENTION_MS).toISOString())
        .run()
    ).meta.changes;
    await backfill(env, now, report);
    await discover(env, now, report);
    await collect(
      env,
      now,
      new Date(time - CONTENT_RETENTION_MS).toISOString(),
      report,
    );
    console.log(JSON.stringify({ event: "retention_completed", ...report }));
    return report;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "retention_failed",
        ...report,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}
