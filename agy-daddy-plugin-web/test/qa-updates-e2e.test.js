'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const { createHostProxy } = require('../src/host-proxy');
const { createWebServer } = require('../src/web-server');
const { AgyDaddyDaemon } = require('../../agy-daddy-host/src/core/daemon');
const { createTarGzBuffer } = require('../../agy-daddy-host/src/core/tar');
const { installPlugin, readInstalledIndex } = require('../../agy-daddy-host/src/core/installer');

function makeTempDir(t, prefix = 'agy-qa-web-e2e-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return dir;
}

function sha512Integrity(buf) {
  return `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
}

function makePluginTgz(manifest) {
  return createTarGzBuffer({
    'package.json': JSON.stringify({ name: `@third/${manifest.id}`, version: manifest.version }),
    'agy-plugin.json': JSON.stringify(manifest),
    'index.js': 'module.exports = { activate() {} };'
  });
}

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

test('QA-E2E: WebServer + HostProxy 真实联调 AgyDaddyDaemon 完成设置、检查、权限确认、升级、回滚、Pin 与 SSE 广播', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');

  const manV1 = {
    schemaVersion: 1, id: 'third.webe2e', publisher: 'third', version: '1.0.0',
    displayName: 'Web E2E', engines: { agyDaddy: '^1.0.0' }, world: 'isolated', main: './index.js', permissions: ['dom:read']
  };
  const manV12 = { ...manV1, version: '1.2.0', permissions: ['dom:read', 'bridge:route'] };
  const tgzV1 = makePluginTgz(manV1);
  const tgzV12 = makePluginTgz(manV12);

  const npmServer = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const port = npmServer.address().port;
    if (p === '/@third%2Fwebe2e') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        name: '@third/webe2e',
        'dist-tags': { latest: '1.2.0' },
        versions: {
          '1.0.0': { dist: { tarball: `http://127.0.0.1:${port}/v1.tgz`, integrity: sha512Integrity(tgzV1) } },
          '1.2.0': { dist: { tarball: `http://127.0.0.1:${port}/v12.tgz`, integrity: sha512Integrity(tgzV12) } }
        }
      }));
    }
    if (p === '/@agy-daddy%2Fhost' || p === '/@agy-daddy%2Fregistry') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ name: p, 'dist-tags': { latest: '1.1.1' }, versions: { '1.1.1': { dist: {} } } }));
    }
    if (p === '/v1.tgz') return res.writeHead(200).end(tgzV1);
    if (p === '/v12.tgz') return res.writeHead(200).end(tgzV12);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => npmServer.listen(0, '127.0.0.1', resolve));
  t.after(() => npmServer.close());
  const npmRegistryUrl = `http://127.0.0.1:${npmServer.address().port}`;

  await installPlugin('npm:@third/webe2e@1.0.0', {
    stateDir, pluginsDir, npmRegistryUrl, trustLevel: 'T2', grantedPermissions: ['dom:read']
  });

  const daemon = new AgyDaddyDaemon({ stateDir, pluginsDir, npmRegistryUrl, skipInject: true });
  const daemonStarted = await daemon.start();
  t.after(async () => { await daemon.stop().catch(() => {}); });

  const daemonBase = `http://127.0.0.1:${daemonStarted.port}`;
  const hostProxy = createHostProxy({
    host: {
      control: {
        async invoke(route, body) {
          const resp = await fetch(`${daemonBase}${route}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-AGY-Host-Token': daemonStarted.hostToken
            },
            body: JSON.stringify(body || {})
          });
          return resp.json();
        }
      }
    }
  });

  let simulatedLevel = 'L0';
  const webServer = createWebServer({
    host: '127.0.0.1',
    port: 0,
    pairingToken: 'qa-e2e-token-1234',
    tokenSource: 'remote',
    channels: { loopback: true, lan: true },
    getPermissionLevel: () => simulatedLevel,
    resolveChannel: () => 'lan',
    hostProxy
  });
  const webStarted = await webServer.start();
  t.after(async () => { await webServer.stop().catch(() => {}); });

  const webBase = `http://127.0.0.1:${webStarted.port}`;
  const headers = { Authorization: 'Bearer qa-e2e-token-1234' };

  // L0 read allowed, writes blocked
  const l0Get = await httpRequest(`${webBase}/api/v1/host/updates`, { headers });
  assert.equal(l0Get.status, 200);
  assert.equal(l0Get.json.ok, true);
  const l0Post = await httpRequest(`${webBase}/api/v1/host/updates/check`, { method: 'POST', headers, body: {} });
  assert.equal(l0Post.status, 403);

  // L2 elevate + SSE
  simulatedLevel = 'L2';
  const sse = await connectSse(`${webBase}/api/v1/stream`, headers);
  t.after(() => sse.close());
  await new Promise((r) => setTimeout(r, 40));

  const saveSet = await httpRequest(`${webBase}/api/v1/host/update-settings`, {
    method: 'PUT',
    headers,
    body: { patch: { npmRegistryUrl, updateChannel: 'stable', autoUpdateMode: 'notify' } }
  });
  assert.equal(saveSet.status, 200);
  assert.equal(saveSet.json.values.npmRegistryUrl, npmRegistryUrl);

  const chkRes = await httpRequest(`${webBase}/api/v1/host/updates/check`, {
    method: 'POST',
    headers,
    body: { targets: ['third.webe2e'], forceRefresh: true }
  });
  assert.equal(chkRes.status, 200);
  assert.equal(chkRes.json.targets['third.webe2e'].latestVersion, '1.2.0');

  // Apply without permission -> confirmation block
  const permNeed = await httpRequest(`${webBase}/api/v1/host/updates/apply`, {
    method: 'POST',
    headers,
    body: { targets: ['third.webe2e'] }
  });
  assert.equal(permNeed.json.needsPermissionConfirm, true);

  // Approve permission -> upgrades to 1.2.0
  const applyOk = await httpRequest(`${webBase}/api/v1/host/updates/apply`, {
    method: 'POST',
    headers,
    body: { targets: ['third.webe2e'], grantedPermissions: { 'third.webe2e': ['bridge:route'] } }
  });
  assert.equal(applyOk.status, 200);
  assert.equal(applyOk.json.ok, true);
  assert.equal(readInstalledIndex({ stateDir }).plugins['third.webe2e'].version, '1.2.0');

  // Rollback -> restores 1.0.0
  const rbRes = await httpRequest(`${webBase}/api/v1/host/updates/rollback`, {
    method: 'POST',
    headers,
    body: { target: 'third.webe2e' }
  });
  assert.equal(rbRes.status, 200);
  assert.equal(rbRes.json.restoredVersion, '1.0.0');
  assert.equal(readInstalledIndex({ stateDir }).plugins['third.webe2e'].version, '1.0.0');

  // Pin -> locks in installed-plugins.json
  const pinRes = await httpRequest(`${webBase}/api/v1/host/updates/pin`, {
    method: 'POST',
    headers,
    body: { pluginId: 'third.webe2e', pinned: true }
  });
  assert.equal(pinRes.status, 200);
  assert.equal(readInstalledIndex({ stateDir }).plugins['third.webe2e'].pinned, true);

  await new Promise((r) => setTimeout(r, 60));
  const patches = sse.events.filter((e) => e.event === 'state.patch' && e.data?.key === 'state:host.updates@1');
  assert.ok(patches.length >= 4);
});
