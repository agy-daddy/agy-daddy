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

test('插件模板契约：紫色主题门禁、隔离世界挂载与零残留 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#fb923c/i, /#c2410c/i];
  for (const f of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', f), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${f} violated theme gate: ${re}`);
  }

  const harness = createMockHostHarness();
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T2' });
    assert.equal(loaded.trust.world, 'isolated');

    const helloSvc = harness.bus.getServiceProxy('hello');
    const res = await helloSvc.greet('Developer');
    assert.equal(res.ok, true);
    assert.equal(res.message, 'Hello, Developer!');

    await harness.unloadPlugin('example.hello');
    harness.assertCleanDispose('example.hello');
  } finally {
    await harness.cleanup();
  }
});
