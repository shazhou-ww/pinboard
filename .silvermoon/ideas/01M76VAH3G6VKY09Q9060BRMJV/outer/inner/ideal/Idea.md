# 网关迭代 3：支持 block、entity 与 all 获取范围

## 问题

仅有路径证明和终点 block，不能恢复多块文件、枚举分片目录或下载完整子 DAG。

## 结果

标准 CAR 客户端按 dag-scope 选择可验证范围，省略参数时取得默认 all，且无需使用 Pinboard 专用导出 API。

## 边界

- 前置为
  [迭代 2](../../../../01M76V81QD1FFYDDGNDX97WA0M/outer/inner/ideal/Idea.md)
  完成；之后推进局部读取及 CAR 参数协商。
- 保持非递归及现有授权与资源限额；明确 raw、DAG-PB/UnixFS、DAG-CBOR 的 scope 语义及支持矩阵，不隐含支持任意 codec。
- 不含 entity-bytes 或 IPNS；存储中存在完整 CAR 不代表可以忽略请求范围、输出额外无关内容或绕过访问检查。

## 验收标准

- 三种 scope 的实际 block 集合与独立 fixture 预期相符；UnixFS
  entity 文件可完整重建，普通 IPLD entity 等价于 block，省略范围等价于 all。
- entity 目录可枚举，包括支持范围内的 HAMT 分片，但不递归下载子文件；all 能恢复终点完整子 DAG并保留路径证明。
- 共享子图、缺失子块、存储异常及清理竞争均有明确完整性语义；scope 专属 ETag 正确，处理不突破资源及权限边界。
