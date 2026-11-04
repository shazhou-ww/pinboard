import type { ReadStream } from "node:tty";
import { CliError, usage } from "./errors.js";
import { resolveEndpoint } from "./endpoint.js";
import { configDirectory, Store } from "./store.js";
import { credentials, hiddenToken, stdinToken } from "./credentials.js";
import { Client } from "./client.js";
import { prepareInput } from "./input.js";

export const help = `Pinboard — public IPFS uploads; no Kubo or daemon required.

pinboard upload <file|directory> [--name LABEL]
pinboard import <archive.car> [--name LABEL]
pinboard list [--cursor CURSOR] [--all]
pinboard inspect <CID>
pinboard remove <CID>
pinboard config get [endpoint]
pinboard config set endpoint <ORIGIN>
pinboard config set-token [--endpoint ORIGIN] [--token-stdin]
pinboard config remove-token [--endpoint ORIGIN]

Network options: --endpoint ORIGIN, --token-stdin, --timeout MS (default 60000).
All commands: --json, --help.
Endpoint: flag > PINBOARD_ENDPOINT > config > https://pinboard.shazhou.work.
Token: PINBOARD_AGENT_TOKEN OR --token-stdin, otherwise endpoint-bound tokens.json.

Upload/import publish PUBLIC content: anyone knowing the CID can read it.
No confirmation or --public flag. Hidden files are included; empty directories
are ignored and entirely empty directories rejected. upload treats .car as an
ordinary file; import preserves the CAR root. Labels may duplicate.
remove only unpins your account reference: public blocks, CDN and other copies
are NOT erased. config remove-token is local only, not server revocation.
Persistent tokens are plaintext protected by OS permissions, not encrypted.
Never pass tokens in command arguments. Obtain/revoke agent tokens in Web.
Writes are never automatically retried; a lost response may mean a completed write.
`;

interface Options {
  words: string[];
  flags: Map<string, string | true>;
}

function parse(args: string[]): Options {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  const booleans = new Set(["json", "help", "all", "token-stdin"]);
  const values = new Set(["name", "endpoint", "cursor", "timeout"]);
  let literal = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (literal || !arg.startsWith("-")) {
      words.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    const key = arg.slice(2);
    if (!arg.startsWith("--") || (!booleans.has(key) && !values.has(key)))
      return usage("Unknown option. See --help.");
    if (flags.has(key)) return usage("Options may not be repeated.");
    if (booleans.has(key)) flags.set(key, true);
    else {
      const value = args[++index];
      if (value === undefined || value.startsWith("--"))
        return usage("Option requires a value.");
      flags.set(key, value);
    }
  }
  return { words, flags };
}

export interface Runtime {
  env: NodeJS.ProcessEnv;
  input: NodeJS.ReadableStream;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}

export async function run(args: string[], runtime: Runtime): Promise<number> {
  const json = args.includes("--json");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let signal = runtime.signal;
  try {
    const { words, flags } = parse(args);
    const value = (key: string) => {
      const result = flags.get(key);
      return typeof result === "string" ? result : undefined;
    };
    if (flags.has("help") || !words.length) {
      runtime.out.write(json ? JSON.stringify({ help }) + "\n" : help);
      return 0;
    }
    const command = words[0]!;
    const configAction = command === "config" ? words[1] : undefined;
    const network = ["upload", "import", "list", "inspect", "remove"].includes(
      command,
    );
    const allowed = new Set(["json", "help"]);
    if (
      network ||
      configAction === "set-token" ||
      configAction === "remove-token"
    )
      allowed.add("endpoint");
    if (network || configAction === "set-token") {
      allowed.add("token-stdin");
      allowed.add("timeout");
    }
    if (command === "upload" || command === "import") allowed.add("name");
    if (command === "list") {
      allowed.add("cursor");
      allowed.add("all");
    }
    for (const flag of flags.keys())
      if (!allowed.has(flag))
        return usage("Option is not valid for this command.");
    if (
      (!network && command !== "config") ||
      (network && words.length !== (command === "list" ? 1 : 2))
    )
      return usage("Invalid command or arguments. See --help.");
    const timeout = Number(value("timeout") ?? 60000);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000)
      return usage(
        "--timeout must be an integer from 1 to 3600000 milliseconds.",
      );
    const deadline = new AbortController();
    timer = setTimeout(() => {
      deadline.abort(new CliError("TIMEOUT", "Operation timed out."));
    }, timeout);
    signal = AbortSignal.any([runtime.signal, deadline.signal]);
    signal.throwIfAborted();
    const store = new Store(configDirectory(runtime.env), signal);
    const config = await store.config();
    const origin = resolveEndpoint(value("endpoint"), runtime.env, config);
    let result: unknown;
    if (command === "config") {
      if (
        configAction === "get" &&
        (words.length === 2 || (words.length === 3 && words[2] === "endpoint"))
      ) {
        result = { endpoint: origin };
      } else if (
        configAction === "set" &&
        words.length === 4 &&
        words[2] === "endpoint"
      ) {
        await store.setEndpoint(words[3]!);
        result = { saved: true };
      } else if (configAction === "set-token" && words.length === 2) {
        if (runtime.env.PINBOARD_AGENT_TOKEN !== undefined)
          return usage(
            "Unset PINBOARD_AGENT_TOKEN before saving a local token.",
          );
        const token = flags.has("token-stdin")
          ? await stdinToken(runtime.input, signal)
          : await hiddenToken(runtime.input as ReadStream, runtime.err, signal);
        await store.setToken(origin, token);
        result = { saved: true, endpoint: origin };
      } else if (configAction === "remove-token" && words.length === 2) {
        await store.removeToken(origin);
        result = { removed: true, endpoint: origin, revoked: false };
      } else return usage("Invalid config command. See --help.");
    } else {
      const token = await credentials(
        store,
        origin,
        runtime.env,
        flags.has("token-stdin"),
        runtime.input,
        signal,
      );
      const client = new Client(origin, token, signal, runtime.fetcher);
      switch (command) {
        case "upload":
        case "import": {
          if (!json)
            runtime.err.write("Preparing public upload (not yet saved)...\n");
          const input = await prepareInput(
            words[1]!,
            command === "import",
            value("name"),
            signal,
          );
          if (!json)
            runtime.err.write(
              "Uploading public content (not yet confirmed)...\n",
            );
          result = await client.upload(
            input.bytes,
            input.kind,
            input.name,
            input.root,
          );
          break;
        }
        case "list":
          result = await client.list(value("cursor"), flags.has("all"));
          break;
        case "inspect":
          result = await client.inspect(words[1]!);
          break;
        case "remove":
          result = await client.remove(words[1]!);
          break;
      }
    }
    signal.throwIfAborted();
    if (json) runtime.out.write(JSON.stringify(result) + "\n");
    else runtime.out.write(human(result, origin) + "\n");
    return 0;
  } catch (error) {
    const filesystemCode =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      [
        "ENOENT",
        "EACCES",
        "EPERM",
        "ELOOP",
        "ENOTDIR",
        "ENOSPC",
        "EROFS",
      ].includes(error.code)
        ? error.code
        : undefined;
    let failure =
      error instanceof CliError
        ? error
        : signal.aborted && signal.reason instanceof CliError
          ? signal.reason
          : filesystemCode
            ? new CliError(
                "FILESYSTEM_ERROR",
                `Filesystem operation failed (${filesystemCode}). Check input paths, permissions and available space.`,
              )
            : new CliError(
                "OPERATION_FAILED",
                "Operation failed. Check input, local permissions and endpoint availability.",
              );
    // Never echo raw service, filesystem, HTTP-library or subprocess diagnostics.
    if (runtime.signal.aborted && failure.exitCode !== 130)
      failure = new CliError(
        "INTERRUPTED",
        failure.message,
        130,
        failure.uncertain,
        failure.recovery,
        failure.status,
      );
    const detail = {
      code: failure.code,
      message: failure.message,
      ...(failure.status === undefined ? {} : { status: failure.status }),
      ...(failure.uncertain
        ? { uncertain: true, recovery: failure.recovery }
        : {}),
    };
    runtime.err.write(
      json
        ? JSON.stringify({ error: detail }) + "\n"
        : `${detail.code}: ${detail.message}${failure.uncertain ? ` Outcome uncertain. ${failure.recovery ?? ""}` : ""}\n`,
    );
    return failure.exitCode;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function human(value: unknown, origin: string): string {
  if (value && typeof value === "object") {
    if ("pins" in value && Array.isArray(value.pins)) {
      return (
        value.pins.map((entry: unknown) => human(entry, origin)).join("\n") +
        ("nextCursor" in value && typeof value.nextCursor === "string"
          ? `\nNext cursor: ${value.nextCursor}`
          : "")
      );
    }
    if ("cid" in value && "name" in value && "size" in value)
      return `${String(value.cid)}\t${JSON.stringify(String(value.name)).slice(1, -1)}\t${String(value.size)} bytes\n${origin}/share/${String(value.cid)}`;
  }
  return JSON.stringify(value);
}
