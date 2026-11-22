# Agy-Daddy Host (`@agy-daddy/host`)

Google Antigravity 桌面端的 100% 零改包 CDP 开放插件底座（Phase 0 + Phase 1 基线）。

## 目录结构

- `src/contracts/`：插件清单校验、SemVer 区间匹配、权限与信任分级策略（T0/T1/T2）
- `src/core/`：运行时解析链、CDP 引擎、RPC 白名单代理、四域总线、动态 Bridge、隔离 Worker、单实例守护、安装器（`local`/`git`/`npm`）、只读迁移与 `doctor`
- `src/renderer/` & `dist/host-renderer.js`：Shadow DOM 顶栏表面、声明式设置面板、锚点注册表与共享 `MutationObserver` 中心、跨世界通道
- `sdk/` & `templates/plugin-template/`：开放 SDK、Mock 测试夹具与最小示例插件
- `plugins/legacy-suite/`：绞杀者过渡期兼容层（只读加载 `antigravity-suite` 既有模块并支持模块掩码逐步退役）

## 常用命令

```sh
npm run build:renderer
npm test
./bin/agy-daddy doctor --json
```
