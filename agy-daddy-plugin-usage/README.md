# @agy-daddy/plugin-usage

Agy-Daddy 官方 Layer 2 用量与账单插件：顶栏 Token 统计胶囊、历史热力图与 Google AI Ultra 订阅回本计算器。

- **npm 包名**：`@agy-daddy/plugin-usage`
- **Layer 层级**：Layer 2（用量与成本核算层）
- **信任等级**：官方 `T0`（声明 `dom:write`、`rpc:read`、`bridge:route`、`fs:brain-read`、`native:install` 权限）
- **适用场景**：多周期 Token 用量监控、跨会话热力图呈现、IDE 与 CLI 用量合并核算及订阅成本回本分析。

---

## 核心功能与安全默认值

- **全周期 Token 统计**：支持今日、本周、本月及全量（allTime）多周期统计，覆盖输入、输出、Cache Read/Write 及 API 费用估算。
- **IDE 与 CLI 用量融合**：可选合并计算 Antigravity IDE 客户端与本地 CLI 的 Token 消耗，提供真实全局账单视图。
- **Google AI Ultra 订阅回本分析**：内置 5x/20x 档位及多币种（USD、EUR、GBP、JPY、CNY、BRL、KRW 等）订阅原价模型，清晰计算回本进度。
- **安全默认值**：
  - `includeIdeUsage: true`、`includeCliUsage: true`：默认全口径统计用量，避免漏记；
  - `subscriptionPriceMode: "preset"`：默认使用官方基准预设价格。

---

## 安装与启用方式

### 1. 随官方全量安装
```sh
agy-daddy plugin install --official
```

### 2. 单独安装
```sh
agy-daddy plugin install npm:@agy-daddy/plugin-usage
```

### 3. 宿主设置中心与顶栏交互
安装后自动激活（`onStartup`）。插件在顶栏（order: 20）展示当前周期的 Token 消耗胶囊。点击胶囊即可弹出用量热力图与订阅成本面板；在设置中心「用量统计与计费」中可切换统计周期与币种。

---

## 配置项说明表

对照 `settings.schema.json`：

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `activePeriod` | `enum` | `"allTime"` | 统计周期（顶栏与面板同步）：可选 `today`（今日）、`thisWeek`（本周）、`thisMonth`（本月）、`allTime`（全部历史） |
| `includeIdeUsage` | `boolean` | `true` | 包含 Antigravity IDE 用量：是否计入宿主 IDE 的 Token 消耗 |
| `includeCliUsage` | `boolean` | `true` | 包含 Antigravity CLI 用量：是否计入 CLI 终端工具生成的 Token 消耗 |
| `ultraSubTier` | `enum` | `"auto"` | 订阅套餐档位：Google AI 订阅级别，可选 `auto`（自动识别）、`none`（无订阅）、`pro`（Pro 5x）、`ultra`（Ultra 20x） |
| `subscriptionRegion` | `enum` | `"US"` | 订阅区域：决定订阅预设价格基准（支持 US, EU, UK, JP, IN, BR, KR, TW 等） |
| `subscriptionCurrency` | `enum` | `"AUTO"` | 订阅付款币种：可选 AUTO 或 USD/EUR/GBP/JPY/CNY/BRL/KRW 等 |
| `subscriptionPriceMode` | `enum` | `"preset"` | 订阅成本模式：`preset`（使用官方预设定价）或 `custom`（使用自定义实付金额） |
| `actualPricePaid` | `number` | `0` | 自定义实付订阅金额：当成本模式设为 custom 时的实付金额 |
| `billingCycle` | `enum` | `"monthly"` | 订阅计费周期：`monthly`（按月）或 `yearly`（按年） |
| `currency` | `enum` | `"USD"` | 参考费用与回本展示币种：面板展示参考价格所用的币种 |

---

## 提供的服务 / 事件 / 命令 / 扩展位

严格依据 `agy-plugin.json` 声明：

- **Permissions**：`dom:write`、`rpc:read`、`bridge:route`、`fs:brain-read`、`native:install`
- **Requires Anchors**：
  - `topbar.rightCluster`：顶栏右侧集群锚点（用于挂载用量统计胶囊）
- **Services (provides)**：
  - `usage`（版本 `1.0.0`，realm: `node`）
  - `subscription`（版本 `1.0.0`，realm: `node`）
- **Consumes Services**：
  - `context`（版本 `^1.0.0`，optional: `true`）
- **States (provides)**：
  - `state:usage.summary@1`：当前用量汇总状态
- **Topbar Units & Popovers (contributes)**：
  - Topbar Unit: `tokens`（order: `20`）
  - Topbar Popover: `usage-panel`（anchorId: `tokens`）
- **Remote Panels (contributes["remote.panels"])**：
  - `usage`（绑定服务 `usage`，为移动端 PWA 远程面板提供 Token 用量汇总）
- **Native Extension (contributes.native)**：
  - MCP 服务器配置：`./native/mcp.json`（向宿主注入用量统计与订阅分析 MCP 工具）

---

## 使用示例与本地测试

### 使用示例
点击顶栏「Tokens」胶囊，浮窗立即展示本周各模型调用的 Token 分布及每日活跃热力图。若配置了 Ultra 20x 套餐，面板会动态计算当前 API 调用量若按标准资费结算所需的金额，并直观呈现回本倍率。

### 本地测试
在插件目录下执行自动化单元测试：
```sh
npm test
```
