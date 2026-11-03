import { describe, expect, it } from "vitest";

import {
  authProviderIds,
  getAuthProviderLabel,
  uploadLimits,
} from "../src/index.js";

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
