# Deployment

## Steps

### D-S01: 独立验证 Publication 标准读取

隔离环境使用专用测试密钥及 Publication，通过标准 HTTP 取得记录，独立验签、更新/回滚和 raw 内容读取；不使用真实私钥 fixture。

将已验收实现的 Worker bundle 启动为仅监听 `127.0.0.1`
的 workerd 服务，由独立 Node HTTP 客户端取记录，直接以名称中的 Ed25519 公钥校验
`ipns-signature:` 与签名 Data，校验 raw block
CID；拒绝篡改、错名及过期记录。在隔离 D1/R2 中验证私有权限、更新/回滚、删除/恢复及续签。停止运行时后复制一致的本地 D1/R2 持久化目录，以相同内存测试 master 从副本启动第二个运行时，验证名称、sequence 及新签名；不得把测试密钥写入证据。记录客户端/运行时版本、命令、请求名称、结果与环境限制；不以现有测试套件通过代替这些真实 HTTP 与离线恢复操作。

### D-S02: 按授权验证续签与目标环境

2026-11-13 用户已单独授权有界生产操作，并进一步指示一次性迁移/密钥配置直接使用 Cloudflare
token，不采用新的 GitHub 运维设施。按 [DirectRollout.md](DirectRollout.md)
核对既有目标、Windows DPAPI 加密备份及恢复能力后，再应用
`apps/worker/migrations/0010_publication_ipns.sql`（空表及索引，无回填），再按
`docs/publication-ipns.md` 配置独立 master
secret、备份恢复及外部续签告警，通过既有 tag-driven
workflow 发布并以专用测试数据验证、清理。不新增云资源、GitHub 运维 environment/token/workflow/scheduler；不把未批准的长期设施方案当作一次性迁移前提，也不降低真实密钥恢复与最终 D-AC02 的证明要求。缺少真正安全条件时停止，不得部署一个缺少 schema 的版本。

先在隔离环境演示每轮 32 条续签上限、失败事件及低于两小时 EOL 余量的观察结果；本地演示不是目标环境告警、调度 SLA 或负载容量证据。生产验收仍需明确授权：指定数据库的 additive
migration、独立 `IPNS_MASTER_KEY` secret 配置、既有 Worker 的 tag-driven
release、备份恢复演练及外部告警接收验证。该有界生产授权已由用户另行给出，不是从父 Agent 门限委托推断。只读预检和当前安全前提阻塞见
[ProductionPreflight.md](ProductionPreflight.md)；未具备条件时保留本项及 D-AC02 未完成，不提交 submitOuter。

## Acceptance criteria

### D-AC01: 标准指针可被外部验证

记录环境/客户端版本、请求名称、签名与 CID 校验及错误记录拒绝证据，不以返回 CID、JSON 或 HTTP
200 当作标准 IPNS 验证成功。

本项可由 D-S01 的隔离真实 HTTP 与独立客户端结果证明，不宣称生产上线。

已执行的隔离结果、精确环境及限制见
[IsolatedEvidence.md](IsolatedEvidence.md)；该证据绑定执行前已同步的契约 blob 与 probe 提交。

### D-AC02: 生命周期声明与实际结果一致

续签不需要用户发版本，缓存不过 EOL，删除关闭服务及续签，明确已缓存签名的剩余有效窗口；原业务历史和 raw 权限不回归。

部署证据须包括同一 master 与一致数据库备份恢复后名称不变及新记录独立验签，续签失败/cron 失败及低于两小时 EOL 余量告警，并确认每小时 32 条批次足够；这些外部验证未由本次仓库测试代替。

目标环境的授权、迁移/secret/release、真实调度、告警接收、备份恢复及容量余量均有证据后方可完成本项；隔离演示只能作为先行证据，不降低门限。

当前安全前提、已获授权范围、精确 SQL/影响及拟议安全顺序见
[TargetAuthorization.md](TargetAuthorization.md)。本项未完成，不提交 outer。
