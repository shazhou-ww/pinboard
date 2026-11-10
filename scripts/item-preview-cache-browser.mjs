// Executed by the existing reading-details CDP harness, against localhost only.
export async function verifyItemPreviewCache({
  url,
  send,
  evaluate,
  wait,
  check,
  click,
  key,
  versions,
  setValue,
  answer,
  open,
  screenshot,
}) {
  const details = [];
  await evaluate(`(() => {
    sessionStorage.setItem('reading-cache-scope', 'true');
    window.__readingTest.scopeLabels = true;
  })()`);
  const pins = await evaluate("window.__readingTest.pins.map(pin => pin.cid)");
  const privatePath = `/api/pins/${pins[0]}/nodes/${pins[0]}/description`;
  const requestCount = () =>
    evaluate(
      `window.__readingTest.requests.filter(r => r.path === ${JSON.stringify(privatePath)} && r.method === 'GET').length`,
    );
  const close = async () => {
    await key("Escape");
    await wait("!document.querySelector('dialog[open]')");
  };
  const root = async (cid) => {
    await evaluate(
      `document.querySelector(${JSON.stringify(`[data-detail-key="pin:${cid}"]`)}).click()`,
    );
    await wait("document.querySelector('dialog[open] .reading-content')");
  };
  const beginMonitor = async () => {
    await evaluate(`(() => {
      const state = window.__cacheMonitor = { samples: [] };
      const sample = () => {
        const content = document.querySelector('dialog[open] .reading-content');
        if (!content) return;
        state.samples.push({
          at: performance.now(),
          text: content.textContent.trim(),
          loading: content.textContent.includes('Loading content...'),
          busy: content.querySelector('[aria-busy]')?.getAttribute('aria-busy')
        });
      };
      state.observer = new MutationObserver(sample);
      state.observer.observe(document.body, {subtree:true, childList:true, characterData:true});
      state.timer = setInterval(sample, 16);
      sample();
    })()`);
  };
  const endMonitor = async (label) => {
    const samples = await evaluate(`(() => {
      const state = window.__cacheMonitor;
      state.observer.disconnect();
      clearInterval(state.timer);
      return state.samples;
    })()`);
    details.push({ label, samples });
    await check(
      label,
      `window.__cacheMonitor.samples.length > 20 && window.__cacheMonitor.samples.every(s => !s.loading && s.busy === 'false' && s.text.length > 0)`,
    );
  };
  const waitDescription = async (path) => {
    await wait(
      `window.__readingTest.requests.filter(r => r.path === ${JSON.stringify(path)} && r.method === 'GET').at(-1)?.finishedAt !== undefined`,
    );
  };

  await root(pins[0]);
  await wait(
    `document.querySelector('dialog[open]').textContent.includes('Root A root synthetic description')`,
  );
  await close();
  const before = await requestCount();
  await evaluate("window.__readingTest.delayDescription = 1500");
  await beginMonitor();
  await root(pins[0]);
  await check(
    "私有详情重开：后台 GET 尚未完成，旧预览与说明立即可见",
    `document.querySelector('dialog[open]').textContent.includes('Root A root synthetic description') && document.querySelector('dialog[open] .reading-content').textContent.includes('Root A root synthetic preview v1') && window.__readingTest.requests.filter(r => r.path === ${JSON.stringify(privatePath)} && r.method === 'GET').at(-1).finishedAt === undefined`,
  );
  await screenshot("private-cache-during-refresh.png");
  await waitDescription(privatePath);
  await endMonitor(
    "私有详情 1500ms 后台更新全过程没有 Loading content/空白回退",
  );
  const after = await requestCount();
  await check(
    "每次重开有真实授权重新验证且不额外重复发起详情 GET",
    `${after} === ${before} + 1`,
  );
  await close();
  await root(pins[1]);
  await check(
    "切换私有根时不显示另一根的完整描述或预览",
    `!document.querySelector('dialog[open]').textContent.includes('Root A root synthetic description') && !document.querySelector('dialog[open] .reading-content').textContent.includes('Root A root synthetic preview')`,
  );
  const secondPath = `/api/pins/${pins[1]}/nodes/${pins[1]}/description`;
  await waitDescription(secondPath);
  await check(
    "不同私有根完成验证后显示各自内容",
    `document.querySelector('dialog[open]').textContent.includes('Root B root synthetic description')`,
  );
  await close();

  await evaluate(`(() => {
    const state = window.__readingTest;
    state.nodeDescriptions[${JSON.stringify(`${pins[0]}/${pins[0]}`)}] = {text:'External v2', version:2};
  })()`);
  await root(pins[0]);
  await click("Edit details");
  await setValue("dialog[open] textarea", "Draft remains based on v1");
  await waitDescription(privatePath);
  await check(
    "后台更新到 v2 时正在编辑的草稿不被覆盖",
    `document.querySelector('dialog[open] textarea').value === 'Draft remains based on v1' && document.querySelector('dialog[open] .reading-content').textContent.includes('preview v2')`,
  );
  await click("Save changes");
  await wait("document.querySelector('dialog[open] [role=alert]')");
  await check(
    "刷新后保存仍使用原草稿 CAS v1，409 明示且保留草稿",
    `window.__readingTest.requests.filter(r => r.method === 'PUT').at(-1).body.expectedVersion === 1 && document.querySelector('dialog[open] textarea').value === 'Draft remains based on v1' && document.querySelector('dialog[open]').textContent.includes('Version conflict')`,
  );
  await evaluate("window.__readingTest.delayDescription = 0");
  await click("Retry description");
  await answer(false);
  await check(
    "取消重试丢弃确认仍保留草稿",
    `document.querySelector('dialog[open] textarea').value === 'Draft remains based on v1'`,
  );
  await click("Retry description");
  await answer(true);
  await wait("!document.querySelector('dialog[open] textarea')");
  await click("Edit details");
  await setValue("dialog[open] textarea", "Saved v3");
  await click("Save changes");
  await wait("!document.querySelector('dialog[open] textarea')");
  await check(
    "明确丢弃后重新编辑/保存显示 PUT 新响应 v3",
    `document.querySelector('dialog[open]').textContent.includes('Saved v3') && document.querySelector('dialog[open] .reading-content').textContent.includes('preview v3') && window.__readingTest.requests.filter(r => r.method === 'PUT').at(-1).body.expectedVersion === 2`,
  );
  await close();
  await evaluate("window.__readingTest.delayDescription = 1500");
  await root(pins[0]);
  await click("Edit details");
  await setValue("dialog[open] textarea", "PUT wins v4");
  await click("Save changes");
  await wait("!document.querySelector('dialog[open] textarea')");
  await waitDescription(privatePath);
  await check(
    "PUT v4 比旧 GET v3 先完成，迟到 GET 不覆盖保存结果",
    `document.querySelector('dialog[open]').textContent.includes('PUT wins v4') && document.querySelector('dialog[open] .reading-content').textContent.includes('preview v4')`,
  );
  await close();
  await evaluate("window.__readingTest.descriptionFailure = true");
  await root(pins[0]);
  await wait(
    `document.querySelector('dialog[open]').textContent.includes('Fixture description unavailable')`,
  );
  await check(
    "真实浏览器后台 503 保留缓存预览并明确提供重试",
    `document.querySelector('dialog[open] .reading-content').textContent.includes('preview v4') && document.querySelector('dialog[open]').textContent.includes('Retry description')`,
  );
  await evaluate(
    `window.__readingTest.descriptionFailure = false; window.__readingTest.delayDescription = 0`,
  );
  await click("Retry description");
  await wait(`!document.querySelector('dialog[open] [role=alert]')`);
  await check(
    "后台失败后的重试实际恢复描述",
    `document.querySelector('dialog[open]').textContent.includes('PUT wins v4')`,
  );
  await close();

  await evaluate(`(async () => {
    window.__readingTest.previewKind = 'directory';
    window.__readingTest.delayDescription = 300;
    const source = await (await fetch('/src/main.tsx')).text();
    const paths = [...source.matchAll(/from "([^"]+)"/g)].map(match => match[1]);
    const reactPath = paths.find(path => /\\/react\\.js\\?/.test(path));
    const domPath = paths.find(path => /react-dom_client\\.js\\?/.test(path));
    const [React, DOM, nodes, clients] = await Promise.all([
      import(reactPath), import(domPath), import('/src/node-description.tsx'), import('/src/description-client.ts')
    ]);
    const client = window.__cacheNodeClient = new clients.DescriptionClient(window.__readingTest.accountId);
    window.__cacheNodeRoots = [];
    const pins = [...window.__readingTest.pins, window.__readingTest.pins[0]];
    for (const [index, pin] of pins.entries()) {
      const element = document.createElement('div');
      element.id = 'cache-node-' + index;
      document.body.append(element);
      const root = DOM.default.createRoot(element);
      root.render(React.default.createElement(nodes.NodeDescriptionEditor, {rootCid:pin.cid, client}));
      window.__cacheNodeRoots.push({root, element});
    }
  })()`);
  await wait(
    "document.querySelectorAll('[id^=cache-node-] input').length === 3",
  );
  await wait(
    "document.querySelectorAll('[id^=cache-node-] .preview-directory').length === 3",
  );
  await check(
    "真实目录预览及独立/嵌套高级节点读者使用当前组件，无恢复详情已移除按钮",
    "document.querySelectorAll('[id^=cache-node-] .preview-directory').length === 3 && !document.querySelector('.detail-advanced')",
  );
  for (const index of [0, 1, 2]) {
    await setValue(
      `#cache-node-${index} input`,
      await evaluate("window.__readingTest.sharedNode"),
    );
    await evaluate(
      `document.querySelector('#cache-node-${index} form').requestSubmit()`,
    );
  }
  await wait(
    `document.querySelector('#cache-node-0').textContent.includes('Root A child') && document.querySelector('#cache-node-1').textContent.includes('Root B child') && document.querySelector('#cache-node-2').textContent.includes('Root A child')`,
  );
  await check(
    "实际独立高级读者：同一 child CID 在两个根内分别显示，缓存不串根/节点",
    `!document.querySelector('#cache-node-0').textContent.includes('Root B child') && !document.querySelector('#cache-node-1').textContent.includes('Root A child') && !document.querySelector('#cache-node-0').textContent.includes('PUT wins v4')`,
  );
  await evaluate(
    `document.querySelector('#cache-node-0 .node-description-editor > button').click()`,
  );
  await wait("document.querySelector('#cache-node-0 textarea')");
  await setValue("#cache-node-0 textarea", "Only root A child changed");
  await evaluate(
    `document.querySelector('#cache-node-0 textarea').closest('form').requestSubmit()`,
  );
  await wait("!document.querySelector('#cache-node-0 textarea')");
  await check(
    "高级读者保存 child 不串写同 CID 的另一根",
    `document.querySelector('#cache-node-0').textContent.includes('Only root A child changed') && document.querySelector('#cache-node-1').textContent.includes('Root B child synthetic description')`,
  );
  await check(
    "同一 root/child 的另一实际读者同步收到 PUT，无旧描述残留",
    "document.querySelector('#cache-node-2').textContent.includes('Only root A child changed')",
  );
  await evaluate(`(() => {
    for (const {root, element} of window.__cacheNodeRoots) {root.unmount(); element.remove();}
    window.__cacheNodeClient.dispose();
    window.__readingTest.previewKind = 'text';
    window.__readingTest.delayDescription = 0;
  })()`);

  await open(true);
  await wait(
    `document.querySelector('dialog[open]').textContent.includes('reading-fixture Public snapshot v3')`,
  );
  await versions();
  await click("View v1");
  await wait(
    `document.querySelector('dialog[open]').textContent.includes('reading-fixture Public snapshot v1')`,
  );
  await close();
  await evaluate("window.__readingTest.delayDescription = 1500");
  await beginMonitor();
  await open(true);
  const publicationPath = `/api/public/publications/reading-fixture/versions/3/nodes/${await evaluate("window.__readingTest.revisions[2].cid")}/description`;
  await check(
    "发布 current v3 重开从独立缓存立即读取而不是 current 字面键",
    `document.querySelector('dialog[open]').textContent.includes('reading-fixture Public snapshot v3') && window.__readingTest.requests.filter(r => r.path === ${JSON.stringify(publicationPath)}).at(-1).finishedAt === undefined`,
  );
  await screenshot("publication-cache-during-refresh.png");
  await waitDescription(publicationPath);
  await endMonitor("发布详情 1500ms 后台更新全过程已有预览持续可见");
  await versions();
  await click("View v1");
  await check(
    "切换已缓存 v1 不显示 v3，后台请求使用明确 revision",
    `document.querySelector('dialog[open]').textContent.includes('reading-fixture Public snapshot v1') && !document.querySelector('dialog[open]').textContent.includes('Public snapshot v3') && window.__readingTest.requests.filter(r=>r.path.endsWith('/description')).at(-1).path.includes('/versions/1/')`,
  );
  await close();
  await open(true, true);
  await check(
    "另一 publication 的同 CID/v1 不复用前一 publication 的用户快照",
    `!document.querySelector('dialog[open]').textContent.includes('reading-fixture Public snapshot v1')`,
  );
  const singlePath = `/api/public/publications/single-fixture/versions/1/nodes/${await evaluate("window.__readingTest.revisions[0].cid")}/description`;
  await waitDescription(singlePath);
  await check(
    "相同 CID 与 revision 也按 publication ID 分离，并保留只读",
    `document.querySelector('dialog[open]').textContent.includes('single-fixture Public snapshot v1') && !document.querySelector('dialog[open] textarea') && !Array.from(document.querySelectorAll('dialog[open] button')).some(button=>button.textContent.trim()==='Edit description')`,
  );
  await close();
  details.push({
    label: "account-a-request-log",
    requests: await evaluate("window.__readingTest.requests"),
  });
  await evaluate(
    "sessionStorage.setItem('reading-fixture-account', 'synthetic-b')",
  );
  await send("Page.reload");
  await wait("document.querySelectorAll('.pin-card').length === 4");
  await evaluate("window.__readingTest.delayDescription = 1500");
  await root(pins[0]);
  await check(
    "真实账号重载路径：另一账号未验证前不显示前账号完整说明或预览",
    `window.__readingTest.accountId === 'synthetic-b' && !document.querySelector('dialog[open]').textContent.includes('PUT wins v4') && !document.querySelector('dialog[open] .reading-content').textContent.includes('Root A root synthetic preview v4')`,
  );
  await waitDescription(privatePath);
  await check(
    "另一账号响应完成后显示其自己的私有说明",
    `document.querySelector('dialog[open]').textContent.includes('Root A root synthetic-b description')`,
  );
  await close();
  await beginMonitor();
  await root(pins[0]);
  await waitDescription(privatePath);
  await endMonitor("另一账号自己的缓存重开同样保留预览而不串前账号");
  await close();

  const probes = await evaluate(`(async () => {
    const paths = ['/api/bootstrap', ${JSON.stringify(privatePath)}, '/p/reading-fixture/v/1'];
    return Promise.all(paths.map(async path => {
      const response = await window.__readingTest.networkFetch(path);
      return {path, url:response.url, status:response.status, contentType:response.headers.get('content-type'), text:(await response.text()).slice(0,300)};
    }));
  })()`);
  details.push({ label: "real-same-origin-network-probes", probes });
  await check(
    "未经 fixture 拦截的同源 Worker bootstrap/受保护 API 与 SPA 路由真实响应",
    JSON.stringify(
      probes.length === 3 &&
        probes[0].status === 200 &&
        probes[1].status === 401 &&
        probes[2].status === 200 &&
        probes.every(
          (probe) => new URL(probe.url).origin === new URL(url).origin,
        ) &&
        probes[2].contentType.includes("text/html"),
    ),
  );
  await check(
    "所有 fixture API 请求保持同源 /api/*，无跨源详情请求",
    `window.__readingTest.requests.every(r=>r.origin === location.origin && r.path.startsWith('/api/')) && window.__readingTest.requests.filter(r=>r.path.endsWith('/description')).every(r=>!r.path.includes('/versions/undefined/') && !r.path.includes('/versions/current/'))`,
  );
  details.push({
    label: "account-b-request-log",
    requests: await evaluate("window.__readingTest.requests"),
  });
  await send("Page.navigate", {
    url: new URL("/p/reading-fixture/v/1", url).href,
  });
  await wait(
    "document.querySelector('.publication-page .node-description-editor input')",
  );
  await wait(
    `document.querySelector('.publication-page').textContent.includes('reading-fixture Public snapshot v1')`,
  );
  await setValue(
    ".publication-page input",
    await evaluate("window.__readingTest.sharedNode"),
  );
  await evaluate(
    "document.querySelector('.publication-page form').requestSubmit()",
  );
  await wait(
    `document.querySelector('.publication-page').textContent.includes('Public snapshot v1 child')`,
  );
  await check(
    "真实固定发布页面读取可达 child，保持 revision/root/node 及只读边界",
    `window.__readingTest.requests.filter(r=>r.path.endsWith('/description')).at(-1).path.includes('/versions/1/nodes/' + window.__readingTest.sharedNode + '/') && !document.querySelector('.publication-page textarea')`,
  );
  await check(
    "真实静态资源和固定页面由同一 Vite origin 返回",
    `document.querySelector('script[src]').src.startsWith(location.origin + '/') && performance.getEntriesByType('resource').filter(r=>['script','css','link'].includes(r.initiatorType)).every(r=>new URL(r.name).origin === location.origin)`,
  );
  await evaluate(
    `sessionStorage.removeItem('reading-fixture-account'); sessionStorage.removeItem('reading-cache-scope')`,
  );
  return details;
}
