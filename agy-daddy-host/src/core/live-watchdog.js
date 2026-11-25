'use strict';

const { resolveActiveCdpTarget, inspectAntigravityHostProcess } = require('./cdp');
const { isNewerVersion } = require('./health-snapshot');
const {
  detectInsideAntigravitySession,
  findAntigravityApp,
  relaunchAntigravityWithCdp
} = require('./lifecycle');

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_FRESH_THRESHOLD_SEC = 25;
const ERROR_LOG_THROTTLE_MS = 30000;

function createLiveWatchdog(daemon, options = {}) {
  const intervalMs = Math.max(50, Number(options.intervalMs) || DEFAULT_INTERVAL_MS);
  const freshThresholdSec = Number.isFinite(Number(options.freshThresholdSec))
    ? Number(options.freshThresholdSec)
    : DEFAULT_FRESH_THRESHOLD_SEC;
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const autoRelaunchEnabled = options.autoRelaunch !== false && env.AGY_DADDY_NO_AUTO_RELAUNCH !== '1';
  const appPath = options.appPath || findAntigravityApp({ platform, env });

  const silent = Boolean(options.silent || options.json);
  const log = silent ? () => {} : (options.log || ((msg) => console.log(msg)));
  const warn = silent ? () => {} : (options.warn || ((msg) => console.warn(msg)));

  const resolveCdpTarget = options.resolveCdpTarget || resolveActiveCdpTarget;
  const inspectHostProcess = options.inspectHostProcess || inspectAntigravityHostProcess;
  const relaunchFn = options.relaunchFn || relaunchAntigravityWithCdp;
  const now = options.now || (() => Date.now());
  const health = daemon?.health;
  const inspect = () => inspectHostProcess({ platform, env, appPath }) ||
    { running: false, pid: null, hasDebugSwitch: false, elapsedSec: null };

  let initialized = false;
  let initialBarePid = null;
  let lastSeenCdpPort = null;
  const warnedBarePids = new Set();
  const relaunchAttemptedPids = new Set();
  const failedTargets = new Map();
  let busy = false;
  let timer = null;
  let stopped = false;
  let backoff = null;

  function init() {
    initialized = true;
    const hostProc = inspect();
    if (
      hostProc.running &&
      !hostProc.hasDebugSwitch &&
      hostProc.pid &&
      (hostProc.elapsedSec === null || hostProc.elapsedSec > freshThresholdSec)
    ) {
      initialBarePid = hostProc.pid;
    } else {
      initialBarePid = null;
    }
    return { initialBarePid };
  }

  function observe(host, cdp) {
    health?.observe(host, cdp);
    if (host.version && daemon?.injector) daemon.injector.antigravityVersion = host.version;
  }

  function updateHealth() {
    if (!stopped && daemon?.running) health?.snapshot();
  }

  async function syncTargets(resolved = {}, syncOpts = {}) {
    const port = resolved?.port ? Number(resolved.port) : null;
    const targets = Array.isArray(resolved?.targets) ? resolved.targets : [];
    if (port && daemon?.injector) {
      daemon.injector.lastCdpPort = port;
    }

    const newTargets = [];
    for (const target of targets) {
      const targetId = target?.id || target?.webSocketDebuggerUrl;
      if (!targetId) continue;

      const existing = daemon?.injector?.sessions?.get(targetId);
      if (
        existing &&
        !existing.closed &&
        existing.target?.webSocketDebuggerUrl === target.webSocketDebuggerUrl
      ) {
        continue;
      }
      newTargets.push({ target, targetId });
    }

    if (newTargets.length > 0 && typeof daemon?.ensureEnabledPluginsActivated === 'function') {
      const isFreshAppStart = Boolean(syncOpts.freshAppStart)
        || (daemon?.injector?.sessions?.size || 0) === 0
        || Boolean(port && lastSeenCdpPort && port !== lastSeenCdpPort);
      try {
        const actRes = await daemon.ensureEnabledPluginsActivated({
          resetCircuit: isFreshAppStart,
          retryTransient: true
        });
        if (actRes?.activated?.length > 0) {
          log(`✅ Antigravity 启动时补激活 ${actRes.activated.length} 个插件 (${actRes.activated.join(', ')})`);
        }
        if (actRes?.failed?.length > 0) {
          warn(`⚠️ Antigravity 启动后仍有 ${actRes.failed.length} 个插件未能激活 (${actRes.failed.map((f) => f.id).join(', ')})，顶栏右侧将展示异常通知`);
        }
      } catch {}
    }

    if (port) {
      lastSeenCdpPort = port;
    }

    const plugins = Array.from(daemon?.activePlugins?.values ? daemon.activePlugins.values() : []);
    let injectedCount = 0;
    let pluginsInjected = 0;
    const errors = [];

    for (const { target, targetId } of newTargets) {
      if (stopped || !daemon.running) break;
      try {
        const res = await daemon.injector.attachTarget(target, plugins);
        health?.recordInjection({ targetId });
        failedTargets.delete(targetId);
        injectedCount++;
        for (const error of res?.errors || []) errors.push({ targetId, ...error });
        pluginsInjected += Number(res?.pluginsInjected) || 0;
        const cdpPort = port || daemon.injector.lastCdpPort || '?';
        log(`✅ 检测到 Antigravity 窗口并完成注入 (CDP :${cdpPort}, 插件 ${Number(res?.pluginsInjected) || 0} 个)`);
      } catch (err) {
        const errMsg = err?.message || String(err);
        health?.recordInjection({ targetId, error: errMsg });
        errors.push({ targetId, error: errMsg });
        const prev = failedTargets.get(targetId);
        const ts = now();
        if (!prev || prev.error !== errMsg || ts - prev.lastLogAt >= ERROR_LOG_THROTTLE_MS) {
          failedTargets.set(targetId, { error: errMsg, lastLogAt: ts });
          warn(`⚠️ 目标注入失败 (${targetId}): ${errMsg}`);
        }
      }
    }

    if (health && daemon.running && !stopped) {
      if (injectedCount > 0) health.recordInjectedVersion(health.host.version);
      updateHealth();
      await daemon.injector.refreshHealthProbes?.(targets);
      updateHealth();
    }
    return { injectedCount, pluginsInjected, errors };
  }

  function warnBareHost(hostProc) {
    if (!hostProc?.pid || warnedBarePids.has(hostProc.pid)) return;
    warnedBarePids.add(hostProc.pid);

    if (detectInsideAntigravitySession(env)) {
      warn(`⚠️ 检测到 Antigravity (PID ${hostProc.pid}) 未开启 CDP 调试端口；当前在 Antigravity 内部会话中，已阻止自动重启宿主，请在外部终端运行 agy-daddy restart。`);
      return;
    }
    if (!autoRelaunchEnabled) {
      warn(`⚠️ 检测到 Antigravity (PID ${hostProc.pid}) 未开启 CDP 调试端口（已禁用自动重启），请运行 agy-daddy restart 或以 --remote-debugging-port=0 启动。`);
      return;
    }
    if (platform !== 'darwin') {
      warn(`⚠️ 检测到运行中的 Antigravity (PID ${hostProc.pid}) 未开启 CDP 调试端口（启动时已存在，为保护现场未自动重启）；关闭并重开 Antigravity 将自动补参注入，或在外部终端运行 agy-daddy restart。`);
      return;
    }
    warn(`⚠️ 检测到运行中的 Antigravity (PID ${hostProc.pid}) 未开启 CDP 调试端口（启动时已存在，为保护现场未自动重启）；按 ⌘Q 退出并重开 Antigravity 将自动补参注入，或在外部终端运行 agy-daddy restart。`);
  }

  async function tick() {
    if (busy || stopped || !daemon?.running) {
      return { skipped: true };
    }
    if (!initialized) {
      init();
    }
    busy = true;
    try {
      let hostProc = inspect();
      let resolved = null;
      try {
        resolved = await resolveCdpTarget({ platform, env, ...daemon?.injector?.cdpOptions, timeoutMs: 1200 });
      } catch {
        resolved = { port: null, targets: [] };
      }
      if (stopped || !daemon.running) return { action: 'stopped' };
      observe(hostProc, resolved || { port: null, targets: [] });
      updateHealth();

      const lastVersion = health?.history.lastInjectedVersion;
      const upgrade = hostProc.running && hostProc.pid && hostProc.hasDebugSwitch === false &&
        isNewerVersion(hostProc.version, lastVersion)
        ? { fromVersion: lastVersion, toVersion: hostProc.version, pid: hostProc.pid }
        : null;
      if (!upgrade && Array.isArray(resolved?.targets) && resolved.targets.length > 0) {
        initialBarePid = null;
        const syncRes = await syncTargets(resolved);
        return { action: 'synced', ...syncRes };
      }

      if (!hostProc.running) {
        initialBarePid = null;
        lastSeenCdpPort = null;
        if (daemon?.injector?.sessions?.size > 0) {
          await daemon.injector.disposeAll().catch(() => {});
          log('ℹ️ 检测到 Antigravity 已退出，已清理旧注入会话，等待重新启动...');
        }
        return { action: 'idle' };
      }

      if (hostProc.hasDebugSwitch) {
        return { action: 'waiting-cdp', pid: hostProc.pid || null };
      }

      if (!hostProc.pid) {
        return { action: 'idle' };
      }

      const isExistingOldBare = initialBarePid !== null && hostProc.pid === initialBarePid;
      const isFreshOrNewBare = !isExistingOldBare && (
        hostProc.elapsedSec === null ||
        hostProc.elapsedSec <= freshThresholdSec ||
        initialBarePid === null ||
        hostProc.pid !== initialBarePid
      );

      const priorUpgrade = upgrade && health.history.upgradeEvents.findLast((event) =>
        event.fromVersion === upgrade.fromVersion && event.toVersion === upgrade.toVersion
      );
      const upgradeAttempted = priorUpgrade &&
        ['attempting', 'succeeded', 'failed'].includes(priorUpgrade.outcome);
      const blocked = detectInsideAntigravitySession(env);
      const supported = ['darwin', 'win32', 'linux'].includes(platform);
      let blockedReason = null;
      if (blocked) blockedReason = 'INSIDE_ANTIGRAVITY_SESSION';
      else if (!autoRelaunchEnabled) blockedReason = 'AUTO_RELAUNCH_DISABLED';
      else if (!supported) blockedReason = 'UNSUPPORTED_PLATFORM';
      if (upgrade && blockedReason) {
        if (priorUpgrade?.pid !== hostProc.pid || priorUpgrade?.reason !== blockedReason) {
          health.recordUpgrade({ ...upgrade, outcome: 'blocked', reason: blockedReason });
        }
      }
      if (blocked && health?.relaunchFailurePid !== hostProc.pid) {
        health?.recordRelaunch({ ok: false, blocked: true, reason: blockedReason });
      }

      const canAutoRelaunch = (
        !blockedReason &&
        (upgrade ? !upgradeAttempted : isFreshOrNewBare) &&
        !relaunchAttemptedPids.has(hostProc.pid)
      );

      if (canAutoRelaunch) {
        if (backoff?.pid === hostProc.pid && now() < backoff.nextAttemptAt) return { action: 'cooldown' };
        relaunchAttemptedPids.add(hostProc.pid);
        if (upgrade && priorUpgrade?.outcome !== 'deferred') {
          health.recordUpgrade({ ...upgrade, outcome: 'attempting' });
        }
        log(`🔄 检测到新启动的 Antigravity (PID ${hostProc.pid}) 未开启 CDP 调试端口，正在自动补充 --remote-debugging-port=0 重启并注入...`);
        let res;
        try {
          const runningAppPath = hostProc.appPath || appPath;
          const spec = await daemon.collectHostLaunchSpec?.(runningAppPath);
          if (stopped || !daemon.running) return { action: 'stopped' };
          res = await relaunchFn({
            appPath: runningAppPath,
            proxyEnv: spec?.env || {},
            extraArgs: spec?.args || [],
            onlyIfBare: true,
            expectedPid: hostProc.pid,
            enforceCooldown: true,
            stateDir: daemon.stateDir,
            env,
            platform
          });
        } catch (err) {
          res = { ok: false, reason: 'RELAUNCH_ERROR', error: err?.message || String(err) };
        }

        const originalPid = hostProc.pid;
        if (stopped || !daemon.running) return { action: 'stopped' };
        if (res?.relaunched) {
          const next = inspect();
          if (next.running) hostProc = next;
        }
        const relaunchCdp = res?.discovery || (res?.port || res?.targets ? { port: res.port, targets: res.targets } : resolved);
        observe(hostProc, relaunchCdp);
        health?.recordRelaunch(res || { ok: false, reason: 'UNKNOWN' });
        updateHealth();

        if (res?.ok && Array.isArray(res.targets) && res.targets.length > 0) {
          backoff = null;
          const syncRes = await syncTargets(relaunchCdp, { freshAppStart: true });
          if (upgrade && !stopped && daemon.running) {
            let reason = null;
            if (syncRes.errors.length > 0 || !health.sessions().length) reason = 'INJECTION_ERROR';
            else if (health.fault.code === 'core_anchor_missing') reason = 'CORE_ANCHOR_MISSING';
            health.recordUpgrade({
              ...upgrade, pid: hostProc.pid,
              outcome: reason ? 'failed' : 'succeeded',
              reason
            });
          }
          return { action: 'relaunched-and-injected', res, syncRes };
        }
        if (res?.reason === 'COOLDOWN_ACTIVE' || res?.reason === 'HOST_PROCESS_CHANGED' ||
            res?.reason === 'ALREADY_HAS_DEBUG_SWITCH') {
          relaunchAttemptedPids.delete(originalPid);
          const delay = backoff?.pid === originalPid ? Math.min(20000, backoff.delay * 2) : intervalMs;
          backoff = { pid: originalPid, delay, nextAttemptAt: now() + delay };
          if (upgrade && priorUpgrade?.outcome !== 'deferred') {
            health.recordUpgrade({ ...upgrade, outcome: 'deferred', reason: res.reason });
          }
          return { action: 'cooldown', res };
        }
        backoff = null;
        if (upgrade) {
          health.recordUpgrade({
            ...upgrade, pid: hostProc.pid, outcome: 'failed', reason: res?.reason || 'CDP_ZERO_TARGETS'
          });
        }
        warn(`⚠️ 自动补参重启未完成 (${res?.reason || 'UNKNOWN'}): ${res?.message || res?.error || ''}`);
        return { action: 'relaunch-failed', res };
      }

      warnBareHost(hostProc);
      return { action: 'bare-warned', pid: hostProc.pid };
    } finally {
      busy = false;
      updateHealth();
    }
  }

  function start() {
    stopped = false;
    init();
    if (timer) return;
    timer = setInterval(() => {
      void tick().catch((err) => warn(err?.message || String(err)));
    }, intervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    init,
    start,
    stop,
    tick,
    syncTargets,
    getState: () => ({
      initialized,
      initialBarePid,
      warnedBarePids: Array.from(warnedBarePids),
      relaunchAttemptedPids: Array.from(relaunchAttemptedPids),
      running: Boolean(timer) && !stopped
    })
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_FRESH_THRESHOLD_SEC,
  ERROR_LOG_THROTTLE_MS,
  createLiveWatchdog
};
