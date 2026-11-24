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

test('插件模板微内核契约 v2：isolated 权限收敛、紫色门禁、样式自注入、托管设置热更新、声明式命令与零残留 dispose', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'agy-plugin.json'), 'utf8'));
  assert.equal(manifest.world, 'isolated');
  assert.equal((manifest.permissions || []).includes('page:main-world'), false);
  assert.equal((manifest.permissions || []).includes('bridge:route'), false);
  assert.equal(manifest.contributes?.migrations, undefined);

  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i, /#fb923c/i, /#c2410c/i];
  for (const f of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', f), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${f} violated theme gate: ${re}`);
    assert.equal(src.includes('registerSection'), false, `${f} must not use registerSection`);
  }

  const harness = createMockHostHarness();
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T2' });
    assert.equal(loaded.trust.world, 'isolated');
    assert.ok(harness.isolatedWorlds.has('example.hello'));

    // 验证 Shadow DOM 样式注入、顶栏胶囊与统一包壳 Popover
    const hostEl = harness.mockDoc.getElementById('agy-daddy-host');
    assert.ok(hostEl?.shadowRoot);
    assert.ok(hostEl.shadowRoot.querySelector('[data-agy-style="example.hello"]'));
    assert.ok(hostEl.shadowRoot.querySelector('[data-agy-slot="unit:example.hello:hello-badge"]'));
    const popBody = hostEl.shadowRoot.querySelector('[data-agy-slot="popover:example.hello:hello-popover"]');
    assert.ok(popBody);
    assert.match(popBody.textContent, /Hello Agy-Daddy/);

    // 验证 Node 服务与声明式命令
    const helloSvc = harness.bus.getServiceProxy('hello');
    const res = await helloSvc.greet('Developer');
    assert.equal(res.ok, true);
    assert.equal(res.message, 'Hello, Developer!');

    const cmdRes = await harness.executeCommand('hello.greet', ['Tester']);
    assert.equal(cmdRes.ok, true);
    assert.equal(cmdRes.message, 'Hello, Tester!');

    // 验证托管设置热更新：修改 greeting 与 showBadge
    await harness.updatePluginSettings('example.hello', { greeting: 'Hi Microkernel v2', showBadge: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.match(popBody.textContent, /Hi Microkernel v2/);
    assert.equal(hostEl.shadowRoot.querySelector('[data-agy-slot="unit:example.hello:hello-badge"]'), null);

    await harness.updatePluginSettings('example.hello', { showBadge: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(hostEl.shadowRoot.querySelector('[data-agy-slot="unit:example.hello:hello-badge"]'));

    await harness.unloadPlugin('example.hello');
    assert.equal(hostEl.shadowRoot.querySelector('[data-agy-style="example.hello"]'), null);
    harness.assertCleanDispose('example.hello');
  } finally {
    await harness.cleanup();
  }
});
