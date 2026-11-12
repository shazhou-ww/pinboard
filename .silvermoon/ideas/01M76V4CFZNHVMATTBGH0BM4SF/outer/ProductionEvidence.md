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

生产发布、真实浏览器 smoke 及专用测试 Pin 清理尚待执行；此节未完成前不能接受 Outer，也不能将本地结果冒充生产证据。
