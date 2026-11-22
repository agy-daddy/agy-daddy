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
const {
  parseQuotaFraction,
  formatQuotaResetMeta,
  buildModelQuotaSnapshot,
  getQuotaAccentToken
} = require('../src/quota-engine');

test('parseQuotaFraction / formatQuotaResetMeta 与共享池分组解析', () => {
  // quota_summary_bucket 缺省字段不得误判耗尽
  const missingBucket = parseQuotaFraction({ resetTime: '2026-11-22T00:00:00Z' }, { schemaKind: 'quota_summary_bucket' });
  assert.equal(missingBucket.fraction, null);
  assert.equal(missingBucket.isExhausted, false);

  // codeium_quota_info scalar float 省略 0 + resetTime -> 耗尽
  const protoZero = parseQuotaFraction({ resetTime: '2026-11-22T00:00:00Z' }, { schemaKind: 'codeium_quota_info' });
  assert.equal(protoZero.fraction, 0);
  assert.equal(protoZero.isExhausted, true);

  // amount / total ratio
  const ratio = parseQuotaFraction({ remainingAmount: '30', totalAmount: '100' });
  assert.equal(ratio.fraction, 0.3);

  const nowMs = Date.parse('2026-11-21T10:00:00Z');
  const cd = formatQuotaResetMeta('2026-11-21T12:30:00Z', nowMs);
  assert.equal(cd.countdownText, '2小时30分');

  const snap = buildModelQuotaSnapshot({
    nowMs,
    quotaSummaryRes: {
      groups: [
        {
          groupId: 'gemini_main',
          displayName: 'Gemini',
          buckets: [
            { window: '5h', remainingFraction: 0.85, resetTime: '2026-11-21T13:00:00Z' },
            { window: 'weekly', remainingFraction: 0.60, resetTime: '2026-11-25T00:00:00Z' }
          ]
        },
        { groupId: '3p_pool', displayName: 'Claude / 3P', buckets: [{ window: 'weekly', remainingFraction: 0.15, resetTime: '2026-11-25T00:00:00Z' }] }
      ]
    }
  });
  assert.equal(snap.gemini.percentText, '60%');
  assert.equal(snap.pools[0].fiveHourBucket.percentText, '85%');
  assert.equal(snap.pools[0].weeklyBucket.percentText, '60%');
  assert.equal(snap.pools[0].tightestPercentText, '最紧 60%');
  assert.equal(snap.claude.percentText, '15%');
  assert.equal(snap.tightestPercentText, '最紧 15%');
  assert.match(getQuotaAccentToken(0.85), /#a78bfa/);
  assert.match(getQuotaAccentToken(0.15), /#ef4444/);
});

test('插件契约：主题门禁、无 usage/subscription 独立降级、有 subscription Ultra 倍率联动与零残留 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
  }

  const onRpc = (method) => {
    if (method === 'RetrieveUserQuotaSummary') {
      return {
        groups: [
          { groupId: 'shared_gemini_main', displayName: 'Gemini Pool', buckets: [{ window: '5h', remainingFraction: 0.72, resetTime: new Date(Date.now() + 3600000).toISOString() }] },
          { groupId: 'shared_3p_pool', displayName: 'Claude Pool', buckets: [{ window: '5h', remainingFraction: 0.45, resetTime: new Date(Date.now() + 7200000).toISOString() }] }
        ]
      };
    }
    return { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } };
  };

  const harness = createMockHostHarness({ onRpc });
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    // 1. 不装 usage/subscription 独立启动
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0', inProcessRenderer: true });

    const quotaSvc = harness.bus.getServiceProxy('quota');
    const st1 = await quotaSvc.getSnapshot();
    assert.equal(st1.ultraSubTier, null);
    assert.equal(st1.quotaMultiplier, 1);
    assert.equal(st1.gemini.percentText, '72%');
    assert.equal(st1.claude.percentText, '45%');

    const barChildren = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot.querySelector('#agy-topbar-slots').children;
    const quotaBtn = barChildren.find((c) => c.id === 'agy-unit-agy-daddy.quota-quota');
    assert.ok(quotaBtn);
    assert.match(quotaBtn.textContent, /G:72%.*C:45%/);

    // 2. 上线 subscription 服务后补齐 Ultra 20x 倍率
    harness.bus.provideService('agy-daddy.usage', 'subscription', {
      getUltraSubTier: () => '20x'
    }, { realm: 'node' });
    const st2 = await quotaSvc.refresh();
    assert.equal(st2.ultraSubTier, '20x');
    assert.equal(st2.quotaMultiplier, 20);

    const quotaPanel = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot.querySelector('#agy-quota-panel');
    assert.ok(quotaPanel);
    assert.match(quotaPanel.textContent, /最紧 45%/);
    assert.match(quotaPanel.textContent, /5h:/);

    await harness.unloadPlugin('agy-daddy.quota');
    harness.assertCleanDispose('agy-daddy.quota');
  } finally {
    await harness.cleanup();
  }
});
