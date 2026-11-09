# 实施详情预览缓存

## Steps

### I-S01: 统一缓存上下文与生命周期

参考现有 preview-client 和 preview-cache，明确详情响应中稳定预览与可变描述的缓存边界、容量和失效规则；优先复用既有机制。

技术方案与风险见
[详情预览缓存技术方案](./PreviewCaching.md)。该文档支持本实施契约；已按当前链路和定向测试细化方案并记录实现证据，不扩展构想验收范围。

### I-S02: 接入详情展示及更新路径

让私有 item 和发布版本节点详情优先显示缓存、后台更新；接通描述保存、预览重试、账号切换和权限错误的更新或清除。

### I-S03: 验证缓存与既有行为

补充定向自动化测试，验证重复打开、后台更新、上下文隔离、失败及轮询，并运行项目既有检查。

## Acceptance criteria

### I-AC01: 重复打开无整体加载闪烁

组件测试延迟后台响应，证明再次打开时立即保留已有预览；请求断言验证新鲜预览的重复请求受到控制。

### I-AC02: 更新与隔离正确

定向测试证明描述保存、重试、版本及账号切换不会误用旧内容；401、403、404 清除受保护展示，其他刷新失败明确提示。

### I-AC03: 缓存有界且回归检查通过

验证容量和过期边界、存储不可用时的显式降级及待生成预览轮询；定向测试和 pnpm
check 通过。若同步后的 primary 引入独立基线失败，须明确归因并证明本改动适用检查通过，不以本构想修改其他已提交的构想契约。

## 实施证据

已接通 DescriptionClient 的会话内完整响应 LRU、缓存先展示并后台验证、共享读写及失效通知。私有 AccountManager、PublicationDialog、PublicationPage、独立高级节点读者使用统一入口；保持现有简化 UI、服务端授权与发布路由不变。具体机制、与准备方案的差异及测试矩阵见
[PreviewCaching.md](./PreviewCaching.md)
的“已实施的机制与方案细化”和“自动化证据”。

定向组合：description-client、description-reader、reading-details、preview-client、publications、preview 六个测试文件。类型检查使用已安装本地 tsc；仓库 ESLint 实际匹配的新增 .ts 文件及已有 preview-client 也通过。首次验证缺少内部工作区 dist，已用本地 tsc 构建 contracts、encoding、react-engraved-background。本实现未新增第三方依赖，也未恢复工作区安装；全检查包含仓库既有的离线 tarball 安装验证。npm/pnpm 有效 registry 均已确认是 Tencent 镜像，未访问官方 registry。

2026-11-09 定向组合最终为
**6 个文件、125 个测试通过**（其中新增客户端/读者测试51 个）；本地前端类型检查通过。请求代次、草稿 CAS、所有上下文隔离、权限/删除、存储降级及 128 条/2
MiB/64 KiB/1 小时精确边界均有自动化证据。

2026-11-09 最终源代码版本的 **pnpm
check 退出码为 0**。项目既有 format:check、release 验证、Turbo
lint/typecheck/test/build、CLI 和 background 离线包检查均通过；本地定向测试、类型检查及变更文件适用的 ESLint 也通过。没有未解决的实施阻塞。

可用已安装的本地 vitest.cmd 按上面六个文件组合重跑（避免 pnpm
exec 自动安装）；全工作区命令为 pnpm
check。Ledger 的全部 I-* 复选框仅镜像上述实施证明；D-* 保持未勾选。未修改 Ideal 或 events.jsonl，未执行生命周期接受/提交、commit、push、部署或发布；外层浏览器与生命周期验收仍由父会话执行。

父会话复验：125 项定向测试通过；包含浏览器脚本的完整候选也曾通过 pnpm
check。随后同步 primary
`dad4162ca37e`，保留了发布详情不显示操作加载状态的并发修复。该基线中另一构想
`01M6ZM2KA80KHK49XQZWWNN66W`
的 Idea.md、UX.md、pinboard-access-ux.html 和 Implementation.md 未通过 Prettier，使新的 pnpm
check 在 format:check 阶段退出 1；这四个文件未被本实现修改，不能把此结果记为全检查通过。父会话单独运行后续 release、lint/typecheck/test/build 和包检查，退出码为 0：24 项 Turbo 任务全部通过，前端 318 项测试通过，CLI 和 background 包检查通过；所有本改动文件的 Prettier 检查也通过。实施门限以该明确记录的独立基线格式例外验收，不修订其他构想的已提交内容。
