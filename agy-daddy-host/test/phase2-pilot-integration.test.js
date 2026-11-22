'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { AgyDaddyDaemon } = require('../src/core/daemon');
const { PluginDataStore } = require('../src/core/storage');

const HOST_ROOT = path.resolve(__dirname, '..');
const PROXY_PLUGIN_DIR = path.resolve(HOST_ROOT, '..', 'agy-daddy-plugin-proxy');
const CONTEXT_PLUGIN_DIR = path.resolve(HOST_ROOT, '..', 'agy-daddy-plugin-context');

function sendHttpViaGateway(gatewayPort, targetUrl) {
  const u = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: gatewayPort,
      method: 'GET',
      path: targetUrl,
      headers: { Host: u.host, Connection: 'close' },
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

test('Phase 2 跨仓联调：AgyDaddyDaemon 同时挂载 proxy + context + legacy-suite 掩码协调与热切换', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-phase2-int-'));
  const stateDir = path.join(root, 'state');
  const legacySrcDir = path.join(root, 'legacy-src');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(legacySrcDir, { recursive: true });

  fs.writeFileSync(path.join(legacySrcDir, 'meter-core.js'), '// mock meter-core');
  fs.writeFileSync(path.join(legacySrcDir, 'meter-renderer.js'), '// mock meter-renderer');
  fs.writeFileSync(path.join(legacySrcDir, 'ag-enhancer-overlay.js'), '// mock enhancer');
  fs.writeFileSync(path.join(legacySrcDir, 'pulse-capsule-overlay.js'), '// mock pulse');
  fs.writeFileSync(path.join(legacySrcDir, 'antigravity-hans-overlay.js'), '// mock hans');

  new PluginDataStore('agy-daddy.legacy-suite', { stateDir }).writeJson('settings.json', {
    sourceDir: legacySrcDir,
    disabledModules: []
  });

  // 启动临时目标站点与临时上游 HTTP 代理
  const targetHits = [];
  const upstreamHits = [];
  const targetSockets = new Set();
  const upSockets = new Set();

  const targetSrv = http.createServer((req, res) => {
    targetHits.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ ok: true, targetPath: req.url }));
  });
  targetSrv.on('connection', (s) => { targetSockets.add(s); s.once('close', () => targetSockets.delete(s)); });

  const upstreamSrv = http.createServer((req, res) => {
    upstreamHits.push(req.url);
    const u = new URL(req.url);
    const fwd = http.request({
      hostname: u.hostname,
      port: Number(u.port || 80),
      method: req.method,
      path: `${u.pathname}${u.search}`,
      headers: { Host: u.host, Connection: 'close' },
      agent: false
    }, (tRes) => {
      res.writeHead(tRes.statusCode || 200, tRes.headers);
      tRes.pipe(res);
    });
    fwd.on('error', (err) => { if (!res.headersSent) { res.writeHead(502); res.end(err.message); } });
    req.pipe(fwd);
  });
  upstreamSrv.on('connection', (s) => { upSockets.add(s); s.once('close', () => upSockets.delete(s)); });

  await new Promise((r) => targetSrv.listen(0, '127.0.0.1', r));
  await new Promise((r) => upstreamSrv.listen(0, '127.0.0.1', r));
  const targetPort = targetSrv.address().port;
  const upstreamPort = upstreamSrv.address().port;

  const mockRpcTransport = {
    async getOrigin() { return 'https://127.0.0.1:51410'; },
    async call(method) {
      if (method === 'GetAvailableModels') {
        return { models: { 'gemini-4-hydrogen': { model: 'gemini-4-hydrogen', maxTokens: 1048576 } } };
      }
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'sess-phase2': { lastModifiedTime: '2026-11-21T12:00:00Z', annotations: { title: 'Phase 2 联调会话' } }
          }
        };
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        return {
          generatorMetadata: [
            {
              stepIndices: [0],
              createdAt: '2026-11-21T12:00:00Z',
              chatModel: {
                model: 'gemini-4-hydrogen',
                modelDisplayName: 'Gemini 4 Hydrogen',
                timeToFirstToken: '0.2s',
                streamingDuration: '0.8s',
                usage: { responseId: 'call-p2-1', inputTokens: 1200, cacheReadTokens: 8800, outputTokens: 250 },
                chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 1048576 } }
              }
            }
          ]
        };
      }
      if (method === 'GetCascadeTrajectory') {
        return { steps: [{ userInput: { userResponse: '联调测试输入' } }] };
      }
      return {};
    }
  };

  const daemon = new AgyDaddyDaemon({
    stateDir,
    origin: '*',
    rpcTransport: mockRpcTransport,
    plugins: [
      { id: 'agy-daddy.proxy', trustLevel: 'T0', installPath: PROXY_PLUGIN_DIR, enabled: true },
      { id: 'agy-daddy.context', trustLevel: 'T0', installPath: CONTEXT_PLUGIN_DIR, enabled: true },
      { id: 'agy-daddy.legacy-suite', trustLevel: 'T0', installPath: path.join(HOST_ROOT, 'plugins', 'legacy-suite'), enabled: true }
    ]
  });

  try {
    const started = await daemon.start();
    assert.deepEqual(started.activationErrors, []);

    // 1. 验证宿主启动参数聚合包含 proxy 插件注入的本地转发网关与环境变量
    const proxySvc = daemon.bus.getServiceProxy('proxy');
    const proxyStatus = await proxySvc.getStatus();
    assert.equal(proxyStatus.listening, true);
    const gwPort = proxyStatus.gatewayPort;

    const launchSpec = await daemon.collectHostLaunchSpec('/Applications/Antigravity.app');
    assert.ok(launchSpec.args.includes(`--proxy-server=http://127.0.0.1:${gwPort}`));
    assert.ok(launchSpec.args.includes('--proxy-bypass-list=<-loopback>'));
    assert.equal(launchSpec.env.HTTP_PROXY, `http://127.0.0.1:${gwPort}`);
    assert.equal(launchSpec.env.HTTPS_PROXY, `http://127.0.0.1:${gwPort}`);

    // 2. 验证真实 HTTP 请求经代理网关直连 -> 免重启热切换上游代理
    const directRes = await sendHttpViaGateway(gwPort, `http://127.0.0.1:${targetPort}/p2-direct`);
    assert.equal(directRes.statusCode, 200);
    assert.equal(upstreamHits.length, 0);

    await proxySvc.setConfig({
      mode: 'upstream',
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      noProxy: 'localhost'
    });
    const upRes = await sendHttpViaGateway(gwPort, `http://127.0.0.1:${targetPort}/p2-upstream`);
    assert.equal(upRes.statusCode, 200);
    assert.equal(upstreamHits.length, 1);

    // 3. 验证 context 服务采样、telemetry 事件广播、粘性状态及移动端快照
    const callsEvents = [];
    daemon.bus.onEvent('test', 'telemetry:generator-calls@1', (p) => callsEvents.push(p));

    const ctxSvc = daemon.bus.getServiceProxy('context');
    const snap = await ctxSvc.rescan({ cascadeId: 'sess-phase2' });
    assert.equal(snap.used, 10250);
    assert.equal(snap.budget, 1048576);
    assert.equal(callsEvents.length, 1);
    assert.equal(callsEvents[0].calls[0].callId, 'call-p2-1');
    assert.equal(daemon.bus.getState('state:context.snapshot@1').value.cascadeId, 'sess-phase2');

    const mobileSnap = await ctxSvc.getMobileSnapshot({ cascadeId: 'sess-phase2' });
    assert.equal(mobileSnap.cascadeId, 'sess-phase2');
    assert.equal(mobileSnap.tokPerSec, 250);

    // 4. 验证 legacy-suite 绞杀者掩码自动与已剥离插件协调，杜绝双 UI
    const legacySvc = daemon.bus.getServiceProxy('legacy-suite');
    const rec = await legacySvc.reconcileWithActivePlugins(Array.from(daemon.activePlugins.keys()));
    assert.ok(rec.disabledModules.includes('proxy'));
    assert.ok(rec.disabledModules.includes('pulse'));
    assert.ok(rec.disabledModules.includes('tokens'));

    const bundle = await legacySvc.getBundle();
    assert.equal(bundle.skipped.includes('pulse'), true);
    assert.match(bundle.parts[0].code, /"showTopbarTokens":false/);
  } finally {
    await daemon.stop();
    for (const s of targetSockets) try { s.destroy(); } catch {}
    for (const s of upSockets) try { s.destroy(); } catch {}
    await new Promise((r) => { targetSrv.close(r); try { targetSrv.closeAllConnections?.(); } catch {} });
    await new Promise((r) => { upstreamSrv.close(r); try { upstreamSrv.closeAllConnections?.(); } catch {} });
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
