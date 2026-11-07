import { beforeEach, expect, it, vi } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { exporter, type UnixFSEntry } from "ipfs-unixfs-exporter";
import * as dagPb from "@ipld/dag-pb";
import {
  createPreviewStore,
  previewFileSource,
  MAX_BLOCK_BYTES,
} from "../src/preview-source.js";
import { checkRange, MAX_PDF_SIZE } from "../src/preview-file.js";
import { getBlock } from "../src/storage.js";
import { importFile, key } from "../src/content.js";
import type { Bindings } from "../src/env.js";

vi.mock("../src/storage.js", () => ({ getBlock: vi.fn() }));
const env = {} as Bindings;
const bytes = new TextEncoder().encode("%PDF-1.7\nbounded source");
const cid = CID.createV1(0x55, await sha256.digest(bytes));
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.mocked(getBlock).mockReset();
});
async function get(store: ReturnType<typeof createPreviewStore>, link = cid) {
  const chunks = [];
  for await (const bytes of store.store.get(link)) chunks.push(bytes);
  return chunks[0];
}
it("shares in-flight verified block promises and releases the request cache", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(getBlock).mockImplementation(async () => {
    await waiting;
    return { size: bytes.length, body: new Blob([bytes]).stream() };
  });
  const source = createPreviewStore(env, signal());
  const first = get(source),
    second = get(source);
  release();
  expect(await first).toEqual(bytes);
  expect(await second).toBe(await first);
  expect(getBlock).toHaveBeenCalledTimes(1);
  expect(source.stats).toEqual({
    reads: 1,
    bytes: bytes.length,
    cachedBlocks: 1,
  });
  source.clear();
  expect(source.stats.cachedBlocks).toBe(0);
});
it("reserves declared bytes before consuming a stream and cancels rejected bodies", async () => {
  for (const size of [MAX_BLOCK_BYTES + 1, 2 * 1024 * 1024 + 1, -1, NaN, 1.5]) {
    const cancel = vi.fn();
    const pull = vi.fn();
    vi.mocked(getBlock).mockResolvedValueOnce({
      size,
      body: new ReadableStream({ pull, cancel }, { highWaterMark: 0 }),
    });
    await expect(get(createPreviewStore(env, signal()))).rejects.toThrow(
      /budget|2 MiB/u,
    );
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  }
});
it("bounds cumulative physical bytes and read counts including failed or unique reads", async () => {
  const block = new Uint8Array(1024 * 1024);
  vi.mocked(getBlock).mockImplementation(() => {
    return Promise.resolve({
      size: block.length,
      body: new Blob([block.slice()]).stream(),
    });
  });
  const source = createPreviewStore(env, signal());
  for (let index = 0; index < 12; index++) {
    const value = new Uint8Array(1024 * 1024);
    value[0] = index;
    const link = CID.createV1(0x55, await sha256.digest(value));
    vi.mocked(getBlock).mockResolvedValueOnce({
      size: value.length,
      body: new Blob([value]).stream(),
    });
    await get(source, link);
  }
  const overflow = CID.createV1(
    0x55,
    await sha256.digest(new Uint8Array([99])),
  );
  await expect(get(source, overflow)).rejects.toThrow("12 MiB");
  expect(source.stats.bytes).toBe(MAX_BLOCK_BYTES);
  const many = createPreviewStore(env, signal());
  for (let index = 0; index < 64; index++) {
    const value = new Uint8Array([index]);
    const link = CID.createV1(0x55, await sha256.digest(value));
    vi.mocked(getBlock).mockResolvedValueOnce({
      size: 1,
      body: new Blob([value]).stream(),
    });
    await get(many, link);
  }
  await expect(get(many, overflow)).rejects.toThrow("64 block reads");
});
it("rejects unavailable, corrupt and short/overlong blocks and aborted I/O", async () => {
  vi.mocked(getBlock).mockResolvedValueOnce(null);
  await expect(get(createPreviewStore(env, signal()))).rejects.toThrow(
    "unavailable",
  );
  for (const [size, body] of [
    [bytes.length, bytes.slice(0, -1)],
    [1, bytes],
    [bytes.length, new Uint8Array(bytes.length)],
  ] as const) {
    vi.mocked(getBlock).mockResolvedValueOnce({
      size,
      body: new Blob([body]).stream(),
    });
    await expect(get(createPreviewStore(env, signal()))).rejects.toThrow(
      /length|match/u,
    );
  }
  const controller = new AbortController();
  const cancel = vi.fn();
  vi.mocked(getBlock).mockResolvedValueOnce({
    size: 1,
    body: new ReadableStream({
      pull() {
        controller.abort(new Error("deadline"));
      },
      cancel,
    }),
  });
  await expect(get(createPreviewStore(env, controller.signal))).rejects.toThrow(
    "deadline",
  );
  expect(cancel).toHaveBeenCalled();
  await expect(get(createPreviewStore(env, controller.signal))).rejects.toThrow(
    "deadline",
  );
});
it("releases a deadline while block metadata is stalled and cancels any late body without allocating it", async () => {
  let release!: (block: {
    size: number;
    body: ReadableStream<Uint8Array>;
  }) => void;
  const pending = new Promise<{
    size: number;
    body: ReadableStream<Uint8Array>;
  }>((resolve) => {
    release = resolve;
  });
  vi.mocked(getBlock).mockReturnValueOnce(pending);
  const controller = new AbortController();
  const source = createPreviewStore(env, controller.signal);
  const reading = get(source);
  controller.abort(new Error("metadata deadline"));
  await expect(reading).rejects.toThrow("metadata deadline");
  source.clear();
  const cancel = vi.fn(),
    pull = vi.fn();
  release({
    size: MAX_BLOCK_BYTES,
    body: new ReadableStream({ cancel, pull }, { highWaterMark: 0 }),
  });
  await pending;
  await Promise.resolve();
  expect(cancel).toHaveBeenCalledOnce();
  expect(pull).not.toHaveBeenCalled();
  expect(source.stats).toEqual({ reads: 1, bytes: 0, cachedBlocks: 0 });
});
it("reads exact UnixFS ranges using one block cache", async () => {
  const input = new Uint8Array(700000).map((_, index) => index % 251);
  const dag = await importFile(input);
  vi.mocked(getBlock).mockImplementation((_env, id) => {
    const block = dag.blocks.get(id)!;
    return Promise.resolve({
      size: block.length,
      body: new Blob([block.slice()]).stream(),
    });
  });
  const cache = createPreviewStore(env, signal());
  const source = previewFileSource(await cache.open(key(dag.root)), signal());
  expect(source.size).toBe(input.length);
  expect(await source.readAt(250000, 40000)).toEqual(
    input.slice(250000, 290000),
  );
  expect(await source.readAt(0, 0)).toEqual(new Uint8Array());
  for (const [offset, length] of [
    [-1, 1],
    [0, -1],
    [0.5, 1],
    [source.size, 1],
    [Number.MAX_SAFE_INTEGER, 1],
  ]) {
    await expect(source.readAt(offset!, length!)).rejects.toThrow("range");
  }
});
it("checks bigint logical size independently of deduplicated DAG byte size", async () => {
  const leaf = new Uint8Array(1024 * 1024);
  const leafCid = CID.createV1(0x55, await sha256.digest(leaf));
  const varint = (n: number) => {
    const bytes: number[] = [];
    do {
      bytes.push((n % 128) | (n >= 128 ? 128 : 0));
      n = Math.floor(n / 128);
    } while (n);
    return bytes;
  };
  const data = Uint8Array.from([
    8,
    2,
    24,
    ...varint(64 * leaf.length),
    ...Array.from({ length: 64 }, () => [32, ...varint(leaf.length)]).flat(),
  ]);
  const block = dagPb.encode({
    Data: data,
    Links: Array.from({ length: 64 }, () => ({
      Hash: leafCid,
      Tsize: leaf.length,
      Name: "",
    })),
  });
  const rootCid = CID.createV1(dagPb.code, await sha256.digest(block));
  const root = await exporter(rootCid, {
    async *get(cid) {
      yield await Promise.resolve(cid.equals(rootCid) ? block : leaf);
    },
  });
  expect(root.size).toBe(64n * 1024n * 1024n);
  expect(block.length + leaf.length).toBeLessThan(2 * 1024 * 1024);
  expect(() => previewFileSource(root, signal())).toThrow("32 MiB logical");
  expect(() =>
    previewFileSource({ type: "directory" } as UnixFSEntry, signal()),
  ).toThrow("Expected a file");
  expect(() => {
    checkRange(MAX_PDF_SIZE, 0, MAX_PDF_SIZE);
  }).not.toThrow();
});
