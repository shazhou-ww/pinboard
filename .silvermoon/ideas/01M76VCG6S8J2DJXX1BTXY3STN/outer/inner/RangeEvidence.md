# 局部 CAR 的实现与证明

## 规范映射与明确选择

依据已接受的
[固定 Trustless Gateway 规范](https://github.com/ipfs/specs/blob/29b7640c6517a03852a5a7958a85e3f89657050a/src/http-gateways/trustless-gateway.md#entity-bytes-request-query-parameter)
及历史 Ideal 的 RangeSemantics.md，不修改 Ideal：

- 闭区间、负偏移、终点 `*`：BigInt 运算，不经 Number 截断。 `0005:0008` 与 `5:8`
  归一化；`-0` 等同 `0`。
- entity-bytes 隐含并覆盖合法 block/all；非法 scope 仍为 400。重复参数、错误编码、空端点、多区间、小数、指数及加号为 400。
- 部分越界取交集；非空实体可预检的完全越界为 400。空实体及显式终点解析后早于起点的区间只返回路径/终点证明。
  `from:*` 超过非空 EOF 是完全越界，不误作显式反向区间。
- raw 本身是字节序列，但 CID 验证单位仍为完整块。DAG-CBOR 的 codec 将 IPLD
  bytes 解码为字节串；其逻辑长度来自该 bytes 值，而非 CBOR 序列化长度。固定规范的连续字节实体规则因此同样适用于根或路径内联 bytes，证明仍是完整包含块。map/list/scalar/目录不是 bytes，忽略选择；HAMT 保持 entity 枚举。测试分别验证逻辑长度越界、内联 bytes 与 map，没有把任意 JavaScript 对象或序列化 CBOR 当作文件。
- 直接解析原始 UnixFS
  protobuf 的 filesize 与 blocksizes；已有 UnixFS.fileSize() 会重新求和并丢弃原始声明，不能用它验证虚假 filesize。元数据必须与 links 数量、内联长度、所选子节点实际长度一致；uint64 截断/溢出及所需元数据损坏为 503，逻辑文件超过 32
  MiB 为 413。不读取或认证未选子树内部的一致性。
- format 决定表示；合法显式 CAR offers 仍约束变体，对应 query 优先。例如
  `format=car` 加 `Accept: ...car;version=2` 为 406，增加 `car-version=1`
  后才可成功。为保留原有显式 format 行为，malformed
  Accept 在 format=car 下忽略，q 不否决显式 format；无 format 时严格解析质量与具体程度，具体 q=0 不被 wildcard 复活。没有显式 CAR
  media
  range 时，wildcard 保持既有 raw/图片基线及 raw 排除行为，不凭 wildcard 改为 CAR。进入 CAR 协商后，wildcard 可以接受与不支持的显式变体不同的受支持组合，但不能复活匹配的具体 q=0；不支持的显式变体不否定另一个实际接受的候选。所有输出仅 v1/dfs/n，没有静默转换为不受请求接受的变体。

## 独立验证与实际读取

`apps/worker/test/gateway-car.test.ts`
使用独立 CarReader 和 SHA-256 验证所有输出块、唯一 CID 与原始字节；独立 PB
fixture 解码器重建字节，不调用网关的范围解析、元数据解析、遍历或存储函数。同时将实际 R2
range
GET 的 offset/length 映射回存储索引 CID，逐一比较预期读取顺序，不只比较最终 CAR 大小。

18 字节 fixture 为 `0abc1defghijkldefg`：根含内联 `0`，中间文件节点含内联
`1`，叶分别为 `abc`、`defg`、`hijkl`，末尾再次引用共享
`defg`。所有文件请求还带一个 `/file` 路径祖先：

| 请求范围                      | 所选文件块（不含路径祖先）    | 实际唯一存储读取数（含祖先） |
| ----------------------------- | ----------------------------- | ---------------------------- |
| `5:8`                         | root、inner、defg             | 4                            |
| `2:10`                        | root、abc、inner、defg、hijkl | 6                            |
| `-5:*` / `-6:*`               | root、inner、hijkl、defg      | 5                            |
| `-999:2`                      | root、abc                     | 3                            |
| `16:999`                      | root、defg                    | 3                            |
| `0:*`                         | root、abc、inner、defg、hijkl | 6                            |
| `0:0` / 显式反向 / 大整数反向 | root                          | 2                            |
| `4:4`                         | root、inner                   | 3                            |

缺少无关 hijkl 分支时，`1:2`
的 GET/HEAD/304 成功；需要该分支的范围以及完整 scope 均为 503。实际所需块 digest 损坏、截短、索引故障、声明长度虚假、中间节点长度不符、错误 codec 均在响应头提交前失败。取消所需子块读取会取消并释放其存储 body。identity 叶从 CID 内嵌 bytes 验证，不读取存储且不产生 CAR 数据 section；probe 即使带范围也仅有 CAR
header。only-if-cached 保持授权缺根 412/普通 404、未知根/缺路径 404，存储故障不变为缓存命中。

真实 workerd 的双 64 KiB 叶文件请求
`65536:65537`：GET、HEAD、条件 GET/304 均实测 **3 次 D1 prepare、2 次 R2 range
GET、65,636 字节所读载荷**，CID 集合恰为 root 与右叶，不读取左叶。其测试独立校验 SHA-256、CID 顺序与返回的目标两字节。

原有初始化 PDF
arena 后的精确边界测试保留并通过：GET/HEAD/304 均为 257 次 D1、256 次 R2、33,554,432 字节；一次独立采样的已计 native
arena 总峰值为 108,529,733 字节，低于 128
MiB。这不是通用峰值保证或新的输出预算。

## 已执行验证

- `pnpm --filter @shazhou/pinboard-worker typecheck`
- `pnpm --filter @shazhou/pinboard-worker exec eslint src/gateway-car.ts src/gateway-http.ts src/gateway-range.ts src/gateway.ts test/gateway-car.test.ts test/gateway-runtime.test.ts --max-warnings=0`
- `pnpm --filter @shazhou/pinboard-worker exec vitest run --config vitest.config.ts test/gateway-car.test.ts test/gateway.test.ts test/gateway-runtime.test.ts`
  ：3 文件、53 测试通过。
- `pnpm --filter @shazhou/pinboard-worker exec vitest run --config vitest.config.ts test/gateway-runtime.test.ts --reporter=verbose --silent=false`
  ：2 测试通过，取得上述实际存储与 heap 证据。

- `pnpm check`
  完整通过；补充本节和 ledger 后再次运行同一命令，验证包含最终证据与清单的候选，退出码 0：release 校验 65 通过；Turborepo 的 lint/typecheck/test/build 共 24 个任务成功。worker 为 20 文件、340 通过、1 个既有 skip，覆盖率 statements
  95.52%、branches 91.53%、functions 97.17%、lines 96.55%；web 347、CLI
  162、contracts 13、encoding 14、background
  34 测试通过，CLI 另有 2 个既有 skip；两个离线打包安装测试各 1 通过。没有新增 skip、降低阈值、增加传输重试或修改依赖。
- `silvermoon check --worktree --audience agent`
  通过，仅证明生命周期快照有效；未替代项目检查，也未提交或记录 submit/accept。

## 保持的限制

无 IPNS、HTTP
Range、UnixFS 渲染、CARv2、dups=y 或整包快路径。授权、唯一块/载荷/单块预算与 payload-retaining 流式 framing 保持；不另建完整 CAR 缓冲区，不新增依赖、并发或跨请求缓存。大 scope 的逐块预检成本仍属于独立性能 idea，本轮不承诺整文件提速。此处仅为 Inner 本地证据，不声称已生产发布、完成父代理门限或 Chrome
smoke。
