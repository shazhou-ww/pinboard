import * as dagCbor from "@ipld/dag-cbor";
import * as dagPb from "@ipld/dag-pb";
import {
  exporter,
  resolvers,
  type ReadableStorage,
} from "ipfs-unixfs-exporter";
import { HTTPException } from "hono/http-exception";
import { CID } from "multiformats/cid";
import {
  key,
  MAX_BLOCK,
  MAX_BLOCKS,
  MAX_UPLOAD,
  PROBE_CID,
  verifyBlock,
} from "./content.js";
import type { Bindings } from "./env.js";
import { matchesEtag, onlyIfCached, parseAccept } from "./gateway-http.js";
import { getBlock } from "./storage.js";

const CAR_TYPE = "application/vnd.ipld.car";

export function gatewayPath(request: Request): { root: CID; parts: string[] } {
  const pathname = new URL(request.url).pathname;
  if (pathname.length > 8192)
    throw new HTTPException(414, { message: "IPLD path is too long" });
  let segments: string[];
  try {
    segments = pathname
      .slice("/ipfs/".length)
      .split("/")
      .map(decodeURIComponent);
  } catch {
    throw new HTTPException(400, { message: "Malformed URL encoding" });
  }
  if (segments.at(-1) === "") segments.pop();
  if (
    segments.length > 257 ||
    segments.some(
      (part) =>
        !part || part === "." || part === ".." || /[/\\\p{Cc}]/u.test(part),
    )
  )
    throw new HTTPException(400, { message: "Invalid IPLD path" });
  try {
    return { root: CID.parse(segments[0]!), parts: segments.slice(1) };
  } catch {
    throw new HTTPException(400, { message: "Invalid CID" });
  }
}

// Explicit format wins over Accept. Only explicit CAR media ranges select CAR;
// wildcards retain the existing raw/image behavior.
export function negotiateCar(request: Request): boolean {
  const query = new URL(request.url).searchParams;
  const format = query.get("format");
  if (format !== null && format !== "car") return false;
  const ranges =
    format === "car"
      ? [{ parameters: new Map<string, string>() }]
      : parseAccept(request.headers.get("accept") ?? "*/*").filter(
          (range) => range.type === CAR_TYPE && range.q > 0,
        );
  if (!ranges.length) return false;
  for (const name of [
    "dag-scope",
    "entity-bytes",
    "car-version",
    "car-order",
    "car-dups",
  ]) {
    if (query.getAll(name).length > 1)
      throw new HTTPException(400, { message: `Repeated ${name}` });
  }
  const scope = query.get("dag-scope") ?? "all";
  if (!["block", "entity", "all"].includes(scope))
    throw new HTTPException(400, { message: "Invalid dag-scope" });
  const supported = ranges.some(({ parameters }) => {
    if (
      [...parameters.keys()].some(
        (name) => !["version", "order", "dups"].includes(name),
      )
    )
      return false;
    return (
      (query.get("car-version") ?? parameters.get("version") ?? "1") === "1" &&
      (query.get("car-order") ?? parameters.get("order") ?? "dfs") === "dfs" &&
      (query.get("car-dups") ?? parameters.get("dups") ?? "n") === "n"
    );
  });
  if (supported && !query.has("entity-bytes")) return true;
  if (format !== "car") return false;
  throw new HTTPException(406, {
    message:
      "Supported CAR: dag-scope=block|entity|all (default all), version=1, order=dfs, dups=n; entity-bytes is unsupported",
  });
}

export async function pathProof(
  root: CID,
  parts: string[],
  read: (cid: CID) => Promise<Uint8Array | undefined> | Uint8Array | undefined,
  signal: AbortSignal,
  missingRootStatus: 404 | 412 = 404,
  scope: "block" | "entity" | "all" = "block",
): Promise<{ cid: CID; bytes: Uint8Array }[]> {
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  let size = 0;
  async function load(cid: CID): Promise<Uint8Array> {
    signal.throwIfAborted();
    const cached = blocks.get(key(cid));
    if (cached) return cached.bytes;
    if (blocks.size >= MAX_BLOCKS)
      throw new HTTPException(413, { message: "Proof exceeds 256 blocks" });
    let bytes: Uint8Array | undefined;
    try {
      bytes = await read(cid);
    } catch (error) {
      if (error instanceof HTTPException || signal.aborted) throw error;
      throw new HTTPException(503, {
        message: "Stored proof block unavailable",
      });
    }
    signal.throwIfAborted();
    if (!bytes)
      throw new HTTPException(blocks.size ? 503 : missingRootStatus, {
        message: "Proof block unavailable",
      });
    try {
      await verifyBlock(cid, bytes);
    } catch (error) {
      if (error instanceof HTTPException && error.status === 413) throw error;
      throw new HTTPException(503, { message: "Invalid stored proof block" });
    }
    size += bytes.length;
    if (size > MAX_UPLOAD)
      throw new HTTPException(413, { message: "Proof exceeds 32 MiB" });
    blocks.set(key(cid), { cid, bytes });
    return bytes;
  }
  const store: ReadableStorage = {
    async *get(cid) {
      yield await load(cid);
    },
  };
  function decodeCbor(bytes: Uint8Array): unknown {
    try {
      return dagCbor.decode(bytes);
    } catch {
      throw new HTTPException(503, { message: "Invalid DAG-CBOR block" });
    }
  }
  function decodePb(bytes: Uint8Array) {
    try {
      return dagPb.decode(bytes);
    } catch {
      throw new HTTPException(503, { message: "Invalid DAG-PB block" });
    }
  }
  let cid = root;
  let value: unknown;
  let inValue = false;
  await load(root);
  for (const part of parts) {
    signal.throwIfAborted();
    if (!inValue && cid.code === 0x70) {
      try {
        const entry = await exporter(cid, store, { signal });
        if (entry.type !== "directory")
          throw new HTTPException(404, { message: "Not a directory" });
        for await (const resolved of resolvers[0x70]!(cid, [part], store, {
          signal,
        })) {
          cid = resolved.cid;
        }
      } catch (error) {
        if (error instanceof HTTPException || signal.aborted) throw error;
        if (error instanceof Error && error.name === "NotFoundError")
          throw new HTTPException(404, { message: "IPLD path not found" });
        if (error instanceof Error && error.name === "NotUnixFSError")
          throw new HTTPException(422, { message: "Unsupported UnixFS path" });
        throw error;
      }
      await load(cid);
      continue;
    }
    if (!inValue) {
      if (cid.code !== dagCbor.code)
        throw new HTTPException(404, { message: "Block has no child path" });
      value = decodeCbor(await load(cid));
      inValue = true;
    }
    if (
      value === null ||
      typeof value !== "object" ||
      value instanceof Uint8Array ||
      (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(part)) ||
      !Object.hasOwn(value, part)
    )
      throw new HTTPException(404, { message: "IPLD path not found" });
    value = (value as Record<string, unknown>)[part];
    const link = CID.asCID(value);
    if (link) {
      cid = link;
      await load(cid);
      inValue = false;
    }
  }
  const visited = new Set<string>();
  function valueLinks(value: unknown): CID[] {
    const link = CID.asCID(value);
    if (link) {
      return [link];
    } else if (Array.isArray(value)) {
      return value.flatMap(valueLinks);
    } else if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Uint8Array)
    ) {
      // DAG-CBOR map order is encoded-key length, then unsigned UTF-8 bytes.
      const encoder = new TextEncoder();
      const names = Object.keys(value).map((name) => ({
        name,
        bytes: encoder.encode(name),
      }));
      names.sort((a, b) => {
        if (a.bytes.length !== b.bytes.length)
          return a.bytes.length - b.bytes.length;
        for (let i = 0; i < a.bytes.length; i++) {
          const difference = a.bytes[i]! - b.bytes[i]!;
          if (difference) return difference;
        }
        return 0;
      });
      return names.flatMap(({ name }) =>
        valueLinks((value as Record<string, unknown>)[name]),
      );
    }
    return [];
  }
  async function walk(cid: CID): Promise<void> {
    if (visited.has(key(cid))) return;
    visited.add(key(cid));
    const bytes = await load(cid);
    if (cid.code === dagPb.code) {
      const links = decodePb(bytes).Links.map((link) => link.Hash);
      for (const link of links) await walk(link);
    } else if (cid.code === dagCbor.code) {
      const links = valueLinks(decodeCbor(bytes));
      for (const link of links) await walk(link);
    }
  }
  if (scope === "all") {
    if (inValue) {
      const links = valueLinks(value);
      for (const link of links) await walk(link);
    } else await walk(cid);
  } else if (scope === "entity" && !inValue && cid.code === dagPb.code) {
    const node = decodePb(await load(cid));
    if (node.Data) {
      const entry = await exporter(cid, store, { signal }).catch(
        (error: unknown) => {
          if (error instanceof HTTPException || signal.aborted) throw error;
          if (error instanceof Error && error.name === "NotUnixFSError")
            return undefined;
          throw new HTTPException(503, { message: "Invalid UnixFS entity" });
        },
      );
      try {
        if (
          entry?.type === "file" &&
          (entry.unixfs.type === "file" || entry.unixfs.type === "raw")
        )
          await walk(cid);
        else if (
          entry?.type === "directory" &&
          entry.unixfs.type === "hamt-sharded-directory"
        ) {
          // This directory iterator reads shards, not child blocks to infer
          // entry types. The read-count regression test enforces that boundary.
          const entries = entry.entries({ signal });
          try {
            while (!(await entries.next()).done) signal.throwIfAborted();
          } finally {
            await entries.return();
          }
        }
      } catch (error) {
        if (error instanceof HTTPException || signal.aborted) throw error;
        throw new HTTPException(503, { message: "Invalid UnixFS entity" });
      }
    }
  }
  signal.throwIfAborted();
  return [...blocks.values()];
}

async function boundedBlock(
  env: Pick<Bindings, "DB" | "BLOCKS">,
  cid: CID,
  signal: AbortSignal,
) {
  const object = await getBlock(env, key(cid));
  if (!object) return undefined;
  const reader = (object.body as ReadableStream<Uint8Array>).getReader();
  const abort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    if (object.size > MAX_BLOCK)
      throw new HTTPException(413, { message: "Block exceeds 2 MiB" });
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > MAX_BLOCK)
        throw new HTTPException(413, { message: "Block exceeds 2 MiB" });
      chunks.push(value);
    }
    if (size !== object.size)
      throw new HTTPException(503, { message: "Stored block length mismatch" });
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function carResponse(
  env: Pick<Bindings, "DB" | "BLOCKS">,
  request: Request,
  root: CID,
  parts: string[],
): Promise<Response> {
  const signal = request.signal;
  signal.throwIfAborted();
  const probe = key(root) === PROBE_CID;
  if (probe && parts.length)
    throw new HTTPException(404, { message: "Probe has no child path" });
  const blocks = probe
    ? []
    : await pathProof(
        root,
        parts,
        (cid) => boundedBlock(env, cid, signal),
        signal,
        onlyIfCached(request.headers.get("cache-control") ?? undefined)
          ? 412
          : 404,
        (new URL(request.url).searchParams.get("dag-scope") ?? "all") as
          "block" | "entity" | "all",
      );
  function varint(value: number): Uint8Array<ArrayBuffer> {
    const bytes: number[] = [];
    do {
      const byte = value % 128;
      value = Math.floor(value / 128);
      bytes.push(byte | (value ? 128 : 0));
    } while (value);
    return Uint8Array.from(bytes);
  }
  const header = dagCbor.encode({ version: 1, roots: [root] });
  const headerLength = varint(header.length);
  let length = headerLength.length + header.length;
  for (const { cid, bytes } of blocks) {
    const section = cid.bytes.length + bytes.length;
    length += varint(section).length + section;
  }
  const representation = new TextEncoder().encode(
    JSON.stringify([
      root.toString(),
      parts,
      new URL(request.url).searchParams.get("dag-scope") ?? "all",
      1,
      "dfs",
      "n",
    ]),
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", representation),
  );
  const etag = `"${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}.car"`;
  const notModified = matchesEtag(
    request.headers.get("if-none-match") ?? undefined,
    etag,
  );
  // Preflight retains one bounded payload set. Framing never concatenates it
  // into a second CAR-sized buffer, and cancellation releases retained blocks.
  const chunks = (function* () {
    yield headerLength;
    yield header;
    for (const { cid, bytes } of blocks) {
      yield varint(cid.bytes.length + bytes.length);
      yield cid.bytes;
      yield bytes;
    }
  })();
  const clear = () => {
    chunks.return(undefined);
    blocks.length = 0;
  };
  const body =
    request.method === "HEAD" || notModified
      ? null
      : new ReadableStream<Uint8Array>({
          pull(controller) {
            if (signal.aborted) {
              clear();
              controller.error(signal.reason);
              return;
            }
            const chunk = chunks.next();
            if (chunk.done) {
              clear();
              controller.close();
            } else controller.enqueue(chunk.value);
          },
          cancel: clear,
        });
  if (!body) clear();
  signal.throwIfAborted();
  const output =
    body && typeof FixedLengthStream !== "undefined"
      ? body.pipeThrough(new FixedLengthStream(length))
      : body;
  return new Response(output, {
    status: notModified ? 304 : 200,
    headers: {
      "Content-Type": `${CAR_TYPE}; version=1; order=dfs; dups=n`,
      "Content-Length": String(length),
      "Content-Disposition": `attachment; filename="${key(root)}.car"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Ipfs-Path":
        `/ipfs/${root.toString()}/${parts.map(encodeURIComponent).join("/")}`.replace(
          /\/$/,
          "",
        ),
      ETag: etag,
    },
  });
}
