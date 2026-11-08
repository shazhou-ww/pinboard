# 主体世界验证证据

## 范围与实现

普通 Pin 与 Publication 使用同一阅读骨架：宽详情容器、内容主栏、说明与事实辅助栏，Share/Download 主动作、More 管理任务与折叠高级查询。私人说明默认只读，显式编辑保留 expectedVersion 并发保护、取消恢复原文与未保存关闭确认；公开说明始终是选中版本的只读快照。

Publication 显式区分正在查看、公开 current 与最新版本；选择历史不写入，固定版本链接、CID 和下载 URL 使用确定的选中 revision
CID。独立 Make current 确认使用真实 sequence，独立发布任务优先显示 owned
Pin 名称与内容事实。关联与转换入口保持不同的公开告知与操作路径，不新增管理 API。

关键源码：[阅读与说明](../../../../../apps/web/src/node-description.tsx)、
[Pin 详情](../../../../../apps/web/src/manager.tsx)、
[Publication 详情](../../../../../apps/web/src/publications.tsx)、
[菜单](../../../../../apps/web/src/detail-actions.tsx)、
[弹窗焦点与关闭](../../../../../apps/web/src/dialog.tsx)。服务端 API、授权、存储、公共页面、预览资源 URL 校验与 migration 均未修改。

## 可重复验证

- `pnpm check`：仓库格式、release 校验、全部 workspace
  lint/typecheck/test/build、CLI 包安装及实际调用检查。结果以同步候选的绿色 CI 与本机执行为准。本机最终执行通过：20/20
  Turbo 任务成功（12 个缓存命中）；Web 245、Worker 284、CLI 161、contracts
  13、encoding 14 测试通过，另有既有 3 项平台测试跳过；release 校验 45 项与 CLI
  tarball 1 项通过。
- `pnpm --filter @shazhou/pinboard-web exec vitest run test\reading-details.test.tsx test\publications.test.tsx test\dialog.test.tsx test\preview.test.tsx test\download.test.tsx test\palette.test.ts --config vitest.config.ts`：6 文件、77 测试通过，包括新增 8 个阅读/菜单/未保存确认测试。
- 启动现有 Web Vite 开发服务器后运行：
  `node scripts\reading-details-browser.mjs http://localhost:5178 .silvermoon\ideas\01M6X25VPFZY240EYF6EXJP7Q3\outer\inner\evidence`。使用现有 Chrome、本机原生 CDP/WebSocket，48 项断言通过，无新增依赖或包版本变化。harness 限制目标为 localhost/127.0.0.1，隔离 profile 在仓库内创建并于退出清理。

本机首次完整检查暴露新增 CSS 使用字面颜色违反既有主题契约，已改为既有主题 tokens。浏览器实测发现 disabled 控件时原生 Escape 与 Tab 可绕开预期交互，已加入关闭保护、文档级 Escape 补偿、显式 Tab 循环及刷新后的稳定卡片焦点返回；最终行为回归覆盖这些修复。

## 浏览器证据

全部数据、账户名称、说明与预览内容都是合成样本，真实 React/Vite 应用在隔离 Chromium 内运行；仅 API 响应由
[fixture](../../../../../scripts/reading-details-fixture.mjs) 模拟。
[执行脚本](../../../../../scripts/reading-details-browser.mjs)
是可重跑证明，不是生产功能或认证替代品。

- [48 项断言清单](./evidence/browser-result.json)。
- 桌面 1440×960：[普通 Pin](./evidence/pin-desktop.png)、
  [Publication](./evidence/publication-desktop.png)。
- 390×844：[Pin](./evidence/pin-390.png)、
  [Publication](./evidence/publication-390.png)、
  [Pin 滚动后](./evidence/pin-390-scrolled.png)、
  [Publication 滚动后](./evidence/publication-390-scrolled.png)。
- 320×844：[Pin](./evidence/pin-320.png)、
  [Publication](./evidence/publication-320.png)、
  [Pin 滚动后](./evidence/pin-320-scrolled.png)、
  [Publication 滚动后](./evidence/publication-320-scrolled.png)。

断言覆盖：两类详情的默认阅读层级；空说明、长名称与 CID；单版本与 current v3
/ 五版本；仅浏览 v5 不写入；v5 固定分享/下载 URL 与 v3 跟随身份分离；回滚取消/确认与 sequence
CAS；说明冲突保留草稿、保存/取消/未保存关闭/写入禁止关闭；历史与说明失败重试；版本切换迟到响应隔离；发布失败保留 Pin 与选择；关联与转换独立入口；最近删除取消不写入；连续十次 Tab、菜单 Escape、焦点返回；两个窄屏的触屏 Share、单列与滚动后主动作；文本、目录、图片/PDF 有限预览说明与 pending/failed/unsupported 状态。

## 既有真实语义回归与局限

完整仓库检查保留
[Worker publication 测试](../../../../../apps/worker/test/publications.test.ts)
对原子转换、无重复 trash、快照/NOP、事务时说明、授权与可达性、历史/回滚/恢复的真实D1/HTTP 回归；[上传/发布测试](../../../../../apps/web/test/publications.test.tsx)
证明上传完成后发布失败保留源 Pin 与重试身份。CLI 和 Worker 检查继续验证实际下载、目录/CAR、转换部分成功与恢复，不把本地 fixture 的模拟写入当成存储语义证据。

浏览器下载断言检查固定 URL/CID 绑定，不声称下载真实生产字节。图片/PDF 使用合成缩略材料，未增加原图查看器、完整 PDF 阅读器或目录导航。生产 authenticated 详情、公开链接与真实下载验收留给
[Deployment.md](../Deployment.md)；当前没有取得或制造生产认证会话，不能标为通过。实施候选提交不等于 acceptInner，不创建 tag、不部署或修改生产数据。
