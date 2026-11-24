# @agy-daddy/plugin-proxy

Agy-Daddy 官方 Layer 1 基础网络层插件：本地固定端口免重启网络代理网关（默认监听 `127.0.0.1:18766`）。

- **npm 包名**：`@agy-daddy/plugin-proxy`
- **Layer 层级**：Layer 1（网络与接入层）
- **信任等级**：官方 `T0`（声明 `bridge:route`、`net:listen`、`net:outbound:*`、`host:launch-args` 权限）
- **适用场景**：国内网络加速、企业出口代理、SOCKS5 转发及无感知切换代理/直连模式。

---

## 核心功能与安全默认值

- **零重启热切换**：单次通过宿主启动参数钩子注入 `--proxy-server=http://127.0.0.1:18766` 及环境变量（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`）。在运行期切换直连（`DIRECT`）或上游代理无需重启 Antigravity 宿主。
- **协议兼容与零外部依赖**：原生纯 Node.js 实现 RFC 1928 / RFC 1929 SOCKS5 客户端、HTTP 转发与 `CONNECT` 隧道代理，支持 `http://`、`https://`、`socks5://` 与 `socks5h://` 上游。
- **环境冲突探测与绕过**：自动探测 `loginShellEnv`（如 `zsh -ilc`）代理冲突，支持针对 CIDR、通配符和回环地址的 `NO_PROXY` 绕过规则。
- **安全默认值**：
  - `gatewayEnabled: true`：默认启用本地网关；
  - `mode: "direct"`：默认直连模式，不转发未经确认的外部代理；
  - `fallbackToDirectOnUpstreamError: false`：上游异常时默认不静默降级为直连，避免意外直连泄露流量。

---

## 安装与启用方式

### 1. 随官方全量安装
```sh
agy-daddy plugin install --official
```

### 2. 单独安装
```sh
agy-daddy plugin install npm:@agy-daddy/plugin-proxy
```

### 3. 宿主设置中心与交互
安装后自动激活（`onStartup`）。在 Agy-Daddy 设置中心进入「网络代理网关」面板，可直接调整转发模式、配置上游代理地址或执行连通性探测。

---

## 配置项说明表

对照 `settings.schema.json`：

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `gatewayEnabled` | `boolean` | `true` | 本地固定转发网关：开启后统一经本地固定端口转发请求，切换上游无需重启客户端 |
| `mode` | `enum` | `"direct"` | 转发模式：可选 `direct`（直连）或 `upstream`（上游代理） |
| `gatewayPort` | `number` | `18766` | 本地监听端口：转发网关绑定于 127.0.0.1 的固定端口（范围 1024-65535） |
| `fallbackToDirectOnUpstreamError` | `boolean` | `false` | 上游异常时自动直连：默认关闭，仅在严格需要可用性优先时开启 |
| `upstreamUrl` | `string` | `""` | 上游代理地址：支持 http://、https://、socks5:// 与 socks5h:// 协议 |
| `noProxy` | `string` | `"localhost,127.0.0.1,::1,127.0.0.0/8,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12,<-loopback>"` | 绕过规则 (NO_PROXY)：逗号分隔的域名或 CIDR 网段，匹配后直接放行不走上游 |

### 声明式操作（Actions）
- **探测代理连通性 (`probe`)**：触发命令 `proxy.probe`。
- **切换代理模式 (`switch-mode`)**：触发命令 `proxy.switch-mode`。

---

## 提供的服务 / 事件 / 命令 / 扩展位

严格依据 `agy-plugin.json` 声明：

- **Services (provides)**：
  - `proxy`（版本 `1.0.0`，realm: `node`）
- **Events (provides)**：
  - `proxy:config-changed@1`：代理配置变更广播事件
- **States (provides)**：
  - `state:proxy.status@1`：代理当前运行状态与统计
- **Commands (contributes)**：
  - `proxy.switch-mode`：切换代理模式
  - `proxy.probe`：探测代理连通性

---

## 使用示例与本地测试

### 使用示例
在 Agy-Daddy 宿主设置中心将模式设为 `upstream`，上游代理填入本地代理软件端口（例如 `http://127.0.0.1:7890`），保存后网关立即热重载生效，无需重启客户端即可享受加速。

### 本地测试
在插件目录下执行自动化单元测试：
```sh
npm test
```
