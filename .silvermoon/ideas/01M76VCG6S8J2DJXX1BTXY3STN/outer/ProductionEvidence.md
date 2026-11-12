# 局部 CAR 与协商外部验收

本文件服务于 Deployment.md。用户明确授权父 Agent 全部门限审批和既有发布、Chrome 验证流程；没有授权生产数据库迁移、性能优化或 iteration
5/6 实施。准确 Inner revision `a30711fbb79a894efa08e016da89d0f727a03c6c`
已提交并批准。

## 发布及环境

| 项目               | 实测结果                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| CI                 | [43184962797](https://github.com/shazhou-ww/pinboard/actions/runs/43184962797)，Windows/Linux、Node 22/24 全部通过 |
| 发布 tag           | release-261112-4，annotated tag                                                                                    |
| 发布 commit        | b5ed45784b32f3b076f7709339e9f7c56ba022bf，已在 origin/main                                                         |
| 部署工作流         | [43185993906](https://github.com/shazhou-ww/pinboard/actions/runs/43185993906)，成功                               |
| Worker version     | 4f28f094-c7d9-4e16-87f0-c32b84a0134f                                                                               |
| 浏览器             | Chrome for Testing 157.0.8103.38                                                                                   |
| 实际域名及导航协议 | https://pinboard.shazhou.work，h3                                                                                  |
| 最终浏览器时间     | 2026-11-12T08:57:02.153Z                                                                                           |
| 专用目录 CID       | bafybeia6xaiy3udek67fkwik7psah2vruxmkxvunkgwirdlkth4x6zlsju                                                        |

CI 和部署工作流均完整执行项目检查，没有绕过失败作业或变更发布触发方式。仅发布应用和资源，未执行生产 SQL、schema 迁移或扩大存储限额。

## 浏览器与独立范围证明

真实已登录浏览器通过既有上传 API 导入独立构造的 UnixFS/DAG-CBOR
fixture，默认私有，匿名范围及条件读取返回 404。最终 123 条浏览器断言通过，13 份实际范围响应保存于
[BrowserSmoke.json](BrowserSmoke.json)，独立摘要、块集合与重建结果见
[OfflineVerification.json](OfflineVerification.json)。

多级文件内容为
`0abc1defghijkldefg`，含根及中间节点内联数据、共享叶和多个可跳过分支；所有请求带根目录到文件的证明。验证器独立解析原始 UnixFS
protobuf、按逻辑区间重建，不调用服务端范围解析或遍历函数。

| 请求                       | 独立重建内容       | CAR 中唯一块数（含目录证明） |
| -------------------------- | ------------------ | ---------------------------- |
| 5:8                        | defg               | 4                            |
| 2:10                       | bc1defghi          | 6                            |
| -5:*                       | ldefg              | 5                            |
| -999:2                     | 0ab                | 3                            |
| 16:999                     | fg                 | 3                            |
| 0:*                        | 0abc1defghijkldefg | 6                            |
| 4:4                        | 1                  | 3                            |
| 10:2                       | 空区间             | 2                            |
| 超过 Number 精度的反向区间 | 空区间             | 2                            |

逐项验证实际 CID 顺序、去重、原始块哈希和范围重建，非完整文件 CAR 后过滤。删除所需叶或替换其字节，独立验证器均拒绝。零长度、空文件、内联字节串、非字节 map 的忽略范围语义也通过；完全越界、错误语法、重复参数及非法 scope 均返回 400。

每个有效文件范围 GET/HEAD/304 的长度、表示 ETag、弱条件响应与无体 304 通过。合法 block/all 被 entity-bytes 覆盖，归一化范围得到一致 ETag；Content-Location 体现实际 entity
scope 和范围。范围并未切断 CAR section 或 raw 块，证明完整块覆盖所请求字节。

协商验证包括 format 优先但不静默忽略显式 CARv2 变体、query 覆盖媒体参数、dups=y 拒绝、质量值与具体 q=0、无匹配时 406；根 raw、all
scope、自定义完整 CAR 及带范围的空 identity 探针保持可用。公开专用 fixture 后匿名范围读取成功，清理后匿名读取恢复 404。

## 独立 Kubo 验证与明确兼容性限制

使用 SHA-512 与官方发布校验一致的 Kubo v0.43.1 Windows AMD64：

- 对另一个无中间内联数据的普通 UnixFS 文件，生产范围证明仅含目录、文件根和所选 raw 叶；全新离线 repo 导入该局部 CAR 后，
  `ipfs cat --offline --offset=3 --length=2 /ipfs/<root>/canonical` 返回准确的
  `de`，没有下载其他叶。
- 含中间内联数据的扩展 fixture 由独立 protobuf 解码器完整通过，但不能宣称 Kubo
  v0.43.1 对该布局兼容。第一次直接用它读取局部证明时，Kubo 返回
  `failed to fetch all nodes`，没有把该失败记为通过。
- 对照实验在另一个全新离线 repo 导入完整参考 DAG，Kubo 读取完整文件仍省略两个中间内联字节，得到
  `abcdefghijkldefg` 而非 `0abc1defghijkldefg`；同样的 offset=5/length=4 得到
  `fghi` 而非
  `defg`。因为完整源也出现相同偏差，不将其归因于网关丢失所需块。原始输出、错误码和普通布局成功结果均保存在独立验证 JSON 中。

UnixFS 规范的
[Data 条款](https://github.com/ipfs/specs/blob/b4ad54e3a8baa8a395c2d17b7eab123099efb228/src/unixfs.md#decodepbnodedatadata)
规定内联数据位于链接内容之前，偏移必须计入其长度；本次独立验证器据此重建并对照原始输入。该客户端差异是后续兼容性收口的明确输入，不因一次普通布局通过而宣称任意客户端均支持所有合法 UnixFS 布局。

## 存储读取及资源证据边界

Inner 的真实 workerd 测试对双 64 KiB 叶文件请求
`65536:65537`，GET、HEAD、304 均为 **2 次 R2 range GET、3 次 D1
prepare、65636 字节载荷**，仅读取根与右叶，左叶不读取。详细命令、fixture、损坏/缺块负例及临界 256
blocks / 32 MiB 全量回归见 Inner RangeEvidence.md。

这组计数来自隔离实际运行时，不冒充生产平台 traces。生产实际 CAR 的准确最小块集合和独立恢复证明了输出语义；服务器没有读取无关分支由本地计数绑定证明。没有使用减少响应体作为唯一收益证据。

大范围完整预检约两分钟的既有成本仍由独立性能 idea 跟踪，本轮未改超时、采用整包快路径、增加跨请求缓存或承诺整文件提速。HEAD/304 继续预检必要范围，新范围读取的取消、存储故障和授权边界由本地/真实运行时回归验证。

## 清理及交付范围

两次外部验证仅创建专用带 nonce
Pin，均正常 DELETE 移入回收站，并确认匿名读取恢复 404；不执行永久删除，不改变真实用户内容或导出凭据。独立 Kubo
repo 与浏览器专用页均清理，测试不接入生产专用上传入口。

本轮只交付 entity-bytes 和 CARv1/dfs/n 的准确协商；dups=y、CARv2、IPNS、普通 HTTP
Range、性能优化及全量一致性认证未实现。上述 Kubo 布局差异保持公开记录，不把本次成功泛化为完整 Trustless
Gateway 合规。
