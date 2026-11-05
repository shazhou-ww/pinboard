import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode.js";
import jpegWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import decodePng, { init as initPng } from "@jsquash/png/decode.js";
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import decodeWebp, { init as initWebp } from "@jsquash/webp/decode.js";
import webpWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import createEncoder from "@jsquash/webp/codec/enc/webp_enc.js";
import encoderWasm from "@jsquash/webp/codec/enc/webp_enc.wasm";
import { defaultOptions } from "@jsquash/webp/meta.js";

export const MAX_IMAGE_PIXELS = 2_000_000;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function imageInfo(bytes: Uint8Array): {
  type: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
} | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
  )
    return {
      type: "image/png",
      width: view.getUint32(16),
      height: view.getUint32(20),
    };
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 255) return null;
      const marker = bytes[offset + 1]!;
      if ([0xc0, 0xc1, 0xc2].includes(marker))
        return {
          type: "image/jpeg",
          width: view.getUint16(offset + 7),
          height: view.getUint16(offset + 5),
        };
      const length = view.getUint16(offset + 2);
      if (length < 2) return null;
      offset += length + 2;
    }
  }
  if (
    bytes.length >= 30 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
  ) {
    const chunk = new TextDecoder().decode(bytes.subarray(12, 16));
    if (chunk === "VP8X")
      return {
        type: "image/webp",
        width: 1 + (view.getUint32(24, true) % 0x1000000),
        height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
      };
    if (chunk === "VP8 ")
      return {
        type: "image/webp",
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    if (chunk === "VP8L") {
      const packed = view.getUint32(21, true);
      return {
        type: "image/webp",
        width: 1 + (packed & 0x3fff),
        height: 1 + ((packed >>> 14) & 0x3fff),
      };
    }
  }
  return null;
}

function resize(source: Raster, edge: number): Raster {
  const scale = Math.min(1, edge / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const data = new Uint8ClampedArray(width * height * 4);
  // Area averaging avoids aliasing and preserves transparency at small sizes.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0, 0];
      let count = 0;
      for (
        let sy = Math.floor(y / scale);
        sy < Math.min(source.height, Math.ceil((y + 1) / scale));
        sy++
      ) {
        for (
          let sx = Math.floor(x / scale);
          sx < Math.min(source.width, Math.ceil((x + 1) / scale));
          sx++
        ) {
          const index = (sy * source.width + sx) * 4;
          const alpha = source.data[index + 3]! / 255;
          for (let c = 0; c < 3; c++)
            sum[c]! += source.data[index + c]! * alpha;
          sum[3]! += alpha;
          count++;
        }
      }
      const index = (y * width + x) * 4;
      for (let c = 0; c < 3; c++)
        data[index + c] = sum[3] ? sum[c]! / sum[3] : 0;
      data[index + 3] = (255 * sum[3]!) / count;
    }
  }
  return { width, height, data };
}

let initialized: Promise<Awaited<ReturnType<typeof createEncoder>>> | undefined;
function codecs() {
  return (initialized ??= (async () => {
    if (!("ImageData" in globalThis))
      Object.assign(globalThis, {
        ImageData: class {
          constructor(
            readonly data: Uint8ClampedArray,
            readonly width: number,
            readonly height: number,
          ) {}
        },
      });
    await initJpeg(jpegWasm);
    await initPng(pngWasm);
    await initWebp(webpWasm);
    return createEncoder({
      noInitialRun: true,
      instantiateWasm(imports, callback) {
        const instance = new WebAssembly.Instance(encoderWasm, imports);
        callback(instance);
        return instance.exports;
      },
    });
  })());
}

export async function thumbnail(bytes: Uint8Array) {
  const info = imageInfo(bytes);
  if (!info) throw new Error("Unrecognized image header");
  if (
    bytes.length > MAX_IMAGE_BYTES ||
    !info.width ||
    !info.height ||
    info.width * info.height > MAX_IMAGE_PIXELS
  )
    throw new Error("Image exceeds 8 MiB / 2 million pixel decode limit");
  const encoder = await codecs();
  const buffer = bytes.slice().buffer;
  const source =
    info.type === "image/png"
      ? await decodePng(buffer)
      : info.type === "image/jpeg"
        ? await decodeJpeg(buffer)
        : await decodeWebp(buffer);
  if (source.width * source.height > MAX_IMAGE_PIXELS)
    throw new Error("Decoded image exceeds pixel limit");
  for (const [edge, quality] of [
    [480, 72],
    [480, 45],
    [320, 40],
    [240, 30],
  ] as const) {
    const raster = resize(source, edge);
    const output = encoder.encode(raster.data, raster.width, raster.height, {
      ...defaultOptions,
      quality,
      method: 2,
      alpha_quality: 80,
    });
    if (!output || output.length === 0) throw new Error("WebP encoding failed");
    if (output.length <= 64 * 1024)
      return {
        bytes: output.slice(),
        width: raster.width,
        height: raster.height,
      };
  }
  throw new Error("Thumbnail exceeds 64 KiB after bounded retries");
}
