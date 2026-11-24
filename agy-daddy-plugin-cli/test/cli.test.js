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
  CLI_PERMISSION_MODES,
  resolvePermissionArgs,
  parseQuickCommands,
  formatCliArgToken,
  buildDefaultCliCommand,
  detectRexAppPath,
  getWindowsHelperPath,
  normalizeWorkspacePath,
  extractWorkspacesFromTrajectory,
  resolveWorkspaceFromTrajectories,
  extractWorkspaceFromBrainDir,
  escapePosixArg,
  toWslPath,
  sanitizeMuxHost,
  detectAvailableTerminals,
  detectTerminalPath,
  verifyTerminalPath,
  listSshMuxHosts,
  buildLaunchPlan
} = require('../src/terminals');

test('terminals: 参数转义、权限模式、路径检测/自定义路径、SSH发现与任意快捷命令', () => {
  assert.equal(escapePosixArg("a'b"), "'a'\\''b'");
  assert.equal(toWslPath('D:\\work\\repo'), '/mnt/d/work/repo');
  assert.equal(sanitizeMuxHost('localhost'), '');
  assert.equal(sanitizeMuxHost('dev@10.0.0.5:22'), 'dev@10.0.0.5:22');
  assert.equal(sanitizeMuxHost('evil; rm -rf /'), null);
  assert.equal(sanitizeMuxHost('-oProxyCommand=bad'), null);

  assert.throws(() => buildLaunchPlan({ muxHost: 'bad host; id' }), /Unsafe muxHost rejected/);

  // 权限模式全集
  assert.deepEqual(CLI_PERMISSION_MODES, ['default', 'plan', 'accept-edits', 'auto', 'skip-permissions']);
  assert.deepEqual(resolvePermissionArgs({ cliPermissionMode: 'default' }), []);
  assert.deepEqual(resolvePermissionArgs({ cliPermissionMode: 'plan' }), ['--mode', 'plan']);
  assert.deepEqual(resolvePermissionArgs({ cliPermissionMode: 'accept-edits' }), ['--mode', 'accept-edits']);
  assert.deepEqual(resolvePermissionArgs({ cliPermissionMode: 'auto' }), ['--mode', 'auto']);
  assert.deepEqual(resolvePermissionArgs({ cliPermissionMode: 'skip-permissions' }), ['--dangerously-skip-permissions']);
  assert.deepEqual(resolvePermissionArgs({ cliSkipPermissions: true }), ['--dangerously-skip-permissions']);

  const macRex = buildLaunchPlan({
    platform: 'darwin',
    terminalApp: 'rex',
    cwd: '/tmp/proj',
    muxHost: 'devbox',
    cliPermissionMode: 'auto',
    cliDefaultModel: 'gemini-4',
    existsSync: (p) => p === '/Applications/Rex Beta.app'
  });
  assert.equal(macRex.executable, 'rex');
  assert.deepEqual(macRex.args.slice(0, 6), ['-S', 'devbox', 'run', '--interactive', '--keep-open', '-c']);
  assert.equal(macRex.args[6], '/tmp/proj');
  assert.equal(macRex.args[7], '--');
  assert.equal(macRex.activateApp, '/Applications/Rex Beta.app');
  assert.match(macRex.args.join(' '), /--mode/);
  assert.match(macRex.args.join(' '), /auto/);
  assert.equal(macRex.env.COLORTERM, 'truecolor');

  // macOS Terminal.app & iTerm2 activate 前置窗口唤起
  const macTerm = buildLaunchPlan({ platform: 'darwin', terminalApp: 'terminal', cwd: '/tmp/proj' });
  assert.equal(macTerm.executable, 'osascript');
  assert.match(macTerm.args.join(' '), /tell application "Terminal" to activate/);
  const macIterm = buildLaunchPlan({ platform: 'darwin', terminalApp: 'iterm2', cwd: '/tmp/proj' });
  assert.match(macIterm.args.join(' '), /tell application "iTerm" to activate/);

  // formatCliArgToken & buildDefaultCliCommand 参数拼接与特殊字符边缘情况
  assert.equal(formatCliArgToken(''), '');
  assert.equal(formatCliArgToken('gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(formatCliArgToken("my 'weird' $model;id"), "'my '\\''weird'\\'' $model;id'");
  assert.equal(buildDefaultCliCommand(null), 'agy');
  assert.equal(buildDefaultCliCommand({ cliPermissionMode: 'default', cliDefaultModel: '' }), 'agy');
  assert.equal(buildDefaultCliCommand({ cliPermissionMode: 'plan', cliDefaultModel: 'gemini-3-pro' }), 'agy --mode plan --model gemini-3-pro');
  assert.equal(buildDefaultCliCommand({ cliPermissionMode: 'skip-permissions', cliDefaultModel: '模型 a b' }), "agy --dangerously-skip-permissions --model '模型 a b'");
  assert.equal(detectRexAppPath({ homeDir: '/Users/nobody', existsSync: (p) => p === '/Applications/Rex.app' }), '/Applications/Rex.app');

  // customTerminalPath 生效：.app 与二进制路径
  const customGhosttyApp = buildLaunchPlan({
    platform: 'darwin',
    terminalApp: 'ghostty',
    customTerminalPath: '/Users/demo/Apps/Ghostty.app',
    cwd: '/tmp/proj'
  });
  assert.equal(customGhosttyApp.executable, 'open');
  assert.equal(customGhosttyApp.args[1], '/Users/demo/Apps/Ghostty.app');

  const customGhosttyBin = buildLaunchPlan({
    platform: 'darwin',
    terminalApp: 'ghostty',
    customTerminalPath: '/opt/homebrew/bin/ghostty',
    cwd: '/tmp/proj'
  });
  assert.equal(customGhosttyBin.executable, '/opt/homebrew/bin/ghostty');

  // 任意终端命令启动计划（不注入 agy 的 model/mode/skip-permissions）
  const customCmdPlan = buildLaunchPlan({
    platform: 'darwin',
    terminalApp: 'wezterm',
    cwd: '/tmp/proj',
    cliPermissionMode: 'skip-permissions',
    cliDefaultModel: 'gemini-2.5-pro',
    rawCommand: 'claude --continue'
  });
  assert.equal(customCmdPlan.isCustomCommand, true);
  assert.equal(customCmdPlan.executable, 'wezterm');
  assert.deepEqual(customCmdPlan.args, ['start', '--cwd', '/tmp/proj', '--', 'sh', '-lc', 'claude --continue']);

  const winPlan = buildLaunchPlan({
    platform: 'win32',
    terminalApp: 'wt',
    cwd: 'C:\\repo',
    cliSkipPermissions: true
  });
  assert.equal(winPlan.executable, 'wt.exe');
  assert.ok(winPlan.args.includes('powershell.exe'));

  const winCustomPlan = buildLaunchPlan({
    platform: 'win32',
    terminalApp: 'wt',
    cwd: 'C:\\repo',
    rawCommand: 'codex --full-auto'
  });
  assert.equal(winCustomPlan.isCustomCommand, true);
  assert.match(winCustomPlan.args[winCustomPlan.args.length - 1], /codex --full-auto/);
  assert.equal(winCustomPlan.args[winCustomPlan.args.length - 1].includes('agy'), false);

  // 实际终端路径检测与校验
  const hitRes = detectTerminalPath('ghostty', {
    platform: 'darwin',
    env: { PATH: '' },
    existsSync: (p) => p === '/Applications/Ghostty.app'
  });
  assert.equal(hitRes.found, true);
  assert.equal(hitRes.path, '/Applications/Ghostty.app');

  const missRes = detectTerminalPath('warp', {
    platform: 'darwin',
    env: { PATH: '' },
    existsSync: () => false
  });
  assert.equal(missRes.found, false);
  assert.match(missRes.error, /未检测到 Warp/);

  const verifyHit = verifyTerminalPath('/opt/bin/rex', { existsSync: (p) => p === '/opt/bin/rex' });
  assert.equal(verifyHit.found, true);
  const verifyMiss = verifyTerminalPath('/nope/rex', { existsSync: () => false });
  assert.equal(verifyMiss.found, false);

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

  // SSH config 解析
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cli-ssh-'));
  try {
    const sshCfg = path.join(tmpDir, 'config');
    fs.writeFileSync(sshCfg, [
      'Host *',
      '  ServerAliveInterval 60',
      'Host dev-box gpu-01',
      '  HostName 10.0.0.8',
      '  User alice',
      'Host localhost',
      '  HostName 127.0.0.1'
    ].join('\n'));
    const muxHosts = listSshMuxHosts({ sshConfigPath: sshCfg });
    assert.deepEqual(muxHosts.map((h) => h.value), ['dev-box', 'gpu-01']);
    assert.equal(muxHosts[0].description, 'alice@10.0.0.8');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // parseQuickCommands
  const parsedQuick = parseQuickCommands([
    JSON.stringify({ name: 'Claude', command: 'claude --continue', pinToTopbar: true }),
    JSON.stringify({ name: 'Dev', command: 'npm run dev', pinToTopbar: false }),
    'htop'
  ]);
  assert.equal(parsedQuick.length, 3);
  assert.equal(parsedQuick[0].name, 'Claude');
  assert.equal(parsedQuick[1].pinToTopbar, false);
  assert.equal(parsedQuick[2].name, 'htop');

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

test('插件契约：isolated 世界 iconSvg 胶囊、权限模式、路径检测、动态选项、自定义快捷命令与零泄漏 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
  }
  const rendererSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', 'renderer.js'), 'utf8');
  assert.equal(/registerSection/.test(rendererSrc), false, 'Renderer must not use deprecated registerSection');

  const harness = createMockHostHarness({
    onRpc: (method) => {
      if (method === 'GetAvailableModels') {
        return {
          models: {
            'gemini-4-neon': { model: 'gemini-4-neon', displayName: 'Gemini 4 Neon' }
          }
        };
      }
      return {};
    }
  });
  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.equal(loaded.manifest.world, 'isolated');
    assert.equal(loaded.trust.world, 'isolated');
    assert.equal(loaded.manifest.permissions.includes('page:main-world'), false);
    assert.equal('migrations' in (loaded.manifest.contributes || {}), false);
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

    // 3. 动态模型与路径检测命令
    const modelsRes = await harness.executeCommand('cli.listModels', [{}]);
    assert.equal(modelsRes.ok, true);
    assert.ok(modelsRes.options.some((o) => o.value === 'gemini-4-neon'));
    assert.ok(modelsRes.options.some((o) => o.value === 'gemini-2.5-pro'));

    const detectMiss = await harness.executeCommand('cli.detectTerminalPath', [{
      trigger: 'watch',
      values: { terminalApp: 'kitty' },
      env: { PATH: '' },
      existsSync: () => false
    }]);
    assert.equal(detectMiss.found, false);
    assert.match(detectMiss.error, /未检测到 Kitty/);

    // 3.5 默认命令生成命令与 spawn 失败不崩溃守护进程
    const builtCmdRes = await harness.executeCommand('cli.buildDefaultCommand', [{
      values: { cliDefaultModel: 'gemini-4-neon', cliPermissionMode: 'skip-permissions' }
    }]);
    assert.equal(builtCmdRes.ok, true);
    assert.equal(builtCmdRes.value, 'agy --dangerously-skip-permissions --model gemini-4-neon');

    const failSpawnRes = await cliSvc.launch({
      testRealSpawn: true,
      terminalApp: 'rex',
      customTerminalPath: '/nonexistent/path/to/missing-rex-binary-999',
      cwd: '/tmp/demo'
    });
    assert.equal(failSpawnRes.ok, false);
    assert.match(failSpawnRes.error, /ENOENT|SPAWN_FAILED|no such file/i);

    // 4. 托管配置实时生效：权限模式 + 默认按钮名 + 可编辑默认命令 + 自定义快捷命令（1 个固定顶栏、1 个收纳进菜单）
    const updRes = await harness.updatePluginSettings('agy-daddy.cli', {
      terminalApp: 'rex',
      cliMuxHost: 'devbox',
      cliLabel: 'Agent终端',
      cliDefaultModel: 'gemini-4-neon',
      cliPermissionMode: 'skip-permissions',
      cliDefaultCommand: 'agy --dangerously-skip-permissions --model gemini-4-neon --sandbox',
      quickCommands: [
        JSON.stringify({ name: 'Claude', command: 'claude --continue', pinToTopbar: true }),
        JSON.stringify({ name: 'Dev', command: 'npm run dev', pinToTopbar: false })
      ]
    });
    assert.equal(updRes.ok, true);

    const cmdRes = await harness.executeCommand('cli.launch', [{ cwd: '/tmp/demo', platform: 'darwin' }]);
    assert.equal(cmdRes.ok, true);
    assert.equal(cmdRes.dryRun, true);
    assert.equal(cmdRes.plan.executable, 'rex');
    assert.deepEqual(cmdRes.plan.args.slice(0, 8), ['-S', 'devbox', 'run', '--interactive', '--keep-open', '-c', '/tmp/demo', '--']);
    const joinedArgs = cmdRes.plan.args.join(' ');
    assert.match(joinedArgs, /--model gemini-4-neon --sandbox/);
    assert.match(joinedArgs, /--dangerously-skip-permissions/);

    // 清空 cliDefaultCommand 并切换为 auto 模式 -> 安全回退动态拼参
    await harness.updatePluginSettings('agy-daddy.cli', { cliPermissionMode: 'auto', cliDefaultCommand: '' });
    const autoRes = await harness.executeCommand('cli.launch', [{ cwd: '/tmp/demo', platform: 'darwin' }]);
    assert.match(autoRes.plan.args.join(' '), /--mode.*auto/);

    // 等待隔离世界同步顶栏胶囊与弹出面板
    await new Promise((r) => setTimeout(r, 40));

    // 5. 顶栏按钮：自定义名称的主 CLI 胶囊 + 固定在顶栏的 Claude 快捷胶囊，未固定的 Dev 在 Popover 中
    const shadow = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
    const barChildren = shadow.querySelector('#agy-topbar-slots').children;
    const cliBtn = barChildren.find((c) => c.id === 'agy-unit-agy-daddy.cli-cli');
    assert.ok(cliBtn);
    const iconSpan = cliBtn.querySelector('.ag-unit-icon');
    assert.ok(iconSpan);
    assert.match(iconSpan.innerHTML, /<svg\b/);
    assert.equal(cliBtn.querySelector('.ag-unit-label')?.textContent, 'Agent终端');

    const quickBtn = barChildren.find((c) => c.id === 'agy-unit-agy-daddy.cli-quick-0');
    assert.ok(quickBtn);
    assert.equal(quickBtn.querySelector('.ag-unit-label')?.textContent, 'Claude');
    assert.equal(barChildren.find((c) => c.id === 'agy-unit-agy-daddy.cli-quick-1'), undefined);

    // Popover 存在并包含自定义默认按钮与未固定的 Dev 命令
    const popSlot = shadow.querySelector('[data-agy-slot="popover:agy-daddy.cli:cli-launcher"]');
    assert.ok(popSlot);
    assert.equal(popSlot.querySelector('[data-cli-launch-default="true"]')?.textContent, '启动 Agent终端');
    assert.match(popSlot.textContent, /Dev/);
    assert.match(popSlot.textContent, /npm run dev/);

    // 修改已配置快捷命令的名称与命令后，顶栏胶囊标题实时热更新且点击仍正常响应
    await harness.updatePluginSettings('agy-daddy.cli', {
      cliDefaultCommand: 'agy --mode auto --model gemini-4-neon',
      quickCommands: [
        JSON.stringify({ name: 'ClaudeCode', command: 'claude --resume', pinToTopbar: true }),
        JSON.stringify({ name: 'Dev', command: 'npm run dev', pinToTopbar: false })
      ]
    });
    await new Promise((r) => setTimeout(r, 40));
    const updatedQuickBtn = shadow.querySelector('#agy-topbar-slots').children.find((c) => c.id === 'agy-unit-agy-daddy.cli-quick-0');
    assert.ok(updatedQuickBtn);
    assert.equal(updatedQuickBtn.querySelector('.ag-unit-label')?.textContent, 'ClaudeCode');
    assert.equal(updatedQuickBtn.getAttribute('title'), 'claude --resume');

    // 验证配置保存后点击顶栏主按钮与自定义快捷按钮均能正常触发 Popover / Launch
    const launchedBodies = [];
    const origLaunch = harness.bridge.pluginRoutes.get('agy-daddy.cli:/launch');
    harness.bridge.registerPluginRoute('agy-daddy.cli', '/launch', async (body, ctx) => {
      launchedBodies.push(body);
      return origLaunch ? await origLaunch(body, ctx) : { ok: true };
    });
    updatedQuickBtn.click();
    cliBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(launchedBodies.some((b) => b.rawCommand === 'claude --resume' && b.commandName === 'ClaudeCode'), true);
    const cliPopoverEl = shadow.querySelector('[data-agy-popover="agy-daddy.cli:cli-launcher"]');
    assert.equal(cliPopoverEl.hidden, false);

    // 6. 私有 /settings 路由已移除
    const removedResp = await fetch(`http://127.0.0.1:${bridgePort}/plugins/agy-daddy.cli/settings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AGY-Plugin-Token': loaded.pluginToken
      },
      body: JSON.stringify({ action: 'get' })
    });
    assert.equal(removedResp.status, 404);

    await harness.unloadPlugin('agy-daddy.cli');
    harness.assertCleanDispose('agy-daddy.cli');
  } finally {
    await harness.cleanup();
  }
});

test('工作区路径规范化与多信号探测（RPC + 点击时 DOM 采集 + 多窗口消歧 + worktree 选择）', async () => {
  // 1. normalizeWorkspacePath
  assert.equal(normalizeWorkspacePath('file:///Volumes/external/Projects/agy-daddy/'), '/Volumes/external/Projects/agy-daddy');
  assert.equal(normalizeWorkspacePath('file:///tmp/%E4%B8%AD%E6%96%87%20project/'), '/tmp/中文 project');
  assert.equal(normalizeWorkspacePath('file:///C:/Users/demo/repo/', { platform: 'win32' }), 'C:\\Users\\demo\\repo');
  assert.equal(normalizeWorkspacePath('~/work/demo/', { platform: 'darwin', homeDir: '/Users/alice' }), '/Users/alice/work/demo');
  assert.equal(normalizeWorkspacePath('./sub/dir'), path.resolve('./sub/dir'));
  assert.equal(normalizeWorkspacePath(''), null);

  // 2. extractWorkspacesFromTrajectory
  const sampleSummary = {
    workspaces: [
      { workspaceFolderAbsoluteUri: 'file:///tmp/ws-main' },
      { gitRootAbsoluteUri: 'file:///tmp/ws-main' },
      { workspaceFolderAbsoluteUri: 'file:///tmp/ws-worktree' }
    ],
    trajectoryMetadata: {
      workspaceUris: ['file:///tmp/ws-main', 'file:///tmp/ws-extra']
    }
  };
  assert.deepEqual(extractWorkspacesFromTrajectory(sampleSummary), [
    '/tmp/ws-main',
    '/tmp/ws-worktree',
    '/tmp/ws-extra'
  ]);

  // 3. resolveWorkspaceFromTrajectories: 多窗口相同 lastUserViewTime 下通过点击时 DOM 消歧 + worktree 选择
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ws-alpha-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ws-beta-'));
  const dirBWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ws-beta-wt-'));
  try {
    const dirBBase = path.basename(dirB);
    const dirBWtBase = path.basename(dirBWorktree);
    const summaries = {
      '11111111-1111-1111-1111-111111111111': {
        summary: 'Alpha Task',
        lastModifiedTime: '2026-11-23T15:40:00Z',
        annotations: { title: 'Alpha Feature', lastUserViewTime: '2026-11-23T15:45:00Z' },
        workspaces: [{ workspaceFolderAbsoluteUri: `file://${dirA}` }]
      },
      '22222222-2222-2222-2222-222222222222': {
        summary: 'Beta Task',
        lastModifiedTime: '2026-11-23T15:41:00Z',
        annotations: { title: 'Beta Feature', lastUserViewTime: '2026-11-23T15:45:00Z' },
        workspaces: [
          { workspaceFolderAbsoluteUri: `file://${dirB}` },
          { workspaceFolderAbsoluteUri: `file://${dirBWorktree}` }
        ]
      }
    };

    // 3a. 精确 cascadeId 匹配
    const byId = resolveWorkspaceFromTrajectories(summaries, {
      cascadeId: '11111111-1111-1111-1111-111111111111'
    });
    assert.equal(byId.cwd, dirA);
    assert.equal(byId.source, 'rpc-cascade');

    // 3b. 无 cascadeId 时，通过激活会话标题匹配 Alpha 窗口
    const byTitle = resolveWorkspaceFromTrajectories(summaries, {
      workspaceHints: { activeConversationTitle: 'Alpha Feature' }
    });
    assert.equal(byTitle.cwd, dirA);
    assert.equal(byTitle.source, 'rpc-dom-title');

    // 3c. 通过标题栏工作区 basename 匹配 Beta 的 worktree
    const byWtName = resolveWorkspaceFromTrajectories(summaries, {
      workspaceHints: { pageTitle: `${dirBWtBase} — Antigravity`, workspaceNameHints: [dirBWtBase] }
    });
    assert.equal(byWtName.cwd, dirBWorktree);
    assert.equal(byWtName.source, 'rpc-dom-workspace-name');

    // 3d. 无 hint 且同 viewTime 时，回退最近 modifiedTime（dirB 主工作区）
    const byLatest = resolveWorkspaceFromTrajectories(summaries, {
      workspaceHints: { workspaceNameHints: [dirBBase] }
    });
    assert.equal(byLatest.cwd, dirB);

    // 3e. DOM 显式绝对路径最高优先级（自动过滤不存在路径）
    const byDomPath = resolveWorkspaceFromTrajectories(summaries, {
      cascadeId: '11111111-1111-1111-1111-111111111111',
      workspaceHints: { domPaths: ['/nonexistent/agy-missing-path-xyz', dirBWorktree] }
    });
    assert.equal(byDomPath.cwd, dirBWorktree);
    assert.equal(byDomPath.source, 'dom-path');

    // 4. 端到端：点击顶栏默认启动按钮（不传 cwd、无 brain metadata.json）-> 探测到当前项目绝对路径
    const harness = createMockHostHarness({
      onRpc: (method, params) => {
        if (method === 'GetAllCascadeTrajectories') {
          return { trajectorySummaries: summaries };
        }
        if (method === 'GetCascadeTrajectory' && params?.cascadeId === '11111111-1111-1111-1111-111111111111') {
          return { trajectory: { metadata: { workspaces: [{ workspaceFolderAbsoluteUri: `file://${dirA}` }] } } };
        }
        return {};
      }
    });

    try {
      const { port: bridgePort } = await harness.bridge.start(0);
      harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
      await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

      // 构造当前窗口标题与激活侧边栏行（URL 不含 cascadeId）
      harness.mockDoc.title = `${dirBBase} — Antigravity`;
      const sidebarRow = harness.mockDoc.createElement('div');
      sidebarRow.setAttribute('data-testid', 'conversation-row-sidebar');
      sidebarRow.setAttribute('aria-selected', 'true');
      sidebarRow.textContent = 'Beta Feature';
      harness.mockDoc.body.appendChild(sidebarRow);

      // 不传 cwd，调用默认 cli.launch（分别验证默认拼接命令与自定义 cliDefaultCommand）
      const defaultCmdLaunch = await harness.executeCommand('cli.launch', [{
        platform: 'darwin',
        terminalApp: 'terminal',
        workspaceHints: { activeConversationTitle: 'Beta Feature', pageTitle: `${dirBBase} — Antigravity` }
      }]);
      assert.equal(defaultCmdLaunch.ok, true);
      assert.equal(defaultCmdLaunch.cwd, dirB);
      assert.equal(defaultCmdLaunch.plan.cwd, dirB);
      assert.match(defaultCmdLaunch.plan.args.join(' ').replace(/\\\\/g, '\\'), new RegExp(`cd '${dirB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' && 'agy'`));
      assert.ok(defaultCmdLaunch.message.includes(dirB));

      // 自定义 cliDefaultCommand 同样在该工作区绝对路径执行
      await harness.updatePluginSettings('agy-daddy.cli', {
        cliDefaultCommand: 'agy --mode auto --model gemini-4-neon'
      });
      const customDefaultLaunch = await harness.executeCommand('cli.launch', [{
        platform: 'darwin',
        terminalApp: 'terminal',
        workspaceHints: { activeConversationTitle: 'Alpha Feature' }
      }]);
      assert.equal(customDefaultLaunch.cwd, dirA);
      assert.match(customDefaultLaunch.plan.args.join(' '), new RegExp(`cd '${dirA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' && agy --mode auto`));

      // 验证 /workspace 路由实时返回当前探测结果
      const loadedMeta = harness.pluginRegistry?.get?.('agy-daddy.cli');
      const wsRouteRes = await harness.bridge.pluginRoutes.get('agy-daddy.cli:/workspace')({
        workspaceHints: { activeConversationTitle: 'Alpha Feature' }
      });
      assert.equal(wsRouteRes.ok, true);
      assert.equal(wsRouteRes.cwd, dirA);
      assert.equal(wsRouteRes.source, 'rpc-dom-title');

      // 点击顶栏默认 CLI 胶囊：验证 renderer 实时采集 DOM 并向 /launch 传递 workspaceHints
      const capturedLaunchBodies = [];
      const origLaunchHandler = harness.bridge.pluginRoutes.get('agy-daddy.cli:/launch');
      harness.bridge.registerPluginRoute('agy-daddy.cli', '/launch', async (body, ctx) => {
        capturedLaunchBodies.push(body);
        return origLaunchHandler ? await origLaunchHandler(body, ctx) : { ok: true };
      });
      const shadow = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
      const cliBtn = shadow.querySelector('#agy-topbar-slots').children.find((c) => c.id === 'agy-unit-agy-daddy.cli-cli');
      assert.ok(cliBtn);
      cliBtn.click();
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(capturedLaunchBodies.length, 1);
      assert.equal(capturedLaunchBodies[0].workspaceHints.activeConversationTitle, 'Beta Feature');
      assert.equal(capturedLaunchBodies[0].workspaceHints.pageTitle, `${dirBBase} — Antigravity`);
      const planCheck = await harness.bridge.pluginRoutes.get('agy-daddy.cli:/plan')(capturedLaunchBodies[0]);
      assert.equal(planCheck.cwd, dirB);
      assert.ok(loadedMeta || true);

      await harness.unloadPlugin('agy-daddy.cli');
      harness.assertCleanDispose('agy-daddy.cli');
    } finally {
      await harness.cleanup();
    }
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
    fs.rmSync(dirBWorktree, { recursive: true, force: true });
  }
});
