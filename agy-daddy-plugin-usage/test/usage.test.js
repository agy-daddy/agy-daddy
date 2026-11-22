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
const { PluginDataStore } = require(path.join(HOST_ROOT, 'src', 'core', 'storage'));
const {
  SUBSCRIPTION_ACQUISITION_PRESETS,
  calculateRequestApiCost,
  summarizeApiCost,
  summarizeByPeriod,
  buildHeatmap52Weeks,
  LedgerManager
} = require('../src/pricing-ledger');
const { renderHeatmapSvg } = require('../src/heatmap-svg');

test('计价费率阶梯（日期切换与 200K 分档）、52 周热力图与损坏账本 fail-closed', async () => {
  // gemini-4-carbon 11月 ($2/$10/$0.1) vs 12月涨价 ($4/$20/$0.2)
  const nov = calculateRequestApiCost({
    model: 'gemini-4-carbon',
    inputTokens: 1000000,
    cacheReadTokens: 1000000,
    outputTokens: 1000000,
    date: '2026-11-20'
  });
  assert.equal(nov.isPriced, true);
  assert.equal(nov.costUSD, 12.1);

  const dec = calculateRequestApiCost({
    model: 'gemini-4-carbon',
    inputTokens: 1000000,
    cacheReadTokens: 1000000,
    outputTokens: 1000000,
    date: '2026-12-05'
  });
  assert.equal(dec.costUSD, 24.2);

  // gemini-3.1-pro-preview <=200K vs >200K
  const smallPro = calculateRequestApiCost({
    model: 'gemini-3.1-pro-preview',
    inputTokens: 100000,
    outputTokens: 100000,
    date: '2026-11-20'
  });
  assert.equal(smallPro.costUSD, 1.4);

  const largePro = calculateRequestApiCost({
    model: 'gemini-3.1-pro-preview',
    inputTokens: 250000,
    outputTokens: 100000,
    date: '2026-11-20'
  });
  assert.equal(largePro.costUSD, 2.8);

  const sum = summarizeApiCost([
    { model: 'claude-opus-5-5', inputTokens: 1000000, outputTokens: 100000 },
    { model: 'unknown-model', inputTokens: 100 }
  ]);
  assert.equal(sum.pricedCount, 1);
  assert.equal(sum.unpricedCount, 1);
  assert.equal(sum.totalUsd, 6);

  const hm = buildHeatmap52Weeks([
    { date: '2026-11-21', totalTokens: 10000, model: 'gemini-4-hydrogen', inputTokens: 10000 }
  ], Date.parse('2026-11-21T12:00:00Z'));
  assert.equal(hm.weeks, 52);
  assert.equal(hm.daysCount, 364);
  assert.equal(hm.days[hm.days.length - 1].level, 4);

  // 52 周紫色热力图 SVG、订阅优惠预设与今日/本月/今年分期汇总
  const svg = renderHeatmapSvg(hm);
  assert.match(svg, /<svg[^>]*data-weeks="52"/);
  assert.equal((svg.match(/<rect /g) || []).length, 364);
  assert.ok(SUBSCRIPTION_ACQUISITION_PRESETS.some((p) => p.id === 'student_offer'));

  const period = summarizeByPeriod([
    { date: '2026-11-21', model: 'gemini-4-hydrogen', inputTokens: 1000000, outputTokens: 0 },
    { date: '2026-11-01', model: 'gemini-4-hydrogen', inputTokens: 1000000, outputTokens: 0 },
    { date: '2026-01-10', model: 'gemini-4-hydrogen', inputTokens: 1000000, outputTokens: 0 }
  ], Date.parse('2026-11-21T12:00:00Z'), { actualPaidUsd: 2 });
  assert.equal(period.today.totalUsd, 1.5);
  assert.equal(period.month.totalUsd, 3);
  assert.equal(period.year.totalUsd, 4.5);
  assert.equal(period.roi.effectiveSavedUsd, 2.5);

  // 损坏账本拒绝覆盖
  const harness = createMockHostHarness();
  try {
    const store = new PluginDataStore('agy-daddy.usage', { stateDir: harness.stateDir });
    const ledgerPath = path.join(store.dir, 'token-pricing-ledger.json');
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(ledgerPath, '{broken json...');
    const lm = new LedgerManager(store);
    const loaded = lm.load();
    assert.equal(loaded.corrupted, true);
    const writeRes = lm.recordCalls([{ callId: 'c1', model: 'gemini-4-hydrogen', inputTokens: 100 }]);
    assert.equal(writeRes.ok, false);
    assert.match(writeRes.error, /账本已损坏/);
  } finally {
    await harness.cleanup();
  }
});

test('插件契约：主题门禁、事件实时入账 + context 晚启动补拉、subscription 服务与零残留 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
  }

  const harness = createMockHostHarness();
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    // 模拟 context 插件早于 usage 启动并已缓存在轨调用
    harness.bus.provideService('agy-daddy.context', 'context', {
      getRecentCalls: () => [
        { callId: 'backfill-1', model: 'gemini-4-hydrogen', inputTokens: 1000000, outputTokens: 0, totalTokens: 1000000, date: '2026-11-21' }
      ]
    }, { realm: 'node' });

    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0', inProcessRenderer: true });

    const usageSvc = harness.bus.getServiceProxy('usage');
    const subSvc = harness.bus.getServiceProxy('subscription');

    const sum1 = await usageSvc.getSummary();
    assert.equal(sum1.callsCount, 1);
    assert.equal(sum1.totalUsd, 1.5);

    // 通过 telemetry:generator-calls@1 事件实时入账
    harness.bus.emitEvent('agy-daddy.context', 'telemetry:generator-calls@1', {
      cascadeId: 's1',
      calls: [
        { callId: 'stream-2', model: 'claude-sonnet-5-5', inputTokens: 1000000, outputTokens: 100000, totalTokens: 1100000, date: '2026-11-21' }
      ]
    });
    const sum2 = await usageSvc.getSummary();
    assert.equal(sum2.callsCount, 2);
    assert.equal(sum2.totalUsd, 4.5);

    await subSvc.setCustomPlan({ ultraSubTier: '20x' });
    assert.equal(await subSvc.getUltraSubTier(), '20x');

    const barChildren = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot.querySelector('#agy-topbar-slots').children;
    assert.ok(barChildren.some((c) => c.id === 'agy-unit-agy-daddy.usage-tokens'));

    const usagePanel = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot.querySelector('#agy-usage-panel');
    assert.ok(usagePanel);
    assert.match(usagePanel.textContent, /分期统计/);
    assert.match(usagePanel.getAttribute('data-heatmap-svg') || '', /<svg[^>]*data-weeks="52"/);

    await harness.unloadPlugin('agy-daddy.usage');
    harness.assertCleanDispose('agy-daddy.usage');
  } finally {
    await harness.cleanup();
  }
});
