# 03 · TDD 测试规格矩阵（Suites A–F）

> 严格执行 `test-driven-development` 铁律：**先写失败测试（RED）→ 确认失败原因正确 → 写最小实现（GREEN）→ 全仓绿灯重构**。  
> 所有后端单测均基于 Node.js 内置 `node:test` + `node:assert/strict`（零第三方测试框架依赖），并在 `AGY_DADDY_TEST_MODE=1` 下运行。

---

## Suite A：Host 底座增量（`agy-daddy-host/test/`）

| ID | 目标模块 | 测试行为 | 会令测试失败的生产改动 | 输入与核心断言 | RED 运行命令 |
|---|---|---|---|---|---|
| **A1** | `rpc.js` | `discoverFromHubDaemonFiles` 跳过已退出 PID 的僵尸 `hub_*.json` | 去掉 `isPidAlive` 校验或仅按 `mtimeMs` 取首个文件 | 构造临时目录含 2 个文件：较新的 `dead`（`pid: 999991`, `isPidAlive` 返回 `false`）与较旧的 `alive`（`pid: 12345`, `isPidAlive` 返回 `true`）；断言返回 `alive` 对应 `origin`；全死时返回 `null` | `AGY_DADDY_TEST_MODE=1 node --test agy-daddy-host/test/bus-bridge-rpc.test.js` |
| **A2** | `constants.js` & `rpc.js` | `RPC_READ_ALLOWLIST` 放行 `GetCascadeTrajectorySteps` 且 `host:control` 仅限 T0 | 从 `RPC_READ_ALLOWLIST` 删除 `GetCascadeTrajectorySteps` 或允许 T1/T2 无审批获取 `host:control` | 断言 `createScopedRpcClient('p', ['rpc:read'], mock)` 可调用 `GetCascadeTrajectorySteps`；断言 `evaluateTrustPolicy` 对 T1/T2 插件申请 `host:control` 判为高危受限 | `AGY_DADDY_TEST_MODE=1 node --test agy-daddy-host/test/manifest-and-trust.test.js` |
| **A3** | `bus.js` | `FourRealmBus.onAny` 捕获所有 `event` 与 `state` 变更并支持彻底 `dispose()` | 不转发 `state` 变更或 `dispose()` 后继续触发回调 | 注册 `onAny` 监听器，分别执行 `emitEvent` 和 `setState`；断言收到两条 `{ kind, topicOrKey, payload }`；调用 `dispose()` 后再触发，断言计数不再增加 | `AGY_DADDY_TEST_MODE=1 node --test agy-daddy-host/test/bus-bridge-rpc.test.js` |
| **A4** | `daemon.js` & `bridge.js` | `host.control.invoke` 复用 `/host/*` 路由且拦截非白名单路由 | 放行 `/host/evil` 或破坏插件权限隔离校验 | 用 T0 插件持有 `host:control` 调用 `/host/plugins` 与 `/host/settings` 返回 `ok: true`；调用 `/host/unknown` 抛出 `HOST_CONTROL_ROUTE_BLOCKED`；无 `host:control` 插件 `host.control` 为 `undefined`/抛 `PERMISSION_DENIED` | `AGY_DADDY_TEST_MODE=1 node --test agy-daddy-host/test/host-control.test.js` |

---

## Suite B：Harness Adapter 与增量推流（`agy-daddy-plugin-web/test/harness-adapter.test.js`）

| ID | 目标模块 | 测试行为 | 会令测试失败的生产改动 | 输入与核心断言 | RED 运行命令 |
|---|---|---|---|---|---|
| **B1** | `harness-adapter.js` | `listSessions()` 归一化摘要、排序与工作区元数据 | 遗漏 `workspaces[0]` 提取或未按 `lastModifiedTime` 降序排序 | 传入 mock `GetAllCascadeTrajectories`（含 2 条不同时间戳、带 `gitRootAbsoluteUri` 与 `branchName`）；断言按最近修改倒序输出且包含 `cascadeId`, `title`, `status`, `stepCount`, `workspaceUri`, `branchName` | `AGY_DADDY_TEST_MODE=1 node --test agy-daddy-plugin-web/test/harness-adapter.test.js` |
| **B2** | `harness-adapter.js` | `normalizeStepToSessionEvent()` 全覆盖 11 种 `CORTEX_STEP_TYPE_*` 与 6 种状态 | 任一 step type 崩溃、丢失 `thinking`/`combinedOutput`/`diffStats`/`questions`/`artifactSnapshots` | 构造含全部 11 种 step type 的数组；断言返回 11 个标准 `SessionEvent`，且各关键字段无丢失，未知 type 优雅降级为 `tool_generic` 不抛错 | 同上 |
| **B3** | `harness-adapter.js` | `pollDelta()` 基于 `stepOffset` 增量拉取并精确推进偏移 | 每次从 `stepOffset=0` 全量重发或对 `GENERATING` 尾部变化静默跳过 | 模拟连续 3 次 `GetCascadeTrajectorySteps` 调用：第 1 次 `step[0]=DONE, step[1]=GENERATING`；第 2 次 `step[1]` 内容增长仍 `GENERATING`；第 3 次 `step[1]=DONE` 且新增 `step[2]=DONE`；断言仅推送变更/新增事件且 `stepOffset` 从 `0 -> 1 -> 3` | 同上 |
| **B4** | `harness-adapter.js` | `createSession()` 必填 `source` 与 `sendMessage()` 携带模型配置及 `cancelSession()` | 漏传 `CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT` 或丢弃 `modelId` | Mock RPC 断言 `StartCascade` 收到 `source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT'`；`SendUserCascadeMessage` 收到 `items: [{ text }]` 与 `cascadeConfig.plannerConfig.requestedModel.model`；`CancelCascadeInvocation` 收到 `{ cascadeId }` | 同上 |
| **B5** | `harness-adapter.js` | `approveStep()` 在未验证真实 RPC 前明确返回 `501 APPROVAL_RPC_UNAVAILABLE_IN_2_34` | 静默伪造成功或调用已知 404 的 `AcceptCascadeStep` | 调用 `approveStep('cid', 1, 'accept')`，断言返回 `{ ok: false, statusCode: 501, error: 'APPROVAL_RPC_UNAVAILABLE_IN_2_34' }` 且未向 RPC 发送 404 废请求 | 同上 |

---

## Suite C：Workspace Sandbox & Artifacts（`agy-daddy-plugin-web/test/workspace-service.test.js`）

| ID | 目标模块 | 测试行为 | 会令测试失败的生产改动 | 输入与核心断言 | RED 运行命令 |
|---|---|---|---|---|---|
| **C1** | `workspace-service.js` | `listTree()` 列举工作区文件并自动忽略 `.git` / `node_modules` | 未过滤 `.git` 或未按目录优先排序 | 在 `os.tmpdir()` 建立工作区（含 `.git/config`、`node_modules/a.js`、`src/index.js`、`README.md`）；断言返回结果不含 `.git` 与 `node_modules`，目录排在文件前 | `AGY_DADDY_TEST_MODE=1 node --test agy-daddy-plugin-web/test/workspace-service.test.js` |
| **C2** | `workspace-service.js` | 路径穿越与 Symlink 逃逸防护 | 仅做字符串 `startsWith` 未做 `fs.realpathSync` 校验 | 分别传入 `../../etc/passwd`、`/etc/hosts`、以及工作区内指向工作区外临时文件的 symlink；断言全部拒绝并返回 `{ ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' }` | 同上 |
| **C3** | `workspace-service.js` | `readFile()` / `writeFile()` 大小限制与原子写入 | 忽略 `maxBytes` 导致大文件 OOM 或允许越界写 | 读取超过上限（如 2MB）文件时返回截断标志或 `413`；写入合法工作区文件成功且内容一致 | 同上 |
| **C4** | `workspace-service.js` | `getGitDiff()` 解析与非 Git 目录降级 | 非 git 目录直接抛未捕获异常导致 500 | 在临时 git init 并修改文件的工作区调用，断言 `isGitRepo: true` 且 `diffText` 包含修改 hunk；在普通非 git 目录调用断言 `{ ok: true, isGitRepo: false, files: [], diffText: '' }` | 同上 |
| **C5** | `workspace-service.js` | `listArtifacts()` / `readArtifact()` 读取 `brain/<cascadeId>` 产物且防越界 | 允许 `cascadeId` 为 `../other` 读取上级目录 | 构造临时 `brainDir/<uuid>/plan.md`；断言正常列出与读取 `.md` 内容，传入 `../secret` 返回 `403` | 同上 |

---

## Suite D：Web Server 安全边界与 SSE 传输（`agy-daddy-plugin-web/test/web-server.test.js`）

| ID | 目标模块 | 测试行为 | 会令测试失败的生产改动 | 输入与核心断言 | RED 运行命令 |
|---|---|---|---|---|---|
| **D1** | `web-server.js` | 默认仅回环；非回环绑定须有对应通道，且仅接受本机网卡地址 | 无通道时允许 `host: '0.0.0.0'`，或 `start()` 静默改写显式 `host` | 默认构造绑定 `127.0.0.1` 且 `channels` 仅 `loopback: true`；`host: '0.0.0.0'` 无通道 → `ERR_CHANNEL_NOT_ENABLED`；`host: '203.0.113.9'` → `ERR_BIND_HOST_NOT_LOCAL`；`bindHostMode: 'loopback'` + `lan` → `ERR_BIND_HOST_CONFLICT`；篡改 `srv.host` 后 `start()` 仍拒绝 | `AGY_DADDY_TEST_MODE=1 node --test agy-daddy-plugin-web/test/web-server.test.js` |
| **D2** | `web-server.js` | 一次性 Token 换 `HttpOnly; SameSite=Strict` Cookie 并剥离 URL token | 保留 URL token 未重定向或 Cookie 缺少 `HttpOnly`/`SameSite=Strict` | 请求 `GET /?token=<valid>` 断言返回 `302`、`Location: /`、`Set-Cookie` 含 `HttpOnly` 与 `SameSite=Strict`；用错 token 返回 `401` | 同上 |
| **D3** | `web-server.js` | API 鉴权、写请求 CSRF Header 与安全响应头 | 放行无 Cookie 请求或写接口忽略 `X-Agy-Csrf` | 无鉴权 `GET /api/v1/sessions` 返回 `401`；带 Cookie 但缺 `X-Agy-Csrf` 的 `POST /api/v1/sessions` 返回 `403 CSRF_REQUIRED`；带齐 Cookie + `X-Agy-Csrf: 1` 返回 `200` 且响应头含 `X-Content-Type-Options: nosniff` 与 `frame-ancestors 'none'` | 同上 |
| **D4** | `web-server.js` | SSE 实时推帧与 `Last-Event-ID` 断线重放 | 未按 `id:` 缓存或重连未补发中间事件 | 建立 SSE 连接，服务端广播 `id: 1`, `id: 2` 后断开；客户端带 `Last-Event-ID: 1` 重连，断言立刻收到 `id: 2` 而非重复 `id: 1`；超窗口时收到 `event: session.resync` | 同上 |
| **D5** | `web-server.js` | 静态托管 `dist/web/` 与 SPA fallback（API 404 不回退 HTML） | `/api/v1/unknown` 错误返回 `index.html` | `GET /settings` 返回 `index.html` (200)；`GET /api/v1/not-exist` 返回 JSON `404` | 同上 |
| **D11** | `web-server.js` | 未启用通道在鉴权前即被拒绝 | 仅在 `/api/*` 内校验通道，静态入口仍可访问 | 以 `lan` 通道请求（通道集仅 `loopback`）→ `403 CHANNEL_DISABLED` 且 `channel: 'lan'`、`allowedChannels: ['loopback']`；`/` 同样 403；`external` 永不放行 | 同上 |
| **D12** | `web-server.js` | 非回环通道按 L0/L1/L2 分级放行 | 非回环通道沿用回环的全读写 | `lan` + `L0`：GET 200、SSE 200、POST `403 PERMISSION_DENIED{required:L1}`；升到 `L1` 后会话写 200 而 `fs/write` 仍 `403{required:L2}`；升到 `L2` 后 `fs/write` 200；回环通道在 `L0` 下写仍 200 | 同上 |
| **D13** | `web-server.js` | Cloudflare 通道写操作需动作绑定的二次确认 | 任意 `X-Agy-Confirm` 值均放行，或令牌不校验动作 | 无确认头 → `403 CONFIRMATION_REQUIRED{action:'POST /api/v1/sessions', confirmToken}`；用另一动作的令牌重放仍 403；用匹配令牌重试 200；`POST /api/v1/confirm` 空 `action` → `400 MISSING_ACTION` | 同上 |
| **D14** | `web-server.js` | 非回环 Cookie 写入须同源 `Origin`，且保持 `HttpOnly; SameSite=Strict` | 接受跨站 `Origin`，或改用 `SameSite=None` 破坏 http LAN | 令牌换 Cookie 后：`Origin: http://evil.example:18767` → `403 CSRF_REQUIRED`；`Origin` 为其他 LAN 主机 → 403；同源 `Origin` → 200；缺 `X-Agy-Csrf` → 403；`Set-Cookie` 含 `HttpOnly` 与 `SameSite=Strict` 且不含 `SameSite=None` | 同上 |
| **D15** | `web-server.js` | `GET /api/v1/web/status` 汇总通道、入口 URL 与权限级别 | 缺失通道/URL/权限字段，或忽略 `tunnelHostname` | 断言 `channel`、`permissionLevel`、`allowRemoteWrite`、`bindHost`、`activeChannels`、`urls.loopback`、`urls.cloudflare`（由 `tunnelHostname` 生成）、`primaryChannel` | 同上 |
| **D16** | `channel-config.js` | 确认令牌 HMAC 绑定单一动作且会过期 | 空 `act` 令牌可跨动作重放，或签名不校验 | 正确动作通过；错误动作、错误密钥、篡改令牌均失败；无动作令牌对具体动作失败；过期令牌失败 | 同上 |
| **D17** | `web-server.js` | `bindHostMode` 热更新重算地址，且被拒策略不留半更新状态 | 校验失败时已写入新通道/模式 | `bindHostMode: 'lan'` + 仅回环 → 抛 `ERR_CHANNEL_NOT_ENABLED` 且 `channels`/`host`/`bindHostMode` 全部不变；启用 `lan` 后同一调用返回 `rebind: true` 且 `host === '0.0.0.0'` | 同上 |
| **D19** | `channel-config.js` | `cf-*` 与 `*.ts.net` 请求头仅在可信源 IP 下生效 | 局域网或公网源 IP 伪造请求头绕过通道开关 | 回环源带 `cf-ray` → `cloudflare`；LAN/公网源伪造 `cf-ray`/`*.ts.net` → 仍归为 `lan`/`external`；回环或 Tailscale 源带 `*.ts.net` → `tailscale` | 同上 |
| **D20** | `web-server.js` | 非回环 `L0` 下 `/api/v1/web/status` 隐藏 `pairingToken` | 非回环只读客户端读取到明文配对 Token | `lan`/`cloudflare` + `L0` 下 `pairingUrl === ''` 且 `urls.*`/`primaryUrl` 不含 `token=`；回环或升至 `L1+` 后恢复返回配对链接 | 同上 |
| **E8** | `node.js` | `reconcileAccess()` 串行 Promise 链与 `start()` 失败回退 `previousHost` | 并发 `onChange` 丢弃二次重绑，或重绑失败后停服 | 连续触发 `{lan:true}`/`{lan:false}` 严格按序重绑；模拟 `0.0.0.0` 监听失败后自动回退 `127.0.0.1` 且服务保持 `running: true` | `AGY_DADDY_TEST_MODE=1 node --test agy-daddy-plugin-web/test/plugin-contract.test.js` |

---

## Suite E：Host Proxy、软聚合与共享服务（`agy-daddy-plugin-web/test/plugin-contract.test.js`）

| ID | 目标模块 | 测试行为 | 会令测试失败的生产改动 | 输入与核心断言 | RED 运行命令 |
|---|---|---|---|---|---|
| **E1** | `host-proxy.js` | 底座插件管理与设置透传（保持 `writeOnly` 脱敏） | 明文透传密钥字段或绕过 `host.control` | Mock `host.control.invoke`，验证 `getPlugins()`、`setPluginSettings()`、`runCommand()` 精确映射并原样保留 `secretState` | `AGY_DADDY_TEST_MODE=1 node --test agy-daddy-plugin-web/test/plugin-contract.test.js` |
| **E2** | `host-proxy.js` | 顶栏 `context`/`usage`/`quota` 软聚合与缺失降级 | 某插件未安装时整个 `/api/v1/topbar` 抛 500 | 仅注册 `context` 服务，缺失 `usage` 与 `quota`；断言 `context.available === true`，`usage.available === false`、`quota.available === false` | 同上 |
| **E3** | `node.js` | 插件激活/卸载生命周期、零泄漏 `dispose()` 与 `web-harness` 共享服务 | `dispose()` 未关闭 HTTP Server 或未注销服务 | 使用 `@agy-daddy/host/sdk/mock-harness` 激活 `agy-daddy-plugin-web`，调用 `web-harness.listSessions()` 与 `agy-daddy.web.status` 命令，随后 `dispose()` 验证监听端口与服务均已释放 | 同上 |

---

## Suite F：PC Web 前端与全仓门禁（`agy-daddy-plugin-web/web/` + CI）

| ID | 目标 | 测试行为 | 验证方式 |
|---|---|---|---|
| **F1** | `columns.ts`（前端几何纯函数） | 1440px 三栏全展（`280 / center / right`）、`<1024px` 左栏自动收折 `56px`、窗口过窄时优先保中栏 `>=400px` 而隐藏右栏（`rightbar=0`） | Vitest（构建期 `devDependencies`）或 Node `--experimental-strip-types` 单测 |
| **F2** | `SchemaSettingsForm` | 正确渲染 `boolean` / `enum` / `string` / `number` / `list` 五种字段与 `actions` 命令按钮，编辑保存触发 `PUT /api/v1/host/plugins/:id/settings` | Vitest 组件单测 |
| **F3** | 全仓静态门禁 + 端到端冒烟 | 1. `dependencies: {}` 零运行依赖<br>2. `world: "isolated"` 无 `page:main-world`<br>3. 紫/中性主题门禁（扫描 `src/` 与 `web/src/`）<br>4. `registry.json` SHA-512 一致性<br>5. 真实浏览器打开 `http://127.0.0.1:<port>/?token=...` 完成“切换会话 → 发消息 → 看流式节点 → 看右栏文件/Diff/Artifacts → 改插件设置” | `npm run verify` + 浏览器实测截图/检查 |
