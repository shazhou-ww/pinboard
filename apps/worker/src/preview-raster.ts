import createEncoder from "@jsquash/webp/codec/enc/webp_enc.js";
import encoderWasm from "../.preview-assets/encoder.wasm";
import { defaultOptions } from "@jsquash/webp/meta.js";

export interface Raster {
  width: number;
  height: number;
  data: Uint8ClampedArray;
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
let memory: WebAssembly.Memory | undefined;
function encoder() {
  if (initialized) return initialized;
  memory ??= new WebAssembly.Memory({ initial: 256, maximum: 256 });
  new Uint8Array(memory.buffer).fill(0);
  return (initialized = createEncoder({
    noInitialRun: true,
    instantiateWasm(imports, callback) {
      const instance = new WebAssembly.Instance(encoderWasm, {
        ...imports,
        pinboard: { memory: memory! },
      });
      callback(instance);
      return instance.exports;
    },
  }));
}

export async function encodeRaster(source: Raster) {
  if (
    !Number.isSafeInteger(source.width) ||
    !Number.isSafeInteger(source.height) ||
    source.width <= 0 ||
    source.height <= 0 ||
    source.width * source.height > 2_000_000 ||
    source.data.length !== source.width * source.height * 4
  )
    throw new Error("Invalid preview raster");
  try {
    return await encode(source);
  } catch (error) {
    initialized = undefined;
    throw error;
  }
}

async function encode(source: Raster) {
  const webp = await encoder();
  for (const [edge, quality] of [
    [480, 72],
    [480, 45],
    [320, 40],
    [240, 30],
  ] as const) {
    const raster = resize(source, edge);
    const output = webp.encode(raster.data, raster.width, raster.height, {
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
