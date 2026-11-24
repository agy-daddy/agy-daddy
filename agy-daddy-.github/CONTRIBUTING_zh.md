[English](./CONTRIBUTING.md) | 简体中文

# Agy-Daddy 贡献指南

感谢你关注并参与 **Agy-Daddy**——面向 Google Antigravity 桌面端的零改包 Chrome DevTools Protocol（CDP）插件底座与开放插件生态。

本文档明确了项目的核心工程原则、本地开发环境搭建、端到端贡献流程、测试与静态门禁规范、社区插件注册提交流程以及行为准则。

---

## 目录

1. [核心工程原则](#1-核心工程原则)
2. [本地开发环境搭建](#2-本地开发环境搭建)
3. [贡献流程规范](#3-贡献流程规范)
4. [测试、静态门禁与代码规范](#4-测试静态门禁与代码规范)
5. [提交社区插件至注册表（`T1`）](#5-提交社区插件至注册表t1)
6. [开源行为准则（Code of Conduct）](#6-开源行为准则code-of-conduct)

---

## 1. 核心工程原则

所有向 `@agy-daddy/host`、官方插件及 `agy-daddy-registry` 提交的贡献都必须严格遵守以下不可妥协的架构约束：

1. **100% 零改包原则**：严禁修改 Antigravity 的 `app.asar`、应用二进制文件或安装包内容。所有 UI 与运行时扩展均通过 CDP 外部挂载及底座受控注入完成。
2. **零第三方运行依赖**：所有核心包（`agy-daddy-host`、`agy-daddy-registry` 与全部 `agy-daddy-plugin-*`）的 `package.json` 必须保持 `"dependencies": {}` 为空，仅使用 Node.js（`>= 22.4.0`）内置 API。
   - *构建期前端例外*：`agy-daddy-plugin-remote/web` 与 `agy-daddy-plugin-web/web` 仅在构建阶段使用 `devDependencies`（Vite、Preact/React、Vitest）将界面打包为静态产物 `dist/web/index.html`。更新后须提交完整自包含的构建产物。
3. **最小权限与沙箱隔离**：
   - 所有插件必须声明 `"world": "isolated"`，严禁申请 `"page:main-world"`。
   - 高危权限（`process:spawn`、`host:launch-args`、`host:control`、`rpc:write`、`fs:user-files`、`net:listen`、`native:install`、`net:outbound:<domain>`）仅在确有必要时申请，且须在文档中清晰说明用途。
   - 严禁在 `contributes` 中声明已废弃的 `"migrations"`，或调用已移除的 `registerSection` API。
4. **声明式扩展与插槽解耦**：
   - 优先使用声明式 `contributes`（`topbar.units`、`topbar.popovers`、`settings`、`settings.pages`、`commands`、`keybindings`、`locales`、`native`）与 `ctx.surfaces` 扩展插槽（`composer.quickActions`、`chat.search`、`chat.navButtons`、`remote.panels`、`remote.actions`），避免直接耦合宿主内部 DOM。
   - `@agy-daddy/host`（`src/renderer/`）必须保持纯净，严禁出现任何插件专属选择器、ID 或硬编码文案。
5. **主题 Token 规范（紫色主题门禁）**：
   - 涉及强调色时必须使用底座主题 CSS 变量：
     ```css
     var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))
     ```
   - 严禁硬编码禁止的非主题绿色、天蓝或橙色调（`#10b981`、`#34d399`、`#059669`、`#38bdf8`、`#7dd3fc`、`#0369a1`、`#0c4a6e`、`#fb923c`、`#c2410c`）。
   - 所有 UI 界面需同时适配深色/浅色模式及 5 套预设高亮色。

---

## 2. 本地开发环境搭建

### 2.1 环境前提

- **Node.js `>= 22.4.0`**（需支持原生 `WebSocket` 与 `fetch`）。
- **Git**（已配置 GitHub SSH 密钥或访问凭据）。
- **Google Antigravity 桌面端**（纯单测/契约测试可选；实时 CDP 冒烟验证必需）。

### 2.2 克隆仓库与基线验证

根目录无需运行 `npm install`：

```sh
git clone git@github.com:<your-username>/agy-daddy.git
cd agy-daddy
git remote add upstream https://github.com/agy-daddy/agy-daddy.git

# 检查 Node 版本并执行全仓构建、门禁与测试
node -v
npm run verify
```

### 2.3 软链本地插件进行联调

使用底座 CLI 包装器将本地单仓插件软链至本机运行时目录，并检查环境状态：

```sh
# 预览将要软链的插件列表
./agy-daddy-host/bin/agy-daddy dev link-all --dry-run

# 将所有本地官方插件软链至运行时目录
./agy-daddy-host/bin/agy-daddy dev link-all

# 软链单个外部或开发中的插件目录
./agy-daddy-host/bin/agy-daddy plugin link /path/to/your-plugin

# 运行环境诊断与无头冒烟检查
./agy-daddy-host/bin/agy-daddy doctor --json
./agy-daddy-host/bin/agy-daddy dev smoke
```

### 2.4 可选前端 UI 开发（`plugin-remote` / `plugin-web`）

仅当你需要修改 `agy-daddy-plugin-remote/web/src` 或 `agy-daddy-plugin-web/web/src` 中的前端页面代码时执行：

```sh
cd agy-daddy-plugin-web/web   # 或 agy-daddy-plugin-remote/web
npm install                   # 仅安装 devDependencies
npm run typecheck
npm test
npm run build                 # 更新 ../dist/web/index.html
```

> **注意**：切勿提交 `node_modules/`。更新前端源码后，请确保重新生成 `dist/web/` 产物并在仓库根目录通过 `npm run verify`。

### 2.5 基于脚手架生成新插件

新插件推荐基于 [`agy-daddy-plugin-template/`](../agy-daddy-plugin-template/) 复制定制，或直接调用 [`agy-daddy-host/sdk/index.js`](../agy-daddy-host/sdk/index.js) 导出的 `createPluginScaffold()` 生成：

```sh
node -e '
  const { createPluginScaffold } = require("./agy-daddy-host/sdk");
  createPluginScaffold("./my-agy-plugin", {
    id: "your-publisher.my-plugin",
    publisher: "your-publisher",
    displayName: "My Plugin"
  });
'
```

---

## 3. 贡献流程规范

### 第一步：Issue 讨论与 RFC 提案

- **缺陷修复与常规改进**：先检索既有 Issue 和 Pull Request。若无相关讨论，请新建 Issue，清晰提供复现步骤、预期与实际行为，以及脱敏后的环境信息（`node -v`、操作系统、Antigravity 版本及脱敏的 `doctor --json` 输出）。
- **底座 API、权限、锚点或插槽变更**：凡涉及 `@agy-daddy/host` 契约、权限模型、14 个具名 DOM 锚点或 `ctx.surfaces` 的架构级或破坏性变更，必须先按 [`rfcs/0000-template.md`](./rfcs/0000-template.md) 提交 RFC 提案。破坏性变更须保留至少一个次版本（`>= 1` minor release）的弃用过渡期并提供迁移路径。

### 第二步：Fork 与分支命名规范

1. 在 GitHub 上 Fork `agy-daddy/agy-daddy`，并保持本地 `main` 与 `upstream/main` 同步：
   ```sh
   git fetch upstream
   git checkout main
   git rebase upstream/main
   ```
2. 从 `main` 切出特性分支开发（禁止直接 push 到 `main`）。分支命名遵循以下前缀约定：

| 前缀 | 用途 | 示例 |
|---|---|---|
| `feat/<scope>-<desc>` | 新增功能或插件能力 | `feat/proxy-socks5-auth` |
| `fix/<scope>-<desc>` | 缺陷修复或竞态防护 | `fix/host-cdp-reconnect` |
| `docs/<scope>-<desc>` | 文档或本地化文案更新 | `docs/github-contributing-i18n` |
| `refactor/<scope>-<desc>` | 不改变外部语义的内部重构 | `refactor/context-pulse-helper` |
| `test/<scope>-<desc>` | 补充单元测试或兼容夹具 | `test/registry-anchor-234` |
| `chore/<scope>-<desc>` | 构建、CI 或注册表摘要维护 | `chore/registry-refresh-sha512` |

### 第三步：提交信息格式规范（Conventional Commits）

所有提交记录与 PR 标题必须遵循 **[Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)** 规范：

```text
<type>(<scope>): <简明扼要的祈使句描述>

[可选正文：说明修改动机与设计取舍]

[可选页脚：例如 BREAKING CHANGE: ... 或 Refs: #123]
```

- **允许的 `<type>`**：
  - `feat`：新增特性或扩展贡献点
  - `fix`：修复 Bug
  - `docs`：纯文档更新
  - `refactor`：既不修 Bug 也不增功能的代码重构
  - `perf`：性能优化
  - `test`：新增或调整测试与夹具
  - `build`：影响渲染层或 Web UI 构建脚本的变更
  - `ci`：GitHub Actions 工作流或静态门禁调整
  - `chore`：日常维护任务（如刷新 `manifestSha512`）
- **常用 `<scope>`**：`host`、`registry`、`sdk`、`proxy`、`zh-cn`、`cli`、`context`、`usage`、`chat-nav`、`quota`、`composer`、`remote`、`web`、`template`、`docs`、`ci`。
- **破坏性变更**：在作用域后追加 `!`（如 `feat(host)!: ...`），并在页脚标注 `BREAKING CHANGE:`。
- **示例**：
  ```text
  feat(proxy): support socks5 authentication credentials
  fix(host): guard cdp reconnect race on target close
  test(registry): add antigravity 2.34 anchor fixture
  chore(registry): refresh manifest sha512 for plugin-quota
  ```

### 第四步：Pull Request 提交与评审流程

1. **保持变更聚焦**：每个 PR 仅解决一个明确问题，避免夹带无关格式化改动或跨包顺手重构。
2. **同步派生构建与摘要产物**：
   - 若修改了 `agy-daddy-host/src/renderer/`，请运行 `npm run build` 更新 `dist/host-renderer.js`。
   - 若修改了任意插件的 `agy-plugin.json`，请重新计算 SHA-512 摘要并同步更新 [`agy-daddy-registry/registry.json`](../agy-daddy-registry/registry.json) 中对应的 `manifestSha512`：
     ```sh
     node -e 'const fs=require("fs"),c=require("crypto");console.log("sha512-"+c.createHash("sha512").update(fs.readFileSync("agy-plugin.json")).digest("base64"));'
     ```
   - 若修改了 DOM 锚点，确保 `agy-daddy-host/data/anchors.json` 与 `agy-daddy-registry/anchors.json` 保持字节完全一致。
3. **运行全量本地校验**：在根目录执行 `npm run verify`，确认全部构建、门禁与测试无报错、无跳过。
4. **填写 PR 模板**：按 [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md) 逐项填写变更说明与自检清单；涉及 UI 或 CLI 行为变更时附带截图或命令输出。
5. **代码评审与合入**：
   - GitHub Actions（`.github/workflows/ci.yml`）会在 Node `22.x` 环境下自动执行 `npm run verify`。
   - 维护者将重点审查架构边界、权限声明、资源释放卫生及测试覆盖情况。
   - 请针对评审意见逐条回应并修改；评审期间除非维护者要求，请勿直接 `force-push` 覆盖评审历史。
   - 评审通过且 CI 全绿后，由维护者通过 **Squash Merge** 合入 `main`。

---

## 4. 测试、静态门禁与代码规范

### 4.1 校验命令速查

| 命令 | 覆盖范围 | 触发时机 |
|---|---|---|
| `npm run verify` | 依次执行 `build` + `gates` + `test`（与 CI 完全等价） | 每次提交 PR 前与最终修改完成后 |
| `npm run build` | 构建 `agy-daddy-host/dist/host-renderer.js`（若存在 `web/node_modules` 则同步构建 Web UI） | 修改底座渲染层或插件前端源码后 |
| `npm run verify:gates` | 执行全部 7 项静态与注册表完整性门禁 | 修改清单、Schema、锚点或样式后 |
| `npm test` | 在 `host`、`registry` 及全部插件包中运行 `npm test` | 日常迭代开发期间 |

如需单独运行某个包的测试：

```sh
cd agy-daddy-host   # 或任意 agy-daddy-plugin-* / agy-daddy-registry
AGY_DADDY_TEST_MODE=1 node --test test/*.test.js
```

### 4.2 静态与注册表门禁明细（`scripts/monorepo.js`）

执行 `npm run verify:gates` 会依次校验以下 7 项硬性门禁：

1. **零第三方运行依赖校验**：检查根目录、底座、注册表及全部插件包的 `package.json` 中 `dependencies` 为空。
2. **遗留产物清除校验**：确保已删除的遗留路径（`agy-daddy-host/plugins/legacy-suite`、`agy-daddy-host/src/core/migration.js`）未被重新引入。
3. **清单与设置 Schema 校验**：使用 `validateManifest()` 校验全部 `agy-plugin.json`，强制要求 `world === "isolated"`，禁用 `page:main-world` 与 `contributes.migrations`，并用 `validateSettingsSchema()` 校验声明的 `settings.schema.json`。
4. **插件紫色主题与废弃 API 门禁**：扫描所有插件 `src/` 目录（以及 `plugin-remote/web/src`、`plugin-web/web/src`），禁止引用已移除的 `registerSection` 及 9 个禁用硬编码色值。
5. **纯净底座解耦与主题门禁**：确保 `agy-daddy-host/src/renderer/` 不包含任何插件专属选择器或禁用色值。
6. **锚点文件一致性校验**：确认 `agy-daddy-host/data/anchors.json` 与 `agy-daddy-registry/anchors.json` 字节完全一致。
7. **注册表完整性与夹具矩阵校验**：核对全部已注册插件的 `manifestSha512`，并在所有 Antigravity 版本夹具（`fixtures/antigravity-*.json`）上验证全部 14 个具名锚点均可命中。

### 4.3 编码约定与测试要求

- **模块规范**：核心底座与插件代码采用 CommonJS（`'use strict';`）及 Node.js 内置模块（`node:fs`、`node:path`、`node:crypto`、`node:test`、`node:assert/strict`）。
- **生命周期零泄漏**：凡挂载 DOM 节点、定时器、Observer 或四域总线监听器的插件，必须在 `dispose()` 中彻底释放；单元测试应使用 `@agy-daddy/host/sdk` 提供的 `createMockHostHarness()` 并调用 `harness.assertCleanDispose(pluginId)` 验证零残留。
- **敏感配置保护**：Token、密码与 API Key 必须在 `settings.schema.json` 中设置 `"secret": true` 与 `"writeOnly": true`，由底座通过 `redactWriteOnlySettings()` 对渲染层脱敏。
- **多语言支持**：建议在 `displayName`、`commands` 及 `settings.schema.json` 字段中同时提供 `en` 与 `zh-CN` 本地化文本。

---

## 5. 提交社区插件至注册表（`T1`）

独立社区插件可通过以下步骤申请列入 `agy-daddy-registry` 的 **`T1`（社区已审）** 信任列表：

1. **初始化与接入复用 CI**：基于 [`agy-daddy-plugin-template`](../agy-daddy-plugin-template/) 创建仓库，并接入 `agy-daddy-.github/.github/workflows/` 中的可复用工作流：
   - `plugin-ci.yml`：零运行依赖检查、清单校验、紫色主题门禁与 `npm test`。
   - `anchors-matrix.yml`：Antigravity DOM 夹具兼容性校验。
   - `release.yml`：SHA-512 清单完整性摘要生成。
2. **逐项自查 `REVIEW_CHECKLIST`**：对照 [`REVIEW_CHECKLIST_zh.md`](./REVIEW_CHECKLIST_zh.md) 完成全部检查项，并确保 `npm test`（含 `assertCleanDispose`）全部通过。
3. **完善开源署名**：提供清晰的 `LICENSE` 文件（推荐 MIT）；若借鉴或复用上游逻辑或词典，须附带 `NOTICE` 文件并遵守 [`LICENSE_AUDIT_zh.md`](./LICENSE_AUDIT_zh.md)。
4. **提交注册表 PR**：向 `agy-daddy-registry` 提交 PR，补充插件元数据、版本号、仓库地址与 `sha512-<base64>` 清单摘要，并附上自查完成的审查清单。

---

## 6. 开源行为准则（Code of Conduct）

所有贡献者、维护者与评审人员均须遵守项目 [**Contributor Covenant 行为准则**](./CODE_OF_CONDUCT.md)：

- **倡导行为**：
  - 在 Issue、Pull Request、RFC 讨论与代码评审中，始终保持建设性、相互尊重且无骚扰的工程交流氛围。
  - 技术讨论聚焦于代码实现、架构边界、安全模型与可验证事实，不对人不对事。
  - 善意推定他人动机，欢迎新贡献者并在评审中给出清晰可执行的改进建议。
- **禁止行为**：
  - 任何形式的骚扰、贬损言论、人身攻击、恶意挑衅或歧视性语言。
  - 未经授权披露他人隐私信息（人肉搜索）或敏感凭据。
  - 提交恶意代码、混淆载荷、欺骗性权限声明，或故意绕过安全与静态检查门禁。
- **适用范围与处理**：本准则适用于全部组织仓库、Issue 区、PR 评审及官方社区渠道。对于违规行为，维护者有权发出警告、锁定或关闭讨论，直至撤销贡献权限。如需私下举报违规行为，请通过 GitHub Security Advisories 或组织主页公布的维护者私人联系方式反馈。
