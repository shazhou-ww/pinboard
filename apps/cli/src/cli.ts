import type { ReadStream } from "node:tty";
import stringWidth from "string-width";
import { CliError, usage } from "./errors.js";
import { resolveEndpoint } from "./endpoint.js";
import { configDirectory, Store } from "./store.js";
import { credentials, hiddenToken, stdinToken } from "./credentials.js";
import { canonicalCid, Client } from "./client.js";
import { prepareInput } from "./input.js";
import { pinFilename, saveContent } from "./retrieval.js";

export const help = `Pinboard — public IPFS storage.

pinboard upload <file|directory> [--name LABEL]
pinboard import <archive.car> [--name LABEL]
pinboard download <CID> [--output PATH]
pinboard export <CID> [--output PATH]
pinboard list [--cursor CURSOR] [--all]
pinboard inspect <CID>
pinboard rename <CID> <NAME>
pinboard remove|restore <CID>
pinboard deleted [--cursor CURSOR]
pinboard publication create|convert <CID> --title TITLE --request-id KEY
pinboard description get|set|clear <ROOT_CID> <NODE_CID> [--text TEXT --version N]
pinboard description export <ROOT_CID>
pinboard publication list [--cursor CURSOR]
pinboard publication get|history <ID> [--revision N (get only)]
pinboard publication description <ID> <NODE_CID> --revision N
pinboard publication download|export <ID> [--revision N] [--output PATH]
pinboard publication publish <ID> <CID> --sequence N --request-id KEY
pinboard publication rollback <ID> <REVISION> --sequence N --request-id KEY
pinboard publication remove|restore <ID>
Upload/import options: --publication ID --sequence N --request-id KEY
Current-CID publish is NOP; draft description changes are not applied.
pinboard config get [endpoint]
pinboard config set endpoint <ORIGIN>
pinboard config set-token [--endpoint ORIGIN] [--token-stdin]
pinboard config remove-token [--endpoint ORIGIN]

Network options: --endpoint ORIGIN, --token-stdin, --timeout MS (default 60000).
All commands: --json, --help.
`;

interface Options {
  words: string[];
  flags: Map<string, string | true>;
}

function parse(args: string[]): Options {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  const booleans = new Set(["json", "help", "all", "token-stdin"]);
  const values = new Set([
    "name",
    "endpoint",
    "cursor",
    "timeout",
    "output",
    "publication",
    "sequence",
    "request-id",
    "title",
    "revision",
    "text",
    "version",
  ]);
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
  const tty = "isTTY" in runtime.out && runtime.out.isTTY === true;
  const progress = async (message: string, warning = false) => {
    if (json && !warning) return;
    await new Promise<void>((resolve, reject) => {
      runtime.err.write(
        json
          ? JSON.stringify({
              warning: { code: "PIN_NAME_UNAVAILABLE", message },
            }) + "\n"
          : `[${new Date().toISOString()}] ${warning ? "Warning: " : ""}${message}\n`,
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  };
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
    const publicRead =
      command === "download" ||
      command === "export" ||
      (command === "publication" &&
        ["get", "history", "download", "export", "description"].includes(
          words[1] ?? "",
        ));
    const network = [
      "upload",
      "import",
      "list",
      "inspect",
      "remove",
      "rename",
      "download",
      "export",
      "publication",
      "deleted",
      "restore",
      "description",
    ].includes(command);
    const allowed = new Set(["json", "help"]);
    if (
      network ||
      configAction === "set-token" ||
      configAction === "remove-token"
    )
      allowed.add("endpoint");
    if (network || configAction === "set-token") {
      if (!publicRead) allowed.add("token-stdin");
      allowed.add("timeout");
    }
    if (command === "download" || command === "export") allowed.add("output");
    if (command === "upload" || command === "import") {
      for (const flag of ["name", "publication", "sequence", "request-id"])
        allowed.add(flag);
    }
    if (command === "publication") {
      const action = words[1];
      const lengths: Record<string, number> = {
        create: 3,
        convert: 3,
        list: 2,
        get: 3,
        history: 3,
        publish: 4,
        rollback: 4,
        remove: 3,
        restore: 3,
        download: 3,
        export: 3,
        description: 4,
      };
      if (!action || words.length !== lengths[action])
        return usage("Invalid publication command. See --help.");
      if (action === "create" || action === "convert") {
        allowed.add("title");
        allowed.add("request-id");
      }
      if (action === "list") allowed.add("cursor");
      if (
        action === "get" ||
        action === "download" ||
        action === "export" ||
        action === "description"
      )
        allowed.add("revision");
      if (action === "download" || action === "export") allowed.add("output");
      if (action === "publish" || action === "rollback") {
        allowed.add("sequence");
        allowed.add("request-id");
      }
    }
    if (command === "description") {
      const action = words[1];
      if (
        !action ||
        !["get", "set", "clear", "export"].includes(action) ||
        words.length !== (action === "export" ? 3 : 4)
      )
        return usage("Invalid description command. See --help.");
      if (action === "set") allowed.add("text");
      if (action === "set" || action === "clear") allowed.add("version");
    }
    if (command === "list" || command === "deleted") {
      allowed.add("cursor");
      if (command === "list") allowed.add("all");
    }
    for (const flag of flags.keys())
      if (!allowed.has(flag))
        return usage("Option is not valid for this command.");
    if (
      (!network && command !== "config") ||
      (network &&
        command !== "publication" &&
        command !== "description" &&
        words.length !==
          (command === "list" || command === "deleted"
            ? 1
            : command === "rename"
              ? 3
              : 2))
    )
      return usage("Invalid command or arguments. See --help.");
    if (publicRead && value("output") === "")
      return usage("--output requires a non-empty path.");
    const timeout = Number(value("timeout") ?? 60000);
    const sequence = () => {
      const expectedSequence = Number(value("sequence"));
      if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 1)
        return usage(
          "--sequence must be a positive integer from the publication's current sequence.",
        );
      const requestId = value("request-id");
      if (!requestId || requestId.length > 128)
        return usage(
          "--request-id requires 1-128 characters; reuse it only for identical retries.",
        );
      return { expectedSequence, requestId };
    };
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
      const token = publicRead
        ? undefined
        : await credentials(
            store,
            origin,
            runtime.env,
            flags.has("token-stdin"),
            runtime.input,
            signal,
          );
      const client = new Client(origin, token, signal, runtime.fetcher);
      switch (command) {
        case "description": {
          const action = words[1];
          if (action === "export")
            result = await client.descriptions(words[2]!);
          else if (action === "get")
            result = await client.description(words[2]!, words[3]!);
          else {
            const expectedVersion = Number(value("version"));
            const text = action === "clear" ? null : value("text");
            if (
              value("version") === undefined ||
              !Number.isSafeInteger(expectedVersion) ||
              expectedVersion < 0 ||
              text === undefined ||
              (text !== null && text.length > 8000)
            )
              return usage(
                "Provide --version (nonnegative integer) and --text (at most 8000 characters) for set.",
              );
            result = await client.description(words[2]!, words[3]!, {
              text,
              expectedVersion,
            });
          }
          break;
        }
        case "deleted":
          result = await client.deleted(value("cursor"));
          break;
        case "restore":
          result = await client.restore(words[1]!);
          break;
        case "publication": {
          const action = words[1]!;
          if (action === "create" || action === "convert") {
            const title = value("title")?.trim();
            const requestId = value("request-id");
            if (
              !title ||
              title.length > 200 ||
              !requestId ||
              requestId.length > 128
            )
              return usage(
                "Create requires --title (1-200 characters) and --request-id (1-128 characters). Title and complete history are public.",
              );
            result =
              action === "convert"
                ? await client.convert(words[2]!, title, requestId)
                : await client.publication(action, undefined, {
                    cid: canonicalCid(words[2]!),
                    title,
                    requestId,
                    public: true,
                  });
          } else if (action === "publish") {
            result = await client.publication(action, words[2], {
              cid: canonicalCid(words[3]!),
              ...sequence(),
            });
          } else if (action === "rollback") {
            const revision = Number(words[3]);
            if (!Number.isSafeInteger(revision) || revision < 1)
              return usage("Revision must be a positive integer.");
            result = await client.publication(action, words[2], {
              revision,
              ...sequence(),
            });
          } else {
            const revision =
              value("revision") === undefined
                ? undefined
                : Number(value("revision"));
            if (
              revision !== undefined &&
              (!Number.isSafeInteger(revision) || revision < 1)
            )
              return usage("--revision must be a positive integer.");
            if (action === "description") {
              if (revision === undefined)
                return usage("Publication description requires --revision N.");
              result = await client.publishedDescription(
                words[2]!,
                revision,
                words[3]!,
              );
              break;
            }
            if (action === "download" || action === "export") {
              const cid = await client.publicationCid(words[2]!, revision);
              await progress(
                `Resolved publication to ${cid}; downloading this fixed CID...`,
              );
              result = await saveContent(
                await client.car(cid),
                cid,
                value("output"),
                action === "export",
                signal,
              );
              break;
            }
            result = await client.publication(action, words[2], {
              ...(revision === undefined ? {} : { revision }),
              ...(value("cursor") === undefined
                ? {}
                : { cursor: value("cursor") }),
            });
          }
          break;
        }
        case "download":
        case "export": {
          const cid = canonicalCid(words[1]!);
          let output = value("output");
          let filenameWarning: string | undefined;
          if (output === undefined) {
            const namingToken = await credentials(
              store,
              origin,
              runtime.env,
              false,
              runtime.input,
              signal,
              true,
            );
            if (namingToken === undefined) {
              filenameWarning =
                "No token for pin metadata; using the CID as filename. Use --output to choose a name.";
            } else {
              try {
                const pin = await new Client(
                  origin,
                  namingToken,
                  signal,
                  runtime.fetcher,
                ).inspect(cid);
                output = pinFilename(pin.name, command === "export");
              } catch (error) {
                if (
                  error instanceof CliError &&
                  (error.code === "UNSAFE_PIN_NAME" ||
                    (error.code === "HTTP_ERROR" &&
                      [401, 403, 404].includes(error.status ?? 0)))
                ) {
                  filenameWarning =
                    error.code === "UNSAFE_PIN_NAME"
                      ? "Pin name is unsafe as a local filename; using the CID instead. Use --output to choose a name."
                      : `Pin name is unavailable (HTTP ${error.status}); using the CID as filename. Use --output to choose a name.`;
                } else throw error;
              }
            }
          }
          await progress("Fetching CAR...");
          const bytes = await client.car(cid);
          await progress(
            command === "export"
              ? "Verifying and saving CAR..."
              : "Verifying and restoring content...",
          );
          result = await saveContent(
            bytes,
            cid,
            output,
            command === "export",
            signal,
          );
          if (filenameWarning !== undefined)
            await progress(filenameWarning, true);
          break;
        }
        case "upload":
        case "import": {
          const publicationId = value("publication");
          const publicationWrite = publicationId ? sequence() : undefined;
          if (
            !publicationId &&
            (flags.has("sequence") || flags.has("request-id"))
          )
            return usage("--sequence and --request-id require --publication.");
          await progress("Preparing upload...");
          const input = await prepareInput(
            words[1]!,
            command === "import",
            value("name"),
            signal,
          );
          await progress("Uploading...");
          const pin = await client.upload(
            input.bytes,
            input.kind,
            input.name,
            input.root,
          );
          result = pin;
          if (publicationId && publicationWrite) {
            try {
              result = {
                pin,
                publication: await client.publication(
                  "publish",
                  publicationId,
                  { cid: pin.cid, ...publicationWrite },
                ),
              };
            } catch (error) {
              if (!(error instanceof CliError)) throw error;
              result = {
                pin,
                partialSuccess: true,
                publicationError: {
                  code: error.code,
                  status: error.status,
                  message:
                    "Upload succeeded; publication failed. The pin is preserved. Retry publication with the same request ID and payload if the outcome is uncertain.",
                  requestId: publicationWrite.requestId,
                  expectedSequence: publicationWrite.expectedSequence,
                },
              };
            }
          }
          break;
        }
        case "list":
          result = await client.list(value("cursor"), flags.has("all"));
          break;
        case "inspect":
          result = await client.inspect(words[1]!);
          break;
        case "rename":
          result = await client.rename(words[1]!, words[2]!);
          break;
        case "remove":
          result = await client.remove(words[1]!);
          break;
      }
    }
    const partialSuccess =
      !!result && typeof result === "object" && "partialSuccess" in result;
    if (!partialSuccess) signal.throwIfAborted();
    if (json) runtime.out.write(JSON.stringify(result) + "\n");
    else
      runtime.out.write(
        (command === "upload" || command === "import" || publicRead
          ? "\n"
          : "") +
          human(result, origin, tty) +
          "\n",
      );
    return partialSuccess ? (runtime.signal.aborted ? 130 : 1) : 0;
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

function human(value: unknown, origin: string, tty: boolean): string {
  if (value && typeof value === "object") {
    if (
      "path" in value &&
      "type" in value &&
      "cid" in value &&
      "size" in value &&
      typeof value.size === "number"
    ) {
      return detailTable(
        [
          ["Path", JSON.stringify(String(value.path)).slice(1, -1)],
          ["Type", String(value.type)],
          ["Size", formatSize(value.size)],
          ["CID", String(value.cid)],
        ],
        tty,
      );
    }
    if ("pins" in value && Array.isArray(value.pins)) {
      return (
        (value.pins.length ? pinTable(value.pins, tty) : "No pins.") +
        ("nextCursor" in value && typeof value.nextCursor === "string"
          ? `\n\nNext cursor: ${value.nextCursor}`
          : "")
      );
    }
    if (
      "cid" in value &&
      "name" in value &&
      "size" in value &&
      typeof value.size === "number" &&
      "blocks" in value &&
      "createdAt" in value
    ) {
      const rows = [
        ["Name", JSON.stringify(String(value.name)).slice(1, -1)],
        ["Size", formatSize(value.size)],
        ["CID", String(value.cid)],
        ["Blocks", String(value.blocks)],
        ["Created", JSON.stringify(String(value.createdAt)).slice(1, -1)],
        ["Share", `${origin}/share/${String(value.cid)}`],
      ];
      return detailTable(rows, tty);
    }
  }
  return JSON.stringify(value);
}

function detailTable(rows: string[][], tty: boolean): string {
  if (tty) return borderedTable(rows);
  return rows
    .map(([label, detail]) => `${label!.padEnd(7)}  ${detail!}`)
    .join("\n");
}

function formatSize(size: number): string {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

function tableName(name: string): string {
  const escaped = JSON.stringify(name).slice(1, -1);
  if (stringWidth(escaped) <= 32) return escaped;
  let shortened = "";
  for (const { segment } of new Intl.Segmenter().segment(escaped)) {
    if (stringWidth(shortened + segment) > 29) break;
    shortened += segment;
  }
  return shortened + "...";
}

function pinTable(pins: unknown[], tty: boolean): string {
  const rows = [
    ["NAME", "SIZE", "CID"],
    ...pins.map((pin: unknown) => {
      if (
        !pin ||
        typeof pin !== "object" ||
        !("name" in pin) ||
        typeof pin.name !== "string" ||
        !("size" in pin) ||
        typeof pin.size !== "number" ||
        !("cid" in pin) ||
        typeof pin.cid !== "string"
      )
        throw new CliError(
          "INVALID_RESPONSE",
          "Server returned an invalid pin.",
        );
      return [tableName(pin.name), formatSize(pin.size), pin.cid];
    }),
  ];
  if (tty) return borderedTable(rows, true, 1);
  const nameWidth = Math.max(...rows.map((row) => stringWidth(row[0]!)));
  const sizeWidth = Math.max(...rows.map((row) => stringWidth(row[1]!)));
  return rows
    .map(
      ([name, size, cid]) =>
        `${name!}${" ".repeat(nameWidth - stringWidth(name!))}  ${size!.padStart(sizeWidth)}  ${cid!}`,
    )
    .join("\n");
}

function borderedTable(
  rows: string[][],
  header = false,
  rightColumn = -1,
): string {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => stringWidth(row[column]!))),
  );
  const border = (left: string, middle: string, right: string) =>
    left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right;
  const lines = [border("┌", "┬", "┐")];
  for (const [index, row] of rows.entries()) {
    lines.push(
      "│ " +
        row
          .map((cell, column) => {
            const padding = " ".repeat(widths[column]! - stringWidth(cell));
            return column === rightColumn ? padding + cell : cell + padding;
          })
          .join(" │ ") +
        " │",
    );
    if (header && index === 0) lines.push(border("├", "┼", "┤"));
  }
  lines.push(border("└", "┴", "┘"));
  return lines.join("\n");
}
