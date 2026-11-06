# CLI 交付证据

## 当前状态

最新真实账户结果见
[生产定向核验](Production-verification.md)：文件、目录和 CAR、独立下载、列表游标、引用移除及本地 token 移除均通过。当前仅等待用户撤销专用 token 后验证服务端拒绝并最终清理本地凭据；下文“等待准备”均为该次执行前的历史观察，不代表仍缺上传授权。

2026-11-06，按用户“你替我验收就行”的委托，基于独立核验结果接受
`implementationRevision=9e4b5edb9c73`；acceptInner 已同步 primary，idea 进入 deploying。这不是 acceptOuter，也不是 npm 发包、生产部署、迁移或真实账户写入授权。

## D-S01：独立安装证据复用

上一阶段已独立下载
`@shazhou/pinboard@0.2.0`，核对准确 SHA-512，在新建的 checkout 外部目录中离线安装，通过真正的 Windows
`pinboard.cmd`
启动。Node.js 为 24.11.1，包要求 22.13+；PATH 仅含复制的 Node，不含 Kubo、pnpm 或 checkout 依赖。顶层命令帮助、JSON 帮助、默认 endpoint 和用法退出码通过，临时安装与缓存已清理。详细字节值、平台限制和首次失败见
[独立复核记录](inner/Evidence.md#2026-11-06-独立实现复核)。

[CI 42182602485](https://github.com/shazhou-ww/pinboard/actions/runs/42182602485)
针对 `5e25788ace88fa36df271a3872b2f3e8637dfbdb` 的 Ubuntu/Windows × Node.js
22.13.0/24.11.1 全部成功，包含修复后的帮助回归及准确构建归档隔离安装。这是源码候选的多平台证据，不声称本机验证了其他 OS。

因此 D-S01 完成。D-AC01 仍未完成：上述无凭据 smoke 不包含真实 token 安全保存、实际 ACL 核验和三条上传路径；已发布 0.2.0 仍缺少帮助语义修复，没有重发。

后续真实操作已补齐 D-AC01，详见生产定向核验；该安装能力验收不等于 npm 重新发布。

## D-S02 / D-AC02：尚无真实账户验证

尚未取得本次 CLI 生产读写授权、专用最小权限 Agent
token、安全输入通道或账户所有者撤销配合。没有读取现有本地秘密，没有请求用户把 token 发到聊天，也没有创建生产资源。本轮未验证真实账户上传、分页、详情、移除引用后公开读取、撤销后拒绝；历史合成 Worker
fixture 和其他 idea 的 OAuth/CAR 验收不能替代这些证据。

恢复条件为用户确认目标环境与可公开的合成内容，准备专用短期 `pins:read` /
`pins:write` / `pins:delete`
token，并确认经隐藏终端输入的临时受限存储及撤销方式。仅清理本次明确创建的资源；普通 remove 只移除引用，不承诺擦除公开数据。条件满足后按已同步的 Deployment 契约定向验证，再更新实际结果；目前不提交 submitOuter。

## 后续授权与当前等待条件

用户随后明确选择“授权；我会准备专用短期 token 并配合撤销”，授权目标为
`https://pinboard.shazhou.work`，范围为少量可公开的合成文件、目录和 CAR 的上传、下载核对、权限检查及本次引用移除；不包含 npm 发包、生产部署或无关资源操作。前述“尚未取得授权”是本次授权前的历史观察，已由此节更新。

当前仍等待用户准备专用短期 token 及本机隐藏输入前置条件，不读取或接收聊天中的秘密。所需权限为
`pins:read`、`pins:write`、`pins:delete`，不需要 publication 或管理权限。token 尚未提供、真实账户请求尚未执行、撤销测试尚未发生，D-S02、D-AC01、D-AC02 继续未完成。用户准备完成后再约定受限本地存储的明确位置、生命周期及隐藏终端输入；不在无交互条件下临时改用命令参数、聊天或未知凭据。
