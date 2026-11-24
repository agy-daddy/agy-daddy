# 01 · Phase 0 & Phase 0b 真机 RPC 与进程契约实测基准

> 实测时间：2026-11-23 · 实测环境：macOS arm64 / Antigravity `2.34.0` / Node `v24.22.1`  
> 本文档区分**已实测事实**与**待补充探针项**，是 `agy-daddy-host` 与 `agy-daddy-plugin-web` 所有 Mock Fixture 和契约测试的唯一事实来源。

---

## 1. 进程树与后台托管实测结论（P0-1）

### 1.1 进程与 Hub 文件实测状态

- **活跃 Hub 描述文件**：`~/.gemini/antigravity/daemon/hub_62486.json`
  - `pid`: `43681`
  - `httpsPort`: `62485`、`httpPort`: `62486`
  - `lsVersion`: `"2.34.0"`
  - `csrfToken`: 已存在（非空，本文不记录原始值）
- **进程父子关系**：
  - 主进程：`Antigravity.app`（PID `43151`，参数含 `--remote-debugging-port=0`）
  - 后端语言服务：`language_server`（PID `43681`，PPID `43151`），关键启动参数：
    `--standalone --override_ide_name antigravity --subclient_type hub --override_ide_version 2.34.0 --enable_sidecars --host_bridge_url=http://127.0.0.1:62478 --read_host_bridge_token_from_stdin`
- **架构结论**：
  1. `language_server` 强依赖主进程提供的 `--host_bridge_url` 与 stdin token；完全退出 `Antigravity.app`（`⌘Q`）会连带终止 `language_server`。
  2. 隐藏主窗口（`⌘H`）或主进程后台驻留时，本地 `https://127.0.0.1:62485` 持续可连接（`⌘W` 关闭全部窗口后的端口保活行为待人工验证）。
- **定位到的 Host 既有缺陷（Task 1 必修）**：
  - `~/.gemini/antigravity/daemon/` 中残留 3 个已退出旧进程的过期文件（`hub_49618.json`、`hub_64261.json`、`hub_64959.json`，均为 `lsVersion: "2.32.1"`）。
  - `agy-daddy-host/src/core/rpc.js` 的 `discoverFromHubDaemonFiles()` 仅按 `mtimeMs` 排序，**未校验 `parsed.pid` 是否存活**。必须增加 `process.kill(Number(parsed.pid), 0)`（或可注入的 `isPidAlive`）过滤，仅选择进程仍存活的 hub 文件。

---

## 2. 只读 RPC 实测矩阵（P0-2）

请求端点：`https://127.0.0.1:62485/exa.language_server_pb.LanguageServerService/<Method>`  
请求头：`Content-Type: application/json`、`Connect-Protocol-Version: 1`、`x-codeium-csrf-token: <token>`

| 方法 | 结果 | 实测耗时 | 关键响应结构 / 实测结论 |
|---|---|---|---|
| `GetUserStatus` | **OK** | 8 ms | 返回 `userStatus`，含 `cascadeModelConfigData.clientModelConfigs`（27 个模型）、`cascadeModelConfigData.defaultOverrideModelConfig.modelOrAlias`、`planStatus`、`userTier` |
| `RetrieveUserQuotaSummary` | **OK** | 3 ms | 返回 `response` |
| `GetAvailableModels` | **OK** | 5 ms | 返回 `response.{models, defaultAgentModelId, agentModelSorts, groupedModels, commandModelIds, imageGenerationModelIds, ...}` |
| `ListAvailableModels` | **HTTP 404** | 3 ms | `404 page not found` —— **2.34.0 已无此端点**，应从 `RPC_READ_ALLOWLIST` 清理 |
| `GetAllCascadeTrajectories` | **OK** | 10 ms | 返回 `trajectorySummaries`（18 条）。状态枚举：`CASCADE_RUN_STATUS_RUNNING`、`CASCADE_RUN_STATUS_IDLE`。每条含 `summary`、`stepCount`、`lastModifiedTime`、`workspaces[]`（含 `workspaceFolderAbsoluteUri`、`gitRootAbsoluteUri`、`repository`、`branchName`） |
| `GetCascadeTrajectory` | **OK** | 15 ms | 60 步全量轨迹仅 15 ms。返回 `trajectory.{trajectoryId, cascadeId, trajectoryType, steps, generatorMetadata, executorMetadatas, source, metadata}`、`status`、`numTotalSteps` |
| `GetCascadeTrajectoryGeneratorMetadata` | **OK** | 5 ms | 返回 `generatorMetadata` |
| `GetCascadeTrajectorySteps` | **OK** | — | 实测传入 `{ cascadeId, stepOffset }` **支持真实偏移增量拉取**（97 步轨迹传 `stepOffset: 94` 精确返回尾部 3 步）。注：传 `{ startIndex, endIndex }` 无效（仍返回全量）；且该方法目前**未在** `constants.js` 的 `RPC_READ_ALLOWLIST` 中声明（Task 1 补入） |

---

## 3. Trajectory Step 实测契约（扫描最近 6 个真实会话）

### 3.1 Step 状态枚举（6 种）

- `CORTEX_STEP_STATUS_DONE`
- `CORTEX_STEP_STATUS_GENERATING`
- `CORTEX_STEP_STATUS_RUNNING`
- `CORTEX_STEP_STATUS_PENDING`
- `CORTEX_STEP_STATUS_ERROR`
- `CORTEX_STEP_STATUS_CANCELED`

### 3.2 Step 类型与载荷结构（11 种）

| Step `type` | 载荷字段名 | 实测内部键 |
|---|---|---|
| `CORTEX_STEP_TYPE_USER_INPUT` | `userInput` | `items`, `userResponse`, `activeUserState`, `userConfig`, `userAgentSpec`, `clientMessageId` |
| `CORTEX_STEP_TYPE_PLANNER_RESPONSE` | `plannerResponse` | `thinking`, `messageId`, `toolCalls`, `thinkingDuration`, `stopReason`, `response`, `modifiedResponse` |
| `CORTEX_STEP_TYPE_RUN_COMMAND` | `runCommand` | `commandLine`, `proposedCommandLine`, `cwd`, `waitMsBeforeAsync`, `blocking`, `exitCode`, `combinedOutput`, `shellName` |
| `CORTEX_STEP_TYPE_VIEW_FILE` | `viewFile` | `absolutePathUri`, `startLine`, `endLine`, `content`, `lineRangeBytes`, `numLines`, `numBytes` |
| `CORTEX_STEP_TYPE_CODE_ACTION` | `codeAction` | `actionSpec`, `actionResult`, `diffStats` |
| `CORTEX_STEP_TYPE_ASK_QUESTION` | `askQuestion` | `questions`（外层步对象带 `completedInteractions`） |
| `CORTEX_STEP_TYPE_SEARCH_WEB` | `searchWeb` | `query`, `webDocuments`, `summary`, `thirdPartyConfig`, `searchType` |
| `CORTEX_STEP_TYPE_CHECKPOINT` | `checkpoint` | `includedStepIndexEnd`, `sessionSummary`, `artifactSnapshots`, `capturedUserRequests`, `totalSubagentCount`, `accumulatedSections` |
| `CORTEX_STEP_TYPE_SYSTEM_MESSAGE` | `systemMessage` | `message`, `renderInfo`, `eventType` |
| `CORTEX_STEP_TYPE_GENERIC` | `generic` | `args`, `result` |
| `CORTEX_STEP_TYPE_ERROR_MESSAGE` | `errorMessage` | `error` |

---

## 4. Phase 0b 写 RPC 隔离会话实测结果

在独立新建测试会话 `cascadeId = "b5f0cef4-229c-4f84-b278-ce1d2ccb245d"` 上实测了全部 6 个 `RPC_WRITE_ALLOWLIST` 接口，得出以下关键契约与协议修正：

| 方法 | 实测结果 | 耗时 | 实测入参 & 响应 / 关键发现 |
|---|---|---|---|
| `StartCascade` | **OK** | 26 ms | **必填 `source` 字段！** 未传 `source` 或空体 `{}` 均返回 `HTTP 400: CortexTrajectorySource is unspecified`。<br>实测成功入参：`{ source: "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT", metadata: { ideName: "antigravity", extensionName: "antigravity" } }` → 返回 `{ cascadeId }` |
| `SendUserCascadeMessage` | **OK** | 11 ms | 实测成功入参：`{ cascadeId, items: [{ text }], metadata: { ideName: "antigravity", extensionName: "antigravity" }, cascadeConfig: { plannerConfig: { requestedModel: { model: "MODEL_PLACEHOLDER_M318" } } } }` → 返回 `{}`。支持每次发送直接指定/切换模型 |
| `GetCascadeTrajectorySteps`（配合写后轮询） | **OK** | 4.33 s 完成整轮 | 每 300 ms 传 `{ cascadeId, stepOffset }`：312 ms 捕获 `step[0]` `USER_INPUT (DONE)`，`stepOffset` 推进为 `1`；4334 ms 捕获 `step[1]` `PLANNER_RESPONSE (DONE)`，校验响应包含 `PROBE_OK`，`stepOffset` 推进为 `2`，`status` 回到 `CASCADE_RUN_STATUS_IDLE` |
| `CancelCascadeInvocation` | **OK** | 2 ms | 传 `{ cascadeId }` 返回 `{}`（对 IDLE 会话调用亦幂等成功；传入不存在 UUID 返回 `HTTP 500: cascade not found`） |
| `AcceptCascadeStep` | **HTTP 404** | 2 ms | `404 page not found` —— **2.34.0 `LanguageServerService` 无此端点** |
| `SetUserModelConfig` | **HTTP 404** | 3 ms | `404 page not found` —— **2.34.0 无此端点**；模型切换改为在前端保持会话级 `selectedModel`，随 `SendUserCascadeMessage.cascadeConfig.plannerConfig.requestedModel` 下发 |
| `UpdateCascadeSettings` | **HTTP 404** | 2 ms | `404 page not found` —— **2.34.0 无此端点** |

### 对架构设计的直接修正

1. **模型切换无需 `SetUserModelConfig`**：`SendUserCascadeMessage` 原生接受 `cascadeConfig.plannerConfig.requestedModel`，因此 Web 端直接维护会话选定模型并在发送时携带即可。
2. **远程/Web 审批交互（`AcceptCascadeStep` 404 的处理）**：`2.34.0` 中 `AcceptCascadeStep` 路由已不存在。Phase 1 优先做好**高危动作/等待审批状态 (`CORTEX_STEP_STATUS_PENDING`) 实时展示与提醒**；`POST /api/v1/sessions/:id/steps/:stepId/approve` 需先通过后续专门探针确认 `2.34.0` 真实的交互提交 RPC 名称（或以 CDP 兜底触发原生按钮）后再启用真实后端放行，严禁猜测未验证 RPC 名写入生产代码。

---

## 5. 离线 TDD Mock Fixture 模板

供 `agy-daddy-plugin-web/test/` 在 `AGY_DADDY_TEST_MODE=1` 下离线使用（100% 复现上述实测结构）：

```js
const MOCK_HUB_FILES = {
  deadOld: { pid: 999991, httpsPort: 49617, httpPort: 49618, lsVersion: '2.32.1', csrfToken: 'old-dead-token' },
  aliveNew: { pid: process.pid, httpsPort: 62485, httpPort: 62486, lsVersion: '2.34.0', csrfToken: 'test-csrf-token' }
};

const MOCK_TRAJECTORY_SUMMARIES = {
  'b5f0cef4-229c-4f84-b278-ce1d2ccb245d': {
    summary: 'Probe Session',
    stepCount: 2,
    lastModifiedTime: '2026-11-23T15:50:56.000Z',
    trajectoryId: 'traj-1',
    status: 'CASCADE_RUN_STATUS_IDLE',
    createdTime: '2026-11-23T15:50:51.000Z',
    workspaces: [{
      workspaceFolderAbsoluteUri: 'file:///tmp/mock-workspace',
      gitRootAbsoluteUri: 'file:///tmp/mock-workspace',
      repository: { computedName: 'mock-workspace' },
      branchName: 'main'
    }],
    trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE'
  }
};
```
