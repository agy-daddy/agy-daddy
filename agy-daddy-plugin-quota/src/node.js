'use strict';

const { buildModelQuotaSnapshot } = require('./quota-engine');

let disposers = [];

async function activate(host) {
  let latestSnapshot = null;

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
      if (!opts.force && latestSnapshot && Date.now() - latestSnapshot.updatedAt < 5000) {
        return latestSnapshot;
      }
      return await refreshQuota(opts);
    },
    async refresh(opts = {}) {
      return await refreshQuota(opts);
    },
    async getMobileSnapshot(opts = {}) {
      const snap = latestSnapshot || await refreshQuota(opts);
      return {
        ultraSubTier: snap.ultraSubTier,
        quotaMultiplier: snap.quotaMultiplier,
        gemini: snap.gemini ? { percentText: snap.gemini.percentText, countdownText: snap.gemini.countdownText } : null,
        claude: snap.claude ? { percentText: snap.claude.percentText, countdownText: snap.claude.countdownText } : null,
        poolsCount: snap.pools.length,
        updatedAt: snap.updatedAt
      };
    }
  };

  const stopSvc = host.services.provide('quota', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopSnapRoute = await host.bridge.registerRoute('/snapshot', async (body) => await serviceMethods.getSnapshot(body || {}));
  const stopRefreshRoute = await host.bridge.registerRoute('/refresh', async (body) => await serviceMethods.refresh(body || {}));

  disposers.push(stopSvc, stopSnapRoute, stopRefreshRoute);
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  activate,
  deactivate
};
