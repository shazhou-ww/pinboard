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

主线 CI
[43159274851](https://github.com/shazhou-ww/pinboard/actions/runs/43159274851)
四个 Windows/Linux、Node 22/24 组合全部通过，随后按既有 tag 工作流发布：

| 项目                    | 实测结果                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------ |
| 发布 tag                | release-261112-2，annotated tag                                                      |
| 发布 commit             | dbfe3991314e114e7d30cc1dc19be48420274ef4，已在 origin/main                           |
| 部署工作流              | [43160092395](https://github.com/shazhou-ww/pinboard/actions/runs/43160092395)，成功 |
| Worker version          | 77a7c910-d82a-4eff-bc2e-5ba599690e42                                                 |
| 浏览器                  | Chrome for Testing 157.0.8103.38                                                     |
| 域名及导航协议          | https://pinboard.shazhou.work，h3                                                    |
| smoke 时间              | 2026-11-12T05:19:38.674Z                                                             |
| 专用目录 CID            | bafybeihc5er463jay3fo2ka4nmwniuvhtnjfdmrt3onw23uimsta3xkyyu                          |
| 完整归档 / 实际路径证明 | 300,640 / 416 bytes，恰好 3 个 block                                                 |
| 浏览器断言              | 36 条成功，含两次预览状态检查                                                        |
| 独立离线客户端          | Kubo v0.43.1，offline resolve/cat 成功                                               |
| 文件 SHA-256            | 0e3fb33b6b7204f6d51dc357b35881e65473640d3917262c64254d422c2bfc4b                     |

实际浏览器结果和原始证明见 [BrowserSmoke.json](BrowserSmoke.json)，独立校验见
[OfflineVerification.json](OfflineVerification.json)。

Chrome 使用现有登录会话上传专用 CAR，确认默认私有及匿名 404，验证所有者的标准路径证明、GET/HEAD、弱条件命中 304、缺失路径在通配验证器下仍 404。公开专用目录后匿名取得证明，完整 CAR 自定义导出及 raw/CAR 探针仍可用。缺省 all、entity 与 CARv2 明确拒绝，没有静默降为 block。

浏览器另生成专用 PNG 并上传，验证预览生成、既有 WebP 选择、缩略图显式 raw 返回相同字节，且 WebP 的 ETag 不命中 raw。两枚专用 Pin 均正常 DELETE 移入回收站，并确认匿名读取恢复 404；不执行永久删除，也不修改真实用户内容。

在独立测试页的网络限速下取消 CAR 请求，CDP 观测到真实请求及 canceled=true，浏览器取得 AbortError；恢复网络后 CAR 探针返回 200、26
bytes。该证据说明浏览器取消与恢复行为，不将其夸大为生产 CPU/R2 资源回收的量化证明。

独立验证器从生产实际响应核对恰好 3 个 CID、逐块 SHA-256 及根到路径关系，删除或篡改中间 block 均拒绝；全新离线 Kubo 导入局部证明后 resolve/cat 成功，无关子树 block 不存在。验证没有调用服务端遍历函数，也没有联网补齐内容。

本次只交付非递归 CARv1
dfs/n 的显式 block 范围；不声明支持 all/entity、entity-bytes、IPNS 或官方全量一致性认证。未执行生产数据库迁移、修改发布触发方式或接受后续迭代；iteration
1 的 raw、权限与图片边界保持成立。
