'use strict';

const crypto = require('node:crypto');

const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CHARS = 24000;
const MAX_SESSION_SUMMARY_CHARS = 6000;
const MAX_SELECTION_CHARS = 8000;
const KEEPALIVE_INTERVAL_MS = 10000;
const DEFAULT_CHUNK_DELAY_MS = 12;
const MAX_STREAM_TAIL_DELAY_MS = 240;

const FAST_MODEL_HINT_RE = /\b(flash|lite|fast|mini|haiku|small|nano)\b/i;

function isTestMode() {
  return (
    process.env.AGY_DADDY_TEST_MODE === '1'
    || process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function truncateChars(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatSseFrame({ id, event, data }) {
  const lines = [];
  if (id !== undefined && id !== null) lines.push(`id: ${id}`);
  if (event) lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data === undefined ? null : data)}`);
  return `${lines.join('\n')}\n\n`;
}

function splitSemanticChunks(text, minSize = 32, maxSize = 64) {
  const str = String(text || '');
  if (!str) return [];
  const chunks = [];
  let idx = 0;
  while (idx < str.length) {
    const remaining = str.length - idx;
    if (remaining <= maxSize) {
      chunks.push(str.slice(idx));
      break;
    }
    const windowStr = str.slice(idx, idx + maxSize);
    let splitAt = -1;
    for (let i = windowStr.length - 1; i >= minSize; i--) {
      if (windowStr[i] === '\n' || windowStr[i] === ' ' || windowStr[i] === '。' || windowStr[i] === '.') {
        splitAt = i + 1;
        break;
      }
    }
    if (splitAt <= 0) splitAt = maxSize;
    chunks.push(str.slice(idx, idx + splitAt));
    idx += splitAt;
  }
  return chunks;
}

function normalizeHistoryTurns(history) {
  if (!Array.isArray(history)) return [];
  const filtered = [];
  for (const turn of history) {
    if (!turn || typeof turn !== 'object') continue;
    const role = turn.role === 'assistant' ? 'assistant' : (turn.role === 'user' ? 'user' : '');
    const content = typeof turn.content === 'string' ? turn.content.trim() : '';
    if (!role || !content) continue;
    filtered.push({ role, content });
  }
  const recent = filtered.slice(-MAX_HISTORY_TURNS);
  const kept = [];
  let totalChars = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const item = recent[i];
    const nextLen = totalChars + item.content.length;
    if (nextLen > MAX_HISTORY_CHARS && kept.length > 0) break;
    const clipped = nextLen > MAX_HISTORY_CHARS
      ? truncateChars(item.content, MAX_HISTORY_CHARS - totalChars)
      : item.content;
    kept.unshift({ role: item.role, content: clipped });
    totalChars += clipped.length;
  }
  return kept;
}

function extractReadonlySessionSummary(trajectoryResp, maxChars = MAX_SESSION_SUMMARY_CHARS) {
  const traj = isPlainObject(trajectoryResp?.trajectory)
    ? trajectoryResp.trajectory
    : (isPlainObject(trajectoryResp) ? trajectoryResp : {});
  const steps = Array.isArray(traj.steps)
    ? traj.steps
    : (Array.isArray(trajectoryResp?.steps) ? trajectoryResp.steps : []);

  const turns = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    if (step.userInput) {
      const itemsText = Array.isArray(step.userInput.items)
        ? step.userInput.items.map((it) => (typeof it === 'string' ? it : it?.text || '')).filter(Boolean).join('\n')
        : '';
      const userText = String(step.userInput.userResponse || itemsText || '').trim();
      if (userText) {
        turns.push(`User: ${userText}`);
      }
    } else if (step.plannerResponse) {
      const replyText = String(step.plannerResponse.modifiedResponse || step.plannerResponse.response || '').trim();
      if (replyText) {
        turns.push(`Assistant: ${replyText}`);
      }
    }
  }

  if (turns.length === 0) return '';
  const recentTurns = turns.slice(-10); // up to ~5 user/assistant pairs
  return truncateChars(recentTurns.join('\n\n'), maxChars);
}

function buildSideChatPrompt({
  prompt,
  history = [],
  contextScope = 'none',
  sessionSummaryText = '',
  selectionContext = null
} = {}) {
  const sections = [
    'You are an independent Side Chat assistant.',
    'Answer concisely and accurately based only on the user request and any explicitly provided read-only context below.'
  ];

  if (contextScope === 'session_summary' && sessionSummaryText) {
    sections.push(`<readonly_session_summary>\n${truncateChars(sessionSummaryText, MAX_SESSION_SUMMARY_CHARS)}\n</readonly_session_summary>`);
  } else if (contextScope === 'active_selection' && selectionContext && typeof selectionContext.snippet === 'string' && selectionContext.snippet.trim()) {
    const safePath = String(selectionContext.path || 'selection').replace(/["\r\n<>]/g, '');
    const kind = selectionContext.kind === 'diff' ? 'diff' : 'file';
    sections.push(`<readonly_workspace_context path="${safePath}" kind="${kind}">\n${truncateChars(selectionContext.snippet, MAX_SELECTION_CHARS)}\n</readonly_workspace_context>`);
  }

  const normalizedHistory = normalizeHistoryTurns(history);
  if (normalizedHistory.length > 0) {
    const lines = normalizedHistory.map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.content}`);
    sections.push(`Previous Side Chat Turns:\n${lines.join('\n\n')}`);
  }

  sections.push(`User: ${String(prompt || '').trim()}\nAssistant:`);
  return sections.join('\n\n');
}

function extractModelCandidates(catalog) {
  const out = [];
  const seen = new Set();
  const pushItem = (id, label) => {
    const cleanId = typeof id === 'string' ? id.trim() : '';
    if (!cleanId || seen.has(cleanId)) return;
    seen.add(cleanId);
    out.push({ id: cleanId, label: label || cleanId });
  };

  if (Array.isArray(catalog?.models)) {
    for (const m of catalog.models) {
      if (!m || typeof m !== 'object') continue;
      if (m.mode === 'orchestrator_preset' || String(m.id || '').startsWith('orchestrator:')) continue;
      pushItem(m.requestedModel || m.id, m.label || m.id);
    }
  }
  if (Array.isArray(catalog?.tree?.nodes)) {
    const walk = (nodes) => {
      for (const n of nodes) {
        if (!n || typeof n !== 'object') continue;
        if (n.kind === 'leaf' && n.selection && n.selection.mode !== 'orchestrator_preset') {
          pushItem(n.selection.requestedModel || n.selection.modelId, n.label);
        } else if (Array.isArray(n.children)) {
          walk(n.children);
        }
      }
    };
    walk(catalog.tree.nodes);
  }

  const fast = out.filter((m) => FAST_MODEL_HINT_RE.test(m.id) || FAST_MODEL_HINT_RE.test(m.label));
  const rest = out.filter((m) => !fast.includes(m));
  return [...fast, ...rest];
}

/**
 * Read-only isolated Side Chat service backed exclusively by GetModelResponse.
 * Never mutates main Cascade trajectories or consumes main session context.
 */
function createSideChatService({ rpc, harnessAdapter = null, securityHeaders = {} } = {}) {
  const activeRequests = new Map();

  async function resolveCandidates(requestedModel) {
    const cleanRequested = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    let catalog = null;
    if (harnessAdapter && typeof harnessAdapter.listModels === 'function') {
      try {
        catalog = await harnessAdapter.listModels();
      } catch {
        catalog = null;
      }
    }
    const allCandidates = extractModelCandidates(catalog);

    if (cleanRequested) {
      if (cleanRequested.startsWith('orchestrator:')) {
        const fam = cleanRequested.slice('orchestrator:'.length).trim();
        const match = allCandidates.find((c) => c.id.includes(fam));
        if (match) return [match];
      }
      const exact = allCandidates.find((c) => c.id === cleanRequested);
      return [exact || { id: cleanRequested, label: cleanRequested }];
    }

    if (allCandidates.length > 0) {
      return allCandidates.slice(0, 3);
    }
    return [{ id: '', label: 'Default Fast Model' }];
  }

  async function invokeGetModelResponse(promptText, candidates, state) {
    if (!rpc || typeof rpc.call !== 'function') {
      const err = new Error('RPC_UNAVAILABLE');
      err.code = 'RPC_UNAVAILABLE';
      err.statusCode = 503;
      throw err;
    }

    let lastErr = null;
    for (const candidate of candidates) {
      if (state.cancelled) return null;
      const params = candidate.id
        ? { prompt: promptText, model: candidate.id }
        : { prompt: promptText };
      try {
        const res = await rpc.call('GetModelResponse', params, {
          timeoutMs: 60000,
          retryOnTimeout: false
        });
        const text = typeof res?.response === 'string'
          ? res.response
          : (typeof res?.text === 'string' ? res.text : '');
        return { text, candidate };
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('SIDE_CHAT_MODEL_FAILED');
  }

  function cancel(requestId) {
    const id = typeof requestId === 'string' ? requestId.trim() : '';
    if (!id) return { ok: true, cancelled: false };
    const entry = activeRequests.get(id);
    if (!entry) return { ok: true, cancelled: false };
    entry.cancelled = true;
    return { ok: true, cancelled: true, requestId: id };
  }

  async function handleCompletionStream(req, res, body = {}, opts = {}) {
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt) {
      res.writeHead(400, {
        'Content-Type': 'application/json; charset=utf-8',
        ...securityHeaders
      });
      res.end(JSON.stringify({ ok: false, error: 'EMPTY_PROMPT' }));
      return;
    }

    const contextScope = body?.contextScope === 'session_summary' || body?.contextScope === 'active_selection'
      ? body.contextScope
      : 'none';
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const state = { cancelled: false };
    activeRequests.set(requestId, state);

    const markCancelled = () => {
      state.cancelled = true;
    };
    req.on?.('close', markCancelled);
    res.on?.('close', markCancelled);

    let sessionSummaryText = '';
    if (contextScope === 'session_summary' && typeof body?.sessionId === 'string' && body.sessionId.trim()) {
      const targetId = body.sessionId.trim();
      try {
        if (rpc && typeof rpc.call === 'function') {
          const traj = await rpc.call('GetCascadeTrajectory', { cascadeId: targetId });
          sessionSummaryText = extractReadonlySessionSummary(traj);
        }
      } catch {
        sessionSummaryText = '';
      }
    }

    const candidates = await resolveCandidates(body?.model);
    const primaryCandidate = candidates[0] || { id: '', label: 'Default Fast Model' };

    req.setTimeout?.(0);
    res.setTimeout?.(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...securityHeaders
    });

    const writeFrame = (frame) => {
      if (!state.cancelled && !res.writableEnded) {
        try {
          res.write(formatSseFrame(frame));
        } catch {
          state.cancelled = true;
        }
      }
    };

    writeFrame({
      event: 'meta',
      data: {
        requestId,
        model: primaryCandidate.id,
        label: primaryCandidate.label,
        contextScope
      }
    });

    const keepaliveTimer = setInterval(() => {
      if (!state.cancelled && !res.writableEnded) {
        try { res.write(': keepalive\n\n'); } catch { state.cancelled = true; }
      }
    }, KEEPALIVE_INTERVAL_MS);
    keepaliveTimer.unref?.();

    try {
      const fullPrompt = buildSideChatPrompt({
        prompt,
        history: body?.history,
        contextScope,
        sessionSummaryText,
        selectionContext: body?.selectionContext
      });

      const outcome = await invokeGetModelResponse(fullPrompt, candidates, state);
      clearInterval(keepaliveTimer);

      if (state.cancelled || !outcome) {
        if (!res.writableEnded) res.end();
        return;
      }

      const chunks = splitSemanticChunks(outcome.text);
      const baseDelay = opts.chunkDelayMs !== undefined
        ? Number(opts.chunkDelayMs)
        : (isTestMode() ? 0 : DEFAULT_CHUNK_DELAY_MS);
      const perChunkDelay = chunks.length > 0 && baseDelay > 0
        ? Math.min(baseDelay, Math.floor(MAX_STREAM_TAIL_DELAY_MS / chunks.length))
        : 0;

      for (const delta of chunks) {
        if (state.cancelled) break;
        writeFrame({ event: 'delta', data: { delta } });
        if (perChunkDelay > 0) {
          await new Promise((r) => setTimeout(r, perChunkDelay));
        }
      }

      if (!state.cancelled) {
        writeFrame({
          event: 'done',
          data: {
            requestId,
            text: outcome.text,
            model: outcome.candidate.id,
            label: outcome.candidate.label,
            durationMs: Date.now() - startedAt
          }
        });
      }
      if (!res.writableEnded) res.end();
    } catch (err) {
      clearInterval(keepaliveTimer);
      if (!state.cancelled) {
        writeFrame({
          event: 'error',
          data: {
            error: err?.code || 'SIDE_CHAT_FAILED',
            message: err?.message || 'Side chat request failed'
          }
        });
      }
      if (!res.writableEnded) res.end();
    } finally {
      activeRequests.delete(requestId);
    }
  }

  return {
    cancel,
    handleCompletionStream
  };
}

module.exports = {
  MAX_HISTORY_TURNS,
  MAX_HISTORY_CHARS,
  MAX_SESSION_SUMMARY_CHARS,
  MAX_SELECTION_CHARS,
  splitSemanticChunks,
  extractReadonlySessionSummary,
  buildSideChatPrompt,
  createSideChatService
};
