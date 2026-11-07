import { renderPdf, pdfRuntimeState } from "../src/preview-pdf.js";
import { encodeRaster } from "../src/preview-raster.js";
import { nativeSession, nativeState } from "../src/preview-native.js";
import {
  createPreviewStore,
  previewFileSource,
} from "../src/preview-source.js";
import { thumbnail } from "../src/preview-image.js";
import { type Bindings } from "../src/env.js";
import app from "../src/index.js";
import { processPreview } from "../src/previews.js";

type TestBindings = Bindings & { PDF_TEST_CONTROL: Fetcher };

async function heldPdf(
  request: Request,
  env: TestBindings,
  context: ExecutionContext,
) {
  const url = new URL(request.url);
  const job = url.searchParams.get("job")!;
  const control = (action: string) =>
    env.PDF_TEST_CONTROL.fetch(`https://control.test/${action}?job=${job}`);
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(10000),
  ]);
  let armed = false;
  let held = false;
  const get = env.BLOCKS.get.bind(env.BLOCKS);
  const pausedGet = new Proxy(get, {
    apply(target, _receiver, args: Parameters<typeof get>) {
      const read = (async () => {
        if (armed && !held) {
          held = true;
          if (!(await control("read")).ok)
            throw new Error("Held PDF source failed");
        }
        const block = await target(...args);
        if (!block || !signal.aborted) return block;
        // Keep the original request's late I/O alive so the production source
        // adapter, rather than request teardown, must cancel this unread body.
        const body = new ReadableStream<Uint8Array>(
          {
            cancel(reason) {
              const cancelled = block.body
                .cancel(reason)
                .then(() => control("late-cancelled"))
                .then(() => {});
              context.waitUntil(cancelled);
              return cancelled;
            },
            pull() {
              throw new Error("Cancelled source body must not be consumed");
            },
          },
          { highWaterMark: 0 },
        );
        return new Proxy(block, {
          get(target, property): unknown {
            return property === "body"
              ? body
              : Reflect.get(target, property, target);
          },
        });
      })();
      context.waitUntil(
        read.then(
          () => {},
          () => {},
        ),
      );
      return read;
    },
  });
  const store = createPreviewStore(
    { DB: env.DB, BLOCKS: { ...env.BLOCKS, get: pausedGet } },
    signal,
  );
  try {
    const source = previewFileSource(
      await store.open(url.searchParams.get("cid")!),
      signal,
    );
    armed = true;
    if (url.searchParams.get("mode") === "cancel") {
      context.waitUntil(
        control("abort").then(() => {
          controller.abort(new Error("Held PDF source cancelled"));
        }),
      );
    }
    const raster = await renderPdf(source, signal);
    return new Response(new Uint8Array(raster.data));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 422 },
    );
  } finally {
    store.clear();
  }
}

export default {
  async fetch(request: Request, env: TestBindings, context: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/held-pdf") return heldPdf(request, env, context);
    if (url.pathname === "/arena-digest") {
      const { owner } = nativeState();
      const digest = await nativeSession(owner, async (memory) =>
        crypto.subtle.digest("SHA-256", memory.buffer),
      );
      return new Response(digest);
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ipfs/"))
      return app.fetch(request, env, context);
    if (url.pathname === "/process") {
      await processPreview(env, url.searchParams.get("cid")!);
      return new Response("ok");
    }
    if (url.pathname === "/state")
      return Response.json({ ...nativeState(), ...pdfRuntimeState() });
    const signal = AbortSignal.timeout(20000);
    const store = createPreviewStore(env, signal);
    try {
      if (url.pathname === "/image") {
        const result = await thumbnail(
          new Uint8Array(await request.arrayBuffer()),
        );
        return new Response(result.bytes);
      }
      const source = url.searchParams.has("cid")
        ? previewFileSource(
            await store.open(url.searchParams.get("cid")!),
            signal,
          )
        : await (async () => {
            const bytes = new Uint8Array(await request.arrayBuffer());
            return {
              size: bytes.length,
              readAt: (offset: number, length: number) =>
                Promise.resolve(bytes.slice(offset, offset + length)),
            };
          })();
      const raster = await renderPdf(
        source,
        signal,
        url.searchParams.has("full") ? "full" : "auto",
      );
      const stats = {
        ...pdfRuntimeState(),
        ...nativeState(),
        ...store.stats,
        width: raster.width,
        height: raster.height,
      };
      if (url.searchParams.has("rgba"))
        return new Response(new Uint8Array(raster.data), {
          headers: { "x-stats": JSON.stringify(stats) },
        });
      const result = await encodeRaster(raster);
      return new Response(result.bytes, {
        headers: {
          "content-type": "image/webp",
          "x-stats": JSON.stringify(stats),
        },
      });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
          ...nativeState(),
          ...pdfRuntimeState(),
        },
        { status: 422 },
      );
    } finally {
      store.clear();
    }
  },
};
