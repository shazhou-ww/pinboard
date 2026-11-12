# 联合渲染可行性证据

## 当前保存与阻塞状态

用户在诊断结束后选择先收敛独立性能优化方案，保留 iteration
5 阻塞，不实施生产改动。按其明确选择，实验测试完整补丁保存在会话目录
`gateway-05-memory-diagnostics.patch`，并保留命名 Git stash：
`b8ef125e2af76e19efcd674aa40d9a612092f789`。

补丁 SHA-256：
`1c5b3a767a792b554f9b0aa358d87f91b8200005d2ba0c8a783de029fe13727e`。它只包含 gateway-runtime-entry.ts 和 gateway-runtime.test.ts 的完整实验差异；工作区测试恢复到此前版本，主线不合入尚在失败的诊断实验。这不是修改断言取得通过，不撤销下文失败结果，也不表示资源验收完成。复现需在对应基线应用补丁，再运行下文记录命令。

目前尚未实现接纳/180 秒期限，也未执行官方一致性套件；所有实现验收项保持未完成，不能提交 submitInner 或发布。独立优化的第一阶段仅评估不必要载荷驻留及复制，详见
[最小改动评估](../../../../01M77BRB8PKDJT9A287FPPN618/outer/inner/ideal/MemoryPlan.md)。

## 结论与停止边界

2026-11-12，首项资源可行性检查未满足固定内存门槛，停止后续实现。未调整 32 MiB /
256 唯一块 / 单块 2 MiB、预览 UX 或 128
MiB 对照门槛；未实现 CAR 接纳、180 秒期限或官方一致性运行器。全部 I-* 项保持未完成，不能提交实现验收或发布。

同日最新授权仅允许计划补充和测试入口内的受控串行化，不授权生产实现或部署。追加三轮实验后，共槽候选仍未满足门槛：最大采样记账 220,377,692 字节，超出 86,159,964 字节。以下保留原始重叠失败及其完整诊断，不以串行化实验替换或删除。

这不是生产 OOM 证明：真实 workerd 中请求均为 200，但沿用现有运行时检查的采样记账超过 128
MiB，且没有真实峰值或目标账户配额证据。不能将偶然通过的采样当作联合内存安全证明。

## 可复现隔离实验

环境为 Windows、Node v24.11.1、pnpm 11.22.0、Wrangler
4.157.0，使用既有 Miniflare/workerd、完整应用入口、真实 native 解码模块和本地独立 D1/R2，兼容日期 2026-10-14。没有远程绑定、生产请求或基础设施变更。

```powershell
pnpm --filter @shazhou/pinboard-worker preview:assets
pnpm --filter @shazhou/pinboard-worker exec vitest run --config vitest.config.ts test/gateway-runtime.test.ts --reporter=verbose --disableConsoleIntercept
```

新增检查位于既有 `gateway-runtime.test.ts`，仅测试入口提供受控保持：

- 先独立运行同一个合法预览，确认它可以正常渲染。
- 原请求完成真实 CAR 预检后保持未读 Response，原请求保持存活，不将其 I/O 移交到另一请求；另一请求读取保持状态后才发起实际预览。不是提前初始化 arena，也不是四个请求串行假装并发。
- CAR 精确载荷 33,554,432 字节、256 唯一块，实际长度 33,564,475 字节；每次 257 次 D1
  prepare、256 次 R2 get。计数为本地绑定包装器口径，不是线上 traces。
- PDF 为既有原创
  `largeSecondPagePdf()`，5,760,921 字节，使用生产默认部分读取策略；图片为确定性的合法 1000×2000
  RGBA PNG，2,000,000 像素、8,004,508 字节，小于既有 8
  MiB 上限。两种预览分别与一个保持 CAR 重叠，不要求两个 native 渲染器同时运行。
- 渲染完成后才释放保持，完整读取 CAR，校验 256 块全部 SHA-256。保持期间未先把 CAR 传到测试客户端释放 Worker 内存。
- 每 10 ms 请求 inspector
  `Runtime.getHeapUsage`，并在预览完成、CAR 仍被持有时采样。同步 WASM 期间采样不保证可调度，V8 采样不是真实峰值。

## 实测结果

两次运行均保留既有 partial-range 与 exact-budget 检查，并加入联合渲染检查，没有跳过新测试。

| 运行   | 既有检查 | 联合检查                   | 最大采样记账 | 相对 134,217,728 字节 |
| ------ | -------- | -------------------------- | ------------ | --------------------- |
| 第一次 | 2 通过   | 通过，但余量不足以证明安全 | 133,898,689  | 仅余 319,039          |
| 第二次 | 2 通过   | 失败                       | 139,571,232  | 超出 5,353,504        |

第二次失败采样出现在 PDF 实际渲染成功后、CAR 仍被持有时：

| inspector 字段或保留项         | 字节        |
| ------------------------------ | ----------- |
| usedSize（仅记录，不重复相加） | 19,442,500  |
| totalSize                      | 33,619,968  |
| embedderHeapUsedSize           | 2,749,600   |
| backingStorageSize             | 69,647,232  |
| 固定 native arena              | 33,554,432  |
| 沿用既有公式的采样记账合计     | 139,571,232 |

公式为
`totalSize + embedderHeapUsedSize + backingStorageSize + native arena`。它是既有工程门槛估算，不是 Cloudflare 的内部精确记账，也不能将 V8 已分配堆全部解释为存活对象。测试不主动 GC、不清空合法缓存、不改变预览策略来换取通过。两个预览在两次运行均返回 200，CAR 块校验均完成。失败是资源安全验收，不能描述为已观测平台 1102。

## 追加：共享接纳候选与受控串行化

候选约束：CAR 与实际 PDF/图片生成共用一个 isolate-local 槽；CAR 忙时新预览走既有 defer/retry，生成忙时新 CAR
429 /
Retry-After。已生成图片、raw 和普通业务请求不接入该槽。CAR 占用延续到 EOF、取消或期限结束，不能只覆盖预检。此处仅讨论该候选，没有改动生产来源文件。

本地复现命令：

```powershell
pnpm --filter @shazhou/pinboard-worker preview:assets
pnpm --filter @shazhou/pinboard-worker exec vitest run --config vitest.config.ts test/gateway-runtime.test.ts -t "test-only shared admission" --reporter=verbose --disableConsoleIntercept
```

独立新建 workerd；沿用相同入口、兼容日期、32 MiB/256 唯一块/单块 2 MiB
CAR、实际 PDF/PNG 输入和原记账公式。测试入口 `/serial-*`
仅控制时间顺序，应用 CAR、PDF 解码和图片生成仍调用原实现。没有强制 GC、清理合法缓存、释放固定 native
arena、增加依赖、改 CPU/内存配额或改变原失败断言。

每轮分别对 PDF 和图片执行 EOF、取消两种路径，共三轮：

1. 在原请求内完成实际 CAR 预检，保持原 Response 未读，槽保持
   `car`。测量保留载荷；native `occupied: false`。新预览只收到测试控制标记
   `{deferred: true, fixtureOnly: true}`（202），不执行生成。该标记不是生产预览响应或真实队列重试证明。
2. 由原 CAR 请求自己读取原流直至 `done`（EOF），或调用原 reader 的
   `cancel`；完成后才清空槽。EOF 实际逐块读取 33,564,475 字节，取消路径不读取载荷。仅返回计数，不在 Worker 内额外聚合 32
   MiB CAR 副本；原重叠检查继续负责完整 CAR 的 SHA-256 校验。
3. 已确认槽空闲才开始同一 PDF/PNG 实际生成。生成前的可控屏障持有 `preview`
   槽，新 CAR 返回 429、`Retry-After: 1`；放开屏障后真正执行渲染、读取生成图片并确认槽空闲。屏障验证共槽拒绝顺序，不声称观察到同步 WASM 执行中途的请求交错。
4. 生成完成后不 GC、不重启 isolate，立即再次运行实际 CAR，同样持有到 EOF/取消，再采样。因此同一个实例同时覆盖 CAR→生成与生成→CAR，未通过更换实例消除历史内存。

共完成 24 个实际 CAR（12
EOF、12 取消）、12 次实际生成（PDF/图片各 6 次）、24 次预览忙标记和 12 次 CAR
429 验证。所有状态、读取长度及真实渲染成功断言均通过，最后的固定内存断言失败。受控任务没有逻辑重叠；**不能推导内存分配没有同时驻留**。取消为原请求内显式 reader 取消，不是浏览器断连；20 秒 fixture 安全定时器不等于验证生产 180 秒总期限，其到期路径本次未触发。

以下均为 inspector 字节记账；“前 CAR”指 CAR→生成，“后 CAR”指生成→CAR：

| 轮次 | 预览 | 释放 | 前 CAR 持有 | 前 CAR 释放后 | 生成完成后  | 后 CAR 持有 | 后 CAR 释放后 |
| ---- | ---- | ---- | ----------- | ------------- | ----------- | ----------- | ------------- |
| 1    | PDF  | EOF  | 104,234,964 | 111,632,363   | 72,494,620  | 108,727,944 | 112,993,271   |
| 1    | PDF  | 取消 | 117,734,650 | 117,734,650   | 123,870,748 | 119,752,788 | 119,752,788   |
| 1    | 图片 | EOF  | 116,640,902 | 122,942,263   | 153,891,171 | 148,919,822 | 138,983,478   |
| 1    | 图片 | 取消 | 193,188,298 | 193,188,298   | 168,332,644 | 154,958,000 | 154,967,800   |
| 2    | PDF  | EOF  | 175,722,446 | 154,939,141   | 161,344,016 | 193,645,962 | 211,332,962   |
| 2    | PDF  | 取消 | 172,191,856 | 172,196,104   | 146,045,501 | 203,064,223 | 203,064,223   |
| 2    | 图片 | EOF  | 140,379,224 | 149,976,025   | 178,800,219 | 169,363,990 | 165,930,887   |
| 2    | 图片 | 取消 | 212,851,034 | 212,851,034   | 186,063,544 | 169,232,578 | 169,232,578   |
| 3    | PDF  | EOF  | 190,051,096 | 152,741,481   | 158,868,756 | 196,488,122 | 209,246,454   |
| 3    | PDF  | 取消 | 167,328,976 | 167,328,976   | 173,717,362 | 198,811,831 | 198,816,079   |
| 3    | 图片 | EOF  | 168,883,018 | 165,610,536   | 195,759,514 | 155,622,680 | 195,915,322   |
| 3    | 图片 | 取消 | 220,367,068 | 220,373,732   | 219,019,830 | 165,232,750 | 165,232,750   |

该独立运行约 70 秒；基线记账 57,305,067 字节，每 10
ms 尝试采样，共 3,015 个返回样本。第一轮图片 EOF 生成完成后的显式样本已达 153,891,171 字节。最大样本位于第三轮图片取消路径、预览获准生成阶段（`3:image:cancel:render`）：

| 字段                 | 字节        |
| -------------------- | ----------- |
| usedSize（仅记录）   | 32,582,428  |
| totalSize            | 78,712,832  |
| embedderHeapUsedSize | 8,657,896   |
| backingStorageSize   | 99,452,532  |
| 固定 native arena    | 33,554,432  |
| 采样记账合计         | 220,377,692 |
| 固定门槛             | 134,217,728 |

生成后 native 状态均为 33,554,432 字节、`occupied: false`、`hasSession: false`、`windows: 0`。这直接显示槽空闲与 arena 常驻并存；EOF/取消后 backing
storage 和已分配 JS 堆也没有可依赖的立即归还保证。采样不能区分每个剩余分配究竟属于缓存、暂未 GC 的载荷还是运行时开销，不能将其全部断言为泄漏，也不能假设串行化自动消除。本地 workerd 完成所有请求，不是实际平台 OOM。同步 native 操作期间 inspector 未必可调度，采样不是峰值；公式仍为保守工程门槛，不是 Cloudflare 内部记账。

选择 `-t`
的独立运行显示 1 项失败、3 项未选中；它不是完整检查。原始联合重叠检查及原 139,571,232 字节失败证据均保留，常规运行不会跳过。原先 341 项 Worker 测试通过也不能证明此共槽候选安全。完整检查结果须与资源结论分开报告。

## 最后验证记录

```powershell
pnpm --filter @shazhou/pinboard-worker typecheck
pnpm --filter @shazhou/pinboard-worker lint
pnpm check
silvermoon check --worktree --audience agent
git --no-pager diff --check
```

Worker typecheck、修正测试 fixture 箭头函数写法后的 lint、Silvermoon worktree
snapshot 与 diff 空白检查通过；它们都不构成资源可行性通过。完整 `pnpm check`
执行约 3 分 39 秒，在 Worker
test 阶段失败：Worker 汇总 341 通过、1 失败、1 跳过，共 343 项，后续包验证没有本次通过结论。新串行化测试未被跳过，完成三轮后仍因同一 134,217,728 字节门槛失败。

完整运行共享已有检查的 isolate 历史，取得 3,140 个串行化样本，最大记账 249,104,494 字节（超出 114,886,766 字节）：
`totalSize=93,392,896`、`embedderHeapUsedSize=15,991,656`、`backingStorageSize=106,165,510`、固定 arena
33,554,432；`usedSize=53,185,316` 仅记录。峰值标签为
`3:pdf:eof:car-then-render`。它与上面的独立新建实例实验是不同运行，不混合样本或取较低值作为通过依据。

同次原始重叠测试实际执行并偶然通过，最大采样记账 133,750,393 字节，仅余 467,335 字节；不撤销原 139,571,232 字节失败，也不证明重叠安全。未放宽断言或设置跳过。证据补录后仅格式化文档，不改动已测测试逻辑。

## 平台约束复核

2026-11-12 读取官方
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/) 与
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)：

- Worker 内存为每 isolate 128 MB，含 JS 与 WASM；不是每请求独立预算。
- 父会话提供的既有只读账户证据为 account/worker `usage_model: standard`、Worker
  `limits: null`、兼容日期 2026-10-14、D1 元数据可读取；subscription API
  403。它不确认 Free/Paid，也不改变 128
  MiB 对照门槛。本轮未访问 cfg、凭据或云控制面。
- Free CPU 为 10 ms；Paid 默认 30 s、可配置上限 300 s。`wrangler.jsonc` 没有
  `limits.cpu_ms`，也不能从仓库推断实际账户计划。180
  s 是墙钟期限，不能推导 CPU 配额。
- HTTP 在客户端保持连接时无固定墙钟上限；断连或响应完成后关联任务可被取消，
  `waitUntil` 最多再延长 30 s。局部状态或注入 AbortSignal 不等于浏览器断连通知。
- 官方 D1 每次调用查询上限为 Free 50 / Paid
  1000；此合法 fixture 的 257 次独立查询超过 Free 上限。官方通用内服务子请求 Free
  1000 /
  Paid 默认 10000，不能用通用上限覆盖 D1 自己的 50 次限制。此处未采用批量优化，也没有购买计划的授权。
- 本地请求成功不证明生产 CPU、子请求或内存可用；正式继续前需要目标账户的只读配额证据及能解释联合峰值的方案。

## 后续状态

固定门槛没有放宽，局部成功不升级为平台可行性通过。当前可操作阻塞为联合内存安全未证实且已有超界采样，另有 D1
Free 计划不兼容且实际付费状态未确认。共槽候选在三轮受控串行化下仍不满足门槛，停止，不继续接纳、期限或官方套件实现。需要父会话向用户报告并返回方案讨论；不能自行引入 DO/D1 全局锁、降低合法输入上限、改变预览体验或合并独立性能优化。待定产品决策是是否另行授权解决保留内存后再复验此候选；当前没有可继续实施或发布的结论。

官方 gateway-conformance
v0.14.1 的 tag 独立核实、获取及逐项矩阵尚未执行，通过数为未测，不是 0 个适用测试，也不声明跳过或兼容成功。四并发三轮、真实客户端取消/180 秒总期限、健康和授权业务各 100 样本及 p95 均未执行，原因是前置可行性停止条件，不能填写通过结果。受控 reader 取消不替代这些验证；完整检查实际失败，`I-AC03`
仍保持未完成。

## 追加：内存归因诊断（不是门槛通过）

### 授权与实验边界

2026-11-12，本次只读调查生产源码和现有测试，在会话工作区运行独立诊断脚本；仓库中只补充本文。未改动测试入口、生产源码、配置、原断言或失败证据，未安装依赖，未查询真实云资源、部署、提交或发布。当前生产 release-261112-4 不变。

实际解析到的版本为 Miniflare `5.20261012.0-beta` → workerd
`1.20261012.1`，不是同时安装的另一个 workerd
`1.20261103.1`。沿用兼容日期、绑定类型、完整测试入口和既有 native
assets；所有 D1/R2 都是独立本地实例。会话复现入口：

```powershell
node "$env:USERPROFILE\.copilot\session-state\98515c8c-fc55-4414-b816-daa8f8a79f4a\files\memory-attribution.cjs"
```

脚本使用 Wrangler `deploy --dry-run` 打包**未修改的**
`test/gateway-runtime-entry.ts`，输出到会话目录；没有执行远程 deploy。诊断结果为同目录
`memory-attribution-results.json`，字段日志及脱敏、截短的 snapshot 大对象尺寸摘要为
`memory-attribution.log`。完整 heap
snapshot 仅在诊断进程内存中解析，没有保存或提交 heap
dump；生成的打包目录在实验后删除。

只连接本次 Miniflare 返回的 `core:user:` / `Worker` inspector target；全程
`Runtime.getIsolateId` 均为 `ca964e437549d769`。没有检查其他应用或用户进程。

与原测试不同的**诊断插桩**：

- 先使用 inspector 在此 isolate 分别保持、删除一个 32 MiB ArrayBuffer 和一个 32
  MiB WASM memory，后者实际写满；每项均诊断 GC 清理后再继续。
- 存入同一合法 32 MiB / 256 块 DAG，初始化真实 PDF 和 WebP 编码器。
- 同一 isolate 执行两轮，每轮 PDF/图片 ×
  EOF/取消，共 8 个实际 CAR 和 8 次实际生成，不重启 isolate。CAR 在原请求内保持、读取或取消；每个 EOF 均为 33,564,475 字节，取消均为 0 字节；全部生成返回 200。沿用实际大 PDF 和 1000×2000
  PNG，输出分别为 248 与 38,430 字节，没有伪造 native 渲染。
- 第一轮操作之间**不主动 GC**，只在持有、释放、生成及空闲 1 秒后顺序采样。第一轮前有上述诊断清理，不能把它称为完全未受 GC 干预的新实例验收。
- 第二轮在持有、释放、生成后分别取诊断 snapshot；没有原测试的 10
  ms 定时采样、Promise 样本数组或 Vitest 断言保留。此次不是对原测试峰值的配对 A/B 实验，不能用两次运行差值量化 sampler 的影响。
- `HeapProfiler.collectGarbage`
  首次尝试 30 秒无应答，已关闭该实例，没有假称成功。改用此 workerd 同步实现的
  `HeapProfiler.takeHeapSnapshot`；V8 的 snapshot 实现先
  `CollectAllAvailableGarbage(kHeapProfiler)`
  并完成 sweeping。下文称为「snapshot-GC」，**只是诊断，不是允许验收调用的 GC 手段**。

### 字段语义与 WASM 记账：未证实 32 MiB 重复计算，反而发现遗漏 16 MiB

已读取
[CDP Runtime 定义](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/js_protocol.pdl)
的 `getHeapUsage`：结果属于整个对应 isolate，不只某个 Runtime context。
`usedSize` 是已用 JS 堆，`totalSize`
是已分配 JS 堆，两者不是相同概念。并按安装版本的
[workerd V8 依赖声明](https://github.com/cloudflare/workerd/blob/v1.20261012.1/build/deps/v8.MODULE.bazel)
复核其 V8 `15.6.75` 的
[getHeapUsage 实现](https://github.com/v8/v8/blob/15.6.75/src/inspector/v8-runtime-agent-impl.cc)：

| CDP 字段             | 实现来源                                            | 不能据此推导的事项                                  |
| -------------------- | --------------------------------------------------- | --------------------------------------------------- |
| usedSize             | `HeapStatistics.used_heap_size()`                   | 不是所有 JS/C++/WASM 存活内存合计                   |
| totalSize            | `HeapStatistics.total_heap_size()`                  | 不是全部仍存活对象，也不是平台 RSS                  |
| embedderHeapUsedSize | `CppHeap.CollectStatistics(kBrief).used_size_bytes` | 不是任意 native 分配的总量                          |
| backingStorageSize   | `HeapStatistics.external_memory()`                  | 不保证覆盖全部 WASM backing、native code 或进程开销 |

受控分配得到：

| 操作                         | backingStorageSize 前 | 持有时     | 差值        |
| ---------------------------- | --------------------- | ---------- | ----------- |
| 普通 ArrayBuffer 32 MiB      | 5,403,539             | 38,957,971 | +33,554,432 |
| WASM memory 32 MiB，实际写满 | 5,403,539             | 5,403,539  | 0           |

因此**本安装版本、此 target 的**32 MiB arena 没有已经计入该 `backingStorageSize`
的证据，不能从原公式删掉它来「消除重复」。V8
[BackingStore::PerIsolateAccountingLength](https://github.com/v8/v8/blob/15.6.75/src/objects/backing-store.h)
也明确把 WASM backing 从普通 ArrayBuffer 路径排除，转由 WASM
memory 的 managed 对象处理；这里不能把其他 native/GC 压力记账与该 CDP 字段混同。

更重要的是，`preview-raster.ts:48–63` 还常驻一个**独立 16 MiB**
`WebAssembly.Memory({initial:256, maximum:256})`，不是 `preview-native.ts:3–19`
的 32 MiB 共用 decoder arena。初始化后的 live
snapshot 同时显示各一个 33,554,432 和 16,777,216 字节的
`system / JSArrayBufferData`；而 `backingStorageSize` 回到约 5.4
MiB。两者在末轮 snapshot 仍同时存在。这是原公式仅补加 32
MiB 时的**具体覆盖遗漏**，不是 16 MiB 泄漏证据。snapshot 还可见 WASM native
module/code 对象；没有证明这些开销与现有计数完整覆盖或可直接无重叠相加，所以仍不宣称总公式等于真实内存。

只把历史字段中的 `totalSize` 换为
`usedSize`，三个既有失败样本会分别变成125,393,764（原重叠）、174,247,288（独立串行化）、208,896,914（完整检查串行化）字节；这是解释字段差异的**假设计算**，没有改变原门槛或测试。后两项依旧超出 134,217,728，且还未计入上述独立 16
MiB encoder arena。不能据此撤销原始失败或宣布第一项通过。

### 同一 isolate：释放之后的分配可以回收，但自然空闲不保证立即回收

以下保留 `usedSize / totalSize / embedderHeapUsedSize / backingStorageSize`
原始字节；「原公式」始终为原四项相加（仍只补 32 MiB）：

| 阶段                                      | usedSize   | totalSize  | embedderHeapUsedSize | backingStorageSize | 原公式      |
| ----------------------------------------- | ---------- | ---------- | -------------------- | ------------------ | ----------- |
| 第一轮图片 EOF 后生成完成，自然           | 30,702,120 | 44,109,824 | 5,545,936            | 56,516,819         | 139,727,011 |
| 同阶段空闲 1 秒，自然                     | 30,702,120 | 44,109,824 | 5,545,936            | 56,516,819         | 139,727,011 |
| 第二轮 PDF EOF，CAR 持有，snapshot-GC 后  | 13,603,852 | 15,536,128 | 6,064                | 38,977,939         | 88,074,563  |
| 同 CAR EOF 完成，空闲 1 秒，未再次 GC     | 19,971,848 | 23,138,304 | 2,579,808            | 44,708,427         | 103,980,971 |
| 同 CAR EOF 完成，snapshot-GC 后           | 13,341,612 | 14,225,408 | 4,224                | 5,404,819          | 53,188,883  |
| 第二轮 PDF 取消，CAR 持有，snapshot-GC 后 | 13,718,412 | 15,273,984 | 6,064                | 38,977,939         | 87,812,419  |
| 同 CAR 取消后空闲 1 秒，未再次 GC         | 13,724,556 | 15,536,128 | 196,072              | 38,977,939         | 88,264,571  |
| 同 CAR 取消后，snapshot-GC 后             | 13,459,068 | 13,963,264 | 4,224                | 5,404,819          | 52,926,739  |
| 第二轮图片取消后生成完成，空闲 1 秒       | 14,774,960 | 18,157,568 | 248,320              | 22,816,633         | 74,776,953  |
| 同生成完成后，snapshot-GC 后              | 13,467,564 | 13,963,264 | 4,224                | 5,404,819          | 52,926,739  |

第二轮四组 PDF/图片、EOF/取消均有同样现象：持有时即使 snapshot-GC，约 32 MiB CAR
payload 仍存活；原请求 EOF/取消完成后 snapshot-GC， `backingStorageSize`
都回到**同一个 5,404,819 字节**。持有与释放的差值为 33,573,120 字节（含少量额外开销，不能把整个差值精确命名为 CAR
payload）。持有 snapshot 有 2 MiB 块及 254 个约 124
KiB 原始块；释放 snapshot 这些块消失，只剩固定 arenas、字体等大对象。末尾状态为
`slot:null`、`occupied:false`、`hasSession:false`、`windows:0`。

这证明本次受控路径中，CAR
EOF/取消及实际渲染后的大幅额外分配**不是都被永久强引用**，可以被完整 GC 回收；第一轮自然样本也非单调增长，说明期间发生了自然回收。但多个阶段空闲 1 秒四字段完全不变，取消本身不会同步降低 external 计数；逻辑串行并不保证下一请求到来前完成回收。诊断 GC 后低值不能覆盖自然样本，更不能用来修改验收或证明无泄漏、真实峰值低于限制。

### 逐项归因与未证实部分

- **明确保留到 EOF/取消的 CAR 数据**： `gateway-car.ts:160–199, 548–585`
  的 preflight Map/数组、generator 闭包和 stream 必须保留 payload；`clear()`
  会结束 generator 并清空数组，EOF/取消调用它。snapshot 前后证据支持本实验这两条路径最终释放强引用，不支持「CAR 清理代码完全没运行」的推断。没有覆盖浏览器断连或期限。
- **可产生暂时副本、但未证明持续泄漏的路径**： `gateway-car.ts:448–482`
  同时保存 R2 reader chunks 和复制后的每块 `Uint8Array`；`FixedLengthStream`
  另有 stream/pump 开销； `preview-image.ts:110–118` 明确复制输入并生成 decoded
  raster； `pdf-entry.ts:140–177` 的测试 PDF 来源先读取完整请求，再用 `slice`
  提供分段。这些分配与剩余垃圾/stream 状态可以共同解释 GC 前的额外 backing，但未给每一字节做 allocation
  stack 归属，不能把全部差值归咎于某一个复制点，也不能把测试 PDF 来源等同于生产 R2 的 source 行为。
- **合法常驻对象而非请求残留**：32 MiB decoder arena、16 MiB encoder
  arena、约 4,529,044 字节字体 buffer 和已加载 WASM module/runtime。字体由
  `preview-pdf.ts:106–109` 的 `canOwn:true` 共享； `preview-pdf.ts:379–381`
  删除当前 session 并清空 PdfData， `preview-pdf-data.ts:96`
  清空 windows，`preview-source.ts:127` 清空请求 cache。snapshot 与
  `hasSession/windows`
  支持没有在这些已完成操作中累积完整输入 cache；不保证所有 decoder/native 内部缓存均无增长。
- **测试端数组和 Response**： `gateway-runtime.test.ts:470–503`
  的样本 Promise 数组、`measurements`、preview fixture
  bytes 均在 Node/Vitest 端，不在被采样的 `core:user:` isolate。CDP pending
  Map 在回包/超时删除（`:113–143`），不存在源码可见的永久 CDP 回调 Map 增长。串行化返回的是计数 JSON，不是 32
  MiB CAR 副本； `gateway-runtime-entry.ts:82–102`
  在原请求内 drain/cancel、releaseLock，最后清空 fixture
  slot。测试持有已消费的客户端 Response 不等于必然保留 worker CAR blocks。现有
  `clone().text()` 也在测试端，不足以单独解释数十 MiB
  target 残留。未执行只改变 sampler 或 Response 生命周期的配对 A/B，因此不声称测试框架完全没有间接影响。
- **Miniflare proxy 边界**：已读安装版 `dist\src\index.js:120173–120190`：native
  proxy 确有强引用 heap，依赖 Node `FinalizationRegistry`
  并批量延迟释放；这是可能的跨边界保留机制。但
  `dispatchFetch`（`:135098–135147`）返回的是经 dispatcher 的 HTTP
  Response，不可直接套用「所有响应都存 proxy heap」的结论。本实验通过
  `getBindings/storeDag` 完成存储前后，user
  isolate 四字段完全相同；所以不能把本地 R2 backend、proxy/control
  isolates 或 Node
  fixture 内存直接算作此 target 的 payload。未采其他 isolates 的内存，也没有证明 proxy
  buffer 是原 220/249 MiB 样本的主因。

### 诊断结论和最小下一步建议

**最有证据的解释**：自然 GC/sweeping 未在请求边界完成，叠加已分配 JS 堆容量和正常暂存/复制，造成逻辑已释放后的分配同时驻留；不是已经证明的永久 CAR 引用泄漏。128
MiB 原门槛仍失败；没有平台 OOM、真实峰值或全面无泄漏证明。「32 MiB
arena 已在 backing 中重复相加」在本安装版本被受控实验反证；另一个 16
MiB 常驻 encoder arena 覆盖遗漏反而需要明确纠正。

建议父会话先报告该记账遗漏与 GC 前/后的区别；若后续获准，最小改动应先补齐
**测试诊断记账与自然采样证据**，分别记录 used/allocated、external、两个 arenas 和未覆盖 native 开销，而不是删掉 32
MiB、改用 usedSize、强制 GC、跳过失败项或立即重构产品。未证实需要修改 CAR
`clear()`；没有获得生产代码修复授权，本轮不实施任何下一步修改。既有 139,571,232
/ 220,377,692 / 249,104,494 字节失败证据与 `pnpm check`
341 通过、1 失败、1 跳过全部保留，不重新标成通过。

## 追加：双 arena 测试记账与全自然复测（仍失败）

### 本轮范围及方法

2026-11-12，本轮只修改 `test/gateway-runtime-entry.ts`、
`test/gateway-runtime.test.ts`
和本文诊断追加内容。生产源码、配置、依赖、部署、Implementation/Deployment 的既有内容及原始失败证据未修改，没有提交、发布或云资源调用。

测试入口用 `WebAssembly.Memory`
构造器 Proxy 观察实际分配，以 WeakRef 记录，不额外初始化或强引用 arena。源码中只有两个对应构造点：decoder 的
`initial=maximum=512`、encoder 的 `initial=maximum=256`；其他观察到的 WASM
memory 单独列出。CDP 使用本次 Miniflare 的 inspector 返回的执行 context，只读取自有 synthetic
Worker 的 `Runtime.getHeapUsage`、 `Runtime.getIsolateId` 和测试 arena
getter；没有 HeapProfiler、heap
snapshot、显式 GC、预先 GC 校准或等待强制回收。没有保存原始 heap dump。

每次样本分别保留：

- `usedSize`：已用 JS heap；`totalSize`：已分配 JS
  heap，不能解释为全部存活对象。
- `backingStorageSize`：CDP external；`embedderHeapUsedSize`：embedder used。
- `decoderArenaBytes`、`encoderArenaBytes`、`otherObservedWasmBytes`：实际观察到的 arena 字节。
- `untrackedNativeBytes: null`：没有测出而不是零；WASM
  code/module、allocator 及其他 native 开销仍未独立量化，不能保证与其他项完全不重叠。

一致的保守比较现在为：

```text
totalSize + backingStorageSize + embedderHeapUsedSize
  + decoderArenaBytes + encoderArenaBytes + otherObservedWasmBytes
```

门槛仍为 **134,217,728 字节（128 MiB）**，不改用 used
heap、不减去 decoder，不改变合法 CAR 预算、fixture 或预览策略。两 arena 初始化后显式合计
**50,331,648 字节（32 + 16 MiB）**。新样本同时记录历史口径
`totalSize + backingStorageSize + embedderHeapUsedSize + 33,554,432`，仅用于对照；历史 139,571,232
/ 220,377,692 /
249,104,494 字节及其原公式原样保留。新公式不是平台精确内存、RSS 或真实峰值，也未量化遗漏 native 开销的上界。

heap 与 arena 是顺序 CDP 读取，不是原子快照；10 ms sampler 及额外 inspector
getter 也会扰动时序。本轮不是旧插桩的配对 A/B，不能用前后差值衡量修复或 sampler 的影响。

### lazy 初始化的实际状态

最终独立串行化实例 `ffb4c66fd6af013b` 起点、第一份 CAR 持有/EOF 释放、第一次
`before-render` 时，decoder 和 encoder 均为
**0**。第一次真实 PDF 生成完成后分别为 **33,554,432 /
16,777,216**，之后保留此状态。因此 encoder
**不是模块加载即分配**；本路径在首次需要实际编码时 lazy 分配。源码
`preview-raster.ts:50–63` 与观察一致：`encoder()`
首次调用创建 memory，后续复用。没有声称采样能定位构造器内部的精确时间或证明所有错误路径均完成编码器初始化。

同实例的第一次生成后样本： `usedSize=14,908,760`、`totalSize=27,594,752`、
`embedderHeapUsedSize=349,344`、`backingStorageSize=11,531,127`，两 arena 为 50,331,648，保守比较为
**89,806,871** 字节。不能把这个单个低样本替代随后更高的自然样本。

### 最终独立串行化结果

三周期均在同一个实例完成，开始/结束 isolate ID 均为
`ffb4c66fd6af013b`，无重启或自然样本之间的强制回收。每周期 PDF/图片 ×
EOF/cancel，每组保留原来的 CAR→render→CAR 次序，共
**24 份实际 CAR、12 次实际生成**。每份 CAR 均记录并断言
`d1=257 / r2=256 / payload=33,554,432`，
`contentLength=33,564,475`；12 次 EOF 各 drain
33,564,475 字节，12 次取消各 drain 0 字节。所有逻辑槽释放后均为 `slot:null`，
`lastSerialRelease`
与 EOF/cancel 一致，生成期间的 CAR 拒绝和 CAR 持有期间的 preview
deferred 断言保留。

全部生成返回 200，PDF 输出每次 248 字节，图片每次 38,430 字节；新增 RIFF/WEBP
signature 和 RIFF 长度断言，不只检查非空。它不是完整解码或视觉正确性证明。每次生成后的 native 状态均为
`occupied:false / hasSession:false / windows:0`。

以下为各次生成完成的原始字段。每行 decoder/encoder/other WASM 均为 33,554,432 /
16,777,216 / 0；未量化 native 均为 null。

| 周期 | 预览 | CAR 操作 | usedSize   | totalSize  | embedderHeapUsedSize | backingStorageSize | 双 arena 比较 |
| ---- | ---- | -------- | ---------- | ---------- | -------------------- | ------------------ | ------------- |
| 1    | PDF  | EOF      | 14,908,760 | 27,594,752 | 349,344              | 11,531,127         | 89,806,871    |
| 1    | PDF  | cancel   | 20,181,704 | 36,507,648 | 1,318,928            | 56,522,632         | 144,680,856   |
| 1    | 图片 | EOF      | 25,168,472 | 61,149,184 | 5,545,840            | 56,516,819         | 173,543,491   |
| 1    | 图片 | cancel   | 17,349,448 | 59,838,464 | 888,880              | 55,948,633         | 167,007,625   |
| 2    | PDF  | EOF      | 21,939,992 | 57,217,024 | 1,586,504            | 59,261,360         | 168,396,536   |
| 2    | PDF  | cancel   | 26,065,964 | 59,838,464 | 3,556,592            | 45,231,189         | 158,957,893   |
| 2    | 图片 | EOF      | 51,859,768 | 70,062,080 | 8,769,744            | 115,236,585        | 244,400,057   |
| 2    | 图片 | cancel   | 34,753,264 | 69,275,648 | 996,944              | 72,137,824         | 192,742,064   |
| 3    | PDF  | EOF      | 29,155,312 | 67,440,640 | 5,713,008            | 45,232,280         | 168,717,576   |
| 3    | PDF  | cancel   | 33,307,312 | 69,799,936 | 5,736,768            | 88,135,489         | 214,003,841   |
| 3    | 图片 | EOF      | 35,007,112 | 80,809,984 | 1,396,888            | 75,326,783         | 207,865,303   |
| 3    | 图片 | cancel   | 37,738,816 | 78,974,976 | 3,471,248            | 64,521,269         | 197,299,141   |

共 **3,248 个样本**；最大比较 **255,866,756 字节**，超出门槛
**121,649,028 字节**，位于 `3:image:eof:render-then-car`：

| 字段                         | 字节        |
| ---------------------------- | ----------- |
| usedSize（独立报告，不相加） | 37,662,540  |
| totalSize                    | 85,266,432  |
| embedderHeapUsedSize         | 9,074,232   |
| backingStorageSize           | 111,194,444 |
| decoderArenaBytes            | 33,554,432  |
| encoderArenaBytes            | 16,777,216  |
| otherObservedWasmBytes       | 0           |
| 未量化 native                | null        |
| 历史单 arena 口径，同一样本  | 239,089,540 |
| 双 arena 比较                | 255,866,756 |

原始日志保留每组 before/held/released/beforeRender/afterRender 的所有上述字段、CAR
read
cost、响应计数及逻辑释放状态。取消后的即时 backing 在每组均与该次 held 样本相同；EOF 后可能升也可能降。例如第一份 CAR
EOF 为 42,520,606 → 45,612,669，第二周期第一份 PDF EOF 为 90,134,008 →
53,134,085。逻辑释放不等于同步自然回收；既不是永久泄漏证明，也不是低于真实平台内存限制的证明。

### 独立 overlap control

另一全新自有 isolate 开始/结束均为
`866579fc84cd907`，起点两 arena 均为 0。沿用实际大 PDF 和 1000×2000
PNG；CAR 在原请求保持未读，预览实际生成；预览均 200，随后完整读取每份 CAR，256 块全部逐块 SHA-256 校验通过。每份 CAR
read cost 与上节一致。

自然最大样本为 **144,333,537 字节**，超出门槛 **10,115,809 字节**：
`usedSize=20,256,244`、`totalSize=36,245,504`、
`embedderHeapUsedSize=1,934,656`、`backingStorageSize=55,821,729`，decoder/encoder/other
WASM 为 33,554,432 / 16,777,216 /
0，未量化 native 为 null。同一样本历史单 arena 口径为
**127,556,321**，但补齐 encoder 后失败；没有据旧口径宣称通过。

### 复现命令、日志与停止边界

从仓库根执行：

```powershell
pnpm --dir apps\worker exec vitest run --config vitest.config.ts test/gateway-runtime.test.ts -t 'measures test-only shared admission'
pnpm --dir apps\worker exec vitest run --config vitest.config.ts test/gateway-runtime.test.ts -t 'measures actual previews while one exact-budget CAR remains unread'
pnpm --filter @shazhou/pinboard-worker typecheck
pnpm exec eslint apps\worker\test\gateway-runtime-entry.ts apps\worker\test\gateway-runtime.test.ts --max-warnings=0
pnpm exec prettier --check apps\worker\test\gateway-runtime-entry.ts apps\worker\test\gateway-runtime.test.ts
```

最终两次 runtime 命令均以 exit 1 **仅在原 128 MiB 断言失败**；各显示 1 failed /
3 skipped，3 项是 `-t`
选择未执行，不是新增 skip 或改绿。类型、定向 lint 和格式检查通过。

另执行仓库要求的 `pnpm check`，exit 1；Worker 为 **339 passed / 3 failed / 1
skipped**（20 个文件中 19 passed / 1 failed），Turbo 为 23 successful / 24
total（20 cached）。三个失败均为本文件原有 128
MiB 断言，未新增 skip，没有把原来通过的单 arena 结果维持为假通过。完整检查共用的实例 ID 为
`bd8af44af6b352cd`，其历史与独立定向实例不同，不能混作同一组重复样本：

| 检查场景             | usedSize   | totalSize  | embedderHeapUsedSize | backingStorageSize | 历史单 arena 比较 | 双 arena 比较 |
| -------------------- | ---------- | ---------- | -------------------- | ------------------ | ----------------- | ------------- |
| exact-budget         | 22,839,684 | 31,264,768 | 2,257,880            | 59,058,799         | 126,135,879       | 142,913,095   |
| overlap              | 24,825,920 | 36,507,648 | 2,260,576            | 56,516,761         | 128,839,417       | 145,616,633   |
| serial（3,370 样本） | 52,621,708 | 77,664,256 | 9,414,120            | 104,919,288        | 225,552,096       | 242,329,312   |

三行 decoder/encoder/other WASM 均为 33,554,432 / 16,777,216 /
0，未量化 native 均为 null；serial 最大样本阶段为
`2:image:cancel:render`。这次失败后没有修改源码以追求通过。没有声称完整
`pnpm check` 成功或后续 CLI/background
packaging 检查已执行；它们在失败的 Turbo 阶段之后。

完整日志存于会话目录
`C:\Users\leescott.REDMOND\.copilot\session-state\98515c8c-fc55-4414-b816-daa8f8a79f4a\files`：
`natural-memory-serial-verified.log`、`natural-memory-overlap-verified.log`、
`natural-memory-pnpm-check.log`。所有早期尝试也保留：`natural-memory-serial.log`、
`natural-memory-serial-retry.log`（default context 错误）、
`natural-memory-serial-context.log`（新增诊断误入 native 状态断言，已只修测试）、
`natural-memory-serial-final.log`（完整三周期，245,594,827 字节失败）、
`natural-memory-overlap-final.log`（143,555,353 字节失败）。没有将错误尝试或较低值当作通过。

**停止**：本轮证实 encoder
lazy 分配及原记账遗漏，且补齐后自然串行化和 overlap 资源门槛仍失败；没有平台 OOM、精确平台峰值或全面无泄漏证明。不实施 shared
CAR/native preview
gate，不改生产清理代码，不降低预算/门槛。下一最小决策是向用户报告此失败并维持未接受状态；任何进一步实验或源码修改应另行授权。
