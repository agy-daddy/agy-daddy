'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const url = require('node:url');

const {
  LOG_TAIL_MAX_BYTES,
  truncateUtf8Tail,
  createTaskManager
} = require('../src/task-manager');

test('truncateUtf8Tail truncates >64KB logs safely without producing U+FFFD replacement chars', () => {
  const small = truncateUtf8Tail('hello 世界', 65536);
  assert.equal(small.truncated, false);
  assert.equal(small.logText, 'hello 世界');

  // Construct >64KB string with 3-byte CJK & 4-byte emoji characters across boundary
  const unit = '日志输出🚀测试';
  const big = unit.repeat(6000);
  const res = truncateUtf8Tail(big, LOG_TAIL_MAX_BYTES);
  assert.equal(res.truncated, true);
  assert.ok(res.totalBytes > LOG_TAIL_MAX_BYTES);
  assert.ok(res.retainedBytes <= LOG_TAIL_MAX_BYTES);
  assert.equal(res.logText.includes('\uFFFD'), false);
  assert.equal(Buffer.byteLength(res.logText, 'utf8'), res.retainedBytes);
});

test('taskManager aggregates 3 sources and implements honest idempotent stopTask', async () => {
  const rpcCalls = [];
  const adapterCalls = [];
  let cmdRunning = true;
  let sessionRunning = true;
  let ptyClosedCount = 0;
  let ptyAlive = true;

  const rpc = {
    async call(method, params) {
      rpcCalls.push({ method, params });
      if (method === 'GetCascadeTrajectorySteps') {
        if (params.cascadeId === 'cid-main') {
          return {
            steps: [
              {
                stepIndex: 0,
                type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
                status: cmdRunning ? 'CORTEX_STEP_STATUS_RUNNING' : 'CORTEX_STEP_STATUS_DONE',
                runCommand: {
                  commandLine: 'npm run dev',
                  cwd: '/repo',
                  combinedOutput: '日志输出'.repeat(10000),
                  exitCode: cmdRunning ? null : 0
                }
              },
              {
                stepIndex: 1,
                type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
                status: 'CORTEX_STEP_STATUS_PENDING',
                runCommand: {
                  proposedCommandLine: 'rm -rf dist',
                  cwd: '/repo',
                  combinedOutput: ''
                }
              }
            ]
          };
        }
        return { steps: [] };
      }
      if (method === 'CancelCascadeSteps') {
        throw new Error('UNIMPLEMENTED');
      }
      return {};
    }
  };

  const harnessAdapter = {
    async listSessions() {
      return {
        sessions: [
          {
            cascadeId: 'cid-main',
            title: 'Main Task',
            status: sessionRunning ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
            isSubagent: false,
            createdTime: '2026-11-25T10:00:00Z',
            lastModifiedTime: '2026-11-25T10:01:00Z'
          },
          {
            cascadeId: 'cid-sub',
            title: 'Subagent Worker',
            status: 'CASCADE_RUN_STATUS_RUNNING',
            isSubagent: true,
            createdTime: '2026-11-25T10:00:10Z',
            lastModifiedTime: '2026-11-25T10:01:10Z'
          }
        ]
      };
    },
    async approveStep(cid, stepIdx, decision) {
      adapterCalls.push({ fn: 'approveStep', cid, stepIdx, decision });
      return { ok: true };
    },
    async cancelSession(cid) {
      adapterCalls.push({ fn: 'cancelSession', cid });
      if (cid === 'cid-main') sessionRunning = false;
      return { ok: true };
    }
  };

  const ptyManager = {
    listAllForTasks() {
      return {
        active: ptyAlive ? [{
          sessionId: 'pty-1',
          title: '#1 · repo',
          shell: 'zsh',
          cwd: '/repo',
          alive: true,
          createdAt: Date.now() - 1000,
          lastActivityAt: Date.now(),
          logSnapshot: 'zsh> ready\n'
        }] : [],
        recentClosed: ptyAlive ? [] : [{
          sessionId: 'pty-1',
          title: '#1 · repo',
          shell: 'zsh',
          cwd: '/repo',
          alive: false,
          finalStatus: 'done',
          exitCode: 0,
          createdAt: Date.now() - 2000,
          endedAt: Date.now() - 100,
          logSnapshot: 'zsh> ready\nexit\n'
        }]
      };
    },
    closeSession(id) {
      if (id === 'pty-1' && ptyAlive) {
        ptyAlive = false;
        ptyClosedCount += 1;
        return { ok: true, closed: true };
      }
      return { ok: true, closed: false, alreadyClosed: true };
    },
    getTaskSnapshot() {
      return {
        sessionId: 'pty-1',
        status: ptyAlive ? 'running' : 'done',
        exitCode: ptyAlive ? null : 0
      };
    }
  };

  const mgr = createTaskManager({ rpc, harnessAdapter, ptyManager });

  const listed = await mgr.listTasks();
  assert.equal(listed.ok, true);
  assert.equal(listed.runningCount, 5);
  assert.ok(listed.running.some((t) => t.taskId === 'pty:pty-1' && t.stopCapability.requiredPermission === 'L2'));
  assert.ok(listed.running.some((t) => t.taskId === 'session:cid-sub' && t.kind === 'subagent'));
  const runningCmd = listed.running.find((t) => t.taskId === 'cmd:cid-main:0');
  assert.equal(runningCmd.stopCapability.stopScope, 'cascade_invocation');
  assert.equal(runningCmd.stopCapability.requiredPermission, 'L1');
  const pendingCmd = listed.running.find((t) => t.taskId === 'cmd:cid-main:1');
  assert.equal(pendingCmd.stopCapability.stopScope, 'step_approval_deny');

  // Detail truncates >64KB CJK output cleanly
  const detail = await mgr.getTaskDetail('cmd:cid-main:0');
  assert.equal(detail.ok, true);
  assert.equal(detail.task.truncated, true);
  assert.equal(detail.task.logText.includes('\uFFFD'), false);

  // Stop pending command -> approveStep('deny')
  const stopPending = await mgr.stopTask('cmd:cid-main:1');
  assert.equal(stopPending.ok, true);
  assert.equal(stopPending.alreadyFinished, false);
  assert.equal(adapterCalls.at(-1).fn, 'approveStep');
  assert.equal(adapterCalls.at(-1).decision, 'deny');

  // Stop running command -> CancelCascadeSteps throws -> fallback CancelCascadeInvocation
  const stopCmd = await mgr.stopTask('cmd:cid-main:0');
  assert.equal(stopCmd.ok, true);
  assert.equal(stopCmd.alreadyFinished, false);
  assert.ok(rpcCalls.some((c) => c.method === 'CancelCascadeSteps'));
  assert.equal(adapterCalls.at(-1).fn, 'cancelSession');

  // Stop PTY -> L2 closeSession
  const stopPty = await mgr.stopTask('pty:pty-1');
  assert.equal(stopPty.ok, true);
  assert.equal(stopPty.alreadyFinished, false);
  assert.equal(ptyClosedCount, 1);

  // Idempotent stop when already finished -> 200 alreadyFinished: true
  cmdRunning = false;
  mgr.invalidateCache();
  const stopAlready = await mgr.stopTask('cmd:cid-main:0');
  assert.equal(stopAlready.ok, true);
  assert.equal(stopAlready.alreadyFinished, true);
  assert.equal(stopAlready.status, 'done');
});

test('HUB-314: taskManager bounds step-scan concurrency, applies short timeout without getSessionDetail fallback, and reuses adapter step cache', async () => {
  let activeScans = 0;
  let maxConcurrentScans = 0;
  let getSessionDetailCalled = 0;
  const rpcCalls = [];

  const sessions = Array.from({ length: 6 }, (_, i) => ({
    cascadeId: `cid-${i}`,
    title: `Session ${i}`,
    status: 'CASCADE_RUN_STATUS_RUNNING',
    workspaceUri: `file:///work/proj-${i % 2}`,
    createdTime: `2026-11-26T10:0${i}:00Z`,
    lastModifiedTime: `2026-11-26T10:1${i}:00Z`
  }));

  const rpc = {
    async call(method, params, opts) {
      rpcCalls.push({ method, params, opts });
      if (method === 'GetCascadeTrajectorySteps') {
        activeScans += 1;
        maxConcurrentScans = Math.max(maxConcurrentScans, activeScans);
        try {
          if (params.cascadeId === 'cid-5') {
            return await new Promise(() => {}); // Hang on last session cid-5 to verify bounded short timeout without skewing inflight counter
          }
          await new Promise((r) => setTimeout(r, 15));
          return {
            steps: [
              {
                stepIndex: 0,
                type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
                status: 'CORTEX_STEP_STATUS_RUNNING',
                runCommand: { commandLine: `echo ${params.cascadeId}`, cwd: `/work/proj-${Number(params.cascadeId.split('-')[1]) % 2}` }
              }
            ]
          };
        } finally {
          activeScans -= 1;
        }
      }
      return {};
    }
  };

  const harnessAdapter = {
    async listSessions() {
      return { sessions };
    },
    getCachedSessionSteps(cid) {
      if (cid === 'cid-0') {
        return [
          {
            stepIndex: 0,
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_RUNNING',
            runCommand: { commandLine: 'cached-cmd', cwd: '/work/proj-0' }
          }
        ];
      }
      return null;
    },
    hasActiveDetailRequest() {
      return false;
    },
    async getSessionDetail() {
      getSessionDetailCalled += 1;
      return { ok: true, session: {}, events: [] };
    }
  };

  const mgr = createTaskManager({
    rpc,
    harnessAdapter,
    stepScanConcurrency: 2,
    stepScanTimeoutMs: 60,
    foregroundDeferMs: 0
  });

  const startedAt = Date.now();
  const res = await mgr.listTasks();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(res.ok, true);
  assert.ok(elapsedMs < 500, `Scan should fail fast on hung session, took ${elapsedMs}ms`);
  assert.ok(maxConcurrentScans <= 2, `Expected concurrency <= 2, observed ${maxConcurrentScans}`);
  assert.equal(getSessionDetailCalled, 0, 'Must not fall back to heavy getSessionDetail when rpc is available');
  assert.equal(rpcCalls.some((c) => c.params.cascadeId === 'cid-0'), false, 'Should reuse adapter step cache for cid-0');
  assert.ok(rpcCalls.every((c) => c.opts && c.opts.retryOnTimeout === false));
  assert.ok(res.running.some((t) => t.taskId === 'cmd:cid-0:0' && t.commandLine === 'cached-cmd'));
});

test('HUB-314: taskManager resolves projectPath/projectName, filters before RECENT_TASKS_LIMIT, and computes global filters + totalRunningCount', async () => {
  const alphaRoot = path.resolve('/work/alpha-repo');
  const betaRoot = path.resolve('/work/beta-repo');
  const standaloneRoot = path.resolve('/work/standalone-default');
  const alphaUri = url.pathToFileURL(alphaRoot).href;
  const betaUri = url.pathToFileURL(betaRoot).href;

  // Build 25 historical idle sessions so proj-alpha's session sits beyond top 20 recent slice
  const sessions = [];
  for (let i = 0; i < 25; i++) {
    const isAlpha = i === 24;
    const min = String(59 - i).padStart(2, '0');
    sessions.push({
      cascadeId: isAlpha ? 'cid-alpha-old' : `cid-beta-${i}`,
      title: isAlpha ? 'Alpha Old Task' : `Beta Task ${i}`,
      status: i === 0 ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
      workspaceUri: isAlpha ? alphaUri : betaUri,
      createdTime: `2026-11-26T09:${min}:00Z`,
      lastModifiedTime: `2026-11-26T09:${min}:30Z`
    });
  }

  const workspaceMetaStore = {
    getState() {
      return { defaultSessionPath: standaloneRoot };
    },
    listProjectsAndGroups() {
      return {
        projects: [
          { id: 'p-alpha', name: 'Alpha Project', rootPath: alphaRoot },
          { id: 'p-beta', name: 'Beta Project', rootPath: betaRoot }
        ],
        groups: []
      };
    }
  };

  const ptyManager = {
    listAllForTasks() {
      return {
        active: [
          {
            sessionId: 'pty-alpha',
            title: 'Alpha Dev Server',
            shell: 'zsh',
            cwd: path.join(alphaRoot, 'packages', 'api'),
            alive: true,
            createdAt: Date.parse('2026-11-26T10:00:00Z'),
            lastActivityAt: Date.parse('2026-11-26T10:00:05Z'),
            logSnapshot: 'listening'
          }
        ],
        recentClosed: []
      };
    }
  };

  const harnessAdapter = {
    async listSessions() {
      return { sessions };
    }
  };
  const rpc = {
    async call(method) {
      if (method === 'GetCascadeTrajectorySteps') return { steps: [] };
      return {};
    }
  };

  const mgr = createTaskManager({ rpc, harnessAdapter, ptyManager, workspaceMetaStore });

  // 1. Unfiltered returns totalRunningCount=2, recent capped at 20, and filters covering all 26 tasks
  const allRes = await mgr.listTasks();
  assert.equal(allRes.ok, true);
  assert.equal(allRes.runningCount, 2);
  assert.equal(allRes.totalRunningCount, 2);
  assert.equal(allRes.recent.length, 20);
  assert.equal(allRes.filters.projects.length, 2);
  const alphaFilterProj = allRes.filters.projects.find((p) => p.path === alphaRoot);
  const betaFilterProj = allRes.filters.projects.find((p) => p.path === betaRoot);
  assert.equal(alphaFilterProj.name, 'Alpha Project');
  assert.equal(alphaFilterProj.count, 2); // 1 PTY (nested cwd mapped to root) + 1 old session
  assert.equal(betaFilterProj.name, 'Beta Project');
  assert.equal(betaFilterProj.count, 24);
  assert.equal(allRes.filters.sessions.length, 25);

  // 2. Filter by project finds old Alpha session beyond top 20 AND Alpha PTY with nested cwd
  const alphaOnly = await mgr.listTasks({ project: `${alphaUri}/` });
  assert.equal(alphaOnly.runningCount, 1);
  assert.equal(alphaOnly.totalRunningCount, 2, 'Global running count must stay intact while filtered');
  assert.equal(alphaOnly.running[0].taskId, 'pty:pty-alpha');
  assert.equal(alphaOnly.running[0].projectPath, alphaRoot);
  assert.equal(alphaOnly.running[0].projectName, 'Alpha Project');
  assert.equal(alphaOnly.recent.length, 1);
  assert.equal(alphaOnly.recent[0].taskId, 'session:cid-alpha-old');
  assert.equal(alphaOnly.filters.projects.length, 2, 'filters must remain based on all tasks');
  assert.equal(alphaOnly.filters.sessions.length, 25);

  // 3. Combined sessionId + project filter
  const comboHit = await mgr.listTasks({ sessionId: 'cid-alpha-old', project: alphaRoot });
  assert.equal(comboHit.runningCount, 0);
  assert.equal(comboHit.totalRunningCount, 2);
  assert.equal(comboHit.recent.length, 1);
  assert.equal(comboHit.recent[0].sessionId, 'cid-alpha-old');

  const comboMiss = await mgr.listTasks({ sessionId: 'cid-alpha-old', project: betaRoot });
  assert.equal(comboMiss.running.length, 0);
  assert.equal(comboMiss.recent.length, 0);
  assert.equal(comboMiss.totalRunningCount, 2);
});

test('HUB-346: nested worktree subdirectory session does not shadow worktree root entry or drop worktreeId', async () => {
  const repoRoot = path.resolve('/work/hub346-repo');
  const nestedWt = path.join(repoRoot, '.worktrees', 'wt-inner');
  const nestedSubdir = path.join(nestedWt, 'src', 'sub');
  const wtId = 'wt_inner_001';

  const workspaceMetaStore = {
    getState() {
      return { defaultSessionPath: path.resolve('/work/standalone') };
    },
    listProjectsAndGroups() {
      return {
        projects: [
          {
            id: 'proj-main',
            name: 'Hub346 Repo',
            rootPath: repoRoot,
            isMultiWorktree: true,
            worktrees: [
              { worktreeId: 'wt_main_001', path: repoRoot, branch: 'main', displayLabel: 'main' },
              { worktreeId: wtId, path: nestedWt, branch: 'feat/inner', displayLabel: 'feat/inner' }
            ]
          }
        ],
        groups: []
      };
    }
  };

  const harnessAdapter = {
    async listSessions() {
      return {
        sessions: [
          {
            cascadeId: 'cid-subdir',
            title: 'Subdir Session',
            status: 'CASCADE_RUN_STATUS_IDLE',
            projectId: 'proj-main',
            projectName: 'Hub346 Repo',
            workspaceUri: url.pathToFileURL(nestedSubdir).href,
            createdTime: '2026-11-26T10:00:00Z',
            lastModifiedTime: '2026-11-26T10:01:00Z'
          }
        ]
      };
    }
  };

  const rpc = {
    async call(method) {
      if (method === 'GetCascadeTrajectorySteps') {
        return {
          steps: [
            {
              stepIndex: 0,
              type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
              status: 'CORTEX_STEP_STATUS_DONE',
              runCommand: {
                commandLine: 'npm test',
                cwd: nestedSubdir,
                exitCode: 0,
                combinedOutput: 'ok'
              }
            }
          ]
        };
      }
      return {};
    }
  };

  const mgr = createTaskManager({ rpc, harnessAdapter, workspaceMetaStore });
  const res = await mgr.listTasks();
  assert.equal(res.ok, true);

  const cmdTask = res.recent.find((t) => t.taskId === 'cmd:cid-subdir:0');
  assert.ok(cmdTask);
  assert.equal(cmdTask.projectPath, nestedWt);
  assert.equal(cmdTask.projectName, 'Hub346 Repo');
  assert.equal(cmdTask.worktreeId, wtId);
  assert.equal(cmdTask.worktreeBranch, 'feat/inner');

  const sessTask = res.recent.find((t) => t.taskId === 'session:cid-subdir');
  assert.ok(sessTask);
  assert.equal(sessTask.projectPath, nestedWt);
  assert.equal(sessTask.worktreeId, wtId);
});
