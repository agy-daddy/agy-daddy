# Agy-Daddy Registry (`registry`)

官方与社区插件索引、完整性校验哈希与 Antigravity 多版本 DOM 锚点兼容矩阵：

- `registry.json`：9 个 `T0` 官方插件及其真实 `sha512` 清单摘要。
- `anchors.json` + `fixtures/antigravity-2.32.json` / `antigravity-2.33.json`：10 个具名锚点 × 版本兼容性回归夹具。

```sh
npm test
```
