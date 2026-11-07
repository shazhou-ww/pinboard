import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode.js";
import jpegWasm from "../.preview-assets/jpeg.wasm";
import initPng, {
  decode as decodePng,
} from "../.preview-assets/preview-png.js";
import pngWasm from "../.preview-assets/png.wasm";
import decodeWebp, { init as initWebp } from "@jsquash/webp/decode.js";
import webpWasm from "../.preview-assets/webp.wasm";
import { encodeRaster, type Raster } from "./preview-raster.js";
import { nativeSession } from "./preview-native.js";

export const MAX_IMAGE_PIXELS = 2_000_000;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export type { Raster } from "./preview-raster.js";

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

let decoderGeneration = 0;

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
  return nativeSession(info.type, async (memory, generation) => {
    if (decoderGeneration !== generation) {
      const module = info.type === "image/jpeg" ? jpegWasm : webpWasm;
      const options = {
        instantiateWasm(
          imports: WebAssembly.Imports,
          callback: (instance: WebAssembly.Instance) => void,
        ) {
          const instance = new WebAssembly.Instance(module, {
            ...imports,
            pinboard: { memory },
          });
          callback(instance);
          return instance.exports;
        },
      };
      if (info.type === "image/png") await initPng(pngWasm, memory);
      else if (info.type === "image/jpeg") await initJpeg(options);
      else await initWebp(options);
      decoderGeneration = generation;
    }
    const buffer = bytes.slice().buffer;
    const decoded: Raster =
      info.type === "image/png"
        ? decodePng(new Uint8Array(buffer))
        : info.type === "image/jpeg"
          ? await decodeJpeg(buffer)
          : await decodeWebp(buffer);
    if (decoded.width * decoded.height > MAX_IMAGE_PIXELS)
      throw new Error("Decoded image exceeds pixel limit");
    return encodeRaster(decoded);
  });
}
