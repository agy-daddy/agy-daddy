'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isSessionWatched,
  classifyStepAttention,
  resolveSessionOrgInfo
} = require('../src/session-watch-aggregator');
const { mapTpsToMotion, createSpeedSmoother } = require('../src/shared/pet-rig-evaluator');

const ORG_FIXTURE = {
  groups: [
    { id: 'grp-a', name: 'Group A' },
    { id: 'grp-b', name: 'Group B' }
  ],
  projects: [
    { id: 'proj-1', aliases: ['proj-1-old'], name: 'Alpha', rootPath: '/work/alpha', uri: 'file:///work/alpha', groupId: 'grp-a' },
    { id: 'proj-2', aliases: [], name: 'Beta', rootPath: '/work/beta', uri: 'file:///work/beta', groupId: 'grp-b' }
  ],
  projectGroupMap: { 'proj-1': 'grp-a', 'proj-2': 'grp-b' },
  sessionGroupMap: { 'cid-override': 'grp-a' },
  sessionProjectOverrides: {},
  archivedSessionIds: ['cid-archived'],
  deletedSessionIds: ['cid-deleted']
};

test('四维会话监听器真值表覆盖全部 8 种组合及生命周期剔除', () => {
  const focusId = 'cid-focus';
  const alphaSession = { cascadeId: 'cid-focus', workspaceUri: 'file:///work/alpha' };
  const betaSession = { cascadeId: 'cid-beta', workspaceUri: 'file:///work/beta' };
  const otherSession = { cascadeId: 'cid-other', workspaceUri: 'file:///work/gamma' };

  // 1. 生命周期剔除：已删除、已归档、isSubagent
  assert.equal(isSessionWatched({ cascadeId: 'cid-deleted', workspaceUri: 'file:///work/alpha' }, {}, ORG_FIXTURE, focusId), false);
  assert.equal(isSessionWatched({ cascadeId: 'cid-archived', workspaceUri: 'file:///work/alpha' }, {}, ORG_FIXTURE, focusId), false);
  assert.equal(isSessionWatched({ cascadeId: 'cid-sub', isSubagent: true, workspaceUri: 'file:///work/alpha' }, {}, ORG_FIXTURE, focusId), false);

  // 2. excludeCurrentSession=true 最高优硬排除（即使在白名单或 followCurrentSession=true 下也排除）
  assert.equal(isSessionWatched(alphaSession, {
    followCurrentSession: true,
    excludeCurrentSession: true,
    projectWhitelist: ['proj-1'],
    groupWhitelist: ['grp-a']
  }, ORG_FIXTURE, focusId), false);
  assert.equal(isSessionWatched(betaSession, {
    followCurrentSession: true,
    excludeCurrentSession: true,
    projectWhitelist: [],
    groupWhitelist: []
  }, ORG_FIXTURE, focusId), true);

  // 3. 白名单为空：全部非排除顶层会话纳入感知池（无论 followCurrentSession true/false）
  assert.equal(isSessionWatched(alphaSession, { followCurrentSession: true, excludeCurrentSession: false }, ORG_FIXTURE, focusId), true);
  assert.equal(isSessionWatched(otherSession, { followCurrentSession: false, excludeCurrentSession: false }, ORG_FIXTURE, focusId), true);

  // 4. 项目白名单 ∪ 分组白名单取并集
  const unionFilter = {
    followCurrentSession: false,
    excludeCurrentSession: false,
    projectWhitelist: ['proj-2'],
    groupWhitelist: ['grp-a']
  };
  assert.equal(isSessionWatched(alphaSession, unionFilter, ORG_FIXTURE, focusId), true); // 命中 grp-a
  assert.equal(isSessionWatched(betaSession, unionFilter, ORG_FIXTURE, focusId), true);  // 命中 proj-2
  assert.equal(isSessionWatched(otherSession, unionFilter, ORG_FIXTURE, focusId), false);

  // 5. 白名单非空 + followCurrentSession=true：焦点会话即使不在白名单也纳入
  assert.equal(isSessionWatched({ cascadeId: 'cid-focus', workspaceUri: 'file:///work/gamma' }, {
    followCurrentSession: true,
    excludeCurrentSession: false,
    projectWhitelist: ['proj-2'],
    groupWhitelist: []
  }, ORG_FIXTURE, focusId), true);

  // 6. 白名单非空 + followCurrentSession=false：焦点会话不在白名单则排除
  assert.equal(isSessionWatched({ cascadeId: 'cid-focus', workspaceUri: 'file:///work/gamma' }, {
    followCurrentSession: false,
    excludeCurrentSession: false,
    projectWhitelist: ['proj-2'],
    groupWhitelist: []
  }, ORG_FIXTURE, focusId), false);

  // 7. sessionGroupMap 覆盖项目所属分组
  const overrideInfo = resolveSessionOrgInfo({ cascadeId: 'cid-override', workspaceUri: 'file:///work/beta' }, ORG_FIXTURE);
  assert.equal(overrideInfo.projectId, 'proj-2');
  assert.equal(overrideInfo.groupId, 'grp-a');
});

test('classifyStepAttention 精确识别待审核项、AskQuestion、错误与已完成回复摘要', () => {
  const approval = classifyStepAttention({
    status: 'CORTEX_STEP_STATUS_PENDING',
    requestedInteraction: { runCommand: { commandLine: 'npm publish' } }
  }, 4, { cascadeId: 'c1', sessionTitle: 'Demo' });
  assert.equal(approval?.kind, 'approval');
  assert.equal(approval?.interactionType, 'runCommand');
  assert.match(approval?.summary || '', /npm publish/);

  const ask = classifyStepAttention({
    type: 'CORTEX_STEP_TYPE_ASK_QUESTION',
    status: 'CORTEX_STEP_STATUS_PENDING',
    askQuestion: { question: '确认继续部署吗？' },
    completedInteractions: []
  }, 5, { cascadeId: 'c1', sessionTitle: 'Demo' });
  assert.equal(ask?.kind, 'approval');
  assert.equal(ask?.interactionType, 'askQuestion');

  const reply = classifyStepAttention({
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    plannerResponse: { response: '## 完成\n已更新 **desktop pet** 组件' }
  }, 6, { cascadeId: 'c1', sessionTitle: 'Demo' });
  assert.equal(reply?.kind, 'reply');
  assert.equal(reply?.summary.includes('**'), false);
  assert.match(reply?.summary || '', /完成/);
});

test('TPS 速率映射曲线与 EMA 平滑器符合 6 档状态规范', () => {
  assert.equal(mapTpsToMotion({ tps: null, busy: false, idleMs: 60000 }).animState, 'sleeping');
  assert.equal(mapTpsToMotion({ tps: null, busy: false, idleMs: 5000 }).animState, 'idle');
  assert.equal(mapTpsToMotion({ tps: null, busy: true, idleMs: 0 }).animState, 'thinking');
  assert.equal(mapTpsToMotion({ tps: 15, busy: true }).animState, 'walking');
  assert.equal(mapTpsToMotion({ tps: 45, busy: true }).animState, 'trotting');
  const sprint = mapTpsToMotion({ tps: 120, busy: true });
  assert.equal(sprint.animState, 'sprinting');
  assert.ok(sprint.rawSpeedFactor > 2.35 && sprint.rawSpeedFactor <= 3.5);
  assert.equal(mapTpsToMotion({ tps: 120, busy: true, hasApproval: true }).roamSpeedPxPerSec, 0);

  const smoother = createSpeedSmoother(0.35);
  assert.equal(smoother.push(1.0), 1.0);
  const next = smoother.push(3.0);
  assert.ok(next > 1.5 && next < 2.0);
});
