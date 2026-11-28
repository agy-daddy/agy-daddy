'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { createTarGzBuffer } = require('../src/core/tar');
const {
  installPlugin,
  linkPlugin,
  readInstalledIndex,
  encodeNpmPackagePath
} = require('../src/core/installer');
const {
  extractSemverFromTag,
  detectHostInstallMode,
  checkUpdates,
  getCachedUpdateStatus,
  readUpdateState
} = require('../src/core/update-checker');
const {
  acquireUpdateLock,
  releaseUpdateLock,
  appendUpdateHistory,
  readUpdateHistory,
  applyUpdates,
  rollbackUpdate,
  setPluginPinned,
  UpdateScheduler
} = require('../src/core/updater');
const { runUpdaterHelper } = require('../src/core/updater-helper');
const { AgyDaddyDaemon } = require('../src/core/daemon');
const { KNOWN_ANCHORS } = require('../src/contracts/constants');

const HOST_ROOT = path.resolve(__dirname, '..');

function makeTempDir(t, prefix = 'agy-upd-') {
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

test('encodeNpmPackagePath 保留 @scope%2Fname 格式且 extractSemverFromTag 剥离多形态前缀', () => {
  assert.equal(encodeNpmPackagePath('@agy-daddy/host'), '@agy-daddy%2Fhost');
  assert.equal(encodeNpmPackagePath('@third/my-plugin'), '@third%2Fmy-plugin');
  assert.equal(encodeNpmPackagePath('unscoped-pkg'), 'unscoped-pkg');

  assert.equal(extractSemverFromTag('v1.2.3'), '1.2.3');
  assert.equal(extractSemverFromTag('host@1.2.3', 'host'), '1.2.3');
  assert.equal(extractSemverFromTag('plugin-quota@1.2.3', 'plugin-quota'), '1.2.3');
  assert.equal(extractSemverFromTag('plugin-cli@1.2.3', 'plugin-quota'), null);
  assert.equal(extractSemverFromTag('registry@2.0.0-rc.1', 'registry'), '2.0.0-rc.1');
});

test('AC-01 & AC-03: npm 源检查/升级保留用户数据、支持 stable/next 通道、T2 禁止静默、pin 与 local 豁免', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const fakeHostRoot = path.join(root, 'host');
  fs.mkdirSync(fakeHostRoot, { recursive: true });
  fs.writeFileSync(path.join(fakeHostRoot, 'package.json'), JSON.stringify({ name: '@agy-daddy/host', version: '1.1.1' }));

  const t0ManV1 = {
    schemaVersion: 1,
    id: 'agy-daddy.samplet0',
    publisher: 'agy-daddy',
    version: '1.0.0',
    displayName: 'Sample T0',
    engines: { agyDaddy: '^1.0.0' },
    world: 'isolated',
    main: './index.js',
    permissions: ['dom:read']
  };
  const t0ManV11 = { ...t0ManV1, version: '1.1.0' };
  const t2ManV1 = {
    schemaVersion: 1,
    id: 'third.samplet2',
    publisher: 'third',
    version: '1.0.0',
    displayName: 'Sample T2',
    engines: { agyDaddy: '^1.0.0' },
    world: 'isolated',
    main: './index.js',
    permissions: ['dom:read']
  };
  const t2ManV12 = { ...t2ManV1, version: '1.2.0' };
  const t2ManV20Perm = { ...t2ManV1, version: '2.0.0', permissions: ['dom:read', 'process:spawn'] };

  const tgzT0V1 = makePluginTgz(t0ManV1);
  const tgzT0V11 = makePluginTgz(t0ManV11);
  const tgzT2V1 = makePluginTgz(t2ManV1);
  const tgzT2V12 = makePluginTgz(t2ManV12);
  const tgzT2V20 = makePluginTgz(t2ManV20Perm);

  let hostHits = 0;
  let etagMatches = 0;
  const requestedPaths = [];

  const server = http.createServer((req, res) => {
    const reqPath = req.url.split('?')[0];
    requestedPaths.push(reqPath);
    const port = server.address().port;

    if (reqPath === '/@agy-daddy%2Fhost') {
      hostHits++;
      if (req.headers['if-none-match'] === 'W/"host-1"') {
        etagMatches++;
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: 'W/"host-1"' });
      res.end(JSON.stringify({
        name: '@agy-daddy/host',
        'dist-tags': { latest: '1.1.1', next: '1.2.0-rc.1' },
        versions: {
          '1.1.1': { dist: { tarball: `http://127.0.0.1:${port}/host-1.1.1.tgz`, integrity: sha512Integrity(Buffer.from('h1')) } },
          '1.2.0-rc.1': { dist: { tarball: `http://127.0.0.1:${port}/host-1.2.0.tgz`, integrity: sha512Integrity(Buffer.from('h2')) } }
        }
      }));
      return;
    }
    if (reqPath === '/@agy-daddy%2Fregistry') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: '@agy-daddy/registry',
        'dist-tags': { latest: '1.1.1' },
        versions: { '1.1.1': { dist: { tarball: `http://127.0.0.1:${port}/reg.tgz`, integrity: sha512Integrity(Buffer.from('r1')) } } }
      }));
      return;
    }
    if (reqPath === '/@agy-daddy%2Fplugin-samplet0') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: '@agy-daddy/plugin-samplet0',
        'dist-tags': { latest: '1.1.0' },
        versions: {
          '1.0.0': { dist: { tarball: `http://127.0.0.1:${port}/t0-1.0.0.tgz`, integrity: sha512Integrity(tgzT0V1) } },
          '1.1.0': { dist: { tarball: `http://127.0.0.1:${port}/t0-1.1.0.tgz`, integrity: sha512Integrity(tgzT0V11) } }
        }
      }));
      return;
    }
    if (reqPath === '/@third%2Fsamplet2') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: '@third/samplet2',
        'dist-tags': { latest: '1.2.0', next: '2.0.0' },
        versions: {
          '1.0.0': { dist: { tarball: `http://127.0.0.1:${port}/t2-1.0.0.tgz`, integrity: sha512Integrity(tgzT2V1) } },
          '1.2.0': { dist: { tarball: `http://127.0.0.1:${port}/t2-1.2.0.tgz`, integrity: sha512Integrity(tgzT2V12) } },
          '2.0.0': { dist: { tarball: `http://127.0.0.1:${port}/t2-2.0.0.tgz`, integrity: sha512Integrity(tgzT2V20) } }
        }
      }));
      return;
    }
    if (reqPath === '/t0-1.0.0.tgz') return res.writeHead(200).end(tgzT0V1);
    if (reqPath === '/t0-1.1.0.tgz') return res.writeHead(200).end(tgzT0V11);
    if (reqPath === '/t2-1.0.0.tgz') return res.writeHead(200).end(tgzT2V1);
    if (reqPath === '/t2-1.2.0.tgz') return res.writeHead(200).end(tgzT2V12);
    if (reqPath === '/t2-2.0.0.tgz') return res.writeHead(200).end(tgzT2V20);
    res.writeHead(404).end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const npmRegistryUrl = `http://127.0.0.1:${server.address().port}`;

  // Install T0 1.0.0, T2 1.0.0, and local symlink plugin
  await installPlugin('npm:@agy-daddy/plugin-samplet0@1.0.0', {
    stateDir, pluginsDir, npmRegistryUrl, trustLevel: 'T0', grantedPermissions: ['dom:read']
  });
  await installPlugin('npm:@third/samplet2@1.0.0', {
    stateDir, pluginsDir, npmRegistryUrl, trustLevel: 'T2', grantedPermissions: ['dom:read']
  });
  await linkPlugin(path.join(HOST_ROOT, 'templates', 'plugin-template'), {
    stateDir, pluginsDir, grantedPermissions: ['dom:write', 'bridge:route']
  });

  // Persist user data that must survive upgrades
  const t0DataDir = path.join(stateDir, 'plugins-data', 'agy-daddy.samplet0');
  fs.mkdirSync(t0DataDir, { recursive: true });
  fs.writeFileSync(path.join(t0DataDir, 'settings.json'), JSON.stringify({ userPref: 'keep-me' }));

  const commonOpts = {
    stateDir,
    pluginsDir,
    hostRoot: fakeHostRoot,
    npmRegistryUrl,
    installMode: 'wrapper',
    writable: true
  };

  // 1. Check stable channel
  const chk1 = await checkUpdates({ ...commonOpts, channel: 'stable', forceRefresh: true });
  assert.equal(chk1.ok, true);
  assert.ok(requestedPaths.includes('/@agy-daddy%2Fhost'));
  assert.equal(chk1.targets.host.status, 'up_to_date');
  assert.equal(chk1.targets['agy-daddy.samplet0'].status, 'available');
  assert.equal(chk1.targets['agy-daddy.samplet0'].latestVersion, '1.1.0');
  assert.equal(chk1.targets['agy-daddy.samplet0'].autoSafeEligible, true);
  assert.equal(chk1.targets['third.samplet2'].status, 'available');
  assert.equal(chk1.targets['third.samplet2'].autoSafeEligible, false, 'T2 must never be autoSafeEligible');
  assert.equal(chk1.targets['example.hello'].status, 'local_exempt');

  // 2. Second check verifies ETag 304 and channel next
  const chkNext = await checkUpdates({ ...commonOpts, channel: 'next', forceRefresh: true, ignoreDebounce: true });
  assert.equal(etagMatches, 1);
  assert.equal(chkNext.targets.host.status, 'available');
  assert.equal(chkNext.targets.host.latestVersion, '1.2.0-rc.1');
  assert.equal(chkNext.targets['third.samplet2'].latestVersion, '2.0.0');

  // 3. Scheduler in auto-safe mode upgrades T0 only, never T2 or local
  const fakeDaemon = {
    stateDir,
    getHostSettings: () => ({ updateChannel: 'stable', autoUpdateMode: 'auto-safe', npmRegistryUrl }),
    reloadPlugin: async () => ({ ok: true }),
    getPluginHealth: () => ({ active: true, circuitOpen: false, lastError: null }),
    publishUpdatesState: () => {}
  };
  const scheduler = new UpdateScheduler({ ...commonOpts, daemon: fakeDaemon });
  await scheduler.runCycle('scheduled');

  const idxAfterAuto = readInstalledIndex({ stateDir });
  assert.equal(idxAfterAuto.plugins['agy-daddy.samplet0'].version, '1.1.0');
  assert.equal(idxAfterAuto.plugins['third.samplet2'].version, '1.0.0', 'T2 must NOT auto-update');
  assert.equal(JSON.parse(fs.readFileSync(path.join(t0DataDir, 'settings.json'), 'utf8')).userPref, 'keep-me');

  // 4. Pin blocks manual/batch update
  setPluginPinned('third.samplet2', true, { stateDir });
  const pinnedRes = await applyUpdates({ targets: ['third.samplet2'], channel: 'stable' }, commonOpts);
  assert.equal(pinnedRes.results[0].outcome, 'blocked');
  assert.equal(pinnedRes.results[0].errorCode, 'PLUGIN_PINNED');
  setPluginPinned('third.samplet2', false, { stateDir });

  // 5. Next channel major + new high-risk permission requires confirmation without mutating disk
  const permBlocked = await applyUpdates({ targets: ['third.samplet2'], channel: 'next' }, commonOpts);
  assert.equal(permBlocked.ok, false);
  assert.equal(permBlocked.needsPermissionConfirm, true);
  assert.equal(permBlocked.errorCode, 'PERMISSION_CONFIRMATION_REQUIRED');
  assert.deepEqual(permBlocked.confirmations[0].addedHighRiskPermissions, ['process:spawn']);
  assert.equal(readInstalledIndex({ stateDir }).plugins['third.samplet2'].version, '1.0.0');

  // 6. Explicitly granting permission + allowMajor succeeds
  const permApproved = await applyUpdates({
    targets: ['third.samplet2'],
    channel: 'next',
    grantedPermissions: { 'third.samplet2': ['process:spawn'] },
    allowMajor: true
  }, commonOpts);
  assert.equal(permApproved.ok, true);
  assert.equal(readInstalledIndex({ stateDir }).plugins['third.samplet2'].version, '2.0.0');
});

test('AC-02: GitHub Release (release-manifest.json)、分支 Commit 更新与 Git 脏工作区硬阻断', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const dirtyRepo = path.join(root, 'dirty-host');
  const thirdGitRepo = path.join(root, 'third-git-plugin');

  // Setup dirty git repo for host
  fs.mkdirSync(dirtyRepo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: dirtyRepo });
  execFileSync('git', ['config', 'user.email', 'test@agy.local'], { cwd: dirtyRepo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dirtyRepo });
  fs.writeFileSync(path.join(dirtyRepo, 'package.json'), JSON.stringify({ name: '@agy-daddy/host', version: '1.1.1' }));
  execFileSync('git', ['add', '.'], { cwd: dirtyRepo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dirtyRepo });
  fs.writeFileSync(path.join(dirtyRepo, 'dirty.txt'), 'uncommitted');

  const dirtyInfo = detectHostInstallMode({ stateDir, hostRoot: dirtyRepo });
  assert.equal(dirtyInfo.installMode, 'git');
  assert.equal(dirtyInfo.dirtyWorktree, true);

  const dirtyApplyRes = await applyUpdates({
    targets: ['host'],
    checkResult: {
      targets: {
        host: { targetId: 'host', kind: 'host', status: 'available', currentVersion: '1.1.1', latestVersion: '1.2.0' }
      },
      summary: { availableCount: 1 }
    }
  }, {
    stateDir,
    pluginsDir,
    hostRoot: dirtyRepo
  });
  assert.equal(dirtyApplyRes.ok, false);
  assert.equal(dirtyApplyRes.results[0].errorCode, 'DIRTY_WORKTREE');
  assert.equal(fs.readFileSync(path.join(dirtyRepo, 'dirty.txt'), 'utf8'), 'uncommitted');

  // Setup 3rd-party local git repo for commit-SHA fallback check & upgrade
  fs.mkdirSync(thirdGitRepo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: thirdGitRepo });
  execFileSync('git', ['config', 'user.email', 'test@agy.local'], { cwd: thirdGitRepo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: thirdGitRepo });
  const gitMan = {
    schemaVersion: 1,
    id: 'third.committest',
    publisher: 'third',
    version: '1.0.0',
    displayName: 'Commit Test',
    engines: { agyDaddy: '^1.0.0' },
    world: 'isolated',
    main: './index.js',
    permissions: []
  };
  fs.writeFileSync(path.join(thirdGitRepo, 'agy-plugin.json'), JSON.stringify(gitMan));
  fs.writeFileSync(path.join(thirdGitRepo, 'index.js'), 'module.exports = { v: 1 };');
  execFileSync('git', ['add', '.'], { cwd: thirdGitRepo });
  execFileSync('git', ['commit', '-m', 'c1'], { cwd: thirdGitRepo });

  await installPlugin(`git:file://${thirdGitRepo}#main`, { stateDir, pluginsDir, trustLevel: 'T2' });
  const sha1 = readInstalledIndex({ stateDir }).plugins['third.committest'].commitSha;

  fs.writeFileSync(path.join(thirdGitRepo, 'index.js'), 'module.exports = { v: 2 };');
  execFileSync('git', ['add', '.'], { cwd: thirdGitRepo });
  execFileSync('git', ['commit', '-m', 'c2'], { cwd: thirdGitRepo });
  const sha2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: thirdGitRepo, encoding: 'utf8' }).trim();
  assert.notEqual(sha1, sha2);

  // Mock GitHub release-manifest.json fetch for host
  const wrapperHost = path.join(root, 'wrapper-host');
  fs.mkdirSync(wrapperHost, { recursive: true });
  fs.writeFileSync(path.join(wrapperHost, 'package.json'), JSON.stringify({ name: '@agy-daddy/host', version: '1.1.1' }));
  fs.writeFileSync(path.join(wrapperHost, '.install-meta.json'), JSON.stringify({ installMode: 'wrapper', wrapperVersion: '1.0.0' }));

  const mockFetch = async (url) => {
    if (url.includes('/repos/agy-daddy/agy-daddy/releases')) {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        arrayBuffer: async () => Buffer.from(JSON.stringify([{
          tag_name: 'v1.2.0',
          draft: false,
          prerelease: false,
          html_url: 'https://github.com/agy-daddy/agy-daddy/releases/tag/v1.2.0',
          tarball_url: 'https://github.com/agy-daddy/agy-daddy/archive/v1.2.0.tar.gz',
          assets: [{ name: 'release-manifest.json', browser_download_url: 'https://mock.gh/release-manifest.json' }]
        }]))
      };
    }
    if (url === 'https://mock.gh/release-manifest.json') {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        arrayBuffer: async () => Buffer.from(JSON.stringify({
          wrapperMinVersion: '1.1.0',
          packages: [{ name: '@agy-daddy/host', dirName: 'agy-daddy-host', version: '1.2.0' }]
        }))
      };
    }
    return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => Buffer.alloc(0) };
  };

  const ghChk = await checkUpdates({
    stateDir,
    pluginsDir,
    hostRoot: wrapperHost,
    targets: ['host', 'third.committest'],
    sourcePreference: 'github',
    fetch: mockFetch,
    forceRefresh: true
  });
  assert.equal(ghChk.targets.host.latestVersion, '1.2.0');
  assert.equal(ghChk.targets.host.wrapperUpdateRecommended, true);
  assert.equal(ghChk.targets.host.wrapperMinVersion, '1.1.0');
  assert.equal(ghChk.targets['third.committest'].status, 'available');
  assert.equal(ghChk.targets['third.committest'].latestCommit, sha2);

  const gitUpd = await applyUpdates({
    targets: ['third.committest'],
    checkResult: ghChk
  }, { stateDir, pluginsDir, hostRoot: wrapperHost });
  assert.equal(gitUpd.ok, true);
  assert.equal(readInstalledIndex({ stateDir }).plugins['third.committest'].commitSha, sha2);
});

test('AC-04: sha512 校验失败、路径穿越拦截、更新锁互斥、以及插件热重载异常自动回滚', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');

  // 1. Update lock busy + stale recovery
  const lock = acquireUpdateLock(stateDir, { runId: 'r1', trigger: 'test', targets: ['all'] });
  assert.throws(() => acquireUpdateLock(stateDir, { runId: 'r2' }), (e) => e.code === 'UPDATE_LOCK_BUSY');
  releaseUpdateLock(stateDir, 'r1');
  fs.writeFileSync(path.join(stateDir, 'update.lock'), JSON.stringify({ pid: 99999999, runId: 'dead', startedAtMs: Date.now() }));
  const recovered = acquireUpdateLock(stateDir, { runId: 'r3' });
  assert.equal(recovered.runId, 'r3');
  releaseUpdateLock(stateDir, 'r3');

  // 2. Tampered tarball -> UPDATE_INTEGRITY_MISMATCH + staging cleaned
  const validV1 = makePluginTgz({
    schemaVersion: 1, id: 'third.crasher', publisher: 'third', version: '1.0.0',
    displayName: 'Crasher', engines: { agyDaddy: '^1.0.0' }, world: 'isolated', main: './index.js', permissions: []
  });
  const tamperedV2 = makePluginTgz({
    schemaVersion: 1, id: 'third.crasher', publisher: 'third', version: '1.1.0',
    displayName: 'Crasher', engines: { agyDaddy: '^1.0.0' }, world: 'isolated', main: './index.js', permissions: []
  }, { 'index.js': 'module.exports = { activate() { throw new Error("BOOM_ON_ACTIVATE"); } };' });

  const evilTraversalTgz = createTarGzBuffer({
    'package.json': '{"name":"evil","version":"1.1.0"}',
    '../../evil.txt': 'pwn'
  });

  let serveTamperedMismatch = true;
  let serveTraversal = false;
  const server = http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    const port = server.address().port;
    if (p === '/@third%2Fcrasher') {
      const targetBuf = serveTraversal ? evilTraversalTgz : tamperedV2;
      const reportedIntegrity = serveTamperedMismatch ? sha512Integrity(Buffer.from('wrong-bytes')) : sha512Integrity(targetBuf);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: '@third/crasher',
        'dist-tags': { latest: '1.1.0' },
        versions: {
          '1.0.0': { dist: { tarball: `http://127.0.0.1:${port}/v1.tgz`, integrity: sha512Integrity(validV1) } },
          '1.1.0': { dist: { tarball: `http://127.0.0.1:${port}/v2.tgz`, integrity: reportedIntegrity } }
        }
      }));
      return;
    }
    if (p === '/v1.tgz') return res.writeHead(200).end(validV1);
    if (p === '/v2.tgz') return res.writeHead(200).end(serveTraversal ? evilTraversalTgz : tamperedV2);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const npmRegistryUrl = `http://127.0.0.1:${server.address().port}`;

  await installPlugin('npm:@third/crasher@1.0.0', { stateDir, pluginsDir, npmRegistryUrl, trustLevel: 'T2' });

  // Mismatch check
  const failMismatch = await applyUpdates({ targets: ['third.crasher'] }, { stateDir, pluginsDir, npmRegistryUrl });
  assert.equal(failMismatch.ok, false);
  assert.equal(failMismatch.results[0].errorCode, 'UPDATE_INTEGRITY_MISMATCH');
  assert.equal(readInstalledIndex({ stateDir }).plugins['third.crasher'].version, '1.0.0');
  assert.equal(fs.readdirSync(path.join(pluginsDir, '.staging')).length, 0);

  // Path traversal check
  serveTamperedMismatch = false;
  serveTraversal = true;
  const failTraversal = await applyUpdates({ targets: ['third.crasher'] }, { stateDir, pluginsDir, npmRegistryUrl });
  assert.equal(failTraversal.ok, false);
  assert.equal(failTraversal.results[0].errorCode, 'UNSAFE_PATH_TRAVERSAL');
  assert.equal(fs.readdirSync(path.join(pluginsDir, '.staging')).length, 0);

  // Valid v1.1.0 that crashes on daemon reload -> auto-rollback within 5s & record lastFailedVersion
  serveTraversal = false;
  const daemon = new AgyDaddyDaemon({ stateDir, pluginsDir, skipInject: true });
  await daemon.start();
  t.after(async () => { await daemon.stop().catch(() => {}); });

  const rbRes = await applyUpdates({ targets: ['third.crasher'] }, {
    stateDir,
    pluginsDir,
    npmRegistryUrl,
    daemon,
    initialProbeMs: 30
  });
  assert.equal(rbRes.ok, false);
  assert.equal(rbRes.results[0].outcome, 'rolled_back');
  assert.equal(rbRes.results[0].errorCode, 'UPDATE_ROLLBACK_TRIGGERED');
  assert.equal(readInstalledIndex({ stateDir }).plugins['third.crasher'].version, '1.0.0');
  assert.equal(daemon.activePlugins.get('third.crasher')?.manifest?.version, '1.0.0');
  assert.equal(readUpdateState({ stateDir }).targets['third.crasher'].lastFailedVersion, '1.1.0');
});

test('Wrapper 底座交接 updater-helper：成功替换与 10s 探活失败自动还原 .prev', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const installDir = path.join(root, 'host-install');
  const stagingDir = `${installDir}.staging.1`;
  const backupDir = `${installDir}.prev`;
  fs.mkdirSync(path.join(installDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(installDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(installDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(installDir, 'package.json'), JSON.stringify({ name: '@agy-daddy/host', version: '1.1.1' }));

  fs.mkdirSync(path.join(stagingDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(stagingDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(stagingDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(stagingDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(stagingDir, 'package.json'), JSON.stringify({ name: '@agy-daddy/host', version: '1.2.0' }));
  fs.writeFileSync(path.join(stagingDir, 'bin', 'agy-daddy.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(stagingDir, 'src', 'cli.js'), '// cli\n');
  fs.writeFileSync(path.join(stagingDir, 'dist', 'host-renderer.js'), '// renderer\n');
  const validAnchors = { schemaVersion: 1, anchors: Object.fromEntries(KNOWN_ANCHORS.map((a) => [a, { versions: [] }])) };
  fs.writeFileSync(path.join(stagingDir, 'data', 'anchors.json'), JSON.stringify(validAnchors));

  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.live-session.json'), JSON.stringify({ port: 19999, pid: 12345 }));

  // 1. Failing health probe rolls back to 1.1.1
  let launches = 0;
  const failPlan = {
    mode: 'apply',
    runId: 'h-fail',
    stateDir,
    installDir,
    stagingDir,
    backupDir,
    fromVersion: '1.1.1',
    targetVersion: '1.2.0',
    supervisorMode: 'live',
    launchCommand: { bin: process.execPath, args: ['-v'] },
    healthTimeoutMs: 150,
    lockPath: path.join(stateDir, 'update.lock'),
    historyPath: path.join(stateDir, 'logs', 'update-history.jsonl'),
    stateFilePath: path.join(stateDir, 'update-state.json'),
    cleanupRunDir: false
  };
  const failRes = await runUpdaterHelper(failPlan, {
    spawnLaunch: () => { launches++; return { pid: 12345, once() {} }; },
    fetchHealth: async () => null,
    isPidAlive: () => false,
    sleep: async () => new Promise((r) => setTimeout(r, 20))
  });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.rolledBack, true);
  assert.equal(failRes.errorCode, 'UPDATE_ROLLBACK_TRIGGERED');
  assert.equal(launches, 2, 'Should launch new daemon once, then relaunch old daemon after rollback');
  assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8')).version, '1.1.1');
  assert.equal(readUpdateState({ stateDir }).targets.host.lastFailedVersion, '1.2.0');

  // 2. Healthy probe commits 1.2.0 and syncs stateDir/anchors.json
  fs.mkdirSync(path.join(stagingDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(stagingDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(stagingDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(stagingDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(stagingDir, 'package.json'), JSON.stringify({ name: '@agy-daddy/host', version: '1.2.0' }));
  fs.writeFileSync(path.join(stagingDir, 'data', 'anchors.json'), JSON.stringify(validAnchors));
  const okRes = await runUpdaterHelper({ ...failPlan, runId: 'h-ok', healthTimeoutMs: 500 }, {
    spawnLaunch: () => ({ pid: 22222, once() {} }),
    fetchHealth: async () => ({ daemon: { pid: 22222 } }),
    isPidAlive: () => false,
    sleep: async () => new Promise((r) => setTimeout(r, 10))
  });
  assert.equal(okRes.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8')).version, '1.2.0');
  assert.equal(fs.existsSync(path.join(stateDir, 'anchors.json')), true);

  // 3. Rollback host manually via rollbackUpdate inline
  const rbHost = await rollbackUpdate({ target: 'host' }, {
    stateDir,
    hostRoot: installDir,
    handoffMode: 'inline',
    supervisorMode: 'none'
  });
  assert.equal(rbHost.ok, true);
  assert.equal(rbHost.restoredVersion, '1.1.1');
});

test('AC-05: 瞬态退避重试、403/429 限流零重试与冷却、@agy-daddy/registry 锚点更新、脱敏日志', async (t) => {
  const root = makeTempDir(t);
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  const fakeHostRoot = path.join(root, 'host');
  fs.mkdirSync(fakeHostRoot, { recursive: true });
  fs.writeFileSync(path.join(fakeHostRoot, 'package.json'), JSON.stringify({ name: '@agy-daddy/host', version: '1.1.1' }));

  const validAnchors = { schemaVersion: 1, anchors: Object.fromEntries(KNOWN_ANCHORS.map((a) => [a, { versions: [] }])) };
  const regTgz = createTarGzBuffer({
    'package.json': JSON.stringify({ name: '@agy-daddy/registry', version: '1.2.0' }),
    'anchors.json': JSON.stringify(validAnchors)
  });

  let regAttempts = 0;
  let ghHits = 0;
  const mockFetch = async (url) => {
    if (url.includes('/@agy-daddy%2Fregistry')) {
      regAttempts++;
      if (regAttempts <= 2) {
        return { ok: false, status: 503, headers: new Map(), arrayBuffer: async () => Buffer.alloc(0) };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        arrayBuffer: async () => Buffer.from(JSON.stringify({
          name: '@agy-daddy/registry',
          'dist-tags': { latest: '1.2.0' },
          versions: {
            '1.2.0': { dist: { tarball: 'http://127.0.0.1:9999/reg-1.2.0.tgz', integrity: sha512Integrity(regTgz) } }
          }
        }))
      };
    }
    if (url === 'http://127.0.0.1:9999/reg-1.2.0.tgz') {
      return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => regTgz };
    }
    if (url.includes('api.github.com')) {
      ghHits++;
      return {
        ok: false,
        status: 403,
        headers: new Map([['x-ratelimit-remaining', '0'], ['x-ratelimit-reset', String(Math.floor((Date.now() + 60000) / 1000))]]),
        text: async () => 'API rate limit exceeded'
      };
    }
    return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => Buffer.alloc(0) };
  };

  // Registry succeeds on 3rd attempt (after 2 retries on 503)
  const chkReg = await checkUpdates({
    stateDir, pluginsDir, hostRoot: fakeHostRoot, targets: ['registry'],
    fetch: mockFetch, retryDelaysMs: [5, 5], forceRefresh: true
  });
  assert.equal(regAttempts, 3);
  assert.equal(chkReg.targets.registry.status, 'available');
  assert.equal(chkReg.targets.registry.latestVersion, '1.2.0');

  const regApply = await applyUpdates({ targets: ['registry'], checkResult: chkReg }, {
    stateDir, pluginsDir, hostRoot: fakeHostRoot, fetch: mockFetch, retryDelaysMs: [5, 5]
  });
  assert.equal(regApply.ok, true);
  assert.equal(fs.existsSync(path.join(stateDir, 'anchors.json')), true);
  assert.equal(getCachedUpdateStatus({ stateDir, pluginsDir, hostRoot: fakeHostRoot }).anchorsVersion, '1.2.0');

  // GitHub 403 rate limit -> 0 retries, cooldown skips subsequent hit
  const chkGh1 = await checkUpdates({
    stateDir, pluginsDir, hostRoot: fakeHostRoot, targets: ['host'],
    sourcePreference: 'github', fetch: mockFetch, retryDelaysMs: [5, 5], forceRefresh: true, ignoreDebounce: true
  });
  assert.equal(ghHits, 1, 'Rate limit must have 0 retries');
  assert.equal(chkGh1.errors[0].errorCode, 'UPDATE_RATE_LIMITED');

  await checkUpdates({
    stateDir, pluginsDir, hostRoot: fakeHostRoot, targets: ['host'],
    sourcePreference: 'github', fetch: mockFetch, retryDelaysMs: [5, 5], forceRefresh: true, ignoreDebounce: true
  });
  assert.equal(ghHits, 1, 'Active cooldown must skip remote call');

  // Log sanitization
  appendUpdateHistory({
    trigger: 'cli',
    targetId: 'host',
    sourceUrl: 'https://user:supersecret@registry.example.com/pkg?token=abc123&t=xyz',
    errorMessage: 'Auth failed Bearer topsecret_jwt ghp_1234567890abcdef npm_9876543210'
  }, { stateDir });
  const hist = readUpdateHistory({ stateDir, limit: 5 });
  const last = hist[0];
  assert.equal(last.sourceUrl.includes('supersecret'), false);
  assert.equal(last.sourceUrl.includes('abc123'), false);
  assert.equal(last.errorMessage.includes('topsecret_jwt'), false);
  assert.equal(last.errorMessage.includes('ghp_1234567890abcdef'), false);
  assert.equal(last.errorMessage.includes('npm_9876543210'), false);
});
