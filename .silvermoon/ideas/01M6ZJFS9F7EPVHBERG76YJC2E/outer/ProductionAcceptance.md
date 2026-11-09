# 详情预览缓存生产验收

本文件支持 [Deployment.md](./Deployment.md)
的 D-S02、D-AC01、D-AC02。2026-11-09 用户明确授权：最新 main 的 CI 通过后触发部署并线上验证；阶段门限由父会话按此前授权审批。

## 精确发布与检查结果

- 发布标签：`release-261109-4`，annotated tag，指向已经在 origin/main 的
  `99f4304da75b1db386ea5b0c051651b1ddf138ae`。
- [该提交 CI](https://github.com/shazhou-ww/pinboard/actions/runs/42590169974)
  的 Windows/Ubuntu、Node.js 22/24 四项矩阵均成功后，才创建和推送标签。
- [生产部署](https://github.com/shazhou-ww/pinboard/actions/runs/42590963771)
  成功，部署工作流的完整 pnpm check 通过。
- Worker version：`36ca9730-4cbc-43bd-a132-7c3f6d499bab`。
- 实际生产地址：`https://pinboard.shazhou.work`；浏览器加载新入口
  `/assets/index-D1_UZUja.js`，不是发布前的 `/assets/index-mHAHlKPh.js`。
- 本次未改发布工作流、secret、绑定或 schema，未执行 D1
  migration。随后 main 仅新增实施 guidance 文档；父会话在 `63f11cfa68cc`
  上运行 pnpm check 也退出 0，原先阻塞 CI 的格式问题已经消除。

## 真实私有详情与保存

按用户要求使用现有 **Chrome for Testing 157.0.8103.38**
的已登录会话，通过原生 CDP 驱动。在同一浏览器中创建专用 smoke 标签页，未操作已有用户标签页中的内容或草稿，未读取、导出 Cookie、密码或 token。

上传仅 84 字节、无敏感内容的独立随机 smoke 文件，通过实际
`/api/pins/upload?kind=file`、明确 `X-Pinboard-Public: true`
创建，并等待真实 Worker 生成文本预览。不使用 dev-preview 或合成服务端响应。

[完整结果](./evidence/production-private-result.json) 和
[仅截取 smoke 详情的截图](./evidence/production-private-preview.png) 证明：

| 场景                   | 可观察结果                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 关闭后重复打开私有详情 | 真正 GET 尚未完成，已有文本预览立即显示                                                                                                                      |
| 后台响应延迟 1500 ms   | 169 次 DOM 采样，loading 0 次、空白 0 次；真实 GET 为 200，状态 ready                                                                                        |
| UI 保存描述            | PUT 使用 expectedVersion=0，成功返回 version=1                                                                                                               |
| 旧 GET 与新 PUT 竞态   | GET 真实返回 version=1，在客户端延迟交付 5000 ms；PUT 使用 expectedVersion=1，返回 version=2，约早于旧 GET 交付 3082 ms；旧 GET 到达后页面仍显示保存的新描述 |
| 再次打开保存后的详情   | 保存结果立即可见，并继续进行真实后台验证                                                                                                                     |
| 清理临时 pin           | DELETE 204，随后真实详情 GET 404；没有继续暴露活动 pin 的受保护描述                                                                                          |

延迟包装只推迟特定 smoke 节点真实 GET 的响应交付，不修改服务器内容、HTTP 状态、版本或授权；结束后恢复 fetch 并关闭专用标签页。

首次 smoke 尝试遇到保存刷新尚未完成时关闭按钮仍禁用，已修正 harness 等待 busy 结束；第二次尝试中真实 PUT 耗时超过 1500
ms，未形成所需竞态，不能据此声称通过。最终将竞态窗口设为 5000
ms，以上时间与版本断言才全部通过。三次尝试创建的独立 smoke
pin 均已 DELETE，未修改用户已有 pin 或描述。按正常回收机制它们进入 Recently
deleted，未进行永久删除、缩短保留期或生产数据清空。

## 真实发布内容、节点与版本

使用既有公开 publication，不创建或修改其版本：

- `ddb3a646-8353-4531-9b10-9d4ee7bb9751/v/1`：真实根目录和可达 resources 子节点均返回 200。读过子节点后返回已缓存的根节点，推迟真实根 GET 交付 1500
  ms；缓存目录立即可见，只有一次完整重新验证请求，观察到的 DOM 变化无加载或空白回退。
- `3a09d1f3-f6df-4ca9-bbc2-7a9e97ada6fd/v/1` 与
  `/v/2`：真实响应均为 200、ready，分别返回 user.version=1/2、各自正确且不同的 rootCid/nodeCid，页面为只读，没有编辑 textarea。
- 发布 PDF 缩略图真实获取为 200、image/webp，Cache-Control 为 public,
  max-age=29030400,
  immutable；真实图像字节能解码为 400×300。集成浏览器页处于 hidden，原生 lazy
  img 尚未触发加载，不能将其当作显示失败；这里证明的是资源获取与解码，不把强制解码冒充普通 lazy 图片显示证据。

发布节点的延迟试验发生在真实生产页面，全部请求使用同源 `/api/*`
及明确版本，不使用 current 或 undefined 作为缓存版本。版本间的页面导航是实际导航，不声称其能跨整页重载保留完整内存缓存。

## 会话隔离与授权

[Chrome for Testing 的独立匿名上下文结果](./evidence/production-anonymous-result.json)：

- 没有已认证用户，也没有私有 pin 卡片。
- 真正 `/api/pins` 返回 401，`/api/bootstrap` 返回 200。
- 使用新的独立 browser
  context，不复制已登录上下文的 Cookie，不退出或破坏用户现有会话；验证后已销毁该上下文。

已登录 smoke 标签页真实上传、读取、PUT 成功；匿名上下文读取受保护 API 被拒绝。跨根/节点、账号与 publication/revision 的缓存键及切换行为另有
[本地浏览器证据](./BrowserAcceptance.md)
和已通过的自动化测试。生产验收没有让第二个真实 OAuth 账号登录，也不声称验证两个不同已登录账号之间的热切换。

## 验收结论与范围

发布成功与验证成功分开确认：实际新资源、私有缓存重开、后台重新验证、真实 CAS 保存、旧响应竞态、公开节点/版本、匿名授权与测试清理均已证明。父会话据此完成部署门限验收。

未重做完整 OAuth 登录/登出、全部上传格式、Kubo 重建、配额压力测试或存储迁移验收；这些不是本次仅前端预览缓存优化的新增机制。账号细粒度隔离和完整 UI 回归沿用已通过的本地与自动化证明，以上限制保留在本文件，不用部署成功替代未执行的试验。
