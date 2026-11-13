# Deployment

## Steps

### D-S01: 独立验证 Publication 标准读取

隔离环境使用专用测试密钥及 Publication，通过标准 HTTP 取得记录，独立验签、更新/回滚和 raw 内容读取；不使用真实私钥 fixture。

### D-S02: 按授权验证续签与目标环境

未来单独获得发布及所需迁移授权后，先应用
`apps/worker/migrations/0010_publication_ipns.sql`（空表及索引，无回填），再按
`docs/publication-ipns.md` 配置独立 master
secret、备份恢复及外部续签告警，验证调度容量、私有权限和删除恢复。本次已授权仓库实现及隔离测试，不发布生产记录、不操作生产数据库、不配置生产 secret 或部署。

## Acceptance criteria

### D-AC01: 标准指针可被外部验证

记录环境/客户端版本、请求名称、签名与 CID 校验及错误记录拒绝证据，不以返回 CID、JSON 或 HTTP
200 当作标准 IPNS 验证成功。

### D-AC02: 生命周期声明与实际结果一致

续签不需要用户发版本，缓存不过 EOL，删除关闭服务及续签，明确已缓存签名的剩余有效窗口；原业务历史和 raw 权限不回归。

部署证据须包括同一 master 与一致数据库备份恢复后名称不变及新记录独立验签，续签失败/cron 失败及低于两小时 EOL 余量告警，并确认每小时 32 条批次足够；这些外部验证未由本次仓库测试代替。
