'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  buildSideChatPrompt,
  extractReadonlySessionSummary,
  splitSemanticChunks,
  createSideChatService
} = require('../src/side-chat-service');

function createMockRes() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.chunks = [];
  res.writableEnded = false;
  res.setTimeout = () => {};
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers || {};
  };
  res.write = (chunk) => {
    res.chunks.push(String(chunk));
    return true;
  };
  res.end = (chunk) => {
    if (chunk) res.chunks.push(String(chunk));
    res.writableEnded = true;
    res.emit('close');
  };
  return res;
}

function parseSseText(raw) {
  const events = [];
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n').filter((l) => l && !l.startsWith(':'));
    if (lines.length === 0) continue;
    let event = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const dataStr = dataLines.join('\n');
    let json = null;
    try { json = JSON.parse(dataStr); } catch {}
    events.push({ event, data: dataStr, json });
  }
  return events;
}

test('side-chat-service source physically omits cascade write RPC identifiers', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'side-chat-service.js'), 'utf8');
  assert.equal(src.includes('StartCascade'), false);
  assert.equal(src.includes('SendUserCascadeMessage'), false);
});

test('buildSideChatPrompt assembles none, session_summary, and active_selection scopes safely', () => {
  const nonePrompt = buildSideChatPrompt({
    prompt: 'Explain Promise.allSettled',
    history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    contextScope: 'none'
  });
  assert.match(nonePrompt, /Explain Promise\.allSettled/);
  assert.doesNotMatch(nonePrompt, /readonly_session_summary/);
  assert.doesNotMatch(nonePrompt, /readonly_workspace_context/);

  const summary = extractReadonlySessionSummary({
    steps: [
      { userInput: { userResponse: 'Check auth bug' } },
      { plannerResponse: { thinking: 'secret internal', response: 'Found missing CSRF check' } }
    ]
  });
  assert.match(summary, /Check auth bug/);
  assert.match(summary, /Found missing CSRF check/);
  assert.doesNotMatch(summary, /secret internal/);

  const sessPrompt = buildSideChatPrompt({
    prompt: 'Summarize',
    contextScope: 'session_summary',
    sessionSummaryText: summary
  });
  assert.match(sessPrompt, /<readonly_session_summary>/);

  const selPrompt = buildSideChatPrompt({
    prompt: 'Review diff',
    contextScope: 'active_selection',
    selectionContext: { path: 'src/app.ts', snippet: '+const x = 1;', kind: 'diff' }
  });
  assert.match(selPrompt, /<readonly_workspace_context path="src\/app\.ts" kind="diff">/);
  assert.ok(splitSemanticChunks('a'.repeat(100), 32, 64).length >= 2);
});

test('sideChatService calls only GetModelResponse (zero trajectory writes) and supports immediate cancel', async () => {
  const rpcCalls = [];
  let resolveSlowRpc = null;

  const rpc = {
    async call(method, params) {
      rpcCalls.push({ method, params });
      if (method === 'GetCascadeTrajectory') {
        return {
          steps: [
            { userInput: { userResponse: 'Main question' } },
            { plannerResponse: { response: 'Main answer' } }
          ]
        };
      }
      if (method === 'GetModelResponse') {
        if (params.prompt.includes('SLOW_CANCEL')) {
          return await new Promise((resolve) => {
            resolveSlowRpc = resolve;
          });
        }
        return { response: 'Side answer line 1. Side answer line 2 with enough words for chunking.' };
      }
      return {};
    }
  };

  const harnessAdapter = {
    async listModels() {
      return {
        models: [
          { id: 'gemini-4-flash', label: 'Gemini 4 Flash' },
          { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }
        ]
      };
    }
  };

  const svc = createSideChatService({ rpc, harnessAdapter });

  // 1. Empty prompt -> 400
  const req0 = new EventEmitter();
  const res0 = createMockRes();
  await svc.handleCompletionStream(req0, res0, { prompt: '   ' });
  assert.equal(res0.statusCode, 400);
  assert.equal(JSON.parse(res0.chunks.join('')).error, 'EMPTY_PROMPT');

  // 2. Normal completion with session_summary
  const req1 = new EventEmitter();
  const res1 = createMockRes();
  await svc.handleCompletionStream(req1, res1, {
    prompt: 'What did we find?',
    contextScope: 'session_summary',
    sessionId: 'cid-main-1'
  }, { chunkDelayMs: 0 });

  assert.equal(res1.statusCode, 200);
  const events1 = parseSseText(res1.chunks.join(''));
  assert.equal(events1[0].event, 'meta');
  assert.equal(events1[0].json.model, 'gemini-4-flash');
  assert.ok(events1.some((e) => e.event === 'delta'));
  const doneEv = events1.find((e) => e.event === 'done');
  assert.ok(doneEv);
  assert.match(doneEv.json.text, /Side answer line 1/);

  // Verify zero StartCascade / SendUserCascadeMessage calls
  const calledMethods = rpcCalls.map((c) => c.method);
  assert.equal(calledMethods.includes('StartCascade'), false);
  assert.equal(calledMethods.includes('SendUserCascadeMessage'), false);
  assert.ok(calledMethods.includes('GetModelResponse'));
  assert.ok(calledMethods.includes('GetCascadeTrajectory'));

  // 3. Cancel in-flight request discards late GetModelResponse
  const req2 = new EventEmitter();
  const res2 = createMockRes();
  const pendingPromise = svc.handleCompletionStream(req2, res2, {
    prompt: 'SLOW_CANCEL'
  }, { chunkDelayMs: 0 });

  await new Promise((r) => setTimeout(r, 20));
  const metaEv = parseSseText(res2.chunks.join('')).find((e) => e.event === 'meta');
  assert.ok(metaEv?.json?.requestId);
  const cancelRes = svc.cancel(metaEv.json.requestId);
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.cancelled, true);

  resolveSlowRpc({ response: 'Should be discarded' });
  await pendingPromise;

  const events2 = parseSseText(res2.chunks.join(''));
  assert.equal(events2.some((e) => e.event === 'delta'), false);
  assert.equal(events2.some((e) => e.event === 'done'), false);
});
