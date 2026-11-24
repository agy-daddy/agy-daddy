'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_WS_FRAME_BYTES = 16 * 1024 * 1024;
const RING_BUFFER_BYTES = 65536;
const DEFAULT_IDLE_TIMEOUT_MS = 600000;
const DEFAULT_MAX_SESSIONS = 8;

const OPCODE_CONT = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xA;

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

function encodeWsFrame(opcode, payloadBuf, fin = true) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || '');
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len <= 65535) headerLen += 2;
  else if (len > 65535) headerLen += 8;

  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);

  if (len < 126) {
    frame[1] = len;
  } else if (len <= 65535) {
    frame[1] = 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }

  if (len > 0) {
    payload.copy(frame, headerLen);
  }
  return frame;
}

/**
 * Pure Node RFC 6455 WebSocket server-side upgrade & framing EventEmitter.
 */
function acceptWebSocket(req, socket, head = Buffer.alloc(0)) {
  const upgrade = String(req?.headers?.upgrade || '').toLowerCase();
  const key = String(req?.headers?.['sec-websocket-key'] || '').trim();
  if (upgrade !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    throw new Error('INVALID_WEBSOCKET_UPGRADE');
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + WS_MAGIC_GUID, 'utf8')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n'
  );

  if (typeof socket.setNoDelay === 'function') {
    socket.setNoDelay(true);
  }

  const emitter = new EventEmitter();
  emitter.readyState = 'OPEN';

  let buffer = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  let closeSent = false;
  let closedEmitted = false;
  let fragOpcode = null;
  let fragChunks = [];
  let fragTotalBytes = 0;

  function emitClose(code = 1005, reason = '') {
    if (closedEmitted) return;
    closedEmitted = true;
    emitter.readyState = 'CLOSED';
    emitter.emit('close', code, reason);
  }

  function writeRaw(buf) {
    if (emitter.readyState !== 'OPEN' || socket.destroyed) return false;
    try {
      socket.write(buf);
      return true;
    } catch (err) {
      emitter.emit('error', err);
      return false;
    }
  }

  function sendCloseFrame(code = 1000, reason = '') {
    if (closeSent || socket.destroyed) return;
    closeSent = true;
    const reasonBuf = reason ? Buffer.from(String(reason), 'utf8').subarray(0, 123) : Buffer.alloc(0);
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    if (reasonBuf.length > 0) reasonBuf.copy(payload, 2);
    try {
      socket.write(encodeWsFrame(OPCODE_CLOSE, payload));
    } catch {
      // Ignore write error during close
    }
  }

  emitter.sendText = function sendText(str) {
    return writeRaw(encodeWsFrame(OPCODE_TEXT, Buffer.from(String(str ?? ''), 'utf8')));
  };

  emitter.sendBinary = function sendBinary(buf) {
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
    return writeRaw(encodeWsFrame(OPCODE_BINARY, data));
  };

  emitter.sendPing = function sendPing(payload = Buffer.alloc(0)) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    return writeRaw(encodeWsFrame(OPCODE_PING, data.subarray(0, 125)));
  };

  emitter.sendPong = function sendPong(payload = Buffer.alloc(0)) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
    return writeRaw(encodeWsFrame(OPCODE_PONG, data.subarray(0, 125)));
  };

  emitter.close = function close(code = 1000, reason = '') {
    if (emitter.readyState === 'CLOSED') return;
    emitter.readyState = 'CLOSING';
    sendCloseFrame(code, reason);
    try {
      socket.end();
    } catch {
      // Ignore end error
    }
    setImmediate(() => {
      if (!socket.destroyed) socket.destroy();
      emitClose(code, reason);
    });
  };

  function failProtocol(code = 1002, reason = 'Protocol error') {
    if (emitter.readyState === 'CLOSED') return;
    emitter.readyState = 'CLOSING';
    sendCloseFrame(code, reason);
    socket.destroy();
    emitClose(code, reason);
  }

  function processBuffer() {
    while (buffer.length >= 2 && emitter.readyState === 'OPEN') {
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        failProtocol(1002, 'Unsupported RSV bits');
        return;
      }

      if (!masked) {
        failProtocol(1002, 'Client frames must be masked');
        return;
      }

      if (payloadLen === 126) {
        if (buffer.length < offset + 2) return;
        payloadLen = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLen === 127) {
        if (buffer.length < offset + 8) return;
        const bigLen = buffer.readBigUInt64BE(offset);
        if (bigLen > BigInt(MAX_WS_FRAME_BYTES)) {
          failProtocol(1009, 'Frame too large');
          return;
        }
        payloadLen = Number(bigLen);
        offset += 8;
      }

      if (payloadLen > MAX_WS_FRAME_BYTES) {
        failProtocol(1009, 'Frame too large');
        return;
      }

      const maskLen = 4;
      const totalFrameBytes = offset + maskLen + payloadLen;
      if (buffer.length < totalFrameBytes) return;

      const maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;

      const payload = Buffer.allocUnsafe(payloadLen);
      for (let i = 0; i < payloadLen; i++) {
        payload[i] = buffer[offset + i] ^ maskKey[i & 3];
      }

      buffer = buffer.subarray(totalFrameBytes);

      // Control frames (Close/Ping/Pong) must not be fragmented and may interleave.
      if (opcode >= 0x8) {
        if (!fin || payloadLen > 125) {
          failProtocol(1002, 'Invalid control frame');
          return;
        }
        if (opcode === OPCODE_PING) {
          emitter.sendPong(payload);
          emitter.emit('ping', payload);
        } else if (opcode === OPCODE_PONG) {
          emitter.emit('pong', payload);
        } else if (opcode === OPCODE_CLOSE) {
          let closeCode = 1005;
          let closeReason = '';
          if (payload.length >= 2) {
            closeCode = payload.readUInt16BE(0);
            closeReason = payload.subarray(2).toString('utf8');
          }
          emitter.readyState = 'CLOSING';
          if (!closeSent) {
            sendCloseFrame(closeCode === 1005 ? 1000 : closeCode, closeReason);
          }
          socket.end();
          emitClose(closeCode, closeReason);
          return;
        } else {
          failProtocol(1002, 'Unknown control opcode');
          return;
        }
        continue;
      }

      if (opcode === OPCODE_CONT) {
        if (fragOpcode === null) {
          failProtocol(1002, 'Unexpected continuation frame');
          return;
        }
        fragTotalBytes += payload.length;
        if (fragTotalBytes > MAX_WS_FRAME_BYTES) {
          failProtocol(1009, 'Message too large');
          return;
        }
        fragChunks.push(payload);
        if (fin) {
          const fullPayload = Buffer.concat(fragChunks, fragTotalBytes);
          const msgOpcode = fragOpcode;
          fragOpcode = null;
          fragChunks = [];
          fragTotalBytes = 0;
          if (msgOpcode === OPCODE_TEXT) {
            emitter.emit('message', fullPayload.toString('utf8'), { isBinary: false });
          } else {
            emitter.emit('message', fullPayload, { isBinary: true });
          }
        }
        continue;
      }

      if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
        if (fragOpcode !== null) {
          failProtocol(1002, 'Expected continuation frame');
          return;
        }
        if (!fin) {
          fragOpcode = opcode;
          fragChunks = [payload];
          fragTotalBytes = payload.length;
        } else if (opcode === OPCODE_TEXT) {
          emitter.emit('message', payload.toString('utf8'), { isBinary: false });
        } else {
          emitter.emit('message', payload, { isBinary: true });
        }
        continue;
      }

      failProtocol(1002, 'Unsupported opcode');
      return;
    }
  }

  socket.on('data', (chunk) => {
    buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
    processBuffer();
  });

  socket.on('error', (err) => {
    emitter.emit('error', err);
  });

  socket.on('close', () => {
    emitClose(1006, '');
  });

  // Process any initial bytes carried in `head` asynchronously after listeners attach.
  if (buffer.length > 0) {
    setImmediate(processBuffer);
  }

  return emitter;
}

class RingBuffer64K {
  constructor(capacity = RING_BUFFER_BYTES) {
    this.capacity = capacity;
    this.buf = Buffer.allocUnsafe(capacity);
    this.writePos = 0;
    this.size = 0;
  }

  push(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (data.length === 0) return;

    if (data.length >= this.capacity) {
      data.copy(this.buf, 0, data.length - this.capacity, data.length);
      this.writePos = 0;
      this.size = this.capacity;
      return;
    }

    const firstPart = Math.min(data.length, this.capacity - this.writePos);
    data.copy(this.buf, this.writePos, 0, firstPart);
    if (firstPart < data.length) {
      data.copy(this.buf, 0, firstPart, data.length);
    }
    this.writePos = (this.writePos + data.length) % this.capacity;
    this.size = Math.min(this.capacity, this.size + data.length);
  }

  snapshot() {
    if (this.size === 0) return Buffer.alloc(0);
    if (this.size < this.capacity) {
      return Buffer.from(this.buf.subarray(0, this.size));
    }
    return Buffer.concat([
      this.buf.subarray(this.writePos, this.capacity),
      this.buf.subarray(0, this.writePos)
    ]);
  }
}

class PtySession extends EventEmitter {
  constructor({ sessionId, cwd, cols = 80, rows = 24, pythonBin = 'python3' } = {}) {
    super();
    this.sessionId = sessionId || crypto.randomUUID();
    this.cwd = cwd;
    this.cols = clampDim(cols, 80, 1, 500);
    this.rows = clampDim(rows, 24, 1, 200);
    this.createdAt = Date.now();
    this.lastActivityAt = this.createdAt;
    this.clients = new Set();
    this.ring = new RingBuffer64K(RING_BUFFER_BYTES);
    this.decoder = new StringDecoder('utf8');
    this.alive = true;
    this.disposed = false;
    this._killTimer = null;

    this.child = spawn(pythonBin, ['-u', '-c', PYTHON_PTY_SCRIPT], {
      cwd: this.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        AGY_PTY_COLS: String(this.cols),
        AGY_PTY_ROWS: String(this.rows)
      },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe']
    });

    this.child.stdout.on('data', (chunk) => {
      this.lastActivityAt = Date.now();
      this.ring.push(chunk);
      const text = this.decoder.write(chunk);
      if (text) {
        for (const ws of this.clients) {
          ws.sendText(text);
        }
      }
      this.emit('data', chunk);
    });

    this.child.stderr.on('data', (chunk) => {
      this.lastActivityAt = Date.now();
      this.ring.push(chunk);
      const text = this.decoder.write(chunk);
      if (text) {
        for (const ws of this.clients) {
          ws.sendText(text);
        }
      }
    });

    this.child.on('error', (err) => {
      this.alive = false;
      this.emit('error', err);
    });

    this.child.on('exit', (code, signal) => {
      this.alive = false;
      if (this._killTimer) {
        clearTimeout(this._killTimer);
        this._killTimer = null;
      }
      const tail = this.decoder.end();
      if (tail) {
        for (const ws of this.clients) {
          ws.sendText(tail);
        }
      }
      for (const ws of Array.from(this.clients)) {
        ws.close(1000, 'PTY exited');
      }
      this.clients.clear();
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

  getReplayBuffer() {
    return this.ring.snapshot();
  }

  attachClient(ws) {
    this.clients.add(ws);
    this.lastActivityAt = Date.now();

    const replay = this.getReplayBuffer();
    if (replay.length > 0) {
      ws.sendText(replay.toString('utf8'));
    }

    const onMessage = (data, meta) => {
      this.lastActivityAt = Date.now();
      if (!meta?.isBinary && typeof data === 'string' && data.startsWith('{')) {
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.type === 'resize') {
            this.resize(parsed.cols, parsed.rows);
            return;
          }
          if (parsed && parsed.type === 'input' && typeof parsed.data === 'string') {
            this.write(parsed.data);
            return;
          }
        } catch {
          // Not JSON control frame; treat as literal TTY input.
        }
      }
      this.write(data);
    };

    const onClose = () => {
      this.clients.delete(ws);
      this.lastActivityAt = Date.now();
      ws.removeListener('message', onMessage);
      ws.removeListener('close', onClose);
      ws.removeListener('error', onError);
      this.emit('clientDetach', ws);
    };

    const onError = () => {
      onClose();
    };

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
    this.emit('clientAttach', ws);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.alive = false;

    for (const ws of Array.from(this.clients)) {
      ws.close(1000, 'Session closed');
    }
    this.clients.clear();

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
      if (typeof this._killTimer.unref === 'function') {
        this._killTimer.unref();
      }
    }
  }
}

function clampDim(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isInsideDir(targetPath, baseDir) {
  const rel = path.relative(baseDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveAllowedRoots(allowedRoots) {
  const raw = typeof allowedRoots === 'function' ? allowedRoots() : allowedRoots;
  if (!Array.isArray(raw)) return [];
  const realRoots = [];
  for (const r of raw) {
    if (typeof r !== 'string' || !r || r.includes('\0')) continue;
    try {
      realRoots.push(fs.realpathSync(r));
    } catch {
      // Ignore non-existent roots
    }
  }
  return realRoots;
}

/**
 * Manages isolated PTY sessions backed by python3 pty.openpty and RFC 6455 WebSocket.
 */
function createPtyManager({
  allowedRoots = [],
  defaultCwd = '',
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  maxSessions = DEFAULT_MAX_SESSIONS,
  pythonBin = 'python3'
} = {}) {
  const sessions = new Map();
  const idleTimers = new Map();
  let disposed = false;

  const effectiveIdleMs = Number.isFinite(Number(idleTimeoutMs)) && Number(idleTimeoutMs) > 0
    ? Math.floor(Number(idleTimeoutMs))
    : DEFAULT_IDLE_TIMEOUT_MS;
  const effectiveMax = Number.isFinite(Number(maxSessions)) && Number(maxSessions) >= 1
    ? Math.floor(Number(maxSessions))
    : DEFAULT_MAX_SESSIONS;

  function validateCwd(rawCwd) {
    const roots = resolveAllowedRoots(allowedRoots);
    if (roots.length === 0) {
      return { ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' };
    }
    const candidate = (typeof rawCwd === 'string' && rawCwd.trim())
      ? rawCwd.trim()
      : (typeof defaultCwd === 'string' && defaultCwd.trim() ? defaultCwd.trim() : roots[0]);

    if (typeof candidate !== 'string' || !candidate || candidate.includes('\0')) {
      return { ok: false, statusCode: 400, error: 'INVALID_CWD' };
    }

    let realCwd;
    try {
      realCwd = fs.realpathSync(candidate);
    } catch {
      return { ok: false, statusCode: 403, error: 'PATH_OUTSIDE_WORKSPACE' };
    }

    if (!roots.some((r) => isInsideDir(realCwd, r))) {
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
    if (disposed || session.clients.size > 0 || !session.alive) return;
    const timer = setTimeout(() => {
      idleTimers.delete(session.sessionId);
      if (session.clients.size === 0) {
        closeSession(session.sessionId);
      }
    }, effectiveIdleMs);
    if (typeof timer.unref === 'function') timer.unref();
    idleTimers.set(session.sessionId, timer);
  }

  function listSessions() {
    return Array.from(sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      cols: s.cols,
      rows: s.rows,
      clients: s.clients.size,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      alive: s.alive
    }));
  }

  function getOrCreateSession({ sessionId, cwd, cols = 80, rows = 24 } = {}) {
    if (disposed) {
      return { ok: false, statusCode: 503, error: 'PTY_MANAGER_DISPOSED' };
    }

    const cleanId = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : '';
    if (cleanId && sessions.has(cleanId)) {
      const existing = sessions.get(cleanId);
      if (existing.alive && !existing.disposed) {
        if (cols !== undefined && rows !== undefined) {
          existing.resize(cols, rows);
        }
        return { ok: true, session: existing, created: false };
      }
      sessions.delete(cleanId);
      clearIdleTimer(cleanId);
    }

    if (sessions.size >= effectiveMax) {
      return { ok: false, statusCode: 429, error: 'MAX_SESSIONS_REACHED' };
    }

    const cwdCheck = validateCwd(cwd);
    if (!cwdCheck.ok) return cwdCheck;

    const session = new PtySession({
      sessionId: cleanId || crypto.randomUUID(),
      cwd: cwdCheck.realCwd,
      cols,
      rows,
      pythonBin
    });

    sessions.set(session.sessionId, session);
    session.on('clientAttach', () => clearIdleTimer(session.sessionId));
    session.on('clientDetach', () => armIdleTimer(session));
    session.on('exit', () => {
      clearIdleTimer(session.sessionId);
      sessions.delete(session.sessionId);
    });
    armIdleTimer(session);

    return { ok: true, session, created: true };
  }

  function closeSession(id) {
    const session = sessions.get(id);
    clearIdleTimer(id);
    if (!session) {
      return { ok: true, closed: false };
    }
    sessions.delete(id);
    session.dispose();
    return { ok: true, closed: true };
  }

  function handleUpgrade(req, socket, head, opts = {}) {
    if (disposed) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return { ok: false, statusCode: 503, error: 'PTY_MANAGER_DISPOSED' };
    }

    let urlObj;
    try {
      urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return { ok: false, statusCode: 400, error: 'INVALID_URL' };
    }

    const sessionId = opts.sessionId ?? urlObj.searchParams.get('sessionId') ?? undefined;
    const cwd = opts.cwd ?? urlObj.searchParams.get('cwd') ?? undefined;
    const cols = opts.cols ?? (urlObj.searchParams.get('cols') || 80);
    const rows = opts.rows ?? (urlObj.searchParams.get('rows') || 24);

    const res = getOrCreateSession({ sessionId, cwd, cols, rows });
    if (!res.ok) {
      const statusText = res.statusCode === 403
        ? 'Forbidden'
        : (res.statusCode === 429 ? 'Too Many Requests' : 'Bad Request');
      socket.write(`HTTP/1.1 ${res.statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return res;
    }

    const ws = acceptWebSocket(req, socket, head);
    res.session.attachClient(ws);
    return { ok: true, session: res.session, ws, created: res.created };
  }

  function disposeAll() {
    disposed = true;
    for (const timer of idleTimers.values()) {
      clearTimeout(timer);
    }
    idleTimers.clear();
    for (const session of Array.from(sessions.values())) {
      session.dispose();
    }
    sessions.clear();
  }

  return {
    listSessions,
    getOrCreateSession,
    closeSession,
    handleUpgrade,
    disposeAll
  };
}

module.exports = {
  RING_BUFFER_BYTES,
  acceptWebSocket,
  PtySession,
  createPtyManager
};
