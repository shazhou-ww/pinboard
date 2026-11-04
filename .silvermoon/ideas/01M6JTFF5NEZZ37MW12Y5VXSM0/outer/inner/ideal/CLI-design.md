# CLI 设计：封装 Kubo，保留主动上传架构

本文是 [构想](Idea.md)
的设计支持材料，用于评审工具复用、产品边界和可行性；命令均为拟议接口，并非已实现功能。具体模块与任务在构想通过后再细化。

## 为什么不是标准远程 pin 或 Kubo RPC

目标是缩短上传工作流，不是变成另一种服务：

| 路径                   | 能复用什么                           | 本次选择                                                                |
| ---------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| 标准 `ipfs pin remote` | CID 请求、状态和管理工具             | 不作为上传入口；不携带文件字节，通常需要另外取回 DAG                    |
| 兼容 Kubo `--api`      | 直接通过 HTTP 上传文件或 CAR         | 暂不增加；参数较长，且会增加版本探测、multipart、导入选项和响应兼容负担 |
| CLI 封装本地 Kubo      | UnixFS 编码、目录 DAG、CID、完整 CAR | 采用；IPFS 底层能力复用 Kubo，用户凭据和业务操作由 CLI 管理             |

标准 Pinning Service API 与 Kubo
RPC 是不同协议。采用标准 CAR 并不意味着实现完整标准 pin 服务，也不意味着内容已在公网 DHT 上宣告。

## 用户入口

```powershell
pinboard config set endpoint https://pinboard.shazhou.work
pinboard config set kubo-path 'C:\tools\kubo\ipfs.exe'

# PINBOARD_AGENT_TOKEN 由用户在本机通过秘密管理机制提供。
pinboard upload .\file.txt --public
pinboard upload .\folder --name example --public
pinboard import .\archive.car --public

pinboard pins list --json
pinboard pins inspect <CID>
pinboard pins remove <CID>
```

- `upload` 接受一个普通文件或目录，统一走 Kubo 编码和 CAR 上传；`.car`
  文件在这里仍是普通文件，只有 `import` 才按 CAR 协议处理，与 Web 现有语义一致。
- 不提供含混的 `pinboard pin <CID>`
  来暗示远程获取；第一版不单独暴露“引用已有 CID”，避免和上传混淆。已有 HTTP/MCP 能力保持不变。
- `pins remove`
  仅删除账户引用；帮助必须说明公开 blocks、CDN 及他人副本不会随之擦除。
- `config set`
  只保存服务地址和 Kubo 路径等非敏感设置；默认使用现有生产 origin，本地地址必须显式配置。
- Token 优先取 `PINBOARD_AGENT_TOKEN`；可提供 `--token-stdin`
  作为互斥替代，不提供命令行明文 token 参数或明文配置存储。第一版不实现 OAuth 登录、token 签发或 OS 密钥链，token 从 Web 获取。
- 服务地址与 Kubo 路径按命令行选项、对应环境变量、用户配置、默认值依次解析。配置放在用户配置目录，不写进项目或 Kubo 仓库；不因当前工作目录中的文件而暗中改写目标 origin。

## 上传路径与隔离

```text
文件或目录
  → CLI 校验输入并创建独立临时仓库
  → Kubo 离线 add
  → Kubo 离线 dag export
  → 完整、单根 CAR
  → 现有 POST /api/pins/upload?kind=car&name=...
  → 现有 DAG 校验、R2 存储及账户引用
```

已有 CAR 跳过 Kubo 和临时仓库，直接上传。账户管理也不依赖 Kubo；缺少 Kubo 只阻塞文件或目录编码，并给出安装指引。

文件和目录编码使用临时
`IPFS_PATH`，不继承用户仓库；离线运行，不启动 daemon、不访问用户正在运行的节点。显式使用 CIDv1、SHA2-256、raw
leaves 和 256 KiB
chunk，避免 Kubo 默认配置漂移。临时仓库中的本地 pin 随本次工作区清理，不在用户仓库留下 pin。

通过进程参数数组启动 Kubo，不经过 shell 拼接；不把 token 或其他无关敏感环境传给子进程。CAR 以二进制流写入受控临时文件，不使用 PowerShell 文本管道，也不把整个 CAR 转成字符串或 base64。

导出必须使用完整遍历的 `dag export --offline`，不能使用会跳过缺失 blocks 的
`--local-only`。上传前必须确认子进程成功退出，避免把截断输出当作合法上传。服务响应的 CID 与导出根按 CID 语义归一化比较，不因 CIDv0/v1 展示不同误判；服务端仍负责权威 hash 与 DAG 校验。

## 输入与限制

- 一个顶层项目；保留目录内部相对路径及文件字节。显式包含隐藏文件，提示用户检查敏感内容；拒绝符号链接、特殊文件和不安全路径，不偷偷跟随仓库外内容。
- 空文件保留。拟保留 Kubo 支持的空目录，完全空目录也按目录 DAG 处理；这是相对 Web 当前忽略空目录的有意差异，必须通过集成测试后才对外声明。
- 目录 CID 代表目录本身，子项直接位于其下，不额外加入一个包装目录。根名称仅作为账户标签；同字节内容不承诺与浏览器编码器产生完全相同的 CID，除非另有实测。
- 第一版沿用 32 MiB 上传体及唯一 DAG 字节、256 个 blocks、单 block 2
  MiB、现有 codec/hash 与单根完整 CAR 限制；CAR 元数据可能使近上限内容超限。
- 文件扫描、编码输出和 CAR 文件大小应尽早检查，但不能以原始文件总大小替代 DAG 限制。共享限制和 CID 工具复用
  `packages/contracts` 及现有依赖，不手写 UnixFS 或 CAR 编码器。
- 文件变化、权限不足、导出失败、超限或无效 CAR 均显式失败；不自动裁剪内容、忽略文件或改用另一种编码。

## 认证、公开确认和 HTTP 行为

所有上传要求显式 `--public`，再由 CLI 发送现有
`X-Pinboard-Public: true`。TTY 下可提示补充该选项，但不能静默确认；自动化缺少确认时直接失败，不等待输入。普通配置不能永久隐式开启公开上传。

Token 只用于 CLI 直接发出的 Authorization 请求头，不交给 Kubo，不放 URL、子进程参数、JSON 结果或诊断日志。非 loopback 地址要求 HTTPS；禁止携带凭据跟随重定向，确保 token 不被转发到其他 origin。令牌仍由服务器逐请求校验账户、scope、有效期和撤销状态。

本次 Kubo v0.43.1 的回环探针观察到 `--api-auth`
会同时出现在 RPC 查询参数中；选定方案不使用这个远程 RPC 认证路径。CLI 的错误输出需过滤服务响应和请求诊断中的敏感内容。

使用现有 pin
API，不新增账户身份参数或降低服务端授权。上传响应丢失、超时或被中断时，服务器可能已经完成写入：不能报成功，也不自动重传；提示用已知 CID 查询账户详情后再决定重试。所有写入默认不自动重放。

## 输出、分页和恢复

- 人类模式显示 CID、名称、大小及分享链接；编码和上传进度只写 stderr，不暗示服务端已经保存。
- `--json` 的成功输出为单个 JSON 文档，不混入进度；列表输出采用
  `{ "pins": [...], "nextCursor": ... }`，详情和上传采用共享 pin 结构，删除返回明确的删除结果。
- 列表默认读一页，支持 `--cursor`；`--all`
  显式遍历到末页，只有全部成功后才输出完整 JSON，不把部分结果伪装成完整列表。
- `--json`
  失败时 stdout 留空，stderr 输出结构化错误；不依赖本地化文案判断状态。拟定退出码：成功
  `0`、运行或服务失败 `1`、用法错误 `2`、用户中断 `130`。
- 请求和子进程均可取消、有超时；进程结束、失败和正常中断时清理本次临时目录，只终止自己启动的进程。强制杀进程或断电不承诺即时清理，残留路径可诊断，不自动删除未知目录。

## 可交付范围与验证风险

拟在 pnpm/Turborepo 内增加 TypeScript CLI 工作区，复用 Node
22.13+ 与现有 contracts，脚本对齐现有 build/lint/typecheck/test。具体包名及命令解析依赖在实施时确定；第一版可本地构建或包归档安装，不把 npm 名称占用、自动安装 Kubo、单文件发行或自动更新作为前提。

需要真实 Kubo 的集成验证，不能只 mock 子进程：文件、嵌套路径、隐藏文件、空文件、空目录、二进制完整性及冷仓库重建；还要覆盖当前仓库已有 daemon 时不被触碰。Windows 路径、空格及非 ASCII 文件名属于必要输入，不应由 shell
quoting 偶然决定行为。

Kubo v0.43.1 已在本次设计调研中完成离线目录 CAR 往返，并验证 `--api` 的 `add` 与
`dag import`
确实发送 HTTP 文件字节；这是方案选择的可行性线索，不是尚未实现的 CLI 验收证据。先将 v0.43.1 作为集成测试基线，其他版本须验证后才宣称支持。

服务端没有新增协议和部署要求；实施阶段跑本地 Worker 集成及
`pnpm check`，现实阶段再验证干净安装和授权账户。生产凭据缺失不能用合成会话冒充真实验收。

## 依据

- [当前接口和限制](../../../../../../README.md)
- [现有 HTTP 上传与 token 说明](../../../../../../docs/mcp.md)
- [本地 Kubo 互操作验证](../../../../../../docs/kubo.md)
- [Kubo v0.43.1 add](https://github.com/ipfs/kubo/blob/v0.43.1/core/commands/add.go)
- [Kubo v0.43.1 CAR export](https://github.com/ipfs/kubo/blob/v0.43.1/core/commands/dag/export.go)
- [Kubo v0.43.1 remote pin](https://github.com/ipfs/kubo/blob/v0.43.1/core/commands/pin/remotepin.go)
- [Kubo v0.43.1 RPC 分发与鉴权](https://github.com/ipfs/kubo/blob/v0.43.1/cmd/ipfs/kubo/start.go)
- [IPFS Pinning Service API](https://ipfs.github.io/pinning-services-api-spec/)
