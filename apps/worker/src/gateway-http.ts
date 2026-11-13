import { HTTPException } from "hono/http-exception";

const RAW_TYPE = "application/vnd.ipld.raw";
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const MEDIA_RANGE = new RegExp(`^(${TOKEN})/(${TOKEN})$`);
const PARAMETER = new RegExp(
  `^(${TOKEN})[ \\t]*=[ \\t]*(${TOKEN}|"(?:[\\t !#-\\[\\]-~\\x80-\\xff]|\\\\[\\t !-~\\x80-\\xff])*")$`,
);

function splitQuoted(value: string, separator: string): string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    if (quoted && value[i] === "\\") {
      i++;
    } else if (value[i] === '"') {
      quoted = !quoted;
    } else if (!quoted && value[i] === separator) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quoted) return undefined;
  parts.push(value.slice(start).trim());
  return parts;
}

function malformedAccept(): never {
  throw new HTTPException(400, { message: "Malformed Accept header" });
}

export function acceptsRaw(accept: string): boolean {
  return mediaQuality(parseAccept(accept), RAW_TYPE).q > 0;
}

export function mediaQuality(
  ranges: ReturnType<typeof parseAccept>,
  requested: string,
) {
  let specificity = -1;
  let quality = 0;
  for (const { type, q, parameters } of ranges) {
    if (parameters.size !== 0) continue;
    const rank =
      type === requested
        ? 2
        : type === `${requested.split("/")[0]}/*`
          ? 1
          : type === "*/*"
            ? 0
            : -1;
    // A specific exclusion overrides a broader positive wildcard.
    const weight = rank < 0 ? -1 : rank * 100 + parameters.size;
    if (weight > specificity) {
      specificity = weight;
      quality = q;
    } else if (weight === specificity) {
      quality = Math.max(quality, q);
    }
  }
  return { q: specificity >= 0 ? quality : 0, specificity };
}

export function parseAccept(accept: string) {
  const ranges = splitQuoted(accept, ",") ?? malformedAccept();
  const result = [];
  for (const range of ranges) {
    const [media, ...parameters] = splitQuoted(range, ";") ?? malformedAccept();
    const match = MEDIA_RANGE.exec(media!);
    if (!match || (match[1] === "*" && match[2] !== "*")) malformedAccept();
    const names = new Set<string>();
    let q = 1;
    const mediaParameters = new Map<string, string>();
    for (const parameter of parameters) {
      const parsed = PARAMETER.exec(parameter);
      if (!parsed) malformedAccept();
      const name = parsed[1]!.toLowerCase();
      if (names.has(name)) malformedAccept();
      names.add(name);
      if (name === "q") {
        if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(parsed[2]!))
          malformedAccept();
        q = Number(parsed[2]);
      } else {
        const value = parsed[2]!;
        mediaParameters.set(
          name,
          value.startsWith('"')
            ? value.slice(1, -1).replace(/\\(.)/g, "$1")
            : value,
        );
      }
    }
    result.push({ type: media!.toLowerCase(), q, parameters: mediaParameters });
  }
  return result;
}

export function matchesEtag(value: string | undefined, etag: string): boolean {
  if (value === undefined) return false;
  if (value.trim() === "*") return true;
  const tag = '(?:W/)?"[\\x21\\x23-\\x7e\\x80-\\xff]*"';
  if (
    !new RegExp(`^[ \\t]*${tag}(?:[ \\t]*,[ \\t]*${tag})*[ \\t]*$`).test(value)
  )
    return false;
  return (value.match(new RegExp(tag, "g")) ?? []).some(
    (candidate) => candidate.replace(/^W\//, "") === etag,
  );
}

export function onlyIfCached(value: string | undefined): boolean {
  return (
    splitQuoted(value ?? "", ",")?.some(
      (directive) => directive.toLowerCase() === "only-if-cached",
    ) ?? false
  );
}
