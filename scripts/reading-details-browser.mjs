import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installReadingFixture } from "./reading-details-fixture.mjs";

const url = process.argv[2] ?? "http://localhost:5178";
assert(
  ["localhost", "127.0.0.1"].includes(new URL(url).hostname),
  "Fixtures must never run against production",
);
const output = process.argv[3] ?? ".reading-details-evidence";
const profile = resolve(".reading-details-browser-profile");
const chrome =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 9338;
const browser = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
let socket;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence = [];
try {
  let targets;
  for (let i = 0; i < 80; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      break;
    } catch {
      await pause(100);
    }
  }
  assert(targets?.length, "Chrome CDP is responsive");
  socket = new WebSocket(
    targets.find((item) => item.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 0;
  const waiting = new Map();
  const dialogs = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Page.javascriptDialogOpening")
      dialogs.push(message.params);
    if (message.method === "Fetch.requestPaused")
      void send("Fetch.fulfillRequest", {
        requestId: message.params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "image/png" }],
        body: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
      });
    const callback = waiting.get(message.id);
    if (callback) {
      waiting.delete(message.id);
      message.error
        ? callback.reject(message.error)
        : callback.resolve(message.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await pause(50);
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const check = async (label, expression) => {
    assert(await evaluate(expression), label);
    evidence.push(label);
    console.log(`PASS ${label}`);
  };
  const click = async (text, tag = "button") => {
    await wait(
      `Array.from(document.querySelectorAll('dialog[open] ${tag}')).some(e => e.textContent.trim() === ${JSON.stringify(text)} && e.getClientRects().length && !e.disabled)`,
    );
    await evaluate(
      `setTimeout(() => { const e = Array.from(document.querySelectorAll('dialog[open] ${tag}')).find(e => e.textContent.trim() === ${JSON.stringify(text)} && e.getClientRects().length && !e.disabled); e.focus(); e.click(); }, 0)`,
    );
    await pause(80);
  };
  const key = async (key, code = key) => {
    const windowsVirtualKeyCode =
      key === "Escape" ? 27 : key === "Tab" ? 9 : key === "Enter" ? 13 : 0;
    void send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode,
    });
    void send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode,
    });
    await pause(80);
  };
  const setValue = async (selector, value) => {
    await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
      const prototype = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : e.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(e, ${JSON.stringify(value)});
      e.dispatchEvent(new Event(e.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true})); })()`);
    await pause(60);
  };
  const answer = async (accept) => {
    await pause(40);
    assert(dialogs.length, "Expected a native confirmation");
    await send("Page.handleJavaScriptDialog", { accept });
    await pause(80);
    return dialogs.pop();
  };
  const screenshot = async (name) => {
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    await writeFile(resolve(output, name), Buffer.from(data, "base64"));
  };
  const open = async (publication = false, single = false) => {
    await evaluate(
      `(() => { const key = ${JSON.stringify(publication ? (single ? "publication:single-fixture" : "publication:reading-fixture") : "pin:bafkreigh2akiscaildcxxbmjcwt4svm6yv6oubkcb3i3m2ak6bpgxy3s6a")}; const e = document.querySelector('[data-detail-key="' + key + '"]'); e.focus(); e.click(); })()`,
    );
    await wait(
      `document.querySelector('dialog[open] .reading-content .pin-preview')`,
    );
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "*/ipfs/*" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(${installReadingFixture.toString()})()`,
  });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url });
  await wait("document.querySelectorAll('.pin-card').length === 4");
  await mkdir(output, { recursive: true });
  await open();
  await check(
    "普通 Pin 默认只读说明、内容优先、高级查询折叠",
    `document.querySelector('dialog[open] .reading-content').textContent.includes('Private content excerpt') && !document.querySelector('dialog[open] textarea') && !document.querySelector('dialog[open] .detail-advanced').open`,
  );
  await screenshot("pin-desktop.png");
  await click("Edit description");
  await setValue("dialog[open] textarea", "Unsaved draft");
  await key("Escape");
  await answer(false);
  await check(
    "未保存编辑取消关闭后保留草稿",
    `document.querySelector('dialog[open] textarea').value === 'Unsaved draft'`,
  );
  await click("Cancel edit");
  await check(
    "取消编辑恢复只读原文",
    `document.querySelector('dialog[open]').textContent.includes('Private fixture description') && !document.querySelector('dialog[open] textarea')`,
  );
  await click("Edit description");
  await setValue("dialog[open] textarea", "Conflict draft");
  await evaluate("window.__readingTest.conflict = true");
  await click("Save description");
  await wait(`document.querySelector('dialog[open] [role="alert"]')`);
  await check(
    "说明冲突保留草稿和 expectedVersion",
    `document.querySelector('dialog[open] textarea').value === 'Conflict draft' && window.__readingTest.requests.find(r=>r.method === 'PUT').body.expectedVersion === 1`,
  );
  await evaluate("window.__readingTest.conflict = false");
  await click("Save description");
  await wait("!document.querySelector('dialog[open] textarea')");
  await check(
    "保存私人说明后回到只读",
    `document.querySelector('dialog[open]').textContent.includes('Conflict draft')`,
  );
  await click("Edit description");
  await setValue("dialog[open] textarea", "Busy save draft");
  await evaluate("window.__readingTest.delayWrite = 2000");
  await click("Save description");
  await wait(
    `document.querySelector('dialog[open]')?.getAttribute('aria-busy') === 'true'`,
  );
  await key("Escape");
  await check(
    "写入期间不能关闭详情",
    `document.querySelector('dialog[open]').getAttribute('aria-busy') === 'true' && document.querySelector('dialog[open] > .section-title button').disabled`,
  );
  await wait("!document.querySelector('dialog[open] textarea')");
  await evaluate("window.__readingTest.delayWrite = 0");
  for (let i = 0; i < 10; i++) {
    await key("Tab");
    assert(
      await evaluate(`document.activeElement.closest('dialog[open]') !== null`),
      `Tab ${i + 1} stays in dialog`,
    );
  }
  evidence.push("连续十次 Tab 循环保持弹窗焦点约束");
  await click("Share", "summary");
  await check(
    "普通 Pin 固定分享且不公开私人名称",
    `document.querySelector('dialog[open] .detail-menu[open]').textContent.includes('Private name and description are not shared')`,
  );
  await key("Escape");
  await check(
    "菜单 Escape 不关闭详情且焦点返回菜单入口",
    `!!document.querySelector('dialog[open]') && document.activeElement.textContent === 'Share' && !document.querySelector('dialog[open] .detail-menu').open`,
  );
  await click("Download", "summary");
  await check(
    "普通 Pin file/ZIP 与 CAR 固定根 CID",
    `Array.from(document.querySelectorAll('dialog[open] .detail-menu[open] a')).every(a=>a.href.includes(window.__readingTest.pins[0].cid))`,
  );
  await key("Escape");
  await click("Advanced information and node query", "summary");
  await wait(
    `document.querySelector('dialog[open] .node-description-editor input')`,
  );
  await setValue(
    "dialog[open] .node-description-editor input",
    "baf-unreachable",
  );
  await click("Read node");
  await wait(
    `document.querySelector('dialog[open]').textContent.includes('not reachable')`,
  );
  await check(
    "高级查询保留授权根约束、失败不覆盖主内容",
    `document.querySelector('dialog[open] .reading-content').textContent.includes('Private content excerpt')`,
  );
  await click("Advanced information and node query", "summary");
  await key("Escape");
  await check(
    "详情 Escape 关闭且焦点返回触发卡片",
    `!document.querySelector('dialog[open]') && document.activeElement.closest('.pin-card') !== null`,
  );
  await open(true);
  await check(
    "Publication 打开 current v3 而非 latest v5",
    `document.querySelector('dialog[open]').textContent.includes('Viewing v3 · Public current v3 · Latest v5') && document.querySelector('dialog[open]').textContent.includes('Public snapshot v3')`,
  );
  await screenshot("publication-desktop.png");
  await click("View v5 · Latest");
  await wait(
    `document.querySelector('dialog[open]').textContent.includes('Public snapshot v5')`,
  );
  await check(
    "浏览 v5 不回滚且公开跟随仍 v3",
    `window.__readingTest.publication.currentRevision === 3 && !window.__readingTest.requests.some(r=>r.path.endsWith('/rollback')) && document.querySelector('dialog[open]').textContent.includes('Viewing v5 · Public current v3')`,
  );
  await click("Share", "summary");
  await check(
    "选中 v5 的固定链接和 CID 与跟随身份分离",
    `document.querySelector('dialog[open] .detail-menu[open]').textContent.includes('Copy fixed v5 link') && document.querySelector('dialog[open] .detail-menu[open]').textContent.includes('current v3')`,
  );
  await key("Escape");
  await click("Download", "summary");
  await check(
    "Publication file/ZIP 与 CAR 绑定选中 v5 确定 CID",
    `Array.from(document.querySelectorAll('dialog[open] .detail-menu[open] a')).every(a=>a.href.includes(window.__readingTest.revisions[4].cid) && !a.href.includes('/current'))`,
  );
  await key("Escape");
  await click("Make viewed v5 current");
  await answer(false);
  await check(
    "取消 Make current 不写入",
    `!window.__readingTest.requests.some(r=>r.path.endsWith('/rollback'))`,
  );
  await click("Make viewed v5 current");
  await answer(true);
  await wait(
    `document.querySelector('dialog[open]').textContent.includes('Public current v5')`,
  );
  await check(
    "显式 Make current 使用 sequence CAS、不增加 revision",
    `window.__readingTest.publication.currentRevision === 5 && window.__readingTest.revisions.length === 5 && window.__readingTest.requests.find(r=>r.path.endsWith('/rollback')).body.expectedSequence === 6`,
  );
  await evaluate("window.__readingTest.lateRevision = 1");
  await click("View v1");
  await click("View v3");
  await wait(
    `document.querySelector('dialog[open]').textContent.includes('Public snapshot v3')`,
  );
  await pause(750);
  await check(
    "切换版本后的迟到响应不覆盖选中快照",
    `document.querySelector('dialog[open]').textContent.includes('Public snapshot v3') && !document.querySelector('dialog[open]').textContent.includes('Public snapshot v1')`,
  );
  await click("More", "summary");
  await click("Publish new version");
  await check(
    "独立发布任务优先 owned Pin 名称、没有原始 CID 输入",
    `!!document.querySelector('dialog[open] select') && !document.querySelector('dialog[open] input[list]') && document.querySelector('dialog[open]').textContent.includes('Second owned pin')`,
  );
  await setValue(
    "dialog[open] select",
    await evaluate("window.__readingTest.pins[1].cid"),
  );
  await evaluate("window.__readingTest.publishFailure = true");
  await click("Publish new version");
  await check(
    "发布失败保留选择与独立 Pin、基线使用真实 sequence",
    `document.querySelector('dialog[open] select').value === window.__readingTest.pins[1].cid && window.__readingTest.pins.length === 2 && window.__readingTest.requests.find(r=>r.path.endsWith('/publish')).body.expectedSequence === 7`,
  );
  await click("Cancel publishing");
  await answer(true);
  await key("Escape");
  await wait("!document.querySelector('dialog[open]')");
  await evaluate("window.__readingTest.historyFailure = true");
  await open(true);
  await wait(
    `document.querySelector('dialog[open]').textContent.includes('Fixture history unavailable')`,
  );
  await check(
    "历史失败显式区域提示且已有内容仍可读",
    `document.querySelector('dialog[open]').textContent.includes('Fixture history unavailable') && document.querySelector('dialog[open]').textContent.includes('Public snapshot v5')`,
  );
  await evaluate("window.__readingTest.historyFailure = false");
  await click("Retry history");
  await wait(
    `document.querySelector('dialog[open]').textContent.includes('View v1')`,
  );
  await check(
    "历史失败可恢复",
    `!document.querySelector('dialog[open]').textContent.includes('Fixture history unavailable')`,
  );
  await key("Escape");
  await open(true, true);
  await check(
    "单版本 Publication 默认 v1、无回滚按钮",
    `document.querySelector('dialog[open]').textContent.includes('Viewing v1 · Public current v1 · Latest v1') && !document.querySelector('dialog[open]').textContent.includes('Make viewed')`,
  );
  await key("Escape");
  await send("Emulation.setTouchEmulationEnabled", { enabled: true });
  for (const width of [390, 320]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    for (const published of [false, true]) {
      await open(published);
      await check(
        `${width}px ${published ? "Publication" : "Pin"} 单列、长名称/CID 不横向溢出`,
        `(() => { const d=document.querySelector('dialog[open]'); const content=d.querySelector('.reading-content').getBoundingClientRect(); const side=d.querySelector('.reading-sidebar').getBoundingClientRect(); return d.scrollWidth <= d.clientWidth + 1 && side.top > content.top && d.getBoundingClientRect().right <= innerWidth; })()`,
      );
      await screenshot(`${published ? "publication" : "pin"}-${width}.png`);
      const point = await evaluate(
        `(() => { const r=document.querySelector('dialog[open] .detail-menu > summary').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
      );
      await send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [point],
      });
      await send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await pause(100);
      await check(
        `${width}px ${published ? "Publication" : "Pin"} 触屏 Share 可用`,
        `document.querySelector('dialog[open] .detail-menu').open`,
      );
      await key("Escape");
      await evaluate(
        "document.querySelector('dialog[open]').scrollTop = 10000",
      );
      await check(
        `${width}px ${published ? "Publication" : "Pin"} 关闭与主动作在滚动后保持可见`,
        `(() => { const d=document.querySelector('dialog[open]').getBoundingClientRect(); const title=document.querySelector('dialog[open] > .section-title').getBoundingClientRect(); const bar=document.querySelector('dialog[open] .detail-toolbar').getBoundingClientRect(); return title.top >= d.top && bar.top >= title.bottom - 1 && bar.bottom < d.bottom; })()`,
      );
      await screenshot(
        `${published ? "publication" : "pin"}-${width}-scrolled.png`,
      );
      await key("Escape");
    }
  }
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const status of ["pending", "failed", "unsupported"]) {
    await evaluate(
      `window.__readingTest.previewStatus = ${JSON.stringify(status)}`,
    );
    await open();
    await check(
      `预览 ${status} 状态不伪装成功`,
      `document.querySelector('dialog[open] .preview-scope').textContent.includes(${JSON.stringify(status === "pending" ? "being generated" : status === "failed" ? "failed" : "not supported")})`,
    );
    await key("Escape");
  }
  await evaluate(
    `window.__readingTest.previewStatus = 'ready'; window.__readingTest.text = null`,
  );
  for (const kind of ["text", "directory", "image", "pdf"]) {
    await evaluate(
      `window.__readingTest.previewKind = ${JSON.stringify(kind)}`,
    );
    await open();
    await check(
      `${kind} 预览标明有限能力、空说明可识别`,
      `document.querySelector('dialog[open]').textContent.includes('No private description') && !!document.querySelector('dialog[open] .preview-scope')`,
    );
    await key("Escape");
  }
  await evaluate("window.__readingTest.descriptionFailure = true");
  await open().catch(() => {});
  await wait(
    `document.querySelector('dialog[open]').textContent.includes('Fixture description unavailable')`,
  );
  await evaluate("window.__readingTest.descriptionFailure = false");
  await click("Retry description");
  await wait("document.querySelector('dialog[open] .pin-preview')");
  await check(
    "说明读取失败可重试恢复",
    `!document.querySelector('dialog[open]').textContent.includes('Fixture description unavailable')`,
  );
  await key("Escape");
  await open();
  await click("More", "summary");
  await click("Add to a publication");
  await wait(`document.querySelector('dialog[open] select:not(:disabled)')`);
  await check(
    "关联任务明确保留源 Pin、创建公开标题不默认私人名称",
    `document.querySelector('dialog[open]').textContent.includes('without removing or renaming it') && document.querySelector('dialog[open] input').value === ''`,
  );
  await setValue("dialog[open] select", "reading-fixture");
  await evaluate("window.__readingTest.publishFailure = false");
  await click("Publish");
  await wait(
    `document.querySelector('dialog[open]').textContent.includes('Already current')`,
  );
  await check(
    "关联已有 Publication 保留源 Pin 并使用真实 sequence",
    `window.__readingTest.pins.length === 2 && window.__readingTest.requests.filter(r=>r.path.endsWith('/publish')).at(-1).body.cid === window.__readingTest.pins[0].cid && window.__readingTest.requests.filter(r=>r.path.endsWith('/publish')).at(-1).body.expectedSequence === 7`,
  );
  await click("Close");
  await open();
  await click("More", "summary");
  await click("Convert to publication");
  await check(
    "转换是独立确认任务并要求明确公开标题",
    `document.querySelector('dialog[open]').textContent.includes('Replace this fixed Pin') && document.querySelector('dialog[open] input').value === '' && !document.querySelector('dialog[open] select')`,
  );
  await click("Close");
  await open();
  await click("More", "summary");
  await click("Move to recently deleted");
  await answer(false);
  await check(
    "取消最近删除不发送写入",
    `!window.__readingTest.requests.some(r=>r.method === 'DELETE') && window.__readingTest.pins.length === 2`,
  );
  await key("Escape");
  await writeFile(
    resolve(output, "browser-result.json"),
    JSON.stringify({ url, checks: evidence.length, evidence }, null, 2) + "\n",
  );
  console.log(`Browser checks passed: ${evidence.length}`);
} finally {
  socket?.close();
  browser.kill();
  await pause(700);
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 300,
  });
}
