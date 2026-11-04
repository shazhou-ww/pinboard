# 非生产运行证据

## 契约与授权

检查前已将 `Deployment.md` 及透传观测入口同步到 primary：

- `contractPrimary=674133fe3c304e5e2c192362e2fb535dd9e151f4`
- `deploymentRevision=9550fba5fc89ced92539f0cd678320431748cd90`
- `implementationRevision=503ebb7ce2c4dc8f57397920baea6768c75fdfa3`，已由上游接受。

检查运行于 2026-11-04 UTC，完成记录时间
`2026-11-04T14:40:30.277Z`。当前仓库仅发现生产绑定和本地 PoC，没有可直接使用且已获授权的远程 staging。按本次明确授权采用隔离本地 Wrangler
4.151.0 / workerd 1.20261012.1，Windows / Node 24.12.0，compatibility date 仍为
`2026-10-14`。

没有创建远程资源、部署生产、迁移生产、读取生产凭据/用户数据、创建 release
tag 或改变 push 部署策略。所有 D1/R2 命令显式 `--local`，资源名为
`retention-local-fixture`，数据库 ID 为虚构值；监听仅
`127.0.0.1`，使用独立持久化目录和合成账号/session/token。

完整产品源码及 Inner/Ideal 未改动。`probe-entry.mjs`
只透传已接受的真实 fetch/scheduled
handler，并对真实 binding 调用计数，不 mock 数据库/R2、不增加写入或登录捷径。[verify-local.mjs](verify-local.mjs)
是外部 CLI/HTTP/浏览器验证工具，不是产品入口；[RuntimeEvidence.json](RuntimeEvidence.json)
保存实际结构化结果、运行 PID、URL、预算和错误日志，不包含 token/session 明文或 hash。

## D-S01 / D-AC01：迁移与真实 scheduled 执行

### 存量与迁移

通过独立 Wrangler 本地 CLI 建立 0001/0002 存量数据库，写入真实 R2
CAR、256 个 block index、两个合成账号的根/子 DAG pin、旧版 raw
block、55 个未发布 CAR 孤儿和一个未知格式对象，然后应用原始
`0003_retention.sql`：

- CAR：`33,447,941` bytes，256 blocks，接近既有 32 MiB/256-block 上限。
- 根：`bafybeibd6m7ssrirxmes4d7z3gn3e2j5rmn3pcxliyjs73t7pa3dkeucvi`。
- 原有 provider 登记 1，物理成员 256，`foreign_key_check=[]`。
- 未将任何存量根直接标记已验证；初始化 `safe_after=2026-11-11T14:36:00.949Z`。

独立 Worker 进程实际启动，外部 HTTP 健康检查成功后，使用当前 Wrangler 的
`/cdn-cgi/local/scheduled?format=json` 触发真实 scheduled
handler。不是直接调用实现函数，也不是 unit test 或 dry-run。

首次回填一个根，仍有一个未知 live
pin：`backfilled=1, blockedPins=1, objectsDeleted=0, discovered=50`。后续只调整隔离夹具的时间戳，不调整应用时钟或生产宽限期。

### 最大工作量预算

同一次实际 scheduled 执行回填剩余近 32 MiB/256-block
DAG，扫描 50 项、删除 20 个对象、删除 100 个满 30 天的 token：

| 指标                   |         实测 |         契约上限 |
| ---------------------- | -----------: | ---------------: |
| D1 binding 调用        |          355 |         纳入总量 |
| SQL 语句               |          403 |         单独记录 |
| R2 binding 调用        |          277 |         纳入总量 |
| R2 GET / DELETE / LIST | 256 / 20 / 1 | 与真实工作量一致 |
| binding 调用总量       |          632 |              900 |
| handler wall 时间      |     1,429 ms |        30,000 ms |

结果为
`backfilled=1, blockedPins=0, tokensDeleted=100, objectsDeleted=20`。记录的是独立 workerd 的真实 I/O 与 wall 时间，包括观测开销；**不是**
Cloudflare 远程账户 CPU 计费时间、内存或计费配额的证明。没有用本地快慢推断生产延迟。

100 个 token 同时包含「先撤销、后过期」与「先过期、后撤销」夹具；不足三十天一小时的失效记录仍保留，只在推进其隔离时间夹具后被下一轮清理。

### 故障、孤儿、共享与边界

- 在隔离 D1 中加入针对一个 orphan 的真实 DELETE 约束故障。R2 删除已完成而登记最终删除失败，真实日志出现
  `retention_object_failed`，对象保持 `deleting`、`attempts=1`、未来
  `retry_at`；该轮仍完成其他 19 个对象。移除夹具约束并仅推进其 retry 时间后，真实 scheduled 重试幂等成功。
- 后一页首次发现的六个孤儿得到新的七天宽限期，未随已到期旧 orphan 一起提前删除；确认这一点后，仅推进其隔离时间夹具，下一轮删除六个，全部 55 个 orphan 登记收敛。未知格式对象仍保留并报告
  `unknownObjects=1`。
- 账号 A
  unpin 大 DAG 后，服务端记录本次实际引用失去时间，账号 B 的 leaf 引用仍为 NULL 保留状态。即使其他未引用时间推进到七天以外，整个共享 CAR 和 leaf 仍返回 200。
- 最后账号 unpin 后，距七天还差一小时的夹具仍保持可读且无删除；推进到七天以外后，CAR 与 legacy/raw 返回 404。`storage_objects`、`object_blocks`、`car_dags`、`car_blocks`、`dag_roots`、`dag_members`、`retained_blocks`
  全部为零；未知格式对象不计入这些安全可回收索引。

验证工具曾遇到两项自身假设问题：旧 `/__scheduled`
路径被 SPA 回退返回 200 但没有 handler 日志，因此不计为成功；改用文档化的新入口后才取证。工具最初也错误预期新观测的六个 orphan 当轮即可清空，实际保留行为正确；确认宽限期并受控推进夹具后继续取证。现场续跑保留了同一隔离数据和前段真实结果，最终全部验证通过；没有修改实现来迎合工具。

## D-S02 / D-AC02：真实用户路径与恢复准备

### HTTP 与独立浏览器

真实 HTTP 返回：匿名 pins/tokens 401、有效 token 200、撤销及过期 token
401、Agent 管理 token 403、跨账号 unpin
404。默认列表仅有效项，history 仅本账号的撤销/过期项；其他账号 token 不泄露。

独立 Edge `156.0.4314.58`
使用项目内新建 profile 和仅属于本地夹具的合成 session，经 CDP 操作真正渲染的 React 页面：

- 初始 active 选择项，只显示 `FixtureActive`。
- 操作 history 选择器，真实请求
  `/api/tokens?view=history`，显示撤销/过期项而不显示有效项。
- 点击真实 pin 行的 Unpin，确认框后该行消失；再次查询真实 API 也无该 pin。
- 页面七天、三十天与无恢复/彻底删除提示均存在。

没有执行真实 Google
OAuth 回环；合成 session 只属于本地授权夹具，生产验证和授权逻辑未放宽。

### 实际备份与恢复

通过本地 D1 export 生成 `169,183` bytes
SQL，并从真实 HTTP 下载大 CAR；停止自有 Worker 后复制完整 D1/R2 持久化状态，避免复制活跃写入。

CAR SHA-256：
`fc69d321ebfa9a61a45b41d1652667bf7a0c0fdfe28aa4f160e3752033ed803c`。

随后真实 unpin/清理使相关内容和索引消失；再次停止自有 Worker，将完整隔离快照恢复，再启动后验证账号 pin 恢复、CAR 摘要完全相同、已撤销 token 仍为 401。不是仅说明“可以备份”，也没有用旧版 writer 回滚。

### 暂停、监测与 forward-fix 清单

已停止主动 scheduled 调用、停止自有 Worker，将本地 `triggers.crons` 设为 `[]`
并省略旧 `--test-scheduled` 标记后重启；健康检查 200、匿名 pins 401、共享 raw
200。

**范围限制：**本地 Wrangler 不会按墙上时钟自动执行 Cron；Local
Explorer 的显式手工入口也不是自动调度。这里验证的是停自有执行器、移除本地配置登记及正常 API 重启，**不声称**已验证远程 Cloudflare 调度暂停或生产任务停止。未来任何生产部署须单独授权；远程暂停时需移除 Cron、核对已发布 trigger 列表并等待在途任务结束，不能只看本地配置。

运维操作：

1. 监测 `retention_completed` 的失败/阻塞计数，以及
   `retention_backfill_failed`、`retention_object_failed`、`retention_failed`；用
   `docs/storage.md` 中查询定位阻塞根和重试队列。
2. 故障时停止新调度并等待在途任务，保留 `deleting`
   声明。只修复服务/已验证数据后重试，不按根 pin 数删除 CAR，不设置 R2 生命周期过期。
3. 取得一致 D1/R2 备份；迁移/切换期间停止旧 writer，使用 retention-aware
   forward-fix，不回滚到旧 writer。
4. 此次运行的自有 Worker/浏览器均已停止，隔离持久化状态、合成凭据和浏览器 profile 已删除；没有删除项目既有
   `.wrangler` 数据或操作生产资源。

## 复核与复现

实际外部取证共八次 scheduled 调用，最高调用总量 632、最高 wall 时间 1,429ms；合成资源已清理。验证脚本的
`node --check` 与 `--preflight` 成功，确认契约、已接受 Inner 和产品源码仍一致。

本阶段仍执行了
`pnpm check`：格式、release 检查及 16 个 task 成功，但本地既有 CLI 祖先 DACL 限制使 9 个凭据测试失败（42
passed、1
skipped），与 Inner 证据中的环境限制相同。未修改权限或跳过测试；此前已接受源码的 Ubuntu/Windows
× Node
22/24 完整 CI 均成功。本地单元检查的这一限制不替代、更不抹去上述真实独立进程、I/O、浏览器和恢复证据；同步本候选后再复核现有 CI。

在仓库根目录，使用已安装依赖和构建产物：

```powershell
node --experimental-import-meta-resolve .silvermoon\ideas\01M6KB4DE7A6X7E3M0W6A6ZGRW\outer\verify-local.mjs --preflight
node --experimental-import-meta-resolve .silvermoon\ideas\01M6KB4DE7A6X7E3M0W6A6ZGRW\outer\verify-local.mjs
```

完整执行会创建并清除仅属于本次运行的项目内隔离资源，可能需要数分钟写入夹具；需要已安装 Edge，或以
`PINBOARD_VERIFY_BROWSER`
指向获准使用的浏览器。不会创建任何远程资源。执行前拒绝已变更的产品源码、Inner 或契约；证据整理后的 Outer
revision 自然变化，但受测契约和已接受实现不变。
