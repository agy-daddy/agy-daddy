# @agy-daddy/plugin-context

Agy-Daddy Layer-2 官方插件：顶栏上下文圆环与测速、详情与附件审计浮窗、底部 Pulse 实时能量胶囊。

## 提供能力
- 服务：`context`（Node 域：`getSnapshot`、`rescan`、`getRecentCalls`、`auditAttachments`、`getMobileSnapshot`）与 `context-ui`（主世界域）
- 事件：`telemetry:generator-calls@1`（按 `callId` 去重供 `usage` 等消费者入账与延迟补拉）
- 状态：`state:context.snapshot@1`
- 可选消费：`usage.estimateCallsCost()`（未安装 `usage` 时安全降级）

## 测试
```sh
npm test
```
