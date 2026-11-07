# 2 号文档：现有 preview 如何编码和传递

本文是 [Idea](./Idea.md) 的现状证据，供[3 号设计](./03-Normalized-preview-design.md)对照。业务代码基线为 `ab0d6ed31426c2fbeca5feca47ab4cef81393e02`；以下不是新协议，也不表示 PDF 首页已经实现。

## 1. 当前编码：contentType 判别的是物料

[共享契约](../../../../../../packages/contracts/src/index.ts)中的 `ContentPreview` 是 `PreviewPayload` 与状态元数据的交集：

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

`PreviewImage` 携带缩略图 `cid / url / width / height`。目录条目携带 `name / kind / depth`。

| 当前字段 | 实际含义 | 局限 |
| --- | --- | --- |
| `contentType` | `content` 的序列化/展示类型 | 图片产物固定为 WebP，不能据此知道原文件是 JPEG、PDF 还是视频 |
| `content` | 图片引用、字符串、目录概要或文件元数据 | “预览物料”和“无物料占位”混在同一联合里 |
| `content.mediaType` | 部分文件占位中的原文件 MIME | 不是顶层统一字段，成功图片和文本描述不携带它 |
| `status / reason` | 生成状态与原因 | 不应在新协议中被空物料抹掉 |
| `version / truncated` | 生成描述版本、物料是否截断 | 仍是迁移与有界展示所需的信息 |

### 当前成功图片

以下 JSON 是字段示意，CID 及 URL 不是实际可请求样例：

```json
{
  "version": 1,
  "status": "ready",
  "contentType": "image/webp",
  "content": {
    "cid": "<thumbnail-cid>",
    "url": "/ipfs/<thumbnail-cid>",
    "width": 480,
    "height": 320
  },
  "truncated": false
}
```

这个响应只能证明有一张 WebP 预览物料，不能证明原文件是 WebP。

### 当前没有 PDF 物料

```json
{
  "version": 1,
  "status": "unsupported",
  "contentType": "application/vnd.pinboard.file+json",
  "content": { "mediaType": "application/pdf", "size": 1024 },
  "truncated": false,
  "reason": "No supported lightweight preview for this content"
}
```

其中 `size` 是示意：现有生成器只在已读取完整文件时填入该字段，并非所有文件都返回大小。不能把 Pin 的块载荷大小直接等同于 UnixFS 逻辑文件大小。

## 2. 从生成到显示的完整链路

```text
已授权/可达的源 CID
  → previews.ts: generate / description / placeholder
  → JSON.stringify(ContentPreview)
  → D1 content_previews.descriptor（另存 status、version、thumbnail_cid 等）
  → getPreview / getPreviews 解析同一描述
  → 单项、批量或节点描述 API 包装
  → 前端请求、校验、可选缓存
  → PreviewContent：先判断 status，再按 contentType 选择展示
```

### 生成和持久化

[生成器](../../../../../../apps/worker/src/previews.ts)用文件头识别 JPEG、PNG、WebP，成功后输出统一 WebP 缩略图；PDF、GIF、部分 MP4 和 MP3 识别结果进入文件占位的 `mediaType`。目录输出目录概要。文本经过有界读取、转义或代码围栏处理后，当前生成路径实际输出 `text/markdown`，不能据此判断原文件本来就是 Markdown。

pending 占位通常是文件描述加空 `content: {}`，尚无原类型。failed 只有部分图片失败路径能保留 MIME 等元数据。非 file/raw 的已验证 IPLD 内容也会使用文件占位，不能由这个占位断言其原内容就是普通文件。

`processPreview` 将完整描述 JSON 写入 D1，缩略图引用另由 `thumbnail_cid`、`preview_images` 和活跃版本参与发布及回收；协议调整不能只改 JSON 而忘记图片引用关系。

### API 如何包装

| 入口 | 当前返回形状 | 实际消费 |
| --- | --- | --- |
| `GET /api/pins/:cid/preview` | `ContentPreview` | 私有单项接口 |
| `POST /api/pins/previews` | `{ previews: [{ cid, preview } 或 { cid, error }] }` | Pin 卡片的批量请求 |
| `GET /api/public/publications/:id/preview/:revision` | `ContentPreview` | Publication 卡片，公开缓存与 ETag |
| 私有/公开节点描述接口 | `{ rootCid, nodeCid, description: { user, preview } }` | 节点详情的 system preview |

证据：[私有 API](../../../../../../apps/worker/src/api.ts)、[批量服务](../../../../../../apps/worker/src/service.ts)、[公开 API](../../../../../../apps/worker/src/publication-api.ts)、[节点描述](../../../../../../apps/worker/src/descriptions.ts)。

HTTP `Content-Type: application/json` 只是响应编码，与 JSON 内的 `contentType` 不是同一个层次。批量项的 404 也是 API 错误，不能变成 unsupported 文件卡片。

### 前端校验、缓存和渲染

- [PreviewClient](../../../../../../apps/web/src/preview-client.ts)校验批量响应，按账户和 CID 隔离持久缓存；仅缓存 ready、unsupported，401/403/404 会使旧缓存失效。
- [缓存校验](../../../../../../apps/web/src/preview-cache.ts)按旧 `contentType` 验证 `content`，检查图片 URL、尺寸、目录层级和条目数量等。unsupported 新鲜期为 5 分钟，其余为 1 小时；保留期为 7 天。
- [PinPreview / PreviewContent](../../../../../../apps/web/src/pin-preview.tsx)先对非 ready 状态输出提示及部分文件元数据，再按物料 `contentType` 渲染。图片加载失败目前输出文字，不会显示文件类型图标。
- [PublicationPreview](../../../../../../apps/web/src/publications.tsx)和[节点详情](../../../../../../apps/web/src/node-description.tsx)也复用 `PreviewContent`，但请求路径不同，不是都通过同一个 PreviewClient。
- [开发预览数据](../../../../../../apps/web/src/dev-preview-data.ts)与[开发 API](../../../../../../apps/web/src/dev-preview.ts)也构造旧描述和对象 URL，迁移时需要同步。

## 3. 与正在实施的 PDF 首页方案的关系

[PDF Idea](../../../../01M6SSPF59MS6DY1MV1JWFZD4N/outer/inner/ideal/Idea.md)已定义首页缩略图边界；其[架构设计](../../../../01M6SSPF59MS6DY1MV1JWFZD4N/outer/inner/ideal/Architecture-review.md)计划复用现有图片发布路径，不把 PDF 状态扩散到前端。

在旧协议下，PDF 首页一旦成功，会像普通图片一样成为 `contentType: "image/webp"`。这足以显示首页，但无法持续携带“原内容是 PDF”的身份。新设计应保留这个复用方向，同时补上原类型与物料的分离；本 Idea 不接管 PDF 渲染实现。
