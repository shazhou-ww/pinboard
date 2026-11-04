import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { boundedBody, readCar } from "../src/content.js";
import { storeDag } from "../src/storage.js";
import type { Bindings } from "../src/env.js";
import { gateway } from "../src/gateway.js";

// Local test entry only. Production never mounts this unauthenticated uploader.
const app = new Hono<{ Bindings: Bindings }>();
app.route("/", gateway);
app.post("/poc/car", async (c) => {
  const dag = await readCar(await boundedBody(c.req.raw));
  await storeDag(c.env, dag);
  return c.json({
    cid: dag.root.toString(),
    blocks: dag.blocks.size,
    size: dag.size,
  });
});
app.onError((error, c) => {
  console.error(error);
  return c.json(
    { error: error.message },
    error instanceof HTTPException ? error.status : 500,
  );
});
export default app;
