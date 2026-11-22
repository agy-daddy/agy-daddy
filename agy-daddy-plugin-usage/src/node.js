'use strict';

const {
  ULTRA_SUB_TIER_PRESETS,
  SUBSCRIPTION_ACQUISITION_PRESETS,
  normalizeUltraSubTier,
  summarizeApiCost,
  summarizeByPeriod,
  buildHeatmap52Weeks,
  LedgerManager
} = require('./pricing-ledger');
const { renderHeatmapSvg } = require('./heatmap-svg');

let disposers = [];

function normalizePlanConfig(raw = {}) {
  const tier = normalizeUltraSubTier(raw.ultraSubTier);
  return {
    tier: tier ? 'ultra' : (raw.tier || 'auto'),
    ultraSubTier: tier,
    country: raw.country || '',
    currency: raw.currency === 'CNY' ? 'CNY' : 'USD',
    actualPricePaid: raw.actualPricePaid !== undefined ? Number(raw.actualPricePaid) : null,
    preset: tier ? ULTRA_SUB_TIER_PRESETS[tier] : null
  };
}

async function activate(host) {
  const ledger = new LedgerManager(host.storage, 'token-pricing-ledger.json');
  ledger.load();

  let planData = normalizePlanConfig(host.storage.readJson('custom-plan.json', {}).data || {});

  function loadSettings() {
    const saved = host.storage.readJson('settings.json', {}).data || {};
    return {
      showCostInTopbar: saved.showCostInTopbar !== false,
      ultraSubTier: saved.ultraSubTier || 'auto',
      currency: saved.currency === 'CNY' ? 'CNY' : 'USD'
    };
  }

  function publishSummary() {
    const summary = summarizeApiCost(ledger.getAllCalls());
    const out = {
      ...summary,
      corrupted: ledger.corrupted,
      ultraSubTier: planData.ultraSubTier,
      updatedAt: Date.now()
    };
    host.state.set('state:usage.summary@1', out);
    return out;
  }

  // 订阅实时调用事件并幂等落盘
  const stopEventSub = host.events.on('telemetry:generator-calls@1', (payload) => {
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

  const usageService = {
    estimateCallsCost(calls = []) {
      return summarizeApiCost(calls);
    },
    recordCalls(calls = []) {
      const res = ledger.recordCalls(calls);
      if (res.changed) publishSummary();
      return res;
    },
    getSummary() {
      const calls = ledger.getAllCalls();
      return {
        ...summarizeApiCost(calls),
        periods: summarizeByPeriod(calls, Date.now(), planData),
        corrupted: ledger.corrupted,
        plan: planData,
        presets: SUBSCRIPTION_ACQUISITION_PRESETS
      };
    },
    getPeriodSummary(opts = {}) {
      return summarizeByPeriod(ledger.getAllCalls(), opts.nowMs || Date.now(), planData);
    },
    getHeatmap(opts = {}) {
      return buildHeatmap52Weeks(ledger.getAllCalls(), opts.nowMs || Date.now());
    },
    getHeatmapSvg(opts = {}) {
      const hm = buildHeatmap52Weeks(ledger.getAllCalls(), opts.nowMs || Date.now());
      return {
        ...hm,
        svg: renderHeatmapSvg(hm, opts)
      };
    },
    getMobileSnapshot() {
      const sum = summarizeApiCost(ledger.getAllCalls());
      return {
        totalTokens: sum.totalTokens,
        totalUsd: sum.totalUsd,
        callsCount: sum.callsCount,
        byModel: sum.byModel,
        ultraSubTier: planData.ultraSubTier,
        updatedAt: Date.now()
      };
    }
  };

  const subscriptionService = {
    getPlan() {
      return { ...planData };
    },
    setCustomPlan(next = {}) {
      planData = normalizePlanConfig({ ...planData, ...next });
      host.storage.writeJson('custom-plan.json', planData);
      publishSummary();
      return { ...planData };
    },
    getUltraSubTier() {
      const s = loadSettings();
      return normalizeUltraSubTier(planData.ultraSubTier || s.ultraSubTier);
    }
  };

  const stopUsageSvc = host.services.provide('usage', usageService, { realm: 'node', version: '1.0.0' });
  const stopSubSvc = host.services.provide('subscription', subscriptionService, { realm: 'node', version: '1.0.0' });
  const stopSumRoute = await host.bridge.registerRoute('/summary', async () => usageService.getSummary());
  const stopPeriodRoute = await host.bridge.registerRoute('/period-summary', async (body) => usageService.getPeriodSummary(body || {}));
  const stopHeatRoute = await host.bridge.registerRoute('/heatmap', async (body) => usageService.getHeatmap(body || {}));
  const stopHeatSvgRoute = await host.bridge.registerRoute('/heatmap-svg', async (body) => usageService.getHeatmapSvg(body || {}));
  const stopPlanRoute = await host.bridge.registerRoute('/plan', async () => subscriptionService.getPlan());
  const stopSetPlanRoute = await host.bridge.registerRoute('/set-plan', async (body) => subscriptionService.setCustomPlan(body || {}));

  publishSummary();

  disposers.push(
    stopEventSub,
    stopUsageSvc,
    stopSubSvc,
    stopSumRoute,
    stopPeriodRoute,
    stopHeatRoute,
    stopHeatSvgRoute,
    stopPlanRoute,
    stopSetPlanRoute
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
