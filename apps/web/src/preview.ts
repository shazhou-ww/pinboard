import { CarReader } from "@ipld/car";
import { uploadLimits } from "@shazhou/pinboard-contracts";
import { exporter, type ReadableStorage } from "ipfs-unixfs-exporter";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";

export const maxPreviewBytes = 8 * 1024 * 1024;
const maxPreviewCarBytes =
  maxPreviewBytes + uploadLimits.maxBlocks * 512 + 4096;

export function imageType(bytes: Uint8Array): string | null {
  const starts = (signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts([255, 216, 255])) return "image/jpeg";
  if (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))
    return "image/gif";
  if (
    starts([82, 73, 70, 70]) &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  )
    return "image/webp";
  return null;
}

export function canPreview(name: string, size: number): boolean {
  return /\.(png|jpe?g|gif|webp)$/iu.test(name) && size <= maxPreviewBytes;
}

export async function imageFromCar(
  bytes: Uint8Array,
  requested: string,
  signal: AbortSignal,
): Promise<Blob | null> {
  signal.throwIfAborted();
  if (bytes.length > maxPreviewCarBytes)
    throw new Error("Image preview exceeds the size limit.");
  const reader = await CarReader.fromBytes(bytes);
  const roots = await reader.getRoots();
  const root = CID.parse(requested).toV1();
  if (roots.length !== 1 || !roots[0]!.toV1().equals(root))
    throw new Error("Image preview does not match the requested CID.");
  const blocks = new Map<string, Uint8Array>();
  let total = 0;
  let count = 0;
  for await (const block of reader.blocks()) {
    signal.throwIfAborted();
    total += block.bytes.length;
    if (
      ++count > uploadLimits.maxBlocks ||
      total > maxPreviewBytes ||
      block.bytes.length > uploadLimits.maxBlockBytes ||
      block.cid.multihash.code !== sha256.code ||
      ![0x55, 0x70].includes(block.cid.code)
    )
      throw new Error(
        "Image preview contains unsupported or oversized blocks.",
      );
    const hash = await sha256.digest(block.bytes);
    if (!CID.createV1(block.cid.code, hash).equals(block.cid.toV1()))
      throw new Error("Image preview failed CID verification.");
    blocks.set(block.cid.toV1().toString(), block.bytes);
  }
  const store: ReadableStorage = {
    *get(cid) {
      signal.throwIfAborted();
      const block = blocks.get(cid.toV1().toString());
      if (!block) throw new Error("Image preview is missing a content block.");
      yield block;
    },
  };
  const entry = await exporter(root, store, { signal });
  if (entry.type !== "file" && entry.type !== "raw") return null;
  if (entry.size > BigInt(maxPreviewBytes))
    throw new Error("Image preview exceeds the size limit.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of entry.content({
    signal,
    blockReadConcurrency: 1,
  })) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > maxPreviewBytes || BigInt(size) > entry.size)
      throw new Error("Image preview exceeds its declared size.");
    chunks.push(chunk);
  }
  if (BigInt(size) !== entry.size)
    throw new Error("Image preview does not match its declared size.");
  const image = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    image.set(chunk, offset);
    offset += chunk.length;
  }
  const type = imageType(image);
  return type ? new Blob([image], { type }) : null;
}

export async function loadImage(
  cid: string,
  signal: AbortSignal,
): Promise<Blob | null> {
  const response = await fetch(`/api/public/${cid}/car`, { signal });
  if (!response.ok)
    throw new Error(`Image preview failed: HTTP ${response.status}.`);
  if (!response.body) throw new Error("Image preview response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxPreviewCarBytes)
        throw new Error("Image preview exceeds the size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return imageFromCar(bytes, cid, signal);
}
