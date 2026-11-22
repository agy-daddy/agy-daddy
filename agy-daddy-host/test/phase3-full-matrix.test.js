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
const WORKSPACE_ROOT = path.resolve(HOST_ROOT, '..');

const ALL_OFFICIAL_PLUGINS = [
  { id: 'agy-daddy.proxy', dir: path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-proxy') },
  { id: 'agy-daddy.zh-cn', dir: path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-zh-cn') },
  { id: 'agy-daddy.cli', dir: path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-cli') },
  { id: 'agy-daddy.context', dir: path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-context') },
  { id: 'agy-daddy.usage', dir: path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-usage') },
  { id: 'agy-daddy.chat-nav', dir: path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-chat-nav') },
  { id: 'agy-daddy.quota', dir: path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-quota') },
  { id: 'agy-daddy.composer', dir: path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-composer') },
  { id: 'agy-daddy.remote', dir: path.join(WORKSPACE_ROOT, 'agy-daddy-plugin-remote') }
];

const FORBIDDEN_THEME_REGEXES = [
  /#10b981/i,
  /#34d399/i,
  /#059669/i,
  /#38bdf8/i,
  /#7dd3fc/i,
  /#0369a1/i,
  /#0c4a6e/i,
  /#fb923c/i,
  /#c2410c/i
];

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
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

function createMockRpcTransport() {
  const future5h = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
  const futureWeekly = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
  return {
    async getOrigin() { return 'https://127.0.0.1:51410'; },
    async call(method) {
      if (method === 'GetAvailableModels') {
        return {
          models: {
            'gemini-4-hydrogen': { model: 'gemini-4-hydrogen', maxTokens: 1048576 }
          }
        };
      }
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'sess-phase3': {
              lastModifiedTime: '2026-11-21T14:00:00Z',
              annotations: { title: 'Phase 3 全矩阵联调' }
            }
          }
        };
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        return {
          generatorMetadata: [
            {
              stepIndices: [0],
              createdAt: '2026-11-21T14:00:00Z',
              chatModel: {
                model: 'gemini-4-hydrogen',
                modelDisplayName: 'Gemini 4 Hydrogen',
                timeToFirstToken: '0.15s',
                streamingDuration: '0.6s',
                usage: {
                  responseId: 'call-p3-1',
                  inputTokens: 1500,
                  cacheReadTokens: 8500,
                  outputTokens: 300
                },
                chatStartMetadata: {
                  contextWindowMetadata: { maxContextTokens: 1048576 }
                }
              }
            }
          ]
        };
      }
      if (method === 'GetCascadeTrajectory') {
        return {
          steps: [{ userInput: { userResponse: '全矩阵测试请求' } }]
        };
      }
      if (method === 'GetUserStatus') {
        return { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } };
      }
      if (method === 'RetrieveUserQuotaSummary') {
        return {
          groups: [
            {
              groupId: 'shared_gemini_main',
              displayName: 'Gemini Pool',
              buckets: [{ window: '5h', remainingFraction: 0.85, resetTime: future5h }]
            },
            {
              groupId: 'shared_3p_pool',
              displayName: 'Claude Pool',
              buckets: [{ window: 'weekly', remainingFraction: 0.4, resetTime: futureWeekly }]
            }
          ]
        };
      }
      return {};
    }
  };
}

test('Phase 3 Full Matrix: 全 10 仓拓扑启动 + 端到端数据流 + legacy-suite 100% 退场 + 跨仓主题门禁', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-phase3-full-'));
  const stateDir = path.join(root, 'state');
  const legacySrcDir = path.join(root, 'legacy-src');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(legacySrcDir, { recursive: true });

  for (const fname of [
    'meter-core.js',
    'meter-renderer.js',
    'ag-enhancer-overlay.js',
    'pulse-capsule-overlay.js',
    'antigravity-hans-overlay.js'
  ]) {
    fs.writeFileSync(path.join(legacySrcDir, fname), `// mock ${fname}`);
  }

  new PluginDataStore('agy-daddy.legacy-suite', { stateDir }).writeJson('settings.json', {
    sourceDir: legacySrcDir,
    disabledModules: []
  });

  // 故意逆序传入 9 个插件以验证宿主拓扑激活顺序 + 加上 legacy-suite 共 10 仓
  const pluginSpecs = [
    ...ALL_OFFICIAL_PLUGINS.slice().reverse().map((p) => ({
      id: p.id,
      trustLevel: 'T0',
      installPath: p.dir,
      enabled: true
    })),
    {
      id: 'agy-daddy.legacy-suite',
      trustLevel: 'T0',
      installPath: path.join(HOST_ROOT, 'plugins', 'legacy-suite'),
      enabled: true
    }
  ];

  const daemon = new AgyDaddyDaemon({
    stateDir,
    origin: '*',
    rpcTransport: createMockRpcTransport(),
    plugins: pluginSpecs
  });

  try {
    const started = await daemon.start();
    assert.deepEqual(started.activationErrors, []);
    assert.equal(daemon.activePlugins.size, 10);

    // 1. 端到端数据流: context -> telemetry:generator-calls@1 -> usage -> subscription 5x -> quota -> remote HTTP /api/snapshot
    const ctxSvc = daemon.bus.getServiceProxy('context');
    const ctxSnap = await ctxSvc.rescan({ cascadeId: 'sess-phase3' });
    assert.equal(ctxSnap.used, 10300);
    assert.equal(ctxSnap.budget, 1048576);

    const usageSvc = daemon.bus.getServiceProxy('usage');
    const usageSum = await usageSvc.getSummary();
    assert.ok(usageSum.callsCount >= 1);
    assert.equal(usageSum.totalTokens, 10300);

    const subSvc = daemon.bus.getServiceProxy('subscription');
    await subSvc.setCustomPlan({ ultraSubTier: '5x' });

    const quotaSvc = daemon.bus.getServiceProxy('quota');
    const quotaSnap = await quotaSvc.refresh();
    assert.equal(quotaSnap.ultraSubTier, '5x');
    assert.equal(quotaSnap.quotaMultiplier, 5);
    assert.equal(quotaSnap.gemini.percentText, '85%');
    assert.equal(quotaSnap.claude.percentText, '40%');

    const remoteSvc = daemon.bus.getServiceProxy('remote');
    const rStatus = await remoteSvc.getStatus();
    const rToken = await remoteSvc.getPairingToken();
    assert.equal(rStatus.running, true);
    assert.equal(rStatus.allowRemoteWrite, false);

    const snapResp = await httpRequest(`${rStatus.url}/api/snapshot`, {
      headers: { Authorization: `Bearer ${rToken}` }
    });
    assert.equal(snapResp.status, 200);
    assert.equal(snapResp.json.ok, true);
    assert.equal(snapResp.json.panels.context.available, true);
    assert.equal(snapResp.json.panels.context.data.used, 10300);
    assert.equal(snapResp.json.panels.usage.available, true);
    assert.equal(snapResp.json.panels.usage.data.totalTokens, 10300);
    assert.equal(snapResp.json.panels.quota.available, true);
    assert.equal(snapResp.json.panels.quota.data.quotaMultiplier, 5);
    assert.equal(snapResp.json.panels.quota.data.gemini.percentText, '85%');

    // 2. legacy-suite 100% 退场验证
    const all9Ids = ALL_OFFICIAL_PLUGINS.map((p) => p.id);
    const legacySvc = daemon.bus.getServiceProxy('legacy-suite');
    const retired = await legacySvc.isFullyRetired(all9Ids);
    assert.equal(retired.retired, true);
    assert.deepEqual(retired.remainingOverlays, []);
    assert.deepEqual(retired.remainingFeatures, []);

    const rec = await legacySvc.reconcileWithActivePlugins(all9Ids);
    assert.equal(rec.ok, true);

    const bundle = await legacySvc.getBundle();
    for (const key of ['meter', 'enhancer', 'pulse', 'hans']) {
      assert.equal(bundle.skipped.includes(key), true, `legacy overlay ${key} should be skipped`);
    }
    assert.deepEqual(bundle.included, []);
    assert.equal(bundle.parts.every((p) => p.key === 'feature-mask'), true);

    // 3. 跨全 9 仓 src/ 静态紫色主题门禁
    for (const plugin of ALL_OFFICIAL_PLUGINS) {
      const srcDir = path.join(plugin.dir, 'src');
      for (const file of fs.readdirSync(srcDir)) {
        const full = path.join(srcDir, file);
        if (!fs.statSync(full).isFile()) continue;
        const content = fs.readFileSync(full, 'utf8');
        for (const re of FORBIDDEN_THEME_REGEXES) {
          assert.equal(re.test(content), false, `${plugin.id} (${file}) violated purple theme gate: ${re}`);
        }
      }
    }
  } finally {
    await daemon.stop();
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Phase 3 Degradation Matrix: 5 组孤立单插件独立启动、降级可用性与锁清理', async () => {
  async function runIsolatedPlugin(pluginId, fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-phase3-iso-'));
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const spec = ALL_OFFICIAL_PLUGINS.find((p) => p.id === pluginId);
    assert.ok(spec, `Unknown plugin ${pluginId}`);

    const daemon = new AgyDaddyDaemon({
      stateDir,
      origin: '*',
      rpcTransport: createMockRpcTransport(),
      plugins: [{
        id: spec.id,
        trustLevel: 'T0',
        installPath: spec.dir,
        enabled: true
      }]
    });

    try {
      const started = await daemon.start();
      assert.deepEqual(started.activationErrors, [], `${pluginId} failed to activate standalone`);
      await fn({ daemon, started, root, stateDir });
    } finally {
      await daemon.stop();
      assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false, `${pluginId} left stale daemon.lock`);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // Case 1: remote standalone
  await runIsolatedPlugin('agy-daddy.remote', async ({ daemon }) => {
    const remoteSvc = daemon.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    assert.equal(st.running, true);
    const snap = await httpRequest(`${st.url}/api/snapshot`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(snap.status, 200);
    assert.equal(snap.json.panels.context.available, false);
    assert.equal(snap.json.panels.usage.available, false);
    assert.equal(snap.json.panels.quota.available, false);
    const writeBlocked = await httpRequest(`${st.url}/api/action`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: { action: 'ping' }
    });
    assert.equal(writeBlocked.status, 403);
  });

  // Case 2: composer standalone
  await runIsolatedPlugin('agy-daddy.composer', async ({ daemon }) => {
    const composerNode = daemon.bus.getServiceProxy('composer-node');
    const settings = await composerNode.getSettings();
    assert.equal(settings.autoAccept, false);
    assert.equal(settings.autoCompact, false);
    const md = await composerNode.exportMarkdown({
      steps: [{ userInput: { userResponse: '孤立测试输入' } }]
    });
    assert.equal(md.ok, true);
    assert.match(md.markdown, /孤立测试输入/);
  });

  // Case 3: quota standalone
  await runIsolatedPlugin('agy-daddy.quota', async ({ daemon }) => {
    const quotaSvc = daemon.bus.getServiceProxy('quota');
    const snap = await quotaSvc.refresh();
    assert.equal(snap.ultraSubTier, null);
    assert.equal(snap.quotaMultiplier, 1);
    assert.equal(snap.gemini.percentText, '85%');
    assert.equal(snap.claude.percentText, '40%');
  });

  // Case 4: chat-nav standalone
  await runIsolatedPlugin('agy-daddy.chat-nav', async ({ daemon, started, root }) => {
    const tok = daemon.bridge.getPluginToken('agy-daddy.chat-nav');
    assert.ok(tok);
    const sampleFile = path.join(root, 'sample.txt');
    fs.writeFileSync(sampleFile, 'hello-chat-nav');

    const settingsRes = await httpRequest(`http://127.0.0.1:${started.port}/plugins/agy-daddy.chat-nav/settings`, {
      method: 'POST',
      headers: { 'X-AGY-Plugin-Token': tok, 'Content-Type': 'application/json' },
      body: {}
    });
    assert.equal(settingsRes.status, 200);
    assert.equal(settingsRes.json.ok, true);
    assert.equal(settingsRes.json.values.showFloatDock, true);

    const readRes = await httpRequest(`http://127.0.0.1:${started.port}/plugins/agy-daddy.chat-nav/file/read`, {
      method: 'POST',
      headers: { 'X-AGY-Plugin-Token': tok, 'Content-Type': 'application/json' },
      body: { path: sampleFile }
    });
    assert.equal(readRes.status, 200);
    assert.equal(readRes.json.ok, true);
    assert.equal(readRes.json.content, 'hello-chat-nav');
  });

  // Case 5: zh-cn standalone
  await runIsolatedPlugin('agy-daddy.zh-cn', async ({ daemon }) => {
    const zhSvc = daemon.bus.getServiceProxy('zh-cn');
    const cfg = await zhSvc.getConfig();
    assert.equal(cfg.enableRemoteThinkingTranslation, false);
    const blocked = await zhSvc.translateSnippet('Arbitrary unmapped reasoning sentence 98765');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.reason, 'REMOTE_TRANSLATION_DISABLED');
  });
});
