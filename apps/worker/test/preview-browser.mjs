// Isolated, synthetic-account browser fixture. Never mounted by production.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createServer as createViteServer } from "vite";
import { buildDirectoryCar } from "@shazhou/pinboard-encoding";
import { simplePdf } from "./pdf-fixtures.ts";

const origin = "http://127.0.0.1:5191";
const dist = new URL("../dist/", import.meta.url);
const runtime = new Miniflare(
  convertV4MiniflareOptions({
    modules: [
      { type: "ESModule", path: fileURLToPath(new URL("index.js", dist)) },
      ...(await readdir(dist))
        .filter((name) => name.endsWith(".wasm") || name.endsWith(".ttf"))
        .map((name) => ({
          type: name.endsWith(".wasm") ? "CompiledWasm" : "Data",
          path: fileURLToPath(new URL(name, dist)),
        })),
    ],
    compatibilityDate: "2026-10-14",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    r2Buckets: ["BLOCKS"],
    bindings: {
      APP_NAME: "Preview fixture",
      PUBLIC_ORIGIN: origin,
      AUTH_SECRET: "synthetic-browser-only-secret-not-production",
    },
  }),
);
await runtime.ready;
const db = await runtime.getD1Database("DB");
const migrations = new URL("../migrations/", import.meta.url);
for (const name of (await readdir(migrations))
  .filter((name) => name.endsWith(".sql"))
  .sort()) {
  const sql = await readFile(new URL(name, migrations), "utf8");
  await db.batch(
    sql
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => db.prepare(part)),
  );
}
const token = "pb_" + randomBytes(32).toString("base64url");
await db
  .prepare(
    "INSERT INTO accounts (id, provider, subject) VALUES ('browser', 'google', 'synthetic-browser')",
  )
  .run();
await db
  .prepare(
    "INSERT INTO agent_tokens (id, account_id, name, prefix, token_hash, scopes, expires_at) VALUES ('browser', 'browser', 'browser test', ?, ?, ?, ?)",
  )
  .bind(
    token.slice(0, 11),
    createHash("sha256").update(token).digest("hex"),
    JSON.stringify([
      "pins:read",
      "pins:write",
      "pins:delete",
      "publications:read",
      "publications:write",
    ]),
    new Date(Date.now() + 3600000).toISOString(),
  )
  .run();
const authorization = `Bearer ${token}`;
async function upload(body, name, kind = "file") {
  const response = await runtime.dispatchFetch(
    `${origin}/api/pins/upload?kind=${kind}&name=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { authorization, "x-pinboard-public": "true" },
      body,
    },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
for (const name of ["photo.jpg", "portrait.jpg", "transparent.png"])
  await upload(
    await readFile(new URL(`fixtures/${name}`, import.meta.url)),
    name,
  );
await upload(
  "An ordinary note\n\n*literal stars* and [text-only link](https://example.test)\n<script>never executed</script>",
  "notes.txt",
);
await upload("%PDF-1.7\nunsupported document", "document.pdf");
const papers = [];
for (const [name, width, height] of [
  ["Portrait paper.pdf", 300, 420],
  ["Landscape paper.pdf", 420, 300],
]) {
  const pin = await upload(
    simplePdf({
      width,
      height,
      content: `0.15 0.25 0.4 rg 20 ${height - 50} ${width - 40} 30 re f
        0.8 0.85 0.9 rg 20 60 ${width - 40} ${height - 130} re f
        0.8 0.3 0.1 rg 20 15 ${width - 40} 20 re f`,
    }),
    name,
  );
  papers.push(pin);
}
const publicationResponse = await runtime.dispatchFetch(
  `${origin}/api/publications`,
  {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({
      title: "Published portrait paper",
      cid: papers[0].cid,
      requestId: "synthetic-browser-paper",
      public: true,
    }),
  },
);
if (!publicationResponse.ok) throw new Error(await publicationResponse.text());
const { publication } = await publicationResponse.json();
const content = new TextEncoder().encode("a real file inside the folder");
const directory = await buildDirectoryCar([
  {
    path: "notes/readme.txt",
    size: content.length,
    content: (async function* () {
      yield await Promise.resolve(content);
    })(),
  },
]);
await upload(directory.bytes, "folder", "car");
const server = createServer((request, response) => {
  void (async () => {
    if (request.url === "/api/auth/session" || request.url === "/api/me") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          user: { id: "browser", name: "Synthetic preview account" },
        }),
      );
      return;
    }
    if (request.url?.startsWith("/api/tokens")) {
      response.setHeader("content-type", "application/json");
      response.end('{"tokens":[]}');
      return;
    }
    if (request.url === "/api/oauth/grants") {
      response.setHeader("content-type", "application/json");
      response.end('{"grants":[]}');
      return;
    }
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers))
      if (value !== undefined)
        headers.set(name, Array.isArray(value) ? value.join(",") : value);
    if (
      request.url?.startsWith("/api/pins") ||
      request.url?.startsWith("/api/publications")
    )
      headers.set("authorization", authorization);
    const result = await runtime.dispatchFetch(origin + request.url, {
      method: request.method,
      headers,
      ...(!["GET", "HEAD"].includes(request.method)
        ? { body: Buffer.concat(body) }
        : {}),
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(new Uint8Array(await result.arrayBuffer()));
  })().catch((error) => {
    console.error(error);
    response.writeHead(500);
    response.end("Fixture request failed");
  });
});
await new Promise((resolve) => server.listen(5192, "127.0.0.1", resolve));
const target = "http://127.0.0.1:5192";
const vite = await createViteServer({
  root: fileURLToPath(new URL("../../web/", import.meta.url)),
  configFile: fileURLToPath(
    new URL("../../web/vite.config.ts", import.meta.url),
  ),
  server: {
    host: "127.0.0.1",
    port: 5191,
    strictPort: true,
    proxy: {
      "/api": { target },
      "/ipfs": { target },
    },
  },
});
await vite.listen();
console.log(`PREVIEW_BROWSER_READY ${origin}`);
console.log(`PREVIEW_PUBLICATION ${origin}/p/${publication.id}`);
async function close() {
  await vite.close();
  await new Promise((resolve) => server.close(resolve));
  await runtime.dispose();
}
process.on("SIGINT", () => {
  void close().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void close().then(() => process.exit(0));
});
