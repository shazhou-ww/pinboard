# Publication 的标准 IPNS 读取层

## 已确认的产品方向

2026-11-13 用户将本 idea 从通用 IPNS 记录出口改为 Publication 的标准读取适配层。Pinboard 托管私钥；Publication 的管理、权限、历史和元数据仍是 Pinboard 扩展，标准读取提供可验证的可变指针，内容读取以 CID/raw 为核心。本次更新文档，不代表批准实施、生成真实密钥、迁移或部署。

不要求 DHT 或其他分布式发现。IPNS 的签名记录和其分发方式分离，可以只从已知 Pinboard
HTTP 端点获取；外部节点不会因此自动发现记录。iteration
5 的职责收缩与其新验收范围仍待重新收敛，不把原重型 CAR 资源实验通过作为签名记录的技术前提，也不据此接受或完成 iteration
5。

## 身份与路由

| 标识/入口        | 定义                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| Publication ID   | 现有随机业务 ID，保留原链接及管理 API                                                                  |
| IPNS Name        | 每个 Publication 的独立密钥身份；公钥派生的 libp2p-key CID，通常 base36；不是业务 ID，也不是每版本新建 |
| 标准签名记录读取 | `GET/HEAD /ipns/{key}?format=ipns-record`；或同路径 `Accept: application/vnd.ipfs.ipns-record`         |
| 内容读取         | `GET/HEAD /ipfs/{cid}?format=raw`，客户端遍历、验证和重建                                              |
| 业务扩展         | 现有 `/p/{id}`、固定版本链接、管理/历史 API；不冒充标准 IPNS 接口                                      |

不提供 `/ipns/{key}/{path}`
的 UnixFS 解析或文件渲染，也不把标准记录接口返回成 Publication
JSON、CID 文本或 HTTP 重定向。Delegated Routing 的 `/routing/v1/ipns/{name}`
是另一个可选分发 API，不是首期默认新增项。

## 记录及更新规则

- Value 为
  `/ipfs/<当前 CID>`，携带 sequence、ValidityType/EOL、TTL 和签名；公钥已内嵌名称时可省略独立 pubKey。序列化记录遵守标准大小与验签要求，不携带 Publication 标题、账户身份或私有历史。
- 新内容发布和回滚都生成更新的指针，回滚不能降低 sequence；IPNS
  sequence 与 Publication
  revision/业务 sequence 不机械等同。相同 CID 的描述修改不应自动制造内容指向变化；必要签名刷新需另行定义。
- Publication 当前指针可长期存在，IPNS 签名记录必须有有限 EOL；未删除时自动续签，不要求用户发新内容版本。TTL 只是建议多久检查更新，不是签名撤销时间；续签是否保持 sequence 按固定规范核实。
- 删除后本服务停止返回记录并停止续签；已下载且未过期的签名仍可能验签成功，旧 CID 和副本也不能被远程抹除。新记录不使所有缓存旧签名立即无效，客户端已见新 sequence 后应避免回退。

## 私钥与信任

托管意味着 Pinboard 能签署该名称更新，不是用户独占密钥。私钥用于更新名称指向及续期，不加密内容、不替代业务授权。名称与具体 Publication 的关联必须通过可信域名/API 建立；签名只证明密钥控制，不能单独证明 Google 登录或官方服务归属。

私钥丢失会失去更新能力，泄露可伪造更新；换密钥会换名称。实施前确定加密托管、根 secret 管理、备份恢复和泄露处置，不以明文数据库字段、日志或仓库文件保存私钥。更新授权、签名及 Publication 当前指针需要可恢复的一致性协议：不能在业务更新失败后发布未经确认的指针，也不能静默报告签名成功。

## 尚须在实施前收敛

- EOL、TTL、续签提前量、调度和故障告警的具体值，不能用极远 EOL 代替续期。
- 私有 Publication 是否提供仅授权可读的记录、何时分配名称；不默认将私有指针公开或向分布式网络广播。
- 删除/恢复是否保留同一名称、过期期间客户端行为、并发更新和签名持久化顺序。
- 现有 Publication 的名称分配/回填、密钥安全恢复以及所需 schema，真实迁移需要单独授权；本次没有选择实现或密钥存储技术。

参考：[IPNS Record and Protocol](https://specs.ipfs.tech/ipns/ipns-record/)、
[Trustless Gateway](https://specs.ipfs.tech/http-gateways/trustless-gateway/)。
