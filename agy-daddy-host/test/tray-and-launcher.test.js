'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const HOST_ROOT = path.resolve(__dirname, '..');
const CLI_JS = path.join(HOST_ROOT, 'src', 'cli.js');
const ICON_DIR = path.join(HOST_ROOT, 'assets', 'icons');

const { generateAllIcons } = require('../scripts/generate-icons');
const {
  LAUNCHER_APP_NAME,
  LAUNCHER_MAC_BUNDLE_NAME,
  LAUNCHER_BUNDLE_ID,
  getLauncherIconPaths,
  installLauncherApp,
  generateLinuxDesktopEntry
} = require('../src/core/lifecycle');
const {
  DEFAULT_TRAY_MENU_IDS,
  DEFAULT_TRAY_ITEMS,
  ensureMacTrayAppBundle,
  TrayManager,
  MemoryTrayBackend
} = require('../src/core/tray-manager');
const { FourRealmBus } = require('../src/core/bus');
const { AgyDaddyDaemon } = require('../src/core/daemon');
const { createLauncherController } = require('../src/core/launcher');

function readPngDimensions(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20)
  };
}

test('图标资产：生成有效的多分辨率 PNG / Windows ICO / macOS ICNS / SVG', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-icons-'));
  try {
    const res = generateAllIcons({ outDir: tmp });
    assert.equal(res.ok, true);
    assert.ok(res.files.length >= 14);

    // Check repository icon assets also exist and match binary format headers
    const paths = getLauncherIconPaths(ICON_DIR);
    for (const [size, key] of [
      [16, 'png16'],
      [32, 'png32'],
      [64, 'png64'],
      [128, 'png128'],
      [256, 'png256'],
      [512, 'png512'],
      [1024, 'png1024']
    ]) {
      const dim = readPngDimensions(fs.readFileSync(paths[key]));
      assert.equal(dim.width, size);
      assert.equal(dim.height, size);
    }

    const tray1x = readPngDimensions(fs.readFileSync(paths.trayTemplate1x));
    assert.equal(tray1x.width, 18);
    const tray2x = readPngDimensions(fs.readFileSync(paths.trayTemplate2x));
    assert.equal(tray2x.width, 36);

    const icoBuf = fs.readFileSync(paths.ico);
    assert.equal(icoBuf.readUInt16LE(0), 0);
    assert.equal(icoBuf.readUInt16LE(2), 1);
    assert.equal(icoBuf.readUInt16LE(4), 7);

    const trayIcoBuf = fs.readFileSync(paths.trayIco);
    assert.equal(trayIcoBuf.readUInt16LE(2), 1);
    assert.equal(trayIcoBuf.readUInt16LE(4), 3);

    const icnsBuf = fs.readFileSync(paths.icns);
    assert.equal(icnsBuf.subarray(0, 4).toString('ascii'), 'icns');
    assert.equal(icnsBuf.readUInt32BE(4), icnsBuf.length);
    assert.ok(icnsBuf.includes(Buffer.from('ic10')));
    assert.ok(icnsBuf.includes(Buffer.from('icp4')));

    const svgText = fs.readFileSync(paths.svg, 'utf8');
    assert.match(svgText, /<svg[^>]+viewBox="0 0 1024 1024"/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('应用重命名与跨平台启动器打包：Agy-Daddy Launcher (macOS / Windows / Linux)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launcher-pkg-'));
  try {
    const macDir = path.join(root, 'mac');
    const mac = installLauncherApp({ platform: 'darwin', targetDir: macDir });
    assert.equal(mac.ok, true);
    assert.equal(mac.appName, LAUNCHER_MAC_BUNDLE_NAME);
    assert.equal(mac.displayName, LAUNCHER_APP_NAME);
    assert.equal(mac.bundleId, LAUNCHER_BUNDLE_ID);
    assert.ok(fs.existsSync(mac.infoPath));
    assert.ok(fs.existsSync(mac.binPath));
    assert.ok(fs.existsSync(mac.iconPath));
    const plist = fs.readFileSync(mac.infoPath, 'utf8');
    assert.match(plist, /<key>CFBundleExecutable<\/key><string>AgyDaddyTray<\/string>/);
    assert.match(plist, /<key>CFBundleName<\/key><string>Agy-Daddy Launcher<\/string>/);
    assert.match(plist, /<key>CFBundleDisplayName<\/key><string>Agy-Daddy Launcher<\/string>/);
    assert.match(plist, /<key>CFBundleIconFile<\/key><string>AgyDaddyLauncher<\/string>/);
    assert.match(plist, /<key>LSMinimumSystemVersion<\/key><string>14\.0<\/string>/);
    assert.match(plist, /<key>NSHighResolutionCapable<\/key><true\/>/);
    assert.match(plist, /<key>LSUIElement<\/key><true\/>/);
    const launchSh = fs.readFileSync(mac.binPath, 'utf8');
    assert.match(launchSh, /exec\s+".*agy-daddy"\s+launcher/);
    assert.match(launchSh, /AGY_DADDY_TRAY_APP/);
    assert.match(launchSh, /launcher\.log/);
    assert.doesNotMatch(launchSh, />\/dev\/null 2>&1 \|\| true/);

    const winDir = path.join(root, 'win');
    const win = installLauncherApp({ platform: 'win32', targetDir: winDir });
    assert.equal(win.ok, true);
    assert.equal(win.appName, 'Agy-Daddy Launcher.bat');
    assert.ok(fs.existsSync(win.filePath));
    assert.ok(fs.existsSync(win.iconPath));
    const bat = fs.readFileSync(win.filePath, 'utf8');
    assert.match(bat, /title Agy-Daddy Launcher/);
    assert.match(bat, /--remote-debugging-port=0/);

    const linuxDir = path.join(root, 'linux');
    const linux = installLauncherApp({ platform: 'linux', targetDir: linuxDir });
    assert.equal(linux.ok, true);
    assert.ok(fs.existsSync(linux.filePath));
    assert.ok(fs.existsSync(linux.iconPath));
    const desktop = generateLinuxDesktopEntry({ iconPath: linux.iconPath });
    assert.match(desktop, /Name=Agy-Daddy Launcher/);
    assert.match(desktop, /launcher/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('TrayManager：默认 4 项基础菜单、插件动态注册、排序权重/位置、更新与注销', async () => {
  const bus = new FourRealmBus();
  const backend = new MemoryTrayBackend();
  const calls = [];
  const tray = new TrayManager({
    bus,
    backend,
    onLaunchAntigravity: () => calls.push('launch'),
    onOpenPluginSettings: () => calls.push('settings'),
    onRestartDaemon: () => calls.push('restart'),
    onQuit: () => calls.push('quit')
  });

  await tray.start();
  const initialLabels = backend.lastPayload.items.filter((i) => i.type !== 'separator').map((i) => i.label);
  assert.deepEqual(initialLabels, [
    'antigravity增强版启动入口',
    '插件设置入口',
    '重启守护进程',
    '退出'
  ]);

  // Verify default click routing
  for (const id of Object.values(DEFAULT_TRAY_MENU_IDS)) {
    const res = await tray.handleMenuClick(id);
    assert.equal(res.ok, true);
  }
  assert.deepEqual(calls, ['launch', 'settings', 'restart', 'quit']);

  // Register custom items from two plugins with weight/order/position/submenu/checkbox
  const apiA = tray.createScopedApi('acme.alpha', { pluginDir: HOST_ROOT });
  const apiB = tray.createScopedApi('acme.beta', { pluginDir: HOST_ROOT });

  let betaClicked = 0;
  const hBeta = apiB.registerMenuItem({
    id: 'status',
    label: 'Beta 状态',
    icon: '⚡',
    order: 20,
    position: 'plugins',
    onClick: () => {
      betaClicked++;
      return { ok: true, betaClicked };
    }
  });

  const hTop = apiA.registerMenuItem({
    id: 'quick-top',
    label: '置顶快捷入口',
    position: 'top',
    order: 10,
    onClick: () => 'top-ok'
  });

  const hBeforeQuit = apiA.registerMenuItem({
    id: 'diag',
    label: '导出诊断',
    position: { before: DEFAULT_TRAY_MENU_IDS.QUIT },
    onClick: () => 'diag-ok'
  });

  let subChecked = false;
  apiA.registerMenuItem({
    id: 'group',
    label: 'Alpha 工具箱',
    type: 'submenu',
    order: 10,
    submenu: [
      {
        id: 'toggle-watch',
        label: '监听变更',
        type: 'checkbox',
        checked: false,
        onClick: (ctx) => {
          subChecked = !ctx.checked;
          return { checked: subChecked };
        }
      }
    ]
  });

  await tray.refreshMenu(true);
  const items = backend.lastPayload.items;
  const labels = items.filter((i) => i.type !== 'separator').map((i) => i.label);
  assert.equal(labels[0], '置顶快捷入口');
  assert.ok(labels.indexOf('Alpha 工具箱') < labels.indexOf('Beta 状态'));
  assert.equal(labels.indexOf('导出诊断'), labels.indexOf('退出') - 1);

  // Trigger nested submenu click and dynamic update
  const subClick = await tray.handleMenuClick('acme.alpha:toggle-watch');
  assert.equal(subClick.ok, true);
  assert.equal(subChecked, true);

  const betaRes = await tray.handleMenuClick(hBeta.fullId);
  assert.equal(betaRes.ok, true);
  assert.equal(betaClicked, 1);

  hBeta.update({ label: 'Beta 状态 (已连接)', enabled: true });
  await tray.refreshMenu(true);
  assert.ok(backend.lastPayload.items.some((i) => i.id === hBeta.fullId && i.label === 'Beta 状态 (已连接)'));

  hTop.dispose();
  hBeforeQuit.dispose();
  tray.unregisterPluginItems('acme.alpha');
  await tray.refreshMenu(true);
  assert.equal(tray.listPluginMenuItems('acme.alpha').length, 0);
  assert.equal(tray.listPluginMenuItems('acme.beta').length, 1);

  await tray.dispose();
});

test('TrayManager 容错隔离：渲染 Getter 异常、回调抛错/超时熔断、路径穿越拦截不影响默认菜单', async () => {
  const bus = new FourRealmBus();
  const backend = new MemoryTrayBackend();
  const emittedErrors = [];
  bus.onEvent('test.observer', 'tray:item-error@1', (payload) => emittedErrors.push(payload));

  const tray = new TrayManager({
    bus,
    backend,
    callbackTimeoutMs: 60,
    maxFailuresPerItem: 2
  });
  await tray.start();

  const badApi = tray.createScopedApi('bad.plugin', { pluginDir: path.join(os.tmpdir(), 'plugin-a') });
  const goodApi = tray.createScopedApi('good.plugin', { pluginDir: path.join(os.tmpdir(), 'plugin-b') });

  // 1. Path traversal in relative icon is blocked immediately
  assert.throws(() => {
    badApi.registerMenuItem({ id: 'evil', label: 'Evil', icon: '../../etc/passwd' });
  }, /TRAY_ICON_PATH_TRAVERSAL/);

  // 2. Throwing getter during render only quarantines that item
  badApi.registerMenuItem({
    id: 'crash-render',
    get label() {
      throw new Error('render getter crashed');
    }
  });

  // 3. Callback crash / async rejection trips circuit breaker after 2 failures
  let failMode = 'sync';
  const flakyHandle = badApi.registerMenuItem({
    id: 'flaky',
    label: '不稳定操作',
    onClick: async () => {
      if (failMode === 'sync') throw new Error('sync boom');
      if (failMode === 'timeout') {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  });

  // 4. Healthy plugin continues working unaffected
  let goodCount = 0;
  goodApi.registerMenuItem({
    id: 'healthy',
    label: '健康功能',
    onClick: () => { goodCount++; return goodCount; }
  });

  await tray.refreshMenu(true);
  const renderedIds = backend.lastPayload.items.map((i) => i.id);
  for (const def of DEFAULT_TRAY_ITEMS) {
    assert.ok(renderedIds.includes(def.id), `Default item ${def.id} must still render`);
  }
  assert.ok(renderedIds.includes('good.plugin:healthy'));
  assert.equal(renderedIds.includes('bad.plugin:crash-render'), false);

  // First click fails (sync throw)
  const r1 = await tray.handleMenuClick(flakyHandle.fullId);
  assert.equal(r1.ok, false);
  assert.equal(r1.circuitOpen, false);

  // Second click fails (timeout) -> opens circuit breaker
  failMode = 'timeout';
  const r2 = await tray.handleMenuClick(flakyHandle.fullId);
  assert.equal(r2.ok, false);
  assert.equal(r2.circuitOpen, true);

  // Third click blocked immediately by circuit breaker
  const r3 = await tray.handleMenuClick(flakyHandle.fullId);
  assert.equal(r3.ok, false);
  assert.match(r3.error, /TRAY_ITEM_CIRCUIT_OPEN/);

  // Healthy plugin still works
  const gRes = await tray.handleMenuClick('good.plugin:healthy');
  assert.equal(gRes.ok, true);
  assert.equal(gRes.result, 1);
  assert.ok(emittedErrors.length >= 3);

  await tray.dispose();
});

test('AgyDaddyDaemon 集成：T0 进程内 + T2 隔离 Worker + manifest tray.menu 声明及退出清理', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tray-daemon-'));
  const t0Dir = path.join(tmp, 't0-plugin');
  const t2Dir = path.join(tmp, 't2-plugin');
  fs.mkdirSync(path.join(t0Dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(t2Dir, 'src'), { recursive: true });

  fs.writeFileSync(path.join(t0Dir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'agy-daddy.tray-t0',
    publisher: 'agy-daddy',
    version: '1.0.0',
    displayName: 'T0 Tray Test',
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    world: 'isolated',
    contributes: {
      commands: [{ id: 'tray-t0.manifestCmd', title: 'Manifest Cmd' }],
      'tray.menu': [
        { id: 'from-manifest', label: '声明式菜单项', command: 'tray-t0.manifestCmd', order: 50 }
      ]
    }
  }));
  fs.writeFileSync(path.join(t0Dir, 'src', 'node.js'), `
    let handle = null;
    exports.activate = async (host) => {
      host.commands.register('tray-t0.manifestCmd', () => ({ from: 'manifest' }));
      handle = host.tray.registerMenuItem({
        id: 'dynamic-t0',
        label: 'T0 动态项',
        order: 10,
        onClick: () => ({ from: 't0-dynamic' })
      });
    };
    exports.deactivate = async () => {
      if (handle) handle.dispose();
    };
  `);

  fs.writeFileSync(path.join(t2Dir, 'agy-plugin.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'third.tray-t2',
    publisher: 'third',
    version: '1.0.0',
    displayName: 'T2 Worker Tray Test',
    engines: { agyDaddy: '^1.0.0' },
    main: './src/node.js',
    world: 'isolated'
  }));
  fs.writeFileSync(path.join(t2Dir, 'src', 'node.js'), `
    let clicks = 0;
    let handle = null;
    exports.activate = async (host) => {
      handle = await host.tray.registerMenuItem({
        id: 'worker-item',
        label: 'T2 Worker 菜单项',
        icon: '🧩',
        order: 30,
        onClick: async (ctx) => {
          clicks++;
          await ctx.update({ label: 'T2 Worker 已点击 #' + clicks });
          return { clicks, from: 't2-worker' };
        }
      });
    };
    exports.deactivate = async () => {
      if (handle) await handle.dispose();
    };
  `);

  const backend = new MemoryTrayBackend();
  const daemon = new AgyDaddyDaemon({
    stateDir: path.join(tmp, 'state'),
    trayOptions: { backend },
    plugins: [
      { id: 'agy-daddy.tray-t0', installPath: t0Dir, trustLevel: 'T0', enabled: true },
      { id: 'third.tray-t2', installPath: t2Dir, trustLevel: 'T2', enabled: true }
    ]
  });

  try {
    await daemon.start();
    await daemon.trayManager.start();

    const menuRes = await daemon.bridge.invokeHostRoute('/host/tray/menu', {});
    assert.equal(menuRes.ok, true);
    const ids = menuRes.items.map((i) => i.id);
    assert.ok(ids.includes('agy-daddy.tray-t0:dynamic-t0'));
    assert.ok(ids.includes('agy-daddy.tray-t0:from-manifest'));
    assert.ok(ids.includes('third.tray-t2:worker-item'));

    const t0Res = await daemon.trayManager.handleMenuClick('agy-daddy.tray-t0:dynamic-t0');
    assert.equal(t0Res.ok, true);
    assert.deepEqual(t0Res.result, { from: 't0-dynamic' });

    const manRes = await daemon.trayManager.handleMenuClick('agy-daddy.tray-t0:from-manifest');
    assert.equal(manRes.ok, true);
    assert.deepEqual(manRes.result, { from: 'manifest' });

    const t2Res = await daemon.trayManager.handleMenuClick('third.tray-t2:worker-item');
    assert.equal(t2Res.ok, true);
    assert.deepEqual(t2Res.result, { clicks: 1, from: 't2-worker' });

    await daemon.trayManager.refreshMenu(true);
    assert.ok(backend.lastPayload.items.some((i) => i.id === 'third.tray-t2:worker-item' && i.label === 'T2 Worker 已点击 #1'));

    // Deactivating T2 plugin removes its tray item cleanly
    await daemon.deactivatePlugin('third.tray-t2');
    assert.equal(daemon.trayManager.listPluginMenuItems('third.tray-t2').length, 0);
  } finally {
    await daemon.trayManager.dispose();
    await daemon.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createLauncherController：4 个默认入口动作（启动增强版、插件设置、重启守护进程保持托盘存活、退出清理）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launcher-ctrl-'));
  const backend = new MemoryTrayBackend();
  const spawned = [];
  const exited = [];
  let cdpOpenedCount = 0;

  const controller = createLauncherController({
    stateDir: path.join(tmp, 'state'),
    platform: 'darwin',
    appPath: '/Applications/Antigravity.app',
    plugins: [],
    trayBackend: backend,
    skipInject: true,
    disableWatchdog: true,
    inspectHostProcess: () => ({ running: false, pid: null, hasDebugSwitch: false }),
    spawnFn: (bin, args) => {
      spawned.push({ bin, args });
      return { unref() {} };
    },
    onExit: (code) => exited.push(code)
  });

  try {
    const startRes = await controller.start();
    assert.equal(startRes.ok, true);
    assert.equal(startRes.appName, 'Agy-Daddy Launcher');
    assert.equal(backend.started, true);

    // 1. Trigger launch Antigravity enhanced
    backend.simulateClick(DEFAULT_TRAY_MENU_IDS.LAUNCH_ANTIGRAVITY);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].bin, 'open');
    assert.ok(spawned[0].args.includes('--remote-debugging-port=0'));

    // 2. Trigger plugin settings (with stubbed injector.openSettingsPanel)
    const d1 = controller.getDaemon();
    d1.injector.openSettingsPanel = async (opts) => {
      cdpOpenedCount++;
      assert.equal(opts.tab, 'plugins');
      return { ok: true, openedCount: 1 };
    };
    const settingsRes = await controller.getTrayManager().handleMenuClick(DEFAULT_TRAY_MENU_IDS.PLUGIN_SETTINGS);
    assert.equal(settingsRes.ok, true);
    assert.equal(settingsRes.result.via, 'cdp');
    assert.equal(cdpOpenedCount, 1);

    // 3. Restart daemon: new daemon instance started while tray backend stays alive
    const oldDaemon = controller.getDaemon();
    const restartRes = await controller.getTrayManager().handleMenuClick(DEFAULT_TRAY_MENU_IDS.RESTART_DAEMON);
    assert.equal(restartRes.ok, true);
    assert.equal(restartRes.result.restarted, true);
    assert.notEqual(controller.getDaemon(), oldDaemon);
    assert.equal(controller.getDaemon().running, true);
    assert.equal(backend.started, true);

    // 4. Quit: disposes tray, stops daemon, calls onExit(0)
    await controller.getTrayManager().handleMenuClick(DEFAULT_TRAY_MENU_IDS.QUIT);
    assert.equal(backend.started, false);
    assert.equal(controller.getDaemon(), null);
    assert.deepEqual(exited, [0]);
  } finally {
    await controller.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI 冒烟验证：install-launcher --dry-run 与 launcher --once --skip-inject --json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launcher-cli-'));
  const env = { ...process.env, AGY_DADDY_TEST_MODE: '1', AGY_DADDY_STATE_DIR: root };
  try {
    const r1 = spawnSync(process.execPath, [CLI_JS, 'install-launcher', '--dry-run', '--dir', root], { env, encoding: 'utf8' });
    assert.equal(r1.status, 0, r1.stderr);
    const p1 = JSON.parse(r1.stdout);
    assert.equal(p1.ok, true);
    assert.equal(p1.displayName, 'Agy-Daddy Launcher');

    const r2 = spawnSync(process.execPath, [CLI_JS, 'launcher', '--once', '--skip-inject', '--json'], { env, encoding: 'utf8' });
    assert.equal(r2.status, 0, r2.stderr);
    const p2 = JSON.parse(r2.stdout);
    assert.equal(p2.ok, true);
    assert.equal(p2.appName, 'Agy-Daddy Launcher');
    assert.ok(p2.trayItems >= 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI launcher 平滑接管已运行的无托盘后台 daemon，并在已有托盘实例时幂等返回', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-launcher-takeover-'));
  const env = { ...process.env, AGY_DADDY_TEST_MODE: '1', AGY_DADDY_STATE_DIR: root };
  let headlessProc = null;
  let launcherProc = null;

  const waitForFile = async (filePath, timeoutMs = 4000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fs.existsSync(filePath)) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    return false;
  };

  try {
    // 1. Start a headless daemon holding daemon.lock
    headlessProc = spawn(process.execPath, [CLI_JS, 'daemon', 'start'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const lockPath = path.join(root, 'daemon.lock');
    assert.equal(await waitForFile(lockPath), true, 'daemon.lock should be created by headless daemon');
    const oldPid = JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid;
    assert.equal(oldPid, headlessProc.pid);

    // 2. Start launcher (should gracefully take over daemon.lock without DAEMON_ALREADY_RUNNING error)
    launcherProc = spawn(process.execPath, [CLI_JS, 'launcher', '--skip-inject', '--json'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let launcherStdout = '';
    launcherProc.stdout.on('data', (d) => { launcherStdout += d.toString('utf8'); });

    const launcherLockPath = path.join(root, 'launcher.lock');
    assert.equal(await waitForFile(launcherLockPath, 5000), true, 'launcher.lock should be created after takeover');
    const launcherLock = JSON.parse(fs.readFileSync(launcherLockPath, 'utf8'));
    assert.equal(launcherLock.pid, launcherProc.pid);
    assert.equal(launcherLock.hasTray, true);
    const newDaemonLock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(newDaemonLock.pid, launcherProc.pid);
    assert.ok(launcherStdout.includes('"appName": "Agy-Daddy Launcher"'));

    // 3. Running launcher a second time returns alreadyRunning cleanly without spawning a duplicate tray
    const dupRes = spawnSync(process.execPath, [CLI_JS, 'launcher', '--skip-inject', '--json'], {
      env,
      encoding: 'utf8'
    });
    assert.equal(dupRes.status, 0, dupRes.stderr);
    const dupJson = JSON.parse(dupRes.stdout);
    assert.equal(dupJson.ok, true);
    assert.equal(dupJson.alreadyRunning, true);
    assert.equal(dupJson.hasTray, true);
    assert.equal(dupJson.pid, launcherProc.pid);
  } finally {
    if (launcherProc && !launcherProc.killed) {
      try { launcherProc.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 150));
      try { launcherProc.kill('SIGKILL'); } catch {}
    }
    if (headlessProc && !headlessProc.killed) {
      try { headlessProc.kill('SIGKILL'); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ensureMacTrayAppBundle：hash 标记置于 Resources 下，清理旧 Contents/.swift-hash 且签名验证通过', { skip: process.platform !== 'darwin' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-tray-bundle-'));
  const appPath = path.join(root, 'Agy-Daddy Launcher.app');
  try {
    const legacyHashPath = path.join(appPath, 'Contents', '.swift-hash');
    const legacyHelperApp = path.join(appPath, 'Contents', 'Helpers', 'Agy-Daddy Tray.app');
    fs.mkdirSync(path.dirname(legacyHashPath), { recursive: true });
    fs.writeFileSync(legacyHashPath, 'stale', 'utf8');
    fs.mkdirSync(legacyHelperApp, { recursive: true });

    const built = ensureMacTrayAppBundle({
      bundlePathOverride: appPath,
      stateDir: path.join(root, 'state'),
      skipRegister: true
    });
    assert.equal(built.ok, true);
    assert.equal(built.compiled, true);
    assert.equal(built.signed, true);
    assert.ok(fs.existsSync(built.exePath));
    assert.equal(fs.existsSync(legacyHashPath), false, 'Contents/.swift-hash must be removed before codesign');
    assert.equal(fs.existsSync(legacyHelperApp), false, 'Legacy Contents/Helpers/Agy-Daddy Tray.app must be removed');

    const resHashPath = path.join(appPath, 'Contents', 'Resources', 'swift-hash.txt');
    assert.ok(fs.existsSync(resHashPath), 'Hash marker should live inside Contents/Resources/swift-hash.txt');
    assert.equal(fs.readFileSync(resHashPath, 'utf8').trim(), built.srcHash);

    const infoPlist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8');
    assert.match(infoPlist, /<key>CFBundleIdentifier<\/key><string>dev\.agy-daddy\.launcher<\/string>/);
    assert.match(infoPlist, /<key>LSMinimumSystemVersion<\/key><string>14\.0<\/string>/);
    assert.match(infoPlist, /<key>NSHighResolutionCapable<\/key><true\/>/);

    const verify = spawnSync('/usr/bin/codesign', ['--verify', '--strict', appPath], { encoding: 'utf8' });
    assert.equal(verify.status, 0, verify.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hideTrayIcon：通过外观设置动态隐藏与恢复通知栏图标（不中断后台守护进程与插件），并在重启启动器时保持', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hide-tray-'));
  let controller = null;
  let controller2 = null;
  try {
    const backend = new MemoryTrayBackend();
    controller = createLauncherController({
      stateDir: root,
      plugins: [],
      trayBackend: backend,
      skipInject: true,
      disableWatchdog: true,
      daemonOptions: { port: 0 }
    });
    const started = await controller.start();
    assert.equal(started.ok, true);
    assert.equal(started.trayVisible, true);
    assert.equal(backend.started, true);
    assert.equal(controller.getState().trayStarted, true);
    assert.equal(controller.getState().trayVisible, true);

    const daemon = controller.getDaemon();
    const trayMgr = controller.getTrayManager();
    trayMgr.registerPluginMenuItem('demo.plugin', { id: 'p1', label: 'Demo Item' });
    await trayMgr.refreshMenu(true);
    assert.ok(backend.lastPayload.items.some((i) => i.label === 'Demo Item'));

    const postBridge = async (route, body) => {
      const resp = await fetch(`http://127.0.0.1:${started.port}${route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AGY-Host-Token': daemon.bridge.hostToken
        },
        body: JSON.stringify(body)
      });
      return await resp.json();
    };

    // 1. 隐藏通知栏图标 -> 托盘后端停止但守护进程与插件项保留
    const hideRes = await postBridge('/host/host-settings', { action: 'save', values: { hideTrayIcon: true } });
    assert.equal(hideRes.ok, true);
    assert.equal(hideRes.values.hideTrayIcon, true);
    assert.equal(backend.started, false);
    assert.equal(controller.getState().trayStarted, false);
    assert.equal(controller.getState().trayVisible, false);
    assert.equal(controller.getState().daemonRunning, true);

    const menuWhileHidden = await postBridge('/host/tray/menu', {});
    assert.equal(menuWhileHidden.ok, true);
    assert.equal(menuWhileHidden.visible, false);
    assert.equal(menuWhileHidden.started, false);
    assert.ok(menuWhileHidden.items.some((i) => i.label === 'Demo Item'));

    // 2. 恢复显示通知栏图标 -> 托盘后端重新拉起并恢复默认项与插件菜单
    const showRes = await postBridge('/host/host-settings', { action: 'save', values: { hideTrayIcon: false } });
    assert.equal(showRes.ok, true);
    assert.equal(showRes.values.hideTrayIcon, false);
    assert.equal(backend.started, true);
    assert.equal(controller.getState().trayStarted, true);
    assert.equal(controller.getState().trayVisible, true);
    assert.ok(backend.lastPayload.items.some((i) => i.label === 'Demo Item'));
    assert.ok(backend.lastPayload.items.some((i) => i.id === DEFAULT_TRAY_MENU_IDS.LAUNCH_ANTIGRAVITY));

    // 3. 设为隐藏并停止后重新创建启动器实例 -> 启动时保持隐藏，不拉起托盘后端
    await daemon.saveHostSettings({ hideTrayIcon: true });
    assert.equal(backend.started, false);
    await controller.stop();
    controller = null;

    const backend2 = new MemoryTrayBackend();
    controller2 = createLauncherController({
      stateDir: root,
      plugins: [],
      trayBackend: backend2,
      skipInject: true,
      disableWatchdog: true,
      daemonOptions: { port: 0 }
    });
    const started2 = await controller2.start();
    assert.equal(started2.ok, true);
    assert.equal(started2.trayVisible, false);
    assert.equal(backend2.started, false);
    assert.equal(controller2.getState().trayStarted, false);
    assert.equal(controller2.getState().trayVisible, false);
    assert.ok(started2.trayItems >= 4);
  } finally {
    if (controller) await controller.stop().catch(() => {});
    if (controller2) await controller2.stop().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
