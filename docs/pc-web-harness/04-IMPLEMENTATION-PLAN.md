# 04 · PC Web Harness 10 步 TDD 实施计划

> 依赖阅读：[01-PHASE0-RPC-CONTRACT.md](./01-PHASE0-RPC-CONTRACT.md) · [02-ARCHITECTURE-AND-API-SPEC.md](./02-ARCHITECTURE-AND-API-SPEC.md) · [03-TDD-TEST-MATRIX-AND-SPEC.md](./03-TDD-TEST-MATRIX-AND-SPEC.md)  
> 提示：正式修改 `agy-daddy-host/` 前，先确认主仓 `feat/host-decoupling-and-settings` 是否已合入 `main`；若已合入，先在本分支执行 `git rebase main` 对齐全部 15 个 `/host/*` 路由。

---

## Task 1：Host `rpc.js` PID 存活校验与 `constants.js` 白名单修正

- **覆盖用例**：Suite A (`A1`, `A2`)
- **涉及文件**：
  - `agy-daddy-host/test/bus-bridge-rpc.test.js`
  - `agy-daddy-host/src/core/rpc.js`
  - `agy-daddy-host/src/contracts/constants.js`
- **TDD 节拍**：
  1. **RED**：在 `bus-bridge-rpc.test.js` 新增“僵尸 hub 文件（较新 mtime 但 PID 不存活）应被跳过、选中较旧但 PID 存活的文件”以及“全死返回 `null`”测试；新增 `GetCascadeTrajectorySteps` 白名单放行断言。运行单测确认红灯。
  2. **GREEN**：在 `rpc.js` 的 `discoverFromHubDaemonFiles()` 中引入 `isPidAlive` 校验（支持 `options.isPidAlive` 测试注入，默认 `process.kill(pid, 0)`）；在 `constants.js` 的 `RPC_READ_ALLOWLIST` 补充 `GetCascadeTrajectorySteps`。
  3. **VERIFY**：`npm test` 全仓 13 包通过。

---

## Task 2：Host `host:control` 薄代理与 `FourRealmBus.onAny`

- **覆盖用例**：Suite A (`A2`, `A3`, `A4`)
- **涉及文件**：
  - `agy-daddy-host/test/host-control.test.js`（新建）
  - `agy-daddy-host/test/bus-bridge-rpc.test.js`
  - `agy-daddy-host/test/manifest-and-trust.test.js`
  - `agy-daddy-host/src/contracts/constants.js`
  - `agy-daddy-host/src/core/bus.js`
  - `agy-daddy-host/src/core/bridge.js`
  - `agy-daddy-host/src/core/daemon.js`
- **TDD 节拍**：
  1. **RED**：编写 `host-control.test.js`，断言 T0 插件持 `host:control` 可调度 `/host/plugins` 与 `/host/settings`、拦截非白名单路由、无权限插件不可访问；在 `bus-bridge-rpc.test.js` 补充 `onAny` 测试。
  2. **GREEN**：新增 `host:control` 权限（列入 `HIGH_RISK_PERMISSIONS` 与 `T1_RESTRICTED_PERMISSIONS`）；实现 `FourRealmBus.onAny`、`bridge.invokeHostRoute()` 与 `daemon.js` 权限受控代理。
  3. **VERIFY**：`npm test` + `npm run verify:gates` 全绿。

---

## Task 3：`agy-daddy-plugin-web` 包脚手架与门禁适配

- **覆盖用例**：Suite F (`F3` 静态门禁部分)
- **涉及文件**：
  - `agy-daddy-plugin-web/agy-plugin.json`
  - `agy-daddy-plugin-web/package.json`（`dependencies: {}`）
  - `agy-daddy-plugin-web/settings.schema.json`
  - `agy-daddy-plugin-web/src/node.js`（最小空壳 + `activate/dispose`）
  - `scripts/monorepo.js`（调整 `runBuild` / 主题扫描仅扫 `src/` 与 `web/src/`，跳过 `dist/web/` 构建产物）
- **TDD 节拍**：
  1. **RED**：运行 `npm run verify:gates`，验证门禁能识别新目录 `agy-daddy-plugin-web` 并校验 manifest / schema / 零依赖。
  2. **GREEN**：落位最小合规清单与 `settings.schema.json`（端口默认 `18766`、工作区白名单列表、自动打开浏览器开关）。
  3. **VERIFY**：`npm run verify:gates` 通过。

---

## Task 4：`harness-adapter.js` — 只读归一化与 `stepOffset` 增量流引擎

- **覆盖用例**：Suite B (`B1`, `B2`, `B3`)
- **涉及文件**：
  - `agy-daddy-plugin-web/test/harness-adapter.test.js`
  - `agy-daddy-plugin-web/src/harness-adapter.js`
- **TDD 节拍**：
  1. **RED**：基于 `01-PHASE0-RPC-CONTRACT.md` 真实结构编写 `listSessions()`、`normalizeStepToSessionEvent()`（覆盖全部 11 种 `CORTEX_STEP_TYPE_*`）与 `pollDelta()`（验证 `stepOffset` 增量推进与 `GENERATING` 尾部变化）红灯测试。
  2. **GREEN**：实现纯函数投影映射与带偏移状态缓存的 `pollDelta()`。
  3. **REFACTOR**：把 11 种 Step 映射拆为映射表（table-driven），避免冗长 `switch/if-else`；再跑测试确认全绿。

---

## Task 5：`harness-adapter.js` — 写操作编排（新建/发送/停止/模型/审批占位）

- **覆盖用例**：Suite B (`B4`, `B5`)
- **涉及文件**：
  - `agy-daddy-plugin-web/test/harness-adapter.test.js`
  - `agy-daddy-plugin-web/src/harness-adapter.js`
- **TDD 节拍**：
  1. **RED**：补充 `createSession()` 必带 `CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT`、`sendMessage()` 携带 `cascadeConfig.plannerConfig.requestedModel`、`cancelSession()`、`approveStep()` 返回 `501 APPROVAL_RPC_UNAVAILABLE_IN_2_34` 的红灯测试。
  2. **GREEN**：实现写操作编排方法；`listModels()` 解析 `GetUserStatus` + `GetAvailableModels`。
  3. **VERIFY**：`AGY_DADDY_TEST_MODE=1 node --test agy-daddy-plugin-web/test/harness-adapter.test.js` 全绿。

---

## Task 6：`workspace-service.js` — 沙箱文件树、读写、Git Diff 与 Brain Artifacts

- **覆盖用例**：Suite C (`C1`–`C5`)
- **涉及文件**：
  - `agy-daddy-plugin-web/test/workspace-service.test.js`
  - `agy-daddy-plugin-web/src/workspace-service.js`
- **TDD 节拍**：
  1. **RED**：编写临时目录 + symlink 逃逸测试、`maxBytes` 截断测试、临时 git repo diff 测试与非 git 目录降级测试、`brain/<cascadeId>` 产物列表/读取及越界拦截测试。
  2. **GREEN**：用 `fs.realpathSync` 实现严格根白名单校验；用 `execFile('git', ...)`（禁止 shell 拼接）实现 diff 解析并优雅降级。
  3. **VERIFY**：`workspace-service.test.js` 全绿。

---

## Task 7：`web-server.js` 与 `host-proxy.js` — 安全网关、SSE Broker 与底座代理

- **覆盖用例**：Suite D (`D1`–`D5`)、Suite E (`E1`, `E2`)
- **涉及文件**：
  - `agy-daddy-plugin-web/test/web-server.test.js`
  - `agy-daddy-plugin-web/test/plugin-contract.test.js`
  - `agy-daddy-plugin-web/src/web-server.js`
  - `agy-daddy-plugin-web/src/host-proxy.js`
- **TDD 节拍**：
  1. **RED**：编写 loopback 硬锁、`/?token=` → `HttpOnly; SameSite=Strict` Cookie 302 跳转、写操作 `X-Agy-Csrf` 门禁、SSE `Last-Event-ID` 重放/resync、`/api/v1/topbar` 缺失插件降级测试。
  2. **GREEN**：实现零第三方依赖 `node:http` 网关、环形事件缓冲 SSE Broker、`HostProxy`（封装 `host.control.invoke` 与 `context`/`usage`/`quota` 软聚合）。
  3. **VERIFY**：`web-server.test.js` 与 `plugin-contract.test.js` 全绿。

---

## Task 8：`node.js` 集成、`web-harness` 共享服务与 `agy-daddy web` CLI

- **覆盖用例**：Suite E (`E3`)
- **涉及文件**：
  - `agy-daddy-plugin-web/src/node.js`
  - `agy-daddy-plugin-web/test/plugin-contract.test.js`
  - `agy-daddy-host/src/cli.js`
  - `agy-daddy-host/test/injector-and-cli.test.js`
- **TDD 节拍**：
  1. **RED**：在 `plugin-contract.test.js` 用 `mock-harness` 测试完整 `activate()` → 调用 `web-harness` 服务 & `agy-daddy.web.status` 命令 → `dispose()` 端口释放；在 `injector-and-cli.test.js` 补充 `agy-daddy web --no-open` CLI 测试。
  2. **GREEN**：组装 `node.js` 与 CLI `web` 子命令。
  3. **VERIFY**：全仓 `npm test` 通过。

---

## Task 9：PC Web 前端实现（Vite + React 18 + CSS Modules）

- **覆盖用例**：Suite F (`F1`, `F2`)
- **涉及文件**：
  - `agy-daddy-plugin-web/web/package.json`（或根 `devDependencies`，确保运行期 `package.json` 的 `dependencies` 仍为 `{}`）
  - `agy-daddy-plugin-web/web/vite.config.ts`
  - `agy-daddy-plugin-web/web/src/layout/columns.ts` & `.test.ts`
  - `agy-daddy-plugin-web/web/src/harness/*`（会话树、11 类 `SessionEvent` 卡片、Composer + 模型选择 + 停止按钮）
  - `agy-daddy-plugin-web/web/src/dock/*`（工作区文件树、Git Diff、Artifacts 预览）
  - `agy-daddy-plugin-web/web/src/host-admin/*`（插件管理 + 通用 Schema 设置表单 + 命令面板 + Doctor + 顶栏胶囊）
  - `agy-daddy-plugin-web/dist/web/*`（构建产物）
- **TDD 节拍**：
  1. **RED**：先写 `columns.test.ts` 与 `SchemaSettingsForm.test.tsx`，确认失败。
  2. **GREEN**：实现 `columns.ts` 几何引擎与 `SchemaSettingsForm`，随后按模块补全三栏壳、Harness 对话流、Dock 与底座管理台，执行 `vite build` 输出到 `dist/web/`。
  3. **VERIFY**：前端 Vitest 全绿 + `npm run verify:gates` 通过。

---

## Task 10：全仓门禁、Registry SHA-512 更新与端到端实机验收

- **覆盖用例**：Suite F (`F3`)
- **涉及文件**：
  - `agy-daddy-registry/registry.json`（登记 `agy-daddy.web` 与 SHA-512）
- **验收步骤**：
  1. 更新 `registry.json` 并运行 `npm run verify`（`build` + `gates` + 全仓所有包 `test`），确认 0 失败。
  2. 本机启动 `agy-daddy web`，真实浏览器打开 `http://127.0.0.1:18766/?token=...`：
     - 验证 URL token 自动剥离、Cookie 生效；
     - 在独立测试会话发消息并观察 SSE 流式渲染、停止按钮、模型切换；
     - 在右栏 Dock 切换工作区文件树、Git Diff、Artifacts；
     - 在底座管理台修改任一插件设置并验证持久化。
  3. 视觉核验与控制台 zero-error 检查无误后，准备提交特性分支发起 PR。
