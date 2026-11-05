# 内容预览实施证据

## 实现与边界

- 图片路径是现有 Worker 内的预编译 WASM：jSquash
  JPEG/PNG/WebP 解码、透明度加权缩小、非 SIMD WebP 编码。无需 Images
  binding、远程图片服务、浏览器解包 CAR 或原生扩展。workerd 测试运行的是真实解码/编码，不是图片生成模拟。
- 解码上限为 8 MiB
  / 二百万像素；缩略图长边最多 480 像素、二进制最多 65,536 字节。超过预算明确失败。GIF、PDF、音视频与未知格式只做明确占位，未声称实现对应渲染器。
- D1 保存 `content_previews` 状态/版本/描述和 `preview_images.bytes` BLOB。raw
  CID 由真实 WebP 字节计算；图片网关直接返回这些字节，显式 raw 协议仍返回同一块内容。不把 CAR、数据库 ID 或 Base64 当图片。
- 文本是 UTF-8 的真实前缀，至多 2,400 个 Unicode 字符。展示 Markdown 仅输出转义文本与忠实代码围栏，不推断作者的 Markdown 意图，不补写标题或结论。目录最多 24 个真实条目、两个条目层级；不附加可选子图，不提供导航或 DAG 图。
- 图片、文字、目录分类不使用账户名称。协议 CAR 根据已验证的 UnixFS 根内容分类，Web 普通
  `.car` 文件保持原义；没有任意远程 CID 读取路径。

## 可重复的自动化证据

在当前隔离 worktree 使用现有 pnpm/Turbo 工具：

```powershell
pnpm --filter @shazhou/pinboard-worker exec vitest run test/previews.test.ts test/image-runtime.test.ts
pnpm --filter @shazhou/pinboard-worker exec vitest run --exclude test/cli.test.ts --coverage
pnpm --filter @shazhou/pinboard-web test
pnpm --filter @shazhou/pinboard-worker typecheck
pnpm --filter @shazhou/pinboard-worker lint
pnpm check
```

`image-runtime.test.ts` 构建单独的测试入口并在真实 workerd 中运行，覆盖：

- NASA 公共领域照片的 PNG/JPEG、纵向裁切照片、复杂透明 RGBA 图，独立解码输出，检查颜色种类与透明像素。
- WebP 原图再次解码；高熵随机 RGBA 的真实压缩降级；畸形、过大和像素炸弹输入。
- 真正的受授权 HTTP 上传、预览描述、同源图片交付、CAR 协议导入与 MCP 上传；未授权访问和无额外账户 Pin。

`previews.test.ts` 使用真实 D1/R2，额外证明：

- `typeof(bytes) = 'blob'`；网关字节重新计算 CID 与描述一致；HEAD、图片/raw 表示及 ETag/304；列表没有图片或私有共享描述。
- 不同账户的预览端点隔离、缺失读取权限与跨源请求被拒绝。
- 普通标点转义、代码围栏、中文/Emoji 精确截断；HTML/SVG、外链、伪造文件名、未知文件和真实目录均不产生主动内容。
- 入队失败仍保存 Pin，记录错误后由有限补生成恢复；重复领取任务受租约保护；最多三次尝试及最后一次中断的失败收敛。

### 共享引用与回收证明

1. 在 JPEG 末尾添加一个不改变解码像素的字节：原 CID 不同，但真实生成的缩略图 CID 相同。删除其中一个账户或原内容的 Pin 不会删除共享 BLOB。
2. 另一个账户直接 Pin 缩略图，或在已 Pin 的目录中引用缩略图块，均保持图片存活；移除最后引用才开始新的七天保留期。
3. 暂停直接 Pin 或目录间接引用的 R2
   PUT，先让 GC 真正删除旧 D1 图片，再恢复 PUT：Pin 的发布事务重新保存已经验证的 BLOB，重新计算网关响应 CID 仍一致。CAR 导入、根块上传及已有 DAG 的 Pin 均覆盖间接引用，不能只保护根 CID。
4. `active`
   指向该源最近发布的版本；替代版本仍待生成或失败时，旧图片超过八天也不会被错误回收。成功发布时原子切换引用。另一个版本切换夹具使用两张真实已编码 BLOB 作为旧/新资源；它只验证引用记账，不声称两张不同图片是同一来源的新编码。已被替换的旧版本六天内保留、八天后删除；当前资源不受影响。
5. 预览发布、Pin 引用变化与图片删除均在 D1 事务中重查存活关系。原内容继续使用现有唯一 R2 对象键与写入围栏，不绕过原存储保留机制。

## 隔离浏览器证据

复验入口：

```powershell
pnpm build
node apps\worker\test\preview-browser.mjs
```

访问
`http://127.0.0.1:5191`。夹具只提供合成账户，在内存 Miniflare 中上传真实样本，并代理到当前编译 Worker；不是生产认证后门，生产入口不会导入该文件。此过程未使用父会话的
`http://127.0.0.1:5178`，验证后停止夹具。

2026-11-05 的真实浏览器检查结果：

| 样本           | 浏览器解码尺寸 | 独立图片请求字节 |
| -------------- | -------------- | ---------------- |
| NASA JPEG 照片 | 480 × 480      | 19,666           |
| 透明 RGBA PNG  | 480 × 320      | 27,350           |
| 纵向 JPEG 照片 | 240 × 480      | 12,454           |

- 六张卡片产生六个 `/api/pins/{cid}/preview` 请求及三个 `/ipfs/{thumbnailCid}`
  图片请求；原始 CAR 请求为零、raw 请求为零、外部资源请求为零。预览区域内可点击链接、script、SVG、iframe 元素均为零。
- 照片、透明图、纵向照片实际显示；文字保留星号、链接文字及 `<script>`
  原文，不执行。目录显示实际两层文件名，PDF 显示明确占位。
- 改名同时更新卡片和详情，不改变缩略图 URL；完整 CID 复制出现成功提示。详情保留 CID、大小、时间、分享及原始 CAR 主动下载入口。
- 经真实 Web 上传对话框上传文本，卡片出现忠实摘录；确认 Unpin 后该卡片消失、账户恢复六个 Pin。
- 390 像素视口无横向溢出。阻断三个缩略图请求后均出现明确图片交付错误，没有自动下载原 CAR 或 raw 块。
- 集成浏览器后台标签会暂停 IntersectionObserver；验证时只对本测试页启用焦点模拟，未替换预览逻辑或网络响应。

### 独立复核后的目录布局修正

父会话复核发现：目录文件名虽存在于 DOM，外层 `.pin-list li`
的网格、边框与内边距仍泄漏到内层目录条目，造成每行 98 像素、实际文件名被裁切。此前仅检查文本存在不足以证明可见，此处补充真实布局证据。

- 将外层行样式限定为
  `.pin-list > li`，清除目录列表默认外边距，并使用紧凑段落间距和 14 像素 /
  1.5 行高；不改变外层卡片、底栏或操作。
- 增加 CSS 回归测试，防止恢复后代 `li` 选择器或丢失目录列表间距重置。
- 在父会话已运行的 `http://127.0.0.1:5191` 上通过 Vite
  HMR 验证：目录整体高度 70.80 像素，列表高度 42 像素；`notes`、`readme.txt`
  各行 21 像素、`display: list-item`，图标为 inline，不再继承边框或上下内边距。
- 实际文本 Range 坐标证明两项都在预览区域内且高于底栏。390 像素移动视口下两项仍可见，无横向溢出。没有启动、重启或停止父会话夹具。
- 修正后 Web 全套 53 个测试通过，Web lint、typecheck 通过。

### 独立复核后的间接引用竞争修正

新增暂停写入测试先在旧实现上复现：目录含真实缩略图 raw 块，暂停 `storeDag` 的 R2
PUT，GC 删除 D1 图片后再发布目录 Pin；块仍在 R2，但标准图片请求得到
**406**。原因是旧代码仅快照根缩略图，遗漏了 DAG 成员。

修正后，上传从整个已验证 DAG 查询已知缩略图的 CID/宽高；已有 DAG 的 Pin 在遍历前查询已知成员，并在发布前合并实际验证成员。快照不复制图片 BLOB；恢复字节取自本地已逐块验算 CID 的 DAG，不猜测任意 WebP 或远程 CID。所有这些图片与新 Pin 在同一 D1 事务内重新发布、刷新引用。

CAR 导入、单根块上传、已有 DAG Pin 三个暂停 PUT /
GC 用例均通过：确实先删除 D1 图片，恢复后 `/ipfs/{thumbnailCid}` 返回 **200
image/webp**，响应字节重新计算的 raw CID 正确，图片 `unreferenced_at`
为 null，且没有自动创建缩略图账户 Pin。直接根引用的暂停 PUT 用例也保持通过。

## 项目检查结果

截至最终独立复验：

| 命令/范围                             | 实际结果                                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两个新增 Worker 预览测试文件          | 31 个测试通过，包含真实 workerd 编码/解码、高熵降级、授权及直接/间接引用竞争                                                                       |
| Worker 完整非 CLI 回归（带 coverage） | 8 个文件通过；134 个测试通过，1 个既有可选 Kubo 测试跳过                                                                                           |
| Worker coverage                       | statements 95.91%、branches 91.44%、functions 99.40%、lines 96.88%；原有 90% 门槛不变                                                              |
| Web 完整测试                          | 6 个文件、53 个测试通过（包括目录 CSS 回归）                                                                                                       |
| Worker / Web typecheck 与 lint        | 均通过                                                                                                                                             |
| `pnpm build`                          | 5/5 构建成功；Worker dry-run 总上传 2,733.44 KiB，gzip 713.37 KiB；只有既有 DB、BLOCKS、ASSETS 绑定，无 Images                                     |
| Worker 既有 CLI 集成                  | 8 通过、1 失败；失败仍是独立凭据写入进程的 Windows `UNSAFE_PERMISSIONS` / DACL                                                                     |
| 两项修正后的 `pnpm check`             | **未通过**；父会话已格式化 Deployment.md，格式及发布校验通过；Turbo 18/20 任务成功后仍被既有 CLI Windows 凭据权限测试中止，未执行后续 CLI 打包阶段 |

`silvermoon check --worktree --audience agent` 验证通过；`git diff --check`
无错误。本实现未修改 accepted Ideal、父会话管理的 Deployment 契约及
`docs/deployment.md`，所有 D-* 保持未勾选；未追加生命周期事件或进行 Git 提交/推送。

此次清缓存后的完整检查还暴露 `apps/cli`
的既有 Windows 实机凭据测试：`cli.test.ts` 一个配置/令牌测试及
`permissions.test.ts`
八个测试失败，139 个通过、1 个跳过。未修改 CLI 权限代码或降低安全要求。完整检查提前停止，CLI 打包阶段没有重新执行；不能把先前已知的
`ERR_UNKNOWN_FILE_EXTENSION` 当作本次重新验证出的结果。

新增 WASM 与 Miniflare 测试将 Worker
runner 并发限制为两个，避免多个真实 runtime 同时占用过多内存；没有降低覆盖门槛、跳过新增用例或以模拟图片替代真实运行。以上 Worker 非 CLI 全套通过是在该限制下重新运行的结果。I-* 勾选表示相关实现及上述明确范围的证据已完成，不表示
`pnpm check` 变绿，也不代替父会话对已知环境阻塞的判断。

### 父会话独立门限复验

父会话在两项修正完成后独立重跑：预览专项 31 项通过、Worker 非 CLI
134 项通过与一项既有跳过、Web 53 项通过；覆盖率与上表一致。完整 `pnpm check`
的既有 DACL/可替换祖先目录失败保持显式记录，不降低凭据保护或覆盖门槛。

实际浏览器再次确认目录两行均为 21 像素，真实文本 Range 坐标均位于预览内，没有仅以 DOM 存在代替可见性。此前独立网络复验确认六个描述请求、三个真实缩略图，字节分别为 19,666、27,350、12,454；无原始 CAR、raw 或外部资源请求。对三个图片响应独立计算 SHA2-256
raw CID，均与 URL 匹配，媒体类型为
`image/webp`，条件请求均为 304。390 像素视口无横向溢出。

## 交给父会话的外部条件

- 没有生产部署、迁移、付费能力启用或新服务配置。`0005_previews.sql`
  只在本地 Miniflare 应用；生产执行需要独立授权。
- 本地 workerd 已证明 WASM 兼容和真实图片处理；这不等于验证了生产账户的 CPU 配额。上线前应在现有 Worker 计划内确认图片任务的 CPU/内存余量及实际任务指标；不得为了此实现自行升级付费计划或启用 Images。
- 当前有界预算故意不承诺所有大图、非 UTF-8 文档或所有图片格式。超过预算时 Pin 仍成功，预览显示失败或不支持；没有不安全的浏览器原内容回退。
- 生产 CPU 指标、迁移审批与发布验收仍属于父会话管理的 Outer
  World；本文件没有代替或修改 Deployment 契约。
