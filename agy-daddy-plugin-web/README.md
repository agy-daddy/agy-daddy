# @agy-daddy/plugin-web

Agy-Daddy 官方 Layer 4 本地控制台插件：PC 桌面 Web 工作台与宿主管理服务。

- **npm 包名**：`@agy-daddy/plugin-web`
- **Layer 层级**：Layer 4（工作台与 Web 呈现层）
- **信任等级**：官方 `T0`（声明 `rpc:read`、`rpc:write`、`net:listen`、`fs:user-files`、`fs:brain-read`、`host:control` 权限）
- **适用场景**：通过现代 PC 桌面浏览器直接访问 Antigravity 工作区、管理会话树、查阅产物与配置插件，并支持按需开启局域网、Tailscale、Bonjour 或 Cloudflare Tunnel 多通道远程访问。

---

## 核心功能与安全默认值

- **PC 桌面 Web 工作台**：所有访问通道共用监听端口（默认 `18767`，`bindHost: "auto"` 默认绑定 `127.0.0.1`），通过浏览器提供完整的双栏/三栏项目管理与会话工作台体验。
- **多通道接入与分级权限**：内置本机回环（`loopback`）、局域网（`lan`）、Tailscale（`tailscale`）、Bonjour（`bonjour`）与 Cloudflare Tunnel（`cloudflare`）五类访问通道，并支持针对非回环通道的 `L0` / `L1` / `L2` 细粒度权限分级。
- **会话与工作区元数据管理**：安全读写工作区目录、展示 Git 差异、检索 brain 产物，并集成 SSE 实时状态流同步。
- **系统主题与外观定制**：支持跟随系统明暗主题（Dark/Light/System）与多种专业主题配色（极简黑白、紫罗兰、钴蓝、翠绿、琥珀、绯红），以及自定义抽屉过渡速率。
- **安全默认值**：
  - 默认 `bindHost: "auto"` 绑定本地回环 `127.0.0.1`，非回环通道（`lan` / `tailscale` / `bonjour` / `cloudflare`）默认全部关闭；未启用任何非回环通道时拒绝非回环网卡绑定；
  - 开启非回环通道时默认 `remotePermissionLevel: "L0"`（只读 + 流式），所有非回环访问均要求配对 Token（定常时间比对），且 Cloudflare Tunnel 通道下的写操作始终需要二次确认；本机回环通道（`loopback`）始终保留完整读写能力；
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
安装后自动激活（`onStartup`）。默认启动时自动打开系统浏览器访问 `http://127.0.0.1:18767`。用户可在设置中心「PC Web 工作台设置」中调整监听端口、多通道接入与非回环权限级别、主题风格或白名单目录。

---

## 配置项说明表

对照 `settings.schema.json`（全部 14 项）：

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `port` | `number` | `18767` | 监听端口：所有访问通道共用的 TCP 端口（范围 1024-65535） |
| `bindHost` | `enum` | `"auto"` | 监听地址：可选 `auto`（自动跟随已启用通道，默认绑定 `127.0.0.1`，仅在启用需非回环监听的通道时扩展到 `0.0.0.0`）、`loopback`（强制 `127.0.0.1`）、`lan`（强制 `0.0.0.0` 所有网卡；未启用任何非回环通道时拒绝非回环绑定） |
| `loopback` | `boolean` | `true` | 本机回环通道 (127.0.0.1)：默认通道，保留本机原有全读写工作台能力 |
| `lan` | `boolean` | `false` | 局域网通道 (Wi-Fi)：监听所有网卡，同一 Wi-Fi 下的手机/平板可打开工作台；仍需配对 Token |
| `tailscale` | `boolean` | `false` | Tailscale 通道：识别 Tailscale `100.64.0.0/10` 与 `*.ts.net` 地址，并提供对应通道入口 |
| `bonjour` | `boolean` | `false` | Bonjour 通道 (.local)：提供 `<主机名>.local` 入口，局域网内免 IP 访问 |
| `cloudflare` | `boolean` | `false` | Cloudflare Tunnel 通道：接受本机 `cloudflared` 指向 `127.0.0.1:<端口>` 建立的隧道流量（`cf-ray` / `cf-connecting-ip`）；该通道写操作始终需要二次确认 |
| `tunnelHostname` | `string` | `""` | 隧道公网域名：可选，命名隧道的 HTTPS 域名（如 `https://ag.example.com`）；用于展示入口 URL 并识别隧道流量 |
| `remotePermissionLevel` | `enum` | `"L0"` | 非回环通道权限级别：仅作用于 `lan`/`tailscale`/`bonjour`/`cloudflare`，本机回环始终全读写。可选 `L0`（只读 + 流式）、`L1`（对话与会话）、`L2`（工作区与宿主管理：增加文件写入、Git、插件与宿主设置） |
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
