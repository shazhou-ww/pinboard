# CAR 生产发布与验收证据

## 2026-11-06：当前生产只读复验

先将环境修订同步到 primary `11f1c09a8e01`，重新观察 CAR
`deploymentRevision=cb8c4b5cab86`
后执行本节检查。仅复用已有公开合成内容，不新建 Pin、授权、Token 或 R2 对象，不改其他 idea、源代码或历史数据库。

当前为 `release-261106-5`、应用提交 `2b109be68a8105bef2b1c51171e937c774f6b553`；
[成功发布流程](https://github.com/shazhou-ww/pinboard/actions/runs/42176511205)。Cloudflare 控制面确认 Worker
`418e27ae-3c78-46e5-8f5f-48c6ad7c6ad7`、100% 流量。当前 D1 为
`9f15fd50-e103-459f-9f3f-9db3036f91de`；下文旧 UUID 只属于历史，不执行任何旧库命令。

`2026-11-06T07:17:58Z` 当前 D1 只读聚合：11 个 indexed root，manifest `size`
合计 972,002 字节，72 个全局块位置，`byte_length` 合计 948,455 字节；数据库
`size_after=544768`，外键检查为空，迁移账本 0001–0008。这些不是 R2 实际对象/计费字节，也不是本夹具的 D1 增量占用；共享块、旧位置改指向、重复 CAR、历史对象与页分配不能由这两个合计推导。查询均
`rows_written=0` / `changed_db=false`。

### 样本来源与完整性

- legacy 根 `bafybeichdmdbzwsifxxipvqqykwdaiviqp3blxbwy5saryokhttifcadzu`
  来自本文件及 `docs/retention-production.md`
  的历史公开合成夹具。当前 D1 没有该根的 `car_dags`
  行；保留为 legacy 兼容路径，不回填它。
- indexed 根 `bafkreief73jih6zmdk5viz56xo33oittxvmnjmt5755nofguv37kd2cqoi`
  来自预览 idea 已记录的公开高频黑白 PNG 合成夹具，见
  [其生产证据](../../01M6N8A59MBK0BQNMNA259RSFS/outer/Production-verification.md)。当前 D1 直接确认
  `car_dags.size=1055`、1 个块位置。不读取账户信息，不使用该 idea 的已验收状态代替本次内容校验。
- 每次下载 raw 块均独立匹配其 CID 的 SHA2-256，CAR 经独立 `CarReader`
  验证单根和全部块的 CID。legacy CAR 为 3,147,545 字节、18 块，SHA-256
  `4daf3f74323481fb5f97309165cfcf5d5cba0ee1cf01fb231cb5951e79b0b28a`，与历史完全相同。
- indexed CAR 为 1,055 字节、1 块，SHA-256
  `f0e66bcf4519f952ac2be0f45f4c61202d46894d43d85bb7732a1108af49c453`；原文件 958 字节，SHA-256
  `85fed283fb2c1abb5467bebbb7b72273bd58d4b27dff7ad714d4aefea1e85072`。
- Kubo `0.43.1` 为每个根新建独立空 repo，以 `--offline` 导入下载的 CAR 并 `get`
  重建，不启动 daemon、连接来源或改动日常 Kubo。随后 `block get`
  根块与生产 raw 下载逐字节一致。legacy 重建出 `empty.txt`（0 字节）、
  `nested/note.txt`（50 字节）和
  `payload.bin`（3,145,865 字节）；indexed 重建出同一 958 字节 PNG。逐文件 SHA-256 保留于原始数据；legacy 的原始逐文件清单未重新取得，不能额外声称与未持有的源目录逐文件对比。

### 当前测量与非同条件历史对照

原始 UTC 窗口、每次状态/首字节/总耗时/字节数/ETag/缓存头、CID校验和离线文件清单见[只读原始测量](ReadOnlyMeasurements-2026-11-06.json)。每种表示首个带唯一查询参数的请求是“冷候选”，后续 5 次复用同 URL为“暖重复”；没有
`cf-cache-status`
或 Age，不能证明边缘或 R2 内部冷热。首字节由实际首个响应体 chunk 计时，同时保存收到 headers 的时间。

| 路径            | 冷候选首字节 / 总耗时 ms | 暖重复首字节中位 ms | 暖重复总耗时中位 ms（范围） | 响应字节  |
| --------------- | ------------------------ | ------------------- | --------------------------- | --------- |
| legacy raw      | 789.48 / 789.77          | 719.09              | 719.28（666.79–761.92）     | 165       |
| legacy CAR      | 5033.56 / 5531.41        | 5036.81             | 5175.58（5049.23–5421.70）  | 3,147,545 |
| indexed PNG raw | 618.03 / 618.38          | 572.37              | 572.61（519.72–633.44）     | 958       |
| indexed PNG CAR | 521.12 / 521.33          | 581.60              | 581.89（520.75–615.18）     | 1,055     |

正式轮次 24 次下载均为 200；另每根 HEAD 200 空体、ETag 304 空体通过。整包接口
`/api/public/{cid}/car` 返回标准CARv1；网关 `/ipfs/{cid}?format=car`
按既有 raw-only 契约返回 406，不将其伪造为第二条 CAR 下载成功路径。

必须保留的失败：第一次探索试跑的带查询参数 legacy
CAR 请求实际返回 500，脚本因此中止；随即不带查询参数的同根请求为 200，之后正式六次同根 CAR 下载均成功。未取得该失败的请求级 trace，原因未定，不宣称已修复或整段验收无失败；没有据此改源码或重复发布。

相对 2026-11-04 最初 legacy 生产基线，当前 raw 总耗时中位约 1.61 倍（慢约 61%），CAR 约 0.93 倍（快约 7%）。这是同一字节内容的不同日期/版本网络测量，
**不是严格同条件改造前后性能因果对照**，不能用小 PNG 对比 3
MiB 目录宣称 CAR 索引加速。没有 R2 请求级 GET/HEAD/Range 操作遥测，不从时延或本地 counted
binding 推断生产操作数；没有取得实际 R2 对象字节与 D1 夹具增量空间。

### 历史证据可复用范围与剩余门限

- D-S01 保持已完成：历史 rollout、增量迁移及禁止回退旧 reader 的边界可复用，当前环境绑定已更新，不再执行历史发布/迁移。
- D-S02 / D-AC01 仍缺至少 128 小文件（含空文件、嵌套目录）及至少 8
  MiB 多块文件的指定规模、固定清单、Kubo 参数、原始 SHA-256 和新格式整包/块范围校验。当前 958 字节 indexed
  PNG 和 3 MiB legacy 目录不能替代它们。
- D-AC02 仍缺同条件旧/新格式的指定夹具对照、请求级真实 R2 操作数和明确空间取舍；现已切换生产，不为补基线回滚旧 reader，也不写 legacy 格式的生产测试后门。若原始基线无法恢复，应明确提请用户调整证据范围，不悄悄降低验收标准。
- 用户已有正常浏览器会话的交接不等于本轮新生产写入授权。新建公开合成夹具、临时授权或 Token、清理仅本轮资源，先明确范围；不触碰其他 session 的 CLI
  idea 或用户数据。
- 尚不满足 outer 提交条件，ledger 不新增完成勾选，不记录 `submitOuter` /
  `acceptOuter`。

## 2026-11-04 历史结论（非当前生产状态）

已通过既有 tag 流程发布并前向修复至 `release-261104-3`，Worker version
`33314a24-76ba-4093-b6f7-810d8d35bc05`，流量 100%。D1 增量迁移与最终 19 项公开 smoke 通过，旧 CAR 查询放大已修复并复测。未认证上传新内容、未创建或撤销应用 token；没有更改永久凭证、鉴权配置或发布工作流。尚不满足完整 outer 验收，不追加
`submitOuter` 或 `acceptOuter`。

**剩余验收阻塞：当前运行环境没有生产应用上传凭证，且共享浏览器没有已登录的 Google/Pinboard 会话。**
恢复条件是通过既有安全凭据通道向执行进程提供有效、最小范围的
`PINBOARD_AGENT_TOKEN`（上传 `pins:write`，清理自有 pin 另需
`pins:delete`，列表需
`pins:read`），或让可用的现有认证浏览器会话通过正常应用接口创建短期 token。此应用凭据只影响认证 smoke，不影响使用 GitHub
production
Environment 凭据的 tag 发布。不能用控制面 D1 权限插入 token、伪造 JWT 或绕过正常认证替代该前置条件。不要求在聊天中粘贴凭证，不要求修改永久 Cloudflare
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

## D1 只读 preflight（首次检查的历史记录）

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

**首次检查时迁移结果：未执行，错误地等待了仅 smoke 所需的应用认证前置条件。**
安全恢复顺序是重新观察 schema/迁移历史，确认仍只有 0002 待应用，再用现有独立授权的控制面身份执行
`pnpm --filter @workspace/worker exec wrangler d1 migrations apply DB --remote`，之后复核表/索引/外键/CHECK 及原有 pin 数量。不得重放 0001，不做破坏性清理。该命令仅是后续恢复步骤，不是已发生动作。

## 真实生产探测（首次检查的历史记录）

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

## Tag 发布、迁移与公开 smoke

用户澄清部署由 tag 触发后，先同步区分“发布凭据”和“应用上传凭据”的合同修订
`7e547ee1bab5854338a6509a6f6eb0a738ad251a`，再执行以下步骤：

- 复核只有 `0002_car_storage.sql` 待应用，使用现有 Wrangler
  OAuth 身份执行远端迁移。执行成功，两个 CAR 表、索引、外键及 CHECK 定义符合提交文件；`d1_migrations`
  同时登记 0001 与 0002；原有 pin 数保持 2，`PRAGMA foreign_key_check` 无结果。
- 发布前精确提交四平台 CI
  [41832307967](https://github.com/shazhou-ww/pinboard/actions/runs/41832307967)
  全部成功，项目 Wrangler dry-run 成功。
- 创建并推送 `release-261104-2`，指向上述已在 main 的准确提交。既有
  [部署工作流 41832774255](https://github.com/shazhou-ww/pinboard/actions/runs/41832774255)
  成功，包括完整 workspace 检查和 Worker/assets/secrets 部署。
- 控制面确认 deployment `68b0738c-9a1f-4d29-88d6-a6e86f840519`，Worker version
  `60cda13e-6a6c-4711-b716-b9423f9387e9`，100% 流量。

公开 smoke 对同一个既有 legacy 根执行 raw
GET 和 CAR 导出各 6 次，首轮为“冷候选”，后 5 轮为“暖重复”。切换前窗口
`2026-11-04T12:48:06Z` 至 `12:48:48Z`，切换后窗口 `12:52:17Z` 至
`12:53:28Z`；均为真实 HTTPS 生产请求。未返回 cf-cache-status 或 Age，不能证明平台内部冷缓存。

| 路径                              | 切换前暖重复 TTFB 中位 ms（范围） | 切换后暖重复 TTFB 中位 ms（范围） | 切换前总耗时中位 ms（范围） | 切换后总耗时中位 ms（范围）  |
| --------------------------------- | --------------------------------- | --------------------------------- | --------------------------- | ---------------------------- |
| legacy raw，165 字节              | 445.36（371.06–1253.06）          | 623.61（534.48–1416.35）          | 445.91（371.72–1253.52）    | 624.15（534.79–1416.91）     |
| legacy CAR，3,147,545 字节、18 块 | 5027.29（4754.55–8791.60）        | 9671.89（8005.56–10483.21）       | 5548.78（5255.24–10412.77） | 11351.81（9463.51–12089.41） |

切换前后 CAR SHA-256 均为
`4daf3f74323481fb5f97309165cfcf5d5cba0ee1cf01fb231cb5951e79b0b28a`；每次独立 CarReader 检查单一根、18 块及每块 SHA2-256 均通过。另 7 项公开检查覆盖 health、空探测块、匿名列表/上传 401、legacy 条件 GET
304、HEAD 空体及 provider 路由 200；合计 19 项断言通过。

性能不能宣称改善：legacy raw 总耗时中位约为旧版本的 1.40 倍，legacy
CAR 约为 2.05 倍。该测量不是新 CAR-only 路径性能证明。代码排查发现旧块兼容路径的逐块 D1 查询放大，已在 inner 中记录修复及重新审批要求；完整性能验收仍需发布修复后复测。原始同阶段 JSON 测量保存于本次 session 的
`files/car-public-before.json` 和 `files/car-public-after.json`，其中不含凭据。

发布后 `car_dags` 和 `car_blocks`
均为 0 行，原有 pin 仍为 2；没有新上传或回填。新格式认证上传、多小文件及 8
MiB 指定夹具的重建/对照、真实 R2 操作遥测与索引空间仍未完成，不能以旧内容兼容 smoke 代替。

## 前向修复发布与最终公开验证

旧 CAR 兼容路径修复经完整 `pnpm check` 20/20 任务及
[四平台 CI 41833944802](https://github.com/shazhou-ww/pinboard/actions/runs/41833944802)
通过；准确 innerRevision `1775f2780022ba0e56f5f0aaeb9f9bd90d0b9586`
重新提交并在授权范围内审批。随后使用新 tag `release-261104-3` 指向 main 提交
`9f4fc51e373b2c02458579c0a1a1b80a0bab90d4`，
[部署工作流 41834637980](https://github.com/shazhou-ww/pinboard/actions/runs/41834637980)
完整检查及部署成功。没有回退到旧 reader，也没有再次执行 schema 迁移。

控制面确认 deployment `14432fd9-cfea-4891-a95c-e143522b2ab3`，version
`33314a24-76ba-4093-b6f7-810d8d35bc05`，100% 流量，创建于
`2026-11-04T13:04:48.916286Z`。

最终复测窗口为 `2026-11-04T13:05:07Z` 至
`13:05:42Z`，使用相同 legacy 根、每类首轮冷候选及 5 次暖重复、相同字节与校验规则：

| 路径                              | 最终暖重复 TTFB 中位 ms（范围） | 最终总耗时中位 ms（范围）  | 相对最初生产基线总耗时中位 |
| --------------------------------- | ------------------------------- | -------------------------- | -------------------------- |
| legacy raw，165 字节              | 612.48（370.98–1434.34）        | 612.84（371.45–1434.86）   | 1.37 倍                    |
| legacy CAR，3,147,545 字节、18 块 | 4862.01（2451.72–5442.51）      | 5331.90（4156.11–6861.11） | 0.96 倍                    |

19 项公开 smoke 全部通过；CAR 和 raw
SHA-256 与前两轮一致，18 块 CID 均验证通过。整包中位耗时从首发的 11,351.81
ms 恢复到 5,331.90
ms；原始新格式性能仍未测量，不把旧内容结果当作新 CAR-only 路径证明。raw 仍有常量级索引查询开销，本次样本较最初中位慢约 37%，网络抖动较大，不能宣称所有路径都提速或据此单独归因。真实操作遥测未取得，不能用时延推算 R2 请求次数。

最终原始测量保留于同一 session 的
`files/car-public-fixed.json`。D-S01 已完成；D-S02、D-AC01、D-AC02 仍未完成，因为认证上传、新格式单块及整包重建、多小文件/8
MiB 指定样本对照和存储取舍证据还需有效应用认证。生产已经更新不代表可将 lifecycle 标记 completed。

## 前置检查时的发布身份（历史记录）

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
- 首次 preflight 时尚无 CAR 发布 tag/commit/WorkerVersion；之后两次实际 tag 发布见上文，不把初次阻塞误报为部署仍未发生。
