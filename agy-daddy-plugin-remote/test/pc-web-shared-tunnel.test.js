'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const { CloudflaredManager } = require('../src/cloudflared');
const { MobileRemoteServer } = require('../src/pwa-server');

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

async function waitUntil(pred, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

test('CloudflaredManager.stop() clears residual publicUrl and error', async () => {
  const cf = new CloudflaredManager();
  await cf.startQuickTunnel(18765, { dryRun: true, mockUrl: 'https://stale-tunnel.trycloudflare.com' });
  assert.equal(cf.getState().active, true);
  assert.equal(cf.getState().publicUrl, 'https://stale-tunnel.trycloudflare.com');

  await cf.stop();
  const after = cf.getState();
  assert.equal(after.active, false);
  assert.equal(after.publicUrl, '');
  assert.equal(after.error, null);
});

test('MobileRemoteServer /pc reverse proxy: 302 slash canonicalization, header sanitization, SSE streaming & client abort', async () => {
  const receivedHeaders = [];
  let sseUpstreamClosed = false;
  let sseResponse = null;

  const upstream = http.createServer((req, res) => {
    receivedHeaders.push({ url: req.url, method: req.method, headers: req.headers });
    if (req.url === '/api/v1/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.write('event: hello\ndata: {"ok":true}\n\n');
      sseResponse = res;
      res.on('close', () => {
        sseUpstreamClosed = true;
      });
      return;
    }
    if (req.url.startsWith('/api/v1/echo') && req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          url: req.url,
          body: Buffer.concat(chunks).toString('utf8'),
          proxySource: req.headers['x-agy-proxy-source'],
          proxyChannel: req.headers['x-agy-proxy-channel'],
          proxyPrefix: req.headers['x-agy-proxy-prefix'],
          proxySecret: req.headers['x-agy-proxy-secret'],
          spoofed: req.headers['x-agy-proxy-evil'] || null
        }));
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><body>PC-WEB-OK</body></html>');
  });

  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

  let proxyTarget = {
    proxyRunning: true,
    port: upstreamPort,
    channels: { loopback: true, cloudflare: true }
  };

  const remoteServer = new MobileRemoteServer({
    host: '127.0.0.1',
    port: 0,
    getToken: () => 'tok_shared',
    getChannels: () => ({ loopback: true, lan: true, tailscale: false, bonjour: false, cloudflare: true }),
    getTunnelHostname: () => 'https://ag.example.com',
    getProxySecret: () => 'sec_proxy_123',
    getPcWebProxyTarget: () => proxyTarget
  });

  try {
    await remoteServer.start();
    const base = remoteServer.getLocalUrl();

    // 1. Non-cloudflare channel trying to access /pc is rejected with 403
    const nonCf = await httpRequest(`${base}/pc/`);
    assert.equal(nonCf.status, 403);
    assert.equal(nonCf.json.error, 'CHANNEL_DISABLED');

    // 2. /pc without trailing slash redirects to /pc/ preserving query string without hitting upstream
    const beforeCount = receivedHeaders.length;
    const redirectRes = await httpRequest(`${base}/pc?token=tok_shared&session=s1`, {
      headers: { 'cf-ray': 'cf-1', Host: 'ag.example.com' }
    });
    assert.equal(redirectRes.status, 302);
    assert.equal(redirectRes.headers.location, '/pc/?token=tok_shared&session=s1');
    assert.equal(receivedHeaders.length, beforeCount);

    // 3. /pc/ proxies HTML and strips spoofed x-agy-proxy-* headers while injecting trusted headers
    const htmlRes = await httpRequest(`${base}/pc/`, {
      headers: {
        'cf-ray': 'cf-2',
        Host: 'ag.example.com',
        'x-agy-proxy-evil': 'forged',
        'x-agy-proxy-channel': 'loopback'
      }
    });
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.text, '<html><body>PC-WEB-OK</body></html>');

    const postRes = await httpRequest(`${base}/pc/api/v1/echo?x=1`, {
      method: 'POST',
      headers: {
        'cf-ray': 'cf-3',
        Host: 'ag.example.com',
        'Content-Type': 'application/json',
        'x-agy-proxy-evil': 'forged',
        'x-agy-proxy-secret': 'wrong'
      },
      body: { msg: 'hello' }
    });
    assert.equal(postRes.status, 200);
    assert.equal(postRes.json.url, '/api/v1/echo?x=1');
    assert.equal(postRes.json.proxySource, 'agy-daddy-remote');
    assert.equal(postRes.json.proxyChannel, 'cloudflare');
    assert.equal(postRes.json.proxyPrefix, '/pc');
    assert.equal(postRes.json.proxySecret, 'sec_proxy_123');
    assert.equal(postRes.json.spoofed, null);

    // 4. Streaming SSE through /pc/api/v1/stream flushes immediately and destroys upstream on client abort
    await new Promise((resolve, reject) => {
      const sseReq = http.get(`${base}/pc/api/v1/stream`, {
        agent: false,
        headers: { 'cf-ray': 'cf-4', Host: 'ag.example.com' }
      }, (sseRes) => {
        assert.equal(sseRes.statusCode, 200);
        sseRes.once('data', (chunk) => {
          assert.match(chunk.toString('utf8'), /event: hello/);
          sseReq.destroy();
          resolve();
        });
      });
      sseReq.on('error', reject);
    });
    assert.ok(await waitUntil(() => sseUpstreamClosed === true));
    if (sseResponse && !sseResponse.writableEnded) sseResponse.end();

    // 5. Web cloudflare disabled -> 403 CHANNEL_DISABLED
    proxyTarget = { proxyRunning: true, port: upstreamPort, channels: { loopback: true, cloudflare: false } };
    const webDisabledRes = await httpRequest(`${base}/pc/`, {
      headers: { 'cf-ray': 'cf-5', Host: 'ag.example.com' }
    });
    assert.equal(webDisabledRes.status, 403);
    assert.equal(webDisabledRes.json.error, 'CHANNEL_DISABLED');

    // 6. Web not running -> 503 PC_WEB_UNAVAILABLE
    proxyTarget = { proxyRunning: false, port: null, channels: {} };
    const unavailableRes = await httpRequest(`${base}/pc/`, {
      headers: { 'cf-ray': 'cf-6', Host: 'ag.example.com' }
    });
    assert.equal(unavailableRes.status, 503);
    assert.equal(unavailableRes.json.error, 'PC_WEB_UNAVAILABLE');
  } finally {
    await remoteServer.stop();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('Remote plugin: getSharedAuthBundle, authEpoch rotation, Cloudflare-priority pcWeb card & deactivate offline state', async () => {
  const harness = createMockHostHarness();
  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });

    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    const remoteSvc = harness.bus.getServiceProxy('remote');

    // Service must be provided cleanly on startup
    const bundle1 = await remoteSvc.getSharedAuthBundle();
    assert.equal(bundle1.ok, true);
    assert.equal(bundle1.authEpoch, 1);
    assert.ok(typeof bundle1.token === 'string' && bundle1.token.length >= 16);
    assert.ok(typeof bundle1.confirmSecret === 'string' && bundle1.confirmSecret.length >= 16);
    assert.ok(typeof bundle1.proxySecret === 'string' && bundle1.proxySecret.length >= 32);
    assert.equal(bundle1.cloudflareEnabled, false);
    assert.equal(bundle1.tunnelPublicOrigin, '');

    // Enable cloudflare and start dryRun quick tunnel
    await harness.updatePluginSettings('agy-daddy.remote', { cloudflare: true });
    const tun = await remoteSvc.startTunnel({ dryRun: true });
    assert.equal(tun.ok, true);
    const tunOrigin = new URL(tun.publicUrl).origin;

    const bundle2 = await remoteSvc.getSharedAuthBundle();
    assert.equal(bundle2.cloudflareEnabled, true);
    assert.equal(bundle2.tunnelPublicOrigin, tunOrigin);

    // Register mock web-harness service with cloudflare + loopback URLs -> Cloudflare prioritized
    const mockWebStatus = {
      ok: true,
      running: true,
      host: '127.0.0.1',
      port: 18767,
      url: 'http://127.0.0.1:18767',
      pairingUrl: `http://127.0.0.1:18767/?token=${bundle2.token}`,
      primaryChannel: 'cloudflare',
      primaryUrl: `${tunOrigin}/pc/`,
      channels: { loopback: true, cloudflare: true },
      urls: {
        loopback: 'http://127.0.0.1:18767',
        cloudflare: `${tunOrigin}/pc/`
      },
      authUrls: {
        loopback: `http://127.0.0.1:18767/?token=${bundle2.token}`,
        cloudflare: `${tunOrigin}/pc/?token=${bundle2.token}`
      },
      cloudflareState: { mode: 'shared_ready', tunnelMode: 'quick' }
    };
    harness.bus.provideService('agy-daddy.web', 'web-harness', {
      getStatus: () => mockWebStatus
    }, { realm: 'node' });
    harness.bus.setState('agy-daddy.web', 'state:web.status@1', {
      ok: true,
      running: true,
      port: 18767,
      primaryChannel: 'cloudflare',
      primaryUrl: `${tunOrigin}/pc/`
    });

    const shadow = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
    const bodyEl = shadow.querySelector('[data-agy-slot="popover:agy-daddy.remote:remote-panel"]');
    const unitBtn = shadow.querySelector('[data-unit-id="remote"]');
    unitBtn.click();

    assert.ok(await waitUntil(() => bodyEl.querySelector('[data-remote-pcweb-channel="cloudflare"]')?.textContent === 'Cloudflare'));
    assert.equal(
      bodyEl.querySelector('[data-remote-pcweb-url-input="true"]')?.value,
      `${tunOrigin}/pc/?token=${bundle2.token}`
    );
    assert.match(bodyEl.querySelector('[data-remote-pcweb-hint="true"]')?.textContent || '', /共用远程访问隧道/);

    // getStatus().pcWeb must scrub token while getPairingBundle().pcWeb keeps pairingUrl
    const st = await remoteSvc.getStatus();
    assert.equal(st.pcWeb.primaryChannel, 'cloudflare');
    assert.equal(st.pcWeb.url, `${tunOrigin}/pc/`);
    assert.equal('pairingUrl' in st.pcWeb, false);

    const pair = await remoteSvc.getPairingBundle();
    assert.equal(pair.pcWeb.primaryChannel, 'cloudflare');
    assert.equal(pair.pcWeb.pairingUrl, `${tunOrigin}/pc/?token=${bundle2.token}`);

    // rotateToken increments authEpoch
    const rotated = await remoteSvc.rotateToken();
    assert.equal(rotated.ok, true);
    assert.equal(rotated.authEpoch, 2);
    const bundle3 = await remoteSvc.getSharedAuthBundle();
    assert.equal(bundle3.authEpoch, 2);
    assert.notEqual(bundle3.token, bundle2.token);

    // Subscribe to state:remote.status@1 to verify deactivate publishes offline state
    let lastRemoteState = null;
    harness.bus.subscribeState('test.watcher', 'state:remote.status@1', (val) => {
      lastRemoteState = val;
    });
    await harness.unloadPlugin('agy-daddy.remote');
    assert.equal(lastRemoteState?.running, false);
    assert.equal(lastRemoteState?.deactivated, true);
    harness.assertCleanDispose('agy-daddy.remote');
  } finally {
    await harness.cleanup();
  }
});

test('HUB-296: Named Tunnel fallback, Bonjour/LAN/legacy_standalone pcWeb selection, /sync-pc-web-channels, and renderer live refresh/copy', async () => {
  const os = require('node:os');
  const { isLanIp } = require('../src/tunnel-security');
  const harness = createMockHostHarness();
  const copiedTexts = [];
  harness.mockDoc.defaultView = {
    navigator: {
      clipboard: {
        writeText(text) {
          copiedTexts.push(String(text));
          return Promise.resolve();
        }
      }
    }
  };

  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });

    // Load real web + remote plugins
    const webPluginDir = path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-plugin-web');
    const loadedWeb = await harness.loadAndRunPlugin(webPluginDir, { trustLevel: 'T0' });
    const loadedRemote = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    const remoteSvc = harness.bus.getServiceProxy('remote');
    const webSvc = harness.bus.getServiceProxy('web-harness');

    const shadow = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
    const bodyEl = shadow.querySelector('[data-agy-slot="popover:agy-daddy.remote:remote-panel"]');
    shadow.querySelector('[data-unit-id="remote"]').click();

    // Initially both remote & web are loopback-only -> no sync button yet
    assert.ok(await waitUntil(() => bodyEl.querySelector('[data-remote-pcweb-status]')?.getAttribute('data-remote-pcweb-status') === 'running'));
    assert.equal(bodyEl.querySelector('[data-remote-pcweb-channel]')?.getAttribute('data-remote-pcweb-channel'), 'loopback');
    assert.equal(bodyEl.querySelector('[data-remote-pcweb-sync="true"]'), null);
    const initialPcWebVal = bodyEl.querySelector('[data-remote-pcweb-url-input="true"]')?.value || '';
    assert.match(initialPcWebVal, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);

    // Enable bonjour on remote ONLY while web remains loopback-only
    await harness.updatePluginSettings('agy-daddy.remote', { bonjour: true });
    assert.ok(await waitUntil(() => bodyEl.querySelector('[data-remote-pcweb-sync="true"]') !== null));
    assert.ok(bodyEl.querySelector('[data-remote-pcweb-sync-hint="true"]'));

    // Remote HTTP server must NOT expose /sync-pc-web-channels
    const remoteSt1 = await remoteSvc.getStatus();
    const remoteToken = await remoteSvc.getPairingToken();
    const remoteSyncAttempt = await httpRequest(`${remoteSt1.url}/sync-pc-web-channels`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${remoteToken}` },
      body: {}
    });
    assert.equal(remoteSyncAttempt.status, 404);

    // Click "同步远程通道" button in renderer -> invokes bridge /sync-pc-web-channels and updates input + copy immediately
    bodyEl.querySelector('[data-remote-pcweb-sync="true"]').click();
    const expectedBonjourPrefix = `http://${os.hostname().replace(/\.local$/i, '')}.local:`;
    assert.ok(await waitUntil(() => {
      const val = bodyEl.querySelector('[data-remote-pcweb-url-input="true"]')?.value || '';
      return val.startsWith(expectedBonjourPrefix) && bodyEl.querySelector('[data-remote-pcweb-sync="true"]') === null;
    }));
    const syncedInputVal = bodyEl.querySelector('[data-remote-pcweb-url-input="true"]')?.value || '';
    assert.equal(bodyEl.querySelector('[data-remote-pcweb-channel]')?.getAttribute('data-remote-pcweb-channel'), 'bonjour');

    bodyEl.querySelector('[data-remote-pcweb-copy="true"]').click();
    assert.equal(copiedTexts[copiedTexts.length - 1], syncedInputVal);
    assert.equal(syncedInputVal.includes('127.0.0.1'), false);

    // Also verify web-harness status reflects non-loopback pairingUrl
    const webStAfterSync = await webSvc.getStatus();
    assert.equal(webStAfterSync.primaryChannel, 'bonjour');
    assert.equal(webStAfterSync.pairingUrl, syncedInputVal);

    // Verify Named Tunnel mode: when cfState.publicUrl is empty in named mode, getTunnelPublicOrigin falls back to tunnelHostname
    const validNamedPayload = Buffer.from(JSON.stringify({ a: 'acc1', t: 'tun1', s: 'sec1' })).toString('base64');
    await harness.updatePluginSettings('agy-daddy.remote', {
      cloudflare: true,
      tunnelMode: 'named',
      tunnelToken: validNamedPayload,
      tunnelHostname: 'https://named-ag.example.com'
    });
    const namedStart = await remoteSvc.startTunnel({ mode: 'named', dryRun: true });
    assert.equal(namedStart.ok, true);
    const namedBundle = await remoteSvc.getSharedAuthBundle();
    assert.equal(namedBundle.tunnelPublicOrigin, 'https://named-ag.example.com');

    // Verify state:remote.status@1 update triggers refresh and never keeps stale loopback pcWeb cache in renderer
    await harness.updatePluginSettings('agy-daddy.web', { cloudflare: true });
    assert.ok(await waitUntil(() => {
      const val = bodyEl.querySelector('[data-remote-pcweb-url-input="true"]')?.value || '';
      return val.startsWith('https://named-ag.example.com/pc/?token=');
    }));
    bodyEl.querySelector('[data-remote-pcweb-copy="true"]').click();
    assert.match(copiedTexts[copiedTexts.length - 1], /^https:\/\/named-ag\.example\.com\/pc\/\?token=/);

    // Unload web and verify legacy_standalone + LAN selection in remote normalizePcWebInfo via mock web-harness
    await harness.unloadPlugin('agy-daddy.web');
    assert.ok(loadedWeb);
    assert.ok(loadedRemote);

    let mockCustomWeb = {
      ok: true,
      running: true,
      host: '127.0.0.1',
      port: 18767,
      tunnelHostname: 'https://legacy-pc.example.com',
      cloudflareState: { mode: 'legacy_standalone', publicOrigin: 'https://legacy-pc.example.com' },
      channels: { loopback: true, cloudflare: true },
      urls: {
        loopback: 'http://127.0.0.1:18767',
        cloudflare: 'https://legacy-pc.example.com'
      },
      authUrls: {
        loopback: 'http://127.0.0.1:18767/?token=tok_leg',
        cloudflare: 'https://legacy-pc.example.com/?token=tok_leg'
      }
    };
    harness.bus.provideService('agy-daddy.web', 'web-harness', {
      getStatus: () => mockCustomWeb
    }, { realm: 'node' });

    const legacySt = await remoteSvc.getPcWebStatus();
    assert.equal(legacySt.running, true);
    assert.equal(legacySt.primaryChannel, 'cloudflare');
    assert.equal(legacySt.pairingUrl, 'https://legacy-pc.example.com/?token=tok_leg');
    const legacyOpen = await remoteSvc.openPcWeb();
    assert.equal(legacyOpen.ok, true);
    assert.equal(legacyOpen.url, 'https://legacy-pc.example.com/?token=tok_leg');

    // If a local LAN IP exists on this host, verify LAN pcWeb selection works cleanly
    const lanIp = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && !i.internal && i.family === 'IPv4' && isLanIp(i.address))?.address;
    if (lanIp) {
      mockCustomWeb = {
        ok: true,
        running: true,
        host: '0.0.0.0',
        port: 18767,
        channels: { loopback: true, lan: true },
        urls: { loopback: 'http://127.0.0.1:18767', lan: `http://${lanIp}:18767` },
        authUrls: { loopback: 'http://127.0.0.1:18767/?token=tok_lan', lan: `http://${lanIp}:18767/?token=tok_lan` }
      };
      const lanSt = await remoteSvc.getPcWebStatus();
      assert.equal(lanSt.primaryChannel, 'lan');
      assert.equal(lanSt.pairingUrl, `http://${lanIp}:18767/?token=tok_lan`);
    }

    await harness.unloadPlugin('agy-daddy.remote');
    harness.assertCleanDispose('agy-daddy.remote');

    // Verify Tailscale IPv6 & *.ts.net normalization in isAllowedPcWebUrl / normalizePcWebInfo
    const { isAllowedPcWebUrl, normalizePcWebInfo, normalizeIpOrHost } = require('../src/node');
    assert.equal(normalizeIpOrHost('FD7A:115C:A1E0:0:0:0:0:1%utun4'), 'fd7a:115c:a1e0::1');
    const tsAllowCtx = {
      localTailscaleIps: new Set([normalizeIpOrHost('fd7a:115c:a1e0:0:0:0:0:1%utun4')]),
      tailscaleHttpsOrigin: 'https://MY-MAC.TAIL1234.TS.NET'
    };
    assert.equal(
      isAllowedPcWebUrl('http://[fd7a:115c:a1e0::1]:18767/?token=t', tsAllowCtx),
      true
    );
    assert.equal(
      isAllowedPcWebUrl('https://my-mac.tail1234.ts.net:18767/?token=t', tsAllowCtx),
      true
    );
    assert.equal(
      isAllowedPcWebUrl('https://attacker.ts.net/?token=t', tsAllowCtx),
      false
    );
    const tsV6Info = normalizePcWebInfo({
      ok: true,
      running: true,
      host: '0.0.0.0',
      port: 18767,
      channels: { loopback: true, tailscale: true },
      urls: { loopback: 'http://127.0.0.1:18767', tailscale: 'http://[fd7a:115c:a1e0:0:0:0:0:1]:18767' },
      authUrls: { loopback: 'http://127.0.0.1:18767/?token=tok_ts', tailscale: 'http://[fd7a:115c:a1e0:0:0:0:0:1]:18767/?token=tok_ts' }
    }, tsAllowCtx);
    assert.equal(tsV6Info.primaryChannel, 'tailscale');
    assert.equal(tsV6Info.pairingUrl, 'http://[fd7a:115c:a1e0:0:0:0:0:1]:18767/?token=tok_ts');
  } finally {
    await harness.cleanup();
  }
});
