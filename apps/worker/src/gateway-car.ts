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
import {
  matchesEtag,
  mediaQuality,
  onlyIfCached,
  parseAccept,
} from "./gateway-http.js";
import {
  entityRange,
  fileMetadata,
  rangeKey,
  selectRange,
  type EntityRange,
} from "./gateway-range.js";
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

export function negotiateCar(
  request: Request,
  imageAvailable = false,
): boolean {
  const query = new URL(request.url).searchParams;
  const format = query.get("format");
  if (format !== null && format !== "car") return false;
  let ranges: ReturnType<typeof parseAccept>;
  try {
    ranges = parseAccept(request.headers.get("accept") ?? "*/*");
  } catch (error) {
    if (format !== "car") throw error;
    // Explicit format retains precedence over a malformed Accept header.
    ranges = [];
  }
  const offers = ranges.filter((range) => range.type === CAR_TYPE);
  const supports = (parameters: Map<string, string>) => {
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
  };
  let selected: boolean;
  if (format === "car") {
    selected = offers.length
      ? offers.some(({ parameters }) => supports(parameters))
      : supports(new Map());
  } else if (!offers.length) {
    selected = false;
  } else {
    const car = mediaQuality(ranges, CAR_TYPE, supports);
    const raw = mediaQuality(ranges, "application/vnd.ipld.raw");
    const image = imageAvailable
      ? mediaQuality(ranges, "image/webp")
      : { q: 0, specificity: -1 };
    const explicit = offers.some(
      ({ parameters, q }) => q > 0 && supports(parameters),
    );
    selected =
      car.q > 0 &&
      [raw, image].every(
        (other) =>
          car.q > other.q ||
          (car.q === other.q &&
            (car.specificity > other.specificity ||
              (explicit && car.specificity === other.specificity))),
      );
  }
  if (format === "car" || offers.length || selected) {
    try {
      for (const pair of new URL(request.url).search.slice(1).split("&"))
        for (const value of pair.split("="))
          decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      throw new HTTPException(400, { message: "Malformed CAR query encoding" });
    }
    for (const name of [
      "format",
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
    entityRange(query.get("entity-bytes"));
  }
  if (selected || format !== "car") return selected;
  throw new HTTPException(406, {
    message:
      "Supported CAR: dag-scope=block|entity|all (default all), entity-bytes=from:to, version=1, order=dfs, dups=n",
  });
}

export async function pathProof(
  root: CID,
  parts: string[],
  read: (cid: CID) => Promise<Uint8Array | undefined> | Uint8Array | undefined,
  signal: AbortSignal,
  missingRootStatus: 404 | 412 = 404,
  scope: "block" | "entity" | "all" = "block",
  range?: EntityRange,
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
      bytes = cid.multihash.code === 0 ? cid.multihash.digest : await read(cid);
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
      if (cid.multihash.code === 0) {
        if (bytes.length > MAX_BLOCK)
          throw new HTTPException(413, { message: "Block exceeds 2 MiB" });
        if (![0x55, dagPb.code, dagCbor.code].includes(cid.code))
          throw new Error("Unsupported identity codec");
      } else await verifyBlock(cid, bytes);
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
    const pending = [value];
    const links: CID[] = [];
    while (pending.length) {
      const current = pending.pop();
      const link = CID.asCID(current);
      if (link) {
        links.push(link);
      } else if (Array.isArray(current)) {
        for (let index = current.length - 1; index >= 0; index--)
          pending.push(current[index]);
      } else if (
        current !== null &&
        typeof current === "object" &&
        !(current instanceof Uint8Array)
      ) {
        // DAG-CBOR map order is encoded-key length, then unsigned UTF-8 bytes.
        const encoder = new TextEncoder();
        const names = Object.keys(current).map((name) => ({
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
        for (const { name } of names.reverse())
          pending.push((current as Record<string, unknown>)[name]);
      }
    }
    return links;
  }
  async function walk(root: CID): Promise<void> {
    const pending = [root];
    while (pending.length) {
      const current = pending.pop()!;
      if (visited.has(key(current))) continue;
      visited.add(key(current));
      const bytes = await load(current);
      const links =
        current.code === dagPb.code
          ? decodePb(bytes).Links.map((link) => link.Hash)
          : current.code === dagCbor.code
            ? valueLinks(decodeCbor(bytes))
            : [];
      for (let index = links.length - 1; index >= 0; index--)
        pending.push(links[index]!);
    }
  }
  async function fileRange(root: CID): Promise<boolean> {
    const bytes = await load(root);
    if (root.code === 0x55) {
      selectRange(range!, BigInt(bytes.length));
      return true;
    }
    if (root.code !== dagPb.code) {
      // A DAG-CBOR byte string (including an inline terminal) is a continuous
      // byte entity, but its containing block remains the CID verification unit.
      const terminal = inValue ? value : decodeCbor(bytes);
      if (terminal instanceof Uint8Array)
        selectRange(range!, BigInt(terminal.length));
      return false;
    }
    const pb = decodePb(bytes);
    if (!pb.Data) return false;
    const metadata = fileMetadata(pb.Data, pb.Links.length);
    if (!metadata) return false;
    const selected = selectRange(range!, metadata.size);
    const pending = [{ cid: root, ...selected, expected: metadata.size }];
    const covered = new Map<string, { start: bigint; end: bigint }[]>();
    while (pending.length) {
      signal.throwIfAborted();
      const task = pending.pop()!;
      const bytes = await load(task.cid);
      if (task.cid.code === 0x55) {
        if (BigInt(bytes.length) !== task.expected)
          throw new HTTPException(503, {
            message: "UnixFS child size mismatch",
          });
        continue;
      }
      if (task.cid.code !== dagPb.code)
        throw new HTTPException(503, { message: "Invalid UnixFS file child" });
      const pb = decodePb(bytes);
      const meta = pb.Data && fileMetadata(pb.Data, pb.Links.length);
      if (!meta || meta.size !== task.expected)
        throw new HTTPException(503, { message: "UnixFS child size mismatch" });
      const intervals = covered.get(key(task.cid)) ?? [];
      if (
        intervals.some(
          ({ start, end }) => start <= task.start && end >= task.end,
        )
      )
        continue;
      intervals.push({ start: task.start, end: task.end });
      covered.set(key(task.cid), intervals);
      let offset = meta.inline;
      const children = [];
      for (let index = 0; index < meta.sizes.length; index++) {
        const size = meta.sizes[index]!;
        const end = offset + size;
        if (task.start < end && task.end > offset) {
          children.push({
            cid: pb.Links[index]!.Hash,
            start: task.start > offset ? task.start - offset : 0n,
            end: task.end < end ? task.end - offset : size,
            expected: size,
          });
        }
        offset = end;
      }
      for (let index = children.length - 1; index >= 0; index--)
        pending.push(children[index]!);
    }
    return true;
  }
  if (range) scope = "entity";
  const selectedFile =
    range && (!inValue || value instanceof Uint8Array)
      ? await fileRange(cid)
      : false;
  if (scope === "all") {
    if (inValue) {
      const links = valueLinks(value);
      for (const link of links) await walk(link);
    } else await walk(cid);
  } else if (
    scope === "entity" &&
    !selectedFile &&
    !inValue &&
    cid.code === dagPb.code
  ) {
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
  return [...blocks.values()].filter(({ cid }) => cid.multihash.code !== 0);
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
  const query = new URL(request.url).searchParams;
  const range = entityRange(query.get("entity-bytes"));
  const scope = range ? "entity" : (query.get("dag-scope") ?? "all");
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
        scope as "block" | "entity" | "all",
        range,
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
      scope,
      rangeKey(range),
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
      "Content-Location": contentLocation(request),
      ETag: etag,
    },
  });
}

function contentLocation(request: Request): string {
  const url = new URL(request.url);
  url.searchParams.set("format", "car");
  url.searchParams.set("car-version", "1");
  url.searchParams.set("car-order", "dfs");
  url.searchParams.set("car-dups", "n");
  if (url.searchParams.has("entity-bytes")) {
    url.searchParams.set("dag-scope", "entity");
    url.searchParams.set(
      "entity-bytes",
      rangeKey(entityRange(url.searchParams.get("entity-bytes")))!,
    );
  }
  return `${url.pathname}${url.search}`;
}
