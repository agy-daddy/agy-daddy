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
  parseTailscaleServeHttpsUrl,
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

async function waitUntil(pred, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
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
  assert.equal(classifyRequestChannel({ headers: { 'x-forwarded-host': 'm4-pro.tailc81e73.ts.net' }, socket: { remoteAddress: '127.0.0.1' } }), 'tailscale');
  assert.equal(classifyRequestChannel({ headers: { 'tailscale-user-login': 'user@example.com' }, socket: { remoteAddress: '127.0.0.1' } }), 'tailscale');
  assert.equal(classifyRequestChannel({ headers: { host: 'macmini.local:18765' }, socket: { remoteAddress: '192.168.1.9' } }), 'bonjour');
  assert.equal(classifyRequestChannel({ headers: {}, socket: { remoteAddress: '192.168.1.9' } }), 'lan');
  assert.equal(classifyRequestChannel({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), 'loopback');
  assert.equal(isChannelAllowed('cloudflare', DEFAULT_CHANNELS), false);
  assert.equal(isChannelAllowed('loopback', DEFAULT_CHANNELS), true);

  // Tailscale Serve HTTPS 解析
  const tsServeSample = {
    Web: {
      'm4-pro.tailc81e73.ts.net:443': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:3005' } }
      },
      'm4-pro.tailc81e73.ts.net:18765': {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:18765' } }
      }
    }
  };
  assert.equal(parseTailscaleServeHttpsUrl(tsServeSample, 3005), 'https://m4-pro.tailc81e73.ts.net');
  assert.equal(parseTailscaleServeHttpsUrl(tsServeSample, 18765), 'https://m4-pro.tailc81e73.ts.net:18765');
  assert.equal(parseTailscaleServeHttpsUrl(tsServeSample, 9999), '');

  // 纯 JS QR 矩阵与 SVG/ASCII
  const mat = generateQrMatrix('http://127.0.0.1:18765/?t=abcdef0123456789');
  assert.ok(mat.size >= 29);
  const svg = generateQrSvg('http://127.0.0.1:18765/?t=abcdef0123456789');
  assert.match(svg, /^<svg /);
  assert.match(svg, /#0a0a0c/);
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

  assert.match(renderRemotePanelHtml({
    panels: {
      context: {
        available: true,
        data: { used: 249000, budget: 512000, percent: 48.6, sessionUsage: { totalTokens: 7960000 }, speed: { tps: 170.7 } }
      }
    }
  }), /249k\/512k \(48\.6%\) · 对话 7\.96M · 170\.7\/s/);
});

test('插件契约：isolated 世界、统一 Popover 包壳与自带样式、托管配置双向同步、命令与零残留 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
  }
  const rendererSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', 'renderer.js'), 'utf8');
  assert.equal(/registerSection/.test(rendererSrc), false, 'Renderer must not use deprecated registerSection');

  const harness = createMockHostHarness();
  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.equal(loaded.manifest.displayName['zh-CN'], '远程访问');
    assert.equal(loaded.manifest.world, 'isolated');
    assert.equal(loaded.trust.world, 'isolated');
    assert.equal(loaded.manifest.permissions.includes('page:main-world'), false);
    assert.equal('migrations' in (loaded.manifest.contributes || {}), false);
    assert.ok(harness.isolatedWorlds.has('agy-daddy.remote'));

    const shadow = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot;

    // 验证通过 ctx.styles.inject 注入了 shadow 专属样式（含 .ag-qr-box）
    const styleEl = shadow.querySelector('style[data-agy-style="agy-daddy.remote"][data-agy-style-id="remote-panel-styles"]');
    assert.ok(styleEl, 'Expected shadow style element for remote-panel-styles');
    assert.match(styleEl.textContent, /\.ag-qr-box/);

    // 顶栏胶囊仅显示手机图标 + 当前优先通道名称（本地）
    const unitBtn = shadow.querySelector('[data-unit-id="remote"]');
    assert.ok(unitBtn);
    assert.equal(unitBtn.textContent.trim(), '本地');

    // 验证统一 Popover 包壳：外层有宿主绘制的标题「远程访问」/⚙/✕，内层仅保留优先通道、只读/可写左右开关、二维码、链接与复制按钮
    const panelEl = shadow.querySelector('[data-agy-popover="agy-daddy.remote:remote-panel"]');
    assert.ok(panelEl);
    assert.equal(panelEl.querySelector('.ag-panel-head .ag-panel-title')?.textContent, '远程访问');
    assert.ok(panelEl.querySelector('.ag-panel-head [data-popover-settings="agy-daddy.remote"]'));
    assert.ok(panelEl.querySelector('.ag-panel-head .ag-popover-close-btn'));
    const bodyEl = panelEl.querySelector('[data-agy-slot="popover:agy-daddy.remote:remote-panel"]');
    assert.ok(bodyEl);
    assert.equal(bodyEl.querySelector('.ag-panel-head'), null, 'Plugin must not duplicate .ag-panel-head inside bodyNode');
    assert.equal(bodyEl.querySelector('[data-remote-primary-channel]')?.textContent, '本地');
    assert.ok(bodyEl.querySelector('[data-remote-write-switch="true"]'));
    assert.ok(bodyEl.querySelector('.ag-qr-box'));
    assert.match(bodyEl.querySelector('.ag-qr-box').innerHTML, /<svg/);
    assert.ok(bodyEl.querySelector('[data-remote-url-input="true"]'));
    assert.ok(bodyEl.querySelector('[data-remote-copy-url="true"]'));
    assert.equal(bodyEl.querySelector('[data-remote-channel]'), null, 'Channel toggles should live in settings, not popover');
    assert.equal(bodyEl.querySelector('[data-remote-rotate-token]'), null, 'Rotate token action should live in settings, not popover');

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
    assert.match(home.text, /--ag-primary-bg/);
    assert.match(home.text, /X-AG-Client-Id|agy_remote_client_id/);
    assert.match(home.text, /id="agy-remote-context-drawer"/);
    assert.match(home.text, /id="agy-remote-context-detail"/);
    assert.match(home.text, /renderContextMobile/);
    assert.match(home.text, /<details class="ctx-help">/);
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

    // Popover 内点击只读/可写左右切换开关，走 ctx.settings.update 双向同步至设置中心与 Node
    const readonlyBtn = bodyEl.querySelector('[data-remote-mode="readonly"]');
    const writableBtn = bodyEl.querySelector('[data-remote-mode="writable"]');
    assert.ok(readonlyBtn && writableBtn);
    assert.equal(readonlyBtn.getAttribute('data-active'), 'true');
    assert.equal(writableBtn.getAttribute('data-active'), 'false');
    writableBtn.click();
    assert.ok(await waitUntil(() => harness.getPluginSettings('agy-daddy.remote').allowRemoteWrite === true));
    assert.equal((await remoteSvc.getStatus()).allowRemoteWrite, true);
    assert.ok(await waitUntil(() => bodyEl.querySelector('[data-remote-mode="writable"]')?.getAttribute('data-active') === 'true'));
    assert.equal(bodyEl.querySelector('[data-remote-mode="readonly"]')?.getAttribute('data-active'), 'false');

    // 从设置中心修改托管配置，实时反映到 Node 与 Popover/胶囊 UI
    await harness.updatePluginSettings('agy-daddy.remote', { allowRemoteWrite: false, bonjour: true });
    assert.equal((await remoteSvc.getStatus()).allowRemoteWrite, false);
    assert.equal((await remoteSvc.getStatus()).channels.bonjour, true);
    assert.ok(await waitUntil(() => bodyEl.querySelector('[data-remote-mode="readonly"]')?.getAttribute('data-active') === 'true'));
    assert.ok(await waitUntil(() => shadow.querySelector('[data-unit-id="remote"]')?.textContent.trim() === '局域网'));
    assert.ok(await waitUntil(() => bodyEl.querySelector('[data-remote-primary-channel]')?.textContent === '局域网'));
    const allowedBonjour = await httpRequest(`${st.url}/api/snapshot`, {
      headers: { Authorization: `Bearer ${token1}`, Host: 'mymac.local:18765' }
    });
    assert.equal(allowedBonjour.status, 200);

    // 校验 settings.schema.json 声明 tunnelToken 为 writeOnly
    const schemaJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'settings.schema.json'), 'utf8'));
    const tokenField = schemaJson.fields.find((f) => f.key === 'tunnelToken');
    assert.equal(tokenField?.writeOnly, true);

    // 设置中心配置 Cloudflare Named 模式（域名 + Token），实时生效并切换优先通道为 Cloudflare，同时渲染端不回显明文 Token
    const namedConnector = Buffer.from(JSON.stringify({ a: 'acc_named', t: 'tun_named', s: 'sec_named' }), 'utf8').toString('base64');
    await harness.updatePluginSettings('agy-daddy.remote', {
      tunnelMode: 'named',
      tunnelHostname: 'https://ag.example.com',
      tunnelToken: `cloudflared service install ${namedConnector}`,
      cloudflare: true
    });
    assert.equal(harness.rendererHost.getPluginSettings('agy-daddy.remote').tunnelToken, '');
    const cfStatus = await remoteSvc.getStatus();
    assert.equal(cfStatus.tunnelMode, 'named');
    assert.equal(cfStatus.tunnelHostname, 'https://ag.example.com');
    assert.equal(cfStatus.hasTunnelToken, true);
    assert.equal(cfStatus.primaryChannel, 'cloudflare');
    const cfPair = await remoteSvc.getPairingBundle();
    assert.equal(cfPair.primaryChannel, 'cloudflare');
    assert.ok(cfPair.primaryUrl.startsWith('https://ag.example.com/?t='));
    assert.ok(await waitUntil(() => shadow.querySelector('[data-unit-id="remote"]')?.textContent.trim() === 'Cloudflare'));
    assert.ok(await waitUntil(() => bodyEl.querySelector('[data-remote-primary-channel]')?.textContent === 'Cloudflare'));
    assert.ok(await waitUntil(() => String(bodyEl.querySelector('[data-remote-url-input="true"]')?.value || '').startsWith('https://ag.example.com/?t=')));

    // 声明式命令执行：remote.rotate-token、remote.status 与 remote.kick-devices
    const rotatedCmd = await harness.executeCommand('remote.rotate-token');
    assert.equal(rotatedCmd.ok, true);
    assert.notEqual(rotatedCmd.token, token1);
    assert.equal((await httpRequest(`${st.url}/api/snapshot`, { headers: { Authorization: `Bearer ${token1}` } })).status, 401);

    const statusCmd = await harness.executeCommand('remote.status');
    assert.equal(statusCmd.running, true);
    assert.equal(statusCmd.channels.bonjour, true);
    assert.match(statusCmd.message, /通道:Cloudflare/);

    const kickedCmd = await harness.executeCommand('remote.kick-devices');
    assert.equal(kickedCmd.ok, true);
    assert.notEqual(kickedCmd.token, rotatedCmd.token);

    const checkCfCmd = await harness.executeCommand('remote.check-cloudflared');
    assert.equal(checkCfCmd.ok, true);
    assert.equal(typeof checkCfCmd.found, 'boolean');
    if (!checkCfCmd.found) {
      assert.ok(Array.isArray(checkCfCmd.commands) && checkCfCmd.commands.length >= 1);
      assert.ok(Array.isArray(checkCfCmd.links) && checkCfCmd.links.length >= 1);
    }

    const cfFieldSchema = schemaJson.fields.find((f) => f.key === 'cloudflare');
    assert.equal(cfFieldSchema?.probe?.command, 'remote.check-cloudflared');
    assert.equal(cfFieldSchema?.probe?.onlyWhenTruthy, true);
    assert.equal(tokenField?.guide?.commands?.[0]?.command, '127.0.0.1:18765');
    assert.equal(tokenField?.guide?.links?.[0]?.url, 'https://one.dash.cloudflare.com/?to=/:account/networks/tunnels');

    // 踢出全部设备 + 轮换 token 立即作废旧令牌
    const kicked = await remoteSvc.kickDevices();
    assert.equal(kicked.ok, true);
    assert.notEqual(kicked.token, kickedCmd.token);
    assert.equal((await remoteSvc.getDevices()).clients.length, 0);

    // Cloudflare Tunnel 开启状态下：隧道入口落地页、安全门禁、/api/channels 与 ?enter=1 直达控制台
    const cfLandingUnauth = await httpRequest(`${st.url}/`, {
      headers: { 'cf-ray': 'cf-landing-unauth' }
    });
    assert.equal(cfLandingUnauth.status, 200);
    assert.match(cfLandingUnauth.text, /id="agy-tunnel-landing"/);
    assert.match(cfLandingUnauth.text, /id="agy-landing-auth-card"/);
    assert.equal(cfLandingUnauth.text.includes(kicked.token), false, 'Unauthenticated landing must not leak pairing token');
    assert.equal(/\.local:\d+/.test(cfLandingUnauth.text), false, 'Unauthenticated landing must not leak .local host');
    for (const re of forbidden) assert.equal(re.test(cfLandingUnauth.text), false, `Landing HTML violated theme gate: ${re}`);

    const cfLandingAuth = await httpRequest(`${st.url}/?t=${kicked.token}`, {
      headers: { 'cf-ray': 'cf-landing-auth', Host: 'ag.example.com' }
    });
    assert.equal(cfLandingAuth.status, 200);
    assert.match(cfLandingAuth.text, /id="agy-tunnel-landing"/);
    assert.match(cfLandingAuth.text, /--ag-bg/);
    assert.match(cfLandingAuth.text, /--ag-primary-bg/);
    assert.match(cfLandingAuth.text, /data-channel-entry="cloudflare"/);
    assert.match(cfLandingAuth.text, /data-channel-entry="bonjour"/);
    assert.equal(/data-channel-entry="loopback"/.test(cfLandingAuth.text), false, 'Remote Cloudflare landing must omit unreachable loopback');
    assert.match(cfLandingAuth.text, /isMixedHttpProbe/);
    assert.match(cfLandingAuth.text, /点击直连/);
    assert.match(cfLandingAuth.text, /id="agy-landing-mixed-hint"/);
    assert.match(cfLandingAuth.text, /id="agy-landing-http-probe-link"/);
    assert.match(cfLandingAuth.text, /enter=1/);
    for (const re of forbidden) assert.equal(re.test(cfLandingAuth.text), false, `Authenticated landing HTML violated theme gate: ${re}`);

    const pingProbe = await httpRequest(`${st.url}/api/ping`);
    assert.equal(pingProbe.status, 200);
    assert.equal(pingProbe.headers['access-control-allow-origin'], '*');
    assert.equal(pingProbe.headers['cross-origin-resource-policy'], 'cross-origin');
    const gifProbe = await httpRequest(`${st.url}/api/ping-gif`);
    assert.equal(gifProbe.status, 200);
    assert.equal(gifProbe.headers['access-control-allow-origin'], '*');
    assert.equal(gifProbe.headers['cross-origin-resource-policy'], 'cross-origin');

    const cfEnterConsole = await httpRequest(`${st.url}/?t=${kicked.token}&enter=1`, {
      headers: { 'cf-ray': 'cf-landing-enter', Host: 'ag.example.com' }
    });
    assert.equal(cfEnterConsole.status, 200);
    assert.match(cfEnterConsole.text, /id="agy-remote-context-drawer"/);
    assert.match(cfEnterConsole.text, /id="agy-switch-channel-btn"/);
    assert.match(cfEnterConsole.text, /agy-speed-probe-btn[\s\S]*\/api\/ping/);
    assert.equal(/id="agy-tunnel-landing"/.test(cfEnterConsole.text), false);

    assert.equal((await httpRequest(`${st.url}/api/channels`)).status, 401);
    const channelsApiCf = await httpRequest(`${st.url}/api/channels`, {
      headers: { Authorization: `Bearer ${kicked.token}`, 'cf-ray': 'cf-ch-api', Host: 'ag.example.com' }
    });
    assert.equal(channelsApiCf.status, 200);
    assert.equal(channelsApiCf.json.ok, true);
    assert.deepEqual(
      channelsApiCf.json.entries.map((e) => e.key),
      ['bonjour', 'cloudflare']
    );
    const bonjourEntryCf = channelsApiCf.json.entries.find((e) => e.key === 'bonjour');
    assert.ok(bonjourEntryCf.probeUrl.endsWith('/api/ping'));
    assert.ok(bonjourEntryCf.httpEntryUrl.includes('/entry?t='));

    const channelsApiLocal = await httpRequest(`${st.url}/api/channels`, {
      headers: { Authorization: `Bearer ${kicked.token}` }
    });
    assert.equal(channelsApiLocal.status, 200);
    assert.deepEqual(
      channelsApiLocal.json.entries.map((e) => e.key),
      ['bonjour', 'cloudflare', 'loopback']
    );
    const cfEntryLocal = channelsApiLocal.json.entries.find((e) => e.key === 'cloudflare');
    assert.equal(cfEntryLocal.probeUrl, 'https://ag.example.com/api/ping');
    assert.ok(cfEntryLocal.enterUrl.startsWith('https://ag.example.com/?t='));

    const explicitEntry = await httpRequest(`${st.url}/entry?t=${kicked.token}`);
    assert.equal(explicitEntry.status, 200);
    assert.match(explicitEntry.text, /id="agy-tunnel-landing"/);

    const directLoopbackHome = await httpRequest(`${st.url}/?t=${kicked.token}`);
    assert.equal(directLoopbackHome.status, 200);
    assert.match(directLoopbackHome.text, /id="agy-remote-context-drawer"/);
    assert.equal(/id="agy-tunnel-landing"/.test(directLoopbackHome.text), false);

    // 确认私有 /set-write 路由已移除
    const removedResp = await fetch(`http://127.0.0.1:${bridgePort}/plugins/agy-daddy.remote/set-write`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AGY-Plugin-Token': loaded.pluginToken
      },
      body: JSON.stringify({ enabled: true })
    });
    assert.equal(removedResp.status, 404);

    // 可选聚合 context/usage/quota + 注册 action
    harness.bus.provideService('agy-daddy.context', 'context', {
      getMobileSnapshot: () => ({
        hasSession: true,
        used: 12000,
        budget: 1000000,
        percent: 1.2,
        cacheCliffRisk: 'none',
        speed: { tps: 200, streamingTps: 240, ttft: 0.4 },
        sessionUsage: { totalTokens: 30600, callsCount: 2 }
      })
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
    assert.equal(snapFull.json.panels.context.data.sessionUsage.totalTokens, 30600);
    assert.equal(snapFull.json.panels.context.data.speed.tps, 200);
    assert.equal(snapFull.json.panels.usage.available, true);
    assert.equal(snapFull.json.panels.quota.available, true);

    harness.bus.provideService('agy-daddy.helper', 'helper', {
      echoAction: (payload) => ({ echoed: payload?.msg || '' })
    }, { realm: 'node' });
    await remoteSvc.registerAction({ id: 'echo', service: 'helper', method: 'echoAction' });
    await remoteSvc.setAllowRemoteWrite(true);
    assert.equal(harness.getPluginSettings('agy-daddy.remote').allowRemoteWrite, true);

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

    // 卸载零残留校验（含 shadow 注入样式自动清除）
    await harness.unloadPlugin('agy-daddy.remote');
    assert.equal(shadow.querySelector('style[data-agy-style="agy-daddy.remote"]'), null);
    harness.assertCleanDispose('agy-daddy.remote');
  } finally {
    await harness.cleanup();
  }
});

test('PC Web 工作台入口卡片：未启动提示、上线同步、安全边界与 /open-pc-web 路由', async () => {
  const harness = createMockHostHarness();
  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.equal(loaded.manifest.consumes?.['web-harness']?.optional, true);

    const shadow = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
    const panelEl = shadow.querySelector('[data-agy-popover="agy-daddy.remote:remote-panel"]');
    const bodyEl = panelEl.querySelector('[data-agy-slot="popover:agy-daddy.remote:remote-panel"]');

    // 1. Offline state (no web-harness service)
    assert.ok(bodyEl.querySelector('[data-remote-pcweb-card="true"]'));
    assert.equal(bodyEl.querySelector('[data-remote-pcweb-status]')?.getAttribute('data-remote-pcweb-status'), 'offline');
    assert.equal(bodyEl.querySelector('[data-remote-pcweb-status]')?.textContent, '未启动');
    assert.ok(bodyEl.querySelector('[data-remote-pcweb-hint="true"]'));
    assert.equal(bodyEl.querySelector('[data-remote-pcweb-open="true"]'), null);

    const offlineOpenResp = await fetch(`http://127.0.0.1:${bridgePort}/plugins/agy-daddy.remote/open-pc-web`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AGY-Plugin-Token': loaded.pluginToken
      },
      body: '{}'
    });
    assert.equal(offlineOpenResp.status, 200);
    const offlineOpenJson = await offlineOpenResp.json();
    assert.equal(offlineOpenJson.ok, false);
    assert.equal(offlineOpenJson.error, 'PC_WEB_UNAVAILABLE');

    // 2. Online state: register mock web-harness service + publish state:web.status@1
    let mockWebStatus = {
      ok: true,
      running: true,
      host: '127.0.0.1',
      port: 18766,
      url: 'http://127.0.0.1:18766',
      pairingUrl: 'http://127.0.0.1:18766/?token=pcweb_secret_tok'
    };
    harness.bus.provideService('agy-daddy.web', 'web-harness', {
      getStatus: () => mockWebStatus
    }, { realm: 'node' });
    harness.bus.setState('agy-daddy.web', 'state:web.status@1', {
      ok: true,
      running: true,
      host: '127.0.0.1',
      port: 18766,
      url: 'http://127.0.0.1:18766'
    });

    // Click topbar unit to open popover (triggers onToggle(true) -> refreshStatus(true))
    const unitBtn = shadow.querySelector('[data-unit-id="remote"]');
    assert.ok(unitBtn);
    unitBtn.click();

    assert.ok(await waitUntil(() => bodyEl.querySelector('[data-remote-pcweb-status]')?.getAttribute('data-remote-pcweb-status') === 'running'));
    assert.equal(bodyEl.querySelector('[data-remote-pcweb-status]')?.textContent, '运行中');
    assert.equal(bodyEl.querySelector('[data-remote-pcweb-url-input="true"]')?.value, 'http://127.0.0.1:18766/?token=pcweb_secret_tok');
    assert.ok(bodyEl.querySelector('[data-remote-pcweb-open="true"]'));
    assert.ok(bodyEl.querySelector('[data-remote-pcweb-copy="true"]'));

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const pcStatusRes = await remoteSvc.getPcWebStatus();
    assert.equal(pcStatusRes.ok, true);
    assert.equal(pcStatusRes.running, true);

    const statusObj = await remoteSvc.getStatus();
    assert.equal(statusObj.pcWeb?.running, true);
    assert.equal(statusObj.pcWeb?.url, 'http://127.0.0.1:18766');
    assert.equal('pairingUrl' in (statusObj.pcWeb || {}), false, 'getStatus().pcWeb must not expose pairingUrl');

    const pairObj = await remoteSvc.getPairingBundle();
    assert.equal(pairObj.pcWeb?.pairingUrl, 'http://127.0.0.1:18766/?token=pcweb_secret_tok');

    const onlineOpenResp = await fetch(`http://127.0.0.1:${bridgePort}/plugins/agy-daddy.remote/open-pc-web`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AGY-Plugin-Token': loaded.pluginToken
      },
      body: '{}'
    });
    assert.equal(onlineOpenResp.status, 200);
    const onlineOpenJson = await onlineOpenResp.json();
    assert.equal(onlineOpenJson.ok, true);
    assert.equal(onlineOpenJson.dryRun, true);
    assert.equal(onlineOpenJson.url, 'http://127.0.0.1:18766/?token=pcweb_secret_tok');

    // Remote HTTP endpoints must never leak PC Web token or pcWeb object
    const mobileToken = await remoteSvc.getPairingToken();
    const remoteSnap = await httpRequest(`${statusObj.url}/api/snapshot`, {
      headers: { Authorization: `Bearer ${mobileToken}` }
    });
    assert.equal(remoteSnap.status, 200);
    assert.equal(remoteSnap.text.includes('pcweb_secret_tok'), false);
    assert.equal('pcWeb' in remoteSnap.json, false);

    const remoteChannels = await httpRequest(`${statusObj.url}/api/channels`, {
      headers: { Authorization: `Bearer ${mobileToken}` }
    });
    assert.equal(remoteChannels.status, 200);
    assert.equal(remoteChannels.text.includes('pcweb_secret_tok'), false);
    assert.equal('pcWeb' in remoteChannels.json, false);

    // 3. Security: reject non-loopback pairingUrl / url
    mockWebStatus = {
      ok: true,
      running: true,
      host: 'evil.example.com',
      port: 443,
      url: 'https://evil.example.com',
      pairingUrl: 'https://evil.example.com/?token=x'
    };
    const rejectedStatus = await remoteSvc.getPcWebStatus();
    assert.equal(rejectedStatus.running, false);
    assert.equal(rejectedStatus.url, '');
    assert.equal(rejectedStatus.pairingUrl, '');
    const rejectedOpen = await remoteSvc.openPcWeb();
    assert.equal(rejectedOpen.ok, false);
    assert.equal(rejectedOpen.error, 'PC_WEB_UNAVAILABLE');

    await harness.unloadPlugin('agy-daddy.remote');
    assert.equal(shadow.querySelector('style[data-agy-style="agy-daddy.remote"]'), null);
    harness.assertCleanDispose('agy-daddy.remote');
  } finally {
    await harness.cleanup();
  }
});

test('remote.browse-allowed-root: schema declares browse on allowedRoots and command returns picked/cancelled state cleanly', async () => {
  const schemaJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'settings.schema.json'), 'utf8'));
  const allowedRootsField = schemaJson.fields.find((f) => f.key === 'allowedRoots');
  assert.equal(allowedRootsField?.type, 'list');
  assert.equal(allowedRootsField?.browse?.command, 'remote.browse-allowed-root');

  const harness = createMockHostHarness();
  const prevDlg = process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT;
  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT = '/Users/demo/Projects/repo-one/';
    const picked = await harness.executeCommand('remote.browse-allowed-root', { values: { allowedRoots: [] } });
    assert.equal(picked.ok, true);
    assert.equal(picked.cancelled, false);
    assert.equal(picked.path, '/Users/demo/Projects/repo-one');

    process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT = '__CANCEL__';
    const cancelled = await harness.executeCommand('remote.browse-allowed-root', {});
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.path, '');

    const listModelsRes = await harness.executeCommand('remote.list-models', {});
    assert.equal(listModelsRes.ok, true);
    assert.ok(Array.isArray(listModelsRes.items) && listModelsRes.items.length >= 1);

    await harness.unloadPlugin('agy-daddy.remote');
    harness.assertCleanDispose('agy-daddy.remote');
  } finally {
    if (prevDlg === undefined) delete process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT;
    else process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT = prevDlg;
    await harness.cleanup();
  }
});
