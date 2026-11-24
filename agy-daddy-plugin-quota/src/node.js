'use strict';

const { buildModelQuotaSnapshot, DEFAULT_CAPSULE_COLOR_RULES } = require('./quota-engine');

let disposers = [];

function normalizeQuotaSettings(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const validModes = ['off', '5h', 'weekly', 'both'];
  let topbarCountdownMode = validModes.includes(src.topbarCountdownMode) ? src.topbarCountdownMode : null;
  if (!topbarCountdownMode) {
    topbarCountdownMode = src.showCountdownInTopbar === false ? 'off' : 'both';
  }
  const capsuleColorRules = Array.isArray(src.capsuleColorRules)
    ? src.capsuleColorRules.map((v) => String(v))
    : [...DEFAULT_CAPSULE_COLOR_RULES];
  return {
    pollIntervalMs: Number(src.pollIntervalMs) >= 5000 ? Number(src.pollIntervalMs) : 60000,
    topbarCountdownMode,
    quotaDisplayMode: src.quotaDisplayMode === 'used' ? 'used' : 'remaining',
    capsuleColorRules
  };
}

async function activate(host) {
  let latestSnapshot = null;

  function loadSettings() {
    const saved = (typeof host.settings?.get === 'function' ? host.settings.get() : null) || {};
    return normalizeQuotaSettings(saved);
  }

  let currentSettings = loadSettings();

  async function refreshQuota(options = {}) {
    let userStatusRes = null;
    let quotaSummaryRes = null;
    try {
      userStatusRes = await host.rpc.call('GetUserStatus', { metadata: { ideName: 'antigravity', extensionName: 'antigravity' } });
    } catch {}
    try {
      quotaSummaryRes = await host.rpc.call('RetrieveUserQuotaSummary', {});
    } catch {}

    // 软消费可选 subscription 服务补齐 Ultra 子档（缺失时安全降级）
    let ultraSubTier = null;
    try {
      const subRes = await host.services.call('subscription', 'getUltraSubTier', [], { optional: true });
      if (subRes?.ok && subRes.value) {
        ultraSubTier = subRes.value;
      }
    } catch {}

    const snapshot = buildModelQuotaSnapshot({
      userStatusRes,
      quotaSummaryRes,
      ultraSubTier,
      nowMs: options.nowMs || Date.now()
    });
    latestSnapshot = snapshot;
    host.storage.writeJson('latest-snapshot.json', snapshot);
    host.state.set('state:quota.snapshot@1', snapshot);
    return snapshot;
  }

  const serviceMethods = {
    async getSnapshot(opts = {}) {
      const cacheWindowMs = Math.min(5000, currentSettings.pollIntervalMs || 5000);
      if (!opts.force && latestSnapshot && Date.now() - latestSnapshot.updatedAt < cacheWindowMs) {
        return latestSnapshot;
      }
      return await refreshQuota(opts);
    },
    async refresh(opts = {}) {
      return await refreshQuota(opts);
    },
    async getMobileSnapshot(opts = {}) {
      const snap = latestSnapshot || await refreshQuota(opts);
      const serializeBucket = (b) => {
        if (!b) return null;
        const frac = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)
          ? b.remainingFraction
          : null;
        return {
          remainingFraction: frac,
          remainingPercent: frac !== null ? Math.round(frac * 100) : null,
          percentText: b.percentText || '--',
          usedPercentText: b.usedPercentText || '--',
          countdownText: b.countdownText || '',
          resetTimeText: b.resetTimeText || ''
        };
      };
      const serializeModelQuota = (primary, windows) => {
        const fiveHour = serializeBucket(windows?.fiveHour || (primary?.windowKey === '5h' ? primary : null));
        const weekly = serializeBucket(windows?.weekly || (primary?.windowKey === 'weekly' ? primary : null));
        if (!primary && !fiveHour && !weekly) return null;
        const base = serializeBucket(primary || fiveHour || weekly);
        return {
          ...base,
          fiveHour,
          weekly
        };
      };
      return {
        ultraSubTier: snap.ultraSubTier,
        quotaMultiplier: snap.quotaMultiplier,
        gemini: serializeModelQuota(snap.gemini, snap.geminiWindows),
        claude: serializeModelQuota(snap.claude, snap.claudeWindows),
        poolsCount: snap.pools.length,
        updatedAt: snap.updatedAt
      };
    }
  };

  const stopSettingsSub = typeof host.settings?.onChange === 'function'
    ? host.settings.onChange((nextValues) => {
        currentSettings = normalizeQuotaSettings(nextValues);
      })
    : () => {};

  const stopSvc = host.services.provide('quota', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopSnapRoute = await host.bridge.registerRoute('/snapshot', async (body) => await serviceMethods.getSnapshot(body || {}));
  const stopRefreshRoute = await host.bridge.registerRoute('/refresh', async (body) => await serviceMethods.refresh(body || {}));

  disposers.push(stopSettingsSub, stopSvc, stopSnapRoute, stopRefreshRoute);
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  normalizeQuotaSettings,
  activate,
  deactivate
};
