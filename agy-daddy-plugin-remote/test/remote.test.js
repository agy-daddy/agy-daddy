'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const {
  DEFAULT_CHANNELS,
  DEFAULT_REMOTE_DISPLAY_CONFIG,
  sanitizeRemoteDisplayConfig,
  classifyRequestChannel,
  isChannelAllowed,
  validateCloudflareTunnelToken,
  validateTunnelHostname,
  safeTokenEqual
} = require('../src/tunnel-security');
const { generateQrMatrix, generateQrSvg, generateQrAscii } = require('../src/qr-svg');
const { getCloudflaredInstallHints, parseQuickTunnelUrl, CloudflaredManager } = require('../src/cloudflared');
const { renderRemotePanelHtml } = require('../src/remote-client');

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

test('Cloudflare 校验、9项展示开关、通道分类/403门禁、纯JS QR码 与 cloudflared 管理器', async () => {
  // Base64 connector JSON
  const rawConnector = Buffer.from(JSON.stringify({ a: 'acc_123', t: 'tun_456', s: 'sec_789' }), 'utf8').toString('base64');
  const resConn = validateCloudflareTunnelToken(`cloudflared service install ${rawConnector}`);
  assert.equal(resConn.ok, true);
  assert.equal(resConn.kind, 'connector');
  assert.equal(resConn.tunnelId, 'tun_456');

  // 3-segment JWT
  const b64url = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const jwt = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'tunnel-jwt', a: 'acc', t: 'tun' })}.sigPart123`;
  assert.equal(validateCloudflareTunnelToken(jwt).kind, 'jwt');
  assert.equal(validateCloudflareTunnelToken('not-a-valid-token').ok, false);

  // Hostname validation
  assert.equal(validateTunnelHostname('https://ag.example.com/path').origin, 'https://ag.example.com');
  assert.equal(validateTunnelHostname('http://ag.example.com').ok, false);
  assert.equal(validateTunnelHostname('https://team.cloudflareaccess.com').ok, false);
  assert.equal(validateTunnelHostname('https://dash.cloudflare.com').ok, false);
  assert.equal(validateTunnelHostname('https://random.trycloudflare.com').ok, false);

  // 9 项 remoteDisplay 与默认关闭高暴露通道
  assert.equal(Object.keys(DEFAULT_REMOTE_DISPLAY_CONFIG).length, 9);
  assert.equal(sanitizeRemoteDisplayConfig({ showThinking: false }).showThinking, false);
  assert.deepEqual(DEFAULT_CHANNELS, { loopback: true, lan: false, tailscale: false, bonjour: false, cloudflare: false });
  assert.equal(safeTokenEqual('abc123', 'abc123'), true);
  assert.equal(safeTokenEqual('abc123', 'abc124'), false);

  // 通道识别与 403 判定
  assert.equal(classifyRequestChannel({ headers: { 'cf-ray': '123' }, socket: { remoteAddress: '127.0.0.1' } }), 'cloudflare');
  assert.equal(classifyRequestChannel({ headers: {}, socket: { remoteAddress: '100.80.1.2' } }), 'tailscale');
  assert.equal(classifyRequestChannel({ headers: { host: 'macmini.local:18765' }, socket: { remoteAddress: '192.168.1.9' } }), 'bonjour');
  assert.equal(classifyRequestChannel({ headers: {}, socket: { remoteAddress: '192.168.1.9' } }), 'lan');
  assert.equal(classifyRequestChannel({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), 'loopback');
  assert.equal(isChannelAllowed('cloudflare', DEFAULT_CHANNELS), false);
  assert.equal(isChannelAllowed('loopback', DEFAULT_CHANNELS), true);

  // 纯 JS QR 矩阵与 SVG/ASCII
  const mat = generateQrMatrix('http://127.0.0.1:18765/?t=abcdef0123456789');
  assert.ok(mat.size >= 29);
  const svg = generateQrSvg('http://127.0.0.1:18765/?t=abcdef0123456789');
  assert.match(svg, /^<svg /);
  assert.match(svg, /#a78bfa/);
  const ascii = generateQrAscii('http://127.0.0.1:18765/?t=1');
  assert.ok(ascii.includes('██'));

  // Cloudflared helper + dryRun
  assert.match(getCloudflaredInstallHints().darwin, /cloudflared/);
  assert.equal(parseQuickTunnelUrl('INF |  https://cool-cat-123.trycloudflare.com  |'), 'https://cool-cat-123.trycloudflare.com');
  const cf = new CloudflaredManager();
  const quickRes = await cf.startQuickTunnel(18765, { dryRun: true });
  assert.equal(quickRes.ok, true);
  assert.match(quickRes.publicUrl, /trycloudflare\.com/);
  await cf.stop();

  assert.match(renderRemotePanelHtml({ panels: {} }), /agy-remote-client-summary/);
});

test('插件契约：默认 loopback+只读、CSP 响应头、通道 403、多端隔离去重、QR配对包、Token 轮换、全聚合与零残留 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
  }

  const harness = createMockHostHarness();
  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort });

    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0', inProcessRenderer: true });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    assert.equal(st.running, true);
    assert.equal(st.allowRemoteWrite, false);
    assert.deepEqual(st.channels, { loopback: true, lan: false, tailscale: false, bonjour: false, cloudflare: false });
    assert.ok(st.url.startsWith('http://127.0.0.1:'));

    const token1 = await remoteSvc.getPairingToken();
    const pair = await remoteSvc.getPairingBundle();
    assert.ok(pair.urls.loopback);
    assert.match(pair.qrSvg, /<svg/);

    // HTTP / 与安全响应头 + 1x1 ping GIF
    const home = await httpRequest(`${st.url}/`);
    assert.equal(home.status, 200);
    assert.ok(home.headers['content-security-policy']);
    assert.equal(home.headers['x-content-type-options'], 'nosniff');
    assert.match(home.text, /#a78bfa/);
    assert.match(home.text, /X-AG-Client-Id|agy_remote_client_id/);
    for (const re of forbidden) assert.equal(re.test(home.text), false, `PWA HTML violated theme gate: ${re}`);

    const gif = await httpRequest(`${st.url}/api/ping-gif`);
    assert.equal(gif.status, 200);
    assert.equal(gif.headers['content-type'], 'image/gif');

    // 未勾选通道 403 拦截（如伪造 Cloudflare Header 或 *.local）
    const blockedCf = await httpRequest(`${st.url}/api/snapshot`, {
      headers: { Authorization: `Bearer ${token1}`, 'cf-ray': 'abc' }
    });
    assert.equal(blockedCf.status, 403);
    assert.equal(blockedCf.json.error, 'CHANNEL_DISABLED');

    const blockedBonjour = await httpRequest(`${st.url}/api/snapshot`, {
      headers: { Authorization: `Bearer ${token1}`, Host: 'mymac.local:18765' }
    });
    assert.equal(blockedBonjour.status, 403);

    // 无/错 token 返回 401；多浏览器 clientId 隔离 + 同 deviceHint 跨通道去重
    assert.equal((await httpRequest(`${st.url}/api/snapshot`)).status, 401);
    const snapA = await httpRequest(`${st.url}/api/snapshot`, {
      headers: { Authorization: `Bearer ${token1}`, 'X-AG-Client-Id': 'tab-1', 'X-AG-Device-Hint': 'iphone-1' }
    });
    const snapB = await httpRequest(`${st.url}/api/snapshot`, {
      headers: { Authorization: `Bearer ${token1}`, 'X-AG-Client-Id': 'tab-2', 'X-AG-Device-Hint': 'iphone-1' }
    });
    assert.equal(snapA.status, 200);
    assert.equal(snapA.json.clientId, 'tab-1');
    assert.equal(snapB.json.clientId, 'tab-2');
    const devList = await remoteSvc.getDevices();
    assert.equal(devList.clients.length, 2);
    assert.equal(devList.devices.length, 1);

    // 默认关闭写入时 POST /api/action 返回 403
    const writeBlocked = await httpRequest(`${st.url}/api/action`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
      body: { action: 'pingAction' }
    });
    assert.equal(writeBlocked.status, 403);
    assert.equal(writeBlocked.json.error, 'REMOTE_WRITE_DISABLED');

    // 踢出全部设备 + 轮换 token 立即作废旧令牌
    const kicked = await remoteSvc.kickDevices();
    assert.equal(kicked.ok, true);
    assert.notEqual(kicked.token, token1);
    assert.equal((await remoteSvc.getDevices()).clients.length, 0);
    assert.equal((await httpRequest(`${st.url}/api/snapshot`, { headers: { Authorization: `Bearer ${token1}` } })).status, 401);

    // 可选聚合 context/usage/quota + 注册 action
    harness.bus.provideService('agy-daddy.context', 'context', {
      getMobileSnapshot: () => ({ used: 12000, budget: 1000000, percent: 1.2 })
    }, { realm: 'node' });
    harness.bus.provideService('agy-daddy.usage', 'usage', {
      getMobileSnapshot: () => ({ totalTokens: 12000, totalUsd: 0.04 })
    }, { realm: 'node' });
    harness.bus.provideService('agy-daddy.quota', 'quota', {
      getMobileSnapshot: () => ({ gemini: { percentText: '88%' }, claude: { percentText: '66%' } })
    }, { realm: 'node' });

    const snapFull = await httpRequest(`${st.url}/api/snapshot`, {
      headers: { Authorization: `Bearer ${kicked.token}` }
    });
    assert.equal(snapFull.status, 200);
    assert.equal(snapFull.json.panels.context.available, true);
    assert.equal(snapFull.json.panels.usage.available, true);
    assert.equal(snapFull.json.panels.quota.available, true);

    harness.bus.provideService('agy-daddy.helper', 'helper', {
      echoAction: (payload) => ({ echoed: payload?.msg || '' })
    }, { realm: 'node' });
    await remoteSvc.registerAction({ id: 'echo', service: 'helper', method: 'echoAction' });
    await remoteSvc.setAllowRemoteWrite(true);

    const writeAllowed = await httpRequest(`${st.url}/api/action`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kicked.token}`, 'Content-Type': 'application/json' },
      body: { action: 'echo', payload: { msg: 'hello-mobile' } }
    });
    assert.equal(writeAllowed.status, 200);
    assert.deepEqual(writeAllowed.json.result, { echoed: 'hello-mobile' });

    // dryRun 隧道探测
    const tun = await remoteSvc.startTunnel({ dryRun: true });
    assert.equal(tun.ok, true);
    await remoteSvc.stopTunnel();

    // 卸载零残留校验
    await harness.unloadPlugin('agy-daddy.remote');
    harness.assertCleanDispose('agy-daddy.remote');
  } finally {
    await harness.cleanup();
  }
});
