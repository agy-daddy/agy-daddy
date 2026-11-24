# Agy-Daddy 生产发布工程化方案（Release Engineering）

本文档定义 Agy-Daddy Monorepo（底座 `@agy-daddy/host`、10 个 `T0` 官方插件、模板 `@agy-daddy/plugin-template` 与注册表 `@agy-daddy/registry`）从构建、门禁、CI/CD 自动化发布到回滚与健康检查的标准化生产发布体系。

---

## 1. 环境与凭证隔离

### 1.1 多环境通道矩阵

| 环境 (`RELEASE_ENV`) | 适用场景 | npm `dist-tag` | 触发来源 | Provenance 溯源签名 | 审批门禁 |
|---|---|---|---|---|---|
| `development` | 本地预演、本地 Verdaccio 联调 | `dev` | 本地手动 / `--dry-run` | 关闭 | 无 |
| `staging` | 预发布 / 金丝雀灰度验证 | `next` | `vX.Y.Z-rc.N` tag 或 `workflow_dispatch(staging)` | 关闭（可按需开启） | GitHub Environment `staging` |
| `production` | 正式生产发布 | `latest` | `vX.Y.Z` / `<pkg>@X.Y.Z` 正式 tag 或 `workflow_dispatch(production)` | 开启 (`--provenance`) | GitHub Environment `production`（建议配置 Required Reviewers） |

### 1.2 环境变量与敏感凭证规范

所有发布相关环境变量模板定义在根目录 [`.env.release.example`](../.env.release.example)（本地覆盖文件 `.env.release.local` 与快照目录 `.release-artifacts/` 均已在 `.gitignore` 中忽略，严禁提交）：

- **敏感凭证**：仅通过 GitHub Environment Secrets (`secrets.NPM_TOKEN`) 或本机环境变量 `NODE_AUTH_TOKEN` 注入，绝不写入 `package.json`、`.npmrc` 或脚本源码。生产环境启用 npm Trusted Publishing / OIDC (`id-token: write`) + `--provenance`。
- **构建期配置**：`VITE_PUBLIC_BASE`（控制前端静态资源公共路径，默认 `/`）、`VITE_SOURCEMAP`（生产默认 `false` 避免源码暴露）。
- **零外部运行依赖约束**：全部 13 个可发布子包的 `dependencies` 必须保持为空，构建期工具（Vite、TypeScript、Vitest）仅隔离在 `agy-daddy-plugin-remote/web` 和 `agy-daddy-plugin-web/web` 的 `devDependencies` 中。

---

## 2. 构建与打包优化

### 2.1 底座与插件构建分层

1. **底座渲染包（`@agy-daddy/host`）**：`scripts/build-renderer.js` 将 `src/renderer/{styles.css,lightdom-styles.css,theme.js,host-runtime.js}` 聚合编译为 `dist/host-renderer.js` 并通过 `vm.Script` 语法校验。`agy-daddy-host/package.json` 已配置 `"prepublishOnly": "npm run build:renderer"`，防止发布时遗漏未入库的 `dist/host-renderer.js`。
2. **Web UI 静态资源（`plugin-remote/web` & `plugin-web/web`）**：
   - **代码压缩与产物分包**：`vite.config.ts` 开启 `minify: 'esbuild'`、`cssMinify: true`、`target: 'es2022'`；将 `xterm`、`preact-vendor`（Remote PWA）与 `react-vendor`（PC Web Harness）拆分为独立 vendor chunk，配合页面级路由/懒加载组件实现增量缓存。
   - **静态资源哈希（Cache Busting）**：显式锁定 `assets/[name]-[hash].js` 与 `assets/[name]-[hash][extname]`，所有 `assets/*` 资源在 `pwa-server.js` 与 `web-server.js` 中统一返回 `Cache-Control: public, max-age=31536000, immutable`；入口 `index.html`、`sw.js` 与全部 `/api/v1/*` 接口严格保持 `Cache-Control: no-store`。
3. **Tarball 白名单瘦身**：13 个可发布子包均已配置 `"files"` 白名单与 `"publishConfig": { "access": "public" }`，彻底剔除 `test/`、`web/src/`、`web/node_modules/` 等开发文件，并通过 `npm run verify:gates` 第 8 项静态门禁强制校验。
4. **体积分析**：运行 `npm run analyze` 统计 `host-renderer.js` 及两个 Web UI 各 chunk 的原始/Gzip 体积（单 JS chunk Gzip 超 `250 KB` 触发预算告警），并执行全部 13 个子包的 `npm pack --dry-run --json` 泄露扫描。

### 2.2 静态资源 CDN/OSS 部署与路径回退策略

- **注入外部 CDN/OSS 路径**：构建前端 UI 时设置 `VITE_PUBLIC_BASE=https://cdn.example.com/agy-daddy/remote/`（或对象存储静态托管子路径），Vite 会自动重写 `index.html` 与异步 chunk 的资源前缀；同步将 `dist/web/assets/` 上传至 CDN/OSS 并保留 `index.html` 在源站或短 TTL 入口。
- **零配置本地回退**：若未设置 `VITE_PUBLIC_BASE`（默认 `/`），产物直接引用同源 `/assets/*`，由插件内置 `pwa-server.js` / `web-server.js` 离线或本地回环直接托管，CDN 不可用时只需不传 `VITE_PUBLIC_BASE` 重新构建即可无痛回退。

---

## 3. CI/CD 自动化流水线

### 3.1 持续集成（`.github/workflows/ci.yml`）

- **并发控制**：同一分支/PR 新提交自动取消旧流水线 (`cancel-in-progress: true`)。
- **`verify` Job**：执行 `npm run verify`（构建 + 8 项静态/注册表门禁 + 全量包与脚本单测）与 `npm run analyze`，将体积与包清单摘要写入 GitHub Actions Step Summary。
- **`web-ui-checks` Job**：通过 matrix 并行检验 `agy-daddy-plugin-remote/web` 与 `agy-daddy-plugin-web/web` 的 `npm ci` -> `typecheck` -> `vitest` -> `vite build`。

### 3.2 持续发布（`.github/workflows/release.yml`）

- **双触发机制**：
  - **Tag 驱动**：推送协调全量 tag `vX.Y.Z`（含 `-rc.N` 自动路由到 `staging`）或单包 tag `host@X.Y.Z`、`plugin-<name>@X.Y.Z`、`registry@X.Y.Z`。
  - **手动演练/发布 (`workflow_dispatch`)**：可选 `staging` / `production`、`target`（`all` 或指定包/tag），默认 `dry_run: true` 防误操作。
- **4 阶段流水线**：
  1. `preflight-verify`：Web UI 构建校验 + `npm run verify` + `scripts/release.js plan` 版本与 `registry.json` SHA-512 一致性检查。
  2. `pack-snapshot`：运行 `scripts/release.js pack` 生成全部 `.tgz` 与带 `sha512` 校验和的 `release-manifest.json`，上传为 30 天保留期的 GitHub Artifact 快照。
  3. `publish-npm`：绑定对应 GitHub Environment 与 `secrets.NPM_TOKEN`，幂等跳过已存在版本，执行 `npm publish --access public --tag <distTag>`（生产附加 `--provenance`）。
  4. `post-release-verify`：执行本地与远端 npm 元数据健康检查；Tag 正式发布成功后自动创建 GitHub Release 并附带 `release-manifest.json`。

---

## 4. 发布可靠性、回滚与监控告警

### 4.1 平滑发布（金丝雀 `next` -> 生产 `latest`）

1. 先打预发布 tag（如 `v1.1.0-rc.1`）或在 Actions 选择 `environment=staging, dry_run=false` 发布到 `next` 通道；
2. 内测用户通过 `npm install -g @agy-daddy/host@next` 与 `agy-daddy plugin install npm:@agy-daddy/plugin-proxy@next` 验证；
3. 确认稳定后合入正式版本并推送 `v1.1.0`（或通过 `workflow_dispatch` 选 `production`）晋升到 `latest`。

### 4.2 版本快照与快速回滚

由于 npm 不允许覆盖或删除已发布逾时的正式版本，回滚采用 **“dist-tag 指针秒级切回 + 异常版本 deprecate 标记”** 策略：

```bash
# 1. 预览回滚命令（默认 dry-run）
node scripts/release.js rollback --env production --target all --to-version 1.0.0 --deprecate-version 1.0.1

# 2. 实际执行回滚（将 latest 指回 1.0.0 并标记 1.0.1 弃用）
node scripts/release.js rollback --env production --target all --to-version 1.0.0 --deprecate-version 1.0.1 --execute
```

同时每次发布均在 `release-manifest.json` 留存 git commit、tarball 文件名与 `sha512`，支持从 GitHub Artifact 快照离线还原或重发。

### 4.3 健康检查与监控告警

- **本地基线检查**：`npm run release:healthcheck`（即 `node scripts/release.js healthcheck --mode local`）校验 `host-renderer.js` 编译语法、两个 `dist/web/index.html`、`registry.json` 矩阵及 `agy-daddy doctor --json`。
- **远端发布后检查**：`node scripts/release.js healthcheck --mode npm --env <env> --target <target> --retries 6 --retry-delay-ms 5000` 校验目标版本已进入 npm registry、对应 `dist-tag` 指针准确且 `dist.integrity` 存在。
- **失败告警**：`release.yml` 在 `post-release-verify` 失败时打印精确的 `rollback` 执行命令，并在配置了 `secrets.RELEASE_ALERT_WEBHOOK_URL` 时自动向外部通知端点发送结构化 JSON 告警。

---

## 5. 生产发布前执行清单（Checklist）

- [ ] **npm 组织与权限**：确认 npmjs.com 已创建 `@agy-daddy` 组织，并在 GitHub Repository Settings -> Environments 中分别配置 `staging` 与 `production`（附带 `NPM_TOKEN` Secret，生产建议开启人工审批）。
- [ ] **版本与哈希同步**：若修改过任何插件的 `agy-plugin.json`，已同步更新 `agy-daddy-registry/registry.json` 的 `version` 与 `manifestSha512`。
- [ ] **前端静态构建**：修改过 `plugin-remote/web` 或 `plugin-web/web` 源码后，已执行 `npm run typecheck && npm test && npm run build` 刷新预编译产物。
- [ ] **全量门禁与体积检查**：根目录运行 `npm run verify`（8 项 gate 全绿、测试 `Failed: 0`）与 `npm run analyze`（确认 tarball 无 `test/` / `web/src/` 泄露）。
- [ ] **本地发布预演**：运行 `npm run release:plan -- --env staging --target all` 与 `npm run release:dry-run -- --env production --target all` 均通过。
- [ ] **灰度与健康验收**：先发布 `staging (next)` 并执行 `node scripts/release.js healthcheck --mode npm --env staging`，确认无误后再推正式 tag 发布 `production (latest)`。
