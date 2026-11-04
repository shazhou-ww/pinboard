# 协议矩阵与验收证据

## 决策与范围

用户已授权主 agent 负责所有门限、取舍和验收，并要求由一个 subagent 实现。主 agent 接受的构想为
`idealRevision=d855bed16d902381374fc8d42d48db3d94023921`；该决定不等于代码或生产结果已经通过验证。

本次仅修正 TG-01 至 TG-05，并补齐 TG-08 的本地证据。TG-06、TG-07 的标准 CAR、IPNS、路径和 Range 扩展继续暂缓。保留现有自定义 CAR、委托路由和授权模型，不增加远程 CID 取回。

明确的有意行为变更：

- GET/HEAD 对现有内容进行 If-None-Match 弱比较，匹配时返回空体 304。
- raw ETag 使用规范化 CID 与 `.raw` 后缀，等价 CID 对应同一表示形式。
- 同时缺少 format 和 Accept 时返回 400；仅使用 format=raw 仍被接受。
- 支持媒体通配符，按具体程度与 q 值判断 raw 的可接受性，不能让通配符绕过更具体的 q=0。
- 显式 format 优先于 Accept；不支持或空的显式 format 必须拒绝。
- 仅在携带 only-if-cached 且根区块缺失时由普通 404 改为 412。指令按完整名称、大小写不敏感匹配，不能接受相似子串。
- 空或畸形 Accept 返回 400；有效但不接受 raw 的 Accept 返回 406。空或不支持的显式 format 返回 406；format=raw 仍优先于畸形或冲突的 Accept。
- 同等具体程度的重复媒体范围取最高质量；带值的 only-if-cached 不视为有效的裸指令。不引入静默成功或未验证的默认行为。

## 需求到验证的矩阵

下表定义实现验收要求；实际测试映射与运行结果记录于后文。

| 需求  | 场景                                                   | 预期结果                                                                                        |
| ----- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| TG-01 | 普通区块 GET/HEAD，匹配强标识、弱标识、标识列表或 `*`  | 304，无响应体，校验标识与缓存元数据一致                                                         |
| TG-01 | 不匹配的校验标识                                       | 200，保留正确元数据与 GET 原始字节                                                              |
| TG-01 | 根区块缺失但请求携带匹配形式或 `*`                     | 普通请求 404，不误返回 304                                                                      |
| TG-01 | bafkqaaa GET/HEAD 条件请求                             | 与普通区块一致的校验语义；成功时长度为 0                                                        |
| TG-01 | HEAD/已匹配条件请求                                    | 只读取必要元数据，不无谓加载区块响应体                                                          |
| TG-02 | 精确 raw 类型、带权重候选类型                          | 仅在 raw 可接受时返回 raw                                                                       |
| TG-02 | raw;q=0，包括与 application/* 或 _/_ 混用              | 具体禁止不能被通配范围覆盖                                                                      |
| TG-02 | application/_、_/* 与不支持的候选类型                  | 按媒体范围、具体程度与 q 值选择或明确拒绝                                                       |
| TG-02 | raw 相似名称、畸形头部、不支持或空的 format            | 明确拒绝，不误接受                                                                              |
| TG-02 | format=raw 与冲突 Accept，或只有 format=raw            | format 优先，保持查询参数形式兼容                                                               |
| TG-03 | GET/HEAD 根区块缺失，组合或大小写变化的 only-if-cached | 412；完整匹配指令名                                                                             |
| TG-03 | 普通根区块缺失，或相似但不同的缓存指令                 | 404，不发生回源                                                                                 |
| TG-03 | 本地存在的区块与探测 CID 携带 only-if-cached           | 正常 200 或条件匹配的 304                                                                       |
| TG-04 | format 和 Accept 都缺失、空值或不支持                  | 按文档所定策略返回 400/406，并覆盖 GET/HEAD                                                     |
| TG-05 | GET/HEAD 与等价 CID 形式                               | 稳定的规范化 `.raw` ETag，条件匹配一致                                                          |
| TG-08 | 原始内容与元数据                                       | 原始字节、Content-Length、attachment、CSP、nosniff、CORS、immutable 缓存和 X-Ipfs-Path 保持正确 |
| TG-08 | 既有业务与接口                                         | 路由、pin 授权与自定义 CAR 回归测试通过                                                         |
| TG-08 | 本地真实 Kubo 取回                                     | 停止源节点，独立冷客户端经 HTTP/2 取回文件/目录，字节与哈希一致                                 |

## 验证结果

### 自动化测试映射

实现位于 [gateway.ts](../../../../../apps/worker/src/gateway.ts) 和
[gateway-http.ts](../../../../../apps/worker/src/gateway-http.ts)。协议测试位于
[gateway.test.ts](../../../../../apps/worker/test/gateway.test.ts)，既有路由、授权及 CAR 回归位于
[worker.test.ts](../../../../../apps/worker/test/worker.test.ts)。

| 需求         | 测试名称                                                              | 证明的主要行为                                                                              |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| TG-01        | weakly compares validators and lists only after checking availability | 普通块与探测、强弱标识、列表、通配符、304 空体、未匹配 200、缺失 404；GET/HEAD 变体分别执行 |
| TG-01        | does not turn storage failures into cache hits, 304s or missing roots | 存储错误保持 500，不伪装成缓存命中或内容缺失                                                |
| TG-02        | negotiates only acceptable raw media ranges                           | 权重、媒体范围具体程度、q=0 排除、通配符和相似类型拒绝                                      |
| TG-02、TG-04 | rejects malformed Accept but lets explicit format override it         | 畸形/空 Accept 400、有效但不接受 raw 时 406、format 优先、缺失/空/不支持选择器矩阵          |
| TG-03        | applies only-if-cached to unavailable roots without network retrieval | 组合/大小写指令、412 与 404、相似或带值指令、本地存在与探测、无网络回源                     |
| TG-04        | applies raw negotiation consistently to the probe                     | 探测与普通块的协商拒绝策略一致                                                              |
| TG-05        | normalizes equivalent CIDv0/v1 representations and validators         | 等价 CID、规范化 `.raw` ETag 与条件匹配                                                     |
| TG-05、TG-08 | keeps GET and HEAD representation headers identical                   | GET/HEAD 表示形式元数据一致，HEAD 不读取完整响应体                                          |
| TG-08        | preserves raw bytes, representation headers and the empty probe       | 原始字节、Content-Length、安全响应头、CORS、immutable 缓存和空探测                          |

### 实现 subagent 的检查结果

以下命令由本任务唯一的实现 subagent 执行并报告通过：

```powershell
pnpm --filter @workspace/worker exec vitest run --config vitest.config.ts test/gateway.test.ts test/worker.test.ts
pnpm check
git --no-pager diff --check
```

- 针对性协议及 Worker 测试：41 项通过。
- 完整检查：release 23 项通过；Turborepo
  12/12 项成功，包括 lint、typecheck、test 和 build。
- 完整单元测试：contracts 2 项、web 37 项、worker 48 项通过。
- Worker 覆盖率：语句 96.40%、分支 94.01%、函数 100%、行 97.07%；未降低既有阈值。
- gateway 覆盖率全部为 100%；gateway-http 的分支覆盖率为 96.36%，其余三项为 100%。

### 主 agent 的独立真实客户端验证

主 agent 独立执行 `pnpm test:kubo`，退出码为 0。使用 Kubo v0.43.1 与 OpenSSL
3.5.9，在确认专用回环端口可用后运行；未访问生产存储，也未停止其他进程。

- 源节点已停止；上传的普通 DAG 包含 16 个区块、3,146,662 字节。
- 浏览器编码的目录 DAG 包含 18 个区块、3,146,769 字节。
- 三个独立冷仓库分别完成 cat、get 和浏览器目录 get，覆盖嵌套文件与空文件，字节/哈希比较通过。
- 观察到 58 个 HTTP/2 请求及 3 次探测。
- 普通 DAG 根 CID：`bafybeicq36tgkqgrveownipkwsxyjlbxchd6mwad43mxevhlrmpv66s24a`。
- 浏览器目录根 CID：`bafybeicqdzjxvvgyv32uxge37gxh4luvovifpsn67bfbx2e5wujqd7brzm`。
- 取回载荷 SHA-256：`3b89ad0914a53a4b3744a2f6516563ddc8cead1d12ba10cdb2f01946a91eb4d8`。

测试数据为随机内容，后续运行的 CID 和哈希会改变。主 agent 随后独立执行
`pnpm check`，退出码为 0：格式检查、23 项 release 测试、87 项工作区单元测试和 12/12 项 Turborepo 任务全部通过，Worker 覆盖率与上述结果一致。主 agent 的
`git diff --check` 也通过。

Silvermoon 的准确修订提交与验收由事件记录，不以本文件替代。

## 外部边界

本地模拟 R2、HTTP/2 代理和冷 Kubo 取回不能证明生产域名、真实 R2 或生产边缘配置合规。本次授权不包含生产部署，不以代理验收代替部署授权，也不将外部阶段标记为完成。
