# 2 号文档：现有 preview 如何编码和传递

本文只记录 [Idea](./Idea.md)
的现状事实，目标决策统一见[3 号设计](./03-Normalized-preview-design.md)。业务代码基线为
`7d2508b9148460d869a7aadb195d34ed24d25447`（2026-11-07 同步）。该基线已包含 PDF 首页实现，但尚未包含本 Idea 的统一协议和纸页展示；PDF 的验证结果见其[实施证据](../../../../01M6SSPF59MS6DY1MV1JWFZD4N/outer/inner/Implementation-evidence.md)，不在此替其作部署验收。

## 1. 当前编码：contentType 判别的是物料

[共享契约](../../../../../../packages/contracts/src/index.ts)中的
`ContentPreview` 是 `PreviewPayload` 与状态元数据的交集：

```ts
type PreviewPayload =
  | { contentType: "image/webp"; content: PreviewImage }
  | { contentType: "text/plain" | "text/markdown"; content: string }
  | {
      contentType: "application/vnd.pinboard.directory+json";
      content: { entries: readonly DirectoryEntry[]; total?: number };
    }
  | {
      contentType: "application/vnd.pinboard.file+json";
      content: { size?: number; mediaType?: string };
    };

// 摘要：省略 readonly，DirectoryEntry 代指现有内联目录条目结构。
type ContentPreview = PreviewPayload & {
  version: number;
  status: "pending" | "ready" | "unsupported" | "failed";
  truncated: boolean;
  reason?: string;
};
```

`PreviewImage` 携带缩略图 `cid / url / width / height`。目录条目携带
`name / kind / depth`。

| 当前字段              | 实际含义                               | 局限                                                         |
| --------------------- | -------------------------------------- | ------------------------------------------------------------ |
| `contentType`         | `content` 的序列化/展示类型            | 图片产物固定为 WebP，不能据此知道原文件是 JPEG、PDF 还是视频 |
| `content`             | 图片引用、字符串、目录概要或文件元数据 | “预览物料”和“无物料占位”混在同一联合里                       |
| `content.mediaType`   | 部分文件占位中的原文件 MIME            | 不是顶层统一字段，成功图片和文本描述不携带它                 |
| `status / reason`     | 生成状态与原因                         | 不应在新协议中被空物料抹掉                                   |
| `version / truncated` | 生成描述版本、物料是否截断             | 仍是迁移与有界展示所需的信息                                 |

成功图片返回 `contentType: "image/webp"`
和缩略图引用，原文件 MIME 不随结果保留；无 PDF 物料时返回文件占位 MIME，实际的
`application/pdf` 位于 `content.mediaType`。

PDF 分支在已识别后的 unsupported/failed 结果中保留
`mediaType`，并在逻辑大小可安全表示为 number 时填入
`size`，不要求读完整个文件；其他文件占位仍主要在完整读取时填入大小。成功图片描述不携带这些源元数据。Pin 的块载荷大小与 UnixFS 逻辑文件大小不是同一概念。

## 2. 从生成到显示的完整链路

```text
已授权/可达的源 CID
  → previews.ts: generate / generateFromStore / imageResult / placeholder
  → JSON.stringify(ContentPreview)
  → D1 content_previews.descriptor（另存 status、version、thumbnail_cid 等）
  → getPreview / getPreviews 解析同一描述
  → 单项、批量或节点描述 API 包装
  → 前端请求、校验、可选缓存
  → PreviewContent：先判断 status，再按 contentType 选择展示
```

### 生成和持久化

[生成器](../../../../../../apps/worker/src/previews.ts)识别 PDF 后通过有界文件源调用首页渲染和 WebP 编码，成功时与 JPEG、PNG、WebP 缩略图共用
`imageResult`。PDF 不支持或失败时保留已识别的源元数据；GIF、部分 MP4 和 MP3 仍进入无物料的文件占位。目录输出目录概要。文本经过有界读取、转义或代码围栏处理后，当前生成路径实际输出
`text/markdown`，不能据此判断原文件本来就是 Markdown。

pending 占位通常是文件描述加空
`content: {}`，尚无原类型。failed 的 PDF 和部分图片失败路径能保留 MIME 等元数据，其他路径可能为空。非 file/raw 的已验证 IPLD 内容也会使用文件占位，不能由这个占位断言其原内容就是普通文件。

`processPreview` 将完整描述 JSON 写入 D1，缩略图引用另由
`thumbnail_cid`、`preview_images` 和活跃版本参与发布及回收。

当前 `PREVIEW_VERSION = 2`，同时用于描述中的
`version`、D1 记录选择和任务调度。`getPreview / getPreviews`
只读取当前生成版本，缺少时建立 pending 任务；现有代码没有跨版本读取并转换旧描述的步骤，也没有 HTTP 表示版本协商。

### API 如何包装

| 入口                                                 | 当前返回形状                                           | 实际消费                          |
| ---------------------------------------------------- | ------------------------------------------------------ | --------------------------------- |
| `GET /api/pins/:cid/preview`                         | `ContentPreview`                                       | 私有单项接口                      |
| `POST /api/pins/previews`                            | `{ previews: [{ cid, preview } 或 { cid, error }] }`   | Pin 卡片的批量请求                |
| `GET /api/public/publications/:id/preview/:revision` | `ContentPreview`                                       | Publication 卡片，公开缓存与 ETag |
| 私有/公开节点描述接口                                | `{ rootCid, nodeCid, description: { user, preview } }` | 节点详情的 system preview         |

证据：[私有 API](../../../../../../apps/worker/src/api.ts)、[批量服务](../../../../../../apps/worker/src/service.ts)、[公开 API](../../../../../../apps/worker/src/publication-api.ts)、[节点描述](../../../../../../apps/worker/src/descriptions.ts)。

HTTP `Content-Type: application/json` 是响应编码，与 JSON 内的 `contentType`
不是同一个层次。批量项的 404 是 API 错误，不是 unsupported 生成状态。

### 前端校验、缓存和渲染

- [PreviewClient](../../../../../../apps/web/src/preview-client.ts)校验批量响应，按账户和 CID 隔离持久缓存；仅缓存 ready、unsupported，401/403/404 会使旧缓存失效。
- [缓存校验](../../../../../../apps/web/src/preview-cache.ts)按旧 `contentType`
  验证
  `content`，检查图片 URL、尺寸、目录层级和条目数量等。unsupported 新鲜期为 5 分钟，其余为 1 小时；保留期为 7 天。
- [PinPreview / PreviewContent](../../../../../../apps/web/src/pin-preview.tsx)先对非 ready 状态输出提示及部分文件元数据，再按物料
  `contentType` 渲染。图片加载失败目前输出文字，不会显示文件类型图标。
- [PublicationPreview](../../../../../../apps/web/src/publications.tsx)和[节点详情](../../../../../../apps/web/src/node-description.tsx)也复用
  `PreviewContent`，但请求路径不同，不是都通过同一个 PreviewClient。
- 三类入口使用[共享轮询规则](../../../../../../apps/web/src/preview-poll.ts)区分 pending 与已安排重试的 failed；生成状态还承担调度职责，并非仅是显示文案。
- [卡片布局](../../../../../../apps/web/src/styles.css)把图片铺满预览区，并用底部信息条覆盖其上；当前尚未按 PDF 原类型预留纸页可见区域。
- [开发预览数据](../../../../../../apps/web/src/dev-preview-data.ts)与[开发 API](../../../../../../apps/web/src/dev-preview.ts)也构造旧描述和对象 URL。

## 3. 已实现的 PDF 首页如何编码

[PDF Idea](../../../../01M6SSPF59MS6DY1MV1JWFZD4N/outer/inner/ideal/Idea.md)已定义首页缩略图边界；其[架构设计](../../../../01M6SSPF59MS6DY1MV1JWFZD4N/outer/inner/ideal/Architecture-review.md)规定 PDF 渲染模块返回 RGBA，像素编码模块输出 WebP，CID、URL 和描述由现有 preview 编排负责。

当前代码已通过 `renderPdf → encodeRaster → imageResult`
接入该路径。PDF 首页与普通图片均返回
`contentType: "image/webp"`，成功响应中不再保留原内容是 PDF 的身份。因而不能只在前端从现有成功描述推断 PDF 外观；目标协议需要由编排明确保留源类型。
