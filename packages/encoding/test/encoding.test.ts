import { CarReader } from "@ipld/car";
import { uploadLimits } from "@workspace/contracts";
import { describe, expect, it } from "vitest";
import { buildDirectoryCar, directoryPaths } from "../src/index.js";

async function* bytes(value: Uint8Array) {
  yield await Promise.resolve(value);
}
const entry = (path = "a", value = new Uint8Array([0, 255])) => ({
  path,
  size: value.length,
  content: bytes(value),
});

describe("environment-independent directory encoding", () => {
  it("sorts normalized paths, retains empty/binary files and deduplicates blocks", async () => {
    const first = await buildDirectoryCar([
      entry("sub/文件"),
      entry(".hidden"),
      entry("empty", new Uint8Array()),
    ]);
    const second = await buildDirectoryCar([
      entry("empty", new Uint8Array()),
      entry(".hidden"),
      entry("sub/文件"),
    ]);
    expect(first.root).toBe(second.root);
    const reader = await CarReader.fromBytes(first.bytes);
    expect((await reader.getRoots())[0]!.toString()).toBe(first.root);
    const all = [];
    for await (const block of reader.blocks()) all.push(block.bytes);
    expect(all.some((value) => value.length === 0)).toBe(true);
    expect(
      all.filter((value) => value.length === 2 && value[1] === 255),
    ).toHaveLength(1);
  });

  it.each(["", "/a", "a/", "a//b", ".", "..", "a/../b", "a\\b", "a\0b"])(
    "rejects unsafe path %j",
    (path) => {
      expect(() => directoryPaths([entry(path)])).toThrow("paths");
    },
  );
  it("rejects empty selection, collisions, duplicates and input limits", () => {
    expect(() => directoryPaths([])).toThrow("Empty folders");
    expect(() => directoryPaths([entry(), entry()])).toThrow("Duplicate");
    expect(() => directoryPaths([entry(), entry("a/b")])).toThrow("conflicts");
    for (const size of [-1, NaN, uploadLimits.maxBytes + 1])
      expect(() => directoryPaths([{ ...entry(), size }])).toThrow("32 MiB");
  });

  it("rejects changed streams and respects cancellation", async () => {
    await expect(buildDirectoryCar([{ ...entry(), size: 1 }])).rejects.toThrow(
      "changed",
    );
    await expect(buildDirectoryCar([{ ...entry(), size: 3 }])).rejects.toThrow(
      "changed",
    );
    await expect(
      buildDirectoryCar([entry()], AbortSignal.abort(new Error("cancelled"))),
    ).rejects.toThrow("cancelled");
  });

  it("enforces unique-block limits without imposing a file-count limit", async () => {
    const repeated = Array.from({ length: 300 }, (_, i) => entry(`a${i}`));
    await expect(buildDirectoryCar(repeated)).resolves.toHaveProperty("root");
    const distinct = Array.from({ length: uploadLimits.maxBlocks }, (_, i) =>
      entry(`a${i}`, new TextEncoder().encode(String(i))),
    );
    await expect(buildDirectoryCar(distinct)).rejects.toThrow(
      "256 IPFS blocks",
    );
  });

  it("enforces DAG and archive overhead limits", async () => {
    const random = (size: number) => {
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i += 65536)
        crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, size)));
      return entry("large", data);
    };
    await expect(
      buildDirectoryCar([random(uploadLimits.maxBytes)]),
    ).rejects.toThrow("Folder DAG exceeds");
    await expect(
      buildDirectoryCar([random(uploadLimits.maxBytes - 9000)]),
    ).rejects.toThrow("Folder archive exceeds");
  }, 30000);
});
