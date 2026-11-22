'use strict';

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  TERMINAL_CATALOG,
  getWindowsHelperPath,
  extractWorkspaceFromBrainDir,
  detectAvailableTerminals,
  buildLaunchPlan
} = require('./terminals');

let disposers = [];

function isTestEnv() {
  return process.env.AGY_DADDY_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
}

async function activate(host) {
  let settings = {
    terminalApp: 'auto',
    customTerminalPath: '',
    cliMuxHost: '',
    cliDefaultModel: '',
    cliSkipPermissions: false,
    ...(host.storage.readJson('settings.json', {}).data || {})
  };

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

  const serviceMethods = {
    listTerminals(opts = {}) {
      return detectAvailableTerminals(opts);
    },
    getTerminalCatalog() {
      return [...TERMINAL_CATALOG];
    },
    resolveWorkspaceFromBrain(brainDir, cascadeId) {
      const dir = brainDir || process.env.AGY_DADDY_BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
      return extractWorkspaceFromBrainDir(dir, cascadeId);
    },
    getWindowsHelperPath() {
      return getWindowsHelperPath();
    },
    getSettings() {
      return { ...settings };
    },
    saveSettings(patch = {}) {
      settings = { ...settings, ...patch };
      host.storage.writeJson('settings.json', settings);
      return { ...settings };
    },
    async planLaunch(opts = {}) {
      const env = await resolveCliEnv();
      let resolvedCwd = opts.cwd;
      if (!resolvedCwd && opts.cascadeId) {
        resolvedCwd = serviceMethods.resolveWorkspaceFromBrain(opts.brainDir, opts.cascadeId);
      }
      return buildLaunchPlan({
        terminalApp: opts.terminalApp || settings.terminalApp,
        cwd: resolvedCwd || process.cwd(),
        cliBin: opts.cliBin || 'agy',
        commandArgs: opts.commandArgs,
        muxHost: opts.muxHost !== undefined ? opts.muxHost : settings.cliMuxHost,
        cliSkipPermissions: opts.cliSkipPermissions !== undefined ? opts.cliSkipPermissions : settings.cliSkipPermissions,
        cliDefaultModel: opts.cliDefaultModel !== undefined ? opts.cliDefaultModel : settings.cliDefaultModel,
        platform: opts.platform || process.platform,
        env
      });
    },
    async launch(opts = {}) {
      const plan = await serviceMethods.planLaunch(opts);
      if (opts.dryRun || isTestEnv()) {
        return { ok: true, dryRun: true, plan };
      }
      const child = spawn(plan.executable, plan.args, {
        detached: true,
        stdio: 'ignore',
        env: plan.env
      });
      child.unref();
      return { ok: true, dryRun: false, pid: child.pid || null, terminalId: plan.terminalId };
    }
  };

  const stopSvc = host.services.provide('cli', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopTermRoute = await host.bridge.registerRoute('/terminals', async () => serviceMethods.listTerminals());
  const stopPlanRoute = await host.bridge.registerRoute('/plan', async (body) => serviceMethods.planLaunch(body || {}));
  const stopLaunchRoute = await host.bridge.registerRoute('/launch', async (body) => serviceMethods.launch(body || {}));
  const stopSettingsRoute = await host.bridge.registerRoute('/settings', async (body) => {
    if (body?.action === 'save' && body.values) return { ok: true, values: serviceMethods.saveSettings(body.values) };
    return { ok: true, values: serviceMethods.getSettings() };
  });

  disposers.push(stopSvc, stopTermRoute, stopPlanRoute, stopLaunchRoute, stopSettingsRoute);
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
