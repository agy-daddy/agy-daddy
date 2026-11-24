'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { relaunchAntigravityWithCdp } = require('../src/core/lifecycle');
const { createLiveWatchdog } = require('../src/core/live-watchdog');
const { CdpInjector } = require('../src/core/injector');

function makeStubDaemon(overrides = {}) {
  const sessions = new Map();
  const activePlugins = new Map([
    ['agy-daddy.zh-cn', { id: 'agy-daddy.zh-cn' }],
    ['agy-daddy.proxy', { id: 'agy-daddy.proxy' }]
  ]);
  const attachCalls = [];
  let disposeAllCalls = 0;

  const injector = {
    sessions,
    lastCdpPort: null,
    lastActivePlugins: [],
    async attachTarget(target, plugins) {
      attachCalls.push({ target, plugins });
      const targetId = target.id || target.webSocketDebuggerUrl;
      sessions.set(targetId, { targetId, target, closed: false });
      const m = String(target.webSocketDebuggerUrl || '').match(/127\.0\.0\.1:(\d+)/);
      if (m) injector.lastCdpPort = Number(m[1]);
      injector.lastActivePlugins = Array.from(plugins || []);
      return { targetId, url: target.url || '', pluginsInjected: plugins.length, errors: [] };
    },
    async disposeAll() {
      disposeAllCalls++;
      sessions.clear();
    }
  };

  return {
    daemon: {
      running: true,
      stateDir: overrides.stateDir || os.tmpdir(),
      activePlugins,
      injector,
      async collectHostLaunchSpec() {
        return overrides.launchSpec || {
          args: ['--remote-debugging-port=0', '--proxy-server=http://127.0.0.1:18766'],
          env: { HTTP_PROXY: 'http://127.0.0.1:18766' }
        };
      }
    },
    attachCalls,
    getDisposeAllCalls: () => disposeAllCalls
  };
}

test('liveWatchdog: 启动时老裸进程不误杀仅告警一次；退出重开后自动补参并注入', async () => {
  const { daemon, attachCalls } = makeStubDaemon();
  const logs = [];
  const warns = [];
  const relaunchCalls = [];

  let currentHost = { running: true, pid: 1001, hasDebugSwitch: false, elapsedSec: 120 };
  let currentCdp = { port: null, targets: [] };

  const watchdog = createLiveWatchdog(daemon, {
    platform: 'darwin',
    env: {},
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    inspectHostProcess: () => currentHost,
    resolveCdpTarget: async () => currentCdp,
    relaunchFn: async (opts) => {
      relaunchCalls.push(opts);
      currentHost = { running: true, pid: 2002, hasDebugSwitch: true, elapsedSec: 1 };
      currentCdp = {
        port: 55100,
        targets: [{ id: 't-new', url: 'https://127.0.0.1:51410/', webSocketDebuggerUrl: 'ws://127.0.0.1:55100/devtools/page/t-new' }]
      };
      return { ok: true, relaunched: true, port: 55100, targets: currentCdp.targets, targetsCount: 1 };
    }
  });

  // 1. 启动时老裸进程 (elapsedSec=120 > 25)：绝不自动重启，连续两次 tick 只打印 1 条告警
  watchdog.init();
  const r1 = await watchdog.tick();
  const r2 = await watchdog.tick();
  assert.equal(r1.action, 'bare-warned');
  assert.equal(r2.action, 'bare-warned');
  assert.equal(relaunchCalls.length, 0);
  assert.equal(warns.length, 1);

  // 2. 用户按 ⌘Q 退出 Antigravity
  currentHost = { running: false, pid: null, hasDebugSwitch: false, elapsedSec: null };
  const r3 = await watchdog.tick();
  assert.equal(r3.action, 'idle');

  // 3. 用户重新正常打开 Antigravity（新 PID 1002，无调试参数，即使 elapsedSec > 25 或 <= 25 都视为新启动）
  currentHost = { running: true, pid: 1002, hasDebugSwitch: false, elapsedSec: 3 };
  const r4 = await watchdog.tick();
  assert.equal(r4.action, 'relaunched-and-injected');
  assert.equal(relaunchCalls.length, 1);
  assert.deepEqual(relaunchCalls[0].proxyEnv, { HTTP_PROXY: 'http://127.0.0.1:18766' });
  assert.ok(relaunchCalls[0].extraArgs.includes('--proxy-server=http://127.0.0.1:18766'));
  assert.equal(attachCalls.length, 1);
  assert.equal(daemon.injector.lastCdpPort, 55100);
  assert.equal(daemon.injector.lastActivePlugins.length, 2);
  assert.ok(logs.some((l) => l.includes('自动补充 --remote-debugging-port=0')));
  assert.ok(logs.some((l) => l.includes('完成注入')));
});

test('liveWatchdog: 刚启动的裸进程 (elapsedSec <= 25) 首次 tick 即自动补参重拉，且同 PID 不重复', async () => {
  const { daemon } = makeStubDaemon();
  const relaunchCalls = [];
  const warns = [];

  const watchdog = createLiveWatchdog(daemon, {
    platform: 'darwin',
    env: {},
    log: () => {},
    warn: (m) => warns.push(m),
    inspectHostProcess: () => ({ running: true, pid: 3001, hasDebugSwitch: false, elapsedSec: 5 }),
    resolveCdpTarget: async () => ({ port: null, targets: [] }),
    relaunchFn: async (opts) => {
      relaunchCalls.push(opts);
      return { ok: false, relaunched: false, reason: 'QUIT_TIMEOUT', message: 'timeout' };
    }
  });

  const r1 = await watchdog.tick();
  const r2 = await watchdog.tick();
  assert.equal(r1.action, 'relaunch-failed');
  assert.equal(relaunchCalls.length, 1);
  assert.equal(r2.action, 'bare-warned');
  assert.equal(warns.length, 2); // 1 failure warn + 1 bare-warned (deduped thereafter)
  const r3 = await watchdog.tick();
  assert.equal(r3.action, 'bare-warned');
  assert.equal(warns.length, 2);
});

test('liveWatchdog: 退出带 CDP 的客户端后普通重启（换新端口/同 targetId 不同 wsUrl）能清理旧会话并重注', async () => {
  const { daemon, attachCalls, getDisposeAllCalls } = makeStubDaemon();
  const logs = [];

  let currentHost = { running: true, pid: 4001, hasDebugSwitch: true, elapsedSec: 10 };
  let currentCdp = {
    port: 51111,
    targets: [{ id: 'same-id', url: 'https://127.0.0.1:51410/', webSocketDebuggerUrl: 'ws://127.0.0.1:51111/devtools/page/same-id' }]
  };

  const watchdog = createLiveWatchdog(daemon, {
    platform: 'darwin',
    env: {},
    log: (m) => logs.push(m),
    warn: () => {},
    inspectHostProcess: () => currentHost,
    resolveCdpTarget: async () => currentCdp
  });

  // 初次注入
  await watchdog.tick();
  assert.equal(attachCalls.length, 1);
  assert.equal(daemon.injector.lastCdpPort, 51111);

  // 同 targetId + 同 wsUrl 幂等跳过
  await watchdog.tick();
  assert.equal(attachCalls.length, 1);

  // 客户端退出
  currentHost = { running: false, pid: null, hasDebugSwitch: false, elapsedSec: null };
  currentCdp = { port: null, targets: [] };
  const idleRes = await watchdog.tick();
  assert.equal(idleRes.action, 'idle');
  assert.equal(getDisposeAllCalls(), 1);
  assert.equal(daemon.injector.sessions.size, 0);

  // 客户端以带调试端口在新端口重开（即使 targetId 复用旧值，新 wsUrl 也能正确注入）
  currentHost = { running: true, pid: 4002, hasDebugSwitch: true, elapsedSec: 2 };
  currentCdp = {
    port: 52222,
    targets: [{ id: 'same-id', url: 'https://127.0.0.1:51410/', webSocketDebuggerUrl: 'ws://127.0.0.1:52222/devtools/page/same-id' }]
  };
  await watchdog.tick();
  assert.equal(attachCalls.length, 2);
  assert.equal(daemon.injector.lastCdpPort, 52222);

  // 如果未经过 idle 直接换了端口/wsUrl，syncTargets 也应识别 wsUrl 变化并重新注入
  currentCdp = {
    port: 53333,
    targets: [{ id: 'same-id', url: 'https://127.0.0.1:51410/', webSocketDebuggerUrl: 'ws://127.0.0.1:53333/devtools/page/same-id' }]
  };
  await watchdog.tick();
  assert.equal(attachCalls.length, 3);
  assert.equal(daemon.injector.lastCdpPort, 53333);
});

test('liveWatchdog: Antigravity 内部会话守卫与 --no-auto-relaunch / env 禁用均不自动重启', async () => {
  for (const envCase of [
    { env: { ANTIGRAVITY_AGENT: '1' }, autoRelaunch: true },
    { env: { AGY_DADDY_NO_AUTO_RELAUNCH: '1' }, autoRelaunch: true },
    { env: {}, autoRelaunch: false }
  ]) {
    const { daemon } = makeStubDaemon();
    const warns = [];
    let relaunched = false;
    const watchdog = createLiveWatchdog(daemon, {
      platform: 'darwin',
      env: envCase.env,
      autoRelaunch: envCase.autoRelaunch,
      log: () => {},
      warn: (m) => warns.push(m),
      inspectHostProcess: () => ({ running: true, pid: 5001, hasDebugSwitch: false, elapsedSec: 1 }),
      resolveCdpTarget: async () => ({ port: null, targets: [] }),
      relaunchFn: async () => {
        relaunched = true;
        return { ok: true };
      }
    });
    const res = await watchdog.tick();
    assert.equal(res.action, 'bare-warned');
    assert.equal(relaunched, false);
    assert.equal(warns.length, 1);
  }
});

test('relaunchAntigravityWithCdp: 优雅退出 + 参数去重 + 代理env + 冷却锁 + 超时与 onlyIfBare', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-relaunch-'));
  try {
    // 1. 正常优雅退出 -> open 去重 -> 等待 CDP target 就绪
    let alive = true;
    let osascriptCount = 0;
    let launchCall = null;
    let cdpPolls = 0;
    let fakeNow = 100000;

    const okRes = await relaunchAntigravityWithCdp({
      platform: 'darwin',
      env: {},
      appPath: '/Applications/Antigravity.app',
      stateDir: root,
      extraArgs: ['--remote-debugging-port=0', '--proxy-server=http://127.0.0.1:18766'],
      proxyEnv: { HTTP_PROXY: 'http://127.0.0.1:18766' },
      pollIntervalMs: 10,
      quitTimeoutMs: 500,
      waitCdpTimeoutMs: 500,
      now: () => fakeNow,
      sleep: async (ms) => { fakeNow += ms; },
      inspectHostProcess: () => ({ running: true, pid: 7001, hasDebugSwitch: false }),
      runOsascript: () => { osascriptCount++; alive = false; },
      isPidAliveFn: () => alive,
      launchApp: (exe, args) => {
        launchCall = { exe, args };
        return { status: 0 };
      },
      resolveCdpTarget: async () => {
        cdpPolls++;
        if (cdpPolls < 2) return { port: null, targets: [] };
        return { port: 54321, targets: [{ id: 'p1', url: 'https://127.0.0.1:51410/' }] };
      }
    });

    assert.equal(okRes.ok, true);
    assert.equal(okRes.relaunched, true);
    assert.equal(okRes.port, 54321);
    assert.equal(okRes.targetsCount, 1);
    assert.equal(osascriptCount, 1);
    assert.equal(launchCall.exe, 'open');
    assert.equal(launchCall.args.filter((a) => a.startsWith('--remote-debugging-port')).length, 1);
    assert.ok(launchCall.args.includes('--proxy-server=http://127.0.0.1:18766'));
    assert.ok(launchCall.args.includes('HTTP_PROXY=http://127.0.0.1:18766'));

    // 2. 冷却锁在 cooldownMs 内阻止重复重启
    const cooldownRes = await relaunchAntigravityWithCdp({
      platform: 'darwin',
      env: {},
      stateDir: root,
      enforceCooldown: true,
      cooldownMs: 20000,
      now: () => fakeNow + 5000,
      inspectHostProcess: () => ({ running: true, pid: 7002, hasDebugSwitch: false }),
      launchApp: () => { throw new Error('should not launch during cooldown'); }
    });
    assert.equal(cooldownRes.ok, false);
    assert.equal(cooldownRes.skipped, true);
    assert.equal(cooldownRes.reason, 'COOLDOWN_ACTIVE');

    // 3. onlyIfBare: true 时进程已带调试开关则跳过
    const skipRes = await relaunchAntigravityWithCdp({
      platform: 'darwin',
      env: {},
      stateDir: root,
      onlyIfBare: true,
      inspectHostProcess: () => ({ running: true, pid: 7003, hasDebugSwitch: true })
    });
    assert.equal(skipRes.ok, true);
    assert.equal(skipRes.relaunched, false);
    assert.equal(skipRes.reason, 'ALREADY_HAS_DEBUG_SWITCH');

    // 4. 退出超时返回 QUIT_TIMEOUT（发送 SIGTERM 但不 SIGKILL）
    let sigs = [];
    let tNow = 500000;
    const timeoutRes = await relaunchAntigravityWithCdp({
      platform: 'darwin',
      env: {},
      stateDir: root,
      pollIntervalMs: 10,
      quitTimeoutMs: 40,
      now: () => tNow,
      sleep: async (ms) => { tNow += ms; },
      inspectHostProcess: () => ({ running: true, pid: 7004, hasDebugSwitch: false }),
      runOsascript: () => {},
      isPidAliveFn: () => true,
      killProcess: (pid, sig) => sigs.push({ pid, sig }),
      launchApp: () => { throw new Error('should not launch on quit timeout'); }
    });
    assert.equal(timeoutRes.ok, false);
    assert.equal(timeoutRes.reason, 'QUIT_TIMEOUT');
    assert.deepEqual(sigs, [{ pid: 7004, sig: 'SIGTERM' }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CdpInjector.attachTarget 同步更新 lastCdpPort 与 lastActivePlugins', async () => {
  class FakeWs {
    constructor() {
      this.listeners = new Map();
      setImmediate(() => this.emit('open', {}));
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    }
    emit(type, ev) {
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
    send(raw) {
      const msg = JSON.parse(raw);
      let result = {};
      if (msg.method === 'Page.getFrameTree') {
        result = { frameTree: { frame: { id: 'f1' } } };
      } else if (msg.method === 'Runtime.evaluate') {
        result = { result: { value: { ok: true } } };
      }
      setImmediate(() => this.emit('message', { data: JSON.stringify({ id: msg.id, result }) }));
    }
    close() {}
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-inj-port-'));
  try {
    const bundlePath = path.join(root, 'host-renderer.js');
    fs.writeFileSync(bundlePath, 'globalThis.__AGYDaddyHost = { version: "1.0.0", dispose() {} };', 'utf8');
    const injector = new CdpInjector({
      WebSocket: FakeWs,
      hostBundlePath: bundlePath,
      bridgePort: 50000,
      hostToken: 'tok'
    });
    const plugins = [{ id: 'demo.p1', manifest: {} }];
    await injector.attachTarget(
      { id: 't1', url: 'https://127.0.0.1:51410/', webSocketDebuggerUrl: 'ws://127.0.0.1:56789/devtools/page/t1' },
      plugins
    );
    assert.equal(injector.lastCdpPort, 56789);
    assert.equal(injector.lastActivePlugins.length, 1);
    assert.equal(injector.lastActivePlugins[0].id, 'demo.p1');
    await injector.disposeAll();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI live: 后台已运行时幂等返回状态，--replace 可停止旧实例并接管', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cli-live-dup-'));
  const stateDir = path.join(root, 'state');
  const pluginsDir = path.join(root, 'plugins');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });

  const cliPath = path.resolve(__dirname, '..', 'src', 'cli.js');
  const env = {
    ...process.env,
    AGY_DADDY_TEST_MODE: '1',
    AGY_DADDY_STATE_DIR: stateDir,
    AGY_DADDY_PLUGINS_DIR: pluginsDir
  };
  delete env.AGY_DADDY_LAUNCHD;

  const child = spawn(process.execPath, [cliPath, 'live', '--skip-inject', '--json'], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    const startedSummary = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => reject(new Error(`Daemon start timeout; stdout=${stdout} stderr=${stderr}`)), 6000);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && parsed.ok && parsed.port) {
            clearTimeout(timer);
            resolve(parsed);
          }
        } catch {}
      });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Daemon exited unexpectedly (${code}): ${stderr}`));
      });
    });

    // 1. live --json 幂等返回运行状态
    const jsonRes = spawnSync(process.execPath, [cliPath, 'live', '--json'], {
      cwd: path.resolve(__dirname, '..'),
      env,
      encoding: 'utf8'
    });
    assert.equal(jsonRes.status, 0, jsonRes.stderr);
    const jsonOut = JSON.parse(jsonRes.stdout);
    assert.equal(jsonOut.ok, true);
    assert.equal(jsonOut.alreadyRunning, true);
    assert.equal(jsonOut.pid, child.pid);
    assert.equal(jsonOut.port, startedSummary.port);

    // 2. live 文本模式幂等返回并提示 --replace
    const textRes = spawnSync(process.execPath, [cliPath, 'live'], {
      cwd: path.resolve(__dirname, '..'),
      env,
      encoding: 'utf8'
    });
    assert.equal(textRes.status, 0, textRes.stderr);
    assert.match(textRes.stdout, /已在后台运行中/);
    assert.match(textRes.stdout, /--replace/);

    // 3. live --replace 停止旧实例并接管（异步运行 CLI，避免同步阻塞测试进程收割子进程）
    const childExitPromise = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    const replaceRes = await new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [cliPath, 'live', '--replace', '--once', '--skip-inject', '--json'], {
        cwd: path.resolve(__dirname, '..'),
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
      proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
      proc.on('error', reject);
      proc.on('exit', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(replaceRes.status, 0, replaceRes.stderr);
    const replaceOut = JSON.parse(replaceRes.stdout);
    assert.equal(replaceOut.ok, true);
    assert.equal(replaceOut.once, true);
    assert.ok(replaceOut.port > 0);
    await childExitPromise;
    assert.equal(fs.existsSync(path.join(stateDir, 'daemon.lock')), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
