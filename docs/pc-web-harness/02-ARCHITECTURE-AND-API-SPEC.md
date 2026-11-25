# 02 · PC Web Harness 架构与接口规范

> 关联文档：[01-PHASE0-RPC-CONTRACT.md](./01-PHASE0-RPC-CONTRACT.md) · [03-TDD-TEST-MATRIX-AND-SPEC.md](./03-TDD-TEST-MATRIX-AND-SPEC.md)

---

## 1. 架构拓扑与方案 B 双插件边界

### 1.1 分层拓扑

```text
+-------------------------------------------------------------------+
|  Antigravity Backend (Local LanguageServer + ~/.gemini/antigravity)|
|  - LanguageServerService Connect RPC (hub_<port>.json)            |
|  - Brain / Artifacts (~/.gemini/antigravity/brain/<id>)           |
|  - Local Workspace FS + Git                                       |
+-------------------------------^-----------------------------------+
                                | Connect RPC (Loopback) + FS
+-------------------------------v-----------------------------------+
|  agy-daddy-host (微内核守护进程)                                   |
|  - FourRealmBus (+ onAny 通配订阅)                                 |
|  - RPC Allowlist Proxy (PID 存活校验 + 清理后读写白名单)            |
|  - Host Control Thin Proxy (host:control -> /host/* 路由复用)     |
|  - Managed Settings Schema Engine & Command Engine                |
+----------------^--------------------------------^-----------------+
                 | host.services / host.events    |
   +-------------+-------------+    +-------------+-------------+
   | agy-daddy-plugin-web (PC) |    | agy-daddy-plugin-remote   |
   | - 多通道: Loopback/LAN/TS  |    | - 5通道 / Tunnel / 扫码    |
   |   /Bonjour/Cloudflare     |    |                           |
   | - 默认全读写 + Cookie/CSRF |    | - 默认只读 + 动作白名单    |
   | - 提供 web-harness 服务    |    | - Phase 3 可选消费服务     |
   | - 三栏 Dock/Diff/底座管理台|    | - 手机单手监控与轻交互     |
   +-------------^-------------+    +-------------^-------------+
                 | HTTP + SSE (多通道监听)        | HTTPS + SSE (Tunnel)
         [PC 浏览器 / PWA 独立窗]              [手机浏览器 / 桌面 PWA]
```

### 1.2 双插件职责硬隔离

| 维度 | `agy-daddy-plugin-web`（PC 桌面替代） | `agy-daddy-plugin-remote`（移动端伴侣，保留既有架构） |
|---|---|---|
| **监听地址** | 按通道开关控制：默认仅 `127.0.0.1`，启用 LAN / Tailscale / Bonjour 任一通道时自动绑定 `0.0.0.0`；未启用任何非回环通道时拒绝非回环绑定（`ERR_CHANNEL_NOT_ENABLED`） | 按 5 通道开关控制（默认 `127.0.0.1`，可选 LAN/TS/CF） |
| **默认权限** | 回环通道全读写；非回环通道按 `remotePermissionLevel` 分级（默认 `L0` 只读，可选 `L1` 对话 / `L2` 全量），写接口仍需 CSRF Header 与配对 Cookie | 默认只读（`allowRemoteWrite: false`），写动作逐一白名单 |
| **能力范围** | 完整对话、模型切换、文件树/读写、Git Diff、Artifacts、Host 全部 9+ 插件管理与设置中心 | 顶栏监控卡片 +（Phase 3）可选会话追踪与白名单快捷交互 |
| **包与渲染** | `dependencies: {}`，构建期 Vite + React 18 产出静态 `dist/web/` | 轻量无框架 PWA（`<150KB`），不下载桌面 Diff/编辑器包体 |

---

## 2. `agy-daddy-host` 最小增量规范

1. **`src/core/rpc.js`**：
   - `discoverFromHubDaemonFiles()` 在汇总候选文件时校验 `isPidAlive(parsed.pid)`（`process.kill(pid, 0)`，允许通过 `options.isPidAlive` 注入测试桩）；若全部文件均带无效 `pid`，返回 `null`（不连僵尸端口）。
   - 向后兼容测试 fixture：若文件未含 `pid` 字段或测试显式注入 `skipPidCheck: true` 可按既有逻辑处理（生产盘上真实 `hub_*.json` 经 Phase 0 实测均包含 `pid` 字段）。
2. **`src/contracts/constants.js`**：
   - `RPC_READ_ALLOWLIST`：加入 `GetCascadeTrajectorySteps`（Phase 0/0b 实测 `stepOffset` 增量可用）；保留或按兼容测试需要处理 `ListAvailableModels`（注意现有单测 `bus-bridge-rpc.test.js` 若断言现有集合需核对后再调整）。
   - `STATIC_PERMISSIONS`：新增 `host:control`（列入 `HIGH_RISK_PERMISSIONS` 与 `T1_RESTRICTED_PERMISSIONS`，仅授予 `T0` 官方插件）。
3. **`src/core/bus.js`（或 `FourRealmBus`）**：
   - 新增 `onAny(listener)`：接收 `{ kind: 'event' | 'state', topicOrKey, payload, meta }`，返回 `dispose()` 清理函数。
4. **`src/core/daemon.js` & `src/core/bridge.js`**：
   - `bridge` 暴露内部可复用方法 `invokeHostRoute(fullPath, body)`，供 `daemon` 向持有 `host:control` 权限的插件提供 `host.control.invoke(routePath, body)`，直接复用既有 `/host/*` 全部逻辑。
5. **`src/cli.js`**：
   - 新增 `agy-daddy web [--port <n>] [--no-open]`：确保 daemon 与 `agy-daddy.web` 就绪，输出并打开 `http://127.0.0.1:<port>/?token=<ephemeral>`。

---

## 3. `/api/v1/*` HTTP + SSE 接口契约

### 3.1 通道模型、鉴权与安全头

- **通道开关**：`settings.schema.json` 提供 `loopback` / `lan` / `tailscale` / `bonjour` / `cloudflare` 五个布尔开关与 `bindHost`（`auto` / `loopback` / `lan`）、`tunnelHostname`、`remotePermissionLevel`。默认仅回环通道，升级安装行为不变。
- **监听地址推导**：`bindHost: auto` 时，仅在启用 `lan` / `tailscale` / `bonjour` 任一通道才绑定 `0.0.0.0`；`cloudflare` 由 cloudflared 连向 `127.0.0.1:<port>`，不扩宽绑定。未启用非回环通道却要求非回环绑定 → `ERR_CHANNEL_NOT_ENABLED`；绑定非本机网卡地址 → `ERR_BIND_HOST_NOT_LOCAL`；`bindHost: loopback` 与外部通道冲突 → `ERR_BIND_HOST_CONFLICT`。显式传入的 `host` 只被重新校验，不被静默改写。`reconcileAccess()` 通过串行 Promise 链应用热更新；若新监听地址 `start()` 失败则自动回退至 `previousHost` 恢复监听。
- **逐请求通道识别**：`classifyRequestChannel()` 将 `cf-*` / 隧道域名请求头信任限制在回环源地址（本机 `cloudflared`），将 `*.ts.net` / `tailscale-user-login` 请求头信任限制在回环或 Tailscale 网段源地址，避免绑定 `0.0.0.0` 时跨通道请求头伪造；未启用通道一律 `403 { ok: false, error: 'CHANNEL_DISABLED', channel, allowedChannels }`，`external` 永不放行。
- **权限分级**（仅作用于非回环通道）：`L0` 只读（GET/HEAD + SSE，且 `/api/v1/web/status` 在非回环 `L0` 下隐藏 `pairingToken`）、`L1` 增加会话与对话写、`L2` 增加文件写入、Git、插件与宿主设置；越级返回 `403 { ok: false, error: 'PERMISSION_DENIED', required, current, channel }`。回环通道始终全读写。
- **Cloudflare 二次确认**：该通道上的写操作另需 `X-Agy-Confirm` 携带 HMAC 令牌（`POST /api/v1/confirm` 或 403 响应体下发），令牌绑定 `${method} ${pathname}`、默认 60s 有效；缺失返回 `403 { ok: false, error: 'CONFIRMATION_REQUIRED', action, confirmToken }`，前端工作台捕获后弹出确认对话框，用户确认后方携带令牌重试。
- **Token → Cookie 交换**：
  - 访问 `GET /?token=<pairingToken>` 时使用 `crypto.timingSafeEqual` 校验通过后，下发 `Set-Cookie: agy_web_sid=<sessionSecret>; HttpOnly; SameSite=Strict; Path=/` 并 `302` 重定向至 `/`（剥离 URL 中的敏感 token）。
  - 所有 `/api/v1/*` 需携带有效 Cookie（或 `Authorization: Bearer <pairingToken>` 供 CLI/单测使用）；未鉴权返回 `401 { ok: false, error: 'UNAUTHORIZED' }`。
- **写操作防 CSRF**：所有 `POST` / `PUT` / `DELETE` 请求（使用 Cookie 鉴权时）必须携带 `X-Agy-Csrf: 1` 且 `Origin` 必须与本次请求的 `Host` 同源（回环通道额外保留 loopback Origin 规则）；缺失返回 `403 { ok: false, error: 'CSRF_REQUIRED' }`。
- **固定安全响应头**：`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`、CSP `frame-ancestors 'none'`。

### 3.2 端点规范表

| 端点 | 方法 | 请求体 / 查询参数 | 响应体（200） | 错误码 |
|---|---|---|---|---|
| `/api/v1/health` | `GET` | — | `{ ok: true, rpcConnected, hubOrigin, pluginVersion }` | `401` |
| `/api/v1/web/status` | `GET` | — | `{ ok, running, channel, channels, activeChannels, urls, primaryChannel, primaryUrl, permissionLevel, allowRemoteWrite, bindHost }` | `401`, `403 CHANNEL_DISABLED` |
| `/api/v1/confirm` | `POST` | `{ action: "POST /api/v1/sessions" }` | `{ ok: true, action, confirmToken, expiresInMs }` | `400 MISSING_ACTION`, `401`, `403 PERMISSION_DENIED` |
| `/api/v1/sessions` | `GET` | `?limit=50` | `{ ok: true, sessions: SessionSummary[] }` | `401`, `502` |
| `/api/v1/sessions` | `POST` | `{ title?, workspaceUri? }` | `{ ok: true, cascadeId }`（调用 `StartCascade`） | `401`, `403`, `502` |
| `/api/v1/sessions/:id` | `GET` | — | `{ ok: true, session: SessionDetail, events: SessionEvent[] }` | `401`, `404`, `502` |
| `/api/v1/sessions/:id/messages` | `POST` | `{ text, modelId?, attachments? }` | `{ ok: true, cascadeId }`（调用 `SendUserCascadeMessage`） | `400`, `401`, `403`, `502` |
| `/api/v1/sessions/:id/cancel` | `POST` | — | `{ ok: true, cascadeId }`（调用 `CancelCascadeInvocation`） | `401`, `403`, `502` |
| `/api/v1/sessions/:id/steps/:stepIdx/approve` | `POST` | `{ decision: 'accept' \| 'reject', payload? }` | `{ ok: true, supported: false, error: 'APPROVAL_RPC_UNAVAILABLE_IN_2_34' }`（**501**，待 Phase 0c 确认真实 RPC 后启用） | `401`, `403`, `501` |
| `/api/v1/stream` | `GET` | `?sessionId=<id>` + `Last-Event-ID` | `text/event-stream`，帧格式见 3.3 | `401` |
| `/api/v1/models` | `GET` | — | `{ ok: true, defaultModelId, models: ModelItem[], groups: ... }` | `401`, `502` |
| `/api/v1/fs/tree` | `GET` | `?root=<dir>&path=<rel>&depth=2` | `{ ok: true, root, entries: FsNode[] }` | `400`, `401`, `403 PATH_OUTSIDE_WORKSPACE` |
| `/api/v1/fs/read` | `GET` | `?root=<dir>&path=<rel>` | `{ ok: true, path, size, truncated, content }` | `403`, `404`, `413` |
| `/api/v1/fs/write` | `PUT` | `{ root, path, content }` | `{ ok: true, path, bytes }` | `403`, `413` |
| `/api/v1/git/diff` | `GET` | `?root=<dir>&path=<rel?>` | `{ ok: true, isGitRepo, branch, files: DiffFile[], diffText }` | `403` |
| `/api/v1/artifacts` | `GET` | `?sessionId=<id>&file=<name?>` | 列表 `{ ok: true, items }` 或文件 `{ ok: true, name, mime, content }` | `403`, `404` |
| `/api/v1/host/plugins` | `GET` | — | `{ ok: true, plugins, catalog, marketStats }` | `401`, `503` |
| `/api/v1/host/plugins/:id/:action` | `POST` | `action ∈ {enable,disable,install,uninstall,rollback}` | 透传 `/host/plugins/*` 结果 | `400`, `401`, `403` |
| `/api/v1/host/settings` | `GET` / `PUT` | `{ patch }` | `{ ok: true, values }` | `400`, `401`, `403` |
| `/api/v1/host/plugins/:id/settings` | `GET` / `PUT` | `{ patch }` | `{ ok: true, values, secretState, schema }` | `400`, `401`, `403` |
| `/api/v1/host/commands/:cmdId` | `POST` | `{ args?: unknown[], pluginId?: string }` | `{ ok: true, result }` | `401`, `403`, `404` |
| `/api/v1/host/doctor` | `GET` | — | 结构化 `doctor` 报告 | `401` |
| `/api/v1/topbar` | `GET` | — | `{ ok: true, panels: { context, usage, quota } }`（软降级 `{ available: false }`） | `401` |

### 3.3 SSE 事件帧规范

```text
id: 42
event: session.delta
data: {"cascadeId":"...","status":"CASCADE_RUN_STATUS_RUNNING","totalSteps":3,"events":[...]}

id: 43
event: state.patch
data: {"key":"state:context.snapshot@1","value":{...}}

event: heartbeat
data: {"ts":1795447000000}
```

- 服务端在内存中维护最近 `N=200` 条环形事件缓冲；重连携带 `Last-Event-ID: 40` 时自动重放 `41..latest`，超窗则下发 `event: session.resync` 提示客户端拉取一次全量 `GET /api/v1/sessions/:id`。

---

## 4. `dsh web` 对标布局几何与投影模型

### 4.1 三栏几何函数契约（纯函数 `computeColumns`）

直接对标 `deepseek-harness/packages/client/ui-layout/src/client/columns.ts`：

- `SIDEBAR_MIN = 264`, `SIDEBAR_MAX = 420`, `SIDEBAR_DEFAULT = 280`, `SIDEBAR_COLLAPSED = 56`, `SIDEBAR_AUTO_COLLAPSE = 1024`
- `CENTER_MIN = 400`
- `RIGHTBAR_MIN = 300`, `RIGHTBAR_MAX_RATIO = 0.7`, `RIGHTBAR_DEFAULT_RATIO = 0.45`
- 约束规则：先计算 `sidebar`（若 `viewport < 1024` 且未手动展开则用 `56`），再用 `available = viewport - sidebar - CENTER_MIN` 决定右栏；若 `available < RIGHTBAR_MIN` 则强制隐藏右栏（`rightbar = 0`），优先保护中栏对话可读性。

### 4.2 `SessionEvent` 投影模型（11 种 Step 类型归一化）

每条 `SessionEvent` 具备统一骨架：
```ts
export interface SessionEvent {
  seq: number;                // 对应 stepIndex (0-based)
  kind: 'user' | 'thinking_and_text' | 'command' | 'file_view' | 'code_action'
      | 'ask_question' | 'web_search' | 'checkpoint' | 'system' | 'tool_generic' | 'error';
  status: 'pending' | 'running' | 'generating' | 'done' | 'error' | 'canceled';
  rawType: string;
  title?: string;
  payload: Record<string, unknown>;
}
```

---

## 5. `web-harness` 共享服务契约（供 `plugin-remote` Phase 3 消费）

`agy-daddy-plugin-web` 通过 `host.services.provide('web-harness', ..., { realm: 'node', version: '1.0.0' })` 暴露：
- `listSessions({ limit })`
- `getSessionDetail(cascadeId)`
- `getSessionDelta(cascadeId, { afterSeq })`
- `sendMessage(cascadeId, { text, modelId })`
- `cancelSession(cascadeId)`
- `getStatus()`

> 说明：移动端 `plugin-remote` 仅通过弱依赖 `consumes: { "web-harness": { version: "^1.0.0", optional: true } }` 消费上述只读与白名单写动作，绝不暴露 `fs/write` 或 `host/plugins/install`。
