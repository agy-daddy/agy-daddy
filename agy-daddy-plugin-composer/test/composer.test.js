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
  parseSlashCommandText,
  selectOptimizerCandidates,
  optimizePromptText
} = require('../src/quick-prompts');

test('全量 12 项快捷指令池、快模型候选筛选与高危命令 9 类规则', () => {
  assert.equal(BUILTIN_QUICK_POOL.length, 12);
  assert.deepEqual(QUICK_PROMPT_GROUPS.map((g) => g.id), ['daily', 'heavy', 'tools']);
  assert.equal(BUILTIN_QUICK_POOL.filter((i) => i.group === 'daily').length, 5);
  assert.equal(BUILTIN_QUICK_POOL.filter((i) => i.group === 'heavy').length, 6);
  assert.equal(BUILTIN_QUICK_POOL.filter((i) => i.group === 'tools').length, 1);

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
});

test('微内核契约 v2：isolated 世界、样式自注入、ctx.surfaces(composer.quickActions)、托管设置与命令、高危红框拦截、240K 自动压缩与零残留 dispose', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'agy-plugin.json'), 'utf8'));
  assert.equal(manifest.world, 'isolated');
  assert.equal((manifest.permissions || []).includes('page:main-world'), false);
  assert.equal(manifest.contributes?.migrations, undefined);

  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
    assert.equal(src.includes('registerSection'), false, `${file} must not use registerSection`);
  }

  const rpcCalls = [];
  const harness = createMockHostHarness({
    seedAnchors: [
      { tag: 'button', attr: 'data-testid', val: 'agent-response' }
    ],
    onRpc(method, body) {
      rpcCalls.push({ method, body });
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { modelId: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (High)', modelOrAlias: { model: 'CLAUDE_SONNET_4_5' }, quotaInfo: { remainingFraction: 1 } },
                { modelId: 'gemini-2.5-flash-low', label: 'Gemini 2.5 Flash (Low)', modelOrAlias: { model: 'GEMINI_2_5_FLASH_LOW' }, quotaInfo: { remainingFraction: 1 } }
              ]
            }
          }
        };
      }
      if (method === 'GetModelResponse') {
        return { response: '请先定位代理配置与报错位置，再执行修复并附带回归验证' };
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.equal(loaded.trust.world, 'isolated');
    assert.ok(harness.isolatedWorlds.has('agy-daddy.composer'));

    // 验证样式自注入（单行快捷栏 + 发送上方优化图标 + 感知提示样式）
    const styleEl = harness.mockDoc.head.querySelector('[data-agy-style="agy-daddy.composer"]');
    assert.ok(styleEl);
    assert.match(styleEl.textContent, /#agy-quick-capsule-bar/);
    assert.match(styleEl.textContent, /flex-wrap:\s*nowrap/);
    assert.match(styleEl.textContent, /#agy-prompt-opt-wrap/);
    assert.match(styleEl.textContent, /#agy-next-step-ghost/);

    // 验证私有 /settings 路由已删除
    const legacyResp = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.composer/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AGY-Plugin-Token': loaded.pluginToken },
      body: '{}'
    });
    assert.equal(legacyResp.status, 404);

    // 验证已注册声明式命令
    const compactCmd = await harness.executeCommand('composer.compact');
    assert.equal(compactCmd.ok, true);
    assert.equal(compactCmd.text, '/compact');

    const quickBar = harness.mockDoc.getElementById('agy-quick-capsule-bar');
    assert.ok(quickBar);
    assert.equal(quickBar.getAttribute('data-agy-surface'), 'composer.quickActions');
    // 验证快捷栏挂载于输入框上方（紧邻 .surface-composer 之前）
    const composerEl = harness.mockDoc.querySelector('.surface-composer');
    const parentChildren = Array.from(composerEl.parentElement.children);
    assert.equal(parentChildren.indexOf(quickBar), parentChildren.indexOf(composerEl) - 1);
    assert.ok(harness.mockDoc.getElementById('agy-qcap-compact'));
    assert.equal(harness.mockDoc.getElementById('agy-qcap-copyid'), null);
    assert.equal(harness.mockDoc.getElementById('agy-qcap-export'), null);

    let composerApi = null;
    const highRiskEvents = [];
    let emitSnap = null;
    await harness.rendererHost.mountPlugin('test.consumer', {
      mount(ctx) {
        composerApi = ctx.services.get('composer');
        ctx.events.on('composer:high-risk-detected@1', (p) => highRiskEvents.push(p));
        emitSnap = (s) => ctx.state.set('state:context.snapshot@1', s);
        ctx.surfaces.mount('composer.quickActions', (slotEl) => {
          const extBtn = createMockElement('button', harness.mockDoc);
          extBtn.id = 'ext-surface-quick-btn';
          extBtn.textContent = 'ExtSurface';
          slotEl.appendChild(extBtn);
          return () => extBtn.remove();
        });
      }
    });

    // 验证外部插件通过 ctx.surfaces.mount('composer.quickActions') 挂载，且设置重渲染不覆盖
    assert.ok(quickBar.querySelector('#ext-surface-quick-btn'));

    // 1. 验证 Node 侧自定义快捷提示词 CRUD（不与托管 settings.json 冲突）
    const composerNode = harness.bus.getServiceProxy('composer-node');
    const added = await composerNode.addCustomPrompt({ id: 'my-check', label: '自检', text: '请先运行完整测试' });
    assert.equal(added.ok, true);
    assert.equal((await composerNode.listQuickPrompts()).builtins.length, 12);
    assert.equal((await composerNode.removeCustomPrompt('my-check')).removed, true);

    // 2. ✨ 优化（位于发送按键上方 + SVG 图标 + 撤回替代优化 + 撤回恢复）
    const optWrap = harness.mockDoc.getElementById('agy-prompt-opt-wrap');
    const optBtn = harness.mockDoc.getElementById('agy-prompt-opt-btn');
    const undoBtn = harness.mockDoc.getElementById('agy-prompt-undo-btn');
    assert.ok(optWrap);
    assert.equal(quickBar.querySelector('#agy-prompt-opt-btn'), null, '优化按钮不再放在快捷栏内');
    assert.equal(optWrap.parentElement, composerEl);
    const sendBtnEl = harness.mockDoc.querySelector('[data-testid="input-send-button"]');
    const compKids = Array.from(composerEl.children);
    assert.equal(compKids.indexOf(optWrap), compKids.indexOf(sendBtnEl) - 1, '优化按钮包裹容器应紧邻发送按键上方');
    assert.match(optBtn.innerHTML, /<svg\b/);

    const editor = harness.mockDoc.querySelector('[contenteditable="true"]');
    editor.textContent = '修一下代理';
    harness.mockDoc.dispatchEvent({ type: 'input', target: editor });
    optBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.match(editor.textContent, /请先定位代理配置/);
    const modelCall = rpcCalls.find((c) => c.method === 'GetModelResponse');
    assert.ok(modelCall);
    assert.equal(modelCall.body.model, 'GEMINI_2_5_FLASH_LOW');
    assert.match(modelCall.body.prompt, /修一下代理/);
    // 生效后撤回按钮替代优化按钮（优化按钮隐藏、撤回按钮显示且为 SVG 图标）
    assert.equal(optBtn.hidden, true);
    assert.equal(undoBtn.hidden, false);
    assert.match(undoBtn.innerHTML, /<svg\b/);
    undoBtn.click();
    assert.equal(editor.textContent, '修一下代理');
    assert.equal(undoBtn.hidden, true);
    assert.equal(optBtn.hidden, false);

    // 3. 最右侧「感知提示」（含快捷键提示 Tab / → + ↑/↓ 切换 + Esc 隐藏 + Tab 填入）
    editor.textContent = '';
    const ghostEl = harness.mockDoc.getElementById('agy-next-step-ghost');
    assert.equal(ghostEl.querySelector('.agy-ns-prefix').textContent, '感知提示');
    assert.equal(ghostEl.querySelector('.agy-ns-kbd').textContent, 'Tab / →');
    assert.equal(ghostEl.querySelector('.agy-ns-text').textContent, '先帮我梳理下当前…');
    assert.equal(ghostEl.getAttribute('data-full-suggestion'), '先帮我梳理下当前任务并给出方案');
    harness.mockDoc.dispatchEvent({ type: 'keydown', key: 'ArrowDown', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
    assert.equal(ghostEl.querySelector('.agy-ns-text').textContent, '/plan');
    assert.equal(ghostEl.getAttribute('data-full-suggestion'), '/plan');
    harness.mockDoc.dispatchEvent({ type: 'keydown', key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
    assert.equal(ghostEl.hidden, true);
    await composerApi.cycleGhostSuggestion(0);
    assert.equal(ghostEl.hidden, false);
    harness.mockDoc.dispatchEvent({ type: 'keydown', key: 'Tab', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false });
    assert.equal(editor.textContent, '/plan');
    editor.textContent = '';

    // 4. 安全默认全关 + 托管设置热开启 autoAccept + 高危命令红框强拦截
    const s0 = await composerApi.getSettings();
    assert.equal(s0.autoAccept, false);
    assert.equal('autoCompact' in s0, false);

    await harness.updatePluginSettings('agy-daddy.composer', { autoAccept: true });
    // 设置热更新重渲染后，外部 surface 挂载按钮依然存活
    assert.ok(harness.mockDoc.getElementById('agy-quick-capsule-bar').querySelector('#ext-surface-quick-btn'));

    let safeClicked = 0;
    let dangerClicked = 0;
    const dangerBtn = createMockElement('button', harness.mockDoc);
    dangerBtn.id = 'test-danger-action-btn';
    dangerBtn.textContent = 'Run';
    dangerBtn.setAttribute('data-command', 'rm -rf /tmp/prod');
    dangerBtn.click = () => { dangerClicked++; };
    harness.mockDoc.body.appendChild(dangerBtn);

    const safeBtn = createMockElement('button', harness.mockDoc);
    safeBtn.id = 'test-safe-action-btn';
    safeBtn.textContent = 'Accept';
    safeBtn.setAttribute('data-command', 'npm test');
    safeBtn.click = () => { safeClicked++; };
    harness.mockDoc.body.appendChild(safeBtn);

    const dangerEval = await composerApi.evaluateActionApproval('#test-danger-action-btn', 'rm -rf /tmp/prod');
    assert.equal(dangerEval.blocked, true);
    assert.equal(dangerClicked, 0);
    assert.equal(dangerBtn.style.getPropertyValue('border-color'), '#ef4444');
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(highRiskEvents.length, 1);

    const safeEval = await composerApi.evaluateActionApproval('#test-safe-action-btn', 'npm test');
    assert.equal(safeEval.executed, true);
    assert.equal(safeClicked, 1);

    dangerBtn.remove();
    safeBtn.remove();

    // 5. 软订阅 state:context.snapshot@1 仅用于更新 /compact 提示文案，不再重复触发自动压缩
    emitSnap({ used: 250000 });
    await new Promise((r) => setTimeout(r, 20));
    const compactBtnTip = harness.mockDoc.getElementById('agy-qcap-compact')?.getAttribute('title') || '';
    assert.match(compactBtnTip, /250K|压缩上下文/);

    // 验证 showQuickBar 隐藏/恢复时 composer.quickActions surface 自动撤销与恢复
    await harness.updatePluginSettings('agy-daddy.composer', { showQuickBar: false });
    assert.equal(harness.mockDoc.getElementById('agy-quick-capsule-bar'), null);
    assert.equal(harness.mockDoc.getElementById('ext-surface-quick-btn'), null);
    await harness.updatePluginSettings('agy-daddy.composer', { showQuickBar: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(harness.mockDoc.getElementById('agy-quick-capsule-bar').querySelector('#ext-surface-quick-btn'));

    await harness.rendererHost.disposePlugin('test.consumer');
    await harness.unloadPlugin('agy-daddy.composer');
    assert.equal(harness.mockDoc.getElementById('agy-quick-capsule-bar'), null);
    assert.equal(harness.mockDoc.getElementById('agy-prompt-opt-wrap'), null);
    assert.equal(harness.mockDoc.head.querySelector('[data-agy-style="agy-daddy.composer"]'), null);
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    await harness.cleanup();
  }
});

test('回归：真实浏览器非 Array 的 HTMLCollection 形态 children 下快捷栏渲染与重渲染不崩溃', async () => {
  const { createMockDocument } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

  function makeHtmlCollectionProxy(backingArr) {
    return new Proxy({}, {
      get(_, prop) {
        if (prop === 'length') return backingArr.length;
        if (prop === 'item') return (i) => backingArr[Number(i)] || null;
        if (prop === Symbol.iterator) return () => backingArr[Symbol.iterator]();
        if (typeof prop === 'string' && /^\d+$/.test(prop)) return backingArr[Number(prop)];
        // 明确不提供 Array.prototype.find / filter / map 等方法，复刻真实 HTMLCollection
        return undefined;
      }
    });
  }

  function wrapWithHtmlCollectionChildren(el) {
    const backing = el.children;
    const htmlCol = makeHtmlCollectionProxy(backing);
    el._backingChildren = backing;
    Object.defineProperty(el, 'children', {
      configurable: true,
      enumerable: true,
      get() { return htmlCol; }
    });
    const origAppend = el.appendChild;
    const origInsertBefore = el.insertBefore;
    el.appendChild = (child) => {
      if (child.parentElement && Array.isArray(child.parentElement._backingChildren)) {
        const idx = child.parentElement._backingChildren.indexOf(child);
        if (idx >= 0) child.parentElement._backingChildren.splice(idx, 1);
        child.parentElement = null;
      }
      return origAppend.call(el, child);
    };
    el.insertBefore = (child, ref) => {
      if (child.parentElement && Array.isArray(child.parentElement._backingChildren)) {
        const idx = child.parentElement._backingChildren.indexOf(child);
        if (idx >= 0) child.parentElement._backingChildren.splice(idx, 1);
        child.parentElement = null;
      }
      return origInsertBefore.call(el, child, ref);
    };
    el.remove = () => {
      if (el.parentElement) {
        const list = Array.isArray(el.parentElement._backingChildren)
          ? el.parentElement._backingChildren
          : el.parentElement.children;
        const idx = typeof list?.indexOf === 'function' ? list.indexOf(el) : -1;
        if (idx >= 0) list.splice(idx, 1);
        el.parentElement = null;
      }
    };
    return el;
  }

  const doc = createMockDocument();
  const origCreateElement = doc.createElement.bind(doc);
  doc.createElement = (tag) => wrapWithHtmlCollectionChildren(origCreateElement(tag));

  const harness = createMockHostHarness({ document: doc });
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.equal(loaded.trust.world, 'isolated');

    const quickBar = harness.mockDoc.getElementById('agy-quick-capsule-bar');
    assert.ok(quickBar);
    assert.equal(Array.isArray(quickBar.children), false);
    assert.equal(typeof quickBar.children.find, 'undefined');
    assert.ok(harness.mockDoc.getElementById('agy-qcap-compact'));
    assert.ok(harness.mockDoc.getElementById('agy-prompt-opt-btn'));

    // 外部插件通过 ctx.surfaces.mount 挂入按钮后，触发设置变更重渲染，验证外部按钮留在末尾且不抛 TypeError
    await harness.rendererHost.mountPlugin('test.htmlcol.consumer', {
      mount(ctx) {
        ctx.surfaces.mount('composer.quickActions', (slotEl) => {
          const extBtn = harness.mockDoc.createElement('button');
          extBtn.id = 'ext-htmlcol-btn';
          extBtn.textContent = 'Ext';
          slotEl.appendChild(extBtn);
          return () => extBtn.remove();
        });
      }
    });

    assert.ok(quickBar.querySelector('#ext-htmlcol-btn'));
    await harness.updatePluginSettings('agy-daddy.composer', { ghostSuggest: false });
    const listAfter = Array.from(quickBar.children);
    assert.ok(listAfter.some((n) => n.id === 'agy-qcap-compact'));
    assert.equal(listAfter[listAfter.length - 1].id, 'ext-htmlcol-btn');

    await harness.rendererHost.disposePlugin('test.htmlcol.consumer');
    await harness.unloadPlugin('agy-daddy.composer');
    assert.equal(harness.mockDoc.getElementById('agy-quick-capsule-bar'), null);
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    await harness.cleanup();
  }
});

test('新建未发送对话即展示快捷栏（无 UUID / 无 .surface-composer 欢迎页）+ 脱离重挂 + 首次草稿即可优化', async () => {
  const { createMockDocument } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
  const doc = createMockDocument();
  // 模拟全新未发送对话的欢迎页：移除 .surface-composer，替换为仅含 lexical editor 的自定义容器
  const oldComposer = doc.querySelector('.surface-composer');
  oldComposer.remove();

  const welcomeWrap = createMockElement('div', doc);
  welcomeWrap.className = 'welcome-composer-shell';
  const welcomeEditor = createMockElement('div', doc);
  welcomeEditor.setAttribute('data-lexical-editor', 'true');
  welcomeEditor.setAttribute('contenteditable', 'true');
  const welcomeSend = createMockElement('button', doc);
  welcomeSend.setAttribute('aria-label', 'Send');
  welcomeWrap.appendChild(welcomeEditor);
  welcomeWrap.appendChild(welcomeSend);
  doc.body.appendChild(welcomeWrap);

  const rpcCalls = [];
  const harness = createMockHostHarness({
    document: doc,
    pageUrl: 'https://127.0.0.1:51410/',
    onRpc(method, body) {
      rpcCalls.push({ method, body });
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { modelId: 'gemini-2.5-flash-low', label: 'Flash Low', modelOrAlias: { model: 'FLASH_LOW' }, quotaInfo: { remainingFraction: 1 } }
              ]
            }
          }
        };
      }
      if (method === 'GetModelResponse') {
        return { response: '优化后的新建对话首次草稿' };
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    const quickBar = doc.getElementById('agy-quick-capsule-bar');
    assert.ok(quickBar, '新建空白对话应立即渲染快捷栏');
    const bodyKids = Array.from(doc.body.children);
    assert.equal(bodyKids.indexOf(quickBar), bodyKids.indexOf(welcomeWrap) - 1);

    // 首次草稿未发送前按钮初始 disabled，输入首字后立即启用并可优化
    const optBtn = doc.getElementById('agy-prompt-opt-btn');
    assert.equal(optBtn.disabled, true);
    welcomeEditor.textContent = '帮我搭一个 CLI 工具';
    doc.dispatchEvent({ type: 'input', target: welcomeEditor });
    assert.equal(optBtn.disabled, false);

    optBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(welcomeEditor.textContent, '优化后的新建对话首次草稿');
    assert.equal(rpcCalls.some((c) => c.method === 'GetModelResponse'), true);

    // 模拟 React 重渲染替换输入框容器导致原快捷栏脱离：refreshQuickBar 应重新挂载到新输入框上方
    welcomeWrap.remove();
    const nextComposer = createMockElement('div', doc);
    nextComposer.className = 'surface-composer';
    const nextEd = createMockElement('div', doc);
    nextEd.setAttribute('data-lexical-editor', 'true');
    nextEd.setAttribute('contenteditable', 'true');
    nextComposer.appendChild(nextEd);
    doc.body.appendChild(nextComposer);

    let composerApi = null;
    await harness.rendererHost.mountPlugin('test.remount', {
      mount(ctx) { composerApi = ctx.services.get('composer'); }
    });
    await composerApi.refreshQuickBar();

    const remountedBar = doc.getElementById('agy-quick-capsule-bar');
    assert.ok(remountedBar);
    const afterKids = Array.from(doc.body.children);
    assert.equal(afterKids.indexOf(remountedBar), afterKids.indexOf(nextComposer) - 1);

    await harness.rendererHost.disposePlugin('test.remount');
    await harness.unloadPlugin('agy-daddy.composer');
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    await harness.cleanup();
  }
});

test('提示词优化：多模型回退、斜杠前缀保留、自定义提示词模板与全失败错误提示', async () => {
  let failAll = false;
  const seenPrompts = [];
  const seenModels = [];
  const harness = createMockHostHarness({
    onRpc(method, body) {
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { modelId: 'gemini-2.5-flash-low', label: 'Flash Low', modelOrAlias: { model: 'FLASH_LOW' }, quotaInfo: { remainingFraction: 1 } },
                { modelId: 'claude-sonnet-4-5-low', label: 'Claude Low', modelOrAlias: { model: 'CLAUDE_LOW' }, quotaInfo: { remainingFraction: 1 } }
              ]
            }
          }
        };
      }
      if (method === 'GetModelResponse') {
        seenPrompts.push(body.prompt);
        seenModels.push(body.model);
        if (failAll || body.model === 'FLASH_LOW') {
          throw new Error('HTTP 429: rate limited');
        }
        return { response: '```markdown\n/plan 优化后任务：先定位根因再修复\n```' };
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    const editor = harness.mockDoc.querySelector('[contenteditable="true"]');

    // 1. 第一候选限流 -> 自动跨族回退到第二候选 + 保留 /plan 前缀且不重复，同时验证撤回替代优化
    editor.textContent = '/plan 修一下登录';
    harness.mockDoc.dispatchEvent({ type: 'input', target: editor });
    const optBtn = harness.mockDoc.getElementById('agy-prompt-opt-btn');
    const undoBtn = harness.mockDoc.getElementById('agy-prompt-undo-btn');
    optBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(seenModels.slice(0, 2), ['FLASH_LOW', 'CLAUDE_LOW']);
    assert.equal(editor.textContent, '/plan 优化后任务：先定位根因再修复');
    assert.equal(optBtn.hidden, true);
    assert.equal(undoBtn.hidden, false);

    // 2. 修改优化后的提示词内容 -> 撤回按钮自动重新切回优化按钮
    await harness.updatePluginSettings('agy-daddy.composer', {
      optimizerPrompt: 'CUSTOM_TEMPLATE_V1:\n{{draft}}'
    });
    editor.textContent = '重构列表渲染';
    harness.mockDoc.dispatchEvent({ type: 'input', target: editor });
    assert.equal(undoBtn.hidden, true);
    assert.equal(optBtn.hidden, false);
    optBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.match(seenPrompts[seenPrompts.length - 1], /^CUSTOM_TEMPLATE_V1:\n重构列表渲染$/);
    assert.equal(undoBtn.hidden, false);
    assert.equal(optBtn.hidden, true);

    await harness.updatePluginSettings('agy-daddy.composer', {
      optimizerPrompt: 'CUSTOM_NO_PLACEHOLDER'
    });
    editor.textContent = '补充单测';
    harness.mockDoc.dispatchEvent({ type: 'input', target: editor });
    harness.mockDoc.getElementById('agy-prompt-opt-btn').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.match(seenPrompts[seenPrompts.length - 1], /CUSTOM_NO_PLACEHOLDER[\s\S]*<draft>\n补充单测\n<\/draft>/);

    // 3. 全部模型失败 -> 显示错误 toast 且不篡改原草稿
    failAll = true;
    editor.textContent = '保持原样草稿';
    harness.mockDoc.dispatchEvent({ type: 'input', target: editor });
    harness.mockDoc.getElementById('agy-prompt-opt-btn').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(editor.textContent, '保持原样草稿');
    const toast = harness.mockDoc.getElementById('agy-qcap-toast');
    assert.equal(toast.hidden, false);
    assert.equal(toast.getAttribute('data-tone'), 'error');
    assert.match(toast.textContent, /429/);

    await harness.unloadPlugin('agy-daddy.composer');
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    await harness.cleanup();
  }
});

test('自定义快捷条目顺序与上下文感知动态适配', async () => {
  const { createMockDocument } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
  const doc = createMockDocument();
  const harness = createMockHostHarness({
    document: doc,
    pageUrl: 'https://127.0.0.1:51410/'
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    let composerApi = null;
    let emitSnap = null;
    await harness.rendererHost.mountPlugin('test.ctx', {
      mount(ctx) {
        composerApi = ctx.services.get('composer');
        emitSnap = (s) => ctx.state.set('state:context.snapshot@1', s);
      }
    });

    const getQcapIds = () => Array.from(doc.getElementById('agy-quick-capsule-bar').children)
      .filter((el) => String(el.id || '').startsWith('agy-qcap-') && el.id !== 'agy-qcap-toast')
      .map((el) => el.id);

    // 1. 新建空白对话 + contextAwareQuickItems 默认开启：隐藏 compact/copyid/export，并推荐 grill-me
    const newChatIds = getQcapIds();
    assert.equal(newChatIds.includes('agy-qcap-compact'), false);
    assert.equal(newChatIds.includes('agy-qcap-copyid'), false);
    assert.equal(newChatIds.includes('agy-qcap-export'), false);
    assert.ok(newChatIds.includes('agy-qcap-grill-me'));
    assert.equal(doc.getElementById('agy-qcap-grill-me').getAttribute('data-context-suggested'), 'true');

    // 2. 模拟已有回复（含报错关键词）+ 脱离新建对话态 -> 推荐 boost
    const replyEl = createMockElement('div', doc);
    replyEl.setAttribute('data-testid', 'agent-response');
    replyEl.textContent = 'Tests failed with TypeError exception in auth.js';
    doc.body.appendChild(replyEl);
    await composerApi.refreshQuickBar();
    assert.ok(getQcapIds().includes('agy-qcap-boost'));

    // 3. 模拟高上下文水位（330K + cacheDropDetected）-> /compact 置顶并标红 danger
    emitSnap({ used: 330000, cacheDropDetected: true, cacheCliffRisk: 'critical' });
    await new Promise((r) => setTimeout(r, 25));
    const riskIds = getQcapIds();
    assert.equal(riskIds[0], 'agy-qcap-compact');
    assert.equal(doc.getElementById('agy-qcap-compact').getAttribute('data-risk'), 'danger');

    // 4. 模拟 AI 正在生成 -> 推荐 /btw
    replyEl.textContent = '正在分析代码结构';
    const cancelBtn = createMockElement('button', doc);
    cancelBtn.setAttribute('data-testid', 'input-cancel-button');
    doc.querySelector('.surface-composer').appendChild(cancelBtn);
    await composerApi.refreshQuickBar();
    assert.ok(getQcapIds().includes('agy-qcap-btw'));
    cancelBtn.remove();

    // 5. 关闭上下文感知并自定义 quickItems 顺序与自定义条目（同时过滤已迁移的旧 copyid/export 项）
    await harness.updatePluginSettings('agy-daddy.composer', {
      contextAwareQuickItems: false,
      quickItems: [
        'goal',
        'copyid',
        JSON.stringify({ id: 'custom_rev', label: '代码审查', text: '请逐行审查本次改动', autoSend: false }),
        'export',
        'plan'
      ]
    });
    assert.deepEqual(getQcapIds(), ['agy-qcap-goal', 'agy-qcap-custom_rev', 'agy-qcap-plan']);
    assert.equal(doc.getElementById('agy-qcap-copyid'), null);
    assert.equal(doc.getElementById('agy-qcap-export'), null);
    doc.getElementById('agy-qcap-custom_rev').click();
    assert.equal(doc.querySelector('[contenteditable="true"]').textContent, '请逐行审查本次改动');

    await harness.rendererHost.disposePlugin('test.ctx');
    await harness.unloadPlugin('agy-daddy.composer');
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    await harness.cleanup();
  }
});

test('禁止重复点击优化（请求进行中锁死）与否定词不误判报错（0 failed / passed 不触发 boost）', async () => {
  let modelCallCount = 0;
  let resolveSlowRpc = null;
  const harness = createMockHostHarness({
    onRpc(method) {
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { modelId: 'gemini-2.5-flash-low', label: 'Flash Low', modelOrAlias: { model: 'FLASH_LOW' }, quotaInfo: { remainingFraction: 1 } }
              ]
            }
          }
        };
      }
      if (method === 'GetModelResponse') {
        modelCallCount += 1;
        return new Promise((resolve) => {
          resolveSlowRpc = () => resolve({ response: '慢请求优化完成文本' });
        });
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    let composerApi = null;
    await harness.rendererHost.mountPlugin('test.dedup', {
      mount(ctx) { composerApi = ctx.services.get('composer'); }
    });

    const editor = harness.mockDoc.querySelector('[contenteditable="true"]');
    const optBtn = harness.mockDoc.getElementById('agy-prompt-opt-btn');
    const undoBtn = harness.mockDoc.getElementById('agy-prompt-undo-btn');

    editor.textContent = '慢请求测试草稿';
    harness.mockDoc.dispatchEvent({ type: 'input', target: editor });

    // 连续触发两次优化：第二次必须被拦截，GetModelResponse 仅发起 1 次
    const p1 = composerApi.optimizePrompt();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(optBtn.disabled, true);
    assert.equal(optBtn.getAttribute('data-loading'), 'true');
    const p2 = await composerApi.optimizePrompt();
    assert.equal(p2.busy, true);
    assert.equal(modelCallCount, 1);

    resolveSlowRpc();
    const res1 = await p1;
    assert.equal(res1.ok, true);
    assert.equal(editor.textContent, '慢请求优化完成文本');
    assert.equal(optBtn.hidden, true);
    assert.equal(undoBtn.hidden, false);

    // 否定词验证：回复中包含 "12/12 passed, 0 failed" 不应误判报错推荐 /boost
    const replyEl = createMockElement('div', harness.mockDoc);
    replyEl.setAttribute('data-testid', 'agent-response');
    replyEl.textContent = 'All 12 tests passed, 0 failed. 已修复并验证通过。';
    harness.mockDoc.body.appendChild(replyEl);
    await composerApi.refreshQuickBar();

    assert.equal(harness.mockDoc.getElementById('agy-qcap-boost'), null);
    assert.ok(harness.mockDoc.getElementById('agy-qcap-learn'));

    await harness.rendererHost.disposePlugin('test.dedup');
    await harness.unloadPlugin('agy-daddy.composer');
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    await harness.cleanup();
  }
});

test('支持显示入口开关 showPromptOptimizer、默认及自定义快捷键触发优化与撤回', async () => {
  const harness = createMockHostHarness({
    onRpc(method) {
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { modelId: 'gemini-2.5-flash-low', label: 'Flash Low', modelOrAlias: { model: 'FLASH_LOW' }, quotaInfo: { remainingFraction: 1 } }
              ]
            }
          }
        };
      }
      if (method === 'GetModelResponse') {
        return { response: '快捷键优化完成文本' };
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    let composerApi = null;
    await harness.rendererHost.mountPlugin('test.shortcut', {
      mount(ctx) { composerApi = ctx.services.get('composer'); }
    });

    const initialSettings = await composerApi.getSettings();
    assert.equal(initialSettings.showPromptOptimizer, true);
    assert.equal(initialSettings.optimizerShortcut, 'Alt+Shift+O');

    const editor = harness.mockDoc.querySelector('[contenteditable="true"]');
    const optBtn = harness.mockDoc.getElementById('agy-prompt-opt-btn');
    assert.ok(optBtn);
    assert.match(optBtn.getAttribute('title'), /Alt\+Shift\+O/);

    // 1. 默认快捷键 Alt+Shift+O（含 macOS Option 产生 Ø 且 code 为 KeyO）触发优化
    editor.textContent = '请帮我优化这段指令';
    harness.mockDoc.dispatchEvent({ type: 'input', target: editor });

    let prevented = false;
    harness.mockDoc.dispatchEvent({
      type: 'keydown',
      key: 'Ø',
      code: 'KeyO',
      altKey: true,
      shiftKey: true,
      target: editor,
      preventDefault() { prevented = true; },
      stopPropagation() {}
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(prevented, true);
    assert.equal(editor.textContent, '快捷键优化完成文本');

    // 2. 优化完尚未修改内容时，再按一次快捷键执行撤回
    harness.mockDoc.dispatchEvent({
      type: 'keydown',
      key: 'O',
      code: 'KeyO',
      altKey: true,
      shiftKey: true,
      target: editor,
      preventDefault() {},
      stopPropagation() {}
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(editor.textContent, '请帮我优化这段指令');

    // 3. 焦点在设置面板快捷键输入框时，不拦截不触发优化
    const mockShortcutInput = createMockElement('input', harness.mockDoc);
    mockShortcutInput.setAttribute('data-shortcut-input', 'optimizerShortcut');
    let interceptedInRecorder = false;
    harness.mockDoc.dispatchEvent({
      type: 'keydown',
      key: 'O',
      code: 'KeyO',
      altKey: true,
      shiftKey: true,
      target: mockShortcutInput,
      preventDefault() { interceptedInRecorder = true; },
      stopPropagation() {}
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(interceptedInRecorder, false);
    assert.equal(editor.textContent, '请帮我优化这段指令');

    // 4. 关闭入口显示开关 -> 隐藏按钮但快捷键仍可用
    await composerApi.updateSettings({
      showPromptOptimizer: false,
      optimizerShortcut: 'Ctrl+Shift+P'
    });
    assert.equal(harness.mockDoc.getElementById('agy-prompt-opt-wrap'), null);

    // 旧快捷键不再触发
    harness.mockDoc.dispatchEvent({
      type: 'keydown',
      key: 'O',
      code: 'KeyO',
      altKey: true,
      shiftKey: true,
      target: editor,
      preventDefault() {},
      stopPropagation() {}
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(editor.textContent, '请帮我优化这段指令');

    // 新自定义快捷键 Ctrl+Shift+P 即使按钮隐藏也可正常触发优化
    harness.mockDoc.dispatchEvent({
      type: 'keydown',
      key: 'P',
      code: 'KeyP',
      ctrlKey: true,
      shiftKey: true,
      target: editor,
      preventDefault() {},
      stopPropagation() {}
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(editor.textContent, '快捷键优化完成文本');

    // 5. 清空快捷键禁用，恢复入口显示开关后按钮重新出现
    await composerApi.updateSettings({
      showPromptOptimizer: true,
      optimizerShortcut: ''
    });
    const restoredBtn = harness.mockDoc.getElementById('agy-prompt-opt-btn');
    const restoredUndoBtn = harness.mockDoc.getElementById('agy-prompt-undo-btn');
    assert.ok(restoredBtn);
    assert.ok(restoredUndoBtn);
    assert.equal(restoredUndoBtn.hidden, false);
    assert.equal(restoredUndoBtn.getAttribute('title'), '撤回优化，恢复原始草稿');
    assert.ok(!restoredBtn.getAttribute('title').includes('Alt+Shift+O'));

    // 清空快捷键后，再按 Ctrl+Shift+P 不应触发撤回
    harness.mockDoc.dispatchEvent({
      type: 'keydown',
      key: 'P',
      code: 'KeyP',
      ctrlKey: true,
      shiftKey: true,
      target: editor,
      preventDefault() {},
      stopPropagation() {}
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(editor.textContent, '快捷键优化完成文本');

    await harness.rendererHost.disposePlugin('test.shortcut');
    await harness.unloadPlugin('agy-daddy.composer');
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    await harness.cleanup();
  }
});

test('优化加载中动画稳定不重置、Key-Value 名称与实际命令分离、高频手动词扫描与模型提炼总结', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const {
    collectManualUserMessages,
    parseFrequentPromptsResponse
  } = require('../src/frequent-prompts');

  const tmpBrainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-freq-brain-'));
  const sess1LogDir = path.join(tmpBrainDir, 'sess-1', '.system_generated', 'logs');
  const sess2LogDir = path.join(tmpBrainDir, 'sess-2', '.system_generated', 'logs');
  fs.mkdirSync(sess1LogDir, { recursive: true });
  fs.mkdirSync(sess2LogDir, { recursive: true });

  const makeUserLine = (text) => JSON.stringify({
    type: 'USER_INPUT',
    source: 'USER_EXPLICIT',
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`
  });

  fs.writeFileSync(path.join(sess1LogDir, 'transcript.jsonl'), [
    makeUserLine('You did not call any tools. You should continue calling tools until you\'ve completed your task.'),
    makeUserLine('Conversation history, background context only. <conversation_history> ...'),
    makeUserLine('/compact'),
    makeUserLine('提交pr'),
    makeUserLine('运行全量测试并修复失败用例'),
    makeUserLine('继续')
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(sess2LogDir, 'transcript.jsonl'), [
    makeUserLine('提交pr'),
    makeUserLine('提交pr'),
    makeUserLine('运行全量测试并修复失败用例'),
    makeUserLine('检查还有没有遗漏')
  ].join('\n'), 'utf8');

  const scanned = await collectManualUserMessages({ brainDirs: [tmpBrainDir] });
  assert.equal(scanned.sessionsScanned, 2);
  assert.equal(scanned.topRepeated[0].text, '提交pr');
  assert.equal(scanned.topRepeated[0].count, 3);
  assert.ok(!scanned.topRepeated.some((it) => /You did not call any tools|compact/i.test(it.text)));

  const parsedSamples = parseFrequentPromptsResponse([
    '```json',
    JSON.stringify([
      { label: '提交 PR', text: '请检查改动并提交 PR 推送分支', tag: '高频·3次', description: '提交并推送 PR', count: 3 },
      { label: '重复内置', text: '/compact', count: 5 },
      { label: '运行全测', text: '请运行全量测试并定位修复失败用例', tag: '高频·2次', count: 2 }
    ]),
    '```'
  ].join('\n'));
  assert.equal(parsedSamples.length, 2);
  assert.equal(parsedSamples[0].label, '提交 PR');
  assert.equal(parsedSamples[0].text, '请检查改动并提交 PR 推送分支');
  assert.match(parsedSamples[0].id, /^freq_[0-9a-f]{8}$/);

  let resolveSlowOpt = null;
  const rpcPrompts = [];
  const harness = createMockHostHarness({
    onRpc(method, body) {
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { modelId: 'gemini-3.5-flash-lite', label: 'Flash Lite', modelOrAlias: { model: 'FLASH_LITE' }, quotaInfo: { remainingFraction: 1 } }
              ]
            }
          }
        };
      }
      if (method === 'GetModelResponse') {
        const promptText = String(body?.prompt || '');
        rpcPrompts.push(promptText);
        if (promptText.includes('历史高频手动输入统计')) {
          return {
            response: JSON.stringify([
              { label: '提交 PR', text: '请先运行测试验证，确认无误后提交 PR 并推送', tag: '高频·3次', description: '测试后提交 PR', count: 3 },
              { label: '全测排错', text: '/review 请运行全量测试并修复失败用例', tag: '高频·2次', description: '运行测试并排查', count: 2 }
            ])
          };
        }
        return new Promise((resolve) => {
          resolveSlowOpt = () => resolve({ response: '优化完成后的提示词' });
        });
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    let composerApi = null;
    await harness.rendererHost.mountPlugin('test.freq', {
      mount(ctx) { composerApi = ctx.services.get('composer'); }
    });

    // 1. 验证加载中动画稳定：重复调用 refreshQuickBar 不重写 optBtn.innerHTML，SVG .agy-opt-spin 保持完整
    const editor = harness.mockDoc.querySelector('[contenteditable="true"]');
    const optBtn = harness.mockDoc.getElementById('agy-prompt-opt-btn');
    let innerHtmlWriteCount = 0;
    let backingHtml = optBtn.innerHTML;
    const htmlDesc = Object.getOwnPropertyDescriptor(optBtn, 'innerHTML') || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(optBtn), 'innerHTML');
    Object.defineProperty(optBtn, 'innerHTML', {
      configurable: true,
      get() { return htmlDesc?.get ? htmlDesc.get.call(this) : backingHtml; },
      set(v) {
        innerHtmlWriteCount++;
        backingHtml = v;
        if (htmlDesc?.set) htmlDesc.set.call(this, v);
      }
    });

    editor.textContent = '需要优化的草稿';
    harness.mockDoc.dispatchEvent({ type: 'input', target: editor });
    const optPromise = composerApi.optimizePrompt();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(optBtn.getAttribute('data-loading'), 'true');
    assert.equal(optBtn.getAttribute('data-icon-state'), 'loading');
    assert.match(optBtn.innerHTML, /<svg[^>]*class="agy-opt-spin"/);
    const writesAtLoading = innerHtmlWriteCount;

    await composerApi.refreshQuickBar();
    await composerApi.refreshQuickBar();
    assert.equal(innerHtmlWriteCount, writesAtLoading, '加载中重复刷新不应重建旋转图标 DOM');

    resolveSlowOpt();
    await optPromise;
    assert.equal(editor.textContent, '优化完成后的提示词');

    // 2. 手动调用 composer.summarizeFrequentPrompts 命令总结并持久化高频词
    const composerNode = harness.bus.getServiceProxy('composer-node');
    const sumRes = await composerNode.summarizeFrequentPrompts({ brainDirs: [tmpBrainDir] });
    assert.equal(sumRes.ok, true);
    assert.equal(sumRes.presets.length, 2);
    assert.equal(sumRes.presets[0].label, '提交 PR');
    assert.equal(sumRes.presets[0].text, '请先运行测试验证，确认无误后提交 PR 并推送');
    assert.ok(rpcPrompts.some((p) => p.includes('提交pr') && p.includes('历史高频手动输入统计')));

    const listed = await harness.executeCommand('composer.listFrequentPrompts');
    assert.equal(listed.ok, true);
    assert.equal(listed.presets.length, 2);

    // 3. 将 Key-Value 条目加入 quickItems：按钮显示 UI 名称，点击填充实际命令
    await composerApi.updateSettings({
      contextAwareQuickItems: false,
      autoSummarizeFrequentPrompts: true,
      quickItems: [
        'compact',
        JSON.stringify(sumRes.presets[0]),
        JSON.stringify(sumRes.presets[1])
      ]
    });
    const kvBtn1 = harness.mockDoc.getElementById(`agy-qcap-${sumRes.presets[0].id}`);
    const kvBtn2 = harness.mockDoc.getElementById(`agy-qcap-${sumRes.presets[1].id}`);
    assert.ok(kvBtn1);
    assert.equal(kvBtn1.textContent, '提交 PR');
    assert.match(kvBtn1.getAttribute('title') || '', /实际填充: 请先运行测试验证/);
    kvBtn1.click();
    assert.equal(editor.textContent, '请先运行测试验证，确认无误后提交 PR 并推送');

    assert.ok(kvBtn2);
    assert.equal(kvBtn2.textContent, '全测排错');
    kvBtn2.click();
    assert.equal(editor.textContent, '/review 请运行全量测试并修复失败用例');
    assert.equal(editor.getAttribute('data-agy-native-slash'), 'review');

    const latestSettings = await composerApi.getSettings();
    assert.equal(latestSettings.autoSummarizeFrequentPrompts, true);

    await harness.rendererHost.disposePlugin('test.freq');
    await harness.unloadPlugin('agy-daddy.composer');
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    fs.rmSync(tmpBrainDir, { recursive: true, force: true });
    await harness.cleanup();
  }
});

test('快速输入词 UI 展示可点击胶囊图标且仅显示友好名称、彻底隐藏斜杠命令文本', async () => {
  const { formatQuickItemDisplayLabel } = require('../src/quick-prompts');
  assert.equal(formatQuickItemDisplayLabel('/summarize 总结全文'), '总结全文');
  assert.equal(formatQuickItemDisplayLabel('/plan'), '规划模式');
  assert.equal(formatQuickItemDisplayLabel('/grill-me 追问对齐'), '追问对齐');

  const harness = createMockHostHarness();
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    let composerApi = null;
    await harness.rendererHost.mountPlugin('test.qcapui', {
      mount(ctx) { composerApi = ctx.services.get('composer'); }
    });

    const styleEl = harness.mockDoc.head.querySelector('[data-agy-style="agy-daddy.composer"]');
    assert.ok(styleEl);
    assert.match(styleEl.textContent, /#agy-quick-capsule-bar button\.agy-qcap-btn/);
    assert.match(styleEl.textContent, /\.agy-qcap-btn:active/);
    assert.match(styleEl.textContent, /\.agy-qcap-icon/);
    assert.match(styleEl.textContent, /var\(--ag-accent-border/);

    await composerApi.updateSettings({
      contextAwareQuickItems: false,
      quickItems: [
        'compact',
        'plan',
        'goal',
        'reload',
        JSON.stringify({ id: 'sum_doc', label: '/summarize 总结全文', text: '/summarize ' })
      ]
    });

    const bar = harness.mockDoc.getElementById('agy-quick-capsule-bar');
    const chips = bar.querySelectorAll('.agy-qcap-btn');
    assert.equal(chips.length, 5);
    assert.deepEqual(
      chips.map((c) => c.querySelector('.agy-qcap-label')?.textContent),
      ['压缩上下文', '规划模式', '持续到底', '重载规则', '总结全文']
    );
    for (const chip of chips) {
      assert.ok(!/^\/[a-z0-9-]+/i.test(chip.textContent.trim()), `不应在 UI 胶囊暴露斜杠命令: ${chip.textContent}`);
      const iconEl = chip.querySelector('.agy-qcap-icon');
      assert.ok(iconEl, '应带可点击视觉前置图标');
      assert.match(iconEl.innerHTML, /<svg/);
    }

    // 底层真实斜杠命令仍完整保留：点击“规划模式”和“总结全文”均填充对应命令（无多余尾随空格）
    const editor = harness.mockDoc.querySelector('[contenteditable="true"]');
    harness.mockDoc.getElementById('agy-qcap-plan').click();
    assert.equal(editor.textContent, '/plan');
    assert.equal(editor.getAttribute('data-agy-native-slash'), 'plan');

    harness.mockDoc.getElementById('agy-qcap-sum_doc').click();
    assert.equal(editor.textContent, '/summarize');
    assert.equal(editor.getAttribute('data-agy-native-slash'), 'summarize');

    await harness.rendererHost.disposePlugin('test.qcapui');
    await harness.unloadPlugin('agy-daddy.composer');
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    await harness.cleanup();
  }
});

test('全量 12 项内置指令与 settings.schema.json 零尾随空格校验 + parseSlashCommandText', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'settings.schema.json'), 'utf8'));
  const quickField = schema.fields.find((f) => f.key === 'quickItems');
  const presets = quickField?.itemEditor?.presets || [];
  assert.equal(presets.length, 12);

  for (const item of BUILTIN_QUICK_POOL) {
    const schemaPreset = presets.find((p) => p.id === item.id);
    assert.ok(schemaPreset, `settings.schema.json missing preset ${item.id}`);
    if (item.slash) {
      assert.equal(item.text, `/${item.slash}`, `BUILTIN_QUICK_POOL ${item.id} must not have trailing space`);
      assert.equal(schemaPreset.text, `/${item.slash}`, `settings.schema.json ${item.id} must not have trailing space`);
    } else {
      assert.equal(item.id, 'reload');
      assert.equal(item.text, '重新读取 AGENTS');
      assert.equal(schemaPreset.text, '重新读取 AGENTS');
    }
  }

  assert.deepEqual(parseSlashCommandText('/swarm '), { slash: 'swarm', commandText: '/swarm', restText: '' });
  assert.deepEqual(parseSlashCommandText('/review 请检查边界'), { slash: 'review', commandText: '/review', restText: '请检查边界' });
  assert.deepEqual(parseSlashCommandText('', { slash: 'plan' }), { slash: 'plan', commandText: '/plan', restText: '' });
  assert.deepEqual(parseSlashCommandText('重新读取 AGENTS'), { slash: '', commandText: '重新读取 AGENTS', restText: '' });
});

test('真实 Lexical/execCommand 环境下斜杠命令（/swarm 等）无尾随空格自动点选原生菜单、边界匹配与 /compact 防重复发送', async () => {
  const { createMockDocument } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
  const doc = createMockDocument();
  const editor = doc.querySelector('[contenteditable="true"]');
  const sendBtn = doc.querySelector('[data-testid="input-send-button"]');

  // 显式保持 __lexicalEditor 为 undefined（isolated 世界真实行为）
  assert.equal(editor.__lexicalEditor, undefined);

  let editorBuffer = '';
  let textContentWritesDuringExec = 0;
  let inExec = false;
  const insertedTexts = [];
  const sentActions = [];
  const menuEvents = [];
  let compactClearsEditorOnSelect = false;

  const origDesc = Object.getOwnPropertyDescriptor(editor, 'textContent');
  Object.defineProperty(editor, 'textContent', {
    configurable: true,
    get() {
      return editorBuffer || (origDesc?.get ? origDesc.get.call(this) : '');
    },
    set(v) {
      if (inExec) textContentWritesDuringExec += 1;
      editorBuffer = String(v ?? '');
      if (origDesc?.set) origDesc.set.call(this, v);
    }
  });
  Object.defineProperty(editor, 'innerText', {
    configurable: true,
    get() {
      // 模拟 Lexical <p> 结尾自带换行符的场景
      return editorBuffer ? `${editorBuffer}\n` : '\n';
    }
  });

  sendBtn.addEventListener('click', () => {
    sentActions.push(editorBuffer);
  });

  let listboxEl = null;
  function clearSlashMenu() {
    if (listboxEl) {
      listboxEl.remove();
      listboxEl = null;
    }
  }

  function showSlashMenuFor(cmdText) {
    clearSlashMenu();
    listboxEl = createMockElement('div', doc);
    listboxEl.setAttribute('role', 'listbox');

    const makeOption = (cmdName, displayText, onActivate) => {
      const opt = createMockElement('div', doc);
      opt.setAttribute('role', 'option');
      const inner = createMockElement('div', doc);
      inner.className = 'cursor-pointer';
      const titleSpan = createMockElement('span', doc);
      titleSpan.textContent = displayText;
      inner.appendChild(titleSpan);
      opt.appendChild(inner);

      inner.addEventListener('mousedown', () => {
        menuEvents.push(`mousedown:${cmdName}`);
      });
      inner.addEventListener('click', () => {
        menuEvents.push(`click:${cmdName}`);
        if (typeof onActivate === 'function') onActivate();
        else editorBuffer = `[pill:${cmdName}]`;
        clearSlashMenu();
      });
      return opt;
    };

    if (cmdText === '/swarm') {
      listboxEl.appendChild(makeOption('swarm', 'swarm 蜂群协作'));
    } else if (cmdText === '/plan') {
      // 干扰项在前：planner 不能被 /plan 误命中
      listboxEl.appendChild(makeOption('planner', 'planner 规划器'));
      listboxEl.appendChild(makeOption('plan', '/plan'));
    } else if (cmdText === '/review') {
      listboxEl.appendChild(makeOption('review', 'review 代码审查'));
    } else if (cmdText === '/compact') {
      listboxEl.appendChild(makeOption('compact', 'compact 压缩上下文', () => {
        editorBuffer = compactClearsEditorOnSelect ? '' : '[pill:compact]';
      }));
    }
    doc.body.appendChild(listboxEl);
  }

  doc.execCommand = (cmd, _ui, val) => {
    inExec = true;
    try {
      if (cmd === 'selectAll') return true;
      if (cmd === 'delete') {
        editorBuffer = '';
        clearSlashMenu();
        return true;
      }
      if (cmd === 'insertText') {
        const s = String(val ?? '');
        insertedTexts.push(s);
        editorBuffer = `${editorBuffer}${s}`;
        if (/^\/[a-z0-9-]+$/i.test(editorBuffer)) {
          const captured = editorBuffer;
          setTimeout(() => {
            if (editorBuffer === captured) showSlashMenuFor(captured);
          }, 25);
        } else {
          clearSlashMenu();
        }
        return true;
      }
      return false;
    } finally {
      inExec = false;
    }
  };

  const harness = createMockHostHarness({ document: doc });
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    let composerApi = null;
    await harness.rendererHost.mountPlugin('test.slash.realdom', {
      mount(ctx) { composerApi = ctx.services.get('composer'); }
    });

    await composerApi.updateSettings({
      contextAwareQuickItems: false,
      quickItems: [
        'swarm',
        'plan',
        'compact',
        JSON.stringify({ id: 'legacy_swarm', label: '旧蜂群', text: '/swarm ' }),
        JSON.stringify({ id: 'freq_rev', label: '全测排错', text: '/review 请运行全量测试' })
      ]
    });

    // 1. 点击「蜂群并发」：输入必须是 '/swarm'（无尾随空格），不覆盖 editor.textContent，且等待异步菜单后 mousedown + click 触发转换
    doc.getElementById('agy-qcap-swarm').click();
    assert.equal(insertedTexts[0], '/swarm');
    assert.equal(textContentWritesDuringExec, 0);
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(menuEvents.slice(-2), ['mousedown:swarm', 'click:swarm']);
    assert.equal(editorBuffer, '[pill:swarm]');

    // 2. 点击「规划模式」：已有内容时先清空再插入 '/plan'，且不会误命中干扰项 planner
    doc.getElementById('agy-qcap-plan').click();
    await new Promise((r) => setTimeout(r, 140));
    assert.equal(insertedTexts[1], '/plan');
    assert.deepEqual(menuEvents.slice(-2), ['mousedown:plan', 'click:plan']);
    assert.equal(editorBuffer, '[pill:plan]');

    // 3. 历史遗留带空格自定义项 '/swarm '：自动规整为 '/swarm' 并成功触发菜单
    doc.getElementById('agy-qcap-legacy_swarm').click();
    await new Promise((r) => setTimeout(r, 140));
    assert.equal(insertedTexts[2], '/swarm');
    assert.deepEqual(menuEvents.slice(-2), ['mousedown:swarm', 'click:swarm']);

    // 4. 带参数斜杠指令 '/review 请运行全量测试'：先触发 review 菜单，再追加参数文本且不破坏胶囊
    doc.getElementById('agy-qcap-freq_rev').click();
    await new Promise((r) => setTimeout(r, 140));
    assert.equal(insertedTexts[3], '/review');
    assert.equal(editorBuffer, '[pill:review] 请运行全量测试');

    // 5. 未出现原生菜单时回退保留纯文本 '/goal'（也不带尾随空格）
    await composerApi.updateSettings({ contextAwareQuickItems: false, quickItems: ['goal', 'compact'] });
    editorBuffer = '';
    doc.getElementById('agy-qcap-goal').click();
    await new Promise((r) => setTimeout(r, 360));
    assert.equal(editorBuffer, '/goal');

    // 6. /compact（autoSend=true）：(a) 菜单点选后仍留在输入框 -> 自动点击发送 1 次
    compactClearsEditorOnSelect = false;
    sentActions.length = 0;
    doc.getElementById('agy-qcap-compact').click();
    await new Promise((r) => setTimeout(r, 140));
    assert.deepEqual(sentActions, ['[pill:compact]']);

    // (b) 若原生菜单点选瞬间已执行并清空输入框 -> 不重复点击发送按钮
    compactClearsEditorOnSelect = true;
    sentActions.length = 0;
    doc.getElementById('agy-qcap-compact').click();
    await new Promise((r) => setTimeout(r, 140));
    assert.deepEqual(sentActions, []);

    // 7. 快速连续切换点击两个斜杠按钮：取消前一次轮询，仅生效最后一次点击
    await composerApi.updateSettings({ contextAwareQuickItems: false, quickItems: ['swarm', 'plan'] });
    menuEvents.length = 0;
    doc.getElementById('agy-qcap-swarm').click();
    doc.getElementById('agy-qcap-plan').click();
    await new Promise((r) => setTimeout(r, 140));
    assert.deepEqual(menuEvents, ['mousedown:plan', 'click:plan']);

    await harness.rendererHost.disposePlugin('test.slash.realdom');
    await harness.unloadPlugin('agy-daddy.composer');
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    await harness.cleanup();
  }
});

test('回归：Lexical beforeinput 返回 false 时点击 /compact 与 /swarm 不重复写入 /compact/compact', async () => {
  const { createMockDocument } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
  class MockInputEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
      this.inputType = init.inputType || '';
      this.data = init.data ?? null;
      this.defaultPrevented = false;
    }
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
  }
  const prevInputEvent = globalThis.InputEvent;
  globalThis.InputEvent = MockInputEvent;

  const doc = createMockDocument();
  const editor = doc.querySelector('[contenteditable="true"]');
  const sendBtn = doc.querySelector('[data-testid="input-send-button"]');
  let editorBuffer = '';
  const sentActions = [];
  const beforeInputDatas = [];
  let listboxEl = null;

  Object.defineProperty(editor, 'textContent', {
    configurable: true,
    get() { return editorBuffer; },
    set(v) { editorBuffer = String(v ?? ''); }
  });
  Object.defineProperty(editor, 'innerText', {
    configurable: true,
    get() { return editorBuffer ? `${editorBuffer}\n` : '\n'; }
  });

  function clearSlashMenu() {
    if (listboxEl) {
      listboxEl.remove();
      listboxEl = null;
    }
  }

  function showSlashMenuFor(cmdText) {
    clearSlashMenu();
    const name = cmdText.slice(1);
    if (name !== 'compact' && name !== 'swarm') return;
    listboxEl = createMockElement('div', doc);
    listboxEl.setAttribute('role', 'listbox');
    const opt = createMockElement('div', doc);
    opt.setAttribute('role', 'option');
    const inner = createMockElement('div', doc);
    inner.className = 'cursor-pointer';
    const titleSpan = createMockElement('span', doc);
    titleSpan.textContent = name === 'compact' ? 'compact 压缩上下文' : 'swarm 蜂群协作';
    inner.appendChild(titleSpan);
    opt.appendChild(inner);
    inner.addEventListener('click', () => {
      editorBuffer = `[pill:${name}]`;
      clearSlashMenu();
    });
    listboxEl.appendChild(opt);
    doc.body.appendChild(listboxEl);
  }

  editor.addEventListener('beforeinput', (ev) => {
    beforeInputDatas.push(ev.data);
    if (ev.inputType === 'insertText' && typeof ev.data === 'string') {
      ev.preventDefault();
      editorBuffer = `${editorBuffer}${ev.data}`;
    }
  });

  sendBtn.addEventListener('click', () => {
    sentActions.push(editorBuffer);
    editorBuffer = '';
  });

  doc.execCommand = (cmd, _ui, val) => {
    if (cmd === 'selectAll') return true;
    if (cmd === 'delete') {
      editorBuffer = '';
      clearSlashMenu();
      return true;
    }
    if (cmd === 'insertText') {
      const ev = new MockInputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: String(val ?? '')
      });
      doc.dispatchEvent(ev);
      editor.dispatchEvent(ev);
      if (/^\/[a-z0-9-]+$/i.test(editorBuffer)) {
        const captured = editorBuffer;
        setTimeout(() => {
          if (editorBuffer === captured) showSlashMenuFor(captured);
        }, 20);
      } else {
        clearSlashMenu();
      }
      return !ev.defaultPrevented;
    }
    return false;
  };

  const harness = createMockHostHarness({ document: doc });
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    let composerApi = null;
    await harness.rendererHost.mountPlugin('test.lexical.composer', {
      mount(ctx) { composerApi = ctx.services.get('composer'); }
    });
    await composerApi.updateSettings({
      contextAwareQuickItems: false,
      quickItems: ['compact', 'swarm']
    });

    doc.getElementById('agy-qcap-compact').click();
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(beforeInputDatas, ['/compact']);
    assert.deepEqual(sentActions, ['[pill:compact]']);

    doc.getElementById('agy-qcap-swarm').click();
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(beforeInputDatas, ['/compact', '/swarm']);
    assert.equal(editorBuffer, '[pill:swarm]');

    await harness.rendererHost.disposePlugin('test.lexical.composer');
    await harness.unloadPlugin('agy-daddy.composer');
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    if (prevInputEvent === undefined) delete globalThis.InputEvent;
    else globalThis.InputEvent = prevInputEvent;
    await harness.cleanup();
  }
});

test('回归：Lexical 异步选区与多行优化结果原子粘贴写入不残留旧草稿、不丢换行不乱序且支持撤回', async () => {
  const { createMockDocument } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

  class MockDataTransfer {
    constructor() { this._map = new Map(); }
    setData(type, val) { this._map.set(String(type), String(val ?? '')); }
    getData(type) { return this._map.get(String(type)) || ''; }
  }

  class MockClipboardEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
      this.clipboardData = init.clipboardData || null;
      this.defaultPrevented = false;
    }
    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
  }

  const prevClipboardEvent = globalThis.ClipboardEvent;
  const prevDataTransfer = globalThis.DataTransfer;
  const prevEvent = globalThis.Event;
  globalThis.ClipboardEvent = MockClipboardEvent;
  globalThis.DataTransfer = MockDataTransfer;
  if (typeof globalThis.Event !== 'function') {
    globalThis.Event = class MockEvent {
      constructor(type) { this.type = type; }
    };
  }

  const doc = createMockDocument();
  doc.defaultView = {
    ClipboardEvent: MockClipboardEvent,
    DataTransfer: MockDataTransfer,
    Event: globalThis.Event
  };
  const editor = doc.querySelector('[contenteditable="true"]');
  const originalDraft = '优化一下主控模型设置\n插件设置弹窗中需要支持模型过滤和排序';
  const optimizedMarkdown = [
    '作为系统架构师与前端/全栈工程师，请按以下需求实现模型编排与插件设置功能：',
    '',
    '### 核心需求与步骤',
    '1. **主控模型编排配置**',
    '   - 将编排主控模型限定并配置为以下 4 个：`carbon`、`argon`、`neon`、`opus5.5`。',
    '   - 为上述每个主控模型分别提供独立的“思考等级”（Thinking Level）设置项，支持按模型单独配置与保存。',
    '2. **插件设置弹窗（Plugin Settings Modal）交互**',
    '   - **模型过滤（Filter）**：在弹窗内增加模型过滤功能，支持用户按模型名称或指定维度筛选可用模型。',
    '   - **模型排序（Sort）**：提供模型列表的排序功能（如按首字母、使用频率或自定义规则等），方便快速定位。',
    '### 验收标准',
    '- 4 个主控模型定义明确，思考等级参数独立生效且可持久化。',
    '- 插件设置弹窗中过滤与排序逻辑响应流畅，状态重置与多条件交互无异常。'
  ].join('\n');

  let editorBuffer = originalDraft;
  // 模拟 Lexical 内部选区：初始仅聚焦在第一行尾部，selectAll 后需等 selectionchange / 下一 tick 才同步为全选
  let domSelectedAll = false;
  let lexicalSelectedAll = false;
  const insertTextCalls = [];

  Object.defineProperty(editor, 'textContent', {
    configurable: true,
    get() { return editorBuffer; },
    set(v) { editorBuffer = String(v ?? ''); }
  });
  Object.defineProperty(editor, 'innerText', {
    configurable: true,
    get() { return editorBuffer ? `${editorBuffer}\n` : '\n'; }
  });

  doc.addEventListener('selectionchange', () => {
    if (domSelectedAll) lexicalSelectedAll = true;
  });

  editor.addEventListener('paste', (ev) => {
    const pasted = ev?.clipboardData?.getData?.('text/plain') || '';
    if (!pasted) return;
    ev.preventDefault();
    const textToApply = pasted;
    setTimeout(() => {
      editorBuffer = lexicalSelectedAll ? textToApply : `${editorBuffer}${textToApply}`;
      lexicalSelectedAll = false;
      domSelectedAll = false;
    }, 10);
  });

  doc.execCommand = (cmd, _ui, val) => {
    if (cmd === 'selectAll') {
      domSelectedAll = true;
      // 模拟真实 Lexical 延迟同步 RangeSelection（同步立刻 delete 无法清空）
      setTimeout(() => {
        if (domSelectedAll) lexicalSelectedAll = true;
      }, 8);
      return true;
    }
    if (cmd === 'delete') {
      if (lexicalSelectedAll) {
        editorBuffer = '';
        lexicalSelectedAll = false;
        domSelectedAll = false;
        return true;
      }
      // 复现旧选区未同步导致删除失败/仅删部分尾部字符
      editorBuffer = editorBuffer.replace(/优化一下主控模型设置\n?/, '');
      return false;
    }
    if (cmd === 'insertText') {
      const str = String(val ?? '');
      insertTextCalls.push(str);
      if (str.includes('\n')) {
        // 复现原 Bug：多行 insertText 在 Lexical 中丢换行并把首行挤到末尾
        const lines = str.split('\n').filter(Boolean);
        const broken = lines.length > 1 ? `${lines.slice(1).join('')}${lines[0]}` : lines.join('');
        editorBuffer = `${editorBuffer}${broken}`;
      } else {
        editorBuffer = `${editorBuffer}${str}`;
      }
      return true;
    }
    return false;
  };

  const harness = createMockHostHarness({
    document: doc,
    onRpc(method) {
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { modelId: 'gemini-2.5-flash-low', label: 'Flash Low', modelOrAlias: { model: 'FLASH_LOW' }, quotaInfo: { remainingFraction: 1 } }
              ]
            }
          }
        };
      }
      if (method === 'GetModelResponse') {
        return { response: optimizedMarkdown };
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    let composerApi = null;
    await harness.rendererHost.mountPlugin('test.lexical.multiline', {
      mount(ctx) { composerApi = ctx.services.get('composer'); }
    });

    const optRes = await composerApi.optimizePrompt();
    assert.equal(optRes.ok, true);
    assert.equal(editorBuffer.includes('插件设置弹窗中需要支持模型过滤和排序'), false, '不应残留旧草稿');
    assert.equal(editorBuffer, optimizedMarkdown, '优化后多行 Markdown 顺序与换行必须完整保留');
    assert.equal(editorBuffer.startsWith('作为系统架构师与前端/全栈工程师，请按以下需求实现模型编排与插件设置功能：'), true);
    assert.equal(editorBuffer.endsWith('- 插件设置弹窗中过滤与排序逻辑响应流畅，状态重置与多条件交互无异常。'), true);
    assert.equal(insertTextCalls.some((s) => s.includes('\n')), false, '绝不应向 execCommand(insertText) 传入含换行字符串');

    await composerApi.undoPromptOptimization();
    assert.equal(editorBuffer, originalDraft, '撤回后应完整恢复多行原始草稿');
    assert.equal(insertTextCalls.some((s) => s.includes('\n')), false);

    await harness.rendererHost.disposePlugin('test.lexical.multiline');
    await harness.unloadPlugin('agy-daddy.composer');
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    if (prevClipboardEvent === undefined) delete globalThis.ClipboardEvent;
    else globalThis.ClipboardEvent = prevClipboardEvent;
    if (prevDataTransfer === undefined) delete globalThis.DataTransfer;
    else globalThis.DataTransfer = prevDataTransfer;
    if (prevEvent === undefined) delete globalThis.Event;
    else globalThis.Event = prevEvent;
    await harness.cleanup();
  }
});

test('回归：无 paste 处理器时多行优化结果走逐行单行插入 + 软换行回退且顺序完整', async () => {
  const { createMockDocument } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

  class MockDataTransfer {
    constructor() { this._map = new Map(); }
    setData(type, val) { this._map.set(String(type), String(val ?? '')); }
    getData(type) { return this._map.get(String(type)) || ''; }
  }

  class MockClipboardEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.bubbles = Boolean(init.bubbles);
      this.cancelable = Boolean(init.cancelable);
      this.clipboardData = init.clipboardData || null;
      this.defaultPrevented = false;
    }
    preventDefault() {}
  }

  const prevClipboardEvent = globalThis.ClipboardEvent;
  const prevDataTransfer = globalThis.DataTransfer;
  globalThis.ClipboardEvent = MockClipboardEvent;
  globalThis.DataTransfer = MockDataTransfer;

  const doc = createMockDocument();
  doc.defaultView = {
    ClipboardEvent: MockClipboardEvent,
    DataTransfer: MockDataTransfer,
    Event: globalThis.Event
  };
  const editor = doc.querySelector('[contenteditable="true"]');
  const originalDraft = '第一行旧草稿\n第二行旧草稿';
  const optimizedMarkdown = [
    '请按以下需求实现：',
    '',
    '1. 第一步配置模型',
    '2. 第二步过滤排序'
  ].join('\n');

  let editorBuffer = originalDraft;
  let lexicalSelectedAll = false;
  const insertTextCalls = [];
  let lineBreakCount = 0;

  Object.defineProperty(editor, 'textContent', {
    configurable: true,
    get() { return editorBuffer; },
    set(v) { editorBuffer = String(v ?? ''); }
  });
  Object.defineProperty(editor, 'innerText', {
    configurable: true,
    get() { return editorBuffer ? `${editorBuffer}\n` : '\n'; }
  });

  // 故意不调用 ev.preventDefault()，模拟 paste 未被宿主接管的场景
  editor.addEventListener('paste', () => {});

  doc.execCommand = (cmd, _ui, val) => {
    if (cmd === 'selectAll') {
      setTimeout(() => { lexicalSelectedAll = true; }, 8);
      return true;
    }
    if (cmd === 'delete') {
      if (lexicalSelectedAll) {
        editorBuffer = '';
        lexicalSelectedAll = false;
        return true;
      }
      return false;
    }
    if (cmd === 'insertText') {
      const str = String(val ?? '');
      insertTextCalls.push(str);
      assert.equal(str.includes('\n'), false, '回退路径也不得传入含换行字符串');
      editorBuffer = `${editorBuffer}${str}`;
      return true;
    }
    if (cmd === 'insertLineBreak') {
      lineBreakCount += 1;
      editorBuffer = `${editorBuffer}\n`;
      return true;
    }
    return false;
  };

  const harness = createMockHostHarness({
    document: doc,
    onRpc(method) {
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { modelId: 'gemini-2.5-flash-low', label: 'Flash Low', modelOrAlias: { model: 'FLASH_LOW' }, quotaInfo: { remainingFraction: 1 } }
              ]
            }
          }
        };
      }
      if (method === 'GetModelResponse') {
        return { response: optimizedMarkdown };
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    let composerApi = null;
    await harness.rendererHost.mountPlugin('test.lexical.fallback', {
      mount(ctx) { composerApi = ctx.services.get('composer'); }
    });

    const optRes = await composerApi.optimizePrompt();
    assert.equal(optRes.ok, true);
    assert.equal(editorBuffer, optimizedMarkdown);
    assert.equal(lineBreakCount, 3);
    assert.deepEqual(insertTextCalls, [
      '请按以下需求实现：',
      '1. 第一步配置模型',
      '2. 第二步过滤排序'
    ]);

    await harness.rendererHost.disposePlugin('test.lexical.fallback');
    await harness.unloadPlugin('agy-daddy.composer');
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    if (prevClipboardEvent === undefined) delete globalThis.ClipboardEvent;
    else globalThis.ClipboardEvent = prevClipboardEvent;
    if (prevDataTransfer === undefined) delete globalThis.DataTransfer;
    else globalThis.DataTransfer = prevDataTransfer;
    await harness.cleanup();
  }
});

test('回归：提示词优化失败时气泡不被感知提示遮挡、按钮旁内联报错、重渲染保留、支持关闭快捷栏与纯快捷键浮动提示', async () => {
  let failKind = 'http429';
  const harness = createMockHostHarness({
    onRpc(method) {
      if (method === 'GetUserStatus') {
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                { modelId: 'gemini-2.5-flash-low', label: 'Flash Low', modelOrAlias: { model: 'FLASH_LOW' }, quotaInfo: { remainingFraction: 1 } }
              ]
            }
          }
        };
      }
      if (method === 'GetModelResponse') {
        if (failKind === 'timeout') {
          throw new Error('ROUTE_TIMEOUT');
        }
        throw new Error('HTTP 429 rate limited');
      }
      return { ok: true };
    }
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    let composerApi = null;
    let emitContext = null;
    await harness.rendererHost.mountPlugin('test.opt.error.feedback', {
      mount(ctx) {
        composerApi = ctx.services.get('composer');
        emitContext = (snap) => ctx.state.set('state:context.snapshot@1', snap);
      }
    });

    const doc = harness.mockDoc;
    const editor = doc.querySelector('[contenteditable="true"]');

    // 1. 验证样式 z-index 层级与 DOM 顺序：#agy-qcap-toast 必须在 #agy-next-step-ghost 之后
    const styleEl = doc.head.querySelector('[data-agy-style="agy-daddy.composer"]');
    assert.ok(styleEl);
    assert.match(styleEl.textContent, /#agy-qcap-toast\s*\{[\s\S]*?z-index:\s*6;/);
    assert.match(styleEl.textContent, /#agy-prompt-opt-status\[data-tone="error"\]/);
    assert.match(styleEl.textContent, /#agy-composer-float-toast\[data-tone="error"\]/);

    const quickBar = doc.getElementById('agy-quick-capsule-bar');
    const quickChildren = Array.from(quickBar.children).map((el) => el.id);
    assert.ok(quickChildren.indexOf('agy-next-step-ghost') >= 0);
    assert.ok(quickChildren.indexOf('agy-qcap-toast') > quickChildren.indexOf('agy-next-step-ghost'), 'toast 必须排在 ghost 之后避免被 sticky 遮挡');

    // 2. 优化失败：按钮旁 #agy-prompt-opt-status 与 #agy-qcap-toast 均可见报错，按钮标记 data-error="true"
    editor.textContent = '帮我优化这段提示词';
    doc.dispatchEvent({ type: 'input', target: editor });
    doc.getElementById('agy-prompt-opt-btn').click();
    await new Promise((r) => setTimeout(r, 40));

    const optBtn = doc.getElementById('agy-prompt-opt-btn');
    const optStatus = doc.getElementById('agy-prompt-opt-status');
    const qcapToast = doc.getElementById('agy-qcap-toast');
    assert.equal(optBtn.getAttribute('data-error'), 'true');
    assert.equal(optStatus.hidden, false);
    assert.equal(optStatus.getAttribute('data-tone'), 'error');
    assert.match(optStatus.textContent, /优化失败：HTTP 429/);
    assert.match(optStatus.getAttribute('title') || '', /Flash Low: HTTP 429/);
    assert.equal(qcapToast.hidden, false);
    assert.equal(qcapToast.getAttribute('data-tone'), 'error');
    assert.match(qcapToast.textContent, /优化失败：HTTP 429/);

    // 3. 快捷栏触发重渲染后，进行中的错误提示应保留不被清空
    emitContext({ used: 250000, max: 1000000 });
    await new Promise((r) => setTimeout(r, 20));
    const qcapToastAfterRerender = doc.getElementById('agy-qcap-toast');
    assert.equal(qcapToastAfterRerender.hidden, false);
    assert.equal(qcapToastAfterRerender.getAttribute('data-tone'), 'error');
    assert.match(qcapToastAfterRerender.textContent, /429/);

    // 点击按钮旁状态胶囊可一键关闭报错状态
    optStatus.click();
    assert.equal(optStatus.hidden, true);
    assert.equal(qcapToastAfterRerender.hidden, true);
    assert.equal(optBtn.getAttribute('data-error'), null);

    // 4. 关闭快捷栏（showQuickBar: false）时，失败仍通过 #agy-prompt-opt-status 可见
    await composerApi.updateSettings({ showQuickBar: false });
    assert.equal(doc.getElementById('agy-quick-capsule-bar'), null);
    doc.getElementById('agy-prompt-opt-btn').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(optStatus.hidden, false);
    assert.equal(optStatus.getAttribute('data-tone'), 'error');
    assert.match(optStatus.textContent, /429/);

    // 5. 同时关闭快捷栏与优化按钮（纯快捷键模式）且发生超时：兜底渲染 #agy-composer-float-toast 中文超时提示
    await composerApi.updateSettings({ showQuickBar: false, showPromptOptimizer: false });
    assert.equal(doc.getElementById('agy-prompt-opt-wrap'), null);
    failKind = 'timeout';
    doc.dispatchEvent({
      type: 'keydown',
      key: 'O',
      code: 'KeyO',
      altKey: true,
      shiftKey: true,
      target: editor,
      preventDefault() {},
      stopPropagation() {}
    });
    await new Promise((r) => setTimeout(r, 40));

    const floatToast = doc.getElementById('agy-composer-float-toast');
    assert.ok(floatToast, '纯快捷键模式失败应渲染 #agy-composer-float-toast');
    assert.equal(floatToast.hidden, false);
    assert.equal(floatToast.getAttribute('data-tone'), 'error');
    assert.match(floatToast.textContent, /提示词优化超时/);

    await harness.rendererHost.disposePlugin('test.opt.error.feedback');
    await harness.unloadPlugin('agy-daddy.composer');
    assert.equal(doc.getElementById('agy-composer-float-toast'), null);
    assert.equal(doc.getElementById('agy-prompt-opt-status'), null);
    harness.assertCleanDispose('agy-daddy.composer');
  } finally {
    await harness.cleanup();
  }
});
