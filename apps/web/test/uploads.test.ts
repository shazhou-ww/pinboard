import { describe, expect, it, vi } from "vitest";
import { uploadLimits } from "@workspace/contracts";
import {
  selectionForDirectory,
  selectionForFile,
  selectionFromDrop,
  type DroppedEntry,
  type DroppedItem,
} from "../src/uploads.js";

const file = (name = "note.txt", text = "hello") => new File([text], name);
const entry = (value: File): DroppedEntry => ({
  name: value.name,
  isFile: true,
  isDirectory: false,
  file: (resolve) => {
    resolve(value);
  },
});
function directory(name: string, batches: DroppedEntry[][]): DroppedEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let index = 0;
      return {
        readEntries: (resolve) => {
          resolve(batches[index++] ?? []);
        },
      };
    },
  };
}
const item = (
  value: DroppedEntry | null,
  fallback: File | null = null,
): DroppedItem => ({
  kind: "file",
  getAsFile: () => fallback,
  webkitGetAsEntry: () => value,
});
function sized(size: number): File {
  const value = file();
  Object.defineProperty(value, "size", { value: size });
  return value;
}

describe("file and directory selection", () => {
  it("keeps all picked files ordinary, including CAR names and empty files", () => {
    expect(selectionForFile(file("archive.car", "not a CAR"))).toMatchObject({
      kind: "file",
      name: "archive.car",
      size: 9,
    });
    expect(selectionForFile(file("empty.txt", ""))).toMatchObject({
      kind: "file",
      size: 0,
    });
    expect(selectionForFile(sized(uploadLimits.maxBytes)).size).toBe(
      uploadLimits.maxBytes,
    );
  });
  it.each(["", " ", "a".repeat(201)])("rejects invalid pin names", (name) => {
    expect(() => selectionForFile(file(name))).toThrow("1-200 characters");
  });
  it.each([-1, NaN, uploadLimits.maxBytes + 1])(
    "rejects invalid file sizes",
    (size) => {
      expect(() => selectionForFile(sized(size))).toThrow("32 MiB");
    },
  );
  it("preserves nested names, strips only the picked root, and sorts deterministically", () => {
    const selection = selectionForDirectory([
      { path: "root/z.txt", file: file("z.txt", "z") },
      { path: "root/sub/\u6587\u4ef6.txt", file: file("a.txt", "a") },
      { path: "root/empty.txt", file: file("empty.txt", "") },
    ]);
    expect(selection).toMatchObject({ kind: "folder", name: "root", size: 2 });
    expect(selection.files.map((value) => value.path)).toEqual([
      "empty.txt",
      "sub/\u6587\u4ef6.txt",
      "z.txt",
    ]);
  });
  it.each([
    "a.txt",
    "/root/a.txt",
    "root//a.txt",
    "root/./a.txt",
    "root/../a.txt",
    "root\\a.txt",
    "root/a\0b.txt",
  ])("rejects malformed or unavailable relative paths: %s", (path) => {
    expect(() => selectionForDirectory([{ path, file: file() }])).toThrow(
      "paths",
    );
  });
  it("rejects empty folders, mixed roots, duplicates and file/directory conflicts", () => {
    expect(() => selectionForDirectory([])).toThrow("Empty folders");
    expect(() =>
      selectionForDirectory([
        { path: "a/x", file: file() },
        { path: "b/y", file: file() },
      ]),
    ).toThrow("one folder");
    expect(() =>
      selectionForDirectory([
        { path: "a/x", file: file() },
        { path: "a/x", file: file() },
      ]),
    ).toThrow("Duplicate");
    expect(() =>
      selectionForDirectory([
        { path: "a/x", file: file() },
        { path: "a/x/y", file: file() },
      ]),
    ).toThrow("conflicts");
    expect(() =>
      selectionForDirectory([{ path: `${"a".repeat(201)}/x`, file: file() }]),
    ).toThrow("1-200 characters");
  });
  it("checks total selected bytes, including the exact upper bound", () => {
    const half = uploadLimits.maxBytes / 2;
    expect(
      selectionForDirectory([
        { path: "a/x", file: sized(half) },
        { path: "a/y", file: sized(half) },
      ]).size,
    ).toBe(uploadLimits.maxBytes);
    expect(() =>
      selectionForDirectory([
        { path: "a/x", file: sized(half) },
        { path: "a/y", file: sized(half + 1) },
      ]),
    ).toThrow("32 MiB");
  });
});

describe("file and directory drops", () => {
  it("accepts native file entries and ordinary File fallback", async () => {
    const value = file();
    expect(await selectionFromDrop([item(entry(value))])).toMatchObject({
      kind: "file",
      name: value.name,
    });
    expect(await selectionFromDrop([item(null, value)])).toMatchObject({
      kind: "file",
      name: value.name,
    });
    expect(
      await selectionFromDrop([
        { kind: "string", getAsFile: () => null },
        item(null, value),
      ]),
    ).toMatchObject({ kind: "file" });
    expect(
      await selectionFromDrop([{ kind: "file", getAsFile: () => value }]),
    ).toMatchObject({ kind: "file" });
  });
  it("captures modern entries synchronously before the drop store becomes protected", async () => {
    let readable = true;
    const modern = vi.fn(() => {
      if (!readable) throw new Error("Protected drag data");
      return directory("root", [[entry(file())]]);
    });
    const promise = selectionFromDrop([
      { kind: "file", getAsFile: () => null, getAsEntry: modern },
    ]);
    readable = false;
    expect(await promise).toMatchObject({ kind: "folder", name: "root" });
    expect(modern).toHaveBeenCalledOnce();
    expect(
      await selectionFromDrop([
        { ...item(entry(file())), getAsEntry: () => null },
      ]),
    ).toMatchObject({ kind: "file" });
  });
  it("reads every batch and nested directory, not just the first 100 entries", async () => {
    const first = Array.from({ length: 100 }, (_, index) =>
      entry(file(`${String(index).padStart(3, "0")}.txt`, "")),
    );
    const nested = directory("sub", [[entry(file("last.txt", "last"))]]);
    const empty = directory("empty", [[]]);
    const selection = await selectionFromDrop([
      item(directory("root", [first, [nested, empty], []])),
    ]);
    expect(selection.kind).toBe("folder");
    if (selection.kind !== "folder") throw new Error("Expected folder");
    expect(selection.files).toHaveLength(101);
    expect(selection.files.at(-1)?.path).toBe("sub/last.txt");
    expect(selection.size).toBe(4);
  });
  it("rejects multiple roots, non-file drops, unreadable items and empty folders", async () => {
    await expect(selectionFromDrop([])).rejects.toThrow("one file");
    await expect(
      selectionFromDrop([item(null, file()), item(null, file())]),
    ).rejects.toThrow("one file");
    await expect(
      selectionFromDrop([{ kind: "string", getAsFile: () => null }]),
    ).rejects.toThrow("one file");
    await expect(selectionFromDrop([item(null)])).rejects.toThrow(
      "cannot read",
    );
    await expect(
      selectionFromDrop([item(directory("root", [[]]))]),
    ).rejects.toThrow("Empty folders");
    await expect(
      selectionFromDrop([
        item({ name: "bad", isFile: true, isDirectory: false }),
      ]),
    ).rejects.toThrow("cannot read");
    await expect(
      selectionFromDrop([
        item({ name: "bad", isFile: false, isDirectory: false }),
      ]),
    ).rejects.toThrow("cannot read");
    await expect(
      selectionFromDrop([
        item({ name: "bad", isFile: false, isDirectory: true }),
      ]),
    ).rejects.toThrow("cannot read");
    await expect(
      selectionFromDrop([
        item(
          directory("root", [
            [{ name: "bad", isFile: true, isDirectory: false }],
          ]),
        ),
      ]),
    ).rejects.toThrow("cannot read");
  });
  it("surfaces file and directory read failures", async () => {
    const error = new DOMException("Permission denied", "NotReadableError");
    const unreadable: DroppedEntry = {
      name: "file",
      isFile: true,
      isDirectory: false,
      file: (_resolve, reject) => {
        reject(error);
      },
    };
    await expect(selectionFromDrop([item(unreadable)])).rejects.toThrow(
      "Permission denied",
    );
    await expect(
      selectionFromDrop([item(directory("root", [[unreadable]]))]),
    ).rejects.toThrow("Permission denied");
    const root: DroppedEntry = {
      name: "root",
      isFile: false,
      isDirectory: true,
      createReader: () => ({
        readEntries: (_resolve, reject) => {
          reject(error);
        },
      }),
    };
    await expect(selectionFromDrop([item(root)])).rejects.toThrow(
      "Permission denied",
    );
  });
});
