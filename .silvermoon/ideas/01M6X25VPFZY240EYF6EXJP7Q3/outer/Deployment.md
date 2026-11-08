# Deployment

发布前提由父级代理在用户明确委托下判断并批准；实施提交后仍必须等待父级的
`acceptInner` 与生产发布批准。本文更新不执行生产部署，不创建资源或迁移数据库。

## Steps

### D-S01: 确认发布授权与候选

在父级批准准确主体世界 revision 及生产发布后，按
[部署指南](../../../../docs/deployment.md) 确认 tested commit 已在 `origin/main`
且 CI 全绿。刷新 tag 清单与正在运行的部署；使用日期 2026-11-08 下一未用正整数索引的 annotated
`release-261108-INDEX`
tag。现有索引 1–6 只是基线观测，不能替代发布时刷新。不变更包版本、工作流触发方式、生产绑定/secret，不执行 D1 迁移或资源创建。

### D-S02: 验证发布后的真实详情

核验 tag 对应的部署 workflow 与域名可用性。通过已有合法认证会话或最小权限、已授权测试访问路径，使用带本 idea 标识的合成样本核验普通 Pin、单/多版本 Publication、current/selected/latest、固定链接及确定 CID 下载，检查桌面与 390px/320px。没有合法认证路径时不得制造 OAuth 绕过或把匿名页面/本地 fixture 当成认证检查通过。仅可清理自己创建的测试对象；真实账户已有对象、说明、current 与历史保持不变。

## Acceptance criteria

### D-AC01: 发布来源与授权可追溯

通过父级发布批准、准确 `origin/main` 候选、绿色 CI、annotated tag 与 tag-driven
workflow 结果证明生产运行已验收实现；没有生产 schema、资源、secret 或 OAuth 改动。

### D-AC02: 真实使用结果符合设计

通过真实认证生产浏览器与固定链接、下载结果证明：阅读优先层级可用，两类详情的管理差异清楚，历史浏览不改变 current，下载 CID 与选中版本一致，私人说明不出现在匿名访问结果中。上传 HTML/JS 不以内联文档形式执行；原有公共检索路径仍正常。认证检查缺失即本标准未完成；部署 workflow 成功不自动等于现实世界验收。
