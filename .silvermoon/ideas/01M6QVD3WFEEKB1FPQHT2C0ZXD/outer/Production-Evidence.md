# 生产发布证据

## 授权与契约

用户于 2026-11-06 明确授权“授权发布，继续”，承接上一轮说明的 release
tag 发布与轻量线上冒烟；自主门禁权限仍有效。未授权也未执行任何数据库迁移或资源重建。

细化的 Deployment 契约先同步到 primary，发布与检查基于提交
`6c8b9c22d1a5a6e38f57e4f51cf8e753d138cc18` 的外部世界修订
`364e7ab1d24cb5625e79c1849c24ec26e5dc8c7b`。该提交包含已接受实现，且发布前已证明可从刷新后的 origin/main 到达。发布前检查未发现其他活动生产部署。

## 发布结果

| 项目                      | 实际结果                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 目标环境                  | https://pinboard.shazhou.work                                                                                                 |
| release tag               | `release-261106-6`，annotated，当天前五个索引已占用                                                                           |
| 目标提交                  | `6c8b9c22d1a5a6e38f57e4f51cf8e753d138cc18`                                                                                    |
| 提交 CI                   | [42187499153](https://github.com/shazhou-ww/pinboard/actions/runs/42187499153)，四组 Linux/Windows 与 Node 22/24 检查全部成功 |
| 部署工作流                | [42188295859](https://github.com/shazhou-ww/pinboard/actions/runs/42188295859)，成功，发布步骤完成于 2026-11-06 08:33:49 UTC  |
| Cloudflare Worker version | `d035593e-1225-4179-9e72-a909b31dd875`                                                                                        |
| 首页脚本                  | `/assets/index-CVrQlnRK.js`                                                                                                   |
| 首页样式                  | `/assets/index-BAl2jAm5.css`                                                                                                  |
| 数据库操作                | 无迁移、回填或远程 SQL                                                                                                        |

发布前首页资产为 `index-C8Hw8XNO.js` 与
`index-Dl7fE6ZH.css`；发布后资产已更新，与本地最终构建的 index.html 一致。线上 JavaScript 返回 200 且包含新过滤框可访问标签。此资产检查证明前端已更新，不代替登录态功能验证。

## 线上检查结果

2026-11-06 08:35:42 UTC，使用独立 profile 的真实 Chrome 156
headless，经 CDP 直接访问生产 origin，没有伪造登录、注入测试会话或修改账户内容：

- 首页返回 200，标题正常，未登录时展示登录入口且没有过滤框。
- `GET /api/health` 返回 200，内容为 `{"service":"Pinboard","status":"ok"}`。
- 匿名 `GET /api/pins?q=test` 与 `GET /api/publications?q=test`
  均返回 401，未开放未授权列表访问。
- 320、768、1440px 三种视口的匿名页面均无水平溢出，登录入口正常。这只证明匿名页布局，不是登录后过滤框布局。
- 工作流验证与实际资产检查通过；未创建、上传、发布、删除或修改任何生产账户内容。

最初尝试访问 `/#preview`
未进入合成预览；查验代码后确认生产构建正确禁用了仅限本地开发的预览模式，未改动这一安全边界，也未将该尝试记录为过滤功能通过。

## 尚未通过的验收与恢复条件

集成浏览器的 open/read 两种访问均因 CDP 连接超时失败。独立 Chrome 没有用户登录会话；Pinboard
MCP 两个只读列表工具都返回需要重新认证；本地 CLI 配置指向正确生产 origin，但没有保存 token，读取列表明确返回 TOKEN_REQUIRED。没有提取用户浏览器 cookies、复用其他会话或绕过授权。

已发起 Pinboard 连接重新授权流程并将平台生成的授权链接展示给用户；不在仓库记录一次性授权 URL。恢复受支持的线上登录浏览器后继续 D-S02，验证两类 item 的名称/根描述命中、排除字段、清空、无匹配、中文输入、窄屏及详情/上传目标选择。连接恢复本身不等于验证已完成。

因此 D-S01、D-AC01 完成；D-S02、D-AC02 未完成。没有记录 submitOuter 或 acceptOuter，不将发布成功误称为整个 IDEA 验收完成。
