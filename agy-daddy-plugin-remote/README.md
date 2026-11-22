# @agy-daddy/plugin-remote

Agy-Daddy 独立手机远程控制台插件（Layer 4）：

- **安全默认值**：仅监听 `127.0.0.1`（`lan: false`, `tailscale: false`, `cloudflare: false`），且远程写入默认关闭（`allowRemoteWrite: false`），未启用前 `POST /api/action` 一律返回 `403 REMOTE_WRITE_DISABLED`。
- **令牌校验与轮换**：`GET /api/snapshot` 与 `POST /api/action` 使用 `crypto.timingSafeEqual` 进行定常时间 Token 校验，支持一键轮换并立即作废旧令牌。
- **弱依赖软聚合**：可选消费 `context`、`usage`、`quota` 服务的 `getMobileSnapshot()`；缺失任意插件时该面板降级为 `{ available: false }`，其余通道与 PWA 仍完整可用。
- **Cloudflare 校验**：内置 Connector Base64 (`a/t/s`) / 3 段 JWT Token 校验与 HTTPS 域名防误填校验（拦截 `*.cloudflareaccess.com`、`dash.cloudflare.com`、`*.trycloudflare.com`）。

```sh
npm test
```
