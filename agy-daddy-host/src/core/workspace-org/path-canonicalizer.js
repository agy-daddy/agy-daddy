'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');

const IS_CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const PERCENT_ENCODED_RE = /%[0-9A-Fa-f]{2}/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const TEMP_BRIDGE_RE = /(?:^|\/)(?:private\/)?tmp\/magpie-agy-bridge-/i;
const MAC_VAR_FOLDERS_TMP_RE = /(?:^|\/)(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/i;

function isTestMode() {
  return (
    process.env.AGY_DADDY_TEST_MODE === '1'
    || process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function expandTilde(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * Resolves an existing path on disk, preferring `fs.realpathSync.native` so
 * Windows 8.3 short paths and macOS `/var` -> `/private/var` symlinks match `git`.
 */
function resolveRealPath(targetPath) {
  if (typeof fs.realpathSync.native === 'function') {
    try {
      return fs.realpathSync.native(targetPath);
    } catch {
      return fs.realpathSync(targetPath);
    }
  }
  return fs.realpathSync(targetPath);
}

function safeRealpath(targetPath) {
  try {
    return resolveRealPath(targetPath);
  } catch {
    return null;
  }
}

function findDeepestExistingAncestor(targetPath) {
  let current = targetPath;
  while (true) {
    try {
      fs.lstatSync(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/**
 * Normalizes a local filesystem path or `file://` URI (handling UTF-8 percent-encoding,
 * `~/` expansion, trailing slashes, and `\0` rejection).
 */
function normalizeLocalPath(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s || s.includes('\0')) return '';

  let fromFileUrl = false;
  if (/^file:\/\//i.test(s)) {
    fromFileUrl = true;
    try {
      s = url.fileURLToPath(s);
    } catch {
      s = s.replace(/^file:\/\//i, '');
      if (/^localhost\//i.test(s)) {
        s = s.slice('localhost'.length);
      }
      if (PERCENT_ENCODED_RE.test(s)) {
        try {
          s = decodeURIComponent(s);
        } catch {
          // Keep raw if malformed percent-encoding
        }
      }
    }
  }

  if (!fromFileUrl && PERCENT_ENCODED_RE.test(s)) {
    const expandedRaw = expandTilde(s);
    if (!fs.existsSync(expandedRaw)) {
      try {
        s = decodeURIComponent(s);
      } catch {
        // Keep raw if malformed percent-encoding
      }
    }
  }

  s = expandTilde(s);
  if (!s || s.includes('\0')) return '';

  if (WINDOWS_DRIVE_RE.test(s) && process.platform !== 'win32') {
    const slashed = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    return slashed.length > 3 ? slashed.replace(/\/+$/, '') : slashed;
  }

  return path.resolve(s);
}

function normalizeUriToPath(uriOrPath) {
  return normalizeLocalPath(uriOrPath);
}

function pathToFileUri(fsPath) {
  const clean = normalizeLocalPath(fsPath);
  if (!clean) return null;
  try {
    return url.pathToFileURL(clean).href;
  } catch {
    return `file://${encodeURI(clean).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
  }
}

/**
 * Canonicalizes a path or `file://` URI, resolving symlinks on the target or on its
 * deepest existing ancestor (so deleted paths like `/tmp/wt-deleted` still resolve
 * `/tmp` -> `/private/tmp` on macOS).
 */
function canonicalizePath(rawUriOrPath) {
  const norm = normalizeLocalPath(rawUriOrPath);
  if (!norm) return '';
  if (WINDOWS_DRIVE_RE.test(norm) && process.platform !== 'win32') {
    return norm;
  }
  const direct = safeRealpath(norm);
  if (direct) return direct;
  const ancestor = findDeepestExistingAncestor(norm);
  const realAncestor = safeRealpath(ancestor);
  if (!realAncestor) return norm;
  const rel = path.relative(ancestor, norm);
  return rel ? path.join(realAncestor, rel) : realAncestor;
}

function canonicalKey(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const trimmed = s.length > 1 && !/^[A-Za-z]:\/$/.test(s) ? s.replace(/\/+$/, '') : s;
  return IS_CASE_INSENSITIVE_FS ? trimmed.toLowerCase() : trimmed;
}

function getPathLookupKeys(normalizedPath) {
  if (!normalizedPath) return [];
  const keys = [canonicalKey(normalizedPath)];
  const canon = canonicalizePath(normalizedPath);
  if (canon) {
    const canonKey = canonicalKey(canon);
    if (!keys.includes(canonKey)) keys.push(canonKey);
  }
  return keys;
}

function isSameOrInside(targetPath, baseDir, caseInsensitive = IS_CASE_INSENSITIVE_FS) {
  const norm = (val) => {
    let s = String(val || '').replace(/\\/g, '/');
    if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) {
      s = s.replace(/\/+$/, '');
    }
    return caseInsensitive ? s.toLowerCase() : s;
  };
  const t = norm(targetPath);
  const b = norm(baseDir);
  if (!t || !b) return false;
  if (b === '/') return t.startsWith('/');
  return t === b || t.startsWith(`${b}/`);
}

function getForbiddenPrefixes() {
  const home = os.homedir();
  const candidates = [
    '/System',
    '/etc',
    '/private/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/var/root',
    '/private/var/root',
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg')
  ];
  const out = [];
  const seen = new Set();
  for (const p of candidates) {
    const norm = path.resolve(p);
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
    const real = safeRealpath(norm);
    if (real && !seen.has(real)) {
      seen.add(real);
      out.push(real);
    }
  }
  return out;
}

/**
 * Rejects root directories, OS directories, and sensitive credential directories.
 */
function isForbiddenSystemRoot(realPath) {
  if (typeof realPath !== 'string' || !realPath.trim() || realPath.includes('\0')) {
    return true;
  }

  const trimmed = realPath.trim();
  if (trimmed === '/' || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return true;
  }
  const winSlashed = trimmed.replace(/\\/g, '/');
  if (/^c:\/windows(?:\/|$)/i.test(winSlashed) || /^file:\/\/\/?c:\/windows(?:\/|$)/i.test(winSlashed)) {
    return true;
  }

  const normalized = normalizeLocalPath(trimmed);
  if (!normalized) return true;
  if (/^c:\/windows(?:\/|$)/i.test(normalized.replace(/\\/g, '/'))) {
    return true;
  }

  const canon = canonicalizePath(normalized);
  const candidates = canon && canon !== normalized ? [normalized, canon] : [normalized];
  const prefixes = getForbiddenPrefixes();
  for (const candidate of candidates) {
    const slashed = candidate.replace(/\\/g, '/');
    if (slashed === '/' || /^[A-Za-z]:\/?$/.test(slashed)) return true;
    for (const prefix of prefixes) {
      if (isSameOrInside(candidate, prefix, IS_CASE_INSENSITIVE_FS)) {
        return true;
      }
    }
  }

  return false;
}

function isTempBridgeWorkspace(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return true;
  const slashed = rawPath.replace(/\\/g, '/');
  return TEMP_BRIDGE_RE.test(slashed) || MAC_VAR_FOLDERS_TMP_RE.test(slashed);
}

function makeWorktreeId(worktreeRawPath) {
  const canon = canonicalizePath(worktreeRawPath) || normalizeLocalPath(worktreeRawPath);
  if (!canon) return '';
  const digest = crypto.createHash('sha1').update(canonicalKey(canon)).digest('hex').slice(0, 12);
  return `wt_${digest}`;
}

function deriveWorkspaceProjectId(normPath) {
  if (!normPath) return null;
  const hash = crypto.createHash('sha1').update(normPath).digest('hex').slice(0, 12);
  const parts = normPath.split(/[\\/]/).filter(Boolean);
  const baseName = parts.length > 0 ? parts[parts.length - 1] : 'workspace';
  const base = baseName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 32) || 'workspace';
  return `ws:${base}:${hash}`;
}

function makeAppSyncedProjectId(normPath) {
  const digest = crypto.createHash('sha1').update(canonicalKey(normPath)).digest('hex').slice(0, 12);
  return `app:${digest}`;
}

function makeImplicitProjectId(normPath) {
  const digest = crypto.createHash('sha1').update(canonicalKey(normPath)).digest('hex').slice(0, 12);
  return `implicit:${digest}`;
}

function makeStableProjectId(normPath) {
  const digest = crypto.createHash('sha1').update(canonicalKey(normPath)).digest('hex').slice(0, 12);
  return `proj_${digest}`;
}

/**
 * Matches a session/task workspace path to the deepest containing worktree using
 * canonicalized longest-prefix matching (e.g., `<repo>/.worktrees/wt-inner` beats `<repo>`).
 */
function matchWorktreeByLongestPrefix(rawPath, knownWorktrees = []) {
  const sPath = canonicalizePath(rawPath) || normalizeLocalPath(rawPath);
  const sKey = canonicalKey(sPath);
  if (!sKey || !Array.isArray(knownWorktrees) || knownWorktrees.length === 0) {
    return null;
  }

  const candidates = [];
  for (const wt of knownWorktrees) {
    if (!wt) continue;
    const rawWtPath = typeof wt === 'string' ? wt : (wt.path || wt.rootPath || wt.uri || '');
    const wtCanon = wt.canonicalPath || canonicalizePath(rawWtPath) || normalizeLocalPath(rawWtPath);
    const wtKey = wt.canonicalKey || canonicalKey(wtCanon);
    if (!wtKey) continue;
    candidates.push({ wt, wtKey });
  }

  candidates.sort((a, b) => {
    if (b.wtKey.length !== a.wtKey.length) {
      return b.wtKey.length - a.wtKey.length;
    }
    return a.wtKey.localeCompare(b.wtKey);
  });

  for (const { wt, wtKey } of candidates) {
    if (sKey === wtKey) return wt;
    const prefix = wtKey.endsWith('/') ? wtKey : `${wtKey}/`;
    if (sKey.startsWith(prefix)) return wt;
  }
  return null;
}

module.exports = {
  IS_CASE_INSENSITIVE_FS,
  isTestMode,
  isPlainObject,
  expandTilde,
  resolveRealPath,
  safeRealpath,
  findDeepestExistingAncestor,
  normalizeLocalPath,
  normalizeUriToPath,
  pathToFileUri,
  canonicalizePath,
  canonicalKey,
  getPathLookupKeys,
  isSameOrInside,
  isForbiddenSystemRoot,
  isTempBridgeWorkspace,
  makeWorktreeId,
  deriveWorkspaceProjectId,
  makeAppSyncedProjectId,
  makeImplicitProjectId,
  makeStableProjectId,
  matchWorktreeByLongestPrefix
};
