# @agy-daddy/plugin-cli

Agy-Daddy Layer-1 官方插件：顶栏 CLI 启动胶囊与跨平台终端（Terminal / iTerm2 / Ghostty / Warp / Rex / WezTerm / tmux / Windows Terminal / PowerShell）启动器。

## 特性
- 隔离世界安全注入：顶栏按钮经 Bridge 安全触发，不访问页面全局。
- 严格校验并转义 `muxHost` 与工作目录参数，防止命令注入。
- 软消费可选 `proxy.getCliEnv()` 自动继承 `127.0.0.1:18766` 代理环境并恢复交互终端真彩色。
