import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagPb from "@ipld/dag-pb";
import * as dagCbor from "@ipld/dag-cbor";
import { CarWriter } from "@ipld/car";
import {
  boundedBody,
  completeDag,
  importFile,
  key,
  links,
  MAX_BLOCK,
  MAX_BLOCKS,
  MAX_UPLOAD,
  parseCid,
  readCar,
  verifyBlock,
} from "../src/content.js";
import { encodeCar } from "../src/car.js";
import { jsonBody, nameSchema, validate } from "../src/schemas.js";

const bytes = new Uint8Array([1, 2, 3]);
const cid = CID.createV1(0x55, await sha256.digest(bytes));
async function carWith(
  roots: CID[],
  blocks: { cid: CID; bytes: Uint8Array }[],
): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create(roots);
  const writing = (async () => {
    for (const block of blocks) await writer.put(block);
    await writer.close();
  })();
  const chunks: Uint8Array[] = [];
  for await (const chunk of out) chunks.push(chunk);
  await writing;
  const data = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

describe("bounded and verified IPLD", () => {
  it("normalizes CIDv0 and rejects invalid CIDs", () => {
    expect(parseCid(CID.createV0(cid.multihash).toString()).version).toBe(1);
    expect(() => parseCid("bad")).toThrow("Invalid CID");
    expect(() => validate(nameSchema, "")).toThrow();
  });
  it("validates exact digest, codec, hash and block-size constraints", async () => {
    await verifyBlock(cid, bytes);
    await expect(verifyBlock(cid, new Uint8Array([4]))).rejects.toThrow(
      "do not match",
    );
    await expect(
      verifyBlock(cid, new Uint8Array(MAX_BLOCK + 1)),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      verifyBlock(CID.createV1(999, cid.multihash), bytes),
    ).rejects.toThrow("Supported");
    const identity = parseCid("bafkqaaa");
    await expect(verifyBlock(identity, bytes)).rejects.toThrow("Supported");
  });
  it("extracts raw, dag-pb and nested dag-cbor links", () => {
    expect(links(cid, bytes)).toEqual([]);
    const pb = dagPb.encode({ Links: [{ Hash: cid, Name: "child" }] });
    expect(links(CID.createV1(dagPb.code, cid.multihash), pb)).toEqual([cid]);
    const cbor = dagCbor.encode({ nested: [null, 1, { link: cid }] });
    expect(links(CID.createV1(dagCbor.code, cid.multihash), cbor)).toEqual([
      cid,
    ]);
    expect(() => links(CID.createV1(dagPb.code, cid.multihash), bytes)).toThrow(
      "Malformed",
    );
    expect(() => links(CID.createV1(999, cid.multihash), bytes)).toThrow(
      "unsupported",
    );
  });
  it("rejects incomplete DAGs and deduplicates links", async () => {
    const block = dagPb.encode({ Links: [{ Hash: cid }, { Hash: cid }] });
    const root = CID.createV1(dagPb.code, await sha256.digest(block));
    await expect(completeDag(root, () => undefined)).rejects.toThrow(
      "Incomplete DAG",
    );
    const dag = await completeDag(root, (link) =>
      key(link) === key(root) ? block : bytes,
    );
    expect(dag.blocks.size).toBe(2);
    expect(dag.size).toBe(bytes.length + block.length);
  });
  it("enforces exact body limits, including undeclared streaming bodies", async () => {
    expect(
      await boundedBody(
        new Request("http://x", { method: "POST", body: bytes }),
        3,
      ),
    ).toEqual(bytes);
    await expect(
      boundedBody(new Request("http://x", { method: "POST", body: bytes }), 2),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      boundedBody(
        new Request("http://x", {
          method: "POST",
          headers: { "content-length": String(MAX_UPLOAD + 1) },
          body: bytes,
        }),
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(boundedBody(new Request("http://x"))).rejects.toMatchObject({
      status: 400,
    });
    expect(
      await jsonBody(new Request("http://x", { method: "POST", body: "{}" })),
    ).toEqual({});
    await expect(
      jsonBody(new Request("http://x", { method: "POST", body: "bad" })),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("rejects malformed, corrupt, multi-root, incomplete and extraneous CARs", async () => {
    await expect(readCar(bytes)).rejects.toThrow("Invalid CAR");
    await expect(readCar(await carWith([], []))).rejects.toThrow("single-root");
    await expect(readCar(await carWith([cid, cid], []))).rejects.toThrow(
      "single-root",
    );
    await expect(
      readCar(await carWith([cid], [{ cid, bytes: new Uint8Array([4]) }])),
    ).rejects.toThrow("do not match");
    await expect(readCar(await carWith([cid], []))).rejects.toThrow(
      "Incomplete DAG",
    );
    const extra = new Uint8Array([9]);
    const extraCid = CID.createV1(0x55, await sha256.digest(extra));
    await expect(
      readCar(
        await carWith(
          [cid],
          [
            { cid, bytes },
            { cid: extraCid, bytes: extra },
          ],
        ),
      ),
    ).rejects.toThrow("unreachable");
    const good = await readCar(await carWith([cid], [{ cid, bytes }]));
    expect(good.size).toBe(3);
    expect(
      (await readCar(await encodeCar(await importFile(new Uint8Array()))))
        .blocks.size,
    ).toBe(1);
  });
  it("enforces DAG total bytes and block-count limits", async () => {
    const blocks = new Map<string, Uint8Array>();
    const children: CID[] = [];
    for (let n = 0; n < 17; n++) {
      const data = new Uint8Array(MAX_BLOCK).fill(n);
      const child = CID.createV1(0x55, await sha256.digest(data));
      children.push(child);
      blocks.set(key(child), data);
    }
    const parent = dagPb.encode({ Links: children.map((Hash) => ({ Hash })) });
    const root = CID.createV1(dagPb.code, await sha256.digest(parent));
    blocks.set(key(root), parent);
    await expect(
      completeDag(root, (link) => blocks.get(key(link))),
    ).rejects.toThrow("32 MiB");
    const many = new Map<string, Uint8Array>();
    const childLinks: CID[] = [];
    for (let n = 0; n < MAX_BLOCKS; n++) {
      const data = new TextEncoder().encode(String(n));
      const child = CID.createV1(0x55, await sha256.digest(data));
      many.set(key(child), data);
      childLinks.push(child);
    }
    const big = dagPb.encode({ Links: childLinks.map((Hash) => ({ Hash })) });
    const bigRoot = CID.createV1(dagPb.code, await sha256.digest(big));
    many.set(key(bigRoot), big);
    await expect(
      completeDag(bigRoot, (link) => many.get(key(link))),
    ).rejects.toThrow(String(MAX_BLOCKS));
  });
});
