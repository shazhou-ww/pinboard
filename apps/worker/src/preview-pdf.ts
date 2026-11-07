import { PDFiumModule } from "@hyzyla/pdfium";
import pdfiumWasm from "../.preview-assets/pdfium.wasm";
import callbacksWasm from "../.preview-assets/callbacks.wasm";
import fontData from "../assets/DroidSansFallbackFull.ttf";
import { nativeSession } from "./preview-native.js";
import { MAX_PDF_SIZE, type PreviewFileSource } from "./preview-file.js";
import { PreviewLimit, PreviewUnsupported } from "./preview-limits.js";
import type { Raster } from "./preview-raster.js";
import { PdfData } from "./preview-pdf-data.js";
export { MAX_PDF_CACHE, MAX_PDF_ROUNDS } from "./preview-pdf-data.js";

type NativeFunction = (...args: number[]) => number;
interface NativeExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __indirect_function_table: WebAssembly.Table;
}
interface Session {
  available(offset: number, length: number): number;
  read(offset: number, pointer: number, length: number): number;
  hint(offset: number, length: number): void;
  error?: Error;
}
interface Runtime {
  generation: number;
  memory: WebAssembly.Memory;
  exports: NativeExports;
  call(name: string, ...args: number[]): number;
  slots: number;
  current?: Session;
  poisoned: boolean;
}
let runtime: Runtime | undefined;
let lastStats = { rounds: 0, logicalBytes: 0, windows: 0 };

async function initialize(
  memory: WebAssembly.Memory,
  generation: number,
): Promise<Runtime> {
  if (runtime?.generation === generation && !runtime.poisoned) return runtime;
  // The arena has already invalidated and zeroed all previous native state.
  runtime = undefined;
  let exports: NativeExports | undefined;
  let failedGrowth = false;
  const module = await PDFiumModule({
    instantiateWasm(imports, callback) {
      const resize = imports.env?.emscripten_resize_heap;
      if (typeof resize !== "function")
        throw new Error("Unexpected PDFium memory ABI");
      const instance = new WebAssembly.Instance(pdfiumWasm, {
        ...imports,
        pinboard: { memory },
        env: {
          ...imports.env,
          emscripten_resize_heap(size: number) {
            const result: unknown = (resize as (size: number) => number)(size);
            if (!result) failedGrowth = true;
            return result;
          },
        },
      });
      exports = instance.exports as NativeExports;
      callback(instance);
    },
  });
  if (!exports || exports.memory !== memory)
    throw new Error("Unexpected PDFium memory");
  const state: Runtime = {
    generation,
    memory,
    exports,
    slots: 0,
    poisoned: false,
    call(name, ...args) {
      const operation = state.exports[name];
      if (typeof operation !== "function")
        throw new Error(`Missing PDFium export ${name}`);
      try {
        const result = (operation as NativeFunction)(...args);
        if (failedGrowth) {
          state.poisoned = true;
          throw new PreviewLimit("PDF exceeds native memory budget");
        }
        return result;
      } catch (error) {
        if (error instanceof WebAssembly.RuntimeError || failedGrowth) {
          state.poisoned = true;
          throw new PreviewLimit("PDF native renderer aborted");
        }
        throw error;
      }
    },
  };
  const fs = (
    module as typeof module & {
      FS: {
        mkdir(path: string): void;
        writeFile(
          path: string,
          data: Uint8Array,
          options: { canOwn: boolean },
        ): void;
      };
    }
  ).FS;
  fs.mkdir("/fonts");
  // canOwn shares the immutable font buffer with MEMFS across reinitializations.
  fs.writeFile("/fonts/DroidSansFallbackFull.ttf", new Uint8Array(fontData), {
    canOwn: true,
  });
  const config = allocate(state, 32);
  try {
    const bytes = new TextEncoder().encode("/fonts\0");
    new Uint8Array(memory.buffer, config + 24, 8).set(bytes);
    new Uint32Array(memory.buffer, config, 6).set([
      2,
      config + 16,
      0,
      0,
      config + 24,
      0,
    ]);
    state.call("FPDF_InitLibraryWithConfig", config);
  } finally {
    if (!state.poisoned) state.call("free", config);
  }
  const callback = <T>(fallback: T, operation: (session: Session) => T): T => {
    if (!state.current) return fallback;
    try {
      return operation(state.current);
    } catch (error) {
      state.current.error =
        error instanceof Error ? error : new Error("PDF callback failed");
      return fallback;
    }
  };
  const bridge = new WebAssembly.Instance(callbacksWasm, {
    callbacks: {
      available(_self: number, offset: number, length: number) {
        return callback(0, (session) => session.available(offset, length));
      },
      read(_self: number, offset: number, pointer: number, length: number) {
        return callback(0, (session) => session.read(offset, pointer, length));
      },
      hint(_self: number, offset: number, length: number) {
        callback(undefined, (session) => {
          session.hint(offset, length);
        });
      },
    },
  });
  const table = state.exports.__indirect_function_table;
  state.slots = table.grow(3);
  table.set(state.slots, bridge.exports.available);
  table.set(state.slots + 1, bridge.exports.read);
  table.set(state.slots + 2, bridge.exports.hint);
  runtime = state;
  return state;
}

function allocate(state: Runtime, length: number) {
  const pointer = state.call("malloc", length);
  if (!pointer) {
    state.poisoned = true;
    throw new PreviewLimit("PDF native allocation failed");
  }
  return pointer;
}

export function pdfRuntimeState() {
  return {
    ...lastStats,
    tableSize: runtime?.exports.__indirect_function_table.length ?? 0,
    hasSession: !!runtime?.current,
    poisoned: runtime?.poisoned ?? false,
  };
}

export async function renderPdf(
  source: PreviewFileSource,
  signal: AbortSignal = AbortSignal.timeout(20000),
  strategy: "auto" | "full" = "auto",
): Promise<Raster> {
  if (
    !Number.isSafeInteger(source.size) ||
    source.size <= 0 ||
    source.size > MAX_PDF_SIZE
  )
    throw new PreviewLimit("PDF exceeds 32 MiB logical file limit or is empty");
  signal.throwIfAborted();
  return nativeSession("pdf", async (memory, generation) => {
    const state = await initialize(memory, generation);
    const data = new PdfData(source, memory, signal);
    const pointers: number[] = [];
    let document = 0,
      availability = 0,
      page = 0,
      bitmap = 0,
      textPage = 0;
    let failure: Error | undefined;
    let raster: Raster | undefined;
    state.current = data;
    const check = () => {
      data.check();
      if (state.poisoned)
        throw new PreviewLimit("PDF native renderer is unavailable");
    };
    const words = (values: number[]) => {
      const pointer = allocate(state, values.length * 4);
      pointers.push(pointer);
      new Uint32Array(memory.buffer, pointer, values.length).set(values);
      return pointer;
    };
    try {
      if (strategy === "full" || source.size <= 256 * 1024) {
        data.hint(0, source.size);
        await data.fill();
      }
      const fileAccess = words([source.size, state.slots + 1, 0]);
      const hints = words([1, state.slots + 2]);
      if (data.stats.logicalBytes === source.size) {
        document = state.call("FPDF_LoadCustomDocument", fileAccess, 0);
      } else {
        const fileAvail = words([1, state.slots]);
        availability = state.call("FPDFAvail_Create", fileAvail, fileAccess);
        if (!availability) {
          state.poisoned = true;
          throw new PreviewLimit("PDF availability allocation failed");
        }
        await data.untilAvailable(() =>
          state.call("FPDFAvail_IsDocAvail", availability, hints),
        );
        document = state.call("FPDFAvail_GetDocument", availability, 0);
      }
      check();
      if (!document) {
        const code = state.call("FPDF_GetLastError");
        throw new PreviewUnsupported(
          code === 4
            ? "Password-protected PDF is unsupported"
            : "PDF is damaged or unsupported",
        );
      }
      if (availability)
        await data.untilAvailable(() =>
          state.call("FPDFAvail_IsPageAvail", availability, 0, hints),
        );
      if (state.call("FPDF_GetFormType", document) !== 0)
        throw new PreviewUnsupported(
          "PDF forms and XFA require static flattening",
        );
      page = state.call("FPDF_LoadPage", document, 0);
      check();
      if (!page) throw new PreviewUnsupported("PDF first page is unavailable");
      if (state.call("FPDFPage_GetAnnotCount", page) !== 0)
        throw new PreviewUnsupported(
          "PDF annotations require static flattening",
        );
      const box = words([0, 0, 0, 0]);
      const boxes: number[][] = [];
      for (const name of ["FPDFPage_GetMediaBox", "FPDFPage_GetCropBox"]) {
        if (state.call(name, page, box, box + 4, box + 8, box + 12)) {
          const values = [...new Float32Array(memory.buffer, box, 4)];
          if (
            !values.every(Number.isFinite) ||
            values[2]! <= values[0]! ||
            values[3]! <= values[1]!
          )
            throw new PreviewUnsupported("PDF has invalid page bounds");
          boxes.push(values);
        }
      }
      if (
        boxes.length === 2 &&
        (Math.min(boxes[0]![2]!, boxes[1]![2]!) <=
          Math.max(boxes[0]![0]!, boxes[1]![0]!) ||
          Math.min(boxes[0]![3]!, boxes[1]![3]!) <=
            Math.max(boxes[0]![1]!, boxes[1]![1]!))
      )
        throw new PreviewUnsupported("PDF page boxes do not intersect");
      const sourceWidth = state.call("FPDF_GetPageWidth", page);
      const sourceHeight = state.call("FPDF_GetPageHeight", page);
      if (
        !Number.isFinite(sourceWidth) ||
        !Number.isFinite(sourceHeight) ||
        sourceWidth <= 0 ||
        sourceHeight <= 0
      )
        throw new PreviewUnsupported("PDF has invalid page dimensions");
      textPage = state.call("FPDFText_LoadPage", page);
      if (!textPage) throw new PreviewUnsupported("PDF text inspection failed");
      const count = state.call("FPDFText_CountChars", textPage);
      if (count < 0 || count > 20000)
        throw new PreviewLimit("PDF exceeds first-page text inspection budget");
      for (let index = 0; index < count; index++) {
        const unicode = state.call("FPDFText_GetUnicode", textPage, index);
        if (
          (unicode >= 0x1100 && unicode <= 0x11ff) ||
          (unicode >= 0x3130 && unicode <= 0x318f) ||
          (unicode >= 0xa960 && unicode <= 0xa97f) ||
          (unicode >= 0xac00 && unicode <= 0xd7ff)
        ) {
          const object = state.call("FPDFText_GetTextObject", textPage, index);
          const font = object && state.call("FPDFTextObj_GetFont", object);
          if (!font || state.call("FPDFFont_GetIsEmbedded", font) !== 1)
            throw new PreviewUnsupported(
              "PDF fallback font does not cover Hangul",
            );
        }
      }
      check();
      const scale = Math.min(1, 480 / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.min(480, Math.round(sourceWidth * scale)));
      const height = Math.max(
        1,
        Math.min(480, Math.round(sourceHeight * scale)),
      );
      const pointer = allocate(state, width * height * 4);
      pointers.push(pointer);
      bitmap = state.call(
        "FPDFBitmap_CreateEx",
        width,
        height,
        4,
        pointer,
        width * 4,
      );
      if (!bitmap) {
        state.poisoned = true;
        throw new PreviewLimit("PDF bitmap allocation failed");
      }
      state.call(
        "FPDFBitmap_FillRect",
        bitmap,
        0,
        0,
        width,
        height,
        0xffffffff,
      );
      state.call(
        "FPDF_RenderPageBitmap",
        bitmap,
        page,
        0,
        0,
        width,
        height,
        0,
        0,
      );
      check();
      const pixels = new Uint8ClampedArray(width * height * 4);
      const bgra = new Uint8Array(memory.buffer, pointer, pixels.length);
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = bgra[i + 2]!;
        pixels[i + 1] = bgra[i + 1]!;
        pixels[i + 2] = bgra[i]!;
        pixels[i + 3] = bgra[i + 3]!;
      }
      raster = { data: pixels, width, height };
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    } finally {
      try {
        if (!state.poisoned) {
          if (bitmap) state.call("FPDFBitmap_Destroy", bitmap);
          if (textPage) state.call("FPDFText_ClosePage", textPage);
          if (page) state.call("FPDF_ClosePage", page);
          if (document) state.call("FPDF_CloseDocument", document);
          if (availability) state.call("FPDFAvail_Destroy", availability);
          for (const pointer of pointers) state.call("free", pointer);
        }
      } catch (error) {
        state.poisoned = true;
        failure ??= error instanceof Error ? error : new Error(String(error));
      } finally {
        delete state.current;
        data.clear();
        lastStats = { ...data.stats };
      }
    }
    if (failure) throw failure;
    return raster!;
  });
}
