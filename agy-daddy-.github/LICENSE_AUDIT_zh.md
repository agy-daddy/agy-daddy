[English](./LICENSE_AUDIT.md) | 简体中文

# 开源许可与上游署名审计（`LICENSE_AUDIT`）

> **审计状态**：已按基线 `antigravity-suite@c349284`、`upstreams.json` 及各分拆包完成全面梳理。**公开发布前置门禁**：正式公开发布前，须取得所引用源仓库主要作者的明确书面署名授权确认。

---

## 1. 审计范围与目标

本文档持续记录 `agy-daddy` 单仓内的开源许可合规状态、上游版权署名、净室排除边界及分包许可台账。所有借鉴或衍生自社区上游项目的组件均须满足以下审计原则：

1. **许可协议兼容**：所有单仓包与上游来源均采用兼容的 OSI 宽松许可协议（MIT）。
2. **版权与 `NOTICE` 保留**：保留上游原始版权声明与 `NOTICE` 归属信息，并列明 `Copyright (c) 2026 Agy-Daddy Contributors`。
3. **净室与排除边界**：严格剔除二进制改包、`app.asar` 修改、解锁绕过代码及无授权资产。

---

## 2. 上游署名与许可矩阵

| 上游组件 / 仓库 | 版本 / 基线 | 协议 | 处理状态与归属包 | 范围与净室处理说明 |
|---|---|---|---|---|
| [`iamvicliu/antigravity-suite`](https://github.com/iamvicliu/antigravity-suite) | `c349284` | MIT（`Antigravity Context Viewer Contributors`） | 底座及各衍生插件均已保留 `LICENSE` + `NOTICE` | 所有衍生包均同时保留原 MIT 版权行与 `Agy-Daddy Contributors`。 |
| [`elviscjn-cjn/antigravity-context-viewer`](https://github.com/elviscjn-cjn/antigravity-context-viewer) | `v0.8.9` | MIT | 已署名归入 `context` / `usage` / `quota` 的 `NOTICE` | 已彻底剔除全部 `app.asar` 修改与解锁逻辑代码。 |
| [`akelabs/antigravity-pulse`](https://github.com/akelabs/antigravity-pulse) | `v1.3.2` | MIT | 已署名归入 `context` 的 `NOTICE` | 仅吸收底部脉冲胶囊界面与速率计算逻辑。 |
| [`n2ns/antigravity-panel`](https://github.com/n2ns/antigravity-panel) | `v2.8.5` | MIT | 已署名归入 `quota` / `composer` 的 `NOTICE` | 已重构为遵循安全默认关闭与隔离世界运行原则。 |
| [`yiheng8023/antigravity-chinese`](https://github.com/yiheng8023/antigravity-chinese) | `v3.3.57` | MIT + VS Code [`microsoft/vscode-loc`](https://github.com/microsoft/vscode-loc)（MIT） | 已署名归入 `zh-cn` 的 `NOTICE` | 明确排除无授权繁体词典（`zh-TW`）；新增的 8 种语言包（`zh-TW`、`ja`、`ko`、`es`、`pt`、`fr`、`ru`、`it`）全部为 `Agy-Daddy Contributors` 原创 MIT 翻译。 |
| [`wycocoyu/agy-context-dashboard`](https://github.com/wycocoyu/agy-context-dashboard) | `v0.9.5` | MIT | 已核对（仅作指标布局去重参考） | 仅作界面指标布局去重参考，不存在直接拷贝代码冲突。 |
| [`oil-oil/agy-fast-io`](https://github.com/oil-oil/agy-fast-io) | `v0.2.1` | MIT | 已署名归入 `composer` 的 `NOTICE` | 原生规则文件存放于 [`agy-daddy-plugin-composer/native/fast-io-AGENTS.md`](../agy-daddy-plugin-composer/native/fast-io-AGENTS.md)。 |

---

## 3. 单仓分包许可与 `NOTICE` 台账

| 包目录 | 声明协议 | `LICENSE` 文件 | `NOTICE` 文件 | 来源与说明 |
|---|---|---|---|---|
| `agy-daddy-host/` | MIT | 已配备 | 已配备 | 衍生自 `antigravity-suite@c349284` + `Agy-Daddy Contributors` 原创纯净声明式底座 |
| `agy-daddy-plugin-proxy/` | MIT | 已配备 | 已配备 | 衍生自 `antigravity-suite`（`meter-proxy.js`） |
| `agy-daddy-plugin-zh-cn/` | MIT | 已配备 | 已配备 | 衍生自 `antigravity-suite`、`antigravity-chinese`、`vscode-loc` + `Agy-Daddy Contributors` 8 语原创翻译 |
| `agy-daddy-plugin-cli/` | MIT | 已配备 | 已配备 | 衍生自 `antigravity-suite`（`meter-cli-launcher.js`、`meter-terminals.js`） |
| `agy-daddy-plugin-context/` | MIT | 已配备 | 已配备 | 衍生自 `antigravity-suite`、`antigravity-context-viewer`、`antigravity-pulse` |
| `agy-daddy-plugin-usage/` | MIT | 已配备 | 已配备 | 衍生自 `antigravity-suite`、`antigravity-context-viewer` |
| `agy-daddy-plugin-chat-nav/` | MIT | 已配备 | 已配备 | 衍生自 `antigravity-suite`（`ag-enhancer-overlay.js`） |
| `agy-daddy-plugin-quota/` | MIT | 已配备 | 已配备 | 衍生自 `antigravity-suite`、`antigravity-context-viewer`、`antigravity-panel` |
| `agy-daddy-plugin-composer/` | MIT | 已配备 | 已配备 | 衍生自 `antigravity-suite`、`antigravity-panel`、`agy-fast-io` |
| `agy-daddy-plugin-remote/` | MIT | 已配备 | 已配备 | 衍生自 `antigravity-suite`（`mobile-remote.js`） |
| `agy-daddy-plugin-web/` | MIT | *待补充独立文件* | 不适用（原创） | `Agy-Daddy Contributors` 原创实现（`package.json` 与 `agy-plugin.json` 已声明 `"license": "MIT"`）；公开发布前需补充独立 `LICENSE` 文件 |
| `agy-daddy-plugin-template/` | MIT | 已配备 | 不适用（原创） | `Agy-Daddy Contributors` 原创插件脚手架模板 |
| `agy-daddy-registry/` | MIT | 已配备 | 不适用（原创） | `Agy-Daddy Contributors` 原创信任注册表与 DOM 夹具 |

---

## 4. 净室与排除规范

1. **禁止二进制与 ASAR 修改**：任何涉及修补 `app.asar`、修改 Electron 资源包或绕过客户端限制的上游代码，在合入前必须彻底清除。
2. **排除无授权资产**：凡缺少可验证 OSI 开源协议的第三方词典、图标或代码片段（如已排除的 `antigravity-chinese` 繁体词典），一律禁止引入；对应资产必须基于 MIT 协议从头原创。
3. **运行时依赖隔离**：核心包保持零第三方运行依赖（`"dependencies": {}`）。`agy-daddy-plugin-remote/web` 与 `agy-daddy-plugin-web/web` 中的前端构建工具链（`vite`、`preact`、`react`、`typescript`、`vitest`）严格限定于 `devDependencies`，并预编译为静态 `dist/web/` 产物。

---

## 5. 持续审计与发布前检查清单

在打上公开发布标签（`v1.x.y`）或引入新的上游借鉴代码前，须逐项确认：

- [ ] 已获得源仓库主要作者对上游署名的明确书面授权确认（前述发布前置阻塞项）。
- [ ] 确保所有新增或变更包均配有准确的 `LICENSE` 文件（含补齐 `agy-daddy-plugin-web/LICENSE`）。
- [ ] 每当引入新的上游参考或代码片段时，同步更新对应包的 `NOTICE` 文件及本 `LICENSE_AUDIT_zh.md` 矩阵。
- [ ] 运行 `npm run verify:gates` 确认全仓包均未引入未经授权的运行时依赖。
