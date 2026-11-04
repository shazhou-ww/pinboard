# 保留策略生产重建与发布证据

## 授权与边界

2026-11-04 用户先明确要求“部署上去验收一下”，随后明确说明线上均为可丢弃测试数据，授权使用 cfg 中既有高权限 token 删除并重建生产
`pinboard`
D1。此次授权包括独立 schema 初始化、新绑定及正常 tag 发布；不扩展为 R2 清空、其他资源删除或未来重建许可。

- account：`92c3c4fdcc84a1590555bccf4f111de2`。
- Worker / domain：`pinboard` / `https://pinboard.shazhou.work`。
- 私有 R2：`pinboard-blocks`，未删除 bucket 或对象。
- 不修改已完成 Silvermoon 的 Ideal/Inner/Outer 契约或 acceptance 历史。

CFG 凭据仅进入当前进程环境，不输出值、不落盘、不复制到 GitHub、不旋转任何 secret。token 状态 active，目标 account、D1 和 Worker
metadata 读取成功；token 自身完整 policy 查询返回 403，未据此扩权。实际 D1
DELETE/CREATE 均通过 Cloudflare 的 D1 Write 权限检查。

## 重建与切换隔离

删除前已验证产品 build/typecheck 10/10 成功、Worker dry-run 成功；main
`eda381bba11ceb685d9ce424f422308509d936aa` 的 CI `41852079705`
四矩阵成功。既有生产版本为 `release-261104-3` /
`33314a24-76ba-4093-b6f7-810d8d35bc05`，DB
binding 明确指向旧 UUID，Cron 列表为空。

用户允许测试数据丢失，因此未将额外备份作为阻塞。删除前 D1 计数为 accounts
1、pins 2、agent_tokens 2、car_dags 1、car_blocks
4；没有导出用户数据或列举整个 R2 bucket。

| 操作             | 实际结果                                                |
| ---------------- | ------------------------------------------------------- |
| 精确删除旧 D1    | `625b568d-106b-4fe1-af33-3eac4fe0a354`，name=`pinboard` |
| 删除开始时间 UTC | `2026-11-04T15:09:12.984Z`                              |
| 删除确认         | API success；随后 GET 旧 UUID 返回 404                  |
| 同名重建         | `9f15fd50-e103-459f-9f3f-9db3036f91de`，name=`pinboard` |
| 创建时间 UTC     | `2026-11-04T15:09:14.596Z`                              |

旧 Worker 保持绑定已删除的旧 UUID，不会因数据库同名而接入新库；在新 schema 和经 CI 验证的 retention-aware
release 发布前，数据库相关 API 可能暂时不可用。这是本次授权的停机切换，不保留旧库 fallback，也不让旧 writer 写入新 schema。R2 仍保留原有对象，未引用对象按首次安全观测起至少七天处理，未知 key 保留并报告。

## 初始化与发布

新绑定已重新生成 Wrangler 类型，Worker typecheck 和 dry-run 成功。本地完整
`pnpm check` 的格式/release 检查及 16 个 task 成功，仍因既有 Windows
checkout 祖先 DACL 导致 9 个 CLI 凭据测试失败（42 passed、1
skipped）；没有修改权限、跳过测试或声称本地全量通过。须取得精确 source
candidate 的四矩阵 CI 成功后才发布 tag。

使用 CFG 既有 token、明确 production account、新 UUID binding 和 `--remote`
执行独立迁移，三项均成功：

| Migration              | applied_at UTC        |
| ---------------------- | --------------------- |
| `0001_pinboard.sql`    | `2026-11-04 15:10:00` |
| `0002_car_storage.sql` | `2026-11-04 15:10:01` |
| `0003_retention.sql`   | `2026-11-04 15:10:01` |

真实数据库包含
`storage_objects`、`retained_blocks`、`object_blocks`、`dag_roots`、`dag_members`、`retention_backfill`、`retention_state`、`retention_write_guard`
及原有业务表；`PRAGMA foreign_key_check=[]`。accounts、pins、agent_tokens、storage_objects 初始均为零，`safe_after=2026-11-11T15:10:01.588Z`。复核 SQL 全部
`changed_db=false`、`rows_written=0`。

此时旧部署仍仅绑定已删除的旧 UUID。后续只通过既有
`.github/workflows/deploy-cloudflare.yaml`（workflow `405678380`）的 annotated
release
tag 发布新绑定；生产 Environment 的专用部署 token 和 secret 不变。精确 CI、release 和生产验收结果将在完成后补记，不以本节初始化结果冒充已发布。
