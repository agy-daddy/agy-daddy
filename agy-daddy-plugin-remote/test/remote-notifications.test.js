'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const { createWebPushManager } = require('../src/web-push');
const { createSseBroker } = require('../src/sse-broker');

function makeDummyP256Sub(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url')
    }
  };
}

function decryptWebPushPayload(bodyBuf, uaEcdh, authSecret) {
  const salt = bodyBuf.subarray(0, 16);
  const idlen = bodyBuf.readUInt8(20);
  const asPublic = bodyBuf.subarray(21, 21 + idlen);
  const ciphertextWithTag = bodyBuf.subarray(21 + idlen);
  const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
  const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);

  const uaPublic = uaEcdh.getPublicKey();
  const sharedSecret = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(authTag);
  const plainPadded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.equal(plainPadded[plainPadded.length - 1], 0x02);
  return plainPadded.subarray(0, plainPadded.length - 1);
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuf = options.body !== undefined
      ? Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body), 'utf8')
      : null;
    const req = http.request(url, {
      method: options.method || 'GET',
      agent: false,
      headers: {
        Connection: 'close',
        ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': String(bodyBuf.byteLength) } : {}),
        ...(options.headers || {})
      }
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
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function openSse(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(urlStr, { method: 'GET', agent: false, headers }, (res) => {
      let buffer = '';
      const events = [];
      const waiters = [];

      function flush() {
        while (waiters.length > 0) {
          const w = waiters[0];
          const found = events.find(w.pred);
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
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = block.split('\n').filter((l) => l && !l.startsWith(':'));
          if (lines.length === 0) continue;
          const ev = { id: null, event: 'message', data: '' };
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith('id:')) ev.id = line.slice(3).trim();
            else if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          const rawData = dataLines.join('\n');
          try { ev.data = JSON.parse(rawData); } catch { ev.data = rawData; }
          events.push(ev);
          flush();
        }
      });

      resolve({
        status: res.statusCode,
        events,
        waitFor(pred, timeoutMs = 2000) {
          const existing = events.find(pred);
          if (existing) return Promise.resolve(existing);
          return new Promise((resW, rejW) => {
            const timer = setTimeout(() => rejW(new Error('SSE_WAIT_TIMEOUT')), timeoutMs);
            waiters.push({ pred, resolve: resW, reject: rejW, timer });
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

test('settings.schema.json declares enablePushNotifications & enableAppBadge with defaults and i18n', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'settings.schema.json'), 'utf8'));
  const pushField = schema.fields.find((f) => f.key === 'enablePushNotifications');
  const badgeField = schema.fields.find((f) => f.key === 'enableAppBadge');

  assert.ok(pushField);
  assert.equal(pushField.type, 'boolean');
  assert.equal(pushField.default, true);
  assert.deepEqual(pushField.group, { 'zh-CN': '通知与提醒', en: 'Notifications & Alerts' });
  assert.deepEqual(pushField.label, { 'zh-CN': '远程推送通知', en: 'Push Notifications' });
  assert.ok(pushField.description?.['zh-CN'] && pushField.description?.en);

  assert.ok(badgeField);
  assert.equal(badgeField.type, 'boolean');
  assert.equal(badgeField.default, true);
  assert.deepEqual(badgeField.group, { 'zh-CN': '通知与提醒', en: 'Notifications & Alerts' });
  assert.deepEqual(badgeField.label, { 'zh-CN': 'PWA 图标角标', en: 'PWA App Icon Badge' });
  assert.ok(badgeField.description?.['zh-CN'] && badgeField.description?.en);
});

test('web-push manager intercepts delivery when disabled and includes badgeEnabled/badgeCount in payload', async () => {
  let pushEnabled = true;
  let badgeEnabled = true;
  const delivered = [];

  const uaEcdh = crypto.createECDH('prime256v1');
  uaEcdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const sub = {
    endpoint: 'https://push.example.com/sub-1',
    keys: {
      p256dh: uaEcdh.getPublicKey().toString('base64url'),
      auth: authSecret.toString('base64url')
    }
  };

  const mgr = createWebPushManager({
    isTestMode: true,
    isEnabled: () => pushEnabled,
    isBadgeEnabled: () => badgeEnabled,
    fetchImpl: async (url, init) => {
      delivered.push({ url, body: init.body });
      return { status: 201 };
    }
  });
  mgr.subscribe(sub);

  // Enabled + badge enabled
  const r1 = await mgr.sendTestNotification({ badgeCount: 3 });
  assert.equal(r1.sent, 1);
  assert.equal(delivered.length, 1);
  const p1 = JSON.parse(decryptWebPushPayload(delivered[0].body, uaEcdh, authSecret).toString('utf8'));
  assert.equal(p1.badgeEnabled, true);
  assert.equal(p1.badgeCount, 3);
  assert.equal(p1.unreadCount, 3);

  // Disabled push -> intercepted without hitting fetch
  pushEnabled = false;
  const r2 = await mgr.sendTestNotification();
  assert.equal(r2.ok, true);
  assert.equal(r2.disabled, true);
  assert.equal(r2.skipped, true);
  assert.equal(r2.sent, 0);
  assert.equal(delivered.length, 1);

  // Re-enabled push + disabled badge
  pushEnabled = true;
  badgeEnabled = false;
  const r3 = await mgr.sendTestNotification({ badgeCount: 5 });
  assert.equal(r3.sent, 1);
  assert.equal(delivered.length, 2);
  const p3 = JSON.parse(decryptWebPushPayload(delivered[1].body, uaEcdh, authSecret).toString('utf8'));
  assert.equal(p3.badgeEnabled, false);
  assert.equal(p3.badgeCount, 0);
  assert.equal(p3.unreadCount, 0);
});

test('sse-broker pollSessions computes attentionCount across concurrent pending/attention sessions', async () => {
  const transitions = [];
  const broker = createSseBroker({
    pollIntervalMs: 20,
    heartbeatIntervalMs: 0,
    listSessions: async () => [
      { cascadeId: 's1', status: 'PENDING', needsAttention: true, attentionReason: 'Approve cmd' },
      { cascadeId: 's2', status: 'PENDING', needsAttention: true, attentionReason: 'Question' },
      { cascadeId: 's3', status: 'IDLE', needsAttention: false }
    ],
    onAttentionTransition: (evt) => transitions.push(evt)
  });

  try {
    await broker.triggerPoll();
    const deadline = Date.now() + 1000;
    while (transitions.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(transitions.length, 2);
    assert.equal(transitions[0].attentionCount, 2);
    assert.equal(transitions[1].attentionCount, 2);
  } finally {
    broker.dispose();
  }
});

test('plugin host settings toggle enablePushNotifications & enableAppBadge live across bootstrap, diagnostics, push test, and SSE state.patch', async () => {
  const harness = createMockHostHarness({
    pluginSettings: {
      'agy-daddy.remote': {
        permissionLevel: 'L1',
        allowRemoteWrite: true,
        loopback: true
      }
    },
    onRpc(method) {
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: {} };
      return {};
    }
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-remote-notif-'));
  let sse = null;

  try {
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st0 = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}` };

    assert.equal(st0.enablePushNotifications, true);
    assert.equal(st0.enableAppBadge, true);

    const boot1 = await httpRequest(`${st0.url}/api/v1/bootstrap`, { headers: auth });
    assert.equal(boot1.status, 200);
    assert.equal(boot1.json.enablePushNotifications, true);
    assert.equal(boot1.json.enableAppBadge, true);
    assert.deepEqual(boot1.json.notifications, { enablePushNotifications: true, enableAppBadge: true });

    const vapid1 = await httpRequest(`${st0.url}/api/v1/push/vapid-key`, { headers: auth });
    assert.equal(vapid1.status, 200);
    assert.equal(vapid1.json.enablePushNotifications, true);
    assert.equal(vapid1.json.enableAppBadge, true);

    const sub = makeDummyP256Sub('https://push.example/notif-test');
    const subRes = await httpRequest(`${st0.url}/api/v1/push/subscribe`, {
      method: 'POST',
      headers: auth,
      body: { subscription: sub }
    });
    assert.equal(subRes.status, 200);

    const pushOk = await httpRequest(`${st0.url}/api/v1/push/test`, {
      method: 'POST',
      headers: auth,
      body: {}
    });
    assert.equal(pushOk.status, 200);
    assert.equal(pushOk.json.sent, 1);

    sse = await openSse(`${st0.url}/api/v1/stream?t=${encodeURIComponent(token)}`);

    // Disable push notifications and app badge in host settings
    await harness.updatePluginSettings('agy-daddy.remote', {
      enablePushNotifications: false,
      enableAppBadge: false
    });

    const patchEvt = await sse.waitFor(
      (ev) => ev.event === 'state.patch' && ev.data?.key === 'state:remote.notifications@1'
    );
    assert.deepEqual(patchEvt.data.value, {
      enablePushNotifications: false,
      enableAppBadge: false
    });

    const st1 = await remoteSvc.getStatus();
    assert.equal(st1.enablePushNotifications, false);
    assert.equal(st1.enableAppBadge, false);

    const boot2 = await httpRequest(`${st0.url}/api/v1/bootstrap`, { headers: auth });
    assert.equal(boot2.json.enablePushNotifications, false);
    assert.equal(boot2.json.enableAppBadge, false);
    assert.deepEqual(boot2.json.notifications, { enablePushNotifications: false, enableAppBadge: false });

    const statusRes = await httpRequest(`${st0.url}/api/v1/push/status`, { headers: auth });
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.json.enablePushNotifications, false);
    assert.equal(statusRes.json.enableAppBadge, false);
    assert.equal(statusRes.json.subscriptionsCount, 1);

    const diagRes = await httpRequest(`${st0.url}/api/v1/diagnostics`, { headers: auth });
    const pushCheck = diagRes.json.checks.find((c) => c.id === 'push_sse');
    assert.match(pushCheck.detail, /disabled/i);

    const pushBlocked = await httpRequest(`${st0.url}/api/v1/push/test`, {
      method: 'POST',
      headers: auth,
      body: {}
    });
    assert.equal(pushBlocked.status, 200);
    assert.equal(pushBlocked.json.disabled, true);
    assert.equal(pushBlocked.json.sent, 0);

    // Re-enable push notifications and verify immediate recovery
    await harness.updatePluginSettings('agy-daddy.remote', {
      enablePushNotifications: true,
      enableAppBadge: true
    });
    const pushRestored = await httpRequest(`${st0.url}/api/v1/push/test`, {
      method: 'POST',
      headers: auth,
      body: {}
    });
    assert.equal(pushRestored.status, 200);
    assert.equal(pushRestored.json.sent, 1);

    await harness.unloadPlugin('agy-daddy.remote');
    harness.assertCleanDispose('agy-daddy.remote');
  } finally {
    if (sse) sse.close();
    await harness.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
