# CAR 路径证明外部验证

本文件服务于 Deployment.md。用户授权由主 Agent 执行门限审批及生产发布，没有授权数据库迁移，也没有接受后续全 DAG、实体字节区间或 IPNS 构想。

## 隔离真实网关与独立客户端

2026-11-12，使用已有 PoC 入口与单独本地 D1/R2 状态，启动真实 Wrangler 网关。客户端独立生成含 nested/hello.txt 与无关大文件的 UnixFS
CAR，通过标准 HTTP 接口请求显式 dag-scope=block，并验证实际返回的 CAR：

| 项目         | 实测结果                                                         |
| ------------ | ---------------------------------------------------------------- |
| 根 CID       | bafybeid76lrap2bbjtvflivc6s2upxwqqllpdaelbkhcccwgrmwhwens3u      |
| 请求路径     | nested/hello.txt                                                 |
| 完整归档     | 300,603 bytes                                                    |
| 路径证明     | 379 bytes，恰好 3 个 block                                       |
| 客户端       | 独立 CarReader/SHA-256 路径验证及全新离线 Kubo v0.43.1           |
| 文件 SHA-256 | 3045a7ccdd72490d020bb5db59b8bd9d7cb4737379aba00cc2def1b4264285ad |
| 完整性       | 根到路径及终点字节正确；删除或篡改中间 block 均拒绝              |
| 非递归范围   | 无关子树的 CID 在离线 Kubo 中不存在                              |

实际响应及独立验证结果见 [LocalProof.json](LocalProof.json)、
[LocalVerification.json](LocalVerification.json)。验证器不调用服务端遍历或证明函数，不是仅检查 HTTP
200、体积减少或 CAR 能被解析。离线 Kubo 在禁用根 pin 的情况下导入局部证明，执行 offline
resolve/cat；不通过回源补齐缺块。局部 HTTP
helper 已停止，其状态与消费者仅使用本会话的隔离临时目录。

父任务门限复核发现已授权缺失根的 only-if-cached 行为与 raw 不一致，已要求修正并复验：GET/HEAD 和条件请求保持普通 404、仅缓存请求 412，无权读取及缺失路径仍为 404，子块/索引存储错误仍为 503。修正后的定向测试 35 项通过，完整 pnpm
check 24 项任务成功，Worker
322 通过、1 项既有跳过；准确实施 revision 已提交并批准。

## 生产验证

生产发布、真实 Chrome for Testing
smoke 与生产证明的独立离线验证待执行。完成前不接受 Outer，不将隔离环境证明冒充线上验证。
