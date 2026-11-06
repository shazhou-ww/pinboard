import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cliVersionFromTag } from "./validate-cli-release.mjs";

for (const version of ["0.0.0", "0.1.0", "1.2.3", "12.34.56"]) {
  test(`extracts npm version ${version}`, () => {
    assert.equal(cliVersionFromTag(`@shazhou/pinboard@${version}`), version);
  });
}
for (const tag of [
  "",
  "main",
  "v0.1.0",
  "cli-v0.1.0",
  "release-261104-1",
  "@shazhou.ww/pinboard@0.1.0",
  "@shazhou/pinboard-web@0.1.0",
  "@shazhou/pinboard@01.2.3",
  "@shazhou/pinboard@1.02.3",
  "@shazhou/pinboard@1.2.03",
  "@shazhou/pinboard@1.2",
  "@shazhou/pinboard@1.2.3-beta",
  "@shazhou/pinboard@1.2.3+build",
  "@shazhou/pinboard@1.2.3/extra",
  "@shazhou/pinboard@1.2.3\n",
  "@shazhou/pinboard@9007199254740992.0.0",
]) {
  test(`rejects CLI release tag ${JSON.stringify(tag)}`, () => {
    assert.throws(
      () => cliVersionFromTag(tag),
      /Expected @shazhou\/pinboard@x.y.z/u,
    );
  });
}

test("CLI release validator prints only the version or fails closed", () => {
  const script = fileURLToPath(
    new URL("./validate-cli-release.mjs", import.meta.url),
  );
  const valid = spawnSync(
    process.execPath,
    [script, "@shazhou/pinboard@0.1.0"],
    { encoding: "utf8" },
  );
  assert.equal(valid.status, 0);
  assert.equal(valid.stdout, "0.1.0\n");
  const invalid = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
});

test("npm publication matches the configured trusted publisher and isolated tag family", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/publish-npm.yaml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /tags:\s*\n\s+- "@shazhou\/pinboard@\*"/u);
  assert.match(workflow, /environment: npm\b/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /git merge-base --is-ancestor HEAD origin\/main/u);
  assert.match(
    workflow,
    /npm publish .*\.tgz" --access public --tag latest --provenance/u,
  );
  assert.match(workflow, /node --test scripts\/cli-package\.test\.mjs/u);
  assert.match(
    workflow,
    /pnpm prepare:cli "\$RELEASE_VERSION"\s+pnpm --dir apps\/cli\/dist\/npm pack --pack-destination \.\./u,
  );
  assert.doesNotMatch(
    workflow,
    /NODE_AUTH_TOKEN|NPM_TOKEN|wrangler|workflow_dispatch|branches:/u,
  );
  const cloudflare = readFileSync(
    new URL("../.github/workflows/deploy-cloudflare.yaml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(cloudflare, /@shazhou\/pinboard@/u);
});
