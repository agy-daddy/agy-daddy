# @agy-daddy/plugin-usage

Agy-Daddy Layer-2 官方插件：累计 Token 用量、52 周热力图、API 参考费用核算与订阅管理。

## 服务与集成
- 提供 `usage`（`estimateCallsCost`, `recordCalls`, `getSummary`, `getHeatmap`, `getMobileSnapshot`）与 `subscription`（`getPlan`, `setCustomPlan`, `getUltraSubTier`）服务。
- 订阅 `telemetry:generator-calls@1` 实时入账；启动时软消费可选 `context.getRecentCalls(0)` 补拉历史调用。
