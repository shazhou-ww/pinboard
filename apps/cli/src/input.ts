import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CarReader } from "@ipld/car";
import { uploadLimits } from "@workspace/contracts";
import { buildDirectoryCar, type DirectoryEntry } from "@workspace/encoding";
import { CliError, usage } from "./errors.js";
import { noLinks } from "./permissions.js";

function sizeCheck(size: number): void {
  if (size > uploadLimits.maxBytes)
    throw new CliError("INPUT_LIMIT", "Input exceeds 32 MiB.");
}

function same(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

async function* content(
  path: string,
  before: Stats,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  signal.throwIfAborted();
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    if (!(await file.stat()).isFile() || !same(before, await file.stat()))
      throw new CliError("INPUT_CHANGED", "Input changed before reading.");
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const buffer = new Uint8Array(64 * 1024);
      const { bytesRead } = await file.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > before.size)
        throw new CliError("INPUT_CHANGED", "Input changed while reading.");
      yield buffer.subarray(0, bytesRead);
    }
    if (
      total !== before.size ||
      !same(before, await file.stat()) ||
      !same(before, await lstat(path))
    )
      throw new CliError("INPUT_CHANGED", "Input changed while reading.");
  } finally {
    await file.close();
  }
}

export async function prepareInput(
  input: string,
  isImport: boolean,
  name: string | undefined,
  signal: AbortSignal,
): Promise<{
  bytes: Uint8Array<ArrayBuffer>;
  kind: "file" | "car";
  name: string;
  root?: string;
}> {
  signal.throwIfAborted();
  const path = resolve(input);
  const label = name ?? basename(path);
  if (!label.trim() || label.trim().length > 200)
    return usage("Upload names must contain 1-200 characters.");
  await noLinks(path);
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
    throw new CliError(
      "INPUT_TYPE",
      "Only regular files and directories are supported; links and special files are refused.",
    );
  if (stat.isDirectory()) {
    if (isImport) return usage("import requires a CAR file, not a directory.");
    const files: DirectoryEntry[] = [];
    let size = 0;
    async function walk(directory: string, prefix: string): Promise<void> {
      signal.throwIfAborted();
      const before = await lstat(directory);
      for (const entry of await readdir(directory)) {
        signal.throwIfAborted();
        const absolute = join(directory, entry);
        const relative = prefix ? `${prefix}/${entry}` : entry;
        const child = await lstat(absolute);
        if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory()))
          throw new CliError(
            "INPUT_TYPE",
            "Directory contains a link or unsupported special file.",
          );
        if (child.isDirectory()) await walk(absolute, relative);
        else {
          size += child.size;
          sizeCheck(size);
          files.push({
            path: relative,
            size: child.size,
            content: content(absolute, child, signal),
          });
        }
      }
      const after = await lstat(directory);
      if (before.ino !== after.ino || before.mtimeMs !== after.mtimeMs)
        throw new CliError(
          "INPUT_CHANGED",
          "Directory changed while scanning.",
        );
    }
    await walk(path, "");
    let encoded;
    try {
      encoded = await buildDirectoryCar(files, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof CliError) throw error;
      const known =
        error instanceof Error &&
        /^(No readable files|Folder (paths|DAG|archive|exceeds)|A folder block|File changed)/u.test(
          error.message,
        );
      throw new CliError(
        "DIRECTORY_ENCODING",
        known
          ? error.message
          : "Cannot encode this directory. Check file readability, paths and upload limits.",
      );
    }
    return { ...encoded, kind: "car", name: label };
  }
  sizeCheck(stat.size);
  const bytes = new Uint8Array(stat.size);
  let offset = 0;
  for await (const chunk of content(path, stat, signal)) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (!isImport) return { bytes, kind: "file", name: label };
  try {
    const reader = await CarReader.fromBytes(bytes);
    const roots = await reader.getRoots();
    if (roots.length !== 1) throw new Error("roots");
    return {
      bytes,
      kind: "car",
      name: label,
      root: roots[0]!.toV1().toString(),
    };
  } catch {
    throw new CliError(
      "INVALID_CAR",
      "Import requires a valid single-root CAR. Complete DAG validation remains authoritative on the server.",
    );
  }
}
