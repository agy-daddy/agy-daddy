# 插件审查清单 (T1 Community Review Checklist)

- [ ] **权限最小化**：核对 `agy-plugin.json` 中 `permissions` 是否存在多余高危权限；默认禁用 `page:main-world`、`process:spawn`、`host:launch-args`、`rpc:write`。
- [ ] **外网出站声明**：若申请 `net:outbound:<domain>`，文档与设置页必须明确告知外发内容与目标域名，且默认开关为关闭（Opt-in）。
- [ ] **无隐蔽全局逃逸**：隔离世界插件不读取 `__APP_CONFIG__` 或 React fiber；不改写 `app.asar` 或 `Antigravity.app` 二进制。
- [ ] **生命周期零泄漏**：卸载 `dispose()` 后 DOM 节点、监听器、定时器、事件订阅均清零，`assertCleanDispose` 通过。
- [ ] **主题一致性**：通过紫色主题禁令静态扫描，适配深色/浅色与 5 套预设高亮色。
- [ ] **完整性签名**：提供稳定语义化版本与正确的 `agy-plugin.json` / tarball SHA-512 哈希。
