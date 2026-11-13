import { authHandler, initAuthConfig, verifyAuth } from "@hono/auth-js";
import type { Session } from "@auth/core/types";
import type {
  BootstrapResponse,
  HealthResponse,
  SessionResponse,
} from "@shazhou/pinboard-contracts";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";

import { createAuthConfig, getConfiguredProviders } from "./auth.js";
import type { Bindings } from "./env.js";
import { api } from "./api.js";
import { gateway } from "./gateway.js";
import { ipnsGateway } from "./ipns-gateway.js";
import { runIpnsRenewal } from "./ipns.js";
import { key, parseCid } from "./content.js";
import { getCar } from "./storage.js";
import { downloadContent } from "./download.js";
import { runRetention } from "./retention.js";
import { runPreviews } from "./previews.js";
import { oauth } from "./oauth.js";
import { requireSessionAccount, type AppEnv } from "./identity.js";
import { authorizeBlock, canReadBlock, optionalIdentity } from "./access.js";

const app = new Hono<AppEnv>();

app.use("*", secureHeaders());
app.use(
  "*",
  initAuthConfig((context) => createAuthConfig(context.env as Bindings)),
);
app.onError((error, context) => {
  if (error instanceof HTTPException)
    return context.json({ error: error.message }, error.status);
  console.error(
    JSON.stringify({
      event: "request_failed",
      path: context.req.path,
      message: error.message,
    }),
  );
  return context.json({ error: "Internal server error" }, 500);
});
app.route("/", gateway);
app.route("/", ipnsGateway);
app.use("/api/public/*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});
app.get("/api/public/:cid/access", async (c) => {
  await authorizeBlock(c.env, c.req.param("cid"), await optionalIdentity(c));
  c.header(
    "X-Pinboard-Byte-Access",
    (await canReadBlock(c.env, c.req.param("cid"))) ? "public" : "private",
  );
  return c.body(null, 204);
});
app.get("/api/public/:cid/download", async (c) => {
  await authorizeBlock(c.env, c.req.param("cid"), await optionalIdentity(c));
  const response = await downloadContent(
    c.env,
    c.req.param("cid"),
    c.req.raw,
    c.req.query("name"),
  );
  response.headers.set("Cache-Control", "private, no-store");
  return response;
});
app.get("/api/public/:cid/car", async (c) => {
  const root = parseCid(c.req.param("cid"));
  await authorizeBlock(c.env, key(root), await optionalIdentity(c));
  const car = await getCar(c.env, key(root));
  if (!car) return c.json({ error: "DAG not found" }, 404);
  return new Response(car.body, {
    headers: {
      "Content-Type": "application/vnd.ipld.car; version=1",
      "Cache-Control": "private, no-store",
      "Content-Length": String(car.size),
      "Content-Disposition": `attachment; filename="${key(root)}.car"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
app.use("/api/auth/*", authHandler());
app.route("/", oauth);

app.get("/api/health", (context) =>
  context.json<HealthResponse>({
    service: context.env.APP_NAME,
    status: "ok",
  }),
);

app.get("/api/bootstrap", (context) =>
  context.json<BootstrapResponse>({
    appName: context.env.APP_NAME,
    providers: getConfiguredProviders(context.env),
  }),
);

app.use("/api/me", verifyAuth());
app.get("/api/me", async (context) => {
  const user = context.get("authUser");
  await requireSessionAccount(context.env.DB, user.token?.accountId);
  const session = user.session;
  return context.json(toSessionResponse(session));
});
app.route("/", api);

app.notFound((context) =>
  context.json(
    {
      error: "Not found",
    },
    404,
  ),
);

export default Object.assign(app, {
  async scheduled(
    _controller: ScheduledController,
    env: Bindings,
  ): Promise<void> {
    await Promise.all([runRetention(env), runPreviews(env), runIpnsRenewal(env)]);
  },
});

export function toSessionResponse(session: Session): SessionResponse {
  return {
    expires: session.expires,
    ...(session.user ? { user: session.user } : {}),
  };
}
