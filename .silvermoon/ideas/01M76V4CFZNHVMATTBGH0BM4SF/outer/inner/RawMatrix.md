# Raw 行为与验证矩阵

本文件服务于 Implementation.md，不扩展独立验收范围。

## 规范基准

- [Trustless Gateway，29b7640c6517](https://github.com/ipfs/specs/blob/29b7640c6517a03852a5a7958a85e3f89657050a/src/http-gateways/trustless-gateway.md)：raw 为 MUST，CAR/IPNS
  record 为 SHOULD；only-if-cached 缺失返回 412 为 SHOULD。
- [Path Gateway，46978c95955e](https://github.com/ipfs/specs/blob/46978c95955e252b23ddae98d6e5cd6e37853c9a/src/http-gateways/path-gateway.md)：条件命中 304 无 payload；无尾斜杠根路径的 Service-Worker:
  script 请求 MUST 返回 400。

本轮保留现有授权策略，明确记录 only-if-cached 推荐行为的适用边界；不把 raw 基线扩大为全功能网关，也不以公开私有内容来换取一致性测试通过。

## 处理顺序与状态

| 场景                                      | GET/HEAD 结果                                            | 验证依据                        |
| ----------------------------------------- | -------------------------------------------------------- | ------------------------------- |
| 无尾斜杠根路径携带 Service-Worker: script | 无论身份、存在性、表示或条件头均为 400；不读取内容       | access.test.ts 的根注册测试     |
| CID 格式错误                              | 400；根注册请求仍适用前一规则                            | 既有 Worker 输入校验测试        |
| 无效 Bearer 或受限凭证                    | 保持既有 401/403；不回退匿名成功                         | access.test.ts                  |
| 未知或当前身份无权访问 CID                | 404，包括 only-if-cached 与匹配条件头；不访问块存储      | access.test.ts、gateway.test.ts |
| 有可读引用但实际 block 不存在             | 普通请求 404；only-if-cached 为 412；不回源              | access.test.ts                  |
| 有索引的 CAR 对象丢失、截断或范围异常     | 503，不变为 404、412 或 304                              | 既有 storage.test.ts            |
| D1/R2 服务故障                            | 显式错误；不伪装成缺块或缓存命中                         | access.test.ts、gateway.test.ts |
| 可读 raw block                            | GET 原字节；HEAD 无 body 且表示头相同                    | gateway.test.ts                 |
| 可读 raw block 的有效条件命中             | 确认可用后 304，无 body；weak/list/* 按现有规则          | gateway.test.ts                 |
| bafkqaaa                                  | 无需身份；显式 raw GET/HEAD 为 200、长度 0，条件命中 304 | gateway.test.ts                 |

Service-Worker 拒绝规则与存在性无关，因此可在授权前安全执行。其他内容响应在授权后才协商表示、查存储或处理条件命中；无权读取 CID 不能通过 412 或 304 暴露其可用性。没有新增块下载时的服务器端重哈希，客户端仍须校验 CID。

## 表示边界

- 显式 format=raw 优先于 Accept，返回 raw 媒体类型、附件及 `.raw` ETag。
- 无 format 时保持现有 Accept 解析和 raw 优先策略；不引入图片与 raw 之间新的权重排序规则。
- 缩略图未显式选择 raw 时继续支持 WebP，包括缺省 Accept；其字节本身匹配缩略图 CID，不是读取时转码。
- WebP 使用 `.webp` ETag；它不能命中 raw 表示的条件响应。缩略图 URL 保持不变。
- 既有非图片请求缺少选择器仍为 400；不支持的格式为 406，格式错误 Accept 为 400，均受前述授权顺序约束。
- 保持 private/no-store 与安全头；未增加跨站 Cookie、私有内容 CORS 授权或预检支持。

## 本轮与后续边界

本轮仅新增根注册拒绝，其他矩阵行为以文档准确声明和回归测试收口。CAR、路径、scope、entity-bytes、IPNS、普通 HTTP
Range 及完整浏览器跨源兼容性分别属于后续构想。独立 Kubo/TLS/HTTP2 检索属于本轮 Outer 验证，不以源码测试代替外部互操作，也不在 Inner 验收前执行生产部署。
