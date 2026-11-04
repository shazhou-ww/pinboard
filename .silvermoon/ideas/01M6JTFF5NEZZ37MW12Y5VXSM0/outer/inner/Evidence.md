# CLI 实施证据

## 范围与环境

- 工作目录仅为本会话的 `files/cli-worktree`，分支 `docs/pinboard-cli`；基线为
  `66727471d8bbe3b2c73e8291e505c3d4c150e804`。
- 接受的理想世界修订为
  `26ef249375a16d51f7e4baa8358cf5cf749a48c4`；未修改理想世界、生命周期事件、Deployment.md 或现实世界支持文件。
- 执行平台为 Windows，Node.js `24.11.1`、pnpm
  `11.22.0`。未安装或启动 Kubo 作为本实现的前提，未连接 daemon
  RPC，未发布 npm 或部署生产。
- 本地账户、token、D1 和 R2 都是受授权的合成测试 fixture；它们不是生产账户、生产凭据或现实验收证据。

## 交付物

| 位置                                      | 内容                                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| `apps/cli/src/main.ts`、`cli.ts`          | 可执行入口、顶层命令、帮助、退出码、JSON 与人类输出         |
| `apps/cli/src/client.ts`                  | 现有 HTTP API、公开声明头、禁止重定向、分页与不确定写入恢复 |
| `apps/cli/src/input.ts`                   | 二进制文件读取、目录适配、CAR 原根保留、链接/变化/大小检查  |
| `apps/cli/src/store.ts`、`permissions.ts` | endpoint 绑定明文凭据、真实 OS 权限、原子替换与跨进程互斥   |
| `packages/encoding`                       | 从 Web 提取的纯共享目录编码与路径/字节/DAG/CAR 限制         |
| `apps/web/src/directory.ts`               | 浏览器流适配与 Blob 包装，继续使用原有选择及拖放语义        |
| `apps/worker/test/cli.test.ts`            | 编译 Worker 在 workerd 中运行的真实本地 HTTP 集成           |
| `docs/cli.md`、`README.md`                | 本地安装、公开内容、命令、凭据边界与故障恢复                |

没有新增第三方库或更改已锁定的第三方版本；新增工作区引用均为
`workspace:*`，编码库继续使用 pnpm
catalog。原有 Worker 生产源代码、授权、路由及公开声明校验保持不变。Turbo 将 Worker 编译作为其集成测试的前置条件，不把 Kubo 检查混入基础流程。

## 已执行验证

2026-11-04 的本地执行记录：

| 命令                                                               | 结果与解释                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `pnpm install`                                                     | 修改工作区 manifest 后安装成功；锁文件变化仅为工作区映射                    |
| `pnpm --filter @workspace/encoding --filter @workspace/cli test`   | 共享编码器及 CLI 定向测试通过；后续扩展测试由完整检查覆盖                   |
| `pnpm --filter @workspace/worker exec vitest run test\cli.test.ts` | 6 项真实本地集成测试通过，实际使用编译 Worker/workerd 和本地 HTTP           |
| `pnpm --filter @workspace/cli test`                                | Windows 命令、凭据读取及真实权限测试通过；平台/权限限制导致的跳过明确保留   |
| `pnpm check`                                                       | 格式、发布约束、lint、typecheck、test、build 全部通过；20/20 Turbo 任务成功 |

完整检查覆盖：发布约束 23 项、contracts 2 项、共享编码 14 项、Web 37 项、Worker
54 项，以及 CLI
49 项通过、2 项跳过。现有共享/Web/Worker 的 90% 覆盖率门槛未降低；共享编码的语句/分支覆盖率为 97.53%/91.30%，Web 为 100%/98.73%，Worker 为 96.40%/94.01%。CLI 自身在 Windows 的语句/分支覆盖率为 86.96%/78.21%；这不是跨平台或全部分支已证明的声明。

### 复审后的根 CID 回归

- 已知目录或 CAR 根时，`Client.upload`
  现在将响应 CID 与预期根均归一化为 CIDv1，按 CID 语义比较而非展示字符串；不匹配返回
  `INVALID_RESPONSE`、 `uncertain: true` 和已知根的恢复建议，不重试写入。
- 新增一项根不匹配回归，以及 CIDv0/CIDv1 两个方向的等价编码回归；原先结构有效但属于其他根的响应不能再报告成功。
- 第一版测试直接把泛型 `MultihashDigest<number>` 传给
  `CID.createV0`，虽然运行测试通过，但父任务完整检查发现其不满足
  `MultihashDigest<18>` 类型约束。已改为在支持的 DAG-PB/sha2-256 CID 上调用
  `toV0()`，没有使用类型强制转换掩盖问题。
- 2026-11-04 19:11 的复审重跑：`pnpm --filter @workspace/cli typecheck`
  通过；随后 `pnpm check` 20/20
  Turbo 任务成功（12 项缓存），耗时 1 分 0.338 秒。CLI 为 49 项通过、2 项因既有平台/权限限制跳过，包含新增的三项根 CID 回归。

### 内容、同根与二进制重建

- 普通二进制文件与空文件走原有
  `kind=file`，与 Worker 的 Web 文件编码路径根 CID 一致；上传 `.car`
  作为普通文件与 `import` 协议导入的 CID 明确不同。
- 同一目录 fixture 含隐藏文件、嵌套非 ASCII 路径、空文件与路径空格；Web
  File 适配器和 CLI 文件系统适配器的根 CID 相同。
- CAR 导入保持原根；真实公开 CAR 导出经成熟 CAR/DAG-PB 库读取，每个 block 与原 CAR 一致，再逐文件核对公开网关中的二进制原字节。
- 空子目录不进入目录根，完全空目录明确拒绝；已有 CAR 缺失 DAG 明确失败，超限文件、DAG/CAR 元数据、重复/冲突/不安全路径及链接均有测试。
- 目录编码的 CIDv1、raw
  leaves、目录包装及 importer 默认策略保持不变；不手写 UnixFS/CID/CAR 编码，不增加文件数量等偏离唯一 block 限制的额外规则。

### 认证、公开发布与自动化

- 文件/目录/CAR 自动发送
  `X-Pinboard-Public: true`，不需要确认参数或交互；直接调用 API 而不带声明头仍被拒绝。
- 真实服务检查了最小读取/写入权限、过期、撤销、同账户同 CID 标签 upsert、不同 CID 可重名，以及移除后账户详情不可见而公开原字节仍可取。
- `--endpoint`、环境、配置与默认值优先级、每条顶层网络命令、JSON/stdout/stderr、
  `--cursor`/`--all`、分页中途失败和循环游标均有测试；失败不输出伪完整列表。
- 真实原生 fetch 超时测试在 Worker 已提交后延迟返回：CLI 失败且
  `uncertain: true`，随后 inspect 可见已提交 pin，请求计数证明未重放上传。单元测试另覆盖中断、重定向拒绝、服务错误及未知写入结果。
- 服务错误原文、子进程诊断、反射的 token 都不会进入命令输出；token 只用于目标请求头，权限辅助进程仅获白名单系统环境与路径元数据。
- 隐藏 TTY 读取使用终端适配测试验证不回显及恢复 raw
  mode；这里不冒充人工真实终端验收。
- 内置 CLI 的独立 Node 进程在 PATH 仅指向测试 fixture 目录时完成真实 HTTP 列表操作，不提供可解析的 Kubo 可执行文件。其余命令与编码路径也不含 IPFS 进程或 RPC 调用。

### 真实平台权限

- Windows 使用当前用户 SID、受保护 DACL、禁用继承及唯一授权项；独立于实现的 PowerShell 检查再次核验实际 owner、继承状态与规则。
- 实际文件系统测试覆盖首次保存、覆盖更新、移除、同进程并发、独立 Node 进程并发、宽权限拒绝、硬链接、目录 junction、写秘密前空文件的真实权限，以及真实 ACL 辅助工具不可用时拒绝保存。
- 显式环境/标准输入凭据不读取本地 token
  map，空环境值不回退，不同 endpoint 不共用凭据；普通 config 不含秘密。
- 可被其他主体修改权限或替换的父目录在实际文件系统测试中被拒绝，秘密文件没有产生；未只检查最终文件而忽略路径祖先的安全性。
- POSIX
  0700/0600、实际 owner、路径链接、硬链接及不安全权限测试已经实现，由新增 Ubuntu
  CI 矩阵执行；本 Windows 会话没有可用 Linux 发行版，未运行它们。
- Windows 尝试建立异 owner
  fixture 时，当前主机不允许未提权进程更改到另一 SID；此项按能力跳过，没有用 mock 冒充成功，也没有提权或修改其他用户文件。另一项跳过是仅 POSIX 的实际 owner/目录权限场景。

## 已修复的验证失败

- 初始格式检查发现新增 CLI 测试需要再次格式化；已修复并通过完整检查。
- 初始 unsafe-DACL fixture 用 `Set-Acl` 遇到 `SeSecurityPrivilege`
  限制；改为当前用户可使用的 .NET 文件 DACL 操作后，真实宽权限拒绝测试通过。
- 初始本地桥接 fixture 没有保留零长度 POST
  body，且转发压缩响应时没有去除旧的 content-encoding/content-length；这些是测试传输适配问题，已修复。最终主要集成直接请求真实 workerd
  HTTP listener，只有响应丢失测试使用受控延迟代理。
- 初始 PATH 隔离环境的类型丢失了 Worker 生成声明中必需字段，以及一次测试清理代码的 await 位置错误；均已修复，lint/typecheck/完整检查通过。
- 发现原生 fetch 会直接抛出 AbortSignal.reason；已修复错误分支，避免把已发出的写入超时误报为确定未写入，并加入真实提交后超时回归。

- 新增祖先目录权限用例一度放入另一测试函数内部，被测试收集器明确拒绝；已移至 suite 层级并独立执行。

Silvermoon 的 `silvermoon check --worktree --audience agent`
也通过了候选快照与事件历史检查。

## 首轮本地验证的缺口

I-AC02 仍未完成：需要 Ubuntu 上真实 POSIX 测试结果，以及允许建立异 owner
fixture 的 Windows 主机结果。CI 配置不是 CI 执行成功的证据；本会话不启动共享 Docker/WSL 或请求提权。本地令牌文件是明文，只防其他普通 OS 用户，不防同用户进程、管理员/root、备份或账户被攻陷。

本文件不提供生产账号授权、生产端点读写或干净机器安装验收；这些属于父任务管理的现实阶段。未改动 D-* 复选框，未暂存、提交、推送或追加生命周期事件。

## 父级复核与首次同步阻塞

父级复核后在实施候选 `aedb16776a4fefbbe4c4668e66e821aae8bc2074` 上再次运行
`pnpm check`，20/20 工作区任务通过。已补充目录/CAR 已知根与上传响应 CID 的语义一致性校验，覆盖不同根拒绝以及 CIDv0/v1 等价表示；新增测试最初暴露的 multihash 类型错误也已修复并通过完整检查。

另外从该本地提交创建了独立干净 checkout，执行
`pnpm install --frozen-lockfile`、CLI/Worker 及依赖构建、CLI 帮助、真实本地 Worker 集成和 CLI 测试：6 项 Worker 集成通过，CLI
49 项通过、2 项平台/权限能力跳过。安装时因 CLI 尚未构建产生一次 bin
shim 缺失警告；按文档构建后通过直接 Node 入口运行成功，不把该入口描述成已发布的独立安装包。这些是干净源码安装和本地合成账户的补充证据，不替代真实生产账户验收。

同步 primary 时 GitHub 连续返回 `fatal error in commit_refs_rules` 或
`Internal Server Error`；普通 main 推送和普通 topic 分支推送均失败，未强推、未改写历史、未绕过仓库策略。刷新后的远端 primary 仍为
`66727471d8bbe3b2c73e8291e505c3d4c150e804`，实现已保存在本地 `docs/pinboard-cli`
的提交中，但尚未到达 primary。因此无法触发本候选的 Ubuntu/Windows
CI；I-AC02 继续未完成，不追加 `submitInner` 或
`acceptInner`，不宣称跨平台验收通过。

本会话未发现可供 CLI 使用的生产 token，集成浏览器在生产域名显示未登录。真实账户现实验证仍需授权凭据，不能通过造会话、读取未知秘密或降低验收要求替代。恢复条件是 GitHub 接受普通推送、取得真实 CI 结果，并在现实阶段具备可用授权账户；无需重新征求已委托的门禁审批。

## 恢复同步后的真实 CI

2026-11-04 再次 fetch、无改写集成后，一次普通 `git push origin HEAD:main`
成功，候选 `c9e92e3582d5a824571e483f46ba621004b00480`
已可从刷新后的 primary 到达；先前 GitHub
500 阻塞已解除。没有尝试强推、其他 Git 传输或策略绕行。

[CI 41822176353](https://github.com/shazhou-ww/pinboard/actions/runs/41822176353)
实际执行了 Ubuntu/Windows × Node.js 22.13.0/24.11.1：

- Ubuntu Node.js 24.11.1 的 `pnpm check` 20/20 任务全部成功，CLI
  49 项通过、2 项 Windows 专属测试跳过；真实 POSIX 权限和所有者检查已执行。
- 另外三个矩阵项暴露了短超时测试在请求前耗尽时限、Windows Node.js
  22 路径/句柄 stat 元数据不一致、以及 Windows runner
  checkout 祖先目录不适合保存凭据的问题。保留这些失败，不将单一绿色任务冒充全矩阵通过。
- 修复提交 `b6c6819895b20db8126477a38d3e7c288b4e933a`
  将输入时间戳限定在同一 stat
  API 内比较，同时保留跨 API 的设备、inode、大小以及读取前后路径检查；超时测试先证明请求已发出，真实 Worker 测试保持响应挂起直至命令超时，并要求写入已经提交。
- Windows CI 的真实凭据 fixture 使用当前用户 profile 下的独立目录，通过
  `PINBOARD_TEST_ROOT`
  传给测试；不放宽生产 DACL 或祖先目录检查，不修改共享系统目录权限。
- 修复代码在本地 `pnpm check`
  20/20 成功后提交；同步时正常集成了其他会话的 CAR-indexed
  storage 想法历史，没有修改其契约或事件。

[CI 41823338788](https://github.com/shazhou-ww/pinboard/actions/runs/41823338788)
在四个平台均于测试前被新集成的无关想法文档格式拦截：
`01M6K5F9464DZXAZVHCMYNHWED/outer/inner/ideal/Idea.md` 和
`outer/inner/Implementation.md`
不符合 Prettier。已通知该想法的负责会话处理，CLI 会话未修改其接受的理想世界。截至该次运行，修复后的矩阵结果仍未得到证明，I-AC02 未完成。

### 最终平台结果与缺口关闭

格式问题由 CAR 想法的负责会话修复并按其权限处理重新接受；本会话通过普通 merge/fetch 保留了该历史及随后提交的 CAR 存储实现。CLI 的理想世界、生命周期事件和现实世界契约未改动。

Windows Node.js 22 的进一步本地实测确认：同一文件的路径 `lstat.dev`
为零（不可用），句柄 `fstat.dev`
为实际卷 ID；最初仅调整时间戳比较不足以解决问题。提交
`006e56fc2470c5732158c482f52f66589e8b1ac3`
为输入和凭据读取统一使用精确 bigint 文件 ID；只在 Windows 的设备 ID 不可用时允许该字段缺省，仍要求精确 inode、单链接凭据和现有路径/句柄检查。增加真实路径/句柄回归及超过 JavaScript 安全整数范围的不同 inode 拒绝断言。本机已有 Node.js
22.13.0 下 CLI 测试 50 项通过、2 项平台/权限限制跳过。

运行
[41825511934](https://github.com/shazhou-ww/pinboard/actions/runs/41825511934)
和
[41826449509](https://github.com/shazhou-ww/pinboard/actions/runs/41826449509)
显示 Ubuntu 两版本成功，但 Windows 原生 PowerShell 辅助进程在 15 秒期限内未返回，内部诊断为
`code: null`、`killed: true`、
`signal: SIGTERM`、空 stdout/stderr。关闭不用的 stdin 后该问题仍存在；没有通过延长期限、跳过权限检查或降低要求制造成功。

最终提交 `82b72b6b7c2cebbf7b00a9b0a056621cd93a179c`
将权限辅助脚本改为直接调用 Windows PowerShell/.NET 文件系统 ACL API，不再依赖
`Get-Acl`、`Get-Item` 或 `New-Object`
模块发现；当前 SID、受保护唯一授权、继承禁用、祖先所有者/替换权限及 reparse拒绝要求均保留。提交前本地
`pnpm check` 20/20 任务通过。

[CI 41827926346](https://github.com/shazhou-ww/pinboard/actions/runs/41827926346)
针对该准确提交实际完成并全部成功：

| 平台与 Node.js  | Job ID         | CLI 原生测试    | 完整检查 |
| --------------- | -------------- | --------------- | -------- |
| Windows 22.13.0 | `126567441475` | 51 通过、1 跳过 | 20/20    |
| Ubuntu 22.13.0  | `126567442138` | 50 通过、2 跳过 | 20/20    |
| Windows 24.11.1 | `126567442149` | 51 通过、1 跳过 | 20/20    |
| Ubuntu 24.11.1  | `126567442216` | 50 通过、2 跳过 | 20/20    |

原生测试前置任务在各 runner 上无缓存实际执行；完整检查随后仅复用本任务产生的 3 个依赖/CLI 结果。Windows 唯一跳过为 POSIX 专属测试，实际另一 Windows 所有者的受保护文件拒绝测试已执行并通过；Ubuntu 跳过两个 Windows 专属用例，实际 POSIX
0700/0600、所有者、链接和祖先权限拒绝已执行。所有平台的 6 项真实 Worker CLI
HTTP 集成通过；合并 CAR 实现后 Worker 全套为 66 通过、1 项独立的可选 smoke 跳过，不是 CLI 权限或集成用例跳过。

因此 I-AC02 的跨平台证据缺口已关闭，并据实勾选其 ledger 条目；所有 I-* 工作与验收条目均完成。这里记录的是实施结果，不追加
`submitInner` 或
`acceptInner`，不改动 D-*，不声称生产账户验收，不发布 npm 或执行生产 rollout。准确的后续世界修订及提交/门禁由父任务重新观察并处理。

### 本地复现命令

```powershell
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=@workspace/cli --filter=@workspace/worker
node .\apps\cli\dist\main.js --help
pnpm --filter @workspace/worker exec vitest run test\cli.test.ts
pnpm --filter @workspace/cli test
pnpm check
```

完整用户步骤与权限修复边界见 [CLI 使用说明](../../../../../docs/cli.md)。
