'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FourRealmBus } = require('../src/core/bus');
const { DynamicBridgeServer, MAX_BODY_BYTES } = require('../src/core/bridge');
const { discoverFromHubDaemonFiles, createScopedRpcClient, createRpcTransport } = require('../src/core/rpc');

test('FourRealmBus: event 瞬时、state 粘性重放、跨域转发、超时降级与彻底清理', async () => {
  const bus = new FourRealmBus({ timeoutMs: 120 });

  // 1. event 不补发
  bus.emitEvent('p.a', 'chat:thinking@1', { seq: 1 });
  const receivedEvents = [];
  bus.onEvent('p.b', 'chat:thinking@1', (p) => receivedEvents.push(p));
  assert.equal(receivedEvents.length, 0);
  bus.emitEvent('p.a', 'chat:thinking@1', { seq: 2 });
  assert.deepEqual(receivedEvents, [{ seq: 2 }]);

  // 2. state 粘性最新值 + 单调版本
  bus.setState('p.a', 'state:context.snapshot@1', { used: 100 });
  const s2 = bus.setState('p.a', 'state:context.snapshot@1', { used: 200 });
  assert.equal(s2.version, 2);
  const lateSeen = [];
  bus.subscribeState('p.c', 'state:context.snapshot@1', (val, meta) => lateSeen.push({ val, meta }));
  assert.equal(lateSeen.length, 1);
  assert.equal(lateSeen[0].val.used, 200);
  assert.equal(lateSeen[0].meta.replay, true);

  // 3. 跨域转发与可序列化校验
  bus.registerRealmForwarder('page-main', async (rec, method, args) => {
    return { forwarded: true, service: rec.name, method, args };
  });
  bus.provideService('p.ctx', 'context', { getSnap: () => ({ direct: true }) }, { realm: 'page-main' });
  const fwd = await bus.callService('context', 'getSnap', [{ id: 's1' }], { callerRealm: 'node' });
  assert.equal(fwd.ok, true);
  assert.equal(fwd.value.forwarded, true);

  // 不可序列化载荷拦截
  await assert.rejects(() => bus.callService('context', 'getSnap', [() => {}], { callerRealm: 'node' }), /serialization failed/);

  // 4. 服务缺失与超时可选降级
  const missing = await bus.callService('nonexistent', 'ping', [], { optional: true });
  assert.equal(missing.unavailable, true);
  assert.equal(missing.value, null);

  let hangTimer = null;
  bus.provideService('p.slow', 'slow', {
    hang: () => new Promise((resolve) => { hangTimer = setTimeout(resolve, 1000); })
  }, { realm: 'node' });
  const timedOut = await bus.callService('slow', 'hang', [], { optional: true, timeoutMs: 40 });
  if (hangTimer) clearTimeout(hangTimer);
  assert.equal(timedOut.unavailable, true);
  assert.match(timedOut.error, /SERVICE_TIMEOUT/);

  // 5. 插件卸载彻底清理
  bus.disposePlugin('p.b');
  bus.disposePlugin('p.c');
  assert.equal(bus.countRegistrations('p.b'), 0);
  assert.equal(bus.countRegistrations('p.c'), 0);
});

test('DynamicBridgeServer: Origin 严格校验、按插件 Token 隔离与反注册', async () => {
  const bridge = new DynamicBridgeServer({ origin: 'https://127.0.0.1:51410' });
  const { port, hostToken } = await bridge.start(0);
  try {
    const tokenA = bridge.issuePluginToken('agy-daddy.alpha');
    const tokenB = bridge.issuePluginToken('agy-daddy.beta');
    bridge.registerPluginRoute('agy-daddy.alpha', '/echo', async (body) => ({ ok: true, echo: body.msg }));
    bridge.registerHostRoute('/host/ping', async () => ({ ok: true, host: true }));

    // 错误 Origin -> 403
    const badOrigin = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.alpha/echo`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'X-AGY-Plugin-Token': tokenA },
      body: '{}'
    });
    assert.equal(badOrigin.status, 403);

    // 跨插件 Token 越权（B 的 token 调 A 的路由）-> 403
    const crossToken = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.alpha/echo`, {
      method: 'POST',
      headers: { Origin: 'https://127.0.0.1:51410', 'X-AGY-Plugin-Token': tokenB },
      body: '{}'
    });
    assert.equal(crossToken.status, 403);

    // 合法请求 -> 200
    const okResp = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.alpha/echo`, {
      method: 'POST',
      headers: { Origin: 'https://127.0.0.1:51410', 'Content-Type': 'application/json', 'X-AGY-Plugin-Token': tokenA },
      body: JSON.stringify({ msg: 'hi' })
    });
    assert.equal(okResp.status, 200);
    assert.deepEqual(await okResp.json(), { ok: true, echo: 'hi' });

    // 体积超 1MB -> 413
    const huge = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.alpha/echo`, {
      method: 'POST',
      headers: { Origin: 'https://127.0.0.1:51410', 'X-AGY-Plugin-Token': tokenA },
      body: 'x'.repeat(MAX_BODY_BYTES + 128)
    });
    assert.equal(huge.status, 413);

    // Host 路由鉴权
    const hostOk = await fetch(`http://127.0.0.1:${port}/host/ping`, {
      method: 'POST',
      headers: { Origin: 'https://127.0.0.1:51410', 'X-AGY-Host-Token': hostToken },
      body: '{}'
    });
    assert.equal(hostOk.status, 200);
    assert.deepEqual(await hostOk.json(), { ok: true, host: true });

    // 插件内置系统路由（/__settings, /__command）仅需合法插件 Token，不计入插件自定义路由计数
    bridge.registerPluginSystemRoute('/__settings', async (body, meta) => ({
      ok: true,
      system: true,
      pluginId: meta.pluginId,
      action: body.action || 'get'
    }));
    assert.equal(bridge.countPluginRoutes('agy-daddy.beta'), 0);
    const sysOk = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.beta/__settings`, {
      method: 'POST',
      headers: { Origin: 'https://127.0.0.1:51410', 'Content-Type': 'application/json', 'X-AGY-Plugin-Token': tokenB },
      body: JSON.stringify({ action: 'get' })
    });
    assert.equal(sysOk.status, 200);
    assert.deepEqual(await sysOk.json(), { ok: true, system: true, pluginId: 'agy-daddy.beta', action: 'get' });

    const sysCross = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.beta/__settings`, {
      method: 'POST',
      headers: { Origin: 'https://127.0.0.1:51410', 'Content-Type': 'application/json', 'X-AGY-Plugin-Token': tokenA },
      body: '{}'
    });
    assert.equal(sysCross.status, 403);

    // 卸载清理路由与吊销 Token
    bridge.unregisterPluginRoutes('agy-daddy.alpha');
    const afterUnload = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.alpha/echo`, {
      method: 'POST',
      headers: { Origin: 'https://127.0.0.1:51410', 'X-AGY-Plugin-Token': tokenA },
      body: '{}'
    });
    assert.equal(afterUnload.status, 403);
    const sysAfterUnload = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.alpha/__settings`, {
      method: 'POST',
      headers: { Origin: 'https://127.0.0.1:51410', 'X-AGY-Plugin-Token': tokenA },
      body: '{}'
    });
    assert.equal(sysAfterUnload.status, 403);
  } finally {
    await bridge.stop();
  }
});

test('RPC 多路径回退发现与方法白名单门禁', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-rpc-'));
  try {
    const oldFile = path.join(tmpDir, 'hub_1001.json');
    const newFile = path.join(tmpDir, 'hub_1002.json');
    fs.writeFileSync(oldFile, JSON.stringify({ httpsPort: 50001, csrfToken: 'old-tok' }));
    fs.writeFileSync(newFile, JSON.stringify({ httpsPort: 50002, csrfToken: 'new-tok' }));
    fs.utimesSync(oldFile, new Date(1000000), new Date(1000000));
    fs.utimesSync(newFile, new Date(2000000), new Date(2000000));

    const hub = discoverFromHubDaemonFiles({ daemonDirs: [tmpDir] });
    assert.equal(hub.origin, 'https://127.0.0.1:50002');
    assert.equal(hub.csrfToken, 'new-tok');

    const transport = {
      getOrigin: async () => hub.origin,
      call: async (method) => ({ ok: true, method })
    };

    const readOnlyRpc = createScopedRpcClient('p.reader', ['rpc:read'], transport);
    assert.equal((await readOnlyRpc.call('GetUserStatus')).ok, true);
    await assert.rejects(() => readOnlyRpc.call('SendUserCascadeMessage', {}), /RPC_PERMISSION_DENIED/);
    await assert.rejects(() => readOnlyRpc.call('DeleteAllData', {}), /RPC_METHOD_BLOCKED/);

    const writeRpc = createScopedRpcClient('p.writer', ['rpc:read', 'rpc:write'], transport);
    assert.equal((await writeRpc.call('SendUserCascadeMessage', {})).ok, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('RPC transport: retryOnTimeout=false 不对超时重复重试，ECONNREFUSED 仍刷新凭据重试', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-rpc-retry-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'hub_2001.json'), JSON.stringify({ httpsPort: 50011, csrfToken: 'tok-1', pid: process.pid }));
    let calls = 0;
    let mode = 'timeout';
    const transport = createRpcTransport({
      skipCdp: true,
      daemonDirs: [tmpDir],
      request: async () => {
        calls++;
        if (mode === 'timeout') throw new Error('Local API timeout');
        if (mode === 'conn' && calls === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:50011');
        return JSON.stringify({ ok: true, calls });
      }
    });

    await assert.rejects(
      () => transport.call('GetModelResponse', { prompt: 'x' }, { retryOnTimeout: false }),
      /Local API timeout/
    );
    assert.equal(calls, 1, 'retryOnTimeout=false 时超时只尝试一次');

    calls = 0;
    mode = 'conn';
    const res = await transport.call('GetModelResponse', { prompt: 'x' }, { retryOnTimeout: false });
    assert.equal(res.ok, true);
    assert.equal(calls, 2, 'ECONNREFUSED 应刷新凭据并重试一次');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
