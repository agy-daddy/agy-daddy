# @agy-daddy/plugin-quota

Agy-Daddy Layer-3 官方插件：Gemini / Claude-3P / Argon / Carbon 配额共享池监测与 5h/周重置倒计时。

## 特性
- 严格遵循 protobuf `codeium_quota_info` 与 `quota_summary_bucket` 不同缺省语义，绝不误判未知比例为耗尽。
- 仅软消费可选 `subscription.getUltraSubTier()` 补齐 Google AI Ultra 5x/20x 倍率信息，独立安装可无报错运行。
