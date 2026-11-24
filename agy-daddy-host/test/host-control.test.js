'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AgyDaddyDaemon } = require('../src/core/daemon');
const { createMockHostHarness } = require('../sdk/mock-harness');

test('host.control.invoke 仅向持有 host:control 的插件开放且严格执行路由白名单', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-host-control-'));
  const stateDir = path.join(tmp, 'state');
  const pluginsDir = path.join(tmp, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });

  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    workspaceRoot: tmp,
    plugins: []
  });

  try {
    await daemon.start();

    const apiWithControl = daemon.buildInProcessHostApi(
      'agy-daddy.web',
      { id: 'agy-daddy.web', version: '1.0.0' },
      { granted: ['fs:plugin-data', 'host:control'] }
    );
    assert.ok(apiWithControl.control);
    assert.equal(typeof apiWithControl.control.invoke, 'function');
    assert.equal(typeof apiWithControl.events.onAny, 'function');

    const pluginsRes = await apiWithControl.control.invoke('/host/plugins');
    assert.equal(pluginsRes.ok, true);
    assert.ok(Array.isArray(pluginsRes.plugins));

    const saveRes = await apiWithControl.control.invoke('/host/settings', {
      pluginId: 'agy-daddy.demo',
      action: 'save',
      values: { port: 18766 }
    });
    assert.equal(saveRes.ok, true);

    const getRes = await apiWithControl.control.invoke('host/settings', {
      pluginId: 'agy-daddy.demo',
      action: 'get'
    });
    assert.equal(getRes.ok, true);
    assert.equal(getRes.values.port, 18766);

    await assert.rejects(
      () => apiWithControl.control.invoke('/host/evil', {}),
      (err) => err?.code === 'HOST_CONTROL_ROUTE_BLOCKED' && /HOST_CONTROL_ROUTE_BLOCKED/.test(err.message)
    );
    await assert.rejects(
      () => apiWithControl.control.invoke('/host/unknown', {}),
      (err) => err?.code === 'HOST_CONTROL_ROUTE_BLOCKED' && /HOST_CONTROL_ROUTE_BLOCKED/.test(err.message)
    );

    const apiWithoutControl = daemon.buildInProcessHostApi(
      'agy-daddy.reader',
      { id: 'agy-daddy.reader', version: '1.0.0' },
      { granted: ['fs:plugin-data', 'rpc:read'] }
    );
    assert.equal(apiWithoutControl.control, undefined);
  } finally {
    await daemon.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mock-harness 镜像 events.onAny、services.has、settings 与 host.control 权限隔离', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mock-ctl-'));
  const pluginDir = path.join(tmp, 'plugin-ctl');
  fs.mkdirSync(path.join(pluginDir, 'src'), { recursive: true });

  fs.writeFileSync(path.join(pluginDir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'agy-daddy.ctl-mock',
    publisher: 'agy-daddy',
    version: '1.0.0',
    displayName: { en: 'Ctl Mock' },
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    world: 'isolated',
    permissions: ['host:control']
  }));

  fs.writeFileSync(path.join(pluginDir, 'src', 'node.js'), `
    let capturedHost = null;
    let seen = [];
    let unsub = null;
    module.exports = {
      async activate(host) {
        capturedHost = host;
        unsub = host.events.onAny((ev) => seen.push(ev));
        host.services.provide('demo-svc', { ping: () => 'pong' });
      },
      async deactivate() {
        if (unsub) unsub();
      },
      getCaptured() { return { capturedHost, seen }; }
    };
  `);

  const harness = createMockHostHarness({
    onHostControl: async (routePath, body) => ({ ok: true, routePath, body })
  });

  try {
    await harness.loadAndRunPlugin(pluginDir, { trustLevel: 'T0' });
    const mod = require(path.join(pluginDir, 'src', 'node.js'));
    const { capturedHost, seen } = mod.getCaptured();

    assert.equal(capturedHost.services.has('demo-svc'), true);
    assert.equal(capturedHost.services.has('missing-svc'), false);

    capturedHost.settings.save({ port: 18766 });
    assert.deepEqual(capturedHost.settings.get(), { port: 18766 });

    harness.bus.emitEvent('other.plugin', 'ping@1', { v: 1 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, 'event');

    const ctlOk = await capturedHost.control.invoke('/host/plugins', { filter: 'all' });
    assert.deepEqual(ctlOk, { ok: true, routePath: '/host/plugins', body: { filter: 'all' } });

    await assert.rejects(
      () => capturedHost.control.invoke('/host/unknown', {}),
      (err) => err?.code === 'HOST_CONTROL_ROUTE_BLOCKED'
    );

    await harness.unloadPlugin('agy-daddy.ctl-mock');
    harness.assertCleanDispose('agy-daddy.ctl-mock');
  } finally {
    await harness.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('/host/settings 在 get 与 save 时均返回 plugin 的 settings.schema.json（覆盖已激活与仅已安装未激活插件）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-settings-schema-'));
  const stateDir = path.join(tmp, 'state');
  const pluginsDir = path.join(tmp, 'plugins');
  const activePluginDir = path.join(tmp, 'active-plugin');
  const disabledPluginDir = path.join(tmp, 'disabled-plugin');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(path.join(activePluginDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(disabledPluginDir, 'src'), { recursive: true });

  const activeSchema = {
    fields: [
      { key: 'port', type: 'number', min: 1024, max: 65535, default: 18766 },
      { key: 'autoOpen', type: 'boolean', default: true }
    ]
  };
  fs.writeFileSync(path.join(activePluginDir, 'settings.schema.json'), JSON.stringify(activeSchema));
  fs.writeFileSync(path.join(activePluginDir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'agy-daddy.active-cfg',
    publisher: 'agy-daddy',
    version: '1.0.0',
    displayName: { en: 'Active Config' },
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    world: 'isolated',
    contributes: { settings: { schema: './settings.schema.json' } }
  }));
  fs.writeFileSync(path.join(activePluginDir, 'src', 'node.js'), 'module.exports = { async activate() {}, async deactivate() {} };');

  const disabledSchema = {
    fields: [
      { key: 'mode', type: 'enum', options: ['fast', 'safe'], default: 'fast' }
    ]
  };
  fs.writeFileSync(path.join(disabledPluginDir, 'settings.schema.json'), JSON.stringify(disabledSchema));
  fs.writeFileSync(path.join(disabledPluginDir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'agy-daddy.disabled-cfg',
    publisher: 'agy-daddy',
    version: '1.0.0',
    displayName: { en: 'Disabled Config' },
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    world: 'isolated',
    contributes: { settings: { schema: './settings.schema.json' } }
  }));
  fs.writeFileSync(path.join(disabledPluginDir, 'src', 'node.js'), 'module.exports = { async activate() {}, async deactivate() {} };');

  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    workspaceRoot: tmp,
    plugins: []
  });

  try {
    await daemon.start();
    const api = daemon.buildInProcessHostApi(
      'agy-daddy.web',
      { id: 'agy-daddy.web', version: '1.0.0' },
      { granted: ['fs:plugin-data', 'host:control'] }
    );

    // 1. Install and activate first plugin
    const installActive = await api.control.invoke('/host/plugins/install', {
      spec: `local:${activePluginDir}`,
      trustLevel: 'T0',
      grantedPermissions: []
    });
    assert.equal(installActive.ok, true);

    const activeGet = await api.control.invoke('/host/settings', {
      pluginId: 'agy-daddy.active-cfg',
      action: 'get'
    });
    assert.equal(activeGet.ok, true);
    assert.deepEqual(activeGet.values, { port: 18766, autoOpen: true });
    assert.deepEqual(activeGet.schema, activeSchema);

    const activeSave = await api.control.invoke('/host/settings', {
      pluginId: 'agy-daddy.active-cfg',
      action: 'save',
      values: { port: 19000, autoOpen: false }
    });
    assert.equal(activeSave.ok, true);
    assert.deepEqual(activeSave.values, { port: 19000, autoOpen: false });

    const badSave = await api.control.invoke('/host/settings', {
      pluginId: 'agy-daddy.active-cfg',
      action: 'save',
      values: { port: 80, autoOpen: false }
    });
    assert.equal(badSave.ok, false);
    assert.ok(Array.isArray(badSave.errors) && badSave.errors.length > 0);

    // 2. Install second plugin and disable it so it is only in installed index (not activePlugins)
    const installDisabled = await api.control.invoke('/host/plugins/install', {
      spec: `local:${disabledPluginDir}`,
      trustLevel: 'T0',
      grantedPermissions: []
    });
    assert.equal(installDisabled.ok, true);
    await api.control.invoke('/host/plugins/toggle', {
      pluginId: 'agy-daddy.disabled-cfg',
      enabled: false
    });
    assert.equal(daemon.activePlugins.has('agy-daddy.disabled-cfg'), false);

    const disabledGet = await api.control.invoke('/host/settings', {
      pluginId: 'agy-daddy.disabled-cfg',
      action: 'get'
    });
    assert.equal(disabledGet.ok, true);
    assert.deepEqual(disabledGet.schema, disabledSchema);

    const disabledSave = await api.control.invoke('/host/settings', {
      pluginId: 'agy-daddy.disabled-cfg',
      action: 'save',
      values: { mode: 'safe' }
    });
    assert.equal(disabledSave.ok, true);
    assert.deepEqual(disabledSave.values, { mode: 'safe' });
  } finally {
    await daemon.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
