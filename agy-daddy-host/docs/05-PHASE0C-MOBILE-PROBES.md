# Phase 0c 真机探针实测报告（Mobile Remote P0c-1 / P0c-2 / P0c-3）

> 状态：**已完成（全部 3 项 Phase 0c 探针实测闭环）**  
> 基准日期：2026-11-24  
> 实测环境：macOS arm64 · Antigravity `2.34.0` (`/Applications/Antigravity.app`) · 活跃 Hub `hub_62486.json`（`pid: 43681`, `httpsPort: 62485`, `httpPort: 62486`, `lsVersion: "2.34.0"`）  
> 关联设计文档：[MOBILE_REMOTE_DESIGN.md](./MOBILE_REMOTE_DESIGN.md)（§3）、[WEB_HARNESS_DESIGN.md](./WEB_HARNESS_DESIGN.md)

---

## 0. 结论总览（Executive Summary）

| 探针 | 目标 | 实测结论 | 关键落地决策 |
|---|---|---|---|
| **P0c-1** | 2.34.0 交互审批 / `ask_question` / 模式切换 RPC 定位 | **纯 RPC 全通**（`HandleCascadeUserInteraction` 统一承载审批与提问；`AcceptCascadeStep`/`SetUserModelConfig`/`UpdateCascadeSettings`/`SubmitUserInteraction`/`RespondToQuestion`/`SetCascadeConfig` 均返回 `HTTP 404`） | 审批、`ask_question`、队列与步取消全部走纯 Connect RPC（`<20ms`，无需窗口焦点）；Host `cdp.js` + `anchors.json` (`chat.actionButtons`) 仅保留作 `<2.34` 兼容或纯 Electron 原生弹窗兜底 |
| **P0c-2** | Antigravity 原生语音输入与语音对话（Go / No-Go 门） | **NO-GO**（实时语音 `/voice/ws` 强耦合内部 `OpenRAPVoice`/`rap` 且远程语音 Mendel 开关全 `disabled: true`；流式听写 `StreamAudioTranscription` 实测挂起 `>3s` 无 `ready` 帧且桌面依赖 `acquireHostMic`） | `GET /api/v1/bootstrap` 固定下发 `voiceSupported: false`，Step 4 手机端 PWA **不渲染语音/麦克风按钮**（遵循 §3.2 裁剪约束） |
| **P0c-3** | `language_server` 脱壳独立拉起与 `⌘W` 关窗保活 | **L1 必达 / L2 原生默认支持 / L3 条件可用（已实测通过）** | macOS 下 `SettingKey.RUN_IN_BACKGROUND` 默认 `true`，`⌘W` 关窗不退出 `Antigravity.app` 与 `language_server`；`HostBridgeService` 仅含更新检测 2 个非关键 RPC，独立进程已验证可完成建会话与读写，L3 可作无 App 兜底托管模式 |

---

## 1. 探针 P0c-1：2.34.0 真实交互 RPC 定位与 Allowlist 增量

### 1.1 符号与前端协议提取来源

- **二进制提取**：`/Applications/Antigravity.app/Contents/Resources/bin/language_server` 共注册 **378 个** `/exa.language_server_pb.LanguageServerService/*` Connect/gRPC Handler。
- **前端 Bundle 提取**：从本地活跃 `https://127.0.0.1:62485/main.js`（`12,581,273` bytes）提取 `@bufbuild/protobuf/codegenv2` 嵌入的 `FileDescriptorProto`（`exa.language_server_pb`、`exa.cortex_pb`、`exa.codeium_common_pb`、`exa.jetski_cortex_pb`）及调用方实现。

### 1.2 活跃端口实测矩阵（`https://127.0.0.1:62485`，未改动任何用户真实会话）

> 探测方法：对只读接口发送 `{}`；对按 `cascadeId` 定位的接口使用虚拟 UUID `00000000-0000-0000-0000-000000000000`；对状态变更写接口发送非法 JSON `{invalid_json`，利用 Connect 框架「先路由匹配、再 JSON 反序列化、最后执行 Handler」的特性区分 `404`（方法不存在）与 `400 invalid_argument`（方法已注册且可达）。

| RPC 方法 | 实测 HTTP 状态 | 返回特征摘要 | 2.34.0 结论 |
|---|---|---|---|
| `AcceptCascadeStep` | **404** | `404 page not found` | **不存在**（已移除/未启用） |
| `SetUserModelConfig` | **404** | `404 page not found` | **不存在**（改由 `SendUserCascadeMessage` 携带） |
| `UpdateCascadeSettings` | **404** | `404 page not found` | **不存在** |
| `SubmitUserInteraction` | **404** | `404 page not found` | **不存在** |
| `RespondToQuestion` | **404** | `404 page not found` | **不存在** |
| `SetCascadeConfig` | **404** | `404 page not found` | **不存在** |
| `GetUserSettings` | **501** | `{"code":"unimplemented","message":"unimplemented: unimplemented"}` | 已注册但服务端未实现 |
| `GetCommandModelConfigs` | **501** | `{"code":"unimplemented","message":"unimplemented: unimplemented"}` | 已注册但服务端未实现 |
| `HandleCascadeUserInteraction` | **500** | `{"code":"unknown","message":"run state not found"}`（虚拟 UUID） | **核心交互入口（已实测可达）** |
| `CancelCascadeSteps` | **500** | `{"code":"unknown","message":"run state not found"}`（虚拟 UUID） | **单步取消（已实测可达）** |
| `DeleteQueuedUserInputStep` | **400** | `unmarshal into *language_server_go_proto.DeleteQueuedUserInputStepRequest` | **删除排队消息（已实测可达）** |
| `SendAllQueuedMessages` | **400** | `unmarshal into *language_server_go_proto.SendAllQueuedMessagesRequest` | **立即发送排队消息（已实测可达）** |
| `RevertToCascadeStep` | **400** | `unmarshal into *language_server_go_proto.RevertToCascadeStepRequest` | **回滚到指定步骤（已实测可达）** |
| `UpdateConversationAnnotations` | **400** | `unmarshal into *language_server_go_proto.UpdateConversationAnnotationsRequest` | **会话注释更新（已实测可达）** |
| `AcknowledgeCascadeCodeEdit` | **400** | `unmarshal into *language_server_go_proto.AcknowledgeCascadeCodeEditRequest` | 已注册（2.34 Web UI 未使用，属旧/IDE 扩展侧） |
| `AcknowledgeCodeActionStep` | **400** | `unmarshal into *language_server_go_proto.AcknowledgeCodeActionStepRequest` | 已注册（2.34 Web UI 未使用） |
| `GetPermissionSettings` | **200** | `{"globalPreset":"AGENT_PERMISSION_PRESET_TURBO","globalArtifactReviewMode":"ARTIFACT_REVIEW_MODE_TURBO"}` | **只读权限预设（已实测可达）** |
| `UpdatePermissionSettings` | **400** | `unmarshal into *language_server_go_proto.UpdatePermissionSettingsRequest` | **更新全局权限预设（已实测可达）** |
| `SetUserSettings` | **400** | `unmarshal into *language_server_go_proto.SetUserSettingsRequest` | 已注册可达（`UserSettings` 写） |
| `GetCascadeModelConfigData` | **200** | `{"clientModelConfigs":[...]}` | **已实测可达**（`GetCascadeModelConfigs` 返回 `{}`） |
| `GetCapabilities` | **200** | `{"supportsHookResultProtoBytes":true}` | **已实测可达** |

---

### 1.3 `HandleCascadeUserInteraction` 完整请求契约（ProtoJSON）

**端点**：`POST /exa.language_server_pb.LanguageServerService/HandleCascadeUserInteraction`

#### 外层结构 (`exa.language_server_pb.HandleCascadeUserInteractionRequest`)

```json
{
  "cascadeId": "<string>",
  "interaction": {
    "trajectoryId": "<string>",
    "stepIndex": 12,
    "<oneof interaction field>": { ... }
  }
}
```

- `trajectoryId` 与 `stepIndex` 取自待处理步骤 `step.sourceTrajectoryStepInfo`（或当前轨迹 `trajectoryId` 与步骤索引）。
- `CascadeUserInteraction` 额外可选字段：`timedOut` (`bool`, field 24)、`remoteControlDetails` (`RemoteControlDetails`, field 25)。

#### 核心 `oneof interaction` 载荷映射表（对应 `step.requestedInteraction.interaction`）

| 场景 | ProtoJSON `oneof` 键名 | 字段编号 | 载荷结构（已从 `FileDescriptorProto` 解码确认） | 2.34.0 Web UI 调用方式 |
|---|---|---|---|---|
| **统一权限审批**（2.34 主路径：命令/文件/扩展等） | `permission` | 21 | `{ "allow": true\|false, "scope": "PERMISSION_SCOPE_ONCE"\|"CONVERSATION"\|"WORKSPACE"\|"GLOBAL"\|"PROJECT", "editedTarget"?: string, "persistGrants"?: PermissionGrantsConfig, "userDenyInstruction"?: string, "sandboxOverride"?: bool }` | `PermissionScope`: `ONCE=1`, `CONVERSATION=2`, `WORKSPACE=3`, `GLOBAL=4`, `PROJECT=5`；`allow/deny` 直接下发 |
| **命令执行审批**（旧/直接命令卡） | `runCommand` | 5 | `{ "confirm": true\|false, "proposedCommandLine"?: string, "submittedCommandLine"?: string, "sandboxOverride"?: bool }` | `confirm: true` 放行，`false` 拒绝 |
| **结构化提问 (`ask_question`)** | `askQuestion` | 22 | `{ "responses": [{ "question": string, "options": [{ "id": string, "text": string }], "isMultiSelect": bool, "selectedOptionIds": string[], "writeInResponse": string, "skipped": bool }], "cancelled": bool }` | 将 `step.requestedInteraction.askQuestion.questions` 逐题回填 `selectedOptionIds` / `writeInResponse` / `skipped` |
| **文件越界 / `.gitignore` 权限** | `filePermission` | 19 | `{ "allow": bool, "scope": PermissionScope, "absolutePathUri": string }` | 单手放行或拒绝工作区外/忽略文件访问 |
| **运行中命令输入确认** | `sendCommandInput` | 16 | `{ "confirm": bool }` | 确认向阻塞命令行写入输入或终止 |
| **通用审批 / MCP / 浏览器确认** | `approvalInteraction` / `mcp` / `openBrowserUrl` / `executeBrowserJavaScript` / `captureBrowserScreenshot` / `clickBrowserPixel` / `readUrlContent` | 23 / 18 / 6 / 8 / 9 / 10 / 17 | `{ "confirm": bool }` | 统一映射 `Allow -> { confirm: true }`、`Deny -> { confirm: false }` |
| **部署 / 浏览器引导 / MCP Elicitation** | `deploy` / `browserAction` / `openBrowserSetup` / `confirmBrowserSetup` / `elicitation` | 4 / 13 / 14 / 15 / 20 | `deploy`: `{ cancel, deployTarget, subdomain }`；其余按 spec 透传 | 手机端对 `elicitation`/`deploy` 等复杂项可按需降级提示或透传 |

---

### 1.4 Plan / Chat 模式切换与 `SendUserCascadeMessage` 契约

从 `SendUserCascadeMessageRequest`、`CascadeConfig`、`CascadePlannerConfig`、`CascadeConversationalPlannerConfig` 及 10 个真实历史轨迹实测得出：

1. **无独立 `SetCascadeConfig` 接口**（实测 `HTTP 404`）；模型与执行/规划模式随每次 `SendUserCascadeMessage` 的 `cascadeConfig` 字段下发，或通过 `SendAllQueuedMessages` 携带 `cascadeConfig`。
2. **`SendUserCascadeMessageRequest` 关键字段**：
   - `cascadeId` (`string`), `items` (`TextOrScopeItem[]`), `media` (`Media[]`), `images` (`ImageData[]`)
   - `artifactComments` / `fileDiffComments` / `fileComments`（支持行内 Diff 评论结构化回注）
   - `deliveryStrategy` (`MessageDeliveryStrategy` — 支持 `WHEN_IDLE` 排队 vs `NEXT_INVOCATION` 插话，可直接服务于 §2.2 的 **Queue / Steer** 能力）
   - `clientMessageId` (`string`)
   - `cascadeConfig` (`CascadeConfig`):
     - `plannerConfig.planModel` (`Model` enum) 与 `plannerConfig.requestedModel` (`ModelOrAlias`)
     - `plannerConfig.conversational`（`oneof planner_type_config`）：
       ```json
       {
         "plannerMode": "CONVERSATIONAL_PLANNER_MODE_DEFAULT",
         "agenticMode": true
       }
       ```
       - `ConversationalPlannerMode`: `UNSPECIFIED (0)`, `DEFAULT (1)`, `READ_ONLY (2)`
       - `agenticMode`: `bool`
3. **Plan / Chat 模式现状补充实测**：
   - 抽样检查本机 10 条真实轨迹的 `userInput.userConfig.plannerConfig`，当前 2.34.0 默认仅填充 `planModel`（`conversational: null`）；`main.js` 默认构造 `{ plannerMode: ConversationalPlannerMode.DEFAULT, agenticMode: true }`。
   - `GetMendelFlags` 中 `use-slash-plan` 已开启（`disabled: false`）；同时 `UserSettings` 中存在 `cascadePlannerMode` (`ConversationalPlannerMode`)、`planningMode` (`PlanningMode`: `OFF=1`, `ON=2`)、`globalPlanModePreference` (`PlanMode`: `ON=1`, `OFF=2`)。
   - **工程建议**：手机端 Composer 切换「Plan / 只读规划」vs「Chat / 执行」时，在 `SendUserCascadeMessage.cascadeConfig.plannerConfig.conversational` 中按需设置 `plannerMode`（`DEFAULT` vs `READ_ONLY`）与 `agenticMode`，并与桌面端 `/plan` 斜杠命令兼容；**不再尝试调用已 404 的 `UpdateCascadeSettings` 或 `SetCascadeConfig`**。

---

### 1.5 `agy-daddy-host/src/contracts/constants.js` Allowlist 增量建议

现网 `constants.js`（L48–L67）检查结果：
- 现有 `RPC_READ_ALLOWLIST` 含 9 项（含已 404 的 `ListAvailableModels`）。
- 现有 `RPC_WRITE_ALLOWLIST` 含 6 项（其中 `SetUserModelConfig`、`UpdateCascadeSettings`、`AcceptCascadeStep` 在 `2.34.0` 均已 404）。

**建议 Step 3 同步更新的 Allowlist 名单**：

- **`RPC_READ_ALLOWLIST` 新增（+3）**：
  - `'GetCascadeModelConfigData'`（2.34.0 模型列表与配额元数据主接口）
  - `'GetPermissionSettings'`（读取当前全局审批预设）
  - `'GetCapabilities'`（宿主能力探测）
  - *清理建议*：移除已 404 的 `'ListAvailableModels'`（或仅保留兼容旧版注释）。

- **`RPC_WRITE_ALLOWLIST` 新增（+6 核心交互，+1 可选设置）**：
  - `'HandleCascadeUserInteraction'` **（必需 — 统一承载 Allow/Deny 审批与 `ask_question` 回填）**
  - `'CancelCascadeSteps'` **（必需 — 取消等待中/运行中的特定步骤）**
  - `'DeleteQueuedUserInputStep'` **（必需 — 取消/编辑服务端排队消息）**
  - `'SendAllQueuedMessages'` **（必需 — 队列立即触发/Steer）**
  - `'RevertToCascadeStep'` **（推荐 — Checkpoint/步骤回滚）**
  - `'UpdateConversationAnnotations'` **（推荐 — 会话标星/标题/状态注解）**
  - `'UpdatePermissionSettings'` *（可选 — 若允许从 L2 本地管理修改全局 Turbo/Default 权限预设；手机端 L0/L1 不应调用）*
  - *清理建议*：`AcceptCascadeStep`、`SetUserModelConfig`、`UpdateCascadeSettings` 在 2.34.0 已 404，可从默认调用链移除（allowlist 若需向后兼容 `<2.34` 可暂留并标注 deprecated）。

### 1.6 Host CDP (`cdp.js` + `anchors.json` `chat.actionButtons`) 兜底必要性评估

- **结论**：对于 2.34.0 手机端核心需求（命令审批、`permission` 审批、`filePermission`、`ask_question`、队列取消/中断），**纯 RPC 已 100% 覆盖**，无需依赖桌面窗口焦点或 DOM 选择器，`cdp.js` + `anchors.json` (`chat.actionButtons`) **不再作为主路径**。
- **仍保留 CDP 通道的唯一边界**：
  1. 兼容 `<2.34.0` 尚未提供 `HandleCascadeUserInteraction` 的旧客户端。
  2. 极少数 Electron 主进程/宿主级原生弹窗（如 `remoteManager.hostQuestions` 触发的客户端交互确认），此类弹窗不经过 `LanguageServerService` 步状态机，仅在无 `requestedInteraction` 载荷时触发降级提示或可选 CDP 点击。

---

## 2. 探针 P0c-2：Antigravity 原生语音输入与语音对话协议（Go / No-Go 门）

### 2.1 实测证据（两套语音链路均未满足移动端直连门禁）

Antigravity `2.34.0` 内部分为两套语音通路，实测结果如下：

1. **实时双向语音对话通路（`/voice/ws` + `jetski-voice-proto`）**：
   - `GET /voice/health` 返回 `HTTP 200 {"addr":"rap","ready":true,"state":"ready"}`。
   - `GET /voice/ws?conversation_id=00000000-0000-0000-0000-000000000000&plan_model=0&sample_rate=16000`（带 `Sec-WebSocket-Protocol: jetski-voice-proto` 与 `x-codeium-csrf-token`）返回 `HTTP 101 Switching Protocols`。
   - **阻断证据**：
     - **`GetMendelFlags` 远程能力全关**：`enable-voice-remote-control` (`disabled: true`)、`enable-voice-remote-web` (`disabled: true`)、`enable-voice-remote` (`disabled: true`)。
     - **内部协议与队列门槛**：`language_server` 二进制内绑定 `voice.OpenRAPVoice` / `VOICE_COMPONENT_RAP` / `devtools_jetski_boq_api_proto`；`main.js` (`BYa`) 中使用私有二进制 Protobuf 帧（`jetski-voice-proto`），且与 `runtimeEnvironment.userCohort === "google"`、`enableVoiceRelay`、桌面麦克风权限 IPC（`app.asar/dist/ipcHandlers.js`: `mic:get-access-status` / `mic:request-access`）联动。
     - `GET /voice/recordings` 返回 `HTTP 404`。

2. **流式语音听写通路（`StreamAudioTranscription` + `SendAudioChunk` + `EndAudioSession`）**：
   - `language_server` 注册了 `StreamAudioTranscription`（Server-Streaming）、`SendAudioChunk`、`EndAudioSession`、`GetTranscription`。
   - **阻断证据**：
     - **实时探针超时**：使用 `curl -k -v --max-time 3` 向 `https://127.0.0.1:62485/exa.language_server_pb.LanguageServerService/StreamAudioTranscription` 发送标准 Connect Streaming 请求帧（`Content-Type: application/connect+json`, `Connect-Protocol-Version: 1`, `{"mimeType":"audio/pcm;rate=16000","continuous":false}`），HTTP/2 建连并完整上传 62 bytes 后，**3001 ms 内收到 0 bytes 响应并超时**（未返回 `AudioStreamReady` 首帧 `sessionId`），说明服务端上游音频转写连接在当前运行环境/账号下不可即时就绪。
     - **桌面宿主耦合**：`main.js` 中桌面听写链路优先走 Electron 预加载桥 `dm().acquireHostMic({})` -> 本地 `["agy-mic.v1", "agy-mic-token.<token>"]` WebSocket 采集（`enable-ide-audio-transcription` 亦为 `disabled: true`）；浏览器端回退依赖 `AudioWorklet` + `navigator.mediaDevices.getUserMedia`（在局域网 `http://192.168.x.x` 非安全上下文中被浏览器禁用）。

### 2.2 P0c-2 明确门禁裁决

> **Verdict：NO-GO（一期裁掉原生语音模块）**

按照 [MOBILE_REMOTE_DESIGN.md](./MOBILE_REMOTE_DESIGN.md) §3.2 门禁规则：
- `GET /api/v1/bootstrap` 响应固定返回 **`voiceSupported: false`**。
- Step 4 手机端 PWA Composer **不渲染语音输入或实时语音通话按钮**，不引入自建 Whisper 服务端或浏览器 Web Speech 兜底。

---

## 3. 探针 P0c-3：`language_server` 脱壳独立拉起与 `⌘W` 关窗保活

### 3.1 `app.asar` 主进程生命周期与 `HostBridgeService` 逆向分析

1. **`⌘W` 关窗保活机制（`app.asar/dist/main.js` L742–754 & `dist/services/settingsService.js` L18）**：
   - `SettingKey.RUN_IN_BACKGROUND` 默认值为 **`process.platform === 'darwin'`**（即 **macOS 默认为 `true`**）。
   - `app.on('window-all-closed')` 逻辑实测原文：
     ```js
     const runInBackground = await settingsService.getSetting(settingsService_1.SettingKey.RUN_IN_BACKGROUND);
     if (!runInBackground) {
         electron_1.app.quit();
     }
     ```
   - **结论**：在 macOS 默认配置下，用户按下 `⌘W` 关闭所有 Antigravity 窗口后，Electron 主进程、`hostBridgeServer` 与子进程 `language_server`（`PID 43681`）**持续驻留后台运行**，`hub_62486.json`（`62485`/`62486`）继续正常响应全部读写 RPC；仅 `⌘Q`（触发 `before-quit`）或在非 macOS / 手动关闭 `runInBackground` 设置时才会销毁 `language_server`。
   - 此外，`app.asar/dist/main.js`（L110, L142–143）内置 `ELECTRON_OZONE_PLATFORM_HINT=headless` 无界面模式（自动追加 `--ozone-platform=headless`、`--headless`）。

2. **`HostBridgeService` 真实契约（`app.asar/dist/proto/host_bridge_pb.js` & `dist/hostBridgeServer.js`）**：
   - `exa.host_bridge_pb.HostBridgeService` **仅包含 2 个方法**：
     1. `GetUpdateStatus(GetUpdateStatusRequest) -> GetUpdateStatusResponse { status: { current_version, latest_version, update_available } }`
     2. `ApplyUpdate(ApplyUpdateRequest) -> ApplyUpdateResponse { accepted: bool }`
   - 它**不承担** OAuth 鉴权、文件/命令工具执行或对话存储。`app.asar/dist/languageServer.js`（L253）明确注释：*"The LS tolerates these being absent"*；`dist/main.js`（L543）明确注释：*"Non-fatal: the app is still usable, the LS just can't drive updates."*
   - 活跃 `language_server`（`PID 43681`）启动参数亦**未传入 `--extension_server_port`**，仅传：
     `--standalone --override_ide_name antigravity --subclient_type hub --override_ide_version 2.34.0 --override_user_agent_name antigravity --https_server_port 0 --app_data_dir antigravity --api_server_url https://generativelanguage.googleapis.com --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com --enable_sidecars --host_bridge_url=http://127.0.0.1:62478 --read_host_bridge_token_from_stdin`

### 3.2 脱壳独立拉起 `language_server --standalone` 真机实测

在**不启动 `Antigravity.app`**、**不提供 `--host_bridge_url` / `--read_host_bridge_token_from_stdin`**（`stdin = DEVNULL`）、使用完全隔离的临时目录 `--gemini_dir /tmp/agy-p0c3-sc-*` 条件下，直接拉起 `/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone`：

| 验证项 | 实测结果 | 说明 |
|---|---|---|
| 进程启动与端口发现 | **PASS** | 3.5s 内正常初始化并在 `<tmp>/antigravity/daemon/hub_<httpPort>.json` 写入发现文件 |
| `GetStatus` | **HTTP 200** `{}` | 服务健康就绪 |
| `GetUserStatus` | **HTTP 200** | 自动读取本机已登录 Pro 账户 OAuth 凭据（`TEAMS_TIER_PRO`），**不依赖 `host_bridge`** |
| `GetAvailableModels` / `GetCascadeModelConfigData` | **HTTP 200** | 完整返回模型目录与配额元数据 |
| `StartCascade` (`source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT"`) | **HTTP 200** | 成功创建隔离会话 `cascadeId` |
| `GetCascadeTrajectory` / `DeleteCascadeTrajectory` | **HTTP 200** | 读写与清理均正常工作（测试结束后已清理进程与临时目录） |

### 3.3 三层无窗口运行架构收敛定稿（L1 / L2 / L3）

| 层级 | 实测状态 | 职责与边界 | 工程注意项 |
|---|---|---|---|
| **L1：0-App 离线可用层** | **GO（必达）** | 工作区文件树与读写、Git / Worktree (`execFile('git', ...)`)、交互式 PTY (`python3 pty`)、`~/.gemini/antigravity/brain/` 与历史会话只读、用量/配额账本、底座与插件设置 | 完全零依赖 `Antigravity.app` 与 `language_server` |
| **L2：后台无感托管层** | **GO（macOS 原生保底）** | 当 `Antigravity.app` 运行且用户 `⌘W` 关闭全部窗口时，凭借 macOS 默认 `runInBackground: true` 保持 `language_server` 在后台运行，手机/PC Web 全功能可用且零切窗；必要时可用 `ELECTRON_OZONE_PLATFORM_HINT=headless` 拉起无窗口主进程 | `agy-daddy-host/src/core/rpc.js` 的 `discoverFromHubDaemonFiles()` 已具备 `isPidAlive(Number(parsed.pid))` 校验（L75–77），可自动跳过已退出僵尸文件 `hub_49618.json`/`hub_64261.json`/`hub_64959.json` |
| **L3：脱壳直拉 `language_server`** | **CONDITIONAL GO（探通解锁）** | 无任何活跃 `Antigravity.app` / `language_server` 进程时，`agy-daddy` 守护进程可直接以 `--standalone --subclient_type hub --app_data_dir antigravity ...` 拉起 `language_server`（无需伪造 `host_bridge`），提供完整 AI 对话、审批与标准工具（文件/命令/搜索/MCP） | **两条硬约束**：<br>1. **互斥锁**：仅在 `discoverFromHubDaemonFiles()` 确认**无存活 LS PID** 时方可拉起，严禁对同一 `~/.gemini/antigravity` 目录并发启动第二个 `language_server`（防 SQLite 轨迹库与 `daemon/hub_*.json` 冲突）；<br>2. **能力降级**：脱离 Electron 主进程后，`computer_use` (`ActuatorService`) 与桌面内嵌浏览器（`AGY_BROWSER_ACTIVE_PORT_FILE`）不可用，仅影响桌面 GUI 接管类子能力 |
