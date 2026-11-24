'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const { PluginDataStore } = require(path.join(HOST_ROOT, 'src', 'core', 'storage'));
const {
  LEDGER_VERSION,
  SUBSCRIPTION_ACQUISITION_PRESETS,
  SUBSCRIPTION_REGIONS_PRESET,
  findRegionPreset,
  convertToCNY,
  resolveSubscriptionCost,
  isGeminiModel,
  filterCallsBySource,
  detectSubscriptionFromUserStatus,
  normalizeModelId,
  resolveModelBucketKey,
  calculateRequestApiCost,
  summarizeApiCost,
  summarizeByPeriod,
  buildHeatmap52Weeks,
  LedgerManager
} = require('../src/pricing-ledger');
const {
  runHistoryBackfill,
  repairLedgerFromTranscripts,
  scanTranscriptBackfill,
  extractModelSelectionFromText
} = require('../src/history-backfill');
const { renderHeatmapSvg } = require('../src/heatmap-svg');
const { getLocalizedAutoLabel, formatTierChipLabel, formatUnitText } = require('../src/renderer');

test('计价费率阶梯、区域订阅换算、Gemini/其他模型拆分、IDE/CLI 过滤与损坏账本 fail-closed', async () => {
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

  // Gemini vs 其他模型识别与 Token 汇总拆分
  assert.equal(isGeminiModel({ model: 'Gemini 4 Neon (High)' }), true);
  assert.equal(isGeminiModel({ model: 'Orchestrator (Neon)' }), true);
  assert.equal(isGeminiModel({ model: 'claude-opus-5-5' }), false);
  assert.equal(isGeminiModel({ model: 'gpt-oss-120b' }), false);

  const sum = summarizeApiCost([
    { model: 'gemini-4-hydrogen', inputTokens: 200000, outputTokens: 50000 },
    { model: 'claude-opus-5-5', inputTokens: 1000000, outputTokens: 100000 },
    { model: 'unknown-model', inputTokens: 100 }
  ]);
  assert.equal(sum.pricedCount, 2);
  assert.equal(sum.unpricedCount, 1);
  assert.equal(sum.geminiTokens, 250000);
  assert.equal(sum.otherTokens, 1100100);
  assert.equal(sum.geminiTokens + sum.otherTokens, sum.totalTokens);

  // 区域订阅预设、多币种汇率换算与年付/免费周期
  assert.ok(SUBSCRIPTION_REGIONS_PRESET.length >= 40);
  assert.equal(findRegionPreset('土耳其')?.id, 'TR');
  assert.equal(convertToCNY(2949.99, 'TRY', 'TR'), 392.35);
  assert.equal(convertToCNY(2900, 'JPY', 'JP'), 123.25);

  const trCustom = resolveSubscriptionCost({
    subscriptionRegion: 'TR',
    subscriptionCurrency: 'TRY',
    priceMode: 'custom',
    actualPricePaid: 2949.99,
    billingCycle: 'monthly'
  });
  assert.equal(trCustom.subscriptionCurrency, 'TRY');
  assert.equal(trCustom.subscriptionCurrencySymbol, '₺');
  assert.equal(trCustom.monthlyCostCny, 392.35);
  assert.equal(trCustom.monthlyCostUsd, Number((392.35 / 7.25).toFixed(4)));

  const jpYearly = resolveSubscriptionCost({
    subscriptionRegion: 'JP',
    priceMode: 'preset',
    billingCycle: 'yearly'
  });
  assert.equal(jpYearly.subscriptionCurrency, 'JPY');
  assert.equal(jpYearly.monthlyNative, 2900);
  assert.equal(jpYearly.monthlyCostCny, 123.25);

  const freePlan = resolveSubscriptionCost({
    subscriptionRegion: 'US',
    priceMode: 'custom',
    actualPricePaid: 99,
    billingCycle: 'free'
  });
  assert.equal(freePlan.monthlyCostUsd, 0);
  assert.equal(freePlan.monthlyCostCny, 0);

  const usUltra20 = resolveSubscriptionCost({
    subscriptionRegion: 'US',
    ultraSubTier: '20x',
    priceMode: 'preset',
    billingCycle: 'monthly'
  });
  assert.equal(usUltra20.actualPaidNative, 199.99);
  assert.equal(usUltra20.monthlyCostUsd, 199.99);

  // IDE vs CLI 来源过滤
  const mixed = [
    { callId: 'a', source: 'desktop', totalTokens: 100 },
    { callId: 'b', source: 'cli', totalTokens: 200 },
    { callId: 'c', totalTokens: 300 }
  ];
  assert.equal(filterCallsBySource(mixed, { includeIdeUsage: true, includeCliUsage: true }).length, 3);
  assert.equal(filterCallsBySource(mixed, { includeIdeUsage: true, includeCliUsage: false }).length, 2);
  assert.equal(filterCallsBySource(mixed, { includeIdeUsage: false, includeCliUsage: true }).length, 1);
  assert.equal(filterCallsBySource(mixed, { includeIdeUsage: false, includeCliUsage: false }).length, 0);

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

  // 订阅自动识别：Pro / Ultra 5X / Ultra 20X / 未知
  assert.deepEqual(
    detectSubscriptionFromUserStatus({ userStatus: { userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } }),
    { detectedTier: 'pro', detectedSubTier: null, detectedLabel: 'Pro', source: 'userTier' }
  );
  assert.deepEqual(
    detectSubscriptionFromUserStatus({
      userStatus: {
        userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
        planStatus: { planInfo: { monthlyFlexCreditPurchaseAmount: 10000 } }
      }
    }),
    { detectedTier: 'ultra', detectedSubTier: '5x', detectedLabel: '5X', source: 'userTier+credits' }
  );
  assert.deepEqual(
    detectSubscriptionFromUserStatus({
      userStatus: {
        userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
        planStatus: { planInfo: { monthlyFlexCreditPurchaseAmount: 25000 } }
      }
    }),
    { detectedTier: 'ultra', detectedSubTier: '20x', detectedLabel: '20X', source: 'userTier+credits' }
  );
  assert.equal(detectSubscriptionFromUserStatus(null).detectedLabel, null);

  // 多语言 auto 标签 + 具体套餐组合展示
  assert.equal(getLocalizedAutoLabel('zh-CN'), '自动');
  assert.equal(getLocalizedAutoLabel('en'), 'Auto');
  assert.equal(getLocalizedAutoLabel('ja'), '自動');
  assert.equal(getLocalizedAutoLabel('ko'), '자동');
  assert.equal(formatTierChipLabel({ ultraSubTier: 'auto' }, { plan: { detectedLabel: '20X' } }, 'zh-CN'), '自动 · 20X');
  assert.equal(formatTierChipLabel({ ultraSubTier: 'auto' }, { plan: { detectedLabel: 'Pro' } }, 'en'), 'Auto · Pro');
  assert.equal(formatTierChipLabel({ ultraSubTier: 'auto' }, { plan: { detectedSubTier: '5x' } }, 'ja'), '自動 · 5X');
  assert.equal(formatTierChipLabel({ ultraSubTier: 'pro' }, {}, 'zh-CN'), 'Pro');

  const period = summarizeByPeriod([
    { date: '2026-11-21', model: 'gemini-4-hydrogen', inputTokens: 1000000, outputTokens: 0 },
    { date: '2026-11-01', model: 'gemini-4-hydrogen', inputTokens: 1000000, outputTokens: 0 },
    { date: '2026-01-10', model: 'gemini-4-hydrogen', inputTokens: 1000000, outputTokens: 0 }
  ], Date.parse('2026-11-21T12:00:00Z'), { actualPaidUsd: 2 });
  assert.equal(period.today.totalUsd, 1.5);
  assert.equal(period.month.totalUsd, 3);
  assert.equal(period.year.totalUsd, 4.5);
  assert.equal(period.roi.effectiveSavedUsd, 2.5);

  const periodWithTrCost = summarizeByPeriod([
    { date: '2026-11-21', model: 'gemini-4-hydrogen', inputTokens: 10000000, outputTokens: 0 },
    { date: '2026-10-05', model: 'claude-opus-5-5', inputTokens: 5000000, outputTokens: 0 }
  ], Date.parse('2026-11-21T12:00:00Z'), {
    subscriptionRegion: 'TR',
    subscriptionCurrency: 'TRY',
    priceMode: 'custom',
    actualPricePaid: 2949.99,
    billingCycle: 'monthly'
  });
  assert.equal(periodWithTrCost.month.geminiTokens, 10000000);
  assert.equal(periodWithTrCost.allTime.otherTokens, 5000000);
  // 2 个月活跃成本 = 2 * 54.1172 = 108.2344 USD
  assert.equal(periodWithTrCost.roiByPeriod.month.actualPaidCny, 392.35);
  assert.equal(periodWithTrCost.roiByPeriod.allTime.monthsCount, 2);
  assert.equal(formatUnitText({ periods: periodWithTrCost }, 'month'), '本月 G:10M · 其他:0');
  assert.equal(formatUnitText({ periods: periodWithTrCost }, 'allTime'), '累计 G:10M · 其他:5M');

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

test('插件契约：主题门禁、isolated 世界、IDE/CLI 历史回填与开关过滤、区域实付回本、顶栏仅展示同步周期 G/其他 与零残留 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
  }

  const tmpConvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-conv-'));
  const tmpCliBrainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-usage-cli-brain-'));
  fs.writeFileSync(path.join(tmpConvDir, 'hist-old.pb'), '');
  fs.writeFileSync(path.join(tmpConvDir, 'hist-mid.db'), '');
  fs.writeFileSync(path.join(tmpConvDir, 'hist-mid.db-wal'), '');

  // 构造 CLI transcript.jsonl
  const cliSessDir = path.join(tmpCliBrainDir, 'cli-sess-1', '.system_generated', 'logs');
  fs.mkdirSync(cliSessDir, { recursive: true });
  const todayIso = new Date().toISOString();
  fs.writeFileSync(path.join(cliSessDir, 'transcript.jsonl'), [
    JSON.stringify({ step_index: 0, model: 'claude-opus-5-5', created_at: todayIso }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: todayIso, input_tokens: 400000, cache_read_tokens: 100000, output_tokens: 50000 })
  ].join('\n'));

  const onRpc = (method, body) => {
    if (method === 'GetUserStatus') {
      return {
        userStatus: {
          userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
          planStatus: { planInfo: { monthlyFlexCreditPurchaseAmount: 25000 } }
        }
      };
    }
    if (method === 'GetAllCascadeTrajectories') {
      return {
        trajectorySummaries: {
          'hist-mid': { createdTime: '2026-06-15T12:00:00Z', lastModifiedTime: '2026-06-15T12:10:00Z' }
        }
      };
    }
    if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
      if (body?.cascadeId === 'hist-old') {
        return {
          generatorMetadata: [
            {
              stepIndices: [0],
              chatModel: {
                model: 'gemini-4-hydrogen',
                chatStartMetadata: { createdAt: '2026-03-24T06:36:08.778796Z' },
                usage: { responseId: 'hist-call-1', inputTokens: 1000000, outputTokens: 0 }
              }
            }
          ]
        };
      }
      if (body?.cascadeId === 'hist-mid') {
        return {
          generatorMetadata: [
            {
              stepIndices: [0],
              chatModel: {
                model: 'gemini-4-hydrogen',
                chatStartMetadata: { createdAt: '2026-06-15T12:00:00Z' },
                usage: { responseId: 'backfill-1', inputTokens: 1000000, outputTokens: 0 }
              }
            }
          ]
        };
      }
    }
    return {};
  };

  const harness = createMockHostHarness({ onRpc });
  try {
    const { port, hostToken } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port, hostToken });

    // 预写入已保存配置，验证 renderer 初始化会真实读取已存配置
    const preStore = new PluginDataStore('agy-daddy.usage', { stateDir: harness.stateDir });
    preStore.writeJson('settings.json', {
      activePeriod: 'allTime',
      includeIdeUsage: true,
      includeCliUsage: true,
      ultraSubTier: '5x',
      subscriptionRegion: 'US',
      currency: 'USD'
    });

    // 模拟 context 插件早于 usage 启动并已缓存在轨调用 (IDE 来源)
    harness.bus.provideService('agy-daddy.context', 'context', {
      getRecentCalls: () => [
        { callId: 'backfill-1', source: 'desktop', model: 'gemini-4-hydrogen', inputTokens: 1000000, outputTokens: 0, totalTokens: 1000000, date: '2026-06-15' }
      ]
    }, { realm: 'node' });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.equal(loaded.manifest.world, 'isolated');
    assert.equal(loaded.trust.world, 'isolated');
    assert.equal((loaded.manifest.permissions || []).includes('page:main-world'), false);
    assert.equal('migrations' in (loaded.manifest.contributes || {}), false);

    // 验证私有 /set-plan 路由已彻底移除
    const deadSetPlan = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.usage/set-plan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AGY-Plugin-Token': loaded.pluginToken
      },
      body: JSON.stringify({ ultraSubTier: '20x' })
    });
    assert.equal(deadSetPlan.status, 404);

    // 验证 .ag-heatmap-box 样式已通过 ctx.styles.inject 注入到 shadow
    const shadowRoot = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
    const injectedShadowStyle = shadowRoot.querySelector('style[data-agy-style="agy-daddy.usage"][data-agy-style-id="usage-heatmap-styles"]');
    assert.ok(injectedShadowStyle, 'Expected usage-heatmap-styles injected into shadowRoot');
    assert.match(injectedShadowStyle.textContent, /\.ag-heatmap-box/);

    const usageSvc = harness.bus.getServiceProxy('usage');
    const subSvc = harness.bus.getServiceProxy('subscription');

    assert.equal(await subSvc.getUltraSubTier(), '5x');
    const barChildren = shadowRoot.querySelector('#agy-topbar-slots').children;
    const usageBtn = barChildren.find((c) => c.id === 'agy-unit-agy-daddy.usage-tokens');
    assert.ok(usageBtn);

    // 执行 IDE + CLI 双端历史回填
    const bf1 = await usageSvc.backfillHistory({
      conversationsDirs: [tmpConvDir],
      ideBrainDirs: [],
      cliBrainDirs: [tmpCliBrainDir],
      skipDiskScan: false
    });
    assert.equal(bf1.ok, true);
    assert.equal(bf1.importedCalls, 2); // hist-call-1 (IDE) + cli-sess-1#1 (CLI)
    assert.equal(bf1.scannedTranscripts, 1);
    assert.equal(bf1.earliestDate, '2026-03-24');

    // 增量游标第二次执行应跳过未变更文件与会话
    const bf2 = await usageSvc.backfillHistory({
      conversationsDirs: [tmpConvDir],
      ideBrainDirs: [],
      cliBrainDirs: [tmpCliBrainDir],
      skipDiskScan: false
    });
    assert.equal(bf2.scannedConversations, 0);
    assert.equal(bf2.scannedTranscripts, 0);

    // 触发面板刷新按钮后，全开时：累计 2M Gemini + 550k 其他 (CLI Claude)
    const usagePanel = shadowRoot.querySelector('#agy-usage-panel');
    assert.ok(usagePanel);
    const refreshBtn = usagePanel.querySelector('button.ag-btn-primary');
    assert.ok(refreshBtn);
    refreshBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(usageBtn.textContent, '累计 G:2M · 其他:550k');
    // 顶栏胶囊绝不显示金额符号
    assert.doesNotMatch(usageBtn.textContent, /[$¥]/);

    // 验证面板切换周期 Tab「今日」时，顶栏胶囊立刻同步切换为「今日 G:0 · 其他:550k」且持久化配置
    const todayTab = usagePanel.querySelector('[data-usage-period="today"]');
    assert.ok(todayTab);
    todayTab.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(usageBtn.textContent, '今日 G:0 · 其他:550k');
    assert.equal(harness.getPluginSettings('agy-daddy.usage').activePeriod, 'today');

    // 切回「累计」
    usagePanel.querySelector('[data-usage-period="allTime"]').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(usageBtn.textContent, '累计 G:2M · 其他:550k');

    // 测试关闭 CLI 统计开关：仅保留 IDE 用量 (2M Gemini, 0 其他)
    await harness.updatePluginSettings('agy-daddy.usage', { includeCliUsage: false });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(usageBtn.textContent, '累计 G:2M · 其他:0');

    // 测试关闭 IDE、开启 CLI：仅保留 CLI 用量 (0 Gemini, 550k 其他)
    await harness.updatePluginSettings('agy-daddy.usage', { includeIdeUsage: false, includeCliUsage: true });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(usageBtn.textContent, '累计 G:0 · 其他:550k');

    // 恢复全部开启
    await harness.updatePluginSettings('agy-daddy.usage', { includeIdeUsage: true, includeCliUsage: true });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(usageBtn.textContent, '累计 G:2M · 其他:550k');

    // 通过托管设置配置土耳其区域 + TRY 币种 + 自定义实付 2949.99 + 人民币展示
    await harness.updatePluginSettings('agy-daddy.usage', {
      ultraSubTier: '20x',
      subscriptionRegion: 'TR',
      subscriptionCurrency: 'TRY',
      subscriptionPriceMode: 'custom',
      actualPricePaid: 2949.99,
      billingCycle: 'monthly',
      currency: 'CNY'
    });
    assert.equal(await subSvc.getUltraSubTier(), '20x');
    const sumCny = await usageSvc.getSummary();
    assert.equal(sumCny.currency, 'CNY');
    assert.equal(sumCny.plan.costInfo.regionId, 'TR');
    assert.equal(sumCny.plan.costInfo.subscriptionCurrency, 'TRY');
    assert.equal(sumCny.plan.costInfo.monthlyCostCny, 392.35);
    assert.equal(sumCny.periods.roiByPeriod.month.actualPaidCny, 392.35);

    await new Promise((r) => setTimeout(r, 40));
    const outerPopover = shadowRoot.querySelector('[data-agy-popover="agy-daddy.usage:usage-panel"]');
    assert.ok(outerPopover);
    assert.equal(usagePanel.querySelector('.ag-panel-head'), null, 'Plugin body must not duplicate .ag-panel-head');
    assert.match(usagePanel.textContent, /Ultra 20X/);
    assert.match(usagePanel.textContent, /土耳其/);
    assert.match(usagePanel.textContent, /IDE \+ CLI/);
    assert.match(usagePanel.textContent, /2026-03-24 起/);
    assert.match(usagePanel.textContent, /₺2949\.99\/月/);
    assert.match(usagePanel.getAttribute('data-heatmap-svg') || '', /<svg[^>]*data-weeks="52"/);

    // 切回 auto 后自动识别 Ultra 20X 并随宿主语言切换更新本地化 auto 词
    await harness.updatePluginSettings('agy-daddy.usage', { ultraSubTier: 'auto' });
    assert.equal(await subSvc.getUltraSubTier(), '20x');
    await new Promise((r) => setTimeout(r, 40));
    assert.match(usagePanel.textContent, /自动 · 20X/);

    await harness.rendererHost.mountPlugin('test.locale.emitter', {
      mount(ctx) {
        ctx.state.set('state:host.locale@1', { lang: 'en', bcp47: 'en', locale: 'en' });
      }
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.match(usagePanel.textContent, /Auto · 20X/);
    await harness.rendererHost.disposePlugin('test.locale.emitter');

    // 通过 subscriptionService.setCustomPlan 双向同步至托管设置
    await subSvc.setCustomPlan({ ultraSubTier: '5x' });
    assert.equal(await subSvc.getUltraSubTier(), '5x');
    assert.equal(harness.getPluginSettings('agy-daddy.usage').ultraSubTier, '5x');

    await harness.unloadPlugin('agy-daddy.usage');
    assert.equal(shadowRoot.querySelector('style[data-agy-style="agy-daddy.usage"]'), null);
    harness.assertCleanDispose('agy-daddy.usage');
  } finally {
    fs.rmSync(tmpConvDir, { recursive: true, force: true });
    fs.rmSync(tmpCliBrainDir, { recursive: true, force: true });
    await harness.cleanup();
  }
});

test('summarizeApiCost 全量计入未定价模型、官方新费率、LedgerManager 双键去重且保留真实日期、跨天回填与模型恢复', async () => {
  // 1. 模型归一化与全量 byModel 守恒（含 Neon/3.6/3.7/3.0 Flash/Claude 4.6 官方费率，及 genuinely unpriced worker/3.5-flash/空模型）
  assert.equal(normalizeModelId('Gemini 4 Neon (High)'), 'gemini-4-neon');
  assert.equal(normalizeModelId('Orchestrator (Neon)'), 'gemini-4-neon');
  assert.equal(normalizeModelId('MODEL_PLACEHOLDER_M532'), 'gemini-4-neon');
  assert.equal(normalizeModelId('gemini-3.7-flash'), 'gemini-3.7-flash');
  assert.equal(normalizeModelId('gemini-3-flash-c'), 'gemini-3-flash');
  assert.equal(normalizeModelId('Gemini 3.5 Flash (Medium)'), 'gemini-3.5-flash');
  assert.equal(normalizeModelId('Gemini 3.5 Flash-Lite'), 'gemini-3.5-flash-lite');
  assert.equal(resolveModelBucketKey({ model: 'Gemini 4 Neon (High)' }), 'gemini-4-neon');
  assert.equal(resolveModelBucketKey({ model: '' }), 'unknown');

  // 官方费率校验：Neon ($3/$15/$0.15), 3.6 & 3.7 Flash (2026: $0.75/$3.75/$0.075, 2027: $1.50/$7.50/$0.15),
  // 3 Flash ($0.50/$3.00/$0.05), Claude Opus 4.6 ($5/$25/$0.50), Claude Sonnet 4.6 ($3/$15/$0.30)
  const neonCost = calculateRequestApiCost({
    model: 'MODEL_PLACEHOLDER_M532',
    inputTokens: 1000000,
    cacheReadTokens: 1000000,
    outputTokens: 1000000,
    date: '2026-11-23'
  });
  assert.equal(neonCost.isPriced, true);
  assert.equal(neonCost.modelKey, 'gemini-4-neon');
  assert.equal(neonCost.costUSD, 18.15);

  const f36Cost = calculateRequestApiCost({ model: 'Gemini 3.6 Flash (High)', inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000, date: '2026-08-10' });
  assert.equal(f36Cost.costUSD, 4.575);
  const f37Cost2026 = calculateRequestApiCost({ model: 'gemini-3.7-flash', inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000, date: '2026-08-15' });
  assert.equal(f37Cost2026.costUSD, 4.575);
  const f37Cost2027 = calculateRequestApiCost({ model: 'gemini-3.7-flash', inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000, date: '2027-01-05' });
  assert.equal(f37Cost2027.costUSD, 9.15);
  const f3Cost = calculateRequestApiCost({ model: 'gemini-3-flash-c', inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000, date: '2026-04-01' });
  assert.equal(f3Cost.costUSD, 3.55);
  const opus46Cost = calculateRequestApiCost({ model: 'claude-opus-4-6-thinking', inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000, date: '2026-05-01' });
  assert.equal(opus46Cost.costUSD, 30.5);
  const sonnet46Cost = calculateRequestApiCost({ model: 'claude-sonnet-4-6', inputTokens: 1000000, cacheReadTokens: 1000000, outputTokens: 1000000, date: '2026-10-04' });
  assert.equal(sonnet46Cost.costUSD, 18.3);

  const mixedSum = summarizeApiCost([
    { model: 'gemini-4-hydrogen-high', inputTokens: 1000000, outputTokens: 0 },
    { model: 'Gemini 4 Neon (High)', inputTokens: 2000000, outputTokens: 0 },
    { model: 'Orchestrator (Neon)', inputTokens: 500000, outputTokens: 0 },
    { model: 'gemini-flash-worker-agy', inputTokens: 300000, outputTokens: 0 },
    { model: 'Gemini 3.5 Flash (Medium)', inputTokens: 150000, outputTokens: 0 },
    { model: '', inputTokens: 200000, outputTokens: 0 }
  ]);
  assert.equal(mixedSum.totalTokens, 4150000);
  assert.equal(mixedSum.pricedCount, 3);
  assert.equal(mixedSum.unpricedCount, 3);
  assert.equal(mixedSum.byModel['gemini-4-hydrogen'].isPriced, true);
  assert.equal(mixedSum.byModel['gemini-4-neon'].tokens, 2500000);
  assert.equal(mixedSum.byModel['gemini-4-neon'].isPriced, true);
  assert.equal(mixedSum.byModel['gemini-4-neon'].costUSD, 7.5);
  assert.equal(mixedSum.byModel['gemini-flash-worker-agy'].tokens, 300000);
  assert.equal(mixedSum.byModel['gemini-flash-worker-agy'].isPriced, false);
  assert.equal(mixedSum.byModel['gemini-3.5-flash'].isPriced, false);
  assert.equal(mixedSum.byModel['unknown'].tokens, 200000);
  const byModelTokenSum = Object.values(mixedSum.byModel).reduce((s, v) => s + v.tokens, 0);
  assert.equal(byModelTokenSum, mixedSum.totalTokens);

  // 2. LedgerManager 双键去重（正序、逆序、保留非临时日期、保留同 step 两次不同显式重试）
  const harness = createMockHostHarness();
  try {
    const store = new PluginDataStore('agy-daddy.usage', { stateDir: harness.stateDir });
    const lm = new LedgerManager(store);
    lm.load();

    // 先到 RPC (provisional date=2026-11-23)，后到 Transcript (exact date=2026-11-21)
    lm.recordCalls([
      {
        callId: 'req_rpc_1',
        source: 'backfill',
        cascadeId: 'sess-x',
        stepIndex: 10,
        model: 'Claude Opus 5.5 (High)',
        inputTokens: 100000,
        cacheReadTokens: 0,
        outputTokens: 1000,
        totalTokens: 101000,
        date: '2026-11-23',
        dateIsProvisional: true,
        timestamp: Date.parse('2026-11-23T03:00:00Z')
      }
    ]);
    lm.recordCalls([
      {
        callId: 'sess-x#10',
        source: 'desktop',
        cascadeId: 'sess-x',
        stepIndex: 10,
        model: 'claude-opus-5-5-high',
        inputTokens: 100000,
        cacheReadTokens: 0,
        outputTokens: 1000,
        totalTokens: 101000,
        date: '2026-11-21',
        dateIsProvisional: false,
        timestamp: Date.parse('2026-11-21T08:14:04Z')
      }
    ]);
    assert.equal(lm.getAllCalls().length, 1);
    const merged1 = lm.getAllCalls()[0];
    assert.equal(merged1.callId, 'req_rpc_1');
    assert.equal(merged1.date, '2026-11-21');
    assert.equal(merged1.dateIsProvisional, false);
    assert.equal(merged1.source, 'desktop');

    // 临时日期绝不覆盖已确立的精确日期
    lm.recordCalls([
      {
        callId: 'req_rpc_1',
        source: 'backfill',
        cascadeId: 'sess-x',
        stepIndex: 10,
        model: 'Claude Opus 5.5 (High)',
        inputTokens: 100000,
        cacheReadTokens: 0,
        outputTokens: 1000,
        totalTokens: 101000,
        date: '2026-11-23',
        dateIsProvisional: true,
        timestamp: Date.parse('2026-11-23T05:00:00Z')
      }
    ]);
    assert.equal(lm.getAllCalls()[0].date, '2026-11-21');
    assert.equal(lm.getAllCalls()[0].dateIsProvisional, false);

    // 逆序到达：先 Transcript 后 RPC，再加同 step 的第二次显式重试
    lm.recordCalls([
      {
        callId: 'sess-y#20',
        source: 'desktop',
        cascadeId: 'sess-y',
        stepIndex: 20,
        model: '',
        inputTokens: 50000,
        cacheReadTokens: 0,
        outputTokens: 500,
        totalTokens: 50500,
        date: '2026-11-21',
        dateIsProvisional: false,
        timestamp: Date.parse('2026-11-21T09:00:00Z')
      }
    ]);
    lm.recordCalls([
      {
        callId: 'req_rpc_2a',
        source: 'desktop',
        cascadeId: 'sess-y',
        stepIndex: 20,
        model: 'Gemini 4 Neon (High)',
        inputTokens: 50000,
        cacheReadTokens: 0,
        outputTokens: 500,
        totalTokens: 50500,
        date: '2026-11-23',
        dateIsProvisional: true,
        timestamp: Date.parse('2026-11-23T01:00:00Z')
      },
      {
        callId: 'req_rpc_2b',
        source: 'desktop',
        cascadeId: 'sess-y',
        stepIndex: 20,
        model: 'Gemini 4 Neon (High)',
        inputTokens: 60000,
        cacheReadTokens: 0,
        outputTokens: 600,
        totalTokens: 60600,
        date: '2026-11-21',
        dateIsProvisional: false,
        timestamp: Date.parse('2026-11-21T09:01:00Z')
      }
    ]);
    const yCalls = lm.getAllCalls().filter((c) => c.cascadeId === 'sess-y');
    assert.equal(yCalls.length, 2);
    const call2a = yCalls.find((c) => c.callId === 'req_rpc_2a');
    assert.equal(call2a.date, '2026-11-21');
    assert.equal(call2a.model, 'Gemini 4 Neon (High)');
  } finally {
    await harness.cleanup();
  }

  // 3. 跨天会话回填 + repairLedgerFromTranscripts 清洗旧 v1.0.0 账本并生成备份
  const tmpIdeBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-repair-brain-'));
  const tmpConv = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-repair-conv-'));
  const repairHarness = createMockHostHarness({
    onRpc: (method, body) => {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'multi-day-sess': {
              createdTime: '2026-11-21T06:00:00Z',
              lastModifiedTime: '2026-11-23T04:00:00Z'
            }
          }
        };
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata' && body?.cascadeId === 'multi-day-sess') {
        return {
          generatorMetadata: [
            {
              stepIndices: [10],
              chatModel: {
                model: 'Claude Opus 5.5 (High)',
                usage: { responseId: 'md_claude_1', inputTokens: 100000, outputTokens: 1000 }
              }
            },
            {
              stepIndices: [50],
              chatModel: {
                model: 'Gemini 4 Neon (High)',
                usage: { responseId: 'md_neon_1', inputTokens: 200000, outputTokens: 2000 }
              }
            }
          ]
        };
      }
      return {};
    }
  });
  try {
    const sessLogDir = path.join(tmpIdeBrain, 'multi-day-sess', '.system_generated', 'logs');
    fs.mkdirSync(sessLogDir, { recursive: true });
    fs.writeFileSync(path.join(sessLogDir, 'transcript.jsonl'), [
      JSON.stringify({ step_index: 10, type: 'PLANNER_RESPONSE', model: 'claude-opus-5-5-high', created_at: '2026-11-21T08:14:04Z', input_tokens: 100000, output_tokens: 1000 }),
      JSON.stringify({ step_index: 50, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', created_at: '2026-11-23T03:20:00Z', input_tokens: 200000, output_tokens: 2000 })
    ].join('\n'));

    const store = new PluginDataStore('agy-daddy.usage', { stateDir: repairHarness.stateDir });
    // 写入旧版 v1.0.0 污染账本（含临时错期 Claude + 双源重复）
    store.writeJson('token-pricing-ledger.json', {
      version: '1.0.0',
      updatedAt: '2026-11-23T04:00:00Z',
      calls: {
        md_claude_1: {
          callId: 'md_claude_1',
          source: 'backfill',
          cascadeId: 'multi-day-sess',
          stepIndex: 10,
          model: 'Claude Opus 5.5 (High)',
          inputTokens: 100000,
          cacheTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 1000,
          totalTokens: 101000,
          date: '2026-11-23',
          dateIsProvisional: true,
          timestamp: Date.parse('2026-11-23T04:00:00Z')
        },
        'multi-day-sess#10': {
          callId: 'multi-day-sess#10',
          source: 'desktop',
          cascadeId: 'multi-day-sess',
          stepIndex: 10,
          model: 'claude-opus-5-5-high',
          inputTokens: 100000,
          cacheTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 1000,
          totalTokens: 101000,
          date: '2026-11-21',
          dateIsProvisional: false,
          timestamp: Date.parse('2026-11-21T08:14:04Z')
        },
        md_neon_1: {
          callId: 'md_neon_1',
          source: 'backfill',
          cascadeId: 'multi-day-sess',
          stepIndex: 50,
          model: 'Gemini 4 Neon (High)',
          inputTokens: 200000,
          cacheTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 2000,
          totalTokens: 202000,
          date: '2026-11-23',
          dateIsProvisional: true,
          timestamp: Date.parse('2026-11-23T04:00:00Z')
        }
      }
    });

    const lm = new LedgerManager(store);
    lm.load();
    const rep = repairLedgerFromTranscripts({
      ledger: lm,
      storage: store,
      ideBrainDirs: [tmpIdeBrain],
      cliBrainDirs: [],
      skipDiskScan: false
    });
    assert.equal(rep.ok, true);
    assert.equal(rep.version, LEDGER_VERSION);
    assert.equal(rep.beforeCount, 3);
    assert.equal(rep.afterCount, 2);
    assert.equal(rep.deduplicatedCount, 1);
    assert.equal(rep.datesFixedCount, 2);
    assert.equal(rep.sourcesNormalizedCount, 2);
    assert.ok(fs.existsSync(path.join(store.dir, 'token-pricing-ledger.pre-v1.2.bak.json')));

    const periods = summarizeByPeriod(lm.getAllCalls(), Date.parse('2026-11-23T12:00:00+08:00'));
    assert.equal(periods.today.callsCount, 1);
    assert.equal(periods.today.byModel['claude-opus-5-5'], undefined);
    assert.equal(periods.today.byModel['gemini-4-neon'].tokens, 202000);

    // 新回填同样应按 transcript 分配正确日期而非会话 lastModifiedTime
    const freshStore = new PluginDataStore('agy-daddy.usage.fresh', { stateDir: repairHarness.stateDir });
    const freshLm = new LedgerManager(freshStore);
    freshLm.load();
    await runHistoryBackfill({
      rpc: { call: async (m, b) => repairHarness.options?.onRpc?.(m, b) || (m === 'GetAllCascadeTrajectories' ? { trajectorySummaries: { 'multi-day-sess': { createdTime: '2026-11-21T06:00:00Z', lastModifiedTime: '2026-11-23T04:00:00Z' } } } : { generatorMetadata: [{ stepIndices: [10], chatModel: { model: 'Claude Opus 5.5 (High)', usage: { responseId: 'md_claude_1', inputTokens: 100000, outputTokens: 1000 } } }, { stepIndices: [50], chatModel: { model: 'Gemini 4 Neon (High)', usage: { responseId: 'md_neon_1', inputTokens: 200000, outputTokens: 2000 } } }] }) },
      ledger: freshLm,
      storage: freshStore,
      conversationsDirs: [tmpConv],
      ideBrainDirs: [tmpIdeBrain],
      cliBrainDirs: [],
      skipDiskScan: false
    });
    const freshPeriods = summarizeByPeriod(freshLm.getAllCalls(), Date.parse('2026-11-23T12:00:00+08:00'));
    assert.equal(freshPeriods.today.callsCount, 1);
    assert.equal(freshPeriods.today.byModel['claude-opus-5-5'], undefined);
  } finally {
    fs.rmSync(tmpIdeBrain, { recursive: true, force: true });
    fs.rmSync(tmpConv, { recursive: true, force: true });
    await repairHarness.cleanup();
  }
});

test('面板分模型分布展示未定价标签与 >6 模型折叠汇总', async () => {
  const harness = createMockHostHarness({
    onRpc: (method) => {
      if (method === 'GetUserStatus') {
        return { userStatus: { userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } } };
      }
      return {};
    }
  });
  try {
    const { port, hostToken } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port, hostToken });
    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.ok(loaded);

    const usageSvc = harness.bus.getServiceProxy('usage');
    const todayIso = new Date().toISOString();
    const todayStr = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
    await usageSvc.recordCalls([
      { callId: 'm1', model: 'gemini-4-hydrogen', inputTokens: 700000, outputTokens: 0, date: todayStr, timestamp: Date.parse(todayIso) },
      { callId: 'm2', model: 'Gemini 4 Neon (High)', inputTokens: 600000, outputTokens: 0, date: todayStr, timestamp: Date.parse(todayIso) },
      { callId: 'm3', model: 'gemini-3.8-flash', inputTokens: 500000, outputTokens: 0, date: todayStr, timestamp: Date.parse(todayIso) },
      { callId: 'm4', model: 'gemini-4-carbon', inputTokens: 400000, outputTokens: 0, date: todayStr, timestamp: Date.parse(todayIso) },
      { callId: 'm5', model: 'claude-opus-5-5', inputTokens: 300000, outputTokens: 0, date: todayStr, timestamp: Date.parse(todayIso) },
      { callId: 'm6', model: 'gemini-flash-worker-agy', inputTokens: 200000, outputTokens: 0, date: todayStr, timestamp: Date.parse(todayIso) },
      { callId: 'm7', model: 'gemini-3.1-pro-preview', inputTokens: 100000, outputTokens: 0, date: todayStr, timestamp: Date.parse(todayIso) },
      { callId: 'm8', model: '', inputTokens: 50000, outputTokens: 0, date: todayStr, timestamp: Date.parse(todayIso) }
    ]);

    const shadowRoot = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
    const usagePanel = shadowRoot.querySelector('#agy-usage-panel');
    usagePanel.querySelector('button.ag-btn-primary').click();
    await new Promise((r) => setTimeout(r, 40));

    assert.match(usagePanel.textContent, /gemini-4-neon/);
    assert.match(usagePanel.textContent, /gemini-flash-worker-agy/);
    assert.match(usagePanel.textContent, /\$1\.80/);
    assert.match(usagePanel.textContent, /未定价/);
    assert.match(usagePanel.textContent, /其他模型 \(2\)/);

    await harness.unloadPlugin('agy-daddy.usage');
    harness.assertCleanDispose('agy-daddy.usage');
  } finally {
    await harness.cleanup();
  }
});

test('extractModelSelectionFromText、scanTranscriptBackfill 与 repairLedgerFromTranscripts 按步骤恢复空模型名', async () => {
  assert.equal(
    extractModelSelectionFromText('The user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment on this change'),
    'Gemini 3.8 Flash (High)'
  );
  assert.equal(
    extractModelSelectionFromText('The user changed setting `Model Selection` from Gemini 4 Carbon (High) to Orchestrator (Neon).\n'),
    'Orchestrator (Neon)'
  );
  assert.equal(extractModelSelectionFromText('The user changed setting `Model Selection` from Gemini 4 Neon to None.'), '');

  const tmpCliBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-model-recover-'));
  const harness = createMockHostHarness();
  try {
    const sessDir = path.join(tmpCliBrain, 'cli-recover-1', '.system_generated', 'logs');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'transcript.jsonl'), [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-12T10:00:00Z', content: '<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment</USER_SETTINGS_CHANGE>' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-12T10:00:05Z', input_tokens: 1000000, output_tokens: 1000 }),
      JSON.stringify({ step_index: 4, type: 'USER_INPUT', created_at: '2026-11-12T10:05:00Z', content: '<USER_SETTINGS_CHANGE>The user changed setting `Model Selection` from Gemini 3.8 Flash (High) to Orchestrator (Neon). No need to comment</USER_SETTINGS_CHANGE>' }),
      JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', created_at: '2026-11-12T10:05:05Z', input_tokens: 1000000, output_tokens: 1000 })
    ].join('\n'));

    // 1. 验证 scanTranscriptBackfill 直接从 USER_SETTINGS_CHANGE 继承模型
    const scanStore = new PluginDataStore('agy-daddy.usage.scan', { stateDir: harness.stateDir });
    const scanLm = new LedgerManager(scanStore);
    scanLm.load();
    const scanCursor = { transcripts: {} };
    const scanRes = scanTranscriptBackfill({
      brainEntries: [{ dir: tmpCliBrain, source: 'cli' }],
      ledger: scanLm,
      cursor: scanCursor
    });
    assert.equal(scanRes.importedCalls, 2);
    const scanned1 = scanLm.getAllCalls().find((c) => c.stepIndex === 1);
    const scanned5 = scanLm.getAllCalls().find((c) => c.stepIndex === 5);
    assert.equal(scanned1.model, 'Gemini 3.8 Flash (High)');
    assert.equal(scanned5.model, 'Orchestrator (Neon)');

    // 2. 验证 repairLedgerFromTranscripts 对已有 v1.1.0 账本中 model='' 的记录按 stepIndex 精准补全并重算费用
    const repStore = new PluginDataStore('agy-daddy.usage.rep', { stateDir: harness.stateDir });
    repStore.writeJson('token-pricing-ledger.json', {
      version: '1.1.0',
      calls: {
        'cli-recover-1#1': {
          callId: 'cli-recover-1#1',
          source: 'cli',
          cascadeId: 'cli-recover-1',
          stepIndex: 1,
          model: '',
          inputTokens: 1000000,
          cacheTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 1000000,
          date: '2026-11-12',
          dateIsProvisional: false,
          timestamp: Date.parse('2026-11-12T10:00:05Z'),
          costUSD: 0,
          isPriced: false
        },
        'cli-recover-1#5': {
          callId: 'cli-recover-1#5',
          source: 'cli',
          cascadeId: 'cli-recover-1',
          stepIndex: 5,
          model: '',
          inputTokens: 1000000,
          cacheTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 1000000,
          date: '2026-11-12',
          dateIsProvisional: false,
          timestamp: Date.parse('2026-11-12T10:05:05Z'),
          costUSD: 0,
          isPriced: false
        }
      }
    });
    const repLm = new LedgerManager(repStore);
    repLm.load();
    const repRes = repairLedgerFromTranscripts({
      ledger: repLm,
      storage: repStore,
      ideBrainDirs: [],
      cliBrainDirs: [tmpCliBrain],
      skipDiskScan: false
    });
    assert.equal(repRes.ok, true);
    assert.equal(repRes.modelsRecoveredCount, 2);
    assert.equal(repRes.version, LEDGER_VERSION);
    const fixed1 = repLm.getAllCalls().find((c) => c.stepIndex === 1);
    const fixed5 = repLm.getAllCalls().find((c) => c.stepIndex === 5);
    assert.equal(fixed1.model, 'Gemini 3.8 Flash (High)');
    assert.equal(fixed1.isPriced, true);
    assert.equal(fixed1.costUSD, 0.75);
    assert.equal(fixed5.model, 'Orchestrator (Neon)');
    assert.equal(fixed5.isPriced, true);
    assert.equal(fixed5.costUSD, 3);
  } finally {
    fs.rmSync(tmpCliBrain, { recursive: true, force: true });
    await harness.cleanup();
  }
});
