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
  getContextLimitForModel,
  classifyRequestError,
  summarizeMetadata,
  analyzeTrajectorySteps,
  extractCallId,
  parseGeneratorCall,
  getRingAccentToken
} = require('../src/context-analyzer');
const { auditAttachments } = require('../src/attachment-audit');

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
  assert.match(getRingAccentToken(10, {}), /#a78bfa/);
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
