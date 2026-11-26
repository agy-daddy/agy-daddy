'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseTimestampMs,
  summarizeMetadata,
  analyzeTrajectorySteps,
  extractStepTimestampsFromTrajectory,
  parseGeneratorCall,
  summarizeSessionGeneratorCalls,
  resolveThresholdTokens,
  formatThresholdLabel,
  getContextLimitForModel
} = require('./context-analyzer');
const { auditAttachments } = require('./attachment-audit');

const MAX_RECENT_CALLS = 500;
const transcriptStepTsCache = new Map();

function getDefaultBrainDirsForContext() {
  const home = os.homedir();
  return [
    path.join(home, '.gemini', 'antigravity', 'brain'),
    path.join(home, '.gemini', 'antigravity-ide', 'brain'),
    path.join(home, '.gemini', 'antigravity-cli', 'brain')
  ];
}

function readTranscriptStepTimestampsCached(cascadeId, brainDirs = null) {
  if (!cascadeId) return null;
  const skipDisk = !Array.isArray(brainDirs) && (process.env.AGY_DADDY_TEST_MODE === '1' || Boolean(process.env.NODE_TEST_CONTEXT));
  if (skipDisk) return null;
  const dirs = Array.isArray(brainDirs) ? brainDirs : getDefaultBrainDirsForContext();
  for (const bDir of dirs) {
    const candidates = [
      path.join(bDir, String(cascadeId), '.system_generated', 'logs', 'transcript.jsonl'),
      path.join(bDir, String(cascadeId), 'transcript.jsonl')
    ];
    for (const fp of candidates) {
      let st;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      const cached = transcriptStepTsCache.get(fp);
      if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
        return cached.map;
      }
      let content = '';
      try {
        content = fs.readFileSync(fp, 'utf8');
      } catch {
        continue;
      }
      const map = new Map();
      for (const ln of content.split(/\r?\n/)) {
        if (!ln || !ln.trim()) continue;
        let ev;
        try {
          ev = JSON.parse(ln);
        } catch {
          continue;
        }
        if (!ev || typeof ev !== 'object') continue;
        const ts = parseTimestampMs(ev.created_at || ev.createdAt || ev.timestamp || ev.chatModel?.chatStartMetadata?.createdAt || ev.chatModel?.createdAt);
        if (ts <= 0) continue;
        const rawStep = ev.step_index ?? ev.stepIndex;
        const parsedStep = rawStep !== undefined && rawStep !== null && rawStep !== '' ? Number(rawStep) : NaN;
        if (Number.isInteger(parsedStep) && parsedStep >= 0 && !map.has(parsedStep)) {
          map.set(parsedStep, ts);
        }
      }
      transcriptStepTsCache.set(fp, { size: st.size, mtimeMs: st.mtimeMs, map });
      return map;
    }
  }
  return null;
}

let disposers = [];
let activeHost = null;

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
  const budget = Number(snapshot?.budget || 0);
  const warnRaw = settings.warnThreshold ?? settings.warnThresholdTokens ?? '240K';
  const cliffRaw = settings.cliffThreshold ?? settings.cliffThresholdTokens ?? '328K';
  const warnInfo = formatThresholdLabel(warnRaw, budget, 240000);
  const cliffInfo = formatThresholdLabel(cliffRaw, budget, 328000);
  if (snapshot?.cacheDropDetected) {
    alerts.push({ level: 'danger', code: 'cache_drop', message: '检测到上下文缓存失效' });
  }
  if (used >= cliffInfo.tokens) {
    alerts.push({ level: 'danger', code: 'cache_cliff', message: `高风险断崖区 (>=${cliffInfo.shortLabel})` });
  } else if (used >= warnInfo.tokens) {
    alerts.push({ level: 'warn', code: 'cache_warn', message: `建议压缩上下文 (>${warnInfo.shortLabel} 缓存衰减风险)` });
  }
  if (snapshot?.compressionDetected) {
    alerts.push({ level: 'info', code: 'compressed', message: '检测到自动上下文压缩' });
  }
  return alerts;
}

async function activate(host) {
  activeHost = host;
  const availableModels = new Map();
  const seenCallIds = new Set();
  const recentCalls = [];
  const contextCacheBySession = new Map();
  let latestSnapshot = null;

  function loadSettings() {
    const saved = (typeof host.settings?.get === 'function' ? host.settings.get() : null) || {};
    let displayLocation = 'composer';
    if (saved.displayLocation === 'topbar' || saved.displayLocation === 'composer') {
      displayLocation = saved.displayLocation;
    } else if (saved.showPulseCapsule === false) {
      displayLocation = 'topbar';
    }
    const showSpeed = saved.showSpeed !== undefined
      ? saved.showSpeed !== false
      : saved.showSpeedInTopbar !== false;
    const VALID_COMPACT_POLICIES = new Set(['remind', 'idle_prompt', 'cliff_auto', 'idle_and_cliff']);
    const compactPolicy = VALID_COMPACT_POLICIES.has(saved.compactPolicy)
      ? saved.compactPolicy
      : 'remind';
    const warnThreshold = String(saved.warnThreshold ?? (saved.warnThresholdTokens ? String(saved.warnThresholdTokens) : '240K')).trim() || '240K';
    const cliffThreshold = String(saved.cliffThreshold ?? (saved.cliffThresholdTokens ? String(saved.cliffThresholdTokens) : '328K')).trim() || '328K';
    return {
      displayLocation,
      showSpeed,
      pollIntervalMs: Number(saved.pollIntervalMs) >= 1000 ? Number(saved.pollIntervalMs) : 3000,
      warnThreshold,
      cliffThreshold,
      compactPolicy,
      autoCompactOnCacheDrop: saved.autoCompactOnCacheDrop === true
    };
  }

  function buildEmptySnapshot(settings = loadSettings()) {
    return {
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
      sessionUsage: summarizeSessionGeneratorCalls([]),
      groups: null,
      attachments: { items: [], totals: { count: 0, chars: 0, bytes: 0, low: 0, high: 0 } },
      alerts: [],
      referenceCost: null,
      displayLocation: settings.displayLocation,
      showSpeed: settings.showSpeed,
      compactPolicy: settings.compactPolicy,
      warnThreshold: settings.warnThreshold,
      cliffThreshold: settings.cliffThreshold,
      updatedAt: Date.now()
    };
  }

  function syncSnapshotFromSettings() {
    const settings = loadSettings();
    if (!latestSnapshot || !latestSnapshot.hasSession) {
      latestSnapshot = {
        ...(latestSnapshot || buildEmptySnapshot(settings)),
        displayLocation: settings.displayLocation,
        showSpeed: settings.showSpeed,
        compactPolicy: settings.compactPolicy,
        warnThreshold: settings.warnThreshold,
        cliffThreshold: settings.cliffThreshold,
        updatedAt: Date.now()
      };
      host.state?.set?.('state:context.snapshot@1', latestSnapshot);
      return;
    }
    const used = Number(latestSnapshot.used || 0);
    const warnTokens = resolveThresholdTokens(settings.warnThreshold, latestSnapshot.budget, 240000);
    const cliffTokens = resolveThresholdTokens(settings.cliffThreshold, latestSnapshot.budget, 328000);
    const cacheCliffRisk = used >= cliffTokens
      ? 'critical'
      : (used >= warnTokens ? 'warn' : 'none');
    latestSnapshot = {
      ...latestSnapshot,
      displayLocation: settings.displayLocation,
      showSpeed: settings.showSpeed,
      compactPolicy: settings.compactPolicy,
      warnThreshold: settings.warnThreshold,
      cliffThreshold: settings.cliffThreshold,
      warnThresholdTokens: warnTokens,
      cliffThresholdTokens: cliffTokens,
      cacheCliffRisk,
      alerts: buildAlerts({ ...latestSnapshot, cacheCliffRisk }, settings),
      updatedAt: Date.now()
    };
    host.storage.writeJson('latest-snapshot.json', latestSnapshot);
    host.state?.set?.('state:context.snapshot@1', latestSnapshot);
  }

  function recordNewGeneratorCalls(rows, cascadeId, parseOptions = {}) {
    const newCalls = [];
    for (let i = 0; i < rows.length; i++) {
      const parsed = parseGeneratorCall(rows[i], cascadeId, 'desktop', i, parseOptions);
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
    if (!cascadeId && !options.isNewChat) {
      try {
        const allResp = await host.rpc.call('GetAllCascadeTrajectories', {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
        });
        summaries = allResp?.trajectorySummaries || {};
        cascadeId = pickTargetCascadeId(null, summaries);
      } catch {}
    }

    if (!cascadeId) {
      const emptySnap = buildEmptySnapshot(settings);
      latestSnapshot = emptySnap;
      host.storage.writeJson('latest-snapshot.json', emptySnap);
      host.state?.set?.('state:context.snapshot@1', emptySnap);
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

    let steps = [];
    try {
      const trajResp = await host.rpc.call('GetCascadeTrajectory', { cascadeId });
      if (Array.isArray(trajResp?.steps)) {
        steps = trajResp.steps;
      } else if (Array.isArray(trajResp?.trajectory?.steps)) {
        steps = trajResp.trajectory.steps;
      }
    } catch {}

    const stepTimestamps = extractStepTimestampsFromTrajectory(steps);
    const transcriptTsMap = readTranscriptStepTimestampsCached(cascadeId);
    if (transcriptTsMap instanceof Map) {
      for (const [s, ts] of transcriptTsMap.entries()) {
        if (!stepTimestamps.has(s)) stepTimestamps.set(s, ts);
      }
    }
    const fallbackTimestampMs =
      parseTimestampMs(summaries[cascadeId]?.createdTime) ||
      parseTimestampMs(summaries[cascadeId]?.lastModifiedTime) ||
      0;

    const newCalls = recordNewGeneratorCalls(gmRows, cascadeId, {
      stepTimestamps,
      fallbackTimestampMs
    });
    const sessionUsage = summarizeSessionGeneratorCalls(gmRows, { cascadeId });

    const stepAnalysis = analyzeTrajectorySteps(steps, {
      preferredModelId: metaSummary?.modelRaw || '',
      preferredModelLabel: metaSummary?.model || '',
      runtimeBudget: metaSummary?.budget || 0,
      warnThreshold: settings.warnThreshold,
      cliffThreshold: settings.cliffThreshold
    });

    const attachmentAudit = auditAttachments(stepAnalysis.media);
    const budget = metaSummary?.budget || stepAnalysis.budget || getContextLimitForModel(metaSummary?.modelRaw, metaSummary?.model, { availableModels });
    const used = metaSummary?.used ?? stepAnalysis.preciseUsed ?? (stepAnalysis.steps > 0 ? stepAnalysis.total.high : null);
    const percent = used !== null && budget > 0 ? Number(((used / budget) * 100).toFixed(1)) : null;
    const remainPercent = percent !== null ? Number(Math.max(0, 100 - percent).toFixed(1)) : null;
    const warnThresholdTokens = resolveThresholdTokens(settings.warnThreshold, budget, 240000);
    const cliffThresholdTokens = resolveThresholdTokens(settings.cliffThreshold, budget, 328000);
    const effectiveUsed = used ?? stepAnalysis.total.high;
    const cacheCliffRisk = effectiveUsed >= cliffThresholdTokens
      ? 'critical'
      : (effectiveUsed >= warnThresholdTokens ? 'warn' : 'none');

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
      sessionUsage,
      groups: stepAnalysis.groups,
      stepsCount: stepAnalysis.steps,
      userMessages: stepAnalysis.userMessages,
      assistantMessages: stepAnalysis.assistantMessages,
      cacheDropDetected: stepAnalysis.cacheDropDetected,
      cacheCliffRisk,
      warnThreshold: settings.warnThreshold,
      cliffThreshold: settings.cliffThreshold,
      warnThresholdTokens,
      cliffThresholdTokens,
      compressionDetected: stepAnalysis.compressionDetected,
      compressionDrop: stepAnalysis.compressionDrop,
      attachments: attachmentAudit,
      referenceCost,
      alerts: [],
      displayLocation: settings.displayLocation,
      showSpeed: settings.showSpeed,
      compactPolicy: settings.compactPolicy,
      updatedAt: Date.now()
    };
    snapshot.alerts = buildAlerts(snapshot, settings);

    latestSnapshot = snapshot;
    host.storage.writeJson('latest-snapshot.json', snapshot);
    host.state.set('state:context.snapshot@1', snapshot);
    return snapshot;
  }

  const serviceMethods = {
    getSettings() {
      return loadSettings();
    },
    async getSnapshot(opts = {}) {
      if (opts.isNewChat && !opts.cascadeId) {
        return await scanCascade(opts);
      }
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
      const settings = loadSettings();
      const snap = latestSnapshot || await scanCascade(opts);
      const groups = snap.groups && typeof snap.groups === 'object'
        ? {
            user: Number(snap.groups.user?.high || 0),
            assistant: Number(snap.groups.assistant?.high || 0),
            thinking: Number(snap.groups.thinking?.high || 0),
            tools: Number(snap.groups.tools?.high || 0),
            summaries: Number(snap.groups.summaries?.high || 0)
          }
        : null;
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
        speed: snap.speed || null,
        cacheCliffRisk: snap.cacheCliffRisk || 'none',
        cacheDropDetected: Boolean(snap.cacheDropDetected),
        warnThreshold: snap.warnThreshold || settings.warnThreshold,
        cliffThreshold: snap.cliffThreshold || settings.cliffThreshold,
        warnThresholdTokens: snap.warnThresholdTokens ?? resolveThresholdTokens(settings.warnThreshold, snap.budget, 240000),
        cliffThresholdTokens: snap.cliffThresholdTokens ?? resolveThresholdTokens(settings.cliffThreshold, snap.budget, 328000),
        groups,
        sessionUsage: snap.sessionUsage || summarizeSessionGeneratorCalls([]),
        alerts: snap.alerts || [],
        attachmentSummary: snap.attachments?.totals || { count: 0, high: 0 },
        referenceCost: snap.referenceCost || null,
        updatedAt: snap.updatedAt
      };
    },
    ingestRendererSnapshot(payload = {}) {
      if (!payload || typeof payload !== 'object') return { ok: false };
      const settings = loadSettings();
      latestSnapshot = {
        ...(latestSnapshot || {}),
        ...payload,
        displayLocation: payload.displayLocation ?? settings.displayLocation,
        showSpeed: payload.showSpeed ?? settings.showSpeed,
        compactPolicy: payload.compactPolicy ?? settings.compactPolicy,
        updatedAt: Date.now()
      };
      host.state?.set?.('state:context.snapshot@1', latestSnapshot);
      return { ok: true, snapshot: latestSnapshot };
    },
    ingestLiveState(payload = {}) {
      if (payload === null) {
        host.state?.set?.('state:context.live@1', null);
        return { ok: true, live: null };
      }
      if (!payload || typeof payload !== 'object') return { ok: false };
      const live = {
        cascadeId: payload.cascadeId ? String(payload.cascadeId) : null,
        busy: Boolean(payload.busy),
        phase: String(payload.phase || (payload.busy ? 'waiting' : 'idle')),
        tps: payload.tps === null || payload.tps === undefined ? null : Number(payload.tps),
        ttft: payload.ttft === null || payload.ttft === undefined ? null : Number(payload.ttft),
        estimatedOutputTokens: Number(payload.estimatedOutputTokens || 0),
        updatedAt: Number(payload.updatedAt) || Date.now()
      };
      host.state?.set?.('state:context.live@1', live);
      return { ok: true, live };
    }
  };

  const stopSvc = host.services.provide('context', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopSnapRoute = await host.bridge.registerRoute('/snapshot', async (body) => serviceMethods.getSnapshot(body || {}));
  const stopRescanRoute = await host.bridge.registerRoute('/rescan', async (body) => serviceMethods.rescan(body || {}));
  const stopAuditRoute = await host.bridge.registerRoute('/audit-attachments', async (body) => serviceMethods.auditAttachments(body?.media || []));
  const stopIngestRoute = await host.bridge.registerRoute('/ingest-renderer-snapshot', async (body) => serviceMethods.ingestRendererSnapshot(body || {}));
  const stopLiveRoute = await host.bridge.registerRoute('/live-state', async (body) => serviceMethods.ingestLiveState(body ?? null));
  const stopSettingsSub = typeof host.settings?.onChange === 'function'
    ? host.settings.onChange(() => {
        syncSnapshotFromSettings();
      })
    : () => {};
  const stopRescanCmd = typeof host.commands?.register === 'function'
    ? await host.commands.register('context.rescan', async (opts = {}) => serviceMethods.rescan(opts || {}))
    : () => {};

  disposers.push(
    stopSvc,
    stopSnapRoute,
    stopRescanRoute,
    stopAuditRoute,
    stopIngestRoute,
    stopLiveRoute,
    stopSettingsSub,
    stopRescanCmd
  );
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
  const host = activeHost;
  activeHost = null;
  try {
    host?.state?.set?.('state:context.snapshot@1', null);
    host?.state?.set?.('state:context.live@1', null);
  } catch {}
}

module.exports = {
  pickTargetCascadeId,
  buildAlerts,
  activate,
  deactivate
};
