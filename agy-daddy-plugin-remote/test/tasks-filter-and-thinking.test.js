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
const { createTaskManager, RECENT_TASKS_LIMIT } = require('../src/task-manager');

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

test('remote.list-orchestrator-thinking-levels 动态读取主控真实档位、不支持空态、宿主未就绪回退与动态档位持久化', async () => {
  let hostReady = true;
  const harness = createMockHostHarness({
    onRpc(method) {
      if (!hostReady && (method === 'GetUserStatus' || method === 'GetAvailableModels')) {
        throw new Error('RPC_UNAVAILABLE');
      }
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { modelOrAlias: { model: 'MODEL_ORCH_CARBON' }, modelId: 'gemini-pro-orchestrator-carbon', label: 'Orchestrator (Carbon)', thinkingLevel: 3 },
                { modelOrAlias: { model: 'MODEL_ORCH_ARGON' }, modelId: 'gemini-pro-orchestrator-argon', label: 'Orchestrator (Argon)', thinkingLevel: 2 },
                { modelOrAlias: { model: 'MODEL_ORCH_NEON' }, modelId: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)', thinkingLevel: 3 },
                { modelOrAlias: { model: 'MODEL_OPUS_LOW' }, modelId: 'claude-opus-5-5', label: 'Claude Opus 5.5' }
              ],
              groupedModels: {
                // Carbon 仅支持 2 档（low / high），禁止补齐 4 档
                'gemini-4-carbon': {
                  displayName: 'Gemini 4 Carbon',
                  supportedThinkingLevels: [
                    { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
                    { thinkingSuffix: 'high', thinkingDisplayName: 'High' }
                  ]
                },
                // Argon 支持 3 档（含 minimal）
                'gemini-4-argon': {
                  displayName: 'Gemini 4 Argon',
                  supportedThinkingLevels: [
                    { thinkingSuffix: 'minimal', thinkingDisplayName: 'Minimal' },
                    { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
                    { thinkingSuffix: 'medium', thinkingDisplayName: 'Medium' }
                  ]
                },
                // Neon 支持 4 档
                'gemini-4-neon': {
                  displayName: 'Gemini 4 Neon',
                  supportedThinkingLevels: [
                    { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
                    { thinkingSuffix: 'medium', thinkingDisplayName: 'Medium' },
                    { thinkingSuffix: 'high', thinkingDisplayName: 'High' },
                    { thinkingSuffix: 'xhigh', thinkingDisplayName: 'XHigh' }
                  ]
                },
                // Opus 5.5 显式不支持思考等级
                'claude-opus-5-5': {
                  displayName: 'Claude Opus 5.5',
                  supportedThinkingLevels: []
                }
              }
            }
          }
        };
      }
      if (method === 'GetAvailableModels') {
        return { response: { models: {} } };
      }
      if (method === 'GetAllCascadeTrajectories') {
        return { trajectorySummaries: {} };
      }
      return { ok: true };
    }
  });

  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    const carbonRes = await harness.executeCommand('remote.list-orchestrator-thinking-levels', [{
      fieldKey: 'orchestratorCarbonThinking'
    }]);
    assert.equal(carbonRes.ok, true);
    assert.equal(carbonRes.fallback, false);
    assert.equal(carbonRes.hostReady, true);
    assert.deepEqual(carbonRes.options.map((o) => o.value), ['low', 'high']);
    assert.equal(carbonRes.options[0].label['zh-CN'], 'Low · 快速响应');
    assert.equal(carbonRes.options[0].label.en, 'Low');

    const argonRes = await harness.executeCommand('remote.list-orchestrator-thinking-levels', [{
      fieldKey: 'orchestratorArgonThinking'
    }]);
    assert.deepEqual(argonRes.options.map((o) => o.value), ['minimal', 'low', 'medium']);
    assert.equal(argonRes.options[0].label['zh-CN'], 'Minimal · 极速轻思考');

    const neonRes = await harness.executeCommand('remote.list-orchestrator-thinking-levels', [{
      fieldKey: 'orchestratorNeonThinking'
    }]);
    assert.deepEqual(neonRes.options.map((o) => o.value), ['low', 'medium', 'high', 'xhigh']);

    const opusRes = await harness.executeCommand('remote.list-orchestrator-thinking-levels', [{
      fieldKey: 'orchestratorOpusThinking'
    }]);
    assert.equal(opusRes.ok, true);
    assert.equal(opusRes.fallback, false);
    assert.equal(opusRes.supported, false);
    assert.deepEqual(opusRes.options, []);
    assert.ok(opusRes.emptyReason && opusRes.emptyReason['zh-CN']);

    // 宿主未就绪时安全回退
    hostReady = false;
    const offlineRes = await harness.executeCommand('remote.list-orchestrator-thinking-levels', [{
      fieldKey: 'orchestratorCarbonThinking'
    }]);
    assert.equal(offlineRes.ok, true);
    assert.equal(offlineRes.hostReady, false);
    assert.equal(offlineRes.fallback, true);
    assert.deepEqual(offlineRes.options.map((o) => o.value), ['low', 'medium', 'high', 'xhigh']);

    // 新档位 minimal / off 在插件设置更新及 /api/v1/orchestrator/thinking 中均不被误拦截
    await harness.updatePluginSettings('agy-daddy.remote', {
      permissionLevel: 'L1',
      allowRemoteWrite: true,
      loopback: true,
      orchestratorArgonThinking: 'minimal',
      orchestratorCarbonThinking: 'off'
    });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const boot1 = await httpRequest(`${st.url}/api/v1/bootstrap`, { headers: auth });
    assert.equal(boot1.status, 200);
    assert.equal(boot1.json.orchestratorThinking.argon, 'minimal');
    assert.equal(boot1.json.orchestratorThinking.carbon, 'off');

    const updRes = await httpRequest(`${st.url}/api/v1/orchestrator/thinking`, {
      method: 'POST',
      headers: auth,
      body: { master: 'neon', thinkingLevel: 'max' }
    });
    assert.equal(updRes.status, 200);
    assert.equal(updRes.json.orchestratorThinking.neon, 'max');
  } finally {
    await harness.cleanup();
  }
});

test('createTaskManager 与 GET /api/v1/tasks 支持 projectPath/projectName/sessionTitle、截断前过滤与全局 filters/totalRunningCount', async () => {
  const projAlpha = path.join(os.tmpdir(), 'task-proj-alpha');
  const projBeta = path.join(os.tmpdir(), 'task-proj-beta');
  const baseTs = Date.now();

  // Build 30 sessions so recent tasks exceed RECENT_TASKS_LIMIT (24)
  // Newer 26 belong to proj-alpha; older 4 (indices 26..29) belong to proj-beta!
  const mockSessions = [];
  for (let i = 0; i < 30; i++) {
    const isAlpha = i < 26;
    const isRunning = i === 0 || i === 29; // 1 running in alpha, 1 running in beta
    mockSessions.push({
      cascadeId: `cid-${i}`,
      title: `Session ${i}`,
      workspacePath: isAlpha ? projAlpha : projBeta,
      projectName: isAlpha ? 'Alpha App' : 'Beta Service',
      status: isRunning ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
      createdTime: new Date(baseTs - i * 10000).toISOString(),
      lastModifiedTime: new Date(baseTs - i * 10000 + 1000).toISOString(),
      stepCount: 2
    });
  }

  const mockPtyRecords = [
    {
      id: 'pty-alpha-sub',
      cwd: path.join(projAlpha, 'packages', 'api'),
      alive: true,
      status: 'running',
      createdAt: baseTs + 5000,
      logBuffer: 'pty running log'
    },
    {
      id: 'pty-beta-done',
      cwd: projBeta,
      alive: false,
      status: 'completed',
      exitCode: 0,
      createdAt: baseTs - 400000,
      endedAt: baseTs - 399000,
      logBuffer: 'pty done log'
    }
  ];

  const tm = createTaskManager({
    ptyManager: { listTaskRecords: () => mockPtyRecords },
    listSessions: async () => ({
      sessions: mockSessions,
      projects: [
        { id: 'p-alpha', name: 'Alpha App', rootPath: projAlpha },
        { id: 'p-beta', name: 'Beta Service', rootPath: projBeta }
      ]
    }),
    getSessionSteps: async (cid) => {
      if (cid === 'cid-0') {
        return [
          {
            stepIndex: 0,
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_RUNNING',
            runCommand: {
              commandLine: 'npm test',
              cwd: path.join(projAlpha, 'sub'),
              combinedOutput: 'running tests'
            },
            metadata: { createdAt: new Date(baseTs + 1000).toISOString() }
          }
        ];
      }
      if (cid === 'cid-28') {
        return [
          {
            stepIndex: 0,
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status: 'CORTEX_STEP_STATUS_DONE',
            runCommand: {
              commandLine: 'echo beta-old',
              cwd: projBeta,
              exitCode: 0,
              combinedOutput: 'beta-old'
            },
            metadata: {
              createdAt: new Date(baseTs - 280000).toISOString(),
              completedAt: new Date(baseTs - 279000).toISOString()
            }
          }
        ];
      }
      return [];
    }
  });

  // 1. 全量未筛选：校验 DTO 字段、totalRunningCount 与 recent 截断上限
  const allRes = await tm.listTasks('L1');
  assert.equal(allRes.ok, true);
  assert.equal(allRes.totalRunningCount, 4); // cid-0, cid-29, cmd:cid-0:0, pty-alpha-sub
  assert.equal(allRes.runningCount, 4);
  assert.equal(allRes.recent.length, RECENT_TASKS_LIMIT);

  const ptyRunning = allRes.running.find((t) => t.id === 'pty:pty-alpha-sub');
  assert.equal(ptyRunning.projectPath, path.resolve(projAlpha));
  assert.equal(ptyRunning.projectName, 'Alpha App');
  assert.equal(ptyRunning.sessionTitle, null);

  const cmdRunning = allRes.running.find((t) => t.id === 'cmd:cid-0:0');
  assert.equal(cmdRunning.projectPath, path.resolve(projAlpha));
  assert.equal(cmdRunning.projectName, 'Alpha App');
  assert.equal(cmdRunning.sessionTitle, 'Session 0');

  // 2. 按 project 过滤 Beta：必须在 recent.slice(0, 24) 之前过滤，命中较早的 cid-26..28 与 pty-beta-done！
  const betaRes = await tm.listTasks('L1', { project: projBeta });
  assert.equal(betaRes.totalRunningCount, 4);
  assert.equal(betaRes.runningCount, 1); // cid-29
  assert.deepEqual(betaRes.running.map((t) => t.id), ['session:cid-29']);
  assert.ok(betaRes.recent.some((t) => t.id === 'session:cid-28'));
  assert.ok(betaRes.recent.some((t) => t.id === 'session:cid-27'));
  assert.ok(betaRes.recent.some((t) => t.id === 'session:cid-26'));
  assert.ok(betaRes.recent.some((t) => t.id === 'pty:pty-beta-done'));
  assert.ok(betaRes.recent.every((t) => t.projectName === 'Beta Service'));
  // filters 依然返回全局聚合供前端切换
  assert.equal(betaRes.filters.projects.length, 2);
  assert.ok(betaRes.filters.projects.some((p) => p.name === 'Alpha App'));
  assert.ok(betaRes.filters.projects.some((p) => p.name === 'Beta Service'));

  // 3. 按 sessionId=cid-28 过滤：命中超出 24 条上限的旧会话及其命令步骤
  const sess28Res = await tm.listTasks('L1', { sessionId: 'cid-28' });
  assert.equal(sess28Res.totalRunningCount, 4);
  assert.equal(sess28Res.runningCount, 0);
  assert.ok(sess28Res.recent.some((t) => t.id === 'session:cid-28'));
  assert.ok(sess28Res.recent.some((t) => t.id === 'cmd:cid-28:0'));
  assert.ok(sess28Res.recent.every((t) => t.sessionId === 'cid-28'));

  // 4. 组合过滤 sessionId + project 不匹配时返回空且 totalRunningCount 保持全量
  const mismatchRes = await tm.listTasks('L1', { sessionId: 'cid-28', project: projAlpha });
  assert.equal(mismatchRes.totalRunningCount, 4);
  assert.equal(mismatchRes.runningCount, 0);
  assert.deepEqual(mismatchRes.running, []);
  assert.deepEqual(mismatchRes.recent, []);
  assert.equal(mismatchRes.filters.projects.length, 2);
});

test('GET /api/v1/tasks HTTP 接口支持 ?sessionId=&project= 参数及 filters 契约', async () => {
  const wsOne = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-tasks-one-'));
  const wsTwo = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-tasks-two-'));
  const nowIso = new Date().toISOString();

  const harness = createMockHostHarness({
    onRpc(method, params) {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            'cid-one': {
              summary: 'One Task Session',
              status: 'CASCADE_RUN_STATUS_RUNNING',
              createdTime: nowIso,
              lastModifiedTime: nowIso,
              stepCount: 1,
              workspaces: [{ workspaceFolderAbsoluteUri: `file://${wsOne}` }]
            },
            'cid-two': {
              summary: 'Two Task Session',
              status: 'CASCADE_RUN_STATUS_IDLE',
              createdTime: nowIso,
              lastModifiedTime: nowIso,
              stepCount: 1,
              workspaces: [{ workspaceFolderAbsoluteUri: `file://${wsTwo}` }]
            }
          }
        };
      }
      if (method === 'GetCascadeTrajectory') {
        const cid = params?.cascadeId;
        return {
          trajectory: {
            cascadeId: cid,
            status: cid === 'cid-one' ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE',
            steps: [
              {
                stepIndex: 0,
                type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
                status: cid === 'cid-one' ? 'CORTEX_STEP_STATUS_RUNNING' : 'CORTEX_STEP_STATUS_DONE',
                runCommand: {
                  commandLine: `echo ${cid}`,
                  cwd: cid === 'cid-one' ? wsOne : wsTwo,
                  combinedOutput: `out ${cid}`
                },
                metadata: { createdAt: nowIso, completedAt: nowIso }
              }
            ]
          }
        };
      }
      return { ok: true };
    }
  });

  try {
    const { port: bridgePort } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort, hostToken: harness.bridge.hostToken });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    await harness.updatePluginSettings('agy-daddy.remote', {
      loopback: true,
      permissionLevel: 'L1',
      allowRemoteWrite: true,
      allowedRoots: [wsOne, wsTwo]
    });

    const remoteSvc = harness.bus.getServiceProxy('remote');
    const st = await remoteSvc.getStatus();
    const token = await remoteSvc.getPairingToken();
    const auth = { Authorization: `Bearer ${token}` };

    const fullRes = await httpRequest(`${st.url}/api/v1/tasks`, { headers: auth });
    assert.equal(fullRes.status, 200);
    assert.equal(fullRes.json.totalRunningCount, 2);
    assert.equal(fullRes.json.runningCount, 2);
    assert.ok(Array.isArray(fullRes.json.filters?.projects));
    assert.ok(Array.isArray(fullRes.json.filters?.sessions));
    assert.equal(fullRes.json.filters.projects.length, 2);
    assert.equal(fullRes.json.filters.sessions.length, 2);

    const byProject = await httpRequest(
      `${st.url}/api/v1/tasks?project=${encodeURIComponent(wsTwo)}`,
      { headers: auth }
    );
    assert.equal(byProject.status, 200);
    assert.equal(byProject.json.totalRunningCount, 2);
    assert.equal(byProject.json.runningCount, 0);
    assert.equal(byProject.json.running.length, 0);
    assert.ok(byProject.json.recent.some((t) => t.id === 'session:cid-two'));
    assert.ok(byProject.json.recent.some((t) => t.id === 'cmd:cid-two:0'));
    assert.ok(byProject.json.recent.every((t) => t.sessionId === 'cid-two'));
    assert.equal(byProject.json.filters.projects.length, 2);

    const bySession = await httpRequest(
      `${st.url}/api/v1/tasks?sessionId=${encodeURIComponent('cid-one')}&project=${encodeURIComponent(wsOne)}`,
      { headers: auth }
    );
    assert.equal(bySession.status, 200);
    assert.equal(bySession.json.totalRunningCount, 2);
    assert.equal(bySession.json.runningCount, 2);
    assert.ok(bySession.json.running.every((t) => t.sessionId === 'cid-one'));
  } finally {
    await harness.cleanup();
    fs.rmSync(wsOne, { recursive: true, force: true });
    fs.rmSync(wsTwo, { recursive: true, force: true });
  }
});
