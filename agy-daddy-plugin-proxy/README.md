# @agy-daddy/plugin-proxy

Agy-Daddy Layer-1 官方插件：本地固定转发代理网关（默认 `127.0.0.1:18766`）。

## 核心能力
- 一次通过宿主启动参数钩子注入 `--proxy-server=http://127.0.0.1:18766` 与 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`。
- 运行期免重启热切换 `DIRECT` 与上游 `http://` / `https://` / `socks5://` / `socks5h://` 代理及 `NO_PROXY` 绕过规则。
- 零第三方依赖 RFC 1928 / RFC 1929 SOCKS5 客户端、HTTP 转发与 `CONNECT` 隧道代理。
- `loginShellEnv`（`zsh -ilc`）代理冲突检测、分层连通性探测与独立 `launchd` `KeepAlive=true` plist 模板生成。

## 测试
```sh
npm test
```
