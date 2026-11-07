import { expect, it, vi } from "vitest";
import {
  PdfData,
  MAX_PDF_CACHE,
  MAX_PDF_ROUNDS,
} from "../src/preview-pdf-data.js";

function data(size = 10000000) {
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 4 });
  const readAt = vi.fn((_offset: number, length: number) =>
    Promise.resolve(new Uint8Array(length).fill(42)),
  );
  const cache = new PdfData(
    { size, readAt },
    memory,
    new AbortController().signal,
  );
  return { memory, readAt, cache };
}
it("copies only complete cached windows, bounds native destinations and clears all windows", async () => {
  const { cache, memory, readAt } = data(100000);
  expect(cache.available(10, 65536)).toBe(0);
  expect(() => cache.read(10, 0, 65536)).toThrow("uncached synchronous");
  cache.hint(10, 65536);
  cache.hint(20, 1);
  await cache.fill();
  expect(readAt).toHaveBeenCalledTimes(2);
  expect(cache.available(10, 65536)).toBe(1);
  expect(cache.available(100000, 0)).toBe(1);
  expect(cache.read(10, 8, 65536)).toBe(1);
  expect(
    new Uint8Array(memory.buffer, 8, 65536).every((byte) => byte === 42),
  ).toBe(true);
  expect(() => cache.read(10, memory.buffer.byteLength - 1, 2)).toThrow(
    "range",
  );
  cache.hint(20, 1);
  await cache.fill();
  expect(readAt).toHaveBeenCalledTimes(2);
  cache.clear();
  expect(cache.stats.windows).toBe(0);
  expect(cache.available(10, 1)).toBe(0);
});
it("bounds all availability rounds, aggregate windows, hint ranges and logical cache bytes", async () => {
  const { cache, readAt } = data();
  let round = 0;
  await expect(
    cache.untilAvailable(() => {
      cache.hint(round++ * 65536, 1);
      return 0;
    }),
  ).rejects.toThrow("64 availability rounds");
  expect(readAt).toHaveBeenCalledTimes(MAX_PDF_ROUNDS);
  const full = data(MAX_PDF_CACHE + 1);
  full.cache.hint(0, MAX_PDF_CACHE + 1);
  await expect(full.cache.fill()).rejects.toThrow("8 MiB logical cache");
  expect(full.readAt).toHaveBeenCalledTimes(MAX_PDF_CACHE / 65536);
  expect(() => {
    full.cache.hint(1, MAX_PDF_CACHE + 1);
  }).toThrow("range");
});
it("rejects no-progress, malformed availability and callback failures instead of returning partial success", async () => {
  await expect(data().cache.untilAvailable(() => 0)).rejects.toThrow(
    "no progress",
  );
  await expect(data().cache.untilAvailable(() => -1)).rejects.toThrow(
    "damaged",
  );
  await expect(data().cache.untilAvailable(() => 1)).resolves.toBeUndefined();
  const { cache } = data();
  await expect(
    cache.untilAvailable(() => {
      cache.error = new Error("uncached synchronous callback");
      return 1;
    }),
  ).rejects.toThrow("uncached synchronous callback");
});
