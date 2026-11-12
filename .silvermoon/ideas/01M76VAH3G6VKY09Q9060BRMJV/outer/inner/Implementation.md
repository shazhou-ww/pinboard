# Implementation

## Steps

### I-S01: 实现范围感知的 DAG 遍历

复用读取与路径证明，按 codec 区分 block、entity、all 和默认 all；仅在归档内容与请求语义吻合时复用整包快路径。

### I-S02: 验证集合及故障边界

增加多块文件、普通及 HAMT 目录、共享子图和通用 IPLD
fixture，覆盖范围 ETag、缺块与资源限制，同步文档并运行 pnpm check。

## Acceptance criteria

### I-AC01: 范围集合可独立证明

独立 CAR 解析与内容重建验证各 scope 的实际 CID 集合、路径证明、目录枚举及默认值，不能仅比较返回体大小。

### I-AC02: 故障与资源限制不伪装成功

注入缺块、存储失败与清理竞争，客户端能判定不完整；授权和限额回归测试及 pnpm
check 通过。
