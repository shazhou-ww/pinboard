# 元信息过滤技术方案

## 现有事实与约束

- [AccountManager](../../../../../apps/web/src/manager.tsx)
  同时展示 Pin 和 Publication，分别维护分页游标，并通过 renderHeader 渲染顶部栏。
- [HomeHeader](../../../../../apps/web/src/ui.tsx)
  目前只有左侧品牌、右侧账户；[样式](../../../../../apps/web/src/styles.css)
  是固定 64px 的 flex 标题栏。
- [PinService.list](../../../../../apps/worker/src/service.ts)
  按 CID、[PublicationService.list](../../../../../apps/worker/src/publications.ts)
  按 ID 排序，每页最多 50 条，以第 51 条判断 nextCursor。因此过滤当前 React 数组无法覆盖所有 items。
- [Pin 契约](../../../../../packages/contracts/src/index.ts)
  没有 description 字段；用户根描述来自 node_descriptions，Publication 当前版本的 descriptions 是发布快照。不能对每张卡片单独请求详情来补全过滤数据。

## 方案选择

推荐复用两个列表接口，加入可选
`q`，由服务端先过滤再分页。首页只负责输入和展示，继续使用原有卡片组件、顺序及两种游标。不新增统一搜索端点、搜索引擎、FTS、相关性得分或全量下载。

纯前端方案代码最少，但只过滤已加载页会漏项；拉完全部页再过滤会把账户数据和 description 一起搬到客户端，并拖慢首次使用。两者不适合作为本需求的默认实现。

## 查询语义与描述来源

逻辑条件为：

```text
q = lowercase(trim(input))
matches = q is empty
       OR lowercase(name).includes(q)
       OR lowercase(rootUserDescription).includes(q)
```

字段分开匹配；不把 name 与 description 拼成一个字符串。不解释 `%`、`_`、正则或查询操作符。缺失描述是空文本。普通 Pin 的根描述必须同时约束 account_id、root_cid、node_cid
=

root_cid；Publication 按 current_revision 的快照及其根 CID 取值，不能读取私有实时描述或其他版本。

不能把 D1/SQLite 的内置 lower/NOCASE 当作完整 Unicode 大小写支持：它们通常只覆盖 ASCII。建议在应用侧使用统一、无 locale 的大小写归一化，比较归一化后的字符串；不额外做重音或兼容字符折叠。测试至少包含非 ASCII 大小写（例如 É/é），避免前后端语义不同。

为在 D1 分页前可靠匹配，建议维护最小的元信息过滤投影：账户、item 类型与稳定 ID、归一化名称、归一化根描述。它是派生数据而非新内容源，可从现有表与快照重建；使用参数绑定和字面子串比较，不使用通配符 LIKE。不建立全文索引。

这一投影需要迁移、历史数据回填及同事务维护，成本高于只支持 ASCII 的 SQL
lower 方案，但可以兑现“不区分大小写”并避免逐项详情请求。实施时先验证 D1 能力和现有写入组织，再确定最小表/列形态；不能用仅 ASCII 的实现默默替代已确认的匹配语义，也不提前执行生产迁移。

所有列表仍从权威 item 表出发约束账户、scope、有效/未删除状态，再关联过滤投影。空查询走现有路径，不因投影缺失破坏普通浏览；非空查询上线前必须完成回填，不能静默漏掉历史数据。

名称/描述修改、首次创建、发布、回滚、转换、删除和恢复需要审查所有 HTTP、MCP、CLI 共用的 service 写入路径，不能只在 React 保存后更新投影。Publication 私有草稿修改不更新发布快照投影。迁移与这些写入必须有一致性测试。

## API 与分页

继续使用 `/api/pins?q=...&cursor=...` 与
`/api/publications?q=...&cursor=...`，省略 q 的调用兼容现有客户端。由共享契约规定输入归一化、长度上限及显式校验错误，建议上限 200 个 Unicode 字符，UI 同步约束；该上限是实施提案而非构想验收要求。

过滤条件必须先于现有 LIMIT
51；每个列表独立返回最多 50 条与 nextCursor。保留原排序，不把名称匹配排在描述匹配之前。切换 q 必须清空两个结果集和游标；加载更多必须携带相同已应用 q。缓存键包含账户、类型、q、cursor；用户关键词不进入新增长期日志。

两个接口独立失败时，不把只成功的一半当作完整结果：各自呈现错误/重试或显示明确的整体失败。没有过滤总数接口，不额外执行 COUNT。

## 前端接线

AccountManager 管理原始输入、已应用关键词、两个列表各自的结果/游标/加载错误状态。扩展 renderHeader 与 HomeHeader 的可选过滤槽位或类型化参数，不反向导入管理组件，不建立无必要的全局 store。

约 200ms
debounce，compositionend 后应用，Enter 立即应用；AbortController 配合查询代次校验，避免旧查询、旧加载更多或旧 refresh 覆盖当前结果。过滤不复用全局 busy 去禁用输入、账户和整个卡片墙。

把当前同时刷新 pins/tokens/publications 的逻辑拆出“列表重新查询”路径，输入关键词不能重复拉取 tokens。详情选择状态与可见结果独立。保留一份未过滤首屏或重新请求以支持清空；不要求保存全部浏览历史。

上传、改名、描述保存、发布、回滚和删除/恢复成功后，统一使当前关键词的列表失效并刷新。不能直接把不匹配的新卡片 prepend 到筛选结果中。

## 性能与落地边界

第一版是账户内的元信息子串过滤；普通 B-tree 无法加速任意位置子串，不应将“加一个索引”当作性能证明。以真实量级及较大测试账户记录查询耗时和请求数量，验证每次输入没有全量内容下载、逐卡描述请求或关键词变化触发的预览风暴。

如实际规模触及 D1 查询限制，应在实施时拿测量数据讨论后续索引方案，而不是现在引入 FTS 或改匹配规则。这里记录技术方向和具体风险，不是实现完成的证明。
