import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { beforeAll, afterAll, expect, it } from "vitest";
import {
  simplePdf,
  largeSecondPagePdf,
  cjkPdf,
  embeddedCjkPdf,
  imagePdf,
  passwordPdf,
  maximumRgbaPng,
} from "./pdf-fixtures.js";
import { migrate } from "./migrations.js";
import { importFile, key } from "../src/content.js";
import { storeDag } from "../src/storage.js";
import type { Bindings } from "../src/env.js";
import { glyphSimilarity } from "./pdf-glyph-reference.js";
import { accountForGoogle, type Principal } from "../src/identity.js";
import { createToken } from "../src/tokens.js";
import { PinService } from "../src/service.js";
import { PublicationService } from "../src/publications.js";
import { scopes } from "../src/schemas.js";
import type {
  ContentPreview,
  NodeDescription,
} from "@shazhou/pinboard-contracts";

let runtime: Miniflare;
let disposeRuntime: (() => Promise<void>) | undefined;
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const heldReads = new Map<
  string,
  {
    entered: ReturnType<typeof gate<void>>;
    release: ReturnType<typeof gate<number>>;
    abort: ReturnType<typeof gate<void>>;
    cancelled: ReturnType<typeof gate<void>>;
  }
>();
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
      "test/pdf-entry.ts",
      "--dry-run",
      "--outdir",
      "pdf-test-dist",
      "--name",
      "pinboard-pdf-test",
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      timeout: 90000,
      env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
    },
  );
  const directory = new URL("../pdf-test-dist/", import.meta.url);
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        {
          type: "ESModule",
          path: fileURLToPath(new URL("pdf-entry.js", directory)),
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
      d1Databases: ["DB"],
      r2Buckets: ["BLOCKS"],
      serviceBindings: {
        async PDF_TEST_CONTROL(request) {
          const url = new URL(request.url);
          const gates = heldReads.get(url.searchParams.get("job")!);
          if (!gates) return new Response(null, { status: 404 });
          if (url.pathname === "/read") {
            gates.entered.resolve();
            return new Response(null, { status: await gates.release.promise });
          }
          if (url.pathname === "/abort") {
            await gates.abort.promise;
          } else if (url.pathname === "/late-cancelled") {
            gates.cancelled.resolve();
          }
          return new Response(null);
        },
      },
      bindings: {
        APP_NAME: "PDF test",
        PUBLIC_ORIGIN: "https://pdf.test",
        AUTH_SECRET: "synthetic-pdf-test-only-not-a-real-secret",
      },
    }),
  );
  disposeRuntime = () => runtime.dispose();
  await runtime.ready;
  await migrate(await runtime.getD1Database("DB"));
}, 120000);
afterAll(async () => {
  await disposeRuntime?.();
  await rm(new URL("../pdf-test-dist/", import.meta.url), {
    recursive: true,
    force: true,
  });
});
async function render(bytes: Uint8Array, query = "rgba") {
  return runtime.dispatchFetch(`https://pdf.test/render?${query}`, {
    method: "POST",
    body: bytes,
  });
}
function pixel(bytes: Uint8Array, width: number, x: number, y: number) {
  return [...bytes.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
}
it("renders independent red/blue first-page expectations, rotation and CropBox", async () => {
  for (const [options, width, height, samples] of [
    [
      {},
      200,
      150,
      [
        [20, 20, [255, 0, 0, 255]],
        [180, 20, [0, 0, 255, 255]],
      ],
    ],
    [
      { rotate: 90 },
      200,
      150,
      [
        [20, 20, [255, 0, 0, 255]],
        [20, 130, [0, 0, 255, 255]],
      ],
    ],
    [
      { crop: "0 0 100 200" },
      100,
      75,
      [
        [20, 20, [255, 0, 0, 255]],
        [80, 60, [255, 0, 0, 255]],
      ],
    ],
  ] as const) {
    const result = await render(simplePdf(options));
    expect(result.status, await result.clone().text()).toBe(200);
    const stats = JSON.parse(result.headers.get("x-stats")!) as {
      width: number;
      height: number;
    };
    expect(stats).toMatchObject({ width, height });
    const bytes = new Uint8Array(await result.arrayBuffer());
    for (const [x, y, expected] of samples)
      expect(pixel(bytes, width, x, y)).toEqual(expected);
  }
});
it("encodes <=480px/64KiB WebP without initializing image decoders", async () => {
  const result = await render(simplePdf({ width: 1000, height: 500 }), "");
  expect(result.status, await result.clone().text()).toBe(200);
  expect(result.headers.get("content-type")).toBe("image/webp");
  expect(JSON.parse(result.headers.get("x-stats")!)).toMatchObject({
    width: 480,
    height: 360,
    owner: "pdf",
    nativeBytes: 33554432,
  });
  expect((await result.arrayBuffer()).byteLength).toBeLessThanOrEqual(65536);
});
it("renders embedded images against independent color expectations and rejects encrypted inputs", async () => {
  const image = await render(imagePdf());
  expect(image.status, await image.clone().text()).toBe(200);
  const pixels = new Uint8Array(await image.arrayBuffer());
  expect(pixel(pixels, 200, 20, 20)).toEqual([255, 0, 0, 255]);
  expect(pixel(pixels, 200, 180, 20)).toEqual([0, 0, 255, 255]);
  expect(pixel(pixels, 200, 20, 130)).toEqual([0, 255, 0, 255]);
  const encrypted = await render(passwordPdf());
  expect(encrypted.status).toBe(422);
  expect(await encrypted.text()).toContain("Password-protected");
});
it("renders fallback simplified/traditional Chinese glyph cells; refuses missing Hangul and forms", async () => {
  const font = await readFile(
    new URL("../assets/DroidSansFallbackFull.ttf", import.meta.url),
  );
  for (const [text, traditional] of [
    ["你好世界", false],
    ["中文預覽", true],
  ] as const) {
    for (const fixture of [
      cjkPdf(text, traditional),
      embeddedCjkPdf(text, font),
    ]) {
      const result = await render(fixture);
      expect(result.status, await result.clone().text()).toBe(200);
      const bytes = new Uint8Array(await result.arrayBuffer());
      for (const [glyph, char] of [...text].entries())
        expect(
          glyphSimilarity(bytes, 400, 20 + glyph * 60, char as "你"),
          char,
        ).toBeGreaterThan(0.7);
    }
  }
  for (const bytes of [
    cjkPdf("한국", false, true),
    simplePdf({ form: true }),
    simplePdf({ annotation: true }),
  ]) {
    const result = await render(bytes);
    expect(result.status).toBe(422);
    expect(await result.text()).toMatch(/Hangul|flattening/u);
  }
});
it("uses actual CAR/R2 range reads, preserves complete pixels and saves >75%", async () => {
  const env = await runtime.getBindings<Bindings>();
  const dag = await importFile(largeSecondPagePdf());
  await storeDag(env, dag);
  const cid = key(dag.root);
  const partial = await runtime.dispatchFetch(
    `https://pdf.test/render?cid=${cid}&rgba`,
  );
  const full = await runtime.dispatchFetch(
    `https://pdf.test/render?cid=${cid}&rgba&full`,
  );
  expect(partial.status, await partial.clone().text()).toBe(200);
  expect(full.status, await full.clone().text()).toBe(200);
  expect(new Uint8Array(await partial.arrayBuffer())).toEqual(
    new Uint8Array(await full.arrayBuffer()),
  );
  const a = JSON.parse(partial.headers.get("x-stats")!) as {
    reads: number;
    bytes: number;
  };
  const b = JSON.parse(full.headers.get("x-stats")!) as {
    reads: number;
    bytes: number;
  };
  console.log("PDF actual R2 payload metrics", { partial: a, full: b });
  expect(a.bytes).toBeLessThan(b.bytes / 4);
  expect(a.reads).toBeLessThan(b.reads);
  const location = await env.DB.prepare(
    "SELECT object_key, byte_offset FROM car_blocks WHERE cid = ?",
  )
    .bind(cid)
    .first<{ object_key: string; byte_offset: number }>();
  const object = await env.BLOCKS.get(location!.object_key);
  const corrupt = new Uint8Array(await object!.arrayBuffer());
  corrupt[location!.byte_offset] = corrupt[location!.byte_offset]! ^ 1;
  await env.BLOCKS.put(location!.object_key, corrupt);
  const rejected = await runtime.dispatchFetch(
    `https://pdf.test/render?cid=${cid}`,
  );
  expect(rejected.status).toBe(422);
  expect(await rejected.text()).toMatch(/match|CID|digest/u);
});
it("publishes the generic WebP descriptor through protected, public publication and node endpoints", async () => {
  const env = await runtime.getBindings<Bindings>();
  const owner: Principal = {
    accountId: await accountForGoogle(env.DB, "pdf-owner"),
    kind: "session",
    scopes,
  };
  const pins = new PinService(env, owner);
  const pin = await pins.upload(
    simplePdf({ rotate: 270 }),
    "file",
    "private-source-label.pdf",
  );
  await runtime.dispatchFetch(`https://pdf.test/process?cid=${pin.cid}`);
  const token = (
    await createToken(env, owner, {
      name: "PDF test",
      scopes,
      expiresInDays: 1,
    })
  ).token;
  const headers = { authorization: `Bearer ${token}` };
  const privatePath = `https://pdf.test/api/pins/${pin.cid}/preview`;
  expect((await runtime.dispatchFetch(privatePath)).status).toBe(401);
  const descriptor = (await (
    await runtime.dispatchFetch(privatePath, { headers })
  ).json()) as ContentPreview;
  expect(descriptor).toMatchObject({
    version: 4,
    status: "ready",
    contentType: "application/pdf",
    preview: { kind: "image" },
  });
  if (descriptor.preview?.kind !== "image")
    throw new Error("Expected image descriptor");
  const image = await runtime.dispatchFetch(
    `https://pdf.test${descriptor.preview.image.url}`,
  );
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/webp");
  expect((await image.arrayBuffer()).byteLength).toBeLessThanOrEqual(65536);
  const publication = (
    await new PublicationService(env, owner).create(
      "PDF cover",
      pin.cid,
      "pdf-publication",
      true,
    )
  ).publication;
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM pins WHERE cid = ?")
      .bind(pin.cid)
      .first(),
  ).toEqual({ n: 0 });
  const publicPreview = await runtime.dispatchFetch(
    `https://pdf.test/api/public/publications/${publication.id}/preview/1`,
  );
  expect(publicPreview.status).toBe(200);
  expect(await publicPreview.json()).toEqual(descriptor);
  const node = await runtime.dispatchFetch(
    `https://pdf.test/api/public/publications/${publication.id}/versions/1/nodes/${pin.cid}/description`,
  );
  expect(node.status).toBe(200);
  expect(((await node.json()) as NodeDescription).description.preview).toEqual(
    descriptor,
  );
  expect(JSON.stringify(descriptor)).not.toContain("private-source-label");
  expect(
    (
      await runtime.dispatchFetch(
        `https://pdf.test/api/pins/${pin.cid}/download`,
        { headers },
      )
    ).status,
  ).toBe(404);
});
it("recovers from native memory abort on the same bounded backing memory and alternates image codecs", async () => {
  const result = await render(simplePdf({ bomb: true }));
  expect(result.status).toBe(422);
  expect(await result.text()).toMatch(/native|memory/u);
  for (const name of [
    "photo.png",
    "photo.jpg",
    "transparent.png",
    "portrait.jpg",
  ]) {
    const image = await runtime.dispatchFetch("https://pdf.test/image", {
      method: "POST",
      body: await readFile(new URL(`fixtures/${name}`, import.meta.url)),
    });
    expect(image.status, await image.clone().text()).toBe(200);
    const recovered = await render(simplePdf());
    expect(recovered.status, await recovered.clone().text()).toBe(200);
  }
  let table = 0;
  for (let index = 0; index < 64; index++) {
    const response = await render(simplePdf());
    expect(response.status).toBe(200);
    const stats = JSON.parse(response.headers.get("x-stats")!) as {
      tableSize: number;
      hasSession: boolean;
      windows: number;
    };
    table ||= stats.tableSize;
    expect(stats).toMatchObject({
      tableSize: table,
      hasSession: false,
      windows: 0,
    });
  }
});
it("preserves the existing near-2-million-pixel image limit in the shared bounded arena", async () => {
  const bytes = maximumRgbaPng();
  expect(bytes.length).toBeLessThan(8 * 1024 * 1024);
  const image = await runtime.dispatchFetch("https://pdf.test/image", {
    method: "POST",
    body: bytes,
  });
  expect(image.status, await image.clone().text()).toBe(200);
  expect((await image.arrayBuffer()).byteLength).toBeLessThanOrEqual(65536);
  const normal = await render(simplePdf());
  expect(normal.status, await normal.clone().text()).toBe(200);
  expect(
    await (await runtime.dispatchFetch("https://pdf.test/state")).json(),
  ).toMatchObject({
    nativeBytes: 32 * 1024 * 1024,
    hasSession: false,
    windows: 0,
    occupied: false,
  });
});

it.each(["resume", "fail", "cancel"] as const)(
  "excludes cross-codec work while owner-request I/O is suspended and safely handles %s",
  async (mode) => {
    const gates = {
      entered: gate<void>(),
      release: gate<number>(),
      abort: gate<void>(),
      cancelled: gate<void>(),
    };
    const job = `cross-codec-${mode}`;
    heldReads.set(job, gates);
    const env = await runtime.getBindings<Bindings>();
    const dag = await importFile(largeSecondPagePdf());
    await storeDag(env, dag);
    const jpeg = await readFile(new URL("fixtures/photo.jpg", import.meta.url));
    const state = async () =>
      (await (
        await runtime.dispatchFetch("https://pdf.test/state")
      ).json()) as {
        generation: number;
        owner: string;
        occupied: boolean;
        hasSession: boolean;
        nativeBytes: number;
      };
    const image = () =>
      runtime.dispatchFetch("https://pdf.test/image", {
        method: "POST",
        body: jpeg,
      });
    const digest = async () =>
      new Uint8Array(
        await (
          await runtime.dispatchFetch("https://pdf.test/arena-digest")
        ).arrayBuffer(),
      );
    const expected = new Uint8Array(200 * 150 * 4);
    for (let y = 0; y < 150; y++)
      for (let x = 0; x < 200; x++)
        expected.set(
          x < 100 ? [255, 0, 0, 255] : [0, 0, 255, 255],
          (y * 200 + x) * 4,
        );
    const owner = runtime.dispatchFetch(
      `https://pdf.test/held-pdf?cid=${key(dag.root)}&job=${job}&mode=${mode}`,
    );
    try {
      await Promise.race([
        gates.entered.promise,
        owner.then(() => {
          throw new Error(
            "PDF owner completed before its source was suspended",
          );
        }),
      ]);
      const paused = await state();
      expect(paused).toMatchObject({
        owner: "pdf",
        occupied: true,
        hasSession: true,
        nativeBytes: 32 * 1024 * 1024,
      });
      // These responses must finish while the owner is still suspended: a
      // queued contender would deadlock this test before release is signalled.
      for (const contender of [image(), render(simplePdf())]) {
        const response = await contender;
        expect(response.status).toBe(422);
        expect(await response.text()).toContain("busy");
      }
      expect(await state()).toEqual(paused);
      if (mode === "cancel") gates.abort.resolve();
      else gates.release.resolve(mode === "fail" ? 503 : 200);
      const completed = await owner;
      if (mode === "resume") {
        expect(completed.status).toBe(200);
        expect(new Uint8Array(await completed.arrayBuffer())).toEqual(expected);
      } else {
        expect(completed.status).toBe(422);
        expect(await completed.text()).toContain(
          mode === "cancel" ? "cancelled" : "failed",
        );
      }
      expect(await state()).toMatchObject({
        occupied: false,
        hasSession: false,
      });
      const switched = await image();
      expect(switched.status, await switched.clone().text()).toBe(200);
      const imageState = await state();
      expect(imageState.owner).toBe("image/jpeg");
      expect(imageState.generation).toBeGreaterThan(paused.generation);
      if (mode === "cancel") {
        const beforeLateRead = await digest();
        gates.release.resolve(200);
        await gates.cancelled.promise;
        expect(await state()).toEqual(imageState);
        expect(await digest()).toEqual(beforeLateRead);
      }
      const recovered = await render(simplePdf());
      expect(recovered.status, await recovered.clone().text()).toBe(200);
      expect(new Uint8Array(await recovered.arrayBuffer())).toEqual(expected);
      expect(await state()).toMatchObject({
        owner: "pdf",
        occupied: false,
        hasSession: false,
      });
    } finally {
      gates.abort.resolve();
      gates.release.resolve(200);
      await owner;
      heldReads.delete(job);
    }
  },
);
