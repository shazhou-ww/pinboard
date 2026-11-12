import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CarReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { key, type Dag } from "../src/content.js";
import type { Bindings } from "../src/env.js";
import { storeDag } from "../src/storage.js";
import { budgetDag } from "./gateway-scope-fixtures.js";
import { migrate } from "./migrations.js";
import { simplePdf } from "./pdf-fixtures.js";

let runtime: Miniflare;
let dag: Dag;
let socket: WebSocket;
let closeInspector: (() => void) | undefined;
let disposeRuntime: (() => Promise<void>) | undefined;
let rpc: (method: string) => Promise<Record<string, number>>;
beforeAll(async () => {
  await promisify(execFile)(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "../../../node_modules/wrangler/bin/wrangler.js",
          import.meta.url,
        ),
      ),
      "deploy",
      "test/gateway-runtime-entry.ts",
      "--dry-run",
      "--outdir",
      "gateway-test-dist",
      "--name",
      "pinboard-gateway-test",
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      timeout: 90000,
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    },
  );
  const directory = new URL("../gateway-test-dist/", import.meta.url);
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        {
          type: "ESModule",
          path: fileURLToPath(new URL("gateway-runtime-entry.js", directory)),
        },
        ...(await readdir(directory))
          .filter((name) => /\.(wasm|ttf)$/u.test(name))
          .map((name) => ({
            type: name.endsWith(".wasm")
              ? ("CompiledWasm" as const)
              : ("Data" as const),
            path: fileURLToPath(new URL(name, directory)),
          })),
      ],
      compatibilityDate: "2026-10-14",
      compatibilityFlags: ["nodejs_compat"],
      inspectorPort: 0,
      d1Databases: ["DB"],
      r2Buckets: ["BLOCKS"],
      bindings: {
        APP_NAME: "Gateway runtime test",
        PUBLIC_ORIGIN: "https://gateway.test",
        AUTH_SECRET: "synthetic-gateway-test-only-not-a-real-secret",
      },
    }),
  );
  disposeRuntime = () => runtime.dispose();
  await runtime.ready;
  const env = await runtime.getBindings<Bindings>();
  await migrate(env.DB);
  await env.DB.prepare(
    "INSERT INTO accounts (id, provider, subject) VALUES ('scope-owner', 'google', 'scope-owner')",
  ).run();
  dag = await budgetDag();
  await storeDag(env, dag);
  await env.DB.prepare(
    "INSERT INTO pins (account_id, cid, name, size, blocks, visibility) VALUES ('scope-owner', ?, 'Exact legal budget', ?, 256, 'public')",
  )
    .bind(key(dag.root), dag.size)
    .run();
  const inspector = await runtime.getInspectorURL();
  inspector.protocol = "http:";
  inspector.pathname = "/json/list";
  const targets = await (
    await fetch(inspector)
  ).json<{ webSocketDebuggerUrl: string }[]>();
  socket = new WebSocket(targets[0]!.webSocketDebuggerUrl);
  closeInspector = () => {
    socket.close();
  };
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener(
      "open",
      () => {
        resolve();
      },
      { once: true },
    );
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, number>) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as {
      id: number;
      result: Record<string, number>;
      error?: unknown;
    };
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    clearTimeout(callback.timeout);
    if (message.error)
      callback.reject(new Error(JSON.stringify(message.error)));
    else callback.resolve(message.result);
  });
  rpc = (method) =>
    new Promise((resolve, reject) => {
      const requestId = ++id;
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Inspector timeout: ${method}`));
      }, 10000);
      pending.set(requestId, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id: requestId, method }));
    });
}, 120000);

it("preflights only the necessary UnixFS range blocks in actual workerd", async () => {
  const left = new Uint8Array(65536).fill(1);
  const right = new Uint8Array(65536).fill(2);
  const leftCid = CID.createV1(0x55, await sha256.digest(left));
  const rightCid = CID.createV1(0x55, await sha256.digest(right));
  const bytes = dagPb.encode({
    Data: Uint8Array.from([
      8, 2, 24, 128, 128, 8, 32, 128, 128, 4, 32, 128, 128, 4,
    ]),
    Links: [
      { Hash: leftCid, Name: "" },
      { Hash: rightCid, Name: "" },
    ],
  });
  const root = CID.createV1(dagPb.code, await sha256.digest(bytes));
  const blocks = new Map([
    [key(root), bytes],
    [key(leftCid), left],
    [key(rightCid), right],
  ]);
  const env = await runtime.getBindings<Bindings>();
  await storeDag(env, {
    root,
    blocks,
    size: bytes.length + left.length + right.length,
  });
  await env.DB.prepare(
    "INSERT INTO pins (account_id, cid, name, size, blocks, visibility) VALUES ('scope-owner', ?, 'Partial worker fixture', ?, 3, 'public')",
  )
    .bind(key(root), bytes.length + left.length + right.length)
    .run();
  const measurements = [];
  let etag = "";
  for (const [method, conditional] of [
    ["GET", false],
    ["HEAD", false],
    ["GET", true],
  ] as const) {
    const response = await runtime.dispatchFetch(
      `https://gateway.test/ipfs/${key(root)}?format=car&entity-bytes=65536:65537`,
      { method, headers: conditional ? { "if-none-match": etag } : {} },
    );
    expect(response.status).toBe(conditional ? 304 : 200);
    etag = response.headers.get("etag")!;
    const cost = JSON.parse(response.headers.get("x-gateway-cost")!) as {
      d1: number;
      r2: number;
      payload: number;
    };
    expect(cost).toEqual({
      d1: 3,
      r2: 2,
      payload: bytes.length + right.length,
    });
    measurements.push({ method, conditional, cost });
    if (method === "GET" && !conditional) {
      const car = await CarReader.fromBytes(
        new Uint8Array(await response.arrayBuffer()),
      );
      const actual = [];
      for await (const block of car.blocks()) {
        expect((await sha256.digest(block.bytes)).digest).toEqual(
          block.cid.multihash.digest,
        );
        actual.push(key(block.cid));
        if (block.cid.equals(rightCid))
          expect(block.bytes.slice(0, 2)).toEqual(right.slice(0, 2));
      }
      expect(actual).toEqual([key(root), key(rightCid)]);
    } else expect(await response.text()).toBe("");
  }
  console.log(
    "Gateway partial-range workerd evidence",
    JSON.stringify(measurements),
  );
});
afterAll(async () => {
  closeInspector?.();
  await disposeRuntime?.();
  await rm(new URL("../gateway-test-dist/", import.meta.url), {
    recursive: true,
    force: true,
  });
});

it("serves exact legal budgets in initialized workerd with measured read cost and heap evidence", async () => {
  const initialized = await runtime.dispatchFetch(
    "https://gateway.test/render",
    {
      method: "POST",
      body: simplePdf(),
    },
  );
  expect(initialized.status, await initialized.clone().text()).toBe(200);
  await initialized.arrayBuffer();
  expect(
    await (await runtime.dispatchFetch("https://gateway.test/state")).json(),
  ).toMatchObject({
    nativeBytes: 32 * 1024 * 1024,
    occupied: false,
    hasSession: false,
    windows: 0,
  });
  const baseline = await rpc("Runtime.getHeapUsage");
  const measurements: unknown[] = [];
  let peak = baseline;
  const footprint = (sample: Record<string, number>) =>
    sample.totalSize! +
    (sample.backingStorageSize ?? 0) +
    (sample.embedderHeapUsedSize ?? 0) +
    32 * 1024 * 1024;
  for (const [method, conditional] of [
    ["GET", false],
    ["HEAD", false],
    ["GET", true],
  ] as const) {
    const samples: Promise<void>[] = [];
    const sampling = setInterval(() => {
      samples.push(
        rpc("Runtime.getHeapUsage").then((sample) => {
          if (footprint(sample) > footprint(peak)) peak = sample;
        }),
      );
    }, 50);
    let response: Awaited<ReturnType<typeof runtime.dispatchFetch>>;
    try {
      response = await runtime.dispatchFetch(
        `https://gateway.test/ipfs/${key(dag.root)}?format=car`,
        {
          method,
          headers: conditional ? { "if-none-match": "*" } : {},
        },
      );
    } finally {
      clearInterval(sampling);
      await Promise.all(samples);
    }
    expect(
      response.status,
      response.status >= 400 ? await response.text() : "",
    ).toBe(conditional ? 304 : 200);
    const cost = JSON.parse(response.headers.get("x-gateway-cost")!) as {
      d1: number;
      r2: number;
      payload: number;
    };
    expect(cost.r2).toBe(256);
    expect(cost.payload).toBe(32 * 1024 * 1024);
    expect(cost.d1).toBe(257);
    const preDrain = await rpc("Runtime.getHeapUsage");
    if (footprint(preDrain) > footprint(peak)) peak = preDrain;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (method === "GET" && !conditional) {
      expect(bytes.length).toBe(Number(response.headers.get("content-length")));
      expect(bytes.length).toBeGreaterThan(dag.size);
      const car = await CarReader.fromBytes(bytes);
      const actual = [];
      for await (const block of car.blocks()) {
        expect((await sha256.digest(block.bytes)).digest).toEqual(
          block.cid.multihash.digest,
        );
        actual.push(key(block.cid));
      }
      expect(actual).toEqual([
        key(dag.root),
        ...[...dag.blocks.keys()].filter((cid) => cid !== key(dag.root)),
      ]);
    } else expect(bytes.length).toBe(0);
    measurements.push({ method, conditional, cost, preDrain });
  }
  console.log(
    "Gateway exact-budget workerd evidence",
    JSON.stringify({
      baseline,
      sampledPeak: peak,
      sampledAccountedBytes: footprint(peak),
      nativeBytes: 32 * 1024 * 1024,
      measurements,
    }),
  );
  expect(footprint(peak)).toBeLessThan(128 * 1024 * 1024);
}, 120000);
