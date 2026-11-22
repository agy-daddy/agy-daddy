'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const {
  TERMINAL_CATALOG,
  getWindowsHelperPath,
  extractWorkspaceFromBrainDir,
  escapePosixArg,
  toWslPath,
  sanitizeMuxHost,
  detectAvailableTerminals,
  buildLaunchPlan
} = require('../src/terminals');

test('terminals: 参数转义、muxHost 防注入校验与 macOS/Windows/Rex/WezTerm 启动计划', () => {
  assert.equal(escapePosixArg("a'b"), "'a'\\''b'");
  assert.equal(toWslPath('D:\\work\\repo'), '/mnt/d/work/repo');
  assert.equal(sanitizeMuxHost('localhost'), '');
  assert.equal(sanitizeMuxHost('dev@10.0.0.5:22'), 'dev@10.0.0.5:22');
  assert.equal(sanitizeMuxHost('evil; rm -rf /'), null);
  assert.equal(sanitizeMuxHost('-oProxyCommand=bad'), null);

  assert.throws(() => buildLaunchPlan({ muxHost: 'bad host; id' }), /Unsafe muxHost rejected/);

  const macRex = buildLaunchPlan({
    platform: 'darwin',
    terminalApp: 'rex',
    cwd: '/tmp/proj',
    muxHost: 'devbox',
    cliSkipPermissions: true,
    cliDefaultModel: 'gemini-4'
  });
  assert.equal(macRex.executable, 'rex');
  assert.deepEqual(macRex.args.slice(0, 4), ['run', '--host', 'devbox', '--']);
  assert.equal(macRex.env.COLORTERM, 'truecolor');

  const winPlan = buildLaunchPlan({
    platform: 'win32',
    terminalApp: 'wt',
    cwd: 'C:\\repo',
    cliSkipPermissions: true
  });
  assert.equal(winPlan.executable, 'wt.exe');
  assert.ok(winPlan.args.includes('powershell.exe'));

  const detectedWin = detectAvailableTerminals({
    platform: 'win32',
    env: { PATH: 'C:\\Windows\\System32' },
    existsSync: () => true
  });
  assert.ok(detectedWin.some((t) => t.id === 'wt'));

  // 13 终端全集 + cmux + WSL + cli-window-helper.cs + Brain 映射提取
  assert.equal(TERMINAL_CATALOG.length, 13);
  assert.ok(TERMINAL_CATALOG.includes('cmux'));
  assert.ok(fs.existsSync(getWindowsHelperPath()));
  const wslPlan = buildLaunchPlan({ platform: 'win32', terminalApp: 'wsl', cwd: 'D:\\repo' });
  assert.equal(wslPlan.executable, 'wsl.exe');
  assert.equal(wslPlan.cwd, '/mnt/d/repo');

  const tmpBrain = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cli-brain-'));
  try {
    const sessDir = path.join(tmpBrain, 'sess-xyz123');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'metadata.json'), JSON.stringify({ workspaceUri: 'file:///tmp/my-app' }));
    assert.equal(extractWorkspaceFromBrainDir(tmpBrain, 'sess-xyz123'), '/tmp/my-app');
  } finally {
    fs.rmSync(tmpBrain, { recursive: true, force: true });
  }
});

test('插件契约：隔离世界 CLI 胶囊、可选 proxy.getCliEnv 合并与无代理降级、零泄漏 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
  }

  const harness = createMockHostHarness();
  try {
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.ok(harness.isolatedWorlds.has('agy-daddy.cli'));

    const cliSvc = harness.bus.getServiceProxy('cli');
    // 1. 无 proxy 插件时仍正常工作
    const dry1 = await cliSvc.launch({ cwd: '/tmp/demo' });
    assert.equal(dry1.ok, true);
    assert.equal(dry1.dryRun, true);
    assert.equal(dry1.plan.env.ELECTRON_RUN_AS_NODE, undefined);

    // 2. 注入可选 proxy.getCliEnv 后自动继承代理环境变量
    harness.bus.provideService('agy-daddy.proxy', 'proxy', {
      getCliEnv: (base) => ({ ...base, HTTP_PROXY: 'http://127.0.0.1:18766', HTTPS_PROXY: 'http://127.0.0.1:18766', COLORTERM: 'truecolor' })
    }, { realm: 'node' });

    const dry2 = await cliSvc.launch({ cwd: '/tmp/demo' });
    assert.equal(dry2.plan.env.HTTP_PROXY, 'http://127.0.0.1:18766');
    assert.equal(dry2.plan.env.COLORTERM, 'truecolor');

    const barChildren = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot.querySelector('#agy-topbar-slots').children;
    assert.ok(barChildren.some((c) => c.id === 'agy-unit-agy-daddy.cli-cli'));

    await harness.unloadPlugin('agy-daddy.cli');
    harness.assertCleanDispose('agy-daddy.cli');
  } finally {
    await harness.cleanup();
  }
});
