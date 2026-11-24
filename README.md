# Agy-Daddy Monorepo

Google Antigravity 桌面端的 100% 零改包 CDP 开放插件底座与官方插件生态单仓（Monorepo）。

## 仓库结构

- `agy-daddy-host/`：纯净微内核插件底座（契约校验、CDP/RPC 代理、四域总线、全托管声明式配置与命令引擎、隔离 Worker、安装器与原生设置弹窗融合渲染底座 `@agy-daddy/host`）
- `agy-daddy-plugin-*/`：全员 `isolated` 隔离世界插件集——官方插件（`proxy`、`zh-cn`、`cli`、`context`、`usage`、`chat-nav`、`quota`、`composer`、`remote`）与插件脚手架模板（`template`），零 `page:main-world` 权限、自有样式注入、基于 `ctx.surfaces` 插槽解耦
- `agy-daddy-registry/`：插件信任注册表（`registry.json`）、SHA-512 完整性摘要与 Antigravity 版本 14 锚点 DOM 夹具矩阵（含原生设置弹窗锚点）
- `agy-daddy-.github/`：组织级贡献指南、审查清单、许可证审计与可复用工作流模板（参考 [`CONTRIBUTING.md`](./agy-daddy-.github/CONTRIBUTING.md)、[`REVIEW_CHECKLIST.md`](./agy-daddy-.github/REVIEW_CHECKLIST.md)、[`LICENSE_AUDIT.md`](./agy-daddy-.github/LICENSE_AUDIT.md)）
- `scripts/monorepo.js`：根目录统一构建、静态解耦/主题/沙箱门禁校验与全仓测试编排脚本

## 环境要求

- Node.js `>= 22.4.0`（零第三方运行依赖，无需 `npm install`）

## 常用命令

```sh
# 1. 构建底座渲染层产物（agy-daddy-host/dist/host-renderer.js）
npm run build

# 2. 运行静态门禁（零依赖、全员 isolated、settings.schema 校验、去耦合/紫色主题门禁、14 锚点一致性、registry SHA-512 与矩阵）
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
