# RFC-0001: Cross-Platform Native Transparent Overlay Window & Scoped Host API

- Feature Name: `desktop-overlay-window`
- Start Date: `2026-11-26`
- Target API Version: `^1.2.0` (backward-compatible with `^1.0.0`)

## Summary

Introduce an opt-in, permission-gated cross-platform transparent Always-on-Top desktop overlay capability (`host.overlay` API, `ui:desktop-overlay` permission, and `desktop.overlay` contribution point) in `@agy-daddy/host`. Following the zero-dependency helper architecture established by `src/core/tray-manager.js` and `src/core/tray-backends/`, `OverlayManager` lazily spawns a lightweight OS-native borderless transparent non-activating window helper on macOS (Swift `AppKit`/`CoreGraphics`), Windows (PowerShell STA + built-in `.NET` WPF + Win32 extended window styles), and Linux (`Python 3` + `GTK3` RGBA/`Cairo`), rendering declarative 2D vector rigs and static sprite frames without bundling third-party runtime dependencies or spawning heavy browser WebView processes.

---

## Motivation & Compatibility

### Why Existing Surfaces Do Not Cover This Use Case

1. **DOM Realm Boundary**: Renderer plugins execute strictly inside Antigravity's Chromium `isolated` world (`world: "isolated"`). Any DOM/Shadow DOM overlay mounted via `ctx.surfaces` or `document.body` is clipped to the Antigravity browser window and disappears whenever the user switches to a terminal, browser, or external editor, or hides Antigravity while working in `pc-web` (`agy-daddy-plugin-web`).
2. **System Tray Scope**: `host.tray` (`src/core/tray-manager.js`) provides OS menu bar / notification area icons and context menus, which cannot render animated 2D desktop companions, screen-edge roaming, or interactive speech/approval bubbles on the desktop work area.
3. **Memory & Dependency Constraints**: Spawning an Electron/WebView runtime per overlay window would violate Agy-Daddy's **Zero Third-Party Runtime Dependencies** rule (`"dependencies": {}`) or consume `80–150 MB` of resident WebContent memory. A thin declarative 2D vector/sprite protocol evaluated natively in AppKit/WPF/GTK3 keeps helper memory under `15–30 MB` and idle CPU below `0.2%`.

### Backward Compatibility & Migration

- **Additive Minor Bump (`1.0.0` → `1.2.0`)**: `HOST_API_VERSION` advances to `'1.2.0'`, which continues to satisfy `"agyDaddy": "^1.0.0"` in all existing official and community plugin manifests. No deprecation window is required because zero existing APIs, anchors, or permissions are altered or removed.
- **Zero Idle Cost**: `OverlayManager` spawns NO OS helper process until an enabled, permission-granted plugin invokes `host.overlay.createWindow()` and sets `visible: true`. Disabling or unloading the plugin immediately terminates the helper process.
- **Graceful Headless / Wayland Fallback**: In headless environments, SSH sessions, or Wayland compositors without XWayland/layer-shell support, `host.overlay.isSupported()` resolves `{ supported: false, reason: 'DISPLAY_UNAVAILABLE' }` without tripping the plugin fault circuit breaker, allowing dual-surface plugins (such as `agy-daddy.pet`) to continue serving `pc-web` and settings previews normally.

---

## Detailed Design & Security Boundaries

### 1. Contracts, Permissions & Trust Policy (`src/contracts/`)

1. **`STATIC_PERMISSIONS` & `HIGH_RISK_PERMISSIONS` (`src/contracts/constants.js`)**:
   - Add `'ui:desktop-overlay'` to `STATIC_PERMISSIONS` and `HIGH_RISK_PERMISSIONS`.
   - Do **not** add `'ui:desktop-overlay'` to `T1_RESTRICTED_PERMISSIONS`:
     - **`T0` (Official)**: Granted automatically in-process (`agy-daddy.pet`).
     - **`T1` (Community Reviewed)**: Granted with `needsConfirmation` surfaced in Customization Center; runs inside `plugin-worker.js` process isolation.
     - **`T2` (Unverified Local/Third-Party)**: Blocked (`denied`) until explicitly approved by the user in Customization Center.
2. **`CONTRIBUTION_POINTS` (`src/contracts/constants.js` & `manifest-validator.js`)**:
   - Add `'desktop.overlay'` to `CONTRIBUTION_POINTS`:
     ```json
     {
       "contributes": {
         "desktop.overlay": {
           "id": "pet-companion",
           "defaultWidth": 220,
           "defaultHeight": 200
         }
       }
     }
     ```
3. **Anti-Spoofing & Phishing Hardening Invariants (Enforced by Host `OverlayManager`)**:
   - **No Keyboard Focus Capture**: Every native backend MUST create a non-activating window (`NSPanel` `.nonactivatingPanel` on macOS, `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW` on Windows, `set_accept_focus(False)` on Linux). Overlay windows cannot receive keyboard events or render text inputs, preventing OS credential-dialog spoofing.
   - **Hard Dimension & Instance Caps**:
     - `maxWindowsPerPlugin = 1`
     - Logical bounds clamped to `64 <= width <= 360` and `64 <= height <= 360` px; coordinates clamped to intersect at least a `48×48` visible region of an active display's usable work area (`NSScreen.visibleFrame` / `SystemParameters.WorkArea` / `Gdk.Monitor.get_workarea()`).
   - **Update Rate Limiting**: `updateState()` coalesces patches per plugin to at most `4 Hz` (`minIntervalMs = 200`, immediate flush on `approval` or `dispose`), protecting the IPC pipe from JSON flood loops.
   - **Asset Path Confinement**: Any raster image path referenced in `setScene()` MUST resolve via `fs.realpathSync()` strictly inside the owning plugin's install directory (`pluginDir`) or its scoped data directory (`~/.agy-daddy/plugin-data/<pluginId>/`), and pass PNG/WebP/GIF magic-byte header checks (`<= 1 MB`, `<= 512×512 px`). Arbitrary filesystem paths and `http(s)://` URLs are rejected.

### 2. Scoped Host API (`sdk/index.d.ts`, `daemon.js`, `plugin-worker.js`)

```ts
export interface OverlaySupportInfo {
  supported: boolean;
  platform: NodeJS.Platform;
  backend: 'macos-appkit' | 'win32-wpf' | 'linux-gtk3' | 'memory' | 'none';
  reason?: string;
}

export interface OverlaySceneLayer {
  id: string;
  kind: 'path' | 'circle' | 'rect' | 'ellipse' | 'sprite';
  d?: string; // SVG path data subset: M, L, H, V, C, Q, Z (for kind === 'path')
  cx?: number; cy?: number; r?: number; rx?: number; ry?: number;
  x?: number; y?: number; width?: number; height?: number; cornerRadius?: number;
  spritePath?: string; // Confined local PNG/WebP/GIF path
  frameRects?: Array<{ x: number; y: number; w: number; h: number }>;
  fill?: string; // Hex (#RRGGBB / #RRGGBBAA) or palette ref; never CSS var() in native wire
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  pivotX?: number;
  pivotY?: number;
  motion?: {
    bobAmpY?: number;
    bobFreqHz?: number;
    swayAmpX?: number;
    swayFreqHz?: number;
    rotAmpDeg?: number;
    rotFreqHz?: number;
    phaseRad?: number;
    blinkIntervalMs?: number;
    states?: string[]; // Optional state filter; omitted = visible in all states
  };
}

export interface OverlaySceneSpec {
  sceneId: string;
  viewBox: { width: number; height: number };
  fps?: { active?: number; idle?: number; sleep?: number };
  hitBox: { x: number; y: number; width: number; height: number };
  layers: OverlaySceneLayer[];
  particles?: {
    preset: 'none' | 'bubbles' | 'sparks' | 'pixels' | 'stars' | 'matrix' | 'exhaust';
    color: string;
  };
}

export interface OverlayBubbleSpec {
  id: string;
  kind: 'approval' | 'reply' | 'error' | 'info';
  title: string;     // Truncated <= 48 chars by OverlayManager
  subtitle?: string; // Truncated <= 80 chars by OverlayManager
  badge?: string;    // e.g. "待审批 (2)" or "新回复"
  accentHex?: string;
  dismissible?: boolean;
}

export interface OverlayRuntimeState {
  animState: 'sleeping' | 'idle' | 'thinking' | 'walking' | 'trotting' | 'sprinting' | 'approval' | 'error';
  speedFactor: number; // Clamped [0.25, 4.0]
  tps?: number | null;
  roam: {
    enabled: boolean;
    mode: 'none' | 'bottom-edge' | 'screen-edges' | 'free-workarea';
    baseSpeedPxPerSec: number; // Clamped [0, 240]
  };
  scale?: number; // Clamped [0.6, 2.0]
  flipX?: boolean;
  statusPill?: { text: string; tone: 'neutral' | 'active' | 'warn' | 'danger' } | null;
  bubble?: OverlayBubbleSpec | null;
  contextMenu?: TrayMenuItemInput[];
}

export interface OverlayInteractionEvent {
  type: 'pet-click' | 'pet-double-click' | 'bubble-click' | 'bubble-dismiss' | 'menu-click' | 'position-changed';
  windowId: string;
  bubbleId?: string;
  itemId?: string;
  bounds?: { x: number; y: number; width: number; height: number; screenIndex?: number };
}

export interface OverlayWindowHandle {
  id: string;
  fullId: string;
  setScene(scene: OverlaySceneSpec): Promise<boolean>;
  updateState(patch: Partial<OverlayRuntimeState>): Promise<boolean>;
  setBounds(bounds: { x?: number; y?: number; width?: number; height?: number; anchor?: 'bottom-right' | 'bottom-left' }): Promise<boolean>;
  setVisible(visible: boolean): Promise<boolean>;
  onInteraction(handler: (event: OverlayInteractionEvent) => void): () => void;
  dispose(): Promise<boolean>;
}
```

- **Worker Realm Routing**: In `daemon.js` (`spawnWorkerPlugin`) and `plugin-worker.js`, `overlay.*` calls map to IPC actions `overlay:isSupported`, `overlay:createWindow`, `overlay:setScene`, `overlay:updateState`, `overlay:setBounds`, `overlay:setVisible`, and `overlay:dispose`, while native interaction events forward back to the worker via `{ type: 'overlay-interaction', windowId, event }` (matching the `tray-click` IPC pattern).
- **Clean Disposal**: `daemon.deactivatePlugin(pluginId)` and `mock-harness.unloadPlugin(pluginId)` invoke `overlayManager.disposePluginWindows(pluginId)`. `harness.assertCleanDispose(pluginId)` asserts `overlayManager.listPluginWindows(pluginId).length === 0`.

### 3. Native Helper Wire Protocol & Process Supervision

- **Isolation from System Tray**: `OverlayManager` runs in its own helper process (`src/core/overlay-manager.js` + `src/core/overlay-backends/`), completely decoupled from `TrayManager` so any graphics/driver fault never affects Host launcher or recovery menus.
- **Transport**:
  - **macOS (`darwin`)**: `0600` Unix Domain Socket `/tmp/agy-ovl-<pid>-<rand>.sock` (same pattern as `macos-tray.swift`), avoiding stdout buffering quirks and preventing other local users from injecting commands.
  - **Windows (`win32`) & Linux (`linux`)**: UTF-8 newline-delimited JSON (JSONL) over `stdin` (Host → Helper) and `stdout` (Helper → Host), `windowsHide: true`.
- **Lifecycle & Crash Safety**:
  - Every helper receives `--parent-pid <daemonPid>` and checks parent liveness every `2000ms` (`Darwin.kill(ppid, 0)` / `Process.GetProcessById` / `os.kill(ppid, 0)`), self-terminating immediately if the Node daemon exits abruptly (`SIGKILL`).
  - Crash loop circuit breaker mirrors `NativeTrayBackend`: exponential backoff (`300ms` → `8000ms`), halting auto-restart after `5` crashes within `60s` and emitting `overlay:backend-error@1` on `FourRealmBus`.
- **JSONL Command Messages (Host → Helper)**:
  - `{ "type": "upsert-window", "windowId": "...", "bounds": {...}, "visible": true }`
  - `{ "type": "set-scene", "windowId": "...", "scene": { ...OverlaySceneSpec } }`
  - `{ "type": "update-state", "windowId": "...", "state": { ...OverlayRuntimeState } }`
  - `{ "type": "remove-window", "windowId": "..." }`
  - `{ "type": "quit" }`
- **JSONL Event Messages (Helper → Host)**:
  - `{ "type": "ready", "platform": "darwin|win32|linux", "pid": 12345, "workArea": { "x": 0, "y": 25, "width": 1512, "height": 915 } }`
  - `{ "type": "interaction", "windowId": "...", "eventType": "bubble-click|bubble-dismiss|pet-click|pet-double-click|menu-click|position-changed", ... }`

### 4. Three-Platform Native Transparent Backends (`src/core/overlay-backends/`)

| Platform | Helper Source & Invocation | Windowing & Always-on-Top | Rendering & Click-Through Hit-Testing |
|---|---|---|---|
| **macOS 14+** | `macos-overlay.swift` compiled on demand via `/usr/bin/swiftc -O` into `<stateDir>/bin/AgyDaddyOverlay.app/Contents/MacOS/AgyDaddyOverlay` (`LSUIElement=true`, `NSHighResolutionCapable=true`, SHA-256 `swift-hash.txt` cache + ad-hoc `codesign`) | `NSPanel` subclass (`canBecomeKey=false`), `styleMask: [.borderless, .nonactivatingPanel]`, `isOpaque=false`, `backgroundColor=.clear`, `level=.floating`, `collectionBehavior=[.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]` | Custom `NSView` drawing cached `CGPath` (parsed from SVG `M/L/H/V/C/Q/Z`) + `NSImage` sprites + rounded HUD bubble card; overrides `hitTest(_:)` + `mouseMoved` `ignoresMouseEvents` so pixels outside `hitBox ∪ bubbleRect` pass clicks straight through to underlying apps; native `NSMenu` on right-click |
| **Windows 10/11** | `win32-overlay.ps1` via `powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File ...` (`windowsHide: true`, zero external DLLs) | Built-in `.NET` WPF `System.Windows.Window` (`WindowStyle=None`, `AllowsTransparency=true`, `Background=Transparent`, `Topmost=true`, `ShowInTaskbar=false`) + `user32.dll` `SetWindowLong` `WS_EX_TOOLWINDOW \| WS_EX_NOACTIVATE` | `DrawingVisual` / `Canvas` using cached `StreamGeometry.Parse(layer.d)` + `BitmapImage` sprites; `HwndSourceHook` intercepting `WM_NCHITTEST` (`0x0084`) and returning `HTTRANSPARENT` (`-1`) whenever cursor is outside `hitBox ∪ bubbleRect`; drag via `DragMove()` + `ContextMenu` |
| **Linux (X11 / XWayland)** | `linux-overlay.py` via `python3` (`gi.repository`: `Gtk 3.0`, `Gdk 3.0`, `GLib`, `cairo`, `Pango`, `GdkPixbuf` — identical dependency baseline to `linux-tray.py`) | `Gtk.Window(Gtk.WindowType.TOPLEVEL)` with `screen.get_rgba_visual()`, `set_app_paintable(True)`, `set_decorated(False)`, `set_keep_above(True)`, `set_skip_taskbar_hint(True)`, `set_accept_focus(False)` | `Gtk.DrawingArea` `draw` signal using `cairo` path commands + `GdkPixbuf` + `Pango` bubble text; updates `window.input_shape_combine_region(cairo.Region([hitRect, bubbleRect]))` whenever bubble visibility changes for 100% OS-level click-through; exits code `2` cleanly if display/RGBA visual unavailable |

---

## Verification Plan

1. **Manifest & Permission Unit Tests (`agy-daddy-host/test/manifest-and-trust.test.js`)**:
   - Assert `'ui:desktop-overlay'` validation, `T0` auto-grant, `T1` `needsConfirmation` + worker isolation, and `T2` default denial without user confirmation.
   - Assert `'desktop.overlay'` contribution point schema validation.
2. **Overlay Manager & Mock Harness Contract Tests (`agy-daddy-host/test/overlay-manager.test.js`)**:
   - Verify `MemoryOverlayBackend` lifecycle (`createWindow`, `setScene`, `updateState` `200ms` coalescing, `360×360` bounds clamping, local-only `spritePath` confinement rejecting `../` and `https://`, `maxWindowsPerPlugin = 1`).
   - Verify Worker IPC round-trip (`spawnWorkerPlugin`) for `T1` plugin calling `host.overlay.*` and receiving `onInteraction` callbacks.
   - Verify `createMockHostHarness().assertCleanDispose(pluginId)` fails when an overlay window is leaked and passes when `dispose()` cleans up.
3. **Native Backend Syntax & Headless Compile Checks (`agy-daddy-host/test/overlay-backends.test.js`)**:
   - On `darwin`: run `swiftc -typecheck src/core/overlay-backends/macos-overlay.swift` to guarantee zero Swift compile errors in CI.
   - On `linux` / `darwin` (when `python3` available): run `python3 -m py_compile src/core/overlay-backends/linux-overlay.py`.
   - Validate PowerShell AST / balanced syntax check on `src/core/overlay-backends/win32-overlay.ps1`.
4. **Monorepo Gates (`npm run verify`)**:
   - Zero runtime dependencies across all packages, Purple Theme Gate compliance, `sdk/index.d.ts` parity, and zero leaked child processes after test suite exit.
