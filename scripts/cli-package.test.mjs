import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildDirectoryCar } from "../packages/encoding/dist/index.js";
import { verifyCar } from "../apps/cli/dist/retrieval.js";
import { cliPackageName, developmentVersion } from "./validate-cli-release.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

async function* content(bytes) {
  yield await Promise.resolve(bytes);
}

test(
  "the exact npm tarball installs offline and runs without the checkout, pnpm or Kubo",
  { timeout: 120000 },
  async () => {
    const artifact = join(root, "apps", "cli", "dist");
    const manifest = JSON.parse(
      await readFile(join(artifact, "npm", "package.json"), "utf8"),
    );
    const expectedVersion =
      process.env.PINBOARD_CLI_EXPECTED_VERSION ?? developmentVersion;
    assert.equal(manifest.name, cliPackageName);
    assert.equal(manifest.version, expectedVersion);
    assert.equal(manifest.private, expectedVersion === developmentVersion);
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.scripts, undefined);
    assert.deepEqual(manifest.bin, { pinboard: "./dist/main.js" });
    const tarball = join(artifact, `shazhou-pinboard-${manifest.version}.tgz`);
    assert.ok(
      existsSync(tarball),
      "Build the npm tarball before running this test.",
    );

    const parent = process.env.PINBOARD_TEST_ROOT ?? homedir();
    await mkdir(parent, { recursive: true });
    const scratch = await mkdtemp(join(parent, ".pinboard-npm-smoke-"));
    let server;
    try {
      const prefix = join(scratch, "installation");
      const working = join(scratch, "working");
      const runtime = join(scratch, "runtime");
      await mkdir(prefix);
      await mkdir(working);
      await mkdir(runtime);
      const node = join(
        runtime,
        process.platform === "win32" ? "node.exe" : "node",
      );
      await copyFile(process.execPath, node);
      await chmod(node, 0o755);
      const npm = [
        join(
          dirname(process.execPath),
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
        join(
          dirname(process.execPath),
          "..",
          "lib",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js",
        ),
      ].find((candidate) => existsSync(candidate));
      assert.ok(
        npm,
        "Cannot find the npm CLI belonging to this Node installation.",
      );

      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (["path", "node_path", "node_options"].includes(key.toLowerCase()))
          delete env[key];
      Object.assign(env, {
        PATH: runtime,
        NPM_CONFIG_CACHE: join(scratch, "npm-cache"),
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        LOCALAPPDATA: join(scratch, "settings"),
        XDG_CONFIG_HOME: join(scratch, "settings"),
        PINBOARD_AGENT_TOKEN: "synthetic-package-smoke-token",
      });
      const options = {
        cwd: working,
        env,
        encoding: "utf8",
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
      };
      await execute(
        process.execPath,
        [
          npm,
          "install",
          "--global",
          "--prefix",
          prefix,
          "--offline",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          tarball,
        ],
        options,
      );
      assert.deepEqual(await readdir(runtime), [
        process.platform === "win32" ? "node.exe" : "node",
      ]);
      const installed =
        process.platform === "win32"
          ? join(prefix, "node_modules", "@shazhou", "pinboard")
          : join(prefix, "lib", "node_modules", "@shazhou", "pinboard");
      assert.deepEqual(
        JSON.parse(await readFile(join(installed, "package.json"), "utf8")),
        manifest,
      );
      const files = [];
      async function walk(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path);
          else files.push(relative(installed, path).split(sep).join("/"));
        }
      }
      await walk(installed);
      assert.deepEqual(files.sort(), [
        "LICENSE",
        "README.md",
        "THIRD_PARTY_LICENSES.txt",
        "dist/main.js",
        "package.json",
      ]);
      assert.match(
        await readFile(join(installed, "THIRD_PARTY_LICENSES.txt"), "utf8"),
        /@ipld\/car@/u,
      );
      const shim =
        process.platform === "win32"
          ? join(prefix, "pinboard.cmd")
          : join(prefix, "bin", "pinboard");
      const help =
        process.platform === "win32"
          ? await execute(
              process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
              ["/d", "/s", "/c", `""${shim}" --help"`],
              { ...options, windowsVerbatimArguments: true },
            )
          : await execute(shim, ["--help"], options);
      assert.match(help.stdout, /pinboard upload/u);
      assert.match(help.stdout, /pinboard download/u);
      assert.match(help.stdout, /pinboard rename/u);

      const fixtureFiles = [
        { path: ".hidden", bytes: new Uint8Array([0, 255, 13]) },
        {
          path: "nested/\u6587\u4ef6.bin",
          bytes: new Uint8Array([128, 0, 10, 254]),
        },
        { path: "empty", bytes: new Uint8Array() },
      ];
      const fixture = await buildDirectoryCar(
        fixtureFiles.map((file) => ({
          path: file.path,
          size: file.bytes.length,
          content: content(file.bytes),
        })),
      );
      const fixtureDag = await verifyCar(
        fixture.bytes,
        fixture.root,
        new AbortController().signal,
      );
      let pin = {
        cid: fixture.root,
        name: "package-smoke",
        size: [...fixtureDag.blocks.values()].reduce(
          (total, bytes) => total + bytes.length,
          0,
        ),
        blocks: fixtureDag.blocks.size,
        createdAt: "2026-11-04T00:00:00Z",
        visibility: "private",
      };
      let removed = false;
      let serverError;
      server = createServer((request, response) => {
        const handle = async () => {
          const url = new URL(request.url, "http://127.0.0.1");
          if (url.pathname === `/api/public/${fixture.root}/car`) {
            assert.ok(request.headers.authorization?.startsWith("Bearer "));
            response.writeHead(200, {
              "content-type": "application/vnd.ipld.car; version=1",
            });
            response.end(fixture.bytes);
            return;
          }
          assert.equal(
            request.headers.authorization,
            "Bearer synthetic-package-smoke-token",
          );
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const bytes = Buffer.concat(chunks);
          let body;
          if (
            request.method === "POST" &&
            url.pathname === "/api/pins/upload"
          ) {
            assert.equal(url.searchParams.get("kind"), "car");
            assert.equal(request.headers["x-pinboard-public"], "true");
            const uploaded = await verifyCar(
              new Uint8Array(bytes),
              fixture.root,
              new AbortController().signal,
            );
            assert.deepEqual(uploaded.blocks, fixtureDag.blocks);
            pin = { ...pin, name: url.searchParams.get("name") };
            body = pin;
          } else if (
            request.method === "PATCH" &&
            url.pathname === `/api/pins/${fixture.root}`
          ) {
            assert.equal(request.headers["content-type"], "application/json");
            pin = { ...pin, name: JSON.parse(bytes.toString()).name };
            body = pin;
          } else if (
            request.method === "DELETE" &&
            url.pathname === `/api/pins/${fixture.root}`
          ) {
            removed = true;
            response.writeHead(204);
            response.end();
            return;
          } else if (
            request.method === "GET" &&
            url.pathname === `/api/pins/${fixture.root}`
          ) {
            body = pin;
          } else if (request.method === "GET" && url.pathname === "/api/pins") {
            body = { pins: removed ? [] : [pin], nextCursor: null };
          } else {
            throw new Error(
              `Unexpected smoke request: ${request.method} ${url.pathname}`,
            );
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };
        void handle().catch((error) => {
          serverError = error;
          response.writeHead(500);
          response.end("Package smoke fixture failed.");
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      env.PINBOARD_ENDPOINT = `http://127.0.0.1:${address.port}`;
      const entry = join(installed, "dist", "main.js");
      const cli = async (...args) => {
        const result = await execute(
          node,
          [entry, ...args, "--json"],
          options,
        ).catch((error) => {
          throw serverError ?? error;
        });
        assert.equal(result.stderr, "");
        assert.equal(result.stdout.trim().split("\n").length, 1);
        return JSON.parse(result.stdout);
      };
      assert.deepEqual(await cli("config", "get", "endpoint"), {
        endpoint: env.PINBOARD_ENDPOINT,
      });
      const source = join(working, "source");
      await mkdir(join(source, "nested"), { recursive: true });
      for (const file of fixtureFiles)
        await writeFile(join(source, ...file.path.split("/")), file.bytes);
      assert.equal(
        (await cli("upload", source, "--name", "package-smoke")).cid,
        fixture.root,
      );
      const archive = join(working, "archive.car");
      assert.equal(
        (await cli("export", fixture.root, "--output", archive)).type,
        "car",
      );
      assert.deepEqual(new Uint8Array(await readFile(archive)), fixture.bytes);
      assert.equal((await cli("import", archive)).cid, fixture.root);
      assert.equal(
        (await cli("rename", fixture.root, "restored-folder")).name,
        "restored-folder",
      );
      assert.equal(
        (await cli("inspect", fixture.root)).name,
        "restored-folder",
      );
      const downloaded = await cli("download", fixture.root);
      assert.equal(downloaded.path, join(working, "restored-folder"));
      for (const file of fixtureFiles)
        assert.deepEqual(
          new Uint8Array(
            await readFile(join(downloaded.path, ...file.path.split("/"))),
          ),
          file.bytes,
        );
      assert.equal((await cli("list")).pins.length, 1);
      assert.equal((await cli("remove", fixture.root)).removed, true);
      assert.deepEqual(await cli("list"), { pins: [], nextCursor: null });
      assert.equal(serverError, undefined);
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
