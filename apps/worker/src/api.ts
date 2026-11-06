import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { boundedBody } from "./content.js";
import {
  authenticate,
  checkOrigin,
  requireIdentity,
  type AppEnv,
} from "./identity.js";
import { handleMcp } from "./mcp.js";
import { PinService } from "./service.js";
import { jsonBody, pinSchema, renamePinSchema, validate } from "./schemas.js";
import { createToken, listTokens, revokeToken } from "./tokens.js";
import { oauthOrigin } from "./oauth.js";
import { getPreview, processPreview, processPreviewBatch } from "./previews.js";
import { previewBatchLimit } from "@shazhou/pinboard-contracts";
import { publicationApi } from "./publication-api.js";
import { DescriptionService, descriptionWriteSchema } from "./descriptions.js";

export const api = new Hono<AppEnv>();
api.use("*", async (c, next) => {
  // MCP never accepts cookies; anonymous initialization must reach its 401 challenge.
  checkOrigin(c, c.req.path !== "/mcp");
  await next();
});
api.route("/", publicationApi);
api.use("/api/pins/*", requireIdentity);
api.use("/api/pins", requireIdentity);
api.get("/api/pins", async (c) =>
  c.json(
    await new PinService(c.env, c.get("principal")).list(
      validate(z.string().max(256).optional(), c.req.query("cursor")),
    ),
  ),
);
api.post("/api/pins/previews", async (c) => {
  const input = validate(
    z
      .object({
        cids: z.array(z.string().min(1).max(256)).min(1).max(previewBatchLimit),
      })
      .strict(),
    await jsonBody(c.req.raw),
  );
  const result = await new PinService(c.env, c.get("principal")).previews(
    input.cids,
  );
  const pending = result.previews.filter(
    (item) =>
      "preview" in item &&
      (item.preview.status === "pending" || item.preview.status === "failed"),
  );
  if (pending.length)
    c.executionCtx.waitUntil(
      processPreviewBatch(
        c.env,
        pending.map((item) => item.cid),
      ),
    );
  c.header("Cache-Control", "private, no-store");
  return c.json(result);
});
api.post("/api/pins", async (c) => {
  const input = validate(pinSchema, await jsonBody(c.req.raw));
  return c.json(
    await new PinService(c.env, c.get("principal"), (work) => {
      c.executionCtx.waitUntil(work);
    }).pin(input.cid, input.name),
    201,
  );
});
api.post("/api/pins/upload", async (c) => {
  if (c.req.header("x-pinboard-public") !== "true")
    throw new HTTPException(400, {
      message: "Acknowledge public content with X-Pinboard-Public: true",
    });
  const kind = validate(z.enum(["file", "car", "block"]), c.req.query("kind"));
  const name = validate(
    z.string().trim().min(1).max(200).default("Untitled"),
    c.req.query("name"),
  );
  return c.json(
    await new PinService(c.env, c.get("principal"), (work) => {
      c.executionCtx.waitUntil(work);
    }).upload(await boundedBody(c.req.raw), kind, name, c.req.query("cid")),
    201,
  );
});
api.get("/api/pins/:cid", async (c) =>
  c.json(
    await new PinService(c.env, c.get("principal")).detail(c.req.param("cid")),
  ),
);
api.get("/api/pins/:cid/descriptions", async (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await new DescriptionService(c.env, c.get("principal")).export(
      c.req.param("cid"),
    ),
  );
});
api.get("/api/pins/:cid/nodes/:node/description", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const result = await new DescriptionService(c.env, c.get("principal")).read(
    c.req.param("cid"),
    c.req.param("node"),
  );
  if (
    result.description.preview.status === "pending" ||
    result.description.preview.status === "failed"
  )
    c.executionCtx.waitUntil(processPreview(c.env, result.nodeCid));
  return c.json(result);
});
api.put("/api/pins/:cid/nodes/:node/description", async (c) => {
  const input = validate(descriptionWriteSchema, await jsonBody(c.req.raw));
  c.header("Cache-Control", "private, no-store");
  const result = await new DescriptionService(c.env, c.get("principal")).write(
    c.req.param("cid"),
    c.req.param("node"),
    input,
  );
  if (
    result.description.preview.status === "pending" ||
    result.description.preview.status === "failed"
  )
    c.executionCtx.waitUntil(processPreview(c.env, result.nodeCid));
  return c.json(result);
});
api.get("/api/pins/:cid/preview", async (c) => {
  const pin = await new PinService(c.env, c.get("principal")).detail(
    c.req.param("cid"),
  );
  const preview = await getPreview(c.env, pin.cid);
  if (preview.status === "pending" || preview.status === "failed")
    c.executionCtx.waitUntil(processPreview(c.env, pin.cid));
  c.header("Cache-Control", "private, no-store");
  return c.json(preview);
});
api.delete("/api/pins/:cid", async (c) => {
  await new PinService(c.env, c.get("principal")).unpin(c.req.param("cid"));
  return c.body(null, 204);
});
api.patch("/api/pins/:cid", async (c) => {
  const input = validate(renamePinSchema, await jsonBody(c.req.raw));
  return c.json(
    await new PinService(c.env, c.get("principal")).rename(
      c.req.param("cid"),
      input.name,
    ),
  );
});
const tokenIdentity: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("principal", await authenticate(c, true));
  await next();
};
api.use("/api/tokens/*", tokenIdentity);
api.use("/api/tokens", tokenIdentity);
api.get("/api/tokens", async (c) =>
  c.json({
    tokens: await listTokens(
      c.env,
      c.get("principal"),
      validate(
        z.enum(["active", "history"]).default("active"),
        c.req.query("view"),
      ) === "history",
    ),
  }),
);
api.post("/api/tokens", async (c) =>
  c.json(
    await createToken(c.env, c.get("principal"), await jsonBody(c.req.raw)),
    201,
  ),
);
api.delete("/api/tokens/:id", async (c) => {
  await revokeToken(c.env, c.get("principal"), c.req.param("id"));
  return c.body(null, 204);
});
api.all("/mcp", async (c) => {
  let principal;
  try {
    if (!c.req.header("authorization"))
      throw new HTTPException(401, { message: "Bearer token required" });
    principal = await authenticate(c);
  } catch (error) {
    if (!(error instanceof HTTPException) || error.status !== 401) throw error;
    return c.json({ error: "Bearer token required, expired or revoked" }, 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${oauthOrigin(c.env)}/.well-known/oauth-protected-resource/mcp", scope="pins:read"`,
      "Cache-Control": "no-store",
    });
  }
  if (c.req.method !== "POST")
    return c.json({ error: "Stateless MCP supports POST only" }, 405, {
      Allow: "POST",
    });
  return handleMcp(c.req.raw, c.env, principal, (work) => {
    c.executionCtx.waitUntil(work);
  });
});
