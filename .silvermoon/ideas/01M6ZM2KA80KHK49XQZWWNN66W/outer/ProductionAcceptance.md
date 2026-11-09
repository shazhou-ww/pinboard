# 逐项访问权限生产验证

本文支持 [Deployment.md](Deployment.md)，区分实际发布、功能验证和未完成前提。

## 发布及 schema

- 用户明确授权父任务代审各阶段、生产发布及 smoke／新增功能验收；另行明确授权加性 D1 迁移，保留全部数据和存量公开状态。
- 候选 `836bd2049f56407e5e6bcedc08b34d51f84f8f2a` 的
  [四项 CI 矩阵](https://github.com/shazhou-ww/pinboard/actions/runs/42607037446)
  全部通过：Windows／Ubuntu，Node.js 22.13.0／24.11.1。
- 核对远端只剩 `0009_item_visibility.sql`，执行独立授权迁移。存量 Pin
  33、Publication 4 全部保持公开；revision
  CID 索引已存在，外键检查无结果。迁移前 21 个存活根中未验证根为 0。未清空或重建数据库，未扩大凭证权限。
- annotated `release-261109-5` 指向上述已经在 `origin/main` 的候选；
  [生产部署工作流](https://github.com/shazhou-ww/pinboard/actions/runs/42608026342)
  成功，工作流完整 `pnpm check` 通过。
- Worker version `7518107f-ed82-489f-a388-4bae2a0fd68b`；服务
  `https://pinboard.shazhou.work`。发布不依赖 branch-push／manual 触发或 npm 版本变更。

## 真实授权与访问

[HTTP／MCP 双账号结果](evidence/http-acceptance.json)
为实际生产请求，不是 dev-preview：

- 新多块 Pin 和 Publication 默认私有；所属账号 MCP `block_get`
  与原始块字节相等。
- 匿名、不同账号、仅上传凭证对私有 raw／CAR／原文件／历史／描述 GET、HEAD、条件请求均 404，无 ETag，响应
  `private, no-store`；私有 providers 列表为空。
- 不同账号不能凭 CID
  Pin、使用缺失子块补齐或创建 Publication 获得私有内容。实际另一账号只有 Pin 读写删范围，Publication 创建返回明确 403；全 Publication 范围的跨账号所有权矩阵另由已通过的本地真实 D1／R2 测试证明，不把线上范围拒绝冒充完整范围的所有权试验。
- 所属账号只读凭证可以下载，但不能改权限；仅上传凭证也不能改权限。
- 一个公开 Publication 让共享字节可匿名读取，但私有 Pin 和另一个私有 Publication 的元数据不公开。
- 取消最后一个公开引用后，新匿名 HEAD／ETag 和历史读取被拒绝。恢复 Publication 保持私有，不重新开放历史。

所有凭证来自真实已登录 Chrome 会话或 cfg 既有 Token，未提取 Cookie、伪造 JWT、插入测试数据库账号或增加生产鉴权旁路。已登录浏览器与用户新提供 Token 实际属于同一账号，所以使用既有的另一账号 Token 做真正的跨账号拒绝验证，并明确保留其范围限制。

## 原文件、CAR、目录与版本

[补充内容验收记录](evidence/additional-content-acceptance.json)
中前三项断言成功：

- 原文件下载与上传字节完全相同；每个 CAR 块独立核对 SHA-256
  CID，逐块原始响应与 CAR 相等；独立 UnixFS exporter 重建完整文件。
- 私有目录下载为 ZIP；真实编译 CLI 通过 stdin 接收授权 Token，下载并重建嵌套文件，逐文件内容相等。没有把 Token 写入 CLI 配置或命令参数。
- 公开项更新到 v2，再回滚到 v1，访问状态保持公开、历史总数为 2；转私有后 v1／v2 均不可匿名读取。

此轮整体 status 为 failed，原因是后续 UI 测量将多行标题的整体中心错误当作权限图标首行位置；不能把整轮称为通过。以上已成功内容断言与之后独立通过的 UI 结果分别引用，不隐藏失败或修改原始证据。

## 真实 Web 与移动详情

[UI 结果](evidence/ui-acceptance.json) 的三项真实生产断言通过，
[私有详情截图](evidence/production-private-detail.png)
仅截取本次随机测试内容的详情：

- 锁是 info bar 第一个元素；移除锁前后，栏高及 preview padding 完全相等。
- 标题栏不存在类型 icon；权限按钮最左侧，与标题首行位于同一横排，多行标题不要求按钮垂直居中于整个段落。
- 点击标题权限按钮打开 Access and
  sharing，通过真实原生确认框先公开、再转私有；实际保存提示成功，独立 HTTP
  API 复核 public／private。
- 在同一测试标签页模拟 390×844
  viewport，标题首行与权限按钮同行，页面无水平溢出。本地 1280／390／320 的内容墙与详情测量另见 Inner 证据。

未修改用户已有标签页、内容或草稿；使用专用 smoke 标签页并在结束后关闭。

## 存量兼容、清理与重试记录

[Legacy 结果](evidence/legacy-acceptance.json)
证明发布前创建的独立公开 fixture 迁移后仍公开，原文件内容不变。将该 fixture 转私有后，未添加新 query 的旧 raw
URL 返回 404；最后仅将该 fixture 移入回收站。没有修改其他既有生产内容。

每轮只生成独立随机测试项，清理仅针对该轮记录的 ID，结果 cleanup 为空。临时全权限／只读／仅上传 Token 每轮各一个，由真实浏览器 Token
API 创建，结束后全部通过 DELETE 撤销；记录包括
[首次](evidence/token-first-attempt-cleanup.json)、[完整 HTTP](evidence/token-cleanup.json)、
[补充验收](evidence/additional-token-cleanup.json)、[最终 UI](evidence/ui-token-cleanup.json)。用户要求的 cfg
`PINBOARD_ACCEPTANCE_OTHER_TOKEN` 已
[删除并核对不存在](evidence/cfg-cleanup.json)。cfg 删除不等于服务端 Token 撤销，未擅自撤销用户提供或既有长期 Token。

[首次 HTTP 试验](evidence/http-first-attempt.json)
因把同一个实际账号误作第二账号，合法条件读取返回 304，不能作为越权证据；确认账号映射、换用真实独立账号后全部通过。
[首次补充试验](evidence/additional-first-attempt.json)
因 exporter 夹具接口应返回 iterable 而失败，修正验收工具后文件／目录／版本断言通过。未因此修改或弱化服务器授权。

## 缓存清理仍未完成

cfg 主 `CLOUDFLARE_API_TOKEN` 可操作目标 D1，但精确 URL Cache
Purge 实际返回 401／Authentication
error。已再次从 cfg 远端获取主 Token 核对，拒绝依旧；没有擅自扩权或清理整个共享 zone。仅要求
`shazhou.work` 的 Cache Purge → Purge 权限。

新的响应均为 `private, no-store`，新匿名读取／条件请求及旧 legacy
URL 已验证拒绝；但这不能证明所有旧 CDN 表示已清空。因此 D-S02、D-AC01、D-AC02 尚不宣告完成，也不记录 submitOuter／acceptOuter。获得必要权限后须仅对 Pinboard 精确 URL 清理并保留结果，外部下载、浏览器缓存和其他节点副本始终不承诺撤回。
