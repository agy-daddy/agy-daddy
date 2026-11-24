'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { LEDGER_VERSION, normalizeCallSource } = require('./pricing-ledger');

function formatLocalDateStr(dt) {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
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

function parseGeneratorCallRow(row, cascadeId = null, fallbackTimestampMs = 0, fallbackIndex = 0, source = 'desktop', stepTsIndex = null) {
  if (!row || typeof row !== 'object') return null;
  const cm = row.chatModel || {};
  const u = cm.usage || row.usage || {};
  const model = cm.modelDisplayName || cm.responseModel || cm.model || row.model || row.modelId || '';

  const inputTokens = Math.max(0, Number(u.inputTokens ?? row.inputTokens ?? row.input_tokens ?? 0) || 0);
  const cacheTokens = Math.max(0, Number(u.cacheReadTokens ?? row.cacheTokens ?? row.cacheReadTokens ?? row.cache_read_tokens ?? 0) || 0);
  const outputTokens = Math.max(0, Number(u.outputTokens ?? row.outputTokens ?? row.output_tokens ?? 0) || 0);
  const totalTokens = inputTokens + cacheTokens + outputTokens;
  if (totalTokens <= 0) return null;

  const rawStepIdx = row.stepIndices?.[0] ?? row.stepIndex ?? row.step_index ?? fallbackIndex;
  const parsedIdx = rawStepIdx !== undefined && rawStepIdx !== null && rawStepIdx !== '' ? Number(rawStepIdx) : NaN;
  const stepIndex = Number.isInteger(parsedIdx) && parsedIdx >= 0 ? parsedIdx : null;

  const callId = extractCallId(row, cascadeId, stepIndex ?? fallbackIndex);
  if (!callId) return null;

  const rawCreatedAt = row.created_at || row.createdAt || row.timestamp || cm.chatStartMetadata?.createdAt || cm.createdAt;
  let timestamp = parseTimestampMs(rawCreatedAt);
  let date = null;
  let dateIsProvisional = false;
  if (timestamp > 0) {
    date = formatLocalDateStr(new Date(timestamp));
  } else {
    const resolved = resolveStepTimestamp(stepIndex, stepTsIndex);
    if (resolved && resolved.timestamp > 0) {
      timestamp = resolved.timestamp;
      date = formatLocalDateStr(new Date(timestamp));
      dateIsProvisional = false;
    } else if (row.date && /^\d{4}-\d{2}-\d{2}/.test(String(row.date))) {
      date = String(row.date).slice(0, 10);
      timestamp = Date.parse(date) || 0;
      dateIsProvisional = Boolean(row.dateIsProvisional);
    } else if (Number.isFinite(Number(fallbackTimestampMs)) && Number(fallbackTimestampMs) > 946684800000) {
      timestamp = Number(fallbackTimestampMs);
      date = formatLocalDateStr(new Date(timestamp));
      dateIsProvisional = true;
    } else {
      timestamp = Date.now();
      date = formatLocalDateStr(new Date(timestamp));
      dateIsProvisional = true;
    }
  }

  return {
    callId,
    source: normalizeCallSource(source),
    apiProvider: u.apiProvider || row.apiProvider || '',
    cascadeId,
    stepIndex,
    model,
    inputTokens,
    cacheTokens,
    cacheReadTokens: cacheTokens,
    outputTokens,
    totalTokens,
    date,
    dateIsProvisional,
    timestamp
  };
}

function getDefaultConversationsDirs() {
  const home = os.homedir();
  return ['antigravity', 'antigravity-ide'].map((dir) => path.join(home, '.gemini', dir, 'conversations'));
}

function getDefaultCliConversationsDirs() {
  const home = os.homedir();
  return [path.join(home, '.gemini', 'antigravity-cli', 'conversations')];
}

function getDefaultIdeBrainDirs() {
  const home = os.homedir();
  return ['antigravity', 'antigravity-ide'].map((dir) => path.join(home, '.gemini', dir, 'brain'));
}

function getDefaultCliBrainDirs() {
  const home = os.homedir();
  return [path.join(home, '.gemini', 'antigravity-cli', 'brain')];
}

async function discoverConversationCandidates({
  rpc,
  conversationsDirs = null,
  cliConversationsDirs = null,
  skipDiskScan = false
} = {}) {
  const byId = new Map();

  const upsert = (cascadeId, mtimeMs, fallbackTimestampMs, sourceKind, sourceTag = 'desktop') => {
    if (!cascadeId) return;
    const prev = byId.get(cascadeId);
    const nextMtime = Number.isFinite(Number(mtimeMs)) ? Number(mtimeMs) : 0;
    const nextFallback = Number.isFinite(Number(fallbackTimestampMs)) ? Number(fallbackTimestampMs) : 0;
    if (!prev || nextMtime > prev.mtimeMs) {
      const preservedRpcFallback = prev?.hasRpcFallback ? prev.fallbackTimestampMs : 0;
      const chosenFallback = sourceKind === 'rpc'
        ? (nextFallback || preservedRpcFallback || prev?.fallbackTimestampMs || 0)
        : (preservedRpcFallback || nextFallback || prev?.fallbackTimestampMs || 0);
      byId.set(cascadeId, {
        cascadeId,
        mtimeMs: nextMtime,
        fallbackTimestampMs: chosenFallback,
        hasRpcFallback: Boolean(prev?.hasRpcFallback || (sourceKind === 'rpc' && nextFallback > 0)),
        source: prev ? `${prev.source}+${sourceKind}` : sourceKind,
        sourceTag: prev?.sourceTag === 'cli' || sourceTag === 'cli' ? 'cli' : 'desktop'
      });
    } else {
      if (sourceKind === 'rpc' && nextFallback > 0) {
        prev.fallbackTimestampMs = nextFallback;
        prev.hasRpcFallback = true;
      } else if (!prev.fallbackTimestampMs && nextFallback) {
        prev.fallbackTimestampMs = nextFallback;
      }
      if (sourceTag === 'cli') prev.sourceTag = 'cli';
    }
  };

  if (!skipDiskScan) {
    const scanConvDirList = (dirs, sourceTag) => {
      for (const dirPath of dirs) {
        let entries;
        try {
          entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const ent of entries) {
          if (ent.isFile && !ent.isFile()) continue;
          const name = ent.name || String(ent);
          if (!/\.(pb|db)$/i.test(name)) continue;
          const cascadeId = name.replace(/\.(pb|db)$/i, '');
          if (!cascadeId) continue;
          try {
            const stat = fs.statSync(path.join(dirPath, name));
            const mtimeMs = Number(stat.mtimeMs) || 0;
            upsert(cascadeId, mtimeMs, mtimeMs, `disk:${sourceTag}`, sourceTag);
          } catch {}
        }
      }
    };

    const ideDirs = Array.isArray(conversationsDirs) && conversationsDirs.length > 0
      ? conversationsDirs
      : getDefaultConversationsDirs();
    const cliDirs = Array.isArray(cliConversationsDirs) && cliConversationsDirs.length > 0
      ? cliConversationsDirs
      : getDefaultCliConversationsDirs();
    scanConvDirList(ideDirs, 'desktop');
    scanConvDirList(cliDirs, 'cli');
  }

  if (rpc && typeof rpc.call === 'function') {
    try {
      const allResp = await rpc.call('GetAllCascadeTrajectories', {
        metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
      });
      const summaries = allResp?.trajectorySummaries || {};
      for (const [cascadeId, meta] of Object.entries(summaries)) {
        const tsMod = parseTimestampMs(meta?.lastModifiedTime);
        const tsCreate = parseTimestampMs(meta?.createdTime);
        const ts = Math.max(tsMod, tsCreate);
        upsert(cascadeId, ts, tsCreate || tsMod, 'rpc', 'desktop');
      }
    } catch {}
  }

  const list = Array.from(byId.values());
  list.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return list;
}

const SKIP_BRAIN_DIRS = new Set(['steps', 'tasks', 'scratch', 'media', 'artifacts', 'node_modules', '.git', '__pycache__']);

function collectTranscriptFiles(brainDir, sourceTag, outList, visited, depth = 0) {
  if (!brainDir || depth > 3) return;
  let realDir;
  try {
    if (!fs.existsSync(brainDir)) return;
    realDir = fs.realpathSync(brainDir);
  } catch {
    return;
  }
  if (visited.has(realDir)) return;
  visited.add(realDir);

  let entries;
  try {
    entries = fs.readdirSync(realDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of entries) {
    if (SKIP_BRAIN_DIRS.has(ent.name)) continue;
    const fullPath = path.join(realDir, ent.name);
    if (ent.isDirectory()) {
      if (depth === 0) {
        const stdLog = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
        const directLog = path.join(fullPath, 'transcript.jsonl');
        let matched = false;
        if (fs.existsSync(stdLog)) {
          outList.push({ filePath: stdLog, cascadeId: ent.name, source: sourceTag });
          matched = true;
        }
        if (fs.existsSync(directLog)) {
          outList.push({ filePath: directLog, cascadeId: ent.name, source: sourceTag });
          matched = true;
        }
        if (matched) continue;
      }
      collectTranscriptFiles(fullPath, sourceTag, outList, visited, depth + 1);
    } else if (ent.isFile() && ent.name === 'transcript.jsonl') {
      const parentName = path.basename(realDir);
      outList.push({ filePath: fullPath, cascadeId: parentName, source: sourceTag });
    }
  }
}

function scanTranscriptBackfill({ brainEntries = [], ledger, cursor, shouldAbort = () => false } = {}) {
  const jobs = [];
  const visited = new Set();
  for (const entry of brainEntries) {
    if (!entry?.dir) continue;
    collectTranscriptFiles(entry.dir, entry.source === 'cli' ? 'cli' : 'desktop', jobs, visited, 0);
  }

  if (!cursor.transcripts || typeof cursor.transcripts !== 'object') {
    cursor.transcripts = {};
  }

  let scannedTranscripts = 0;
  let importedCalls = 0;
  let cursorDirty = false;

  for (const job of jobs) {
    if (shouldAbort()) break;
    let st;
    try {
      st = fs.statSync(job.filePath);
    } catch {
      continue;
    }
    const prev = cursor.transcripts[job.filePath];
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
      continue;
    }

    let content = '';
    try {
      content = fs.readFileSync(job.filePath, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    const parsedCalls = [];
    let lastModel = '';
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln || !ln.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(ln);
      } catch {
        continue;
      }
      if (!ev || typeof ev !== 'object') continue;
      const cm = ev.chatModel || {};
      const selectedModel = extractModelSelectionFromText(ev.content);
      const evModel = cm.modelDisplayName || cm.responseModel || cm.model || ev.model || ev.modelId || selectedModel || '';
      if (evModel) lastModel = String(evModel);

      const u = cm.usage || ev.usage || {};
      const inputTokens = Math.max(0, Number(ev.input_tokens ?? ev.inputTokens ?? u.inputTokens ?? 0) || 0);
      const cacheTokens = Math.max(0, Number(ev.cache_read_tokens ?? ev.cacheReadTokens ?? ev.cacheTokens ?? u.cacheReadTokens ?? 0) || 0);
      const outputTokens = Math.max(0, Number(ev.output_tokens ?? ev.outputTokens ?? u.outputTokens ?? 0) || 0);
      const totalTokens = inputTokens + cacheTokens + outputTokens;
      if (totalTokens <= 0) continue;

      const rawStep = ev.step_index ?? ev.stepIndex;
      const parsedStep = rawStep !== undefined && rawStep !== null && rawStep !== '' ? Number(rawStep) : NaN;
      const stepIndex = Number.isInteger(parsedStep) && parsedStep >= 0 ? parsedStep : null;
      const cascadeId = String(ev.cascadeId || job.cascadeId || path.basename(job.filePath));
      const callId = extractCallId(ev, cascadeId, stepIndex ?? i);
      if (!callId) continue;

      const rawCreatedAt = ev.created_at || ev.createdAt || ev.timestamp || cm.chatStartMetadata?.createdAt;
      let timestamp = parseTimestampMs(rawCreatedAt);
      let dateIsProvisional = false;
      if (timestamp <= 0) {
        timestamp = Number(st.mtimeMs) || Date.now();
        dateIsProvisional = true;
      }
      const date = formatLocalDateStr(new Date(timestamp));

      parsedCalls.push({
        callId,
        source: job.source,
        apiProvider: u.apiProvider || ev.apiProvider || '',
        cascadeId,
        stepIndex,
        model: String(evModel || lastModel || ''),
        inputTokens,
        cacheTokens,
        cacheReadTokens: cacheTokens,
        outputTokens,
        totalTokens,
        date,
        dateIsProvisional,
        timestamp
      });
    }

    if (parsedCalls.length > 0 && ledger && typeof ledger.recordCalls === 'function') {
      const recRes = ledger.recordCalls(parsedCalls);
      if (recRes?.ok) {
        importedCalls += (recRes.added || 0);
      }
    }

    cursor.transcripts[job.filePath] = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      scannedAt: Date.now()
    };
    cursorDirty = true;
    scannedTranscripts++;
  }

  return { scannedTranscripts, importedCalls, cursorDirty };
}

function extractModelSelectionFromText(text) {
  if (!text || typeof text !== 'string') return '';
  const m = text.match(/changed setting `Model Selection` from [^\n<]+? to ([^\n<]+?)(?:\.\s*No need|\.\s*<\/USER_SETTINGS_CHANGE>|\.\s*$|\n)/);
  if (!m || !m[1]) return '';
  const val = m[1].replace(/\.+$/, '').trim();
  if (!val || /^none$/i.test(val)) return '';
  return val;
}

function readTranscriptStepTimestamps(filePath) {
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const byStep = new Map();
  const modelChanges = [];
  let minTs = 0;
  let maxTs = 0;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln || !ln.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(ln);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    const rawStep = ev.step_index ?? ev.stepIndex;
    const parsedStep = rawStep !== undefined && rawStep !== null && rawStep !== '' ? Number(rawStep) : NaN;
    const validStep = Number.isInteger(parsedStep) && parsedStep >= 0 ? parsedStep : null;

    const cm = ev.chatModel || {};
    const stepModel = cm.modelDisplayName || cm.responseModel || cm.model || ev.model || ev.modelId || extractModelSelectionFromText(ev.content) || '';
    if (stepModel) {
      modelChanges.push({ step: validStep !== null ? validStep : i, model: String(stepModel) });
    }

    const ts = parseTimestampMs(
      ev.created_at ||
      ev.createdAt ||
      ev.timestamp ||
      cm.chatStartMetadata?.createdAt ||
      cm.createdAt
    );
    if (ts <= 0) continue;
    minTs = minTs > 0 ? Math.min(minTs, ts) : ts;
    maxTs = Math.max(maxTs, ts);
    if (validStep !== null && !byStep.has(validStep)) {
      byStep.set(validStep, ts);
    }
  }
  if (byStep.size === 0 && minTs <= 0 && modelChanges.length === 0) return null;
  const sortedSteps = Array.from(byStep.entries())
    .map(([step, ts]) => ({ step, ts }))
    .sort((a, b) => a.step - b.step);
  modelChanges.sort((a, b) => a.step - b.step);
  return { byStep, sortedSteps, minTs, maxTs, modelChanges };
}

function resolveStepModel(stepIndex, tsIndex) {
  if (!tsIndex || !Array.isArray(tsIndex.modelChanges) || tsIndex.modelChanges.length === 0) return '';
  const arr = tsIndex.modelChanges;
  if (!Number.isInteger(stepIndex) || stepIndex < 0) {
    return arr[0].model || '';
  }
  let lo = 0;
  let hi = arr.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].step <= stepIndex) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const chosen = best >= 0 ? arr[best] : arr[0];
  return chosen?.model || '';
}

function resolveStepTimestamp(stepIndex, tsIndex) {
  if (!tsIndex) return null;
  const hasValidStep = Number.isInteger(stepIndex) && stepIndex >= 0;
  if (hasValidStep && tsIndex.byStep instanceof Map && tsIndex.byStep.has(stepIndex)) {
    return { timestamp: tsIndex.byStep.get(stepIndex), exact: true };
  }
  if (hasValidStep && Array.isArray(tsIndex.sortedSteps) && tsIndex.sortedSteps.length > 0) {
    const arr = tsIndex.sortedSteps;
    let lo = 0;
    let hi = arr.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].step <= stepIndex) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const chosen = best >= 0 ? arr[best] : arr[0];
    if (chosen && chosen.ts > 0) {
      return { timestamp: chosen.ts, exact: false };
    }
  }
  if (tsIndex.minTs > 0) {
    return { timestamp: tsIndex.minTs, exact: false };
  }
  return null;
}

function createTranscriptTimestampResolver(brainEntries = []) {
  const jobs = [];
  const visited = new Set();
  for (const entry of Array.isArray(brainEntries) ? brainEntries : []) {
    if (!entry?.dir) continue;
    collectTranscriptFiles(entry.dir, entry.source === 'cli' ? 'cli' : 'desktop', jobs, visited, 0);
  }
  const filesByCascade = new Map();
  for (const job of jobs) {
    if (!job?.cascadeId || !job?.filePath) continue;
    if (!filesByCascade.has(job.cascadeId)) {
      filesByCascade.set(job.cascadeId, []);
    }
    filesByCascade.get(job.cascadeId).push(job.filePath);
  }
  const cache = new Map();
  return {
    get(cascadeId) {
      if (!cascadeId) return null;
      if (cache.has(cascadeId)) return cache.get(cascadeId);
      const paths = filesByCascade.get(cascadeId);
      if (!paths || paths.length === 0) {
        cache.set(cascadeId, null);
        return null;
      }
      let merged = null;
      for (const fp of paths) {
        const idx = readTranscriptStepTimestamps(fp);
        if (!idx) continue;
        if (!merged) {
          merged = idx;
        } else {
          for (const [s, t] of idx.byStep.entries()) {
            if (!merged.byStep.has(s)) merged.byStep.set(s, t);
          }
          if (idx.minTs > 0) {
            merged.minTs = merged.minTs > 0 ? Math.min(merged.minTs, idx.minTs) : idx.minTs;
          }
          merged.maxTs = Math.max(merged.maxTs, idx.maxTs);
          merged.sortedSteps = Array.from(merged.byStep.entries())
            .map(([step, ts]) => ({ step, ts }))
            .sort((a, b) => a.step - b.step);
          if (Array.isArray(idx.modelChanges) && idx.modelChanges.length > 0) {
            merged.modelChanges = [...(merged.modelChanges || []), ...idx.modelChanges].sort((a, b) => a.step - b.step);
          }
        }
      }
      cache.set(cascadeId, merged);
      return merged;
    }
  };
}

function buildDefaultBrainEntries(ideBrainDirs = null, cliBrainDirs = null) {
  const ideBrains = Array.isArray(ideBrainDirs) ? ideBrainDirs : getDefaultIdeBrainDirs();
  const cliBrains = Array.isArray(cliBrainDirs) ? cliBrainDirs : getDefaultCliBrainDirs();
  return [
    ...ideBrains.map((dir) => ({ dir, source: 'desktop' })),
    ...cliBrains.map((dir) => ({ dir, source: 'cli' }))
  ];
}

function resolveEarliestCallDate(calls = []) {
  let earliest = null;
  for (const c of Array.isArray(calls) ? calls : []) {
    let ds = null;
    if (c?.date && /^\d{4}-\d{2}-\d{2}/.test(String(c.date))) {
      ds = String(c.date).slice(0, 10);
    } else if (Number.isFinite(Number(c?.timestamp)) && Number(c.timestamp) > 946684800000) {
      ds = formatLocalDateStr(new Date(Number(c.timestamp)));
    }
    if (ds && (!earliest || ds < earliest)) {
      earliest = ds;
    }
  }
  return earliest;
}

async function runHistoryBackfill({
  rpc,
  ledger,
  storage,
  conversationsDirs = null,
  cliConversationsDirs = null,
  ideBrainDirs = null,
  cliBrainDirs = null,
  skipDiskScan = false,
  concurrency = 4,
  shouldAbort = () => false
} = {}) {
  const cursorRes = storage && typeof storage.readJson === 'function'
    ? storage.readJson('history-backfill-cursor.json', { version: 1, conversations: {}, transcripts: {} })
    : { data: { version: 1, conversations: {}, transcripts: {} } };
  const rawCursor = cursorRes?.data && typeof cursorRes.data === 'object' ? cursorRes.data : {};
  const cursor = {
    version: 1,
    conversations: rawCursor.conversations && typeof rawCursor.conversations === 'object'
      ? { ...rawCursor.conversations }
      : {},
    transcripts: rawCursor.transcripts && typeof rawCursor.transcripts === 'object'
      ? { ...rawCursor.transcripts }
      : {}
  };

  const candidates = await discoverConversationCandidates({
    rpc,
    conversationsDirs,
    cliConversationsDirs,
    skipDiskScan
  });
  const toScan = [];
  let skippedConversations = 0;

  for (const c of candidates) {
    const prev = cursor.conversations[c.cascadeId];
    if (prev && Number(prev.mtimeMs || 0) > 0 && Number(c.mtimeMs || 0) <= Number(prev.mtimeMs || 0)) {
      skippedConversations++;
      continue;
    }
    toScan.push(c);
  }

  const brainEntries = skipDiskScan ? [] : buildDefaultBrainEntries(ideBrainDirs, cliBrainDirs);
  const tsResolver = skipDiskScan ? null : createTranscriptTimestampResolver(brainEntries);

  let scannedConversations = 0;
  let importedCalls = 0;
  let cursorDirty = false;
  let rpcUnavailable = false;
  let nextIdx = 0;

  const workerCount = Math.max(1, Math.min(8, Number(concurrency) || 4));
  const runWorker = async () => {
    while (!rpcUnavailable && !shouldAbort()) {
      const idx = nextIdx++;
      if (idx >= toScan.length) return;
      const cand = toScan[idx];
      if (!rpc || typeof rpc.call !== 'function') {
        rpcUnavailable = true;
        return;
      }
      let gmResp = null;
      try {
        gmResp = await rpc.call('GetCascadeTrajectoryGeneratorMetadata', {
          cascadeId: cand.cascadeId,
          generatorMetadataOffset: 0,
          includeMessages: false
        });
      } catch (err) {
        const msg = String(err?.message || err || '');
        if (/Unable to resolve|ECONNREFUSED|RPC_PERMISSION_DENIED/i.test(msg)) {
          rpcUnavailable = true;
          return;
        }
        continue;
      }
      if (shouldAbort()) return;

      const rows = Array.isArray(gmResp?.generatorMetadata) ? gmResp.generatorMetadata : [];
      const stepTsIndex = tsResolver ? tsResolver.get(cand.cascadeId) : null;
      const parsedCalls = [];
      for (let i = 0; i < rows.length; i++) {
        const parsed = parseGeneratorCallRow(
          rows[i],
          cand.cascadeId,
          cand.fallbackTimestampMs || cand.mtimeMs || 0,
          i,
          cand.sourceTag || 'desktop',
          stepTsIndex
        );
        if (parsed) parsedCalls.push(parsed);
      }

      if (parsedCalls.length > 0 && ledger && typeof ledger.recordCalls === 'function') {
        const recRes = ledger.recordCalls(parsedCalls);
        if (recRes?.ok) {
          importedCalls += (recRes.added || 0);
        }
      }

      cursor.conversations[cand.cascadeId] = {
        mtimeMs: cand.mtimeMs || Date.now(),
        rowCount: rows.length,
        scannedAt: Date.now()
      };
      cursorDirty = true;
      scannedConversations++;
    }
  };

  if (toScan.length > 0) {
    const workers = [];
    for (let w = 0; w < Math.min(workerCount, toScan.length); w++) {
      workers.push(runWorker());
    }
    await Promise.all(workers);
  }

  let scannedTranscripts = 0;
  if (!skipDiskScan && !shouldAbort()) {
    const tRes = scanTranscriptBackfill({ brainEntries, ledger, cursor, shouldAbort });
    scannedTranscripts = tRes.scannedTranscripts;
    importedCalls += tRes.importedCalls;
    if (tRes.cursorDirty) cursorDirty = true;
  }

  if (cursorDirty && storage && typeof storage.writeJson === 'function') {
    storage.writeJson('history-backfill-cursor.json', cursor);
  }

  const allCalls = ledger && typeof ledger.getAllCalls === 'function' ? ledger.getAllCalls() : [];
  const earliestDate = resolveEarliestCallDate(allCalls);

  return {
    ok: !rpcUnavailable || scannedTranscripts > 0,
    rpcUnavailable,
    totalConversations: candidates.length,
    scannedConversations,
    skippedConversations,
    scannedTranscripts,
    importedCalls,
    earliestDate,
    updatedAt: Date.now()
  };
}

function repairLedgerFromTranscripts({
  ledger,
  storage = null,
  ideBrainDirs = null,
  cliBrainDirs = null,
  skipDiskScan = false
} = {}) {
  if (!ledger || ledger.corrupted) {
    return { ok: false, changed: false, error: '账本已损坏，跳过自动修复' };
  }

  const prevVersion = ledger.state?.version || '1.0.0';
  const existing = ledger.getAllCalls();
  const beforeCount = existing.length;

  const brainEntries = skipDiskScan ? [] : buildDefaultBrainEntries(ideBrainDirs, cliBrainDirs);
  const tsResolver = skipDiskScan ? null : createTranscriptTimestampResolver(brainEntries);

  let datesFixedCount = 0;
  let modelsRecoveredCount = 0;
  let sourcesNormalizedCount = 0;
  const repairedList = [];

  for (const c of existing) {
    if (!c || typeof c !== 'object') continue;
    const next = { ...c };
    const normalizedSrc = normalizeCallSource(next.source);
    if (next.source !== normalizedSrc) {
      next.source = normalizedSrc;
      sourcesNormalizedCount++;
    }
    const rawStep = next.stepIndex;
    const parsedStep = rawStep !== undefined && rawStep !== null && rawStep !== '' ? Number(rawStep) : NaN;
    const stepIdx = Number.isInteger(parsedStep) && parsedStep >= 0 ? parsedStep : null;
    const needsDateFix = Boolean(next.dateIsProvisional) || !next.date || !(Number(next.timestamp) > 946684800000);
    const needsModelFix = !String(next.model || '').trim();
    const tsIndex = (needsDateFix || needsModelFix) && tsResolver && next.cascadeId
      ? tsResolver.get(next.cascadeId)
      : null;

    if (needsDateFix && tsIndex) {
      const resolved = resolveStepTimestamp(stepIdx, tsIndex);
      if (resolved && resolved.timestamp > 0) {
        next.timestamp = resolved.timestamp;
        next.date = formatLocalDateStr(new Date(resolved.timestamp));
        next.dateIsProvisional = false;
        datesFixedCount++;
      }
    }
    if (needsModelFix && tsIndex) {
      const recoveredModel = resolveStepModel(stepIdx, tsIndex);
      if (recoveredModel) {
        next.model = recoveredModel;
        modelsRecoveredCount++;
      }
    }
    repairedList.push(next);
  }

  if (prevVersion !== LEDGER_VERSION && storage && typeof storage.readJson === 'function' && typeof storage.writeJson === 'function') {
    try {
      const bakFile = `token-pricing-ledger.pre-v${LEDGER_VERSION.split('.').slice(0, 2).join('.')}.bak.json`;
      const bakRes = storage.readJson(bakFile, null);
      if (!bakRes?.data && !bakRes?.corrupted) {
        storage.writeJson(bakFile, ledger.state);
      }
    } catch {}
  }

  const replaceRes = ledger.replaceAllCalls(repairedList, { version: LEDGER_VERSION });
  if (!replaceRes?.ok) {
    return {
      ok: false,
      changed: false,
      beforeCount,
      afterCount: beforeCount,
      deduplicatedCount: 0,
      datesFixedCount,
      modelsRecoveredCount,
      sourcesNormalizedCount,
      version: prevVersion,
      error: replaceRes?.error || '写入修复后账本失败'
    };
  }

  const afterCount = replaceRes.totalCalls;
  const deduplicatedCount = Math.max(0, beforeCount - afterCount);
  const changed = Boolean(
    deduplicatedCount > 0 ||
    datesFixedCount > 0 ||
    modelsRecoveredCount > 0 ||
    sourcesNormalizedCount > 0 ||
    prevVersion !== LEDGER_VERSION
  );

  return {
    ok: true,
    changed,
    beforeCount,
    afterCount,
    deduplicatedCount,
    datesFixedCount,
    modelsRecoveredCount,
    sourcesNormalizedCount,
    version: LEDGER_VERSION
  };
}

module.exports = {
  parseTimestampMs,
  parseGeneratorCallRow,
  extractModelSelectionFromText,
  readTranscriptStepTimestamps,
  resolveStepTimestamp,
  resolveStepModel,
  createTranscriptTimestampResolver,
  discoverConversationCandidates,
  scanTranscriptBackfill,
  resolveEarliestCallDate,
  runHistoryBackfill,
  repairLedgerFromTranscripts
};
