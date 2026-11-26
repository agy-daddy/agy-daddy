'use strict';

const path = require('node:path');
const { normalizeLocalPath } = require('./workspace-meta-store');
const { resolveWorkspaceOrg } = require('./session-org-bridge');

const workspaceOrg = resolveWorkspaceOrg(null);

const LOG_TAIL_MAX_BYTES = 65536;
const RECENT_TASKS_LIMIT = 20;
const STEP_SCAN_SESSION_LIMIT = 8;
const STEP_SCAN_CONCURRENCY = 2;
const STEP_SCAN_TIMEOUT_MS = 3500;
const STEP_SCAN_CACHE_TTL_MS = 2500;
const FOREGROUND_DEFER_MS = 120;
const IS_CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function canonicalProjectKey(normPath) {
  if (typeof normPath !== 'string' || !normPath.trim()) return '';
  let s = normPath.trim().replace(/\\/g, '/');
  if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) {
    s = s.replace(/\/+$/, '');
  }
  return (IS_CASE_INSENSITIVE_FS || /^[A-Za-z]:\//.test(s)) ? s.toLowerCase() : s;
}

function isSameOrInsidePath(targetPath, rootPath) {
  const t = canonicalProjectKey(targetPath);
  const r = canonicalProjectKey(rootPath);
  if (!t || !r) return false;
  if (t === r) return true;
  const prefix = r === '/' ? '/' : (r.endsWith('/') ? r : `${r}/`);
  return t.startsWith(prefix);
}

function normalizeProjectFilterInput(rawProject) {
  if (typeof rawProject !== 'string') return null;
  const trimmed = rawProject.trim();
  if (!trimmed) return null;
  const norm = normalizeLocalPath(trimmed);
  return canonicalProjectKey(norm || trimmed) || null;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout(promise, timeoutMs, message = 'Step scan timed out') {
  const limit = Number(timeoutMs);
  if (!Number.isFinite(limit) || limit <= 0) {
    return Promise.resolve(promise);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, limit);
    Promise.resolve(promise).then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return;
  const concurrency = Math.max(1, Math.min(list.length, Number(limit) || 1));
  let cursor = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (cursor < list.length) {
      const idx = cursor++;
      await worker(list[idx], idx);
    }
  });
  await Promise.all(runners);
}

/**
 * Truncate text to at most maxBytes from the end without splitting multi-byte UTF-8 sequences.
 */
function truncateUtf8Tail(rawText, maxBytes = LOG_TAIL_MAX_BYTES) {
  const text = String(rawText || '');
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) {
    return {
      logText: text,
      truncated: false,
      totalBytes: buf.length,
      retainedBytes: buf.length
    };
  }
  const tail = buf.subarray(buf.length - maxBytes);
  let offset = 0;
  while (offset < tail.length && offset < 3 && (tail[offset] & 0xc0) === 0x80) {
    offset += 1;
  }
  const cleanBuf = tail.subarray(offset);
  return {
    logText: cleanBuf.toString('utf8'),
    truncated: true,
    totalBytes: buf.length,
    retainedBytes: cleanBuf.length
  };
}

function mapSessionStatus(rawStatus, notFullyIdle = false, killed = false) {
  if (killed) return 'canceled';
  const s = String(rawStatus || '').toUpperCase();
  if (s.includes('RUNNING') || s.includes('GENERATING')) return 'running';
  if (s.includes('ERROR') || s.includes('FAIL')) return 'error';
  if (s.includes('CANCEL')) return 'canceled';
  if (notFullyIdle) return 'running';
  return 'done';
}

function mapCommandStepStatus(rawStatus) {
  const s = String(rawStatus || '').toUpperCase();
  if (s.includes('RUNNING') || s.includes('GENERATING') || s === 'RUNNING' || s === 'GENERATING') return 'running';
  if (s.includes('PENDING') || s === 'PENDING') return 'pending';
  if (s.includes('ERROR') || s === 'ERROR') return 'error';
  if (s.includes('CANCEL') || s === 'CANCELED' || s === 'CANCELLED') return 'canceled';
  return 'done';
}

function toIsoOrNull(val) {
  if (!val) return null;
  if (typeof val === 'number' && Number.isFinite(val)) {
    return new Date(val).toISOString();
  }
  const str = String(val).trim();
  if (!str) return null;
  const parsed = Date.parse(str);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function computeDurationMs(startedAtIso, endedAtIso, isRunning) {
  const startMs = startedAtIso ? Date.parse(startedAtIso) : NaN;
  if (!Number.isFinite(startMs)) return null;
  if (endedAtIso) {
    const endMs = Date.parse(endedAtIso);
    if (Number.isFinite(endMs)) return Math.max(0, endMs - startMs);
  }
  if (isRunning) {
    return Math.max(0, Date.now() - startMs);
  }
  return null;
}

function isAlreadyFinishedRpcError(err) {
  const msg = String(err?.message || err?.code || '');
  return /already[\s_]*(idle|finished|completed|stopped|done)|not[\s_]*running|no[\s_]*active[\s_]*invocation/i.test(msg);
}

function createStopCapability(kind, status, sessionId) {
  const active = status === 'running' || status === 'pending';
  if (!active) {
    return {
      canStop: false,
      requiredPermission: kind === 'pty' ? 'L2' : 'L1',
      stopScope: 'none',
      affectsSessionId: sessionId || null
    };
  }
  if (kind === 'pty') {
    return {
      canStop: true,
      requiredPermission: 'L2',
      stopScope: 'pty_session',
      affectsSessionId: null
    };
  }
  if (kind === 'command' && status === 'pending') {
    return {
      canStop: true,
      requiredPermission: 'L1',
      stopScope: 'step_approval_deny',
      affectsSessionId: sessionId || null
    };
  }
  return {
    canStop: true,
    requiredPermission: 'L1',
    stopScope: 'cascade_invocation',
    affectsSessionId: sessionId || null
  };
}

/**
 * Aggregates background tasks across sessions/subagents, run-command steps, and Web PTY sessions.
 */
function createTaskManager({
  rpc = null,
  harnessAdapter = null,
  ptyManager = null,
  workspaceMetaStore = null,
  worktreeDiscovery = null,
  cacheTtlMs = STEP_SCAN_CACHE_TTL_MS,
  stepScanSessionLimit = STEP_SCAN_SESSION_LIMIT,
  stepScanConcurrency = STEP_SCAN_CONCURRENCY,
  stepScanTimeoutMs = STEP_SCAN_TIMEOUT_MS,
  foregroundDeferMs = FOREGROUND_DEFER_MS
} = {}) {
  const stepCache = new Map(); // cascadeId -> { fetchedAt, marker, steps }
  const inflightCollections = new Map(); // scanKey -> Promise

  const resolvedScanLimit = Number.isFinite(Number(stepScanSessionLimit)) && Number(stepScanSessionLimit) > 0
    ? Math.floor(Number(stepScanSessionLimit))
    : STEP_SCAN_SESSION_LIMIT;
  const resolvedScanConcurrency = Number.isFinite(Number(stepScanConcurrency)) && Number(stepScanConcurrency) > 0
    ? Math.floor(Number(stepScanConcurrency))
    : STEP_SCAN_CONCURRENCY;
  const resolvedScanTimeoutMs = Number.isFinite(Number(stepScanTimeoutMs)) && Number(stepScanTimeoutMs) > 0
    ? Number(stepScanTimeoutMs)
    : STEP_SCAN_TIMEOUT_MS;
  const resolvedDeferMs = Number.isFinite(Number(foregroundDeferMs)) && Number(foregroundDeferMs) >= 0
    ? Number(foregroundDeferMs)
    : FOREGROUND_DEFER_MS;

  function invalidateCache(cascadeId = null) {
    if (cascadeId) {
      stepCache.delete(cascadeId);
    } else {
      stepCache.clear();
    }
  }

  async function fetchStepsCached(cascadeId, marker) {
    const now = Date.now();
    const cached = stepCache.get(cascadeId);
    if (cached && cached.marker === marker && (now - cached.fetchedAt) < cacheTtlMs) {
      return cached.steps;
    }

    if (harnessAdapter && typeof harnessAdapter.getCachedSessionSteps === 'function') {
      const sharedSteps = harnessAdapter.getCachedSessionSteps(cascadeId);
      if (Array.isArray(sharedSteps)) {
        stepCache.set(cascadeId, { fetchedAt: now, marker, steps: sharedSteps });
        return sharedSteps;
      }
    }

    if (resolvedDeferMs > 0 && harnessAdapter && typeof harnessAdapter.hasActiveDetailRequest === 'function') {
      for (let waitAttempt = 0; waitAttempt < 2 && harnessAdapter.hasActiveDetailRequest(); waitAttempt++) {
        await delay(resolvedDeferMs);
      }
    }

    let steps = Array.isArray(cached?.steps) ? cached.steps : [];
    if (rpc && typeof rpc.call === 'function') {
      try {
        const resp = await withTimeout(
          rpc.call('GetCascadeTrajectorySteps', { cascadeId, stepOffset: 0 }, {
            timeoutMs: resolvedScanTimeoutMs,
            retryOnTimeout: false
          }),
          resolvedScanTimeoutMs,
          'Background step scan timed out'
        );
        steps = Array.isArray(resp?.steps)
          ? resp.steps
          : (Array.isArray(resp?.trajectory?.steps) ? resp.trajectory.steps : []);
      } catch {
        // Keep stale cached steps (or empty) without falling back to heavy GetCascadeTrajectory.
      }
    } else if (harnessAdapter && typeof harnessAdapter.getSessionDetail === 'function') {
      try {
        const detail = await withTimeout(
          harnessAdapter.getSessionDetail(cascadeId),
          resolvedScanTimeoutMs,
          'Background session detail scan timed out'
        );
        steps = Array.isArray(detail?.events) ? detail.events : [];
      } catch {
        // Keep stale cached steps (or empty).
      }
    }
    stepCache.set(cascadeId, { fetchedAt: Date.now(), marker, steps });
    return steps;
  }

  function extractCommandStepFields(step, fallbackIdx) {
    // Support both raw GetCascadeTrajectorySteps shape and normalized event shape
    const isNormalized = Boolean(step?.kind === 'command' && isPlainObject(step?.payload));
    const rc = isNormalized ? step.payload : (step?.runCommand || {});
    if (!isNormalized && step?.type && step.type !== 'CORTEX_STEP_TYPE_RUN_COMMAND' && !step.runCommand) {
      return null;
    }
    if (!isNormalized && !step?.runCommand) return null;
    const stepIndex = Number.isInteger(step?.stepIndex)
      ? step.stepIndex
      : (Number.isInteger(step?.seq) ? step.seq : fallbackIdx);
    const status = isNormalized
      ? mapCommandStepStatus(step.status)
      : mapCommandStepStatus(step.status);
    const commandLine = String(rc.commandLine || rc.proposedCommandLine || step.title || 'Run Command').trim();
    const cwd = rc.cwd || null;
    const exitCode = Number.isInteger(rc.exitCode) ? rc.exitCode : null;
    const combinedOutput = String(rc.combinedOutput || '');
    const startedAt = toIsoOrNull(step?.metadata?.createdAt || step?.createdAt || rc.startedAt);
    const endedAt = toIsoOrNull(step?.metadata?.completedAt || step?.completedAt || rc.endedAt);
    return {
      stepIndex,
      status,
      commandLine,
      cwd,
      exitCode,
      combinedOutput,
      startedAt,
      endedAt
    };
  }

  function buildProjectResolver(sessions) {
    const byKey = new Map();
    const byId = new Map();
    let defaultPathKey = '';

    if (workspaceMetaStore) {
      try {
        const metaState = workspaceMetaStore.getState?.();
        if (metaState?.defaultSessionPath) {
          const normDefault = normalizeLocalPath(metaState.defaultSessionPath);
          defaultPathKey = canonicalProjectKey(normDefault);
        }
      } catch {}

      try {
        const listed = workspaceMetaStore.listProjectsAndGroups?.(sessions);
        for (const p of listed?.projects || []) {
          const normRoot = normalizeLocalPath(p?.rootPath);
          const key = canonicalProjectKey(normRoot);
          if (normRoot && key) {
            const entry = {
              id: p.id || null,
              path: normRoot,
              key,
              name: (typeof p.name === 'string' && p.name.trim()) ? p.name.trim() : (path.basename(normRoot) || normRoot)
            };
            if (!byKey.has(key)) byKey.set(key, entry);
            if (entry.id) byId.set(entry.id, entry);
          }
          if (Array.isArray(p?.worktrees)) {
            for (const wt of p.worktrees) {
              const wtNorm = normalizeLocalPath(wt?.path);
              const wtKey = canonicalProjectKey(wtNorm);
              if (!wtNorm || !wtKey) continue;
              if (!byKey.has(wtKey)) {
                byKey.set(wtKey, {
                  id: p.id || null,
                  path: wtNorm,
                  key: wtKey,
                  worktreeId: wt.worktreeId || null,
                  worktreeBranch: wt.branch || wt.displayLabel || null,
                  name: (typeof p.name === 'string' && p.name.trim()) ? p.name.trim() : (path.basename(wtNorm) || wtNorm)
                });
              }
            }
          }
        }
      } catch {}
    }

    if (worktreeDiscovery) {
      for (const wt of worktreeDiscovery.getAllKnownWorktrees()) {
        const wtNorm = normalizeLocalPath(wt?.path);
        const wtKey = canonicalProjectKey(wtNorm);
        if (!wtNorm || !wtKey || byKey.has(wtKey)) continue;
        byKey.set(wtKey, {
          id: null,
          path: wtNorm,
          key: wtKey,
          worktreeId: wt.worktreeId || null,
          worktreeBranch: wt.branch || wt.displayLabel || null,
          name: wt.displayLabel || path.basename(wtNorm) || wtNorm
        });
      }
    }

    for (const s of sessions) {
      if (!s || typeof s !== 'object') continue;
      const rawWs = s.workspacePath
        || s.workspaceUri
        || s.workspaces?.[0]?.workspaceFolderAbsoluteUri
        || s.workspaces?.[0]?.workspaceUri
        || s.gitRootUri
        || '';
      const normWs = normalizeLocalPath(rawWs);
      const key = canonicalProjectKey(normWs);
      if (!normWs || !key) continue;
      if (defaultPathKey && key === defaultPathKey) continue;
      if (!byKey.has(key)) {
        const name = (typeof s.projectName === 'string' && s.projectName.trim())
          || (typeof s.repoName === 'string' && s.repoName.trim())
          || path.basename(normWs)
          || normWs;
        byKey.set(key, { id: s.projectId || null, path: normWs, key, name });
      }
    }

    const sortedProjects = Array.from(byKey.values()).sort((a, b) => b.path.length - a.path.length);

    function matchKnownProject(rawPath) {
      const norm = normalizeLocalPath(rawPath);
      if (!norm) return null;
      const canon = workspaceOrg.canonicalizePath(norm) || norm;
      for (const proj of sortedProjects) {
        const projCanon = workspaceOrg.canonicalizePath(proj.path) || proj.path;
        if (isSameOrInsidePath(canon, projCanon) || isSameOrInsidePath(norm, proj.path)) {
          return {
            projectPath: proj.path,
            projectName: proj.name,
            ...(proj.worktreeId ? { worktreeId: proj.worktreeId, worktreeBranch: proj.worktreeBranch } : {})
          };
        }
      }
      return null;
    }

    function resolvePath(rawPath, fallbackName = null) {
      const norm = normalizeLocalPath(rawPath);
      if (!norm) return { projectPath: null, projectName: null };
      const matched = matchKnownProject(norm);
      if (matched) return matched;
      const key = canonicalProjectKey(norm);
      if (defaultPathKey && key === defaultPathKey) {
        return { projectPath: null, projectName: null };
      }
      const cleanFallback = typeof fallbackName === 'string' && fallbackName.trim() ? fallbackName.trim() : '';
      return {
        projectPath: norm,
        projectName: cleanFallback || path.basename(norm) || norm
      };
    }

    function resolveSessionProject(s) {
      if (s?.projectId && byId.has(s.projectId)) {
        const p = byId.get(s.projectId);
        return { projectPath: p.path, projectName: p.name };
      }
      const rawWs = s?.workspacePath
        || s?.workspaceUri
        || s?.workspaces?.[0]?.workspaceFolderAbsoluteUri
        || s?.workspaces?.[0]?.workspaceUri
        || s?.gitRootUri
        || '';
      return resolvePath(rawWs, s?.projectName || s?.repoName || null);
    }

    return {
      matchKnownProject,
      resolvePath,
      resolveSessionProject
    };
  }

  async function runCollectAllTasks({ extraSessionIds = [] } = {}) {
    const running = [];
    const recent = [];
    const detailIndex = new Map();

    // 1. Sessions first (so project roots from sessions are available for PTY cwd mapping too)
    let sessions = [];
    if (harnessAdapter && typeof harnessAdapter.listSessions === 'function') {
      try {
        const listRes = await harnessAdapter.listSessions({ limit: 200 });
        if (Array.isArray(listRes?.sessions)) {
          sessions = listRes.sessions;
        }
      } catch {
        sessions = [];
      }
    }

    const projectResolver = buildProjectResolver(sessions);

    // 2. Web PTY sessions
    if (ptyManager && typeof ptyManager.listAllForTasks === 'function') {
      const ptyData = ptyManager.listAllForTasks();
      for (const item of [...(ptyData.active || []), ...(ptyData.recentClosed || [])]) {
        const taskId = `pty:${item.sessionId}`;
        const status = item.alive ? 'running' : (item.status || 'done');
        const startedAt = toIsoOrNull(item.createdAt);
        const endedAt = item.alive ? null : toIsoOrNull(item.endedAt || item.lastActivityAt);
        const proj = projectResolver.resolvePath(item.cwd);
        const dto = {
          taskId,
          kind: 'pty',
          title: item.title || `Terminal (${item.shell || 'sh'})`,
          commandLine: `${item.shell || 'sh'} (${item.cwd || ''})`,
          cwd: item.cwd || null,
          projectPath: proj.projectPath,
          projectName: proj.projectName,
          sessionId: null,
          sessionTitle: null,
          status,
          startedAt,
          endedAt,
          durationMs: computeDurationMs(startedAt, endedAt, status === 'running'),
          exitCode: item.exitCode ?? null,
          stopCapability: createStopCapability('pty', status, null)
        };
        detailIndex.set(taskId, { dto, rawLog: String(item.logSnapshot || '') });
        if (status === 'running') running.push(dto);
        else recent.push(dto);
      }
    }

    // 3. Sessions & subagents + run_command steps
    const sessionDetailTargetIds = new Set();
    const sessionProjectMap = new Map();
    const knownSessionIds = new Set();
    for (const s of sessions) {
      const cid = s?.cascadeId;
      if (!cid) continue;
      knownSessionIds.add(cid);
      const status = mapSessionStatus(s.status, s.notFullyIdle, s.killed);
      const isSub = Boolean(s.isSubagent);
      const kind = isSub ? 'subagent' : 'session';
      const title = s.title || s.agentName || (isSub ? 'Subagent' : 'Session');
      const startedAt = toIsoOrNull(s.createdTime);
      const endedAt = status === 'running' ? null : toIsoOrNull(s.lastCompletedTime || s.lastModifiedTime);
      const rawWs = s.workspacePath
        || s.workspaceUri
        || s.workspaces?.[0]?.workspaceFolderAbsoluteUri
        || s.workspaces?.[0]?.workspaceUri
        || null;
      const normWs = normalizeLocalPath(rawWs) || null;
      const proj = projectResolver.resolveSessionProject(s);
      sessionProjectMap.set(cid, proj);
      const taskId = `session:${cid}`;
      const dto = {
        taskId,
        kind,
        title,
        commandLine: null,
        cwd: s.workspacePath || normWs || null,
        projectPath: proj.projectPath,
        projectName: proj.projectName,
        sessionId: cid,
        sessionTitle: title,
        status,
        startedAt,
        endedAt,
        durationMs: computeDurationMs(startedAt, endedAt, status === 'running'),
        exitCode: null,
        stopCapability: createStopCapability(kind, status, cid)
      };

      if (status === 'running') {
        running.push(dto);
        sessionDetailTargetIds.add(cid);
      } else {
        recent.push(dto);
      }
      detailIndex.set(taskId, {
        dto,
        rawLog: '',
        cascadeId: cid
      });
    }

    for (const s of sessions) {
      if (sessionDetailTargetIds.size >= resolvedScanLimit) break;
      if (s?.cascadeId) sessionDetailTargetIds.add(s.cascadeId);
    }
    for (const extraId of extraSessionIds) {
      if (extraId && knownSessionIds.has(extraId)) {
        sessionDetailTargetIds.add(extraId);
      }
    }

    const sessionTitleMap = new Map(sessions.map((s) => [s.cascadeId, s.title || s.agentName || s.cascadeId]));
    const sessionMarkerMap = new Map(
      sessions.map((s) => [s.cascadeId, `${s.status || ''}:${s.stepCount || 0}:${s.lastModifiedTime || ''}`])
    );

    await runWithConcurrency(
      Array.from(sessionDetailTargetIds),
      resolvedScanConcurrency,
      async (cid) => {
        const steps = await fetchStepsCached(cid, sessionMarkerMap.get(cid) || '');
        const sessionTitle = sessionTitleMap.get(cid) || cid;
        const sessionProj = sessionProjectMap.get(cid) || { projectPath: null, projectName: null };
        const cmdLogsForSession = [];
        for (let i = 0; i < steps.length; i++) {
          const parsed = extractCommandStepFields(steps[i], i);
          if (!parsed) continue;
          if (parsed.combinedOutput) {
            cmdLogsForSession.push(`$ ${parsed.commandLine}\n${parsed.combinedOutput}`);
          }
          const matchedCmdProj = parsed.cwd ? projectResolver.matchKnownProject(parsed.cwd) : null;
          const cmdProj = matchedCmdProj
            || (sessionProj.projectPath ? sessionProj : projectResolver.resolvePath(parsed.cwd));
          const taskId = `cmd:${cid}:${parsed.stepIndex}`;
          const isActive = parsed.status === 'running' || parsed.status === 'pending';
          const dto = {
            taskId,
            kind: 'command',
            title: parsed.commandLine,
            commandLine: parsed.commandLine,
            cwd: parsed.cwd,
            projectPath: cmdProj.projectPath,
            projectName: cmdProj.projectName,
            sessionId: cid,
            sessionTitle,
            status: parsed.status,
            startedAt: parsed.startedAt,
            endedAt: isActive ? null : parsed.endedAt,
            durationMs: computeDurationMs(parsed.startedAt, isActive ? null : parsed.endedAt, isActive),
            exitCode: parsed.exitCode,
            stopCapability: createStopCapability('command', parsed.status, cid)
          };
          detailIndex.set(taskId, { dto, rawLog: parsed.combinedOutput });
          if (isActive) running.push(dto);
          else recent.push(dto);
        }

        const sessionEntry = detailIndex.get(`session:${cid}`);
        if (sessionEntry) {
          sessionEntry.rawLog = cmdLogsForSession.join('\n\n') || `Session ${sessionTitle} (${sessionEntry.dto.status})`;
        }
      }
    );

    const sortByTimeDesc = (a, b) => {
      const tb = Date.parse(b.endedAt || b.startedAt || '') || 0;
      const ta = Date.parse(a.endedAt || a.startedAt || '') || 0;
      return tb - ta;
    };

    running.sort(sortByTimeDesc);
    recent.sort(sortByTimeDesc);

    return {
      allRunning: running,
      allRecent: recent,
      detailIndex
    };
  }

  async function collectAllTasks(opts = {}) {
    const extraSessionIds = Array.isArray(opts?.extraSessionIds)
      ? opts.extraSessionIds.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()).sort()
      : [];
    const scanKey = extraSessionIds.join(',');
    const existing = inflightCollections.get(scanKey);
    if (existing) return await existing;
    const task = runCollectAllTasks({ extraSessionIds });
    inflightCollections.set(scanKey, task);
    try {
      return await task;
    } finally {
      if (inflightCollections.get(scanKey) === task) {
        inflightCollections.delete(scanKey);
      }
    }
  }

  function buildTaskFilters(allTasks) {
    const projectMap = new Map();
    const sessionMap = new Map();

    for (const t of allTasks) {
      const ts = Date.parse(t.endedAt || t.startedAt || '') || 0;
      if (t.projectPath) {
        const key = canonicalProjectKey(t.projectPath);
        if (key) {
          const existing = projectMap.get(key);
          if (existing) {
            existing.count += 1;
            if (ts > existing.latestMs) existing.latestMs = ts;
          } else {
            projectMap.set(key, {
              key,
              name: t.projectName || path.basename(t.projectPath) || t.projectPath,
              path: t.projectPath,
              count: 1,
              latestMs: ts
            });
          }
        }
      }
      if (t.sessionId) {
        const existingSess = sessionMap.get(t.sessionId);
        if (existingSess) {
          existingSess.count += 1;
          if (!existingSess.projectPath && t.projectPath) existingSess.projectPath = t.projectPath;
          if (ts > existingSess.latestMs) existingSess.latestMs = ts;
        } else {
          sessionMap.set(t.sessionId, {
            id: t.sessionId,
            title: t.sessionTitle || t.title || t.sessionId,
            projectPath: t.projectPath || null,
            count: 1,
            latestMs: ts
          });
        }
      }
    }

    const projects = Array.from(projectMap.values())
      .sort((a, b) => (b.latestMs - a.latestMs) || a.name.localeCompare(b.name))
      .map(({ latestMs, ...rest }) => rest);

    const sessions = Array.from(sessionMap.values())
      .sort((a, b) => (b.latestMs - a.latestMs) || a.id.localeCompare(b.id))
      .map(({ latestMs, ...rest }) => rest);

    return { projects, sessions };
  }

  async function listTasks({ sessionId = null, project = null } = {}) {
    const cleanSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
    const cleanProjectKey = normalizeProjectFilterInput(project);
    const { allRunning, allRecent } = await collectAllTasks({
      extraSessionIds: cleanSessionId ? [cleanSessionId] : []
    });

    const totalRunningCount = allRunning.length;
    const filters = buildTaskFilters([...allRunning, ...allRecent]);

    const matchesFilter = (t) => {
      if (cleanSessionId && t.sessionId !== cleanSessionId) return false;
      if (cleanProjectKey) {
        const taskKey = t.projectPath ? canonicalProjectKey(t.projectPath) : '';
        if (!taskKey || taskKey !== cleanProjectKey) return false;
      }
      return true;
    };

    const filteredRunning = (cleanSessionId || cleanProjectKey) ? allRunning.filter(matchesFilter) : allRunning;
    const filteredRecent = (cleanSessionId || cleanProjectKey) ? allRecent.filter(matchesFilter) : allRecent;

    return {
      ok: true,
      runningCount: filteredRunning.length,
      totalRunningCount,
      running: filteredRunning,
      recent: filteredRecent.slice(0, RECENT_TASKS_LIMIT),
      filters,
      serverTime: Date.now()
    };
  }

  async function getTaskDetail(taskId) {
    const cleanId = String(taskId || '').trim();
    if (!cleanId) {
      return { ok: false, statusCode: 400, error: 'TASK_ID_REQUIRED' };
    }
    const { detailIndex } = await collectAllTasks();
    const entry = detailIndex.get(cleanId);
    if (!entry) {
      return { ok: false, statusCode: 404, error: 'TASK_NOT_FOUND', taskId: cleanId };
    }
    let rawLog = entry.rawLog;
    if (!rawLog && entry.cascadeId) {
      const steps = await fetchStepsCached(entry.cascadeId, String(Date.now()));
      const chunks = [];
      for (let i = 0; i < steps.length; i++) {
        const cmd = extractCommandStepFields(steps[i], i);
        if (cmd?.combinedOutput) chunks.push(`$ ${cmd.commandLine}\n${cmd.combinedOutput}`);
      }
      rawLog = chunks.join('\n\n');
    }
    const tail = truncateUtf8Tail(rawLog, LOG_TAIL_MAX_BYTES);
    return {
      ok: true,
      task: {
        ...entry.dto,
        ...tail
      }
    };
  }

  async function stopTask(taskId) {
    const cleanId = String(taskId || '').trim();
    if (!cleanId) {
      return { ok: false, statusCode: 400, error: 'TASK_ID_REQUIRED' };
    }

    const { detailIndex } = await collectAllTasks();
    const entry = detailIndex.get(cleanId);
    if (!entry) {
      return { ok: false, statusCode: 404, error: 'TASK_NOT_FOUND', taskId: cleanId };
    }

    const dto = entry.dto;
    if (dto.status !== 'running' && dto.status !== 'pending') {
      return {
        ok: true,
        taskId: cleanId,
        alreadyFinished: true,
        status: dto.status,
        exitCode: dto.exitCode ?? null,
        task: dto
      };
    }

    if (cleanId.startsWith('pty:')) {
      const ptyId = cleanId.slice('pty:'.length);
      if (!ptyManager) {
        return { ok: false, statusCode: 503, error: 'PTY_MANAGER_UNAVAILABLE' };
      }
      const closeRes = ptyManager.closeSession(ptyId);
      const snap = ptyManager.getTaskSnapshot?.(ptyId);
      if (!closeRes.closed) {
        const finalStatus = snap?.status || 'done';
        return {
          ok: true,
          taskId: cleanId,
          alreadyFinished: true,
          status: finalStatus,
          exitCode: snap?.exitCode ?? dto.exitCode ?? null,
          task: { ...dto, status: finalStatus, exitCode: snap?.exitCode ?? dto.exitCode ?? null }
        };
      }
      return {
        ok: true,
        taskId: cleanId,
        alreadyFinished: false,
        status: 'canceled',
        exitCode: snap?.exitCode ?? null,
        task: { ...dto, status: 'canceled', stopCapability: createStopCapability('pty', 'canceled', null) }
      };
    }

    if (cleanId.startsWith('cmd:')) {
      const parts = cleanId.split(':');
      const stepIdx = Number(parts.pop());
      const cid = parts.slice(1).join(':');
      invalidateCache(cid);

      if (dto.status === 'pending' && harnessAdapter?.approveStep) {
        try {
          await harnessAdapter.approveStep(cid, stepIdx, 'deny');
          return {
            ok: true,
            taskId: cleanId,
            alreadyFinished: false,
            status: 'canceled',
            exitCode: null,
            task: { ...dto, status: 'canceled', stopCapability: createStopCapability('command', 'canceled', cid) }
          };
        } catch (err) {
          if (isAlreadyFinishedRpcError(err)) {
            return {
              ok: true,
              taskId: cleanId,
              alreadyFinished: true,
              status: 'done',
              exitCode: dto.exitCode ?? null,
              task: { ...dto, status: 'done' }
            };
          }
          throw err;
        }
      }

      let cancelled = false;
      if (rpc && typeof rpc.call === 'function' && Number.isInteger(stepIdx)) {
        try {
          await rpc.call('CancelCascadeSteps', { cascadeId: cid, stepIndices: [stepIdx] });
          cancelled = true;
        } catch (err) {
          if (isAlreadyFinishedRpcError(err)) {
            return {
              ok: true,
              taskId: cleanId,
              alreadyFinished: true,
              status: 'done',
              exitCode: dto.exitCode ?? null,
              task: { ...dto, status: 'done' }
            };
          }
          cancelled = false;
        }
      }
      if (!cancelled && harnessAdapter?.cancelSession) {
        try {
          await harnessAdapter.cancelSession(cid);
          cancelled = true;
        } catch (err) {
          if (isAlreadyFinishedRpcError(err)) {
            return {
              ok: true,
              taskId: cleanId,
              alreadyFinished: true,
              status: 'done',
              exitCode: dto.exitCode ?? null,
              task: { ...dto, status: 'done' }
            };
          }
          throw err;
        }
      }
      return {
        ok: true,
        taskId: cleanId,
        alreadyFinished: false,
        status: 'canceled',
        exitCode: null,
        task: { ...dto, status: 'canceled', stopCapability: createStopCapability('command', 'canceled', cid) }
      };
    }

    if (cleanId.startsWith('session:')) {
      const cid = cleanId.slice('session:'.length);
      invalidateCache(cid);
      if (!harnessAdapter?.cancelSession) {
        return { ok: false, statusCode: 503, error: 'HARNESS_ADAPTER_UNAVAILABLE' };
      }
      try {
        await harnessAdapter.cancelSession(cid);
        return {
          ok: true,
          taskId: cleanId,
          alreadyFinished: false,
          status: 'canceled',
          exitCode: null,
          task: { ...dto, status: 'canceled', stopCapability: createStopCapability(dto.kind, 'canceled', cid) }
        };
      } catch (err) {
        if (isAlreadyFinishedRpcError(err)) {
          return {
            ok: true,
            taskId: cleanId,
            alreadyFinished: true,
            status: 'done',
            exitCode: null,
            task: { ...dto, status: 'done' }
          };
        }
        throw err;
      }
    }

    return { ok: false, statusCode: 404, error: 'TASK_NOT_FOUND', taskId: cleanId };
  }

  return {
    invalidateCache,
    listTasks,
    getTaskDetail,
    stopTask
  };
}

module.exports = {
  LOG_TAIL_MAX_BYTES,
  RECENT_TASKS_LIMIT,
  STEP_SCAN_SESSION_LIMIT,
  STEP_SCAN_CONCURRENCY,
  STEP_SCAN_TIMEOUT_MS,
  truncateUtf8Tail,
  canonicalProjectKey,
  createTaskManager
};
