# 实现证据

## 范围与安全论证

- `apps/worker/migrations/0003_retention.sql` 保留既有 CAR
  manifest/index，登记物理 provider，明确区分「已有索引」和「已验证完整闭包」。迁移测试使用真实 0001/0002 存量数据，验证映射、成员数及
  `foreign_key_check`。
- `storage.ts`、`service.ts` 将发布与 pin 引用更新分别限制在 D1 batch
  transaction 内。公开读取仍使用 CAR range /
  manifest，完整 DAG 验证、账号隔离和 scope 校验不变。
- `retention.ts` 只从已验证闭包推断引用；无法验证任何 live
  pin 时不创建新删除声明。共享 CAR 整体保留，可能比七天更久，不承诺 compaction 或全局去重。旧数据起点不明时采用观测时间及全局安全下限，宁可延后，不按旧对象创建时间回收。
- 删除声明持久存在，不靠会过期的锁；每次写入的对象 key 唯一，发布/保存 pin 受 CHECK
  guard 约束。若旧对象先被声明，新 pin 只能发布完整新副本，不能引用正在删除的对象。先取得完整 DAG 的并发 repin 可以在旧对象删除后成功；若读取已无引用内容时落后于 GC，可以失败重试，但不得返回损坏 pin 的成功响应。
- `tokens.ts` 的撤销时间幂等；清理使用较早的撤销/过期时间。`identity.ts`
  未修改，服务端即时鉴权不依赖保留列表或后台清理。
- 不执行生产迁移、部署、release tag 或默认 push 部署变更。`Deployment.md`
  仅补充新 schema/Cron/停止旧 writer 的必要外部前提，D-* 均未完成。

## 自动化证明矩阵

| 约束                        | 证明位置与断言                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 七天从最后有效引用起算      | retention：对象创建二十天后仍有账号引用则保留；最后账号 unpin 后 7 天前 1ms 不删除，满 7 天删除                                                      |
| 跨账号、嵌套 DAG 和共享 CAR | retention/storage：其他账号或父 DAG 引用 leaf 时仍可读取；共享 CAR 不按根无 pin 删除，独立 pin 子 DAG 仍受保护                                       |
| repin 与并发写入            | retention：重新 pin 重置宽限期；在 PUT 暂停期间删除旧对象，恢复后新 pin 完整可读；超过七天的迟到 PUT 无法发布                                        |
| 对象/索引/孤儿收敛          | retention：CAR 与 canonical legacy key 扫描分页 50；每轮最多 20；未知 key 保留报告；最后删除后 manifest、block index、对象成员、闭包及保留元数据收敛 |
| 失败和重试                  | storage/retention：R2 PUT 失败、D1 发布/claim rollback、R2 DELETE 失败、R2 成功但 D1 finalization 失败、列表失败；状态持久、退避、重试幂等           |
| 存量安全                    | retention：一个未验证/缺失 DAG 阻止其他新删除；轮转回填；未验证 pin 的 unpin 设置七天全局下限                                                        |
| token 三十天与即时失效      | retention/worker：早撤销、早过期、重复撤销、30 天前 1ms/边界；清理前后均拒绝失效凭据                                                                 |
| token 列表与权限            | retention：默认 active、history 仅失效项、跨账号隔离、错误 view 400、Agent 管理 403；web SSR 默认选项及历史入口                                      |
| unpin 体验                  | service 列表立即无该 pin；manager 成功后先更新本地列表再刷新，提示七天/共享及外部副本，无恢复/彻底删除入口                                           |

## 本地验证记录（2026-11-04，Windows / Node 24.12.0 / pnpm 11.22.0）

- `pnpm exec turbo run build`：5/5 workspace build 成功，包括 Worker
  `wrangler deploy --dry-run`；没有外部上传。
- `pnpm --filter @workspace/worker types`、`typecheck`、`lint`：成功；类型由当前 Wrangler
  4.151.0、workerd 1.20261012.1 和既有 compatibility date 生成。
- 最终 `pnpm exec turbo run lint typecheck build`：15/15
  tasks 成功；`pnpm --filter @workspace/worker exec vitest run test\retention.test.ts test\storage.test.ts test\worker.test.ts`：3/3
  suites，53 passed、1
  skipped（可选 Kubo）；`pnpm --filter @workspace/web test`：4/4 suites，37
  passed，覆盖率 statements/lines/functions 100%、branches 98.73%。
- 完整 Worker 测试尝试两次，唯一失败均为既有 `test/cli.test.ts` 中
  `serializes real independent credential writers without losing endpoint entries`，错误
  `UNSAFE_PERMISSIONS`。该测试只启动既有 CLI 配置凭据进程，与本次保留算法无关。
- 为隔离该环境失败，运行
  `pnpm --filter @workspace/worker exec vitest run --coverage -t '^(?!.*serializes real independent credential writers)'`：6/6
  suites，80 passed、2 skipped（既有可选 Kubo + 明确排除的 Windows
  DACL 用例）；覆盖率 statements 96.92%、branches 94.30%、functions 100%、lines
  97.63%。这不是完整测试通过，也不能代替 `pnpm check`。
- 只读检查证实当前 checkout、`D:\Code\pinboard.worktrees`、`D:\Code`、`D:\`
  均存在 CLI 安全策略拒绝的可替换祖先 ACL。没有修改共享目录权限、弱化验证或绕过安全检查。恢复条件是由环境所有者提供符合现有安全策略的 checkout 祖先链，或在既有 CI 的安全文件系统上获得完整
  `pnpm check` 成功结果。
- 最初 `pnpm check` 的格式阻断定位为本 idea 的
  `Implementation.md`（既有基线问题）及新增编辑；仅格式化本次合法修改的路径，没有清理无关文件。
- 格式修正后完整 `pnpm check`：Prettier 与 release 测试通过；在
  `@workspace/cli:test` 的既有 Windows 凭据检查中退出 1（2 failed / 1 passed
  suites；9 failed / 42 passed / 1 skipped
  tests），原因同上述祖先 DACL。Turbo 在该失败后中止其他未完成任务，不能称为全量成功。CLI 代码、权限检查、依赖清单及 lockfile 均未修改。
- 本地环境失败没有被排除测试或安全放宽所掩盖；`I-AC03`
  由下面的安全 checkout 完整 CI 结果补齐，不使用上述隔离运行冒充完整通过。

## 已同步候选的 CI 复核

候选 `5e1962c60697febfb1fdb8a6004fe5e2a6dca1a0` 的
[CI 41843680711](https://github.com/shazhou-ww/pinboard/actions/runs/41843680711)：Ubuntu
/ Node 22.13.0、24.11.1 的完整 `pnpm check`
均成功；Windows 两个 job 的既有 CLI 权限测试亦成功，证明其受保护 fixture 不受本地祖先 ACL 限制。Windows 唯一失败是新增 57 对象分页/分批清理 fixture 超过 Vitest 默认 5s，未出现行为断言失败。

已将该大 fixture 的单用例预算对齐既有多对象 storage 测试的 30s；不修改全局预算、不跳过断言、不改变算法或权限。

修正后的准确源代码候选 `735e2e090e45caa70ee8a4bf9ffe7fd6d6c8c203` 的
[CI 41844551679](https://github.com/shazhou-ww/pinboard/actions/runs/41844551679)
已成功，完整 `pnpm check` 的四个矩阵 job 均为 success：

| 环境                   | Job          | 结果    |
| ---------------------- | ------------ | ------- |
| Windows / Node 24.11.1 | 126624542234 | success |
| Ubuntu / Node 24.11.1  | 126624542607 | success |
| Ubuntu / Node 22.13.0  | 126624542659 | success |
| Windows / Node 22.13.0 | 126624542683 | success |

后续仅整理本 idea 的 contract/ledger/证据与提交事件，不再修改已验证的
`apps`、`packages`、`scripts`、`.github`
源码/测试/配置树。完整验证已持久化且没有生产部署，`I-AC03`
完成，可以为准确同步的 Inner World 追加 `submitInner`，不代替上游验收。

## 运维与未验证边界

`docs/storage.md`
说明各批次上限、每小时调度、首次观测宽限期、重试/阻塞日志、排障 SQL、暂停 Cron 及旧 writer 不兼容性；README 和 Web 说明公开副本不保证删除。批次数量有界不等于任意规模查询成本恒定，外部阶段仍须验证实际 D1 查询与 Workers
CPU/subrequest 预算。

本地 Miniflare 和 dry-run 不能证明远程 schema、Cron 生效、真实 OAuth/browser 或生产资源行为。必须在明确授权的非生产环境完成 D-*，不缩短真实生产对象宽限期作验证。
