'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createHostProxy } = require('../src/host-proxy');
const { createWebServer, requiredPermissionFor } = require('../src/web-server');

function httpRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const bodyText = options.body !== undefined ? JSON.stringify(options.body) : null;
    const headers = {
      ...(options.headers || {}),
      ...(bodyText !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText) } : {})
    };
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (bodyText !== null) req.write(bodyText);
    req.end();
  });
}

function connectSse(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const events = [];
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: 'GET',
      headers
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let eventName = 'message';
          let dataLine = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
          }
          if (dataLine) {
            try { events.push({ event: eventName, data: JSON.parse(dataLine) }); } catch {}
          }
        }
      });
      resolve({
        res,
        events,
        close: () => { try { req.destroy(); } catch {} }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('PC Web 更新代理、L0/L2 权限门禁、/host/host-settings 隔离与 SSE state:host.updates@1 广播', async (t) => {
  assert.equal(requiredPermissionFor('GET', '/api/v1/host/updates'), 'L0');
  assert.equal(requiredPermissionFor('POST', '/api/v1/host/updates/check'), 'L2');
  assert.equal(requiredPermissionFor('POST', '/api/v1/host/updates/apply'), 'L2');
  assert.equal(requiredPermissionFor('POST', '/api/v1/host/updates/rollback'), 'L2');
  assert.equal(requiredPermissionFor('POST', '/api/v1/host/updates/pin'), 'L2');
  assert.equal(requiredPermissionFor('PUT', '/api/v1/host/update-settings'), 'L2');

  const controlCalls = [];
  const hostProxy = createHostProxy({
    host: {
      control: {
        async invoke(route, body) {
          controlCalls.push({ route, body });
          if (route === '/host/updates/status') {
            return {
              ok: true,
              hostVersion: '1.1.1',
              summary: { availableCount: 1, pluginAvailableCount: 1, hostAvailable: false, registryAvailable: false, blockedCount: 0 }
            };
          }
          if (route === '/host/updates/check') {
            return {
              ok: true,
              checkedNow: true,
              summary: { availableCount: 2, pluginAvailableCount: 1, hostAvailable: true, registryAvailable: false, blockedCount: 0 }
            };
          }
          if (route === '/host/updates/apply') {
            return {
              ok: true,
              deferredReload: true,
              summary: { availableCount: 0, pluginAvailableCount: 0, hostAvailable: false, registryAvailable: false, blockedCount: 0 }
            };
          }
          if (route === '/host/updates/rollback') {
            return { ok: true, target: body.target, restoredVersion: '1.0.0' };
          }
          if (route === '/host/updates/pin') {
            return { ok: true, pluginId: body.pluginId, pinned: body.pinned };
          }
          if (route === '/host/host-settings') {
            return { ok: true, values: { updateChannel: 'next', ...body.patch } };
          }
          if (route === '/host/settings') {
            return { ok: true, values: { theme: 'dark' } };
          }
          return { ok: true };
        }
      }
    }
  });

  // Test non-loopback L0 vs L2 gating via resolveChannel seam
  let simulatedChannel = 'lan';
  let simulatedLevel = 'L0';
  const server = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken: 'test-token-1234',
    tokenSource: 'remote',
    channels: { loopback: true, lan: true },
    getPermissionLevel: () => simulatedLevel,
    resolveChannel: () => simulatedChannel,
    hostProxy
  });
  const started = await server.start();
  t.after(async () => { await server.stop().catch(() => {}); });

  const baseUrl = `http://127.0.0.1:${started.port}`;
  const bearer = { Authorization: 'Bearer test-token-1234' };

  // 1. Non-loopback L0 can read GET /api/v1/host/updates, blocked (403) on all write endpoints
  const l0Get = await httpRequest(`${baseUrl}/api/v1/host/updates`, { headers: bearer });
  assert.equal(l0Get.status, 200);
  assert.equal(l0Get.json.hostVersion, '1.1.1');

  for (const [method, pathName, body] of [
    ['POST', '/api/v1/host/updates/check', {}],
    ['POST', '/api/v1/host/updates/apply', { targets: ['agy-daddy.web'] }],
    ['POST', '/api/v1/host/updates/rollback', { target: 'agy-daddy.web' }],
    ['POST', '/api/v1/host/updates/pin', { pluginId: 'agy-daddy.quota', pinned: true }],
    ['PUT', '/api/v1/host/update-settings', { patch: { updateChannel: 'next' } }]
  ]) {
    const denied = await httpRequest(`${baseUrl}${pathName}`, { method, headers: bearer, body });
    assert.equal(denied.status, 403, `Expected 403 on ${method} ${pathName} at L0`);
  }

  // 2. Elevate to L2 + connect SSE to observe state.patch broadcasts
  simulatedLevel = 'L2';
  const sse = await connectSse(`${baseUrl}/api/v1/stream`, bearer);
  t.after(() => sse.close());
  await new Promise((r) => setTimeout(r, 40));

  const checkRes = await httpRequest(`${baseUrl}/api/v1/host/updates/check`, {
    method: 'POST',
    headers: bearer,
    body: { forceRefresh: true }
  });
  assert.equal(checkRes.status, 200);
  assert.equal(checkRes.json.summary.availableCount, 2);

  const applyRes = await httpRequest(`${baseUrl}/api/v1/host/updates/apply`, {
    method: 'POST',
    headers: bearer,
    body: { targets: ['agy-daddy.web'] }
  });
  assert.equal(applyRes.status, 200);
  assert.equal(applyRes.json.deferredReload, true);

  const rbRes = await httpRequest(`${baseUrl}/api/v1/host/updates/rollback`, {
    method: 'POST',
    headers: bearer,
    body: { target: 'agy-daddy.web' }
  });
  assert.equal(rbRes.status, 200);
  assert.equal(rbRes.json.restoredVersion, '1.0.0');

  const pinRes = await httpRequest(`${baseUrl}/api/v1/host/updates/pin`, {
    method: 'POST',
    headers: bearer,
    body: { pluginId: 'agy-daddy.quota', pinned: true }
  });
  assert.equal(pinRes.status, 200);

  // 3. PUT /api/v1/host/update-settings routes strictly to /host/host-settings (not /host/settings)
  const badPatch = await httpRequest(`${baseUrl}/api/v1/host/update-settings`, {
    method: 'PUT',
    headers: bearer,
    body: { patch: 'invalid' }
  });
  assert.equal(badPatch.status, 400);

  const updSet = await httpRequest(`${baseUrl}/api/v1/host/update-settings`, {
    method: 'PUT',
    headers: bearer,
    body: { patch: { updateChannel: 'next', autoUpdateMode: 'auto-safe' } }
  });
  assert.equal(updSet.status, 200);
  assert.equal(updSet.json.values.autoUpdateMode, 'auto-safe');

  // Verify legacy /api/v1/host/settings still invokes /host/settings
  await httpRequest(`${baseUrl}/api/v1/host/settings`, { headers: bearer });

  await new Promise((r) => setTimeout(r, 60));
  const updatePatches = sse.events.filter((e) => e.event === 'state.patch' && e.data?.key === 'state:host.updates@1');
  assert.ok(updatePatches.length >= 4, `Expected >=4 SSE state:host.updates@1 patches, got ${updatePatches.length}`);

  assert.ok(controlCalls.some((c) => c.route === '/host/host-settings' && c.body?.action === 'save'));
  assert.ok(controlCalls.some((c) => c.route === '/host/settings' && c.body?.scope === 'host'));
});
