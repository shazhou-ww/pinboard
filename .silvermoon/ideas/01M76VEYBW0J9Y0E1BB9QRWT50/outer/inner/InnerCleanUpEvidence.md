# iteration 5 收敛清理证据

## 候选范围与兼容

2026-11-13 按已接受 ideal `3300647f9a83064a503e2f8e5ac3fd24c4aaa197`
实施；基线 main
`f017d8a13bdbd6a808c9817998bece1afdb0c00a`。仅候选，不修改 iteration
1–4、历史失败证据或事件，不执行生产操作、提交或迁移。

- GET/HEAD 标准 CAR、CAR-only Accept、CAR probe、子路径（含尾随
  `/`）、scope/range/variant 及未知 query 均在授权后返回 406，不读取 R2。未知/私有不可读 CID 保持 404；无效凭证仍按认证规则处理。
- raw 显式 format 优先、Accept 质量/排除、弱/列表/通配 ETag、HEAD/304、identity
  probe、only-if-cached、private/no-store、安全头、公开 raw CORS、provider
  JSON/NDJSON、活跃 DAG member 授权与缩略图表示保留。 `access=v1`
  是已有缓存分区标记，必须保留，否则会损坏 Web 缩略图和 CLI 读取。重复 format 为 400；普通 HTTP
  Range 忽略并返回完整 200。
- `getCar` 索引命中仅查一次 manifest、一次整对象 R2 GET，返回原始流和
  `car:<object-key>:<size>`
  etag。缺失/截断索引对象为 503；不再编码或遍历。manifest 缺失仅检查根元数据：根存在则 503 并提示重新上传 CAR 或显式 pin；根不存在返回 null，由路由给 404。授权发生在读取前。
- legacy raw 与已索引但无自身归档的 sub-DAG
  member 仍可读取；其归档下载明确失败，不再静默聚合。现有 `POST /api/pins` / MCP
  `pinboard_pin` 或上传可显式准备归档；不删除记录、不做自动回填。
- Publication `prepareTarget`
  是已有显式写操作的准备步骤，不是下载入口：保留 legacy 目标完整性验证、归档创建和 GC
  fence，在该写方法中显式实施，不再依赖读取函数返回 Uint8Array 来隐式打包。所有 Publication 下载只读已存归档。此兼容调整保留既有 publication
  legacy promotion 与并发 GC 测试。

## 删除与调用方清点

仅删除以下六个动态网关专用文件，共 3,228 行：

| 文件                                         | 原行数 |
| -------------------------------------------- | -----: |
| `apps/worker/src/gateway-car.ts`             |    622 |
| `apps/worker/src/gateway-range.ts`           |    101 |
| `apps/worker/test/gateway-car.test.ts`       |  2,087 |
| `apps/worker/test/gateway-runtime.test.ts`   |    327 |
| `apps/worker/test/gateway-runtime-entry.ts`  |     59 |
| `apps/worker/test/gateway-scope-fixtures.ts` |     32 |

`gateway.ts` 不再引用动态协商、路径解析、遍历或 framing。 `gateway-http.ts`
删除仅为 CAR 提供的 media 参数匹配回调及无独立调用的 `acceptsMedia`
包装；保留 raw/image 公共解析。`storage.ts` 删除
`completeDag`/encode/hash 的读取回退，保留正常写入 encoder 和 etag。未添加/删除依赖；UnixFS
importer/exporter、DAG
codec、CAR 工具仍被上传、客户端编码、预览及原文件/ZIP 下载使用，不能移除。

| 调用方                                                   | 审计结论                                                                                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Web / preview descriptor                                 | 现有 `/ipfs/{cid}?access=v1` 图片与 raw 客户端读取继续有效；原文件/ZIP 下载不改                                                           |
| CLI `client.ts` / `retrieval.ts`                         | 使用 `/api/public/{cid}/car?access=v1`；验证 CAR 后在客户端重建，未使用动态路径/scope；无归档时现有错误传播，恢复路径已更新 `docs/cli.md` |
| MCP                                                      | block 读取与 Pin/upload 操作仍使用共享 raw/storage 路径；不依赖标准动态 CAR                                                               |
| `index.ts`                                               | 自有 CAR 下载直接调用 `getCar`，授权后无归档 503；原文件/ZIP 路由保持                                                                     |
| `publication-api.ts`                                     | 当前/固定修订 CAR 下载继续使用 `getCar.etag`；original 格式不改                                                                           |
| `publications.ts`                                        | 只有显式写准备 legacy 目标时建档；读方法没有聚合回退                                                                                      |
| `scripts/kubo-poc.mjs` / test PoC entry                  | 只用 raw probe/逐块读取；专用公开测试引用保留，无生产认证旁路                                                                             |
| `scripts/access-http-check.mjs`                          | 使用现有 raw/access 标记和自有 CAR API，不用被撤出路由                                                                                    |
| README、`docs/kubo.md`、`docs/storage.md`、`docs/cli.md` | 当前能力声明及 breaking compatibility 已同步；历史完成契约未改                                                                            |

## 已执行验证

- Worker targeted
  gateway/access/storage/publications：4 文件，84 通过、1 个未启用 Kubo 的条件测试跳过；追加独立客户端环境后 gateway/access/storage/publications/previews：5 文件，115 通过、零跳过。
- `pnpm test:kubo`（Kubo 0.43.1，现有本地 HTTP/2
  PoC）：源 daemon 已停止，三个冷 repo 分别 cat、get、browser-encoded
  get 全部字节一致；58 HTTP/2 请求、3 probes。源根
  `bafybeignmfprrmt4x2vh2hpn2zext57g4fqcb7izjtarrzqzizgsl6xvlu`，16 blocks /
  3,146,662 bytes；浏览器根
  `bafybeib2mkgq5bbmpprvnfxxnvp4bjorbqlqar5pqsyp6bf4vl6s2dzfoy`，18 blocks /
  3,146,769 bytes。payload SHA-256
  `08de483d2952815e1a39d64d12a6b2684f61f4f65adddd176ceee2e0004637a2`。
- `PINBOARD_TEST_KUBO=1`
  的存储测试独立导入已存 CAR，离线重建目录、多块文件与空文件；直接 archive
  bytes 与独立 CAR reader/哈希验证保留。
- 官方全功能网关套件未执行，不宣称完整认证；动态 CAR/path/scope/range 测试因能力撤出不再适用。历史联合 native/动态 CAR 内存失败仍成立，未应用诊断补丁，不宣称旧风险已解决或 180 秒/单 CAR 接纳目标通过。
- 最后追加 raw HTTP
  Range 与已索引无归档 member 回归后，定向 5 文件 116 通过、1 个默认关闭的 Kubo 条件测试跳过；Worker
  lint/typecheck 通过。
- `pnpm check` 完整通过：24 个 Turbo task；Worker
  18 文件、307 通过/1 个 Kubo 条件跳过，覆盖 statements 95.45%、branches
  90.72%、functions 97.64%、lines 96.59%。Web 347、CLI 162、encoding
  14、background
  34 个测试通过，CLI 两个既有条件测试跳过；CLI/background 离线打包安装测试通过。原有 preview
  memory 基线完整执行，其故障注入的 native
  grow 警告为预期输出，不降低断言。更新本证据与 ledger 后再运行完整检查，保证最终候选验证。
  `silvermoon check --worktree --audience agent`
  通过。格式化仅针对本轮文件。registry 观测为
  `https://mirrors.cloud.tencent.com/npm/`；无安装或 manifest 改动。

## 外部边界

当前生产 `release-261112-4`
仍是旧功能，候选不等于已发布。父会话审阅并拥有提交、同步、所有生命周期门禁、CI、GitHub
Actions 生产发布、Chrome CDP 19302 smoke。iteration 6
IPNS 未实施；任何必要纯新增 SQL 须先展示准确语句和影响并单独取得用户批准。Outer 条目保持未勾选。
