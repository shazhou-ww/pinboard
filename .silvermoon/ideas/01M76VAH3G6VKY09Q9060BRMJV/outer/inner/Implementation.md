# Implementation

## Steps

### I-S01: 实现范围感知的 DAG 遍历

复用读取与路径证明，保留真实路径终点，按 codec 区分 block、entity、all 和默认 all。统一累计证明与目标范围的唯一块，沿用有界预检及 dfs/n；本轮不启用整包归档快路径，不改变 raw
HEAD 或原有完整 CAR 导出。

`pathProof`
在同一个读取缓存和预算内保留 CID 或已解码的内联终值，扩展范围而不重新把请求根当作终点。UnixFS
entity 文件补齐数据；普通目录不展开，HAMT 使用只枚举名称/CID、读取分片而不判定子项类型的
`entries()`。all 对 DAG-PB 链接及 DAG-CBOR 编码键顺序进行深度优先遍历并去重。CAR 编码在预检成功后逐段发送 header、长度、CID 和原始载荷；Worker 使用 FixedLengthStream 保留实际 Content-Length，不再聚合第二份完整 CAR 缓冲。

### I-S02: 验证集合及故障边界

增加多块文件、普通及 HAMT 目录、共享子图、通用 IPLD 和内联 DAG-CBOR
fixture，覆盖默认值、范围 ETag、缺块、取消、清理竞争及资源边界。同步能力与 HEAD/304 读取成本文档，不把 32
MiB 载荷上限当作峰值内存保证。

测试及测量方法见
[ScopeEvidence.md](ScopeEvidence.md)：除了小 fixture，实际 workerd 加载完整应用并初始化 PDF/native
32 MiB 内存后，验证恰好 256 个唯一块、32 MiB 载荷、最大单块 2
MiB 的 GET、HEAD 和条件 GET。记录 D1/R2 读取成本及 V8
inspector 采样，不将本地测量替代生产并发或平台配额验收。

## Acceptance criteria

### I-AC01: 范围集合可独立证明

独立 CAR 解析与内容重建验证各 scope 的准确 CID 集合、路径证明、目录枚举及默认值。特别证明 entity 目录不读取子文件，内联 all 不递归包含块中的兄弟链接，默认 all 与显式 all 的表示及 ETag 一致；不能仅比较返回体大小。

证据入口为 `apps/worker/test/gateway-car.test.ts`
的独立 CAR/SHA-256校验、文件重建及删除/篡改反例，以及 `gateway-runtime.test.ts`
的真实 Worker 输出校验。

### I-AC02: 故障与资源限制不伪装成功

注入缺块、存储失败、取消与清理竞争，GET/HEAD/304 不把不完整范围报告为成功。验证证明与范围合计的 256
blocks / 32 MiB 及单块 2
MiB 边界，包括临界合法输入的内存和 D1/R2 可行性；不静默放宽限额或扩大授权。

分别验证唯一块数超限、总载荷多一字节、单块多一字节，以及证明和终点范围合并计费。临界合法 fixture 的具体读次数、framing 字节与采样结果保存在 ScopeEvidence.md。

### I-AC03: 最终候选通过完整检查

实现后最终候选通过 pnpm check，保留 raw、图片、block
scope 和自定义 CAR 回归。候选改变后重新验证，不用生命周期元数据检查代替代码检查；准备阶段不把计划或未执行的检查标记完成。
