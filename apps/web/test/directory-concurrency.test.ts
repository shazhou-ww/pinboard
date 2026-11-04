import { CarReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it, vi } from "vitest";
import type * as Contracts from "@shazhou/pinboard-contracts";

const scenario = vi.hoisted(() => ({ overflow: false }));
vi.mock("@shazhou/pinboard-contracts", async (original) => {
  const actual = await original<typeof Contracts>();
  return {
    ...actual,
    uploadLimits: { ...actual.uploadLimits, maxBytes: 1600, maxBlocks: 2 },
  };
});
vi.mock("ipfs-unixfs-importer", () => ({
  importer: async function* (
    _source: unknown,
    store: { put: (cid: CID, bytes: Uint8Array) => Promise<unknown> },
  ) {
    const bytes = new Uint8Array(1024).fill(1);
    const first = CID.createV1(0x55, await sha256.digest(bytes));
    const extra = new Uint8Array([2]);
    const second = CID.createV1(0x55, await sha256.digest(extra));
    const directory = dagPb.encode({
      Data: new Uint8Array([8, 1]),
      Links: [
        { Hash: first, Name: "first" },
        ...(scenario.overflow ? [{ Hash: second, Name: "second" }] : []),
      ],
    });
    const root = CID.createV1(dagPb.code, await sha256.digest(directory));
    if (scenario.overflow) {
      await Promise.all([
        store.put(first, bytes),
        store.put(second, extra),
        store.put(root, directory),
      ]);
    } else {
      await Promise.all([store.put(first, bytes), store.put(first, bytes)]);
      await store.put(root, directory);
    }
    yield { path: "", cid: root };
  },
}));

import { buildDirectoryCar } from "../src/directory.js";
import { selectionForDirectory } from "../src/uploads.js";

describe("concurrent directory block puts", () => {
  it("counts a concurrently written duplicate CID only once", async () => {
    scenario.overflow = false;
    const archive = await buildDirectoryCar(
      selectionForDirectory([
        { path: "root/input", file: new File([], "input") },
      ]),
    );
    const reader = await CarReader.fromBytes(
      new Uint8Array(await archive.arrayBuffer()),
    );
    const ids: string[] = [];
    for await (const block of reader.blocks()) ids.push(block.cid.toString());
    expect(ids).toHaveLength(2);
    expect(archive.size).toBeLessThan(1600);
  });
  it("does not allow concurrent writes to exceed the unique-block limit", async () => {
    scenario.overflow = true;
    await expect(
      buildDirectoryCar(
        selectionForDirectory([
          { path: "root/input", file: new File([], "input") },
        ]),
      ),
    ).rejects.toThrow("2 IPFS blocks");
  });
});
