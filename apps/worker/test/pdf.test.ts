import { expect, it, vi } from "vitest";
import {
  renderPdf,
  pdfRuntimeState,
  MAX_PDF_CACHE,
} from "../src/preview-pdf.js";
import { nativeSession, nativeState } from "../src/preview-native.js";
import { encodeRaster } from "../src/preview-raster.js";
import {
  simplePdf,
  cjkPdf,
  largeSecondPagePdf,
  passwordPdf,
} from "./pdf-fixtures.js";
import { MAX_PDF_SIZE, type PreviewFileSource } from "../src/preview-file.js";

function source(bytes: Uint8Array): PreviewFileSource {
  return {
    size: bytes.length,
    readAt: (offset, length) =>
      Promise.resolve(bytes.slice(offset, offset + length)),
  };
}
it("renders and encodes deterministic first-page rasters, with bounded persistent callbacks", async () => {
  const bytes = simplePdf();
  for (let index = 0; index < 3; index++) {
    const raster = await renderPdf(source(bytes));
    expect(raster).toMatchObject({ width: 200, height: 200 });
    expect([...raster.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    const result = await encodeRaster(raster);
    expect(result.bytes.length).toBeLessThanOrEqual(65536);
    expect(pdfRuntimeState()).toMatchObject({
      hasSession: false,
      windows: 0,
      poisoned: false,
    });
  }
  expect(nativeState()).toMatchObject({
    nativeBytes: 32 * 1024 * 1024,
    occupied: false,
  });
});
it("performs asynchronous availability rounds and matches full reads", async () => {
  const bytes = largeSecondPagePdf();
  const file = source(bytes);
  const readAt = vi.fn((offset: number, length: number) =>
    file.readAt(offset, length),
  );
  const partial = await renderPdf({ size: bytes.length, readAt });
  expect(
    readAt.mock.calls.reduce((sum, [, length]) => sum + length, 0),
  ).toBeLessThan(bytes.length / 4);
  const full = await renderPdf(source(bytes), undefined, "full");
  expect(partial).toEqual(full);
});
it("rejects encrypted/invalid/unsupported capabilities instead of publishing blank successes", async () => {
  for (const bytes of [
    new TextEncoder().encode("%PDF-1.7\nbroken"),
    passwordPdf(),
    simplePdf({ form: true }),
    simplePdf({ annotation: true }),
    cjkPdf("한국", false, true),
    simplePdf({ width: 0 }),
    simplePdf({ crop: "300 300 500 500" }),
    simplePdf({ crop: "10 0 0 10" }),
  ])
    await expect(renderPdf(source(bytes))).rejects.toThrow(/PDF|Hangul/u);
  for (const bytes of [
    cjkPdf("你好世界"),
    cjkPdf("中文預覽", true),
    simplePdf({ content: "" }),
    simplePdf({ width: 1, height: 100000 }),
    simplePdf({ rotate: 270 }),
  ])
    expect((await renderPdf(source(bytes))).data.length).toBeGreaterThan(0);
});
it("guards source dimensions, deadline, read length, cache budget and I/O failures", async () => {
  for (const size of [0, -1, 1.5, MAX_PDF_SIZE + 1, Number.MAX_SAFE_INTEGER])
    await expect(
      renderPdf({ size, readAt: () => Promise.resolve(new Uint8Array()) }),
    ).rejects.toThrow("logical");
  const controller = new AbortController();
  controller.abort(new Error("deadline"));
  await expect(
    renderPdf(source(simplePdf()), controller.signal),
  ).rejects.toThrow("deadline");
  await expect(
    renderPdf({ size: 128, readAt: () => Promise.resolve(new Uint8Array(1)) }),
  ).rejects.toThrow("length");
  await expect(
    renderPdf({
      size: 128,
      readAt: () => Promise.reject(new Error("missing R2")),
    }),
  ).rejects.toThrow("missing R2");
  await expect(
    renderPdf(
      {
        size: MAX_PDF_CACHE + 1,
        readAt: (_offset, length) => Promise.resolve(new Uint8Array(length)),
      },
      undefined,
      "full",
    ),
  ).rejects.toThrow("cache budget");
  expect(pdfRuntimeState()).toMatchObject({ hasSession: false, windows: 0 });
});
it("defers immediately without queued source references and recovers after async cancellation", async () => {
  const bytes = simplePdf();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = renderPdf({
    size: bytes.length,
    async readAt(offset, length) {
      await wait;
      return bytes.slice(offset, offset + length);
    },
  });
  await expect(renderPdf(source(bytes))).rejects.toThrow("busy");
  release();
  await first;
  const controller = new AbortController();
  await expect(
    renderPdf(
      {
        size: bytes.length,
        readAt() {
          controller.abort(new Error("cancelled"));
          return Promise.resolve(bytes);
        },
      },
      controller.signal,
    ),
  ).rejects.toThrow("cancelled");
  expect((await renderPdf(source(bytes))).width).toBe(200);
});
it("does not reuse poisoned native state or allocate a second native memory", async () => {
  const before = nativeState().nativeBytes;
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(renderPdf(source(simplePdf({ bomb: true })))).rejects.toThrow(
      /native|memory/u,
    );
  } finally {
    spy.mockRestore();
  }
  expect(pdfRuntimeState()).toMatchObject({
    hasSession: false,
    windows: 0,
    poisoned: true,
  });
  expect((await renderPdf(source(simplePdf()))).width).toBe(200);
  expect(nativeState().nativeBytes).toBe(before);
  await nativeSession("probe", async (memory) => {
    expect(() => memory.grow(1)).toThrow(RangeError);
    expect(memory.buffer.byteLength).toBe(before);
    await Promise.resolve();
  });
  expect((await renderPdf(source(simplePdf()))).width).toBe(200);
});
it("checks raster input before initializing encoders", async () => {
  for (const [width, height] of [
    [0, 1],
    [1, NaN],
    [1.5, 1],
    [1, 1],
    [2000001, 1],
  ])
    await expect(
      encodeRaster({
        width: width!,
        height: height!,
        data: new Uint8ClampedArray(),
      }),
    ).rejects.toThrow("Invalid preview raster");
});
it("does not execute document JavaScript or fetch external resources", async () => {
  const fetch = vi.fn(() =>
    Promise.reject(new Error("External fetch is forbidden")),
  );
  vi.stubGlobal("fetch", fetch);
  try {
    const raster = await renderPdf(source(simplePdf({ script: true })));
    expect([...raster.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(fetch).not.toHaveBeenCalled();
    await nativeSession("independent-output", async (memory) => {
      new Uint8Array(memory.buffer).fill(17);
      await Promise.resolve();
    });
    expect([...raster.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
  } finally {
    vi.unstubAllGlobals();
  }
});
