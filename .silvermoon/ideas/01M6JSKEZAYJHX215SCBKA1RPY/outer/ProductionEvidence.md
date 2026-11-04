# 生产发布与外部验证证据

## 验收结论

`release-261104-1`
已成功部署。D-AC01 通过；D-S02、D-AC02、D-AC03 未完成，不能整体接受外部阶段。合法会话和已授权测试 token 不可用，上传返回 401，尚无真实生产多区块内容的成功重建证据。

本次未更改工作流、凭证、资源绑定、域名或 D1，未执行迁移，也未创建 release
skill。只沿用现有标签发布流程，不启用分支推送部署。不通过伪造会话或绕过授权消除验证阻塞。

## 不可变发布身份

| 项目               | 实际结果                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| 生产源站           | `https://pinboard.shazhou.work`                                                                              |
| 发布标签           | `release-261104-1`                                                                                           |
| 标签对象           | `f0633706de8886c4f058574a7ed5ca22759c58ce`                                                                   |
| 发布提交           | `96583d9bf8d52ba839dd746abef06c6b0d0a9dc2`                                                                   |
| 部署 Actions       | [41801933814](https://github.com/shazhou-ww/pinboard/actions/runs/41801933814)，success                      |
| 发布前 CI          | [41801698266](https://github.com/shazhou-ww/pinboard/actions/runs/41801698266)，Node 22.13.0、24.11.1 均通过 |
| Worker version     | `8a1bd7fa-6a32-4a8c-8c3b-acbdb7c30585`                                                                       |
| Version annotation | `workers/tag=release-261104-1`                                                                               |
| Deployment         | `d4e93825-65ef-49d3-b9cd-66ec24336001`                                                                       |
| 流量分配           | 上述 version 为 100%                                                                                         |
| 部署创建时间       | `2026-11-04T08:46:02.913883Z`                                                                                |
| 控制面二次确认时间 | `2026-11-04T08:50:34.656Z`                                                                                   |

发布前本地
`pnpm check`、主分支祖先检查和标签格式校验通过；部署 Actions 再次运行完整检查成功。主 agent 通过
`gh run view 41801933814` 独立确认成功状态及准确提交。

## 已通过的实际边缘验证

使用 Node 原生 HTTP/2 客户端直连生产域名，保留证书验证：`authorized=true`、ALPN 为
`h2`、TLS 为 `TLSv1.3`，无本地代理，也未以 Cloudflare 响应头推断协议。

匿名矩阵最终执行于 `2026-11-04T08:49:23.456Z` 至
`08:49:43.896Z`，共 166 项记录通过、0 项脚本失败：165 次请求及一次 GET/HEAD 表示头比较。状态分布为 200×78、304×10、400×34、401×1、404×10、406×28、412×4。这些计数包含缺失和鉴权拒绝测试，不等于完整部署验收通过。

| 场景                       | 实际结果与边界                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| bafkqaaa GET/HEAD raw 探测 | 200，长度 0，无重定向；GET 精确为空，HEAD 无体                                                                     |
| identity ETag 与条件请求   | `"bafkqaaa.raw"`；强弱标识、列表、`*` 均正确返回空体 304；非匹配为 200                                             |
| Accept 协商                | raw、权重及通配符可接受时 200；q=0、具体排除覆盖通配符、不支持或相似类型为 406                                     |
| 畸形或缺失选择器           | 空/畸形 Accept 或无选择器为 400；空/不支持 format 为 406                                                           |
| format 优先级              | format=raw 优先于冲突或畸形 Accept，返回 200                                                                       |
| 根区块缺失                 | 普通 GET/HEAD 为 404；only-if-cached 为 412；附条件标识也不误返回 304                                              |
| identity 表示头            | Content-Type、长度、attachment、CSP、nosniff、CORS、immutable 缓存及 X-Ipfs-Path 正确；GET/HEAD 九项选定元数据一致 |
| 委托路由                   | identity 的 JSON/NDJSON 指向既定生产 HTTP provider；缺失 CID 返回空提供者集合                                      |
| 自定义 CAR 缺失回归        | 缺失根返回 404；成功导出尚未验证                                                                                   |
| 受保护上传                 | 正确 Origin 和公开确认头，无认证时返回 401，未绕过授权                                                             |

实际 provider 为 `12D3KooWCjfPiojcCUmv78Wd1NJzi4Mraj1moxigp7AfQVQvGLwH`，地址
`/dns4/pinboard.shazhou.work/tcp/443/tls/http`，协议
`transport-ipfs-gateway-http`。

首轮脚本曾误用上传路径并缺少 Origin，实际 403 与其预期 401 不符。修正测试路径和请求头后得到正确 401；未改动应用来迎合错误断言。

## 已执行但未成功的真实内容验证

测试使用真实 Kubo
0.43.1，确定性生成专用公开目录，包含 3,145,865 字节 payload、50 字节嵌套文本和空文件。未读取未知用户文件。完整 CAR 为 3,147,545 字节。

| 内容             | 来源标识                                                           |
| ---------------- | ------------------------------------------------------------------ |
| 目录根 CID       | `bafybeichdmdbzwsifxxipvqqykwdaiviqp3blxbwy5saryokhttifcadzu`      |
| payload SHA-256  | `3d56182a6e05230a33c16dbe3566253c609c3715adcf93aa696765fe09ffb2a8` |
| 嵌套文本 SHA-256 | `8adba0ab46a29257ca09a8e4ac213db9fb4e2730b22d54cc0f1317fafd1b9200` |
| 空文件 SHA-256   | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| CAR SHA-256      | `f871a516821d993a373eb9ce8d456bff8bef75642be1cc8664a04d7aea0b547f` |

以上是本地来源数据，不是生产下载成功证明。

1. 源 daemon 于 `08:49:24.943Z` 正常停止，早于上传和冷客户端取回。
2. 生产 `/api/me` 为 401；没有已提供的合法测试 token。真实 CAR 上传至
   `/api/pins/upload?kind=car`，携带正确 Origin 和公开确认，于 `08:49:25.988Z`
   返回 401、`Sign in with Google`，未写入生产。
3. 两个独立冷仓库均先确认离线缺少该根区块；禁用 bootstrap、swarm 和 mDNS，仅允许生产 delegated
   router/HTTP provider，TLS 验证开启。
4. 两客户端的 findprovs 均为空；cat 和 get 各在 20 秒后以
   `context deadline exceeded`
   失败。因为上传未成功、内容未提供，这不是生产取回成功证明，也不能单凭这些超时判定网关回归。
5. 该根的自定义 CAR 下载为 404，与未上传一致。已知的三项本地 PoC
   CID 在线上也均为 404，未枚举未知用户内容寻找替代样本。
6. 自身 daemon、精确 scratch 目录和专用端口均已清理；subagent 完成时工作区干净。

## 剩余阻塞与恢复条件

必须通过合法登录会话或已授权测试 token 成功上传自有多区块 fixture，随后补齐：

- 实际存储的非空区块 GET/HEAD、字节与长度、条件请求和等价 CIDv0/v1 的 ETag。
- 存储 DAG 的 provider 路由，而不仅是 identity 探测提供者。
- 停源后两个独立冷仓库成功 cat/get，重建目录、嵌套路径与空文件，比较来源字节和哈希。
- 自定义 CAR 成功导出、根及区块验证往返。

主 agent 不因拥有验收决定权而跳过真实证据。未获取认证前保持
`deploying`，不提交 submitOuter、不记录 acceptOuter。标准 CAR/IPNS/Range 扩展仍暂缓。
