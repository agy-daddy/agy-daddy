'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { AgyDaddyDaemon } = require('../src/core/daemon');
const { safeWriteJsonSync } = require('../src/core/storage');
const { createMockDocument } = require('../sdk/mock-harness');
const { version: hostPackageVersion } = require('../package.json');

const HOST_ROOT = path.resolve(__dirname, '..');

function createMockLocalStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); }
  };
}

function createRealEnvShim(mockDoc, extra = {}) {
  class MockCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  class MockMutationObserver {
    observe() {}
    disconnect() {}
  }
  const activeTimeouts = new Set();
  const activeIntervals = new Set();
  function trackedSetTimeout(fn, delay, ...args) {
    const id = setTimeout(() => {
      activeTimeouts.delete(id);
      fn(...args);
    }, delay);
    activeTimeouts.add(id);
    return id;
  }
  function trackedClearTimeout(id) {
    activeTimeouts.delete(id);
    clearTimeout(id);
  }
  function trackedSetInterval(fn, delay, ...args) {
    const id = setInterval(fn, delay, ...args);
    activeIntervals.add(id);
    return id;
  }
  function trackedClearInterval(id) {
    activeIntervals.delete(id);
    clearInterval(id);
  }
  function clearTimers() {
    for (const id of activeTimeouts) clearTimeout(id);
    for (const id of activeIntervals) clearInterval(id);
    activeTimeouts.clear();
    activeIntervals.clear();
  }
  const base = {
    document: mockDoc,
    fetch: globalThis.fetch,
    CustomEvent: MockCustomEvent,
    MutationObserver: MockMutationObserver,
    console,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    ...extra
  };
  return { ctx: vm.createContext(base), clearTimers };
}

function createMockCdpTargetServer(pageUrl = 'https://127.0.0.1:51410/11111111-2222-3333-4444-555555555555') {
  const sockets = new Set();
  const realmCleanups = [];
  let mockDoc = createMockDocument();
  let localStorage = createMockLocalStorage();
  let mainCtx = createNewMainContext();
  let nextIsoId = 100;
  let isoContexts = new Map();

  function destroyAllRealms() {
    for (const fn of realmCleanups) {
      try { fn(); } catch {}
    }
    realmCleanups.length = 0;
  }

  function createNewMainContext() {
    const { ctx, clearTimers } = createRealEnvShim(mockDoc, {
      location: { href: pageUrl },
      localStorage,
      __APP_CONFIG__: { csrfToken: 'main-world-csrf-secret' }
    });
    ctx.window = ctx;
    ctx.self = ctx;
    ctx.globalThis = ctx;
    realmCleanups.push(clearTimers);
    return ctx;
  }

  function sendWsText(socket, text) {
    if (socket.destroyed) return;
    const payload = Buffer.from(text, 'utf8');
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  function broadcastEvent(method, params) {
    const raw = JSON.stringify({ method, params });
    for (const s of sockets) sendWsText(s, raw);
  }

  async function handleCdpCommand(socket, msg) {
    const reply = (res) => sendWsText(socket, JSON.stringify(res));
    if (msg.method === 'Runtime.enable') {
      reply({ id: msg.id, result: {} });
      reply({ method: 'Runtime.executionContextCreated', params: { context: { id: 1, origin: 'https://127.0.0.1:51410' } } });
      return;
    }
    if (msg.method === 'Page.enable') {
      reply({ id: msg.id, result: {} });
      return;
    }
    if (msg.method === 'Page.getFrameTree') {
      reply({ id: msg.id, result: { frameTree: { frame: { id: 'frame-main', url: pageUrl } } } });
      return;
    }
    if (msg.method === 'Page.createIsolatedWorld') {
      const ctxId = nextIsoId++;
      const { ctx: isoCtx, clearTimers } = createRealEnvShim(mockDoc, {
        location: { href: pageUrl }
      });
      isoCtx.globalThis = isoCtx;
      isoCtx.self = isoCtx;
      realmCleanups.push(clearTimers);
      isoContexts.set(ctxId, isoCtx);
      reply({ id: msg.id, result: { executionContextId: ctxId } });
      return;
    }
    if (msg.method === 'Runtime.evaluate') {
      const ctxId = msg.params?.contextId;
      const targetCtx = typeof ctxId === 'number' ? isoContexts.get(ctxId) : mainCtx;
      if (!targetCtx) {
        reply({ id: msg.id, error: { message: `Execution context ${ctxId} destroyed` } });
        return;
      }
      try {
        let value = vm.runInContext(msg.params.expression, targetCtx);
        if (msg.params.awaitPromise !== false && value && typeof value.then === 'function') {
          value = await value;
        }
        const safeValue = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
        reply({ id: msg.id, result: { result: { value: safeValue } } });
      } catch (err) {
        reply({
          id: msg.id,
          result: {
            exceptionDetails: {
              text: err?.message || String(err),
              exception: { description: err?.stack || err?.message || String(err) }
            }
          }
        });
      }
      return;
    }
    reply({ id: msg.id, result: {} });
  }

  const server = http.createServer((req, res) => {
    const port = server.address().port;
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        {
          id: 'target-main',
          type: 'page',
          title: 'Antigravity',
          url: pageUrl,
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/target-main`
        }
      ]));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        if (opcode === 0x8) { socket.end(); return; }
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const need = offset + (masked ? 4 : 0) + len;
        if (buf.length < need) return;
        let payload = buf.subarray(offset + (masked ? 4 : 0), need);
        if (masked) {
          const mask = buf.subarray(offset, offset + 4);
          payload = Buffer.from(payload);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buf = buf.subarray(need);
        if (opcode === 0x1) {
          const msg = JSON.parse(payload.toString('utf8'));
          void handleCdpCommand(socket, msg);
        }
      }
    });
  });

  return {
    getState: () => ({ mockDoc, mainCtx, isoContexts, localStorage }),
    simulateNavigation() {
      destroyAllRealms();
      mockDoc = createMockDocument();
      localStorage = createMockLocalStorage();
      isoContexts = new Map();
      mainCtx = createNewMainContext();
      broadcastEvent('Runtime.executionContextsCleared', {});
      broadcastEvent('Page.frameNavigated', { frame: { id: 'frame-main', url: pageUrl } });
    },
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      destroyAllRealms();
      for (const s of sockets) {
        try { s.destroy(); } catch {}
      }
      await new Promise((resolve) => {
        server.close(() => resolve());
        try { server.closeAllConnections?.(); } catch {}
      });
    }
  };
}

test('CdpInjector 全员 Isolated World 端到端（真实 dist/host-renderer.js）：Boot 元数据、跨世界全能力、热重载与导航重注', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-inj-e2e-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });

  // 1. 准备 Isolated 插件 A（提供 surface + isolated service + Node command）
  const pluginADir = path.join(pluginsDir, 'agy-daddy.iso-provider');
  fs.mkdirSync(path.join(pluginADir, 'src'), { recursive: true });
  safeWriteJsonSync(path.join(pluginADir, 'agy-plugin.json'), {
    schemaVersion: 1,
    id: 'agy-daddy.iso-provider',
    publisher: 'agy-daddy',
    version: '1.0.0',
    displayName: 'Iso Provider',
    description: 'Provides surface and isolated service',
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    renderer: './src/renderer.js',
    world: 'isolated',
    permissions: ['dom:write'],
    provides: {
      surfaces: ['chat.search'],
      services: { isosvc: { version: '1.0.0', realm: 'page-isolated' } }
    },
    contributes: {
      'topbar.units': [{ id: 'prov-unit', order: 10 }],
      commands: [{ id: 'provider.echo', title: 'Echo' }],
      settings: { schema: './settings.schema.json' }
    }
  });
  safeWriteJsonSync(path.join(pluginADir, 'settings.schema.json'), {
    title: 'Provider Settings',
    fields: [{ key: 'prefix', type: 'string', default: 'P' }]
  });
  fs.writeFileSync(path.join(pluginADir, 'src', 'node.js'), `
    let stopCmd = null;
    module.exports = {
      activate(host) {
        stopCmd = host.commands.register('provider.echo', (arg) => ({
          ok: true,
          prefix: host.settings.get().prefix,
          arg
        }));
      },
      deactivate() { if (stopCmd) stopCmd(); }
    };
  `);
  fs.writeFileSync(path.join(pluginADir, 'src', 'renderer.js'), `
    let stops = [];
    module.exports = {
      async mount(ctx) {
        const slot = document.createElement('div');
        slot.id = 'provider-surface-box';
        document.body.appendChild(slot);
        stops.push(() => slot.remove());
        stops.push(ctx.surfaces.provide('chat.search', slot));
        stops.push(ctx.services.provide('isosvc', {
          greet(name) { return { hello: name, from: 'isolated-provider' }; }
        }));
        stops.push(ctx.topbar.registerUnit({ id: 'prov-unit', order: 10, label: 'Prov' }));
      },
      dispose() { for (const f of stops) try { f(); } catch {} stops = []; }
    };
  `);

  // 2. 准备 Isolated 插件 B（消费 surface + fallback、styles、unit/popover render、events/state/services/settings/commands/hostDom）
  const pluginBDir = path.join(pluginsDir, 'third.iso-consumer');
  fs.mkdirSync(path.join(pluginBDir, 'src'), { recursive: true });
  safeWriteJsonSync(path.join(pluginBDir, 'agy-plugin.json'), {
    schemaVersion: 1,
    id: 'third.iso-consumer',
    publisher: 'third',
    version: '1.0.0',
    displayName: 'Iso Consumer',
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    renderer: './src/renderer.js',
    world: 'isolated',
    permissions: ['dom:write'],
    contributes: {
      'topbar.units': [{ id: 'iso-badge', order: 20 }],
      settings: { schema: './settings.schema.json' }
    }
  });
  safeWriteJsonSync(path.join(pluginBDir, 'settings.schema.json'), {
    title: 'Consumer Settings',
    fields: [{ key: 'tag', type: 'string', default: 'init' }]
  });
  fs.writeFileSync(path.join(pluginBDir, 'src', 'node.js'), `
    let logs = [];
    module.exports = {
      async activate(host) {
        await host.commands.register('consumer.report', (payload) => {
          if (payload !== undefined) logs.push(payload);
          return { count: logs.length, last: logs[logs.length - 1] || null, all: logs };
        });
      },
      async deactivate() { logs = []; }
    };
  `);
  function writeConsumerRenderer(verTag) {
    fs.writeFileSync(path.join(pluginBDir, 'src', 'renderer.js'), `
      let stops = [];
      module.exports = {
        async mount(ctx) {
          const surfaceMounts = [];
          const receivedEvents = [];
          const stateUpdates = [];
          const settingsUpdates = [];
          let popoverEvents = [];
          let unitClicked = 0;

          stops.push(ctx.styles.inject('.iso-doc-test{color:#a78bfa;}', { scope: 'document', id: 'doc-css' }));
          stops.push(ctx.styles.inject('.iso-sh-test{color:#c4b5fd;}', { scope: 'shadow', id: 'sh-css' }));

          stops.push(ctx.topbar.registerUnit({
            id: 'iso-badge',
            order: 20,
            label: 'Iso${verTag}',
            badge: '1',
            tone: 'accent',
            render(node) { node.setAttribute('data-rendered-ver', '${verTag}'); },
            onClick() { unitClicked++; }
          }));

          const pop = ctx.topbar.registerPopover({
            id: 'iso-pop',
            anchorId: 'iso-badge',
            title: 'Iso Popover',
            render(bodyNode) {
              const p = document.createElement('p');
              p.textContent = 'body-${verTag}';
              bodyNode.appendChild(p);
            },
            onToggle(open) { popoverEvents.push(open); }
          });
          stops.push(() => pop.dispose());

          stops.push(ctx.surfaces.mount('chat.search', (el, meta) => {
            surfaceMounts.push({ id: el.id || el.className, fallback: meta.fallback });
            const chip = document.createElement('span');
            chip.id = 'mounted-in-surface';
            el.appendChild(chip);
            return () => chip.remove();
          }, { fallbackAnchor: 'composer.root' }));

          stops.push(ctx.events.on('demo:ping@1', (p) => receivedEvents.push(p)));
          stops.push(ctx.state.subscribe('state:demo.counter@1', (v, meta) => stateUpdates.push({ v, version: meta.version })));
          stops.push(ctx.settings.onChange((vals, keys) => settingsUpdates.push({ vals, keys })));

          await ctx.events.emit('demo:ping@1', { ver: '${verTag}' });
          await ctx.state.set('state:demo.counter@1', { n: 1 });
          await ctx.state.set('state:demo.counter@1', { n: 2 });
          await pop.toggle(true);
          await ctx.settings.open('appearance');
          await ctx.settings.open({ tab: 'plugins', pluginId: 'third.iso-consumer' });

          const greetRes = await ctx.services.get('isosvc').greet('${verTag}');
          const echoCmd = await ctx.commands.execute('provider.echo', ['hi-${verTag}']);
          const sysSettings = await ctx.bridge.post('/__settings', { action: 'get' });
          const initCfg = ctx.settings.get();
          await ctx.topbar.updateUnit('iso-badge', { label: 'Iso${verTag}-Upd' });

          const sessionId = ctx.hostDom.getSessionId();
          const hasComposer = Boolean(ctx.hostDom.getComposer());

          globalThis.__ISO_INSPECT__ = () => ({
            surfaceMounts,
            receivedEvents,
            stateUpdates,
            settingsUpdates,
            popoverEvents,
            unitClicked,
            currentSettings: ctx.settings.get()
          });

          await ctx.bridge.post('/__command', {
            commandId: 'consumer.report',
            args: [{
              ver: '${verTag}',
              greetRes,
              echoCmd,
              sysSettings,
              initCfg,
              sessionId,
              hasComposer,
              hasAppConfig: typeof __APP_CONFIG__ !== 'undefined',
              hasHostGlobal: typeof __AGYDaddyHost !== 'undefined'
            }]
          });
        },
        dispose() { for (const f of stops) try { f(); } catch {} stops = []; }
      };
    `);
  }
  writeConsumerRenderer('V1');

  const cdpServer = createMockCdpTargetServer();
  const cdpPort = await cdpServer.start();

  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    origin: '*',
    reinjectDebounceMs: 25,
    cdpOptions: { ports: [cdpPort], allowLsof: false },
    plugins: [
      { id: 'agy-daddy.iso-provider', trustLevel: 'T0', installPath: pluginADir, grantedPermissions: ['dom:write'], enabled: true },
      { id: 'third.iso-consumer', trustLevel: 'T2', installPath: pluginBDir, grantedPermissions: ['dom:write'], enabled: true }
    ]
  });

  try {
    daemon.saveHostSettings({ themeMode: 'dark', maxVisibleUnits: 5 });
    const started = await daemon.start();
    assert.deepEqual(started.activationErrors, []);

    const injRes = await daemon.injectActiveTargets();
    assert.equal(injRes.targetsInjected, 1);
    assert.equal(injRes.pluginsInjected, 2);
    assert.deepEqual(injRes.errors, []);

    const { mockDoc, mainCtx, isoContexts } = cdpServer.getState();

    // 1. 验证真实 dist/host-renderer.js 正确消费 Boot Options 且不泄露全局 Token / 内部通道
    assert.ok(mainCtx.__AGYDaddyHost);
    assert.equal(mainCtx.__AGYDaddyHost.version, hostPackageVersion);
    assert.equal(mainCtx.__AGY_DADDY_BOOT_OPTIONS__, undefined);
    assert.equal(mainCtx.__AGYDaddyHost.xworldChannelName, undefined);
    assert.equal(mainCtx.__AGYDaddyHost.bridgeToken, undefined);
    assert.equal(mainCtx.__AGYDaddyHost.hostToken, undefined);

    // 2. 验证两个插件均在独立 Isolated World，且消费端完整跑通全能力
    assert.equal(isoContexts.size, 2);
    const report1 = await daemon.executeCommand('consumer.report');
    assert.equal(report1.count, 1);
    assert.equal(report1.last.ver, 'V1');
    assert.deepEqual(report1.last.greetRes, { hello: 'V1', from: 'isolated-provider' });
    assert.equal(report1.last.echoCmd.ok, true);
    assert.deepEqual(report1.last.echoCmd.result, { ok: true, prefix: 'P', arg: 'hi-V1' });
    assert.deepEqual(report1.last.sysSettings, { ok: true, values: { tag: 'init' } });
    assert.deepEqual(report1.last.initCfg, { tag: 'init' });
    assert.equal(report1.last.sessionId, '11111111-2222-3333-4444-555555555555');
    assert.equal(report1.last.hasComposer, true);
    assert.equal(report1.last.hasAppConfig, false);
    assert.equal(report1.last.hasHostGlobal, false);

    // 3. 验证真实 ShadowRoot 中 unit.render、updateUnit、popover.render（含 ⚙ 按钮包壳）、styles.inject 与 surface 挂载
    const hostEl = mockDoc.getElementById('agy-daddy-host');
    assert.ok(hostEl);
    const unitBtn = hostEl.shadowRoot.querySelector('[data-agy-slot="unit:third.iso-consumer:iso-badge"]');
    assert.ok(unitBtn);
    assert.equal(unitBtn.getAttribute('data-rendered-ver'), 'V1');
    assert.match(unitBtn.textContent, /IsoV1-Upd/);
    unitBtn.click();

    const popBody = hostEl.shadowRoot.querySelector('[data-agy-slot="popover:third.iso-consumer:iso-pop"]');
    assert.ok(popBody);
    assert.equal(popBody.textContent, 'body-V1');
    assert.ok(mockDoc.head.querySelector('[data-agy-style="third.iso-consumer"]'));
    assert.ok(hostEl.shadowRoot.querySelector('[data-agy-style="third.iso-consumer"]'));
    assert.ok(mockDoc.getElementById('mounted-in-surface'));

    // 4. 验证 Node 端更新配置 -> injector.notifyPluginSettingsChanged (rendererNotified === 1) -> 隔离世界 onChange 实时收到
    const nodeUpdRes = await daemon.updatePluginSettings('third.iso-consumer', { tag: 'from-node' });
    assert.equal(nodeUpdRes.ok, true);
    assert.equal(nodeUpdRes.rendererNotified, 1);
    const consumerIso = Array.from(isoContexts.values()).find((c) => typeof c.__ISO_INSPECT__ === 'function');
    const insp1 = JSON.parse(JSON.stringify(consumerIso.__ISO_INSPECT__()));
    assert.equal(insp1.unitClicked, 1);
    assert.deepEqual(insp1.popoverEvents, [true, false]);
    assert.deepEqual(insp1.receivedEvents, [{ ver: 'V1' }]);
    assert.deepEqual(insp1.stateUpdates.map((x) => x.v.n), [1, 2]);
    assert.equal(insp1.currentSettings.tag, 'from-node');
    assert.equal(insp1.settingsUpdates.length, 1);
    assert.deepEqual(insp1.settingsUpdates[0].keys, ['tag']);
    assert.equal(insp1.surfaceMounts.some((m) => m.id === 'provider-surface-box' && m.fallback === false), true);

    // 5. 验证 surface 提供方卸载后消费方自动降级到 fallbackAnchor，提供方热重载回来后自动切回真实 surface
    const activeSession = Array.from(daemon.injector.sessions.values())[0];
    await daemon.injector.disposePluginFromSession(activeSession, 'agy-daddy.iso-provider');
    const inspAfterRevoke = JSON.parse(JSON.stringify(consumerIso.__ISO_INSPECT__()));
    assert.equal(inspAfterRevoke.surfaceMounts.some((m) => m.fallback === true), true);

    const provReload = await daemon.reloadPlugin('agy-daddy.iso-provider');
    assert.equal(provReload.ok, true);
    const inspAfterRestore = JSON.parse(JSON.stringify(consumerIso.__ISO_INSPECT__()));
    assert.equal(inspAfterRestore.surfaceMounts[inspAfterRestore.surfaceMounts.length - 1].fallback, false);

    // 6. 验证单插件热重载：旧样式/单元清理、新 Token 签发、V2 生效
    writeConsumerRenderer('V2');
    const oldToken = daemon.bridge.getPluginToken('third.iso-consumer');
    const reloadRes = await daemon.reloadPlugin('third.iso-consumer');
    assert.equal(reloadRes.ok, true);
    assert.notEqual(daemon.bridge.getPluginToken('third.iso-consumer'), oldToken);
    const reloadedUnit = hostEl.shadowRoot.querySelector('[data-agy-slot="unit:third.iso-consumer:iso-badge"]');
    assert.ok(reloadedUnit);
    assert.match(reloadedUnit.textContent, /IsoV2-Upd/);

    // 7. 验证导航重建：全新 xworldNonce + 全量重注
    const oldNonce = injRes.results[0].xworldNonce;
    const reinjectedPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Reinject timeout')), 3000);
      daemon.injector.once('reinjected', (ev) => { clearTimeout(t); resolve(ev); });
    });
    cdpServer.simulateNavigation();
    const reinjected = await reinjectedPromise;
    assert.equal(reinjected.pluginsInjected, 2);
    assert.deepEqual(reinjected.errors, []);
    assert.notEqual(reinjected.xworldNonce, oldNonce);

    // 8. 停止守护进程彻底卸载 DOM 与锁
    await daemon.stop();
    assert.equal(cdpServer.getState().mockDoc.getElementById('agy-daddy-host'), null);
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false);
  } finally {
    await daemon.stop();
    await cdpServer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 端到端烟雾测试：doctor (14 锚点) / status / plugin 生命周期 / 无 migrate / live --once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cli-smoke-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const cliPath = path.join(HOST_ROOT, 'src', 'cli.js');
  const env = {
    ...process.env,
    AGY_DADDY_TEST_MODE: '1',
    AGY_DADDY_STATE_DIR: stateDir,
    AGY_DADDY_PLUGINS_DIR: pluginsDir
  };

  function runCli(args) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      cwd: HOST_ROOT,
      env,
      encoding: 'utf8'
    });
  }

  try {
    // 1. doctor --json
    const docRes = runCli(['doctor', '--json']);
    assert.equal(docRes.status, 0, docRes.stderr);
    const docJson = JSON.parse(docRes.stdout);
    assert.equal(docJson.ok, true);
    assert.equal(docJson.injection.anchors.total, 14);
    assert.equal(docJson.legacySuite, undefined);

    // 2. status --skip-cdp
    const statusRes = runCli(['status', '--skip-cdp']);
    assert.equal(statusRes.status, 0, statusRes.stderr);
    const statusJson = JSON.parse(statusRes.stdout);
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.legacySuite, undefined);

    // 3. plugin link / list / disable / enable / uninstall
    const linkRes = runCli(['plugin', 'link', 'templates/plugin-template', '--grant', 'dom:write,bridge:route']);
    assert.equal(linkRes.status, 0, linkRes.stderr);
    assert.equal(JSON.parse(linkRes.stdout).plugin.id, 'example.hello');

    const list1 = JSON.parse(runCli(['plugin', 'list']).stdout);
    assert.equal(list1.plugins.length, 1);
    assert.equal(list1.plugins[0].enabled, true);

    const disRes = runCli(['plugin', 'disable', 'example.hello']);
    assert.equal(disRes.status, 0, disRes.stderr);
    assert.equal(JSON.parse(disRes.stdout).plugin.enabled, false);

    const enRes = runCli(['plugin', 'enable', 'example.hello']);
    assert.equal(enRes.status, 0, enRes.stderr);
    assert.equal(JSON.parse(enRes.stdout).plugin.enabled, true);

    const unRes = runCli(['plugin', 'uninstall', 'example.hello']);
    assert.equal(unRes.status, 0, unRes.stderr);
    const list2 = JSON.parse(runCli(['plugin', 'list']).stdout);
    assert.equal(list2.plugins.length, 0);

    // 4. help 不再包含已删除的 migrate 子命令
    const helpRes = runCli(['--help']);
    assert.equal(helpRes.status, 0, helpRes.stderr);
    assert.equal(helpRes.stdout.includes('migrate'), false);

    // 5. live --once --skip-inject --json（无残留 daemon.lock）
    const liveRes = runCli(['live', '--once', '--skip-inject', '--json']);
    assert.equal(liveRes.status, 0, liveRes.stderr);
    const liveJson = JSON.parse(liveRes.stdout);
    assert.equal(liveJson.ok, true);
    assert.ok(liveJson.port > 0);
    assert.equal(liveJson.once, true);
    assert.equal(liveJson.inject.skipped, true);
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false);

    // 6. web --no-open / --port / --reset-token
    const webDefaultRes = runCli(['web', '--no-open']);
    assert.equal(webDefaultRes.status, 0, webDefaultRes.stderr);
    const webDefault = JSON.parse(webDefaultRes.stdout);
    assert.equal(webDefault.ok, true);
    assert.equal(webDefault.port, 18767);
    assert.equal(webDefault.opened, false);
    assert.equal(webDefault.tokenRotated, false);
    assert.match(webDefault.url, /^http:\/\/127\.0\.0\.1:18767\/\?token=[a-f0-9]{48}$/);
    const expectedCfgPath = path.join(stateDir, 'plugins-data', 'agy-daddy.web', 'web-config.json');
    assert.equal(webDefault.configPath, expectedCfgPath);
    assert.equal(fs.existsSync(expectedCfgPath), true);
    const persisted1 = JSON.parse(fs.readFileSync(expectedCfgPath, 'utf8'));
    assert.equal(persisted1.port, 18767);
    assert.equal(webDefault.url, `http://127.0.0.1:18767/?token=${persisted1.token}`);

    const webPortRes = runCli(['web', '--port', '19988', '--no-open']);
    assert.equal(webPortRes.status, 0, webPortRes.stderr);
    const webPort = JSON.parse(webPortRes.stdout);
    assert.equal(webPort.port, 19988);
    assert.equal(webPort.opened, false);
    assert.equal(webPort.tokenRotated, false);
    assert.equal(webPort.url, `http://127.0.0.1:19988/?token=${persisted1.token}`);
    const persisted2 = JSON.parse(fs.readFileSync(expectedCfgPath, 'utf8'));
    assert.equal(persisted2.port, 19988);

    const webRotateRes = runCli(['web', '--reset-token', '--no-open']);
    assert.equal(webRotateRes.status, 0, webRotateRes.stderr);
    const webRotate = JSON.parse(webRotateRes.stdout);
    assert.equal(webRotate.tokenRotated, true);
    assert.equal(webRotate.opened, false);
    assert.equal(webRotate.port, 19988);
    const persisted3 = JSON.parse(fs.readFileSync(expectedCfgPath, 'utf8'));
    assert.notEqual(persisted3.token, persisted1.token);
    assert.equal(webRotate.url, `http://127.0.0.1:19988/?token=${persisted3.token}`);

    const badPortRes = runCli(['web', '--port', '99999', '--no-open']);
    assert.notEqual(badPortRes.status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POST /host/reload-all 与 /host/daemon/restart：全量代码热重载（含 node.js 与 renderer.js）及重启调度', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-reload-all-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const pluginDir = path.join(pluginsDir, 'third.hot-demo');
  fs.mkdirSync(path.join(pluginDir, 'src'), { recursive: true });

  safeWriteJsonSync(path.join(pluginDir, 'agy-plugin.json'), {
    schemaVersion: 1,
    id: 'third.hot-demo',
    publisher: 'third',
    version: '1.0.0',
    displayName: 'Hot Demo',
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    renderer: './src/renderer.js',
    world: 'isolated',
    permissions: ['dom:write'],
    contributes: {
      'topbar.units': [{ id: 'hot-unit', order: 10 }]
    }
  });

  function writePluginCode(tag) {
    fs.writeFileSync(path.join(pluginDir, 'src', 'node.js'), `
      let stopCmd = null;
      module.exports = {
        activate(host) {
          stopCmd = host.commands.register('hot.ping', () => ({ ok: true, ver: '${tag}' }));
        },
        deactivate() { if (stopCmd) stopCmd(); }
      };
    `);
    fs.writeFileSync(path.join(pluginDir, 'src', 'renderer.js'), `
      let stops = [];
      module.exports = {
        mount(ctx) {
          stops.push(ctx.topbar.registerUnit({ id: 'hot-unit', order: 10, label: 'Hot-${tag}' }));
        },
        dispose() { for (const f of stops) try { f(); } catch {} stops = []; }
      };
    `);
  }
  writePluginCode('v1');

  const cdpServer = createMockCdpTargetServer();
  const cdpPort = await cdpServer.start();
  let restartCalls = [];

  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    origin: '*',
    cdpOptions: { ports: [cdpPort], allowLsof: false },
    plugins: [
      { id: 'third.hot-demo', trustLevel: 'T2', installPath: pluginDir, grantedPermissions: ['dom:write'], enabled: true }
    ],
    onRestartDaemon: (info) => {
      restartCalls.push(info.reason);
    }
  });

  const daemonNoCb = new AgyDaddyDaemon({
    stateDir: path.join(root, 'state-nocb'),
    pluginsDir: path.join(root, 'plugins-nocb'),
    origin: '*',
    plugins: []
  });

  try {
    const started = await daemon.start();
    await daemon.injectActiveTargets();
    assert.deepEqual(await daemon.executeCommand('hot.ping'), { ok: true, ver: 'v1' });
    const hostElBefore = cdpServer.getState().mockDoc.getElementById('agy-daddy-host');
    assert.match(hostElBefore.shadowRoot.querySelector('[data-agy-slot="unit:third.hot-demo:hot-unit"]').textContent, /Hot-v1/);

    // 修改磁盘上的 node.js 与 renderer.js
    writePluginCode('v2');

    const reinjectedPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('reinjected event timeout')), 3000);
      daemon.injector.once('reinjected', (ev) => { clearTimeout(t); resolve(ev); });
    });

    const reloadResp = await fetch(`http://127.0.0.1:${started.port}/host/reload-all`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agy-Host-Token': started.hostToken
      },
      body: JSON.stringify({
        rebuildRenderer: true,
        restoreView: { open: true, tab: 'plugins', diagnosticsExpanded: true }
      })
    }).then((r) => r.json());

    assert.equal(reloadResp.ok, true);
    assert.equal(reloadResp.reloadedCount, 1);
    assert.deepEqual(reloadResp.reloadedPlugins, ['third.hot-demo']);
    assert.equal(reloadResp.injector.sessionsUpdated, 1);

    const reinjectedEv = await reinjectedPromise;
    assert.equal(reinjectedEv.pluginsInjected, 1);

    // 验证新 node.js 与新 renderer.js 均已生效，且设置页自动恢复
    assert.deepEqual(await daemon.executeCommand('hot.ping'), { ok: true, ver: 'v2' });
    const hostElAfter = cdpServer.getState().mockDoc.getElementById('agy-daddy-host');
    assert.match(hostElAfter.shadowRoot.querySelector('[data-agy-slot="unit:third.hot-demo:hot-unit"]').textContent, /Hot-v2/);
    await new Promise((r) => setTimeout(r, 40));
    const { mainCtx } = cdpServer.getState();
    assert.notEqual(mainCtx.__AGYDaddyHost.getSettingsMode(), 'closed');
    assert.equal(hostElAfter.shadowRoot.querySelector('#agy-diagnostics-detail-body').hidden, false);

    // 验证 /host/daemon/restart (callback 模式)
    const restartResp = await fetch(`http://127.0.0.1:${started.port}/host/daemon/restart`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agy-Host-Token': started.hostToken
      },
      body: JSON.stringify({ rebuildRenderer: true, reason: 'test-cb' })
    }).then((r) => r.json());
    assert.equal(restartResp.ok, true);
    assert.equal(restartResp.scheduled, true);
    assert.equal(restartResp.mode, 'callback');
    await new Promise((r) => setTimeout(r, 180));
    assert.deepEqual(restartCalls, ['test-cb']);

    // 验证 /host/daemon/restart (test 模式默认 dryRun，不退出进程)
    const startedNoCb = await daemonNoCb.start();
    const dryResp = await fetch(`http://127.0.0.1:${startedNoCb.port}/host/daemon/restart`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agy-Host-Token': startedNoCb.hostToken
      },
      body: JSON.stringify({ rebuildRenderer: false })
    }).then((r) => r.json());
    assert.equal(dryResp.ok, true);
    assert.equal(dryResp.scheduled, false);
    assert.equal(dryResp.dryRun, true);
    assert.equal(dryResp.mode, 'test');
  } finally {
    await daemon.stop();
    await daemonNoCb.stop();
    await cdpServer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildIsolatedWorldPluginScript: 跨世界生命周期事件清理旧实例且 bridge.post 安全处理非 JSON 错误响应', async () => {
  const { buildIsolatedWorldPluginScript } = require('../src/core/injector');
  const mockDoc = createMockDocument();
  const { ctx: iso1, clearTimers: clear1 } = createRealEnvShim(mockDoc, {
    fetch: async () => ({
      ok: false,
      status: 502,
      text: async () => 'Bad Gateway: Direct HTTP request timeout'
    })
  });
  const { ctx: iso2, clearTimers: clear2 } = createRealEnvShim(mockDoc, {
    fetch: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true })
    })
  });

  try {
    let disposedCount1 = 0;
    let disposedCount2 = 0;
    let bridgeOut1 = null;

    const rendererSrc1 = `
      module.exports = {
        async mount(ctx) {
          globalThis.__res1 = await ctx.bridge.post('/optimize-prompt', { text: 'hi' });
        },
        dispose() {
          globalThis.__disposed1 = (globalThis.__disposed1 || 0) + 1;
        }
      };
    `;
    const rendererSrc2 = `
      module.exports = {
        mount() {},
        dispose() {
          globalThis.__disposed2 = (globalThis.__disposed2 || 0) + 1;
        }
      };
    `;

    const s1 = buildIsolatedWorldPluginScript('agy-daddy.demo', rendererSrc1, {
      xworldChannelName: '__agy_xworld_nonce1',
      xworldNonce: 'nonce1',
      bridgePort: 18888,
      pluginToken: 'tok1'
    });
    await vm.runInContext(s1, iso1);
    bridgeOut1 = iso1.__res1;
    assert.equal(bridgeOut1.ok, false);
    assert.equal(bridgeOut1.status, 502);
    assert.match(bridgeOut1.error, /HTTP 502: Bad Gateway/);

    // 注入同插件新实例（不同 nonce），应自动触发旧实例 dispose
    const s2 = buildIsolatedWorldPluginScript('agy-daddy.demo', rendererSrc2, {
      xworldChannelName: '__agy_xworld_nonce2',
      xworldNonce: 'nonce2',
      bridgePort: 18889,
      pluginToken: 'tok2'
    });
    await vm.runInContext(s2, iso2);
    await new Promise((r) => setTimeout(r, 20));
    disposedCount1 = iso1.__disposed1 || 0;
    disposedCount2 = iso2.__disposed2 || 0;
    assert.equal(disposedCount1, 1, '同 pluginId 新实例注入时应清理遗留旧隔离世界');
    assert.equal(disposedCount2, 0, '新实例自身不应被误销毁');

    // 发送 host.reset（nextNonce !== 'nonce2'）应清理 iso2
    mockDoc.dispatchEvent({
      type: '__agy_xworld_lifecycle__',
      detail: { type: 'host.reset', nextNonce: 'nonce3' }
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(iso2.__disposed2, 1, '收到新宿主 host.reset 时旧隔离世界应自清理');
  } finally {
    clear1();
    clear2();
  }
});
