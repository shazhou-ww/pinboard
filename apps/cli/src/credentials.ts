import type { ReadStream } from "node:tty";
import { CliError, usage } from "./errors.js";
import { validToken } from "./endpoint.js";
import type { Store } from "./store.js";

export async function stdinToken(
  input: NodeJS.ReadableStream,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let value = "";
    const clean = () => {
      input.off("data", data);
      input.off("end", end);
      input.off("error", failure);
      signal.removeEventListener("abort", abort);
      input.pause();
    };
    const failure = () => {
      clean();
      reject(new CliError("TOKEN_INPUT", "Could not read token input."));
    };
    const abort = () => {
      clean();
      reject(signal.reason as Error);
    };
    const data = (chunk: Buffer | string) => {
      value += chunk.toString();
      if (value.length > 4098) {
        clean();
        reject(new CliError("TOKEN_INPUT", "Token input exceeds the limit."));
      }
    };
    const end = () => {
      clean();
      try {
        resolve(validToken(value.replace(/\r?\n$/u, "")));
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new CliError("TOKEN_INPUT", "Invalid token input."),
        );
      }
    };
    input.on("data", data);
    input.on("end", end);
    input.on("error", failure);
    signal.addEventListener("abort", abort, { once: true });
    input.resume();
  });
}

export async function hiddenToken(
  input: ReadStream,
  output: NodeJS.WritableStream,
  signal: AbortSignal,
): Promise<string> {
  if (!input.isTTY)
    return usage("Use --token-stdin explicitly when not reading from a TTY.");
  signal.throwIfAborted();
  output.write("Token (hidden): ");
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  return new Promise((resolve, reject) => {
    let value = "";
    const clean = () => {
      input.off("data", data);
      input.off("error", failure);
      signal.removeEventListener("abort", abort);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
    };
    const failure = () => {
      clean();
      reject(new CliError("TOKEN_INPUT", "Could not read hidden token."));
    };
    const abort = () => {
      clean();
      reject(signal.reason as Error);
    };
    const data = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === "\u0003") {
          clean();
          reject(new CliError("INTERRUPTED", "Interrupted.", 130));
          return;
        }
        if (char === "\r" || char === "\n") {
          clean();
          try {
            resolve(validToken(value));
          } catch (error) {
            reject(
              error instanceof Error
                ? error
                : new CliError("TOKEN_INPUT", "Invalid token input."),
            );
          }
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
        if (value.length > 4096) {
          failure();
          return;
        }
      }
    };
    input.on("data", data);
    input.on("error", failure);
    signal.addEventListener("abort", abort, { once: true });
    input.resume();
  });
}

export async function credentials(
  store: Store,
  origin: string,
  env: NodeJS.ProcessEnv,
  useStdin: boolean,
  input: NodeJS.ReadableStream,
  signal: AbortSignal,
  optional = false,
): Promise<string | undefined> {
  if (env.PINBOARD_AGENT_TOKEN !== undefined) {
    if (useStdin)
      return usage(
        "PINBOARD_AGENT_TOKEN and --token-stdin are mutually exclusive.",
      );
    return validToken(env.PINBOARD_AGENT_TOKEN);
  }
  if (useStdin) return stdinToken(input, signal);
  const token = await store.token(origin);
  if (token === undefined && !optional)
    throw new CliError(
      "TOKEN_REQUIRED",
      "No token for this endpoint. Use config set-token, PINBOARD_AGENT_TOKEN or --token-stdin.",
    );
  return token;
}
