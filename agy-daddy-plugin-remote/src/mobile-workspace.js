'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveWorkspaceOrg } = require('./session-org-store');

const workspaceOrg = resolveWorkspaceOrg(null);

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_WRITE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DIFF_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
const IGNORED_TREE_NAMES = new Set(['.git', 'node_modules']);

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
  '.webp': 'image/webp',
  '.gif': 'image/gif'
});

function outsideError() {
  return { ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' };
}

function isInsideDir(targetPath, baseDir) {
  return workspaceOrg.isSameOrInside(targetPath, baseDir);
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
  if (!Array.isArray(roots)) return resolved;
  for (const r of roots) {
    if (typeof r !== 'string' || !r || r.includes('\0')) continue;
    try {
      const real = workspaceOrg.resolveRealPath(r);
      if (!resolved.includes(real)) resolved.push(real);
    } catch {
      // Ignore non-existent roots
    }
  }
  return resolved;
}

/**
 * Resolves a path strictly inside `realBase` (and optionally `allowedRealRoots`),
 * blocking lexical traversal, out-of-root absolute paths, and symlink/dangling-symlink escapes.
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
      const realTarget = workspaceOrg.resolveRealPath(candidate);
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
          const linkAncestor = workspaceOrg.resolveRealPath(findDeepestExistingAncestor(resolvedLink));
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

  let realAncestor;
  const ancestor = findDeepestExistingAncestor(candidate);
  try {
    realAncestor = workspaceOrg.resolveRealPath(ancestor);
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

function readBoundedFile(filePath, limit, { binary = false } = {}) {
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
    const slice = buf.subarray(0, totalRead);
    return {
      ok: true,
      size,
      truncated: size > limit,
      content: binary ? slice : slice.toString('utf8')
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
        entryRealPath = workspaceOrg.resolveRealPath(fullPath);
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

async function runGit(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8'
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
      const filePath = entry.slice(3);
      if (xy.includes('R') || xy.includes('C')) {
        i += 1;
      }
      const stats = numstatByPath.get(filePath) || { additions: 0, deletions: 0 };
      files.push({
        path: filePath,
        status: mapPorcelainStatus(xy),
        additions: stats.additions,
        deletions: stats.deletions,
        staged: xy[0] !== ' ' && xy[0] !== '?'
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
      staged: false
    });
  }

  return files;
}

function parseWorktreePorcelain(stdout, realRoot) {
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
      isCurrent: false
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
        realWt = workspaceOrg.resolveRealPath(item.path);
      } catch {
        realWt = path.resolve(item.path);
      }
      item.path = realWt;
      item.isCurrent = workspaceOrg.canonicalKey(realWt) === workspaceOrg.canonicalKey(realRoot);
      const isMainWt = worktrees.length === 0;
      const enriched = workspaceOrg.buildWorktreeDto(item, {
        repoMainPath: worktrees[0]?.path || realWt || realRoot,
        currentRealRoot: realRoot,
        isMain: isMainWt,
        allowedRealRoots: null
      });
      enriched.isCurrent = item.isCurrent;
      worktrees.push(enriched);
    }
  }
  return worktrees;
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
  if (/[\s~^:?*\[\\]/.test(base.value) || base.value.includes('..')) {
    return { ok: false, statusCode: 400, error: errorCode };
  }
  return base;
}

/**
 * Creates a self-contained L1 offline filesystem, Git/Worktree, and Artifacts service.
 */
function createMobileWorkspaceService({
  getAllowedRoots = null,
  allowedRoots = [],
  brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
  maxReadBytes = DEFAULT_MAX_READ_BYTES,
  maxWriteBytes = DEFAULT_MAX_WRITE_BYTES,
  maxDiffBytes = DEFAULT_MAX_DIFF_BYTES,
  worktreeDiscovery = null,
  hasRunningSessionInPath = null
} = {}) {
  const defaultReadLimit = Number.isFinite(Number(maxReadBytes)) && Number(maxReadBytes) >= 0
    ? Math.floor(Number(maxReadBytes))
    : DEFAULT_MAX_READ_BYTES;
  const defaultWriteLimit = Number.isFinite(Number(maxWriteBytes)) && Number(maxWriteBytes) >= 0
    ? Math.floor(Number(maxWriteBytes))
    : DEFAULT_MAX_WRITE_BYTES;
  const defaultDiffLimit = Number.isFinite(Number(maxDiffBytes)) && Number(maxDiffBytes) >= 0
    ? Math.floor(Number(maxDiffBytes))
    : DEFAULT_MAX_DIFF_BYTES;

  function currentAllowedRealRoots() {
    const raw = typeof getAllowedRoots === 'function' ? getAllowedRoots() : allowedRoots;
    return resolveRealRoots(raw);
  }

  function resolveRootOnly(root) {
    if (typeof root !== 'string' || !root || root.includes('\0')) {
      return { ok: false, statusCode: 400, error: 'INVALID_ROOT' };
    }
    const allowedRealRoots = currentAllowedRealRoots();
    if (allowedRealRoots.length === 0) {
      return outsideError();
    }

    let realRoot;
    try {
      realRoot = workspaceOrg.resolveRealPath(root);
    } catch {
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

    return { ok: true, realRoot, allowedRealRoots };
  }

  function resolveRootAndTarget({ root, relPath = '', mustExist = true, forWrite = false }) {
    const rootRes = resolveRootOnly(root);
    if (!rootRes.ok) return rootRes;

    const resolved = resolveWithinBase({
      realBase: rootRes.realRoot,
      allowedRealRoots: rootRes.allowedRealRoots,
      relPath: relPath == null ? '' : relPath,
      mustExist,
      forWrite
    });
    if (!resolved.ok) return resolved;

    return {
      ok: true,
      realRoot: rootRes.realRoot,
      allowedRealRoots: rootRes.allowedRealRoots,
      realTarget: resolved.realTarget,
      exists: resolved.exists,
      lstat: resolved.lstat
    };
  }

  function listRoots() {
    const realRoots = currentAllowedRealRoots();
    const roots = [];
    for (const realRoot of realRoots) {
      try {
        const st = fs.statSync(realRoot);
        if (!st.isDirectory()) continue;
        let isGitRepo = false;
        try {
          isGitRepo = fs.existsSync(path.join(realRoot, '.git'));
        } catch {
          isGitRepo = false;
        }
        roots.push({
          path: realRoot,
          name: path.basename(realRoot) || realRoot,
          isGitRepo
        });
      } catch {
        // Ignore inaccessible roots
      }
    }
    return { ok: true, roots };
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

    let realParent;
    try {
      realParent = workspaceOrg.resolveRealPath(targetDir);
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
        diffText: '',
        truncated: false
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

    let truncated = false;
    const rawDiffBuf = Buffer.from(diffText, 'utf8');
    if (rawDiffBuf.byteLength > defaultDiffLimit) {
      diffText = rawDiffBuf.subarray(0, defaultDiffLimit).toString('utf8');
      truncated = true;
    }

    const files = parseGitFiles(statusRes.ok ? statusRes.stdout : '', numstatOut);
    return {
      ok: true,
      isGitRepo: true,
      branch,
      files,
      diffText,
      truncated
    };
  }

  async function listWorktrees({ root, refresh = false } = {}) {
    const rootRes = resolveRootOnly(root);
    if (!rootRes.ok) return rootRes;

    if (worktreeDiscovery) {
      const snap = await worktreeDiscovery.listWorktrees({
        root: rootRes.realRoot,
        refresh: Boolean(refresh),
        allowedRealRoots: rootRes.allowedRealRoots
      });
      if (!snap.isGitRepo) {
        return { ok: true, isGitRepo: false, worktrees: [] };
      }
      const worktrees = (snap.worktrees || []).map((wt) => ({
        ...wt,
        isCurrent: wt.path === rootRes.realRoot,
        allowed: rootRes.allowedRealRoots.length > 0
          ? rootRes.allowedRealRoots.some((allowed) => isInsideDir(wt.path, allowed))
          : true
      }));
      return { ok: true, isGitRepo: true, worktrees };
    }

    const checkRepo = await runGit(rootRes.realRoot, ['rev-parse', '--is-inside-work-tree']);
    if (!checkRepo.ok || checkRepo.stdout.trim() !== 'true') {
      return { ok: true, isGitRepo: false, worktrees: [] };
    }

    const wtRes = await runGit(rootRes.realRoot, ['worktree', 'list', '--porcelain']);
    if (!wtRes.ok) {
      return { ok: false, statusCode: 500, error: wtRes.stderr || 'GIT_WORKTREE_LIST_FAILED' };
    }

    return {
      ok: true,
      isGitRepo: true,
      worktrees: parseWorktreePorcelain(wtRes.stdout, rootRes.realRoot)
    };
  }

  async function gitStage({ root, paths, unstage = false } = {}) {
    const rootRes = resolveRootOnly(root);
    if (!rootRes.ok) return rootRes;

    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, statusCode: 400, error: 'MISSING_STAGE_PATHS' };
    }

    const safeRelPaths = [];
    for (const p of paths) {
      const argCheck = validateSafeGitArg(p, 'INVALID_PATH');
      if (!argCheck.ok) return argCheck;

      const resolved = resolveWithinBase({
        realBase: rootRes.realRoot,
        allowedRealRoots: rootRes.allowedRealRoots,
        relPath: argCheck.value,
        mustExist: false
      });
      if (!resolved.ok) return resolved;

      const rel = toPosixRel(rootRes.realRoot, resolved.realTarget);
      safeRelPaths.push(rel || '.');
    }

    let gitRes;
    if (unstage) {
      const hasHead = await runGit(rootRes.realRoot, ['rev-parse', '--verify', 'HEAD']);
      if (hasHead.ok) {
        gitRes = await runGit(rootRes.realRoot, ['reset', '-q', 'HEAD', '--', ...safeRelPaths]);
      } else {
        gitRes = await runGit(rootRes.realRoot, ['rm', '--cached', '-r', '-q', '--', ...safeRelPaths]);
      }
    } else {
      gitRes = await runGit(rootRes.realRoot, ['add', '--', ...safeRelPaths]);
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
      paths: safeRelPaths
    };
  }

  async function gitCommit({ root, message } = {}) {
    const rootRes = resolveRootOnly(root);
    if (!rootRes.ok) return rootRes;

    if (typeof message !== 'string' || !message.trim() || message.includes('\0')) {
      return { ok: false, statusCode: 400, error: 'INVALID_COMMIT_MESSAGE' };
    }
    const cleanMsg = message.trim();

    const commitRes = await runGit(rootRes.realRoot, ['commit', '-m', cleanMsg]);
    if (!commitRes.ok) {
      return {
        ok: false,
        statusCode: 400,
        error: (commitRes.stderr || commitRes.stdout || 'GIT_COMMIT_FAILED').trim()
      };
    }

    const [shaRes, branchRes] = await Promise.all([
      runGit(rootRes.realRoot, ['rev-parse', 'HEAD']),
      runGit(rootRes.realRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    ]);

    return {
      ok: true,
      commitSha: shaRes.ok ? shaRes.stdout.trim() : '',
      branch: branchRes.ok ? branchRes.stdout.trim() : '',
      message: cleanMsg,
      stdout: commitRes.stdout.trim()
    };
  }

  async function gitPush({ root, remote, branch } = {}) {
    const rootRes = resolveRootOnly(root);
    if (!rootRes.ok) return rootRes;

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

    if (cleanRemote) {
      args.push(cleanRemote);
    } else if (cleanBranch) {
      cleanRemote = 'origin';
      args.push(cleanRemote);
    }
    if (cleanBranch) {
      args.push(cleanBranch);
    }

    const pushRes = await runGit(rootRes.realRoot, args);
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

  function resolveWorktreePath(rootRes, rawPath, { action = 'add', branch = '' } = {}) {
    const argCheck = validateSafeGitArg(rawPath, 'INVALID_WORKTREE_PATH');
    if (!argCheck.ok) return argCheck;

    const candidate = path.resolve(rootRes.realRoot, argCheck.value);
    try {
      const lstat = fs.lstatSync(candidate);
      if (lstat) {
        const realExisting = workspaceOrg.resolveRealPath(candidate);
        if (rootRes.allowedRealRoots.some((allowed) => isInsideDir(realExisting, allowed))) {
          return { ok: true, targetPath: realExisting };
        }
        if (action === 'add' && workspaceOrg.isSafeSiblingWorktreeTarget(rootRes.realRoot, realExisting, { branch })) {
          return { ok: true, targetPath: realExisting, isSibling: true };
        }
        return outsideError();
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        return outsideError();
      }
    }

    const ancestor = findDeepestExistingAncestor(candidate);
    let realAncestor;
    try {
      realAncestor = workspaceOrg.resolveRealPath(ancestor);
    } catch {
      return outsideError();
    }
    const target = path.join(realAncestor, path.relative(ancestor, candidate));
    const isAllowedAncestor = rootRes.allowedRealRoots.some((allowed) => isInsideDir(realAncestor, allowed));
    const isAllowedTarget = rootRes.allowedRealRoots.some((allowed) => isInsideDir(target, allowed));
    if (!isAllowedAncestor || !isAllowedTarget) {
      if (action === 'add' && workspaceOrg.isSafeSiblingWorktreeTarget(rootRes.realRoot, target, { branch })) {
        return { ok: true, targetPath: target, isSibling: true };
      }
      return outsideError();
    }
    return { ok: true, targetPath: target };
  }

  async function gitWorktree({ root, action, path: wtPath, branch, createBranch = false } = {}) {
    const rootRes = resolveRootOnly(root);
    if (!rootRes.ok) return rootRes;

    const rawAct = typeof action === 'string' ? action.trim().toLowerCase() : '';
    const act = rawAct === 'create' ? 'add' : rawAct;
    if (act === 'list') {
      return listWorktrees({ root: rootRes.realRoot });
    }
    if (act === 'prune') {
      const pruneRes = await runGit(rootRes.realRoot, ['worktree', 'prune']);
      if (!pruneRes.ok) {
        return { ok: false, statusCode: 400, error: (pruneRes.stderr || 'GIT_WORKTREE_PRUNE_FAILED').trim() };
      }
      const listed = await listWorktrees({ root: rootRes.realRoot, refresh: true });
      if (worktreeDiscovery && listed.ok) {
        worktreeDiscovery.invalidate(rootRes.realRoot, { action: 'prune', worktrees: listed.worktrees || [] });
      }
      return listed.ok ? { ...listed, action: 'prune' } : listed;
    }

    if (act !== 'add' && act !== 'remove') {
      return { ok: false, statusCode: 400, error: 'INVALID_WORKTREE_ACTION' };
    }

    let cleanBranch = '';
    if (branch !== undefined && branch !== null && branch !== '') {
      const brCheck = validateSafeRefToken(branch, 'INVALID_GIT_BRANCH');
      if (!brCheck.ok) return brCheck;
      cleanBranch = brCheck.value;
    }

    const targetCheck = resolveWorktreePath(rootRes, wtPath, { action: act, branch: cleanBranch });
    if (!targetCheck.ok) return targetCheck;

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
      if (targetCheck.targetPath === rootRes.realRoot) {
        return { ok: false, statusCode: 400, error: 'CANNOT_REMOVE_MAIN_WORKTREE' };
      }
      const beforeList = await listWorktrees({ root: rootRes.realRoot, refresh: true });
      const matchingWt = beforeList.ok && Array.isArray(beforeList.worktrees)
        ? beforeList.worktrees.find((w) => w.path === targetCheck.targetPath)
        : null;
      if (matchingWt?.locked) {
        return { ok: false, statusCode: 409, error: 'WORKTREE_LOCKED' };
      }
      if (typeof hasRunningSessionInPath === 'function' && await hasRunningSessionInPath(targetCheck.targetPath)) {
        return { ok: false, statusCode: 409, error: 'WORKTREE_HAS_RUNNING_SESSION' };
      }
      gitArgs = ['worktree', 'remove', targetCheck.targetPath];
    }

    const wtRes = await runGit(rootRes.realRoot, gitArgs);
    if (!wtRes.ok) {
      return {
        ok: false,
        statusCode: 400,
        error: (wtRes.stderr || wtRes.stdout || 'GIT_WORKTREE_FAILED').trim()
      };
    }

    const listed = await listWorktrees({ root: rootRes.realRoot, refresh: true });
    if (worktreeDiscovery && listed.ok) {
      worktreeDiscovery.invalidate(rootRes.realRoot, { action: act, worktrees: listed.worktrees || [] });
    }
    if (listed.ok && act === 'add' && Array.isArray(listed.worktrees)) {
      for (const wt of listed.worktrees) {
        if (wt.path === targetCheck.targetPath) {
          wt.allowed = true;
        }
      }
    }
    return listed.ok ? { ...listed, action: act, targetPath: targetCheck.targetPath } : listed;
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
      realBrainDir = workspaceOrg.resolveRealPath(brainDir);
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
        realItem = workspaceOrg.resolveRealPath(fullPath);
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

  function readArtifact(sessionId, fileName, { binary = false } = {}) {
    const session = validateSessionDir(sessionId);
    if (!session.ok) return session;

    if (typeof fileName !== 'string' || !fileName || fileName.includes('\0')) {
      return outsideError();
    }
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

    const readRes = readBoundedFile(resolvedFile.realTarget, defaultReadLimit, { binary: Boolean(binary) });
    if (!readRes.ok) return readRes;

    const relName = toPosixRel(session.realSessionDir, resolvedFile.realTarget);
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

  return {
    listRoots,
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
    readArtifact
  };
}

module.exports = {
  createMobileWorkspaceService
};
