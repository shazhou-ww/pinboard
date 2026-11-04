import { usage } from "./errors.js";

export const defaultEndpoint = "https://pinboard.shazhou.work";

export function endpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return usage("Endpoint must be an HTTP(S) origin.");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    /[?#]/u.test(value) ||
    /^[a-z]+:\/\/[^/]*@/iu.test(value)
  )
    return usage(
      "Endpoint must be an HTTP(S) origin without credentials, path, query or fragment.",
    );
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
  if (url.protocol === "http:" && !loopback)
    return usage("Plain HTTP is permitted only for loopback endpoints.");
  return url.origin;
}

export function resolveEndpoint(
  override: string | undefined,
  env: NodeJS.ProcessEnv,
  config: { endpoint?: string },
): string {
  return endpoint(
    override ?? env.PINBOARD_ENDPOINT ?? config.endpoint ?? defaultEndpoint,
  );
}

export function validToken(value: string): string {
  if (!value || value.length > 4096 || !/^[\x21-\x7e]+$/u.test(value))
    return usage(
      "Token must be a nonempty printable ASCII value without whitespace.",
    );
  return value;
}
