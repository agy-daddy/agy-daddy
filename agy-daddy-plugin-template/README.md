# @agy-daddy/plugin-template

Agy-Daddy 官方微内核 v2 插件开发入门模板：标准化隔离世界、全托管设置、声明式命令与样式自注入。

- **npm 包名**：`@agy-daddy/plugin-template`
- **Layer 层级**：Starter Template（第三方插件标准模版）
- **信任等级**：社区 `T2` 规范（声明最小化 `dom:write` 权限）
- **适用场景**：开发者基于 Agy-Daddy 微内核 SDK 快速开发、验证并发布自己的第三方 CDP 插件。

---

## 核心功能与安全默认值

- **微内核契约 v2 规范**：完全运行于 `isolated` 隔离世界，不污染宿主全局 Window 对象，支持无痕销毁（零残留 `dispose`）。
- **全托管配置与声明式命令**：配置项由宿主根据 `settings.schema.json` 自动渲染，命令由宿主统一部署在命令面板，无需自制繁琐 UI。
- **设计风格自适应**：支持自动注入隔离样式，适配 Antigravity 原生暗色/亮色外观，禁止硬编码主题色。
- **安全默认值**：
  - 严格限制权限仅声明 `dom:write`；
  - 契约测试开箱即用，通过 `@agy-daddy/sdk` Mock Harness 验证生命周期。

---

## 安装与启用方式

### 1. 基于模板创建新插件
```sh
# 克隆或复制本目录作为开发起点
cp -r agy-daddy-plugin-template my-awesome-plugin
cd my-awesome-plugin
```

### 2. 插件安装与调试
```sh
# 链接本地开发目录进行调试
agy-daddy plugin link .
```

### 3. 宿主设置中心与顶栏交互
安装后自动激活（`onStartup`）。在顶栏（order: 90）挂载示例徽章（`hello-badge`），点击即可展开浮窗并执行问候操作；在设置中心进入「示例插件设置」可修改欢迎文本。

---

## 配置项说明表

对照 `settings.schema.json`：

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `greeting` | `string` | `"Hello Agy-Daddy"` | 欢迎语：点击示例胶囊或执行问候命令时展示的提示文本 |
| `showBadge` | `boolean` | `true` | 显示顶栏示例胶囊：在顶栏右侧集群挂载示例状态胶囊入口 |

### 声明式操作（Actions）
- **立即发送问候 (`greet-now`)**：触发命令 `hello.greet`。

---

## 提供的服务 / 事件 / 命令 / 扩展位

严格依据 `agy-plugin.json` 声明：

- **Services (provides)**：
  - `hello`（版本 `1.0.0`，realm: `node`）
- **States (provides)**：
  - `state:hello.greeting@1`：示例问候状态
- **Surfaces (provides)**：
  - `[]`（空数组）
- **Commands (contributes)**：
  - `hello.greet`：发送示例问候
- **Topbar Units & Popovers (contributes)**：
  - Topbar Unit: `hello-badge`（order: `90`）
  - Topbar Popover: `hello-popover`（anchorId: `hello-badge`）
- **Requires Anchors**：
  - `topbar.rightCluster`

---

## 使用示例与本地测试

### 使用示例
开发者可直接修改 `src/renderer.js` 与 `src/node.js` 实现业务逻辑，修改 `agy-plugin.json` 扩展服务或界面插槽。

### 本地测试
在模板目录下执行契约与生命周期测试：
```sh
npm test
```
