'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { ERROR_CODES, safeErrorPayload } = require('./constants');

const MAX_PATH_LENGTH = 4096;

const SENSITIVE_SYSTEM_PREFIXES = Object.freeze([
  '/System',
  '/etc',
  '/private/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var/root',
  '/private/var/root',
  '/proc',
  '/sys',
  '/dev',
  '/Applications/Antigravity.app',
  'C:/Windows',
  'C:/Program Files',
  'C:/Program Files (x86)'
]);

const SENSITIVE_CREDENTIAL_RE = /(?:^|[\\/])(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.npmrc|\.netrc|\.git[\\/]credentials|1Password)(?:[\\/]|$)/i;

function resolveRealPath(targetPath) {
  if (typeof fs.realpathSync.native === 'function') {
    return fs.realpathSync.native(targetPath);
  }
  return fs.realpathSync(targetPath);
}

function normalizeForCompare(p, platform = process.platform) {
  const resolved = path.resolve(String(p || ''));
  const normalized = platform === 'win32' ? resolved.toLowerCase() : resolved;
  return normalized.length > 1 ? normalized.replace(/[\\/]+$/, '') : normalized;
}

function isInsideRoot(targetPath, rootPath, platform = process.platform) {
  const target = normalizeForCompare(targetPath, platform);
  const root = normalizeForCompare(rootPath, platform);
  if (!target || !root) return false;
  if (target === root) return true;
  if (root === '/' || root === path.sep) {
    return target.startsWith(root);
  }
  return target.startsWith(`${root}${path.sep}`);
}

function isInsideAnyRoot(targetPath, allowedRealRoots, platform = process.platform) {
  if (!Array.isArray(allowedRealRoots) || allowedRealRoots.length === 0) return false;
  for (const root of allowedRealRoots) {
    if (isInsideRoot(targetPath, root, platform)) return true;
  }
  return false;
}

function isSensitiveSystemOrCredentialPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  if (SENSITIVE_CREDENTIAL_RE.test(targetPath)) return true;

  const forward = targetPath.replace(/\\/g, '/');
  const lower = forward.toLowerCase();

  for (const prefix of SENSITIVE_SYSTEM_PREFIXES) {
    const isWinPrefix = /^[A-Za-z]:\//.test(prefix);
    const cmpTarget = isWinPrefix || process.platform === 'win32' ? lower : forward;
    const cmpPrefix = isWinPrefix || process.platform === 'win32' ? prefix.toLowerCase() : prefix;
    if (cmpTarget === cmpPrefix || cmpTarget.startsWith(`${cmpPrefix}/`)) {
      return true;
    }
  }
  return false;
}

function hasUncOrNetworkPrefix(raw) {
  if (!raw || typeof raw !== 'string') return false;
  if (/^\\\\/.test(raw)) return true;
  if (/^\/\/(?!\/)/.test(raw)) return true;
  return false;
}

function safeDecodeUriComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function preSyscallLexicalGate(rawPath) {
  if (typeof rawPath !== 'string') {
    return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.INVALID_PATH) };
  }
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > MAX_PATH_LENGTH) {
    return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.INVALID_PATH) };
  }
  if (trimmed.includes('\0') || /%00/i.test(trimmed)) {
    return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.INVALID_PATH) };
  }

  const decoded = safeDecodeUriComponent(trimmed);
  if (decoded.includes('\0')) {
    return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.INVALID_PATH) };
  }

  if (hasUncOrNetworkPrefix(trimmed) || hasUncOrNetworkPrefix(decoded)) {
    return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.UNC_PATH_BLOCKED) };
  }

  if (/^file:/i.test(trimmed)) {
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.INVALID_PATH) };
    }
    const host = String(parsed.hostname || '').toLowerCase();
    if (host !== '' && host !== 'localhost') {
      return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.UNC_PATH_BLOCKED) };
    }
  }

  return { ok: true, trimmed };
}

function decodeAndResolveCandidate(trimmed, options = {}) {
  let localInput = trimmed;
  if (/^file:/i.test(trimmed)) {
    try {
      localInput = fileURLToPath(trimmed);
    } catch {
      return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.INVALID_PATH) };
    }
    if (hasUncOrNetworkPrefix(localInput)) {
      return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.UNC_PATH_BLOCKED) };
    }
  } else if (localInput === '~' || localInput.startsWith('~/') || localInput.startsWith('~\\')) {
    const home = options.homeDir || os.homedir();
    localInput = localInput === '~' ? home : path.join(home, localInput.slice(2));
  }

  if (!path.isAbsolute(localInput)) {
    if (typeof options.baseRoot === 'string' && options.baseRoot.trim()) {
      localInput = path.resolve(options.baseRoot.trim(), localInput);
    } else {
      return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.INVALID_PATH) };
    }
  }

  return { ok: true, candidatePath: path.resolve(localInput) };
}

function findDeepestExistingAncestor(targetPath) {
  let current = path.resolve(targetPath);
  const trailingParts = [];
  while (true) {
    try {
      const lstat = fs.lstatSync(current);
      return { ancestor: current, lstat, relativeTail: trailingParts.reverse() };
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        return { error: err };
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return { ancestor: null, relativeTail: [] };
      }
      trailingParts.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Validates and resolves a directory path (for allowed workspace roots).
 * Runs Steps 1-3 + realpath + directory check without checking containment against itself.
 */
function validateDirectoryRoot(rawPath, options = {}) {
  const step1 = preSyscallLexicalGate(rawPath);
  if (!step1.ok) return step1;

  const step2 = decodeAndResolveCandidate(step1.trimmed, options);
  if (!step2.ok) return step2;

  if (isSensitiveSystemOrCredentialPath(step2.candidatePath)) {
    return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.SENSITIVE_PATH_BLOCKED) };
  }

  let lstat;
  try {
    lstat = fs.lstatSync(step2.candidatePath);
  } catch {
    return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
  }

  let realPath;
  try {
    realPath = resolveRealPath(step2.candidatePath);
  } catch {
    return {
      ok: false,
      statusCode: 403,
      ...safeErrorPayload(lstat.isSymbolicLink() ? ERROR_CODES.SYMLINK_ESCAPE : ERROR_CODES.PATH_OUT_OF_BOUNDS)
    };
  }

  if (isSensitiveSystemOrCredentialPath(realPath)) {
    return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.SENSITIVE_PATH_BLOCKED) };
  }

  let stat;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
  }
  if (!stat.isDirectory()) {
    return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
  }

  return { ok: true, realPath, candidatePath: step2.candidatePath, stat };
}

/**
 * 4-step PathGuard pipeline:
 * 1. Pre-syscall lexical gate (null bytes, UNC, remote file:// hosts)
 * 2. Protocol decode & path.resolve
 * 3. System & credential sensitive path blacklist
 * 4. Allowed roots containment + realpathSync.native symlink escape guard
 */
function validatePathAccess(rawPath, options = {}) {
  const allowedRealRoots = Array.isArray(options.allowedRealRoots) ? options.allowedRealRoots : [];
  const mustExist = options.mustExist !== false;
  const requireRegularFile = options.requireRegularFile !== false;

  const step1 = preSyscallLexicalGate(rawPath);
  if (!step1.ok) return step1;

  const step2 = decodeAndResolveCandidate(step1.trimmed, options);
  if (!step2.ok) return step2;

  const candidatePath = step2.candidatePath;
  if (isSensitiveSystemOrCredentialPath(candidatePath)) {
    return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.SENSITIVE_PATH_BLOCKED) };
  }

  if (allowedRealRoots.length === 0) {
    return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
  }

  let lstat;
  try {
    lstat = fs.lstatSync(candidatePath);
  } catch (err) {
    if (!err || err.code !== 'ENOENT' || mustExist) {
      return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
    }
    const ancestorInfo = findDeepestExistingAncestor(candidatePath);
    if (!ancestorInfo || ancestorInfo.error || !ancestorInfo.ancestor) {
      return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
    }
    let realAncestor;
    try {
      realAncestor = resolveRealPath(ancestorInfo.ancestor);
    } catch {
      return {
        ok: false,
        statusCode: 403,
        ...safeErrorPayload(
          ancestorInfo.lstat?.isSymbolicLink?.() ? ERROR_CODES.SYMLINK_ESCAPE : ERROR_CODES.PATH_OUT_OF_BOUNDS
        )
      };
    }
    if (!isInsideAnyRoot(realAncestor, allowedRealRoots)) {
      return {
        ok: false,
        statusCode: 403,
        ...safeErrorPayload(
          ancestorInfo.lstat?.isSymbolicLink?.() ? ERROR_CODES.SYMLINK_ESCAPE : ERROR_CODES.PATH_OUT_OF_BOUNDS
        )
      };
    }
    const reconstructed = path.resolve(realAncestor, ...ancestorInfo.relativeTail);
    if (isSensitiveSystemOrCredentialPath(reconstructed) || !isInsideAnyRoot(reconstructed, allowedRealRoots)) {
      return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
    }
    return {
      ok: true,
      exists: false,
      realPath: reconstructed,
      candidatePath,
      stat: null,
      isSymlink: false
    };
  }

  const isSymlink = lstat.isSymbolicLink();
  let realTarget;
  try {
    realTarget = resolveRealPath(candidatePath);
  } catch {
    return {
      ok: false,
      statusCode: 403,
      ...safeErrorPayload(isSymlink ? ERROR_CODES.SYMLINK_ESCAPE : ERROR_CODES.PATH_OUT_OF_BOUNDS)
    };
  }

  if (!isInsideAnyRoot(realTarget, allowedRealRoots)) {
    return {
      ok: false,
      statusCode: 403,
      ...safeErrorPayload(isSymlink ? ERROR_CODES.SYMLINK_ESCAPE : ERROR_CODES.PATH_OUT_OF_BOUNDS)
    };
  }

  if (isSensitiveSystemOrCredentialPath(realTarget)) {
    return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.SENSITIVE_PATH_BLOCKED) };
  }

  let stat;
  try {
    stat = fs.statSync(realTarget);
  } catch {
    return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.PATH_OUT_OF_BOUNDS) };
  }

  if (requireRegularFile && !stat.isFile()) {
    return { ok: false, statusCode: 403, ...safeErrorPayload(ERROR_CODES.NOT_A_REGULAR_FILE) };
  }

  return {
    ok: true,
    exists: true,
    realPath: realTarget,
    candidatePath,
    stat,
    isSymlink
  };
}

module.exports = {
  MAX_PATH_LENGTH,
  SENSITIVE_SYSTEM_PREFIXES,
  SENSITIVE_CREDENTIAL_RE,
  resolveRealPath,
  isInsideRoot,
  isInsideAnyRoot,
  isSensitiveSystemOrCredentialPath,
  preSyscallLexicalGate,
  validateDirectoryRoot,
  validatePathAccess
};
