'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  GPT_OSS_LIMIT,
  CLAUDE_55_LIMIT,
  GEMINI_4_LIMIT,
  DEFAULT_CONTEXT_LIMIT,
  measure,
  parseThresholdSpec,
  resolveThresholdTokens,
  formatThresholdLabel,
  normalizeModelId,
  getContextLimitForModel,
  classifyRequestError,
  summarizeMetadata,
  analyzeTrajectorySteps,
  extractCallId,
  parseGeneratorCall,
  summarizeSessionGeneratorCalls,
  getRingAccentToken
} = require('../src/context-analyzer');
const { auditAttachments } = require('../src/attachment-audit');
const { estimateTextTokens, createStreamSpeedTracker } = require('../src/stream-speed-tracker');
const { normalizeContextSettings, formatStatusBadge } = require('../src/renderer');
const { formatSpeedCompact, buildCapsuleSegments, buildCapsuleTooltip } = require('../src/pulse-capsule');

test('measure 与模型上下文窗口上限识别', () => {
  const en = measure('hello world');
  assert.equal(en.chars, 11);
  assert.equal(en.bytes, 11);
  assert.ok(en.low >= 1 && en.high >= en.low);

  const zh = measure('你好世界');
  assert.equal(zh.chars, 4);
  assert.equal(zh.bytes, 12);

  assert.equal(getContextLimitForModel('gpt-oss-120b'), GPT_OSS_LIMIT);
  assert.equal(getContextLimitForModel('claude-opus-5-5'), CLAUDE_55_LIMIT);
  assert.equal(getContextLimitForModel('gemini-4-hydrogen'), GEMINI_4_LIMIT);
  assert.equal(getContextLimitForModel('custom-small-model'), DEFAULT_CONTEXT_LIMIT);
  assert.equal(getContextLimitForModel('claude-opus-5-5', '', { runtimeBudget: 512000 }), 512000);
});

test('classifyRequestError 覆盖全部 8 类错误并排除 Go context.DeadlineExceeded', () => {
  assert.equal(classifyRequestError('').kind, 'none');
  assert.equal(classifyRequestError('context deadline exceeded while calling upstream').kind, 'network_error');

  const overflow = classifyRequestError('input token count exceeds maximum context length allowed 256,000');
  assert.equal(overflow.kind, 'context_overflow');
  assert.equal(overflow.serviceLimit, 256000);

  assert.equal(classifyRequestError('RESOURCE_EXHAUSTED: daily quota exhausted').kind, 'quota_exhausted');
  const rate = classifyRequestError('429 Too many requests, retry in 12.5 seconds');
  assert.equal(rate.kind, 'rate_limited');
  assert.equal(rate.retryAfterSec, 12.5);
  assert.equal(classifyRequestError('context canceled by user').kind, 'canceled');
  assert.equal(classifyRequestError('401 UNAUTHENTICATED: credentials expired').kind, 'auth_error');
  assert.equal(classifyRequestError('503 Service Unavailable: server overloaded').kind, 'service_unavailable');
  assert.equal(classifyRequestError('unexpected EOF read socket').kind, 'network_error');
  assert.equal(classifyRequestError('weird unknown fault xyz').kind, 'unknown');
});

test('summarizeMetadata: TTFT/流式测速与错误解耦保留上一次有效上下文', () => {
  const okSnap = summarizeMetadata({
    chatModel: {
      model: 'MODEL_M417',
      modelDisplayName: 'Gemini 4 Argon (High)',
      timeToFirstToken: '0.4s',
      streamingDuration: '2.0s',
      usage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 480 },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 1000000 } }
    }
  });
  assert.equal(okSnap.status, 'reported');
  assert.equal(okSnap.actual, 10480);
  assert.equal(okSnap.cacheHitRate, 90);
  assert.equal(okSnap.speed.ttft, 0.4);
  assert.equal(okSnap.speed.streamingSec, 2);
  assert.equal(okSnap.speed.duration, 2.4);
  assert.equal(okSnap.speed.tps, 200);
  assert.equal(okSnap.speed.streamingTps, 240);

  const errSnap = summarizeMetadata({
    chatModel: {
      model: 'MODEL_M417',
      error: '503 Service Unavailable'
    }
  }, { previousValidContext: okSnap });
  assert.equal(errSnap.status, 'service_unavailable');
  assert.equal(errSnap.used, 10480);
});

test('analyzeTrajectorySteps: 5 组拆解、自动压缩检测、240K/328K 断崖及 callId 去重解析', () => {
  const steps = [
    {
      userInput: {
        userResponse: '请分析代码',
        media: [{ uri: 'file:///tmp/spec.md', mimeType: 'text/markdown', description: 'spec.md' }]
      },
      metadata: { modelUsage: { model: 'claude-opus-5-5', inputTokens: 20000, cacheReadTokens: 80000, outputTokens: 500 } }
    },
    {
      plannerResponse: { thinking: '内部思考中', response: '这是回答正文' },
      metadata: { modelUsage: { model: 'claude-opus-5-5', inputTokens: 5000, cacheReadTokens: 60000, outputTokens: 1200 } }
    },
    {
      checkpoint: { sessionSummary: '阶段摘要内容' }
    },
    {
      toolCall: { name: 'read_file', path: '/tmp/a.js' }
    },
    {
      plannerResponse: { response: '大上下文续写' },
      metadata: { modelUsage: { model: 'claude-opus-5-5', inputTokens: 280000, cacheReadTokens: 55000, outputTokens: 800 } }
    }
  ];

  const analysis = analyzeTrajectorySteps(steps);
  assert.equal(analysis.userMessages, 1);
  assert.equal(analysis.assistantMessages, 2);
  assert.ok(analysis.groups.user.chars > 0);
  assert.ok(analysis.groups.assistant.chars > 0);
  assert.ok(analysis.groups.thinking.chars > 0);
  assert.ok(analysis.groups.summaries.chars > 0);
  assert.ok(analysis.groups.tools.chars > 0);
  assert.equal(analysis.media.length, 1);
  assert.equal(analysis.compressionDetected, true);
  assert.equal(analysis.compressionDrop, 100000 - 65000);
  assert.equal(analysis.cacheDropDetected, true);
  assert.equal(analysis.cacheCliffRisk, 'critical');
  assert.equal(analysis.budget, CLAUDE_55_LIMIT);

  const row = {
    stepIndices: [3],
    createdAt: '2026-11-21T10:00:00Z',
    chatModel: {
      model: 'gemini-4-hydrogen',
      timeToFirstToken: '0.5s',
      streamingDuration: '1.5s',
      usage: { responseId: 'resp-abc-1', inputTokens: 100, cacheReadTokens: 400, outputTokens: 200 }
    }
  };
  assert.equal(extractCallId(row, 'cid-1'), 'resp-abc-1');
  const parsedCall = parseGeneratorCall(row, 'cid-1', 'desktop');
  assert.equal(parsedCall.callId, 'resp-abc-1');
  assert.equal(parsedCall.status, 'final');
  assert.equal(parsedCall.tps, 100);
  const startMetaCall = parseGeneratorCall({
    stepIndices: [4],
    chatModel: {
      model: 'gemini-4-hydrogen',
      chatStartMetadata: { createdAt: '2026-03-24T06:36:08.778796Z' },
      usage: { responseId: 'resp-start-meta', inputTokens: 100, outputTokens: 50 }
    }
  }, 'cid-1', 'desktop');
  assert.equal(startMetaCall.dateIsProvisional, false);
  assert.equal(startMetaCall.date.startsWith('2026-03-24'), true);
  assert.match(getRingAccentToken(10, {}), /#71717a|currentColor/);
});

test('auditAttachments 只读测算文本字符数，绝不泄露文件内容且识别二进制/缺失文件', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-att-'));
  try {
    const txtPath = path.join(tmp, 'secret-note.md');
    const binPath = path.join(tmp, 'image.png');
    const secretContent = 'Top secret architecture line 12345';
    fs.writeFileSync(txtPath, secretContent, 'utf8');
    fs.writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const audit = auditAttachments([
      { uri: `file://${txtPath}`, mime: 'text/markdown', name: 'secret-note.md', source: 'user', references: 2 },
      { uri: `file://${binPath}`, mime: 'image/png', name: 'image.png', source: 'user', references: 1 },
      { uri: path.join(tmp, 'gone.txt'), mime: 'text/plain', name: 'gone.txt', source: 'assistant', references: 1 },
      { uri: 'inline:inline-0', mime: 'image/png', name: 'inline.png', source: 'user', references: 1 }
    ]);

    assert.equal(audit.totals.count, 4);
    assert.equal(audit.totals.measuredCount, 1);
    assert.equal(audit.totals.unknownCount, 3);
    assert.equal(audit.items[0].status, 'measured');
    assert.equal(audit.items[0].chars, secretContent.length);
    assert.equal(audit.items[1].status, 'binary_or_unparsed');
    assert.equal(audit.items[2].status, 'missing');
    assert.equal(audit.items[3].status, 'inline_unmeasured');

    // 安全不变式：返回值不得泄露原文内容
    assert.equal(JSON.stringify(audit).includes(secretContent), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('summarizeSessionGeneratorCalls 汇总当前对话全量调用并去重与过滤影子模型', () => {
  const rows = [
    {
      stepIndices: [0],
      chatModel: {
        model: 'claude-opus-5-5',
        timeToFirstToken: '0.5s',
        streamingDuration: '1.5s',
        usage: { responseId: 'c1', inputTokens: 8000, cacheReadTokens: 2000, outputTokens: 200, thinkingOutputTokens: 50, responseOutputTokens: 150 }
      }
    },
    // 同 responseId 覆盖去重
    {
      stepIndices: [0],
      chatModel: {
        model: 'claude-opus-5-5',
        timeToFirstToken: '0.5s',
        streamingDuration: '1.5s',
        usage: { responseId: 'c1', inputTokens: 8000, cacheReadTokens: 2000, outputTokens: 200, thinkingOutputTokens: 50, responseOutputTokens: 150 }
      }
    },
    // 影子图像模型应被忽略
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_M50_IMAGE',
        usage: { responseId: 'img-1', inputTokens: 99999, cacheReadTokens: 0, outputTokens: 999 }
      }
    },
    {
      stepIndices: [2],
      chatModel: {
        model: 'claude-opus-5-5',
        timeToFirstToken: '0.5s',
        streamingDuration: '1.5s',
        usage: { responseId: 'c2', inputTokens: 2000, cacheReadTokens: 18000, outputTokens: 400, thinkingOutputTokens: 100, responseOutputTokens: 300 }
      }
    }
  ];

  const summary = summarizeSessionGeneratorCalls(rows, { cascadeId: 'sess-1' });
  assert.equal(summary.callsCount, 2);
  assert.equal(summary.inputTokens, 10000);
  assert.equal(summary.cachedTokens, 20000);
  assert.equal(summary.totalInputTokens, 30000);
  assert.equal(summary.outputTokens, 600);
  assert.equal(summary.thinkingTokens, 150);
  assert.equal(summary.responseTokens, 450);
  assert.equal(summary.totalTokens, 30600);
  assert.equal(summary.avgTps, 150);
  assert.equal(summary.avgStreamingTps, 200);
});

test('createStreamSpeedTracker 在流式生成期间输出估算 ~tok/s 并在结束时触发完成信号', () => {
  let nowMs = 1000;
  const tracker = createStreamSpeedTracker({ now: () => nowMs });

  assert.deepEqual(tracker.sample({ busy: false, text: '' }), { live: null, completed: false });

  // 进入等待首字状态
  const r1 = tracker.sample({ busy: true, text: '已有前文' });
  assert.equal(r1.completed, false);
  assert.equal(r1.live.active, true);
  assert.equal(r1.live.phase, 'waiting');
  assert.equal(r1.live.tps, null);

  // 首字出现（0.4s TTFT）
  nowMs = 1400;
  const r2 = tracker.sample({ busy: true, text: '已有前文abc' });
  assert.equal(r2.live.phase, 'streaming');
  assert.equal(r2.live.ttft, 0.4);
  assert.equal(r2.live.tps, null); // 刚出首字，时长与增量不足

  // 流式吐字 1.0s 后达到估算速度
  nowMs = 2400;
  const appended = 'A'.repeat(400); // 400 ASCII chars -> 100 tokens
  const r3 = tracker.sample({ busy: true, text: `已有前文abc${appended}` });
  assert.equal(r3.live.phase, 'streaming');
  assert.equal(r3.live.estimated, true);
  assert.ok(r3.live.tps >= 50 && r3.live.tps <= 150, `unexpected tps: ${r3.live.tps}`);
  assert.ok(r3.live.estimatedOutputTokens >= 95);

  // 结束生成：返回 completed: true 并清空状态
  nowMs = 2800;
  const r4 = tracker.sample({ busy: false, text: `已有前文abc${appended}` });
  assert.deepEqual(r4, { live: null, completed: true });
  assert.ok(estimateTextTokens('你好世界abcd') > 4);
});

test('normalizeContextSettings 默认放输入框下方并兼容旧版配置迁移', () => {
  assert.deepEqual(normalizeContextSettings({}), {
    displayLocation: 'composer',
    showSpeed: true,
    pollIntervalMs: 3000,
    warnThreshold: '240K',
    cliffThreshold: '328K',
    compactPolicy: 'remind',
    autoCompactOnCacheDrop: false,
    autoCompactCooldownMs: 300000
  });
  assert.equal(normalizeContextSettings({ showPulseCapsule: false }).displayLocation, 'topbar');
  assert.equal(normalizeContextSettings({ showSpeedInTopbar: false }).showSpeed, false);
  assert.equal(normalizeContextSettings({ displayLocation: 'composer', showPulseCapsule: false }).displayLocation, 'composer');
  assert.equal(normalizeContextSettings({ warnThresholdTokens: 180000 }).warnThreshold, '180000');
  assert.equal(normalizeContextSettings({ compactPolicy: 'idle_and_cliff' }).compactPolicy, 'idle_and_cliff');
});

test('parseThresholdSpec 与 resolveThresholdTokens 支持绝对值与百分比混用', () => {
  assert.deepEqual(parseThresholdSpec('240K'), { kind: 'tokens', value: 240000, label: '240K' });
  assert.deepEqual(parseThresholdSpec('0.5M'), { kind: 'tokens', value: 500000, label: '500K' });
  assert.deepEqual(parseThresholdSpec('50%'), { kind: 'percent', value: 50, label: '50%' });
  assert.equal(resolveThresholdTokens('50%', 512000), 256000);
  assert.equal(resolveThresholdTokens('70%', 1000000), 700000);
  assert.equal(resolveThresholdTokens('240K', 1000000), 240000);
  assert.equal(resolveThresholdTokens(180000, 1000000), 180000);
  assert.equal(resolveThresholdTokens('bad-value', 1000000, 240000), 240000);
  assert.equal(formatThresholdLabel('50%', 512000).shortLabel, '50%');
  assert.equal(formatThresholdLabel('328K', 512000).shortLabel, '328K');
});

test('buildCapsuleSegments 输出精简 icon+数字 分段，不含冗余中文标签', () => {
  assert.equal(formatSpeedCompact(170.7), '171/s');
  assert.equal(formatSpeedCompact(68.54), '68.5/s');

  const snap = {
    hasSession: true,
    used: 249000,
    budget: 512000,
    percent: 48.6,
    cacheHitRate: 98.5,
    cacheCliffRisk: 'warn',
    speed: { tps: 170.7, streamingTps: 264.2, ttft: 3.53 },
    sessionUsage: { totalTokens: 7960000, callsCount: 48, outputTokens: 64600 },
    alerts: [{ level: 'warn', message: '建议压缩上下文' }]
  };
  const segs = buildCapsuleSegments(snap, { showSpeed: true });
  assert.equal(segs.length, 4);
  assert.equal(segs[0].text, '249k/512k');
  assert.equal(segs[1].text, '7.96M');
  assert.equal(segs[2].text, '171/s');
  assert.equal(segs[3].kind, 'alert');
  assert.equal(segs[3].tone, 'warn');
  assert.equal(segs[3].text, '');
  const joined = segs.map((s) => s.text).join(' ');
  assert.equal(/窗口|本对话|断崖/.test(joined), false);

  const tip = buildCapsuleTooltip(snap);
  assert.match(tip, /上下文窗口/);
  assert.match(tip, /当前对话累计/);
  assert.match(tip, /点击展开详情/);
});

test('formatStatusBadge 隐藏正常态 reported 并汉化异常/流式状态', () => {
  assert.equal(formatStatusBadge({ status: 'reported' }, null), null);
  assert.equal(formatStatusBadge({ status: 'idle' }, null), null);
  assert.deepEqual(formatStatusBadge({ status: 'reported' }, { active: true }), { text: '流式生成中', tone: '' });
  assert.deepEqual(formatStatusBadge({ status: 'estimated' }, null), { text: '估算', tone: 'muted' });
  assert.deepEqual(formatStatusBadge({ status: 'exceeded' }, null), { text: '窗口超限', tone: 'danger' });
  assert.deepEqual(formatStatusBadge({ status: 'rate_limited' }, null), { text: '请求限流', tone: 'warn' });
  assert.deepEqual(formatStatusBadge({ status: 'network' }, null), { text: '网络异常', tone: 'danger' });
});

test('parseGeneratorCall 优先使用 stepTimestamps 与 fallbackTimestampMs，并识别 Neon 模型', () => {
  assert.equal(normalizeModelId('Gemini 4 Neon (High)'), 'gemini-4-neon');
  assert.equal(normalizeModelId('Orchestrator (Neon)'), 'gemini-4-neon');
  assert.equal(normalizeModelId('MODEL_PLACEHOLDER_M532'), 'gemini-4-neon');
  assert.equal(getContextLimitForModel('gemini-4-neon-high', 'Gemini 4 Neon (High)'), GEMINI_4_LIMIT);
  assert.equal(getContextLimitForModel('MODEL_PLACEHOLDER_M532'), GEMINI_4_LIMIT);

  const stepTimestamps = new Map([
    [10, Date.parse('2026-11-21T08:14:04Z')],
    [50, Date.parse('2026-11-23T03:00:00Z')]
  ]);
  const exactStep = parseGeneratorCall(
    {
      stepIndices: [10],
      chatModel: {
        model: 'Claude Opus 5.5 (High)',
        usage: { responseId: 'r1', inputTokens: 1000, outputTokens: 50 }
      }
    },
    'sess-ctx-1',
    'desktop',
    0,
    { stepTimestamps, fallbackTimestampMs: Date.parse('2026-11-23T05:00:00Z') }
  );
  assert.equal(exactStep.dateIsProvisional, false);
  assert.equal(exactStep.timestamp, Date.parse('2026-11-21T08:14:04Z'));

  const nearestStep = parseGeneratorCall(
    {
      stepIndices: [12],
      chatModel: {
        model: 'Gemini 4 Neon (High)',
        usage: { responseId: 'r2', inputTokens: 2000, outputTokens: 100 }
      }
    },
    'sess-ctx-1',
    'desktop',
    1,
    { stepTimestamps, fallbackTimestampMs: Date.parse('2026-11-23T05:00:00Z') }
  );
  assert.equal(nearestStep.dateIsProvisional, false);
  assert.equal(nearestStep.timestamp, Date.parse('2026-11-21T08:14:04Z'));

  const fallbackCall = parseGeneratorCall(
    {
      stepIndices: [1],
      chatModel: {
        model: 'gemini-3.8-flash',
        usage: { responseId: 'r3', inputTokens: 3000, outputTokens: 100 }
      }
    },
    'sess-ctx-2',
    'desktop',
    0,
    { fallbackTimestampMs: Date.parse('2026-11-20T04:00:00Z') }
  );
  assert.equal(fallbackCall.dateIsProvisional, true);
  assert.equal(fallbackCall.timestamp, Date.parse('2026-11-20T04:00:00Z'));
});
