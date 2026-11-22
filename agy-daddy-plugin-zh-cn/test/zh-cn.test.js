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
const {
  BRAND_TITLE_MODES,
  EXACT_DICTIONARY,
  REGEX_DICTIONARY,
  parseCustomRules,
  translateText
} = require('../src/dictionary');

test('全量 3920+ 精确词典与 341+ 正则规则、品牌标题档位、路径保护与自定义规则优先级', () => {
  assert.ok(EXACT_DICTIONARY.size >= 3920, `expected >= 3920 exact entries, got ${EXACT_DICTIONARY.size}`);
  assert.ok(REGEX_DICTIONARY.length >= 340, `expected >= 340 regex rules, got ${REGEX_DICTIONARY.length}`);

  assert.equal(translateText('  New Chat  '), '  新建对话  ');
  assert.equal(translateText('Thought for 12.5 seconds'), '已思考 12.5 秒');
  assert.equal(translateText('Reviewed 4 files'), '已查阅 4 个文件');
  assert.equal(translateText('See all (18)'), '查看全部 (18)');

  // 路径与命令保护不被误翻译
  assert.equal(translateText('/Users/dev/Settings/New Chat'), '/Users/dev/Settings/New Chat');
  assert.equal(translateText('https://example.com/Accept'), 'https://example.com/Accept');

  // 品牌标题三档切换
  assert.equal(translateText('Antigravity', { brandTitle: BRAND_TITLE_MODES.ENGLISH }), 'Antigravity');
  assert.equal(translateText('Antigravity', { brandTitle: BRAND_TITLE_MODES.TRANSLATED }), '反重力');
  assert.equal(translateText('Antigravity', { brandTitle: BRAND_TITLE_MODES.HIDDEN }), '');

  // 英文保留档位预设关闭 vs 开启
  assert.equal(translateText('Turbo', { englishLabels: false }), '无限');
  assert.equal(translateText('Turbo', { englishLabels: true }), 'Turbo');

  // 自定义规则最高优先级（覆盖 englishLabels 且支持空译文保留原文）
  const rules = parseCustomRules('Turbo => 暴走模式\nAccept =>');
  assert.equal(translateText('Turbo', { englishLabels: true, customRules: rules }), '暴走模式');
  assert.equal(translateText('Accept', { customRules: rules }), 'Accept');
});

test('插件契约：可逆 DOM 汉化/[data-uri]/code 跳过/自定义会话标题优先/默认禁外发与零残留 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
  }

  let fetchCalled = 0;
  const mockFetch = async () => {
    fetchCalled++;
    return { ok: true, status: 200, json: async () => [[['你好世界', 'hello world']]] };
  };

  const harness = createMockHostHarness({
    seedAnchors: [{ tag: 'div', attr: 'data-testid', val: 'conversation-list-row' }],
    fetch: mockFetch
  });
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    // 插入可翻译宿主节点、受保护 [data-uri] 节点、<code> 节点及品牌标题节点
    const btn = createMockElement('button', harness.mockDoc);
    btn.textContent = 'New Chat';
    btn.setAttribute('aria-label', 'Review Changes');
    harness.mockDoc.body.appendChild(btn);

    const uriNode = createMockElement('span', harness.mockDoc);
    uriNode.setAttribute('data-uri', 'file:///src/Settings');
    uriNode.textContent = 'Settings';
    harness.mockDoc.body.appendChild(uriNode);

    const codeNode = createMockElement('code', harness.mockDoc);
    codeNode.textContent = 'Accept';
    harness.mockDoc.body.appendChild(codeNode);

    const brandNode = createMockElement('span', harness.mockDoc);
    brandNode.setAttribute('data-testid', 'brand-title');
    brandNode.textContent = 'Antigravity';
    harness.mockDoc.body.appendChild(brandNode);

    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0', inProcessRenderer: true });

    // 挂载即按默认 zh 翻译，[data-uri] 与 <code> 原封不动
    assert.equal(btn.textContent, '新建对话');
    assert.equal(btn.getAttribute('aria-label'), '审查更改');
    assert.equal(uriNode.textContent, 'Settings');
    assert.equal(codeNode.textContent, 'Accept');
    assert.equal(brandNode.textContent, 'Antigravity');

    // 模拟 chat-nav 广播思考块展开，未装 chat-nav 也可独立响应新增节点
    const lateThinking = createMockElement('span', harness.mockDoc);
    lateThinking.textContent = 'Thought for 3s';
    harness.mockDoc.body.appendChild(lateThinking);
    let emitThinking = null;
    await harness.rendererHost.mountPlugin('test.emitter', {
      mount(ctx) { emitThinking = () => ctx.events.emit('chat:thinking-expanded@1', { count: 1 }); }
    });
    emitThinking();
    assert.equal(lateThinking.textContent, '已思考 3 秒');
    await harness.rendererHost.disposePlugin('test.emitter');

    const langBtn = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot.querySelector('#agy-topbar-slots').children
      .find((c) => c.id === 'agy-unit-agy-daddy.zh-cn-lang-toggle');
    assert.equal(langBtn.textContent, '中');

    // 点击切换到 EN 原地无损还原
    langBtn.click();
    assert.equal(langBtn.textContent, 'EN');
    assert.equal(btn.textContent, 'New Chat');
    assert.equal(btn.getAttribute('aria-label'), 'Review Changes');

    // 默认禁用远程思考翻译外发，且用户自定义会话标题优先级高于默认翻译
    const zhSvc = harness.bus.getServiceProxy('zh-cn');
    await zhSvc.setCustomTitle('conv-1', '我的专属架构重构');
    const customTitleRes = await zhSvc.translateConversationTitle('conv-1', 'New Chat');
    assert.equal(customTitleRes.source, 'custom');
    assert.equal(customTitleRes.title, '我的专属架构重构');

    const blocked = await zhSvc.translateSnippet('unseen technical phrase');
    assert.equal(blocked.blocked, true);
    assert.equal(fetchCalled, 0);

    await zhSvc.setConfig({ enableRemoteThinkingTranslation: true });
    const remoteRes = await zhSvc.translateSnippet('unseen technical phrase');
    assert.equal(remoteRes.ok, true);
    assert.equal(remoteRes.text, '你好世界');
    assert.equal(fetchCalled, 1);

    // 切回中文后再卸载，验证 dispose 自动还原全部节点且零残留
    langBtn.click();
    assert.equal(btn.textContent, '新建对话');
    await harness.unloadPlugin('agy-daddy.zh-cn');
    assert.equal(btn.textContent, 'New Chat');
    harness.assertCleanDispose('agy-daddy.zh-cn');
  } finally {
    await harness.cleanup();
  }
});
