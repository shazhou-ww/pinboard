# 详情缓存本地浏览器验收证据

本文件支持 [Deployment.md](./Deployment.md)
的本地 D-S01、D-AC01、D-AC02。这是同一构想的 Outer supporting
evidence，不是生产发布或生命周期事件。

## 实际执行环境

2026-11-09，Windows、本机 Chrome
**156.0.8078.81**、真实 React/Vite 页面、原生 CDP/WebSocket 驱动。使用已有本地二进制，无新增第三方依赖或安装：

- Vite：`http://127.0.0.1:5196`，显式 `VITE_UI_PREVIEW=false`。
- Wrangler：`http://127.0.0.1:8787`，`--local`，独立的仓库内持久目录，仅提供真实同源路由/未认证授权探针；未运行 D1
  migrations。
- 浏览器使用仓库内独立 profile，CDP 端口 9367；profile 和浏览器 scratch 均在退出时清理。Vite、Worker、Chrome 辅助进程已停止。
- 私有账号、Pin、发布历史、可达 child 和写入由现有
  [reading fixture](../../../../scripts/reading-details-fixture.mjs)
  合成，通过实际组件发起请求；不使用生产账号或真实生产数据。

复用
[reading-details CDP harness](../../../../scripts/reading-details-browser.mjs)，新增
`--cache-only` 模式及
[定向验收模块](../../../../scripts/item-preview-cache-browser.mjs)。fixture 增加账号/root/node/发布身份标签、响应完成时间、GET 快照和延迟控制，使慢 GET 即使晚于 PUT 完成也仍返回其原始快照，避免用 fixture 的动态新数据伪造竞态成功。

## 重复阅读和慢后台更新

[最终 28 项断言、请求日志、DOM 采样与真实网络响应](./evidence/browser-result.json)
记录最终成功执行，退出码 0。

| 实际场景                   | DOM 样本数 | 采样跨度 | Loading/空白回退 |
| -------------------------- | ---------: | -------: | ---------------- |
| 私有详情关闭后重开         |         95 |  1502 ms | 0                |
| 发布 current v3 关闭后重开 |         95 |  1538 ms | 0                |
| 另一账号自己的私有缓存重开 |         93 |  1521 ms | 0                |

MutationObserver 与 16 ms 定时采样同时观察实际 DOM；后台请求被固定延迟 1500
ms，完成记录显示慢 GET 实际耗时约 1502–1514
ms。缓存打开时后台 GET 尚未完成，旧预览及说明已可见；全过程预览容器
`aria-busy=false`，没有 Loading
content 或空白回退。一次私有重开只新增一个完整 GET：保持真实重新验证，不以缓存替代授权。

后台尚未完成时的截图： [私有详情](./evidence/private-cache-during-refresh.png)、
[发布详情](./evidence/publication-cache-during-refresh.png)。

## 更新、节点与身份隔离

浏览器实际操作及响应/请求记录证明：

- 从缓存 v1 开始编辑，后台刷新到 v2 时草稿保持；保存仍带
  `expectedVersion=1`，409 明示冲突并保留草稿。取消丢弃确认仍保留编辑；明确确认后重新读取、以 v2 保存并显示 PUT
  v3。
- PUT v4 先于冻结为 v3 的旧 GET 完成；旧 GET 忽略取消并晚到后，界面仍为 PUT v4。
- 后台 503 明确显示错误和 Retry
  description，已有预览保持；重试实际重新请求并恢复。
- 私有根 A/B 不显示另一根的用户描述或预览。在 fixture 测试宿主中挂载现有独立 NodeDescriptionEditor，实际显示目录预览并用 Node
  CID 表单读取两个根共享的 child
  CID。同一 root/child 的第三个实际读者同步收到 PUT；同 CID 的另一根仍保留自身描述。没有给普通详情恢复已移除的高级按钮。
- 发布 current
  v3 与历史 v1 使用明确 revision；再打开及切换已缓存版本不显示另一版本。
  `reading-fixture` 与 `single-fixture` 的同 CID/v1 也不共享用户快照，保持只读。
- 按应用实际登录导航方式重载账号 `synthetic` →
  `synthetic-b`；新账号的延迟验证期间不显示前账号完整说明或预览，完成后显示新账号内容；新账号自身重复打开也保持缓存预览。此证据是实际页面重载切换，不声称验证不存在的热切换认证入口。
- 真正访问 `/p/reading-fixture/v/1`
  的固定发布页面，使用现有节点表单读取 child，请求仍含明确版本、正确 root/node，且不可编辑。

## 同源路由的真实探针

fixture 保留原始浏览器 fetch。以下请求明确绕过合成响应，通过同一 Vite
origin 及现有 Worker proxy 实际发到本地服务：

| 路径                                                | 实际结果                        |
| --------------------------------------------------- | ------------------------------- |
| `/api/bootstrap`                                    | 200，`application/json`         |
| `/api/pins/<root>/nodes/<root>/description`，未认证 | **401**，`application/json`     |
| `/p/reading-fixture/v/1`                            | 200，`text/html`，真实 SPA 路由 |

JSON 证据另保存 230 个真实浏览器网络响应，并断言静态脚本/CSS/font 资源使用同一 origin。合成授权详情请求也全部保持同源
`/api/*`，没有 undefined/current 字面 revision。因此不是只检查字符串 URL：实际静态页面、Worker
bootstrap 和未认证 API gate 都已探测。

## 回归与复跑

- 新缓存模式：**28 项真实浏览器断言通过**。
- 原有默认 reading-details 模式：**55 项断言通过**，覆盖当前简化 UI、冲突/保存、版本、迟到响应、目录/image/PDF 状态、窄屏及关闭交互。此次默认回归的 scratch 截图目录已删除，不保留无关图像。
- 三个变更 harness/fixture 文件的 ESLint（0 warning）、 `node --check`
  及 Prettier 检查通过。本次未修改源代码、Inner 文档或 I-* 复选框；未重复替父会话执行实施生命周期。

复跑：从仓库根目录，先用已安装的 Vite/Wrangler 在上述端口启动本地服务；Wrangler 必须
`--local`、独立仓库内 persist-to、非生产测试 AUTH_SECRET，并覆盖 PUBLIC_ORIGIN 为
`http://127.0.0.1:5196`。随后运行：

```powershell
$env:READING_CDP_PORT = "9367"
node scripts\reading-details-browser.mjs http://127.0.0.1:5196 .silvermoon\ideas\01M6ZJFS9F7EPVHBERG76YJC2E\outer\evidence --cache-only
```

运行后停止自己创建的服务并清理独立 profile/persist-to。不得将 fixture 指向生产；harness 拒绝非 localhost/127.0.0.1 目标。

## 局限与生产边界

本地 D-S01、D-AC01、D-AC02 已有上述证据；授权成功后的描述与发布数据是合成 fixture，不是实际 OAuth/D1 或真实 DAG 存储证明。真实 Worker 探针验证未认证访问仍 401，但不将合成账号当作真实授权会话。慢网络是 1500
ms 响应延迟，图片是既有合成缩略图；不声称验证生产网络或真实文件下载。

**D-S02 保持未勾选**：没有生产发布授权，没有部署、release
tag、commit、push、生产认证或线上复验，也未写任何 lifecycle
events。如以后获准发布，仍必须按部署指南执行，在线复验同一结果并补充生产证据。
