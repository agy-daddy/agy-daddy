'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const { AgyDaddyDaemon } = require('../src/core/daemon');
const { DirectProxyFallbackServer, parseProxyPortFromCommand, hasProxyServerArg } = require('../src/core/proxy-fallback');
const { createLiveWatchdog } = require('../src/core/live-watchdog');
const { createHostRuntime } = require('../src/renderer/host-runtime');
const { createMockDocument } = require('../sdk/mock-harness');
const { loadAnchorsRegistry } = require('../src/core/anchors');
const { readInstalledIndex } = require('../src/core/installer');

const HOST_ROOT = path.resolve(__dirname, '..');
const PROXY_PLUGIN_DIR = path.resolve(HOST_ROOT, '..', 'agy-daddy-plugin-proxy');

async function waitFor(predicate, timeoutMs = 4000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function sendHttpViaProxy(proxyPort, targetUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const req = http.request({
      hostname: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: targetUrl,
      headers: { Host: u.host },
      agent: false
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function sendConnectViaProxy(proxyPort, targetHost, targetPort, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: proxyPort });
    let headerDone = false;
    let buf = Buffer.alloc(0);
    socket.once('connect', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!headerDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx >= 0) {
          headerDone = true;
          const statusLine = buf.slice(0, idx).toString('utf8').split('\r\n')[0];
          if (!statusLine.includes('200')) {
            socket.destroy();
            reject(new Error(`Unexpected CONNECT status: ${statusLine}`));
            return;
          }
          const rest = buf.slice(idx + 4);
          buf = rest;
          socket.write(payload);
        }
      }
      if (headerDone && buf.length >= payload.length) {
        const out = buf.toString('utf8');
        socket.destroy();
        resolve(out);
      }
    });
    socket.on('error', reject);
  });
}

test('DirectProxyFallbackServer 与启动参数解析：直连 HTTP/CONNECT 转发与防回环', async () => {
  assert.equal(hasProxyServerArg('Antigravity --remote-debugging-port=0 --proxy-server=http://127.0.0.1:18766'), true);
  assert.equal(hasProxyServerArg('Antigravity --remote-debugging-port=0'), false);
  assert.equal(parseProxyPortFromCommand('Antigravity --proxy-server=http://127.0.0.1:18766 --foo'), 18766);
  assert.equal(parseProxyPortFromCommand('Antigravity --proxy-server="http://localhost:19001"'), 19001);
  assert.equal(parseProxyPortFromCommand('Antigravity --remote-debugging-port=0'), null);

  const targetSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`direct-ok:${req.url}`);
  });
  await new Promise((r) => targetSrv.listen(0, '127.0.0.1', r));
  const targetPort = targetSrv.address().port;

  const echoSrv = net.createServer((sock) => {
    sock.on('data', (d) => sock.write(d));
  });
  await new Promise((r) => echoSrv.listen(0, '127.0.0.1', r));
  const echoPort = echoSrv.address().port;

  const fallback = new DirectProxyFallbackServer({ host: '127.0.0.1', port: 0 });
  try {
    const st = await fallback.start(0);
    assert.equal(st.listening, true);
    assert.equal(st.mode, 'direct');
    assert.equal(st.forcedDirect, true);

    const httpRes = await sendHttpViaProxy(st.port, `http://127.0.0.1:${targetPort}/ping`);
    assert.equal(httpRes.statusCode, 200);
    assert.equal(httpRes.body, 'direct-ok:/ping');

    const tunnelOut = await sendConnectViaProxy(st.port, '127.0.0.1', echoPort, 'hello-tunnel');
    assert.equal(tunnelOut, 'hello-tunnel');

    const loopRes = await sendHttpViaProxy(st.port, `http://127.0.0.1:${st.port}/self`);
    assert.equal(loopRes.statusCode, 400);
  } finally {
    await fallback.stop();
    await new Promise((r) => { targetSrv.close(r); try { targetSrv.closeAllConnections?.(); } catch {} });
    await new Promise((r) => echoSrv.close(r));
  }
});

test('方案C全链路：首次安装要求重启、停用切换18766直连直到重启且下次不带参数、卸载要求重启', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-scheme-c-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');

  // 真实本地目标服务 & 模拟上游代理服务
  let upstreamHits = 0;
  const targetSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`ok:${req.url}`);
  });
  const upstreamSrv = http.createServer((req, res) => {
    upstreamHits++;
    const u = new URL(req.url);
    const fwd = http.request({
      hostname: u.hostname,
      port: u.port,
      method: req.method,
      path: `${u.pathname}${u.search}`,
      headers: req.headers,
      agent: false
    }, (upRes) => {
      res.writeHead(upRes.statusCode || 200, upRes.headers);
      upRes.pipe(res);
    });
    req.pipe(fwd);
  });

  await new Promise((r) => targetSrv.listen(0, '127.0.0.1', r));
  await new Promise((r) => upstreamSrv.listen(0, '127.0.0.1', r));
  const targetPort = targetSrv.address().port;
  const upstreamPort = upstreamSrv.address().port;

  let mockHostProc = {
    running: true,
    pid: 4242,
    appPath: '/Applications/Antigravity.app',
    version: '2.33.0',
    hasDebugSwitch: true,
    elapsedSec: 120,
    command: '/Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0'
  };
  const relaunchCalls = [];

  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    origin: '*',
    env: {},
    inspectHostProcess: () => ({ ...mockHostProc }),
    relaunchAntigravity: async (opts) => {
      relaunchCalls.push(opts);
      const hasProxyArg = Array.isArray(opts.extraArgs) && opts.extraArgs.some((a) => a.startsWith('--proxy-server='));
      mockHostProc = {
        ...mockHostProc,
        pid: mockHostProc.pid + 1,
        command: `/Applications/Antigravity.app/Contents/MacOS/Antigravity ${opts.extraArgs.join(' ')}`
      };
      return {
        ok: true,
        relaunched: true,
        hasProxyArg,
        args: opts.extraArgs,
        env: opts.proxyEnv
      };
    }
  });

  let uiHost = null;
  try {
    const started = await daemon.start();

    const uiDoc = createMockDocument();
    const uiWin = { location: { href: 'https://127.0.0.1:51410/' } };
    uiHost = createHostRuntime({
      document: uiDoc,
      window: uiWin,
      fetch: globalThis.fetch,
      anchorsRegistry: loadAnchorsRegistry(),
      bridgePort: started.port,
      hostToken: daemon.bridge.hostToken
    });

    uiHost.toggleSettingsPanel(true);
    const shadow = uiDoc.getElementById('agy-daddy-host').shadowRoot;
    await waitFor(() => Boolean(shadow.querySelector('#agy-marketplace-more-btn') || shadow.querySelector('[data-catalog-install="agy-daddy.proxy"]')));

    // 1. 首次从插件市场安装 agy-daddy.proxy（T0）：UI 层要求重启生效，并提示不重启将无法使用
    const moreBtn = shadow.querySelector('#agy-marketplace-more-btn');
    if (moreBtn) {
      moreBtn.click();
      await waitFor(() => Boolean(shadow.querySelector('[data-catalog-install="agy-daddy.proxy"]')));
    }
    const catInstallBtn = shadow.querySelector('[data-catalog-install="agy-daddy.proxy"]');
    assert.ok(catInstallBtn);
    catInstallBtn.click();
    const installUiReady = await waitFor(() => {
      const btn = shadow.querySelector('#agy-host-restart-btn');
      return Boolean(shadow.querySelector('#agy-host-restart-banner'))
        && Boolean(btn && !btn.disabled)
        && Boolean(shadow.querySelector('#agy-manage-toast'));
    });
    assert.equal(installUiReady, true);

    assert.equal(daemon.activePlugins.has('agy-daddy.proxy'), true);
    const installBanner = shadow.querySelector('#agy-host-restart-banner');
    assert.ok(installBanner);
    assert.match(installBanner.textContent, /需要重启 Antigravity 生效/);
    assert.match(installBanner.textContent, /不重启将无法使用/);
    const installToast = shadow.querySelector('#agy-manage-toast');
    assert.match(installToast.textContent, /不重启将无法使用/);

    // 点击「立即重启 Antigravity」-> 验证携带 --proxy-server= 重启且横幅消失
    const restartBtn = shadow.querySelector('#agy-host-restart-btn');
    assert.ok(restartBtn);
    restartBtn.click();
    await waitFor(() => relaunchCalls.length === 1 && !shadow.querySelector('#agy-host-restart-banner'));
    assert.ok(relaunchCalls[0].extraArgs.some((a) => /^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/.test(a)));
    assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(relaunchCalls[0].proxyEnv.HTTP_PROXY));

    // 返回通用插件列表并配置上游代理，验证插件激活期正常走 upstream
    const marketBackBtn = shadow.querySelector('#agy-marketplace-back-btn');
    if (marketBackBtn) {
      marketBackBtn.click();
      await waitFor(() => Boolean(shadow.querySelector('[data-plugin-toggle="agy-daddy.proxy"]')));
    }
    const proxySvc = daemon.bus.getServiceProxy('proxy');
    const gwPort = (await proxySvc.getStatus()).gatewayPort;
    assert.ok(gwPort > 0);
    await daemon.updatePluginSettings('agy-daddy.proxy', {
      mode: 'upstream',
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      noProxy: 'localhost'
    });
    const upRes = await sendHttpViaProxy(gwPort, `http://127.0.0.1:${targetPort}/via-upstream`);
    assert.equal(upRes.statusCode, 200);
    assert.equal(upstreamHits, 1);

    // 3. 停用 agy-daddy.proxy：强制切换为当前网关端口直连直到重启，下次启动不带 --proxy-server=
    const listToggle = shadow.querySelector('[data-plugin-toggle="agy-daddy.proxy"]');
    assert.ok(listToggle);
    listToggle.checked = false;
    listToggle.dispatchEvent({ type: 'change', target: listToggle });
    const disabledUiReady = await waitFor(() => {
      const toggle = shadow.querySelector('[data-plugin-toggle="agy-daddy.proxy"]');
      return !daemon.activePlugins.has('agy-daddy.proxy')
        && daemon.getSessionProxyFallbackStatus().active
        && Boolean(shadow.querySelector('[data-proxy-fallback="true"]'))
        && Boolean(toggle && !toggle.disabled);
    });
    assert.equal(disabledUiReady, true);

    // UI 不应要求强制重启横幅，而应展示直连兜底提示与芯片
    assert.equal(shadow.querySelector('#agy-host-restart-banner'), null);
    assert.ok(shadow.querySelector('[data-proxy-fallback="true"]'));
    assert.match(shadow.querySelector('#agy-manage-toast').textContent, /直连直到重启/);
    assert.equal(readInstalledIndex({ stateDir }).plugins['agy-daddy.proxy'].enabled, false);

    // 验证同一端口依然可通，且强制走直连（不走 upstream，不 ECONNREFUSED）
    const fbStatus = daemon.getSessionProxyFallbackStatus();
    assert.equal(fbStatus.port, gwPort);
    assert.equal(fbStatus.mode, 'direct');
    const fallbackRes = await sendHttpViaProxy(gwPort, `http://127.0.0.1:${targetPort}/via-fallback`);
    assert.equal(fallbackRes.statusCode, 200);
    assert.equal(fallbackRes.body, 'ok:/via-fallback');
    assert.equal(upstreamHits, 1); // 未走上游代理

    // 验证下次启动参数不带 --proxy-server= 与代理 env
    const nextSpec = await daemon.collectHostLaunchSpec('/Applications/Antigravity.app');
    assert.equal(nextSpec.args.some((a) => a.startsWith('--proxy-server=')), false);
    assert.equal(nextSpec.env.HTTP_PROXY, undefined);
    assert.equal(nextSpec.env.HTTPS_PROXY, undefined);

    // 4. 在未重启前重新启用：停止兜底端口并热恢复插件，无需重启
    const reEnableToggle = shadow.querySelector('[data-plugin-toggle="agy-daddy.proxy"]');
    reEnableToggle.checked = true;
    reEnableToggle.dispatchEvent({ type: 'change', target: reEnableToggle });
    const reEnabledUiReady = await waitFor(() => {
      const toggle = shadow.querySelector('[data-plugin-toggle="agy-daddy.proxy"]');
      return daemon.activePlugins.has('agy-daddy.proxy')
        && !daemon.getSessionProxyFallbackStatus().active
        && !shadow.querySelector('[data-proxy-fallback="true"]')
        && Boolean(toggle && toggle.checked && !toggle.disabled);
    });
    assert.equal(reEnabledUiReady, true);
    assert.equal(daemon.getSessionProxyFallbackStatus().active, false);
    assert.equal(shadow.querySelector('#agy-host-restart-banner'), null);

    // 5. 卸载插件：UI 层要求重启生效，并提示不重启将无法使用
    shadow.querySelector('[data-plugin-detail="agy-daddy.proxy"]').click();
    const uninstallBtnReady = await waitFor(() => {
      const unBtn = shadow.querySelector('[data-plugin-uninstall="agy-daddy.proxy"]');
      return Boolean(unBtn && !unBtn.disabled);
    });
    assert.equal(uninstallBtnReady, true);
    shadow.querySelector('[data-plugin-uninstall="agy-daddy.proxy"]').click();
    assert.equal(shadow.querySelector('[data-plugin-uninstall="agy-daddy.proxy"]').textContent, '确认卸载?');
    shadow.querySelector('[data-plugin-uninstall="agy-daddy.proxy"]').click();
    const uninstallUiReady = await waitFor(() => {
      const btn = shadow.querySelector('#agy-host-restart-btn');
      return !daemon.activePlugins.has('agy-daddy.proxy')
        && Boolean(shadow.querySelector('#agy-host-restart-banner'))
        && Boolean(btn && !btn.disabled);
    });
    assert.equal(uninstallUiReady, true);

    assert.equal(daemon.getSessionProxyFallbackStatus().active, false);
    const uninstallBanner = shadow.querySelector('#agy-host-restart-banner');
    assert.ok(uninstallBanner);
    assert.match(uninstallBanner.textContent, /需要重启 Antigravity 生效/);
    assert.match(uninstallBanner.textContent, /不重启将无法使用/);

    // 点击重启后以干净无 --proxy-server= 参数拉起
    shadow.querySelector('#agy-host-restart-btn').click();
    const relaunchedClean = await waitFor(() => relaunchCalls.length === 2 && !shadow.querySelector('#agy-host-restart-banner'));
    assert.equal(relaunchedClean, true);
    assert.equal(relaunchCalls[1].extraArgs.some((a) => a.startsWith('--proxy-server=')), false);
    assert.equal(relaunchCalls[1].proxyEnv.HTTP_PROXY, undefined);
  } finally {
    uiHost?.dispose?.();
    await daemon.stop();
    await new Promise((r) => { targetSrv.close(r); try { targetSrv.closeAllConnections?.(); } catch {} });
    await new Promise((r) => { upstreamSrv.close(r); try { upstreamSrv.closeAllConnections?.(); } catch {} });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Antigravity 退出与守护进程重启恢复：Watchdog 退出清理兜底，重启后仍停用则自动续接直连兜底', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-scheme-c-wd-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');

  // 找一个可用空闲端口模拟固定 18766 端口
  const probeSrv = net.createServer();
  await new Promise((r) => probeSrv.listen(0, '127.0.0.1', r));
  const simPort = probeSrv.address().port;
  await new Promise((r) => probeSrv.close(r));

  let hostRunning = true;
  const mockCmd = `/Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0 --proxy-server=http://127.0.0.1:${simPort}`;

  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    origin: '*',
    inspectHostProcess: () => (hostRunning
      ? { running: true, pid: 8888, appPath: '/Applications/Antigravity.app', version: '2.33.0', hasDebugSwitch: true, elapsedSec: 60, command: mockCmd }
      : { running: false, pid: null, version: '2.33.0', hasDebugSwitch: false, elapsedSec: null, command: '' })
  });

  try {
    await daemon.start();
    // 启动后因为 Antigravity 带着 --proxy-server= 运行而未启用 proxy 插件，daemon 自动启动直连兜底
    assert.equal(daemon.getSessionProxyFallbackStatus().active, true);
    assert.equal(daemon.getSessionProxyFallbackStatus().port, simPort);

    const watchdog = createLiveWatchdog(daemon, {
      silent: true,
      autoRelaunch: false,
      inspectHostProcess: () => (hostRunning
        ? { running: true, pid: 8888, appPath: '/Applications/Antigravity.app', version: '2.33.0', hasDebugSwitch: true, elapsedSec: 60, command: mockCmd }
        : { running: false, pid: null, version: '2.33.0', hasDebugSwitch: false, elapsedSec: null, command: '' }),
      resolveCdpTarget: async () => ({ port: null, targets: [] })
    });

    hostRunning = false;
    await watchdog.tick();
    assert.equal(daemon.getSessionProxyFallbackStatus().active, false);
  } finally {
    await daemon.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
