# DAG scope 外部验收证据

本文件服务于 Deployment.md。用户已授权本轮实施、父 Agent 门限审批及生产发布，未授权生产 schema 迁移或后续 iteration
4。准确 Inner revision `988dffaedc0c009a189a6dc94051e395a278eaed`
已提交并通过审批。

## 发布及环境

| 项目               | 实测结果                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| CI                 | [43170918878](https://github.com/shazhou-ww/pinboard/actions/runs/43170918878)，Windows/Linux、Node 22/24 全部通过 |
| 发布 tag           | release-261112-3，annotated tag                                                                                    |
| 发布 commit        | 62e84dd81527cac5f5ac154903b8fc0ba2aa74ba，已在 origin/main                                                         |
| 部署工作流         | [43172633415](https://github.com/shazhou-ww/pinboard/actions/runs/43172633415)，成功                               |
| Worker version     | 010b43d0-7592-4dfa-b864-90bfc0d0d4e8                                                                               |
| Chrome for Testing | 157.0.8103.38，CDP 127.0.0.1:19302                                                                                 |
| 实际域名及导航协议 | https://pinboard.shazhou.work，h3                                                                                  |

CI 首次 Windows/Node
22 作业发生本地连接 ECONNRESET，导致新测试取得 500；同一 commit 的失败作业重跑后通过，没有改测试、加重试逻辑或绕过门限。部署工作流再次执行完整项目检查后发布，没有生产 SQL 操作。

## 标准范围与独立重建

使用独立编码的带 nonce 专用 CAR，真实浏览器经已有登录会话上传并调用标准网关；不是通过服务端测试专用入口或存储控制面注入生产数据。

| 样本                        | 范围           | 实际 CAR / blocks                                    |
| --------------------------- | -------------- | ---------------------------------------------------- |
| 普通目录根                  | block / entity | 均为 206 bytes / 1 block，scope ETag 区分            |
| 普通目录根                  | all            | 700687 bytes / 7 blocks                              |
| nested 子目录               | entity         | 301 bytes / 2 blocks                                 |
| nested 子目录               | all            | 700614 bytes / 6 blocks，不包含根的兄弟文件          |
| nested/file.bin             | block          | 497 bytes / 3 blocks，仅路径证明及文件根             |
| nested/file.bin             | entity         | 700614 bytes / 6 blocks，恢复完整 700000 字节文件    |
| 60 条目的 HAMT 根           | entity         | 4212 bytes / 8 blocks，只有目录分片，无子文件块      |
| HAMT 根                     | all            | 8762 bytes / 68 blocks                               |
| DAG-CBOR /selected 内联对象 | all            | 277 bytes / 2 blocks，只包含所选链接，不包含兄弟子图 |
| DAG-CBOR /selected          | entity         | 203 bytes / 1 block                                  |
| DAG-CBOR 根                 | all            | 351 bytes / 3 blocks                                 |

浏览器完成 12 个 scope 场景，共 499 条断言（包含逐块摘要检查），结果见
[BrowserScopes.json](BrowserScopes.json)。每个场景验证准确 CID 集合、逐块 SHA-256、CARv1
dfs/n、Content-Length、HEAD 与条件命中 304；默认 all 与显式 all 的字节和 ETag 相同，不同 scope 的 ETag 区分。匿名不可读内容仍是 404，公开后可读；缺路径不能被通配验证器转为 304。entity-bytes 仍拒绝，旧的完整 CAR 导出、图片 WebP/raw 选择及 raw/CAR 探针保持可用。

独立客户端结果见 [OfflineVerification.json](OfflineVerification.json)：

- Kubo v0.43.1 官方 Windows
  AMD64 压缩包 SHA-512 与发布校验一致；使用全新离线 repo，禁止通过网络补齐所需块。
- 从生产实际 block 证明执行 offline resolve；从 entity CAR 执行 offline
  cat，恢复文件 SHA-256 为
  `4d9116157955c71ba4bd7f93f160162e77da5640b94efff808f84899c7716fa9`。
- 独立 CarReader/SHA-256/DAG-PB/DAG-CBOR 验证器枚举全部 60 个 HAMT 名称，确认子文件 CID 不在 entity 证明中；验证内联对象的选中链接存在、兄弟链接缺席。
- 删除或篡改路径中间块，独立验证器均拒绝。不是仅凭 HTTP
  200、体积减少或 CAR 可解析来判断成功。

浏览器证据保留短小原始证明；大文件 entity 的完整 base64 不重复入库，其精确 CID 集合、响应摘要和独立恢复哈希已持久化。

## 临界输入与真实成本

本地真实 workerd 已在同一完整应用的 PDF native arena 初始化后，验证恰好 256
blocks / 32 MiB 载荷 / 单块 2 MiB 的 GET、HEAD、304；257 次 D1 与 256 次 R2
range GET 的计数以及内存采样，详见 Inner ScopeEvidence.md。113.9
MiB 是保守采样核算，不是精确峰值、并发隔离或生产内存保证。

生产使用合法单次 CAR 上传能容纳的近界样本： **256 个唯一块、31
MiB 块载荷、最大单块 2 MiB**，CAR 为 32515899
bytes。没有为了上传归档 framing 而放宽 32
MiB 上传体上限。实际响应逐块 SHA-256 和准确 256 个 CID 全部验证，通过 HEAD、304 及默认 all 与显式 all 一致性检查；813 条断言通过，见
[BrowserBudget.json](BrowserBudget.json)。

| 请求         | 实际结果                                    | 浏览器端耗时 |
| ------------ | ------------------------------------------- | ------------ |
| GET all      | 200，32515899 bytes，256 个经过摘要验证的块 | 121295 ms    |
| HEAD all     | 200，无 body，长度及 ETag 与 GET 相同       | 111925 ms    |
| 条件 GET all | 304，无 body                                | 109184 ms    |

**这是明显的已知成本，不是低延迟保证。**
有界预检在 HEAD/304 前也会读取并验证全范围；生产近界请求约需两分钟，不能把条件命中描述为廉价查询。耗时是该浏览器、网络与部署环境的一次观测，不推断为纯 Worker
CPU，也不把本地 D1/R2 计数冒充生产平台 traces。当前不改用户选择的预检语义或限额；资源隔离、吞吐和性能优化仍需在后续迭代明确验证。

首次将所有场景连在同一浏览器脚本，因累计时间超过客户端脚本期限而中断；另一次 60 秒近界请求也超时。没有把它们算作通过。后续拆分普通范围与近界验证，明确延长单请求等待，保持网关和断言不变，最终完成上述完整字节与 HEAD/304 验证。被中断的专用 Pin 也已逐项清理。重新上传已公开 CID 会保留原可见性，因此重新生成 nonce 样本，没有把产品的可见性保留行为误判为新 Pin 默认策略失败。

## 取消、清理及边界

[BrowserCancellation.json](BrowserCancellation.json) 记录真实大范围请求在 250
ms 取消后取得 AbortError，之后 CAR 探针恢复成功；它只证明浏览器取消及恢复，不把该结果夸大为生产资源回收的量化证据。本地取消测试验证读取 body 的取消与释放。

所有测试只创建专用临时 Pin，正常 DELETE 移入回收站，并确认匿名读取恢复 404。最终按本次专用名称前缀核查，活动 Pin 数为零，见
[Cleanup.json](Cleanup.json)；按产品保留策略不是永久删除 R2 内容。未改用户既有内容或导出凭据。

本轮只交付非递归 block/entity/all/default all，保持 CARv1
dfs/n。没有实现 entity-bytes、IPNS、额外 CAR 变体或全量 gateway-conformance 认证；本次证据不支持宣称完整 Trustless
Gateway 协议已经完成。
