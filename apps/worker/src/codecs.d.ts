declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "*.ttf" {
  const bytes: ArrayBuffer;
  export default bytes;
}
declare module "*preview-png.js" {
  export default function init(
    module: WebAssembly.Module,
    memory: WebAssembly.Memory,
  ): Promise<unknown>;
  export function decode(bytes: Uint8Array): {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  };
}
declare module "@jsquash/png/codec/pkg/squoosh_png_bg.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "@jsquash/webp/codec/enc/webp_enc.js" {
  export default function create(options: {
    noInitialRun: boolean;
    instantiateWasm: (
      imports: WebAssembly.Imports,
      callback: (instance: WebAssembly.Instance) => void,
    ) => WebAssembly.Exports;
  }): Promise<{
    encode(
      data: Uint8ClampedArray,
      width: number,
      height: number,
      options: Record<string, number>,
    ): Uint8Array | null;
  }>;
}
