import { uploadLimits } from "@workspace/contracts";

export interface DirectoryFile {
  readonly path: string;
  readonly file: File;
}

export interface DirectorySelection {
  readonly kind: "folder";
  readonly name: string;
  readonly size: number;
  readonly files: readonly DirectoryFile[];
}

export type UploadSelection =
  | {
      readonly kind: "file";
      readonly name: string;
      readonly size: number;
      readonly file: File;
    }
  | DirectorySelection;

export interface DroppedEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  file?: (
    success: (file: File) => void,
    failure: (error: DOMException) => void,
  ) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: DroppedEntry[]) => void,
      failure: (error: DOMException) => void,
    ) => void;
  };
}

export interface DroppedItem {
  readonly kind: string;
  getAsFile: () => File | null;
  getAsEntry?: () => DroppedEntry | null;
  webkitGetAsEntry?: () => DroppedEntry | null;
}

function checkName(name: string): void {
  if (!name.trim() || name.length > 200)
    throw new Error("File and folder names must contain 1-200 characters.");
}

function checkSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > uploadLimits.maxBytes) {
    throw new Error("Choose a file or folder totaling no more than 32 MiB.");
  }
}

export function selectionForFile(file: File): UploadSelection {
  checkName(file.name);
  checkSize(file.size);
  return { kind: "file", name: file.name, size: file.size, file };
}

export function selectionForDirectory(
  entries: readonly DirectoryFile[],
): DirectorySelection {
  if (!entries.length)
    throw new Error("No readable files found. Empty folders are not included.");
  let name: string | undefined;
  let size = 0;
  const paths = new Set<string>();
  const directories = new Set<string>();
  const files: DirectoryFile[] = [];
  for (const entry of entries) {
    const parts = entry.path.split("/");
    if (
      parts.length < 2 ||
      parts.some((part) => !part || part === "." || part === "..") ||
      entry.path.includes("\\") ||
      entry.path.includes("\0")
    ) {
      throw new Error(
        "Folder paths are invalid or unavailable. Use a browser that supports folder selection.",
      );
    }
    const root = parts.shift()!;
    if (name !== undefined && root !== name)
      throw new Error("Choose one folder at a time.");
    name = root;
    const path = parts.join("/");
    if (paths.has(path)) throw new Error(`Duplicate folder path: ${path}`);
    paths.add(path);
    for (let index = 1; index < parts.length; index++)
      directories.add(parts.slice(0, index).join("/"));
    checkSize(entry.file.size);
    size += entry.file.size;
    checkSize(size);
    files.push({ path, file: entry.file });
  }
  for (const path of paths) {
    if (directories.has(path))
      throw new Error(`A file conflicts with a folder: ${path}`);
  }
  checkName(name!);
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return { kind: "folder", name: name!, size, files };
}

export async function selectionFromDrop(
  items: readonly DroppedItem[],
): Promise<UploadSelection> {
  const files = items.filter((item) => item.kind === "file");
  if (files.length !== 1)
    throw new Error("Drop one file or one folder at a time.");
  const item = files[0]!;
  // Capture the entry before awaiting: the drag data store is readable only during drop.
  const entry = item.getAsEntry?.() ?? item.webkitGetAsEntry?.();
  if (!entry) {
    const file = item.getAsFile();
    if (!file)
      throw new Error(
        "This browser cannot read that drop. Use Choose file or Choose folder.",
      );
    return selectionForFile(file);
  }
  const entries: DirectoryFile[] = [];
  async function walk(current: DroppedEntry, path: string): Promise<void> {
    if (current.isFile && current.file) {
      const file = await new Promise<File>((resolve, reject) => {
        current.file!(resolve, reject);
      });
      entries.push({ path, file });
      return;
    }
    if (!current.isDirectory || !current.createReader)
      throw new Error(
        "This browser cannot read that entry. Use the file or folder picker.",
      );
    const reader = current.createReader();
    for (;;) {
      const batch = await new Promise<DroppedEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject);
      });
      if (!batch.length) break;
      for (const child of batch) await walk(child, `${path}/${child.name}`);
    }
  }
  if (entry.isFile) {
    if (!entry.file)
      throw new Error("This browser cannot read that file. Use Choose file.");
    return selectionForFile(
      await new Promise<File>((resolve, reject) => {
        entry.file!(resolve, reject);
      }),
    );
  }
  await walk(entry, entry.name);
  return selectionForDirectory(entries);
}
