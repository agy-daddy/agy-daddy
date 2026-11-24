'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const url = require('node:url');

const { WebServer, createWebServer, SECURITY_HEADERS } = require('../src/web-server');
const { createWorkspaceMetaStore } = require('../src/workspace-meta-store');
const { createWorkspaceService } = require('../src/workspace-service');
const { createHostProxy } = require('../src/host-proxy');

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
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer,
          text,
          json
        });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

function assertSecurityHeaders(headers) {
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.equal(headers['cache-control'], 'no-store');
  assert.match(String(headers['content-security-policy'] || ''), /default-src 'self'/);
  assert.match(String(headers['content-security-policy'] || ''), /frame-ancestors 'none'/);
}

function openSse(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers
    }, (res) => {
      let buffer = '';
      const events = [];
      const waiters = [];

      function flushWaiters() {
        while (waiters.length > 0) {
          const w = waiters[0];
          const found = events.find(w.predicate);
          if (!found) break;
          waiters.shift();
          clearTimeout(w.timer);
          w.resolve(found);
        }
      }

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawBlock = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = rawBlock.split('\n').filter((l) => l && !l.startsWith(':'));
          if (lines.length === 0) continue;
          const ev = { id: null, event: 'message', data: '' };
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith('id:')) ev.id = line.slice(3).trim();
            else if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          ev.data = dataLines.join('\n');
          try { ev.json = JSON.parse(ev.data); } catch {}
          events.push(ev);
          flushWaiters();
        }
      });

      resolve({
        status: res.statusCode,
        headers: res.headers,
        events,
        waitForEvent(predicate, timeoutMs = 2000) {
          const existing = events.find(predicate);
          if (existing) return Promise.resolve(existing);
          return new Promise((resWait, rejWait) => {
            const timer = setTimeout(() => {
              const pos = waiters.findIndex((w) => w.resolve === resWait);
              if (pos >= 0) waiters.splice(pos, 1);
              rejWait(new Error(`Timed out waiting for SSE event. Received: ${JSON.stringify(events)}`));
            }, timeoutMs);
            waiters.push({ predicate, resolve: resWait, reject: rejWait, timer });
          });
        },
        close() {
          req.destroy();
          res.destroy();
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function createFakeDeps() {
  const calls = [];
  return {
    calls,
    harnessAdapter: {
      async getHealth() {
        return { ok: true, rpcConnected: true, hubOrigin: 'https://127.0.0.1:51410' };
      },
      async listSessions({ limit }) {
        calls.push({ fn: 'listSessions', limit });
        return { ok: true, sessions: [{ cascadeId: 'c1', title: 'Test Session' }] };
      },
      async createSession(body) {
        calls.push({ fn: 'createSession', body });
        return { ok: true, cascadeId: 'c-new' };
      },
      async getSessionDetail(id) {
        calls.push({ fn: 'getSessionDetail', id });
        if (id === 'missing') return { ok: false, statusCode: 404, error: 'SESSION_NOT_FOUND' };
        return { ok: true, session: { cascadeId: id }, events: [] };
      },
      async sendMessage(id, body) {
        calls.push({ fn: 'sendMessage', id, body });
        return { ok: true, cascadeId: id };
      },
      async cancelSession(id) {
        calls.push({ fn: 'cancelSession', id });
        return { ok: true, cascadeId: id };
      },
      async approveStep(id, stepIdx, decision) {
        calls.push({ fn: 'approveStep', id, stepIdx, decision });
        return { ok: false, supported: false, statusCode: 501, error: 'APPROVAL_RPC_UNAVAILABLE_IN_2_34' };
      },
      async listModels() {
        calls.push({ fn: 'listModels' });
        return { ok: true, defaultModelId: 'model-a', models: [{ id: 'model-a' }], groups: [] };
      }
    },
    workspaceService: {
      async listTree(opts) {
        calls.push({ fn: 'listTree', opts });
        return { ok: true, root: opts.root, entries: [] };
      },
      async readFile(opts) {
        calls.push({ fn: 'readFile', opts });
        return { ok: true, path: opts.path, size: 3, truncated: false, content: 'abc' };
      },
      async writeFile(opts) {
        calls.push({ fn: 'writeFile', opts });
        return { ok: true, path: opts.path, bytes: Buffer.byteLength(String(opts.content || '')) };
      },
      async getGitDiff(opts) {
        calls.push({ fn: 'getGitDiff', opts });
        return { ok: true, isGitRepo: false, branch: '', files: [], diffText: '' };
      },
      async listArtifacts(sessionId) {
        calls.push({ fn: 'listArtifacts', sessionId });
        return { ok: true, items: [{ name: 'plan.md' }] };
      },
      async readArtifact(sessionId, file) {
        calls.push({ fn: 'readArtifact', sessionId, file });
        return { ok: true, name: file, mime: 'text/markdown', content: '# Plan' };
      }
    },
    hostProxy: {
      async getPlugins() {
        return { ok: true, plugins: [], catalog: [], marketStats: { total: 0, installed: 0, catalogCount: 0 } };
      },
      async pluginAction(id, action, body) {
        calls.push({ fn: 'pluginAction', id, action, body });
        return { ok: true, id, action };
      },
      async getHostSettings() {
        return { ok: true, values: { theme: 'dark' } };
      },
      async setHostSettings(patch) {
        calls.push({ fn: 'setHostSettings', patch });
        return { ok: true, values: patch };
      },
      async getPluginSettings(id) {
        return { ok: true, values: { enabled: true }, secretState: { key: { configured: true } }, schema: { fields: [] } };
      },
      async setPluginSettings(id, patch) {
        calls.push({ fn: 'setPluginSettings', id, patch });
        return { ok: true, values: patch, secretState: { key: { configured: true } }, schema: { fields: [] } };
      },
      async runCommand(cmdId, opts) {
        calls.push({ fn: 'runCommand', cmdId, opts });
        return { ok: true, result: { cmdId } };
      },
      async getDoctor() {
        return { ok: true, checks: [] };
      },
      async getTopbar() {
        return { ok: true, panels: { context: { available: false }, usage: { available: false }, quota: { available: false } } };
      }
    }
  };
}

test('D1: WebServer hard-locks loopback hosts in constructor and start()', async () => {
  assert.throws(() => new WebServer({ host: '0.0.0.0' }), /ERR_NON_LOOPBACK_FORBIDDEN/);
  assert.throws(() => createWebServer({ host: '192.168.1.5' }), /ERR_NON_LOOPBACK_FORBIDDEN/);
  assert.throws(() => createWebServer({ host: 'localhost' }), /ERR_NON_LOOPBACK_FORBIDDEN/);

  const srv = createWebServer({ host: '127.0.0.1', port: 0, pairingToken: 'tok-d1' });
  srv.host = '0.0.0.0';
  await assert.rejects(() => srv.start(), /ERR_NON_LOOPBACK_FORBIDDEN/);
  await srv.stop();

  const ipv4Srv = createWebServer({ host: '127.0.0.1', port: 0, pairingToken: 'tok-d1-v4' });
  const info4 = await ipv4Srv.start();
  assert.equal(info4.host, '127.0.0.1');
  assert.ok(info4.port > 0);
  await ipv4Srv.stop();
});

test('D2 & D3: token->cookie exchange, API auth, CSRF gate, security headers, and full endpoint wiring', async () => {
  const deps = createFakeDeps();
  const pairingToken = 'pairing-secret-token-12345';
  const sessionSecret = 'session-secret-cookie-67890';
  const srv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken,
    sessionSecret,
    pluginVersion: '1.2.3',
    ...deps
  });
  const info = await srv.start();
  const baseUrl = `http://127.0.0.1:${info.port}`;

  try {
    // D2: wrong token -> 401
    const badLogin = await httpRequest(`${baseUrl}/?token=wrong-token-of-diff-len`);
    assert.equal(badLogin.status, 401);
    assert.deepEqual(badLogin.json, { ok: false, error: 'UNAUTHORIZED' });
    assertSecurityHeaders(badLogin.headers);

    const sameLenBad = await httpRequest(`${baseUrl}/?token=${'x'.repeat(pairingToken.length)}`);
    assert.equal(sameLenBad.status, 401);

    // D2: valid token -> 302 redirect stripping token + HttpOnly; SameSite=Strict cookie
    const goodLogin = await httpRequest(`${baseUrl}/?token=${pairingToken}`);
    assert.equal(goodLogin.status, 302);
    assert.equal(goodLogin.headers.location, '/');
    assertSecurityHeaders(goodLogin.headers);
    const setCookie = String(goodLogin.headers['set-cookie'] || '');
    assert.match(setCookie, new RegExp(`agy_web_sid=${sessionSecret}`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//i);
    const cookieHeader = setCookie.split(';')[0];

    // D3: unauthenticated API -> 401
    const unauth = await httpRequest(`${baseUrl}/api/v1/sessions`);
    assert.equal(unauth.status, 401);
    assert.deepEqual(unauth.json, { ok: false, error: 'UNAUTHORIZED' });
    assertSecurityHeaders(unauth.headers);

    // D3: cookie-authenticated GET works
    const authedGet = await httpRequest(`${baseUrl}/api/v1/sessions?limit=10`, {
      headers: { Cookie: cookieHeader }
    });
    assert.equal(authedGet.status, 200);
    assert.equal(authedGet.json.ok, true);
    assertSecurityHeaders(authedGet.headers);

    // D3: cookie-authenticated POST without X-Agy-Csrf -> 403 CSRF_REQUIRED
    const noCsrf = await httpRequest(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'Content-Type': 'application/json' },
      body: { title: 'Blocked' }
    });
    assert.equal(noCsrf.status, 403);
    assert.deepEqual(noCsrf.json, { ok: false, error: 'CSRF_REQUIRED' });
    assertSecurityHeaders(noCsrf.headers);

    // D3: cookie-authenticated POST with X-Agy-Csrf but cross-origin Origin -> 403 CSRF_REQUIRED
    const evilOrigin = await httpRequest(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'X-Agy-Csrf': '1',
        Origin: 'http://evil.attacker.test',
        'Content-Type': 'application/json'
      },
      body: { title: 'Blocked Origin' }
    });
    assert.equal(evilOrigin.status, 403);
    assert.deepEqual(evilOrigin.json, { ok: false, error: 'CSRF_REQUIRED' });

    const diffPortOrigin = await httpRequest(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'X-Agy-Csrf': '1',
        Origin: `http://127.0.0.1:${info.port + 1}`,
        'Content-Type': 'application/json'
      },
      body: { title: 'Blocked Port' }
    });
    assert.equal(diffPortOrigin.status, 403);

    // D3: cookie-authenticated POST with X-Agy-Csrf and same-origin Origin -> 200
    const okPost = await httpRequest(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'X-Agy-Csrf': '1',
        Origin: baseUrl,
        'Content-Type': 'application/json'
      },
      body: { title: 'Allowed' }
    });
    assert.equal(okPost.status, 200);
    assert.equal(okPost.json.cascadeId, 'c-new');
    assertSecurityHeaders(okPost.headers);

    // Bearer token auth + remaining endpoints
    const bearer = { Authorization: `Bearer ${pairingToken}`, 'Content-Type': 'application/json' };
    const health = await httpRequest(`${baseUrl}/api/v1/health`, { headers: bearer });
    assert.equal(health.status, 200);
    assert.equal(health.json.pluginVersion, '1.2.3');

    const detail = await httpRequest(`${baseUrl}/api/v1/sessions/c1`, { headers: bearer });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.session.cascadeId, 'c1');

    const detailMissing = await httpRequest(`${baseUrl}/api/v1/sessions/missing`, { headers: bearer });
    assert.equal(detailMissing.status, 404);

    const badMsg = await httpRequest(`${baseUrl}/api/v1/sessions/c1/messages`, {
      method: 'POST',
      headers: bearer,
      body: { text: '   ' }
    });
    assert.equal(badMsg.status, 400);

    const okMsg = await httpRequest(`${baseUrl}/api/v1/sessions/c1/messages`, {
      method: 'POST',
      headers: bearer,
      body: { text: 'hello' }
    });
    assert.equal(okMsg.status, 200);

    const cancelRes = await httpRequest(`${baseUrl}/api/v1/sessions/c1/cancel`, {
      method: 'POST',
      headers: bearer,
      body: {}
    });
    assert.equal(cancelRes.status, 200);

    const approveRes = await httpRequest(`${baseUrl}/api/v1/sessions/c1/steps/2/approve`, {
      method: 'POST',
      headers: bearer,
      body: { decision: 'accept' }
    });
    assert.equal(approveRes.status, 501);
    assert.equal(approveRes.json.error, 'APPROVAL_RPC_UNAVAILABLE_IN_2_34');
    assert.equal(approveRes.json.supported, false);

    assert.equal((await httpRequest(`${baseUrl}/api/v1/models`, { headers: bearer })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/fs/tree?root=/tmp&path=&depth=2`, { headers: bearer })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/fs/read?root=/tmp&path=a.txt`, { headers: bearer })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/fs/write`, { method: 'PUT', headers: bearer, body: { root: '/tmp', path: 'a.txt', content: 'hi' } })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/git/diff?root=/tmp`, { headers: bearer })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/artifacts?sessionId=c1`, { headers: bearer })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/artifacts?sessionId=c1&file=plan.md`, { headers: bearer })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/host/plugins`, { headers: bearer })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/host/plugins/agy-daddy.context/enable`, { method: 'POST', headers: bearer, body: {} })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/host/settings`, { headers: bearer })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/host/settings`, { method: 'PUT', headers: bearer, body: { patch: { theme: 'light' } } })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/host/plugins/agy-daddy.web/settings`, { headers: bearer })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/host/plugins/agy-daddy.web/settings`, { method: 'PUT', headers: bearer, body: { patch: { port: 18766 } } })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/host/commands/agy-daddy.web.status`, { method: 'POST', headers: bearer, body: { args: [] } })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/host/doctor`, { headers: bearer })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/topbar`, { headers: bearer })).status, 200);
  } finally {
    await srv.stop();
  }
});

test('D4: SSE real-time broadcast, Last-Event-ID replay, session.resync out-of-window, heartbeat, and stop()', async () => {
  const pairingToken = 'sse-token-999';
  const srv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken,
    ringBufferSize: 3,
    heartbeatIntervalMs: 60
  });
  const info = await srv.start();
  const baseUrl = `http://127.0.0.1:${info.port}`;
  const authHeaders = { Authorization: `Bearer ${pairingToken}` };

  try {
    const client1 = await openSse(`${baseUrl}/api/v1/stream?sessionId=s1`, authHeaders);
    assert.equal(client1.status, 200);
    assertSecurityHeaders(client1.headers);

    srv.broadcast('session.delta', { step: 1 }, { sessionId: 's1' });
    srv.broadcast('session.delta', { other: true }, { sessionId: 's2' });
    srv.broadcast('state.patch', { key: 'state:context.snapshot@1', value: { pct: 50 } });

    const ev1 = await client1.waitForEvent((e) => e.id === '1');
    const ev3 = await client1.waitForEvent((e) => e.id === '3');
    assert.equal(ev1.event, 'session.delta');
    assert.equal(ev3.event, 'state.patch');
    assert.equal(client1.events.some((e) => e.id === '2'), false, 's2 event must not leak to s1 stream');

    // Verify periodic heartbeat arrives
    const hb = await client1.waitForEvent((e) => e.event === 'heartbeat', 1000);
    assert.equal(typeof hb.json?.ts, 'number');
    client1.close();

    // Reconnect with Last-Event-ID: 1 -> should replay id: 3 (not id: 1)
    const client2 = await openSse(`${baseUrl}/api/v1/stream?sessionId=s1`, {
      ...authHeaders,
      'Last-Event-ID': '1'
    });
    const replayed = await client2.waitForEvent((e) => e.id === '3');
    assert.equal(replayed.event, 'state.patch');
    assert.equal(client2.events.some((e) => e.id === '1'), false);
    client2.close();

    // Push past ringBufferSize=3 (ids 4, 5, 6 -> buffer keeps 4, 5, 6)
    srv.broadcast('session.delta', { step: 4 }, { sessionId: 's1' });
    srv.broadcast('session.delta', { step: 5 }, { sessionId: 's1' });
    srv.broadcast('session.delta', { step: 6 }, { sessionId: 's1' });

    // Reconnect with Last-Event-ID: 1 (older than oldest buffered id 4) -> emits session.resync
    const client3 = await openSse(`${baseUrl}/api/v1/stream?sessionId=s1`, {
      ...authHeaders,
      'Last-Event-ID': '1'
    });
    const resyncEv = await client3.waitForEvent((e) => e.event === 'session.resync');
    assert.equal(resyncEv.event, 'session.resync');
    // leave client3 open to verify stop() cleanly closes active SSE streams
  } finally {
    await srv.stop();
  }
});

test('D5: staticDir hosting with SPA fallback and JSON 404 for unknown /api/v1/* routes', async () => {
  const tmpStatic = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-static-'));
  fs.mkdirSync(path.join(tmpStatic, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(tmpStatic, 'index.html'), '<!doctype html><html><body>SPA SHELL</body></html>', 'utf8');
  fs.writeFileSync(path.join(tmpStatic, 'assets', 'app.js'), 'console.log("agy-web");', 'utf8');
  fs.writeFileSync(path.join(tmpStatic, 'assets', 'app-abc123.js'), 'console.log("agy-web-hashed");', 'utf8');

  const pairingToken = 'static-token-111';
  const srv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken,
    staticDir: tmpStatic
  });
  const info = await srv.start();
  const baseUrl = `http://127.0.0.1:${info.port}`;

  try {
    const spaRoot = await httpRequest(`${baseUrl}/`);
    assert.equal(spaRoot.status, 200);
    assert.match(String(spaRoot.headers['content-type']), /text\/html/);
    assert.match(spaRoot.text, /SPA SHELL/);
    assertSecurityHeaders(spaRoot.headers);

    const spaRoute = await httpRequest(`${baseUrl}/settings`);
    assert.equal(spaRoute.status, 200);
    assert.match(String(spaRoute.headers['content-type']), /text\/html/);
    assert.match(spaRoute.text, /SPA SHELL/);

    const assetRes = await httpRequest(`${baseUrl}/assets/app.js`);
    assert.equal(assetRes.status, 200);
    assert.match(String(assetRes.headers['content-type']), /javascript/);
    assert.match(assetRes.text, /agy-web/);
    assert.equal(assetRes.headers['cache-control'], 'public, max-age=31536000, immutable');

    const hashedAssetRes = await httpRequest(`${baseUrl}/assets/app-abc123.js`);
    assert.equal(hashedAssetRes.status, 200);
    assert.equal(hashedAssetRes.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(spaRoot.headers['cache-control'], 'no-store');

    const unknownApi = await httpRequest(`${baseUrl}/api/v1/not-exist`, {
      headers: { Authorization: `Bearer ${pairingToken}` }
    });
    assert.equal(unknownApi.status, 404);
    assert.deepEqual(unknownApi.json, { ok: false, error: 'NOT_FOUND' });
    assertSecurityHeaders(unknownApi.headers);
  } finally {
    await srv.stop();
    fs.rmSync(tmpStatic, { recursive: true, force: true });
  }
});

test('D6: CSP allows inline styles + safe same-origin frames/images and per-sessionId SSE delta pump emits changes and cleans up on disconnect/stop', async () => {
  assert.equal(
    SECURITY_HEADERS['Content-Security-Policy'],
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob: data:; object-src 'self' blob:; frame-ancestors 'none'"
  );

  const pairingToken = 'delta-pump-token-123';
  const pollCalls = [];
  let nextPollResult = {
    ok: true,
    cascadeId: 's-live',
    status: 'CASCADE_RUN_STATUS_RUNNING',
    totalSteps: 1,
    stepOffset: 0,
    events: [{ seq: 0, kind: 'user', status: 'done', payload: { text: 'hello' } }],
    hasChanges: true
  };

  const srv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken,
    deltaPollIntervalMs: 35,
    harnessAdapter: {
      async pollDelta(sessionId) {
        pollCalls.push(sessionId);
        return { ...nextPollResult, cascadeId: sessionId };
      },
      async sendMessage(id) {
        nextPollResult = {
          ok: true,
          cascadeId: id,
          status: 'CASCADE_RUN_STATUS_RUNNING',
          totalSteps: 2,
          stepOffset: 1,
          events: [{ seq: 1, kind: 'thinking_and_text', status: 'generating', payload: { text: 'working' } }],
          hasChanges: true
        };
        return { ok: true, cascadeId: id };
      },
      async cancelSession(id) {
        nextPollResult = {
          ok: true,
          cascadeId: id,
          status: 'CASCADE_RUN_STATUS_CANCELED',
          totalSteps: 2,
          stepOffset: 2,
          events: [],
          hasChanges: false
        };
        return { ok: true, cascadeId: id };
      }
    }
  });

  const info = await srv.start();
  const baseUrl = `http://127.0.0.1:${info.port}`;
  const authHeaders = { Authorization: `Bearer ${pairingToken}`, 'Content-Type': 'application/json' };

  try {
    const client1 = await openSse(`${baseUrl}/api/v1/stream?sessionId=s-live`, authHeaders);
    const ev1 = await client1.waitForEvent((e) => e.event === 'session.delta');
    assert.equal(ev1.json.cascadeId, 's-live');
    assert.equal(ev1.json.status, 'CASCADE_RUN_STATUS_RUNNING');
    assert.equal(ev1.json.totalSteps, 1);
    assert.equal(ev1.json.stepOffset, 0);
    assert.equal(ev1.json.events.length, 1);
    assert.equal(srv._sessionPollers.size, 1);

    // Subsequent identical idle poll (hasChanges: false, same status) must not emit duplicate delta
    const countAfterFirst = client1.events.filter((e) => e.event === 'session.delta').length;
    nextPollResult = {
      ok: true,
      cascadeId: 's-live',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      totalSteps: 1,
      stepOffset: 0,
      events: [],
      hasChanges: false
    };
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(client1.events.filter((e) => e.event === 'session.delta').length, countAfterFirst);

    // Open second client for same session; closing first client must keep poller alive
    const client2 = await openSse(`${baseUrl}/api/v1/stream?sessionId=s-live`, authHeaders);
    client1.close();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(srv._sessionPollers.size, 1);

    // POST /messages triggers immediate delta poll
    const msgRes = await httpRequest(`${baseUrl}/api/v1/sessions/s-live/messages`, {
      method: 'POST',
      headers: authHeaders,
      body: { text: 'ping' }
    });
    assert.equal(msgRes.status, 200);
    const ev2 = await client2.waitForEvent((e) => e.event === 'session.delta' && e.json?.totalSteps === 2);
    assert.equal(ev2.json.events[0].seq, 1);

    // POST /cancel triggers immediate delta poll and status change emission even when hasChanges=false
    const cancelRes = await httpRequest(`${baseUrl}/api/v1/sessions/s-live/cancel`, {
      method: 'POST',
      headers: authHeaders,
      body: {}
    });
    assert.equal(cancelRes.status, 200);
    const ev3 = await client2.waitForEvent((e) => e.event === 'session.delta' && e.json?.status === 'CASCADE_RUN_STATUS_CANCELED');
    assert.equal(ev3.json.stepOffset, 2);
    assert.deepEqual(ev3.json.events, []);

    // Closing last client for s-live tears down poller immediately
    client2.close();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(srv._sessionPollers.size, 0);
    const countAfterDisconnect = pollCalls.length;
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(pollCalls.length, countAfterDisconnect);

    // Open client for s-stop and verify stop() tears down active pollers
    await openSse(`${baseUrl}/api/v1/stream?sessionId=s-stop`, authHeaders);
    assert.equal(srv._sessionPollers.size, 1);
  } finally {
    await srv.stop();
  }

  assert.equal(srv._sessionPollers.size, 0);
  const countAtStop = pollCalls.length;
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(pollCalls.length, countAtStop);
});

test('D7: host locale sync + SSE broadcast, web-scoped plugins/settings, workspace projects/groups/pinning, and authorize-root', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-d7-'));
  const projDir = path.join(tmpBase, 'proj-alpha');
  const extraRootDir = path.join(tmpBase, 'extra-root');
  const defaultPathDir = path.join(tmpBase, 'default-ws');
  const fileInTmp = path.join(tmpBase, 'not-a-dir.txt');
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(extraRootDir, { recursive: true });
  fs.mkdirSync(defaultPathDir, { recursive: true });
  fs.writeFileSync(fileInTmp, 'hello', 'utf8');

  const metaStore = createWorkspaceMetaStore({ defaultBaseDir: defaultPathDir });
  const refreshedRoots = [];
  const createdSessions = [];
  let webSettings = { port: 18767, allowedRoots: [fs.realpathSync(projDir)] };
  let currentLocale = { locale: 'en', hostLang: 'en' };
  const proxyScopeCalls = [];

  const pairingToken = 'd7-token-xyz';
  const authHeaders = { Authorization: `Bearer ${pairingToken}`, 'Content-Type': 'application/json' };

  const srv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken,
    workspaceMetaStore: metaStore,
    refreshSessionRoots: (sessions) => refreshedRoots.push(sessions),
    harnessAdapter: {
      async listSessions() {
        return {
          ok: true,
          sessions: [
            {
              cascadeId: 's-proj',
              title: 'Alpha Task',
              lastModifiedTime: '2026-11-24T10:00:00Z',
              workspaceUri: url.pathToFileURL(projDir).href
            },
            {
              cascadeId: 's-free',
              title: 'Standalone Task',
              lastModifiedTime: '2026-11-24T11:00:00Z',
              workspaceUri: null
            }
          ]
        };
      },
      async createSession(payload) {
        createdSessions.push(payload);
        return { ok: true, cascadeId: `cid-${createdSessions.length}`, ...payload };
      }
    },
    hostProxy: {
      async getHostLocale() {
        return {
          ok: true,
          locale: currentLocale.locale,
          hostLang: currentLocale.hostLang,
          source: 'state:host.locale@1',
          supportedLanguages: [{ code: 'zh', bcp47: 'zh-CN', nativeName: '简体中文', shortLabel: '简中' }]
        };
      },
      async setHostLocale(val) {
        currentLocale = { locale: val === 'zh' ? 'zh-CN' : val, hostLang: val === 'zh-CN' ? 'zh' : val };
        return {
          ok: true,
          locale: currentLocale.locale,
          hostLang: currentLocale.hostLang,
          supportedLanguages: [{ code: 'zh', bcp47: 'zh-CN', nativeName: '简体中文', shortLabel: '简中' }]
        };
      },
      async getPlugins(opts) {
        proxyScopeCalls.push({ fn: 'getPlugins', opts });
        return { ok: true, scope: opts?.scope || 'all', plugins: [], catalog: [] };
      },
      async getPluginSettings(pluginId, opts) {
        proxyScopeCalls.push({ fn: 'getPluginSettings', pluginId, opts });
        if (pluginId === 'agy-daddy.web') {
          return { ok: true, values: { ...webSettings }, schema: { fields: [] } };
        }
        return { ok: true, scope: opts?.scope || 'all', values: { lang: 'zh' }, filteredDesktopFieldCount: 2 };
      },
      async setPluginSettings(pluginId, patch) {
        if (pluginId === 'agy-daddy.web') {
          webSettings = { ...webSettings, ...patch };
          return { ok: true, values: { ...webSettings } };
        }
        return { ok: true, values: patch };
      }
    }
  });

  const info = await srv.start();
  const baseUrl = `http://127.0.0.1:${info.port}`;

  try {
    // 1. Module 2: Host locale GET/PUT + SSE broadcast
    const sseClient = await openSse(`${baseUrl}/api/v1/stream`, authHeaders);
    const getLoc = await httpRequest(`${baseUrl}/api/v1/host/locale`, { headers: authHeaders });
    assert.equal(getLoc.status, 200);
    assert.equal(getLoc.json.locale, 'en');

    const putLoc = await httpRequest(`${baseUrl}/api/v1/host/locale`, {
      method: 'PUT',
      headers: authHeaders,
      body: { locale: 'zh-CN' }
    });
    assert.equal(putLoc.status, 200);
    assert.equal(putLoc.json.locale, 'zh-CN');
    assert.equal(putLoc.json.hostLang, 'zh');

    const localePatchEv = await sseClient.waitForEvent(
      (e) => e.event === 'state.patch' && e.json?.key === 'state:host.locale@1'
    );
    assert.equal(localePatchEv.json.value.bcp47, 'zh-CN');
    assert.equal(localePatchEv.json.value.lang, 'zh');
    sseClient.close();

    // 2. Module 5: scope=web query param passed to hostProxy
    const webPlugins = await httpRequest(`${baseUrl}/api/v1/host/plugins?scope=web`, { headers: authHeaders });
    assert.equal(webPlugins.status, 200);
    assert.equal(webPlugins.json.scope, 'web');

    const webPluginSettings = await httpRequest(`${baseUrl}/api/v1/host/plugins/agy-daddy.zh-cn/settings?scope=web`, {
      headers: authHeaders
    });
    assert.equal(webPluginSettings.status, 200);
    assert.equal(webPluginSettings.json.scope, 'web');
    assert.equal(webPluginSettings.json.filteredDesktopFieldCount, 2);
    assert.deepEqual(proxyScopeCalls[0], { fn: 'getPlugins', opts: { scope: 'web' } });
    assert.deepEqual(proxyScopeCalls[1], { fn: 'getPluginSettings', pluginId: 'agy-daddy.zh-cn', opts: { scope: 'web' } });

    // 3. Module 3: Project groups, projects, pinning, session creation & filtering
    const grpRes = await httpRequest(`${baseUrl}/api/v1/project-groups`, {
      method: 'POST',
      headers: authHeaders,
      body: { name: 'Core Repos' }
    });
    assert.equal(grpRes.status, 200);
    const groupId = grpRes.json.group.id;

    const grpListRes = await httpRequest(`${baseUrl}/api/v1/project-groups`, { headers: authHeaders });
    assert.equal(grpListRes.status, 200);
    assert.equal(grpListRes.json.groups.length, 1);

    const patchGrp = await httpRequest(`${baseUrl}/api/v1/project-groups/${groupId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: { collapsed: true }
    });
    assert.equal(patchGrp.status, 200);
    assert.equal(patchGrp.json.group.collapsed, true);

    const projRes = await httpRequest(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: { name: 'Alpha', rootPath: projDir, groupId }
    });
    assert.equal(projRes.status, 200);
    const projectId = projRes.json.project.id;

    const patchProj = await httpRequest(`${baseUrl}/api/v1/projects/${projectId}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: { name: 'Alpha Renamed' }
    });
    assert.equal(patchProj.status, 200);
    assert.equal(patchProj.json.project.name, 'Alpha Renamed');

    const listProj = await httpRequest(`${baseUrl}/api/v1/projects`, { headers: authHeaders });
    assert.equal(listProj.status, 200);
    assert.equal(listProj.json.projects[0].sessionCount, 1);

    // Pin session s-proj and verify enriched order & projectId filters
    const pinRes = await httpRequest(`${baseUrl}/api/v1/sessions/s-proj/pin`, {
      method: 'PUT',
      headers: authHeaders,
      body: { pinned: true }
    });
    assert.equal(pinRes.status, 200);
    assert.equal(pinRes.json.pinned, true);

    const sessionsAll = await httpRequest(`${baseUrl}/api/v1/sessions`, { headers: authHeaders });
    assert.equal(sessionsAll.status, 200);
    assert.equal(sessionsAll.json.sessions[0].cascadeId, 's-proj');
    assert.equal(sessionsAll.json.sessions[0].pinned, true);
    assert.equal(sessionsAll.json.sessions[0].projectId, projectId);
    assert.ok(refreshedRoots.length >= 1);

    const sessionsByProj = await httpRequest(`${baseUrl}/api/v1/sessions?projectId=${encodeURIComponent(projectId)}`, {
      headers: authHeaders
    });
    assert.equal(sessionsByProj.json.sessions.length, 1);
    assert.equal(sessionsByProj.json.sessions[0].cascadeId, 's-proj');

    const sessionsNone = await httpRequest(`${baseUrl}/api/v1/sessions?projectId=__none__`, {
      headers: authHeaders
    });
    assert.equal(sessionsNone.json.sessions.length, 1);
    assert.equal(sessionsNone.json.sessions[0].cascadeId, 's-free');

    // Reassign s-free to projectId
    const assignRes = await httpRequest(`${baseUrl}/api/v1/sessions/s-free/project`, {
      method: 'PUT',
      headers: authHeaders,
      body: { projectId }
    });
    assert.equal(assignRes.status, 200);
    assert.equal(assignRes.json.projectId, projectId);

    // Create session inside project & standalone
    const createInProj = await httpRequest(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders,
      body: { title: 'In Proj', projectId }
    });
    assert.equal(createInProj.status, 200);
    assert.equal(createInProj.json.projectId, projectId);
    assert.equal(createInProj.json.workspaceUri, url.pathToFileURL(projDir).href);

    const createMissingProj = await httpRequest(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders,
      body: { title: 'Bad Proj', projectId: 'proj_missing' }
    });
    assert.equal(createMissingProj.status, 404);

    const createStandalone = await httpRequest(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders,
      body: { title: 'Standalone', standalone: true }
    });
    assert.equal(createStandalone.status, 200);
    assert.equal(createStandalone.json.workspaceUri, url.pathToFileURL(defaultPathDir).href);
    assert.equal(metaStore.getState().sessionProjectOverrides[createStandalone.json.cascadeId], null);

    // Update default-path
    const newDefaultDir = path.join(tmpBase, 'new-default');
    fs.mkdirSync(newDefaultDir, { recursive: true });
    const putDefaultPath = await httpRequest(`${baseUrl}/api/v1/workspace/default-path`, {
      method: 'PUT',
      headers: authHeaders,
      body: { defaultSessionPath: newDefaultDir }
    });
    assert.equal(putDefaultPath.status, 200);
    assert.equal(putDefaultPath.json.defaultSessionPath, newDefaultDir);

    // Delete project & group
    assert.equal((await httpRequest(`${baseUrl}/api/v1/projects/${projectId}`, { method: 'DELETE', headers: authHeaders })).status, 200);
    assert.equal((await httpRequest(`${baseUrl}/api/v1/project-groups/${groupId}`, { method: 'DELETE', headers: authHeaders })).status, 200);

    // 4. Module 4: authorize-root validation & persistence
    const forbidRes = await httpRequest(`${baseUrl}/api/v1/workspace/authorize-root`, {
      method: 'POST',
      headers: authHeaders,
      body: { root: '/etc' }
    });
    assert.equal(forbidRes.status, 403);

    const missingRes = await httpRequest(`${baseUrl}/api/v1/workspace/authorize-root`, {
      method: 'POST',
      headers: authHeaders,
      body: { root: path.join(tmpBase, 'does-not-exist') }
    });
    assert.equal(missingRes.status, 404);

    const fileRes = await httpRequest(`${baseUrl}/api/v1/workspace/authorize-root`, {
      method: 'POST',
      headers: authHeaders,
      body: { root: fileInTmp }
    });
    assert.equal(fileRes.status, 400);

    const authOk = await httpRequest(`${baseUrl}/api/v1/workspace/authorize-root`, {
      method: 'POST',
      headers: authHeaders,
      body: { root: extraRootDir }
    });
    assert.equal(authOk.status, 200);
    const realExtra = fs.realpathSync(extraRootDir);
    assert.equal(authOk.json.root, realExtra);
    assert.equal(authOk.json.allowedRoots.includes(realExtra), true);

    // Duplicate authorize-root is deduped
    const authDup = await httpRequest(`${baseUrl}/api/v1/workspace/authorize-root`, {
      method: 'POST',
      headers: authHeaders,
      body: { root: extraRootDir }
    });
    assert.equal(authDup.status, 200);
    assert.equal(authDup.json.allowedRoots.filter((r) => r === realExtra).length, 1);
  } finally {
    await srv.stop();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('D8: internal/subagent filtering, user-created session protection, read-state + completion SSE sync, raw artifact streaming, and previewers', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-d8-'));
  const brainDir = path.join(tmpBase, 'brain');
  const sid = '11111111-aaaa-bbbb-cccc-222222222222';
  const sessionDir = path.join(brainDir, sid);
  const outsideDir = path.join(tmpBase, 'outside');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const pdfBuf = Buffer.from('%PDF-1.4\n%test\n', 'utf8');
  const svgBuf = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>', 'utf8');
  const htmlBuf = Buffer.from('<!doctype html><html><body><h1>Report</h1></body></html>', 'utf8');

  fs.writeFileSync(path.join(sessionDir, 'shot.png'), pngBuf);
  fs.writeFileSync(path.join(sessionDir, 'doc.pdf'), pdfBuf);
  fs.writeFileSync(path.join(sessionDir, 'chart.svg'), svgBuf);
  fs.writeFileSync(path.join(sessionDir, 'report.html'), htmlBuf);
  fs.writeFileSync(path.join(outsideDir, 'secret.png'), pngBuf);
  fs.symlinkSync(path.join(outsideDir, 'secret.png'), path.join(sessionDir, 'escape.png'));

  const metaStore = createWorkspaceMetaStore({
    defaultBaseDir: path.join(tmpBase, 'default-ws'),
    conversationDbPath: null,
    sharedReadStatePath: null
  });
  const workspaceService = createWorkspaceService({ allowedRoots: [], brainDir });

  const hostState = new Map([
    ['state:host.artifact-previewers@1', {
      key: 'state:host.artifact-previewers@1',
      value: [{
        id: 'plugin.mermaid',
        name: 'Mermaid',
        extensions: ['mmd'],
        mimeTypes: ['text/vnd.mermaid'],
        pluginId: 'agy-daddy.mermaid',
        renderKind: 'plugin_html'
      }]
    }]
  ]);
  const hostProxy = createHostProxy({
    host: {
      state: {
        get(key) { return hostState.get(key) || null; },
        set(key, value) { hostState.set(key, { key, value }); }
      },
      services: {
        async call(serviceName, method, args) {
          if (serviceName === 'agy-daddy.mermaid' && method === 'previewArtifact') {
            return {
              ok: true,
              value: { ok: true, kind: 'html', content: `<div>${args[0].file}</div>`, mime: 'text/html' }
            };
          }
          return { ok: false, unavailable: true, value: null };
        }
      }
    }
  });

  const readStateChangedCalls = [];
  let createdCount = 0;
  let pollPhase = 'running';
  const sessionList = [
    {
      cascadeId: 's-main',
      title: 'Main Session',
      status: 'CASCADE_RUN_STATUS_IDLE',
      stepCount: 3,
      lastModifiedTime: '2026-11-24T01:00:00Z'
    },
    {
      cascadeId: 's-sub',
      title: 'Subagent Worker',
      status: 'CASCADE_RUN_STATUS_IDLE',
      stepCount: 5,
      parentConversationId: 's-main',
      nestingDepth: 1,
      agentName: 'researcher',
      lastModifiedTime: '2026-11-24T02:00:00Z'
    },
    {
      cascadeId: 's-internal-src',
      title: '',
      hasTitle: false,
      titleSource: 'none',
      source: 'INTERNAL_SWARM',
      status: 'CASCADE_RUN_STATUS_IDLE',
      stepCount: 2,
      lastModifiedTime: '2026-11-24T03:00:00Z'
    }
  ];

  const pairingToken = 'd8-token-999';
  const authHeaders = { Authorization: `Bearer ${pairingToken}`, 'Content-Type': 'application/json' };

  const srv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken,
    deltaPollIntervalMs: 30,
    workspaceService,
    workspaceMetaStore: metaStore,
    hostProxy,
    onReadStateChanged: () => {
      readStateChangedCalls.push(metaStore.getReadStateSnapshot());
    },
    harnessAdapter: {
      async listSessions() {
        return { ok: true, sessions: [...sessionList] };
      },
      async createSession(payload) {
        createdCount += 1;
        const cid = `s-user-${createdCount}`;
        sessionList.push({
          cascadeId: cid,
          title: payload.title || '',
          hasTitle: Boolean(payload.title),
          titleSource: payload.title ? 'title' : 'none',
          source: 'INTERNAL_TEST',
          status: 'CASCADE_RUN_STATUS_IDLE',
          stepCount: 0,
          lastModifiedTime: new Date().toISOString()
        });
        return { ok: true, cascadeId: cid };
      },
      async pollDelta(sessionId) {
        if (pollPhase === 'running') {
          return {
            ok: true,
            cascadeId: sessionId,
            status: 'CASCADE_RUN_STATUS_RUNNING',
            totalSteps: 4,
            stepOffset: 3,
            events: [{ seq: 3, kind: 'thinking_and_text', status: 'generating', payload: { text: 'working' } }],
            hasChanges: true
          };
        }
        return {
          ok: true,
          cascadeId: sessionId,
          status: 'CASCADE_RUN_STATUS_IDLE',
          totalSteps: 5,
          stepOffset: 4,
          events: [{ seq: 4, kind: 'thinking_and_text', status: 'done', payload: { text: 'finished' } }],
          hasChanges: true
        };
      }
    }
  });

  const info = await srv.start();
  const baseUrl = `http://127.0.0.1:${info.port}`;

  try {
    // 1. Default GET /api/v1/sessions hides internal/subagent sessions and reports hiddenInternalCount
    const defaultList = await httpRequest(`${baseUrl}/api/v1/sessions`, { headers: authHeaders });
    assert.equal(defaultList.status, 200);
    assert.equal(defaultList.json.hiddenInternalCount, 2);
    assert.deepEqual(defaultList.json.sessions.map((s) => s.cascadeId), ['s-main']);

    // ?includeInternal=1 reveals internal/subagent sessions
    const fullList = await httpRequest(`${baseUrl}/api/v1/sessions?includeInternal=1`, { headers: authHeaders });
    assert.equal(fullList.status, 200);
    assert.equal(fullList.json.hiddenInternalCount, 2);
    assert.equal(fullList.json.sessions.length, 3);
    assert.equal(fullList.json.sessions.find((s) => s.cascadeId === 's-sub').isSubagent, true);

    // 2. POST /api/v1/sessions marks user-created protection & initialized read state (not unread, not hidden)
    const created = await httpRequest(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders,
      body: { standalone: true }
    });
    assert.equal(created.status, 200);
    const createdId = created.json.cascadeId;
    assert.ok(metaStore.getState().userCreatedSessions[createdId]);
    assert.equal(metaStore.getState().sessionReadState[createdId].lastReadStepCount, 0);

    const afterCreateList = await httpRequest(`${baseUrl}/api/v1/sessions`, { headers: authHeaders });
    const createdEntry = afterCreateList.json.sessions.find((s) => s.cascadeId === createdId);
    assert.ok(createdEntry, 'User-created 0-step session must stay visible');
    assert.equal(createdEntry.unread, false);

    // 3. PUT /api/v1/sessions/:id/read updates read state, calls onReadStateChanged, and broadcasts state.patch to all SSE tabs
    const tabAll = await openSse(`${baseUrl}/api/v1/stream`, authHeaders);
    const tabOther = await openSse(`${baseUrl}/api/v1/stream?sessionId=other-session`, authHeaders);

    const readRes = await httpRequest(`${baseUrl}/api/v1/sessions/s-main/read`, {
      method: 'PUT',
      headers: authHeaders,
      body: { lastReadStepCount: 3 }
    });
    assert.equal(readRes.status, 200);
    assert.equal(readRes.json.cascadeId, 's-main');
    assert.equal(readRes.json.lastReadStepCount, 3);
    assert.ok(readStateChangedCalls.length >= 1);

    const patchTabAll = await tabAll.waitForEvent(
      (e) => e.event === 'state.patch' && e.json?.key === 'state:session.readState@1' && e.json?.value?.sessions?.['s-main']?.lastReadStepCount === 3
    );
    const patchTabOther = await tabOther.waitForEvent(
      (e) => e.event === 'state.patch' && e.json?.key === 'state:session.readState@1' && e.json?.value?.sessions?.['s-main']?.lastReadStepCount === 3
    );
    assert.ok(patchTabAll);
    assert.ok(patchTabOther);

    // 4. Poller transition RUNNING -> IDLE records completion and broadcasts state.patch with completedSessionId
    const liveClient = await openSse(`${baseUrl}/api/v1/stream?sessionId=s-main`, authHeaders);
    await liveClient.waitForEvent((e) => e.event === 'session.delta' && e.json?.status === 'CASCADE_RUN_STATUS_RUNNING');
    pollPhase = 'idle';
    const compEv = await tabOther.waitForEvent(
      (e) => e.event === 'state.patch' && e.json?.key === 'state:session.readState@1' && e.json?.value?.completedSessionId === 's-main'
    );
    assert.equal(compEv.json.value.completedSessionId, 's-main');
    assert.equal(metaStore.getState().sessionCompletionTimes['s-main'].lastCompletedStepCount, 5);

    tabAll.close();
    tabOther.close();
    liveClient.close();

    // 5. GET /api/v1/artifacts/:sessionId/raw (png/pdf/svg/html, HEAD, frame-ancestors 'self', traversal 403)
    const pngRes = await httpRequest(`${baseUrl}/api/v1/artifacts/${sid}/raw?file=shot.png`, { headers: authHeaders });
    assert.equal(pngRes.status, 200);
    assert.equal(pngRes.headers['content-type'], 'image/png');
    assert.equal(pngRes.headers['x-content-type-options'], 'nosniff');
    assert.equal(pngRes.headers['content-disposition'], 'inline; filename="shot.png"');
    assert.equal(pngRes.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'self'");
    assert.equal(Buffer.compare(pngRes.buffer, pngBuf), 0);

    const pngHead = await httpRequest(`${baseUrl}/api/v1/artifacts/${sid}/raw?file=shot.png`, {
      method: 'HEAD',
      headers: authHeaders
    });
    assert.equal(pngHead.status, 200);
    assert.equal(pngHead.headers['content-length'], String(pngBuf.length));
    assert.equal(pngHead.buffer.length, 0);

    const pdfRes = await httpRequest(`${baseUrl}/api/v1/artifacts/${sid}/raw?file=doc.pdf`, { headers: authHeaders });
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers['content-type'], 'application/pdf');
    assert.equal(pdfRes.headers['content-security-policy'], "default-src 'none'; object-src 'self'; frame-ancestors 'self'");
    assert.equal(Buffer.compare(pdfRes.buffer, pdfBuf), 0);

    const svgRes = await httpRequest(`${baseUrl}/api/v1/artifacts/${sid}/raw?file=chart.svg`, { headers: authHeaders });
    assert.equal(svgRes.status, 200);
    assert.equal(svgRes.headers['content-type'], 'image/svg+xml; charset=utf-8');
    assert.equal(
      svgRes.headers['content-security-policy'],
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'"
    );

    const htmlRes = await httpRequest(`${baseUrl}/api/v1/artifacts/${sid}/raw?file=report.html`, { headers: authHeaders });
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(String(htmlRes.headers['content-security-policy']), /sandbox/);
    assert.match(String(htmlRes.headers['content-security-policy']), /frame-ancestors 'self'/);

    const travRes = await httpRequest(`${baseUrl}/api/v1/artifacts/${sid}/raw?file=../outside/secret.png`, { headers: authHeaders });
    assert.equal(travRes.status, 403);
    const escRes = await httpRequest(`${baseUrl}/api/v1/artifacts/${sid}/raw?file=escape.png`, { headers: authHeaders });
    assert.equal(escRes.status, 403);

    // 6. GET /api/v1/artifacts/previewers and POST /api/v1/artifacts/:sessionId/plugin-preview
    const prevRes = await httpRequest(`${baseUrl}/api/v1/artifacts/previewers`, { headers: authHeaders });
    assert.equal(prevRes.status, 200);
    assert.equal(prevRes.json.ok, true);
    assert.equal(prevRes.json.builtins.length, 5);
    assert.equal(prevRes.json.plugins[0].id, 'plugin.mermaid');

    const renderRes = await httpRequest(`${baseUrl}/api/v1/artifacts/${sid}/plugin-preview`, {
      method: 'POST',
      headers: authHeaders,
      body: { pluginId: 'agy-daddy.mermaid', file: 'flow.mmd', mime: 'text/vnd.mermaid' }
    });
    assert.equal(renderRes.status, 200);
    assert.equal(renderRes.json.ok, true);
    assert.equal(renderRes.json.kind, 'html');
    assert.equal(renderRes.json.content, '<div>flow.mmd</div>');
  } finally {
    await srv.stop();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('D9: POST /api/v1/sessions supports App-synced/implicit projects with enriched summary, GET /api/v1/projects uses limit 500, and GET /api/v1/remote/status serves QR', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ws-d9-'));
  const implicitDir = path.resolve('/Volumes/mock/d9-implicit-proj');
  const appDir = path.resolve('/Volumes/mock/d9-app-proj');
  const files = new Map();
  const storage = {
    readJson(name, fallback = null) {
      if (!files.has(name)) return { ok: true, exists: false, data: fallback };
      return { ok: true, exists: true, data: JSON.parse(files.get(name)) };
    },
    writeJson(name, data) {
      files.set(name, JSON.stringify(data));
      return { ok: true };
    }
  };
  const vscdbPath = path.join(tmpBase, 'state.vscdb');

  // Create state.vscdb with appDir
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(vscdbPath);
  const uri = url.pathToFileURL(appDir).href;
  const buf = Buffer.concat([
    Buffer.from([0x0a, 0x01, 0x0a, Buffer.byteLength(uri, 'utf8')]),
    Buffer.from(uri, 'utf8'),
    Buffer.from([0x12, 0x02, 0x08, 0x01])
  ]);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB);');
  db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
    'antigravityUnifiedStateSync.sidebarWorkspaces',
    buf.toString('base64')
  );
  db.close();

  const metaStore = createWorkspaceMetaStore({
    storage,
    defaultBaseDir: path.join(tmpBase, 'default-ws'),
    stateVscdbPath: vscdbPath,
    conversationDbPath: null,
    sharedReadStatePath: null
  });

  const listCalls = [];
  let createdSeq = 0;
  const adapter = {
    async listSessions(opts = {}) {
      listCalls.push(opts);
      return {
        ok: true,
        sessions: [
          {
            cascadeId: 's-implicit-seed',
            title: 'Implicit Seed',
            hasTitle: true,
            stepCount: 2,
            status: 'CASCADE_RUN_STATUS_IDLE',
            lastModifiedTime: '2026-11-24T01:00:00.000Z',
            workspaceUri: url.pathToFileURL(implicitDir).href
          }
        ]
      };
    },
    async createSession(payload = {}) {
      createdSeq += 1;
      return {
        ok: true,
        cascadeId: `new-cid-${createdSeq}`,
        ...(payload.title ? { title: payload.title } : {}),
        ...(payload.workspaceUri ? { workspaceUri: payload.workspaceUri } : {})
      };
    }
  };

  const hostProxy = {
    async getRemoteStatus() {
      return {
        ok: true,
        available: true,
        running: true,
        port: 18765,
        pairingUrl: 'http://192.168.1.99:18765/?t=tok',
        qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
      };
    }
  };

  const srv = createWebServer({
    port: 0,
    pairingToken: 'd9-tok',
    harnessAdapter: adapter,
    workspaceMetaStore: metaStore,
    hostProxy
  });
  const info = await srv.start();
  const baseUrl = info.url;
  const authHeaders = { Authorization: 'Bearer d9-tok' };

  try {
    // 1. GET /api/v1/projects calls listSessions({ limit: 500 }) and returns both app:... and implicit:...
    const projRes = await httpRequest(`${baseUrl}/api/v1/projects`, { headers: authHeaders });
    assert.equal(projRes.status, 200);
    assert.equal(listCalls[0].limit, 500);
    const appProj = projRes.json.projects.find((p) => p.rootPath === appDir);
    const impProj = projRes.json.projects.find((p) => p.rootPath === implicitDir);
    assert.ok(appProj && appProj.id.startsWith('app:'));
    assert.ok(impProj && impProj.id.startsWith('implicit:'));

    // 2. POST /api/v1/sessions on App-synced project succeeds with enriched summary fields
    const createAppSess = await httpRequest(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders,
      body: { title: 'App Session', projectId: appProj.id }
    });
    assert.equal(createAppSess.status, 200);
    assert.equal(createAppSess.json.ok, true);
    assert.equal(createAppSess.json.projectId, appProj.id);
    assert.equal(createAppSess.json.projectName, 'd9-app-proj');
    assert.equal(createAppSess.json.workspaceUri, url.pathToFileURL(appDir).href);
    assert.equal(createAppSess.json.status, 'CASCADE_RUN_STATUS_IDLE');
    assert.equal(createAppSess.json.stepCount, 0);
    assert.equal(createAppSess.json.title, 'App Session');
    assert.equal(createAppSess.json.hasTitle, true);
    assert.ok(createAppSess.json.createdTime);
    assert.ok(createAppSess.json.lastModifiedTime);

    // 3. POST /api/v1/sessions on implicit project succeeds without 404
    const createImpSess = await httpRequest(`${baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders,
      body: { projectId: impProj.id }
    });
    assert.equal(createImpSess.status, 200);
    assert.equal(createImpSess.json.projectId, impProj.id);
    assert.equal(createImpSess.json.workspaceUri, url.pathToFileURL(implicitDir).href);
    assert.equal(createImpSess.json.title, '');
    assert.equal(createImpSess.json.hasTitle, false);

    // 4. GET /api/v1/remote/status returns remote status & QR SVG
    const remoteRes = await httpRequest(`${baseUrl}/api/v1/remote/status`, { headers: authHeaders });
    assert.equal(remoteRes.status, 200);
    assert.equal(remoteRes.json.ok, true);
    assert.equal(remoteRes.json.running, true);
    assert.equal(remoteRes.json.pairingUrl, 'http://192.168.1.99:18765/?t=tok');
    assert.match(remoteRes.json.qrSvg, /^<svg/);
  } finally {
    await srv.stop();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});
