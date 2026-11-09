import { pathToFileURL } from "node:url";
import {
  cliPackageName,
  packageVersionFromTag,
} from "./validate-cli-release.mjs";

export const backgroundPackageName = "react-engraved-background";

export function npmReleaseFromTag(tag) {
  const name = [cliPackageName, backgroundPackageName].find((name) =>
    tag.startsWith(`${name}@`),
  );
  if (!name) throw new Error("Unsupported npm package release tag.");
  return { name, version: packageVersionFromTag(tag, name) };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const release = npmReleaseFromTag(process.argv[2] ?? "");
  console.log(`package=${release.name}\nversion=${release.version}`);
}
