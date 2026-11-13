# Worker 网关能力取舍与标准路由对照

## 定位与当前状态

2026-11-13，基于 Worker 的执行与内存限制，建议将 Pinboard 定位为：以 raw
block 分发为核心，提供受限路径证明；客户端负责 DAG 遍历、逐块验证、文件重建及 CAR 组装，不让 Worker 承担任意 DAG 动态聚合。

本文件是 iteration
5 的职责调整建议，不替代已接受的 Ideal 或当前验收契约。用户本次要求记录讨论和路由对照，不表示已批准删除线上能力、改变协议行为或部署。iteration
1–4 已上线的 entity/all/entity-bytes 仍然存在；若决定收缩，须明确新支持矩阵、兼容性与迁移方案，并重新收敛契约及接受准确 revision。原有资源阻塞和失败证据不撤销，也不通过缩小范围把旧门槛改记为通过。

## 路由记号

- `{cid}` 为请求根 CID，`{path}` 为可选的 UnixFS/IPLD 子路径， `{key}`
  为 IPNS 名称。以下查询参数使用 `&` 连接，不是独立路径。
- 标准 raw 请求只支持 `/ipfs/{cid}`，不能把带子路径的 raw 请求静默解释成终点块。
- GET/HEAD 是同一表示的读取和无体读取；HEAD 不自动意味着处理成本低。
- “无专用路由”表示该能力通过已有请求头/响应头实现，或没有该标准 API；不能据表格自行发明并宣称标准的 endpoint。

## 能力取舍表

| 能力                                 | 建议                                     | 对应路由与请求方式                                                                                                                                                     | 标准归属及约束                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw block GET                        | 应该做，核心能力                         | `GET /ipfs/{cid}?format=raw`；或 `GET /ipfs/{cid}` 加 `Accept: application/vnd.ipld.raw`                                                                               | Trustless Gateway 的 raw 必需能力；按 CID 授权并读取单块，客户端验证 CID，沿用单块 2 MiB 上限、不回源                                                            |
| Raw HEAD、ETag、304                  | 应该做                                   | 同一 raw 路由使用 `HEAD`；GET/HEAD 携带 `If-None-Match`，命中返回 304                                                                                                  | 没有独立 `/head` 或 `/etag` API；授权与可用性检查先于条件命中，保留已有元数据优化                                                                                |
| 空 identity probe                    | 应该做                                   | `GET/HEAD /ipfs/bafkqaaa?format=raw`；若提供 CAR，则 `GET/HEAD /ipfs/bafkqaaa?format=car`                                                                              | Trustless Gateway 专用探测；raw 为空体，CAR 为有效 header-only CAR。只探测格式，不能由 CAR probe 推断支持全部 scope/路径/范围                                    |
| 格式及 CAR 变体协商                  | 应该做                                   | `/ipfs/{cid}[/{path}]?format=car` 或 raw 路由；`Accept`、`car-version`、`car-order`、`car-dups` 与响应 `Content-Type`                                                  | 没有独立协商路由；只声明实际格式/变体，不支持时明确拒绝，不悄悄把 CAR 换成 raw                                                                                   |
| 公开 CORS、安全头及预检              | 应该做                                   | 实际 raw/CAR URL 的 GET/HEAD；浏览器需要预检时向同一 URL 发 `OPTIONS`                                                                                                  | HTTP/CORS 机制，不是能力 manifest。OPTIONS/Allow 不列出 DAG 功能；不能为公开跨源读取放开私有 Cookie 或根 service worker                                          |
| Provider discovery                   | 应该做                                   | `GET /routing/v1/providers/{cid}`，可用 JSON 或 NDJSON                                                                                                                 | 属于 Delegated Routing V1，不是 Trustless Gateway 内容路由；`transport-ipfs-gateway-http` 只声明传输，不细分 CAR scope 或字节范围                                |
| 完整能力清单                         | 可以做，自有扩展                         | 没有标准 Trustless Gateway 能力清单路由；若新增，需另定版本化 Pinboard API                                                                                             | 不把自有 `/api/...` 或任意 `/.well-known/...` 宣称为 IPFS 标准；通用客户端仍依赖探测、协商及实际错误响应                                                         |
| UnixFS 路径定位目标 CID              | 受限地做                                 | 标准可验证方式为 `GET/HEAD /ipfs/{cid}/{path}?format=car&dag-scope=block`；只返回解析 CID 的独立 API 无统一 Trustless Gateway 路由                                     | 读取完整沿途目录/HAMT 元数据块，不是 HTTP HEAD 或固定大小“块头”。只给目标 CID 不能证明路径，客户端需沿途块或 CAR 路径证明                                        |
| block 范围路径证明 CAR               | 受限地做，建议保留                       | `GET/HEAD /ipfs/{cid}[/{path}]?format=car&dag-scope=block`                                                                                                             | 包含验证路径及终点所需块，不取终点文件后代；整个证明设较小独立预算，超限明确失败，不把部分证明报告为完整                                                         |
| 普通及 HAMT 目录枚举                 | 受限地做                                 | `GET/HEAD /ipfs/{cid}[/{path}]?format=car&dag-scope=entity`，终点为目录                                                                                                | 同一 entity scope，不存在标准 `/ls` 路由；CAR 携带可验证目录/必要分片，不递归子文件。大 HAMT 可能昂贵，应限制并拒绝超额，不返回伪完整列表                        |
| 完整文件 entity                      | 不作为通用 Worker 能力；如保留，仅小预算 | 同一 `?format=car&dag-scope=entity`，终点为文件                                                                                                                        | 与目录枚举共用路由，成本取决于终点类型；多块文件需要完整文件 DAG，不能将“支持目录 entity”表述为无条件支持所有 entity                                             |
| 完整子树 all                         | 不建议动态提供                           | `GET/HEAD /ipfs/{cid}[/{path}]?format=car&dag-scope=all`；省略 dag-scope 的 CAR 请求也默认为 all                                                                       | 请求范围可很大，建议交给客户端；若停用，显式 all 与省略 scope 都要明确处理，不能把默认改为 block                                                                 |
| entity-bytes 局部 CAR                | 可选、严格受限，非核心要求               | `GET/HEAD /ipfs/{cid}[/{path}]?format=car&entity-bytes={from}:{to}`                                                                                                    | 隐含 entity，不是 HTTP Range 或 CAR 字节截断；限定实际必要读取数/字节，不只限制区间长度。保留与否需迁移决定                                                      |
| 已存完整 CAR 直接下载                | 应该保留                                 | 现有 `GET /api/public/{cid}/car`；未来若走标准入口，根上的 `GET /ipfs/{cid}?format=car&dag-scope=all` 才可能是候选                                                     | 当前是 Pinboard 自有完整归档导出，不是新标准路由。标准入口复用仅在根、块集合、顺序、版本、dups、授权及完整性语义全部相符时成立，不能直接重定向或冒充支持任意查询 |
| 现场组装完整 CAR                     | 不建议做                                 | 无额外专用路由；表现为标准 CAR `all` 或文件 `entity` 查询，也可能是自有导出实现细节                                                                                    | 动态遍历/聚合才是风险，不是“CAR”媒体类型本身。客户端组装或未来独立服务；已存 R2 对象流式发送不等同现场组装                                                       |
| 普通 raw HTTP Range                  | 暂不做                                   | 同一 raw URL 携带 `Range: bytes=...`，不是 `?entity-bytes=...`                                                                                                         | Path Gateway 的 HTTP 范围机制，不另建 `/range`；目前整块 200 不宣称 206/416 支持，客户端需要完整块验证 CID                                                       |
| 任意 CID 回源、DHT、Bitswap          | 不做                                     | Trustless Gateway 没有专门“回源”路由；同一 `/ipfs/{cid}` 请求是否递归属于网关策略；DHT/Bitswap 是另行协议                                                              | 保持本地非递归，未知/不可用明确返回；客户端负责内容发现及其他 provider 选择，不能把 HTTP provider 标识当作 libp2p 服务                                           |
| IPNS 原始签名记录                    | 可独立受限支持，低优先级                 | `GET/HEAD /ipns/{key}?format=ipns-record`；或 `Accept: application/vnd.ipfs.ipns-record`                                                                               | Trustless Gateway 的可验证记录；不等于文件解析、DNSLink、DHT 查询或记录发布。`GET /routing/v1/ipns/{name}` 是另一个 Delegated Routing API，不混同                |
| 网站渲染、DNSLink、Subdomain Gateway | 不做                                     | Path Gateway 的 `/ipfs/{cid}/{path}`、`/ipns/{name}/{path}` 可涉及浏览器表示；子域形式如 `https://{cid}.ipfs.{gateway}/{path}`、`https://{name}.ipns.{gateway}/{path}` | 分属更广的 Path/DNSLink/Subdomain Gateway；不是 Trustless Gateway 必需功能，也不要求本 Worker 提供网站执行或 DNS 解析                                            |

## 建议的长期核心组合

raw 分发、元数据 HEAD/条件请求、本地 provider
discovery、受限 UnixFS 路径证明，以及已存完整 CAR 流式下载。客户端逐块校验、按需遍历及重建，客户端也应控制并发、缓存和流式输出，不能仅将整包内存问题转移到浏览器。

受限能力的预算必须同时约束块数、累计读取字节、D1/R2 操作、路径深度、在途载荷和总期限；数值待实测，不能沿用 32
MiB 上传限额即认定安全。单槽也不保证 GC 在请求边界完成，不据此宣称联合内存风险已解决。

## 协议和迁移注意事项

- raw 是 MUST，CAR 是 SHOULD；可以明确提供 raw 主导的服务，但不能声称已实现完整标准 CAR 查询。
- 目录枚举和文件读取都用 entity，同一 scope 可因内容和成本出现不同结果；须公开范围/限额与准确错误，不使客户端把资源拒绝误解为内容不存在。
- scope=block 的路径证明不包含完整文件；不要把它作为 entity/all 的成功降级。
- CAR-only 客户端不会因服务端声明 raw 就自动逐块回退，需要客户端支持相应策略。
- 任何停用 entity/all/entity-bytes 的决定均需列出 Web、CLI、Kubo 和外部客户端影响，保留自有归档下载的兼容路径，获准后才能修改生产。
- 本次只记录表格；iteration 5 原内存阻塞、官方套件未执行及生产版本状态不变。

## 规范来源

- [Trustless Gateway](https://github.com/ipfs/specs/blob/29b7640c6517a03852a5a7958a85e3f89657050a/src/http-gateways/trustless-gateway.md)
- [Path Gateway](https://github.com/ipfs/specs/blob/46978c95955e252b23ddae98d6e5cd6e37853c9a/src/http-gateways/path-gateway.md)
- [Delegated Routing V1](https://specs.ipfs.tech/routing/http-routing-v1/)
- [Subdomain Gateway](https://specs.ipfs.tech/http-gateways/subdomain-gateway/)
- [DNSLink Gateway](https://specs.ipfs.tech/http-gateways/dnslink-gateway/)
