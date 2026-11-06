import {
  exporter,
  type ReadableStorage,
  type UnixFSEntry,
} from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import type {
  ContentPreview,
  PreviewPayload,
} from "@shazhou/pinboard-contracts";
import type { Bindings } from "./env.js";
import { key, parseCid, verifyBlock } from "./content.js";
import { readBlock } from "./storage.js";

export const PREVIEW_VERSION = 1;
export const PREVIEW_RETENTION_MS = 7 * 86400000;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TEXT = 2400;
const MAX_ENTRIES = 24;
const MAX_READS = 64;
const MAX_ATTEMPTS = 3;
const fileType = "application/vnd.pinboard.file+json" as const;
const nowIso = (time: number) => new Date(time).toISOString();
interface Row {
  descriptor: string;
  status: ContentPreview["status"];
  attempts: number;
}
interface Generated {
  descriptor: ContentPreview;
  image?: { cid: string; bytes: Uint8Array; width: number; height: number };
}
interface FileMetadata {
  size?: number;
  mediaType?: string;
}
class PreviewFailure extends Error {
  constructor(
    message: string,
    readonly metadata: FileMetadata,
  ) {
    super(message);
  }
}
const placeholder = (
  status: ContentPreview["status"],
  reason?: string,
  metadata: FileMetadata = {},
): ContentPreview => ({
  version: PREVIEW_VERSION,
  status,
  contentType: fileType,
  content: metadata,
  truncated: false,
  ...(reason ? { reason } : {}),
});

export function previewLog(event: string, source: string, error: unknown) {
  console.error(
    JSON.stringify({
      event,
      source,
      message: error instanceof Error ? error.message : String(error),
    }),
  );
}

export async function enqueuePreview(
  env: Bindings,
  cid: string,
  time = Date.now(),
) {
  await enqueueStatement(env, cid, time).run();
}

function enqueueStatement(env: Bindings, cid: string, time: number) {
  const descriptor = placeholder("pending");
  return env.DB.prepare(
    `INSERT OR IGNORE INTO content_previews (source_cid, version, status, descriptor, retry_at)
     SELECT ?, ?, 'pending', ?, ? WHERE ${retainedPreviewSource("?")}`,
  ).bind(
    cid,
    PREVIEW_VERSION,
    JSON.stringify(descriptor),
    nowIso(time),
    cid,
    cid,
  );
}

export async function getPreviews(
  env: Bindings,
  cids: readonly string[],
): Promise<Map<string, ContentPreview>> {
  if (!cids.length) return new Map();
  await env.DB.batch(cids.map((cid) => enqueueStatement(env, cid, Date.now())));
  const rows = await env.DB.prepare(
    `SELECT source_cid, descriptor FROM content_previews WHERE version = ? AND source_cid IN (${cids.map(() => "?").join(",")})`,
  )
    .bind(PREVIEW_VERSION, ...cids)
    .all<{ source_cid: string; descriptor: string }>();
  const result = new Map(
    rows.results.map((row) => [
      row.source_cid,
      JSON.parse(row.descriptor) as ContentPreview,
    ]),
  );
  for (const cid of cids)
    if (!result.has(cid)) result.set(cid, placeholder("pending"));
  return result;
}

export async function getPreview(
  env: Bindings,
  cid: string,
): Promise<ContentPreview> {
  await enqueuePreview(env, cid);
  const row = await env.DB.prepare(
    "SELECT descriptor FROM content_previews WHERE source_cid = ? AND version = ?",
  )
    .bind(cid, PREVIEW_VERSION)
    .first<Row>();
  return row
    ? (JSON.parse(row.descriptor) as ContentPreview)
    : placeholder("pending");
}

function description(
  payload: PreviewPayload,
  truncated = false,
  status: ContentPreview["status"] = "ready",
  reason?: string,
): ContentPreview {
  return {
    ...payload,
    version: PREVIEW_VERSION,
    status,
    truncated,
    ...(reason ? { reason } : {}),
  };
}

export function textDescription(
  bytes: Uint8Array,
  size: bigint,
): ContentPreview | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: BigInt(bytes.length) < size,
    });
  } catch {
    return null;
  }
  if (
    [...text].some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 && ![9, 10, 13].includes(code);
    })
  )
    return null;
  if (/^\s*(?:<\?xml|<!doctype|<html\b|<svg\b|<script\b)/iu.test(text))
    return null;
  const characters = Array.from(text);
  const truncated = characters.length > MAX_TEXT || BigInt(bytes.length) < size;
  text = characters.slice(0, MAX_TEXT).join("");
  // Source syntax is never trusted as formatting intent. Code fences preserve
  // structured text, while ordinary Markdown punctuation stays literal.
  if (
    /^\s*[{[]/u.test(text) ||
    /^(?:import |export |function |const |def |class )/mu.test(text)
  ) {
    const fence = "`".repeat(
      Math.max(
        3,
        ...[...text.matchAll(/`+/gu)].map((match) => match[0].length + 1),
      ),
    );
    return description(
      { contentType: "text/markdown", content: `${fence}\n${text}\n${fence}` },
      truncated,
    );
  }
  const escaped = text.replace(/([\\`*_{}[\]()#+.!>|~-])/gu, "\\$1");
  return description(
    { contentType: "text/markdown", content: escaped },
    truncated,
  );
}

async function generate(env: Bindings, cid: string): Promise<Generated> {
  let reads = 0;
  let readBytes = 0;
  const store: ReadableStorage = {
    async *get(link) {
      if (++reads > MAX_READS)
        throw new Error("Preview exceeds 64 block reads");
      const bytes = await readBlock(env, key(link));
      if (!bytes) throw new Error("Preview source block is unavailable");
      readBytes += bytes.length;
      if (readBytes > 12 * 1024 * 1024)
        throw new Error("Preview exceeds 12 MiB block budget");
      await verifyBlock(parseCid(link.toString()), bytes);
      yield bytes;
    },
  };
  const root = await exporter(parseCid(cid), store);
  if (root.type === "directory") {
    const entries: {
      name: string;
      kind: "file" | "directory" | "unknown";
      depth: number;
    }[] = [];
    const overview = { truncated: false };
    let rootTotal = 0;
    const visit = async (directory: UnixFSEntry, depth: number) => {
      if (directory.type !== "directory") return;
      for await (const entry of directory.entries({
        blockReadConcurrency: 1,
      })) {
        if (depth === 0) rootTotal++;
        if (entries.length >= MAX_ENTRIES) {
          overview.truncated = true;
          break;
        }
        const child = await exporter(entry.cid, store);
        entries.push({
          name: entry.name,
          kind:
            child.type === "directory"
              ? "directory"
              : ["file", "raw"].includes(child.type)
                ? "file"
                : "unknown",
          depth,
        });
        if (child.type === "directory") {
          if (depth < 1) await visit(child, depth + 1);
          else overview.truncated = true;
        }
      }
    };
    await visit(root, 0);
    return {
      descriptor: description(
        {
          contentType: "application/vnd.pinboard.directory+json",
          content: {
            entries,
            ...(!overview.truncated ? { total: rootTotal } : {}),
          },
        },
        overview.truncated,
      ),
    };
  }
  if (root.type !== "file" && root.type !== "raw")
    return {
      descriptor: description(
        { contentType: fileType, content: {} },
        false,
        "unsupported",
        "No preview for this verified IPLD content",
      ),
    };
  const size = root.size;
  const readFile = async (limit: number) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of root.content({
      length: Math.min(Number(size), limit),
      blockReadConcurrency: 1,
    })) {
      length += chunk.length;
      if (length > limit) throw new Error("File exceeds preview read limit");
      chunks.push(chunk);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  };
  let bytes = await readFile(10000);
  const first = new TextDecoder().decode(bytes.subarray(0, 16));
  const isImage =
    (bytes[0] === 255 && bytes[1] === 216) ||
    (bytes[0] === 137 && first.slice(1, 4) === "PNG") ||
    (first.startsWith("RIFF") && first.slice(8, 12) === "WEBP");
  if (isImage) {
    const mediaType =
      bytes[0] === 255
        ? "image/jpeg"
        : bytes[0] === 137
          ? "image/png"
          : "image/webp";
    try {
      if (size > BigInt(MAX_FILE))
        throw new Error("Image exceeds 8 MiB preview limit");
      if (BigInt(bytes.length) !== size) bytes = await readFile(MAX_FILE);
      if (BigInt(bytes.length) !== size)
        throw new Error("Image length mismatch");
      const { thumbnail } = await import("./preview-image.js");
      const image = await thumbnail(bytes);
      const thumbnailCid = CID.createV1(
        0x55,
        await sha256.digest(image.bytes),
      ).toString();
      return {
        descriptor: description({
          contentType: "image/webp",
          content: {
            cid: thumbnailCid,
            url: `/ipfs/${thumbnailCid}`,
            width: image.width,
            height: image.height,
          },
        }),
        image: { ...image, cid: thumbnailCid },
      };
    } catch (error) {
      throw new PreviewFailure(
        error instanceof Error ? error.message : String(error),
        {
          mediaType,
          ...(BigInt(bytes.length) === size ? { size: bytes.length } : {}),
        },
      );
    }
  }
  const mediaType = first.startsWith("%PDF-")
    ? "application/pdf"
    : first.startsWith("GIF87a") || first.startsWith("GIF89a")
      ? "image/gif"
      : first.slice(4, 8) === "ftyp" &&
          ["isom", "iso2", "mp41", "mp42"].includes(first.slice(8, 12))
        ? "application/mp4"
        : first.startsWith("ID3")
          ? "audio/mpeg"
          : undefined;
  const text = mediaType ? null : textDescription(bytes, size);
  if (text) return { descriptor: text };
  return {
    descriptor: description(
      {
        contentType: fileType,
        content: {
          ...(BigInt(bytes.length) === size ? { size: bytes.length } : {}),
          ...(mediaType ? { mediaType } : {}),
        },
      },
      false,
      "unsupported",
      "No supported lightweight preview for this content",
    ),
  };
}

function retainedPreviewSource(source: string) {
  return `(EXISTS (SELECT 1 FROM retained_roots WHERE cid = ${source})
    OR EXISTS (SELECT 1 FROM dag_members dm JOIN retained_roots r ON r.cid = dm.root WHERE dm.cid = ${source}))`;
}

export const previewSourceLive = retainedPreviewSource("source_cid");

// These predicates are always rechecked inside the transaction performing GC.
const imageLive = `(EXISTS (
  SELECT 1 FROM content_previews cp
  WHERE cp.thumbnail_cid = preview_images.cid AND cp.active = 1 AND cp.status = 'ready' AND ${retainedPreviewSource("cp.source_cid")}
) OR EXISTS (SELECT 1 FROM retained_roots WHERE retained_roots.cid = preview_images.cid)
 OR EXISTS (SELECT 1 FROM dag_members dm JOIN retained_roots p ON p.cid = dm.root WHERE dm.cid = preview_images.cid))`;

export function refreshPreviewReferences(
  db: D1Database,
  time = Date.now(),
  source?: string,
): D1PreparedStatement {
  const where = source
    ? "cid = ? OR cid IN (SELECT thumbnail_cid FROM content_previews WHERE source_cid = ?) OR cid IN (SELECT cid FROM dag_members WHERE root = ?)"
    : `cid IN (SELECT cid FROM preview_images WHERE
        (${imageLive} AND unreferenced_at IS NOT NULL) OR
        (NOT ${imageLive} AND unreferenced_at IS NULL) LIMIT 50)`;
  return db
    .prepare(
      `UPDATE preview_images SET unreferenced_at = CASE WHEN ${imageLive} THEN NULL ELSE coalesce(unreferenced_at, ?) END WHERE ${where}`,
    )
    .bind(nowIso(time), ...(source ? [source, source, source] : []));
}

export async function processPreview(
  env: Bindings,
  cid: string,
  time = Date.now(),
): Promise<void> {
  const lease = crypto.randomUUID();
  const row = await env.DB.prepare(
    `UPDATE content_previews SET lease = ?, lease_until = ?, attempts = attempts + 1
     WHERE source_cid = ? AND version = ? AND attempts < ?
     AND status IN ('pending', 'failed') AND retry_at <= ?
     AND (lease_until IS NULL OR lease_until <= ?)
     AND ${previewSourceLive}
     RETURNING descriptor, status, attempts`,
  )
    .bind(
      lease,
      nowIso(time + 120000),
      cid,
      PREVIEW_VERSION,
      MAX_ATTEMPTS,
      nowIso(time),
      nowIso(time),
    )
    .first<Row>();
  if (!row) return;
  try {
    const generated = await generate(env, cid);
    const statements: D1PreparedStatement[] = [];
    statements.push(
      env.DB.prepare(
        `UPDATE content_previews SET active = 0 WHERE source_cid = ? AND version < ?
       AND EXISTS (SELECT 1 FROM content_previews job WHERE job.source_cid = ? AND job.version = ? AND job.lease = ?)`,
      ).bind(cid, PREVIEW_VERSION, cid, PREVIEW_VERSION, lease),
    );
    if (generated.image) {
      const image = generated.image;
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO preview_images (cid, bytes, width, height, unreferenced_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_previews WHERE source_cid = ? AND version = ? AND lease = ?)`,
        ).bind(
          image.cid,
          image.bytes,
          image.width,
          image.height,
          nowIso(time),
          cid,
          PREVIEW_VERSION,
          lease,
        ),
      );
    }
    statements.push(
      env.DB.prepare(
        `UPDATE content_previews SET status = ?, descriptor = ?, thumbnail_cid = ?, active = 1, lease = NULL, lease_until = NULL
         WHERE source_cid = ? AND version = ? AND lease = ?
         AND NOT EXISTS (SELECT 1 FROM content_previews newer WHERE newer.source_cid = ? AND newer.active = 1 AND newer.version > ?)`,
      ).bind(
        generated.descriptor.status,
        JSON.stringify(generated.descriptor),
        generated.image?.cid ?? null,
        cid,
        PREVIEW_VERSION,
        lease,
        cid,
        PREVIEW_VERSION,
      ),
    );
    statements.push(refreshPreviewReferences(env.DB, time, cid));
    await env.DB.batch(statements);
  } catch (error) {
    previewLog("preview_generation_failed", cid, error);
    const descriptor = placeholder(
      "failed",
      row.attempts >= MAX_ATTEMPTS
        ? "Preview failed after 3 attempts"
        : "Preview generation failed; retry scheduled",
      error instanceof PreviewFailure ? error.metadata : {},
    );
    await env.DB.prepare(
      `UPDATE content_previews SET status = 'failed', descriptor = ?, lease = NULL, lease_until = NULL, retry_at = ?
       WHERE source_cid = ? AND version = ? AND lease = ?`,
    )
      .bind(
        JSON.stringify(descriptor),
        nowIso(time + 60000 * 2 ** row.attempts),
        cid,
        PREVIEW_VERSION,
        lease,
      )
      .run();
  }
}

async function duePreviews(
  env: Bindings,
  time: number,
  cids?: readonly string[],
) {
  return env.DB.prepare(
    `SELECT source_cid FROM content_previews WHERE version = ? AND status IN ('pending', 'failed')
     AND attempts < ? AND retry_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
     AND ${previewSourceLive}
     ${cids ? `AND source_cid IN (${cids.map(() => "?").join(",")})` : ""}
     ORDER BY retry_at LIMIT 2`,
  )
    .bind(
      PREVIEW_VERSION,
      MAX_ATTEMPTS,
      nowIso(time),
      nowIso(time),
      ...(cids ?? []),
    )
    .all<{ source_cid: string }>();
}

export async function processPreviewBatch(
  env: Bindings,
  cids: readonly string[],
) {
  if (!cids.length) return;
  const jobs = await duePreviews(env, Date.now(), cids);
  for (const { source_cid } of jobs.results)
    await processPreview(env, source_cid);
}

export async function runPreviews(env: Bindings, time = Date.now()) {
  const exhausted = await env.DB.prepare(
    `UPDATE content_previews SET status = 'failed', descriptor = ?, lease = NULL, lease_until = NULL
     WHERE version = ? AND attempts >= ? AND status IN ('pending', 'failed')
     AND lease_until IS NOT NULL AND lease_until <= ?`,
  )
    .bind(
      JSON.stringify(
        placeholder("failed", "Preview worker exhausted 3 attempts"),
      ),
      PREVIEW_VERSION,
      MAX_ATTEMPTS,
      nowIso(time),
    )
    .run();
  if (exhausted.meta.changes)
    console.error(
      JSON.stringify({
        event: "preview_lease_exhausted",
        count: exhausted.meta.changes,
      }),
    );
  const missing = await env.DB.prepare(
    "SELECT DISTINCT cid FROM retained_roots WHERE NOT EXISTS (SELECT 1 FROM content_previews WHERE source_cid = retained_roots.cid AND version = ?) LIMIT 2",
  )
    .bind(PREVIEW_VERSION)
    .all<{ cid: string }>();
  for (const { cid } of missing.results) await enqueuePreview(env, cid, time);
  const jobs = await duePreviews(env, time);
  for (const { source_cid } of jobs.results)
    await processPreview(env, source_cid, time);
  const cutoff = nowIso(time - PREVIEW_RETENTION_MS);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE content_previews SET unreferenced_at =
       CASE WHEN (active = 1 OR version >= ?) AND ${previewSourceLive}
       THEN NULL ELSE coalesce(unreferenced_at, ?) END
       WHERE (source_cid, version) IN (
         SELECT source_cid, version FROM content_previews
         WHERE ((active = 1 OR version >= ?) AND ${previewSourceLive} AND unreferenced_at IS NOT NULL)
         OR (((active = 0 AND version < ?) OR NOT ${previewSourceLive}) AND unreferenced_at IS NULL)
         LIMIT 50)`,
    ).bind(PREVIEW_VERSION, nowIso(time), PREVIEW_VERSION, PREVIEW_VERSION),
    refreshPreviewReferences(env.DB, time),
    env.DB.prepare(
      `DELETE FROM content_previews WHERE (source_cid, version) IN (
        SELECT source_cid, version FROM content_previews
        WHERE unreferenced_at <= ? AND ((active = 0 AND version < ?) OR NOT ${previewSourceLive})
        AND (lease_until IS NULL OR lease_until <= ?) LIMIT 50)`,
    ).bind(cutoff, PREVIEW_VERSION, nowIso(time)),
    env.DB.prepare(
      `DELETE FROM preview_images WHERE cid IN (SELECT cid FROM preview_images WHERE unreferenced_at <= ? AND NOT ${imageLive} LIMIT 50)`,
    ).bind(cutoff),
  ]);
}
