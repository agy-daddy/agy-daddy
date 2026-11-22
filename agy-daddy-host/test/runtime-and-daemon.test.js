'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolveRuntime } = require('../src/core/runtime-resolver');
const { CdpClient, inspectAntigravityHostProcess } = require('../src/core/cdp');
const { AgyDaddyDaemon, acquireDaemonLock, releaseDaemonLock } = require('../src/core/daemon');
const { createScopedNetFetch } = require('../src/core/plugin-worker');
const { safeWriteJsonSync } = require('../src/core/storage');

function createMinimalWsServer(onJsonMessage) {
  const sockets = new Set();
  const server = http.createServer();

  function sendWsText(socket, text) {
    const payload = Buffer.from(text, 'utf8');
    const header = payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
    socket.write(Buffer.concat([header, payload]));
  }

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
          onJsonMessage(JSON.parse(payload.toString('utf8')), (obj) => sendWsText(socket, JSON.stringify(obj)));
        }
      }
    });
  });

  return {
    server,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      for (const s of sockets) {
        try { s.destroy(); } catch {}
      }
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

test('runtimeResolver 损坏 Node 自动跳过并回退至 Electron Helper', () => {
  const brokenHomeBrew = '/opt/homebrew/bin/node';
  const electronHelper = '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper';
  const res = resolveRuntime({
    env: {},
    candidates: [
      { path: brokenHomeBrew, source: 'path', isElectron: false },
      { path: electronHelper, source: 'electron-helper', isElectron: true }
    ],
    probeFn: (cand) => {
      if (cand.path === brokenHomeBrew) {
        return { ok: false, reason: 'dyld: Library not loaded: libsimdjson.36.dylib' };
      }
      return { ok: true, nodeVersion: '24.22.0', electronVersion: '44.9.1' };
    }
  });
  assert.equal(res.ok, true);
  assert.equal(res.source, 'electron-helper');
  assert.equal(res.isElectron, true);
  assert.deepEqual(res.envPatch, { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(res.rejected.length, 1);
  assert.match(res.rejected[0].reason, /libsimdjson/);
});

test('CdpClient 支持隔离世界创建、执行与页面上下文重建事件，及宿主进程解析', async () => {
  const wsSrv = createMinimalWsServer((msg, reply) => {
    if (msg.method === 'Runtime.enable') {
      reply({ id: msg.id, result: {} });
      reply({ method: 'Runtime.executionContextCreated', params: { context: { id: 10, origin: 'https://127.0.0.1:51410' } } });
      return;
    }
    if (msg.method === 'Page.createIsolatedWorld') {
      reply({ id: msg.id, result: { executionContextId: 42 } });
      return;
    }
    if (msg.method === 'Runtime.evaluate') {
      reply({ id: msg.id, result: { result: { value: { ctx: msg.params.contextId || 1, ok: true } } } });
      return;
    }
    reply({ id: msg.id, result: {} });
  });
  const port = await wsSrv.start();
  const client = new CdpClient(`ws://127.0.0.1:${port}`);
  try {
    await client.connect();
    const contexts = [];
    client.on('executionContextCreated', (c) => contexts.push(c));
    await client.enable();
    const isoId = await client.createIsolatedWorld('frame-1', 'agy-plugin-demo');
    assert.equal(isoId, 42);
    const val = await client.evaluate('1+1', { contextId: isoId });
    assert.deepEqual(val, { ctx: 42, ok: true });
    assert.equal(contexts.length, 1);
  } finally {
    client.close();
    await wsSrv.close();
  }

  const hostInfo = inspectAntigravityHostProcess({
    psOutput: [
      '  30379 05:10 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone',
      '  28465 05:12 /Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0'
    ].join('\n')
  });
  assert.equal(hostInfo.running, true);
  assert.equal(hostInfo.pid, 28465);
  assert.equal(hostInfo.hasDebugSwitch, true);
});

test('AgyDaddyDaemon 单实例锁、陈旧锁接管、T0同进程+T2独立Worker隔离、钩子聚合与3次崩溃熔断', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-daemon-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  fs.mkdirSync(stateDir, { recursive: true });

  // 获取一个已确认退出的真实死亡 PID 测试陈旧锁接管
  const deadSpawn = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const deadPid = deadSpawn.pid;
  const lockPath = path.join(stateDir, 'daemon.lock');
  safeWriteJsonSync(lockPath, { pid: deadPid, startedAt: Date.now() - 10000 });

  // 准备 T0 插件 (带 hostLaunchArgs/Env)
  const t0Dir = path.join(pluginsDir, 'agy-daddy.t0proxy');
  fs.mkdirSync(path.join(t0Dir, 'src'), { recursive: true });
  safeWriteJsonSync(path.join(t0Dir, 'agy-plugin.json'), {
    schemaVersion: 1,
    id: 'agy-daddy.t0proxy',
    publisher: 'agy-daddy',
    version: '1.0.0',
    displayName: 'T0 Proxy Stub',
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    permissions: ['host:launch-args', 'bridge:route']
  });
  fs.writeFileSync(path.join(t0Dir, 'src', 'node.js'), `
    let stop = [];
    module.exports = {
      async activate(host) {
        stop.push(host.hooks.register('hostLaunchArgs', () => ['--proxy-server=http://127.0.0.1:18766']));
        stop.push(host.hooks.register('hostLaunchEnv', () => ({ HTTP_PROXY: 'http://127.0.0.1:18766' })));
        stop.push(await host.bridge.registerRoute('/info', async () => ({ ok: true, from: 't0-in-process' })));
      },
      async deactivate() { for (const f of stop) try { f(); } catch {} stop = []; }
    };
  `);

  // 准备 T2 独立子进程 Worker 插件
  const t2Dir = path.join(pluginsDir, 'third.worker');
  fs.mkdirSync(path.join(t2Dir, 'src'), { recursive: true });
  safeWriteJsonSync(path.join(t2Dir, 'agy-plugin.json'), {
    schemaVersion: 1,
    id: 'third.worker',
    publisher: 'third',
    version: '1.0.0',
    displayName: 'T2 Worker',
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    permissions: ['bridge:route', 'net:outbound:api.allowed.test']
  });
  fs.writeFileSync(path.join(t2Dir, 'src', 'node.js'), `
    module.exports = {
      async activate(host) {
        await host.bridge.registerRoute('/worker-ping', async () => ({
          ok: true,
          workerPid: process.pid,
          isWorkerEnv: process.env.AGY_DADDY_WORKER === '1'
        }));
      },
      async deactivate() {}
    };
  `);

  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    origin: '*',
    plugins: [
      { id: 'agy-daddy.t0proxy', trustLevel: 'T0', installPath: t0Dir, grantedPermissions: ['host:launch-args', 'bridge:route'], enabled: true },
      { id: 'third.worker', trustLevel: 'T2', installPath: t2Dir, grantedPermissions: ['bridge:route', 'net:outbound:api.allowed.test'], enabled: true }
    ]
  });

  try {
    const started = await daemon.start();
    assert.ok(started.port > 0);
    assert.deepEqual(started.activationErrors, []);

    // 验证第二个 daemon 无法重复启动（锁生效）
    assert.throws(() => acquireDaemonLock(lockPath), /DAEMON_ALREADY_RUNNING/);

    // 验证 T0 与 T2 Worker 路由均可访问且各自独立 Token 生效
    const t0Token = daemon.bridge.getPluginToken('agy-daddy.t0proxy');
    const t2Token = daemon.bridge.getPluginToken('third.worker');

    const t0Resp = await fetch(`http://127.0.0.1:${started.port}/plugins/agy-daddy.t0proxy/info`, {
      method: 'POST',
      headers: { 'X-AGY-Plugin-Token': t0Token },
      body: '{}'
    });
    assert.deepEqual(await t0Resp.json(), { ok: true, from: 't0-in-process' });

    const t2Resp = await fetch(`http://127.0.0.1:${started.port}/plugins/third.worker/worker-ping`, {
      method: 'POST',
      headers: { 'X-AGY-Plugin-Token': t2Token },
      body: '{}'
    });
    const t2Json = await t2Resp.json();
    assert.equal(t2Json.ok, true);
    assert.equal(t2Json.isWorkerEnv, true);
    assert.notEqual(t2Json.workerPid, process.pid);

    // 验证启动参数和环境变量钩子聚合
    const launchSpec = await daemon.collectHostLaunchSpec('/Applications/Antigravity.app');
    assert.ok(launchSpec.args.includes('--remote-debugging-port=0'));
    assert.ok(launchSpec.args.includes('--proxy-server=http://127.0.0.1:18766'));
    assert.equal(launchSpec.env.HTTP_PROXY, 'http://127.0.0.1:18766');
    assert.ok(launchSpec.macOpenArgs.includes('--env'));

    // 验证出站域名权限门禁
    const scopedFetch = createScopedNetFetch('third.worker', ['net:outbound:api.allowed.test'], null, async () => ({ ok: true }));
    assert.equal((await scopedFetch('https://api.allowed.test/v1')).ok, true);
    await assert.rejects(() => scopedFetch('https://evil.example/steal'), /NET_PERMISSION_DENIED/);

    // 验证 60s 内 3 次崩溃熔断器
    const circuitEvents = [];
    daemon.bus.onEvent('test', 'host:plugin-circuit-opened@1', (p) => circuitEvents.push(p));
    assert.equal(daemon.recordPluginFailure('flaky.plugin', new Error('boom1')).circuitOpen, false);
    assert.equal(daemon.recordPluginFailure('flaky.plugin', new Error('boom2')).circuitOpen, false);
    assert.equal(daemon.recordPluginFailure('flaky.plugin', new Error('boom3')).circuitOpen, true);
    assert.equal(circuitEvents.length, 1);
    assert.equal(circuitEvents[0].pluginId, 'flaky.plugin');
  } finally {
    await daemon.stop();
    releaseDaemonLock(lockPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
