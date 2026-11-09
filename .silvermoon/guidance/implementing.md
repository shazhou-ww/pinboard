# Inner 阶段的项目验收要求

- 在 `Implementation.md` 中增加独立的 `I-ACxx` 验收项，并在 `ledger.md`
  中镜像对应 ID：最终候选版本必须运行并通过 `pnpm check`。
- 检查通过后若修改候选内容或合入并发变更，必须重新运行
  `pnpm check`；重新验证通过前，不得将对应验收项标记为完成或提交 `submitInner`。
- `silvermoon check` 只校验生命周期元数据，不能替代项目的 `pnpm check`。
