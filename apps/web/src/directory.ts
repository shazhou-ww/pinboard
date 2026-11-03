import {
  createWriter,
  blockLength,
  headerLength,
} from "@ipld/car/buffer-writer";
import { uploadLimits } from "@workspace/contracts";
import { importer } from "ipfs-unixfs-importer";
import { CID } from "multiformats/cid";
import type { DirectorySelection } from "./uploads.js";

async function* content(file: File): AsyncGenerator<Uint8Array> {
  const reader = file.stream().getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function buildDirectoryCar(
  selection: DirectorySelection,
): Promise<Blob> {
  const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
  let root: CID | undefined;
  let total = 0;
  for await (const entry of importer(
    selection.files.map(({ path, file }) => ({ path, content: content(file) })),
    {
      put: async (cid, input) => {
        const normalized = CID.parse(cid.toString());
        const id = normalized.toString();
        if (blocks.has(id)) return cid;
        const chunks: Uint8Array[] = [];
        let length = 0;
        for await (const chunk of input instanceof Uint8Array
          ? [input]
          : input) {
          length += chunk.length;
          if (length > uploadLimits.maxBlockBytes)
            throw new Error("A folder block exceeds 2 MiB.");
          chunks.push(chunk);
        }
        // Other concurrent puts may have stored this CID while its bytes were read.
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
  return new Blob([buffer], { type: "application/vnd.ipld.car" });
}
