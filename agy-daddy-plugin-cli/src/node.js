'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const {
  TERMINAL_CATALOG,
  CLI_PERMISSION_MODES,
  parseQuickCommands,
  buildDefaultCliCommand,
  getWindowsHelperPath,
  normalizeWorkspacePath,
  extractWorkspacesFromTrajectory,
  resolveWorkspaceFromTrajectories,
  extractWorkspaceFromBrainDir,
  sanitizeMuxHost,
  detectAvailableTerminals,
  detectTerminalPath,
  verifyTerminalPath,
  listSshMuxHosts,
  buildLaunchPlan
} = require('./terminals');

const DEFAULT_MODEL_OPTIONS = [
  { value: '', label: '沿用 CLI 默认模型（留空）' },
  { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
  { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
  { value: 'gemini-3-pro-preview', label: 'gemini-3-pro-preview' },
  { value: 'claude-sonnet-4-5', label: 'claude-sonnet-4-5' },
  { value: 'claude-opus-4-6', label: 'claude-opus-4-6' }
];

let disposers = [];

function isTestEnv() {
  return process.env.AGY_DADDY_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
}

function normalizeManagedSettings(raw = {}) {
  const rawMode = typeof raw.cliPermissionMode === 'string' ? raw.cliPermissionMode.trim() : '';
  let cliPermissionMode = CLI_PERMISSION_MODES.includes(rawMode) ? rawMode : '';
  if (!cliPermissionMode) {
    cliPermissionMode = raw.cliSkipPermissions ? 'skip-permissions' : 'default';
  }
  const cliDefaultModel = typeof raw.cliDefaultModel === 'string' ? raw.cliDefaultModel : '';
  const cliLabel = typeof raw.cliLabel === 'string' && raw.cliLabel.trim() ? raw.cliLabel.trim() : 'CLI';
  const cliDefaultCommand = typeof raw.cliDefaultCommand === 'string'
    ? raw.cliDefaultCommand
    : buildDefaultCliCommand({ cliBin: 'agy', cliDefaultModel, cliPermissionMode });
  return {
    terminalApp: typeof raw.terminalApp === 'string' && raw.terminalApp ? raw.terminalApp : 'auto',
    customTerminalPath: typeof raw.customTerminalPath === 'string' ? raw.customTerminalPath : '',
    cliMuxHost: typeof raw.cliMuxHost === 'string' ? raw.cliMuxHost : '',
    cliLabel,
    cliDefaultModel,
    cliPermissionMode,
    cliDefaultCommand,
    cliSkipPermissions: cliPermissionMode === 'skip-permissions',
    quickCommands: Array.isArray(raw.quickCommands) ? raw.quickCommands.map((v) => String(v)) : []
  };
}

function spawnDetachedSafely(executable, args = [], spawnOpts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(executable, args, {
        detached: true,
        stdio: 'ignore',
        ...spawnOpts
      });
    } catch (err) {
      done({ ok: false, error: err?.message || String(err), code: err?.code || 'SPAWN_FAILED' });
      return;
    }
    child.on('error', (err) => {
      if (!settled) {
        done({ ok: false, error: err?.message || String(err), code: err?.code || 'SPAWN_FAILED' });
      }
    });
    child.once('spawn', () => {
      try { child.unref(); } catch {}
      done({ ok: true, pid: child.pid || null });
    });
    timer = setTimeout(() => {
      try { child.unref(); } catch {}
      done({ ok: true, pid: child.pid || null });
    }, 200);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function runExecFile(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 30000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err?.message || ''
      });
    });
  });
}

async function activate(host) {
  let settings = normalizeManagedSettings(host.settings.get());
  let syncingSettings = false;

  const stopSettingsSub = host.settings.onChange((nextValues) => {
    if (syncingSettings) return;
    settings = normalizeManagedSettings(nextValues);
  });

  async function resolveCliEnv() {
    let base = { ...process.env };
    try {
      const proxyRes = await host.services.call('proxy', 'getCliEnv', [base], { optional: true });
      if (proxyRes?.ok && proxyRes.value && typeof proxyRes.value === 'object') {
        return proxyRes.value;
      }
    } catch {}
    delete base.ELECTRON_RUN_AS_NODE;
    delete base.NO_COLOR;
    base.TERM = 'xterm-256color';
    base.COLORTERM = 'truecolor';
    return base;
  }

  async function resolveLaunchWorkspace(opts = {}) {
    const platform = opts.platform || process.platform;
    const rawMux = opts.muxHost !== undefined ? opts.muxHost : settings.cliMuxHost;
    const muxClean = rawMux ? sanitizeMuxHost(rawMux) : '';
    const localOnly = !muxClean;
    const existsFn = typeof opts.existsSync === 'function' ? opts.existsSync : fs.existsSync;
    const statFn = typeof opts.statSync === 'function' ? opts.statSync : fs.statSync;

    if (typeof opts.cwd === 'string' && opts.cwd.trim()) {
      const explicitCwd = normalizeWorkspacePath(opts.cwd, { platform });
      if (explicitCwd) {
        return { cwd: explicitCwd, source: 'explicit', matchedCascadeId: opts.cascadeId || null };
      }
    }

    const hints = opts.workspaceHints && typeof opts.workspaceHints === 'object' ? opts.workspaceHints : null;
    if (hints && Array.isArray(hints.domPaths) && hints.domPaths.length > 0) {
      const fromDom = resolveWorkspaceFromTrajectories(null, {
        workspaceHints: hints,
        localOnly,
        platform,
        existsSync: existsFn,
        statSync: statFn
      });
      if (fromDom && fromDom.cwd) {
        return fromDom;
      }
    }

    const cascadeId = typeof opts.cascadeId === 'string' ? opts.cascadeId.trim() : '';
    const contextCascadeId = typeof opts.contextCascadeId === 'string' ? opts.contextCascadeId.trim() : '';

    if (host.rpc && typeof host.rpc.call === 'function') {
      try {
        const allResp = await host.rpc.call('GetAllCascadeTrajectories', {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
        });
        const summaries = allResp?.trajectorySummaries || {};
        const fromRpc = resolveWorkspaceFromTrajectories(summaries, {
          cascadeId,
          contextCascadeId,
          workspaceHints: hints,
          localOnly,
          platform,
          existsSync: existsFn,
          statSync: statFn
        });
        if (fromRpc && fromRpc.cwd) {
          return fromRpc;
        }
      } catch {}

      const targetCascadeId = cascadeId || contextCascadeId;
      if (targetCascadeId) {
        try {
          const trajResp = await host.rpc.call('GetCascadeTrajectory', { cascadeId: targetCascadeId });
          const cands = extractWorkspacesFromTrajectory(trajResp, { platform });
          const chosen = cands.find((cand) => {
            if (!localOnly) return true;
            try { return existsFn(cand); } catch { return false; }
          }) || cands[0];
          if (chosen) {
            return { cwd: chosen, source: 'rpc-trajectory', matchedCascadeId: targetCascadeId };
          }
        } catch {}
      }
    }

    const brainCascadeId = cascadeId || contextCascadeId;
    if (brainCascadeId) {
      const fromBrain = serviceMethods.resolveWorkspaceFromBrain(opts.brainDir, brainCascadeId, { platform });
      if (fromBrain) {
        return { cwd: fromBrain, source: 'brain', matchedCascadeId: brainCascadeId };
      }
    }

    const fallbackCwd = normalizeWorkspacePath(process.cwd(), { platform }) || process.cwd();
    return { cwd: fallbackCwd, source: 'process-cwd', matchedCascadeId: null };
  }

  const serviceMethods = {
    listTerminals(opts = {}) {
      return detectAvailableTerminals(opts);
    },
    getTerminalCatalog() {
      return [...TERMINAL_CATALOG];
    },
    resolveWorkspaceFromBrain(brainDir, cascadeId, opts = {}) {
      const dir = brainDir || process.env.AGY_DADDY_BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
      return extractWorkspaceFromBrainDir(dir, cascadeId, opts);
    },
    async resolveWorkspace(opts = {}) {
      const resolved = await resolveLaunchWorkspace(opts || {});
      return { ok: true, ...resolved };
    },
    getWindowsHelperPath() {
      return getWindowsHelperPath();
    },
    getSettings() {
      return { ...settings };
    },
    async saveSettings(patch = {}) {
      const cleanPatch = {};
      for (const k of ['terminalApp', 'customTerminalPath', 'cliMuxHost', 'cliLabel', 'cliDefaultModel', 'cliPermissionMode', 'cliDefaultCommand', 'quickCommands']) {
        if (patch[k] !== undefined) cleanPatch[k] = patch[k];
      }
      if (patch.cliSkipPermissions !== undefined && cleanPatch.cliPermissionMode === undefined) {
        cleanPatch.cliPermissionMode = patch.cliSkipPermissions ? 'skip-permissions' : 'default';
      }
      settings = normalizeManagedSettings({ ...settings, ...cleanPatch });
      if (Object.keys(cleanPatch).length > 0) {
        syncingSettings = true;
        try {
          await host.settings.update(cleanPatch);
        } finally {
          syncingSettings = false;
        }
      }
      return { ...settings };
    },
    detectTerminalPath(opts = {}) {
      const values = opts.values && typeof opts.values === 'object' ? opts.values : {};
      const trigger = String(opts.trigger || 'manual');
      const targetApp = opts.terminalApp || values.terminalApp || settings.terminalApp || 'auto';
      const customPath = opts.customTerminalPath !== undefined
        ? String(opts.customTerminalPath || '').trim()
        : (values.customTerminalPath !== undefined ? String(values.customTerminalPath || '').trim() : String(settings.customTerminalPath || '').trim());

      const detectOpts = {
        platform: opts.platform || process.platform,
        env: opts.env,
        existsSync: opts.existsSync,
        homeDir: opts.homeDir
      };

      if (trigger === 'watch' || trigger === 'manual') {
        return detectTerminalPath(targetApp, detectOpts);
      }
      if (customPath) {
        return verifyTerminalPath(customPath, detectOpts);
      }
      return detectTerminalPath(targetApp, detectOpts);
    },
    async browseTerminalPath(opts = {}) {
      if (typeof opts.pickerFn === 'function') {
        return await opts.pickerFn(opts);
      }
      if (isTestEnv()) {
        return { ok: true, cancelled: true, path: '' };
      }
      const platform = opts.platform || process.platform;
      if (platform === 'darwin') {
        const res = await runExecFile('osascript', [
          '-e',
          'tell current application to activate',
          '-e',
          'POSIX path of (choose file with prompt "选择终端程序或可执行文件" default location POSIX file "/Applications")'
        ], { timeout: 120000 });
        if (!res.ok) {
          return { ok: true, cancelled: true, path: '' };
        }
        const picked = res.stdout.trim().replace(/\/+$/, '');
        return picked ? { ok: true, cancelled: false, path: picked } : { ok: true, cancelled: true, path: '' };
      }
      if (platform === 'win32') {
        const psScript = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '$f = New-Object System.Windows.Forms.OpenFileDialog',
          '$f.Title = "选择终端程序"',
          'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }'
        ].join('; ');
        const res = await runExecFile('powershell.exe', ['-NoProfile', '-Command', psScript], { timeout: 120000 });
        const picked = res.ok ? res.stdout.trim() : '';
        return picked ? { ok: true, cancelled: false, path: picked } : { ok: true, cancelled: true, path: '' };
      }
      const zen = await runExecFile('zenity', ['--file-selection', '--title=选择终端程序'], { timeout: 120000 });
      if (zen.ok && zen.stdout.trim()) {
        return { ok: true, cancelled: false, path: zen.stdout.trim() };
      }
      const kd = await runExecFile('kdialog', ['--getopenfilename', '/usr/bin'], { timeout: 120000 });
      if (kd.ok && kd.stdout.trim()) {
        return { ok: true, cancelled: false, path: kd.stdout.trim() };
      }
      return { ok: true, cancelled: true, path: '' };
    },
    listMuxHosts(opts = {}) {
      const hosts = listSshMuxHosts(opts);
      return {
        ok: true,
        options: [
          { value: '', label: '本地终端（留空）' },
          ...hosts
        ]
      };
    },
    async listModels(opts = {}) {
      const out = [];
      const seen = new Set();
      const pushOpt = (opt) => {
        if (!opt) return;
        const val = typeof opt === 'string' ? opt : String(opt.value ?? '');
        if (seen.has(val)) return;
        seen.add(val);
        out.push(typeof opt === 'string' ? { value: opt, label: opt } : { value: val, label: String(opt.label || val), ...(opt.description ? { description: opt.description } : {}) });
      };
      pushOpt(DEFAULT_MODEL_OPTIONS[0]);

      if (host.rpc && typeof host.rpc.call === 'function') {
        try {
          const resp = await host.rpc.call('GetAvailableModels', { forceRefresh: false });
          const modelsObj = resp?.response?.models || resp?.models || {};
          const entries = Array.isArray(modelsObj)
            ? modelsObj.map((m) => [m.model || m.modelId || m.id || '', m])
            : Object.entries(modelsObj);
          for (const [k, v] of entries) {
            if (!v || typeof v !== 'object') continue;
            const modelId = String(v.model || v.modelId || v.id || k || '').trim();
            if (!modelId) continue;
            const displayName = String(v.displayName || v.label || modelId).trim();
            pushOpt({
              value: modelId,
              label: displayName,
              description: displayName !== modelId ? modelId : ''
            });
          }
        } catch {}
      }

      if (Array.isArray(opts.extraModels)) {
        for (const m of opts.extraModels) pushOpt(m);
      }
      for (const def of DEFAULT_MODEL_OPTIONS.slice(1)) {
        pushOpt(def);
      }
      return { ok: true, options: out };
    },
    getQuickCommands() {
      return parseQuickCommands(settings.quickCommands);
    },
    buildDefaultCommand(opts = {}) {
      const values = opts.values && typeof opts.values === 'object' ? opts.values : {};
      const cliDefaultModel = opts.cliDefaultModel !== undefined
        ? opts.cliDefaultModel
        : (values.cliDefaultModel !== undefined ? values.cliDefaultModel : settings.cliDefaultModel);
      const cliPermissionMode = opts.cliPermissionMode !== undefined
        ? opts.cliPermissionMode
        : (values.cliPermissionMode !== undefined ? values.cliPermissionMode : settings.cliPermissionMode);
      const cliBin = opts.cliBin || 'agy';
      const command = buildDefaultCliCommand({ cliBin, cliDefaultModel, cliPermissionMode });
      return { ok: true, value: command, command };
    },
    async planLaunch(opts = {}) {
      const env = await resolveCliEnv();
      const ws = await resolveLaunchWorkspace(opts);
      const resolvedCwd = ws.cwd;
      let rawCommand = typeof opts.rawCommand === 'string' ? opts.rawCommand.trim() : '';
      if (!rawCommand && opts.commandId) {
        const hit = parseQuickCommands(settings.quickCommands).find((c) => c.id === opts.commandId);
        if (hit) rawCommand = hit.command;
      }
      const hasExplicitCliOverrides = opts.cliDefaultModel !== undefined
        || opts.cliPermissionMode !== undefined
        || opts.cliSkipPermissions !== undefined
        || (Array.isArray(opts.commandArgs) && opts.commandArgs.length > 0);
      if (!rawCommand && !hasExplicitCliOverrides) {
        const customDefaultCmd = typeof opts.cliDefaultCommand === 'string'
          ? opts.cliDefaultCommand.trim()
          : String(settings.cliDefaultCommand || '').trim();
        if (customDefaultCmd) {
          rawCommand = customDefaultCmd;
        }
      }
      let cliPermissionMode = opts.cliPermissionMode;
      if (cliPermissionMode === undefined && opts.cliSkipPermissions !== undefined) {
        cliPermissionMode = opts.cliSkipPermissions ? 'skip-permissions' : 'default';
      }
      if (cliPermissionMode === undefined) {
        cliPermissionMode = settings.cliPermissionMode;
      }
      return buildLaunchPlan({
        terminalApp: opts.terminalApp || settings.terminalApp,
        customTerminalPath: opts.customTerminalPath !== undefined ? opts.customTerminalPath : settings.customTerminalPath,
        cwd: resolvedCwd,
        workspaceSource: ws.source,
        cliBin: opts.cliBin || 'agy',
        commandArgs: opts.commandArgs,
        rawCommand,
        muxHost: opts.muxHost !== undefined ? opts.muxHost : settings.cliMuxHost,
        cliPermissionMode,
        cliSkipPermissions: opts.cliSkipPermissions,
        cliDefaultModel: opts.cliDefaultModel !== undefined ? opts.cliDefaultModel : settings.cliDefaultModel,
        platform: opts.platform || process.platform,
        env
      });
    },
    async launch(opts = {}) {
      const plan = await serviceMethods.planLaunch(opts);
      if (opts.dryRun || (isTestEnv() && !opts.testRealSpawn)) {
        return { ok: true, dryRun: true, cwd: plan.cwd, workspaceSource: plan.workspaceSource, plan };
      }
      const spawnOpts = { env: plan.env };
      if (!plan.muxHost && plan.cwd && (opts.platform || process.platform) === process.platform) {
        try {
          if (fs.existsSync(plan.cwd) && fs.statSync(plan.cwd).isDirectory()) {
            spawnOpts.cwd = plan.cwd;
          }
        } catch {}
      }
      const spawnRes = await spawnDetachedSafely(plan.executable, plan.args, spawnOpts);
      if (!spawnRes.ok) {
        return {
          ok: false,
          dryRun: false,
          cwd: plan.cwd,
          workspaceSource: plan.workspaceSource,
          terminalId: plan.terminalId,
          executable: plan.executable,
          error: spawnRes.error,
          code: spawnRes.code
        };
      }
      if (plan.activateApp) {
        void spawnDetachedSafely('open', ['-a', plan.activateApp], {});
      }
      return {
        ok: true,
        dryRun: false,
        cwd: plan.cwd,
        workspaceSource: plan.workspaceSource,
        pid: spawnRes.pid || null,
        terminalId: plan.terminalId
      };
    }
  };

  const stopSvc = host.services.provide('cli', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopTermRoute = await host.bridge.registerRoute('/terminals', async () => serviceMethods.listTerminals());
  const stopDetectRoute = await host.bridge.registerRoute('/detect-terminal', async (body) => serviceMethods.detectTerminalPath(body || {}));
  const stopWorkspaceRoute = await host.bridge.registerRoute('/workspace', async (body) => serviceMethods.resolveWorkspace(body || {}));
  const stopPlanRoute = await host.bridge.registerRoute('/plan', async (body) => serviceMethods.planLaunch(body || {}));
  const stopLaunchRoute = await host.bridge.registerRoute('/launch', async (body) => serviceMethods.launch(body || {}));
  const stopLaunchCmd = host.commands.register('cli.launch', async (opts = {}) => {
    const res = await serviceMethods.launch(opts || {});
    if (!res.ok) {
      return {
        ...res,
        message: `启动失败：${res.error || '未知错误'}`
      };
    }
    const label = opts?.commandName || settings.cliLabel || 'CLI';
    const cwdSuffix = res.cwd ? `（${res.cwd}）` : '';
    return {
      ...res,
      message: res.dryRun
        ? `已生成启动计划 (${res.plan?.terminalId || 'auto'})${cwdSuffix}`
        : `已在 ${res.terminalId || '终端'} 启动 ${label}${cwdSuffix}`
    };
  });
  const stopDetectCmd = host.commands.register('cli.detectTerminalPath', async (opts = {}) => serviceMethods.detectTerminalPath(opts || {}));
  const stopBrowseCmd = host.commands.register('cli.browseTerminalPath', async (opts = {}) => serviceMethods.browseTerminalPath(opts || {}));
  const stopMuxHostsCmd = host.commands.register('cli.listMuxHosts', async (opts = {}) => serviceMethods.listMuxHosts(opts || {}));
  const stopModelsCmd = host.commands.register('cli.listModels', async (opts = {}) => serviceMethods.listModels(opts || {}));
  const stopBuildDefaultCmd = host.commands.register('cli.buildDefaultCommand', async (opts = {}) => serviceMethods.buildDefaultCommand(opts || {}));

  disposers.push(
    stopSettingsSub,
    stopSvc,
    stopTermRoute,
    stopDetectRoute,
    stopWorkspaceRoute,
    stopPlanRoute,
    stopLaunchRoute,
    stopLaunchCmd,
    stopDetectCmd,
    stopBrowseCmd,
    stopMuxHostsCmd,
    stopModelsCmd,
    stopBuildDefaultCmd
  );
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  activate,
  deactivate
};
