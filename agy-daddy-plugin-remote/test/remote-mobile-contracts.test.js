'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const { createPtyManager } = require('../src/pty-bridge');
const { truncateUtf8Tail } = require('../src/task-manager');
const { generatePwaHtml } = require('../src/pwa-html');

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
    if (bodyBuf) req.write(bodyBuf);
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
        waitForEvent(pred, timeoutMs = 3000) {
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

test('G-1: full telemetry aggregation, fallback, and FourRealmBus SSE telemetry.patch/state.patch sync', async () => {
  const harness = createMockHostHarness();
  try {
    let contextLoc = 'topbar';
    harness.bus.provideService('agy-daddy.context', 'context', {
      getSnapshot: () => ({
        hasSession: true,
        cascadeId: 'cid-1',
        title: 'Main Task',
        model: 'Gemini 4',
        used: 120000,
        budget: 1000000,
        percent: 12,
        inputTokens: 80000,
        cachedTokens: 30000,
        uncachedInput: 50000,
        outputTokens: 10000,
        cacheHitRate: 0.375,
        speed: 142,
        warnThresholdTokens: 240000,
        cliffThresholdTokens: 328000,
        groups: { user: { high: 20000 }, assistant: { high: 60000 }, tools: { high: 40000 } },
        alerts: [{ level: 'warn', code: 'cache_warn', message: 'Approaching cliff' }],
        displayLocation: contextLoc,
        showSpeed: true,
        compactPolicy: 'remind'
      }),
      getSettings: () => ({ displayLocation: contextLoc, showSpeed: true, compactPolicy: 'remind' })
    }, { realm: 'node' });

    harness.bus.provideService('agy-daddy.usage', 'usage', {
      getSummary: () => ({
        totalTokens: 50000,
        totalUsd: 1.25,
        cacheReadTokens: 20000,
        periods: {
          today: { totalTokens: 5000, totalUsd: 0.12, roi: { effectiveSavedUsd: 2.4 } },
          month: { totalTokens: 50000, totalUsd: 1.25 }
        },
        byModel: {
          'gemini-4': { calls: 4, tokens: 50000, costUSD: 1.25 }
        }
      })
    }, { realm: 'node' });

    harness.bus.provideService('agy-daddy.quota', 'quota', {
      getSnapshot: () => ({
        planTier: 'ultra',
        ultraSubTier: '20x',
        quotaMultiplier: 20,
        tightestFraction: 0.42,
        tightestPercentText: '剩余最少 42%',
        pools: [
          {
            id: 'pool-g',
            title: 'Gemini Main',
            models: ['gemini-4'],
            tightestFraction: 0.42,
            fiveHourBucket: { remainingFraction: 0.42, countdownText: '2小时10分' },
            weeklyBucket: { remainingFraction: 0.85, countdownText: '5天' }
          }
        ]
      })
    }, { realm: 'node' });

    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    await harness.updatePluginSettings('agy-daddy.remote', {
      loopback: true,
      permissionLevel: 'L1',
      allowRemoteWrite: true
    });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}` };

    const boot = await httpRequest(`${st.url}/api/v1/bootstrap`, { headers: auth });
    assert.equal(boot.status, 200);
    assert.equal(typeof boot.json.runningTasksCount, 'number');

    const ctx = boot.json.telemetry.panels.context.data;
    assert.equal(ctx.displayLocation, 'topbar');
    assert.equal(ctx.showSpeed, true);
    assert.equal(ctx.compactPolicy, 'remind');
    assert.equal(ctx.inputTokens, 80000);
    assert.equal(ctx.cachedTokens, 30000);
    assert.equal(ctx.uncachedInput, 50000);
    assert.equal(ctx.outputTokens, 10000);
    assert.equal(ctx.cacheHitRate, 0.375);
    assert.equal(ctx.speed, 142);
    assert.equal(Array.isArray(ctx.groups), true);
    assert.equal(ctx.groups.length, 3);
    assert.equal(ctx.alerts[0].level, 'warn');

    const usage = boot.json.telemetry.panels.usage.data;
    assert.equal(usage.cacheReadTokens, 20000);
    assert.equal(usage.periods.today.totalTokens, 5000);
    assert.equal(usage.periods.roi.savedUsd, 2.4);
    assert.equal(Array.isArray(usage.byModel), true);
    assert.equal(usage.byModel[0].model, 'gemini-4');

    const quota = boot.json.telemetry.panels.quota.data;
    assert.equal(quota.planTier, 'ultra');
    assert.equal(quota.ultraSubTier, '20x');
    assert.equal(quota.quotaMultiplier, 20);
    assert.equal(quota.pools.length, 1);
    assert.equal(quota.pools[0].fiveHourBucket.resetInHuman, '2小时10分');

    const sse = await openSse(`${st.url}/api/v1/stream`, auth);
    try {
      contextLoc = 'composer';
      harness.bus.setState('agy-daddy.context', 'state:context.snapshot@1', { displayLocation: 'composer' });
      const telEv = await sse.waitForEvent(
        (e) => e.event === 'telemetry.patch' && e.json?.panels?.context?.data?.displayLocation === 'composer',
        2500
      );
      assert.equal(typeof telEv.json.runningTasksCount, 'number');

      harness.bus.setState('agy-daddy.composer', 'state:composer.settings@1', { showQuickBar: false });
      const stateEv = await sse.waitForEvent(
        (e) => e.event === 'state.patch' && e.json?.key === 'state:composer.settings@1',
        2500
      );
      assert.equal(stateEv.json.value.showQuickBar, false);
    } finally {
      sse.close();
    }

    // Timeout fallback test: slow getSnapshot falls back to state:context.snapshot@1
    harness.bus.provideService('agy-daddy.context', 'context', {
      getSnapshot: () => new Promise(() => {}),
      getSettings: () => ({ displayLocation: 'composer' })
    }, { realm: 'node' });
    harness.bus.setState('agy-daddy.context', 'state:context.snapshot@1', {
      hasSession: true,
      used: 555,
      budget: 1000,
      displayLocation: 'composer'
    });
    const fallbackSnap = await remoteSvc.getSnapshot();
    assert.equal(fallbackSnap.panels.context.available, true);
    assert.equal(fallbackSnap.panels.context.data.used, 555);
  } finally {
    await harness.cleanup();
  }
});

test('G-2: composer state/local-fallback optimize and /compact route + action fix', async () => {
  const sentMessages = [];
  let activeSessions = [];
  const harness = createMockHostHarness({
    onRpc(method, params) {
      if (method === 'GetAllCascadeTrajectories') {
        const summaries = {};
        for (const s of activeSessions) summaries[s.id] = { summary: s.title, status: s.status };
        return { trajectorySummaries: summaries };
      }
      if (method === 'SendUserCascadeMessage') {
        sentMessages.push(params);
        return { ok: true };
      }
      return {};
    }
  });
  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    await harness.updatePluginSettings('agy-daddy.remote', {
      loopback: true,
      permissionLevel: 'L1',
      allowRemoteWrite: true
    });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 1. /api/v1/composer/state alias & settings when composer-node is offline
    const stateRes = await httpRequest(`${st.url}/api/v1/composer/state`, { headers: auth });
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.json.available, false);
    assert.equal(stateRes.json.settings.showQuickBar, true);
    assert.equal(stateRes.json.settings.ghostSuggest, true);

    // 2. Local optimize fallback (short -> unchanged, normal -> structured, slash -> 400)
    const shortOpt = await httpRequest(`${st.url}/api/v1/composer/optimize`, {
      method: 'POST',
      headers: auth,
      body: { text: 'hello' }
    });
    assert.equal(shortOpt.status, 200);
    assert.equal(shortOpt.json.source, 'local-fallback');
    assert.equal(shortOpt.json.unchanged, true);
    assert.equal(shortOpt.json.optimizedText, 'hello');

    const fullOpt = await httpRequest(`${st.url}/api/v1/composer/optimize`, {
      method: 'POST',
      headers: auth,
      body: { text: 'Refactor login form validation' }
    });
    assert.equal(fullOpt.status, 200);
    assert.equal(fullOpt.json.source, 'local-fallback');
    assert.equal(fullOpt.json.unchanged, false);
    assert.match(fullOpt.json.optimizedText, /Goal:/);

    const slashOpt = await httpRequest(`${st.url}/api/v1/composer/optimize`, {
      method: 'POST',
      headers: auth,
      body: { text: '/compact' }
    });
    assert.equal(slashOpt.status, 400);
    assert.equal(slashOpt.json.error, 'SLASH_ONLY');

    // 3. /compact with no active session -> 400 SESSION_REQUIRED
    const noSessAction = await httpRequest(`${st.url}/api/action`, {
      method: 'POST',
      headers: auth,
      body: { action: 'compact' }
    });
    assert.equal(noSessAction.status, 400);
    assert.equal(noSessAction.json.error, 'SESSION_REQUIRED');

    // 4. /compact with active session & /api/v1/sessions/:id/compact + Cloudflare confirm
    activeSessions = [{ id: 'cid-compact-1', title: 'S1', status: 'CASCADE_RUN_STATUS_IDLE' }];
    const okAction = await httpRequest(`${st.url}/api/action`, {
      method: 'POST',
      headers: auth,
      body: { action: 'compact' }
    });
    assert.equal(okAction.status, 200);
    assert.equal(okAction.json.ok, true);
    assert.equal(okAction.json.sessionId, 'cid-compact-1');
    assert.equal(okAction.json.dispatched, true);
    assert.equal(sentMessages[0].items[0].text, '/compact');

    const okRoute = await httpRequest(`${st.url}/api/v1/sessions/cid-compact-2/compact`, {
      method: 'POST',
      headers: auth,
      body: {}
    });
    assert.equal(okRoute.status, 200);
    assert.equal(okRoute.json.sessionId, 'cid-compact-2');
    assert.equal(sentMessages[1].cascadeId, 'cid-compact-2');
    assert.equal(sentMessages[1].items[0].text, '/compact');

    // Cloudflare requires confirm
    await harness.updatePluginSettings('agy-daddy.remote', { cloudflare: true });
    const cfMissingConfirm = await httpRequest(`${st.url}/api/v1/sessions/cid-compact-2/compact`, {
      method: 'POST',
      headers: { ...auth, 'cf-ray': 'ray-123' },
      body: {}
    });
    assert.equal(cfMissingConfirm.status, 403);
    assert.equal(cfMissingConfirm.json.error, 'CONFIRMATION_REQUIRED');
  } finally {
    await harness.cleanup();
  }
});

test('G-3: truncateUtf8Tail, PTY recentClosedSessions FIFO(12), 3-source tasks, and idempotent stop', async () => {
  // 1. 64KB UTF-8 boundary truncation with multi-byte Chinese & emoji characters
  const chunk = '中文测试🚀日志输出abc123\n';
  const bigLog = chunk.repeat(4000); // > 100KB
  const truncated = truncateUtf8Tail(bigLog, 65536);
  assert.equal(truncated.truncated, true);
  assert.ok(truncated.totalBytes > 65536);
  assert.ok(truncated.retainedBytes <= 65536);
  assert.equal(Buffer.byteLength(truncated.logText, 'utf8'), truncated.retainedBytes);
  assert.equal(truncated.logText.includes('\uFFFD'), false);

  // 2. PTY recentClosedSessions FIFO(12) + onTaskEvent
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pty-fifo-'));
  const events = [];
  const ptyMgr = createPtyManager({
    allowedRoots: [tmpDir],
    defaultCwd: tmpDir,
    maxSessions: 20,
    onTaskEvent: (ev) => events.push(ev)
  });
  try {
    for (let i = 1; i <= 14; i++) {
      const created = ptyMgr.getOrCreateSession({ sessionId: `p-${i}`, cwd: tmpDir });
      assert.equal(created.ok, true);
      ptyMgr.closeSession(`p-${i}`);
    }
    const recs = ptyMgr.listTaskRecords();
    assert.equal(recs.length, 12);
    assert.equal(ptyMgr.getTaskRecord('p-1'), null);
    assert.equal(ptyMgr.getTaskRecord('p-2'), null);
    assert.ok(ptyMgr.getTaskRecord('p-14'));
    assert.ok(events.some((e) => e.taskId === 'pty:p-14' && e.status === 'running'));
    assert.ok(events.some((e) => e.taskId === 'pty:p-14' && e.status === 'stopped'));
  } finally {
    ptyMgr.disposeAll();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 3. Full HTTP + SSE 3-source tasks & idempotent stop
  let sessStatus = 'CASCADE_RUN_STATUS_RUNNING';
  let cmdStatus = 'CORTEX_STEP_STATUS_RUNNING';
  let cancelCalls = 0;
  let simulateAlreadyIdle = false;

  const harness = createMockHostHarness({
    onRpc(method) {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'cid-task-1': {
              summary: 'Build Pipeline',
              status: sessStatus,
              stepCount: 1,
              lastModifiedTime: new Date().toISOString()
            }
          }
        };
      }
      if (method === 'GetCascadeTrajectory') {
        return {
          trajectory: {
            cascadeId: 'cid-task-1',
            status: sessStatus,
            steps: [
              {
                stepIndex: 0,
                type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
                status: cmdStatus,
                runCommand: {
                  commandLine: 'npm run build',
                  combinedOutput: bigLog
                }
              }
            ]
          }
        };
      }
      if (method === 'CancelCascadeSteps' || method === 'CancelCascadeInvocation') {
        cancelCalls += 1;
        if (simulateAlreadyIdle) {
          throw new Error('cascade already idle');
        }
        sessStatus = 'CASCADE_RUN_STATUS_IDLE';
        cmdStatus = 'CORTEX_STEP_STATUS_CANCELED';
        return { ok: true };
      }
      return {};
    }
  });
  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    await harness.updatePluginSettings('agy-daddy.remote', {
      loopback: true,
      permissionLevel: 'L1',
      allowRemoteWrite: true
    });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const listRes = await httpRequest(`${st.url}/api/v1/tasks`, { headers: auth });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.json.runningCount, 2);
    assert.ok(listRes.json.running.some((t) => t.id === 'session:cid-task-1'));
    assert.ok(listRes.json.running.some((t) => t.id === 'cmd:cid-task-1:0'));

    const detailRes = await httpRequest(`${st.url}/api/v1/tasks/${encodeURIComponent('cmd:cid-task-1:0')}`, { headers: auth });
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.json.task.truncated, true);
    assert.ok(detailRes.json.task.retainedBytes <= 65536);
    assert.equal(detailRes.json.task.logText.includes('\uFFFD'), false);

    // PTY stop blocked at L1
    const ptyDeny = await httpRequest(`${st.url}/api/v1/tasks/${encodeURIComponent('pty:fake-1')}/stop`, {
      method: 'POST',
      headers: auth,
      body: {}
    });
    assert.equal(ptyDeny.status, 403);
    assert.equal(ptyDeny.json.error, 'PERMISSION_DENIED');

    // Stop command task and verify SSE task.updated broadcast
    const sse = await openSse(`${st.url}/api/v1/stream`, auth);
    try {
      const stopRes = await httpRequest(`${st.url}/api/v1/tasks/${encodeURIComponent('cmd:cid-task-1:0')}/stop`, {
        method: 'POST',
        headers: auth,
        body: {}
      });
      assert.equal(stopRes.status, 200);
      assert.equal(stopRes.json.ok, true);
      assert.equal(stopRes.json.alreadyFinished, false);
      assert.equal(cancelCalls, 1);

      const taskEv = await sse.waitForEvent((e) => e.event === 'task.updated', 2500);
      assert.equal(taskEv.json.task.id, 'cmd:cid-task-1:0');
    } finally {
      sse.close();
    }

    // Idempotent repeat stop -> HTTP 200 alreadyFinished: true
    const repeatStop = await httpRequest(`${st.url}/api/v1/tasks/${encodeURIComponent('cmd:cid-task-1:0')}/stop`, {
      method: 'POST',
      headers: auth,
      body: {}
    });
    assert.equal(repeatStop.status, 200);
    assert.equal(repeatStop.json.ok, true);
    assert.equal(repeatStop.json.alreadyFinished, true);

    // Already idle RPC error -> HTTP 200 alreadyFinished: true (never 500)
    sessStatus = 'CASCADE_RUN_STATUS_RUNNING';
    simulateAlreadyIdle = true;
    const idleRaceStop = await httpRequest(`${st.url}/api/v1/tasks/${encodeURIComponent('session:cid-task-1')}/stop`, {
      method: 'POST',
      headers: auth,
      body: {}
    });
    assert.equal(idleRaceStop.status, 200);
    assert.equal(idleRaceStop.json.ok, true);
    assert.equal(idleRaceStop.json.alreadyFinished, true);
  } finally {
    await harness.cleanup();
  }
});

test('G-4: CORS Origin whitelist, /api/v1/channels secret scrubbing, switch-ticket single redeem & landing bypass', async () => {
  const harness = createMockHostHarness();
  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    await harness.updatePluginSettings('agy-daddy.remote', {
      loopback: true,
      lan: true,
      cloudflare: true,
      tunnelMode: 'named',
      tunnelHostname: 'https://ag.example.com',
      tunnelToken: 'eyJhbGciOiJIUzI1NiJ9.eyJ0IjoidDEifQ.c2ln',
      permissionLevel: 'L0'
    });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 1. CORS preflight for allowed origins
    for (const allowedOrigin of [
      'http://127.0.0.1:5173',
      'http://192.168.1.42:18765',
      'http://100.88.1.2:18765',
      'https://ag.example.com'
    ]) {
      const optRes = await httpRequest(`${st.url}/api/v1/bootstrap`, {
        method: 'OPTIONS',
        headers: { Origin: allowedOrigin }
      });
      assert.equal(optRes.status, 204);
      assert.equal(optRes.headers['access-control-allow-origin'], allowedOrigin);
      assert.match(optRes.headers['access-control-allow-headers'] || '', /Authorization/);
    }

    // Disallowed third-party origin MUST NOT be reflected
    const evilOpt = await httpRequest(`${st.url}/api/v1/bootstrap`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.attacker.com' }
    });
    assert.equal(evilOpt.status, 204);
    assert.equal(evilOpt.headers['access-control-allow-origin'], undefined);

    // 2. GET /api/v1/channels without pairingToken/?t= and with requiresTicketRedirect on HTTPS
    const chRes = await httpRequest(`${st.url}/api/v1/channels`, {
      headers: { ...auth, 'cf-ray': 'ray-test' }
    });
    assert.equal(chRes.status, 200);
    assert.equal(chRes.json.currentChannel, 'cloudflare');
    assert.equal(chRes.text.includes(token), false);
    assert.equal(chRes.text.includes('?t='), false);
    assert.equal(chRes.text.includes('pairingToken'), false);
    const lanEntry = chRes.json.entries.find((e) => e.key === 'lan');
    if (lanEntry) {
      assert.equal(lanEntry.requiresTicketRedirect, true);
    }

    // 3. switch-ticket draft size limit & single-use redeem-ticket (unauthenticated, stripPairingSecrets safe)
    const bigDraft = 'a'.repeat(32 * 1024 + 10);
    const tooBigRes = await httpRequest(`${st.url}/api/v1/channels/switch-ticket`, {
      method: 'POST',
      headers: auth,
      body: { targetChannel: 'lan', sessionId: 'cid-9', draftText: bigDraft }
    });
    assert.equal(tooBigRes.status, 413);

    const ticketRes = await httpRequest(`${st.url}/api/v1/channels/switch-ticket`, {
      method: 'POST',
      headers: auth,
      body: { targetChannel: 'lan', sessionId: 'cid-9', draftText: 'unsent draft' }
    });
    assert.equal(ticketRes.status, 200);
    assert.match(ticketRes.json.ticket, /^st_[0-9a-f]{48}$/);

    // Unauthenticated redeem succeeds ONCE and returns authToken
    const redeem1 = await httpRequest(`${st.url}/api/v1/channels/redeem-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { ticket: ticketRes.json.ticket }
    });
    assert.equal(redeem1.status, 200);
    assert.equal(redeem1.json.authToken, token);
    assert.equal(redeem1.json.sessionId, 'cid-9');
    assert.equal(redeem1.json.draftText, 'unsent draft');

    // Second redeem fails 401
    const redeem2 = await httpRequest(`${st.url}/api/v1/channels/redeem-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { ticket: ticketRes.json.ticket }
    });
    assert.equal(redeem2.status, 401);
    assert.equal(redeem2.json.error, 'INVALID_OR_EXPIRED_TICKET');

    // 4. shouldShowLanding is false when enter=1 or switch_ticket= is present on cloudflare
    const enterRes = await httpRequest(`${st.url}/?enter=1`, { headers: { 'cf-ray': 'ray-test' } });
    assert.equal(enterRes.status, 200);
    assert.equal(enterRes.text.includes('id="agy-tunnel-landing"'), false);

    const ticketHomeRes = await httpRequest(`${st.url}/?switch_ticket=st_dummy`, { headers: { 'cf-ray': 'ray-test' } });
    assert.equal(ticketHomeRes.status, 200);
    assert.equal(ticketHomeRes.text.includes('id="agy-tunnel-landing"'), false);

    // 5. Fallback pwa-html has no maximum-scale=1
    assert.equal(generatePwaHtml().includes('maximum-scale=1'), false);
  } finally {
    await harness.cleanup();
  }
});

test('G-5 & G-6: 10-language locale sync, readonly diagnostics without host:control, and 4-command whitelist', async () => {
  const harness = createMockHostHarness();
  try {
    const setLangCalls = [];
    harness.bus.provideService('agy-daddy.zh-cn', 'zh-cn', {
      getConfig: () => ({ lang: 'en' }),
      setLang: (lang) => {
        setLangCalls.push(lang);
        return { ok: true, lang };
      }
    }, { realm: 'node' });
    harness.bus.provideService('agy-daddy.context', 'context', {
      getSnapshot: () => ({ hasSession: false }),
      rescan: () => ({ ok: true, rescanned: true })
    }, { realm: 'node' });
    harness.bus.provideService('agy-daddy.quota', 'quota', {
      getSnapshot: () => ({ pools: [] }),
      refresh: () => ({ ok: true, refreshed: true })
    }, { realm: 'node' });

    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    await harness.updatePluginSettings('agy-daddy.remote', {
      loopback: true,
      permissionLevel: 'L0',
      allowRemoteWrite: false
    });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // G-5: invalid locale -> 400
    const badLoc = await httpRequest(`${st.url}/api/v1/locale`, {
      method: 'PUT',
      headers: auth,
      body: { locale: 'xx-INVALID' }
    });
    assert.equal(badLoc.status, 400);
    assert.equal(badLoc.json.error, 'INVALID_LOCALE');

    // G-5: L0 -> localOnly: true
    const l0Loc = await httpRequest(`${st.url}/api/v1/locale`, {
      method: 'PUT',
      headers: auth,
      body: { locale: 'ja' }
    });
    assert.equal(l0Loc.status, 200);
    assert.equal(l0Loc.json.locale, 'ja');
    assert.equal(l0Loc.json.syncedToHost, false);
    assert.equal(l0Loc.json.localOnly, true);

    // G-6: Diagnostics in L0
    const diagRes = await httpRequest(`${st.url}/api/v1/diagnostics`, { headers: auth });
    assert.equal(diagRes.status, 200);
    assert.equal(diagRes.json.mode, 'readonly-safe');
    assert.equal(diagRes.json.hostControlAvailable, false);
    assert.equal(diagRes.json.checks.length, 6);

    // G-6: Commands list & whitelist enforcement
    const cmdList = await httpRequest(`${st.url}/api/v1/commands`, { headers: auth });
    assert.equal(cmdList.status, 200);
    assert.deepEqual(
      cmdList.json.commands.map((c) => c.id),
      ['remote.status', 'remote.check-cloudflared', 'context.rescan', 'quota.refresh']
    );

    const forbiddenCmd = await httpRequest(`${st.url}/api/v1/commands/run`, {
      method: 'POST',
      headers: auth,
      body: { commandId: 'remote.rotate-token' }
    });
    assert.equal(forbiddenCmd.status, 403);
    assert.equal(forbiddenCmd.json.error, 'COMMAND_FORBIDDEN_ON_MOBILE');

    const l0Rescan = await httpRequest(`${st.url}/api/v1/commands/run`, {
      method: 'POST',
      headers: auth,
      body: { commandId: 'context.rescan' }
    });
    assert.equal(l0Rescan.status, 403);
    assert.equal(l0Rescan.json.error, 'PERMISSION_DENIED');

    // Elevate to L1 -> locale syncs to Host & emits SSE state.patch; context.rescan succeeds
    await harness.updatePluginSettings('agy-daddy.remote', { permissionLevel: 'L1', allowRemoteWrite: true });
    const sse = await openSse(`${st.url}/api/v1/stream`, auth);
    try {
      const l1Loc = await httpRequest(`${st.url}/api/v1/locale`, {
        method: 'PUT',
        headers: auth,
        body: { locale: 'zh-CN' }
      });
      assert.equal(l1Loc.status, 200);
      assert.equal(l1Loc.json.syncedToHost, true);
      assert.equal(l1Loc.json.localOnly, false);
      assert.deepEqual(setLangCalls, ['zh']);

      const patchEv = await sse.waitForEvent(
        (e) => e.event === 'state.patch' && e.json?.key === 'state:host.locale@1' && e.json?.value?.locale === 'zh-CN',
        2500
      );
      assert.equal(patchEv.json.value.lang, 'zh');
    } finally {
      sse.close();
    }

    const l1Rescan = await httpRequest(`${st.url}/api/v1/commands/run`, {
      method: 'POST',
      headers: auth,
      body: { commandId: 'context.rescan' }
    });
    assert.equal(l1Rescan.status, 200);
    assert.equal(l1Rescan.json.result.rescanned, true);

    const getLoc = await httpRequest(`${st.url}/api/v1/locale`, { headers: auth });
    assert.equal(getLoc.status, 200);
    assert.equal(getLoc.json.locale, 'zh-CN');
    assert.equal(getLoc.json.supportedLocales.length, 10);
  } finally {
    await harness.cleanup();
  }
});
