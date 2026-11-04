# CAR 生产发布前置检查与阻塞证据

## 当前结论

本次未完成发布，也未申请 outer 验收。生产仍为 `release-261104-1`，Worker version
`8a1bd7fa-6a32-4a8c-8c3b-acbdb7c30585`，流量 100%。未创建 release
tag，未执行 D1 写入，未上传任何内容，未创建或撤销 token，未更改永久凭证或鉴权配置。所有 D-*
ledger 条目保持未完成；不得追加 `submitOuter` 或 `acceptOuter`。

**可执行阻塞：当前运行环境没有生产应用上传凭证，且共享浏览器没有已登录的 Google/Pinboard 会话。**
恢复条件是通过既有安全凭据通道向执行进程提供有效、最小范围的
`PINBOARD_AGENT_TOKEN`（上传 `pins:write`，清理自有 pin 另需
`pins:delete`，列表需
`pins:read`），或让可用的现有认证浏览器会话通过正常应用接口创建短期 token。不能用控制面 D1 权限插入 token、伪造 JWT 或绕过正常认证替代该前置条件。不要求在聊天中粘贴凭证，不要求修改永久 Cloudflare
token。

## 合同与隔离

- 全部操作位于 `D:\Code\pinboard-car-delivery` 的
  `delivery/car-indexed-storage`，未修改原工作树或 CLI 工作树。
- 可测量协议先在 primary 提交 `212f600ac296cf498825471f863d9e5b66c93838`
  同步，之后才执行生产只读检查。当时 outerRevision 为
  `433da4ed88577ca9f1aa07bbdc29a2d3a2338039`；本证据加入后会形成新的 outerRevision。
- 已验收 innerRevision 仍为
  `8dabac12bb595939f9ab925b25a903655dd0ef6b`，未更改 inner/ideal、源代码、资源绑定或发布工作流。
- 既有生产证据见
  `../../01M6JSKEZAYJHX215SCBKA1RPY/outer/ProductionEvidence.md`。

## 身份、权限与安全替代路径

`pnpm --filter @workspace/worker exec wrangler whoami` 确认项目本地 Wrangler
`4.151.0` 使用现有 OAuth 身份 `shazhou.ww@gmail.com`，目标 account
`92c3c4fdcc84a1590555bccf4f111de2`，已有 `d1 (write)`、Worker 写入与
`workers_tail (read)`。未执行登录、重新授权或扩权。Wrangler 的缺少 K2
scopes 提醒与本次 D1/R2 任务无关，不据此扩大授权。

Cloudflare
MCP 的 whoami/docs 都返回需要认证；改用已认证的本地 Wrangler，成功查询生产 D1 与 Worker
deployment。官方 D1 文档：
<https://developers.cloudflare.com/workers/wrangler/commands/d1/>；执行前核对本地
`wrangler d1 execute --help` 的 `--remote`、`--command`、`--json`。

应用认证替代路径已检查：

- 当前进程没有 `PINBOARD_AGENT_TOKEN` 等 Pinboard 应用凭据。
- 设备 cfg 的导出及完整键名清单没有 Pinboard/Agent
  token；没有输出秘密值。其他产品 smoke 凭据不能当作 Pinboard 凭据。
- 文档指定的 `%LOCALAPPDATA%\pinboard\tokens.json`
  不存在；未扫描其他工作树、历史会话或未知用户文件寻找秘密。
- 共享浏览器首页为未登录；正常进入 Auth.js 原生表单并提交后到达 Google “Email or
  phone”登录页，没有可复用会话。未填写账户密码或获取其他站点 cookie。
- GitHub `production`
  Environment 中五个既有部署 secret 的名称存在；值不可读取，且它们不是 Pinboard 应用上传 token。未尝试提取 CI
  secret。

## D1 只读 preflight

目标 D1 `625b568d-106b-4fe1-af33-3eac4fe0a354`；配置名/绑定为 `pinboard` /
`DB`。使用 `wrangler d1 execute DB --remote` 查询：

- `sqlite_master` 中 legacy `accounts`、`agent_tokens`、`pins` 及其索引存在。
- `d1_migrations` 已有 `0001_pinboard.sql`，记录时间
  `2026-11-03 13:37:37`。因此本实例不是“手工初始化但无历史”的假设情形。
- `car_dags`、`car_blocks`、`car_blocks_object` 均不存在；两个 CAR 表的
  `PRAGMA table_info` 返回空。
- `pins` 列定义符合旧 schema，`SELECT count(*) FROM pins` 为 2。
- `wrangler d1 migrations list DB --remote` 只列出待应用的
  `0002_car_storage.sql`。只读查询的 `changed_db=false`、`rows_written=0`。

**迁移结果：未执行，等待应用认证前置条件。**
安全恢复顺序是重新观察 schema/迁移历史，确认仍只有 0002 待应用，再用现有独立授权的控制面身份执行
`pnpm --filter @workspace/worker exec wrangler d1 migrations apply DB --remote`，之后复核表/索引/外键/CHECK 及原有 pin 数量。不得重放 0001，不做破坏性清理。该命令仅是后续恢复步骤，不是已发生动作。

## 真实生产探测

以下请求于 `2026-11-04T12:35:10.925Z` 至 `12:35:13.551Z`
直接访问生产 HTTPS 域名；使用 Node
fetch 和正常证书验证。它们是发布前连通性/拒绝语义检查，不是指定夹具的前后性能基线，也不是 CAR
rollout smoke 成功。

| 请求                                                              | 状态 | 首字节 ms | 总耗时 ms | 响应字节 | 结果                                        |
| ----------------------------------------------------------------- | ---- | --------- | --------- | -------- | ------------------------------------------- |
| `GET /api/me`                                                     | 401  | 814.66    | 816.37    | 12       | 未登录                                      |
| `GET /api/pins`                                                   | 401  | 916.33    | 916.56    | 31       | `Sign in with Google`                       |
| `POST /api/pins/upload?kind=file&name=car-rollout-auth-preflight` | 401  | 152.91    | 153.15    | 31       | 正确 Origin、公开确认头，空体；拒绝且未写入 |
| 已有 legacy 根的 raw GET                                          | 200  | 735.19    | 737.48    | 165      | SHA-256 匹配既有独立证据                    |

legacy 请求路径为
`/ipfs/bafybeichdmdbzwsifxxipvqqykwdaiviqp3blxbwy5saryokhttifcadzu?format=raw`。实际 SHA-256
`471b061cda482dee87d610c2ac3022a883f615dc36c76408e1ca3ce6828803cd`，ETag 为该 CID 加
`.raw` 的双引号强标签；`cf-cache-status`
未返回。只有单次样本，不推断冷/暖、性能改善或回归。

尚未测量：指定多小文件/多区块夹具的切换前基线、切换后真实认证上传、整包 CAR 下载和离线重建、真实 R2 操作数、R2 字节及 D1 索引占用、前后性能比值。没有本地模拟替代、没有虚构遥测或验收结论。恢复后仍须完整执行 Deployment.md 协议，并在 CAR-only 写入后坚持保留新 reader 的前向修复边界。

## 检查与发布身份

- 本工作树 `pnpm check`
  于本次 preflight 后运行，退出 0；未升级依赖。首次调用项目 Wrangler 时 pnpm 自动按现有锁文件恢复缺失依赖。
- 已接受实现的四平台 CI：
  [41827926346](https://github.com/shazhou-ww/pinboard/actions/runs/41827926346)，Windows/Ubuntu
  × Node 22.13.0/24.11.1 四项 success。
- 已接受 primary 提交 CI：
  [41829587642](https://github.com/shazhou-ww/pinboard/actions/runs/41829587642)，success。
- 生产现有 release 的部署：
  [41801933814](https://github.com/shazhou-ww/pinboard/actions/runs/41801933814)，tag
  `release-261104-1`，源提交 `96583d9bf8d52ba839dd746abef06c6b0d0a9dc2`。
- 本次 CAR 发布 tag/commit/WorkerVersion：均未创建；不得把现有生产版本记为 CAR 已发布。
