# @agy-daddy/plugin-web

Agy-Daddy 官方 Layer 4 本地控制台插件：PC 桌面 Web 工作台与宿主管理服务。

- **npm 包名**：`@agy-daddy/plugin-web`
- **Layer 层级**：Layer 4（工作台与 Web 呈现层）
- **信任等级**：官方 `T0`（声明 `rpc:read`、`rpc:write`、`net:listen`、`fs:user-files`、`fs:brain-read`、`host:control` 权限）
- **适用场景**：通过现代 PC 桌面浏览器直接访问 Antigravity 工作区、管理会话树、查阅产物与配置插件。

---

## 核心功能与安全默认值

- **PC 桌面 Web 工作台**：本地绑定监听端口（默认 `127.0.0.1:18767`），通过浏览器提供完整的双栏/三栏项目管理与会话工作台体验。
- **会话与工作区元数据管理**：安全读写工作区目录、展示 Git 差异、检索 brain 产物，并集成 SSE 实时状态流同步。
- **系统主题与外观定制**：支持跟随系统明暗主题（Dark/Light/System）与多种专业主题配色（极简黑白、紫罗兰、钴蓝、翠绿、琥珀、绯红），以及自定义抽屉过渡速率。
- **安全默认值**：
  - 仅绑定本地回环网络 `127.0.0.1`，不暴露公网；
  - 严格限制工作区目录边界，拦截目录穿越与敏感系统根目录读写；
  - 需经过宿主鉴权方可执行 `host:control` 等高权限操作。

---

## 安装与启用方式

### 1. 随官方全量安装
```sh
agy-daddy plugin install --official
```

### 2. 单独安装
```sh
agy-daddy plugin install npm:@agy-daddy/plugin-web
```

### 3. 宿主设置中心与浏览器交互
安装后自动激活（`onStartup`）。默认启动时自动打开系统浏览器访问 `http://127.0.0.1:18767`。用户可在设置中心「PC Web 工作台设置」中修改监听端口、主题风格或白名单目录。

---

## 配置项说明表

对照 `settings.schema.json`：

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `port` | `number` | `18767` | 本地监听端口 (127.0.0.1)：Web 工作台绑定端口（范围 1024-65535） |
| `theme` | `enum` | `"system"` | 明暗主题模式：可选 `system`（跟随系统）、`dark`（暗色模式）、`light`（亮色模式） |
| `colorTheme` | `enum` | `"monochrome"` | 颜色主题风格：可选 `monochrome`（黑白简约，原生默认）、`purple`（紫罗兰）、`blue`（钴蓝）、`green`（翠绿）、`amber`（琥珀）、`red`（绯红） |
| `drawerSpeed` | `enum` | `"normal"` | 抽屉展开/收起动画速度：可选 `fast` (120ms)、`normal` (200ms)、`smooth` (320ms)、`off` (0ms 无动画) |
| `allowedRoots` | `list` | `[]` | 允许访问的工作区根目录白名单：允许浏览器工作台访问的本地项目目录列表 |
| `autoOpenBrowser` | `boolean` | `true` | 启动时自动打开浏览器：启动宿主时是否自动打开默认浏览器访问 Web 工作台 |

---

## 提供的服务 / 事件 / 命令 / 扩展位

严格依据 `agy-plugin.json` 声明：

- **Permissions**：`rpc:read`、`rpc:write`、`net:listen`、`fs:user-files`、`fs:brain-read`、`host:control`
- **Services (provides)**：
  - `web-harness`（版本 `1.0.0`，realm: `node`）
- **Consumes Services**：
  - `context`（版本 `^1.0.0`，optional: `true`）
  - `usage`（版本 `^1.0.0`，optional: `true`）
  - `quota`（版本 `^1.0.0`，optional: `true`）
- **States (provides)**：
  - `state:web.status@1`：PC Web 工作台服务状态
- **Commands (contributes)**：
  - `agy-daddy.web.status`：查看 PC Web 工作台状态

---

## 使用示例与本地测试

### 使用示例
启动 Antigravity 宿主后，浏览器自动打开 `http://127.0.0.1:18767`，进入 PC Web 工作台。在工作台中可以随时查阅项目文件目录、查看当前会话的流式响应，并在大屏环境下舒适地审查代码差异。

### 本地测试
在插件目录下执行自动化单元测试：
```sh
npm test
```
