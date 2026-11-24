# @agy-daddy/plugin-zh-cn

Agy-Daddy 官方 Layer 1 本地化插件：可逆 10 语言客户端界面与零 Token 词典/正则翻译。

- **npm 包名**：`@agy-daddy/plugin-zh-cn`
- **Layer 层级**：Layer 1（核心增强层）
- **信任等级**：官方 `T0`（声明 `dom:read`、`dom:write`、`net:outbound:translate.googleapis.com` 权限）
- **适用场景**：多语言用户交互界面本地化、思考内容翻译及侧边栏标题翻译。

---

## 核心功能与安全默认值

- **10 语言可逆本地化**：支持简体中文 (`zh`)、繁體中文 (`zh-TW`)、日本語 (`ja`)、한국어 (`ko`)、Español (`es`)、Português (`pt`)、Français (`fr`)、Русский (`ru`)、Italiano (`it`) 与 English 原文 (`en`)。
- **无痕还原与零内存泄漏**：基于 `WeakMap` 记录被重写节点的原文，语言切换即时生效，切回英文或卸载插件时无痕还原 DOM。
- **零 Token 消耗翻译**：全量界面词典与正则规则匹配，无需调用外部大模型 API。
- **安全默认值**：
  - `enableRemoteThinkingTranslation: false`：远程思考翻译（`translate.googleapis.com`）默认关闭，保护用户数据隐私，仅在用户明确勾选后启用；
  - `englishLabels: false`：默认全量本地化，可自由开启保留英文核心术语。

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
安装后自动激活（`onStartup`）。可在 Agy-Daddy 设置中心「客户端多语言」面板中切换语言并精细调节显示偏好，或通过命令面板执行 `zh-cn.toggle-lang` / `zh-cn.set-lang` 快速切换界面显示语言，即切即生效，无需重启客户端。

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
| `enableRemoteThinkingTranslation` | `boolean` | `false` | 允许远程翻译思考片段：默认关闭；开启后仅在触发时将选中内容发送至 translate.googleapis.com（按当前语言目标翻译） |

---

## 提供的服务 / 事件 / 命令 / 扩展位

严格依据 `agy-plugin.json` 声明：

- **Permissions**：`dom:read`、`dom:write`、`net:outbound:translate.googleapis.com`
- **Requires Anchors**：
  - `sidebar.conversationRows`：侧边栏会话行锚点（用于会话标题本地化翻译）
- **Services (provides)**：
  - `zh-cn`（版本 `1.0.0`，realm: `node`）
- **States (provides)**：
  - `state:zh-cn.lang@1`：当前生效的语言状态广播
- **Commands (contributes)**：
  - `zh-cn.toggle-lang`：切换当前语言 / English 原文
  - `zh-cn.set-lang`：切换界面显示语言

---

## 使用示例与本地测试

### 使用示例
在 Agy-Daddy 设置中心选择「繁體中文」或「日本語」，整界面文案将在毫秒级完成无缝切换；若需临时对比英文原词，执行快捷命令 `zh-cn.toggle-lang` 即可在当前语言与 English 之间一键往返。

### 本地测试
在插件目录下执行自动化单元测试：
```sh
npm test
```
