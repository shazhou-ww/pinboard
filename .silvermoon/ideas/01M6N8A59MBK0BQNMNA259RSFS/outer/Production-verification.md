# 内容预览生产发布证据

## 发布身份与授权

- 用户已明确授权本次生产发布，并独立确认追加式 D1 迁移；允许必要时清理旧测试数据。本次无需清库，未重建数据库、删除原有 Pin 或修改账户与凭据。
- 验证依据为已同步的 `deploymentRevision=346817894f1b`。发布标签为
  `release-261105-3`，指向已在 primary 且 CI 通过的
  `ac14ffa9f83f`，未修改包版本或创建发布分支。
- [生产发布 workflow](https://github.com/shazhou-ww/pinboard/actions/runs/42003403419)
  成功；Ubuntu 上完整 workspace 校验、Worker、静态资源和秘密配置的原子发布步骤全部通过。
- 生产 deployment ID：`3c3f8fcc-1de5-48ae-af5c-b0867158af3c`；Worker version
  ID：`5d39507b-a5ea-49d6-9a98-1e4aa73324ce`，流量为 100%。

## D-S02 / D-AC02：独立生产迁移

Cloudflare
MCP 实际操作连接仍要求重新认证，但现有 Wrangler 登录有效；所有生产 D1 和运行信息均通过正常认证的 Wrangler 操作，没有读取、复制或输出凭据。

迁移前确认目标数据库为配置中的 `pinboard`，其 migration ledger 完整记录 `0001`
至 `0004`，预览表不存在，原有 Pin 为一个。先记录 D1 Time
Travel 恢复 bookmark，再执行：

```powershell
pnpm --filter @shazhou/pinboard-worker exec wrangler d1 migrations apply pinboard --remote --config wrangler.jsonc
```

实际仅应用 `0005_previews.sql`。随后核对两个表、五个索引、状态检查、BLOB
65,536 字节及宽高 480 的约束，并确认 ledger 新增
`0005`。未重复执行历史迁移；schema 就绪之后才推送发布 tag。

恢复 bookmark 为
`00000028-00000000-0000511a-66294fe982df6cf0b86615a5ee1c76db`。恢复操作本身未执行；bookmark 不是访问凭据，实际恢复仍需要 D1 操作权限及对新增写入影响的审查。此前的隔离迁移、任务恢复与版本切换证据仍见[落地准备记录](Rollout-readiness.md)。

## D-S01 / D-AC01：真实资源消耗

使用现有、正常授权的 MCP 上传入口提交公开测试 PNG：1400 ×
1400，即 1,960,000 像素，接近实现的二百万像素预算；输入为 958 字节的高频黑白图案，不声称它是复杂照片或生产负载压测。

生产 D1 记录首次尝试即为 `ready`，缩略图为 320 × 320
WebP、45,024 字节，`typeof(bytes)` 为
`blob`。实际执行了真实解码、缩小与有界编码，并非模拟服务。

平台 `wrangler tail --format json` 的该次 MCP 请求记录：

| 指标           | 实际结果   |
| -------------- | ---------- |
| CPU time       | 915 ms     |
| Wall time      | 4,825 ms   |
| HTTP / outcome | 200 / `ok` |
| Exceptions     | 0          |

生产 Worker 使用既有 `standard` usage
model。本次未提高 CPU 限制、升级付费计划、启用 Images 或新增队列。近预算图片在现有配置下完成，未出现 CPU 或内存超限结果。没有取得峰值内存数值，不虚构精确内存余量；上述单请求结果也不等于任意并发规模的容量保证。

## D-S03 / D-AC03：网关、授权与共享引用

- 原内容 CID：`bafkreief73jih6zmdk5viz56xo33oittxvmnjmt5755nofguv37kd2cqoi`。
- 缩略图 CID：`bafkreibej3cw5b4adhr6b7muhxiaoddgo57rqivmksngopqifdpe6f4g54`。
- 生产 `/ipfs/{thumbnailCid}` 返回 200、`image/webp`、45,024 字节及
  `nosniff`；独立重算 SHA2-256 raw
  CID，与 URL 完全一致。HEAD 为 200 且无响应体，ETag 条件请求为 304。真实浏览器独立解码为 320
  × 320。
- 匿名 `/api/me`
  和预览描述端点均为 401。未为验证而安装合成账户入口、绕过正常授权或读取用户登录 cookie；生产上传使用正常 MCP
  OAuth。
- 直接 Pin 缩略图后再移除测试原内容 Pin，图片仍为 200，D1 的 `unreferenced_at`
  为 null。移除最后的测试直接 Pin 后，时间更新为
  `2026-11-05T09:42:48.334Z`，进入既有七天保留期，而不是立即物理删除。
- 测试前后原有 Pin 均为一个；此次新增的两个测试 Pin 已通过标准 Unpin 移除，没有清空旧数据，也不声称公开字节或外部缓存已即时撤回。

现有 Web、CLI、API、MCP 的全入口隔离验证及内容墙零自动 CAR 下载证据保留在[落地准备记录](Rollout-readiness.md)；本次生产补充正常 MCP、公共网关、私有端点拒绝和真实资源执行结果。未重新完成一次人工 Google 登录、等待七天实际回收或实施并发压力测试，不将这些未执行事项写成通过。
