# 最小设施建议：待确认，不执行

**后续用户方向：不采用本提案。** 用户明确要求一次性迁移及配置直接通过 Cloudflare
token 执行，不新增 GitHub 运维设施。当前实际执行方式见
[DirectRollout.md](DirectRollout.md)；本文件只保留历史提案，不能作为已授权资源、24h 恢复窗口、费用或 SLA 的依据。

## 建议结论

建议复用 **D1 Time Travel + 现有 R2 + GitHub
Actions/Secrets/Artifacts**，不先建新的 Cloudflare Worker、D1、R2
bucket、Secrets Store 或 Workflows。新增一个专用运维 API
token、一个 GitHub 运维 environment 及少量 secret/
workflow 配置，即可构成小规模 IPNS 的首版备份、受限恢复和告警闭环。

这是供父 Agent 审阅后提请用户确认的方案，不是已批准的实施。当前继续保持生产写入停止；不修改 Inner
World、应用、工作流、门限或 ledger。已有生产操作授权并未撤销，但用户本轮明确要求先看设施方案、不创建资源。

## 已知事实，不重复读取生产

- 先前只读预检已确认目标匹配、0010 表及 master 不存在、Cloudflare Secrets
  Store 为空、Notification policies 只有 billing 类型。
- 本轮仅补充 GitHub 设施元数据：仓库为 **public**；现有 `production`
  environment 的
  `protection_rules=[]`、`deployment_branch_policy=null`。因此不能在未加保护前就把新 master 填进该 environment。
- `cfg` 是已有 Cloudflare
  credential 来源，不等于缺少操作凭据。本轮按提示将单个 token 的命令输出捕获到进程变量，尝试 GET 公开权限目录，未成功取得目录；没有输出值、传入命令行参数、加载完整 cfg
  dump、换用其他 credential 或推断失败根因。此路径停止，不影响通过官方公开文档拟定方案；后续执行时再单独验证安全取值和最小权限。
- 本轮没有 D1 导出、备份任务启动、SQL 写入、secret 生成/配置、云资源创建、生产测试数据变更或 release/tag 操作。

## 推荐的最小组合

| 需要解决的问题          | 推荐做法                                                                                                                                                          | 新增/修改量                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 数据库可恢复状态        | 复用已启用的 D1 Time Travel；迁移前和首个 IPNS smoke 后各做一份完整、一致 SQL export，之后每日低峰导出；导出立即加密后才上传 GitHub Artifact                      | 无新 Cloudflare 存储资源；新增一个备份 job，最多保留 7 份、每份上限 50 MiB，超限停止并告警                                           |
| master 独立托管         | Cloudflare 运行时持有生产 master；**独立于 Cloudflare 的 GitHub `production` secret** 保存同一 master 的恢复副本；备份解密私钥为另一个 secret，不使用 AUTH_SECRET | `IPNS_MASTER_KEY`、`IPNS_BACKUP_AGE_KEY` 两项；公开 age recipient 可放非 secret 配置；建议操作者另在已有密码管理器留一份离线恢复副本 |
| 安全的持续运维          | 新建 `pinboard-ops` GitHub environment，仅允许 main；只放专用 token，不放 master/备份解密私钥                                                                     | 一个 GitHub environment + 一个 token secret；不是新增 Cloudflare compute/storage                                                     |
| 受限恢复演练            | 审批后的手动 Actions job，在一次性 runner 中恢复真实加密备份到本地 D1/workerd；仅回环监听、不接公网、无自动 cron、不写生产 DB/R2                                  | 复用 hosted runner，不建远端 restore Worker/D1；完成后销毁本轮数据                                                                   |
| 续签/cron/headroom 告警 | 同一个运维 workflow 每 30 分钟查询既有 Worker 日志与 D1 聚合状态；异常令 job 失败，通过指定 GitHub 账户的 Actions email 通知送达                                  | 一个 monitor job，复用 GitHub 通知，不改 billing policies、不新增邮件服务/Cloudflare policy                                          |

### 必须先加的密钥访问保护

在现有 `production` environment 上明确 required reviewer，只允许已验证 main 和
`release-*`
ref；备份解密/恢复与部署均需审批。指定真实 reviewer 及是否允许 self-review，不能假设项目已有第二名维护者。这会改变现有 release 的审批体验，必须纳入本次确认，不能静默启用。

`pinboard-ops`
的自动 job 只拿必要运维 token，不拿 master 或 age 私钥。保护 environment/固定已审阅 workflow、固定第三方 Action/binary 校验，不在 PR、fork 或任意 ref 上运行带生产 credential 的任务。GitHub
Secrets 的 API 不直接回读明文，但**受批准的 workflow 可以恢复读取**；要以一次真实 round-trip 证明可恢复，不能仅凭 secret 名称存在就放行。

## R2：不必为了 0010 先复制整个 bucket

0010 只增加空 D1 表/索引，不写 R2。现有存储的 CAR
key 是不可复用的随机 UUID，完整 R2 PUT 在 D1 索引提交之前完成；已被 live
Pin/Publication 引用的对象不会被应用 GC 删除，最后引用释放后还有至少 7 天宽限。相关事实见
`docs/storage.md`、`apps/worker/src/storage.ts`、
`apps/worker/src/retention.ts`，不是从对象名字猜测。

因此推荐先采用**限定的逻辑恢复窗口**：

- 以完整 D1 export 的同一 `at_bookmark`
  为状态点，从该快照导出 live/recoverable 根实际依赖的 ready 物理 R2
  key/长度/CID 清单；不能拿 export 前后不同时间的多个 SELECT 拼成一致清单。
- 保证无额外 R2
  lifecycle、人工删除、覆盖或外部清理绕过上述保留协议，并核对快照依赖对象存在。该条件必须在实际执行时验证。
- 约定 **备份 RPO 至多 24 小时、开始恢复时快照年龄至多 24 小时、目标 RTO
  4 小时**；小于七天宽限并留出充分余量。这是拟议运行目标，不是已证明的 SLA。
- 恢复从快照还原 D1，并使用仍在原 R2 中的精确 immutable
  objects；演练另把专用 smoke 的少量精确 CAR 与清单一起加密保存，核对原 key、长度、每块 CID 和 D1
  offset 后在受限 runner 中读取。不把“同一逻辑 CID 重新打的另一个 CAR”冒充原字节布局。
- 快照中的旧 unreferenced/deleting 对象不自动享有此保证；清单须覆盖所有可恢复业务引用所需字节，包括必要的 legacy
  provider。如果依赖闭包或保留条件无法证明，就停止使用该优化。

**该方案防的是迁移/索引/操作失误的短窗口恢复，不防整个 R2
bucket 丢失、Cloudflare 账户丢失、人工删除或对象损坏。**
它不是异地全量内容灾备，也不把 D1 Time
Travel 的 7/30 天误称为同样长的 R2 恢复窗口。这项边界需要用户明确选择；本方案不据此悄悄改写现有验收标准。

若要求上述额外灾难场景，则有一个实质替代：另授权
**一个私有备份 bucket/独立存储目的地及受限读写凭据**，复制快照实际引用的精确对象，验证完整性与独立恢复；不必复制完全无关的 orphan/过期垃圾。这会增加存储、请求、权限与维护成本，不是首选默认项。

## 一致备份、恢复与 sequence 安全

导出必须覆盖业务表、revision/retention/索引和
`publication_ipns`，包含加密私钥、nonce、名称与 sequence；不能只备份单个 IPNS 表。公开 Artifact 只存
**age 加密后的 bundle**，不存明文 SQL、账户/CID 清单、解密密钥或 master；密码型遮罩不是加密。本方案选择公开 recipient 加密，使自动备份 job 不需要任何解密私钥。

D1
export 在运行期间会阻塞数据库请求，需获准低峰维护窗口，首次测量影响后再启用每日任务。建议一次维护窗口上限 60 秒；遇超时/失败停止并告警，不为凑备份删除表或禁用校验。Time
Travel 始终启用、无额外恢复费，但 Free/Paid 的历史窗口为 7/30 天；其 restore 是**原地破坏性覆盖**，也不是 clone。本方案绝不用生产 Time
Travel restore 来“证明演练成功”。

真实恢复演练从实际备份取得数据，用同一 master，只对被冻结的专用 smoke
Publication 在回环环境生成新签名、独立验签，核对名称、sequence、CID、raw 读取及私有拒绝；不向公网分发恢复记录。解除冻结前比较生产最新状态；不向旧快照续签并继续生产。真事故时必须找到权威最新 sequence/high-water 状态，无法核对就保持停签，不能用“24 小时 RPO”当作允许降低 IPNS
sequence 的理由。

## 凭据与告警的具体建议

### 一个专用 token，不把 cfg 的 bootstrap token 放进 Actions

拟新建
`pinboard-ipns-ops`，限制到既有目标 account，初始建议有效期 90 天并有到期通知。所需能力：

- `D1 Read`：只运行固定 UUID 的聚合 SELECT；导出能力须对 export
  endpoint 单独验证，不因 query 可用就假设 export 可用。若实际 API 要求更高权限，先报差异；不得自动给 D1
  Write。
- `Workers Observability Write`：官方日志 **query** endpoint 的实际 accepted
  permission 名称就是 Write；不能宣传它是纯 Read 权限。仅使用 ad-hoc 查询，不保存/改写其他监控对象。
- 不授予 Workers Scripts Write、secret 写、D1 Write、R2
  Write、DNS/Routes 或其他账户权限。

这些 permission 可能只能做到 account scope，脚本过滤 `pinboard` / 固定 DB UUID
**不是服务端资源隔离**。用户须确认这一最小 API 可用范围；如不接受，就另选人工本机查询或单独设计受限监控接口，不能偷偷扩大权限。现有 cfg 凭据仅用于获准的一次性控制操作/安全预检，只在进程中捕获、官方 API
header 中使用，不通过 CLI 参数、日志或完整 dump 传递。

### 一条通知通道，而不是新增一套监控平台

默认每 30 分钟、避开整点运行，检查：

- 过去窗口存在 `ipns_renewal_failed` 或 scheduled invocation failure；
- 最近成功 hourly cron 距今超过 90 分钟；
- live 绑定有 expired、最小 EOL
  headroom 小于两小时，或 retry/backlog 按 32/小时处理无法在最老 EOL 前留足余量；
- API 无法查询、token 将到期、最新成功备份超过 24 小时。

只输出聚合数字与脱敏原因，不输出名称、账户、CID、SQL 数据或 secret。使用一个明确的 GitHub 账户启用 Actions 的失败 email 通知，并让该账户成为实际 schedule
actor；要做标记的测试事件投递并确认收件。不会改写现有 billing 告警来冒充 IPNS 告警。

GitHub 明确说明 schedule 可能延迟甚至丢弃，public
repo 无活动 60 天会禁用 schedule，通知收件人还会随 cron 修改者/重新启用者变化。因此这是**低运维、best-effort 的小规模默认项**；监控器自身完全失效时不能自报，不能称为严格两小时响应 SLA。如用户需要独立 dead-man/值班保障，需要另授权外部接收/心跳设施，不偷偷包含在“最小方案”中。

## 上线前硬前提与完整 Outer 后续，分开安排

**任何 0010/可能部署的 secret 操作之前：**

1. 用户确认本方案的范围、恢复窗口、通知/审批人及维护窗口。
2. 设施/运维代码经单独审阅测试后才实施；现有 Inner 标准不因本提案改变。
3. 建立受保护 escrow 与可恢复的加密完整 D1
   backup，完成解密/受限导入检查及 R2 引用闭包/保留条件核对。
4. 检查真实 schema/迁移历史，只有上述前提满足才执行已授权的精确 0010。
5. master 从安全通道产生并存入受保护 escrow，做恢复读取检查；在既有 release
   workflow 的原子 secrets-file 中增加该一项，随已验证 release 一同发布，避免先
   `secret put` 意外部署旧代码。

**部署后仍必须完成，不能以设施存在替代：**

- 专用线上账户的标准 HTTP/独立验签/更新回滚/raw/私有与删除恢复冒烟；
- 对真实 IPNS 备份同 master 恢复，名称及新签名保持；
- 实际 hourly cron 观察、目标 backlog/容量余量与外部告警送达证明；
- 验证测试数据清理、证据准确，父 Agent 再评审精确 Outer revision。

部署初期不批量为既有 Publication 启用 IPNS；先只启用获准 smoke 绑定，验证告警及真实续签后再扩大使用。D-S02
/ D-AC02 仍未完成，当前不提交 Outer，也不请求或记录任何验收。

## 费用、负担和需要确认的最少决定

标准 hosted runner 在本 **public**
仓库的计算用量免费；每 30 分钟约 1,440 次 monitor/月、约 30 次 backup/月，另有手动恢复/演练。Artifact 有存储/保留配额或计费规则，按上述上限最多 350
MiB；Cloudflare 仍有现有日志/API/D1 读取成本。本轮未查询账单/可用额度，不承诺新增费用必为零。建议约束：只用既有免费/已付额度，不升级套餐；超出先停止并报告。日常负担是维护 token、备份健康、schedule
actor/通知设置及周期恢复演练。

供父 Agent 提请用户确认的最小集合：

1. 是否同意 **不新增 Cloudflare compute/storage**，但新增 **1 个专用 API
   token、1 个 GitHub ops environment**，并配置上述两个恢复 secret、一个 ops
   token secret、加密 Artifact、backup/restore/monitor workflow、现有 production
   environment 访问保护？既有 release
   workflow 仅增加 master 的安全传入，不新增部署触发器。
2. 是否接受
   **24 小时逻辑恢复窗口，R2 原对象保留而非 bucket 灾备**？若不接受，是否改为额外批准一个私有备份存储目的地及引用对象复制？
3. 指定哪个 GitHub 账户负责
   **审批及失败通知**，是否有现成密码管理器可留离线恢复副本；是否接受 best-effort 通知、每日低峰短暂 export 阻塞及只用现有额度的约束？

这三项是设施及风险选择，不是重复要求泛化生产授权，也不是 Outer 验收。当前只保存提案；没有创建任何上述资源、密钥、job 或配置。

## 核实依据

- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)：always-on、Free/Paid
  7/30 天、无额外恢复费、restore 原地覆盖、不能当 clone。
- [D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
  /
  [API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)：完整导出及
  `at_bookmark`、运行期间阻塞查询。
- [Observability query](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)：accepted
  permission 为 `Workers Observability Write`。
- [GitHub Secrets](https://docs.github.com/en/actions/concepts/security/secrets)：入站 sealed-box 加密、workflow 可注入、environment
  reviewer 可保护访问。
- [Actions 通知](https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs)
  /
  [schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)：actor/收件人、延迟/丢弃及 public
  repo 60 天禁用。
- [Actions 费用](https://docs.github.com/en/billing/concepts/product-billing/github-actions)：public
  repo 标准 runner 计算免费；不要由此推定所有存储和外部服务都免费。
