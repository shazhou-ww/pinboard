# 实现证据

## 本地验证范围

本证据只描述工作树中的实现与本地测试，不表示生命周期批准、primary 同步、真实账户验收或生产发布。理想世界、events.jsonl 和 Deployment 均未修改；没有数据库迁移或生产操作。

## 自动测试

- `apps/worker/test/item-filter.test.ts`：105 个 Pin 和 105 个 Publication，验证默认首屏之外的名称/根描述命中、É/é、中文、内部空白、字面
  `%`/`_`、缺失描述、跨字段反例、CID、子节点、旧快照和其他账户排除；两类列表均验证 50/50/4 匹配分页、游标、空白查询兼容、认证、scope 和 q 校验。
- `apps/worker/test/publications.test.ts`：新增实际 service 写入回归，验证根描述编辑、私有草稿与发布快照隔离、发布新版本、回滚、改名、Pin 删除/恢复、Publication 删除/恢复与转换后立即按权威元信息过滤。
- `apps/web/test/item-filter.test.tsx`：用轻量 React hook
  host 与假计时器驱动实际 hook，验证 200ms
  debounce、IME、Enter、Escape、清空、请求取消及无视取消的旧响应防护、旧加载更多和旧 refresh 不污染新条件、q/cursor 同行、部分接口失败与重试、不拉取 tokens。这是状态/事件测试，不冒充浏览器布局测试。
- 定向执行服务端过滤与 Publication 测试共 40 项通过；API 测试初次缺少本地 AUTH_URL 导致失败，补齐测试环境后 5 项全部通过。
- 定向执行前端输入、UI、只读预览测试共 42 项通过。现有静态 header 断言已随登录态筛选 class 更新，未更改未登录页预期。
- 原始实现的
  `pnpm check`（在下面的选择器后续修复之前执行）已完整通过：格式、release 规则测试、五个 workspace 的 lint/typecheck/test/build（20/20
  Turbo
  tasks）、CLI 打包及离线安装运行。workspace 共 557 项通过、3 项既有跳过；另有 release 规则 45 项、CLI 打包验证 1 项通过。Worker
  build 为
  `wrangler deploy --dry-run`，没有实际发布。初次完整检查暴露的新增函数覆盖率、测试只读环境赋值、lint 和重复测试夹具均已修复后重新运行，不将失败执行计为通过。

## 真实浏览器检查

集成浏览器 CDP 连接两次超时后，改用本机独立 Chrome
headless、项目内独立 profile、原生 Node
WebSocket/CDP 驱动真实 Vite/React 只读预览。服务器实际使用 5179（5178 已占用，未触碰占用进程）。

- 初始 7 张卡片；输入不存在的关键词后先显示 Filtering...，debounce 后出现 No
  items match this filter.，卡片为 0。
- 点击 Clear
  filter 恢复 7 张卡片，焦点回输入框；输入框 Escape 立即清空并恢复；composition 期间不改变卡片，compositionend 后才应用中文条件。
- 将账户可见文字改为长账户名，分别检查 320、768、1440px。没有水平溢出，品牌、输入和账户不重叠。320px 输入范围 x=16..304、宽 288、高 44；768px 宽 736、高 44；两者均位于第二行，header 高 120，内容从 y=136 开始。
- 1440px 输入范围 x=540..900、宽 360、高 40，中心严格为视口 x=720；header 高 64，品牌右边界约 165，账户左边界 1160，内容从 y=80 开始。

浏览器使用合成只读数据，不证明生产 OAuth、真实上传或跨账户隔离；这些边界由现有/新增 API 和 service 测试覆盖。测试辅助服务器、Chrome 及 profile 在验证结束后清理，不留后台助手。

## 已知取舍

不新增派生数据，因而无需回填及双写一致性验证。非空查询在 Worker 扫描当前账户 cursor 后的元信息，匹配后才分页；不把全量数据发给浏览器，不请求候选项的正文、预览或每项描述接口。读取成本与候选数量线性相关，105 项自动测试不能证明超大生产账户性能；发布前应按实际量级评估。没有执行生产迁移、发布、部署、提交、推送、primary 同步或门禁事件。

## Silvermoon 快照检查

原始子代理检查曾遇到旧分支与更新的 primary 历史不一致；父级随后合并
`origin/main` 的 `614a64a`，并独立执行
`silvermoon check --worktree --audience agent`，确认快照与历史均有效。旧历史阻塞已解决，不再作为当前风险。父级还独立运行服务端过滤及 Publication 定向测试，40/40 通过。以上是父级报告的独立验证，不是子代理重复执行的结果。此次修复不修改理想世界或事件日志。

## 父级评审后的操作选择器回归修复

评审发现上传目的地与 Publication 的既有 Pin/Publication 选择器错误复用了筛选后的卡片墙数组；无匹配条件会删除可选目的地，输入变化会影响已选目的地。新增
`useActionItems`：仅在相关对话框打开时按需读取不带 q 的列表并跟随游标，与筛选输入和卡片墙状态完全独立。选项查询有 loading/error/retry、对话框关闭/切换时 AbortController 取消和旧响应检查；不读取 tokens 或预览。上传请求在提交时固定解析当前选中的未筛选 Publication，并验证可用性，不会在上传完成后从会变化的卡片墙寻找目的地。

检查了 manager 中其他消费者：PublicationDialog 的发布目的地和既有 Pin 建议均改用上述独立数据；墙上的卡片和拖放源仍使用当前可见墙数据，不扩张筛选范围。失效的既有 Publication 选择不会意外回退为新建 Publication。

后续定向测试（子代理执行）：`item-filter.test.tsx`、
`publications.test.tsx`、`ui.test.tsx`
共 34/34 通过。新增证明覆盖无匹配墙仍可选择既有上传目的地、对话框中继续输入不重拉选项且不丢选择、上传实际调用既有 Publication 的 publish 与原 sequence、不带 q 的选项分页、关闭/切换后旧响应防护、错误/重试、未筛选 Pin 建议及失效选择不会意外新建。此次后续修复不重跑全量
`pnpm check`；父级负责最终合并验证，因此 I-AC03 在最终检查前保持未勾选。

前端 workspace 的 typecheck 与 lint 均已通过（子代理执行）。

## 父级最终验证与审查

父级审查了服务端字段边界、过滤后分页、请求竞争与上传目标隔离，要求修复筛选墙数据被操作选择器共用的回归；修复后目标选择使用独立未筛选数据，上传使用提交时的目的地快照。

父级于 2026-11-06 在合入 primary 历史后的最终候选运行
`pnpm check`，退出码 0：五个 workspace 共 562 项通过、3 项既有跳过，20/20
lint/typecheck/test/build 任务通过，另有 45 项 release 规则测试和 1 项 CLI 打包验证通过。此执行包含后续操作选择器修复，I-AC03 据此完成。另行运行的服务端过滤与 Publication 生命周期测试 40/40 通过。

本候选不需要数据库迁移；Worker 构建仅 dry-run。真实浏览器检查仍为上述子代理的合成只读预览证据，不据此宣称生产上线或全规模性能已验证。

## 变更文件索引

- `packages/contracts/src/index.ts`
- `packages/contracts/test/index.test.ts`
- `apps/worker/src/item-filter.ts`
- `apps/worker/src/schemas.ts`
- `apps/worker/src/service.ts`
- `apps/worker/src/publications.ts`
- `apps/worker/src/api.ts`
- `apps/worker/src/publication-api.ts`
- `apps/worker/test/item-filter.test.ts`
- `apps/worker/test/publications.test.ts`
- `apps/web/src/item-filter.tsx`
- `apps/web/src/action-items.ts`
- `apps/web/src/manager.tsx`
- `apps/web/src/ui.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/node-description.tsx`
- `apps/web/src/publications.tsx`
- `apps/web/src/dev-preview.ts`
- `apps/web/test/item-filter.test.tsx`
- `apps/web/test/ui.test.tsx`
- `docs/publications.md`
- 当前 idea 的 `outer/inner/Implementation.md`
- 当前 idea 的 `outer/inner/Filtering-Design.md`
- 当前 idea 的 `outer/inner/Filtering-Evidence.md`
- 当前 idea 的 `ledger.md`
