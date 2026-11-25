'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getPluginDataDir } = require('./paths');

function safeWriteJsonSync(targetPath, data, options = {}) {
  const fsImpl = options.fs || fs;
  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, phase: 'argument', error: '目标文件路径无效', path: targetPath };
  }

  const resolved = path.resolve(targetPath);
  const dir = path.dirname(resolved);

  try {
    fsImpl.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return { ok: false, phase: 'mkdir', ...(err?.code ? { code: err.code } : {}), error: err?.message || '创建父目录失败', path: resolved };
  }

  try {
    if (fsImpl.existsSync(resolved) && fsImpl.statSync(resolved).isDirectory()) {
      return { ok: false, phase: 'validate_target', code: 'EISDIR', error: '目标路径是一个目录', path: resolved };
    }
  } catch (err) {
    return { ok: false, phase: 'stat', ...(err?.code ? { code: err.code } : {}), error: err?.message || '检查目标路径失败', path: resolved };
  }

  let serialized;
  try {
    const indent = options.indent !== undefined ? options.indent : 2;
    serialized = JSON.stringify(data, null, indent) + '\n';
  } catch (err) {
    return { ok: false, phase: 'serialize', error: err?.message || 'JSON 序列化失败', path: resolved };
  }

  const baseName = path.basename(resolved);
  const rand = crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(dir, `.${baseName}.${process.pid}.${Date.now()}.${rand}.tmp`);

  try {
    fsImpl.writeFileSync(tmpPath, serialized, 'utf8');
  } catch (err) {
    try { if (fsImpl.existsSync(tmpPath)) fsImpl.unlinkSync(tmpPath); } catch {}
    return { ok: false, phase: 'write_temp', ...(err?.code ? { code: err.code } : {}), error: err?.message || '写入临时文件失败', path: resolved };
  }

  try {
    const parsed = JSON.parse(fsImpl.readFileSync(tmpPath, 'utf8'));
    if (typeof options.validate === 'function' && !options.validate(parsed)) {
      throw new Error('临时文件内容未通过业务校验规则');
    }
  } catch (err) {
    try { if (fsImpl.existsSync(tmpPath)) fsImpl.unlinkSync(tmpPath); } catch {}
    return { ok: false, phase: 'pre_verify', ...(err?.code ? { code: err.code } : {}), error: err?.message || '临时文件校验失败', path: resolved };
  }

  try {
    fsImpl.renameSync(tmpPath, resolved);
  } catch (renameErr) {
    try { if (fsImpl.existsSync(tmpPath)) fsImpl.unlinkSync(tmpPath); } catch {}
    return { ok: false, phase: 'rename', ...(renameErr?.code ? { code: renameErr.code } : {}), error: renameErr?.message || '重命名替换目标文件失败', path: resolved };
  }

  try {
    const finalParsed = JSON.parse(fsImpl.readFileSync(resolved, 'utf8'));
    if (typeof options.validate === 'function' && !options.validate(finalParsed)) {
      throw new Error('目标文件写后校验未通过业务规则');
    }
  } catch (postErr) {
    return { ok: false, phase: 'post_verify', ...(postErr?.code ? { code: postErr.code } : {}), error: postErr?.message || '替换后读回校验失败', path: resolved };
  }

  return { ok: true, path: resolved, bytesWritten: Buffer.byteLength(serialized, 'utf8') };
}

function safeReadJsonSync(targetPath, fallbackValue = null, options = {}) {
  const fsImpl = options.fs || fs;
  if (!targetPath) {
    return { ok: false, data: fallbackValue, exists: false, corrupted: false, error: '未指定目标路径' };
  }

  const resolved = path.resolve(targetPath);
  try {
    const st = fsImpl.statSync(resolved);
    if (st.isDirectory()) {
      return { ok: false, data: fallbackValue, exists: true, corrupted: false, code: 'EISDIR', error: '目标路径是一个目录' };
    }
  } catch (statErr) {
    if (statErr && statErr.code === 'ENOENT') {
      return { ok: true, data: fallbackValue, exists: false, corrupted: false };
    }
    return { ok: false, data: fallbackValue, exists: true, corrupted: false, code: statErr?.code, error: statErr?.message || '检查目标文件状态失败' };
  }

  let content = '';
  try {
    content = fsImpl.readFileSync(resolved, 'utf8');
  } catch (err) {
    return { ok: false, data: fallbackValue, exists: true, corrupted: false, code: err?.code, error: err?.message || '读取文件失败' };
  }

  if (!content.trim()) {
    return { ok: false, data: fallbackValue, exists: true, corrupted: true, error: '文件内容为空' };
  }

  try {
    const parsed = JSON.parse(content);
    if (typeof options.validate === 'function' && !options.validate(parsed)) {
      throw new Error('数据结构未通过业务校验');
    }
    return { ok: true, data: parsed, exists: true, corrupted: false };
  } catch (parseErr) {
    let quarantinePath = null;
    if (options.quarantineCorrupt !== false) {
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        quarantinePath = resolved.replace(/\.json$/i, '') + `.corrupt.${stamp}.json`;
        fsImpl.copyFileSync(resolved, quarantinePath);
      } catch {}
    }
    if (options.backupPath && fsImpl.existsSync(options.backupPath)) {
      try {
        const bakParsed = JSON.parse(fsImpl.readFileSync(options.backupPath, 'utf8'));
        if (!options.validate || options.validate(bakParsed)) {
          return {
            ok: true,
            data: bakParsed,
            exists: true,
            corrupted: true,
            recoveredFromBackup: true,
            backupPath: options.backupPath,
            quarantinePath,
            error: parseErr?.message || '原始文件损坏，已从备份恢复'
          };
        }
      } catch {}
    }
    return {
      ok: false,
      data: fallbackValue,
      exists: true,
      corrupted: true,
      quarantinePath,
      error: parseErr?.message || 'JSON 解析失败'
    };
  }
}

const LOCK_SLEEP_BUF = typeof SharedArrayBuffer === 'function'
  ? new Int32Array(new SharedArrayBuffer(4))
  : null;

function sleepSyncMs(ms) {
  if (LOCK_SLEEP_BUF) {
    try {
      Atomics.wait(LOCK_SLEEP_BUF, 0, 0, ms);
      return;
    } catch {}
  }
  const until = Date.now() + ms;
  while (Date.now() < until) {}
}

function acquireSyncFileLock(targetPath, timeoutMs = 15000) {
  const resolved = path.resolve(targetPath);
  const lockFile = `${resolved}.lock`;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, `${process.pid}:${Date.now()}`, 'utf8');
      fs.closeSync(fd);
      return {
        lockFile,
        release: () => {
          try { fs.unlinkSync(lockFile); } catch {}
        }
      };
    } catch {
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`获取文件写锁超时 (${lockFile})`);
      }
      try {
        const content = fs.readFileSync(lockFile, 'utf8');
        const pid = parseInt(String(content).split(':')[0], 10);
        if (pid && !Number.isNaN(pid)) {
          let running = true;
          try { process.kill(pid, 0); } catch { running = false; }
          if (!running) {
            try { fs.unlinkSync(lockFile); } catch {}
            continue;
          }
        }
      } catch {}
      sleepSyncMs(12);
    }
  }
}

function withFileLockSync(targetPath, fn, timeoutMs = 15000) {
  const lock = acquireSyncFileLock(targetPath, timeoutMs);
  try {
    return fn();
  } finally {
    lock.release();
  }
}

function readHostHealthState(stateDir) {
  const { data } = safeReadJsonSync(path.join(stateDir, 'host-health.json'), null, { quarantineCorrupt: false });
  return {
    lastInjectedVersion: typeof data?.lastInjectedVersion === 'string' ? data.lastInjectedVersion : null,
    upgradeEvents: Array.isArray(data?.upgradeEvents)
      ? data.upgradeEvents.filter((event) => typeof event?.fromVersion === 'string' &&
        typeof event.toVersion === 'string' && typeof event.outcome === 'string').slice(-20)
      : []
  };
}

function makeHostRelaunchRecord(result, timestamp = Date.now()) {
  const blockedBy = result.blocked || result.reason === 'INSIDE_ANTIGRAVITY_SESSION' ? result.reason : null;
  return {
    at: new Date(timestamp).toISOString(),
    status: result.ok ? 'succeeded' : (result.skipped ? 'deferred' : (blockedBy ? 'blocked' : 'failed')),
    reason: result.reason || result.error || null,
    blockedBy: blockedBy || null
  };
}

function readHostRelaunch(stateDir) {
  const { data } = safeReadJsonSync(path.join(stateDir, 'last-host-relaunch.json'), null, { quarantineCorrupt: false });
  return typeof data?.at === 'string' ? data : null;
}

function writeHostRelaunch(stateDir, result) {
  return safeWriteJsonSync(path.join(stateDir, 'last-host-relaunch.json'), result);
}

function writeHostHealthState(stateDir, data) {
  return safeWriteJsonSync(path.join(stateDir, 'host-health.json'), {
    lastInjectedVersion: data.lastInjectedVersion,
    upgradeEvents: data.upgradeEvents.slice(-20)
  });
}

function copyDirRecursiveSync(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  if (!fs.existsSync(srcDir)) return;
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, ent.name);
    const dst = path.join(dstDir, ent.name);
    if (ent.isDirectory()) {
      copyDirRecursiveSync(src, dst);
    } else if (ent.isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
}

function clearDirEntriesSync(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
    fs.rmSync(path.join(dirPath, ent.name), { recursive: true, force: true });
  }
}

class PluginDataStore {
  constructor(pluginId, options = {}) {
    this.pluginId = pluginId;
    this.dir = options.dir ? path.resolve(options.dir) : getPluginDataDir(pluginId, options);
    this.metaPath = path.join(this.dir, '.meta.json');
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  resolveFile(relName) {
    const clean = String(relName || '').trim();
    if (!clean || path.isAbsolute(clean) || clean.includes('..')) {
      throw new Error(`Unsafe plugin data file path: ${String(relName)}`);
    }
    const resolved = path.resolve(this.dir, clean);
    if (!resolved.startsWith(this.dir + path.sep) && resolved !== this.dir) {
      throw new Error(`Plugin data path escaped sandbox: ${clean}`);
    }
    return resolved;
  }

  readJson(relName, fallbackValue = null, options = {}) {
    return safeReadJsonSync(this.resolveFile(relName), fallbackValue, options);
  }

  writeJson(relName, data, options = {}) {
    this.ensureDir();
    const target = this.resolveFile(relName);
    return withFileLockSync(target, () => safeWriteJsonSync(target, data, options));
  }

  getDataVersion() {
    const res = safeReadJsonSync(this.metaPath, null, { quarantineCorrupt: false });
    if (res.ok && res.exists && Number.isInteger(res.data?.dataVersion)) {
      return res.data.dataVersion;
    }
    return 1;
  }

  setDataVersion(version) {
    this.ensureDir();
    return safeWriteJsonSync(this.metaPath, {
      pluginId: this.pluginId,
      dataVersion: version,
      updatedAt: new Date().toISOString()
    });
  }

  async upgradeDataVersion(targetVersion, migrateFn) {
    if (!Number.isInteger(targetVersion) || targetVersion < 1) {
      throw new Error(`Invalid target dataVersion: ${String(targetVersion)}`);
    }
    this.ensureDir();
    const fromVersion = this.getDataVersion();
    if (fromVersion >= targetVersion) {
      return { ok: true, migrated: false, fromVersion, toVersion: fromVersion };
    }
    const snapshotDir = path.join(
      path.dirname(this.dir),
      `.snapshot.${path.basename(this.dir)}.${process.pid}.${Date.now()}`
    );
    copyDirRecursiveSync(this.dir, snapshotDir);
    try {
      if (typeof migrateFn === 'function') {
        await migrateFn(fromVersion, targetVersion, this);
      }
      const metaRes = this.setDataVersion(targetVersion);
      if (!metaRes.ok) {
        throw new Error(metaRes.error || '写入数据版本元信息失败');
      }
      fs.rmSync(snapshotDir, { recursive: true, force: true });
      return { ok: true, migrated: true, fromVersion, toVersion: targetVersion };
    } catch (err) {
      try {
        clearDirEntriesSync(this.dir);
        copyDirRecursiveSync(snapshotDir, this.dir);
      } finally {
        try { fs.rmSync(snapshotDir, { recursive: true, force: true }); } catch {}
      }
      return {
        ok: false,
        rolledBack: true,
        fromVersion,
        toVersion: targetVersion,
        error: err?.message || String(err)
      };
    }
  }
}

module.exports = {
  readHostHealthState,
  writeHostHealthState,
  makeHostRelaunchRecord,
  readHostRelaunch,
  writeHostRelaunch,
  safeWriteJsonSync,
  safeReadJsonSync,
  withFileLockSync,
  PluginDataStore
};
