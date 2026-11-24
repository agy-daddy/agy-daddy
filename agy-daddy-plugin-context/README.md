# @agy-daddy/plugin-context

Agy-Daddy 官方 Layer 2 上下文监测插件：上下文环、审计面板、附件检查器与输入框实时脉冲胶囊。

- **npm 包名**：`@agy-daddy/plugin-context`
- **Layer 层级**：Layer 2（会话洞察与监控层）
- **信任等级**：官方 `T0`（声明 `dom:read`、`dom:write`、`rpc:read`、`fs:brain-read`、`bridge:route`、`native:install` 权限）
- **适用场景**：实时监测对话 Token 上下文大小、预警 240K/328K 提示缓存断崖，以及输入框生成速度与附件审计。

---

## 核心功能与安全默认值

- **实时上下文环与速率脉冲**：实时计算当前会话的总 Token 占用与生成速率（~tok/s），支持在输入框下方或顶栏展示动态环形指示器。
- **缓存断崖梯级预警**：支持 240K 预警与 328K 断崖阈值，自动标记超限风险，预防上下文溢出。
- **附件审计面板**：就近弹出详情面板，清晰呈现历史轮次、Prompt Cache 命中率及附件大小。
- **安全默认值**：
  - `compactPolicy: "remind"`：默认仅提醒，绝不在用户输入中或模型生成时强行中断会话；
  - `autoCompactOnCacheDrop: false`：默认关闭丢缓存强制压缩，必须由用户自主配置。

---

## 安装与启用方式

### 1. 随官方全量安装
```sh
agy-daddy plugin install --official
```

### 2. 单独安装
```sh
agy-daddy plugin install npm:@agy-daddy/plugin-context
```

### 3. 宿主设置中心与顶栏/输入框交互
安装后自动激活（`onStartup`）。默认在输入框下方挂载上下文脉冲胶囊，或在顶栏（order: 10）挂载环形图元。点击就近弹出审计面板，亦可在设置中心「上下文与实时速度」进行策略定制。

---

## 配置项说明表

对照 `settings.schema.json`：

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `displayLocation` | `enum` | `"composer"` | 胶囊显示位置：二选一：`composer`（仅在输入框下方）或 `topbar`（仅在顶栏显示实时胶囊），点击就近弹出详情面板 |
| `showSpeed` | `boolean` | `true` | 显示生成速度：在胶囊中实时显示流式估算速率 (~tok/s) 及完成后的精确速率 |
| `pollIntervalMs` | `number` | `3000` | 轮询采样间隔：定期读取当前会话记录并重算 Token 构成的时间间隔（毫秒） |
| `warnThreshold` | `string` | `"240K"` | 预警阈值：支持绝对值（如 240K / 240000）或窗口百分比（如 50%）；达到后胶囊变橙提醒 |
| `cliffThreshold` | `string` | `"328K"` | 断崖阈值：支持绝对值（如 328K / 328000）或窗口百分比（如 70%）；达到后标记高风险断崖 |
| `compactPolicy` | `enum` | `"remind"` | 压缩触发策略：可选 `remind`（仅提醒）、`suggest`（空闲显示一键压缩）、`auto`（达断崖等本步结束自动发 /compact）、`both`（A+B 同时开启） |
| `autoCompactOnCacheDrop` | `boolean` | `false` | 丢缓存强行触发压缩：开启后若检测到缓存断崖且处于空闲状态，强制触发压缩提示 |

### 声明式操作（Actions）
- **立即重新扫描会话 (`rescan`)**：触发命令 `context.rescan`。

---

## 提供的服务 / 事件 / 命令 / 扩展位

严格依据 `agy-plugin.json` 声明：

- **Permissions**：`dom:read`、`dom:write`、`rpc:read`、`fs:brain-read`、`bridge:route`、`native:install`
- **Requires Anchors**：
  - `topbar.rightCluster`：顶栏右侧集群锚点（用于挂载顶栏上下文环）
  - `composer.root`：输入框根容器锚点（用于挂载输入框脉冲胶囊）
- **Services (provides)**：
  - `context`（版本 `1.0.0`，realm: `node`）
  - `context-ui`（版本 `1.0.0`，realm: `page-isolated`）
- **Consumes Services**：
  - `usage`（版本 `^1.0.0`，optional: `true`）
- **Events (provides)**：
  - `telemetry:generator-calls@1`：生成器调用遥测事件
  - `context:auto-compact-triggered@1`：自动压缩触发事件
- **States (provides)**：
  - `state:context.snapshot@1`：上下文快照状态
- **Commands (contributes)**：
  - `context.rescan`：重新扫描会话
- **Topbar Units & Popovers (contributes)**：
  - Topbar Unit: `ring`（order: `10`）
  - Topbar Popover: `context-panel`（anchorId: `ring`）
- **Remote Panels (contributes["remote.panels"])**：
  - `context`（绑定服务 `context`，为移动端 PWA 远程面板提供上下文快照）
- **Native Extension (contributes.native)**：
  - MCP 服务器配置：`./native/mcp.json`（向宿主注入上下文治理 MCP 工具）
  - Skills 技能目录：`./native/skills`（注入 context-governance 技能包）

---

## 使用示例与本地测试

### 使用示例
在长会话编码过程中，输入框下方的实时胶囊会动态变色（绿色正常、橙色预警、红色危险）并展示生成速度。当上下文接近 240K 时点击胶囊，审计面板会列出附件占比及各轮次 Token 消耗，方便针对性精简。

### 本地测试
在插件目录下执行自动化单元测试：
```sh
npm test
```
