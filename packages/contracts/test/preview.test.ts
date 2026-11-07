import { describe, expect, it } from "vitest";
import {
  isContentPreview,
  type ContentPreview,
  type PreviewMaterial,
} from "../src/index.js";

const image = {
  cid: "thumbnail",
  url: "/ipfs/thumbnail",
  width: 339,
  height: 480,
};
const ready = (
  preview: PreviewMaterial,
  contentType: string | null = null,
): ContentPreview => ({
  version: 3,
  status: "ready",
  contentType,
  preview,
  truncated: false,
});

describe("normalized preview boundary", () => {
  it.each(["image/jpeg", "application/pdf", "video/mp4", null])(
    "accepts image material independent of source %s",
    (source) => {
      expect(isContentPreview(ready({ kind: "image", image }, source))).toBe(
        true,
      );
    },
  );
  it("accepts bounded text and directory material and optional metadata", () => {
    for (const kind of ["text", "markdown"] as const)
      expect(
        isContentPreview({
          ...ready({ kind, text: "literal" }, "text/plain"),
          size: 12,
          reason: "sample",
          truncated: true,
        }),
      ).toBe(true);
    for (const total of [undefined, 1])
      expect(
        isContentPreview(
          ready(
            {
              kind: "directory",
              entries: [{ name: "child", kind: "unknown", depth: 1 }],
              ...(total === undefined ? {} : { total }),
            },
            "inode/directory",
          ),
        ),
      ).toBe(true);
  });
  it.each(["pending", "unsupported", "failed"] as const)(
    "keeps %s distinct from usable material",
    (status) => {
      const empty = {
        ...ready({ kind: "image", image }),
        status,
        preview: null,
        reason: "diagnosis",
      };
      expect(isContentPreview(empty)).toBe(true);
      expect(
        isContentPreview({ ...empty, preview: { kind: "image", image } }),
      ).toBe(false);
      expect(isContentPreview({ ...empty, truncated: true })).toBe(false);
    },
  );
  it("rejects old protocol, invalid states, metadata and malformed materials", () => {
    const base = ready({ kind: "image", image });
    for (const invalid of [
      null,
      [],
      {},
      { ...base, status: "unknown" },
      { ...base, preview: null },
      { ...base, contentType: 1 },
      { ...base, version: 0 },
      { ...base, version: 1.5 },
      { ...base, reason: 7 },
      { ...base, size: -1 },
      { ...base, size: Infinity },
      { ...base, truncated: "false" },
      { ...base, preview: { kind: "pdf", image } },
      {
        version: 2,
        status: "ready",
        truncated: false,
        contentType: "image/webp",
        content: image,
      },
      { ...base, content: image },
      { ...base, mediaType: "application/pdf" },
      ready({ kind: "text", text: 1 } as unknown as PreviewMaterial),
      ready({
        kind: "directory",
        entries: Array(25).fill({ name: "a", kind: "file", depth: 0 }),
      }),
      ready({ kind: "directory", entries: [], total: -1 }),
      ready({
        kind: "directory",
        entries: [{ name: "a", kind: "file", depth: 2 }],
      }),
      {
        ...base,
        preview: {
          kind: "directory",
          entries: [{ name: 7, kind: "file", depth: 0 }],
        },
      },
    ])
      expect(isContentPreview(invalid)).toBe(false);
  });
  it("preserves image URL, dimension and development-only blob boundaries", () => {
    for (const invalid of [
      { ...image, url: "https://external.test/image.webp" },
      { ...image, url: "/ipfs/different" },
      { ...image, cid: "../escape" },
      { ...image, width: 0 },
      { ...image, height: 481 },
      { ...image, width: 1.2 },
      { ...image, height: -1 },
    ])
      expect(isContentPreview(ready({ kind: "image", image: invalid }))).toBe(
        false,
      );
    const blob = ready({
      kind: "image",
      image: { ...image, url: "blob:local" },
    });
    expect(isContentPreview(blob)).toBe(false);
    expect(isContentPreview(blob, true)).toBe(true);
  });
});
