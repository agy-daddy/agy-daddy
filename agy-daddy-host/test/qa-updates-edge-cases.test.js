'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { createTarGzBuffer } = require('../src/core/tar');
const { installPlugin, linkPlugin, readInstalledIndex } = require('../src/core/installer');
const { checkUpdates } = require('../src/core/update-checker');
const {
  appendUpdateHistory,
  readUpdateHistory,
  applyUpdates
} = require('../src/core/updater');
const { AgyDaddyDaemon } = require('../src/core/daemon');
const { MemoryTrayBackend, TrayManager, UPDATE_TRAY_MENU_IDS } = require('../src/core/tray-manager');

const HOST_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(HOST_ROOT, 'src', 'cli.js');

function makeTempDir(t, prefix = 'agy-qa-upd-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
  return dir;
}

function sha512Integrity(buf) {
  return `sha512-${crypto.createHash('sha512').update(buf).digest('base64')}`;
}

function makePluginTgz(manifest, extraFiles = {}) {
  return createTarGzBuffer({
    'package.json': JSON.stringify({ name: `@third/${manifest.id}`, version: manifest.version }),
    'agy-plugin.json': JSON.stringify(manifest),
    'index.js': 'module.exports = { activate() {} };',
    ...extraFiles
  });
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

test('QA-INT-01: UpdateScheduler 真实定时器与 AgyDaddyDaemon + TrayManager 联动（auto-safe 仅升 T0、跳过 T2 与 local）', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');

  const t0V1 = {
    schemaVersion: 1, id: 'agy-daddy.qat0', publisher: 'agy-daddy', version: '1.0.0',
    displayName: 'QA T0', engines: { agyDaddy: '^1.0.0' }, world: 'isolated', main: './index.js', permissions: ['dom:read']
  };
  const t0V11 = { ...t0V1, version: '1.1.0' };
  const t2V1 = {
    schemaVersion: 1, id: 'third.qat2', publisher: 'third', version: '1.0.0',
    displayName: 'QA T2', engines: { agyDaddy: '^1.0.0' }, world: 'isolated', main: './index.js', permissions: ['dom:read']
  };
  const t2V12 = { ...t2V1, version: '1.2.0' };

  const tgzT0V1 = makePluginTgz(t0V1);
  const tgzT0V11 = makePluginTgz(t0V11);
  const tgzT2V1 = makePluginTgz(t2V1);
  const tgzT2V12 = makePluginTgz(t2V12);

  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const port = server.address().port;
    if (p === '/@agy-daddy%2Fplugin-qat0') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        name: '@agy-daddy/plugin-qat0',
        'dist-tags': { latest: '1.1.0' },
        versions: {
          '1.0.0': { dist: { tarball: `http://127.0.0.1:${port}/t0-v1.tgz`, integrity: sha512Integrity(tgzT0V1) } },
          '1.1.0': { dist: { tarball: `http://127.0.0.1:${port}/t0-v11.tgz`, integrity: sha512Integrity(tgzT0V11) } }
        }
      }));
    }
    if (p === '/@third%2Fqat2') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        name: '@third/qat2',
        'dist-tags': { latest: '1.2.0' },
        versions: {
          '1.0.0': { dist: { tarball: `http://127.0.0.1:${port}/t2-v1.tgz`, integrity: sha512Integrity(tgzT2V1) } },
          '1.2.0': { dist: { tarball: `http://127.0.0.1:${port}/t2-v12.tgz`, integrity: sha512Integrity(tgzT2V12) } }
        }
      }));
    }
    if (p === '/@agy-daddy%2Fhost' || p === '/@agy-daddy%2Fregistry') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ name: p, 'dist-tags': { latest: '1.1.1' }, versions: { '1.1.1': { dist: {} } } }));
    }
    if (p === '/t0-v1.tgz') return res.writeHead(200).end(tgzT0V1);
    if (p === '/t0-v11.tgz') return res.writeHead(200).end(tgzT0V11);
    if (p === '/t2-v1.tgz') return res.writeHead(200).end(tgzT2V1);
    if (p === '/t2-v12.tgz') return res.writeHead(200).end(tgzT2V12);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const npmRegistryUrl = `http://127.0.0.1:${server.address().port}`;

  await installPlugin('npm:@agy-daddy/plugin-qat0@1.0.0', {
    stateDir, pluginsDir, npmRegistryUrl, trustLevel: 'T0', grantedPermissions: ['dom:read']
  });
  await installPlugin('npm:@third/qat2@1.0.0', {
    stateDir, pluginsDir, npmRegistryUrl, trustLevel: 'T2', grantedPermissions: ['dom:read']
  });
  await linkPlugin(path.join(HOST_ROOT, 'templates', 'plugin-template'), {
    stateDir, pluginsDir, grantedPermissions: ['dom:write', 'bridge:route']
  });

  const daemon = new AgyDaddyDaemon({
    stateDir,
    pluginsDir,
    npmRegistryUrl,
    skipInject: true,
    enableSchedulerInTest: true,
    initialDelayMs: 25,
    jitterMs: 0
  });

  // Persist auto-safe mode before daemon starts
  daemon.saveHostSettings({
    autoUpdateMode: 'auto-safe',
    updateChannel: 'stable',
    npmRegistryUrl
  }, { skipTraySync: true });

  const backend = new MemoryTrayBackend();
  const tray = new TrayManager({ bus: daemon.bus, backend });
  daemon.trayManager = tray;
  await tray.start();
  t.after(async () => { await tray.dispose().catch(() => {}); });

  await daemon.start();
  t.after(async () => { await daemon.stop().catch(() => {}); });

  // Wait for initial scheduler cycle (25ms + apply)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const idx = readInstalledIndex({ stateDir });
    if (idx.plugins['agy-daddy.qat0']?.version === '1.1.0') break;
    await new Promise((r) => setTimeout(r, 40));
  }

  const idxAfter = readInstalledIndex({ stateDir });
  assert.equal(idxAfter.plugins['agy-daddy.qat0'].version, '1.1.0', 'T0 should auto-upgrade');
  assert.equal(idxAfter.plugins['third.qat2'].version, '1.0.0', 'T2 must NOT auto-upgrade');
  assert.equal(idxAfter.plugins['example.hello'].sourceKind, 'local');

  // Sticky bus state & tray label reflect remaining 1 T2 update
  await new Promise((r) => setTimeout(r, 40));
  const sticky = daemon.bus.getState('state:host.updates@1');
  assert.equal(sticky?.value?.summary?.availableCount, 1);
  const checkItem = backend.lastPayload.items.find((i) => i.id === UPDATE_TRAY_MENU_IDS.CHECK_UPDATES);
  assert.equal(checkItem.label, '发现 1 个可用更新…');
});

test('QA-INT-02: HOST_API_INCOMPATIBLE、UPDATE_NETWORK_TIMEOUT 退避重试、npm-global 权限不足、自更新与历史日志轮转', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const fakeHostRoot = path.join(root, 'host');
  fs.mkdirSync(fakeHostRoot, { recursive: true });
  fs.writeFileSync(path.join(fakeHostRoot, 'package.json'), JSON.stringify({ name: '@agy-daddy/host', version: '1.1.1' }));

  const compatV1 = {
    schemaVersion: 1, id: 'third.compat', publisher: 'third', version: '1.0.0',
    displayName: 'Compat', engines: { agyDaddy: '^1.0.0' }, world: 'isolated', main: './index.js', permissions: []
  };
  const compatV2BadApi = { ...compatV1, version: '1.2.0', engines: { agyDaddy: '^99.0.0' } };
  const tgzCompatV1 = makePluginTgz(compatV1);
  const tgzCompatV2 = makePluginTgz(compatV2BadApi);

  const webV1 = {
    schemaVersion: 1, id: 'agy-daddy.web', publisher: 'agy-daddy', version: '1.0.0',
    displayName: 'Web', engines: { agyDaddy: '^1.0.0' }, world: 'isolated', main: './index.js', permissions: ['host:launch-args']
  };
  const webV11 = { ...webV1, version: '1.1.0' };
  const tgzWebV1 = makePluginTgz(webV1);
  const tgzWebV11 = makePluginTgz(webV11);

  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const port = server.address().port;
    if (p === '/@third%2Fcompat') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        name: '@third/compat',
        'dist-tags': { latest: '1.2.0' },
        versions: {
          '1.0.0': { dist: { tarball: `http://127.0.0.1:${port}/c1.tgz`, integrity: sha512Integrity(tgzCompatV1) } },
          '1.2.0': {
            agyDaddy: { engines: { agyDaddy: '^99.0.0' } },
            dist: { tarball: `http://127.0.0.1:${port}/c2.tgz`, integrity: sha512Integrity(tgzCompatV2) }
          }
        }
      }));
    }
    if (p === '/@agy-daddy%2Fplugin-web') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        name: '@agy-daddy/plugin-web',
        'dist-tags': { latest: '1.1.0' },
        versions: {
          '1.0.0': { dist: { tarball: `http://127.0.0.1:${port}/w1.tgz`, integrity: sha512Integrity(tgzWebV1) } },
          '1.1.0': { dist: { tarball: `http://127.0.0.1:${port}/w2.tgz`, integrity: sha512Integrity(tgzWebV11) } }
        }
      }));
    }
    if (p === '/@agy-daddy%2Fhost' || p === '/@agy-daddy%2Fregistry') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ name: p, 'dist-tags': { latest: '1.2.0' }, versions: { '1.2.0': { dist: {} } } }));
    }
    if (p === '/c1.tgz') return res.writeHead(200).end(tgzCompatV1);
    if (p === '/c2.tgz') return res.writeHead(200).end(tgzCompatV2);
    if (p === '/w1.tgz') return res.writeHead(200).end(tgzWebV1);
    if (p === '/w2.tgz') return res.writeHead(200).end(tgzWebV11);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const npmRegistryUrl = `http://127.0.0.1:${server.address().port}`;

  await installPlugin('npm:@third/compat@1.0.0', { stateDir, pluginsDir, npmRegistryUrl, trustLevel: 'T2' });
  await installPlugin('npm:@agy-daddy/plugin-web@1.0.0', {
    stateDir, pluginsDir, npmRegistryUrl, trustLevel: 'T0', grantedPermissions: ['host:launch-args']
  });

  // 1. HOST_API_INCOMPATIBLE blocks standalone plugin update
  const chkCompat = await checkUpdates({
    stateDir, pluginsDir, hostRoot: fakeHostRoot, targets: ['third.compat'], npmRegistryUrl, forceRefresh: true
  });
  assert.equal(chkCompat.targets['third.compat'].status, 'blocked');
  assert.equal(chkCompat.targets['third.compat'].blockReason, 'HOST_API_INCOMPATIBLE');
  const applyCompat = await applyUpdates({ targets: ['third.compat'], checkResult: chkCompat }, {
    stateDir, pluginsDir, hostRoot: fakeHostRoot, npmRegistryUrl
  });
  assert.equal(applyCompat.ok, false);
  assert.equal(applyCompat.results[0].errorCode, 'HOST_API_INCOMPATIBLE');

  // 2. npm-global writable=false blocks host update with UPDATE_FS_PERMISSION_DENIED
  const chkHostPerm = await checkUpdates({
    stateDir, pluginsDir, hostRoot: fakeHostRoot, targets: ['host'],
    npmRegistryUrl, installMode: 'npm-global', writable: false, forceRefresh: true, ignoreDebounce: true
  });
  assert.equal(chkHostPerm.targets.host.status, 'blocked');
  assert.equal(chkHostPerm.targets.host.blockReason, 'UPDATE_FS_PERMISSION_DENIED');

  // 3. agy-daddy.web self-update with trigger='web' + host:launch-args -> deferredReload & hostRestartRequired
  const daemon = new AgyDaddyDaemon({ stateDir, pluginsDir, npmRegistryUrl, skipInject: true });
  await daemon.start();
  t.after(async () => { await daemon.stop().catch(() => {}); });
  const webRes = await applyUpdates({ targets: ['agy-daddy.web'], trigger: 'web' }, {
    stateDir, pluginsDir, hostRoot: fakeHostRoot, npmRegistryUrl, daemon
  });
  assert.equal(webRes.ok, true);
  assert.equal(webRes.deferredReload, true);
  assert.equal(webRes.hostRestartRequired, true);
  assert.equal(readInstalledIndex({ stateDir }).plugins['agy-daddy.web'].version, '1.1.0');

  // 4. Network timeout -> 2 retries (total 3 attempts) + UPDATE_NETWORK_TIMEOUT
  let timeoutHits = 0;
  const slowFetch = (_url, init = {}) => new Promise((_resolve, reject) => {
    timeoutHits++;
    init.signal?.addEventListener('abort', () => reject(init.signal.reason || Object.assign(new Error('Aborted'), { name: 'AbortError' })));
  });
  const timeoutChk = await checkUpdates({
    stateDir, pluginsDir, hostRoot: fakeHostRoot, targets: ['host'],
    npmRegistryUrl: 'https://slow.example.test', fetch: slowFetch,
    checkTimeoutMs: 25, retryDelaysMs: [5, 5], forceRefresh: true, ignoreDebounce: true
  });
  assert.equal(timeoutHits, 3, 'Should perform 1 initial + 2 backoff retries on timeout');
  assert.equal(timeoutChk.errors[0].errorCode, 'UPDATE_NETWORK_TIMEOUT');

  // 5. Log rotation when exceeding 1000 lines
  const historyPath = path.join(stateDir, 'logs', 'update-history.jsonl');
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  const bulkLines = Array.from({ length: 1001 }, (_, i) => JSON.stringify({ timestamp: '2026-11-28T00:00:00.000Z', seq: i })).join('\n') + '\n';
  fs.writeFileSync(historyPath, bulkLines, 'utf8');
  appendUpdateHistory({ trigger: 'qa', targetId: 'host', outcome: 'succeeded' }, { stateDir });
  assert.equal(fs.existsSync(path.join(stateDir, 'logs', 'update-history.1.jsonl')), true);
  assert.equal(readUpdateHistory({ stateDir, limit: 5 })[0].trigger, 'qa');
});

test('QA-INT-03: CLI agy-daddy plugin rollback <id> 端到端回滚', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');

  const manV1 = {
    schemaVersion: 1, id: 'third.clirb', publisher: 'third', version: '1.0.0',
    displayName: 'CLI RB', engines: { agyDaddy: '^1.0.0' }, world: 'isolated', main: './index.js', permissions: []
  };
  const manV11 = { ...manV1, version: '1.1.0' };
  const tgzV1 = makePluginTgz(manV1);
  const tgzV11 = makePluginTgz(manV11);

  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const port = server.address().port;
    if (p === '/@third%2Fclirb') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        name: '@third/clirb',
        'dist-tags': { latest: '1.1.0' },
        versions: {
          '1.0.0': { dist: { tarball: `http://127.0.0.1:${port}/v1.tgz`, integrity: sha512Integrity(tgzV1) } },
          '1.1.0': { dist: { tarball: `http://127.0.0.1:${port}/v11.tgz`, integrity: sha512Integrity(tgzV11) } }
        }
      }));
    }
    if (p === '/v1.tgz') return res.writeHead(200).end(tgzV1);
    if (p === '/v11.tgz') return res.writeHead(200).end(tgzV11);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const regUrl = `http://127.0.0.1:${server.address().port}`;

  await installPlugin('npm:@third/clirb@1.0.0', { stateDir, pluginsDir, npmRegistryUrl: regUrl, trustLevel: 'T2' });

  const env = {
    ...process.env,
    AGY_DADDY_TEST_MODE: '1',
    AGY_DADDY_STATE_DIR: stateDir,
    AGY_DADDY_PLUGINS_DIR: pluginsDir
  };
  const updOut = await runCliAsync(['plugin', 'update', 'third.clirb', '--registry', regUrl, '--yes', '--json'], env);
  assert.equal(updOut.status, 0, updOut.stderr);
  assert.equal(readInstalledIndex({ stateDir }).plugins['third.clirb'].version, '1.1.0');

  const rbOut = await runCliAsync(['plugin', 'rollback', 'third.clirb', '--json'], env);
  assert.equal(rbOut.status, 0, rbOut.stderr);
  assert.equal(JSON.parse(rbOut.stdout).restoredVersion, '1.0.0');
  assert.equal(readInstalledIndex({ stateDir }).plugins['third.clirb'].version, '1.0.0');
});
