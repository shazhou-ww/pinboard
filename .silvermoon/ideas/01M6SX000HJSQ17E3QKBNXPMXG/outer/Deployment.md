# Deployment

本阶段交付已验收实现的实际生产结果，不修改已接受的 Inner/Ideal World。
`implementationRevision = 0cc4c3764f9b3105c20e0d32a36a81329bfb5fcf`，acceptInner 已在 primary
commit `efff42cd011ea672c73461e960a9f7decc7669d6`
生效。发布遵守[部署指南](../../../../docs/deployment.md)和现有
`deploy-cloudflare.yaml`，目标为 Cloudflare account
`92c3c4fdcc84a1590555bccf4f111de2` 的既有 Worker `pinboard` /
`https://pinboard.shazhou.work`。

用户已授权应用发布；**本合同必须先由父 Agent 同步到 primary，再取得父 Agent 对准确 deploymentRevision 与 release
commit 的执行放行，才可创建或推送 release tag。**
父 Agent 负责文件同步、submitOuter 和 deployment
acceptance；执行 Agent 不代记任何门限事件。当前只准备合同，所有 D-* 保持未完成。

不授权也不需要 schema
migration、生产 SQL、purge、手动 backfill、新资源或权限扩展。协议直接切换为 v3，依赖既有入口/cron 的有界 lazy
rebuild；不转换旧服务端描述，不设置旧客户端兼容窗口，不删除原文件、CAR、Pin、Publication 或授权记录。

## Steps

### D-S01: 确认发布与一次性切换

1. 放行后刷新 primary 和远端 release tags。记录父 Agent 指定的准确 release
   commit、已同步合同的 deploymentRevision、该 commit 对应的成功 CI
   run，以及发布前实际 Worker version/tag。确认 release commit 已在
   `origin/main`，包含已接受实现和本合同；不把更早 commit 的绿色 CI 当作候选通过，也不自行改用并发出现的其他候选。
2. 选执行时采用的有效日历日期，重新核对该日期的全部远端标签，使用下一个未占用
   `release-YYMMDD-INDEX`；例如本次日期可为
   `261108`，INDEX 不预先假定。只在放行的 commit 上创建 annotated
   tag 并推送该单个 tag。不创建 release
   branch、改版本、推送业务文件、重写已有 tag、直接运行生产 Wrangler
   deploy 或使用手动部署入口。
3. 等待该 tag 的 `Deploy to Cloudflare` workflow 完成。记录 run
   URL/ID、tag 对象与 peeled commit、结论、实际部署的 Worker version
   ID 和时间；以成功部署日志及只读当前 deployment/version 记录核对正在服务的版本，不能仅凭标签存在或上传成功认定发布完成。同时核对生产健康响应、当前 HTML/资源指纹和 v3 描述，证明新前后端一起生效。
4. 数据切换只由应用正常访问触发。旧内容首次访问可能 pending，按现有重试/轮询边界等待终态，不通过 SQL 强制改状态或批量清空预览。用刷新后的客户端实测 IndexedDB
   v1→v2 一次失效，验证旧结构不被读取、第二次刷新不再清空新结构；具体证据边界见 D-S02。

若 CI、部署或身份/资源核对失败，保留证据和未完成项，停止继续发布并交父 Agent 处理；不自动回滚到旧协议应用，不为了完成门限扩大权限、修改 schema 或清除内容。

### D-S02: 验证真实环境展示与恢复

仅执行本次统一预览所需的小规模冒烟，不重跑不相关的历史 OAuth、Kubo、限流或资源压力验收。真实结果记录在本 Outer
World 的 `Deployment-evidence.md`
及必要截图/响应摘要中，带执行时间、准确版本/源 CID、URL、命令结果、真实与模拟边界；不记录凭据。

- **真实私有与公开描述。** 使用现有已认证 Pinboard
  MCP 读取明确的合成 PDF 节点，不读取或复制 token/cookie。核验生成版本 3、原始
  `application/pdf`、ready+image，以及原有表单 PDF 的 unsupported+null；已识别失败保留 MIME/原因，不把失败包装成 ready。通过正常 authenticated
  API/MCP 最多新增两份明确命名 `Unified-preview-smoke-*` 的合成横/竖 PDF
  Pin 和两份对应 Publication，不发布私人数据。公开 Publication
  preview 与公开节点描述必须返回同一规范化模型，图片 URL/尺寸仍受既有限制；没有旧 content/mediaType 字段。这些 API 响应与 PDF 生成必须来自真实部署，不用本地 Worker 或响应替身代替。
- **原内容与授权未改变。** 重取已有中文 PDF
  `bafkreihd6ugt2x3givrfd6d44sgfdccmiovx4ex3qnktqndaacgxy4tcda`
  的原始 HTTP 字节，与父 Agent 已记录的 1,038 字节及 SHA-256
  `e3f50d3d5f66456251f87ce48c51884c43ab7e12fb8355383460008d7c726218`
  比较；记录本次新建合成源的预期 CID/大小/哈希与线上读回的一致性。对同一源的私有 preview/节点路由做无凭据真实 HTTP 读取，仍须被 401 拒绝；MCP 可读与公开 Publication 可读不等于取消私有授权。既有[PDF 样例](../../01M6SSPF59MS6DY1MV1JWFZD4N/outer/Online-samples.md)
  及用户 Pin/Publication 均只读，不修改、删除或转换。新建合成引用记录准确 ID/CID 并保留供父 Agent 验收，不自动清理或 purge。
- **真实已部署界面。** 用实际生产 HTML/JS/CSS 打开新建 Publication `/p/:id`
  及其公开节点描述，真实加载生产生成的首页图；观察横竖纸页完整比例、中性背景、轻边框/阴影及左上 PDF 标识。卡片场景验证 PDF 标识与独立 Publication 标记、底部信息条在展开/聚焦/触屏时互不遮挡。至少覆盖桌面、390px 和 320px；同时记录 viewport、document/body
  clientWidth/scrollWidth、grid
  track、card/info 边界，不能只检查图片位于纸页容器内。
- **受控图片失败与恢复。**
  只在会话隔离的浏览器中拦截选定 thumbnail 的图片请求，不删除生产图片或篡改生成状态。验证已部署共享渲染转为普通 PDF 图标封面，没有失败文案、红色警告或重试按钮；解除拦截并刷新后真实图片恢复，不留下永久失败缓存。对实际 API 的拒绝/协议异常仍保留错误，不当作正常图标成功。
- **本地缓存与无浏览器登录的边界。**
  一次性切换检查使用会话隔离的浏览器 profile，预置本机 IndexedDB
  v1 的合成旧记录，再运行已部署客户端：数据库升级为 v2，旧 sentinel/旧结构条目消失，新规范化条目可写入且刷新后保留。若浏览器仍无 OAuth 登录，可仅为墙卡片/缓存触发提供合成账户 shell、所选合成 Pin 列表与私有批量描述的受控浏览器 transport；数据取自前述真实公开描述，不替换已部署代码/CSS，Publication
  preview、公开节点和图片仍访问真实生产接口。必须将这一部分标为“已部署客户端 + 本机身份/私有 transport 夹具”，不声称完成真实浏览器登录或私有 HTTP 认证；真实私有访问由 MCP 和真实无凭据拒绝分别证明。
- **主题边界。**
  产品现有 palette 为浅色。验证实际暗色 OS 偏好时如实记录仍为浅色；若额外注入深色 token，只标为深色表面压力模拟，不把它当作新增暗色主题或生成能力。不新增视频样例/解码，也不把本地截图当作线上证明。

## Acceptance criteria

### D-AC01: 发布版本与一次性切换可核验

证据可把父 Agent 放行的 primary SHA、该 SHA 的绿色 CI、下一未占用 annotated
tag、成功部署 run、正在服务的 Worker version
ID 与真实生产前后端响应串联为同一次发布；当前协议为 v3，旧服务端描述没有混读。受控本机旧缓存由实际已部署客户端一次失效，后续刷新保留规范化缓存，且清楚区分 browser
transport 夹具与真实私有授权证据。没有执行 schema/SQL/purge、手动迁移或资源创建，既有原内容/引用与授权边界未改变；不以兼容旧客户端或跨协议回滚作为通过条件。

### D-AC02: 线上物料与图标切换符合约定

真实 MCP、公开 Publication/节点描述及原文件读回证明源 MIME、物料和状态准确，合成横竖 PDF 在实际生产渲染代码中呈现为完整悬浮纸页。桌面与 390px/320px 的卡片/信息条不超 viewport/track，也不覆盖页面或类型标识；受控图片请求失败只改变本次浏览器展示为类型图标，无新增失败 UX，解除拦截并刷新后真实物料恢复。真实无凭据私有请求仍被拒绝。证据明确标注卡片/缓存 transport 夹具、深色模拟与真实公开页面，不以未执行检查或模拟响应冒充生产生成、浏览器 OAuth 或产品暗色主题。以上 D-* 只在对应证据完成后勾选，最终部署验收仍由父 Agent 对准确 deploymentRevision 作出。
