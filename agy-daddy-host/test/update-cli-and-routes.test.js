'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const { createTarGzBuffer } = require('../src/core/tar');
const { installPlugin } = require('../src/core/installer');
const { AgyDaddyDaemon, HOST_CONTROL_ROUTE_ALLOWLIST } = require('../src/core/daemon');
const { MemoryTrayBackend, TrayManager, UPDATE_TRAY_MENU_IDS } = require('../src/core/tray-manager');
const { FourRealmBus } = require('../src/core/bus');
const { runDoctor, exportDiagnosticBundle } = require('../src/core/doctor');

const HOST_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(HOST_ROOT, 'src', 'cli.js');

function makeTempDir(t, prefix = 'agy-upd-cli-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return dir;
}

function runCliAsync(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function sha512Integrity(buf) {
  return `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
}

function makePluginTgz(manifest) {
  return createTarGzBuffer({
    'package.json': JSON.stringify({ name: `@third/${manifest.id}`, version: manifest.version }),
    'agy-plugin.json': JSON.stringify(manifest),
    'index.js': 'module.exports = { activate() {} };'
  });
}

test('Daemon /host/updates/* Bridge RPC、buildPluginManagePayload 兼容字段与 Doctor 诊断段', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');

  for (const r of ['/host/updates/status', '/host/updates/check', '/host/updates/apply', '/host/updates/rollback', '/host/updates/pin']) {
    assert.ok(HOST_CONTROL_ROUTE_ALLOWLIST.includes(r), `Missing allowlist route ${r}`);
  }

  const manV1 = {
    schemaVersion: 1, id: 'third.routedemo', publisher: 'third', version: '1.0.0',
    displayName: 'Route Demo', engines: { agyDaddy: '^1.0.0' }, world: 'isolated', main: './index.js', permissions: ['dom:read']
  };
  const manV12 = { ...manV1, version: '1.2.0', permissions: ['dom:read', 'bridge:route'] };
  const tgzV1 = makePluginTgz(manV1);
  const tgzV12 = makePluginTgz(manV12);

  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const port = server.address().port;
    if (p === '/@third%2Froutedemo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: '@third/routedemo',
        'dist-tags': { latest: '1.2.0' },
        versions: {
          '1.0.0': { dist: { tarball: `http://127.0.0.1:${port}/v1.tgz`, integrity: sha512Integrity(tgzV1) } },
          '1.2.0': { dist: { tarball: `http://127.0.0.1:${port}/v12.tgz`, integrity: sha512Integrity(tgzV12) } }
        }
      }));
      return;
    }
    if (p === '/@agy-daddy%2Fhost' || p === '/@agy-daddy%2Fregistry') {
      const ver = '1.1.1';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: p, 'dist-tags': { latest: ver }, versions: { [ver]: { dist: {} } } }));
      return;
    }
    if (p === '/v1.tgz') return res.writeHead(200).end(tgzV1);
    if (p === '/v12.tgz') return res.writeHead(200).end(tgzV12);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const npmRegistryUrl = `http://127.0.0.1:${server.address().port}`;

  await installPlugin('npm:@third/routedemo@1.0.0', {
    stateDir, pluginsDir, npmRegistryUrl, trustLevel: 'T2', grantedPermissions: ['dom:read']
  });

  const daemon = new AgyDaddyDaemon({ stateDir, pluginsDir, npmRegistryUrl, skipInject: true });
  const started = await daemon.start();
  t.after(async () => { await daemon.stop().catch(() => {}); });

  const base = `http://127.0.0.1:${started.port}`;
  const headers = { 'Content-Type': 'application/json', 'X-AGY-Host-Token': started.hostToken };
  const post = async (route, body = {}) => fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => r.json());

  // 1. Save host update settings via /host/host-settings
  const saveRes = await post('/host/host-settings', {
    action: 'save',
    patch: { updateChannel: 'stable', autoUpdateMode: 'notify', updateCheckInterval: '12h', npmRegistryUrl }
  });
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.values.updateCheckInterval, '12h');
  assert.equal(saveRes.values.npmRegistryUrl, npmRegistryUrl);

  // 2. Status (zero network)
  const st1 = await post('/host/updates/status');
  assert.equal(st1.ok, true);
  assert.equal(st1.settings.npmRegistryUrl, npmRegistryUrl);

  // 3. Check updates
  const chk1 = await post('/host/updates/check', { targets: ['third.routedemo'], forceRefresh: true });
  assert.equal(chk1.ok, true);
  assert.equal(chk1.checkedNow, true);
  assert.equal(chk1.summary.pluginAvailableCount, 1);

  // Debounced check within 10s
  const chkDebounced = await post('/host/updates/check', { targets: ['third.routedemo'], forceRefresh: false });
  assert.equal(chkDebounced.debounced, true);

  // /host/plugins exposes updateInfo + updatesSummary
  const pluginsPayload = await post('/host/plugins');
  assert.equal(pluginsPayload.updatesSummary.pluginAvailableCount, 1);
  const demoItem = pluginsPayload.plugins.find((p) => p.id === 'third.routedemo');
  assert.equal(demoItem.updateInfo.latestVersion, '1.2.0');

  // 4. Pin / Unpin
  const pinRes = await post('/host/updates/pin', { pluginId: 'third.routedemo', pinned: true });
  assert.equal(pinRes.ok, true);
  assert.equal(pinRes.pinned, true);
  await post('/host/updates/pin', { pluginId: 'third.routedemo', pinned: false });

  // 5. Apply without permission -> confirmation envelope, then with grantedPermissions -> succeeds
  const needPerm = await post('/host/updates/apply', { targets: ['third.routedemo'] });
  assert.equal(needPerm.ok, false);
  assert.equal(needPerm.needsPermissionConfirm, true);
  assert.deepEqual(needPerm.confirmations[0].addedPermissions, ['bridge:route']);

  const applied = await post('/host/updates/apply', {
    targets: ['third.routedemo'],
    grantedPermissions: { 'third.routedemo': ['bridge:route'] }
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.results[0].outcome, 'succeeded');

  // 6. Rollback
  const rb = await post('/host/updates/rollback', { target: 'third.routedemo' });
  assert.equal(rb.ok, true);
  assert.equal(rb.restoredVersion, '1.0.0');

  // 7. Doctor & Diagnostic bundle include updates section
  const doc = await runDoctor({ stateDir, pluginsDir, skipCdp: true });
  assert.ok(doc.updates);
  assert.ok(Array.isArray(doc.updates.recentHistory));
  assert.ok(doc.updates.recentHistory.length >= 2);
  const expPath = path.join(root, 'diag.json');
  const exp = await exportDiagnosticBundle(expPath, { stateDir, pluginsDir, skipCdp: true });
  assert.equal(exp.ok, true);
  assert.ok(exp.report.updates);
});

test('TrayManager 更新菜单项动态文案与点击路由', async () => {
  const bus = new FourRealmBus();
  const backend = new MemoryTrayBackend();
  const clicks = [];
  const tray = new TrayManager({
    bus,
    backend,
    onCheckUpdates: (opts) => clicks.push(opts)
  });

  await tray.start();
  let checkItem = backend.lastPayload.items.find((i) => i.id === UPDATE_TRAY_MENU_IDS.CHECK_UPDATES);
  assert.equal(checkItem.label, '检查更新…');

  tray.setUpdatesSummary({ availableCount: 3, pluginAvailableCount: 2, hostAvailable: true });
  await new Promise((r) => setTimeout(r, 20));
  checkItem = backend.lastPayload.items.find((i) => i.id === UPDATE_TRAY_MENU_IDS.CHECK_UPDATES);
  assert.equal(checkItem.label, '发现 3 个可用更新…');

  const clickRes = await tray.handleMenuClick(UPDATE_TRAY_MENU_IDS.CHECK_UPDATES);
  assert.equal(clickRes.ok, true);
  assert.equal(clicks.length, 1);
  await tray.dispose();
});

test('CLI: agy-daddy update (--repo/--check/exit 2/--grant) 与 plugin check/update/pin', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const dirtyRepo = path.join(root, 'dirty-repo');

  fs.mkdirSync(dirtyRepo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: dirtyRepo });
  execFileSync('git', ['config', 'user.email', 'test@agy.local'], { cwd: dirtyRepo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dirtyRepo });
  fs.writeFileSync(path.join(dirtyRepo, 'a.txt'), '1');
  execFileSync('git', ['add', '.'], { cwd: dirtyRepo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dirtyRepo });
  fs.writeFileSync(path.join(dirtyRepo, 'a.txt'), '2');

  const cliEnv = {
    ...process.env,
    AGY_DADDY_TEST_MODE: '1',
    AGY_DADDY_STATE_DIR: stateDir,
    AGY_DADDY_PLUGINS_DIR: pluginsDir
  };

  // 1. Backward compatible --repo dirty check
  const dirtyOut = await runCliAsync(['update', '--repo', dirtyRepo, '--dry-run', '--json'], cliEnv);
  assert.equal(dirtyOut.status, 1);
  assert.equal(JSON.parse(dirtyOut.stdout).error, 'DIRTY_WORKTREE');

  // 2. Mock npm registry for CLI plugin check/update/pin
  const manV1 = {
    schemaVersion: 1, id: 'third.clidemo', publisher: 'third', version: '1.0.0',
    displayName: 'CLI Demo', engines: { agyDaddy: '^1.0.0' }, world: 'isolated', main: './index.js', permissions: []
  };
  const manV11 = { ...manV1, version: '1.1.0', permissions: ['dom:read'] };
  const tgzV1 = makePluginTgz(manV1);
  const tgzV11 = makePluginTgz(manV11);

  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const port = server.address().port;
    if (p === '/@third%2Fclidemo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: '@third/clidemo',
        'dist-tags': { latest: '1.1.0' },
        versions: {
          '1.0.0': { dist: { tarball: `http://127.0.0.1:${port}/v1.tgz`, integrity: sha512Integrity(tgzV1) } },
          '1.1.0': { dist: { tarball: `http://127.0.0.1:${port}/v11.tgz`, integrity: sha512Integrity(tgzV11) } }
        }
      }));
      return;
    }
    if (p === '/v1.tgz') return res.writeHead(200).end(tgzV1);
    if (p === '/v11.tgz') return res.writeHead(200).end(tgzV11);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const regUrl = `http://127.0.0.1:${server.address().port}`;

  await installPlugin('npm:@third/clidemo@1.0.0', { stateDir, pluginsDir, npmRegistryUrl: regUrl, trustLevel: 'T2' });

  const chkOut = await runCliAsync(['plugin', 'check', 'third.clidemo', '--registry', regUrl, '--json'], cliEnv);
  assert.equal(chkOut.status, 0, chkOut.stderr);
  assert.equal(JSON.parse(chkOut.stdout).targets['third.clidemo'].latestVersion, '1.1.0');

  // Non-TTY permission expansion without --grant -> exit code 2
  const blockedOut = await runCliAsync(['plugin', 'update', 'third.clidemo', '--registry', regUrl, '--json'], cliEnv);
  assert.equal(blockedOut.status, 2);
  assert.equal(JSON.parse(blockedOut.stdout).errorCode, 'PERMISSION_CONFIRMATION_REQUIRED');

  // With --grant dom:read --yes -> exit code 0
  const okOut = await runCliAsync(['plugin', 'update', 'third.clidemo', '--registry', regUrl, '--grant', 'dom:read', '--yes', '--json'], cliEnv);
  assert.equal(okOut.status, 0, okOut.stderr);
  assert.equal(JSON.parse(okOut.stdout).ok, true);

  // Pin & unpin
  const pinOut = await runCliAsync(['plugin', 'pin', 'third.clidemo', '--json'], cliEnv);
  assert.equal(pinOut.status, 0);
  assert.equal(JSON.parse(pinOut.stdout).pinned, true);

  const unpinOut = await runCliAsync(['plugin', 'pin', 'third.clidemo', '--off', '--json'], cliEnv);
  assert.equal(unpinOut.status, 0);
  assert.equal(JSON.parse(unpinOut.stdout).pinned, false);
});
