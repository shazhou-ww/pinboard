# 实施验证证据

## 范围及授权

本轮保留现有授权优先、404/412/503 区分与图片兼容分支，仅新增根路径 Service-Worker:
script 的统一 400 拒绝规则。普通 HTTP
Range、跨站私有内容 CORS、CAR 与后续迭代均不在本轮实现。

用户已明确同意收敛建议，并授权顺序推进 iteration 1 和 iteration
2、由主 Agent 执行门限审批，以及部署阶段发布生产并使用 Chrome for
Testing 验证。该授权不包括生产数据库迁移。其余四个构想没有被接受或开始实施。

## 本地验证

2026-11-12，Node.js 24.11.1、pnpm 11.22.0，Windows：

- 先构建缺失的 encoding 工作区产物并生成已有 preview
  assets；未安装新依赖或更改依赖清单。
- gateway、access、previews 三组定向测试共 58 项通过。
- pnpm check 通过，24/24 Turbo 任务成功；Worker 302 通过、1 跳过，Web
  347 通过，CLI 162 通过、2 跳过，encoding 14、contracts 13、background
  34 通过，release 与 CLI/background 包装检查通过。
- 本次新增根注册测试及 raw 图片选择断言均未跳过；已有跳过项不作为通过证据。

早期定向运行遇到缺失 encoding
dist 及预生成 jpeg.wasm；使用仓库已有构建命令生成后，同一测试选择通过。此前构想文档的格式问题仅用既有 Prettier 修正，没有语义修改理想世界；格式变化导致的构想 revision 变化必须重新提交并按用户授权审批，不能沿用旧 revision。

## 门限约束

独立 Kubo 验证发现旧的本地 PoC 上传器只保存归档，不建立公开引用，因此在当前授权模型下 provider
discovery 正确返回空集。修正仅限本地 poc-entry：仍走 readCar/storeDag 验证与存储，并为专用测试账号创建公开 Pin；生产入口不导入该上传器，没有放宽生产授权。修正后 3 个冷缓存客户端完成 TLS/HTTP2
cat/get 与浏览器目录重建，完整结果另记 Outer World。

上述结果是源码与本地 Worker 模拟环境证据，不是生产部署证明。补充本文件及部署契约后，最终候选必须重新运行 pnpm
check 并通过，才能将 I-AC03 标记完成并提交准确 implementationRevision。部署、独立 Kubo/TLS 检索和真实浏览器 smoke 的结果记录在 Outer
World。
