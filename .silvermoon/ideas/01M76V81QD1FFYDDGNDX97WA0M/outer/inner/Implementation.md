# Implementation

## Steps

### I-S01: 接入标准 CAR 与路径证明

复用现有 CID、读取及授权能力，增加范围受限的 CAR 协商和路径遍历；明确支持的 codec、路径规则和表示参数。

### I-S02: 验证流式失败与兼容性

补充独立解析和证明校验、缺块与取消测试，同步能力文档并运行 pnpm check。

## Acceptance criteria

### I-AC01: 证明与实际响应一致

固定多级路径 fixture 的 CAR block 集合由独立验证器检查；错误路径、授权拒绝、探测和条件响应有明确断言。

### I-AC02: 资源及已有接口保持边界

故障注入证明不会成功输出不完整证明或无界缓冲；raw、自定义 CAR 与权限回归测试及 pnpm check 通过。
