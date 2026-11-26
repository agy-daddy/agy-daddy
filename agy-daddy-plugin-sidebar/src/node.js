'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PLUGIN_ID = 'agy-daddy.sidebar';
const GIT_MUTATE_TIMEOUT_MS = 10_000;
const DEFAULT_METADATA = Object.freeze({
  ideName: 'antigravity',
  apiKey: '',
  locale: 'zh-CN',
  ideVersion: '2.33.0',
  extensionName: 'antigravity'
});
const RUNNING_STATUS_RE = /RUNNING|GENERATING/i;
const ATTENTION_STATUS_RE = /PENDING|WAITING|ERROR/i;

let activeRuntime = null;

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

/**
 * Resolves the shared workspace-org core from host injection, AGY_DADDY_HOST_DIR, or monorepo root.
 */
function resolveWorkspaceOrg(host) {
  if (host && host.workspaceOrg) {
    return host.workspaceOrg;
  }
  if (process.env.AGY_DADDY_HOST_DIR) {
    try {
      return require(path.join(process.env.AGY_DADDY_HOST_DIR, 'src', 'core', 'workspace-org'));
    } catch {
      // Fallback to monorepo path
    }
  }
  return require(path.resolve(__dirname, '..', '..', 'agy-daddy-host', 'src', 'core', 'workspace-org'));
}

function validateSafeGitArg(raw, errorCode = 'INVALID_GIT_ARG') {
  if (typeof raw !== 'string') {
    return { ok: false, statusCode: 400, error: errorCode };
  }
  const value = raw.trim();
  if (!value || value.startsWith('-') || value.includes('\0') || /[\r\n]/.test(value)) {
    return { ok: false, statusCode: 400, error: errorCode };
  }
  return { ok: true, value };
}

function validateSafeRefToken(raw, errorCode = 'INVALID_GIT_BRANCH') {
  const base = validateSafeGitArg(raw, errorCode);
  if (!base.ok) return base;
  const v = base.value;
  if (
    v.startsWith('/')
    || v.endsWith('/')
    || v.endsWith('.')
    || v.includes('..')
    || v.includes('@{')
    || v.includes('//')
    || v.endsWith('.lock')
    || /[\s~^:?*\[\\]/.test(v)
  ) {
    return { ok: false, statusCode: 400, error: errorCode };
  }
  return { ok: true, value: v };
}

function runGitAsync(cwd, args, timeoutMs = GIT_MUTATE_TIMEOUT_MS) {
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
      finish({ ok: false, stdout: '', stderr: err?.message || String(err) });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish({ ok: false, stdout, stderr: 'GIT_TIMEOUT' });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (c) => { stdout += String(c); });
    child.stderr?.on('data', (c) => { stderr += String(c); });
    child.on('error', (err) => finish({ ok: false, stdout, stderr: err?.message || String(err) }));
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}

function findAntigravityExecutable(env = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    const candidates = [
      env.AGY_DADDY_ANTIGRAVITY_APP,
      '/Applications/Antigravity.app',
      path.join(os.homedir(), 'Applications', 'Antigravity.app')
    ].filter(Boolean);
    for (const cand of candidates) {
      try {
        if (fs.existsSync(cand)) return cand;
      } catch {}
    }
    return '/Applications/Antigravity.app';
  }
  if (platform === 'win32') {
    if (env.AGY_DADDY_ANTIGRAVITY_EXE) return env.AGY_DADDY_ANTIGRAVITY_EXE;
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const candidates = [
      path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'),
      'C:\\Program Files\\Antigravity\\Antigravity.exe'
    ];
    for (const cand of candidates) {
      try {
        if (fs.existsSync(cand)) return cand;
      } catch {}
    }
    return candidates[0];
  }
  return env.AGY_DADDY_ANTIGRAVITY_BIN || 'antigravity';
}

function normalizeSessionSummary(cascadeId, raw) {
  const item = isPlainObject(raw) ? raw : {};
  const workspaces = Array.isArray(item.workspaces) ? item.workspaces : [];
  const firstWs = workspaces.find((w) => isPlainObject(w) && (w.workspaceFolderAbsoluteUri || w.workspaceUri)) || null;
  const workspaceUri = (typeof item.workspaceUri === 'string' && item.workspaceUri.trim())
    ? item.workspaceUri.trim()
    : (firstWs?.workspaceFolderAbsoluteUri || firstWs?.workspaceUri || '');
  const status = String(item.status || 'CASCADE_RUN_STATUS_IDLE');
  const notFullyIdle = Boolean(item.notFullyIdle);
  const isRunning = Boolean(item.isRunning || RUNNING_STATUS_RE.test(status) || notFullyIdle);
  const needsAttention = Boolean(item.needsAttention || ATTENTION_STATUS_RE.test(status));

  return {
    cascadeId: String(cascadeId || item.cascadeId || item.id || '').trim(),
    title: String(item.title || item.summary || '').trim(),
    summary: String(item.summary || item.title || '').trim(),
    status,
    notFullyIdle,
    isRunning,
    needsAttention,
    stepCount: Number.isFinite(Number(item.stepCount)) ? Number(item.stepCount) : 0,
    createdTime: item.createdTime || null,
    lastModifiedTime: item.lastModifiedTime || item.createdTime || null,
    workspaceUri: workspaceUri || null,
    workspaces,
    repoName: item.repoName || firstWs?.repository?.computedName || null,
    branchName: item.branchName || firstWs?.branchName || null,
    parentConversationId: item.parentConversationId || null,
    nestingDepth: Number.isFinite(Number(item.nestingDepth)) ? Number(item.nestingDepth) : 0,
    agentName: item.agentName || null,
    isSubagent: Boolean(item.isSubagent)
  };
}

async function activate(host) {
  if (activeRuntime) {
    await deactivate();
  }

  const workspaceOrg = resolveWorkspaceOrg(host);
  const worktreeDiscovery = host?.workspaceOrg?.worktreeDiscovery
    || workspaceOrg.createWorktreeDiscoveryService();

  let latestSessions = [];
  let cachedHostWindowWorkspace = null;
  const disposers = [];

  function emitOrgState(summary) {
    if (typeof host?.state?.set === 'function') {
      host.state.set('state:session.org@1', summary);
    }
    if (typeof host?.events?.emit === 'function') {
      host.events.emit('sidebar:org-updated@1', summary);
    }
  }

  const sessionOrgCore = workspaceOrg.createSessionOrgCore({
    pluginId: PLUGIN_ID,
    worktreeDiscovery,
    onOrgChanged: (_org, summary) => emitOrgState(summary),
    onExternalOrgChanged: (_org, summary) => {
      if (typeof host?.events?.emit === 'function') {
        host.events.emit('sidebar:org-updated@1', summary);
      }
    }
  });

  if (typeof host?.state?.subscribe === 'function') {
    const stopStateSub = host.state.subscribe('state:session.org@1', (val, meta) => {
      if (meta?.publisher === PLUGIN_ID) return;
      sessionOrgCore.syncFromExternalSignal(val);
    });
    if (typeof stopStateSub === 'function') disposers.push(stopStateSub);
  }

  if (typeof worktreeDiscovery?.onWorktreeUpdated === 'function') {
    const stopWtSub = worktreeDiscovery.onWorktreeUpdated((payload) => {
      if (typeof host?.events?.emit === 'function') {
        host.events.emit('sidebar:worktree-updated@1', payload);
      }
    });
    if (typeof stopWtSub === 'function') disposers.push(stopWtSub);
  }

  async function fetchRpcSessions() {
    if (!host?.rpc || typeof host.rpc.call !== 'function') {
      return { rpcAvailable: false, sessions: [] };
    }
    try {
      const resp = await host.rpc.call('GetAllCascadeTrajectories', {});
      const summaries = isPlainObject(resp?.trajectorySummaries) ? resp.trajectorySummaries : {};
      const sessions = Object.entries(summaries)
        .map(([cid, item]) => normalizeSessionSummary(cid, item))
        .filter((s) => Boolean(s.cascadeId));
      latestSessions = sessions;
      return { rpcAvailable: true, sessions };
    } catch {
      return { rpcAvailable: false, sessions: [] };
    }
  }

  function collectAllowedRoots(persistedOrg, rpcSessions = []) {
    const seeds = [];
    const seen = new Set();
    const pushSeed = (raw) => {
      const norm = workspaceOrg.normalizeLocalPath(raw);
      if (!norm || workspaceOrg.isForbiddenSystemRoot(norm)) return;
      const key = workspaceOrg.canonicalKey(norm);
      if (!key || seen.has(key)) return;
      seen.add(key);
      seeds.push(norm);
    };

    if (persistedOrg?.defaultSessionPath) pushSeed(persistedOrg.defaultSessionPath);
    for (const proj of (persistedOrg?.projects || [])) {
      pushSeed(proj.rootPath || proj.uri);
    }
    for (const s of (Array.isArray(rpcSessions) ? rpcSessions : [])) {
      if (s?.workspaceUri) pushSeed(s.workspaceUri);
      if (Array.isArray(s?.workspaces)) {
        for (const ws of s.workspaces) {
          pushSeed(ws?.workspaceFolderAbsoluteUri || ws?.workspaceUri);
        }
      }
    }
    return worktreeDiscovery.getAuthorizedWorktreeRoots(seeds);
  }

  async function getPcWebUrl() {
    if (!host?.services?.has?.('web-harness')) return null;
    try {
      const status = await host.services.call('web-harness', 'getStatus', []);
      if (status?.running) {
        return status.primaryUrl || status.url || null;
      }
    } catch {
      // Optional service unavailable
    }
    return null;
  }

  async function buildBootstrapPayload(body = {}) {
    const includeArchived = Boolean(body.includeArchived);
    const refreshWorktrees = Boolean(body.refreshWorktrees);
    const rpcRes = await fetchRpcSessions();
    const persisted = sessionOrgCore.loadPersistedOrg();
    const seedRoots = [];
    for (const p of (persisted.projects || [])) {
      if (p.rootPath) seedRoots.push(p.rootPath);
    }
    for (const s of rpcRes.sessions) {
      if (s.workspaceUri) seedRoots.push(s.workspaceUri);
    }

    await worktreeDiscovery.warmRoots(seedRoots, {
      refresh: refreshWorktrees,
      softTimeoutMs: refreshWorktrees ? 1200 : 150
    }).catch(() => {});

    const allowedRoots = collectAllowedRoots(persisted, rpcRes.sessions);
    let enriched = sessionOrgCore.enrichSessionsAndOrg({
      rpcSessions: rpcRes.sessions,
      allowedRoots,
      includeArchived,
      limit: 500
    });

    // Sync worktree topology for multi-worktree projects (preserves sessionOrder across upgrade/downgrade)
    let topologyChanged = false;
    for (const proj of (enriched.projects || [])) {
      const mainWt = Array.isArray(proj.worktrees) ? (proj.worktrees.find((w) => w.isMain) || proj.worktrees[0]) : null;
      const missingWts = Array.isArray(proj.worktrees)
        ? proj.worktrees
            .filter((w) => w.status === 'missing' || w.prunable)
            .map((w) => ({
              worktreeId: w.worktreeId,
              repoRootPath: proj.repoRootPath || proj.rootPath || '',
              path: w.path,
              branch: w.branch || ''
            }))
        : [];
      if (mainWt || missingWts.length > 0) {
        const syncRes = sessionOrgCore.syncWorktreeTopology({
          repoProjectId: proj.id,
          mainWorktreeId: mainWt?.worktreeId || '',
          isMultiWorktree: Boolean(proj.isMultiWorktree),
          missingWorktrees: missingWts
        });
        if (syncRes?.changed) topologyChanged = true;
      }
    }
    if (topologyChanged) {
      enriched = sessionOrgCore.enrichSessionsAndOrg({
        rpcSessions: rpcRes.sessions,
        allowedRoots,
        includeArchived,
        limit: 500
      });
    }

    const pcWebUrl = await getPcWebUrl();
    if (typeof body.hostWindowWorkspace === 'string' && body.hostWindowWorkspace.trim()) {
      cachedHostWindowWorkspace = workspaceOrg.canonicalizePath(body.hostWindowWorkspace)
        || workspaceOrg.normalizeLocalPath(body.hostWindowWorkspace);
    }
    const hostWindowWorkspace = cachedHostWindowWorkspace;

    if (typeof host?.state?.set === 'function') {
      host.state.set('state:sidebar.visible-sessions@1', {
        count: enriched.sessions.length,
        revision: enriched.revision,
        updatedAt: new Date().toISOString()
      });
    }

    return {
      ok: true,
      rpcAvailable: rpcRes.rpcAvailable,
      version: 2,
      revision: enriched.revision,
      sessions: enriched.sessions,
      org: enriched,
      groups: enriched.groups,
      projects: enriched.projects,
      collapsedNodes: enriched.collapsedNodes,
      pins: enriched.pins,
      groupOrder: enriched.groupOrder,
      projectOrder: enriched.projectOrder,
      sessionOrder: enriched.sessionOrder,
      worktreeTombstones: enriched.worktreeTombstones,
      archivedCount: enriched.archivedCount,
      ...(includeArchived ? { archivedSessions: enriched.archivedSessions || {} } : {}),
      defaultSessionPath: enriched.defaultSessionPath,
      pcWebUrl,
      hostWindowWorkspace
    };
  }

  function buildSessionContainersMap(orderedIds = []) {
    const out = {};
    const knownWts = worktreeDiscovery.getAllKnownWorktrees();
    const persisted = sessionOrgCore.loadPersistedOrg();
    const bindings = persisted.sessionWorktreeBindings || {};
    const byId = new Map(latestSessions.map((s) => [s.cascadeId, s]));

    for (const sid of orderedIds) {
      const b = bindings[sid];
      if (b?.worktreeId) {
        out[sid] = b.worktreeId;
        continue;
      }
      const s = byId.get(sid);
      const rawWs = s?.workspaceUri || s?.workspaces?.[0]?.workspaceFolderAbsoluteUri || '';
      if (rawWs && knownWts.length > 0) {
        const hit = workspaceOrg.matchWorktreeByLongestPrefix(rawWs, knownWts);
        if (hit?.worktreeId) {
          out[sid] = hit.worktreeId;
        }
      }
    }
    return out;
  }

  async function handleSessionCreate(body = {}) {
    const persisted = sessionOrgCore.loadPersistedOrg();
    const defaultSessionPath = persisted.defaultSessionPath || '';
    const target = await workspaceOrg.resolveAndValidateSessionTarget(body, {
      getAllowedRoots: () => collectAllowedRoots(sessionOrgCore.loadPersistedOrg(), latestSessions),
      worktreeDiscovery,
      resolveProjectById: (pid, opts) => {
        const orgNow = sessionOrgCore.loadPersistedOrg();
        const found = orgNow.projects.find((p) => p.id === pid || (Array.isArray(p.aliases) && p.aliases.includes(pid)));
        if (found) return found;
        if (opts?.workspaceUri) {
          const norm = workspaceOrg.normalizeLocalPath(opts.workspaceUri);
          if (norm) return { id: pid, rootPath: norm, name: path.basename(norm) };
        }
        return null;
      },
      defaultSessionPath
    });

    if (!target.ok) {
      return { ok: false, statusCode: target.statusCode || 400, error: target.error };
    }

    const cleanTitle = typeof body.title === 'string' ? body.title.trim() : '';
    const rpcParams = {
      source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
      metadata: { ...DEFAULT_METADATA },
      ...(target.workspaceUri ? { workspaceUris: [target.workspaceUri] } : {})
    };
    const resp = await host.rpc.call('StartCascade', rpcParams);
    if (!resp?.cascadeId) {
      return { ok: false, statusCode: 502, error: 'RPC_INVALID_RESPONSE' };
    }

    if (target.workspacePath || target.workspaceUri || target.projectId) {
      sessionOrgCore.bindSessionWorkspace(resp.cascadeId, {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        workspacePath: target.workspacePath,
        workspaceUri: target.workspaceUri
      });
    }

    return {
      ok: true,
      cascadeId: resp.cascadeId,
      title: cleanTitle,
      workspaceUri: target.workspaceUri || '',
      worktreeId: target.worktreeId || null,
      worktreePath: target.workspacePath || '',
      projectId: target.projectId || null
    };
  }

  async function handleSessionDelete(body = {}) {
    const cascadeId = String(body.cascadeId || '').trim();
    if (!cascadeId) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }
    const mode = String(body.mode || 'auto').trim().toLowerCase();
    if (mode === 'local_hide') {
      return sessionOrgCore.deleteSessionOrgRecord(cascadeId, { mode: 'local_tombstone' });
    }
    try {
      await host.rpc.call('DeleteCascadeTrajectory', { cascadeId });
    } catch (err) {
      return {
        ok: false,
        statusCode: 503,
        error: 'HOST_DELETE_UNAVAILABLE',
        canFallbackLocalHide: true,
        message: err?.message || String(err)
      };
    }
    return sessionOrgCore.deleteSessionOrgRecord(cascadeId, { mode: 'host_deleted' });
  }

  async function handleWorktreeList(body = {}) {
    const rawRoot = String(body.root || '').trim();
    if (!rawRoot) {
      return { ok: false, statusCode: 400, error: 'INVALID_WORKSPACE_PATH' };
    }
    if (workspaceOrg.isForbiddenSystemRoot(rawRoot)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }
    const org = sessionOrgCore.loadPersistedOrg();
    return await worktreeDiscovery.listWorktrees({
      root: rawRoot,
      refresh: Boolean(body.refresh),
      collapsedWorktrees: org.collapsedNodes?.worktrees || {}
    });
  }

  async function handleWorktreeMutate(body = {}) {
    const rawRoot = String(body.root || '').trim();
    const action = String(body.action || '').trim().toLowerCase();
    if (!rawRoot) {
      return { ok: false, statusCode: 400, error: 'INVALID_WORKSPACE_PATH' };
    }
    if (workspaceOrg.isForbiddenSystemRoot(rawRoot)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }
    const canonRoot = workspaceOrg.canonicalizePath(rawRoot) || workspaceOrg.normalizeLocalPath(rawRoot);
    if (!canonRoot || !fs.existsSync(canonRoot)) {
      return { ok: false, statusCode: 404, error: 'ROOT_NOT_FOUND' };
    }

    const probe = await worktreeDiscovery.probeRepository(canonRoot, { refresh: true });
    if (!probe.isGitRepo) {
      return { ok: false, statusCode: 400, error: 'NOT_A_GIT_REPOSITORY' };
    }
    const repoRoot = probe.repoRoot || canonRoot;

    if (action === 'prune') {
      const res = await runGitAsync(repoRoot, ['worktree', 'prune']);
      if (!res.ok) {
        return { ok: false, statusCode: 400, error: (res.stderr || res.stdout || 'GIT_WORKTREE_PRUNE_FAILED').trim() };
      }
      const listed = await worktreeDiscovery.listWorktrees({ root: repoRoot, refresh: true });
      worktreeDiscovery.invalidate(repoRoot, { action: 'prune', worktrees: listed.worktrees || [] });
      return { ...listed, action: 'prune' };
    }

    if (action !== 'add' && action !== 'remove') {
      return { ok: false, statusCode: 400, error: 'INVALID_WORKTREE_ACTION' };
    }

    let cleanBranch = '';
    if (body.branch !== undefined && body.branch !== null && String(body.branch).trim() !== '') {
      const brCheck = validateSafeRefToken(body.branch, 'INVALID_GIT_BRANCH');
      if (!brCheck.ok) return brCheck;
      cleanBranch = brCheck.value;
    }

    const pathArg = validateSafeGitArg(body.path, 'INVALID_WORKTREE_PATH');
    if (!pathArg.ok) return pathArg;

    const expanded = pathArg.value.startsWith('~/') ? path.join(os.homedir(), pathArg.value.slice(2)) : pathArg.value;
    const candidate = path.resolve(repoRoot, expanded);
    if (workspaceOrg.isForbiddenSystemRoot(candidate)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }
    const targetPath = workspaceOrg.canonicalizePath(candidate) || candidate;
    if (workspaceOrg.isForbiddenSystemRoot(targetPath)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }

    const allowedRoots = collectAllowedRoots(sessionOrgCore.loadPersistedOrg(), latestSessions);
    const insideAllowed = allowedRoots.some((r) => workspaceOrg.isSameOrInside(targetPath, r));

    let gitArgs;
    if (action === 'add') {
      const safeSibling = workspaceOrg.isSafeSiblingWorktreeTarget(repoRoot, targetPath, { branch: cleanBranch });
      if (!insideAllowed && !safeSibling) {
        return { ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' };
      }
      gitArgs = ['worktree', 'add'];
      if (body.createBranch) {
        if (!cleanBranch) return { ok: false, statusCode: 400, error: 'MISSING_BRANCH_NAME' };
        gitArgs.push('-b', cleanBranch);
      }
      gitArgs.push(targetPath);
      if (!body.createBranch && cleanBranch) {
        gitArgs.push(cleanBranch);
      }
    } else {
      if (!insideAllowed) {
        return { ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' };
      }
      if (workspaceOrg.canonicalKey(targetPath) === workspaceOrg.canonicalKey(repoRoot)) {
        return { ok: false, statusCode: 400, error: 'CANNOT_REMOVE_MAIN_WORKTREE' };
      }
      const existingWt = (probe.worktrees || []).find(
        (w) => workspaceOrg.canonicalKey(w.path) === workspaceOrg.canonicalKey(targetPath)
      );
      if (existingWt?.locked) {
        return { ok: false, statusCode: 409, error: 'WORKTREE_LOCKED' };
      }
      const rpcRes = await fetchRpcSessions();
      const hasRunning = rpcRes.sessions.some((s) => {
        if (!s.isRunning) return false;
        const sPath = workspaceOrg.canonicalizePath(s.workspaceUri) || workspaceOrg.normalizeLocalPath(s.workspaceUri);
        return Boolean(sPath && workspaceOrg.isSameOrInside(sPath, targetPath));
      });
      if (hasRunning) {
        return { ok: false, statusCode: 409, error: 'WORKTREE_HAS_RUNNING_SESSION' };
      }
      gitArgs = ['worktree', 'remove', targetPath];
    }

    const mutRes = await runGitAsync(repoRoot, gitArgs);
    if (!mutRes.ok) {
      return { ok: false, statusCode: 400, error: (mutRes.stderr || mutRes.stdout || 'GIT_WORKTREE_FAILED').trim() };
    }
    const listed = await worktreeDiscovery.listWorktrees({ root: repoRoot, refresh: true });
    worktreeDiscovery.invalidate(repoRoot, { action, worktrees: listed.worktrees || [] });
    return { ...listed, action, targetPath };
  }

  async function handleOpenWindow(body = {}) {
    const rawTarget = String(body.path || body.worktreePath || '').trim();
    if (!rawTarget) {
      return { ok: false, statusCode: 400, error: 'INVALID_WORKSPACE_PATH' };
    }
    if (workspaceOrg.isForbiddenSystemRoot(rawTarget)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }
    const canon = workspaceOrg.canonicalizePath(rawTarget) || workspaceOrg.normalizeLocalPath(rawTarget);
    if (!canon || workspaceOrg.isForbiddenSystemRoot(canon)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }
    if (!fs.existsSync(canon) || !fs.statSync(canon).isDirectory()) {
      return { ok: false, statusCode: 404, error: 'WORKTREE_PATH_MISSING' };
    }
    const allowedRoots = collectAllowedRoots(sessionOrgCore.loadPersistedOrg(), latestSessions);
    const isAuthorized = allowedRoots.some((r) => workspaceOrg.isSameOrInside(canon, r));
    if (!isAuthorized) {
      return { ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' };
    }

    if (isTestMode()) {
      return { ok: true, opened: true, path: canon, simulated: true };
    }

    const executable = findAntigravityExecutable();
    if (process.platform === 'darwin') {
      const child = spawn('open', ['-na', executable, '--args', canon], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    } else {
      const child = spawn(executable, [canon], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    }
    return { ok: true, opened: true, path: canon };
  }

  // Register §6.2 Bridge routes
  if (host?.bridge?.registerRoute) {
    disposers.push(host.bridge.registerRoute('/bootstrap', (body) => buildBootstrapPayload(body)));
    disposers.push(host.bridge.registerRoute('/org/group', (body) => sessionOrgCore.mutateGroup(body)));
    disposers.push(host.bridge.registerRoute('/org/collapse', (body) => sessionOrgCore.setNodeCollapsed(body)));
    disposers.push(host.bridge.registerRoute('/org/pin', (body) => sessionOrgCore.togglePin(body)));
    disposers.push(host.bridge.registerRoute('/org/reorder', (body) => {
      const payload = isPlainObject(body) ? { ...body } : {};
      if (payload.targetType === 'session' && payload.containerId !== '__pinned__' && !payload.sessionContainers) {
        payload.sessionContainers = buildSessionContainersMap(payload.orderedIds || []);
      }
      return sessionOrgCore.reorderOrg(payload);
    }));
    disposers.push(host.bridge.registerRoute('/session/create', (body) => handleSessionCreate(body)));
    disposers.push(host.bridge.registerRoute('/session/archive', (body) => sessionOrgCore.archiveSession(body?.cascadeId, body)));
    disposers.push(host.bridge.registerRoute('/session/delete', (body) => handleSessionDelete(body)));
    disposers.push(host.bridge.registerRoute('/worktree/list', (body) => handleWorktreeList(body)));
    disposers.push(host.bridge.registerRoute('/worktree/mutate', (body) => handleWorktreeMutate(body)));
    disposers.push(host.bridge.registerRoute('/workspace/open-window', (body) => handleOpenWindow(body)));
    disposers.push(host.bridge.registerRoute('/health', (body) => {
      if (isPlainObject(body) && typeof host?.state?.set === 'function') {
        host.state.set('state:sidebar.health@1', body);
      }
      return { ok: true };
    }));
  }

  // Register manifest commands
  if (host?.commands?.register) {
    disposers.push(host.commands.register('sidebar.toggle-view', async (nextMode) => {
      const cur = host.settings?.get?.()?.viewMode || 'enhanced';
      const targetMode = nextMode === 'enhanced' || nextMode === 'native'
        ? nextMode
        : (cur === 'enhanced' ? 'native' : 'enhanced');
      if (typeof host.settings?.update === 'function') {
        await host.settings.update({ viewMode: targetMode });
      }
      host.events?.emit?.('sidebar:view-mode-changed@1', { viewMode: targetMode });
      return { ok: true, viewMode: targetMode };
    }));

    disposers.push(host.commands.register('sidebar.refresh-worktrees', async () => {
      const snap = await buildBootstrapPayload({ refreshWorktrees: true });
      return { ok: true, revision: snap.revision, projectCount: snap.projects.length };
    }));

    disposers.push(host.commands.register('sidebar.create-group', async (name) => {
      if (typeof name === 'string' && name.trim()) {
        return sessionOrgCore.mutateGroup({ action: 'upsert', name: name.trim() });
      }
      host.events?.emit?.('sidebar:open-create-group@1', {});
      return { ok: true, prompted: true };
    }));
  }

  if (host?.services?.provide) {
    const stopSvc = await host.services.provide('sidebar-node', {
      bootstrap: (opts) => buildBootstrapPayload(opts),
      refreshWorktrees: () => buildBootstrapPayload({ refreshWorktrees: true }),
      toggleViewMode: (mode) => host.commands?.execute?.('sidebar.toggle-view', [mode])
    }, { realm: 'node', version: '1.0.0' });
    if (typeof stopSvc === 'function') disposers.push(stopSvc);
  }

  activeRuntime = {
    disposers,
    sessionOrgCore
  };
  return { ok: true, pluginId: PLUGIN_ID };
}

async function deactivate() {
  const rt = activeRuntime;
  if (!rt) return;
  activeRuntime = null;
  for (const fn of rt.disposers.splice(0).reverse()) {
    try {
      if (typeof fn === 'function') fn();
    } catch {}
  }
  try {
    rt.sessionOrgCore?.dispose?.();
  } catch {}
}

module.exports = {
  activate,
  deactivate,
  resolveWorkspaceOrg,
  normalizeSessionSummary,
  validateSafeGitArg,
  validateSafeRefToken
};
