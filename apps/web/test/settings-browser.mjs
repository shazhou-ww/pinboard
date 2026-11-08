// Production React build with synthetic routes restricted to localhost.
/* global document, window */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const origin = process.env.SETTINGS_ORIGIN ?? "http://localhost:5196";
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const output = resolve(
  process.env.SETTINGS_EVIDENCE ??
    ".browser-tools/settings-refinement-evidence",
);
await mkdir(output, { recursive: true });
process.env.TEMP = process.env.TMP = resolve(".browser-tools");
const { chromium } = await import(
  pathToFileURL(
    resolve(".browser-tools/node_modules/playwright-core/index.mjs"),
  ).href
);
const profile = resolve(".browser-tools/settings-refinement-profile");
const browser = await chromium.launchPersistentContext(profile, {
  executablePath:
    process.env.BROWSER_EXECUTABLE ??
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
  viewport: { width: 1280, height: 900 },
  downloadsPath: resolve(".browser-tools/downloads"),
});
const page = await browser.newPage();
const checks = [];
const check = (name, detail = "通过") => checks.push({ name, detail });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const assets = new Map();
page.on("response", (response) => {
  const url = new URL(response.url());
  if (
    url.origin === origin &&
    /^\/assets\/index-.*\.(js|css)$/.test(url.pathname)
  )
    assets.set(
      url.pathname,
      response.body().then((body) => ({
        path: url.pathname,
        sha256: createHash("sha256").update(body).digest("hex"),
      })),
    );
});
const now = Date.now();
const token = (id, name, expiresAt = now + 86400000, revokedAt = null) => ({
  id,
  name,
  prefix: "fixture_prefix",
  scopes: "pins:read publications:read",
  createdAt: new Date(now).toISOString(),
  expiresAt: new Date(expiresAt).toISOString(),
  revokedAt,
});
let tokens = Array.from({ length: 32 }, (_, i) =>
  token(`token-${i}`, `Example access token ${i}`),
);
let history = [
  token("expired", "Expired example", now - 1),
  token(
    "revoked",
    "Revoked example",
    now + 86400000,
    new Date(now).toISOString(),
  ),
];
let grants = Array.from({ length: 32 }, (_, i) => ({
  id: `grant-${i}`,
  clientId: `client-${i}`,
  clientName: `Example OAuth client ${i}`,
  scopes: "pins:read publications:read",
  createdAt: now,
  expiresAt: i === 1 ? null : now + 86400000,
  revokedAt: null,
  tokenIssued: true,
  codeExpiresAt: now + 600000,
}));
grants.push(
  { ...grants[0], id: "expired", clientName: "Expired OAuth", expiresAt: now },
  { ...grants[0], id: "revoked", clientName: "Revoked OAuth", revokedAt: now },
  {
    ...grants[0],
    id: "code-expired",
    clientName: "Expired code",
    expiresAt: null,
    tokenIssued: false,
    codeExpiresAt: now,
  },
  {
    ...grants[0],
    id: "pending",
    clientName: "Pending code",
    expiresAt: null,
    tokenIssued: false,
  },
);
let oauthError = false;
let tokenFailure = "";
let createFails = false;
let delayWrite = false;
let releaseWrite;
let delayHistory = false;
let releaseHistory;
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
  if (method !== "GET") {
    mutations.push({ path, method });
    if (delayWrite)
      await new Promise((done) => {
        releaseWrite = done;
      });
  }
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
    const view = url.searchParams.get("view");
    const snapshot = view === "history" ? history : tokens;
    if (delayHistory && view === "history")
      await new Promise((done) => {
        releaseHistory = done;
      });
    if (tokenFailure === view)
      return json({ error: `Example ${view} retrieval failure` }, 503);
    return json({ tokens: snapshot });
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
  if (path === "/api/oauth/grants")
    return oauthError
      ? json({ error: "OAuth fixture failure" }, 503)
      : json({ grants });
  if (path.startsWith("/api/oauth/grants/") && method === "DELETE") {
    grants = grants.map((item) =>
      path.endsWith(item.id) ? { ...item, revokedAt: now } : item,
    );
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
  throw new Error(`Unexpected local fixture request: ${method} ${path}`);
});
const settings = page.getByRole("dialog", {
  name: "Pinboard Settings",
  exact: true,
});
const tab = (name) =>
  settings.getByRole("tab", {
    name:
      {
        "Access tokens": "Tokens",
        "OAuth authorizations": "OAuth",
        "Recently deleted": "Trash",
      }[name] ?? name,
    exact: true,
  });
const panel = () => settings.locator('[role="tabpanel"]:visible');
const form = page.getByRole("dialog", {
  name: "Create access token",
  exact: true,
});
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
async function filter(include) {
  await panel()
    .getByRole("button", { name: /filter options/ })
    .click();
  await panel()
    .getByRole("switch", { name: "Show inactive authorizations" })
    .setChecked(include);
  await page.keyboard.press("Escape");
  assert(await settings.isVisible());
}
async function tableGeometry(label, horizontal) {
  const region = panel().getByRole("region");
  const before = await region.evaluate((element) => {
    const rect = (node) => node.getBoundingClientRect().toJSON();
    return {
      table: rect(element),
      header: rect(element.querySelector("th")),
      toolbar: rect(
        element.parentElement.querySelector(".authorization-toolbar"),
      ),
      pageWidth: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });
  assert(before.pageWidth <= before.viewport);
  assert(
    before.scrollHeight > before.clientHeight + 100,
    `${label}: enough rows to scroll`,
  );
  assert.equal(before.scrollWidth > before.clientWidth + 1, horizontal);
  await region.evaluate((element) => {
    element.scrollTop = 250;
  });
  await page.waitForTimeout(50);
  const after = await region.evaluate((element) => ({
    scrollTop: element.scrollTop,
    headerTop: element.querySelector("th").getBoundingClientRect().top,
    toolbarTop: element.parentElement
      .querySelector(".authorization-toolbar")
      .getBoundingClientRect().top,
  }));
  assert(after.scrollTop > 100);
  assert(Math.abs(after.headerTop - before.header.top) < 2);
  assert.equal(after.toolbarTop, before.toolbar.top);
  if (horizontal) {
    await region.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    assert(await region.evaluate((element) => element.scrollLeft > 0));
  }
  await region.evaluate((element) => {
    element.scrollTop = 0;
    element.scrollLeft = 0;
  });
  check(label, { before, after });
}
try {
  await page.goto(origin);
  await openSettings();
  assert.equal(await settings.getByRole("tab").count(), 4);
  assert.deepEqual(await settings.getByRole("tab").allTextContents(), [
    "General",
    "Tokens",
    "OAuth",
    "Trash",
  ]);
  assert(
    await settings.getByRole("tab").evaluateAll((buttons) =>
      buttons.every((button) => {
        const range = document.createRange();
        range.selectNodeContents(button);
        const text = range.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        return (
          range.getClientRects().length === 1 &&
          text.left >= bounds.left &&
          text.right <= bounds.right
        );
      }),
    ),
  );
  assert.equal(
    await settings.locator("> .section-title h2").innerText(),
    "Pinboard Settings",
  );
  assert.equal(
    await settings
      .getByRole("button", { name: "Close Pinboard Settings" })
      .getAttribute("title"),
    "Close Pinboard Settings",
  );
  assert((await panel().innerText()).includes("MCP endpoint"));
  assert.equal(
    await panel()
      .locator(".background-swatch")
      .first()
      .evaluate((node) => node.getBoundingClientRect().height),
    144,
  );
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
  check("General 配置归属、144px 色块、配色与本浏览器提醒");
  await tab("General").focus();
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
  check("桌面键盘分类");
  await select("Access tokens");
  await panel().getByText("Example access token 0", { exact: true }).waitFor();
  assert(!(await panel().innerText()).includes("MCP endpoint"));
  await tableGeometry("1280px token 表格独立滚动与固定表头", false);
  await filter(true);
  await panel().getByText("Revoked example", { exact: true }).waitFor();
  for (const name of ["Expired example", "Revoked example"])
    assert.equal(
      await panel()
        .getByRole("row")
        .filter({ hasText: name })
        .getByRole("button")
        .count(),
      0,
    );
  assert(
    (
      await panel()
        .getByRole("button", { name: /filter options/ })
        .getAttribute("class")
    ).includes("filter-active"),
  );
  await panel().getByRole("searchbox").fill("PUBLICATIONS:READ");
  assert.equal(await panel().locator("tbody tr").count(), 34);
  await panel().getByRole("searchbox").fill("Expired example");
  assert.equal(await panel().locator("tbody tr").count(), 1);
  await filter(false);
  await panel()
    .getByText("No matching access tokens.", { exact: true })
    .waitFor();
  await panel()
    .getByRole("searchbox")
    .fill("fixture-only-not-a-real-credential");
  assert.equal(
    await panel()
      .getByRole("button", { name: /^Revoke/ })
      .count(),
    0,
  );
  await panel().getByRole("searchbox").fill("");
  await panel().getByText("Example access token 0", { exact: true }).waitFor();
  check("token 搜索与筛选组合、无效行无撤销、密钥不参与搜索");
  // An in-flight history response must not restore old filters/results.
  delayHistory = true;
  await filter(true);
  await panel()
    .getByText("Loading access tokens...", { exact: true })
    .waitFor();
  await filter(false);
  await panel().getByText("Example access token 0", { exact: true }).waitFor();
  assert(releaseHistory);
  delayHistory = false;
  releaseHistory();
  await page.waitForTimeout(100);
  assert.equal(
    await panel().getByText("Revoked example", { exact: true }).count(),
    0,
  );
  check("token 请求竞争不回写陈旧历史");
  for (const view of ["active", "history"]) {
    tokenFailure = view;
    await filter(true);
    await panel()
      .getByRole("alert")
      .getByText(`Example ${view} retrieval failure`, { exact: true })
      .waitFor();
    assert.equal(
      await panel()
        .getByRole("button", { name: /^Revoke/ })
        .count(),
      0,
    );
    tokenFailure = "";
    await panel().getByRole("button", { name: "Retry access tokens" }).click();
    await panel().getByText("Revoked example", { exact: true }).waitFor();
    await filter(false);
    await panel()
      .getByText("Example access token 0", { exact: true })
      .waitFor();
  }
  check("active/history 任一请求失败不伪装空列表，重试恢复");
  await panel()
    .getByRole("button", { name: "Create access token", exact: true })
    .click();
  await form
    .getByRole("textbox", { name: "Token label" })
    .fill("Example drafted token");
  await form.getByRole("spinbutton").fill("17");
  assert.equal(await form.getByRole("checkbox").count(), 6);
  assert.equal(await form.getByRole("spinbutton").getAttribute("min"), "1");
  assert.equal(await form.getByRole("spinbutton").getAttribute("max"), "365");
  await form.getByRole("checkbox", { name: "pins:write", exact: true }).check();
  await page.keyboard.press("Escape");
  assert(await settings.isVisible());
  await select("OAuth authorizations");
  assert(!(await panel().innerText()).includes("MCP endpoint"));
  await select("Access tokens");
  await panel()
    .getByRole("button", { name: "Create access token", exact: true })
    .click();
  assert.equal(
    await form.getByRole("textbox", { name: "Token label" }).inputValue(),
    "Example drafted token",
  );
  assert.equal(await form.getByRole("spinbutton").inputValue(), "17");
  createFails = true;
  await form
    .getByRole("button", { name: "Create access token", exact: true })
    .click();
  await form.getByRole("alert").waitFor();
  createFails = false;
  delayWrite = true;
  await form
    .getByRole("button", { name: "Create access token", exact: true })
    .click();
  await form
    .getByRole("button", { name: "Close Create access token" })
    .waitFor();
  await page.waitForFunction(
    () =>
      document
        .querySelector('dialog[aria-label="Create access token"]')
        ?.getAttribute("aria-busy") === "true",
  );
  assert(
    await form
      .getByRole("button", { name: "Close Create access token" })
      .isDisabled(),
  );
  await page.keyboard.press("Escape");
  await page.mouse.click(3, 3);
  assert(await form.isVisible());
  assert(releaseWrite);
  delayWrite = false;
  releaseWrite();
  await form
    .getByRole("textbox", { name: "Copy now — shown only once" })
    .waitFor();
  assert.equal(
    await form
      .getByRole("textbox", { name: "Copy now — shown only once" })
      .inputValue(),
    "fixture-only-not-a-real-credential",
  );
  assert(
    await form
      .getByRole("button", { name: "Create access token", exact: true })
      .isDisabled(),
  );
  await page.keyboard.press("Escape");
  await select("General");
  await settings
    .getByRole("button", { name: "Return to copy token", exact: true })
    .click();
  await panel().getByRole("button", { name: "Copy new access token" }).click();
  assert.equal(
    await form
      .getByRole("textbox", { name: "Copy now — shown only once" })
      .inputValue(),
    "fixture-only-not-a-real-credential",
  );
  await form.getByRole("button", { name: "Dismiss", exact: true }).click();
  await page.keyboard.press("Escape");
  check(
    "独立创建弹层、6 scopes/有效期、草稿跨分类、失败/忙碌保护与一次性密钥不覆盖",
  );
  await panel()
    .getByRole("row")
    .filter({ hasText: "Example access token 0" })
    .getByRole("button")
    .click();
  await page.waitForTimeout(100);
  assert.equal(
    await panel().getByText("Example access token 0", { exact: true }).count(),
    0,
  );
  await select("OAuth authorizations");
  await panel().getByText("Pending code", { exact: true }).waitFor();
  assert.equal(await panel().locator("tbody tr").count(), 33);
  await filter(true);
  await select("Access tokens");
  await panel()
    .getByRole("button", { name: /filter options/ })
    .click();
  assert.equal(await panel().getByRole("switch").isChecked(), false);
  await page.keyboard.press("Escape");
  await select("OAuth authorizations");
  await panel()
    .getByRole("button", { name: /filter options/ })
    .click();
  assert.equal(await panel().getByRole("switch").isChecked(), true);
  await page.keyboard.press("Escape");
  check("两页筛选状态独立保留");
  for (const name of ["Expired OAuth", "Revoked OAuth", "Expired code"])
    assert.equal(
      await panel()
        .getByRole("row")
        .filter({ hasText: name })
        .getByRole("button")
        .count(),
      0,
    );
  await panel().getByRole("searchbox").fill("Expired");
  assert.equal(await panel().locator("tbody tr").count(), 2);
  await panel().getByRole("searchbox").fill("");
  delayWrite = true;
  releaseWrite = undefined;
  await panel()
    .getByRole("row")
    .filter({ hasText: "Example OAuth client 0" })
    .getByRole("button")
    .click();
  await select("General");
  await page.waitForFunction(
    () =>
      document
        .querySelector('dialog[aria-label="Pinboard Settings"]')
        ?.getAttribute("aria-busy") === "true",
  );
  assert(
    await settings
      .getByRole("button", { name: "Close Pinboard Settings" })
      .isDisabled(),
  );
  await page.keyboard.press("Escape");
  await page.mouse.click(3, 3);
  assert(await settings.isVisible());
  assert(releaseWrite);
  delayWrite = false;
  releaseWrite();
  await select("OAuth authorizations");
  await page.waitForTimeout(100);
  oauthError = true;
  await panel().getByRole("button", { name: "Refresh authorizations" }).click();
  await panel().getByRole("alert").waitFor();
  assert.equal(
    await panel()
      .getByText("No OAuth authorizations.", { exact: true })
      .count(),
    0,
  );
  oauthError = false;
  await panel().getByRole("button", { name: "Refresh authorizations" }).click();
  await panel().getByText("Pending code", { exact: true }).waitFor();
  check("OAuth 有效/待兑换/无效状态、逐行撤销、忙碌关闭与刷新失败");
  await page
    .getByText("Token revoked.", { exact: true })
    .waitFor({ state: "hidden" });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await select("General");
    assert.equal(
      await panel()
        .locator(".background-swatch")
        .first()
        .evaluate((node) => node.getBoundingClientRect().height),
      width === 1280 ? 144 : 108,
    );
    await page.screenshot({ path: resolve(output, `${width}-general.png`) });
    for (const category of ["Access tokens", "OAuth authorizations"]) {
      await select(category);
      await tableGeometry(
        `${width}px ${category} 表头与工具栏固定/内部横向滚动`,
        width < 640,
      );
      await panel()
        .getByRole("button", { name: /filter options/ })
        .click();
      const popup = await panel()
        .locator(".authorization-filter-menu")
        .boundingBox();
      assert(popup.x >= 0 && popup.x + popup.width <= width);
      await page.keyboard.press("Escape");
      assert(
        (await page.locator(":focus").getAttribute("aria-label")).includes(
          "filter options",
        ),
      );
      assert(await settings.isVisible());
      await panel()
        .getByRole("button", { name: /filter options/ })
        .click();
      await panel().getByRole("heading").click();
      assert.equal(await panel().getByRole("switch").count(), 0);
      assert(
        await settings.evaluate((dialog) =>
          dialog.contains(document.activeElement),
        ),
      );
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press(i % 2 ? "Shift+Tab" : "Tab");
        assert(
          await settings.evaluate((dialog) =>
            dialog.contains(document.activeElement),
          ),
        );
      }
      await page.screenshot({
        path: resolve(
          output,
          `${width}-${category === "Access tokens" ? "tokens" : "oauth"}.png`,
        ),
      });
    }
  }
  check("1280/390/320px popup 适配、外侧收起与 Escape 恢复焦点");
  await page.setViewportSize({ width: 1280, height: 480 });
  await select("Access tokens");
  await tableGeometry("1280x480 低窗口仍可独立滚动", false);
  const lowBounds = await settings.boundingBox();
  assert(lowBounds.y >= 0 && lowBounds.y + lowBounds.height <= 480);
  await page.setViewportSize({ width: 320, height: 900 });
  await select("Recently deleted");
  assert((await panel().innerText()).includes("seven days"));
  await panel().getByRole("button", { name: "Open recently deleted" }).click();
  const deleted = page.getByRole("dialog", {
    name: "Recently deleted",
    exact: true,
  });
  await deleted.getByRole("button", { name: "Restore", exact: true }).click();
  await deleted.getByRole("button", { name: "Close Recently deleted" }).click();
  assert.equal(
    await tab("Recently deleted").getAttribute("aria-selected"),
    "true",
  );
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("aria-label") ===
      "Account options for Local UI fixture",
  );
  check("恢复独立弹层与返回分类、关闭焦点回入口");
  await openSettings();
  await select("Access tokens");
  await panel()
    .getByRole("button", { name: /filter options/ })
    .click();
  await page.keyboard.press("Escape");
  assert(await settings.isVisible());
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  await openSettings();
  await page.mouse.click(3, 3);
  await settings.waitFor({ state: "hidden" });
  await openSettings();
  const bounds = await settings.boundingBox();
  await page.mouse.move(bounds.x + 40, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(3, 3);
  await page.mouse.up();
  assert(await settings.isVisible());
  await page.mouse.move(3, 3);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 40, bounds.y + 40);
  await page.mouse.up();
  assert(await settings.isVisible());
  await select("OAuth authorizations");
  grants = [];
  await panel().getByRole("button", { name: "Refresh authorizations" }).click();
  await panel()
    .getByText("No OAuth authorizations.", { exact: true })
    .waitFor();
  assert.equal(await panel().getByRole("alert").count(), 0);
  await select("Access tokens");
  tokens = [];
  await filter(true);
  await panel().getByText("Revoked example", { exact: true }).waitFor();
  await filter(false);
  await panel()
    .getByText("No active access tokens.", { exact: true })
    .waitFor();
  await panel().getByRole("searchbox").fill("missing");
  await panel()
    .getByText("No matching access tokens.", { exact: true })
    .waitFor();
  check("真正空列表、筛选无匹配、加载与错误状态分别可辨");
  await settings
    .getByRole("button", { name: "Close Pinboard Settings" })
    .click();
  await settings.waitFor({ state: "hidden" });
  check("双向跨边界拖动不误关闭，关闭图标可用");
  check("Escape 首次关闭 popup、再次关闭 Settings，外侧关闭保留");
  assert.deepEqual(errors, []);
  const builtAssets = await Promise.all(assets.values());
  assert.equal(builtAssets.length, 2);
  const result = {
    verifiedAt: new Date().toISOString(),
    build: "production Vite preview",
    scope:
      "localhost synthetic API only; no production requests or credentials",
    checks,
    errors,
    assets: builtAssets,
    mutations,
  };
  await writeFile(
    resolve(output, "results.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ checks: checks.length, errors, output }, null, 2),
  );
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}
