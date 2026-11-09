# 验证详情预览缓存体验

## Steps

### D-S01: 在可访问环境验证重复阅读

在本地或授权验收环境反复打开私有 item、目录节点和发布版本，使用浏览器网络记录与可见状态验证慢网络下的阅读体验。

### D-S02: 按授权发布并复验

仅在用户明确授权生产发布后，按现有部署指南执行标签发布，再复验缓存、更新与权限隔离；未获授权不部署。

## Acceptance criteria

### D-AC01: 实际重复阅读稳定

浏览器验收证明已有预览在再次打开和慢速后台更新时持续可见；保存描述和重试能够显示新结果。

### D-AC02: 实际环境隔离与路由不变

在验收环境切换账号和发布版本，确认无错误缓存展示；验证同源静态资源和 /api/* 路由保持正常。若执行生产发布，对同一结果进行线上复验并提供证据。

## 本地验收证据（不代表生产发布）

2026-11-09 的真实 Chrome/React/Vite 本地验收已完成：新缓存模式 28 项断言通过，原有 reading-details 回归 55 项通过。1500
ms 延迟 GET 下私有、发布与另一账号缓存重开分别取得 95、95、93 个 DOM 样本，均无 Loading
content/空白回退；保存、409、重试、PUT/旧 GET 竞态及 root/node/
publication/revision/账号隔离均有可重跑证据。

真实同源静态页及 Worker
bootstrap/未认证详情 API 另用原始 fetch 探测，分别得到 200/200/401。合成授权数据的范围、局限、截图、请求记录和复跑步骤见
[BrowserAcceptance.md](./BrowserAcceptance.md)。

本地验收当时仅镜像勾选 D-S01、D-AC01、D-AC02，D-S02 保持未勾选。所有本次本地 server/browser
helper 已停止，独立 scratch/profile/state 已清理。

## 授权生产发布与线上复验

2026-11-09 用户授权在最新 main 的 CI 转绿后发布。`release-261109-4`
已部署成功，私有详情在真实 Chrome for Testing 中完成缓存重开、1500
ms 慢响应、真实描述保存及迟到 GET/新 PUT 竞态验证；公开节点与版本、独立匿名上下文 401 也通过。临时 smoke
pin 已正常 DELETE，未操作已有用户数据或运行迁移。

精确 source commit、Worker
version、CI/部署链接、169 次无 loading/空白采样、保存版本、清理结果与验收范围见
[ProductionAcceptance.md](./ProductionAcceptance.md)。D-S02 据实际发布和复验完成勾选；第二个真实 OAuth 账号等未执行范围明确披露，不以部署成功代替其证据。
