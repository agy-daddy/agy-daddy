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
  const fiveHourBucket = buckets.find((b) => b.windowKey === '5h') || null;
  const weeklyBucket = buckets.find((b) => b.windowKey === 'weekly') || null;
  return {
    fiveHourBucket,
    weeklyBucket,
    tightestBucket,
    tightestFraction,
    tightestPercentText: tightestFraction !== null ? `最紧 ${formatQuotaPercentText(tightestFraction)}` : '--'
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
      return {
        bucketId: b.bucketId || b.id || `bucket-${bIdx}`,
        ...wMeta,
        remainingFraction: frac.fraction,
        percentText: formatQuotaPercentText(frac.fraction),
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
      const bucket = {
        bucketId: `${p.id}-5h`,
        windowKey: '5h',
        windowShort: '5h',
        windowLabel: '5小时滚动配额',
        remainingFraction: p.minFraction,
        percentText: formatQuotaPercentText(p.minFraction),
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

  return {
    ok: true,
    ultraSubTier,
    quotaMultiplier: ultraSubTier === '20x' ? 20 : (ultraSubTier === '5x' ? 5 : 1),
    pools,
    gemini: geminiPool?.primaryBucket || null,
    claude: claudePool?.primaryBucket || null,
    tightestFraction,
    tightestPercentText: tightestFraction !== null ? `最紧 ${formatQuotaPercentText(tightestFraction)}` : '--',
    updatedAt: nowMs
  };
}

function getQuotaAccentToken(fraction) {
  if (fraction === null || fraction === undefined) {
    return 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))';
  }
  const f = Number(fraction);
  if (f <= 0.2) return 'var(--ag-ring-danger, #ef4444)';
  if (f <= 0.5) return 'var(--ag-ring-warn, #f59e0b)';
  return 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))';
}

module.exports = {
  getModelPoolKey,
  getSharedQuotaGroupKey,
  parseQuotaFraction,
  formatQuotaPercentText,
  formatQuotaResetMeta,
  classifyModelQuotaAvailability,
  buildModelQuotaSnapshot,
  getQuotaAccentToken
};
