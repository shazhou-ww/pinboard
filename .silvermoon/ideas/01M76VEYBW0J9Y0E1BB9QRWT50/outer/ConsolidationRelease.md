# 能力收敛外部验收

## 发布身份

- CI
  [43356988847](https://github.com/shazhou-ww/pinboard/actions/runs/43356988847)：Windows/Linux、Node
  22/24 全部通过。
- annotated tag：release-261113-1，commit
  `9a860f3e3375704accb241092157c4e385e83b00`，已在 origin/main。
- 部署
  [43362426332](https://github.com/shazhou-ww/pinboard/actions/runs/43362426332)
  成功，工作流再次执行完整项目检查。
- Worker version：86d74f13-54ab-4531-8e2e-7e2c980dbed3。
- 未执行数据库迁移、自动回填或删除用户数据。

## 稳定能力与撤出验证

Chrome for Testing
157.0.8103.38，通过用户提供的 CDP，在生产同源会话执行 41 条断言，全部通过；导航协议 h3，时间 2026-11-13T04:02:49.844Z。原始结果见
[ConsolidationBrowser.json](ConsolidationBrowser.json)。

专用随机 raw 内容上传后默认私有，匿名通配条件读取保持 404。所有者 raw
GET 字节、HEAD 长度、weak ETag 的 304 通过；公开后匿名读取及 provider
discovery 正确，原文件下载与页面渲染正常。

GET/HEAD 对动态 CAR、block/entity/all、entity-bytes、子路径和尾斜杠、raw 携带 scope 参数以及 CAR
probe 均为 406；raw identity probe 仍为 200。CAR-only
Accept 明确拒绝，没有静默降为 raw/block。普通 HTTP Range 返回完整 raw
200，不宣称 206/416。

自有已存 CAR 下载成功，独立 CarReader 检查根、单块集合、原始字节及 SHA-256；该响应不是现场聚合。legacy/无归档的显式 503 与无 R2 遍历由真实存储回归验证，生产不为测试创建未索引或损坏对象。原始缩略图与预览的回归见 Inner 的完整检查，不因仅移除动态网关而宣称整个预览内存风险已解决。

专用测试 Pin 已 DELETE 移入回收站，并确认匿名读取恢复 404，未永久删除 R2 内容或改变其他用户内容。

## 独立客户端与范围声明

Inner 已使用 Kubo
v0.43.1 的三个冷缓存消费者，通过本地 TLS/HTTP2 在源节点停止后完成 cat/get 和浏览器目录编码重建，58 次 HTTP/2 请求、3 次 probe；另独立离线导入已存 CAR 并重建多块目录/空文件。准确 CID、哈希和命令见 InnerCleanUpEvidence.md；这不是公网 Kubo 检索证明。

官方全功能套件未执行，不宣称全量认证。历史动态 CAR 联合内存实验保持失败，旧单槽/180 秒保护目标未实现或记为通过；本轮验收的是能力明确撤出与稳定范围回归。代码清理删除六个仅为动态能力服务的文件，原有共享 UnixFS 上传、预览、原文件/ZIP 和 Publication 显式写准备保留；读取侧无隐藏现场打包回退。

IPNS Publication 尚未实现，交由 iteration 6；本轮没有新增能力清单接口。
