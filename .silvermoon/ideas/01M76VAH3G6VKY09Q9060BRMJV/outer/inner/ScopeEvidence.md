# 范围实现与本地证明

本文件服务于 Implementation.md，仅记录 Inner 的可复核证据，不代表生产发布或 Outer 验收。Ideal、已完成的 iteration
1/2 及事件日志未修改。

## 实现边界

- 复用 `gateway-car.ts` 的
  `pathProof`、读取缓存、规范化 CID 去重与有界读取；路径终值保留为实际 CID 或内联解码值，all 不重新从请求根递归。
- block 保留路径证明行为；entity 补齐 UnixFS 文件，普通目录只保留目录块；HAMT 的
  `entries()`
  只加载枚举分片，不为了判定条目类型读取子文件或子目录。测试对每次 R2 读取计数并与预期分片集合一致。
- all 在证明之后按 DAG-PB 链接顺序、DAG-CBOR 编码键顺序进行 DFS。重复链接只输出一次；CIDv0/v1 按规范化 CID 去重，输出保留原始 CID 版本和块字节。
- CARv1 header 和 block
  framing 单独编码，预检后的块载荷直接进入有背压的响应流。Worker 的 FixedLengthStream 保留实际 Content-Length；不再收集 CarWriter 输出再拼接整包，不使用已存储整包归档快路径。
- raw HEAD 元数据优化、图片选择、授权和自定义完整 CAR
  API 不改写。不增加 entity-bytes、协商变体、网络回源、IPNS、schema、依赖或符号链接路径能力。

## 独立集合与失败证明

命令：

```powershell
pnpm --filter @shazhou/pinboard-worker typecheck
pnpm --filter @shazhou/pinboard-worker exec eslint src/gateway-car.ts src/gateway.ts test/gateway-car.test.ts test/gateway-runtime.test.ts test/gateway-runtime-entry.ts test/gateway-scope-fixtures.ts --max-warnings=0
pnpm --filter @shazhou/pinboard-worker exec vitest run --config vitest.config.ts test/gateway-car.test.ts test/gateway-runtime.test.ts
```

2026-11-12 本地结果：typecheck、定向 lint 通过；2 个测试文件、27 个测试通过。已有 raw 协商矩阵中原先拒绝默认 CAR 的条目按本轮新增行为更新；不支持的 CARv2 仍保留拒绝/回退断言。单独执行
`pnpm --filter @shazhou/pinboard-worker exec vitest run --config vitest.config.ts test/gateway.test.ts`，15 个测试通过。测试来源：

- `gateway-car.test.ts`
  使用独立 CarReader 和 SHA-256 校验根、唯一 CID 顺序及字节；多块文件独立重建为 700000 字节，删除或篡改所需数据块会使离线验证失败。
- 普通目录包含子目录的 fixture，以及 60 条目的 HAMT
  fixture，按独立目录解码得到的集合验证，R2 读取数恰等于所需目录/分片数，不读取子项内容。
- 内联 `{selected: {...}, sibling: CID}`
  只跟随 selected 中的链接；内联标量不扩展。带整数键的 DAG-CBOR
  fixture 防止 JavaScript 对象枚举顺序被误当编码顺序。共享链接、CIDv0、多块 UnixFS 文件和非 UnixFS
  DAG-PB/IPLD entity 均有准确预期集合。
- 默认 all 与显式 all 的字节和 ETag 相同；即使载荷相同，不同 scope 的 ETag 也不同。identity 探针在三种 scope 下均只有 CAR
  header。
- GET、HEAD、条件请求均在成功前验证整个范围；必要子块缺失、损坏、indexed
  storage 故障及 root 读完后的清理竞争不能伪装成 200/304。未知/不可读 root、缺路径、授权但缺 root 的 only-if-cached 矩阵沿用已有边界。
- root 和后代读取期间的取消会取消存储 body；只读且无网络回源。entity-bytes、CARv2、重复输出等不支持组合仍拒绝。
- fixture 的实际载荷总和恰为 33554432 字节、唯一块数恰为 256、最大块恰为 2097152 字节。独立测试总载荷多一字节、单块多一字节、仅数量超限及证明与范围合并超限，均为 413。

## 实际 Worker 临界输入与成本

命令：

```powershell
pnpm --filter @shazhou/pinboard-worker exec vitest run --config vitest.config.ts test/gateway-runtime.test.ts --reporter=verbose --disableConsoleIntercept
```

2026-11-12 本地结果：1 个测试通过。测试经现有 Wrangler
dry-run 打包完整应用，在 Miniflare/workerd 中运行实际 `/ipfs/`
路由、D1 索引和 R2 range 读取；先实际渲染 PDF，验证 native
arena 已初始化为 33554432 字节，且无悬挂 session/window。随后在同一 Worker 中依次执行 GET、HEAD、条件 GET（304）。

| 请求     | 实际状态 | D1 语句 | R2 range GET | 块载荷字节 |
| -------- | -------- | ------- | ------------ | ---------- |
| GET      | 200      | 257     | 256          | 33554432   |
| HEAD     | 200      | 257     | 256          | 33554432   |
| 条件 GET | 304      | 257     | 256          | 33554432   |

257 条 D1 语句包括匿名公开 fixture 的一次授权查询与 256 次块定位；R2 只读取索引指定的 payload
range，不读取整包。GET 的独立 CAR 解析逐块校验 SHA-256、完整 CID 顺序及声明长度；CAR 总长为 33564475 字节，其中 framing 为 10043 字节，没有把 framing 计入 32
MiB 载荷预算。HEAD/304 没有响应体，但读取成本不减少。有 token/session、legacy 非索引块或其他授权上下文时，D1 成本可能增加。

### 内存测量及适用范围

使用同一用户 Worker 的 V8 inspector `Runtime.getHeapUsage`，在范围预检期间每 50
ms 采样，并在响应 drain 前再次采样。一次通过运行的记录：

- 已初始化基线：usedSize 13925324、totalSize 18395136、embedderHeapUsedSize
  257432、backingStorageSize 5645820 字节。
- 最大采样记录：usedSize 22422744、totalSize 30978048、embedderHeapUsedSize
  3575872、backingStorageSize 45536012 字节。
- 保守采样核算额外加上完整 native arena：totalSize + embedderHeapUsedSize +
  backingStorageSize + 33554432 = **113644364 字节，约 108.4
  MiB**。测试要求该核算值小于 128 MiB，并实际完成临界 GET/HEAD/304。

完整 `pnpm check` 再次运行该测试时的最大采样核算为 **119412326 字节，约 113.9
MiB**：totalSize 33075200、embedderHeapUsedSize 3832800、backingStorageSize
48949894，再加 native 33554432；三类请求均成功，读取成本与上表一致。

这证明该完整应用/native 初始化上下文下的临界合法 fixture 可完成，不是把 32
MiB 载荷当作峰值内存，也不是进程 RSS、精确峰值或并发隔离保证。50
ms 采样可能遗漏瞬时峰值，V8、Wasm 与 embedder 的统计口径也不是平台完整计费模型。本地 workerd 不替代生产 CPU、子请求配额及并发验收；目标环境须容纳本 fixture 每请求 257 次 D1 与 256 次 R2 操作，父 Agent 在 Outer 核查生产环境。全负载隔离仍属于后续迭代，未降低或放宽任何既有限额。

## 最终候选检查

独立 I-AC03 执行 `pnpm check`，结果全部通过：

- format:check 通过，release 验证 65 个测试通过。
- Turbo 的 lint、typecheck、test、build 共 24 个任务通过；Worker
  20 个测试文件，329 个测试通过、1 个既有测试跳过；CLI
  162 个测试通过、2 个既有测试跳过；Web 347、contracts 13、encoding
  14、背景组件 34 个测试通过。没有新增跳过项。
- Worker 覆盖率：statements 95.46%、branches 91.08%、functions 97.31%、lines
  96.52%，未调整任何门限。
- CLI 和背景组件的实际离线 tarball 安装验证分别 1 个测试通过。
- `git diff --check` 与 `silvermoon check --worktree --audience agent`
  均通过；后者只验证元数据，不代替代码检查。

写入本记录并更新 ledger 后再次运行同一 `pnpm check`
验证最终候选；后续候选改变仍须重新执行，不以生命周期状态或缓存外的口头说明代替检查。
