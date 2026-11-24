'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { PluginDataStore } = require(path.join(HOST_ROOT, 'src', 'core', 'storage'));

const {
  generateVapidKeys,
  createVapidAuthHeader,
  encryptWebPushPayload,
  createWebPushManager
} = require('../src/web-push');
const {
  RING_BUFFER_BYTES,
  acceptWebSocket,
  createPtyManager
} = require('../src/pty-bridge');
const { createMobileWorkspaceService } = require('../src/mobile-workspace');
const { createSseBroker } = require('../src/sse-broker');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitUntil(pred, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

/**
 * Independent RFC 8291 (aes128gcm) decryptor simulating a browser Push Service / User Agent.
 */
function decryptWebPushPayload(bodyBuf, uaEcdh, authSecret) {
  assert.ok(bodyBuf.length >= 86 + 16, 'aes128gcm body must include 86-byte header + tag');
  const salt = bodyBuf.subarray(0, 16);
  const rs = bodyBuf.readUInt32BE(16);
  assert.ok(rs >= 18);
  const idLen = bodyBuf.readUInt8(20);
  assert.equal(idLen, 65);
  const asPublic = bodyBuf.subarray(21, 21 + idLen);
  const encryptedAndTag = bodyBuf.subarray(21 + idLen);
  const ciphertext = encryptedAndTag.subarray(0, encryptedAndTag.length - 16);
  const tag = encryptedAndTag.subarray(encryptedAndTag.length - 16);

  const uaPublic = uaEcdh.getPublicKey();
  const sharedSecret = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  // Strip trailing zero padding and assert 0x02 delimiter
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0x00) end -= 1;
  assert.equal(padded[end], 0x02, 'RFC 8188 final record delimiter 0x02 must be present');
  return padded.subarray(0, end);
}

/**
 * Minimal masked RFC 6455 client frame builder + server frame parser for WS tests.
 */
function buildMaskedClientFrame(opcode, payloadBuf, fin = true) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(String(payloadBuf), 'utf8');
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len <= 65535) headerLen += 2;
  else if (len > 65535) headerLen += 8;

  const maskKey = crypto.randomBytes(4);
  const out = Buffer.allocUnsafe(headerLen + 4 + len);
  out[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  if (len < 126) {
    out[1] = 0x80 | len;
  } else if (len <= 65535) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  maskKey.copy(out, headerLen);
  for (let i = 0; i < len; i++) {
    out[headerLen + 4 + i] = payload[i] ^ maskKey[i & 3];
  }
  return out;
}

function buildMasked64BitClientFrame(opcode, payloadBuf) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(String(payloadBuf), 'utf8');
  const maskKey = crypto.randomBytes(4);
  const out = Buffer.allocUnsafe(2 + 8 + 4 + payload.length);
  out[0] = 0x80 | (opcode & 0x0f);
  out[1] = 0x80 | 127;
  out.writeBigUInt64BE(BigInt(payload.length), 2);
  maskKey.copy(out, 10);
  for (let i = 0; i < payload.length; i++) {
    out[14 + i] = payload[i] ^ maskKey[i & 3];
  }
  return out;
}

function connectRawWs(port, pathAndQuery) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathAndQuery,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13'
      }
    });
    req.on('upgrade', (res, socket, head) => {
      const frames = [];
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      const listeners = new Set();

      function parse() {
        while (buf.length >= 2) {
          const b0 = buf[0];
          const b1 = buf[1];
          const opcode = b0 & 0x0f;
          let len = b1 & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < off + 2) return;
            len = buf.readUInt16BE(off);
            off += 2;
          } else if (len === 127) {
            if (buf.length < off + 8) return;
            len = Number(buf.readBigUInt64BE(off));
            off += 8;
          }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          const frame = { opcode, payload };
          frames.push(frame);
          for (const fn of listeners) fn(frame);
        }
      }

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        parse();
      });
      socket.on('error', () => {});
      if (buf.length > 0) setImmediate(parse);

      resolve({
        res,
        socket,
        frames,
        onFrame(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        sendMaskedText(text) {
          socket.write(buildMaskedClientFrame(0x1, Buffer.from(text, 'utf8'), true));
        },
        sendPing(payload = 'hi') {
          socket.write(buildMaskedClientFrame(0x9, Buffer.from(payload, 'utf8'), true));
        },
        sendClose(code = 1000, reason = 'bye') {
          const r = Buffer.from(reason, 'utf8');
          const p = Buffer.allocUnsafe(2 + r.length);
          p.writeUInt16BE(code, 0);
          r.copy(p, 2);
          socket.write(buildMaskedClientFrame(0x8, p, true));
        },
        closeNow() {
          socket.destroy();
        }
      });
    });
    req.on('response', (res) => {
      reject(new Error(`WS_UPGRADE_REJECTED_${res.statusCode}`));
    });
    req.on('error', reject);
    req.end();
  });
}

test('web-push: VAPID ES256 signature verification, RFC 8291 decrypt round-trip, persistence & 404/410 pruning', async () => {
  const { publicKey, privateKey } = generateVapidKeys();
  const pubRaw = Buffer.from(publicKey, 'base64url');
  assert.equal(pubRaw.length, 65);
  assert.equal(pubRaw[0], 0x04);
  assert.ok(privateKey.includes('BEGIN PRIVATE KEY'));

  const header = createVapidAuthHeader({
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    subject: 'mailto:test@example.com',
    publicKey,
    privateKey,
    ttlSec: 1800
  });
  assert.ok(header.authorization.startsWith('vapid t='));
  assert.equal(header.cryptoKey, `p256ecdsa=${publicKey}`);

  // Verify ES256 JWT signature independently
  const jwt = header.authorization.slice('vapid t='.length, header.authorization.indexOf(', k='));
  const [hdrB64, payB64, sigB64] = jwt.split('.');
  const parsedHdr = JSON.parse(Buffer.from(hdrB64, 'base64url').toString('utf8'));
  const parsedPay = JSON.parse(Buffer.from(payB64, 'base64url').toString('utf8'));
  assert.equal(parsedHdr.alg, 'ES256');
  assert.equal(parsedPay.aud, 'https://fcm.googleapis.com');
  assert.equal(parsedPay.sub, 'mailto:test@example.com');

  const verifyKey = crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pubRaw.subarray(1, 33).toString('base64url'),
      y: pubRaw.subarray(33, 65).toString('base64url')
    },
    format: 'jwk'
  });
  const sigValid = crypto.verify(
    'sha256',
    Buffer.from(`${hdrB64}.${payB64}`, 'utf8'),
    { key: verifyKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(sigB64, 'base64url')
  );
  assert.equal(sigValid, true);

  // Real RFC 8291 decrypt round-trip test
  const uaEcdh = crypto.createECDH('prime256v1');
  uaEcdh.generateKeys();
  const uaP256dh = uaEcdh.getPublicKey().toString('base64url');
  const authSecret = crypto.randomBytes(16);
  const uaAuth = authSecret.toString('base64url');
  const originalPayload = JSON.stringify({ title: 'Approval Required', cascadeId: 'sess-1', seq: 42, zh: '请确认命令' });

  const encrypted = encryptWebPushPayload(originalPayload, { p256dh: uaP256dh, auth: uaAuth });
  assert.equal(encrypted.salt.length, 16);
  assert.equal(encrypted.localPublicKey.length, 65);
  const recovered = decryptWebPushPayload(encrypted.body, uaEcdh, authSecret);
  assert.equal(recovered.toString('utf8'), originalPayload);

  // Manager persistence + testMode dryRun + 404/410 auto-prune
  const tmpDir = makeTempDir('agy-webpush-');
  try {
    const storage = new PluginDataStore('test-remote', { dir: tmpDir });
    const mgr1 = createWebPushManager({ storage, isTestMode: true });
    const persistedPub = mgr1.getPublicKey();

    const sub1 = { endpoint: 'https://push.example.com/ok', keys: { p256dh: uaP256dh, auth: uaAuth } };
    const sub2 = { endpoint: 'https://push.example.com/gone', keys: { p256dh: uaP256dh, auth: uaAuth } };
    const sub3 = { endpoint: 'https://push.example.com/missing', keys: { p256dh: uaP256dh, auth: uaAuth } };
    assert.equal(mgr1.subscribe(sub1, { device: 'iPhone' }).ok, true);
    assert.equal(mgr1.subscribe(sub2, { device: 'OldPhone' }).ok, true);
    assert.equal(mgr1.subscribe(sub3, { device: 'DeadPhone' }).ok, true);

    const dryRes = await mgr1.sendTestNotification();
    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.dryRun, true);
    assert.equal(dryRes.sent, 3);

    // Reload from disk with a new manager instance
    const delivered = [];
    const mgr2 = createWebPushManager({
      storage,
      isTestMode: true,
      fetchImpl: async (url, init) => {
        delivered.push({ url, headers: init.headers, body: init.body });
        if (url.endsWith('/gone')) return { status: 410 };
        if (url.endsWith('/missing')) return { status: 404 };
        return { status: 201 };
      }
    });
    assert.equal(mgr2.getPublicKey(), persistedPub);
    assert.equal(mgr2.listSubscriptions().length, 3);

    const sendRes = await mgr2.sendNotification({ title: 'Hello', body: 'Check' });
    assert.equal(sendRes.ok, true);
    assert.equal(sendRes.dryRun, false);
    assert.equal(sendRes.sent, 1);
    assert.equal(sendRes.failed, 2);
    assert.equal(sendRes.pruned, 2);
    assert.equal(delivered.length, 3);
    assert.equal(delivered[0].headers['Content-Encoding'], 'aes128gcm');
    assert.equal(decryptWebPushPayload(delivered[0].body, uaEcdh, authSecret).toString('utf8'), JSON.stringify({ title: 'Hello', body: 'Check' }));

    const remaining = mgr2.listSubscriptions();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].endpoint, 'https://push.example.com/ok');

    assert.equal(mgr2.unsubscribe('https://push.example.com/ok').removed, true);
    assert.equal(mgr2.listSubscriptions().length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('pty-bridge: RFC 6455 framing (7/16/64-bit, fragmentation, ping/pong), live python3 pty echo/resize, 64KB ring replay & 403 escape', async () => {
  const tmpRoot = makeTempDir('agy-pty-root-');
  const outsideDir = makeTempDir('agy-pty-out-');
  const escapingLink = path.join(tmpRoot, 'escape-link');
  fs.symlinkSync(outsideDir, escapingLink);

  const ptyMgr = createPtyManager({
    allowedRoots: [tmpRoot],
    defaultCwd: tmpRoot,
    idleTimeoutMs: 60000,
    maxSessions: 4
  });

  // Direct acceptWebSocket framing server (tests 7/16/64-bit + fragmentation + ping/pong)
  const rawWsMessages = [];
  const rawServer = http.createServer();
  rawServer.on('upgrade', (req, socket, head) => {
    const ws = acceptWebSocket(req, socket, head);
    ws.on('message', (msg, meta) => {
      rawWsMessages.push({ msg, isBinary: meta.isBinary });
      if (meta.isBinary) ws.sendBinary(msg);
      else ws.sendText(msg);
    });
  });

  // PTY manager upgrade server
  const ptyServer = http.createServer();
  ptyServer.on('upgrade', (req, socket, head) => {
    ptyMgr.handleUpgrade(req, socket, head);
  });

  try {
    await new Promise((r) => rawServer.listen(0, '127.0.0.1', r));
    await new Promise((r) => ptyServer.listen(0, '127.0.0.1', r));
    const rawPort = rawServer.address().port;
    const ptyPort = ptyServer.address().port;

    // 1. RFC 6455 framing test
    const wsRaw = await connectRawWs(rawPort, '/ws');
    const receivedFrames = [];
    wsRaw.onFrame((f) => receivedFrames.push(f));

    // 7-bit text + 16-bit (300 bytes) + 64-bit binary (70000 bytes) + fragmented with interleaved Ping
    wsRaw.sendMaskedText('short-7bit');
    const med16 = 'M'.repeat(300);
    wsRaw.sendMaskedText(med16);
    const bin64 = Buffer.alloc(70000, 0x5a);
    wsRaw.socket.write(buildMasked64BitClientFrame(0x2, bin64));

    // Fragmented message: part1 (FIN=0) + interleaved Ping + part2 (FIN=1)
    wsRaw.socket.write(buildMaskedClientFrame(0x1, Buffer.from('frag-one-', 'utf8'), false));
    wsRaw.sendPing('ping-mid');
    wsRaw.socket.write(buildMaskedClientFrame(0x0, Buffer.from('frag-two', 'utf8'), true));

    const gotAllRaw = await waitUntil(() =>
      receivedFrames.some((f) => f.opcode === 0xA && f.payload.toString('utf8') === 'ping-mid') &&
      rawWsMessages.length >= 4
    );
    assert.equal(gotAllRaw, true);
    assert.equal(rawWsMessages[0].msg, 'short-7bit');
    assert.equal(rawWsMessages[1].msg, med16);
    assert.equal(Buffer.isBuffer(rawWsMessages[2].msg), true);
    assert.equal(rawWsMessages[2].msg.equals(bin64), true);
    assert.equal(rawWsMessages[3].msg, 'frag-one-frag-two');

    wsRaw.sendClose(1000, 'done');
    await waitUntil(() => receivedFrames.some((f) => f.opcode === 0x8));
    wsRaw.closeNow();

    // 2. Escape cwd & symlink cwd blocked with 403
    await assert.rejects(
      () => connectRawWs(ptyPort, `/ws/pty?cwd=${encodeURIComponent(outsideDir)}`),
      /WS_UPGRADE_REJECTED_403/
    );
    await assert.rejects(
      () => connectRawWs(ptyPort, `/ws/pty?cwd=${encodeURIComponent(escapingLink)}`),
      /WS_UPGRADE_REJECTED_403/
    );

    // 3. Live python3 PTY echo, resize, and 64KB ring buffer replay (POSIX pty/termios)
    if (process.platform !== 'win32') {
      const sessionId = 'pty-test-1';
      const ptyClient1 = await connectRawWs(ptyPort, `/ws/pty?sessionId=${sessionId}&cols=80&rows=24`);
      let termText1 = '';
      ptyClient1.onFrame((f) => {
        if (f.opcode === 0x1 || f.opcode === 0x2) {
          termText1 += f.payload.toString('utf8');
        }
      });

      ptyClient1.sendMaskedText('echo PTY_ECHO_CHECK_99\n');
      assert.equal(await waitUntil(() => termText1.includes('PTY_ECHO_CHECK_99')), true);

      ptyClient1.sendMaskedText(JSON.stringify({ type: 'resize', cols: 117, rows: 39 }));
      await new Promise((r) => setTimeout(r, 80));
      ptyClient1.sendMaskedText('stty size\n');
      assert.equal(await waitUntil(() => termText1.includes('39 117')), true);

      // Verify 64KB ring buffer caps at exactly 65536 bytes while retaining tail
      const sessionObj = ptyMgr.getOrCreateSession({ sessionId }).session;
      const bigPayload = 'A'.repeat(70000) + 'TAIL_MARKER_64K';
      sessionObj.ring.push(Buffer.from(bigPayload, 'utf8'));
      const snap = sessionObj.getReplayBuffer();
      assert.equal(snap.length, RING_BUFFER_BYTES);
      assert.ok(snap.toString('utf8').endsWith('TAIL_MARKER_64K'));

      // Disconnect client1 and reconnect client2 to confirm replay
      ptyClient1.sendClose(1000, 'detach');
      await new Promise((r) => setTimeout(r, 60));
      ptyClient1.closeNow();

      const ptyClient2 = await connectRawWs(ptyPort, `/ws/pty?sessionId=${sessionId}`);
      let termText2 = '';
      ptyClient2.onFrame((f) => {
        if (f.opcode === 0x1 || f.opcode === 0x2) {
          termText2 += f.payload.toString('utf8');
        }
      });
      assert.equal(await waitUntil(() => termText2.includes('TAIL_MARKER_64K')), true);
      ptyClient2.closeNow();

      assert.equal(ptyMgr.listSessions().length, 1);
    }
  } finally {
    ptyMgr.disposeAll();
    rawServer.close();
    ptyServer.close();
    await new Promise((r) => setTimeout(r, 80));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('mobile-workspace: symlink/dangling-symlink 403, flag injection guard, artifacts, git diff/stage/commit/worktree', async () => {
  const wsParent = makeTempDir('agy-mws-');
  const repoDir = path.join(wsParent, 'repo');
  const outsideDir = makeTempDir('agy-mws-out-');
  const brainDir = makeTempDir('agy-mws-brain-');

  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP_SECRET', 'utf8');
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(repoDir, 'escape-file.txt'));
  fs.symlinkSync(path.join(outsideDir, 'nonexistent.txt'), path.join(repoDir, 'dangling-escape.txt'));

  // Init temp git repo
  execFileSync('git', ['-C', repoDir, 'init'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello\n', 'utf8');
  execFileSync('git', ['-C', repoDir, 'add', 'README.md']);
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init']);

  // Brain artifacts + escaping symlink inside brain
  const sessBrain = path.join(brainDir, 'sess-abc');
  fs.mkdirSync(sessBrain, { recursive: true });
  fs.writeFileSync(path.join(sessBrain, 'plan.md'), '# Plan\n- Step 1\n', 'utf8');
  fs.writeFileSync(path.join(sessBrain, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(sessBrain, 'leak.txt'));

  const svc = createMobileWorkspaceService({
    getAllowedRoots: () => [wsParent],
    brainDir,
    maxDiffBytes: 256
  });

  try {
    // Roots & tree
    const rootsRes = svc.listRoots();
    assert.equal(rootsRes.ok, true);
    assert.equal(rootsRes.roots.length, 1);

    // Symlink & traversal 403 checks
    assert.equal(svc.readFile({ root: repoDir, path: '../outside.txt' }).statusCode, 403);
    assert.equal(svc.readFile({ root: repoDir, path: 'escape-file.txt' }).statusCode, 403);
    assert.equal(svc.readFile({ root: repoDir, path: 'dangling-escape.txt' }).statusCode, 403);
    assert.equal(svc.writeFile({ root: repoDir, path: 'dangling-escape.txt', content: 'x' }).statusCode, 403);
    assert.equal(svc.readArtifact('sess-abc', 'leak.txt').statusCode, 403);
    assert.equal(svc.readArtifact('../outside', 'secret.txt').statusCode, 403);

    // Artifacts read (text & binary)
    const arts = svc.listArtifacts('sess-abc');
    assert.equal(arts.ok, true);
    assert.deepEqual(arts.items.map((i) => i.name), ['img.png', 'plan.md']);
    assert.equal(svc.readArtifact('sess-abc', 'plan.md').content, '# Plan\n- Step 1\n');
    const binArt = svc.readArtifact('sess-abc', 'img.png', { binary: true });
    assert.equal(Buffer.isBuffer(binArt.content), true);
    assert.equal(binArt.content[0], 0x89);

    // Leading '-' flag injection blocked
    assert.equal((await svc.gitStage({ root: repoDir, paths: ['--exec=evil'] })).statusCode, 400);
    assert.equal((await svc.getGitDiff({ root: repoDir, path: '-n' })).statusCode, 400);
    assert.equal((await svc.gitPush({ root: repoDir, remote: '--upload-pack=evil' })).statusCode, 400);
    assert.equal((await svc.gitWorktree({ root: repoDir, action: 'add', path: '-b', branch: 'x' })).statusCode, 400);

    // Write file -> gitDiff (check truncation too) -> stage -> unstage -> stage -> commit
    const writeRes = svc.writeFile({ root: repoDir, path: 'src/app.js', content: `// ${'x'.repeat(400)}\n` });
    assert.equal(writeRes.ok, true);
    assert.equal(svc.readFile({ root: repoDir, path: 'src/app.js' }).ok, true);

    assert.equal((await svc.gitStage({ root: repoDir, paths: ['src/app.js'] })).ok, true);
    const diffRes = await svc.getGitDiff({ root: repoDir });
    assert.equal(diffRes.ok, true);
    assert.equal(diffRes.isGitRepo, true);
    assert.equal(diffRes.truncated, true);
    assert.ok(Buffer.byteLength(diffRes.diffText, 'utf8') <= 256);

    assert.equal((await svc.gitStage({ root: repoDir, paths: ['src/app.js'], unstage: true })).ok, true);
    assert.equal((await svc.gitStage({ root: repoDir, paths: ['src/app.js'] })).ok, true);
    const commitRes = await svc.gitCommit({ root: repoDir, message: 'feat: add app.js' });
    assert.equal(commitRes.ok, true);
    assert.ok(commitRes.commitSha.length >= 7);

    // Worktree add, list, remove (and block outside worktree path)
    const wtOutside = await svc.gitWorktree({
      root: repoDir,
      action: 'add',
      path: path.join(outsideDir, 'wt-bad'),
      branch: 'wt-bad',
      createBranch: true
    });
    assert.equal(wtOutside.statusCode, 403);

    const wtDir = path.join(wsParent, 'repo-wt-1');
    const wtAdd = await svc.gitWorktree({
      root: repoDir,
      action: 'add',
      path: wtDir,
      branch: 'feat/wt-test',
      createBranch: true
    });
    assert.equal(wtAdd.ok, true);
    assert.equal(wtAdd.worktrees.length, 2);
    assert.equal(wtAdd.worktrees.some((w) => w.branch === 'feat/wt-test'), true);

    const wtList = await svc.listWorktrees({ root: repoDir });
    assert.equal(wtList.ok, true);
    assert.equal(wtList.worktrees.length, 2);

    const wtRem = await svc.gitWorktree({ root: repoDir, action: 'remove', path: wtDir });
    assert.equal(wtRem.ok, true);
    assert.equal(wtRem.worktrees.length, 1);
  } finally {
    fs.rmSync(wsParent, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.rmSync(brainDir, { recursive: true, force: true });
  }
});

test('sse-broker: stepOffset deltas, Last-Event-ID replay, attention transitions, telemetry & FIFO queue RUNNING->IDLE auto-dispatch', async () => {
  let currentStatus = 'RUNNING';
  let currentAttention = false;
  let currentReason = '';
  let steps = [{ seq: 1, text: 'step1' }];
  let telemetry = { tokens: 100 };

  const transitions = [];
  const dispatched = [];

  const broker = createSseBroker({
    ringBufferSize: 50,
    heartbeatIntervalMs: 0,
    pollIntervalMs: 25,
    getDelta: async (sessionId, stepOffset) => {
      if (sessionId !== 's-1') return { events: [], nextOffset: stepOffset };
      const slice = steps.slice(stepOffset);
      return { events: slice, nextOffset: steps.length };
    },
    listSessions: async () => [
      {
        cascadeId: 's-1',
        title: 'Test Session',
        status: currentStatus,
        needsAttention: currentAttention,
        attentionReason: currentReason
      }
    ],
    getTelemetry: async () => telemetry,
    dispatchMessage: async (cascadeId, item) => {
      dispatched.push({ cascadeId, text: item.text, queueId: item.queueId });
      return { ok: true };
    },
    onAttentionTransition: (evt) => transitions.push(evt)
  });

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/stream') {
      broker.handleStreamRequest(req, res, {
        sessionId: u.searchParams.get('sessionId'),
        lastEventId: u.searchParams.get('lastEventId') ?? req.headers['last-event-id']
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  function openSse(port, query, headers = {}) {
    return new Promise((resolve, reject) => {
      const events = [];
      let raw = '';
      const req = http.get({ host: '127.0.0.1', port, path: `/stream${query}`, headers }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
          const blocks = raw.split('\n\n');
          raw = blocks.pop();
          for (const b of blocks) {
            if (!b || b.startsWith(':')) continue;
            const rec = { id: null, event: 'message', data: null };
            for (const line of b.split('\n')) {
              if (line.startsWith('id: ')) rec.id = Number(line.slice(4));
              else if (line.startsWith('event: ')) rec.event = line.slice(7);
              else if (line.startsWith('data: ')) rec.data = JSON.parse(line.slice(6));
            }
            events.push(rec);
          }
        });
        resolve({
          res,
          req,
          events,
          close: () => {
            req.destroy();
            res.destroy();
          }
        });
      });
      req.on('error', reject);
    });
  }

  try {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const client1 = await openSse(port, '?sessionId=s-1');
    assert.equal(await waitUntil(() =>
      client1.events.some((e) => e.event === 'session.delta') &&
      client1.events.some((e) => e.event === 'telemetry.patch')
    ), true);

    const firstDelta = client1.events.find((e) => e.event === 'session.delta');
    assert.equal(firstDelta.data.events.length, 1);
    const resumeAfterId = firstDelta.id;

    // Disconnect client1, produce more events while disconnected
    client1.close();
    steps.push({ seq: 2, text: 'step2' });
    telemetry = { tokens: 250 };
    broker.emit('session.delta', { sessionId: 's-1', stepOffset: 1, nextOffset: 2, events: [steps[1]] }, { sessionId: 's-1' });
    broker.emit('telemetry.patch', telemetry);

    // Reconnect with Last-Event-ID and verify replay
    const client2 = await openSse(port, '?sessionId=s-1', { 'Last-Event-ID': String(resumeAfterId) });
    assert.equal(await waitUntil(() =>
      client2.events.some((e) => e.event === 'session.delta' && e.data.events?.[0]?.seq === 2) &&
      client2.events.some((e) => e.event === 'telemetry.patch' && e.data.tokens === 250)
    ), true);
    assert.equal(client2.events.every((e) => e.id > resumeAfterId), true);

    // Attention transition RUNNING -> PENDING -> RUNNING -> ERROR
    currentStatus = 'PENDING';
    currentAttention = true;
    currentReason = 'approval';
    assert.equal(await waitUntil(() => transitions.some((t) => t.status === 'PENDING')), true);

    currentStatus = 'RUNNING';
    currentAttention = false;
    currentReason = '';
    await new Promise((r) => setTimeout(r, 60));

    // Queue 3 items, remove middle, verify FIFO dispatch on RUNNING -> IDLE
    const q1 = broker.enqueueMessage('s-1', { text: 'first-queued' });
    const q2 = broker.enqueueMessage('s-1', { text: 'remove-me' });
    const q3 = broker.enqueueMessage('s-1', { text: 'second-queued' });
    assert.equal(broker.listQueue('s-1').length, 3);
    assert.equal(broker.removeQueuedMessage('s-1', q2.queueId).removed, true);
    assert.deepEqual(broker.listQueue('s-1').map((x) => x.queueId), [q1.queueId, q3.queueId]);

    currentStatus = 'IDLE';
    assert.equal(await waitUntil(() => dispatched.length === 1), true);
    assert.equal(dispatched[0].text, 'first-queued');

    // Transition back to RUNNING then IDLE for second queued message
    currentStatus = 'RUNNING';
    await new Promise((r) => setTimeout(r, 60));
    currentStatus = 'IDLE';
    assert.equal(await waitUntil(() => dispatched.length === 2), true);
    assert.equal(dispatched[1].text, 'second-queued');
    assert.equal(broker.listQueue('s-1').length, 0);

    client2.close();
  } finally {
    broker.dispose();
    server.close();
    await new Promise((r) => setTimeout(r, 50));
  }
});
