'use strict';

const COMPRESSION_MIN_DROP = 5000;
const DEFAULT_CONTEXT_LIMIT = 256000;
const GPT_OSS_LIMIT = 131072;
const CLAUDE_55_LIMIT = 1000000;
const GEMINI_4_LIMIT = 1048576;

function safeNum(value) {
  return value !== undefined && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0
    ? Number(value)
    : null;
}

function toPositiveIntLimit(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function parseDurationSec(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const match = String(value).trim().match(/^([\d.]+)\s*s?$/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function parseTimestampMs(val) {
  if (!val) return 0;
  if (typeof val === 'number') {
    const ms = val < 1e11 ? val * 1000 : val;
    return Number.isFinite(ms) && ms > 946684800000 ? ms : 0;
  }
  if (typeof val === 'string') {
    const t = val.trim();
    if (!t || t.startsWith('1970-01-01') || t.startsWith('0001-01-01')) return 0;
    const ms = Date.parse(t.replace(/(\.\d{3})\d+(Z|[+-]\d{2}:?\d{2})$/, '$1$2'));
    return Number.isFinite(ms) && ms > 946684800000 ? ms : 0;
  }
  return 0;
}

function measure(text, outAcc = null) {
  const s = String(text || '');
  const len = s.length;
  let chars = 0;
  let bytes = 0;
  let cjk = 0;
  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c <= 127) {
      chars++;
      bytes++;
    } else if (c <= 2047) {
      chars++;
      bytes += 2;
    } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < len) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
        i++;
        chars++;
        bytes += 4;
        continue;
      }
      chars++;
      bytes += 3;
    } else {
      chars++;
      bytes += 3;
      if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
    }
  }
  if (outAcc) {
    outAcc.chars += chars;
    outAcc.bytes += bytes;
    outAcc.cjk += cjk;
    return outAcc;
  }
  const middle = (chars - cjk) / 4 + cjk * 1.2;
  return {
    chars,
    bytes,
    low: Math.ceil(middle * 0.7),
    high: Math.ceil(Math.max(middle * 1.6, bytes / 2))
  };
}

function parseThresholdSpec(raw, fallbackTokens = 240000) {
  const fb = Number(fallbackTokens) > 0 ? Math.round(Number(fallbackTokens)) : 240000;
  const fbLabel = formatTokensShort(fb).toUpperCase();
  if (typeof raw === 'number') {
    if (Number.isFinite(raw) && raw > 0) {
      const val = Math.round(raw);
      return { kind: 'tokens', value: val, label: formatTokensShort(val).toUpperCase() };
    }
    return { kind: 'tokens', value: fb, label: fbLabel };
  }
  const s = String(raw || '').trim();
  if (!s) return { kind: 'tokens', value: fb, label: fbLabel };

  const pctMatch = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pctMatch) {
    const pct = Math.max(1, Math.min(99, Number(pctMatch[1])));
    const cleanPct = Number(pct.toFixed(1));
    return { kind: 'percent', value: cleanPct, label: `${cleanPct}%` };
  }

  const mMatch = s.match(/^(\d+(?:\.\d+)?)\s*m$/i);
  if (mMatch) {
    const num = Number(mMatch[1]);
    if (Number.isFinite(num) && num > 0) {
      const val = Math.round(num * 1000000);
      return { kind: 'tokens', value: val, label: formatTokensShort(val).toUpperCase() };
    }
  }

  const kMatch = s.match(/^(\d+(?:\.\d+)?)\s*k$/i);
  if (kMatch) {
    const num = Number(kMatch[1]);
    if (Number.isFinite(num) && num > 0) {
      const val = Math.round(num * 1000);
      return { kind: 'tokens', value: val, label: formatTokensShort(val).toUpperCase() };
    }
  }

  const numMatch = s.match(/^(\d+(?:\.\d+)?)$/);
  if (numMatch) {
    const num = Number(numMatch[1]);
    if (Number.isFinite(num) && num > 0) {
      const val = Math.round(num);
      return { kind: 'tokens', value: val, label: formatTokensShort(val).toUpperCase() };
    }
  }

  return { kind: 'tokens', value: fb, label: fbLabel };
}

function resolveThresholdTokens(raw, budget, fallbackTokens = 240000) {
  const spec = parseThresholdSpec(raw, fallbackTokens);
  if (spec.kind === 'percent') {
    const b = Number(budget);
    if (Number.isFinite(b) && b > 0) {
      return Math.max(1000, Math.round((spec.value / 100) * b));
    }
    return Number(fallbackTokens) > 0 ? Math.round(Number(fallbackTokens)) : 240000;
  }
  return spec.value;
}

function formatThresholdLabel(raw, budget, fallbackTokens = 240000) {
  const spec = parseThresholdSpec(raw, fallbackTokens);
  const tokens = resolveThresholdTokens(raw, budget, fallbackTokens);
  return {
    spec,
    tokens,
    shortLabel: spec.kind === 'percent' ? `${spec.value}%` : formatTokensShort(tokens).toUpperCase()
  };
}

function emptyGroup() {
  return { chars: 0, bytes: 0, low: 0, high: 0 };
}

function addGroup(a, b) {
  for (const k of ['chars', 'bytes', 'low', 'high']) a[k] += b[k] || 0;
  return a;
}

function formatTokensShort(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const safe = Math.max(0, Number(value));
  if (safe >= 1000000) return `${(safe / 1000000).toFixed(safe >= 10000000 ? 1 : 2).replace(/\.?0+$/, '')}M`;
  if (safe >= 1000) return `${(safe / 1000).toFixed(safe >= 100000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(safe));
}

function normalizeModelId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const str = raw.trim().toLowerCase().replace(/^word\//, '');
  if (str.includes('3.8-flash') || str.includes('3.8 flash') || str.includes('flash-n')) return 'gemini-3.8-flash';
  if (str.includes('3.7-flash') || str.includes('3.7 flash')) return 'gemini-3.7-flash';
  if (str.includes('3.6-flash') || str.includes('3.6 flash')) return 'gemini-3.6-flash';
  if (str.includes('3.5-flash-lite') || str.includes('3.5 flash-lite') || str.includes('flash-lite')) {
    if (str.includes('3.1')) return 'gemini-3.1-flash-lite';
    if (str.includes('2.5')) return 'gemini-2.5-flash-lite';
    return 'gemini-3.5-flash-lite';
  }
  if (str.includes('3.1-flash-lite') || str.includes('3.1 flash-lite')) return 'gemini-3.1-flash-lite';
  if (str.includes('2.5-flash-lite') || str.includes('2.5 flash-lite')) return 'gemini-2.5-flash-lite';
  if (str.includes('2.5-flash') || str.includes('2.5 flash')) return 'gemini-2.5-flash';
  if ((str.includes('3.5-flash') || str.includes('3.5 flash')) && !str.includes('flash-lite')) return 'gemini-3.5-flash';
  if (/\bgemini-3-flash(?:-[a-z0-9]+)?\b/.test(str) || str.includes('3 flash')) return 'gemini-3-flash';
  if (str.includes('4-hydrogen') || str.includes('4 hydrogen') || str.includes('hydrogen')) return 'gemini-4-hydrogen';
  if (str.includes('4-carbon') || str.includes('4 carbon') || str.includes('carbon') || str.includes('m670')) return 'gemini-4-carbon';
  if (str.includes('4-neon') || str.includes('4 neon') || /\bneon\b/.test(str) || str.includes('m532')) return 'gemini-4-neon';
  if (str.includes('4-argon') || str.includes('4 argon') || str.includes('argon') || /\bgemini-pro-orchestrator(?:-(?:argon|g1(?:-pro)?))?(?![a-z0-9-])/.test(str) || str.includes('m668')) {
    return 'gemini-4-argon';
  }
  if (str.includes('3.1-pro') || str.includes('3.1 pro')) return 'gemini-3.1-pro-preview';
  if (str.includes('2.5-pro') || str.includes('2.5 pro')) return 'gemini-2.5-pro';
  if (/(?:opus[-_ ]5[._-]5|5[._-]5[-_ ]opus)/.test(str)) return 'claude-opus-5-5';
  if (/(?:sonnet[-_ ]5[._-]5|5[._-]5[-_ ]sonnet)/.test(str)) return 'claude-sonnet-5-5';
  if (/(?:opus[-_ ]4[._-]6|4[._-]6[-_ ]opus)/.test(str)) return 'claude-opus-4-6';
  if (/(?:sonnet[-_ ]4[._-]6|4[._-]6[-_ ]sonnet)/.test(str)) return 'claude-sonnet-4-6';
  return null;
}

function getModelCandidateKeys(modelId, label) {
  const keys = [];
  const pushKey = (raw) => {
    const k = String(raw || '').trim().toLowerCase();
    if (!k) return;
    if (!keys.includes(k)) keys.push(k);
    const stripped = k.replace(/^model_placeholder_/, '').replace(/^model_/, '');
    if (stripped && !keys.includes(stripped)) keys.push(stripped);
    const mTag = k.match(/\b(m\d{2,4})\b/);
    if (mTag && !keys.includes(mTag[1])) keys.push(mTag[1]);
  };
  pushKey(modelId);
  pushKey(label);
  return keys;
}

function getContextLimitForModel(modelId, label = '', options = {}) {
  const rtBudget = toPositiveIntLimit(options.runtimeBudget);
  if (rtBudget > 0) return rtBudget;

  const modelMax = toPositiveIntLimit(options.modelMaxTokens);
  if (modelMax > 0) return modelMax;

  const candKeys = getModelCandidateKeys(modelId, label);
  if (options.availableModels instanceof Map) {
    for (const k of candKeys) {
      const info = options.availableModels.get(k);
      if (info && toPositiveIntLimit(info.maxTokens) > 0) return toPositiveIntLimit(info.maxTokens);
    }
  }

  const combined = `${modelId || ''} ${label || ''}`.toUpperCase();
  if (combined.includes('GPT_OSS') || combined.includes('GPT-OSS') || combined.includes('120B')) {
    return GPT_OSS_LIMIT;
  }
  if (combined.includes('CLAUDE') || combined.includes('OPUS') || combined.includes('SONNET')) {
    if (/5[._-]5|M400|M401|M402|M403|M404|M405/.test(combined)) return CLAUDE_55_LIMIT;
    return 200000;
  }
  if (combined.includes('GEMINI') || combined.includes('CARBON') || combined.includes('ARGON') || combined.includes('HYDROGEN') || combined.includes('NEON') || combined.includes('M532') || combined.includes('M668') || combined.includes('M670') || combined.includes('ORCHESTRATOR') || combined.includes('FLASH')) {
    return GEMINI_4_LIMIT;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

function isShadowOrImageModel(modelId) {
  if (!modelId) return false;
  const s = String(modelId).toUpperCase();
  return s.includes('_M50') || s === 'M50' || s.includes('FLASH_LITE') || s.includes('_M21') || s === 'M21' || s.includes('BANANA');
}

function formatResetTimeZh(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return String(isoStr);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return String(isoStr);
  }
}

function classifyRequestError(input, options = {}) {
  const error = typeof input === 'string' ? input : String(input?.error || input?.message || '');
  const currentModel = options.currentModel || '';

  if (!error) {
    return {
      kind: 'none',
      title: '正常',
      badgeText: '正常',
      detail: '',
      serviceLimit: null,
      retryAfterSec: null,
      modelOrPool: currentModel || null,
      diagnostic: ''
    };
  }

  let diagnostic = error.replace(/https?:\/\/[^\s"']+/g, '<API>').trim();
  if (diagnostic.length > 120) diagnostic = diagnostic.slice(0, 117) + '...';

  // 1. 上下文超限（明确排除 Go context.DeadlineExceeded）
  const isDeadlineTimeout = /context deadline exceeded|deadline exceeded|stream idle timeout/i.test(error);
  const overflowMatch = !isDeadlineTimeout && /input token count exceeds|context\s*(?:window|length|tokens?|limit|size|capacity)?.{0,35}(?:exceed|too long)|maximum context length|prompt exceeds maximum context length|max_tokens exceeded/i.test(error);
  if (overflowMatch) {
    const rawLimit = error.match(/(?:allowed|limit(?:\s+of)?|length(?:\s+is|\s+of)?)\s*[:=]?\s*([\d,]+)/i)?.[1];
    const serviceLimit = rawLimit ? safeNum(rawLimit.replaceAll(',', '')) : null;
    return {
      kind: 'context_overflow',
      title: '超限告警',
      badgeText: '超限',
      detail: `输入超出模型容量上限${serviceLimit ? `（${serviceLimit} tokens）` : ''}，请精简上下文或压缩会话`,
      serviceLimit,
      retryAfterSec: null,
      modelOrPool: currentModel || null,
      diagnostic
    };
  }

  // 2. 配额耗尽
  if (/(?:quota\s*(?:exceeded|reached|limit|exhausted)|out\s+of\s+quota|exhausted.*(?:capacity|quota)|resource_exhausted.*(?:quota|capacity|billing)|daily\s+quota|weekly\s+quota)/i.test(error)) {
    const resetTimeZh = options.resetTime ? formatResetTimeZh(options.resetTime) : null;
    return {
      kind: 'quota_exhausted',
      title: '额度耗尽',
      badgeText: '额度耗尽',
      detail: `${currentModel || '当前模型'}配额已用尽${resetTimeZh ? `，预计 ${resetTimeZh} 重置` : ''}`,
      serviceLimit: null,
      retryAfterSec: null,
      modelOrPool: currentModel || null,
      diagnostic
    };
  }

  // 3. 频率限制
  if (/(?:rate\s*limit|too\s*many\s*requests|\b429\b|RateLimitError|RESOURCE_EXHAUSTED.*rate)/i.test(error)) {
    const retryMatch = error.match(/(?:retry\s+in|retry-after|wait)\s*[:=]?\s*([\d.]+)/i);
    const retryAfterSec = retryMatch ? parseFloat(retryMatch[1]) : null;
    return {
      kind: 'rate_limited',
      title: '请求限流',
      badgeText: '限流',
      detail: `触发频率限制 (429)${retryAfterSec ? `，建议等待 ${retryAfterSec}s` : ''}`,
      serviceLimit: null,
      retryAfterSec,
      modelOrPool: currentModel || null,
      diagnostic
    };
  }

  // 4. 用户取消
  if (/(?:context canceled by user|user cancelled|request was aborted|AbortError)/i.test(error)) {
    return {
      kind: 'canceled',
      title: '已取消',
      badgeText: '已取消',
      detail: '生成请求已取消',
      serviceLimit: null,
      retryAfterSec: null,
      modelOrPool: currentModel || null,
      diagnostic
    };
  }

  // 5. 认证与权限
  if (/(?:UNAUTHENTICATED|PERMISSION_DENIED|\b401\b|\b403\b|invalid api key|credentials expired|permission denied)/i.test(error)) {
    return {
      kind: 'auth_error',
      title: '认证异常',
      badgeText: '认证',
      detail: '身份认证失败或缺少权限，请检查登录态或订阅级别',
      serviceLimit: null,
      retryAfterSec: null,
      modelOrPool: currentModel || null,
      diagnostic
    };
  }

  // 6. 服务端暂不可用
  if (/(?:UNAVAILABLE|\b503\b|\b502\b|\b504\b|server overloaded|high demand|Bad Gateway|Service Unavailable)/i.test(error)) {
    return {
      kind: 'service_unavailable',
      title: '服务受限',
      badgeText: '服务异常',
      detail: '模型服务暂时过载或不可用，请稍后重试',
      serviceLimit: null,
      retryAfterSec: null,
      modelOrPool: currentModel || null,
      diagnostic
    };
  }

  // 7. 网络连接或超时
  if (/(?:\bEOF\b|idle timeout|deadline exceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|Failed to fetch|NetworkError)/i.test(error)) {
    return {
      kind: 'network_error',
      title: '网络故障',
      badgeText: '网络',
      detail: '网络连接异常或超时，请检查代理网关连通性',
      serviceLimit: null,
      retryAfterSec: null,
      modelOrPool: currentModel || null,
      diagnostic
    };
  }

  // 8. 兜底未知
  return {
    kind: 'unknown',
    title: '原因待确认',
    badgeText: '待确认',
    detail: `请求失败 (${diagnostic})`,
    serviceLimit: null,
    retryAfterSec: null,
    modelOrPool: currentModel || null,
    diagnostic
  };
}

function summarizeMetadata(metadata, options = {}) {
  const m = metadata?.chatModel;
  if (!m) return null;
  const lastRetry = (m.retryInfos || []).at(-1);
  const error = String(lastRetry?.error || m.error || '');
  const model = m.modelDisplayName || m.responseModel || m.model || options.currentModel || '';
  const modelRaw = String(m.model || m.modelOrAlias?.model || m.responseModel || m.modelDisplayName || options.currentModel || '').trim();

  const classification = error ? classifyRequestError(error, { currentModel: model }) : { kind: 'none' };
  const exceeded = classification.kind === 'context_overflow';
  const network = classification.kind === 'network_error';

  const usage = lastRetry ? lastRetry.usage : m.usage;
  const input = safeNum(usage?.inputTokens);
  const cached = safeNum(usage?.cacheReadTokens);
  const output = safeNum(usage?.outputTokens);
  const thinking = safeNum(usage?.thinkingOutputTokens);
  const responseTokens = safeNum(usage?.responseOutputTokens);
  const hasInput = (input || 0) + (cached || 0) > 0;

  const prevContext = options.previousValidContext || null;
  const totalInputTokens = (input || 0) + (cached || 0);
  const actualCached = hasInput ? (cached || 0) : (prevContext?.cached || 0);
  const uncachedInput = hasInput ? (input || 0) : (prevContext?.uncachedInput ?? null);
  const cacheHitRate = hasInput && totalInputTokens > 0
    ? Number(((actualCached / totalInputTokens) * 100).toFixed(1))
    : (prevContext?.cacheHitRate ?? null);

  let actual = hasInput && !error ? (input || 0) + (cached || 0) + (output || 0) : null;
  if (actual === null && prevContext && prevContext.actual != null && !exceeded) {
    actual = prevContext.actual;
  }

  const context = m.chatStartMetadata?.contextWindowMetadata;
  const estimate = safeNum(context?.estimatedTokensUsed) || prevContext?.estimate || null;
  const budget = safeNum(context?.maxContextTokens) || prevContext?.budget || getContextLimitForModel(modelRaw, model, options);

  const ttft = parseDurationSec(m.timeToFirstToken);
  const streamingSec = parseDurationSec(m.streamingDuration);
  const duration = (ttft !== null && streamingSec !== null) ? (ttft + streamingSec) : (ttft ?? streamingSec ?? null);
  const tps = (output && duration && duration > 0) ? Number((output / duration).toFixed(1)) : null;
  const streamingTps = (output && streamingSec && streamingSec > 0.05) ? Number((output / streamingSec).toFixed(1)) : null;

  const speed = (tps !== null || duration !== null || output !== null) ? {
    tps,
    streamingTps,
    duration: duration !== null ? Number(duration.toFixed(2)) : null,
    ttft: ttft !== null ? Number(ttft.toFixed(2)) : null,
    streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
    outputTokens: output ?? 0,
    thinkingTokens: thinking ?? 0,
    responseTokens: responseTokens ?? (output ?? 0)
  } : null;

  let status = 'pending';
  if (exceeded) status = 'exceeded';
  else if (network) status = 'network';
  else if (classification.kind === 'quota_exhausted') status = 'quota_exhausted';
  else if (classification.kind === 'rate_limited') status = 'rate_limited';
  else if (classification.kind === 'auth_error') status = 'auth_error';
  else if (classification.kind === 'service_unavailable') status = 'service_unavailable';
  else if (classification.kind === 'canceled') status = 'canceled';
  else if (error) status = 'failed';
  else if (actual !== null) status = 'reported';
  else if (estimate > 0) status = 'estimated';

  const usedVal = actual ?? (estimate > 0 ? estimate : null);
  const percentVal = usedVal !== null && budget > 0 && !exceeded ? Number(((usedVal / budget) * 100).toFixed(1)) : null;

  return {
    used: usedVal,
    actual,
    estimate: estimate > 0 ? estimate : null,
    budget: budget > 0 ? budget : null,
    serviceLimit: classification.serviceLimit || null,
    exceeded,
    network,
    error,
    errorClassification: classification,
    estimated: actual === null,
    input: hasInput ? totalInputTokens : (prevContext?.input || null),
    cached: actualCached,
    uncachedInput,
    cacheHitRate,
    output: output ?? (prevContext?.output ?? null),
    percent: percentVal,
    model,
    modelRaw,
    status,
    speed
  };
}

function analyzeTrajectorySteps(steps, options = {}) {
  const groups = {
    user: emptyGroup(),
    assistant: emptyGroup(),
    thinking: emptyGroup(),
    tools: emptyGroup(),
    summaries: emptyGroup()
  };
  const media = new Map();
  let userMessages = 0;
  let assistantMessages = 0;
  let prevCacheInclusiveInput = 0;
  let maxPriorCacheRead = 0;
  let compressionDetected = false;
  let compressionBefore = 0;
  let compressionAfter = 0;
  let compressionDrop = 0;
  let latestCacheRead = 0;
  let latestInput = 0;
  let latestOutput = 0;
  let hasPreciseUsage = false;
  let activeModelId = options.preferredModelId || '';
  let observedBudget = toPositiveIntLimit(options.runtimeBudget);

  const skip = new Set(['metadata', 'userConfig', 'lastUserConfig', 'userAgentSpec', 'activeUserState', 'thinkingSignature', 'thumbnail', 'inlineData', 'media', 'modelUsage', 'tokenUsage', 'mendelExperimentIds']);
  const toolAcc = { chars: 0, bytes: 0, cjk: 0 };

  function accumulateContent(value, acc) {
    if (typeof value === 'string') { measure(value, acc); return; }
    if (typeof value === 'number' || typeof value === 'boolean') { measure(String(value), acc); return; }
    if (!value) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (i > 0) { acc.chars += 1; acc.bytes += 1; }
        accumulateContent(value[i], acc);
      }
      return;
    }
    const keys = Object.keys(value);
    let wrote = false;
    for (const key of keys) {
      if (skip.has(key)) continue;
      if (wrote) { acc.chars += 1; acc.bytes += 1; }
      wrote = true;
      measure(key, acc);
      acc.chars += 2;
      acc.bytes += 2;
      accumulateContent(value[key], acc);
    }
  }

  function collectAttachments(value, source, withinStep = new Set()) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) collectAttachments(v, source, withinStep);
      return;
    }
    if (value.uri && (value.mimeType || value.inlineData !== undefined)) {
      const key = String(value.uri);
      if (!withinStep.has(key)) {
        withinStep.add(key);
        const prior = media.get(key);
        if (prior) {
          prior.references++;
        } else {
          media.set(key, {
            uri: key,
            name: String(value.description || key.split(/[\\/]/).pop()),
            mime: String(value.mimeType || ''),
            references: 1,
            source
          });
        }
      }
    } else if (value.inlineData && !value.uri) {
      const key = `inline-${media.size}`;
      const mime = String(value.mimeType || value.inlineData.mimeType || '');
      if (!withinStep.has(key)) {
        withinStep.add(key);
        media.set(key, {
          uri: `inline:${key}`,
          name: String(value.description || (mime.startsWith('image/') ? '内嵌图像' : '内嵌附件')),
          mime,
          references: 1,
          source
        });
      }
    }
    for (const [key, v] of Object.entries(value)) {
      if (!skip.has(key) || key === 'media') collectAttachments(v, source, withinStep);
    }
  }

  const list = Array.isArray(steps) ? steps : [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s || typeof s !== 'object') continue;
    const meta = s.metadata || s;
    const mu = meta.modelUsage || s.modelUsage || s.checkpoint?.modelUsage || s.usage || null;
    const stepModel = (mu && (mu.model || mu.modelId)) || meta.generatorModel || s.model || '';
    const stepBudget = toPositiveIntLimit(meta.chatStartMetadata?.contextWindowMetadata?.maxContextTokens ?? meta.modelInfo?.maxTokens);
    if (stepBudget > 0 && (!stepModel || !isShadowOrImageModel(stepModel))) {
      observedBudget = stepBudget;
    }

    if (mu && (mu.inputTokens !== undefined || mu.outputTokens !== undefined || mu.cacheReadTokens !== undefined || mu.promptTokens !== undefined)) {
      if (!isShadowOrImageModel(stepModel)) {
        const inTok = Math.max(0, Number(mu.inputTokens ?? mu.promptTokens ?? 0) || 0);
        const cacheRead = Math.max(0, Number(mu.cacheReadTokens ?? mu.cachedTokens ?? 0) || 0);
        const outTok = Math.max(0, Number(mu.outputTokens ?? mu.completionTokens ?? 0) || 0);
        const cacheInclusive = inTok + cacheRead;
        if (cacheInclusive + outTok > 0) {
          if (prevCacheInclusiveInput > 0 && (prevCacheInclusiveInput - cacheInclusive) > COMPRESSION_MIN_DROP) {
            compressionDetected = true;
            compressionBefore = prevCacheInclusiveInput;
            compressionAfter = cacheInclusive;
            compressionDrop = prevCacheInclusiveInput - cacheInclusive;
          }
          if (hasPreciseUsage) {
            maxPriorCacheRead = Math.max(maxPriorCacheRead, latestCacheRead);
          }
          prevCacheInclusiveInput = cacheInclusive;
          latestInput = inTok;
          latestCacheRead = cacheRead;
          latestOutput = outTok;
          hasPreciseUsage = true;
          if (stepModel && !activeModelId) activeModelId = stepModel;
        }
      }
    }

    if (s.userInput) {
      userMessages++;
      const u = s.userInput;
      addGroup(groups.user, measure(u.userResponse || (u.items || []).map((it) => it.text || '').join('\n')));
      collectAttachments(u.media?.length ? u.media : u.items, 'user');
    } else if (s.plannerResponse) {
      assistantMessages++;
      addGroup(groups.assistant, measure(s.plannerResponse.modifiedResponse || s.plannerResponse.response || ''));
      addGroup(groups.thinking, measure(s.plannerResponse.thinking || ''));
      collectAttachments(s.plannerResponse, 'assistant');
    } else if (s.checkpoint) {
      addGroup(groups.summaries, measure(s.checkpoint.sessionSummary || ''));
    } else {
      toolAcc.chars = 0;
      toolAcc.bytes = 0;
      toolAcc.cjk = 0;
      let wroteStep = false;
      const withinToolStep = new Set();
      for (const k of Object.keys(s)) {
        if (k === 'type' || k === 'status' || k === 'metadata' || k === 'error') continue;
        if (!skip.has(k)) {
          if (wroteStep) { toolAcc.chars += 1; toolAcc.bytes += 1; }
          wroteStep = true;
          measure(k, toolAcc);
          toolAcc.chars += 2;
          toolAcc.bytes += 2;
          accumulateContent(s[k], toolAcc);
        }
        if (!skip.has(k) || k === 'media') {
          collectAttachments(s[k], 'assistant', withinToolStep);
        }
      }
      if (toolAcc.chars > 0 || toolAcc.bytes > 0) {
        const middle = (toolAcc.chars - toolAcc.cjk) / 4 + toolAcc.cjk * 1.2;
        addGroup(groups.tools, {
          chars: toolAcc.chars,
          bytes: toolAcc.bytes,
          low: Math.ceil(middle * 0.7),
          high: Math.ceil(Math.max(middle * 1.6, toolAcc.bytes / 2))
        });
      }
    }
  }

  const totalTextGroup = Object.values(groups).reduce(addGroup, emptyGroup());
  const budget = getContextLimitForModel(activeModelId, options.preferredModelLabel, { runtimeBudget: observedBudget });
  const preciseUsed = hasPreciseUsage ? (latestInput + latestCacheRead + latestOutput) : null;
  const totalInputWithCache = latestInput + latestCacheRead;
  const cacheHitRate = totalInputWithCache > 0 ? Number(((latestCacheRead / totalInputWithCache) * 100).toFixed(1)) : 0;

  const warnThreshold = resolveThresholdTokens(options.warnThreshold ?? options.warnThresholdTokens, budget, 240000);
  const cliffThreshold = resolveThresholdTokens(options.cliffThreshold ?? options.cliffThresholdTokens, budget, 328000);
  const effectiveUsed = preciseUsed ?? totalTextGroup.high;

  const cacheDropDetected = Boolean(
    hasPreciseUsage &&
    totalInputWithCache >= 150000 &&
    cacheHitRate < 25 &&
    (maxPriorCacheRead >= 50000 || latestInput >= warnThreshold)
  );
  const cacheCliffRisk = effectiveUsed >= cliffThreshold ? 'critical' : (effectiveUsed >= warnThreshold ? 'warn' : 'none');

  return {
    groups,
    total: totalTextGroup,
    media: Array.from(media.values()),
    steps: list.length,
    userMessages,
    assistantMessages,
    preciseUsed,
    budget,
    inputTokens: latestInput,
    cacheReadTokens: latestCacheRead,
    outputTokens: latestOutput,
    cacheHitRate,
    hasPreciseUsage,
    cacheDropDetected,
    cacheCliffRisk,
    compressionDetected,
    compressionBefore,
    compressionAfter,
    compressionDrop,
    modelId: activeModelId
  };
}

function extractCallId(row, cascadeId = null, fallbackStepIndex = null) {
  if (!row || typeof row !== 'object') return '';
  const u = row.chatModel?.usage || row.usage || {};
  const explicit =
    u.responseId ||
    u.response_id ||
    row.response_id ||
    row.responseId ||
    u.messageId ||
    u.message_id ||
    row.message_id ||
    row.messageId ||
    row.callId ||
    row.call_id ||
    '';
  if (explicit) return String(explicit);
  const stepIdx = row.stepIndices?.[0] ?? row.stepIndex ?? row.step_index ?? fallbackStepIndex;
  if (cascadeId && stepIdx !== null && stepIdx !== undefined) {
    return `${cascadeId}#${stepIdx}`;
  }
  return '';
}

function formatLocalDateStr(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function extractStepTimestampsFromTrajectory(steps = []) {
  const map = new Map();
  const list = Array.isArray(steps) ? steps : [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s || typeof s !== 'object') continue;
    const rawStep = s.stepIndex ?? s.step_index ?? s.metadata?.stepIndex ?? i;
    const parsedStep = Number(rawStep);
    if (!Number.isInteger(parsedStep) || parsedStep < 0) continue;
    const ts = parseTimestampMs(
      s.metadata?.createdAt ||
      s.metadata?.timestamp ||
      s.createdAt ||
      s.created_at ||
      s.timestamp ||
      s.plannerResponse?.createdAt ||
      s.userInput?.createdAt
    );
    if (ts > 0 && !map.has(parsedStep)) {
      map.set(parsedStep, ts);
    }
  }
  return map;
}

function resolveTimestampFromStepMap(stepIndex, stepTimestamps) {
  if (!stepTimestamps) return 0;
  if (typeof stepTimestamps.resolve === 'function') {
    return Number(stepTimestamps.resolve(stepIndex)) || 0;
  }
  if (!(stepTimestamps instanceof Map) || stepTimestamps.size === 0) return 0;
  const hasValidStep = Number.isInteger(stepIndex) && stepIndex >= 0;
  if (hasValidStep && stepTimestamps.has(stepIndex)) {
    return Number(stepTimestamps.get(stepIndex)) || 0;
  }
  let bestStep = -1;
  let bestTs = 0;
  let earliestStep = Infinity;
  let earliestTs = 0;
  for (const [s, ts] of stepTimestamps.entries()) {
    if (!Number.isFinite(ts) || ts <= 946684800000) continue;
    if (s < earliestStep) {
      earliestStep = s;
      earliestTs = ts;
    }
    if (hasValidStep && s <= stepIndex && s > bestStep) {
      bestStep = s;
      bestTs = ts;
    }
  }
  if (bestTs > 0) return bestTs;
  return earliestTs > 0 ? earliestTs : 0;
}

function parseGeneratorCall(row, cascadeId = null, source = 'desktop', fallbackIndex = 0, options = {}) {
  if (!row || typeof row !== 'object') return null;
  const cm = row.chatModel || {};
  const u = cm.usage || row.usage || {};
  const model = cm.modelDisplayName || cm.responseModel || cm.model || row.model || row.modelId || '';
  const modelKey = normalizeModelId(model);

  const inputTokens = Number(u.inputTokens ?? row.inputTokens ?? row.input_tokens ?? 0);
  const cacheTokens = Number(u.cacheReadTokens ?? row.cacheTokens ?? row.cacheReadTokens ?? row.cache_read_tokens ?? 0);
  const outputTokens = Number(u.outputTokens ?? row.outputTokens ?? row.output_tokens ?? 0);
  const thinkingTokens = Number(u.thinkingOutputTokens ?? row.thinkingTokens ?? row.thinking_output_tokens ?? 0);
  const responseTokens = Number(u.responseOutputTokens ?? row.responseTokens ?? Math.max(0, outputTokens - thinkingTokens));
  const totalTokens = inputTokens + cacheTokens + outputTokens;

  const rawStepIdx = row.stepIndices?.[0] ?? row.stepIndex ?? row.step_index ?? fallbackIndex;
  const parsedIdx = rawStepIdx !== undefined && rawStepIdx !== null && rawStepIdx !== '' ? Number(rawStepIdx) : NaN;
  const stepIndex = Number.isInteger(parsedIdx) && parsedIdx >= 0 ? parsedIdx : null;

  const callId = extractCallId(row, cascadeId, stepIndex ?? fallbackIndex);
  if (!callId) return null;

  const hasExplicitFinish = Boolean(
    row.status === 'final' ||
    row.status === 'completed' ||
    cm.finishReason ||
    row.finishReason ||
    row.done === true ||
    (cm.streamingDuration != null && cm.timeToFirstToken != null)
  );
  const status = hasExplicitFinish || (totalTokens > 0 && !row.isStreaming && row.status !== 'streaming')
    ? 'final'
    : 'streaming';
  const isEstimated = totalTokens <= 0 || outputTokens === 0;

  const rawCreatedAt = row.created_at || row.createdAt || row.timestamp || cm.chatStartMetadata?.createdAt || cm.createdAt;
  let timestamp = parseTimestampMs(rawCreatedAt);
  let date = null;
  let dateIsProvisional = false;
  if (timestamp > 0) {
    date = formatLocalDateStr(new Date(timestamp));
  } else {
    const stepTs = resolveTimestampFromStepMap(stepIndex, options?.stepTimestamps);
    const fallbackMs = Number(options?.fallbackTimestampMs) || 0;
    if (stepTs > 0) {
      timestamp = stepTs;
      date = formatLocalDateStr(new Date(timestamp));
      dateIsProvisional = false;
    } else if (row.date && /^\d{4}-\d{2}-\d{2}/.test(String(row.date))) {
      date = String(row.date).slice(0, 10);
      timestamp = Date.parse(date);
      dateIsProvisional = Boolean(row.dateIsProvisional);
    } else if (Number.isFinite(fallbackMs) && fallbackMs > 946684800000) {
      timestamp = fallbackMs;
      date = formatLocalDateStr(new Date(timestamp));
      dateIsProvisional = true;
    } else {
      timestamp = Date.now();
      date = formatLocalDateStr(new Date(timestamp));
      dateIsProvisional = true;
    }
  }

  const ttftSec = parseDurationSec(cm.timeToFirstToken) ?? safeNum(row.ttftSec);
  const streamingSec = parseDurationSec(cm.streamingDuration) ?? safeNum(row.streamingSec);
  const durationSec = (ttftSec !== null && streamingSec !== null)
    ? Number((ttftSec + streamingSec).toFixed(2))
    : (ttftSec ?? streamingSec ?? safeNum(row.durationSec));
  const tps = (status === 'final' && !isEstimated && outputTokens > 0 && durationSec && durationSec > 0)
    ? Number((outputTokens / durationSec).toFixed(1))
    : null;

  return {
    callId,
    source,
    cascadeId,
    stepIndex,
    model,
    modelKey,
    inputTokens,
    cacheTokens,
    cacheReadTokens: cacheTokens,
    outputTokens,
    thinkingTokens,
    responseTokens,
    totalTokens,
    status,
    isEstimated,
    date,
    dateIsProvisional,
    timestamp,
    ttftSec,
    streamingSec,
    durationSec,
    tps
  };
}

function summarizeSessionGeneratorCalls(gmRows, options = {}) {
  const rows = Array.isArray(gmRows) ? gmRows : [];
  const cascadeId = options.cascadeId || null;
  const deduped = [];
  const byCallId = new Map();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    const cm = row.chatModel || {};
    const u = cm.usage || row.usage || {};
    const modelRaw = String(cm.model || cm.modelOrAlias?.model || cm.responseModel || cm.modelDisplayName || row.model || row.modelId || '').trim();
    if (isShadowOrImageModel(modelRaw)) continue;

    const inputTokens = Math.max(0, Number(u.inputTokens ?? row.inputTokens ?? row.input_tokens ?? 0) || 0);
    const cachedTokens = Math.max(0, Number(u.cacheReadTokens ?? row.cacheTokens ?? row.cacheReadTokens ?? row.cache_read_tokens ?? 0) || 0);
    const outputTokens = Math.max(0, Number(u.outputTokens ?? row.outputTokens ?? row.output_tokens ?? 0) || 0);
    const thinkingTokens = Math.max(0, Number(u.thinkingOutputTokens ?? row.thinkingTokens ?? row.thinking_output_tokens ?? 0) || 0);
    const rawResponseTokens = u.responseOutputTokens ?? row.responseTokens;
    const responseTokens = rawResponseTokens !== undefined && rawResponseTokens !== null
      ? Math.max(0, Number(rawResponseTokens) || 0)
      : Math.max(0, outputTokens - thinkingTokens);

    if (inputTokens + cachedTokens + outputTokens <= 0) continue;

    const ttftSec = parseDurationSec(cm.timeToFirstToken) ?? safeNum(row.ttftSec);
    const streamingSec = parseDurationSec(cm.streamingDuration) ?? safeNum(row.streamingSec);
    const durationSec = (ttftSec !== null && streamingSec !== null)
      ? (ttftSec + streamingSec)
      : (ttftSec ?? streamingSec ?? safeNum(row.durationSec));

    const entry = {
      inputTokens,
      cachedTokens,
      outputTokens,
      thinkingTokens,
      responseTokens,
      ttftSec,
      streamingSec,
      durationSec
    };

    const explicitId = String(
      u.responseId || u.response_id || row.response_id || row.responseId
      || u.messageId || u.message_id || row.message_id || row.messageId
      || row.callId || row.call_id || ''
    );
    const callKey = explicitId || extractCallId(row, cascadeId, i);
    if (callKey) {
      if (byCallId.has(callKey)) {
        deduped[byCallId.get(callKey)] = entry;
      } else {
        byCallId.set(callKey, deduped.length);
        deduped.push(entry);
      }
    } else {
      deduped.push(entry);
    }
  }

  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let responseTokens = 0;
  let timedOutput = 0;
  let timedDuration = 0;
  let streamOutput = 0;
  let streamDuration = 0;

  for (const c of deduped) {
    inputTokens += c.inputTokens;
    cachedTokens += c.cachedTokens;
    outputTokens += c.outputTokens;
    thinkingTokens += c.thinkingTokens;
    responseTokens += c.responseTokens;
    if (c.outputTokens > 0 && c.durationSec !== null && c.durationSec > 0) {
      timedOutput += c.outputTokens;
      timedDuration += c.durationSec;
    }
    if (c.outputTokens > 0 && c.streamingSec !== null && c.streamingSec > 0.05) {
      streamOutput += c.outputTokens;
      streamDuration += c.streamingSec;
    }
  }

  const totalInputTokens = inputTokens + cachedTokens;
  const totalTokens = totalInputTokens + outputTokens;

  return {
    callsCount: deduped.length,
    inputTokens,
    cachedTokens,
    totalInputTokens,
    outputTokens,
    thinkingTokens,
    responseTokens,
    totalTokens,
    avgTps: timedDuration > 0 ? Number((timedOutput / timedDuration).toFixed(1)) : null,
    avgStreamingTps: streamDuration > 0.05 ? Number((streamOutput / streamDuration).toFixed(1)) : null
  };
}

function getRingAccentToken(usagePercent, cacheAlert = {}) {
  if (cacheAlert.isCacheDrop || Number(usagePercent) >= 80) {
    return 'var(--ag-ring-danger, #ef4444)';
  }
  if (cacheAlert.isCliff328k || cacheAlert.isWarn240k || Number(usagePercent) >= 50) {
    return 'var(--ag-ring-warn, #f59e0b)';
  }
  return 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #71717a))';
}

module.exports = {
  COMPRESSION_MIN_DROP,
  DEFAULT_CONTEXT_LIMIT,
  GPT_OSS_LIMIT,
  CLAUDE_55_LIMIT,
  GEMINI_4_LIMIT,
  measure,
  parseTimestampMs,
  parseDurationSec,
  formatTokensShort,
  parseThresholdSpec,
  resolveThresholdTokens,
  formatThresholdLabel,
  normalizeModelId,
  getModelCandidateKeys,
  getContextLimitForModel,
  isShadowOrImageModel,
  classifyRequestError,
  summarizeMetadata,
  analyzeTrajectorySteps,
  extractStepTimestampsFromTrajectory,
  extractCallId,
  parseGeneratorCall,
  summarizeSessionGeneratorCalls,
  getRingAccentToken
};
