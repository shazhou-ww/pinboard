# Implementation

## Steps

### I-S01: 拆分分类详情

构想验收后按[设计说明](./ideal/Design.md)拆分为浏览器偏好、访问令牌、OAuth 授权和最近删除四个一级详情页，按授权方式而非客户端类型命名；token 与 OAuth 使用一致行式列表，保留各自数据和操作，沿用组件与样式体系，不改变普通详情弹层。

MCP endpoint 仅在 OAuth 授权页展示，不改变连接协议或 token 使用能力。

已实施：新增 [SettingsDialog](../../../../../apps/web/src/settings.tsx)，复用
[Dialog](../../../../../apps/web/src/dialog.tsx)
的原生 modal、外侧手势判定及 Escape 规则；普通弹层默认仍显示关闭按钮，只有 Settings 使用专用样式并隐藏关闭按钮。
[AccountManager](../../../../../apps/web/src/manager.tsx) 保留原状态与请求路径，
[OAuthGrants](../../../../../apps/web/src/oauth.tsx)
使用相同行式列表及独立加载、错误、空状态。沿用 BackgroundSettings、DeletedDialog 和现有 CSS 配色变量，不修改后端、认证或路由。

### I-S02: 保留操作状态与无障碍交互

接回现有偏好、token、OAuth 和回收站操作，明确类别切换、一次性密钥、错误及忙碌状态；header 仅保留 Settings，以外侧点击和 Escape 关闭，支持窄屏和键盘导航。

四个详情在分类切换时保持挂载，创建表单默认收起，草稿和密钥不因切换消失；其它分类提供返回复制入口，现有密钥显式 Dismiss 前禁止再次创建以免覆盖。OAuth 撤销与刷新状态纳入 Settings 忙碌关闭保护。最近删除仍打开专用恢复弹层，关闭后返回 Settings 的最近删除分类；最终关闭回到账号菜单入口。使用关联的 tab/tabpanel、单一活动 tab 焦点及随 640px 断点改变的方向键。

### I-S03: 验证行为兼容

补充针对性 UI 测试并运行项目检查，以浏览器核对桌面、窄屏及焦点行为。

参考现有 `dialog.test.tsx`、`oauth.test.tsx`、`background.test.tsx` 和
`preview-browser.mjs` 的组件与本地浏览器验证方式，新增
[settings.test.tsx](../../../../../apps/web/test/settings.test.tsx) 和
[settings-browser.mjs](../../../../../apps/web/test/settings-browser.mjs)，更新现有英文文案及行式状态断言。浏览器驱动缺失检查后，仅在未提交的
`.browser-tools` 安装
`playwright-core`，不改变依赖清单；脚本关闭浏览器后删除自身 profile，避免格式检查读取 Chrome 锁文件。

## Acceptance criteria

### I-AC01: 内容与操作无遗漏

以 UI 测试及现有行为对照证明：偏好仅存本浏览器，token 和 OAuth 在独立一级页面以列表管理，列表行可识别名称、权限、有效期与状态并提供逐行撤销，历史 token 只读且无完整密钥；恢复及公开内容说明仍可访问。

证据：[浏览器结果](./evidence/results.json)验证三种配色、本地提醒、有效/历史 token、逐行撤销、OAuth 刷新失败与空列表区分、恢复操作及返回路径。
[桌面 token 列表](./evidence/desktop-tokens.png)和
[桌面 OAuth 列表](./evidence/desktop-oauth.png)展示统一结构及 endpoint 归属。所有账户响应均在 localhost 浏览器路由内合成；没有读取或修改生产账户，也没有真实凭据。

### I-AC02: 切换不丢失重要状态

用组件测试及真实浏览器证明表单草稿、一次性密钥提示、错误及忙碌限制在切换时保持预期；外侧点击和 Escape 可关闭，内部点击、双向跨边界拖动及忙碌时不关闭，关闭后焦点返回入口。

`settings.test.tsx`
验证四个面板保持挂载、密钥提示、错误和忙碌反馈，以及定向键盘导航；
`dialog.test.tsx`
保留手势、Escape 与忙碌保护断言。浏览器脚本实际输入名称、17 天有效期及写权限，跨分类创建、检查密钥值、显式 Dismiss，并验证 token 与 OAuth 请求期间关闭被阻止、失败反馈保留、原生 modal 焦点约束及关闭后焦点恢复。证据中的密钥仅为不可使用的固定测试字符串，截图均在 Dismiss 后采集。

### I-AC03: 布局与检查通过

以桌面、低高度窗口及 390px /
320px 窄屏浏览器验证无横向页面溢出、内容与外侧关闭区域可达，header 只有 Settings 且无关闭按钮，并以
`pnpm check` 通过作为仓库质量证据。

2026-11-08 实测桌面 1280×900：面板 1000×680，导航 208px；详情单独
`overflow-y: auto`。390px /
320px 页面宽度分别不超过视口，横向 tabs 支持左右键及 Home/End，两种列表均可换行、操作可达，12px 外侧留白实际可以关闭。另验证 1280×480 下详情范围不越出面板。窄屏截图：[390px token](./evidence/mobile-390-tokens.png)、
[390px OAuth](./evidence/mobile-390-oauth.png)、
[320px token](./evidence/mobile-320-tokens.png)、
[320px OAuth](./evidence/mobile-320-oauth.png)。

实际验证命令与结果（仓库根目录）：

```powershell
pnpm --filter @shazhou/pinboard-web exec vitest run test\dialog.test.tsx test\settings.test.tsx test\oauth.test.tsx
# 3 个文件，24 个测试通过。
pnpm check
# format、release 校验、20/20 Turbo 任务及 CLI 离线包验证全部通过。
# web：16 个文件、229 个测试通过；worker：259 通过、1 个既有跳过。
# CLI：161 通过、2 个既有跳过；contracts：13 通过；encoding：14 通过。
pnpm --filter @shazhou/pinboard-web exec vite preview --host localhost --port 5196 --strictPort
# localhost 返回 HTTP 200，仅服务 pnpm check 产出的生产构建。
$env:SETTINGS_BUILD = "true"
$env:SETTINGS_EVIDENCE = ".silvermoon\ideas\01M6W9XRKV91J1F889HG0VA74Q\outer\inner\evidence"
node apps\web\test\settings-browser.mjs
# 17 项真实 Chrome 检查通过，无页面运行错误。
```

最终浏览器证据来自生产构建而非样稿或开发模式； `results.json`
同时记录实际加载的 JS/CSS 路径与 SHA-256，供后续发布阶段关联同一构建。这里的隔离浏览器合成账户只证明前端行为，不替代生产登录或后端集成测试；生产发布与线上验收仍由 Outer
World 负责，本阶段未创建 release tag 或部署。
