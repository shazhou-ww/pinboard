import {
  exporter,
  type ReadableStorage,
  type UnixFSEntry,
} from "ipfs-unixfs-exporter";
import { key, parseCid, verifyBlock, MAX_BLOCK } from "./content.js";
import { getBlock } from "./storage.js";
import type { Bindings } from "./env.js";
import { PreviewLimit } from "./preview-limits.js";
import {
  checkRange,
  MAX_PDF_SIZE,
  type PreviewFileSource,
} from "./preview-file.js";
export const MAX_BLOCK_BYTES = 12 * 1024 * 1024;
const readError = (reason: unknown): Error =>
  reason instanceof Error
    ? reason
    : new Error(
        typeof reason === "string" ? reason : "Preview source read aborted",
        { cause: reason },
      );

function awaitBlock(
  pending: ReturnType<typeof getBlock>,
  signal: AbortSignal,
): ReturnType<typeof getBlock> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(readError(signal.reason));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(
      (block) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          void block?.body.cancel().catch(() => undefined);
          reject(readError(signal.reason));
        } else {
          resolve(block);
        }
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(readError(error));
      },
    );
  });
}

export function createPreviewStore(
  env: Pick<Bindings, "DB" | "BLOCKS">,
  signal: AbortSignal,
) {
  const cache = new Map<string, Promise<Uint8Array>>();
  const stats = { reads: 0, bytes: 0, cachedBlocks: 0 };
  const store: ReadableStorage = {
    async *get(cid) {
      signal.throwIfAborted();
      const id = key(cid);
      let promise = cache.get(id);
      if (!promise) {
        promise = (async () => {
          if (++stats.reads > 64)
            throw new PreviewLimit("Preview exceeds 64 block reads");
          const block = await awaitBlock(getBlock(env, id), signal);
          if (!block) throw new Error("Preview source block is unavailable");
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          try {
            signal.throwIfAborted();
            if (
              !Number.isSafeInteger(block.size) ||
              block.size < 0 ||
              block.size > MAX_BLOCK_BYTES - stats.bytes
            )
              throw new PreviewLimit("Preview exceeds 12 MiB block budget");
            if (block.size > MAX_BLOCK)
              throw new PreviewLimit("Preview block exceeds 2 MiB");
            stats.bytes += block.size;
            const bytes = new Uint8Array(block.size);
            reader = block.body.getReader();
            const cancel = () => {
              void reader?.cancel(signal.reason).catch(() => undefined);
            };
            signal.addEventListener("abort", cancel, { once: true });
            try {
              let written = 0;
              for (;;) {
                signal.throwIfAborted();
                const chunk = await reader.read();
                signal.throwIfAborted();
                if (chunk.done) break;
                if (chunk.value.length > bytes.length - written)
                  throw new Error("Preview block length mismatch");
                bytes.set(chunk.value, written);
                written += chunk.value.length;
              }
              if (written !== block.size)
                throw new Error("Preview block length mismatch");
              await verifyBlock(parseCid(id), bytes);
              signal.throwIfAborted();
              stats.cachedBlocks++;
              return bytes;
            } finally {
              signal.removeEventListener("abort", cancel);
            }
          } finally {
            if (reader) {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            } else {
              await block.body.cancel().catch(() => undefined);
            }
          }
        })();
        cache.set(id, promise);
      }
      yield await promise;
    },
  };
  return {
    store,
    stats,
    open: (cid: string) => exporter(parseCid(cid), store),
    clear() {
      cache.clear();
      stats.cachedBlocks = 0;
    },
  };
}

export function previewFileSource(
  root: UnixFSEntry,
  signal: AbortSignal,
  maximum = MAX_PDF_SIZE,
): PreviewFileSource {
  if (root.type !== "file" && root.type !== "raw")
    throw new Error("Expected a file");
  if (root.size < 0n || root.size > BigInt(maximum))
    throw new PreviewLimit("PDF exceeds 32 MiB logical file limit");
  const size = Number(root.size);
  return {
    size,
    async readAt(offset, length) {
      checkRange(size, offset, length);
      signal.throwIfAborted();
      const output = new Uint8Array(length);
      let written = 0;
      for await (const bytes of root.content({
        offset,
        length,
        blockReadConcurrency: 1,
      })) {
        signal.throwIfAborted();
        if (bytes.length > length - written)
          throw new Error("UnixFS range length mismatch");
        output.set(bytes, written);
        written += bytes.length;
      }
      if (written !== length) throw new Error("UnixFS range length mismatch");
      return output;
    },
  };
}
