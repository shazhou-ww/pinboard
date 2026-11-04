# 生产发布与外部验证证据

## 验收结论

`release-261104-1`
已成功部署，D-AC01 至 D-AC03 的实际验证均已完成。首次因无认证导致的 401 和冷取回超时保留为历史失败事实；用户随后提供临时 Agent
token，真实上传及非空区块、冷 Kubo 重建、自定义 CAR 往返于
`2026-11-04T09:03:03.520Z` 完成并全部通过。

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

## 已通过的匿名边缘验证

使用 Node 原生 HTTP/2 客户端直连生产域名，保留证书验证：`authorized=true`、ALPN 为
`h2`、TLS 为 `TLSv1.3`，无本地代理，也未以 Cloudflare 响应头推断协议。

首次完整匿名矩阵执行于 `2026-11-04T08:49:23.456Z` 至
`08:49:43.896Z`，共 166 项记录通过、0 项脚本失败：165 次请求及一次 GET/HEAD 表示头比较。状态分布为 200×78、304×10、400×34、401×1、404×10、406×28、412×4。这些计数包含缺失和鉴权拒绝测试，须结合后文真实内容验证才能支持完整验收。

| 场景                       | 实际结果                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| bafkqaaa GET/HEAD raw 探测 | 200，长度 0，无重定向；GET 精确为空，HEAD 无体                                                                     |
| identity ETag 与条件请求   | `"bafkqaaa.raw"`；强弱标识、列表、`*` 均正确返回空体 304；非匹配为 200                                             |
| Accept 协商                | raw、权重及通配符可接受时 200；q=0、具体排除覆盖通配符、不支持或相似类型为 406                                     |
| 畸形或缺失选择器           | 空/畸形 Accept 或无选择器为 400；空/不支持 format 为 406                                                           |
| format 优先级              | format=raw 优先于冲突或畸形 Accept，返回 200                                                                       |
| 根区块缺失                 | 普通 GET/HEAD 为 404；only-if-cached 为 412；附条件标识也不误返回 304                                              |
| identity 表示头            | Content-Type、长度、attachment、CSP、nosniff、CORS、immutable 缓存及 X-Ipfs-Path 正确；GET/HEAD 九项选定元数据一致 |
| 委托路由                   | identity 的 JSON/NDJSON 指向既定生产 HTTP provider；缺失 CID 返回空提供者集合                                      |
| 自定义 CAR 缺失回归        | 缺失根返回 404；成功导出见下文认证验收                                                                             |
| 受保护上传                 | 正确 Origin 和公开确认头，无认证时返回 401，未绕过授权                                                             |

实际 provider 为 `12D3KooWCjfPiojcCUmv78Wd1NJzi4Mraj1moxigp7AfQVQvGLwH`，地址
`/dns4/pinboard.shazhou.work/tcp/443/tls/http`，协议
`transport-ipfs-gateway-http`。

首轮脚本曾误用上传路径并缺少 Origin，实际 403 与其预期 401 不符。修正测试路径和请求头后得到正确 401；未改动应用来迎合错误断言。

## 首次真实内容验证及历史阻塞

测试使用真实 Kubo
0.43.1，确定性生成专用公开目录，包含 3,145,865 字节 payload、50 字节嵌套文本和空文件。未读取未知用户文件。完整 CAR 为 3,147,545 字节。

| 内容             | 来源标识                                                           |
| ---------------- | ------------------------------------------------------------------ |
| 目录根 CID       | `bafybeichdmdbzwsifxxipvqqykwdaiviqp3blxbwy5saryokhttifcadzu`      |
| payload SHA-256  | `3d56182a6e05230a33c16dbe3566253c609c3715adcf93aa696765fe09ffb2a8` |
| 嵌套文本 SHA-256 | `8adba0ab46a29257ca09a8e4ac213db9fb4e2730b22d54cc0f1317fafd1b9200` |
| 空文件 SHA-256   | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| 原始 CAR SHA-256 | `f871a516821d993a373eb9ce8d456bff8bef75642be1cc8664a04d7aea0b547f` |

这些最初仅是本地来源数据；后续成功下载对照同一组来源字节和哈希。

1. 首次源 daemon 于 `08:49:24.943Z` 正常停止，早于上传和冷客户端取回。
2. 当时没有合法测试 token，生产 `/api/me` 为 401；真实 CAR 上传至
   `/api/pins/upload?kind=car`，携带正确 Origin 和公开确认，于 `08:49:25.988Z`
   返回 401、`Sign in with Google`，未写入生产。
3. 两个独立冷仓库均先确认离线缺少该根区块；禁用 bootstrap、swarm 和 mDNS，仅允许生产 delegated
   router/HTTP provider，TLS 验证开启。
4. 两客户端的 findprovs 均为空；cat 和 get 各在 20 秒后以
   `context deadline exceeded`
   失败。因为上传未成功、内容未提供，不能把这些超时判为取回成功或单凭其判定网关回归。
5. 该根自定义 CAR 下载为 404，与未上传一致。已知的三项本地 PoC
   CID 在线上也均为 404，未枚举未知用户内容寻找替代样本。
6. 自身 daemon、精确 scratch 目录和专用端口均已清理；subagent 完成时工作区干净。

## 认证后的真实生产验收

用户随后提供专用于临时验收的 Agent
token。父 agent 仅在独立进程环境中注入凭据，脚本读入后即从环境删除，避免源节点和冷客户端继承。凭据不进入外部程序命令参数、脚本、结果、提交或本报告；用户将自行撤销。

认证验证执行区间为 `2026-11-04T09:02:10.110Z` 至
`09:03:03.520Z`，针对同一已部署版本，不再次发布，不修改线上配置或业务代码。

### 成功上传与非空区块

- 源 daemon 于 `09:02:16.597Z` 正常退出，早于真实上传和任何取回。
- `POST /api/pins/upload?kind=car&name=production-acceptance-261104-1` 于
  `09:02:33.498Z` 返回 201。
- 目录 CID 仍为
  `bafybeichdmdbzwsifxxipvqqykwdaiviqp3blxbwy5saryokhttifcadzu`；接受 18 个区块、3,146,793 字节唯一内容。
- 对真实存储的 165 字节根区块经正常证书验证的 HTTP/2 直连，完成 20 项请求断言。区块 SHA-256 为
  `471b061cda482dee87d610c2ac3022a883f615dc36c76408e1ca3ce6828803cd`，GET 字节与源区块完全相同。
- GET/HEAD 的九项表示元数据一致，包含原始类型、准确长度、attachment、CSP、nosniff、CORS、immutable 缓存和 X-Ipfs-Path。
- 强/弱/列表/通配符 If-None-Match 匹配均为无体 304，非匹配为 200；only-if-cached 对存在内容正确返回 200 或条件匹配的 304。
- CIDv0 和 CIDv1 地址都返回相同原始字节及规范化 `.raw`
  ETag，GET/HEAD 和条件匹配一致。
- 真实目录根的 JSON/NDJSON 路由均为 200，精确匹配上述生产 provider、multiaddr 和协议，不再仅验证 identity 路由。

### 停源后独立冷 Kubo 重建

使用两个新建的 Kubo
0.43.1 仓库，各自在启动前验证离线缺少测试根；bootstrap、swarm 和 mDNS 均关闭，仅配置生产 delegated
router 和生产 HTTP provider allowlist，TLS 验证开启。

- consumer-cat 于 `09:02:43.587Z` 就绪，取得正确 provider，经
  `ipfs cat /ipfs/<root>/payload.bin`
  取回 3,145,865 字节，与来源 Buffer 逐字节相同，SHA-256 为
  `3d56182a6e05230a33c16dbe3566253c609c3715adcf93aa696765fe09ffb2a8`。
- consumer-get 于 `09:02:51.478Z` 就绪，经独立 `ipfs get`
  重建完整目录，payload 和嵌套文本哈希均匹配，空文件长度为 0。
- 两客户端分别于 `09:02:50.857Z` 和 `09:02:58.349Z` 正常退出，exit
  0；源节点在全部取回期间保持停止。

### 真实自定义 CAR 往返

`GET /api/public/<root>/car` 于 `09:03:03.495Z` 返回 200，类型为
`application/vnd.ipld.car; version=1`，使用附件声明；CAR 为 3,147,545 字节，SHA-256 为
`4daf3f74323481fb5f97309165cfcf5d5cba0ee1cf01fb231cb5951e79b0b28a`。

使用独立 CAR
reader 解析上传和导出的 CAR：导出根精确匹配测试目录根，18 个区块的 CID 集合及各自字节全部相等，无缺失或额外区块。CAR 字节顺序不作为合规要求，因此不要求导出 CAR 哈希与原始 CAR 哈希相同。

### 复现及清理

会话中保留 `gateway-production-kubo.mjs` 和脱敏结果
`gateway-production-kubo-authenticated-results.json`。复跑时由调用方在独立进程中安全提供
`PINBOARD_ACCEPTANCE_TOKEN`，然后执行
`node <脚本路径>`；脚本不会持久化或回显 token，会立即移除子进程可继承的环境变量。

脚本断言上传状态、请求状态/字节、冷仓库初始缺块、来源字节/哈希、自定义 CAR 集合，任一失败均以非零退出码结束。本次退出码 0，`pass=true`，全部自身进程已停止，精确 scratch 已移除；专用公开测试 pin 保留在线上，未删除用户内容或撤销用户 token。

## 声明范围

### subagent 的末尾独立核查

- 匿名矩阵于 `2026-11-04T09:03:33.720Z` 至 `09:04:19.705Z`
  再次运行，166/166 通过，实证证书验证成功、TLS1.3、ALPN h2。
- 于 `09:03:36.665Z` 只读查询控制面，确认仍为 `release-261104-1`、version
  `8a1bd7fa-6a32-4a8c-8c3b-acbdb7c30585`、deployment
  `d4e93825-65ef-49d3-b9cd-66ec24336001`，流量 100%，没有并发切换。
- 只读核对脱敏认证结果：20 项非空区块断言、路由、冷 cat/get 字节比较、18 区块精确 CAR 往返及清理均通过。subagent 未接收 token、执行认证请求、上传或再次发布。
- 主 agent 随后运行 `pnpm check`，退出码 0，最终文档及仓库检查通过。

此前阻塞已解除，选定 raw-only 外部验收证据齐备，主 agent 可对同步后的准确修订作出验收。标准 CAR 网关、IPNS、Range/路径扩展仍暂缓；既有自定义 CAR 往返不代表支持标准 CAR 协商。没有把本地 PoC 冒充生产，也没有放宽原先矩阵。
