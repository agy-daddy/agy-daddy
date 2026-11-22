# @agy-daddy/plugin-zh-cn

Agy-Daddy Layer-1 官方插件：可逆客户端中文汉化与会话自定义标题缓存。

## 特点
- 基于 `WeakMap` 记录被重写节点原文，切换 `EN` 或停用插件时无痕还原。
- 单向订阅 `chat:thinking-expanded@1`，与 `chat-nav` 彻底解耦。
- 远程思考翻译（`translate.googleapis.com`）默认关闭，需用户明确勾选开启。
