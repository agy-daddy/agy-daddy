'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');
const { loadAnchorsRegistry, resolveAnchorSelectors, checkAnchorHealth, checkPluginAnchors } = require('../src/core/anchors');
const { KNOWN_ANCHORS } = require('../src/contracts/constants');
const { createMockHostHarness, createMockDocument } = require('../sdk/mock-harness');
const { createHostRuntime } = require('../src/renderer/host-runtime');

const HOST_ROOT = path.resolve(__dirname, '..');

test('anchors.json 覆盖全部 10 个具名锚点并可检测缺失禁用', () => {
  const registry = loadAnchorsRegistry();
  for (const name of KNOWN_ANCHORS) {
    assert.ok(registry.anchors[name], `Missing anchor definition: ${name}`);
    const resolved = resolveAnchorSelectors(name, '2.33.0', registry);
    assert.equal(resolved.found, true);
    assert.ok(resolved.selectors.length >= 1);
  }

  const doc = createMockDocument();
  const health = checkAnchorHealth(registry, '2.33.0', (sel) => doc.querySelector(sel));
  assert.ok(health.matched['topbar.rightCluster']);
  assert.ok(health.matched['composer.editor']);

  const okCheck = checkPluginAnchors({ requires: { anchors: ['topbar.rightCluster', 'composer.editor'] } }, health);
  assert.equal(okCheck.ok, true);
  const missCheck = checkPluginAnchors({ requires: { anchors: ['fileViewer.header'] } }, health);
  assert.equal(missCheck.ok, false);
  assert.deepEqual(missCheck.missing, ['fileViewer.header']);
});

test('UI 主题色系一致性静态门禁与渲染层产物编译', () => {
  const uiFiles = [
    path.join(HOST_ROOT, 'src', 'renderer', 'styles.css'),
    path.join(HOST_ROOT, 'src', 'renderer', 'host-runtime.js'),
    path.join(HOST_ROOT, 'dist', 'host-renderer.js')
  ];
  const forbidden = [
    /#10b981/i,
    /16,\s*185,\s*129/,
    /#34d399/i,
    /#059669/i,
    /#38bdf8/i,
    /56,\s*189,\s*248/,
    /2,\s*132,\s*199/,
    /#7dd3fc/i,
    /#(?:0369a1|0c4a6e)/i,
    /#(?:fb923c|c2410c)|249,\s*115,\s*22|234,\s*88,\s*12/i
  ];
  for (const f of uiFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of forbidden) {
      assert.equal(re.test(src), false, `${path.basename(f)} violated theme color gate: ${re}`);
    }
  }
  const bundle = fs.readFileSync(uiFiles[2], 'utf8');
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'host-renderer.js' }));
  assert.match(bundle, /#a78bfa/);
});

test('渲染底座隔离清理旧全局、不泄露全局 Token、熔断隔离故障插件', async () => {
  const doc = createMockDocument();
  let disposedCalls = 0;
  const win = {
    location: { href: 'https://127.0.0.1:51410/abc' },
    __AGContextMeter: { dispose: () => { disposedCalls++; } },
    __AGEnhancer: { dispose: () => { disposedCalls++; } },
    __AGY_CTX_CAPSULE_DISPOSE__: () => { disposedCalls++; },
    __antigravityZhPatchCleanup: () => { disposedCalls++; },
    __AGContextMeterLive: { port: 12345, token: 'legacy-secret' }
  };

  const host = createHostRuntime({
    document: doc,
    window: win,
    anchorsRegistry: loadAnchorsRegistry()
  });

  try {
    // 1. 不得在 window 暴露全局 bridge token
    assert.equal(win.__AGYDaddyHost.bridgeToken, undefined);
    assert.equal(win.__AGYDaddyHost.hostToken, undefined);

    // 2. 清理旧套件全局对象
    const cleaned = host.disposeLegacyGlobals();
    assert.equal(disposedCalls, 4);
    assert.equal(cleaned.length, 4);
    assert.equal(win.__AGContextMeterLive, undefined);

    // 3. 挂载正常插件与故障插件，故障插件崩溃不影响正常插件
    await host.mountPlugin('good.plugin', {
      mount(ctx) {
        ctx.topbar.registerUnit({ id: 'ok', order: 1, label: 'OK' });
      },
      dispose() {}
    });

    const badRes = await host.mountPlugin('bad.plugin', {
      mount() { throw new Error('boom'); }
    });
    assert.equal(badRes.ok, false);
    assert.equal(host.getPluginUsageStats('good.plugin').domNodes, 1);
    assert.equal(host.getPluginUsageStats('bad.plugin').domNodes, 0);
  } finally {
    await host.dispose();
  }
});

test('SDK Mock Harness 端到端运行模板插件 example.hello（隔离世界校验 + 零泄漏 dispose）', async () => {
  const harness = createMockHostHarness();
  try {
    const templateDir = path.join(HOST_ROOT, 'templates', 'plugin-template');
    const loaded = await harness.loadAndRunPlugin(templateDir, {
      trustLevel: 'T2',
      grantedPermissions: ['dom:write', 'bridge:route']
    });
    assert.equal(loaded.manifest.id, 'example.hello');
    assert.equal(loaded.trust.world, 'isolated');
    assert.ok(harness.isolatedWorlds.has('example.hello'));

    // 隔离世界不能读取主世界的 __APP_CONFIG__.csrfToken
    const isoWinCheck = vm.runInContext('typeof __APP_CONFIG__', harness.isolatedWorlds.get('example.hello'));
    assert.equal(isoWinCheck, 'undefined');

    // 验证 Node 服务与粘性状态
    const greetRes = await harness.bus.callService('hello', 'greet', ['World']);
    assert.equal(greetRes.value, 'Hi, World!');
    assert.equal(harness.bus.getState('state:hello.greeting@1').value.ready, true);

    // 卸载并严格断言零残留
    await harness.unloadPlugin('example.hello');
    harness.assertCleanDispose('example.hello');
  } finally {
    await harness.cleanup();
  }
});
