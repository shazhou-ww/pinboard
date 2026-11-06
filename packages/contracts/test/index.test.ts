import { describe, expect, it } from "vitest";

import {
  authProviderIds,
  getAuthProviderLabel,
  itemFilterMaxLength,
  normalizeItemFilter,
  uploadLimits,
} from "../src/index.js";

describe("item filtering contract", () => {
  it("shares the input limit and Unicode literal normalization", () => {
    expect(itemFilterMaxLength).toBe(200);
    expect(normalizeItemFilter(" \tÉCOLE 中文  A%_\n")).toBe("école 中文  a%_");
    expect(normalizeItemFilter(" \t\n")).toBe("");
  });
});

describe("getAuthProviderLabel", () => {
  it("labels every supported provider", () => {
    expect(authProviderIds.map(getAuthProviderLabel)).toEqual([
      "GitHub",
      "Google",
      "Microsoft",
    ]);
  });

  describe("upload limits", () => {
    it("shares the exact body, block and DAG bounds between browser and Worker", () => {
      expect(uploadLimits).toEqual({
        maxBytes: 32 * 1024 * 1024,
        maxBlockBytes: 2 * 1024 * 1024,
        maxBlocks: 256,
      });
    });
  });
});
