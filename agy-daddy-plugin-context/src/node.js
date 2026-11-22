'use strict';

const {
  summarizeMetadata,
  analyzeTrajectorySteps,
  parseGeneratorCall,
  getContextLimitForModel
} = require('./context-analyzer');
const { auditAttachments } = require('./attachment-audit');

const MAX_RECENT_CALLS = 500;

let disposers = [];

function pickTargetCascadeId(requestedId, summariesObj = {}) {
  if (requestedId) return requestedId;
  const entries = Object.entries(summariesObj || {});
  if (!entries.length) return null;
  entries.sort((a, b) => {
    const tA = Date.parse(a[1]?.lastModifiedTime || 0) || 0;
    const tB = Date.parse(b[1]?.lastModifiedTime || 0) || 0;
    return tB - tA;
  });
  return entries[0][0];
}

function buildAlerts(snapshot, settings = {}) {
  const alerts = [];
  const used = Number(snapshot?.used || 0);
  const warnAt = Number(settings.warnThresholdTokens) > 0 ? Number(settings.warnThresholdTokens) : 240000;
  const cliffAt = Number(settings.cliffThresholdTokens) > 0 ? Number(settings.cliffThresholdTokens) : 328000;
  if (snapshot?.cacheDropDetected) {
    alerts.push({ level: 'danger', code: 'cache_drop', message: '检测到上下文缓存失效' });
  }
  if (used >= cliffAt) {
    alerts.push({ level: 'danger', code: 'cache_cliff', message: `高风险断崖区 (>=${Math.round(cliffAt / 1000)}K)` });
  } else if (used >= warnAt) {
    alerts.push({ level: 'warn', code: 'cache_warn', message: `建议压缩上下文 (>${Math.round(warnAt / 1000)}K 缓存衰减风险)` });
  }
  if (snapshot?.compressionDetected) {
    alerts.push({ level: 'info', code: 'compressed', message: '检测到自动上下文压缩' });
  }
  return alerts;
}

async function activate(host) {
  const availableModels = new Map();
  const seenCallIds = new Set();
  const recentCalls = [];
  const contextCacheBySession = new Map();
  let latestSnapshot = null;

  function loadSettings() {
    const saved = host.storage.readJson('settings.json', {}).data || {};
    return {
      showPulseCapsule: saved.showPulseCapsule !== false,
      showSpeedInTopbar: saved.showSpeedInTopbar !== false,
      pollIntervalMs: Number(saved.pollIntervalMs) >= 1000 ? Number(saved.pollIntervalMs) : 3000,
      warnThresholdTokens: Number(saved.warnThresholdTokens) >= 50000 ? Number(saved.warnThresholdTokens) : 240000,
      cliffThresholdTokens: Number(saved.cliffThresholdTokens) >= 100000 ? Number(saved.cliffThresholdTokens) : 328000
    };
  }

  function recordNewGeneratorCalls(rows, cascadeId) {
    const newCalls = [];
    for (let i = 0; i < rows.length; i++) {
      const parsed = parseGeneratorCall(rows[i], cascadeId, 'desktop', i);
      if (!parsed) continue;
      if (seenCallIds.has(parsed.callId)) continue;
      seenCallIds.add(parsed.callId);
      recentCalls.push(parsed);
      newCalls.push(parsed);
      while (recentCalls.length > MAX_RECENT_CALLS) {
        const dropped = recentCalls.shift();
        if (dropped?.callId) seenCallIds.delete(dropped.callId);
      }
    }
    if (newCalls.length > 0) {
      host.events.emit('telemetry:generator-calls@1', { cascadeId, calls: newCalls });
    }
    return newCalls;
  }

  async function scanCascade(options = {}) {
    const settings = loadSettings();
    let cascadeId = options.cascadeId || null;

    if (availableModels.size === 0) {
      try {
        const availResp = await host.rpc.call('GetAvailableModels', { forceRefresh: false });
        const modelsObj = availResp?.response?.models || availResp?.models || {};
        const entries = Array.isArray(modelsObj)
          ? modelsObj.map((m) => [m.model || m.modelId || '', m])
          : Object.entries(modelsObj);
        for (const [k, v] of entries) {
          if (!v || typeof v !== 'object') continue;
          const idKey = String(v.model || v.modelId || k || '').trim().toLowerCase();
          if (idKey && Number(v.maxTokens) > 0) {
            availableModels.set(idKey, { maxTokens: Number(v.maxTokens), displayName: v.displayName || v.label || k });
          }
        }
      } catch {}
    }

    let summaries = {};
    if (!cascadeId) {
      try {
        const allResp = await host.rpc.call('GetAllCascadeTrajectories', {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
        });
        summaries = allResp?.trajectorySummaries || {};
        cascadeId = pickTargetCascadeId(null, summaries);
      } catch {}
    }

    if (!cascadeId) {
      const emptySnap = {
        ok: true,
        hasSession: false,
        cascadeId: null,
        status: 'idle',
        used: null,
        budget: null,
        percent: null,
        remainPercent: null,
        model: null,
        speed: null,
        groups: null,
        attachments: { items: [], totals: { count: 0, chars: 0, bytes: 0, low: 0, high: 0 } },
        alerts: [],
        referenceCost: null,
        updatedAt: Date.now()
      };
      latestSnapshot = emptySnap;
      host.state.set('state:context.snapshot@1', emptySnap);
      return emptySnap;
    }

    let gmRows = [];
    try {
      const gmResp = await host.rpc.call('GetCascadeTrajectoryGeneratorMetadata', {
        cascadeId,
        generatorMetadataOffset: 0,
        includeMessages: false
      });
      if (Array.isArray(gmResp?.generatorMetadata)) {
        gmRows = gmResp.generatorMetadata;
      }
    } catch {}

    const prevCtx = contextCacheBySession.get(cascadeId) || null;
    let metaSummary = null;
    for (let i = gmRows.length - 1; i >= 0; i--) {
      const s = summarizeMetadata(gmRows[i], {
        previousValidContext: prevCtx,
        availableModels,
        currentModel: summaries[cascadeId]?.lastModel
      });
      if (s) {
        metaSummary = s;
        break;
      }
    }

    const newCalls = recordNewGeneratorCalls(gmRows, cascadeId);

    let steps = [];
    try {
      const trajResp = await host.rpc.call('GetCascadeTrajectory', { cascadeId });
      if (Array.isArray(trajResp?.steps)) {
        steps = trajResp.steps;
      } else if (Array.isArray(trajResp?.trajectory?.steps)) {
        steps = trajResp.trajectory.steps;
      }
    } catch {}

    const stepAnalysis = analyzeTrajectorySteps(steps, {
      preferredModelId: metaSummary?.modelRaw || '',
      preferredModelLabel: metaSummary?.model || '',
      runtimeBudget: metaSummary?.budget || 0,
      warnThresholdTokens: settings.warnThresholdTokens,
      cliffThresholdTokens: settings.cliffThresholdTokens
    });

    const attachmentAudit = auditAttachments(stepAnalysis.media);
    const budget = metaSummary?.budget || stepAnalysis.budget || getContextLimitForModel(metaSummary?.modelRaw, metaSummary?.model, { availableModels });
    const used = metaSummary?.used ?? stepAnalysis.preciseUsed ?? (stepAnalysis.steps > 0 ? stepAnalysis.total.high : null);
    const percent = used !== null && budget > 0 ? Number(((used / budget) * 100).toFixed(1)) : null;
    const remainPercent = percent !== null ? Number(Math.max(0, 100 - percent).toFixed(1)) : null;

    if (metaSummary && metaSummary.actual !== null) {
      contextCacheBySession.set(cascadeId, metaSummary);
    }

    // 软消费可选 usage 服务获取本会话参考费用（usage 未安装时安全返回 null）
    let referenceCost = null;
    const callsForSession = recentCalls.filter((c) => c.cascadeId === cascadeId);
    const costInput = callsForSession.length ? callsForSession : newCalls;
    if (costInput.length > 0) {
      try {
        const usageRes = await host.services.call('usage', 'estimateCallsCost', [costInput], { optional: true });
        if (usageRes?.ok && usageRes.value) {
          referenceCost = usageRes.value;
        }
      } catch {}
    }

    const snapshot = {
      ok: true,
      hasSession: true,
      cascadeId,
      title: summaries[cascadeId]?.annotations?.title || summaries[cascadeId]?.summary || '',
      model: metaSummary?.model || stepAnalysis.modelId || 'Unknown',
      modelRaw: metaSummary?.modelRaw || stepAnalysis.modelId || '',
      status: metaSummary?.status || (used !== null ? 'reported' : 'idle'),
      error: metaSummary?.error || '',
      errorClassification: metaSummary?.errorClassification || { kind: 'none' },
      used,
      actual: metaSummary?.actual ?? stepAnalysis.preciseUsed,
      estimate: metaSummary?.estimate ?? null,
      budget,
      percent,
      remainPercent,
      inputTokens: metaSummary?.input ?? stepAnalysis.inputTokens,
      cachedTokens: metaSummary?.cached ?? stepAnalysis.cacheReadTokens,
      uncachedInput: metaSummary?.uncachedInput ?? null,
      cacheHitRate: metaSummary?.cacheHitRate ?? stepAnalysis.cacheHitRate,
      outputTokens: metaSummary?.output ?? stepAnalysis.outputTokens,
      speed: metaSummary?.speed || null,
      groups: stepAnalysis.groups,
      stepsCount: stepAnalysis.steps,
      userMessages: stepAnalysis.userMessages,
      assistantMessages: stepAnalysis.assistantMessages,
      cacheDropDetected: stepAnalysis.cacheDropDetected,
      cacheCliffRisk: stepAnalysis.cacheCliffRisk,
      compressionDetected: stepAnalysis.compressionDetected,
      compressionDrop: stepAnalysis.compressionDrop,
      attachments: attachmentAudit,
      referenceCost,
      alerts: [],
      updatedAt: Date.now()
    };
    snapshot.alerts = buildAlerts(snapshot, settings);

    latestSnapshot = snapshot;
    host.storage.writeJson('latest-snapshot.json', snapshot);
    host.state.set('state:context.snapshot@1', snapshot);
    return snapshot;
  }

  const serviceMethods = {
    async getSnapshot(opts = {}) {
      if (!opts.force && latestSnapshot && (!opts.cascadeId || opts.cascadeId === latestSnapshot.cascadeId) && Date.now() - latestSnapshot.updatedAt < 1000) {
        return latestSnapshot;
      }
      return await scanCascade(opts);
    },
    async rescan(opts = {}) {
      return await scanCascade({ ...opts, force: true });
    },
    getRecentCalls(sinceMs = 0) {
      const cutoff = Number(sinceMs) || 0;
      return recentCalls.filter((c) => (c.timestamp || 0) >= cutoff);
    },
    auditAttachments(mediaList = []) {
      return auditAttachments(mediaList);
    },
    async getMobileSnapshot(opts = {}) {
      const snap = latestSnapshot || await scanCascade(opts);
      return {
        hasSession: snap.hasSession,
        cascadeId: snap.cascadeId,
        title: snap.title || '',
        model: snap.model,
        status: snap.status,
        used: snap.used,
        budget: snap.budget,
        percent: snap.percent,
        remainPercent: snap.remainPercent,
        inputTokens: snap.inputTokens,
        cachedTokens: snap.cachedTokens,
        cacheHitRate: snap.cacheHitRate,
        outputTokens: snap.outputTokens,
        tokPerSec: snap.speed?.tps ?? null,
        alerts: snap.alerts || [],
        attachmentSummary: snap.attachments?.totals || { count: 0, high: 0 },
        referenceCost: snap.referenceCost || null,
        updatedAt: snap.updatedAt
      };
    },
    ingestRendererSnapshot(payload = {}) {
      if (!payload || typeof payload !== 'object') return { ok: false };
      latestSnapshot = { ...(latestSnapshot || {}), ...payload, updatedAt: Date.now() };
      host.state.set('state:context.snapshot@1', latestSnapshot);
      return { ok: true, snapshot: latestSnapshot };
    }
  };

  const stopSvc = host.services.provide('context', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopSnapRoute = await host.bridge.registerRoute('/snapshot', async (body) => serviceMethods.getSnapshot(body || {}));
  const stopRescanRoute = await host.bridge.registerRoute('/rescan', async (body) => serviceMethods.rescan(body || {}));
  const stopAuditRoute = await host.bridge.registerRoute('/audit-attachments', async (body) => serviceMethods.auditAttachments(body?.media || []));
  const stopIngestRoute = await host.bridge.registerRoute('/ingest-renderer-snapshot', async (body) => serviceMethods.ingestRendererSnapshot(body || {}));
  const stopSettingsRoute = await host.bridge.registerRoute('/settings', async (body) => {
    if (body?.action === 'save' && body.values) {
      const cur = host.storage.readJson('settings.json', {}).data || {};
      const next = { ...cur, ...body.values };
      host.storage.writeJson('settings.json', next);
      return { ok: true, values: next };
    }
    return { ok: true, values: loadSettings() };
  });

  disposers.push(stopSvc, stopSnapRoute, stopRescanRoute, stopAuditRoute, stopIngestRoute, stopSettingsRoute);
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  pickTargetCascadeId,
  buildAlerts,
  activate,
  deactivate
};
