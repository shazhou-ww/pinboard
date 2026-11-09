import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { npmReleaseFromTag } from "./validate-npm-release.mjs";

for (const name of ["@shazhou/pinboard", "react-engraved-background"]) {
  for (const version of ["0.0.0", "0.1.0", "1.2.3"]) {
    test(`routes ${name}@${version} to the exact package`, () => {
      assert.deepEqual(npmReleaseFromTag(`${name}@${version}`), {
        name,
        version,
      });
    });
  }
}
for (const tag of [
  "",
  "main",
  "release-261109-1",
  "another-package@1.0.0",
  "react-engraved-background@01.0.0",
  "react-engraved-background@0.01.0",
  "react-engraved-background@0.1.00",
  "react-engraved-background@0.1",
  "react-engraved-background@0.1.0-beta",
  "react-engraved-background@0.1.0+build",
  "react-engraved-background@0.1.0\n",
  "react-engraved-background@9007199254740992.0.0",
]) {
  test(`rejects npm release tag ${JSON.stringify(tag)}`, () => {
    assert.throws(() => npmReleaseFromTag(tag));
  });
}

test("release outputs are safe GitHub step outputs and invalid tags emit nothing", () => {
  const script = fileURLToPath(
    new URL("./validate-npm-release.mjs", import.meta.url),
  );
  const valid = spawnSync(
    process.execPath,
    [script, "react-engraved-background@0.1.0"],
    { encoding: "utf8" },
  );
  assert.equal(valid.status, 0);
  assert.equal(
    valid.stdout,
    "package=react-engraved-background\nversion=0.1.0\n",
  );
  const invalid = spawnSync(process.execPath, [script, "main"], {
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
});

test("background publication uses the configured workflow and exact tested artifact", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/publish-npm.yaml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /- "react-engraved-background@\*"/u);
  assert.match(workflow, /environment: npm\b/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /node scripts\/validate-npm-release\.mjs/u);
  assert.match(workflow, /git merge-base --is-ancestor HEAD origin\/main/u);
  assert.match(workflow, /pnpm prepare:background "\$RELEASE_VERSION"/u);
  assert.match(workflow, /node --test scripts\/background-package\.test\.mjs/u);
  assert.match(
    workflow,
    /npm publish "\.\/packages\/react-engraved-background\/dist\/react-engraved-background-\$\{RELEASE_VERSION\}\.tgz" --access public --tag latest --provenance/u,
  );
  assert.doesNotMatch(
    workflow,
    /NODE_AUTH_TOKEN|NPM_TOKEN|wrangler|workflow_dispatch|branches:/u,
  );
});
