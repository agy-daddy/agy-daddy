'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness, createMockElement } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const { HIGH_RISK_RULES, detectHighRiskLabels, shouldBlockAutoAccept } = require('../src/high-risk-guard');
const {
  QUICK_PROMPT_GROUPS,
  BUILTIN_QUICK_POOL,
  truncateGhostLabel,
  selectOptimizerCandidates,
  optimizePromptText,
  exportConversationMarkdown
} = require('../src/quick-prompts');

test('全量 14 项快捷指令池、快模型候选筛选、高危命令 9 类规则与 Markdown 导出', () => {
  assert.equal(BUILTIN_QUICK_POOL.length, 14);
  assert.deepEqual(QUICK_PROMPT_GROUPS.map((g) => g.id), ['daily', 'heavy', 'tools']);
  assert.equal(BUILTIN_QUICK_POOL.filter((i) => i.group === 'daily').length, 5);
  assert.equal(BUILTIN_QUICK_POOL.filter((i) => i.group === 'heavy').length, 6);
  assert.equal(BUILTIN_QUICK_POOL.filter((i) => i.group === 'tools').length, 3);

  assert.equal(truncateGhostLabel('继续验证关键路径', 8), '继续验证关键路径');
  assert.equal(truncateGhostLabel('定位具体失败用例并修复', 8), '定位具体失败用例…');

  // 快模型优先且跳过耗尽模型
  const cands = selectOptimizerCandidates([
    { model: 'gemini-4-hydrogen', maxTokens: 1048576 },
    { model: 'gemini-3.5-flash-lite', maxTokens: 1048576 },
    { model: 'claude-sonnet-5-5', maxTokens: 200000 }
  ], { claude: { isExhausted: true }, gemini: { isExhausted: false } });
  assert.equal(cands[0].model, 'gemini-3.5-flash-lite');
  assert.equal(cands.some((c) => c.model.includes('claude')), false);

  assert.equal(HIGH_RISK_RULES.length, 9);
  const dangerous = [
    'rm -rf ./dist',
    'git reset --hard HEAD~1',
    'git clean -fd',
    'git push origin main --force',
    'git checkout -- .',
    'sudo chmod 777 /etc/hosts',
    'pkill -9 node',
    'DROP TABLE users;',
    'op item delete my-secret'
  ];
  for (const cmd of dangerous) {
    const res = shouldBlockAutoAccept(cmd);
    assert.equal(res.blocked, true, `Expected blocked: ${cmd}`);
    assert.ok(res.labels.length >= 1);
  }
  assert.equal(detectHighRiskLabels('npm test && git status').length, 0);

  assert.match(optimizePromptText('修一下登录报错'), /请先定位相关代码/);
  const md = exportConversationMarkdown([
    { userInput: { userResponse: '你好' } },
    { plannerResponse: { thinking: '思考', response: '搞定' } }
  ], { cascadeId: 'cid-9', model: 'gemini-4' });
  assert.match(md, /Session ID: `cid-9`/);
  assert.match(md, /<summary>Thinking<\/summary>/);
});

test('插件契约：14 项快捷栏 + 自定义增删、✨优化/↩撤回、Tab/Esc 幽灵建议、安全默认全关、高危红框拦截与零残留 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
  }

  const harness = createMockHostHarness({
    seedAnchors: [
      { tag: 'button', attr: 'data-testid', val: 'agent-response' }
    ]
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0', inProcessRenderer: true });

    const quickBar = harness.mockDoc.getElementById('agy-quick-capsule-bar');
    assert.ok(quickBar);
    assert.ok(harness.mockDoc.getElementById('agy-qcap-compact'));
    assert.ok(harness.mockDoc.getElementById('agy-qcap-export'));

    let composerApi = null;
    const highRiskEvents = [];
    const compactEvents = [];
    let emitSnap = null;
    await harness.rendererHost.mountPlugin('test.consumer', {
      mount(ctx) {
        composerApi = ctx.services.get('composer');
        ctx.events.on('composer:high-risk-detected@1', (p) => highRiskEvents.push(p));
        ctx.events.on('composer:auto-compact-triggered@1', (p) => compactEvents.push(p));
        emitSnap = (s) => ctx.state.set('state:context.snapshot@1', s);
      }
    });

    // 1. 验证 Node 侧自定义快捷提示词 CRUD
    const composerNode = harness.bus.getServiceProxy('composer-node');
    const added = await composerNode.addCustomPrompt({ id: 'my-check', label: '自检', text: '请先运行完整测试' });
    assert.equal(added.ok, true);
    assert.equal((await composerNode.listQuickPrompts()).builtins.length, 14);
    assert.equal((await composerNode.removeCustomPrompt('my-check')).removed, true);

    // 2. ✨ 优化 -> ↩ 撤回 -> 手动输入清除撤回
    const editor = harness.mockDoc.querySelector('[contenteditable="true"]');
    editor.textContent = '修一下代理';
    harness.mockDoc.getElementById('agy-prompt-opt-btn').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.match(editor.textContent, /请先定位相关代码/);
    const undoBtn = harness.mockDoc.getElementById('agy-prompt-undo-btn');
    assert.equal(undoBtn.hidden, false);
    undoBtn.click();
    assert.equal(editor.textContent, '修一下代理');
    assert.equal(undoBtn.hidden, true);

    // 3. Tab 下一步建议（8字截断 + ↑/↓切换 + Tab填入）
    editor.textContent = '';
    const ghostEl = harness.mockDoc.getElementById('agy-next-step-ghost');
    assert.equal(ghostEl.textContent, '继续验证关键路径');
    harness.mockDoc.dispatchEvent({ type: 'keydown', key: 'ArrowDown', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
    assert.equal(ghostEl.textContent, '汇总变更与测试结…');
    assert.equal(ghostEl.getAttribute('data-full-suggestion'), '汇总变更与测试结果');
    harness.mockDoc.dispatchEvent({ type: 'keydown', key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
    assert.equal(ghostEl.hidden, true);
    composerApi.cycleGhostSuggestion(0);
    assert.equal(ghostEl.hidden, false);
    harness.mockDoc.dispatchEvent({ type: 'keydown', key: 'Tab', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
    assert.equal(editor.textContent, '汇总变更与测试结果');
    editor.textContent = '';

    // 4. 安全默认全关 + 高危命令红框强拦截
    const s0 = composerApi.getSettings();
    assert.equal(s0.autoAccept, false);
    assert.equal(s0.autoCompact, false);

    composerApi.updateSettings({ autoAccept: true });
    let safeClicked = 0;
    let dangerClicked = 0;
    const dangerBtn = createMockElement('button', harness.mockDoc);
    dangerBtn.click = () => { dangerClicked++; };
    const safeBtn = createMockElement('button', harness.mockDoc);
    safeBtn.click = () => { safeClicked++; };

    const dangerEval = composerApi.evaluateActionApproval(dangerBtn, 'rm -rf /tmp/prod');
    assert.equal(dangerEval.blocked, true);
    assert.equal(dangerClicked, 0);
    assert.equal(dangerBtn.style.getPropertyValue('border-color'), '#ef4444');
    assert.equal(highRiskEvents.length, 1);

    const safeEval = composerApi.evaluateActionApproval(safeBtn, 'npm test');
    assert.equal(safeEval.executed, true);
    assert.equal(safeClicked, 1);

    // 5. 240K / 丢缓存自动压缩 + quickActions 扩展表面 + dispose
    const sendBtn = harness.mockDoc.querySelector('[data-testid="input-send-button"]');
    const sentTexts = [];
    sendBtn.addEventListener('click', () => sentTexts.push(editor.textContent));

    assert.equal(composerApi.evaluateContextSnapshot({ used: 260000 }).triggered, false);
    composerApi.updateSettings({ autoCompact: true });

    const cancelBtn = createMockElement('button', harness.mockDoc);
    cancelBtn.setAttribute('data-testid', 'input-cancel-button');
    harness.mockDoc.body.appendChild(cancelBtn);
    assert.equal(composerApi.evaluateContextSnapshot({ used: 260000 }).reason, 'assistant_busy');
    cancelBtn.remove();

    emitSnap({ used: 250000 });
    assert.deepEqual(sentTexts, ['/compact']);
    assert.equal(compactEvents.length, 1);

    const rmExt = composerApi.registerQuickAction({ id: 'my-ext', label: 'ExtBtn' });
    assert.ok(harness.mockDoc.getElementById('agy-qcap-ext-my-ext'));
    rmExt();
    assert.equal(harness.mockDoc.getElementById('agy-qcap-ext-my-ext'), null);

    await harness.rendererHost.disposePlugin('test.consumer');
    await harness.unloadPlugin('agy-daddy.composer');
    assert.equal(harness.mockDoc.getElementById('agy-quick-capsule-bar'), null);
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    await harness.cleanup();
  }
});
