'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');
const { execFileSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const { resolveWorkspaceOrg } = require('../src/session-org-store');
const { createPtyManager: createRemotePtyManager } = require('../src/pty-bridge');

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function initGitRepo(repoDir, branch = 'main') {
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', branch], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'init\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
}

function httpRequest(targetUrl, { method = 'GET', headers = {}, body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const payload = body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method,
      agent: false,
      headers: {
        Connection: 'close',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
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
    if (payload) req.write(payload);
    req.end();
  });
}

function rawUpgrade(baseUrl, pathWithQuery, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const socket = net.connect({ host: u.hostname, port: Number(u.port) }, () => {
      socket.write([
        `GET ${pathWithQuery} HTTP/1.1`,
        `Host: ${u.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        `Authorization: Bearer ${token}`,
        '',
        ''
      ].join('\r\n'));
    });
    let headBuf = '';
    socket.on('data', (chunk) => {
      headBuf += chunk.toString('utf8');
      if (headBuf.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(headBuf);
      }
    });
    socket.on('error', reject);
  });
}

test('remote: worktree discovery, StartCascade workspaceUris, sibling fs/git auto-auth, PTY 409 mismatch & collapse/project lock', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-rem-wo-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-rem-out-'));
  const repo = path.join(tmp, 'rem-repo');
  const nestedWt = path.join(repo, '.worktrees', 'wt-alpha');
  const siblingWt = path.join(tmp, 'rem-repo-feat-sib');
  const otherProj = path.join(tmp, 'other-proj');
  const bareRepo = path.join(tmp, 'bare.git');
  fs.mkdirSync(otherProj, { recursive: true });
  initGitRepo(repo, 'main');
  execFileSync('git', ['worktree', 'add', '-b', 'feat/alpha', nestedWt], { cwd: repo, stdio: 'ignore' });
  fs.mkdirSync(bareRepo, { recursive: true });
  execFileSync('git', ['init', '--bare'], { cwd: bareRepo, stdio: 'ignore' });

  const prevOrgPath = process.env.AGY_DADDY_SESSION_ORG_PATH;
  process.env.AGY_DADDY_SESSION_ORG_PATH = path.join(tmp, 'session-org.json');
  t.after(() => {
    if (prevOrgPath === undefined) delete process.env.AGY_DADDY_SESSION_ORG_PATH;
    else process.env.AGY_DADDY_SESSION_ORG_PATH = prevOrgPath;
    cleanupDir(tmp);
    cleanupDir(outsideDir);
  });

  const startCascadeCalls = [];
  const harness = createMockHostHarness({
    onRpc(method, params) {
      if (method === 'StartCascade') {
        startCascadeCalls.push(params);
        return { cascadeId: `rem-cid-${startCascadeCalls.length}` };
      }
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'rem-cid-1': {
              summary: 'Remote WT Session',
              status: 'CASCADE_RUN_STATUS_IDLE',
              workspaces: [{ workspaceFolderAbsoluteUri: url.pathToFileURL(fs.realpathSync.native(nestedWt)).href }]
            }
          }
        };
      }
      if (method === 'GetUserStatus') {
        return { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } };
      }
      if (method === 'GetAvailableModels') {
        return { response: { models: {} } };
      }
      return { ok: true };
    }
  });

  const { port: bridgePort } = await harness.bridge.start(0);
  harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
  await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
  t.after(() => harness.cleanup());
  await harness.updatePluginSettings('agy-daddy.remote', {
    permissionLevel: 'L2',
    allowedRoots: [repo, bareRepo],
    loopback: true
  });

  const remoteSvc = harness.bus.getServiceProxy('remote');
  const st = await remoteSvc.getStatus();
  const token = await remoteSvc.getPairingToken();
  const base = st.url;
  const auth = { Authorization: `Bearer ${token}` };

  const pMain = await httpRequest(`${base}/api/v1/projects`, {
    method: 'POST',
    headers: auth,
    body: { name: 'Rem Repo', rootPath: repo }
  });
  assert.equal(pMain.status, 200);
  const pOther = await httpRequest(`${base}/api/v1/projects`, {
    method: 'POST',
    headers: auth,
    body: { name: 'Other', rootPath: otherProj }
  });
  assert.equal(pOther.status, 200);

  // 1. Standalone StartCascade passes workspaceUris & validates worktreePath
  const okSess = await httpRequest(`${base}/api/v1/sessions`, {
    method: 'POST',
    headers: auth,
    body: { title: 'WT', projectId: pMain.json.project.id, worktreePath: nestedWt }
  });
  assert.equal(okSess.status, 200);
  assert.deepEqual(startCascadeCalls[0].workspaceUris, [url.pathToFileURL(fs.realpathSync.native(nestedWt)).href]);

  const missSess = await httpRequest(`${base}/api/v1/sessions`, {
    method: 'POST',
    headers: auth,
    body: { title: 'Missing', worktreePath: path.join(tmp, 'does-not-exist') }
  });
  assert.equal(missSess.status, 404);
  assert.equal(missSess.json.error, 'WORKTREE_PATH_MISSING');

  const bareSess = await httpRequest(`${base}/api/v1/sessions`, {
    method: 'POST',
    headers: auth,
    body: { title: 'Bare', worktreePath: bareRepo }
  });
  assert.equal(bareSess.status, 400);
  assert.equal(bareSess.json.error, 'WORKTREE_IS_BARE');

  const outSess = await httpRequest(`${base}/api/v1/sessions`, {
    method: 'POST',
    headers: auth,
    body: { title: 'Out', worktreePath: outsideDir }
  });
  assert.equal(outSess.status, 403);
  assert.equal(outSess.json.error, 'PATH_OUTSIDE_WORKSPACE');

  // 2. Sibling worktree create & immediate fs/git access without 403
  const wtAdd = await httpRequest(`${base}/api/v1/git/worktree`, {
    method: 'POST',
    headers: auth,
    body: { root: repo, action: 'add', path: '../rem-repo-feat-sib', branch: 'feat/sib', createBranch: true }
  });
  assert.equal(wtAdd.status, 200, JSON.stringify(wtAdd.json));
  assert.equal(wtAdd.json.worktrees.some((w) => w.branch === 'feat/sib' && w.allowed === true), true);

  const sibTree = await httpRequest(`${base}/api/v1/fs/tree?root=${encodeURIComponent(siblingWt)}`, { headers: auth });
  assert.equal(sibTree.status, 200);

  // 3. PTY ?cwd= isolation + 409 PTY_CWD_MISMATCH (cross-platform pty-bridge + live WS on POSIX)
  const fakePtyBridge = createRemotePtyManager({
    allowedRoots: [repo, siblingWt],
    defaultCwd: repo,
    spawnFn: () => {
      const listeners = new Map();
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
          for (const fn of listeners.get('exit') || []) fn(0, 'SIGTERM');
        }
      };
    }
  });
  t.after(() => fakePtyBridge.disposeAll());
  const pSib = fakePtyBridge.getOrCreateSession({ sessionId: 'pty-mock-sib', cwd: siblingWt });
  assert.equal(pSib.ok, true);
  assert.deepEqual(fakePtyBridge.listSessions({ cwd: siblingWt }).map((s) => s.sessionId), ['pty-mock-sib']);
  assert.equal(fakePtyBridge.listSessions({ cwd: repo }).length, 0);
  const pMismatch = fakePtyBridge.getOrCreateSession({ sessionId: 'pty-mock-sib', cwd: repo });
  assert.equal(pMismatch.ok, false);
  assert.equal(pMismatch.statusCode, 409);
  assert.equal(pMismatch.error, 'PTY_CWD_MISMATCH');

  if (process.platform !== 'win32') {
    const wsOk = await rawUpgrade(
      base,
      `/ws/pty?sessionId=pty-sib-1&cwd=${encodeURIComponent(siblingWt)}`,
      token
    );
    assert.match(wsOk, /^HTTP\/1\.1 101 /);

    const ptyListSib = await httpRequest(`${base}/api/v1/pty/sessions?cwd=${encodeURIComponent(siblingWt)}`, { headers: auth });
    assert.equal(ptyListSib.status, 200);
    assert.deepEqual(ptyListSib.json.sessions.map((s) => s.sessionId), ['pty-sib-1']);

    const ptyListMain = await httpRequest(`${base}/api/v1/pty/sessions?cwd=${encodeURIComponent(repo)}`, { headers: auth });
    assert.equal(ptyListMain.status, 200);
    assert.equal(ptyListMain.json.sessions.length, 0);

    const wsMismatch = await rawUpgrade(
      base,
      `/ws/pty?sessionId=pty-sib-1&cwd=${encodeURIComponent(repo)}`,
      token
    );
    assert.match(wsMismatch, /^HTTP\/1\.1 409 /);

    // Removing worktree with running PTY is rejected with 409 WORKTREE_HAS_RUNNING_SESSION
    const remBusy = await httpRequest(`${base}/api/v1/git/worktree`, {
      method: 'POST',
      headers: auth,
      body: { root: repo, action: 'remove', path: siblingWt }
    });
    assert.equal(remBusy.status, 409);
    assert.equal(remBusy.json.error, 'WORKTREE_HAS_RUNNING_SESSION');
  }

  // 4. Org refresh, collapse, and cross-container project lock
  const orgRes = await httpRequest(`${base}/api/v1/sessions/org?refreshWorktrees=1`, { headers: auth });
  assert.equal(orgRes.status, 200);
  const agg = orgRes.json.projects.find((p) => p.id === pMain.json.project.id);
  assert.equal(agg.isMultiWorktree, true);

  const workspaceOrg = resolveWorkspaceOrg(null);
  const nestedWtId = workspaceOrg.makeWorktreeId(nestedWt);
  const colRes = await httpRequest(`${base}/api/v1/sessions/org/collapse`, {
    method: 'POST',
    headers: auth,
    body: { nodeType: 'worktree', nodeId: nestedWtId, collapsed: true }
  });
  assert.equal(colRes.status, 200);
  assert.equal(colRes.json.collapsedNodes.worktrees[nestedWtId], true);

  const crossAssign = await httpRequest(`${base}/api/v1/sessions/rem-cid-1/project`, {
    method: 'PATCH',
    headers: auth,
    body: { projectId: pOther.json.project.id }
  });
  assert.equal(crossAssign.status, 409);
  assert.equal(crossAssign.json.error, 'CROSS_CONTAINER_SESSION_MOVE_FORBIDDEN');
});
