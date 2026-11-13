# Implementation

2026-11-13 用户明确授权继承归档候选并继续实施；此前“未来获准后”和“不实施”文字不再限制本阶段。已接受的 Ideal
World 不扩展、不重写；授权不包括生产迁移、真实密钥配置、发布或部署。候选未验证前不为清除 primary
hygiene 提示而同步半成品。

## Steps

### I-S01: 收敛 Publication 密钥与记录生命周期

采用按需启用的稳定 Ed25519 名称、AES-256-GCM 加密托管及绑定身份的 AAD。24 小时 EOL、300 秒 TTL、提前 12 小时每小时最多续签 32 条；同 CID 不替换记录，续签保持 sequence，回滚增加 sequence。私有记录仅所有者有读权限时可取，删除停服停签、恢复保留名称；业务 sequence 与密钥 generation/不存在状态共同围栏，业务指针及签名记录同一 D1 事务提交。详见
[运行、托管及恢复约束](../../../../../docs/publication-ipns.md)；真实迁移、secret、备份演练及外部告警仍须部署阶段单独授权。

### I-S02: 实现标准读取适配并验证互操作

实现 owner
opt-in/元数据 API、标准原始记录 GET/HEAD、format/Accept、授权后的 ETag 与 private/no-store。输出 base36 名称，接受等价 base32
CID；不实现 DHT、UnixFS 路径或任意 IPNS 回源。保留 Publication 与 raw
API。检查已安装 @libp2p/crypto 5.2.0 源码：Ed25519 解码会复制 raw
buffer，不能声称擦除 protobuf 就已擦除私钥；签名完成后额外清除库持有的 raw 副本，签名前检查名称及公钥绑定，生成后验签。

## Acceptance criteria

### I-AC01: 签名指针与生命周期可证明

独立客户端验签及版本测试覆盖发布、回滚、续签、重启、过期、错名及篡改；续签不创建内容版本，删除不再服务或续签，失败/并发不发布错误 CID。

证据位置：`apps/worker/test/publications.test.ts` 的
`Publication standard IPNS records` 行为测试。独立 WebCrypto
Ed25519 验签使用名称中的公钥与 `ipns-signature:`
前缀及签名 Data，不调用服务端验签函数；同时用 ipns routing-key
validator 检查标准绑定，用 selector 证明相同 sequence 的续签 EOL 排序。持久化加密行与相同临时 master 重建 signer 证明进程外状态恢复，不声称完成真实生产备份演练。

`apps/worker/test/image-runtime.test.ts`
另在 Wrangler 打包的 workerd 中通过 HTTP 分配密钥、读取记录、重新解密私钥并发布下一 CID，Node 客户端验签成功，避免仅在 Node 测试宿主中证明加密库兼容。

### I-AC02: 密钥与读取权限安全

验证无未授权更新、密钥不进入日志/响应、恢复后名称不变及私有指针不泄露；协商、缓存与原有 Publication/raw
API 回归通过。

相同测试组覆盖 owner HTTP
opt-in、授权与条件请求、私有及不同账户负例、无 master 的既有行为与同 CID 编辑、错误 master、删除/恢复、过期读取、签名 generation 竞争、启用/无 binding 竞争、业务事务失败回滚及续签重试。2026-11-13 验证：13 个 IPNS 生命周期行为测试及 1 个打包 workerd 签名测试通过；worker
typecheck/lint 通过。完整 `pnpm check` 退出 0，worker 18 个测试文件通过，321
passed / 1 skipped（保留既有跳过项），Publication 文件 53 项、workerd
image-runtime 文件 9 项全部通过。worker 覆盖率 statements 95.46%、branches
91.13%、functions 97.55%、lines
96.64%，未降低门槛。全仓 lint/typecheck/test/build、release 校验与 CLI/background 打包测试均由该命令通过。

### I-AC03: 最终候选通过完整检查

最终候选执行并通过
`pnpm check`；候选变化后重新验证，不以元数据检查代替签名、业务及密钥安全证明。Silvermoon
worktree/staged 检查通过后方可提交；同步 primary 并提交精确 implementationRevision 后等待人工实施评审，不自批、不推断已验收。
