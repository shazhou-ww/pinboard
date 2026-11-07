# 3 号文档：统一 content type 与 Preview 物料

本文是 [Idea](./Idea.md)
的唯一目标设计说明，与[2 号现状编码](./02-Current-preview-protocol.md)对照。2026-11-07 同步最新主线后收敛 MVP：PDF 采用方案 A「悬浮纸页」，直接切换新协议，图片加载失败按正常渲染规则回类型图标。[PDF 首页实现](../../../../01M6SSPF59MS6DY1MV1JWFZD4N/outer/inner/Implementation-evidence.md)已合入，本轮只更新文档，不开始编码或替其作部署验收决定。

## 1. 决策：展示载荷只有两个维度

1. `contentType`：原内容的类型，参与有物料和无物料时的视觉语义，不是缩略图或文本摘要的输出格式。
2. `preview`：可空的预览物料，用独立的判别联合选择基础渲染器。

两项共同决定最终 UX：有可用物料时，由物料选择基础渲染器，再由原类型调整标识与外观；没有可用物料时，使用原类型图标。`contentType`
不只是 fallback 的输入。图片加载失败也属于当前没有可用物料，fallback 是类型封面而不是错误界面。生成状态、原因、版本和截断信息保留在外围，不成为第三种物料。

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

## 2. 现有字段与目标结构对照

下表说明新结果如何表达相同信息，不要求提供新旧格式转换层；一次性切换策略见第 5 节。

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

| 原类型与物料                              | 基础渲染       | 类型相关的 UX                                                     |
| ----------------------------------------- | -------------- | ----------------------------------------------------------------- |
| `image/*` + image                         | 共享图片渲染器 | 普通图片展示，不增加文档标识                                      |
| `application/pdf` + image                 | 同一图片渲染器 | 采用方案 A「悬浮纸页」：完整首页、轻边框与阴影、左上角小 PDF 标识 |
| 已识别的视频类型 + image                  | 同一图片渲染器 | 可叠加非交互的视频类型标识；不暗示已经支持播放                    |
| 未知类型或未定义视觉变体 + 任意已支持物料 | 对应物料渲染器 | 使用中性默认外观，仍显示物料，不因缺少类型样式退回图标            |
| 任意类型 + 无可用物料                     | 类型封面       | 已知类型图标，或通用内容图标                                      |

### PDF：方案 A「悬浮纸页」

- 在卡片内使用中性背景，首页截图像一张纸置于其中，四周留白，配细边框与轻阴影；保留截图本身的颜色，不把页面重绘或染成主题色。
- 保留真实页面比例，完整展示首页，不使用照片式居中裁切。横版页面按自身比例呈现，不强制变成竖纸；缩略图用于辨认内容，不承诺卡片内可阅读所有小字。
- 小型 `PDF`
  标识放在卡片左上角留白区，不在底部信息条下，也不覆盖正文；类型不只靠颜色表达，保留可读与可访问名称。已有 Publication 标记保留独立位置，二者不互相遮挡。
- 共享展示边界包括外层布局：纸页在扣除类型标识和底部信息条后的可见区域内排布，信息条展开、键盘聚焦和触屏状态下仍不遮住页脚。不是只给内部图片设置
  `contain`。
- Pin、Publication 和节点详情保持同一纸页语义，可按各自容器适配尺寸；普通图片保持现有图片外观，不附加文档装饰。

MVP 不实现页签式文档框、局部阅读窗口、翻页、书脊、模拟页数或复杂动画。颜色、留白和阴影的具体值沿用现有设计语言，在实施时验证，不增加可配置主题系统。

前端在共享展示入口组合物料渲染与少量类型视觉规则，不为每种 MIME 建整套卡片，也不建设主题插件框架。API 仍只传原类型与物料，不新增
`presentationKind`、图标名、布局提示等可推导字段；装饰不烧录进缩略图，也不影响其 CID、缓存或生成器。`contentType`
只能调整视觉，不能绕过物料 kind 的校验、执行原文件，或增加尚不存在的阅读/播放能力。

### Fallback 是渲染规则

| 物料/状态                                     | 主展示                           | 状态处理                                                         |
| --------------------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| 有可用 image/text/markdown/directory 物料     | 物料与原类型共同呈现             | 原类型未知时使用中性外观，不遮挡物料                             |
| 无物料，pending / unsupported / failed        | 同一类型封面，未知类型用通用图标 | 保留各状态、原因及原有轮询/重试语义，不把封面标成生成成功        |
| 图片 URL 加载失败                             | 回退同一类型封面                 | 不改写服务器生成状态，不在预览区新增失败文案、红色警告或重试按钮 |
| 预览描述 API 返回 401/403/404，或内容身份变化 | 清除不再有效的旧展示             | 保留已有授权和请求错误处理，不能用图标冒充合法结果               |

MVP 不新增独立的加载失败提示 UX，也不将错误文案移到另一个新界面。已有诊断日志与 API 错误处理保留，类型封面不承担错误通知职责。缩略图的
`onError`
只说明物料当前不可用，不能据此推断描述访问权限失效；无效协议仍由共享校验显式拒绝，不能静默转换为正常文件结果。

后台刷新时可保留同一源 CID 的有效旧快照，不得跨账户、跨内容身份复用；物料重新可用后正常恢复展示，不把一次加载失败持久化为永久 fallback。状态用于生成、轮询与诊断，不要求另外展示状态文案，也不引入第二套“可否预览”标志。

类型封面沿用 Phosphor 图标与简短类型标签，不重复信息条的名称、大小。详情可继续显示 MIME 和可靠大小，但不为本 MVP 新增失败提示。目录、文本保持专用物料展示；PDF 有截图时是纸页，无截图或截图加载失败时是 PDF 图标，表达的是同一种内容身份。

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

## 5. MVP 直接切换与一次性迁移

当前数据为测试数据，直接切换到新结构；不维护向前或向后的协议兼容，不支持旧客户端继续消费新响应，也不把跨版本预览数据回退列为 MVP 验收门槛。

- **单一协议。**
  前后端、开发样例及共享校验一起更新；旧页面刷新到新客户端即可，不增加协商头、双响应、兼容窗口或旧表示适配器。
- **服务端优先复用重建。** 从同步基线的 `PREVIEW_VERSION = 2`
  递增生成版本，沿用既有入口和有界调度生成新形状。缺少当前结果时返回 pending，由类型封面承接；旧描述不当新数据读取。既有重建足够时，不另写迁移脚本。
- **缓存一次失效。**
  新客户端切换缓存格式/命名空间并清理旧描述，保留账户隔离、TTL 和授权失效。不能只等旧 unsupported 自然过期，也不继续展示格式不兼容的旧快照。
- **必要时只做一次性处理。**
  若实施证明需要额外迁移或清理，只限定在预览派生记录、相关引用和缓存，遵守既有图片引用回收；不修改或删除原始文件、CAR、Pin、Publication 或授权数据。
- **生成版本不是协议协商。**
  后续增加视频首帧仍输出 image 物料，不因生成版本递增而增加 HTTP 协商、改变缓存格式或新增物料解码分支；视觉规则也不依赖生成版本。

当前只更新文档；基于同步后的 PDF 实现开展获准的本项实施，再在单独发布授权后部署。一次性数据处理的方案不等于执行授权；涉及生产操作或数据库 schema 迁移仍需分别获得许可。

## 6. 本设计的验证矩阵

| 证明目标                | 最少覆盖                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 原类型与物料解耦        | JPEG → image；PDF → image/null；视频类型 → 模拟 image/null；文本 → markdown；目录 → directory                                     |
| 有物料时的类型语义      | 同一 image 物料分别配 PDF、图片及未知类型：PDF 是悬浮纸页并有左上角小标识，图片无文档装饰，未知类型仍展示物料；无需新增协议字段   |
| 卡片可见区域            | 竖页、横页、底部信息条展开、键盘聚焦和触屏状态下，纸页与类型标识不被遮挡；暗色模式不改变截图本身颜色                              |
| 状态诚实与正常 fallback | 拒绝无效 status/preview 组合；图片加载失败回类型图标且无新增失败提示，物料重新可用后恢复；描述 API 错误不转换成成功占位           |
| 信息不丢失              | size 可缺失、目录 total 可缺失、truncated/reason、已识别 MIME 在成功/失败中保留                                                   |
| 三类入口一致            | Pin、Publication、节点详情的类型语义与降级一致；公开入口不依赖私有账户缓存                                                        |
| 一次性切换有效          | 新生成版本重建、旧缓存一次失效、刷新后的客户端只消费新结构、公开缓存正确；旧 unsupported 不永久遮挡新物料，原始内容与授权不受影响 |
| 已有安全和体验          | URL/尺寸限制、文本不执行、目录有界、长名称、暗色模式、授权失效清除                                                                |

视频仅验证协议表达与展示，不把模拟图片当作视频首帧生成成功；PDF 首页生成正确性仍由 PDF
Idea 的验证负责。
