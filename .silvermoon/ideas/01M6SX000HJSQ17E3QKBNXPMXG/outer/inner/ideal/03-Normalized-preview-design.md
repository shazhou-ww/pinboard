# 3 号文档：统一 content type 与 Preview 物料

本文是 [Idea](./Idea.md) 的设计补充，与[2 号现状编码](./02-Current-preview-protocol.md)对照。以下是目标协议和待实施约束，不是已完成的业务改动。

## 1. 决策：展示载荷只有两个维度

1. `contentType`：原内容的类型，不是缩略图或文本摘要的输出格式。
2. `preview`：可空的预览物料，用独立的判别联合描述如何展示。

有可用物料，按物料渲染；没有物料，按原类型显示图标。生成状态、原因、版本和截断信息保留在外围，不成为第三种物料，也不改变这条主规则。

目标 TypeScript 形状：

```ts
interface PreviewImage {
  readonly cid: string;
  readonly url: string;
  readonly width: number;
  readonly height: number;
}

interface DirectoryEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "unknown";
  readonly depth: number;
}

type PreviewMaterial =
  | { readonly kind: "image"; readonly image: PreviewImage }
  | { readonly kind: "markdown"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "directory";
      readonly entries: readonly DirectoryEntry[];
      readonly total?: number;
    };

interface ContentPresentation {
  readonly contentType: string | null;
  readonly preview: PreviewMaterial | null;
}

type ContentPreview = ContentPresentation & {
  readonly version: number;
  readonly status: "pending" | "ready" | "unsupported" | "failed";
  readonly truncated: boolean;
  readonly reason?: string;
  readonly size?: number;
};
```

`size` 是可选的可靠逻辑文件大小元数据，不属于展示载荷的两个维度；保留现有语义，不把缺失值补成 0。现有 `content`、占位文件联合和嵌套 `mediaType` 从目标形状移除。`kind` 是物料判别字段，`image` 只描述可展示的图片产物，不意味着原内容是图片。

### 类型的可靠性

- 原类型由生成端对源内容的有界识别提供，不能从 `preview.kind` 或缩略图后缀反推。
- 无可靠结论时 `contentType: null`，显示通用内容图标；已确定是普通文件但仅知通用二进制类型时可用 `application/octet-stream`。
- 目录使用明确的应用约定 `inode/directory`，不继续使用“目录 JSON 物料格式”冒充原类型。其他 IPLD 内容未知时保持 null，不能一律标成文件。
- 文本物料是 Markdown，不表示源内容是 `text/markdown`。只能确认文本时标 `text/plain`，无法可靠识别原语言时不猜成 JSON、JavaScript 等。
- Pin 名称可修改，Publication 标题和节点 CID 更不是可靠文件名。首版以已知原类型映射图标，不新增文件名猜测链路。

## 2. 现有字段如何迁移

| 现有编码 | 目标编码 | 不能做的转换 |
| --- | --- | --- |
| 顶层 `contentType: "image/webp"` 和 `content: PreviewImage` | `preview: { kind: "image", image }`；原 `contentType` 从源识别取得 | 不能一律把原类型写成 `image/webp` |
| `text/plain` 或 `text/markdown` 加字符串 `content` | `preview: { kind: "text" 或 "markdown", text }` | 不能把摘要输出格式认作原文格式 |
| 目录物料 MIME 和目录 `content` | `contentType: "inode/directory"`；`preview.kind: "directory"` | 不能丢失条目 kind、depth、total 和截断语义 |
| 文件占位中的 `content.mediaType` | 顶层 `contentType`；`preview: null` | 不能把占位 MIME 当原文件类型 |
| 文件占位中的 `content.size` | 外围可选 `size` | 不能用 Pin 大小或缺省 0 替代可靠文件大小 |
| pending/failed 的空文件占位 | 已知类型或 null，加 `preview: null`；保留 status/reason | 不能把失败包装成 ready |
| `version / truncated / reason / status` | 同名外围元数据 | 不能因 `preview: null` 而丢掉生成状态 |
| 缩略图 `cid / url / width / height` | 原样保留在图片物料里 | 不能改成原文件 URL 或绕过现有 URL 校验 |

### 示例：同一个 PDF 从无物料到首页成功

以下 JSON 是协议示意，CID 及尺寸不是执行证据：

```json
{
  "version": 2,
  "status": "unsupported",
  "contentType": "application/pdf",
  "preview": null,
  "truncated": false,
  "reason": "No supported lightweight preview for this content"
}
```

```json
{
  "version": 2,
  "status": "ready",
  "contentType": "application/pdf",
  "preview": {
    "kind": "image",
    "image": {
      "cid": "<thumbnail-cid>",
      "url": "/ipfs/<thumbnail-cid>",
      "width": 339,
      "height": 480
    }
  },
  "truncated": false
}
```

未来视频首帧使用完全相同的图片物料结构，原 `contentType` 为已识别的视频类型；不需要再增加 `kind: "pdf"` 或 `kind: "video-first-frame"`。生成能力仍由各自生成器提供，示例不承诺 MP4、Office 或所有压缩格式已经可识别。

## 3. 展示与状态规则

| 物料/状态 | 主展示 | 辅助行为 |
| --- | --- | --- |
| 有可用 image/text/markdown/directory 物料 | 对应物料渲染器 | 可以显示原类型标签，不把 PDF 或视频改称图片 |
| 无物料，pending | 类型封面，未知类型用通用图标 | 显示正在生成 |
| 无物料，unsupported | 同一类型封面 | 中性提示暂无内容预览，不伪装成系统故障 |
| 无物料，failed | 同一类型封面 | 显示生成失败和必要原因 |
| 图片 URL 加载失败 | 回退同一类型封面 | 显示加载失败；不改写服务器生成状态 |
| 401/403/404 或内容身份变化 | 清除不再有效的旧物料 | 按现有授权/错误路径处理，不能用图标掩盖无权访问 |

生成器的新描述以 ready 对应非空物料，pending/unsupported/failed 对应空物料。展示层若保留同一源 CID 的旧物料用于后台刷新，它是明确的客户端旧快照，不把它伪写进新失败描述；已授权且仍有效时可以继续展示，另示刷新状态。绝不复用另一 CID 或另一账户的物料。

卡片采用大类型图标与简短标签，不重复信息条的名称、大小；详情保留 MIME、可靠大小和错误原因。沿用现有 Phosphor 图标体系，未知 MIME 有通用兜底。目录、文本保持专用物料展示，不强行做成缩略图。视频首帧不代表已有播放器，不能出现不可兑现的播放操作。

物料本身仍遵守现有边界：缩略图尺寸和 URL 白名单、文本转义和代码展示、目录最多 24 条/深度 1、可访问性和截断提示。Markdown 物料不授权执行 HTML、脚本或外链。

## 4. 传递链路如何改变

```text
源 CID
  → 有界识别原 contentType
  → 现有生成器提供 PreviewMaterial 或明确的空结果
  → 统一 ContentPreview 描述
  → D1 descriptor + 既有缩略图发布/回收引用
  → 私有单项/批量、公开 Publication、节点描述 API
  → 对应版本的运行时校验、内存/IndexedDB 缓存
  → 共享物料渲染入口或类型封面
```

所有 API 包装保持自身职责：批量仍按 CID 返回结果或错误；节点描述继续把用户描述与系统预览分开；HTTP 响应编码仍是 JSON。共享描述内部的 `preview` 是物料，批量项 `preview` 和节点 `description.preview` 则是完整描述，代码中用明确类型名区分，不把外层完整描述误当图片物料。

原类型要贯穿成功和已识别后的失败路径；还没识别出类型的 pending 不为图标额外读取整份文件。新结构本身不要求新增数据库表或 schema，不改变 `thumbnail_cid` 的发布和回收规则。

## 5. 版本与并行开发边界

这是现有 `contentType` 的语义变更，不是仅增加可选字段。不能让旧校验器把 `application/pdf` 当未知物料，也不能直接将旧 IndexedDB 记录按新字段读取。

1. **新旧描述明确分版。** 示例使用 version 2；实施时与当时的 `PREVIEW_VERSION`、PDF 分支对齐，保证新形状拥有未使用版本。旧 D1 JSON 先经显式转换再使用；旧图片物料可保留，但没有原类型证据时必须是 null，不能捏造 MIME。
2. **API 有短期兼容出口。** 过渡期由升级客户端通过明确的版本协商请求新表示，旧客户端默认仍取旧表示；转换集中在共享描述边界，而非各路由复制。公开响应区分协商版本的缓存与 ETag，并正确设置 `Vary`。具体协商标识在实施时统一，不能把表示版本混进原文件 `contentType`。
3. **缓存按表示版本隔离。** 新校验器检查原类型和物料联合；持久键包含新表示版本，旧缓存不当作新数据。已有 unsupported 短 TTL 和新生成版本重建机制继续生效；仅转换旧 unsupported 不是重新生成 PDF 首页。
4. **不依靠旧描述恢复已经丢失的信息。** 旧文件占位可以提升 `mediaType/size`；旧成功 WebP 和 Markdown 只能先保留物料，原类型未知，之后由现有有界生成流程补齐。转换不额外无界读取，不新建第二套调度系统。
5. **保持 PDF 的内部复用边界。** PDF 生成器交付图片物料及已知 `application/pdf`；统一描述适配由本 Idea 协调。若 PDF 先合入旧协议，按旧描述兼容；若本协议先合入，PDF 接入新包装。评估差异后更新实施契约，不让两个分支分别发明预览结构。

前后端、开发样例和缓存需在同一实施候选中更新；不将所有第三方类型探测、视频解码或通用插件框架纳入此工作。兼容窗口结束和旧表示移除需要有独立验证，不以一次刷新成功代替旧页面验收。

## 6. 本设计的验证矩阵

| 证明目标 | 最少覆盖 |
| --- | --- |
| 原类型与物料解耦 | JPEG → image；PDF → image/null；视频类型 → 模拟 image/null；文本 → markdown；目录 → directory |
| 状态诚实 | pending/unsupported/failed 空物料；图片加载失败回图标；HTTP 错误不转换成成功占位 |
| 信息不丢失 | size 可缺失、目录 total 可缺失、truncated/reason、已识别 MIME 在成功/失败中保留 |
| 三类入口一致 | Pin、Publication、节点详情；公开入口不依赖私有账户缓存 |
| 迁移有效 | 旧 D1 描述、新旧客户端表示、旧 IndexedDB、旧 unsupported 升级、公开 ETag/Vary |
| 已有安全和体验 | URL/尺寸限制、文本不执行、目录有界、长名称、暗色模式、授权失效清除 |

视频仅验证协议表达与展示，不把模拟图片当作视频首帧生成成功；PDF 首页生成正确性仍由 PDF Idea 的验证负责。
