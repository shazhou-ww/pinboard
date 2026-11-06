import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "./identity.js";
import { hashToken, requireIdentity } from "./identity.js";
import {
  PublicationService,
  publicationHistory,
  readPublication,
  resolvePublication,
} from "./publications.js";
import { listDeleted, restorePin } from "./recently-deleted.js";
import { boundedBody } from "./content.js";
import { publishedDescription } from "./descriptions.js";
import { getCar } from "./storage.js";
import { getPreview, processPreview } from "./previews.js";
import {
  jsonBody,
  publicationCreateSchema,
  publicationPublishSchema,
  publicationRollbackSchema,
  publicationWriteSchema,
  validate,
} from "./schemas.js";

export const publicationApi = new Hono<AppEnv>();
publicationApi.use("/api/public/publications/*", async (c, next) => {
  c.header("Cache-Control", "public, no-cache");
  await next();
});
publicationApi.get(
  "/api/public/publications/:id/versions/:revision/nodes/:node/description",
  async (c) => {
    const result = await publishedDescription(
      c.env,
      c.req.param("id"),
      Number(c.req.param("revision")),
      c.req.param("node"),
    );
    const preview = result.description.preview;
    if (preview.status === "pending" || preview.status === "failed")
      c.executionCtx.waitUntil(processPreview(c.env, result.nodeCid));
    const body = JSON.stringify(result);
    const etag = `"${await hashToken("publication-node-v1:" + body)}"`;
    c.header("ETag", etag);
    c.header("Content-Type", "application/json; charset=UTF-8");
    if (
      c.req
        .header("if-none-match")
        ?.split(",")
        .some(
          (value) =>
            value.trim() === "*" || value.trim().replace(/^W\//, "") === etag,
        )
    )
      return c.body(null, 304);
    return c.body(body);
  },
);
publicationApi.get(
  "/api/public/publications/:id/preview/:revision",
  async (c) => {
    const { publication, revision } = await resolvePublication(
      c.env,
      c.req.param("id"),
      Number(c.req.param("revision")),
    );
    const preview = await getPreview(c.env, revision.cid);
    if (preview.status === "pending" || preview.status === "failed")
      c.executionCtx.waitUntil(processPreview(c.env, revision.cid));
    const body = JSON.stringify(preview);
    const etag = `"${await hashToken(`publication-preview-v1:${publication.sequence}:` + body)}"`;
    c.header("Cache-Control", "public, no-cache");
    c.header("ETag", etag);
    c.header("Content-Type", "application/json; charset=UTF-8");
    if (
      c.req
        .header("if-none-match")
        ?.split(",")
        .some(
          (value) =>
            value.trim() === "*" || value.trim().replace(/^W\//, "") === etag,
        )
    )
      return c.body(null, 304);
    return c.body(body);
  },
);
publicationApi.get("/api/public/publications/:id/:view?", async (c, next) => {
  const view = c.req.param("view");
  if (view && view !== "history") return next();
  const body = JSON.stringify(
    view === "history"
      ? await publicationHistory(c.env, c.req.param("id"))
      : await readPublication(c.env, c.req.param("id")),
  );
  const etag = `"${await hashToken("publication-json-v1:" + body)}"`;
  c.header("Cache-Control", "public, no-cache");
  c.header("ETag", etag);
  c.header("Content-Type", "application/json; charset=UTF-8");
  if (
    c.req
      .header("if-none-match")
      ?.split(",")
      .some(
        (value) =>
          value.trim() === "*" || value.trim().replace(/^W\//, "") === etag,
      )
  )
    return c.body(null, 304);
  return c.body(body);
});
publicationApi.get(
  "/api/public/publications/:id/versions/:revision",
  async (c) => {
    const resolved = await resolvePublication(
      c.env,
      c.req.param("id"),
      Number(c.req.param("revision")),
    );
    const body = JSON.stringify(resolved);
    const etag = `"${await hashToken("publication-fixed-json-v1:" + body)}"`;
    c.header("Cache-Control", "public, no-cache");
    c.header("ETag", etag);
    c.header("Content-Type", "application/json; charset=UTF-8");
    if (
      c.req
        .header("if-none-match")
        ?.split(",")
        .some(
          (value) =>
            value.trim() === "*" || value.trim().replace(/^W\//, "") === etag,
        )
    )
      return c.body(null, 304);
    return c.body(body);
  },
);
publicationApi.get(
  "/api/public/publications/:id/download/:revision?",
  async (c) => {
    const fixed = c.req.param("revision");
    const { publication, revision } = await resolvePublication(
      c.env,
      c.req.param("id"),
      fixed ? Number(fixed) : undefined,
    );
    const car = await getCar(c.env, revision.cid);
    if (!car)
      throw new HTTPException(503, { message: "Revision content unavailable" });
    const etag = `"${await hashToken(`publication-car-v1:${publication.sequence}:${revision.cid}:${car.etag}`)}"`;
    if (
      c.req
        .header("if-none-match")
        ?.split(",")
        .some(
          (value) =>
            value.trim() === "*" || value.trim().replace(/^W\//, "") === etag,
        )
    ) {
      if (car.body instanceof ReadableStream) await car.body.cancel();
      return new Response(null, {
        status: 304,
        headers: { ETag: etag, "Cache-Control": "public, no-cache" },
      });
    }
    return new Response(car.body, {
      headers: {
        "Cache-Control": "public, no-cache",
        "Content-Type": "application/vnd.ipld.car; version=1",
        "Content-Length": String(car.size),
        "Content-Disposition": `attachment; filename="${revision.cid}.car"`,
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
        ETag: etag,
      },
    });
  },
);
publicationApi.use("/api/publications", requireIdentity);
publicationApi.use("/api/publications/*", requireIdentity);
publicationApi.use("/api/recently-deleted", requireIdentity);
publicationApi.get("/api/publications", async (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await new PublicationService(c.env, c.get("principal")).list(
      validate(z.string().max(256).optional(), c.req.query("cursor")),
    ),
  );
});
publicationApi.post("/api/publications", async (c) => {
  const input = validate(publicationCreateSchema, await jsonBody(c.req.raw));
  return c.json(
    await new PublicationService(c.env, c.get("principal")).create(
      input.title,
      input.cid,
      input.requestId,
    ),
    201,
  );
});
publicationApi.post("/api/pins/:cid/convert", requireIdentity, async (c) => {
  const input = validate(
    publicationCreateSchema.omit({ cid: true }),
    await jsonBody(c.req.raw),
  );
  return c.json(
    await new PublicationService(c.env, c.get("principal")).create(
      input.title,
      c.req.param("cid"),
      input.requestId,
      true,
    ),
    201,
  );
});
publicationApi.get("/api/publications/:id", async (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await new PublicationService(c.env, c.get("principal")).owned(
      c.req.param("id"),
    ),
  );
});
publicationApi.post("/api/publications/:id/publish", async (c) => {
  const input = validate(publicationPublishSchema, await jsonBody(c.req.raw));
  return c.json(
    await new PublicationService(c.env, c.get("principal")).publish(
      c.req.param("id"),
      input.cid,
      input,
    ),
  );
});
publicationApi.post("/api/publications/:id/rollback", async (c) => {
  const input = validate(publicationRollbackSchema, await jsonBody(c.req.raw));
  return c.json(
    await new PublicationService(c.env, c.get("principal")).rollback(
      c.req.param("id"),
      input.revision,
      input,
    ),
  );
});
publicationApi.delete("/api/publications/:id", async (c) => {
  await new PublicationService(c.env, c.get("principal")).delete(
    c.req.param("id"),
  );
  return c.body(null, 204);
});
publicationApi.post("/api/publications/:id/restore", async (c) =>
  c.json(
    await new PublicationService(c.env, c.get("principal")).restore(
      c.req.param("id"),
    ),
  ),
);
publicationApi.get("/api/recently-deleted", async (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await listDeleted(
      c.env,
      c.get("principal"),
      validate(z.string().max(512).optional(), c.req.query("cursor")),
    ),
  );
});
publicationApi.post("/api/publications/:id/upload", async (c) => {
  if (c.req.header("x-pinboard-public") !== "true")
    throw new HTTPException(400, {
      message: "Acknowledge public content with X-Pinboard-Public: true",
    });
  const write = validate(publicationWriteSchema, {
    requestId: c.req.header("idempotency-key"),
    expectedSequence: Number(c.req.header("if-publication-sequence")),
  });
  const kind = validate(z.enum(["file", "car", "block"]), c.req.query("kind"));
  const name = validate(
    z.string().trim().min(1).max(200).default("Untitled"),
    c.req.query("name"),
  );
  const result = await new PublicationService(c.env, c.get("principal")).upload(
    c.req.param("id"),
    write,
    await boundedBody(c.req.raw),
    kind,
    name,
    c.req.query("cid"),
    (work) => {
      c.executionCtx.waitUntil(work);
    },
  );
  return c.json(result, "partialSuccess" in result ? 207 : 201);
});
publicationApi.post("/api/pins/:cid/restore", requireIdentity, async (c) => {
  await restorePin(c.env, c.get("principal"), c.req.param("cid"));
  return c.json({ restored: true });
});
