# Agy-Daddy 手机端远程访问（Step 2–4）工程设计与实施方案

> 状态：**`/grill-me` 决策已锁定 · Step 1（PC Web 入口链接）已落地并验证 · Step 2–4 工程规划定稿**  
> 基准日期：2026-11-24（基于 Antigravity `2.34.0` 实测基线与 [WEB_HARNESS_DESIGN.md](./WEB_HARNESS_DESIGN.md) 双插件分治架构）

---

## 1. 背景、目标与已锁定核心决策总表

`agy-daddy-plugin-remote` 现已通过 Step 1 在桌面端顶栏浮窗接入了 `agy-daddy.web`（`web-harness`）PC Web 入口卡片；而现有的 `18765` 手机 PWA 页面（`src/pwa-html.js`）仍处于 3 秒轮询监控快照阶段，对话流与输入区尚未接通全量控制能力。

本方案对标 **Lody**、**T3 Code** 与 **Happier（原 Happy Coder）** 三款主流移动端 AI 编码控制面产品，结合 `agy-daddy` 零运行期依赖（`dependencies: {}`）与安全通道隔离要求，定义 **Step 2（Phase 0c 联合真机探针）→ Step 3（后端升级）→ Step 4（极致性能 Preact PWA 前端与验收）** 的完整落地蓝图。

| 决策维度 | 锁定结论 |
|---|---|
| **前端技术栈与体积预算** | `agy-daddy-plugin-remote/web/src/` 采用 **Vite + Preact + TypeScript + CSS Modules** 编译为静态 `dist/web/`；运行期严格保持 `dependencies: {}` 零第三方依赖；**核心首屏 `<55KB` gzip**，二次打开 **`<200ms`** 可交互 |
| **Antigravity 底层驱动** | **RPC 优先 + CDP 无感兜底**：Phase 0c 探明 `2.34.0` 真实审批/`ask_question`/模式切换 RPC，纯 RPC 能通的走 RPC（`<20ms` 不依赖窗口），确无 RPC 的通过 Host 既有 CDP 通道无感兜底 |
| **信息架构与单手导航** | **对话主屏 + 左右侧滑抽屉**（类 ChatGPT App 手感）：启动直达最近对话，无常驻底栏遮挡，最大化 375px 竖屏阅读与虚拟键盘空间 |
| **一期全功能边界** | P0 Antigravity 全操作 + `agy-daddy` 独有监控 + 7 项竞品核心能力（Attention 置顶队列与锁屏推送、Queue/Steer 与离线草稿、行级 Diff + 行内评论回注 + Artifacts、文件树与轻编辑、Git/Worktree、PTY 交互终端、原生语音探针衔接） |
| **明确不做（裁剪项）** | 多人实时协作、外部第三方推送 Webhook（Bark/飞书/Telegram/ntfy）、Monaco 重型编辑器；若 Phase 0c 探明原生语音不可衔接，则暂不做浏览器替代语音输入 |
| **安全权限模型** | **三级权限（向后兼容 `allowRemoteWrite`）**：`L0 只读监控（默认）` / `L1 对话与审批` / `L2 文件写 · Git 写 · PTY 终端`（L2 仅宿主机可开启，公网 Cloudflare 通道对高危动作强制二次确认） |
| **锁屏后台提醒** | **纯 PWA Web Push（VAPID，Node 原生 `node:crypto` 零依赖实现）+ 前台音震**，添加到主屏幕配合 HTTPS 通道即可锁屏触达 |
| **终端与代码编辑规格** | 终端按需懒加载 `@xterm/xterm` + `@xterm/addon-fit`（SW 缓存后秒开，完整支持 `sudo` 等交互与手机虚拟按键栏），后端走系统 `python3 pty` + 零依赖 RFC 6455 WebSocket；代码编辑走轻量高亮编辑器 |
| **无 Antigravity 窗口运行** | **三层架构**：L1 离线可用层（文件/Git/PTY/历史只读/插件设置无需 App）→ L2 后台无感托管层（守护进程保活隐藏 App，日常零切窗）→ L3 Phase 0c 探针验证脱壳直拉 `language_server` |

---

## 2. 竞品能力全景对标与范围边界

### 2.1 P0 Antigravity 原生 + `agy-daddy` 独有基线能力

1. **会话全生命周期**：按工作区 / Git 分支 / 状态筛选会话列表，支持新建会话、切换会话、中断生成（`CancelCascadeInvocation`）。
2. **11 类步骤流式渲染**：覆盖 `WEB_HARNESS_DESIGN.md` 实测的 11 种 `CORTEX_STEP_TYPE_*`（用户消息、Thinking 折叠 + Markdown 正文、命令执行与输出、文件阅读、代码变更 Diff 摘要、结构化提问 `ask_question`、网页检索来源、Checkpoint 快照、系统消息、通用工具、错误告警）。
3. **完整 Composer**：多行自适应输入、图片上传（端侧 Canvas 自动压缩转 JPEG/WebP）、`/` 斜杠命令、途中切换模型（随 `SendUserCascadeMessage.cascadeConfig.plannerConfig.requestedModel` 下发）、Plan/Chat 模式切换、复用 `agy-daddy.composer` 快捷提示词与 LLM 提示词优化。
4. **远程交互审批**：`PENDING` 状态命令/修改卡片底部悬浮 `Allow / Deny`，`ask_question` 选项单手点击直接回填。
5. **独有监控集成**：顶栏双环 Context 胶囊与 240K/328K 缓存断崖预警、本对话累计 Token 与生成速度（TPS/TTFT）、跨会话用量成本账本、Gemini/Claude 配额余量、5 通道测速与 `/entry` 一键切换。

### 2.2 Lody / T3 Code / Happier 竞品特性一期映射表

| 竞品特性 | 参考来源 | 手机端一期落地设计 | 归属层级 |
|---|---|---|---|
| **Needs Attention 待审批置顶队列** | Happier / Lody / T3 | 左抽屉顶部聚合所有 `PENDING` 审批、`ask_question` 提问、错误中断会话，带红色角标与一键直达 | L0 查看 / L1 操作 |
| **PWA 锁屏推送与前台音震** | T3 / Happier / Lody | 零依赖 VAPID Web Push 推送待审批/完成/报错事件，点击通知深链直达对应会话；前台可选提示音与短震 | L0 订阅 / L1 快捷动作 |
| **Queue(排队) vs Steer(插话) + 离线草稿** | T3 Code | 运行中发送按钮支持长按或切换胶囊：`Steer` 立即注入引导，`Queue` 入本地持久化队列待当前轮 `IDLE` 自动按序发送；断网草稿与图片缓存 IndexedDB | L1 |
| **行级 Diff + 行内评论回注 + Artifacts** | Happier / Lody | 右抽屉「Diff」分段展示改动文件与移动端单栏行级 Diff（+/- 高亮）；点击任意行弹出批注框，确认后格式化带文件路径与行号引用回填到 Composer；「产物」分段预览 `brain/<id>` 文档/截图 | L0 查看 / L1 回注 |
| **工作区文件树 + 轻量编辑** | Happier / Lody | 右抽屉「文件」分段：目录懒加载树、文件名快搜、路径白名单沙箱读取；L2 开启后支持轻量行号高亮编辑与保存 | L0 读 / L2 写 |
| **Git 工作台 & Worktree 管理** | Lody / T3 / Happier | 右抽屉「Git」分段：当前分支与 Worktree 列表（切换/新建隔离 Worktree）、变更暂存（Stage/Unstage）、Commit、Push | L0 读 / L2 写 |
| **远程交互式终端 PTY** | Happier / T3 | 右抽屉「终端」分段：L2 开启后按需懒加载 `@xterm/xterm`，支持 `sudo` 等 TTY 密码/交互输入、多 Tab 会话与手机虚拟功能键栏 | L2 |
| **原生语音输入 / 语音对话** | T3 / Happier | 仅当 Step 2 Phase 0c 探通 Antigravity 原生语音接口时启用直连；探不通则本期不展示语音按钮 | 视探针结果而定 |

### 2.3 明确裁剪与延后项

- **不做多人协作共享会话**：本插件定位个人远程安全伴侣，遵循单主控令牌 + 多标签隔离，不引入共享房间与权限分发。
- **不做外部第三方推送 Webhook**：不内置 Bark、飞书、Telegram、ntfy 等外部服务适配，锁屏触达统一依赖自包含 PWA Web Push。
- **不引入 Monaco 编辑器**：避免 MB 级包体拖垮移动端加载与内存。
- **不做非原生浏览器语音兜底**：若 Antigravity 原生语音接口不可接通，不自建 Whisper 服务端或退回碎片化 Web Speech。

---

## 3. Step 2：Phase 0c 联合真机探针规格与退出门槛

在编写 Step 3/4 生产代码前，必须先在隔离测试环境执行一次性真机探针（实测结果同步更新至契约文档），消除剩余 3 个底层未知数：

### 3.1 探针 P0c-1：2.34.0 真实交互 RPC 定位（审批 / `ask_question` / 模式切换）

- **已知事实**：`AcceptCascadeStep`、`SetUserModelConfig`、`UpdateCascadeSettings` 在 Antigravity `2.34.0` `LanguageServerService` 均返回 `HTTP 404`。
- **探针方法**：
  1. 提取本机 `language_server` 二进制或前端 bundle 中 `LanguageServerService` 注册的 Connect RPC 方法表（重点检索 `HandleCascadeUserInteraction`、`SubmitUserInteraction`、`RespondToQuestion`、`SetCascadeConfig`、`PlanMode` 等符号）。
  2. 在隔离测试会话触发一次待审批 `RUN_COMMAND` 与一次 `ASK_QUESTION`，抓取原生客户端发往 `127.0.0.1:<httpsPort>` 的实际路径与 JSON 载荷。
  3. 同步验证 `ag-daddy` Host `constants.js` 的 `RPC_WRITE_ALLOWLIST` 增量名单。
- **兜底与退出门槛**：
  - 能通过纯 RPC 调通的交互，全部走 `harness-adapter` 纯 RPC（`<20ms`，不依赖桌面窗口焦点）。
  - 确实无公开 RPC 的交互项，锁定 Host `cdp.js` 精确选择器操作（复用 `anchors.json` 中 `chat.actionButtons` 等锚点），明确标注依赖窗口存活。

### 3.2 探针 P0c-2：Antigravity 原生语音输入与语音对话协议（Go / No-Go 门）

- **探针方法**：
  1. 检查 `Antigravity.app` 语音录入与语音对话模式触发时，是否向 `language_server` 发送音频 RPC / WebSocket 流，还是由 Electron 渲染层直连云端/系统语音通道。
  2. 验证录音二进制（PCM / WebM / Opus）能否经 Node 网关中继透传并返回转写文本或双向语音流。
- **Go / No-Go 门禁**：
  - **Go**：若能稳定通过本地 `language_server` 或 `host_bridge` 复现语音输入/对话，则列入 Step 3 接口与 Step 4 Composer 语音按钮。
  - **No-Go**：若协议强耦合桌面私有音频设备/封闭云端签名，**直接裁掉一期语音模块**，不在手机端留占位按钮。

### 3.3 探针 P0c-3：`language_server` 脱壳独立拉起与 `⌘W` 关窗保活

- **已知事实**：`language_server` 启动参数包含 `--host_bridge_url=http://127.0.0.1:<port>` 与 `--read_host_bridge_token_from_stdin`，完全 `⌘Q` 退出 `Antigravity.app` 会终止 `language_server`。
- **探针方法**：
  1. 人工实测 `⌘W` 关闭全部原生窗口但保留 `Antigravity.app` 驻留时，`hub_<port>.json` 与 `62485` 端口是否持续响应读写 RPC。
  2. 尝试由独立 Node 脚本提供最小 `host_bridge` HTTP 服务并通过 stdin 传入 token，单独拉起 `language_server --standalone`，验证无 `Antigravity.app` 进程时 `GetUserStatus`、`StartCascade`、`SendUserCascadeMessage` 是否正常工作（重点观察认证凭据与工具执行是否依赖 IDE 扩展宿主）。
- **三层运行架构收敛**：
  - **L1 无 App 离线可用层（必达）**：守护进程直接提供工作区文件读写、Git/Worktree、PTY 终端、`brain/` 历史会话只读、用量账本与底座设置，**0 依赖 `Antigravity.app`**。
  - **L2 后台无感托管层（保底）**：若脱壳无法完整支持内置工具链，由 `agy-daddy` 守护进程在需要 AI 会话时自动以隐藏/无窗口态保活 `Antigravity.app`，实现“日常永不切回桌面窗口”。
  - **L3 完全无 App 模式（探通即解锁）**：若探针证实独立 `host_bridge` 可完整承载工具与会话，将其封装为 `agy-daddy daemon` 可选托管模式。

---

## 4. Step 3：`agy-daddy-plugin-remote` 后端能力升级架构

### 4.1 三级权限模型与通道安全门禁

保留既有 `allowRemoteWrite` 布尔字段作向后兼容映射（`false → L0`，`true → L1`），在 `settings.schema.json` 新增 `permissionLevel`（默认 `L0`）及 L2 高危开关，严格在服务端 `pwa-server.js` 按请求鉴权裁剪：

| 权限级别 | 英文标识 | 允许能力范围 | 开启与二次确认约束 |
|---|---|---|---|
| **L0（默认）** | `readonly` | 会话列表与实时流查看、Diff/文件树/Git状态/Artifacts 只读、5 通道测速、Context/Usage/Quota 监控、Web Push 订阅与提醒 | 默认开启，零破坏性风险 |
| **L1** | `chat` | 包含 L0 + 新建/切换/停止会话、发送文本与图片、模型切换、Queue/Steer 排队、审批 Allow/Deny、`ask_question` 回填、行内评论回注、快捷词/提示词优化、L1 级 Git 只读刷状态 | 可在桌面浮窗或设置中心切换；与 `allowRemoteWrite: true` 互为映射 |
| **L2** | `workspace` | 包含 L1 + 工作区文件保存写、Git `stage/commit/push`/Worktree 增删切、交互式 PTY 终端 WebSocket | **仅允许在宿主机本地设置中心手动开启**（禁止手机端远程提权）；当请求经 `cloudflare` 公网通道触发 L2 写操作或新建 PTY 时，服务端校验短时效 `X-Agy-Confirm` 二次确认令牌 |

> **隔离红线**：`agy-daddy-plugin-web` 的 `pairingUrl` / `pairingToken` **严禁**出现在任何手机端 HTTP/SSE/WS 响应中；手机端路径访问严格限制在已授权工作区白名单及 `~/.gemini/antigravity/brain/` 内，经 `fs.realpathSync` 阻断 symlink 逃逸。

### 4.2 服务复用拓扑

`agy-daddy-plugin-remote` 通过 `consumes` 软依赖复用底座与兄弟插件能力，不重复造轮子：
- `web-harness`（来自 `agy-daddy.web`，optional）：直接复用 `listSessions`、`getSessionDetail`、`getSessionDelta`、`sendMessage`、`cancelSession`、审批与工作区/Git/Diff 底层服务（若 `plugin-web` 未启用，则由共享/内联轻量 adapter 兜底核心会话读写）。
- `composer-node`（来自 `agy-daddy.composer`，optional）：复用 `listQuickPrompts`、`listFrequentPrompts`、`optimizePrompt`。
- `context` / `usage` / `quota`（optional）：延续 `getMobileSnapshot` 聚合，增加随 SSE 推送而不靠 3s 盲轮询。

### 4.3 完整 API 契约表（HTTP + SSE + WebSocket）

所有 `/api/v1/*` 接口沿用 Bearer Token / `X-AGY-Token` 鉴权（WebSocket 支持首帧 Auth 握手或短时票据，避免长 token 反复暴露在日志中），并复用现有 `classifyRequestChannel` 通道门禁：

| 能力域 | 协议与端点 | 最低权限 | 说明 |
|---|---|---|---|
| **能力发现与鉴权** | `GET /api/v1/bootstrap` | L0 | 返回当前通道、权限级别（`L0`/`L1`/`L2`）、模型目录、工作区列表、VAPID 公钥、语音探针可用标志 |
| **会话列表与详情** | `GET /api/v1/sessions`<br>`GET /api/v1/sessions/:id` | L0 | 返回归一化会话摘要（含 `needsAttention` 标记：待审批/提问/出错）及全量 `SessionEvent[]` |
| **实时事件流** | `GET /api/v1/stream?sessionId=...` | L0 | SSE 增量流（复用 `stepOffset` + 环形缓冲 + `Last-Event-ID` 断线补帧）；推送 `session.delta`、`attention.update`、`telemetry.patch`；切后台断开、回前台秒级 `Last-Event-ID` 重连 |
| **对话与排队控制** | `POST /api/v1/sessions`<br>`POST /api/v1/sessions/:id/messages`<br>`POST /api/v1/sessions/:id/cancel` | L1 | 支持 `{ text, modelId, mode, images, dispatchMode: 'steer' \| 'queue' }`；`queue` 模式在后端会话状态回到 `IDLE` 时由服务端或客户端协调按序触发 |
| **审批与提问回填** | `POST /api/v1/sessions/:id/steps/:seq/approve`<br>`POST /api/v1/sessions/:id/steps/:seq/answer` | L1 | 优先走 Phase 0c 探明的 2.34.0 RPC，不可用时无缝回退 Host CDP 动作执行 |
| **Prompt 快捷词与优化** | `GET /api/v1/composer/presets`<br>`POST /api/v1/composer/optimize` | L0 / L1 | 转发 `composer-node` 快捷词/高频词与模型提示词优化 |
| **Diff / 文件 / Artifacts** | `GET /api/v1/git/diff?root=...`<br>`GET /api/v1/fs/tree?root=...`<br>`GET /api/v1/fs/read?path=...`<br>`GET /api/v1/artifacts?sessionId=...` | L0 | 大文件/超大 Diff 自动分段截断保护移动端内存；复用 `workspace-service` 安全根校验 |
| **文件写与 Git/Worktree** | `PUT /api/v1/fs/write`<br>`GET /api/v1/git/worktrees`<br>`POST /api/v1/git/{stage,commit,push,worktree}` | L2 | 全参数 `execFile('git', ...)` 禁止 shell 拼接；公网 Cloudflare 通道要求 `X-Agy-Confirm` |
| **Web Push 订阅** | `GET /api/v1/push/vapid-key`<br>`POST /api/v1/push/subscribe`<br>`DELETE /api/v1/push/subscribe` | L0 | 持久化手机端 PushSubscription（存插件数据目录 `push-subs.json`），状态转 `PENDING`/`ERROR`/`DONE` 时异步派发 |
| **PTY 交互终端** | `GET /api/v1/pty/sessions`<br>`WS /ws/pty?cols=...&rows=...&cwd=...` | L2 | 零依赖 RFC 6455 WebSocket + `python3 -c "import pty..."` 桥接真实 TTY（支持 `sudo`、`Ctrl+C`、`SIGWINCH` resize）；保留 64KB 环形重放缓冲 |

### 4.4 零依赖关键模块实现蓝图

1. **VAPID Web Push 引擎（`src/web-push.js`）**：
   - 使用 Node 内置 `node:crypto` 生成并持久化 P-256（`prime256v1`）VAPID 密钥对。
   - 使用 `crypto.createSign('SHA256')` 签发 ES256 VAPID JWT（`aud`、`exp`、`sub`）。
   - 使用 ECDH（`prime256v1`）+ HKDF-SHA256 + `aes-128-gcm` 实现 RFC 8291（`aes128gcm` 内容编码）载荷加密，经 Node `https`/`fetch` 直推 Apple/FCM Push Endpoint，**零外部 npm 依赖**。
2. **原生 PTY + RFC 6455 WebSocket 桥接（`src/pty-bridge.js`）**：
   - 监听 `http.Server` 的 `upgrade` 事件，校验路径 `/ws/pty`、Token、L2 权限及通道确认后完成 `101 Switching Protocols` RFC 6455 握手与帧编解码（支持文本/二进制帧、Ping/Pong 保活）。
   - 子进程采用 `python3` 标准库 `pty.openpty()` + `fcntl.ioctl(TIOCSWINSZ)` + `os.execvpe(shell)` 派生真实交互式伪终端，支持 `sudo` 密码隐藏输入、方向键与全屏 TUI 程序。
   - 内置每会话 **64KB 环形输出缓冲**：手机端切出终端 Tab 或短时断网重连后，自动重放最近上下文屏幕状态；无客户端连接超过可配超时（默认 10 分钟）自动回收空闲 PTY 或支持手动关闭。

---

## 5. Step 4：`agy-daddy-plugin-remote/web` 极致性能手机端实现与验收

### 5.1 工程目录与仓库门禁适配

```text
agy-daddy-plugin-remote/
├── agy-plugin.json               # 声明 consumes: web-harness/composer-node/context/usage/quota
├── package.json                  # dependencies: {} (运行期零依赖), devDependencies: vite, preact, @preact/preset-vite, typescript, @xterm/xterm, @xterm/addon-fit
├── src/                          # 纯 Node.js 运行时（含 pwa-server, sse-broker, web-push, pty-bridge, tunnel-*）
├── web/                          # 构建期源码（仅 build 阶段运行，产物输出到 dist/web/）
│   ├── vite.config.ts            # build.outDir = '../dist/web', manualChunks 分包隔离 xterm
│   ├── sw.js                     # Service Worker：App Shell 预缓存 + Push 监听与通知点击深链
│   └── src/
│       ├── main.tsx              # Preact 入口（<55KB gzip 核心首屏）
│       ├── store/                # 状态、SSE 增量引擎、IndexedDB 离线草稿与快照缓存
│       ├── layout/               # 对话主屏 + 左右侧滑手势抽屉 + 44px 顶栏
│       ├── chat/                 # 虚拟滚动对话流、11 类 Step 卡片、PENDING 悬浮审批、Composer
│       ├── drawers/              # 左抽屉（Attention + 会话 + 设置）与右抽屉壳
│       └── lazy/                 # 动态 import() 懒加载重模块：Diff 审阅+行评论 / 文件树+轻编辑 / Git+Worktree / Artifacts / xterm 终端
└── dist/web/                     # 预构建静态产物（含 manifest.webmanifest 与 hash 化 chunk），随插件直接分发
```

**门禁兼容说明（对齐 `scripts/monorepo.js`）**：
- `agy-daddy-plugin-remote/package.json` 的 `dependencies` 保持 `{}`，构建工具与 `@xterm/xterm` 全部放在 `devDependencies`（或 `web/package.json`），编译为静态 `dist/web/` 后运行期零外部依赖。
- 所有 CSS 严禁出现 `FORBIDDEN_THEME_REGEXES` 中的硬编码绿色/天蓝/橙色色值，全部复用 `--ag-*` 单色极简变量（自动/浅色/深色三态）。
- `scripts/monorepo.js` 中 `runBuild()` 补充 `agy-daddy-plugin-remote/web` 构建（若存在 `web/package.json`），紫色主题静态门禁扫描 `web/src/` 并跳过 `dist/web/`。

### 5.2 375px 单手信息架构与手势交互

1. **顶部紧凑状态栏（44px 固定高度）**：
   - 左侧：`[☰]` 汉堡按钮（存在 `Needs Attention` 待审批/报错会话时显示醒目数量红点）。
   - 中部：当前会话标题（可点切换工作区/会话）+ 模型短名胶囊 + 双环 Context 迷你胶囊（点击向下展开完整 Context 进度条 / Usage / Quota / 通道测速 / 权限级别面板，不占主屏常驻空间）。
   - 右侧：`[⌘]` 右抽屉入口按钮（带当前工作区改动文件数角标）。
2. **对话主屏（100% 视口聚焦）**：
   - 启动/点击通知直接进入对应会话对话流；左右边缘轻滑或点击顶栏图标以 `220ms` 阻尼动画滑出左/右抽屉（带背景遮罩与防误触死区，避免与代码块横向滚动冲突）。
   - 底部 **PENDING 悬浮审批卡**：当当前会话或活跃会话出现 `PENDING` 命令/代码操作/`ask_question` 时，在 Composer 上方浮出单手大按钮卡（`允许 Allow` / `拒绝 Deny` / 选项胶囊），拇指无需上滑翻找历史消息即可一键放行。
   - **拇指友好 Composer**：贴合 `env(safe-area-inset-bottom)` 与 `visualViewport` 键盘避让；上方一排轻量功能胶囊（`/` 快捷词、模型切换、Plan/Chat 模式、`Queue | Steer` 模式）；主行支持拍照/选图自动压缩上传、提示词优化（魔法棒）、发送/停止（运行中智能变为停止按钮，长按或切模式支持插话/排队）。
3. **左抽屉（导航与全局状态）**：
   - 置顶 **🔔 Needs Attention** 分区：所有等待审批、`ask_question` 或运行异常的会话置顶高亮。
   - **会话管理**：新建会话（含选择工作区/分支）、按状态/工作区过滤、会话列表（含运行绿点/审批点/时间）。
   - **系统与通知**：通道切换（跳 `/entry` 测速选优）、开启/测试 PWA 锁屏推送、外观（自动/浅色/深色）、当前权限状态（L0/L1/L2 只读提示与安全说明）。
4. **右抽屉（代码与终端工作区，分段懒加载）**：
   - 顶部 5 段切换胶囊：`Diff` | `文件` | `Git` | `产物` | `终端`（首次切入对应分段时触发动态 `import()`）。
   - **Diff 分段**：变更文件列表 → 单栏优化的行级 Diff；**点击任意代码行弹出「行内评论」浮动条**，输入批注点「回注对话」自动生成带 `path:line` 与代码片段的格式化引用并填入 Composer（直接切回对话即可发送给 Agent 修正）。
   - **文件分段**：目录树懒展开、按文件名过滤、语法高亮只读预览；L2 下支持切换「编辑」模式改代码并保存（公网通道保存前二次确认）。
   - **Git 分段**：当前分支与 Worktree 卡片（支持新建/切换隔离 Worktree）、变更勾选暂存（Stage/Unstage）、Commit 信息输入提交、Push；L0/L1 下仅提供分支与变更只读查看。
   - **产物分段**：读取 `~/.gemini/antigravity/brain/<cascadeId>` 下的计划、报告、截图产物并渲染 Markdown/图片。
   - **终端分段（仅 L2 可用）**：懒加载 `@xterm/xterm` + `@xterm/addon-fit` 接入 `/ws/pty`；键盘上方自带移动专用快捷条（`Esc`、`Tab`、`Ctrl+C`、`Ctrl+D`、`↑`、`↓`、`/`、`-`），解决手机软键盘无控制键痛点，完整支持 `sudo` 等交互式命令。

### 5.3 极致性能预算与弱网工程策略

| 性能优化点 | 验收目标 | 具体实现机制 |
|---|---|---|
| **首屏体积硬约束** | 核心 JS + CSS **`<55KB` gzip** | Preact（~4KB）+ 轻量手写增量 Markdown 渲染器；`@xterm/xterm`、Diff 解析器、代码高亮表、Git/文件组件全走 Vite `import()` 独立异步 chunk |
| **App Shell 秒开** | 二次打开 **`<200ms`** 可交互 | Service Worker `CacheFirst` 缓存带内容哈希的静态 JS/CSS；IndexedDB 缓存最近 10 个会话摘要与当前会话首屏 30 步快照，打开页面先渲染缓存再在后台拉 `SSE` 补齐增量 |
| **长对话 60fps** | 500+ 步轨迹滚动不掉帧 | 仅渲染视口附近及前后缓冲步的虚拟窗口；历史已完成（`DONE`/`ERROR`/`CANCELED`）Step 设为不可变 `memo` 节点且仅解析一次 Markdown；流式生成仅更新尾部 1 个活动 Step |
| **流式传输与省电** | 零无效轮询，流量省 90% | 以单条 `/api/v1/stream` SSE 替代原 `setInterval(3000)`；服务端按 `stepOffset` 仅下发变化帧；`document.visibilitychange` 切后台 15s 后主动挂起 SSE，回前台按 `Last-Event-ID` 瞬间续传 |
| **图片与弱网韧性** | 照片上传 `<400KB`，草稿零丢失 | 手机拍照（常 4–10MB HEIC/JPEG）上传前在端侧 `<canvas>` 缩放至长边 `<=1600px` 并转 `image/jpeg`（质量 `0.82`）；草稿与 `Queue` 待发队列写入 IndexedDB，断网提示清晰、重连自动按序补发 |
| **xterm 按需与休眠** | 不进终端零内存占用 | 未点击「终端」Tab 时 `xterm` JS/CSS 为 0 下载、0 WebSocket；离开终端 Tab 超过休眠阈值仅断开前后台渲染节流，保留后端 64KB 环形缓冲，重进无缝回显 |

### 5.4 Step 2–4 分阶段 TDD 测试与真机验收清单

#### 阶段测试矩阵（遵循 `AGY_DADDY_TEST_MODE=1` 离线可测 + 真机验收）

1. **Step 2 验收（Phase 0c 探针）**：
   - 产出探针实测报告（补充至 `01-PHASE0-RPC-CONTRACT.md` 或新建 `05-PHASE0C-MOBILE-PROBES.md`），锁定审批/`ask_question`/模式切换的纯 RPC 与 CDP 映射表、原生语音 Go/No-Go 结论、`language_server` 脱壳与 `⌘W` 保活实测结论。
2. **Step 3 验收（后端单测 `remote-v2.test.js`）**：
   - **权限隔离门禁**：`L0` 拦截所有对话/审批/文件写/Git写/PTY（403）；`L1` 放行对话与审批但拦截文件写/Git写/PTY；`L2` 仅允许本地设置开启，且 Cloudflare 通道下无 `X-Agy-Confirm` 拦截高危动作；任何远端接口响应体不包含 PC Web `pairingUrl`/`pairingToken`。
   - **SSE 与离线队列**：模拟 `stepOffset` 增量推流、`Last-Event-ID` 断线重放、Queue 队列在 `RUNNING -> IDLE` 时顺序消费。
   - **文件与 Git 沙箱**：symlink 越界拦截、`execFile('git')` Worktree 列举/Diff 解析无注入风险。
   - **VAPID Web Push & PTY WS**：VAPID JWT 签名与 RFC 8291 载荷加密单元校验；RFC 6455 WebSocket 握手、`python3 pty` 交互回显（含模拟 `resize` 与 64KB 环形重放）。
3. **Step 4 验收（前端单测 + 构建门禁 + 真机 E2E）**：
   - **构建与静态门禁**：`npm run verify`（含 `plugin-remote/web` 构建、零运行期依赖、主题无禁色、SHA-512 一致性）全绿；检查 `dist/web/` 首屏入口 JS+CSS gzip 总和 **`< 55KB`**。
   - **真机 E2E 实测（iOS Safari + Android Chrome + Cloudflare Tunnel 公网弱网）**：
     1. 扫码打开 `/entry` 通道选择页测速切优进入手机端，首屏秒开进入最近会话。
     2. 手机端新建会话、压缩上传截图、切换模型发送消息，观察 SSE 流式渲染与停止按钮、Queue/Steer 排队插话。
     3. 锁屏状态下等待桌面触发待审批命令，验证 PWA Web Push 锁屏弹窗推送 → 点击直达会话 → 底部悬浮卡片一键 `Allow`。
     4. 右滑打开右抽屉：查看行级 Diff 并点击某行添加评论回注输入框；浏览工作区文件与 `brain/` 产物；开启 L2 后在「终端」Tab 运行 `sudo -n true` / 交互式 Shell 命令并测试虚拟按键与断线重连屏幕重放。
