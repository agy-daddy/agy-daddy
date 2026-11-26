'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const {
  createHostProxy,
  CANONICAL_HOST_LANGUAGES,
  WEB_RELEVANT_PLUGIN_POLICY,
  BUILTIN_ARTIFACT_PREVIEWERS,
  toBcp47Locale,
  toHostLangCode
} = require('../src/host-proxy');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(__dirname, '..', '..', 'agy-daddy-host');
const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

function createMockHost(overrides = {}) {
  const calls = [];
  const host = {
    control: {
      async invoke(routePath, body = {}) {
        calls.push({ kind: 'control', routePath, body });
        if (typeof overrides.onControl === 'function') {
          return overrides.onControl(routePath, body);
        }
        return { ok: true, routePath, body };
      }
    },
    services: {
      async call(serviceName, method, args = [], opts = {}) {
        calls.push({ kind: 'service', serviceName, method, args, opts });
        if (typeof overrides.onService === 'function') {
          return overrides.onService(serviceName, method, args, opts);
        }
        return { ok: false, unavailable: true, value: null };
      }
    },
    state: {
      get(key) {
        calls.push({ kind: 'state', key });
        if (typeof overrides.onStateGet === 'function') {
          return overrides.onStateGet(key);
        }
        return null;
      },
      set(key, value) {
        calls.push({ kind: 'state.set', key, value });
        if (typeof overrides.onStateSet === 'function') {
          return overrides.onStateSet(key, value);
        }
        return { key, value };
      }
    }
  };
  if ('control' in overrides) host.control = overrides.control;
  if ('services' in overrides) host.services = overrides.services;
  if ('state' in overrides) host.state = overrides.state;
  return { host, calls };
}

test('E1: getPlugins, pluginAction, settings (with secretState), runCommand, and getDoctor map cleanly to host.control', async () => {
  const secretState = {
    tunnelToken: { configured: true, writeOnly: true, masked: '****-9a1f' }
  };
  const { host, calls } = createMockHost({
    onControl(routePath, body) {
      if (routePath === '/host/plugins') {
        return {
          ok: true,
          plugins: [{ id: 'agy-daddy.context', enabled: true }],
          catalog: [{ id: 'agy-daddy.remote' }]
        };
      }
      if (routePath === '/host/settings' && body.pluginId === 'agy-daddy.remote') {
        return {
          ok: true,
          values: { tunnelMode: 'named', tunnelToken: '****-9a1f' },
          secretState,
          schema: { fields: [{ key: 'tunnelToken', type: 'string', writeOnly: true }] }
        };
      }
      if (routePath === '/host/settings') {
        return {
          ok: true,
          values: body.action === 'save' ? body.values : { theme: 'dark' }
        };
      }
      if (routePath === '/host/bus/call') {
        if (body.commandId === 'missing.cmd') {
          return { ok: false, unavailable: true, value: null };
        }
        return { ok: true, unavailable: false, value: { ran: body.commandId, args: body.args } };
      }
      if (routePath === '/host/health') {
        return { ok: true, checks: [{ id: 'rpc', ok: true }] };
      }
      return { ok: true, routePath, body };
    }
  });

  const proxy = createHostProxy({ host });

  const pluginsRes = await proxy.getPlugins();
  assert.equal(pluginsRes.ok, true);
  assert.equal(pluginsRes.plugins.length, 1);
  assert.equal(pluginsRes.catalog.length, 1);
  assert.equal(calls.at(-1).routePath, '/host/plugins');

  await proxy.pluginAction('agy-daddy.context', 'enable');
  assert.equal(calls.at(-1).routePath, '/host/plugins/toggle');
  assert.deepEqual(calls.at(-1).body, { pluginId: 'agy-daddy.context', enabled: true });

  await proxy.pluginAction('agy-daddy.context', 'disable');
  assert.equal(calls.at(-1).routePath, '/host/plugins/toggle');
  assert.deepEqual(calls.at(-1).body, { pluginId: 'agy-daddy.context', enabled: false });

  await proxy.pluginAction('agy-daddy.remote', 'install', { spec: 'local:/tmp/p', trustLevel: 'T0' });
  assert.equal(calls.at(-1).routePath, '/host/plugins/install');
  assert.equal(calls.at(-1).body.spec, 'local:/tmp/p');

  await proxy.pluginAction('agy-daddy.remote', 'uninstall');
  assert.equal(calls.at(-1).routePath, '/host/plugins/uninstall');
  assert.equal(calls.at(-1).body.pluginId, 'agy-daddy.remote');

  await proxy.pluginAction('agy-daddy.remote', 'rollback');
  assert.equal(calls.at(-1).routePath, '/host/plugins/rollback');
  assert.equal(calls.at(-1).body.pluginId, 'agy-daddy.remote');

  await assert.rejects(
    () => proxy.pluginAction('agy-daddy.remote', 'destroy'),
    (err) => err.statusCode === 400
  );

  const hostSettings = await proxy.getHostSettings();
  assert.equal(hostSettings.ok, true);
  assert.deepEqual(hostSettings.values, { theme: 'dark' });
  assert.equal(calls.at(-1).routePath, '/host/settings');

  const updatedHostSettings = await proxy.setHostSettings({ theme: 'midnight' });
  assert.equal(updatedHostSettings.ok, true);
  assert.equal(calls.at(-1).routePath, '/host/settings');
  assert.equal(calls.at(-1).body.action, 'save');

  const pluginSettings = await proxy.getPluginSettings('agy-daddy.remote');
  assert.equal(pluginSettings.ok, true);
  assert.deepEqual(pluginSettings.secretState, secretState);
  assert.equal(pluginSettings.values.tunnelToken, '****-9a1f');

  const savedPluginSettings = await proxy.setPluginSettings('agy-daddy.remote', { tunnelMode: 'quick' });
  assert.equal(savedPluginSettings.ok, true);
  assert.deepEqual(savedPluginSettings.secretState, secretState);
  assert.equal(savedPluginSettings.values.tunnelToken, '****-9a1f');
  assert.equal(calls.at(-1).routePath, '/host/settings');
  assert.equal(calls.at(-1).body.pluginId, 'agy-daddy.remote');
  assert.equal(calls.at(-1).body.action, 'save');

  const cmdRes = await proxy.runCommand('agy-daddy.context.rescan', { args: ['fast'], pluginId: 'agy-daddy.context' });
  assert.equal(cmdRes.ok, true);
  assert.equal(calls.at(-1).routePath, '/host/bus/call');
  assert.deepEqual(cmdRes.result, { ran: 'agy-daddy.context.rescan', args: ['agy-daddy.context.rescan', 'fast'] });

  const missingCmdRes = await proxy.runCommand('missing.cmd');
  assert.equal(missingCmdRes.ok, false);
  assert.equal(missingCmdRes.statusCode, 404);

  const doctorRes = await proxy.getDoctor();
  assert.equal(doctorRes.ok, true);
  assert.equal(calls.at(-1).routePath, '/host/health');
});

test('E1: getPlugins cleanly fails with 503 when host.control is unavailable', async () => {
  const { host } = createMockHost({ control: undefined });
  const proxy = createHostProxy({ host });

  await assert.rejects(
    () => proxy.getPlugins(),
    (err) => err.statusCode === 503
  );
});

test('E2: getTopbar soft-aggregates context/usage/quota with state fallback and missing degradation', async () => {
  const { host } = createMockHost({
    onService(serviceName) {
      if (serviceName === 'context') {
        return { ok: true, unavailable: false, value: { usedTokens: 12000, maxTokens: 200000 } };
      }
      if (serviceName === 'quota') {
        throw new Error('SERVICE_METHOD_NOT_FOUND: quota.getSnapshot');
      }
      return { ok: false, unavailable: true, value: null };
    },
    onStateGet(key) {
      if (key === 'state:quota.status@1') {
        return { key, value: { remainingPercent: 84 }, version: 3 };
      }
      return null;
    }
  });

  const proxy = createHostProxy({ host });
  const topbar = await proxy.getTopbar();

  assert.equal(topbar.ok, true);
  assert.equal(topbar.panels.context.available, true);
  assert.deepEqual(topbar.panels.context.data, { usedTokens: 12000, maxTokens: 200000 });
  assert.equal(topbar.panels.usage.available, false);
  assert.equal(topbar.panels.quota.available, true);
  assert.deepEqual(topbar.panels.quota.data, { remainingPercent: 84 });
});

test('E2: getTopbar falls back to snapshot@1 state and never throws when all panels missing', async () => {
  const { host } = createMockHost({
    onService() {
      return { ok: false, unavailable: true, value: null };
    },
    onStateGet(key) {
      if (key === 'state:usage.snapshot@1') {
        return { key, value: { todayTokens: 5500 }, version: 1 };
      }
      return null;
    }
  });

  const proxy = createHostProxy({ host });
  const topbar = await proxy.getTopbar();

  assert.equal(topbar.ok, true);
  assert.equal(topbar.panels.context.available, false);
  assert.equal(topbar.panels.usage.available, true);
  assert.deepEqual(topbar.panels.usage.data, { todayTokens: 5500 });
  assert.equal(topbar.panels.quota.available, false);
});

function httpJsonRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method: options.method || 'GET',
      headers: options.headers || {}
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
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

function waitForSseEvent(urlStr, headers, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    let settled = false;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers
    }, (res) => {
      let buf = '';
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          req.destroy();
          reject(new Error('Timed out waiting for SSE event from host.events.onAny'));
        }
      }, timeoutMs);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = block.split('\n').filter((l) => l && !l.startsWith(':'));
          if (lines.length === 0) continue;
          const ev = { id: null, event: 'message', data: '' };
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith('id:')) ev.id = line.slice(3).trim();
            else if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          ev.data = dataLines.join('\n');
          try { ev.json = JSON.parse(ev.data); } catch {}
          if (predicate(ev) && !settled) {
            settled = true;
            clearTimeout(timer);
            req.destroy();
            res.destroy();
            resolve(ev);
            return;
          }
        }
      });
      resolve._ready?.();
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    req.end();
  });
}

test('E3: full plugin activate/service/command/SSE/dispose lifecycle via mock-harness', async () => {
  const harness = createMockHostHarness({
    onRpc(method, body) {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'cid-e3': {
              summary: 'E3 Harness Session',
              status: 'CASCADE_RUN_STATUS_IDLE',
              stepCount: 2,
              lastModifiedTime: '2026-11-24T01:00:00Z',
              createdTime: '2026-11-24T00:50:00Z',
              workspaces: [{ workspaceFolderAbsoluteUri: 'file:///tmp/ws-e3', branchName: 'main' }]
            }
          }
        };
      }
      if (method === 'GetCascadeTrajectorySteps') {
        return { steps: [], numTotalSteps: 0, status: 'CASCADE_RUN_STATUS_IDLE' };
      }
      return { ok: true, method, body };
    }
  });

  try {
    await harness.loadAndRunPlugin(PLUGIN_DIR);

    // 1. Verify web-harness shared service is registered and works
    assert.equal(harness.bus.hasService('web-harness'), true);
    const listSvcRes = await harness.bus.callService('web-harness', 'listSessions', [{ limit: 10 }], { callerRealm: 'node' });
    assert.equal(listSvcRes.ok, true);
    assert.equal(listSvcRes.value.ok, true);
    assert.equal(listSvcRes.value.sessions[0].cascadeId, 'cid-e3');

    const statusSvcRes = await harness.bus.callService('web-harness', 'getStatus', [], { callerRealm: 'node' });
    assert.equal(statusSvcRes.ok, true);
    const status = statusSvcRes.value;
    assert.equal(status.ok, true);
    assert.equal(status.running, true);
    assert.equal(status.host, '127.0.0.1');
    assert.ok(Number.isInteger(status.port) && status.port > 0);
    assert.ok(typeof status.pairingToken === 'string' && status.pairingToken.length >= 16);

    const stateEntry = harness.bus.getState('state:web.status@1');
    assert.equal(stateEntry.value.running, true);
    assert.equal(stateEntry.value.port, status.port);

    // 2. Verify HTTP gateway responds with Bearer auth and runs agy-daddy.web.status command
    const baseUrl = `http://127.0.0.1:${status.port}`;
    const authHeaders = { Authorization: `Bearer ${status.pairingToken}`, 'Content-Type': 'application/json' };

    const healthRes = await httpJsonRequest(`${baseUrl}/api/v1/health`, { headers: authHeaders });
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.json.ok, true);
    assert.equal(healthRes.json.rpcConnected, true);

    const cmdRes = await httpJsonRequest(`${baseUrl}/api/v1/host/commands/agy-daddy.web.status`, {
      method: 'POST',
      headers: authHeaders,
      body: { args: [] }
    });
    assert.equal(cmdRes.status, 200);
    assert.equal(cmdRes.json.ok, true);
    assert.equal(cmdRes.json.result.port, status.port);

    // 3. Verify host.events.onAny forwards bus state updates over SSE
    const ssePromise = waitForSseEvent(
      `${baseUrl}/api/v1/stream`,
      authHeaders,
      (ev) => ev.event === 'state.patch' && ev.json?.key === 'state:context.snapshot@1'
    );
    await new Promise((r) => setTimeout(r, 40));
    harness.bus.setState('agy-daddy.context', 'state:context.snapshot@1', { usedTokens: 420 });
    const sseEv = await ssePromise;
    assert.equal(sseEv.json.value.usedTokens, 420);

    // 4. Unload plugin and verify zero leaks & closed HTTP port
    await harness.unloadPlugin('agy-daddy.web');
    harness.assertCleanDispose('agy-daddy.web');
    assert.equal(harness.bus.hasService('web-harness'), false);

    await assert.rejects(
      () => httpJsonRequest(`${baseUrl}/api/v1/health`, { headers: authHeaders }),
      (err) => err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')
    );
  } finally {
    await harness.cleanup();
  }
});

test('E4: composer bridge soft-degrades cleanly when composer-node service is absent', async () => {
  const { host } = createMockHost({});
  const proxy = createHostProxy({ host });

  const state = await proxy.getComposerState();
  assert.equal(state.ok, true);
  assert.equal(state.available, false);
  assert.equal(state.settings.showQuickBar, true);
  assert.ok(Array.isArray(state.builtins) && state.builtins.length >= 6);

  const opt = await proxy.optimizePrompt('Fix login race condition');
  assert.equal(opt.ok, true);
  assert.ok(opt.optimized.includes('Fix login race condition'));

  const exp = await proxy.exportSessionMarkdown({
    title: 'Demo Session',
    events: [{ seq: 0, kind: 'user', payload: { text: 'hi' } }]
  });
  assert.equal(exp.ok, true);
  assert.ok(exp.markdown.includes('# Demo Session'));
  assert.ok(exp.markdown.includes('Step #0'));
});

test('E5: consecutive partial setPluginSettings calls preserve existing settings and strip masked secret placeholders', async () => {
  let stored = {
    port: 18778,
    allowedRoots: ['/repo'],
    colorTheme: 'monochrome',
    drawerSpeed: 'normal',
    theme: 'system',
    tunnelToken: '****-9a1f'
  };
  const secretState = {
    tunnelToken: { configured: true, writeOnly: true, masked: '****-9a1f' }
  };
  const { host } = createMockHost({
    onControl(routePath, body) {
      assert.equal(routePath, '/host/settings');
      if (body.action === 'get') {
        return { ok: true, values: { ...stored }, secretState };
      }
      if (body.action === 'save') {
        assert.equal('tunnelToken' in body.values, false);
        stored = { ...body.values };
        return { ok: true, values: { ...stored } };
      }
      return { ok: false };
    }
  });

  const proxy = createHostProxy({ host });
  await proxy.setPluginSettings('agy-daddy.web', { drawerSpeed: 'smooth' });
  const afterSecond = await proxy.setPluginSettings('agy-daddy.web', { theme: 'light' });

  assert.equal(afterSecond.ok, true);
  assert.equal(afterSecond.values.port, 18778);
  assert.deepEqual(afterSecond.values.allowedRoots, ['/repo']);
  assert.equal(afterSecond.values.drawerSpeed, 'smooth');
  assert.equal(afterSecond.values.theme, 'light');
});

test('Module 2: CANONICAL_HOST_LANGUAGES, toBcp47Locale, and toHostLangCode cover all 10 languages', () => {
  assert.equal(CANONICAL_HOST_LANGUAGES.length, 10);
  const expected = [
    ['zh', 'zh-CN', '简体中文', '简中'],
    ['zh-TW', 'zh-TW', '繁體中文', '繁中'],
    ['ja', 'ja', '日本語', '日本語'],
    ['ko', 'ko', '한국어', '한국어'],
    ['es', 'es', 'Español', 'ES'],
    ['pt', 'pt', 'Português', 'PT'],
    ['fr', 'fr', 'Français', 'FR'],
    ['ru', 'ru', 'Русский', 'RU'],
    ['it', 'it', 'Italiano', 'IT'],
    ['en', 'en', 'English', 'EN']
  ];

  for (let i = 0; i < expected.length; i += 1) {
    const [code, bcp47, nativeName, shortLabel] = expected[i];
    assert.deepEqual(CANONICAL_HOST_LANGUAGES[i], { code, bcp47, nativeName, shortLabel });
    assert.equal(toBcp47Locale(code), bcp47);
    assert.equal(toBcp47Locale(bcp47), bcp47);
    assert.equal(toHostLangCode(bcp47), code);
    assert.equal(toHostLangCode(code), code);
  }

  assert.equal(toBcp47Locale('zh_CN'), 'zh-CN');
  assert.equal(toHostLangCode('zh-cn'), 'zh');
  assert.equal(toBcp47Locale('zh_TW'), 'zh-TW');
  assert.equal(toHostLangCode('zh-HK'), 'zh-TW');
  assert.equal(toBcp47Locale('en-US'), 'en');
  assert.equal(toHostLangCode('pt-BR'), 'pt');
  assert.equal(toBcp47Locale('unknown'), 'en');
  assert.equal(toHostLangCode(null), 'en');
});

test('Module 2: getHostLocale follows precedence chain (host.locale@1 > zh-cn.lang@1 > zh-cn.getConfig > en) and supportedLanguages fallback', async () => {
  // 1. state:host.locale@1 takes precedence
  {
    const { host } = createMockHost({
      onStateGet(key) {
        if (key === 'state:host.locale@1') return { key, value: { bcp47: 'ja', lang: 'ja' } };
        if (key === 'state:zh-cn.lang@1') return { key, value: { lang: 'zh' } };
        return null;
      },
      onService(svc, method) {
        if (svc === 'zh-cn' && method === 'getConfig') return { ok: true, value: { lang: 'fr' } };
        return { ok: false, unavailable: true, value: null };
      }
    });
    const proxy = createHostProxy({ host });
    const res = await proxy.getHostLocale();
    assert.equal(res.ok, true);
    assert.equal(res.locale, 'ja');
    assert.equal(res.hostLang, 'ja');
    assert.equal(res.source, 'state:host.locale@1');
    assert.equal(res.supportedLanguages.length, 10);
  }

  // 2. state:zh-cn.lang@1 falls back when host.locale@1 absent
  {
    const { host } = createMockHost({
      onStateGet(key) {
        if (key === 'state:zh-cn.lang@1') return { key, value: { lang: 'zh' } };
        return null;
      },
      onService(svc, method) {
        if (svc === 'zh-cn' && method === 'getConfig') return { ok: true, value: { lang: 'es' } };
        return { ok: false, unavailable: true, value: null };
      }
    });
    const proxy = createHostProxy({ host });
    const res = await proxy.getHostLocale();
    assert.equal(res.locale, 'zh-CN');
    assert.equal(res.hostLang, 'zh');
    assert.equal(res.source, 'state:zh-cn.lang@1');
  }

  // 3. zh-cn.getConfig & getSupportedLanguages used when state absent
  {
    const customSupported = [
      { code: 'zh-TW', bcp47: 'zh-TW', nativeName: '繁體中文', shortLabel: '繁中' },
      { code: 'en', bcp47: 'en', nativeName: 'English', shortLabel: 'EN' }
    ];
    const { host } = createMockHost({
      onService(svc, method) {
        if (svc === 'zh-cn' && method === 'getConfig') return { ok: true, value: { lang: 'zh-TW' } };
        if (svc === 'zh-cn' && method === 'getSupportedLanguages') return { ok: true, value: customSupported };
        return { ok: false, unavailable: true, value: null };
      }
    });
    const proxy = createHostProxy({ host });
    const res = await proxy.getHostLocale();
    assert.equal(res.locale, 'zh-TW');
    assert.equal(res.hostLang, 'zh-TW');
    assert.equal(res.source, 'service:zh-cn');
    assert.deepEqual(res.supportedLanguages, customSupported);
  }

  // 4. Default 'en' fallback when state and service are absent
  {
    const { host } = createMockHost({});
    const proxy = createHostProxy({ host });
    const res = await proxy.getHostLocale();
    assert.equal(res.ok, true);
    assert.equal(res.locale, 'en');
    assert.equal(res.hostLang, 'en');
    assert.equal(res.source, 'default');
    assert.equal(res.supportedLanguages.length, 10);
  }
});

test('Module 2: setHostLocale syncs all 10 languages via zh-cn.setLang + state:host.locale@1 and falls back to settings when service unavailable', async () => {
  // Path A: zh-cn service available for all 10 languages
  const stateStore = new Map();
  const setLangCalls = [];
  {
    const { host } = createMockHost({
      onService(svc, method, args) {
        if (svc === 'zh-cn' && method === 'setLang') {
          setLangCalls.push(args[0]);
          return { ok: true, value: { lang: args[0] } };
        }
        return { ok: false, unavailable: true, value: null };
      },
      onStateGet(key) {
        return stateStore.has(key) ? { key, value: stateStore.get(key) } : null;
      },
      onStateSet(key, value) {
        stateStore.set(key, value);
      }
    });
    const proxy = createHostProxy({ host });

    for (const langEntry of CANONICAL_HOST_LANGUAGES) {
      const setRes = await proxy.setHostLocale(langEntry.bcp47);
      assert.equal(setRes.ok, true);
      assert.equal(setRes.locale, langEntry.bcp47);
      assert.equal(setRes.hostLang, langEntry.code);
      assert.equal(setRes.supportedLanguages.length, 10);

      const getRes = await proxy.getHostLocale();
      assert.equal(getRes.locale, langEntry.bcp47);
      assert.equal(getRes.hostLang, langEntry.code);
      assert.equal(getRes.source, 'state:host.locale@1');
    }

    assert.deepEqual(
      setLangCalls,
      CANONICAL_HOST_LANGUAGES.map((entry) => entry.code)
    );
  }

  // Path B: zh-cn service unavailable -> falls back to setPluginSettings('agy-daddy.zh-cn', { lang }) preserving desktop fields
  {
    let zhCnStored = {
      lang: 'zh',
      brandTitle: 'translated',
      englishLabels: false,
      enableRemoteThinkingTranslation: true
    };
    let hostLocaleState = null;
    const { host, calls } = createMockHost({
      onService() {
        return { ok: false, unavailable: true, value: null };
      },
      onControl(routePath, body) {
        assert.equal(routePath, '/host/settings');
        assert.equal(body.pluginId, 'agy-daddy.zh-cn');
        if (body.action === 'get') {
          return { ok: true, values: { ...zhCnStored } };
        }
        if (body.action === 'save') {
          zhCnStored = { ...body.values };
          return { ok: true, values: { ...zhCnStored } };
        }
        return { ok: false };
      },
      onStateSet(key, value) {
        if (key === 'state:host.locale@1') hostLocaleState = value;
      }
    });
    const proxy = createHostProxy({ host });
    const res = await proxy.setHostLocale('zh-TW');
    assert.equal(res.ok, true);
    assert.equal(res.locale, 'zh-TW');
    assert.equal(res.hostLang, 'zh-TW');
    assert.equal(zhCnStored.lang, 'zh-TW');
    assert.equal(zhCnStored.brandTitle, 'translated');
    assert.equal(zhCnStored.enableRemoteThinkingTranslation, true);
    assert.deepEqual(hostLocaleState, { bcp47: 'zh-TW', locale: 'zh-TW', lang: 'zh-TW' });
    assert.ok(calls.some((c) => c.kind === 'control' && c.routePath === '/host/settings' && c.body.action === 'save'));

    await assert.rejects(() => proxy.setHostLocale(''), (err) => err.statusCode === 400);
  }
});

test('Module 5: getPlugins annotates web relevance and filters cleanly when scope=web', async () => {
  assert.equal(WEB_RELEVANT_PLUGIN_POLICY['agy-daddy.web'].mode, 'all');
  assert.equal(WEB_RELEVANT_PLUGIN_POLICY['agy-daddy.zh-cn'].mode, 'fields');

  const rawPlugins = [
    { id: 'agy-daddy.web', enabled: true, active: true },
    { id: 'agy-daddy.zh-cn', enabled: true, active: true },
    { id: 'agy-daddy.theme', enabled: true, active: true },
    { id: 'agy-daddy.antigravity-tweaks', enabled: false, active: false },
    { id: 'agy-daddy.custom-web', enabled: true, active: true, surfaces: ['desktop', 'web'] },
    { id: 'agy-daddy.context', enabled: true, active: true, surfaces: ['desktop'] }
  ];
  const rawCatalog = [
    { id: 'agy-daddy.quota' },
    { id: 'agy-daddy.desktop-only-cat' },
    { id: 'agy-daddy.web-cat', surfaces: ['web'] }
  ];

  const { host } = createMockHost({
    onControl(routePath) {
      if (routePath === '/host/plugins') {
        return { ok: true, plugins: rawPlugins, catalog: rawCatalog };
      }
      return { ok: true };
    }
  });
  const proxy = createHostProxy({ host });

  // Default / scope='all' preserves all plugins and adds annotations
  const allRes = await proxy.getPlugins();
  assert.equal(allRes.plugins.length, 6);
  assert.equal(allRes.catalog.length, 3);
  assert.equal(allRes.scope, undefined);
  assert.equal(allRes.plugins.find((p) => p.id === 'agy-daddy.web').webRelevant, true);
  assert.equal(allRes.plugins.find((p) => p.id === 'agy-daddy.web').webVisibleFields, '*');
  assert.deepEqual(
    allRes.plugins.find((p) => p.id === 'agy-daddy.zh-cn').webVisibleFields,
    ['lang', 'englishLabels']
  );
  assert.equal(allRes.plugins.find((p) => p.id === 'agy-daddy.theme').webRelevant, false);
  assert.equal(allRes.plugins.find((p) => p.id === 'agy-daddy.custom-web').webRelevant, true);
  assert.equal(allRes.plugins.find((p) => p.id === 'agy-daddy.context').webRelevant, false);

  // scope='web' filters out desktop-only items and reports counts
  const webRes = await proxy.getPlugins({ scope: 'web' });
  assert.equal(webRes.scope, 'web');
  assert.equal(webRes.allPluginsCount, 6);
  assert.equal(webRes.hiddenDesktopCount, 3);
  assert.deepEqual(
    webRes.plugins.map((p) => p.id),
    ['agy-daddy.web', 'agy-daddy.zh-cn', 'agy-daddy.custom-web']
  );
  assert.deepEqual(
    webRes.catalog.map((c) => c.id),
    ['agy-daddy.quota', 'agy-daddy.web-cat']
  );
});

test('Module 5: getPluginSettings(agy-daddy.zh-cn, { scope: "web" }) filters desktop fields and setPluginSettings preserves them', async () => {
  const zhCnSchema = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'agy-daddy-plugin-zh-cn', 'settings.schema.json'), 'utf8')
  );
  let stored = {
    lang: 'zh',
    brandTitle: 'translated',
    englishLabels: false,
    translateThinking: true,
    translateConversationTitles: true,
    enableRemoteThinkingTranslation: true
  };

  const { host } = createMockHost({
    onControl(routePath, body) {
      assert.equal(routePath, '/host/settings');
      if (body.pluginId === 'agy-daddy.zh-cn') {
        if (body.action === 'get') {
          return { ok: true, values: { ...stored }, schema: zhCnSchema };
        }
        if (body.action === 'save') {
          stored = { ...body.values };
          return { ok: true, values: { ...stored }, schema: zhCnSchema };
        }
      }
      if (body.pluginId === 'agy-daddy.custom-mixed' && body.action === 'get') {
        return {
          ok: true,
          values: { webFlag: true, desktopFlag: 'keep-me' },
          schema: {
            fields: [
              { key: 'webFlag', type: 'boolean', surfaces: ['web'] },
              { key: 'desktopFlag', type: 'string', surfaces: ['desktop'] }
            ]
          }
        };
      }
      return { ok: false };
    }
  });

  const proxy = createHostProxy({ host });

  // Web-scoped read filters out desktop-only fields (brandTitle, translateThinking, translateConversationTitles, enableRemoteThinkingTranslation)
  const webSettings = await proxy.getPluginSettings('agy-daddy.zh-cn', { scope: 'web' });
  assert.equal(webSettings.ok, true);
  assert.equal(webSettings.scope, 'web');
  assert.equal(webSettings.filteredDesktopFieldCount, zhCnSchema.fields.length - 2);
  assert.deepEqual(
    webSettings.schema.fields.map((f) => f.key),
    ['lang', 'englishLabels']
  );
  assert.deepEqual(webSettings.values, { lang: 'zh', englishLabels: false });
  assert.equal('brandTitle' in webSettings.values, false);
  assert.equal('enableRemoteThinkingTranslation' in webSettings.values, false);

  // Full read keeps all fields from agy-daddy-plugin-zh-cn/settings.schema.json
  const fullSettings = await proxy.getPluginSettings('agy-daddy.zh-cn');
  assert.equal(fullSettings.schema.fields.length, zhCnSchema.fields.length);
  assert.equal(fullSettings.values.brandTitle, 'translated');

  // Partial save from web preserves hidden desktop fields via mergeSettingsPatch
  const saved = await proxy.setPluginSettings('agy-daddy.zh-cn', { lang: 'ja', englishLabels: true });
  assert.equal(saved.ok, true);
  assert.deepEqual(stored, {
    lang: 'ja',
    brandTitle: 'translated',
    englishLabels: true,
    translateThinking: true,
    translateConversationTitles: true,
    enableRemoteThinkingTranslation: true
  });

  // Declarative surfaces array on fields works even for plugins outside WEB_RELEVANT_PLUGIN_POLICY
  const mixedWebSettings = await proxy.getPluginSettings('agy-daddy.custom-mixed', { scope: 'web' });
  assert.equal(mixedWebSettings.scope, 'web');
  assert.equal(mixedWebSettings.filteredDesktopFieldCount, 1);
  assert.deepEqual(mixedWebSettings.schema.fields.map((f) => f.key), ['webFlag']);
  assert.deepEqual(mixedWebSettings.values, { webFlag: true });
});

test('settings.schema.json removes redundant locale and tunnelHostname fields while keeping core web fields', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_DIR, 'settings.schema.json'), 'utf8')
  );
  const keys = schema.fields.map((f) => f.key);
  assert.equal(keys.includes('locale'), false);
  assert.equal(keys.includes('tunnelHostname'), false);
  assert.deepEqual(keys, [
    'port', 'bindHost', 'loopback', 'lan', 'tailscale', 'bonjour', 'cloudflare',
    'remotePermissionLevel', 'theme', 'colorTheme', 'drawerSpeed',
    'allowedRoots', 'autoOpenBrowser', 'enableNotifications'
  ]);
  const byKey = Object.fromEntries(schema.fields.map((f) => [f.key, f]));
  assert.equal(byKey.port.default, 18767);
  assert.equal(byKey.bindHost.default, 'auto');
  assert.equal(byKey.loopback.default, true);
  assert.equal(byKey.lan.default, false);
  assert.equal(byKey.remotePermissionLevel.default, 'L0');
  assert.equal(byKey.enableNotifications.type, 'boolean');
  assert.equal(byKey.enableNotifications.default, false);
  assert.deepEqual(byKey.enableNotifications.group, {
    'zh-CN': '通知与提醒',
    en: 'Notifications & Alerts'
  });
  assert.deepEqual(byKey.enableNotifications.label, {
    'zh-CN': '浏览器系统通知',
    en: 'Browser Notifications'
  });
  assert.equal(typeof byKey.enableNotifications.description['zh-CN'], 'string');
  assert.equal(typeof byKey.enableNotifications.description.en, 'string');
  assert.match(byKey.cloudflare.description['zh-CN'], /agy-daddy\.remote/);
  assert.match(byKey.cloudflare.description['zh-CN'], /\/pc\//);
});

test('Artifact previewers: BUILTIN_ARTIFACT_PREVIEWERS, getArtifactPreviewers plugin discovery, and renderPluginArtifactPreview', async () => {
  assert.equal(BUILTIN_ARTIFACT_PREVIEWERS.length, 5);
  const byId = Object.fromEntries(BUILTIN_ARTIFACT_PREVIEWERS.map((d) => [d.id, d]));
  assert.deepEqual(byId['builtin.markdown'].extensions, ['md', 'markdown']);
  assert.deepEqual(byId['builtin.svg'].extensions, ['svg']);
  assert.deepEqual(byId['builtin.image'].extensions, ['jpg', 'jpeg', 'png', 'gif', 'webp']);
  assert.deepEqual(byId['builtin.html'].extensions, ['html', 'htm']);
  assert.deepEqual(byId['builtin.pdf'].extensions, ['pdf']);

  // 1. Soft-degrades cleanly when host state/services/control are absent or throw
  {
    const proxy = createHostProxy({
      host: {
        state: {
          get() { throw new Error('state unavailable'); }
        },
        services: {
          async call() { throw new Error('service unavailable'); }
        }
      }
    });
    const res = await proxy.getArtifactPreviewers();
    assert.equal(res.ok, true);
    assert.equal(res.builtins.length, 5);
    assert.deepEqual(res.plugins, []);

    const missingSvc = await proxy.renderPluginArtifactPreview({
      pluginId: 'agy-daddy.mermaid',
      sessionId: 's-1',
      file: 'flow.mmd'
    });
    assert.equal(missingSvc.ok, false);
    assert.equal(missingSvc.statusCode, 404);
  }

  // 2. Discovers plugin previewers from host.state, enumerable state keys, artifact-previewer service, and active plugins
  {
    const stateEntries = new Map([
      ['state:host.artifact-previewers@1', {
        key: 'state:host.artifact-previewers@1',
        value: [
          {
            id: 'plugin.mermaid',
            name: 'Mermaid Diagram',
            extensions: ['.mmd', 'mermaid'],
            mimeTypes: ['text/vnd.mermaid'],
            pluginId: 'agy-daddy.mermaid',
            renderKind: 'plugin_html'
          }
        ]
      }],
      ['state:agy-daddy.csv.artifact-previewers@1', {
        key: 'state:agy-daddy.csv.artifact-previewers@1',
        value: {
          id: 'plugin.csv',
          name: 'CSV Table',
          extensions: ['csv', 'tsv'],
          mimeTypes: ['text/csv'],
          renderKind: 'plugin_iframe',
          iframeUrlTemplate: '/preview/csv?file={file}'
        }
      }]
    ]);

    const serviceCalls = [];
    const { host } = createMockHost({
      onControl(routePath) {
        if (routePath === '/host/plugins') {
          return {
            ok: true,
            plugins: [
              { id: 'agy-daddy.mermaid', active: true },
              {
                id: 'agy-daddy.docx',
                active: true,
                artifactPreviewers: [
                  {
                    id: 'plugin.docx',
                    name: 'DOCX Viewer',
                    extensions: ['docx'],
                    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
                    renderKind: 'plugin_markdown'
                  }
                ]
              }
            ],
            catalog: []
          };
        }
        return { ok: true };
      },
      onService(serviceName, method, args) {
        serviceCalls.push({ serviceName, method, args });
        if (serviceName === 'artifact-previewer' && method === 'listPreviewers') {
          return {
            ok: true,
            value: [
              {
                id: 'plugin.mermaid',
                name: 'Duplicate Mermaid Ignored',
                extensions: ['mmd'],
                mimeTypes: ['text/vnd.mermaid'],
                pluginId: 'agy-daddy.mermaid'
              },
              {
                id: 'plugin.ipynb',
                name: 'Notebook Viewer',
                extensions: ['ipynb'],
                mimeTypes: ['application/x-ipynb+json'],
                pluginId: 'agy-daddy.notebook',
                renderKind: 'plugin_html'
              }
            ]
          };
        }
        if (serviceName === 'agy-daddy.mermaid' && method === 'previewArtifact') {
          return {
            ok: true,
            value: {
              ok: true,
              kind: 'html',
              content: '<div class="mermaid">graph TD; A-->B;</div>',
              mime: 'text/html'
            }
          };
        }
        if (serviceName === 'agy-daddy.unimplemented' && method === 'previewArtifact') {
          return { ok: false, statusCode: 501, error: 'NOT_IMPLEMENTED' };
        }
        return { ok: false, unavailable: true, value: null };
      }
    });
    host.state = {
      get(key) { return stateEntries.get(key) || null; },
      keys() { return Array.from(stateEntries.keys()); }
    };

    const proxy = createHostProxy({ host });
    const discovered = await proxy.getArtifactPreviewers();
    assert.equal(discovered.ok, true);
    assert.equal(discovered.builtins.length, 5);
    assert.deepEqual(
      discovered.plugins.map((p) => p.id),
      ['plugin.mermaid', 'plugin.csv', 'plugin.ipynb', 'plugin.docx']
    );
    const csvDesc = discovered.plugins.find((p) => p.id === 'plugin.csv');
    assert.equal(csvDesc.pluginId, 'agy-daddy.csv');
    assert.equal(csvDesc.source, 'plugin');
    assert.equal(csvDesc.renderKind, 'plugin_iframe');

    // Validation: empty pluginId -> 400
    const badReq = await proxy.renderPluginArtifactPreview({ pluginId: '   ', sessionId: 's-1', file: 'a.mmd' });
    assert.equal(badReq.ok, false);
    assert.equal(badReq.statusCode, 400);

    // Unavailable plugin -> 404
    const notFound = await proxy.renderPluginArtifactPreview({
      pluginId: 'agy-daddy.missing',
      sessionId: 's-1',
      file: 'a.xyz'
    });
    assert.equal(notFound.ok, false);
    assert.equal(notFound.statusCode, 404);

    // Explicit 501 from plugin -> 501
    const notImpl = await proxy.renderPluginArtifactPreview({
      pluginId: 'agy-daddy.unimplemented',
      sessionId: 's-1',
      file: 'a.xyz'
    });
    assert.equal(notImpl.ok, false);
    assert.equal(notImpl.statusCode, 501);

    // Successful plugin preview render
    const previewOk = await proxy.renderPluginArtifactPreview({
      pluginId: 'agy-daddy.mermaid',
      sessionId: 's-1',
      file: 'flow.mmd',
      mime: 'text/vnd.mermaid'
    });
    assert.equal(previewOk.ok, true);
    assert.equal(previewOk.kind, 'html');
    assert.ok(previewOk.content.includes('graph TD'));
    assert.deepEqual(
      serviceCalls.find((c) => c.serviceName === 'agy-daddy.mermaid'),
      {
        serviceName: 'agy-daddy.mermaid',
        method: 'previewArtifact',
        args: [{ sessionId: 's-1', file: 'flow.mmd', mime: 'text/vnd.mermaid' }]
      }
    );
  }

  // 3. Missing host.services returns 501 cleanly
  {
    const { host } = createMockHost({ services: undefined });
    const proxy = createHostProxy({ host });
    const res = await proxy.renderPluginArtifactPreview({
      pluginId: 'agy-daddy.mermaid',
      sessionId: 's-1',
      file: 'flow.mmd'
    });
    assert.equal(res.ok, false);
    assert.equal(res.statusCode, 501);
  }
});

test('E6: getTopbar supports usage.getSummary service and state:usage.summary@1 fallback', async () => {
  // 1. Service getSummary()
  {
    const { host } = createMockHost({
      onService(serviceName, method) {
        if (serviceName === 'usage' && method === 'getSummary') {
          return { ok: true, value: { totalTokens: 42000, totalUsd: 1.25 } };
        }
        return { ok: false, unavailable: true, value: null };
      }
    });
    const proxy = createHostProxy({ host });
    const topbar = await proxy.getTopbar();
    assert.equal(topbar.panels.usage.available, true);
    assert.equal(topbar.panels.usage.source, 'service');
    assert.equal(topbar.panels.usage.data.totalTokens, 42000);
  }

  // 2. State state:usage.summary@1 fallback
  {
    const { host } = createMockHost({
      onService() {
        return { ok: false, unavailable: true, value: null };
      },
      onStateGet(key) {
        if (key === 'state:usage.summary@1') {
          return { key, value: { totalTokens: 8800, currency: 'CNY' }, version: 2 };
        }
        return null;
      }
    });
    const proxy = createHostProxy({ host });
    const topbar = await proxy.getTopbar();
    assert.equal(topbar.panels.usage.available, true);
    assert.equal(topbar.panels.usage.source, 'state');
    assert.equal(topbar.panels.usage.data.totalTokens, 8800);
  }
});

test('E7: getRemoteStatus aggregates remote snapshot/state, generates qrSvg, and soft-degrades when absent', async () => {
  // 1. Live remote status with primaryUrl -> generates crisp SVG QR
  {
    const { host } = createMockHost({
      onService(serviceName, method) {
        if (serviceName === 'remote' && method === 'getSnapshot') {
          return {
            ok: true,
            value: {
              ok: true,
              permissionLevel: 'L1',
              writeEnabled: true,
              channels: { lan: true, loopback: true }
            }
          };
        }
        return { ok: false, unavailable: true, value: null };
      },
      onStateGet(key) {
        if (key === 'state:remote.status@1') {
          return {
            key,
            value: {
              running: true,
              port: 18765,
              url: 'http://127.0.0.1:18765',
              primaryChannel: 'lan',
              primaryUrl: 'http://192.168.1.50:18765/?t=secret-token',
              devicesCount: 2
            }
          };
        }
        return null;
      }
    });
    const proxy = createHostProxy({ host });
    const status = await proxy.getRemoteStatus();
    assert.equal(status.ok, true);
    assert.equal(status.available, true);
    assert.equal(status.running, true);
    assert.equal(status.port, 18765);
    assert.equal(status.pairingUrl, 'http://192.168.1.50:18765/?t=secret-token');
    assert.equal(status.primaryChannel, 'lan');
    assert.equal(status.permissionLevel, 'L1');
    assert.equal(status.allowRemoteWrite, true);
    assert.equal(status.deviceCount, 2);
    assert.match(status.qrSvg, /^<svg\b/);
    assert.match(status.qrSvg, /<\/svg>$/);
  }

  // 2. Absent remote service and state -> soft-degrades
  {
    const { host } = createMockHost({
      onService() {
        return { ok: false, unavailable: true, value: null };
      }
    });
    const proxy = createHostProxy({ host });
    const status = await proxy.getRemoteStatus();
    assert.deepEqual(status, {
      ok: true,
      available: false,
      running: false
    });
  }
});

test('E8: reconcileAccess serializes rapid settings changes and rolls back to previousHost when rebind start() fails', async () => {
  const { activate, deactivate } = require('../src/node');
  let liveSettings = {
    loopback: true,
    lan: false,
    remotePermissionLevel: 'L0',
    tunnelHostname: ''
  };
  const changeListeners = new Set();
  const stateMap = new Map();
  const storageMap = new Map();

  const host = {
    settings: {
      get: () => ({ ...liveSettings }),
      onChange: (fn) => {
        changeListeners.add(fn);
        return () => changeListeners.delete(fn);
      }
    },
    storage: {
      readJson: (name, fallback) => ({
        ok: true,
        data: storageMap.has(name) ? storageMap.get(name) : fallback
      }),
      writeJson: (name, val) => {
        storageMap.set(name, val);
        return { ok: true };
      }
    },
    state: {
      get: (key) => stateMap.get(key) || null,
      set: (key, value) => {
        stateMap.set(key, value);
        return { key, value };
      }
    },
    rpc: {
      call: async () => ({}),
      getOrigin: async () => null
    }
  };

  const emitSettings = (next) => {
    liveSettings = { ...liveSettings, ...next };
    for (const fn of Array.from(changeListeners)) {
      fn();
    }
  };

  const listenHosts = [];
  let failNextWildcardBind = false;
  const origListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function patchedListen(...args) {
    const bindHost = typeof args[1] === 'string' ? args[1] : '';
    listenHosts.push(bindHost);
    if (failNextWildcardBind && bindHost === '0.0.0.0') {
      failNextWildcardBind = false;
      process.nextTick(() => {
        const err = new Error('listen EADDRINUSE: address already in use 0.0.0.0');
        err.code = 'EADDRINUSE';
        this.emit('error', err);
      });
      return this;
    }
    return origListen.apply(this, args);
  };

  try {
    const initial = await activate(host);
    assert.equal(initial.running, true);
    assert.equal(initial.host, '127.0.0.1');
    const initialPort = initial.port;
    const authHeaders = { Authorization: `Bearer ${initial.pairingToken}` };

    // 1. Overlapping settings changes ({ lan: true }, then { lan: false } while
    // the first rebind is mid-flight) must execute strictly serially:
    // 127.0.0.1 -> 0.0.0.0 -> 127.0.0.1, keeping the same port and ending on 127.0.0.1.
    emitSettings({ lan: true });
    await Promise.resolve();
    emitSettings({ lan: false });
    await new Promise((r) => setTimeout(r, 120));

    assert.deepEqual(listenHosts, ['127.0.0.1', '0.0.0.0', '127.0.0.1']);
    const afterRapid = stateMap.get('state:web.status@1');
    assert.equal(afterRapid.running, true);
    assert.equal(afterRapid.host, '127.0.0.1');
    assert.equal(afterRapid.port, initialPort);
    assert.deepEqual(afterRapid.activeChannels, ['loopback']);

    const checkRapid = await httpJsonRequest(`http://127.0.0.1:${initialPort}/api/v1/web/status`, {
      headers: authHeaders
    });
    assert.equal(checkRapid.status, 200);
    assert.equal(checkRapid.json.bindHost, '127.0.0.1');

    // 2. When start() on the new bind address (0.0.0.0) fails, reconcileAccess
    // must roll back to previousHost (127.0.0.1) and previous policy and keep serving.
    failNextWildcardBind = true;
    emitSettings({
      lan: true,
      remotePermissionLevel: 'L2',
      tunnelHostname: 'https://ag.example.com'
    });
    await new Promise((r) => setTimeout(r, 120));

    const afterRollback = stateMap.get('state:web.status@1');
    assert.equal(afterRollback.running, true);
    assert.equal(afterRollback.host, '127.0.0.1');
    assert.equal(afterRollback.port, initialPort);
    assert.equal(afterRollback.permissionLevel, 'L0');
    assert.equal(afterRollback.tunnelHostname, '');

    const checkRecovered = await httpJsonRequest(
      `http://127.0.0.1:${initialPort}/api/v1/web/status`,
      { headers: authHeaders }
    );
    assert.equal(checkRecovered.status, 200);
    assert.equal(checkRecovered.json.bindHost, '127.0.0.1');
    assert.equal(checkRecovered.json.permissionLevel, 'L0');
  } finally {
    http.Server.prototype.listen = origListen;
    await deactivate();
  }
});

test('E9: 5-scenario cloudflareState matrix, remote token sync/fallback & legacy tunnelHostname backup', async () => {
  const { activate, deactivate } = require('../src/node');
  let liveSettings = { loopback: true, cloudflare: true, remotePermissionLevel: 'L0' };
  const stateMap = new Map();
  const storageMap = new Map([
    ['settings.json', { loopback: true, cloudflare: true, tunnelHostname: 'https://legacy.example.com' }]
  ]);
  const anyListeners = new Set();
  const settingsListeners = new Set();

  let remoteOnline = false;
  let remoteBundle = {
    ok: true,
    available: true,
    running: true,
    port: 18765,
    authEpoch: 1,
    token: 'remote-shared-tok-1',
    confirmSecret: 'remote-confirm-1',
    proxySecret: 'remote-proxy-1',
    cloudflareEnabled: false,
    tunnelMode: 'quick',
    tunnelPublicOrigin: '',
    tunnelState: { active: false, mode: 'quick', publicUrl: '', error: null },
    tunnelConfigError: ''
  };

  const host = {
    settings: {
      get: () => ({ ...liveSettings }),
      onChange: (fn) => {
        settingsListeners.add(fn);
        return () => settingsListeners.delete(fn);
      }
    },
    storage: {
      readJson: (name, fallback) => ({
        ok: true,
        data: storageMap.has(name) ? storageMap.get(name) : fallback
      }),
      writeJson: (name, val) => {
        storageMap.set(name, val);
        return { ok: true };
      }
    },
    state: {
      get: (key) => stateMap.get(key) || null,
      set: (key, val) => {
        stateMap.set(key, val);
        return { key, value: val };
      }
    },
    events: {
      onAny: (fn) => {
        anyListeners.add(fn);
        return () => anyListeners.delete(fn);
      }
    },
    services: {
      call: async (svc, method) => {
        if (svc === 'remote' && method === 'getSharedAuthBundle' && remoteOnline) {
          return { ok: true, value: { ...remoteBundle } };
        }
        return { ok: false, unavailable: true };
      }
    },
    rpc: {
      call: async () => ({}),
      getOrigin: async () => null
    }
  };

  function emitRemoteState(payload = { running: remoteOnline }) {
    for (const fn of anyListeners) {
      fn({ kind: 'state', topicOrKey: 'state:remote.status@1', payload });
    }
  }

  try {
    // Scenario 5a: remote offline + legacy tunnelHostname from raw settings.json
    const st5a = await activate(host);
    assert.equal(st5a.cloudflareState.mode, 'legacy_standalone');
    assert.equal(st5a.primaryChannel, 'cloudflare');
    assert.match(st5a.primaryUrl, /^https:\/\/legacy\.example\.com\/\?token=/);
    assert.equal(storageMap.get('web-config.json').legacyTunnelHostname, 'https://legacy.example.com');
    const localTok = st5a.pairingToken;

    // Scenario 4: remote online, remote.cloudflare = false -> syncs token to web-config.json
    remoteOnline = true;
    emitRemoteState({ running: true });
    await new Promise((r) => setTimeout(r, 40));
    let st = stateMap.get('state:web.status@1');
    assert.equal(st.cloudflareState.mode, 'remote_tunnel_off');
    assert.equal(st.primaryChannel, 'loopback');
    assert.equal(storageMap.get('web-config.json').token, 'remote-shared-tok-1');
    assert.equal(storageMap.get('web-config.json').localToken, localTok);

    // Scenario 3a: remote.cloudflare = true, tunnel starting (no publicOrigin yet)
    remoteBundle.cloudflareEnabled = true;
    emitRemoteState({ running: true });
    await new Promise((r) => setTimeout(r, 40));
    st = stateMap.get('state:web.status@1');
    assert.equal(st.cloudflareState.mode, 'remote_pending');

    // Scenario 3b: remote.cloudflare = true, tunnelConfigError
    remoteBundle.tunnelConfigError = 'CLOUDFLARED_NOT_INSTALLED';
    emitRemoteState({ running: true });
    await new Promise((r) => setTimeout(r, 40));
    st = stateMap.get('state:web.status@1');
    assert.equal(st.cloudflareState.mode, 'remote_error');
    assert.equal(st.cloudflareState.reasonCode, 'CLOUDFLARED_NOT_INSTALLED');

    // Scenario 1: shared_ready -> overrides legacyTunnelHostname and mounts at /pc/
    remoteBundle.tunnelConfigError = '';
    remoteBundle.tunnelPublicOrigin = 'https://shared-tun.trycloudflare.com';
    remoteBundle.tunnelState = { active: true, mode: 'quick', publicUrl: 'https://shared-tun.trycloudflare.com', error: null };
    emitRemoteState({ running: true });
    await new Promise((r) => setTimeout(r, 40));
    st = stateMap.get('state:web.status@1');
    assert.equal(st.cloudflareState.mode, 'shared_ready');
    assert.equal(st.primaryChannel, 'cloudflare');
    assert.match(st.primaryUrl, /^https:\/\/shared-tun\.trycloudflare\.com\/pc\/\?token=remote-shared-tok-1$/);

    // Scenario 2: web.cloudflare = false while remote tunnel is ready -> web_disabled
    liveSettings = { loopback: true, cloudflare: false, remotePermissionLevel: 'L0' };
    for (const fn of settingsListeners) fn();
    await new Promise((r) => setTimeout(r, 40));
    st = stateMap.get('state:web.status@1');
    assert.equal(st.cloudflareState.mode, 'web_disabled');
    assert.equal(st.primaryChannel, 'loopback');

    // Scenario 5b: remote deactivates and no legacy hostname -> remote_unavailable + localToken fallback
    storageMap.set('settings.json', { loopback: true, cloudflare: true });
    liveSettings = { loopback: true, cloudflare: true, remotePermissionLevel: 'L0' };
    for (const fn of settingsListeners) fn();
    await new Promise((r) => setTimeout(r, 40));
    // Clear legacyTunnelHostname for 5b check by verifying token reverts on remote deactivate
    remoteOnline = false;
    emitRemoteState({ running: false, deactivated: true });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(storageMap.get('web-config.json').token, localTok);
  } finally {
    await deactivate();
  }
});

test('HUB-332: enableNotifications defaults to false, updates via host.settings.onChange, and broadcasts SSE state.patch', async () => {
  const { activate, deactivate } = require('../src/node');
  let liveSettings = {
    loopback: true
  };
  const storageMap = new Map();
  const stateMap = new Map();
  const settingsListeners = new Set();

  const host = {
    storage: {
      readJson(name, fallback) {
        return { ok: true, data: storageMap.get(name) ?? fallback };
      },
      writeJson(name, data) {
        storageMap.set(name, data);
        return { ok: true };
      }
    },
    settings: {
      get() { return { ...liveSettings }; },
      onChange(fn) {
        settingsListeners.add(fn);
        return () => settingsListeners.delete(fn);
      }
    },
    state: {
      get(key) { return stateMap.get(key) ?? null; },
      set(key, val) { stateMap.set(key, val); }
    },
    services: {
      async provide() { return () => {}; },
      async call() { return { ok: false, unavailable: true }; }
    },
    events: {
      onAny() { return () => {}; }
    },
    rpc: {
      async getOrigin() { return 'http://127.0.0.1:41999'; },
      async call() { return { ok: true }; }
    }
  };

  try {
    const initialStatus = await activate(host);
    assert.equal(initialStatus.enableNotifications, false);
    const token = storageMap.get('web-config.json').token;
    const baseUrl = initialStatus.url;

    const statusBefore = await httpJsonRequest(`${baseUrl}/api/v1/web/status`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(statusBefore.status, 200);
    assert.equal(statusBefore.json.enableNotifications, false);

    const ssePromise = waitForSseEvent(
      `${baseUrl}/api/v1/stream`,
      { Authorization: `Bearer ${token}` },
      (ev) =>
        ev.event === 'state.patch' &&
        ev.json?.key === 'state:plugin.settings@1' &&
        ev.json?.value?.pluginId === 'agy-daddy.web' &&
        ev.json?.value?.values?.enableNotifications === true,
      2000
    );
    await new Promise((r) => setTimeout(r, 40));

    liveSettings = { loopback: true, enableNotifications: true };
    for (const fn of settingsListeners) fn();

    const patchEv = await ssePromise;
    assert.equal(patchEv.json.value.values.enableNotifications, true);

    const statusAfter = await httpJsonRequest(`${baseUrl}/api/v1/web/status`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(statusAfter.status, 200);
    assert.equal(statusAfter.json.enableNotifications, true);
  } finally {
    await deactivate();
  }
});

