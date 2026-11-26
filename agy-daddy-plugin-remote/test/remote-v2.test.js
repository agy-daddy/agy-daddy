'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const {
  normalizePermissionLevel,
  isPermissionAtLeast,
  createConfirmToken,
  verifyConfirmToken
} = require('../src/tunnel-security');
const { generateTunnelLandingHtml } = require('../src/tunnel-landing-html');
const { createSessionOrgStore, isTempBridgeWorkspace } = require('../src/session-org-store');

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const bodyBuf = options.body !== undefined
      ? Buffer.from(typeof options.body === 'string' ? options.body : JSON.stringify(options.body), 'utf8')
      : null;
    const req = http.request(url, {
      method: options.method || 'GET',
      agent: false,
      headers: {
        Connection: 'close',
        ...(bodyBuf ? { 'Content-Length': String(bodyBuf.byteLength) } : {}),
        ...(options.headers || {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (bodyBuf) {
      req.write(bodyBuf);
    }
    req.end();
  });
}

function openSse(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(urlStr, { method: 'GET', agent: false, headers }, (res) => {
      let buffer = '';
      const events = [];
      const waiters = [];

      function flush() {
        while (waiters.length > 0) {
          const w = waiters[0];
          const found = events.find(w.pred);
          if (!found) break;
          waiters.shift();
          clearTimeout(w.timer);
          w.resolve(found);
        }
      }

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = block.split('\n').filter((l) => l && !l.startsWith(':'));
          if (lines.length === 0) continue;
          const ev = { id: null, event: 'message', data: '' };
          const dataLines = [];
          for (const line of lines) {
            if (line.startsWith('id:')) ev.id = line.slice(3).trim();
            else if (line.startsWith('event:')) ev.event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          ev.data = dataLines.join('\n');
          try { ev.json = JSON.parse(ev.data); } catch {}
          events.push(ev);
          flush();
        }
      });

      resolve({
        status: res.statusCode,
        headers: res.headers,
        events,
        waitForEvent(pred, timeoutMs = 2500) {
          const existing = events.find(pred);
          if (existing) return Promise.resolve(existing);
          return new Promise((resW, rejW) => {
            const timer = setTimeout(() => {
              const pos = waiters.findIndex((w) => w.resolve === resW);
              if (pos >= 0) waiters.splice(pos, 1);
              rejW(new Error(`Timed out waiting for SSE event. Received: ${JSON.stringify(events)}`));
            }, timeoutMs);
            waiters.push({ pred, resolve: resW, reject: rejW, timer });
          });
        },
        close() {
          req.destroy();
          res.destroy();
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function sendMaskedWsFrame(socket, opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''), 'utf8');
  const mask = crypto.randomBytes(4);
  const len = data.length;
  let headerLen = 2;
  if (len >= 126 && len <= 65535) headerLen += 2;
  else if (len > 65535) headerLen += 8;

  const frame = Buffer.allocUnsafe(headerLen + 4 + len);
  frame[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) {
    frame[1] = 0x80 | len;
  } else if (len <= 65535) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(len, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
  }
  mask.copy(frame, headerLen);
  for (let i = 0; i < len; i++) {
    frame[headerLen + 4 + i] = data[i] ^ mask[i & 3];
  }
  socket.write(frame);
}

function connectRawWs(urlStr, headers = {}) {
  const u = new URL(urlStr);
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: u.hostname, port: Number(u.port) }, () => {
      const reqLines = [
        `GET ${u.pathname}${u.search} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13'
      ];
      for (const [k, v] of Object.entries(headers)) {
        reqLines.push(`${k}: ${v}`);
      }
      reqLines.push('', '');
      socket.write(reqLines.join('\r\n'));
    });

    let rawBuf = Buffer.alloc(0);
    let upgraded = false;
    const textChunks = [];

    function parseServerFrames() {
      while (rawBuf.length >= 2) {
        const opcode = rawBuf[0] & 0x0f;
        let len = rawBuf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (rawBuf.length < 4) return;
          len = rawBuf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (rawBuf.length < 10) return;
          len = Number(rawBuf.readBigUInt64BE(2));
          offset = 10;
        }
        if (rawBuf.length < offset + len) return;
        const payload = rawBuf.subarray(offset, offset + len);
        rawBuf = rawBuf.subarray(offset + len);
        if (opcode === 0x1 || opcode === 0x2) {
          textChunks.push(payload.toString('utf8'));
        }
      }
    }

    socket.on('data', (chunk) => {
      rawBuf = Buffer.concat([rawBuf, chunk]);
      if (!upgraded) {
        const idx = rawBuf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const headText = rawBuf.subarray(0, idx).toString('utf8');
        const statusLine = headText.split('\r\n')[0] || '';
        const statusMatch = statusLine.match(/HTTP\/1\.1\s+(\d{3})/);
        const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
        rawBuf = rawBuf.subarray(idx + 4);
        upgraded = true;
        if (statusCode !== 101) {
          socket.destroy();
          resolve({ statusCode, socket: null, sendText: () => {}, close: () => {}, waitForOutput: async () => '' });
          return;
        }
        parseServerFrames();
        resolve({
          statusCode: 101,
          socket,
          sendText(str) {
            sendMaskedWsFrame(socket, 0x1, str);
          },
          async waitForOutput(substr, timeoutMs = 2500) {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
              const joined = textChunks.join('');
              if (joined.includes(substr)) return joined;
              await new Promise((r) => setTimeout(r, 25));
            }
            throw new Error(`Timed out waiting for PTY output "${substr}". Got: ${textChunks.join('')}`);
          },
          close() {
            try { sendMaskedWsFrame(socket, 0x8, Buffer.alloc(0)); } catch {}
            socket.destroy();
          }
        });
      } else {
        parseServerFrames();
      }
    });

    socket.on('error', reject);
  });
}

async function waitUntil(pred, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

function makeDummyP256Sub(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url')
    }
  };
}

test('tunnel-security: permission helpers and 60s HMAC confirm tokens', () => {
  assert.equal(normalizePermissionLevel('l2'), 'L2');
  assert.equal(normalizePermissionLevel('chat'), 'L1');
  assert.equal(normalizePermissionLevel('readonly'), 'L0');
  assert.equal(normalizePermissionLevel(undefined, true), 'L1');
  assert.equal(normalizePermissionLevel(undefined, false), 'L0');

  assert.equal(isPermissionAtLeast('L0', 'L0'), true);
  assert.equal(isPermissionAtLeast('L0', 'L1'), false);
  assert.equal(isPermissionAtLeast('L1', 'L1'), true);
  assert.equal(isPermissionAtLeast('L1', 'L2'), false);
  assert.equal(isPermissionAtLeast('L2', 'L2'), true);

  const secret = 'test-confirm-secret-xyz';
  const now = 1_700_000_000_000;
  const tok = createConfirmToken(secret, { action: '/api/v1/fs/write', ttlMs: 60000, now });
  assert.equal(verifyConfirmToken(tok, secret, { action: '/api/v1/fs/write', now: now + 30000 }), true);
  assert.equal(verifyConfirmToken(tok, secret, { action: '/api/v1/git/push', now: now + 1000 }), false);
  assert.equal(verifyConfirmToken(tok, secret, { action: '/api/v1/fs/write', now: now + 60001 }), false);
  assert.equal(verifyConfirmToken('confirmed', secret, { action: '/api/v1/fs/write', now }), false);
  assert.equal(verifyConfirmToken(`${tok}tamper`, secret, { action: '/api/v1/fs/write', now }), false);
});

test('remote-v2: L0/L1/L2 permission matrix, Cloudflare X-Agy-Confirm, zero pairingUrl leak, static dist/web, SSE/Queue, 2.34.0 RPC, FS/Git/PTY/Push', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-remote-v2-'));
  const repoDir = path.join(tmpRoot, 'repo');
  const outsideDir = path.join(tmpRoot, 'outside');
  const brainRoot = path.join(tmpRoot, 'brain');
  const sessionBrainDir = path.join(brainRoot, 'cid-1');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.mkdirSync(sessionBrainDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP_SECRET', 'utf8');
  fs.writeFileSync(path.join(sessionBrainDir, 'plan.md'), '# Plan\nStep 1', 'utf8');
  fs.writeFileSync(path.join(sessionBrainDir, 'preview.png'), Buffer.from('iVBORw0KGgo=', 'base64'));

  execFileSync('git', ['init'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@agy.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Agy Test'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'app.js'), 'const a = 1;\n', 'utf8');
  execFileSync('git', ['add', 'app.js'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'app.js'), 'const a = 2;\n', 'utf8');
  fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(repoDir, 'escape-link.txt'));

  const prevBrain = process.env.AGY_DADDY_BRAIN_DIR;
  process.env.AGY_DADDY_BRAIN_DIR = brainRoot;

  let sessionStatus = 'CASCADE_RUN_STATUS_RUNNING';
  let stepsPollCount = 0;
  const rpcCalls = [];

  const harness = createMockHostHarness({
    onRpc(method, params) {
      rpcCalls.push({ method, params });
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'cid-1': {
              summary: 'V2 Session',
              status: sessionStatus,
              stepCount: 2,
              lastModifiedTime: '2026-11-24T10:00:00Z',
              workspaces: [{ workspaceFolderAbsoluteUri: `file://${repoDir}`, branchName: 'main' }]
            }
          }
        };
      }
      if (method === 'GetCascadeTrajectory') {
        return {
          status: sessionStatus,
          numTotalSteps: 2,
          trajectory: {
            trajectoryId: 'traj-v2',
            cascadeId: params.cascadeId,
            steps: [
              {
                stepIndex: 0,
                type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
                status: 'CORTEX_STEP_STATUS_PENDING',
                sourceTrajectoryStepInfo: { trajectoryId: 'traj-inner', stepIndex: 7 },
                requestedInteraction: { interaction: { permission: { scope: 'PERMISSION_SCOPE_ONCE' } } },
                runCommand: { commandLine: 'npm test' }
              },
              {
                stepIndex: 1,
                type: 'CORTEX_STEP_TYPE_ASK_QUESTION',
                status: 'CORTEX_STEP_STATUS_PENDING',
                askQuestion: {
                  questions: [{ question: 'Choose env', options: [{ id: 'dev', text: 'Dev' }] }]
                }
              }
            ]
          }
        };
      }
      if (method === 'GetCascadeTrajectorySteps') {
        stepsPollCount += 1;
        return {
          status: sessionStatus,
          numTotalSteps: stepsPollCount,
          steps: [
            {
              stepIndex: 0,
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: sessionStatus === 'CASCADE_RUN_STATUS_IDLE' ? 'CORTEX_STEP_STATUS_DONE' : 'CORTEX_STEP_STATUS_GENERATING',
              plannerResponse: { response: `chunk-${stepsPollCount}` }
            }
          ]
        };
      }
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_A' } },
              clientModelConfigs: [{ label: 'Model A', modelOrAlias: { model: 'MODEL_A' } }]
            }
          }
        };
      }
      if (method === 'GetAvailableModels') {
        return { response: { defaultAgentModelId: 'MODEL_A', models: { MODEL_A: { model: 'MODEL_A', displayName: 'Model A' } } } };
      }
      if (method === 'StartCascade') return { cascadeId: 'cid-new' };
      return { ok: true };
    }
  });

  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });

    // Provide mock web-harness with pairingUrl/pairingToken + composer-node
    harness.bus.provideService('agy-daddy.web', 'web-harness', {
      getStatus: () => ({
        ok: true,
        running: true,
        host: '127.0.0.1',
        port: 18767,
        url: 'http://127.0.0.1:18767',
        pairingUrl: 'http://127.0.0.1:18767/?token=pc_secret_999',
        pairingToken: 'pc_secret_999'
      })
    }, { realm: 'node' });
    harness.bus.provideService('agy-daddy.composer', 'composer-node', {
      listQuickPrompts: () => ({
        builtins: [{ id: 'q1', label: 'Review', text: 'Review this diff', enabled: true, group: 'builtin' }],
        custom: []
      }),
      listFrequentPrompts: () => ({ presets: [{ id: 'f1', label: 'Tests', prompt: 'Run tests' }] }),
      optimizePrompt: (txt) => ({ ok: true, optimized: `Optimized: ${txt}` })
    }, { realm: 'node' });

    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    await harness.updatePluginSettings('agy-daddy.remote', { allowedRoots: [repoDir], cloudflare: true });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st0 = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const cfHeaders = { ...auth, 'cf-ray': 'cf-test-1' };

    const shadow = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
    const bodyEl = shadow.querySelector('[data-agy-slot="popover:agy-daddy.remote:remote-panel"]');
    assert.equal(bodyEl.querySelector('[data-remote-permission-badge]')?.getAttribute('data-remote-permission-badge'), 'L0');

    // 1. Static dist/web + CSP + immutable assets + zero pairingUrl leakage
    const home = await httpRequest(`${st0.url}/`);
    assert.equal(home.status, 200);
    assert.match(home.text, /<div id="root"><\/div>/);
    assert.match(home.headers['content-security-policy'], /ws:/);
    assert.match(home.headers['content-security-policy'], /wss:/);
    assert.match(home.headers['content-security-policy'], /worker-src 'self'/);

    const assetMatch = home.text.match(/src="(\/assets\/index-[^"]+\.js)"/);
    assert.ok(assetMatch, 'Expected Vite entry asset script in index.html');
    const assetRes = await httpRequest(`${st0.url}${assetMatch[1]}`);
    assert.equal(assetRes.status, 200);
    assert.match(assetRes.headers['cache-control'], /immutable/);

    const swRes = await httpRequest(`${st0.url}/sw.js`);
    assert.equal(swRes.status, 200);
    assert.match(swRes.headers['cache-control'], /no-store/);

    // 2. L0 read-only matrix & zero pairingUrl/pairingToken leakage
    const boot0 = await httpRequest(`${st0.url}/api/v1/bootstrap`, { headers: auth });
    assert.equal(boot0.status, 200);
    assert.equal(boot0.json.permissionLevel, 'L0');
    assert.equal(boot0.json.voiceSupported, false);
    assert.equal(boot0.text.includes('pc_secret_999'), false);
    assert.equal(boot0.text.includes('pairingUrl'), false);
    assert.equal(boot0.text.includes('pairingToken'), false);

    assert.equal((await httpRequest(`${st0.url}/api/v1/sessions`, { headers: auth })).status, 200);
    assert.equal((await httpRequest(`${st0.url}/api/v1/sessions`, { method: 'POST', headers: auth, body: {} })).status, 403);
    assert.equal((await httpRequest(`${st0.url}/api/v1/sessions/cid-1/messages`, { method: 'POST', headers: auth, body: { text: 'hi' } })).status, 403);
    assert.equal((await httpRequest(`${st0.url}/api/v1/fs/write`, { method: 'PUT', headers: auth, body: { root: repoDir, path: 'x.txt', content: '1' } })).status, 403);
    assert.equal((await httpRequest(`${st0.url}/api/v1/pty/sessions`, { headers: auth })).status, 403);

    // 3. Bidirectional sync allowRemoteWrite: true -> L1
    await harness.updatePluginSettings('agy-daddy.remote', { allowRemoteWrite: true });
    assert.equal((await remoteSvc.getStatus()).permissionLevel, 'L1');
    assert.ok(await waitUntil(() => bodyEl.querySelector('[data-remote-permission-badge]')?.getAttribute('data-remote-permission-badge') === 'L1'));

    // L1 allows chat, Plan/Chat mode, HandleCascadeUserInteraction approve/answer, composer presets/optimize; blocks L2
    const presetsRes = await httpRequest(`${st0.url}/api/v1/composer/presets`, { headers: auth });
    assert.equal(presetsRes.status, 200);
    assert.ok(presetsRes.json.presets.length >= 2);
    const optRes = await httpRequest(`${st0.url}/api/v1/composer/optimize`, {
      method: 'POST',
      headers: auth,
      body: { text: 'fix bug' }
    });
    assert.equal(optRes.status, 200);
    assert.equal(optRes.json.optimizedText, 'Optimized: fix bug');

    const msgPlan = await httpRequest(`${st0.url}/api/v1/sessions/cid-1/messages`, {
      method: 'POST',
      headers: auth,
      body: { text: 'analyze only', mode: 'plan', dispatchMode: 'steer' }
    });
    assert.equal(msgPlan.status, 200);
    const sendCall = rpcCalls.find((c) => c.method === 'SendUserCascadeMessage');
    assert.equal(sendCall.params.cascadeConfig.plannerConfig.conversational.plannerMode, 'CONVERSATIONAL_PLANNER_MODE_READ_ONLY');

    const appRes = await httpRequest(`${st0.url}/api/v1/sessions/cid-1/steps/0/approve`, {
      method: 'POST',
      headers: auth,
      body: { decision: 'allow' }
    });
    assert.equal(appRes.status, 200);
    assert.equal(rpcCalls.some((c) => c.method === 'AcceptCascadeStep'), false);
    const permCall = rpcCalls.find((c) => c.method === 'HandleCascadeUserInteraction' && c.params.interaction.permission);
    assert.deepEqual(permCall.params.interaction, {
      trajectoryId: 'traj-inner',
      stepIndex: 7,
      permission: { allow: true, scope: 'PERMISSION_SCOPE_ONCE' }
    });

    const ansRes = await httpRequest(`${st0.url}/api/v1/sessions/cid-1/steps/1/answer`, {
      method: 'POST',
      headers: auth,
      body: { answers: [{ index: 0, question: 'Choose env', answer: 'Dev' }] }
    });
    assert.equal(ansRes.status, 200);
    assert.equal((await httpRequest(`${st0.url}/api/v1/fs/write`, { method: 'PUT', headers: auth, body: { root: repoDir, path: 'x.txt', content: '1' } })).status, 403);

    // 4. SSE delta + Last-Event-ID replay + Queue RUNNING -> IDLE auto-dispatch
    const sse1 = await openSse(`${st0.url}/api/v1/stream?t=${token}&sessionId=cid-1`);
    const delta1 = await sse1.waitForEvent((e) => e.event === 'session.delta');
    assert.ok(Number(delta1.id) >= 1);
    const savedId = delta1.id;
    sse1.close();

    const qRes = await httpRequest(`${st0.url}/api/v1/sessions/cid-1/messages`, {
      method: 'POST',
      headers: auth,
      body: { text: 'queued-msg-after-idle', dispatchMode: 'queue' }
    });
    assert.equal(qRes.status, 200);
    assert.equal(qRes.json.queued, true);
    assert.equal(rpcCalls.some((c) => c.params?.items?.[0]?.text === 'queued-msg-after-idle'), false);

    // Flip to IDLE and reconnect with Last-Event-ID
    sessionStatus = 'CASCADE_RUN_STATUS_IDLE';
    assert.ok(await waitUntil(() => rpcCalls.some((c) => c.params?.items?.[0]?.text === 'queued-msg-after-idle')));
    const sse2 = await openSse(`${st0.url}/api/v1/stream?t=${token}&sessionId=cid-1`, { 'Last-Event-ID': savedId });
    const replayed = await sse2.waitForEvent((e) => e.event === 'queue.update' || e.event === 'session.delta');
    assert.ok(Number(replayed.id) > Number(savedId));
    sse2.close();

    // 5. FS sandbox, Git diff/worktrees, Artifacts
    const treeRes = await httpRequest(`${st0.url}/api/v1/fs/tree?root=${encodeURIComponent(repoDir)}`, { headers: auth });
    assert.equal(treeRes.status, 200);
    assert.ok(treeRes.json.entries.some((e) => e.name === 'app.js' && e.type === 'file'));
    assert.equal((await httpRequest(`${st0.url}/api/v1/fs/read?root=${encodeURIComponent(repoDir)}&path=escape-link.txt`, { headers: auth })).status, 403);

    const artList = await httpRequest(`${st0.url}/api/v1/artifacts?sessionId=cid-1`, { headers: auth });
    assert.equal(artList.status, 200);
    assert.equal(artList.json.items.length, 2);
    const artImg = await httpRequest(`${st0.url}/api/v1/artifacts/cid-1/preview.png`, { headers: auth });
    assert.equal(artImg.status, 200);
    assert.match(artImg.json.dataUrl, /^data:image\/png;base64,/);

    // 6. Enable L2 via host settings + Cloudflare X-Agy-Confirm enforcement + FS/Git/PTY
    await harness.updatePluginSettings('agy-daddy.remote', { permissionLevel: 'L2' });
    assert.equal((await remoteSvc.getStatus()).allowRemoteWrite, true);
    assert.ok(await waitUntil(() => bodyEl.querySelector('[data-remote-permission-badge]')?.getAttribute('data-remote-permission-badge') === 'L2'));

    // Cloudflare without X-Agy-Confirm -> 403 CONFIRMATION_REQUIRED with HMAC confirmToken
    const cfBlocked = await httpRequest(`${st0.url}/api/v1/fs/write`, {
      method: 'PUT',
      headers: cfHeaders,
      body: { root: repoDir, path: 'new.txt', content: 'cf-write' }
    });
    assert.equal(cfBlocked.status, 403);
    assert.equal(cfBlocked.json.error, 'CONFIRMATION_REQUIRED');
    assert.ok(cfBlocked.json.confirmToken);

    // Bogus 'confirmed' sentinel must be rejected
    const cfBogus = await httpRequest(`${st0.url}/api/v1/fs/write`, {
      method: 'PUT',
      headers: { ...cfHeaders, 'X-Agy-Confirm': 'confirmed' },
      body: { root: repoDir, path: 'new.txt', content: 'cf-write' }
    });
    assert.equal(cfBogus.status, 403);

    // Valid HMAC confirmToken succeeds
    const cfOk = await httpRequest(`${st0.url}/api/v1/fs/write`, {
      method: 'PUT',
      headers: { ...cfHeaders, 'X-Agy-Confirm': cfBlocked.json.confirmToken },
      body: { root: repoDir, path: 'new.txt', content: 'cf-write' }
    });
    assert.equal(cfOk.status, 200);
    assert.equal(fs.readFileSync(path.join(repoDir, 'new.txt'), 'utf8'), 'cf-write');

    // Git stage + commit + worktree on loopback L2
    assert.equal((await httpRequest(`${st0.url}/api/v1/git/stage`, { method: 'POST', headers: auth, body: { root: repoDir, paths: ['new.txt'] } })).status, 200);
    const commitRes = await httpRequest(`${st0.url}/api/v1/git/commit`, { method: 'POST', headers: auth, body: { root: repoDir, message: 'add new.txt' } });
    assert.equal(commitRes.status, 200);
    assert.ok(commitRes.json.hash);

    const wtCreate = await httpRequest(`${st0.url}/api/v1/git/worktree`, {
      method: 'POST',
      headers: auth,
      body: { root: repoDir, action: 'create', path: '../repo-wt', branch: 'wt-test', createBranch: true }
    });
    assert.equal(wtCreate.status, 403); // ../repo-wt escapes repoDir allowedRoot!
    const wtCreateInside = await httpRequest(`${st0.url}/api/v1/git/worktree`, {
      method: 'POST',
      headers: auth,
      body: { root: repoDir, action: 'create', path: 'wt1', branch: 'wt-test', createBranch: true }
    });
    assert.equal(wtCreateInside.status, 200, JSON.stringify(wtCreateInside.json));
    assert.ok(wtCreateInside.json.worktrees.some((w) => w.branch === 'wt-test'));
    const wtListRes = await httpRequest(`${st0.url}/api/v1/git/worktrees?root=${encodeURIComponent(repoDir)}`, { headers: auth });
    assert.equal(wtListRes.status, 200);
    assert.equal(wtListRes.json.worktrees.length, 2);
    const wtRemoveRes = await httpRequest(`${st0.url}/api/v1/git/worktree`, {
      method: 'POST',
      headers: auth,
      body: { root: repoDir, action: 'remove', path: 'wt1' }
    });
    assert.equal(wtRemoveRes.status, 200);
    assert.equal(wtRemoveRes.json.worktrees.length, 1);

    // 7. VAPID Web Push endpoints
    const vapidRes = await httpRequest(`${st0.url}/api/v1/push/vapid-key`, { headers: auth });
    assert.equal(vapidRes.status, 200);
    assert.ok(vapidRes.json.publicKey.length > 20);
    const sub = makeDummyP256Sub('https://push.example/sub/v2');
    assert.equal((await httpRequest(`${st0.url}/api/v1/push/subscribe`, { method: 'POST', headers: auth, body: { subscription: sub } })).status, 200);
    const testPushRes = await httpRequest(`${st0.url}/api/v1/push/test`, { method: 'POST', headers: auth, body: {} });
    assert.equal(testPushRes.status, 200);
    assert.equal(testPushRes.json.sent, 1);
    const unsubRes = await httpRequest(`${st0.url}/api/v1/push/subscribe`, { method: 'DELETE', headers: auth, body: { endpoint: sub.endpoint } });
    assert.equal(unsubRes.status, 200, JSON.stringify(unsubRes.json));

    // 8. PTY WebSocket integration + Cloudflare confirm gate on WS
    const cfWsBlocked = await connectRawWs(`ws://127.0.0.1:${st0.port}/ws/pty?t=${token}&cwd=${encodeURIComponent(repoDir)}`, { 'cf-ray': 'cf-ws-1' });
    assert.equal(cfWsBlocked.statusCode, 403);

    if (process.platform !== 'win32') {
      const ws = await connectRawWs(`ws://127.0.0.1:${st0.port}/ws/pty?t=${token}&cwd=${encodeURIComponent(repoDir)}&sessionId=pty-v2`);
      assert.equal(ws.statusCode, 101);
      ws.sendText('echo AGY_REMOTE_V2_PTY_OK\r');
      const ptyOut = await ws.waitForOutput('AGY_REMOTE_V2_PTY_OK');
      assert.match(ptyOut, /AGY_REMOTE_V2_PTY_OK/);
      const ptyList = await httpRequest(`${st0.url}/api/v1/pty/sessions`, { headers: auth });
      assert.equal(ptyList.status, 200);
      assert.ok(ptyList.json.sessions.some((s) => s.id === 'pty-v2'));
      ws.close();
    }

    // Clean unload
    await harness.unloadPlugin('agy-daddy.remote');
    harness.assertCleanDispose('agy-daddy.remote');
  } finally {
    if (prevBrain === undefined) delete process.env.AGY_DADDY_BRAIN_DIR;
    else process.env.AGY_DADDY_BRAIN_DIR = prevBrain;
    await harness.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('remote-v2: L1 offline resilience when Antigravity RPC is completely unreachable', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-remote-offline-'));
  const repoDir = path.join(tmpRoot, 'ws');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Offline OK\n', 'utf8');

  const harness = createMockHostHarness({
    onRpc() {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:62485');
      err.code = 'ECONNREFUSED';
      throw err;
    }
  });

  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    await harness.updatePluginSettings('agy-daddy.remote', { allowedRoots: [repoDir], permissionLevel: 'L1' });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}` };

    const boot = await httpRequest(`${st.url}/api/v1/bootstrap`, { headers: auth });
    assert.equal(boot.status, 200);
    assert.equal(boot.json.rpcConnected, false);
    assert.equal(boot.json.voiceSupported, false);
    assert.deepEqual(boot.json.models, []);
    assert.equal(boot.json.workspaces.length, 1);

    const sessions = await httpRequest(`${st.url}/api/v1/sessions`, { headers: auth });
    assert.equal(sessions.status, 200);
    assert.equal(sessions.json.offline, true);
    assert.deepEqual(sessions.json.sessions, []);

    const readme = await httpRequest(`${st.url}/api/v1/fs/read?root=${encodeURIComponent(repoDir)}&path=README.md`, { headers: auth });
    assert.equal(readme.status, 200);
    assert.equal(readme.json.content, '# Offline OK\n');

    await harness.unloadPlugin('agy-daddy.remote');
    harness.assertCleanDispose('agy-daddy.remote');
  } finally {
    await harness.cleanup();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('remote-v2: consumes full web-harness service without leaking pairingUrl & forbids remote L2 elevation', async () => {
  const webPluginDir = path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-plugin-web');
  const rpcCalls = [];
  const harness = createMockHostHarness({
    onRpc(method, params) {
      rpcCalls.push({ method, params });
      if (method === 'GetAllCascadeTrajectories') {
        return { trajectorySummaries: {} };
      }
      if (method === 'StartCascade') {
        return { cascadeId: 'cid-via-web' };
      }
      if (method === 'GetCascadeTrajectory') {
        return {
          status: 'CASCADE_RUN_STATUS_IDLE',
          numTotalSteps: 1,
          trajectory: {
            trajectoryId: 'traj-web',
            steps: [
              {
                stepIndex: 0,
                type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
                status: 'CORTEX_STEP_STATUS_PENDING',
                requestedInteraction: { interaction: { runCommand: { proposedCommandLine: 'ls' } } }
              }
            ]
          }
        };
      }
      if (method === 'GetUserStatus') {
        return { userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: 'M1', modelOrAlias: { model: 'M1' } }] } } };
      }
      if (method === 'GetAvailableModels') {
        return { response: { defaultAgentModelId: 'M1', models: { M1: { model: 'M1', displayName: 'M1' } } } };
      }
      return { ok: true };
    }
  });

  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });

    await harness.loadAndRunPlugin(webPluginDir, { trustLevel: 'T0' });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    await harness.updatePluginSettings('agy-daddy.remote', { permissionLevel: 'L1' });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const boot = await httpRequest(`${st.url}/api/v1/bootstrap`, { headers: auth });
    assert.equal(boot.status, 200);
    assert.equal(boot.json.models.length >= 1, true);
    assert.equal('pairingUrl' in boot.json, false);
    assert.equal('pairingToken' in boot.json, false);

    const created = await httpRequest(`${st.url}/api/v1/sessions`, { method: 'POST', headers: auth, body: { title: 'Via Web' } });
    assert.equal(created.status, 200);
    assert.equal(created.json.cascadeId, 'cid-via-web');

    const approved = await httpRequest(`${st.url}/api/v1/sessions/cid-via-web/steps/0/approve`, {
      method: 'POST',
      headers: auth,
      body: { decision: 'allow' }
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.json.interactionType, 'runCommand');

    // Remote HTTP cannot elevate to L2
    assert.equal((await httpRequest(`${st.url}/api/v1/permission`, { method: 'POST', headers: auth, body: { permissionLevel: 'L2' } })).status, 404);
    assert.equal((await httpRequest(`${st.url}/api/action`, { method: 'POST', headers: auth, body: { action: 'setPermissionLevel', payload: { level: 'L2' } } })).status, 200);
    assert.equal((await remoteSvc.getStatus()).permissionLevel, 'L1');

    await harness.unloadPlugin('agy-daddy.remote');
    await harness.unloadPlugin('agy-daddy.web');
    harness.assertCleanDispose('agy-daddy.remote');
    harness.assertCleanDispose('agy-daddy.web');
  } finally {
    await harness.cleanup();
  }
});

test('remote-v2 regressions (P01/P03/P05): presets sanitization, model catalog cleanup, and /entry channel-aware copy + token scrub', async () => {
  const harness = createMockHostHarness({
    onRpc(method) {
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: {} };
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_PLACEHOLDER_DEFAULT' } },
              clientModelConfigs: [
                { label: 'Gemini 2.5 Pro', modelOrAlias: { model: 'M_DUP_DISABLED' }, disabled: true },
                { label: 'Gemini 2.5 Pro', modelOrAlias: { model: 'M_DUP_ENABLED' }, disabled: false },
                { label: '', modelOrAlias: { model: 'M_NO_LABEL' } },
                { label: 'MODEL_PLACEHOLDER_BAD', modelOrAlias: { model: 'MODEL_PLACEHOLDER_BAD' } }
              ]
            }
          }
        };
      }
      if (method === 'GetAvailableModels') {
        return {
          response: {
            defaultAgentModelId: 'MODEL_PLACEHOLDER_DEFAULT',
            models: {
              '': { model: '', displayName: 'Empty Id' },
              MODEL_PLACEHOLDER_DEFAULT: { model: 'MODEL_PLACEHOLDER_DEFAULT', displayName: '' },
              M_NO_LABEL: { model: 'M_NO_LABEL', displayName: '   ' },
              M_CLAUDE: { model: 'M_CLAUDE', displayName: 'Claude 4.5 Sonnet' }
            }
          }
        };
      }
      return { ok: true };
    }
  });

  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });

    harness.bus.provideService('agy-daddy.composer', 'composer-node', {
      listQuickPrompts: () => ({
        builtins: [
          null,
          undefined,
          { id: 'empty', label: '  ', text: '  ' },
          { id: 'plan', title: '规划模式', text: '/plan', enabled: true },
          { id: 'q1', title: 'Quick Title', text: 'Run quick check', enabled: true }
        ],
        custom: ['Plain string prompt', { id: 'c1', name: 'Named Custom', content: 'Custom content' }]
      }),
      listFrequentPrompts: () => ({
        presets: [null, { id: 'f1', label: 'Freq', prompt: 'Frequent prompt' }]
      })
    }, { realm: 'node' });

    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    await harness.updatePluginSettings('agy-daddy.remote', { cloudflare: true });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}` };

    // P01: presets never contain null, missing labels, or redundant /plan shortcut
    const presetsRes = await httpRequest(`${st.url}/api/v1/composer/presets`, { headers: auth });
    assert.equal(presetsRes.status, 200);
    assert.equal(presetsRes.json.presets.length, 4);
    assert.equal(presetsRes.json.presets.some((p) => p.prompt === '/plan'), false);
    for (const p of presetsRes.json.presets) {
      assert.ok(p && typeof p === 'object');
      assert.ok(typeof p.label === 'string' && p.label.length > 0);
      assert.ok(typeof p.prompt === 'string' && p.prompt.length > 0);
    }

    // P03: empty/placeholder models filtered, duplicate labels deduplicated keeping enabled, valid defaultModelId
    const bootRes = await httpRequest(`${st.url}/api/v1/bootstrap`, { headers: auth });
    assert.equal(bootRes.status, 200);
    const modelIds = bootRes.json.models.map((m) => m.id);
    assert.deepEqual(modelIds, ['M_CLAUDE', 'M_DUP_ENABLED']);
    assert.equal(bootRes.json.defaultModelId, 'M_CLAUDE');

    // P05: /entry on loopback renders loopback copy + token scrub, and LAN landing omits Cloudflare copy
    const entryLoopback = await httpRequest(`${st.url}/entry?t=${token}`);
    assert.equal(entryLoopback.status, 200);
    const entryBody = entryLoopback.text.split('<script>')[0];
    assert.match(entryBody, /已通过本机回环/);
    assert.match(entryBody, /本机回环/);
    assert.match(entryLoopback.text, /history\.replaceState/);
    assert.equal(entryBody.includes('已通过 Cloudflare 隧道接入'), false);

    const lanHtml = generateTunnelLandingHtml({
      version: '2.0.0',
      authenticated: true,
      writeEnabled: false,
      tunnelMode: 'named',
      currentChannel: 'lan',
      currentHost: '192.168.1.20:18765',
      entries: [{ key: 'lan', label: '局域网 (Wi-Fi)', enterUrl: 'http://192.168.1.20:18765/?t=abc', isCurrent: true }]
    });
    const lanBody = lanHtml.split('<script>')[0];
    assert.match(lanBody, /已通过局域网 \(Wi-Fi\) 接入/);
    assert.match(lanBody, /局域网直连/);
    assert.match(lanHtml, /history\.replaceState/);
    assert.equal(lanBody.includes('已通过 Cloudflare 隧道接入'), false);
    assert.equal(lanBody.includes('Named 固定隧道'), false);
    assert.equal(lanBody.includes('Cloudflare Tunnel 入口导航'), false);

    await harness.unloadPlugin('agy-daddy.remote');
    harness.assertCleanDispose('agy-daddy.remote');
  } finally {
    await harness.cleanup();
  }
});

test('remote-v2: model catalog 2-level metadata, host DB groups/projects/pins synced with Web, streaming delta cascadeId/status, and queue/steer endpoints', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-remote-org-'));
  const orgFile = path.join(tmpDir, 'session-org.json');
  const dbFile = path.join(tmpDir, 'conversation_summaries.db');
  const repoA = path.join(tmpDir, 'repo-alpha');
  const repoB = path.join(tmpDir, 'repo-beta');
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });

  // Populate real SQLite conversation_summaries DB fixture
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      step_count INTEGER NOT NULL DEFAULT 0,
      last_modified_time DATETIME NOT NULL,
      workspace_uris TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      project_id TEXT NOT NULL DEFAULT '',
      agent_name TEXT NOT NULL DEFAULT '',
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      nesting_depth INTEGER NOT NULL DEFAULT 0,
      group_id TEXT NOT NULL DEFAULT ''
    );
  `);
  const insert = db.prepare(`
    INSERT INTO conversation_summaries
      (conversation_id, title, step_count, last_modified_time, workspace_uris, status, project_id, agent_name, parent_conversation_id, nesting_depth, group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run('cid-alpha', 'Alpha Main', 4, '2026-11-24T11:00:00Z', JSON.stringify([`file://${repoA}`]), 'CASCADE_RUN_STATUS_RUNNING', 'proj-alpha', '', '', 0, 'host-group-1');
  insert.run('cid-sub', 'Subagent Task', 2, '2026-11-24T11:05:00Z', JSON.stringify([`file://${repoA}`]), 'CASCADE_RUN_STATUS_IDLE', 'proj-alpha', 'worker-1', 'cid-alpha', 1, 'host-group-1');
  insert.run('cid-beta', 'Beta Session', 3, '2026-11-24T10:30:00Z', JSON.stringify([`file://${repoB}`]), 'CASCADE_RUN_STATUS_IDLE', 'proj-beta', '', '', 0, '');
  db.close();

  const prevOrg = process.env.AGY_DADDY_SESSION_ORG_PATH;
  const prevDb = process.env.AGY_DADDY_CONVERSATION_DB_PATH;
  process.env.AGY_DADDY_SESSION_ORG_PATH = orgFile;
  process.env.AGY_DADDY_CONVERSATION_DB_PATH = dbFile;

  let alphaStatus = 'CASCADE_RUN_STATUS_RUNNING';
  let chunkSeq = 0;
  const dispatchedTexts = [];

  const harness = createMockHostHarness({
    onRpc(method, params) {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'cid-alpha': {
              title: 'Alpha Main',
              status: alphaStatus,
              stepCount: 4,
              lastModifiedTime: '2026-11-24T11:00:00Z',
              workspaces: [{ workspaceFolderAbsoluteUri: `file://${repoA}`, branchName: 'feat/mobile' }]
            },
            'cid-sub': {
              title: 'Subagent Task',
              status: 'CASCADE_RUN_STATUS_IDLE',
              stepCount: 2,
              lastModifiedTime: '2026-11-24T11:05:00Z',
              workspaces: [{ workspaceFolderAbsoluteUri: `file://${repoA}`, branchName: 'feat/mobile' }]
            },
            'cid-beta': {
              title: 'Beta Session',
              status: 'CASCADE_RUN_STATUS_IDLE',
              stepCount: 3,
              lastModifiedTime: '2026-11-24T10:30:00Z',
              workspaces: [{ workspaceFolderAbsoluteUri: `file://${repoB}`, branchName: 'main' }]
            }
          }
        };
      }
      if (method === 'GetCascadeTrajectorySteps') {
        chunkSeq += 1;
        return {
          status: alphaStatus,
          numTotalSteps: 2,
          steps: [
            {
              stepIndex: 0,
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: alphaStatus === 'CASCADE_RUN_STATUS_IDLE' ? 'CORTEX_STEP_STATUS_DONE' : 'CORTEX_STEP_STATUS_GENERATING',
              plannerResponse: {
                thinking: `thought-${chunkSeq}`,
                response: `stream-token-${chunkSeq}`
              }
            }
          ]
        };
      }
      if (method === 'SendUserCascadeMessage') {
        dispatchedTexts.push(params?.items?.[0]?.text || '');
        return { ok: true };
      }
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M537' } },
              clientModelConfigs: [
                { label: 'Gemini 3.1 Pro (Low)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M536' }, tagTitle: 'Fast' },
                { label: 'Gemini 3.1 Pro (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M537' }, tagTitle: 'Recommended', quotaInfo: { remainingFraction: 0.82 } },
                { label: 'Gemini 3.1 Pro (XHigh)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M538' } },
                { label: 'Gemini 3.1 Pro (Max)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M539' } },
                { label: 'Claude Sonnet 4.6', modelOrAlias: { model: 'MODEL_CLAUDE_46' } },
                { label: 'Claude Sonnet 4.6 (Thinking)', modelOrAlias: { model: 'MODEL_CLAUDE_46_THINK' } },
                { label: 'Orchestrator (Fast)', modelOrAlias: { model: 'MODEL_ORCH_FAST' } },
                { label: 'Orchestrator (High)', modelOrAlias: { model: 'MODEL_ORCH_HIGH' } },
                { label: 'MODEL_PLACEHOLDER_RAW', modelOrAlias: { model: 'MODEL_PLACEHOLDER_RAW' } }
              ]
            }
          }
        };
      }
      if (method === 'GetAvailableModels') {
        return {
          response: {
            defaultAgentModelId: 'MODEL_PLACEHOLDER_M537',
            models: {
              MODEL_PLACEHOLDER_M536: { model: 'MODEL_PLACEHOLDER_M536', displayName: 'Gemini 3.1 Pro (Low)' },
              MODEL_PLACEHOLDER_M537: { model: 'MODEL_PLACEHOLDER_M537', displayName: 'Gemini 3.1 Pro (High)' },
              MODEL_PLACEHOLDER_M538: { model: 'MODEL_PLACEHOLDER_M538', displayName: 'Gemini 3.1 Pro (XHigh)' },
              MODEL_PLACEHOLDER_M539: { model: 'MODEL_PLACEHOLDER_M539', displayName: 'Gemini 3.1 Pro (Max)' },
              MODEL_CLAUDE_46: { model: 'MODEL_CLAUDE_46', displayName: 'Claude Sonnet 4.6' },
              MODEL_CLAUDE_46_THINK: { model: 'MODEL_CLAUDE_46_THINK', displayName: 'Claude Sonnet 4.6 (Thinking)' },
              MODEL_ORCH_FAST: { model: 'MODEL_ORCH_FAST', displayName: 'Orchestrator (Fast)' },
              MODEL_ORCH_HIGH: { model: 'MODEL_ORCH_HIGH', displayName: 'Orchestrator (High)' }
            }
          }
        };
      }
      return { ok: true };
    }
  });

  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
    const webPluginDir = path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-plugin-web');
    await harness.loadAndRunPlugin(webPluginDir, { trustLevel: 'T0' });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const webSvc = harness.bus.getServiceProxy('web-harness');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 1. Model catalog preserves MODEL_PLACEHOLDER_* with valid labels & builds 2-level modelGroups
    const boot = await httpRequest(`${st.url}/api/v1/bootstrap`, { headers: auth });
    assert.equal(boot.status, 200);
    assert.equal(boot.json.defaultModelId, 'MODEL_PLACEHOLDER_M537');
    const ids = boot.json.models.map((m) => m.id);
    assert.ok(ids.includes('MODEL_PLACEHOLDER_M536'));
    assert.ok(ids.includes('MODEL_PLACEHOLDER_M537'));
    assert.ok(ids.includes('MODEL_CLAUDE_46'));
    assert.ok(ids.includes('MODEL_CLAUDE_46_THINK'));
    assert.ok(ids.includes('MODEL_ORCH_FAST'));
    assert.ok(ids.includes('MODEL_ORCH_HIGH'));
    assert.equal(ids.includes('MODEL_PLACEHOLDER_RAW'), false);

    const orchGroup = boot.json.modelGroups.find((g) => g.id === 'orchestrator');
    assert.ok(orchGroup && orchGroup.isOrchestrator);
    assert.equal(orchGroup.variants.length, 2);
    const gemGroup = boot.json.modelGroups.find((g) => g.label === 'Gemini 3.1 Pro');
    assert.ok(gemGroup && gemGroup.kind === 'thinking_family' && gemGroup.hasThinkingTiers);
    assert.deepEqual(gemGroup.variants.map((v) => v.thinkingLevel), ['low', 'high', 'xhigh', 'max']);
    assert.equal(gemGroup.variants.find((v) => v.thinkingLevel === 'xhigh')?.label, 'XHigh');
    const xhighModel = boot.json.models.find((m) => m.id === 'MODEL_PLACEHOLDER_M538');
    assert.equal(xhighModel.family, 'Gemini 3.1 Pro');
    assert.equal(xhighModel.thinkingLevel, 'xhigh');
    assert.equal(xhighModel.thinkingLabel, 'XHigh');
    assert.equal(boot.json.permissionInfo.hostOnlyElevation, true);

    // 2. Host DB enrichment: subagent filtered by default, included with includeSubagents=true
    const sessDefault = await httpRequest(`${st.url}/api/v1/sessions`, { headers: auth });
    assert.equal(sessDefault.status, 200);
    assert.equal(sessDefault.json.sessions.some((s) => s.cascadeId === 'cid-sub'), false);
    const alphaSess = sessDefault.json.sessions.find((s) => s.cascadeId === 'cid-alpha');
    assert.equal(alphaSess.groupId, 'host-group-1');
    assert.equal(alphaSess.projectId, 'proj-alpha');
    assert.ok(sessDefault.json.groups.some((g) => g.id === 'host-group-1'));
    assert.ok(sessDefault.json.projects.some((p) => p.id === 'proj-alpha'));

    const sessWithSub = await httpRequest(`${st.url}/api/v1/sessions?includeSubagents=true`, { headers: auth });
    const subSess = sessWithSub.json.sessions.find((s) => s.cascadeId === 'cid-sub');
    assert.ok(subSess && subSess.isSubagent === true && subSess.parentConversationId === 'cid-alpha' && subSess.agentName === 'worker-1');

    // L0 blocks pin/group mutations & orchestrator thinking mutations
    assert.equal((await httpRequest(`${st.url}/api/v1/sessions/pin`, { method: 'POST', headers: auth, body: { type: 'session', id: 'cid-beta' } })).status, 403);
    assert.equal((await httpRequest(`${st.url}/api/v1/orchestrator/thinking`, { method: 'POST', headers: auth, body: { master: 'carbon', thinkingLevel: 'xhigh' } })).status, 403);

    // Elevate to L1 via host settings
    await harness.updatePluginSettings('agy-daddy.remote', { permissionLevel: 'L1', modelSortMode: 'name_asc' });

    // Independent orchestrator master thinking level update & persistence
    const orchCarbonRes = await httpRequest(`${st.url}/api/v1/orchestrator/thinking`, {
      method: 'POST',
      headers: auth,
      body: { master: 'carbon', thinkingLevel: 'xhigh' }
    });
    assert.equal(orchCarbonRes.status, 200);
    assert.equal(orchCarbonRes.json.orchestratorThinking.carbon, 'xhigh');
    assert.equal(orchCarbonRes.json.orchestratorThinking.argon, 'high');

    const orchOpusRes = await httpRequest(`${st.url}/api/v1/orchestrator/thinking`, {
      method: 'POST',
      headers: auth,
      body: { master: 'opus5.5', thinkingLevel: 'medium' }
    });
    assert.equal(orchOpusRes.status, 200);
    assert.equal(orchOpusRes.json.orchestratorThinking['opus5.5'], 'medium');
    assert.equal(orchOpusRes.json.orchestratorThinking.carbon, 'xhigh');

    const bootAfterOrch = await httpRequest(`${st.url}/api/v1/bootstrap`, { headers: auth });
    assert.equal(bootAfterOrch.json.orchestratorThinking.carbon, 'xhigh');
    assert.equal(bootAfterOrch.json.orchestratorThinking['opus5.5'], 'medium');
    assert.equal(bootAfterOrch.json.modelPreferences.sortMode, 'name_asc');

    // 3. Pin via Remote -> synced to Web (/api/sessions/org) via shared ~/.agy-daddy/session-org.json!
    const pinRes = await httpRequest(`${st.url}/api/v1/sessions/pin`, {
      method: 'POST',
      headers: auth,
      body: { type: 'session', id: 'cid-beta' }
    });
    assert.equal(pinRes.status, 200);
    assert.equal(pinRes.json.pinned, true);
    assert.ok(pinRes.json.pins.sessions.includes('cid-beta'));

    const webSt = await webSvc.getStatus();
    const webAuth = { Authorization: `Bearer ${webSt.pairingToken}`, 'Content-Type': 'application/json' };
    const webOrg = await httpRequest(`${webSt.url}/api/sessions/org`, { headers: webAuth });
    assert.equal(webOrg.status, 200);
    assert.ok(webOrg.json.pins.sessions.includes('cid-beta'));

    // Create group via Web (/api/sessions/groups) -> visible on Remote (/api/v1/sessions/org)!
    const grpCreate = await httpRequest(`${webSt.url}/api/sessions/groups`, {
      method: 'POST',
      headers: webAuth,
      body: { action: 'upsert', name: 'Synced Work', projectIds: ['proj-beta'] }
    });
    assert.equal(grpCreate.status, 200);
    const remoteOrg = await httpRequest(`${st.url}/api/v1/sessions/org`, { headers: auth });
    assert.equal(remoteOrg.status, 200);
    assert.ok(remoteOrg.json.groups.some((g) => g.name === 'Synced Work'));

    // 4. Streaming delta emits cascadeId + sessionId + status + totalSteps on non-terminal generating step
    const sse = await openSse(`${st.url}/api/v1/stream?t=${token}&sessionId=cid-alpha`);
    const d1 = await sse.waitForEvent((e) => e.event === 'session.delta');
    assert.equal(d1.json.cascadeId, 'cid-alpha');
    assert.equal(d1.json.sessionId, 'cid-alpha');
    assert.equal(d1.json.status, 'CASCADE_RUN_STATUS_RUNNING');
    assert.equal(d1.json.totalSteps, 2);
    assert.equal(d1.json.events[0].status, 'generating');

    // Second incremental chunk arrives even though stepOffset hasn't advanced
    const d2 = await sse.waitForEvent((e) =>
      e.event === 'session.delta' && e.json?.events?.[0]?.payload?.text && e.json.events[0].payload.text !== d1.json.events[0].payload.text
    );
    assert.equal(d2.json.cascadeId, 'cid-alpha');

    // 5. Queue management endpoints: enqueue -> GET queue -> DELETE -> POST steer
    const enq1 = await httpRequest(`${st.url}/api/v1/sessions/cid-alpha/messages`, {
      method: 'POST',
      headers: auth,
      body: { text: 'queue-item-delete', dispatchMode: 'queue' }
    });
    assert.equal(enq1.status, 200);
    assert.equal(enq1.json.queued, true);
    assert.equal(enq1.json.queue.length, 1);
    assert.equal(enq1.json.queue[0].id, enq1.json.queueId);

    const enq2 = await httpRequest(`${st.url}/api/v1/sessions/cid-alpha/messages`, {
      method: 'POST',
      headers: auth,
      body: { text: 'queue-item-steer', dispatchMode: 'queue' }
    });
    assert.equal(enq2.status, 200);
    assert.equal(enq2.json.queue.length, 2);

    const qList = await httpRequest(`${st.url}/api/v1/sessions/cid-alpha/queue`, { headers: auth });
    assert.equal(qList.status, 200);
    assert.equal(qList.json.queue.length, 2);

    const delRes = await httpRequest(`${st.url}/api/v1/sessions/cid-alpha/queue/${encodeURIComponent(enq1.json.queueId)}`, {
      method: 'DELETE',
      headers: auth
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.json.removed, true);
    assert.equal(delRes.json.queue.length, 1);

    const steerRes = await httpRequest(`${st.url}/api/v1/sessions/cid-alpha/queue/${encodeURIComponent(enq2.json.queueId)}/steer`, {
      method: 'POST',
      headers: auth,
      body: {}
    });
    assert.equal(steerRes.status, 200);
    assert.equal(steerRes.json.steered, true);
    assert.equal(steerRes.json.queue.length, 0);
    assert.ok(dispatchedTexts.includes('queue-item-steer'));

    const qEvt = await sse.waitForEvent((e) => e.event === 'queue.update' && e.json?.action === 'steered');
    assert.equal(qEvt.json.cascadeId, 'cid-alpha');

    sse.close();
    await harness.unloadPlugin('agy-daddy.remote');
    await harness.unloadPlugin('agy-daddy.web');
    harness.assertCleanDispose('agy-daddy.remote');
    harness.assertCleanDispose('agy-daddy.web');
  } finally {
    if (prevOrg === undefined) delete process.env.AGY_DADDY_SESSION_ORG_PATH;
    else process.env.AGY_DADDY_SESSION_ORG_PATH = prevOrg;
    if (prevDb === undefined) delete process.env.AGY_DADDY_CONVERSATION_DB_PATH;
    else process.env.AGY_DADDY_CONVERSATION_DB_PATH = prevDb;
    await harness.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('remote-v2: filters internal temp/probe workspaces (agy-model-probe-*, route-score-*, magpie-agy-bridge-*) from projects and sessions', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-probe-filter-test-'));
  const orgFile = path.join(tmpDir, 'session-org.json');
  try {
    assert.equal(isTempBridgeWorkspace('file:///private/var/folders/3n/8vkwhj6x64dfnxs_mb25ztdc0000gn/T/agy-model-probe-0cb6YA'), true);
    assert.equal(isTempBridgeWorkspace('/private/var/folders/3n/8vkwhj6x64dfnxs_mb25ztdc0000gn/T/route-score-ax7r2i_g'), true);
    assert.equal(isTempBridgeWorkspace('/private/var/folders/3n/8vkwhj6x64dfnxs_mb25ztdc0000gn/T/magpie-agy-bridge-XVAljS'), true);
    assert.equal(isTempBridgeWorkspace('/Volumes/external/Projects/agy-daddy'), false);
    assert.equal(isTempBridgeWorkspace('/tmp/my-custom-workspace'), false);

    const store = createSessionOrgStore({ orgPath: orgFile, dbPath: null });
    const enriched = store.enrichSessionsAndOrg({
      rpcSessions: [
        {
          cascadeId: 'probe-session-1',
          title: '',
          workspaceUri: 'file:///private/var/folders/3n/8vkwhj6x64dfnxs_mb25ztdc0000gn/T/agy-model-probe-0cb6YA',
          lastModifiedTime: '2026-11-24T05:00:00Z'
        },
        {
          cascadeId: 'route-score-1',
          title: '',
          workspaceUri: 'file:///private/var/folders/3n/8vkwhj6x64dfnxs_mb25ztdc0000gn/T/route-score-ax7r2i_g',
          lastModifiedTime: '2026-11-24T04:50:00Z'
        },
        {
          cascadeId: 'real-bridged-session',
          title: 'Real Workspace Chat',
          workspaceUri: 'file:///private/var/folders/3n/8vkwhj6x64dfnxs_mb25ztdc0000gn/T/magpie-agy-bridge-XVAljS',
          workspaces: [
            { workspaceFolderAbsoluteUri: 'file:///private/var/folders/3n/8vkwhj6x64dfnxs_mb25ztdc0000gn/T/magpie-agy-bridge-XVAljS' },
            { workspaceFolderAbsoluteUri: 'file:///Volumes/external/Projects/real-app' }
          ],
          lastModifiedTime: '2026-11-24T04:40:00Z'
        }
      ],
      allowedRoots: [
        '/Volumes/external/Projects/real-app',
        '/private/var/folders/3n/8vkwhj6x64dfnxs_mb25ztdc0000gn/T/agy-model-probe-0cb6YA'
      ]
    });

    const sessionIds = enriched.sessions.map((s) => s.cascadeId);
    assert.deepEqual(sessionIds, ['real-bridged-session']);
    assert.equal(enriched.sessions[0].workspaceUri, 'file:///Volumes/external/Projects/real-app');

    const projectNames = enriched.projects.map((p) => p.name);
    assert.equal(projectNames.includes('agy-model-probe-0cb6YA'), false);
    assert.equal(projectNames.includes('route-score-ax7r2i_g'), false);
    assert.equal(projectNames.includes('magpie-agy-bridge-XVAljS'), false);
    assert.deepEqual(projectNames, ['real-app']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('remote-v2: getSessionDetail seeds the delta cursor so the first SSE poll resumes after the terminal prefix', async () => {
  const TOTAL_STEPS = 50;
  const completedSteps = Array.from({ length: TOTAL_STEPS }, (_, idx) => ({
    stepIndex: idx,
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    plannerResponse: { response: `done-step-${idx}` }
  }));
  const stepCalls = [];
  let liveStep = null;

  const harness = createMockHostHarness({
    onRpc(method, params) {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'cid-50': {
              title: 'Long Finished Session',
              status: 'CASCADE_RUN_STATUS_IDLE',
              stepCount: TOTAL_STEPS,
              lastModifiedTime: '2026-11-24T10:00:00Z'
            }
          }
        };
      }
      if (method === 'GetCascadeTrajectory') {
        return {
          status: 'CASCADE_RUN_STATUS_IDLE',
          numTotalSteps: TOTAL_STEPS,
          trajectory: { cascadeId: params.cascadeId, steps: completedSteps }
        };
      }
      if (method === 'GetCascadeTrajectorySteps') {
        stepCalls.push({ stepOffset: params.stepOffset });
        if (params.stepOffset < TOTAL_STEPS) {
          return {
            status: 'CASCADE_RUN_STATUS_IDLE',
            numTotalSteps: TOTAL_STEPS,
            steps: completedSteps.slice(params.stepOffset)
          };
        }
        return {
          status: liveStep ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
          numTotalSteps: TOTAL_STEPS + (liveStep ? 1 : 0),
          steps: liveStep ? [liveStep] : []
        };
      }
      if (method === 'GetUserStatus') {
        return { userStatus: { cascadeModelConfigData: { defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_A' } }, clientModelConfigs: [] } } };
      }
      if (method === 'GetAvailableModels') {
        return { response: { defaultAgentModelId: 'MODEL_A', models: { MODEL_A: { model: 'MODEL_A', displayName: 'Model A' } } } };
      }
      return { ok: true };
    }
  });

  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const detail = await httpRequest(`${st.url}/api/v1/sessions/cid-50`, { headers: auth });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.session.numTotalSteps, TOTAL_STEPS);
    assert.equal(detail.json.events.length, TOTAL_STEPS);

    // Detail already rendered the whole terminal prefix: the first delta poll must resume at 50.
    const sse = await openSse(`${st.url}/api/v1/stream?t=${token}&sessionId=cid-50`);
    const first = await sse.waitForEvent((e) => e.event === 'session.delta');
    assert.equal(first.json.nextOffset, TOTAL_STEPS);
    assert.equal(first.json.events.length, 0);
    assert.ok(stepCalls.length >= 1, 'expected GetCascadeTrajectorySteps to be polled');
    assert.equal(stepCalls[0].stepOffset, TOTAL_STEPS, 'first delta poll must not re-pull history from 0');

    // A brand-new step still streams through on the next poll.
    liveStep = {
      stepIndex: TOTAL_STEPS,
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_GENERATING',
      plannerResponse: { response: 'streaming-token' }
    };
    const streamed = await sse.waitForEvent((e) => e.event === 'session.delta' && e.json?.events?.length > 0, 3000);
    assert.equal(streamed.json.events[0].seq, TOTAL_STEPS);
    assert.equal(streamed.json.events[0].status, 'generating');

    sse.close();
    await harness.unloadPlugin('agy-daddy.remote');
    harness.assertCleanDispose('agy-daddy.remote');
  } finally {
    await harness.cleanup();
  }
});

test('HUB-296: standaloneRpcAdapter & getBootstrap preserve object-map groupedModels and web-harness tree supportedThinkingLevels without padding', async () => {
  const rpcFixtures = {
    GetUserStatus: () => ({
      userStatus: {
        cascadeModelConfigData: {
          defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M533' } },
          clientModelConfigs: [
            { label: 'Gemini 4 Neon (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M533' }, modelId: 'gemini-4-neon-medium' },
            { label: 'Gemini 4 Neon (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' }, modelId: 'gemini-4-neon-high' },
            { label: 'Claude Opus 5.5 (Low)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M400' }, modelId: 'claude-opus-5-5-low' },
            { label: 'Claude Opus 5.5 (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M401' }, modelId: 'claude-opus-5-5-medium' },
            { label: 'Claude Opus 5.5 (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' }, modelId: 'claude-opus-5-5-high' },
            { label: 'Orchestrator (Neon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M537' }, modelId: 'gemini-pro-orchestrator-neon' },
            { label: 'GPT-OSS 120B', modelOrAlias: { model: 'MODEL_GPT_OSS_SINGLE' }, modelId: 'gpt-oss-120b' }
          ],
          groupedModels: {
            'gemini-4-neon': {
              displayName: 'Gemini 4 Neon',
              supportedThinkingLevels: [
                { thinkingSuffix: 'medium', thinkingDisplayName: 'Medium' },
                { thinkingSuffix: 'high', thinkingDisplayName: 'High' }
              ]
            },
            'claude-opus-5-5': {
              displayName: 'Claude Opus 5.5',
              supportedThinkingLevels: [
                { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
                { thinkingSuffix: 'medium', thinkingDisplayName: 'Medium' },
                { thinkingSuffix: 'high', thinkingDisplayName: 'High' }
              ]
            },
            'gpt-oss-120b': {
              displayName: 'GPT-OSS 120B',
              supportedThinkingLevels: []
            }
          }
        }
      }
    }),
    GetAvailableModels: () => ({
      response: {
        defaultAgentModelId: 'MODEL_PLACEHOLDER_M533',
        models: {
          'gemini-4-neon-medium': { model: 'MODEL_PLACEHOLDER_M533', displayName: 'Gemini 4 Neon (Medium)', thinkingLevel: 2 },
          'gemini-4-neon-high': { model: 'MODEL_PLACEHOLDER_M532', displayName: 'Gemini 4 Neon (High)', thinkingLevel: 3 },
          'claude-opus-5-5-low': { model: 'MODEL_PLACEHOLDER_M400', displayName: 'Claude Opus 5.5 (Low)', thinkingLevel: 1 },
          'claude-opus-5-5-medium': { model: 'MODEL_PLACEHOLDER_M401', displayName: 'Claude Opus 5.5 (Medium)', thinkingLevel: 2 },
          'claude-opus-5-5-high': { model: 'MODEL_PLACEHOLDER_M402', displayName: 'Claude Opus 5.5 (High)', thinkingLevel: 3 },
          'gemini-pro-orchestrator-neon': { model: 'MODEL_PLACEHOLDER_M537', displayName: 'Orchestrator (Neon)', thinkingLevel: 3 },
          'gpt-oss-120b': { model: 'MODEL_GPT_OSS_SINGLE', displayName: 'GPT-OSS 120B' }
        },
        groupedModels: {
          'gemini-4-neon': {
            displayName: 'Gemini 4 Neon',
            supportedThinkingLevels: [
              { thinkingSuffix: 'medium', thinkingDisplayName: 'Medium' },
              { thinkingSuffix: 'high', thinkingDisplayName: 'High' }
            ]
          }
        }
      }
    })
  };

  // Part A: standaloneRpcAdapter (without web-harness) preserves object-map groupedModels
  const standaloneHarness = createMockHostHarness({
    onRpc(method) {
      if (rpcFixtures[method]) return rpcFixtures[method]();
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: {} };
      return { ok: true };
    }
  });
  try {
    const { port: bridgePort } = await standaloneHarness.bridge.start(0);
    standaloneHarness.rendererHost.configure({ bridgePort, hostToken: standaloneHarness.bridge.hostToken });
    await standaloneHarness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    const remoteSvc = standaloneHarness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const boot = await httpRequest(`${st.url}/api/v1/bootstrap`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(boot.status, 200);

    const neonMed = boot.json.models.find((m) => m.id === 'MODEL_PLACEHOLDER_M533');
    assert.deepEqual(neonMed.supportedThinkingLevels, ['medium', 'high']);

    const neonGroup = boot.json.modelGroups.find((g) => g.label === 'Gemini 4 Neon');
    assert.deepEqual(neonGroup.supportedThinkingLevels, ['medium', 'high']);

    const opusGroup = boot.json.modelGroups.find((g) => g.label === 'Claude Opus 5.5');
    assert.deepEqual(opusGroup.supportedThinkingLevels, ['low', 'medium', 'high']);

    const singleGpt = boot.json.models.find((m) => m.id === 'MODEL_GPT_OSS_SINGLE');
    assert.deepEqual(singleGpt.supportedThinkingLevels, []);

    const orchGroup = boot.json.modelGroups.find((g) => g.id === 'orchestrator');
    const orchNeon = orchGroup.variants.find((v) => v.modelId === 'MODEL_PLACEHOLDER_M537');
    assert.deepEqual(orchNeon.supportedThinkingLevels, ['medium', 'high']);

    await standaloneHarness.unloadPlugin('agy-daddy.remote');
    standaloneHarness.assertCleanDispose('agy-daddy.remote');
  } finally {
    await standaloneHarness.cleanup();
  }

  // Part B: with web-harness loaded, getBootstrap also preserves modelTree + exact supportedThinkingLevels
  const webHarness = createMockHostHarness({
    onRpc(method) {
      if (rpcFixtures[method]) return rpcFixtures[method]();
      if (method === 'GetAllCascadeTrajectories') return { trajectorySummaries: {} };
      return { ok: true };
    }
  });
  try {
    const { port: bridgePort } = await webHarness.bridge.start(0);
    webHarness.rendererHost.configure({ bridgePort, hostToken: webHarness.bridge.hostToken });
    const webPluginDir = path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-plugin-web');
    await webHarness.loadAndRunPlugin(webPluginDir, { trustLevel: 'T0' });
    await webHarness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    const remoteSvc = webHarness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const boot = await httpRequest(`${st.url}/api/v1/bootstrap`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(boot.status, 200);
    assert.ok(boot.json.modelTree && Array.isArray(boot.json.modelTree.nodes));

    const orchTreeNode = boot.json.modelTree.nodes.find((n) => n.key === 'orch');
    const neonOrchLeaf = orchTreeNode.children.find((c) => c.key === 'orch/gemini-4-neon');
    assert.deepEqual(neonOrchLeaf.supportedThinkingLevels, ['medium', 'high']);
    const opusOrchLeaf = orchTreeNode.children.find((c) => c.key === 'orch/claude-opus-5-5');
    assert.deepEqual(opusOrchLeaf.supportedThinkingLevels, ['low', 'medium', 'high']);

    const orchGroup = boot.json.modelGroups.find((g) => g.id === 'orchestrator');
    const orchNeonVariant = orchGroup.variants.find((v) => v.modelId === 'MODEL_PLACEHOLDER_M537');
    assert.deepEqual(orchNeonVariant.supportedThinkingLevels, ['medium', 'high']);

    await webHarness.unloadPlugin('agy-daddy.remote');
    await webHarness.unloadPlugin('agy-daddy.web');
    webHarness.assertCleanDispose('agy-daddy.remote');
    webHarness.assertCleanDispose('agy-daddy.web');
  } finally {
    await webHarness.cleanup();
  }
});
