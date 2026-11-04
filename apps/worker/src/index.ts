import { authHandler, initAuthConfig, verifyAuth } from "@hono/auth-js";
import type { Session } from "@auth/core/types";
import type {
  BootstrapResponse,
  HealthResponse,
  SessionResponse,
} from "@workspace/contracts";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";

import { createAuthConfig, getConfiguredProviders } from "./auth.js";
import type { Bindings } from "./env.js";
import { api } from "./api.js";
import { gateway } from "./gateway.js";
import { key, parseCid } from "./content.js";
import { getCar } from "./storage.js";
import { runRetention } from "./retention.js";

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", secureHeaders());
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
app.get("/api/public/:cid/car", async (c) => {
  const root = parseCid(c.req.param("cid"));
  const car = await getCar(c.env, key(root));
  if (!car) return c.json({ error: "DAG not found" }, 404);
  return new Response(car.body, {
    headers: {
      "Content-Type": "application/vnd.ipld.car; version=1",
      "Content-Length": String(car.size),
      "Content-Disposition": `attachment; filename="${key(root)}.car"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
app.use(
  "*",
  initAuthConfig((context) => createAuthConfig(context.env as Bindings)),
);

app.use("/api/auth/*", authHandler());

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
app.get("/api/me", (context) => {
  const session = context.get("authUser").session;
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
    await runRetention(env);
  },
});

export function toSessionResponse(session: Session): SessionResponse {
  return {
    expires: session.expires,
    ...(session.user ? { user: session.user } : {}),
  };
}
