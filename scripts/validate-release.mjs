import { pathToFileURL } from "node:url";

export function validateReleaseTag(tag) {
  const match = /^release-(\d{2})(\d{2})(\d{2})-([1-9]\d*)$/.exec(tag);
  if (!match) {
    throw new Error(
      "Expected release-YYMMDD-INDEX, with a positive index and no leading zeros (for example release-261103-1)",
    );
  }
  const year = 2000 + Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(
      "Release tag must contain a valid calendar date in 2000-2099",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  validateReleaseTag(process.argv[2] ?? "");
  console.log(`Validated release tag: ${process.argv[2]}`);
}
