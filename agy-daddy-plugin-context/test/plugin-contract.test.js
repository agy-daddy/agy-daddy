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

test('插件契约：主题门禁、主世界 UI 胶囊与面板、事件去重、可选 usage 降级与零泄漏 dispose', async () => {
  // 1. 全 src 目录紫色主题静态门禁
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
  for (const fileName of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const full = path.join(PLUGIN_ROOT, 'src', fileName);
    const src = fs.readFileSync(full, 'utf8');
    for (const re of forbidden) {
      assert.equal(re.test(src), false, `${fileName} violated theme color gate: ${re}`);
    }
  }

  const telemetryEvents = [];
  const sampleRpcHandler = (method) => {
    if (method === 'GetAvailableModels') {
      return {
        models: {
          'claude-opus-5-5': { model: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', maxTokens: 1000000 }
        }
      };
    }
    if (method === 'GetAllCascadeTrajectories') {
      return {
        trajectorySummaries: {
          '11111111-2222-3333-4444-555555555555': {
            lastModifiedTime: '2026-11-21T10:00:00Z',
            annotations: { title: '测试会话' }
          }
        }
      };
    }
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      return {
        generatorMetadata: [
          {
            stepIndices: [0],
            createdAt: '2026-11-21T10:00:00Z',
            chatModel: {
              model: 'claude-opus-5-5',
              modelDisplayName: 'Claude Opus 5.5',
              timeToFirstToken: '0.5s',
              streamingDuration: '1.5s',
              usage: { responseId: 'call-ctx-1', inputTokens: 2000, cacheReadTokens: 18000, outputTokens: 400 },
              chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 1000000 } }
            }
          }
        ]
      };
    }
    if (method === 'GetCascadeTrajectory') {
      return {
        steps: [
          { userInput: { userResponse: '测试提问' } },
          { plannerResponse: { response: '测试回答', thinking: '思考' } }
        ]
      };
    }
    return {};
  };

  const harness = createMockHostHarness({ onRpc: sampleRpcHandler });
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    harness.bus.onEvent('test', 'telemetry:generator-calls@1', (p) => telemetryEvents.push(p));

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, {
      trustLevel: 'T0',
      inProcessRenderer: true
    });
    assert.equal(loaded.manifest.id, 'agy-daddy.context');
    assert.equal(loaded.trust.world, 'main');

    // 验证顶栏单元与底部 Pulse 胶囊均已挂载
    const barChildren = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot.querySelector('#agy-topbar-slots').children;
    const ringBtn = barChildren.find((c) => c.id === 'agy-unit-agy-daddy.context-ring');
    assert.ok(ringBtn);
    assert.match(ringBtn.textContent, /20\.4k\/1M/);
    assert.match(ringBtn.textContent, /200\/s/);

    const pulseBtn = harness.mockDoc.querySelector('[data-agy-context-capsule="1"]');
    assert.ok(pulseBtn);
    assert.match(pulseBtn.textContent, /20\.4k\/1M/);
    assert.match(pulseBtn.getAttribute('data-dual-svg') || '', /<svg[^>]*data-occ=/);

    // 验证可选订阅 state:quota.snapshot@1 写入 5h 倒计时，且弹出面板展示 5 组结构拆解
    let setQuota = null;
    await harness.rendererHost.mountPlugin('test.quota.pub', {
      mount(ctx) { setQuota = (q) => ctx.state.set('state:quota.snapshot@1', q); }
    });
    setQuota({ gemini: { countdownText: '3小时10分' } });
    assert.match(pulseBtn.textContent, /5h:3小时10分/);
    const panelEl = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot.querySelector('#agy-context-panel');
    assert.ok(panelEl);
    assert.match(panelEl.textContent, /结构拆解\(5组\)/);
    await harness.rendererHost.disposePlugin('test.quota.pub');

    // 验证事件广播与 callId 幂等去重
    assert.equal(telemetryEvents.length, 1);
    assert.equal(telemetryEvents[0].calls[0].callId, 'call-ctx-1');

    const ctxSvc = harness.bus.getServiceProxy('context');
    const bufferedCalls = await ctxSvc.getRecentCalls(0);
    assert.equal(bufferedCalls.length, 1);

    // 重复扫描同一 callId 不重复广播
    const snapWithoutUsage = await ctxSvc.rescan({ cascadeId: '11111111-2222-3333-4444-555555555555' });
    assert.equal(telemetryEvents.length, 1);
    assert.equal(snapWithoutUsage.referenceCost, null); // usage 未安装时安全降级

    // 模拟 usage 服务上线后，referenceCost 自动填充并反映到移动端快照
    harness.bus.provideService('agy-daddy.usage', 'usage', {
      estimateCallsCost(calls) {
        return { callsCount: calls.length, totalUsd: 0.1234 };
      }
    }, { realm: 'node' });

    const snapWithUsage = await ctxSvc.rescan({ cascadeId: '11111111-2222-3333-4444-555555555555' });
    assert.deepEqual(snapWithUsage.referenceCost, { callsCount: 1, totalUsd: 0.1234 });

    const mobileSnap = await ctxSvc.getMobileSnapshot({ cascadeId: '11111111-2222-3333-4444-555555555555' });
    assert.equal(mobileSnap.used, 20400);
    assert.equal(mobileSnap.budget, 1000000);
    assert.deepEqual(mobileSnap.referenceCost, { callsCount: 1, totalUsd: 0.1234 });

    // 卸载并严格断言零泄漏（包含底部 Pulse 胶囊移除）
    await harness.unloadPlugin('agy-daddy.context');
    assert.equal(harness.mockDoc.querySelector('[data-agy-context-capsule="1"]'), null);
    harness.assertCleanDispose('agy-daddy.context');
  } finally {
    await harness.cleanup();
  }
});
