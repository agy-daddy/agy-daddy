'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const url = require('node:url');

const { WebServer, createWebServer, SECURITY_HEADERS, isLoopbackSameOrigin } = require('../src/web-server');
const { readAccessSettings } = require('../src/node');
const { createWorkspaceMetaStore } = require('../src/workspace-meta-store');
const { createWorkspaceService } = require('../src/workspace-service');
const { createHostProxy } = require('../src/host-proxy');
const {
  classifyRequestChannel,
  createConfirmToken,
  verifyConfirmToken
} = require('../src/channel-config');

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
      },
      async listWorktrees({ root }) {
        calls.push({ fn: 'listWorktrees', root });
        return { ok: true, isGitRepo: true, worktrees: [{ path: root, branch: 'main', isCurrent: true }] };
      },
      async gitStage(payload) {
        calls.push({ fn: 'gitStage', payload });
        return { ok: true, staged: !payload.unstage, paths: payload.paths || [] };
      },
      async gitCommit(payload) {
        calls.push({ fn: 'gitCommit', payload });
        return { ok: true, commitSha: 'abcdef1234567890', branch: 'main', message: payload.message, stdout: '' };
      },
      async gitPush(payload) {
        calls.push({ fn: 'gitPush', payload });
        return { ok: true, remote: payload.remote || 'origin', branch: payload.branch || 'main', stdout: '', stderr: '' };
      },
      async gitWorktree(payload) {
        calls.push({ fn: 'gitWorktree', payload });
        return { ok: true, isGitRepo: true, action: payload.action, worktrees: [] };
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

test('D1: WebServer binds per channel policy (loopback default, guarded widening)', async () => {
  // Default: loopback only, bound to 127.0.0.1
  const defaultSrv = createWebServer({ port: 0, pairingToken: 'tok-d1-default' });
  assert.equal(defaultSrv.host, '127.0.0.1');
  assert.deepEqual(defaultSrv.channels, {
    loopback: true,
    lan: false,
    tailscale: false,
    bonjour: false,
    cloudflare: false
  });

  // Wildcard bind without any non-loopback channel is still refused
  assert.throws(() => new WebServer({ host: '0.0.0.0' }), /ERR_CHANNEL_NOT_ENABLED/);
  assert.throws(() => createWebServer({ host: '0.0.0.0', channels: { loopback: true } }), /ERR_CHANNEL_NOT_ENABLED/);

  // Wildcard bind is allowed once a channel actually needs it
  const lanSrv = createWebServer({ host: '0.0.0.0', channels: { lan: true }, port: 0 });
  assert.equal(lanSrv.host, '0.0.0.0');
  assert.equal(lanSrv.getLocalUrl(), '');
  const lanInfo = await lanSrv.start();
  assert.equal(lanInfo.host, '0.0.0.0');
  assert.match(lanInfo.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  await lanSrv.stop();

  // Addresses that are not local interfaces are refused
  assert.throws(
    () => createWebServer({ host: '203.0.113.9', channels: { lan: true } }),
    /ERR_BIND_HOST_NOT_LOCAL/
  );

  // "localhost" resolves deterministically to 127.0.0.1 instead of ::1
  assert.equal(createWebServer({ host: 'localhost' }).host, '127.0.0.1');
  assert.equal(createWebServer({ host: '::1' }).host, '::1');

  // bindHost:"loopback" cannot be combined with an external channel
  assert.throws(
    () => createWebServer({ host: '0.0.0.0', channels: { lan: true }, bindHostMode: 'loopback' }),
    /ERR_BIND_HOST_CONFLICT/
  );

  // start() re-validates against the live policy
  const srv = createWebServer({ host: '127.0.0.1', port: 0, pairingToken: 'tok-d1' });
  srv.host = '0.0.0.0';
  await assert.rejects(() => srv.start(), /ERR_CHANNEL_NOT_ENABLED/);
  await srv.stop();
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
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http: https:; frame-src 'self' blob: data:; object-src 'self' blob:; frame-ancestors 'none'"
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
    const realExtra = (fs.realpathSync.native || fs.realpathSync)(extraRootDir);
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

function channelServer(overrides = {}) {
  const deps = createFakeDeps();
  const state = { channel: 'lan' };
  const srv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken: 'pairing-secret-token-12345',
    sessionSecret: 'session-secret-cookie-67890',
    channels: { loopback: true, lan: true },
    resolveChannel: () => state.channel,
    ...deps,
    ...overrides
  });
  return { srv, state, deps };
}

test('D11: a channel that is disabled is refused before auth (CHANNEL_DISABLED)', async () => {
  const { srv, state } = channelServer({ channels: { loopback: true, lan: false } });
  const info = await srv.start();
  try {
    state.channel = 'lan';
    const res = await httpRequest(`http://127.0.0.1:${info.port}/api/v1/web/status`, {
      headers: { Authorization: 'Bearer pairing-secret-token-12345' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, 'CHANNEL_DISABLED');
    assert.equal(res.json.channel, 'lan');
    assert.deepEqual(res.json.allowedChannels, ['loopback']);

    // ...and the static entry point is refused too, so no token prompt leaks
    const html = await httpRequest(`http://127.0.0.1:${info.port}/`);
    assert.equal(html.status, 403);
    assert.equal(html.json.error, 'CHANNEL_DISABLED');

    // "external" (unclassified non-RFC1918 client) is never allowed
    state.channel = 'external';
    const ext = await httpRequest(`http://127.0.0.1:${info.port}/api/v1/health`);
    assert.equal(ext.status, 403);
    assert.equal(ext.json.error, 'CHANNEL_DISABLED');
  } finally {
    await srv.stop();
  }
});

test('D12: non-loopback channels are gated by L0/L1/L2 permission tiers', async () => {
  const { srv, state } = channelServer({ permissionLevel: 'L0' });
  const info = await srv.start();
  const base = `http://127.0.0.1:${info.port}`;
  const bearer = { Authorization: 'Bearer pairing-secret-token-12345' };

  try {
    // L0: reads and streaming stay available
    const read = await httpRequest(`${base}/api/v1/sessions`, { headers: bearer });
    assert.equal(read.status, 200);

    const stream = await openSse(`${base}/api/v1/stream`, bearer);
    assert.equal(stream.status, 200);

    // L0: every write is denied, with the tier stated in the body
    const denied = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: bearer,
      body: { title: 'x' }
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'PERMISSION_DENIED');
    assert.equal(denied.json.required, 'L1');
    assert.equal(denied.json.current, 'L0');
    assert.equal(denied.json.channel, 'lan');

    // L1: chat/session lifecycle allowed, workspace writes still denied
    srv.updateAccessConfig({ permissionLevel: 'L1' });
    const chat = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: bearer,
      body: { title: 'remote chat' }
    });
    assert.equal(chat.status, 200);
    assert.equal(chat.json.ok, true);

    const fsDenied = await httpRequest(`${base}/api/v1/fs/write`, {
      method: 'PUT',
      headers: bearer,
      body: { root: '/tmp', path: 'a.txt', content: 'x' }
    });
    assert.equal(fsDenied.status, 403);
    assert.equal(fsDenied.json.error, 'PERMISSION_DENIED');
    assert.equal(fsDenied.json.required, 'L2');

    // L2: workspace writes pass the channel gate
    srv.updateAccessConfig({ permissionLevel: 'L2' });
    const fsOk = await httpRequest(`${base}/api/v1/fs/write`, {
      method: 'PUT',
      headers: bearer,
      body: { root: '/tmp', path: 'a.txt', content: 'x' }
    });
    assert.equal(fsOk.status, 200);
    assert.equal(fsOk.json.ok, true);

    // loopback is never tier-gated, even at L0
    srv.updateAccessConfig({ permissionLevel: 'L0' });
    state.channel = 'loopback';
    const localWrite = await httpRequest(`${base}/api/v1/fs/write`, {
      method: 'PUT',
      headers: bearer,
      body: { root: '/tmp', path: 'a.txt', content: 'x' }
    });
    assert.equal(localWrite.status, 200);
  } finally {
    await srv.stop();
  }
});

test('D13: Cloudflare channel writes need an action-bound second confirmation', async () => {
  const { srv, state } = channelServer({
    channels: { loopback: true, cloudflare: true },
    permissionLevel: 'L2'
  });
  state.channel = 'cloudflare';
  const info = await srv.start();
  const base = `http://127.0.0.1:${info.port}`;
  const bearer = { Authorization: 'Bearer pairing-secret-token-12345' };

  try {
    // Reads stay open on the tunnel channel
    const read = await httpRequest(`${base}/api/v1/sessions`, { headers: bearer });
    assert.equal(read.status, 200);

    // Writes are challenged with a confirm token bound to "POST /api/v1/sessions"
    const challenged = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: bearer,
      body: { title: 'x' }
    });
    assert.equal(challenged.status, 403);
    assert.equal(challenged.json.error, 'CONFIRMATION_REQUIRED');
    assert.equal(challenged.json.channel, 'cloudflare');
    assert.equal(challenged.json.action, 'POST /api/v1/sessions');
    assert.ok(challenged.json.confirmToken);

    // A token minted for a different action is rejected
    const wrongAction = await httpRequest(`${base}/api/v1/confirm`, {
      method: 'POST',
      headers: bearer,
      body: { action: 'PUT /api/v1/fs/write' }
    });
    assert.equal(wrongAction.status, 200);
    const replayWrong = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { ...bearer, 'X-Agy-Confirm': wrongAction.json.confirmToken },
      body: { title: 'x' }
    });
    assert.equal(replayWrong.status, 403);
    assert.equal(replayWrong.json.error, 'CONFIRMATION_REQUIRED');

    // The matching token passes
    const confirmed = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { ...bearer, 'X-Agy-Confirm': challenged.json.confirmToken },
      body: { title: 'x' }
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.json.ok, true);

    // /api/v1/confirm requires a non-empty action
    const missing = await httpRequest(`${base}/api/v1/confirm`, {
      method: 'POST',
      headers: bearer,
      body: {}
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error, 'MISSING_ACTION');
  } finally {
    await srv.stop();
  }
});

test('D14: non-loopback cookie auth requires a same-origin Origin and keeps HttpOnly/Strict', async () => {
  const { srv, state } = channelServer({ permissionLevel: 'L2' });
  state.channel = 'lan';
  const info = await srv.start();
  const base = `http://127.0.0.1:${info.port}`;

  try {
    const login = await httpRequest(`${base}/?token=pairing-secret-token-12345`);
    assert.equal(login.status, 302);
    const setCookie = String(login.headers['set-cookie'] || '');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.doesNotMatch(setCookie, /SameSite=None/i);
    const cookie = setCookie.split(';')[0];

    const writeHeaders = {
      Cookie: cookie,
      'X-Agy-Csrf': '1',
      'Content-Type': 'application/json'
    };

    // Cross-origin Origin (another site) is refused
    const crossSite = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { ...writeHeaders, Origin: 'http://evil.example:18767' },
      body: { title: 'x' }
    });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.json.error, 'CSRF_REQUIRED');

    // A LAN origin that is not the Host actually serving the page is refused
    const otherLanHost = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { ...writeHeaders, Origin: 'http://192.168.1.50:18767' },
      body: { title: 'x' }
    });
    assert.equal(otherLanHost.status, 403);
    assert.equal(otherLanHost.json.error, 'CSRF_REQUIRED');

    // Same-origin write passes
    const sameOrigin = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { ...writeHeaders, Origin: base },
      body: { title: 'x' }
    });
    assert.equal(sameOrigin.status, 200);

    // Cookie writes still need the CSRF header
    const noCsrf = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base },
      body: { title: 'x' }
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.json.error, 'CSRF_REQUIRED');
  } finally {
    await srv.stop();
  }
});

test('D15: /api/v1/web/status reports the channel set, entry URLs and tier', async () => {
  const { srv, state } = channelServer({
    channels: { loopback: true, lan: true, cloudflare: true },
    permissionLevel: 'L1',
    tunnelHostname: 'https://ag.example.com'
  });
  state.channel = 'loopback';
  const info = await srv.start();
  try {
    const res = await httpRequest(`http://127.0.0.1:${info.port}/api/v1/web/status`, {
      headers: { Authorization: 'Bearer pairing-secret-token-12345' }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.channel, 'loopback');
    assert.equal(res.json.permissionLevel, 'L1');
    assert.equal(res.json.allowRemoteWrite, true);
    assert.equal(res.json.bindHost, '127.0.0.1');
    assert.deepEqual(res.json.activeChannels, ['loopback', 'lan', 'cloudflare']);
    assert.match(res.json.urls.loopback, /token=pairing-secret-token-12345$/);
    assert.equal(
      res.json.urls.cloudflare,
      'https://ag.example.com/?token=pairing-secret-token-12345'
    );
    assert.equal(res.json.primaryChannel, 'cloudflare');
    assert.equal(res.json.primaryUrl, res.json.urls.cloudflare);
    assert.ok(res.json.channelEndpoints?.cloudflare?.probeUrl === 'https://ag.example.com/api/v1/ping');
  } finally {
    await srv.stop();
  }
});

test('D16: confirm tokens are HMAC-bound to exactly one action and expire', () => {
  const secret = 'unit-test-confirm-secret';
  const action = 'POST /api/v1/sessions';
  const token = createConfirmToken(secret, { action });

  assert.equal(verifyConfirmToken(token, secret, { action }), true);
  assert.equal(verifyConfirmToken(token, secret, { action: 'PUT /api/v1/fs/write' }), false);
  assert.equal(verifyConfirmToken(token, 'wrong-secret', { action }), false);
  assert.equal(verifyConfirmToken('not-a-token', secret, { action }), false);

  // A token minted without an action must not unlock any action-specific write.
  assert.equal(verifyConfirmToken(createConfirmToken(secret), secret, { action }), false);

  const expired = createConfirmToken(secret, { action, ttlMs: 1000, now: 1000 });
  assert.equal(verifyConfirmToken(expired, secret, { action, now: 200000 }), false);
});

test('D17: bindHostMode is hot-applied and a rejected policy commits nothing', () => {
  const { srv } = channelServer({ channels: { loopback: true, lan: false } });
  assert.equal(srv.bindHostMode, 'auto');
  assert.equal(srv.host, '127.0.0.1');

  // Forcing lan mode without any non-loopback channel is rejected, and the
  // previous policy must survive untouched.
  assert.throws(
    () => srv.updateAccessConfig({ bindHostMode: 'lan' }),
    /ERR_CHANNEL_NOT_ENABLED/
  );
  assert.equal(srv.bindHostMode, 'auto');
  assert.equal(srv.host, '127.0.0.1');
  assert.equal(srv.channels.loopback, true);
  assert.equal(srv.channels.lan, false);

  // Once a channel needs it, the forced mode re-resolves the listen address.
  const applied = srv.updateAccessConfig({
    channels: { loopback: true, lan: true },
    bindHostMode: 'lan'
  });
  assert.equal(applied.rebind, true);
  assert.equal(applied.host, '0.0.0.0');
  assert.equal(srv.bindHostMode, 'lan');
  assert.equal(srv.getAccessStatus().bindHost, '0.0.0.0');
});

test('D18: isLoopbackSameOrigin enforces port matching and readAccessSettings guards invalid bindHost', () => {
  assert.equal(isLoopbackSameOrigin('http://localhost:18767', 18767, '127.0.0.1:18767', 'loopback'), true);
  assert.equal(isLoopbackSameOrigin('http://localhost:18767', 18767, '', 'loopback'), true);
  assert.equal(isLoopbackSameOrigin('http://localhost:9999', 18767, '127.0.0.1:18767', 'loopback'), false);
  assert.equal(isLoopbackSameOrigin('https://ag.example.com', 18767, 'ag.example.com', 'cloudflare'), true);
  assert.equal(isLoopbackSameOrigin('http://ag.example.com:9999', 18767, 'ag.example.com', 'cloudflare'), false);
  assert.equal(isLoopbackSameOrigin('https://ag.example.com:9999', 18767, 'ag.example.com', 'cloudflare'), false);

  const guarded = readAccessSettings({ bindHost: 'lan', loopback: true, lan: false });
  assert.equal(guarded.bindHostMode, 'auto');
  assert.equal(guarded.channels.loopback, true);

  const preserved = readAccessSettings({ bindHost: 'lan', loopback: true, lan: true });
  assert.equal(preserved.bindHostMode, 'lan');
});

test('D19: classifyRequestChannel restricts cf-* to loopback and *.ts.net to loopback/Tailscale source IPs', () => {
  // Trusted loopback cloudflared traffic classifies as cloudflare
  assert.equal(
    classifyRequestChannel({
      headers: { 'cf-ray': '8abc123' },
      socket: { remoteAddress: '127.0.0.1' }
    }),
    'cloudflare'
  );
  assert.equal(
    classifyRequestChannel({
      headers: { 'cf-connecting-ip': '198.51.100.7' },
      socket: { remoteAddress: '::ffff:127.0.0.1' }
    }),
    'cloudflare'
  );
  assert.equal(
    classifyRequestChannel(
      { headers: { host: 'ag.example.com' }, socket: { remoteAddress: '::1' } },
      { tunnelHostname: 'https://ag.example.com' }
    ),
    'cloudflare'
  );

  // Spoofed cf-* / tunnel Host from LAN, Tailscale, or external IPs must NOT classify as cloudflare
  assert.equal(
    classifyRequestChannel(
      {
        headers: { 'cf-ray': 'spoof', 'cf-connecting-ip': '1.2.3.4', host: 'ag.example.com' },
        socket: { remoteAddress: '192.168.1.50' }
      },
      { tunnelHostname: 'https://ag.example.com' }
    ),
    'lan'
  );
  assert.equal(
    classifyRequestChannel({
      headers: { 'cf-ray': 'spoof', host: 'demo.trycloudflare.com' },
      socket: { remoteAddress: '100.80.1.2' }
    }),
    'tailscale'
  );
  assert.equal(
    classifyRequestChannel({
      headers: { 'cf-ray': 'spoof', host: 'demo.trycloudflare.com' },
      socket: { remoteAddress: '203.0.113.9' }
    }),
    'external'
  );

  // Trusted loopback (`tailscale serve`) or Tailscale subnet with *.ts.net / tailscale-user-login -> tailscale
  assert.equal(
    classifyRequestChannel({
      headers: { 'x-forwarded-host': 'box.tail123.ts.net' },
      socket: { remoteAddress: '127.0.0.1' }
    }),
    'tailscale'
  );
  assert.equal(
    classifyRequestChannel({
      headers: { 'tailscale-user-login': 'alice@example.com' },
      socket: { remoteAddress: '::1' }
    }),
    'tailscale'
  );
  assert.equal(
    classifyRequestChannel({
      headers: { host: 'box.tail123.ts.net:18767' },
      socket: { remoteAddress: '100.90.1.5' }
    }),
    'tailscale'
  );

  // Spoofed *.ts.net / tailscale-user-login from LAN or external IPs must NOT classify as tailscale
  assert.equal(
    classifyRequestChannel({
      headers: {
        host: 'box.tail123.ts.net:18767',
        'x-forwarded-host': 'box.tail123.ts.net',
        'tailscale-user-login': 'spoof@example.com'
      },
      socket: { remoteAddress: '192.168.1.50' }
    }),
    'lan'
  );
  assert.equal(
    classifyRequestChannel({
      headers: { host: 'box.tail123.ts.net:18767', 'tailscale-user-login': 'spoof@example.com' },
      socket: { remoteAddress: '203.0.113.9' }
    }),
    'external'
  );
});

test('D20: /api/v1/web/status hides pairingToken on non-loopback L0 while preserving it on loopback and L1+', async () => {
  const { srv, state } = channelServer({
    channels: { loopback: true, lan: true, cloudflare: true },
    permissionLevel: 'L0',
    tunnelHostname: 'https://ag.example.com'
  });
  const info = await srv.start();
  const base = `http://127.0.0.1:${info.port}`;
  const bearer = { Authorization: 'Bearer pairing-secret-token-12345' };

  try {
    // Non-loopback L0 (lan): pairingToken must not appear anywhere in response
    state.channel = 'lan';
    const lanL0 = await httpRequest(`${base}/api/v1/web/status`, { headers: bearer });
    assert.equal(lanL0.status, 200);
    assert.equal(lanL0.text.includes('pairing-secret-token-12345'), false);
    assert.equal(lanL0.json.pairingUrl, '');
    assert.equal(lanL0.json.urls.loopback, base);
    assert.equal(lanL0.json.urls.cloudflare, 'https://ag.example.com');
    assert.equal(lanL0.json.primaryChannel, 'cloudflare');
    assert.equal(lanL0.json.primaryUrl, 'https://ag.example.com');

    // Non-loopback L0 (cloudflare): pairingToken also hidden
    state.channel = 'cloudflare';
    const cfL0 = await httpRequest(`${base}/api/v1/web/status`, { headers: bearer });
    assert.equal(cfL0.status, 200);
    assert.equal(cfL0.text.includes('pairing-secret-token-12345'), false);
    assert.equal(cfL0.json.pairingUrl, '');

    // Loopback at L0: pairingToken remains available for local device pairing
    state.channel = 'loopback';
    const localL0 = await httpRequest(`${base}/api/v1/web/status`, { headers: bearer });
    assert.equal(localL0.status, 200);
    assert.match(localL0.json.pairingUrl, /token=pairing-secret-token-12345$/);
    assert.match(localL0.json.urls.loopback, /token=pairing-secret-token-12345$/);
    assert.equal(
      localL0.json.urls.cloudflare,
      'https://ag.example.com/?token=pairing-secret-token-12345'
    );

    // Non-loopback upgraded to L1: pairingToken available again
    srv.updateAccessConfig({ permissionLevel: 'L1' });
    state.channel = 'lan';
    const lanL1 = await httpRequest(`${base}/api/v1/web/status`, { headers: bearer });
    assert.equal(lanL1.status, 200);
    assert.match(lanL1.json.pairingUrl, /token=pairing-secret-token-12345$/);
    assert.match(lanL1.json.urls.loopback, /token=pairing-secret-token-12345$/);
  } finally {
    await srv.stop();
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

test('D21: adaptive dual-tier delta polling defaults, backward-compatible options, immediate SSE connect poll, and active/idle/burst transitions', async () => {
  // 1. Default split options and backward-compatible deltaPollIntervalMs semantics
  const defaultSrv = createWebServer({});
  assert.equal(defaultSrv.idleDeltaPollIntervalMs, 400);
  assert.equal(defaultSrv.activeDeltaPollIntervalMs, 50);
  assert.equal(defaultSrv.burstWindowMs, 2500);
  assert.equal(defaultSrv.deltaPollIntervalMs, 400);

  const disabledZeroSrv = createWebServer({ deltaPollIntervalMs: 0 });
  assert.equal(disabledZeroSrv.deltaPollIntervalMs, 0);
  assert.equal(disabledZeroSrv.idleDeltaPollIntervalMs, 0);
  assert.equal(disabledZeroSrv.activeDeltaPollIntervalMs, 0);

  const disabledFalseSrv = createWebServer({ deltaPollIntervalMs: false });
  assert.equal(disabledFalseSrv.deltaPollIntervalMs, 0);
  assert.equal(disabledFalseSrv.idleDeltaPollIntervalMs, 0);
  assert.equal(disabledFalseSrv.activeDeltaPollIntervalMs, 0);

  const customSlowSrv = createWebServer({ deltaPollIntervalMs: 250 });
  assert.equal(customSlowSrv.deltaPollIntervalMs, 250);
  assert.equal(customSlowSrv.idleDeltaPollIntervalMs, 250);
  assert.equal(customSlowSrv.activeDeltaPollIntervalMs, 50);

  const customFastSrv = createWebServer({ deltaPollIntervalMs: 35 });
  assert.equal(customFastSrv.deltaPollIntervalMs, 35);
  assert.equal(customFastSrv.idleDeltaPollIntervalMs, 35);
  assert.equal(customFastSrv.activeDeltaPollIntervalMs, 35);

  // Disabled polling never starts pollers even on SSE connect or POST /messages
  const disabledCalls = [];
  const disabledToken = 'd21-disabled-tok';
  const disabledAuth = { Authorization: `Bearer ${disabledToken}`, 'Content-Type': 'application/json' };
  const disabledLiveSrv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken: disabledToken,
    deltaPollIntervalMs: 0,
    harnessAdapter: {
      async pollDelta(id) {
        disabledCalls.push(id);
        return { ok: true, cascadeId: id, status: 'CASCADE_RUN_STATUS_IDLE', totalSteps: 0, stepOffset: 0, events: [], hasChanges: false };
      },
      async sendMessage(id) {
        return { ok: true, cascadeId: id };
      }
    }
  });
  const disabledInfo = await disabledLiveSrv.start();
  try {
    const client = await openSse(`http://127.0.0.1:${disabledInfo.port}/api/v1/stream?sessionId=s-off`, disabledAuth);
    await httpRequest(`http://127.0.0.1:${disabledInfo.port}/api/v1/sessions/s-off/messages`, {
      method: 'POST',
      headers: disabledAuth,
      body: { text: 'hello' }
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(disabledLiveSrv._sessionPollers.size, 0);
    assert.equal(disabledCalls.length, 0);
    client.close();
  } finally {
    await disabledLiveSrv.stop();
  }

  // 2. Live adaptive polling: immediate connect poll, <=60ms post-write delta, burst window, RUNNING 50ms, IDLE 400ms
  const pairingToken = 'd21-live-tok';
  const authHeaders = { Authorization: `Bearer ${pairingToken}`, 'Content-Type': 'application/json' };
  const pollTimestamps = [];
  let pollState = {
    status: 'CASCADE_RUN_STATUS_IDLE',
    totalSteps: 1,
    stepOffset: 0,
    events: [{ seq: 0, kind: 'user', status: 'done', payload: { text: 'init' } }],
    hasChanges: true
  };

  const srv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken,
    idleDeltaPollIntervalMs: 400,
    activeDeltaPollIntervalMs: 50,
    burstWindowMs: 180,
    harnessAdapter: {
      async pollDelta(sessionId) {
        pollTimestamps.push(Date.now());
        const out = {
          ok: true,
          cascadeId: sessionId,
          status: pollState.status,
          totalSteps: pollState.totalSteps,
          stepOffset: pollState.stepOffset,
          events: pollState.events,
          hasChanges: pollState.hasChanges
        };
        pollState.hasChanges = false;
        pollState.events = [];
        return out;
      },
      async sendMessage(sessionId, body) {
        // Simulate language_server returning IDLE briefly right after SendUserCascadeMessage
        pollState = {
          status: 'CASCADE_RUN_STATUS_IDLE',
          totalSteps: 2,
          stepOffset: 1,
          events: [{ seq: 1, kind: 'user', status: 'done', payload: { text: body.text } }],
          hasChanges: true
        };
        return { ok: true, cascadeId: sessionId };
      }
    }
  });

  const info = await srv.start();
  const baseUrl = `http://127.0.0.1:${info.port}`;
  try {
    // Immediate first poll on SSE connect (much faster than 400ms idle interval)
    const connectStart = Date.now();
    const client = await openSse(`${baseUrl}/api/v1/stream?sessionId=s-adapt`, authHeaders);
    const firstEv = await client.waitForEvent((e) => e.event === 'session.delta');
    const connectElapsed = Date.now() - connectStart;
    assert.equal(firstEv.json.totalSteps, 1);
    assert.ok(connectElapsed < 120, `expected immediate SSE connect delta, took ${connectElapsed}ms`);

    const poller = srv._sessionPollers.get('s-adapt');
    assert.ok(poller);
    assert.equal(poller.currentIntervalMs, 400);

    // POST /messages triggers immediate poll + 50ms burst even before status flips to RUNNING
    const writeStart = Date.now();
    const sendRes = await httpRequest(`${baseUrl}/api/v1/sessions/s-adapt/messages`, {
      method: 'POST',
      headers: authHeaders,
      body: { text: 'fast burst' }
    });
    assert.equal(sendRes.status, 200);
    const deltaAfterWrite = await client.waitForEvent((e) => e.event === 'session.delta' && e.json?.totalSteps === 2);
    const writeToDeltaMs = Date.now() - writeStart;
    assert.equal(deltaAfterWrite.json.events[0].payload.text, 'fast burst');
    assert.ok(writeToDeltaMs <= 60, `expected first post-write delta <= 60ms, got ${writeToDeltaMs}ms`);
    assert.equal(poller.currentIntervalMs, 50);

    // Flip to RUNNING and verify poller stays on 50ms past burstWindowMs (180ms)
    pollState = {
      status: 'CASCADE_RUN_STATUS_RUNNING',
      totalSteps: 3,
      stepOffset: 2,
      events: [{ seq: 2, kind: 'thinking_and_text', status: 'generating', payload: { text: 'streaming' } }],
      hasChanges: true
    };
    await client.waitForEvent((e) => e.event === 'session.delta' && e.json?.status === 'CASCADE_RUN_STATUS_RUNNING');
    const callsBeforeRunningWindow = pollTimestamps.length;
    await new Promise((r) => setTimeout(r, 230));
    const runningPolls = pollTimestamps.length - callsBeforeRunningWindow;
    assert.equal(poller.currentIntervalMs, 50);
    assert.ok(runningPolls >= 3, `expected >= 3 active polls in 230ms at 50ms cadence, got ${runningPolls}`);

    // Flip back to IDLE after burst already expired -> automatically reverts to 400ms
    pollState = {
      status: 'CASCADE_RUN_STATUS_IDLE',
      totalSteps: 3,
      stepOffset: 3,
      events: [],
      hasChanges: false
    };
    await client.waitForEvent(
      (e) => e.event === 'session.delta' && e.json?.totalSteps === 3 && e.json?.status === 'CASCADE_RUN_STATUS_IDLE'
    );
    assert.equal(poller.currentIntervalMs, 400);

    const callsAtIdle = pollTimestamps.length;
    await new Promise((r) => setTimeout(r, 320));
    const idlePolls = pollTimestamps.length - callsAtIdle;
    assert.ok(idlePolls <= 1, `expected <= 1 idle poll in 320ms at 400ms cadence (<=2.5/s), got ${idlePolls}`);

    client.close();
  } finally {
    await srv.stop();
  }
});

test('D22: _nudgeSessionPoller triggers burst + immediate delta poll for approve, answer, and cancel routes', async () => {
  const pairingToken = 'd22-nudge-tok';
  const authHeaders = { Authorization: `Bearer ${pairingToken}`, 'Content-Type': 'application/json' };
  let pollState = {
    status: 'CASCADE_RUN_STATUS_IDLE',
    totalSteps: 1,
    stepOffset: 0,
    events: [{ seq: 0, kind: 'user', status: 'done', payload: { text: 'start' } }],
    hasChanges: true
  };

  const srv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken,
    idleDeltaPollIntervalMs: 400,
    activeDeltaPollIntervalMs: 50,
    burstWindowMs: 120,
    harnessAdapter: {
      async pollDelta(sessionId) {
        const out = {
          ok: true,
          cascadeId: sessionId,
          status: pollState.status,
          totalSteps: pollState.totalSteps,
          stepOffset: pollState.stepOffset,
          events: pollState.events,
          hasChanges: pollState.hasChanges
        };
        pollState.hasChanges = false;
        pollState.events = [];
        return out;
      },
      async approveStep(sessionId, stepIdx) {
        pollState = {
          status: 'CASCADE_RUN_STATUS_IDLE',
          totalSteps: 2,
          stepOffset: 1,
          events: [{ seq: stepIdx, kind: 'command', status: 'done', payload: { approved: true } }],
          hasChanges: true
        };
        return { ok: true, cascadeId: sessionId, stepIdx };
      },
      async answerQuestion(sessionId, stepIdx) {
        pollState = {
          status: 'CASCADE_RUN_STATUS_IDLE',
          totalSteps: 3,
          stepOffset: 2,
          events: [{ seq: stepIdx, kind: 'question', status: 'done', payload: { answered: true } }],
          hasChanges: true
        };
        return { ok: true, cascadeId: sessionId, stepIdx };
      },
      async cancelSession(sessionId) {
        pollState = {
          status: 'CASCADE_RUN_STATUS_CANCELED',
          totalSteps: 3,
          stepOffset: 3,
          events: [],
          hasChanges: false
        };
        return { ok: true, cascadeId: sessionId };
      }
    }
  });

  const info = await srv.start();
  const baseUrl = `http://127.0.0.1:${info.port}`;
  try {
    const client = await openSse(`${baseUrl}/api/v1/stream?sessionId=s-nudge`, authHeaders);
    await client.waitForEvent((e) => e.event === 'session.delta' && e.json?.totalSteps === 1);
    const poller = srv._sessionPollers.get('s-nudge');
    assert.equal(poller.currentIntervalMs, 400);

    // 1. Approve triggers immediate delta + burst
    let t0 = Date.now();
    const approveRes = await httpRequest(`${baseUrl}/api/v1/sessions/s-nudge/steps/1/approve`, {
      method: 'POST',
      headers: authHeaders,
      body: { decision: 'approve' }
    });
    assert.equal(approveRes.status, 200);
    await client.waitForEvent((e) => e.event === 'session.delta' && e.json?.totalSteps === 2);
    assert.ok(Date.now() - t0 <= 60);
    assert.equal(poller.currentIntervalMs, 50);

    // Wait for burst expiration and verify return to 400ms
    await new Promise((r) => setTimeout(r, 180));
    assert.equal(poller.currentIntervalMs, 400);

    // 2. Answer triggers immediate delta + burst
    t0 = Date.now();
    const answerRes = await httpRequest(`${baseUrl}/api/v1/sessions/s-nudge/steps/2/answer`, {
      method: 'POST',
      headers: authHeaders,
      body: { answers: ['yes'] }
    });
    assert.equal(answerRes.status, 200);
    await client.waitForEvent((e) => e.event === 'session.delta' && e.json?.totalSteps === 3);
    assert.ok(Date.now() - t0 <= 60);
    assert.equal(poller.currentIntervalMs, 50);

    await new Promise((r) => setTimeout(r, 180));
    assert.equal(poller.currentIntervalMs, 400);

    // 3. Cancel triggers immediate delta + burst
    t0 = Date.now();
    const cancelRes = await httpRequest(`${baseUrl}/api/v1/sessions/s-nudge/cancel`, {
      method: 'POST',
      headers: authHeaders,
      body: {}
    });
    assert.equal(cancelRes.status, 200);
    await client.waitForEvent((e) => e.event === 'session.delta' && e.json?.status === 'CASCADE_RUN_STATUS_CANCELED');
    assert.ok(Date.now() - t0 <= 60);
    assert.equal(poller.currentIntervalMs, 50);

    client.close();
  } finally {
    await srv.stop();
  }
});

test('D23: /api/v1/ping CORS/PNA headers, CSP connect-src, /pc proxy secret anti-spoofing, switch-ticket & auth', async () => {
  const { srv } = channelServer({
    channels: { loopback: true, lan: true, cloudflare: true },
    permissionLevel: 'L0',
    tunnelHostname: 'https://ag.example.com',
    cloudflareMountPath: '/pc',
    proxySecret: 'proxy-secret-xyz',
    resolveChannel: undefined
  });
  const info = await srv.start();
  const base = `http://127.0.0.1:${info.port}`;
  const bearer = { Authorization: 'Bearer pairing-secret-token-12345' };

  try {
    // 1. CSP allows cross-origin connect-src probes
    assert.match(SECURITY_HEADERS['Content-Security-Policy'], /connect-src 'self' http: https:/);

    // 2. Unauthenticated /api/v1/ping OPTIONS & GET with CORS + PNA and zero secrets
    const pingOpt = await httpRequest(`${base}/api/v1/ping`, { method: 'OPTIONS' });
    assert.equal(pingOpt.status, 204);
    assert.equal(pingOpt.headers['access-control-allow-origin'], '*');
    assert.equal(pingOpt.headers['access-control-allow-private-network'], 'true');
    assert.equal(pingOpt.headers['cross-origin-resource-policy'], 'cross-origin');

    const pingGet = await httpRequest(`${base}/api/v1/ping`);
    assert.equal(pingGet.status, 200);
    assert.equal(pingGet.json.ok, true);
    assert.equal(pingGet.json.service, 'agy-daddy-web');
    assert.equal(pingGet.json.channel, 'loopback');
    assert.equal(pingGet.text.includes('pairing-secret-token-12345'), false);

    // 3. Spoofed x-agy-proxy-* on loopback MUST return 403 external (never loopback!)
    const spoofed = await httpRequest(`${base}/api/v1/sessions`, {
      headers: {
        ...bearer,
        'x-agy-proxy-channel': 'cloudflare',
        'x-agy-proxy-secret': 'wrong-secret'
      }
    });
    assert.equal(spoofed.status, 403);
    assert.equal(spoofed.json.error, 'CHANNEL_DISABLED');
    assert.equal(spoofed.json.channel, 'external');

    // 4. Trusted /pc proxy classifies as cloudflare (NOT loopback), enforces L0 write 403, and scopes Cookie Path=/pc
    const trustedProxyHeaders = {
      Host: 'ag.example.com',
      Origin: 'https://ag.example.com',
      'x-agy-proxy-source': 'agy-daddy-remote',
      'x-agy-proxy-channel': 'cloudflare',
      'x-agy-proxy-prefix': '/pc',
      'x-agy-proxy-secret': 'proxy-secret-xyz'
    };

    // POST /api/v1/web/auth works through /pc proxy and issues Path=/pc; Secure cookie
    const authFail = await httpRequest(`${base}/api/v1/web/auth`, {
      method: 'POST',
      headers: { ...trustedProxyHeaders, 'Content-Type': 'application/json' },
      body: { token: 'wrong-token' }
    });
    assert.equal(authFail.status, 401);

    const authOk = await httpRequest(`${base}/api/v1/web/auth`, {
      method: 'POST',
      headers: { ...trustedProxyHeaders, 'Content-Type': 'application/json' },
      body: { token: 'pairing-secret-token-12345' }
    });
    assert.equal(authOk.status, 200);
    assert.equal(authOk.json.channel, 'cloudflare');
    const pcCookieHeader = String(authOk.headers['set-cookie'] || '');
    assert.match(pcCookieHeader, /Path=\/pc\b/);
    assert.match(pcCookieHeader, /Secure/);
    assert.match(pcCookieHeader, /HttpOnly/);
    assert.match(pcCookieHeader, /SameSite=Strict/);
    const pcCookie = pcCookieHeader.split(';')[0];

    // Non-loopback L0 write on /pc still returns 403 PERMISSION_DENIED (never treated as loopback)
    const l0Write = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: { ...trustedProxyHeaders, Cookie: pcCookie, 'X-Agy-Csrf': '1' },
      body: { title: 'blocked-l0' }
    });
    assert.equal(l0Write.status, 403);
    assert.equal(l0Write.json.error, 'PERMISSION_DENIED');

    // D20 preserved under /pc proxy at L0
    const statusL0 = await httpRequest(`${base}/api/v1/web/status`, {
      headers: { ...trustedProxyHeaders, Cookie: pcCookie }
    });
    assert.equal(statusL0.status, 200);
    assert.equal(statusL0.json.channel, 'cloudflare');
    assert.equal(statusL0.text.includes('pairing-secret-token-12345'), false);
    assert.equal(statusL0.json.urls.cloudflare, 'https://ag.example.com/pc/');
    assert.equal(statusL0.json.channelEndpoints.cloudflare.probeUrl, 'https://ag.example.com/pc/api/v1/ping');

    // 5. L0 switch-ticket minting under /pc proxy succeeds without X-Agy-Confirm and preserves session
    const mintTicket = await httpRequest(`${base}/api/v1/web/switch-ticket`, {
      method: 'POST',
      headers: { ...trustedProxyHeaders, Cookie: pcCookie, 'X-Agy-Csrf': '1' },
      body: { targetChannel: 'loopback', sessionId: 'sess-42' }
    });
    assert.equal(mintTicket.status, 200);
    assert.equal(mintTicket.json.ok, true);
    assert.match(mintTicket.json.switchUrl, /\?switch_ticket=.*&session=sess-42$/);

    const parsedSwitch = new URL(mintTicket.json.switchUrl);
    const ticketParam = parsedSwitch.searchParams.get('switch_ticket');

    // Loopback ticket cannot be redeemed on non-loopback channel
    const wrongChannelRedeem = await httpRequest(`${base}/?switch_ticket=${ticketParam}&session=sess-42`, {
      headers: trustedProxyHeaders
    });
    assert.equal(wrongChannelRedeem.status, 401);
    assert.equal(wrongChannelRedeem.json.error, 'SWITCH_TICKET_INVALID');

    // Mint a fresh ticket for loopback and redeem on loopback
    const mintLoopback = await httpRequest(`${base}/api/v1/web/switch-ticket`, {
      method: 'POST',
      headers: { ...trustedProxyHeaders, Cookie: pcCookie, 'X-Agy-Csrf': '1' },
      body: { targetChannel: 'loopback', sessionId: 'sess-42' }
    });
    const loopTicket = new URL(mintLoopback.json.switchUrl).searchParams.get('switch_ticket');
    const redeemOk = await httpRequest(`${base}/?switch_ticket=${loopTicket}&session=sess-42`);
    assert.equal(redeemOk.status, 302);
    assert.equal(redeemOk.headers.location, '/?session=sess-42');
    assert.match(String(redeemOk.headers['set-cookie'] || ''), /Path=\/(?:;|$)/);

    // Replay of consumed ticket fails
    const replayFail = await httpRequest(`${base}/?switch_ticket=${loopTicket}&session=sess-42`);
    assert.equal(replayFail.status, 401);

    // Mint ticket for cloudflare and redeem via /pc proxy -> 302 /pc/?session=sess-42
    const mintCf = await httpRequest(`${base}/api/v1/web/switch-ticket`, {
      method: 'POST',
      headers: bearer,
      body: { targetChannel: 'cloudflare', sessionId: 'sess-42' }
    });
    assert.equal(mintCf.status, 200);
    assert.ok(mintCf.json.switchUrl.startsWith('https://ag.example.com/pc/?switch_ticket='));
    const cfTicket = new URL(mintCf.json.switchUrl).searchParams.get('switch_ticket');
    const redeemCf = await httpRequest(`${base}/?switch_ticket=${cfTicket}&session=sess-42`, {
      headers: trustedProxyHeaders
    });
    assert.equal(redeemCf.status, 302);
    assert.equal(redeemCf.headers.location, '/pc/?session=sess-42');

    // 6. Remote SSE + Cookie invalidation on setAuthMaterial({ rotateRemoteSession: true }) while loopback survives
    const remoteSse = await openSse(`${base}/api/v1/stream`, { ...trustedProxyHeaders, Cookie: pcCookie });
    const localLogin = await httpRequest(`${base}/?token=pairing-secret-token-12345`);
    const localCookie = String(localLogin.headers['set-cookie'] || '').split(';')[0];

    srv.setAuthMaterial({
      pairingToken: 'rotated-new-token-999',
      authEpoch: 2,
      rotateRemoteSession: true
    });

    await new Promise((r) => setTimeout(r, 40));
    // Remote cookie is immediately rejected with 401
    const afterRotateRemote = await httpRequest(`${base}/api/v1/web/status`, {
      headers: { ...trustedProxyHeaders, Cookie: pcCookie }
    });
    assert.equal(afterRotateRemote.status, 401);
    // Loopback cookie remains valid
    const afterRotateLocal = await httpRequest(`${base}/api/v1/web/status`, {
      headers: { Cookie: localCookie }
    });
    assert.equal(afterRotateLocal.status, 200);
    remoteSse.close();
  } finally {
    await srv.stop();
  }
});

test('D24: /api/v1/git/{worktrees,stage,commit,push,worktree} enforces L0 read-only, L1 deny, and L2 Cloudflare X-Agy-Confirm', async () => {
  const { srv, deps, state } = channelServer({
    channels: { loopback: true, lan: true, cloudflare: true },
    permissionLevel: 'L0'
  });
  const info = await srv.start();
  const base = `http://127.0.0.1:${info.port}`;
  const bearer = { Authorization: 'Bearer pairing-secret-token-12345' };

  try {
    // 1. L0 on LAN: GET /api/v1/git/worktrees succeeds, POST /api/v1/git/stage returns 403 PERMISSION_DENIED
    state.channel = 'lan';
    const wtReadL0 = await httpRequest(`${base}/api/v1/git/worktrees?root=%2Frepo`, { headers: bearer });
    assert.equal(wtReadL0.status, 200);
    assert.equal(wtReadL0.json.ok, true);
    assert.equal(wtReadL0.json.worktrees[0].branch, 'main');

    const stageBlockedL0 = await httpRequest(`${base}/api/v1/git/stage`, {
      method: 'POST',
      headers: bearer,
      body: { root: '/repo', paths: ['a.ts'] }
    });
    assert.equal(stageBlockedL0.status, 403);
    assert.equal(stageBlockedL0.json.error, 'PERMISSION_DENIED');
    assert.equal(stageBlockedL0.json.required, 'L2');

    // 2. L1 on LAN: Git mutations STILL return 403 PERMISSION_DENIED (requires L2)
    srv.updateAccessConfig({ permissionLevel: 'L1' });
    for (const [route, body] of [
      ['/api/v1/git/stage', { root: '/repo', paths: ['a.ts'] }],
      ['/api/v1/git/commit', { root: '/repo', message: 'feat: x' }],
      ['/api/v1/git/push', { root: '/repo', branch: 'main' }],
      ['/api/v1/git/worktree', { root: '/repo', action: 'add', path: '../wt', branch: 'feat/wt', createBranch: true }]
    ]) {
      const denied = await httpRequest(`${base}${route}`, { method: 'POST', headers: bearer, body });
      assert.equal(denied.status, 403, `${route} must require L2`);
      assert.equal(denied.json.required, 'L2');
    }

    // 3. L2 on Cloudflare: requires X-Agy-Confirm challenge before mutating Git state
    srv.updateAccessConfig({ permissionLevel: 'L2' });
    state.channel = 'cloudflare';

    const commitChallenge = await httpRequest(`${base}/api/v1/git/commit`, {
      method: 'POST',
      headers: bearer,
      body: { root: '/repo', message: 'feat: confirmed commit' }
    });
    assert.equal(commitChallenge.status, 403);
    assert.equal(commitChallenge.json.error, 'CONFIRMATION_REQUIRED');
    assert.equal(commitChallenge.json.action, 'POST /api/v1/git/commit');

    const commitConfirmed = await httpRequest(`${base}/api/v1/git/commit`, {
      method: 'POST',
      headers: { ...bearer, 'X-Agy-Confirm': commitChallenge.json.confirmToken },
      body: { root: '/repo', message: 'feat: confirmed commit' }
    });
    assert.equal(commitConfirmed.status, 200);
    assert.equal(commitConfirmed.json.commitSha, 'abcdef1234567890');

    // 4. Loopback always has full L2 access without confirmation challenge
    state.channel = 'loopback';
    const stageOk = await httpRequest(`${base}/api/v1/git/stage`, {
      method: 'POST',
      headers: bearer,
      body: { root: '/repo', all: true, unstage: false }
    });
    assert.equal(stageOk.status, 200);
    assert.equal(stageOk.json.staged, true);

    const pushOk = await httpRequest(`${base}/api/v1/git/push`, {
      method: 'POST',
      headers: bearer,
      body: { root: '/repo', branch: 'main', setUpstream: true }
    });
    assert.equal(pushOk.status, 200);
    assert.equal(pushOk.json.remote, 'origin');

    const wtOk = await httpRequest(`${base}/api/v1/git/worktree`, {
      method: 'POST',
      headers: bearer,
      body: { root: '/repo', action: 'add', path: '../wt2', branch: 'feat/wt2', createBranch: true }
    });
    assert.equal(wtOk.status, 200);
    assert.equal(wtOk.json.action, 'add');
    assert.equal(deps.calls.some((c) => c.fn === 'gitWorktree'), true);
  } finally {
    await srv.stop();
  }
});

test('S3-1 org-api: archive, true/503/local_hide session delete, atomic reorder, and L0/L1/L2 + Cloudflare confirm', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-org-api-'));
  const projA = path.join(tmpBase, 'projA');
  const projB = path.join(tmpBase, 'projB');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });

  const { createSessionOrgBridge } = require('../src/session-org-bridge');
  const orgPath = path.join(tmpBase, 'session-org.json');
  const bridge = createSessionOrgBridge({ orgPath });
  const metaStore = createWorkspaceMetaStore({
    defaultBaseDir: path.join(tmpBase, 'default-ws'),
    sessionOrgBridge: bridge,
    conversationDbPath: null,
    sharedReadStatePath: null
  });

  const deletedCalls = [];
  const cancelledCalls = [];
  let deleteModeBehavior = 'ok';
  let channelMode = 'loopback';

  const srv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken: 'org-api-token-12345',
    confirmSecret: 'org-api-confirm-secret',
    channels: { loopback: true, lan: true, cloudflare: true },
    permissionLevel: 'L1',
    resolveChannel: () => channelMode,
    workspaceMetaStore: metaStore,
    sessionOrgBridge: bridge,
    harnessAdapter: {
      async listSessions() {
        return {
          ok: true,
          sessions: [
            { cascadeId: 's-1', title: 'S1', status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 5, workspaceUri: url.pathToFileURL(projA).href, lastModifiedTime: '2026-11-25T10:00:00Z' },
            { cascadeId: 's-2', title: 'S2', status: 'CASCADE_RUN_STATUS_RUNNING', stepCount: 8, workspaceUri: url.pathToFileURL(projB).href, lastModifiedTime: '2026-11-25T11:00:00Z' },
            { cascadeId: 's-3', title: 'S3', status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 3, workspaceUri: url.pathToFileURL(projA).href, lastModifiedTime: '2026-11-25T09:00:00Z' }
          ]
        };
      },
      async cancelSession(id) {
        cancelledCalls.push(id);
        return { ok: true, cascadeId: id };
      },
      async deleteSession(id) {
        if (deleteModeBehavior === 'offline') {
          throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:50001'), { code: 'ECONNREFUSED' });
        }
        if (deleteModeBehavior === 'blocked') {
          throw new Error('RPC_METHOD_BLOCKED: DeleteCascadeTrajectory');
        }
        deletedCalls.push(id);
        return { ok: true, cascadeId: id, hostCleaned: true };
      }
    }
  });

  const info = await srv.start();
  const base = `http://127.0.0.1:${info.port}`;
  const auth = { Authorization: 'Bearer org-api-token-12345', 'Content-Type': 'application/json' };

  try {
    // Setup projects & groups
    const g1 = (await httpRequest(`${base}/api/v1/sessions/groups`, { method: 'POST', headers: auth, body: { action: 'upsert', name: 'G1' } })).json.group;
    const g2 = (await httpRequest(`${base}/api/v1/sessions/groups`, { method: 'POST', headers: auth, body: { action: 'upsert', name: 'G2' } })).json.group;
    const p1 = (await httpRequest(`${base}/api/v1/projects`, { method: 'POST', headers: auth, body: { name: 'P1', rootPath: projA, groupId: g1.id } })).json.project;
    const p2 = (await httpRequest(`${base}/api/v1/projects`, { method: 'POST', headers: auth, body: { name: 'P2', rootPath: projB, groupId: g1.id } })).json.project;

    // Pin s-1 then archive -> atomic unpin & hidden from active sessions
    assert.equal((await httpRequest(`${base}/api/v1/sessions/pin`, { method: 'POST', headers: auth, body: { type: 'session', id: 's-1', pinned: true } })).status, 200);
    const archRes = await httpRequest(`${base}/api/v1/sessions/s-1/archive`, {
      method: 'POST',
      headers: auth,
      body: { archived: true }
    });
    assert.equal(archRes.status, 200);
    assert.equal(archRes.json.archived, true);
    assert.equal(archRes.json.unpinned, true);
    assert.equal(archRes.json.archivedCount, 1);

    const orgWithArch = await httpRequest(`${base}/api/v1/sessions/org?includeArchived=1`, { headers: auth });
    assert.equal(orgWithArch.status, 200);
    assert.ok(orgWithArch.json.archivedSessions['s-1']);
    assert.equal(orgWithArch.json.pins.sessions.includes('s-1'), false);

    // Unarchive s-1 -> stays unpinned
    const unarchRes = await httpRequest(`${base}/api/v1/sessions/s-1/archive`, {
      method: 'POST',
      headers: auth,
      body: { archived: false }
    });
    assert.equal(unarchRes.status, 200);
    assert.equal(unarchRes.json.archived, false);
    assert.equal(unarchRes.json.archivedCount, 0);

    // Reorder: ZONE_PIN_MISMATCH rejected with 409
    assert.equal((await httpRequest(`${base}/api/v1/sessions/pin`, { method: 'POST', headers: auth, body: { type: 'project', id: p1.id, pinned: true } })).status, 200);
    const mismatch = await httpRequest(`${base}/api/v1/sessions/org/reorder`, {
      method: 'POST',
      headers: auth,
      body: { targetType: 'project', containerId: g1.id, zone: 'normal', orderedIds: [p1.id, p2.id] }
    });
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.json.error, 'ZONE_PIN_MISMATCH');

    // Cross-group atomic move p2 from g1 -> g2
    const crossMove = await httpRequest(`${base}/api/v1/sessions/org/reorder`, {
      method: 'POST',
      headers: auth,
      body: {
        targetType: 'project',
        containerId: g2.id,
        zone: 'normal',
        orderedIds: [p2.id],
        movedProject: { projectId: p2.id, fromGroupId: g1.id, toGroupId: g2.id }
      }
    });
    assert.equal(crossMove.status, 200);
    assert.equal(crossMove.json.org.projectGroupMap[p2.id], g2.id);
    assert.deepEqual(crossMove.json.org.projectOrder[g2.id].normal, [p2.id]);

    // Permission check: non-loopback L1 blocks DELETE /api/v1/sessions/:id with 403 L2 required,
    // allows /api/sessions/pin (L1 compat) and PATCH /api/v1/projects/:id (L1)
    channelMode = 'lan';
    const delL1 = await httpRequest(`${base}/api/v1/sessions/s-2`, { method: 'DELETE', headers: auth });
    assert.equal(delL1.status, 403);
    assert.equal(delL1.json.required, 'L2');

    const compatPin = await httpRequest(`${base}/api/sessions/pin`, {
      method: 'POST',
      headers: auth,
      body: { type: 'group', id: g1.id, pinned: true }
    });
    assert.equal(compatPin.status, 200);

    const patchProjL1 = await httpRequest(`${base}/api/v1/projects/${p1.id}`, {
      method: 'PATCH',
      headers: auth,
      body: { name: 'P1 L1 Renamed' }
    });
    assert.equal(patchProjL1.status, 200);

    // L2 + Cloudflare requires X-Agy-Confirm on DELETE /api/v1/sessions/:id
    srv.updateAccessConfig({ permissionLevel: 'L2' });
    channelMode = 'cloudflare';
    const cfChallenge = await httpRequest(`${base}/api/v1/sessions/s-2`, { method: 'DELETE', headers: auth });
    assert.equal(cfChallenge.status, 403);
    assert.equal(cfChallenge.json.error, 'CONFIRMATION_REQUIRED');

    // True delete on running session cancels first, then calls DeleteCascadeTrajectory
    const cfDelOk = await httpRequest(`${base}/api/v1/sessions/s-2`, {
      method: 'DELETE',
      headers: { ...auth, 'X-Agy-Confirm': cfChallenge.json.confirmToken }
    });
    assert.equal(cfDelOk.status, 200);
    assert.equal(cfDelOk.json.deletionMode, 'host_deleted');
    assert.equal(cfDelOk.json.hostCleaned, true);
    assert.deepEqual(cancelledCalls, ['s-2']);
    assert.deepEqual(deletedCalls, ['s-2']);

    // Host offline -> 503 HOST_DELETE_UNAVAILABLE (no tombstone written yet), then mode=local_hide writes tombstone
    channelMode = 'loopback';
    deleteModeBehavior = 'offline';
    const del503 = await httpRequest(`${base}/api/v1/sessions/s-3`, { method: 'DELETE', headers: auth });
    assert.equal(del503.status, 503);
    assert.equal(del503.json.error, 'HOST_DELETE_UNAVAILABLE');
    assert.equal(del503.json.reasonCode, 'RPC_OFFLINE');
    assert.equal(del503.json.canFallbackLocalHide, true);
    assert.equal(Boolean(bridge.loadPersistedOrg().deletedSessions['s-3']), false);

    const delHide = await httpRequest(`${base}/api/v1/sessions/s-3?mode=local_hide`, { method: 'DELETE', headers: auth });
    assert.equal(delHide.status, 200);
    assert.equal(delHide.json.deletionMode, 'local_tombstone');
    assert.equal(delHide.json.hostCleaned, false);
    assert.ok(bridge.loadPersistedOrg().deletedSessions['s-3']);

    const afterHide = await httpRequest(`${base}/api/v1/sessions`, { headers: auth });
    assert.equal(afterHide.json.sessions.some((s) => s.cascadeId === 's-3'), false);
  } finally {
    bridge.dispose();
    await srv.stop();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('WebServer workspace browse & remote provisioning endpoints: L2 gates, Cloudflare confirm, 202 jobs, cancel exemption', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { createSessionOrgBridge } = require('../src/session-org-bridge');
  const { createWorkspaceBrowser } = require('../src/workspace-browser');
  const { createRemoteProjectProvisioner } = require('../src/remote-project-provisioner');

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ws-prov-'));
  const orgPath = path.join(tmpBase, 'session-org.json');
  const wsRoot = path.join(tmpBase, 'ws');
  fs.mkdirSync(wsRoot, { recursive: true });

  const makeChild = ({ code = 0, stdout = '', delayMs = 5 } = {}) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let timer = setTimeout(() => {
      if (stdout) child.stdout.write(stdout);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code, null);
    }, delayMs);
    child.kill = (sig = 'SIGTERM') => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', null, sig);
      });
      return true;
    };
    return child;
  };

  const bridge = createSessionOrgBridge({ orgPath });
  const metaStore = createWorkspaceMetaStore({ sessionOrgBridge: bridge });
  const browser = createWorkspaceBrowser({
    getDefaultSessionPath: () => wsRoot,
    getProjectRootPaths: () => metaStore.getProjectRootPaths()
  });
  const provisioner = createRemoteProjectProvisioner({
    spawnFn: (bin, args) => {
      if (bin === 'git' && args[0] === 'clone') {
        const target = args[args.length - 1];
        fs.mkdirSync(path.join(target, '.git'), { recursive: true });
        return makeChild({ code: 0, delayMs: 40 });
      }
      if (bin === 'gh' && args[0] === '--version') {
        return makeChild({ code: 0, stdout: 'gh version 2.50.0\n' });
      }
      if (bin === 'gh' && args[0] === 'auth') {
        return makeChild({ code: 0, stdout: 'Logged in to github.com account octo\nActive account: true\n' });
      }
      if (bin === 'gh' && args[0] === 'repo' && args[1] === 'list') {
        return makeChild({
          code: 0,
          stdout: JSON.stringify([{ nameWithOwner: 'octo/repo', url: 'https://github.com/octo/repo', isPrivate: false }])
        });
      }
      return makeChild({ code: 0 });
    },
    createProjectFn: (payload) => metaStore.createProject(payload)
  });

  let channelMode = 'cloudflare';
  const srv = createWebServer({
    port: 0,
    pairingToken: 'tok-prov-123',
    confirmSecret: 'cf-secret-prov',
    permissionLevel: 'L1',
    channels: { loopback: true, lan: true, tailscale: true, bonjour: true, cloudflare: true },
    resolveChannel: () => channelMode,
    workspaceMetaStore: metaStore,
    sessionOrgBridge: bridge,
    workspaceBrowser: browser,
    remoteProvisioner: provisioner,
    deltaPollIntervalMs: 0
  });

  try {
    const info = await srv.start();
    const base = `http://127.0.0.1:${info.port}`;
    const auth = { Authorization: 'Bearer tok-prov-123' };

    // L1 blocked on L2 browse/preflight
    const l1Browse = await httpRequest(`${base}/api/v1/workspace/browse?path=${encodeURIComponent(wsRoot)}`, { headers: auth });
    assert.equal(l1Browse.status, 403);
    assert.equal(l1Browse.json.required, 'L2');

    srv.updateAccessConfig({ permissionLevel: 'L2' });

    // L2 GET routes pass on Cloudflare without X-Agy-Confirm
    assert.equal((await httpRequest(`${base}/api/v1/workspace/browse?path=${encodeURIComponent(wsRoot)}`, { headers: auth })).status, 200);
    const pfRes = await httpRequest(`${base}/api/v1/workspace/remote-preflight?provider=github`, { headers: auth });
    assert.equal(pfRes.status, 200);
    assert.equal(pfRes.json.github.ghAuthenticated, true);
    const reposRes = await httpRequest(`${base}/api/v1/workspace/github-repos`, { headers: auth });
    assert.equal(reposRes.status, 200);
    assert.equal(reposRes.json.repos[0].nameWithOwner, 'octo/repo');

    // POST mkdir & remote-jobs require X-Agy-Confirm on Cloudflare
    const jobCh = await httpRequest(`${base}/api/v1/projects/remote-jobs`, {
      method: 'POST',
      headers: auth,
      body: {
        provider: 'github',
        mode: 'gh_clone',
        projectName: 'Repo One',
        parentDir: wsRoot,
        localDirName: 'repo-one',
        github: { repoSpec: 'octo/repo' }
      }
    });
    assert.equal(jobCh.status, 403);
    assert.equal(jobCh.json.error, 'CONFIRMATION_REQUIRED');

    const jobStart = await httpRequest(`${base}/api/v1/projects/remote-jobs`, {
      method: 'POST',
      headers: { ...auth, 'X-Agy-Confirm': jobCh.json.confirmToken },
      body: {
        provider: 'github',
        mode: 'gh_clone',
        projectName: 'Repo One',
        parentDir: wsRoot,
        localDirName: 'repo-one',
        github: { repoSpec: 'octo/repo' }
      }
    });
    assert.equal(jobStart.status, 202);
    assert.ok(jobStart.json.jobId);

    // /cancel exempts X-Agy-Confirm
    const cancelRes = await httpRequest(`${base}/api/v1/projects/remote-jobs/${jobStart.json.jobId}/cancel`, {
      method: 'POST',
      headers: auth,
      body: {}
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.json.job.status, 'cancelled');
  } finally {
    provisioner.dispose();
    bridge.dispose();
    await srv.stop();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
});

test('HUB-296: getPairingUrl() prioritizes highest-priority enabled non-loopback channel URL over loopback', async () => {
  const srv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken: 'tok-pairing-priority',
    channels: { loopback: true, lan: false, tailscale: false, bonjour: false, cloudflare: false }
  });
  try {
    const info = await srv.start();
    const localUrl = `http://127.0.0.1:${info.port}/?token=tok-pairing-priority`;
    assert.equal(srv.getPairingUrl(), localUrl);

    // Enable bonjour -> bonjour beats loopback
    srv.updateAccessConfig({ channels: { loopback: true, bonjour: true } });
    const bonjourPairing = srv.getPairingUrl();
    assert.match(bonjourPairing, /^http:\/\/.+\.local:\d+\/\?token=tok-pairing-priority$/);
    assert.equal(bonjourPairing.includes('127.0.0.1'), false);

    // Enable cloudflare with tunnelHostname -> cloudflare beats bonjour/lan/tailscale/loopback
    srv.updateAccessConfig({
      channels: { loopback: true, bonjour: true, cloudflare: true },
      tunnelHostname: 'https://pcweb.example.com'
    });
    assert.equal(srv.getPairingUrl(), 'https://pcweb.example.com/?token=tok-pairing-priority');

    // Shared /pc mount path also respected in getPairingUrl()
    srv.cloudflareMountPath = '/pc';
    assert.equal(srv.getPairingUrl(), 'https://pcweb.example.com/pc/?token=tok-pairing-priority');

    // Back to loopback-only -> falls back to loopback pairing URL
    srv.cloudflareMountPath = '';
    srv.updateAccessConfig({ channels: { loopback: true, bonjour: false, cloudflare: false } });
    assert.equal(srv.getPairingUrl(), localUrl);
  } finally {
    await srv.stop();
  }
});

test('HUB-314: GET /api/v1/sessions/:id enforces route timeout (504) and GET /api/v1/tasks passes sessionId/project filters', async () => {
  const listTaskCalls = [];
  const srv = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken: 'tok-hub314-http',
    sessionDetailTimeoutMs: 60,
    harnessAdapter: {
      async getSessionDetail(id) {
        if (id === 'hang-session') {
          return await new Promise(() => {});
        }
        return { ok: true, session: { cascadeId: id }, events: [] };
      }
    },
    taskManager: {
      async listTasks(opts = {}) {
        listTaskCalls.push(opts);
        const allRunning = [
          {
            taskId: 'session:s1',
            kind: 'session',
            title: 'Alpha Session',
            projectPath: '/work/alpha',
            projectName: 'alpha',
            sessionId: 's1',
            sessionTitle: 'Alpha Session',
            status: 'running'
          },
          {
            taskId: 'session:s2',
            kind: 'session',
            title: 'Beta Session',
            projectPath: '/work/beta',
            projectName: 'beta',
            sessionId: 's2',
            sessionTitle: 'Beta Session',
            status: 'running'
          }
        ];
        const filtered = allRunning.filter((t) => {
          if (opts.sessionId && t.sessionId !== opts.sessionId) return false;
          if (opts.project && t.projectPath !== opts.project) return false;
          return true;
        });
        return {
          ok: true,
          runningCount: filtered.length,
          totalRunningCount: allRunning.length,
          running: filtered,
          recent: [],
          filters: {
            projects: [
              { key: '/work/alpha', name: 'alpha', path: '/work/alpha', count: 1 },
              { key: '/work/beta', name: 'beta', path: '/work/beta', count: 1 }
            ],
            sessions: [
              { id: 's1', title: 'Alpha Session', projectPath: '/work/alpha', count: 1 },
              { id: 's2', title: 'Beta Session', projectPath: '/work/beta', count: 1 }
            ]
          },
          serverTime: Date.now()
        };
      }
    }
  });

  try {
    const info = await srv.start();
    const baseUrl = `http://127.0.0.1:${info.port}`;
    const auth = { Authorization: 'Bearer tok-hub314-http' };

    const hangRes = await httpRequest(`${baseUrl}/api/v1/sessions/hang-session`, { headers: auth });
    assert.equal(hangRes.status, 504);
    assert.equal(hangRes.json.ok, false);
    assert.equal(hangRes.json.error, 'SESSION_DETAIL_TIMEOUT');

    const tasksRes = await httpRequest(
      `${baseUrl}/api/v1/tasks?sessionId=s1&project=${encodeURIComponent('/work/alpha')}`,
      { headers: auth }
    );
    assert.equal(tasksRes.status, 200);
    assert.equal(tasksRes.json.runningCount, 1);
    assert.equal(tasksRes.json.totalRunningCount, 2);
    assert.equal(tasksRes.json.running.length, 1);
    assert.equal(tasksRes.json.running[0].taskId, 'session:s1');
    assert.equal(tasksRes.json.filters.projects.length, 2);
    assert.deepEqual(listTaskCalls[0], { sessionId: 's1', project: '/work/alpha' });
  } finally {
    await srv.stop();
  }
});

test('D21: /api/v1/pet/state, /api/v1/pet/interact, and /api/v1/pet/themes enforce channel tiers & Cloudflare confirmation', async () => {
  const interactCalls = [];
  const { srv, state } = channelServer({
    channels: { loopback: true, lan: true, cloudflare: true },
    permissionLevel: 'L0',
    hostProxy: {
      ...createFakeDeps().hostProxy,
      async getPetState() {
        return {
          ok: true,
          available: true,
          state: { enabled: true, desktopVisible: true, webVisible: true, themeId: 'daddy-orb' },
          scene: { sceneId: 'daddy-orb', layers: [] },
          themes: []
        };
      },
      async interactPet(payload) {
        interactCalls.push(payload);
        if (payload?.action === 'import-theme') {
          return { ok: true, theme: { id: 'custom-imported', builtin: false } };
        }
        return { ok: true };
      }
    }
  });

  const info = await srv.start();
  const baseUrl = `http://127.0.0.1:${info.port}`;
  const bearer = { Authorization: 'Bearer pairing-secret-token-12345' };

  try {
    state.channel = 'lan';
    const petGet = await httpRequest(`${baseUrl}/api/v1/pet/state`, { headers: bearer });
    assert.equal(petGet.status, 200);
    assert.equal(petGet.json.available, true);
    assert.equal(petGet.json.state.themeId, 'daddy-orb');

    // L0 allows lightweight L0 interaction (bubble-dismiss / set-active-session / update-web-anchor)
    const l0Interact = await httpRequest(`${baseUrl}/api/v1/pet/interact`, {
      method: 'POST',
      headers: bearer,
      body: { action: 'set-active-session', cascadeId: 's-1' }
    });
    assert.equal(l0Interact.status, 200);
    assert.equal(l0Interact.json.ok, true);

    // L0 rejects theme import even when tunneled via /api/v1/pet/interact
    const l0ImportViaInteract = await httpRequest(`${baseUrl}/api/v1/pet/interact`, {
      method: 'POST',
      headers: bearer,
      body: { action: 'import-theme', fileName: 'x.svg', svgText: '<svg/>' }
    });
    assert.equal(l0ImportViaInteract.status, 403);
    assert.equal(l0ImportViaInteract.json.error, 'PERMISSION_DENIED');
    assert.equal(l0ImportViaInteract.json.required, 'L1');

    // Cloudflare L1 requires CONFIRMATION_REQUIRED for POST /api/v1/pet/themes
    srv.updateAccessConfig({ permissionLevel: 'L1' });
    state.channel = 'cloudflare';
    const cfChallenge = await httpRequest(`${baseUrl}/api/v1/pet/themes`, {
      method: 'POST',
      headers: bearer,
      body: { fileName: 'buddy.svg', svgText: '<svg/>' }
    });
    assert.equal(cfChallenge.status, 403);
    assert.equal(cfChallenge.json.error, 'CONFIRMATION_REQUIRED');
    assert.equal(cfChallenge.json.action, 'POST /api/v1/pet/themes');

    const cfConfirmed = await httpRequest(`${baseUrl}/api/v1/pet/themes`, {
      method: 'POST',
      headers: { ...bearer, 'X-Agy-Confirm': cfChallenge.json.confirmToken },
      body: { fileName: 'buddy.svg', svgText: '<svg/>' }
    });
    assert.equal(cfConfirmed.status, 200);
    assert.equal(cfConfirmed.json.theme.id, 'custom-imported');
    assert.equal(interactCalls.length, 2);
  } finally {
    await srv.stop();
  }
});

test('HUB-332: web-server exposes enableNotifications default/value and syncs PUT updates over SSE', async () => {
  let persistedWebSettings = { port: 18767 };
  const srv = createWebServer({
    port: 0,
    pairingToken: 'tok-hub332-http',
    enableNotifications: false,
    hostProxy: {
      async getPluginSettings(pluginId) {
        if (pluginId === 'agy-daddy.web') {
          return { ok: true, values: { ...persistedWebSettings }, schema: { fields: [] } };
        }
        return { ok: true, values: {} };
      },
      async setPluginSettings(pluginId, patch) {
        if (pluginId === 'agy-daddy.web') {
          persistedWebSettings = { ...persistedWebSettings, ...patch };
          return { ok: true, values: { ...persistedWebSettings } };
        }
        return { ok: true, values: patch };
      }
    }
  });

  try {
    const info = await srv.start();
    const baseUrl = `http://127.0.0.1:${info.port}`;
    const authHeaders = { Authorization: 'Bearer tok-hub332-http' };

    const statusInitial = await httpRequest(`${baseUrl}/api/v1/web/status`, { headers: authHeaders });
    assert.equal(statusInitial.status, 200);
    assert.equal(statusInitial.json.enableNotifications, false);

    const settingsInitial = await httpRequest(`${baseUrl}/api/v1/host/plugins/agy-daddy.web/settings`, {
      headers: authHeaders
    });
    assert.equal(settingsInitial.status, 200);
    assert.equal(settingsInitial.json.values.enableNotifications, false);

    const sseClient = await openSse(`${baseUrl}/api/v1/stream`, authHeaders);
    const putRes = await httpRequest(`${baseUrl}/api/v1/host/plugins/agy-daddy.web/settings`, {
      method: 'PUT',
      headers: authHeaders,
      body: { patch: { enableNotifications: true } }
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.json.values.enableNotifications, true);

    const sseEv = await sseClient.waitForEvent(
      (ev) =>
        ev.event === 'state.patch' &&
        ev.json?.key === 'state:plugin.settings@1' &&
        ev.json?.value?.pluginId === 'agy-daddy.web'
    );
    assert.equal(sseEv.json.value.values.enableNotifications, true);
    sseClient.close();

    const statusAfter = await httpRequest(`${baseUrl}/api/v1/web/status`, { headers: authHeaders });
    assert.equal(statusAfter.status, 200);
    assert.equal(statusAfter.json.enableNotifications, true);
  } finally {
    await srv.stop();
  }
});
