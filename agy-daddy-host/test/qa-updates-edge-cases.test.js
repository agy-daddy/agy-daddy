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
const { installPlugin, linkPlugin, readInstalledIndex } = require('../src/core/installer');
const { checkUpdates, readUpdateState } = require('../src/core/update-checker');
const {
  appendUpdateHistory,
  readUpdateHistory,
  applyUpdates
} = require('../src/core/updater');
const { AgyDaddyDaemon } = require('../src/core/daemon');
const { MemoryTrayBackend, TrayManager, UPDATE_TRAY_MENU_IDS } = require('../src/core/tray-manager');
const { KNOWN_ANCHORS } = require('../src/contracts/constants');

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

  // Wait for initial scheduler cycle (25ms + apply) to settle completely
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const idx = readInstalledIndex({ stateDir });
    if (
      idx.plugins['agy-daddy.qat0']?.version === '1.1.0' &&
      !daemon.updateScheduler.runningCheck &&
      !daemon.updateScheduler.applyingUpdate
    ) {
      break;
    }
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

test('QA-INT-04: 真实 release-manifest.json（dir/tarball/sha512）下 GitHub 源升级 host、registry 与 T0 插件', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const hostInstallDir = path.join(root, 'host-install');
  fs.mkdirSync(hostInstallDir, { recursive: true });
  fs.writeFileSync(path.join(hostInstallDir, 'package.json'), JSON.stringify({ name: '@agy-daddy/host', version: '1.1.1' }));
  fs.writeFileSync(path.join(hostInstallDir, '.install-meta.json'), JSON.stringify({ installMode: 'wrapper', wrapperVersion: '1.0.0' }));

  const validAnchors = { schemaVersion: 1, anchors: Object.fromEntries(KNOWN_ANCHORS.map((a) => [a, { versions: [] }])) };
  const hostTgz = createTarGzBuffer({
    'package.json': JSON.stringify({ name: '@agy-daddy/host', version: '1.2.0' }),
    'bin/agy-daddy.js': '#!/usr/bin/env node\n',
    'src/cli.js': '// cli\n',
    'dist/host-renderer.js': '// renderer\n',
    'data/anchors.json': JSON.stringify(validAnchors)
  });
  const regTgz = createTarGzBuffer({
    'package.json': JSON.stringify({ name: '@agy-daddy/registry', version: '1.2.0' }),
    'anchors.json': JSON.stringify(validAnchors)
  });

  // Real GitHub monorepo source archive fallback (top-level repo folder + gitignored dist/)
  const ghSourceArchive = createTarGzBuffer({
    'agy-daddy-host/package.json': JSON.stringify({ name: '@agy-daddy/host', version: '1.2.0' }),
    'agy-daddy-host/bin/agy-daddy.js': '#!/usr/bin/env node\n',
    'agy-daddy-host/src/cli.js': '// cli\n',
    'agy-daddy-host/src/renderer/styles.css': '.x { color: inherit; }\n',
    'agy-daddy-host/src/renderer/host-runtime.js': 'const ok = true;\n',
    'agy-daddy-host/scripts/build-renderer.js': fs.readFileSync(path.join(HOST_ROOT, 'scripts', 'build-renderer.js'), 'utf8'),
    'agy-daddy-host/data/anchors.json': JSON.stringify(validAnchors),
    'agy-daddy-registry/package.json': JSON.stringify({ name: '@agy-daddy/registry', version: '1.2.0' }),
    'agy-daddy-registry/anchors.json': JSON.stringify(validAnchors)
  }, 'agy-daddy-1.2.0');

  // Setup local git repo for T0 plugin with subpath
  const pluginRepo = path.join(root, 'plugin-repo');
  fs.mkdirSync(path.join(pluginRepo, 'agy-daddy-plugin-quota'), { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: pluginRepo });
  execFileSync('git', ['config', 'user.email', 'qa@test.local'], { cwd: pluginRepo });
  execFileSync('git', ['config', 'user.name', 'QA'], { cwd: pluginRepo });
  const quotaMan = {
    schemaVersion: 1, id: 'agy-daddy.quota', publisher: 'agy-daddy', version: '1.1.1',
    displayName: 'Quota', engines: { agyDaddy: '^1.0.0' }, world: 'isolated', main: './index.js', permissions: []
  };
  fs.writeFileSync(path.join(pluginRepo, 'agy-daddy-plugin-quota', 'agy-plugin.json'), JSON.stringify(quotaMan));
  fs.writeFileSync(path.join(pluginRepo, 'agy-daddy-plugin-quota', 'index.js'), 'module.exports = {};');
  execFileSync('git', ['add', '.'], { cwd: pluginRepo });
  execFileSync('git', ['commit', '-m', 'v1.1.1'], { cwd: pluginRepo });
  quotaMan.version = '1.2.0';
  fs.writeFileSync(path.join(pluginRepo, 'agy-daddy-plugin-quota', 'agy-plugin.json'), JSON.stringify(quotaMan));
  execFileSync('git', ['add', '.'], { cwd: pluginRepo });
  execFileSync('git', ['commit', '-m', 'v1.2.0'], { cwd: pluginRepo });
  execFileSync('git', ['tag', 'v1.2.0'], { cwd: pluginRepo });

  await installPlugin(`git:file://${pluginRepo}#main:agy-daddy-plugin-quota`, { stateDir, pluginsDir, trustLevel: 'T0' });
  const idxPath = path.join(stateDir, 'installed-plugins.json');
  const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  idx.plugins['agy-daddy.quota'].version = '1.1.1';
  idx.plugins['agy-daddy.quota'].sourceSpec = 'github:agy-daddy/agy-daddy#main:agy-daddy-plugin-quota';
  fs.writeFileSync(idxPath, JSON.stringify(idx));

  const realManifest = {
    schemaVersion: 1,
    releaseTag: 'v1.2.0',
    npmRegistryUrl: 'https://registry.npmjs.org',
    packages: [
      { name: '@agy-daddy/host', version: '1.2.0', dir: 'agy-daddy-host', tarball: 'agy-daddy-host-1.2.0.tgz', sha512: sha512Integrity(hostTgz) },
      { name: '@agy-daddy/registry', version: '1.2.0', dir: 'agy-daddy-registry', tarball: 'agy-daddy-registry-1.2.0.tgz', sha512: sha512Integrity(regTgz) },
      { name: '@agy-daddy/plugin-quota', version: '1.2.0', dir: 'agy-daddy-plugin-quota', tarball: 'agy-daddy-plugin-quota-1.2.0.tgz', sha512: sha512Integrity(Buffer.from('pkg-tgz')) }
    ]
  };

  let includeTgzAssets = false;
  const mockFetch = async (url) => {
    if (url.includes('/repos/agy-daddy/agy-daddy/releases')) {
      const assets = [{ name: 'release-manifest.json', browser_download_url: 'https://mock.gh/release-manifest.json' }];
      if (includeTgzAssets) {
        assets.push({ name: 'agy-daddy-host-1.2.0.tgz', browser_download_url: 'https://mock.gh/agy-daddy-host-1.2.0.tgz' });
        assets.push({ name: 'agy-daddy-registry-1.2.0.tgz', browser_download_url: 'https://mock.gh/agy-daddy-registry-1.2.0.tgz' });
      }
      return {
        ok: true, status: 200, headers: new Map(),
        arrayBuffer: async () => Buffer.from(JSON.stringify([{
          tag_name: 'v1.2.0', draft: false, prerelease: false,
          html_url: 'https://github.com/agy-daddy/agy-daddy/releases/tag/v1.2.0',
          tarball_url: 'https://mock.gh/source-v1.2.0.tar.gz',
          assets
        }]))
      };
    }
    if (url === 'https://mock.gh/release-manifest.json') {
      return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => Buffer.from(JSON.stringify(realManifest)) };
    }
    if (url === 'https://mock.gh/agy-daddy-host-1.2.0.tgz') {
      return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => hostTgz };
    }
    if (url === 'https://mock.gh/agy-daddy-registry-1.2.0.tgz') {
      return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => regTgz };
    }
    if (url === 'https://mock.gh/source-v1.2.0.tar.gz') {
      return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => ghSourceArchive };
    }
    return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => Buffer.alloc(0) };
  };

  // A. Monorepo GitHub source archive fallback (builds host-renderer.js + extracts registry + upgrades T0 plugin)
  const chkFallback = await checkUpdates({
    stateDir, pluginsDir, hostRoot: hostInstallDir,
    targets: ['host', 'registry', 'agy-daddy.quota'],
    sourcePreference: 'github', installMode: 'wrapper', writable: true, fetch: mockFetch, forceRefresh: true
  });
  assert.equal(chkFallback.targets.host.archiveSubpath, 'agy-daddy-host');
  assert.equal(chkFallback.targets.host.integrity, null);
  assert.equal(chkFallback.targets.registry.archiveSubpath, 'agy-daddy-registry');

  const applyHostFallback = await applyUpdates({ targets: ['host'], checkResult: chkFallback }, {
    stateDir, pluginsDir, hostRoot: hostInstallDir, installMode: 'wrapper', writable: true,
    fetch: mockFetch, handoffMode: 'inline', supervisorMode: 'none'
  });
  assert.equal(applyHostFallback.ok, true, JSON.stringify(applyHostFallback));
  assert.equal(JSON.parse(fs.readFileSync(path.join(hostInstallDir, 'package.json'), 'utf8')).version, '1.2.0');
  assert.equal(fs.existsSync(path.join(hostInstallDir, 'dist', 'host-renderer.js')), true);

  const applyRegAndPlugin = await applyUpdates({ targets: ['registry', 'agy-daddy.quota'], checkResult: chkFallback }, {
    stateDir, pluginsDir, hostRoot: hostInstallDir, fetch: mockFetch,
    gitRunner: (args) => {
      if (args[0] === 'clone') {
        const dest = args[args.length - 1];
        execFileSync('git', ['clone', '--depth', '1', '--branch', args[4], `file://${pluginRepo}`, dest]);
        return '';
      }
      return execFileSync('git', args.slice(0, -1), { cwd: args[args.length - 1], encoding: 'utf8' }).trim();
    }
  });
  assert.equal(applyRegAndPlugin.ok, true);
  assert.equal(fs.existsSync(path.join(stateDir, 'anchors.json')), true);
  assert.equal(readInstalledIndex({ stateDir }).plugins['agy-daddy.quota'].version, '1.2.0');

  // B. Release with matching .tgz assets uses asset URL + SHA-512 verification
  includeTgzAssets = true;
  fs.writeFileSync(path.join(hostInstallDir, 'package.json'), JSON.stringify({ name: '@agy-daddy/host', version: '1.1.1' }));
  const chkAsset = await checkUpdates({
    stateDir, pluginsDir, hostRoot: hostInstallDir,
    targets: ['host'], sourcePreference: 'github', installMode: 'wrapper', writable: true,
    fetch: mockFetch, forceRefresh: true, ignoreDebounce: true
  });
  assert.equal(chkAsset.targets.host.tarballUrl, 'https://mock.gh/agy-daddy-host-1.2.0.tgz');
  assert.equal(chkAsset.targets.host.integrity, sha512Integrity(hostTgz));
  const applyHostAsset = await applyUpdates({ targets: ['host'], checkResult: chkAsset }, {
    stateDir, pluginsDir, hostRoot: hostInstallDir, installMode: 'wrapper', writable: true,
    fetch: mockFetch, handoffMode: 'inline', supervisorMode: 'none'
  });
  assert.equal(applyHostAsset.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(hostInstallDir, 'package.json'), 'utf8')).version, '1.2.0');
});

test('QA-INT-05: update-state.json sourceUrl 脱敏且 daemon /host/updates/apply 保留失败态 ok=false', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');

  const v1 = {
    schemaVersion: 1, id: 'third.okpreserve', publisher: 'third', version: '1.0.0',
    displayName: 'OK Preserve', engines: { agyDaddy: '^1.0.0' }, world: 'isolated', main: './index.js', permissions: []
  };
  const v2Crash = { ...v1, version: '1.1.0' };
  const tgz1 = makePluginTgz(v1);
  const tgz2 = makePluginTgz(v2Crash, { 'index.js': 'module.exports = { activate() { throw new Error("CRASH"); } };' });

  const srv = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const port = srv.address().port;
    if (p === '/@third%2Fokpreserve') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        name: '@third/okpreserve', 'dist-tags': { latest: '1.1.0' },
        versions: {
          '1.0.0': { dist: { tarball: `http://127.0.0.1:${port}/1.tgz`, integrity: sha512Integrity(tgz1) } },
          '1.1.0': { dist: { tarball: `http://127.0.0.1:${port}/2.tgz`, integrity: sha512Integrity(tgz2) } }
        }
      }));
    }
    if (p === '/1.tgz') return res.writeHead(200).end(tgz1);
    if (p === '/2.tgz') return res.writeHead(200).end(tgz2);
    res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const regUrl = `http://127.0.0.1:${srv.address().port}`;

  await installPlugin('npm:@third/okpreserve@1.0.0', { stateDir, pluginsDir, npmRegistryUrl: regUrl, trustLevel: 'T2' });

  // Verify sourceUrl in update-state.json redacts embedded credentials
  await checkUpdates({
    stateDir, pluginsDir,
    targets: ['third.okpreserve'],
    npmRegistryUrl: 'https://user:secretpass@registry.example.test',
    fetch: async () => ({
      ok: true, status: 200, headers: new Map(),
      arrayBuffer: async () => Buffer.from(JSON.stringify({
        name: '@third/okpreserve', 'dist-tags': { latest: '1.1.0' }, versions: { '1.1.0': { dist: {} } }
      }))
    }),
    forceRefresh: true
  });
  const savedState = readUpdateState({ stateDir });
  assert.equal(savedState.targets['third.okpreserve'].sourceUrl.includes('secretpass'), false);

  // Verify Daemon /host/updates/apply preserves ok: false on plugin auto-rollback
  const daemon = new AgyDaddyDaemon({ stateDir, pluginsDir, npmRegistryUrl: regUrl, skipInject: true, initialProbeMs: 30 });
  const started = await daemon.start();
  t.after(async () => { await daemon.stop().catch(() => {}); });
  const resp = await fetch(`http://127.0.0.1:${started.port}/host/updates/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AGY-Host-Token': started.hostToken },
    body: JSON.stringify({ targets: ['third.okpreserve'], npmRegistryUrl: regUrl })
  }).then((r) => r.json());
  assert.equal(resp.ok, false);
  assert.equal(resp.results[0].outcome, 'rolled_back');
  assert.equal(resp.results[0].errorCode, 'UPDATE_ROLLBACK_TRIGGERED');
});
