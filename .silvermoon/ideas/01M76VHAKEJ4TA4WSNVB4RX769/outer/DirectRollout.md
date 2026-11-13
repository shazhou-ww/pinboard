# 一次性直接执行：授权与安全边界

## 当前执行方式

用户已明确区分：0010 是一次性迁移，直接使用 cfg 中的 Cloudflare
token，无需 GitHub 运维设施；随后指示继续执行。本轮遵从该方向，不执行
`MinimalInfrastructure.md` 的未获批准方案，不新增 token、GitHub
environment、workflow/scheduler、Cloudflare Worker/D1/R2/Secrets
Store 或告警设施。既有应用 cron 已负责续签；代码发布仍只能使用既有 tag-driven
workflow。

本文件只精化一次性 rollout 的执行步骤，不移除 D-AC02 的实际恢复、调度与告警证明要求。后者如不能完成，明确报告父 Agent，不自动勾选或验收。

## 凭据、备份与恢复

已用 cfg 安全捕获的单个 credential 在进程内调用**精确目标 D1 GET**成功：account
`92c3c4fdcc84a1590555bccf4f111de2`、database
`9f15fd50-e103-459f-9f3f-9db3036f91de` / `pinboard` /
`production`。旧 permission-catalog
lookup 失败不能解释为该目标 credential 不可用。不输出值、不通过命令行传值、不读取整个 cfg 配置或缓存。

使用本机**现有 Windows CurrentUser
DPAPI**做一次性加密恢复包：已以临时随机数据验证 Protect/Unprotect 可用，不创建证书或云设施。恢复目录
`.dev.vars.ipns-recovery` 在当前仓库根，由现有 `.dev.vars.*`
ignore 规则排除；目录 ACL 只准当前 Windows
SID 与 SYSTEM，关闭继承。仅保存 DPAPI 密文及非 secret 状态记录，不保存明文 master/SQL
dump。先把实际完整 D1 export 在内存加密，再持久化并解密比对；导出的 signed
download URL 不记录或输出。

master 备份与 Cloudflare D1 分离，保存在
`master-v1.dpapi`，由独立子进程验证可恢复；禁止覆盖已有备份或现有 Worker
master。该备份依赖**本机当前 Windows 用户 profile/DPAPI 系统密钥**，不是跨设备或离线灾备承诺。不能删除目录、重置 profile 或把一般 clean 指向该目录；设备/profile 丢失的后续托管安排由父 Agent 另行审视，不将“已加密”说成全灾难可恢复。不得把生产 master 写入本地测试 fixture、仓库、日志或回复。

0010 不写 R2，不为这次 additive schema
operation 强行要求复制整个 bucket。迁移前 D1
bookmark/加密一致 export 给出可恢复数据库状态；R2 原对象不改、不做删除、重写、生命周期更改或全量复制，也不把先前未批准的 24h/RTO/SLA 提案作为当前事实。默认失败处置是停止并保留 additive
schema，不原地回滚生产 D1、不重置业务/IPNS sequence，不动原有内容。

## 操作顺序与成功判据

1. 同步本计划和操作支持文件到 primary，保留验收标准。
2. 只读核对 schema 和完整
   `d1_migrations`：实际历史为 0001–0009，0010 表/索引与 ledger 均不存在，既有四个 AUTH
   secret 元数据存在。
3. 建立上述 ACL/DPAPI 恢复目录，读取当前 D1
   bookmark，导出实际完整数据库、内存加密，持久化后解密核对。export 可能短暂阻塞请求，60 秒仍未完成即停止轮询并报告，不持久化明文。
4. 只发送 `apps/worker/migrations/0010_publication_ipns.sql`
   的两条 CREATE，核对新表、约束、索引且为 0 行；之后只补写 `d1_migrations` 中
   **0010 这一条追踪记录**，不运行其他 migrations/ backfill，不改业务行。
5. schema 确认后，在内存生成独立 32 字节 master，先完成 DPAPI 持久化及恢复检查，再通过 Cloudflare 单 secret
   PUT 配置。此 API 会创建 Worker
   version，可能立即部署，因此必须排在 schema 后；核对既有 AUTH
   secret 元数据、DB/R2 绑定和健康入口保持。
6. 刷新 main，选择已在 `origin/main` 且 CI
   success 的准确提交，创建当日下一个有效 annotated `release-YYMMDD-INDEX`
   tag，只由既有 workflow 发布。检查实际部署版本、健康与 master 保留；不新增 GitHub
   secret/运维 job 或部署触发器。
7. 通过既有合法应用 credential，仅创建具名合成 Pin/Publication，实际 HTTPS 取得标准记录，独立验签、核对 raw
   CID、发布/回滚、私有/删除恢复及续签。必要的到期触发仅修改本轮专用绑定，并明确区分故障注入与真实时间经过，不动原有用户对象。
8. 从实际生产快照与本机加密 master 做受限恢复，恢复数据只留在进程/受限临时运行态，不作通用生产密钥 fixture；同名/同 CID/sequence 的新签名独立验证，不向公网分发恢复签名，不从旧状态恢复生产签署。
9. 仅清理本轮新建对象，通过产品正常删除/回收窗口处理，明确仍在恢复期的状态，不绕过保留协议物理删除用户内容。

## secret 与发布语义

Cloudflare 官方说明单 secret PUT 创建一个带该 secret 的新版本，
`wrangler secret put` 立即部署。既有 release 的 `--secrets-file`
**保留文件中未包含的 secrets**，所以可直接保留已在 Worker 上的 master，无需为此修改 GitHub
workflow 或复制 master 到 GitHub。发布后必须以 secret 名称核对和真实签名/恢复证明验证，不能只信文档。

- [单 secret API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/)
- [Secrets 与 secrets-file 保留规则](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code)

## 当前未自动解除的门限

既有 cron 不等于已经证明实际执行，已有日志也不等于已验证外部告警送达。执行后记录真实结果；如仍缺告警送达或完整调度/容量证明，保持 D-S02
/ D-AC02 未完成，不提交/接受 Outer，由父 Agent 判断下一步。
