import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateReleaseTag } from "./validate-release.mjs";

for (const tag of [
  "release-261103-1",
  "release-261103-2",
  "release-261103-123",
  "release-000229-1",
  "release-240229-1",
  "release-991231-1",
]) {
  test(`accepts ${tag}`, () => {
    assert.doesNotThrow(() => validateReleaseTag(tag));
  });
}

for (const tag of [
  "",
  "main",
  "v0.1.0",
  "release-20261103-1",
  "release-261103-0",
  "release-261103-01",
  "release-261103",
  "release-261103-1-beta",
  "release-261103-1/extra",
  "release-261103-1\n",
  "release-261332-1",
  "release-260001-1",
  "release-261100-1",
  "release-261131-1",
  "release-260229-1",
]) {
  test(`rejects ${JSON.stringify(tag)}`, () => {
    assert.throws(() => validateReleaseTag(tag));
  });
}

test("CLI fails closed for invalid and missing tags", () => {
  const script = fileURLToPath(
    new URL("./validate-release.mjs", import.meta.url),
  );
  for (const args of [["release-261103-1"], ["v0.1.0"], []]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, args[0] === "release-261103-1" ? 0 : 1);
    if (result.status !== 0) {
      assert.match(result.stderr, /Expected release-YYMMDD-INDEX/);
    }
  }
});
