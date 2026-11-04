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
tag 发布新绑定；生产 Environment 的专用部署 token 和 secret 不变。以下为之后实际完成的发布与验收，不将初始化本身当作发布成功。

## 生产发布结果

| 项目                  | 实际结果                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 精确 source candidate | `fd8b03a443663b048b4ddc3c3ef3794277c5a660`，先同步至 origin/main                                                                              |
| 完整 CI               | [41855176767](https://github.com/shazhou-ww/pinboard/actions/runs/41855176767)，Ubuntu/Windows × Node 22.13.0/24.11.1 四矩阵全部 success      |
| Annotated release tag | `release-261104-4`，发布前刷新并确认 1/2/3 已占用；没有重写 tag                                                                               |
| Tag 工作流            | [41855871116](https://github.com/shazhou-ww/pinboard/actions/runs/41855871116)，success，完整 workspace 验证及 Worker/assets/secrets 部署成功 |
| Deployment ID         | `58c0d326-ba8a-4cb0-8fff-0ae0d061b3b5`                                                                                                        |
| Worker version        | `fede68cc-053a-465f-a638-e05779279c70`，`workers/tag=release-261104-4`，100% 流量                                                             |
| 实际部署时间 UTC      | `2026-11-04T15:17:14.292695Z`                                                                                                                 |
| 实际 DB binding       | `DB` → `9f15fd50-e103-459f-9f3f-9db3036f91de`                                                                                                 |
| 实际 R2 binding       | `BLOCKS` → `pinboard-blocks`，保持原 bucket                                                                                                   |
| 实际 Cron 登记        | `17 * * * *`，登记时间 `2026-11-04T15:17:20.231047Z`                                                                                          |

没有把高权限 CFG token 写入 GitHub；发布继续使用既有 production
Environment 的五项 secret。没有改变分支/manual 触发器、部署 token 权限或应用鉴权。重建到新版本绑定切换之间约八分钟为本次允许的数据库相关操作不可用区间；不声称逐秒测量了所有流量。

## 发布后的真实验收

以下请求直连 `https://pinboard.shazhou.work`，未使用本地模拟或伪造 session：

| 检查                             | 结果                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/api/health`                    | 200，`Pinboard / ok`                                                                                             |
| `/api/bootstrap`                 | 200，仅启用 Google                                                                                               |
| 首页及同源 assets                | 首页正常；JS `/assets/index-V2UVoEMG.js` 200 / 244,475 bytes，CSS `/assets/index-CQUrhv-f.css` 200 / 6,486 bytes |
| Delegated routing identity probe | 200，既有 provider ID 与生产 multiaddr 正确                                                                      |
| 匿名 `/api/pins`                 | 401                                                                                                              |
| 匿名 active/history token 列表   | `/api/tokens?view=active` 和 `?view=history` 均 401                                                              |
| 原有受保护本地应用凭据           | 仅在进程内用于一次 GET，返回 401，符合 D1 重建后旧 Agent token 失效；未披露值                                    |
| 真实 D1 复核                     | 0001/0002/0003 齐全，FK check 无结果，accounts/pins/tokens 初始仍为零，SQL 无错误且只读                          |

保留原 R2 后，对既有公开 legacy 根
`bafybeichdmdbzwsifxxipvqqykwdaiviqp3blxbwy5saryokhttifcadzu` 执行实际 raw
GET 和 CAR 导出：

- raw：200，165 bytes，SHA-256
  `471b061cda482dee87d610c2ac3022a883f615dc36c76408e1ca3ce6828803cd`，与先前证据一致。
- CAR：200，3,147,545 bytes，独立 `CarReader` 读取 18 blocks，逐 block
  SHA-256/CID 均验证成功，根匹配。
- CAR
  SHA-256：`4daf3f74323481fb5f97309165cfcf5d5cba0ee1cf01fb231cb5951e79b0b28a`。
- Content-Type 为 CARv1，attachment 文件名与根一致，`X-Content-Type-Options=nosniff`。

这是**既有公开内容的读取证明，不是新认证上传成功**。没有清空 R2、删除既有对象、列举整个 bucket、缩短保留时间、写入生产夹具时间戳或强制回收。

## 明确的验收缺口与后续条件

1. **真实认证写入尚未验证。**
   可用浏览器未登录 Pinboard；通过正常 Auth.js 原生 CSRF
   form 进入 Google 后出现 Email or
   phone 登录页，需要真实账号交互。未读取密码、提取 AUTH_SECRET、伪造 JWT、直接插入账号/token，亦未创建测试专用生产入口。旧保存 token 已失效，因此本次没有新上传、unpin、创建/撤销临时 token 或认证后的 active/history
   UI 成功证据。恢复条件是正常 Google 登录或通过既有安全通道提供重建后有效的最小权限应用凭据；不在聊天中索取凭据。
2. **Cron 已登记，但未观察到实际远程运行。** 受控 remote tail 成功连接，约
   `15:16:36Z`
   起最多观察 180 秒，仅过滤 retention 日志，之后已结束，没有捕获 retention 事件。登记在
   `15:17:20Z`，晚于该小时的 17 分钟；下一常规窗口为
   `16:17Z`，不为此等待一小时，也不把本地日志或登记配置冒充远程执行证明。
3. D1 的七天安全下限仍为
   `2026-11-11T15:10:01.588Z`；孤儿还须从实际首次观测起保留至少七天。没有等待真实七天/三十天完成，也没有声称生产回收边界已经实证。

公开、配置、schema 与发布验收已通过；上述认证写入和实际远程 Cron 运行保持显式未验证。既有测试数据重建是已执行且获准的独立操作，不改变已完成 Silvermoon 世界契约或新增 acceptance
event。
