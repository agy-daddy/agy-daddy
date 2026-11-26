'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeStepStatus,
  normalizeStepToSessionEvent,
  normalizeSessionSummary,
  STEP_TYPE_MAPPERS,
  createHarnessAdapter
} = require('../src/harness-adapter');

const EXPECTED_STEP_TYPES = [
  'CORTEX_STEP_TYPE_USER_INPUT',
  'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
  'CORTEX_STEP_TYPE_RUN_COMMAND',
  'CORTEX_STEP_TYPE_VIEW_FILE',
  'CORTEX_STEP_TYPE_CODE_ACTION',
  'CORTEX_STEP_TYPE_ASK_QUESTION',
  'CORTEX_STEP_TYPE_SEARCH_WEB',
  'CORTEX_STEP_TYPE_CHECKPOINT',
  'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
  'CORTEX_STEP_TYPE_GENERIC',
  'CORTEX_STEP_TYPE_ERROR_MESSAGE'
];

function createMockRpc(handlers = {}) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      if (typeof handlers[method] === 'function') {
        return await handlers[method](params, calls);
      }
      if (handlers[method] !== undefined) {
        return handlers[method];
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    }
  };
}

test('B1: listSessions() 归一化摘要、按 lastModifiedTime 降序排序并提取工作区元数据', async () => {
  const rpc = createMockRpc({
    GetAllCascadeTrajectories: {
      trajectorySummaries: {
        'older-id': {
          summary: 'Older Probe',
          stepCount: 4,
          lastModifiedTime: '2026-11-23T10:00:00.000Z',
          createdTime: '2026-11-23T09:50:00.000Z',
          status: 'CASCADE_RUN_STATUS_IDLE',
          workspaces: [{
            workspaceFolderAbsoluteUri: 'file:///tmp/older-ws',
            gitRootAbsoluteUri: 'file:///tmp/older-ws',
            repository: { computedName: 'older-repo' },
            branchName: 'dev'
          }]
        },
        'newer-id': {
          annotations: { title: 'Newer Title' },
          summary: 'Newer Probe',
          stepCount: 2,
          lastModifiedTime: '2026-11-23T15:50:56.000Z',
          createdTime: '2026-11-23T15:50:51.000Z',
          status: 'CASCADE_RUN_STATUS_RUNNING',
          workspaces: [{
            workspaceFolderAbsoluteUri: 'file:///tmp/mock-workspace',
            gitRootAbsoluteUri: 'file:///tmp/mock-workspace',
            repository: { computedName: 'mock-workspace' },
            branchName: 'main'
          }]
        }
      }
    }
  });

  const adapter = createHarnessAdapter({ rpc });
  const res = await adapter.listSessions({ limit: 50 });

  assert.equal(res.ok, true);
  assert.equal(rpc.calls[0].method, 'GetAllCascadeTrajectories');
  assert.deepEqual(rpc.calls[0].params, {});
  assert.equal(res.sessions.length, 2);
  assert.equal(res.sessions[0].cascadeId, 'newer-id');
  assert.equal(res.sessions[0].title, 'Newer Title');
  assert.equal(res.sessions[0].summary, 'Newer Probe');
  assert.equal(res.sessions[0].status, 'CASCADE_RUN_STATUS_RUNNING');
  assert.equal(res.sessions[0].stepCount, 2);
  assert.equal(res.sessions[0].workspaceUri, 'file:///tmp/mock-workspace');
  assert.equal(res.sessions[0].gitRootUri, 'file:///tmp/mock-workspace');
  assert.equal(res.sessions[0].repoName, 'mock-workspace');
  assert.equal(res.sessions[0].branchName, 'main');
  assert.equal(res.sessions[0].createdTime, '2026-11-23T15:50:51.000Z');
  assert.equal(res.sessions[0].lastModifiedTime, '2026-11-23T15:50:56.000Z');
  assert.equal(res.sessions[0].workspaces.length, 1);

  assert.equal(res.sessions[1].cascadeId, 'older-id');
  assert.equal(res.sessions[1].title, 'Older Probe');

  const limited = await adapter.listSessions({ limit: 1 });
  assert.equal(limited.sessions.length, 1);
  assert.equal(limited.sessions[0].cascadeId, 'newer-id');
});

test('B2: normalizeStepStatus、STEP_TYPE_MAPPERS 全覆盖 11 种 Step、未知类型降级与 getSessionDetail', async () => {
  assert.equal(normalizeStepStatus('CORTEX_STEP_STATUS_DONE'), 'done');
  assert.equal(normalizeStepStatus('CORTEX_STEP_STATUS_GENERATING'), 'generating');
  assert.equal(normalizeStepStatus('CORTEX_STEP_STATUS_RUNNING'), 'running');
  assert.equal(normalizeStepStatus('CORTEX_STEP_STATUS_PENDING'), 'pending');
  assert.equal(normalizeStepStatus('CORTEX_STEP_STATUS_ERROR'), 'error');
  assert.equal(normalizeStepStatus('CORTEX_STEP_STATUS_CANCELED'), 'canceled');
  assert.equal(normalizeStepStatus('UNKNOWN_STATUS'), 'pending');
  assert.equal(normalizeStepStatus(null), 'pending');

  for (const stepType of EXPECTED_STEP_TYPES) {
    assert.ok(STEP_TYPE_MAPPERS[stepType], `Missing mapper for ${stepType}`);
  }

  const allSteps = [
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      status: 'CORTEX_STEP_STATUS_DONE',
      userInput: {
        items: [{ text: 'hello' }],
        userResponse: 'hello',
        activeUserState: { file: 'a.js' },
        userConfig: { mode: 'fast' },
        userAgentSpec: { role: 'user' },
        clientMessageId: 'cm-1'
      }
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_GENERATING',
      plannerResponse: {
        thinking: 'deep thought',
        messageId: 'msg-1',
        toolCalls: [{ id: 'tc-1', name: 'view_file' }],
        thinkingDuration: '1.2s',
        stopReason: 'STOP_REASON_END_TURN',
        response: 'raw resp',
        modifiedResponse: 'final resp'
      }
    },
    {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_DONE',
      runCommand: {
        commandLine: 'npm test',
        proposedCommandLine: 'npm test',
        cwd: '/tmp/ws',
        waitMsBeforeAsync: 5000,
        blocking: true,
        exitCode: 0,
        combinedOutput: 'PASS 12 tests',
        shellName: 'zsh'
      }
    },
    {
      type: 'CORTEX_STEP_TYPE_VIEW_FILE',
      status: 'CORTEX_STEP_STATUS_DONE',
      viewFile: {
        absolutePathUri: 'file:///tmp/ws/index.js',
        startLine: 1,
        endLine: 20,
        content: 'console.log(1);',
        lineRangeBytes: 15,
        numLines: 1,
        numBytes: 15
      }
    },
    {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_PENDING',
      codeAction: {
        actionSpec: { targetFile: 'src/app.js', description: 'edit app' },
        actionResult: { applied: false },
        diffStats: { additions: 5, deletions: 2 }
      }
    },
    {
      type: 'CORTEX_STEP_TYPE_ASK_QUESTION',
      status: 'CORTEX_STEP_STATUS_RUNNING',
      completedInteractions: [{ id: 'q1', answer: 'yes' }],
      askQuestion: {
        questions: [{ id: 'q1', question: 'Proceed?' }]
      }
    },
    {
      type: 'CORTEX_STEP_TYPE_SEARCH_WEB',
      status: 'CORTEX_STEP_STATUS_DONE',
      searchWeb: {
        query: 'node test runner',
        webDocuments: [{ url: 'https://nodejs.org', title: 'Node' }],
        summary: 'Node built-in test runner',
        thirdPartyConfig: { provider: 'web' },
        searchType: 'SEARCH_TYPE_WEB'
      }
    },
    {
      type: 'CORTEX_STEP_TYPE_CHECKPOINT',
      status: 'CORTEX_STEP_STATUS_DONE',
      checkpoint: {
        includedStepIndexEnd: 7,
        sessionSummary: 'Implemented adapter',
        artifactSnapshots: [{ name: 'plan.md' }],
        capturedUserRequests: ['build adapter'],
        totalSubagentCount: 1,
        accumulatedSections: ['sec1']
      }
    },
    {
      type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      status: 'CORTEX_STEP_STATUS_DONE',
      systemMessage: {
        message: 'Context compacted',
        renderInfo: { level: 'info' },
        eventType: 'COMPACT'
      }
    },
    {
      type: 'CORTEX_STEP_TYPE_GENERIC',
      status: 'CORTEX_STEP_STATUS_DONE',
      generic: {
        args: { foo: 'bar' },
        result: { ok: true }
      }
    },
    {
      type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
      status: 'CORTEX_STEP_STATUS_ERROR',
      errorMessage: {
        error: { message: 'Tool failed', code: 'E_FAIL' }
      }
    }
  ];

  const events = allSteps.map((s, i) => normalizeStepToSessionEvent(s, i));
  assert.equal(events.length, 11);
  assert.deepEqual(
    events.map((e) => e.kind),
    [
      'user',
      'thinking_and_text',
      'command',
      'file_view',
      'code_action',
      'ask_question',
      'web_search',
      'checkpoint',
      'system',
      'tool_generic',
      'error'
    ]
  );
  assert.equal(events[0].seq, 0);
  assert.equal(events[0].payload.clientMessageId, 'cm-1');
  assert.equal(events[1].status, 'generating');
  assert.equal(events[1].payload.thinking, 'deep thought');
  assert.equal(events[1].payload.toolCalls.length, 1);
  assert.equal(events[1].payload.modifiedResponse, 'final resp');
  assert.equal(events[2].payload.combinedOutput, 'PASS 12 tests');
  assert.equal(events[2].payload.exitCode, 0);
  assert.equal(events[2].payload.cwd, '/tmp/ws');
  assert.equal(events[3].payload.absolutePathUri, 'file:///tmp/ws/index.js');
  assert.deepEqual(events[4].payload.diffStats, { additions: 5, deletions: 2 });
  assert.equal(events[4].payload.actionSpec.targetFile, 'src/app.js');
  assert.deepEqual(events[4].payload.actionResult, { applied: false });
  assert.equal(events[5].payload.questions.length, 1);
  assert.equal(events[5].payload.completedInteractions.length, 1);
  assert.equal(events[6].payload.query, 'node test runner');
  assert.equal(events[6].payload.webDocuments.length, 1);
  assert.equal(events[6].payload.summary, 'Node built-in test runner');
  assert.equal(events[7].payload.artifactSnapshots.length, 1);
  assert.equal(events[7].payload.sessionSummary, 'Implemented adapter');
  assert.equal(events[8].payload.message, 'Context compacted');
  assert.deepEqual(events[9].payload.args, { foo: 'bar' });
  assert.deepEqual(events[10].payload.error, { message: 'Tool failed', code: 'E_FAIL' });

  // Unknown step type degrades gracefully
  const unknownEv = normalizeStepToSessionEvent({
    type: 'CORTEX_STEP_TYPE_FUTURE_MAGIC',
    status: 'CORTEX_STEP_STATUS_CANCELED',
    futureMagic: { x: 42 }
  }, 99);
  assert.equal(unknownEv.seq, 99);
  assert.equal(unknownEv.kind, 'tool_generic');
  assert.equal(unknownEv.status, 'canceled');
  assert.equal(unknownEv.rawType, 'CORTEX_STEP_TYPE_FUTURE_MAGIC');
  assert.ok(unknownEv.payload && typeof unknownEv.payload === 'object');

  // Null/empty step degrades without throwing
  const emptyEv = normalizeStepToSessionEvent(null, 5);
  assert.equal(emptyEv.seq, 5);
  assert.equal(emptyEv.kind, 'tool_generic');
  assert.equal(emptyEv.status, 'pending');

  // getSessionDetail
  const rpc = createMockRpc({
    GetCascadeTrajectory: {
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 2,
      trajectory: {
        trajectoryId: 'traj-1',
        cascadeId: 'cid-1',
        trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
        steps: allSteps.slice(0, 2)
      }
    }
  });
  const adapter = createHarnessAdapter({ rpc });
  const detail = await adapter.getSessionDetail('cid-1');
  assert.equal(rpc.calls[0].method, 'GetCascadeTrajectory');
  assert.deepEqual(rpc.calls[0].params, { cascadeId: 'cid-1' });
  assert.equal(detail.ok, true);
  assert.equal(detail.session.cascadeId, 'cid-1');
  assert.equal(detail.session.status, 'CASCADE_RUN_STATUS_IDLE');
  assert.equal(detail.session.numTotalSteps, 2);
  assert.equal(detail.events.length, 2);
  assert.equal(detail.events[0].kind, 'user');
  assert.equal(detail.events[1].kind, 'thinking_and_text');
});

test('B3: pollDelta() 增量拉取、非终态尾部指纹更新与 stepOffset 精确推进 (0 -> 1 -> 3)', async () => {
  let pollIdx = 0;
  const rpc = createMockRpc({
    GetCascadeTrajectorySteps: (params) => {
      pollIdx++;
      if (pollIdx === 1) {
        assert.equal(params.stepOffset, 0);
        return {
          status: 'CASCADE_RUN_STATUS_RUNNING',
          numTotalSteps: 2,
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: 'hi' } },
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_GENERATING', plannerResponse: { response: 'hel' } }
          ]
        };
      }
      if (pollIdx === 2) {
        assert.equal(params.stepOffset, 1);
        return {
          status: 'CASCADE_RUN_STATUS_RUNNING',
          numTotalSteps: 2,
          steps: [
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_GENERATING', plannerResponse: { response: 'hel' } }
          ]
        };
      }
      if (pollIdx === 3) {
        assert.equal(params.stepOffset, 1);
        return {
          status: 'CASCADE_RUN_STATUS_RUNNING',
          numTotalSteps: 2,
          steps: [
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_GENERATING', plannerResponse: { response: 'hello world' } }
          ]
        };
      }
      assert.equal(params.stepOffset, 1);
      return {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 3,
        steps: [
          { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'hello world!' } },
          { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_DONE', runCommand: { commandLine: 'ls', exitCode: 0 } }
        ]
      };
    }
  });

  const adapter = createHarnessAdapter({ rpc });

  // Poll 1: step[0]=DONE, step[1]=GENERATING -> emits 0,1; stepOffset=1
  const d1 = await adapter.pollDelta('cid-stream');
  assert.equal(d1.ok, true);
  assert.equal(d1.cascadeId, 'cid-stream');
  assert.equal(d1.stepOffset, 1);
  assert.equal(d1.totalSteps, 2);
  assert.equal(d1.hasChanges, true);
  assert.deepEqual(d1.events.map((e) => e.seq), [0, 1]);

  // Poll 2: step[1] unchanged -> emits nothing, stepOffset=1
  const d2 = await adapter.pollDelta('cid-stream');
  assert.equal(d2.stepOffset, 1);
  assert.equal(d2.hasChanges, false);
  assert.equal(d2.events.length, 0);

  // Poll 3: step[1] grows while GENERATING -> emits updated step[1], stepOffset=1
  const d3 = await adapter.pollDelta('cid-stream');
  assert.equal(d3.stepOffset, 1);
  assert.equal(d3.hasChanges, true);
  assert.equal(d3.events.length, 1);
  assert.equal(d3.events[0].seq, 1);
  assert.equal(d3.events[0].payload.response, 'hello world');

  // Poll 4: step[1]=DONE, step[2]=DONE -> emits 1,2; stepOffset=3
  const d4 = await adapter.pollDelta('cid-stream');
  assert.equal(d4.stepOffset, 3);
  assert.equal(d4.totalSteps, 3);
  assert.equal(d4.status, 'CASCADE_RUN_STATUS_IDLE');
  assert.equal(d4.hasChanges, true);
  assert.deepEqual(d4.events.map((e) => e.seq), [1, 2]);

  // resetSessionCursor resets offset back to 0
  adapter.resetSessionCursor('cid-stream');
  pollIdx = 0;
  const dReset = await adapter.pollDelta('cid-stream');
  assert.equal(dReset.stepOffset, 1);
  assert.deepEqual(dReset.events.map((e) => e.seq), [0, 1]);

  // PENDING/RUNNING 阻塞 stepOffset；ERROR/CANCELED 终态放行；afterSeq 显式偏移查询
  const edgeRpc = createMockRpc({
    GetCascadeTrajectorySteps: (params) => {
      if (params.stepOffset === 2) {
        return {
          status: 'CASCADE_RUN_STATUS_IDLE',
          numTotalSteps: 3,
          steps: [{ type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE', status: 'CORTEX_STEP_STATUS_ERROR', errorMessage: { error: 'boom' } }]
        };
      }
      return {
        numTotalSteps: 3,
        steps: [
          { type: 'CORTEX_STEP_TYPE_CODE_ACTION', status: 'CORTEX_STEP_STATUS_PENDING', codeAction: { diffStats: { additions: 1 } } },
          { type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_CANCELED', runCommand: { commandLine: 'sleep 1' } },
          { type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE', status: 'CORTEX_STEP_STATUS_ERROR', errorMessage: { error: 'boom' } }
        ]
      };
    }
  });
  const edgeAdapter = createHarnessAdapter({ rpc: edgeRpc });
  const pendingRes = await edgeAdapter.pollDelta('cid-edge');
  assert.equal(pendingRes.stepOffset, 0);
  assert.equal(pendingRes.status, 'CASCADE_RUN_STATUS_RUNNING');

  const afterRes = await edgeAdapter.pollDelta('cid-edge', { afterSeq: 1 });
  assert.equal(afterRes.events.length, 1);
  assert.equal(afterRes.events[0].seq, 2);
  assert.equal(afterRes.stepOffset, 3);
});

test('B4: createSession()、sendMessage()、cancelSession() 与 listModels() RPC 契约', async () => {
  const rpc = createMockRpc({
    StartCascade: () => ({ cascadeId: 'new-cid-123' }),
    SendUserCascadeMessage: () => ({}),
    CancelCascadeInvocation: () => ({}),
    GetUserStatus: () => ({
      userStatus: {
        cascadeModelConfigData: {
          defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_A' } },
          clientModelConfigs: [
            { label: 'Model A', modelOrAlias: { model: 'MODEL_A' }, quotaInfo: { remainingFraction: 0.8 } },
            { label: 'Model B', modelOrAlias: { model: 'MODEL_B' }, disabled: true, tagTitle: 'Unavailable' }
          ]
        }
      }
    }),
    GetAvailableModels: () => ({
      response: {
        defaultAgentModelId: 'MODEL_A',
        models: {
          MODEL_A: { model: 'MODEL_A', displayName: 'Model A Pro', maxTokens: 1000000 },
          MODEL_C: { model: 'MODEL_C', displayName: 'Model C Fast', maxTokens: 200000 }
        },
        groupedModels: [{ groupId: 'primary', modelIds: ['MODEL_A', 'MODEL_C'] }]
      }
    })
  });

  const adapter = createHarnessAdapter({ rpc });

  // createSession mandatory source & metadata + workspaceUris
  const created = await adapter.createSession({ title: 'Test', workspaceUri: 'file:///tmp/ws' });
  assert.equal(created.ok, true);
  assert.equal(created.cascadeId, 'new-cid-123');
  assert.equal(created.workspaceUri, 'file:///tmp/ws');
  assert.equal(rpc.calls[0].method, 'StartCascade');
  assert.equal(rpc.calls[0].params.source, 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT');
  assert.deepEqual(rpc.calls[0].params.metadata, { ideName: 'antigravity', extensionName: 'antigravity' });
  assert.deepEqual(rpc.calls[0].params.workspaceUris, ['file:///tmp/ws']);

  // sendMessage validates non-empty text
  await assert.rejects(() => adapter.sendMessage('new-cid-123', { text: '   ' }));
  await assert.rejects(() => adapter.sendMessage('new-cid-123', {}));

  // sendMessage with modelId
  const sentWithModel = await adapter.sendMessage('new-cid-123', { text: 'PROBE_OK', modelId: 'MODEL_PLACEHOLDER_M318' });
  assert.equal(sentWithModel.ok, true);
  assert.equal(sentWithModel.cascadeId, 'new-cid-123');
  const sendCall1 = rpc.calls.find((c) => c.method === 'SendUserCascadeMessage');
  assert.deepEqual(sendCall1.params, {
    cascadeId: 'new-cid-123',
    items: [{ text: 'PROBE_OK' }],
    metadata: { ideName: 'antigravity', extensionName: 'antigravity' },
    cascadeConfig: { plannerConfig: { requestedModel: { model: 'MODEL_PLACEHOLDER_M318' } } }
  });

  // sendMessage without modelId omits cascadeConfig
  const sentNoModel = await adapter.sendMessage('new-cid-123', { text: 'plain msg' });
  assert.equal(sentNoModel.ok, true);
  const sendCalls = rpc.calls.filter((c) => c.method === 'SendUserCascadeMessage');
  assert.equal(sendCalls[1].params.cascadeConfig, undefined);

  // cancelSession
  const canceled = await adapter.cancelSession('new-cid-123');
  assert.equal(canceled.ok, true);
  assert.equal(canceled.cascadeId, 'new-cid-123');
  const cancelCall = rpc.calls.find((c) => c.method === 'CancelCascadeInvocation');
  assert.deepEqual(cancelCall.params, { cascadeId: 'new-cid-123' });

  // listModels
  const modelsRes = await adapter.listModels();
  assert.equal(modelsRes.ok, true);
  assert.equal(modelsRes.defaultModelId, 'MODEL_A');
  assert.ok(Array.isArray(modelsRes.models));
  assert.ok(modelsRes.models.some((m) => m.id === 'MODEL_A' && m.maxTokens === 1000000));
  assert.ok(modelsRes.models.some((m) => m.id === 'MODEL_C' && m.displayName === 'Model C Fast'));
  assert.ok(Array.isArray(modelsRes.groups));
  assert.equal(modelsRes.groups.length, 1);

  // sendMessage with attachments
  await adapter.sendMessage('new-cid-123', { text: 'with att', attachments: [{ text: '@file.js' }] });
  const sendWithAtt = rpc.calls.filter((c) => c.method === 'SendUserCascadeMessage')[2];
  assert.deepEqual(sendWithAtt.params.items, [{ text: 'with att' }, { text: '@file.js' }]);

  // listModels partial degradation & both-fail rejection
  const partialRpc = createMockRpc({
    GetUserStatus: () => { throw new Error('UserStatus unavailable'); },
    GetAvailableModels: () => ({ defaultAgentModelId: 'M1', models: [{ model: 'M1', displayName: 'M1' }] })
  });
  const partialModels = await createHarnessAdapter({ rpc: partialRpc }).listModels();
  assert.equal(partialModels.ok, true);
  assert.equal(partialModels.defaultModelId, 'M1');
  assert.equal(partialModels.models.length, 1);

  const deadRpc = createMockRpc({});
  await assert.rejects(() => createHarnessAdapter({ rpc: deadRpc }).listModels(), /Unexpected RPC method/);
});

test('B5: approveStep()、answerQuestion()、images 与 Plan/Chat 模式切换走 2.34.0 HandleCascadeUserInteraction（严禁调用 AcceptCascadeStep）', async () => {
  const rpc = createMockRpc({
    GetCascadeTrajectory: () => ({
      trajectory: {
        trajectoryId: 'traj-234',
        steps: [
          {
            stepIndex: 0,
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            status: 'CORTEX_STEP_STATUS_DONE'
          },
          {
            stepIndex: 1,
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_PENDING',
            sourceTrajectoryStepInfo: { trajectoryId: 'traj-inner', stepIndex: 11 },
            requestedInteraction: {
              interaction: {
                permission: { scope: 'PERMISSION_SCOPE_ONCE' }
              }
            }
          },
          {
            stepIndex: 2,
            type: 'CORTEX_STEP_TYPE_ASK_QUESTION',
            status: 'CORTEX_STEP_STATUS_PENDING',
            askQuestion: {
              questions: [
                { question: 'Deploy target?', options: [{ id: 'staging', text: 'Staging' }, { id: 'prod', text: 'Prod' }] }
              ]
            }
          }
        ]
      }
    }),
    HandleCascadeUserInteraction: () => ({}),
    SendUserCascadeMessage: () => ({})
  });
  const adapter = createHarnessAdapter({ rpc });

  const approveRes = await adapter.approveStep('cid-1', 1, 'allow');
  assert.equal(approveRes.ok, true);
  assert.equal(approveRes.supported, true);
  assert.equal(approveRes.interactionType, 'permission');
  const interactCall = rpc.calls.find((c) => c.method === 'HandleCascadeUserInteraction');
  assert.deepEqual(interactCall.params, {
    cascadeId: 'cid-1',
    interaction: {
      trajectoryId: 'traj-inner',
      stepIndex: 11,
      permission: { allow: true, scope: 'PERMISSION_SCOPE_ONCE' }
    }
  });

  const answerRes = await adapter.answerQuestion('cid-1', 2, [
    { index: 0, question: 'Deploy target?', answer: 'Staging' }
  ]);
  assert.equal(answerRes.ok, true);
  const answerCall = rpc.calls.filter((c) => c.method === 'HandleCascadeUserInteraction')[1];
  assert.equal(answerCall.params.interaction.trajectoryId, 'traj-234');
  assert.equal(answerCall.params.interaction.stepIndex, 2);
  assert.deepEqual(answerCall.params.interaction.askQuestion.responses[0].selectedOptionIds, ['staging']);

  await adapter.sendMessage('cid-1', { text: 'plan only', mode: 'plan' });
  const planMsg = rpc.calls.find((c) => c.method === 'SendUserCascadeMessage');
  assert.deepEqual(planMsg.params.cascadeConfig, {
    plannerConfig: {
      conversational: {
        plannerMode: 'CONVERSATIONAL_PLANNER_MODE_READ_ONLY',
        agenticMode: false
      }
    }
  });

  await adapter.sendMessage('cid-1', {
    images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }]
  });
  const imgMsg = rpc.calls.filter((c) => c.method === 'SendUserCascadeMessage')[1];
  assert.deepEqual(imgMsg.params.items, []);
  assert.deepEqual(imgMsg.params.images, [{ mimeType: 'image/png', inlineData: 'iVBORw0KGgo=' }]);

  assert.equal(rpc.calls.some((c) => c.method === 'AcceptCascadeStep'), false);
});

test('B6: 无标题会话不回退裸 UUID，listModels() 过滤内部模型并构建 2.34.0 App 级联树', async () => {
  const rpc = createMockRpc({
    GetAllCascadeTrajectories: {
      trajectorySummaries: {
        '1050fb4f-4c80-4df1-ac7d-d640eb91ddf5': {
          stepCount: 36,
          lastModifiedTime: '2026-11-24T01:00:00Z',
          status: 'CASCADE_RUN_STATUS_IDLE',
          workspaces: [{ repository: { computedName: 'agy-daddy/agy-daddy' }, branchName: 'main' }]
        }
      }
    },
    GetUserStatus: {
      userStatus: {
        cascadeModelConfigData: {
          defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M533' } },
          clientModelConfigs: [
            {
              label: 'Gemini 4 Neon (High)',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' },
              modelId: 'gemini-4-neon-high',
              tagTitle: 'New',
              tagDescription: 'Deep reasoning',
              quotaInfo: { remainingFraction: 0.9 }
            },
            {
              label: 'Gemini 4 Neon (Medium)',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M533' },
              modelId: 'gemini-4-neon-medium',
              tagTitle: 'New'
            },
            {
              label: 'Orchestrator (Neon)',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M537' },
              modelId: 'gemini-pro-orchestrator-neon',
              tagTitle: 'New'
            },
            {
              label: 'Orchestrator (Carbon)',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M667' },
              modelId: 'gemini-pro-orchestrator',
              tagTitle: 'New'
            },
            {
              label: 'Orchestrator (Argon)',
              modelOrAlias: { model: 'MODEL_PLACEHOLDER_M681' },
              modelId: 'gemini-pro-orchestrator-argon',
              tagTitle: 'New'
            },
            {
              label: 'GPT-OSS 120B (Medium)',
              modelOrAlias: { model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM' },
              modelId: 'gpt-oss-120b-medium',
              tagTitle: 'Notice',
              tagDescription: 'Removed Nov 30'
            }
          ],
          groupedModels: {
            'gemini-4-neon': {
              displayName: 'Gemini 4 Neon',
              supportedThinkingLevels: [
                { thinkingSuffix: 'medium', thinkingDisplayName: 'Medium' },
                { thinkingSuffix: 'high', thinkingDisplayName: 'High' }
              ]
            }
          },
          clientModelSorts: [
            {
              name: 'Recommended',
              groups: [
                {
                  modelLabels: [
                    'Gemini 4 Neon (High)',
                    'Gemini 4 Neon (Medium)',
                    'Orchestrator (Neon)',
                    'Orchestrator (Carbon)',
                    'Orchestrator (Argon)',
                    'GPT-OSS 120B (Medium)'
                  ]
                }
              ]
            }
          ]
        }
      }
    },
    GetAvailableModels: {
      response: {
        models: {
          'gemini-4-neon-high': { model: 'MODEL_PLACEHOLDER_M532', displayName: 'Gemini 4 Neon (High)', maxTokens: 1048576 },
          'gemini-4-neon-medium': { model: 'MODEL_PLACEHOLDER_M533', displayName: 'Gemini 4 Neon (Medium)', maxTokens: 1048576 },
          'tab_flash_lite_preview': { model: 'MODEL_PLACEHOLDER_M19', maxTokens: 32000 },
          'gemini-4-hydrogen-sonar': { model: 'MODEL_PLACEHOLDER_M578', maxTokens: 32000 },
          'gemini-3.8-flash-tiered': { model: 'MODEL_PLACEHOLDER_M322', maxTokens: 32000 },
          'gemini-flash-worker-agy': { model: 'MODEL_PLACEHOLDER_M669', displayName: 'Gemini 4 Hydrogen (Orchestrator)' }
        }
      }
    }
  });

  const adapter = createHarnessAdapter({ rpc });
  const sessionsRes = await adapter.listSessions();
  assert.equal(sessionsRes.sessions.length, 1);
  assert.equal(sessionsRes.sessions[0].title, '');
  assert.equal(sessionsRes.sessions[0].hasTitle, false);
  assert.equal(sessionsRes.sessions[0].titleSource, 'none');
  assert.equal(sessionsRes.sessions[0].shortId, '1050fb4f');

  const modelsRes = await adapter.listModels();
  const ids = modelsRes.models.map((m) => m.id);
  assert.equal(ids.includes('MODEL_PLACEHOLDER_M19'), false);
  assert.equal(ids.includes('MODEL_PLACEHOLDER_M578'), false);
  assert.equal(ids.includes('MODEL_PLACEHOLDER_M322'), false);
  assert.equal(ids.includes('MODEL_PLACEHOLDER_M669'), false);
  assert.equal(modelsRes.models.length, 6);

  assert.equal(modelsRes.tree.supportsCustomOrchestrator, true);
  assert.equal(modelsRes.tree.defaultSelectionKey, 'family/gemini-4-neon/medium');
  assert.equal(modelsRes.tree.nodes.length, 3);

  const [neonFamily, orchBranch, gptLeaf] = modelsRes.tree.nodes;
  assert.equal(neonFamily.kind, 'branch');
  assert.equal(neonFamily.role, 'family');
  assert.equal(neonFamily.label, 'Gemini 4 Neon');
  assert.equal(neonFamily.children.length, 2);
  assert.equal(neonFamily.children[0].selection.requestedModel, 'MODEL_PLACEHOLDER_M533');

  assert.equal(orchBranch.kind, 'branch');
  assert.equal(orchBranch.role, 'orchestrator_root');
  assert.equal(orchBranch.label, 'Orchestrator');
  assert.equal(orchBranch.secondaryLabel, 'Gemini 4 Neon High');
  assert.equal(orchBranch.children.length, 3);
  assert.deepEqual(
    orchBranch.children.map((c) => c.selection),
    [
      {
        mode: 'orchestrator_preset',
        requestedModel: 'MODEL_PLACEHOLDER_M537',
        modelId: 'gemini-pro-orchestrator-neon',
        plannerFamilyId: 'gemini-4-neon',
        executorFamilyId: 'gemini-4-hydrogen',
        plannerThinkingSuffix: 'high'
      },
      {
        mode: 'orchestrator_preset',
        requestedModel: 'MODEL_PLACEHOLDER_M667',
        modelId: 'gemini-pro-orchestrator',
        plannerFamilyId: 'gemini-4-carbon',
        executorFamilyId: 'gemini-4-hydrogen',
        plannerThinkingSuffix: 'high'
      },
      {
        mode: 'orchestrator_preset',
        requestedModel: 'MODEL_PLACEHOLDER_M681',
        modelId: 'gemini-pro-orchestrator-argon',
        plannerFamilyId: 'gemini-4-argon',
        executorFamilyId: 'gemini-4-hydrogen',
        plannerThinkingSuffix: 'high'
      }
    ]
  );

  assert.equal(gptLeaf.kind, 'leaf');
  assert.equal(gptLeaf.label, 'GPT-OSS 120B (Medium)');
  assert.equal(gptLeaf.badge.kind, 'notice');

  // Slug defaultAgentModelId resolves to canonical MODEL_PLACEHOLDER_* enum
  const slugDefaultRpc = createMockRpc({
    GetUserStatus: {
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Gemini 4 Neon (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' }, modelId: 'gemini-4-neon-high' }
          ]
        }
      }
    },
    GetAvailableModels: {
      response: {
        defaultAgentModelId: 'gemini-4-neon-high',
        models: {
          'gemini-4-neon-high': { model: 'MODEL_PLACEHOLDER_M532', displayName: 'Gemini 4 Neon (High)' }
        }
      }
    }
  });
  const slugRes = await createHarnessAdapter({ rpc: slugDefaultRpc }).listModels();
  assert.equal(slugRes.defaultModelId, 'MODEL_PLACEHOLDER_M532');
  assert.equal(slugRes.models[0].isDefault, true);
});

test('静态门禁：harness-adapter.js 零外部依赖且不含禁用主题色', () => {
  const srcPath = path.resolve(__dirname, '../src/harness-adapter.js');
  const content = fs.readFileSync(srcPath, 'utf8');
  const forbidden = [
    /#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i,
    /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i, /#fb923c/i, /#c2410c/i
  ];
  for (const re of forbidden) {
    assert.equal(re.test(content), false, `Forbidden hex found: ${re}`);
  }
});

test('B7: createSession passes workspaceUris and fails fast without silent fallback when StartCascade rejects', async () => {
  const calls = [];
  const rpc = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'StartCascade' && Array.isArray(params.workspaceUris)) {
        if (params.workspaceUris[0] === 'file:///tmp/project-bad') {
          throw new Error('StartCascade unknown field workspaceUris');
        }
        return { cascadeId: 'scoped-cid-456' };
      }
      if (method === 'StartCascade') {
        return { cascadeId: 'plain-cid-123' };
      }
      throw new Error(`Unexpected: ${method}`);
    }
  };
  const adapter = createHarnessAdapter({ rpc });
  const res = await adapter.createSession({ title: 'Scoped', workspaceUri: 'file:///tmp/project-a' });
  assert.equal(res.ok, true);
  assert.equal(res.cascadeId, 'scoped-cid-456');
  assert.equal(res.title, 'Scoped');
  assert.equal(res.workspaceUri, 'file:///tmp/project-a');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params.workspaceUris, ['file:///tmp/project-a']);

  await assert.rejects(
    () => adapter.createSession({ title: 'Bad', workspaceUri: 'file:///tmp/project-bad' }),
    /StartCascade unknown field workspaceUris/
  );
  assert.equal(calls.length, 2);

  const plainRes = await adapter.createSession({ title: 'Plain' });
  assert.equal(plainRes.ok, true);
  assert.equal('workspaceUris' in calls[2].params, false);
  assert.equal('workspaceUri' in plainRes, false);
});

test('B8: tool_generic 提取有意义 toolName、紧凑 target hint 与 humanized rawType', () => {
  const findEv = normalizeStepToSessionEvent({
    type: 'CORTEX_STEP_TYPE_FIND_BY_NAME',
    status: 'CORTEX_STEP_STATUS_DONE',
    findByName: { directoryPath: '/repo/src', pattern: '*.js' }
  }, 1);
  assert.equal(findEv.kind, 'tool_generic');
  assert.equal(findEv.payload.toolName, 'Find By Name');
  assert.equal(findEv.title, 'Find By Name: /repo/src');

  const grepEv = normalizeStepToSessionEvent({
    type: 'CORTEX_STEP_TYPE_GREP_SEARCH',
    status: 'CORTEX_STEP_STATUS_DONE',
    grepSearch: { query: 'normalizeSessionSummary' }
  }, 2);
  assert.equal(grepEv.payload.toolName, 'Grep Search');
  assert.equal(grepEv.title, 'Grep Search: normalizeSessionSummary');

  const writeEv = normalizeStepToSessionEvent({
    type: 'CORTEX_STEP_TYPE_WRITE_TO_FILE',
    status: 'CORTEX_STEP_STATUS_DONE',
    writeToFile: { targetFile: 'src/workspace-meta-store.js' }
  }, 3);
  assert.equal(writeEv.payload.toolName, 'Write To File');
  assert.equal(writeEv.title, 'Write To File: src/workspace-meta-store.js');

  const listDirEv = normalizeStepToSessionEvent({
    type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY',
    status: 'CORTEX_STEP_STATUS_DONE',
    listDirectory: { directoryPath: '/tmp/workspace' }
  }, 4);
  assert.equal(listDirEv.payload.toolName, 'List Directory');
  assert.equal(listDirEv.title, 'List Directory: /tmp/workspace');

  const mcpEv = normalizeStepToSessionEvent({
    type: 'CORTEX_STEP_TYPE_MCP_TOOL',
    status: 'CORTEX_STEP_STATUS_DONE',
    mcpTool: { serverName: 'github', toolName: 'get_pull_request', path: 'pulls/42' }
  }, 5);
  assert.equal(mcpEv.payload.toolName, 'github/get_pull_request');
  assert.equal(mcpEv.title, 'github/get_pull_request: pulls/42');

  const genericNamedEv = normalizeStepToSessionEvent({
    type: 'CORTEX_STEP_TYPE_GENERIC',
    status: 'CORTEX_STEP_STATUS_DONE',
    generic: {
      serverName: 'linear',
      name: 'search_issues',
      args: { pattern: 'bug-*' }
    }
  }, 6);
  assert.equal(genericNamedEv.payload.toolName, 'linear/search_issues');
  assert.equal(genericNamedEv.title, 'linear/search_issues: bug-*');

  const actionEv = normalizeStepToSessionEvent({
    type: 'CORTEX_STEP_TYPE_GENERIC',
    status: 'CORTEX_STEP_STATUS_DONE',
    generic: {
      action: 'sync_index',
      absolutePathUri: 'file:///tmp/demo/index.ts'
    }
  }, 7);
  assert.equal(actionEv.payload.toolName, 'sync_index');
  assert.equal(actionEv.title, 'sync_index: /tmp/demo/index.ts');

  const mcpToolNameEv = normalizeStepToSessionEvent({
    type: 'CORTEX_STEP_TYPE_UNKNOWN_CALL',
    status: 'CORTEX_STEP_STATUS_DONE',
    mcpToolName: 'fetch_docs',
    toolName: 'tool'
  }, 8);
  assert.equal(mcpToolNameEv.payload.toolName, 'fetch_docs');
  assert.equal(mcpToolNameEv.title, 'fetch_docs');
});

test('B9: normalizeSessionSummary 保留顶层及 metadata 中的子代理与完成状态字段', () => {
  const fromTop = normalizeSessionSummary('cid-top', {
    title: 'Subagent Task',
    stepCount: 5,
    parentConversationId: 'parent-1',
    nestingDepth: 2,
    agentName: 'researcher',
    isSubagent: true,
    lastUserInputStepIndex: -1,
    notFullyIdle: true,
    killed: false,
    lastCompletedTime: '2026-11-24T04:00:00.000Z',
    source: 'CORTEX_TRAJECTORY_SOURCE_SUBAGENT'
  });
  assert.equal(fromTop.parentConversationId, 'parent-1');
  assert.equal(fromTop.nestingDepth, 2);
  assert.equal(fromTop.agentName, 'researcher');
  assert.equal(fromTop.isSubagent, true);
  assert.equal(fromTop.lastUserInputStepIndex, -1);
  assert.equal(fromTop.notFullyIdle, true);
  assert.equal(fromTop.killed, false);
  assert.equal(fromTop.lastCompletedTime, '2026-11-24T04:00:00.000Z');
  assert.equal(fromTop.source, 'CORTEX_TRAJECTORY_SOURCE_SUBAGENT');

  const fromMeta = normalizeSessionSummary('cid-meta', {
    summary: 'Nested',
    metadata: {
      parentConversationId: 'parent-2',
      nestingDepth: 1,
      agentName: 'verifier',
      isSubagent: true,
      lastUserInputStepIndex: 3,
      notFullyIdle: false,
      killed: true,
      lastCompletedTime: '2026-11-24T04:05:00.000Z'
    }
  });
  assert.equal(fromMeta.parentConversationId, 'parent-2');
  assert.equal(fromMeta.nestingDepth, 1);
  assert.equal(fromMeta.agentName, 'verifier');
  assert.equal(fromMeta.isSubagent, true);
  assert.equal(fromMeta.lastUserInputStepIndex, 3);
  assert.equal(fromMeta.notFullyIdle, false);
  assert.equal(fromMeta.killed, true);
  assert.equal(fromMeta.lastCompletedTime, '2026-11-24T04:05:00.000Z');

  const plain = normalizeSessionSummary('cid-plain', { summary: 'Plain' });
  assert.equal('parentConversationId' in plain, false);
  assert.equal('isSubagent' in plain, false);
});

test('B10: Orchestrator thinkingLevel 映射 (100=xhigh, 3=high, 2=medium, 1=low)、0步会话详情与 sendMessage 思考等级回退', async () => {
  const sendAttempts = [];
  let rejectThinkingOnce = true;

  const rpc = createMockRpc({
    StartCascade: () => ({ cascadeId: 'brand-new-0-step' }),
    GetCascadeTrajectory: ({ cascadeId }) => {
      if (cascadeId === 'brand-new-0-step') {
        const err = new Error('NOT_FOUND: no trajectory yet');
        err.statusCode = 404;
        throw err;
      }
      if (cascadeId === 'empty-obj-0-step') {
        return {};
      }
      return { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0, trajectory: { steps: [] } };
    },
    SendUserCascadeMessage: (params) => {
      sendAttempts.push(params);
      if (rejectThinkingOnce && params?.cascadeConfig?.plannerConfig?.thinkingLevel !== undefined) {
        rejectThinkingOnce = false;
        throw new Error('Invalid JSON payload: unknown field thinkingLevel');
      }
      return {};
    },
    GetUserStatus: () => ({
      userStatus: {
        cascadeModelConfigData: {
          defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M537' } },
          clientModelConfigs: [
            { label: 'Gemini 4 Neon (Low)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M530' }, modelId: 'gemini-4-neon-low' },
            { label: 'Gemini 4 Neon (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M533' }, modelId: 'gemini-4-neon-medium' },
            { label: 'Gemini 4 Neon (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' }, modelId: 'gemini-4-neon-high' },
            { label: 'Gemini 4 Neon (XHigh)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M534' }, modelId: 'gemini-4-neon-xhigh' },
            { label: 'Orchestrator (Neon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M537' }, modelId: 'gemini-pro-orchestrator-neon', tagTitle: 'New' },
            { label: 'Orchestrator (Carbon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M667' }, modelId: 'gemini-pro-orchestrator' },
            { label: 'Orchestrator (Argon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M681' }, modelId: 'gemini-pro-orchestrator-argon' }
          ],
          groupedModels: {
            'gemini-4-neon': {
              displayName: 'Gemini 4 Neon',
              supportedThinkingLevels: [
                { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
                { thinkingSuffix: 'medium', thinkingDisplayName: 'Medium' },
                { thinkingSuffix: 'high', thinkingDisplayName: 'High' },
                { thinkingSuffix: 'xhigh', thinkingDisplayName: 'Extra High' }
              ]
            }
          }
        }
      }
    }),
    GetAvailableModels: () => ({
      response: {
        models: {
          'gemini-4-neon-low': { model: 'MODEL_PLACEHOLDER_M530', displayName: 'Gemini 4 Neon (Low)', thinkingLevel: 1 },
          'gemini-4-neon-medium': { model: 'MODEL_PLACEHOLDER_M533', displayName: 'Gemini 4 Neon (Medium)', thinkingLevel: 2 },
          'gemini-4-neon-high': { model: 'MODEL_PLACEHOLDER_M532', displayName: 'Gemini 4 Neon (High)', thinkingLevel: 3 },
          'gemini-4-neon-xhigh': { model: 'MODEL_PLACEHOLDER_M534', displayName: 'Gemini 4 Neon (XHigh)', thinkingLevel: 100 },
          'gemini-pro-orchestrator-neon': { model: 'MODEL_PLACEHOLDER_M537', displayName: 'Orchestrator (Neon)', thinkingLevel: 100 },
          'gemini-pro-orchestrator': { model: 'MODEL_PLACEHOLDER_M667', displayName: 'Orchestrator (Carbon)', thinkingLevel: 3 },
          'gemini-pro-orchestrator-argon': { model: 'MODEL_PLACEHOLDER_M681', displayName: 'Orchestrator (Argon)', thinkingLevel: 3 }
        }
      }
    })
  });

  const adapter = createHarnessAdapter({ rpc });
  const catalog = await adapter.listModels();
  assert.equal(catalog.tree.supportsCustomOrchestrator, true);

  const orchNode = catalog.tree.nodes.find((n) => n.key === 'orch');
  assert.ok(orchNode);
  assert.equal(orchNode.secondaryLabel, 'Gemini 4 Neon Extra High');

  const neonPreset = orchNode.children.find((c) => c.key === 'orch/gemini-4-neon');
  assert.equal(neonPreset.defaultThinkingSuffix, 'xhigh');
  assert.equal(neonPreset.secondaryLabel, 'Extra High · → Hydrogen');
  assert.equal(neonPreset.selectedDisplayLabel, 'Orchestrator · Gemini 4 Neon Extra High');
  assert.equal(neonPreset.selection.plannerThinkingSuffix, 'xhigh');
  assert.deepEqual(neonPreset.supportedThinkingLevels, ['low', 'medium', 'high', 'xhigh']);

  const carbonPreset = orchNode.children.find((c) => c.key === 'orch/gemini-4-carbon');
  assert.equal(carbonPreset.defaultThinkingSuffix, 'high');
  assert.equal(carbonPreset.secondaryLabel, 'High · → Hydrogen');
  assert.equal(carbonPreset.selection.plannerThinkingSuffix, 'high');
  assert.deepEqual(carbonPreset.supportedThinkingLevels, ['low', 'medium', 'high']);

  const neonBranch = catalog.tree.nodes.find((n) => n.key === 'family/gemini-4-neon');
  assert.deepEqual(neonBranch.children[0].supportedThinkingLevels, ['low', 'medium', 'high', 'xhigh']);

  // 0-step brand-new cascade detail handling (both NOT_FOUND after createSession and empty {})
  const created = await adapter.createSession({ title: 'Brand New' });
  const detailNew = await adapter.getSessionDetail(created.cascadeId);
  assert.equal(detailNew.ok, true);
  assert.equal(detailNew.session.status, 'CASCADE_RUN_STATUS_IDLE');
  assert.equal(detailNew.session.numTotalSteps, 0);
  assert.deepEqual(detailNew.events, []);

  const detailEmpty = await adapter.getSessionDetail('empty-obj-0-step');
  assert.equal(detailEmpty.ok, true);
  assert.equal(detailEmpty.session.status, 'CASCADE_RUN_STATUS_IDLE');
  assert.equal(detailEmpty.session.numTotalSteps, 0);
  assert.deepEqual(detailEmpty.events, []);

  // sendMessage resolves grouped family variant when thinkingLevel is passed
  await adapter.sendMessage('brand-new-0-step', {
    text: 'Use xhigh variant',
    modelId: 'MODEL_PLACEHOLDER_M533',
    thinkingLevel: 'xhigh'
  });
  assert.equal(sendAttempts[0].cascadeConfig.plannerConfig.requestedModel.model, 'MODEL_PLACEHOLDER_M534');
  assert.equal(sendAttempts[0].cascadeConfig.plannerConfig.thinkingLevel, undefined);

  // sendMessage on Orchestrator preset attaches thinkingLevel and retries cleanly if RPC rejects unknown field
  await adapter.sendMessage('brand-new-0-step', {
    text: 'Orchestrate medium',
    modelId: 'MODEL_PLACEHOLDER_M537',
    thinkingLevel: 'medium'
  });
  assert.equal(sendAttempts.length, 3);
  assert.equal(sendAttempts[1].cascadeConfig.plannerConfig.requestedModel.model, 'MODEL_PLACEHOLDER_M537');
  assert.equal(sendAttempts[1].cascadeConfig.plannerConfig.thinkingLevel, 2);
  assert.equal(sendAttempts[2].cascadeConfig.plannerConfig.requestedModel.model, 'MODEL_PLACEHOLDER_M537');
  assert.equal(sendAttempts[2].cascadeConfig.plannerConfig.thinkingLevel, undefined);
});

test('B11: listModels injects Claude Opus planner preset into Orchestrator and sendMessage resolves backing thinking variant', async () => {
  const sentPayloads = [];
  const rpc = createMockRpc({
    GetUserStatus: () => ({
      userStatus: {
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: 'Orchestrator (Neon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M537' }, modelId: 'gemini-pro-orchestrator-neon', tagTitle: 'New' },
            { label: 'Orchestrator (Carbon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M667' }, modelId: 'gemini-pro-orchestrator', tagTitle: 'New' },
            { label: 'Orchestrator (Argon)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M681' }, modelId: 'gemini-pro-orchestrator-argon', tagTitle: 'New' },
            { label: 'Claude Opus 5.5 (Low)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M400' }, modelId: 'claude-opus-5-5-low', tagTitle: 'New', quotaInfo: { remainingFraction: 0.05 } },
            { label: 'Claude Opus 5.5 (Medium)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M401' }, modelId: 'claude-opus-5-5-medium', tagTitle: 'New', quotaInfo: { remainingFraction: 0.05 } },
            { label: 'Claude Opus 5.5 (High)', modelOrAlias: { model: 'MODEL_PLACEHOLDER_M402' }, modelId: 'claude-opus-5-5-high', tagTitle: 'New', quotaInfo: { remainingFraction: 0.05 } }
          ],
          groupedModels: {
            'claude-opus-5-5': {
              displayName: 'Claude Opus 5.5',
              supportedThinkingLevels: [
                { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
                { thinkingSuffix: 'medium', thinkingDisplayName: 'Medium' },
                { thinkingSuffix: 'high', thinkingDisplayName: 'High' }
              ]
            }
          }
        }
      }
    }),
    GetAvailableModels: () => ({
      response: {
        models: {
          'claude-opus-5-5-low': { model: 'MODEL_PLACEHOLDER_M400', displayName: 'Claude Opus 5.5 (Low)', thinkingLevel: 1 },
          'claude-opus-5-5-medium': { model: 'MODEL_PLACEHOLDER_M401', displayName: 'Claude Opus 5.5 (Medium)', thinkingLevel: 2 },
          'claude-opus-5-5-high': { model: 'MODEL_PLACEHOLDER_M402', displayName: 'Claude Opus 5.5 (High)', thinkingLevel: 3 }
        }
      }
    }),
    SendUserCascadeMessage: (params) => {
      sentPayloads.push(params);
      return {};
    }
  });

  const adapter = createHarnessAdapter({ rpc });
  const catalog = await adapter.listModels();
  const orchNode = catalog.tree.nodes.find((n) => n.key === 'orch');
  assert.ok(orchNode);
  const opusPreset = orchNode.children.find((c) => c.key === 'orch/claude-opus-5-5');
  assert.ok(opusPreset, 'Expected Claude Opus 5.5 preset inside Orchestrator');
  assert.equal(opusPreset.label, 'Claude Opus 5.5');
  assert.equal(opusPreset.defaultThinkingSuffix, 'high');
  assert.deepEqual(opusPreset.supportedThinkingLevels, ['low', 'medium', 'high']);
  assert.equal(opusPreset.selection.requestedModel, 'orchestrator:claude-opus-5-5');
  assert.deepEqual(opusPreset.selection.backingModels, {
    low: 'MODEL_PLACEHOLDER_M400',
    medium: 'MODEL_PLACEHOLDER_M401',
    high: 'MODEL_PLACEHOLDER_M402'
  });

  await adapter.sendMessage('test-opus-orch', {
    text: 'Plan with Opus Medium',
    modelId: 'orchestrator:claude-opus-5-5',
    thinkingLevel: 'medium'
  });
  assert.equal(sentPayloads.length, 1);
  assert.equal(sentPayloads[0].cascadeConfig.plannerConfig.requestedModel.model, 'MODEL_PLACEHOLDER_M401');
  assert.equal(sentPayloads[0].cascadeConfig.plannerConfig.thinkingLevel, undefined);
});

test('HUB-314: getSessionDetail enforces bounded timeout without retry storm and returns 504 SESSION_DETAIL_TIMEOUT', async () => {
  const rpcCalls = [];
  const rpc = {
    async call(method, params, opts) {
      rpcCalls.push({ method, params, opts });
      return new Promise(() => {}); // Simulate hung LanguageServer RPC
    }
  };

  const adapter = createHarnessAdapter({ rpc, detailTimeoutMs: 70 });
  const startedAt = Date.now();
  await assert.rejects(
    () => adapter.getSessionDetail('cid-hang'),
    (err) => err && err.statusCode === 504 && err.code === 'SESSION_DETAIL_TIMEOUT'
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 500, `Expected bounded timeout, took ${elapsedMs}ms`);
  assert.ok(rpcCalls.every((c) => c.opts && c.opts.retryOnTimeout === false));
});

test('HUB-314: getSessionDetail falls back to GetCascadeTrajectorySteps, deduplicates inflight, caches briefly, and seeds poll cursor', async () => {
  let trajCalls = 0;
  let stepCalls = 0;
  const stepOffsets = [];
  const rpc = {
    async call(method, params) {
      if (method === 'GetCascadeTrajectory') {
        trajCalls += 1;
        await new Promise((r) => setTimeout(r, 25));
        throw new Error('RESOURCE_EXHAUSTED: trajectory payload too large');
      }
      if (method === 'GetCascadeTrajectorySteps') {
        stepCalls += 1;
        stepOffsets.push(params.stepOffset);
        if (params.stepOffset === 0) {
          return {
            status: 'CASCADE_RUN_STATUS_IDLE',
            numTotalSteps: 2,
            steps: [
              { stepIndex: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', userInput: { userResponse: 'hi' } },
              { stepIndex: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', plannerResponse: { response: 'hello' } }
            ]
          };
        }
        return { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 2, steps: [] };
      }
      return {};
    }
  };

  const adapter = createHarnessAdapter({ rpc, detailTimeoutMs: 500, detailCacheTtlMs: 2000 });
  const [d1, d2] = await Promise.all([
    adapter.getSessionDetail('cid-fb'),
    adapter.getSessionDetail('cid-fb')
  ]);
  assert.equal(d1.ok, true);
  assert.equal(d2.ok, true);
  assert.equal(d1.events.length, 2);
  assert.equal(trajCalls, 1, 'inflight requests must coalesce');
  assert.equal(stepCalls, 1);

  // Short-TTL cache hit + shared steps for task-manager
  const d3 = await adapter.getSessionDetail('cid-fb');
  assert.equal(d3.events.length, 2);
  assert.equal(trajCalls, 1, 'cached detail should avoid duplicate RPC');
  assert.equal(adapter.getCachedSessionSteps('cid-fb')?.length, 2);

  // Seeded cursor avoids re-pulling stepOffset=0 on immediate pollDelta
  const delta = await adapter.pollDelta('cid-fb');
  assert.equal(delta.hasChanges, false);
  assert.equal(stepOffsets.at(-1), 2);
});

test('HUB-314: getSessionDetail classifies RPC_UNAVAILABLE (503) and SESSION_NOT_FOUND (404)', async () => {
  const rpcOffline = createMockRpc({
    GetCascadeTrajectory: () => { throw new Error('connect ECONNREFUSED 127.0.0.1:51234'); },
    GetCascadeTrajectorySteps: () => { throw new Error('connect ECONNREFUSED 127.0.0.1:51234'); }
  });
  const offlineAdapter = createHarnessAdapter({ rpc: rpcOffline, detailTimeoutMs: 200 });
  await assert.rejects(
    () => offlineAdapter.getSessionDetail('cid-offline'),
    (err) => err && err.statusCode === 503 && err.code === 'RPC_UNAVAILABLE'
  );

  const rpcMissing = createMockRpc({
    GetCascadeTrajectory: () => { throw new Error('trajectory not found'); }
  });
  const missingAdapter = createHarnessAdapter({ rpc: rpcMissing, detailTimeoutMs: 200 });
  await assert.rejects(
    () => missingAdapter.getSessionDetail('cid-missing'),
    (err) => err && err.statusCode === 404 && err.code === 'SESSION_NOT_FOUND'
  );
});
