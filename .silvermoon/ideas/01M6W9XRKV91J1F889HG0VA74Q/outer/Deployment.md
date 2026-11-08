# Deployment

本轮状态：表格与组合 Filter 的实现已验收，尚未部署。用户本轮只要求按样稿更新，未要求再次生产发布；停留在待发布状态，不创建 release
tag。下文 `release-261108-3`
及其证据仅为上一轮列表版的历史记录，不证明当前实现已上线。后续发布须使用当前验收构建重新验证，并明确获得本轮发布授权。

## Steps

### D-S01: 在预览环境验证设置操作

实施验收后，在隔离预览环境通过真实浏览器核对设置及授权操作，仅使用专用测试数据。

使用已验收实现对应的构建，核对四个分类、两种授权列表、OAuth 页的 MCP
endpoint、浏览器偏好、回收站返回路径及外侧关闭；桌面和窄屏均记录证据。

已核对已验收的 Inner `46195d43e4c2a7b14e83a71ee117153dd5975c75`：
[真实浏览器结果](./inner/evidence/results.json)包含 17 项通过记录，地址
`http://localhost:5196`
服务的是生产构建而非 HTML 样稿。发布目标 commit 与实现 commit 的 `apps/web/src`
tree 均为
`89d709956d48360e8a11a7d8297135fb8bfef2a3`，此后没有应用代码变更。本地构建的 JS/CSS
SHA-256 与已验收证据逐字一致。预览进程已关闭；账户响应由 localhost 浏览器路由合成，不连接生产账户。

### D-S02: 经授权后发布并抽验

用户已于本轮明确授权 subagent 实现并部署，要求部署到线上供查看，并委托协调 Agent 负责阶段门限审批，无需再次询问。实施验收后遵循[部署指南](../../../../docs/deployment.md)的 tag 流程发布到现有生产站点，不仅停留在本地或预览环境。

等待目标 primary commit 的 CI 成功，使用当天未占用的下一个 annotated release
tag。记录 tag、主分支 commit、workflow 结果和线上地址；不更改部署触发器、密钥、绑定、账户数据或 D1
schema。

2026-11-08 已完成授权发布：

- Tagged commit：`88df4ea67a9277710aeb220da183849b97d93e71`，打 tag 前已在
  `origin/main`。
- [目标 commit CI](https://github.com/shazhou-ww/pinboard/actions/runs/42436208346)
  四个 Windows/Ubuntu、Node.js 22.13.0/24.11.1 组合最终全部成功。首次 Windows
  Node.js
  22 原生 CLI 权限测试的 PowerShell 子进程超时；仅重跑失败任务，第二次通过，未修改代码、放宽检查或绕过 CI。机器结果见
  [ci-evidence.json](./ci-evidence.json)。
- 刷新远端 tags 与 release runs 后，当天只有 `-1`、`-2`，创建并普通推送annotated
  `release-261108-3`；tag object 为 `217fdd4690fe2eeacfdaf9bfaa4f17600ca9c463`。
- [生产 release workflow](https://github.com/shazhou-ww/pinboard/actions/runs/42436950404)
  `Deploy to Cloudflare` / `Deploy production Worker`
  成功，包含 workspace 校验及实际部署步骤；结果见
  [release-evidence.json](./release-evidence.json)。
- Wrangler 输出的实际 Worker version：
  `5837bccd-0668-487d-a864-1486876ce0e4`，部署完成于 `2026-11-08T02:07:34Z`。
- 线上地址：[https://pinboard.shazhou.work](https://pinboard.shazhou.work)。

仅通过既有 tag
workflow 发布，沿用现有配置及生产 secret 值，没有直接部署、迁移 D1、更改 secret 值/绑定、修改触发器或执行生产账户写操作。

## Acceptance criteria

### D-AC01: 预览环境行为正确

记录预览地址及浏览器证据，证明分类可达、浏览器偏好不影响其他设备，测试授权可撤销，测试回收站可进入及恢复。

已验收构建的 17 项真实 Chrome 检查覆盖四个分类、token 有效与只读历史列表、两种授权的逐行撤销、本地偏好、测试恢复及返回、忙碌关闭保护、双向拖动保护与焦点返回。桌面面板实测 1000×680
/ 导航 208px，390px 与 320px 均无页面横向溢出。证据：[桌面 OAuth](./inner/evidence/desktop-oauth.png)、
[桌面 token](./inner/evidence/desktop-tokens.png)、
[390px OAuth](./inner/evidence/mobile-390-oauth.png)、
[320px token](./inner/evidence/mobile-320-tokens.png)。这些授权撤销与恢复仅作用于本地合成响应，不声称验证生产账户写操作。

### D-AC02: 授权发布后的入口可用

生产 release
workflow 成功，线上主页与发布构建的静态资源可获取，匿名受保护 API 仍拒绝访问。以发布资源版本及 Settings 相关代码/样式指纹证明新版已上线，并结合对应构建的桌面/窄屏浏览器证据证明 Settings 分类与关闭行为。

如已有合法生产测试会话，可追加登录后的线上只读抽验；不得为了验收伪造会话或绕过认证。没有生产测试会话时明确记录这一证据限制，提供线上地址让用户通过正常登录查看，不声称完成个人 Google 登录或线上数据变更验证。

`2026-11-08T02:07:57Z` 的[生产 HTTP 证据](./production-evidence.json)已证明：

- 主页 HTTP 200，并实际引用已验收的 JS/CSS，而非仅能访问历史资源。
- `/assets/index-DQRLJeBs.css` HTTP 200，SHA-256
  `5534efa049daf82e9fc5b3e2f3ee6f704c7ae6c2be2f6b481f18e1d114534782`。
- `/assets/index--j016cdQ.js` HTTP 200，SHA-256
  `e2a37f14f0d27dfe6b5bc3a11d86e1959bdcafd7f8c722b588b3e6978d77cf4d`。
- 两个线上资源指纹均与已验收构建的浏览器证据完全一致，未出现来源或构建差异。
- 无 Cookie、无 Authorization 的 `GET /api/pins`、`GET /api/tokens`、
  `GET /api/oauth/grants` 全部返回 HTTP 401。

可用[只读验证脚本](./verify-production.mjs)复核相同指纹及匿名拒绝行为：

```powershell
$env:RELEASE_TAG = "release-261108-3"
$env:RELEASE_COMMIT = "88df4ea67a9277710aeb220da183849b97d93e71"
$env:RELEASE_WORKFLOW = "https://github.com/shazhou-ww/pinboard/actions/runs/42436950404"
node .silvermoon\ideas\01M6W9XRKV91J1F889HG0VA74Q\outer\verify-production.mjs
# 生产主页、精确 JS/CSS SHA-256 和三项匿名 API 拒绝验证通过。
```

本轮没有获提供合法生产测试会话，因此未执行生产登录后 UI 抽验，也未伪造会话、创建令牌、撤销授权或恢复生产对象。证明范围为成功发布、线上正在引用的精确构建、同构建隔离浏览器行为及线上匿名访问拒绝；用户可通过正常 Google 登录在上述线上地址查看 Settings。
