import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { isBuiltin } from "node:module";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cliPackageName,
  cliVersionFromTag,
  developmentVersion,
} from "./validate-cli-release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "apps", "cli");
const output = join(source, "dist", "npm");
const requestedVersion = process.argv[2];
if (process.argv.length > 3) throw new Error("Usage: pnpm package:cli [x.y.z]");
const packageManager = process.env.npm_execpath;
if (!packageManager || !/^pnpm(?:\.|$)/u.test(basename(packageManager)))
  throw new Error("Build the npm artifact through pnpm package:cli.");
const version =
  requestedVersion === undefined
    ? developmentVersion
    : cliVersionFromTag(`${cliPackageName}@${requestedVersion}`);
const workspace = JSON.parse(
  await readFile(join(source, "package.json"), "utf8"),
);
const project = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (workspace.name !== cliPackageName)
  throw new Error("CLI workspace name does not match the release package.");

const executable = join(output, "dist", "main.js");
const result = await build({
  entryPoints: [join(source, "src", "main.ts")],
  outfile: executable,
  platform: "node",
  target: "node22.13",
  format: "esm",
  bundle: true,
  write: false,
  metafile: true,
  legalComments: "eof",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
for (const entry of Object.values(result.metafile.outputs))
  for (const dependency of entry.imports)
    if (dependency.external && !isBuiltin(dependency.path))
      throw new Error(`Unbundled runtime dependency: ${dependency.path}`);
if (result.outputFiles.length !== 1)
  throw new Error("Expected one standalone CLI executable.");
if (!result.outputFiles[0].text.startsWith("#!/usr/bin/env node\n"))
  throw new Error("The standalone CLI is missing its executable shebang.");

const licenses = new Map();
const bundledInputs = new Set(
  Object.values(result.metafile.outputs).flatMap((entry) =>
    Object.entries(entry.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([path]) => path),
  ),
);
for (const input of bundledInputs) {
  let directory = dirname(resolve(input));
  if (!directory.split(sep).includes("node_modules")) continue;
  let found = false;
  while (directory.split(sep).includes("node_modules")) {
    let metadata;
    try {
      metadata = JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (metadata?.name) {
      found = true;
      const identity = `${metadata.name}@${metadata.version}`;
      if (!licenses.has(identity)) {
        const packageFiles = await readdir(directory);
        const names = packageFiles
          .filter((name) =>
            /^(licen[cs]e|copying|notice)(?:$|[.-])/iu.test(name),
          )
          .sort();
        const notices = await Promise.all(
          names.map(
            async (name) =>
              `${name}\n${await readFile(join(directory, name), "utf8")}`,
          ),
        );
        if (!names.length) {
          const selectedLicense = [
            "MIT",
            "Apache-2.0 OR MIT",
            "(Apache-2.0 OR MIT)",
          ].includes(metadata.license)
            ? "MIT"
            : metadata.license;
          if (
            !["MIT", "ISC"].includes(selectedLicense) ||
            project.license !== "MIT"
          )
            throw new Error(
              `Missing license notice for bundled dependency ${identity}`,
            );
          const ownLicense = await readFile(join(root, "LICENSE"), "utf8");
          const start = ownLicense.indexOf("Permission is hereby granted");
          if (start < 0)
            throw new Error(
              "Cannot locate the standard MIT permission notice.",
            );
          const readme = packageFiles.find((name) =>
            /^readme(?:$|[.-])/iu.test(name),
          );
          const permission =
            selectedLicense === "MIT"
              ? ownLicense.slice(start)
              : [
                  "Permission to use, copy, modify, and/or distribute this software for any",
                  "purpose with or without fee is hereby granted, provided that the above",
                  "copyright notice and this permission notice appear in all copies.",
                  "",
                  'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES',
                  "WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF",
                  "MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR",
                  "ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES",
                  "WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION",
                  "OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN",
                  "CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.",
                ].join("\n");
          // Some permissive packages ship only an SPDX declaration. Retain all supplied
          // attribution and README notices alongside the full permission terms.
          notices.push(
            JSON.stringify(
              {
                name: metadata.name,
                version: metadata.version,
                license: metadata.license,
                selectedLicense,
                author: metadata.author,
                contributors: metadata.contributors,
                repository: metadata.repository,
              },
              null,
              2,
            ),
            permission,
          );
          if (readme)
            notices.push(await readFile(join(directory, readme), "utf8"));
        }
        licenses.set(identity, notices.join("\n\n"));
      }
      break;
    }
    directory = dirname(directory);
  }
  if (!found)
    throw new Error(`Cannot identify bundled dependency license for ${input}`);
}

await rm(output, { recursive: true, force: true });
await mkdir(dirname(executable), { recursive: true });
await writeFile(executable, result.outputFiles[0].contents, { mode: 0o755 });
await chmod(executable, 0o755);
await copyFile(join(source, "README.md"), join(output, "README.md"));
await copyFile(join(root, "LICENSE"), join(output, "LICENSE"));
await writeFile(
  join(output, "THIRD_PARTY_LICENSES.txt"),
  [...licenses]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([identity, notice]) =>
        `${identity}\n${"=".repeat(identity.length)}\n${notice}`,
    )
    .join("\n\n") + "\n",
);
await writeFile(
  join(output, "package.json"),
  JSON.stringify(
    {
      name: cliPackageName,
      version,
      description:
        "Upload, download and manage public IPFS content with Pinboard.",
      private: requestedVersion === undefined,
      type: "module",
      license: project.license,
      bin: { pinboard: "./dist/main.js" },
      files: [
        "dist/main.js",
        "README.md",
        "LICENSE",
        "THIRD_PARTY_LICENSES.txt",
      ],
      engines: project.engines,
      repository: { ...project.repository, directory: "apps/cli" },
      homepage: project.homepage,
      bugs: project.bugs,
      publishConfig: { access: "public" },
    },
    null,
    2,
  ) + "\n",
);
console.log(`Prepared ${cliPackageName}@${version} in ${output}`);
execFileSync(
  process.execPath,
  [
    packageManager,
    "--dir",
    output,
    "pack",
    "--pack-destination",
    dirname(output),
  ],
  { stdio: "inherit" },
);
