'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { HOST_API_VERSION, KNOWN_ANCHORS, isHighRiskPermission } = require('../contracts/constants');
const { satisfies, compareSemver } = require('../contracts/semver');
const { evaluateTrustPolicy } = require('../contracts/manifest-validator');
const { getStateDir, getPluginsDir, assertSafePluginId, isTestMode } = require('./paths');
const { safeReadJsonSync, safeWriteJsonSync, withFileLockSync } = require('./storage');
const { extractTarGzToDir } = require('./tar');
const { syncPluginNativeArtifacts, removePluginNativeArtifacts } = require('./native-sync');
const {
  loadRegistry,
  readInstalledIndex,
  writeInstalledIndex,
  readManifestFromDir,
  assertSafeSubpath,
  backupForRollback,
  copyDirSync,
  moveDirSync,
  defaultGitRunner,
  rollbackPlugin,
  sortPluginsByDependency
} = require('./installer');
const {
  HOST_ROOT,
  DOWNLOAD_TIMEOUT_MS,
  makeUpdateError,
  redactUrl,
  isLoopbackOrLocalUrl,
  resolveEffectiveNpmRegistry,
  compareSemverSafe,
  isMajorBump,
  getUpdateStatePath,
  readUpdateState,
  writeUpdateState,
  detectHostInstallMode,
  fetchBufferWithRetry,
  normalizeHostUpdateSettingsView,
  getCachedUpdateStatus,
  checkUpdates
} = require('./update-checker');

const UPDATE_LOCK_FILENAME = 'update.lock';
const MAX_LOCK_AGE_MS = 10 * 60 * 1000;
const MAX_HISTORY_LINES = 1000;
const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_HISTORY_FILES = 2;
const HELPER_SOURCE_PATH = path.resolve(__dirname, 'updater-helper.js');

const CHECK_INTERVAL_MS_MAP = Object.freeze({
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000
});

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function getUpdateLockPath(stateDir) {
  return path.join(stateDir, UPDATE_LOCK_FILENAME);
}

function acquireUpdateLock(stateDir, meta = {}, options = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = getUpdateLockPath(stateDir);
  const maxAgeMs = Number(options.maxLockAgeMs) > 0 ? Number(options.maxLockAgeMs) : MAX_LOCK_AGE_MS;
  const payload = {
    pid: process.pid,
    runId: meta.runId || `upd_${crypto.randomBytes(4).toString('hex')}`,
    trigger: meta.trigger || 'cli',
    targets: Array.isArray(meta.targets) ? meta.targets : [String(meta.targets || 'all')],
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now()
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(payload, null, 2) + '\n', 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath, ...payload };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const existing = safeReadJsonSync(lockPath, null, { quarantineCorrupt: false }).data;
      const holderPid = Number(existing?.pid);
      const startedAtMs = Number(existing?.startedAtMs || 0);
      const stale = !holderPid || !isPidAlive(holderPid) || (startedAtMs > 0 && (Date.now() - startedAtMs) > maxAgeMs);
      if (stale && attempt === 0) {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }
      throw makeUpdateError(
        'UPDATE_LOCK_BUSY',
        `Update lock busy (held by PID ${holderPid || 'unknown'}, trigger=${existing?.trigger || 'unknown'})`,
        { holder: existing || { pid: holderPid || null } }
      );
    }
  }
  throw makeUpdateError('UPDATE_LOCK_BUSY', 'Failed to acquire update lock');
}

function releaseUpdateLock(stateDir, expectedRunId = null) {
  const lockPath = getUpdateLockPath(stateDir);
  try {
    if (!fs.existsSync(lockPath)) return false;
    const existing = safeReadJsonSync(lockPath, null, { quarantineCorrupt: false }).data;
    if (!expectedRunId || !existing?.runId || existing.runId === expectedRunId) {
      fs.unlinkSync(lockPath);
      return true;
    }
  } catch {}
  return false;
}

function transferUpdateLock(stateDir, newPid, expectedRunId = null) {
  const lockPath = getUpdateLockPath(stateDir);
  if (!fs.existsSync(lockPath)) return false;
  const existing = safeReadJsonSync(lockPath, null, { quarantineCorrupt: false }).data || {};
  if (expectedRunId && existing.runId && existing.runId !== expectedRunId) return false;
  safeWriteJsonSync(lockPath, {
    ...existing,
    pid: newPid,
    transferredAt: new Date().toISOString()
  });
  return true;
}

function getUpdateHistoryPath(options = {}) {
  return path.join(getStateDir(options), 'logs', 'update-history.jsonl');
}

function sanitizeLogString(raw) {
  if (raw === null || raw === undefined) return raw;
  let s = String(raw);
  s = s.replace(/\b(https?:\/\/)[^\s/@]+@/gi, '$1***@');
  s = s.replace(/([?&](?:token|t|access_token|auth|key)=)[^&\s]+/gi, '$1<REDACTED>');
  s = s.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer <REDACTED>');
  s = s.replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|npm)_[A-Za-z0-9_]+\b/g, '<REDACTED_TOKEN>');
  s = s.replace(/\b((?:authorization|token|password|secret)\s*(?:=|:)\s*)[^\s,;]+/gi, '$1<REDACTED>');
  return s;
}

function sanitizeUpdateLogEntry(entry = {}) {
  const out = {};
  for (const [k, v] of Object.entries(entry)) {
    if (typeof v === 'string') {
      out[k] = sanitizeLogString(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) => (typeof item === 'string' ? sanitizeLogString(item) : item));
    } else {
      out[k] = v;
    }
  }
  return out;
}

function rotateHistoryIfNeeded(historyPath) {
  if (!fs.existsSync(historyPath)) return;
  try {
    const st = fs.statSync(historyPath);
    let lineCount = 0;
    if (st.size < MAX_HISTORY_BYTES) {
      const content = fs.readFileSync(historyPath, 'utf8');
      lineCount = content.split('\n').filter(Boolean).length;
    }
    if (st.size >= MAX_HISTORY_BYTES || lineCount >= MAX_HISTORY_LINES) {
      for (let idx = MAX_HISTORY_FILES; idx >= 1; idx--) {
        const src = idx === 1 ? historyPath : `${historyPath.replace(/\.jsonl$/, '')}.${idx - 1}.jsonl`;
        const dst = `${historyPath.replace(/\.jsonl$/, '')}.${idx}.jsonl`;
        if (fs.existsSync(src)) {
          try { fs.rmSync(dst, { force: true }); } catch {}
          fs.renameSync(src, dst);
        }
      }
    }
  } catch {}
}

function appendUpdateHistory(entry, options = {}) {
  const historyPath = getUpdateHistoryPath(options);
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  return withFileLockSync(historyPath, () => {
    rotateHistoryIfNeeded(historyPath);
    const clean = sanitizeUpdateLogEntry({
      timestamp: new Date().toISOString(),
      runId: null,
      trigger: 'cli',
      targetId: null,
      sourceKind: null,
      sourceUrl: null,
      channel: 'stable',
      fromVersion: null,
      toVersion: null,
      phase: 'apply',
      durationMs: 0,
      outcome: 'succeeded',
      errorCode: null,
      errorMessage: null,
      ...entry
    });
    fs.appendFileSync(historyPath, JSON.stringify(clean) + '\n', 'utf8');
    return clean;
  });
}

function readUpdateHistory(options = {}) {
  const historyPath = getUpdateHistoryPath(options);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 50;
  const files = [
    historyPath,
    `${historyPath.replace(/\.jsonl$/, '')}.1.jsonl`,
    `${historyPath.replace(/\.jsonl$/, '')}.2.jsonl`
  ];
  const entries = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          entries.push(JSON.parse(lines[i]));
          if (entries.length >= limit) return entries;
        } catch {}
      }
    } catch {}
  }
  return entries;
}

function verifyBufferSha512(buf, expectedIntegrity, label) {
  if (!expectedIntegrity) return;
  if (typeof expectedIntegrity === 'string' && expectedIntegrity.startsWith('sha512-')) {
    const expectedB64 = expectedIntegrity.slice('sha512-'.length);
    const actualB64 = crypto.createHash('sha512').update(buf).digest('base64');
    if (actualB64 !== expectedB64) {
      throw makeUpdateError(
        'UPDATE_INTEGRITY_MISMATCH',
        `SHA-512 integrity check failed for ${label}`
      );
    }
  } else if (typeof expectedIntegrity === 'string' && /^[0-9a-f]{128}$/i.test(expectedIntegrity)) {
    const actualHex = crypto.createHash('sha512').update(buf).digest('hex');
    if (actualHex.toLowerCase() !== expectedIntegrity.toLowerCase()) {
      throw makeUpdateError(
        'UPDATE_INTEGRITY_MISMATCH',
        `SHA-512 hex integrity check failed for ${label}`
      );
    }
  }
}

function verifyRegistryManifestHash(pluginDir, manifest, regEntry) {
  if (!regEntry?.manifestSha512) return;
  if (regEntry.version && manifest.version && regEntry.version !== manifest.version) {
    return;
  }
  const raw = fs.readFileSync(path.join(pluginDir, 'agy-plugin.json'));
  const actualHex = crypto.createHash('sha512').update(raw).digest('hex');
  if (actualHex.toLowerCase() !== String(regEntry.manifestSha512).toLowerCase()) {
    throw makeUpdateError(
      'UPDATE_INTEGRITY_MISMATCH',
      `Registry manifestSha512 mismatch for ${manifest.id}@${manifest.version}`
    );
  }
}

function recordLastFailedVersion(targetId, failedVersion, options = {}) {
  if (!targetId || !failedVersion) return;
  const state = readUpdateState(options);
  if (!state.targets || typeof state.targets !== 'object') state.targets = {};
  const prev = state.targets[targetId] && typeof state.targets[targetId] === 'object'
    ? state.targets[targetId]
    : { targetId };
  state.targets[targetId] = {
    ...prev,
    lastFailedVersion: failedVersion
  };
  writeUpdateState(state, options);
}

function classifyFsError(err) {
  if (err && ['EACCES', 'EPERM', 'EBUSY'].includes(err.code)) {
    return makeUpdateError('UPDATE_FS_PERMISSION_DENIED', err.message, { causeCode: err.code });
  }
  return err;
}

function safeExtractTarGz(tgzBuffer, destDir) {
  try {
    return extractTarGzToDir(tgzBuffer, destDir, { strip: 1 });
  } catch (err) {
    if (/traversal|escaped destination/i.test(err?.message || '')) {
      throw makeUpdateError('UNSAFE_PATH_TRAVERSAL', err.message);
    }
    throw makeUpdateError('MANIFEST_INVALID', err?.message || 'Failed to extract tarball');
  }
}

function extractPackageTarballToDir(tgzBuffer, destDir, archiveSubpath = null) {
  if (!archiveSubpath) {
    return safeExtractTarGz(tgzBuffer, destDir);
  }
  const archiveTmpDir = `${destDir}.archive`;
  fs.rmSync(archiveTmpDir, { recursive: true, force: true });
  fs.mkdirSync(archiveTmpDir, { recursive: true });
  try {
    safeExtractTarGz(tgzBuffer, archiveTmpDir);
    let safeSub;
    try {
      safeSub = assertSafeSubpath(archiveSubpath);
    } catch (err) {
      throw makeUpdateError('UNSAFE_PATH_TRAVERSAL', err.message);
    }
    const subDir = path.resolve(archiveTmpDir, safeSub);
    const rel = path.relative(archiveTmpDir, subDir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw makeUpdateError('UNSAFE_PATH_TRAVERSAL', `Unsafe archive subpath: ${archiveSubpath}`);
    }
    if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) {
      copyDirSync(subDir, destDir);
    } else if (fs.existsSync(path.join(archiveTmpDir, 'package.json'))) {
      copyDirSync(archiveTmpDir, destDir);
    } else {
      throw makeUpdateError('MANIFEST_INVALID', `Archive missing subpath: ${safeSub}`);
    }
  } finally {
    try { fs.rmSync(archiveTmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function applyRegistryUpdate({ targetInfo, runId, trigger, channel, options, checkCtx }) {
  const startMs = Date.now();
  const stateDir = getStateDir(options);
  const stagingRoot = path.join(stateDir, '.staging');
  const stagingDir = path.join(stagingRoot, `reg-${process.pid}-${Date.now()}`);
  const fromVersion = targetInfo.currentVersion || '0.0.0';
  const toVersion = targetInfo.latestVersion || fromVersion;
  let result;

  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    if (!targetInfo.tarballUrl) {
      throw makeUpdateError('UPDATE_NETWORK_ERROR', 'Missing tarball URL for @agy-daddy/registry');
    }
    const tgzBuf = await fetchBufferWithRetry(targetInfo.tarballUrl, {}, checkCtx);
    verifyBufferSha512(tgzBuf, targetInfo.integrity, `@agy-daddy/registry@${toVersion}`);
    extractPackageTarballToDir(tgzBuf, stagingDir, targetInfo.archiveSubpath || null);

    const anchorsPath = path.join(stagingDir, 'anchors.json');
    if (!fs.existsSync(anchorsPath)) {
      throw makeUpdateError('MANIFEST_INVALID', 'Registry tarball missing anchors.json');
    }
    let parsedAnchors;
    try {
      parsedAnchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
    } catch (err) {
      throw makeUpdateError('MANIFEST_INVALID', `Invalid anchors.json: ${err.message}`);
    }
    if (!parsedAnchors || typeof parsedAnchors !== 'object' || !parsedAnchors.anchors || typeof parsedAnchors.anchors !== 'object') {
      throw makeUpdateError('MANIFEST_INVALID', 'Registry anchors.json missing anchors object');
    }
    const missingAnchors = KNOWN_ANCHORS.filter((name) => !parsedAnchors.anchors[name]);
    if (missingAnchors.length > 0) {
      throw makeUpdateError('MANIFEST_INVALID', `Registry anchors.json missing core anchors: ${missingAnchors.join(', ')}`);
    }

    let pkgVer = toVersion;
    const regPkgPath = path.join(stagingDir, 'package.json');
    if (fs.existsSync(regPkgPath)) {
      try {
        const regPkg = JSON.parse(fs.readFileSync(regPkgPath, 'utf8'));
        if (regPkg?.version) pkgVer = String(regPkg.version);
      } catch {}
    }

    if (options.dryRun) {
      result = {
        targetId: 'registry',
        kind: 'registry',
        outcome: 'dry_run',
        fromVersion,
        toVersion: pkgVer
      };
      return result;
    }

    const liveAnchorsPath = path.join(stateDir, 'anchors.json');
    const prevAnchorsPath = path.join(stateDir, 'anchors.prev.json');
    if (fs.existsSync(liveAnchorsPath)) {
      fs.copyFileSync(liveAnchorsPath, prevAnchorsPath);
    }
    safeWriteJsonSync(liveAnchorsPath, parsedAnchors);
    safeWriteJsonSync(path.join(stateDir, 'anchors.meta.json'), {
      version: pkgVer,
      updatedAt: new Date().toISOString(),
      sourceKind: targetInfo.sourceKind || 'npm'
    });

    result = {
      targetId: 'registry',
      kind: 'registry',
      outcome: 'succeeded',
      fromVersion,
      toVersion: pkgVer
    };
    appendUpdateHistory({
      runId,
      trigger,
      targetId: 'registry',
      sourceKind: targetInfo.sourceKind || 'npm',
      sourceUrl: targetInfo.sourceUrl || null,
      channel,
      fromVersion,
      toVersion: pkgVer,
      phase: 'apply',
      durationMs: Date.now() - startMs,
      outcome: 'succeeded'
    }, options);
    return result;
  } catch (err) {
    const normErr = classifyFsError(err);
    appendUpdateHistory({
      runId,
      trigger,
      targetId: 'registry',
      sourceKind: targetInfo.sourceKind || 'npm',
      sourceUrl: targetInfo.sourceUrl || null,
      channel,
      fromVersion,
      toVersion,
      phase: 'apply',
      durationMs: Date.now() - startMs,
      outcome: 'failed',
      errorCode: normErr.code || 'UPDATE_FAILED',
      errorMessage: normErr.message
    }, options);
    throw normErr;
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
}

async function stagePluginCandidate({ rec, targetInfo, regEntry, pluginsDir, options, checkCtx }) {
  const stagingRoot = path.join(pluginsDir, '.staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const stagingDir = path.join(stagingRoot, `upd-${rec.id}-${process.pid}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`);

  try {
    let sourceDir = stagingDir;
    let commitSha = null;
    let npmIntegrity = null;

    if (targetInfo.sourceKind === 'npm') {
      if (!targetInfo.tarballUrl) {
        throw makeUpdateError('UPDATE_NETWORK_ERROR', `Missing npm tarball URL for ${rec.id}`);
      }
      const tgzBuf = await fetchBufferWithRetry(targetInfo.tarballUrl, {}, checkCtx);
      verifyBufferSha512(tgzBuf, targetInfo.integrity, `${rec.id}@${targetInfo.latestVersion}`);
      npmIntegrity = targetInfo.integrity || null;
      safeExtractTarGz(tgzBuf, stagingDir);
    } else {
      const gitRun = options.gitRunner || defaultGitRunner;
      const repoUrl = targetInfo.sourceUrl || rec.sourceSpec;
      let cloneUrl = repoUrl;
      if (String(cloneUrl || '').startsWith('github:')) {
        const slug = cloneUrl.slice('github:'.length).split('#')[0].replace(/\.git$/, '');
        cloneUrl = `https://github.com/${slug}.git`;
      } else if (String(cloneUrl || '').startsWith('git:')) {
        cloneUrl = cloneUrl.slice('git:'.length).split('#')[0];
      }
      if (!options.gitRunner && isTestMode() && !isLoopbackOrLocalUrl(cloneUrl) && options.allowNetworkInTest !== true) {
        throw makeUpdateError('UPDATE_NETWORK_ERROR', `Test mode blocked git clone from ${redactUrl(cloneUrl)}`);
      }
      const cloneArgs = ['clone', '--depth', '1'];
      if (targetInfo.candidateRef) {
        cloneArgs.push('--branch', targetInfo.candidateRef);
      }
      cloneArgs.push(cloneUrl, stagingDir);
      gitRun(cloneArgs);
      try {
        commitSha = gitRun(['rev-parse', 'HEAD'], stagingDir) || targetInfo.latestCommit || null;
      } catch {
        commitSha = targetInfo.latestCommit || null;
      }
      const subpath = rec.subpath || regEntry?.subpath || null;
      if (subpath) {
        let safeSubpath;
        try {
          safeSubpath = assertSafeSubpath(subpath);
        } catch (err) {
          throw makeUpdateError('UNSAFE_PATH_TRAVERSAL', err.message);
        }
        const resolvedSubdir = path.resolve(stagingDir, safeSubpath);
        const rel = path.relative(stagingDir, resolvedSubdir);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
          throw makeUpdateError('UNSAFE_PATH_TRAVERSAL', `Unsafe subpath: ${subpath}`);
        }
        if (!fs.existsSync(resolvedSubdir) || !fs.statSync(resolvedSubdir).isDirectory()) {
          throw makeUpdateError('MANIFEST_INVALID', `Subpath missing in repository: ${safeSubpath}`);
        }
        sourceDir = resolvedSubdir;
      }
    }

    let manifest;
    try {
      manifest = readManifestFromDir(sourceDir);
    } catch (err) {
      throw makeUpdateError('MANIFEST_INVALID', err.message);
    }
    if (manifest.id !== rec.id) {
      throw makeUpdateError('MANIFEST_INVALID', `Manifest id mismatch: expected ${rec.id}, got ${manifest.id}`);
    }
    if (manifest.world !== 'isolated') {
      throw makeUpdateError('MANIFEST_INVALID', `Plugin ${rec.id} must declare world="isolated"`);
    }
    if ((manifest.permissions || []).includes('page:main-world')) {
      throw makeUpdateError('MANIFEST_INVALID', `Forbidden permission page:main-world in ${rec.id}`);
    }
    if (!satisfies(HOST_API_VERSION, manifest.engines.agyDaddy)) {
      throw makeUpdateError(
        'HOST_API_INCOMPATIBLE',
        `${rec.id}@${manifest.version} requires @agy-daddy/host API ${manifest.engines.agyDaddy} (current: ${HOST_API_VERSION})`
      );
    }
    verifyRegistryManifestHash(sourceDir, manifest, regEntry);
    if (targetInfo.manifestSha512) {
      const raw = fs.readFileSync(path.join(sourceDir, 'agy-plugin.json'));
      const actualHex = crypto.createHash('sha512').update(raw).digest('hex');
      if (actualHex.toLowerCase() !== String(targetInfo.manifestSha512).toLowerCase()) {
        throw makeUpdateError('UPDATE_INTEGRITY_MISMATCH', `Release manifestSha512 mismatch for ${rec.id}@${manifest.version}`);
      }
    }

    const cmp = compareSemverSafe(manifest.version, rec.version || '0.0.0');
    const isCommitOnlyUpdate = Boolean(
      targetInfo.sourceKind !== 'npm' &&
      commitSha &&
      rec.commitSha &&
      commitSha !== rec.commitSha
    );
    if (cmp !== null && (cmp < 0 || (cmp === 0 && !isCommitOnlyUpdate))) {
      throw makeUpdateError(
        'UPDATE_DOWNGRADE_BLOCKED',
        `Refusing downgrade for ${rec.id}: ${rec.version} -> ${manifest.version}`
      );
    }

    return {
      stagingDir,
      sourceDir,
      manifest,
      commitSha,
      npmIntegrity
    };
  } catch (err) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    throw classifyFsError(err);
  }
}

function installPluginWatchdog(daemon, pluginId, targetVersion, options = {}) {
  if (!daemon || typeof daemon.on !== 'function' || !daemon.bus) return;
  const watchMs = Number.isFinite(Number(options.postUpdateWatchMs))
    ? Math.max(0, Number(options.postUpdateWatchMs))
    : (isTestMode() ? 200 : 5000);
  if (watchMs <= 0) return;

  const prevErrors = daemon.pluginErrors?.get?.(pluginId)?.at || 0;
  let settled = false;

  const triggerAutoRollback = async (reason) => {
    if (settled) return;
    settled = true;
    cleanup();
    try {
      const rb = rollbackPlugin(pluginId, options);
      await daemon.reloadPlugin(pluginId, { resetCircuit: true }).catch(() => {});
      recordLastFailedVersion(pluginId, targetVersion, options);
      appendUpdateHistory({
        trigger: 'auto-rollback',
        targetId: pluginId,
        fromVersion: targetVersion,
        toVersion: rb?.plugin?.version || null,
        phase: 'probe',
        outcome: 'rolled_back',
        errorCode: 'UPDATE_ROLLBACK_TRIGGERED',
        errorMessage: `Auto-rolled back ${pluginId}@${targetVersion}: ${reason}`
      }, options);
      daemon.publishUpdatesState?.();
    } catch {}
  };

  const onCircuit = (payload) => {
    if (payload?.pluginId === pluginId) {
      void triggerAutoRollback(payload.lastError || 'circuit opened');
    }
  };
  const unsubCircuit = daemon.bus.onEvent('agy-daddy.host', 'host:plugin-circuit-opened@1', onCircuit);
  const pollTimer = setInterval(() => {
    if (settled || !daemon.running) {
      cleanup();
      return;
    }
    const diag = daemon.pluginErrors?.get?.(pluginId);
    if (diag && diag.at > prevErrors) {
      void triggerAutoRollback(diag.message || diag.code || 'plugin error');
    }
  }, Math.min(250, Math.max(25, Math.floor(watchMs / 4))));
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  const stopTimer = setTimeout(() => {
    settled = true;
    cleanup();
  }, watchMs);
  if (typeof stopTimer.unref === 'function') stopTimer.unref();

  const cleanup = () => {
    clearInterval(pollTimer);
    clearTimeout(stopTimer);
    try { unsubCircuit(); } catch {}
    daemon._activeUpdateWatchdogs?.delete?.(pluginId);
  };

  if (daemon._activeUpdateWatchdogs instanceof Map) {
    const prevCleanup = daemon._activeUpdateWatchdogs.get(pluginId);
    if (typeof prevCleanup === 'function') prevCleanup();
    daemon._activeUpdateWatchdogs.set(pluginId, cleanup);
  }
}

async function applyPluginUpdate({
  rec,
  targetInfo,
  regEntry,
  request,
  options,
  checkCtx,
  runId,
  trigger,
  channel,
  daemon
}) {
  const startMs = Date.now();
  const pluginsDir = getPluginsDir(options);
  const grantedPrev = Array.isArray(rec.grantedPermissions) ? rec.grantedPermissions : [];
  const trustLevel = rec.trustLevel || regEntry?.trustLevel || 'T2';

  const staged = await stagePluginCandidate({ rec, targetInfo, regEntry, pluginsDir, options, checkCtx });
  try {
    const manifest = staged.manifest;
    const manifestPerms = Array.isArray(manifest.permissions) ? manifest.permissions : [];
    const addedPermissions = manifestPerms.filter((p) => !grantedPrev.includes(p));
    const addedHighRiskPermissions = addedPermissions.filter(isHighRiskPermission);
    const reqGrantedMap = request.grantedPermissions && typeof request.grantedPermissions === 'object'
      ? request.grantedPermissions
      : {};
    const explicitForPlugin = Array.isArray(reqGrantedMap[rec.id])
      ? reqGrantedMap[rec.id]
      : (Array.isArray(request.grantedPermissionsList) ? request.grantedPermissionsList : []);

    const effectiveGranted = Array.from(new Set([...grantedPrev, ...explicitForPlugin]));
    const trustPolicy = evaluateTrustPolicy(manifest, trustLevel, effectiveGranted);
    const unapprovedAdditions = addedPermissions.filter((p) => !explicitForPlugin.includes(p));

    if ((!trustPolicy.allowed || unapprovedAdditions.length > 0) && request.approveAllPermissions !== true) {
      const confirmation = {
        pluginId: rec.id,
        displayName: (typeof manifest.displayName === 'string' ? manifest.displayName : manifest.displayName?.['zh-CN'] || manifest.displayName?.en) || rec.id,
        trustLevel: trustPolicy.trustLevel,
        fromVersion: rec.version,
        toVersion: manifest.version,
        currentPermissions: grantedPrev,
        addedPermissions,
        addedHighRiskPermissions
      };
      return {
        needsPermissionConfirm: true,
        confirmation
      };
    }

    const major = isMajorBump(rec.version, manifest.version);
    if (major && !request.allowMajor && !request.yes) {
      return {
        needsMajorConfirm: true,
        confirmation: {
          pluginId: rec.id,
          displayName: (typeof manifest.displayName === 'string' ? manifest.displayName : manifest.displayName?.['zh-CN'] || manifest.displayName?.en) || rec.id,
          trustLevel: trustPolicy.trustLevel,
          fromVersion: rec.version,
          toVersion: manifest.version,
          isMajor: true,
          currentPermissions: grantedPrev,
          addedPermissions: [],
          addedHighRiskPermissions: []
        }
      };
    }

    if (request.dryRun || options.dryRun) {
      return {
        targetId: rec.id,
        kind: 'plugin',
        outcome: 'dry_run',
        fromVersion: rec.version,
        toVersion: manifest.version
      };
    }

    const targetDir = path.join(pluginsDir, assertSafePluginId(rec.id));
    const rollbackDir = path.join(pluginsDir, '.rollback', `${rec.id}.prev`);
    const index = readInstalledIndex(options);
    const prevRecord = index.plugins[rec.id] || rec;
    const backedUpPrev = backupForRollback(targetDir, rollbackDir, prevRecord);

    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      if (staged.sourceDir !== staged.stagingDir) {
        copyDirSync(staged.sourceDir, targetDir);
      } else {
        moveDirSync(staged.stagingDir, targetDir);
      }
    } catch (swapErr) {
      if (fs.existsSync(rollbackDir)) {
        try { rollbackPlugin(rec.id, options); } catch {}
      }
      throw classifyFsError(swapErr);
    }

    const nextRecord = {
      ...prevRecord,
      id: rec.id,
      version: manifest.version,
      trustLevel: trustPolicy.trustLevel,
      badge: trustPolicy.badge,
      world: trustPolicy.world,
      nodeIsolation: trustPolicy.nodeIsolation,
      autoUpdateAllowed: trustPolicy.autoUpdateAllowed,
      grantedPermissions: trustPolicy.granted,
      sourceKind: targetInfo.sourceKind || prevRecord.sourceKind,
      sourceSpec: prevRecord.sourceSpec,
      subpath: prevRecord.subpath || null,
      installPath: targetDir,
      commitSha: staged.commitSha || prevRecord.commitSha || null,
      npmIntegrity: staged.npmIntegrity || prevRecord.npmIntegrity || null,
      pinned: Boolean(prevRecord.pinned),
      installedChannel: channel,
      enabled: prevRecord.enabled !== false,
      previousRecord: backedUpPrev,
      updatedAt: new Date().toISOString()
    };

    const nativeSync = options.syncNative === false
      ? { ok: true, synced: false, skipped: true }
      : syncPluginNativeArtifacts(targetDir, manifest, {
          ...options,
          grantedPermissions: trustPolicy.granted,
          nativeConfig: nextRecord.nativeConfig
        });

    index.plugins[rec.id] = nextRecord;
    writeInstalledIndex(index, options);

    const usesLaunchArgs = Boolean(
      manifestPerms.includes('host:launch-args') || trustPolicy.granted.includes('host:launch-args')
    );

    if (daemon) {
      if (rec.id === 'agy-daddy.web' && trigger === 'web') {
        const timer = setTimeout(() => {
          void daemon.reloadPlugin('agy-daddy.web', { resetCircuit: true }).catch(() => {});
        }, 250);
        if (typeof timer.unref === 'function') timer.unref();
        appendUpdateHistory({
          runId,
          trigger,
          targetId: rec.id,
          sourceKind: nextRecord.sourceKind,
          sourceUrl: targetInfo.sourceUrl || null,
          channel,
          fromVersion: rec.version,
          toVersion: manifest.version,
          phase: 'apply',
          durationMs: Date.now() - startMs,
          outcome: 'succeeded'
        }, options);
        return {
          targetId: rec.id,
          kind: 'plugin',
          outcome: 'succeeded',
          fromVersion: rec.version,
          toVersion: manifest.version,
          deferredReload: true,
          nativeSync,
          hostRestartRequired: usesLaunchArgs
        };
      }

      let reloadFailed = false;
      let reloadErrorMsg = '';
      try {
        const reloadRes = await daemon.reloadPlugin(rec.id, { resetCircuit: true });
        if (reloadRes && reloadRes.ok === false) {
          reloadFailed = true;
          reloadErrorMsg = reloadRes.error || 'Plugin reload failed';
        }
        const initialWaitMs = Number.isFinite(Number(options.initialProbeMs))
          ? Math.max(0, Number(options.initialProbeMs))
          : (isTestMode() ? 40 : 250);
        if (!reloadFailed && initialWaitMs > 0) {
          await new Promise((r) => setTimeout(r, initialWaitMs));
        }
        const health = daemon.getPluginHealth?.(rec.id);
        if (
          !reloadFailed &&
          health &&
          (health.circuitOpen || health.lastError || (manifest.main && nextRecord.enabled !== false && !health.active))
        ) {
          reloadFailed = true;
          reloadErrorMsg = health.lastError || 'Plugin failed health probe after update';
        }
      } catch (err) {
        reloadFailed = true;
        reloadErrorMsg = err?.message || String(err);
      }

      if (reloadFailed) {
        const rb = rollbackPlugin(rec.id, options);
        await daemon.reloadPlugin(rec.id, { resetCircuit: true }).catch(() => {});
        recordLastFailedVersion(rec.id, manifest.version, options);
        appendUpdateHistory({
          runId,
          trigger,
          targetId: rec.id,
          sourceKind: nextRecord.sourceKind,
          sourceUrl: targetInfo.sourceUrl || null,
          channel,
          fromVersion: rec.version,
          toVersion: manifest.version,
          phase: 'probe',
          durationMs: Date.now() - startMs,
          outcome: 'rolled_back',
          errorCode: 'UPDATE_ROLLBACK_TRIGGERED',
          errorMessage: reloadErrorMsg
        }, options);
        return {
          targetId: rec.id,
          kind: 'plugin',
          outcome: 'rolled_back',
          fromVersion: rec.version,
          toVersion: manifest.version,
          restoredVersion: rb?.plugin?.version || rec.version,
          errorCode: 'UPDATE_ROLLBACK_TRIGGERED',
          errorMessage: reloadErrorMsg
        };
      }

      installPluginWatchdog(daemon, rec.id, manifest.version, options);
    }

    appendUpdateHistory({
      runId,
      trigger,
      targetId: rec.id,
      sourceKind: nextRecord.sourceKind,
      sourceUrl: targetInfo.sourceUrl || null,
      channel,
      fromVersion: rec.version,
      toVersion: manifest.version,
      phase: 'apply',
      durationMs: Date.now() - startMs,
      outcome: 'succeeded'
    }, options);

    return {
      targetId: rec.id,
      kind: 'plugin',
      outcome: 'succeeded',
      fromVersion: rec.version,
      toVersion: manifest.version,
      nativeSync,
      hostRestartRequired: usesLaunchArgs
    };
  } finally {
    try { fs.rmSync(staged.stagingDir, { recursive: true, force: true }); } catch {}
  }
}

function resolveSupervisorLaunchCommand(hostInfo, options = {}) {
  const cliPath = path.join(hostInfo.hostRoot, 'src', 'cli.js');
  if (process.env.AGY_DADDY_LAUNCHD === '1') {
    return {
      supervisorMode: 'launchd',
      launchCommand: {
        bin: process.execPath,
        args: [cliPath, 'live', '--replace'],
        env: { ...process.env }
      }
    };
  }
  return {
    supervisorMode: options.supervisorMode || 'live',
    launchCommand: options.launchCommand || {
      bin: process.execPath,
      args: [cliPath, 'live', '--replace'],
      env: { ...process.env }
    }
  };
}

function spawnDetachedHelper(helperCopyPath, planPath, stateDir, options = {}) {
  if (typeof options.spawnHelper === 'function') {
    return options.spawnHelper(helperCopyPath, planPath, stateDir);
  }
  const child = spawn(process.execPath, [helperCopyPath, planPath], {
    cwd: stateDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env }
  });
  if (typeof child.unref === 'function') child.unref();
  return child;
}

async function applyHostUpdate({ hostInfo, targetInfo, runId, trigger, channel, npmRegistryUrl, request, options, checkCtx, daemon }) {
  const startMs = Date.now();
  const stateDir = getStateDir(options);
  const fromVersion = hostInfo.hostVersion;
  const toVersion = targetInfo.latestVersion || fromVersion;

  if (hostInfo.installMode === 'git') {
    if (hostInfo.dirtyWorktree) {
      throw makeUpdateError('DIRTY_WORKTREE', '工作区存在未提交改动，已阻止自动拉取');
    }
    if (request.dryRun || options.dryRun) {
      return { targetId: 'host', kind: 'host', outcome: 'dry_run', fromVersion, toVersion };
    }
    const gitRun = options.gitRunner || defaultGitRunner;
    const origHead = gitRun(['rev-parse', 'HEAD'], hostInfo.hostRoot);
    try {
      gitRun(['pull', '--ff-only'], hostInfo.hostRoot);
    } catch (err) {
      throw makeUpdateError('UPDATE_NETWORK_ERROR', `git pull --ff-only failed: ${err.message}`);
    }
    if (daemon && typeof daemon.requestDaemonRestart === 'function') {
      try {
        await daemon.requestDaemonRestart({ rebuildRenderer: true, reason: 'host_update' });
      } catch (err) {
        try { gitRun(['reset', '--hard', origHead], hostInfo.hostRoot); } catch {}
        throw makeUpdateError('UPDATE_ROLLBACK_TRIGGERED', `Daemon restart failed after git pull, reset to ${origHead}: ${err.message}`);
      }
    }
    appendUpdateHistory({
      runId,
      trigger,
      targetId: 'host',
      sourceKind: 'git',
      sourceUrl: targetInfo.sourceUrl || null,
      channel,
      fromVersion,
      toVersion,
      phase: 'apply',
      durationMs: Date.now() - startMs,
      outcome: 'succeeded'
    }, options);
    return {
      targetId: 'host',
      kind: 'host',
      outcome: 'succeeded',
      fromVersion,
      toVersion,
      requiresDaemonRestart: true
    };
  }

  if (hostInfo.installMode === 'npm-global') {
    if (!hostInfo.writable) {
      throw makeUpdateError(
        'UPDATE_FS_PERMISSION_DENIED',
        `无全局安装目录写权限 (${hostInfo.hostRoot})，请手动执行: npm install -g @agy-daddy/host@${toVersion}`
      );
    }
    if (request.dryRun || options.dryRun) {
      return { targetId: 'host', kind: 'host', outcome: 'dry_run', fromVersion, toVersion };
    }
    const npmArgs = ['install', '-g', `@agy-daddy/host@${toVersion}`];
    if (npmRegistryUrl) npmArgs.push('--registry', npmRegistryUrl);
    const execFn = options.execNpmGlobal || ((args) => execFileSync('npm', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true
    }));
    try {
      execFn(npmArgs);
    } catch (err) {
      throw makeUpdateError('UPDATE_FS_PERMISSION_DENIED', `npm global install failed: ${err.message}`);
    }
    if (daemon && typeof daemon.requestDaemonRestart === 'function') {
      await daemon.requestDaemonRestart({ rebuildRenderer: false, reason: 'host_update' });
    }
    appendUpdateHistory({
      runId,
      trigger,
      targetId: 'host',
      sourceKind: 'npm',
      sourceUrl: targetInfo.sourceUrl || null,
      channel,
      fromVersion,
      toVersion,
      phase: 'apply',
      durationMs: Date.now() - startMs,
      outcome: 'succeeded'
    }, options);
    return {
      targetId: 'host',
      kind: 'host',
      outcome: 'succeeded',
      fromVersion,
      toVersion,
      requiresDaemonRestart: true
    };
  }

  // Wrapper / one-click install mode
  if (!hostInfo.writable) {
    throw makeUpdateError('UPDATE_FS_PERMISSION_DENIED', `无安装目录写权限: ${hostInfo.hostRoot}`);
  }
  if (!targetInfo.tarballUrl) {
    throw makeUpdateError('UPDATE_NETWORK_ERROR', 'Missing tarball URL for @agy-daddy/host');
  }

  const stagingDir = `${hostInfo.hostRoot}.staging.${process.pid}.${Date.now()}`;
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    const tgzBuf = await fetchBufferWithRetry(targetInfo.tarballUrl, {}, checkCtx);
    verifyBufferSha512(tgzBuf, targetInfo.integrity, `@agy-daddy/host@${toVersion}`);
    extractPackageTarballToDir(tgzBuf, stagingDir, targetInfo.archiveSubpath || null);

    const rendererDist = path.join(stagingDir, 'dist', 'host-renderer.js');
    const buildRendererScript = path.join(stagingDir, 'scripts', 'build-renderer.js');
    if (!fs.existsSync(rendererDist) && fs.existsSync(buildRendererScript)) {
      execFileSync(process.execPath, [buildRendererScript], {
        cwd: stagingDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    }

    const requiredFiles = ['package.json', 'bin/agy-daddy.js', 'src/cli.js', 'dist/host-renderer.js'];
    for (const rel of requiredFiles) {
      if (!fs.existsSync(path.join(stagingDir, rel))) {
        throw makeUpdateError('MANIFEST_INVALID', `Host package missing required file: ${rel}`);
      }
    }

    if (request.dryRun || options.dryRun) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      return { targetId: 'host', kind: 'host', outcome: 'dry_run', fromVersion, toVersion };
    }

    const runDir = path.join(stateDir, 'updater-run', runId);
    fs.mkdirSync(runDir, { recursive: true });
    const helperCopyPath = path.join(runDir, 'updater-helper.js');
    fs.copyFileSync(HELPER_SOURCE_PATH, helperCopyPath);

    const { supervisorMode, launchCommand } = resolveSupervisorLaunchCommand(hostInfo, options);
    const planPath = path.join(runDir, 'plan.json');
    const plan = {
      mode: 'apply',
      runId,
      runDir,
      trigger,
      stateDir,
      installDir: hostInfo.hostRoot,
      stagingDir,
      backupDir: `${hostInfo.hostRoot}.prev`,
      oldPid: daemon ? process.pid : null,
      fromVersion,
      targetVersion: toVersion,
      channel,
      sourceKind: targetInfo.sourceKind || 'npm',
      sourceUrl: targetInfo.sourceUrl || null,
      wrapperVersion: hostInfo.wrapperVersion || null,
      supervisorMode: daemon ? supervisorMode : (options.supervisorMode || 'none'),
      launchCommand: daemon ? launchCommand : (options.launchCommand || null),
      syncAnchorsToStateDir: options.syncAnchorsToStateDir !== false,
      lockPath: getUpdateLockPath(stateDir),
      historyPath: getUpdateHistoryPath(options),
      stateFilePath: getUpdateStatePath(options),
      healthTimeoutMs: options.helperHealthTimeoutMs || 10000,
      waitOldPidTimeoutMs: options.helperWaitTimeoutMs || 10000
    };
    safeWriteJsonSync(planPath, plan);

    if (options.handoffMode === 'inline') {
      const { runUpdaterHelper } = require('./updater-helper');
      const helperRes = await runUpdaterHelper(plan, options.helperDeps || {});
      return {
        targetId: 'host',
        kind: 'host',
        handoff: true,
        inline: true,
        outcome: helperRes.ok ? 'succeeded' : (helperRes.rolledBack ? 'rolled_back' : 'failed'),
        fromVersion,
        toVersion,
        ...helperRes
      };
    }

    const child = spawnDetachedHelper(helperCopyPath, planPath, stateDir, options);
    if (child?.pid) {
      transferUpdateLock(stateDir, child.pid, runId);
    }

    if (daemon) {
      const exitDelay = Number.isFinite(Number(options.handoffExitDelayMs)) ? Number(options.handoffExitDelayMs) : 120;
      const timer = setTimeout(async () => {
        try { await daemon.stop(); } catch {}
        if (typeof options.onHandoffExit === 'function') {
          options.onHandoffExit(0);
        } else if (!isTestMode()) {
          process.exit(0);
        }
      }, exitDelay);
      if (typeof timer.unref === 'function') timer.unref();
    }

    return {
      targetId: 'host',
      kind: 'host',
      handoff: true,
      keepLockForHelper: true,
      outcome: 'handoff',
      fromVersion,
      toVersion,
      planPath
    };
  } catch (err) {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    throw classifyFsError(err);
  }
}

async function applyUpdates(request = {}, options = {}) {
  const stateDir = getStateDir(options);
  const trigger = request.trigger || options.trigger || 'cli';
  const runId = `upd_${crypto.randomBytes(4).toString('hex')}`;
  const rawTargets = request.targets !== undefined ? request.targets : 'all';
  const lock = acquireUpdateLock(stateDir, {
    runId,
    trigger,
    targets: Array.isArray(rawTargets) ? rawTargets : [String(rawTargets)]
  }, options);

  let lockTransferredToHelper = false;
  try {
    const daemon = options.daemon || null;
    const hostSettings = normalizeHostUpdateSettingsView(options.hostSettings || daemon?.getHostSettings?.() || {});
    const channel = request.channel || hostSettings.updateChannel;
    const sourcePreference = request.sourcePreference || hostSettings.updateSourcePreference;
    const npmRegistryUrl = resolveEffectiveNpmRegistry({ npmRegistryUrl: request.npmRegistryUrl || options.npmRegistryUrl }, hostSettings);

    const checkResult = request.checkResult || options.checkResult || await checkUpdates({
      ...options,
      stateDir,
      hostSettings,
      targets: rawTargets,
      channel,
      sourcePreference,
      npmRegistryUrl,
      forceRefresh: true,
      ignoreDebounce: true,
      trigger
    });

    const hostInfo = detectHostInstallMode({ ...options, stateDir });
    const installedIndex = readInstalledIndex(options);
    const reg = loadRegistry(options);
    const regById = new Map((Array.isArray(reg?.plugins) ? reg.plugins : []).map((p) => [p.id, p]));

    const requestedArr = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
    const wantsAll = requestedArr.includes('all');
    const wantsPlugins = wantsAll || requestedArr.includes('plugins');
    const wantsHost = wantsAll || requestedArr.includes('host');
    const wantsRegistry = wantsAll || requestedArr.includes('registry');

    const checkCtx = {
      fetch: options.fetch,
      allowNetworkInTest: options.allowNetworkInTest,
      timeoutMs: options.downloadTimeoutMs || DOWNLOAD_TIMEOUT_MS,
      retryDelaysMs: options.retryDelaysMs,
      rateLimits: checkResult.rateLimits || {}
    };

    const results = [];
    const permissionConfirmations = [];
    const majorConfirmations = [];
    let handoff = false;
    let deferredReload = false;
    let hostRestartRequired = false;

    const hostTarget = checkResult.targets?.host;
    if (wantsHost && hostTarget) {
      if (hostTarget.status === 'blocked') {
        const errCode = hostTarget.blockReason || 'UPDATE_NETWORK_ERROR';
        results.push({
          targetId: 'host',
          kind: 'host',
          outcome: 'blocked',
          errorCode: errCode,
          fromVersion: hostTarget.currentVersion,
          toVersion: hostTarget.latestVersion
        });
      } else if (hostTarget.status === 'available') {
        const major = isMajorBump(hostTarget.currentVersion, hostTarget.latestVersion);
        if (major && !request.allowMajor && !request.yes) {
          majorConfirmations.push({
            pluginId: 'host',
            targetId: 'host',
            displayName: '@agy-daddy/host',
            fromVersion: hostTarget.currentVersion,
            toVersion: hostTarget.latestVersion,
            isMajor: true,
            currentPermissions: [],
            addedPermissions: [],
            addedHighRiskPermissions: []
          });
        } else {
          try {
            const hRes = await applyHostUpdate({
              hostInfo,
              targetInfo: hostTarget,
              runId,
              trigger,
              channel,
              npmRegistryUrl,
              request,
              options,
              checkCtx,
              daemon
            });
            results.push(hRes);
            if (hRes.handoff) handoff = true;
            if (hRes.keepLockForHelper) lockTransferredToHelper = true;
          } catch (err) {
            results.push({
              targetId: 'host',
              kind: 'host',
              outcome: 'failed',
              errorCode: err.code || 'UPDATE_FAILED',
              errorMessage: err.message,
              fromVersion: hostTarget.currentVersion,
              toVersion: hostTarget.latestVersion
            });
          }
        }
      } else {
        results.push({
          targetId: 'host',
          kind: 'host',
          outcome: 'up_to_date',
          fromVersion: hostTarget.currentVersion,
          toVersion: hostTarget.currentVersion
        });
      }
    }

    if (handoff && !lockTransferredToHelper && wantsHost && results.some((r) => r.targetId === 'host' && r.outcome === 'handoff')) {
      lockTransferredToHelper = true;
    }

    // If host just handed off to detached helper (exiting daemon), return early so helper takes over cleanly
    if (handoff && results.some((r) => r.targetId === 'host' && r.outcome === 'handoff')) {
      return {
        ok: true,
        runId,
        handoff: true,
        deferredReload: false,
        hostRestartRequired: false,
        results,
        summary: checkResult.summary
      };
    }

    const regTarget = checkResult.targets?.registry;
    if (wantsRegistry && regTarget) {
      if (regTarget.status === 'available') {
        try {
          results.push(await applyRegistryUpdate({
            targetInfo: regTarget,
            runId,
            trigger,
            channel,
            options,
            checkCtx
          }));
        } catch (err) {
          results.push({
            targetId: 'registry',
            kind: 'registry',
            outcome: 'failed',
            errorCode: err.code || 'UPDATE_FAILED',
            errorMessage: err.message,
            fromVersion: regTarget.currentVersion,
            toVersion: regTarget.latestVersion
          });
        }
      } else {
        results.push({
          targetId: 'registry',
          kind: 'registry',
          outcome: 'up_to_date',
          fromVersion: regTarget.currentVersion,
          toVersion: regTarget.currentVersion
        });
      }
    }

    // Collect plugin targets and sort topologically (with agy-daddy.web last)
    const pluginRecs = [];
    for (const rec of Object.values(installedIndex.plugins || {})) {
      if (!rec?.id) continue;
      if (wantsPlugins || requestedArr.includes(rec.id)) {
        let manifest = null;
        if (rec.installPath && fs.existsSync(rec.installPath)) {
          try { manifest = readManifestFromDir(rec.installPath); } catch {}
        }
        pluginRecs.push({
          rec,
          manifest: manifest || { id: rec.id, provides: {}, consumes: {} }
        });
      }
    }
    const sortedPlugins = sortPluginsByDependency(pluginRecs);
    const webIdx = sortedPlugins.findIndex((x) => x.rec.id === 'agy-daddy.web');
    if (webIdx >= 0 && webIdx !== sortedPlugins.length - 1) {
      const [webItem] = sortedPlugins.splice(webIdx, 1);
      sortedPlugins.push(webItem);
    }

    for (const { rec } of sortedPlugins) {
      const tInfo = checkResult.targets?.[rec.id];
      if (!tInfo) continue;
      if (tInfo.status === 'local_exempt') {
        results.push({
          targetId: rec.id,
          kind: 'plugin',
          outcome: 'skipped',
          errorCode: 'LOCAL_SOURCE_EXEMPT',
          fromVersion: rec.version,
          toVersion: rec.version
        });
        continue;
      }
      if (rec.pinned && !request.ignorePin) {
        results.push({
          targetId: rec.id,
          kind: 'plugin',
          outcome: 'blocked',
          errorCode: 'PLUGIN_PINNED',
          fromVersion: rec.version,
          toVersion: tInfo.latestVersion
        });
        continue;
      }
      if (tInfo.status === 'blocked' && tInfo.blockReason === 'HOST_API_INCOMPATIBLE') {
        results.push({
          targetId: rec.id,
          kind: 'plugin',
          outcome: 'blocked',
          errorCode: 'HOST_API_INCOMPATIBLE',
          fromVersion: rec.version,
          toVersion: tInfo.latestVersion
        });
        continue;
      }
      if (tInfo.status === 'up_to_date') {
        results.push({
          targetId: rec.id,
          kind: 'plugin',
          outcome: 'up_to_date',
          fromVersion: rec.version,
          toVersion: rec.version
        });
        continue;
      }

      try {
        const pRes = await applyPluginUpdate({
          rec,
          targetInfo: tInfo,
          regEntry: regById.get(rec.id),
          request,
          options,
          checkCtx,
          runId,
          trigger,
          channel,
          daemon
        });
        if (pRes.needsPermissionConfirm) {
          permissionConfirmations.push(pRes.confirmation);
          continue;
        }
        if (pRes.needsMajorConfirm) {
          majorConfirmations.push(pRes.confirmation);
          continue;
        }
        if (pRes.deferredReload) deferredReload = true;
        if (pRes.hostRestartRequired) hostRestartRequired = true;
        results.push(pRes);
      } catch (err) {
        appendUpdateHistory({
          runId,
          trigger,
          targetId: rec.id,
          sourceKind: tInfo.sourceKind || rec.sourceKind,
          sourceUrl: tInfo.sourceUrl || null,
          channel,
          fromVersion: rec.version,
          toVersion: tInfo.latestVersion,
          phase: 'apply',
          outcome: 'failed',
          errorCode: err.code || 'UPDATE_FAILED',
          errorMessage: err.message
        }, options);
        results.push({
          targetId: rec.id,
          kind: 'plugin',
          outcome: 'failed',
          errorCode: err.code || 'UPDATE_FAILED',
          errorMessage: err.message,
          fromVersion: rec.version,
          toVersion: tInfo.latestVersion
        });
      }
    }

    if (permissionConfirmations.length > 0 || majorConfirmations.length > 0) {
      const isPerm = permissionConfirmations.length > 0;
      const errCode = isPerm ? 'PERMISSION_CONFIRMATION_REQUIRED' : 'MAJOR_UPDATE_CONFIRMATION_REQUIRED';
      const updatedView = getCachedUpdateStatus({ ...options, stateDir, hostSettings });
      return {
        ok: false,
        runId,
        errorCode: errCode,
        needsPermissionConfirm: isPerm,
        needsMajorConfirm: majorConfirmations.length > 0,
        confirmations: [...permissionConfirmations, ...majorConfirmations],
        results,
        summary: updatedView.summary
      };
    }

    const hasFailures = results.some((r) => r.outcome === 'failed' || r.outcome === 'rolled_back' || r.outcome === 'blocked');
    const updatedView = getCachedUpdateStatus({ ...options, stateDir, hostSettings });

    return {
      ok: !hasFailures,
      runId,
      handoff,
      deferredReload,
      hostRestartRequired,
      results,
      summary: updatedView.summary
    };
  } finally {
    if (!lockTransferredToHelper) {
      releaseUpdateLock(stateDir, lock.runId);
    }
  }
}

async function rollbackUpdate(request = {}, options = {}) {
  const startMs = Date.now();
  const stateDir = getStateDir(options);
  const target = String(request.target || '').trim();
  if (!target) {
    throw makeUpdateError('INVALID_TARGET', 'rollbackUpdate requires target');
  }
  const trigger = request.trigger || options.trigger || 'cli';
  const runId = `rb_${crypto.randomBytes(4).toString('hex')}`;
  const daemon = options.daemon || null;
  const lock = acquireUpdateLock(stateDir, { runId, trigger, targets: [target] }, options);
  let lockTransferredToHelper = false;

  try {
    if (target === 'registry') {
      const prevPath = path.join(stateDir, 'anchors.prev.json');
      const livePath = path.join(stateDir, 'anchors.json');
      if (!fs.existsSync(prevPath)) {
        throw makeUpdateError('NO_ROLLBACK_SNAPSHOT', 'No rollback snapshot available for registry anchors');
      }
      fs.copyFileSync(prevPath, livePath);
      appendUpdateHistory({
        runId,
        trigger,
        targetId: 'registry',
        phase: 'rollback',
        durationMs: Date.now() - startMs,
        outcome: 'rolled_back'
      }, options);
      return { ok: true, target: 'registry', handoff: false };
    }

    if (target === 'host') {
      const hostInfo = detectHostInstallMode({ ...options, stateDir });
      const backupDir = `${hostInfo.hostRoot}.prev`;
      if (!fs.existsSync(backupDir)) {
        throw makeUpdateError('NO_ROLLBACK_SNAPSHOT', 'No rollback snapshot available for @agy-daddy/host');
      }
      const runDir = path.join(stateDir, 'updater-run', runId);
      fs.mkdirSync(runDir, { recursive: true });
      const helperCopyPath = path.join(runDir, 'updater-helper.js');
      fs.copyFileSync(HELPER_SOURCE_PATH, helperCopyPath);
      const { supervisorMode, launchCommand } = resolveSupervisorLaunchCommand(hostInfo, options);
      const planPath = path.join(runDir, 'plan.json');
      const plan = {
        mode: 'rollback',
        runId,
        runDir,
        trigger,
        stateDir,
        installDir: hostInfo.hostRoot,
        backupDir,
        oldPid: daemon ? process.pid : null,
        fromVersion: hostInfo.hostVersion,
        targetVersion: null,
        supervisorMode: daemon ? supervisorMode : (options.supervisorMode || 'none'),
        launchCommand: daemon ? launchCommand : (options.launchCommand || null),
        lockPath: getUpdateLockPath(stateDir),
        historyPath: getUpdateHistoryPath(options),
        stateFilePath: getUpdateStatePath(options)
      };
      safeWriteJsonSync(planPath, plan);

      if (!daemon || options.handoffMode === 'inline') {
        const { runUpdaterHelper } = require('./updater-helper');
        const helperRes = await runUpdaterHelper(plan, options.helperDeps || {});
        const nextInfo = detectHostInstallMode({ ...options, stateDir });
        return {
          ok: Boolean(helperRes.ok),
          target: 'host',
          restoredVersion: nextInfo.hostVersion,
          handoff: Boolean(daemon)
        };
      }

      const child = spawnDetachedHelper(helperCopyPath, planPath, stateDir, options);
      if (child?.pid) {
        transferUpdateLock(stateDir, child.pid, runId);
        lockTransferredToHelper = true;
      }
      const exitDelay = Number.isFinite(Number(options.handoffExitDelayMs)) ? Number(options.handoffExitDelayMs) : 120;
      const timer = setTimeout(async () => {
        try { await daemon.stop(); } catch {}
        if (typeof options.onHandoffExit === 'function') {
          options.onHandoffExit(0);
        } else if (!isTestMode()) {
          process.exit(0);
        }
      }, exitDelay);
      if (typeof timer.unref === 'function') timer.unref();

      return { ok: true, target: 'host', handoff: true };
    }

    // Plugin rollback
    const idxBefore = readInstalledIndex(options).plugins?.[target];
    let rb;
    try {
      rb = rollbackPlugin(target, options);
    } catch (err) {
      if (/No rollback snapshot/i.test(err?.message || '')) {
        throw makeUpdateError('NO_ROLLBACK_SNAPSHOT', err.message);
      }
      throw err;
    }
    if (daemon && typeof daemon.reloadPlugin === 'function') {
      await daemon.reloadPlugin(target, { resetCircuit: true });
    }
    appendUpdateHistory({
      runId,
      trigger,
      targetId: target,
      sourceKind: rb?.plugin?.sourceKind || idxBefore?.sourceKind || null,
      fromVersion: idxBefore?.version || null,
      toVersion: rb?.plugin?.version || null,
      phase: 'rollback',
      durationMs: Date.now() - startMs,
      outcome: 'rolled_back'
    }, options);
    return {
      ok: true,
      target,
      restoredVersion: rb?.plugin?.version || null,
      handoff: false,
      plugin: rb.plugin
    };
  } finally {
    if (!lockTransferredToHelper) {
      releaseUpdateLock(stateDir, lock.runId);
    }
  }
}

function setPluginPinned(pluginId, pinned, options = {}) {
  const safeId = assertSafePluginId(pluginId);
  const index = readInstalledIndex(options);
  if (!index.plugins[safeId]) {
    throw makeUpdateError('PLUGIN_NOT_FOUND', `Plugin not installed: ${safeId}`);
  }
  const nextPinned = Boolean(pinned);
  index.plugins[safeId].pinned = nextPinned;
  index.plugins[safeId].updatedAt = new Date().toISOString();
  writeInstalledIndex(index, options);
  return { ok: true, pluginId: safeId, pinned: nextPinned };
}

class UpdateScheduler {
  constructor(options = {}) {
    this.daemon = options.daemon || null;
    this.options = options;
    this.initialTimer = null;
    this.intervalTimer = null;
    this.runningCheck = false;
    this.applyingUpdate = false;
    this.nextCheckAt = null;
    this.enabled = false;
  }

  _getHostSettings() {
    const raw = this.daemon?.getHostSettings?.() || this.options.hostSettings || {};
    return normalizeHostUpdateSettingsView(raw);
  }

  _isAllowedToRunTimers() {
    if (isTestMode() && !this.options.enableSchedulerInTest) return false;
    const hs = this._getHostSettings();
    return hs.autoUpdateMode !== 'manual';
  }

  start() {
    this.stop();
    if (!this._isAllowedToRunTimers()) {
      this.enabled = false;
      this.nextCheckAt = null;
      return { started: false, enabled: false };
    }
    this.enabled = true;
    const hs = this._getHostSettings();
    const intervalMs = CHECK_INTERVAL_MS_MAP[hs.updateCheckInterval] || CHECK_INTERVAL_MS_MAP['6h'];
    const baseInitialMs = Number.isFinite(Number(this.options.initialDelayMs))
      ? Math.max(0, Number(this.options.initialDelayMs))
      : 45000;
    const maxJitterMs = Number.isFinite(Number(this.options.jitterMs))
      ? Math.max(0, Number(this.options.jitterMs))
      : 15000;
    const firstDelay = baseInitialMs + (maxJitterMs > 0 ? Math.floor(Math.random() * maxJitterMs) : 0);

    this.nextCheckAt = new Date(Date.now() + firstDelay).toISOString();
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.runCycle('scheduled').catch(() => {});
    }, firstDelay);
    if (typeof this.initialTimer.unref === 'function') this.initialTimer.unref();

    this.intervalTimer = setInterval(() => {
      this.nextCheckAt = new Date(Date.now() + intervalMs).toISOString();
      void this.runCycle('scheduled').catch(() => {});
    }, intervalMs);
    if (typeof this.intervalTimer.unref === 'function') this.intervalTimer.unref();

    return { started: true, enabled: true, firstDelayMs: firstDelay, intervalMs };
  }

  reschedule() {
    return this.start();
  }

  stop() {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.enabled = false;
    this.nextCheckAt = null;
  }

  getStatus() {
    const stateDir = this.daemon?.stateDir || getStateDir(this.options);
    const cached = readUpdateState({ ...this.options, stateDir });
    return {
      enabled: this.enabled,
      runningCheck: this.runningCheck,
      applyingUpdate: this.applyingUpdate,
      lastCheckedAt: cached.lastCheckedAt || null,
      nextCheckAt: this.nextCheckAt
    };
  }

  async runCycle(trigger = 'scheduled') {
    const hs = this._getHostSettings();
    if (trigger === 'scheduled' && hs.autoUpdateMode === 'manual') {
      return { ok: true, skipped: true, reason: 'MANUAL_MODE' };
    }
    if (this.runningCheck) {
      return { ok: true, skipped: true, reason: 'CHECK_IN_PROGRESS' };
    }
    const stateDir = this.daemon?.stateDir || getStateDir(this.options);
    this.runningCheck = true;
    let checkRes;
    try {
      checkRes = await checkUpdates({
        ...this.options,
        stateDir,
        hostSettings: hs,
        forceRefresh: true,
        ignoreDebounce: true,
        trigger
      });
    } finally {
      this.runningCheck = false;
    }

    this.daemon?.publishUpdatesState?.(checkRes);

    if (hs.autoUpdateMode === 'auto-safe') {
      const safeTargets = Object.values(checkRes.targets || {})
        .filter((t) => t && t.status === 'available' && t.autoSafeEligible === true && t.latestVersion !== t.lastFailedVersion)
        .map((t) => t.targetId);

      // Update registry and safe plugins before host wrapper handoff so host exit does not cut short safe plugin updates
      const orderedSafe = [
        ...safeTargets.filter((id) => id === 'registry'),
        ...safeTargets.filter((id) => id !== 'host' && id !== 'registry'),
        ...safeTargets.filter((id) => id === 'host')
      ];

      if (orderedSafe.length > 0) {
        this.applyingUpdate = true;
        try {
          const nonHost = orderedSafe.filter((id) => id !== 'host');
          let applyRes = null;
          if (nonHost.length > 0) {
            applyRes = await applyUpdates({
              targets: nonHost,
              checkResult: checkRes,
              trigger
            }, {
              ...this.options,
              stateDir,
              hostSettings: hs,
              daemon: this.daemon
            });
          }
          if (orderedSafe.includes('host')) {
            applyRes = await applyUpdates({
              targets: ['host'],
              checkResult: checkRes,
              trigger
            }, {
              ...this.options,
              stateDir,
              hostSettings: hs,
              daemon: this.daemon
            });
          }
          this.daemon?.publishUpdatesState?.();
          return { ok: true, checked: checkRes, applied: applyRes };
        } finally {
          this.applyingUpdate = false;
        }
      }
    }

    return { ok: true, checked: checkRes, applied: null };
  }
}

module.exports = {
  UPDATE_LOCK_FILENAME,
  CHECK_INTERVAL_MS_MAP,
  acquireUpdateLock,
  releaseUpdateLock,
  transferUpdateLock,
  getUpdateHistoryPath,
  sanitizeUpdateLogEntry,
  appendUpdateHistory,
  readUpdateHistory,
  applyUpdates,
  rollbackUpdate,
  setPluginPinned,
  UpdateScheduler
};
