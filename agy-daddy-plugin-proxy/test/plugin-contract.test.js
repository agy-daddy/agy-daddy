'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

test('插件契约：manifest/settings 校验、启动参数钩子、热切换与零残留 dispose', async () => {
  // 主题一致性静态门禁（UI 不得包含禁用非主题色）
  const rendererSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', 'renderer.js'), 'utf8');
  for (const re of [/#10b981/i, /#34d399/i, /#38bdf8/i, /#7dd3fc/i]) {
    assert.equal(re.test(rendererSrc), false, `Renderer violated purple theme gate: ${re}`);
  }

  const harness = createMockHostHarness();
  try {
    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, {
      trustLevel: 'T0'
    });
    assert.equal(loaded.manifest.id, 'agy-daddy.proxy');
    assert.equal(loaded.trust.world, 'isolated');
    assert.ok(harness.isolatedWorlds.has('agy-daddy.proxy'));

    const svc = harness.bus.getServiceProxy('proxy');
    const st0 = await svc.getStatus();
    assert.equal(st0.listening, true);
    assert.ok(st0.gatewayPort > 0);
    assert.equal(st0.mode, 'direct');

    // 验证 hostLaunchArgs / hostLaunchEnv 钩子导出本地固定网关地址
    const argHooks = await harness.bus.runHooks('hostLaunchArgs', { appPath: '/Applications/Antigravity.app' });
    const flatArgs = argHooks.flatMap((h) => h.result);
    assert.ok(flatArgs.includes(`--proxy-server=http://127.0.0.1:${st0.gatewayPort}`));
    assert.ok(flatArgs.includes('--proxy-bypass-list=<-loopback>'));

    const envHooks = await harness.bus.runHooks('hostLaunchEnv', {});
    assert.equal(envHooks[0].result.HTTP_PROXY, `http://127.0.0.1:${st0.gatewayPort}`);
    assert.equal(envHooks[0].result.HTTPS_PROXY, `http://127.0.0.1:${st0.gatewayPort}`);

    // 热切换上游模式并验证 sticky state + event
    const events = [];
    harness.bus.onEvent('test', 'proxy:config-changed@1', (p) => events.push(p));

    const updated = await svc.setConfig({
      mode: 'upstream',
      upstreamUrl: 'http://u:secret@127.0.0.1:7897'
    });
    assert.equal(updated.mode, 'upstream');
    assert.equal(updated.upstreamUrl, 'http://u:***@127.0.0.1:7897'); // 脱敏
    assert.equal(events.length, 1);
    assert.equal(harness.bus.getState('state:proxy.status@1').value.mode, 'upstream');

    // Bridge 路由携带按插件 Token 校验
    const { port } = await harness.bridge.start(0);
    const resp = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.proxy/switch-mode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AGY-Plugin-Token': loaded.pluginToken
      },
      body: JSON.stringify({ mode: 'direct' })
    });
    const switchJson = await resp.json();
    assert.equal(switchJson.mode, 'direct');

    // 卸载并严格断言零残留（gateway/routes/bus/timers/dom）
    await harness.unloadPlugin('agy-daddy.proxy');
    harness.assertCleanDispose('agy-daddy.proxy');
  } finally {
    await harness.cleanup();
  }
});
