# 能力收敛范围与迁移边界

2026-11-13 用户明确将 iteration
5 改为删除不做的已实现能力、清理代码、收敛到稳定范围。本文取代此前动态 CAR 运行保障方案；旧方案保存在 Inner
HistoricalConformanceBudget.md，失败证据不删除。本次更新契约，不等同已经执行删除、完成实现或获得新的生产部署授权。

## 保留的范围

- `/ipfs/{cid}?format=raw` 的单块 GET/HEAD、Accept 选择及 raw identity probe。
- 授权优先、存储可用性检查、表示 ETag、条件请求、安全头和必要公开 CORS；不新增私有跨站 Cookie 访问，不弱化私有内容隐藏。
- `/routing/v1/providers/{cid}` 的本地 HTTP provider discovery。
- 已存完整 CAR 的直接流式导出，继续明确是 Pinboard 扩展，不为了标准 CAR 协商再次引入路径、scope 或现场聚合。
- 原有缩略图表示、业务管理和预览扩展保持；IPNS Publication 标准读取由 iteration
  6 负责，未实现前不宣称支持。

## 删除的实现和承诺

- 服务端 UnixFS/IPLD 子路径定位、路径证明 CAR、普通及 HAMT 目录枚举。
- 标准动态 CAR 根 block 包装、entity/all 遍历与 entity-bytes 范围选择。
- 仅服务上述能力的格式变体协商、Content-Location/范围验证器分支、预检及动态 CAR
  framing；保留通用 raw Accept/ETag 等实际使用的共享逻辑。
- 不保留“仅小请求”“受限路径”或 feature
  flag 作为未批准的例外。CAR-only 请求明确拒绝；省略 scope 的默认 all 不能偷偷变成 block。
- 完整能力清单不做：自有客户端不消费，标准客户端不识别，不新增自有能力 manifest、发现 API 或
  `/.well-known/...`。范围以标准 probe、协商/拒绝行为及准确文档表达。
- CAR
  probe 必须随实际支持更新，不能只保留 header-only 成功而暗示通用 CAR。普通 raw
  HTTP Range、DHT/Bitswap、DNSLink/网站托管继续不做。

## 清理及调用方迁移

先清点 Web、CLI、MCP、文档、测试、本地 PoC 和外部客户端入口。移除动态网关实现、失效断言和只为它服务的工具；新增拒绝行为及保留能力的回归测试，不能简单删掉失败测试就宣称资源保障已完成。只移除无调用方的依赖，共享的 CID、UnixFS 上传编码、预览及归档工具不可误删。不篡改已完成 iteration
1–4 的历史契约、事件或验收记录。

自有 `/api/public/{cid}/car`
目前存在 legacy/未索引根的现场遍历回退。此类回退也应撤出，不能换个自有路由继续承担同一聚合风险。实施前需清点存量影响并明确无归档时的错误、用户恢复/准备归档路径及是否需要另行授权迁移；不得默默损坏存量下载或自动执行生产回填。

原文件/ZIP 下载及预览仍属于其他产品能力，不因本次网关收缩直接删除；若发现其中同类资源问题，明确记录并单独讨论，不能擅自扩大清理范围。

## 验证与完成定义

固定现有 raw 协议/权限矩阵，验证真实路由的已删除能力拒绝、未知/私有 CID 隐藏、HEAD/304、probe、raw 内容 CID 及已存 CAR 流式读取。独立客户端复验保留范围，文档/能力声明不能继续列出撤出的路径和 scope。官方套件仅选择保留的适用测试；通过/排除/未执行逐项说明，不宣称完整认证。

原来的 32
MiB 重型 CAR 与 native 联合内存验收不再作为本轮交付条件，原因是能力被明确撤出，不是阈值被放宽或此前风险不存在。raw、归档流式下载、预览等保留路径仍需准确回归及资源边界验证。既有性能 idea 及内存补丁保留，适用范围另行重评，不自动接受或完成。

方案变更使旧 ideal
acceptance 不再适用，需提交新 revision 再审阅；本次不授权上线、schema 迁移、数据删除、套餐升级或密钥生成。
