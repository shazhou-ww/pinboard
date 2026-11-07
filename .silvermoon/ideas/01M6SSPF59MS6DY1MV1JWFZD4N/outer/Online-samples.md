# 线上 PDF 人工验收样例

## 授权与执行范围

2026-11-07 用户明确要求：“你可以用pinboard的命令，把生成好的文档直接上传上去，然后我在线上点开验收。”

本会话据此通过已认证的 Pinboard
MCP 命令上传以下四份合成文件，只新增这些账户引用；未修改用户既有文件、描述或出版物，未创建云资源、发布标签或重新部署。文件与缩略图均公开，暂时保留供用户检查，不提前移除。

本机 CLI 请求返回 401，未尝试读取或修改凭据；MCP
OAuth 连接正常。MCP 内联上传上限为 2
MiB，因此大样例使用去重 CAR 导入；这与有效 CLI/HTTP 凭据上传普通大文件不是同一测试路径。

## 文件与预期结果

登录 [Pinboard](https://pinboard.shazhou.work/)
后，可按以下文件名在节点列表中检查。前三个链接直接打开本次源文件生成的公开缩略图，不要求登录。

| 文件名                                        | 原文件与传输说明                                                                                              | 服务端结果                                         | 预期与线上缩略图                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PDF-Review-01-large-logical-6MiB-2pages.pdf` | 完整 PDF 为 6,292,377 字节，两页；去重 CAR 3,342 字节、11 个唯一块；账户显示的去重载荷大小可能只有 2,865 字节 | `ready`，200 × 200，WebP 276 字节                  | 首页左红右蓝，第二页是灰阶纹理；[查看首页缩略图](https://pinboard.shazhou.work/ipfs/bafkreie6hfz5ek5iqxt4mis6pzn4ilx3eh2wwknkjc3z7ub75prdm6oycu)   |
| `PDF-Review-02-Chinese-fallback.pdf`          | 1,038 字节，未嵌入中文字体                                                                                    | `ready`，400 × 100，WebP 2,450 字节                | 白底黑字“你好世界”，无方框或缺字；[查看中文缩略图](https://pinboard.shazhou.work/ipfs/bafkreidxzikeiyycwmmz5b5oqgnhegxvtm3pmsmf5x5i7g5q33t544z22y) |
| `PDF-Review-03-rotated-90.pdf`                | 762 字节，页面旋转 90 度                                                                                      | `ready`，200 × 200，WebP 280 字节                  | 上红下蓝；[查看旋转缩略图](https://pinboard.shazhou.work/ipfs/bafkreigpxb3aez6zmj3glvqp42wflgyo6ahwtt7e64balf23c2glivl7j4)                         |
| `PDF-Review-04-form-unsupported.pdf`          | 792 字节，含 AcroForm                                                                                         | `unsupported`，`application/pdf`，没有发布图片描述 | 列表应明确显示不支持/需扁平化，原因为 `PDF forms and XFA require static flattening`，而不是空白图或持续 pending                                    |

前三份预览均为
`version: 2`、`contentType: image/webp`、`truncated: false`。下载线上产物后检查了实际尺寸与字节数，均满足最长边 480px、最大 65,536 字节；本会话目视确认了上述红蓝方向及中文内容。源文件已存在于账户列表，不依赖浏览器本地登录才能上传。

建议用户仅补充卡片层面的观察：找到四个文件，核对前三份缩略图及最后一份明确的提示，刷新后仍能正确显示。现有居中裁切可能裁掉横向中文缩略图的两侧；完整内容以公开缩略图链接为准，不把卡片裁切误认为服务端缺字。

## 可核对的源 CID

| 样例 | 源 CID                                                        |
| ---- | ------------------------------------------------------------- |
| 01   | `bafybeicwarxw5hfwsaow25s552kogzd5vdtih6wlxtaekcyfqm6ncekpmm` |
| 02   | `bafkreihd6ugt2x3givrfd6d44sgfdccmiovx4ex3qnktqndaacgxy4tcda` |
| 03   | `bafkreidoehsizzcnf25gx7ar3jwvvx7pumd3nm5vjjxkiueqo4yarynbca` |
| 04   | `bafkreih7fvqgjqkbj6r6ryo544isejkhszw47abwqonh5q272spkhiwhae` |

大样例在本地先通过 CAR reader 与 UnixFS
exporter 完整还原，逐字节比较等于原 PDF；服务器返回的源 CID 与本地预期相同。构造使用原始红蓝图形和重复灰阶图像字节，没有用户数据、系统字体、外部资源请求或耗尽内存内容。一次较早的 CAR 传输被验证器以 400 拒绝，修正为本地重新验证的归档后导入成功；未把该拒绝当作预览失败或成功上传。

## 证据的适用边界

此大样例验证“较大逻辑文件、非线性化、深层与重复 UnixFS 引用仍可生成首页”，但它的实际去重存储很小，**不是普通 6
MiB 随机内容文件的 R2 流量、CPU 或峰值内存压力证明**。页面数量也只有两页，不宣称覆盖长文档的所有结构。

这些结果补充 [Deployment 记录](./Deployment-verification.md)
的线上生成和视觉证据。尚未完成生产混合并发、实际大体积源读取量、服务器总 isolate 内存与回退检查；表单不支持提示也不等同于原生 abort 后恢复测试。D-* 不因上传成功自动勾选，等待完整证据后再提交外部验收。

## 2026-11-07 用户卡片反馈与 03 复核

用户报告 01、02 已显示，03、04 未成功，并提供实际卡片截图：

- 01、02：用户侧正常显示，中文卡片按既有居中裁切只显示部分字形；完整缩略图内容此前已核实。
- 04：截图显示
  `PDF forms and XFA require static flattening`，与负例预期一致，不是新发现的渲染故障。本样例的通过标准是明确拒绝，而不是显示图片。
- 03：截图显示
  `Unable to load thumbnail. The original is available in details.`。这是真实的用户侧图片加载错误，不能因为后端为 ready 就把整条 UI 验收算作通过。

本会话重新查询 03 描述，仍为 `ready`
且指向同一缩略图 CID。以浏览器常见图片 Accept 请求头获取公开图片得到 HTTP
200、`image/webp`、280 字节；重新计算 CID 与描述相同。独立解码为 200 ×
200，顶部像素为 `(255, 1, 0)`、底部为
`(0, 0, 255)`，方向符合预期。该证据排除了“当前线上没有生成这张旋转图片”，但不能解释用户浏览器最初失败时的响应或网络状态。

检查现有 `Thumbnail`：`onError` 会把本次挂载的 `failed`
状态设为 true，随后不再渲染
`<img>`；该分支没有重新加载动作。因此初次加载失败后，即使网络恢复或服务端已有图片，同一张卡片仍会停留在提示，直到重新挂载或页面刷新。此轮尚未修改该行为，也未将具体首次失败原因推断为 CDN、缓存或格式问题。

共享浏览器连接在本次图片解码探针期间断开，不能据此取得用户页面的 Network 证据或声称已在其浏览器复现。03 继续作为待用户刷新/直接图片访问确认的界面问题，完整 Deployment 验收仍未通过。
