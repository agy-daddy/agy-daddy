'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const {
  parseQuotaFraction,
  computeUsedFraction,
  formatQuotaDisplayPercent,
  formatQuotaResetMeta,
  buildModelQuotaSnapshot,
  getQuotaAccentToken,
  DEFAULT_CAPSULE_COLOR_RULES,
  serializeCapsuleColorRule,
  parseCapsuleColorRule,
  evaluateCapsuleColorRules
} = require('../src/quota-engine');

test('parseQuotaFraction / formatQuotaResetMeta 与共享池分组解析', () => {
  // quota_summary_bucket 缺省字段不得误判耗尽
  const missingBucket = parseQuotaFraction({ resetTime: '2026-11-22T00:00:00Z' }, { schemaKind: 'quota_summary_bucket' });
  assert.equal(missingBucket.fraction, null);
  assert.equal(missingBucket.isExhausted, false);

  // codeium_quota_info scalar float 省略 0 + resetTime -> 耗尽
  const protoZero = parseQuotaFraction({ resetTime: '2026-11-22T00:00:00Z' }, { schemaKind: 'codeium_quota_info' });
  assert.equal(protoZero.fraction, 0);
  assert.equal(protoZero.isExhausted, true);

  // amount / total ratio
  const ratio = parseQuotaFraction({ remainingAmount: '30', totalAmount: '100' });
  assert.equal(ratio.fraction, 0.3);
  assert.equal(computeUsedFraction(0.3), 0.7);
  assert.equal(formatQuotaDisplayPercent(0.3, 'remaining'), '30%');
  assert.equal(formatQuotaDisplayPercent(0.3, 'used'), '70%');

  const nowMs = Date.parse('2026-11-21T10:00:00Z');
  const cd = formatQuotaResetMeta('2026-11-21T12:30:00Z', nowMs);
  assert.equal(cd.countdownText, '2小时30分');

  const snap = buildModelQuotaSnapshot({
    nowMs,
    quotaSummaryRes: {
      groups: [
        {
          groupId: 'gemini_main',
          displayName: 'Gemini',
          buckets: [
            { window: '5h', remainingFraction: 0.85, resetTime: '2026-11-21T13:00:00Z' },
            { window: 'weekly', remainingFraction: 0.60, resetTime: '2026-11-25T00:00:00Z' }
          ]
        },
        { groupId: '3p_pool', displayName: 'Claude / 3P', buckets: [{ window: 'weekly', remainingFraction: 0.15, resetTime: '2026-11-25T00:00:00Z' }] }
      ]
    }
  });
  assert.equal(snap.gemini.percentText, '60%');
  assert.equal(snap.gemini.usedPercentText, '40%');
  assert.equal(snap.pools[0].fiveHourBucket.percentText, '85%');
  assert.equal(snap.pools[0].weeklyBucket.percentText, '60%');
  assert.equal(snap.pools[0].tightestPercentText, '剩余最少 60%');
  assert.equal(snap.pools[0].highestUsedPercentText, '已用最多 40%');
  assert.equal(snap.claude.percentText, '15%');
  assert.equal(snap.tightestPercentText, '剩余最少 15%');
  assert.equal(snap.highestUsedPercentText, '已用最多 85%');
  assert.match(getQuotaAccentToken(0.85), /#71717a|currentColor/);
  assert.match(getQuotaAccentToken(0.15), /#ef4444/);
});

test('胶囊颜色规则解析、序列化、优先级匹配与禁用语义', () => {
  const canonical = parseCapsuleColorRule('claude_weekly:remaining<=20:#8b5cf6');
  assert.ok(canonical);
  assert.equal(canonical.target, 'claude_weekly');
  assert.equal(canonical.metric, 'remaining');
  assert.equal(canonical.operator, 'lte');
  assert.equal(canonical.threshold, 20);
  assert.equal(canonical.color, '#8b5cf6');
  assert.equal(canonical.summary, 'Claude Week 剩余 ≤ 20%');
  assert.equal(serializeCapsuleColorRule(canonical), 'claude_weekly:remaining<=20:#8b5cf6');

  const shorthand1 = parseCapsuleColorRule('claude_weekly <= 20% -> purple');
  assert.equal(shorthand1?.color, '#8b5cf6');
  assert.equal(shorthand1?.raw, 'claude_weekly:remaining<=20:#8b5cf6');

  const shorthand2 = parseCapsuleColorRule('gemini_5h used >= 80% #3b82f6');
  assert.equal(shorthand2?.target, 'gemini_5h');
  assert.equal(shorthand2?.metric, 'used');
  assert.equal(shorthand2?.operator, 'gte');
  assert.equal(shorthand2?.threshold, 80);
  assert.equal(shorthand2?.color, '#3b82f6');
  assert.equal(shorthand2?.summary, 'Gemini 5H 已用 ≥ 80%');

  const snap = buildModelQuotaSnapshot({
    nowMs: Date.parse('2026-11-21T10:00:00Z'),
    quotaSummaryRes: {
      groups: [
        {
          groupId: 'shared_gemini_main',
          displayName: 'Gemini Pool',
          buckets: [
            { window: '5h', remainingFraction: 0.72, resetTime: '2026-11-21T13:00:00Z' },
            { window: 'weekly', remainingFraction: 0.85, resetTime: '2026-11-25T00:00:00Z' }
          ]
        },
        {
          groupId: 'shared_3p_pool',
          displayName: 'Claude Pool',
          buckets: [
            { window: '5h', remainingFraction: 0.90, resetTime: '2026-11-21T13:00:00Z' },
            { window: 'weekly', remainingFraction: 0.45, resetTime: '2026-11-25T00:00:00Z' }
          ]
        }
      ]
    }
  });

  // 按顺序匹配，第一条命中生效
  const r1 = evaluateCapsuleColorRules(snap, [
    'claude_weekly:remaining<=50:#8b5cf6',
    'gemini_5h:used>=25:#22c55e'
  ]);
  assert.equal(r1.matched, true);
  assert.equal(r1.color, '#8b5cf6');
  assert.equal(r1.matchedWindowKey, 'weekly');

  const r2 = evaluateCapsuleColorRules(snap, [
    'gemini_5h:used>=25:#22c55e',
    'claude_weekly:remaining<=50:#8b5cf6'
  ]);
  assert.equal(r2.matched, true);
  assert.equal(r2.color, '#22c55e');
  assert.equal(r2.matchedWindowKey, '5h');

  // any_weekly 精确筛选 weekly 窗口
  const r3 = evaluateCapsuleColorRules(snap, ['any_weekly:remaining<=50:#3b82f6']);
  assert.equal(r3.matched, true);
  assert.equal(r3.color, '#3b82f6');

  // 空数组明确关闭规则着色
  const rEmpty = evaluateCapsuleColorRules(snap, []);
  assert.deepEqual(rEmpty, { matched: false, color: '', tone: '', rule: null });
});

test('插件契约：主题门禁、isolated 隔离世界、统一 Popover 包壳、5H/Week 倒计时、已用/剩余切换、自定义颜色规则与零残留 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
  }

  const onRpc = (method) => {
    if (method === 'RetrieveUserQuotaSummary') {
      return {
        groups: [
          {
            groupId: 'shared_gemini_main',
            displayName: 'Gemini Pool',
            buckets: [
              { window: '5h', remainingFraction: 0.72, resetTime: new Date(Date.now() + 3600000).toISOString() },
              { window: 'weekly', remainingFraction: 0.85, resetTime: new Date(Date.now() + 3 * 86400000).toISOString() }
            ]
          },
          {
            groupId: 'shared_3p_pool',
            displayName: 'Claude Pool',
            buckets: [
              { window: '5h', remainingFraction: 0.90, resetTime: new Date(Date.now() + 7200000).toISOString() },
              { window: 'weekly', remainingFraction: 0.45, resetTime: new Date(Date.now() + 2 * 86400000).toISOString() }
            ]
          }
        ]
      };
    }
    return { userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } };
  };

  const harness = createMockHostHarness({ onRpc });
  try {
    const { port, hostToken } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port, hostToken });

    // 监听跨世界 state:quota.snapshot@1 广播（供 context 胶囊等消费）
    const observedQuotaStates = [];
    await harness.rendererHost.mountPlugin('test.quota.obs', {
      mount(ctx) {
        ctx.state.subscribe('state:quota.snapshot@1', (val) => observedQuotaStates.push(val));
      }
    });

    // 1. 不装 usage/subscription 在 isolated 隔离世界独立启动
    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.equal(loaded.manifest.world, 'isolated');
    assert.equal(loaded.trust.world, 'isolated');
    assert.equal((loaded.manifest.permissions || []).includes('page:main-world'), false);
    assert.equal('migrations' in (loaded.manifest.contributes || {}), false);

    const quotaSvc = harness.bus.getServiceProxy('quota');
    const st1 = await quotaSvc.getSnapshot();
    assert.equal(st1.ultraSubTier, null);
    assert.equal(st1.quotaMultiplier, 1);
    assert.equal(st1.gemini.percentText, '72%');
    assert.equal(st1.claude.percentText, '45%');

    const mob1 = await quotaSvc.getMobileSnapshot();
    assert.equal(mob1.gemini.fiveHour.remainingPercent, 72);
    assert.equal(mob1.gemini.weekly.remainingPercent, 85);
    assert.equal(mob1.claude.fiveHour.remainingPercent, 90);
    assert.equal(mob1.claude.weekly.remainingPercent, 45);
    assert.ok(mob1.gemini.fiveHour.countdownText);
    assert.ok(mob1.claude.weekly.countdownText);

    // 验证 isolated renderer 已发布 state:quota.snapshot@1 给跨世界订阅者
    assert.ok(observedQuotaStates.length >= 1);
    assert.equal(observedQuotaStates[observedQuotaStates.length - 1].gemini.percentText, '72%');

    const shadowRoot = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
    const barChildren = shadowRoot.querySelector('#agy-topbar-slots').children;
    const quotaBtn = barChildren.find((c) => c.id === 'agy-unit-agy-daddy.quota-quota');
    assert.ok(quotaBtn);
    assert.match(quotaBtn.textContent, /G:72%.*C:45%/);
    assert.match(quotaBtn.textContent, /5H:/);
    assert.match(quotaBtn.textContent, /W:/);

    // 验证自定义颜色规则：Claude Week <= 50% -> 紫色 (#8b5cf6)
    await harness.updatePluginSettings('agy-daddy.quota', {
      capsuleColorRules: ['claude_weekly:remaining<=50:#8b5cf6', 'gemini_5h:used>=25:#22c55e']
    });
    assert.equal(quotaBtn.getAttribute('data-custom-color'), '#8b5cf6');
    assert.match(quotaBtn.getAttribute('title') || '', /Claude Week/);

    // 调整顺序让 Gemini 5H 已用 >= 25% -> 绿色 (#22c55e) 在前
    await harness.updatePluginSettings('agy-daddy.quota', {
      capsuleColorRules: ['gemini_5h:used>=25:#22c55e', 'claude_weekly:remaining<=50:#8b5cf6']
    });
    assert.equal(quotaBtn.getAttribute('data-custom-color'), '#22c55e');

    // 清空规则则取消自定义胶囊颜色
    await harness.updatePluginSettings('agy-daddy.quota', {
      capsuleColorRules: []
    });
    assert.equal(quotaBtn.getAttribute('data-custom-color'), null);

    // 验证托管配置实时生效：off / 5h / weekly / both 四态倒计时切换
    await harness.updatePluginSettings('agy-daddy.quota', {
      topbarCountdownMode: 'off',
      pollIntervalMs: 15000
    });
    assert.doesNotMatch(quotaBtn.textContent, /\(/);

    await harness.updatePluginSettings('agy-daddy.quota', {
      topbarCountdownMode: '5h'
    });
    assert.match(quotaBtn.textContent, /\(5H:/);
    assert.doesNotMatch(quotaBtn.textContent, /W:/);

    await harness.updatePluginSettings('agy-daddy.quota', {
      topbarCountdownMode: 'weekly'
    });
    assert.match(quotaBtn.textContent, /\(W:/);
    assert.doesNotMatch(quotaBtn.textContent, /5H:/);

    await harness.updatePluginSettings('agy-daddy.quota', {
      topbarCountdownMode: 'both'
    });
    assert.match(quotaBtn.textContent, /\(5H:.*W:/);

    // 验证统一 Popover 包壳与标题「额度监控」（宿主渲染 .ag-panel-head + ⚙ + ✕，插件内容区不重复绘制）
    const outerPopover = shadowRoot.querySelector('[data-agy-popover="agy-daddy.quota:quota-panel"]');
    assert.ok(outerPopover);
    assert.match(outerPopover.querySelector('.ag-panel-title')?.textContent || outerPopover.textContent, /额度监控/);
    assert.ok(outerPopover.querySelector('.ag-popover-settings-btn'));
    assert.ok(outerPopover.querySelector('.ag-popover-close-btn'));

    const quotaPanel = shadowRoot.querySelector('#agy-quota-panel');
    assert.ok(quotaPanel);
    assert.equal(quotaPanel.querySelector('.ag-panel-head'), null, 'Plugin body must not duplicate .ag-panel-head');
    assert.equal(quotaPanel.querySelector('[data-quota-rules-toggle]'), null, 'Popover must keep rules configuration in Settings page');
    assert.equal(quotaPanel.querySelector('[data-quota-rules-editor]'), null);
    assert.match(quotaPanel.textContent, /剩余最少 45%/);
    assert.match(quotaPanel.textContent, /5h 剩余:/);
    assert.match(quotaPanel.textContent, /每周 剩余:/);

    // 打开宿主统一「设置页面」中的额度监控详情页，验证颜色规则可视化编辑器与顶栏实时联动
    const quotaSchema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'settings.schema.json'), 'utf8'));
    harness.rendererHost.configure({
      pluginMeta: {
        'agy-daddy.quota': {
          id: 'agy-daddy.quota',
          displayName: '额度监控',
          version: loaded.manifest.version,
          trustLevel: 'T0',
          settingsSchema: quotaSchema,
          settingsValues: harness.getPluginSettings('agy-daddy.quota')
        }
      }
    });
    await harness.rendererHost.openSettings({ tab: 'plugins', pluginId: 'agy-daddy.quota' });
    const ruleEditor = shadowRoot.querySelector('[data-rule-editor="capsuleColorRules"]');
    assert.ok(ruleEditor, 'Expected capsuleColorRules visual rule editor in Settings page');

    const targetSel = ruleEditor.querySelector('[data-rule-target="capsuleColorRules"]');
    const metricSel = ruleEditor.querySelector('[data-rule-metric="capsuleColorRules"]');
    const thrInput = ruleEditor.querySelector('[data-rule-threshold="capsuleColorRules"]');
    const blueSwatch = ruleEditor.querySelector('[data-rule-color-preset="capsuleColorRules:#3b82f6"]');
    targetSel.value = 'claude_weekly';
    metricSel.value = 'remaining<=';
    thrInput.value = '50';
    blueSwatch.click();

    const addRuleBtn = ruleEditor.querySelector('[data-list-add="capsuleColorRules"]');
    assert.ok(addRuleBtn);
    addRuleBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(
      harness.getPluginSettings('agy-daddy.quota').capsuleColorRules,
      ['claude_weekly:remaining<=50:#3b82f6']
    );
    assert.equal(quotaBtn.getAttribute('data-custom-color'), '#3b82f6');

    // 直接在设置页原地编辑该条规则的阈值和颜色
    const inlineThr = shadowRoot.querySelector('[data-rule-item-threshold="capsuleColorRules:0"]');
    assert.ok(inlineThr);
    inlineThr.value = '48';
    inlineThr.dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(
      harness.getPluginSettings('agy-daddy.quota').capsuleColorRules,
      ['claude_weekly:remaining<=48:#3b82f6']
    );

    const inlineColor = shadowRoot.querySelector('[data-rule-item-color="capsuleColorRules:0"]');
    assert.ok(inlineColor);
    inlineColor.value = '#ec4899';
    inlineColor.dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(
      harness.getPluginSettings('agy-daddy.quota').capsuleColorRules,
      ['claude_weekly:remaining<=48:#ec4899']
    );
    assert.equal(quotaBtn.getAttribute('data-custom-color'), '#ec4899');

    const resetRulesBtn = shadowRoot.querySelector('[data-rule-reset="capsuleColorRules"]');
    assert.ok(resetRulesBtn);
    resetRulesBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(
      harness.getPluginSettings('agy-daddy.quota').capsuleColorRules,
      [...DEFAULT_CAPSULE_COLOR_RULES]
    );
    assert.equal(quotaBtn.getAttribute('data-custom-color'), null);
    await harness.rendererHost.closeSettings();

    // 切换为「已使用额度」显示模式并验证顶栏与面板即时更新
    await harness.updatePluginSettings('agy-daddy.quota', {
      quotaDisplayMode: 'used'
    });
    assert.match(quotaBtn.textContent, /G:28%.*C:55%/);
    assert.match(quotaPanel.textContent, /已用最多 55%/);
    assert.match(quotaPanel.textContent, /5h 已用:/);
    assert.match(quotaPanel.textContent, /每周 已用:/);

    // 切回「剩余额度」
    await harness.updatePluginSettings('agy-daddy.quota', {
      quotaDisplayMode: 'remaining'
    });
    assert.match(quotaBtn.textContent, /G:72%.*C:45%/);
    assert.match(quotaPanel.textContent, /剩余最少 45%/);

    // 2. 上线 subscription 服务后补齐 Ultra 20x 倍率，并通过面板刷新按钮同步 UI
    harness.bus.provideService('agy-daddy.usage', 'subscription', {
      getUltraSubTier: () => '20x'
    }, { realm: 'node' });
    const st2 = await quotaSvc.refresh();
    assert.equal(st2.ultraSubTier, '20x');
    assert.equal(st2.quotaMultiplier, 20);

    const refreshBtn = quotaPanel.querySelector('button.ag-btn-primary');
    assert.ok(refreshBtn);
    refreshBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.match(quotaPanel.textContent, /Ultra 20x \(20x\)/);

    await harness.rendererHost.disposePlugin('test.quota.obs');
    await harness.unloadPlugin('agy-daddy.quota');
    assert.equal(shadowRoot.querySelector('style[data-agy-style="agy-daddy.quota"]'), null);
    harness.assertCleanDispose('agy-daddy.quota');
  } finally {
    await harness.cleanup();
  }
});
