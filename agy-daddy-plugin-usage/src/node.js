'use strict';

const {
  LEDGER_VERSION,
  USD_TO_CNY_RATE,
  ULTRA_SUB_TIER_PRESETS,
  SUBSCRIPTION_ACQUISITION_PRESETS,
  SUBSCRIPTION_REGIONS_PRESET,
  CURRENCY_SYMBOLS,
  findRegionPreset,
  resolveSubscriptionCost,
  filterCallsBySource,
  normalizeUltraSubTier,
  detectSubscriptionFromUserStatus,
  summarizeApiCost,
  summarizeByPeriod,
  buildHeatmap52Weeks,
  LedgerManager
} = require('./pricing-ledger');
const { renderHeatmapSvg } = require('./heatmap-svg');
const {
  resolveEarliestCallDate,
  runHistoryBackfill,
  repairLedgerFromTranscripts
} = require('./history-backfill');

let disposers = [];

function normalizePeriodKey(val) {
  return ['today', 'month', 'year', 'allTime'].includes(val) ? val : 'allTime';
}

function normalizePlanConfig(raw = {}) {
  const manualSubTier = normalizeUltraSubTier(raw.ultraSubTier);
  const isManualPro = raw.ultraSubTier === 'pro' || (raw.mode === 'manual' && raw.tier === 'pro');
  const mode = raw.mode === 'manual'
    ? 'manual'
    : (raw.mode === 'auto' ? 'auto' : ((manualSubTier || isManualPro) ? 'manual' : 'auto'));

  const detectedSubTier = normalizeUltraSubTier(raw.detectedSubTier);
  const detectedTier = raw.detectedTier || null;
  const detectedLabel = raw.detectedLabel || null;

  let tier;
  let ultraSubTier;
  if (mode === 'auto') {
    tier = 'auto';
    ultraSubTier = detectedSubTier;
  } else if (isManualPro && !manualSubTier) {
    tier = 'pro';
    ultraSubTier = null;
  } else {
    tier = manualSubTier ? 'ultra' : (raw.tier || 'auto');
    ultraSubTier = manualSubTier;
  }

  const rawPaid = (raw.actualPricePaid !== undefined && raw.actualPricePaid !== null)
    ? raw.actualPricePaid
    : ((raw.actualPaidUsd !== undefined && raw.actualPaidUsd !== null) ? raw.actualPaidUsd : 0);
  const parsedPaid = Number.isFinite(Number(rawPaid)) ? Math.max(0, Number(rawPaid)) : 0;

  const regionPreset = findRegionPreset(raw.subscriptionRegion || raw.region || 'US') || findRegionPreset('US');
  const subscriptionRegion = regionPreset.id;
  const rawSubCur = String(raw.subscriptionCurrency || 'AUTO').trim().toUpperCase();
  const subscriptionCurrency = (rawSubCur === 'AUTO' || CURRENCY_SYMBOLS[rawSubCur]) ? rawSubCur : 'AUTO';
  const priceMode = (raw.priceMode === 'custom' || raw.subscriptionPriceMode === 'custom') ? 'custom' : 'preset';
  const billingCycle = ['monthly', 'yearly', 'free'].includes(raw.billingCycle) ? raw.billingCycle : 'monthly';

  const basePlan = {
    mode,
    tier,
    ultraSubTier,
    detectedTier,
    detectedSubTier,
    detectedLabel,
    country: raw.country || '',
    subscriptionRegion,
    subscriptionCurrency,
    priceMode,
    billingCycle,
    currency: raw.currency === 'CNY' ? 'CNY' : 'USD',
    actualPricePaid: parsedPaid,
    actualPaidUsd: parsedPaid,
    preset: ultraSubTier ? ULTRA_SUB_TIER_PRESETS[ultraSubTier] : null
  };
  const costInfo = resolveSubscriptionCost(basePlan);
  return {
    ...basePlan,
    costInfo
  };
}

function getCurrencyMeta(currency) {
  const isCny = currency === 'CNY';
  return {
    currency: isCny ? 'CNY' : 'USD',
    exchangeRate: isCny ? USD_TO_CNY_RATE : 1,
    currencySymbol: isCny ? '¥' : '$'
  };
}

async function activate(host) {
  let deactivated = false;
  const ledger = new LedgerManager(host.storage, 'token-pricing-ledger.json');
  ledger.load();

  function runRepairIfNeeded(opts = {}) {
    const hasExplicitDirs = Boolean(opts.ideBrainDirs || opts.cliBrainDirs);
    const skipDiskScan = opts.skipDiskScan !== undefined
      ? Boolean(opts.skipDiskScan)
      : (!hasExplicitDirs && (process.env.AGY_DADDY_TEST_MODE === '1' || Boolean(process.env.NODE_TEST_CONTEXT)));
    return repairLedgerFromTranscripts({
      ledger,
      storage: host.storage,
      ideBrainDirs: opts.ideBrainDirs || null,
      cliBrainDirs: opts.cliBrainDirs || null,
      skipDiskScan
    });
  }

  if (!ledger.corrupted && ledger.state.version !== LEDGER_VERSION && ledger.getAllCalls().length > 0) {
    try {
      runRepairIfNeeded();
    } catch {}
  }

  function loadSettings(src = null) {
    const saved = (src && typeof src === 'object' ? src : (typeof host.settings?.get === 'function' ? host.settings.get() : null)) || {};
    return {
      activePeriod: normalizePeriodKey(saved.activePeriod),
      includeIdeUsage: saved.includeIdeUsage !== false,
      includeCliUsage: saved.includeCliUsage !== false,
      ultraSubTier: saved.ultraSubTier || 'auto',
      subscriptionRegion: saved.subscriptionRegion || 'US',
      subscriptionCurrency: saved.subscriptionCurrency || 'AUTO',
      subscriptionPriceMode: saved.subscriptionPriceMode === 'custom' ? 'custom' : 'preset',
      actualPricePaid: Number.isFinite(Number(saved.actualPricePaid)) ? Math.max(0, Number(saved.actualPricePaid)) : 0,
      billingCycle: ['monthly', 'yearly', 'free'].includes(saved.billingCycle) ? saved.billingCycle : 'monthly',
      currency: saved.currency === 'CNY' ? 'CNY' : 'USD'
    };
  }

  let currentSettings = loadSettings();
  const savedPlan = host.storage.readJson('custom-plan.json', {}).data || {};
  let detectedSub = {
    detectedTier: savedPlan.detectedTier || null,
    detectedSubTier: normalizeUltraSubTier(savedPlan.detectedSubTier),
    detectedLabel: savedPlan.detectedLabel || null,
    checkedAt: 0
  };

  function buildPlanFromSettings(base = savedPlan) {
    const sel = currentSettings.ultraSubTier || 'auto';
    const common = {
      ...base,
      detectedTier: detectedSub.detectedTier,
      detectedSubTier: detectedSub.detectedSubTier,
      detectedLabel: detectedSub.detectedLabel,
      subscriptionRegion: currentSettings.subscriptionRegion,
      subscriptionCurrency: currentSettings.subscriptionCurrency,
      priceMode: currentSettings.subscriptionPriceMode,
      actualPricePaid: currentSettings.actualPricePaid,
      billingCycle: currentSettings.billingCycle,
      currency: currentSettings.currency || base.currency || 'USD'
    };
    if (sel === 'pro') {
      return normalizePlanConfig({ ...common, mode: 'manual', tier: 'pro', ultraSubTier: 'pro' });
    }
    if (sel === '5x' || sel === '20x') {
      return normalizePlanConfig({ ...common, mode: 'manual', tier: 'ultra', ultraSubTier: sel });
    }
    return normalizePlanConfig({ ...common, mode: 'auto', tier: 'auto', ultraSubTier: null });
  }

  let planData = buildPlanFromSettings(savedPlan);
  let backfillStatus = {
    running: false,
    totalConversations: 0,
    scannedConversations: 0,
    skippedConversations: 0,
    scannedTranscripts: 0,
    importedCalls: 0,
    earliestDate: resolveEarliestCallDate(ledger.getAllCalls()),
    updatedAt: null
  };

  function getScopedCalls() {
    return filterCallsBySource(ledger.getAllCalls(), currentSettings);
  }

  function decorateSummary(baseSummary) {
    const cm = getCurrencyMeta(planData.currency);
    return {
      ...baseSummary,
      currency: cm.currency,
      exchangeRate: cm.exchangeRate,
      currencySymbol: cm.currencySymbol,
      totalDisplayCost: Number(((Number(baseSummary.totalUsd) || 0) * cm.exchangeRate).toFixed(4))
    };
  }

  function publishSummary() {
    const calls = getScopedCalls();
    const summary = decorateSummary(summarizeApiCost(calls));
    const earliestDate = resolveEarliestCallDate(calls) || backfillStatus.earliestDate;
    const out = {
      ...summary,
      corrupted: ledger.corrupted,
      ultraSubTier: planData.ultraSubTier,
      activePeriod: currentSettings.activePeriod,
      scope: {
        includeIdeUsage: currentSettings.includeIdeUsage,
        includeCliUsage: currentSettings.includeCliUsage
      },
      plan: { ...planData },
      backfillStatus: { ...backfillStatus, earliestDate },
      updatedAt: Date.now()
    };
    host.state.set('state:usage.summary@1', out);
    return out;
  }

  let inflightDetect = null;
  async function refreshDetectedSubscription(force = false) {
    if (!force && detectedSub.checkedAt && Date.now() - detectedSub.checkedAt < 60000) {
      return detectedSub;
    }
    if (inflightDetect) return inflightDetect;
    inflightDetect = (async () => {
      try {
        if (typeof host.rpc?.call !== 'function') return detectedSub;
        const res = await host.rpc.call('GetUserStatus', {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
        });
        const detected = detectSubscriptionFromUserStatus(res);
        const changed = (
          detected.detectedTier !== detectedSub.detectedTier ||
          detected.detectedSubTier !== detectedSub.detectedSubTier ||
          detected.detectedLabel !== detectedSub.detectedLabel
        );
        detectedSub = {
          detectedTier: detected.detectedTier,
          detectedSubTier: detected.detectedSubTier,
          detectedLabel: detected.detectedLabel,
          checkedAt: Date.now()
        };
        if (changed && !deactivated) {
          planData = buildPlanFromSettings(planData);
          host.storage.writeJson('custom-plan.json', planData);
          publishSummary();
        }
      } catch {
        detectedSub = { ...detectedSub, checkedAt: Date.now() };
      } finally {
        inflightDetect = null;
      }
      return detectedSub;
    })();
    return inflightDetect;
  }

  let inflightBackfill = null;
  async function triggerBackfill(opts = {}) {
    if (deactivated) return { ok: false, aborted: true };
    if (inflightBackfill) return inflightBackfill;
    const explicitDir = opts.conversationsDir || process.env.AGY_DADDY_CONVERSATIONS_DIR || '';
    const conversationsDirs = Array.isArray(opts.conversationsDirs)
      ? opts.conversationsDirs
      : (explicitDir ? [explicitDir] : null);
    const hasExplicitDirs = Boolean(
      conversationsDirs ||
      opts.cliConversationsDirs ||
      opts.ideBrainDirs ||
      opts.cliBrainDirs
    );
    const skipDiskScan = opts.skipDiskScan !== undefined
      ? Boolean(opts.skipDiskScan)
      : (!hasExplicitDirs && (process.env.AGY_DADDY_TEST_MODE === '1' || Boolean(process.env.NODE_TEST_CONTEXT)));

    backfillStatus = { ...backfillStatus, running: true };
    inflightBackfill = (async () => {
      try {
        const res = await runHistoryBackfill({
          rpc: host.rpc,
          ledger,
          storage: host.storage,
          conversationsDirs,
          cliConversationsDirs: opts.cliConversationsDirs || null,
          ideBrainDirs: opts.ideBrainDirs || null,
          cliBrainDirs: opts.cliBrainDirs || null,
          skipDiskScan,
          concurrency: opts.concurrency || 4,
          shouldAbort: () => deactivated
        });
        backfillStatus = {
          running: false,
          totalConversations: res.totalConversations || 0,
          scannedConversations: res.scannedConversations || 0,
          skippedConversations: res.skippedConversations || 0,
          scannedTranscripts: res.scannedTranscripts || 0,
          importedCalls: res.importedCalls || 0,
          earliestDate: res.earliestDate || resolveEarliestCallDate(ledger.getAllCalls()),
          updatedAt: res.updatedAt || Date.now()
        };
        if (!deactivated && res.importedCalls > 0) {
          publishSummary();
        }
        return res;
      } catch (err) {
        backfillStatus = { ...backfillStatus, running: false, updatedAt: Date.now() };
        return { ok: false, error: err?.message || String(err) };
      } finally {
        inflightBackfill = null;
      }
    })();
    return inflightBackfill;
  }

  // 订阅实时调用事件并幂等落盘
  const stopEventSub = await host.events.on('telemetry:generator-calls@1', (payload) => {
    if (Array.isArray(payload?.calls) && payload.calls.length > 0) {
      ledger.recordCalls(payload.calls);
      publishSummary();
    }
  });

  // 晚启动回拉：软消费可选 context.getRecentCalls(0)
  try {
    const backfillRes = await host.services.call('context', 'getRecentCalls', [0], { optional: true });
    if (backfillRes?.ok && Array.isArray(backfillRes.value) && backfillRes.value.length > 0) {
      ledger.recordCalls(backfillRes.value);
    }
  } catch {}

  let syncingFromSetCustomPlan = false;

  const usageService = {
    estimateCallsCost(calls = []) {
      return decorateSummary(summarizeApiCost(calls));
    },
    recordCalls(calls = []) {
      const res = ledger.recordCalls(calls);
      if (res.changed) publishSummary();
      return res;
    },
    async backfillHistory(opts = {}) {
      return await triggerBackfill(opts);
    },
    repairLedger(opts = {}) {
      const res = runRepairIfNeeded(opts);
      if (res?.changed) publishSummary();
      return res;
    },
    async getSummary() {
      if (currentSettings.ultraSubTier === 'auto' && !detectedSub.checkedAt) {
        await refreshDetectedSubscription(false);
      }
      const calls = getScopedCalls();
      const base = decorateSummary(summarizeApiCost(calls));
      const earliestDate = resolveEarliestCallDate(calls) || backfillStatus.earliestDate;
      return {
        ...base,
        periods: summarizeByPeriod(calls, Date.now(), planData),
        corrupted: ledger.corrupted,
        activePeriod: currentSettings.activePeriod,
        scope: {
          includeIdeUsage: currentSettings.includeIdeUsage,
          includeCliUsage: currentSettings.includeCliUsage
        },
        plan: { ...planData },
        regions: SUBSCRIPTION_REGIONS_PRESET,
        backfillStatus: { ...backfillStatus, earliestDate },
        presets: SUBSCRIPTION_ACQUISITION_PRESETS
      };
    },
    getPeriodSummary(opts = {}) {
      const cm = getCurrencyMeta(planData.currency);
      return {
        ...summarizeByPeriod(getScopedCalls(), opts.nowMs || Date.now(), planData),
        currency: cm.currency,
        exchangeRate: cm.exchangeRate,
        currencySymbol: cm.currencySymbol
      };
    },
    getHeatmap(opts = {}) {
      return buildHeatmap52Weeks(getScopedCalls(), opts.nowMs || Date.now());
    },
    getHeatmapSvg(opts = {}) {
      const hm = buildHeatmap52Weeks(getScopedCalls(), opts.nowMs || Date.now());
      return {
        ...hm,
        svg: renderHeatmapSvg(hm, opts)
      };
    },
    getMobileSnapshot() {
      const calls = getScopedCalls();
      const sum = decorateSummary(summarizeApiCost(calls));
      return {
        totalTokens: sum.totalTokens,
        geminiTokens: sum.geminiTokens,
        otherTokens: sum.otherTokens,
        totalUsd: sum.totalUsd,
        currency: sum.currency,
        currencySymbol: sum.currencySymbol,
        totalDisplayCost: sum.totalDisplayCost,
        callsCount: sum.callsCount,
        byModel: sum.byModel,
        ultraSubTier: planData.ultraSubTier,
        activePeriod: currentSettings.activePeriod,
        scope: {
          includeIdeUsage: currentSettings.includeIdeUsage,
          includeCliUsage: currentSettings.includeCliUsage
        },
        plan: { ...planData },
        updatedAt: Date.now()
      };
    }
  };

  const subscriptionService = {
    async getPlan() {
      if (currentSettings.ultraSubTier === 'auto' && !detectedSub.checkedAt) {
        await refreshDetectedSubscription(false);
      }
      return { ...planData };
    },
    async setCustomPlan(next = {}) {
      const hasExplicitSub = 'ultraSubTier' in next;
      const nextMode = next.mode || (hasExplicitSub ? (next.ultraSubTier && next.ultraSubTier !== 'auto' ? 'manual' : 'auto') : planData.mode);
      planData = normalizePlanConfig({
        ...planData,
        ...next,
        mode: nextMode,
        detectedTier: detectedSub.detectedTier,
        detectedSubTier: detectedSub.detectedSubTier,
        detectedLabel: detectedSub.detectedLabel
      });
      host.storage.writeJson('custom-plan.json', planData);
      const settingsPatch = {};
      if (hasExplicitSub) {
        if (planData.mode === 'auto') settingsPatch.ultraSubTier = 'auto';
        else if (planData.tier === 'pro') settingsPatch.ultraSubTier = 'pro';
        else settingsPatch.ultraSubTier = planData.ultraSubTier || 'auto';
      }
      if ('currency' in next) settingsPatch.currency = planData.currency;
      if ('subscriptionRegion' in next || 'region' in next) settingsPatch.subscriptionRegion = planData.subscriptionRegion;
      if ('subscriptionCurrency' in next) settingsPatch.subscriptionCurrency = planData.subscriptionCurrency;
      if ('priceMode' in next || 'subscriptionPriceMode' in next) settingsPatch.subscriptionPriceMode = planData.priceMode;
      if ('actualPricePaid' in next || 'actualPaidUsd' in next) settingsPatch.actualPricePaid = planData.actualPricePaid;
      if ('billingCycle' in next) settingsPatch.billingCycle = planData.billingCycle;

      if (Object.keys(settingsPatch).length > 0 && typeof host.settings?.update === 'function') {
        syncingFromSetCustomPlan = true;
        try {
          await host.settings.update(settingsPatch);
        } catch {} finally {
          syncingFromSetCustomPlan = false;
        }
      }
      currentSettings = loadSettings({ ...currentSettings, ...settingsPatch });
      publishSummary();
      return { ...planData };
    },
    getUltraSubTier() {
      const s = loadSettings();
      if (s.ultraSubTier === 'pro') return null;
      const fromSettings = normalizeUltraSubTier(s.ultraSubTier);
      if (fromSettings) return fromSettings;
      return normalizeUltraSubTier(planData.detectedSubTier || planData.ultraSubTier);
    }
  };

  const stopSettingsSub = typeof host.settings?.onChange === 'function'
    ? host.settings.onChange((nextValues, changedKeys) => {
        currentSettings = loadSettings(nextValues);
        if (syncingFromSetCustomPlan) return;
        const keys = Array.isArray(changedKeys) ? changedKeys : [];
        const planKeys = [
          'ultraSubTier',
          'subscriptionRegion',
          'subscriptionCurrency',
          'subscriptionPriceMode',
          'actualPricePaid',
          'billingCycle',
          'currency'
        ];
        if (keys.length === 0 || keys.some((k) => planKeys.includes(k))) {
          planData = buildPlanFromSettings(planData);
          host.storage.writeJson('custom-plan.json', planData);
          if (currentSettings.ultraSubTier === 'auto') {
            void refreshDetectedSubscription(false);
          }
        }
        publishSummary();
      })
    : () => {};

  const stopUsageSvc = host.services.provide('usage', usageService, { realm: 'node', version: '1.0.0' });
  const stopSubSvc = host.services.provide('subscription', subscriptionService, { realm: 'node', version: '1.0.0' });
  const stopSumRoute = await host.bridge.registerRoute('/summary', async () => await usageService.getSummary());
  const stopPeriodRoute = await host.bridge.registerRoute('/period-summary', async (body) => usageService.getPeriodSummary(body || {}));
  const stopHeatRoute = await host.bridge.registerRoute('/heatmap', async (body) => usageService.getHeatmap(body || {}));
  const stopHeatSvgRoute = await host.bridge.registerRoute('/heatmap-svg', async (body) => usageService.getHeatmapSvg(body || {}));
  const stopPlanRoute = await host.bridge.registerRoute('/plan', async () => await subscriptionService.getPlan());
  const stopBackfillRoute = await host.bridge.registerRoute('/backfill', async (body) => await usageService.backfillHistory(body || {}));
  const stopRepairRoute = await host.bridge.registerRoute('/repair', async (body) => usageService.repairLedger(body || {}));

  publishSummary();
  void refreshDetectedSubscription(false);
  void triggerBackfill().catch(() => {});

  disposers.push(
    () => { deactivated = true; },
    stopEventSub,
    stopSettingsSub,
    stopUsageSvc,
    stopSubSvc,
    stopSumRoute,
    stopPeriodRoute,
    stopHeatRoute,
    stopHeatSvgRoute,
    stopPlanRoute,
    stopBackfillRoute,
    stopRepairRoute
  );
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  normalizePlanConfig,
  activate,
  deactivate
};
