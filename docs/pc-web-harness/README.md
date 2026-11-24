# PC Web Harness TDD 设计与开发文档套件

> Worktree 路径：`/Volumes/external/worktrees/agy-daddy/feat-pc-web-harness`  
> 分支：`feat/pc-web-harness`（基线提交：`e353217`，全仓 13 个包基线 `npm test` 全部通过，0 失败）  
> 目标：打造替代 Antigravity 原生闭源窗口的 PC 端 Web Harness 插件（`agy-daddy-plugin-web`），对标 `dsh web` 体验并提供完整 `agy-daddy-host` 底座控制能力，严格遵循 **Test-Driven Development (TDD)** 推进开发。

---

## 1. 文档索引

| 文档 | 用途 | 核心内容 |
|---|---|---|
| [01-PHASE0-RPC-CONTRACT.md](./01-PHASE0-RPC-CONTRACT.md) | 协议真机实测基准 | Phase 0（只读）+ Phase 0b（写探针）全量实测契约、进程树结论、11 类 Step 结构与离线 Mock Fixture 模板 |
| [02-ARCHITECTURE-AND-API-SPEC.md](./02-ARCHITECTURE-AND-API-SPEC.md) | 架构与接口规范 | 方案 B 双插件边界、Host 最小增量、`/api/v1/*` HTTP + SSE 契约、安全模型、`dsh web` 三栏几何与 `web-harness` 共享服务 |
| [03-TDD-TEST-MATRIX-AND-SPEC.md](./03-TDD-TEST-MATRIX-AND-SPEC.md) | 测试驱动规格矩阵 | 6 大测试套件（Suite A–F）的逐条 Red-Green 用例定义、会令测试失败的变动约束、输入断言与运行命令 |
| [04-IMPLEMENTATION-PLAN.md](./04-IMPLEMENTATION-PLAN.md) | 10 步 TDD 实施计划 | Task 1–10 的严格红绿重构节拍、文件落位、门禁校验与端到端验收标准 |

---

## 2. 分支基线与主仓对齐说明（必读）

- 本 worktree 从提交 `e353217` 切出，**隔离保护了主仓** `/Volumes/external/Projects/agy-daddy`（分支 `feat/host-decoupling-and-settings`）上尚未提交的既有改动。
- **差异提醒**：在 `e353217` 基线上，`agy-daddy-host/src/core/daemon.js` 已注册 10 个 `/host/*` 路由（`/host/health`、`/host/plugins`、`/host/plugins/{toggle,install,uninstall,rollback}`、`/host/reload`、`/host/anchors`、`/host/bus/call`、`/host/settings`）；主仓未提交工作区中新增的 5 个路由（`/host/marketplace/stats`、`/host/reload-all`、`/host/daemon/restart`、`/host/host-settings`、`/host/commands/run`、`/host/diagnostics/export`）待主仓 `feat/host-decoupling-and-settings` 合入 `main` 后，在修改 Host 源码前对本分支执行一次 `git rebase` 即可自动对齐，避免重复造轮子或合并冲突。

---

## 3. TDD 执行铁律

```text
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

每个 Task（Task 1–10）必须严格按以下闭环推进：

1. **RED（先写失败测试）**：按 [03-TDD-TEST-MATRIX-AND-SPEC.md](./03-TDD-TEST-MATRIX-AND-SPEC.md) 写出单个行为测试（优先使用 `node:test` + `node:assert/strict` 与真实模块边界，仅对外部进程/RPC 注入最小 stub）。
2. **Verify RED（亲眼验证红灯）**：运行单测命令，确认测试因“功能缺失或目标缺陷”而非语法/路径错误而失败。
3. **GREEN（最小实现）**：只写刚好让该红灯变绿的最简代码，不提前过度设计。
4. **Verify GREEN（全量绿灯）**：先跑当前单测，再跑包级/全仓 `npm test` 确认零回归。
5. **REFACTOR（绿灯重构）**：消除重复逻辑、提炼小函数，并再次运行 `npm test` 与 `npm run verify:gates` 保持全绿。

---

## 4. 常用验证命令速查（Worktree 内执行）

```sh
# 1. 基线 / 全仓单元测试（13 个包）
npm test

# 2. 单独运行 Host 或新插件测试
AGY_DADDY_TEST_MODE=1 node --test agy-daddy-host/test/<file>.test.js
AGY_DADDY_TEST_MODE=1 node --test agy-daddy-plugin-web/test/<file>.test.js

# 3. 静态门禁（零运行依赖 / 全员 isolated / schema / 主题 / anchors / registry SHA-512）
npm run verify:gates

# 4. 完整 CI 等价校验（build + gates + test）
npm run verify
```
