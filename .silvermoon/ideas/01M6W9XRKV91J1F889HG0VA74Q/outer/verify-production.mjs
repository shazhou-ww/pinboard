import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const origin = "https://pinboard.shazhou.work";
const buildEvidence =
  process.env.BUILD_EVIDENCE ?? "inner/evidence-refinement/results.json";
const { assets: buildAssets } = JSON.parse(
  await readFile(resolve(root, buildEvidence), "utf8"),
);
const results = {
  checkedAt: new Date().toISOString(),
  origin,
  scope:
    "仅公开 GET 与无 Cookie 的匿名 API；不登录、不创建授权、不变更账户数据",
  releaseTag: process.env.RELEASE_TAG,
  taggedCommit: process.env.RELEASE_COMMIT,
  workflowUrl: process.env.RELEASE_WORKFLOW,
  implementationRevision:
    process.env.IMPLEMENTATION_REVISION ??
    "32df5f993aa37a8c7dbe4878531cab076ba45921",
  buildEvidence,
  homepage: null,
  assets: [],
  anonymousApi: [],
  limitations:
    "未提供合法生产测试会话；已验收构建的隔离浏览器证据不等同于生产登录后数据操作",
};
const errors = [];
const request = (path) =>
  fetch(`${origin}${path}`, {
    headers: { "Cache-Control": "no-cache" },
    redirect: "error",
  });
const homepage = await request("/");
const html = await homepage.text();
const entryPaths = [
  ...html.matchAll(/(?:src|href)="(\/assets\/index-[^"]+\.(?:js|css))"/g),
].map((match) => match[1]);
results.homepage = { status: homepage.status, entryPaths };
if (homepage.status !== 200) errors.push("主页未返回 200");
for (const expected of buildAssets) {
  const response = await request(expected.path);
  const actual = createHash("sha256")
    .update(new Uint8Array(await response.arrayBuffer()))
    .digest("hex");
  const match =
    response.status === 200 &&
    entryPaths.includes(expected.path) &&
    actual === expected.sha256;
  results.assets.push({
    path: expected.path,
    status: response.status,
    expectedSha256: expected.sha256,
    actualSha256: actual,
    referencedByHomepage: entryPaths.includes(expected.path),
    match,
  });
  if (!match) errors.push(`发布资源指纹不匹配：${expected.path}`);
}
for (const path of ["/api/pins", "/api/tokens", "/api/oauth/grants"]) {
  const response = await request(path);
  const rejected = [401, 403].includes(response.status);
  results.anonymousApi.push({ path, status: response.status, rejected });
  if (!rejected) errors.push(`匿名受保护 API 未拒绝：${path}`);
}
results.errors = errors;
results.passed = errors.length === 0;
await writeFile(
  resolve(
    root,
    process.env.PRODUCTION_EVIDENCE ?? "production-refinement-evidence.json",
  ),
  `${JSON.stringify(results, null, 2)}\n`,
);
assert.equal(errors.length, 0, errors.join("；"));
console.log("生产主页、精确 JS/CSS SHA-256 和三项匿名 API 拒绝验证通过。");
