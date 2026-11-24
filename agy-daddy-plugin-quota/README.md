# @agy-daddy/plugin-quota

Agy-Daddy 官方 Layer 3 额度监测插件：Gemini / Claude-3P / Argon / Carbon 配额共享池监控与 5 小时/周重置倒计时。

- **npm 包名**：`@agy-daddy/plugin-quota`
- **Layer 层级**：Layer 3（配额与模型状态监控层）
- **信任等级**：官方 `T0`（声明 `dom:write`、`rpc:read`、`bridge:route`、`native:install` 权限）
- **适用场景**：多模型配额实时剩余比例监测、用尽告警与倒计时提醒。

---

## 核心功能与安全默认值

- **共享池配额精准监测**：严格遵循 Protobuf `codeium_quota_info` 与 `quota_summary_bucket` 缺省语义，绝不将未知或空字段误判为配额耗尽。
- **顶栏倒计时与变色规则**：顶栏展示剩余比例，支持 5 小时滑动窗口与每周重置倒计时双模式，并支持自定义阶梯颜色预警规则。
- **弱依赖与独立运行**：软消费可选 `subscription.getUltraSubTier()` 补充套餐级别，在独立安装未安装 usage 插件时亦可无报错健壮运行。
- **安全默认值**：
  - `pollIntervalMs: 60000`：默认 60 秒轮询，避免频繁请求造成系统负担；
  - 默认告警阶梯：剩余 <= 15% 红色警告，剩余 <= 35% 橙色警告。

---

## 安装与启用方式

### 1. 随官方全量安装
```sh
agy-daddy plugin install --official
```

### 2. 单独安装
```sh
agy-daddy plugin install npm:@agy-daddy/plugin-quota
```

### 3. 宿主设置中心与顶栏交互
安装后自动激活（`onStartup`）。插件在顶栏（order: 30）展示配额胶囊及倒计时。点击胶囊即可呼出配额快照浮窗，查看各类模型的具体配额池占比。

---

## 配置项说明表

对照 `settings.schema.json`：

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `pollIntervalMs` | `number` | `60000` | 配额自动刷新间隔：后台定期轮询最新配额状态的时间周期（毫秒，10000-600000） |
| `topbarCountdownMode` | `enum` | `"both"` | 顶栏附带最近重置倒计时：可选 `both`（同时显示 5h 与周重置）、`fiveHours`（仅 5 小时）、`weekly`（仅每周重置）、`none`（隐藏倒计时） |
| `quotaDisplayMode` | `enum` | `"remaining"` | 额度显示方式：`remaining`（显示剩余百分比）或 `used`（显示已消耗百分比） |
| `capsuleColorRules` | `list` | `["any:remaining<=15:#ef4444","any:remaining<=35:#f59e0b"]` | 胶囊颜色规则：配置当配额比例触碰指定阈值时的色彩表现规则（如任意模型剩余不足 15% 标红） |

---

## 提供的服务 / 事件 / 命令 / 扩展位

严格依据 `agy-plugin.json` 声明：

- **Permissions**：`dom:write`、`rpc:read`、`bridge:route`、`native:install`
- **Requires Anchors**：
  - `topbar.rightCluster`：顶栏右侧集群锚点（用于挂载配额监测胶囊）
- **Services (provides)**：
  - `quota`（版本 `1.0.0`，realm: `node`）
- **Consumes Services**：
  - `subscription`（版本 `^1.0.0`，optional: `true`）
- **States (provides)**：
  - `state:quota.snapshot@1`：配额快照状态广播
- **Topbar Units & Popovers (contributes)**：
  - Topbar Unit: `quota`（order: `30`）
  - Topbar Popover: `quota-panel`（anchorId: `quota`）
- **Remote Panels (contributes["remote.panels"])**：
  - `quota`（绑定服务 `quota`，为移动端 PWA 远程面板提供多模型配额比例快照）
- **Native Extension (contributes.native)**：
  - MCP 服务器配置：`./native/mcp.json`（向宿主注入模型额度监控与余量查询 MCP 工具）

---

## 使用示例与本地测试

### 使用示例
在日常编写代码时，顶栏配额胶囊实时展示当前主力模型的剩余额度及距离下个 5 小时周期的倒计时。点击胶囊浮窗可一览 Gemini 2.5 Flash、Claude 3.5 Sonnet 与 GPT-4o 等不同模型池的详细分配比例。

### 本地测试
在插件目录下执行自动化单元测试：
```sh
npm test
```
