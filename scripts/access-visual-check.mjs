// Local readonly preview: layout/focus evidence, not an authentication bypass or production test.
/* global document, window, getComputedStyle, innerWidth */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const origin = process.env.ACCESS_VISUAL_ORIGIN ?? "http://127.0.0.1:5199";
assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const profile = resolve(`.access-browser-profile-${process.pid}`);
const evidence = resolve(
  process.env.ACCESS_VISUAL_EVIDENCE ??
    ".silvermoon\\ideas\\01M6ZM2KA80KHK49XQZWWNN66W\\outer\\inner\\AccessVisual.json",
);
await mkdir(profile, { recursive: true });
const port = Number(process.env.ACCESS_VISUAL_CDP_PORT ?? 9333);
const chrome = spawn(
  process.env.BROWSER_EXECUTABLE ??
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "about:blank",
  ],
  { stdio: "ignore", env: { ...process.env, TEMP: profile, TMP: profile } },
);
let socket;
const pending = new Map();
let sequence = 0;
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(expression) {
  for (let i = 0; i < 120; i++) {
    if (await evaluate(`!!(${expression})`)) return;
    await wait(100);
  }
  throw new Error("Local UI condition timed out: " + expression);
}
const results = [];
try {
  let tabs;
  for (let i = 0; i < 100; i++) {
    try {
      tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (tabs.length) break;
    } catch {}
    await wait(100);
  }
  assert(tabs?.length, "Chrome did not start");
  socket = new WebSocket(
    tabs.find((tab) => tab.type === "page").webSocketDebuggerUrl,
  );
  await new Promise((done, fail) => {
    socket.addEventListener("open", done, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const action = pending.get(message.id);
      pending.delete(message.id);
      if (message.error)
        action.reject(new Error(JSON.stringify(message.error)));
      else action.resolve(message.result);
    } else if (message.method === "Page.javascriptDialogOpening") {
      void send("Page.handleJavaScriptDialog", { accept: true });
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Page.navigate", { url: origin + "/#preview" });
  await until("document.querySelectorAll('.pin-card').length >= 4");
  for (const width of [1280, 390, 320]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 500,
    });
    await wait(250);
    await evaluate("document.activeElement?.blur()");
    await wait(250);
    const unfocusedWidth = await evaluate(
      "document.querySelector('.item-filter').getBoundingClientRect().width",
    );
    await evaluate("document.querySelector('.item-filter select').focus()");
    await wait(250);
    const accessFocusedWidth = await evaluate(
      "document.querySelector('.item-filter').getBoundingClientRect().width",
    );
    assert.equal(accessFocusedWidth, unfocusedWidth);
    await evaluate("document.querySelector('.item-filter input').focus()");
    await wait(250);
    const inputFocusedWidth = await evaluate(
      "document.querySelector('.item-filter').getBoundingClientRect().width",
    );
    if (width > 959)
      assert(
        inputFocusedWidth > unfocusedWidth,
        JSON.stringify({
          width,
          unfocusedWidth,
          accessFocusedWidth,
          inputFocusedWidth,
        }),
      );
    else assert.equal(inputFocusedWidth, unfocusedWidth);
    await evaluate("document.querySelector('.item-filter select').focus()");
    await wait(250);
    const trigger = await evaluate(`(() => {
      const select=document.querySelector('.item-filter select');
      const bounds=select.getBoundingClientRect();
      const group=select.closest('.item-filter').getBoundingClientRect();
      return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2,
        contained:bounds.x>=group.x&&bounds.y>=group.y&&bounds.bottom<=group.bottom,
        radius:getComputedStyle(select).borderTopLeftRadius,
        customizable:CSS.supports('appearance','base-select')};
    })()`);
    await wait(250);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: trigger.x,
      y: trigger.y,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: trigger.x,
      y: trigger.y,
      button: "left",
      clickCount: 1,
    });
    await until(
      "document.querySelector('.item-filter select').matches(':open')",
    );
    const picker = await evaluate(`(() => {
      const select=document.querySelector('.item-filter select');
      const bounds=select.closest('.item-filter').getBoundingClientRect();
      const options=Array.from(select.options).map(option=>{const r=option.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
      return {open:select.matches(':open'),options,
        viewport:options.every(r=>r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight),
        belowControl:options.every(r=>r.top>=bounds.bottom)};
    })()`);
    assert(trigger.contained && trigger.customizable);
    assert(picker.open && picker.viewport && picker.belowControl);
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await until(
      "!document.querySelector('.item-filter select').matches(':open')",
    );
    await evaluate(`(() => {
      const input = document.querySelector('.item-filter input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ' ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until("document.querySelector('.item-filter button')");
    const filter = await evaluate(`(() => {
      const group = document.querySelector('.item-filter');
      const select = group.querySelector('select');
      const input = group.querySelector('input');
      const clear = group.querySelector('button');
      const bounds = group.getBoundingClientRect();
      const text = input.getBoundingClientRect();
      const action = clear.getBoundingClientRect();
      return { firstAccess: group.firstElementChild === select,
        leftAccess: select.getBoundingClientRect().right <= text.left,
        rightClear: Math.abs(action.right - bounds.right) < 1,
        textClearance: text.right - parseFloat(getComputedStyle(input).paddingRight) <= action.left,
        clearLabel: clear.getAttribute('aria-label'), height: bounds.height };
    })()`);
    assert(
      filter.firstAccess &&
        filter.leftAccess &&
        filter.rightClear &&
        filter.textClearance,
    );
    assert.equal(filter.clearLabel, "Clear filter text");
    assert.equal(filter.height, 44);
    await evaluate("document.querySelector('.item-filter button').click()");
    await until("document.querySelectorAll('.pin-card').length >= 4");
    const geometry = await evaluate(`(() => {
      const card = document.querySelector('.pin-card');
      const lock = card.querySelector('.pin-lock');
      const name = card.querySelector('.pin-name');
      const info = card.querySelector('.pin-info');
      const first = info.querySelector('.pin-info-summary').firstElementChild;
      const before = info.getBoundingClientRect().height;
      const preview = card.querySelector('.pin-preview');
      const padding = getComputedStyle(preview).paddingTop;
      const lockParent = lock.parentNode;
      const next = lock.nextSibling;
      lock.remove();
      const without = info.getBoundingClientRect().height;
      const paddingWithout = getComputedStyle(preview).paddingTop;
      lockParent.insertBefore(lock, next);
      return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
        firstLock: first === lock, lockBeforeName: lock.getBoundingClientRect().right <= name.getBoundingClientRect().left,
        before, without, padding, paddingWithout };
    })()`);
    assert(!geometry.overflow, `Wall overflow at ${width}`);
    assert(geometry.firstLock && geometry.lockBeforeName);
    assert.equal(geometry.before, geometry.without);
    assert.equal(geometry.padding, geometry.paddingWithout);
    await evaluate("document.querySelector('.pin-open').click()");
    await until("document.querySelector('dialog[open] .detail-access')");
    const title = await evaluate(`(() => {
      const dialog = document.querySelector('dialog[open]');
      const access = dialog.querySelector('.detail-access');
      const title = dialog.querySelector('.detail-title h3');
      access.focus();
      const accessBounds = access.getBoundingClientRect();
      const titleBounds = title.getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
      return { first: dialog.querySelector('.detail-title').firstElementChild === access,
        sameRow: Math.abs(accessBounds.top + accessBounds.height / 2 - titleBounds.top - lineHeight / 2) < 1,
        actionBackground: getComputedStyle(access).backgroundColor,
        oldIcon: !!dialog.querySelector('.detail-type-icon'), focused: document.activeElement === access,
        overflow: dialog.scrollWidth > dialog.clientWidth };
    })()`);
    assert(
      title.first &&
        title.sameRow &&
        title.focused &&
        !title.oldIcon &&
        !title.overflow,
    );
    assert.notEqual(title.actionBackground, "rgba(0, 0, 0, 0)");
    const beforeEditing = await evaluate(`(() => {
      const dialog=document.querySelector('dialog[open]');
      return {height:dialog.getBoundingClientRect().height,
        preview:dialog.querySelector('.reading-preview-viewport').getBoundingClientRect().height};
    })()`);
    await evaluate(
      "document.querySelector('dialog[open] [aria-label=\"Edit details\"]').focus(); document.querySelector('dialog[open] [aria-label=\"Edit details\"]').click()",
    );
    await until(
      "document.querySelector('dialog[open] .reading-description-form textarea')",
    );
    const metadataEditing = await evaluate(`(() => {
      const dialog=document.querySelector('dialog[open]');
      const textarea=dialog.querySelector('.reading-description-form textarea');
      textarea.style.height='800px';
      const sidebar=dialog.querySelector('.reading-sidebar');
      return {height:dialog.getBoundingClientRect().height,
        preview:dialog.querySelector('.reading-preview-viewport').getBoundingClientRect().height,
        sidebar:sidebar.getBoundingClientRect().height,textarea:textarea.getBoundingClientRect().height,
        scrollable:getComputedStyle(sidebar).overflowY==='auto',
        titleReadOnly:!!dialog.querySelector('.detail-title h3'),
        formCount:dialog.querySelectorAll('form').length,
        hasName:!!dialog.querySelector('.detail-metadata-form input'),
        competingActions:!!dialog.querySelector('.detail-action-list,[aria-label="Rename pin"],[aria-label="Edit description"]'),
        accessDisabled:dialog.querySelector('.detail-access').disabled};
    })()`);
    assert.equal(metadataEditing.preview, beforeEditing.preview);
    assert(
      metadataEditing.sidebar <= 360 &&
        metadataEditing.textarea <= 180 &&
        metadataEditing.scrollable,
    );
    assert.equal(metadataEditing.height, beforeEditing.height);
    assert(
      metadataEditing.titleReadOnly &&
        metadataEditing.formCount === 1 &&
        metadataEditing.hasName &&
        !metadataEditing.competingActions &&
        metadataEditing.accessDisabled,
    );
    if (width === 1280 && process.env.ACCESS_VISUAL_SCREENSHOT) {
      await evaluate(
        "document.querySelector('.detail-metadata-form textarea').style.height=''",
      );
      const clip = await evaluate(`(() => {
        const r=document.querySelector('dialog[open]').getBoundingClientRect();
        return {x:r.x+window.scrollX,y:r.y+window.scrollY,width:r.width,height:r.height,scale:1};
      })()`);
      const image = await send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip,
      });
      await writeFile(
        process.env.ACCESS_VISUAL_SCREENSHOT,
        Buffer.from(image.data, "base64"),
      );
    }
    await evaluate(`(() => {
      const input=document.querySelector('.detail-metadata-form input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Unified name draft');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      const textarea=document.querySelector('.detail-metadata-form textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'Unified description draft');
      textarea.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await evaluate(
      "document.querySelector('.detail-metadata-form .primary').click()",
    );
    await until(
      "document.querySelector('.detail-metadata-form [role=\"alert\"]')",
    );
    assert(
      await evaluate(
        `document.querySelector('.detail-metadata-form input').value==='Unified name draft'&&document.querySelector('.detail-metadata-form textarea').value==='Unified description draft'`,
      ),
    );
    await evaluate(
      `Array.from(document.querySelector('.detail-metadata-form').querySelectorAll('button')).find(b=>b.textContent==='Cancel').click()`,
    );
    await until(
      "document.activeElement.getAttribute('aria-label')==='Edit details'",
    );
    await evaluate(
      "document.querySelector('dialog[open] .detail-access').focus(); document.querySelector('dialog[open] .detail-access').click()",
    );
    await until(
      "document.querySelector('dialog[open][aria-label=\"Access and sharing\"]')",
    );
    await evaluate(
      `Array.from(document.querySelector('dialog[open][aria-label="Access and sharing"]').querySelectorAll('button')).find(b => b.textContent === 'Make public').click()`,
    );
    await until(
      `document.querySelector('dialog[open][aria-label="Access and sharing"] [role="alert"]')?.textContent.includes('The displayed setting is unchanged')`,
    );
    await evaluate(
      `Array.from(document.querySelector('dialog[open][aria-label="Access and sharing"]').querySelectorAll('button')).find(b => b.textContent.includes('Close')).click()`,
    );
    await until("document.querySelectorAll('dialog[open]').length === 1");
    assert(
      await evaluate(
        "document.activeElement.classList.contains('detail-access')",
      ),
    );
    await evaluate(
      `document.querySelector('dialog[open] button[aria-label="Close Pin details"]').click()`,
    );
    await until("document.querySelectorAll('dialog[open]').length === 0");
    results.push({
      viewport: width,
      result: "通过",
      card: geometry,
      filter,
      focusWidths: { unfocusedWidth, accessFocusedWidth, inputFocusedWidth },
      picker,
      metadataEditing,
      detail: title,
      saveFailure:
        "只读预览拒绝保存，原私有状态保留；关闭分享对话框后焦点返回权限按钮",
    });
  }
  const publication = await evaluate(`(() => {
    const card = Array.from(document.querySelectorAll('.pin-card')).find(c => c.querySelector('.publication-badge')?.textContent === 'v3');
    const badge = card?.querySelector('.publication-badge');
    return { badge: badge?.textContent, fontSize: badge ? getComputedStyle(badge).fontSize : null, height: badge?.getBoundingClientRect().height, current: card?.querySelector('.pin-publication-version')?.textContent };
  })()`);
  assert.equal(publication.badge, "v3");
  assert.equal(publication.fontSize, "11px");
  assert.equal(publication.height, 22);
  assert(publication.current.includes("5 versions"));
  assert(
    await evaluate(
      `Array.from(document.querySelectorAll('.pin-card')).find(c => c.querySelector('.publication-badge')?.textContent === 'v1')?.querySelector('.pin-lock') === null`,
    ),
  );
  results.push({
    result: "通过",
    publicCard: "公开卡片不显示锁；访客只读图标由组件交互测试另行验证",
  });
  await writeFile(
    evidence,
    JSON.stringify(
      {
        scope: "真实 Chrome、本地只读 UI 预览；不代表生产认证或保存成功验证",
        results,
        publication,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Local visual checks passed: ${results.filter((item) => item.viewport).length} viewports; public card without lock; current v3 of 5; evidence ${evidence}`,
  );
} finally {
  if (socket?.readyState === WebSocket.OPEN)
    await send("Browser.close").catch(() => {});
  socket?.close();
  for (let i = 0; i < 50 && chrome.exitCode === null; i++) await wait(100);
  if (chrome.exitCode === null) chrome.kill();
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
