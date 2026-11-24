# Phase 5: Antigravity MCP Apps 面板迁移可行性评估

> 结论：建议采用**双轨共存策略**——非顶栏独立报表与热力图/配额详单（`usage` 52 周热力图、`quota` 共享池明细）评估迁移或双模暴露至官方 MCP Apps；顶栏实时胶囊（`ring`、`tokens`、`quota`、`remote`）、输入框快捷栏与会话内联控件（`composer`、`chat-nav`、`zh-cn`）继续由 CDP 底座承载。

## 1. 能力对比与边界

| 面板 / 组件 | 当前承载方式 | 迁入 MCP Apps 可行性 | 评估建议 |
|---|---|---|---|
| Usage 52 周热力图与期间账单 (`usage`) | 顶栏 Popover / DOM 注入 | **高**：纯数据可视化，对页面 React/Composer 无耦合 | 提供 `usage_summary` MCP 工具，并在支持 MCP App 资源渲染时作为官方侧栏/全页视图承载，显著降低 DOM 改版脆弱性 |
| Quota 多池与 Ultra 倍率面板 (`quota`) | 顶栏 Popover | **中-高**：只读状态展示 | 提供 `quota_status` MCP 工具，Agent 对话可直接查询剩余配额；顶栏 G4/C 胶囊仍保留以便秒级 glanceable 感知 |
| 上下文快照与 240K 预警 (`context`) | Isolated World + 自注入 Pulse 底部胶囊 | **部分**：底部胶囊需强绑定 `composer.root` | 提供 `context_status` MCP 工具与 `context-governance` Skill；顶栏圆环与底部胶囊保留 Isolated World 渲染 |
| 汉化 / 对话导航 / 输入框快捷栏 | 宿主 DOM 重写与键盘监听 | **低（不适用 MCP Apps）** | 依赖全局快捷键（`⌘1~⌘9`、`Tab`）与高危红框实时拦截，继续由 CDP 宿主加载 |

## 2. 安全与生命周期结论

- 所有随插件 sync 至 `~/.gemini/config/plugins/<id>/` 的 MCP 配置与规则产物均受 `native:install` 权限门禁控制。
- 安装期由 `agy-daddy-host/src/core/native-sync.js` 自动写入隔离数据目录环境变量（`AGY_DADDY_PLUGIN_DATA_DIR`），卸载插件时整目录原子清理。
- 实机验证前：MCP server JSON-RPC 2.0 (`quota_status`、`usage_summary`、`context_status`) 已通过真实子进程 stdio 测试验证；Antigravity 客户端内 MCP Apps UI 宿主页渲染将在 Phase 5 实机冒烟时最终核验。
