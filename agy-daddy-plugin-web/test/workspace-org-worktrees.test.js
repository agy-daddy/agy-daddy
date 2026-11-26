'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');
const { execFileSync } = require('node:child_process');

const { createHarnessAdapter } = require('../src/harness-adapter');
const { createWorkspaceService } = require('../src/workspace-service');
const { createSessionOrgBridge, resolveWorkspaceOrg } = require('../src/session-org-bridge');
const { createWorkspaceMetaStore } = require('../src/workspace-meta-store');
const { createPtyManager } = require('../src/pty-manager');
const { createTaskManager } = require('../src/task-manager');
const { createWebServer } = require('../src/web-server');
const { createConfirmToken } = require('../src/channel-config');

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

function makeMemoryStorage(initial = {}) {
  let data = { ...initial };
  return {
    readJson(_file, fallback = {}) {
      return { ok: true, data: data || fallback };
    },
    writeJson(_file, next) {
      data = JSON.parse(JSON.stringify(next));
      return { ok: true };
    }
  };
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
      headers: {
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

function openSseCollector(sseUrl, headers = {}) {
  const events = [];
  let reqRef = null;
  let closed = false;
  const ready = new Promise((resolve, reject) => {
    const u = new URL(sseUrl);
    reqRef = http.request({
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => {
        if (closed) return;
        buf += chunk.toString('utf8');
        const frames = buf.split('\n\n');
        buf = frames.pop() || '';
        for (const frame of frames) {
          const lines = frame.split('\n');
          let eventName = 'message';
          let dataText = '';
          for (const line of lines) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataText += line.slice(5).trim();
          }
          if (eventName || dataText) {
            let parsed = null;
            try { parsed = JSON.parse(dataText); } catch {}
            events.push({ event: eventName, data: parsed ?? dataText });
          }
        }
      });
      resolve();
    });
    reqRef.on('error', (err) => {
      if (!closed) reject(err);
    });
    reqRef.end();
  });
  return {
    ready,
    events,
    close() {
      closed = true;
      reqRef?.destroy();
    }
  };
}

test('web: worktree discovery, sibling auto-auth, locked/running guards, pty cwd isolation, task longest-prefix & L0/L1/L2/SSE routes', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-wo-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-web-out-'));
  try {
    const repo = path.join(tmp, 'my-repo');
    const nestedWt = path.join(repo, '.worktrees', 'wt-nested');
    const siblingWt = path.join(tmp, 'my-repo-feat-sib');
    const otherProj = path.join(tmp, 'other-proj');
    const bareRepo = path.join(tmp, 'bare.git');
    const defaultDir = path.join(tmp, 'default-ws');
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.mkdirSync(otherProj, { recursive: true });
    initGitRepo(repo, 'main');
    execFileSync('git', ['worktree', 'add', '-b', 'feat/nested', nestedWt], { cwd: repo, stdio: 'ignore' });
    fs.mkdirSync(bareRepo, { recursive: true });
    execFileSync('git', ['init', '--bare'], { cwd: bareRepo, stdio: 'ignore' });

    const workspaceOrg = resolveWorkspaceOrg(null);
    const worktreeDiscovery = workspaceOrg.createWorktreeDiscoveryService();
    const orgPath = path.join(tmp, 'session-org.json');

    let serverRef = null;
    const bridge = createSessionOrgBridge({
      orgPath,
      worktreeDiscovery,
      onOrgChanged: (_org, summary) => {
        serverRef?.broadcast('org.updated', summary);
      }
    });
    const metaStore = createWorkspaceMetaStore({
      storage: makeMemoryStorage(),
      sessionOrgBridge: bridge,
      worktreeDiscovery,
      defaultBaseDir: defaultDir,
      conversationDbPath: null,
      stateVscdbPath: null,
      sharedReadStatePath: null
    });
    const projRes = metaStore.createProject({ name: 'My Repo', rootPath: repo });
    assert.equal(projRes.ok, true);
    const otherRes = metaStore.createProject({ name: 'Other', rootPath: otherProj });
    assert.equal(otherRes.ok, true);

    const extraRoots = [bareRepo];
    const getAllowedRoots = () => {
      const seeds = [...metaStore.getProjectRootPaths(), defaultDir, ...extraRoots];
      return worktreeDiscovery.getAuthorizedWorktreeRoots(seeds);
    };

    const startCascadeCalls = [];
    const adapter = createHarnessAdapter({
      rpc: {
        async call(method, params) {
          if (method === 'StartCascade') {
            startCascadeCalls.push(params);
            return { cascadeId: `cid-${startCascadeCalls.length}` };
          }
          if (method === 'GetAllCascadeTrajectories') {
            return {
              trajectorySummaries: {
                'cid-1': {
                  summary: 'Nested WT Session',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  workspaces: [{ workspaceFolderAbsoluteUri: url.pathToFileURL(fs.realpathSync.native(nestedWt)).href }]
                }
              }
            };
          }
          if (method === 'GetCascadeTrajectory' || method === 'GetCascadeTrajectorySteps') {
            const steps = [
              {
                type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
                status: 'CORTEX_STEP_STATUS_DONE',
                runCommand: {
                  commandLine: 'git status',
                  cwd: fs.realpathSync.native(nestedWt),
                  exitCode: 0,
                  combinedOutput: 'clean'
                }
              }
            ];
            return method === 'GetCascadeTrajectory'
              ? { trajectory: { steps } }
              : { steps };
          }
          return {};
        }
      }
    });

    let runningFlagForPath = null;
    let ptyMgr = null;
    const wsSvc = createWorkspaceService({
      getAllowedRoots,
      worktreeDiscovery,
      hasRunningSessionInPath: async (target) => {
        if (ptyMgr && ptyMgr.listSessions({ cwd: target }).length > 0) return true;
        if (!runningFlagForPath) return false;
        const k1 = workspaceOrg.canonicalKey(workspaceOrg.canonicalizePath(runningFlagForPath));
        const k2 = workspaceOrg.canonicalKey(workspaceOrg.canonicalizePath(target));
        return Boolean(k1 && k2 && k1 === k2);
      }
    });
    ptyMgr = createPtyManager({
      allowedRoots: getAllowedRoots,
      defaultCwd: repo,
      worktreeDiscovery
    });
    t.after(() => ptyMgr.disposeAll());

    const taskMgr = createTaskManager({
      harnessAdapter: adapter,
      ptyManager: ptyMgr,
      workspaceMetaStore: metaStore,
      worktreeDiscovery
    });

    await worktreeDiscovery.warmRoots([repo, bareRepo], { refresh: true });

    const pairingToken = 'test-token-wo';
    const confirmSecret = 'confirm-secret-wo';
    let fakeChannel = 'loopback';
    let fakePerm = 'L2';
    serverRef = createWebServer({
      port: 0,
      pairingToken,
      confirmSecret,
      channels: { loopback: true, lan: true, cloudflare: true },
      getChannels: () => ({ loopback: true, lan: true, cloudflare: true }),
      getPermissionLevel: () => fakePerm,
      resolveChannel: () => fakeChannel,
      harnessAdapter: adapter,
      workspaceService: wsSvc,
      workspaceMetaStore: metaStore,
      sessionOrgBridge: bridge,
      worktreeDiscovery,
      ptyManager: ptyMgr,
      taskManager: taskMgr
    });
    worktreeDiscovery.onWorktreeUpdated((ev) => {
      serverRef.broadcast('worktree.updated', ev);
    });
    const info = await serverRef.start();
    t.after(() => serverRef.stop());
    const base = `http://127.0.0.1:${info.port}`;
    const auth = { Authorization: `Bearer ${pairingToken}` };

    const sse = openSseCollector(`${base}/api/v1/stream`, auth);
    await sse.ready;
    t.after(() => sse.close());

    // 1. POST /api/v1/sessions target validation & worktreeId binding
    const okCreate = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: auth,
      body: { title: 'WT1', projectId: projRes.project.id, worktreePath: nestedWt }
    });
    assert.equal(okCreate.status, 200);
    assert.equal(okCreate.json.worktreeId, workspaceOrg.makeWorktreeId(nestedWt));
    assert.deepEqual(startCascadeCalls[0].workspaceUris, [url.pathToFileURL(fs.realpathSync.native(nestedWt)).href]);

    const missingCreate = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: auth,
      body: { title: 'Missing', worktreePath: path.join(tmp, 'missing-wt') }
    });
    assert.equal(missingCreate.status, 404);
    assert.equal(missingCreate.json.error, 'WORKTREE_PATH_MISSING');

    const bareCreate = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: auth,
      body: { title: 'Bare', worktreePath: bareRepo }
    });
    assert.equal(bareCreate.status, 400);
    assert.equal(bareCreate.json.error, 'WORKTREE_IS_BARE');

    const outCreate = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: auth,
      body: { title: 'Out', worktreePath: outsideDir }
    });
    assert.equal(outCreate.status, 403);
    assert.equal(outCreate.json.error, 'PATH_OUTSIDE_WORKSPACE');

    const sysCreate = await httpRequest(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: auth,
      body: { title: 'Sys', worktreePath: '/' }
    });
    assert.equal(sysCreate.status, 403);
    assert.equal(sysCreate.json.error, 'FORBIDDEN_SYSTEM_ROOT');

    // 2. Sibling worktree add + auto-authorization for listTree/getGitDiff + SSE worktree.updated
    const sibCreate = await httpRequest(`${base}/api/v1/git/worktree`, {
      method: 'POST',
      headers: auth,
      body: { root: repo, action: 'add', path: '../my-repo-feat-sib', branch: 'feat/sib', createBranch: true }
    });
    assert.equal(sibCreate.status, 200, JSON.stringify(sibCreate.json));
    assert.equal(sibCreate.json.worktrees.some((w) => w.branch === 'feat/sib' && w.allowed === true), true);

    const sibTree = await httpRequest(`${base}/api/v1/fs/tree?root=${encodeURIComponent(siblingWt)}`, { headers: auth });
    assert.equal(sibTree.status, 200);
    const sibDiff = await httpRequest(`${base}/api/v1/git/diff?root=${encodeURIComponent(siblingWt)}`, { headers: auth });
    assert.equal(sibDiff.status, 200);

    // 3. PTY isolation: ?cwd= filters longest-prefix without leaking nested worktree into main repo, and blocks 409 reuse
    const pMain = await ptyMgr.createOrGetSession({ sessionId: 'pty-main', cwd: repo });
    const pNested = await ptyMgr.createOrGetSession({ sessionId: 'pty-nested', cwd: nestedWt });
    assert.equal(pMain.ok, true);
    assert.equal(pNested.ok, true);

    const listMain = await httpRequest(`${base}/api/v1/terminal/sessions?cwd=${encodeURIComponent(repo)}`, { headers: auth });
    assert.equal(listMain.status, 200);
    assert.deepEqual(listMain.json.sessions.map((s) => s.sessionId), ['pty-main']);

    const listNested = await httpRequest(`${base}/api/v1/terminal/sessions?cwd=${encodeURIComponent(nestedWt)}`, { headers: auth });
    assert.equal(listNested.status, 200);
    assert.deepEqual(listNested.json.sessions.map((s) => s.sessionId), ['pty-nested']);

    const reuseMismatch = await httpRequest(`${base}/api/v1/terminal/sessions`, {
      method: 'POST',
      headers: auth,
      body: { sessionId: 'pty-main', cwd: nestedWt }
    });
    assert.equal(reuseMismatch.status, 409);
    assert.equal(reuseMismatch.json.error, 'PTY_CWD_MISMATCH');

    // 4. Worktree removal guards: 409 WORKTREE_HAS_RUNNING_SESSION & 409 WORKTREE_LOCKED
    runningFlagForPath = siblingWt;
    const remRunning = await httpRequest(`${base}/api/v1/git/worktree`, {
      method: 'POST',
      headers: auth,
      body: { root: repo, action: 'remove', path: siblingWt }
    });
    assert.equal(remRunning.status, 409, JSON.stringify(remRunning.json));
    assert.equal(remRunning.json.error, 'WORKTREE_HAS_RUNNING_SESSION');
    runningFlagForPath = null;

    execFileSync('git', ['worktree', 'lock', siblingWt], { cwd: repo, stdio: 'ignore' });
    const remLocked = await httpRequest(`${base}/api/v1/git/worktree`, {
      method: 'POST',
      headers: auth,
      body: { root: repo, action: 'remove', path: siblingWt }
    });
    assert.equal(remLocked.status, 409);
    assert.equal(remLocked.json.error, 'WORKTREE_LOCKED');

    // 5. Tasks attribution uses longest-prefix nested worktree
    const tasksRes = await httpRequest(`${base}/api/v1/tasks`, { headers: auth });
    assert.equal(tasksRes.status, 200);
    const cmdTask = tasksRes.json.recent.find((x) => x.kind === 'command');
    assert.equal(cmdTask.projectPath, fs.realpathSync.native(nestedWt));

    // 6. Collapse, Org aggregation, cross-container move lock, and L0/L1/Cloudflare permissions
    const orgRes = await httpRequest(`${base}/api/v1/sessions/org?refreshWorktrees=1`, { headers: auth });
    assert.equal(orgRes.status, 200);
    const aggProj = orgRes.json.projects.find((p) => p.id === projRes.project.id);
    assert.equal(aggProj.isMultiWorktree, true);
    assert.equal(aggProj.worktrees.length, 3);

    const collapseOk = await httpRequest(`${base}/api/v1/sessions/org/collapse`, {
      method: 'POST',
      headers: auth,
      body: { nodeType: 'worktree', nodeId: okCreate.json.worktreeId, collapsed: true }
    });
    assert.equal(collapseOk.status, 200);
    assert.equal(collapseOk.json.collapsedNodes.worktrees[okCreate.json.worktreeId], true);

    const crossProj = await httpRequest(`${base}/api/v1/sessions/cid-1/project`, {
      method: 'PATCH',
      headers: auth,
      body: { projectId: otherRes.project.id }
    });
    assert.equal(crossProj.status, 409);
    assert.equal(crossProj.json.error, 'CROSS_CONTAINER_SESSION_MOVE_FORBIDDEN');

    // Permission checks: LAN L0 blocks L1 collapse; LAN L1 allows collapse; Cloudflare requires X-Agy-Confirm
    fakeChannel = 'lan';
    fakePerm = 'L0';
    const collapseL0 = await httpRequest(`${base}/api/v1/sessions/org/collapse`, {
      method: 'POST',
      headers: auth,
      body: { nodeType: 'project', nodeId: projRes.project.id, collapsed: true }
    });
    assert.equal(collapseL0.status, 403);

    fakePerm = 'L1';
    const collapseL1 = await httpRequest(`${base}/api/v1/sessions/org/collapse`, {
      method: 'POST',
      headers: auth,
      body: { nodeType: 'project', nodeId: projRes.project.id, collapsed: true }
    });
    assert.equal(collapseL1.status, 200);

    fakeChannel = 'cloudflare';
    const cfMissing = await httpRequest(`${base}/api/v1/sessions/org/collapse`, {
      method: 'POST',
      headers: auth,
      body: { nodeType: 'project', nodeId: projRes.project.id, collapsed: false }
    });
    assert.equal(cfMissing.status, 403);
    assert.equal(cfMissing.json.error, 'CONFIRMATION_REQUIRED');

    const cfToken = createConfirmToken(confirmSecret, { action: 'POST /api/v1/sessions/org/collapse' });
    const cfOk = await httpRequest(`${base}/api/v1/sessions/org/collapse`, {
      method: 'POST',
      headers: { ...auth, 'X-Agy-Confirm': cfToken },
      body: { nodeType: 'project', nodeId: projRes.project.id, collapsed: false }
    });
    assert.equal(cfOk.status, 200);

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sse.events.some((e) => e.event === 'org.updated'), true);
    assert.equal(sse.events.some((e) => e.event === 'worktree.updated'), true);
  } finally {
    cleanupDir(tmp);
    cleanupDir(outsideDir);
  }
});
