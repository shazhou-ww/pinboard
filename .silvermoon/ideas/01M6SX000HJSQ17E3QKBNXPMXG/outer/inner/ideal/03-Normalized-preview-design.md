# 3 号文档：统一 content type 与 Preview 物料

本文是 [Idea](./Idea.md)
的唯一目标设计说明，与[2 号现状编码](./02-Current-preview-protocol.md)对照。2026-11-07 更新：[PDF 首页预览](../../../../01M6SSPF59MS6DY1MV1JWFZD4N/outer/inner/Implementation-evidence.md)已完成实施并进入部署验收；本轮只修订展示设计，不开始本项编码，也不替 PDF 作部署验收决定。

## 1. 决策：展示载荷只有两个维度

1. `contentType`：原内容的类型，参与有物料和无物料时的视觉语义，不是缩略图或文本摘要的输出格式。
2. `preview`：可空的预览物料，用独立的判别联合选择基础渲染器。

两项共同决定最终 UX：有可用物料时，由物料选择基础渲染器，再由原类型调整标识与外观；没有可用物料时，使用原类型图标。`contentType`
不只是 fallback 的输入。生成状态、原因、版本和截断信息保留在外围，不成为第三种物料。

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

type ContentPreview = {
  readonly contentType: string | null;
  readonly version: number;
  readonly truncated: boolean;
  readonly reason?: string;
  readonly size?: number;
} & (
  | { readonly status: "ready"; readonly preview: PreviewMaterial }
  | {
      readonly status: "pending" | "unsupported" | "failed";
      readonly preview: null;
    }
);
```

`contentType` 与 `preview` 是展示载荷；其余是外围元数据。`version`
继续表示生成结果版本，不充当 HTTP 协议版本。`size`
保留可靠逻辑文件大小，未知时省略；`truncated` 描述物料，空物料时为 false。旧
`content` 和嵌套 `mediaType` 不保留在目标形状中。

共享运行时校验须与上述联合一致，拒绝 `ready + null`、`failed + image`
等无效组合，不能由各组件分别修正。客户端保留的旧物料是独立快照，不混入新的生成结果。

### 类型的可靠性

- 原类型由生成端对源内容的有界识别提供，不能从 `preview.kind` 或缩略图后缀反推。
- 无可靠结论时
  `contentType: null`：有物料仍按其 kind 展示，不加猜测的类型标识；无物料才显示通用内容图标。已确定是普通文件但仅知通用二进制类型时可用
  `application/octet-stream`。
- 目录使用明确的应用约定
  `inode/directory`，不继续使用“目录 JSON 物料格式”冒充原类型。其他 IPLD 内容未知时保持 null，不能一律标成文件。
- 文本物料是 Markdown，不表示源内容是 `text/markdown`。只能确认文本时标
  `text/plain`，无法可靠识别原语言时不猜成 JSON、JavaScript 等。
- Pin 名称可修改，Publication 标题和节点 CID 更不是可靠文件名。首版以已知原类型选择标识和视觉变体，不新增文件名猜测链路。

## 2. 现有字段如何迁移

| 现有编码                                                    | 目标编码                                                           | 不能做的转换                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 顶层 `contentType: "image/webp"` 和 `content: PreviewImage` | `preview: { kind: "image", image }`；原 `contentType` 从源识别取得 | 不能一律把原类型写成 `image/webp`                                     |
| `text/plain` 或 `text/markdown` 加字符串 `content`          | `preview: { kind: "text" 或 "markdown", text }`                    | 不能把摘要输出格式认作原文格式                                        |
| 目录物料 MIME 和目录 `content`                              | `contentType: "inode/directory"`；`preview.kind: "directory"`      | 不能丢失条目 kind、depth、total 和截断语义                            |
| 文件占位中的 `content.mediaType`                            | 顶层 `contentType`；`preview: null`                                | 不能把占位 MIME 当原文件类型                                          |
| 文件占位中的 `content.size`                                 | 外围可选 `size`                                                    | 不能用 Pin 大小或缺省 0 替代可靠文件大小                              |
| pending/failed 的空文件占位                                 | 已知类型或 null，加 `preview: null`；保留 status/reason            | 不能把失败包装成 ready                                                |
| `version / truncated / reason / status`                     | 保留各自语义的外围元数据，status 与物料按上述联合约束              | 不能因 `preview: null` 而丢掉生成状态，不能将生成版本当 HTTP 协议版本 |
| 缩略图 `cid / url / width / height`                         | 原样保留在图片物料里                                               | 不能改成原文件 URL 或绕过现有 URL 校验                                |

### 示例：同一个 PDF 从无物料到首页成功

| 情况             | contentType                   | status                                | preview                                                 |
| ---------------- | ----------------------------- | ------------------------------------- | ------------------------------------------------------- |
| 首页生成中       | `application/pdf`（已识别时） | pending                               | null                                                    |
| 已有首页         | `application/pdf`             | ready                                 | `{ kind: "image", image: { cid, url, width, height } }` |
| 无法生成首页     | `application/pdf`（已识别时） | unsupported 或 failed，按实际原因区分 | null                                                    |
| 未来已有视频首帧 | 已识别的视频类型              | ready                                 | 相同的 image 物料                                       |

PDF 和视频都不新增物料分支。上表仅说明表达能力，不承诺视频生成、所有格式识别或尚未验证的 PDF 结果。

## 3. 展示与状态规则

### 物料与内容语义共同呈现

| 原类型与物料                              | 基础渲染       | 类型相关的 UX                                                                         |
| ----------------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| `image/*` + image                         | 共享图片渲染器 | 普通图片展示，不增加文档标识                                                          |
| `application/pdf` + image                 | 同一图片渲染器 | 首页保留页面比例，以 PDF 标识或纸页外观区别于普通图片，不按照片填满的方式裁掉页面内容 |
| 已识别的视频类型 + image                  | 同一图片渲染器 | 可叠加非交互的视频类型标识；不暗示已经支持播放                                        |
| 未知类型或未定义视觉变体 + 任意已支持物料 | 对应物料渲染器 | 使用中性默认外观，仍显示物料，不因缺少类型样式退回图标                                |
| 任意类型 + 无可用物料                     | 类型封面       | 已知类型图标，或通用内容图标                                                          |

PDF 标识、纸页边框等是视觉实现选项，不要求同时堆叠；具体样式在实施时验证，验收重点是“看得出是文档，且首页内容没有被装饰遮挡”。类型不能只靠颜色表达，还应有可读或可访问的名称。类型展示须在三类入口中保持一致语义，不要求卡片和详情尺寸相同。

前端在共享展示入口组合物料渲染与少量类型视觉规则，不为每种 MIME 建整套卡片，也不建设主题插件框架。API 仍只传原类型与物料，不新增
`presentationKind`、图标名、布局提示等可推导字段；装饰不烧录进缩略图，也不影响其 CID、缓存或生成器。`contentType`
只能调整视觉，不能绕过物料 kind 的校验、执行原文件，或增加尚不存在的阅读/播放能力。

### 状态与降级

| 物料/状态                                 | 主展示                             | 辅助行为                                           |
| ----------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| 有可用 image/text/markdown/directory 物料 | 物料渲染器与原类型视觉规则共同呈现 | PDF 首页明确保留文档身份，原类型未知时使用中性外观 |
| 无物料，pending                           | 类型封面，未知类型用通用图标       | 显示正在生成                                       |
| 无物料，unsupported                       | 同一类型封面                       | 中性提示暂无内容预览，不伪装成系统故障             |
| 无物料，failed                            | 同一类型封面                       | 显示生成失败和必要原因                             |
| 图片 URL 加载失败                         | 回退同一类型封面                   | 显示加载失败；不改写服务器生成状态                 |
| 401/403/404 或内容身份变化                | 清除不再有效的旧物料               | 按现有授权/错误路径处理，不能用图标掩盖无权访问    |

后台刷新时，同一源 CID 的有效旧快照可以继续显示，刷新状态另行提示；不得跨账户、跨内容身份复用。物料与原类型共同决定主展示，状态只影响辅助提示，不引入第二套“可否预览”标志。

无可用物料的卡片采用大类型图标与简短标签，不重复信息条的名称、大小；详情保留 MIME、可靠大小和错误原因。沿用现有 Phosphor 图标体系。目录、文本保持专用物料展示，不强行做成缩略图；加载失败退回封面时仍使用同一原类型身份。

保留现有[物料校验](../../../../../../apps/web/src/preview-cache.ts)与[安全展示](../../../../../../apps/web/src/pin-preview.tsx)边界，不在本文复制尺寸、目录数量等数值规格；Markdown 物料不授权执行 HTML、脚本或外链。

## 4. 职责与传递链路

```text
源 CID → 现有预览编排：有界识别、调用格式处理
                          ↓
              格式渲染器 → 像素/字节
                          ↓
         现有编排：编码、CID、发布、组装 ContentPreview
                          ↓
             既有存储与 API → 校验/缓存 → 共享展示
```

格式渲染模块不构造 CID、URL 或公开协议。[PDF 架构](../../../../01M6SSPF59MS6DY1MV1JWFZD4N/outer/inner/ideal/Architecture-review.md)中的 PDF 渲染器继续只返回 RGBA，现有编排调用编码器并组装图片物料；未来视频沿用同一责任边界。文本和目录直接形成对应物料，不经过像素路径。

所有接口复用同一描述契约与校验规则；批量结果、节点描述等外层包装保持不变，其中外层
`preview` 是完整描述，内部 `preview`
才是物料。只改描述组装及消费边界，不让存储、路由、前端增加 PDF/视频专用协议分支；前端的类型视觉变体不等于新增物料渲染协议。

编排在成功和已识别后的失败结果中保留原类型；pending 尚未识别时允许 null，不为图标额外读取整份文件。不新增表、服务、插件框架或调度系统，不改变原文件、CAR、授权和缩略图引用回收规则。

## 5. 最小迁移与实施顺序

这是破坏旧字段含义的结构变更，需要过渡，但不预建通用多版本平台。

- **服务端采用重建，不双轨迁移。** 在 PDF 合入后的实际生成版本上递增
  `PREVIEW_VERSION`，按既有入口和调度为当前版本生成新形状。旧 D1 描述不批量改写，也不新增跨版本读后转换路径；旧版本图片继续遵守既有引用回收。缺少当前结果时返回 pending，不伪造原 MIME。
- **本地缓存做一次结构失效。**
  新客户端不把旧 IndexedDB 描述当新形状读取；使用一次性的缓存格式/命名空间切换并清理旧记录，继续保留账户隔离、TTL 和授权失效。以后仅增加生成能力，不要求再次更换缓存格式。
- **生成版本不是协议版本。** `version`
  随生成能力和结果重建变化；未来增加视频首帧仍输出已有 image 联合，不因生成版本递增而增加 HTTP 协商、响应结构或前端物料解码分支，类型视觉规则独立于生成版本。
- **旧客户端过渡先核实需求。**
  编码前基于已合入的 PDF 实现确认实际消费者及旧页面恢复要求，在实施契约中确定一个最小过渡策略和退出条件。当前不预定双响应、协商头或
  `Vary`；若确需旧表示兼容，转换只放在统一 API 描述出口，内部只使用新模型。未验证旧页面恢复和真实外部读者前，不宣称可以直接替换上线。

后续基于已合入的 PDF 实现，先刷新现状与确定过渡策略，再开展获准的本项实施，最后在发布授权后部署。PDF 实施完成不等于本 Idea 已被接受；当前仍只修订文档，不自动开始实现或发布。

## 6. 本设计的验证矩阵

| 证明目标           | 最少覆盖                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 原类型与物料解耦   | JPEG → image；PDF → image/null；视频类型 → 模拟 image/null；文本 → markdown；目录 → directory                               |
| 有物料时的类型语义 | 同一 image 物料分别配 PDF、图片及未知类型：PDF 可辨识为文档且页面完整，图片无文档标识，未知类型仍展示物料；无需新增协议字段 |
| 状态诚实           | 拒绝无效 status/preview 组合；图片加载失败回图标；HTTP 错误不转换成成功占位                                                 |
| 信息不丢失         | size 可缺失、目录 total 可缺失、truncated/reason、已识别 MIME 在成功/失败中保留                                             |
| 三类入口一致       | Pin、Publication、节点详情的类型语义与降级一致；公开入口不依赖私有账户缓存                                                  |
| 迁移有效           | 新生成版本重建、旧缓存一次失效、旧 unsupported 不永久遮挡新物料、已确定的旧客户端恢复路径及公开缓存正确性                   |
| 已有安全和体验     | URL/尺寸限制、文本不执行、目录有界、长名称、暗色模式、授权失效清除                                                          |

视频仅验证协议表达与展示，不把模拟图片当作视频首帧生成成功；PDF 首页生成正确性仍由 PDF
Idea 的验证负责。
