# 实现证据

## 设计与一致性边界

- 所有公开上传入口继续使用同一
  `PinService`；file、block、CARv1/v2 先校验 CID 和完整闭包，再归一化为一个 CARv1。新数据不另存全套独立块。
- R2 键为 CAR 字节的 SHA2-256 CID，D1 `car_dags` 登记根、对象和长度，
  `car_blocks`
  登记归一化 CID、对象、载荷偏移和长度。相同内容重试复用对象；每个包内去重，不承诺不同根之间的全局载荷去重。
- 完整对象 PUT 后，两个 SQL statement 在同一 D1
  batch 中发布根和全部块位置，然后保存账户 pin。块行通过一个绑定 JSON 参数展开，256 块也不产生逐块 SQL 往返。根整包下载为一个 D1 查询和一个 R2
  GET，直接返回对象流，不遍历或重新编码。
- 单块为索引查询加精确 R2
  Range；HEAD、条件命中和 provider 查询只读对象元数据。空块不用非法零长 Range。旧 CID 键、混合 DAG 和未登记子 DAG 保留兼容读；显式 pin 后可直接整包读取，旧对象不被删除。
- 跨产品非原子窗口明确保留：D1 失败可能留下无索引 CAR，pin 保存失败或提交响应丢失可能留下完整公开内容。失败请求不宣称成功；相同上传幂等重试恢复。不做失败删除补偿，防止误删并发写入或响应丢失但已提交的数据。
- 索引对象缺失、截断或返回错误范围时失败关闭并返回 503；客户端仍需核验 CID，元数据不能发现等长的带外内容损坏。unpin 只删账户引用，无物理 GC。孤儿清理需另行授权、暂停写入并核对所有 manifest，而不是只看仍有 pin 的根。

实现与运行边界详见 `apps/worker/src/storage.ts`、
`apps/worker/migrations/0002_car_storage.sql` 和 `docs/storage.md`。

## 同样本存储放大对照

2026-11-04 在本机 Miniflare 的真实 R2/D1 绑定执行。
`apps/worker/test/storage.test.ts`
的旧格式基线复现改造前逐块 PUT、HEAD、闭包逐块 GET 和 CAR 编码逻辑，使用独立本地桶存储同一 DAG；新格式通过可计数绑定和编码函数 spy 验证。基线不是生产时延测量。

| 样本                                            | 旧格式                                             | CAR 索引格式                                                          | 取舍                                                                        |
| ----------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 64 个小文件，65 块，DAG 4,080 字节              | 65 个数据 PUT；导出 1 HEAD + 65 GET；R2 4,080 字节 | 1 PUT；导出 0 HEAD + 1 GET；R2 6,545 字节；65 个块索引行              | R2 字节增加 2,465（60.4%）；读取请求不再随块数增长                          |
| 3 MiB + 137 字节文件，14 块；DAG 3,146,522 字节 | 导出 14 个数据 GET                                 | 导出 1 GET；CAR 3,147,125 字节                                        | 相比原 DAG 仅多 603 字节（约 0.0192%）；原文件 3,145,865 字节逐字节重建一致 |
| 两个共享同一叶块的 DAG，3 个不同块              | 独立块去重后 189 字节                              | 两个完整 CAR 共 469 字节；共享块载荷重复 14 字节；全局索引只保留 3 行 | 增加 280 字节，含重复载荷及 CAR/根元数据；不宣称全局包间去重                |

小文件样本的块位置行导出 JSON 为 12,351 字节；同一测试 D1 `meta.size_after`
的本地数据库增长为 28,672 字节，包含表、索引和页分配效应。前者不是 SQLite 磁盘大小，后者不是生产 D1 计费估算，也不能线性外推到每块成本。索引和 CAR
framing 对微小文件显著，不把减少 R2 请求等同于总存储字节下降。写入另有一个包含两个 statement 的 D1 事务和账户 pin 写入；读取另有 D1 索引查询。

## 自动化覆盖

存储专用套件验证：

- 65 块所有载荷偏移由独立 `CarReader` 逐块复核；直接导出不调用 `encodeCar`。
- file、raw 父块引用既有子块、CARv2、CIDv0、空块及 256 块上限。
- 目录、多块文件、同 DAG 重试、共享块、并发相同上传以及跨账户 pin 隔离。
- 旧独立块、混合 DAG、旧内容重新 pin 后打包、unpin 后公共内容保留。
- 索引 raw GET/HEAD、弱 ETag
  304、安全头和 provider 语义；既有网关完整协议套件仍保留。
- R2
  PUT 异常，真实 D1 第二条 statement 失败回滚、孤儿幂等重试，数据库已提交但响应丢失、pin 保存失败及重试，以及丢失/截断对象和错误 Range 响应。

可复现命令：

```powershell
pnpm exec turbo run build --filter=@workspace/encoding --filter=@workspace/cli
$env:PINBOARD_TEST_KUBO = "1"
pnpm --filter @workspace/worker exec vitest run test\storage.test.ts --disableConsoleIntercept
Remove-Item Env:\PINBOARD_TEST_KUBO
```

2026-11-04
20:10（UTC+8）存储套件 13 项全部通过；同次 content、gateway、worker 和 storage 合计 61 项通过，覆盖率为 statements
96.67%、branches 95.33%、functions 100%、lines 97.27%。

独立 Kubo 验证使用新建空白离线 repo，导入从存储读回的 CAR，通过
`ipfs cat --offline` 重建嵌套多块二进制文件、空文件和文本文件：

- 根：`bafybeidiftokdsuxuwhe55nhqo3ae66p5wu5s3i7qhtrcazcgfmz2sxlqe`
- 块数：10；文件数：3；文件总字节：1,048,633。
- 三个文件逐字节一致；不访问生产、不依赖来源节点或远程拉取。
- 项目内 `.car-storage-kubo` 测试目录已由测试清理。

另执行已有
`pnpm test:kubo`，为本机提供 Git 安装所带的 OpenSSL 路径，不安装或升级依赖。PoC 现使用项目内临时工作目录及新增本地 D1 绑定，先应用两份本地迁移；没有生产连接或未认证生产入口。Kubo
0.43.1 的来源 daemon 在上传前停止，三个全新冷客户端分别通过 HTTP/2 provider
routing 完成 `cat`、`get` 和浏览器目录 `get`：

- 来源目录：`bafybeighwbotmoqto263xmqxoi42kqixjvzqvuoegsitqzajbvmyh7oqhm`，16 块，DAG
  3,146,662 字节。
- 浏览器编码目录：`bafybeiaslcqyucdvib6inc43d7adnstrowhboz76yfzzgyxglypu3cotsa`，18 块，DAG
  3,146,769 字节。
- 三个客户端重建同一随机公开测试 payload，其 SHA-256 均为
  `679031ae41bb0d1596b636b5c86acd641a785b1a1b795c18d5bd50b436d878c4`；共 58 次 HTTP/2 请求、3 次 probe，全部通过。
- PoC 自身进程和项目内 `.kubo-poc-*`
  工作目录已清理；此处随机样本不用于前后空间对照。

## 仓库检查状态

所有本次修改文档均经过 Prettier；Worker
lint、typecheck、build 和专用存储套件通过。合入并行 CLI 修复
`006e56fc2470c5732158c482f52f66589e8b1ac3` 后，完整默认 `pnpm check`
的 20 项 Turbo 任务中 19 项通过；唯一失败为 Worker CLI 集成的独立凭据写入进程
`serializes real independent credential writers without losing endpoint entries`
返回 `UNSAFE_PERMISSIONS`。未跳过该测试、未降低 ACL 要求，也未修改 CLI 源码。

对应上游 CI
[41825511934](https://github.com/shazhou-ww/pinboard/actions/runs/41825511934)
同样失败，Windows Node 22 的 PowerShell ACL helper 出现 `killed: true`、
`signal: SIGTERM`。已将精确失败交由 CLI 工作所有者处理。另尝试仅通过运行器环境串行化测试文件，仍产生
`Replaceable ancestor` 拒绝；该尝试也不算检查通过。最终 `submitInner`
前必须合入修复并重跑完整检查；当时 I-S03、I-AC03 保持未完成，没有以局部成功或暂存/提交代码冒充门禁就绪。

随后以普通 merge 合入 CLI 的 helper 标准输入管道修复
`59e8b2e552d2302ee9fc14cfdd8f494209bbede2`（合并提交
`dc84b1e0c43e3fd0056e90a3a48a90f72590aeb0`），再次执行默认
`pnpm check`，结果仍为 19/20 任务通过，唯一失败仍是同一凭据并发测试。因此该次同步没有记录
`submitInner`，继续诊断外部检查前置条件，没有擅自改变 ACL 或跳过测试。

进一步用不含凭据的独立 `secureDirectory` 诊断确认：本机默认 `D:\Code\pinboard`
fixture 继承自 D 盘的 `NT AUTHORITY\Authenticated Users`
可修改祖先权限，真实拒绝为
`Replaceable ancestor`（`code: 1`、`killed: false`、`signal: null`），不是此处的 helper 超时。该拒绝符合安全边界；未修改任何已有 ACL，诊断用项目内目录已清理。仓库已有
`PINBOARD_TEST_ROOT`
支持，后续完整检查必须在受信任的项目工作树或其独立 fixture 根中执行，避免与并行 CLI 测试共用目录；无需放宽生产 DACL 检查。

最终普通 fast-forward 合入 CLI 的原生 ACL helper 修复
`82b72b6b7c2cebbf7b00a9b0a056621cd93a179c`，确认该提交包含完整 CAR 实现，并独立核查成功 CI
[41827926346](https://github.com/shazhou-ww/pinboard/actions/runs/41827926346)：

| 环境                   | Job ID       | 原生 CLI 权限测试 | 完整 `pnpm check` |
| ---------------------- | ------------ | ----------------- | ----------------- |
| Windows / Node 22.13.0 | 126567441475 | success           | success           |
| Ubuntu / Node 22.13.0  | 126567442138 | success           | success           |
| Windows / Node 24.11.1 | 126567442149 | success           | success           |
| Ubuntu / Node 24.11.1  | 126567442216 | success           | success           |

通过 `gh run watch --exit-status` 等待成功，并逐 job 核查
`Verify native CLI permissions` 和 `Run all checks`
的实际结论，不以单个构建或缓存日志冒充完整检查。Windows 工作流明确设置受信任的
`PINBOARD_TEST_ROOT=$env:USERPROFILE\pinboard-ci-fixtures`，仍执行真实 DACL 与独立凭据写入进程测试；本机 D 盘拒绝作为环境限制保留。之后只更新此证据及 ledger，无运行时代码变化；I-S03、I-AC03 已具备完成证据。

## 现实世界前置条件与未宣称事项

尚未生产部署或运行真实在线 smoke。实现验收后，先独立核查生产数据库 schema 及迁移历史，旧库仅应用加法
`0002`，不要重放手工初始化过的 `0001`。部署继续沿用已有 release
tag 流程，不开启 main
push 部署，不扩大发布凭据权限。新 CAR-only 数据产生后不能直接回退到仅懂独立块的旧 Worker，需保留新读取能力并前向修复。精确操作和在线 smoke 范围写入
`docs/deployment.md`。

真实 R2 的 TTFB、总耗时、平台请求指标、缓存差异及上线结果仍由现实世界验证；本机操作数、SQLite 分配量或离线 Kubo 结果不能替代这些证据。
