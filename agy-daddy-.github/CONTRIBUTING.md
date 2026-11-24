English | [简体中文](./CONTRIBUTING_zh.md)

# Contributing to Agy-Daddy

Thank you for your interest in contributing to **Agy-Daddy**, the zero-patch Chrome DevTools Protocol (CDP) plugin host and open plugin ecosystem for Google Antigravity Desktop.

This guide defines the engineering principles, local development setup, end-to-end contribution workflow, testing and static gate standards, registry submission rules, and community Code of Conduct.

---

## Table of Contents

1. [Core Engineering Principles](#1-core-engineering-principles)
2. [Local Development Environment Setup](#2-local-development-environment-setup)
3. [Contribution Workflow](#3-contribution-workflow)
4. [Testing, Static Gates & Code Standards](#4-testing-static-gates--code-standards)
5. [Submitting a Community Plugin (`T1`)](#5-submitting-a-community-plugin-t1)
6. [Code of Conduct](#6-code-of-conduct)

---

## 1. Core Engineering Principles

All contributions to `@agy-daddy/host`, official plugins, and `agy-daddy-registry` must adhere to the following non-negotiable architectural rules:

1. **100% Zero-Patch Guarantee**: Never modify Antigravity's `app.asar`, application binaries, or installation bundle. All UI and runtime extensions operate strictly through CDP attachment and host-managed injection.
2. **Zero Third-Party Runtime Dependencies**: All core packages (`agy-daddy-host`, `agy-daddy-registry`, and every `agy-daddy-plugin-*` package) must keep `"dependencies": {}` empty in `package.json` and rely exclusively on Node.js (`>= 22.4.0`) built-in APIs.
   - *Build-time frontend exception*: `agy-daddy-plugin-remote/web` and `agy-daddy-plugin-web/web` use `devDependencies` (Vite, Preact/React, Vitest) solely to compile static assets into `dist/web/index.html`. Compiled outputs must remain self-contained and committed cleanly when updated.
3. **Least-Privilege Permissions & Sandbox Isolation**:
   - Every plugin must declare `"world": "isolated"` and must **never** request `"page:main-world"`.
   - High-risk permissions (`process:spawn`, `host:launch-args`, `host:control`, `rpc:write`, `fs:user-files`, `net:listen`, `native:install`, `net:outbound:<domain>`) must only be requested when strictly necessary and clearly justified.
   - Plugins must not declare legacy `"migrations"` in `contributes` or call the removed `registerSection` API.
4. **Declarative Contributions & Surface Decoupling**:
   - Prefer declarative `contributes` (`topbar.units`, `topbar.popovers`, `settings`, `settings.pages`, `commands`, `keybindings`, `locales`, `native`) and `ctx.surfaces` extension slots (`composer.quickActions`, `chat.search`, `chat.navButtons`, `remote.panels`, `remote.actions`) over ad-hoc DOM queries.
   - Keep `@agy-daddy/host` (`src/renderer/`) completely decoupled from plugin-specific selectors, IDs, or hardcoded labels.
5. **Theme Token Discipline (Purple Theme Gate)**:
   - Always use host theme CSS tokens for accent styling:
     ```css
     var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))
     ```
   - Never hardcode forbidden non-theme green, sky-blue, or orange colors (`#10b981`, `#34d399`, `#059669`, `#38bdf8`, `#7dd3fc`, `#0369a1`, `#0c4a6e`, `#fb923c`, `#c2410c`).
   - UI surfaces must adapt cleanly to both light and dark modes as well as all 5 preset accent colors.

---

## 2. Local Development Environment Setup

### 2.1 Prerequisites

- **Node.js `>= 22.4.0`** (must include native `WebSocket` and `fetch`).
- **Git** (configured with your GitHub SSH key or personal access token).
- **Google Antigravity Desktop** (optional for unit/contract tests, required for live CDP smoke testing).

### 2.2 Clone and Verify the Workspace

No root `npm install` is required:

```sh
git clone git@github.com:<your-username>/agy-daddy.git
cd agy-daddy
git remote add upstream https://github.com/agy-daddy/agy-daddy.git

# Verify node version and run the full build + gates + test suite
node -v
npm run verify
```

### 2.3 Linking Local Plugins for Live Development

Use the host CLI wrapper to link local monorepo plugins into your local runtime directory and verify environment readiness:

```sh
# Preview which plugins will be linked
./agy-daddy-host/bin/agy-daddy dev link-all --dry-run

# Link all local official plugins into the runtime directory
./agy-daddy-host/bin/agy-daddy dev link-all

# Link a single external or in-development plugin directory
./agy-daddy-host/bin/agy-daddy plugin link /path/to/your-plugin

# Run environment diagnostics and headless smoke checks
./agy-daddy-host/bin/agy-daddy doctor --json
./agy-daddy-host/bin/agy-daddy dev smoke
```

### 2.4 Optional Web UI Development (`plugin-remote` / `plugin-web`)

If you are editing frontend UI code inside `agy-daddy-plugin-remote/web/src` or `agy-daddy-plugin-web/web/src`:

```sh
cd agy-daddy-plugin-web/web   # or agy-daddy-plugin-remote/web
npm install                   # installs devDependencies only
npm run typecheck
npm test
npm run build                 # updates ../dist/web/index.html
```

> **Note**: Do not commit `node_modules/`. Ensure the updated static bundle under `dist/web/` is built and passes `npm run verify` from the repository root.

### 2.5 Scaffolding a New Plugin

New plugins should be generated from [`agy-daddy-plugin-template/`](../agy-daddy-plugin-template/) or programmatically via the SDK's `createPluginScaffold()` exported by [`agy-daddy-host/sdk/index.js`](../agy-daddy-host/sdk/index.js):

```sh
node -e '
  const { createPluginScaffold } = require("./agy-daddy-host/sdk");
  createPluginScaffold("./my-agy-plugin", {
    id: "your-publisher.my-plugin",
    publisher: "your-publisher",
    displayName: "My Plugin"
  });
'
```

---

## 3. Contribution Workflow

### Step 1: Issue Discussion & RFCs

- **Bug Fixes & Small Improvements**: Search existing issues and pull requests first. If none exist, open an issue describing the reproduction steps, expected vs. actual behavior, and environment (`node -v`, OS, Antigravity version, and `doctor --json` output with sensitive data redacted).
- **Host API, Permission, Anchor, or Surface Changes**: Before implementing breaking or architectural changes to `@agy-daddy/host` contracts, permissions, the 14 DOM anchors, or `ctx.surfaces`, open an RFC using [`rfcs/0000-template.md`](./rfcs/0000-template.md). Breaking changes require a deprecation window of at least one minor release (`>= 1` minor release) and a documented migration path.

### Step 2: Fork & Branch Naming

1. Fork `agy-daddy/agy-daddy` on GitHub and keep your `main` branch synced with `upstream/main`:
   ```sh
   git fetch upstream
   git checkout main
   git rebase upstream/main
   ```
2. Create a topic branch from `main`. Direct pushes to `main` are blocked. Use the following branch naming convention:

| Prefix | Purpose | Example |
|---|---|---|
| `feat/<scope>-<desc>` | New feature or plugin capability | `feat/proxy-socks5-auth` |
| `fix/<scope>-<desc>` | Bug fix or race condition guard | `fix/host-cdp-reconnect` |
| `docs/<scope>-<desc>` | Documentation or localization updates | `docs/github-contributing-i18n` |
| `refactor/<scope>-<desc>` | Internal refactor without semantic change | `refactor/context-pulse-helper` |
| `test/<scope>-<desc>` | Test coverage or fixture additions | `test/registry-anchor-234` |
| `chore/<scope>-<desc>` | Build, CI, or registry digest maintenance | `chore/registry-refresh-sha512` |

### Step 3: Commit Message Specification

All commits and PR titles must follow **[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/)**:

```text
<type>(<scope>): <imperative lowercase summary>

[optional body explaining why the change was made]

[optional footer(s), e.g., BREAKING CHANGE: ... or Refs: #123]
```

- **Allowed `<type>` values**:
  - `feat`: A new feature or contribution point
  - `fix`: A bug fix
  - `docs`: Documentation only changes
  - `refactor`: Code change that neither fixes a bug nor adds a feature
  - `perf`: Performance improvement
  - `test`: Adding or updating tests/fixtures
  - `build`: Changes affecting renderer/web build scripts
  - `ci`: Changes to GitHub Actions workflows or static gates
  - `chore`: Maintenance tasks (e.g., refreshing `manifestSha512`)
- **Common `<scope>` values**: `host`, `registry`, `sdk`, `proxy`, `zh-cn`, `cli`, `context`, `usage`, `chat-nav`, `quota`, `composer`, `remote`, `web`, `template`, `docs`, `ci`.
- **Breaking changes**: Append `!` after the scope (e.g., `feat(host)!: ...`) and include a `BREAKING CHANGE:` footer.
- **Examples**:
  ```text
  feat(proxy): support socks5 authentication credentials
  fix(host): guard cdp reconnect race on target close
  test(registry): add antigravity 2.34 anchor fixture
  chore(registry): refresh manifest sha512 for plugin-quota
  ```

### Step 4: Pull Request Submission & Review Process

1. **Keep PRs focused**: One logical change per PR. Avoid unrelated formatting edits or drive-by changes across untouched packages.
2. **Sync Derived Artifacts**:
   - If you modified `agy-daddy-host/src/renderer/`, run `npm run build` so `dist/host-renderer.js` is up to date.
   - If you modified any plugin's `agy-plugin.json`, recompute its SHA-512 digest and update `manifestSha512` in [`agy-daddy-registry/registry.json`](../agy-daddy-registry/registry.json):
     ```sh
     node -e 'const fs=require("fs"),c=require("crypto");console.log("sha512-"+c.createHash("sha512").update(fs.readFileSync("agy-plugin.json")).digest("base64"));'
     ```
   - If you modified DOM anchors, ensure `agy-daddy-host/data/anchors.json` and `agy-daddy-registry/anchors.json` remain byte-identical.
3. **Run Full Local Verification**: Run `npm run verify` and confirm zero errors or skipped assertions.
4. **Complete the PR Template**: Fill out [`.github/PULL_REQUEST_TEMPLATE.md`](../.github/PULL_REQUEST_TEMPLATE.md), linking related issues/RFCs and attaching screenshots or CLI outputs for UI/behavior changes.
5. **Code Review & Merge**:
   - GitHub Actions (`.github/workflows/ci.yml`) automatically runs `npm run verify` on Node `22.x`.
   - Maintainers review architecture alignment, permission scope, disposal hygiene, and test coverage.
   - Respond constructively to review comments; avoid force-pushing over active review history until requested.
   - Once approved and all checks are green, maintainers integrate the PR via **Squash Merge** into `main`.

---

## 4. Testing, Static Gates & Code Standards

### 4.1 Verification Commands

| Command | Scope | When to Run |
|---|---|---|
| `npm run verify` | Runs `build` + `gates` + `test` (CI equivalent) | Before every PR and after final edits |
| `npm run build` | Builds `agy-daddy-host/dist/host-renderer.js` (and `web/` UIs if `node_modules` exists) | After editing host renderer or web UI source |
| `npm run verify:gates` | Runs all 7 static and registry integrity gates | After editing manifests, schemas, anchors, or CSS/UI |
| `npm test` | Runs `npm test` across `host`, `registry`, and all plugins | During iterative development |

To run tests for a single package quickly:

```sh
cd agy-daddy-host   # or any agy-daddy-plugin-* / agy-daddy-registry
AGY_DADDY_TEST_MODE=1 node --test test/*.test.js
```

### 4.2 Static & Registry Gates Reference (`scripts/monorepo.js`)

The monorepo gate runner (`npm run verify:gates`) enforces 7 automated checks:

1. **Zero Runtime Dependencies**: Verifies `dependencies` is absent or empty (`{}`) in `package.json` across the root, host, registry, and all plugins.
2. **Removed Legacy Artifacts Check**: Ensures deleted legacy paths (`agy-daddy-host/plugins/legacy-suite`, `agy-daddy-host/src/core/migration.js`) are not reintroduced.
3. **Manifest & Settings Schema Validation**: Validates every `agy-plugin.json` against `validateManifest()`, enforces `world === "isolated"`, forbids `page:main-world` and `contributes.migrations`, and validates declared `settings.schema.json` files via `validateSettingsSchema()`.
4. **Plugin Purple Theme & API Gate**: Scans all files under plugin `src/` (plus `plugin-remote/web/src` and `plugin-web/web/src`) for removed `registerSection` references and the 9 forbidden hex colors.
5. **Host Renderer Decoupling & Theme Gate**: Ensures `agy-daddy-host/src/renderer/` contains no plugin-specific identifiers or forbidden hardcoded theme colors.
6. **Anchors Parity Check**: Verifies `agy-daddy-host/data/anchors.json` and `agy-daddy-registry/anchors.json` are byte-identical.
7. **Registry Integrity & Anchor Matrix**: Verifies every registered plugin's `manifestSha512` and validates all 14 named anchors against every Antigravity version fixture (`fixtures/antigravity-*.json`).

### 4.3 Code Conventions & Plugin Testing Standards

- **Module Format**: Core host and plugin files use CommonJS (`'use strict';`) with Node.js built-in modules (`node:fs`, `node:path`, `node:crypto`, `node:test`, `node:assert/strict`).
- **Clean Lifecycle Disposal**: Every plugin that registers DOM elements, timers, observers, or bus listeners must clean them up completely in `dispose()`. Test plugins using `createMockHostHarness()` and assert zero leaks with `harness.assertCleanDispose(pluginId)` from `@agy-daddy/host/sdk`.
- **Settings Security**: Mark tokens, passwords, and API keys with `"secret": true` and `"writeOnly": true` in `settings.schema.json` so the host redacts them via `redactWriteOnlySettings()`.
- **Localization**: Provide localized strings (`en` and `zh-CN` where applicable) in `displayName`, `commands`, and `settings.schema.json` fields.

---

## 5. Submitting a Community Plugin (`T1`)

Independent community plugins can apply for **`T1` (Community Reviewed)** listing in `agy-daddy-registry`:

1. **Bootstrap & Configure CI**: Use [`agy-daddy-plugin-template`](../agy-daddy-plugin-template/) and wire the reusable workflows from `agy-daddy-.github/.github/workflows/`:
   - `plugin-ci.yml`: Zero runtime dependencies, manifest check, purple theme gate, and `npm test`.
   - `anchors-matrix.yml`: Antigravity DOM fixture compatibility check.
   - `release.yml`: SHA-512 manifest integrity computation.
2. **Self-Audit with `REVIEW_CHECKLIST.md`**: Complete every item in [`REVIEW_CHECKLIST.md`](./REVIEW_CHECKLIST.md) and ensure `npm test` (including `assertCleanDispose`) passes.
3. **Prepare Attribution**: Include a `LICENSE` file (MIT recommended) and a `NOTICE` file if any logic or dictionary is derived from upstream projects (see [`LICENSE_AUDIT.md`](./LICENSE_AUDIT.md)).
4. **Submit Registry PR**: Open a Pull Request adding your plugin entry, version, repository URL, and `sha512-<base64>` manifest digest to `agy-daddy-registry`, attaching your completed `REVIEW_CHECKLIST.md`.

---

## 6. Code of Conduct

All contributors, maintainers, and reviewers are bound by the [**Contributor Covenant Code of Conduct**](./CODE_OF_CONDUCT.md).

- **Expected Behavior**:
  - Maintain a constructive, respectful, and harassment-free engineering environment across issues, pull requests, RFCs, and code reviews.
  - Focus technical feedback on code, architecture, security boundaries, and verifiable behavior rather than individuals.
  - Assume good faith, welcome newcomers, and provide actionable guidance during reviews.
- **Unacceptable Behavior**:
  - Harassment, derogatory remarks, personal attacks, trolling, or discriminatory language.
  - Publishing private information (doxxing) or credentials without authorization.
  - Submitting malicious code, obfuscated payloads, deceptive permission requests, or intentionally bypassing security/static gates.
- **Scope & Enforcement**: This Code of Conduct applies to all project repositories, issue trackers, PR reviews, and official community channels. Maintainers may warn, close/lock threads, or revoke contribution privileges for violations. To report unacceptable behavior privately, contact the repository maintainers via GitHub security advisories or private maintainer contact listed in the organization profile.
