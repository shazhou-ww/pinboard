import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "./migrations.js";
import { accountForGoogle, type Principal } from "../src/identity.js";
import { createToken } from "../src/tokens.js";
import type { Bindings } from "../src/env.js";
import type { ContentPreview, Pin } from "@shazhou/pinboard-contracts";
import { importFile } from "../src/content.js";
import { encodeCar } from "../src/car.js";
import { crc32, deflateSync } from "node:zlib";

let runtime: Miniflare;
let disposeRuntime: (() => Promise<void>) | undefined;
let token: string;
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
      "test/image-entry.ts",
      "--dry-run",
      "--outdir",
      "image-test-dist",
      "--name",
      "pinboard-image-test",
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      timeout: 90000,
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    },
  );
  const directory = new URL("../image-test-dist/", import.meta.url);
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        {
          type: "ESModule",
          path: fileURLToPath(new URL("image-entry.js", directory)),
        },
        ...(await readdir(directory))
          .filter((name) => name.endsWith(".wasm") || name.endsWith(".ttf"))
          .map((name) => ({
            type: name.endsWith(".wasm")
              ? ("CompiledWasm" as const)
              : ("Data" as const),
            path: fileURLToPath(new URL(name, directory)),
          })),
      ],
      compatibilityDate: "2026-10-14",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      r2Buckets: ["BLOCKS"],
      bindings: {
        APP_NAME: "Preview runtime test",
        PUBLIC_ORIGIN: "https://local.test",
        AUTH_SECRET: "synthetic-preview-test-only-not-a-real-secret",
      },
    }),
  );
  disposeRuntime = () => runtime.dispose();
  await runtime.ready;
  const env = await runtime.getBindings<Bindings>();
  await migrate(env.DB);
  const principal: Principal = {
    accountId: await accountForGoogle(env.DB, "runtime-preview-owner"),
    kind: "session",
    scopes: ["pins:read", "pins:write", "pins:delete"],
  };
  token = (
    await createToken(env, principal, {
      name: "test",
      scopes: principal.scopes,
      expiresInDays: 1,
    })
  ).token;
}, 120000);

afterAll(async () => {
  try {
    await disposeRuntime?.();
  } finally {
    await rm(new URL("../image-test-dist/", import.meta.url), {
      recursive: true,
      force: true,
    });
  }
});

it.each([
  ["photo.png", 480, 480],
  ["photo.jpg", 480, 480],
  ["portrait.jpg", 240, 480],
  ["transparent.png", 480, 320],
])(
  "encodes and independently decodes %s in workerd without an Images binding",
  async (name, width, height) => {
    const photo = await readFile(new URL(`fixtures/${name}`, import.meta.url));
    const result = await runtime.dispatchFetch("https://local.test/", {
      method: "POST",
      body: photo,
    });
    expect(result.status, await result.clone().text()).toBe(200);
    expect(result.headers.get("content-type")).toBe("image/webp");
    expect(Number(result.headers.get("x-width"))).toBe(width);
    expect(Number(result.headers.get("x-height"))).toBe(height);
    const bytes = new Uint8Array(await result.arrayBuffer());
    expect(bytes.length).toBeLessThanOrEqual(65536);
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WEBP");
    const decoded = await runtime.dispatchFetch("https://local.test/inspect", {
      method: "POST",
      body: bytes,
    });
    const inspection = (await decoded.json()) as {
      width: number;
      height: number;
      colors: number;
      transparent: number;
      opaque: number;
    };
    expect(inspection.width).toBe(width);
    expect(inspection.height).toBe(height);
    expect(inspection.colors).toBeGreaterThan(1000);
    expect(inspection.opaque).toBeGreaterThan(0);
    if (name === "transparent.png")
      expect(inspection.transparent).toBeGreaterThan(1000);
  },
);

it("rejects malformed, oversized and pixel-bomb images explicitly", async () => {
  const png = await readFile(
    new URL("fixtures/transparent.png", import.meta.url),
  );
  const oversized = png.slice();
  oversized.writeUInt32BE(50000, 16);
  for (const body of [
    oversized,
    png.subarray(0, 30),
    new Uint8Array(8 * 1024 * 1024 + 1),
  ]) {
    const result = await runtime.dispatchFetch("https://local.test/", {
      method: "POST",
      body,
    });

    expect(result.status).toBe(422);
  }
});

it("also decodes WebP originals rather than relying on filename extensions", async () => {
  const source = await readFile(
    new URL("fixtures/transparent.png", import.meta.url),
  );
  const first = await runtime.dispatchFetch("https://local.test/", {
    method: "POST",
    body: source,
  });

  const second = await runtime.dispatchFetch("https://local.test/", {
    method: "POST",
    body: new Uint8Array(await first.arrayBuffer()),
  });
  expect(second.status).toBe(200);
  expect(Number(second.headers.get("x-width"))).toBe(480);
  expect(Number(second.headers.get("x-height"))).toBe(320);
  const inspect = await runtime.dispatchFetch("https://local.test/inspect", {
    method: "POST",
    body: new Uint8Array(await second.arrayBuffer()),
  });
  expect(await inspect.json()).toMatchObject({ width: 480, height: 320 });
});

it("reduces genuinely high-entropy RGBA pixels until the encoded WebP fits the hard byte budget", async () => {
  const edge = 480;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(edge, 0);
  header.writeUInt32BE(edge, 4);
  header[8] = 8;
  header[9] = 6;
  const raster = Buffer.alloc((edge * 4 + 1) * edge);
  let seed = 42;
  for (let y = 0; y < edge; y++)
    for (let x = 1; x <= edge * 4; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      raster[y * (edge * 4 + 1) + x] = seed >>> 24;
    }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const content = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(content));
    return Buffer.concat([length, content, crc]);
  };
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raster)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const result = await runtime.dispatchFetch("https://local.test/", {
    method: "POST",
    body: png,
  });
  expect(result.status, await result.clone().text()).toBe(200);
  expect(Number(result.headers.get("x-width"))).toBeLessThan(480);
  const webp = new Uint8Array(await result.arrayBuffer());
  expect(webp.length).toBeLessThanOrEqual(65536);
  const decoded = await runtime.dispatchFetch("https://local.test/inspect", {
    method: "POST",
    body: webp,
  });
  expect(decoded.status).toBe(200);
  const inspection = (await decoded.json()) as {
    colors: number;
    transparent: number;
  };
  expect(inspection.colors).toBeGreaterThan(1000);
  expect(inspection.transparent).toBeGreaterThan(1000);
});

it("generates through the real authenticated API and MCP, with no preview-only account pins", async () => {
  const bytes = await readFile(new URL("fixtures/photo.jpg", import.meta.url));
  const authorization = `Bearer ${token}`;
  const upload = await runtime.dispatchFetch(
    "https://local.test/api/pins/upload?kind=file&name=private-secret-label.car",
    {
      method: "POST",
      headers: { authorization, "x-pinboard-public": "true" },
      body: bytes,
    },
  );
  expect(upload.status, await upload.clone().text()).toBe(201);
  const pin = (await upload.json()) as Pin;
  let descriptor: ContentPreview | undefined;
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await runtime.dispatchFetch(
      `https://local.test/api/pins/${pin.cid}/preview`,
      { headers: { authorization } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    descriptor = (await response.json()) as ContentPreview;
    if (descriptor.status !== "pending") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(descriptor!.status).toBe("ready");
  if (descriptor!.contentType !== "image/webp") throw new Error("not image");
  const image = await runtime.dispatchFetch(
    `https://local.test${descriptor!.content.url}`,
    { headers: { accept: "image/webp,*/*" } },
  );
  expect(image.headers.get("content-type")).toBe("image/webp");
  const imageBytes = new Uint8Array(await image.arrayBuffer());
  expect(imageBytes.byteLength).toBeLessThanOrEqual(65536);
  const decoded = await runtime.dispatchFetch("https://local.test/inspect", {
    method: "POST",
    body: imageBytes,
  });
  expect(decoded.status, await decoded.clone().text()).toBe(200);
  expect(await decoded.json()).toMatchObject({ width: 480, height: 480 });
  expect(JSON.stringify(descriptor)).not.toContain("private-secret-label");
  const unauthorized = await runtime.dispatchFetch(
    `https://local.test/api/pins/${pin.cid}/preview`,
  );
  expect(unauthorized.status).toBe(401);
  const list = await runtime.dispatchFetch("https://local.test/api/pins", {
    headers: { authorization },
  });
  const page = (await list.json()) as { pins: Pin[] };
  expect(page.pins.map((item) => item.cid)).toEqual([pin.cid]);
  expect(JSON.stringify(page)).not.toMatch(
    /blob|base64|descriptor|thumbnail/iu,
  );
  // Verified protocol CAR imports and raw blocks use exactly the same pipeline.
  const dag = await importFile(
    new TextEncoder().encode("a protocol-imported text file"),
  );
  const car = await runtime.dispatchFetch(
    "https://local.test/api/pins/upload?kind=car&name=misleading.png",
    {
      method: "POST",
      headers: { authorization, "x-pinboard-public": "true" },
      body: await encodeCar(dag),
    },
  );
  expect(car.status).toBe(201);
  const mcp = await runtime.dispatchFetch("https://local.test/mcp", {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "upload",
        arguments: {
          kind: "file",
          name: "mcp text",
          contentBase64: Buffer.from("actual MCP text").toString("base64"),
          public: true,
        },
      },
    }),
  });
  expect(mcp.status, await mcp.clone().text()).toBe(200);
  const rpc = (await mcp.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  expect(rpc.result.isError).not.toBe(true);
  const mcpPin = JSON.parse(rpc.result.content[0]!.text) as Pin;
  const mcpPreview = await runtime.dispatchFetch(
    `https://local.test/api/pins/${mcpPin.cid}/preview`,
    { headers: { authorization } },
  );
  expect(mcpPreview.status).toBe(200);
});
