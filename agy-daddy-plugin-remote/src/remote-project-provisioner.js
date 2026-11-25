'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const {
  normalizeLocalPath,
  isForbiddenSystemRoot,
  isSameOrInside
} = require('./workspace-browser');

const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const DEFAULT_PREFLIGHT_TIMEOUT_MS = 3000;
const MOUNT_PROBE_TIMEOUT_MS = 1500;
const CANCEL_KILL_GRACE_MS = 1500;
const MAX_JOBS = 100;

const SAFE_REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;
const OWNER_REPO_SHORTHAND_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const ALLOWED_GITHUB_URL_RE = /^(?:https:\/\/github\.com\/[^\s]+|git@github\.com:[^\s]+|ssh:\/\/git@github\.com\/[^\s]+)$/i;
const MY_DRIVE_DIR_NAMES = ['My Drive', '我的云端硬盘', 'マイドライブ', 'Mon Drive', 'Meine Ablage', 'Mi unidad'];

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function validateSafeCliArg(val, fieldName) {
  if (typeof val !== 'string') return { ok: true, value: '' };
  const s = val.trim();
  if (!s) return { ok: true, value: '' };
  if (s.startsWith('-')) {
    return { ok: false, error: 'INVALID_ARGUMENT_INJECTION', field: fieldName, message: `${fieldName} cannot start with '-'` };
  }
  if (/[\0\r\n]/.test(s)) {
    return { ok: false, error: 'INVALID_ARGUMENT_INJECTION', field: fieldName, message: `${fieldName} contains control characters` };
  }
  return { ok: true, value: s };
}

function validateSingleFolderName(raw, fieldName = 'localDirName') {
  const argCheck = validateSafeCliArg(raw, fieldName);
  if (!argCheck.ok) return argCheck;
  const s = argCheck.value;
  if (!s || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || path.basename(s) !== s) {
    return { ok: false, error: 'INVALID_DIR_NAME', field: fieldName, message: 'Directory name must be a single folder name' };
  }
  return { ok: true, value: s };
}

function resolveGithubCloneSpec(rawSpec) {
  const check = validateSafeCliArg(rawSpec, 'repoSpec');
  if (!check.ok) return check;
  const s = check.value;
  if (!s) {
    return { ok: false, error: 'MISSING_REPO_SPEC', message: 'Repository URL or owner/repo is required' };
  }
  if (OWNER_REPO_SHORTHAND_RE.test(s)) {
    const clean = s.replace(/\.git$/i, '');
    return {
      ok: true,
      cloneUrl: `https://github.com/${clean}.git`,
      ownerRepo: clean,
      defaultDirName: clean.split('/')[1]
    };
  }
  if (ALLOWED_GITHUB_URL_RE.test(s)) {
    const clean = s.replace(/\/+$/, '');
    const m = clean.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i);
    const ownerRepo = m ? m[1] : '';
    const defaultDirName = ownerRepo ? ownerRepo.split('/')[1] : path.basename(clean, '.git');
    return {
      ok: true,
      cloneUrl: clean,
      ownerRepo,
      defaultDirName
    };
  }
  return {
    ok: false,
    error: 'INVALID_GITHUB_URL',
    message: 'Only GitHub HTTPS, SSH, or owner/repo shorthand is supported'
  };
}

function withTimeout(promise, ms, code = 'TIMEOUT') {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(code), { code }));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildNonInteractiveEnv(extraEnv = {}) {
  return {
    ...process.env,
    ...extraEnv,
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C.UTF-8'
  };
}

function runSpawnPromise(spawnFn, bin, args, { timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS, env = {}, onChild = null } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer = null;
    let timeoutTimer = null;

    let child;
    try {
      child = spawnFn(bin, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildNonInteractiveEnv(env)
      });
    } catch (err) {
      resolve({ ok: false, code: -1, spawnError: err?.code || err?.message || 'SPAWN_FAILED', stdout: '', stderr: String(err?.message || '') });
      return;
    }

    if (typeof onChild === 'function') {
      onChild(child);
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    timeoutTimer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, CANCEL_KILL_GRACE_MS);
      killTimer.unref?.();
      finish({ ok: false, code: -1, timedOut: true, stdout, stderr });
    }, timeoutMs);
    timeoutTimer.unref?.();

    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      finish({ ok: false, code: -1, spawnError: err?.code || err?.message || 'SPAWN_ERROR', stdout, stderr });
    });
    child.on('close', (code, signal) => {
      finish({ ok: code === 0, code, signal: signal || null, stdout, stderr });
    });
  });
}

function parseGhAuthOutput(combinedOutput) {
  const accounts = [];
  let activeAccount = null;
  const lines = String(combinedOutput || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/Logged in to [^\s]+ account ([^\s(]+)/i);
    if (m) {
      const acct = m[1].trim();
      if (acct && !accounts.includes(acct)) accounts.push(acct);
      const windowText = lines.slice(i, i + 4).join(' ');
      if (/Active account:\s*true/i.test(windowText) || !activeAccount) {
        activeAccount = acct;
      }
    }
  }
  return {
    ghAuthenticated: accounts.length > 0,
    activeAccount,
    accounts
  };
}

function parseRcloneRemotes(stdout) {
  const driveRemotes = [];
  const lines = String(stdout || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([^\s:]+):\s*(\S+)/);
    if (m && m[2].toLowerCase() === 'drive') {
      driveRemotes.push(m[1]);
    }
  }
  return driveRemotes;
}

/**
 * Async GitHub & Google Drive project provisioning engine with zero-injection spawn and cancel cleanup.
 */
function createRemoteProjectProvisioner(options = {}) {
  const spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : spawn;
  const execTimeoutMs = Number.isFinite(Number(options.execTimeoutMs)) && Number(options.execTimeoutMs) > 0
    ? Number(options.execTimeoutMs)
    : DEFAULT_EXEC_TIMEOUT_MS;
  const preflightTimeoutMs = Number.isFinite(Number(options.preflightTimeoutMs)) && Number(options.preflightTimeoutMs) > 0
    ? Number(options.preflightTimeoutMs)
    : DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const gdriveScanRoots = options.gdriveScanRoots;
  const createProjectFn = typeof options.createProjectFn === 'function' ? options.createProjectFn : null;
  const authorizeRootFn = typeof options.authorizeRootFn === 'function' ? options.authorizeRootFn : null;
  const checkDuplicateProjectFn = typeof options.checkDuplicateProjectFn === 'function' ? options.checkDuplicateProjectFn : null;
  const onJobUpdated = typeof options.onJobUpdated === 'function' ? options.onJobUpdated : null;

  const jobs = new Map();
  const activeProcesses = new Map();

  function emitJob(job) {
    job.updatedAt = new Date().toISOString();
    job.elapsedMs = Math.max(0, Date.now() - job._startedAtMs);
    if (onJobUpdated) {
      try {
        onJobUpdated(serializeJob(job));
      } catch {}
    }
  }

  function serializeJob(job) {
    const copy = { ...job };
    delete copy._startedAtMs;
    delete copy._realParent;
    return copy;
  }

  function pruneOldJobs() {
    if (jobs.size <= MAX_JOBS) return;
    const sorted = Array.from(jobs.values()).sort((a, b) => a._startedAtMs - b._startedAtMs);
    for (const j of sorted) {
      if (jobs.size <= MAX_JOBS) break;
      if (j.status !== 'running') jobs.delete(j.jobId);
    }
  }

  async function probeGithub() {
    const gitRes = await runSpawnPromise(spawnFn, 'git', ['--version'], { timeoutMs: preflightTimeoutMs });
    const gitInstalled = gitRes.ok;
    const gitVersion = gitInstalled ? gitRes.stdout.trim().replace(/^git version\s*/i, '') : null;

    const ghVerRes = await runSpawnPromise(spawnFn, 'gh', ['--version'], { timeoutMs: preflightTimeoutMs });
    const ghInstalled = ghVerRes.ok;

    let ghAuthenticated = false;
    let activeAccount = null;
    let accounts = [];
    let orgs = [];

    if (ghInstalled) {
      const authRes = await runSpawnPromise(spawnFn, 'gh', ['auth', 'status'], { timeoutMs: preflightTimeoutMs });
      const parsed = parseGhAuthOutput(`${authRes.stdout}\n${authRes.stderr}`);
      ghAuthenticated = parsed.ghAuthenticated;
      activeAccount = parsed.activeAccount;
      accounts = parsed.accounts;

      if (ghAuthenticated) {
        const orgRes = await runSpawnPromise(spawnFn, 'gh', ['api', 'user/orgs', '--jq', '.[].login'], { timeoutMs: preflightTimeoutMs });
        if (orgRes.ok) {
          orgs = orgRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        }
      }
    }

    const installHints = {};
    if (!gitInstalled) {
      installHints.git = process.platform === 'darwin'
        ? 'xcode-select --install'
        : (process.platform === 'win32' ? 'winget install Git.Git' : 'Install git via system package manager');
    }
    if (!ghInstalled || !ghAuthenticated) {
      installHints.ghLogin = ghInstalled ? 'gh auth login' : 'Install gh CLI then run: gh auth login';
    }

    return {
      gitInstalled,
      gitVersion,
      ghInstalled,
      ghAuthenticated,
      activeAccount,
      accounts,
      orgs,
      canClonePublicOrSsh: gitInstalled,
      canCreateRepo: gitInstalled && ghInstalled && ghAuthenticated,
      installHints
    };
  }

  async function probeGoogleDrive() {
    const home = os.homedir();
    const scanRoots = Array.isArray(gdriveScanRoots)
      ? gdriveScanRoots
      : [path.join(home, 'Library', 'CloudStorage'), '/Volumes', path.join(home, 'Google Drive')];

    const mounts = [];
    const seenPaths = new Set();

    for (const scanRoot of scanRoots) {
      try {
        if (!fs.existsSync(scanRoot)) continue;
        const candidates = [];
        if (path.basename(scanRoot) === 'Google Drive') {
          candidates.push(scanRoot);
        } else {
          const ents = await withTimeout(fs.promises.readdir(scanRoot, { withFileTypes: true }), MOUNT_PROBE_TIMEOUT_MS, 'GDRIVE_SCAN_TIMEOUT');
          for (const ent of ents) {
            if (ent.name.startsWith('GoogleDrive-') || /^GoogleDrive/i.test(ent.name)) {
              candidates.push(path.join(scanRoot, ent.name));
            }
          }
        }
        for (const rootPath of candidates) {
          const norm = normalizeLocalPath(rootPath);
          if (!norm || seenPaths.has(norm)) continue;
          seenPaths.add(norm);
          let responsive = false;
          let myDrivePath = norm;
          try {
            const subEnts = await withTimeout(fs.promises.readdir(norm, { withFileTypes: true }), MOUNT_PROBE_TIMEOUT_MS, 'GDRIVE_MOUNT_TIMEOUT');
            responsive = true;
            const myDrive = subEnts.find((e) => e.isDirectory() && MY_DRIVE_DIR_NAMES.includes(e.name));
            if (myDrive) {
              myDrivePath = path.join(norm, myDrive.name);
            }
          } catch {
            responsive = false;
          }
          const baseName = path.basename(norm);
          const account = baseName.startsWith('GoogleDrive-') ? baseName.slice('GoogleDrive-'.length) : null;
          mounts.push({
            id: `gd_mount_${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 8)}`,
            account,
            rootPath: norm,
            myDrivePath,
            responsive
          });
        }
      } catch {
        // Ignore inaccessible scan root
      }
    }

    const rcloneRes = await runSpawnPromise(spawnFn, 'rclone', ['listremotes', '--long'], { timeoutMs: preflightTimeoutMs });
    const rcloneInstalled = rcloneRes.ok || !rcloneRes.spawnError;
    const driveRemotes = rcloneRes.ok ? parseRcloneRemotes(rcloneRes.stdout) : [];

    let gdriveInstalled = false;
    let gdriveAuth = false;
    let gdriveAccount = null;
    const gdVer = await runSpawnPromise(spawnFn, 'gdrive', ['version'], { timeoutMs: preflightTimeoutMs });
    if (!gdVer.spawnError) {
      gdriveInstalled = true;
      const gdAccount = await runSpawnPromise(spawnFn, 'gdrive', ['account', 'list'], { timeoutMs: preflightTimeoutMs });
      if (gdAccount.ok && gdAccount.stdout.trim()) {
        gdriveAuth = true;
        gdriveAccount = gdAccount.stdout.trim().split(/\r?\n/)[0].trim() || null;
      } else {
        const gdStatus = await runSpawnPromise(spawnFn, 'gdrive', ['auth', 'status'], { timeoutMs: preflightTimeoutMs });
        if (gdStatus.ok && !/not\s+authenticated|no\s+account/i.test(gdStatus.stdout + gdStatus.stderr)) {
          gdriveAuth = true;
          const m = (gdStatus.stdout + gdStatus.stderr).match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
          gdriveAccount = m ? m[0] : null;
        }
      }
    }

    const tier = mounts.some((m) => m.responsive) || mounts.length > 0
      ? 'mount'
      : (driveRemotes.length > 0 || gdriveAuth ? 'cli' : 'unavailable');

    const setupHints = [];
    if (tier === 'unavailable') {
      setupHints.push('Install and sign in to Google Drive Desktop to expose a local mount directory.');
      setupHints.push('Or configure rclone (rclone config) / gdrive CLI authentication on the host.');
    }

    return {
      tier,
      mounts,
      rclone: {
        installed: rcloneInstalled,
        driveRemotes
      },
      gdriveCli: {
        installed: gdriveInstalled,
        authenticated: gdriveAuth,
        account: gdriveAccount
      },
      setupHints
    };
  }

  async function preflight({ provider = 'all' } = {}) {
    const cleanProv = String(provider || 'all').trim().toLowerCase();
    const res = { ok: true };
    if (cleanProv === 'all' || cleanProv === 'github') {
      res.github = await probeGithub();
    }
    if (cleanProv === 'all' || cleanProv === 'gdrive') {
      res.gdrive = await probeGoogleDrive();
    }
    return res;
  }

  async function listGithubRepos({ owner = '', limit = 30 } = {}) {
    const ownerCheck = validateSafeCliArg(owner, 'owner');
    if (!ownerCheck.ok) {
      return { ok: false, statusCode: 400, error: ownerCheck.error, message: ownerCheck.message };
    }
    const ghInfo = await probeGithub();
    if (!ghInfo.ghInstalled || !ghInfo.ghAuthenticated) {
      return { ok: false, statusCode: 409, error: 'GH_NOT_AUTHENTICATED' };
    }
    const parsedLimit = Number(limit);
    const boundedLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(Math.floor(parsedLimit), 100) : 30;
    const args = ['repo', 'list'];
    if (ownerCheck.value) args.push(ownerCheck.value);
    args.push('--limit', String(boundedLimit), '--json', 'nameWithOwner,url,sshUrl,isPrivate,defaultBranchRef,updatedAt');

    const res = await runSpawnPromise(spawnFn, 'gh', args, { timeoutMs: Math.max(preflightTimeoutMs, 8000) });
    if (!res.ok) {
      return { ok: false, statusCode: 502, error: 'GH_REPO_LIST_FAILED', message: res.stderr.trim() || 'gh repo list failed' };
    }
    try {
      const repos = JSON.parse(res.stdout || '[]');
      return { ok: true, repos: Array.isArray(repos) ? repos : [] };
    } catch {
      return { ok: false, statusCode: 502, error: 'GH_REPO_LIST_PARSE_FAILED' };
    }
  }

  function cleanupCreatedTargetDir(job) {
    if (!job?.createdTargetDir) return;
    const dirToClean = job.createdTargetDir;
    if (isForbiddenSystemRoot(dirToClean)) return;
    if (job._realParent && !isSameOrInside(dirToClean, job._realParent)) return;
    if (dirToClean === job._realParent) return;
    try {
      if (fs.existsSync(dirToClean)) {
        fs.rmSync(dirToClean, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup
    }
  }

  function registerCreatedProject({ name, rootPath, groupId, source, remote }) {
    if (authorizeRootFn) {
      try {
        void Promise.resolve(authorizeRootFn(rootPath)).catch(() => {});
      } catch {}
    }
    if (!createProjectFn) {
      return { ok: true, project: { id: `proj_${crypto.randomUUID()}`, name, rootPath, groupId: groupId || null, source, remote } };
    }
    return createProjectFn({ name, rootPath, groupId: groupId || null, source, remote });
  }

  async function runJobAsync(job, params) {
    const registerAndFinish = (projectPayload) => {
      job.step = 'registering';
      emitJob(job);
      const regRes = registerCreatedProject(projectPayload);
      if (!regRes || regRes.ok === false) {
        cleanupCreatedTargetDir(job);
        job.status = 'failed';
        job.error = regRes?.error || 'PROJECT_REGISTER_FAILED';
        job.message = regRes?.message || job.error;
        emitJob(job);
        return;
      }
      job.status = 'succeeded';
      job.step = 'done';
      job.project = regRes.project || regRes;
      emitJob(job);
    };

    try {
      if (job.status === 'cancelled') return;

      if (job.provider === 'github') {
        const gh = params.github || {};
        if (job.mode === 'gh_clone') {
          const spec = resolveGithubCloneSpec(gh.repoSpec);
          const branchCheck = validateSafeCliArg(gh.branch, 'branch');
          job.step = 'cloning';
          emitJob(job);

          const args = ['clone', '--progress'];
          if (branchCheck.value) args.push('--branch', branchCheck.value);
          args.push('--', spec.cloneUrl, job.targetDir);

          const cloneRes = await runSpawnPromise(spawnFn, 'git', args, {
            timeoutMs: execTimeoutMs,
            onChild: (child) => { activeProcesses.set(job.jobId, child); }
          });
          activeProcesses.delete(job.jobId);

          if (job.status === 'cancelled') {
            cleanupCreatedTargetDir(job);
            return;
          }
          if (!cloneRes.ok) {
            cleanupCreatedTargetDir(job);
            const errText = `${cloneRes.stderr}\n${cloneRes.stdout}`.trim();
            job.status = 'failed';
            job.error = cloneRes.timedOut
              ? 'JOB_TIMEOUT'
              : (/Authentication failed|Permission denied|could not read Username|terminal prompts disabled/i.test(errText) ? 'AUTH_REQUIRED' : 'GIT_CLONE_FAILED');
            job.message = errText || job.error;
            emitJob(job);
            return;
          }

          registerAndFinish({
            name: job.projectName,
            rootPath: job.targetDir,
            groupId: job.groupId,
            source: 'github',
            remote: {
              provider: 'github',
              ownerRepo: spec.ownerRepo,
              repoUrl: spec.cloneUrl,
              ...(branchCheck.value ? { branch: branchCheck.value } : {})
            }
          });
          return;
        }

        if (job.mode === 'gh_create_and_clone') {
          const repoName = String(gh.newRepoName || '').trim();
          const owner = String(gh.owner || '').trim();
          const visibility = gh.visibility === 'public' ? '--public' : '--private';
          const description = typeof gh.description === 'string' ? gh.description.replace(/[\0\r\n]/g, ' ').trim() : '';
          const addReadme = gh.addReadme !== false;

          const targetSlug = owner ? `${owner}/${repoName}` : repoName;
          job.step = 'creating_remote';
          emitJob(job);

          const createArgs = ['repo', 'create', targetSlug, visibility];
          if (description) createArgs.push('--description', description);
          if (addReadme) createArgs.push('--add-readme');

          const createRes = await runSpawnPromise(spawnFn, 'gh', createArgs, {
            timeoutMs: execTimeoutMs,
            onChild: (child) => { activeProcesses.set(job.jobId, child); }
          });
          activeProcesses.delete(job.jobId);

          if (job.status === 'cancelled') {
            cleanupCreatedTargetDir(job);
            return;
          }
          if (!createRes.ok) {
            const errText = `${createRes.stderr}\n${createRes.stdout}`.trim();
            job.status = 'failed';
            job.error = createRes.timedOut
              ? 'JOB_TIMEOUT'
              : (/auth login|not logged/i.test(errText) ? 'AUTH_REQUIRED' : 'GH_CREATE_FAILED');
            job.message = errText || job.error;
            emitJob(job);
            return;
          }

          const outUrlMatch = createRes.stdout.match(/https:\/\/github\.com\/[^\s]+/i);
          const htmlUrl = outUrlMatch ? outUrlMatch[0].trim().replace(/\.git$/i, '') : `https://github.com/${targetSlug}`;
          const ownerRepoFromUrl = htmlUrl.replace(/^https:\/\/github\.com\//i, '');
          const cloneUrl = `${htmlUrl}.git`;
          job.remoteCreated = {
            ownerRepo: ownerRepoFromUrl,
            cloneUrl,
            htmlUrl
          };

          job.step = 'cloning';
          emitJob(job);

          const cloneRes = await runSpawnPromise(spawnFn, 'git', ['clone', '--progress', '--', cloneUrl, job.targetDir], {
            timeoutMs: execTimeoutMs,
            onChild: (child) => { activeProcesses.set(job.jobId, child); }
          });
          activeProcesses.delete(job.jobId);

          if (job.status === 'cancelled') {
            cleanupCreatedTargetDir(job);
            return;
          }
          if (!cloneRes.ok) {
            cleanupCreatedTargetDir(job);
            const errText = `${cloneRes.stderr}\n${cloneRes.stdout}`.trim();
            job.status = 'failed';
            job.error = 'CLONE_AFTER_CREATE_FAILED';
            job.message = errText || 'Remote GitHub repository was created, but local git clone failed';
            emitJob(job);
            return;
          }

          registerAndFinish({
            name: job.projectName,
            rootPath: job.targetDir,
            groupId: job.groupId,
            source: 'github',
            remote: {
              provider: 'github',
              ownerRepo: ownerRepoFromUrl,
              repoUrl: cloneUrl
            }
          });
          return;
        }
      }

      if (job.provider === 'gdrive') {
        const gd = params.gdrive || {};
        if (job.mode === 'gdrive_mount_select' || job.mode === 'gdrive_mount_mkdir') {
          job.step = 'preparing_mount';
          emitJob(job);
          if (job.mode === 'gdrive_mount_mkdir') {
            fs.mkdirSync(job.targetDir, { recursive: false });
          }
          if (job.status === 'cancelled') {
            cleanupCreatedTargetDir(job);
            return;
          }
          registerAndFinish({
            name: job.projectName,
            rootPath: job.targetDir,
            groupId: job.groupId,
            source: 'google-drive',
            remote: {
              provider: 'google-drive',
              driveMode: 'mount',
              ...(gd.account ? { account: String(gd.account).trim() } : {})
            }
          });
          return;
        }

        if (job.mode === 'gdrive_cli_pull' || job.mode === 'gdrive_cli_mkdir') {
          const cliTool = gd.cliTool === 'gdrive' ? 'gdrive' : 'rclone';
          const remoteName = String(gd.remoteName || '').trim();
          const folderIdOrPath = String(gd.folderIdOrPath || '').trim();
          job.step = job.mode === 'gdrive_cli_mkdir' ? 'creating_remote' : 'pulling';
          emitJob(job);

          if (cliTool === 'rclone') {
            if (job.mode === 'gdrive_cli_mkdir') {
              const remoteTarget = `${remoteName}:${folderIdOrPath || job.localDirName}`;
              const mkRes = await runSpawnPromise(spawnFn, 'rclone', ['mkdir', remoteTarget], {
                timeoutMs: execTimeoutMs,
                onChild: (child) => { activeProcesses.set(job.jobId, child); }
              });
              activeProcesses.delete(job.jobId);
              if (job.status === 'cancelled') {
                cleanupCreatedTargetDir(job);
                return;
              }
              if (!mkRes.ok) {
                job.status = 'failed';
                job.error = mkRes.timedOut ? 'JOB_TIMEOUT' : 'GDRIVE_CLI_FAILED';
                job.message = mkRes.stderr.trim() || job.error;
                emitJob(job);
                return;
              }
              fs.mkdirSync(job.targetDir, { recursive: true });
            } else {
              fs.mkdirSync(job.targetDir, { recursive: true });
              const remoteSrc = `${remoteName}:${folderIdOrPath}`;
              const cpRes = await runSpawnPromise(spawnFn, 'rclone', ['copy', remoteSrc, job.targetDir], {
                timeoutMs: execTimeoutMs,
                onChild: (child) => { activeProcesses.set(job.jobId, child); }
              });
              activeProcesses.delete(job.jobId);
              if (job.status === 'cancelled') {
                cleanupCreatedTargetDir(job);
                return;
              }
              if (!cpRes.ok) {
                cleanupCreatedTargetDir(job);
                job.status = 'failed';
                job.error = cpRes.timedOut ? 'JOB_TIMEOUT' : 'GDRIVE_CLI_FAILED';
                job.message = cpRes.stderr.trim() || job.error;
                emitJob(job);
                return;
              }
            }
          } else {
            if (job.mode === 'gdrive_cli_mkdir') {
              const args = ['files', 'mkdir', job.localDirName];
              if (folderIdOrPath) args.push('--parent', folderIdOrPath);
              const mkRes = await runSpawnPromise(spawnFn, 'gdrive', args, {
                timeoutMs: execTimeoutMs,
                onChild: (child) => { activeProcesses.set(job.jobId, child); }
              });
              activeProcesses.delete(job.jobId);
              if (job.status === 'cancelled') {
                cleanupCreatedTargetDir(job);
                return;
              }
              if (!mkRes.ok) {
                job.status = 'failed';
                job.error = mkRes.timedOut ? 'JOB_TIMEOUT' : 'GDRIVE_CLI_FAILED';
                job.message = mkRes.stderr.trim() || job.error;
                emitJob(job);
                return;
              }
              fs.mkdirSync(job.targetDir, { recursive: true });
            } else {
              fs.mkdirSync(job.targetDir, { recursive: true });
              const dlRes = await runSpawnPromise(spawnFn, 'gdrive', ['files', 'download', '--recursive', '--destination', job.targetDir, folderIdOrPath], {
                timeoutMs: execTimeoutMs,
                onChild: (child) => { activeProcesses.set(job.jobId, child); }
              });
              activeProcesses.delete(job.jobId);
              if (job.status === 'cancelled') {
                cleanupCreatedTargetDir(job);
                return;
              }
              if (!dlRes.ok) {
                cleanupCreatedTargetDir(job);
                job.status = 'failed';
                job.error = dlRes.timedOut ? 'JOB_TIMEOUT' : 'GDRIVE_CLI_FAILED';
                job.message = dlRes.stderr.trim() || job.error;
                emitJob(job);
                return;
              }
            }
          }

          registerAndFinish({
            name: job.projectName,
            rootPath: job.targetDir,
            groupId: job.groupId,
            source: 'google-drive',
            remote: {
              provider: 'google-drive',
              driveMode: 'cli',
              ...(remoteName ? { remoteName } : {}),
              ...(folderIdOrPath ? { remoteFolderId: folderIdOrPath } : {})
            }
          });
          return;
        }
      }

      job.status = 'failed';
      job.error = 'UNSUPPORTED_MODE';
      emitJob(job);
    } catch (err) {
      cleanupCreatedTargetDir(job);
      job.status = 'failed';
      job.error = err?.code || 'PROVISION_ERROR';
      job.message = err?.message || 'Provisioning failed';
      emitJob(job);
    }
  }

  function startJob(body = {}) {
    if (!isPlainObject(body)) {
      return { ok: false, statusCode: 400, error: 'INVALID_JOB_BODY' };
    }
    const provider = String(body.provider || '').trim().toLowerCase();
    const mode = String(body.mode || '').trim();
    const projectName = typeof body.projectName === 'string' ? body.projectName.trim() : '';
    const groupId = body.groupId ? String(body.groupId).trim() : null;

    const allowedModes = {
      github: ['gh_clone', 'gh_create_and_clone'],
      gdrive: ['gdrive_mount_select', 'gdrive_mount_mkdir', 'gdrive_cli_pull', 'gdrive_cli_mkdir']
    };
    if (!allowedModes[provider] || !allowedModes[provider].includes(mode)) {
      return { ok: false, statusCode: 400, error: 'INVALID_PROVIDER_OR_MODE' };
    }
    if (!projectName) {
      return { ok: false, statusCode: 400, error: 'MISSING_PROJECT_NAME' };
    }

    let defaultDirName = projectName;
    if (provider === 'github') {
      const gh = isPlainObject(body.github) ? body.github : {};
      if (mode === 'gh_clone') {
        const spec = resolveGithubCloneSpec(gh.repoSpec);
        if (!spec.ok) return { ok: false, statusCode: 400, error: spec.error, message: spec.message };
        const branchCheck = validateSafeCliArg(gh.branch, 'branch');
        if (!branchCheck.ok) return { ok: false, statusCode: 400, error: branchCheck.error, message: branchCheck.message };
        defaultDirName = spec.defaultDirName || projectName;
      } else {
        const nameCheck = validateSafeCliArg(gh.newRepoName, 'newRepoName');
        if (!nameCheck.ok) return { ok: false, statusCode: 400, error: nameCheck.error, message: nameCheck.message };
        if (!nameCheck.value || !SAFE_REPO_NAME_RE.test(nameCheck.value) || nameCheck.value === '.' || nameCheck.value === '..') {
          return { ok: false, statusCode: 400, error: 'INVALID_REPO_NAME' };
        }
        const ownerCheck = validateSafeCliArg(gh.owner, 'owner');
        if (!ownerCheck.ok) return { ok: false, statusCode: 400, error: ownerCheck.error, message: ownerCheck.message };
        defaultDirName = nameCheck.value;
      }
    } else if (provider === 'gdrive') {
      const gd = isPlainObject(body.gdrive) ? body.gdrive : {};
      for (const [k, v] of [['remoteName', gd.remoteName], ['folderIdOrPath', gd.folderIdOrPath]]) {
        const check = validateSafeCliArg(v, k);
        if (!check.ok) return { ok: false, statusCode: 400, error: check.error, message: check.message };
      }
    }

    let targetDir = '';
    let realParent = '';
    let dirExistedBefore = false;

    if (mode === 'gdrive_mount_select') {
      const mountPathRaw = body.gdrive?.mountPath || body.parentDir;
      const normMount = normalizeLocalPath(mountPathRaw);
      if (!normMount) return { ok: false, statusCode: 400, error: 'INVALID_PATH' };
      if (isForbiddenSystemRoot(normMount)) return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
      try {
        targetDir = fs.realpathSync(normMount);
      } catch {
        return { ok: false, statusCode: 404, error: 'MOUNT_PATH_NOT_FOUND' };
      }
      if (isForbiddenSystemRoot(targetDir)) return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
      if (!fs.statSync(targetDir).isDirectory()) return { ok: false, statusCode: 400, error: 'ROOT_NOT_DIRECTORY' };
      dirExistedBefore = true;
      realParent = path.dirname(targetDir);
    } else {
      const rawParent = mode === 'gdrive_mount_mkdir' ? (body.gdrive?.mountPath || body.parentDir) : body.parentDir;
      const normParent = normalizeLocalPath(rawParent);
      if (!normParent) return { ok: false, statusCode: 400, error: 'INVALID_PARENT_DIR' };
      if (isForbiddenSystemRoot(normParent)) return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
      try {
        realParent = fs.realpathSync(normParent);
      } catch {
        return { ok: false, statusCode: 404, error: 'PARENT_NOT_FOUND' };
      }
      if (isForbiddenSystemRoot(realParent)) return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
      if (!fs.statSync(realParent).isDirectory()) return { ok: false, statusCode: 400, error: 'PARENT_NOT_DIRECTORY' };

      const dirNameCheck = validateSingleFolderName(body.localDirName || defaultDirName, 'localDirName');
      if (!dirNameCheck.ok) {
        return { ok: false, statusCode: 400, error: dirNameCheck.error, message: dirNameCheck.message };
      }
      targetDir = path.join(realParent, dirNameCheck.value);
      if (isForbiddenSystemRoot(targetDir)) return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
      dirExistedBefore = fs.existsSync(targetDir);
      if (dirExistedBefore) {
        try {
          const items = fs.readdirSync(targetDir);
          if (items.length > 0 || mode === 'gdrive_mount_mkdir') {
            return { ok: false, statusCode: 409, error: 'TARGET_DIR_EXISTS', targetDir };
          }
        } catch {
          return { ok: false, statusCode: 409, error: 'TARGET_DIR_EXISTS', targetDir };
        }
      }
    }

    if (checkDuplicateProjectFn) {
      const dup = checkDuplicateProjectFn(targetDir);
      if (dup) {
        return { ok: false, statusCode: 409, error: 'PROJECT_ALREADY_EXISTS', project: dup };
      }
    }

    const jobId = `pjob_${crypto.randomBytes(8).toString('hex')}`;
    const nowIso = new Date().toISOString();
    const job = {
      jobId,
      provider,
      mode,
      projectName,
      localDirName: path.basename(targetDir),
      groupId,
      targetDir,
      createdTargetDir: dirExistedBefore ? null : targetDir,
      remoteCreated: null,
      status: 'running',
      step: 'validating',
      error: null,
      message: null,
      project: null,
      startedAt: nowIso,
      updatedAt: nowIso,
      elapsedMs: 0,
      _startedAtMs: Date.now(),
      _realParent: realParent
    };
    jobs.set(jobId, job);
    pruneOldJobs();
    emitJob(job);

    void runJobAsync(job, body);

    return {
      ok: true,
      statusCode: 202,
      jobId,
      job: serializeJob(job)
    };
  }

  function getJob(jobId) {
    const cleanId = String(jobId || '').trim();
    const job = jobs.get(cleanId);
    if (!job) {
      return { ok: false, statusCode: 404, error: 'JOB_NOT_FOUND' };
    }
    if (job.status === 'running') {
      job.elapsedMs = Math.max(0, Date.now() - job._startedAtMs);
    }
    return {
      ok: true,
      job: serializeJob(job)
    };
  }

  function cancelJob(jobId) {
    const cleanId = String(jobId || '').trim();
    const job = jobs.get(cleanId);
    if (!job) {
      return { ok: false, statusCode: 404, error: 'JOB_NOT_FOUND' };
    }
    if (job.status === 'running') {
      job.status = 'cancelled';
      job.step = 'cancelled';
      job.error = 'JOB_CANCELLED';
      const child = activeProcesses.get(cleanId);
      if (child) {
        try { child.kill('SIGTERM'); } catch {}
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, CANCEL_KILL_GRACE_MS);
        timer.unref?.();
        activeProcesses.delete(cleanId);
      }
      cleanupCreatedTargetDir(job);
      emitJob(job);
    }
    return {
      ok: true,
      jobId: cleanId,
      cancelled: true,
      job: serializeJob(job)
    };
  }

  function dispose() {
    for (const [jid, child] of activeProcesses.entries()) {
      try { child.kill('SIGKILL'); } catch {}
      const job = jobs.get(jid);
      if (job && job.status === 'running') {
        job.status = 'cancelled';
        cleanupCreatedTargetDir(job);
      }
    }
    activeProcesses.clear();
  }

  return {
    preflight,
    listGithubRepos,
    startJob,
    getJob,
    cancelJob,
    dispose
  };
}

module.exports = {
  createRemoteProjectProvisioner,
  validateSafeCliArg,
  validateSingleFolderName,
  resolveGithubCloneSpec,
  parseGhAuthOutput,
  parseRcloneRemotes
};
