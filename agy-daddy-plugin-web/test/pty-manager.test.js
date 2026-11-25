'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RING_BUFFER_BYTES,
  SeqRingBuffer64K,
  createPtyManager
} = require('../src/pty-manager');

test('SeqRingBuffer64K enforces 64KB byte cap and supports seq replayAfter', () => {
  const ring = new SeqRingBuffer64K(128);
  const e1 = ring.pushText('a'.repeat(60));
  const e2 = ring.pushText('b'.repeat(60));
  const e3 = ring.pushText('c'.repeat(60));

  assert.equal(e1.seq, 1);
  assert.equal(e2.seq, 2);
  assert.equal(e3.seq, 3);
  assert.ok(ring.totalBytes <= 128);
  assert.deepEqual(ring.replayAfter(2).map((e) => e.seq), [3]);
  assert.equal(ring.snapshotText(), `${'b'.repeat(60)}${'c'.repeat(60)}`);
  assert.equal(RING_BUFFER_BYTES, 65536);
});

test('ptyManager validates allowedRoots with realpathSync and enforces maxSessions=8 and missing python3 503', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pty-ws-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pty-out-'));
  const escapeLink = path.join(tmpRoot, 'escape-link');
  fs.symlinkSync(outsideDir, escapeLink);

  try {
    // 1. Missing python3 runtime -> 503 PTY_RUNTIME_UNAVAILABLE
    const unavailableMgr = createPtyManager({
      allowedRoots: [tmpRoot],
      probeFn: async () => ({ available: false, reason: 'PYTHON_PTY_MISSING' })
    });
    const unavailRes = await unavailableMgr.createOrGetSession({ cwd: tmpRoot });
    assert.equal(unavailRes.ok, false);
    assert.equal(unavailRes.statusCode, 503);
    assert.equal(unavailRes.error, 'PTY_RUNTIME_UNAVAILABLE');
    assert.equal(unavailRes.reason, 'PYTHON_PTY_MISSING');
    unavailableMgr.disposeAll();

    // 2. Mock spawn PTY manager for path & session limit assertions
    const fakeSpawn = () => {
      const listeners = new Map();
      const emit = (ev, ...args) => {
        for (const fn of listeners.get(ev) || []) fn(...args);
      };
      return {
        exitCode: null,
        killed: false,
        stdin: { destroyed: false, write() {}, end() {} },
        stdout: { on() {} },
        stderr: { on() {} },
        stdio: [null, null, null, { destroyed: false, write() {}, end() {} }],
        on(ev, fn) {
          if (!listeners.has(ev)) listeners.set(ev, []);
          listeners.get(ev).push(fn);
        },
        kill() {
          this.killed = true;
          this.exitCode = 0;
          emit('exit', 0, 'SIGTERM');
        }
      };
    };

    const mgr = createPtyManager({
      allowedRoots: [tmpRoot],
      maxSessions: 8,
      probeFn: async () => ({ available: true, reason: null }),
      spawnFn: fakeSpawn
    });

    try {
      const outsideRes = await mgr.createOrGetSession({ cwd: outsideDir });
      assert.equal(outsideRes.ok, false);
      assert.equal(outsideRes.statusCode, 403);
      assert.equal(outsideRes.error, 'PATH_OUTSIDE_WORKSPACE');

      const symlinkRes = await mgr.createOrGetSession({ cwd: escapeLink });
      assert.equal(symlinkRes.ok, false);
      assert.equal(symlinkRes.statusCode, 403);
      assert.equal(symlinkRes.error, 'PATH_OUTSIDE_WORKSPACE');

      const createdIds = [];
      for (let i = 0; i < 8; i++) {
        const res = await mgr.createOrGetSession({ cwd: tmpRoot });
        assert.equal(res.ok, true);
        createdIds.push(res.session.sessionId);
      }
      assert.equal(mgr.listSessions().length, 8);

      const overLimit = await mgr.createOrGetSession({ cwd: tmpRoot });
      assert.equal(overLimit.ok, false);
      assert.equal(overLimit.statusCode, 429);
      assert.equal(overLimit.error, 'MAX_SESSIONS_REACHED');

      const closeRes = mgr.closeSession(createdIds[0]);
      assert.equal(closeRes.ok, true);
      assert.equal(closeRes.closed, true);
      assert.equal(mgr.writeInput(createdIds[0], 'ls\n').error, 'TERMINAL_EXITED');
      assert.equal(mgr.closeSession(createdIds[0]).alreadyClosed, true);
    } finally {
      mgr.disposeAll();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('ptyManager runs real python3 pty session with output replay, input, resize, and clean dispose', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pty-real-'));
  const mgr = createPtyManager({
    allowedRoots: [tmpRoot],
    defaultCwd: tmpRoot
  });

  try {
    const rt = await mgr.checkRuntime();
    if (!rt.available) {
      t.skip(`python3 pty unavailable in environment: ${rt.reason}`);
      return;
    }

    const created = await mgr.createOrGetSession({ cwd: tmpRoot, cols: 80, rows: 24 });
    assert.equal(created.ok, true);
    const sid = created.session.sessionId;

    const frames = [];
    let closed = false;
    mgr.attachSseClient(sid, {
      sendOutput(seq, chunk, alive) {
        frames.push({ seq, chunk, alive });
      },
      sendExit() {
        closed = true;
      },
      onClose() {},
      close() {
        closed = true;
      }
    });

    const writeRes = mgr.writeInput(sid, 'echo __AGY_PTY_OK__\n');
    assert.equal(writeRes.ok, true);
    const resizeRes = mgr.resizeSession(sid, 100, 30);
    assert.equal(resizeRes.ok, true);
    assert.equal(resizeRes.cols, 100);
    assert.equal(resizeRes.rows, 30);

    await new Promise((resolve) => {
      const deadline = Date.now() + 3000;
      const timer = setInterval(() => {
        const joined = frames.map((f) => f.chunk).join('');
        if (joined.includes('__AGY_PTY_OK__') || Date.now() > deadline) {
          clearInterval(timer);
          resolve();
        }
      }, 30);
    });

    const combined = frames.map((f) => f.chunk).join('');
    assert.match(combined, /__AGY_PTY_OK__/);

    mgr.closeSession(sid);
    assert.equal(closed, true);
    assert.equal(mgr.listSessions().length, 0);
  } finally {
    mgr.disposeAll();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
