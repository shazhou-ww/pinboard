import { thumbnail } from "../src/preview-image.js";
import decodeWebp, { init } from "@jsquash/webp/decode.js";
import wasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import app from "../src/index.js";
import type { Bindings } from "../src/env.js";

export default {
  async fetch(request: Request, env: Bindings, context: ExecutionContext) {
    if (/^\/(?:api|mcp|ipfs|ipns)(?:\/|$)/u.test(new URL(request.url).pathname))
      return app.fetch(request, env, context);
    try {
      if (new URL(request.url).pathname === "/inspect") {
        await init(wasm);
        const image = await decodeWebp(await request.arrayBuffer());
        const colors = new Set<number>();
        let transparent = 0;
        let opaque = 0;
        for (let i = 0; i < image.data.length; i += 4) {
          if (image.data[i + 3]! < 250) transparent++;
          if (image.data[i + 3]! > 250) opaque++;
          colors.add(
            (image.data[i]! << 16) |
              (image.data[i + 1]! << 8) |
              image.data[i + 2]!,
          );
        }
        return Response.json({
          width: image.width,
          height: image.height,
          colors: colors.size,
          transparent,
          opaque,
        });
      }
      const start = performance.now();
      const result = await thumbnail(
        new Uint8Array(await request.arrayBuffer()),
      );
      return new Response(result.bytes, {
        headers: {
          "Content-Type": "image/webp",
          "X-Width": String(result.width),
          "X-Height": String(result.height),
          "X-Milliseconds": String(performance.now() - start),
        },
      });
    } catch (error) {
      return new Response(String(error), { status: 422 });
    }
  },
};
