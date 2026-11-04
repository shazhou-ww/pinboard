# CLI 设计：独立 API 客户端与共享目录编码

本文是 [构想](Idea.md)
的设计支持材料。命令均为拟议接口，并非已实现功能；具体模块与任务在构想通过后再细化。本版取代原先“封装本地 Kubo”的方案，不再引入 IPFS 可执行文件或 daemon
RPC 依赖。

## 定位与取舍

CLI 与 MCP 一样作为现有 API 的客户端，不经由 MCP 传输文件，不要求用户拥有 IPFS 节点。

| 路径                           | 复用能力与代价                                           | 本次选择                              |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------- |
| 标准 `ipfs pin remote`         | 提交 CID，不直接携带文件字节，通常需要另外取回 DAG       | 不作为上传入口                        |
| Kubo RPC 或本地可执行文件封装  | 可上传或编码，但引入协议兼容、安装、版本、仓库或进程管理 | 不作为 CLI 运行依赖，也不提供隐式回退 |
| 独立 HTTP 客户端与成熟 IPFS 库 | 直接复用上传与管理 API，目录复用现有 Web 编码            | 采用                                  |

不实现完整 Pinning Service API，不增加服务端 P2P、DHT 宣告、Kubo
RPC 或远程 CID 拉取。标准 IPFS 客户端仍可在显式配置下读取内容，相关能力独立于本 CLI；仅按已验证的网关和路由范围描述，不暗示自动公网发现。

## 用户入口

```powershell
pinboard config set endpoint https://pinboard.shazhou.work

# PINBOARD_AGENT_TOKEN 由用户在本机通过秘密管理机制提供。
pinboard upload .\file.txt
pinboard upload .\folder --name example
pinboard import .\archive.car
pinboard import .\archive.car --name example

pinboard list --json
pinboard inspect <CID>
pinboard remove <CID>

# 单次覆盖服务地址，不修改已保存的配置。
pinboard upload .\file.txt --endpoint http://localhost:8787
```

- `upload` 接受一个普通文件或目录；`.car` 文件在这里仍是普通文件，只有 `import`
  才按 CAR 协议处理，与 Web 现有语义一致。
- `upload` 与 `import`
  共用命名、认证、endpoint、公开发布及输出语义，区别仅在输入解释与相应处理路径；`import`
  不是另一种账户 pin。
- 两者均支持
  `--name`，未指定时默认使用输入文件或目录的 basename。名称仅为当前账户 pin 的标签，可重名，不改变内容、目录内部路径或 CID；同一账户重复保存相同 CID 时沿用现有 upsert 行为并更新标签，不创建第二条同 CID 的 pin。默认名称也必须满足服务端长度和有效性限制，不静默截断。
- 不提供含混的 `pinboard pin <CID>`
  来暗示远程获取；第一版不单独暴露“引用已有 CID”。已有 HTTP/MCP 能力保持不变。
- `upload`、`import`、`list`、`inspect` 和 `remove`
  都以 pin 为操作对象，统一放在顶层，不增加 `pins`
  命令组或冗余别名；配置仍单独归入 `config`。HTTP 的 `/api/pins`
  路由与 JSON 中的 `pins` 字段不受命令层级影响。
- `remove` 仅删除账户引用；帮助必须说明公开 blocks、CDN 及他人副本不会随之擦除。
- `config set`
  只保存服务地址等非敏感设置；默认使用现有生产 origin，本地地址必须显式配置。移除原方案的 Kubo 路径与版本设置。
- Token 来自 `PINBOARD_AGENT_TOKEN`，可提供 `--token-stdin`
  作为互斥替代；同时指定时明确报用法错误。不提供命令行明文 token 参数或明文配置存储。第一版不实现 OAuth 登录、token 签发或 OS 密钥链，token 从 Web 获取。
- 每条联网命令均支持 `--endpoint` 单次覆盖，不修改用户配置；优先级为
  `--endpoint`、`PINBOARD_ENDPOINT`、用户配置、默认值。切换 endpoint 时由用户提供对应服务的 token，不自动探测或转发其他服务的凭据。配置放在用户配置目录，不写进项目；不因当前工作目录中的文件而暗中改写目标 origin。

## 三条上传路径

| 输入     | CLI 行为                                                      | 现有 API                                   |
| -------- | ------------------------------------------------------------- | ------------------------------------------ |
| 普通文件 | 按二进制发送原始文件，不在客户端重复编码 UnixFS               | `POST /api/pins/upload?kind=file&name=...` |
| 目录     | 扫描与规范化相对路径，通过共享编码器生成完整、单根 UnixFS CAR | `POST /api/pins/upload?kind=car&name=...`  |
| 已有 CAR | 上传原始 CAR，不重新导入或编码                                | `POST /api/pins/upload?kind=car&name=...`  |

三条路径都由现有 Worker 执行权限、CID/hash、完整 DAG、大小限制校验，再写入 R2 并保存账户引用；不新增服务端协议。客户端的提前检查不能替代服务端权威校验。

普通文件沿用 Worker 的 `importFile`；目录复用 Web 已使用的
`ipfs-unixfs-importer`、`@ipld/car` 和
`multiformats`，不手写 UnixFS、CID 或 CAR 编码器。CLI 不需要临时 IPFS 仓库、Kubo 子进程、daemon、RPC 地址或本地节点凭据。

## 共享目录编码与 Web 一致性

从现有 Web 的 `buildDirectoryCar`
提取环境无关的编码核心，放在独立共享工作区包；`packages/contracts`
继续承载接口与限制，不因本次提取承担文件系统或编码实现。

编码核心接收规范化相对路径与异步二进制内容流，不依赖浏览器
`File`、目录选择器或 Node 文件系统。Web 适配器将选择结果转换为该输入，再包装为现有上传所需的 Blob；CLI 适配器负责本地路径扫描与读取。共享核心统一编码选项、完整 CAR 输出和编码限制，依赖版本沿用 pnpm
catalog，内部包使用 `workspace:*`。

提取时保持 Web 当前 CIDv1、raw
leaves、目录包装选项及其他有效默认值，不趁机改变 chunker 或编码策略。相同相对路径和字节的 CLI/Web 目录 fixture 必须得到相同根 CID；普通文件的 CLI/Web 上传都走 Worker 的文件编码路径。CAR 上传则保持原根 CID；比较按 CID 语义归一化，不只比较展示字符串。

这是一项实际的跨环境提取工作，不是直接把浏览器文件复制到 CLI；实施时必须证明 Web 文件选择、拖放、编码和上传均无回归。

## 输入与限制

- 一个顶层项目，目录内保留相对路径；包含隐藏文件，不自动应用
  `.gitignore`。提示用户审查公开内容；拒绝符号链接、特殊文件和不安全路径，不偷偷跟随目录外内容。
- 空文件保留。与 Web 对齐：空目录不编码，完全没有文件的目录明确拒绝；帮助应明示此规则。取消原 Kubo 方案中保留空目录的差异。
- 目录 CID 代表目录内容，子项直接位于其下，不额外加入一个包装目录。根文件夹名称用于账户标签；路径分隔符在输入适配层规范化。
- 沿用 32 MiB 上传体及唯一 DAG 字节、256 个 blocks、单 block 2
  MiB、现有 codec/hash 与单根完整 CAR 限制；CAR 元数据可能使近上限内容超限。
- 文件扫描、内容读取和编码输出尽早检查限制，不能只检查原始文件总大小。失败时不自动裁剪、忽略文件或改用另一种编码。
- 二进制内容不经过 shell、文本重定向或 base64。优先复用现有有界内存编码方式；避免无界缓冲和不必要的完整副本，不为本次需求引入磁盘缓存系统。
- 文件变化、权限不足、读取中断、超限或无效 CAR 均显式失败；不声称对正在变更的目录提供原子快照。

## 认证、公开发布和 HTTP 行为

`upload` 和 `import` 的固定语义就是公开发布，不提供
`--public`、`--confirm-public`、私有模式或二次确认，TTY 和自动化行为一致。CLI 对每次上传自动发送现有
`X-Pinboard-Public: true`，把明确的上传命令映射为 API 的公开声明；服务器仍拒绝未携带该头的直接 API 上传，不修改 Web/MCP 的确认机制。

命令帮助和使用文档必须在上传说明中直接标明“内容公开，知道 CID 即可读取；移除 pin 不等于擦除内容”。不把说明变成阻塞提示，不增加确认配置或交互向导。

Token 只用于 CLI 直接发出的 Authorization 请求头，不放 URL、子进程参数、JSON 结果或诊断日志。非 loopback 地址要求 HTTPS；禁止携带凭据跟随重定向，确保 token 不被转发到其他 origin。令牌仍由服务器逐请求校验账户、scope、有效期和撤销状态；不新增账户身份参数或降低服务端授权。

上传响应丢失、超时或被中断时，服务器可能已经完成写入：不能报成功，也不自动重传。目录或可识别的 CAR 已知根 CID 时提示查询账户详情；普通文件若尚无返回 CID，则提示检查账户列表和名称，不凭空假定已知 CID。所有写入默认不自动重放。错误输出需过滤服务响应和请求诊断中的敏感内容。

## 输出、分页和恢复

- 人类模式显示 CID、名称、大小及分享链接；编码和上传进度只写 stderr，不暗示服务端已经保存。
- `--json` 的成功输出为单个 JSON 文档，不混入进度；列表输出采用
  `{ "pins": [...], "nextCursor": ... }`，详情和上传采用共享 pin 结构，删除返回明确的删除结果。
- 列表默认读一页，支持 `--cursor`；`--all`
  显式遍历到末页，只有全部成功后才输出完整 JSON，不把部分结果伪装成完整列表。
- `--json`
  失败时 stdout 留空，stderr 输出结构化错误；不依赖本地化文案判断状态。拟定退出码：成功
  `0`、运行或服务失败 `1`、用法错误 `2`、用户中断 `130`。
- 请求和文件读取可取消、有超时；失败和中断时关闭本次流与连接，停止编码。不得探测、启动、停止或修改用户 IPFS 节点；不自动删除未知目录。

## 可交付范围与验证

拟在 pnpm/Turborepo 内增加 TypeScript CLI 工作区及共享编码工作区包，复用 Node
22.13+、现有 contracts 和 catalog 库，脚本对齐现有 build/lint/typecheck/test。具体包名及命令解析依赖在实施时确定；第一版可本地构建或包归档安装，不把 npm 名称占用、单文件发行或自动更新作为前提。

基础测试和真实本地 Worker 集成必须在未安装 Kubo、未运行 daemon 的条件下成立，覆盖三条上传路径、目录 CLI/Web
CID 一致性、CAR 导出重建字节一致，以及隐藏文件、空文件、空目录、路径空格和非 ASCII 名称。通过依赖与运行路径检查，证明没有 Kubo 可执行文件、子进程或 RPC 依赖。

共享编码提取需同时验证现有 Web 行为与限制边界，认证、分页、JSON、取消和不确定写入结果也需测试。Kubo 可在单独的可选互操作测试中用冷仓库重建内容，但不是 CLI 运行、基础检查或安装前提；既有 Kubo 测试能力保持独立。

服务端没有新增协议和部署要求；实施阶段跑相关测试及
`pnpm check`，现实阶段再验证无 Kubo 的干净安装和授权账户。生产凭据缺失不能用合成会话冒充真实验收。本文只定义候选，不把已有 Web/MCP 能力当作尚未实现的 CLI 验收证据。

## 依据

- [当前接口和限制](../../../../../../README.md)
- [现有 HTTP 上传与 token 说明](../../../../../../docs/mcp.md)
- [Web 目录编码](../../../../../../apps/web/src/directory.ts)
- [Web 文件与目录输入处理](../../../../../../apps/web/src/uploads.ts)
- [Worker 文件编码及 DAG 校验](../../../../../../apps/worker/src/content.ts)
- [现有上传与账户 pin 服务](../../../../../../apps/worker/src/service.ts)
- [可选 Kubo 读取配置与互操作验证](../../../../../../docs/kubo.md)
