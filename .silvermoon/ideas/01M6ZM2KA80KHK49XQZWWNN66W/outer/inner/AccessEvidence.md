# 逐项访问权限实施证据

## 边界与存量策略

本次未更改 Ideal
World、部署契约、D-* 清单、事件日志或生命周期元数据。未提交、暂存、推送、拉取、创建标签、部署或执行生产 D1 迁移。迁移
`0009_item_visibility.sql`
只添加受检查的访问字段，存量回填公开；新建默认私有。生产命令和旧 CDN 缓存风险见
[`docs/access-control.md`](../../../../../docs/access-control.md)。

## 本地证明

- Worker 新授权矩阵使用真实 Miniflare
  D1／R2：匿名、其他账号及仅上传凭证在原始块、完整下载、Publication 元数据／历史／描述及 HEAD／304 上拒绝，并断言拒绝前没有 R2
  GET／HEAD。已存储无引用写入不能匿名读取。
- 根与共享字节测试覆盖 DAG 子块、缩略图来源、公开引用撤回、私有源曝光确认、转换、回滚及恢复；私有元数据不随共享公开字节外泄。
- Web 测试实际调用事件处理函数：取消／复制不授权，保存成功才更新权限，失败保留原状态且允许再次确认重试；卡片锁在名称前，访客图标只读。
- [真实 Chrome 测量](AccessVisual.json)
  为本地只读 UI 预览：1280／390／320 像素下均无墙或详情溢出；移除锁前后 info
  bar 高度和 preview
  padding 相等，标题权限按钮同行，关闭分享框后焦点返回按钮。当前 `v3` 与历史总数
  `5` 分离。只读预览拒绝保存后仍保持私有状态。

## 操作者验收脚本

`scripts/access-http-check.mjs` 接收以下环境变量，不生成或修改凭证：

- `PINBOARD_ACCEPTANCE_ORIGIN`、`PINBOARD_ACCEPTANCE_TOKEN`：实际服务及操作者真实 Agent 凭证，需 Pin／Publication 读写删范围。
- `PINBOARD_ACCEPTANCE_OTHER_TOKEN`：真实另一账号。
- `PINBOARD_ACCEPTANCE_READ_ONLY_TOKEN`：所属账号 `pins:read`。
- `PINBOARD_ACCEPTANCE_UPLOAD_ONLY_TOKEN`：所属账号 `pins:write`。
- 非本机服务须显式
  `PINBOARD_ACCEPTANCE_ALLOW_REMOTE=1`；缺凭证时默认在任何写入前停止，只有显式
  `PINBOARD_ACCEPTANCE_ALLOW_PARTIAL=1` 才执行已覆盖子集并以退出码 `2`
  报告未完成。
- `PINBOARD_ACCEPTANCE_REPORT`
  可写入当前项目内的 JSON 证据；输出不含凭证。每轮只创建唯一随机前缀的内容，清理仅撤销／删除本轮产生的引用；清理失败明确列出 ID，不操作既有内容。

此脚本尚未对生产执行；不能替代真实外部 MCP OAuth 与第二账号验证。
`scripts/access-visual-check.mjs` 仅允许本机只读 UI 预览，不接受生产地址。

## 检查记录

环境：Node `v24.11.1`、pnpm `11.22.0`。npm／pnpm 有效 registry 均为
`https://mirrors.cloud.tencent.com/npm/`，NRM 当前条目为
`tencent-cloud`；锁文件未发现官方 registry
URL。本次没有显式恢复依赖；首次 pnpm 验证命令自动复用本地缓存恢复工作区，下载数为
`0`。两个包验收均使用既有离线安装测试。

| 命令                                                                                                                              | 最后结果                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm exec turbo run lint typecheck --filter=@shazhou/pinboard-worker --filter=@shazhou/pinboard-web --filter=@shazhou/pinboard`  | 11／11 个任务成功                                                                                                                               |
| `pnpm --filter @shazhou/pinboard-web test`                                                                                        | 22 个测试文件通过，282 个测试通过；语句 95.45%、分支 96.42%、函数 93.75%、行 95.16%                                                             |
| `pnpm --filter @shazhou/pinboard-worker build`                                                                                    | Wrangler `--dry-run` 成功，未部署                                                                                                               |
| `pnpm --filter @shazhou/pinboard-worker exec vitest run --coverage -t '^(?!.*serializes real independent credential writers).*$'` | 单独运行的最后一轮：18 个文件通过，294 个测试通过、3 个跳过；语句 95.32%、分支 90.06%、函数 97.86%、行 96.42%                                   |
| `pnpm --filter @shazhou/pinboard exec vitest run test/retrieval.test.ts`                                                          | 57／57 个测试通过                                                                                                                               |
| `pnpm test:cli-package`                                                                                                           | 精确 CLI tarball 离线安装验收：1／1 通过                                                                                                        |
| `pnpm test:background-package`                                                                                                    | 精确 background tarball 离线安装验收：1／1 通过                                                                                                 |
| `node scripts/access-visual-check.mjs`                                                                                            | 真实 Chrome：1280／390／320 三种宽度通过；公开卡片无锁、v3 与 5 个历史版本分离，详见 JSON                                                       |
| `node --check scripts/access-http-check.mjs`                                                                                      | 语法检查通过；未对生产或真实外部服务运行                                                                                                        |
| `pnpm check`，设置 `PINBOARD_TEST_ROOT` 为当前工作区                                                                              | **失败**：CLI 163 个测试中 153 通过、9 失败、1 跳过；9 个失败均为既有 Windows 凭证文件 DACL 检查的 `UNSAFE_PERMISSIONS`／`Replaceable ancestor` |

Worker 选择器明确排除了同一主机原因阻塞的一个独立凭证文件写入测试，另两个跳过来自既有平台条件；这不是完整
`pnpm check`
通过。核心授权、真实 HTTP／MCP／CLI、DAG／CAR、图片／PDF、删除恢复和缓存回归均包含在 294 个已通过测试中。曾在并行运行完整检查时出现本地 Miniflare
`fetch failed`；停止重叠广泛运行后，单独完整应用验收通过，未隐藏该错误。

上述交接时 **I-S03、I-AC03 尚未完成**。未降低覆盖率门槛、未跳过／修改原 Windows
ACL 安全检查，也未改变共享磁盘权限。

### 父任务完整复核

父任务采用仓库 `.github/workflows/ci.yaml` 已有的 Windows 测试位置，设置
`PINBOARD_TEST_ROOT=$env:USERPROFILE\pinboard-ci-fixtures`，而不是将凭证夹具放在共享的
`D:\Code` 祖先目录下。未修改 ACL 检查、跳过条件、系统权限或覆盖率门槛。

完整 `pnpm check` 已成功，退出码
`0`：核心 24／24、包检查 3／3 和最后 1／1 个任务成功。Worker 为 296 个测试通过、1 个既有平台跳过；CLI 为 161 个通过、2 个既有条件跳过；Web 为 282 个通过。契约 13、编码 14、背景 34 个测试通过，两个精确 tarball 离线验收通过。因此 I-S03、I-AC03 已完成。复核还修正了设置页移除公开提醒开关后残留的旧说明，改为明确告知曾公开内容的外部副本无法收回。

`.prettierignore` 唯一新增规则精确指向本构想的已接受 Ideal
World：这些未格式化的审阅快照原本使根格式检查失败，但本任务明确禁止改动它们。Implementation／证据／应用代码仍接受正常格式检查。已核对理想世界 Git 树为
`ff2ec6f06b57f43604a6834195444a7f7f37168f`，且无内容修改。

## 主要改动与交接边界

- `apps/worker/src/access.ts`、`service.ts`、`publications.ts`、`mcp.ts`、
  `gateway.ts`、`index.ts`、`api.ts`、`publication-api.ts`、
  `descriptions.ts`、`recently-deleted.ts`、`schemas.ts`、`previews.ts`：存活根授权、默认私有、权限修改、MCP 私有块读取、范围与持久重试保护、全历史隔离、权限恢复及可撤销缓存。
- `apps/web/src/access.tsx`、`detail-actions.tsx`、`manager.tsx`、
  `publications.tsx`、`ui.tsx`、`item-filter.tsx`、`recently-deleted.tsx`、
  `dialog.tsx`、`icon.tsx`、`styles.css`
  及本机只读预览：详情管理、只读访客图标、私有个人链接、失败不确认、卡片锁及当前版本。
- `apps/cli/src/cli.ts`、`client.ts`、共享
  `packages/contracts/src`、直接相关 Worker／Web／CLI／包测试与 README／访问／存储／MCP／CLI 文档。
- 稳定迁移文件：`apps/worker/migrations/0009_item_visibility.sql`。它只添加
  `pins.visibility`、`publications.visibility` 的非空枚举字段（默认
  `private`）、回填既有项为 `public`，并创建 `publication_revisions_cid`，列为
  `(cid, publication_id)`。
  **没有**重置、删除、凭证扩权、历史正文改写或自动部署迁移。

父任务独立授权后使用的 schema 命令为
`pnpm --filter @shazhou/pinboard-worker exec wrangler d1 migrations apply pinboard --remote --config wrangler.jsonc`；先确认 pending 列表，不能误应用无关迁移。本子任务没有运行该命令。父任务还需核实旧根 DAG 归属回填、清理 Pinboard 域名下旧
`/ipfs/*` 及 `/routing/v1/providers/*`
CDN 表示，并执行真实范围凭证／第二账号／外部 MCP
OAuth 验收。过去已下载的字节、浏览器缓存和外部副本无法收回。

浏览器复验契约：本机启动
`VITE_UI_PREVIEW=true pnpm --filter @shazhou/pinboard-web exec vite --host 127.0.0.1 --port 5199 --strictPort`，然后运行
`node scripts/access-visual-check.mjs`；Windows 可用 PowerShell
`$env:VITE_UI_PREVIEW='true'`
设置变量。脚本使用既有 Chrome 与原生 CDP，不安装 Playwright，不伪造生产认证，并清理自己的浏览器 profile。HTTP 脚本的环境变量契约见上节；默认不允许远程和缺凭证写入，只有父任务明确打开对应开关后才运行限定前缀的真实内容验收。
