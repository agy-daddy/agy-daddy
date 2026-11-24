# @agy-daddy/plugin-cli

Agy-Daddy 官方 Layer 1 终端与多路复用器启动插件：顶栏 CLI 胶囊与多平台终端一键唤起。

- **npm 包名**：`@agy-daddy/plugin-cli`
- **Layer 层级**：Layer 1（接入与工作区层）
- **信任等级**：官方 `T0`（声明 `dom:write`、`process:spawn`、`fs:read`、`fs:write` 权限）
- **适用场景**：一键从当前会话工作区启动独立终端 CLI（Terminal、iTerm2、Ghostty、Warp、Rex、WezTerm、tmux、Windows Terminal、PowerShell 等）。

---

## 核心功能与安全默认值

- **跨平台终端集成**：智能探测并支持 macOS、Linux 与 Windows 下的主流终端与复用器（Terminal、iTerm2、Alacritty、Kitty、Ghostty、Warp、Rex、WezTerm、tmux、Windows Terminal、PowerShell）。
- **工作区上下文与环境继承**：自动识别当前 Antigravity 会话的工作区绝对路径，并软消费可选 `proxy.getCliEnv()` 自动继承代理环境变量（`127.0.0.1:18766`）与真彩色支持。
- **参数安全转义**：严格转义 `muxHost`、自定义启动参数与工作路径，拦截命令注入。
- **安全默认值**：
  - `cliPermissionMode: "default"`：默认保持标准权限模式，不默认开启免审核高危模式；
  - `cliMuxHost: ""`：默认本地启动，不预连未受信任远程主机。

---

## 安装与启用方式

### 1. 随官方全量安装
```sh
agy-daddy plugin install --official
```

### 2. 单独安装
```sh
agy-daddy plugin install npm:@agy-daddy/plugin-cli
```

### 3. 宿主设置中心与顶栏交互
安装后自动激活（`onStartup`）。插件在顶栏右侧集群挂载 CLI 启动胶囊（order: 40）。点击即可在新终端窗口中进入当前工作区并启动 CLI，亦可在设置中心「CLI 终端启动器」中配置常用命令与终端路径。

---

## 配置项说明表

对照 `settings.schema.json`：

| Key | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `terminalApp` | `enum` | `"auto"` | 目标终端 / 多路复用器：从顶栏点击 CLI 胶囊时优先唤起的终端或会话复用器（可选 auto, Terminal, iTerm2, Alacritty, Kitty, Ghostty, Warp, Rex, WezTerm, tmux, Windows Terminal, PowerShell） |
| `customTerminalPath` | `string` | `""` | 终端程序路径：切换终端后自动检测并回显路径；检测失败时请手动输入或点击「浏览选择」 |
| `cliMuxHost` | `string` | `""` | SSH 多路复用主机：支持下拉选择 ~/.ssh/config 主机或直接输入 user@host；留空则在本地启动 |
| `cliLabel` | `string` | `"CLI"` | 默认按钮显示名称：自定义顶栏默认 CLI 启动按钮与菜单标题的显示名称 |
| `cliDefaultModel` | `string` | `""` | 默认 CLI 模型：支持下拉选择可用模型或直接输入自定义模型标识，留空沿用 CLI 默认配置 |
| `cliPermissionMode` | `enum` | `"default"` | 启动权限模式：设置启动 agy 时的工具执行权限策略；可选 `default`（标准）或 `bypass`（免审核，仅建议在受信任工作区使用） |
| `cliDefaultCommand` | `string` | `""` | 默认启动命令：根据模型与权限选项自动拼接生成，支持直接编辑或追加参数 |
| `quickCommands` | `list` | `[]` | 自定义快捷启动命令：添加任意终端命令用于顶栏快速启动（如 claude、codex、npm run dev 等），可选择固定在顶栏或收纳进 CLI 菜单 |

### 声明式操作（Actions）
- **在新终端启动 CLI (`launch`)**：触发命令 `cli.launch`。

---

## 提供的服务 / 事件 / 命令 / 扩展位

严格依据 `agy-plugin.json` 声明：

- **Services (provides)**：
  - `cli`（版本 `1.0.0`，realm: `node`）
- **Consumes Services**：
  - `proxy`（版本 `^1.0.0`，optional: `true`）
- **Commands (contributes)**：
  - `cli.launch`：在新终端启动 CLI
- **Topbar Units (contributes)**：
  - `cli`（order: `40`）

---

## 使用示例与本地测试

### 使用示例
在 Antigravity 中打开一个项目后，直接点击顶栏的「CLI」胶囊，即可自动在系统默认终端（或配置的 iTerm2 / tmux）中唤起命令行会话，且工作目录自动定位到当前项目路径。

### 本地测试
在插件目录下执行自动化单元测试：
```sh
npm test
```
