# Agy-Daddy Host (`@agy-daddy/host`)

Google Antigravity 桌面端的 100% 零改包 Chrome DevTools Protocol（CDP）纯净微内核（Thin Declarative Host）插件底座。

Agy-Daddy Host 是 Agy-Daddy 插件体系的核心运行时底座，通过 Chrome DevTools Protocol 外部非侵入挂载，提供多域事件总线、14 具名 DOM 锚点治理、全托管声明式设置与命令引擎、隔离世界沙箱及跨平台系统托盘能力。

---

## 核心特性

- **100% 零改包 CDP 架构**：不侵入、不篡改 Antigravity 的 `app.asar` 或任何底层二进制文件，升级官方客户端无破坏风险。
- **免 Node.js 开箱即用**：提供 macOS / Windows / Linux 三平台原生启动器，首次启动自动复用 Antigravity 自带的 Electron 运行时，小白用户无需预装 Node.js 或 npm。
- **纯净微内核契约**：插件逻辑与底座内部分离，严格基于 `agy-plugin.json` 与 `settings.schema.json` 声明式契约驱动。
- **隔离世界安全沙箱（`world: "isolated"`）**：官方插件严格运行于 Chrome 隔离世界，样式自带封装不污染主界面，跨域通过安全随机通道通信。
- **全托管设置与原生融合**：三段式设置中心深度融合至 Antigravity 原生设置面板，并提供 `760×560` 独立模态窗安全降级。
- **跨平台系统托盘 Launcher**：桌面通知区域常驻托盘，支持一键启动增强版、设置中心快捷直达与进程健康诊断。

---

## 安装与快速上手

### 方式一：三平台包装器直接下载（免装 Node.js / npm，推荐）

无需安装 Node.js 或 npm，完整解压对应平台压缩包后直接运行：

| 平台 / 用途 | 资产文件名 | 固定下载直链 |
|---|---|---|
| **macOS 包装器**（Universal 14+） | `agy-daddy-launcher-macos.zip` | [下载 macOS ZIP](https://github.com/agy-daddy/agy-daddy/releases/latest/download/agy-daddy-launcher-macos.zip) |
| **Windows 包装器**（x64 / ARM64） | `agy-daddy-launcher-windows.zip` | [下载 Windows ZIP](https://github.com/agy-daddy/agy-daddy/releases/latest/download/agy-daddy-launcher-windows.zip) |
| **Linux 包装器**（x64 / ARM64） | `agy-daddy-launcher-linux.tar.gz` | [下载 Linux tar.gz](https://github.com/agy-daddy/agy-daddy/releases/latest/download/agy-daddy-launcher-linux.tar.gz) |
| **SHA-256 校验和** | `agy-daddy-wrappers-sha256sums.txt` | [下载 SHA256SUMS](https://github.com/agy-daddy/agy-daddy/releases/latest/download/agy-daddy-wrappers-sha256sums.txt) |

> **提示**：上述固定直链将在下一个包含包装器的正式版本 tag（如 `v1.1.1`）发布后正式生效。
>
> **首次运行简要说明**：
> - **macOS**：解压后双击 `Agy-Daddy Launcher.app` 静默启动，或双击 `Install & Launch.command` 查看终端安装进度。若遇 Gatekeeper 拦截，在解压目录运行 `xattr -cr 'Agy-Daddy Launcher.app' 'Install & Launch.command'`。
> - **Windows**：右键压缩包选择「全部解压缩」，双击 `Agy-Daddy-Launcher.vbs` 无黑框启动，或双击 `Agy-Daddy-Launcher.cmd` 查看控制台日志。遇 SmartScreen 提示点击「更多信息」&rarr;「仍要运行」。
> - **Linux**：解压后在终端执行 `chmod +x agy-daddy-launcher.sh install-desktop-entry.sh && ./agy-daddy-launcher.sh`。托盘需预装 Python 3 与 PyGObject + GTK 3（如 `python3-gi` 与 `gir1.2-gtk-3.0`）。

---

### 方式二：一键脚本安装（终端命令行）

只要本机已安装 **Google Antigravity 桌面端**，即可在终端快速安装：

macOS / Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/agy-daddy/agy-daddy/main/scripts/install.sh | bash
```

Windows (PowerShell)：

```powershell
irm https://raw.githubusercontent.com/agy-daddy/agy-daddy/main/scripts/install.ps1 | iex
```

---

### 方式三：通过 npm 安装与日常使用

适用于已有 Node.js（`>= 22.4.0`）开发环境的用户（若未装全局 Node，入口 `bin/agy-daddy.js` 会自动探测并回退到 Antigravity Electron 运行时）：

```sh
# 1. 全局安装底座 CLI（或使用 npx @agy-daddy/host doctor --json）
npm install -g @agy-daddy/host

# 2. 跨平台一键安装全部 10 个官方插件（或按需单装，例如 npm:@agy-daddy/plugin-proxy）
agy-daddy plugin install --official

# 3. 环境诊断与日常管理
agy-daddy doctor --json       # 环境健康度与 14 锚点诊断
agy-daddy live                # 启动后台守护进程并执行 CDP 热注入
agy-daddy launcher            # 启动 Agy-Daddy Launcher 系统托盘与守护进程
agy-daddy install-launcher    # 生成桌面启动器快捷方式
agy-daddy auto-on             # 开启开机自启动
```

---

## 目录结构

- `bin/`：跨平台 CLI 执行入口（`agy-daddy.js` 与 Unix 启动脚本 `agy-daddy`），集成多环境 Node / Electron 探测回退链。
- `src/contracts/`：插件清单规范校验、`settings.schema.json`（含声明式 `actions`）与值校验、SemVer 区间匹配、权限与信任分级策略（`T0`/`T1`/`T2`）。
- `src/core/`：运行时解析链、全员 `Isolated World` CDP 注入器、RPC 白名单代理、四域总线、动态 Bridge（含插件内置系统路由 `/__settings` 与 `/__command`）、隔离 Worker 运行时、单实例守护进程（含 `host-settings.json` 与全托管配置/命令引擎）、安装器（`local`/`git`/`npm`）与 `doctor` 诊断系统。
- `src/renderer/` & `dist/host-renderer.js`：Shadow DOM 顶栏治理（Pin/排序/`⋯` 溢出与统一 Popover 包壳）、Antigravity 原生设置弹窗融合（含 `760×560` 独立模态窗降级）与三段式下钻设置中心、14 具名锚点注册表、`ctx.surfaces` 插槽注册表与 `__agy_xworld_<nonce>` 跨世界通道。
- `assets/`：启动器跨平台图标资产（macOS `.icns`、Windows `.ico`、Linux 多分辨率 `.png` 与矢量 `.svg`）。
- `sdk/` & `templates/plugin-template/`：开放 SDK、Isolated World Mock 测试夹具与最小示例插件模板。

---

## 常用开发命令

```sh
# 构建底座渲染层产物（生成 dist/host-renderer.js）
npm run build:renderer

# 运行底座所有单测与契约测试
npm test

# 执行环境诊断
./bin/agy-daddy doctor --json
```

---

## 相关链接

- [Agy-Daddy 总仓 README](../README.md)
- [Agy-Daddy 中文主档](../agy-daddy-.github/README_zh.md)
- [插件信任注册表与 DOM 锚点](../agy-daddy-registry/README.md)
- [贡献指南](../agy-daddy-.github/CONTRIBUTING_zh.md)
