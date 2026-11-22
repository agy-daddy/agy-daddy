# Agy-Daddy Organization Infrastructure (`.github`)

Agy-Daddy 开放插件生态的组织级治理、可复用 GitHub Actions 工作流与安全审查规范库：

- `.github/workflows/plugin-ci.yml`: 可复用插件 CI（Node 22.4+、零第三方运行依赖校验、`agy-plugin.json` Schema 校验、紫色主题禁令静态门禁、单测）。
- `.github/workflows/anchors-matrix.yml`: Antigravity 各历史版本 DOM 夹具 × `anchors.json` 兼容矩阵校验。
- `.github/workflows/release.yml`: SHA-512 完整性摘要与发布前清单校验。
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) / [`REVIEW_CHECKLIST.md`](./REVIEW_CHECKLIST.md) / [`LICENSE_AUDIT.md`](./LICENSE_AUDIT.md) / [`rfcs/0000-template.md`](./rfcs/0000-template.md)
