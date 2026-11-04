import { CarReader } from "@ipld/car";
import * as dagCbor from "@ipld/dag-cbor";
import * as dagPb from "@ipld/dag-pb";
import { importer } from "ipfs-unixfs-importer";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { HTTPException } from "hono/http-exception";
import { uploadLimits } from "@workspace/contracts";

export const MAX_UPLOAD = uploadLimits.maxBytes;
export const MAX_BLOCK = uploadLimits.maxBlockBytes;
export const MAX_BLOCKS = uploadLimits.maxBlocks;
export const PROBE_CID = "bafkqaaa";

export function parseCid(value: string): CID {
  try {
    return CID.parse(value).toV1();
  } catch {
    throw new HTTPException(400, { message: "Invalid CID" });
  }
}

export function key(cid: CID): string {
  return cid.toV1().toString();
}

export async function boundedBody(
  request: Request,
  limit = MAX_UPLOAD,
): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > limit) {
    throw new HTTPException(413, { message: "Upload exceeds 32 MiB" });
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPException(400, { message: "Empty request body" });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel();
        throw new HTTPException(413, { message: "Upload exceeds size limit" });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function verifyBlock(cid: CID, bytes: Uint8Array): Promise<void> {
  if (bytes.length > MAX_BLOCK)
    throw new HTTPException(413, { message: "Block exceeds 2 MiB" });
  if (
    cid.multihash.code !== sha256.code ||
    ![0x55, dagPb.code, dagCbor.code].includes(cid.code)
  ) {
    throw new HTTPException(400, {
      message: "Supported: sha2-256 raw, dag-pb and dag-cbor blocks",
    });
  }
  const digest = await sha256.digest(bytes);
  if (!CID.createV1(cid.code, digest).equals(cid.toV1())) {
    throw new HTTPException(400, { message: "Block bytes do not match CID" });
  }
}

export function links(cid: CID, bytes: Uint8Array): CID[] {
  try {
    if (cid.code === dagPb.code)
      return dagPb.decode(bytes).Links.map((link) => link.Hash);
    if (cid.code === 0x55) return [];
    if (cid.code !== dagCbor.code) throw new Error("Unsupported codec");
    const result: CID[] = [];
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      const link = CID.asCID(value);
      if (link) {
        result.push(link);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else {
        Object.values(value).forEach(walk);
      }
    };
    walk(dagCbor.decode(bytes));
    return result;
  } catch {
    throw new HTTPException(400, {
      message: "Malformed or unsupported IPLD block",
    });
  }
}

export interface Dag {
  root: CID;
  blocks: Map<string, Uint8Array>;
  size: number;
}

export async function completeDag(
  root: CID,
  read: (cid: CID) => Promise<Uint8Array | undefined> | Uint8Array | undefined,
): Promise<Dag> {
  const blocks = new Map<string, Uint8Array>();
  const queue = [root];
  let size = 0;
  while (queue.length) {
    const cid = queue.pop()!;
    if (blocks.has(key(cid))) continue;
    if (blocks.size >= MAX_BLOCKS)
      throw new HTTPException(413, {
        message: `DAG exceeds ${MAX_BLOCKS} blocks`,
      });
    const bytes = await read(cid);
    if (!bytes)
      throw new HTTPException(400, {
        message: `Incomplete DAG: missing ${key(cid)}`,
      });
    await verifyBlock(cid, bytes);
    size += bytes.length;
    if (size > MAX_UPLOAD)
      throw new HTTPException(413, { message: "DAG exceeds 32 MiB" });
    blocks.set(key(parseCid(cid.toString())), bytes);
    queue.push(...links(cid, bytes));
  }
  return { root: root.toV1(), blocks, size };
}

export async function readCar(bytes: Uint8Array): Promise<Dag> {
  let root: CID;
  const blocks = new Map<string, Uint8Array>();
  try {
    const reader = await CarReader.fromBytes(bytes);
    const roots = await reader.getRoots();
    if (roots.length !== 1) throw new Error("Expected one root");
    root = roots[0]!;
    for await (const block of reader.blocks()) {
      if (blocks.size >= MAX_BLOCKS)
        throw new HTTPException(413, {
          message: `CAR exceeds ${MAX_BLOCKS} blocks`,
        });
      await verifyBlock(block.cid, block.bytes);
      blocks.set(key(block.cid), block.bytes);
    }
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, {
      message: "Invalid CAR; supply a single-root CARv1 or CARv2",
    });
  }
  const dag = await completeDag(root, (cid) => blocks.get(key(cid)));
  if (dag.blocks.size !== blocks.size)
    throw new HTTPException(400, {
      message: "CAR contains unreachable blocks",
    });
  return dag;
}

export async function importFile(bytes: Uint8Array): Promise<Dag> {
  const blocks = new Map<string, Uint8Array>();
  let root: CID | undefined;
  for await (const entry of importer(
    [{ content: bytes }],
    {
      put: async (cid, block) => {
        let bytes: Uint8Array;
        if (block instanceof Uint8Array) {
          bytes = block;
        } else {
          const chunks: Uint8Array[] = [];
          let length = 0;
          for await (const chunk of block) {
            length += chunk.length;
            if (length > MAX_BLOCK)
              throw new HTTPException(413, { message: "Block exceeds 2 MiB" });
            chunks.push(chunk);
          }
          bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
        }
        blocks.set(key(parseCid(cid.toString())), bytes);
        return cid;
      },
    },
    { cidVersion: 1, rawLeaves: true },
  )) {
    root = parseCid(entry.cid.toString());
  }
  if (!root) throw new HTTPException(400, { message: "Could not import file" });
  return completeDag(root, (cid) => blocks.get(key(cid)));
}
