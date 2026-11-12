import pdfEntry from "./pdf-entry.js";
import type { Bindings } from "../src/env.js";

export default {
  async fetch(request: Request, env: Bindings, context: ExecutionContext) {
    if (!new URL(request.url).pathname.startsWith("/ipfs/"))
      return pdfEntry.fetch(
        request,
        env as Parameters<typeof pdfEntry.fetch>[1],
        context,
      );
    const stats = { d1: 0, r2: 0, payload: 0 };
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            stats.d1++;
            return target.prepare(sql);
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function"
          ? (value.bind(target) as unknown)
          : value;
      },
    });
    const bucket = new Proxy(env.BLOCKS, {
      get(target, property) {
        if (property === "get")
          return async (...args: Parameters<typeof target.get>) => {
            stats.r2++;
            const result = await target.get(...args);
            if (result && "body" in result)
              stats.payload +=
                result.range && "length" in result.range
                  ? result.range.length
                  : result.size;
            return result;
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function"
          ? (value.bind(target) as unknown)
          : value;
      },
    });
    const response = await pdfEntry.fetch(
      request,
      { ...env, DB: db, BLOCKS: bucket } as Parameters<
        typeof pdfEntry.fetch
      >[1],
      context,
    );
    const headers = new Headers(response.headers);
    headers.set("x-gateway-cost", JSON.stringify(stats));
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  },
};
