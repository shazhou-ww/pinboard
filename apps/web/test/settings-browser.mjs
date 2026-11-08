// Real React UI, with synthetic account responses isolated to localhost.
/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const origin = process.env.SETTINGS_ORIGIN ?? "http://localhost:5196";
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const output = resolve(
  process.env.SETTINGS_EVIDENCE ?? ".browser-tools/settings-evidence",
);
await mkdir(output, { recursive: true });
process.env.TEMP = process.env.TMP = resolve(".browser-tools");
const { chromium } = await import(
  pathToFileURL(
    resolve(
      process.env.PLAYWRIGHT_MODULE ??
        ".browser-tools/node_modules/playwright-core/index.mjs",
    ),
  ).href
);
const browser = await chromium.launchPersistentContext(
  resolve(".browser-tools/settings-profile"),
  {
    executablePath:
      process.env.BROWSER_EXECUTABLE ??
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    viewport: { width: 1280, height: 900 },
    downloadsPath: resolve(".browser-tools/downloads"),
  },
);
const checks = [];
const check = (name, detail = "通过") => checks.push({ name, detail });
const page = await browser.newPage();
const assetResponses = new Map();
page.on("response", (response) => {
  const url = new URL(response.url());
  if (
    url.origin === origin &&
    /^\/assets\/index-.*\.(js|css)$/.test(url.pathname)
  )
    assetResponses.set(
      url.pathname,
      response.body().then((body) => ({
        path: url.pathname,
        sha256: createHash("sha256").update(body).digest("hex"),
      })),
    );
});
const failures = [];
page.on("pageerror", (error) => failures.push(error.message));
const now = Date.now();
const token = (
  id,
  name,
  revokedAt = null,
  expiresAt = new Date(now + 86400000).toISOString(),
) => ({
  id,
  name,
  prefix: "demo_label",
  scopes: "pins:read publications:read",
  createdAt: new Date(now).toISOString(),
  expiresAt,
  revokedAt,
});
let tokens = [token("active", "Example access token — a label, not identity")];
let history = [
  token("revoked", "Revoked example", new Date(now).toISOString()),
  token(
    "expired",
    "Expired example",
    null,
    new Date(now - 86400000).toISOString(),
  ),
];
let grants = [0, 1, 2, 3, 4].map((index) => ({
  id: `grant-${index}`,
  clientId: `example-client-${index}`,
  clientName: `Example OAuth client ${index + 1}`,
  scopes: "pins:read publications:read",
  createdAt: now,
  expiresAt: index === 1 ? null : now + 86400000,
  revokedAt: null,
  tokenIssued: true,
  codeExpiresAt: now + 600000,
}));
let oauthError = false;
let tokenError = false;
let pendingResolve;
let pending = false;
let createFails = false;
const mutations = [];
await page.route(`${origin}/api/**`, async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();
  const json = (body, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  if (method !== "GET") mutations.push({ path, method });
  if (pending && method !== "GET")
    await new Promise((done) => {
      pendingResolve = done;
    });
  if (path === "/api/bootstrap")
    return json({
      appName: "Pinboard",
      providers: [{ id: "google", label: "Google" }],
    });
  if (path === "/api/auth/session")
    return json({
      user: {
        id: "fixture",
        name: "Local UI fixture",
        email: "fixture@example.test",
      },
    });
  if (path === "/api/pins") return json({ pins: [], nextCursor: null });
  if (path === "/api/publications")
    return json({ publications: [], nextCursor: null });
  if (path === "/api/tokens" && method === "GET") {
    if (tokenError) return json({ error: "Example token list failure" }, 503);
    return json({
      tokens: url.searchParams.get("view") === "history" ? history : tokens,
    });
  }
  if (path === "/api/tokens" && method === "POST") {
    if (createFails) return json({ error: "Example creation failure" }, 503);
    const input = request.postDataJSON();
    assert.equal(input.expiresInDays, 17);
    assert(input.scopes.includes("pins:write"));
    const created = token("created", input.name);
    tokens.push(created);
    return json({ ...created, token: "fixture-only-not-a-real-credential" });
  }
  if (path.startsWith("/api/tokens/") && method === "DELETE") {
    const found = tokens.find((item) => path.endsWith(item.id));
    assert(found);
    tokens = tokens.filter((item) => item !== found);
    history.push({ ...found, revokedAt: new Date(now).toISOString() });
    return json({});
  }
  if (path === "/api/oauth/grants") {
    if (oauthError) return json({ error: "Example OAuth failure" }, 503);
    return json({ grants });
  }
  if (path.startsWith("/api/oauth/grants/") && method === "DELETE") {
    grants = grants.filter((item) => !path.endsWith(item.id));
    return json({});
  }
  if (path === "/api/recently-deleted")
    return json({
      items: [
        {
          kind: "pin",
          id: "deleted-fixture",
          title: "Recoverable example pin",
          deletedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 30 * 86400000).toISOString(),
        },
      ],
      nextCursor: null,
    });
  if (path === "/api/pins/deleted-fixture/restore") return json({});
  throw new Error(`Unexpected fixture request: ${method} ${path}`);
});
const settings = page.getByRole("dialog", { name: "Settings", exact: true });
const tab = (name) => settings.getByRole("tab", { name, exact: true });
const panel = () => settings.locator('[role="tabpanel"]:visible');
async function openSettings() {
  await page
    .getByRole("button", { name: "Account options for Local UI fixture" })
    .click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await settings.waitFor({ state: "visible" });
}
async function select(name) {
  await tab(name).click();
}
async function geometry(label) {
  const metrics = await settings.evaluate((dialog) => {
    const detail = dialog.querySelector(".settings-detail");
    const nav = dialog.querySelector(".settings-nav");
    const header = dialog.querySelector(".section-title");
    const rect = (element) => element.getBoundingClientRect().toJSON();
    return {
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      dialog: rect(dialog),
      detail: rect(detail),
      nav: rect(nav),
      header: rect(header),
      detailOverflow: getComputedStyle(detail).overflowY,
      detailScrollWidth: detail.scrollWidth,
      detailClientWidth: detail.clientWidth,
      orientation: nav.getAttribute("aria-orientation"),
    };
  });
  assert(metrics.pageWidth <= metrics.viewport, `${label}: page overflows`);
  assert(
    metrics.detailScrollWidth <= metrics.detailClientWidth + 1,
    `${label}: detail overflows`,
  );
  assert(
    metrics.dialog.x >= 10 && metrics.dialog.right <= metrics.viewport - 10,
  );
  assert.equal(metrics.detailOverflow, "auto");
  assert(metrics.detail.bottom <= metrics.dialog.bottom + 1);
  check(label, metrics);
}
try {
  await page.goto(origin);
  await openSettings();
  assert.equal(await settings.getByRole("tab").count(), 4);
  assert.equal(
    await settings.getByRole("button", { name: /Close/ }).count(),
    0,
  );
  assert.equal(
    await settings.locator("> .section-title").innerText(),
    "Settings",
  );
  await geometry("桌面布局");
  await tab("Browser preferences").focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await tab("Access tokens").getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("End");
  assert.equal(
    await tab("Recently deleted").getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("Home");
  assert.equal(
    await tab("Browser preferences").getAttribute("aria-selected"),
    "true",
  );
  check("桌面方向键与 Home/End");
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press(index % 2 ? "Shift+Tab" : "Tab");
    assert(
      await settings.evaluate((dialog) =>
        dialog.contains(document.activeElement),
      ),
    );
  }
  check("原生 modal 焦点约束");
  for (const palette of ["sand", "ice", "mist"]) {
    await panel().locator(`input[value="${palette}"]`).check();
    assert.equal(
      await page.locator("html").getAttribute("data-background"),
      palette,
    );
  }
  const reminder = panel().getByRole("checkbox");
  await reminder.uncheck();
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem("pinboard:skip-public-upload-reminder"),
    ),
    "true",
  );
  await reminder.check();
  check("三种配色与仅本浏览器提醒");
  await select("Access tokens");
  assert(!(await panel().innerText()).includes("MCP endpoint"));
  await panel().getByText("Example access token", { exact: false }).waitFor();
  await panel()
    .getByRole("button", { name: "Create token", exact: true })
    .click();
  await panel()
    .getByRole("textbox", { name: "Token label" })
    .fill("Example drafted token");
  await panel().getByRole("spinbutton").fill("17");
  await panel()
    .getByRole("checkbox", { name: "pins:write", exact: true })
    .check();
  await select("OAuth authorizations");
  await panel().getByText("Example OAuth client 1", { exact: true }).waitFor();
  assert((await panel().innerText()).includes("MCP endpoint"));
  assert.equal(await panel().locator(".token-list li").count(), 5);
  await page.screenshot({ path: resolve(output, "desktop-oauth.png") });
  await select("Access tokens");
  assert.equal(
    await panel().getByRole("textbox", { name: "Token label" }).inputValue(),
    "Example drafted token",
  );
  assert.equal(await panel().getByRole("spinbutton").inputValue(), "17");
  assert(
    await panel()
      .getByRole("checkbox", { name: "pins:write", exact: true })
      .isChecked(),
  );
  check("类别切换保留名称、权限和有效期草稿");
  createFails = true;
  await panel().getByRole("button", { name: "Create access token" }).click();
  await settings
    .getByRole("alert")
    .getByText("Example creation failure", { exact: true })
    .waitFor();
  await select("Browser preferences");
  assert((await settings.innerText()).includes("Example creation failure"));
  createFails = false;
  await select("Access tokens");
  pending = true;
  pendingResolve = undefined;
  await panel().getByRole("button", { name: "Create access token" }).click();
  await settings
    .getByText("An operation is in progress.", { exact: false })
    .waitFor();
  await select("Browser preferences");
  await page.keyboard.press("Escape");
  await page.mouse.click(3, 3);
  assert(await settings.isVisible());
  while (!pendingResolve) await page.waitForTimeout(10);
  pending = false;
  pendingResolve();
  await settings
    .getByRole("button", { name: "Return to copy token" })
    .waitFor();
  await settings.getByRole("button", { name: "Return to copy token" }).click();
  assert.equal(
    await panel()
      .getByRole("textbox", { name: "Copy now — shown only once" })
      .inputValue(),
    "fixture-only-not-a-real-credential",
  );
  assert(
    await panel()
      .getByRole("button", { name: "Create access token" })
      .isDisabled(),
  );
  await select("OAuth authorizations");
  await settings.getByRole("button", { name: "Return to copy token" }).click();
  assert.equal(
    await panel()
      .getByRole("textbox", { name: "Copy now — shown only once" })
      .inputValue(),
    "fixture-only-not-a-real-credential",
  );
  await panel().getByRole("button", { name: "Dismiss", exact: true }).click();
  check("创建错误、忙碌关闭限制及一次性密钥跨分类保留");
  await panel().getByRole("combobox").selectOption("history");
  await panel().getByText("Revoked example", { exact: true }).waitFor();
  assert.equal(
    await panel().getByRole("button", { name: "Revoke", exact: true }).count(),
    0,
  );
  assert((await panel().innerText()).includes("Expired"));
  await panel().getByRole("combobox").selectOption("active");
  await panel().getByText("Example access token", { exact: false }).waitFor();
  await panel()
    .locator(".token-list li")
    .first()
    .getByRole("button", { name: "Revoke", exact: true })
    .click();
  await panel().getByText("Example drafted token", { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[role="tabpanel"]:not([hidden]) .token-list')
        ?.children.length === 1,
  );
  assert.equal(await panel().locator(".token-list li").count(), 1);
  check("访问令牌有效与只读历史列表、逐行撤销");
  await panel().getByRole("button", { name: "Hide token form" }).click();
  await page.screenshot({ path: resolve(output, "desktop-tokens.png") });
  await select("OAuth authorizations");
  pending = true;
  pendingResolve = undefined;
  await panel()
    .getByRole("button", { name: "Revoke client authorization" })
    .first()
    .click();
  await select("Browser preferences");
  await page.keyboard.press("Escape");
  assert(await settings.isVisible());
  while (!pendingResolve) await page.waitForTimeout(10);
  pending = false;
  pendingResolve();
  await select("OAuth authorizations");
  await panel()
    .getByRole("button", { name: "Refresh authorizations" })
    .waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('[role="tabpanel"]:not([hidden]) .token-list')
        ?.children.length === 4,
  );
  oauthError = true;
  await panel().getByRole("button", { name: "Refresh authorizations" }).click();
  await panel().getByRole("alert").waitFor();
  assert(!(await panel().innerText()).includes("No OAuth authorizations."));
  await select("Browser preferences");
  await select("OAuth authorizations");
  assert(await panel().getByRole("alert").isVisible());
  oauthError = false;
  grants = [];
  await panel().getByRole("button", { name: "Refresh authorizations" }).click();
  await panel()
    .getByText("No OAuth authorizations.", { exact: true })
    .waitFor();
  check("OAuth 逐行撤销、忙碌及刷新失败与空列表区分");
  await select("Recently deleted");
  assert((await panel().innerText()).includes("seven days"));
  await panel().getByRole("button", { name: "Open recently deleted" }).click();
  const deleted = page.getByRole("dialog", {
    name: "Recently deleted",
    exact: true,
  });
  await deleted.getByText("Recoverable example pin", { exact: true }).waitFor();
  await deleted.getByRole("button", { name: "Restore", exact: true }).click();
  await deleted.getByRole("button", { name: "Close Recently deleted" }).click();
  assert.equal(
    await tab("Recently deleted").getAttribute("aria-selected"),
    "true",
  );
  check("原有恢复弹层与返回最近删除分类");
  await page.mouse.click(3, 3);
  await settings.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") ===
      "Account options for Local UI fixture",
  );
  assert.equal(
    await page.locator(":focus").getAttribute("aria-label"),
    "Account options for Local UI fixture",
  );
  await openSettings();
  const bounds = await settings.boundingBox();
  await page.mouse.click(bounds.x + 3, bounds.y + 3);
  assert(await settings.isVisible());
  await page.mouse.move(bounds.x + 3, bounds.y + 3);
  await page.mouse.down();
  await page.mouse.move(3, 3);
  await page.mouse.up();
  assert(await settings.isVisible());
  await page.mouse.move(3, 3);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 3, bounds.y + 3);
  await page.mouse.up();
  assert(await settings.isVisible());
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") ===
      "Account options for Local UI fixture",
  );
  assert.equal(
    await page.locator(":focus").getAttribute("aria-label"),
    "Account options for Local UI fixture",
  );
  check("外侧与 Escape 关闭、内侧空白与双向跨边界拖动保护、焦点返回");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await openSettings();
    await tab("Browser preferences").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await tab("Access tokens").getAttribute("aria-selected"),
      "true",
    );
    await page.keyboard.press("End");
    assert.equal(
      await tab("Recently deleted").getAttribute("aria-selected"),
      "true",
    );
    await page.keyboard.press("Home");
    assert.equal(
      await tab("Browser preferences").getAttribute("aria-selected"),
      "true",
    );
    await select("Access tokens");
    await geometry(`${width}px 访问令牌布局`);
    await page.screenshot({
      path: resolve(output, `mobile-${width}-tokens.png`),
    });
    await select("OAuth authorizations");
    grants = [
      {
        id: "mobile",
        clientId: "long-example-id",
        clientName:
          "A very long unverified example client name that wraps on narrow screens",
        scopes: "pins:read pins:write publications:read publications:write",
        createdAt: now,
        expiresAt: null,
        revokedAt: null,
        tokenIssued: true,
        codeExpiresAt: now + 600000,
      },
    ];
    await panel()
      .getByRole("button", { name: "Refresh authorizations" })
      .click();
    await panel().getByText(grants[0].clientName, { exact: true }).waitFor();
    await geometry(`${width}px OAuth 列表布局与横向方向键`);
    await page.screenshot({
      path: resolve(output, `mobile-${width}-oauth.png`),
    });
    await page.mouse.click(3, 3);
    await settings.waitFor({ state: "hidden" });
  }
  await page.setViewportSize({ width: 1280, height: 480 });
  await openSettings();
  await select("Access tokens");
  await geometry("低高度桌面独立详情滚动");
  await page.keyboard.press("Escape");
  tokenError = true;
  await page.reload();
  await openSettings();
  await select("Access tokens");
  await panel()
    .getByText("Example token list failure", { exact: true })
    .waitFor();
  assert(!(await panel().innerText()).includes("No active tokens."));
  tokenError = false;
  tokens = [];
  await panel().getByRole("button", { name: "Retry access tokens" }).click();
  await panel().getByText("No active tokens.", { exact: true }).waitFor();
  check("访问令牌失败、重试与空列表区分");
  assert.deepEqual(failures, []);
  check("无浏览器运行错误、全部变更限于本地合成响应", mutations);
  const buildAssets = await Promise.all(assetResponses.values());
  if (process.env.SETTINGS_BUILD === "true") assert(buildAssets.length >= 2);
  await writeFile(
    resolve(output, "results.json"),
    `${JSON.stringify({ origin, buildAssets, checks }, null, 2)}\n`,
  );
  console.log(`Passed ${checks.length} browser checks; evidence: ${output}`);
} finally {
  await browser.close();
  await rm(resolve(".browser-tools/settings-profile"), {
    recursive: true,
    force: true,
  });
}
