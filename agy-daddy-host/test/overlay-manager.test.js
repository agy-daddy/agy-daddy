'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  OverlayManager,
  MemoryOverlayBackend,
  clampBounds,
  sanitizeSceneSpec,
  resolveConfinedSpritePath
} = require('../src/core/overlay-manager');
const { AgyDaddyDaemon } = require('../src/core/daemon');
const { createMockHostHarness } = require('../sdk');

function createTinyPngBuffer(width = 64, height = 64) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLen = Buffer.from([0, 0, 0, 13]);
  const ihdrTag = Buffer.from('IHDR', 'ascii');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // RGBA
  const crc = Buffer.alloc(4);
  return Buffer.concat([sig, ihdrLen, ihdrTag, ihdrData, crc]);
}

test('OverlayManager 权限校验、单窗限制、尺寸裁剪与精灵路径沙箱', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ovl-test-'));
  const pluginDir = path.join(tmpRoot, 'plugin');
  const dataDir = path.join(tmpRoot, 'state', 'plugin-data', 'third.demo');
  const outsideFile = path.join(tmpRoot, 'secret.png');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(outsideFile, createTinyPngBuffer(64, 64));
  fs.writeFileSync(path.join(pluginDir, 'pet.png'), createTinyPngBuffer(128, 128));
  fs.writeFileSync(path.join(pluginDir, 'huge.png'), createTinyPngBuffer(600, 600));
  fs.writeFileSync(path.join(pluginDir, 'fake.png'), Buffer.from('not-a-png'));

  const backend = new MemoryOverlayBackend();
  const mgr = new OverlayManager({ stateDir: path.join(tmpRoot, 'state'), backend, minUpdateIntervalMs: 120 });

  try {
    // 无权限拒绝
    await assert.rejects(
      () => mgr.createWindow('third.demo', { id: 'pet' }, { pluginDir, permissions: ['dom:read'] }),
      /OVERLAY_PERMISSION_DENIED/
    );

    const handle = await mgr.createWindow(
      'third.demo',
      { id: 'pet', bounds: { x: -5000, y: 99999, width: 900, height: 10 }, visible: false },
      { pluginDir, permissions: ['ui:desktop-overlay'] }
    );
    // visible: false 时不应启动后端子进程
    assert.equal(backend.started, false);

    // 单插件最多 1 个窗口
    await assert.rejects(
      () => mgr.createWindow('third.demo', { id: 'pet2' }, { pluginDir, permissions: ['ui:desktop-overlay'] }),
      /OVERLAY_WINDOW_LIMIT/
    );

    // 尺寸与边界裁剪
    const listed = mgr.listPluginWindows('third.demo');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].bounds.width, 360);
    assert.equal(listed[0].bounds.height, 64);

    // 精灵路径逃逸、远程 URL、假魔数、超尺寸拒绝
    await assert.rejects(() => handle.setScene({
      sceneId: 's1', viewBox: { width: 100, height: 100 }, hitBox: { x: 10, y: 10, width: 80, height: 80 },
      layers: [{ id: 'sp', kind: 'sprite', spritePath: '../secret.png' }]
    }), /OVERLAY_SPRITE_ESCAPE/);

    await assert.rejects(() => handle.setScene({
      sceneId: 's2', viewBox: { width: 100, height: 100 }, hitBox: { x: 10, y: 10, width: 80, height: 80 },
      layers: [{ id: 'sp', kind: 'sprite', spritePath: 'https://evil.example/a.png' }]
    }), /OVERLAY_SPRITE_FORBIDDEN/);

    await assert.rejects(() => handle.setScene({
      sceneId: 's3', viewBox: { width: 100, height: 100 }, hitBox: { x: 10, y: 10, width: 80, height: 80 },
      layers: [{ id: 'sp', kind: 'sprite', spritePath: 'fake.png' }]
    }), /OVERLAY_SPRITE_FORMAT/);

    await assert.rejects(() => handle.setScene({
      sceneId: 's4', viewBox: { width: 100, height: 100 }, hitBox: { x: 10, y: 10, width: 80, height: 80 },
      layers: [{ id: 'sp', kind: 'sprite', spritePath: 'huge.png' }]
    }), /OVERLAY_SPRITE_DIMENSIONS/);

    // 合法本地精灵与 SVG 路径放行
    assert.equal(resolveConfinedSpritePath('pet.png', pluginDir, dataDir), fs.realpathSync(path.join(pluginDir, 'pet.png')));
    await handle.setScene({
      sceneId: 'ok',
      viewBox: { width: 120, height: 120 },
      hitBox: { x: 20, y: 20, width: 80, height: 80 },
      layers: [
        { id: 'body', kind: 'path', d: 'M10 10 L90 10 L90 90 Z', fill: '#a78bfa' },
        { id: 'sp', kind: 'sprite', spritePath: 'pet.png', x: 0, y: 0, width: 64, height: 64 }
      ]
    });

    // setVisible(true) 懒启动后端并回放场景
    await handle.setVisible(true);
    assert.equal(backend.started, true);
    assert.ok(backend.scenes.has('third.demo:pet'));

    // updateState 节流合并 + approval 立即刷新
    const beforeCmds = backend.commands.filter((c) => c.type === 'update-state').length;
    await handle.updateState({ animState: 'walking', speedFactor: 1.5 });
    await handle.updateState({ animState: 'trotting', speedFactor: 2.1 });
    await handle.updateState({ animState: 'sprinting', speedFactor: 3.0 });
    const afterBurst = backend.commands.filter((c) => c.type === 'update-state').length;
    assert.equal(afterBurst - beforeCmds, 1);

    await handle.updateState({ animState: 'approval', bubble: { id: 'b1', kind: 'approval', title: 'X'.repeat(80) } });
    const flushedState = backend.states.get('third.demo:pet');
    assert.equal(flushedState.animState, 'approval');
    assert.ok(flushedState.bubble.title.length <= 48);

    // setVisible(false) 停止后端释放资源
    await handle.setVisible(false);
    assert.equal(backend.started, false);

    // 交互事件回调
    const events = [];
    const stopEv = handle.onInteraction((ev) => events.push(ev));
    backend.simulateInteraction({ type: 'bubble-click', windowId: 'third.demo:pet', bubbleId: 'b1' });
    assert.equal(events.length, 1);
    assert.equal(events[0].windowId, 'pet');
    assert.equal(events[0].bubbleId, 'b1');
    stopEv();

    await handle.dispose();
    assert.equal(mgr.listPluginWindows('third.demo').length, 0);
  } finally {
    await mgr.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('MockHarness assertCleanDispose 检查 overlay 窗口泄漏，T1 Worker IPC 透传完整', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ovl-worker-'));
  const pluginDir = path.join(tmpRoot, 't1-overlay');
  fs.mkdirSync(path.join(pluginDir, 'src'), { recursive: true });

  fs.writeFileSync(path.join(pluginDir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'community.ovl',
    publisher: 'community',
    version: '1.0.0',
    displayName: 'T1 Overlay',
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    world: 'isolated',
    permissions: ['ui:desktop-overlay'],
    contributes: {
      'desktop.overlay': { id: 'mini', defaultWidth: 180, defaultHeight: 180 }
    }
  }, null, 2));

  fs.writeFileSync(path.join(pluginDir, 'src', 'node.js'), `
'use strict';
let handle = null;
const received = [];
async function activate(host) {
  const sup = await host.overlay.isSupported();
  handle = await host.overlay.createWindow({ id: 'mini', visible: true, bounds: { width: 180, height: 180 } });
  handle.onInteraction((ev) => received.push(ev));
  await handle.setScene({
    sceneId: 's',
    viewBox: { width: 100, height: 100 },
    hitBox: { x: 10, y: 10, width: 80, height: 80 },
    layers: [{ id: 'c', kind: 'circle', cx: 50, cy: 50, r: 30, fill: '#a78bfa' }]
  });
  host.commands.register('ovl.check', async () => ({ sup, received, wins: await host.overlay.listWindows() }));
}
async function deactivate() {
  if (handle) { await handle.dispose(); handle = null; }
}
module.exports = { activate, deactivate };
`);

  // 1. MockHarness 泄漏校验（未调用 deactivate 清理 overlay 窗口）
  const leakyDir = path.join(tmpRoot, 't1-leaky');
  fs.mkdirSync(path.join(leakyDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(leakyDir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'community.leaky',
    publisher: 'community',
    version: '1.0.0',
    displayName: 'Leaky Overlay',
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    world: 'isolated',
    permissions: ['ui:desktop-overlay']
  }, null, 2));
  fs.writeFileSync(path.join(leakyDir, 'src', 'node.js'), `
'use strict';
async function activate(host) {
  await host.overlay.createWindow({ id: 'mini', visible: true });
}
module.exports = { activate };
`);

  const harness = createMockHostHarness();
  try {
    await harness.loadAndRunPlugin(leakyDir, { trustLevel: 'T0' });
    await harness.unloadPlugin('community.leaky');
    assert.throws(() => harness.assertCleanDispose('community.leaky'), /leaked 1 overlay windows/);

    await harness.loadAndRunPlugin(pluginDir, { trustLevel: 'T0' });
    await harness.unloadPlugin('community.ovl');
    harness.assertCleanDispose('community.ovl');
  } finally {
    await harness.cleanup();
  }

  // 2. Daemon T1 Worker IPC 往返校验
  const stateDir = path.join(tmpRoot, 'daemon-state');
  const backend = new MemoryOverlayBackend();
  const daemon = new AgyDaddyDaemon({
    stateDir,
    overlayOptions: { backend },
    plugins: [{
      id: 'community.ovl',
      installPath: pluginDir,
      trustLevel: 'T1',
      grantedPermissions: ['ui:desktop-overlay'],
      enabled: true
    }]
  });
  try {
    await daemon.start();
    assert.equal(backend.started, true);
    backend.simulateInteraction({ type: 'pet-click', windowId: 'community.ovl:mini' });
    await new Promise((r) => setTimeout(r, 60));
    const check = await daemon.executeCommand('ovl.check', []);
    assert.equal(check.sup.backend, 'memory');
    assert.equal(check.wins.length, 1);
    assert.equal(check.received.length, 1);
    assert.equal(check.received[0].type, 'pet-click');
    await daemon.deactivatePlugin('community.ovl');
    assert.equal(daemon.overlayManager.listPluginWindows('community.ovl').length, 0);
  } finally {
    await daemon.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('clampBounds 在多工作区边界下保持至少 48x48 可见区域', () => {
  const wa = { x: 0, y: 25, width: 1280, height: 775 };
  const clamped = clampBounds({ x: -500, y: 5000, width: 200, height: 200 }, null, wa);
  assert.equal(clamped.x, -152); // 0 - 200 + 48
  assert.equal(clamped.y, 752);  // 25 + 775 - 48
});
