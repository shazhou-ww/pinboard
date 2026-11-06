# CLI 真实账户交付核验

## 范围与结果

2026-11-06T09:09:41Z 至 09:10:59Z，按本 idea 已记录的有限授权，在
`https://pinboard.shazhou.work` 使用用户经本机隐藏输入保存的专用 Agent
token。仅创建两个唯一公开合成内容根，CAR 导入复用本次目录根，不创建 publication。账户已有引用只用于内存中的列表比较，没有记录其名称、CID 或下载内容。未发包、部署、迁移或重置数据，未使用其他 idea 的 MCP/浏览器会话替代 CLI。

真实上传、读取、引用移除及本地凭据操作通过；用户在 Web 撤销专用 token 后，服务端拒绝与最终本地凭据清理也已验证。全部 D-* 工作完成；仍需同步准确 outer
revision 并提交 submitOuter 后进入交付接受 gate，不在本文件代替 acceptOuter。

## 安装与凭据

- Windows / Node.js 24.11.1；从本地归档离线安装
  `@shazhou/pinboard@0.0.0-development.0`
  到 checkout 外的新建临时目录，没有 runtime npm dependencies 或 lifecycle
  scripts。归档 SHA-256：
  `8407496a0356aa52a544c46e959ee312f73626810d9168ba10472ea90c245d05`。
- 执行安装包内独立入口，PATH 仅含复制的 Node 与 Windows
  PowerShell 目录（凭据 ACL
  helper 所需），不含 Kubo、pnpm 或源码依赖。修复后的公开读取与移除语义帮助通过；此前已发布 0.2.0 的独立 shim 核验继续有效，但不把本地归档说成已发布版本。
- 用户专用凭据文件经独立 PowerShell `Get-Acl`
  核对：当前用户所有、受保护 DACL、单一当前用户规则且无继承项。CLI 自身也在读取时执行实际权限验证；token 不进入输出、命令参数或证据。
- 空 `PINBOARD_AGENT_TOKEN`
  明确失败且 stdout 为空，不回退本地秘密；显式无效环境 token 得到 HTTP
  401；内存中的专用有效 token 环境覆盖后读取成功，没有为覆盖测试增加磁盘秘密副本。
- 本地 `config remove-token` 后，受保护 Store 不再含该 endpoint， `list` 返回
  `TOKEN_REQUIRED`、退出 1、stdout 为空。随后使用 stdin 在原专用目录安全恢复同一 token，仅供服务端撤销拒绝验证；撤销验证完成后已最终移除专用本地记录。

## 真实内容与资源核对

| 操作                         | 实际结果                                                                |
| ---------------------------- | ----------------------------------------------------------------------- |
| 普通文件 upload / inspect    | 成功，返回根与详情一致；不传公开确认参数                                |
| 无凭据独立 HTTP 下载         | HTTP 200，字节与包含 NUL、0xff、CR/LF 的原文件完全一致                  |
| 目录 upload / download       | 隐藏文件、空文件、嵌套 Unicode 名称与原字节一致；空子目录按约定忽略     |
| CAR export / import / export | 导入根等于本次目录根，两次导出的完整 CAR 字节一致                       |
| list --all / list --cursor   | 两个本次根均出现；按本次文件 CID 游标查询所得后缀与排序后的账户列表一致 |
| remove / inspect             | 两个本次根的账户引用均移除；再次 inspect 均为 HTTP 404                  |
| 移除后无凭据独立下载         | HTTP 200，原文件字节仍完全相同，证明移除引用不等于立即擦除公开内容      |

本次创建并移除引用的唯一根：

- 文件：`bafkreiavkqfaxj4yyfhauptibdbyy435ibrrwdgxue2io6ukx2netbe6h4`
- 目录及 CAR：`bafybeicoqk76nvrtqojolspjnatqfwtqvf4zzxv4fbitu6ffi2nqi6jykm`

文件 SHA-256：
`15540a0ba798c14e0a3e6808c38c737d40631b0cd7a134877a8abe9a49849e3f`。完整 CAR
SHA-256：
`51b4a6feba268c8a70edfbb74e33c8934d505e3386c92e6570d02acc4ea1f844`。本次临时安装、缓存、源 fixture、下载和导出目录已清理；未清理任何既有账户引用。remove 遵守现有软删除/保留策略，不声称清除了服务端保留数据、CDN 或他人副本。

## 限制与剩余检查

- 账户初始 4 个引用，最多临时增加至 6 个，`nextCursor=null`。已验证真实游标路由与结果后缀，未观测服务端生成的跨 50 项分页；不批量写入生产凑页数。跨多页的逻辑回归继续引用已有实现测试，不冒充本次真实多页结果。
- 本次专用 token 的无效覆盖拒绝没有被当作撤销证据；后续使用同一真实凭据的撤销验证见下节。
- 已发布 0.2.0 不包含帮助修复；本次使用经接受源码构建的独立归档。如需更新 npm 包须另行明确发包授权，不是本验收的隐含动作。

## 专用 token 撤销与最终清理

用户明确确认“已在 Web 撤销本次专用 token”后，于 2026-11-06T09:14:35Z 完成验证：

- CLI 使用此前成功上传所用的同一专用凭据请求 `list`，返回 `HTTP_ERROR`、HTTP
  401、退出 1，stdout 完全为空，未回退匿名或其他 token。
- `config remove-token` 成功，确认专用 `tokens.json` 为
  `{}`；随后仅删除该空凭据文件和本次专用空目录。没有修改日常配置或其他会话凭据。
- 首次 PowerShell
  stderr 重定向被宿主包装成非 JSON，解析失败；未据此声称通过，也未输出或读取原始秘密。改用 Node 子进程捕获原始 CLI
  stderr，结构化验证上述结果后才清理。该辅助诊断文件已删除。
- 全部操作辅助脚本、fixture 与临时安装均已清理；本次两个引用已移除。本地清理不撤销已公开内容，服务端软删除保留及后续 GC 按现有生命周期处理。

D-S02、D-AC02 完成；真实列表验证边界仍为上节明确记录的游标查询，不声称实际产生了服务端跨 50 项分页。
