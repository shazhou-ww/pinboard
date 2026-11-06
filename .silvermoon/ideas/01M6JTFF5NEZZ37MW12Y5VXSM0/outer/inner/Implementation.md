# Implementation

已实现独立 API CLI、共享目录编码与工作区测试；设计范围仍以接受的
[CLI 设计](ideal/CLI-design.md) 为准。实现与检查记录见
[实施证据](Evidence.md)。Ubuntu/Windows 与两个受支持 Node.js 版本的真实 CI 已通过，包含 Windows 异所有者拒绝测试。2026-11-06 独立复核发现当前源码及已发布 0.2.0 的帮助缺少本契约要求的公开读取与移除引用说明；I-S03、I-AC02 重新打开，修复并定向验证前不提交 submitInner。本契约不声称生产账户验收或现实阶段完成。

## Steps

### I-S01: 建立命令与认证边界

在工作区内实现命令解析、配置优先级、安全 HTTP 客户端、JSON 输出与失败退出码；对接已有 pin
API，不新增服务端协议。

入口位于
`apps/cli`：顶层上传、导入、列表、详情、移除，以及配置与本地 token 管理。JSON 成功与失败流分离，分页全部成功后才输出；写入不自动重试，响应丢失明确报告不确定结果。

增加配置旁独立 token 文件及保存、移除入口，按 endpoint 隔离并支持环境变量覆盖；实现 POSIX 权限及 Windows
ACL 的安全创建、验证和明确失败，不增加系统凭据库依赖。

凭据文件采用受保护目录、预先设权的暂存文件、同目录原子替换与跨进程锁；Windows 使用真实 PowerShell/.NET
DACL 验证，辅助进程不接收 token 参数或 token 环境变量。

### I-S02: 复用 API 与共享目录编码

普通文件直接使用 `kind=file`，已有 CAR 使用
`kind=car`。从 Web 提取环境无关的目录 CAR 编码逻辑，供浏览器和 CLI 文件流适配器共同使用；保持现有编码选项、路径与空目录语义，不引入 Kubo 运行依赖。

共享核心位于
`packages/encoding`，仅接受相对路径、大小与异步二进制内容流；Web 保留 File/Blob 适配，CLI 扫描与有界读取本地文件，拒绝链接和特殊输入。

### I-S03: 补齐验证与使用文档

接入现有工作区检查，为 CLI、共享编码器、Web 回归和 Worker
API 增加针对性验证，并记录无需 Kubo 的安装、公开内容语义和故障恢复。

用户入口见
`docs/cli.md`；真实编译 Worker/workerd、D1/R2 与 CLI 的本地 HTTP 集成位于
`apps/worker/test/cli.test.ts`。CI 增加 Windows/Ubuntu 与现有 Node 版本矩阵，尚未运行的平台结果不由配置本身推断。

## Acceptance criteria

### I-AC01: 上传内容与 Web 语义一致

在无 Kubo 可执行文件、无 daemon 的环境中，通过本地 Worker 验证文件、嵌套目录、隐藏文件、空文件和 CAR 上传；相同文件与目录 fixture 的 CLI/Web 根 CID 相同，CAR 保持原根，导出后字节一致。验证空目录按 Web 规则忽略、全空目录拒绝，以及缺失 DAG、超限和不支持输入明确失败。

### I-AC02: 认证与自动化行为可靠

验证 `upload`、`import`、`list`、`inspect`、`remove`
均为顶层命令，帮助与示例不要求 `pins`
层级；命令扁平化不改变 HTTP 路由、JSON 字段、权限或移除账户引用的语义。

验证 `upload` 与 `import` 共享
`--name`、endpoint 及输出规则，默认使用输入 basename；不同 CID 允许重名，同账户同 CID 再次保存更新标签，名称不影响 CID。

通过真实平台文件系统测试验证 POSIX `0700`/`0600`
及 Windows 当前用户 DACL，覆盖首次保存、覆盖更新、移除、并发冲突、权限过宽、错误所有者、路径链接及无权限支持时拒绝保存。验证 endpoint 绑定、环境变量/标准输入覆盖且不落盘、空环境变量明确失败；无对应凭据时不跨 endpoint 取 token。不能仅 mock 权限 API 后声称平台安全性成立。

测试覆盖最小权限、过期与撤销、分页、每条联网命令的 endpoint 单次覆盖及配置优先级、HTTP 错误、JSON 输出、失败退出码，以及超时后不误报成功、不自动重放写入。文件、目录和 CAR 上传无需公开参数或交互，均自动携带公开声明头；帮助明确说明公开发布与移除引用语义。凭据不进入 URL、子进程参数或日志；直接 API 的公开声明校验保持不变。

### I-AC03: 无 Kubo 依赖且工作区检查通过

验证所有命令不启动或探测 IPFS 子进程、不连接 daemon
RPC，且并行、失败和中断不泄漏资源；共享编码提取后的 Web 行为不变。CLI 相关检查和提交前的
`pnpm check` 通过；Kubo 只用于可选的互操作验证，不成为基础检查或运行的前提。
