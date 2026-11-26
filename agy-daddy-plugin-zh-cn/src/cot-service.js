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
  hashCotKey,
  parseFileUriTarget,
  protectFileUrisForTranslation,
  restoreProtectedFileUris,
  parseThinkingSegments
} = require('./cot-utils');

const MAX_COT_CACHE_ENTRIES = 500;
const MAX_ACTIVE_JOBS = 64;
const COMPLETED_JOB_TTL_MS = 5 * 60 * 1000;

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
  const fetchFn = deps.fetch;
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
    const modelPart = mode === THINKING_TRANSLATION_MODES.CUSTOM_API ? String(model || DEFAULT_THINKING_API_MODEL) : 'mt';
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
    const targetLang = params.targetLang || cfg.lang || 'zh';
    if (targetLang === 'en') {
      return { ok: true, status: 'done', done: true, translatedText: rawText, delta: rawText, cursor: rawText.length, source: 'passthrough' };
    }
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

    const cacheKey = makeCacheKey(mode, targetLang, cfg.thinkingApiModel, rawText);
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
    const targetMeta = getLanguageMeta(targetLang);
    const jobId = `cot_${++seq}_${Date.now().toString(36)}`;
    const job = {
      id: jobId,
      cacheKey,
      mode,
      targetLang,
      source: mode === THINKING_TRANSLATION_MODES.CUSTOM_API ? 'custom_api' : 'free',
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

    const runner = mode === THINKING_TRANSLATION_MODES.CUSTOM_API
      ? runCustomApiStreamJob(job, rawText, targetMeta, cfg)
      : runFreeTranslationJob(job, rawText, targetMeta);

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

  async function testCustomEndpoint(override = {}) {
    const cfg = { ...getConfig(), ...(override && typeof override === 'object' ? override : {}) };
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
    dispose,
    getCacheSize: () => cache.size
  };
}

module.exports = {
  splitChunksForMachineTranslation,
  buildCotSystemPrompt,
  findAntigravityCliCandidates,
  resolveAntigravityCliBinary,
  openFileInHost,
  createCotTranslationManager
};
