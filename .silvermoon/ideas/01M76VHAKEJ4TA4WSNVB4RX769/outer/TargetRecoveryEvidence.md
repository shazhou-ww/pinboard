# 目标数据隔离恢复与真实批次续签验证

## 契约与执行边界

执行前已同步契约及探针提交 `65cec7b55a2bd54cbbd10b53fb94a4ac15fb8bc7`，outer
revision `ad9a830576c9`。支持文件为
[VerifyTargetRecovery.mjs](VerifyTargetRecovery.mjs)。本轮以现有授权只操作具名合成 Publication/Pin，没有迁移、覆盖 master、创建 release
tag 或云资源，不更改其他业务对象。

开始时间为 `2026-11-13T10:31:19.813Z`。执行前 live IPNS
binding 为 0。本轮创建 32 个合成 Publication，共用专用 raw CID
`bafkreic27gotqbb6vq4lyw2e635f5vku2fcstyc25cpgo4fmfncdj6of4q`，标记
`ipns-cron-recovery-a4b782c1-3450-4515-83c6-119f7596b214`。最终探针于
`2026-11-13T11:17:46.732Z` 退出 0，`passed=true`；真实批次续签和正常清理均完成。

## 实际目标数据备份与隔离恢复：通过

对首个合成 Publication `b18308bd-3f2d-499d-a77c-8ed22528356b`，单条只读 D1
SELECT 同时序列化其 Publication、revision、operation、retention、IPNS
binding，以及该 CID 的 CAR location、storage object、blocks、DAG
membership 和 retained-block 行，共 12 个相关表的定点快照。没有导出其他 Publication、真实账户资料或应用凭据。这些行在单条 SQL 的一致快照中读取，不是分时拼接业务状态。

从既有授权下载入口取得生产 R2 的原 CAR，校验其长度、实际 block
offset/length 对应的 raw CID
digest；两次下载的 ETag 和内容 SHA-256 相同，下载前后定点 D1 快照完全一致。CAR
SHA-256 为
`6b8280c31f46957d957eb6979fc392413f8c31416e999949363ea085a54d78ea`。数据库与 CAR 组成独立备份，经 CurrentUser
DPAPI 加密后持久化，实际从磁盘读取、解密并比较备份 digest，随后只从恢复内容构建运行时。不保存明文 master 或将生产密钥作为一般测试 fixture。

受限 scratch 目录关闭 ACL 继承，仅当前 Windows
SID 与 SYSTEM 可访问；使用 workerd/Miniflare 恢复已授权测试数据，监听
`http://127.0.0.1:58630`。应用账户映射保持原 account
ID，但本地使用合成账户 subject 和临时 token，不复制生产身份资料或凭据。实际 PGP
master 在本机 GPG 子进程解密后经内存 pipe 传入运行时。

`2026-11-13T10:32:21.284Z` 完成以下真实本地 HTTP 检查：

- 原生产名称 `k51qzi5uqu5dlbnkje3apjalpwxbl5yrwx6r5dw8ekc8ktt10tm0ew3dlq2jv3`
  保持，原签名从恢复库读取并独立通过 Ed25519/name 验证。
- 本地仅注入测试 binding 的过期元数据后生成不同的新记录，sequence 仍为 0、Value 仍为上述 raw
  CID，独立验签通过。新签名 SHA-256 为
  `77fbf409f69724b1adb4757c7657c53ab6f41b6aa606bf6d0029e5feb737ea80`。
- 恢复后的原 CAR 可通过 raw HTTP 读取，原文及 CID digest 相符。
- 匿名标准 IPNS 与 raw 读取均为 404；本地临时所有者可读。
- 续签前后完整业务历史 JSON 相等，未引入业务版本。

恢复运行时随后已 dispose，未将恢复签名写回生产或对外发布，未从备份恢复生产 sequence。这是该合成 Publication 所需完整数据和内容的一致备份恢复，不是整个生产账户/服务的灾难恢复、跨设备 DPAPI 可恢复性或长期备份 SLA 证明。DPAPI 文件依赖当前 Windows
profile，应与独立 PGP master 备份分别保管。

## 真实 cron 与批次容量：通过

`2026-11-13T10:32:22.579Z` 起等待实际 `17 * * * *`
生产 cron。仅对本轮 32 个具名 binding 注入六小时 headroom 的 `expires_at`
元数据，SQL 确认影响 32 行，注入值为
`2026-11-13T16:32:21.336Z`。原始签名中的 EOL 没有篡改；测试对象在该元数据与签名不一致期间不作为可用服务示例。

观察进程每分钟只读查询本轮 binding 的 generation 和 expiry，在
`2026-11-13T11:17:37.747Z` 观察到全部 32 条续签成功：generation 均为 1，IPNS
sequence 均保持 0。在该观测之前不请求标准记录，也未手动调用 scheduled
handler，从而避免把读取续签或手动触发冒充真实 hourly
cron。随后首个名称的真实 HTTPS 新记录独立验签通过，业务历史 JSON 与恢复前快照完全相等；记录 SHA-256 为
`a7d5628f342f8d0fe1e6af1a8ff2f8fb570d8232cac092f80ae7f3abb8e3543d`。

目标 Workers Observability 的只读查询交叉核对实际生产调度：

| 项目                  | 实际结果                                                |
| --------------------- | ------------------------------------------------------- |
| cron / scheduled time | `17 * * * *` / `2026-11-13T11:17:01.792Z`               |
| Worker version        | `0fa83d9d-a513-4f86-92a2-1e5a0b212c33`                  |
| outcome / wall / CPU  | `ok` / 1243 ms / 89 ms                                  |
| invocation request ID | `1fd6d1c14f2d96573a5fc326e3d3bead`                      |
| event ID              | `01M7AA065Q00000000000000J0`                            |
| 最早 / 最晚新 EOL     | `2026-11-14T11:17:03.221Z` / `2026-11-14T11:17:04.139Z` |

`2026-11-13T11:18:54.578Z`
又通过只读 D1 查询取得本轮全部 32 条已续签记录，逐条独立校验名称公钥、Ed25519
V2 签名、Value、sequence、generation 及 signed
EOL 与存储 expiry 一致，全部通过；SQL 写入量为 0。不是只用 generation 计数或首条样本推定全部签名有效。

本轮证明空 live
baseline 下单次真实 hourly 调度能处理 32 条，且返回约 24 小时 EOL 余量。当前没有持续生产负载或积压；固定容量仍是 32 次/小时，不能由一次满批次宣称无限绑定或长期 SLA。应以实际续签需求、失败重试及 backlog 约束后续启用规模；增加规模仍需另行容量验证，告警不可省略。

## 清理与剩余验收条件

探针在 `2026-11-13T11:17:46.732Z` 前通过正常 API
soft-delete 全部 32 个 Publication 及共用专用 Pin，不绕过恢复窗口或物理删除数据。后续只读核对确认本轮 32 条 Publication 全部已删除、binding 均 generation=1；专用 Pin 只有一个 owner
row，且存在正常 deleted-pin 记录。 `2026-11-13T11:18:37.488Z` 的全局 live
binding 和 eligible backlog 均为 0。恢复 listener `127.0.0.1:58630`
已不响应，本轮精确 operation-owned scratch 目录已删除，无遗留本地运行时。

备份恢复、真实调度及当前规模的满批次证明均已完成。外部告警送达仍无证据，本轮没有配置新设施或改写 billing 告警。需要既有接收渠道及实际投递验证，或另行明确新增设施授权。因此 D-S02
/ D-AC02 仍未完成，不提交 `submitOuter`。
