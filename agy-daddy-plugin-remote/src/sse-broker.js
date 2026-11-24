'use strict';

const crypto = require('node:crypto');

const DEFAULT_RING_BUFFER_SIZE = 200;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_POLL_INTERVAL_MS = 350;
const DEFAULT_ACTIVE_POLL_INTERVAL_MS = 180;
const ATTENTION_STATES = new Set(['PENDING', 'ERROR', 'DONE']);
const NON_TERMINAL_STEP_STATES = new Set(['generating', 'running', 'pending']);

function formatSseFrame(entry) {
  return `id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`;
}

function classifyRunStatus(rawStatus) {
  const up = String(rawStatus || '').trim().toUpperCase();
  if (!up) return '';
  if (up.includes('RUNNING') || up.includes('GENERATING')) return 'RUNNING';
  if (up.includes('PENDING') || up.includes('WAITING')) return 'PENDING';
  if (up.includes('ERROR') || up.includes('FAIL')) return 'ERROR';
  if (up.includes('IDLE')) return 'IDLE';
  if (up.includes('DONE')) return 'DONE';
  return up;
}

function parseLastEventId(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function normalizeQueueEntry(cascadeId, item) {
  const queueId = typeof item.queueId === 'string' && item.queueId.trim()
    ? item.queueId.trim()
    : (typeof item.id === 'string' && item.id.trim() ? item.id.trim() : crypto.randomUUID());
  const createdAt = Number(item.createdAt || item.enqueuedAt) || Date.now();
  return {
    ...item,
    id: queueId,
    queueId,
    sessionId: cascadeId,
    cascadeId,
    text: String(item.text || ''),
    modelId: item.modelId || undefined,
    mode: item.mode || 'chat',
    dispatchMode: item.dispatchMode || 'queue',
    status: item.status || 'queued',
    createdAt,
    enqueuedAt: createdAt
  };
}

/**
 * Creates a multiplexed SSE broker with ring-buffer Last-Event-ID replay,
 * adaptive stepOffset delta polling, attention transition hooks, and FIFO/Steer queue dispatch.
 */
function createSseBroker({
  ringBufferSize = DEFAULT_RING_BUFFER_SIZE,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  activePollIntervalMs = DEFAULT_ACTIVE_POLL_INTERVAL_MS,
  getDelta = null,
  listSessions = null,
  getTelemetry = null,
  dispatchMessage = null,
  onAttentionTransition = null
} = {}) {
  const maxRing = Number.isFinite(Number(ringBufferSize)) && Number(ringBufferSize) >= 1
    ? Math.floor(Number(ringBufferSize))
    : DEFAULT_RING_BUFFER_SIZE;
  const heartbeatMs = Number.isFinite(Number(heartbeatIntervalMs)) && Number(heartbeatIntervalMs) >= 0
    ? Math.floor(Number(heartbeatIntervalMs))
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
  const pollMs = Number.isFinite(Number(pollIntervalMs)) && Number(pollIntervalMs) >= 0
    ? Math.floor(Number(pollIntervalMs))
    : DEFAULT_POLL_INTERVAL_MS;
  const activePollMs = Number.isFinite(Number(activePollIntervalMs)) && Number(activePollIntervalMs) > 0
    ? Math.floor(Number(activePollIntervalMs))
    : DEFAULT_ACTIVE_POLL_INTERVAL_MS;

  const clients = new Set();
  const ringBuffer = [];
  const queues = new Map(); // cascadeId -> Array<queueItem>
  const sessionStates = new Map(); // cascadeId -> { status, needsAttention, attentionReason }
  const sessionOffsets = new Map(); // sessionId -> number
  const sessionDeltaMeta = new Map(); // sessionId -> { lastStatus, lastTotalSteps, active }

  let nextEventId = 1;
  let heartbeatTimer = null;
  let pollTimer = null;
  let currentPollTimerMs = null;
  let pollInFlight = false;
  let pollPending = false;
  let lastTelemetryJson = null;
  let disposed = false;

  function hasPendingQueues() {
    for (const q of queues.values()) {
      if (q.length > 0) return true;
    }
    return false;
  }

  function hasActiveStreaming() {
    for (const client of clients) {
      if (!client.sessionId) continue;
      const meta = sessionDeltaMeta.get(client.sessionId);
      if (meta?.active) return true;
      const st = sessionStates.get(client.sessionId);
      if (st && classifyRunStatus(st.status) === 'RUNNING') return true;
    }
    return false;
  }

  function clientMatchesSession(clientSessionId, eventSessionId) {
    if (!clientSessionId || !eventSessionId) return true;
    return clientSessionId === eventSessionId;
  }

  function writeToClient(client, chunk) {
    if (disposed || client.closed || client.res.writableEnded || client.res.destroyed) {
      return false;
    }
    try {
      client.res.write(chunk);
      return true;
    } catch {
      cleanupClient(client);
      return false;
    }
  }

  function emit(eventName, data, { sessionId = null } = {}) {
    if (disposed) return null;
    const entry = {
      id: nextEventId++,
      event: String(eventName || 'message'),
      data: data === undefined ? null : data,
      sessionId: sessionId || null,
      timestamp: Date.now()
    };

    ringBuffer.push(entry);
    if (ringBuffer.length > maxRing) {
      ringBuffer.splice(0, ringBuffer.length - maxRing);
    }

    const frame = formatSseFrame(entry);
    for (const client of Array.from(clients)) {
      if (clientMatchesSession(client.sessionId, entry.sessionId)) {
        writeToClient(client, frame);
      }
    }

    return entry;
  }

  function cleanupClient(client) {
    if (!clients.has(client)) return;
    client.closed = true;
    clients.delete(client);
    try {
      if (!client.res.writableEnded && !client.res.destroyed) {
        client.res.end();
      }
    } catch {
      // Ignore stream end errors
    }
    updateTimers();
  }

  function stopPollTimer() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      currentPollTimerMs = null;
    }
  }

  function stopHeartbeatTimer() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function updateTimers() {
    if (disposed) {
      stopPollTimer();
      stopHeartbeatTimer();
      return;
    }

    if (clients.size > 0 && heartbeatMs > 0 && !heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        for (const client of Array.from(clients)) {
          writeToClient(client, ': heartbeat\n\n');
        }
      }, heartbeatMs);
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    } else if (clients.size === 0) {
      stopHeartbeatTimer();
    }

    const shouldPoll = (clients.size > 0 || hasPendingQueues()) &&
      pollMs > 0 &&
      (typeof getDelta === 'function' || typeof listSessions === 'function' || typeof getTelemetry === 'function');

    if (shouldPoll) {
      const desiredMs = hasActiveStreaming() ? Math.min(pollMs, activePollMs) : pollMs;
      if (!pollTimer || currentPollTimerMs !== desiredMs) {
        stopPollTimer();
        currentPollTimerMs = desiredMs;
        pollTimer = setInterval(() => {
          void pollOnce();
        }, desiredMs);
        if (typeof pollTimer.unref === 'function') pollTimer.unref();
      }
    } else {
      stopPollTimer();
    }
  }

  async function processQueueDispatch(cascadeId) {
    const queue = queues.get(cascadeId);
    if (!queue || queue.length === 0) return;

    const item = queue.shift();
    if (queue.length === 0) {
      queues.delete(cascadeId);
    }

    const snapshotQueue = queue.map((q) => ({ ...q }));
    emit('queue.update', {
      cascadeId,
      sessionId: cascadeId,
      action: 'dispatching',
      item: { ...item, status: 'sending' },
      remaining: snapshotQueue.length,
      queue: snapshotQueue
    }, { sessionId: cascadeId });

    if (typeof dispatchMessage !== 'function') return;

    try {
      const result = await dispatchMessage(cascadeId, item);
      emit('queue.update', {
        cascadeId,
        sessionId: cascadeId,
        action: 'dispatched',
        item,
        remaining: snapshotQueue.length,
        queue: snapshotQueue,
        result
      }, { sessionId: cascadeId });
    } catch (err) {
      emit('queue.update', {
        cascadeId,
        sessionId: cascadeId,
        action: 'failed',
        item: { ...item, status: 'failed', error: err && err.message ? err.message : 'QUEUE_DISPATCH_FAILED' },
        remaining: snapshotQueue.length,
        queue: snapshotQueue,
        error: err && err.message ? err.message : 'QUEUE_DISPATCH_FAILED'
      }, { sessionId: cascadeId });
    }
  }

  async function pollSessions() {
    if (typeof listSessions !== 'function') return;
    const raw = await listSessions();
    const sessions = Array.isArray(raw) ? raw : (Array.isArray(raw?.sessions) ? raw.sessions : []);

    for (const s of sessions) {
      if (!s || typeof s !== 'object') continue;
      const cascadeId = s.cascadeId || s.id;
      if (!cascadeId) continue;

      const nextStatus = classifyRunStatus(s.status);
      const nextAttention = Boolean(s.needsAttention);
      const nextReason = String(s.attentionReason || '');
      const prev = sessionStates.get(cascadeId);

      sessionStates.set(cascadeId, {
        status: nextStatus,
        needsAttention: nextAttention,
        attentionReason: nextReason
      });

      if (!prev) {
        if (nextAttention || ATTENTION_STATES.has(nextStatus)) {
          const payload = {
            cascadeId,
            status: nextStatus,
            prevStatus: '',
            needsAttention: nextAttention,
            attentionReason: nextReason,
            title: s.title || '',
            session: s
          };
          emit('attention.update', payload);
          if (typeof onAttentionTransition === 'function') {
            try { await onAttentionTransition(payload); } catch {}
          }
        }
        continue;
      }

      const statusChanged = prev.status !== nextStatus;
      const enteredAttentionStatus = statusChanged && ATTENTION_STATES.has(nextStatus);
      const attentionFlippedOn = !prev.needsAttention && nextAttention;
      const attentionReasonChanged = nextAttention && prev.attentionReason !== nextReason;

      if (enteredAttentionStatus || attentionFlippedOn || attentionReasonChanged) {
        const payload = {
          cascadeId,
          status: nextStatus,
          prevStatus: prev.status,
          needsAttention: nextAttention,
          attentionReason: nextReason,
          title: s.title || '',
          session: s
        };
        emit('attention.update', payload);
        if (typeof onAttentionTransition === 'function') {
          try { await onAttentionTransition(payload); } catch {}
        }
      }

      if (prev.status === 'RUNNING' && nextStatus === 'IDLE') {
        await processQueueDispatch(cascadeId);
      }
    }
  }

  async function pollDeltas() {
    if (typeof getDelta !== 'function' || clients.size === 0) return;

    const watchedSessionIds = new Set();
    for (const client of clients) {
      if (client.sessionId) watchedSessionIds.add(client.sessionId);
    }

    for (const sid of watchedSessionIds) {
      const currentOffset = sessionOffsets.get(sid) ?? 0;
      const delta = await getDelta(sid, currentOffset);
      if (!delta || typeof delta !== 'object') continue;

      const events = Array.isArray(delta.events) ? delta.events : [];
      const nextOffset = Number.isFinite(Number(delta.nextOffset))
        ? Number(delta.nextOffset)
        : (Number.isFinite(Number(delta.stepOffset)) ? Number(delta.stepOffset) : currentOffset + events.length);

      const rawStatus = String(delta.status || delta.session?.status || '').trim();
      const prevMeta = sessionDeltaMeta.get(sid) || null;
      const effectiveStatus = rawStatus || prevMeta?.lastStatus || 'CASCADE_RUN_STATUS_IDLE';
      const totalSteps = Number.isFinite(Number(delta.totalSteps))
        ? Number(delta.totalSteps)
        : (Number.isFinite(Number(delta.session?.numTotalSteps))
          ? Number(delta.session.numTotalSteps)
          : Math.max(nextOffset, currentOffset + events.length, prevMeta?.lastTotalSteps || 0));

      const hasNonTerminalEvent = events.some((ev) => NON_TERMINAL_STEP_STATES.has(String(ev?.status || '').toLowerCase()));
      const isActive = hasNonTerminalEvent || classifyRunStatus(effectiveStatus) === 'RUNNING';
      const statusChanged = Boolean(rawStatus && prevMeta && prevMeta.lastStatus && prevMeta.lastStatus !== rawStatus);

      sessionDeltaMeta.set(sid, {
        lastStatus: effectiveStatus,
        lastTotalSteps: totalSteps,
        active: isActive
      });

      if (events.length > 0 || nextOffset > currentOffset || statusChanged) {
        sessionOffsets.set(sid, nextOffset);
        const sessionObj = delta.session
          ? {
              cascadeId: sid,
              status: effectiveStatus,
              numTotalSteps: totalSteps,
              ...delta.session
            }
          : {
              cascadeId: sid,
              status: effectiveStatus,
              numTotalSteps: totalSteps
            };

        emit('session.delta', {
          cascadeId: sid,
          sessionId: sid,
          status: effectiveStatus,
          totalSteps,
          stepOffset: currentOffset,
          nextOffset,
          events,
          session: sessionObj
        }, { sessionId: sid });
      }
    }
  }

  async function pollTelemetry() {
    if (typeof getTelemetry !== 'function' || clients.size === 0) return;
    const tel = await getTelemetry();
    if (!tel || typeof tel !== 'object') return;
    const serialized = JSON.stringify(tel);
    if (serialized !== lastTelemetryJson) {
      lastTelemetryJson = serialized;
      emit('telemetry.patch', tel);
    }
  }

  async function pollOnce() {
    if (disposed) return;
    if (pollInFlight) {
      pollPending = true;
      return;
    }
    pollInFlight = true;
    try {
      await pollSessions();
      await pollDeltas();
      await pollTelemetry();
    } catch {
      // Swallow transient poll errors so stream stays alive
    } finally {
      pollInFlight = false;
      updateTimers();
      if (pollPending && !disposed) {
        pollPending = false;
        void pollOnce();
      }
    }
  }

  function triggerPoll() {
    if (disposed) return;
    void pollOnce();
  }

  function handleStreamRequest(req, res, {
    sessionId = null,
    clientId = '',
    channel = 'loopback',
    permissionLevel = 'L0',
    lastEventId = undefined,
    stepOffset = undefined
  } = {}) {
    if (disposed) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'SSE_BROKER_DISPOSED' }));
      return null;
    }

    const cleanSessionId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
    if (cleanSessionId && Number.isFinite(Number(stepOffset)) && Number(stepOffset) >= 0) {
      sessionOffsets.set(cleanSessionId, Math.floor(Number(stepOffset)));
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const client = {
      res,
      sessionId: cleanSessionId,
      clientId: String(clientId || ''),
      channel: String(channel || 'loopback'),
      permissionLevel: String(permissionLevel || 'L0'),
      closed: false
    };
    clients.add(client);

    const headerLastId = req?.headers?.['last-event-id'];
    const resumeFromId = parseLastEventId(lastEventId !== undefined ? lastEventId : headerLastId);

    if (resumeFromId !== null) {
      for (const entry of ringBuffer) {
        if (entry.id > resumeFromId && clientMatchesSession(cleanSessionId, entry.sessionId)) {
          writeToClient(client, formatSseFrame(entry));
        }
      }
    } else {
      writeToClient(client, ': connected\n\n');
    }

    const onClose = () => cleanupClient(client);
    if (req && typeof req.on === 'function') req.on('close', onClose);
    if (typeof res.on === 'function') {
      res.on('close', onClose);
      res.on('error', onClose);
    }

    updateTimers();
    return client;
  }

  function enqueueMessage(cascadeId, item) {
    if (disposed) {
      return { ok: false, statusCode: 503, error: 'SSE_BROKER_DISPOSED' };
    }
    if (typeof cascadeId !== 'string' || !cascadeId.trim()) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }
    if (!item || typeof item !== 'object') {
      return { ok: false, statusCode: 400, error: 'INVALID_QUEUE_ITEM' };
    }

    const id = cascadeId.trim();
    const queue = queues.get(id) || [];
    const entry = normalizeQueueEntry(id, item);
    queue.push(entry);
    queues.set(id, queue);

    const snapshotQueue = queue.map((q) => ({ ...q }));
    emit('queue.update', {
      cascadeId: id,
      sessionId: id,
      action: 'enqueued',
      item: entry,
      remaining: snapshotQueue.length,
      queue: snapshotQueue
    }, { sessionId: id });

    updateTimers();
    return {
      ok: true,
      cascadeId: id,
      queueId: entry.queueId,
      item: entry,
      queue: snapshotQueue
    };
  }

  function listQueue(cascadeId) {
    const id = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    const queue = queues.get(id);
    return queue ? queue.map((item) => ({ ...item })) : [];
  }

  function removeQueuedMessage(cascadeId, queueId) {
    const id = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    const qid = typeof queueId === 'string' ? queueId.trim() : '';
    const queue = queues.get(id);
    if (!queue) {
      return { ok: true, removed: false, cascadeId: id, queueId: qid, queue: [] };
    }

    const idx = queue.findIndex((item) => item.queueId === qid || item.id === qid);
    if (idx < 0) {
      return { ok: true, removed: false, cascadeId: id, queueId: qid, queue: queue.map((q) => ({ ...q })) };
    }

    const [removedItem] = queue.splice(idx, 1);
    if (queue.length === 0) {
      queues.delete(id);
    }

    const snapshotQueue = queue.map((q) => ({ ...q }));
    emit('queue.update', {
      cascadeId: id,
      sessionId: id,
      action: 'removed',
      item: removedItem,
      remaining: snapshotQueue.length,
      queue: snapshotQueue
    }, { sessionId: id });

    updateTimers();
    return {
      ok: true,
      removed: true,
      cascadeId: id,
      queueId: removedItem.queueId,
      item: removedItem,
      queue: snapshotQueue
    };
  }

  async function steerQueuedMessage(cascadeId, queueId) {
    if (disposed) {
      return { ok: false, statusCode: 503, error: 'SSE_BROKER_DISPOSED' };
    }
    const id = typeof cascadeId === 'string' ? cascadeId.trim() : '';
    const qid = typeof queueId === 'string' ? queueId.trim() : '';
    const queue = queues.get(id);
    if (!queue) {
      return { ok: false, statusCode: 404, error: 'QUEUE_ITEM_NOT_FOUND', cascadeId: id, queue: [] };
    }

    const idx = queue.findIndex((item) => item.queueId === qid || item.id === qid);
    if (idx < 0) {
      return { ok: false, statusCode: 404, error: 'QUEUE_ITEM_NOT_FOUND', cascadeId: id, queue: queue.map((q) => ({ ...q })) };
    }

    const [removedItem] = queue.splice(idx, 1);
    if (queue.length === 0) {
      queues.delete(id);
    }
    const snapshotQueue = queue.map((q) => ({ ...q }));
    const steerItem = { ...removedItem, dispatchMode: 'steer' };

    let result = { ok: true };
    if (typeof dispatchMessage === 'function') {
      result = await dispatchMessage(id, steerItem);
    }

    emit('queue.update', {
      cascadeId: id,
      sessionId: id,
      action: 'steered',
      item: steerItem,
      remaining: snapshotQueue.length,
      queue: snapshotQueue,
      result
    }, { sessionId: id });

    updateTimers();
    triggerPoll();
    return {
      ok: true,
      steered: true,
      cascadeId: id,
      queueId: removedItem.queueId,
      item: steerItem,
      queue: snapshotQueue,
      result
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopPollTimer();
    stopHeartbeatTimer();
    for (const client of Array.from(clients)) {
      client.closed = true;
      try {
        if (!client.res.writableEnded && !client.res.destroyed) {
          client.res.end();
        }
      } catch {
        // Ignore end errors
      }
    }
    clients.clear();
    queues.clear();
    sessionStates.clear();
    sessionOffsets.clear();
    sessionDeltaMeta.clear();
  }

  return {
    handleStreamRequest,
    emit,
    enqueueMessage,
    listQueue,
    removeQueuedMessage,
    steerQueuedMessage,
    triggerPoll,
    dispose
  };
}

module.exports = {
  classifyRunStatus,
  createSseBroker
};
