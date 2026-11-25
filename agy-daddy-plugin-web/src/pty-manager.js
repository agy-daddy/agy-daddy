'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');

const RING_BUFFER_BYTES = 65536;
const MAX_INPUT_BYTES = 65536;
const DEFAULT_MAX_SESSIONS = 8;
const RECENT_CLOSED_LIMIT = 20;
const PYTHON_PROBE_TIMEOUT_MS = 1500;

const PYTHON_PTY_SCRIPT = [
  'import os, sys, pty, fcntl, termios, struct, select, signal, json, errno',
  'cols = max(1, min(500, int(os.environ.get("AGY_PTY_COLS", "80"))))',
  'rows = max(1, min(200, int(os.environ.get("AGY_PTY_ROWS", "24"))))',
  'master, slave = pty.openpty()',
  'fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))',
  'pid = os.fork()',
  'if pid == 0:',
  '  os.close(master)',
  '  try: os.close(3)',
  '  except OSError: pass',
  '  os.setsid()',
  '  try: fcntl.ioctl(slave, termios.TIOCSCTTY, 0)',
  '  except OSError: pass',
  '  os.dup2(slave, 0)',
  '  os.dup2(slave, 1)',
  '  os.dup2(slave, 2)',
  '  if slave > 2: os.close(slave)',
  '  shell = os.environ.get("SHELL") or "/bin/sh"',
  '  if not os.path.exists(shell): shell = "/bin/sh"',
  '  os.execvpe(shell, [shell], os.environ)',
  'os.close(slave)',
  'os.set_blocking(master, False)',
  'ctrl_open = True',
  'stdin_open = True',
  'ctrl_buf = b""',
  'exit_code = 0',
  'def cleanup_child():',
  '  try: os.killpg(pid, signal.SIGHUP)',
  '  except OSError:',
  '    try: os.kill(pid, signal.SIGHUP)',
  '    except OSError: pass',
  'def on_term(signum, frame):',
  '  cleanup_child()',
  '  sys.exit(0)',
  'signal.signal(signal.SIGTERM, on_term)',
  'signal.signal(signal.SIGHUP, on_term)',
  'try:',
  '  while True:',
  '    rfds = [master] + ([0] if stdin_open else []) + ([3] if ctrl_open else [])',
  '    r, _, _ = select.select(rfds, [], [], 0.2)',
  '    if stdin_open and 0 in r:',
  '      d = os.read(0, 4096)',
  '      if not d:',
  '        stdin_open = False',
  '        break',
  '      view = memoryview(d)',
  '      while view:',
  '        try:',
  '          written = os.write(master, view)',
  '          view = view[written:]',
  '        except BlockingIOError:',
  '          select.select([], [master], [], 0.05)',
  '        except OSError:',
  '          stdin_open = False',
  '          break',
  '    if ctrl_open and 3 in r:',
  '      c = os.read(3, 4096)',
  '      if not c:',
  '        ctrl_open = False',
  '      else:',
  '        ctrl_buf += c',
  '        while b"\\n" in ctrl_buf:',
  '          line, ctrl_buf = ctrl_buf.split(b"\\n", 1)',
  '          try:',
  '            msg = json.loads(line.decode("utf-8"))',
  '            nc = max(1, min(500, int(msg.get("cols", cols))))',
  '            nr = max(1, min(200, int(msg.get("rows", rows))))',
  '            cols, rows = nc, nr',
  '            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))',
  '            try: os.killpg(pid, signal.SIGWINCH)',
  '            except OSError:',
  '              try: os.kill(pid, signal.SIGWINCH)',
  '              except OSError: pass',
  '          except Exception:',
  '            pass',
  '    if master in r:',
  '      while True:',
  '        try:',
  '          out = os.read(master, 16384)',
  '        except BlockingIOError:',
  '          break',
  '        except OSError as e:',
  '          if e.errno == errno.EIO:',
  '            out = b""',
  '            break',
  '          raise',
  '        if not out:',
  '          break',
  '        os.write(1, out)',
  '    wp, st = os.waitpid(pid, os.WNOHANG)',
  '    if wp != 0:',
  '      while True:',
  '        try:',
  '          tail = os.read(master, 16384)',
  '          if not tail: break',
  '          os.write(1, tail)',
  '        except OSError:',
  '          break',
  '      exit_code = os.waitstatus_to_exitcode(st) if hasattr(os, "waitstatus_to_exitcode") else 0',
  '      break',
  'finally:',
  '  try: os.close(master)',
  '  except OSError: pass',
  '  try:',
  '    wp, _ = os.waitpid(pid, os.WNOHANG)',
  '    if wp == 0:',
  '      cleanup_child()',
  '      os.waitpid(pid, 0)',
  '  except OSError:',
  '    pass',
  'sys.exit(exit_code)'
].join('\n');

function isTestMode() {
  return (
    process.env.AGY_DADDY_TEST_MODE === '1'
    || process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

function clampDim(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isInsideDir(targetPath, baseDir) {
  const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
  const a = caseInsensitive ? String(targetPath).toLowerCase() : String(targetPath);
  const b = caseInsensitive ? String(baseDir).toLowerCase() : String(baseDir);
  const rel = path.relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isForbiddenSystemRoot(p) {
  const norm = String(p || '').replace(/[\\/]+$/, '') || '/';
  if (norm === '/') return true;
  if (/^[A-Za-z]:$/i.test(norm)) return true;
  return false;
}

function resolveAllowedRoots(allowedRoots) {
  const raw = typeof allowedRoots === 'function' ? allowedRoots() : allowedRoots;
  if (!Array.isArray(raw)) return [];
  const realRoots = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !r || r.includes('\0')) continue;
    try {
      const real = fs.realpathSync(r);
      if (!isForbiddenSystemRoot(real)) {
        realRoots.push(real);
      }
    } catch {
      // Ignore non-existent roots
    }
  }
  return realRoots;
}

function sliceUtf8Tail(str, maxBytes) {
  const buf = Buffer.from(String(str || ''), 'utf8');
  if (buf.length <= maxBytes) return str;
  const tail = buf.subarray(buf.length - maxBytes);
  let offset = 0;
  while (offset < tail.length && offset < 3 && (tail[offset] & 0xc0) === 0x80) {
    offset++;
  }
  return tail.subarray(offset).toString('utf8');
}

class SeqRingBuffer64K {
  constructor(capacity = RING_BUFFER_BYTES) {
    this.capacity = capacity;
    this.entries = [];
    this.totalBytes = 0;
    this.latestSeq = 0;
  }

  pushText(chunkText) {
    if (!chunkText) return null;
    const text = sliceUtf8Tail(String(chunkText), this.capacity);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes === 0) return null;
    const seq = ++this.latestSeq;
    const entry = { seq, chunk: text, bytes };
    this.entries.push(entry);
    this.totalBytes += bytes;
    while (this.totalBytes > this.capacity && this.entries.length > 1) {
      const dropped = this.entries.shift();
      this.totalBytes -= dropped.bytes;
    }
    return entry;
  }

  replayAfter(afterSeq) {
    if (afterSeq === null || afterSeq === undefined || !Number.isInteger(Number(afterSeq)) || Number(afterSeq) < 0) {
      return [...this.entries];
    }
    const minSeq = Number(afterSeq);
    return this.entries.filter((e) => e.seq > minSeq);
  }

  snapshotText() {
    if (this.entries.length === 0) return '';
    return this.entries.map((e) => e.chunk).join('');
  }
}

class PtySession extends EventEmitter {
  constructor({ sessionId, title, cwd, cols = 80, rows = 24, pythonBin = 'python3', spawnFn = spawn } = {}) {
    super();
    this.sessionId = sessionId || crypto.randomUUID();
    this.cwd = cwd;
    this.shell = path.basename(process.env.SHELL || '/bin/sh') || 'sh';
    this.title = (typeof title === 'string' && title.trim())
      ? title.trim()
      : `${path.basename(cwd) || 'terminal'} (${this.shell})`;
    this.cols = clampDim(cols, 80, 1, 500);
    this.rows = clampDim(rows, 24, 1, 200);
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
    this.endedAt = null;
    this.exitCode = null;
    this.signal = null;
    this.sseClients = new Set();
    this.ring = new SeqRingBuffer64K(RING_BUFFER_BYTES);
    this.decoder = new StringDecoder('utf8');
    this.alive = true;
    this.disposed = false;
    this._recordedClosed = false;
    this._killTimer = null;

    this.child = spawnFn(pythonBin, ['-u', '-c', PYTHON_PTY_SCRIPT], {
      cwd: this.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        AGY_PTY_COLS: String(this.cols),
        AGY_PTY_ROWS: String(this.rows)
      },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    });

    const handleText = (text) => {
      if (!text) return;
      this.lastActivityAt = Date.now();
      const entry = this.ring.pushText(text);
      if (entry) {
        for (const client of this.sseClients) {
          client.sendOutput(entry.seq, entry.chunk, this.alive);
        }
        this.emit('output', entry);
      }
    };

    this.child.stdout?.on('data', (chunk) => {
      handleText(this.decoder.write(chunk));
    });

    this.child.stderr?.on('data', (chunk) => {
      handleText(this.decoder.write(chunk));
    });

    this.child.on('error', (err) => {
      this.alive = false;
      this.endedAt = this.endedAt || Date.now();
      this.emit('error', err);
    });

    this.child.on('exit', (code, signal) => {
      this.alive = false;
      this.endedAt = this.endedAt || Date.now();
      this.exitCode = code ?? null;
      this.signal = signal ?? null;
      if (this._killTimer) {
        clearTimeout(this._killTimer);
        this._killTimer = null;
      }
      const tail = this.decoder.end();
      if (tail) {
        handleText(tail);
      }
      for (const client of Array.from(this.sseClients)) {
        client.sendExit({
          exitCode: this.exitCode,
          signal: this.signal,
          endedAt: this.endedAt
        });
        client.close();
      }
      this.sseClients.clear();
      this.emit('exit', code, signal);
    });
  }

  write(data) {
    if (!this.alive || this.disposed || !this.child?.stdin || this.child.stdin.destroyed) {
      return false;
    }
    this.lastActivityAt = Date.now();
    try {
      this.child.stdin.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(cols, rows) {
    const nextCols = clampDim(cols, this.cols, 1, 500);
    const nextRows = clampDim(rows, this.rows, 1, 200);
    this.cols = nextCols;
    this.rows = nextRows;
    this.lastActivityAt = Date.now();
    const ctrlPipe = this.child?.stdio?.[3];
    if (!this.alive || this.disposed || !ctrlPipe || ctrlPipe.destroyed) {
      return false;
    }
    try {
      ctrlPipe.write(`${JSON.stringify({ cols: nextCols, rows: nextRows })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  attachSseClient(client, { afterSeq } = {}) {
    this.sseClients.add(client);
    this.lastActivityAt = Date.now();

    const replay = this.ring.replayAfter(afterSeq);
    for (const entry of replay) {
      client.sendOutput(entry.seq, entry.chunk, this.alive);
    }

    if (!this.alive) {
      client.sendExit({
        exitCode: this.exitCode,
        signal: this.signal,
        endedAt: this.endedAt || Date.now()
      });
      this.sseClients.delete(client);
      client.close();
      return;
    }

    client.onClose(() => {
      this.sseClients.delete(client);
      this.lastActivityAt = Date.now();
      this.emit('clientDetach', client);
    });
    this.emit('clientAttach', client);
  }

  toDto() {
    return {
      sessionId: this.sessionId,
      title: this.title,
      cwd: this.cwd,
      shell: this.shell,
      cols: this.cols,
      rows: this.rows,
      alive: this.alive,
      exitCode: this.exitCode,
      signal: this.signal,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      endedAt: this.endedAt,
      latestSeq: this.ring.latestSeq
    };
  }

  getLogSnapshot() {
    return this.ring.snapshotText();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.alive = false;
    this.endedAt = this.endedAt || Date.now();

    for (const client of Array.from(this.sseClients)) {
      try {
        client.sendExit({
          exitCode: this.exitCode,
          signal: this.signal || 'SIGTERM',
          endedAt: this.endedAt
        });
        client.close();
      } catch {}
    }
    this.sseClients.clear();

    try { this.child?.stdin?.end(); } catch {}
    try { this.child?.stdio?.[3]?.end(); } catch {}

    if (this.child && this.child.exitCode === null && !this.child.killed) {
      try {
        this.child.kill('SIGTERM');
      } catch {}
      this._killTimer = setTimeout(() => {
        this._killTimer = null;
        if (this.child && this.child.exitCode === null) {
          try { this.child.kill('SIGKILL'); } catch {}
        }
      }, 400);
      this._killTimer.unref?.();
    }
  }
}

/**
 * Manages SSE + HTTP POST interactive PTY terminal sessions for agy-daddy-plugin-web.
 */
function createPtyManager({
  allowedRoots = [],
  defaultCwd = '',
  idleTimeoutMs,
  maxSessions = DEFAULT_MAX_SESSIONS,
  pythonBin = 'python3',
  probeFn = null,
  spawnFn = spawn,
  onTaskUpdated = null
} = {}) {
  const sessions = new Map();
  const recentClosed = [];
  const idleTimers = new Map();
  let disposed = false;
  let cachedRuntime = null;
  let runtimeProbePromise = null;
  let sessionCounter = 0;

  const effectiveIdleMs = Number.isFinite(Number(idleTimeoutMs)) && Number(idleTimeoutMs) > 0
    ? Math.floor(Number(idleTimeoutMs))
    : (isTestMode() ? 60_000 : 600_000);
  const effectiveMax = Number.isFinite(Number(maxSessions)) && Number(maxSessions) >= 1
    ? Math.floor(Number(maxSessions))
    : DEFAULT_MAX_SESSIONS;

  async function checkRuntime() {
    if (cachedRuntime) return cachedRuntime;
    if (runtimeProbePromise) return runtimeProbePromise;

    runtimeProbePromise = (async () => {
      if (typeof probeFn === 'function') {
        const res = await Promise.resolve(probeFn());
        cachedRuntime = res && typeof res === 'object'
          ? { available: Boolean(res.available), reason: res.reason || null }
          : { available: Boolean(res), reason: res ? null : 'PYTHON_PTY_MISSING' };
        return cachedRuntime;
      }
      if (process.platform === 'win32') {
        cachedRuntime = { available: false, reason: 'UNSUPPORTED_PLATFORM' };
        return cachedRuntime;
      }
      cachedRuntime = await new Promise((resolve) => {
        execFile(pythonBin, ['-c', 'import pty'], { timeout: PYTHON_PROBE_TIMEOUT_MS }, (err) => {
          if (err) {
            resolve({ available: false, reason: 'PYTHON_PTY_MISSING' });
          } else {
            resolve({ available: true, reason: null });
          }
        });
      });
      return cachedRuntime;
    })();

    return runtimeProbePromise;
  }

  function resolveDefaultCwd() {
    return typeof defaultCwd === 'function' ? defaultCwd() : defaultCwd;
  }

  function validateCwd(rawCwd) {
    const roots = resolveAllowedRoots(allowedRoots);
    if (roots.length === 0) {
      return { ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' };
    }
    const def = resolveDefaultCwd();
    const candidate = (typeof rawCwd === 'string' && rawCwd.trim())
      ? rawCwd.trim()
      : (typeof def === 'string' && def.trim() ? def.trim() : roots[0]);

    if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) {
      return { ok: false, statusCode: 400, error: 'INVALID_CWD' };
    }

    let realCwd;
    try {
      realCwd = fs.realpathSync(candidate);
    } catch {
      return { ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' };
    }

    if (isForbiddenSystemRoot(realCwd) || !roots.some((r) => isInsideDir(realCwd, r))) {
      return { ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' };
    }

    let stat;
    try {
      stat = fs.statSync(realCwd);
    } catch {
      return { ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' };
    }
    if (!stat.isDirectory()) {
      return { ok: false, statusCode: 400, error: 'CWD_NOT_DIRECTORY' };
    }

    return { ok: true, realCwd };
  }

  function clearIdleTimer(sessionId) {
    const timer = idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(sessionId);
    }
  }

  function armIdleTimer(session) {
    clearIdleTimer(session.sessionId);
    if (disposed || session.sseClients.size > 0 || !session.alive) return;
    const timer = setTimeout(() => {
      idleTimers.delete(session.sessionId);
      if (session.sseClients.size === 0) {
        closeSession(session.sessionId);
      }
    }, effectiveIdleMs);
    timer.unref?.();
    idleTimers.set(session.sessionId, timer);
  }

  function recordClosedSession(session, statusOverride = null) {
    if (session._recordedClosed) return;
    session._recordedClosed = true;
    const dto = session.toDto();
    const entry = {
      ...dto,
      alive: false,
      endedAt: dto.endedAt || Date.now(),
      finalStatus: statusOverride || (dto.signal ? 'canceled' : (dto.exitCode && dto.exitCode !== 0 ? 'error' : 'done')),
      logSnapshot: session.getLogSnapshot(),
      replayEntries: session.ring.replayAfter(null)
    };
    const idx = recentClosed.findIndex((item) => item.sessionId === entry.sessionId);
    if (idx !== -1) recentClosed.splice(idx, 1);
    recentClosed.unshift(entry);
    if (recentClosed.length > RECENT_CLOSED_LIMIT) {
      recentClosed.length = RECENT_CLOSED_LIMIT;
    }
  }

  function findClosed(sessionId) {
    return recentClosed.find((item) => item.sessionId === sessionId) || null;
  }

  function emitTaskUpdate(sessionId, status) {
    if (typeof onTaskUpdated === 'function') {
      try {
        onTaskUpdated({
          runningCount: sessions.size,
          taskId: `pty:${sessionId}`,
          status
        });
      } catch {}
    }
  }

  function listSessions() {
    return Array.from(sessions.values()).map((s) => s.toDto());
  }

  function listAllForTasks() {
    const active = Array.from(sessions.values()).map((s) => ({
      ...s.toDto(),
      status: 'running',
      logSnapshot: s.getLogSnapshot()
    }));
    const closed = recentClosed.map((c) => ({
      ...c,
      status: c.finalStatus || (c.exitCode && c.exitCode !== 0 ? 'error' : 'done')
    }));
    return { active, recentClosed: closed };
  }

  async function createOrGetSession({ sessionId, cwd, title, cols = 80, rows = 24 } = {}) {
    if (disposed) {
      return { ok: false, statusCode: 503, error: 'PTY_MANAGER_DISPOSED' };
    }

    const runtime = await checkRuntime();
    if (!runtime.available) {
      return {
        ok: false,
        statusCode: 503,
        error: 'PTY_RUNTIME_UNAVAILABLE',
        reason: runtime.reason || 'PYTHON_PTY_MISSING'
      };
    }

    const cleanId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : '';
    if (cleanId && sessions.has(cleanId)) {
      const existing = sessions.get(cleanId);
      if (existing.alive && !existing.disposed) {
        if (cols !== undefined && rows !== undefined) {
          existing.resize(cols, rows);
        }
        return { ok: true, session: existing.toDto(), created: false };
      }
      sessions.delete(cleanId);
      clearIdleTimer(cleanId);
    }

    if (sessions.size >= effectiveMax) {
      return { ok: false, statusCode: 429, error: 'MAX_SESSIONS_REACHED', maxSessions: effectiveMax };
    }

    const cwdCheck = validateCwd(cwd);
    if (!cwdCheck.ok) return cwdCheck;

    sessionCounter += 1;
    const resolvedTitle = (typeof title === 'string' && title.trim())
      ? title.trim()
      : `#${sessionCounter} · ${path.basename(cwdCheck.realCwd) || 'shell'}`;

    const session = new PtySession({
      sessionId: cleanId || crypto.randomUUID(),
      title: resolvedTitle,
      cwd: cwdCheck.realCwd,
      cols,
      rows,
      pythonBin,
      spawnFn
    });

    sessions.set(session.sessionId, session);
    session.on('clientAttach', () => clearIdleTimer(session.sessionId));
    session.on('clientDetach', () => armIdleTimer(session));
    session.on('exit', () => {
      clearIdleTimer(session.sessionId);
      sessions.delete(session.sessionId);
      recordClosedSession(session);
      emitTaskUpdate(session.sessionId, session.exitCode && session.exitCode !== 0 ? 'error' : 'done');
    });
    armIdleTimer(session);
    emitTaskUpdate(session.sessionId, 'running');

    return { ok: true, session: session.toDto(), created: true };
  }

  function attachSseClient(sessionId, client, { afterSeq } = {}) {
    const active = sessions.get(sessionId);
    if (active) {
      active.attachSseClient(client, { afterSeq });
      return { ok: true, alive: active.alive };
    }
    const closed = findClosed(sessionId);
    if (closed) {
      const minSeq = (afterSeq !== null && afterSeq !== undefined && Number.isInteger(Number(afterSeq)))
        ? Number(afterSeq)
        : -1;
      for (const entry of closed.replayEntries || []) {
        if (entry.seq > minSeq) {
          client.sendOutput(entry.seq, entry.chunk, false);
        }
      }
      client.sendExit({
        exitCode: closed.exitCode,
        signal: closed.signal,
        endedAt: closed.endedAt
      });
      client.close();
      return { ok: true, alive: false };
    }
    return { ok: false, statusCode: 404, error: 'TERMINAL_SESSION_NOT_FOUND' };
  }

  function writeInput(sessionId, data) {
    if (typeof data !== 'string') {
      return { ok: false, statusCode: 400, error: 'INVALID_TERMINAL_INPUT' };
    }
    if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) {
      return { ok: false, statusCode: 413, error: 'PAYLOAD_TOO_LARGE' };
    }
    const active = sessions.get(sessionId);
    if (!active) {
      if (findClosed(sessionId)) {
        return { ok: false, statusCode: 409, error: 'TERMINAL_EXITED' };
      }
      return { ok: false, statusCode: 404, error: 'TERMINAL_SESSION_NOT_FOUND' };
    }
    if (!active.alive || active.disposed) {
      return { ok: false, statusCode: 409, error: 'TERMINAL_EXITED' };
    }
    const written = active.write(data);
    if (!written) {
      return { ok: false, statusCode: 409, error: 'TERMINAL_EXITED' };
    }
    return { ok: true, sessionId };
  }

  function resizeSession(sessionId, cols, rows) {
    const active = sessions.get(sessionId);
    if (!active) {
      if (findClosed(sessionId)) {
        return { ok: false, statusCode: 409, error: 'TERMINAL_EXITED' };
      }
      return { ok: false, statusCode: 404, error: 'TERMINAL_SESSION_NOT_FOUND' };
    }
    if (!active.alive || active.disposed) {
      return { ok: false, statusCode: 409, error: 'TERMINAL_EXITED' };
    }
    active.resize(cols, rows);
    return { ok: true, sessionId, cols: active.cols, rows: active.rows };
  }

  function closeSession(sessionId) {
    clearIdleTimer(sessionId);
    const session = sessions.get(sessionId);
    if (!session) {
      return { ok: true, closed: false, alreadyClosed: true };
    }
    sessions.delete(sessionId);
    session.dispose();
    recordClosedSession(session, 'canceled');
    emitTaskUpdate(sessionId, 'canceled');
    return { ok: true, closed: true, alreadyClosed: false };
  }

  function getTaskSnapshot(sessionId) {
    const active = sessions.get(sessionId);
    if (active) {
      return {
        ...active.toDto(),
        status: 'running',
        logSnapshot: active.getLogSnapshot()
      };
    }
    const closed = findClosed(sessionId);
    if (closed) {
      return {
        ...closed,
        status: closed.finalStatus || (closed.exitCode && closed.exitCode !== 0 ? 'error' : 'done')
      };
    }
    return null;
  }

  function disposeAll() {
    disposed = true;
    for (const timer of idleTimers.values()) {
      clearTimeout(timer);
    }
    idleTimers.clear();
    for (const session of Array.from(sessions.values())) {
      session.dispose();
      recordClosedSession(session, 'canceled');
    }
    sessions.clear();
  }

  return {
    maxSessions: effectiveMax,
    checkRuntime,
    listSessions,
    listAllForTasks,
    createOrGetSession,
    attachSseClient,
    writeInput,
    resizeSession,
    closeSession,
    getTaskSnapshot,
    disposeAll
  };
}

module.exports = {
  RING_BUFFER_BYTES,
  MAX_INPUT_BYTES,
  DEFAULT_MAX_SESSIONS,
  SeqRingBuffer64K,
  PtySession,
  createPtyManager
};
