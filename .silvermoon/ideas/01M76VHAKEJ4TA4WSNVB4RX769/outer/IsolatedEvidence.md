# 隔离部署验证证据与剩余边界

## 绑定的契约和对象

- 执行结束时间：`2026-11-13T06:08:56.239Z`。
- 已同步 primary 的被测提交： `071f4eab11d7634165adeed33293df78958bdb64`。
- 执行前已同步且重新观测的 outer tree：
  `a8e530d124697182eb568c27d46c7306eb85ba7d`。
- 未在执行中修改的 `Deployment.md` blob：
  `4af6767cad9e4fdc2ca85bda662f6c6738376cf7`；契约先在
  `f9ac2753baeb401e13a2407cda80383be3320a9e`
  同步，随后同步 probe 与授权边界，再运行最终检查。
- 可复现支持文件：[VerifyIsolated.mjs](VerifyIsolated.mjs)。没有修改 Inner
  World、应用源码、工作流、仓库 schema 定义或实现验收事实。

本证据只证明 D-S01 /
D-AC01 的隔离外部行为，不是生产部署、Cloudflare 小时调度 SLA、生产备份恢复或告警接收证明。D-S02
/ D-AC02 未完成，授权阻塞及精确操作方案见
[TargetAuthorization.md](TargetAuthorization.md)；没有记录 `submitOuter` /
`acceptOuter`。

## 环境与执行

| 项目                             | 实际值                                            |
| -------------------------------- | ------------------------------------------------- |
| 系统 / 独立客户端                | Windows `win32`，Node `v24.11.1`，OpenSSL `3.5.4` |
| Miniflare                        | `5.20261012.0-beta`                               |
| workerd 包 / 可执行文件          | `1.20261012.1` / `workerd 2026-10-12`             |
| Wrangler / ipns 客户端解码       | `4.157.0` / `11.0.1`                              |
| 请求的 compatibility 配置        | `2026-10-14`，`nodejs_compat`                     |
| 第一运行时                       | `http://127.0.0.1:62607`                          |
| 停止并离线复制后启动的恢复运行时 | `http://127.0.0.1:63737`                          |

实际 workerd 版本与请求的 compatibility 配置分别记录，不推定本地与生产运行时完全一致。所有运行时仅监听回环地址；使用 Node
`fetch` 通过真实 TCP HTTP 读取打包 Worker，不使用 `app.request`、`dispatchFetch`
或现有测试套件的通过结果作替代。定时处理器通过仅在本地 Miniflare 启用的
`unsafeTriggerHandlers` 及 `/cdn-cgi/local/scheduled`
手动触发，不是应用新增的生产 HTTP 路由。

从仓库根执行：

```powershell
node --check .silvermoon\ideas\01M76VHAKEJ4TA4WSNVB4RX769\outer\VerifyIsolated.mjs
node .silvermoon\ideas\01M76VHAKEJ4TA4WSNVB4RX769\outer\VerifyIsolated.mjs
```

最终 probe **退出 0**，全部断言通过。脚本内部使用本地 Wrangler
`deploy --dry-run --outdir <operation-owned bundle>`
打包已验收入口，在新建隔离 D1/R2 目录应用仓库 SQL，所有内容、账户、凭据及密钥均为专用临时数据。probe 在内存生成并传入 master、AUTH
secret 与 Bearer 凭据，不主动写明文 secret 文件；D1 中保存加密私钥与凭据 hash，不在报告或仓库记录 secret 值。不对 Miniflare/crypto 内部副本的完全内存擦除作保证，运行时临时目录最终一并清理。启动后先由真实 HTTP
`/api/health` 验证响应，再执行检查。

## 可核查结果

临时名称： `k51qzi5uqu5dk68u8nd3t0llp6u03w3rqgzkjsh53cj38lf912doqdysuv6wky`

临时原始内容 CID： `bafkreih2ls6gxaftymy5jvn3wwnrpvh7mmzr4isrmyoyrxyqss5gjr4usy`

恢复后新记录的 SHA-256：
`142b2704f6f96a9326ac67275b130a910d173ee7a8515471cb9ab02476fc082e`。该记录 sequence 为
`2`，EOL 为 `2026-11-14T06:08:47.498000000Z`，TTL 为 `300000000000`
ns；在执行时通过独立签名与有效期校验。原始临时签名及私钥没有保存为 fixture；现在这些运行时及测试数据均已清理，名称不代表存在一个可继续访问的公开服务。

| 检查                 | 结果与判据                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标准记录 GET         | `/ipns/{name}?format=ipns-record` 返回原始字节；独立客户端从名称提取 Ed25519 公钥，用 Node/OpenSSL 校验 `ipns-signature:` + Data 的 V2 签名；核对 signed CBOR 的 Value、Sequence、Validity、ValidityType，与解码记录一致且未过 EOL；不调用服务端验签函数 |
| wire 限制 / TTL      | 记录不大于 10240 字节；TTL 精确为 300 秒                                                                                                                                                                                                                 |
| HEAD / Accept / ETag | HEAD 无 body 且长度与 GET 相等；Accept 指定标准 media type 返回 200；q=0 返回 406；额外 query 返回 406；授权后相同 ETag 返回 304；Cache-Control 为 `private, no-store`                                                                                   |
| 私有指针及 raw       | 匿名和不同账户标准记录均 404；私有 raw 匿名 404；所有者可取，raw codec 0x55 / SHA2-256 code 0x12，实际 body hash 等于 CID digest，UTF-8 原文吻合                                                                                                         |
| 独立负例             | 改动记录字节、换名称公钥、以及用另一临时密钥真实签署的过期记录都被独立客户端拒绝                                                                                                                                                                         |
| 发布 / 回滚          | 第二 CID 发布后 IPNS sequence 0→1，回滚首版本后 1→2，Value 回到首 CID，名称保持                                                                                                                                                                          |
| 权限切换             | 改为公开后匿名可独立验签；再改回私有后匿名携带 `If-None-Match: *` 仍 404                                                                                                                                                                                 |
| 续签 / 删除 / 恢复   | 手动 scheduled 续签保持 IPNS sequence，EOL 延长，不改变完整业务 Publication；删除后 HTTP 404 且 generation 不增长，恢复后触发续签，名称及 sequence 2 保持                                                                                                |
| 离线一致恢复         | 完全 dispose 第一 workerd 后复制 D1/R2 持久化目录，以相同内存 master 启动新的 workerd；Publication 快照、加密私钥字节、名称、sequence 一致，私有负例仍 404；从恢复库解密并生成不同的新记录，经独立客户端验签，raw CID 仍匹配                             |
| 33 条续签批次        | 通过真实 HTTP 创建并启用 33 个独立绑定；首轮 scheduled 仅续签 32 条，剩 1 条低于两小时 headroom；本地 SQL 阈值观察为 true；第二轮后剩余 0                                                                                                                |
| 失败观察             | 空 master 配置下，scheduled 输出 `ipns_renewal_failed` 事件，retry_at 在未来，过期元数据读取返回 503；隔离 rename 表制造 schema 故障后 scheduled HTTP 500，随后恢复表及 master，标准读取重新通过                                                         |

33 条演示首轮端到端 scheduled 请求为 **402
ms**，包含既有 cron 的其他工作；这不是生产吞吐量、成本、每小时必达性或无限绑定容量承诺。

## 故障注入、准备修正与清理

- 到期及低 headroom 条件通过**隔离 SQL 修改 expires_at 元数据**注入，没有等待真实 24 小时。因此不能把该操作宣称为真实跨日签名过期证据；独立 EOL 拒绝另外使用真实签名的过期临时 fixture 验证。
- 本地 master 在同一个独立客户端进程内保留，并传给新 workerd；这证明备份数据库/R2 与同一 master 可重建名称和 signer，不是 secret
  manager/off-host 备份的恢复演练，也没有使用生产备份。
- 本地探针观察到失败事件、cron HTTP
  500 与 headroom 阈值；没有配置或验证生产告警规则、收件人、消息投递或升级响应。
- 准备阶段首轮因未启用本地 cron hook 返回 404；随后发现已安装 Miniflare
  5 的持久化选项需用 `resourcePersistencePath`，不能用会被转换器忽略的旧
  `d1Persist` / `r2Persist`。只修正 Outer
  probe，未修改产品实现；失败轮未被当成恢复成功。最终检查使用已同步 primary 的修正版本，退出 0。
- `finally` dispose 所有运行时并删除本轮精确 operation-owned 目录；结束后没有
  `.ipns-outer-runtime-*` 残留。对 `127.0.0.1:62607` 与 `127.0.0.1:63737`
  的复查均不再响应。未保留后台 server、临时明文 secret 或临时数据库。

## 剩余目标门限

没有运行生产数据库命令、配置生产 secret、创建/推送 release
tag、部署 Worker、创建云资源或更改生产数据。目标 schema、目标 secret 存在性、实际 HTTPS 服务、真实 hourly
cron、告警投递、备份恢复及容量余量均未观测。目标操作仍需
[单独授权与安全顺序](TargetAuthorization.md)，不能以父 Agent 的门限受托身份替代该授权。

后续状态：用户已另行给出有界生产授权；最新目标只读核对与安全停止原因见
[ProductionPreflight.md](ProductionPreflight.md)。本文件保留为上述隔离时窗的原始证明范围，不把后续授权或健康检查倒推为隔离时已完成生产部署。
