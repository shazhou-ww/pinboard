import { pathToFileURL } from "node:url";

export const cliPackageName = "@shazhou/pinboard";
export const developmentVersion = "0.0.0-development.0";

export function cliVersionFromTag(tag) {
  const match =
    /^@shazhou\/pinboard@((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/u.exec(
      tag,
    );
  if (
    !match ||
    match[0] !== tag ||
    !match[1].split(".").every((part) => Number.isSafeInteger(Number(part)))
  ) {
    throw new Error(
      "Expected @shazhou/pinboard@x.y.z with a stable numeric version and no leading zeros.",
    );
  }
  return match[1];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(cliVersionFromTag(process.argv[2] ?? ""));
}
