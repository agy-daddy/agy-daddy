'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const { loadHealthAnchorsRegistry, resolveAnchorSelectors } = require('../src/core/anchors');
const { createLauncherController } = require('../src/core/launcher');
const {
  ALERT_TRAY_TITLE,
  FAULT_TRAY_MENU_IDS,
  MemoryTrayBackend,
  TrayManager
} = require('../src/core/tray-manager');

const anchorsRegistry = loadHealthAnchorsRegistry();
const topbarSelector = resolveAnchorSelectors('topbar.rightCluster', '2.35.1', anchorsRegistry).selectors[0];

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tray-fault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeReportItems(matched = {}) {
  return Object.keys(anchorsRegistry.anchors).map((name) => ({
    name,
    status: matched[name] ? 'ok' : 'missing',
    matchedSelector: matched[name] || null
  }));
}

async function flushMicrotasks(ticks = 6) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createFakeDom(html) {
  const scripts = [];
  const jsonBlocks = new Map();
  for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = match[1] || '';
    const content = match[2] || '';
    const idMatch = attrs.match(/\bid="([^"]+)"/);
    const typeMatch = attrs.match(/\btype="([^"]+)"/);
    if (typeMatch?.[1] === 'application/json' && idMatch?.[1]) {
      jsonBlocks.set(idMatch[1], content);
    } else if (!typeMatch) {
      scripts.push(content);
    }
  }

  class FakeNode {
    constructor(tag = 'div') {
      this.tagName = String(tag).toUpperCase();
      this.id = '';
      this.className = '';
      this.children = [];
      this.attributes = new Map();
      this.listeners = new Map();
      this.disabled = false;
      this.checked = true;
      this._text = '';
    }
    get firstChild() {
      return this.children[0] || null;
    }
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this._text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(val) {
      this.children = [];
      this._text = String(val ?? '');
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      return child;
    }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    async click() {
      for (const fn of this.listeners.get('click') || []) {
        await fn({ target: this });
      }
    }
  }

  const ids = [
    'refresh-btn', 'relaunch-btn', 'auto-refresh-toggle',
    'fault-banner', 'fault-title', 'fault-meta',
    'action-status', 'action-status-text',
    'daemon-badge', 'daemon-kv',
    'ag-badge', 'ag-kv', 'upgrade-events-wrap',
    'cdp-badge', 'cdp-kv', 'cdp-matched-wrap', 'cdp-filtered-wrap',
    'injection-badge', 'injection-kv', 'anchors-wrap',
    'plugins-badge', 'plugins-wrap'
  ];
  const elements = new Map(ids.map((id) => {
    const node = new FakeNode('div');
    node.id = id;
    return [id, node];
  }));
  for (const [id, text] of jsonBlocks.entries()) {
    const node = new FakeNode('script');
    node.id = id;
    node.textContent = text;
    elements.set(id, node);
  }

  return {
    scripts,
    elements,
    document: {
      createElement: (tag) => new FakeNode(tag),
      createTextNode: (text) => {
        const n = new FakeNode('#text');
        n.textContent = text;
        return n;
      },
      getElementById: (id) => elements.get(id) || null
    },
    FakeNode
  };
}

test('hideTrayIcon: true 下 5 类异常超过 5s 强显托盘图标、切告警标题与置顶菜单，恢复后重新隐藏', async (t) => {
  const stateDir = makeTempDir(t);
  let now = 100_000;
  let hostProc = { running: false, pid: null, hasDebugSwitch: false, version: '2.35.1', elapsedSec: 60 };
  const backend = new MemoryTrayBackend();
  const openedUrls = [];
  const relaunchCalls = [];

  const controller = createLauncherController({
    stateDir,
    platform: 'darwin',
    appPath: '/Applications/Antigravity.app',
    plugins: [],
    trayBackend: backend,
    skipInject: true,
    disableWatchdog: true,
    inspectHostProcess: () => hostProc,
    relaunchAntigravity: async (opts) => {
      relaunchCalls.push(opts);
      return { ok: true, relaunched: true, port: 54320, targets: [] };
    },
    openBrowserFn: (url) => {
      openedUrls.push(url);
      return true;
    },
    daemonOptions: {
      now: () => now,
      inspectHostProcess: () => hostProc
    }
  });

  t.after(async () => {
    await controller.stop().catch(() => {});
  });

  const daemonTmp = await controller.start();
  assert.equal(daemonTmp.ok, true);
  const daemon = controller.getDaemon();
  const tray = controller.getTrayManager();

  // Save hideTrayIcon: true -> tray hides while healthy
  const saveRes = daemon.saveHostSettings({ hideTrayIcon: true });
  assert.equal(saveRes.ok, true);
  await flushMicrotasks();
  assert.equal(tray.visible, false);
  assert.equal(backend.started, false);

  const target = {
    id: 'win-1',
    type: 'page',
    title: 'Antigravity',
    url: 'https://127.0.0.1:54321/',
    webSocketDebuggerUrl: 'ws://127.0.0.1:54320/devtools/page/win-1'
  };
  const runningHost = { running: true, pid: 2222, hasDebugSwitch: true, version: '2.35.1', elapsedSec: 60 };
  const bareHost = { ...runningHost, hasDebugSwitch: false };

  const faultCases = [
    {
      code: 'missing_cdp_switch',
      expectedText: '未开启 CDP',
      trigger: () => {
        daemon.health.observe(bareHost, { port: null, targets: [] });
      }
    },
    {
      code: 'relaunch_blocked_or_timeout',
      expectedText: '自动补参被环境变量拦截',
      trigger: () => {
        daemon.health.observe(bareHost, { port: null, targets: [] });
        daemon.health.recordRelaunch({ ok: false, blocked: true, reason: 'INSIDE_ANTIGRAVITY_SESSION' }, bareHost.pid);
      }
    },
    {
      code: 'cdp_zero_targets',
      expectedText: 'CDP',
      trigger: () => {
        daemon.health.observe(runningHost, { port: 54320, targets: [] });
      }
    },
    {
      code: 'injection_error',
      expectedText: '宿内注入异常',
      trigger: () => {
        daemon.health.observe(runningHost, { port: 54320, targets: [target] });
        daemon.health.recordInjection({ targetId: target.id, error: 'renderer bootstrap crashed' });
      }
    },
    {
      code: 'core_anchor_missing',
      expectedText: '核心锚点失效',
      trigger: () => {
        daemon.health.observe(runningHost, { port: 54320, targets: [target] });
        daemon.injector.sessions.set(target.id, {
          target,
          targetId: target.id,
          readyForNavEvents: true,
          healthProbe: { items: makeReportItems() }
        });
      }
    }
  ];

  for (const fc of faultCases) {
    // Reset to clean healthy state before each fault class
    daemon.injector.sessions.clear();
    daemon.health.recordInjection({ targetId: target.id });
    daemon.health.recordRelaunch({ ok: true });
    hostProc = { running: false, pid: null, hasDebugSwitch: false, version: '2.35.1', elapsedSec: 60 };
    daemon.health.observe(hostProc, { port: null, targets: [] });
    daemon.getHostHealth();
    await flushMicrotasks();
    assert.equal(tray.visible, false, `Tray should be hidden before ${fc.code}`);
    assert.equal(backend.started, false);

    // Trigger fault at t0 -> <5s grace window respects hideTrayIcon: true
    fc.trigger();
    let snap = daemon.getHostHealth();
    assert.equal(snap.fault.code, fc.code);
    assert.equal(snap.fault.exceeded5s, false);
    await flushMicrotasks();
    assert.equal(tray.visible, false, `Tray must stay hidden at 0ms for ${fc.code}`);
    assert.equal(backend.started, false);

    // At exactly 5000ms -> still not strictly >5000ms
    now += 5000;
    snap = daemon.getHostHealth();
    assert.equal(snap.fault.exceeded5s, false);
    await flushMicrotasks();
    assert.equal(tray.visible, false, `Tray must stay hidden at 5000ms for ${fc.code}`);

    // At 5001ms -> exceeded5s === true -> forced reveal!
    now += 1;
    snap = daemon.getHostHealth();
    assert.equal(snap.fault.exceeded5s, true);
    await flushMicrotasks();

    assert.equal(tray.visible, true, `Tray must force-reveal after >5s for ${fc.code}`);
    assert.equal(backend.started, true);
    assert.equal(backend.lastPayload.title, ALERT_TRAY_TITLE);

    const items = backend.lastPayload.items;
    assert.equal(items[0].id, FAULT_TRAY_MENU_IDS.FAULT_STATUS);
    assert.equal(items[0].enabled, false);
    assert.ok(items[0].label.includes('⚠️'), `First item must have warning icon for ${fc.code}`);
    assert.ok(items[0].label.includes('2.35.1'), `First item must include version for ${fc.code}`);
    assert.ok(items[0].label.includes(fc.expectedText), `Expected "${fc.expectedText}" in "${items[0].label}"`);

    assert.equal(items[1].id, FAULT_TRAY_MENU_IDS.RELAUNCH_ANTIGRAVITY);
    assert.equal(items[1].label, '一键补参重启 Antigravity');
    assert.equal(items[1].enabled, true);

    assert.equal(items[2].id, FAULT_TRAY_MENU_IDS.OPEN_DIAGNOSTICS);
    assert.equal(items[2].label, '打开独立诊断面板（浏览器）');
    assert.equal(items[2].enabled, true);

    // Summary submenu consumes the same hostHealth snapshot
    const summaryItem = items.find((it) => it.id === FAULT_TRAY_MENU_IDS.HEALTH_SUMMARY);
    assert.ok(summaryItem, 'Tray menu should include 5-segment health summary');
    assert.equal(summaryItem.submenu.length, 5);

    // Saving hideTrayIcon: true while fault >5s stays visible
    daemon.saveHostSettings({ hideTrayIcon: true });
    await flushMicrotasks();
    assert.equal(tray.visible, true);

    // Recover -> automatically re-hides because user setting hideTrayIcon is still true
    daemon.injector.sessions.clear();
    daemon.health.recordInjection({ targetId: target.id });
    daemon.health.recordRelaunch({ ok: true });
    daemon.health.observe({ running: false, pid: null, hasDebugSwitch: false }, { port: null, targets: [] });
    snap = daemon.getHostHealth();
    assert.equal(snap.fault.active, false);
    await flushMicrotasks();
    assert.equal(tray.visible, false, `Tray must re-hide after ${fc.code} recovers`);
    assert.equal(backend.started, false);
    assert.equal(daemon.getHostSettings().hideTrayIcon, true);
  }
});

test('故障菜单两个修复动作触发与正常态 title 还原', async (t) => {
  const stateDir = makeTempDir(t);
  let now = 50_000;
  let hostProc = { running: true, pid: 3333, hasDebugSwitch: false, version: '2.35.1', elapsedSec: 60 };
  const backend = new MemoryTrayBackend();
  const openedUrls = [];
  const relaunchCalls = [];

  const controller = createLauncherController({
    stateDir,
    platform: 'darwin',
    appPath: '/Applications/Antigravity.app',
    plugins: [],
    trayBackend: backend,
    skipInject: true,
    disableWatchdog: true,
    inspectHostProcess: () => hostProc,
    relaunchAntigravity: async (opts) => {
      relaunchCalls.push(opts);
      hostProc = { running: true, pid: 3334, hasDebugSwitch: true, version: '2.35.1', elapsedSec: 1 };
      return {
        ok: true,
        relaunched: true,
        port: 54320,
        targets: [{ id: 'w1', type: 'page', title: 'Antigravity', url: 'https://127.0.0.1:54321/' }]
      };
    },
    openBrowserFn: (url) => {
      openedUrls.push(url);
      return true;
    },
    daemonOptions: {
      now: () => now,
      inspectHostProcess: () => hostProc
    }
  });

  t.after(async () => {
    await controller.stop().catch(() => {});
  });

  const started = await controller.start();
  const daemon = controller.getDaemon();
  const tray = controller.getTrayManager();

  // Trigger blocked relaunch > 5s
  daemon.health.observe(hostProc, { port: null, targets: [] });
  daemon.health.recordRelaunch({ ok: false, blocked: true, reason: 'INSIDE_ANTIGRAVITY_SESSION' }, 3333);
  daemon.getHostHealth();
  now += 5001;
  daemon.getHostHealth();
  await flushMicrotasks();

  assert.equal(backend.lastPayload.title, ALERT_TRAY_TITLE);
  assert.equal(backend.lastPayload.items[0].label, '⚠️ Antigravity 2.35.1 未开启 CDP（自动补参被环境变量拦截）');

  // Action 2: open standalone diagnostics in browser
  const diagClick = await tray.handleMenuClick(FAULT_TRAY_MENU_IDS.OPEN_DIAGNOSTICS);
  assert.equal(diagClick.ok, true);
  assert.equal(openedUrls.length, 1);
  assert.equal(openedUrls[0], `http://127.0.0.1:${started.port}/diagnostics`);

  // Action 1: one-click relaunch Antigravity
  const relaunchClick = await tray.handleMenuClick(FAULT_TRAY_MENU_IDS.RELAUNCH_ANTIGRAVITY);
  assert.equal(relaunchClick.ok, true);
  assert.equal(relaunchCalls.length, 1);
  assert.equal(relaunchCalls[0].onlyIfBare, false);
  assert.ok(relaunchCalls[0].extraArgs.includes('--remote-debugging-port=0'));

  // After recovery, hideTrayIcon defaults to false so tray remains visible with cleared alert title
  await flushMicrotasks();
  assert.equal(tray.visible, true);
  assert.equal(backend.lastPayload.title, '');
  assert.notEqual(backend.lastPayload.items[0].id, FAULT_TRAY_MENU_IDS.FAULT_STATUS);
});

test('升级后接管失败 macOS 通知按 PID + reason 严格去重', async (t) => {
  const stateDir = makeTempDir(t);
  const notifications = [];
  const spawnCalls = [];
  const backend = new MemoryTrayBackend();

  const controller = createLauncherController({
    stateDir,
    platform: 'darwin',
    plugins: [],
    trayBackend: backend,
    skipInject: true,
    disableWatchdog: true,
    sendNotification: async (payload) => {
      notifications.push(payload);
      return { ok: true };
    }
  });

  t.after(async () => {
    await controller.stop().catch(() => {});
  });

  await controller.start();
  const daemon = controller.getDaemon();
  daemon.health.recordInjectedVersion('2.34.0');

  // Emit same (pid=4100, reason='CDP_WAIT_TIMEOUT') twice -> only 1 notification
  daemon.health.recordUpgrade({
    fromVersion: '2.34.0', toVersion: '2.35.1', pid: 4100, outcome: 'failed', reason: 'CDP_WAIT_TIMEOUT'
  });
  daemon.health.recordUpgrade({
    fromVersion: '2.34.0', toVersion: '2.35.1', pid: 4100, outcome: 'failed', reason: 'CDP_WAIT_TIMEOUT'
  });
  await flushMicrotasks();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].key, '4100:CDP_WAIT_TIMEOUT');
  assert.match(notifications[0].subtitle, /2\.35\.1/);
  assert.match(notifications[0].subtitle, /4100/);
  assert.match(notifications[0].message, /CDP_WAIT_TIMEOUT/);

  // Same PID, different reason -> emits second notification
  daemon.health.recordUpgrade({
    fromVersion: '2.34.0', toVersion: '2.35.1', pid: 4100, outcome: 'failed', reason: 'INJECTION_ERROR'
  });
  await flushMicrotasks();
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].key, '4100:INJECTION_ERROR');

  // Different PID, same reason -> emits third notification
  daemon.health.recordUpgrade({
    fromVersion: '2.34.0', toVersion: '2.35.1', pid: 4101, outcome: 'blocked', reason: 'CDP_WAIT_TIMEOUT'
  });
  await flushMicrotasks();
  assert.equal(notifications.length, 3);
  assert.deepEqual(controller.getNotifiedUpgradeKeys(), [
    '4100:CDP_WAIT_TIMEOUT',
    '4100:INJECTION_ERROR',
    '4101:CDP_WAIT_TIMEOUT'
  ]);

  // Verify default osascript invocation safely passes argv without interpolation
  const controllerWithSpawn = createLauncherController({
    stateDir: makeTempDir(t),
    platform: 'darwin',
    plugins: [],
    trayBackend: new MemoryTrayBackend(),
    skipInject: true,
    disableWatchdog: true,
    notifyInTest: true,
    spawnFn: (bin, args) => {
      spawnCalls.push({ bin, args });
      return { unref() {} };
    }
  });
  t.after(async () => {
    await controllerWithSpawn.stop().catch(() => {});
  });
  await controllerWithSpawn.start();
  controllerWithSpawn.getDaemon().emit('host-health:upgrade-takeover-failed', {
    pid: 5150,
    reason: 'QUOTE_"TEST"',
    version: '2.35.2'
  });
  await flushMicrotasks();
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].bin, 'osascript');
  assert.ok(spawnCalls[0].args.includes('on run argv'));
  assert.ok(spawnCalls[0].args.some((a) => String(a).includes('QUOTE_"TEST"')));
});

test('常驻 Daemon GET /diagnostics 脱离 Antigravity 可访问并完整消费 5 段 hostHealth 与安全补参', async (t) => {
  const stateDir = makeTempDir(t);
  const backend = new MemoryTrayBackend();
  const relaunchCalls = [];
  let hostProc = { running: false, pid: null, hasDebugSwitch: false, version: null, elapsedSec: null };

  const controller = createLauncherController({
    stateDir,
    platform: 'darwin',
    plugins: [],
    trayBackend: backend,
    skipInject: true,
    disableWatchdog: true,
    inspectHostProcess: () => hostProc,
    relaunchAntigravity: async (opts) => {
      relaunchCalls.push(opts);
      return { ok: true, relaunched: true, port: 54320, targets: [] };
    },
    daemonOptions: {
      inspectHostProcess: () => hostProc
    }
  });

  t.after(async () => {
    await controller.stop().catch(() => {});
  });

  const started = await controller.start();
  const daemon = controller.getDaemon();
  const baseUrl = `http://127.0.0.1:${started.port}`;

  // Populate rich 5-segment data (including upgrade event, matched & filtered CDP pages, 14 anchors, plugin error stack)
  const matchedTarget = {
    id: 'matched-1',
    type: 'page',
    title: 'Workspace Window',
    url: 'https://127.0.0.1:54321/?token=secret-token-value',
    webSocketDebuggerUrl: 'ws://127.0.0.1:54320/devtools/page/matched-1'
  };
  const filteredTarget = {
    id: 'filtered-1',
    type: 'service_worker',
    title: 'Worker',
    url: 'file:///Users/demo/worker.js',
    filterReason: 'unsupported_target_type'
  };
  daemon.health.recordInjectedVersion('2.34.0');
  daemon.health.recordUpgrade({
    fromVersion: '2.34.0',
    toVersion: '2.35.1',
    pid: 9001,
    outcome: 'failed',
    reason: 'CDP_WAIT_TIMEOUT'
  });
  daemon.activePlugins.set('demo.plugin', {
    id: 'demo.plugin',
    record: { id: 'demo.plugin', enabled: true },
    manifest: { displayName: 'Demo Plugin', requires: { anchors: ['composer.editor'] } }
  });
  daemon.injector.sessions.set(matchedTarget.id, {
    target: matchedTarget,
    targetId: matchedTarget.id,
    readyForNavEvents: true,
    mountedPlugins: new Map(),
    mountErrors: new Map([['demo.plugin', {
      message: `Mount failed at ${os.homedir()}/plugin.js token=topsecret123`,
      stack: `Error: Mount failed\n    at ${os.homedir()}/plugin.js:12:3`,
      at: Date.now()
    }]]),
    healthProbe: {
      items: makeReportItems({ 'topbar.rightCluster': topbarSelector })
    }
  });
  daemon.health.observe(
    { running: false, pid: null, hasDebugSwitch: false, version: '2.35.1' },
    { port: 54320, portsTried: [54320], reachable: true, targets: [matchedTarget], filtered: [filteredTarget] }
  );

  // 1. Fetch HTML while Antigravity is NOT running (running: false)
  const pageRes = await fetch(`${baseUrl}/diagnostics`);
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.headers.get('content-type'), /^text\/html/);
  const html = await pageRes.text();

  // Zero third-party runtime CDN/external dependencies
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+href=/i);
  // Secrets redacted in embedded initial snapshot
  assert.doesNotMatch(html, /secret-token-value/);
  assert.doesNotMatch(html, /topsecret123/);

  // 2. Fetch /diagnostics/health JSON directly
  const healthRes = await fetch(`${baseUrl}/diagnostics/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.antigravity.running, false);
  assert.equal(healthJson.antigravity.upgradeEvents.length, 1);
  assert.equal(healthJson.cdp.targets.matched.length, 1);
  assert.equal(healthJson.cdp.targets.filtered.length, 1);
  assert.equal(healthJson.injection.anchors.total, 15);
  assert.equal(healthJson.plugins[0].id, 'demo.plugin');

  // 3. Execute inline JS inside a sandboxed DOM to verify all 5 sections render & refresh/relaunch work
  const fakeDom = createFakeDom(html);
  assert.equal(fakeDom.scripts.length, 1);
  const fetchCalls = [];
  const sandbox = {
    document: fakeDom.document,
    Node: fakeDom.FakeNode,
    JSON,
    Date,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url, init });
      if (url === '/diagnostics/health') {
        const res = await fetch(`${baseUrl}/diagnostics/health`);
        return { ok: res.ok, status: res.status, json: () => res.json() };
      }
      if (url === '/diagnostics/relaunch') {
        const res = await fetch(`${baseUrl}/diagnostics/relaunch`, {
          method: init.method,
          headers: { ...(init.headers || {}), Origin: baseUrl },
          body: init.body
        });
        return { ok: res.ok, status: res.status, json: () => res.json() };
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
  };
  vm.runInNewContext(fakeDom.scripts[0], sandbox);
  await flushMicrotasks(12);

  assert.ok(fetchCalls.some((c) => c.url === '/diagnostics/health'));
  assert.match(fakeDom.elements.get('daemon-kv').textContent, new RegExp(String(process.pid)));
  assert.match(fakeDom.elements.get('ag-kv').textContent, /2\.34\.0/);
  assert.match(fakeDom.elements.get('upgrade-events-wrap').textContent, /CDP_WAIT_TIMEOUT/);
  assert.match(fakeDom.elements.get('cdp-matched-wrap').textContent, /matched-1/);
  assert.match(fakeDom.elements.get('cdp-filtered-wrap').textContent, /unsupported_target_type/);
  assert.match(fakeDom.elements.get('anchors-wrap').textContent, /topbar\.rightCluster/);
  assert.match(fakeDom.elements.get('anchors-wrap').textContent, /composer\.editor/);
  assert.match(fakeDom.elements.get('plugins-wrap').textContent, /Demo Plugin/);
  assert.match(fakeDom.elements.get('plugins-wrap').textContent, /Mount failed/);

  // 4. Security checks on POST /diagnostics/relaunch
  assert.equal((await fetch(`${baseUrl}/diagnostics/relaunch`, { method: 'GET' })).status, 403);
  assert.equal((await fetch(`${baseUrl}/diagnostics/relaunch`, {
    method: 'GET',
    headers: { Origin: baseUrl }
  })).status, 405);
  assert.equal((await fetch(`${baseUrl}/diagnostics/relaunch`, {
    method: 'POST',
    headers: { Origin: 'https://evil.invalid' }
  })).status, 403);
  assert.equal((await fetch(`${baseUrl}/diagnostics/relaunch`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'X-AGY-Diagnostics-Token': 'wrong-token' }
  })).status, 403);

  // Trigger relaunch button from inside rendered page JS
  hostProc = { running: true, pid: 9002, hasDebugSwitch: false, version: '2.35.1', elapsedSec: 5 };
  await fakeDom.elements.get('relaunch-btn').click();
  await flushMicrotasks(10);
  assert.equal(relaunchCalls.length, 1);
  assert.match(fakeDom.elements.get('action-status-text').textContent, /补参重启指令已执行/);
});
