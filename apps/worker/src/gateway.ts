import { Hono } from "hono";
import type { AppEnv } from "./identity.js";
import { authorizeBlock, canReadBlock, optionalIdentity } from "./access.js";
import { key, parseCid, PROBE_CID } from "./content.js";
import {
  acceptsMedia,
  acceptsRaw,
  matchesEtag,
  onlyIfCached,
} from "./gateway-http.js";
import { blobBytes, getBlock, headBlock, type D1Blob } from "./storage.js";

export const gateway = new Hono<AppEnv>();
gateway.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});

gateway.on(["GET", "HEAD"], "/ipfs/:cid", async (c) => {
  const cid = parseCid(c.req.param("cid"));
  if (key(cid) !== PROBE_CID)
    await authorizeBlock(c.env, key(cid), await optionalIdentity(c));
  const format = c.req.query("format");
  const accept = c.req.header("accept");
  if (
    format === undefined &&
    (accept === undefined ||
      (acceptsMedia(accept, "image/webp") &&
        !(
          accept.toLowerCase().includes("application/vnd.ipld.raw") &&
          acceptsRaw(accept)
        )))
  ) {
    const image = await c.env.DB.prepare(
      "SELECT bytes FROM preview_images WHERE cid = ?",
    )
      .bind(key(cid))
      .first<{ bytes: D1Blob }>();
    if (image) {
      const bytes = blobBytes(image.bytes);
      const headers = {
        "Content-Type": "image/webp",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        ETag: `"${key(cid)}.webp"`,
        "X-Ipfs-Path": `/ipfs/${key(cid)}`,
      };
      return new Response(
        c.req.method === "HEAD" ||
          matchesEtag(c.req.header("if-none-match"), headers.ETag)
          ? null
          : bytes,
        {
          status: matchesEtag(c.req.header("if-none-match"), headers.ETag)
            ? 304
            : 200,
          headers,
        },
      );
    }
  }
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
    "Cache-Control": "private, no-store",
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
    const object = probe ? { size: 0 } : await headBlock(c.env, key(cid));
    if (!object) return missing();
    const responseHeaders = {
      ...headers,
      "Content-Length": String(object.size),
    };
    if (notModified)
      return new Response(null, { status: 304, headers: responseHeaders });
    return new Response(null, { headers: responseHeaders });
  }
  const object = await getBlock(c.env, key(cid));
  if (!object) return missing();
  return new Response(object.body, {
    headers: { ...headers, "Content-Length": String(object.size) },
  });
});

gateway.get("/routing/v1/providers/:cid", async (c) => {
  const cid = parseCid(c.req.param("cid"));
  const exists =
    key(cid) === PROBE_CID ||
    ((await canReadBlock(c.env, key(cid), await optionalIdentity(c))) &&
      (await headBlock(c.env, key(cid))));
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
  c.header("Cache-Control", "private, no-store");
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
