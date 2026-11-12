# Implementation

## Steps

### I-S01: 实现实体范围与 CAR 变体

复用路径与 scope 遍历，以 BigInt 解析闭区间；entity-bytes 优先隐含 entity。按 CID 校验后的 UnixFS 原始 filesize、内联 data 长度与 blocksizes，非递归定位所需子树；检查所选子节点实际逻辑长度，保留共享块单次读取、路径证明、既有限额与流取消。部分越界取交集；可预检确认的非空完全越界返回 400；空文件及显式反向区间保留 block 证明。raw 与 DAG-CBOR 字节串使用完整验证块，目录及其他非字节实体保持 entity 行为。

只输出 CARv1/dfs/n。显式 format 优先决定表示，但合法 CAR 媒体参数仍约束变体，对应 query 可以覆盖；无 format 时按质量和具体程度选择受支持候选，落实 q=0 排除。返回实际 Content-Location、有效 scope 与归一化请求范围的 ETag，不扩展变体、整包快路径、并发或跨请求缓存优化。历史 Ideal 授权文字不改动。

### I-S02: 验证最小集合和协商边界

增加独立 CarReader/SHA-256、路径验证与 fixture 元数据解码/范围重建，逐项检查精确 CID/DFS 集合及实际 R2 索引范围读取集合。覆盖负偏移、跨块、超大偏移、根/中间内联 data、空 raw/分块文件、非字节实体、HAMT、identity 排除、HEAD/304、所需与无关缺块、错误元数据和取消；补充真实 workerd 局部读取测量，保留初始化 PDF
arena 后的 256 块/32 MiB 边界验收。同步 README 与 Kubo 支持说明。

## Acceptance criteria

### I-AC01: 局部读取精确且可验证

用跨块、负偏移、越界、空实体及目录 fixture，独立检查返回 CID 集合、重建字节及实际读取集合，证明未先下载完整文件再过滤。删除或篡改所需块会失败，不以传输变小代替正确性。固定规范映射、读取测量、命令及局限见
[RangeEvidence.md](RangeEvidence.md)。

### I-AC02: 协商与表示一致

逐项验证 query/header 优先级、质量及具体程度、q=0 排除、引号参数、响应参数、dfs/n、范围 ETag、Content-Location 和条件请求；dups=y、CARv2 等不支持变体明确失败。显式 raw、图片默认值、wildcard 和已有 scope 有回归矩阵；新增按质量选择而非一律偏好 CAR 的变化明确记入英文文档。

### I-AC03: 最终候选通过完整检查

最终候选运行并通过
`pnpm check`；候选内容、格式或 ledger 变化后重新执行，且仅在最终检查通过时保持对应 ledger 完成状态，不以生命周期检查或计划代替代码验证。
