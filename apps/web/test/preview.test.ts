import { CarReader, CarWriter } from "@ipld/car";
import { importer } from "ipfs-unixfs-importer";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  canPreview,
  imageFromCar,
  imageType,
  loadImage,
  maxPreviewBytes,
} from "../src/preview.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const signal = () => new AbortController().signal;

async function car(
  root: CID,
  blocks: { cid: CID; bytes: Uint8Array }[],
): Promise<Uint8Array<ArrayBuffer>> {
  const { writer, out } = CarWriter.create([root]);
  const collecting = (async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of out) chunks.push(chunk);
    const bytes = new Uint8Array(
      chunks.reduce((size, chunk) => size + chunk.length, 0),
    );
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  })();
  for (const block of blocks) await writer.put(block);
  await writer.close();
  return collecting;
}

async function raw(bytes = png) {
  const cid = CID.createV1(0x55, await sha256.digest(bytes));
  return { cid, bytes: await car(cid, [{ cid, bytes }]) };
}

afterEach(() => vi.unstubAllGlobals());

describe("content wall image previews", () => {
  it("only previews supported image labels within the exact size threshold", () => {
    expect(canPreview("PHOTO.PNG", maxPreviewBytes)).toBe(true);
    expect(canPreview("photo.jpg", maxPreviewBytes + 1)).toBe(false);
    for (const name of ["page.html", "image.svg", "archive.car", "notes.txt"])
      expect(canPreview(name, 10)).toBe(false);
  });

  it("identifies raster signatures, never SVG or HTML masquerading as an image", () => {
    expect(imageType(png)).toBe("image/png");
    expect(imageType(new Uint8Array([255, 216, 255]))).toBe("image/jpeg");
    expect(imageType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(imageType(new TextEncoder().encode("GIF87a"))).toBe("image/gif");
    expect(imageType(new TextEncoder().encode("RIFF0000WEBP"))).toBe(
      "image/webp",
    );
    expect(
      imageType(new TextEncoder().encode("<svg onload='alert(1)'>")),
    ).toBeNull();
    expect(imageType(new TextEncoder().encode("<html>"))).toBeNull();
    expect(imageType(new Uint8Array())).toBeNull();
  });

  it("verifies a raw image CAR and preserves its bytes", async () => {
    const archive = await raw();
    const image = await imageFromCar(
      archive.bytes,
      archive.cid.toString(),
      signal(),
    );
    expect(image?.type).toBe("image/png");
    expect(new Uint8Array(await image!.arrayBuffer())).toEqual(png);
  });

  it("reconstructs UnixFS files rather than displaying the DAG root block", async () => {
    const blocks: { cid: CID; bytes: Uint8Array }[] = [];
    let root: CID | undefined;
    for await (const entry of importer(
      [{ path: "image.png", content: png }],
      {
        put: async (cid, bytes) => {
          const chunks: Uint8Array[] = [];
          if (bytes instanceof Uint8Array) chunks.push(bytes);
          else for await (const chunk of bytes) chunks.push(chunk);
          const stored = new Uint8Array(
            chunks.reduce((size, chunk) => size + chunk.length, 0),
          );
          let offset = 0;
          for (const chunk of chunks) {
            stored.set(chunk, offset);
            offset += chunk.length;
          }
          blocks.push({ cid: CID.parse(cid.toString()), bytes: stored });
          return cid;
        },
      },
      { rawLeaves: false, cidVersion: 1 },
    ))
      root = CID.parse(entry.cid.toString());
    const image = await imageFromCar(
      await car(root!, blocks),
      root!.toString(),
      signal(),
    );
    expect(new Uint8Array(await image!.arrayBuffer())).toEqual(png);
  });

  it("rejects mismatched CIDs, tampered blocks and incomplete CARs", async () => {
    const archive = await raw();
    const other = await raw(new Uint8Array([1]));
    await expect(
      imageFromCar(archive.bytes, other.cid.toString(), signal()),
    ).rejects.toThrow("requested CID");
    const reader = await CarReader.fromBytes(archive.bytes);
    const block = await reader.get(archive.cid);
    const corrupt = await car(archive.cid, [
      { cid: archive.cid, bytes: new Uint8Array([...block!.bytes, 1]) },
    ]);
    await expect(
      imageFromCar(corrupt, archive.cid.toString(), signal()),
    ).rejects.toThrow("verification");
    await expect(
      imageFromCar(
        await car(archive.cid, []),
        archive.cid.toString(),
        signal(),
      ),
    ).rejects.toThrow();
  });

  it("does not preview active content even with an image label", async () => {
    const archive = await raw(
      new TextEncoder().encode("<svg onload='alert(1)'/>"),
    );
    expect(
      await imageFromCar(archive.bytes, archive.cid.toString(), signal()),
    ).toBeNull();
  });

  it("surfaces HTTP errors, bounds streamed responses and supports aborting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    await expect(loadImage("missing", signal())).rejects.toThrow("HTTP 404");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array(maxPreviewBytes + 200000)),
        ),
    );
    await expect(loadImage("large", signal())).rejects.toThrow("size limit");
    const archive = await raw();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(archive.bytes)),
    );
    expect((await loadImage(archive.cid.toString(), signal()))?.type).toBe(
      "image/png",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      imageFromCar(archive.bytes, archive.cid.toString(), controller.signal),
    ).rejects.toThrow();
  });
});
