'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const HOST_DIR = path.join(ROOT_DIR, 'agy-daddy-host');
const REMOTE_DIR = path.join(ROOT_DIR, 'agy-daddy-plugin-remote');
const WEB_DIR = path.join(ROOT_DIR, 'agy-daddy-plugin-web');

const { createMockHostHarness } = require(path.join(HOST_DIR, 'sdk', 'mock-harness'));

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      agent: false,
      headers: {
        Connection: 'close',
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
    if (options.body !== undefined) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

function openSse(url, headers = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.get(url, { agent: false, headers }, (res) => {
      let closed = false;
      res.on('close', () => { closed = true; });
      res.on('end', () => { closed = true; });
      res.resume();
      if (res.statusCode !== 200) {
        settled = true;
        reject(new Error(`SSE failed with status ${res.statusCode}`));
        return;
      }
      settled = true;
      resolve({
        req,
        res,
        isClosed: () => closed,
        close: () => {
          try { req.destroy(); } catch {}
        }
      });
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

async function waitUntil(pred, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test('E2E: remote + web shared Cloudflare tunnel (/pc proxy), unified token rotation, L0 switch-ticket, confirm modal & degradation', async () => {
  const harness = createMockHostHarness({
    onRpc(method) {
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: {} };
      if (method === 'StartCascade') return { cascadeId: 'cid-e2e-new' };
      if (method === 'GetCascadeTrajectory') {
        return {
          status: 'CASCADE_RUN_STATUS_IDLE',
          numTotalSteps: 0,
          trajectory: { trajectoryId: 'traj-e2e', steps: [] }
        };
      }
      if (method === 'GetUserStatus') {
        return { userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'M1', modelOrAlias: { model: 'M1' } }] } } };
      }
      if (method === 'GetAvailableModels') {
        return { response: { defaultAgentModelId: 'M1', models: { M1: { model: 'M1', displayName: 'M1' } } } };
      }
      return { ok: true };
    }
  });

  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });

    // Load remote first, then web (both orders supported; verifies live sync)
    await harness.loadAndRunPlugin(REMOTE_DIR, { trustLevel: 'T0' });
    await harness.loadAndRunPlugin(WEB_DIR, { trustLevel: 'T0' });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const webSvc = harness.bus.getServiceProxy('web-harness');

    // 1. Unified token shared between remote and web
    const sharedToken = await remoteSvc.getPairingToken();
    const initWeb = await webSvc.getStatus();
    assert.equal(initWeb.pairingToken, sharedToken);

    // 2. Enable cloudflare on both plugins and start dryRun Quick tunnel
    await harness.updatePluginSettings('agy-daddy.remote', { cloudflare: true });
    await harness.updatePluginSettings('agy-daddy.web', { cloudflare: true, remotePermissionLevel: 'L0' });
    const quickTun = await remoteSvc.startTunnel({ dryRun: true, mode: 'quick' });
    assert.equal(quickTun.ok, true);
    const quickOrigin = new URL(quickTun.publicUrl).origin;

    assert.ok(await waitUntil(async () => {
      const ws = await webSvc.getStatus();
      return ws.cloudflareState?.mode === 'shared_ready' && ws.primaryChannel === 'cloudflare';
    }));

    const remoteSt = await remoteSvc.getStatus();
    const webSt = await webSvc.getStatus();
    assert.equal(webSt.primaryUrl, `${quickOrigin}/pc/?token=${sharedToken}`);

    const remoteBase = remoteSt.url;
    const webLocalBase = webSt.url;
    const quickHost = new URL(quickOrigin).host;
    const cfHeaders = { 'cf-ray': 'e2e-ray-1', Host: quickHost };

    // 3. /pc -> /pc/ 302 canonicalization, then /pc/?token=... -> Cookie Path=/pc + 302 /pc/?session=...
    const pcSlash = await httpRequest(`${remoteBase}/pc?token=${sharedToken}&session=sess-e2e`, { headers: cfHeaders });
    assert.equal(pcSlash.status, 302);
    assert.equal(pcSlash.headers.location, `/pc/?token=${sharedToken}&session=sess-e2e`);

    const pcLogin = await httpRequest(`${remoteBase}/pc/?token=${sharedToken}&session=sess-e2e`, { headers: cfHeaders });
    assert.equal(pcLogin.status, 302);
    assert.equal(pcLogin.headers.location, '/pc/?session=sess-e2e');
    const pcSetCookie = String(pcLogin.headers['set-cookie'] || '');
    assert.match(pcSetCookie, /Path=\/pc\b/);
    assert.match(pcSetCookie, /Secure/);
    const pcCookie = pcSetCookie.split(';')[0];

    // 4. Mobile PWA at / still serves landing page while /pc/ serves built PC Web HTML + relative assets
    const mobileRoot = await httpRequest(`${remoteBase}/?t=${sharedToken}`, { headers: cfHeaders });
    assert.equal(mobileRoot.status, 200);
    assert.match(mobileRoot.text, /id="agy-tunnel-landing"/);

    const pcHtml = await httpRequest(`${remoteBase}/pc/`, { headers: { ...cfHeaders, Cookie: pcCookie } });
    assert.equal(pcHtml.status, 200);
    assert.match(pcHtml.text, /\.\/theme-init\.js/);
    const assetMatch = pcHtml.text.match(/\.\/(assets\/index-[^"']+\.js)/);
    assert.ok(assetMatch, 'Built HTML must reference relative ./assets/index-*.js');

    const pcTheme = await httpRequest(`${remoteBase}/pc/theme-init.js`, { headers: cfHeaders });
    assert.equal(pcTheme.status, 200);
    const pcAsset = await httpRequest(`${remoteBase}/pc/${assetMatch[1]}`, { headers: cfHeaders });
    assert.equal(pcAsset.status, 200);

    // 5. /pc/api/v1/ping and /pc/api/v1/web/status (D20 + channel === 'cloudflare')
    const pcPing = await httpRequest(`${remoteBase}/pc/api/v1/ping`, { headers: cfHeaders });
    assert.equal(pcPing.status, 200);
    assert.equal(pcPing.json.channel, 'cloudflare');
    assert.equal(pcPing.text.includes(sharedToken), false);

    const pcStatus = await httpRequest(`${remoteBase}/pc/api/v1/web/status`, {
      headers: { ...cfHeaders, Cookie: pcCookie }
    });
    assert.equal(pcStatus.status, 200);
    assert.equal(pcStatus.json.channel, 'cloudflare');
    assert.equal(pcStatus.json.primaryChannel, 'cloudflare');
    assert.equal(pcStatus.text.includes(sharedToken), false);

    // 6. L0 write on /pc is strictly 403 PERMISSION_DENIED (never misclassified as loopback)
    const l0Blocked = await httpRequest(`${remoteBase}/pc/api/v1/sessions`, {
      method: 'POST',
      headers: { ...cfHeaders, Origin: quickOrigin, Cookie: pcCookie, 'X-Agy-Csrf': '1' },
      body: { title: 'blocked' }
    });
    assert.equal(l0Blocked.status, 403);
    assert.equal(l0Blocked.json.error, 'PERMISSION_DENIED');

    // 7. L0 multi-hop switch-ticket: /pc -> loopback -> /pc
    const toLocalTicket = await httpRequest(`${remoteBase}/pc/api/v1/web/switch-ticket`, {
      method: 'POST',
      headers: { ...cfHeaders, Origin: quickOrigin, Cookie: pcCookie, 'X-Agy-Csrf': '1' },
      body: { targetChannel: 'loopback', sessionId: 'sess-e2e' }
    });
    assert.equal(toLocalTicket.status, 200);
    const localTicketId = new URL(toLocalTicket.json.switchUrl).searchParams.get('switch_ticket');
    const localRedeem = await httpRequest(`${webLocalBase}/?switch_ticket=${localTicketId}&session=sess-e2e`);
    assert.equal(localRedeem.status, 302);
    assert.equal(localRedeem.headers.location, '/?session=sess-e2e');
    const localCookie = String(localRedeem.headers['set-cookie'] || '').split(';')[0];

    const toCfTicket = await httpRequest(`${webLocalBase}/api/v1/web/switch-ticket`, {
      method: 'POST',
      headers: { Cookie: localCookie, Origin: webLocalBase, 'X-Agy-Csrf': '1' },
      body: { targetChannel: 'cloudflare', sessionId: 'sess-e2e' }
    });
    assert.equal(toCfTicket.status, 200);
    assert.ok(toCfTicket.json.switchUrl.startsWith(`${quickOrigin}/pc/?switch_ticket=`));
    const backTicketId = new URL(toCfTicket.json.switchUrl).searchParams.get('switch_ticket');
    const cfRedeem = await httpRequest(`${remoteBase}/pc/?switch_ticket=${backTicketId}&session=sess-e2e`, {
      headers: cfHeaders
    });
    assert.equal(cfRedeem.status, 302);
    assert.equal(cfRedeem.headers.location, '/pc/?session=sess-e2e');

    // 8. L1 write on /pc triggers Cloudflare X-Agy-Confirm challenge using shared confirmSecret
    await harness.updatePluginSettings('agy-daddy.web', { remotePermissionLevel: 'L1' });
    const challenged = await httpRequest(`${remoteBase}/pc/api/v1/sessions`, {
      method: 'POST',
      headers: { ...cfHeaders, Origin: quickOrigin, Cookie: pcCookie, 'X-Agy-Csrf': '1' },
      body: { title: 'cf-confirmed-session' }
    });
    assert.equal(challenged.status, 403);
    assert.equal(challenged.json.error, 'CONFIRMATION_REQUIRED');
    assert.equal(challenged.json.action, 'POST /api/v1/sessions');

    const confirmed = await httpRequest(`${remoteBase}/pc/api/v1/sessions`, {
      method: 'POST',
      headers: {
        ...cfHeaders,
        Origin: quickOrigin,
        Cookie: pcCookie,
        'X-Agy-Csrf': '1',
        'X-Agy-Confirm': challenged.json.confirmToken
      },
      body: { title: 'cf-confirmed-session' }
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.json.cascadeId, 'cid-e2e-new');

    // 9. Named tunnel mode updates shared /pc/ URL seamlessly
    const namedConnector = Buffer.from(JSON.stringify({ a: 'acc', t: 'tun', s: 'sec' }), 'utf8').toString('base64');
    await harness.updatePluginSettings('agy-daddy.remote', {
      tunnelMode: 'named',
      tunnelHostname: 'https://ag-e2e.example.com',
      tunnelToken: namedConnector
    });
    const namedTun = await remoteSvc.startTunnel({ dryRun: true, mode: 'named' });
    assert.equal(namedTun.ok, true);
    assert.ok(await waitUntil(async () => {
      const ws = await webSvc.getStatus();
      return ws.cloudflareState?.tunnelMode === 'named' &&
        ws.primaryUrl === `https://ag-e2e.example.com/pc/?token=${sharedToken}`;
    }));

    // 10. Open remote & loopback SSE streams, then kickDevices -> remote SSE closes & old token/cookie 401
    const namedHeaders = { 'cf-ray': 'e2e-ray-named', Host: 'ag-e2e.example.com' };
    const remoteSse = await openSse(`${remoteBase}/pc/api/v1/stream?sessionId=sess-e2e`, {
      ...namedHeaders,
      Cookie: pcCookie
    });
    const localSse = await openSse(`${webLocalBase}/api/v1/stream?sessionId=sess-e2e`, {
      Cookie: localCookie
    });

    const kicked = await remoteSvc.kickDevices();
    assert.equal(kicked.ok, true);
    assert.notEqual(kicked.token, sharedToken);

    assert.ok(await waitUntil(() => remoteSse.isClosed() === true));
    assert.equal(localSse.isClosed(), false);

    // Old token and old remote cookie immediately return 401
    const oldTokenTry = await httpRequest(`${remoteBase}/pc/?token=${sharedToken}`, { headers: namedHeaders });
    assert.equal(oldTokenTry.status, 401);
    const oldCookieTry = await httpRequest(`${remoteBase}/pc/api/v1/web/status`, {
      headers: { ...namedHeaders, Cookie: pcCookie }
    });
    assert.equal(oldCookieTry.status, 401);

    // New shared token immediately succeeds
    const newTokenLogin = await httpRequest(`${remoteBase}/pc/?token=${kicked.token}`, { headers: namedHeaders });
    assert.equal(newTokenLogin.status, 302);
    localSse.close();

    // 11. Unloading remote gracefully degrades web to remote_unavailable + localToken
    await harness.unloadPlugin('agy-daddy.remote');
    assert.ok(await waitUntil(async () => {
      const ws = await webSvc.getStatus();
      return ws.cloudflareState?.mode === 'remote_unavailable' && ws.pairingToken !== kicked.token;
    }));

    await harness.unloadPlugin('agy-daddy.web');
    harness.assertCleanDispose('agy-daddy.remote');
    harness.assertCleanDispose('agy-daddy.web');
  } finally {
    await harness.cleanup();
  }
});
