'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createWebServer, requiredPermissionFor } = require('../src/web-server');
const { createHostProxy } = require('../src/host-proxy');
const { createPtyManager } = require('../src/pty-manager');
const { createSideChatService } = require('../src/side-chat-service');
const { createTaskManager } = require('../src/task-manager');

function httpRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

test('ADR-4 hostProxy: context deactivation hides slot and settings.displayLocation propagates', async () => {
  let contextActive = true;
  let storedDisplayLocation = 'topbar';
  const stateMap = new Map([
    ['state:context.snapshot@1', { key: 'state:context.snapshot@1', value: { usedTokens: 1000, maxTokens: 200000 } }],
    ['state:composer.settings@1', {
      key: 'state:composer.settings@1',
      value: {
        available: true,
        settings: { showQuickBar: true, ghostSuggest: false },
        builtins: [{ id: 'compact', label: '/compact', text: '/compact', enabled: true, builtin: true }],
        custom: []
      }
    }]
  ]);

  const host = {
    services: {
      has(name) {
        if (name === 'context') return contextActive;
        return false;
      },
      async call(svc, method) {
        if (svc === 'context' && contextActive) {
          if (method === 'getSnapshot') {
            return { ok: true, value: { usedTokens: 1000, maxTokens: 200000, displayLocation: storedDisplayLocation, showSpeed: false } };
          }
        }
        return { ok: false, unavailable: true, value: null };
      }
    },
    state: {
      get(key) {
        return stateMap.get(key) || null;
      }
    }
  };

  const proxy = createHostProxy({ host });

  const top1 = await proxy.getTopbar();
  assert.equal(top1.panels.context.available, true);
  assert.deepEqual(top1.panels.context.settings, {
    displayLocation: 'topbar',
    showSpeed: false,
    compactPolicy: 'remind'
  });

  // Deactivated context plugin -> available: false even if state map still had stale snapshot
  contextActive = false;
  const top2 = await proxy.getTopbar();
  assert.equal(top2.panels.context.available, false);

  // Composer state fallback via state:composer.settings@1
  const comp = await proxy.getComposerState();
  assert.equal(comp.available, true);
  assert.equal(comp.settings.ghostSuggest, false);
});

test('WebServer terminal/side-chat/tasks permission matrix (L0/L1/L2) & Cloudflare 5min PTY_WRITE lease', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-ext-'));
  let channelMode = 'cloudflare';
  let permLevel = 'L0';

  const ptyManager = createPtyManager({
    allowedRoots: [tmpRoot],
    probeFn: async () => ({ available: true, reason: null }),
    spawnFn: () => {
      const listeners = new Map();
      return {
        exitCode: null,
        killed: false,
        stdin: { destroyed: false, write() {}, end() {} },
        stdout: { on() {} },
        stderr: { on() {} },
        stdio: [null, null, null, { destroyed: false, write() {}, end() {} }],
        on(ev, fn) {
          if (!listeners.has(ev)) listeners.set(ev, []);
          listeners.get(ev).push(fn);
        },
        kill() {
          this.killed = true;
          this.exitCode = 0;
          for (const fn of listeners.get('exit') || []) fn(0, 'SIGTERM');
        }
      };
    }
  });

  const rpc = {
    async call(method) {
      if (method === 'GetModelResponse') return { response: 'Side reply' };
      return {};
    }
  };
  const harnessAdapter = {
    async listSessions() {
      return {
        sessions: [{
          cascadeId: 'cid-1',
          title: 'Active Run',
          status: 'CASCADE_RUN_STATUS_RUNNING',
          isSubagent: false
        }]
      };
    },
    async listModels() {
      return { models: [{ id: 'gemini-4-flash', label: 'Flash' }] };
    },
    async cancelSession() {
      return { ok: true };
    }
  };

  const sideChatService = createSideChatService({ rpc, harnessAdapter });
  const taskManager = createTaskManager({ rpc, harnessAdapter, ptyManager });

  const srv = createWebServer({
    port: 0,
    channels: { loopback: true, cloudflare: true },
    getPermissionLevel: () => permLevel,
    resolveChannel: () => channelMode,
    pairingToken: 'tok-ext-1234567890123456',
    confirmSecret: 'confirm-secret-ext-123456',
    harnessAdapter,
    ptyManager,
    sideChatService,
    taskManager
  });

  try {
    const info = await srv.start();
    const baseUrl = `http://127.0.0.1:${info.port}`;
    const authHeaders = {
      Authorization: 'Bearer tok-ext-1234567890123456',
      'Content-Type': 'application/json'
    };

    // L0: reads allowed, terminal writable=false, side-chat & task stop & terminal create rejected 403 PERMISSION_DENIED
    const listTermL0 = await httpRequest(`${baseUrl}/api/v1/terminal/sessions`, { headers: authHeaders });
    assert.equal(listTermL0.status, 200);
    assert.equal(listTermL0.json.writable, false);
    assert.equal(listTermL0.json.requiredPermission, 'L2');

    const createTermL0 = await httpRequest(`${baseUrl}/api/v1/terminal/sessions`, {
      method: 'POST',
      headers: authHeaders,
      body: { cwd: tmpRoot }
    });
    assert.equal(createTermL0.status, 403);
    assert.equal(createTermL0.json.error, 'PERMISSION_DENIED');
    assert.equal(createTermL0.json.required, 'L2');

    const sideChatL0 = await httpRequest(`${baseUrl}/api/v1/side-chat/completions`, {
      method: 'POST',
      headers: authHeaders,
      body: { prompt: 'hi' }
    });
    assert.equal(sideChatL0.status, 403);
    assert.equal(sideChatL0.json.required, 'L1');

    const stopSessionL0 = await httpRequest(`${baseUrl}/api/v1/tasks/session:cid-1/stop`, {
      method: 'POST',
      headers: authHeaders,
      body: {}
    });
    assert.equal(stopSessionL0.status, 403);
    assert.equal(stopSessionL0.json.required, 'L1');

    // L0: non-PTY task detail stays L0, while terminal SSE stream & pty: task detail require L2
    const sessionTaskDetailL0 = await httpRequest(`${baseUrl}/api/v1/tasks/session:cid-1`, {
      headers: authHeaders
    });
    assert.equal(sessionTaskDetailL0.status, 200);
    assert.equal(sessionTaskDetailL0.json.ok, true);

    const termStreamL0 = await httpRequest(`${baseUrl}/api/v1/terminal/sessions/s-any/stream`, {
      headers: authHeaders
    });
    assert.equal(termStreamL0.status, 403);
    assert.equal(termStreamL0.json.error, 'PERMISSION_DENIED');
    assert.equal(termStreamL0.json.required, 'L2');

    const ptyDetailL0 = await httpRequest(`${baseUrl}/api/v1/tasks/pty:p1`, {
      headers: authHeaders
    });
    assert.equal(ptyDetailL0.status, 403);
    assert.equal(ptyDetailL0.json.error, 'PERMISSION_DENIED');
    assert.equal(ptyDetailL0.json.required, 'L2');

    const ptyDetailEncodedL0 = await httpRequest(`${baseUrl}/api/v1/tasks/pty%3Ap1`, {
      headers: authHeaders
    });
    assert.equal(ptyDetailEncodedL0.status, 403);
    assert.equal(ptyDetailEncodedL0.json.error, 'PERMISSION_DENIED');
    assert.equal(ptyDetailEncodedL0.json.required, 'L2');

    // L1 on Cloudflare: side-chat requires X-Agy-Confirm, cancel exempts X-Agy-Confirm, terminal still L2
    permLevel = 'L1';
    const termStreamL1 = await httpRequest(`${baseUrl}/api/v1/terminal/sessions/s-any/stream`, {
      headers: authHeaders
    });
    assert.equal(termStreamL1.status, 403);
    assert.equal(termStreamL1.json.error, 'PERMISSION_DENIED');
    assert.equal(termStreamL1.json.required, 'L2');

    const ptyDetailL1 = await httpRequest(`${baseUrl}/api/v1/tasks/pty:p1`, {
      headers: authHeaders
    });
    assert.equal(ptyDetailL1.status, 403);
    assert.equal(ptyDetailL1.json.error, 'PERMISSION_DENIED');
    assert.equal(ptyDetailL1.json.required, 'L2');
    const sideChatNoConfirm = await httpRequest(`${baseUrl}/api/v1/side-chat/completions`, {
      method: 'POST',
      headers: authHeaders,
      body: { prompt: 'hi' }
    });
    assert.equal(sideChatNoConfirm.status, 403);
    assert.equal(sideChatNoConfirm.json.error, 'CONFIRMATION_REQUIRED');

    const sideChatConfirm = await httpRequest(`${baseUrl}/api/v1/side-chat/completions`, {
      method: 'POST',
      headers: { ...authHeaders, 'X-Agy-Confirm': sideChatNoConfirm.json.confirmToken },
      body: { prompt: 'hi' }
    });
    assert.equal(sideChatConfirm.status, 200);
    assert.match(sideChatConfirm.text, /event: done/);

    const cancelRes = await httpRequest(`${baseUrl}/api/v1/side-chat/cancel`, {
      method: 'POST',
      headers: authHeaders,
      body: { requestId: 'non-existent' }
    });
    assert.equal(cancelRes.status, 200);

    const stopPtyL1 = await httpRequest(`${baseUrl}/api/v1/tasks/pty:p1/stop`, {
      method: 'POST',
      headers: authHeaders,
      body: {}
    });
    assert.equal(stopPtyL1.status, 403);
    assert.equal(stopPtyL1.json.required, 'L2');

    // L2 on Cloudflare: terminal create mints 5min writeConfirmToken usable for input & resize
    permLevel = 'L2';
    const createNoConfirm = await httpRequest(`${baseUrl}/api/v1/terminal/sessions`, {
      method: 'POST',
      headers: authHeaders,
      body: { cwd: tmpRoot }
    });
    assert.equal(createNoConfirm.status, 403);
    assert.equal(createNoConfirm.json.error, 'CONFIRMATION_REQUIRED');

    const createOk = await httpRequest(`${baseUrl}/api/v1/terminal/sessions`, {
      method: 'POST',
      headers: { ...authHeaders, 'X-Agy-Confirm': createNoConfirm.json.confirmToken },
      body: { cwd: tmpRoot }
    });
    assert.equal(createOk.status, 201);
    const sid = createOk.json.session.sessionId;
    const leaseToken = createOk.json.writeConfirmToken;
    assert.ok(leaseToken);

    // L2 on Cloudflare: GET terminal stream & GET pty: task detail succeed WITHOUT X-Agy-Confirm
    const ptyDetailL2 = await httpRequest(`${baseUrl}/api/v1/tasks/pty:${sid}`, {
      headers: authHeaders
    });
    assert.equal(ptyDetailL2.status, 200);
    assert.equal(ptyDetailL2.json.ok, true);
    assert.equal(ptyDetailL2.json.task.taskId, `pty:${sid}`);

    const sseHeadL2 = await new Promise((resolve, reject) => {
      const u = new URL(`${baseUrl}/api/v1/terminal/sessions/${sid}/stream`);
      const req = http.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'GET',
        headers: authHeaders
      }, (res) => {
        res.once('data', (chunk) => {
          req.destroy();
          resolve({ status: res.statusCode, contentType: res.headers['content-type'], firstChunk: chunk.toString('utf8') });
        });
      });
      req.on('error', (err) => {
        if (err && err.code === 'ECONNRESET') return;
        reject(err);
      });
      req.end();
    });
    assert.equal(sseHeadL2.status, 200);
    assert.match(String(sseHeadL2.contentType), /text\/event-stream/);
    assert.match(sseHeadL2.firstChunk, /connected/);

    // Input & resize succeed with the single 5min PTY_WRITE lease token
    const inputOk = await httpRequest(`${baseUrl}/api/v1/terminal/sessions/${sid}/input`, {
      method: 'POST',
      headers: { ...authHeaders, 'X-Agy-Confirm': leaseToken },
      body: { data: 'pwd\n' }
    });
    assert.equal(inputOk.status, 200);

    const resizeOk = await httpRequest(`${baseUrl}/api/v1/terminal/sessions/${sid}/resize`, {
      method: 'POST',
      headers: { ...authHeaders, 'X-Agy-Confirm': leaseToken },
      body: { cols: 100, rows: 30 }
    });
    assert.equal(resizeOk.status, 200);

    // DELETE still requires its own action-bound confirmation on Cloudflare
    const delNoConfirm = await httpRequest(`${baseUrl}/api/v1/terminal/sessions/${sid}`, {
      method: 'DELETE',
      headers: authHeaders
    });
    assert.equal(delNoConfirm.status, 403);
    assert.equal(delNoConfirm.json.error, 'CONFIRMATION_REQUIRED');

    const delOk = await httpRequest(`${baseUrl}/api/v1/terminal/sessions/${sid}`, {
      method: 'DELETE',
      headers: { ...authHeaders, 'X-Agy-Confirm': delNoConfirm.json.confirmToken }
    });
    assert.equal(delOk.status, 200);
    assert.equal(delOk.json.closed, true);

    // Idempotent DELETE on loopback
    channelMode = 'loopback';
    const delIdem = await httpRequest(`${baseUrl}/api/v1/terminal/sessions/${sid}`, {
      method: 'DELETE',
      headers: authHeaders
    });
    assert.equal(delIdem.status, 200);
    assert.equal(delIdem.json.alreadyClosed, true);
  } finally {
    await srv.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('requiredPermissionFor tightens terminal SSE stream and pty: task details to L2 while preserving L0 reads', () => {
  assert.equal(requiredPermissionFor('GET', '/api/v1/terminal/sessions/s-1/stream'), 'L2');
  assert.equal(requiredPermissionFor('HEAD', '/api/v1/terminal/sessions/s-1/stream'), 'L2');
  assert.equal(requiredPermissionFor('GET', '/api/v1/tasks/pty:s-1'), 'L2');
  assert.equal(requiredPermissionFor('GET', '/api/v1/tasks/pty%3As-1'), 'L2');
  assert.equal(requiredPermissionFor('HEAD', '/api/v1/tasks/pty:s-1'), 'L2');

  assert.equal(requiredPermissionFor('GET', '/api/v1/terminal/sessions'), 'L0');
  assert.equal(requiredPermissionFor('GET', '/api/v1/tasks'), 'L0');
  assert.equal(requiredPermissionFor('GET', '/api/v1/tasks/session:cid-1'), 'L0');
  assert.equal(requiredPermissionFor('GET', '/api/v1/tasks/%E0%A4%A'), 'L0');
  assert.equal(requiredPermissionFor('POST', '/api/v1/tasks/%E0%A4%A/stop'), 'L1');
});
