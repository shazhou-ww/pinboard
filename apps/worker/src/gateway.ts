import { Hono } from "hono";
import type { Bindings } from "./env.js";
import { key, parseCid, PROBE_CID } from "./content.js";
import { acceptsRaw, matchesEtag, onlyIfCached } from "./gateway-http.js";

export const gateway = new Hono<{ Bindings: Bindings }>();

gateway.on(["GET", "HEAD"], "/ipfs/:cid", async (c) => {
  const cid = parseCid(c.req.param("cid"));
  const format = c.req.query("format");
  const accept = c.req.header("accept");
  if (format === undefined && accept === undefined)
    return c.json({ error: "Request format=raw or an Accept header" }, 400);
  if (format !== undefined ? format !== "raw" : !acceptsRaw(accept!)) {
    return c.json(
      {
        error:
          "Raw blocks only; request ?format=raw or Accept: application/vnd.ipld.raw",
      },
      406,
    );
  }
  const headers = {
    "Content-Type": "application/vnd.ipld.raw",
    "Content-Disposition": `attachment; filename="${key(cid)}.bin"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "public, max-age=29030400, immutable",
    ETag: `"${key(cid)}.raw"`,
    "Access-Control-Allow-Origin": "*",
    "X-Ipfs-Path": `/ipfs/${c.req.param("cid")}`,
  };
  const notModified = matchesEtag(c.req.header("if-none-match"), headers.ETag);
  const missing = () =>
    c.json(
      { error: "Block not found" },
      onlyIfCached(c.req.header("cache-control")) ? 412 : 404,
    );
  const metadataOnly = c.req.method === "HEAD" || notModified;
  const probe = key(cid) === PROBE_CID;
  if (probe || metadataOnly) {
    const object = probe ? { size: 0 } : await c.env.BLOCKS.head(key(cid));
    if (!object) return missing();
    const responseHeaders = {
      ...headers,
      "Content-Length": String(object.size),
    };
    if (notModified)
      return new Response(null, { status: 304, headers: responseHeaders });
    return new Response(null, { headers: responseHeaders });
  }
  const object = await c.env.BLOCKS.get(key(cid));
  if (!object) return missing();
  return new Response(object.body, {
    headers: { ...headers, "Content-Length": String(object.size) },
  });
});

gateway.get("/routing/v1/providers/:cid", async (c) => {
  const cid = parseCid(c.req.param("cid"));
  const exists = key(cid) === PROBE_CID || (await c.env.BLOCKS.head(key(cid)));
  const providers = exists
    ? [
        {
          Schema: "peer",
          ID: c.env.PROVIDER_ID,
          Addrs: [c.env.PROVIDER_MULTIADDR],
          Protocols: ["transport-ipfs-gateway-http"],
        },
      ]
    : [];
  c.header("Cache-Control", "public, max-age=60");
  c.header("Access-Control-Allow-Origin", "*");
  if (c.req.header("accept")?.includes("application/x-ndjson")) {
    return c.body(
      providers.map((provider) => JSON.stringify(provider) + "\n").join(""),
      200,
      {
        "Content-Type": "application/x-ndjson",
      },
    );
  }
  return c.json({ Providers: providers });
});
