'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { getStateDir, isTestMode } = require('./paths');
const { safeReadJsonSync, safeWriteJsonSync } = require('./storage');
const { AgyDaddyDaemon, isPidAlive } = require('./daemon');
const { TrayManager } = require('./tray-manager');
const { createLiveWatchdog } = require('./live-watchdog');
const { FAULT_CHANGED, UPGRADE_TAKEOVER_FAILED } = require('./health-snapshot');
const { registerStandaloneDiagnostics } = require('./diagnostics-page');
const { inspectAntigravityHostProcess, resolveActiveCdpTarget } = require('./cdp');
const { findAntigravityApp, relaunchAntigravityWithCdp } = require('./lifecycle');

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

function defaultSendSystemNotification(payload = {}, options = {}) {
  const platform = options.platform || process.platform;
  const spawnFn = options.spawnFn || spawn;
  if (platform !== 'darwin') {
    return { ok: false, skipped: true, reason: 'UNSUPPORTED_PLATFORM' };
  }
  const title = String(payload.title || 'Agy-Daddy Launcher');
  const subtitle = String(payload.subtitle || '');
  const message = String(payload.message || '');
  try {
    const child = spawnFn('osascript', [
      '-e', 'on run argv',
      '-e', 'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)',
      '-e', 'end run',
      message,
      title,
      subtitle
    ], {
      detached: true,
      stdio: 'ignore'
    });
    if (typeof child?.unref === 'function') child.unref();
    return { ok: true, via: 'osascript' };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function createLauncherController(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const stateDir = options.stateDir || getStateDir(options);
  const appPath = options.appPath || findAntigravityApp({ platform, env });

  const spawnFn = options.spawnFn || spawn;
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const inspectHostProcess = options.inspectHostProcess || (() => inspectAntigravityHostProcess({ platform, env }));
  const resolveCdpTarget = options.resolveCdpTarget || resolveActiveCdpTarget;
  const relaunchAntigravity = options.relaunchAntigravity || relaunchAntigravityWithCdp;
  const hasCustomOpenBrowser = typeof options.openBrowserFn === 'function';
  const openBrowserFn = options.openBrowserFn || defaultOpenBrowserUrl;
  const hasCustomNotifier = typeof (options.sendNotification || options.notifyFn) === 'function';
  const sendNotificationFn = options.sendNotification || options.notifyFn ||
    ((payload) => defaultSendSystemNotification(payload, { platform, spawnFn }));

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
  let unregisterDiagnostics = null;
  let unsubDaemonHealth = null;
  let running = false;
  let restartingPromise = null;
  let quittingPromise = null;
  let restartCount = 0;
  const notifiedUpgradeFailures = new Set();
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

  async function syncTrayWithHealth() {
    if (!daemon) return null;
    const snap = daemon.getHostHealth();
    if (typeof trayManager.applyHostHealth === 'function') {
      await trayManager.applyHostHealth(snap);
    }
    if (running) {
      writeLauncherLock(daemon?.bridge?.port || null);
    }
    return snap;
  }

  async function notifyUpgradeTakeoverFailed(event = {}) {
    const pid = event?.pid ?? null;
    const reason = String(event?.reason || 'UNKNOWN');
    const version = event?.version ? String(event.version) : null;
    const dedupKey = `${pid ?? 'unknown'}:${reason}`;
    if (notifiedUpgradeFailures.has(dedupKey)) {
      return { ok: true, deduped: true, key: dedupKey };
    }
    notifiedUpgradeFailures.add(dedupKey);
    const payload = {
      pid,
      reason,
      version,
      key: dedupKey,
      title: 'Agy-Daddy 升级接管失败',
      subtitle: version ? `Antigravity ${version} (PID ${pid ?? '—'})` : `Antigravity (PID ${pid ?? '—'})`,
      message: `升级后未能接管 CDP 调试端口（${reason}），请点击托盘「一键补参重启 Antigravity」或打开独立诊断面板。`
    };
    if (isTestMode() && !hasCustomNotifier && !options.notifyInTest) {
      return { ok: true, deduped: false, skippedInTest: true, key: dedupKey, payload };
    }
    try {
      const res = await sendNotificationFn(payload);
      return { ok: res?.ok !== false, deduped: false, key: dedupKey, payload, result: res };
    } catch (err) {
      return { ok: false, deduped: false, key: dedupKey, error: err?.message || String(err) };
    }
  }

  function wireDaemonIntegrations(targetDaemon) {
    if (unsubDaemonHealth) {
      try { unsubDaemonHealth(); } catch {}
      unsubDaemonHealth = null;
    }
    if (unregisterDiagnostics) {
      try { unregisterDiagnostics(); } catch {}
      unregisterDiagnostics = null;
    }
    if (!targetDaemon) return;

    const onFaultChanged = () => {
      void syncTrayWithHealth().catch(() => {});
    };
    const onUpgradeFailed = (ev) => {
      void notifyUpgradeTakeoverFailed(ev);
    };
    targetDaemon.on?.(FAULT_CHANGED, onFaultChanged);
    targetDaemon.on?.(UPGRADE_TAKEOVER_FAILED, onUpgradeFailed);
    let unsubUpdates = null;
    if (typeof targetDaemon.bus?.subscribeState === 'function') {
      unsubUpdates = targetDaemon.bus.subscribeState('agy-daddy.launcher', 'state:host.updates@1', (val) => {
        if (val && typeof trayManager.setUpdatesSummary === 'function') {
          trayManager.setUpdatesSummary(val.summary || val);
        }
      });
    }
    unsubDaemonHealth = () => {
      targetDaemon.off?.(FAULT_CHANGED, onFaultChanged);
      targetDaemon.off?.(UPGRADE_TAKEOVER_FAILED, onUpgradeFailed);
      try { unsubUpdates?.(); } catch {}
    };
    unregisterDiagnostics = registerStandaloneDiagnostics(targetDaemon, {
      onRelaunch: () => relaunchAntigravityWithCdpAction()
    });
  }

  async function relaunchAntigravityWithCdpAction() {
    if (!daemon) {
      return { ok: false, reason: 'DAEMON_NOT_STARTED' };
    }
    const hostProc = inspectHostProcess() || { running: false, pid: null, hasDebugSwitch: false };
    if (!hostProc.running) {
      const res = await launchAntigravityEnhanced();
      await syncTrayWithHealth();
      return res;
    }
    const targetAppPath = hostProc.appPath || appPath;
    const spec = await daemon.collectHostLaunchSpec(targetAppPath);
    const relaunchRes = await relaunchAntigravity({
      appPath: targetAppPath,
      proxyEnv: spec.env,
      extraArgs: spec.args,
      onlyIfBare: false,
      allowSelfTerminate: Boolean(options.allowSelfTerminate),
      stateDir,
      env,
      platform
    });
    daemon.health?.recordRelaunch?.(relaunchRes, hostProc.pid);
    if (relaunchRes?.discovery || relaunchRes?.port || relaunchRes?.targets) {
      const nextProc = inspectHostProcess() || hostProc;
      daemon.health?.observe?.(nextProc, relaunchRes.discovery || { port: relaunchRes.port, targets: relaunchRes.targets || [] });
    }
    if (relaunchRes?.ok) {
      await daemon.stopSessionProxyFallback?.();
      daemon.clearPendingHostRestart?.();
    }
    if (relaunchRes?.ok && Array.isArray(relaunchRes.targets) && relaunchRes.targets.length > 0 && !options.skipInject) {
      const injectRes = await daemon.injectActiveTargets({ resetCircuitOnLaunch: true });
      await syncTrayWithHealth();
      return { ok: true, action: 'relaunched', relaunch: relaunchRes, inject: injectRes };
    }
    await syncTrayWithHealth();
    return { ok: Boolean(relaunchRes?.ok), action: 'relaunch-attempted', relaunch: relaunchRes };
  }

  async function openDiagnosticsPage() {
    if (!daemon || !daemon.bridge?.port) {
      return { ok: false, reason: 'DAEMON_NOT_STARTED' };
    }
    const url = `http://127.0.0.1:${daemon.bridge.port}/diagnostics`;
    const shouldInvoke = hasCustomOpenBrowser || !isTestMode() || Boolean(options.openBrowserInTest);
    const opened = shouldInvoke ? Boolean(openBrowserFn(url)) : true;
    return { ok: opened, via: 'diagnostics-url', url };
  }

  function buildDaemon() {
    const opts = {
      ...(options.daemonOptions || {}),
      stateDir,
      plugins: options.plugins,
      trayManager,
      onRelaunchAntigravity: () => relaunchAntigravityWithCdpAction(),
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
        if (unsubDaemonHealth) {
          try { unsubDaemonHealth(); } catch {}
          unsubDaemonHealth = null;
        }
        if (unregisterDiagnostics) {
          try { unregisterDiagnostics(); } catch {}
          unregisterDiagnostics = null;
        }
        if (daemon) {
          await daemon.stop().catch(() => {});
          daemon = null;
        }

        daemon = buildDaemon();
        const started = await daemon.start();
        wireDaemonIntegrations(daemon);
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
        await syncTrayWithHealth();
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
    if (unsubDaemonHealth) {
      try { unsubDaemonHealth(); } catch {}
      unsubDaemonHealth = null;
    }
    if (unregisterDiagnostics) {
      try { unregisterDiagnostics(); } catch {}
      unregisterDiagnostics = null;
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
    onRelaunchAntigravity: () => relaunchAntigravityWithCdpAction(),
    onOpenDiagnostics: () => openDiagnosticsPage(),
    onOpenPluginSettings: () => openPluginSettings(),
    onCheckUpdates: () => openPluginSettings(),
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
      wireDaemonIntegrations(daemon);
      trayManager.setActionHandlers({
        executeCommand: (cmdId, args, opts) => daemon.executeCommand(cmdId, args, opts)
      });
      trayManager.managed = true;
      const hideTrayIcon = Boolean(daemon.getHostSettings()?.hideTrayIcon);
      await trayManager.setVisible(!hideTrayIcon);
      running = true;
      await syncTrayWithHealth();
      writeLauncherLock(started.port);
    } catch (err) {
      if (unsubDaemonHealth) {
        try { unsubDaemonHealth(); } catch {}
        unsubDaemonHealth = null;
      }
      if (unregisterDiagnostics) {
        try { unregisterDiagnostics(); } catch {}
        unregisterDiagnostics = null;
      }
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
    await syncTrayWithHealth();

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
    relaunchAntigravityWithCdp: relaunchAntigravityWithCdpAction,
    openDiagnosticsPage,
    openPluginSettings,
    restartDaemon,
    quit,
    getDaemon: () => daemon,
    getTrayManager: () => trayManager,
    getNotifiedUpgradeKeys: () => Array.from(notifiedUpgradeFailures),
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
