import { Hono } from "hono";
import type { AppEnv } from "./identity.js";
import { optionalIdentity } from "./access.js";
import { matchesEtag, mediaQuality, parseAccept } from "./gateway-http.js";
import { checkedIpnsBytes, parseIpnsName, renewIpns, type IpnsBinding } from "./ipns.js";
import { HTTPException } from "hono/http-exception";

const mediaType = "application/vnd.ipfs.ipns-record";
export const ipnsGateway = new Hono<AppEnv>();
ipnsGateway.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});
ipnsGateway.on(["GET", "HEAD"], ["/ipns/:name", "/ipns/:name/*"], async (c) => {
  const name = c.req.param("name");
  parseIpnsName(name);
  const principal = await optionalIdentity(c);
  const read = () => c.env.DB.prepare(
    `SELECT i.*, p.visibility FROM publication_ipns i
    JOIN publications p ON p.id = i.publication_id
    JOIN publication_revisions r ON r.publication_id = p.id AND r.revision = p.current_revision
    WHERE i.name = ? AND p.deleted_at IS NULL AND r.cid = i.record_cid
    AND (p.visibility = 'public' OR (p.account_id = ? AND ?))`,
  ).bind(name, principal?.accountId ?? "",
    principal?.scopes.includes("publications:read") ? 1 : 0)
    .first<IpnsBinding & { visibility: string }>();
  let row = await read();
  if (!row) throw new HTTPException(404, { message: "Content unavailable" });
  const url = new URL(c.req.url);
  if (url.pathname !== `/ipns/${name}` ||
    [...url.searchParams.keys()].some((key) => key !== "format") ||
    url.searchParams.getAll("format").length > 1)
    throw new HTTPException(406, { message: "IPNS paths and query parameters are unsupported" });
  const format = url.searchParams.get("format");
  if (format !== null ? format !== "ipns-record" :
    !c.req.header("accept") || mediaQuality(parseAccept(c.req.header("accept")!), mediaType).q <= 0)
    throw new HTTPException(406, { message: "Request format=ipns-record or Accept: application/vnd.ipfs.ipns-record" });
  if (row.expires_at <= Date.now()) {
    await renewIpns(c.env, row);
    // Reauthorize and read the actual committed winner, including concurrent delete/change.
    row = await read();
    if (!row) throw new HTTPException(404, { message: "Content unavailable" });
  }
  const bytes = await checkedIpnsBytes(row);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const etag = `"${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
  const headers: Record<string, string> = {
    "Content-Type": mediaType,
    "Content-Length": String(bytes.length),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Disposition": `attachment; filename="${name}.ipns-record"`,
    "X-Ipfs-Path": `/ipns/${name}`,
    ETag: etag,
    Vary: "Accept, Authorization, Cookie",
  };
  if (row.visibility === "public" && !principal && !c.req.header("cookie") && !c.req.header("authorization"))
    headers["Access-Control-Allow-Origin"] = "*";
  const notModified = matchesEtag(c.req.header("if-none-match"), etag);
  return new Response(c.req.method === "HEAD" || notModified ? null : bytes, {
    status: notModified ? 304 : 200, headers,
  });
});
