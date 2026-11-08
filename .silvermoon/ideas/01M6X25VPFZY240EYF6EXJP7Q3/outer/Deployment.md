# Deployment

父级于 2026-11-08 明确批准准确主体世界
`23cee2dfcec745592cde6ef6894e0415bd7ffdfd` 的 `acceptInner`
与生产发布。本阶段执行获批发布和有界合成样本验收，不创建资源、不迁移数据库、不修改实现。

## Steps

### D-S01: 确认发布授权与候选

在父级批准准确主体世界 revision 及生产发布后，按
[部署指南](../../../../docs/deployment.md) 确认 tested commit 已在 `origin/main`
且 CI 全绿。刷新 tag 清单与正在运行的部署；使用日期 2026-11-08 下一未用正整数索引的 annotated
`release-261108-INDEX`
tag。现有索引 1–6 只是基线观测，不能替代发布时刷新。使用既有工作流原子发布 Worker、assets 与既有 auth
secrets，不轮换或新增 credentials；不变更包版本、工作流触发方式、生产绑定，不执行 D1 迁移或资源创建。

### D-S02: 验证发布后的真实详情

核验 tag 对应的部署 workflow、当前活跃 Worker
version 与域名可用性。通过已有合法认证会话或既有 host `cfg` 中的 Agent
credential，使用本 idea 专用合成样本核验普通 Pin、单/多版本 Publication、current/selected/latest、固定链接及确定 CID 下载，检查桌面与 390px/320px。credential 只在当前进程内读取，不输出、不进入证据或 Git。已有 Agent
credential 能授权真实 API，但 `/api/auth/session`
不因此成为浏览器会话；若无法取得已有合法浏览器会话，则完成真实 API、匿名公共路由与已发布 assets 检查，明确报告所有者 UI 认证检查未完成，不把替代证据标为通过。仅将自己创建的样本 Pin/Publication 移到最近删除，核对已有账户对象集合未改变；不永久删除、不修改真实对象的说明、current 或历史，不制造 OAuth 绕过。

## Acceptance criteria

### D-AC01: 发布来源与授权可追溯

通过父级发布批准、准确 `origin/main` 候选、绿色 CI、annotated tag 与 tag-driven
workflow 结果证明生产运行已验收实现；没有生产 schema、资源、secret 或 OAuth 改动。

### D-AC02: 真实使用结果符合设计

通过真实认证生产浏览器与固定链接、下载结果证明：阅读优先层级可用，两类详情的管理差异清楚，历史浏览不改变 current，下载 CID 与选中版本一致，私人说明不出现在匿名访问结果中。上传 HTML/JS 不以内联文档形式执行；原有公共检索路径仍正常。认证检查缺失即本标准未完成；部署 workflow 成功不自动等于现实世界验收。
