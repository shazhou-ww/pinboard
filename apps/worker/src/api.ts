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

export const api = new Hono<AppEnv>();
api.use("*", async (c, next) => {
  checkOrigin(c);
  await next();
});
api.use("/api/pins/*", requireIdentity);
api.use("/api/pins", requireIdentity);
api.get("/api/pins", async (c) =>
  c.json(
    await new PinService(c.env, c.get("principal")).list(
      validate(z.string().max(256).optional(), c.req.query("cursor")),
    ),
  ),
);
api.post("/api/pins", async (c) => {
  const input = validate(pinSchema, await jsonBody(c.req.raw));
  return c.json(
    await new PinService(c.env, c.get("principal")).pin(input.cid, input.name),
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
    await new PinService(c.env, c.get("principal")).upload(
      await boundedBody(c.req.raw),
      kind,
      name,
      c.req.query("cid"),
    ),
    201,
  );
});
api.get("/api/pins/:cid", async (c) =>
  c.json(
    await new PinService(c.env, c.get("principal")).detail(c.req.param("cid")),
  ),
);
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
  if (!c.req.header("authorization"))
    throw new HTTPException(401, { message: "Agent Bearer token required" });
  const principal = await authenticate(c);
  if (c.req.method !== "POST")
    return c.json({ error: "Stateless MCP supports POST only" }, 405, {
      Allow: "POST",
    });
  return handleMcp(c.req.raw, c.env, principal);
});
