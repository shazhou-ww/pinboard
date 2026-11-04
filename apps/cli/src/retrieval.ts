import { CarReader } from "@ipld/car";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagPb from "@ipld/dag-pb";
import { uploadLimits } from "@workspace/contracts";
import {
  exporter,
  type ReadableStorage,
  type UnixFSEntry,
} from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { mkdir, lstat, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CliError, missing } from "./errors.js";
import { noLinks, sameFileIdentity } from "./permissions.js";

// Stored CARs add framing to the bounded DAG, including ordinary 32 MiB files.
export const maxCarBytes =
  uploadLimits.maxBytes + uploadLimits.maxBlocks * 512 + 4096;

interface Dag {
  root: CID;
  blocks: Map<string, Uint8Array>;
}

function invalidCar(): never {
  throw new CliError(
    "INVALID_CAR",
    "Expected a complete single-root CAR matching the requested CID, with valid supported blocks.",
  );
}

function blockLinks(cid: CID, bytes: Uint8Array): CID[] {
  if (cid.code === 0x55) return [];
  if (cid.code === dagPb.code)
    return dagPb.decode(bytes).Links.map((link) => link.Hash);
  const links: CID[] = [];
  const queue: unknown[] = [dagCbor.decode(bytes)];
  while (queue.length) {
    const value = queue.pop();
    if (!value || typeof value !== "object") continue;
    const link = CID.asCID(value);
    if (link) links.push(link);
    else {
      const children: unknown[] = Object.values(value);
      queue.push(...children);
    }
  }
  return links;
}

export async function verifyCar(
  bytes: Uint8Array,
  requested: string,
  signal: AbortSignal,
): Promise<Dag> {
  try {
    signal.throwIfAborted();
    if (bytes.length > maxCarBytes) invalidCar();
    const reader = await CarReader.fromBytes(bytes);
    const roots = await reader.getRoots();
    const root = CID.parse(requested).toV1();
    if (roots.length !== 1 || !roots[0]!.toV1().equals(root)) invalidCar();
    const blocks = new Map<string, Uint8Array>();
    let total = 0;
    let count = 0;
    for await (const block of reader.blocks()) {
      signal.throwIfAborted();
      if (
        ++count > uploadLimits.maxBlocks ||
        block.bytes.length > uploadLimits.maxBlockBytes ||
        block.cid.multihash.code !== sha256.code ||
        ![0x55, dagPb.code, dagCbor.code].includes(block.cid.code)
      )
        invalidCar();
      const digest = await sha256.digest(block.bytes);
      if (!CID.createV1(block.cid.code, digest).equals(block.cid.toV1()))
        invalidCar();
      const key = block.cid.toV1().toString();
      if (!blocks.has(key)) total += block.bytes.length;
      if (total > uploadLimits.maxBytes) invalidCar();
      blocks.set(key, block.bytes);
    }
    const visited = new Set<string>();
    const queue: CID[] = [root];
    while (queue.length) {
      signal.throwIfAborted();
      const cid = queue.pop()!;
      const key = cid.toV1().toString();
      if (visited.has(key)) continue;
      const block = blocks.get(key);
      if (!block) invalidCar();
      visited.add(key);
      queue.push(...blockLinks(cid, block));
    }
    if (visited.size !== blocks.size) invalidCar();
    return { root, blocks };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof CliError) throw error;
    return invalidCar();
  }
}

interface RestoredFile {
  parts: string[];
  bytes: Uint8Array<ArrayBuffer>;
}

interface Restored {
  type: "file" | "directory";
  files: RestoredFile[];
  directories: string[][];
  size: number;
}

function portableName(name: string): boolean {
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

function safeName(name: string): void {
  if (!portableName(name))
    throw new CliError(
      "UNSAFE_PATH",
      "The DAG contains an unsafe or non-portable filename. Use export to keep it as a CAR.",
    );
}

export function pinFilename(name: string, car: boolean): string {
  const filename = car && !/\.car$/iu.test(name) ? `${name}.car` : name;
  if (
    !portableName(name) ||
    !portableName(filename) ||
    Buffer.byteLength(filename) > 255
  )
    throw new CliError(
      "UNSAFE_PIN_NAME",
      "Pin name is not a safe local filename; use --output to choose a path.",
    );
  return filename;
}

async function restore(dag: Dag, signal: AbortSignal): Promise<Restored> {
  const store: ReadableStorage = {
    *get(cid) {
      signal.throwIfAborted();
      const bytes = dag.blocks.get(cid.toV1().toString());
      if (!bytes) return invalidCar();
      yield bytes;
    },
  };
  const files: RestoredFile[] = [];
  const directories: string[][] = [];
  const paths = new Set<string>();
  let total = 0;
  let entries = 0;
  async function walk(entry: UnixFSEntry, parts: string[]): Promise<void> {
    signal.throwIfAborted();
    if (++entries > 10000 || parts.length > 256)
      throw new CliError(
        "OUTPUT_LIMIT",
        "Restored tree exceeds the entry or depth limit.",
      );
    if (entry.type === "directory") {
      directories.push(parts);
      for await (const child of entry.entries({ signal })) {
        signal.throwIfAborted();
        safeName(child.name);
        const path = [...parts, child.name];
        const key = path.join("/").normalize("NFC").toLowerCase();
        if (paths.has(key))
          throw new CliError(
            "UNSAFE_PATH",
            "The DAG contains conflicting output paths.",
          );
        paths.add(key);
        await walk(await exporter(child.cid, store, { signal }), path);
      }
    } else if (entry.type === "file" || entry.type === "raw") {
      if (entry.size < 0n || entry.size > BigInt(uploadLimits.maxBytes - total))
        throw new CliError("OUTPUT_LIMIT", "Restored files exceed 32 MiB.");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of entry.content({
        signal,
        blockReadConcurrency: 1,
      })) {
        signal.throwIfAborted();
        size += chunk.length;
        total += chunk.length;
        if (total > uploadLimits.maxBytes || BigInt(size) > entry.size)
          throw new CliError(
            "OUTPUT_LIMIT",
            "Restored files exceed their size limit.",
          );
        chunks.push(chunk);
      }
      if (BigInt(size) !== entry.size)
        throw new CliError(
          "INVALID_UNIXFS",
          "File content does not match its declared size.",
        );
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      files.push({ parts, bytes });
    } else {
      throw new CliError(
        "UNSUPPORTED_CONTENT",
        "download requires a raw file or UnixFS file/directory. Use export for other IPLD DAGs.",
      );
    }
  }
  try {
    const root = await exporter(dag.root, store, { signal });
    await walk(root, []);
    return {
      type: root.type === "directory" ? "directory" : "file",
      files,
      directories,
      size: total,
    };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof CliError) throw error;
    throw new CliError(
      "INVALID_UNIXFS",
      "Cannot restore this DAG as files and directories. Use export to keep it as a CAR.",
    );
  }
}

async function available(path: string): Promise<void> {
  await noLinks(path);
  try {
    await lstat(path);
  } catch (error) {
    if (missing(error)) {
      const parent = await lstat(dirname(path));
      if (!parent.isDirectory())
        throw new CliError(
          "OUTPUT_PATH",
          "The output parent must be an existing directory.",
        );
      return;
    }
    throw error;
  }
  throw new CliError(
    "OUTPUT_EXISTS",
    "Output already exists; choose a new --output path.",
  );
}

async function writeExclusive(
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new CliError(
        "OUTPUT_EXISTS",
        "Output already exists; choose a new --output path.",
      );
    throw error;
  }
  const created = await file.stat({ bigint: true });
  try {
    await file.writeFile(bytes, { signal });
    await file.sync();
    signal.throwIfAborted();
  } catch (error) {
    await file.close();
    const current = await lstat(path, { bigint: true });
    if (sameFileIdentity(created, current)) await rm(path);
    throw error;
  }
  await file.close();
}

export interface SavedContent {
  cid: string;
  path: string;
  type: "file" | "directory" | "car";
  size: number;
}

export async function saveContent(
  bytes: Uint8Array<ArrayBuffer>,
  cid: string,
  output: string | undefined,
  car: boolean,
  signal: AbortSignal,
): Promise<SavedContent> {
  const path = resolve(output ?? `${cid}${car ? ".car" : ""}`);
  await available(path);
  const dag = await verifyCar(bytes, cid, signal);
  if (car) {
    await writeExclusive(path, bytes, signal);
    return { cid, path, type: "car", size: bytes.length };
  }
  const restored = await restore(dag, signal);
  if (restored.type === "file") {
    await writeExclusive(path, restored.files[0]!.bytes, signal);
  } else {
    signal.throwIfAborted();
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        throw new CliError(
          "OUTPUT_EXISTS",
          "Output already exists; choose a new --output path.",
        );
      throw error;
    }
    const created = await lstat(path, { bigint: true });
    try {
      for (const parts of restored.directories.slice(1)) {
        signal.throwIfAborted();
        await noLinks(path);
        await mkdir(join(path, ...parts), { mode: 0o700 });
      }
      for (const file of restored.files) {
        signal.throwIfAborted();
        const target = join(path, ...file.parts);
        await noLinks(target);
        await writeExclusive(target, file.bytes, signal);
      }
      signal.throwIfAborted();
    } catch (error) {
      const current = await lstat(path, { bigint: true });
      if (sameFileIdentity(created, current) && !current.isSymbolicLink())
        await rm(path, { recursive: true });
      throw error;
    }
  }
  return { cid, path, type: restored.type, size: restored.size };
}
