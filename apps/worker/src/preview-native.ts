import { PreviewDeferred } from "./preview-limits.js";

export const NATIVE_MEMORY_BYTES = 32 * 1024 * 1024;
let memory: WebAssembly.Memory | undefined;
let generation = 0;
let owner = "";
let occupied = false;

// All decoders use the same backing store. Reinitialization zeros it before
// instantiation, even after an abort; no native cleanup or immediate GC is needed.
export async function nativeSession<T>(
  kind: string,
  operation: (memory: WebAssembly.Memory, generation: number) => Promise<T>,
): Promise<T> {
  if (occupied) throw new PreviewDeferred("Native preview renderer busy");
  occupied = true;
  try {
    const pages = NATIVE_MEMORY_BYTES / 65536;
    memory ??= new WebAssembly.Memory({ initial: pages, maximum: pages });
    if (owner !== kind) {
      new Uint8Array(memory.buffer).fill(0);
      owner = kind;
      generation++;
    }
    return await operation(memory, generation);
  } catch (error) {
    owner = "";
    throw error;
  } finally {
    occupied = false;
  }
}

export function nativeState() {
  return {
    nativeBytes: memory?.buffer.byteLength ?? 0,
    generation,
    owner,
    occupied,
  };
}
