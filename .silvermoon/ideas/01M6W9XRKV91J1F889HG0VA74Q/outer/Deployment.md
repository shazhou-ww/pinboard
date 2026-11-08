# Deployment

当前发布范围为已验收 Inner `b0d96a5642a0f45ea9875ff190e0aa6b5ef94a86` 的 General
/ Tokens / OAuth /
Trash 单行短导航标签，右侧完整标题、内部分类及行为不变。用户于 2026-11-08 明确指示“做完了直接提交并部署啊，让我看看效果”，授权本轮生产发布；协调 Agent 负责阶段审批，执行 Agent 不自行验收 Outer。既有表格版 release-261108-5 不是本次短标签发布证据。

仅使用[部署指南](../../../../docs/deployment.md)的既有 annotated release
tag 流程，不改变应用源码、认证、触发器、版本、绑定、密钥或 D1
schema，不写生产账户数据。保留 main 已整合的并发下载功能。先将本契约同步到 primary 并重新观测，再开展外部验证。

## Steps

### D-S01: 在预览环境验证设置操作

重新运行最终同步源码的真实 Chrome 检查，保存本轮
`short-label-browser-evidence.json`，核对[实施记录](./inner/Implementation.md)，确认 21 项检查来自最终整合后的 Vite 生产构建，包含短标签和单行文本 Range 边界，而非首轮列表版、旧表格构建或 HTML 样稿。使用其当前 JS/CSS
SHA-256 作为生产精确匹配基准。

已验收短标签指纹：`/assets/index-BP2DwIGo.js` 为
`afe4b626386bddcf3a472ddb61f7dec040eb69065098813ce3332b9b2eb6273d`，`/assets/index-Cn2h5Svz.css`
为
`e45dc9cff8582dc1075ed8c31a99853355897d6fd43e596a8a290901539b37de`。如并发源码使构建来源改变，先调查而不沿用旧证明。

检查覆盖四分类、语义授权表格与 sticky 表头、组合搜索/无效筛选、独立创建弹层与跨分类状态、MCP
endpoint、General 偏好、外侧及 Escape/关闭忙碌保护、回收站恢复/返回和 1280/390/320px 布局。所有账户响应仅在 localhost 合成，预览与专用浏览器进程已关闭；不将本地写操作声称为生产账户验证。

### D-S02: 经授权后发布并抽验

目标 commit 必须已在 `origin/main` 且其 CI 成功。刷新远端 tags 和 release
runs，等待任何现有生产发布完成后，选择当天未占用的下一个
`release-261108-INDEX`，普通推送 annotated tag。记录 tag/object、tagged
commit、目标 CI 与实际 release workflow URL/结论、日志可见 Worker
version。CI 若短暂失败，仅在检查失败原因后重跑失败任务，不绕过要求。

获取线上主页正在引用的当前 JS/CSS，比较其字节 SHA-256 与本轮
`short-label-browser-evidence.json`；验证无 Cookie/Authorization 的
`GET /api/pins`、`GET /api/tokens`、`GET /api/oauth/grants`
被拒绝。指纹不一致时调查 commit/build 来源，不能改用旧证据宣称通过。

## Acceptance criteria

### D-AC01: 预览环境行为正确

本轮 21 项真实 Chrome 检查通过且页面错误为零；对应最终整合后的生产构建资产作为匹配基准。桌面/窄屏短标签单行、表格滚动、Filter、General/MCP、关闭及操作状态由本轮
`short-label-browser-evidence.json` 证明，不使用旧 `inner/evidence/` 或
`inner/evidence-refinement/` 的构建指纹。

### D-AC02: 授权发布后的入口可用

实际生产 release workflow 成功，线上
[https://pinboard.shazhou.work](https://pinboard.shazhou.work)
主页及其引用的精确本轮 JS/CSS 均 HTTP
200，三个匿名受保护 API 返回 401/403。将当前真实 GET、SHA-256、tag/commit、CI/release 结果及局限保存在 Outer 支持证据，不仅记录 tag 推送。

只有已合法提供的生产会话才可追加登录后的只读抽验；不搜索个人凭据、不伪造会话、不绕过认证。未获合法会话时明确限定为成功发布、线上精确资产匹配、对应构建真实本地 UI 证据和匿名 API 拒绝，不声称生产登录后 UI、个人 Google 登录或数据变更验证。用户通过正常 Google 登录查看 Settings。

可复核的只读脚本为 [verify-production.mjs](./verify-production.mjs)，读取本轮由
`BUILD_EVIDENCE` 指定本轮 `short-label-browser-evidence.json`，由
`PRODUCTION_EVIDENCE` 指定
`production-short-label-evidence.json`，并显式传入本轮
`IMPLEMENTATION_REVISION`。

## 当前短标签发布结果

本轮部署契约先同步到 primary，随后进行最终构建浏览器检查、成功 CI、annotated
release
tag 及线上只读验证；当前尚未发布。发布完成后在此记录本轮 tag、目标 commit、CI/release
workflow、Worker version 及线上精确指纹。

## 历史表格版发布结果（不证明短标签）

2026-11-08 本轮授权发布已完成，等待协调 Agent 对准确 Outer revision 验收：

- 契约先同步为 primary commit `8ac1af7298f3ac941b6bfbf7457f8d8c86b3bcc2`
  并重新观测，随后才进行本轮外部发布与验证。此 commit 的 `apps/web/src` tree 为
  `e40d947673736eede7e78524918d63cea3bf79f6`，保留并发下载功能，未改变已验收实现。
- `pnpm check` 成功：20/20 Turbo 任务（20 个缓存结果），CLI
  tarball 离线安装测试通过。本地重建 JS/CSS 与已验收 21 项真实 Chrome 证据逐字匹配；见
  [refinement-local-evidence.json](./refinement-local-evidence.json)。
- [当前目标 CI](https://github.com/shazhou-ww/pinboard/actions/runs/42444233566)
  四个 Windows/Ubuntu、Node.js 22.13.0/24.11.1 组合全部成功，无需重跑；见
  [ci-refinement-evidence.json](./ci-refinement-evidence.json)。
- 刷新远端 tags/runs，等待并发 `release-261108-4`
  workflow 成功结束后，普通推送 annotated `release-261108-5`，tag object
  `84350cc5141b9d5f15e6a01be854a9e394f60aa7`。Tagged commit
  `8ac1af7298f3ac941b6bfbf7457f8d8c86b3bcc2` 在创建 tag 前已证明可从
  `origin/main` 到达。
- [当前生产 release workflow](https://github.com/shazhou-ww/pinboard/actions/runs/42444608197)
  / `Deploy production Worker` 实际成功，完成于
  `2026-11-08T03:57:24Z`。日志记录 Worker version
  `42b4455c-953a-42d0-baf9-0bff183ed4dd`；见
  [release-refinement-evidence.json](./release-refinement-evidence.json)。
- `2026-11-08T03:57:59.130Z`
  [当前生产只读证据](./production-refinement-evidence.json)：主页 HTTP
  200，实际引用 `/assets/index-qf0X8Z_Y.js` 与
  `/assets/index-SYMU66G7.css`，两者 HTTP 200，SHA-256 分别为
  `2c29df06c3dd3c06038941434197299031a90b356f33d5a474a9bb3b1861da4d` 与
  `546bedf3a8df9c525226c6d8326f494bc5aacaf7352b9a7eab490881a4313007`，完全匹配本轮
  `evidence-refinement/results.json`。无来源或构建差异。
- 无 Cookie/Authorization 的三个匿名 GET 均返回 HTTP
  401。没有合法生产测试会话，未执行登录后线上 UI 抽验、生产写操作或个人 Google 登录验证；证明范围严格限定为上述发布、精确资产、对应构建真实本地 UI 和匿名授权拒绝。

复核命令（不会登录或修改账户）：

```powershell
$env:RELEASE_TAG = "release-261108-5"
$env:RELEASE_COMMIT = "8ac1af7298f3ac941b6bfbf7457f8d8c86b3bcc2"
$env:RELEASE_WORKFLOW = "https://github.com/shazhou-ww/pinboard/actions/runs/42444608197"
node .silvermoon\ideas\01M6W9XRKV91J1F889HG0VA74Q\outer\verify-production.mjs
```

## 历史证据（不用于当前完成判定）

上一轮列表版 `release-261108-3`，tagged commit
`88df4ea67a9277710aeb220da183849b97d93e71`，Worker version
`5837bccd-0668-487d-a864-1486876ce0e4`：
[历史 CI](https://github.com/shazhou-ww/pinboard/actions/runs/42436208346)、[历史 release](https://github.com/shazhou-ww/pinboard/actions/runs/42436950404)、[ci-evidence.json](./ci-evidence.json)、[release-evidence.json](./release-evidence.json)、[production-evidence.json](./production-evidence.json)。其 17 项浏览器结果和旧资产不能证明本轮表格/Filter 版本。

本轮开始时已观测到其他发布者创建 `release-261108-4`，指向
`27cde05b36186b94741ad61225702e122d8c75ba`，发布说明为原文件与 ZIP 下载。此并发发布保留并等待其结果，不覆盖 tag，也不将其未经核实的结果当作本轮完成证据。
