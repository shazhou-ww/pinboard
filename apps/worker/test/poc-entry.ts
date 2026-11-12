import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { boundedBody, key, readCar } from "../src/content.js";
import { storeDag } from "../src/storage.js";
import type { Bindings } from "../src/env.js";
import { gateway } from "../src/gateway.js";
import { accountForGoogle } from "../src/identity.js";

// Local test entry only. Production never mounts this unauthenticated uploader.
const app = new Hono<{ Bindings: Bindings }>();
app.route("/", gateway);
app.post("/poc/car", async (c) => {
  const dag = await readCar(await boundedBody(c.req.raw));
  await storeDag(c.env, dag);
  const account = await accountForGoogle(c.env.DB, "kubo-local-poc");
  await c.env.DB.prepare(
    "INSERT INTO pins (account_id, cid, name, size, blocks, visibility) VALUES (?, ?, 'Kubo local fixture', ?, ?, 'public') ON CONFLICT(account_id, cid) DO UPDATE SET visibility = 'public'",
  )
    .bind(account, key(dag.root), dag.size, dag.blocks.size)
    .run();
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
