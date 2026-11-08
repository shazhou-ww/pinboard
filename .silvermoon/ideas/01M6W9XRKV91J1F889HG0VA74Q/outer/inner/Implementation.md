# Implementation

本轮落实已获批准的[最新样稿](./ideal/settings-table.mock.html)及[设计说明](./ideal/Design.md)，不是上一轮已上线版本的重复验收。旧目录
`evidence/` 只保留首轮历史证据，不证明本轮布局；本轮使用
`evidence-refinement/`。不修改 Ideal World、后端、认证、协议或 Outer
World，也不发布生产。

## Steps

### I-S01: 拆分分类详情

采用 General、Access tokens、OAuth authorizations、Recently
deleted 四分类，标题 Pinboard
Settings 与右上圆形关闭图标。General 集中本浏览器偏好、公开提醒、MCP
endpoint 与配置/安全/历史解释；授权页只有紧凑工具栏、语义表格及计数。导航高亮方角，配色色块桌面 144px
/ 窄屏 108px。

### I-S02: 保留操作状态与无障碍交互

两种授权独立保留搜索与默认关闭的 Show inactive
authorizations。搜索包含名称/权限而非密钥；筛选框内图标展开圆角 switch，关闭后仍高亮；外侧收起，Escape 先关闭 popup 并返回按钮焦点，再次可关闭 Settings。token 默认查 active，打开无效筛选原子获取 active/history 并按 id 去重，陈旧请求不得覆盖最新状态；任一请求失败呈现错误而非空列表。

创建 token 独立小弹层，不压缩表格，保留六权限与 1–365 天范围。草稿、一次性密钥及错误跨分类保留，未 Dismiss 密钥禁止重复创建。有效及尚未过期的待兑换 OAuth 可撤销；过期（包括 code）和已撤销记录只读。所有关闭入口保留 busy 保护及焦点恢复。回收站沿用独立恢复弹层及返回分类、30 天恢复/七天清理/公开副本说明。

### I-S03: 验证行为兼容

补充状态边界、组合搜索筛选、active/history 任一失败与去重、可访问图标及 endpoint 归属组件测试；以真实 Chrome 加载生产构建并合成本地 API 验证 1280/390/320px、足量记录滚动后 sticky 表头和工具栏位置、popup 边界/焦点、竞态、创建/草稿/密钥、撤销及恢复。运行
`pnpm check`；所有 I-* 仅据本轮新证据重新勾选。

## Acceptance criteria

### I-AC01: 内容与操作无遗漏

组件测试与本地真实浏览器证明 General 归属、授权语义表格、搜索加无效记录、无效行无撤销、真实端点及偏好/恢复能力。证据只涵盖前端合成账户，不声称生产登录、服务端联调或无限历史保留。

### I-AC02: 切换不丢失重要状态

真实浏览器验证独立创建弹层草稿及一次性密钥跨分类保留、未披露密钥不覆盖、创建及 OAuth 错误/忙碌状态、popup
Escape 优先与焦点返回、所有关闭 busy 保护、回收站返回及 Settings 关闭回入口。

### I-AC03: 布局与检查通过

真实 Chrome 在桌面和 390/320px 无页面横向溢出，表格内可横向滚动，足量数据垂直滚动后表头及工具栏位置不变；General 色块高度和 popup 边界满足样稿。`pnpm check`
通过，生产构建 JS/CSS SHA-256 与新截图/结果保存在 `evidence-refinement/`。

## 本轮验证结果

2026-11-08 完成新一轮验证：

- `pnpm --filter @shazhou/pinboard-web exec vitest run test\dialog.test.tsx test\settings.test.tsx test\oauth.test.tsx test\authorizations.test.tsx`：4 文件、31 测试通过。
- `pnpm check`：格式、45 个 release 校验、20/20
  Turbo 任务及 CLI 离线安装测试通过；web 17 文件/236 测试，worker
  259 通过/1 既有跳过，CLI 161 通过/2 既有跳过，contracts 13、encoding 14 通过。
- `pnpm --filter @shazhou/pinboard-web exec vite preview --host localhost --port 5196 --strictPort`
  返回 HTTP 200，服务实际 Vite 生产构建。
- 设置 `SETTINGS_EVIDENCE` 为本目录的 `evidence-refinement` 后运行
  `node apps\web\test\settings-browser.mjs`：21 项真实 Chrome 检查通过，页面错误 0。脚本退出后关闭 Chrome 并删除专用 profile；预览进程也在验证后停止。

源码：[分类面板](../../../../../apps/web/src/settings.tsx)、[授权工具栏/表格/状态与检索辅助](../../../../../apps/web/src/authorizations.tsx)、[token 与 General 接线](../../../../../apps/web/src/manager.tsx)、[OAuth 表格](../../../../../apps/web/src/oauth.tsx)、[样式](../../../../../apps/web/src/styles.css)。

新证据：[结果与构建资产 SHA-256](./evidence-refinement/results.json)、[可复跑 Chrome 脚本](../../../../../apps/web/test/settings-browser.mjs)、[边界与查询组件测试](../../../../../apps/web/test/authorizations.test.tsx)。结果逐项记录表格 scrollTop、滚动前后表头/工具栏位置、容器尺寸及页面宽度，包含 1280×480 低窗口；表格之外不产生页面横向溢出。筛选面板在 1280/390/320px 范围内，外侧收起后焦点仍留在 modal，Escape 返回图标，第二次 Escape 关闭 Settings。创建弹层与 OAuth 请求期间均实测 Escape、外侧和关闭图标保护；双向边界拖动不误关闭。

截图：[桌面 General](./evidence-refinement/1280-general.png)、[桌面 token](./evidence-refinement/1280-tokens.png)、[桌面 OAuth](./evidence-refinement/1280-oauth.png)、[390px token](./evidence-refinement/390-tokens.png)、[390px OAuth](./evidence-refinement/390-oauth.png)、[320px General](./evidence-refinement/320-general.png)、[320px token](./evidence-refinement/320-tokens.png)、[320px OAuth](./evidence-refinement/320-oauth.png)。密钥展示采用不可使用的固定合成字符串，所有截图均在创建前或显式 Dismiss 后采集。

浏览器路由仅在 localhost 合成 API，证明真实前端生产构建的行为，不替代生产账户、生产登录或后端联调；没有生产凭据、生产数据修改、D1 迁移、release
tag 或部署。本轮停在同步后的 Inner World 提交，等待上游验收。
