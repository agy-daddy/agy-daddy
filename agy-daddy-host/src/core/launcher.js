'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { getStateDir, isTestMode } = require('./paths');
const { safeReadJsonSync, safeWriteJsonSync } = require('./storage');
const { AgyDaddyDaemon, isPidAlive } = require('./daemon');
const { TrayManager } = require('./tray-manager');
const { createLiveWatchdog } = require('./live-watchdog');
const { inspectAntigravityHostProcess, resolveActiveCdpTarget } = require('./cdp');
const { findMacAntigravityApp, relaunchAntigravityWithCdp } = require('./lifecycle');

function readLauncherLock(stateDir = getStateDir()) {
  const lockPath = path.join(stateDir, 'launcher.lock');
  const lock = safeReadJsonSync(lockPath, null, { quarantineCorrupt: false }).data;
  const pid = Number(lock?.pid);
  const running = Boolean(pid && isPidAlive(pid));
  return { running, pid: running ? pid : null, lock: lock || null, lockPath };
}

function defaultOpenBrowserUrl(url) {
  try {
    const spec = process.platform === 'darwin'
      ? { bin: 'open', args: [url] }
      : (process.platform === 'win32'
        ? { bin: 'cmd', args: ['/c', 'start', '', url], windowsHide: true }
        : { bin: 'xdg-open', args: [url] });
    const child = spawn(spec.bin, spec.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: Boolean(spec.windowsHide)
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function createLauncherController(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const stateDir = options.stateDir || getStateDir(options);
  const appPath = options.appPath || (platform === 'darwin' ? findMacAntigravityApp({ env }) : 'antigravity');

  const spawnFn = options.spawnFn || spawn;
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const inspectHostProcess = options.inspectHostProcess || (() => inspectAntigravityHostProcess({ platform, env }));
  const resolveCdpTarget = options.resolveCdpTarget || resolveActiveCdpTarget;
  const relaunchAntigravity = options.relaunchAntigravity || relaunchAntigravityWithCdp;
  const openBrowserFn = options.openBrowserFn || defaultOpenBrowserUrl;

  const trayManager = options.trayManager || new TrayManager({
    stateDir,
    appName: options.appName || 'Agy-Daddy Launcher',
    backend: options.trayBackend,
    iconPath: options.iconPath,
    assetsDir: options.assetsDir,
    headless: options.headless
  });

  let daemon = null;
  let watchdog = null;
  let running = false;
  let restartingPromise = null;
  let quittingPromise = null;
  let restartCount = 0;
  const launcherLockPath = path.join(stateDir, 'launcher.lock');

  function writeLauncherLock(port = null) {
    safeWriteJsonSync(launcherLockPath, {
      pid: process.pid,
      startedAt: Date.now(),
      hasTray: true,
      trayVisible: trayManager.visible !== false,
      port
    });
  }

  function removeLauncherLock() {
    try {
      if (!fs.existsSync(launcherLockPath)) return;
      const disk = safeReadJsonSync(launcherLockPath, null, { quarantineCorrupt: false }).data;
      if (!disk || Number(disk.pid) === process.pid) {
        fs.unlinkSync(launcherLockPath);
      }
    } catch {}
  }

  function buildDaemon() {
    const opts = {
      ...(options.daemonOptions || {}),
      stateDir,
      plugins: options.plugins,
      trayManager,
      onRestartDaemon: () => restartDaemon(),
      onHostSettingsChange: () => {
        if (running) {
          writeLauncherLock(daemon?.bridge?.port || null);
        }
      }
    };
    if (typeof options.createDaemon === 'function') {
      return options.createDaemon(opts);
    }
    return new AgyDaddyDaemon(opts);
  }

  function buildWatchdog(targetDaemon) {
    const wOpts = {
      autoRelaunch: options.autoRelaunch !== false,
      silent: Boolean(options.silent || options.json),
      appPath,
      platform,
      env,
      ...(options.watchdogOptions || {})
    };
    if (typeof options.createWatchdog === 'function') {
      return options.createWatchdog(targetDaemon, wOpts);
    }
    return createLiveWatchdog(targetDaemon, wOpts);
  }

  async function launchAntigravityEnhanced() {
    if (!daemon) {
      return { ok: false, reason: 'DAEMON_NOT_STARTED' };
    }
    const spec = await daemon.collectHostLaunchSpec(appPath);
    const hostProc = inspectHostProcess() || { running: false, pid: null, hasDebugSwitch: false };

    if (hostProc.running && hostProc.hasDebugSwitch) {
      if (platform === 'darwin' && !isTestMode() && options.focusOnAlreadyRunning !== false) {
        try {
          spawnSyncFn('open', ['-a', appPath], { encoding: 'utf8', timeout: 3000, stdio: 'ignore' });
        } catch {}
      }
      const injectRes = options.skipInject ? { ok: true, skipped: true } : await daemon.injectActiveTargets({ resetCircuitOnLaunch: true });
      return { ok: true, action: 'focused-and-injected', pid: hostProc.pid || null, inject: injectRes };
    }

    if (hostProc.running && !hostProc.hasDebugSwitch) {
      const relaunchRes = await relaunchAntigravity({
        appPath,
        proxyEnv: spec.env,
        extraArgs: spec.args,
        onlyIfBare: true,
        allowSelfTerminate: Boolean(options.allowSelfTerminate),
        stateDir,
        env,
        platform
      });
      if (relaunchRes?.ok && Array.isArray(relaunchRes.targets) && relaunchRes.targets.length > 0 && !options.skipInject) {
        const injectRes = await daemon.injectActiveTargets({ resetCircuitOnLaunch: true });
        return { ok: true, action: 'relaunched', relaunch: relaunchRes, inject: injectRes };
      }
      return { ok: Boolean(relaunchRes?.ok), action: 'relaunch-attempted', relaunch: relaunchRes };
    }

    // Not running: launch enhanced instance directly with --remote-debugging-port=0 & plugin hooks
    if (platform === 'darwin') {
      const child = spawnFn('open', spec.macOpenArgs, {
        detached: true,
        stdio: 'ignore'
      });
      if (typeof child?.unref === 'function') child.unref();
    } else if (platform === 'win32') {
      const exe = options.windowsExe || appPath || 'Antigravity.exe';
      const child = spawnFn(exe, spec.args, {
        detached: true,
        stdio: 'ignore',
        env: { ...env, ...spec.env },
        windowsHide: false
      });
      if (typeof child?.unref === 'function') child.unref();
    } else {
      const bin = options.linuxBin || appPath || 'antigravity';
      const child = spawnFn(bin, spec.args, {
        detached: true,
        stdio: 'ignore',
        env: { ...env, ...spec.env }
      });
      if (typeof child?.unref === 'function') child.unref();
    }

    if (watchdog && typeof watchdog.tick === 'function') {
      void watchdog.tick().catch(() => {});
    }
    return { ok: true, action: 'launched', args: spec.args, env: spec.env };
  }

  async function openPluginSettings() {
    if (!daemon) {
      return { ok: false, reason: 'DAEMON_NOT_STARTED' };
    }
    const res = await daemon.openPluginSettings({ tab: 'plugins' });
    if (res.ok && res.via === 'cdp') {
      if (platform === 'darwin' && !isTestMode()) {
        try {
          spawnSyncFn('open', ['-a', appPath], { encoding: 'utf8', timeout: 3000, stdio: 'ignore' });
        } catch {}
      }
      return { ok: true, via: 'cdp', openedCount: res.openedCount };
    }
    if (res.ok && res.via === 'web-url' && res.url) {
      const opened = isTestMode() && !options.openBrowserInTest ? true : openBrowserFn(res.url);
      return { ok: Boolean(opened), via: 'web-url', url: res.url };
    }
    return { ok: false, via: res.via || 'none', reason: res.reason || 'NO_SETTINGS_TARGET' };
  }

  async function restartDaemon() {
    if (restartingPromise) return restartingPromise;
    restartingPromise = (async () => {
      try {
        if (watchdog) {
          watchdog.stop();
          watchdog = null;
        }
        if (daemon) {
          await daemon.stop().catch(() => {});
          daemon = null;
        }

        daemon = buildDaemon();
        const started = await daemon.start();
        trayManager.setActionHandlers({
          executeCommand: (cmdId, args, opts) => daemon.executeCommand(cmdId, args, opts)
        });

        let inject = { ok: true, skipped: true, targetsInjected: 0 };
        if (!options.skipInject) {
          inject = await daemon.injectActiveTargets().catch((err) => ({ ok: false, error: err?.message || String(err) }));
        }
        if (!isTestMode() && !options.disableWatchdog) {
          watchdog = buildWatchdog(daemon);
          watchdog.start();
        }
        restartCount++;
        const hideTrayIcon = Boolean(daemon.getHostSettings()?.hideTrayIcon);
        await trayManager.setVisible(!hideTrayIcon);
        writeLauncherLock(started.port);
        if (trayManager.started) {
          await trayManager.refreshMenu(true);
        }
        return {
          ok: true,
          restarted: true,
          restartCount,
          port: started.port,
          activePlugins: Array.from(daemon.activePlugins.keys()),
          inject
        };
      } finally {
        restartingPromise = null;
      }
    })();
    return restartingPromise;
  }

  async function stop() {
    running = false;
    if (watchdog) {
      watchdog.stop();
      watchdog = null;
    }
    removeLauncherLock();
    await trayManager.dispose().catch(() => {});
    if (daemon) {
      await daemon.stop().catch(() => {});
      daemon = null;
    }
    return { ok: true };
  }

  async function quit() {
    if (quittingPromise) return quittingPromise;
    quittingPromise = (async () => {
      await stop();
      if (typeof options.onExit === 'function') {
        await options.onExit(0);
      } else if (!isTestMode() && options.exitProcess !== false) {
        process.exit(0);
      }
      return { ok: true, exited: true };
    })();
    return quittingPromise;
  }

  trayManager.setActionHandlers({
    onLaunchAntigravity: () => launchAntigravityEnhanced(),
    onOpenPluginSettings: () => openPluginSettings(),
    onRestartDaemon: () => restartDaemon(),
    onQuit: () => quit()
  });

  async function start() {
    if (running) {
      return {
        ok: true,
        alreadyRunning: true,
        port: daemon?.bridge?.port || null,
        activePlugins: daemon ? Array.from(daemon.activePlugins.keys()) : []
      };
    }

    daemon = buildDaemon();
    const started = await daemon.start();
    try {
      trayManager.setActionHandlers({
        executeCommand: (cmdId, args, opts) => daemon.executeCommand(cmdId, args, opts)
      });
      trayManager.managed = true;
      const hideTrayIcon = Boolean(daemon.getHostSettings()?.hideTrayIcon);
      await trayManager.setVisible(!hideTrayIcon);
      running = true;
      writeLauncherLock(started.port);
    } catch (err) {
      removeLauncherLock();
      await daemon.stop().catch(() => {});
      daemon = null;
      throw err;
    }

    let inject = { ok: true, skipped: true, targetsInjected: 0, pluginsInjected: 0, errors: [] };
    if (!options.skipInject) {
      inject = await daemon.injectActiveTargets();
    }

    let initialLaunch = null;
    if (options.launchAppOnStart) {
      initialLaunch = await launchAntigravityEnhanced();
    }

    if (!isTestMode() && !options.disableWatchdog) {
      watchdog = buildWatchdog(daemon);
      watchdog.start();
      if ((inject.targetsInjected || 0) === 0 && !options.launchAppOnStart) {
        await watchdog.tick().catch(() => {});
      }
    }

    return {
      ok: true,
      appName: trayManager.appName,
      port: started.port,
      activePlugins: Array.from(daemon.activePlugins.keys()),
      activationErrors: started.activationErrors || [],
      trayItems: trayManager.buildMenuModel().length,
      trayVisible: trayManager.visible !== false,
      inject,
      ...(initialLaunch ? { initialLaunch } : {})
    };
  }

  return {
    start,
    stop,
    launchAntigravityEnhanced,
    openPluginSettings,
    restartDaemon,
    quit,
    getDaemon: () => daemon,
    getTrayManager: () => trayManager,
    getState: () => ({
      running,
      restartCount,
      trayStarted: trayManager.started,
      trayVisible: trayManager.visible !== false,
      daemonRunning: Boolean(daemon?.running),
      activePlugins: daemon ? Array.from(daemon.activePlugins.keys()) : []
    })
  };
}

module.exports = {
  readLauncherLock,
  createLauncherController
};
