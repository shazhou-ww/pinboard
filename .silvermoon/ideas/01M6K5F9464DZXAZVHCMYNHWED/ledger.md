# Ledger

## Implementation

### Implementation steps

- [x] **I-S01:** 明确打包存储与兼容策略
- [x] **I-S02:** 接入整包与单块读写
- [x] **I-S03:** 验证正确性与读写开销

### Implementation acceptance criteria

- [x] **I-AC01:** 内容与接口兼容
- [x] **I-AC02:** 整包读取不再逐块放大
- [x] **I-AC03:** 失败处理与仓库检查通过

## Deployment

### Deployment steps

- [x] **D-S01:** 确认验证环境与回退边界
- [x] **D-S02:** 验证真实 R2 下载与性能
- [ ] **D-S03:** 清理临时实验资源

### Deployment acceptance criteria

- [x] **D-AC01:** 远端内容可用且完整
- [x] **D-AC02:** 性能与空间取舍可核查
