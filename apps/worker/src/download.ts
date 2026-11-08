import { Zip, ZipPassThrough } from "fflate";
import { HTTPException } from "hono/http-exception";
import {
  exporter,
  type ReadableStorage,
  type UnixFSEntry,
} from "ipfs-unixfs-exporter";
import { completeDag, key, MAX_UPLOAD, parseCid } from "./content.js";
import type { Bindings } from "./env.js";
import { headBlock, readBlock } from "./storage.js";

type FileEntry = Extract<UnixFSEntry, { type: "file" | "raw" }>;
interface DownloadEntry {
  path: string;
  file?: FileEntry;
}

function unsupported(): never {
  throw new HTTPException(422, {
    message:
      "Download requires a raw file or UnixFS file/directory. Export CAR for other IPLD content.",
  });
}

function safePart(name: string): boolean {
  return !(
    !name.trim() ||
    name === "." ||
    name === ".." ||
    /[<>:"/\\|?*\p{Cc}]/u.test(name) ||
    /[. ]$/u.test(name) ||
    /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(
      name,
    )
  );
}

function attachment(name: string, fallback: string): string {
  if (!safePart(name) || new TextEncoder().encode(name).length > 240)
    throw new HTTPException(400, { message: "Invalid download filename" });
  const ascii = name.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii || fallback}"; filename*=UTF-8''${encoded}`;
}

async function* fileBytes(file: FileEntry, signal: AbortSignal) {
  let size = 0n;
  for await (const chunk of file.content({ signal, blockReadConcurrency: 1 })) {
    signal.throwIfAborted();
    size += BigInt(chunk.length);
    if (size > file.size)
      throw new HTTPException(422, {
        message: "File exceeds its declared size",
      });
    yield chunk;
  }
  if (size !== file.size)
    throw new HTTPException(422, { message: "File content length mismatch" });
}

async function* zipBytes(entries: DownloadEntry[], signal: AbortSignal) {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  try {
    for (const entry of entries) {
      signal.throwIfAborted();
      const file = new ZipPassThrough(entry.path);
      file.mtime = new Date("1980-01-01T00:00:00Z");
      zip.add(file);
      if (entry.file) {
        for await (const chunk of fileBytes(entry.file, signal)) {
          file.push(chunk, false);
          yield* chunks.splice(0);
        }
      }
      file.push(new Uint8Array(), true);
      yield* chunks.splice(0);
    }
    zip.end();
    yield* chunks.splice(0);
  } finally {
    zip.terminate();
  }
}

function responseStream(
  bytes: AsyncGenerator<Uint8Array>,
  abort: AbortController,
  cid: string,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await bytes.next();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "download_failed",
            cid,
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        controller.error(error);
      }
    },
    async cancel(reason) {
      abort.abort(reason);
      await bytes.return(undefined);
    },
  });
}

export async function downloadContent(
  env: Pick<Bindings, "DB" | "BLOCKS">,
  cid: string,
  request: Request,
  name?: string,
): Promise<Response> {
  const rootCid = parseCid(cid);
  const id = key(rootCid);
  if (![0x55, 0x70].includes(rootCid.code)) unsupported();
  if (!(await headBlock(env, id)))
    throw new HTTPException(404, { message: "DAG not found" });
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  // Verify the complete DAG within the existing 32 MiB upload budget.
  const dag = await completeDag(rootCid, (link) => {
    signal.throwIfAborted();
    return readBlock(env, key(link));
  });
  const store: ReadableStorage = {
    *get(link) {
      signal.throwIfAborted();
      const bytes = dag.blocks.get(key(link));
      if (!bytes)
        throw new HTTPException(503, { message: "Content block unavailable" });
      yield bytes;
    },
  };
  const root = await exporter(rootCid, store, { signal });
  const entries: DownloadEntry[] = [];
  const paths = new Set<string>();
  let total = 0n;
  let count = 0;
  async function walk(entry: UnixFSEntry, parts: string[]): Promise<void> {
    signal.throwIfAborted();
    if (++count > 10000 || parts.length > 256)
      throw new HTTPException(413, {
        message: "Download tree exceeds entry or depth limit",
      });
    if (entry.type === "directory") {
      if (parts.length) entries.push({ path: parts.join("/") + "/" });
      for await (const child of entry.entries({ signal })) {
        if (!safePart(child.name))
          throw new HTTPException(422, {
            message: "Unsafe archive path. Export CAR instead.",
          });
        const path = [...parts, child.name];
        const normalized = path.join("/").normalize("NFC").toLowerCase();
        if (paths.has(normalized))
          throw new HTTPException(422, {
            message: "Conflicting archive paths. Export CAR instead.",
          });
        paths.add(normalized);
        await walk(await exporter(child.cid, store, { signal }), path);
      }
    } else if (entry.type === "file" || entry.type === "raw") {
      if (entry.size < 0n || entry.size > BigInt(MAX_UPLOAD) - total)
        throw new HTTPException(413, {
          message: "Restored content exceeds 32 MiB",
        });
      total += entry.size;
      entries.push({ path: parts.join("/"), file: entry });
    } else unsupported();
  }
  await walk(root, []);
  const directory = root.type === "directory";
  const filename = directory ? `${name ?? id}.zip` : (name ?? `${id}.bin`);
  const headers: Record<string, string> = {
    "Content-Type": directory ? "application/zip" : "application/octet-stream",
    "Content-Disposition": attachment(filename, id),
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "X-Content-Type-Options": "nosniff",
  };
  if (!directory) headers["Content-Length"] = String(root.size);
  return new Response(
    responseStream(
      directory
        ? zipBytes(entries, signal)
        : fileBytes(entries[0]!.file!, signal),
      abort,
      id,
    ),
    { headers },
  );
}
