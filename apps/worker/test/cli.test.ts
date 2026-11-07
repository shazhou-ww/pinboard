import { CarReader } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import { run } from "@shazhou/pinboard";
import type { Pin, PublicationResult } from "@shazhou/pinboard-contracts";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createServer } from "node:http";
import { readFile, readdir, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Bindings } from "../src/env.js";
import { accountForGoogle, type Principal } from "../src/identity.js";
import { createToken, revokeToken } from "../src/tokens.js";
import { importFile } from "../src/content.js";
import { buildDirectoryCar } from "../../web/src/directory.js";
import { selectionForDirectory } from "../../web/src/uploads.js";
import { encodeCar } from "../src/car.js";
import { migrate } from "./migrations.js";
import { fixtureDirectory } from "../../cli/test/fixture-directory.js";

let directory: string;
let mf: Miniflare;
let env: Bindings;
let origin: string;
let runtimeOrigin: string;
let principal: Principal;
let token: string;
let slowWrites = 0;
let releaseSlowResponse!: () => void;
const slowResponse = new Promise<void>((resolve) => {
  releaseSlowResponse = resolve;
});
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
      await slowResponse;
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
  directory = await fixtureDirectory(".worker-cli-tests-");
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
      modules: [
        {
          type: "ESModule",
          path: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
        },
        ...(await readdir(new URL("../dist/", import.meta.url)))
          .filter((name) => name.endsWith(".wasm") || name.endsWith(".ttf"))
          .map((name) => ({
            type: name.endsWith(".wasm")
              ? ("CompiledWasm" as const)
              : ("Data" as const),
            path: fileURLToPath(new URL(`../dist/${name}`, import.meta.url)),
          })),
      ],
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
  await migrate(db);
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
  releaseSlowResponse();
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
  it("runs compiled CLI child/root descriptions, explicit sidecar export and atomic conversion through real HTTP storage", async () => {
    const owner: Principal = {
      ...principal,
      accountId: await accountForGoogle(env.DB, "compiled-conversion-account"),
      scopes: [
        "pins:read",
        "pins:write",
        "pins:delete",
        "publications:read",
        "publications:write",
        "publications:delete",
      ],
    };
    const credential = (
      await createToken(env, owner, {
        name: "compiled-convert",
        scopes: owner.scopes,
        expiresInDays: 1,
      })
    ).token;
    const executable = fileURLToPath(
      new URL("../../cli/dist/main.js", import.meta.url),
    );
    const execute = async (args: string[]) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [executable, ...args, "--endpoint", runtimeOrigin, "--json"],
        {
          cwd: directory,
          env: {
            ...process.env,
            PINBOARD_AGENT_TOKEN: credential,
            LOCALAPPDATA: directory,
            XDG_CONFIG_HOME: directory,
          },
          timeout: 15000,
        },
      );
      return JSON.parse(stdout) as Record<string, unknown>;
    };
    const archive = await buildDirectoryCar(
      selectionForDirectory([
        {
          path: "description-folder/child.txt",
          file: new File(["Compiled child bytes"], "child.txt"),
        },
      ]),
    );
    const uploaded = await fetch(
      `${runtimeOrigin}/api/pins/upload?kind=car&name=Never%20public%20private%20name`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "x-pinboard-public": "true",
        },
        body: archive,
      },
    );
    expect(uploaded.status).toBe(201);
    const pin = await uploaded.json<Pin>();
    const reader = await CarReader.fromBytes(
      new Uint8Array(
        await (
          await fetch(`${runtimeOrigin}/api/public/${pin.cid}/car`)
        ).arrayBuffer(),
      ),
    );
    const rootBlock = await reader.get((await reader.getRoots())[0]!);
    const child = dagPb.decode(rootBlock!.bytes).Links[0]!.Hash.toString();
    expect(await execute(["description", "get", pin.cid, child])).toMatchObject(
      { description: { user: { text: null, version: 0 } } },
    );
    expect(
      await execute([
        "description",
        "set",
        pin.cid,
        child,
        "--text",
        "CLI child sidecar",
        "--version",
        "0",
      ]),
    ).toMatchObject({
      description: { user: { text: "CLI child sidecar", version: 1 } },
    });
    await execute([
      "description",
      "set",
      pin.cid,
      pin.cid,
      "--text",
      "CLI root sidecar",
      "--version",
      "0",
    ]);
    await execute(["description", "clear", pin.cid, pin.cid, "--version", "1"]);
    expect(await execute(["description", "export", pin.cid])).toEqual({
      rootCid: pin.cid,
      descriptions: { [child]: "CLI child sidecar" },
    });
    const args = [
      "publication",
      "convert",
      pin.cid,
      "--title",
      "Explicit compiled public title",
      "--request-id",
      "compiled-conversion",
    ];
    const converted = (await execute(args)) as unknown as PublicationResult;
    expect(converted.status).toBe("converted");
    expect(converted.publication.current.descriptions).toEqual({
      [child]: "CLI child sidecar",
    });
    expect(await execute(args)).toEqual(converted);
    expect((await execute(["list"])).pins).toEqual([]);
    expect(
      await execute([
        "publication",
        "get",
        converted.publication.id,
        "--revision",
        "1",
      ]),
    ).toMatchObject({
      revision: { descriptions: { [child]: "CLI child sidecar" } },
    });
    expect(
      await execute([
        "publication",
        "description",
        converted.publication.id,
        child,
        "--revision",
        "1",
      ]),
    ).toMatchObject({
      description: { user: { text: "CLI child sidecar", version: 1 } },
    });
    expect(await raw(child)).toEqual(
      new TextEncoder().encode("Compiled child bytes"),
    );
    expect(
      await execute([
        "publication",
        "publish",
        converted.publication.id,
        pin.cid,
        "--sequence",
        "1",
        "--request-id",
        "compiled-nop",
      ]),
    ).toMatchObject({ status: "nop" });
    await execute(["publication", "remove", converted.publication.id]);
    await execute(["publication", "restore", converted.publication.id]);
    expect((await execute(["list"])).pins).toEqual([]);
  }, 60000);

  it("runs publication creation, NOP retry, upload/publish, rollback, fixed export and both recovery lifecycles against real storage", async () => {
    const owner: Principal = {
      ...principal,
      accountId: await accountForGoogle(env.DB, "publication-cli-account"),
    };
    const credential = (
      await createToken(env, owner, {
        name: "publication-cli",
        scopes: [
          "pins:read",
          "pins:write",
          "pins:delete",
          "publications:read",
          "publications:write",
          "publications:delete",
        ],
        expiresInDays: 1,
      })
    ).token;
    const upload = async (value: string) => {
      const response = await fetch(
        runtimeOrigin + "/api/pins/upload?kind=file&name=Private-cli-label",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${credential}`,
            "x-pinboard-public": "true",
          },
          body: new TextEncoder().encode(value),
        },
      );
      expect(response.status).toBe(201);
      return response.json<Pin>();
    };
    const invoke = async (args: string[]) => {
      const response = await cli(args, credential);
      expect(response.code, response.err).toBe(0);
      return JSON.parse(response.out) as unknown;
    };
    const a = await upload("publication CLI original");
    const b = await upload("publication CLI next");
    const created = (await invoke([
      "publication",
      "create",
      a.cid,
      "--title",
      "CLI public title",
      "--request-id",
      "cli-create",
    ])) as PublicationResult;
    const id = created.publication.id;
    expect(
      await invoke([
        "publication",
        "publish",
        id,
        a.cid,
        "--sequence",
        "1",
        "--request-id",
        "cli-nop",
      ]),
    ).toMatchObject({ status: "nop" });
    expect(
      await invoke([
        "publication",
        "publish",
        id,
        b.cid,
        "--sequence",
        "1",
        "--request-id",
        "cli-next",
      ]),
    ).toMatchObject({ publication: { currentRevision: 2, sequence: 2 } });
    expect(
      await invoke([
        "publication",
        "publish",
        id,
        a.cid,
        "--sequence",
        "1",
        "--request-id",
        "cli-nop",
      ]),
    ).toMatchObject({ status: "nop", publication: { currentRevision: 1 } });
    await invoke([
      "publication",
      "rollback",
      id,
      "1",
      "--sequence",
      "2",
      "--request-id",
      "cli-rollback",
    ]);
    expect(await invoke(["publication", "get", id])).toMatchObject({
      currentRevision: 1,
      revisionCount: 2,
    });
    expect(
      await invoke(["publication", "get", id, "--revision", "2"]),
    ).toMatchObject({ revision: { cid: b.cid } });
    const output = join(directory, "publication-fixed.car");
    await invoke([
      "publication",
      "export",
      id,
      "--revision",
      "2",
      "--output",
      output,
    ]);
    expect(
      (await (await CarReader.fromBytes(await readFile(output))).getRoots())[0]!
        .toV1()
        .toString(),
    ).toBe(b.cid);
    await invoke(["remove", a.cid]);
    expect(await invoke(["deleted"])).toMatchObject({
      items: [{ id: a.cid, kind: "pin" }],
    });
    expect(await invoke(["publication", "get", id])).toMatchObject({
      current: { cid: a.cid },
    });
    await invoke(["restore", a.cid]);
    await invoke(["publication", "remove", id]);
    const unavailable = await cli(["publication", "history", id], credential);
    expect(unavailable.code).toBe(1);
    expect(JSON.parse(unavailable.err)).toHaveProperty("error.status", 404);
    await invoke(["publication", "restore", id]);
    expect(await invoke(["publication", "get", id])).toMatchObject({
      currentRevision: 1,
      revisionCount: 2,
    });
  });
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
    try {
      const result = await cli(
        ["upload", path, "--name", "timeout-commit", "--timeout", "5000"],
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
      expect(pinResult(await cli(["inspect", cid])).name).toBe(
        "timeout-commit",
      );
    } finally {
      releaseSlowResponse();
    }
  }, 15000);
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

  it("round-trips CLI upload/download and export/import through the public CAR API without credentials", async () => {
    const source = join(directory, "retrieval-source");
    await mkdir(join(source, "nested"), { recursive: true });
    const large = new Uint8Array(1024 * 1024 + 19);
    for (let index = 0; index < large.length; index++)
      large[index] = index % 251;
    const entries = [
      { path: ".hidden", data: new Uint8Array([0, 128, 255]) },
      { path: "nested/\u6587\u4ef6.bin", data: large },
      { path: "empty", data: new Uint8Array() },
    ];
    for (const entry of entries)
      await writeFile(join(source, ...entry.path.split("/")), entry.data);
    const pin = pinResult(await cli(["upload", source]));
    const target = join(directory, "retrieval-target");
    const downloaded = await cli(["download", pin.cid, "--output", target], "");
    expect(downloaded.code, downloaded.err).toBe(0);
    expect(JSON.parse(downloaded.out)).toEqual({
      cid: pin.cid,
      path: target,
      type: "directory",
      size: large.length + 3,
    });
    for (const entry of entries)
      expect(
        new Uint8Array(await readFile(join(target, ...entry.path.split("/")))),
      ).toEqual(entry.data);
    expect(pinResult(await cli(["upload", target])).cid).toBe(pin.cid);

    const archive = join(directory, "retrieval-export.car");
    const exported = await cli(["export", pin.cid, "--output", archive], "");
    expect(exported.code, exported.err).toBe(0);
    const car = await CarReader.fromBytes(
      new Uint8Array(await readFile(archive)),
    );
    expect((await car.getRoots())[0]!.toString()).toBe(pin.cid);
    expect(pinResult(await cli(["import", archive])).cid).toBe(pin.cid);

    const file = pinResult(
      await cli(["upload", join(source, "nested", "\u6587\u4ef6.bin")]),
    );
    const restoredFile = join(directory, "retrieval-file.bin");
    const restored = await cli(
      ["download", file.cid, "--output", restoredFile],
      "",
    );
    expect(restored.code, restored.err).toBe(0);
    expect(new Uint8Array(await readFile(restoredFile))).toEqual(large);

    const duplicate = await cli(["download", pin.cid, "--output", target], "");
    expect(duplicate.code).toBe(1);
    expect(duplicate.out).toBe("");
    expect(duplicate.err).toContain("OUTPUT_EXISTS");
    expect(
      new Uint8Array(
        await readFile(join(target, "nested", "\u6587\u4ef6.bin")),
      ),
    ).toEqual(large);
  }, 30000);

  it("renames pins through PATCH without uploading content or changing their CID", async () => {
    const source = join(directory, "rename-source");
    const bytes = new Uint8Array([5, 6, 8, 13]);
    await writeFile(source, bytes);
    const before = pinResult(
      await cli(["upload", source, "--name", "Before rename"]),
    );
    const renamed = pinResult(
      await cli(["rename", before.cid, "After rename"]),
    );
    expect(renamed).toEqual({ ...before, name: "After rename" });
    expect(pinResult(await cli(["inspect", before.cid])).name).toBe(
      "After rename",
    );
    expect(await raw(before.cid)).toEqual(bytes);
    const reader = await createToken(env, principal, {
      name: "rename-reader",
      scopes: ["pins:read"],
      expiresInDays: 1,
    });
    const denied = await cli(["rename", before.cid, "Denied"], reader.token);
    expect(denied.code).toBe(1);
    expect(denied.err).toContain('"status":403');
    expect(pinResult(await cli(["inspect", before.cid])).name).toBe(
      "After rename",
    );
  });

  it("uses private pin names as default download/export filenames in the built executable", async () => {
    const source = join(directory, "named-source");
    const data = new Uint8Array([0, 128, 255, 13]);
    await writeFile(source, data);
    const pin = pinResult(
      await cli(["upload", source, "--name", "original.bin"]),
    );
    const executable = fileURLToPath(
      new URL("../../cli/dist/main.js", import.meta.url),
    );
    const execute = async (command: string, cwd: string) => {
      const result = await promisify(execFile)(
        process.execPath,
        [executable, command, pin.cid, "--endpoint", runtimeOrigin, "--json"],
        {
          cwd,
          env: {
            ...process.env,
            PINBOARD_AGENT_TOKEN: token,
            LOCALAPPDATA: directory,
            XDG_CONFIG_HOME: directory,
          },
          timeout: 15000,
        },
      );
      expect(result.stderr).toBe("");
      return JSON.parse(result.stdout) as { path: string; type: string };
    };
    for (const command of ["download", "export"]) {
      const cwd = join(directory, `named-${command}`);
      await mkdir(cwd);
      const result = await execute(command, cwd);
      const path = join(
        cwd,
        `original.bin${command === "export" ? ".car" : ""}`,
      );
      expect(result.path).toBe(path);
      if (command === "download")
        expect(new Uint8Array(await readFile(path))).toEqual(data);
      else {
        const reader = await CarReader.fromBytes(
          new Uint8Array(await readFile(path)),
        );
        expect((await reader.getRoots())[0]!.toString()).toBe(pin.cid);
      }
    }
    pinResult(await cli(["upload", source, "--name", "archive.car"]));
    const cwd = join(directory, "named-export");
    expect((await execute("export", cwd)).path).toBe(join(cwd, "archive.car"));
  }, 30000);

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
