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

test('主题引擎 5 预设 / 14 槽位 / 三态外观、5 分页设置中心与小红点状态', async () => {
  assert.equal(Object.keys(HEAT_PRESETS).length, 5);
  assert.equal(Object.keys(COLOR_SLOTS).length, 14);

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

    const applied = hostRuntime.setTheme('light', undefined, 'purple');
    assert.equal(applied.effectiveMode, 'light');
    assert.equal(applied.accent, '#7c3aed');
    assert.equal(seenTheme.heatPreset, 'purple');
    assert.equal(seenTheme.effectiveMode, 'light');

    // 打开设置中心并切换 5 个分页
    hostRuntime.toggleSettingsPanel(true);
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    for (const tabId of ['plugins', 'theme', 'health', 'manage', 'general']) {
      assert.ok(shadow.querySelector(`#agy-tab-${tabId}`), `Missing tab ${tabId}`);
    }
    shadow.querySelector('#agy-tab-theme').click();
    assert.ok(shadow.querySelector('#agy-theme-settings-card'));
    shadow.querySelector('#agy-preset-blue').click();
    assert.equal(seenTheme.heatPreset, 'blue');

    shadow.querySelector('#agy-tab-general').click();
    hostRuntime.setUpdateInfo({ hasUpdate: true, currentVersion: '1.0.0', latestVersion: '1.1.0' });
    assert.equal(shadow.querySelector('#agy-update-dot').hidden, false);
    shadow.querySelector('#agy-tab-general').click();
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
    assert.ok(fs.existsSync(launcher.infoPath));
    assert.ok(fs.existsSync(launcher.binPath));

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
