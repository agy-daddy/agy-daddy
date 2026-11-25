English | [简体中文](./release-engineering.zh-CN.md)

# Agy-Daddy Release Engineering Plan

This document defines the standardized production release system for the Agy-Daddy Monorepo (the microkernel host `@agy-daddy/host`, 10 `T0` official plugins, the template `@agy-daddy/plugin-template`, and the registry `@agy-daddy/registry`), covering build processes, quality gates, CI/CD automated publishing, rollback mechanisms, and health checks.

---

## 1. Environment & Credential Isolation

### 1.1 Multi-Environment Channel Matrix

| Environment (`RELEASE_ENV`) | Target Scenario | npm `dist-tag` | Trigger Source | Authentication & Provenance Mechanism | Approval Gate |
|---|---|---|---|---|---|
| `development` | Local rehearsal, local Verdaccio integration | `dev` | Local manual / `--dry-run` | Local `npm login` or unauthenticated | None |
| `staging` | Staging / canary grayscale validation | `next` | `vX.Y.Z-rc.N` tag or `workflow_dispatch(staging)` | Pure OIDC Trusted Publishing (automatically includes Provenance) | GitHub Environment `npm-release` |
| `production` | Official production release | `latest` | `vX.Y.Z` / `<pkg>@X.Y.Z` official tag or `workflow_dispatch(production)` | Pure OIDC Trusted Publishing (automatically includes Provenance) | GitHub Environment `npm-release` (Required Reviewers configurable) |

### 1.2 Environment Variables and Sensitive Credential Specifications

All release-related environment variable templates are defined in the root [`.env.release.example`](../.env.release.example) (the local override file `.env.release.local` and snapshot directory `.release-artifacts/` are ignored in `.gitignore` and must never be committed):

- **Pure OIDC Tokenless Authentication (CI Default)**: The `publish-npm` job in `release.yml` uses the GitHub Environment `npm-release` with `permissions: { id-token: write }` and requires `npm >= 11.5.1`. During execution, `NODE_AUTH_TOKEN` and `NPM_TOKEN` are explicitly stripped (omitting `registry-url` in `setup-node` to avoid generating placeholder token configs). GitHub OIDC and npm Trusted Publishing directly exchange ephemeral publishing credentials and automatically attach cryptographic Provenance signatures.
- **Initial Version Manual Interactive 2FA**: Before newly created packages exist on npmjs.com, Trusted Publisher cannot be configured. An initial interactive 2FA publication must be performed locally via `npm login` and `node scripts/release.js publish --env production --target all --execute --interactive`. Subsequently, configure **Settings → Trusted Publisher** on npmjs.com for each package, binding `agy-daddy/agy-daddy` + `release.yml` + `npm-release`.
- **Build-Time Configuration**: `VITE_PUBLIC_BASE` (controls the public path for frontend static assets, default `/`), `VITE_SOURCEMAP` (defaults to `false` in production to prevent source code exposure).
- **Zero External Runtime Dependency Constraint**: All 13 publishable packages must keep `dependencies` completely empty (`dependencies: {}`). Build-time tooling (Vite, TypeScript, Vitest) is strictly isolated within the `devDependencies` of `agy-daddy-plugin-remote/web` and `agy-daddy-plugin-web/web`.

---

## 2. Build & Bundle Optimization

### 2.1 Host and Plugin Build Stratification

1. **Host Renderer Bundle (`@agy-daddy/host`)**: `scripts/build-renderer.js` aggregates and compiles `src/renderer/{styles.css,lightdom-styles.css,theme.js,host-runtime.js}` into `dist/host-renderer.js` and validates syntax via `vm.Script`. `agy-daddy-host/package.json` configures `"prepublishOnly": "npm run build:renderer"` to prevent publishing without an up-to-date `dist/host-renderer.js`.
2. **Web UI Static Assets (`plugin-remote/web` & `plugin-web/web`)**:
   - **Code Minification and Chunk Splitting**: `vite.config.ts` enables `minify: 'esbuild'`, `cssMinify: true`, and `target: 'es2022'`. `xterm`, `preact-vendor` (Remote PWA), and `react-vendor` (PC Web Harness) are split into dedicated vendor chunks, leveraging route-level code splitting and lazy loading for incremental browser caching.
   - **Static Asset Hashing (Cache Busting)**: Explicitly outputs `assets/[name]-[hash].js` and `assets/[name]-[hash][extname]`. All `assets/*` files served by `pwa-server.js` and `web-server.js` return `Cache-Control: public, max-age=31536000, immutable`, while entry `index.html`, `sw.js`, and all `/api/v1/*` endpoints strictly enforce `Cache-Control: no-store`.
3. **Tarball Whitelist Slimming**: All 13 publishable packages configure a `"files"` whitelist and `"publishConfig": { "access": "public" }`, completely excluding `test/`, `web/src/`, `web/node_modules/`, and other development files, strictly verified by Gate 8 of `npm run verify:gates`.
4. **Bundle Size Analysis**: Running `npm run analyze` reports raw and Gzip sizes for `host-renderer.js` and all Web UI chunks (triggering budget alerts if any single JS chunk exceeds `250 KB` Gzip), and runs `npm pack --dry-run --json` leak detection across all 13 subpackages.

### 2.2 Static Asset CDN/OSS Deployment & Path Fallback Strategy

- **External CDN/OSS Injection**: Building the frontend UI with `VITE_PUBLIC_BASE=https://cdn.example.com/agy-daddy/remote/` (or an object storage static hosting subpath) automatically rewrites the asset prefix for `index.html` and asynchronous chunks. Simultaneously upload `dist/web/assets/` to CDN/OSS while serving `index.html` from the origin or behind a short-TTL cache.
- **Zero-Config Local Fallback**: When `VITE_PUBLIC_BASE` is omitted (default `/`), assets reference the same-origin `/assets/*` path served directly by the built-in `pwa-server.js` / `web-server.js` offline or on localhost. If the CDN becomes unavailable, rebuilding without `VITE_PUBLIC_BASE` provides a painless, immediate fallback.

---

## 3. CI/CD Automated Pipelines

### 3.1 Continuous Integration (`.github/workflows/ci.yml`)

- **Concurrency Control**: New commits on the same branch/PR automatically cancel in-progress runs (`cancel-in-progress: true`).
- **`verify` Job**: Executes `npm run verify` (build + 8 static/registry quality gates + all unit tests across packages and scripts) and `npm run analyze`, outputting bundle size and package manifests directly to the GitHub Actions Step Summary.
- **`web-ui-checks` Job**: Uses a parallel matrix to validate `agy-daddy-plugin-remote/web` and `agy-daddy-plugin-web/web` through `npm ci` -> `typecheck` -> `vitest` -> `vite build`.

### 3.2 Continuous Delivery (`.github/workflows/release.yml`)

- **Dual Trigger Mechanism**:
  - **Tag-Driven**: Pushing coordinated full-release tags `vX.Y.Z` (with `-rc.N` automatically routed to `staging`) or single-package tags `host@X.Y.Z`, `plugin-<name>@X.Y.Z`, `registry@X.Y.Z`.
  - **Manual Run/Rehearsal (`workflow_dispatch`)**: Selectable `staging` / `production`, target scope (`all` or specific package/tag), defaulting to `dry_run: true` to prevent accidental execution.
- **4-Stage Pipeline**:
  1. `preflight-verify`: Web UI build validation + `npm run verify` + `scripts/release.js plan` version and `registry.json` SHA-512 consistency checks.
  2. `pack-snapshot`: Runs `scripts/release.js pack` to generate all `.tgz` archives and `release-manifest.json` containing `sha512` checksums, uploaded as a GitHub Artifact snapshot retained for 30 days.
  3. `publish-npm`: Binds to the single GitHub Environment `npm-release` with `id-token: write`, verifies `npm >= 11.5.1`, strips `NODE_AUTH_TOKEN` / `NPM_TOKEN`, and performs idempotent publishing with `npm publish --access public --tag <distTag>` via pure OIDC Trusted Publishing (automatically generating Provenance).
  4. `post-release-verify`: Executes local and remote npm metadata health checks. Upon successful tag-based release, automatically generates a GitHub Release with `release-manifest.json` attached.

### 3.3 Initial Interactive 2FA Release & Trusted Publishing Binding

1. **Initial 1.0.0 Local Interactive Release** (creating 13 packages):
   ```bash
   npm login
   npm run verify
   node scripts/release.js publish --env production --target all --execute --interactive --skip-verify
   ```
2. **Bind Trusted Publisher**: On npmjs.com, navigate to `https://www.npmjs.com/package/<encoded-name>/access` for each of the 13 packages, select **GitHub Actions**, and provide:
   - Organization or user: `agy-daddy`
   - Repository: `agy-daddy`
   - Workflow filename: `release.yml`
   - Environment name: `npm-release`
3. **Subsequent Pure OIDC Automated Releases**: Once `npm-release` is created in GitHub Repository Settings → Environments, pushing a tag (e.g., `v1.0.1`) or manually triggering `Release & Publish npm Packages` will publish automatically without requiring `NPM_TOKEN`.

---

## 4. Release Reliability, Rollback & Monitoring

### 4.1 Phased Rollout (Canary `next` -> Production `latest`)

1. Push a pre-release tag (e.g., `v1.1.0-rc.1`) or select `environment=staging, dry_run=false` in GitHub Actions to publish to the `next` channel;
2. Early adopters test via `npm install -g @agy-daddy/host@next` and `agy-daddy plugin install npm:@agy-daddy/plugin-proxy@next`;
3. Once verified stable, merge the release and push `v1.1.0` (or trigger `workflow_dispatch` selecting `production`) to promote to `latest`.

### 4.2 Version Snapshot & Rapid Rollback

Because npm prohibits overwriting or unpublishing packages after a grace window, rollback uses a **"second-level dist-tag pointer switch + deprecation marking for problematic versions"** strategy:

```bash
# 1. Preview rollback commands (default dry-run)
node scripts/release.js rollback --env production --target all --to-version 1.0.0 --deprecate-version 1.0.1

# 2. Execute rollback (points latest back to 1.0.0 and marks 1.0.1 deprecated)
node scripts/release.js rollback --env production --target all --to-version 1.0.0 --deprecate-version 1.0.1 --execute
```

Additionally, every release records the git commit, tarball filename, and `sha512` in `release-manifest.json`, enabling offline restoration or republishing directly from GitHub Artifact snapshots.

### 4.3 Health Checks & Monitoring Alerts

- **Local Baseline Health Check**: `npm run release:healthcheck` (i.e. `node scripts/release.js healthcheck --mode local`) validates `host-renderer.js` compilation syntax, both `dist/web/index.html` files, the `registry.json` matrix, and `agy-daddy doctor --json`.
- **Post-Release Remote Check**: `node scripts/release.js healthcheck --mode npm --env <env> --target <target> --retries 6 --retry-delay-ms 5000` verifies that target versions appear on the npm registry, corresponding `dist-tag` pointers are accurate, and `dist.integrity` is present.
- **Failure Alerts**: If `post-release-verify` fails, `release.yml` prints the exact `rollback` command and automatically dispatches structured JSON alerts to external notification endpoints when `secrets.RELEASE_ALERT_WEBHOOK_URL` is configured.

---

## 5. Pre-Release Checklist

- [ ] **Initial Release & Trusted Publishing Binding**: All 13 packages have completed their initial `1.0.0` interactive release, each package's **Settings → Trusted Publisher** on npmjs.com is configured for `GitHub Actions` (Owner: `agy-daddy`, Repository: `agy-daddy`, Workflow: `release.yml`, Environment: `npm-release`), and `npm-release` is created under GitHub Repository Settings → Environments (no extraneous `NPM_TOKEN`, optional manual approval enabled).
- [ ] **Version and Hash Synchronization**: If any plugin's `agy-plugin.json` was modified, `version` and `manifestSha512` in `agy-daddy-registry/registry.json` have been synchronized.
- [ ] **Frontend Static Builds**: After modifying source code in `plugin-remote/web` or `plugin-web/web`, `npm run typecheck && npm test && npm run build` has been executed to refresh precompiled assets.
- [ ] **Complete Quality Gates and Size Checks**: Ran `npm run verify` in the repository root (all 8 gates passing, `Failed: 0` tests) and `npm run analyze` (confirmed no `test/` or `web/src/` leaks in tarballs).
- [ ] **Local Release Rehearsal**: Both `npm run release:plan -- --env staging --target all` and `npm run release:dry-run -- --env production --target all` succeed.
- [ ] **Canary & Health Validation**: Deploy to `staging (next)` first and execute `node scripts/release.js healthcheck --mode npm --env staging`. Once validated, push the official tag to publish to `production (latest)`.
