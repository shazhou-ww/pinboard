# 目标环境授权、持续安全前提与执行顺序

## 当前边界

门限审阅与验收已委托父 Agent。2026-11-13 用户另通过结构化选择明确回答“授权上述有界生产操作”，授权核对既有目标及备份、仅执行 0010、安全配置及备份独立 master、既有 release
tag 工作流发布，以及专用测试数据的线上验证与清理。目标恢复演练和告警验证仅可用获准的既有设施，不创建新云资源；缺少安全条件时停止。该新增授权与此前的门限委托分开记录。

下面的操作范围已经获准，但安全前提仍须逐项建立，不能因获准就跳过一致备份、可恢复 master 托管或受限恢复条件。生产结果不能由隔离环境结果推定。本轮只读预检与停止原因见
[ProductionPreflight.md](ProductionPreflight.md)；尚未执行迁移、生产 master 生成/配置、release 或线上测试数据变更。

配置所指的既有目标为 Cloudflare account
`92c3c4fdcc84a1590555bccf4f111de2`，Worker `pinboard`，D1 `pinboard` /
`9f15fd50-e103-459f-9f3f-9db3036f91de`，私有 R2
`pinboard-blocks`。本轮已用只读控制面核对目标、schema 及 secret 名称，未读取 secret 值、导出业务数据或创建资源。

## 已获授权范围与持续安全前提

- 只读核对上述目标的 schema、迁移历史、已部署版本与备份状态；以目标批准的方式创建一致 D1/R2 备份，并限制访问。
- 对上述 D1 应用且仅应用
  `0010_publication_ipns.sql`；如 schema 已有或部分存在，先停止并核对，不盲跑所有 migrations。
- 经受保护的 secret manager/输入通道生成及配置独立的
  `IPNS_MASTER_KEY`（32 随机字节、64 hex），与 `AUTH_SECRET`
  分离。不把值放入仓库、日志、命令参数或回复；备份 secret 与数据库分离。secret 操作可能形成新的 Worker
  version/deployment，须把该影响纳入授权。
- 对已在刷新后 `origin/main`、CI 通过的精确提交创建并推送 `release-YYMMDD-INDEX`
  annotated
  tag，由既有生产 workflow 部署。日期须有效、INDEX 使用该日下一个未用正整数；不新增触发器、不改版本号。
- 在目标使用专门验证账户、临时 Publication/CID 的有界 smoke 数据变更，验证真实 HTTPS 的标准记录、独立验签、raw
  CID、权限、发布/回滚、删除/恢复及恢复后名称。测试数据的创建、清理也需要纳入授权。
- 在获准的受限恢复环境中用目标备份与同一 master 做恢复演练；验证新签名且不能从陈旧 sequence 恢复运行。配置并实际触发既有外部告警通道，覆盖续签失败、cron 失败及 live
  EOL headroom 小于两小时，核对 eligible backlog 与 32
  renewals/hour 的容量余量。不得默认为此创建新资源。

以上范围的有界授权已经到位；未授权新建云资源、扩权或为通过门限任意改写既有 billing 告警。必须先明确现成的受限 D1/R2 备份位置、master 可恢复托管通道、恢复目标与 IPNS 告警设施，再继续任何可能触发部署或改变数据库的操作。

## 精确 SQL 与影响

与 `apps/worker/migrations/0010_publication_ipns.sql` 一致：

```sql
CREATE TABLE publication_ipns (
  publication_id TEXT PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE,
  name TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL CHECK(length(public_key) = 36),
  key_version INTEGER NOT NULL DEFAULT 1 CHECK(key_version = 1),
  encrypted_key BLOB NOT NULL CHECK(length(encrypted_key) > 16),
  nonce BLOB NOT NULL CHECK(length(nonce) = 12),
  record BLOB NOT NULL CHECK(length(record) > 0 AND length(record) <= 10240),
  record_cid TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence >= 0 AND sequence <= 9007199254740991),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  expires_at INTEGER NOT NULL,
  retry_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX publication_ipns_renewal ON publication_ipns(retry_at, expires_at, publication_id);
```

仅增加空表及续签索引，不回填、不生成密钥、不修改既有 Publication/CID/ 权限/历史，也不迁移 R2。后续 Publication 最终删除会通过外键级联删除对应 binding；加密私钥、nonce、记录及 sequence 此后只存在于适用备份。SQL 的 CREATE 非幂等，不能在未知 schema 上重复执行。新代码即使没有启用 IPNS 的 Publication 也会读取该表，所以必须先迁移、后部署代码。

目标 schema 核对及备份完成后，拟执行的定点迁移命令（**未执行**）：

```powershell
pnpm --filter @shazhou/pinboard-worker exec wrangler d1 execute pinboard --remote --config wrangler.jsonc --file migrations\0010_publication_ipns.sql
```

这不是 release workflow 的步骤，不应为部署 token 扩大 D1 管理权限。

## 安全顺序与回退

1. 父 Agent 确认精确目标、操作范围及授权；核对 schema/版本/备份，确定验证账户、告警接收方和中止条件。
2. 取得受限、一致且可恢复的 D1/R2 备份；托管 master 的独立安全备份。应用上述 additive
   SQL 并核对表、约束、外键及索引，不对未知结构自行修补。
3. 经批准的 secret 通道配置 master，保留原 AUTH 与 OAuth 配置；由 release
   workflow 发布已验证 main 提交，不做分支推送部署。
4. 只用获准验证账户进行 smoke；核对 signature/name/CID/sequence/EOL、私有负例与删除剩余有效窗口。配置并演练外部告警，观察实际 hourly
   cron；用容量与 backlog 数据决定是否允许更多绑定，不能只看 HTTP 200。
5. 在隔离恢复环境完成目标备份恢复与同 master 新签名证明后，补齐 D-S02 /
   D-AC02 证据，再由父 Agent 审阅精确 deploymentRevision。

任一核对失败即停止，不删除表、密钥或业务记录，不重置 sequence。迁移前停止没有 schema 影响；空表迁移后尚未启用时可暂缓代码发布并保留 additive
schema。代码回退须选择已核对的 retention/visibility-aware 既有版本，保留表及 master；不得回到不保护 Publication 保留引用或私有权限的旧代码。已有真实名称后优先 forward-fix；若必须暂停标准接口/签名，明确通知可用性中断，保留同一身份与备份，不能以丢弃密钥或数据库回滚“恢复”可验证历史。已下载签名最长仍可有效至各自 EOL，TTL 不是撤销；旧 CID/副本也不能远程抹除。secret 泄露时停止受影响签名/服务并走单独事件处置授权，不直接覆盖 master。

## 尚未满足的门限

有界生产操作授权已到位，当前阻塞是未建立可用的安全备份/托管/受限恢复及既有 IPNS 告警条件，不再称为“缺少生产授权”。目标迁移/secret/release、目标 hourly
cron/告警接收、真实目标备份恢复、容量余量与外部 HTTPS
smoke 仍未执行或证明。因此 D-S02 与 D-AC02 保持未完成；不写 `submitOuter` 或
`acceptOuter`，不以门限委托或生产授权推定执行完成。
