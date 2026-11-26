'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  canonicalizePath,
  canonicalKey,
  isForbiddenSystemRoot,
  isSameOrInside,
  isTempBridgeWorkspace,
  makeWorktreeId,
  normalizeLocalPath,
  pathToFileUri
} = require('./path-canonicalizer');

const DEFAULT_CACHE_TTL_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_CONCURRENCY = 4;

function computeDisplaySubpath(wtPath, repoMainPath, isMain, isBare) {
  if (isMain && !isBare) return 'Main';
  if (!repoMainPath) return path.basename(wtPath) || wtPath;
  if (isSameOrInside(wtPath, repoMainPath)) {
    const rel = path.relative(repoMainPath, wtPath).split(path.sep).join('/');
    return rel || 'Main';
  }
  const repoParentKey = canonicalKey(path.dirname(repoMainPath));
  const wtParentKey = canonicalKey(path.dirname(wtPath));
  if (repoParentKey && repoParentKey === wtParentKey) {
    return `../${path.basename(wtPath)}`;
  }
  return path.basename(wtPath) || wtPath;
}

function deriveWorktreeStatus({ bare, exists, prunable, locked, detached }) {
  if (bare) return 'bare';
  if (!exists || prunable) return 'missing';
  if (locked) return 'locked';
  if (detached) return 'detached';
  return 'ready';
}

function buildWorktreeDto(rawItem, {
  repoMainPath = '',
  currentRealRoot = '',
  isMain = false,
  allowedRealRoots = null,
  collapsedWorktrees = null
} = {}) {
  const canonPath = canonicalizePath(rawItem.path) || normalizeLocalPath(rawItem.path);
  const canonKey = canonicalKey(canonPath);
  const worktreeId = makeWorktreeId(canonPath);
  let exists = false;
  try {
    exists = Boolean(canonPath && fs.existsSync(canonPath));
  } catch {
    exists = false;
  }
  const bare = Boolean(rawItem.bare);
  const prunable = Boolean(rawItem.prunable) || !exists;
  const locked = Boolean(rawItem.locked);
  const detached = Boolean(rawItem.detached);
  const head = String(rawItem.head || '').trim();
  const headShort = head ? head.slice(0, 7) : '';
  const branch = String(rawItem.branch || '').trim();
  const status = deriveWorktreeStatus({ bare, exists, prunable, locked, detached });
  const displayLabel = bare
    ? 'bare'
    : (detached ? `detached @ ${headShort || 'HEAD'}` : (branch || path.basename(canonPath) || canonPath));
  const displaySubpath = computeDisplaySubpath(canonPath, repoMainPath, isMain, bare);
  const forbidden = isForbiddenSystemRoot(canonPath);
  let allowed = !bare && exists && !forbidden;
  if (allowed && Array.isArray(allowedRealRoots) && allowedRealRoots.length > 0) {
    allowed = allowedRealRoots.some((r) => isSameOrInside(canonPath, r));
  }
  const isCurrent = Boolean(currentRealRoot && canonKey && canonKey === canonicalKey(currentRealRoot));
  const collapsed = Boolean(collapsedWorktrees && collapsedWorktrees[worktreeId]);

  return {
    worktreeId,
    path: canonPath,
    canonicalKey: canonKey,
    uri: pathToFileUri(canonPath) || '',
    displaySubpath,
    head,
    headShort,
    branch,
    displayLabel,
    isMain,
    bare,
    detached,
    locked,
    prunable,
    exists,
    status,
    collapsed,
    allowed,
    isCurrent
  };
}

/**
 * Parses `git worktree list --porcelain` stdout into normalized `WorktreeDto` entries.
 */
function parseWorktreePorcelain(stdout, currentRealRoot = null, opts = {}) {
  const rawEntries = [];
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
      prunable: false
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
      rawEntries.push(item);
    }
  }
  if (rawEntries.length === 0) return [];
  const repoMainPath = canonicalizePath(rawEntries[0].path) || normalizeLocalPath(rawEntries[0].path);
  return rawEntries.map((entry, idx) => buildWorktreeDto(entry, {
    repoMainPath,
    currentRealRoot: currentRealRoot ? canonicalizePath(currentRealRoot) : '',
    isMain: idx === 0,
    allowedRealRoots: opts.allowedRealRoots || null,
    collapsedWorktrees: opts.collapsedWorktrees || null
  }));
}

function execGitAsync(cwd, args, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    let child = null;

    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(res);
    };

    try {
      child = spawn('git', ['-C', cwd, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0'
        }
      });
    } catch (err) {
      finish({ ok: false, stdout: '', stderr: err?.message || String(err), timedOut: false });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, stdout, stderr: 'GIT_TIMEOUT', timedOut: true });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      finish({ ok: false, stdout, stderr: err?.message || String(err), timedOut: false });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr, timedOut: false });
    });
  });
}

function readGitdirLinkSync(dirPath) {
  try {
    const dotGit = path.join(dirPath, '.git');
    const st = fs.lstatSync(dotGit);
    if (st.isDirectory()) return dotGit;
    if (st.isFile()) {
      const content = fs.readFileSync(dotGit, 'utf8');
      const m = content.match(/^gitdir:\s*(.+)$/m);
      if (m && m[1]) {
        return path.resolve(dirPath, m[1].trim());
      }
    }
  } catch {}
  return null;
}

/**
 * Lightweight cold-cache topology fallback using `.git/worktrees/<name>/gitdir` without
 * spawning `git`, so synchronous `getAuthorizedWorktreeRoots()` still recognizes
 * same-repo linked worktrees even before async discovery completes.
 */
function probeColdWorktreePathsSync(seedPath) {
  const canon = canonicalizePath(seedPath);
  if (!canon || isForbiddenSystemRoot(canon)) return [];
  const gitdir = readGitdirLinkSync(canon);
  if (!gitdir) return [];

  let commonGitDir = gitdir;
  const commondirFile = path.join(gitdir, 'commondir');
  try {
    if (fs.existsSync(commondirFile)) {
      const rel = fs.readFileSync(commondirFile, 'utf8').trim();
      if (rel) commonGitDir = path.resolve(gitdir, rel);
    }
  } catch {}

  const discovered = new Set();
  const mainCandidate = path.basename(commonGitDir) === '.git' ? path.dirname(commonGitDir) : null;
  if (mainCandidate && fs.existsSync(mainCandidate) && !isForbiddenSystemRoot(mainCandidate)) {
    discovered.add(canonicalizePath(mainCandidate));
  }
  if (fs.existsSync(canon)) {
    discovered.add(canon);
  }

  const worktreesMetaDir = path.join(commonGitDir, 'worktrees');
  try {
    if (fs.existsSync(worktreesMetaDir)) {
      for (const ent of fs.readdirSync(worktreesMetaDir, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const gitdirPtr = path.join(worktreesMetaDir, ent.name, 'gitdir');
        try {
          const targetDotGit = fs.readFileSync(gitdirPtr, 'utf8').trim();
          const wtDir = path.dirname(path.resolve(path.dirname(gitdirPtr), targetDotGit));
          if (fs.existsSync(wtDir) && !isForbiddenSystemRoot(wtDir)) {
            discovered.add(canonicalizePath(wtDir));
          }
        } catch {}
      }
    }
  } catch {}

  return Array.from(discovered);
}

/**
 * Deterministic ordering for Worktree subgroups within an aggregated multi-worktree project:
 *   1. Non-bare main worktree first
 *   2. Active/ready/detached/locked worktrees with running/needsAttention sessions
 *   3. Other non-missing worktrees sorted by branch/displaySubpath
 *   4. Missing/prunable worktrees last (bare last or metadata)
 */
function sortWorktreeSubgroups(worktrees = [], runtimeStatsById = null) {
  return [...worktrees].sort((a, b) => {
    const aMissing = a.status === 'missing' ? 1 : 0;
    const bMissing = b.status === 'missing' ? 1 : 0;
    if (aMissing !== bMissing) return aMissing - bMissing;

    const aBare = a.bare ? 1 : 0;
    const bBare = b.bare ? 1 : 0;
    if (aBare !== bBare) return aBare - bBare;

    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;

    const statusRank = (s) => (s === 'ready' ? 0 : (s === 'detached' ? 1 : (s === 'locked' ? 2 : 3)));
    const srDiff = statusRank(a.status) - statusRank(b.status);
    if (srDiff !== 0) return srDiff;

    if (runtimeStatsById) {
      const sa = runtimeStatsById.get(a.worktreeId);
      const sb = runtimeStatsById.get(b.worktreeId);
      const aHot = (sa?.runningCount || 0) > 0 || (sa?.needsAttentionCount || 0) > 0 ? 1 : 0;
      const bHot = (sb?.runningCount || 0) > 0 || (sb?.needsAttentionCount || 0) > 0 ? 1 : 0;
      if (aHot !== bHot) return bHot - aHot;
    }

    const la = (a.branch || a.displaySubpath || a.path || '').toLowerCase();
    const lb = (b.branch || b.displaySubpath || b.path || '').toLowerCase();
    const cmp = la.localeCompare(lb);
    if (cmp !== 0) return cmp;
    return (a.canonicalKey || '').localeCompare(b.canonicalKey || '');
  });
}

function sanitizeBranchSlug(branch) {
  return String(branch || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isSafeSiblingWorktreeTarget(repoRealRoot, candidatePath, opts = {}) {
  const repoCanon = canonicalizePath(repoRealRoot);
  const candCanon = canonicalizePath(candidatePath);
  if (!repoCanon || !candCanon) return false;

  const repoParent = canonicalizePath(path.dirname(repoCanon));
  const candParent = canonicalizePath(path.dirname(candCanon));
  if (!repoParent || !candParent || isForbiddenSystemRoot(candParent)) return false;
  if (canonicalKey(repoParent) !== canonicalKey(candParent)) return false;

  const repoBase = path.basename(repoCanon);
  const candBase = path.basename(candCanon);
  if (!repoBase || !candBase) return false;
  const branchSlug = sanitizeBranchSlug(opts?.branch);
  if (branchSlug) {
    const dashPrefix = `${repoBase}-${branchSlug}`;
    const dotPrefix = `${repoBase}.${branchSlug}`;
    const exactOrSuffix = candBase === dashPrefix
      || candBase === dotPrefix
      || candBase.startsWith(`${dashPrefix}-`)
      || candBase.startsWith(`${dotPrefix}-`);
    if (!exactOrSuffix) return false;
  } else if (!candBase.startsWith(`${repoBase}-`) && !candBase.startsWith(`${repoBase}.`)) {
    return false;
  }

  try {
    if (fs.existsSync(candCanon)) {
      const st = fs.statSync(candCanon);
      if (!st.isDirectory()) return false;
      const entries = fs.readdirSync(candCanon);
      if (entries.length > 0) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function createWorktreeDiscoveryService({
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY,
  now = () => Date.now()
} = {}) {
  const emitter = new EventEmitter();
  const repoCache = new Map(); // repoKey -> { repoRoot, isGitRepo, worktrees, updatedAt }
  const pathToRepoKey = new Map(); // any worktree canonicalKey -> repoKey
  const inflight = new Map(); // canonicalKey -> Promise

  let activeCount = 0;
  const waitQueue = [];

  async function withConcurrency(fn) {
    if (activeCount >= maxConcurrency) {
      await new Promise((resolve) => waitQueue.push(resolve));
    }
    activeCount += 1;
    try {
      return await fn();
    } finally {
      activeCount -= 1;
      const next = waitQueue.shift();
      if (next) next();
    }
  }

  function getCachedSnapshot(rawPath) {
    const canon = canonicalizePath(rawPath) || normalizeLocalPath(rawPath);
    const key = canonicalKey(canon);
    if (!key) return null;
    const repoKey = pathToRepoKey.get(key) || key;
    const entry = repoCache.get(repoKey);
    return entry || null;
  }

  function getCachedWorktrees(rawPath) {
    const snap = getCachedSnapshot(rawPath);
    return snap ? snap.worktrees : null;
  }

  function storeSnapshot(queryKey, snapshot) {
    const repoKey = canonicalKey(snapshot.repoRoot);
    repoCache.set(repoKey, snapshot);
    pathToRepoKey.set(queryKey, repoKey);
    for (const wt of snapshot.worktrees) {
      if (wt.canonicalKey) {
        pathToRepoKey.set(wt.canonicalKey, repoKey);
      }
    }
  }

  async function probeRepository(rawRoot, { refresh = false } = {}) {
    const canon = canonicalizePath(rawRoot) || normalizeLocalPath(rawRoot);
    const key = canonicalKey(canon);
    if (!canon || !key || isForbiddenSystemRoot(canon) || isTempBridgeWorkspace(canon)) {
      return { ok: true, isGitRepo: false, repoRoot: canon, isMultiWorktree: false, worktrees: [] };
    }

    const existing = getCachedSnapshot(canon);
    if (!refresh && existing && (now() - existing.updatedAt) < cacheTtlMs) {
      return {
        ok: true,
        isGitRepo: existing.isGitRepo,
        repoRoot: existing.repoRoot,
        isMultiWorktree: existing.worktrees.length >= 2 || (existing.worktrees.length === 1 && existing.worktrees[0].bare),
        worktrees: existing.worktrees.map((w) => ({ ...w }))
      };
    }

    if (!refresh && inflight.has(key)) {
      return inflight.get(key);
    }

    const promise = withConcurrency(async () => {
      if (!fs.existsSync(canon)) {
        return { ok: true, isGitRepo: false, repoRoot: canon, isMultiWorktree: false, worktrees: [] };
      }

      const res = await execGitAsync(canon, ['worktree', 'list', '--porcelain'], commandTimeoutMs);
      if (!res.ok) {
        if (res.timedOut && existing) {
          return {
            ok: true,
            isGitRepo: existing.isGitRepo,
            repoRoot: existing.repoRoot,
            isMultiWorktree: existing.worktrees.length >= 2 || (existing.worktrees.length === 1 && existing.worktrees[0].bare),
            worktrees: existing.worktrees.map((w) => ({ ...w })),
            stale: true
          };
        }
        const snap = {
          repoRoot: canon,
          isGitRepo: false,
          worktrees: [],
          updatedAt: now()
        };
        storeSnapshot(key, snap);
        return { ok: true, isGitRepo: false, repoRoot: canon, isMultiWorktree: false, worktrees: [] };
      }

      const worktrees = parseWorktreePorcelain(res.stdout, canon);
      const repoRoot = worktrees[0]?.path || canon;
      const snap = {
        repoRoot,
        isGitRepo: true,
        worktrees,
        updatedAt: now()
      };
      const prevDigest = existing ? JSON.stringify(existing.worktrees) : '';
      storeSnapshot(key, snap);
      const nextDigest = JSON.stringify(worktrees);
      if (existing && prevDigest !== nextDigest) {
        emitter.emit('worktree.updated', {
          repoRootPath: repoRoot,
          action: 'refresh',
          isMultiWorktree: worktrees.length >= 2 || (worktrees.length === 1 && worktrees[0].bare),
          worktrees: worktrees.map((w) => ({ ...w })),
          updatedAt: new Date().toISOString()
        });
      }
      return {
        ok: true,
        isGitRepo: true,
        repoRoot,
        isMultiWorktree: worktrees.length >= 2 || (worktrees.length === 1 && worktrees[0].bare),
        worktrees: worktrees.map((w) => ({ ...w }))
      };
    }).finally(() => {
      inflight.delete(key);
    });

    inflight.set(key, promise);
    return promise;
  }

  async function listWorktrees({ root, refresh = false, collapsedWorktrees = null, allowedRealRoots = null } = {}) {
    const res = await probeRepository(root, { refresh });
    if (!res.ok) return res;
    const canonCurrent = canonicalizePath(root) || normalizeLocalPath(root);
    const curKey = canonicalKey(canonCurrent);
    const worktrees = (res.worktrees || []).map((wt) => {
      const next = {
        ...wt,
        isCurrent: Boolean(curKey && wt.canonicalKey === curKey),
        collapsed: Boolean(collapsedWorktrees && collapsedWorktrees[wt.worktreeId])
      };
      if (Array.isArray(allowedRealRoots) && allowedRealRoots.length > 0) {
        next.allowed = next.allowed && allowedRealRoots.some((r) => isSameOrInside(wt.path, r));
      }
      return next;
    });
    const currentWt = worktrees.find((w) => w.isCurrent);
    return {
      ok: true,
      isGitRepo: res.isGitRepo,
      repoRoot: res.repoRoot,
      isMultiWorktree: res.isMultiWorktree,
      current: currentWt ? currentWt.path : canonCurrent,
      worktrees
    };
  }

  async function warmRoots(roots = [], { refresh = false, softTimeoutMs = 150 } = {}) {
    const targets = [];
    const seen = new Set();
    for (const raw of (Array.isArray(roots) ? roots : [])) {
      const canon = canonicalizePath(raw) || normalizeLocalPath(raw);
      const key = canonicalKey(canon);
      if (!canon || !key || seen.has(key) || isForbiddenSystemRoot(canon) || isTempBridgeWorkspace(canon)) continue;
      seen.add(key);
      if (!refresh) {
        const cached = getCachedSnapshot(canon);
        if (cached && (now() - cached.updatedAt) < cacheTtlMs) continue;
      }
      targets.push(canon);
    }
    if (targets.length === 0) return;

    const allPromise = Promise.allSettled(targets.map((t) => probeRepository(t, { refresh })));
    if (refresh || !Number.isFinite(Number(softTimeoutMs)) || softTimeoutMs <= 0) {
      await allPromise;
      return;
    }
    await Promise.race([
      allPromise,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, softTimeoutMs);
        timer.unref?.();
      })
    ]);
  }

  function invalidate(rawPath, { action = 'refresh', worktrees = null } = {}) {
    const canon = canonicalizePath(rawPath) || normalizeLocalPath(rawPath);
    const key = canonicalKey(canon);
    if (!key) return;
    const repoKey = pathToRepoKey.get(key) || key;
    const prev = repoCache.get(repoKey);
    repoCache.delete(repoKey);
    if (prev) {
      for (const wt of prev.worktrees) {
        pathToRepoKey.delete(wt.canonicalKey);
      }
    }
    if (Array.isArray(worktrees)) {
      const repoRoot = worktrees[0]?.path || prev?.repoRoot || canon;
      const newRepoKey = canonicalKey(repoRoot) || repoKey;
      const normalizedWts = worktrees.map((w) => ({ ...w }));
      if (normalizedWts.length > 0) {
        const snap = {
          repoRoot,
          repoKey: newRepoKey,
          isGitRepo: true,
          worktrees: normalizedWts,
          updatedAt: now()
        };
        repoCache.set(newRepoKey, snap);
        for (const wt of normalizedWts) {
          const wtKey = wt.canonicalKey || canonicalKey(wt.path);
          if (wtKey) pathToRepoKey.set(wtKey, newRepoKey);
        }
      }
      emitter.emit('worktree.updated', {
        repoRootPath: repoRoot,
        action,
        isMultiWorktree: normalizedWts.length >= 2 || (normalizedWts.length === 1 && normalizedWts[0].bare),
        worktrees: normalizedWts,
        updatedAt: new Date().toISOString()
      });
    }
  }

  function getAuthorizedWorktreeRoots(seedRoots = []) {
    const out = [];
    const seen = new Set();
    const pushSafe = (p) => {
      const canon = canonicalizePath(p) || normalizeLocalPath(p);
      const key = canonicalKey(canon);
      if (!canon || !key || seen.has(key) || isForbiddenSystemRoot(canon) || isTempBridgeWorkspace(canon)) return;
      try {
        if (!fs.existsSync(canon)) return;
      } catch {
        return;
      }
      seen.add(key);
      out.push(canon);
    };

    for (const rawSeed of (Array.isArray(seedRoots) ? seedRoots : [])) {
      const canonSeed = canonicalizePath(rawSeed) || normalizeLocalPath(rawSeed);
      if (!canonSeed || isForbiddenSystemRoot(canonSeed) || isTempBridgeWorkspace(canonSeed)) continue;
      pushSafe(canonSeed);
      const cached = getCachedSnapshot(canonSeed);
      if (cached && cached.isGitRepo) {
        for (const wt of cached.worktrees) {
          if (!wt.bare && wt.exists && !isForbiddenSystemRoot(wt.path)) {
            pushSafe(wt.path);
          }
        }
      } else {
        for (const coldPath of probeColdWorktreePathsSync(canonSeed)) {
          pushSafe(coldPath);
        }
      }
    }
    return out;
  }

  function getAllKnownWorktrees() {
    const byId = new Map();
    for (const snap of repoCache.values()) {
      for (const wt of (snap.worktrees || [])) {
        if (wt.worktreeId && !byId.has(wt.worktreeId)) {
          byId.set(wt.worktreeId, wt);
        }
      }
    }
    return Array.from(byId.values());
  }

  function onWorktreeUpdated(fn) {
    if (typeof fn !== 'function') return () => {};
    emitter.on('worktree.updated', fn);
    return () => emitter.off('worktree.updated', fn);
  }

  return {
    parseWorktreePorcelain,
    probeRepository,
    listWorktrees,
    warmRoots,
    invalidate,
    getCachedSnapshot,
    getCachedWorktrees,
    getAuthorizedWorktreeRoots,
    getAllKnownWorktrees,
    isSafeSiblingWorktreeTarget,
    sortWorktreeSubgroups,
    onWorktreeUpdated
  };
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENCY,
  buildWorktreeDto,
  parseWorktreePorcelain,
  sortWorktreeSubgroups,
  isSafeSiblingWorktreeTarget,
  createWorktreeDiscoveryService
};
