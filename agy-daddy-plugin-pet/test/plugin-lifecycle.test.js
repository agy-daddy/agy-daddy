'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

test('agy-daddy.pet 插件完整生命周期：桌面置顶懒启停、PC-Web 状态同步、气泡联动与零泄漏 dispose', async () => {
  const harness = createMockHostHarness({
    onRpc(method, body) {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'cid-bg': {
              status: 'CASCADE_RUN_STATUS_IDLE',
              stepCount: 2,
              workspaces: [{ workspaceFolderAbsoluteUri: 'file:///work/alpha' }],
              annotations: { title: '后台会话' }
            }
          }
        };
      }
      if (method === 'GetCascadeTrajectorySteps' && body?.cascadeId === 'cid-bg') {
        return {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
            {
              type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
              status: 'CORTEX_STEP_STATUS_PENDING',
              requestedInteraction: { runCommand: { commandLine: 'git status' } }
            }
          ]
        };
      }
      return {};
    }
  });

  try {
    const petStates = [];
    const focusEvents = [];
    harness.bus.subscribeState('test', 'state:pet.state@1', (val) => petStates.push(val));
    harness.bus.onEvent('test', 'pet:focus-session@1', (ev) => focusEvents.push(ev));

    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.equal(loaded.manifest.id, 'agy-daddy.pet');
    assert.equal(loaded.manifest.world, 'isolated');

    // 桌面置顶窗口应已懒启动
    assert.equal(harness.overlayManager.listPluginWindows('agy-daddy.pet').length, 1);
    assert.equal(harness.overlayManager.backend.started, true);

    const petSvc = harness.bus.getServiceProxy('pet');
    const snap0 = await petSvc.getSnapshot();
    assert.equal(snap0.ok, true);
    assert.equal(snap0.themes.length, 12);
    assert.equal(snap0.state.themeId, 'daddy-orb');

    // 推送 context.live@1 高流速 -> 桌宠状态加速
    harness.bus.setState('agy-daddy.context', 'state:context.live@1', {
      cascadeId: 'cid-fg',
      busy: true,
      phase: 'streaming',
      tps: 92,
      updatedAt: Date.now()
    });
    await new Promise((r) => setTimeout(r, 40));
    const snapFast = await petSvc.getSnapshot();
    assert.equal(snapFast.state.motion.animState, 'sprinting');
    assert.equal(snapFast.state.motion.tps, 92);

    // 关闭桌面置顶但保持 webVisible=true -> 原生浮窗立即释放，PC-Web 状态保持开启
    await harness.updatePluginSettings('agy-daddy.pet', { desktopVisible: false });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(harness.overlayManager.listPluginWindows('agy-daddy.pet').length, 0);
    assert.equal(harness.overlayManager.backend.started, false);
    const snapWebOnly = await petSvc.getSnapshot();
    assert.equal(snapWebOnly.state.desktopVisible, false);
    assert.equal(snapWebOnly.state.webVisible, true);

    // 重新开启桌面置顶 + 点击气泡聚焦会话
    await harness.updatePluginSettings('agy-daddy.pet', { desktopVisible: true });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(harness.overlayManager.listPluginWindows('agy-daddy.pet').length, 1);

    await petSvc.handleInteraction({ action: 'bubble-click', bubbleId: 'cid-bg:1:approval', cascadeId: 'cid-bg' });
    assert.equal(focusEvents.length, 1);
    assert.equal(focusEvents[0].cascadeId, 'cid-bg');

    // 卸载并严格断言零资源泄漏
    await harness.unloadPlugin('agy-daddy.pet');
    assert.equal(petStates[petStates.length - 1], null);
    harness.assertCleanDispose('agy-daddy.pet');
  } finally {
    await harness.cleanup();
  }
});
