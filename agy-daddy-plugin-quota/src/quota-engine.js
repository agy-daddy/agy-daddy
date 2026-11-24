'use strict';

function getModelPoolKey(raw) {
  if (!raw) return 'unknown';
  const text = typeof raw === 'object'
    ? [raw.modelId, raw.model, raw.label, raw.modelDisplayName, raw.modelOrAlias?.model, raw.poolKey].filter(Boolean).join(' ')
    : String(raw);
  const s = String(text || '').toLowerCase().trim().replace(/^word\//, '');
  if (!s) return 'unknown';
  if (s.includes('carbon') || s.includes('gemini-4-carbon') || s.includes('m670')) return 'gemini-4-carbon';
  if (s.includes('argon') || s.includes('gemini-4-argon') || s.includes('m668') || /\bgemini-pro-orchestrator(?:-(?:argon|g1(?:-pro)?))?(?![a-z0-9-])/.test(s)) {
    return 'gemini-4-argon';
  }
  if (s.includes('hydrogen') || s.includes('gemini-4-hydrogen')) return 'gemini-4-hydrogen';
  if (s.includes('flash') || s.includes('gemini-3.8-flash') || s.includes('gemini-3-flash') || s.includes('gemini-2.5-flash')) {
    return 'gemini-3.8-flash';
  }
  if (s.includes('pro') && (s.includes('gemini-3') || s.includes('gemini-4') || s.includes('high') || s.includes('low'))) {
    return 'gemini-4-hydrogen';
  }
  if (s.includes('opus') || s.includes('claude-opus')) return 'claude-opus-5-5';
  if (s.includes('sonnet') || s.includes('claude-sonnet') || s.includes('claude')) return 'claude-sonnet-5-5';
  if (s.includes('gpt-oss') || s.includes('gpt')) return 'gpt-oss-120b';
  return s.replace(/[^a-z0-9_-]/g, '') || 'unknown';
}

function getSharedQuotaGroupKey(raw) {
  const pk = getModelPoolKey(raw);
  if (pk === 'gemini-4-hydrogen' || pk === 'gemini-3.8-flash') return 'shared_gemini_main';
  if (pk === 'claude-opus-5-5' || pk === 'claude-sonnet-5-5' || pk === 'gpt-oss-120b') return 'shared_3p_pool';
  if (pk === 'gemini-4-argon') return 'shared_gemini_argon';
  if (pk === 'gemini-4-carbon') return 'shared_gemini_carbon';
  return pk && pk !== 'unknown' ? `shared_${pk}` : 'unknown';
}

function parseQuotaFraction(rawQuota, options = {}) {
  if (!rawQuota || typeof rawQuota !== 'object') {
    return { fraction: null, hasValue: false, isExhausted: false, source: 'missing' };
  }
  const candidates = [rawQuota.remainingFraction, rawQuota.remaining_fraction, rawQuota.fraction];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) {
      const clamped = Math.max(0, Math.min(1, c));
      return { fraction: clamped, hasValue: true, isExhausted: clamped === 0, source: 'fraction' };
    }
  }
  const amtCandidates = [rawQuota.remainingAmount, rawQuota.remaining_amount, rawQuota.remaining];
  for (const rawAmt of amtCandidates) {
    if (rawAmt === undefined || rawAmt === null || rawAmt === '') continue;
    const amt = typeof rawAmt === 'number'
      ? rawAmt
      : (typeof rawAmt === 'string' && /^-?\d+(\.\d+)?$/.test(rawAmt.trim()) ? Number(rawAmt.trim()) : NaN);
    if (Number.isFinite(amt)) {
      if (amt <= 0) {
        return { fraction: 0, hasValue: true, isExhausted: true, source: 'amount_zero' };
      }
      const rawTotal = rawQuota.limit ?? rawQuota.totalAmount ?? rawQuota.total ?? null;
      const total = rawTotal === null || rawTotal === undefined || rawTotal === '' ? NaN : Number(rawTotal);
      if (Number.isFinite(total) && total > 0) {
        const clamped = Math.max(0, Math.min(1, amt / total));
        return { fraction: clamped, hasValue: true, isExhausted: clamped === 0, source: 'amount_ratio' };
      }
      return { fraction: null, hasValue: false, isExhausted: false, source: 'amount_without_total' };
    }
  }

  // proto3 scalar float 省略 0 仅对明确契约 schemaKind === 'codeium_quota_info' 且存在 resetTime 时按 0 处理；
  // 对 oneof remaining (QuotaSummaryBucket) 缺字段一律判定为未知。
  const canInferProto3ScalarZero = options.schemaKind === 'codeium_quota_info' || options.allowProto3ZeroDefault === true;
  const isExplicitlyDisabled = Boolean(options.unavailable || rawQuota.disabled === true);
  const resetStr = rawQuota.resetTime || rawQuota.reset_time;
  const hasResetStr = typeof resetStr === 'string' && resetStr.trim().length > 0 && !Number.isNaN(Date.parse(resetStr));
  if (canInferProto3ScalarZero && !isExplicitlyDisabled && hasResetStr) {
    return { fraction: 0, hasValue: true, isExhausted: true, source: 'proto3_zero_with_reset' };
  }
  return { fraction: null, hasValue: false, isExhausted: false, source: 'missing' };
}

function formatQuotaPercentText(fraction) {
  if (fraction === null || fraction === undefined || !Number.isFinite(Number(fraction))) return '未知';
  const f = Math.max(0, Math.min(1, Number(fraction)));
  if (f === 0) return '0%';
  const pct = f * 100;
  if (pct < 0.1) return '<0.1%';
  if (pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

function computeUsedFraction(remainingFraction) {
  if (remainingFraction === null || remainingFraction === undefined || !Number.isFinite(Number(remainingFraction))) {
    return null;
  }
  const clamped = Math.max(0, Math.min(1, Number(remainingFraction)));
  return Math.max(0, Math.min(1, Number((1 - clamped).toFixed(6))));
}

function formatQuotaDisplayPercent(remainingFraction, displayMode = 'remaining') {
  if (displayMode === 'used') {
    return formatQuotaPercentText(computeUsedFraction(remainingFraction));
  }
  return formatQuotaPercentText(remainingFraction);
}

function resolveTopbarCountdowns(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { fiveHour: null, weekly: null };
  }
  const fiveHours = [];
  const weeklies = [];
  const seen = new Set();

  const addBucket = (b) => {
    if (!b || typeof b !== 'object' || seen.has(b)) return;
    seen.add(b);
    if (b.windowKey === 'weekly') weeklies.push(b);
    else if (b.windowKey === '5h') fiveHours.push(b);
  };

  if (Array.isArray(snapshot.pools) && snapshot.pools.length > 0) {
    for (const p of snapshot.pools) {
      if (!p || typeof p !== 'object') continue;
      addBucket(p.fiveHourBucket);
      addBucket(p.weeklyBucket);
      if (Array.isArray(p.buckets)) {
        for (const b of p.buckets) addBucket(b);
      }
    }
  } else {
    for (const b of [snapshot.gemini, snapshot.claude]) {
      if (!b || typeof b !== 'object') continue;
      if (b.windowKey === 'weekly') weeklies.push(b);
      else fiveHours.push(b);
    }
  }

  const pickBest = (list) => {
    const valid = list.filter((b) => b && b.countdownText && b.hasResetTime !== false);
    if (valid.length === 0) return null;
    valid.sort((a, b) => {
      const aPassed = a.isResetPassed ? 1 : 0;
      const bPassed = b.isResetPassed ? 1 : 0;
      if (aPassed !== bPassed) return aPassed - bPassed;
      const aMs = Number.isFinite(Number(a.countdownMs)) ? Number(a.countdownMs) : Infinity;
      const bMs = Number.isFinite(Number(b.countdownMs)) ? Number(b.countdownMs) : Infinity;
      return aMs - bMs;
    });
    return valid[0] || null;
  };

  return {
    fiveHour: pickBest(fiveHours),
    weekly: pickBest(weeklies)
  };
}

function formatQuotaResetMeta(resetTimeIso, nowMs = Date.now()) {
  if (!resetTimeIso || typeof resetTimeIso !== 'string') {
    return {
      hasResetTime: false,
      resetTimeIso: null,
      resetAtMs: null,
      resetTimeText: null,
      countdownText: null,
      countdownMs: null,
      isResetPassed: false
    };
  }
  const parsedMs = Date.parse(resetTimeIso);
  if (!Number.isFinite(parsedMs)) {
    return {
      hasResetTime: false,
      resetTimeIso: null,
      resetAtMs: null,
      resetTimeText: null,
      countdownText: null,
      countdownMs: null,
      isResetPassed: false
    };
  }
  const d = new Date(parsedMs);
  const resetTimeText = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const diffMs = parsedMs - nowMs;
  if (diffMs <= 0) {
    return {
      hasResetTime: true,
      resetTimeIso,
      resetAtMs: parsedMs,
      resetTimeText,
      countdownText: '已到重置时间（待确认）',
      countdownMs: 0,
      isResetPassed: true
    };
  }
  const totalSec = Math.ceil(diffMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  let countdownText;
  if (days > 0) countdownText = `${days}天${hours}小时`;
  else if (hours > 0) countdownText = `${hours}小时${mins}分`;
  else if (mins > 0) countdownText = `${mins}分`;
  else countdownText = `${Math.max(1, secs)}秒`;

  return {
    hasResetTime: true,
    resetTimeIso,
    resetAtMs: parsedMs,
    resetTimeText,
    countdownText,
    countdownMs: diffMs,
    isResetPassed: false
  };
}

function classifyModelQuotaAvailability(config) {
  if (!config || typeof config !== 'object') {
    return { noPermission: false, unavailable: false, reason: null };
  }
  const tagTitle = typeof config.tagTitle === 'string' ? config.tagTitle.trim() : '';
  const isTagUnavailable = /^(unavailable|disabled|不可用|无权限|無權限)$/i.test(tagTitle) || /unavailable|disabled|不可用|无权限|無權限/i.test(tagTitle);
  const disabled = Boolean(config.disabled === true || config.enabled === false || config.unavailable === true || isTagUnavailable);
  return {
    noPermission: disabled,
    unavailable: disabled,
    reason: disabled ? (config.unavailabilityReason || config.tagDescription || tagTitle || '无访问权限') : null
  };
}

function inferWindowMeta(bucket = {}, idx = 0) {
  const idStr = String(bucket.window || bucket.bucketId || bucket.id || '').toLowerCase();
  if (idStr.includes('week') || idStr.includes('7d')) {
    return { windowKey: 'weekly', windowShort: '周', windowLabel: '7天周期配额' };
  }
  if (idStr.includes('5h') || idStr.includes('session') || idx === 0) {
    return { windowKey: '5h', windowShort: '5h', windowLabel: '5小时滚动配额' };
  }
  return { windowKey: idStr || `win-${idx}`, windowShort: `W${idx + 1}`, windowLabel: `窗口 ${idx + 1}` };
}

function computePoolWindowMeta(buckets = []) {
  const numeric = buckets.filter((b) => typeof b.remainingFraction === 'number' && !Number.isNaN(b.remainingFraction));
  numeric.sort((a, b) => a.remainingFraction - b.remainingFraction);
  const tightestBucket = numeric[0] || null;
  const tightestFraction = tightestBucket ? tightestBucket.remainingFraction : null;
  const highestUsedFraction = computeUsedFraction(tightestFraction);
  const fiveHourBucket = buckets.find((b) => b.windowKey === '5h') || null;
  const weeklyBucket = buckets.find((b) => b.windowKey === 'weekly') || null;
  return {
    fiveHourBucket,
    weeklyBucket,
    tightestBucket,
    tightestFraction,
    tightestPercentText: tightestFraction !== null ? `剩余最少 ${formatQuotaPercentText(tightestFraction)}` : '--',
    highestUsedFraction,
    highestUsedPercentText: highestUsedFraction !== null ? `已用最多 ${formatQuotaPercentText(highestUsedFraction)}` : '--'
  };
}

function buildModelQuotaSnapshot(input = {}) {
  const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
  const userStatusRoot = input.userStatusRes?.userStatus || input.userStatusRes || null;
  const rawConfigs = Array.isArray(input.cascadeModelConfigs)
    ? input.cascadeModelConfigs
    : (Array.isArray(userStatusRoot?.cascadeModelConfigData?.clientModelConfigs)
      ? userStatusRoot.cascadeModelConfigData.clientModelConfigs
      : []);
  const quotaSummaryRoot = input.quotaSummaryRes?.response || input.quotaSummaryRes || null;
  const rawGroups = Array.isArray(quotaSummaryRoot?.groups) ? quotaSummaryRoot.groups : [];
  const ultraSubTier = input.ultraSubTier || null;

  const pools = [];
  for (let i = 0; i < rawGroups.length; i++) {
    const g = rawGroups[i] || {};
    const buckets = (Array.isArray(g.buckets) ? g.buckets : []).map((b, bIdx) => {
      const frac = parseQuotaFraction(b, { unavailable: Boolean(b?.disabled), schemaKind: 'quota_summary_bucket' });
      const resetMeta = formatQuotaResetMeta(b?.resetTime || b?.reset_time || null, nowMs);
      const wMeta = inferWindowMeta(b, bIdx);
      const usedFraction = computeUsedFraction(frac.fraction);
      return {
        bucketId: b.bucketId || b.id || `bucket-${bIdx}`,
        ...wMeta,
        remainingFraction: frac.fraction,
        percentText: formatQuotaPercentText(frac.fraction),
        usedFraction,
        usedPercentText: formatQuotaPercentText(usedFraction),
        isExhausted: frac.isExhausted,
        fractionSource: frac.source,
        ...resetMeta
      };
    });
    const title = String(g.displayName || g.name || g.groupId || `配额组 ${i + 1}`).trim();
    const wSlots = computePoolWindowMeta(buckets);
    const primaryBucket = wSlots.tightestBucket || wSlots.fiveHourBucket || buckets[0] || null;
    pools.push({
      id: g.groupId || `group-${i}`,
      title,
      sharedGroupKey: getSharedQuotaGroupKey(title),
      buckets,
      primaryBucket,
      ...wSlots
    });
  }

  // 若 summary 缺失或需补充按模型配额，聚合 clientModelConfigs 到共享池
  const poolAgg = new Map();
  for (const c of rawConfigs) {
    if (!c || typeof c !== 'object') continue;
    const avail = classifyModelQuotaAvailability(c);
    if (avail.unavailable) continue;
    const qi = c.quotaInfo || {};
    const parsed = parseQuotaFraction(qi, { schemaKind: 'codeium_quota_info' });
    const resetMeta = formatQuotaResetMeta(qi.resetTime || qi.reset_time || null, nowMs);
    const groupKey = getSharedQuotaGroupKey(c);
    const titleMap = {
      shared_gemini_main: 'Gemini 主配额池',
      shared_3p_pool: 'Claude / 3P 共享池',
      shared_gemini_argon: 'Argon 配额池',
      shared_gemini_carbon: 'Carbon 配额池'
    };
    const prev = poolAgg.get(groupKey) || {
      id: groupKey,
      title: titleMap[groupKey] || c.label || groupKey,
      sharedGroupKey: groupKey,
      minFraction: null,
      resetMeta: null
    };
    if (parsed.hasValue && (prev.minFraction === null || parsed.fraction < prev.minFraction)) {
      prev.minFraction = parsed.fraction;
    }
    if (resetMeta.hasResetTime && (!prev.resetMeta || resetMeta.resetAtMs < prev.resetMeta.resetAtMs)) {
      prev.resetMeta = resetMeta;
    }
    poolAgg.set(groupKey, prev);
  }

  if (pools.length === 0 && poolAgg.size > 0) {
    for (const p of poolAgg.values()) {
      const usedFraction = computeUsedFraction(p.minFraction);
      const bucket = {
        bucketId: `${p.id}-5h`,
        windowKey: '5h',
        windowShort: '5h',
        windowLabel: '5小时滚动配额',
        remainingFraction: p.minFraction,
        percentText: formatQuotaPercentText(p.minFraction),
        usedFraction,
        usedPercentText: formatQuotaPercentText(usedFraction),
        isExhausted: p.minFraction === 0,
        fractionSource: 'codeium_quota_info',
        ...(p.resetMeta || formatQuotaResetMeta(null, nowMs))
      };
      const wSlots = computePoolWindowMeta([bucket]);
      pools.push({
        id: p.id,
        title: p.title,
        sharedGroupKey: p.sharedGroupKey,
        buckets: [bucket],
        primaryBucket: bucket,
        ...wSlots
      });
    }
  }

  const findPool = (matchRe) => pools.find((p) => matchRe.test(`${p.id} ${p.title} ${p.sharedGroupKey}`)) || null;
  const geminiPool = findPool(/gemini_main|gemini(?!.*(argon|carbon))/i) || pools[0] || null;
  const claudePool = findPool(/3p|claude|sonnet|opus/i) || null;
  const allFracs = pools.map((p) => p.tightestFraction).filter((v) => typeof v === 'number');
  const tightestFraction = allFracs.length ? Math.min(...allFracs) : null;
  const highestUsedFraction = computeUsedFraction(tightestFraction);

  return {
    ok: true,
    ultraSubTier,
    quotaMultiplier: ultraSubTier === '20x' ? 20 : (ultraSubTier === '5x' ? 5 : 1),
    pools,
    gemini: geminiPool?.primaryBucket || null,
    claude: claudePool?.primaryBucket || null,
    geminiWindows: {
      fiveHour: geminiPool?.fiveHourBucket || null,
      weekly: geminiPool?.weeklyBucket || null
    },
    claudeWindows: {
      fiveHour: claudePool?.fiveHourBucket || null,
      weekly: claudePool?.weeklyBucket || null
    },
    tightestFraction,
    tightestPercentText: tightestFraction !== null ? `剩余最少 ${formatQuotaPercentText(tightestFraction)}` : '--',
    highestUsedFraction,
    highestUsedPercentText: highestUsedFraction !== null ? `已用最多 ${formatQuotaPercentText(highestUsedFraction)}` : '--',
    updatedAt: nowMs
  };
}

function getQuotaAccentToken(fraction) {
  if (fraction === null || fraction === undefined) {
    return 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #71717a))';
  }
  const f = Number(fraction);
  if (f <= 0.2) return 'var(--ag-ring-danger, #ef4444)';
  if (f <= 0.5) return 'var(--ag-ring-warn, #f59e0b)';
  return 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #71717a))';
}

const DEFAULT_CAPSULE_COLOR_RULES = Object.freeze([
  'any:remaining<=15:#ef4444',
  'any:remaining<=35:#f59e0b'
]);

const CAPSULE_RULE_TARGETS = Object.freeze([
  { id: 'any', label: '任意限额' },
  { id: 'any_5h', label: '任意 5H' },
  { id: 'any_weekly', label: '任意 Week' },
  { id: 'gemini', label: 'Gemini（任意窗口）' },
  { id: 'gemini_5h', label: 'Gemini 5H' },
  { id: 'gemini_weekly', label: 'Gemini Week' },
  { id: 'claude', label: 'Claude / 3P（任意窗口）' },
  { id: 'claude_5h', label: 'Claude 5H' },
  { id: 'claude_weekly', label: 'Claude Week' }
]);

const CAPSULE_COLOR_PRESETS = Object.freeze([
  { id: 'red', label: '红色', hex: '#ef4444' },
  { id: 'amber', label: '琥珀橙', hex: '#f59e0b' },
  { id: 'yellow', label: '黄色', hex: '#eab308' },
  { id: 'green', label: '绿色', hex: '#22c55e' },
  { id: 'blue', label: '蓝色', hex: '#3b82f6' },
  { id: 'purple', label: '紫色', hex: '#8b5cf6' },
  { id: 'pink', label: '玫红', hex: '#ec4899' },
  { id: 'gray', label: '灰色', hex: '#71717a' }
]);

const COLOR_ALIAS_MAP = Object.freeze({
  red: '#ef4444',
  danger: '#ef4444',
  amber: '#f59e0b',
  orange: '#f59e0b',
  warn: '#f59e0b',
  yellow: '#eab308',
  green: '#22c55e',
  ok: '#22c55e',
  blue: '#3b82f6',
  purple: '#8b5cf6',
  violet: '#8b5cf6',
  pink: '#ec4899',
  rose: '#ec4899',
  gray: '#71717a',
  grey: '#71717a',
  neutral: '#71717a'
});

const TARGET_LABEL_MAP = Object.freeze(
  Object.fromEntries(CAPSULE_RULE_TARGETS.map((t) => [t.id, t.label]))
);

function resolveRuleColorHex(rawColor) {
  if (typeof rawColor !== 'string') return '';
  const s = rawColor.trim().toLowerCase();
  if (!s) return '';
  if (COLOR_ALIAS_MAP[s]) return COLOR_ALIAS_MAP[s];
  const m3 = s.match(/^#([0-9a-f]{3})$/);
  if (m3) {
    const c = m3[1];
    return `#${c[0]}${c[0]}${c[1]}${c[1]}${c[2]}${c[2]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  return '';
}

function normalizeRuleTarget(rawTarget) {
  if (typeof rawTarget !== 'string') return '';
  const s = rawTarget.trim().toLowerCase().replace(/[\s/]+/g, '_');
  if (TARGET_LABEL_MAP[s]) return s;
  const aliasMap = {
    all: 'any',
    '5h': 'any_5h',
    week: 'any_weekly',
    weekly: 'any_weekly',
    g: 'gemini',
    'g_5h': 'gemini_5h',
    'gemini:5h': 'gemini_5h',
    'gemini-5h': 'gemini_5h',
    'g_weekly': 'gemini_weekly',
    'g_week': 'gemini_weekly',
    'gemini:weekly': 'gemini_weekly',
    'gemini:week': 'gemini_weekly',
    'gemini_week': 'gemini_weekly',
    'gemini-week': 'gemini_weekly',
    'gemini-weekly': 'gemini_weekly',
    c: 'claude',
    '3p': 'claude',
    'c_5h': 'claude_5h',
    'claude:5h': 'claude_5h',
    'claude-5h': 'claude_5h',
    'c_weekly': 'claude_weekly',
    'c_week': 'claude_weekly',
    'claude:weekly': 'claude_weekly',
    'claude:week': 'claude_weekly',
    'claude_week': 'claude_weekly',
    'claude-week': 'claude_weekly',
    'claude-weekly': 'claude_weekly'
  };
  return aliasMap[s] || '';
}

function normalizeOperator(rawOp, metric) {
  const s = String(rawOp || '').trim().toLowerCase();
  if (s === '<' || s === 'lt') return { op: 'lt', symbol: '<' };
  if (s === '<=' || s === 'lte') return { op: 'lte', symbol: '<=' };
  if (s === '>' || s === 'gt') return { op: 'gt', symbol: '>' };
  if (s === '>=' || s === 'gte') return { op: 'gte', symbol: '>=' };
  return metric === 'used'
    ? { op: 'gte', symbol: '>=' }
    : { op: 'lte', symbol: '<=' };
}

function serializeCapsuleColorRule(rule) {
  if (!rule || typeof rule !== 'object') return '';
  const target = normalizeRuleTarget(rule.target);
  const metric = rule.metric === 'used' ? 'used' : 'remaining';
  const { symbol } = normalizeOperator(rule.operator || rule.symbol, metric);
  const num = Number(rule.threshold);
  const color = resolveRuleColorHex(rule.color);
  if (!target || !Number.isFinite(num) || !color) return '';
  const clamped = Math.max(0, Math.min(100, Number(num.toFixed(1))));
  return `${target}:${metric}${symbol}${clamped}:${color}`;
}

function parseCapsuleColorRule(raw) {
  if (!raw) return null;
  let target = '';
  let metric = 'remaining';
  let opRaw = '';
  let thresholdRaw = NaN;
  let color = '';

  if (typeof raw === 'object' && !Array.isArray(raw)) {
    target = normalizeRuleTarget(raw.target);
    metric = String(raw.metric || 'remaining').toLowerCase() === 'used' ? 'used' : 'remaining';
    opRaw = raw.operator || raw.symbol || '';
    thresholdRaw = Number(raw.threshold);
    color = resolveRuleColorHex(raw.color);
  } else if (typeof raw === 'string') {
    const str = raw.trim();
    if (!str) return null;
    // Canonical: target:metric(<=|<|>=|>)threshold:color
    const canonical = str.match(/^([a-z0-9_:-]+?)\s*:\s*(remaining|remain|rem|used)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)\s*%?\s*:\s*(#[0-9a-f]{3,6}|[a-z]+)$/i);
    if (canonical) {
      target = normalizeRuleTarget(canonical[1]);
      metric = canonical[2].toLowerCase().startsWith('used') ? 'used' : 'remaining';
      opRaw = canonical[3];
      thresholdRaw = Number(canonical[4]);
      color = resolveRuleColorHex(canonical[5]);
    } else {
      // Forgiving shorthand: e.g. "claude_weekly <= 20% -> red" or "gemini_5h used >= 80% #3b82f6"
      const shorthand = str.match(/^([a-z0-9_:-]+)\s+(?:(remaining|remain|rem|used)\s+)?(<=|>=|<|>)\s*(\d+(?:\.\d+)?)\s*%?\s*(?:->|:|\s)\s*(#[0-9a-f]{3,6}|[a-z]+)$/i);
      if (shorthand) {
        target = normalizeRuleTarget(shorthand[1]);
        metric = shorthand[2] && shorthand[2].toLowerCase().startsWith('used') ? 'used' : 'remaining';
        opRaw = shorthand[3];
        thresholdRaw = Number(shorthand[4]);
        color = resolveRuleColorHex(shorthand[5]);
      }
    }
  }

  if (!target || !Number.isFinite(thresholdRaw) || !color) return null;
  const threshold = Math.max(0, Math.min(100, Number(thresholdRaw.toFixed(1))));
  const { op, symbol } = normalizeOperator(opRaw, metric);
  const opDisplay = symbol === '<=' ? '≤' : (symbol === '>=' ? '≥' : symbol);
  const metricLabel = metric === 'used' ? '已用' : '剩余';
  const targetLabel = TARGET_LABEL_MAP[target] || target;
  return {
    target,
    targetLabel,
    metric,
    operator: op,
    symbol,
    threshold,
    color,
    raw: serializeCapsuleColorRule({ target, metric, operator: op, threshold, color }),
    summary: `${targetLabel} ${metricLabel} ${opDisplay} ${threshold}%`
  };
}

function collectBucketsForTarget(snapshot, target) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const pools = Array.isArray(snapshot.pools) ? snapshot.pools : [];
  const isGeminiPool = (p) => p?.sharedGroupKey === 'shared_gemini_main' || /gemini_main|gemini(?!.*(argon|carbon))/i.test(`${p?.id || ''} ${p?.title || ''} ${p?.sharedGroupKey || ''}`);
  const isClaudePool = (p) => p?.sharedGroupKey === 'shared_3p_pool' || /3p|claude|sonnet|opus/i.test(`${p?.id || ''} ${p?.title || ''} ${p?.sharedGroupKey || ''}`);

  const results = [];
  const pushPoolBuckets = (pool, windowFilter = null) => {
    if (!pool || typeof pool !== 'object') return;
    const seen = new Set();
    const all = [];
    for (const b of [pool.fiveHourBucket, pool.weeklyBucket, ...(Array.isArray(pool.buckets) ? pool.buckets : [])]) {
      if (!b || typeof b !== 'object' || seen.has(b)) continue;
      seen.add(b);
      all.push(b);
    }
    for (const b of all) {
      if (windowFilter && b.windowKey !== windowFilter) continue;
      if (typeof b.remainingFraction !== 'number' || !Number.isFinite(b.remainingFraction)) continue;
      results.push({ bucket: b, poolTitle: pool.title || pool.id || '' });
    }
  };

  if (pools.length > 0) {
    if (target === 'any') {
      for (const p of pools) pushPoolBuckets(p, null);
    } else if (target === 'any_5h') {
      for (const p of pools) pushPoolBuckets(p, '5h');
    } else if (target === 'any_weekly') {
      for (const p of pools) pushPoolBuckets(p, 'weekly');
    } else if (target === 'gemini' || target === 'gemini_5h' || target === 'gemini_weekly') {
      const wf = target === 'gemini_5h' ? '5h' : (target === 'gemini_weekly' ? 'weekly' : null);
      for (const p of pools.filter(isGeminiPool)) pushPoolBuckets(p, wf);
    } else if (target === 'claude' || target === 'claude_5h' || target === 'claude_weekly') {
      const wf = target === 'claude_5h' ? '5h' : (target === 'claude_weekly' ? 'weekly' : null);
      for (const p of pools.filter(isClaudePool)) pushPoolBuckets(p, wf);
    }
    return results;
  }

  // Fallback when snapshot has no pools array
  const pushDirect = (b, poolTitle, windowFilter = null) => {
    if (!b || typeof b !== 'object') return;
    if (windowFilter && b.windowKey && b.windowKey !== windowFilter) return;
    if (typeof b.remainingFraction !== 'number' || !Number.isFinite(b.remainingFraction)) return;
    results.push({ bucket: b, poolTitle });
  };
  if (target === 'any' || target === 'any_5h' || target === 'any_weekly') {
    const wf = target === 'any_5h' ? '5h' : (target === 'any_weekly' ? 'weekly' : null);
    pushDirect(snapshot.gemini, 'Gemini', wf);
    pushDirect(snapshot.claude, 'Claude / 3P', wf);
  } else if (target.startsWith('gemini')) {
    const wf = target === 'gemini_5h' ? '5h' : (target === 'gemini_weekly' ? 'weekly' : null);
    pushDirect(snapshot.gemini, 'Gemini', wf);
  } else if (target.startsWith('claude')) {
    const wf = target === 'claude_5h' ? '5h' : (target === 'claude_weekly' ? 'weekly' : null);
    pushDirect(snapshot.claude, 'Claude / 3P', wf);
  }
  return results;
}

function compareRuleThreshold(valPct, operator, threshold) {
  const eps = 1e-6;
  if (operator === 'lte') return valPct <= threshold + eps;
  if (operator === 'lt') return valPct < threshold - eps;
  if (operator === 'gte') return valPct >= threshold - eps;
  if (operator === 'gt') return valPct > threshold + eps;
  return false;
}

function evaluateCapsuleColorRules(snapshot, rulesInput) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { matched: false, color: '', tone: '', rule: null };
  }
  const rawList = Array.isArray(rulesInput) ? rulesInput : DEFAULT_CAPSULE_COLOR_RULES;
  for (const rawRule of rawList) {
    const rule = parseCapsuleColorRule(rawRule);
    if (!rule) continue;
    const candidates = collectBucketsForTarget(snapshot, rule.target);
    for (const item of candidates) {
      const remFrac = Math.max(0, Math.min(1, Number(item.bucket.remainingFraction)));
      const valPct = rule.metric === 'used' ? (1 - remFrac) * 100 : remFrac * 100;
      if (compareRuleThreshold(valPct, rule.operator, rule.threshold)) {
        const tone = rule.color === '#ef4444' ? 'danger' : (rule.color === '#f59e0b' ? 'warn' : '');
        return {
          matched: true,
          color: rule.color,
          tone,
          rule,
          matchedPoolTitle: item.poolTitle,
          matchedWindowKey: item.bucket.windowKey || null,
          remainingFraction: remFrac
        };
      }
    }
  }
  return { matched: false, color: '', tone: '', rule: null };
}

module.exports = {
  getModelPoolKey,
  getSharedQuotaGroupKey,
  parseQuotaFraction,
  formatQuotaPercentText,
  computeUsedFraction,
  formatQuotaDisplayPercent,
  resolveTopbarCountdowns,
  formatQuotaResetMeta,
  classifyModelQuotaAvailability,
  buildModelQuotaSnapshot,
  getQuotaAccentToken,
  DEFAULT_CAPSULE_COLOR_RULES,
  CAPSULE_RULE_TARGETS,
  CAPSULE_COLOR_PRESETS,
  resolveRuleColorHex,
  normalizeRuleTarget,
  serializeCapsuleColorRule,
  parseCapsuleColorRule,
  evaluateCapsuleColorRules
};
