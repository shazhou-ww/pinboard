import * as dagCbor from "@ipld/dag-cbor";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { key, type Dag } from "../src/content.js";

export async function budgetDag(
  count = 256,
  size = 32 * 1024 * 1024,
): Promise<Dag> {
  const placeholder = CID.createV1(0x55, await sha256.digest(new Uint8Array()));
  const rootSize = dagCbor.encode({
    links: Array<CID>(count - 1).fill(placeholder),
  }).length;
  const links: CID[] = [];
  const blocks = new Map<string, Uint8Array>();
  let remaining = size - rootSize;
  for (let index = 0; index < count - 1; index++) {
    const length =
      index === 0
        ? Math.min(2 * 1024 * 1024, remaining - (count - 2))
        : Math.floor(remaining / (count - 1 - index));
    const bytes = new Uint8Array(length).fill(index);
    const cid = CID.createV1(0x55, await sha256.digest(bytes));
    blocks.set(key(cid), bytes);
    links.push(cid);
    remaining -= length;
  }
  const bytes = dagCbor.encode({ links });
  const root = CID.createV1(dagCbor.code, await sha256.digest(bytes));
  blocks.set(key(root), bytes);
  return { root, blocks, size };
}
