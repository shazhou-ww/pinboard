# Implementation evidence

## 范围与结果

本证据对应已接受的
`idealRevision 1ddd2824faf8112ae7c1078d1aec26c550d58de9`，基线为
`2dc3c2042ae3d8e80ec14efd4d585c3a019c5136`。实现没有修改 Ideal World、
`events.jsonl` 或 Deployment
contract；没有提交、推送、发布标签、部署或生产数据操作。本文件与 ledger 的完成记录不是门限审批。

### I-S01 / I-AC01：单一规范化协议

- `packages/contracts/src/index.ts` 定义原始 `contentType: string | null` 与
  `PreviewMaterial`，保留 version/status/truncated/reason/可选可靠 size。
  `src/preview.ts`
  为共享运行时校验：ready 必须有物料，其余状态必须为 null，空物料不得 truncated；旧 content/mediaType 结构、外站图片 URL、非法尺寸和目录深度被拒绝。
- `apps/worker/src/previews.ts` 保留 JPEG/PNG/WebP/PDF 的源 MIME，文本源使用
  `text/plain`，目录使用
  `inode/directory`，非文件 IPLD 未知类型保留 null。成功、已识别后的失败、延迟和租约耗尽保留可知源元数据。PDF 模块没有改动；仍只输出像素，由现有编排构造 WebP/CID/URL。
- 私有单项、批量、公开 Publication 与节点描述继续使用原有外层包装和授权规则；D1 单项/批量读取、前端批量、Publication、节点读取/保存共享同一校验。CLI 没有独立的旧 preview 解码器；其既有测试与打包检查仍纳入总检查。

### I-S02 / I-AC02：共享展示

- `apps/web/src/pin-preview.tsx`
  按物料 kind 选择渲染；仅 PDF 图片采用悬浮纸页。普通图片继续原裁切外观，未知原类型和模拟视频类型仍展示有效图片。无物料和图片加载失败使用 Phosphor 类型图标，不显示原因、红色提示或重试按钮。
- `styles.css`
  将 PDF 卡片信息条置于独立自适应行，纸页内部再分标识行与图片行；横竖页均保持真实比例，左上 PDF 标识不覆盖正文，Publication 标记保持右上独立。PDF 卡片采用 280px 最小高度，并明确宽度为 grid
  track 的 100%，防止首选宽高比反推超出轨道的宽度；普通图片卡片不变。
- 图片失败只存在于组件内存，CID/URL 变化重建组件，成功 load 可恢复，不写入缓存。API 请求/协议错误不转成成功图标。节点保存的 409 保留编辑数据；后台轮询的 500/网络失败同样保留有效描述、编辑表单和未保存草稿。401/403/404、非法 preview 联合与损坏 JSON 清除旧展示，保留显式错误处理。
- 开发样例改为规范化结构；README、PDF 与 Publication 文档同步更新。

### I-S03 / I-AC03：一次性切换与安全边界

- `PREVIEW_VERSION`
  从 2 升为 3，复用现有 lazy/cron 重建；读取只选择当前生成版本。测试证明 v2 原描述不被转换或混读，新的 pending/ready 独立产生，旧图片引用仍遵守已有事务/保留期回收机制。
- IndexedDB 数据库版本从 1 升为 2，升级时重建描述 store，一次清除全部旧账户描述，不保留旧结构适配器。账户隔离、TTL、预算、授权失效与 blob 不持久化继续通过测试。
- 没有 schema
  migration、新资源、依赖清单变化，未删除或重写源内容、CAR、Pin、Publication、身份和授权数据。

## 已执行验证

环境：Windows，Node.js `v24.12.0`、pnpm
`11.22.0`；使用仓库锁定依赖，未升级业务依赖。

| 命令                                                                                                                                                         | 结果                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @shazhou/pinboard-contracts exec vitest run --coverage`                                                                                       | 2 文件、13 测试通过；语句/分支/函数/行覆盖率均 100%                                                                                                            |
| `pnpm --filter @shazhou/pinboard-web exec vitest run test\preview.test.tsx test\preview-client.test.ts test\dev-preview.test.ts`                             | 3 文件、71 测试通过                                                                                                                                            |
| `pnpm --filter @shazhou/pinboard-worker exec vitest run test\previews.test.ts test\pdf-runtime.test.ts test\image-runtime.test.ts test\publications.test.ts` | 4 文件、84 测试通过；含真实 workerd/PDFium/图像编码、私有/公开/节点 API 一致性及授权/引用回收回归                                                              |
| `pnpm --filter @shazhou/pinboard-web lint` 与 Worker `lint` / `typecheck`                                                                                    | 通过                                                                                                                                                           |
| `pnpm --filter @shazhou/pinboard-web build` 与 Worker `build`                                                                                                | 通过；Worker 为现有 `wrangler deploy --dry-run`，不是部署                                                                                                      |
| `node apps\web\test\preview-browser.mjs`                                                                                                                     | 本地真实 Chrome 41 项浏览器检查通过，含 viewport/track 边界及 pending→草稿→失败的轮询回归，见下节                                                              |
| `pnpm check`                                                                                                                                                 | 退出 0；format/release checks、20 个 Turbo lint/typecheck/test/build 任务和实际 CLI tarball 离线安装执行测试全部通过；workspace 测试共 665 通过、3 个既有 skip |
| `silvermoon check --worktree --audience agent` 与 `git diff --check`                                                                                         | 最终候选退出 0；未 stage、commit 或记录任何 lifecycle event                                                                                                    |

Worker 总覆盖率：语句 95.55%、分支 90.16%、函数 97.97%、行 96.65%，保留现有门限。

最初直接运行 Worker 针对性测试时缺少本地预编译 WASM，执行现有
`pnpm --filter @shazhou/pinboard-worker preview:assets`
后重跑通过。完整检查过程中修复了本次新增阴影未使用设计 token 的问题及新增代码 lint 问题。另一次检查遇到既有 CLI 测试删除
`.retrieval-tests` 与并发 ESLint 扫描竞争；单独 CLI
lint 通过后使用相同任务缓存重跑，不修改 CLI 或降低门限。

## 浏览器证明与边界

使用 `apps/worker/test/preview-browser.mjs` 启动内存 Miniflare
D1/R2 与本地 Vite。固定图片来自仓库现有夹具；横竖 PDF 是会话自有合成图形文件，由实际 Worker/PDFium 生成首页缩略图，Publication 和节点描述经过实际本地 API。身份由测试代理提供；未使用真实账户、生产凭证或线上数据。

- 1280×900：横竖 Pin 与 Publication；普通、悬停展开、键盘聚焦展开。
- 390×844 和 320×720：触屏信息条常展开；断言整页、标识和信息条边界，图片宽高比与原缩略图一致，Publication 标记不遮盖 PDF 标识。同时断言 document/body
  scrollWidth 不超过 clientWidth，卡片不超过 grid
  track、viewport，纸页与信息条都不超出卡片。
- 原仓库目前只提供浅色 palette，`color-scheme: light`。已实际测试暗色 OS 偏好；另以浏览器注入深色设计 token 作明确标注的深色表面压力测试，确认原图没有滤镜、变色或裁切。**没有声称已新增或验收产品级暗色主题。**
- Pin/Publication 图片请求被 Playwright 真正中止时回 PDF 图标，没有失败文案；私有/公开节点同样验证 error/load 事件恢复。新物料 CID/URL 恢复已验证。
- 同一实际缩略图配 `image/jpeg`、null、`video/mp4`
  的检查是前端物料/类型组合模拟，不代表新增视频解码。API
  200 非法协议及 401/403/404 响应也是浏览器拦截模拟，证明显式错误展示而不是成功 fallback；服务端授权由上述真实 API 测试覆盖。
- 本地集成浏览器工具无法连接 loopback，改用已安装 Chrome 与临时
  `playwright-core`
  驱动完成检查；驱动、profile 和中间文件已在检查后清理，不加入业务依赖。

### 独立审查修正

先前 34 项结果只证明图片在纸页容器内，未证明卡片本身在 viewport 内。父 Agent 指出 320px 时卡片被
`aspect-ratio` 与 `min-height`
拉宽，以及节点轮询临时失败清空编辑表单的问题。本轮已修正并替换所有浏览器结果和截图；本次结果不是沿用先前存在缺口的无溢出结论。

| 真实浏览器测量                            | 390px 触屏 | 320px 触屏 |
| ----------------------------------------- | ---------- | ---------- |
| document / body scrollWidth               | 390 / 390  | 320 / 320  |
| 三张 PDF 卡片各自的宽度 / grid track 宽度 | 346 / 346  | 276 / 276  |
| 卡片右边界 / 信息条右边界                 | 368 / 367  | 298 / 297  |

新增七项节点后台轮询回归先返回合法 pending 描述，在 textarea 输入未保存草稿后，才使下一次真实轮询失败：500、网络中断均保留可见表单和原草稿；401、403、404、ready+null、损坏 JSON 则清除旧描述。原有保存 409 保留、保存 403 清除和公开 API 非法协议/授权错误检查继续通过。测试初始读取会被 React 开发 Strict
Mode 重放，结果记录两次初始读取与一次失败轮询，不把初始请求重放误当成后台失败。

证据：

- [逐项几何与断言结果](./browser-evidence/browser-results.json)
- [桌面横竖纸页与键盘展开](./browser-evidence/desktop-paper.png)
- [窄屏触屏](./browser-evidence/narrow-touch.png)
- [320px 触屏与完整卡片宽度](./browser-evidence/small-320px-touch.png)
- [深色表面模拟，不是新增主题](./browser-evidence/dark-surface-fixture.png)
- [真实图片请求中止后的正常图标封面](./browser-evidence/image-load-fallback.png)

### 可复现设置

从仓库根目录运行，下列命令只用于本地合成夹具：

```powershell
pnpm --filter @shazhou/pinboard-contracts build
pnpm --filter @shazhou/pinboard-web build
pnpm --filter @shazhou/pinboard-worker build
node --experimental-strip-types apps\worker\test\preview-browser.mjs
```

等待 `PREVIEW_BROWSER_READY`，打开 `http://127.0.0.1:5191`，过滤
`paper`；夹具还会打印新建本地 Publication 的 `/p/:id`
URL。卡片点击可进入节点详情。这是本地测试服务，验证结束后关闭；交付时没有遗留后台服务。

需要自动重放且未安装 Playwright 时，可按本次缺失工具后的实际做法安装临时驱动：

```powershell
npm install --prefix .browser-tools --no-package-lock --no-save playwright-core
node apps\web\test\preview-browser.mjs
Remove-Item -LiteralPath .browser-tools -Recurse -Force
```

默认使用 `C:\Program Files\Google\Chrome\Application\chrome.exe`。可设置
`BROWSER_EXECUTABLE`、`PLAYWRIGHT_MODULE` 与
`PREVIEW_EVIDENCE`；输出默认位于仓库内
`.browser-tools\evidence`。断言脚本拒绝非 loopback 目标。不要把上述本地结果当成 deployment
acceptance。

## 父会话独立复核

父会话检查了共享契约与校验、Worker 生成/引用路径、三处前端入口、缓存升级和纸页布局，确认接受的 Ideal
World 未变。首次复核没有直接通过：发现 320px 视口的纸页右界达到 394.33px，以及节点后台轮询的临时请求错误会清除正在编辑的表单，已退回子代理修正。

修正后，父会话独立运行 `pnpm check`
退出 0，并重新启动隔离 Worker 夹具、运行真实 Chrome 检查，41 项断言全部通过。复核确认 320px 下 document/body 宽度均为 320px、卡片右界为 298px，节点 500/网络错误保留草稿，401/403/404 和非法协议清除旧数据；并目视检查了更新后的窄屏截图。实现验收无剩余阻断项，生产表现仍须在部署阶段另行证明。

独立重放将临时浏览器驱动与输出放在会话目录，未改变项目依赖；使用外置
`PLAYWRIGHT_MODULE` 和 `PREVIEW_EVIDENCE` 时仍需先创建本地 `.browser-tools`
临时目录供 Chrome 使用。验证结束后已停止隔离服务；临时目录不属于交付文件。
