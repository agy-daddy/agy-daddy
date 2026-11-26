'use strict';

const { Buffer } = require('node:buffer');
const os = require('node:os');
const path = require('node:path');
const { isPermissionAtLeast } = require('./tunnel-security');

const LOG_TAIL_MAX_BYTES = 65536;
const RECENT_TASKS_LIMIT = 24;
const STEP_SCAN_SESSION_LIMIT = 8;
const STEP_SCAN_CACHE_TTL_MS = 2500;
const IS_CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function normalizeProjectPath(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s || s.includes('\0')) return '';
  if (/^file:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
      if (WINDOWS_DRIVE_RE.test(s.slice(1))) s = s.slice(1);
    } catch {
      s = s.replace(/^file:\/\//i, '');
      if (/^localhost\//i.test(s)) s = s.slice('localhost'.length);
    }
  }
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
  if (WINDOWS_DRIVE_RE.test(s) && process.platform !== 'win32') {
    const slashed = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    return slashed.length > 3 ? slashed.replace(/\/+$/, '') : slashed;
  }
  const resolved = path.isAbsolute(s) ? path.resolve(s) : s.replace(/\\/g, '/');
  return resolved.length > 1 && !/^[A-Za-z]:[\\/]$/.test(resolved) ? resolved.replace(/[\\/]+$/, '') : resolved;
}

function canonicalProjectKey(raw) {
  const norm = normalizeProjectPath(raw);
  if (!norm) return '';
  const slashed = norm.replace(/\\/g, '/');
  return IS_CASE_INSENSITIVE_FS ? slashed.toLowerCase() : slashed;
}

function extractProjectBasename(normPath) {
  const slashed = String(normPath || '').replace(/\\/g, '/');
  const parts = slashed.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : slashed;
}

/**
 * Strip any leading UTF-8 continuation bytes (10xxxxxx) and any incomplete
 * trailing multi-byte UTF-8 sequence so decoding never emits U+FFFD.
 */
function cleanUtf8BoundaryBuffer(buf) {
  if (!buf || buf.length === 0) return Buffer.alloc(0);
  let start = 0;
  while (start < buf.length && start < 3 && (buf[start] & 0b11000000) === 0b10000000) {
    start += 1;
  }
  let end = buf.length;
  // Check up to the last 3 bytes for an incomplete multi-byte leader
  for (let i = Math.max(start, end - 3); i < end; i++) {
    const b = buf[i];
    if ((b & 0b10000000) === 0) continue;
    if ((b & 0b11000000) === 0b10000000) continue;
    let expectedLen = 1;
    if ((b & 0b11100000) === 0b11000000) expectedLen = 2;
    else if ((b & 0b11110000) === 0b11100000) expectedLen = 3;
    else if ((b & 0b11111000) === 0b11110000) expectedLen = 4;
    if (i + expectedLen > end) {
      end = i;
      break;
    }
  }
  return buf.subarray(start, end);
}

/**
 * Truncate raw text/buffer to at most maxBytes from the end on clean UTF-8 boundaries.
 */
function truncateUtf8Tail(rawText, maxBytes = LOG_TAIL_MAX_BYTES) {
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Math.floor(Number(maxBytes))
    : LOG_TAIL_MAX_BYTES;
  const buf = Buffer.isBuffer(rawText)
    ? rawText
    : Buffer.from(String(rawText || ''), 'utf8');
  const totalBytes = buf.length;

  if (totalBytes <= limit) {
    const clean = Buffer.isBuffer(rawText) ? cleanUtf8BoundaryBuffer(buf) : buf;
    return {
      logText: clean.toString('utf8'),
      truncated: false,
      totalBytes,
      retainedBytes: clean.length
    };
  }

  const tail = buf.subarray(totalBytes - limit);
  const cleanBuf = cleanUtf8BoundaryBuffer(tail);
  return {
    logText: cleanBuf.toString('utf8'),
    truncated: true,
    totalBytes,
    retainedBytes: cleanBuf.length
  };
}

function toTimestampMs(val, fallback = null) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim()) {
    const parsed = Date.parse(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function normalizeTaskStatus(rawStatus, fallback = 'completed') {
  const s = String(rawStatus || '').trim().toUpperCase();
  if (!s) return fallback;
  if (s === 'RUNNING' || s.includes('RUNNING') || s.includes('GENERATING') || s === 'PENDING' || s.includes('PENDING') || s.includes('WAITING')) {
    return 'running';
  }
  if (s === 'STOPPED' || s.includes('CANCEL') || s === 'STOP' || s === 'KILLED') {
    return 'stopped';
  }
  if (s === 'FAILED' || s.includes('ERROR') || s.includes('FAIL')) {
    return 'failed';
  }
  if (s === 'COMPLETED' || s === 'DONE' || s.includes('DONE') || s.includes('IDLE')) {
    return 'completed';
  }
  return fallback;
}

function isAlreadyFinishedRpcError(err) {
  const msg = String(err?.message || err?.code || '');
  return /already[\s_]*(idle|finished|completed|stopped|done)|not[\s_]*running|no[\s_]*active[\s_]*invocation/i.test(msg);
}

function buildStopCapability(kind, status, permissionLevel) {
  const requiredLevel = kind === 'pty' ? 'L2' : 'L1';
  if (status !== 'running') {
    return {
      canStop: false,
      requiredLevel
    };
  }
  if (isPermissionAtLeast(permissionLevel, requiredLevel)) {
    return {
      canStop: true,
      requiredLevel
    };
  }
  return {
    canStop: false,
    requiredLevel,
    reason: kind === 'pty'
      ? '停止终端进程需要宿主机授予 L2 权限'
      : '停止任务需要宿主机授予 L1 或以上权限'
  };
}

function extractCommandStepFields(step, fallbackIdx) {
  const isNormalized = Boolean(step?.kind === 'command' && isPlainObject(step?.payload));
  const rc = isNormalized ? step.payload : (step?.runCommand || null);
  if (!isNormalized && step?.type !== 'CORTEX_STEP_TYPE_RUN_COMMAND' && !rc) {
    return null;
  }
  if (!rc) return null;
  const stepIndex = Number.isInteger(step?.stepIndex)
    ? step.stepIndex
    : (Number.isInteger(step?.seq) ? step.seq : fallbackIdx);
  const rawStatus = String(step?.status || '').toUpperCase();
  const status = normalizeTaskStatus(rawStatus, 'completed');
  const isPendingApproval = rawStatus.includes('PENDING');
  const commandLine = String(rc.commandLine || rc.proposedCommandLine || step.title || 'Run Command').trim();
  const cwd = rc.cwd || null;
  const exitCode = Number.isInteger(rc.exitCode) ? rc.exitCode : null;
  const combinedOutput = String(rc.combinedOutput || rc.output || '');
  const startedAt = toTimestampMs(step?.metadata?.createdAt || step?.createdAt || rc.startedAt, Date.now());
  const endedAt = status === 'running' ? null : toTimestampMs(step?.metadata?.completedAt || step?.completedAt || rc.endedAt, startedAt);
  return {
    stepIndex,
    status,
    isPendingApproval,
    commandLine,
    cwd,
    exitCode,
    combinedOutput,
    startedAt,
    endedAt
  };
}

/**
 * Aggregates background tasks across PTY sessions, sessions/subagents, and run-command steps.
 */
function createTaskManager({
  ptyManager = null,
  listSessions = null,
  getAllowedRoots = null,
  getSessionSteps = null,
  cancelSession = null,
  approveStep = null,
  callRpc = null,
  cacheTtlMs = STEP_SCAN_CACHE_TTL_MS
} = {}) {
  const stepCache = new Map();

  function invalidateCache(cascadeId = null) {
    if (cascadeId) stepCache.delete(cascadeId);
    else stepCache.clear();
  }

  async function fetchStepsCached(cascadeId, marker) {
    if (typeof getSessionSteps !== 'function') return [];
    const now = Date.now();
    const cached = stepCache.get(cascadeId);
    if (cached && cached.marker === marker && (now - cached.fetchedAt) < cacheTtlMs) {
      return cached.steps;
    }
    let steps = [];
    try {
      const res = await getSessionSteps(cascadeId);
      steps = Array.isArray(res) ? res : [];
    } catch {
      steps = [];
    }
    stepCache.set(cascadeId, { fetchedAt: now, marker, steps });
    return steps;
  }

  async function collectAllTasks(permissionLevel = 'L0', { targetSessionId = '' } = {}) {
    const running = [];
    const recent = [];
    const detailIndex = new Map();

    // Fetch sessions & projects first so PTY and command tasks can map cwds onto known project roots
    let sessions = [];
    let rawProjects = [];
    if (typeof listSessions === 'function') {
      try {
        const res = await listSessions({ limit: 200, includeSubagents: true });
        sessions = Array.isArray(res?.sessions) ? res.sessions : (Array.isArray(res) ? res : []);
        if (Array.isArray(res?.projects)) rawProjects = res.projects;
      } catch {
        sessions = [];
        rawProjects = [];
      }
    }

    const knownProjectMap = new Map(); // key -> { key, path, name, id, aliases }
    const projectIdToKey = new Map();
    const registerKnownProject = (rawPath, { name = '', id = '', aliases = [] } = {}) => {
      const normPath = normalizeProjectPath(rawPath);
      const key = canonicalProjectKey(normPath);
      if (!key) return;
      const existing = knownProjectMap.get(key);
      const resolvedName = existing?.name || String(name || '').trim() || extractProjectBasename(normPath) || normPath;
      const mergedAliases = new Set([...(existing?.aliases || []), ...(Array.isArray(aliases) ? aliases : [])]);
      const resolvedId = id || existing?.id || '';
      knownProjectMap.set(key, {
        key,
        path: existing?.path || normPath,
        name: resolvedName,
        id: resolvedId,
        aliases: Array.from(mergedAliases)
      });
      if (resolvedId) projectIdToKey.set(resolvedId, key);
      for (const al of mergedAliases) {
        if (al) projectIdToKey.set(String(al), key);
      }
    };

    for (const p of rawProjects) {
      if (!p) continue;
      registerKnownProject(p.rootPath || p.workspaceUri || p.path || '', {
        name: p.name,
        id: p.id,
        aliases: p.aliases
      });
    }
    if (typeof getAllowedRoots === 'function') {
      try {
        const roots = getAllowedRoots();
        for (const r of Array.isArray(roots) ? roots : []) {
          registerKnownProject(r);
        }
      } catch {}
    }
    for (const s of sessions) {
      const wsRaw = s?.workspacePath || (typeof s?.workspaceUri === 'string' ? s.workspaceUri : '');
      if (wsRaw) {
        registerKnownProject(wsRaw, { name: s.projectName || '', id: s.projectId || '' });
      }
    }

    const knownProjectsDesc = Array.from(knownProjectMap.values()).sort((a, b) => b.key.length - a.key.length);
    const resolveProjectInfo = (candidateRaw, fallbackProject = null) => {
      const normCand = normalizeProjectPath(candidateRaw);
      const candKey = canonicalProjectKey(normCand);
      if (candKey) {
        for (const proj of knownProjectsDesc) {
          const prefix = proj.key.endsWith('/') ? proj.key : `${proj.key}/`;
          if (candKey === proj.key || candKey.startsWith(prefix)) {
            return { key: proj.key, path: proj.path, name: proj.name };
          }
        }
      }
      if (fallbackProject && fallbackProject.path) {
        return fallbackProject;
      }
      if (normCand) {
        return {
          key: candKey,
          path: normCand,
          name: extractProjectBasename(normCand) || normCand
        };
      }
      return { key: '', path: null, name: null };
    };

    // 1. PTY tasks
    if (ptyManager && typeof ptyManager.listTaskRecords === 'function') {
      const records = ptyManager.listTaskRecords();
      for (const rec of Array.isArray(records) ? records : []) {
        const ptyId = rec.id || rec.sessionId;
        if (!ptyId) continue;
        const id = `pty:${ptyId}`;
        const status = rec.alive ? 'running' : normalizeTaskStatus(rec.status, rec.exitCode && rec.exitCode !== 0 ? 'failed' : 'completed');
        const dirName = rec.cwd ? path.basename(rec.cwd) : 'terminal';
        const projInfo = resolveProjectInfo(rec.cwd || '');
        const dto = {
          id,
          taskId: id,
          kind: 'pty',
          title: `PTY · ${dirName || 'shell'}`,
          subtitle: rec.cwd || '',
          status,
          cwd: rec.cwd || undefined,
          projectPath: projInfo.path,
          projectName: projInfo.name,
          sessionTitle: rec.sessionTitle || null,
          startedAt: toTimestampMs(rec.createdAt, Date.now()),
          endedAt: status === 'running' ? null : toTimestampMs(rec.endedAt, Date.now()),
          exitCode: rec.exitCode ?? null,
          stopCapability: buildStopCapability('pty', status, permissionLevel)
        };
        detailIndex.set(id, { dto, rawLog: rec.logBuffer || '' });
        if (status === 'running') running.push(dto);
        else recent.push(dto);
      }
    }

    // 2. Sessions & Subagents
    const stepScanTargets = new Set();
    const sessionTitleMap = new Map();
    const sessionMarkerMap = new Map();
    const sessionProjectMap = new Map();

    for (const s of sessions) {
      const cid = s?.cascadeId || s?.id;
      if (!cid) continue;
      const status = normalizeTaskStatus(s.status, 'completed');
      const isSubagent = Boolean(s.isSubagent || s.parentCascadeId);
      const title = String(s.title || s.summary || (isSubagent ? 'Subagent' : 'Session')).trim();
      const rawWs = s.workspacePath || (typeof s.workspaceUri === 'string' ? s.workspaceUri : '');
      const cwd = normalizeProjectPath(rawWs) || undefined;
      const projInfo = resolveProjectInfo(rawWs);
      if (s.projectName && projInfo.path && !knownProjectMap.has(projInfo.key)) {
        projInfo.name = String(s.projectName).trim();
      }
      const startedAt = toTimestampMs(s.createdTime, Date.now());
      const endedAt = status === 'running' ? null : toTimestampMs(s.lastModifiedTime || s.createdTime, startedAt);
      const id = `session:${cid}`;
      const dto = {
        id,
        taskId: id,
        kind: 'session',
        title,
        subtitle: isSubagent ? 'Subagent 会话' : (cwd ? path.basename(cwd) : '主会话'),
        status,
        sessionId: cid,
        sessionTitle: title,
        cwd,
        projectPath: projInfo.path,
        projectName: projInfo.name,
        startedAt,
        endedAt,
        exitCode: null,
        stopCapability: buildStopCapability('session', status, permissionLevel)
      };

      sessionTitleMap.set(cid, title);
      sessionMarkerMap.set(cid, `${s.status || ''}:${s.stepCount || 0}:${s.lastModifiedTime || ''}`);
      sessionProjectMap.set(cid, projInfo);

      if (status === 'running') {
        running.push(dto);
        stepScanTargets.add(cid);
      } else {
        recent.push(dto);
      }
      detailIndex.set(id, { dto, rawLog: '', cascadeId: cid });
    }

    for (const s of sessions.slice(0, STEP_SCAN_SESSION_LIMIT)) {
      const cid = s?.cascadeId || s?.id;
      if (cid) stepScanTargets.add(cid);
    }
    if (targetSessionId && sessionTitleMap.has(targetSessionId)) {
      stepScanTargets.add(targetSessionId);
    }

    // 3. Command steps inside active & recent sessions
    await Promise.all(
      Array.from(stepScanTargets).map(async (cid) => {
        const steps = await fetchStepsCached(cid, sessionMarkerMap.get(cid) || '');
        const sessionTitle = sessionTitleMap.get(cid) || cid;
        const sessProj = sessionProjectMap.get(cid) || null;
        const cmdLogs = [];

        for (let i = 0; i < steps.length; i++) {
          const parsed = extractCommandStepFields(steps[i], i);
          if (!parsed) continue;
          if (parsed.combinedOutput) {
            cmdLogs.push(`$ ${parsed.commandLine}\n${parsed.combinedOutput}`);
          }
          const projInfo = resolveProjectInfo(parsed.cwd || '', sessProj);
          const id = `cmd:${cid}:${parsed.stepIndex}`;
          const dto = {
            id,
            taskId: id,
            kind: 'command',
            title: parsed.commandLine,
            subtitle: sessionTitle,
            status: parsed.status,
            sessionId: cid,
            sessionTitle,
            cwd: parsed.cwd || undefined,
            projectPath: projInfo.path,
            projectName: projInfo.name,
            startedAt: parsed.startedAt,
            endedAt: parsed.status === 'running' ? null : parsed.endedAt,
            exitCode: parsed.exitCode,
            stopCapability: buildStopCapability('command', parsed.status, permissionLevel)
          };
          detailIndex.set(id, {
            dto,
            rawLog: parsed.combinedOutput,
            isPendingApproval: parsed.isPendingApproval
          });
          if (parsed.status === 'running') running.push(dto);
          else recent.push(dto);
        }

        const sessEntry = detailIndex.get(`session:${cid}`);
        if (sessEntry) {
          sessEntry.rawLog = cmdLogs.join('\n\n') || `Session ${sessionTitle} (${sessEntry.dto.status})`;
        }
      })
    );

    const sortDesc = (a, b) => ((b.endedAt || b.startedAt || 0) - (a.endedAt || a.startedAt || 0));
    running.sort(sortDesc);
    recent.sort(sortDesc);

    return {
      running,
      recent,
      detailIndex,
      projectIdToKey
    };
  }

  async function listTasks(permissionLevel = 'L0', filterOpts = {}) {
    const filterSessionId = typeof filterOpts?.sessionId === 'string' ? filterOpts.sessionId.trim() : '';
    const filterProjectRaw = typeof filterOpts?.project === 'string' ? filterOpts.project.trim() : '';

    const { running: allRunning, recent: allRecent, projectIdToKey } = await collectAllTasks(permissionLevel, {
      targetSessionId: filterSessionId
    });

    const totalRunningCount = allRunning.length;
    const projectAggMap = new Map();
    const sessionAggMap = new Map();

    for (const dto of [...allRunning, ...allRecent]) {
      if (dto.projectPath) {
        const pKey = canonicalProjectKey(dto.projectPath);
        if (pKey) {
          let entry = projectAggMap.get(pKey);
          if (!entry) {
            entry = {
              key: pKey,
              name: dto.projectName || extractProjectBasename(dto.projectPath) || dto.projectPath,
              path: dto.projectPath,
              count: 0
            };
            projectAggMap.set(pKey, entry);
          }
          entry.count += 1;
        }
      }
      if (dto.sessionId) {
        const sid = String(dto.sessionId).trim();
        if (sid) {
          let entry = sessionAggMap.get(sid);
          if (!entry) {
            entry = {
              id: sid,
              title: dto.sessionTitle || (dto.kind === 'session' ? dto.title : dto.subtitle) || sid,
              projectPath: dto.projectPath || null,
              count: 0
            };
            sessionAggMap.set(sid, entry);
          } else if (!entry.projectPath && dto.projectPath) {
            entry.projectPath = dto.projectPath;
          }
          entry.count += 1;
        }
      }
    }

    const resolvedFilterProjectKey = filterProjectRaw
      ? (projectIdToKey.get(filterProjectRaw) || canonicalProjectKey(filterProjectRaw))
      : '';

    const matchesFilter = (dto) => {
      if (filterSessionId && dto.sessionId !== filterSessionId) {
        return false;
      }
      if (filterProjectRaw) {
        const taskProjKey = dto.projectPath ? canonicalProjectKey(dto.projectPath) : '';
        if (!taskProjKey || taskProjKey !== resolvedFilterProjectKey) {
          return false;
        }
      }
      return true;
    };

    const filteredRunning = (filterSessionId || filterProjectRaw)
      ? allRunning.filter(matchesFilter)
      : allRunning;
    const filteredRecent = (filterSessionId || filterProjectRaw)
      ? allRecent.filter(matchesFilter)
      : allRecent;

    return {
      ok: true,
      runningCount: filteredRunning.length,
      totalRunningCount,
      running: filteredRunning,
      recent: filteredRecent.slice(0, RECENT_TASKS_LIMIT),
      filters: {
        projects: Array.from(projectAggMap.values()).sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name)),
        sessions: Array.from(sessionAggMap.values())
      }
    };
  }

  async function getTaskDetail(taskId, permissionLevel = 'L0') {
    const cleanId = String(taskId || '').trim();
    if (!cleanId) {
      return { ok: false, statusCode: 400, error: 'TASK_ID_REQUIRED' };
    }
    const { detailIndex } = await collectAllTasks(permissionLevel);
    const entry = detailIndex.get(cleanId);
    if (!entry) {
      return { ok: false, statusCode: 404, error: 'TASK_NOT_FOUND', taskId: cleanId };
    }

    let rawLog = entry.rawLog;
    if (!rawLog && entry.cascadeId) {
      const steps = await fetchStepsCached(entry.cascadeId, String(Date.now()));
      const chunks = [];
      for (let i = 0; i < steps.length; i++) {
        const parsed = extractCommandStepFields(steps[i], i);
        if (parsed?.combinedOutput) {
          chunks.push(`$ ${parsed.commandLine}\n${parsed.combinedOutput}`);
        }
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

  async function stopTask(taskId, permissionLevel = 'L0') {
    const cleanId = String(taskId || '').trim();
    if (!cleanId) {
      return { ok: false, statusCode: 400, error: 'TASK_ID_REQUIRED' };
    }
    const { detailIndex } = await collectAllTasks(permissionLevel);
    const entry = detailIndex.get(cleanId);
    if (!entry) {
      return { ok: false, statusCode: 404, error: 'TASK_NOT_FOUND', taskId: cleanId };
    }

    const dto = entry.dto;
    if (dto.status !== 'running') {
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
      const rec = typeof ptyManager.getTaskRecord === 'function' ? ptyManager.getTaskRecord(ptyId) : null;
      if (!closeRes?.closed) {
        const finalStatus = rec ? normalizeTaskStatus(rec.status, 'completed') : 'completed';
        const updated = {
          ...dto,
          status: finalStatus,
          endedAt: rec?.endedAt || Date.now(),
          exitCode: rec?.exitCode ?? dto.exitCode ?? null,
          stopCapability: buildStopCapability('pty', finalStatus, permissionLevel)
        };
        return {
          ok: true,
          taskId: cleanId,
          alreadyFinished: true,
          status: finalStatus,
          exitCode: updated.exitCode,
          task: updated
        };
      }
      const updated = {
        ...dto,
        status: 'stopped',
        endedAt: rec?.endedAt || Date.now(),
        exitCode: rec?.exitCode ?? dto.exitCode ?? null,
        stopCapability: buildStopCapability('pty', 'stopped', permissionLevel)
      };
      return {
        ok: true,
        taskId: cleanId,
        alreadyFinished: false,
        status: 'stopped',
        exitCode: updated.exitCode,
        task: updated
      };
    }

    if (cleanId.startsWith('cmd:')) {
      const parts = cleanId.split(':');
      const stepIdx = Number(parts.pop());
      const cid = parts.slice(1).join(':');
      invalidateCache(cid);

      if (entry.isPendingApproval && typeof approveStep === 'function') {
        try {
          await approveStep(cid, stepIdx, 'deny');
          const updated = {
            ...dto,
            status: 'stopped',
            endedAt: Date.now(),
            stopCapability: buildStopCapability('command', 'stopped', permissionLevel)
          };
          return {
            ok: true,
            taskId: cleanId,
            alreadyFinished: false,
            status: 'stopped',
            exitCode: null,
            task: updated
          };
        } catch (err) {
          if (isAlreadyFinishedRpcError(err)) {
            const updated = {
              ...dto,
              status: 'completed',
              endedAt: Date.now(),
              stopCapability: buildStopCapability('command', 'completed', permissionLevel)
            };
            return {
              ok: true,
              taskId: cleanId,
              alreadyFinished: true,
              status: 'completed',
              exitCode: dto.exitCode ?? null,
              task: updated
            };
          }
          return {
            ok: false,
            statusCode: err?.statusCode || 502,
            error: err?.code || err?.message || 'STOP_TASK_FAILED'
          };
        }
      }

      let stopped = false;
      if (typeof callRpc === 'function' && Number.isInteger(stepIdx)) {
        try {
          await callRpc('CancelCascadeSteps', { cascadeId: cid, stepIndices: [stepIdx] });
          stopped = true;
        } catch (err) {
          if (isAlreadyFinishedRpcError(err)) {
            const updated = {
              ...dto,
              status: 'completed',
              endedAt: Date.now(),
              stopCapability: buildStopCapability('command', 'completed', permissionLevel)
            };
            return {
              ok: true,
              taskId: cleanId,
              alreadyFinished: true,
              status: 'completed',
              exitCode: dto.exitCode ?? null,
              task: updated
            };
          }
          stopped = false;
        }
      }

      if (!stopped && typeof cancelSession === 'function') {
        try {
          await cancelSession(cid);
          stopped = true;
        } catch (err) {
          if (isAlreadyFinishedRpcError(err)) {
            const updated = {
              ...dto,
              status: 'completed',
              endedAt: Date.now(),
              stopCapability: buildStopCapability('command', 'completed', permissionLevel)
            };
            return {
              ok: true,
              taskId: cleanId,
              alreadyFinished: true,
              status: 'completed',
              exitCode: dto.exitCode ?? null,
              task: updated
            };
          }
          return {
            ok: false,
            statusCode: err?.statusCode || 502,
            error: err?.code || err?.message || 'STOP_TASK_FAILED'
          };
        }
      }

      const updated = {
        ...dto,
        status: 'stopped',
        endedAt: Date.now(),
        stopCapability: buildStopCapability('command', 'stopped', permissionLevel)
      };
      return {
        ok: true,
        taskId: cleanId,
        alreadyFinished: false,
        status: 'stopped',
        exitCode: null,
        task: updated
      };
    }

    if (cleanId.startsWith('session:')) {
      const cid = cleanId.slice('session:'.length);
      invalidateCache(cid);
      if (typeof cancelSession !== 'function') {
        return { ok: false, statusCode: 503, error: 'HARNESS_ADAPTER_UNAVAILABLE' };
      }
      try {
        await cancelSession(cid);
        const updated = {
          ...dto,
          status: 'stopped',
          endedAt: Date.now(),
          stopCapability: buildStopCapability('session', 'stopped', permissionLevel)
        };
        return {
          ok: true,
          taskId: cleanId,
          alreadyFinished: false,
          status: 'stopped',
          exitCode: null,
          task: updated
        };
      } catch (err) {
        if (isAlreadyFinishedRpcError(err)) {
          const updated = {
            ...dto,
            status: 'completed',
            endedAt: Date.now(),
            stopCapability: buildStopCapability('session', 'completed', permissionLevel)
          };
          return {
            ok: true,
            taskId: cleanId,
            alreadyFinished: true,
            status: 'completed',
            exitCode: null,
            task: updated
          };
        }
        return {
          ok: false,
          statusCode: err?.statusCode || 502,
          error: err?.code || err?.message || 'STOP_TASK_FAILED'
        };
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
  truncateUtf8Tail,
  createTaskManager
};
