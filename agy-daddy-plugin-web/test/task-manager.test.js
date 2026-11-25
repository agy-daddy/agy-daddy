'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
