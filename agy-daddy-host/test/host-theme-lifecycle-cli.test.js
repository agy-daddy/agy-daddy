'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const HOST_ROOT = path.resolve(__dirname, '..');
const CLI_JS = path.join(HOST_ROOT, 'src', 'cli.js');

const { HEAT_PRESETS, COLOR_SLOTS, applyThemeVariables } = require('../src/renderer/theme');
const { createHostRuntime } = require('../src/renderer/host-runtime');
const { createMockDocument } = require('../sdk/mock-harness');
const { loadAnchorsRegistry } = require('../src/core/anchors');
const { bundlePluginRendererSource } = require('../src/core/injector');
const {
  generateMacLaunchAgentPlist,
  generateWindowsLauncherBat,
  generateLinuxSystemdUnit,
  installAutoStart,
  removeAutoStart,
  installMacLauncherApp,
  detectInsideAntigravitySession,
  planAntigravityRestart,
  checkAndPullGitUpdate
} = require('../src/core/lifecycle');
const { auditUpstreamsAndBaselines } = require('../src/core/upstreams');

test('主题引擎系统中性配色 / 14 槽位 / 三态外观、三段式设置中心与小红点状态', async () => {
  assert.ok(HEAT_PRESETS.system);
  assert.equal(Object.keys(COLOR_SLOTS).length, 14);
  for (const preset of Object.values(HEAT_PRESETS)) {
    assert.equal(/#a78bfa|#7c3aed/i.test(JSON.stringify(preset)), false);
  }

  const doc = createMockDocument();
  const hostRuntime = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    anchorsRegistry: loadAnchorsRegistry()
  });

  try {
    let seenTheme = null;
    await hostRuntime.mountPlugin('test.theme.listener', {
      mount(ctx) {
        ctx.state.subscribe('state:host.theme@1', (val) => { seenTheme = val; });
      }
    });

    const applied = hostRuntime.setTheme('light', undefined, 'system');
    assert.equal(applied.effectiveMode, 'light');
    assert.equal(applied.accent, '#18181b');
    assert.equal(seenTheme.heatPreset, 'system');
    assert.equal(seenTheme.effectiveMode, 'light');

    const appliedDark = hostRuntime.setTheme('dark', undefined, 'system');
    assert.equal(appliedDark.effectiveMode, 'dark');
    assert.equal(appliedDark.accent, '#e4e4e7');

    // 打开设置中心并验证两段式导航（通用 / 外观）及底部运行诊断区
    hostRuntime.toggleSettingsPanel(true);
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    for (const tabId of ['plugins', 'appearance']) {
      assert.ok(shadow.querySelector(`#agy-tab-${tabId}`), `Missing segment ${tabId}`);
    }
    assert.equal(shadow.querySelector('#agy-tab-plugins').textContent, '通用');
    assert.equal(shadow.querySelector('#agy-tab-appearance').textContent, '外观');
    assert.equal(shadow.querySelector('#agy-tab-diagnostics'), null);
    assert.equal(shadow.querySelector('#agy-tab-manage'), null);
    assert.equal(shadow.querySelector('#agy-tab-general'), null);
    assert.ok(shadow.querySelector('#agy-diagnostics-summary-card'));

    shadow.querySelector('#agy-tab-appearance').click();
    assert.equal(shadow.querySelector('#agy-theme-settings-card'), null);
    assert.equal(shadow.querySelector('#agy-appearance-mode-card'), null);
    assert.ok(shadow.querySelector('#agy-topbar-layout-card'));
    assert.ok(shadow.querySelector('#agy-general-settings-card'));

    hostRuntime.setUpdateInfo({ hasUpdate: true, currentVersion: '1.0.0', latestVersion: '1.1.0' });
    assert.equal(shadow.querySelector('#agy-update-dot').hidden, false);
    assert.match(shadow.querySelector('#agy-general-settings-card').textContent, /1\.1\.0/);
  } finally {
    await hostRuntime.dispose();
  }
});

test('bundlePluginRendererSource 可零依赖内联 zh-cn 全部词典供真实 CDP 页面执行', () => {
  const zhPluginDir = path.resolve(HOST_ROOT, '..', 'agy-daddy-plugin-zh-cn');
  const bundled = bundlePluginRendererSource(path.join(zhPluginDir, 'src', 'renderer.js'), zhPluginDir);
  assert.ok(bundled.length > 50000);
  const sandbox = { module: { exports: {} }, exports: {}, console };
  sandbox.exports = sandbox.module.exports;
  vm.runInNewContext(bundled, sandbox, { filename: 'zh-cn-browser-bundle.js' });
  assert.equal(typeof sandbox.module.exports.mount, 'function');
  assert.equal(typeof sandbox.module.exports.dispose, 'function');
});

test('lifecycle 跨平台自启/桌面启动器、防自杀重启守卫、git 洁净更新与 upstreams 审计', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ws3-life-'));
  try {
    const plist = generateMacLaunchAgentPlist({ username: 'tester', logDir: path.join(root, 'logs') });
    assert.match(plist, /com\.tester\.agy-daddyd/);
    assert.match(plist, /AGY_DADDY_LAUNCHD/);
    assert.doesNotMatch(plist, /\/opt\/homebrew\/opt\/node@22/);

    const winBat = generateWindowsLauncherBat({ proxyUrl: 'http://127.0.0.1:18766' });
    assert.match(winBat, /ELECTRON_RUN_AS_NODE=1/);
    assert.match(winBat, /--remote-debugging-port=0/);

    const sysd = generateLinuxSystemdUnit({});
    assert.match(sysd, /ExecStart=/);

    const installed = installAutoStart({ platform: 'darwin', username: 'tester', targetDir: root });
    assert.equal(installed.ok, true);
    assert.ok(fs.existsSync(installed.filePath));
    const removed = removeAutoStart({ username: 'tester', targetDir: root });
    assert.equal(removed.removed, true);

    const launcher = installMacLauncherApp({ targetDir: root });
    assert.equal(launcher.ok, true);
    assert.equal(launcher.appName, 'Agy-Daddy Launcher.app');
    assert.ok(fs.existsSync(launcher.infoPath));
    assert.ok(fs.existsSync(launcher.binPath));
    assert.ok(fs.existsSync(launcher.iconPath));
    const infoPlist = fs.readFileSync(launcher.infoPath, 'utf8');
    assert.match(infoPlist, /<key>CFBundleDisplayName<\/key><string>Agy-Daddy Launcher<\/string>/);
    assert.match(infoPlist, /<key>CFBundleIconFile<\/key><string>AgyDaddyLauncher<\/string>/);
    assert.match(infoPlist, /<key>LSMinimumSystemVersion<\/key><string>14\.0<\/string>/);
    assert.match(infoPlist, /<key>NSHighResolutionCapable<\/key><true\/>/);

    assert.equal(detectInsideAntigravitySession({ ANTIGRAVITY_AGENT: '1' }), true);
    const blocked = planAntigravityRestart({ env: { ANTIGRAVITY_AGENT: '1' } });
    assert.equal(blocked.blocked, true);
    const allowed = planAntigravityRestart({ env: {} });
    assert.equal(allowed.ok, true);
    assert.ok(allowed.args.includes('--remote-debugging-port=0'));

    // Dirty git worktree 阻止更新
    const fakeRepo = path.join(root, 'repo');
    fs.mkdirSync(fakeRepo, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: fakeRepo });
    fs.writeFileSync(path.join(fakeRepo, 'dirty.txt'), 'x');
    const updRes = checkAndPullGitUpdate(fakeRepo, { dryRun: true });
    assert.equal(updRes.error, 'DIRTY_WORKTREE');

    const up = auditUpstreamsAndBaselines({ hostRoot: HOST_ROOT, workspaceRoot: path.resolve(HOST_ROOT, '..') });
    assert.equal(up.ok, true);
    assert.equal(up.upstreamsCount, 6);
    assert.ok(up.pluginBaselines.length >= 9);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI 新增运维与多仓开发命令冒烟验证 (upstreams / auto-on --dry-run / remote / dev)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ws3-cli-'));
  const env = { ...process.env, AGY_DADDY_TEST_MODE: '1', AGY_DADDY_STATE_DIR: root };
  try {
    for (const args of [
      ['upstreams', '--json'],
      ['auto-on', '--dry-run'],
      ['remote', '--reset-token'],
      ['dev', 'capture-fixture', '--version', '2.33.0'],
      ['dev', 'smoke']
    ]) {
      const r = spawnSync(process.execPath, [CLI_JS, ...args], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, `${args.join(' ')} failed: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.ok, true);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('顶栏 Popover 同步创建 Light-DOM browser occluder、调用 setPortalOverlayOpen 并在外部弹窗打开时降级让位', async () => {
  const prevMo = globalThis.MutationObserver;
  const observerInstances = [];
  globalThis.MutationObserver = class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      observerInstances.push(this);
    }
    observe() {}
    disconnect() {}
  };

  const doc = createMockDocument();
  const portalCalls = [];
  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    location: { href: 'https://127.0.0.1:51410/' },
    electronNative: {
      wcvBrowser: {
        setPortalOverlayOpen(open) {
          portalCalls.push(Boolean(open));
          return Promise.resolve();
        }
      }
    }
  };

  const hostRuntime = createHostRuntime({
    document: doc,
    window: win,
    anchorsRegistry: loadAnchorsRegistry()
  });

  try {
    let popHandle = null;
    await hostRuntime.mountPlugin('test.occluder.plugin', {
      mount(ctx) {
        popHandle = ctx.topbar.registerPopover({ id: 'remote-panel', title: '远程访问' });
      }
    });

    const hostEl = doc.getElementById('agy-daddy-host');
    assert.ok(hostEl);
    assert.equal(doc.getElementById('agy-popover-browser-occluder'), null);

    // 1. 打开 Popover：应在 Light DOM 创建并显示 occluder，且调用 setPortalOverlayOpen(true)
    popHandle.toggle(true);
    const occluder = doc.getElementById('agy-popover-browser-occluder');
    assert.ok(occluder, 'Expected Light-DOM browser occluder element');
    assert.equal(occluder.getAttribute('data-browser-occluder'), 'true');
    assert.equal(occluder.hidden, false);
    assert.equal(hostEl.getAttribute('data-elevated'), 'true');
    assert.ok(parseFloat(occluder.style.getPropertyValue('width')) >= 240);
    assert.ok(parseFloat(occluder.style.getPropertyValue('height')) >= 200);
    assert.deepEqual(portalCalls, [true]);

    // 2. 关闭 Popover：隐藏 occluder 并释放 setPortalOverlayOpen(false)
    popHandle.toggle(false);
    assert.equal(occluder.hidden, true);
    assert.equal(hostEl.getAttribute('data-elevated'), 'false');
    assert.deepEqual(portalCalls, [true, false]);

    // 3. 再次打开后，外部原生弹窗 [role="dialog"] 出现时自动让位 (data-under-dialog="true") 并收起 Popover
    popHandle.toggle(true);
    assert.equal(occluder.hidden, false);
    const extDialog = doc.createElement('div');
    extDialog.setAttribute('role', 'dialog');
    doc.body.appendChild(extDialog);
    for (const obs of observerInstances) obs.cb();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hostEl.getAttribute('data-under-dialog'), 'true');
    assert.equal(occluder.hidden, true);

    // 4. 弹窗关闭后恢复层级
    extDialog.remove();
    for (const obs of observerInstances) obs.cb();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(hostEl.getAttribute('data-under-dialog'), 'false');

    // 5. dispose 后彻底清理 Light-DOM occluder
    await hostRuntime.dispose();
    assert.equal(doc.getElementById('agy-popover-browser-occluder'), null);
  } finally {
    await hostRuntime.dispose();
    if (prevMo === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = prevMo;
  }
});
