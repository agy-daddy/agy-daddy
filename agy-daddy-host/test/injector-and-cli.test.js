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
const { PluginDataStore, safeWriteJsonSync } = require('../src/core/storage');
const { createMockDocument } = require('../sdk/mock-harness');

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
      const { ctx: isoCtx, clearTimers } = createRealEnvShim(mockDoc);
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

test('CdpInjector 端到端：双世界隔离、跨世界 nonce 服务与桥接通信、插件热重载与导航重注', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-inj-e2e-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const legacySrcDir = path.join(root, 'legacy-src');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(legacySrcDir, { recursive: true });

  // 1. 构建安全无副作用的假 legacy 源目录（仅启用 meter + enhancer，屏蔽 pulse/hans/remote）
  fs.writeFileSync(path.join(legacySrcDir, 'meter-core.js'), 'globalThis.__TEST_LEGACY_CORE__ = true;');
  fs.writeFileSync(path.join(legacySrcDir, 'meter-renderer.js'), 'globalThis.__TEST_LEGACY_RENDERER__ = true;');
  fs.writeFileSync(path.join(legacySrcDir, 'ag-enhancer-overlay.js'), 'globalThis.__TEST_LEGACY_ENHANCER__ = true;');
  fs.writeFileSync(path.join(legacySrcDir, 'pulse-capsule-overlay.js'), 'globalThis.__TEST_LEGACY_PULSE__ = true;');

  const legacyStore = new PluginDataStore('agy-daddy.legacy-suite', { stateDir });
  legacyStore.writeJson('settings.json', {
    sourceDir: legacySrcDir,
    disabledModules: ['pulse', 'hans', 'remote']
  });

  // 2. 准备 T0 主世界插件（注册 unit + 主世界服务 t0svc.ping）
  const t0Dir = path.join(pluginsDir, 'agy-daddy.t0main');
  fs.mkdirSync(path.join(t0Dir, 'src'), { recursive: true });
  safeWriteJsonSync(path.join(t0Dir, 'agy-plugin.json'), {
    schemaVersion: 1,
    id: 'agy-daddy.t0main',
    publisher: 'agy-daddy',
    version: '1.0.0',
    displayName: 'T0 Main Plugin',
    engines: { agyDaddy: '^1.0.0' },
    renderer: './src/renderer.js',
    world: 'main',
    permissions: ['dom:write', 'page:main-world']
  });
  fs.writeFileSync(path.join(t0Dir, 'src', 'renderer.js'), `
    let stopUnit = null;
    let stopSvc = null;
    module.exports = {
      mount(ctx) {
        stopUnit = ctx.topbar.registerUnit({ id: 't0-badge', order: 10, label: 'T0Main' });
        stopSvc = ctx.services.provide('t0svc', {
          ping(who) { return { pong: who || 'ok', fromMain: true }; }
        });
      },
      dispose() {
        if (stopUnit) stopUnit();
        if (stopSvc) stopSvc();
      }
    };
  `);

  // 3. 准备 T2 隔离世界 + Worker 插件
  const t2Dir = path.join(pluginsDir, 'third.iso');
  fs.mkdirSync(path.join(t2Dir, 'src'), { recursive: true });
  safeWriteJsonSync(path.join(t2Dir, 'agy-plugin.json'), {
    schemaVersion: 1,
    id: 'third.iso',
    publisher: 'third',
    version: '1.0.0',
    displayName: 'T2 Isolated Plugin',
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    renderer: './src/renderer.js',
    world: 'isolated',
    permissions: ['dom:write', 'bridge:route']
  });
  fs.writeFileSync(path.join(t2Dir, 'src', 'node.js'), `
    let records = [];
    module.exports = {
      async activate(host) {
        await host.bridge.registerRoute('/iso-echo', async (body) => {
          records.push(body);
          return { ok: true, count: records.length, echoed: body };
        });
        await host.bridge.registerRoute('/get-last-echo', async () => ({
          count: records.length,
          last: records[records.length - 1] || null
        }));
      },
      async deactivate() { records = []; }
    };
  `);
  function writeIsoRenderer(verTag) {
    fs.writeFileSync(path.join(t2Dir, 'src', 'renderer.js'), `
      let stopUnit = null;
      let stopTimer = null;
      module.exports = {
        async mount(ctx) {
          stopUnit = ctx.topbar.registerUnit({ id: 'iso-badge', order: 20, label: 'Iso${verTag}' });
          stopTimer = ctx.schedule.every(10000, () => {});
          const pingRes = await ctx.services.call('t0svc', 'ping', ['from-iso-${verTag}']);
          const echoRes = await ctx.bridge.post('/iso-echo', {
            tag: '${verTag}',
            pingRes: pingRes,
            hasAppConfig: typeof __APP_CONFIG__ !== 'undefined',
            hasHostGlobal: typeof __AGYDaddyHost !== 'undefined'
          });
          await ctx.state.set('state:third.iso.last@1', echoRes);
        },
        dispose() {
          if (stopUnit) stopUnit();
          if (stopTimer) stopTimer();
        }
      };
    `);
  }
  writeIsoRenderer('V1');

  const cdpServer = createMockCdpTargetServer();
  const cdpPort = await cdpServer.start();

  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    origin: '*',
    reinjectDebounceMs: 25,
    cdpOptions: { ports: [cdpPort], allowLsof: false },
    plugins: [
      { id: 'agy-daddy.t0main', trustLevel: 'T0', installPath: t0Dir, grantedPermissions: ['dom:write', 'page:main-world'], enabled: true },
      { id: 'third.iso', trustLevel: 'T2', installPath: t2Dir, grantedPermissions: ['dom:write', 'bridge:route'], enabled: true },
      { id: 'agy-daddy.legacy-suite', trustLevel: 'T0', installPath: path.join(HOST_ROOT, 'plugins', 'legacy-suite'), enabled: true }
    ]
  });

  try {
    const started = await daemon.start();
    assert.deepEqual(started.activationErrors, []);

    const injRes = await daemon.injectActiveTargets();
    assert.equal(injRes.targetsInjected, 1);
    assert.equal(injRes.pluginsInjected, 3);
    assert.deepEqual(injRes.errors, []);

    const { mockDoc, mainCtx, isoContexts, localStorage } = cdpServer.getState();

    // 校验不泄露全局 Token / 内部渠道名 / Boot 配置
    assert.ok(mainCtx.__AGYDaddyHost);
    assert.equal(mainCtx.__AGY_DADDY_BOOT_OPTIONS__, undefined);
    assert.equal(mainCtx.__AGYDaddyHost.xworldChannelName, undefined);
    assert.equal(mainCtx.__AGYDaddyHost.bridgeToken, undefined);
    assert.equal(mainCtx.__AGYDaddyHost.hostToken, undefined);

    // 校验主世界 + 隔离世界 Unit 均挂载到 Topbar
    const hostEl = mockDoc.getElementById('agy-daddy-host');
    assert.ok(hostEl);
    const barEl = hostEl.shadowRoot.querySelector('#agy-topbar-slots');
    const labels = barEl.children.map((c) => c.textContent);
    assert.ok(labels.includes('T0Main'));
    assert.ok(labels.includes('IsoV1'));
    assert.ok(labels.includes('Legacy'));

    // 校验 legacy-suite 掩码按预期运行并跳过被禁用的 pulse
    assert.equal(mainCtx.__TEST_LEGACY_CORE__, true);
    assert.equal(mainCtx.__TEST_LEGACY_ENHANCER__, true);
    assert.equal(mainCtx.__TEST_LEGACY_PULSE__, undefined);
    assert.match(localStorage.getItem('ag_suite_feature_flags'), /"showTopbarRemote":false/);

    // 校验隔离世界：无法看到主世界 __APP_CONFIG__，但成功跨世界调 t0svc.ping 且携带私有 Token 调 Worker Bridge
    assert.equal(isoContexts.size, 1);
    const t2Token = daemon.bridge.getPluginToken('third.iso');
    const lastEcho1 = await fetch(`http://127.0.0.1:${started.port}/plugins/third.iso/get-last-echo`, {
      method: 'POST',
      headers: { 'X-AGY-Plugin-Token': t2Token },
      body: '{}'
    }).then((r) => r.json());
    assert.equal(lastEcho1.count, 1);
    assert.equal(lastEcho1.last.tag, 'V1');
    assert.deepEqual(lastEcho1.last.pingRes, { pong: 'from-iso-V1', fromMain: true });
    assert.equal(lastEcho1.last.hasAppConfig, false);
    assert.equal(lastEcho1.last.hasHostGlobal, false);

    // 测试单插件热重载，不重复挂载 Unit，旧定时器被清理，新 Worker + 新隔离上下文生效
    writeIsoRenderer('V2');
    const reloadRes = await daemon.reloadPlugin('third.iso');
    assert.equal(reloadRes.ok, true);
    assert.equal(reloadRes.injector.sessionsUpdated, 1);

    const barLabelsAfterReload = barEl.children.map((c) => c.textContent);
    assert.equal(barLabelsAfterReload.filter((x) => x.startsWith('Iso')).length, 1);
    assert.ok(barLabelsAfterReload.includes('IsoV2'));

    const t2Token2 = daemon.bridge.getPluginToken('third.iso');
    assert.notEqual(t2Token2, t2Token);
    const lastEcho2 = await fetch(`http://127.0.0.1:${started.port}/plugins/third.iso/get-last-echo`, {
      method: 'POST',
      headers: { 'X-AGY-Plugin-Token': t2Token2 },
      body: '{}'
    }).then((r) => r.json());
    assert.equal(lastEcho2.last.tag, 'V2');

    // 测试页面导航重建时自动生成全新 xworldNonce 并重注全部插件
    const oldNonce = injRes.results[0].xworldNonce;
    const reinjectedPromise = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Reinject timeout')), 3000);
      daemon.injector.once('reinjected', (ev) => {
        clearTimeout(t);
        resolve(ev);
      });
    });
    cdpServer.simulateNavigation();
    const reinjected = await reinjectedPromise;
    assert.equal(reinjected.pluginsInjected, 3);
    assert.deepEqual(reinjected.errors, []);
    assert.notEqual(reinjected.xworldNonce, oldNonce);

    const navState = cdpServer.getState();
    assert.equal(navState.mockDoc.getElementById('agy-daddy-host') !== null, true);
    const navBarLabels = navState.mockDoc.getElementById('agy-daddy-host').shadowRoot.querySelector('#agy-topbar-slots').children.map((c) => c.textContent);
    assert.ok(navBarLabels.includes('T0Main'));
    assert.ok(navBarLabels.includes('IsoV2'));

    // 停止守护进程时彻底卸载 DOM 与锁
    await daemon.stop();
    assert.equal(navState.mockDoc.getElementById('agy-daddy-host'), null);
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false);
  } finally {
    await daemon.stop();
    await cdpServer.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 端到端烟雾测试：doctor / status / plugin 生命周期 / migrate / live --once', () => {
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
    assert.equal(docJson.anchors.count, 10);

    // 2. status --skip-cdp
    const statusRes = runCli(['status', '--skip-cdp']);
    assert.equal(statusRes.status, 0, statusRes.stderr);
    const statusJson = JSON.parse(statusRes.stdout);
    assert.equal(statusJson.ok, true);

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

    // 4. migrate --dry-run
    const migRes = runCli(['migrate', '--dry-run']);
    assert.equal(migRes.status, 0, migRes.stderr);
    const migJson = JSON.parse(migRes.stdout);
    assert.equal(typeof migJson, 'object');

    // 5. live --once --skip-inject --json（无残留 daemon.lock）
    const liveRes = runCli(['live', '--once', '--skip-inject', '--json']);
    assert.equal(liveRes.status, 0, liveRes.stderr);
    const liveJson = JSON.parse(liveRes.stdout);
    assert.equal(liveJson.ok, true);
    assert.ok(liveJson.port > 0);
    assert.equal(liveJson.once, true);
    assert.equal(liveJson.inject.skipped, true);
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
