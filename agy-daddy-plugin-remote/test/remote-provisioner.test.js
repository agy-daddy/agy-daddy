'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { MobileRemoteServer } = require('../src/pwa-server');
const { createWorkspaceBrowser } = require('../src/workspace-browser');
const { createRemoteProjectProvisioner } = require('../src/remote-project-provisioner');
const { createSessionOrgStore } = require('../src/session-org-store');

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

function makeFakeChild({ code = 0, stdout = '', stderr = '', delayMs = 5, onKill = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  let timer = setTimeout(() => {
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, null);
  }, delayMs);
  child.kill = (sig = 'SIGTERM') => {
    child.killed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (onKill) onKill(sig);
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null, sig);
    });
    return true;
  };
  return child;
}

test('remote workspace-browser & remote-provisioner: browse guards, injection blocks, and HTTP L2 + Cloudflare confirm routes', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-remote-prov-'));
  const orgPath = path.join(tmp, 'session-org.json');
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const store = createSessionOrgStore({ orgPath });
  t.after(() => store.dispose());

  const workspaceRoot = path.join(tmp, 'workspaces');
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const browser = createWorkspaceBrowser({
    getDefaultSessionPath: () => workspaceRoot,
    getProjectRootPaths: () => (store.loadPersistedOrg().projects || []).map((p) => p.rootPath)
  });

  const provisioner = createRemoteProjectProvisioner({
    spawnFn: (bin, args) => {
      if (bin === 'git' && args[0] === 'clone') {
        const target = args[args.length - 1];
        fs.mkdirSync(path.join(target, '.git'), { recursive: true });
        return makeFakeChild({ code: 0, delayMs: 25 });
      }
      if (bin === 'gh' && args[0] === '--version') {
        return makeFakeChild({ code: 0, stdout: 'gh version 2.50.0\n' });
      }
      if (bin === 'gh' && args[0] === 'auth') {
        return makeFakeChild({ code: 0, stdout: 'Logged in to github.com account octocat\nActive account: true\n' });
      }
      if (bin === 'gh' && args[0] === 'repo' && args[1] === 'list') {
        return makeFakeChild({
          code: 0,
          stdout: JSON.stringify([{ nameWithOwner: 'octocat/hello', url: 'https://github.com/octocat/hello', isPrivate: false }])
        });
      }
      return makeFakeChild({ code: 0 });
    },
    createProjectFn: ({ name, rootPath, groupId = null, source = 'local', remote = null }) => {
      return store.mutateOrgAtomically((org) => {
        const proj = store.materializeProjectInOrg(org, {
          id: `proj_${Date.now()}`,
          name,
          rootPath,
          groupId,
          source,
          remote,
          syncedFromApp: false
        });
        return { buildResult: () => ({ ok: true, project: proj }) };
      });
    }
  });
  t.after(() => provisioner.dispose());

  let permissionLevel = 'L1';
  const server = new MobileRemoteServer({
    host: '127.0.0.1',
    port: 0,
    staticDir: '',
    getToken: () => 'tok-remote-prov',
    getConfirmSecret: () => 'confirm-secret-prov',
    getPermissionLevel: () => permissionLevel,
    getChannels: () => ({ loopback: true, lan: true, tailscale: true, bonjour: true, cloudflare: true }),
    getTunnelHostname: () => 'remote-prov.example.com',
    isWriteEnabled: () => true,
    workspaceBrowser: browser,
    remoteProvisioner: provisioner,
    v1Handlers: {
      async createProject(body) {
        return store.mutateOrgAtomically((org) => {
          const proj = store.materializeProjectInOrg(org, {
            id: `proj_local_${Date.now()}`,
            name: body.name || path.basename(body.rootPath),
            rootPath: body.rootPath,
            source: 'local',
            syncedFromApp: false
          });
          return { buildResult: (saved) => ({ ok: true, project: proj, revision: saved.revision }) };
        });
      }
    }
  });
  await server.start();
  t.after(() => server.stop());

  const base = `http://127.0.0.1:${server.port}`;
  const cfAuth = {
    Authorization: 'Bearer tok-remote-prov',
    Host: 'remote-prov.example.com',
    'cf-ray': 'cf-test-prov',
    'Content-Type': 'application/json'
  };

  // L1 blocked on L2 routes (GET browse & POST mkdir)
  const browseL1 = await httpRequest(`${base}/api/v1/workspace/browse?path=${encodeURIComponent(workspaceRoot)}`, {
    headers: cfAuth
  });
  assert.equal(browseL1.status, 403);
  assert.equal(browseL1.json.required, 'L2');

  // Switch to L2 on Cloudflare channel
  permissionLevel = 'L2';

  // Read routes succeed without X-Agy-Confirm
  const browseL2 = await httpRequest(`${base}/api/v1/workspace/browse?path=${encodeURIComponent(workspaceRoot)}`, {
    headers: cfAuth
  });
  assert.equal(browseL2.status, 200);
  assert.equal(browseL2.json.ok, true);

  const pfL2 = await httpRequest(`${base}/api/v1/workspace/remote-preflight?provider=github`, {
    headers: cfAuth
  });
  assert.equal(pfL2.status, 200);
  assert.equal(pfL2.json.github.ghAuthenticated, true);

  const reposL2 = await httpRequest(`${base}/api/v1/workspace/github-repos`, {
    headers: cfAuth
  });
  assert.equal(reposL2.status, 200);
  assert.equal(reposL2.json.repos[0].nameWithOwner, 'octocat/hello');

  // Browse blocks /etc
  const etcRes = await httpRequest(`${base}/api/v1/workspace/browse?path=${encodeURIComponent('/etc')}`, {
    headers: cfAuth
  });
  assert.equal(etcRes.status, 403);
  assert.equal(etcRes.json.error, 'FORBIDDEN_SYSTEM_ROOT');

  // POST mkdir requires X-Agy-Confirm on Cloudflare
  const mkChallenge = await httpRequest(`${base}/api/v1/workspace/mkdir`, {
    method: 'POST',
    headers: cfAuth,
    body: { parentDir: workspaceRoot, name: 'sub-proj' }
  });
  assert.equal(mkChallenge.status, 403);
  assert.equal(mkChallenge.json.error, 'CONFIRMATION_REQUIRED');

  const mkOk = await httpRequest(`${base}/api/v1/workspace/mkdir`, {
    method: 'POST',
    headers: { ...cfAuth, 'X-Agy-Confirm': mkChallenge.json.confirmToken },
    body: { parentDir: workspaceRoot, name: 'sub-proj' }
  });
  assert.equal(mkOk.status, 200);
  assert.equal(fs.existsSync(path.join(workspaceRoot, 'sub-proj')), true);

  // POST /api/v1/projects/remote-jobs requires X-Agy-Confirm on Cloudflare and returns 202
  const jobChallenge = await httpRequest(`${base}/api/v1/projects/remote-jobs`, {
    method: 'POST',
    headers: cfAuth,
    body: {
      provider: 'github',
      mode: 'gh_clone',
      projectName: 'Cloned App',
      parentDir: workspaceRoot,
      localDirName: 'cloned-app',
      github: { repoSpec: 'octocat/hello' }
    }
  });
  assert.equal(jobChallenge.status, 403);
  assert.equal(jobChallenge.json.error, 'CONFIRMATION_REQUIRED');

  const jobStart = await httpRequest(`${base}/api/v1/projects/remote-jobs`, {
    method: 'POST',
    headers: { ...cfAuth, 'X-Agy-Confirm': jobChallenge.json.confirmToken },
    body: {
      provider: 'github',
      mode: 'gh_clone',
      projectName: 'Cloned App',
      parentDir: workspaceRoot,
      localDirName: 'cloned-app',
      github: { repoSpec: 'octocat/hello' }
    }
  });
  assert.equal(jobStart.status, 202);
  assert.ok(jobStart.json.jobId);

  // POST /cancel is EXEMPT from X-Agy-Confirm on Cloudflare
  const cancelRes = await httpRequest(`${base}/api/v1/projects/remote-jobs/${jobStart.json.jobId}/cancel`, {
    method: 'POST',
    headers: cfAuth,
    body: {}
  });
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.json.job.status, 'cancelled');

  // Job poll endpoint
  const jobPoll = await httpRequest(`${base}/api/v1/projects/remote-jobs/${jobStart.json.jobId}`, {
    headers: cfAuth
  });
  assert.equal(jobPoll.status, 200);
  assert.equal(jobPoll.json.job.status, 'cancelled');
});
