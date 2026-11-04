# Implementation

本契约在准备阶段细化。2026-11-05 用户另行明确要求实现应用代码；这不等于构想获准、理想验收或实施验收。上游 preparing 状态不变，不记录提交、验收或部署生命周期事件。以下区分已执行的本地测试与仍需另行授权的真实客户端、Google 登录和生产迁移检查。

## Steps

### I-S01: 确认授权方案与兼容客户端

依据实施时的 MCP 授权规范，确定授权服务实现或集成方案、客户端识别与注册策略、资源边界和凭据生命周期，并选定可验证的真实 MCP 客户端。复用现有 Google 账户登录作为用户身份来源，不把 Google
access token 当作 Pinboard 凭据。

- 对照 MCP 2026-07-28 授权规范（保留 2025-11-25 发现/PKCE 兼容性）：RFC
  9728 资源元数据、RFC 8414 授权服务元数据、RFC
  7591 公共客户端动态注册、授权码 + 强制 S256 PKCE、RFC 8707
  `resource`。授权服务与受保护资源共用应用的规范来源；Google 仅用于现有网页登录。
- 选定 **Visual Studio Code + GitHub Copilot** 作为部署后真实兼容性验证对象；VS
  Code 官方文档记录了远程 HTTP
  MCP 与 OAuth 支持。具体客户端版本、真实登录及连接结果必须在获授权环境补证，不声称本地测试完成了真实客户端验收。
- 新版规范优先建议 CIMD，DCR 为保留但已弃用的兼容路径。本次明确选择 DCR，不宣称实现 CIMD，不拉取任意远程客户端元数据；客户端需具备 DCR 后备能力。注册响应只授予 authorization_code，不因客户端额外请求 refresh/device
  grant 而增加能力；授权回调加入 `iss` 防混淆参数。
- 当前检索来源：
  [MCP 规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)、
  [VS Code MCP](https://code.visualstudio.com/api/extension-guides/ai/mcp)、
  [VS Code 配置](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)、
  [D1 batch 原子事务](https://developers.cloudflare.com/d1/worker-api/d1-database/)。环境 DNS 阻止直接 web_fetch；使用 web_search 官方公开索引检索相关要求，不绕过阻止。

### I-S02: 接入授权与管理流程

接入授权发现、授权码与 PKCE、浏览器同意、资源绑定的短期 access
token，以及网页客户端授权查看和撤销。若签发 refresh
token，覆盖轮换、重用检测与撤销。OAuth 与 API Token 在同一个 `/mcp`
复用账户和权限校验，保留现有 Token 管理的浏览器会话保护。

- `apps/worker/src/oauth.ts`
  实现发现、公共注册、授权请求、会话同意、换码及授权列表/撤销。新增迁移
  `0004_mcp_oauth.sql`，未应用任何生产迁移。
- 回调精确匹配注册字符串；不接受 fragment、用户信息、空白/控制字符、反斜线、任意 HTTP 地址或通配匹配。仅 RFC
  8252 的数字回环 `127.0.0.1` / `[::1]` 可使用 HTTP，不给 `localhost`
  或其他主机例外。不拉取客户端控制的远程元数据。
- 授权请求 **10 分钟**有效，以 HttpOnly、SameSite=Lax
  cookie 的哈希绑定浏览器；HTTPS 使用 Secure 与
  `__Host-`。查看同意页时绑定现有 Google 会话账户，POST 再核对账户与严格同源 Origin，不能通过换账户或 API
  Token 代替同意。
- 明确展示未验证客户端名称、ID、回调、资源、账户与权限，允许缩减权限；默认仅请求读权限。取消返回
  `access_denied` 而不创建授权；关闭页面也不建立访问权。
- 授权码
  **60 秒**有效；同意事务和换码操作分别使用 D1 原子事务/条件 UPDATE，并发同意或并发换码只有一个成功。校验客户端、精确回调、资源和 S256
  verifier 后清除授权码哈希，防止重放。
- access
  token 为应用生成的随机不透明凭据，仅保存 SHA-256 哈希，**1 小时**有效，绑定账户、所选 scope 和同一个
  `/mcp`。不能用于私有 `/api/*`，更不能管理 Token 或授权。MCP 继续复用
  `PinService` 的账户隔离、读/写/删除权限与原工具 schema。
- **不签发 refresh
  token**；到期后由客户端重新连接、登录并同意。撤销同时废止未换取的授权码与已签发凭据；每次新 MCP 请求读取 D1 状态，已鉴权的在途操作可能完成。
- 网页 `/connect/mcp` 复用现有 Auth.js
  Google 登录；首页单独管理 MCP 客户端授权，与原 API
  Token 管理并列。协议/同意响应禁止缓存和 referrer 泄漏；SPA 静态 `_headers`
  与 HTML referrer meta 补齐资产先行路由的保护。
- 授权/客户端元数据当前不自动清理；公开动态注册消耗 D1 存储。公开上线前应在获授权环境配置边缘限流/滥用防护，不能把本地功能测试当作容量或外部安全验收。

### I-S03: 补齐回归测试与使用文档

增加授权正反向测试，明确 OAuth 和手动 Token 的适用场景、兼容客户端、有效期与撤销行为；保持 CLI
Token 配置兼容并运行项目检查。

- `apps/worker/test/oauth.test.ts` 使用真实 Miniflare
  D1/R2 与合成 Auth.js 会话，运行整个 HTTP 协议和 MCP 工具链；不增加生产登录后门或透传 Google 凭据。
- `apps/web/test/oauth.test.tsx`
  沿用现有 React 服务端渲染测试，覆盖同意内容、权限选择/忙碌状态、未验证名称 HTML 转义及授权列表状态。不是系统浏览器/真实 Google 测试。
- `docs/mcp.md` 与 README 区分交互 OAuth、API Token、CLI、2 MiB
  MCP 内联上传及 API
  Token 专用大文件 HTTP 上传；记录客户端配置、有效期、重新授权与外部验证步骤。
- 保持 Workers compatibility date
  `2026-10-14`；不新增 secret、不提交凭据、不 deploy、不修改 Deployment.md、Idea.md、ledger 或事件。实现子代理未 commit/push；主代理负责独立验收与同步。

## Acceptance criteria

### I-AC01: 授权流程可验证

通过自动化协议测试及浏览器流程夹具证明发现、登录、权限同意和工具调用闭环；拒绝或取消同意时不签发可用授权，并明确真实客户端尚待外部验证。

本地协议夹具覆盖发现 → 注册 → 浏览器绑定请求 → 要求会话 → 明确同意 →
PKCE 换码 → 真实 MCP 工具调用；合成会话仅证明 Google 会话整合边界，不能证明真实 Google 交换。取消/过期请求不建立授权；真实 VS
Code、浏览器登录和 D-AC01 留待部署授权后验证。

### I-AC02: 授权边界不退化

负向测试覆盖 PKCE 校验失败、授权码重放、无效回调地址、错误目标资源、权限不足、跨账户访问、过期与撤销；若有刷新机制，验证轮换及旧 refresh
token 重用被拒绝。访问与刷新令牌不进入 URL，所有凭据不进入日志或仓库。

测试覆盖精确回调、非法回调/重复参数、错误资源/客户端/verifier、授权码到期/重放/ 并发消费、并发同意、浏览器绑定与切换账户、缺 Origin/跨源请求、缩减而不扩大 scope、跨账户 list/revoke/detail/unpin、凭据到期/撤销、OAuth 冒用 HTTP
API、API
Token/OAuth 均无管理权、响应 no-store/no-referrer。没有 refresh 路径；意外错误仅记录固定事件名，不输出异常中的协议值。URL 中的 access_token 不被接受。

### I-AC03: 现有接口保持兼容

API
Token、CLI 配置与环境变量及原有 MCP 工具的回归测试通过，网页会话保护不变；运行
`pnpm check` 并记录结果，环境阻塞必须明确区分于代码失败。

## 本地实际证据（2026-11-05）

- 环境 Node.js 24.12 / pnpm 11.22；默认共享 pnpm store 出现
  `ERR_PNPM_ERR_SQLITE_ERROR: database disk image is malformed`。使用工作树内独立 store 恢复依赖后清理该 store，未修改共享 store 或依赖 manifest/锁文件。
- `pnpm exec turbo run build --filter=@shazhou/pinboard-worker^...`：4 个依赖构建通过；
  `pnpm --filter @shazhou/pinboard-worker build`：Wrangler **dry-run**
  构建通过，无部署。
- Worker/Web `typecheck` 和 `lint` 均通过。
- `pnpm --filter @shazhou/pinboard-worker exec vitest run test\oauth.test.ts`：15 个协议集成测试通过；Web
  `test\oauth.test.tsx`：3 个 UI 测试通过。
- Worker
  6 个非 CLI 套件（oauth、worker、content、gateway、storage、retention）合并覆盖：100
  passed、1 skipped；总体 statements 97.47%、branches 94.91%、functions
  100%、lines 98.15%；`oauth.ts` statements/lines/functions 100%、branches
  98.73%。原 90% 覆盖门槛未放宽。
- `pnpm --filter @shazhou/pinboard-web test`：5 文件、40 测试通过；原覆盖门槛通过。
- Worker 全套：108 passed、1 failed、1 skipped。唯一失败为既有
  `test/cli.test.ts` 的独立凭据写入进程并发测试，Windows 返回
  `UNSAFE_PERMISSIONS`：无法建立/验证当前用户 DACL；单独重跑同一测试仍失败。其余 CLI-Worker 回归通过。初次直接跑 Worker 全套缺少
  `dist/index.js`，先完成上述本地 dry-run 构建后已排除此先决条件。
- `pnpm check`：格式检查、45 个 release 测试通过；Turborepo
  19/20 任务成功，唯一失败是上述既有 Worker CLI 并发 DACL 测试（108 passed、1
  failed、1 skipped）。独立 CLI 套件 147 passed、2 skipped，contracts
  2、encoding 14、Web
  40 均通过；lint/typecheck/build 通过。根脚本因此未继续运行 test:cli-package，不能把整条 pnpm
  check 记为通过。
- 单独运行
  `pnpm test:cli-package`：离线安装真实 tarball 并在仓库外运行的 1 个打包测试通过。
- 主代理独立复验：默认 D 盘根目录重现同一个 CLI DACL 失败；将已有
  `PINBOARD_TEST_ROOT` 设置为
  `C:\Users\Wei\AppData\Local\Temp\pinboard-mcp-oauth-acceptance`
  后，单独凭据并发测试通过，随后完整 `pnpm check`
  **通过**。没有修改权限校验、测试或覆盖门槛。45 个 release 测试、Turborepo
  20/20 任务及最终 CLI 打包测试均成功；Worker 109 passed、1 skipped，Web 40
  passed，CLI 147 passed、2 skipped，contracts 2 passed、encoding 14 passed。
- 主代理在本地 Vite
  preview 的真实浏览器上使用合成 HTTP 响应夹具复验：未登录只显示 Google 登录入口，不显示同意按钮；未验证名称作为文本显示；取消全部权限后禁止允许；缩减为只读后提交
  `approve: true` 与唯一 `pins:read`，到达合成授权码回调；取消提交
  `approve: false` 和空权限，到达 `access_denied`
  回调；授权列表发送 DELETE 并刷新为 Revoked，移除撤销按钮。这些验证运行实际 React 组件和浏览器事件，但 HTTP、账户及回调均为夹具，不构成真实 Google 或真实 MCP 客户端证据。
- 真实 VS
  Code 版本、外部 HTTPS、真实 Google、实际到期/撤销观察和原 Token 客户端的外部结果均**待明确部署/迁移授权后验证**，不以本地证据替代。
