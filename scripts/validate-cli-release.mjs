import { pathToFileURL } from "node:url";

export const cliPackageName = "@shazhou/pinboard";
export const developmentVersion = "0.0.0-development.0";

export function packageVersionFromTag(tag, packageName) {
  const prefix = `${packageName}@`;
  const version = tag.startsWith(prefix) ? tag.slice(prefix.length) : "";
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (
    !match ||
    match[0] !== version ||
    !version.split(".").every((part) => Number.isSafeInteger(Number(part)))
  ) {
    throw new Error(
      `Expected ${packageName}@x.y.z with a stable numeric version and no leading zeros.`,
    );
  }
  return version;
}

export function cliVersionFromTag(tag) {
  return packageVersionFromTag(tag, cliPackageName);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(cliVersionFromTag(process.argv[2] ?? ""));
}
