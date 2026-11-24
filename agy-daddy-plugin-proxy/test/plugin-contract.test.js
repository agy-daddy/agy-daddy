'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

async function getFreePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function waitUntil(pred, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

test('插件契约：isolated 世界、托管配置免重启热重载、命令与零残留 dispose（无顶栏胶囊）', async () => {
  // 主题一致性静态门禁（UI 不得包含禁用非主题色）
  const srcFiles = fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))
    .map((f) => path.join(PLUGIN_ROOT, 'src', f))
    .filter((f) => fs.statSync(f).isFile());
  for (const file of srcFiles) {
    const src = fs.readFileSync(file, 'utf8');
    for (const re of [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i, /#fb923c/i, /#c2410c/i]) {
      assert.equal(re.test(src), false, `Source violated purple theme gate (${file}): ${re}`);
    }
    assert.equal(/registerSection/.test(src), false, `Source must not use deprecated registerSection (${file})`);
  }

  const harness = createMockHostHarness();
  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, {
      trustLevel: 'T0'
    });
    assert.equal(loaded.manifest.id, 'agy-daddy.proxy');
    assert.equal(loaded.manifest.world, 'isolated');
    assert.equal(loaded.trust.world, 'isolated');
    assert.equal(loaded.manifest.renderer, undefined);
    assert.equal(loaded.manifest.permissions.includes('page:main-world'), false);
    assert.equal(loaded.manifest.permissions.includes('dom:write'), false);
    assert.equal(loaded.manifest.contributes['topbar.units'], undefined);
    assert.equal('migrations' in (loaded.manifest.contributes || {}), false);

    const svc = harness.bus.getServiceProxy('proxy');
    const st0 = await svc.getStatus();
    assert.equal(st0.listening, true);
    assert.ok(st0.gatewayPort > 0);
    assert.equal(st0.mode, 'direct');

    const topbarSlots = harness.mockDoc.getElementById('agy-daddy-host')?.shadowRoot?.querySelector('#agy-topbar-slots');
    if (topbarSlots) {
      assert.equal(
        topbarSlots.children.some((c) => String(c.id || '').includes('agy-daddy.proxy')),
        false
      );
    }

    // 验证 hostLaunchArgs / hostLaunchEnv 钩子导出本地固定网关地址
    const argHooks = await harness.bus.runHooks('hostLaunchArgs', { appPath: '/Applications/Antigravity.app' });
    const flatArgs = argHooks.flatMap((h) => h.result);
    assert.ok(flatArgs.includes(`--proxy-server=http://127.0.0.1:${st0.gatewayPort}`));
    assert.ok(flatArgs.includes('--proxy-bypass-list=localhost;127.0.0.1;[::1];<local>'));

    const envHooks = await harness.bus.runHooks('hostLaunchEnv', {});
    assert.equal(envHooks[0].result.HTTP_PROXY, `http://127.0.0.1:${st0.gatewayPort}`);
    assert.equal(envHooks[0].result.HTTPS_PROXY, `http://127.0.0.1:${st0.gatewayPort}`);

    // 托管设置中心变更触发免重启热重载（mode/upstreamUrl/noProxy/fallback）
    const events = [];
    harness.bus.onEvent('test', 'proxy:config-changed@1', (p) => events.push(p));

    const updRes = await harness.updatePluginSettings('agy-daddy.proxy', {
      mode: 'upstream',
      upstreamUrl: 'http://u:secret@127.0.0.1:7897',
      noProxy: 'localhost,internal.local',
      fallbackToDirectOnUpstreamError: true
    });
    assert.equal(updRes.ok, true);

    const st1 = await svc.getStatus();
    assert.equal(st1.mode, 'upstream');
    assert.equal(st1.gatewayPort, st0.gatewayPort); // 免重启同端口热重载
    assert.equal(st1.upstreamUrl, 'http://u:***@127.0.0.1:7897'); // 脱敏
    assert.equal(st1.noProxy, 'localhost,internal.local');
    assert.equal(st1.fallbackToDirectOnUpstreamError, true);
    assert.ok(events.length >= 1);
    assert.equal(harness.bus.getState('state:proxy.status@1').value.mode, 'upstream');

    // 声明式命令执行：proxy.switch-mode 与 proxy.probe
    const cmdSwitched = await harness.executeCommand('proxy.switch-mode', ['direct']);
    assert.equal(cmdSwitched.mode, 'direct');
    assert.equal(harness.getPluginSettings('agy-daddy.proxy').mode, 'direct');

    const cmdSwitchedUp = await harness.executeCommand('proxy.switch-mode', ['upstream']);
    assert.equal(cmdSwitchedUp.mode, 'upstream');
    assert.equal(harness.getPluginSettings('agy-daddy.proxy').mode, 'upstream');

    const cmdProbe = await harness.executeCommand('proxy.probe', [{ shellEnvOutput: 'PATH=/usr/bin' }]);
    assert.equal(cmdProbe.gatewayTcp.ok, true);

    // 托管设置热重载 gatewayPort 与 gatewayEnabled 启停
    const newPort = await getFreePort();
    await harness.updatePluginSettings('agy-daddy.proxy', { gatewayPort: newPort });
    assert.ok(await waitUntil(async () => (await svc.getStatus()).gatewayPort === newPort));

    await harness.updatePluginSettings('agy-daddy.proxy', { gatewayEnabled: false });
    assert.ok(await waitUntil(async () => (await svc.getStatus()).listening === false));

    await harness.updatePluginSettings('agy-daddy.proxy', { gatewayEnabled: true, mode: 'direct' });
    assert.ok(await waitUntil(async () => (await svc.getStatus()).listening === true));

    // 确认私有设置路由 /set-config 已彻底移除
    const removedRouteResp = await fetch(`http://127.0.0.1:${bridgePort}/plugins/agy-daddy.proxy/set-config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AGY-Plugin-Token': loaded.pluginToken
      },
      body: JSON.stringify({ mode: 'direct' })
    });
    assert.equal(removedRouteResp.status, 404);

    // 卸载并严格断言零残留（gateway/routes/bus/commands/timers/dom）
    await harness.unloadPlugin('agy-daddy.proxy');
    harness.assertCleanDispose('agy-daddy.proxy');
  } finally {
    await harness.cleanup();
  }
});
