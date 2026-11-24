# @agy-daddy/plugin-remote

Agy-Daddy 官方 Layer 4 远程控制插件：手机移动端 PWA 控制台、多通道状态聚合与安全加密隧道（LAN / Tailscale / Cloudflare Tunnel）。

- **npm 包名**：`@agy-daddy/plugin-remote`
- **Layer 层级**：Layer 4（远程接入与互联层）
- **信任等级**：官方 `T0`（声明 `dom:write`、`rpc:read`、`rpc:write`、`bridge:route`、`fs:brain-read`、`fs:user-files`、`net:listen`、`process:spawn` 权限）
- **适用场景**：手机随时随地监控长任务进度、查看工作区文件差异、下达指令或审批会话，支持离家公网安全穿透。

---

## 核心功能与安全默认值

- **手机端极速 PWA 控制台**：本地独立端口（默认监听 `18765`），提供为移动端触屏定制的会话管理、文件预览与 PTY 交互。
- **软状态聚合架构**：可选消费 `context`、`usage`、`quota` 等服务，任一插件缺失时平滑降级（显示 `{ available: false }`），绝不影响主控制台运行。
- **多通道网络与穿透**：支持本机回环（127.0.0.1）、同一 Wi-Fi 局域网直连、Tailscale 组网发现及 Cloudflare Tunnel（支持 Quick 与 Named 域名）公网穿透。
- **安全默认值**：
  - `permissionLevel: "L0"` / `allowRemoteWrite: false`：默认严格只读监控，禁止远程写操作；未授权前一切写请求均返回 `403 REMOTE_WRITE_DISABLED`；
  - `lan: false`、`tailscale: false`、`cloudflare: false`：外网与局域网通道默认全部关闭，仅监听本地回环；
  - 令牌校验使用 `crypto.timingSafeEqual` 定常时间比对，杜绝时序攻击。

---

## 安装与启用方式

### 1. 随官方全量安装
```sh
agy-daddy plugin install --official
```

### 2. 单独安装
```sh
agy-daddy plugin install npm:@agy-daddy/plugin-remote
```

### 3. 宿主设置中心与顶栏交互
安装后自动激活（`onStartup`）。插件在顶栏（order: 60）挂载远程连接胶囊。点击胶囊即可弹出动态配对二维码浮窗（扫码即可直接配对连接并自动填充安全 Token）；在设置中心「远程访问设置」可按需开启网络通道与调整权限级别。

---

## 配置项说明表

对照 `settings.schema.json`：

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `permissionLevel` | `enum` | `"L0"` | 远程权限级别：`L0`（只读监控）；`L1`（允许发消息、排队插话与审批）；`L2`（解锁文件写、Git 提交推送与交互式 PTY 终端，仅限宿主机本地开启） |
| `allowRemoteWrite` | `boolean` | `false` | 允许远程写操作：向后兼容开关：与 L1/L2 权限联动（关闭对应 L0 只读，开启对应 L1 对话与审批） |
| `allowedRoots` | `list` | `[]` | 允许访问的工作区根目录白名单：限制手机端文件读写、Git 与 PTY 终端仅可访问以下本地目录；可点击「浏览」可视化选择文件夹添加，或手动输入路径（留空则仅读取已发现会话的工作区） |
| `orchestratorCarbonThinking` | `enum` | `"high"` | Carbon 主控思考等级：编排模型选择 Carbon 主控时独立使用的思考等级（off/low/medium/high） |
| `orchestratorArgonThinking` | `enum` | `"high"` | Argon 主控思考等级：编排模型选择 Argon 主控时独立使用的思考等级（off/low/medium/high） |
| `orchestratorNeonThinking` | `enum` | `"high"` | Neon 主控思考等级：编排模型选择 Neon 主控时独立使用的思考等级（off/low/medium/high） |
| `orchestratorOpusThinking` | `enum` | `"high"` | Opus 5.5 主控思考等级：编排模型选择 Opus 5.5 主控时独立使用的思考等级（off/low/medium/high） |
| `modelSortMode` | `enum` | `"custom"` | 模型默认排序方式：控制手机端与设置列表中的模型排序规则（custom/name/provider） |
| `modelFilterOrder` | `list` | `[]` | 模型过滤与排序：按名称或厂商筛选模型、控制手机端可见性，并支持按规则排序或上移/下移自定义顺序 |
| `loopback` | `boolean` | `true` | 本机回环监听 (127.0.0.1)：为本机浏览器调试或 SSH 端口转发提供轻量服务入口 |
| `lan` | `boolean` | `false` | 局域网访问通道：同一 Wi-Fi 下手机可直接扫码访问，仅对持令牌设备开放 |
| `tailscale` | `boolean` | `false` | Tailscale 组网探测：自动探测本机 Tailscale 虚拟网卡 IP 并生成加密私网链接 |
| `bonjour` | `boolean` | `false` | Bonjour (.local) 发现：在局域网内广播 mDNS 服务名，无需记住 IP 地址 |
| `cloudflare` | `boolean` | `false` | Cloudflare Tunnel 公网穿透：通过 cloudflared 建立 HTTPS 隧道以支持移动网络远程访问 |
| `tunnelMode` | `enum` | `"quick"` | Cloudflare 隧道模式：Quick 模式免账号即时生成随机域名；Named 模式使用自定义固定域名 |
| `tunnelHostname` | `string` | `""` | 固定隧道域名 (Public Hostname)：在 Cloudflare Zero Trust 中绑定的自有 HTTPS 域名（如 https://ag.example.com） |
| `tunnelToken` | `string` | `""` | Cloudflare Tunnel Token：仅写保存，保存后不再回显明文；粘贴 Connector Token 或完整 cloudflared service install 命令，自动提取并校验 |

### 声明式操作（Actions）
- **轮换远程配对令牌 (`rotate-token`)**：触发命令 `remote.rotate-token`。
- **查看远程通道状态 (`status`)**：触发命令 `remote.status`。
- **踢出全部设备 (`kick-devices`)**：触发命令 `remote.kick-devices`。

---

## 提供的服务 / 事件 / 命令 / 扩展位

严格依据 `agy-plugin.json` 声明：

- **Services (provides)**：
  - `remote`（版本 `1.0.0`，realm: `node`）
- **Consumes Services**：
  - `context`（版本 `^1.0.0`，optional: `true`）
  - `usage`（版本 `^1.0.0`，optional: `true`）
  - `quota`（版本 `^1.0.0`，optional: `true`）
  - `web-harness`（版本 `^1.0.0`，optional: `true`）
  - `composer-node`（版本 `^1.0.0`，optional: `true`）
- **Surfaces (provides)**：
  - `remote.panels`：远程面板扩展插槽
  - `remote.actions`：远程动作扩展插槽
- **States (provides)**：
  - `state:remote.status@1`：远程连接与通道运行状态
- **Commands (contributes)**：
  - `remote.rotate-token`：轮换远程配对令牌
  - `remote.status`：查看远程通道状态
  - `remote.kick-devices`：踢出全部已连设备并轮换令牌
  - `remote.check-cloudflared`：检测 cloudflared 安装状态
  - `remote.browse-allowed-root`：浏览并添加允许访问的工作区目录
  - `remote.list-models`：获取可用模型列表
- **Topbar Units & Popovers (contributes)**：
  - Topbar Unit: `remote`（order: `60`）
  - Topbar Popover: `remote-panel`（anchorId: `remote`）

---

## 使用示例与本地测试

### 使用示例
在设置中开启「局域网访问通道」，点击顶栏远程图标弹出二维码，使用手机扫码即可直接在手机浏览器或添加到主屏幕（PWA）查看正在执行的长任务，随时审批操作。

### 本地测试
在插件目录下执行自动化单元测试：
```sh
npm test
```
