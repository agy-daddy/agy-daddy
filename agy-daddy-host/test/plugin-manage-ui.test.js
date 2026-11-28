'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { EventEmitter } = require('events');
const { execFileSync } = require('child_process');

const { AgyDaddyDaemon } = require('../src/core/daemon');
const { createHostRuntime } = require('../src/renderer/host-runtime');
const { createMockDocument } = require('../sdk/mock-harness');
const { loadAnchorsRegistry } = require('../src/core/anchors');
const { readInstalledIndex } = require('../src/core/installer');

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

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

test('页面管理后端路由 + UI 可视化装卸/启停/权限确认 + hostToken 绝不泄露到 window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-manage-ui-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const wsDir = path.join(root, 'workspace');
  const demoDir = path.join(wsDir, 'agy-daddy-plugin-demo');
  fs.mkdirSync(path.join(demoDir, 'src'), { recursive: true });

  fs.writeFileSync(path.join(demoDir, 'package.json'), JSON.stringify({
    name: '@third/demo',
    version: '1.0.0'
  }, null, 2));
  fs.writeFileSync(path.join(demoDir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'third.demo',
    publisher: 'third',
    version: '1.0.0',
    displayName: { 'zh-CN': '演示可装卸插件', en: 'Demo Manage Plugin' },
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    renderer: './src/renderer.js',
    world: 'isolated',
    permissions: ['dom:write', 'bridge:route', 'process:spawn'],
    contributes: { 'topbar.units': [{ id: 'demo-unit', order: 65 }] }
  }, null, 2));
  fs.writeFileSync(path.join(demoDir, 'src', 'node.js'), `
'use strict';
let stopRoute = null;
async function activate(host) {
  stopRoute = await host.bridge.registerRoute('/ping', async () => ({ pong: true }));
}
async function deactivate() {
  if (typeof stopRoute === 'function') stopRoute();
  stopRoute = null;
}
module.exports = { activate, deactivate };
`);
  fs.writeFileSync(path.join(demoDir, 'src', 'renderer.js'), `
'use strict';
let stop = null;
function mount(ctx) {
  stop = ctx.topbar.registerUnit({ id: 'demo-unit', order: 65, label: 'DemoOK' });
}
function dispose() {
  if (typeof stop === 'function') stop();
  stop = null;
}
module.exports = { mount, dispose };
`);

  const cdpHarness = await createLocalCdpHarness();
  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    workspaceRoot: wsDir,
    origin: '*',
    WebSocket: cdpHarness.MockCdpWebSocket,
    cdpOptions: { ports: [cdpHarness.cdpPort], allowLsof: false }
  });

  try {
    const started = await daemon.start();
    const inj = await daemon.injectActiveTargets();
    assert.equal(inj.targetsInjected, 1);

    // 1. 严禁泄露 hostToken / bootOptions 到 window 或 __AGYDaddyHost
    assert.ok(cdpHarness.mainCtx.__AGYDaddyHost);
    assert.equal(cdpHarness.mainCtx.__AGYDaddyHost.hostToken, undefined);
    assert.equal(cdpHarness.mainCtx.__AGY_DADDY_BOOT_OPTIONS__, undefined);

    // 2. 通过主机路由测试 catalog、权限拦截、授权安装、停用、启用、卸载
    const list1 = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins', {});
    assert.equal(list1.status, 200);
    assert.equal(list1.data.plugins.length, 0);
    assert.ok(list1.data.catalog.some((c) => c.id === 'third.demo'));

    // T2 声明了 process:spawn 高危权限，首次安装必须返回 needsPermissionConfirm
    const needPerm = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins/install', {
      spec: `local:${demoDir}`
    });
    assert.equal(needPerm.status, 200);
    assert.equal(needPerm.data.ok, false);
    assert.equal(needPerm.data.needsPermissionConfirm, true);
    assert.ok(needPerm.data.trustPolicy.denied.includes('process:spawn'));

    // 确认授权并安装 -> 自动热激活与热注入 CDP 页面
    const instOk = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins/install', {
      spec: `local:${demoDir}`,
      trustLevel: 'T2',
      grantedPermissions: needPerm.data.trustPolicy.denied
    });
    assert.equal(instOk.data.ok, true);
    assert.equal(instOk.data.plugin.id, 'third.demo');
    assert.equal(daemon.activePlugins.has('third.demo'), true);

    const getBarTexts = () => cdpHarness.mockDoc.getElementById('agy-daddy-host')
      .shadowRoot.querySelector('#agy-topbar-slots').children.map((c) => c.textContent);
    assert.ok(getBarTexts().includes('DemoOK'));

    // 停用 -> 立即从 activePlugins 与 DOM 卸下
    const disRes = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins/toggle', {
      pluginId: 'third.demo',
      enabled: false
    });
    assert.equal(disRes.data.ok, true);
    assert.equal(daemon.activePlugins.has('third.demo'), false);
    assert.equal(getBarTexts().includes('DemoOK'), false);
    assert.equal(readInstalledIndex({ stateDir }).plugins['third.demo'].enabled, false);

    // 启用 -> 立即热恢复
    const enRes = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins/toggle', {
      pluginId: 'third.demo',
      enabled: true
    });
    assert.equal(enRes.data.ok, true);
    assert.equal(daemon.activePlugins.has('third.demo'), true);
    assert.ok(getBarTexts().includes('DemoOK'));

    // 3. 在渲染器 UI 中端到端操作「插件管理」页面（触发安装确认 + 卸载）
    const uiDoc = createMockDocument();
    const uiWin = { location: { href: 'https://127.0.0.1:51410/' } };
    const uiHost = createHostRuntime({
      document: uiDoc,
      window: uiWin,
      fetch: globalThis.fetch,
      anchorsRegistry: loadAnchorsRegistry(),
      bridgePort: started.port,
      hostToken: daemon.bridge.hostToken
    });
    try {
      assert.equal(uiWin.__AGYDaddyHost.hostToken, undefined);
      uiHost.toggleSettingsPanel(true);
      const shadow = uiDoc.getElementById('agy-daddy-host').shadowRoot;
      assert.ok(shadow.querySelector('#agy-tab-plugins'));
      await waitFor(() => Boolean(shadow.querySelector('[data-plugin-toggle="third.demo"]')));

      const card = shadow.querySelector('#agy-manage-settings-card');
      assert.ok(card);
      assert.ok(shadow.querySelector('[data-plugin-toggle="third.demo"]'));

      // 下钻进入 third.demo 二级详情页并测试二次确认卸载
      const detailBtn = shadow.querySelector('[data-plugin-detail="third.demo"]');
      assert.ok(detailBtn);
      detailBtn.click();
      assert.ok(shadow.querySelector('#agy-detail-back-btn'));

      const unBtn = shadow.querySelector('[data-plugin-uninstall="third.demo"]');
      assert.equal(unBtn.textContent, '卸载');
      unBtn.click();
      assert.equal(shadow.querySelector('[data-plugin-uninstall="third.demo"]').textContent, '确认卸载?');
      shadow.querySelector('[data-plugin-uninstall="third.demo"]').click();
      await waitFor(() => !daemon.activePlugins.has('third.demo') && Boolean(shadow.querySelector('[data-catalog-install="third.demo"]')));

      assert.equal(daemon.activePlugins.has('third.demo'), false);
      assert.equal(readInstalledIndex({ stateDir }).plugins['third.demo'], undefined);
      assert.ok(shadow.querySelector('[data-catalog-install="third.demo"]'));

      // 顶部常驻安装条直接输入路径触发权限确认卡 -> 点授权并安装装回
      const inp = shadow.querySelector('#agy-plugin-install-input');
      inp.value = `local:${demoDir}`;
      shadow.querySelector('#agy-plugin-install-btn').click();
      await waitFor(() => Boolean(shadow.querySelector('#agy-perm-confirm-btn')));

      const permConfirmBtn = shadow.querySelector('#agy-perm-confirm-btn');
      assert.ok(permConfirmBtn, 'Expected permission confirmation UI');
      permConfirmBtn.click();
      await waitFor(() => daemon.activePlugins.has('third.demo') && Boolean(shadow.querySelector('[data-plugin-toggle="third.demo"]')));

      assert.equal(daemon.activePlugins.has('third.demo'), true);
      assert.ok(shadow.querySelector('[data-plugin-toggle="third.demo"]'));
    } finally {
      await uiHost.dispose();
    }
  } finally {
    await daemon.stop();
    await cdpHarness.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('原生扩展插件详情页：可配置注入开关、Rules 备份撤回与卸载提示弹窗确认', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-native-ui-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const nativeDir = path.join(root, 'native-plugins');
  const nativePluginDir = path.join(root, 'native-demo-plugin');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(nativeDir, { recursive: true });
  fs.mkdirSync(path.join(nativePluginDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(nativePluginDir, 'native', 'skills', 'demo-skill'), { recursive: true });

  fs.writeFileSync(path.join(nativePluginDir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'agy-daddy.nativedemo',
    publisher: 'agy-daddy',
    version: '1.0.0',
    license: 'MIT',
    displayName: { 'zh-CN': '原生测试插件', en: 'Native Demo' },
    description: { 'zh-CN': '测试原生注入配置与卸载确认', en: 'Test native config' },
    engines: { agyDaddy: '^1.0.0', antigravity: '>=2.32.0' },
    main: './src/node.js',
    renderer: './src/renderer.js',
    world: 'isolated',
    activationEvents: ['onStartup'],
    permissions: ['dom:write', 'native:install'],
    contributes: {
      native: {
        rules: ['./native/demo-rule.md'],
        skills: ['./native/skills']
      }
    }
  }, null, 2));
  fs.writeFileSync(path.join(nativePluginDir, 'src', 'node.js'), 'exports.activate = () => {};');
  fs.writeFileSync(path.join(nativePluginDir, 'src', 'renderer.js'), 'exports.mount = () => {};');
  fs.writeFileSync(path.join(nativePluginDir, 'native', 'demo-rule.md'), '# Plugin Rule v1\n', 'utf8');
  fs.writeFileSync(path.join(nativePluginDir, 'native', 'skills', 'demo-skill', 'SKILL.md'), '# Demo Skill\n', 'utf8');

  // 预置用户原有规则文件，验证注入前备份 + UI 撤回恢复
  const targetNativeDir = path.join(nativeDir, 'agy-daddy-nativedemo');
  const existingRulePath = path.join(targetNativeDir, 'rules', 'demo-rule.md');
  fs.mkdirSync(path.dirname(existingRulePath), { recursive: true });
  fs.writeFileSync(existingRulePath, '# User Original Rule\n', 'utf8');

  const cdpHarness = await createLocalCdpHarness();
  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    nativePluginsDir: nativeDir,
    workspaceRoot: path.join(root, 'empty-ws'),
    cdpPort: cdpHarness.cdpPort,
    WebSocketImpl: cdpHarness.MockCdpWebSocket,
    skipSingleInstanceLock: true,
    skipHeartbeat: true,
    pluginList: []
  });

  try {
    const started = await daemon.start();
    const instRes = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins/install', {
      spec: `local:${nativePluginDir}`,
      trustLevel: 'T0'
    });
    assert.equal(instRes.data.ok, true);
    assert.equal(fs.readFileSync(existingRulePath, 'utf8'), '# Plugin Rule v1\n');

    // 未确认 confirmNativeDelete 时，后端卸载必须拦截且不删除文件
    const blockedRes = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins/uninstall', {
      pluginId: 'agy-daddy.nativedemo'
    });
    assert.equal(blockedRes.data.ok, false);
    assert.equal(blockedRes.data.needsNativeUninstallConfirm, true);
    assert.equal(fs.existsSync(existingRulePath), true);

    const uiDoc = createMockDocument();
    const uiWin = { location: { href: 'https://127.0.0.1:51410/' } };
    const uiHost = createHostRuntime({
      document: uiDoc,
      window: uiWin,
      fetch: globalThis.fetch,
      anchorsRegistry: loadAnchorsRegistry(),
      bridgePort: started.port,
      hostToken: daemon.bridge.hostToken
    });

    try {
      uiHost.toggleSettingsPanel(true);
      const shadow = uiDoc.getElementById('agy-daddy-host').shadowRoot;
      await waitFor(() => Boolean(shadow.querySelector('[data-plugin-detail="agy-daddy.nativedemo"]')));

      const detailBtn = shadow.querySelector('[data-plugin-detail="agy-daddy.nativedemo"]');
      assert.ok(detailBtn);
      detailBtn.click();

      // 1. 详情页渲染原生扩展注入开关与 Rules 撤回按钮
      assert.ok(shadow.querySelector('#agy-native-injection-card'));
      const skillsToggle = shadow.querySelector('[data-native-toggle="agy-daddy.nativedemo:skills"]');
      assert.ok(skillsToggle);
      assert.equal(skillsToggle.checked, true);

      // 关闭 skills 注入开关
      skillsToggle.checked = false;
      skillsToggle.dispatchEvent({ type: 'change' });
      await waitFor(() => !fs.existsSync(path.join(targetNativeDir, 'skills')) && shadow.querySelector('[data-native-toggle="agy-daddy.nativedemo:skills"]')?.checked === false);
      assert.equal(fs.existsSync(path.join(targetNativeDir, 'skills')), false);
      assert.equal(shadow.querySelector('[data-native-toggle="agy-daddy.nativedemo:skills"]').checked, false);

      // 2. 点击「撤回 Rules」恢复用户原始规则文件内容
      const rbRulesBtn = shadow.querySelector('[data-native-rules-rollback="agy-daddy.nativedemo"]');
      assert.ok(rbRulesBtn);
      assert.equal(rbRulesBtn.disabled, false);
      rbRulesBtn.click();
      await waitFor(() => fs.readFileSync(existingRulePath, 'utf8') === '# User Original Rule\n');
      assert.equal(fs.readFileSync(existingRulePath, 'utf8'), '# User Original Rule\n');

      // 3. 点击卸载必须弹出原生扩展删除确认框，取消不删除，确认后才卸载并删除原生目录
      const unBtn = shadow.querySelector('[data-plugin-uninstall="agy-daddy.nativedemo"]');
      unBtn.click();
      assert.ok(shadow.querySelector('#agy-native-uninstall-confirm-box'));
      assert.equal(fs.existsSync(targetNativeDir), true);

      shadow.querySelector('#agy-native-uninstall-cancel-btn').click();
      assert.equal(shadow.querySelector('#agy-native-uninstall-confirm-box'), null);
      assert.equal(fs.existsSync(targetNativeDir), true);

      shadow.querySelector('[data-plugin-uninstall="agy-daddy.nativedemo"]').click();
      await waitFor(() => shadow.querySelector('#agy-native-uninstall-confirm-btn')?.disabled === false);
      const confirmUninstall = shadow.querySelector('#agy-native-uninstall-confirm-btn');
      assert.equal(confirmUninstall?.disabled, false);
      confirmUninstall.click();
      await waitFor(() => readInstalledIndex({ stateDir }).plugins['agy-daddy.nativedemo'] === undefined && !fs.existsSync(targetNativeDir));

      assert.equal(readInstalledIndex({ stateDir }).plugins['agy-daddy.nativedemo'], undefined);
      assert.equal(fs.existsSync(targetNativeDir), false);
    } finally {
      await uiHost.dispose();
    }
  } finally {
    await daemon.stop();
    await cdpHarness.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('全屏插件市场搜索 T1 插件、三项高危权限确认弹窗与免重启热加载挂载', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-market-t1-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const emptyWs = path.join(root, 'empty-ws');
  const originDir = path.join(root, 'origin-design-plugin');
  const registryPath = path.join(root, 'registry.json');
  fs.mkdirSync(emptyWs, { recursive: true });
  fs.mkdirSync(path.join(originDir, 'src'), { recursive: true });

  fs.writeFileSync(path.join(originDir, 'package.json'), JSON.stringify({
    name: 'agy-plugin-design',
    version: '0.1.0'
  }, null, 2));
  fs.writeFileSync(path.join(originDir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'hubo1989.design',
    publisher: 'hubo1989',
    version: '0.1.0',
    displayName: { 'zh-CN': 'Agy Design Studio', en: 'Agy Design Studio' },
    description: '本地优先的 Antigravity 可视化设计工作台',
    category: 'design',
    tags: ['design', 'slides', 'canvas'],
    engines: { agyDaddy: '^1.0.0', antigravity: '>=2.32.0' },
    main: './src/node.js',
    renderer: './src/renderer.js',
    world: 'isolated',
    permissions: ['dom:read', 'dom:write', 'rpc:read', 'fs:user-files', 'net:listen', 'process:spawn'],
    contributes: { 'topbar.units': [{ id: 'design', order: 48 }] }
  }, null, 2));
  fs.writeFileSync(path.join(originDir, 'src', 'node.js'), `
'use strict';
async function activate() {}
async function deactivate() {}
module.exports = { activate, deactivate };
`);
  fs.writeFileSync(path.join(originDir, 'src', 'renderer.js'), `
'use strict';
let stop = null;
function mount(ctx) {
  stop = ctx.topbar.registerUnit({ id: 'design', order: 48, label: 'Design' });
}
function dispose() {
  if (typeof stop === 'function') stop();
  stop = null;
}
module.exports = { mount, dispose };
`);

  execFileSync('git', ['init', '-b', 'main'], { cwd: originDir });
  execFileSync('git', ['config', 'user.email', 'test@agy-daddy.local'], { cwd: originDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: originDir });
  execFileSync('git', ['add', '.'], { cwd: originDir });
  execFileSync('git', ['commit', '-m', 'init v0.1.0'], { cwd: originDir });

  fs.writeFileSync(registryPath, JSON.stringify({
    schemaVersion: 1,
    organization: 'agy-daddy',
    plugins: [
      {
        shortName: 'design',
        id: 'hubo1989.design',
        publisher: 'hubo1989',
        name: 'Agy Design Studio',
        version: '0.1.0',
        layer: 4,
        category: 'design',
        tags: ['design', 'slides', 'canvas'],
        trustLevel: 'T1',
        defaultEnabled: false,
        external: true,
        repo: `file://${originDir}`,
        ref: 'v0.1.0',
        permissions: ['dom:read', 'dom:write', 'rpc:read', 'fs:user-files', 'net:listen', 'process:spawn'],
        description: '本地优先的 Antigravity 可视化设计工作台'
      }
    ]
  }, null, 2));

  const cdpHarness = await createLocalCdpHarness();
  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    registryPath,
    workspaceRoot: emptyWs,
    origin: '*',
    WebSocket: cdpHarness.MockCdpWebSocket,
    cdpOptions: { ports: [cdpHarness.cdpPort], allowLsof: false }
  });

  try {
    const started = await daemon.start();
    const inj = await daemon.injectActiveTargets();
    assert.equal(inj.targetsInjected, 1);

    const listRes = await postHost(started.port, daemon.bridge.hostToken, '/host/plugins', {});
    const catItem = listRes.data.catalog.find((c) => c.id === 'hubo1989.design');
    assert.ok(catItem);
    assert.equal(catItem.version, '0.1.0');
    assert.equal(catItem.category, 'design');
    assert.deepEqual(catItem.tags, ['design', 'slides', 'canvas']);
    assert.equal(catItem.permissions.length, 6);

    const uiDoc = createMockDocument();
    const uiWin = { location: { href: 'https://127.0.0.1:51410/' } };
    const uiHost = createHostRuntime({
      document: uiDoc,
      window: uiWin,
      fetch: globalThis.fetch,
      anchorsRegistry: loadAnchorsRegistry(),
      bridgePort: started.port,
      hostToken: daemon.bridge.hostToken
    });

    try {
      uiHost.toggleSettingsPanel(true);
      const shadow = uiDoc.getElementById('agy-daddy-host').shadowRoot;
      await waitFor(() => Boolean(shadow.querySelector('#agy-marketplace-more-btn')));

      // 进入全屏插件市场页
      shadow.querySelector('#agy-marketplace-more-btn').click();
      await waitFor(() => Boolean(shadow.querySelector('#agy-marketplace-full-grid')));

      // 通过 tag/shortName 检索命中 Agy Design Studio
      const searchInp = shadow.querySelector('#agy-settings-search');
      searchInp.value = 'slides';
      searchInp.dispatchEvent({ type: 'input' });
      assert.ok(shadow.querySelector('[data-catalog-id="hubo1989.design"]'));

      searchInp.value = 'design';
      searchInp.dispatchEvent({ type: 'input' });
      const installBtn = shadow.querySelector('[data-catalog-install="hubo1989.design"]');
      assert.ok(installBtn);

      // 点击安装应在全屏市场页原地弹出 #agy-perm-confirm-box 并完整显示 3 项高危权限
      installBtn.click();
      await waitFor(() => Boolean(shadow.querySelector('#agy-perm-confirm-box')));

      const permBox = shadow.querySelector('#agy-perm-confirm-box');
      assert.ok(permBox, 'Expected #agy-perm-confirm-box in full marketplace view');
      const chipTexts = permBox.querySelectorAll('.ag-chip').map((el) => el.textContent);
      assert.ok(chipTexts.includes('process:spawn'), `Missing process:spawn in ${JSON.stringify(chipTexts)}`);
      assert.ok(chipTexts.includes('fs:user-files'), `Missing fs:user-files in ${JSON.stringify(chipTexts)}`);
      assert.ok(chipTexts.includes('net:listen'), `Missing net:listen in ${JSON.stringify(chipTexts)}`);

      // 点击「授权并安装」完成安装（含 ref tag 未创建回退默认分支）并热加载挂载顶栏
      shadow.querySelector('#agy-perm-confirm-btn').click();
      await waitFor(() => daemon.activePlugins.has('hubo1989.design'));

      assert.equal(daemon.activePlugins.has('hubo1989.design'), true);
      const getBarTexts = () => cdpHarness.mockDoc.getElementById('agy-daddy-host')
        .shadowRoot.querySelector('#agy-topbar-slots').children.map((c) => c.textContent);
      assert.ok(getBarTexts().includes('Design'), 'Expected Design topbar unit mounted via hot reload');
    } finally {
      await uiHost.dispose();
    }
  } finally {
    await daemon.stop();
    await cdpHarness.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
