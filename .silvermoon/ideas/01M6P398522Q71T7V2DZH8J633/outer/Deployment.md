# Deployment

本轮增量尚未实施或部署：后续须针对卡片拖放、已有 Pin
link、原位转换及节点 description/preview 独立性重新验收。本文已有 release 与 migration 证据保留为首轮历史，不代表本轮上线；新增数据模型的迁移范围、生产发布及描述公开边界应在方案明确后重新核定。

外部工作先完成隔离本地环境的功能与界面验证及生产 D1 的向后兼容 schema 准备，随后按 2026-11-06 的新增授权发布生产应用。用户于 2026-11-05 明确授权本功能所需的数据迁移，可使用 cfg 中的 Cloudflare
token，无需再次审批；该授权不包括删除现有生产数据、重建数据库、修改线上时钟或执行生产清理测试，也不自动授权生产应用发布及 release 标签。

## Steps

2026-11-06 首次上线后的反馈要求补齐上传创建入口及另一个 session 的背景改动。修复时合并已提交背景分支，重新同步最新 main、验证后发布下一未使用的同日 annotated
release
tag；线上必须确认新的上传创建选项、公开标题提示、背景图案和设置配色实际送达，不以旧发布成功证明修复已上线。

用户于 2026-11-06 明确要求部署生产应用，并要求优先合并最新代码。本轮先 fetch 并合并
`origin/main`，确认包含完整发布实现和已验证迁移，再以 main 上通过检查的 commit 创建下一个未使用的
`release-261106-INDEX` annotated tag，由现有 GitHub
production 工作流部署。部署前复核迁移已应用及外键无违规；部署后核验工作流、版本标识、静态资源、健康检查、发布路由及匿名写入拒绝。不重复迁移、不发布 npm、不把部署授权视为对尚未产生的线上结果的验收。

### D-S01: 确认授权环境和上线前提

依现有部署指南确认目标环境、数据保护和回退条件。生产目标为现有 pinboard
D1 数据库，ID 为 9f15fd50-e103-459f-9f3f-9db3036f91de；先核实新增迁移内容和当前迁移记录，验证兼容当前线上代码，再取得迁移前 Time
Travel
bookmark 并执行已授权迁移。凭据仅在子进程环境中传递，不写入文件或日志。生产应用发布保持独立授权边界。

### D-S02: 在授权环境验证发布闭环

通过 Web、CLI、HTTP 和 MCP 的真实访问链路验证两种发布入口、当前 CID 的 NOP、历史 CID 重发、统一公开历史、固定链接、当前链接、回滚、协商缓存及最近删除与恢复，并确认既有上传、CID 分享和 Token 鉴权边界；在桌面与窄屏、触屏和键盘路径下验证统一卡片的辨识及管理操作。

### D-S03: 核验引用存活和运维可见性

在隔离测试数据上验证 Unpin 后的发布存活、30 天最近删除窗口、恢复与到期释放及最后引用的 GC 语义，检查发布失败、到期处理与 GC 异常的可定位证据；时间边界仅在可控的授权测试环境验证，不修改生产时钟或有效数据。

## Acceptance criteria

### D-AC01: 发布遵循现有授权与上线流程

记录目标版本和本地验证环境，保留用户对本次生产迁移的授权依据、迁移前 bookmark、实际应用的迁移名及迁移后 schema、迁移记录和线上只读健康检查结果。只允许本功能经审阅的向后兼容迁移，不夹带其他待应用迁移；如另获生产应用发布授权，仍须提供符合标签驱动流程的发布证据，不以 schema 准备冒充功能已上线。

实现版本为
`64138b8a6b06447c8e7eac8eb4b3c4a74b7d145b`，已同步 primary。2026-11-05 16:51:21
UTC 以已授权凭据核对生产数据库身份并取得迁移前 bookmark：
`00000057-00000000-0000511a-2f0489cd72e716b7beb23f7b57894a2d`。执行文件
[0006_publications.sql](../../../../apps/worker/migrations/0006_publications.sql)
的 SHA256 为
`13c44a39849692e18e55a1dc2b16296555be278d1e9e3d055b970f3953ba4611`；迁移前只有此项待应用，Wrangler
4.151.0 在 16:51:27 UTC 完成应用，最终无待应用迁移。

迁移后确认六张新增表
`deleted_pins`、`publications`、`publication_revisions`、`publication_retention`、`publication_requests`、`publication_operations`
和 `retained_roots`
视图均存在；逐项比较迁移前已有 schema 定义，全部未改变。`PRAGMA foreign_key_check`
为零违规，六张新表均为空，未对生产内容执行写入测试。16:51:36 UTC 线上
`/api/health` 返回 HTTP
200、`{"service":"Pinboard","status":"ok"}`。本轮没有创建 release 标签、发布 Worker 或发布 npm 包，生产功能仍由原应用版本提供；[部署指南](../../../../docs/deployment.md)
记录了启用新引用后不可退回旧保留逻辑的边界。

### D-AC02: 实际客户端访问符合发布约定

反馈修正版已发布为 `release-261106-2`，tag 指向同步且四组 CI 全部通过的
`b249d8bb2b7dc2b9f2e84eb60c06b567412971c9`，包含背景提交 `20e6095` 的合并历史。
[修正版 CI](https://github.com/shazhou-ww/pinboard/actions/runs/42141142392) 和
[修正版生产工作流](https://github.com/shazhou-ww/pinboard/actions/runs/42141816906)
全部通过，01:11:04 UTC 部署版本 `2dde482f-8ac5-4ca1-8352-47ef0cee2988`。线上 JS
`/assets/index-CCLOtKgm.js` 已包含上传创建及公开标题表单和背景设置，CSS
`/assets/index-BoABbdyR.css` 引用
`/assets/pinboard-pattern-5qimH7d_.svg`，图案资源实际返回 HTTP 200 /
SVG。真实生产浏览器的根元素为默认 `mist` 配色，computed
background 同时含该 SVG、两层径向渐变及线性渐变；健康检查为 200。本地真实组件浏览器验证了空账户的两种上传选项、公开标题必填、上传创建请求、背景配色保存及刷新持久化，网络写入仅使用本地 fixture。上线未再次迁移或写入生产测试内容。

2026-11-06 生产应用发布证据：部署前先 fetch 并合并最新 main（无遗漏提交），在
`9ae2d5252e39ba37863e8a0d30ba56d0b723e3ad` 完成四组 Windows/Linux、Node 22/24
[CI](https://github.com/shazhou-ww/pinboard/actions/runs/42137815200)，本地完整检查也通过。一次 Windows
CI 出现 5 秒测试超时及本地 Miniflare 连接失败，仅重跑失败任务后全部通过，不跳过检查或改写安全保护。已在该 primary
commit 创建并推送 annotated tag `release-261106-1`；
[生产工作流](https://github.com/shazhou-ww/pinboard/actions/runs/42139021128)
全部通过，于 00:46:24 UTC 部署 Worker 版本
`14c1aefb-3c51-4306-a7ac-cbded5049295`，独立查询部署记录确认该版本承载 100% 流量，定时任务保持
`17 * * * *`。

线上
`/api/health`、首页、发布 SPA 路径及实际 JS 静态资源均返回 200，生产 bundle 包含发布详情和最近删除 UI。真实浏览器确认首页登录入口正常、缺失发布项显示明确错误。管理列表和恢复列表匿名访问返回 401；写入缺 Origin 返回 403，同源匿名写入返回 401。缺失发布项的历史、固定版本、下载及预览返回 404，附
`If-None-Match: *` 仍返回 404 而非 304；公开发布错误响应保留
`public, no-cache`。OAuth metadata 包含 `publications:read` 与
`publications:write`。部署前再次确认 `0006_publications.sql`
已应用、无待迁移项、外键零违规，本轮未重复执行 migration。线上冒烟不创建生产内容或伪造会话；已认证写入闭环沿用前述真实隔离客户端证据，生产登录后的内容管理由用户实际体验验收。该发布请求是部署授权，不记录尚未明确作出的
`acceptOuter`。

保留全部入口的真实 HTTP 状态、ETag 和客户端结果，证明当前 CID 重发为 NOP、非当前历史 CID 重发创建新版本，历史读取不区分登录状态，发布与回滚更新当前入口、固定内容不变、未变化响应为 304、最近删除后全部发布解析入口不可用且不返回旧状态的 304、恢复后原链接重新可用；以实际界面证据证明两类卡片尺寸一致、版本可辨、复制无歧义及最近删除可恢复。

证据由主 Agent 独立检查：[真实 HTTP/MCP 与 D1/R2 测试](../../../../apps/worker/test/publications.test.ts)、
[编译 CLI 到编译 Worker 的 HTTP 集成](../../../../apps/worker/test/cli.test.ts)
及生产构建 Web 的真实 Chrome 闭环。浏览器中实际创建 v1、上传生成 v2、回滚而不增加版本、删除后历史 404、恢复原身份与版本、普通 Pin
Unpin 与恢复全部成功；身份仅在隔离本地测试网关合成，不改产品鉴权。另以 1440 ×
1000 与 390 ×
844 的真实浏览器检查统一卡片、窄屏无溢出、键盘焦点和真实触屏菜单。供次日查看的
`http://127.0.0.1:5188/#preview`
为只读外观预览，修改操作明确拒绝；不把该 fixture 当作持久写入或生产功能证明。

### D-AC03: 已发布内容不因普通 Unpin 丢失

用隔离数据的读回结果、引用状态、到期时间与清理日志证明 Pin 和发布项删除保留 30 天、期内恢复保留原身份和版本、期满仅释放自身引用，发布引用保护完整内容和预览、释放最后引用才进入七天 GC 宽限期；不把 GC 当作恢复机制，不对生产有效内容执行破坏性清理测试。

真实 Miniflare
D1/R2 的可控时钟和并发暂停测试覆盖 30 天精确到期、重复删除不续期、恢复与到期竞争、源 Pin 到期后发布仍可读、多版本完整 DAG/CAR 和预览保留、独立发布引用保护以及最后引用释放后七天宽限期。旧独立块 Pin 的提升还验证了缺块、损坏、GC 抢占与安全重试。完整仓库检查通过，Worker
174 个测试通过、分支覆盖率 92.36%；既有故障注入用例明确检查可定位的保留清理错误，不吞掉失败。上述测试全部使用隔离数据，生产仅执行已授权新增 schema 和只读核验。
