import { CarWriter } from "@ipld/car";
import * as dagCbor from "@ipld/dag-cbor";
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
export function negotiateCar(request: Request, probe: boolean): boolean {
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
  const supportedScope =
    scope === "block" || (probe && !query.has("dag-scope"));
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
  if (supportedScope && supported && !query.has("entity-bytes")) return true;
  if (format !== "car") return false;
  throw new HTTPException(406, {
    message:
      "Supported CAR: explicit dag-scope=block, version=1, order=dfs, dups=n; entity-bytes is unsupported",
  });
}

export async function pathProof(
  root: CID,
  parts: string[],
  read: (cid: CID) => Promise<Uint8Array | undefined> | Uint8Array | undefined,
  signal: AbortSignal,
  missingRootStatus: 404 | 412 = 404,
): Promise<{ cid: CID; bytes: Uint8Array }[]> {
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  let size = 0;
  async function load(cid: CID): Promise<Uint8Array> {
    signal.throwIfAborted();
    const cached = blocks.get(key(cid));
    if (cached) return cached.bytes;
    if (blocks.size >= MAX_BLOCKS)
      throw new HTTPException(413, { message: "Proof exceeds 256 blocks" });
    const bytes = await read(cid);
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
      try {
        value = dagCbor.decode(await load(cid));
      } catch {
        throw new HTTPException(503, { message: "Invalid DAG-CBOR block" });
      }
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
      );
  const { writer, out } = CarWriter.create([root]);
  const writing = (async () => {
    for (const block of blocks) await writer.put(block);
    await writer.close();
  })();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of out) {
    chunks.push(chunk);
    length += chunk.length;
  }
  await writing;
  signal.throwIfAborted();
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
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
  return new Response(request.method === "HEAD" || notModified ? null : bytes, {
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
