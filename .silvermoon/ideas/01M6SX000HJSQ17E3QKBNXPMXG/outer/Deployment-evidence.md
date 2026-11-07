# Deployment evidence

## 当前结论

授权应用发布已成功；部署验收尚未完成。认证 Pinboard 工具桥接暂不可用，因此真实 v3 描述、两份 Publication、生产纸页/失败恢复及本机缓存切换仍未验证。所有 D-* 保持未勾选，不以已有实现测试或本次发布成功代替这些生产证明。

本次按父 Agent 对起始
`deploymentRevision 6169af356897811e10bebd0e570745579e07eb9a`
的明确放行执行。未修改已接受的 Inner/Ideal、业务代码、schema、权限或生命周期事件。

## 已完成：准确版本的应用发布

| 项目                     | 实际结果                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 授权 release commit      | `ebfed1a217aa9e8e5c6db8223fcfa87bea83d063`                                                                                 |
| 该 SHA 的 CI             | [42389751815](https://github.com/shazhou-ww/pinboard/actions/runs/42389751815)，success；不是以旧 SHA CI 替代              |
| 远端前置检查             | main 正是授权 SHA；`261108` 无已有 release tag；最近100条 deployment run 中没有未完成任务                                  |
| 唯一新增 annotated tag   | `release-261108-1`                                                                                                         |
| tag 对象 / peeled commit | `3b63f8e95ba380f6a67ff18b5f0b4f8f007a1e96` / `ebfed1a217aa9e8e5c6db8223fcfa87bea83d063`                                    |
| 部署 workflow            | [42391212471](https://github.com/shazhou-ww/pinboard/actions/runs/42391212471)，success；Deploy production Worker 完整结束 |
| 实际 Worker version      | `95756681-0759-490a-a318-b743f1e64106`                                                                                     |
| 控制面 deployment        | `b5981270-2744-4e52-8fab-6dc9c202347e`，`2026-11-07T16:28:24.442084Z`，该版本100%流量                                      |
| 发布前版本               | `886ec1c5-4267-4c7d-a09d-2f89b0f45709`，`release-261107-3`，commit `eaebe728744afc7803f1c02f1c3541a0862936c3`              |

实际操作：等待准确 CI 变绿，再刷新远端标签和部署队列，以
`node scripts\validate-release.mjs release-261108-1` 检查标签；对指定 SHA 执行
`git tag -a`，只推送
`refs/tags/release-261108-1`。没有推送业务文件、重写标签、直接执行生产 Wrangler
deploy 或创建新资源。

Workflow 日志在 `2026-11-07T16:28:26.3577933Z` 报告上述 Current Version
ID。随后使用正常已有 CLI 认证执行只读
`pnpm --filter @shazhou/pinboard-worker exec wrangler deployments list --name pinboard --config wrangler.jsonc --json`，目标 account
`92c3c4fdcc84a1590555bccf4f111de2`，确认当前最新 deployment 确实把该版本配置为100%；未读取、打印或复制凭据。父 Agent 还独立核对了 CI、tag、部署日志、资源指纹和原文件/匿名拒绝，结果相符。

父 Agent 随后也使用已安装 Wrangler 的 help 核对命令，并独立执行上述只读 deployments 查询，得到同一 deployment
ID、Worker
version 与 100% 流量配置。应用发布本身已获独立证实；这不填补下述真实认证描述与界面验收的缺口。

## 已完成：真实匿名 HTTP 及原内容保护

执行记录：[http-baseline.json](./live-evidence/http-baseline.json)，包含实际时间、状态、字节数、SHA-256及非秘密响应头。

- 生产首页和 `/api/health` 均 HTTP200；health 为
  `{"service":"Pinboard","status":"ok"}`。
- 首页实际引用 `/assets/index-DxJaRKmm.js` 和
  `/assets/index-B1iVkNIA.css`，两个资源均HTTP200。父 Agent 对照发布前资源确认指纹变化。
- 中文源 `bafkreihd6ugt2x3givrfd6d44sgfdccmiovx4ex3qnktqndaacgxy4tcda`
  发布前后仍为1,038字节，SHA-256仍为
  `e3f50d3d5f66456251f87ce48c51884c43ab7e12fb8355383460008d7c726218`，原始响应带
  `nosniff`。使用真实 `/ipfs/:cid?format=raw` 与
  `Accept: application/vnd.ipld.raw`；最初不受支持的 `application/octet-stream`
  Accept 返回406，不将该响应当成原文件。
- 对同一源的私有 `/api/pins/:cid/preview` 和
  `/api/pins/:root/nodes/:node/description`
  无凭据请求均真实HTTP401，不以图标或假成功响应代替授权拒绝。
- 既有样例均未修改、删除或转换；未执行SQL、迁移、purge、手动backfill。

## 阻塞及精确续办条件

本子 Agent 的 shazhou 工具发现先出现 client
disconnected；随后 route 工具明确报告连接成功并列出当前工具名，但再次搜索准确的
`pinboard_description_get` 等名称仍只返回 route
/ 无关工具，没有可调用参数定义。未猜测 deferred 工具参数或读取认证配置。

正常 CLI 的替代只读尝试：

```powershell
node apps\cli\dist\main.js description get bafkreihd6ugt2x3givrfd6d44sgfdccmiovx4ex3qnktqndaacgxy4tcda bafkreihd6ugt2x3givrfd6d44sgfdccmiovx4ex3qnktqndaacgxy4tcda --endpoint https://pinboard.shazhou.work --json
```

实际返回 `HTTP_ERROR` / HTTP401。没有修改CLI
token/endpoint、扩展权限或绕过授权。此限制属于认证工具通道，不是已证实的应用代码缺陷。

需要父 Agent 恢复本子任务的已认证 Pinboard 工具可见性，或作如下有界 MCP 桥接：

1. 读取上述中文PDF和表单负例
   `bafkreih7fvqgjqkbj6r6ryo544isejkhszw47abwqonh5q272spkhiwhae` 的 scoped
   description，保留真实响应。
2. 仅上传下列两份已生成的828字节合成PDF；按清单 title/requestId 各创建一个 Publication，返回 source
   CID 与 Publication
   ID。之后本 Agent 可用真实公开接口和父 Agent 已有 session-scoped
   Playwright 驱动继续其余验证。

[samples.json](./live-evidence/samples.json)记录预期CID、哈希、大小与幂等请求标识。文件是原始几何图形，无用户内容、脚本或外部资源：

- [竖页](./live-evidence/Unified-preview-smoke-261108-portrait.pdf)
- [横页](./live-evidence/Unified-preview-smoke-261108-landscape.pdf)

**截至本记录：实际新增烟测 Pin 为0，Publication为0；文件仅在本地准备，未声称上传成功。**
新建后须保留供父 Agent 验收，不自动清理。当前没有浏览器截图、生产规范化描述或cache升级成功的证据；不会用本地实现证据填补。临时脚本已清理，未触碰父 Agent 的浏览器驱动；没有遗留本次后台测试服务。

## 父会话门限判定：暂不通过部署验收

父会话独立确认发布版本、100% 流量配置、资源更新、原文件哈希与匿名拒绝。随后进行了有界的工具通道恢复：既有执行上下文与独立恢复上下文均未取得 Pinboard 工具的可调用定义，发现请求返回 client
disconnected，路由定义也不可用；正常 CLI 的 401 没有被绕过。恢复尝试未上传文件、创建 Publication、读取凭据或修改认证状态。

因此不记录 `submitOuter` 或
`acceptOuter`，所有 D-* 保持未完成；Idea 留在 deploying，而不是 completed。恢复已认证 Pinboard
MCP 工具通道后，按上述样例清单继续真实描述、公开 Publication、生产界面与缓存切换验证，再由父会话审查证据。应用已经发布，不应为恢复验收通道重复发布标签；仅当实施代码另有修正时才重新走对应实施与发布门限。
