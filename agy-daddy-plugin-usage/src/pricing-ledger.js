'use strict';

const GEMINI_PRICING_TABLE = {
  'gemini-3.8-flash': [
    { effectiveTo: '2026-12-31', inputPerMillion: 0.75, outputPerMillion: 3.75, cacheReadPerMillion: 0.075 },
    { effectiveFrom: '2027-01-01', inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.15 }
  ],
  'gemini-4-hydrogen': [
    { inputPerMillion: 1.50, outputPerMillion: 7.50, cacheReadPerMillion: 0.075 }
  ],
  'gemini-4-carbon': [
    { effectiveTo: '2026-11-30', inputPerMillion: 2.00, outputPerMillion: 10.00, cacheReadPerMillion: 0.10 },
    { effectiveFrom: '2026-12-01', inputPerMillion: 4.00, outputPerMillion: 20.00, cacheReadPerMillion: 0.20 }
  ],
  'gemini-4-argon': [
    { effectiveTo: '2026-11-30', inputPerMillion: 2.00, outputPerMillion: 10.00, cacheReadPerMillion: 0.10 },
    { effectiveFrom: '2026-12-01', inputPerMillion: 4.00, outputPerMillion: 20.00, cacheReadPerMillion: 0.20 }
  ],
  'gemini-3.1-pro-preview': [
    { maxPromptTokens: 200000, inputPerMillion: 2.00, outputPerMillion: 12.00, cacheReadPerMillion: 0.20 },
    { minPromptTokens: 200001, inputPerMillion: 4.00, outputPerMillion: 18.00, cacheReadPerMillion: 0.40 }
  ],
  'gemini-3.5-flash-lite': [
    { inputPerMillion: 0.30, outputPerMillion: 2.50, cacheReadPerMillion: 0.03 }
  ],
  'gemini-2.5-pro': [
    { maxPromptTokens: 200000, inputPerMillion: 1.25, outputPerMillion: 10.00, cacheReadPerMillion: 0.125 },
    { minPromptTokens: 200001, inputPerMillion: 2.50, outputPerMillion: 15.00, cacheReadPerMillion: 0.25 }
  ],
  'claude-opus-5-5': [
    { inputPerMillion: 4.00, outputPerMillion: 20.00, cacheReadPerMillion: 0.20 }
  ],
  'claude-sonnet-5-5': [
    { inputPerMillion: 2.00, outputPerMillion: 10.00, cacheReadPerMillion: 0.10 }
  ]
};

const ULTRA_SUB_TIER_PRESETS = {
  '5x': {
    id: '5x',
    label: 'Ultra 5x',
    tierName: 'Google AI Ultra (5x)',
    quotaMultiplier: 5,
    officialPriceMonthly: 99.99,
    flowCreditsMonthly: 10000,
    developerCreditsMonthlyUSD: 40
  },
  '20x': {
    id: '20x',
    label: 'Ultra 20x',
    tierName: 'Google AI Ultra (20x)',
    quotaMultiplier: 20,
    officialPriceMonthly: 199.99,
    flowCreditsMonthly: 25000,
    developerCreditsMonthlyUSD: 100
  }
};

function normalizeUltraSubTier(val) {
  if (!val || typeof val !== 'string') return null;
  const s = val.trim().toLowerCase();
  if (s === '5x' || s === 'ultra-5x' || s === 'ultra_5x' || s === 'ultra 5x') return '5x';
  if (s === '20x' || s === 'ultra-20x' || s === 'ultra_20x' || s === 'ultra 20x') return '20x';
  return null;
}

function formatLocalDateStr(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function normalizeModelId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const str = raw.trim().toLowerCase().replace(/^word\//, '');
  if (str.includes('3.8-flash') || str.includes('3.8 flash') || str.includes('flash-n')) return 'gemini-3.8-flash';
  if (str.includes('4-hydrogen') || str.includes('4 hydrogen') || str.includes('hydrogen')) return 'gemini-4-hydrogen';
  if (str.includes('4-carbon') || str.includes('4 carbon') || str.includes('carbon') || str.includes('m670')) return 'gemini-4-carbon';
  if (str.includes('4-argon') || str.includes('4 argon') || str.includes('argon') || /\bgemini-pro-orchestrator(?:-(?:argon|g1(?:-pro)?))?(?![a-z0-9-])/.test(str) || str.includes('m668')) {
    return 'gemini-4-argon';
  }
  if (str.includes('3.1-pro') || str.includes('3.1 pro')) return 'gemini-3.1-pro-preview';
  if (str.includes('3.5-flash-lite') || str.includes('3.5 flash-lite') || str.includes('flash-lite')) return 'gemini-3.5-flash-lite';
  if (str.includes('2.5-pro') || str.includes('2.5 pro')) return 'gemini-2.5-pro';
  if (/(?:opus[-_ ]5[._-]5|5[._-]5[-_ ]opus)/.test(str)) return 'claude-opus-5-5';
  if (/(?:sonnet[-_ ]5[._-]5|5[._-]5[-_ ]sonnet)/.test(str)) return 'claude-sonnet-5-5';
  return null;
}

function calculateRequestApiCost(req) {
  if (!req || typeof req !== 'object') {
    return { costUSD: null, isPriced: false, reason: '缺失请求数据' };
  }
  const rawModel = String(req.modelKey || req.model || req.modelId || req.modelExactId || req.modelLabel || '').trim();
  const modelKey = normalizeModelId(rawModel);
  if (!modelKey || !GEMINI_PRICING_TABLE[modelKey]) {
    return { costUSD: null, isPriced: false, modelKey: null, rawModel, reason: !rawModel ? '缺模型名称' : '未知模型或无官方公开费率' };
  }

  const input = Math.max(0, Number(req.inputTokens ?? req.input_tokens ?? req.input ?? 0) || 0);
  const cache = Math.max(0, Number(req.cacheTokens ?? req.cacheReadTokens ?? req.cache_read_tokens ?? req.cached ?? 0) || 0);
  const output = Math.max(0, Number(req.outputTokens ?? req.output_tokens ?? req.output ?? 0) || 0);
  const totalPrompt = input + cache;

  let reqDate = '2026-11-08';
  if (req.date && /^\d{4}-\d{2}-\d{2}/.test(String(req.date)) && !req.dateIsProvisional) {
    reqDate = String(req.date).slice(0, 10);
  } else if (req.created_at) {
    const dt = new Date(req.created_at);
    if (!Number.isNaN(dt.getTime())) reqDate = formatLocalDateStr(dt);
  } else if (req.date && /^\d{4}-\d{2}-\d{2}/.test(String(req.date))) {
    reqDate = String(req.date).slice(0, 10);
  }

  const tierRules = GEMINI_PRICING_TABLE[modelKey];
  let matchedTier = null;
  for (const rule of tierRules) {
    if (rule.effectiveTo && reqDate > rule.effectiveTo) continue;
    if (rule.effectiveFrom && reqDate < rule.effectiveFrom) continue;
    if (rule.maxPromptTokens && totalPrompt > rule.maxPromptTokens) continue;
    if (rule.minPromptTokens && totalPrompt < rule.minPromptTokens) continue;
    matchedTier = rule;
    break;
  }
  if (!matchedTier) matchedTier = tierRules[0];

  const costInput = (input * matchedTier.inputPerMillion) / 1000000;
  const costCache = (cache * matchedTier.cacheReadPerMillion) / 1000000;
  const costOutput = (output * matchedTier.outputPerMillion) / 1000000;
  const totalCost = Number((costInput + costCache + costOutput).toFixed(6));

  return {
    costUSD: totalCost,
    isPriced: true,
    modelKey,
    matchedTier,
    inputTokens: input,
    cacheReadTokens: cache,
    outputTokens: output,
    totalTokens: input + cache + output
  };
}

function summarizeApiCost(requests = []) {
  let totalUsd = 0;
  let totalTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let pricedCount = 0;
  let unpricedCount = 0;
  const byModel = {};

  for (const req of Array.isArray(requests) ? requests : []) {
    const res = calculateRequestApiCost(req);
    const inTok = Math.max(0, Number(req?.inputTokens ?? req?.input ?? 0) || 0);
    const cTok = Math.max(0, Number(req?.cacheReadTokens ?? req?.cacheTokens ?? 0) || 0);
    const outTok = Math.max(0, Number(req?.outputTokens ?? 0) || 0);
    const sumTok = inTok + cTok + outTok;

    totalTokens += sumTok;
    inputTokens += inTok;
    cacheReadTokens += cTok;
    outputTokens += outTok;

    if (res.isPriced) {
      pricedCount++;
      totalUsd += res.costUSD;
      const mk = res.modelKey;
      if (!byModel[mk]) byModel[mk] = { calls: 0, tokens: 0, costUSD: 0 };
      byModel[mk].calls++;
      byModel[mk].tokens += sumTok;
      byModel[mk].costUSD = Number((byModel[mk].costUSD + res.costUSD).toFixed(6));
    } else {
      unpricedCount++;
    }
  }

  return {
    callsCount: (Array.isArray(requests) ? requests.length : 0),
    pricedCount,
    unpricedCount,
    totalUsd: Number(totalUsd.toFixed(6)),
    totalTokens,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    byModel
  };
}

function buildHeatmap52Weeks(calls = [], nowMs = Date.now()) {
  const dailyMap = new Map();
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!c) continue;
    let dateStr = c.date && /^\d{4}-\d{2}-\d{2}/.test(String(c.date)) ? String(c.date).slice(0, 10) : null;
    if (!dateStr && Number.isFinite(Number(c.timestamp))) {
      dateStr = formatLocalDateStr(new Date(Number(c.timestamp)));
    }
    if (!dateStr) continue;
    const tok = Math.max(0, Number(c.totalTokens || ((c.inputTokens || 0) + (c.cacheReadTokens || c.cacheTokens || 0) + (c.outputTokens || 0))) || 0);
    const prev = dailyMap.get(dateStr) || { date: dateStr, tokens: 0, calls: 0, costUSD: 0 };
    prev.tokens += tok;
    prev.calls += 1;
    const cost = calculateRequestApiCost(c);
    if (cost.isPriced) prev.costUSD = Number((prev.costUSD + cost.costUSD).toFixed(6));
    dailyMap.set(dateStr, prev);
  }

  const endDt = new Date(nowMs);
  endDt.setHours(0, 0, 0, 0);
  const days = [];
  let maxTokens = 0;

  for (let i = 363; i >= 0; i--) {
    const dt = new Date(endDt.getTime() - i * 86400000);
    const dStr = formatLocalDateStr(dt);
    const rec = dailyMap.get(dStr) || { date: dStr, tokens: 0, calls: 0, costUSD: 0 };
    if (rec.tokens > maxTokens) maxTokens = rec.tokens;
    days.push(rec);
  }

  for (const d of days) {
    if (d.tokens <= 0 || maxTokens <= 0) d.level = 0;
    else {
      const ratio = d.tokens / maxTokens;
      d.level = ratio >= 0.75 ? 4 : (ratio >= 0.5 ? 3 : (ratio >= 0.25 ? 2 : 1));
    }
  }

  return { weeks: 52, daysCount: days.length, maxTokens, days };
}

const SUBSCRIPTION_ACQUISITION_PRESETS = Object.freeze([
  { id: 'normal_paid', name: '正常付费订阅', category: 'paid', defaultPaid: 19.99, note: '按月或按年全额付费订阅' },
  { id: 'student_offer', name: '学生认证优惠 (Google One AI Student)', category: 'discount', defaultPaid: 0, note: '学生资格试用或折扣权益' },
  { id: 'pixel_bundle', name: 'Google Pixel 设备赠送', category: 'bundle_free', defaultPaid: 0, note: '指定 Pixel 机型附赠权益' },
  { id: 'chromebook_bundle', name: 'Chromebook Plus 设备赠送', category: 'bundle_free', defaultPaid: 0, note: 'Chromebook Plus 赠送权益' },
  { id: 'samsung_galaxy', name: 'Samsung Galaxy 设备指定活动', category: 'bundle_free', defaultPaid: 0, note: 'Galaxy 设备活动赠送权益' }
]);

function resolveCallDateStr(call) {
  if (call?.date && /^\d{4}-\d{2}-\d{2}/.test(String(call.date))) {
    return String(call.date).slice(0, 10);
  }
  if (call?.created_at || call?.createdAt || call?.timestamp) {
    const dt = new Date(call.created_at || call.createdAt || call.timestamp);
    if (!Number.isNaN(dt.getTime())) return formatLocalDateStr(dt);
  }
  return '';
}

function summarizeByPeriod(calls = [], nowMs = Date.now(), plan = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const todayStr = formatLocalDateStr(new Date(nowMs));
  const monthPrefix = todayStr.slice(0, 7);
  const yearPrefix = todayStr.slice(0, 4);

  const todayCalls = [];
  const monthCalls = [];
  const yearCalls = [];
  for (const c of list) {
    const ds = resolveCallDateStr(c);
    if (ds === todayStr) todayCalls.push(c);
    if (ds.startsWith(monthPrefix)) monthCalls.push(c);
    if (ds.startsWith(yearPrefix)) yearCalls.push(c);
  }

  const today = summarizeApiCost(todayCalls);
  const month = summarizeApiCost(monthCalls);
  const year = summarizeApiCost(yearCalls);
  const allTime = summarizeApiCost(list);

  const actualPaidUsd = Number.isFinite(Number(plan?.actualPaidUsd)) ? Number(plan.actualPaidUsd) : 0;
  const effectiveSavedUsd = Number((allTime.totalUsd - actualPaidUsd).toFixed(4));

  return {
    todayDate: todayStr,
    today,
    month,
    year,
    allTime,
    roi: {
      actualPaidUsd,
      estimatedApiUsd: allTime.totalUsd,
      effectiveSavedUsd
    }
  };
}

class LedgerManager {
  constructor(storage, fileName = 'token-pricing-ledger.json') {
    this.storage = storage;
    this.fileName = fileName;
    this.corrupted = false;
    this.state = { version: '1.0.0', updatedAt: null, calls: {} };
  }

  load() {
    const res = this.storage.readJson(this.fileName, null);
    if (res.corrupted) {
      this.corrupted = true;
      return { ok: false, corrupted: true, error: res.error || '账本已损坏' };
    }
    if (res.data && typeof res.data === 'object' && res.data.calls && typeof res.data.calls === 'object') {
      this.state = {
        version: res.data.version || '1.0.0',
        updatedAt: res.data.updatedAt || null,
        calls: { ...res.data.calls }
      };
    }
    this.corrupted = false;
    return { ok: true, corrupted: false, callsCount: Object.keys(this.state.calls).length };
  }

  recordCalls(incoming = []) {
    if (this.corrupted) {
      return { ok: false, changed: false, error: '账本已损坏，拒绝空覆盖以保护既有历史数据' };
    }
    const list = Array.isArray(incoming) ? incoming : [];
    let added = 0;
    let updated = 0;
    const nextCalls = { ...this.state.calls };

    for (const c of list) {
      if (!c || !c.callId) continue;
      const costRes = calculateRequestApiCost(c);
      const entry = {
        ...c,
        costUSD: costRes.isPriced ? costRes.costUSD : (c.costUSD ?? 0),
        isPriced: costRes.isPriced
      };
      if (nextCalls[c.callId]) {
        const prev = nextCalls[c.callId];
        if ((prev.totalTokens || 0) <= (entry.totalTokens || 0)) {
          nextCalls[c.callId] = { ...prev, ...entry };
          updated++;
        }
      } else {
        nextCalls[c.callId] = entry;
        added++;
      }
    }

    if (added === 0 && updated === 0) {
      return { ok: true, changed: false, added: 0, updated: 0, totalCalls: Object.keys(nextCalls).length };
    }

    const nextState = {
      version: '1.0.0',
      updatedAt: new Date().toISOString(),
      calls: nextCalls
    };
    const writeRes = this.storage.writeJson(this.fileName, nextState);
    if (!writeRes.ok) {
      return { ok: false, changed: false, error: writeRes.error || '写入账本失败' };
    }
    this.state = nextState;
    return { ok: true, changed: true, added, updated, totalCalls: Object.keys(nextCalls).length };
  }

  getAllCalls() {
    return Object.values(this.state.calls);
  }
}

module.exports = {
  GEMINI_PRICING_TABLE,
  ULTRA_SUB_TIER_PRESETS,
  SUBSCRIPTION_ACQUISITION_PRESETS,
  normalizeUltraSubTier,
  normalizeModelId,
  calculateRequestApiCost,
  summarizeApiCost,
  summarizeByPeriod,
  buildHeatmap52Weeks,
  LedgerManager
};
