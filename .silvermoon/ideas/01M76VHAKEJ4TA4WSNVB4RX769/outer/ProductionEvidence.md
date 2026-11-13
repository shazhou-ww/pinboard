# 生产部署与 HTTPS 验证证据

## 契约、版本及范围

本轮按用户 2026-11-13 的继续推进指示，使用既有应用凭据和专用合成数据执行验证。没有重新迁移、覆盖 master、创建 release
tag、重新部署或创建云资源。本轮结果不受此前只读预检时的历史状态限制，也不将新的功能验证倒推为完整恢复或告警验收。

- 生产 release：`release-261113-2`，提交
  `4c6b53742d35e97ed8e1d46181c0be71d259601a`；
  [既有成功发布 run](https://github.com/shazhou-ww/pinboard/actions/runs/43382000190)。
- 生产 deployment：`927cf7d0-1cf4-4773-a8a3-63139c7fe4b3`，
  `2026-11-13T06:57:42.491501Z`，Worker version
  `0fa83d9d-a513-4f86-92a2-1e5a0b212c33` 承载 100% 流量。
- 被检目标：既有 account `92c3c4fdcc84a1590555bccf4f111de2`、Worker
  `pinboard`、D1 `9f15fd50-e103-459f-9f3f-9db3036f91de`、R2
  `pinboard-blocks`。绑定及 `PUBLIC_ORIGIN` 未错配，健康入口返回 200。
- `publication_ipns` 表、完整约束及 `publication_ipns_renewal` 索引已存在；
  `0010_publication_ipns.sql` 的历史时间为 `2026-11-13 06:48:46`。本轮 schema
  SELECT 的写入量为 0。
- `IPNS_MASTER_KEY` secret 名称存在，原四个 AUTH
  secret 名称保留。未从 Worker 获取 secret 值；真实签名及续签验证证明当前 signer 可用，但不证明 master 的备份可恢复。
- 执行前已同步的探针提交：
  `d0f95e955e2d7a79f573478be619f03a650d1309`；对应 outer revision 前缀
  `188e251d21f1`。本轮没有修改应用实现或降低 Deployment 标准。

## 真实 HTTPS 检查

执行时间为 `2026-11-13T09:47:29.958Z` 至
`2026-11-13T09:47:44.056Z`，Windows、Node `v26.13.0`。使用仓库锁定依赖中的
`ipns` 解码、`multiformats` 解析名称与 CID、CBOR 解码及独立 Node/OpenSSL
Ed25519 验签，没有调用服务端验签函数。所有应用请求都发往
`https://pinboard.shazhou.work`，不是本地运行时或 mock。

执行命令如下；凭据由探针在子进程中从 cfg 读取，不写到参数、仓库或证据。运行需另行确认生产测试数据写入授权。

```powershell
$env:PINBOARD_IPNS_PRODUCTION_PROBE = 'authorized'
node .silvermoon\ideas\01M76VHAKEJ4TA4WSNVB4RX769\outer\VerifyProduction.mjs <operation-owned-result-path>
```

最终探针退出 0，`passed=true`。可复现支持文件为
[VerifyProduction.mjs](VerifyProduction.mjs)。

| 项目             | 实际结果                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 合成 Publication | `41454a4e-0f5a-4abe-aa78-5bc0e12d5070`，标签 `ipns-acceptance-893c4199-57d9-43e0-81d4-4501f8fe9fb3`                                                                                  |
| 名称             | `k51qzi5uqu5dmd4hut6ufqnbwnq9t4p8fnx43lmxvxbwvuhptupznbk1gbgr5i`                                                                                                                     |
| 首 CID           | `bafkreih5ho43ncyejpe77vk4y6pa3fdfuemgz7lofxspmicoix67cxxjzi`                                                                                                                        |
| 第二 CID         | `bafkreihq7qsxp7ilir5meunnz3qvesdhyb4qq3ehz3fm4evtajjg2bi274`                                                                                                                        |
| 标准记录         | 原始 IPNS bytes 的 Ed25519 公钥与名称绑定、V2 `ipns-signature:` 签名、signed CBOR Value/Sequence/Validity/ValidityType 均通过；TTL 为 300 秒，记录不超过 10240 bytes；篡改字节被拒绝 |
| raw 内容         | 两个 raw block 的 SHA-256 均匹配 CID digest，实际 UTF-8 原文吻合；匿名私有 raw 为 404                                                                                                |
| HTTP 协商        | HEAD 无 body 且长度匹配；ETag 条件请求为 304；标准 Accept 为 200，q=0 或额外 query 为 406；成功响应为 `private, no-store`                                                            |
| 更新与权限       | 未启用状态为 false；重复启用保持名称；发布 sequence 0→1，回滚 1→2、Value 回到首 CID；仅元数据编辑不替换签名字节；公开后匿名可验签，改回私有后匿名条件请求仍为 404                    |
| 删除与恢复       | 删除后标准读取为 404；正常恢复后名称、sequence 与原签名字节不变；历史仍保留两个内容 revision                                                                                         |
| 读取续签         | 仅将本轮绑定的 `expires_at` 元数据定点置为过去，影响 1 行；随后真实 HTTPS 读取生成不同的新签名，名称/sequence 2/Value 不变、EOL 延长，独立验签通过；完整业务历史 JSON 不变           |
| 续签记录         | 221 bytes，SHA-256 `30e84cd0b5b5cfc99416d66fea8f8f7f018f7de05fd4f2b5751f759de9937cc1`，EOL `2026-11-14T09:47:43.567000000Z`                                                          |

过期条件通过专用绑定的数据库元数据注入，未篡改或公开生产 master，未修改其他绑定。这不是等待真实 24 小时过期，也不是 hourly
cron 续签证明。本轮没有执行跨账户线上负例；该项隔离证据仍见
[IsolatedEvidence.md](IsolatedEvidence.md)。

首轮 `09:46:12Z`
的探针在完成主要签名、更新、权限和恢复检查后，因使用不存在的 owner `/history`
路由返回 404 而退出 1。修正为既有 `/api/public/publications/{id}/history`
后，先校验并同步探针，再完整重跑上述最终检查。没有修改产品来适配探针；首轮失败未计为完整通过，其合成数据也已清理。

## 调度、容量及清理核对

通过 Workers Observability 的只读 telemetry query，限定发布后时间窗、service
`pinboard` 和 scheduled 事件，取得同一生产 version 的实际记录：

| UTC 调度时间               | outcome | wall time | CPU time |
| -------------------------- | ------- | --------- | -------- |
| `2026-11-13T07:17:01.792Z` | ok      | 10401 ms  | 33 ms    |
| `2026-11-13T08:17:01.792Z` | ok      | 1133 ms   | 40 ms    |
| `2026-11-13T09:17:01.792Z` | ok      | 829 ms    | 37 ms    |

这证明该 release 的 hourly
handler 实际执行过，不只是存在 cron 配置。这些执行早于本轮合成绑定，不能据此宣称已观察到目标绑定被 cron 续签，也不能将耗时当作 IPNS 批次的生产吞吐量或 SLA。

两轮均通过产品正常 DELETE 清理本轮 Publication 和两个 Pin，未绕过回收窗口、物理删除数据或动其他用户对象。最终标准读取为 404。首轮 Publication 为
`3dfbdc53-fdd2-4a41-b6ad-d7277b48e2f5`；首轮两个 CID 为
`bafkreihgj37v7j2uez6dzi7fxqocz3e4ledtbulmlqcvx5ok53hbspt43i`、
`bafkreib6xq6fgwrn5fu7vcepmrmsypiyqtv52x7wh754o7pn6lklze2rpm`。
`2026-11-13T09:48:18.747Z`
的只读 D1 复查确认两个 Publication 均已 soft-delete；总 binding 2、live binding
0、12 小时内 eligible live backlog 0。最后一条测试 binding
generation 为 3，sequence 为 2。仍在恢复窗口的加密密钥和签名受既有保留协议管理，不声称已物理擦除。

## 用户提供的加密 master 恢复核对

用户随后提供 PGP 加密 master 文件，并同意在本机密码窗口解密。
`2026-11-13T10:08:14.829Z`，通过本机 GnuPG `2.4.5`
解密成功；密码未通过聊天、命令参数或日志传入。明文只经子进程 stdout
pipe 进入验证进程，没有写入文件、仓库或生产 secret。

对上文最终合成 Publication 的实际生产 binding 做只读查询，在内存中使用恢复出的 master 解密其 AES-GCM 私钥，校验绑定 Publication
ID/name/key-version 的 AAD、存储公钥及 Ed25519 名称，确认该备份确实对应当前生产加密密钥，而不只是格式正确。随后重建同名、同 CID、sequence
2 的新 IPNS 记录并以 Node/OpenSSL 独立验签：

- 名称：`k51qzi5uqu5dmd4hut6ufqnbwnq9t4p8fnx43lmxvxbwvuhptupznbk1gbgr5i`。
- EOL：`2026-11-14T10:08:14.827000000Z`。
- 新记录 SHA-256：
  `f6bf01f448b52f4bb1779294be914c120c71d4a2f20956cf5f2de531081cc778`。
- 新签名字节不同于存储记录，签名有效；没有公开或写回该恢复签名。

验证结果为
`passed=true`；生产 SQL 写入量为 0，没有恢复已删除对象、覆盖 master 或改变 sequence。恢复内容和可访问的原始私钥 buffer 使用后清零，但不保证 JavaScript/crypto 内部副本的完全内存擦除。本项证明独立加密备份可恢复当前 signer，不等于完整一致 D1/R2 备份在受限运行时中恢复、HTTP 私有权限及内容读取的端到端演练。

## 尚不能完成 D-S02 / D-AC02 的具体缺口

后续实际定点一致备份与完整测试 Publication 的受限运行时恢复已通过，32 条真实 cron 批次验证正在等待调度；最新结果见
[TargetRecoveryEvidence.md](TargetRecoveryEvidence.md)。下面第 1 项的历史缺口已由该演练补齐，不再要求寻找原 DPAPI 包；真实批次结果及告警送达尚未完成。

1. **一致数据备份的端到端恢复。**
   原 master 材料缺失的阻塞已由上述 PGP 备份及生产 signer 恢复核对解除，不再需要寻找原 DPAPI
   profile。仍需同一 master 与一致数据库/内容备份在受限运行时中恢复，验证名称、sequence、新签名、私有访问拒绝和 raw 内容。单条实际 binding 的只读重建不冒充完整一致备份恢复；不通过覆盖 master、重建身份或恢复生产旧 sequence 绕过。
2. **外部告警接收验证。** 控制面已见的两条启用 policy 均为 billing
   budget，没有 IPNS renewal/cron/headroom
   policy。没有获准既有 IPNS 告警通道的实际送达证据；不改写无关 billing
   policy，不把 telemetry 日志当告警。需指定既有接收设施，或明确允许建立所需设施后，实际演练续签失败、cron 失败和低于两小时 headroom 的告警接收。
3. **目标续签容量。** 当前 live
   backlog 为 0，不存在当前积压，但尚无目标绑定被真实 cron 续签的观测及 32 条/小时的负载余量证明。隔离 33 条批次演示和本轮读取续签不替代该项。

这些是恢复能力和运行结果的缺口，不是对当前设备所属公司或信息密级的推断，也不是再次索要已授予的有界生产操作授权。保留 D-S02
/ D-AC02 未完成，不追加 `submitOuter` 或 `acceptOuter`。

## 仓库验证

本轮 `pnpm check` 退出 0，包括格式、release 校验、workspace
lint/typecheck/test/build、CLI package 和 background
package 验证。修正探针另通过 Prettier、Node syntax check 和执行前 Silvermoon
worktree/staged snapshot 检查。完整测试不代替本文件的生产 HTTPS 证据。
