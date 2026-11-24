[English](./REVIEW_CHECKLIST.md) | 简体中文

# 插件审查清单（`T1` 社区审查标准）

本清单用于规范社区插件申请进入 `agy-daddy-registry` **`T1`（社区已审）** 信任层级，以及既有已收录插件发生重大变更时的安全、隔离、兼容性与质量审查流程。

> 批准 `T1` 收录 PR 前，下方每一项检查都必须具备可验证的实证依据（代码审阅结论、测试输出或 SHA-512 校验结果）。

---

## 提交元数据

| 字段 | 内容 |
|---|---|
| **插件 ID** | `<publisher>.<name>` |
| **版本号** | `x.y.z`（SemVer） |
| **仓库地址 / Commit SHA** | `https://github.com/...`（`<commit-sha>`） |
| **目标信任等级** | `T1`（社区已审） |
| **清单 SHA-512 摘要** | `sha512-...` |
| **审查人** | `@maintainer` |

---

## 1. 权限最小化与信任策略

- [ ] **最小 `permissions` 声明**：`agy-plugin.json` 中声明的每一项权限都对应明确且有文档说明的用户功能，无冗余或试探性权限。
- [ ] **排除 `T1` 受限高危权限**：`agy-plugin.json` **未申请** `page:main-world`、`process:spawn`、`host:launch-args`、`host:control` 或 `rpc:write`（根据 `evaluateTrustPolicy`，`T1_RESTRICTED_PERMISSIONS` 默认拒绝，除非经单独安全评审批准并留档说明）。
- [ ] **高危权限具备安全边界说明**：若申请了 `fs:user-files`、`net:listen` 或 `native:install`，插件 README 中必须明确说明安全边界，且在用户拒绝授权时能够安全降级。
- [ ] **合理使用隐式默认权限**：插件自身数据持久化优先使用隐式授予的 `fs:plugin-data`，不无故扩大为 `fs:user-files`。

## 2. 外网出站声明与数据隐私

- [ ] **精确限定 `net:outbound:<domain>`**：避免使用通配符 `net:outbound:*`，仅声明明确必需的目标域名。
- [ ] **透明告知外发内容**：若声明了 `net:outbound:<domain>`，插件 README 与 `settings.schema.json` 描述中必须明确告知**发送的数据内容**、**目标域名**及**用途**。
- [ ] **默认关闭（Opt-in）**：所有涉及外网请求的功能，其默认配置开关必须为关闭（`"default": false`），须由用户显式开启。
- [ ] **凭据保护**：`settings.schema.json` 中的 Token、密码或 API Key 必须配置 `"secret": true` 与 `"writeOnly": true`，确保底座向渲染层下发状态时自动脱敏。

## 3. 沙箱隔离与零改包保证

- [ ] **强制隔离世界**：`agy-plugin.json` 声明 `"world": "isolated"`，且不包含 `"page:main-world"`。
- [ ] **无隐蔽全局逃逸**：隔离世界脚本不读取 `window.__APP_CONFIG__`、React fiber 内部对象（`__reactFiber$`、`__reactProps$`）、Electron `ipcRenderer` 内部接口或未授权的宿主全局对象。
- [ ] **严格零改包合规**：不读取、修改、解包或修补 `app.asar`、`Antigravity.app` 或任何 Antigravity 安装文件与二进制产物。
- [ ] **零第三方运行依赖**：`package.json` 不含任何第三方运行时 `"dependencies"`（缺失或为 `{}`）。
- [ ] **无废弃或已移除 API**：清单不声明 `contributes.migrations`，源码不调用已移除的底座接口（如 `registerSection`）。

## 4. 生命周期卫生与零资源泄漏

- [ ] **卸载 `dispose()` 彻底清理**：禁用或卸载插件后，所有注入的 DOM 节点、`ShadowRoot` 容器、DOM/Window 事件监听器、`setTimeout`/`setInterval` 定时器、`MutationObserver`/`ResizeObserver` 以及四域总线订阅均已清零。
- [ ] **自动化卸载验证通过**：单元测试覆盖 `mount()` → 业务运行 → `unloadPlugin()` 全流程，并通过 `@agy-daddy/host/sdk`（`mock-harness.js`）中的 `harness.assertCleanDispose(pluginId)` 断言。
- [ ] **支持幂等重挂载**：执行 `dispose()` 后再次启用或重载插件可正常工作，无重复监听器或残留状态。

## 5. 主题一致性与插槽解耦

- [ ] **通过紫色主题静态门禁**：源码静态扫描未命中任何禁止色值（`#10b981`、`#34d399`、`#059669`、`#38bdf8`、`#7dd3fc`、`#0369a1`、`#0c4a6e`、`#fb923c`、`#c2410c`）。
- [ ] **遵循强调色 Token 契约**：强调色统一使用 `var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))`，并完整适配深色模式、浅色模式及 5 套预设高亮色。
- [ ] **基于扩展面与锚点解耦**：通过 `contributes`（`topbar.units`、`topbar.popovers`、`settings`、`settings.pages`、`commands`、`keybindings`、`locales`）或 `ctx.surfaces.mount(...)`（`composer.quickActions`、`chat.search`、`chat.navButtons`、`remote.panels`、`remote.actions`）挂载 UI，仅依赖 `anchors.json` 中的具名锚点，而非脆弱的样式类名链路。

## 6. 版本规范、完整性签名与兼容性

- [ ] **合法 SemVer 与引擎版本约束**：`version` 为合法 SemVer 字符串，`engines.agyDaddy` 匹配 `^1.0.0`（或目标底座 API），使用 DOM 锚点时已声明 `engines.antigravity`。
- [ ] **清单与发行包 SHA-512 校验一致**：`sha512-<base64>` 摘要与 `agy-plugin.json`（及外部发行 tarball）字节精确匹配：
  ```sh
  node -e 'const fs=require("fs"),c=require("crypto");console.log("sha512-"+c.createHash("sha512").update(fs.readFileSync("agy-plugin.json")).digest("base64"));'
  ```
- [ ] **CI 与兼容夹具全绿**：可复用工作流（`plugin-ci.yml`、`anchors-matrix.yml`、`release.yml`）与 `npm test`（`AGY_DADDY_TEST_MODE=1`）全部通过，无跳过断言。

## 7. 开源许可与上游署名

- [ ] **符合 OSI 标准的开源协议**：包内包含合法的 `LICENSE` 文件（推荐 MIT），且与 `package.json` 和 `agy-plugin.json` 声明一致。
- [ ] **保留上游 `NOTICE` 署名**：所有衍生代码、提示词规则或本地化词典均已在 `NOTICE` 中完整署名，且符合 [`LICENSE_AUDIT_zh.md`](./LICENSE_AUDIT_zh.md) 要求。

---

## 审查结论与签字

- **审查结果**：`[ ] 批准收录为 T1` / `[ ] 需修改后重审` / `[ ] 拒绝`
- **特殊权限豁免（如有）**：`无` *（如有特批受限权限，须在此列出权限项及批准理由）*
- **验证证据**：填写 CI 运行链接或本地 `npm run verify` 输出记录
- **备注**：
