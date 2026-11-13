# Worker 网关能力取舍与标准路由对照

## 已确认的职责方向

2026-11-13 用户确认收缩 Worker 职责：**提供 CID/raw 分发，不提供服务端 UnixFS 路径解析及动态 DAG 聚合**。客户端自行解析目录、遍历、校验和组装；Publication 增加标准 IPNS 签名读取层，管理、历史及其他产品接口为扩展。

本表描述 iteration 5 候选已实施的收敛范围，不冒充已上线状态。生产
`release-261112-4`
仍提供旧能力；候选显式撤出路径、scope、entity-bytes 及所有动态 CAR（包括根 block 包装与 probe）。原内存实验失败仍成立，不把缩小职责当作旧门槛通过，也不修改已完成迭代历史。实际清理和兼容证据见
[清理证据](InnerCleanUpEvidence.md)。

## 能力与路由

`{cid}` 是根 CID，`{path}` 是子路径，`{key}` 是 IPNS
Name。标准 raw 仅支持根路径；HEAD、条件请求和 CORS 没有额外内容路由。取舍列仅使用“保留”“不做”“待做”；细节放在说明列。下表为目标方向，不冒充已部署的支持矩阵。

| 能力                               | 目标取舍 | 标准路由/请求方式                                                                                                              | 说明                                                                                                               |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Raw block GET                      | 保留     | `GET /ipfs/{cid}?format=raw`，或同路径 `Accept: application/vnd.ipld.raw`                                                      | 核心单块授权读取，保留 2 MiB 限额；客户端校验 CID                                                                  |
| Raw HEAD/ETag/304                  | 保留     | 同 raw URL 的 HEAD，以及 GET/HEAD 的 `If-None-Match`                                                                           | 授权与可用性检查先于命中，保留元数据优化                                                                           |
| identity probe                     | 保留     | `GET/HEAD /ipfs/bafkqaaa?format=raw`                                                                                           | 仅保留 raw probe；CAR probe `/ipfs/bafkqaaa?format=car` 随动态 CAR 撤出，不暗示提供通用 CAR                        |
| 格式/变体协商                      | 保留     | `/ipfs/{cid}` 的 `format`/`Accept`；标准 CAR 查询含 `car-version/order/dups`                                                   | 保留 raw 选择及不支持项的准确拒绝；CAR 变体执行逻辑不保留，不静默换 raw 或把默认 all 改 block                      |
| 公开 CORS/安全头/预检              | 保留     | 实际 raw/IPNS URL；预检为同 URL 的 `OPTIONS`                                                                                   | 保留必要公开读取支持；IPNS 随 iteration 6 增加。不开放跨站私有 Cookie 或根 service worker                          |
| Provider discovery                 | 保留     | `GET /routing/v1/providers/{cid}`                                                                                              | Delegated Routing V1，不是 Trustless Gateway 内容路由；只声明 HTTP provider，不宣称 libp2p 或 CAR 全功能           |
| 完整能力清单                       | 不做     | 没有统一标准能力清单路由                                                                                                       | 自有客户端不消费，标准客户端不识别；不新增自有 manifest/API 或 `/.well-known/...`，仅保留标准 probe/协商及文档声明 |
| UnixFS 路径定位 CID                | 不做     | 标准可验证路径入口原为 `GET/HEAD /ipfs/{cid}/{path}?format=car&dag-scope=block`；单独 resolve-CID 无统一 Trustless Gateway API | 客户端读目录/HAMT 块自行定位；不新建 `/resolve`，不偷偷把路径 raw 解释为终点块                                     |
| 路径证明 CAR                       | 不做     | `GET/HEAD /ipfs/{cid}[/{path}]?format=car&dag-scope=block`                                                                     | 包括受限版本；不保留服务端路径解析或根的 block CAR 包装，raw 足够                                                  |
| 普通/HAMT 目录枚举                 | 不做     | `GET/HEAD /ipfs/{cid}[/{path}]?format=car&dag-scope=entity`，终点为目录                                                        | 无标准 `/ls`；客户端通过 raw 重建目录，已存归档下载不是目录查询                                                    |
| 完整文件 entity                    | 不做     | 同 `?format=car&dag-scope=entity`，终点为文件                                                                                  | 不做动态获取/聚合，不为小文件或单节点特设例外                                                                      |
| 子树 all                           | 不做     | `GET/HEAD /ipfs/{cid}[/{path}]?format=car&dag-scope=all`，省略 scope 也为 all                                                  | 不做动态获取/聚合，不将省略默认值改为 block；准确拒绝，不返回伪完整 CAR                                            |
| entity-bytes                       | 不做     | `GET/HEAD /ipfs/{cid}[/{path}]?format=car&entity-bytes={from}:{to}`                                                            | 不做服务端范围证明；客户端按 UnixFS 索引取所需 raw 块                                                              |
| 已存完整 CAR 下载                  | 保留     | 现有 `GET /api/public/{cid}/car`；标准根 CAR 入口为 `/ipfs/{cid}?format=car`，但本方向不自动复用                               | 自有流式扩展，仅返回已存在归档，不遍历/现场打包，不冒充任意标准 CAR 查询                                           |
| 现场组装完整 CAR                   | 不做     | 无额外专用标准路由，通常体现为 all/文件 entity 或自有导出的实现                                                                | 客户端组装；既有自有导出的 legacy/未索引兼容回退也需检查，不能保留隐藏的服务端整 DAG 聚合                          |
| 普通 raw HTTP Range                | 不做     | raw URL 加 `Range: bytes=...`                                                                                                  | 不是 entity-bytes；不宣称 206/416，整块读取才能独立校验 CID                                                        |
| 任意 CID 回源/DHT/Bitswap          | 不做     | 无专门 Trustless Gateway 回源路由；是否回源是 `/ipfs/{cid}` 的策略，DHT/Bitswap 为其他协议                                     | 保持非递归，客户端选择其他 provider                                                                                |
| Publication IPNS 记录              | 待做     | `GET/HEAD /ipns/{key}?format=ipns-record` 或 `Accept: application/vnd.ipfs.ipns-record`                                        | iteration 6：Pinboard 托管密钥、原始签名指针、有限 EOL 自动续签，不返回 Publication JSON 或内容重定向              |
| 通用 IPNS 解析/记录获取            | 不做     | 通用 `/ipns/{key}`，以及可选 Delegated Routing `GET /routing/v1/ipns/{name}`                                                   | 首期只服务自己的 Publication 名称，不任意网络查找；额外 routing IPNS API 不默认新增                                |
| 网站渲染/DNSLink/Subdomain Gateway | 不做     | Path Gateway 的 `/ipfs/{cid}/{path}`、`/ipns/{name}/{path}`；`https://{cid}.ipfs.{gateway}/{path}` 等                          | 非本服务标准读取目标，不提供网站执行或 DNS 解析                                                                    |

## 核心组合与 Publication

目标组合为 raw 分发、元数据 HEAD/条件请求、本地 provider
discovery、已有完整 CAR 流式下载，加
[Publication 标准 IPNS 读取层](../../../../01M76VHAKEJ4TA4WSNVB4RX769/outer/inner/ideal/Idea.md)。服务端没有 UnixFS 路径时，客户端仍可在一次用户下载操作内部发出多个块请求；IPNS 先验签得到当前根 CID，再在客户端解析目录和文件。

raw 是规范 MUST，CAR/IPNS record 是 SHOULD；不以精简范围宣称完整 Path/Trustless
Gateway。不做完整能力清单；用标准 probe、协商及准确文档表达范围，不假定 CAR-only 客户端自动回退。

## 候选兼容边界与父会话验收

- Web/CLI/MCP、脚本与文档清点见
  [清理证据](InnerCleanUpEvidence.md)；撤出能力对可读根为 406，未知/不可读根保持 404，不能混淆内容不可用与能力不支持。
- 自有完整 CAR 只保留直接归档流式路径；legacy/未索引根无归档时为 503，提示重新上传或显式 pin，禁止读取时遍历重编码或自动回填。
- 自有原文件/ZIP 下载、预览生成属于产品扩展，不因本表宣称已迁移到客户端；它们可能仍有聚合与内存成本，需独立清点，不能据网关收缩宣布整个 Worker 安全。
- CAR
  probe、文档及官方测试选择必须与新范围同步；不新增能力清单，不只删失败测试就把旧资源保障标为通过。
- 子会话不执行发布、生产迁移、数据删除或真实密钥生成。父会话门禁及用户最新 GitHub
  Actions 发布授权见 [Deployment](../Deployment.md)；iteration
  5 无迁移，iteration 6 必要纯新增 SQL 须展示准确语句/影响并另获用户批准。

## 规范来源

- [Trustless Gateway](https://specs.ipfs.tech/http-gateways/trustless-gateway/)
- [Delegated Routing V1](https://specs.ipfs.tech/routing/http-routing-v1/)
- [IPNS Record and Protocol](https://specs.ipfs.tech/ipns/ipns-record/)
- [Path Gateway](https://specs.ipfs.tech/http-gateways/path-gateway/)
