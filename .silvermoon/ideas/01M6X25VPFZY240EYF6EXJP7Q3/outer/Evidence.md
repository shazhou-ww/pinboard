# 生产发布证据与未完成验收

## 已完成发布

父级于 2026-11-08 明确批准准确主体世界
`23cee2dfcec745592cde6ef6894e0415bd7ffdfd`
的验收与生产发布。acceptInner 已记录于 primary
`31b4cde332d81f8d98d50dd9a563943912bd0415`。细化现实世界契约先同步于
`3867218c9d053646a3411fb2a53b6222fddb6099`，当时 deploymentRevision 为
`8ef0583f0e20a42e2103ceb2158a98c3a35a7a1b`，随后执行外部检查。

- 发布 tag：[`release-261108-7`](https://github.com/shazhou-ww/pinboard/tree/release-261108-7)，annotated
  tag object `bd1bae22f0b719bac8b06025a4a3ff51ed13b86d`。
- 精确 target：`3867218c9d053646a3411fb2a53b6222fddb6099`，已在 `origin/main`。
- [候选 CI 42465665953](https://github.com/shazhou-ww/pinboard/actions/runs/42465665953)
  全部四个 Ubuntu/Windows、Node 22/24 jobs 成功。
- [发布 workflow 42466094519](https://github.com/shazhou-ww/pinboard/actions/runs/42466094519)
  成功，tag/ancestry、完整
  `pnpm check`、Worker/assets/既有 secrets 原子上传全部通过。
- 活跃 Worker version：`5a6558ca-1516-47db-8311-d879121797f9`，deployment
  `189f194c-1de2-4084-b7eb-fc3616cad4e1`，100% 流量，
  `workers/tag=release-261108-7`，创建于
  `2026-11-08T09:14:16.106971Z`。发布前的活跃 version 是
  `e1e601ac-6ccf-47a6-8eba-cfc5d1046d91`。
- [不可变发布与活跃版本记录](./evidence/release.json)。

tag 前再次刷新 main、当日 tags 与部署队列：现有索引 1–6，没有正在运行的部署，故选择 7。没有包版本变化、release
branch、触发规则改动、D1 迁移、资源创建、绑定变更或 credential 轮换；仅执行既有获批发布工作流。Cloudflare 只读检查使用已有 host
credential，不输出值。Wrangler 文档在线检索不可用，检查命令语法来自已安装版本的
`--help` 与仓库部署指南，没有推测或执行新控制平面写操作。

## 已完成真实生产检查

生产地址：[HTTPS 首页](https://pinboard.shazhou.work)。
[部署 assets 验证](./evidence/deployed-assets.json) 证明 HTTPS 200、Google
provider 已配置，生产 JS/CSS 的 SHA-256 与已测试本机构建逐字节一致。另发现 HTTP 首页返回 200，并非强制跳转 HTTPS；这是现有域名行为，本次未修改或宣称已完成 HTTPS 重定向加固。

使用 `cfg` 中已有 `PINBOARD_AGENT_TOKEN`，仅在执行进程环境中读取，完成
[17 项真实认证 Pin API 检查](./evidence/pin-api-smoke.json)：

- 两个独有合成样本（文本与 HTML）上传成功；固定 CID 原文件字节与上传一致，CAR 根一致。
- 私人说明真实保存，旧 expectedVersion 返回 409，已保存值未覆盖。
- 匿名私人说明/账户列表返回 401；授权根不含另一个样本 CID，节点查询返回 404。
- HTML/JS 原始路由为 attachment、nosniff、sandbox
  CSP；原文件下载也不以内联文档返回。

真实公共固定 CID 分享页面在 1440px、390px、320px
Chromium 检查通过，没有横向页面溢出、私人 Pin 名称或私人说明：
[桌面](./evidence/production-public-pin-share-1440.png)、
[390px](./evidence/production-public-pin-share-390.png)、
[320px](./evidence/production-public-pin-share-320.png)。
[公共浏览器记录](./evidence/production-browser.json)
明确这些不是已认证所有者详情截图。此处样本链接清理后仍可按内容保留规则读取，不能将其当作永久在线演示承诺。

## 权限边界与未完成标准

**D-AC02 未完成，D-S02 保持未勾选；不 submitOuter，不 acceptOuter。**

- 既有 Agent credential 缺少 `publications:read`、`publications:write`、
  `publications:delete`：列表与两个随机不存在身份的非破坏性权限探测均明确返回 403。
  [范围探测记录](./evidence/auth-limits.json) 不包含 credential 或真实账户对象。
- 标准 CLI endpoint-bound credential 的独立读取尝试返回 401。
  [首次 Publication smoke 被权限阻断](./evidence/api-smoke.json)，尚未创建任何 Publication。
- 浏览器工具客户端没有连接，现有 Chrome/Edge 无可用调试端点。隔离 Chrome 中
  `/api/auth/session` 无 user；合法 Agent credential 不会变成 Auth.js
  session。没有伪造 session、读取/解密浏览器 cookie、修改 OAuth、扩展 Agent 权限或用本地 fixture 假装生产认证通过。
- 因而未验证真实认证的普通 Pin/Publication 所有者详情、生产 current/selected/latest 历史浏览、Publication 固定版本链接与下载；主体世界的 48 项合成浏览器证据仍然只是本地证据。
- 尚未执行新 Google OAuth round
  trip、跨账户真实删除或独立 Kubo 重建；本次没有声称通过这些未新增需求或需要其他账户/客户端的检查。

继续验收需要已有合法浏览器会话，以及明确授权、具备必要 Publication
scopes 的测试访问路径；只需补做本契约剩余生产验证，不需要重复部署，不应扩大已有 credential 权限或改实现来绕过认证。

## 精准清理

[清理记录](./evidence/cleanup.json)：仅将本次创建的两个合成 Pin 移到最近删除，两个对象均保留正常 30 天恢复窗口。账户原有 16 个 active
Pin 在前后完全一致，身份集合 SHA-256 相同。没有创建或修改 Publication，没有永久删除，没有修改真实对象的名称、说明或历史。没有创建新 token，也没有撤销用户既有共享 credential。隔离浏览器 profile 与执行 scratch 文件在结束前清理；没有持久化 secret。
