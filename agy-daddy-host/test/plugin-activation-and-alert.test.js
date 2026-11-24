'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('vm');
const { EventEmitter } = require('node:events');

const { AgyDaddyDaemon } = require('../src/core/daemon');
const { createLiveWatchdog } = require('../src/core/live-watchdog');
const { installPlugin, readInstalledIndex } = require('../src/core/installer');
const { createHostRuntime } = require('../src/renderer/host-runtime');
const { loadAnchorsRegistry } = require('../src/core/anchors');
const { createMockDocument } = require('../sdk/mock-harness');
const { buildHostRenderer } = require('../scripts/build-renderer');

async function postHost(port, hostToken, route, body = {}) {
  const resp = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AGY-Host-Token': hostToken
    },
    body: JSON.stringify(body)
  });
  return { status: resp.status, data: await resp.json() };
}

function createVmContext(mockDoc) {
  class MockCustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  }
  class MockMutationObserver {
    observe() {}
    disconnect() {}
  }
  const timers = new Set();
  const ctx = vm.createContext({
    document: mockDoc,
    location: { href: 'https://127.0.0.1:51410/conv-1' },
    CustomEvent: MockCustomEvent,
    MutationObserver: MockMutationObserver,
    fetch: globalThis.fetch,
    URL,
    console,
    Math,
    Date,
    setTimeout(fn, ms, ...a) { const id = setTimeout(fn, ms, ...a); timers.add(id); return id; },
    clearTimeout(id) { timers.delete(id); clearTimeout(id); },
    setInterval(fn, ms, ...a) { const id = setInterval(fn, ms, ...a); timers.add(id); return id; },
    clearInterval(id) { timers.delete(id); clearInterval(id); }
  });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.self = ctx;
  ctx.__clearTimers = () => { for (const id of timers) { clearTimeout(id); clearInterval(id); } timers.clear(); };
  return ctx;
}

async function createLocalCdpHarness() {
  const mockDoc = createMockDocument();
  const mainCtx = createVmContext(mockDoc);
  const isoContexts = new Map();
  let nextIsoId = 2;

  const httpServer = http.createServer((req, res) => {
    const port = httpServer.address().port;
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        {
          id: 'target-main',
          type: 'page',
          url: 'https://127.0.0.1:51410/conv-1',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/cdp`
        }
      ]));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const cdpPort = httpServer.address().port;

  class MockCdpWebSocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('open'));
    }
    addEventListener(type, fn) { this.on(type, fn); }
    removeEventListener(type, fn) { this.off(type, fn); }
    async send(raw) {
      const msg = JSON.parse(raw);
      const emitMsg = (obj) => this.emit('message', { data: JSON.stringify(obj) });
      if (msg.method === 'Page.getFrameTree') {
        emitMsg({ id: msg.id, result: { frameTree: { frame: { id: 'frame-main' } } } });
      } else if (msg.method === 'Page.createIsolatedWorld') {
        const ctxId = nextIsoId++;
        isoContexts.set(ctxId, createVmContext(mockDoc));
        emitMsg({ id: msg.id, result: { executionContextId: ctxId } });
      } else if (msg.method === 'Runtime.evaluate') {
        const ctx = typeof msg.params?.contextId === 'number'
          ? isoContexts.get(msg.params.contextId)
          : mainCtx;
        try {
          let val = vm.runInContext(msg.params.expression, ctx);
          if (msg.params.awaitPromise !== false && val && typeof val.then === 'function') {
            val = await val;
          }
          const safe = val === undefined ? undefined : JSON.parse(JSON.stringify(val));
          emitMsg({ id: msg.id, result: { result: { value: safe } } });
        } catch (err) {
          emitMsg({ id: msg.id, result: { exceptionDetails: { text: err?.message || String(err) } } });
        }
      } else {
        emitMsg({ id: msg.id, result: {} });
      }
    }
    close() { this.emit('close'); }
  }

  return {
    cdpPort,
    mockDoc,
    mainCtx,
    MockCdpWebSocket,
    async cleanup() {
      mainCtx.__clearTimers();
      for (const ctx of isoContexts.values()) ctx.__clearTimers();
      httpServer.closeAllConnections?.();
      await new Promise((r) => httpServer.close(r));
    }
  };
}

function writeFlagDrivenPlugin(dir, { id, displayName, unitId, unitLabel, flagFile, errorText = 'GATEWAY_PORT_OCCUPIED: 127.0.0.1:18766 is already in use' }) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id,
    publisher: 'agy-daddy',
    version: '1.0.0',
    displayName: { 'zh-CN': displayName, en: displayName },
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    renderer: './src/renderer.js',
    world: 'isolated',
    permissions: ['dom:write'],
    contributes: { 'topbar.units': [{ id: unitId, order: 40 }] }
  }, null, 2));

  fs.writeFileSync(path.join(dir, 'src', 'node.js'), `
'use strict';
const fs = require('fs');
async function activate() {
  if (fs.existsSync(${JSON.stringify(flagFile)})) {
    throw new Error(${JSON.stringify(errorText)});
  }
}
async function deactivate() {}
module.exports = { activate, deactivate };
`);

  fs.writeFileSync(path.join(dir, 'src', 'renderer.js'), `
'use strict';
let stop = null;
function mount(ctx) {
  stop = ctx.topbar.registerUnit({ id: ${JSON.stringify(unitId)}, order: 40, label: ${JSON.stringify(unitLabel)} });
}
function dispose() {
  if (typeof stop === 'function') stop();
  stop = null;
}
module.exports = { mount, dispose };
`);
}

test('Daemon 结构化诊断 + /host/plugins/activate 激活与 CDP 同步清理顶栏警报', async () => {
  buildHostRenderer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-act-daemon-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const pluginDir = path.join(root, 'plugin-port');
  const flagFile = path.join(root, 'fail.flag');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(flagFile, '1', 'utf8');

  writeFlagDrivenPlugin(pluginDir, {
    id: 'agy-daddy.portfail',
    displayName: '端口依赖插件',
    unitId: 'portfail',
    unitLabel: 'PortOK',
    flagFile
  });

  const installedFile = path.join(stateDir, 'installed-plugins.json');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(installedFile, JSON.stringify({
    schemaVersion: 1,
    plugins: {
      'agy-daddy.portfail': {
        id: 'agy-daddy.portfail',
        version: '1.0.0',
        trustLevel: 'T0',
        enabled: true,
        installPath: pluginDir,
        sourceKind: 'local'
      }
    }
  }, null, 2));

  const cdpHarness = await createLocalCdpHarness();
  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    workspaceRoot: root,
    origin: '*',
    startRetryDelayMs: 5,
    WebSocket: cdpHarness.MockCdpWebSocket,
    cdpOptions: { ports: [cdpHarness.cdpPort], allowLsof: false }
  });

  try {
    const started = await daemon.start();
    assert.equal(daemon.activePlugins.has('agy-daddy.portfail'), false);
    assert.ok(started.activationErrors.some((e) => e.id === 'agy-daddy.portfail'));

    const list1 = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins', {});
    const p1 = list1.data.plugins.find((x) => x.id === 'agy-daddy.portfail');
    assert.equal(p1.enabled, true);
    assert.equal(p1.active, false);
    assert.equal(p1.health.lastErrorCode, 'PORT_IN_USE');
    assert.equal(p1.health.lastErrorStage, 'activate');
    assert.match(p1.health.lastError, /GATEWAY_PORT_OCCUPIED/);
    assert.ok(p1.health.lastErrorSuggestion.length > 5);

    const metaMap = daemon.buildPluginMetaMap();
    assert.equal(metaMap['agy-daddy.portfail'].enabled, true);
    assert.equal(metaMap['agy-daddy.portfail'].active, false);
    assert.equal(metaMap['agy-daddy.portfail'].health.lastErrorCode, 'PORT_IN_USE');

    // 注入宿主壳到 CDP 页面 -> 顶栏最右侧应立即出现异常胶囊
    const inj = await daemon.injectActiveTargets({ skipActivateInactive: true });
    assert.equal(inj.targetsInjected, 1);
    const shadow = cdpHarness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
    const alertBtn = shadow.querySelector('#agy-plugin-alert-btn');
    assert.ok(alertBtn);
    assert.equal(alertBtn.hidden, false);
    assert.equal(alertBtn.getAttribute('data-issue-count'), '1');

    // 条件仍未修复时激活 -> 返回 ok: false 但不抛 500
    const actFail = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins/activate', {
      pluginId: 'agy-daddy.portfail'
    });
    assert.equal(actFail.status, 200);
    assert.equal(actFail.data.ok, false);
    assert.equal(actFail.data.active, false);
    assert.match(actFail.data.error, /GATEWAY_PORT_OCCUPIED/);

    // 触发 3 次崩溃进入熔断态，再移除故障标记 -> 手动激活可解除熔断并热注入页面、消除顶栏警报
    await postHost(started.port, daemon.bridge.hostToken, '/host/plugins/activate', {
      pluginId: 'agy-daddy.portfail',
      resetCircuit: false
    });
    fs.unlinkSync(flagFile);

    const actOk = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins/activate', {
      pluginId: 'agy-daddy.portfail',
      resetCircuit: true
    });
    assert.equal(actOk.status, 200);
    assert.equal(actOk.data.ok, true);
    assert.equal(actOk.data.active, true);
    assert.equal(actOk.data.health.lastError, null);
    assert.equal(daemon.activePlugins.has('agy-daddy.portfail'), true);

    const barTexts = shadow.querySelector('#agy-topbar-slots').children.map((c) => c.textContent);
    assert.ok(barTexts.includes('PortOK'));
    assert.equal(alertBtn.hidden, true);
  } finally {
    await daemon.stop();
    await cdpHarness.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('每次 Antigravity 启动时尽可能激活未激活插件，仍失败则在顶栏右侧胶囊提示', async () => {
  buildHostRenderer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launch-act-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const recDir = path.join(root, 'plugin-rec');
  const brokenDir = path.join(root, 'plugin-broken');
  const recFlag = path.join(root, 'rec.flag');
  const brokenFlag = path.join(root, 'broken.flag');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(recFlag, '1', 'utf8');
  fs.writeFileSync(brokenFlag, '1', 'utf8');

  writeFlagDrivenPlugin(recDir, {
    id: 'agy-daddy.rec',
    displayName: '启动恢复插件',
    unitId: 'rec-unit',
    unitLabel: 'RecOK',
    flagFile: recFlag,
    errorText: 'TRANSIENT_NOT_READY'
  });
  writeFlagDrivenPlugin(brokenDir, {
    id: 'agy-daddy.broken',
    displayName: '持续故障插件',
    unitId: 'broken-unit',
    unitLabel: 'BrokenOK',
    flagFile: brokenFlag,
    errorText: 'PERMANENT_START_FAIL'
  });

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'installed-plugins.json'), JSON.stringify({
    schemaVersion: 1,
    plugins: {
      'agy-daddy.rec': {
        id: 'agy-daddy.rec',
        version: '1.0.0',
        trustLevel: 'T0',
        enabled: true,
        installPath: recDir,
        sourceKind: 'local'
      },
      'agy-daddy.broken': {
        id: 'agy-daddy.broken',
        version: '1.0.0',
        trustLevel: 'T0',
        enabled: true,
        installPath: brokenDir,
        sourceKind: 'local'
      }
    }
  }, null, 2));

  const cdpHarness = await createLocalCdpHarness();
  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    workspaceRoot: root,
    origin: '*',
    startRetryDelayMs: 5,
    WebSocket: cdpHarness.MockCdpWebSocket,
    cdpOptions: { ports: [cdpHarness.cdpPort], allowLsof: false }
  });

  const logs = [];
  const warns = [];

  try {
    await daemon.start();
    assert.equal(daemon.activePlugins.has('agy-daddy.rec'), false);
    assert.equal(daemon.activePlugins.has('agy-daddy.broken'), false);

    // 模拟在 Antigravity App 启动前环境条件就绪（recFlag 消失，brokenFlag 仍在）
    fs.unlinkSync(recFlag);

    const watchdog = createLiveWatchdog(daemon, {
      platform: 'darwin',
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
      inspectHostProcess: () => ({ running: true, pid: 8888, hasDebugSwitch: true, elapsedSec: 2 }),
      resolveCdpTarget: async () => ({
        port: cdpHarness.cdpPort,
        targets: [
          {
            id: 'target-main',
            type: 'page',
            url: 'https://127.0.0.1:51410/conv-1',
            webSocketDebuggerUrl: `ws://127.0.0.1:${cdpHarness.cdpPort}/cdp`
          }
        ]
      })
    });

    const tickRes = await watchdog.tick();
    assert.equal(tickRes.action, 'synced');
    assert.equal(tickRes.injectedCount, 1);

    // 可恢复插件应在 attachTarget 前已被补激活并注入页面
    assert.equal(daemon.activePlugins.has('agy-daddy.rec'), true);
    assert.equal(daemon.activePlugins.has('agy-daddy.broken'), false);

    const shadow = cdpHarness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
    const barChildren = shadow.querySelector('#agy-topbar-slots').children;
    assert.ok(barChildren.some((c) => c.textContent === 'RecOK'));

    // 仍无法激活的插件应在顶栏最右侧胶囊给出提示
    const alertBtn = shadow.querySelector('#agy-plugin-alert-btn');
    assert.ok(alertBtn);
    assert.equal(alertBtn.hidden, false);
    assert.equal(alertBtn.getAttribute('data-issue-count'), '1');
    assert.equal(barChildren[barChildren.length - 1].id, 'agy-plugin-alert-btn');
    assert.ok(logs.some((m) => m.includes('agy-daddy.rec')));
    assert.ok(warns.some((m) => m.includes('agy-daddy.broken')));
  } finally {
    await daemon.stop();
    await cdpHarness.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('顶栏最右侧异常胶囊交互：单插件直达诊断、设置页激活、多插件列表及紧凑侧边栏提升风险点', async () => {
  const doc = createMockDocument();
  const win = { innerWidth: 1920, innerHeight: 1000, location: { href: 'https://127.0.0.1:51410/' } };

  let pluginsState = [
    {
      id: 'agy-daddy.alpha',
      displayName: 'Alpha 插件',
      description: '第一个异常插件',
      version: '1.0.0',
      trustLevel: 'T0',
      enabled: true,
      active: false,
      health: {
        active: false,
        crashesInWindow: 0,
        circuitOpen: false,
        lastError: 'GATEWAY_PORT_OCCUPIED: 127.0.0.1:18766 is already in use',
        lastErrorCode: 'PORT_IN_USE',
        lastErrorStage: 'activate',
        lastErrorSuggestion: '请修改端口后重新激活'
      }
    }
  ];

  const bridgeCalls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    bridgeCalls.push({ path: u.pathname, body });

    if (u.pathname === '/host/plugins') {
      return { ok: true, status: 200, json: async () => ({ ok: true, plugins: pluginsState, catalog: [] }) };
    }
    if (u.pathname === '/host/plugins/activate') {
      if (body.all) {
        pluginsState = pluginsState.map((p) => ({
          ...p,
          active: true,
          health: { active: true, crashesInWindow: 0, circuitOpen: false, lastError: null }
        }));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            activated: pluginsState.map((p) => p.id),
            failed: [],
            plugins: pluginsState,
            catalog: []
          })
        };
      }
      pluginsState = pluginsState.map((p) => (p.id === body.pluginId
        ? { ...p, active: true, health: { active: true, crashesInWindow: 0, circuitOpen: false, lastError: null } }
        : p));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          pluginId: body.pluginId,
          active: true,
          plugins: pluginsState,
          catalog: []
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const host = createHostRuntime({
    document: doc,
    window: win,
    fetch: fetchFn,
    bridgePort: 19999,
    hostToken: 'test-token',
    anchorsRegistry: loadAnchorsRegistry(),
    hostSettings: { showTopbarEntry: false, injectNativeSettings: false },
    pluginMeta: {
      'agy-daddy.alpha': pluginsState[0]
    }
  });

  try {
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    const barEl = shadow.querySelector('#agy-topbar-slots');
    const alertBtn = shadow.querySelector('#agy-plugin-alert-btn');

    // 1. 即使隐藏了 Agy 入口，单插件异常胶囊也必须显示在顶栏最右侧
    assert.ok(alertBtn);
    assert.equal(alertBtn.hidden, false);
    assert.equal(alertBtn.getAttribute('data-tone'), 'danger');
    assert.equal(alertBtn.getAttribute('data-issue-count'), '1');
    assert.equal(barEl.children[barEl.children.length - 1].id, 'agy-plugin-alert-btn');

    // 2. 点击单插件异常胶囊 -> 直接打开设置并定位到该插件的诊断区块
    alertBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(host.getSettingsMode(), 'modal');
    const detailHeader = shadow.querySelector('#agy-plugin-detail-header');
    assert.equal(detailHeader?.getAttribute('data-detail-plugin-id'), 'agy-daddy.alpha');
    const diagCard = shadow.querySelector('#agy-plugin-diagnostics-card');
    assert.ok(diagCard);
    assert.equal(diagCard.getAttribute('data-diag-focused'), 'true');
    assert.match(shadow.querySelector('#agy-plugin-diag-error').textContent, /GATEWAY_PORT_OCCUPIED/);
    assert.match(shadow.querySelector('#agy-plugin-diag-suggestion').textContent, /请修改端口后重新激活/);

    // 3. 在诊断区块点击「立即激活」-> 激活成功并自动消除顶栏异常胶囊
    const diagActivateBtn = shadow.querySelector('[data-diag-activate="agy-daddy.alpha"]');
    assert.ok(diagActivateBtn);
    diagActivateBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(bridgeCalls.some((c) => c.path === '/host/plugins/activate' && c.body.pluginId === 'agy-daddy.alpha'));
    assert.equal(shadow.querySelector('#agy-plugin-diagnostics-card').getAttribute('data-diag-status'), 'ok');
    assert.equal(alertBtn.hidden, true);

    host.closeSettings();

    // 4. 多个插件不可用 -> 点击胶囊打开通知列表弹窗，可分别跳转诊断或一键全部重试激活
    pluginsState = [
      {
        id: 'agy-daddy.alpha',
        displayName: 'Alpha 插件',
        version: '1.0.0',
        trustLevel: 'T0',
        enabled: true,
        active: false,
        health: { active: false, crashesInWindow: 0, circuitOpen: false, lastError: 'Alpha 未激活' }
      },
      {
        id: 'agy-daddy.beta',
        displayName: 'Beta 插件',
        version: '1.0.0',
        trustLevel: 'T0',
        enabled: true,
        active: false,
        health: { active: false, crashesInWindow: 3, circuitOpen: true, lastError: 'Beta 已熔断' }
      }
    ];
    host.syncPluginStates({
      'agy-daddy.alpha': pluginsState[0],
      'agy-daddy.beta': pluginsState[1]
    });

    assert.equal(alertBtn.hidden, false);
    assert.equal(alertBtn.getAttribute('data-issue-count'), '2');

    alertBtn.click();
    const alertPopover = shadow.querySelector('#agy-plugin-alert-popover');
    assert.equal(alertPopover.hidden, false);
    assert.ok(shadow.querySelector('[data-alert-plugin-id="agy-daddy.alpha"]'));
    assert.ok(shadow.querySelector('[data-alert-plugin-id="agy-daddy.beta"]'));

    // 点击第二个异常插件 -> 跳转 Beta 诊断
    shadow.querySelector('[data-alert-plugin-id="agy-daddy.beta"]').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(alertPopover.hidden, true);
    assert.equal(shadow.querySelector('#agy-plugin-detail-header')?.getAttribute('data-detail-plugin-id'), 'agy-daddy.beta');
    assert.equal(shadow.querySelector('#agy-plugin-diagnostics-card').getAttribute('data-diag-focused'), 'true');

    // 5. 测试侧边栏展开紧凑态：健康胶囊存在时，溢出按钮应透出高风险圆点且异常通知进入聚合菜单顶部
    await host.mountPlugin('agy-daddy.healthy', {
      mount(ctx) {
        ctx.topbar.registerUnit({ id: 'ok-unit', order: 10, label: 'OK' });
      }
    });
    const auxRoot = doc.createElement('div');
    auxRoot.setAttribute('data-side-panel-open', 'true');
    doc.body.appendChild(auxRoot);
    host.syncAuxSidebar();
    assert.equal(host.isAuxSidebarExpanded(), true);

    const overflowBtn = shadow.querySelector('#agy-topbar-overflow-btn');
    const overflowList = shadow.querySelector('#agy-topbar-overflow-list');
    assert.equal(overflowBtn.querySelector('.ag-unit-dot')?.getAttribute('data-level'), 'danger');
    assert.equal(overflowList.children[0].id, 'agy-plugin-alert-btn');

    // 通过弹窗底部「全部重试激活」一次恢复所有插件
    host.closeSettings();
    alertBtn.click();
    shadow.querySelector('#agy-alert-activate-all-btn').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(bridgeCalls.some((c) => c.path === '/host/plugins/activate' && c.body.all === true));
    assert.equal(alertBtn.hidden, true);
  } finally {
    await host.dispose();
  }
});

test('断链 worktree 检测 + 覆盖悬空软链修复 (/host/plugins/repair auto/relink/uninstall)', async () => {
  buildHostRenderer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-broken-symlink-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const wsDir = path.join(root, 'workspace');
  const mainPluginDir = path.join(wsDir, 'agy-daddy-plugin-webdemo');
  const worktreePluginDir = path.join(root, 'worktree', 'agy-daddy-plugin-webdemo');
  const altPluginDir = path.join(root, 'alt-custom', 'agy-daddy-plugin-webdemo');
  const dummyFlag = path.join(root, 'never.flag');

  fs.mkdirSync(pluginsDir, { recursive: true });
  writeFlagDrivenPlugin(mainPluginDir, {
    id: 'agy-daddy.webdemo',
    displayName: 'Web Demo',
    unitId: 'webdemo',
    unitLabel: 'WebOK',
    flagFile: dummyFlag
  });
  writeFlagDrivenPlugin(worktreePluginDir, {
    id: 'agy-daddy.webdemo',
    displayName: 'Web Demo',
    unitId: 'webdemo',
    unitLabel: 'WebWT',
    flagFile: dummyFlag
  });
  writeFlagDrivenPlugin(altPluginDir, {
    id: 'agy-daddy.webdemo',
    displayName: 'Web Demo',
    unitId: 'webdemo',
    unitLabel: 'WebAlt',
    flagFile: dummyFlag
  });

  // 先软链到主工作区，再覆盖软链到 worktree，最后删除 worktree 制造悬空软链
  await installPlugin(`local:${mainPluginDir}`, { stateDir, pluginsDir, trustLevel: 'T0' });
  await installPlugin(`local:${worktreePluginDir}`, { stateDir, pluginsDir, trustLevel: 'T0' });
  fs.rmSync(path.join(root, 'worktree'), { recursive: true, force: true });

  const cdpHarness = await createLocalCdpHarness();
  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    workspaceRoot: wsDir,
    origin: '*',
    startRetryDelayMs: 5,
    WebSocket: cdpHarness.MockCdpWebSocket,
    cdpOptions: { ports: [cdpHarness.cdpPort], allowLsof: false }
  });

  try {
    const started = await daemon.start();
    assert.equal(daemon.activePlugins.has('agy-daddy.webdemo'), false);
    assert.ok(started.activationErrors.some((e) => e.id === 'agy-daddy.webdemo' && /软链目标已丢失/.test(e.error)));

    const listRes = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins', {});
    const item = listRes.data.plugins.find((p) => p.id === 'agy-daddy.webdemo');
    assert.equal(item.health.lastErrorCode, 'INSTALL_PATH_MISSING');
    assert.equal(item.installHealth.status, 'broken_symlink');
    assert.equal(item.installHealth.symlinkTarget, worktreePluginDir);
    assert.ok(item.installHealth.repairCandidates.length >= 1);
    assert.equal(item.installHealth.repairCandidates[0].target, mainPluginDir);

    // 1. 一键自动修复：应能覆盖悬空软链（不抛 EEXIST）并立即激活且注入 CDP
    const inj = await daemon.injectActiveTargets({ skipActivateInactive: true });
    assert.equal(inj.targetsInjected, 1);

    const repAuto = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins/repair', {
      pluginId: 'agy-daddy.webdemo',
      mode: 'auto'
    });
    assert.equal(repAuto.status, 200);
    assert.equal(repAuto.data.ok, true);
    assert.equal(repAuto.data.repaired, true);
    assert.equal(repAuto.data.active, true);
    assert.equal(daemon.activePlugins.has('agy-daddy.webdemo'), true);
    const fixedItem = repAuto.data.plugins.find((p) => p.id === 'agy-daddy.webdemo');
    assert.equal(fixedItem.installHealth.status, 'ok');
    assert.equal(fixedItem.health.lastError, null);

    // 2. 再次制造悬空软链 -> 手动指定 localPath 重新链接同样成功覆盖悬空软链
    await installPlugin(`local:${altPluginDir}`, { stateDir, pluginsDir, trustLevel: 'T0' });
    fs.rmSync(path.join(root, 'alt-custom'), { recursive: true, force: true });
    await daemon.reloadAll({ rebuildRenderer: false });
    assert.equal(daemon.activePlugins.has('agy-daddy.webdemo'), false);

    const repCustom = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins/repair', {
      pluginId: 'agy-daddy.webdemo',
      mode: 'relink',
      localPath: mainPluginDir
    });
    assert.equal(repCustom.status, 200);
    assert.equal(repCustom.data.ok, true);
    assert.equal(repCustom.data.active, true);
    assert.equal(fs.readlinkSync(path.join(pluginsDir, 'agy-daddy.webdemo')), mainPluginDir);

    // 3. 卸载失效记录可彻底清理索引与悬空软链
    const unRes = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins/uninstall', {
      pluginId: 'agy-daddy.webdemo',
      confirmNativeDelete: true
    });
    assert.equal(unRes.data.ok, true);
    assert.equal(readInstalledIndex({ stateDir }).plugins['agy-daddy.webdemo'], undefined);
  } finally {
    await daemon.stop();
    await cdpHarness.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('已安装列表与诊断区对路径失效插件提供一键修复、手动重链与移除失效记录交互', async () => {
  const doc = createMockDocument();
  const win = { innerWidth: 1920, innerHeight: 1000, location: { href: 'https://127.0.0.1:51410/' } };

  let pluginsState = [
    {
      id: 'agy-daddy.web',
      displayName: 'PC Web 工作台',
      description: 'Web console',
      version: '1.0.0',
      trustLevel: 'T0',
      enabled: true,
      active: false,
      health: {
        active: false,
        crashesInWindow: 0,
        circuitOpen: false,
        lastErrorCode: 'INSTALL_PATH_MISSING',
        lastErrorStage: 'load',
        lastError: 'INSTALL_PATH_MISSING: 软链目标已丢失 (/tmp/deleted-worktree/agy-daddy-plugin-web)'
      },
      installHealth: {
        status: 'broken_symlink',
        exists: false,
        isSymlink: true,
        symlinkTarget: '/tmp/deleted-worktree/agy-daddy-plugin-web',
        repairCandidates: [
          {
            kind: 'rollback',
            label: '恢复上次路径',
            target: '/Volumes/external/Projects/agy-daddy/agy-daddy-plugin-web',
            spec: 'rollback'
          }
        ]
      }
    },
    {
      id: 'third.lost',
      displayName: '已丢失第三方插件',
      description: 'Missing third plugin',
      version: '1.0.0',
      trustLevel: 'T2',
      enabled: true,
      active: false,
      health: {
        active: false,
        crashesInWindow: 0,
        circuitOpen: false,
        lastErrorCode: 'INSTALL_PATH_MISSING',
        lastErrorStage: 'load',
        lastError: 'INSTALL_PATH_MISSING: /tmp/missing-third'
      },
      installHealth: {
        status: 'missing_dir',
        exists: false,
        isSymlink: false,
        symlinkTarget: null,
        repairCandidates: []
      }
    }
  ];

  const bridgeCalls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    bridgeCalls.push({ path: u.pathname, body });

    if (u.pathname === '/host/plugins') {
      return { ok: true, status: 200, json: async () => ({ ok: true, plugins: pluginsState, catalog: [] }) };
    }
    if (u.pathname === '/host/plugins/repair') {
      pluginsState = pluginsState.map((p) => (p.id === body.pluginId
        ? {
            ...p,
            active: true,
            health: { active: true, crashesInWindow: 0, circuitOpen: false, lastError: null },
            installHealth: { status: 'ok', exists: true, isSymlink: true, symlinkTarget: body.localPath || '/repaired', repairCandidates: [] }
          }
        : p));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          repaired: true,
          active: true,
          pluginId: body.pluginId,
          plugins: pluginsState,
          catalog: []
        })
      };
    }
    if (u.pathname === '/host/plugins/uninstall') {
      pluginsState = pluginsState.filter((p) => p.id !== body.pluginId);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          id: body.pluginId,
          plugins: pluginsState,
          catalog: []
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const host = createHostRuntime({
    document: doc,
    window: win,
    fetch: fetchFn,
    bridgePort: 19998,
    hostToken: 'test-token',
    anchorsRegistry: loadAnchorsRegistry(),
    hostSettings: { injectNativeSettings: false },
    pluginMeta: {
      'agy-daddy.web': pluginsState[0],
      'third.lost': pluginsState[1]
    }
  });

  try {
    await host.openSettings({ tab: 'plugins' });
    await new Promise((r) => setTimeout(r, 30));
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 1. 列表页：有恢复源的显示「一键修复」，无恢复源的显示「修复路径」，两者均有「移除」，且不显示无意义的「激活」按钮
    assert.ok(shadow.querySelector('[data-plugin-list-repair="agy-daddy.web"]'));
    assert.ok(shadow.querySelector('[data-plugin-list-remove-broken="agy-daddy.web"]'));
    assert.equal(shadow.querySelector('[data-plugin-list-activate="agy-daddy.web"]'), null);
    assert.ok(shadow.querySelector('[data-plugin-list-inspect-repair="third.lost"]'));
    assert.ok(shadow.querySelector('[data-plugin-list-remove-broken="third.lost"]'));

    // 2. 点击「一键修复」-> 调用 /host/plugins/repair 并恢复 agy-daddy.web 为正常态
    shadow.querySelector('[data-plugin-list-repair="agy-daddy.web"]').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(bridgeCalls.some((c) => c.path === '/host/plugins/repair' && c.body.pluginId === 'agy-daddy.web' && c.body.mode === 'auto'));
    assert.equal(shadow.querySelector('[data-plugin-list-repair="agy-daddy.web"]'), null);

    // 3. 点击 third.lost 的「修复路径」-> 进入诊断区，展示手动路径输入框 + 重新链接 + 移除失效记录
    shadow.querySelector('[data-plugin-list-inspect-repair="third.lost"]').click();
    const pathInp = shadow.querySelector('#agy-plugin-repair-path-input');
    const relinkBtn = shadow.querySelector('[data-diag-relink="third.lost"]');
    const rmDiagBtn = shadow.querySelector('[data-diag-remove-broken="third.lost"]');
    assert.ok(pathInp);
    assert.ok(relinkBtn);
    assert.ok(rmDiagBtn);

    // 两次点击移除失效记录 -> 卸载清理
    rmDiagBtn.click();
    assert.equal(shadow.querySelector('[data-diag-remove-broken="third.lost"]').textContent, '确认移除?');
    shadow.querySelector('[data-diag-remove-broken="third.lost"]').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(bridgeCalls.some((c) => c.path === '/host/plugins/uninstall' && c.body.pluginId === 'third.lost'));
    assert.equal(shadow.querySelector('#agy-plugin-alert-btn').hidden, true);
  } finally {
    await host.dispose();
  }
});
