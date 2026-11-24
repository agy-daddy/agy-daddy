English | [简体中文](./LICENSE_AUDIT_zh.md)

# Open Source License & Upstream Attribution Audit (`LICENSE_AUDIT`)

> **Audit Status**: Audited against baseline `antigravity-suite@c349284`, `upstreams.json`, and all split monorepo packages. **Pre-release gate**: Prior to public release, obtain explicit written attribution sign-off from the primary authors of the referenced upstream repositories.

---

## 1. Audit Scope & Objectives

This document tracks the open-source license compliance, upstream copyright attributions, clean-room exclusions, and per-package legal inventory across the `agy-daddy` monorepo. Every component derived from or inspired by upstream community projects is audited to verify:

1. **License Compatibility**: All packages and upstream sources use permissive OSI-approved licenses (MIT).
2. **Copyright & Notice Preservation**: Original copyright headers and `NOTICE` attributions are preserved alongside `Copyright (c) 2026 Agy-Daddy Contributors`.
3. **Clean-Room Boundaries**: Binary patching, `app.asar` modification, unlock scripts, and unlicensed assets are strictly excluded.

---

## 2. Upstream Attribution & License Matrix

| Upstream Component / Repository | Version / Baseline | License | Audit Status & Target Package(s) | Scope & Clean-Room Notes |
|---|---|---|---|---|
| [`iamvicliu/antigravity-suite`](https://github.com/iamvicliu/antigravity-suite) | `c349284` | MIT (`Antigravity Context Viewer Contributors`) | `LICENSE` + `NOTICE` retained across host & split plugins | All derived packages preserve the original MIT copyright line alongside `Agy-Daddy Contributors`. |
| [`elviscjn-cjn/antigravity-context-viewer`](https://github.com/elviscjn-cjn/antigravity-context-viewer) | `v0.8.9` | MIT | Attributed in `context` / `usage` / `quota` `NOTICE` | All `app.asar` patching and unlock code has been completely stripped. |
| [`akelabs/antigravity-pulse`](https://github.com/akelabs/antigravity-pulse) | `v1.3.2` | MIT | Attributed in `context` `NOTICE` | Adopted strictly for bottom pulse capsule UI and rate calculation logic. |
| [`n2ns/antigravity-panel`](https://github.com/n2ns/antigravity-panel) | `v2.8.5` | MIT | Attributed in `quota` / `composer` `NOTICE` | Refactored to enforce secure default-off settings and isolated-world execution. |
| [`yiheng8023/antigravity-chinese`](https://github.com/yiheng8023/antigravity-chinese) | `v3.3.57` | MIT + VS Code [`microsoft/vscode-loc`](https://github.com/microsoft/vscode-loc) (MIT) | Attributed in `zh-cn` `NOTICE` | Unlicensed Traditional Chinese (`zh-TW`) dictionary explicitly excluded; 8 newly added locales (`zh-TW`, `ja`, `ko`, `es`, `pt`, `fr`, `ru`, `it`) are 100% original MIT-licensed translations by `Agy-Daddy Contributors`. |
| [`wycocoyu/agy-context-dashboard`](https://github.com/wycocoyu/agy-context-dashboard) | `v0.9.5` | MIT | Audited (metrics layout deduplication reference) | Used solely as a reference to deduplicate metric layouts; no direct copied code conflict. |
| [`oil-oil/agy-fast-io`](https://github.com/oil-oil/agy-fast-io) | `v0.2.1` | MIT | Attributed in `composer` `NOTICE` | Native rule file placed at [`agy-daddy-plugin-composer/native/fast-io-AGENTS.md`](../agy-daddy-plugin-composer/native/fast-io-AGENTS.md). |

---

## 3. Monorepo Package License & Notice Inventory

| Package Directory | Declared License | `LICENSE` File | `NOTICE` File | Provenance |
|---|---|---|---|---|
| `agy-daddy-host/` | MIT | Present | Present | Derived from `antigravity-suite@c349284` + original Thin Declarative Host by `Agy-Daddy Contributors` |
| `agy-daddy-plugin-proxy/` | MIT | Present | Present | Derived from `antigravity-suite` (`meter-proxy.js`) |
| `agy-daddy-plugin-zh-cn/` | MIT | Present | Present | Derived from `antigravity-suite`, `antigravity-chinese`, `vscode-loc` + 8 original locales by `Agy-Daddy Contributors` |
| `agy-daddy-plugin-cli/` | MIT | Present | Present | Derived from `antigravity-suite` (`meter-cli-launcher.js`, `meter-terminals.js`) |
| `agy-daddy-plugin-context/` | MIT | Present | Present | Derived from `antigravity-suite`, `antigravity-context-viewer`, `antigravity-pulse` |
| `agy-daddy-plugin-usage/` | MIT | Present | Present | Derived from `antigravity-suite`, `antigravity-context-viewer` |
| `agy-daddy-plugin-chat-nav/` | MIT | Present | Present | Derived from `antigravity-suite` (`ag-enhancer-overlay.js`) |
| `agy-daddy-plugin-quota/` | MIT | Present | Present | Derived from `antigravity-suite`, `antigravity-context-viewer`, `antigravity-panel` |
| `agy-daddy-plugin-composer/` | MIT | Present | Present | Derived from `antigravity-suite`, `antigravity-panel`, `agy-fast-io` |
| `agy-daddy-plugin-remote/` | MIT | Present | Present | Derived from `antigravity-suite` (`mobile-remote.js`) |
| `agy-daddy-plugin-web/` | MIT | *Pending standalone file* | N/A (original) | Original work by `Agy-Daddy Contributors` (`"license": "MIT"` in `package.json` & `agy-plugin.json`); add standalone `LICENSE` before public release |
| `agy-daddy-plugin-template/` | MIT | Present | N/A (original) | Original starter template by `Agy-Daddy Contributors` |
| `agy-daddy-registry/` | MIT | Present | N/A (original) | Original registry index and DOM fixtures by `Agy-Daddy Contributors` |

---

## 4. Clean-Room & Exclusion Policy

1. **Zero Binary / ASAR Modification**: Any upstream code that patches `app.asar`, modifies Electron resources, or unlocks proprietary client restrictions is strictly prohibited and removed during integration.
2. **Exclusion of Unlicensed Assets**: Third-party dictionaries, icons, or snippets lacking a verifiable OSI-approved license (such as the excluded `zh-TW` dictionary in `antigravity-chinese`) must never be imported. Replacement assets must be authored from scratch under MIT.
3. **Runtime Dependency Isolation**: Core packages ship with zero third-party runtime dependencies (`"dependencies": {}`). Frontend build toolchains (`vite`, `preact`, `react`, `typescript`, `vitest`) in `agy-daddy-plugin-remote/web` and `agy-daddy-plugin-web/web` are confined strictly to `devDependencies` and compiled into static `dist/web/` bundles.

---

## 5. Ongoing Audit & Pre-Release Checklist

Before tagging a public release (`v1.x.y`) or merging new upstream-derived code:

- [ ] Confirm written attribution acknowledgment from primary upstream repository authors (pre-release blocker noted above).
- [ ] Ensure every new or modified package includes an accurate `LICENSE` file (including adding `agy-daddy-plugin-web/LICENSE`).
- [ ] Update the corresponding package `NOTICE` file and this `LICENSE_AUDIT.md` matrix whenever new upstream code or inspiration is incorporated.
- [ ] Verify `npm run verify:gates` passes to confirm zero unapproved runtime dependencies across all packages.
