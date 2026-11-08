# Deployment

当前发布范围为已验收 Inner `32df5f993aa37a8c7dbe4878531cab076ba45921`
的表格、组合 Filter、General/MCP、关闭保护及高色块版本。用户于 2026-11-08 明确指示“部署吧”，授权本轮生产发布；协调 Agent 负责阶段审批，执行 Agent 不自行验收 Outer。

仅使用[部署指南](../../../../docs/deployment.md)的既有 annotated release
tag 流程，不改变应用源码、认证、触发器、版本、绑定、密钥或 D1
schema，不写生产账户数据。保留 main 已整合的并发下载功能。先将本契约同步到 primary 并重新观测，再开展外部验证。

## Steps

### D-S01: 在预览环境验证设置操作

核对本轮[真实浏览器结果](./inner/evidence-refinement/results.json)及[实施记录](./inner/Implementation.md)，确认 21 项真实 Chrome 检查来自最终整合后的 Vite 生产构建，而非首轮列表版或 HTML 样稿。使用其当前 JS/CSS
SHA-256 作为生产精确匹配基准。

检查覆盖四分类、语义授权表格与 sticky 表头、组合搜索/无效筛选、独立创建弹层与跨分类状态、MCP
endpoint、General 偏好、外侧及 Escape/关闭忙碌保护、回收站恢复/返回和 1280/390/320px 布局。所有账户响应仅在 localhost 合成，预览与专用浏览器进程已关闭；不将本地写操作声称为生产账户验证。

### D-S02: 经授权后发布并抽验

目标 commit 必须已在 `origin/main` 且其 CI 成功。刷新远端 tags 和 release
runs，等待任何现有生产发布完成后，选择当天未占用的下一个
`release-261108-INDEX`，普通推送 annotated tag。记录 tag/object、tagged
commit、目标 CI 与实际 release workflow URL/结论、日志可见 Worker
version。CI 若短暂失败，仅在检查失败原因后重跑失败任务，不绕过要求。

获取线上主页正在引用的当前 JS/CSS，比较其字节 SHA-256 与本轮
`evidence-refinement/results.json`；验证无 Cookie/Authorization 的
`GET /api/pins`、`GET /api/tokens`、`GET /api/oauth/grants`
被拒绝。指纹不一致时调查 commit/build 来源，不能改用旧证据宣称通过。

## Acceptance criteria

### D-AC01: 预览环境行为正确

本轮 21 项真实 Chrome 检查通过且页面错误为零；对应最终整合后的生产构建资产作为匹配基准。桌面/窄屏表格滚动、Filter、General/MCP、关闭及操作状态由本轮[结果](./inner/evidence-refinement/results.json)和[截图索引](./inner/Implementation.md)证明，不使用旧
`inner/evidence/`。

### D-AC02: 授权发布后的入口可用

实际生产 release workflow 成功，线上
[https://pinboard.shazhou.work](https://pinboard.shazhou.work)
主页及其引用的精确本轮 JS/CSS 均 HTTP
200，三个匿名受保护 API 返回 401/403。将当前真实 GET、SHA-256、tag/commit、CI/release 结果及局限保存在 Outer 支持证据，不仅记录 tag 推送。

只有已合法提供的生产会话才可追加登录后的只读抽验；不搜索个人凭据、不伪造会话、不绕过认证。未获合法会话时明确限定为成功发布、线上精确资产匹配、对应构建真实本地 UI 证据和匿名 API 拒绝，不声称生产登录后 UI、个人 Google 登录或数据变更验证。用户通过正常 Google 登录查看 Settings。

可复核的只读脚本为 [verify-production.mjs](./verify-production.mjs)，读取本轮
`inner/evidence-refinement/results.json` 并写入当前
`production-refinement-evidence.json`。

## 历史证据（不用于当前完成判定）

上一轮列表版 `release-261108-3`，tagged commit
`88df4ea67a9277710aeb220da183849b97d93e71`，Worker version
`5837bccd-0668-487d-a864-1486876ce0e4`：
[历史 CI](https://github.com/shazhou-ww/pinboard/actions/runs/42436208346)、[历史 release](https://github.com/shazhou-ww/pinboard/actions/runs/42436950404)、[ci-evidence.json](./ci-evidence.json)、[release-evidence.json](./release-evidence.json)、[production-evidence.json](./production-evidence.json)。其 17 项浏览器结果和旧资产不能证明本轮表格/Filter 版本。

本轮开始时已观测到其他发布者创建 `release-261108-4`，指向
`27cde05b36186b94741ad61225702e122d8c75ba`，发布说明为原文件与 ZIP 下载。此并发发布保留并等待其结果，不覆盖 tag，也不将其未经核实的结果当作本轮完成证据。
