import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { backgroundPackageName } from "./validate-npm-release.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test(
  "the exact background tarball installs offline and renders outside the checkout",
  { timeout: 60000 },
  async () => {
    const version = process.env.BACKGROUND_EXPECTED_VERSION ?? "0.0.0";
    const artifact = join(root, "packages", backgroundPackageName, "dist");
    const tarball = join(artifact, `${backgroundPackageName}-${version}.tgz`);
    assert.ok(
      existsSync(tarball),
      "Pack the release before running this test.",
    );
    const parent = process.env.PINBOARD_TEST_ROOT ?? homedir();
    await mkdir(parent, { recursive: true });
    const scratch = await mkdtemp(join(parent, ".background-npm-smoke-"));
    try {
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
      ].find((path) => existsSync(path));
      assert.ok(
        npm,
        "Cannot find the npm CLI belonging to this Node installation.",
      );
      await writeFile(
        join(scratch, "package.json"),
        '{"private":true,"type":"module"}\n',
      );
      const env = {
        ...process.env,
        NPM_CONFIG_CACHE: join(scratch, "npm-cache"),
      };
      for (const key of Object.keys(env)) {
        if (
          [
            "node_path",
            "node_options",
            "node_auth_token",
            "npm_token",
          ].includes(key.toLowerCase())
        )
          delete env[key];
      }
      await execute(
        process.execPath,
        [
          npm,
          "install",
          tarball,
          "--offline",
          "--ignore-scripts",
          "--legacy-peer-deps",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
        ],
        { cwd: scratch, env },
      );
      const installed = join(scratch, "node_modules", backgroundPackageName);
      const manifest = JSON.parse(
        await readFile(join(installed, "package.json"), "utf8"),
      );
      assert.equal(manifest.name, backgroundPackageName);
      assert.equal(manifest.version, version);
      assert.equal(manifest.private, undefined);
      assert.equal(manifest.scripts, undefined);
      assert.equal(manifest.devDependencies, undefined);
      assert.equal(manifest.dependencies, undefined);
      assert.deepEqual(manifest.peerDependencies, { react: ">=18.0.0 <20" });
      assert.equal(
        manifest.repository.directory,
        "packages/react-engraved-background",
      );
      assert.doesNotMatch(JSON.stringify(manifest), /catalog:|workspace:/u);
      for (const path of [
        "dist/index.js",
        "dist/index.d.ts",
        "LICENSE",
        "README.md",
      ]) {
        assert.ok(
          existsSync(join(installed, path)),
          `Missing package file: ${path}`,
        );
      }
      assert.equal(existsSync(join(installed, "src")), false);
      assert.equal(existsSync(join(installed, "test")), false);
      // Supply local React fixtures as an isolated consumer's peer dependencies.
      for (const name of ["react", "react-dom"]) {
        await cp(
          await realpath(join(root, "node_modules", name)),
          join(scratch, "node_modules", name),
          { recursive: true },
        );
      }
      await writeFile(
        join(scratch, "smoke.mjs"),
        `
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EngravedBackground, generateIconLayout, engravingStyles, mistPalette } from "react-engraved-background";
const Icon = props => createElement("svg", { viewBox: "0 0 24 24", ...props }, createElement("path", { d: "M2 2h20v20H2Z" }));
const html = renderToStaticMarkup(createElement(EngravedBackground, { icons: [Icon], palette: mistPalette, seed: "published-smoke" }));
assert.equal((html.match(/rotate\\(/g) ?? []).length, 70);
assert.equal((html.match(/<use /g) ?? []).length, 9);
assert.equal(engravingStyles.length, 4);
assert.deepEqual(generateIconLayout({ iconCount: 1 }), generateIconLayout({ iconCount: 1 }));
assert.match(html, /patternUnits="userSpaceOnUse"/);
assert.match(html, /flood-color="#66718b"/);
console.log("Isolated background package render passed.");
`,
      );
      const result = await execute(
        process.execPath,
        [join(scratch, "smoke.mjs")],
        { cwd: scratch, env },
      );
      assert.match(result.stdout, /Isolated background package render passed/u);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
