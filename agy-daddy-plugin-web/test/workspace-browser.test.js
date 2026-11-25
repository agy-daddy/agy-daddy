'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { createWorkspaceBrowser } = require('../src/workspace-browser');
const { createRemoteProjectProvisioner } = require('../src/remote-project-provisioner');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

async function waitForJobTerminal(provisioner, jobId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = provisioner.getJob(jobId);
    if (res.ok && res.job && ['succeeded', 'failed', 'cancelled'].includes(res.job.status)) {
      return res.job;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Job ${jobId} did not reach terminal state within ${timeoutMs}ms`);
}

test('workspace-browser: single-level browse, showHidden, isGitRepo, shortcuts, and nonexistent ancestor', async (t) => {
  const tmp = makeTempDir('agy-wb-browse-');
  const gdriveScan = makeTempDir('agy-wb-gdrive-');
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(gdriveScan, { recursive: true, force: true });
  });

  const subRepo = path.join(tmp, 'repo-a');
  const subNormal = path.join(tmp, 'notes');
  const hiddenDir = path.join(tmp, '.hidden-cfg');
  fs.mkdirSync(path.join(subRepo, '.git'), { recursive: true });
  fs.mkdirSync(subNormal, { recursive: true });
  fs.mkdirSync(hiddenDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'README.md'), 'hi');

  const gdriveMount = path.join(gdriveScan, 'GoogleDrive-user@example.com');
  fs.mkdirSync(path.join(gdriveMount, 'My Drive'), { recursive: true });

  const browser = createWorkspaceBrowser({
    getDefaultSessionPath: () => subNormal,
    getProjectRootPaths: () => [subRepo],
    gdriveScanRoots: [gdriveScan]
  });

  const res = await browser.browse({ path: tmp });
  assert.equal(res.ok, true);
  assert.equal(res.exists, true);
  assert.equal(res.willCreateRelative, '');
  assert.deepEqual(res.entries.map((e) => e.name), ['notes', 'repo-a']);
  assert.equal(res.entries.find((e) => e.name === 'repo-a')?.isGitRepo, true);
  assert.equal(res.entries.find((e) => e.name === 'notes')?.isGitRepo, false);
  assert.ok(res.breadcrumbs.length >= 1);
  assert.ok(res.shortcuts.some((s) => s.kind === 'home'));
  assert.ok(res.shortcuts.some((s) => s.kind === 'gdrive' && s.path === gdriveMount));

  const resHidden = await browser.browse({ path: tmp, showHidden: true });
  assert.equal(resHidden.ok, true);
  assert.ok(resHidden.entries.some((e) => e.name === '.hidden-cfg'));

  const missingPath = path.join(tmp, 'new-org', 'new-proj');
  const resMissing = await browser.browse({ path: missingPath });
  assert.equal(resMissing.ok, true);
  assert.equal(resMissing.exists, false);
  assert.equal(resMissing.resolvedPath, fs.realpathSync(tmp));
  assert.equal(resMissing.willCreateRelative, path.join('new-org', 'new-proj'));
});

test('workspace-browser: blocks system roots, traversal to /etc, symlinks to /etc, and validates mkdir', async (t) => {
  const tmp = makeTempDir('agy-wb-sec-');
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const browser = createWorkspaceBrowser();

  const etcRes = await browser.browse({ path: '/etc' });
  assert.equal(etcRes.ok, false);
  assert.equal(etcRes.statusCode, 403);
  assert.equal(etcRes.error, 'FORBIDDEN_SYSTEM_ROOT');

  const sshRes = await browser.browse({ path: path.join(os.homedir(), '.ssh') });
  assert.equal(sshRes.ok, false);
  assert.equal(sshRes.statusCode, 403);
  assert.equal(sshRes.error, 'FORBIDDEN_SYSTEM_ROOT');

  const travRes = await browser.browse({ path: path.join(tmp, '..', '..', '..', '..', '..', 'etc') });
  assert.equal(travRes.ok, false);
  assert.equal(travRes.statusCode, 403);
  assert.equal(travRes.error, 'FORBIDDEN_SYSTEM_ROOT');

  if (fs.existsSync('/etc')) {
    const linkPath = path.join(tmp, 'link-etc');
    try {
      fs.symlinkSync('/etc', linkPath);
      const symRes = await browser.browse({ path: linkPath });
      assert.equal(symRes.ok, false);
      assert.equal(symRes.statusCode, 403);
      assert.equal(symRes.error, 'FORBIDDEN_SYSTEM_ROOT');
    } catch {
      // Symlink creation may require privilege on some filesystems
    }
  }

  const badMk = await browser.mkdir({ parentDir: tmp, name: '../escape' });
  assert.equal(badMk.ok, false);
  assert.equal(badMk.statusCode, 400);
  assert.equal(badMk.error, 'INVALID_DIR_NAME');

  const sysMk = await browser.mkdir({ parentDir: '/etc', name: 'evil' });
  assert.equal(sysMk.ok, false);
  assert.equal(sysMk.statusCode, 403);

  const okMk = await browser.mkdir({ parentDir: tmp, name: 'brand-new' });
  assert.equal(okMk.ok, true);
  assert.equal(fs.existsSync(okMk.path), true);

  const dupMk = await browser.mkdir({ parentDir: tmp, name: 'brand-new' });
  assert.equal(dupMk.ok, false);
  assert.equal(dupMk.statusCode, 409);
  assert.equal(dupMk.error, 'DIR_ALREADY_EXISTS');
});

test('remote-project-provisioner: blocks CLI argument injection and clones with -- separator', async (t) => {
  const tmp = makeTempDir('agy-rp-clone-');
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const spawnCalls = [];
  const createdProjects = [];
  const authorizedRoots = [];
  const jobEvents = [];

  const provisioner = createRemoteProjectProvisioner({
    spawnFn: (bin, args) => {
      spawnCalls.push({ bin, args: [...args] });
      if (bin === 'git' && args[0] === 'clone') {
        const target = args[args.length - 1];
        fs.mkdirSync(path.join(target, '.git'), { recursive: true });
        return makeFakeChild({ code: 0, stdout: 'Cloning into...' });
      }
      return makeFakeChild({ code: 0 });
    },
    createProjectFn: (payload) => {
      const proj = { id: 'proj_1', ...payload };
      createdProjects.push(proj);
      return { ok: true, project: proj };
    },
    authorizeRootFn: (rootPath) => {
      authorizedRoots.push(rootPath);
      return { ok: true };
    },
    onJobUpdated: (job) => {
      jobEvents.push({ status: job.status, step: job.step });
    }
  });
  t.after(() => provisioner.dispose());

  // Argument injection blocked
  const injBranch = await provisioner.startJob({
    provider: 'github',
    mode: 'gh_clone',
    projectName: 'Safe Project',
    parentDir: tmp,
    localDirName: 'safe-dir',
    github: { repoSpec: 'owner/repo', branch: '--upload-pack=evil' }
  });
  assert.equal(injBranch.ok, false);
  assert.equal(injBranch.statusCode, 400);
  assert.equal(injBranch.error, 'INVALID_ARGUMENT_INJECTION');

  const injUrl = await provisioner.startJob({
    provider: 'github',
    mode: 'gh_clone',
    projectName: 'Safe Project',
    parentDir: tmp,
    github: { repoSpec: 'https://evil.example.com/a/b.git' }
  });
  assert.equal(injUrl.ok, false);
  assert.equal(injUrl.statusCode, 400);
  assert.equal(injUrl.error, 'INVALID_GITHUB_URL');

  const listInj = await provisioner.listGithubRepos({ owner: '-evil' });
  assert.equal(listInj.ok, false);
  assert.equal(listInj.statusCode, 400);
  assert.equal(listInj.error, 'INVALID_ARGUMENT_INJECTION');

  // Valid clone passes `--` before repoUrl and completes
  const started = await provisioner.startJob({
    provider: 'github',
    mode: 'gh_clone',
    parentDir: tmp,
    localDirName: 'demo-app',
    projectName: 'Demo App',
    github: { repoSpec: 'octo/demo-app', branch: 'main' }
  });
  assert.equal(started.ok, true);
  assert.equal(started.statusCode, 202);
  const doneJob = await waitForJobTerminal(provisioner, started.jobId);
  assert.equal(doneJob.status, 'succeeded');
  assert.equal(doneJob.project.name, 'Demo App');

  const cloneCall = spawnCalls.find((c) => c.bin === 'git' && c.args[0] === 'clone');
  assert.ok(cloneCall);
  const sepIdx = cloneCall.args.indexOf('--');
  assert.ok(sepIdx >= 0);
  assert.equal(cloneCall.args[sepIdx + 1], 'https://github.com/octo/demo-app.git');
  assert.equal(createdProjects.length, 1);
  assert.equal(createdProjects[0].source, 'github');
  assert.equal(authorizedRoots.length, 1);
  assert.ok(jobEvents.some((e) => e.status === 'succeeded'));
});

test('remote-project-provisioner: gh_create_and_clone preserves remoteCreated when clone fails', async (t) => {
  const tmp = makeTempDir('agy-rp-create-fail-');
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const provisioner = createRemoteProjectProvisioner({
    spawnFn: (bin, args) => {
      if (bin === 'gh' && args[0] === 'repo' && args[1] === 'create') {
        return makeFakeChild({ code: 0, stdout: 'https://github.com/octo/fresh-repo\n' });
      }
      if (bin === 'git' && args[0] === 'clone') {
        return makeFakeChild({ code: 128, stderr: 'fatal: network timeout' });
      }
      return makeFakeChild({ code: 0 });
    }
  });
  t.after(() => provisioner.dispose());

  const started = await provisioner.startJob({
    provider: 'github',
    mode: 'gh_create_and_clone',
    projectName: 'Fresh Repo',
    parentDir: tmp,
    localDirName: 'fresh-repo',
    github: { newRepoName: 'fresh-repo', owner: 'octo', visibility: 'private' }
  });
  assert.equal(started.ok, true);
  const done = await waitForJobTerminal(provisioner, started.jobId);
  assert.equal(done.status, 'failed');
  assert.equal(done.error, 'CLONE_AFTER_CREATE_FAILED');
  assert.deepEqual(done.remoteCreated, {
    ownerRepo: 'octo/fresh-repo',
    cloneUrl: 'https://github.com/octo/fresh-repo.git',
    htmlUrl: 'https://github.com/octo/fresh-repo'
  });
  assert.equal(fs.existsSync(path.join(tmp, 'fresh-repo')), false);
});

test('remote-project-provisioner: cancel kills running child and removes partial createdTargetDir', async (t) => {
  const tmp = makeTempDir('agy-rp-cancel-');
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const signals = [];
  const provisioner = createRemoteProjectProvisioner({
    spawnFn: (bin, args) => {
      if (bin === 'git' && args[0] === 'clone') {
        const target = args[args.length - 1];
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'partial.tmp'), 'downloading');
        return makeFakeChild({
          delayMs: 5000,
          onKill: (sig) => signals.push(sig)
        });
      }
      return makeFakeChild({ code: 0 });
    }
  });
  t.after(() => provisioner.dispose());

  const started = await provisioner.startJob({
    provider: 'github',
    mode: 'gh_clone',
    projectName: 'Cancel Me',
    parentDir: tmp,
    localDirName: 'cancel-me',
    github: { repoSpec: 'octo/cancel-me' }
  });
  assert.equal(started.ok, true);
  await new Promise((r) => setTimeout(r, 30));

  const cancelRes = await provisioner.cancelJob(started.jobId);
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.job.status, 'cancelled');
  assert.ok(signals.includes('SIGTERM'));
  assert.equal(fs.existsSync(path.join(tmp, 'cancel-me')), false);
  assert.equal(fs.existsSync(tmp), true);
});

test('remote-project-provisioner: preflight detects Google Drive 3 tiers & syncs mount path', async (t) => {
  const tmp = makeTempDir('agy-rp-gdrive-');
  const mountScan = makeTempDir('agy-rp-mount-');
  const destParent = makeTempDir('agy-rp-dest-');
  t.after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(mountScan, { recursive: true, force: true });
    fs.rmSync(destParent, { recursive: true, force: true });
  });

  const mountRoot = path.join(mountScan, 'GoogleDrive-team@example.com');
  const myDrive = path.join(mountRoot, 'My Drive');
  const srcFolder = path.join(myDrive, 'ClientProject');
  fs.mkdirSync(srcFolder, { recursive: true });
  fs.writeFileSync(path.join(srcFolder, 'spec.md'), '# Project Spec\n');

  // Tier 1: mount
  const provMount = createRemoteProjectProvisioner({
    gdriveScanRoots: [mountScan],
    spawnFn: () => makeFakeChild({ code: 1, stderr: 'not installed' }),
    createProjectFn: (payload) => ({ ok: true, project: { id: 'proj_gd', ...payload } })
  });
  t.after(() => provMount.dispose());

  const pfMount = await provMount.preflight({ provider: 'gdrive' });
  assert.equal(pfMount.ok, true);
  assert.equal(pfMount.gdrive.tier, 'mount');
  assert.equal(pfMount.gdrive.mounts.length, 1);

  const gdJob = await provMount.startJob({
    provider: 'gdrive',
    mode: 'gdrive_mount_select',
    projectName: 'Client Project',
    gdrive: { mountPath: srcFolder, account: 'team@example.com' }
  });
  assert.equal(gdJob.ok, true);
  const done = await waitForJobTerminal(provMount, gdJob.jobId);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.project.source, 'google-drive');
  assert.equal(done.project.rootPath, fs.realpathSync(srcFolder));

  const gdMkdirJob = await provMount.startJob({
    provider: 'gdrive',
    mode: 'gdrive_mount_mkdir',
    projectName: 'New Mount Dir',
    localDirName: 'new-client-folder',
    gdrive: { mountPath: myDrive, account: 'team@example.com' }
  });
  assert.equal(gdMkdirJob.ok, true);
  const doneMkdir = await waitForJobTerminal(provMount, gdMkdirJob.jobId);
  assert.equal(doneMkdir.status, 'succeeded');
  assert.equal(fs.existsSync(path.join(myDrive, 'new-client-folder')), true);

  // Tier 2: cli
  const provCli = createRemoteProjectProvisioner({
    gdriveScanRoots: [path.join(tmp, 'missing-mounts')],
    spawnFn: (bin, args) => {
      if (bin === 'rclone' && args[0] === 'listremotes') {
        return makeFakeChild({ code: 0, stdout: 'mydrive: drive\n' });
      }
      const errChild = new EventEmitter();
      errChild.stdout = new PassThrough();
      errChild.stderr = new PassThrough();
      errChild.kill = () => true;
      setImmediate(() => errChild.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      return errChild;
    }
  });
  t.after(() => provCli.dispose());
  const pfCli = await provCli.preflight({ provider: 'gdrive' });
  assert.equal(pfCli.gdrive.tier, 'cli');
  assert.deepEqual(pfCli.gdrive.rclone.driveRemotes, ['mydrive']);

  // Tier 3: unavailable
  const provNone = createRemoteProjectProvisioner({
    gdriveScanRoots: [path.join(tmp, 'missing-mounts')],
    spawnFn: () => {
      const errChild = new EventEmitter();
      errChild.stdout = new PassThrough();
      errChild.stderr = new PassThrough();
      errChild.kill = () => true;
      setImmediate(() => errChild.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      return errChild;
    }
  });
  t.after(() => provNone.dispose());
  const pfNone = await provNone.preflight({ provider: 'gdrive' });
  assert.equal(pfNone.gdrive.tier, 'unavailable');
  assert.ok(pfNone.gdrive.setupHints.length >= 1);
});
