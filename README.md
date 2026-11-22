# Agy-Daddy Monorepo

Google Antigravity 桌面端的 100% 零改包 CDP 开放插件底座与官方插件生态单仓（Monorepo）。

## 仓库结构

- `agy-daddy-host/`：插件底座核心（契约校验、CDP/RPC 代理、四域总线、隔离 Worker、安装器与渲染底座 `@agy-daddy/host`）
- `agy-daddy-plugin-*/`：官方插件集（`proxy`、`zh-cn`、`cli`、`context`、`usage`、`chat-nav`、`quota`、`composer`、`remote`）、社区示例插件（`chat-search`）与插件脚手架模板（`template`）
- `agy-daddy-registry/`：插件信任注册表（`registry.json`）、SHA-512 完整性摘要与 Antigravity 版本 DOM 锚点夹具矩阵
- `agy-daddy-.github/`：组织级贡献指南、审查清单、许可证审计与可复用工作流模板（参考 [`CONTRIBUTING.md`](./agy-daddy-.github/CONTRIBUTING.md)、[`REVIEW_CHECKLIST.md`](./agy-daddy-.github/REVIEW_CHECKLIST.md)、[`LICENSE_AUDIT.md`](./agy-daddy-.github/LICENSE_AUDIT.md)）
- `scripts/monorepo.js`：根目录统一构建、门禁校验与全仓测试编排脚本

## 环境要求

- Node.js `>= 22.4.0`（零第三方运行依赖，无需 `npm install`）

## 常用命令

```sh
# 1. 构建底座渲染层产物（agy-daddy-host/dist/host-renderer.js）
npm run build

# 2. 运行静态门禁（零依赖、manifest 校验、紫色主题门禁、anchors 一致性、registry SHA-512 与矩阵）
npm run verify:gates

# 3. 运行全仓所有包的单元测试
npm test

# 4. 一键执行 build + gates + test（CI 等价）
npm run verify

# 5. 将本地仓库中的所有官方/示例插件软链到本机运行时目录
./agy-daddy-host/bin/agy-daddy dev link-all
```

## Git 协作规范

- **主干分支**：`main` 为受保护分支，禁止直接 push；所有变更通过特性分支发起 Pull Request 并经 CI 通过后 Squash Merge。
- **分支命名**：`feat/<scope>-<desc>`、`fix/<scope>-<desc>`、`chore/<scope>-<desc>`（如 `feat/proxy-socks5`、`fix/host-cdp-reconnect`）。
- **提交信息（Conventional Commits）**：`<type>(<scope>): <summary>`
  - `feat(proxy): support socks5 auth`
  - `fix(host): guard reconnect race on target close`
  - `chore(registry): refresh manifest sha512`
- **发布策略**：统一版本演进时使用根 Tag `v1.x.y`；后续插件独立发版时可使用包级 Tag（如 `plugin-quota@1.0.1`）。
