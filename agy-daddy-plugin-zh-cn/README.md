# @agy-daddy/plugin-zh-cn

Agy-Daddy 官方 Layer 1 本地化插件：可逆 10 语言客户端界面、零 Token 词典/正则翻译，以及思维链（CoT）多模转译与双语对照。

- **npm 包名**：`@agy-daddy/plugin-zh-cn`
- **Layer 层级**：Layer 1（核心增强层）
- **信任等级**：官方 `T0`（声明 `dom:read`、`dom:write`、`rpc:read`、`bridge:route`、`process:spawn`、`net:outbound:*` 权限）
- **开源协议**：MIT（完全独立净室实现，无 GPL 代码）
- **适用场景**：多语言用户交互界面本地化、侧边栏标题翻译、思维链（CoT）多模转译（含 Antigravity 内置模型、免配置机翻、自定义 OpenAI 兼容端点）、双语对照与源码行号定位跳转。

---

## 核心功能与安全默认值

- **10 语言可逆本地化**：支持简体中文 (`zh`)、繁體中文 (`zh-TW`)、日本語 (`ja`)、한국어 (`ko`)、Español (`es`)、Português (`pt`)、Français (`fr`)、Русский (`ru`)、Italiano (`it`) 与 English (`en`)，覆盖界面词典、CoT 面板 UI 与思考转译目标语言。
- **无痕还原与零内存泄漏**：基于 `WeakMap` 记录被重写节点的原文，语言切换或切换双语/纯译文模式即时生效，切回英文或卸载插件时无痕还原 DOM。
- **思维链（CoT）多模转译与双语对照**：
  - **免配置机器翻译 (`free`)**：开箱即用，自动保护 `file://` 路径占位符后按段落增量翻译并实时展示；
  - **Antigravity 内置模型转译 (`antigravity`)**：通过宿主只读 RPC (`GetUserStatus` / `GetAvailableModels` / `GetModelResponse`) 调用已登录的 Antigravity 模型，无需额外 API Key，支持自动优选轻量模型或下拉指定模型；
  - **自定义 AI 模型流式转译 (`custom_api`)**：支持配置任意 OpenAI 兼容端点（含本地免密 Ollama `http://127.0.0.1:11434/v1`、LM Studio 等），SSE 流式实时转译思考内容；
  - **全 10 语言目标与双语排版切换**：支持跟随当前界面语言或单独指定 `zh` / `zh-TW` / `ja` / `ko` / `es` / `pt` / `fr` / `ru` / `it` / `en` 全部 10 种目标语言，并支持「双语上下对照 (`bilingual`)」与「沉浸式纯译文 (`translated`)」一键切换；
  - **源码定位跳转**：自动识别思考译文中的 `file://` 路径与 `#L` 行号，点击直接触发宿主文件跳转定位。
- **安全默认值与外发数据透明披露**：
  - `thinkingTranslationMode: "off"`：默认关闭，不干扰原生思维链流式输出，也不向任何外部服务发送思考内容；
  - 开启 `free` 模式时，仅在思考块展开后将思考文本（`file://` 路径经占位符保护）发送至 `translate.googleapis.com` 获取译文；
  - 开启 `antigravity` 模式时，仅通过宿主只读 RPC `GetModelResponse` 调用本地 Antigravity 已登录模型服务；
  - 开启 `custom_api` 模式时，仅将展开后的思考文本发送至用户配置的 `thinkingApiBaseUrl`（可为本地 `127.0.0.1` 端点），`thinkingApiKey` 采用仅写保密存储（`writeOnly`），不向前端回显明文；
  - `enableRemoteThinkingTranslation: false` & `englishLabels: false`：保持既有隐私默认策略。

---

## 安装与启用方式

### 1. 随官方全量安装
```sh
agy-daddy plugin install --official
```

### 2. 单独安装
```sh
agy-daddy plugin install npm:@agy-daddy/plugin-zh-cn
```

### 3. 宿主设置中心与交互
安装后自动激活（`onStartup`）。可在 Agy-Daddy 设置中心「客户端多语言」面板中切换语言、调节「思考转译」模式、目标语言与排版方式，或通过命令面板执行 `zh-cn.toggle-lang` / `zh-cn.set-lang` / `zh-cn.toggle-thinking-display` / `zh-cn.test-thinking-api` / `zh-cn.list-antigravity-models` 快速操作，即切即生效无需重启。

---

## 配置项说明表

对照 `settings.schema.json`：

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `lang` | `enum` | `"zh"` | 界面语言：切换 Antigravity 宿主界面显示语言（支持简繁中文、日韩、西葡法俄意及英文原文），即切即生效无需重启 |
| `brandTitle` | `enum` | `"english"` | 左上角品牌标题：控制窗口左上角品牌标题的呈现（保留英文/本地化译名）或隐藏以节省顶栏空间 |
| `englishLabels` | `boolean` | `false` | 模型与权限选项保留英文：在任意界面语言下保留模型名称与权限档位原始英文术语 |
| `translateThinking` | `boolean` | `true` | 翻译思考过程：开启后自动翻译思考耗时标签与展开后的思考块内容；关闭后思考区保持原文 |
| `translateConversationTitles` | `boolean` | `true` | 翻译会话标题：开启后翻译侧边栏会话标题（保留用户手动重命名的自定义标题）；关闭后会话标题保持原文 |
| `enableRemoteThinkingTranslation` | `boolean` | `false` | 允许远程翻译思考片段：默认关闭；开启后仅在触发时将选中内容发送至 `translate.googleapis.com`（按当前语言目标翻译） |
| `thinkingTranslationMode` | `enum` | `"off"` | 思考转译模式：`off`（关闭）/ `free`（免配置机翻，发送至 `translate.googleapis.com`）/ `antigravity`（调用 Antigravity 内置 RPC 模型）/ `custom_api`（自定义 OpenAI 兼容端点流式转译） |
| `thinkingTargetLang` | `enum` | `"follow"` | 思考转译目标语言：`follow`（跟随当前界面语言）或单独指定 `zh`/`zh-TW`/`ja`/`ko`/`es`/`pt`/`fr`/`ru`/`it`/`en` 全部 10 种语言 |
| `thinkingDisplayMode` | `enum` | `"bilingual"` | 思考排版模式：`bilingual`（双语上下对照）/ `translated`（沉浸式纯译文） |
| `thinkingAntigravityModel` | `string` | `""` | Antigravity 转译模型：支持动态拉取宿主可用模型列表，留空自动优选 Flash Lite 等轻量快速模型 |
| `thinkingApiBaseUrl` | `string` | `"http://127.0.0.1:11434/v1"` | 自定义 API Base URL：支持本地 Ollama / LM Studio 免密端点或云端 OpenAI 兼容服务 |
| `thinkingApiKey` | `string` | `""` | API Key（可选，仅写保密）：本地免密端点可留空 |
| `thinkingApiModel` | `string` | `"qwen2.5:7b"` | 转译模型名称：发送至自定义 OpenAI 兼容端点的 `model` 字段 |

---

## 提供的服务 / 事件 / 命令 / 扩展位

严格依据 `agy-plugin.json` 声明：

- **Permissions**：`dom:read`、`dom:write`、`rpc:read`、`bridge:route`、`process:spawn`、`net:outbound:*`
- **Requires Anchors**：
  - `sidebar.conversationRows`：侧边栏会话行锚点（用于会话标题本地化翻译）
- **Services (provides)**：
  - `zh-cn`（版本 `1.0.0`，realm: `node`）
- **States (provides)**：
  - `state:zh-cn.lang@1`：当前生效的语言与思考转译状态广播
- **Commands (contributes)**：
  - `zh-cn.toggle-lang`：切换当前语言 / English 原文
  - `zh-cn.set-lang`：切换界面显示语言
  - `zh-cn.toggle-thinking-display`：切换思考转译双语对照 / 沉浸纯译文
  - `zh-cn.test-thinking-api`：测试思考转译服务连通性
  - `zh-cn.list-antigravity-models`：获取 Antigravity 可用转译模型列表

---

## 使用示例与本地测试

### 使用示例
1. 在设置中心「思考转译」中选择「Antigravity 内置模型转译」、「免配置机翻」或「自定义 AI 模型流式转译」，可跟随界面语言或指定全部 10 种目标语言中的任意一种；
2. 点击面板右上角切换按钮在沉浸式纯译文与双语上下对照间即时切换；
3. 点击译文中的 `file:///.../path.ts#L42` 代码位置链接，直接触发宿主编辑器定位到对应文件与行号。

### 本地测试
在插件目录下执行自动化单元测试：
```sh
npm test
```
