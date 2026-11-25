'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { isForbiddenSystemRoot } = require('./workspace-meta-store');

const execFileAsync = promisify(execFile);

const IS_CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const PERCENT_ENCODED_RE = /%[0-9A-Fa-f]{2}/;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_RAW_ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
const IGNORED_TREE_NAMES = new Set(['.git', 'node_modules']);
const GIT_TIMEOUT_MS = 10_000;
const GIT_PUSH_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const MAX_COMMIT_MESSAGE_CHARS = 8192;

const MIME_BY_EXT = Object.freeze({
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf'
});

function outsideError() {
  return { ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' };
}

function isInsideDir(targetPath, baseDir) {
  const a = IS_CASE_INSENSITIVE_FS ? String(targetPath).toLowerCase() : String(targetPath);
  const b = IS_CASE_INSENSITIVE_FS ? String(baseDir).toLowerCase() : String(baseDir);
  const rel = path.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function expandTilde(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * Normalizes a workspace root input: converts file:// URIs via fileURLToPath,
 * safely decodes percent-encoded paths when raw path doesn't exist on disk but decoded does,
 * expands ~/, and resolves to an absolute path.
 */
function normalizeInputRoot(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s || s.includes('\0')) return '';

  if (/^file:\/\//i.test(s)) {
    try {
      s = url.fileURLToPath(s);
    } catch {
      return '';
    }
  }

  s = expandTilde(s);
  if (!s || s.includes('\0')) return '';

  if (PERCENT_ENCODED_RE.test(s) && !fs.existsSync(s)) {
    try {
      const decoded = expandTilde(decodeURIComponent(s));
      if (decoded && !decoded.includes('\0') && fs.existsSync(decoded)) {
        s = decoded;
      }
    } catch {
      // Keep raw if malformed percent-encoding
    }
  }

  return path.resolve(s);
}

function toPosixRel(baseDir, targetPath) {
  const rel = path.relative(baseDir, targetPath);
  return rel ? rel.split(path.sep).join('/') : '';
}

function guessMime(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function findDeepestExistingAncestor(targetPath) {
  let current = path.dirname(targetPath);
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

function resolveRealRoots(roots) {
  const resolved = [];
  for (const r of roots) {
    if (typeof r !== 'string' || !r || r.includes('\0')) continue;
    try {
      resolved.push(fs.realpathSync(r));
    } catch {
      // Ignore roots that do not exist yet
    }
  }
  return resolved;
}

/**
 * Resolves a relative or absolute path strictly inside `realBase` (and optionally
 * `allowedRealRoots`), blocking lexical traversal, out-of-root absolute paths,
 * and escaping symlinks (including dangling symlinks).
 */
function resolveWithinBase({ realBase, allowedRealRoots, relPath = '', mustExist = true, forWrite = false }) {
  if (typeof relPath !== 'string' || relPath.includes('\0')) {
    return { ok: false, statusCode: 400, error: 'INVALID_PATH' };
  }

  const candidate = path.resolve(realBase, relPath);
  if (!isInsideDir(candidate, realBase)) {
    return outsideError();
  }

  let lstat = null;
  try {
    lstat = fs.lstatSync(candidate);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      return { ok: false, statusCode: 400, error: 'INVALID_PATH' };
    }
  }

  if (lstat) {
    try {
      const realTarget = fs.realpathSync(candidate);
      if (!isInsideDir(realTarget, realBase)) return outsideError();
      if (allowedRealRoots && !allowedRealRoots.some((r) => isInsideDir(realTarget, r))) {
        return outsideError();
      }
      return { ok: true, realTarget, exists: true, lstat };
    } catch (err) {
      if (lstat.isSymbolicLink()) {
        // Dangling symlink: inspect link target to ensure escaping symlinks return 403.
        try {
          const rawLink = fs.readlinkSync(candidate);
          const resolvedLink = path.resolve(path.dirname(candidate), rawLink);
          if (!isInsideDir(resolvedLink, realBase)) return outsideError();
          const linkAncestor = fs.realpathSync(findDeepestExistingAncestor(resolvedLink));
          if (!isInsideDir(linkAncestor, realBase)) return outsideError();
        } catch {
          return outsideError();
        }
        if (forWrite) return outsideError();
        return { ok: false, statusCode: 404, error: 'FILE_NOT_FOUND' };
      }
      if (err && err.code === 'ENOENT') {
        return { ok: false, statusCode: 404, error: 'FILE_NOT_FOUND' };
      }
      return outsideError();
    }
  }

  // Target does not exist: validate deepest existing ancestor via realpathSync.
  let realAncestor;
  const ancestor = findDeepestExistingAncestor(candidate);
  try {
    realAncestor = fs.realpathSync(ancestor);
  } catch {
    return outsideError();
  }

  if (!isInsideDir(realAncestor, realBase)) return outsideError();
  if (allowedRealRoots && !allowedRealRoots.some((r) => isInsideDir(realAncestor, r))) {
    return outsideError();
  }

  if (mustExist) {
    return { ok: false, statusCode: 404, error: 'FILE_NOT_FOUND' };
  }

  const realTarget = path.join(realAncestor, path.relative(ancestor, candidate));
  if (!isInsideDir(realTarget, realBase)) return outsideError();
  return { ok: true, realTarget, exists: false, lstat: null };
}

function readBoundedFile(filePath, limit) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    if (stat.isDirectory()) {
      return { ok: false, statusCode: 400, error: 'IS_A_DIRECTORY' };
    }
    const size = stat.size;
    const bytesToRead = Math.min(size, limit);
    const buf = Buffer.allocUnsafe(bytesToRead);
    let totalRead = 0;
    while (totalRead < bytesToRead) {
      const n = fs.readSync(fd, buf, totalRead, bytesToRead - totalRead, totalRead);
      if (n === 0) break;
      totalRead += n;
    }
    return {
      ok: true,
      size,
      truncated: size > limit,
      content: buf.subarray(0, totalRead).toString('utf8')
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: false, statusCode: 404, error: 'FILE_NOT_FOUND' };
    }
    return { ok: false, statusCode: 500, error: err && err.message ? err.message : 'READ_FAILED' };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }
}

function compareTreeNodes(a, b) {
  if (a.type !== b.type) {
    return a.type === 'directory' ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function buildTreeEntries({ dirPath, realRoot, remainingDepth, visitedRealDirs }) {
  if (remainingDepth <= 0) return [];

  let dirents;
  try {
    dirents = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes = [];
  for (const ent of dirents) {
    if (IGNORED_TREE_NAMES.has(ent.name)) continue;

    const fullPath = path.join(dirPath, ent.name);
    let entryRealPath = fullPath;
    let isDir = ent.isDirectory();
    let isFile = ent.isFile();
    let size;

    if (ent.isSymbolicLink()) {
      try {
        entryRealPath = fs.realpathSync(fullPath);
        if (!isInsideDir(entryRealPath, realRoot)) continue;
        const st = fs.statSync(entryRealPath);
        isDir = st.isDirectory();
        isFile = st.isFile();
        size = st.size;
      } catch {
        continue;
      }
    } else if (isFile) {
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        continue;
      }
    }

    if (!isDir && !isFile) continue;

    const relPath = toPosixRel(realRoot, fullPath);
    if (isDir) {
      const node = { name: ent.name, path: relPath, type: 'directory' };
      if (remainingDepth > 1 && !visitedRealDirs.has(entryRealPath)) {
        visitedRealDirs.add(entryRealPath);
        node.children = buildTreeEntries({
          dirPath: entryRealPath,
          realRoot,
          remainingDepth: remainingDepth - 1,
          visitedRealDirs
        });
      }
      nodes.push(node);
    } else {
      nodes.push({ name: ent.name, path: relPath, type: 'file', size });
    }
  }

  nodes.sort(compareTreeNodes);
  return nodes;
}

async function runGit(cwd, args, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    return { ok: true, stdout: stdout || '', stderr: stderr || '' };
  } catch (err) {
    return {
      ok: false,
      stdout: (err && err.stdout) || '',
      stderr: (err && err.stderr) || '',
      error: err
    };
  }
}

function validateSafeGitArg(value, errorCode = 'INVALID_PATH') {
  if (typeof value !== 'string') {
    return { ok: false, statusCode: 400, error: errorCode };
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.startsWith('-')) {
    return { ok: false, statusCode: 400, error: errorCode };
  }
  return { ok: true, value: trimmed };
}

function validateSafeRefToken(value, errorCode = 'INVALID_GIT_REF') {
  const base = validateSafeGitArg(value, errorCode);
  if (!base.ok) return base;
  if (
    /[\s~^:?*\[\\]/.test(base.value) ||
    base.value.includes('..') ||
    base.value.includes('@{') ||
    base.value.endsWith('.lock') ||
    base.value.endsWith('/')
  ) {
    return { ok: false, statusCode: 400, error: errorCode };
  }
  return base;
}

function isSameDir(dirA, dirB) {
  return isInsideDir(dirA, dirB) && isInsideDir(dirB, dirA);
}

function parseWorktreePorcelain(stdout, realRoot, allowedRealRoots = null) {
  const worktrees = [];
  const blocks = String(stdout || '').split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    if (lines.length === 0) continue;
    const item = {
      path: '',
      head: '',
      branch: '',
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
      isCurrent: false,
      allowed: true
    };
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        item.path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        item.head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        item.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      } else if (line === 'bare') {
        item.bare = true;
      } else if (line === 'detached') {
        item.detached = true;
      } else if (line === 'locked' || line.startsWith('locked ')) {
        item.locked = true;
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        item.prunable = true;
      }
    }
    if (item.path) {
      let realWt = item.path;
      try {
        realWt = fs.realpathSync(item.path);
      } catch {
        realWt = path.resolve(item.path);
      }
      item.isCurrent = isSameDir(realWt, realRoot);
      if (Array.isArray(allowedRealRoots) && allowedRealRoots.length > 0) {
        item.allowed = allowedRealRoots.some((allowed) => isInsideDir(realWt, allowed));
      }
      worktrees.push(item);
    }
  }
  return worktrees;
}

function mapPorcelainStatus(xy) {
  if (xy === '??') return 'untracked';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('A')) return 'added';
  if (xy.includes('D')) return 'deleted';
  return 'modified';
}

function parseGitFiles(statusOut, numstatOut) {
  const numstatByPath = new Map();
  if (numstatOut) {
    for (const rec of numstatOut.split('\0')) {
      if (!rec) continue;
      const parts = rec.split('\t');
      if (parts.length < 3) continue;
      const additions = parts[0] === '-' ? 0 : Number.parseInt(parts[0], 10) || 0;
      const deletions = parts[1] === '-' ? 0 : Number.parseInt(parts[1], 10) || 0;
      const filePath = parts.slice(2).join('\t');
      numstatByPath.set(filePath, { additions, deletions });
    }
  }

  const files = [];
  const seen = new Set();
  if (statusOut) {
    const tokens = statusOut.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (!entry || entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      let filePath = entry.slice(3);
      if (xy.includes('R') || xy.includes('C')) {
        // In `-z` porcelain output, rename/copy includes an extra NUL-terminated original path.
        i += 1;
      }
      const stats = numstatByPath.get(filePath) || { additions: 0, deletions: 0 };
      files.push({
        path: filePath,
        status: mapPorcelainStatus(xy),
        additions: stats.additions,
        deletions: stats.deletions,
        staged: xy[0] !== ' ' && xy[0] !== '?',
        unstaged: xy[1] !== ' '
      });
      seen.add(filePath);
    }
  }

  for (const [filePath, stats] of numstatByPath.entries()) {
    if (seen.has(filePath)) continue;
    files.push({
      path: filePath,
      status: 'modified',
      additions: stats.additions,
      deletions: stats.deletions,
      staged: false,
      unstaged: true
    });
  }

  return files;
}

/**
 * Creates a sandboxed workspace and artifacts service backed solely by Node built-ins.
 */
function createWorkspaceService({
  allowedRoots = [],
  getAllowedRoots = null,
  brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
  maxReadBytes = DEFAULT_MAX_BYTES,
  maxWriteBytes = DEFAULT_MAX_BYTES
} = {}) {
  const defaultReadLimit = Number.isFinite(Number(maxReadBytes)) && Number(maxReadBytes) >= 0
    ? Math.floor(Number(maxReadBytes))
    : DEFAULT_MAX_BYTES;
  const defaultWriteLimit = Number.isFinite(Number(maxWriteBytes)) && Number(maxWriteBytes) >= 0
    ? Math.floor(Number(maxWriteBytes))
    : DEFAULT_MAX_BYTES;

  function resolveRootAndTarget({ root, relPath = '', mustExist = true, forWrite = false }) {
    if (typeof root !== 'string' || !root || root.includes('\0')) {
      return { ok: false, statusCode: 400, error: 'INVALID_ROOT' };
    }
    const normalizedRoot = normalizeInputRoot(root);
    if (!normalizedRoot) {
      return { ok: false, statusCode: 400, error: 'INVALID_ROOT' };
    }

    const activeRoots = typeof getAllowedRoots === 'function' ? getAllowedRoots() : allowedRoots;
    const normalizedActiveRoots = Array.isArray(activeRoots)
      ? activeRoots.map((r) => normalizeInputRoot(r)).filter(Boolean)
      : [];
    const allowedRealRoots = resolveRealRoots(normalizedActiveRoots);
    if (allowedRealRoots.length === 0) {
      return outsideError();
    }

    let rootLstat = null;
    try {
      rootLstat = fs.lstatSync(normalizedRoot);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        const ancestor = findDeepestExistingAncestor(normalizedRoot);
        let realAncestor;
        try {
          realAncestor = fs.realpathSync(ancestor);
        } catch {
          return outsideError();
        }
        const realCandidate = path.join(realAncestor, path.relative(ancestor, normalizedRoot));
        const insideAllowed = allowedRealRoots.some(
          (allowed) => isInsideDir(realAncestor, allowed) && isInsideDir(realCandidate, allowed)
        );
        if (insideAllowed) {
          return { ok: false, statusCode: 404, error: 'ROOT_NOT_FOUND' };
        }
        return outsideError();
      }
      return outsideError();
    }

    let realRoot;
    try {
      realRoot = fs.realpathSync(normalizedRoot);
    } catch (err) {
      if (rootLstat && rootLstat.isSymbolicLink() && err && err.code === 'ENOENT') {
        try {
          const parentReal = fs.realpathSync(path.dirname(normalizedRoot));
          if (!allowedRealRoots.some((allowed) => isInsideDir(parentReal, allowed))) {
            return outsideError();
          }
          const rawLink = fs.readlinkSync(normalizedRoot);
          const resolvedLink = path.resolve(parentReal, rawLink);
          const linkAncestor = fs.realpathSync(findDeepestExistingAncestor(resolvedLink));
          const realLinkTarget = path.join(
            linkAncestor,
            path.relative(findDeepestExistingAncestor(resolvedLink), resolvedLink)
          );
          if (allowedRealRoots.some((allowed) => isInsideDir(linkAncestor, allowed) && isInsideDir(realLinkTarget, allowed))) {
            return { ok: false, statusCode: 404, error: 'ROOT_NOT_FOUND' };
          }
        } catch {
          return outsideError();
        }
        return outsideError();
      }
      return outsideError();
    }

    if (!allowedRealRoots.some((allowed) => isInsideDir(realRoot, allowed))) {
      return outsideError();
    }

    let rootStat;
    try {
      rootStat = fs.statSync(realRoot);
    } catch {
      return outsideError();
    }
    if (!rootStat.isDirectory()) {
      return { ok: false, statusCode: 400, error: 'ROOT_NOT_DIRECTORY' };
    }

    const resolved = resolveWithinBase({
      realBase: realRoot,
      allowedRealRoots,
      relPath: relPath == null ? '' : relPath,
      mustExist,
      forWrite
    });
    if (!resolved.ok) return resolved;

    return {
      ok: true,
      realRoot,
      allowedRealRoots,
      realTarget: resolved.realTarget,
      exists: resolved.exists,
      lstat: resolved.lstat
    };
  }

  function listTree({ root, path: relPath = '', depth = 2 } = {}) {
    const resolved = resolveRootAndTarget({ root, relPath, mustExist: true });
    if (!resolved.ok) return resolved;

    try {
      if (!fs.statSync(resolved.realTarget).isDirectory()) {
        return { ok: false, statusCode: 400, error: 'NOT_A_DIRECTORY' };
      }
    } catch {
      return { ok: false, statusCode: 404, error: 'FILE_NOT_FOUND' };
    }

    const maxDepth = Number.isFinite(Number(depth))
      ? Math.max(0, Math.min(20, Math.floor(Number(depth))))
      : 2;

    const visitedRealDirs = new Set([resolved.realTarget]);
    const entries = buildTreeEntries({
      dirPath: resolved.realTarget,
      realRoot: resolved.realRoot,
      remainingDepth: maxDepth,
      visitedRealDirs
    });

    return {
      ok: true,
      root: resolved.realRoot,
      path: toPosixRel(resolved.realRoot, resolved.realTarget),
      entries
    };
  }

  function readFile({ root, path: relPath, maxBytes } = {}) {
    if (typeof relPath !== 'string' || !relPath) {
      return { ok: false, statusCode: 400, error: 'INVALID_PATH' };
    }
    const resolved = resolveRootAndTarget({ root, relPath, mustExist: true });
    if (!resolved.ok) return resolved;

    const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) >= 0
      ? Math.floor(Number(maxBytes))
      : defaultReadLimit;

    const readRes = readBoundedFile(resolved.realTarget, limit);
    if (!readRes.ok) return readRes;

    return {
      ok: true,
      path: toPosixRel(resolved.realRoot, resolved.realTarget),
      size: readRes.size,
      truncated: readRes.truncated,
      content: readRes.content
    };
  }

  function writeFile({ root, path: relPath, content } = {}) {
    if (typeof relPath !== 'string' || !relPath) {
      return { ok: false, statusCode: 400, error: 'INVALID_PATH' };
    }

    let buf;
    if (typeof content === 'string') {
      buf = Buffer.from(content, 'utf8');
    } else if (Buffer.isBuffer(content)) {
      buf = content;
    } else {
      return { ok: false, statusCode: 400, error: 'INVALID_CONTENT' };
    }

    if (buf.byteLength > defaultWriteLimit) {
      return { ok: false, statusCode: 413, error: 'PAYLOAD_TOO_LARGE' };
    }

    const resolved = resolveRootAndTarget({ root, relPath, mustExist: false, forWrite: true });
    if (!resolved.ok) return resolved;

    if (resolved.exists && resolved.lstat && resolved.lstat.isDirectory()) {
      return { ok: false, statusCode: 400, error: 'IS_A_DIRECTORY' };
    }

    const targetDir = path.dirname(resolved.realTarget);
    fs.mkdirSync(targetDir, { recursive: true });

    // Re-verify parent containment after mkdirSync.
    let realParent;
    try {
      realParent = fs.realpathSync(targetDir);
    } catch {
      return outsideError();
    }
    if (!isInsideDir(realParent, resolved.realRoot)) {
      return outsideError();
    }

    const finalTarget = path.join(realParent, path.basename(resolved.realTarget));
    const tmpPath = path.join(
      realParent,
      `.agy-tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
    );

    try {
      fs.writeFileSync(tmpPath, buf);
      fs.renameSync(tmpPath, finalTarget);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      return { ok: false, statusCode: 500, error: err && err.message ? err.message : 'WRITE_FAILED' };
    }

    return {
      ok: true,
      path: toPosixRel(resolved.realRoot, finalTarget),
      bytes: buf.byteLength
    };
  }

  async function getGitDiff({ root, path: relPath } = {}) {
    if (relPath !== undefined && relPath !== null && relPath !== '') {
      const argCheck = validateSafeGitArg(relPath, 'INVALID_PATH');
      if (!argCheck.ok) return argCheck;
    }
    const resolved = resolveRootAndTarget({
      root,
      relPath: relPath == null ? '' : relPath,
      mustExist: false
    });
    if (!resolved.ok) return resolved;

    const checkRepo = await runGit(resolved.realRoot, ['rev-parse', '--is-inside-work-tree']);
    if (!checkRepo.ok || checkRepo.stdout.trim() !== 'true') {
      return {
        ok: true,
        isGitRepo: false,
        branch: '',
        files: [],
        diffText: ''
      };
    }

    let branch = '';
    const branchRes = await runGit(resolved.realRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branchRes.ok) {
      branch = branchRes.stdout.trim();
    } else {
      const symRes = await runGit(resolved.realRoot, ['symbolic-ref', '--short', 'HEAD']);
      if (symRes.ok) branch = symRes.stdout.trim();
    }

    const filterRel = relPath ? toPosixRel(resolved.realRoot, resolved.realTarget) : '';
    const pathSpecArgs = filterRel ? ['--', filterRel] : [];

    const hasHeadRes = await runGit(resolved.realRoot, ['rev-parse', '--verify', 'HEAD']);
    const diffBaseArgs = hasHeadRes.ok ? ['diff', 'HEAD'] : ['diff', '--cached'];

    const [diffRes, numstatRes, statusRes] = await Promise.all([
      runGit(resolved.realRoot, [...diffBaseArgs, '--no-color', ...pathSpecArgs]),
      runGit(resolved.realRoot, [...diffBaseArgs, '--numstat', '-z', ...pathSpecArgs]),
      runGit(resolved.realRoot, ['status', '--porcelain=v1', '-z', ...pathSpecArgs])
    ]);

    let diffText = diffRes.ok ? diffRes.stdout : '';
    let numstatOut = numstatRes.ok ? numstatRes.stdout : '';
    if (!hasHeadRes.ok && !diffText) {
      const unstaged = await runGit(resolved.realRoot, ['diff', '--no-color', ...pathSpecArgs]);
      if (unstaged.ok) diffText = unstaged.stdout;
      const unstagedNum = await runGit(resolved.realRoot, ['diff', '--numstat', '-z', ...pathSpecArgs]);
      if (unstagedNum.ok) numstatOut = unstagedNum.stdout;
    }

    const files = parseGitFiles(statusRes.ok ? statusRes.stdout : '', numstatOut);
    return {
      ok: true,
      isGitRepo: true,
      branch,
      files,
      diffText
    };
  }

  async function ensureGitRepoRoot(root) {
    const resolved = resolveRootAndTarget({ root, relPath: '', mustExist: true });
    if (!resolved.ok) return resolved;
    const checkRepo = await runGit(resolved.realRoot, ['rev-parse', '--is-inside-work-tree']);
    if (!checkRepo.ok || checkRepo.stdout.trim() !== 'true') {
      return {
        ok: false,
        statusCode: 400,
        error: 'NOT_A_GIT_REPO',
        realRoot: resolved.realRoot,
        allowedRealRoots: resolved.allowedRealRoots
      };
    }
    return {
      ok: true,
      realRoot: resolved.realRoot,
      allowedRealRoots: resolved.allowedRealRoots
    };
  }

  async function listWorktrees({ root } = {}) {
    const resolved = resolveRootAndTarget({ root, relPath: '', mustExist: true });
    if (!resolved.ok) return resolved;

    const checkRepo = await runGit(resolved.realRoot, ['rev-parse', '--is-inside-work-tree']);
    if (!checkRepo.ok || checkRepo.stdout.trim() !== 'true') {
      return { ok: true, isGitRepo: false, worktrees: [] };
    }

    const wtRes = await runGit(resolved.realRoot, ['worktree', 'list', '--porcelain']);
    if (!wtRes.ok) {
      return {
        ok: false,
        statusCode: 500,
        error: (wtRes.stderr || wtRes.stdout || 'GIT_WORKTREE_LIST_FAILED').trim()
      };
    }

    return {
      ok: true,
      isGitRepo: true,
      worktrees: parseWorktreePorcelain(wtRes.stdout, resolved.realRoot, resolved.allowedRealRoots)
    };
  }

  async function gitStage({ root, paths, unstage = false, all = false } = {}) {
    const repoCheck = await ensureGitRepoRoot(root);
    if (!repoCheck.ok) return repoCheck;

    const { realRoot, allowedRealRoots } = repoCheck;
    let safeRelPaths = [];
    let gitRes;

    if (all === true) {
      if (unstage) {
        const hasHead = await runGit(realRoot, ['rev-parse', '--verify', 'HEAD']);
        if (hasHead.ok) {
          gitRes = await runGit(realRoot, ['reset', '-q', 'HEAD']);
        } else {
          gitRes = await runGit(realRoot, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '.']);
        }
      } else {
        gitRes = await runGit(realRoot, ['add', '-A']);
      }
    } else {
      if (!Array.isArray(paths) || paths.length === 0) {
        return { ok: false, statusCode: 400, error: 'MISSING_STAGE_PATHS' };
      }

      for (const p of paths) {
        const argCheck = validateSafeGitArg(p, 'INVALID_PATH');
        if (!argCheck.ok) return argCheck;

        const resolved = resolveWithinBase({
          realBase: realRoot,
          allowedRealRoots,
          relPath: argCheck.value,
          mustExist: false
        });
        if (!resolved.ok) return resolved;

        const rel = toPosixRel(realRoot, resolved.realTarget);
        safeRelPaths.push(rel || '.');
      }

      if (unstage) {
        const hasHead = await runGit(realRoot, ['rev-parse', '--verify', 'HEAD']);
        if (hasHead.ok) {
          gitRes = await runGit(realRoot, ['reset', '-q', 'HEAD', '--', ...safeRelPaths]);
        } else {
          gitRes = await runGit(realRoot, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...safeRelPaths]);
        }
      } else {
        gitRes = await runGit(realRoot, ['add', '--', ...safeRelPaths]);
      }
    }

    if (!gitRes.ok) {
      return {
        ok: false,
        statusCode: 400,
        error: (gitRes.stderr || gitRes.stdout || 'GIT_STAGE_FAILED').trim()
      };
    }

    return {
      ok: true,
      staged: !unstage,
      ...(all === true ? { all: true } : {}),
      paths: safeRelPaths
    };
  }

  async function gitCommit({ root, message } = {}) {
    const repoCheck = await ensureGitRepoRoot(root);
    if (!repoCheck.ok) return repoCheck;

    if (typeof message !== 'string' || message.includes('\0')) {
      return { ok: false, statusCode: 400, error: 'INVALID_COMMIT_MESSAGE' };
    }
    const cleanMsg = message.trim();
    if (!cleanMsg || cleanMsg.length > MAX_COMMIT_MESSAGE_CHARS) {
      return { ok: false, statusCode: 400, error: 'INVALID_COMMIT_MESSAGE' };
    }

    const commitRes = await runGit(repoCheck.realRoot, ['commit', '-m', cleanMsg]);
    if (!commitRes.ok) {
      return {
        ok: false,
        statusCode: 400,
        error: (commitRes.stderr || commitRes.stdout || 'GIT_COMMIT_FAILED').trim()
      };
    }

    const [shaRes, branchRes] = await Promise.all([
      runGit(repoCheck.realRoot, ['rev-parse', 'HEAD']),
      runGit(repoCheck.realRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    ]);

    return {
      ok: true,
      commitSha: shaRes.ok ? shaRes.stdout.trim() : '',
      branch: branchRes.ok ? branchRes.stdout.trim() : '',
      message: cleanMsg,
      stdout: commitRes.stdout.trim()
    };
  }

  async function gitPush({ root, remote, branch, setUpstream = false } = {}) {
    const repoCheck = await ensureGitRepoRoot(root);
    if (!repoCheck.ok) return repoCheck;

    const args = ['push'];
    let cleanRemote = '';
    let cleanBranch = '';

    if (remote !== undefined && remote !== null && remote !== '') {
      const remoteCheck = validateSafeRefToken(remote, 'INVALID_GIT_REMOTE');
      if (!remoteCheck.ok) return remoteCheck;
      cleanRemote = remoteCheck.value;
    }
    if (branch !== undefined && branch !== null && branch !== '') {
      const branchCheck = validateSafeRefToken(branch, 'INVALID_GIT_BRANCH');
      if (!branchCheck.ok) return branchCheck;
      cleanBranch = branchCheck.value;
    }

    if (setUpstream) {
      args.push('-u');
      if (!cleanRemote) cleanRemote = 'origin';
      if (!cleanBranch) {
        const branchRes = await runGit(repoCheck.realRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const headBranch = branchRes.ok ? branchRes.stdout.trim() : '';
        if (headBranch && headBranch !== 'HEAD') {
          cleanBranch = headBranch;
        }
      }
    }

    if (cleanRemote) {
      args.push(cleanRemote);
    } else if (cleanBranch) {
      cleanRemote = 'origin';
      args.push(cleanRemote);
    }
    if (cleanBranch) {
      args.push(cleanBranch);
    }

    const pushRes = await runGit(repoCheck.realRoot, args, { timeoutMs: GIT_PUSH_TIMEOUT_MS });
    if (!pushRes.ok) {
      return {
        ok: false,
        statusCode: 400,
        error: (pushRes.stderr || pushRes.stdout || 'GIT_PUSH_FAILED').trim()
      };
    }

    return {
      ok: true,
      remote: cleanRemote,
      branch: cleanBranch,
      stdout: pushRes.stdout.trim(),
      stderr: pushRes.stderr.trim()
    };
  }

  function resolveWorktreePath(repoCheck, rawPath) {
    const argCheck = validateSafeGitArg(rawPath, 'INVALID_WORKTREE_PATH');
    if (!argCheck.ok) return argCheck;

    const expanded = expandTilde(argCheck.value);
    if (!expanded || expanded.includes('\0')) {
      return { ok: false, statusCode: 400, error: 'INVALID_WORKTREE_PATH' };
    }

    const candidate = path.resolve(repoCheck.realRoot, expanded);
    if (isForbiddenSystemRoot(candidate)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }

    const ancestor = findDeepestExistingAncestor(candidate);
    let realAncestor;
    try {
      realAncestor = fs.realpathSync(ancestor);
    } catch {
      return outsideError();
    }
    if (!repoCheck.allowedRealRoots.some((allowed) => isInsideDir(realAncestor, allowed))) {
      return outsideError();
    }

    const target = path.join(realAncestor, path.relative(ancestor, candidate));
    if (isForbiddenSystemRoot(target)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }
    if (!repoCheck.allowedRealRoots.some((allowed) => isInsideDir(target, allowed))) {
      return outsideError();
    }
    try {
      if (fs.existsSync(target)) {
        const realExisting = fs.realpathSync(target);
        if (!repoCheck.allowedRealRoots.some((allowed) => isInsideDir(realExisting, allowed))) {
          return outsideError();
        }
        return { ok: true, targetPath: realExisting };
      }
    } catch {
      return outsideError();
    }
    return { ok: true, targetPath: target };
  }

  async function gitWorktree({ root, action, path: wtPath, branch, createBranch = false } = {}) {
    const rawAct = typeof action === 'string' ? action.trim().toLowerCase() : '';
    const act = rawAct === 'create' ? 'add' : rawAct;

    if (act === 'list') {
      return listWorktrees({ root });
    }

    const repoCheck = await ensureGitRepoRoot(root);
    if (!repoCheck.ok) return repoCheck;

    if (act === 'prune') {
      const pruneRes = await runGit(repoCheck.realRoot, ['worktree', 'prune']);
      if (!pruneRes.ok) {
        return {
          ok: false,
          statusCode: 400,
          error: (pruneRes.stderr || pruneRes.stdout || 'GIT_WORKTREE_PRUNE_FAILED').trim()
        };
      }
      const listed = await listWorktrees({ root: repoCheck.realRoot });
      return listed.ok ? { ...listed, action: 'prune' } : listed;
    }

    if (act !== 'add' && act !== 'remove') {
      return { ok: false, statusCode: 400, error: 'INVALID_WORKTREE_ACTION' };
    }

    const targetCheck = resolveWorktreePath(repoCheck, wtPath);
    if (!targetCheck.ok) return targetCheck;

    let cleanBranch = '';
    if (branch !== undefined && branch !== null && branch !== '') {
      const brCheck = validateSafeRefToken(branch, 'INVALID_GIT_BRANCH');
      if (!brCheck.ok) return brCheck;
      cleanBranch = brCheck.value;
    }

    let gitArgs;
    if (act === 'add') {
      gitArgs = ['worktree', 'add'];
      if (createBranch) {
        if (!cleanBranch) {
          return { ok: false, statusCode: 400, error: 'MISSING_BRANCH_NAME' };
        }
        gitArgs.push('-b', cleanBranch);
      }
      gitArgs.push(targetCheck.targetPath);
      if (!createBranch && cleanBranch) {
        gitArgs.push(cleanBranch);
      }
    } else {
      if (isSameDir(targetCheck.targetPath, repoCheck.realRoot)) {
        return { ok: false, statusCode: 400, error: 'CANNOT_REMOVE_MAIN_WORKTREE' };
      }
      gitArgs = ['worktree', 'remove', targetCheck.targetPath];
    }

    const wtRes = await runGit(repoCheck.realRoot, gitArgs);
    if (!wtRes.ok) {
      return {
        ok: false,
        statusCode: 400,
        error: (wtRes.stderr || wtRes.stdout || 'GIT_WORKTREE_FAILED').trim()
      };
    }

    let resolvedTargetPath = targetCheck.targetPath;
    try {
      if (fs.existsSync(targetCheck.targetPath)) {
        resolvedTargetPath = fs.realpathSync(targetCheck.targetPath);
      }
    } catch {
      // Keep lexical target path if removed
    }

    const listed = await listWorktrees({ root: repoCheck.realRoot });
    return listed.ok
      ? { ...listed, action: act, targetPath: resolvedTargetPath }
      : listed;
  }

  function validateSessionDir(sessionId) {
    if (
      typeof sessionId !== 'string' ||
      !sessionId ||
      sessionId.trim() !== sessionId ||
      sessionId === '.' ||
      sessionId === '..' ||
      sessionId.includes('..') ||
      sessionId.includes('/') ||
      sessionId.includes('\\') ||
      sessionId.includes('\0')
    ) {
      return outsideError();
    }

    let realBrainDir;
    try {
      realBrainDir = fs.realpathSync(brainDir);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { ok: true, missingBrain: true, realSessionDir: null };
      }
      return outsideError();
    }

    const resolvedSession = resolveWithinBase({
      realBase: realBrainDir,
      relPath: sessionId,
      mustExist: true
    });
    if (!resolvedSession.ok) {
      if (resolvedSession.statusCode === 404) {
        return { ok: true, missingBrain: true, realSessionDir: null };
      }
      return resolvedSession;
    }

    return { ok: true, missingBrain: false, realSessionDir: resolvedSession.realTarget };
  }

  function listArtifacts(sessionId) {
    const session = validateSessionDir(sessionId);
    if (!session.ok) return session;
    if (session.missingBrain || !session.realSessionDir) {
      return { ok: true, sessionId, items: [] };
    }

    let dirents;
    try {
      dirents = fs.readdirSync(session.realSessionDir, { withFileTypes: true });
    } catch {
      return { ok: true, sessionId, items: [] };
    }

    const items = [];
    for (const ent of dirents) {
      if (ent.name.startsWith('.')) continue;
      const fullPath = path.join(session.realSessionDir, ent.name);
      let realItem;
      let stat;
      try {
        realItem = fs.realpathSync(fullPath);
        if (!isInsideDir(realItem, session.realSessionDir)) continue;
        stat = fs.statSync(realItem);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;

      items.push({
        name: ent.name,
        path: ent.name,
        size: stat.size,
        mime: guessMime(ent.name),
        modifiedAt: stat.mtime.toISOString()
      });
    }

    items.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, sessionId, items };
  }

  function resolveArtifactTarget(sessionId, fileName) {
    const session = validateSessionDir(sessionId);
    if (!session.ok) return session;

    if (typeof fileName !== 'string' || !fileName || fileName.includes('\0')) {
      return outsideError();
    }
    // Check lexical traversal even if brainDir/sessionDir does not exist on disk.
    const baseCheck = session.realSessionDir || path.resolve(brainDir, sessionId);
    const lexicalTarget = path.resolve(baseCheck, fileName);
    if (!isInsideDir(lexicalTarget, baseCheck)) {
      return outsideError();
    }

    if (session.missingBrain || !session.realSessionDir) {
      return { ok: false, statusCode: 404, error: 'FILE_NOT_FOUND' };
    }

    const resolvedFile = resolveWithinBase({
      realBase: session.realSessionDir,
      relPath: fileName,
      mustExist: true
    });
    if (!resolvedFile.ok) return resolvedFile;

    return { ok: true, session, resolvedFile };
  }

  function readArtifact(sessionId, fileName) {
    const target = resolveArtifactTarget(sessionId, fileName);
    if (!target.ok) return target;

    const readRes = readBoundedFile(target.resolvedFile.realTarget, defaultReadLimit);
    if (!readRes.ok) return readRes;

    const relName = toPosixRel(target.session.realSessionDir, target.resolvedFile.realTarget);
    return {
      ok: true,
      name: path.basename(relName),
      path: relName,
      mime: guessMime(relName),
      size: readRes.size,
      truncated: readRes.truncated,
      content: readRes.content
    };
  }

  function readArtifactRaw(sessionId, fileName, { maxBytes = DEFAULT_RAW_ARTIFACT_MAX_BYTES } = {}) {
    const target = resolveArtifactTarget(sessionId, fileName);
    if (!target.ok) return target;

    const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) >= 0
      ? Math.floor(Number(maxBytes))
      : DEFAULT_RAW_ARTIFACT_MAX_BYTES;

    let stat;
    try {
      stat = fs.statSync(target.resolvedFile.realTarget);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { ok: false, statusCode: 404, error: 'FILE_NOT_FOUND' };
      }
      return { ok: false, statusCode: 500, error: err && err.message ? err.message : 'READ_FAILED' };
    }

    if (stat.isDirectory()) {
      return { ok: false, statusCode: 400, error: 'IS_A_DIRECTORY' };
    }
    if (stat.size > limit) {
      return { ok: false, statusCode: 413, error: 'PAYLOAD_TOO_LARGE' };
    }

    let buffer;
    try {
      buffer = fs.readFileSync(target.resolvedFile.realTarget);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return { ok: false, statusCode: 404, error: 'FILE_NOT_FOUND' };
      }
      return { ok: false, statusCode: 500, error: err && err.message ? err.message : 'READ_FAILED' };
    }

    const relName = toPosixRel(target.session.realSessionDir, target.resolvedFile.realTarget);
    return {
      ok: true,
      name: path.basename(relName),
      path: relName,
      mime: guessMime(relName),
      size: stat.size,
      buffer
    };
  }

  return {
    listTree,
    readFile,
    writeFile,
    getGitDiff,
    listWorktrees,
    gitStage,
    gitCommit,
    gitPush,
    gitWorktree,
    listArtifacts,
    readArtifact,
    readArtifactRaw
  };
}

module.exports = {
  createWorkspaceService,
  normalizeInputRoot,
  isForbiddenSystemRoot
};
