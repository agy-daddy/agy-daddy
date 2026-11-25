'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFile, spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');

const { loadHealthAnchorsRegistry, resolveAnchorSelectors } = require('../src/core/anchors');
const { resolveActiveCdpTarget, inspectAntigravityHostProcess, readAntigravityVersion } = require('../src/core/cdp');
const { AgyDaddyDaemon } = require('../src/core/daemon');
const { runDoctor } = require('../src/core/doctor');
const { HostHealth, FAULT_CHANGED, UPGRADE_TAKEOVER_FAILED } = require('../src/core/health-snapshot');
const { CdpInjector } = require('../src/core/injector');
const { installAutoStart, installMacLauncherApp, isolateResidentEnv } = require('../src/core/lifecycle');
const { createLiveWatchdog } = require('../src/core/live-watchdog');
const { readHostHealthState } = require('../src/core/storage');

const execFileAsync = promisify(execFile);
const cli = path.resolve(__dirname, '../src/cli.js');
const sessionVars = ['ANTIGRAVITY_AGENT', 'ANTIGRAVITY_SESSION', 'AGY_SESSION_ID', 'VSCODE_IPC_HOOK_CLI', 'TERM_PROGRAM'];
const dirtyEnv = Object.fromEntries(sessionVars.map((name) => [name, 'antigravity-session']));
const target = {
  id: 'window', type: 'page', title: 'Antigravity',
  url: 'https://127.0.0.1:54321/?token=page-secret#session',
  webSocketDebuggerUrl: 'ws://127.0.0.1:54320/devtools/page/window'
};
const host = { running: true, pid: 100, hasDebugSwitch: true, version: '2.35.1', elapsedSec: 60 };
const anchors = loadHealthAnchorsRegistry();
const topbar = resolveAnchorSelectors('topbar.rightCluster', host.version, anchors).selectors[0];

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function reportItems(matched = {}) {
  return Object.keys(anchors.anchors).map((name) => ({
    name, status: matched[name] ? 'ok' : 'missing', matchedSelector: matched[name] || null
  }));
}

test('resident wrappers remove session values and preserve only the inherited names for audit', (t) => {
  const homeDir = tempDir(t);
  const env = { ...process.env, ...dirtyEnv, HOME: homeDir };
  const clean = isolateResidentEnv({ ...env });
  for (const key of sessionVars) assert.equal(clean[key], undefined);
  assert.deepEqual(clean.AGY_DADDY_INHERITED_SESSION_VARS.split(','), sessionVars);

  const fixture = path.join(homeDir, 'fixture probe.js');
  fs.writeFileSync(fixture, 'console.log(JSON.stringify(process.env));');
  const runtimeInfo = { runtime: process.execPath };
  const mac = installAutoStart({
    platform: 'darwin', dryRun: true, homeDir, cliPath: fixture, runtimeInfo,
    env: { ANTIGRAVITY_AGENT: 'do-not-write-this-value' }
  });
  assert.doesNotMatch(mac.plist, /do-not-write-this-value/);
  const argsXml = mac.plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]+?)<\/array>/)[1];
  const macArgs = Array.from(argsXml.matchAll(/<string>([\s\S]+?)<\/string>/g), ([, value]) =>
    value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
  );
  const { content: linux } = installAutoStart({ platform: 'linux', dryRun: true, binPath: fixture, runtimeInfo });
  const exec = linux.match(/^ExecStart=:\/bin\/sh -c (.+)$/m)[1];
  const linuxArgs = Array.from(exec.matchAll(/"(?:[^"\\]|\\.)*"/g), ([value]) => JSON.parse(value));
  const { content: bat } = installAutoStart({ platform: 'win32', dryRun: true });
  for (const key of sessionVars) {
    assert.ok(bat.includes(`set "${key}="`));
    assert.ok(bat.includes(`%,${key}"`));
  }

  if (process.platform !== 'win32') {
    for (const [shell, ...args] of [macArgs, ['/bin/sh', '-c', ...linuxArgs]]) {
      const result = spawnSync(shell, args, { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const childEnv = JSON.parse(result.stdout);
      for (const key of sessionVars) assert.equal(childEnv[key], undefined);
      assert.deepEqual(childEnv.AGY_DADDY_INHERITED_SESSION_VARS.split(',').filter(Boolean), sessionVars);
    }
  }

  if (process.platform === 'darwin') {
    const launcher = installMacLauncherApp({ targetDir: homeDir });
    const script = fs.readFileSync(launcher.binPath, 'utf8').replace(/^exec .*$/m,
      `exec '${process.execPath}' '${fixture}'`);
    const result = spawnSync('/bin/zsh', ['-c', script], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const childEnv = JSON.parse(result.stdout);
    for (const key of sessionVars) assert.equal(childEnv[key], undefined);
    assert.deepEqual(childEnv.AGY_DADDY_INHERITED_SESSION_VARS.split(',').filter(Boolean), sessionVars);
  }

  for (const key of sessionVars) {
    const guarded = spawnSync(process.execPath, [cli, 'restart', '--dry-run'], {
      env: { ...process.env, [key]: dirtyEnv[key] }, encoding: 'utf8'
    });
    assert.equal(guarded.status, 1, guarded.stderr);
    assert.equal(JSON.parse(guarded.stdout).reason, 'INSIDE_ANTIGRAVITY_SESSION');
  }
});

test('launcher and daemon start expose a names-only session audit while they are running', async (t) => {
  for (const args of [['launcher', '--skip-inject', '--json'], ['daemon', 'start']]) {
    const stateDir = tempDir(t);
    const env = { ...process.env, ...dirtyEnv, AGY_DADDY_TEST_MODE: '1', AGY_DADDY_STATE_DIR: stateDir };
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const completion = once(child, 'close');
    try {
      let data = '';
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const info = await new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          data += chunk;
          try { resolve(JSON.parse(data)); } catch {}
        });
        child.once('error', reject);
        child.once('close', () => reject(new Error(stderr || data || 'No startup output')));
      });
      const res = await fetch(`http://127.0.0.1:${info.port}/diagnostics/health`);
      assert.equal(res.status, 200);
      const health = await res.json();
      assert.deepEqual(health.daemon.inheritedSessionVars, sessionVars);
      assert.equal(health.daemon.hasSessionEnvPollution, false);
      assert.ok(!JSON.stringify(health).includes('antigravity-session'));
    } finally {
      child.kill();
      await completion;
    }
  }
});

test('version inspection reads CFBundleShortVersionString from the running or installed app', (t) => {
  const nativeMac = process.platform === 'darwin';
  const appPath = nativeMac ? path.join(tempDir(t), 'Antigravity Preview.app') : '/Applications/Antigravity Preview.app';
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  if (nativeMac) {
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>2.35.1</string></dict></plist>');
  }
  const options = {
    platform: 'darwin',
    ...(!nativeMac ? {
      fs: { existsSync: (file) => file === plist },
      execFileSync(binary, args) {
        assert.equal(binary, '/usr/bin/plutil');
        assert.equal(args[1], 'CFBundleShortVersionString');
        assert.equal(args.at(-1), plist);
        return '2.35.1\n';
      }
    } : {})
  };
  const psOutput = `123 01:45 ${appPath}/Contents/MacOS/Antigravity --remote-debugging-port=0`;
  const running = inspectAntigravityHostProcess({ ...options, psOutput });
  assert.equal(running.version, '2.35.1');
  assert.equal(running.appPath, appPath);
  assert.equal(inspectAntigravityHostProcess({ ...options, psOutput: '', appPath }).version, '2.35.1');
  assert.equal(readAntigravityVersion({ platform: 'linux', appPath }), null);
});

test('CDP discovery retains rejected targets on earlier ports and when no target matches', async () => {
  const filtered = { id: 'new-prefix', type: 'page', url: 'https://example.invalid/' };
  const worker = { id: 'worker', type: 'service_worker', url: 'blob:worker-test' };
  const fetchJson = async (port) => {
    if (port === 1) throw new Error('not listening');
    return port === 2 ? [filtered, worker] : [target];
  };
  const discovery = await resolveActiveCdpTarget({ ports: [1, 2, 3, 4], fetchJson });
  assert.deepEqual(discovery.portsTried, [1, 2, 3]);
  assert.equal(discovery.port, 3);
  assert.equal(discovery.reachable, true);
  assert.deepEqual(discovery.pages, [filtered, worker, target]);
  assert.deepEqual(discovery.targets, [target]);
  assert.deepEqual(discovery.filtered.map(({ filterReason }) => filterReason), ['unexpected_url', 'unsupported_target_type']);
  const empty = await resolveActiveCdpTarget({ ports: [1, 2], fetchJson });
  assert.equal(empty.port, 2);
  assert.deepEqual(empty.pages, [filtered, worker]);
  assert.deepEqual(empty.targets, []);
});

test('watchdog retries cooldown with backoff, persists takeover and emits a structured failure once', async (t) => {
  const stateDir = tempDir(t);
  const events = [];
  let now = 10_000;
  let current = { ...host, hasDebugSwitch: false };
  const sessions = new Map();
  const health = new HostHealth({
    stateDir, now: () => now, getSession: (id) => sessions.get(id),
    emit: (name, value) => events.push({ name, value })
  });
  health.recordInjectedVersion('2.34.0');
  const daemon = {
    running: true, stateDir, health,
    injector: {
      sessions,
      async attachTarget(page) {
        sessions.set(page.id, { target: page });
        return { errors: [] };
      }
    }
  };
  let attempts = 0;
  const watchdog = createLiveWatchdog(daemon, {
    platform: 'darwin', silent: true, env: {}, now: () => now, intervalMs: 100,
    inspectHostProcess: () => current, resolveCdpTarget: async () => ({ targets: [] }),
    relaunchFn: async (options) => {
      assert.equal(options.expectedPid, 100);
      assert.equal(options.enforceCooldown, true);
      attempts++;
      return attempts === 1
        ? { ok: false, skipped: true, reason: 'COOLDOWN_ACTIVE' }
        : { ok: false, reason: 'CDP_WAIT_TIMEOUT', relaunched: true };
    }
  });
  assert.equal((await watchdog.tick()).action, 'cooldown');
  now += 99;
  assert.equal((await watchdog.tick()).action, 'cooldown');
  assert.equal(attempts, 1);
  now++;
  current = { ...current };
  assert.equal((await watchdog.tick()).action, 'relaunch-failed');
  assert.equal(health.snapshot().fault.code, 'relaunch_blocked_or_timeout');
  assert.equal((await watchdog.tick()).action, 'bare-warned');
  current = { ...current, pid: 101 };
  await watchdog.tick();
  assert.equal(attempts, 2, 'one actual attempt per persisted upgrade, including a different PID');
  assert.deepEqual(events.filter(({ name }) => name === UPGRADE_TAKEOVER_FAILED), [
    { name: UPGRADE_TAKEOVER_FAILED, value: { pid: 100, reason: 'CDP_WAIT_TIMEOUT', version: '2.35.1' } }
  ]);
  let state = readHostHealthState(stateDir);
  assert.equal(state.lastInjectedVersion, '2.34.0');
  assert.deepEqual(state.upgradeEvents.map(({ outcome }) => outcome), ['attempting', 'deferred', 'failed']);

  current = { ...host, pid: 101 };
  const next = createLiveWatchdog(daemon, {
    silent: true, inspectHostProcess: () => current, resolveCdpTarget: async () => ({ port: 54320, targets: [target] })
  });
  await next.tick();
  state = readHostHealthState(stateDir);
  assert.equal(state.lastInjectedVersion, '2.35.1');
  assert.equal(health.snapshot().fault.active, false);
});

test('watchdog records a successful upgrade against the replacement PID even with a stale CDP target', async (t) => {
  const stateDir = tempDir(t);
  const sessions = new Map();
  const health = new HostHealth({ stateDir, getSession: (id) => sessions.get(id) });
  health.recordInjectedVersion('2.34.0');
  let processInfo = { ...host, hasDebugSwitch: false, appPath: '/Applications/Custom Antigravity.app' };
  const injected = [];
  const daemon = {
    running: true, stateDir, health,
    injector: {
      sessions,
      async attachTarget(page) {
        injected.push(page.id);
        sessions.set(page.id, { target: page });
        return { errors: [] };
      }
    }
  };
  const watchdog = createLiveWatchdog(daemon, {
    platform: 'darwin', silent: true, env: {},
    inspectHostProcess: () => processInfo,
    resolveCdpTarget: async () => ({ port: 54320, targets: [{ ...target, id: 'stale' }] }),
    relaunchFn: async (options) => {
      assert.equal(options.appPath, processInfo.appPath);
      processInfo = { ...host, pid: 101 };
      return { ok: true, relaunched: true, port: 54320, targets: [target] };
    }
  });
  assert.equal((await watchdog.tick()).action, 'relaunched-and-injected');
  assert.deepEqual(injected, ['window']);
  const restored = new HostHealth({ stateDir }).snapshot();
  assert.equal(restored.antigravity.lastInjectedVersion, '2.35.1');
  assert.deepEqual(restored.antigravity.upgradeEvents.map(({ outcome, pid }) => [outcome, pid]), [
    ['attempting', 100], ['succeeded', 101]
  ]);
});

test('five fault classes cross the threshold once per fault and recover on a healthy observation', (t) => {
  const stateDir = tempDir(t);
  const sessions = new Map();
  const events = [];
  let now = 0;
  const health = new HostHealth({
    stateDir, now: () => now, getSession: (id) => sessions.get(id),
    emit: (name, fault) => events.push({ name, fault })
  });
  const active = { port: 54320, targets: [target] };
  const bare = { ...host, hasDebugSwitch: false };
  const cases = {
    missing_cdp_switch() { health.observe(bare, {}); },
    relaunch_blocked_or_timeout() {
      health.observe(bare, {});
      health.recordRelaunch({ ok: false, blocked: true, reason: 'INSIDE_ANTIGRAVITY_SESSION' });
    },
    cdp_zero_targets() { health.observe(host, { port: 54320, targets: [] }); },
    injection_error() {
      health.observe(host, active);
      health.recordInjection({ targetId: target.id, error: 'renderer bootstrap failed' });
    },
    core_anchor_missing() {
      health.observe(host, active);
      sessions.set(target.id, { target, healthProbe: { items: reportItems() } });
    }
  };
  for (const [code, trigger] of Object.entries(cases)) {
    health.reset();
    sessions.clear();
    events.length = 0;
    trigger();
    const first = health.snapshot().fault;
    assert.equal(first.code, code);
    assert.equal(first.exceeded5s, false);
    now += 5000;
    assert.equal(health.snapshot().fault.exceeded5s, false);
    now++;
    const exceeded = health.snapshot().fault;
    assert.equal(exceeded.exceeded5s, true);
    assert.equal(exceeded.since, first.since);
    now++;
    health.snapshot();
    health.observe({ running: false, pid: null }, {});
    assert.equal(health.snapshot().fault.active, false);
    assert.deepEqual(events.map(({ name, fault }) => [name, fault.active, fault.exceeded5s]), [
      [FAULT_CHANGED, true, false], [FAULT_CHANGED, true, true], [FAULT_CHANGED, false, false]
    ]);
  }
});

test('daemon health merges live DOM and authenticated renderer reports and feeds doctor and diagnostics', async (t) => {
  const stateDir = tempDir(t);
  const id = 'example.health';
  const record = { id, enabled: true };
  const manifest = { displayName: 'Health fixture', requires: { anchors: ['composer.editor'] } };
  const injector = new CdpInjector({ stateDir, antigravityVersion: host.version });
  const daemon = new AgyDaddyDaemon({ stateDir, injector, plugins: [], inspectHostProcess: () => host });
  await daemon.start();
  t.after(() => daemon.stop());
  daemon.activePlugins.set(id, { id, record, manifest });
  const session = {
    target, targetId: target.id, xworldNonce: 'active-document', readyForNavEvents: true,
    activePlugins: [{ id }], mountedPlugins: new Map([[id, {}]]),
    client: { evaluate: async (expression) => vm.runInNewContext(expression, {
      __AGYDaddyHost: { getSettingsMode: () => 'closed' },
      document: {
        body: {},
        querySelectorAll: (sel) => sel === topbar ? [{ closest: () => null }] : [],
        querySelector: () => null
      }
    }) }
  };
  injector.sessions.set(target.id, session);
  const rejected = { id: 'other', url: 'file:///tmp/private-document', type: 'page', filterReason: 'unexpected_url' };
  daemon.health.observe(host, { port: 54320, targets: [target], filtered: [rejected] });
  await injector.refreshHealthProbes([target]);

  const base = `http://127.0.0.1:${daemon.bridge.port}`;
  const auth = { 'x-agy-host-token': daemon.bridge.hostToken, 'content-type': 'application/json' };
  const post = (route, body = {}, headers = auth) => fetch(base + route, {
    method: 'POST', headers, body: JSON.stringify(body)
  });
  let snapshot = await (await post('/host/health')).json();
  assert.equal(snapshot.injection.probeSource, 'runtime');
  assert.equal(snapshot.injection.injectedCount, 1);
  assert.equal(snapshot.injection.anchors.total, 14);
  assert.equal(snapshot.injection.anchors.healthyCount, 1);
  assert.equal(snapshot.fault.active, false, 'closed native settings are expected to be missing');
  assert.equal(snapshot.plugins[0].rendererMounted, true);
  assert.equal(snapshot.plugins[0].nodeState, 'not_applicable');
  assert.deepEqual(snapshot.plugins[0].affectedByMissingAnchors, ['composer.editor']);
  assert.deepEqual(snapshot.injection.anchors.items.find(({ name }) => name === 'composer.editor').affectedPlugins, [id]);
  assert.equal(snapshot.cdp.targets.matched[0].url, target.url);
  assert.equal(snapshot.cdp.targets.filtered[0].url, rejected.url);

  const report = {
    targetId: target.id, reportId: session.xworldNonce, settingsExpected: true,
    anchors: { items: reportItems({ 'topbar.rightCluster': topbar }) },
    plugins: [{ id, rendererMounted: false, lastError: 'token=renderer-secret', lastErrorStack: `Error at ${os.homedir()}/renderer.js` }]
  };
  assert.equal((await post('/host/health/runtime-report', report, {})).status, 403);
  assert.equal((await post('/host/health/runtime-report', { ...report, reportId: 'old-document' })).status, 409);
  assert.equal((await post('/host/health/runtime-report', { ...report, anchors: { items: [] } })).status, 400);
  assert.equal((await post('/host/health/runtime-report', report)).status, 200);
  snapshot = await (await post('/host/health')).json();
  assert.equal(snapshot.fault.code, 'core_anchor_missing');
  assert.equal(snapshot.plugins[0].rendererMounted, false);
  assert.equal(snapshot.plugins[0].lastErrorStack, report.plugins[0].lastErrorStack);

  const publicResponse = await fetch(base + '/diagnostics/health');
  assert.equal(publicResponse.status, 200);
  const publicHealth = await publicResponse.json();
  assert.deepEqual(Object.keys(publicHealth), Object.keys(snapshot));
  assert.equal(publicHealth.cdp.targets.matched[0].url, 'https://127.0.0.1:54321/');
  assert.equal(publicHealth.cdp.targets.filtered[0].url, 'file:<REDACTED>');
  assert.equal(publicHealth.plugins[0].lastError, 'token=<REDACTED>');
  assert.match(publicHealth.plugins[0].lastErrorStack, /<HOME>/);
  assert.equal((await fetch(base + '/diagnostics/health', { headers: { origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await fetch(base + '/diagnostics/health', { method: 'POST' })).status, 405);
  const invalidHost = await new Promise((resolve, reject) => {
    http.get(base + '/diagnostics/health', { headers: { host: `localhost:${daemon.bridge.port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(invalidHost, 403);

  assert.equal((await fetch(base + '/diagnostics')).status, 404);
  const unregister = daemon.bridge.registerDiagnosticsPage(async () => '<h1>Diagnostics</h1>');
  const page = await fetch(base + '/diagnostics');
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.equal(await page.text(), '<h1>Diagnostics</h1>');
  unregister();
  assert.equal((await fetch(base + '/diagnostics')).status, 404);

  const legacy = await daemon.bridge.invokeHostRoute('/host/health', {}, { via: 'host.control' });
  assert.equal(legacy.anchors.count, 14);
  assert.ok(Array.isArray(legacy.plugins.items));
  assert.equal(legacy.hostHealth.plugins[0].id, id);

  const env = { ...process.env, AGY_DADDY_TEST_MODE: '1', AGY_DADDY_STATE_DIR: stateDir };
  const { stdout: json } = await execFileAsync(process.execPath, [cli, 'doctor', '--json'], { env });
  const live = JSON.parse(json);
  assert.equal(live.daemon.pid, process.pid);
  assert.deepEqual(live.cdp, publicHealth.cdp);
  const { stdout: text } = await execFileAsync(process.execPath, [cli, 'doctor'], { env });
  for (const label of ['Daemon:', 'Antigravity:', 'CDP:', '注入:', '插件:', '故障:']) assert.ok(text.includes(label));

  await daemon.stop();
  const offline = (await runDoctor({ stateDir, skipCdp: true })).hostHealth;
  assert.deepEqual(Object.keys(offline), Object.keys(live));
  assert.equal(offline.daemon.pid, null);
  assert.equal(offline.injection.probeSource, 'static');
  assert.equal(offline.injection.anchors.total, 14);
});
