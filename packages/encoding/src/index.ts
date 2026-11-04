import {
  createWriter,
  blockLength,
  headerLength,
} from "@ipld/car/buffer-writer";
import { uploadLimits } from "@shazhou/pinboard-contracts";
import { importer } from "ipfs-unixfs-importer";
import { CID } from "multiformats/cid";

export interface DirectoryEntry {
  readonly path: string;
  readonly size: number;
  readonly content: AsyncIterable<Uint8Array>;
}

export function directoryPaths<
  T extends { readonly path: string; readonly size: number },
>(entries: readonly T[]): T[] {
  if (!entries.length)
    throw new Error("No readable files found. Empty folders are not included.");
  const paths = new Set<string>();
  const directories = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const parts = entry.path.split("/");
    if (
      parts.some((part) => !part || part === "." || part === "..") ||
      entry.path.includes("\\") ||
      entry.path.includes("\0")
    )
      throw new Error("Folder paths are invalid or unavailable.");
    if (paths.has(entry.path))
      throw new Error(`Duplicate folder path: ${entry.path}`);
    paths.add(entry.path);
    for (let index = 1; index < parts.length; index++)
      directories.add(parts.slice(0, index).join("/"));
    total += entry.size;
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      !Number.isSafeInteger(total) ||
      total > uploadLimits.maxBytes
    )
      throw new Error("Choose a file or folder totaling no more than 32 MiB.");
  }
  for (const path of paths)
    if (directories.has(path))
      throw new Error(`A file conflicts with a folder: ${path}`);
  return [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

export async function buildDirectoryCar(
  entries: readonly DirectoryEntry[],
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; root: string }> {
  const files = directoryPaths(entries);
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  let root: CID | undefined;
  let total = 0;
  async function* content(entry: DirectoryEntry) {
    let size = 0;
    for await (const chunk of entry.content) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > entry.size) throw new Error("File changed while reading.");
      yield chunk;
    }
    if (size !== entry.size) throw new Error("File changed while reading.");
  }
  for await (const entry of importer(
    files.map((file) => ({ path: file.path, content: content(file) })),
    {
      put: async (cid, input) => {
        signal?.throwIfAborted();
        const normalized = CID.parse(cid.toString());
        const id = normalized.toString();
        if (blocks.has(id)) return cid;
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const chunk of input instanceof Uint8Array
          ? [input]
          : input) {
          signal?.throwIfAborted();
          length += chunk.length;
          if (length > uploadLimits.maxBlockBytes)
            throw new Error("A folder block exceeds 2 MiB.");
          chunks.push(chunk);
        }
        if (blocks.has(id)) return cid;
        if (blocks.size >= uploadLimits.maxBlocks)
          throw new Error(
            `Folder exceeds the limit of ${uploadLimits.maxBlocks} IPFS blocks.`,
          );
        total += length;
        if (total > uploadLimits.maxBytes)
          throw new Error("Folder DAG exceeds 32 MiB.");
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        blocks.set(id, { cid: normalized, bytes });
        return cid;
      },
    },
    { cidVersion: 1, rawLeaves: true, wrapWithDirectory: true },
  )) {
    signal?.throwIfAborted();
    if (entry.path === "") root = CID.parse(entry.cid.toString());
  }
  if (!root) throw new Error("Could not build a complete folder DAG.");
  const roots = [root];
  const length =
    headerLength({ roots }) +
    [...blocks.values()].reduce((size, block) => size + blockLength(block), 0);
  if (length > uploadLimits.maxBytes)
    throw new Error(
      "Folder archive exceeds 32 MiB, including directory metadata. Choose a smaller folder.",
    );
  const buffer = new ArrayBuffer(length);
  const writer = createWriter(buffer, { roots });
  for (const block of blocks.values()) writer.write(block);
  writer.close();
  return { bytes: new Uint8Array(buffer), root: root.toString() };
}
