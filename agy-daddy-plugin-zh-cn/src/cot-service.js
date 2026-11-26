'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  THINKING_TRANSLATION_MODES,
  DEFAULT_THINKING_API_MODEL,
  normalizeThinkingTranslationMode,
  normalizeApiBaseUrl,
  resolveEffectiveCotTargetLang,
  hashCotKey,
  parseFileUriTarget,
  protectFileUrisForTranslation,
  restoreProtectedFileUris,
  parseThinkingSegments
} = require('./cot-utils');

const MAX_COT_CACHE_ENTRIES = 500;
const MAX_ACTIVE_JOBS = 64;
const COMPLETED_JOB_TTL_MS = 5 * 60 * 1000;

const DEFAULT_ANTIGRAVITY_FALLBACK_MODELS = Object.freeze([
  { model: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite' },
  { model: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { model: 'gemini-4-argon', label: 'Gemini 4 Argon' }
]);

function scoreAntigravityModelCandidate(entry, isPreferred = false) {
  if (isPreferred) return -100;
  const mid = String(entry?.modelId || '').toLowerCase();
  const label = String(entry?.label || '').toLowerCase();
  const model = String(entry?.model || '').toLowerCase();
  const text = `${mid} ${label} ${model}`;
  const remaining = entry?.remainingFraction;
  const exhaustedPenalty = (typeof remaining === 'number' && Number.isFinite(remaining) && remaining <= 0) ? 200 : 0;

  let baseScore = 50;
  if (text.includes('orchestrator')) baseScore = 90;
  else if (text.includes('flash')) {
    if (text.includes('low') || text.includes('lite')) baseScore = 10;
    else if (text.includes('medium')) baseScore = 15;
    else baseScore = 18;
  } else if (text.includes('argon')) baseScore = 20;
  else if (/\b(?:haiku|mini|lite)\b|gpt[-_]oss/i.test(text)) baseScore = 22;
  else if (/\blow\b|\(low\)|-low\b|_low\b/.test(text)) baseScore = 26;
  else if (/\bmedium\b|\(medium\)|-medium\b|_medium\b/.test(text)) baseScore = 36;
  else if (/\bhigh\b|\(high\)|-high\b|_high\b/.test(text)) baseScore = 62;

  return baseScore + exhaustedPenalty;
}

function collectAntigravityModelsFromStatus(cfgData) {
  if (!cfgData || typeof cfgData !== 'object') return [];
  const configs = Array.isArray(cfgData.clientModelConfigs) ? cfgData.clientModelConfigs : [];
  const out = [];
  const seen = new Set();
  for (const c of configs) {
    const model = String(c?.modelOrAlias?.model || c?.model || c?.modelId || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push({
      model,
      modelId: String(c?.modelId || '').trim(),
      label: String(c?.label || c?.displayName || c?.modelId || model).trim(),
      remainingFraction: typeof c?.quotaInfo?.remainingFraction === 'number' ? c.quotaInfo.remainingFraction : null
    });
  }
  return out;
}

function collectAntigravityModelsFromAvailable(rawModels) {
  const list = Array.isArray(rawModels)
    ? rawModels
    : Object.entries(rawModels || {}).map(([id, m]) => ({ model: m?.model || m?.modelId || id, ...(m || {}) }));
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || raw.disabled === true) continue;
    const model = String(raw.model || raw.modelId || raw.id || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push({
      model,
      modelId: String(raw.modelId || '').trim(),
      label: String(raw.displayName || raw.label || model).trim(),
      remainingFraction: typeof raw.remainingFraction === 'number' ? raw.remainingFraction : null
    });
  }
  return out;
}

function splitChunksForMachineTranslation(text, maxLen = 1400) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  if (raw.length <= maxLen) return [raw];
  const segments = parseThinkingSegments(raw, maxLen);
  const chunks = [];
  let buf = '';
  for (const seg of segments) {
    if (seg.length > maxLen) {
      if (buf) {
        chunks.push(buf);
        buf = '';
      }
      for (let i = 0; i < seg.length; i += maxLen) {
        chunks.push(seg.slice(i, i + maxLen));
      }
      continue;
    }
    const candidate = buf ? `${buf}\n\n${seg}` : seg;
    if (candidate.length > maxLen && buf) {
      chunks.push(buf);
      buf = seg;
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function buildCotSystemPrompt(targetLangLabel) {
  return [
    `You are a concise, accurate technical translator. Translate the user's Chain-of-Thought reasoning text into ${targetLangLabel}.`,
    'Rules:',
    '1. Output ONLY the translated text — no greetings, explanations, or surrounding markdown code fences.',
    '2. Preserve all file:// URIs, #L line references, filesystem paths, symbol/function/variable names, CLI commands, and Markdown formatting verbatim.',
    '3. Keep technical terms natural and accurate in the target language.'
  ].join('\n');
}

function buildAntigravityTranslatePrompt(rawText, targetLangLabel) {
  return [
    buildCotSystemPrompt(targetLangLabel),
    '',
    '<thinking_text>',
    rawText,
    '</thinking_text>'
  ].join('\n');
}

function cleanAntigravityTranslateOutput(rawOutput) {
  let out = String(rawOutput || '').replace(/\r\n?/g, '\n').trim();
  out = out.replace(/^<thinking_text>\s*/i, '').replace(/\s*<\/thinking_text>$/i, '').trim();
  const fenceMatch = out.match(/^```(?:markdown|md|text|txt)?\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenceMatch) {
    out = fenceMatch[1].trim();
  }
  return out;
}

function findAntigravityCliCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const home = options.homeDir || os.homedir();
  const candidates = [];

  if (env.AGY_DADDY_ANTIGRAVITY_CLI) {
    candidates.push(env.AGY_DADDY_ANTIGRAVITY_CLI);
  }
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity',
      path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'bin', 'antigravity'),
      '/usr/local/bin/antigravity',
      '/opt/homebrew/bin/antigravity'
    );
  } else if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.win32.join(localAppData, 'Programs', 'Antigravity', 'bin', 'antigravity.cmd'),
      path.win32.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      path.win32.join(programFiles, 'Antigravity', 'bin', 'antigravity.cmd'),
      path.win32.join(programFiles, 'Antigravity', 'Antigravity.exe')
    );
  } else {
    candidates.push(
      '/usr/bin/antigravity',
      '/usr/local/bin/antigravity',
      '/opt/antigravity/bin/antigravity',
      path.posix.join(home, '.local', 'bin', 'antigravity')
    );
  }
  return candidates;
}

function resolveAntigravityCliBinary(options = {}) {
  const fsImpl = options.fs || fs;
  for (const cand of findAntigravityCliCandidates(options)) {
    try {
      if (cand && fsImpl.existsSync(cand)) return cand;
    } catch {}
  }
  return null;
}

async function openFileInHost(input = {}, options = {}) {
  const rawTarget = typeof input === 'string'
    ? input
    : (input.uri || input.path || '');
  let parsed = parseFileUriTarget(rawTarget);
  if (!parsed.ok && typeof input?.path === 'string' && input.path.trim()) {
    const rawPath = input.path.trim();
    const lineNum = Number.isInteger(Number(input.line)) && Number(input.line) >= 1 ? Number(input.line) : 1;
    const normSlash = rawPath.replace(/\\/g, '/');
    const syntheticUri = `file://${normSlash.startsWith('/') ? '' : '/'}${normSlash}#L${lineNum}`;
    parsed = parseFileUriTarget(syntheticUri);
  }
  if (!parsed.ok) {
    return { ok: false, error: parsed.error || 'INVALID_FILE_TARGET' };
  }

  const line = Number.isInteger(Number(input?.line)) && Number(input.line) >= 1
    ? Number(input.line)
    : parsed.line;
  const endLine = Number.isInteger(Number(input?.endLine)) && Number(input.endLine) >= line
    ? Number(input.endLine)
    : parsed.endLine;
  const gotoArg = `${parsed.path}:${line}`;

  if (typeof options.openFileImpl === 'function') {
    const customRes = await options.openFileImpl({
      ...parsed,
      line,
      endLine,
      gotoArg
    });
    return {
      ok: customRes?.ok !== false,
      method: customRes?.method || 'custom',
      path: parsed.path,
      line,
      endLine,
      editorUri: parsed.editorUri,
      ...(customRes && typeof customRes === 'object' ? customRes : {})
    };
  }

  const isTestEnv = process.env.AGY_DADDY_TEST_MODE === '1' || Boolean(process.env.NODE_TEST_CONTEXT);
  const cliBin = isTestEnv ? null : resolveAntigravityCliBinary(options);
  if (cliBin) {
    const spawnFn = options.spawn || spawn;
    try {
      const child = spawnFn(cliBin, ['--reuse-window', '--goto', gotoArg], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child?.unref?.();
      return {
        ok: true,
        method: 'cli-goto',
        executable: cliBin,
        path: parsed.path,
        line,
        endLine,
        editorUri: parsed.editorUri
      };
    } catch {}
  }

  return {
    ok: true,
    method: 'uri-fallback',
    path: parsed.path,
    line,
    endLine,
    editorUri: parsed.editorUri
  };
}

function createCotTranslationManager(deps = {}) {
  const getConfig = deps.getConfig;
  const getLanguageMeta = deps.getLanguageMeta;
  const normalizeLang = deps.normalizeLang;
  const fetchFn = deps.fetch;
  const rpc = deps.rpc || null;
  const services = deps.services || null;
  const storage = deps.storage;
  const cacheFile = deps.cacheFile || 'zh-cot-translation-cache.json';

  const rawDisk = storage?.readJson?.(cacheFile, {})?.data;
  const cache = new Map();
  if (rawDisk && typeof rawDisk === 'object' && !Array.isArray(rawDisk)) {
    for (const [k, v] of Object.entries(rawDisk)) {
      if (typeof v === 'string' && v) cache.set(k, v);
    }
  }

  const jobs = new Map();
  const dedupeMap = new Map();
  let modelCache = { candidates: [], fetchedAt: 0 };
  let seq = 0;
  let disposed = false;

  function persistCache() {
    if (!storage?.writeJson) return;
    while (cache.size > MAX_COT_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    const obj = {};
    for (const [k, v] of cache.entries()) obj[k] = v;
    storage.writeJson(cacheFile, obj);
  }

  function makeCacheKey(mode, targetLang, model, text) {
    let modelPart = 'mt';
    if (mode === THINKING_TRANSLATION_MODES.CUSTOM_API) {
      modelPart = String(model || DEFAULT_THINKING_API_MODEL);
    } else if (mode === THINKING_TRANSLATION_MODES.ANTIGRAVITY) {
      modelPart = String(model || 'auto');
    }
    return `${mode}::${targetLang}::${modelPart}::${hashCotKey(text)}`;
  }

  function notifyJobWaiters(job) {
    const waiters = job.waiters.splice(0, job.waiters.length);
    for (const wake of waiters) {
      try { wake(); } catch {}
    }
  }

  function pruneOldJobs() {
    const now = Date.now();
    for (const [id, job] of jobs.entries()) {
      if (job.done && (now - job.updatedAt) > COMPLETED_JOB_TTL_MS) {
        jobs.delete(id);
        if (dedupeMap.get(job.cacheKey) === id) dedupeMap.delete(job.cacheKey);
      }
    }
    while (jobs.size > MAX_ACTIVE_JOBS) {
      const firstId = jobs.keys().next().value;
      if (!firstId) break;
      const old = jobs.get(firstId);
      try { old?.abortController?.abort(); } catch {}
      jobs.delete(firstId);
      if (old && dedupeMap.get(old.cacheKey) === firstId) dedupeMap.delete(old.cacheKey);
    }
  }

  async function resolveAntigravityModels(opts = {}) {
    const cfg = getConfig();
    const preferred = String(opts.preferredModel !== undefined ? opts.preferredModel : (cfg.thinkingAntigravityModel || '')).trim();
    let list = [];
    if (!opts.forceRefresh && modelCache.candidates.length > 0 && (Date.now() - modelCache.fetchedAt) < 60000) {
      list = modelCache.candidates;
    }

    if (list.length === 0 && rpc && typeof rpc.call === 'function') {
      try {
        const userStatus = await rpc.call('GetUserStatus', {}, { timeoutMs: 8000 });
        const cfgData = userStatus?.userStatus?.cascadeModelConfigData || userStatus?.cascadeModelConfigData || null;
        const fromStatus = collectAntigravityModelsFromStatus(cfgData);
        if (fromStatus.length > 0) list = fromStatus;
      } catch {}

      if (list.length === 0) {
        try {
          const res = await rpc.call('GetAvailableModels', { forceRefresh: false }, { timeoutMs: 8000 });
          const rawModels = res?.response?.models || res?.models || [];
          const fromAvail = collectAntigravityModelsFromAvailable(rawModels);
          if (fromAvail.length > 0) list = fromAvail;
        } catch {}
      }

      if (list.length > 0) {
        modelCache = { candidates: list, fetchedAt: Date.now() };
      }
    }

    let quotaSnap = null;
    if (services && typeof services.call === 'function') {
      try {
        const qRes = await services.call('quota', 'getSnapshot', [], { optional: true });
        if (qRes?.ok) quotaSnap = qRes.value;
      } catch {}
    }
    const geminiExhausted = quotaSnap?.gemini?.isExhausted === true || quotaSnap?.gemini?.remainingFraction === 0;
    const claudeExhausted = quotaSnap?.claude?.isExhausted === true || quotaSnap?.claude?.remainingFraction === 0;

    const byModel = new Map();
    for (const item of list) {
      const lower = item.model.toLowerCase();
      const is3p = lower.includes('claude') || lower.includes('gpt-oss');
      if (item.model !== preferred) {
        if (is3p && claudeExhausted) continue;
        if (!is3p && geminiExhausted) continue;
      }
      byModel.set(item.model, {
        ...item,
        score: scoreAntigravityModelCandidate(item, item.model === preferred)
      });
    }
    if (preferred && !byModel.has(preferred)) {
      byModel.set(preferred, {
        model: preferred,
        modelId: preferred,
        label: preferred,
        remainingFraction: null,
        score: -100
      });
    }
    const sorted = Array.from(byModel.values()).sort((a, b) => a.score - b.score || a.model.localeCompare(b.model));
    if (sorted.length === 0) {
      return DEFAULT_ANTIGRAVITY_FALLBACK_MODELS.map((m) => ({
        ...m,
        modelId: m.model,
        remainingFraction: null,
        score: scoreAntigravityModelCandidate(m, m.model === preferred)
      }));
    }
    return sorted;
  }

  async function listAntigravityModelOptions(opts = {}) {
    const out = [
      {
        value: '',
        label: '自动选择轻量快速模型（推荐）',
        description: 'Auto-select fast Antigravity model'
      }
    ];
    const seen = new Set(['']);
    const models = await resolveAntigravityModels({ ...opts, forceRefresh: true });
    for (const m of models) {
      if (!m?.model || seen.has(m.model)) continue;
      seen.add(m.model);
      out.push({
        value: m.model,
        label: m.label || m.model,
        description: m.label && m.label !== m.model ? m.model : ''
      });
    }
    return { ok: true, options: out };
  }

  async function runFreeTranslationJob(job, rawText, targetMeta) {
    const { maskedText, tokens } = protectFileUrisForTranslation(rawText);
    const chunks = splitChunksForMachineTranslation(maskedText, 1400);
    const parts = [];
    for (const chunk of chunks) {
      if (job.aborted || disposed) return;
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetMeta.googleTl)}&dt=t&q=${encodeURIComponent(chunk)}`;
      const resp = await fetchFn(url, { signal: job.abortController.signal });
      if (!resp || resp.ok === false) {
        throw new Error(`HTTP ${resp?.status || 'error'}`);
      }
      const data = await resp.json();
      const chunkTranslated = Array.isArray(data?.[0])
        ? data[0].map((seg) => (Array.isArray(seg) ? String(seg[0] || '') : '')).join('')
        : chunk;
      parts.push(restoreProtectedFileUris(chunkTranslated || chunk, tokens));
      job.translatedText = parts.join('\n\n');
      job.updatedAt = Date.now();
      notifyJobWaiters(job);
    }
    const finalText = restoreProtectedFileUris(parts.join('\n\n'), tokens).trim() || rawText;
    job.translatedText = finalText;
    job.done = true;
    job.status = 'done';
    job.updatedAt = Date.now();
    cache.delete(job.cacheKey);
    cache.set(job.cacheKey, finalText);
    persistCache();
    notifyJobWaiters(job);
  }

  async function runAntigravityRpcJob(job, rawText, targetMeta, config) {
    if (!rpc || typeof rpc.call !== 'function') {
      throw new Error('ANTIGRAVITY_RPC_UNAVAILABLE');
    }
    const candidates = await resolveAntigravityModels({ preferredModel: config.thinkingAntigravityModel });
    const prompt = buildAntigravityTranslatePrompt(rawText, `${targetMeta.nativeName} (${targetMeta.bcp47})`);
    const attempts = [];

    for (const cand of candidates.slice(0, 4)) {
      if (job.aborted || disposed) return;
      const modelEnum = String(cand?.model || '').trim();
      if (!modelEnum) continue;
      try {
        const resPayload = await rpc.call(
          'GetModelResponse',
          { prompt, model: modelEnum },
          { timeoutMs: 25000, retryOnTimeout: false }
        );
        if (job.aborted || disposed) return;
        const rawResp = resPayload?.response ?? resPayload?.text ?? '';
        const cleaned = cleanAntigravityTranslateOutput(rawResp);
        if (!cleaned) {
          const emptyErr = new Error('ANTIGRAVITY_EMPTY_RESPONSE');
          emptyErr.status = 200;
          throw emptyErr;
        }
        job.translatedText = cleaned;
        job.modelUsed = modelEnum;
        job.done = true;
        job.status = 'done';
        job.updatedAt = Date.now();
        cache.delete(job.cacheKey);
        cache.set(job.cacheKey, cleaned);
        persistCache();
        notifyJobWaiters(job);
        return;
      } catch (err) {
        const msg = String(err?.message || 'RPC_FAILED');
        const statusMatch = msg.match(/\bHTTP\s+(\d{3})\b/i);
        const status = Number(err?.status || (statusMatch ? statusMatch[1] : 0));
        attempts.push(`${modelEnum}: ${msg}`);
        if (status === 401 || status === 403) break;
      }
    }

    modelCache.fetchedAt = 0;
    throw new Error(attempts[attempts.length - 1] || 'ANTIGRAVITY_TRANSLATION_FAILED');
  }

  async function runCustomApiStreamJob(job, rawText, targetMeta, config) {
    const urlCheck = normalizeApiBaseUrl(config.thinkingApiBaseUrl);
    if (!urlCheck.ok) {
      throw new Error(urlCheck.error || 'INVALID_API_BASE_URL');
    }
    const model = String(config.thinkingApiModel || DEFAULT_THINKING_API_MODEL).trim() || DEFAULT_THINKING_API_MODEL;
    const headers = {
      'Content-Type': 'application/json'
    };
    const apiKey = String(config.thinkingApiKey || '').trim();
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const payload = {
      model,
      stream: true,
      temperature: 0.2,
      messages: [
        { role: 'system', content: buildCotSystemPrompt(`${targetMeta.nativeName} (${targetMeta.bcp47})`) },
        { role: 'user', content: rawText }
      ]
    };

    const resp = await fetchFn(urlCheck.chatCompletionsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: job.abortController.signal
    });

    if (!resp || resp.ok === false) {
      let detail = '';
      try {
        if (typeof resp?.text === 'function') detail = (await resp.text()).slice(0, 200);
      } catch {}
      throw new Error(`HTTP ${resp?.status || 'error'}${detail ? `: ${detail}` : ''}`);
    }

    const contentType = String(resp.headers?.get?.('content-type') || '').toLowerCase();
    const body = resp.body;

    // Non-streaming JSON fallback (e.g. mocks or servers ignoring stream=true)
    if (!body || contentType.includes('application/json')) {
      const json = typeof resp.json === 'function' ? await resp.json() : null;
      const content = json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text ?? '';
      const finalText = String(content || '').trim() || rawText;
      job.translatedText = finalText;
      job.done = true;
      job.status = 'done';
      job.updatedAt = Date.now();
      cache.delete(job.cacheKey);
      cache.set(job.cacheKey, finalText);
      persistCache();
      notifyJobWaiters(job);
      return;
    }

    const decoder = new TextDecoder('utf-8');
    let sseBuffer = '';

    const processSseLines = (textChunk) => {
      sseBuffer += textChunk;
      const lines = sseBuffer.split(/\r?\n/);
      sseBuffer = lines.pop() ?? '';
      let appended = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed?.choices?.[0]?.delta?.content
            ?? parsed?.choices?.[0]?.message?.content
            ?? parsed?.message?.content
            ?? '';
          if (typeof delta === 'string' && delta.length > 0) {
            job.translatedText += delta;
            appended = true;
          }
        } catch {}
      }
      if (appended) {
        job.updatedAt = Date.now();
        notifyJobWaiters(job);
      }
    };

    if (typeof body.getReader === 'function') {
      const reader = body.getReader();
      try {
        while (true) {
          if (job.aborted || disposed) break;
          const { value, done } = await reader.read();
          if (done) break;
          const str = typeof value === 'string'
            ? value
            : decoder.decode(value, { stream: true });
          processSseLines(str);
        }
      } finally {
        try { reader.releaseLock?.(); } catch {}
      }
    } else if (typeof body[Symbol.asyncIterator] === 'function') {
      for await (const value of body) {
        if (job.aborted || disposed) break;
        const str = typeof value === 'string'
          ? value
          : decoder.decode(value, { stream: true });
        processSseLines(str);
      }
    }

    const tail = decoder.decode();
    if (tail) processSseLines(tail);
    if (sseBuffer.trim()) processSseLines('\n');

    if (job.aborted || disposed) return;
    const finalText = job.translatedText.trim() || rawText;
    job.translatedText = finalText;
    job.done = true;
    job.status = 'done';
    job.updatedAt = Date.now();
    cache.delete(job.cacheKey);
    cache.set(job.cacheKey, finalText);
    persistCache();
    notifyJobWaiters(job);
  }

  function snapshotJob(job, cursor = 0) {
    const start = Math.max(0, Number(cursor) || 0);
    const fullText = job.translatedText || '';
    return {
      ok: !job.error,
      jobId: job.id,
      status: job.status,
      done: Boolean(job.done),
      source: job.source,
      ...(job.modelUsed ? { model: job.modelUsed } : {}),
      translatedText: fullText,
      delta: fullText.slice(start),
      cursor: fullText.length,
      ...(job.error ? { error: job.error } : {})
    };
  }

  async function startOrGetJob(params = {}) {
    if (disposed) {
      return { ok: false, error: 'SERVICE_DISPOSED', done: true };
    }
    const rawText = String(params.text || '').trim();
    if (!rawText) {
      return { ok: true, status: 'done', done: true, translatedText: '', delta: '', cursor: 0, source: 'empty' };
    }
    const cfg = getConfig();
    const effectiveTarget = params.targetLang !== undefined
      ? (typeof normalizeLang === 'function' ? normalizeLang(params.targetLang, cfg.lang || 'zh') : params.targetLang)
      : resolveEffectiveCotTargetLang(cfg, normalizeLang);
    const mode = normalizeThinkingTranslationMode(
      params.mode !== undefined ? params.mode : cfg.thinkingTranslationMode,
      cfg.enableRemoteThinkingTranslation
    );
    if (mode === THINKING_TRANSLATION_MODES.OFF) {
      return {
        ok: false,
        blocked: true,
        reason: 'COT_TRANSLATION_DISABLED',
        done: true,
        translatedText: rawText
      };
    }

    const activeModel = mode === THINKING_TRANSLATION_MODES.CUSTOM_API
      ? cfg.thinkingApiModel
      : (mode === THINKING_TRANSLATION_MODES.ANTIGRAVITY ? (cfg.thinkingAntigravityModel || 'auto') : 'mt');
    const cacheKey = makeCacheKey(mode, effectiveTarget, activeModel, rawText);
    if (!params.force && cache.has(cacheKey)) {
      const hit = cache.get(cacheKey);
      cache.delete(cacheKey);
      cache.set(cacheKey, hit);
      return {
        ok: true,
        status: 'done',
        done: true,
        source: 'cache',
        translatedText: hit,
        delta: hit,
        cursor: hit.length
      };
    }

    const existingId = dedupeMap.get(cacheKey);
    if (!params.force && existingId && jobs.has(existingId)) {
      const existing = jobs.get(existingId);
      if (!existing.error) {
        return snapshotJob(existing, params.cursor || 0);
      }
    }

    pruneOldJobs();
    const targetMeta = getLanguageMeta(effectiveTarget);
    const jobId = `cot_${++seq}_${Date.now().toString(36)}`;
    let source = 'free';
    if (mode === THINKING_TRANSLATION_MODES.CUSTOM_API) source = 'custom_api';
    else if (mode === THINKING_TRANSLATION_MODES.ANTIGRAVITY) source = 'antigravity';

    const job = {
      id: jobId,
      cacheKey,
      mode,
      targetLang: effectiveTarget,
      source,
      status: 'streaming',
      done: false,
      aborted: false,
      error: null,
      translatedText: '',
      waiters: [],
      updatedAt: Date.now(),
      abortController: typeof AbortController === 'function' ? new AbortController() : { abort() {}, signal: undefined }
    };
    jobs.set(jobId, job);
    dedupeMap.set(cacheKey, jobId);

    let runner;
    if (mode === THINKING_TRANSLATION_MODES.CUSTOM_API) {
      runner = runCustomApiStreamJob(job, rawText, targetMeta, cfg);
    } else if (mode === THINKING_TRANSLATION_MODES.ANTIGRAVITY) {
      runner = runAntigravityRpcJob(job, rawText, targetMeta, cfg);
    } else {
      runner = runFreeTranslationJob(job, rawText, targetMeta);
    }

    void runner.catch((err) => {
      if (job.aborted || disposed) return;
      job.error = err?.message || String(err);
      job.status = 'error';
      job.done = true;
      job.updatedAt = Date.now();
      if (dedupeMap.get(cacheKey) === jobId) dedupeMap.delete(cacheKey);
      notifyJobWaiters(job);
    });

    const initialWait = Math.min(250, Math.max(0, Number(params.initialWaitMs ?? 120) || 0));
    if (initialWait > 0 && !job.done) {
      await new Promise((resolve) => {
        let timer = null;
        const doneWait = () => {
          if (timer) clearTimeout(timer);
          resolve();
        };
        job.waiters.push(doneWait);
        timer = setTimeout(() => {
          const idx = job.waiters.indexOf(doneWait);
          if (idx >= 0) job.waiters.splice(idx, 1);
          resolve();
        }, initialWait);
      });
    }

    return snapshotJob(job, params.cursor || 0);
  }

  async function pollJob(params = {}) {
    const jobId = String(params.jobId || '').trim();
    const cursor = Math.max(0, Number(params.cursor) || 0);
    const waitMs = Math.min(2000, Math.max(0, Number(params.waitMs ?? 300) || 0));
    const job = jobs.get(jobId);
    if (!job) {
      return { ok: false, error: 'JOB_NOT_FOUND', done: true };
    }
    if (job.done || job.translatedText.length > cursor || waitMs === 0) {
      return snapshotJob(job, cursor);
    }
    await new Promise((resolve) => {
      let timer = null;
      const doneWait = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      job.waiters.push(doneWait);
      timer = setTimeout(() => {
        const idx = job.waiters.indexOf(doneWait);
        if (idx >= 0) job.waiters.splice(idx, 1);
        resolve();
      }, waitMs);
    });
    return snapshotJob(job, cursor);
  }

  function cancelJob(jobId) {
    const job = jobs.get(String(jobId || '').trim());
    if (!job) return { ok: false, cancelled: false };
    job.aborted = true;
    job.done = true;
    job.status = 'cancelled';
    try { job.abortController?.abort?.(); } catch {}
    if (dedupeMap.get(job.cacheKey) === job.id) dedupeMap.delete(job.cacheKey);
    notifyJobWaiters(job);
    return { ok: true, cancelled: true, jobId: job.id };
  }

  async function testAntigravityRpc(cfg) {
    if (!rpc || typeof rpc.call !== 'function') {
      return { ok: false, mode: 'antigravity', error: 'ANTIGRAVITY_RPC_UNAVAILABLE' };
    }
    const startedAt = Date.now();
    const candidates = await resolveAntigravityModels({
      preferredModel: cfg.thinkingAntigravityModel,
      forceRefresh: true
    });
    const first = candidates[0];
    if (!first?.model) {
      return { ok: false, mode: 'antigravity', error: 'NO_ANTIGRAVITY_MODELS' };
    }
    try {
      const resPayload = await rpc.call(
        'GetModelResponse',
        { prompt: 'Reply with OK.', model: first.model },
        { timeoutMs: 12000, retryOnTimeout: false }
      );
      const rawResp = String(resPayload?.response ?? resPayload?.text ?? '').trim();
      if (!rawResp) {
        return { ok: false, mode: 'antigravity', model: first.model, error: 'ANTIGRAVITY_EMPTY_RESPONSE' };
      }
      return {
        ok: true,
        mode: 'antigravity',
        model: first.model,
        latencyMs: Date.now() - startedAt
      };
    } catch (err) {
      return {
        ok: false,
        mode: 'antigravity',
        model: first.model,
        error: err?.message || String(err)
      };
    }
  }

  async function testCustomEndpoint(override = {}) {
    const cfg = { ...getConfig(), ...(override && typeof override === 'object' ? override : {}) };
    const mode = normalizeThinkingTranslationMode(override.mode ?? cfg.thinkingTranslationMode, false);
    if (mode === THINKING_TRANSLATION_MODES.ANTIGRAVITY) {
      return await testAntigravityRpc(cfg);
    }
    const urlCheck = normalizeApiBaseUrl(cfg.thinkingApiBaseUrl);
    if (!urlCheck.ok) {
      return { ok: false, error: urlCheck.error || 'INVALID_API_BASE_URL' };
    }
    const model = String(cfg.thinkingApiModel || DEFAULT_THINKING_API_MODEL).trim() || DEFAULT_THINKING_API_MODEL;
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = String(cfg.thinkingApiKey || '').trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const startedAt = Date.now();
    try {
      const resp = await fetchFn(urlCheck.chatCompletionsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: 16,
          temperature: 0,
          messages: [{ role: 'user', content: 'Reply with OK.' }]
        })
      });
      if (!resp || resp.ok === false) {
        return {
          ok: false,
          status: resp?.status || 0,
          endpoint: urlCheck.chatCompletionsUrl,
          error: `HTTP ${resp?.status || 'error'}`
        };
      }
      return {
        ok: true,
        status: resp.status || 200,
        endpoint: urlCheck.chatCompletionsUrl,
        model,
        latencyMs: Date.now() - startedAt
      };
    } catch (err) {
      return {
        ok: false,
        endpoint: urlCheck.chatCompletionsUrl,
        error: err?.message || String(err)
      };
    }
  }

  function dispose() {
    disposed = true;
    for (const job of jobs.values()) {
      job.aborted = true;
      job.done = true;
      try { job.abortController?.abort?.(); } catch {}
      notifyJobWaiters(job);
    }
    jobs.clear();
    dedupeMap.clear();
  }

  return {
    startOrGetJob,
    pollJob,
    cancelJob,
    testCustomEndpoint,
    listAntigravityModelOptions,
    resolveAntigravityModels,
    dispose,
    getCacheSize: () => cache.size
  };
}

module.exports = {
  splitChunksForMachineTranslation,
  buildCotSystemPrompt,
  buildAntigravityTranslatePrompt,
  cleanAntigravityTranslateOutput,
  collectAntigravityModelsFromStatus,
  collectAntigravityModelsFromAvailable,
  findAntigravityCliCandidates,
  resolveAntigravityCliBinary,
  openFileInHost,
  createCotTranslationManager
};
