# Deployment

本轮增量已实现、通过隔离环境验收，并由协调发布 session 完成生产 `0007`
迁移、`release-261106-3` 应用部署及 CLI `0.2.0` 发布。发布基准为
`0e421899c24e63c8b1aab2e78d04eee72910ee03`；其后 main 的 `e80138e`
卡片操作整合不包含在本次发布结果中，不以移动分支代表线上版本。当前证据已就绪，最终 outer 接受仍须用户明确决定。

用户已委托主 Agent 自主处理本轮全部门禁。主 Agent 须实际审阅实现、检查及客户端闭环后再记录对应阶段决定，不能预先写入未来版本验收。本轮优先在隔离 D1/R2 与真实浏览器完成转换、引用、描述快照和恢复验证，再同步最新 primary；既有生产 release 记录不能充当本轮结果，普通 main
push 不代表部署。

本轮应用增量的生产先决条件是经审阅的 `0007_descriptions.sql`，本地 SHA256 为
`a3bb890899b3866dcf77d48618608574bc59e8e7b2bf0e053d8e1fa27971e790`。它新增一张独立用户描述表，并给版本表增加带
`{}`
默认值的快照列；旧行和旧应用仍可读取，真实本地迁移测试已覆盖原有数据。该 SHA256 对应 CRLF 工作文件字节，不能与 Git 中 LF 字节的 hash 混用。生产操作由另一 session 在用户明确授权下执行，下方本轮证据替代此前待部署状态；本文旧 release 记录仅作历史背景。

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

本轮增量须实际验证外部文件到两类卡片、已有 Pin
link、无上传原位转换、菜单/触屏/键盘等价入口及取消/部分成功；分别读回普通 Pin 与固定 publication 版本的根/子节点描述，重建预览后复核用户文字和名字不变。

通过 Web、CLI、HTTP 和 MCP 的真实访问链路验证两种发布入口、当前 CID 的 NOP、历史 CID 重发、统一公开历史、固定链接、当前链接、回滚、协商缓存及最近删除与恢复，并确认既有上传、CID 分享和 Token 鉴权边界；在桌面与窄屏、触屏和键盘路径下验证统一卡片的辨识及管理操作。

### D-S03: 核验引用存活和运维可见性

本轮重点核验转换期间事务交接、删除/恢复不产生重复卡片、相同 CID 在不同根或账户的元数据隔离、源 Pin 到期后版本描述快照存活；生成预览的更新与回收不得清理持久用户描述。

在隔离测试数据上验证 Unpin 后的发布存活、30 天最近删除窗口、恢复与到期释放及最后引用的 GC 语义，检查发布失败、到期处理与 GC 异常的可定位证据；时间边界仅在可控的授权测试环境验证，不修改生产时钟或有效数据。

## Acceptance criteria

### D-AC01: 发布遵循现有授权与上线流程

#### 本轮生产及 CLI 发布证据（2026-11-06）

发布协调方在隔离工作区 `D:\Code\pinboard.worktrees\release-261106-3-validated`
完成集成和完整本地检查；[四组 CI](https://github.com/shazhou-ww/pinboard/actions/runs/42162632448)、[应用发布](https://github.com/shazhou-ww/pinboard/actions/runs/42163182996)
和 [npm 发布](https://github.com/shazhou-ww/pinboard/actions/runs/42163656358)
均成功。本 Agent 独立只读核对三个 workflow 的 `headSha` 均为
`0e421899c24e63c8b1aab2e78d04eee72910ee03`，并核对 annotated tags
`release-261106-3` 和 `@shazhou/pinboard@0.2.0`
均指向该 commit；未重复执行任何外部发布操作。

协调方报告并核验：使用本机已存在的 Wrangler OAuth，经原生
`d1 migrations list/time-travel/apply` 仅应用
`0007_descriptions.sql`，成功记录由 Wrangler 管理，不手工改写 migration
ledger。生产目标沿用本契约数据库；迁移前 bookmark 为
`00000079-00000000-0000511b-52676961c13e7dbec58008a4e76c0d6d`，迁移后为
`00000079-00000004-0000511b-57b1d25c57f2deacf312809365bb0191`。迁移记录完整为
`0001..0007`，新增表和版本描述列默认 `{}` 已读回，`PRAGMA foreign_key_check`
无违规。原有 7 个 Pin 的数量、总 size `922230`、总 blocks `77` 前后一致。OAuth
`0008` 未包含、未执行，生产 `oauth_grants` 没有
`access_ttl`；后续 OAuth 变更须单独授权。

协调方报告应用实际承载 100% 流量的 Worker version 为
`beade787-ea39-432c-89c4-c4eaf01c1665`。CLI `0.2.0` 的 npmX metadata 已核验
`latest=0.2.0`、provenance/trustedPublisher 为 true、stagedPublish 为 false，Sigstore
`logIndex=3709302546`，实际发布包 SHA512 为
`2fUVNDJvNCTp6kAmbfcv+gWg4gpehy6MNkKwo3cSVgacmy75XVvNKQyHyjH3GXNZbhaq1emilTn50eskSXS1Vw==`。本地模拟 tarball 烟测通过；发布后本机官方 npm
TLS 失败且镜像滞后，协调方改从 UNPKG 不可变 `0.2.0`
取得全部五个发布文件、逐项校验 SHA256，再以 native npm 离线安装，验证 Windows
shim 及新增 publication/description 命令帮助。此替代验证不冒称本机官方 registry 在线安装成功，临时文件已清理。

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

本轮协调方的真实生产冒烟：主页/bootstrap HTTP
200，匿名 pins/publications/node-description HTTP
401；使用现有授权 MCP 上传 32 字节合成文本，创建 publication
v1，再上传并发布 v2。公共 current 和两个固定版本的 raw
bytes 精确匹配，CAR 经 CLI `verifyCar` 验证 root CID 和块完整性，版本
`descriptions:{}` 可读。线上 `/assets/index-BcHgIBG5.js`
不含旧 Excerpt 标签，`/assets/index-JMtw9kJv.css`
包含二级目录连接线修复。此生产证据验证空描述快照和真实发布链路；根/子节点非空描述、转换和预览独立性的完整证明仍来自下方真实隔离集成验收，不将未执行的线上动作写为已验证。

本轮主 Agent 使用生产 Web 构建和编译 Worker 接入独立 Miniflare
D1/R2：Web 根与子节点描述写入/读回、已有 Pin 内部拖放 link、外部文件到两类卡片、取消零写入、无上传键盘菜单转换、发布失败后的真实上传保留均验证通过。转换得到原内容 v1、新上传内容 v2；普通 link 保留来源卡片/名字，发布目标名字不变。390
×
844 下描述详情宽 352，内部 clientWidth=scrollWidth=335；公开固定版本页面实际显示根/子描述及系统预览，背景图案保留且无横向溢出。本地网关只合成会话展示和 Token 列表，业务均调用真实编译服务；一次发布 409 为故障注入并明确标识，不冒充真实成功写入。

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

协调方将本轮两个合成测试 Pin 和一个 publication 通过标准 MCP/API 移入最近删除，随后该 publication 全部公开链接返回 404；未硬删用户数据，未绕过 30 天恢复窗口，未以生产时钟或 GC 破坏性测试清理内容。

本轮实际转换 publication 删除时，即使附旧条件请求仍返回 404；恢复原 ID 后子节点描述快照和预览重新可读，源固定卡片不重复复活。真实存储回归还覆盖转换事务失败完整回滚/安全重试、源描述修改与到期不改历史、其他账户/根隔离、预览重建/清理不碰用户文字。隔离 runtime 验证后已关闭，仅保留既有只读外观预览，无生产内容变更。

用隔离数据的读回结果、引用状态、到期时间与清理日志证明 Pin 和发布项删除保留 30 天、期内恢复保留原身份和版本、期满仅释放自身引用，发布引用保护完整内容和预览、释放最后引用才进入七天 GC 宽限期；不把 GC 当作恢复机制，不对生产有效内容执行破坏性清理测试。

真实 Miniflare
D1/R2 的可控时钟和并发暂停测试覆盖 30 天精确到期、重复删除不续期、恢复与到期竞争、源 Pin 到期后发布仍可读、多版本完整 DAG/CAR 和预览保留、独立发布引用保护以及最后引用释放后七天宽限期。旧独立块 Pin 的提升还验证了缺块、损坏、GC 抢占与安全重试。完整仓库检查通过，Worker
174 个测试通过、分支覆盖率 92.36%；既有故障注入用例明确检查可定位的保留清理错误，不吞掉失败。上述测试全部使用隔离数据，生产仅执行已授权新增 schema 和只读核验。
