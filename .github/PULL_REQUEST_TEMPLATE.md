## 变更说明
<!-- 简述本 PR 的改动范围与背景 -->

## 检查清单
- [ ] 提交信息与 PR 标题遵循 Conventional Commits（例如 `feat(proxy): ...`、`fix(host): ...`）
- [ ] 已在根目录执行 `npm run verify` 并全部通过
- [ ] 所有包的 `package.json` 保持零第三方运行依赖（`dependencies` 为空）
- [ ] UI 代码通过紫色主题静态门禁（使用 `--ag-custom-token-accent` / `#a78bfa`，无禁止的绿/天蓝/橙硬编码色）
- [ ] 若修改了任意插件的 `agy-plugin.json`，已同步更新 `agy-daddy-registry/registry.json` 中对应的 `manifestSha512`
