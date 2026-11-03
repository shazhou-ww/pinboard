import { CarReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import { uploadLimits } from "@workspace/contracts";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it } from "vitest";
import { buildDirectoryCar } from "../src/directory.js";
import { selectionForDirectory } from "../src/uploads.js";

async function archive(entries: { path: string; file: File }[]) {
  const blob = await buildDirectoryCar(selectionForDirectory(entries));
  const reader = await CarReader.fromBytes(
    new Uint8Array(await blob.arrayBuffer()),
  );
  return { blob, reader };
}

function randomFile(size: number): File {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536) {
    crypto.getRandomValues(
      bytes.subarray(offset, Math.min(offset + 65536, size)),
    );
  }
  return new File([bytes], "large.bin");
}

describe("browser directory CAR encoding", () => {
  it("produces one directory root, preserving nested names, empty files and exact bytes", async () => {
    const { blob, reader } = await archive([
      {
        path: "root/sub/\u6587\u4ef6.txt",
        file: new File(["hello"], "note.txt"),
      },
      { path: "root/empty.txt", file: new File([], "empty.txt") },
      { path: "root/copy.txt", file: new File(["hello"], "copy.txt") },
    ]);
    expect(blob.type).toBe("application/vnd.ipld.car");
    const roots = await reader.getRoots();
    expect(roots).toHaveLength(1);
    const root = await reader.get(roots[0]!);
    expect(root).toBeDefined();
    const directory = dagPb.decode(root!.bytes);
    expect(directory.Data?.slice(0, 2)).toEqual(new Uint8Array([8, 1]));
    expect(directory.Links.map((link) => link.Name)).toEqual([
      "copy.txt",
      "empty.txt",
      "sub",
    ]);
    const sub = directory.Links.find((link) => link.Name === "sub")!;
    const nested = dagPb.decode(
      (await reader.get(CID.parse(sub.Hash.toString())))!.bytes,
    );
    expect(nested.Links[0]!.Name).toBe("\u6587\u4ef6.txt");
    const hello = await reader.get(CID.parse(nested.Links[0]!.Hash.toString()));
    expect(new TextDecoder().decode(hello!.bytes)).toBe("hello");
    const empty = await reader.get(
      CID.parse(
        directory.Links.find(
          (link) => link.Name === "empty.txt",
        )!.Hash.toString(),
      ),
    );
    expect(empty!.bytes).toHaveLength(0);
    let count = 0;
    for await (const block of reader.blocks()) {
      count++;
      expect(
        CID.createV1(block.cid.code, await sha256.digest(block.bytes)).equals(
          block.cid,
        ),
      ).toBe(true);
    }
    expect(count).toBe(4);
  });
  it("is deterministic across selection order and selected root-directory names", async () => {
    const files = [new File(["a"], "a"), new File(["b"], "b")];
    const first = await archive([
      { path: "one/b", file: files[1]! },
      { path: "one/a", file: files[0]! },
    ]);
    const second = await archive([
      { path: "two/a", file: files[0]! },
      { path: "two/b", file: files[1]! },
    ]);
    expect((await first.reader.getRoots())[0]!.toString()).toBe(
      (await second.reader.getRoots())[0]!.toString(),
    );
  });
  it("keeps a single-file selection inside a directory rather than flattening its root", async () => {
    const { reader } = await archive([
      { path: "root/one.txt", file: new File(["one"], "one.txt") },
    ]);
    const root = (await reader.getRoots())[0]!;
    expect(root.code).toBe(dagPb.code);
    expect(dagPb.decode((await reader.get(root))!.bytes).Links[0]!.Name).toBe(
      "one.txt",
    );
  });
  it("enforces the existing unique-block limit before upload", async () => {
    const entries = Array.from(
      { length: uploadLimits.maxBlocks },
      (_, index) => ({
        path: `root/${String(index).padStart(3, "0")}.txt`,
        file: new File([String(index)], `${index}.txt`),
      }),
    );
    await expect(
      buildDirectoryCar(selectionForDirectory(entries)),
    ).rejects.toThrow("256 IPFS blocks");
  });
  it("accepts a near-limit archive and rejects oversized DAG and CAR metadata", async () => {
    const accepted = await archive([
      {
        path: "root/large.bin",
        file: randomFile(uploadLimits.maxBytes - 16000),
      },
    ]);
    expect(accepted.blob.size).toBeLessThanOrEqual(uploadLimits.maxBytes);
    expect(accepted.blob.size).toBeGreaterThan(uploadLimits.maxBytes - 16000);
    await expect(
      buildDirectoryCar(
        selectionForDirectory([
          { path: "root/large.bin", file: randomFile(uploadLimits.maxBytes) },
        ]),
      ),
    ).rejects.toThrow("Folder DAG exceeds");
    await expect(
      buildDirectoryCar(
        selectionForDirectory([
          {
            path: "root/large.bin",
            file: randomFile(uploadLimits.maxBytes - 9000),
          },
        ]),
      ),
    ).rejects.toThrow("Folder archive exceeds");
  }, 30000);
});
