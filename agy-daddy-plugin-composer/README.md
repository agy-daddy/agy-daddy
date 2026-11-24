# @agy-daddy/plugin-composer

Agy-Daddy 官方 Layer 3 输入框增强与安全自动化插件：快捷指令栏、幽灵感知提示、提示词一键优化与 Auto-Accept 高危拦截守卫。

- **npm 包名**：`@agy-daddy/plugin-composer`
- **Layer 层级**：Layer 3（输入辅助与自动化守卫层）
- **信任等级**：官方 `T0`（声明 `dom:read`、`dom:write` 权限）
- **适用场景**：常用 Prompt 一键输入、下一步动作智能推荐、提示词专业优化及执行安全把关。

---

## 核心功能与安全默认值

- **快捷指令胶囊栏**：在输入框上方挂载快捷输入项（如 `/compact`、`/plan`、`/goal`、`/reload` 等），并开放 `composer.quickActions` 插槽供第三方插件扩展。
- **提示词一键优化与撤回**：根据 Google Cloud 提示工程规范改写用户草稿，消除口语模糊，保留关键路径与标识符，并支持一键撤销恢复草稿。
- **Auto-Accept 与高危拦截守卫**：支持自动确认常规安全步骤，但内置 9 大类破坏性命令拦截规则（如 `rm -rf /`、`DROP DATABASE`、未授权修改全局凭据等），遇险立即报警拦截。
- **安全默认值**：
  - `autoAccept: false`：自动批准步骤默认严格关闭；
  - `autoSummarizeFrequentPrompts: false`：历史高频词汇总默认关闭；
  - 自动化及写操作均须由用户明确确认或勾选开启。

---

## 安装与启用方式

### 1. 随官方全量安装
```sh
agy-daddy plugin install --official
```

### 2. 单独安装
```sh
agy-daddy plugin install npm:@agy-daddy/plugin-composer
```

### 3. 宿主设置中心与输入框交互
安装后自动激活（`onStartup`）。插件自动在 Antigravity 主输入框下方注入快捷动作胶囊与优化按钮（快捷键 `Alt+Shift+O`），并在设置中心「输入框增强与安全自动化」提供完整配置。

---

## 配置项说明表

对照 `settings.schema.json`：

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `showQuickBar` | `boolean` | `true` | 快捷指令栏：在输入框下方常驻显示快捷输入胶囊栏 |
| `ghostSuggest` | `boolean` | `true` | 感知提示：根据当前会话状态，在输入框中提供下一步操作的淡灰色幽灵建议（按 Tab 键自动采纳） |
| `contextAwareQuickItems` | `boolean` | `true` | 上下文感知动态快捷条目：在错误时优先展示修复/排查建议，在超长会话时优先展示压缩提示 |
| `autoSummarizeFrequentPrompts` | `boolean` | `false` | 自动总结历史高频手动发送词：定期分析历史会话并推荐将常用提示加入快捷栏 |
| `quickItems` | `list` | `["compact","plan","goal","reload"]` | 快捷输入条目与显示顺序：配置快捷栏展示的指令标识符与先后顺序 |
| `showPromptOptimizer` | `boolean` | `true` | 显示提示词优化入口：在输入框操作区显示 ✨ 提示词优化按钮 |
| `optimizerShortcut` | `string` | `"Alt+Shift+O"` | 提示词优化快捷键：一键触发草稿优化的快捷键绑定 |
| `optimizerPrompt` | `string` | *(内置长文本)* | 提示词优化指令模板：基于 Google Cloud 提示工程准则的改写系统指令模板 |
| `autoAccept` | `boolean` | `false` | 自动批准安全步骤 (Auto-Accept)：默认关闭；启用后自动确认常规操作，但命中高危命令时仍会拦截提醒 |

---

## 提供的服务 / 事件 / 命令 / 扩展位

严格依据 `agy-plugin.json` 声明：

- **Services (provides)**：
  - `composer`（版本 `1.0.0`，realm: `page-isolated`）
  - `composer-node`（版本 `1.0.0`，realm: `node`）
- **Consumes Services**：
  - `context`（版本 `^1.0.0`，optional: `true`）
- **Surfaces (provides)**：
  - `composer.quickActions`：输入框快捷操作位扩展插槽
- **Events (provides)**：
  - `composer:high-risk-detected@1`：高危命令拦截预警事件
- **Commands (contributes)**：
  - `composer.compact`：发送 /compact 压缩指令
  - `composer.listFrequentPrompts`：读取历史高频快捷指令列表
  - `composer.summarizeFrequentPrompts`：手动总结高频手动发送词

---

## 使用示例与本地测试

### 使用示例
在输入框输入口语化需求如“帮我看看这个报错怎么改”，按下 `Alt+Shift+O`，提示词立即被规范化为包含错误排查、边界约束与测试要求的工程级指令；再次点击可撤销恢复原文。

### 本地测试
在插件目录下执行自动化单元测试：
```sh
npm test
```
