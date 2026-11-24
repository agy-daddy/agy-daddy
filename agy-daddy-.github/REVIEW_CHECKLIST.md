English | [简体中文](./REVIEW_CHECKLIST_zh.md)

# Plugin Review Checklist (`T1` Community Review)

This checklist governs the security, isolation, compatibility, and quality review for community plugins applying for **`T1` (Community Reviewed)** trust status in `agy-daddy-registry` and for significant changes to existing registered plugins.

> Every checkbox below must be verified with concrete evidence (code inspection, test output, or SHA-512 output) before a `T1` listing PR is approved.

---

## Submission Metadata

| Field | Value |
|---|---|
| **Plugin ID** | `<publisher>.<name>` |
| **Version** | `x.y.z` (SemVer) |
| **Repository / Commit SHA** | `https://github.com/...` (`<commit-sha>`) |
| **Target Trust Level** | `T1` (Community Reviewed) |
| **Manifest SHA-512** | `sha512-...` |
| **Reviewer(s)** | `@maintainer` |

---

## 1. Least-Privilege Permissions & Trust Policy

- [ ] **Minimal `permissions` declaration**: Every permission in `agy-plugin.json` is strictly required by a documented user-facing feature; unused or speculative permissions are removed.
- [ ] **`T1` restricted permissions excluded**: `agy-plugin.json` does **not** request `page:main-world`, `process:spawn`, `host:launch-args`, `host:control`, or `rpc:write` (`T1_RESTRICTED_PERMISSIONS` are denied by default under `evaluateTrustPolicy` unless a dedicated security waiver is explicitly granted and documented).
- [ ] **High-risk permissions justified**: Any high-risk permission (`fs:user-files`, `net:listen`, `native:install`) has a documented threat boundary in the plugin README and fails safely if denied by the user.
- [ ] **Implicit default respected**: Storage within the plugin's own data directory uses the implicit `fs:plugin-data` scope without requesting broader `fs:user-files` access unnecessarily.

## 2. Outbound Network & Data Privacy

- [ ] **Explicit `net:outbound:<domain>` scoping**: Wildcard `net:outbound:*` is avoided; only exact, required hostnames are declared.
- [ ] **Transparent disclosure**: If `net:outbound:<domain>` is declared, both the plugin README and its `settings.schema.json` descriptions explicitly state **what data is sent**, **to which domain(s)**, and **for what purpose**.
- [ ] **Opt-in by default**: Any feature that performs outbound network requests defaults to **disabled** (`"default": false`) until explicitly enabled by the user.
- [ ] **Credential protection**: All tokens, passwords, or API keys in `settings.schema.json` set `"secret": true` and `"writeOnly": true` so the host redacts stored values from renderer state.

## 3. Sandbox Isolation & Zero-Patch Guarantee

- [ ] **Isolated world enforced**: `agy-plugin.json` declares `"world": "isolated"` and does not include `"page:main-world"`.
- [ ] **No hidden global escapes**: Isolated-world renderer scripts do not access `window.__APP_CONFIG__`, React fiber internals (`__reactFiber$`, `__reactProps$`), Electron `ipcRenderer` internals, or unapproved host globals.
- [ ] **Zero-patch compliance**: The plugin never reads, modifies, unpacks, or patches `app.asar`, `Antigravity.app`, or any Antigravity binary/installation file.
- [ ] **Zero runtime dependencies**: `package.json` contains no third-party runtime `"dependencies"` (`dependencies` is absent or `{}`).
- [ ] **No deprecated/removed APIs**: Manifest does not declare `contributes.migrations`, and source code does not invoke removed host APIs (such as `registerSection`).

## 4. Lifecycle Hygiene & Zero Resource Leaks

- [ ] **Complete `dispose()` cleanup**: Unloading or disabling the plugin removes all injected DOM nodes, `ShadowRoot` containers, DOM/window event listeners, `setTimeout`/`setInterval` timers, `MutationObserver`/`ResizeObserver` instances, and four-realm bus subscriptions.
- [ ] **Automated disposal verification**: Unit tests exercise `mount()` → active usage → `unloadPlugin()` and pass `harness.assertCleanDispose(pluginId)` via `@agy-daddy/host/sdk` (`mock-harness.js`).
- [ ] **Idempotent re-mount**: Re-enabling or reloading the plugin after `dispose()` works cleanly without duplicate listeners or stale state.

## 5. Visual Theme Consistency & Surface Decoupling

- [ ] **Purple theme gate passed**: Static scan finds zero forbidden hardcoded colors (`#10b981`, `#34d399`, `#059669`, `#38bdf8`, `#7dd3fc`, `#0369a1`, `#0c4a6e`, `#fb923c`, `#c2410c`).
- [ ] **Accent token contract followed**: Accent colors use `var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))` and adapt seamlessly across light mode, dark mode, and all 5 preset highlight accents.
- [ ] **Surface & anchor decoupling**: Extensions mount via `contributes` (`topbar.units`, `topbar.popovers`, `settings`, `settings.pages`, `commands`, `keybindings`, `locales`) or `ctx.surfaces.mount(...)` (`composer.quickActions`, `chat.search`, `chat.navButtons`, `remote.panels`, `remote.actions`) and reference only named anchors in `anchors.json` instead of brittle hardcoded class chains.

## 6. Versioning, Integrity & Compatibility

- [ ] **Valid SemVer & engine constraints**: `version` is a valid SemVer string, `engines.agyDaddy` matches `^1.0.0` (or the target host API), and `engines.antigravity` is declared when DOM anchors are used.
- [ ] **Manifest & tarball SHA-512 verified**: `sha512-<base64>` digest matches the exact `agy-plugin.json` bytes (and release tarball if distributed externally):
  ```sh
  node -e 'const fs=require("fs"),c=require("crypto");console.log("sha512-"+c.createHash("sha512").update(fs.readFileSync("agy-plugin.json")).digest("base64"));'
  ```
- [ ] **CI & fixture compatibility green**: Reusable CI workflows (`plugin-ci.yml`, `anchors-matrix.yml`, `release.yml`) and `npm test` (with `AGY_DADDY_TEST_MODE=1`) pass with zero skipped assertions.

## 7. Licensing & Upstream Attribution

- [ ] **OSI-approved license**: Package includes a valid `LICENSE` file (MIT preferred) matching `package.json` and `agy-plugin.json`.
- [ ] **Upstream `NOTICE` preserved**: Any adapted code, prompt rules, or localization dictionaries include complete upstream attribution in `NOTICE` and comply with [`LICENSE_AUDIT.md`](./LICENSE_AUDIT.md).

---

## Review Decision & Sign-Off

- **Outcome**: `[ ] Approved for T1` / `[ ] Changes Requested` / `[ ] Rejected`
- **Special Permission Waivers (if any)**: `None` *(or list approved restricted permissions and justification)*
- **Verification Evidence**: Link to CI run / local `npm run verify` output
- **Notes**:
