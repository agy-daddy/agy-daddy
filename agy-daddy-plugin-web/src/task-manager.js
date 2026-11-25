'use strict';

const LOG_TAIL_MAX_BYTES = 65536;
const RECENT_TASKS_LIMIT = 20;
const STEP_SCAN_SESSION_LIMIT = 8;
const STEP_SCAN_CACHE_TTL_MS = 2500;

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
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
function createTaskManager({ rpc = null, harnessAdapter = null, ptyManager = null, cacheTtlMs = STEP_SCAN_CACHE_TTL_MS } = {}) {
  const stepCache = new Map(); // cascadeId -> { fetchedAt, marker, steps }

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
    let steps = [];
    if (rpc && typeof rpc.call === 'function') {
      try {
        const resp = await rpc.call('GetCascadeTrajectorySteps', { cascadeId, stepOffset: 0 });
        steps = Array.isArray(resp?.steps)
          ? resp.steps
          : (Array.isArray(resp?.trajectory?.steps) ? resp.trajectory.steps : []);
      } catch {
        if (harnessAdapter && typeof harnessAdapter.getSessionDetail === 'function') {
          try {
            const detail = await harnessAdapter.getSessionDetail(cascadeId);
            steps = Array.isArray(detail?.events) ? detail.events : [];
          } catch {
            steps = [];
          }
        }
      }
    } else if (harnessAdapter && typeof harnessAdapter.getSessionDetail === 'function') {
      try {
        const detail = await harnessAdapter.getSessionDetail(cascadeId);
        steps = Array.isArray(detail?.events) ? detail.events : [];
      } catch {
        steps = [];
      }
    }
    stepCache.set(cascadeId, { fetchedAt: now, marker, steps });
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

  async function collectAllTasks() {
    const running = [];
    const recent = [];
    const detailIndex = new Map();

    // 1. Web PTY sessions
    if (ptyManager && typeof ptyManager.listAllForTasks === 'function') {
      const ptyData = ptyManager.listAllForTasks();
      for (const item of [...(ptyData.active || []), ...(ptyData.recentClosed || [])]) {
        const taskId = `pty:${item.sessionId}`;
        const status = item.alive ? 'running' : (item.status || 'done');
        const startedAt = toIsoOrNull(item.createdAt);
        const endedAt = item.alive ? null : toIsoOrNull(item.endedAt || item.lastActivityAt);
        const dto = {
          taskId,
          kind: 'pty',
          title: item.title || `Terminal (${item.shell || 'sh'})`,
          commandLine: `${item.shell || 'sh'} (${item.cwd || ''})`,
          cwd: item.cwd || null,
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

    // 2. Sessions & subagents + run_command steps
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

    const sessionDetailTargetIds = new Set();
    for (const s of sessions) {
      const cid = s?.cascadeId;
      if (!cid) continue;
      const status = mapSessionStatus(s.status, s.notFullyIdle, s.killed);
      const isSub = Boolean(s.isSubagent);
      const kind = isSub ? 'subagent' : 'session';
      const title = s.title || s.agentName || (isSub ? 'Subagent' : 'Session');
      const startedAt = toIsoOrNull(s.createdTime);
      const endedAt = status === 'running' ? null : toIsoOrNull(s.lastCompletedTime || s.lastModifiedTime);
      const taskId = `session:${cid}`;
      const dto = {
        taskId,
        kind,
        title,
        commandLine: null,
        cwd: s.workspacePath || null,
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
      } else if (isSub || sessionDetailTargetIds.size < STEP_SCAN_SESSION_LIMIT) {
        recent.push(dto);
      }
      detailIndex.set(taskId, {
        dto,
        rawLog: '',
        cascadeId: cid
      });
    }

    for (const s of sessions.slice(0, STEP_SCAN_SESSION_LIMIT)) {
      if (s?.cascadeId) sessionDetailTargetIds.add(s.cascadeId);
    }

    const sessionTitleMap = new Map(sessions.map((s) => [s.cascadeId, s.title || s.agentName || s.cascadeId]));
    const sessionMarkerMap = new Map(
      sessions.map((s) => [s.cascadeId, `${s.status || ''}:${s.stepCount || 0}:${s.lastModifiedTime || ''}`])
    );

    await Promise.all(
      Array.from(sessionDetailTargetIds).map(async (cid) => {
        const steps = await fetchStepsCached(cid, sessionMarkerMap.get(cid) || '');
        const sessionTitle = sessionTitleMap.get(cid) || cid;
        const cmdLogsForSession = [];
        for (let i = 0; i < steps.length; i++) {
          const parsed = extractCommandStepFields(steps[i], i);
          if (!parsed) continue;
          if (parsed.combinedOutput) {
            cmdLogsForSession.push(`$ ${parsed.commandLine}\n${parsed.combinedOutput}`);
          }
          const taskId = `cmd:${cid}:${parsed.stepIndex}`;
          const isActive = parsed.status === 'running' || parsed.status === 'pending';
          const dto = {
            taskId,
            kind: 'command',
            title: parsed.commandLine,
            commandLine: parsed.commandLine,
            cwd: parsed.cwd,
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
      })
    );

    const sortByTimeDesc = (a, b) => {
      const tb = Date.parse(b.endedAt || b.startedAt || '') || 0;
      const ta = Date.parse(a.endedAt || a.startedAt || '') || 0;
      return tb - ta;
    };

    running.sort(sortByTimeDesc);
    recent.sort(sortByTimeDesc);

    return {
      running,
      recent: recent.slice(0, RECENT_TASKS_LIMIT),
      detailIndex
    };
  }

  async function listTasks() {
    const { running, recent } = await collectAllTasks();
    return {
      ok: true,
      runningCount: running.length,
      running,
      recent,
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
  truncateUtf8Tail,
  createTaskManager
};
