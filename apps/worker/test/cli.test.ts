import { CarReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import { run } from "@workspace/cli";
import type { Pin } from "@workspace/contracts";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bindings } from "../src/env.js";
import { accountForGoogle, type Principal } from "../src/identity.js";
import { createToken, revokeToken } from "../src/tokens.js";
import { importFile } from "../src/content.js";
import { buildDirectoryCar } from "../../web/src/directory.js";
import { selectionForDirectory } from "../../web/src/uploads.js";
import { encodeCar } from "../src/car.js";

const directory = resolve(".worker-cli-tests");
let mf: Miniflare;
let env: Bindings;
let origin: string;
let runtimeOrigin: string;
let principal: Principal;
let token: string;
let slowWrites = 0;
const inFlight = new Set<Promise<void>>();
const server = createServer((request, response) => {
  const operation = (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.from(chunk as Uint8Array));
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers))
      if (
        value !== undefined &&
        ["authorization", "content-type", "x-pinboard-public"].includes(key)
      )
        headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    const body = Buffer.concat(chunks);
    const result = await fetch(runtimeOrigin + request.url!, {
      method: request.method!,
      headers,
      ...(["POST", "PUT", "PATCH"].includes(request.method!)
        ? { body: new Uint8Array(body) }
        : {}),
    });
    if (
      new URL(origin + request.url!).searchParams.get("name") ===
      "timeout-commit"
    ) {
      slowWrites++;
      await sleep(500);
    }
    const responseHeaders = new Headers(result.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    response.writeHead(result.status, Object.fromEntries(responseHeaders));
    response.end(new Uint8Array(await result.arrayBuffer()));
  })().catch(() => {
    response.writeHead(500);
    response.end();
  });
  inFlight.add(operation);
  void operation.finally(() => {
    inFlight.delete(operation);
  });
});

beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  await new Promise<void>((ready) => {
    server.listen(0, "127.0.0.1", ready);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing local listener");
  origin = `http://127.0.0.1:${address.port}`;
  const bindings = {
    APP_NAME: "Local CLI fixture",
    AUTH_SECRET: "synthetic-local-only-secret-long-enough",
    AUTH_URL: origin + "/api/auth",
    PUBLIC_ORIGIN: origin,
    PROVIDER_ID: "12D3KooWCjfPiojcCUmv78Wd1NJzi4Mraj1moxigp7AfQVQvGLwH",
    PROVIDER_MULTIADDR: "/ip4/127.0.0.1/tcp/8787/http",
  };
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
      compatibilityDate: "2026-10-14",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      r2Buckets: ["BLOCKS"],
      serviceBindings: { ASSETS: () => new Response("local fixture") },
      bindings,
      host: "127.0.0.1",
      port: 0,
    }),
  );
  runtimeOrigin = (await mf.ready).origin;
  expect((await fetch(runtimeOrigin + "/api/health")).status).toBe(200);
  const db = await mf.getD1Database("DB");
  const sql = await readFile(
    new URL("../migrations/0001_pinboard.sql", import.meta.url),
    "utf8",
  );
  await db.batch(
    sql
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => db.prepare(part)),
  );
  env = {
    ...(await mf.getBindings<Pick<Bindings, "DB" | "BLOCKS" | "ASSETS">>()),
    ...bindings,
  };
  principal = {
    accountId: await accountForGoogle(db, "synthetic-cli-account"),
    kind: "session",
    scopes: ["pins:read", "pins:write", "pins:delete"],
  };
  token = (
    await createToken(env, principal, {
      name: "local-cli",
      scopes: principal.scopes,
      expiresInDays: 1,
    })
  ).token;
  const authorized = await fetch(runtimeOrigin + "/api/pins", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(authorized.status).toBe(200);
  expect(await authorized.json()).toMatchObject({ pins: [] });
}, 30000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((done, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else done();
    });
  });
  await Promise.all(inFlight);
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
});

async function cli(args: string[], credential = token, target = runtimeOrigin) {
  let out = "",
    err = "";
  const capture = (write: (text: string) => void) =>
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        write(chunk.toString());
        done();
      },
    });
  const code = await run([...args, "--endpoint", target, "--json"], {
    env: {
      ...process.env,
      LOCALAPPDATA: directory,
      XDG_CONFIG_HOME: directory,
      PINBOARD_AGENT_TOKEN: credential,
    },
    input: Readable.from([]),
    out: capture((text) => {
      out += text;
    }),
    err: capture((text) => {
      err += text;
    }),
    signal: new AbortController().signal,
  });
  return { code, out, err };
}
const pinResult = (result: { code: number; out: string; err: string }): Pin => {
  expect(result.code, result.err).toBe(0);
  return JSON.parse(result.out) as Pin;
};
async function raw(cid: string) {
  const response = await fetch(`${runtimeOrigin}/ipfs/${cid}?format=raw`);
  expect(response.status).toBe(200);
  return new Uint8Array(await response.arrayBuffer());
}

describe("CLI against real local Worker API, D1 and R2 (synthetic authorization)", () => {
  it("serializes real independent credential writers without losing endpoint entries", async () => {
    const path = fileURLToPath(
      new URL("../../cli/dist/main.js", import.meta.url),
    );
    const configRoot = join(directory, "concurrent-processes");
    const env = {
      ...process.env,
      PINBOARD_AGENT_TOKEN: undefined,
      LOCALAPPDATA: configRoot,
      XDG_CONFIG_HOME: configRoot,
    };
    const save = (endpoint: string, value: string) => {
      const pending = promisify(execFile)(
        process.execPath,
        [
          path,
          "config",
          "set-token",
          "--endpoint",
          endpoint,
          "--token-stdin",
          "--json",
        ],
        { env, timeout: 55000 },
      );
      pending.child.stdin!.end(value + "\n");
      return pending;
    };
    const results = await Promise.all([
      save("https://one.example", "synthetic-one"),
      save("https://two.example", "synthetic-two"),
    ]);
    for (const result of results) {
      expect(JSON.parse(result.stdout)).toHaveProperty("saved", true);
      expect(result.stdout).not.toContain("synthetic");
      expect(result.stderr).toBe("");
    }
    expect(
      JSON.parse(
        await readFile(join(configRoot, "pinboard", "tokens.json"), "utf8"),
      ),
    ).toEqual({
      "https://one.example": "synthetic-one",
      "https://two.example": "synthetic-two",
    });
  }, 60000);

  it("reports an uncertain native-fetch timeout even when the Worker has committed the write", async () => {
    const bytes = new TextEncoder().encode("committed-before-lost-response");
    const path = join(directory, "timeout.bin");
    await writeFile(path, bytes);
    const result = await cli(
      ["upload", path, "--name", "timeout-commit", "--timeout", "200"],
      token,
      origin,
    );
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(JSON.parse(result.err)).toMatchObject({
      error: { code: "TIMEOUT", uncertain: true },
    });
    expect(slowWrites).toBe(1);
    const cid = (await importFile(bytes)).root.toString();
    expect(pinResult(await cli(["inspect", cid])).name).toBe("timeout-commit");
  });
  it("runs the built CLI executable over local HTTP without an IPFS executable or RPC", async () => {
    const path = fileURLToPath(
      new URL("../../cli/dist/main.js", import.meta.url),
    );
    const isolatedEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(isolatedEnv))
      if (key.toLowerCase() === "path") delete isolatedEnv[key];
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [path, "list", "--endpoint", runtimeOrigin, "--json"],
      {
        env: {
          ...isolatedEnv,
          PATH: directory,
          PINBOARD_AGENT_TOKEN: token,
          LOCALAPPDATA: directory,
          XDG_CONFIG_HOME: directory,
        },
        timeout: 10000,
      },
    );
    expect(JSON.parse(stdout)).toHaveProperty("pins");
    expect(stderr).toBe("");
  });
  it("uploads binary/empty files through the same Worker path as Web; labels upsert and may duplicate", async () => {
    const bytes = new Uint8Array([0, 255, 13, 10, 128]);
    const path = join(directory, "普通 file.bin");
    await writeFile(path, bytes);
    const first = pinResult(await cli(["upload", path]));
    expect(first.name).toBe("普通 file.bin");
    expect(first.cid).toBe((await importFile(bytes)).root.toString());
    expect(await raw(first.cid)).toEqual(bytes);
    const update = pinResult(
      await cli(["upload", path, "--name", "same-label"]),
    );
    expect(update.cid).toBe(first.cid);
    expect(update.name).toBe("same-label");
    const empty = join(directory, "empty.bin");
    await writeFile(empty, "");
    const second = pinResult(
      await cli(["upload", empty, "--name", "same-label"]),
    );
    expect(second.cid).not.toBe(first.cid);
    expect(second.name).toBe(update.name);
    expect(await raw(second.cid)).toHaveLength(0);
    const listing = await cli(["list", "--all"]);
    expect(listing.code).toBe(0);
    expect(
      (JSON.parse(listing.out) as { pins: Pin[] }).pins.filter(
        (pin) => pin.cid === first.cid,
      ),
    ).toHaveLength(1);
    expect(pinResult(await cli(["inspect", first.cid])).name).toBe(
      "same-label",
    );
    expect((await cli(["remove", first.cid])).code).toBe(0);
    expect((await cli(["inspect", first.cid])).code).toBe(1);
    expect(await raw(first.cid)).toEqual(bytes); // Removing an account reference is not erasure.
  });

  it("matches the browser directory CID, preserves CAR roots and reconstructs every binary byte from the public gateway", async () => {
    const folder = join(directory, "目录 space");
    await mkdir(join(folder, "nested"), { recursive: true });
    await mkdir(join(folder, "ignored-empty"));
    const fixture = [
      { path: ".hidden", data: new Uint8Array([0, 1, 255]) },
      { path: "nested/文件.bin", data: new Uint8Array([128, 10, 0, 254]) },
      { path: "empty", data: new Uint8Array() },
    ];
    for (const file of fixture)
      await writeFile(join(folder, ...file.path.split("/")), file.data);
    const web = await buildDirectoryCar(
      selectionForDirectory(
        fixture.map((file) => ({
          path: `root/${file.path}`,
          file: new File([file.data], file.path),
        })),
      ),
    );
    const car = new Uint8Array(await web.arrayBuffer());
    const reader = await CarReader.fromBytes(car);
    const root = (await reader.getRoots())[0]!;
    const uploaded = pinResult(await cli(["upload", folder]));
    expect(uploaded.cid).toBe(root.toString());
    expect(uploaded.name).toBe("目录 space");
    const directoryNode = dagPb.decode(await raw(uploaded.cid));
    const exportedResponse = await fetch(
      `${runtimeOrigin}/api/public/${uploaded.cid}/car`,
    );
    expect(exportedResponse.status).toBe(200);
    const exported = await CarReader.fromBytes(
      new Uint8Array(await exportedResponse.arrayBuffer()),
    );
    expect((await exported.getRoots())[0]!.toString()).toBe(uploaded.cid);
    for await (const block of reader.blocks())
      expect((await exported.get(block.cid))!.bytes).toEqual(block.bytes);
    expect(directoryNode.Links.map((link) => link.Name)).not.toContain(
      "ignored-empty",
    );
    for (const file of fixture) {
      let node = directoryNode;
      const parts = file.path.split("/");
      for (let index = 0; index < parts.length; index++) {
        const link = node.Links.find((link) => link.Name === parts[index])!;
        const block = await raw(link.Hash.toString());
        expect((await exported.get(link.Hash))!.bytes).toEqual(block);
        if (index === parts.length - 1) expect(block).toEqual(file.data);
        else node = dagPb.decode(block);
      }
    }
    const archive = join(directory, "archive.car");
    await writeFile(archive, car);
    const imported = pinResult(
      await cli(["import", archive, "--name", "imported"]),
    );
    expect(imported.cid).toBe(root.toString());
    expect(imported.name).toBe("imported");
    const ordinary = pinResult(await cli(["upload", archive]));
    expect(ordinary.cid).toBe((await importFile(car)).root.toString());
    expect(ordinary.cid).not.toBe(imported.cid);
    const defaultName = pinResult(await cli(["import", archive]));
    expect(defaultName.name).toBe("archive.car");
    const missing = join(directory, "missing.car");
    await writeFile(
      missing,
      await encodeCar({ root, blocks: new Map(), size: 0 }),
    );
    const failed = await cli(["import", missing]);
    expect(failed.code).toBe(1);
    expect(failed.out).toBe("");
  });

  it("keeps least privilege, expiry, revocation and direct API public acknowledgement authoritative", async () => {
    const readOnly = await createToken(env, principal, {
      name: "read-only",
      scopes: ["pins:read"],
      expiresInDays: 1,
    });
    expect((await cli(["list"], readOnly.token)).code).toBe(0);
    const path = join(directory, "denied");
    await writeFile(path, "no");
    const denied = await cli(["upload", path], readOnly.token);
    expect(denied.code).toBe(1);
    expect(denied.err).toContain('"status":403');
    const writeOnly = await createToken(env, principal, {
      name: "write-only",
      scopes: ["pins:write"],
      expiresInDays: 1,
    });
    expect((await cli(["upload", path], writeOnly.token)).code).toBe(0);
    expect((await cli(["list"], writeOnly.token)).code).toBe(1);
    await revokeToken(env, principal, readOnly.id);
    expect((await cli(["list"], readOnly.token)).err).toContain('"status":401');
    await env.DB.prepare("UPDATE agent_tokens SET expires_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00Z", writeOnly.id)
      .run();
    expect((await cli(["upload", path], writeOnly.token)).err).toContain(
      '"status":401',
    );
    const direct = await fetch(
      runtimeOrigin + "/api/pins/upload?kind=file&name=direct",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "not acknowledged",
      },
    );
    expect(direct.status).toBe(400);
  });
});
