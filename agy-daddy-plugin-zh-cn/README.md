# @agy-daddy/plugin-zh-cn

Agy-Daddy Layer-1 官方插件：可逆 10 语言客户端本地化与会话自定义标题缓存。

## 支持语言
- 东亚：`简体中文 (zh)`、`繁體中文 (zh-TW)`、`日本語 (ja)`、`한국어 (ko)`
- 欧美：`Español (es)`、`Português (pt)`、`Français (fr)`、`Русский (ru)`、`Italiano (it)`
- 原文：`English (en)`

## 特点
- 基于 `WeakMap` 记录被重写节点原文，任意语言间无重启直切，切回 `EN` 或停用插件时无痕还原。
- 顶栏集成地球切换胶囊与 10 语言选择浮窗（Popover），并同步托管设置中心与 `zh-cn.toggle-lang` / `zh-cn.set-lang` 命令。
- 单向订阅 `chat:thinking-expanded@1`，与 `chat-nav` 彻底解耦。
- 远程思考翻译（`translate.googleapis.com`）默认关闭，需用户明确勾选开启，按目标语言隔离缓存。
