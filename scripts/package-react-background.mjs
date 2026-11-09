import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageVersionFromTag } from "./validate-cli-release.mjs";
import { backgroundPackageName } from "./validate-npm-release.mjs";

const source = fileURLToPath(
  new URL("../packages/react-engraved-background/", import.meta.url),
);
if (process.argv.length !== 3) {
  throw new Error("Usage: pnpm prepare:background x.y.z");
}
const version = packageVersionFromTag(
  `${backgroundPackageName}@${process.argv[2]}`,
  backgroundPackageName,
);
const manifest = JSON.parse(
  await readFile(join(source, "package.json"), "utf8"),
);
if (manifest.name !== backgroundPackageName) {
  throw new Error(
    "Background workspace name does not match the release package.",
  );
}
const compiled = (await readdir(join(source, "dist"))).filter((name) =>
  /\.(?:js|d\.ts)$/u.test(name),
);
if (!compiled.includes("index.js") || !compiled.includes("index.d.ts")) {
  throw new Error("Build the background package before preparing a release.");
}
const output = join(source, "dist", "npm");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "dist"), { recursive: true });
for (const name of compiled) {
  await copyFile(join(source, "dist", name), join(output, "dist", name));
}
for (const name of ["README.md", "LICENSE", "preview.png"]) {
  await copyFile(join(source, name), join(output, name));
}
await writeFile(
  join(output, "package.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version,
      description: manifest.description,
      license: manifest.license,
      type: manifest.type,
      sideEffects: manifest.sideEffects,
      files: manifest.files,
      exports: manifest.exports,
      peerDependencies: manifest.peerDependencies,
      repository: manifest.repository,
      homepage: manifest.homepage,
      bugs: manifest.bugs,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Prepared ${backgroundPackageName}@${version} in ${output}`);
