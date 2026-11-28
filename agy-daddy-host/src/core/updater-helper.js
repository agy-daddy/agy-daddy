'use strict';

/**
 * 跨平台脱耦底座自更新引导进程。
 * 严禁引入相对仓库源码依赖——本文件会被复制至 <stateDir>/updater-run/<runId>/ 独立运行。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function defaultSleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

async function moveDirWithRetry(src, dst, sleepFn = defaultSleep) {
  const retryableCodes = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let i = 0; i < 6; i++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (err) {
      if (err && retryableCodes.has(err.code) && i < 5) {
        await sleepFn(150);
        continue;
      }
      if (err && (err.code === 'EXDEV' || retryableCodes.has(err.code))) {
        copyDirSync(src, dst);
        fs.rmSync(src, { recursive: true, force: true });
        return;
      }
      throw err;
    }
  }
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function safeWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendHistoryEntry(historyPath, entry) {
  if (!historyPath) return;
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.appendFileSync(historyPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      ...entry
    }) + '\n', 'utf8');
  } catch {}
}

function releaseLockIfOwned(lockPath, expectedRunId) {
  if (!lockPath) return;
  try {
    if (!fs.existsSync(lockPath)) return;
    const lock = safeReadJson(lockPath, null);
    if (!expectedRunId || !lock?.runId || lock.runId === expectedRunId) {
      fs.unlinkSync(lockPath);
    }
  } catch {}
}

function markLastFailedVersion(stateFilePath, targetVersion) {
  if (!stateFilePath || !targetVersion) return;
  try {
    const state = safeReadJson(stateFilePath, { schemaVersion: 1, targets: {} }) || { schemaVersion: 1, targets: {} };
    if (!state.targets || typeof state.targets !== 'object') state.targets = {};
    if (!state.targets.host || typeof state.targets.host !== 'object') state.targets.host = { targetId: 'host', kind: 'host' };
    state.targets.host.lastFailedVersion = targetVersion;
    safeWriteJson(stateFilePath, state);
  } catch {}
}

function defaultFetchHealth(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/diagnostics/health',
      timeout: timeoutMs
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      try { req.destroy(); } catch {}
      resolve(null);
    });
  });
}

async function waitForOldProcessExit(oldPid, timeoutMs, isPidAliveFn, sleepFn) {
  if (!Number.isInteger(oldPid) || oldPid <= 0 || oldPid === process.pid) return true;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (isPidAliveFn(oldPid)) {
    if (Date.now() >= deadline) return false;
    await sleepFn(50);
  }
  return true;
}

async function waitForDaemonHealth(stateDir, timeoutMs, fetchHealthFn, sleepFn, spawnedChild = null) {
  const liveSessionPath = path.join(stateDir, '.live-session.json');
  const deadline = Date.now() + Math.max(100, timeoutMs);
  let childExited = false;
  if (spawnedChild && typeof spawnedChild.once === 'function') {
    spawnedChild.once('exit', () => { childExited = true; });
  }
  while (Date.now() < deadline) {
    if (childExited) return { ok: false, reason: 'SPAWNED_DAEMON_EXITED' };
    const session = safeReadJson(liveSessionPath, null);
    if (session && Number.isInteger(session.port) && session.port > 0) {
      const health = await fetchHealthFn(session.port, 1200);
      if (health && health.daemon && (!spawnedChild?.pid || health.daemon.pid === spawnedChild.pid || health.daemon.pid)) {
        return { ok: true, port: session.port, health };
      }
    }
    await sleepFn(100);
  }
  return { ok: false, reason: 'HEALTH_PROBE_TIMEOUT' };
}

function defaultSpawnLaunchCommand(launchCommand) {
  if (!launchCommand || !launchCommand.bin) return null;
  const child = spawn(launchCommand.bin, Array.isArray(launchCommand.args) ? launchCommand.args : [], {
    cwd: launchCommand.cwd || undefined,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: launchCommand.env || process.env
  });
  if (typeof child.unref === 'function') child.unref();
  return child;
}

async function runUpdaterHelper(planOrPath, deps = {}) {
  const plan = typeof planOrPath === 'string'
    ? safeReadJson(planOrPath, null)
    : planOrPath;
  if (!plan || typeof plan !== 'object') {
    throw new Error('Invalid updater-helper plan');
  }

  const isPidAliveFn = deps.isPidAlive || defaultIsPidAlive;
  const sleepFn = deps.sleep || defaultSleep;
  const fetchHealthFn = deps.fetchHealth || defaultFetchHealth;
  const spawnLaunchFn = deps.spawnLaunch || defaultSpawnLaunchCommand;
  const startMs = Date.now();
  const mode = plan.mode === 'rollback' ? 'rollback' : 'apply';
  const waitOldPidTimeoutMs = Number(plan.waitOldPidTimeoutMs) > 0 ? Number(plan.waitOldPidTimeoutMs) : 10000;
  const healthTimeoutMs = Number(plan.healthTimeoutMs) > 0 ? Number(plan.healthTimeoutMs) : 10000;

  try {
    if (plan.oldPid) {
      await waitForOldProcessExit(Number(plan.oldPid), waitOldPidTimeoutMs, isPidAliveFn, sleepFn);
    }

    if (mode === 'rollback') {
      if (!plan.backupDir || !fs.existsSync(plan.backupDir)) {
        throw new Error(`NO_ROLLBACK_SNAPSHOT: missing ${plan.backupDir || ''}`);
      }
      const brokenDir = `${plan.installDir}.broken.${plan.runId || Date.now()}`;
      if (fs.existsSync(plan.installDir)) {
        fs.rmSync(brokenDir, { recursive: true, force: true });
        await moveDirWithRetry(plan.installDir, brokenDir, sleepFn);
      }
      await moveDirWithRetry(plan.backupDir, plan.installDir, sleepFn);
      fs.rmSync(brokenDir, { recursive: true, force: true });
    } else {
      if (!plan.stagingDir || !fs.existsSync(plan.stagingDir)) {
        throw new Error(`Missing staging directory: ${plan.stagingDir || ''}`);
      }
      if (plan.backupDir && fs.existsSync(plan.backupDir)) {
        fs.rmSync(plan.backupDir, { recursive: true, force: true });
      }
      if (fs.existsSync(plan.installDir)) {
        await moveDirWithRetry(plan.installDir, plan.backupDir, sleepFn);
      }
      try {
        await moveDirWithRetry(plan.stagingDir, plan.installDir, sleepFn);
      } catch (swapErr) {
        if (plan.backupDir && fs.existsSync(plan.backupDir) && !fs.existsSync(plan.installDir)) {
          await moveDirWithRetry(plan.backupDir, plan.installDir, sleepFn).catch(() => {});
        }
        throw swapErr;
      }

      const prevMeta = safeReadJson(path.join(plan.backupDir || '', '.install-meta.json'), {}) || {};
      safeWriteJson(path.join(plan.installDir, '.install-meta.json'), {
        installMode: 'wrapper',
        wrapperVersion: prevMeta.wrapperVersion || plan.wrapperVersion || null,
        installedVersion: plan.targetVersion || null,
        installedChannel: plan.channel || prevMeta.installedChannel || 'stable',
        installedSource: plan.sourceKind || prevMeta.installedSource || 'npm',
        updatedAt: new Date().toISOString()
      });

      if (plan.syncAnchorsToStateDir !== false && plan.stateDir) {
        const bundledAnchors = path.join(plan.installDir, 'data', 'anchors.json');
        const stateAnchors = path.join(plan.stateDir, 'anchors.json');
        const prevStateAnchors = path.join(plan.stateDir, 'anchors.prev.json');
        if (fs.existsSync(bundledAnchors)) {
          try {
            if (fs.existsSync(stateAnchors)) {
              fs.copyFileSync(stateAnchors, prevStateAnchors);
            }
            fs.copyFileSync(bundledAnchors, stateAnchors);
          } catch {}
        }
      }

      if (process.platform !== 'win32') {
        for (const binRel of ['bin/agy-daddy', 'bin/agy-daddy.js']) {
          const binFile = path.join(plan.installDir, binRel);
          if (fs.existsSync(binFile)) {
            try { fs.chmodSync(binFile, 0o755); } catch {}
          }
        }
      }
    }

    if (plan.launchCommand && plan.supervisorMode && plan.supervisorMode !== 'none') {
      const child = spawnLaunchFn(plan.launchCommand);
      const probe = await waitForDaemonHealth(
        plan.stateDir,
        healthTimeoutMs,
        fetchHealthFn,
        sleepFn,
        child
      );
      if (!probe.ok) {
        if (child?.pid && isPidAliveFn(child.pid)) {
          try { process.kill(child.pid, 'SIGKILL'); } catch {}
        }
        if (mode === 'apply' && plan.backupDir && fs.existsSync(plan.backupDir)) {
          fs.rmSync(plan.installDir, { recursive: true, force: true });
          await moveDirWithRetry(plan.backupDir, plan.installDir, sleepFn);
          spawnLaunchFn(plan.launchCommand);
          markLastFailedVersion(plan.stateFilePath, plan.targetVersion);
          appendHistoryEntry(plan.historyPath, {
            runId: plan.runId || null,
            trigger: plan.trigger || 'ui',
            targetId: 'host',
            sourceKind: plan.sourceKind || 'npm',
            sourceUrl: plan.sourceUrl || null,
            channel: plan.channel || 'stable',
            fromVersion: plan.fromVersion || null,
            toVersion: plan.targetVersion || null,
            phase: 'probe',
            durationMs: Date.now() - startMs,
            outcome: 'rolled_back',
            errorCode: 'UPDATE_ROLLBACK_TRIGGERED',
            errorMessage: `New host daemon failed health probe (${probe.reason}); rolled back to ${plan.fromVersion || 'previous'}`
          });
          return {
            ok: false,
            rolledBack: true,
            errorCode: 'UPDATE_ROLLBACK_TRIGGERED',
            reason: probe.reason
          };
        }
        throw new Error(`Health probe failed after ${mode}: ${probe.reason}`);
      }
    }

    appendHistoryEntry(plan.historyPath, {
      runId: plan.runId || null,
      trigger: plan.trigger || 'ui',
      targetId: 'host',
      sourceKind: plan.sourceKind || 'npm',
      sourceUrl: plan.sourceUrl || null,
      channel: plan.channel || 'stable',
      fromVersion: plan.fromVersion || null,
      toVersion: plan.targetVersion || null,
      phase: mode,
      durationMs: Date.now() - startMs,
      outcome: mode === 'rollback' ? 'rolled_back' : 'succeeded',
      errorCode: null,
      errorMessage: null
    });
    return {
      ok: true,
      mode,
      targetVersion: plan.targetVersion || null
    };
  } catch (err) {
    appendHistoryEntry(plan.historyPath, {
      runId: plan.runId || null,
      trigger: plan.trigger || 'ui',
      targetId: 'host',
      sourceKind: plan.sourceKind || 'npm',
      sourceUrl: plan.sourceUrl || null,
      channel: plan.channel || 'stable',
      fromVersion: plan.fromVersion || null,
      toVersion: plan.targetVersion || null,
      phase: mode,
      durationMs: Date.now() - startMs,
      outcome: 'failed',
      errorCode: err?.code || 'UPDATE_HELPER_FAILED',
      errorMessage: err?.message || String(err)
    });
    return {
      ok: false,
      errorCode: err?.code || 'UPDATE_HELPER_FAILED',
      error: err?.message || String(err)
    };
  } finally {
    releaseLockIfOwned(plan.lockPath, plan.runId);
    if (plan.cleanupRunDir !== false && plan.runDir && fs.existsSync(plan.runDir)) {
      try { fs.rmSync(plan.runDir, { recursive: true, force: true }); } catch {}
    }
  }
}

if (require.main === module) {
  const planPath = process.argv[2];
  runUpdaterHelper(planPath)
    .then((res) => {
      process.exitCode = res?.ok ? 0 : 1;
    })
    .catch((err) => {
      console.error(err?.message || String(err));
      process.exitCode = 1;
    });
}

module.exports = {
  runUpdaterHelper,
  waitForOldProcessExit,
  waitForDaemonHealth
};
