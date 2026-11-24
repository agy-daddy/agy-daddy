# Agy-Daddy Web Harness 架构设计与 Phase 0 真机探针报告

> 状态：**架构决议已锁定 · Phase 0 + Phase 0b 真机探针已完成 · 独立 Worktree (`feat/pc-web-harness`) 与 TDD 文档套件已就绪**
> 基准日期：2026-11-23（实测环境：macOS arm64 / Antigravity `2.34.0` / Node `v24.22.1`）

---

## 1. 核心决策摘要（已锁定）

| 决策项 | 锁定结论 |
|---|---|
| **宿主边界** | 先按**后台无感托管模式**推进（Antigravity 主进程驻留后台托管 `language_server`，Web 端完全接管日常交互）；具体窗口关闭行为待 Phase 0b 补充验证 |
| **多端插件形态** | **方案 B：共协议底座 + 双 UI 插件分治**。新建 `agy-daddy-plugin-web`（PC 端对标 `dsh web`，仅绑 `127.0.0.1`，默认全读写）；保留并升级 `agy-daddy-plugin-remote`（移动端 5 通道安全伴侣，默认只读，可选消费 `web-harness` 服务） |
| **前端与门禁策略** | 构建期 `devDependencies` 采用 **Vite + React 18 (TypeScript) + CSS Modules** 编译为静态 `dist/web/`；运行期 `dependencies: {}` 严格保持**零第三方依赖**，完全通过 `scripts/monorepo.js` 全仓门禁 |
| **Phase 1 MVP 范围** | 核心对话 Harness + 底座能力管理台 + 右栏 Dock（工作区文件树、Git Diff 审阅、Artifacts 预览）；浏览器内置 PTY 终端归入 Phase 2+ |

---

## 2. Phase 0 真机探针实测结果

### 2.1 P0-1 进程树与存活机制

- **活跃 Hub 描述文件**：`~/.gemini/antigravity/daemon/hub_62486.json`
  - `pid`: `43681`
  - `httpsPort`: `62485`、`httpPort`: `62486`
  - `lsVersion`: `"2.34.0"`
  - `csrfToken`: 已存在（探针已确认非空，本文不记录原始值）
- **进程父子关系**：
  - 主进程：`Antigravity.app`（PID `43151`，启动参数含 `--remote-debugging-port=0`）
  - 后端服务：`language_server`（PID `43681`，PPID `43151`），启动参数含：
    `--standalone --override_ide_name antigravity --subclient_type hub --override_ide_version 2.34.0 --enable_sidecars --host_bridge_url=http://127.0.0.1:62478 --read_host_bridge_token_from_stdin`
- **架构结论**：
  - `language_server` 强依赖 Electron 主进程提供的 `host_bridge_url` 与 stdin token，完全退出 `Antigravity.app`（`⌘Q`）会连带终止 `language_server`。
  - 在 macOS 下隐藏窗口（`⌘H`）或主进程无窗口后台驻留时服务保持活跃（注：`⌘W` 关闭全部窗口后 `62485` 端口是否持续保活待人工确认）。
- **发现的既有缺陷（须在 Phase 1 修复）**：
  - `~/.gemini/antigravity/daemon/` 中同时残留 3 个已退出旧进程的过期文件（`hub_49618.json`、`hub_64261.json`、`hub_64959.json`，均为 `lsVersion: "2.32.1"`）。
  - 当前 `agy-daddy-host/src/core/rpc.js` 的 `discoverFromHubDaemonFiles()` 仅按 `mtimeMs` 排序选取最新文件，**未校验 `parsed.pid` 是否存活**（应补充 `process.kill(pid, 0)` 存活检查，避免连向僵尸端口或旧实例）。

### 2.2 P0-2 只读 RPC 实测矩阵与延迟

基于 `https://127.0.0.1:62485/exa.language_server_pb.LanguageServerService/<Method>`（Connect JSON 协议）实测结果：

| RPC 方法 | 状态 | 延迟 | 实测返回结构摘要 |
|---|---|---|---|
| `GetUserStatus` | **OK** | 8 ms | 返回 `userStatus`，含 `cascadeModelConfigData.clientModelConfigs`（27 个模型）、`planStatus`、`userTier`、`name`、`email`、`profilePictureUrl` |
| `RetrieveUserQuotaSummary` | **OK** | 3 ms | 返回 `response` |
| `GetAvailableModels` | **OK** | 5 ms | 返回 `response.{models, defaultAgentModelId, agentModelSorts, groupedModels, commandModelIds, imageGenerationModelIds, ...}` |
| `ListAvailableModels` | **HTTP 404** | 3 ms | `404 page not found` —— **2.34.0 已移除该接口**，需从 `constants.js` 白名单或调用链清理 |
| `GetAllCascadeTrajectories` | **OK** | 10 ms | 返回 18 条 `trajectorySummaries`，状态枚举 `CASCADE_RUN_STATUS_RUNNING` / `CASCADE_RUN_STATUS_IDLE`；自带 `summary`、`stepCount`、`lastModifiedTime`、`workspaces[]`（含 `workspaceFolderAbsoluteUri`、`gitRootAbsoluteUri`、`repository`、`branchName`） |
| `GetCascadeTrajectory` | **OK** | 15 ms | 拉取 60 步全量轨迹仅 15 ms，返回 `trajectory.{trajectoryId, cascadeId, trajectoryType, steps, generatorMetadata, executorMetadatas, source, metadata}`、`status`、`numTotalSteps` |
| `GetCascadeTrajectoryGeneratorMetadata` | **OK** | 5 ms | 返回 `generatorMetadata`（含模型/token 用量元数据） |
| `GetCascadeTrajectorySteps` | **OK（未列入白名单）** | — | 返回 `steps`，但传入 `{ startIndex: 0, endIndex: 5 }` 仍返回全量 174 步（分页参数名待核实），且**未在** `agy-daddy-host/src/contracts/constants.js` 的 `RPC_READ_ALLOWLIST` 中声明 |

> **性能与流式结论**：60 步完整轨迹拉取仅需 **15 ms**。即便上游未提供或未公开 Connect Server-Streaming 端点，Node 端基于 `250–400 ms` 轮询增量 `step-index diff` 合成 SSE delta，也足以实现近似实时的流式对话与状态刷新。

### 2.3 P0-2b 实测 Trajectory Step 契约

扫描最近 6 个真实会话共提取 **6 种步骤状态** 与 **11 种步骤类型**：

- **步骤状态枚举**：
  `CORTEX_STEP_STATUS_DONE`、`CORTEX_STEP_STATUS_GENERATING`、`CORTEX_STEP_STATUS_RUNNING`、`CORTEX_STEP_STATUS_PENDING`、`CORTEX_STEP_STATUS_ERROR`、`CORTEX_STEP_STATUS_CANCELED`

- **步骤类型与实测字段**：

| Step Type | 载荷键 | 核心字段（已实测） |
|---|---|---|
| `CORTEX_STEP_TYPE_USER_INPUT` | `userInput` | `items`, `userResponse`, `activeUserState`, `userConfig`, `userAgentSpec`, `clientMessageId` |
| `CORTEX_STEP_TYPE_PLANNER_RESPONSE` | `plannerResponse` | `thinking`, `messageId`, `toolCalls`, `thinkingDuration`, `stopReason`, `response`, `modifiedResponse` |
| `CORTEX_STEP_TYPE_RUN_COMMAND` | `runCommand` | `commandLine`, `proposedCommandLine`, `cwd`, `waitMsBeforeAsync`, `blocking`, `exitCode`, `combinedOutput`, `shellName` |
| `CORTEX_STEP_TYPE_VIEW_FILE` | `viewFile` | `absolutePathUri`, `startLine`, `endLine`, `content`, `lineRangeBytes`, `numLines`, `numBytes` |
| `CORTEX_STEP_TYPE_CODE_ACTION` | `codeAction` | `actionSpec`, `actionResult`, `diffStats` |
| `CORTEX_STEP_TYPE_ASK_QUESTION` | `askQuestion` | `questions`（外层含 `completedInteractions`） |
| `CORTEX_STEP_TYPE_SEARCH_WEB` | `searchWeb` | `query`, `webDocuments`, `summary`, `thirdPartyConfig`, `searchType` |
| `CORTEX_STEP_TYPE_CHECKPOINT` | `checkpoint` | `includedStepIndexEnd`, `sessionSummary`, `artifactSnapshots`, `capturedUserRequests`, `totalSubagentCount`, `accumulatedSections` |
| `CORTEX_STEP_TYPE_SYSTEM_MESSAGE` | `systemMessage` | `message`, `renderInfo`, `eventType` |
| `CORTEX_STEP_TYPE_GENERIC` | `generic` | `args`, `result` |
| `CORTEX_STEP_TYPE_ERROR_MESSAGE` | `errorMessage` | `error` |

### 2.4 P0-3 Phase 0b 写 RPC 实测结果与环境基线

已在独立隔离测试会话 `cascadeId = "b5f0cef4-229c-4f84-b278-ce1d2ccb245d"` 完成 Phase 0b 写探针（详见新 worktree 中 [01-PHASE0-RPC-CONTRACT.md](file:///Volumes/external/worktrees/agy-daddy/feat-pc-web-harness/docs/pc-web-harness/01-PHASE0-RPC-CONTRACT.md)）：

- **`StartCascade`（OK，26 ms）**：必须携带 `source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT"`（缺省返回 `HTTP 400: CortexTrajectorySource is unspecified`），返回 `{ cascadeId }`。
- **`SendUserCascadeMessage`（OK，11 ms）**：入参 `{ cascadeId, items: [{ text }], metadata, cascadeConfig: { plannerConfig: { requestedModel } } }` 返回 `{}`，支持发送时直接指定/切换模型。
- **`GetCascadeTrajectorySteps`（OK，增量偏移已实测）**：传入 `{ cascadeId, stepOffset }` 支持真实偏移增量拉取（97 步轨迹传 `stepOffset: 94` 精确返回 3 步；新会话 300 ms 轮询在 4.33 s 完成整轮并验证 `PROBE_OK`）。
- **`CancelCascadeInvocation`（OK，2 ms）**：传 `{ cascadeId }` 返回 `{}`（对 IDLE 会话调用亦幂等成功；虚拟 UUID 返回 `HTTP 500: cascade not found`）。
- **`AcceptCascadeStep` / `SetUserModelConfig` / `UpdateCascadeSettings`（均返回 HTTP 404）**：Antigravity `2.34.0` `LanguageServerService` 无这 3 个端点。模型切换改由 `SendUserCascadeMessage.cascadeConfig.plannerConfig.requestedModel` 承载；远程审批放行端点需另行探针或 CDP 兜底，Phase 1 先返回 `501 APPROVAL_RPC_UNAVAILABLE_IN_2_34`。
- **待人工确认项**：`⌘W` 关闭所有原生窗口后 `language_server` 端口保活表现。
- **底座运行基线（`agy-daddy doctor --json`）**：`ok: true`，Node `24.22.1`，`agy-daddy` daemon（PID `2223`）运行中，9 个官方 T0 插件全部 `world: "isolated"` / `in-process`，CDP 端口 `62476` 活跃。

---

## 3. 总体架构拓扑与底座能力暴露设计

### 3.1 架构拓扑

```text
+-------------------------------------------------------------------+
|  Antigravity Backend (Local LanguageServer + ~/.gemini/antigravity)|
|  - exa.language_server_pb.LanguageServerService (hub_<port>.json) |
|  - Brain / Artifacts / Conversations / Local Workspace FS         |
+-------------------------------^-----------------------------------+
                                | Connect RPC (Loopback) + FS
+-------------------------------v-----------------------------------+
|  agy-daddy-host (微内核守护进程 — 增强控制面 & 事件流)              |
|  - FourRealmBus (node / page-isolated / remote-client)            |
|  - RPC Allowlist Proxy (Read + Write + 增量 Diff / Stream Adapter)|
|  - Plugin Lifecycle / Managed Settings Schema / Command Engine    |
|  - NEW: host.control 服务 (复用到既有 15 个 /host/* 底座路由)      |
|  - NEW: Bus 通配订阅接口 (驱动 Web SSE Broker)                     |
+----------------^--------------------------------^-----------------+
                 | host.services / host.events    |
   +-------------+-------------+    +-------------+-------------+
   | agy-daddy-plugin-web      |    | agy-daddy-plugin-remote   |
   | (PC Web Harness 桌面替代)  |    | (Mobile PWA 远程安全伴侣)  |
   | - 仅绑 127.0.0.1 (默认全读写)|    | - 5通道+CF/TS穿透+扫码配对  |
   | - 提供 web-harness 服务    |    | - 默认只读/令牌轮换/设备踢出|
   | - 三栏 Dock / Diff /       |    | - 可选消费 web-harness 视图|
   |   Artifacts / 底座管理台   |    | - 单手审批 / 快捷追问 / 监控|
   +-------------^-------------+    +-------------^-------------+
                 | HTTP + SSE                     | HTTPS + SSE (Tunnel)
         [PC 浏览器 / PWA 独立窗]              [手机浏览器 / 桌面图标 PWA]
```

### 3.2 底座管理台零重复复用策略

复查 `agy-daddy-host/src/core/daemon.js`（L1065–L1255）确认，Host 已内置完整的 15 个 `/host/*` 底座管理路由，涵盖：
- 插件全生命周期：`/host/plugins`、`/host/plugins/{toggle,install,uninstall,rollback}`、`/host/marketplace/stats`
- 配置与命令：`/host/host-settings`、`/host/settings`（含 `writeOnly` 密钥脱敏）、`/host/commands/run`
- 运维与诊断：`/host/health`、`/host/reload`、`/host/reload-all`、`/host/daemon/restart`、`/host/diagnostics/export`

因此，`agy-daddy-host` 侧只需 **3 处最小增量**，严禁重写一套插件/配置管理逻辑：
1. 新增 `T0` 专属受限权限 `host:control`，在 `daemon.js` 为 `agy-daddy.web` 注入 `host.control.invoke(routePath, body)`，直接调度既有 `/host/*` 处理器。
2. 在 `FourRealmBus` 增加通配事件/状态监听，向 `plugin-web` 的 SSE Broker 推送 `state:*`、插件热重载与健康事件。
3. 修复 `rpc.js` 中 `discoverFromHubDaemonFiles()` 的 `pid` 存活校验，并同步清理 `constants.js` 的 `RPC_READ_ALLOWLIST`（移除已 404 的 `ListAvailableModels`，按需补充 `GetCascadeTrajectorySteps`）。

### 3.3 Web API 接口契约（`/api/v1/*`）

`agy-daddy-plugin-web` 仅绑定 `127.0.0.1`，首次访问通过一次性 URL token 换取 `HttpOnly; SameSite=Strict` 会话 Cookie，所有写请求校验自定义请求头（防 CSRF）。

| 能力域 | HTTP / SSE 契约 | 底层数据源 | 说明 |
|---|---|---|---|
| **会话列表与详情** | `GET /api/v1/sessions`<br>`GET /api/v1/sessions/:id` | `GetAllCascadeTrajectories` + `GetCascadeTrajectory` | 返回归一化会话摘要与 `SessionEvent[]` 投影 |
| **会话控制** | `POST /api/v1/sessions`（新建）<br>`POST /api/v1/sessions/:id/messages`（发送）<br>`POST /api/v1/sessions/:id/cancel`（停止）<br>`POST /api/v1/sessions/:id/steps/:stepId/approve`（审批/回答） | `StartCascade` / `SendUserCascadeMessage` / `CancelCascadeInvocation` / `AcceptCascadeStep` | 具体入参由 Phase 0b 沙箱探针定稿 |
| **实时事件流** | `GET /api/v1/stream?sessionId=...`（SSE） | `CascadeStreamAdapter` + `FourRealmBus` | 推送 `session.delta`、`step.approval_needed`、`state.patch`、`plugin.status`，支持 `Last-Event-ID` |
| **模型与切换** | `GET /api/v1/models`<br>`PUT /api/v1/sessions/:id/model` | `GetUserStatus` / `GetAvailableModels` / `SetUserModelConfig` | 复用 `plugin-composer` 模型分组与配额联动能力 |
| **工作区与产物** | `GET /api/v1/fs/tree?root=...`<br>`GET /api/v1/fs/read?path=...`<br>`PUT /api/v1/fs/write`<br>`GET /api/v1/git/diff?root=...`<br>`GET /api/v1/artifacts?sessionId=...` | 扩展 `file-service.js` + `git diff` + `~/.gemini/antigravity/brain/<id>` | 严格校验路径归属当前工作区白名单或 `brain/` 目录，防止越权穿越 |
| **底座治理** | `GET /api/v1/host/plugins`<br>`POST /api/v1/host/plugins/:id/{enable,disable,install,uninstall,rollback}`<br>`GET/PUT /api/v1/host/settings`<br>`GET/PUT /api/v1/host/plugins/:id/settings`<br>`POST /api/v1/host/commands/:cmdId`<br>`GET /api/v1/host/doctor` | `host.control.invoke('/host/...')` | 100% 复用 Host 声明式 `settings.schema.json` 引擎 |
| **插件状态挂载** | `GET /api/v1/topbar`<br>`GET /api/v1/panels/:panelId/snapshot` | `host.services.call`（`context`/`usage`/`quota`/`composer`） | 消费现有 `getMobileSnapshot` 及新增 `web.topbar` / `web.dockPanels` |

---

## 4. 多端适配权衡矩阵与双插件协同契约

### 4.1 方案 A vs 方案 B 对比矩阵

| 评估维度 | 方案 A：单插件多端响应式（升级 `plugin-remote`） | 方案 B：双插件分治（`plugin-web` PC + `plugin-remote` 移动，共享服务） |
|---|---|---|
| **安全边界** | **风险高**。本机全读写与公网隧道共存同一进程，需按来源动态裁剪路由，漏判一处即暴露本机代码/配置写权限 | **物理隔离，天然安全**。`plugin-web` 仅绑 `127.0.0.1` 全读写；`plugin-remote` 延续 5 通道 + 默认只读 + 动作白名单，公网不暴露高危接口 |
| **PC 端体验** | 受移动端兼容拖拽/触控约束，三栏 Dock、Diff、快捷键每个交互都要做降级分支 | **无包袱，体验拉满**。专注桌面视口、悬停态、快捷键与多 Tab Dock |
| **移动端体验** | 容易退化为桌面端压缩版，弱网下还要加载重型语法高亮/Diff 包体 | **按场景定制**。单手拇指交互、极速首屏（`<150KB`）、专注状态监控与审批放行 |
| **首期开发成本** | 中高（需同时调通桌面 1440px 与手机 375px + 通道权限矩阵） | **首期更低**（Phase 1 聚焦 PC 替代，现有 `plugin-remote` 零改动继续服役） |
| **长期维护成本** | 随功能增长呈指数上升（PC 新特性拖累手机回归） | **低耦合可控**。核心协议下沉 `web-harness` 服务，两套 UI 独立迭代 |
| **包体积与性能** | 单 SPA 体积大，或需在单插件内维护双入口（实质仍接近方案 B 复杂度） | PC 端可使用完整 React 构建产物；移动端保持极轻零框架/Preact PWA |

### 4.2 共享服务契约（`plugin-web` → `plugin-remote`）

`agy-daddy-plugin-web` 激活后向总线注册 `web-harness` 服务，供 `agy-daddy-plugin-remote` 在 Phase 3 通过 `consumes: { "web-harness": { version: "^1.0.0", optional: true } }` 按需调用：

```js
// agy-daddy-plugin-web 对外提供的共享服务（realm: 'node'）
const webHarnessService = {
  async listSessions({ limit = 20 } = {}) {},
  async getSessionSummary(cascadeId) {},
  async getSessionProjection(cascadeId, { afterStepIndex = 0 } = {}) {},
  async sendMessage(cascadeId, { text, modelId } = {}) {},
  async approveStep(cascadeId, stepIndex, decision /* 'accept' | 'reject' */) {},
  async cancelSession(cascadeId) {}
};
```

未安装 `plugin-web` 时，`plugin-remote` 自动降级回现有的 `context` / `usage` / `quota` 三监控卡片。

---

## 5. 对标 `dsh web` 的 UI/交互规格与工程结构

### 5.1 三栏几何引擎与投影模型

1. **三栏可拖拽布局**：直接借鉴 `deepseek-harness/packages/client/ui-layout/src/client/columns.ts` 算法：
   - 左栏（工作区 & 会话树）：`SIDEBAR_MIN = 264`、`SIDEBAR_MAX = 420`、`SIDEBAR_DEFAULT = 280`、视口 `< 1024px` 自动收折为 `56px` 图标轨。
   - 中栏（对话流 & Composer）：`CENTER_MIN = 400`（优先保护宽度，窗口变窄时先收缩并自动隐藏右栏）。
   - 右栏（多 Tab Dock）：`RIGHTBAR_MIN = 300`、`RIGHTBAR_MAX_RATIO = 0.7`、`RIGHTBAR_DEFAULT_RATIO = 0.45`，承载工作区文件树、Git Diff 审阅、Artifacts 预览、插件面板与底座设置抽屉。
2. **`SessionEvent` 前端统一投影映射**（将 Phase 0 实测的 11 种 `CORTEX_STEP_TYPE_*` 折叠为标准 UI 节点）：
   - `USER_INPUT` → 用户气泡（含附件/引用标签）
   - `PLANNER_RESPONSE` → `ThinkingBlock`（可折叠思考时长 `thinkingDuration`）+ Markdown 正文 + 流式光标
   - `RUN_COMMAND` → 终端命令卡片（命令、cwd、退出码、`combinedOutput` 折叠、`PENDING` 时显示审批按钮）
   - `VIEW_FILE` / `CODE_ACTION` → 文件阅读摘要 / Git Diff 变更卡（基于 `diffStats` 与工作区 diff）
   - `ASK_QUESTION` → 结构化交互选择卡（支持直接回填决策）
   - `SEARCH_WEB` → 检索来源折叠卡
   - `CHECKPOINT` → 检查点分隔符与 `artifactSnapshots` 快捷入口
   - `SYSTEM_MESSAGE` / `GENERIC` / `ERROR_MESSAGE` → 系统/通用工具/错误提示条

### 5.2 `agy-daddy-plugin-web` 目录与门禁兼容

```text
agy-daddy-plugin-web/
├── agy-plugin.json          # id: "agy-daddy.web", world: "isolated", trustLevel: T0
├── package.json             # dependencies: {}, devDependencies: { vite, react, react-dom, typescript }
├── settings.schema.json     # 端口(默认 18766)、自动打开浏览器、工作区根白名单、主题跟随
├── src/                     # 纯 Node.js 运行时（零第三方依赖）
│   ├── node.js              # 注册 web-harness 服务、HTTP/SSE 服务、agy-daddy.web.* 命令
│   ├── web-server.js        # 127.0.0.1 HTTP + SSE + Cookie/CSRF 鉴权 + 静态托管 dist/web/
│   ├── harness-adapter.js   # LanguageServerService 读写封装 + Step 归一化 + 增量 Diff 推流
│   ├── workspace-service.js # 工作区文件树、安全读写、git diff、brain artifacts 预览
│   └── host-proxy.js        # 转发 /api/v1/host/* 到 host.control + 聚合顶栏胶囊快照
├── web/                     # Vite + React 18 + CSS Modules 源码（仅构建期使用）
│   └── vite.config.ts       # build.outDir = '../dist/web'
└── dist/web/                # 预构建静态资源，随插件直接分发
```

**仓库基础设施适配点**：
- `scripts/monorepo.js`：`dependencies: {}` 门禁完全不放宽；`runBuild()` 增加可选 `plugin-web` 构建触发，主题/解耦门禁扫描 `web/src/` 源码而跳过 `dist/web/` 压缩产物。
- `agy-daddy-host/src/cli.js`：新增 `agy-daddy web [--port <n>] [--no-open]` 命令，确保守护进程启动后输出并打开带一次性配对 token 的本机地址。
- `agy-daddy-registry/registry.json`：登记 `agy-daddy.web` 的 T0 元信息并刷新 SHA-512 摘要。

---

## 6. 关键分层接口伪代码

### 6.1 Host 控制面薄代理（`agy-daddy-host/src/core/daemon.js`）

```js
// 仅向授予 `host:control` 权限的 T0 插件开放，零重复复用现有 /host/* 路由
function createHostControlClient(pluginId, permissions, daemon) {
  if (!permissions.includes('host:control')) return null;
  const ALLOWED_PREFIXES = ['/host/plugins', '/host/settings', '/host/host-settings', '/host/commands', '/host/health', '/host/reload', '/host/diagnostics'];
  return {
    async invoke(routePath, body = {}) {
      if (!ALLOWED_PREFIXES.some((p) => routePath.startsWith(p))) {
        throw new Error(`HOST_CONTROL_ROUTE_BLOCKED: ${routePath}`);
      }
      return daemon.bridge.invokeHostRoute(routePath, body);
    },
    subscribeBus(listener) {
      return daemon.bus.onAny((evt) => listener(evt));
    }
  };
}
```

### 6.2 Harness 适配器增量推流（`agy-daddy-plugin-web/src/harness-adapter.js`）

```js
class AntigravityHarnessAdapter {
  constructor({ rpc }) { this.rpc = rpc; this.snapshots = new Map(); }

  async pollDelta(cascadeId) {
    const resp = await this.rpc.call('GetCascadeTrajectory', { cascadeId });
    const steps = resp?.trajectory?.steps || [];
    const prev = this.snapshots.get(cascadeId) || { len: 0, lastSig: '' };
    const nextEvents = [];
    // 仅切片发送新增或状态/内容发生变化的尾部步骤（如 GENERATING 中的最后一步）
    const startIdx = Math.max(0, prev.len - 1);
    for (let i = startIdx; i < steps.length; i++) {
      const normalized = normalizeStepToSessionEvent(i, steps[i]);
      const sig = `${steps[i].status}:${JSON.stringify(normalized).length}`;
      if (i >= prev.len || sig !== prev.lastSig) nextEvents.push(normalized);
    }
    const lastStep = steps[steps.length - 1];
    this.snapshots.set(cascadeId, {
      len: steps.length,
      lastSig: lastStep ? `${lastStep.status}:${JSON.stringify(normalizeStepToSessionEvent(steps.length - 1, lastStep)).length}` : ''
    });
    return { status: resp?.status, totalSteps: steps.length, events: nextEvents };
  }
}
```

### 6.3 插件 Web 扩展点声明（`agy-plugin.json`）

```json
{
  "contributes": {
    "web.topbar": [
      { "id": "context.capsule", "service": "context", "method": "getMobileSnapshot", "order": 10 },
      { "id": "quota.capsule", "service": "quota", "method": "getMobileSnapshot", "order": 20 }
    ],
    "web.dockPanels": [
      { "id": "usage.ledger", "title": { "zh-CN": "用量账本", "en": "Usage" }, "service": "usage", "method": "getMobileSnapshot" }
    ]
  }
}
```

---

## 7. 分阶段落地路线图与验收标准

| 阶段 | 核心目标 | 关键交付物 | 可检验验收标准 |
|---|---|---|---|
| **Phase 0b：写 RPC 沙箱探针（0.5–1 天）** | 锁定写协议与窗口关闭行为 | 1. 在隔离测试会话实测 `StartCascade`、`SendUserCascadeMessage`、`AcceptCascadeStep`、`SetUserModelConfig` 入参/回包<br>2. 确认是否存在 Connect 流式端点与 `GetCascadeTrajectorySteps` 分页参数<br>3. 验证 `⌘W` 关窗后 `hub_*.json` 端口保活 | 补齐写 RPC 契约表，无未知阻塞接口 |
| **Phase 1：Host 增量 + `plugin-web` MVP（1 周）** | 在浏览器完成日常对话与底座治理 | 1. Host 修复 `hub_*.json` PID 存活校验、增加 `host:control` 与 `onAny` 总线订阅<br>2. `agy-daddy-plugin-web` 落地：三栏布局、实时会话流、发送/停止/审批、模型切换、工作区文件树/Diff/Artifacts、全插件 Schema 设置中心、`agy-daddy web` CLI | 1. `npm run verify`（含零运行依赖、isolated、主题、SHA-512 门禁）全过<br>2. 浏览器访问 `127.0.0.1:<port>` 跑通“新建/切换会话 → 发消息 → 看思考/工具流 → 审批 → 查看 Diff → 修改插件设置” |
| **Phase 2：`dsh web` 体验打磨 + 终端（1–2 周）** | 全面追平桌面高频效率 | 全局 `Cmd+K` 命令面板、Composer 快捷词与图片粘贴、可选本地 PTY 终端 Tab、`context`/`usage`/`quota`/`chat-nav` 深度面板 | 连续 1 个工作日纯浏览器完成编码与 Agent 协作，无需切回 Antigravity 原生窗口 |
| **Phase 3：双插件联动升级（3–5 天）** | 手机端共享会话与远程审批 | `agy-daddy-plugin-remote` 可选消费 `web-harness` 服务，增加手机端实时追踪 + 单手审批 + 快捷追问 | Cloudflare/Tailscale 手机端可看实时对话与审批，且 `allowRemoteWrite: false` 时仍严格返回 `403 REMOTE_WRITE_DISABLED` |
