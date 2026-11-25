'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHostRuntime } = require('../src/renderer/host-runtime');
const { loadAnchorsRegistry, loadHealthAnchorsRegistry, buildResolvedAnchorsMap } = require('../src/core/anchors');
const { CdpInjector } = require('../src/core/injector');
const { AgyDaddyDaemon } = require('../src/core/daemon');
const { createMockDocument } = require('../sdk/mock-harness');
const { buildHostRenderer } = require('../scripts/build-renderer');

function createSeededWindow(doc, width = 1280, height = 800) {
  const winListeners = new Map();
  return {
    innerWidth: width,
    innerHeight: height,
    location: { href: 'https://127.0.0.1:51410/11111111-2222-3333-4444-555555555555' },
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, new Set());
      winListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      winListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      const set = winListeners.get(ev.type);
      if (set) for (const fn of Array.from(set)) fn(ev);
      return true;
    },
    getDocumentListenersCount() {
      return doc ? winListeners.size : 0;
    }
  };
}

function addTopbarCluster(doc) {
  const titlebar = doc.createElement('div');
  titlebar.className = '@container/titlebar';
  const shrink = doc.createElement('div');
  shrink.className = 'shrink-0';
  const toggleBtn = doc.createElement('div');
  toggleBtn.setAttribute('data-testid', 'toggle-aux-sidebar');
  shrink.appendChild(toggleBtn);
  titlebar.appendChild(shrink);
  doc.body.appendChild(titlebar);
  return titlebar;
}

function buildSampleHostHealth(anchorsRegistry, overrides = {}) {
  const names = Object.keys(anchorsRegistry.anchors || {});
  const items = names.map((name, idx) => ({
    name,
    status: idx < 3 ? 'missing' : 'ok',
    matchedSelector: idx < 3 ? null : (anchorsRegistry.anchors[name]?.versions?.[0]?.selectors?.[0] || '.ok'),
    affectedPlugins: name === 'composer.editor' ? ['agy-daddy.demo'] : []
  }));
  return {
    ok: true,
    daemon: {
      pid: 43210,
      bridgePort: 19456,
      inheritedSessionVars: [],
      hasSessionEnvPollution: false,
      startedAt: '2026-11-25T09:55:00.000Z',
      uptimeMs: 300000
    },
    antigravity: {
      running: true,
      pid: 54321,
      version: '2.35.1',
      lastInjectedVersion: '2.34.0',
      hasDebugSwitch: true,
      lastRelaunch: {
        at: '2026-11-25T09:58:00.000Z',
        status: 'succeeded',
        reason: null,
        blockedBy: null
      },
      upgradeEvents: [
        {
          at: '2026-11-25T09:57:30.000Z',
          fromVersion: '2.34.0',
          toVersion: '2.35.1',
          pid: 54321,
          outcome: 'succeeded',
          reason: null
        }
      ]
    },
    cdp: {
      port: 9222,
      portsTried: [9222],
      reachable: true,
      targets: {
        total: 2,
        matched: [
          { id: 't1', title: 'Antigravity', url: 'https://127.0.0.1:51410/conv-1', type: 'page' }
        ],
        filtered: [
          { id: 't2', title: 'DevTools', url: 'devtools://devtools/bundled/inspector.html', type: 'other', filterReason: 'unsupported_target_type' }
        ]
      }
    },
    injection: {
      injectedCount: 1,
      lastInjectError: null,
      probeSource: 'runtime',
      antigravityVersion: '2.35.1',
      anchors: {
        total: 14,
        healthyCount: items.filter((i) => i.status === 'ok').length,
        missingCount: items.filter((i) => i.status === 'missing').length,
        items
      }
    },
    plugins: [
      {
        id: 'agy-daddy.demo',
        name: 'Demo Plugin',
        enabled: true,
        nodeState: 'active',
        rendererMounted: false,
        lastError: 'Composer anchor missing',
        lastErrorStack: 'Error: Composer anchor missing\n    at mount (/plugins/demo/renderer.js:12:9)',
        affectedByMissingAnchors: ['composer.editor']
      }
    ],
    fault: {
      active: true,
      code: 'core_anchor_missing',
      reason: 'topbar.rightCluster, settings.dialog, settings.nav',
      since: '2026-11-25T09:59:00.000Z',
      durationMs: 7400,
      exceeded5s: true,
      pid: 54321
    },
    ...overrides
  };
}

test('Safe Mode triggers on topbar.rightCluster missing, settings injection failure, and plugin exception, ignoring showTopbarEntry:false and recovering cleanly', async () => {
  const anchorsRegistry = loadAnchorsRegistry();

  // 1. Trigger 1: topbar.rightCluster missing even when showTopbarEntry: false
  {
    const doc = createMockDocument();
    const topbarEl = doc.querySelector('.@container\\/titlebar')
      || Array.from(doc.body.children).find((el) => el.querySelector?.('[data-testid="toggle-aux-sidebar"]'));
    assert.ok(topbarEl);
    topbarEl.remove();

    const win = createSeededWindow(doc);
    const host = createHostRuntime({
      document: doc,
      window: win,
      anchorsRegistry,
      hostSettings: { showTopbarEntry: false, injectNativeSettings: true }
    });

    try {
      const pillHost = doc.getElementById('agy-safe-mode-pill-host');
      assert.ok(pillHost, 'Safe Mode pill host must mount in document.body');
      assert.equal(pillHost.parentElement, doc.body);
      assert.equal(pillHost.hidden, false);
      assert.equal(pillHost.style.getPropertyValue('position'), 'fixed');
      assert.equal(pillHost.style.getPropertyValue('z-index'), '2147483647');

      const pillBtn = pillHost.shadowRoot.querySelector('#agy-safe-mode-pill');
      assert.ok(pillBtn);
      assert.match(pillBtn.textContent, /Agy ⚠️ \d+ 锚点失效/);
      assert.equal(host.getSafeModeState().topbarMissing, true);

      // Recovery: restore topbar.rightCluster -> pill auto-hides and showTopbarEntry:false stays respected
      addTopbarCluster(doc);
      host.syncNativeSettings();
      assert.equal(host.getSafeModeState().active, false);
      assert.equal(pillHost.hidden, true);
      const settingsBtn = doc.getElementById('agy-daddy-host')?.shadowRoot?.querySelector('#agy-btn-settings');
      if (settingsBtn) {
        assert.equal(settingsBtn.hidden, true);
      }
    } finally {
      await host.dispose();
    }
  }

  // 2. Trigger 2: settings.dialog present without settings.nav (and openSettings fallback failure)
  {
    const doc = createMockDocument();
    const win = createSeededWindow(doc);
    const host = createHostRuntime({
      document: doc,
      window: win,
      anchorsRegistry,
      hostSettings: { showTopbarEntry: false, injectNativeSettings: true }
    });

    try {
      assert.equal(host.getSafeModeState().active, false);

      const settingsDialog = doc.createElement('div');
      settingsDialog.setAttribute('data-testid', 'settings-dialog');
      settingsDialog.setAttribute('role', 'dialog');
      doc.body.appendChild(settingsDialog);
      host.syncNativeSettings();

      const pillHost = doc.getElementById('agy-safe-mode-pill-host');
      assert.ok(pillHost);
      assert.equal(pillHost.hidden, false);
      assert.equal(host.getSafeModeState().settingsInjectionFailed, true);

      // Restore settings.nav + settings.content -> recovers
      const nav = doc.createElement('div');
      nav.setAttribute('data-testid', 'settings-sidebar');
      const content = doc.createElement('div');
      content.setAttribute('data-testid', 'settings-content');
      settingsDialog.appendChild(nav);
      settingsDialog.appendChild(content);
      host.syncNativeSettings();

      assert.equal(host.getSafeModeState().active, false);
      assert.equal(pillHost.hidden, true);

      // Remove native settings completely and call openSettings() -> native injection attempt fails -> Safe Mode activates
      settingsDialog.remove();
      host.syncNativeSettings();
      const openRes = await host.openSettings({ tab: 'plugins' });
      assert.equal(openRes.mode, 'modal');
      assert.equal(host.getSafeModeState().settingsInjectionFailed, true);
      assert.equal(pillHost.hidden, false);
      host.closeSettings();
      assert.equal(pillHost.hidden, false);
    } finally {
      await host.dispose();
    }
  }

  // 3. Trigger 3: plugin mount/runtime exception -> Safe Mode activates and recovers on re-enable
  {
    const doc = createMockDocument();
    const win = createSeededWindow(doc);
    const host = createHostRuntime({
      document: doc,
      window: win,
      anchorsRegistry,
      hostSettings: { showTopbarEntry: false, injectNativeSettings: false }
    });

    try {
      assert.equal(host.getSafeModeState().active, false);
      const mountRes = await host.mountPlugin('broken.plugin', {
        mount() {
          throw new Error('BOOM_RENDERER_FAIL');
        }
      });
      assert.equal(mountRes.ok, false);

      const pillHost = doc.getElementById('agy-safe-mode-pill-host');
      assert.ok(pillHost);
      assert.equal(pillHost.hidden, false);
      const pillBtn = pillHost.shadowRoot.querySelector('#agy-safe-mode-pill');
      assert.match(pillBtn.textContent, /1 插件异常/);

      // Recover via healthy remount
      const recoverRes = await host.mountPlugin('broken.plugin', {
        mount() {}
      });
      assert.equal(recoverRes.ok, true);
      assert.equal(host.getSafeModeState().active, false);
      assert.equal(pillHost.hidden, true);
    } finally {
      await host.dispose();
    }
  }
});

test('Safe Mode pill supports dragging with viewport boundary clamping and prevents accidental click after drag', async () => {
  const doc = createMockDocument();
  const win = createSeededWindow(doc, 1000, 700);
  const anchorsRegistry = loadAnchorsRegistry();

  const host = createHostRuntime({
    document: doc,
    window: win,
    anchorsRegistry,
    hostSettings: { showTopbarEntry: false }
  });

  try {
    await host.mountPlugin('drag.broken', {
      mount() {
        throw new Error('drag test fault');
      }
    });

    const pillHost = doc.getElementById('agy-safe-mode-pill-host');
    const pillBtn = pillHost.shadowRoot.querySelector('#agy-safe-mode-pill');
    assert.ok(pillHost && pillBtn);
    pillHost.getBoundingClientRect = () => ({
      left: 816,
      top: 652,
      right: 984,
      bottom: 684,
      width: 168,
      height: 32
    });

    // 1. Drag within viewport -> updates left/top and suppresses click
    pillBtn.dispatchEvent({ type: 'pointerdown', button: 0, clientX: 850, clientY: 660 });
    doc.dispatchEvent({ type: 'pointermove', clientX: 450, clientY: 260, preventDefault() {} });
    doc.dispatchEvent({ type: 'pointerup', clientX: 450, clientY: 260 });
    pillBtn.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });

    assert.equal(host.getSettingsMode(), 'closed', 'drag gesture must not trigger click modal open');
    const pos1 = host.getSafeModeState().pillPosition;
    assert.deepEqual(pos1, { left: 416, top: 252 });
    assert.equal(pillHost.style.getPropertyValue('left'), '416px');
    assert.equal(pillHost.style.getPropertyValue('top'), '252px');

    // 2. Drag past negative and max viewport boundaries -> clamped within [8, vw - width - 8] and [8, vh - height - 8]
    pillHost.getBoundingClientRect = () => ({
      left: pos1.left,
      top: pos1.top,
      right: pos1.left + 168,
      bottom: pos1.top + 32,
      width: 168,
      height: 32
    });
    pillBtn.dispatchEvent({ type: 'mousedown', button: 0, clientX: 450, clientY: 260 });
    doc.dispatchEvent({ type: 'mousemove', clientX: -1000, clientY: 5000, preventDefault() {} });
    doc.dispatchEvent({ type: 'mouseup', clientX: -1000, clientY: 5000 });

    const clampedPos = host.getSafeModeState().pillPosition;
    assert.deepEqual(clampedPos, { left: 8, top: 660 });

    // 3. Normal click (no drag movement) -> opens fallback modal
    await new Promise((r) => setTimeout(r, 140));
    pillBtn.click();
    assert.equal(host.getSettingsMode(), 'modal');
  } finally {
    await host.dispose();
  }
});

test('Clicking Safe Mode pill opens independent 760x560 Shadow DOM modal and renders all 5 hostHealth segments on first screen', async () => {
  const doc = createMockDocument();
  const composerEl = doc.querySelector('.surface-composer');
  if (composerEl) composerEl.remove();
  const win = createSeededWindow(doc);
  const anchorsRegistry = loadAnchorsRegistry();
  const healthAnchors = buildResolvedAnchorsMap(loadHealthAnchorsRegistry(), '2.35.1');
  const sampleHealth = buildSampleHostHealth(healthAnchors);

  // Even if native settings trigger exists, Safe Mode pill MUST NOT depend on native settings DOM
  const nativeTrigger = doc.createElement('button');
  nativeTrigger.setAttribute('data-testid', 'settings-button');
  let nativeTriggerClicked = 0;
  nativeTrigger.click = () => { nativeTriggerClicked++; };
  doc.body.appendChild(nativeTrigger);

  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path: parsed.pathname, headers: init.headers || {}, body });
    if (parsed.pathname === '/host/health') {
      return { ok: true, status: 200, async json() { return sampleHealth; } };
    }
    if (parsed.pathname === '/host/health/runtime-report') {
      return { ok: true, status: 200, async json() { return { ok: true }; } };
    }
    if (parsed.pathname === '/host/plugins') {
      return { ok: true, status: 200, async json() { return { ok: true, plugins: [], catalog: [] }; } };
    }
    return { ok: true, status: 200, async json() { return { ok: true }; } };
  };

  const host = createHostRuntime({
    document: doc,
    window: win,
    fetch: fetchFn,
    bridgePort: 19456,
    hostToken: 'safe-token',
    antigravityVersion: '2.35.1',
    anchorsRegistry,
    healthTargetId: 'target-1',
    healthReportId: 'nonce-1',
    healthAnchors,
    hostSettings: { showTopbarEntry: false, injectNativeSettings: true }
  });

  try {
    await host.mountPlugin('agy-daddy.demo', {
      mount() {
        const err = new Error('Composer anchor missing');
        err.stack = 'Error: Composer anchor missing\n    at mount (/plugins/demo/renderer.js:12:9)';
        throw err;
      }
    });

    const pillHost = doc.getElementById('agy-safe-mode-pill-host');
    const pillBtn = pillHost.shadowRoot.querySelector('#agy-safe-mode-pill');
    pillBtn.click();

    await new Promise((r) => setTimeout(r, 40));

    assert.equal(nativeTriggerClicked, 0, 'Safe Mode pill must not touch Antigravity native settings DOM');
    assert.equal(host.getSettingsMode(), 'modal');

    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    const modalBackdrop = shadow.querySelector('#agy-settings-modal-backdrop');
    assert.equal(modalBackdrop.hidden, false);

    // First screen contains all 4 unified diagnostics blocks
    const diagView = shadow.querySelector('#agy-safe-mode-diagnostics-view');
    assert.ok(diagView, 'First screen must render Safe Mode diagnostics view');

    const faultCard = shadow.querySelector('#agy-safe-mode-fault-card');
    assert.match(faultCard.textContent, /core_anchor_missing/);
    assert.match(faultCard.textContent, />5s 告警/);
    assert.match(faultCard.textContent, /7\.4s/);
    assert.match(faultCard.textContent, /2\.34\.0 -> 2\.35\.1/);

    const anchorsTable = shadow.querySelector('#agy-safe-mode-anchors-table');
    const anchorRows = anchorsTable.querySelectorAll('tr[data-anchor-name]');
    assert.equal(anchorRows.length, 14);
    const composerRow = anchorsTable.querySelector('tr[data-anchor-name="composer.editor"]');
    assert.ok(composerRow);
    assert.equal(composerRow.getAttribute('data-anchor-status'), 'missing');
    assert.match(composerRow.textContent, /MISSING/);
    assert.match(composerRow.textContent, /agy-daddy\.demo/);

    const pluginsCard = shadow.querySelector('#agy-safe-mode-plugins-card');
    assert.match(pluginsCard.textContent, /node: active/);
    assert.match(pluginsCard.textContent, /renderer: unmounted/);
    assert.match(pluginsCard.textContent, /Composer anchor missing/);
    assert.match(pluginsCard.textContent, /at mount \(\/plugins\/demo\/renderer\.js:12:9\)/);

    const sysCard = shadow.querySelector('#agy-safe-mode-system-card');
    assert.match(sysCard.textContent, /PID 43210/);
    assert.match(sysCard.textContent, /已隔离/);
    assert.match(sysCard.textContent, /v2\.35\.1/);
    assert.match(sysCard.textContent, /hasDebugSwitch=true/);
    assert.match(sysCard.textContent, /https:\/\/127\.0\.0\.1:51410\/conv-1/);
    assert.match(sysCard.textContent, /devtools:\/\/devtools\/bundled\/inspector\.html/);
    assert.match(sysCard.textContent, /unsupported_target_type/);

    assert.ok(calls.some((c) => c.path === '/host/health' && c.headers['X-AGY-Host-Token'] === 'safe-token'));
  } finally {
    await host.dispose();
  }
});

test('Live 14-anchor probe reports via POST /host/health/runtime-report to daemon on startup and state changes', async () => {
  buildHostRenderer();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-safe-mode-health-'));
  const doc = createMockDocument();
  const win = createSeededWindow(doc);
  const hostProc = { running: true, pid: 77777, version: '2.35.1', hasDebugSwitch: true };
  const target = {
    id: 'target-live-1',
    title: 'Antigravity',
    url: 'https://127.0.0.1:51410/conv-live',
    type: 'page',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/target-live-1'
  };

  const injector = new CdpInjector({ stateDir, antigravityVersion: hostProc.version });
  const daemon = new AgyDaddyDaemon({
    stateDir,
    injector,
    plugins: [],
    inspectHostProcess: () => hostProc
  });
  await daemon.start();

  const pluginId = 'agy-daddy.live-probe';
  daemon.activePlugins.set(pluginId, {
    id: pluginId,
    record: { id: pluginId, enabled: true },
    manifest: { displayName: 'Live Probe', requires: { anchors: ['composer.editor'] } }
  });

  const session = {
    target,
    targetId: target.id,
    xworldNonce: 'nonce-live-1',
    readyForNavEvents: true,
    activePlugins: [{ id: pluginId }],
    mountedPlugins: new Map([[pluginId, {}]]),
    client: { evaluate: async () => null }
  };
  injector.sessions.set(target.id, session);
  daemon.health.observe(hostProc, { port: 9222, targets: [target], filtered: [] });

  const healthAnchors = buildResolvedAnchorsMap(loadHealthAnchorsRegistry(), hostProc.version);
  const host = createHostRuntime({
    document: doc,
    window: win,
    fetch: globalThis.fetch,
    bridgePort: daemon.bridge.port,
    hostToken: daemon.bridge.hostToken,
    antigravityVersion: hostProc.version,
    anchorsRegistry: loadAnchorsRegistry(),
    healthTargetId: target.id,
    healthReportId: session.xworldNonce,
    healthAnchors,
    healthReportIntervalMs: 100
  });

  try {
    // 1. Mount plugin cleanly and let initial runtime-report reach daemon
    await host.mountPlugin(pluginId, { mount() {} });
    const reportRes = await host.reportRuntimeHealth();
    assert.equal(reportRes.ok, true);

    let snapshot = daemon.getHostHealth();
    assert.equal(snapshot.injection.probeSource, 'runtime');
    assert.equal(snapshot.injection.anchors.total, 14);
    assert.equal(snapshot.injection.anchors.items.find((i) => i.name === 'topbar.rightCluster').status, 'ok');
    assert.equal(snapshot.injection.anchors.items.find((i) => i.name === 'composer.editor').status, 'ok');
    assert.equal(snapshot.plugins[0].rendererMounted, true);
    assert.equal(snapshot.fault.active, false);

    // 2. Break topbar.rightCluster and fail plugin mount -> runtime-report immediately updates daemon snapshot
    const topbarEl = doc.querySelector('.@container\\/titlebar')
      || Array.from(doc.body.children).find((el) => el.querySelector?.('[data-testid="toggle-aux-sidebar"]'));
    topbarEl.remove();

    await host.mountPlugin(pluginId, {
      mount() {
        const err = new Error('live mount crash');
        err.stack = 'Error: live mount crash\n    at test:1:1';
        throw err;
      }
    });
    await new Promise((r) => setTimeout(r, 60));

    snapshot = daemon.getHostHealth();
    assert.equal(snapshot.injection.anchors.items.find((i) => i.name === 'topbar.rightCluster').status, 'missing');
    assert.equal(snapshot.plugins[0].rendererMounted, false);
    assert.equal(snapshot.plugins[0].lastError, 'live mount crash');
    assert.match(snapshot.plugins[0].lastErrorStack, /live mount crash/);
    assert.equal(snapshot.fault.active, true);
    assert.equal(snapshot.fault.code, 'core_anchor_missing');
  } finally {
    await host.dispose();
    await daemon.stop();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
