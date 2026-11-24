# Agy-Daddy Host (`@agy-daddy/host`)

Google Antigravity 桌面端的 100% 零改包 CDP 纯净微内核（Thin Declarative Host）插件底座。

## 目录结构

- `src/contracts/`：插件清单校验、`settings.schema.json`（含声明式 `actions`）与值校验、SemVer 区间匹配、权限与信任分级策略（T0/T1/T2）
- `src/core/`：运行时解析链、全员 `Isolated World` CDP 注入器、RPC 白名单代理、四域总线、动态 Bridge（含插件内置系统路由 `/__settings` 与 `/__command`）、隔离 Worker、单实例守护（含 `host-settings.json` 与全托管配置/命令引擎）、安装器（`local`/`git`/`npm`）与 `doctor`
- `src/renderer/` & `dist/host-renderer.js`：Shadow DOM 顶栏治理（Pin/排序/`⋯` 溢出与统一 Popover 包壳）、Antigravity 原生设置弹窗融合（含 760×560 独立模态窗降级）与三段式下钻设置中心、14 具名锚点注册表、`ctx.surfaces` 插槽注册表与 `__agy_xworld_<nonce>` 跨世界通道
- `sdk/` & `templates/plugin-template/`：开放 SDK、Isolated World Mock 测试夹具与最小示例插件

## 常用命令

```sh
npm run build:renderer
npm test
./bin/agy-daddy doctor --json
```
