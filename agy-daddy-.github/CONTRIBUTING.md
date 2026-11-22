# 贡献指南 (CONTRIBUTING)

1. 遵循零改包、零第三方运行依赖与最小权限原则。
2. 新插件推荐基于 `agy-daddy-plugin-template` 或 `createPluginScaffold()` 生成。
3. 所有扩展交互优先消费既有 `contributes` 与 `surfaces`（例如 `composer.quickActions`、`chat.search`、`chat.navButtons`、`remote.panels`）。
4. 涉及主题强调色时必须使用 `var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))`，严禁硬编码非主题绿色/天蓝/橙色调。
5. 提交到 `agy-daddy-registry` 申请 `T1` 信任收录前，必须通过 `REVIEW_CHECKLIST.md` 全部检查项及 `npm test`。
