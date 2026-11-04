# 内容与 token 保留实现

## Steps

### I-S01: 建立安全的内容回收机制

通过 `0003_retention.sql`
引入完整 DAG 闭包、物理对象成员和每个 CID 的最后失去引用时间；账号 pin 与引用时间在同一 D1
transaction 中更新。任何账号或 pinned
DAG 仍引用的 block 都保护其 CAR/旧版对象，不根据根 pin 数或对象创建时间删除。

写入先登记 `writing`，使用永不复用的 UUID CAR key，完成 R2
PUT 后原子发布索引/闭包并转为
`ready`；保存 pin 再次执行 CHECK 约束防护。回收以事务重新检查引用、持久标记
`deleting`
并拆除该对象索引，再删除 R2 和登记。声明不超时、不复用 key；延迟 PUT、并发 repin、丢失响应不会让旧删除操作破坏新 pin。

每小时 Cron 最多清理 20 个对象、扫描 50 个对象、回填 1 个存量 DAG；任何未验证 live
pin 阻止新内容删除，未回填 pin 的 unpin 设置全局七天安全下限。未知历史/孤儿从首次安全观测起保守保留七天；共享 CAR 不拆包。失败结构化记录并按对象退避，元数据分批收敛。代码及迁移见
[证据](Evidence.md)。

### I-S02: 完成 token 保留和列表体验

每轮最多删除 100 个已失效满 30 天的 token，起点为
`min(revoked_at, expires_at)`；重复撤销保留第一次时间。鉴权继续在服务端即时校验撤销、过期、scope 和账号，不依赖清理进度。

`GET /api/tokens` 默认 active，`?view=history`
仅返回当前账号失效项，未知 view 拒绝，管理接口仍限定浏览器 session。Web 提供 active/history 选择器和保留提示；unpin 成功立即本地移除列表项，再刷新；不增加恢复或彻底删除操作。

### I-S03: 补齐验证与文档

补充 Miniflare/D1/R2 回归测试，覆盖精确边界、跨账号/嵌套 DAG/共享 CAR、迁移与旧版对象、孤儿扫描分页、并发重新 pin、迟到 PUT、事务回滚、删除失败及重试。更新 README、存储与运维文档，生成 Wrangler 类型，执行 targeted
tests、lint/typecheck、dry-run build 和 `pnpm check`，将实际结果与环境限制记录在
[Evidence.md](Evidence.md)；不以跳过既有失败测试冒充全量通过。

## Acceptance criteria

### I-AC01: 内容回收安全且完整

自动化测试证明 7 天边界、跨账号及 DAG 引用保护、重新 pin、CAR 共享索引、孤儿和失败重试行为；仍有引用的数据不因回收而不可读。

证明：`apps/worker/test/retention.test.ts` 与
`storage.test.ts`；断言包括 7 天前 1ms 不删除、边界删除、最后账号退出后重新计时、仍可读取共享 DAG、GC 与 repin 交错、迟到写入被 fence、R2/SQL 失败后的幂等恢复及索引清理。

### I-AC02: Token 生命周期和界面一致

测试证明撤销或过期即拒绝鉴权，30 天边界正确，默认仅有效项且历史可查看；unpin 成功即从列表移除，不提供恢复或彻底删除入口。

证明：真实认证 HTTP 测试覆盖 active/history、越权账号、Agent
token 禁止管理、过期边界及清理前后 401；SSR 测试覆盖默认 active 选择项、历史入口及保留提示。unpin 的服务端列表断言及前端成功分支共同证明即时移除。

### I-AC03: 检查和文档一致

相关测试及 pnpm
check 通过；文档说明实际保留起点、清理延迟、公开副本限制与运维失败处理。

文档与针对性检查已完成；源代码候选 `735e2e090e45caa70ee8a4bf9ffe7fd6d6c8c203`
的完整 `pnpm check` 已在既有 CI 的 Ubuntu/Windows × Node
22.13.0/24.11.1 四个 job 全部成功。当前本地 checkout 的既有 Windows CLI
DACL 限制仍如实保留，没有排除测试或弱化权限来制造通过。可复核的运行链接、失败修正与结果见
[Evidence.md](Evidence.md)。
