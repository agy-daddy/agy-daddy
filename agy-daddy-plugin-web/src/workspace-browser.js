'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');

const IS_CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const PERCENT_ENCODED_RE = /%[0-9A-Fa-f]{2}/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const DEFAULT_FS_TIMEOUT_MS = 2500;
const MOUNT_PROBE_TIMEOUT_MS = 1500;
const MAX_ENTRIES = 500;

function expandTilde(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function safeRealpathSync(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

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
      if (/^localhost\//i.test(s)) s = s.slice('localhost'.length);
      if (PERCENT_ENCODED_RE.test(s)) {
        try { s = decodeURIComponent(s); } catch {}
      }
    }
  }

  if (!fromFileUrl && PERCENT_ENCODED_RE.test(s)) {
    const expandedRaw = expandTilde(s);
    if (!fs.existsSync(expandedRaw)) {
      try { s = decodeURIComponent(s); } catch {}
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
  return t === b || t.startsWith(b.endsWith('/') ? b : `${b}/`);
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
    const real = safeRealpathSync(norm);
    if (real && !seen.has(real)) {
      seen.add(real);
      out.push(real);
    }
  }
  return out;
}

function isForbiddenSystemRoot(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.includes('\0')) {
    return true;
  }
  const trimmed = rawPath.trim();
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

  const resolvedReal = safeRealpathSync(normalized);
  const candidates = resolvedReal && resolvedReal !== normalized ? [normalized, resolvedReal] : [normalized];
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

function withTimeout(promise, ms, code = 'FS_TIMEOUT') {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(code), { code, statusCode: 504 }));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildBreadcrumbs(dirPath) {
  if (!dirPath) return [];
  const parsed = path.parse(dirPath);
  const root = parsed.root || '/';
  const rel = path.relative(root, dirPath);
  const segments = rel ? rel.split(path.sep).filter(Boolean) : [];
  const crumbs = [];
  let acc = root;
  for (const seg of segments) {
    acc = path.join(acc, seg);
    crumbs.push({ name: seg, path: acc });
  }
  return crumbs;
}

function computeCommonParent(pathsList) {
  const valid = (Array.isArray(pathsList) ? pathsList : [])
    .map((p) => normalizeLocalPath(p))
    .filter((p) => p && !isForbiddenSystemRoot(p));
  if (valid.length === 0) return null;
  const parents = valid.map((p) => path.dirname(p));
  const counts = new Map();
  for (const par of parents) {
    if (!isForbiddenSystemRoot(par)) {
      counts.set(par, (counts.get(par) || 0) + 1);
    }
  }
  let best = null;
  let bestCount = 0;
  for (const [par, cnt] of counts.entries()) {
    if (cnt > bestCount) {
      best = par;
      bestCount = cnt;
    }
  }
  return best;
}

async function detectShortcuts({ getDefaultSessionPath, getProjectRootPaths, gdriveScanRoots, timeoutMs = MOUNT_PROBE_TIMEOUT_MS } = {}) {
  const shortcuts = [];
  const seen = new Set();
  const addShortcut = (kind, label, p) => {
    const norm = normalizeLocalPath(p);
    if (!norm || isForbiddenSystemRoot(norm)) return;
    const key = IS_CASE_INSENSITIVE_FS ? norm.toLowerCase() : norm;
    if (seen.has(key)) return;
    try {
      if (!fs.existsSync(norm) || !fs.statSync(norm).isDirectory()) return;
    } catch {
      return;
    }
    seen.add(key);
    shortcuts.push({ kind, label, path: norm });
  };

  const home = os.homedir();
  addShortcut('home', 'Home (~)', home);

  if (typeof getDefaultSessionPath === 'function') {
    const defPath = getDefaultSessionPath();
    if (defPath) addShortcut('default', 'Default Workspace', defPath);
  }

  if (typeof getProjectRootPaths === 'function') {
    const common = computeCommonParent(getProjectRootPaths());
    if (common) addShortcut('projects_parent', path.basename(common) || 'Projects', common);
  }

  addShortcut('desktop', 'Desktop', path.join(home, 'Desktop'));
  addShortcut('documents', 'Documents', path.join(home, 'Documents'));

  const scanRoots = Array.isArray(gdriveScanRoots)
    ? gdriveScanRoots
    : [path.join(home, 'Library', 'CloudStorage'), '/Volumes', path.join(home, 'Google Drive')];

  for (const scanRoot of scanRoots) {
    try {
      if (!fs.existsSync(scanRoot)) continue;
      if (path.basename(scanRoot) === 'Google Drive') {
        addShortcut('gdrive', 'Google Drive', scanRoot);
        continue;
      }
      const ents = await withTimeout(fs.promises.readdir(scanRoot, { withFileTypes: true }), timeoutMs, 'GDRIVE_PROBE_TIMEOUT');
      for (const ent of ents) {
        if (ent.name.startsWith('GoogleDrive-') || /^GoogleDrive/i.test(ent.name)) {
          addShortcut('gdrive', ent.name, path.join(scanRoot, ent.name));
        }
      }
    } catch {
      // Ignore slow/unavailable mount
    }
  }

  return shortcuts;
}

/**
 * Safe single-level host directory browser for L2/loopback project creation.
 */
function createWorkspaceBrowser(options = {}) {
  const fsTimeoutMs = Number.isFinite(Number(options.fsTimeoutMs)) && Number(options.fsTimeoutMs) > 0
    ? Number(options.fsTimeoutMs)
    : DEFAULT_FS_TIMEOUT_MS;
  const getDefaultSessionPath = typeof options.getDefaultSessionPath === 'function'
    ? options.getDefaultSessionPath
    : () => '';
  const getProjectRootPaths = typeof options.getProjectRootPaths === 'function'
    ? options.getProjectRootPaths
    : () => [];
  const gdriveScanRoots = options.gdriveScanRoots;

  async function browse({ path: rawPath, showHidden = false } = {}) {
    const requestedRaw = typeof rawPath === 'string' && rawPath.trim()
      ? rawPath.trim()
      : (getDefaultSessionPath() || os.homedir());

    if (requestedRaw.includes('\0')) {
      return { ok: false, statusCode: 400, error: 'INVALID_PATH' };
    }

    const normalized = normalizeLocalPath(requestedRaw);
    if (!normalized) {
      return { ok: false, statusCode: 400, error: 'INVALID_PATH' };
    }
    if (isForbiddenSystemRoot(normalized)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }

    const exists = fs.existsSync(normalized);
    let targetToBrowse = normalized;
    let willCreateRelative = '';

    if (!exists) {
      const ancestor = findDeepestExistingAncestor(normalized);
      if (isForbiddenSystemRoot(ancestor)) {
        return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
      }
      targetToBrowse = ancestor;
      willCreateRelative = path.relative(ancestor, normalized);
    }

    let resolvedReal;
    try {
      resolvedReal = await withTimeout(fs.promises.realpath(targetToBrowse), fsTimeoutMs, 'REALPATH_TIMEOUT');
    } catch (err) {
      if (err?.code === 'REALPATH_TIMEOUT') {
        return { ok: false, statusCode: 504, error: 'BROWSE_TIMEOUT' };
      }
      return { ok: false, statusCode: 404, error: 'PATH_NOT_FOUND' };
    }

    if (isForbiddenSystemRoot(resolvedReal)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }

    let stat;
    try {
      stat = await withTimeout(fs.promises.stat(resolvedReal), fsTimeoutMs, 'STAT_TIMEOUT');
    } catch (err) {
      if (err?.code === 'STAT_TIMEOUT') {
        return { ok: false, statusCode: 504, error: 'BROWSE_TIMEOUT' };
      }
      return { ok: false, statusCode: 404, error: 'PATH_NOT_FOUND' };
    }
    if (!stat.isDirectory()) {
      return { ok: false, statusCode: 400, error: 'ROOT_NOT_DIRECTORY' };
    }

    let dirents;
    try {
      dirents = await withTimeout(
        fs.promises.readdir(resolvedReal, { withFileTypes: true }),
        fsTimeoutMs,
        'READDIR_TIMEOUT'
      );
    } catch (err) {
      if (err?.code === 'READDIR_TIMEOUT') {
        return { ok: false, statusCode: 504, error: 'BROWSE_TIMEOUT' };
      }
      return { ok: false, statusCode: 403, error: 'READDIR_FAILED', message: err?.message || 'READDIR_FAILED' };
    }

    const entries = [];
    for (const dirent of dirents) {
      const name = dirent.name;
      if (!showHidden && name.startsWith('.')) continue;

      const entryPath = path.join(resolvedReal, name);
      let isDir = dirent.isDirectory();
      const isSymlink = dirent.isSymbolicLink();

      if (isSymlink) {
        try {
          const linkTargetReal = await withTimeout(fs.promises.realpath(entryPath), 400, 'SYMLINK_TIMEOUT');
          if (isForbiddenSystemRoot(linkTargetReal)) continue;
          const linkSt = await withTimeout(fs.promises.stat(linkTargetReal), 400, 'SYMLINK_TIMEOUT');
          isDir = linkSt.isDirectory();
        } catch {
          isDir = false;
        }
      }

      if (!isDir) continue;
      let isGitRepo = false;
      try {
        isGitRepo = fs.existsSync(path.join(entryPath, '.git'));
      } catch {
        isGitRepo = false;
      }

      entries.push({
        name,
        path: entryPath,
        isGitRepo,
        isSymlink
      });
      if (entries.length >= MAX_ENTRIES) break;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const rawParent = path.dirname(resolvedReal);
    const parentPath = rawParent && rawParent !== resolvedReal && !isForbiddenSystemRoot(rawParent)
      ? rawParent
      : null;

    const shortcuts = await detectShortcuts({
      getDefaultSessionPath,
      getProjectRootPaths,
      gdriveScanRoots
    });

    return {
      ok: true,
      requestedPath: normalized,
      resolvedPath: resolvedReal,
      exists,
      willCreateRelative,
      parentPath,
      breadcrumbs: buildBreadcrumbs(resolvedReal),
      entries,
      shortcuts
    };
  }

  async function mkdir({ parentDir, name } = {}) {
    const cleanName = typeof name === 'string' ? name.trim() : '';
    if (
      !cleanName
      || cleanName === '.'
      || cleanName === '..'
      || cleanName.includes('/')
      || cleanName.includes('\\')
      || cleanName.includes('\0')
    ) {
      return { ok: false, statusCode: 400, error: 'INVALID_DIR_NAME' };
    }

    const normalizedParent = normalizeLocalPath(parentDir);
    if (!normalizedParent) {
      return { ok: false, statusCode: 400, error: 'INVALID_PATH' };
    }
    if (isForbiddenSystemRoot(normalizedParent)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }

    let realParent;
    try {
      realParent = await withTimeout(fs.promises.realpath(normalizedParent), fsTimeoutMs, 'REALPATH_TIMEOUT');
    } catch {
      return { ok: false, statusCode: 404, error: 'PARENT_NOT_FOUND' };
    }

    if (isForbiddenSystemRoot(realParent)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }

    let st;
    try {
      st = await withTimeout(fs.promises.stat(realParent), fsTimeoutMs, 'STAT_TIMEOUT');
    } catch {
      return { ok: false, statusCode: 404, error: 'PARENT_NOT_FOUND' };
    }
    if (!st.isDirectory()) {
      return { ok: false, statusCode: 400, error: 'PARENT_NOT_DIRECTORY' };
    }

    const targetDir = path.join(realParent, cleanName);
    if (isForbiddenSystemRoot(targetDir)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }
    if (fs.existsSync(targetDir)) {
      return { ok: false, statusCode: 409, error: 'DIR_ALREADY_EXISTS', path: targetDir };
    }

    try {
      fs.mkdirSync(targetDir, { recursive: false });
    } catch (err) {
      return {
        ok: false,
        statusCode: 400,
        error: 'MKDIR_FAILED',
        message: err?.message || 'MKDIR_FAILED'
      };
    }

    return {
      ok: true,
      name: cleanName,
      path: targetDir,
      parentPath: realParent
    };
  }

  return {
    browse,
    mkdir
  };
}

module.exports = {
  createWorkspaceBrowser,
  normalizeLocalPath,
  isForbiddenSystemRoot,
  isSameOrInside
};
