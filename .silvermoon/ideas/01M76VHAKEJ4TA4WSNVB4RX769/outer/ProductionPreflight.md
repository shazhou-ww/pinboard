# 有界生产授权后的只读预检与安全停止

本文件保留为 `2026-11-13T14:16:56+08:00` 的历史预检快照。后续 `release-261113-2`
已完成迁移/secret 配置及发布；最新只读核对、真实生产 HTTPS 验证与仍缺的恢复/告警证明见
[ProductionEvidence.md](ProductionEvidence.md)，不要将下面的历史未执行状态当作当前状态。

## 授权与结果边界

2026-11-13 用户对父 Agent 的完整有界问题明确选择“授权上述有界生产操作”。范围包含既有目标/备份核对、仅 0010 增量迁移、独立 master 的安全配置与备份、既有 release
tag
workflow、专用测试数据线上验证与清理；恢复/告警只能用获准既有设施，不得创建新云资源，缺少安全条件时停止。门限仍由父 Agent 评审。

本轮已执行**只读生产控制面与健康核对**，但安全备份/可恢复 master托管/受限恢复及既有 IPNS 告警条件尚未建立，所以在任何生产写入之前停止。不是撤销或忽略新增授权，也不再将“用户未授权”列为阻塞。本轮没有生产迁移、master 生成/配置、secret 写入、Worker 发布、release
tag、线上测试数据创建/修改/清理或云资源创建。

观测记录的本机时间锚点为 `2026-11-13T14:16:56.1989130+08:00`；被检仓库 HEAD 为
`153e9c2a4357801c8ed191491b92facacdcf0fdb`。没有获取或输出任何 secret 值。

## 已完成的只读核对

| 项目                          | 实际结果                                                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目标 D1                       | account `92c3c4fdcc84a1590555bccf4f111de2`，database `9f15fd50-e103-459f-9f3f-9db3036f91de`，名称 `pinboard`，版本 `production`；与配置吻合                      |
| Worker 绑定                   | `pinboard` 的 DB 指向上述 UUID，BLOCKS 指向 `pinboard-blocks`；compatibility date `2026-10-14`，flag `nodejs_compat`；没有目标错配                               |
| schema                        | `publications` 与 `publication_revisions` 存在，已有 visibility/descriptions；`d1_migrations` 存在；`publication_ipns` 与 `publication_ipns_renewal` 未返回      |
| 查询写入量                    | schema SELECT 的 API meta 为 `changes=0`、`changed_db=false`、`rows_written=0`；未执行 0010 或其他 SQL 写入                                                      |
| D1 Time Travel                | 当前 bookmark 的只读查询成功；这不是创建完整备份，不是恢复演练，也不代表有一致 R2 快照                                                                           |
| Worker secret 元数据          | 仅 `AUTH_GOOGLE_ID`、`AUTH_GOOGLE_SECRET`、`AUTH_SECRET`、`AUTH_URL`；没有 `IPNS_MASTER_KEY`，未读取值                                                           |
| GitHub production Environment | 名称清单只有上述三个 AUTH 项及 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`；没有 IPNS master；未获取、修改或尝试解密值                                       |
| Secrets Store                 | 账户 store 列表 `total_count=0`，不是已有可直接使用的 master escrow                                                                                              |
| Notification policies         | 仅两个启用的 billing budget alert，mechanism 类型为 email；未发现既有 IPNS renewal/cron/headroom policy；未读取或复用收件人地址、未触发 billing 告警             |
| R2 名称核对                   | `pinboard-blocks` 存在；另见历史 `pinboard-pdf-verify-261108-f3b284c8` 测试 bucket；没有据名称认定其为生产备份目的地                                             |
| 当前部署                      | 读到 deployment `c336455c-7674-46d5-9b9e-3a99c0f294d0`，创建于 `2026-11-13T04:01:50.444546Z`；version `86d74f13-54ab-4531-8e2e-7e2c980dbed3` 占 100%；未改变流量 |
| HTTPS baseline                | `GET https://pinboard.shazhou.work/api/health` 为 200，body 为 `{"service":"Pinboard","status":"ok"}`；仅证明既有服务健康，不证明 IPNS 已上线                    |

通过 Cloudflare API adapter 执行的只读路径：

```text
GET  /accounts/{account}/d1/database/{database}
POST /accounts/{account}/d1/database/{database}/query  [only SELECT sqlite_master]
GET  /accounts/{account}/d1/database/{database}/time_travel/bookmark
GET  /accounts/{account}/workers/scripts/pinboard/settings
GET  /accounts/{account}/workers/scripts/pinboard/secrets
GET  /accounts/{account}/workers/scripts/pinboard/deployments
GET  /accounts/{account}/secrets_store/stores
GET  /accounts/{account}/alerting/v3/policies
GET  /accounts/{account}/r2/buckets  [name_contains=pinboard]
```

用于 schema 的完整 SELECT：

```sql
SELECT name, type, sql FROM sqlite_master
WHERE name IN ('publications','publication_revisions','publication_ipns',
               'publication_ipns_renewal','d1_migrations')
ORDER BY name;
```

后续 migration-history
SELECT 因工具 catalog 在调用前变化而未执行成功；不能把未返回 `publication_ipns`
推断为迁移历史已完整核对。没有绕过该失败读取 cfg 中的主 credential 或做任何写入。

## 已有发布与 CI（不是本轮发布）

- 最近成功 release：
  [`release-261113-1` / run 43362426332](https://github.com/shazhou-ww/pinboard/actions/runs/43362426332)，GitHub 记录提交
  `9a860f3e3375704accb241092157c4e385e83b00`；本轮没有创建新 tag、重跑 release 或将该旧 release 当作 IPNS 发布。
- 被检 HEAD 的
  [CI run 43377073740](https://github.com/shazhou-ww/pinboard/actions/runs/43377073740)
  在预检时仍为 `in_progress`，不能标记 success。
- 已有 `production` secret 环境与 release
  workflow 确实存在；但当前 workflow 只向 Worker 写 AUTH
  secrets，不是已经完成的 IPNS
  master 可恢复托管/传入/恢复流程。没有因其可写就随意生成 master 或修改 workflow。

## 必须先解除的具体安全条件

1. **一致、受限且可恢复的 D1/R2 备份路径。** D1
   bookmark 只能给数据库恢复点；未识别既有获准的 R2 快照/备份目的地、一致性方法与访问边界。不把生产导出落到仓库或明文 scratch，不把历史 PDF
   synthetic bucket 直接当生产备份库。
2. **master 的可恢复托管位置及安全输入过程。** Cloudflare Secrets
   Store 当前为空；Worker secrets 和 GitHub Environment 都没有 IPNS
   master。GitHub
   Environment 是现有加密 secret 设施候选，但尚无已确认的 master 存取、备份与恢复过程，不能称为已具备可验证恢复。
   `cfg --help` 显示该工具有本地 cache 及 UI
   secret-masking 标记；未证明它满足生产 master
   escrow/恢复要求，不向其写入新 master，也不读取其 credential 值。没有因某 CLI 已安装就擅自扫描其他云账户。
3. **获准、受限的既有恢复目标。**
   仓库记录的 PDF 验证环境仅承载合成数据，不能据此认定其可接收生产 D1/R2 数据、身份记录或 master。需先指定现成的合规隔离目标及权限边界，不覆盖既有测试数据、不新建资源。
4. **既有 IPNS 告警规则/接收验证设施。**
   现有 policy 只有 billing 类型；不能为续签测试改写无关 budget
   alerts，不能擅自创建新的 policy/云资源。需给出获准的现成日志/cron/headroom 告警通道及接收验证方法，才可完成目标告警证明。

当前问题不是请求再泛化授权一次，而是需要父 Agent/操作者明确并验证这些
**已经存在的设施与访问条件**。若确实不存在，必须另行决定是否改变“不得新建云资源”的范围；本轮不替用户作该决定。

## 安全停止点

没有满足备份/恢复/托管前提，所以**没有执行 0010**；也没有为了让 release 前进而生成 root
key、配置 Worker
secret（可能部署）、创建 tag 或部署缺少表的新代码。无需回滚或清理生产测试数据，因为本轮没有这类写入。下一轮需先重新核对目标、迁移历史及现时部署，再按
[TargetAuthorization.md](TargetAuthorization.md) 的安全顺序继续。

D-S02 / D-AC02 保持未完成；不追加 `submitOuter` /
`acceptOuter`，不把授权本身、200 health 或 Time Travel
bookmark 当作最终 Outer 证据。
