# Raw 网关外部验证

本文件服务于 Deployment.md。用户已授权由主 Agent 执行门限审批及生产发布；不执行数据库迁移，也不宣称完整 CAR/IPNS 网关兼容。

## 隔离 Kubo 验证

2026-11-12，Windows，Kubo v0.43.1，官方 Windows
AMD64 压缩包 SHA-512 与发布校验文件一致：

`e611cecef25cddb10b7f907145383608d9b31219ad7120041aeacfe2313882da1944f2897fda29bc2d959dd357e4950089ec8f2cbd52b29f2fc472bcae4356d0`

使用仓库 pnpm
test:kubo，临时 Worker、D1、R2、TLS/HTTP2 代理和独立客户端；源节点导出后停止，消费者的 bootstrap、swarm 和 mDNS 均关闭。

| 项目                 | 实测结果                                                         |
| -------------------- | ---------------------------------------------------------------- |
| Kubo 创建的目录根    | bafybeiaf35klfgmya4d6h4vrjwpc64hlar36xwfr2g77dkfvkyn3zcxveq      |
| 原始目录 DAG         | 16 blocks，3,146,662 bytes                                       |
| 浏览器编码目录根     | bafybeic6lylvruydo6tbwcvqngyi24u2ufsbndq4r5wszoq5e6idy3hmc4      |
| 浏览器编码 DAG       | 18 blocks，3,146,769 bytes                                       |
| consumer-cat         | 冷缓存 routing + cat 通过                                        |
| consumer-get         | 冷缓存 routing + get 通过                                        |
| consumer-browser-get | 冷缓存 routing + get 通过，嵌套路径及空文件保留                  |
| 文件 SHA-256         | cc048258dd0204b522a6c7f7ea469482783a3e88dae689c63dc5d618ff6a9664 |
| 传输                 | 58 次 HTTP/2 请求，3 次专用探测                                  |

这证明真实网关处理器的本地协议互操作，不证明公网域名、生产 R2/D1 或公网 Kubo 检索。旧 PoC 因缺少公开引用而不能发现 provider，已在 Inner 阶段修复并重新验证；没有通过削弱生产授权绕过该失败。临时源、消费者和 Worker 进程及数据由脚本清理。

## 生产验证

发布前 CI 在 Windows/Node
24 的既有 PDF 范围读取测试两次失败：二进制响应的诊断 clone 已被消费。用户单独授权修复该阻塞后，测试改为按请求顺序各读取一次原始字节，再比较两份完整像素；保留原来的大于 75% 节省、读取次数与损坏拒绝断言，没有跳过测试或放宽阈值。定向测试通过，随后完整 pnpm
check 通过；远端 CI 仍须成功后才创建发布 tag。

修正后的主线 CI
[43154653759](https://github.com/shazhou-ww/pinboard/actions/runs/43154653759)
四个 Windows/Linux、Node 22/24 组合全部通过，未绕过失败作业。

| 项目           | 实测结果                                                                             |
| -------------- | ------------------------------------------------------------------------------------ |
| 发布 tag       | release-261112-1，annotated tag                                                      |
| 发布 commit    | 2ee900f87fda5d1b043ec122e1a21f3256bf47ca，已在 origin/main                           |
| 部署工作流     | [43155385401](https://github.com/shazhou-ww/pinboard/actions/runs/43155385401)，成功 |
| Worker version | 38be853c-abcd-49cc-9681-7ff69520b201                                                 |
| 浏览器         | Chrome for Testing 157.0.8103.38                                                     |
| 域名及传输     | https://pinboard.shazhou.work，实际导航协议 h3                                       |
| smoke 时间     | 2026-11-12T04:35:15.490Z                                                             |
| 专用测试 CID   | bafkreickvvemn7qrqcm73vxm4jnkdbz6fgycb22noinfdoluu7fj3ag6fe                          |
| 浏览器断言     | 27 项通过，原始结果见 [BrowserSmoke.json](BrowserSmoke.json)                         |

真实浏览器会话上传专用原始 block，确认默认私有及匿名条件读取 404，读取者取得 raw 附件并独立用 SHA-256/CID 编码校验字节。GET/HEAD、weak
ETag 的无体 304、公开后的匿名读取、空 identity
probe 与格式拒绝均通过。实际调用 navigator.serviceWorker.register，浏览器确认根脚本被 HTTP
400 拒绝；没有把错误 MIME 导致的注册失败当作正确拒绝。页面正常渲染。

测试 Pin 已经正常 DELETE 移入回收站，并确认匿名读取恢复 404；按产品的保留策略不是永久删除 R2 内容。没有创建 Agent
token、修改真实用户内容、执行生产 schema 操作或更改发布触发方式。生产浏览器 HTTP/3
smoke 与本地 Kubo/TLS/HTTP2 互操作是两组独立证据，不据此宣称公网 Kubo 或完整网关合规。
