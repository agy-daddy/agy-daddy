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
  DEFAULT_LANG,
  SUPPORTED_LANGUAGES,
  BRAND_TITLE_MODES,
  EXACT_DICTIONARY,
  REGEX_DICTIONARY,
  normalizeLang,
  getLanguageMeta,
  getLanguageDictionary,
  getDictionaryStats,
  parseCustomRules,
  translateText
} = require('../src/dictionary');

async function waitUntil(pred, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

test('10 语言元数据、别名规范化、全量词典与正则规则、品牌标题档位、路径保护及自定义规则优先级', () => {
  assert.equal(DEFAULT_LANG, 'zh');
  assert.equal(SUPPORTED_LANGUAGES.length, 10);

  // 别名规范化
  assert.equal(normalizeLang('zh-CN'), 'zh');
  assert.equal(normalizeLang('zh_cn'), 'zh');
  assert.equal(normalizeLang('zh-Hant'), 'zh-TW');
  assert.equal(normalizeLang('zh-HK'), 'zh-TW');
  assert.equal(normalizeLang('ja-JP'), 'ja');
  assert.equal(normalizeLang('ko-KR'), 'ko');
  assert.equal(normalizeLang('es-419'), 'es');
  assert.equal(normalizeLang('pt-BR'), 'pt');
  assert.equal(normalizeLang('fr-CA'), 'fr');
  assert.equal(normalizeLang('ru-RU'), 'ru');
  assert.equal(normalizeLang('it-IT'), 'it');
  assert.equal(normalizeLang('en-US'), 'en');
  assert.equal(normalizeLang('unknown-lang', 'zh'), 'zh');

  assert.ok(EXACT_DICTIONARY.size >= 3920, `expected >= 3920 exact entries, got ${EXACT_DICTIONARY.size}`);
  assert.ok(REGEX_DICTIONARY.length >= 340, `expected >= 340 regex rules, got ${REGEX_DICTIONARY.length}`);

  const allStats = getDictionaryStats('all');
  assert.equal(allStats.totalLanguages, 10);

  const nonEnCodes = SUPPORTED_LANGUAGES.map((l) => l.code).filter((c) => c !== 'en');
  for (const code of nonEnCodes) {
    const dict = getLanguageDictionary(code);
    assert.ok(dict.exactMap.size >= 3974, `${code}: expected >= 3974 exact entries, got ${dict.exactMap.size}`);
    assert.ok(dict.regexRules.length >= 340, `${code}: expected >= 340 regex rules, got ${dict.regexRules.length}`);

    for (const key of [
      'Interface Layout',
      'Screen Reader Mode',
      'Search shortcuts...',
      'Built-in Browser',
      'Manage project folders and settings.',
      'Pin / Unpin Conversation',
      'Font',
      'Side Chat',
      'Side Conversation',
      'Insert into Composer',
      'Clear Side Chat',
      'Independent Side Chat',
      'Custom Menu',
      'Plugin Management',
      'Stop Task'
    ]) {
      assert.notEqual(translateText(key, { lang: code }), key, `${code} must translate "${key}"`);
    }

    const trWeekly = translateText('You have used some of your weekly limit, it will fully refresh in 4 days, 23 hours.', { lang: code });
    assert.notEqual(trWeekly, 'You have used some of your weekly limit, it will fully refresh in 4 days, 23 hours.', `${code} weekly limit`);
    assert.equal(/\b(?:days?|hours?)\b/i.test(trWeekly), false, `${code} weekly limit must not leak English days/hours: ${trWeekly}`);

    const tr5h = translateText('You have used some of your 5-hour limit, it will fully refresh in 2 hours, 15 minutes.', { lang: code });
    assert.notEqual(tr5h, 'You have used some of your 5-hour limit, it will fully refresh in 2 hours, 15 minutes.', `${code} 5h limit`);
    assert.equal(/\bhours?\b|\bminutes?\b(?!\()/i.test(tr5h), false, `${code} 5h limit must not leak English hours/minutes: ${tr5h}`);
    assert.equal(/\(s\)\(s\)/.test(tr5h), false, `${code} 5h limit must not duplicate (s): ${tr5h}`);

    const trChat = translateText('  New Chat  ', { lang: code });
    assert.notEqual(trChat.trim(), 'New Chat', `${code} must translate New Chat`);
    assert.ok(trChat.startsWith('  ') && trChat.endsWith('  '), `${code} must preserve surrounding spaces`);

    const trThought = translateText('Thought for 12.5 seconds', { lang: code });
    assert.notEqual(trThought, 'Thought for 12.5 seconds', `${code} must translate Thought for N seconds`);
    assert.ok(trThought.includes('12.5'), `${code} must preserve 12.5 in Thought pattern`);

    const trRev = translateText('Reviewed 4 files', { lang: code });
    assert.notEqual(trRev, 'Reviewed 4 files', `${code} must translate Reviewed N files`);
    assert.ok(trRev.includes('4'), `${code} must preserve 4 in Reviewed pattern`);

    const trSee = translateText('See all (18)', { lang: code });
    assert.notEqual(trSee, 'See all (18)', `${code} must translate See all (18)`);
    assert.ok(trSee.includes('18'), `${code} must preserve 18 in See all pattern`);

    // 路径与命令保护不被误翻译
    assert.equal(translateText('/Users/dev/Settings/New Chat', { lang: code }), '/Users/dev/Settings/New Chat');
    assert.equal(translateText('https://example.com/Accept', { lang: code }), 'https://example.com/Accept');

    // 英文保留档位跨语言生效：Default 等通用词仅在模型/权限选项上下文保留英文，不误伤常规设置项
    assert.notEqual(translateText('Default', { lang: code, englishLabels: false }), 'Default');
    assert.notEqual(translateText('Default', { lang: code, englishLabels: true }), 'Default');
    assert.equal(translateText('Default', { lang: code, englishLabels: true, inOptionContext: true }), 'Default');
    assert.equal(translateText('Turbo', { lang: code, englishLabels: true }), 'Turbo');
    assert.equal(translateText('Always Proceed', { lang: code, englishLabels: true }), 'Always Proceed');
    assert.equal(translateText('Gemini 4 Neon (High)', { lang: code, englishLabels: true }), 'Gemini 4 Neon (High)');
    assert.notEqual(translateText('Gemini 4 Neon (High)', { lang: code, englishLabels: false }), 'Gemini 4 Neon (High)');
    assert.notEqual(translateText('Claude Sonnet 4.6 (Thinking)', { lang: code, englishLabels: false }), 'Claude Sonnet 4.6 (Thinking)');

    // 品牌标题三档切换
    assert.equal(translateText('Antigravity', { lang: code, brandTitle: BRAND_TITLE_MODES.ENGLISH }), 'Antigravity');
    assert.equal(
      translateText('Antigravity', { lang: code, brandTitle: BRAND_TITLE_MODES.TRANSLATED }),
      getLanguageMeta(code).brandTranslated
    );
    assert.equal(translateText('Antigravity', { lang: code, brandTitle: BRAND_TITLE_MODES.HIDDEN }), '');
  }

  // zh 具体文案基线
  assert.equal(translateText('  New Chat  ', { lang: 'zh' }), '  新建对话  ');
  assert.equal(translateText('Thought for 12.5 seconds', { lang: 'zh' }), '已思考 12.5 秒');
  assert.equal(translateText('Reviewed 4 files', { lang: 'zh' }), '已查阅 4 个文件');
  assert.equal(translateText('See all (18)', { lang: 'zh' }), '查看全部 (18)');
  assert.equal(translateText('Turbo', { lang: 'zh', englishLabels: false }), '无限');
  assert.equal(translateText('Turbo', { lang: 'zh', englishLabels: true }), 'Turbo');

  // en 原文直通
  assert.equal(translateText('New Chat', { lang: 'en' }), 'New Chat');
  assert.equal(translateText('Thought for 12.5 seconds', { lang: 'en' }), 'Thought for 12.5 seconds');

  // 自定义规则最高优先级（覆盖 englishLabels 且支持空译文保留原文）
  const rules = parseCustomRules('Turbo => 暴走模式\nAccept =>');
  assert.equal(translateText('Turbo', { lang: 'ja', englishLabels: true, customRules: rules }), '暴走模式');
  assert.equal(translateText('Accept', { lang: 'ja', customRules: rules }), 'Accept');
});

test('插件契约：isolated 世界多语言 DOM 切换、Popover 选单、命令执行、按语言远程翻译缓存与零残留 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
  }
  const rendererSrc = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', 'renderer.js'), 'utf8');
  assert.equal(/registerSection/.test(rendererSrc), false, 'Renderer must not use deprecated registerSection');

  const fetchCalls = [];
  const nativeFetch = globalThis.fetch;
  const mockFetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr.startsWith('http://127.0.0.1:') && urlStr.includes('/plugins/')) {
      return nativeFetch(url, init);
    }
    fetchCalls.push(urlStr);
    const m = urlStr.match(/[?&]tl=([^&]+)/);
    const tl = m ? decodeURIComponent(m[1]) : 'zh-CN';
    return {
      ok: true,
      status: 200,
      json: async () => [[[`[${tl}] hello world`, 'unseen technical phrase']]]
    };
  };

  const harness = createMockHostHarness({
    seedAnchors: [{ tag: 'div', attr: 'data-testid', val: 'conversation-list-row' }],
    fetch: mockFetch
  });
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port, hostToken: harness.bridge.hostToken });

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

    const turboNode = createMockElement('span', harness.mockDoc);
    turboNode.setAttribute('data-testid', 'mode-option');
    turboNode.textContent = 'Turbo';
    harness.mockDoc.body.appendChild(turboNode);

    const convRow = createMockElement('div', harness.mockDoc);
    convRow.setAttribute('data-testid', 'conversation-list-row');
    convRow.setAttribute('data-cascade-id', 'conv-2');
    const convTitleNode = createMockElement('span', harness.mockDoc);
    convTitleNode.textContent = 'New Chat';
    convRow.appendChild(convTitleNode);
    harness.mockDoc.body.appendChild(convRow);

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.equal(loaded.manifest.world, 'isolated');
    assert.equal(loaded.trust.world, 'isolated');
    assert.equal(loaded.manifest.permissions.includes('page:main-world'), false);
    assert.equal(loaded.manifest.permissions.includes('bridge:route'), true);
    assert.equal(loaded.manifest.contributes['topbar.units'], undefined);
    assert.equal(loaded.manifest.contributes['topbar.popovers'], undefined);
    assert.equal('migrations' in (loaded.manifest.contributes || {}), false);
    assert.ok(harness.isolatedWorlds.has('agy-daddy.zh-cn'));
    assert.ok(harness.bridge.countPluginRoutes('agy-daddy.zh-cn') >= 5);

    // 挂载即按默认 zh 翻译，[data-uri] 与 <code> 原封不动
    assert.equal(btn.textContent, '新建对话');
    assert.equal(btn.getAttribute('aria-label'), '审查更改');
    assert.equal(uriNode.textContent, 'Settings');
    assert.equal(codeNode.textContent, 'Accept');
    assert.equal(brandNode.textContent, 'Antigravity');
    assert.equal(turboNode.textContent, '无限');

    // 托管设置中心实时切换 brandTitle 与 englishLabels
    await harness.updatePluginSettings('agy-daddy.zh-cn', { brandTitle: 'translated', englishLabels: true });
    assert.equal(brandNode.textContent, '反重力');
    assert.equal(turboNode.textContent, 'Turbo');

    await harness.updatePluginSettings('agy-daddy.zh-cn', { brandTitle: 'hidden' });
    assert.equal(brandNode.style.getPropertyValue('display'), 'none');

    await harness.updatePluginSettings('agy-daddy.zh-cn', { brandTitle: 'english', englishLabels: false });
    assert.equal(brandNode.style.getPropertyValue('display'), '');
    assert.equal(brandNode.textContent, 'Antigravity');
    assert.equal(turboNode.textContent, '无限');

    // 模拟 chat-nav 广播思考块展开
    const lateThinking = createMockElement('span', harness.mockDoc);
    lateThinking.textContent = 'Thought for 3s';
    harness.mockDoc.body.appendChild(lateThinking);
    let emitThinking = null;
    await harness.rendererHost.mountPlugin('test.emitter', {
      mount(ctx) { emitThinking = () => ctx.events.emit('chat:thinking-expanded@1', { count: 1 }); }
    });
    emitThinking();
    assert.equal(lateThinking.textContent, '已思考 3 秒');
    assert.equal(convTitleNode.textContent, '新建对话');
    await harness.rendererHost.disposePlugin('test.emitter');

    // 验证思考过程与会话标题翻译独立开关（关闭后实时还原原文，开启后恢复翻译）
    await harness.updatePluginSettings('agy-daddy.zh-cn', {
      translateThinking: false,
      translateConversationTitles: false
    });
    assert.equal(lateThinking.textContent, 'Thought for 3s');
    assert.equal(convTitleNode.textContent, 'New Chat');
    assert.equal(btn.textContent, '新建对话');

    await harness.updatePluginSettings('agy-daddy.zh-cn', {
      translateThinking: true,
      translateConversationTitles: true
    });
    assert.equal(lateThinking.textContent, '已思考 3 秒');
    assert.equal(convTitleNode.textContent, '新建对话');

    const shadow = harness.mockDoc.getElementById('agy-daddy-host').shadowRoot;
    assert.equal(
      shadow.querySelector('#agy-topbar-slots').children.some((c) => c.id === 'agy-unit-agy-daddy.zh-cn-lang-toggle'),
      false
    );
    assert.equal(shadow.querySelector('[data-agy-popover="agy-daddy.zh-cn:lang-picker"]'), null);
    assert.equal(shadow.querySelector('#agy-lang-picker-panel'), null);

    // 通过托管设置中心逐一切换 zh-TW -> ja -> ko -> es -> pt -> fr -> ru -> it -> en -> ja
    const sequence = ['zh-TW', 'ja', 'ko', 'es', 'pt', 'fr', 'ru', 'it', 'en', 'ja'];
    for (const targetCode of sequence) {
      await harness.updatePluginSettings('agy-daddy.zh-cn', { lang: targetCode });
      assert.equal(harness.getPluginSettings('agy-daddy.zh-cn').lang, targetCode);

      if (targetCode === 'en') {
        assert.equal(btn.textContent, 'New Chat');
        assert.equal(btn.getAttribute('aria-label'), 'Review Changes');
      } else {
        assert.equal(btn.textContent, translateText('New Chat', { lang: targetCode }));
        assert.equal(btn.getAttribute('aria-label'), translateText('Review Changes', { lang: targetCode }));
      }
      assert.equal(uriNode.textContent, 'Settings');
      assert.equal(codeNode.textContent, 'Accept');
    }

    // 在 ja 状态下执行 zh-cn.toggle-lang：切换至 en 并记住 ja，再次执行恢复 ja
    const cmdToEn = await harness.executeCommand('zh-cn.toggle-lang');
    assert.equal(cmdToEn.ok, true);
    assert.equal(cmdToEn.lang, 'en');
    assert.equal(harness.getPluginSettings('agy-daddy.zh-cn').lang, 'en');
    assert.equal(btn.textContent, 'New Chat');

    const cmdBackJa = await harness.executeCommand('zh-cn.toggle-lang');
    assert.equal(cmdBackJa.ok, true);
    assert.equal(cmdBackJa.lang, 'ja');
    assert.equal(harness.getPluginSettings('agy-daddy.zh-cn').lang, 'ja');
    assert.equal(btn.textContent, translateText('New Chat', { lang: 'ja' }));

    // 执行 zh-cn.set-lang 直接切回 zh
    const setZhRes = await harness.executeCommand('zh-cn.set-lang', ['zh']);
    assert.equal(setZhRes.ok, true);
    assert.equal(setZhRes.lang, 'zh');
    assert.equal(btn.textContent, '新建对话');

    // 验证 node service 扩展方法及按语言隔离远程翻译缓存
    const zhSvc = harness.bus.getServiceProxy('zh-cn');
    const supported = await zhSvc.getSupportedLanguages();
    assert.equal(supported.length, 10);
    const stats = await zhSvc.getDictionaryStats('fr');
    assert.equal(stats.lang, 'fr');
    assert.ok(stats.exactCount >= 3920);

    await zhSvc.setCustomTitle('conv-1', '我的专属架构重构');
    const customTitleRes = await zhSvc.translateConversationTitle('conv-1', 'New Chat');
    assert.equal(customTitleRes.source, 'custom');
    assert.equal(customTitleRes.title, '我的专属架构重构');

    // 关闭独立开关后：translateSnippet({ kind: 'thinking' }) 与 translateConversationTitle 返回原文（自定义标题仍保留）
    await harness.updatePluginSettings('agy-daddy.zh-cn', {
      translateThinking: false,
      translateConversationTitles: false
    });
    const thinkDisabledRes = await zhSvc.translateSnippet('Thought for 5s', { kind: 'thinking' });
    assert.equal(thinkDisabledRes.source, 'disabled');
    assert.equal(thinkDisabledRes.text, 'Thought for 5s');
    const titleDisabledRes = await zhSvc.translateConversationTitle('conv-2', 'New Chat');
    assert.equal(titleDisabledRes.source, 'disabled');
    assert.equal(titleDisabledRes.title, 'New Chat');
    const customKeptRes = await zhSvc.translateConversationTitle('conv-1', 'New Chat');
    assert.equal(customKeptRes.source, 'custom');
    assert.equal(customKeptRes.title, '我的专属架构重构');

    await harness.updatePluginSettings('agy-daddy.zh-cn', {
      translateThinking: true,
      translateConversationTitles: true
    });

    const blocked = await zhSvc.translateSnippet('unseen technical phrase');
    assert.equal(blocked.blocked, true);
    assert.equal(fetchCalls.length, 0);

    await harness.updatePluginSettings('agy-daddy.zh-cn', { enableRemoteThinkingTranslation: true });
    const remoteZh = await zhSvc.translateSnippet('unseen technical phrase');
    assert.equal(remoteZh.ok, true);
    assert.equal(remoteZh.text, '[zh-CN] hello world');
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0], /tl=zh-CN/);

    // 切换至 ja 后同一 phrase 不应误命中 zh 缓存，而应按 tl=ja 请求并独立缓存
    await zhSvc.setLang('ja');
    const remoteJa = await zhSvc.translateSnippet('unseen technical phrase');
    assert.equal(remoteJa.ok, true);
    assert.equal(remoteJa.text, '[ja] hello world');
    assert.equal(fetchCalls.length, 2);
    assert.match(fetchCalls[1], /tl=ja/);

    const cachedJa = await zhSvc.translateSnippet('unseen technical phrase');
    assert.equal(cachedJa.source, 'cache');
    assert.equal(cachedJa.text, '[ja] hello world');
    assert.equal(fetchCalls.length, 2);

    // 卸载验证 dispose 自动还原全部节点且零残留
    await harness.unloadPlugin('agy-daddy.zh-cn');
    assert.equal(btn.textContent, 'New Chat');
    assert.equal(btn.getAttribute('aria-label'), 'Review Changes');
    harness.assertCleanDispose('agy-daddy.zh-cn');
  } finally {
    await harness.cleanup();
  }
});

test('动态弹出窗口（设置弹窗/切页）MutationObserver 自动增量翻译、受保护容器排除与防自触发死循环', async () => {
  const prevObserver = globalThis.MutationObserver;
  const observerInstances = [];
  class TestMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.observed = [];
      this.disconnected = false;
      this.takeRecordsCalls = 0;
      observerInstances.push(this);
    }
    observe(target, opts) {
      this.observed.push({ target, opts });
    }
    takeRecords() {
      this.takeRecordsCalls++;
      return [];
    }
    disconnect() {
      this.disconnected = true;
    }
    trigger(records) {
      if (!this.disconnected) this.cb(records, this);
    }
  }
  globalThis.MutationObserver = TestMutationObserver;

  const harness = createMockHostHarness({
    seedAnchors: [{ tag: 'div', attr: 'data-testid', val: 'conversation-list-row' }]
  });
  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port, hostToken: harness.bridge.hostToken });

    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0', inProcessRenderer: true });

    const domObs = observerInstances.find((o) =>
      o.observed.some((rec) => rec.opts && rec.opts.characterData === true && rec.opts.attributes === true)
    );
    assert.ok(domObs, 'Expected MutationObserver watching childList/characterData/attributes');
    const takeCountBefore = domObs.takeRecordsCalls;

    // 模拟点击「设置」后 React 动态插入原生设置弹窗（无需重载或切换语言）
    const settingsDialog = createMockElement('div', harness.mockDoc);
    settingsDialog.setAttribute('data-testid', 'settings-dialog');

    const settingsHeading = createMockElement('h2', harness.mockDoc);
    settingsHeading.textContent = 'Settings';
    settingsDialog.appendChild(settingsHeading);

    const dialogBtn = createMockElement('button', harness.mockDoc);
    dialogBtn.textContent = 'New Chat';
    dialogBtn.setAttribute('aria-label', 'Review Changes');
    settingsDialog.appendChild(dialogBtn);

    const protectedMount = createMockElement('div', harness.mockDoc);
    protectedMount.id = 'agy-native-settings-mount';
    const mountInner = createMockElement('span', harness.mockDoc);
    mountInner.textContent = 'Settings';
    protectedMount.appendChild(mountInner);
    settingsDialog.appendChild(protectedMount);

    const protectedCode = createMockElement('code', harness.mockDoc);
    protectedCode.textContent = 'Accept';
    settingsDialog.appendChild(protectedCode);

    const searchInput = createMockElement('input', harness.mockDoc);
    searchInput.setAttribute('placeholder', 'Search shortcuts...');
    searchInput.textContent = 'New Chat';
    settingsDialog.appendChild(searchInput);

    harness.mockDoc.body.appendChild(settingsDialog);
    domObs.trigger([{ type: 'childList', target: harness.mockDoc.body, addedNodes: [settingsDialog] }]);

    assert.ok(await waitUntil(() => settingsHeading.textContent === '设置'));
    assert.equal(dialogBtn.textContent, '新建对话');
    assert.equal(dialogBtn.getAttribute('aria-label'), '审查更改');
    assert.equal(searchInput.getAttribute('placeholder'), '搜索快捷键...');
    assert.equal(searchInput.textContent, 'New Chat');
    assert.equal(mountInner.textContent, 'Settings');
    assert.equal(protectedCode.textContent, 'Accept');
    assert.ok(domObs.takeRecordsCalls > takeCountBefore, 'Expected runWithMutationGuard to call takeRecords()');

    // 模拟弹窗内切 Tab 后属性与文本动态更新
    dialogBtn.textContent = 'Copy';
    dialogBtn.setAttribute('title', 'Cancel');
    domObs.trigger([{ type: 'attributes', target: dialogBtn }]);
    assert.ok(await waitUntil(() => dialogBtn.textContent === '复制'));
    assert.equal(dialogBtn.getAttribute('title'), '取消');

    await harness.unloadPlugin('agy-daddy.zh-cn');
    assert.equal(domObs.disconnected, true);
    assert.equal(settingsHeading.textContent, 'Settings');
    assert.equal(dialogBtn.textContent, 'Copy');
    assert.equal(dialogBtn.getAttribute('title'), 'Cancel');
    assert.equal(searchInput.getAttribute('placeholder'), 'Search shortcuts...');
    harness.assertCleanDispose('agy-daddy.zh-cn');
  } finally {
    globalThis.MutationObserver = prevObserver;
    await harness.cleanup();
  }
});

test('HUB-299 回归：品牌标题多层级、模型与权限选项上下文、动态会话标题、Schedules 与内置斜杠命令全量翻译', async () => {
  const fetchCalls = [];
  const mockFetch = async (url) => {
    fetchCalls.push(String(url));
    const m = String(url).match(/[?&]q=([^&]+)/);
    const q = m ? decodeURIComponent(m[1]) : '';
    return {
      ok: true,
      status: 200,
      json: async () => [[[`[译] ${q}`, q]]]
    };
  };

  const harness = createMockHostHarness({
    seedAnchors: [{ tag: 'div', attr: 'data-testid', val: 'conversation-row-sidebar' }],
    fetch: mockFetch
  });

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port, hostToken: harness.bridge.hostToken });

    // 1. 品牌标题混合 DOM（textNode 与 icon 兄弟节点，以及纯文本节点）
    const brandMixed = createMockElement('div', harness.mockDoc);
    const brandIcon = createMockElement('span', harness.mockDoc);
    brandMixed.appendChild(brandIcon);
    const brandTextNode = { nodeType: 3, nodeValue: 'Antigravity', parentElement: brandMixed, parentNode: brandMixed, isConnected: true };
    brandMixed.childNodes.push(brandTextNode);
    harness.mockDoc.body.appendChild(brandMixed);

    const brandLeaf = createMockElement('span', harness.mockDoc);
    brandLeaf.setAttribute('data-testid', 'brand-title');
    brandLeaf.textContent = 'Antigravity';
    harness.mockDoc.body.appendChild(brandLeaf);

    // 2. 对话宽度与对比度的 Default vs 权限预设 Default vs 模型选择
    const widthSection = createMockElement('div', harness.mockDoc);
    const widthTitle = createMockElement('span', harness.mockDoc);
    widthTitle.textContent = 'Conversation Width';
    const widthDefault = createMockElement('span', harness.mockDoc);
    widthDefault.textContent = 'Default';
    widthSection.appendChild(widthTitle);
    widthSection.appendChild(widthDefault);
    harness.mockDoc.body.appendChild(widthSection);

    const contrastDefault = createMockElement('span', harness.mockDoc);
    contrastDefault.textContent = 'Default';
    harness.mockDoc.body.appendChild(contrastDefault);

    const permGroup = createMockElement('div', harness.mockDoc);
    permGroup.setAttribute('data-testid', 'permission-preset');
    const permDefault = createMockElement('span', harness.mockDoc);
    permDefault.textContent = 'Default';
    const permReadOnly = createMockElement('span', harness.mockDoc);
    permReadOnly.textContent = 'Read Only';
    const permExecPolicy = createMockElement('span', harness.mockDoc);
    permExecPolicy.textContent = 'Execution Policy';
    const permAgentDecides = createMockElement('span', harness.mockDoc);
    permAgentDecides.textContent = 'Agent Decides';
    permGroup.appendChild(permDefault);
    permGroup.appendChild(permReadOnly);
    permGroup.appendChild(permExecPolicy);
    permGroup.appendChild(permAgentDecides);
    harness.mockDoc.body.appendChild(permGroup);

    const modelSelector = createMockElement('button', harness.mockDoc);
    modelSelector.setAttribute('aria-label', 'Select model, current: Gemini 4 Neon (High)');
    const modelText = createMockElement('span', harness.mockDoc);
    modelText.textContent = 'Gemini 4 Neon (High)';
    modelSelector.appendChild(modelText);
    harness.mockDoc.body.appendChild(modelSelector);

    // 3. 浏览器 Change、环境 Local Storage、侧边栏 Search... 与 Side Question
    const changeBtn = createMockElement('button', harness.mockDoc);
    changeBtn.textContent = 'Change';
    const storageOpt = createMockElement('span', harness.mockDoc);
    storageOpt.textContent = 'Local Storage';
    const sidebarSearch = createMockElement('input', harness.mockDoc);
    sidebarSearch.setAttribute('placeholder', 'Search...');
    const sideQuestion = createMockElement('span', harness.mockDoc);
    sideQuestion.textContent = 'Side Question';
    harness.mockDoc.body.appendChild(changeBtn);
    harness.mockDoc.body.appendChild(storageOpt);
    harness.mockDoc.body.appendChild(sidebarSearch);
    harness.mockDoc.body.appendChild(sideQuestion);

    // 4. Schedules 自动化弹窗文案
    const schedModal = createMockElement('div', harness.mockDoc);
    const reqBadge = createMockElement('span', harness.mockDoc);
    reqBadge.textContent = 'Required';
    const reqStar = createMockElement('span', harness.mockDoc);
    reqStar.textContent = '* Required';
    const schedSub = createMockElement('p', harness.mockDoc);
    schedSub.textContent = 'Uses your local files and tools. Schedules only.';
    const trigTitle = createMockElement('span', harness.mockDoc);
    trigTitle.textContent = 'Trigger';
    const atNode = createMockElement('span', harness.mockDoc);
    atNode.textContent = 'at';
    const instrTitle = createMockElement('span', harness.mockDoc);
    instrTitle.textContent = 'Instructions';
    const instrArea = createMockElement('textarea', harness.mockDoc);
    instrArea.setAttribute('placeholder', 'What should the agent do on each run? For example: summarize new bugs assigned to me and anything that changed overnight.');
    schedModal.appendChild(reqBadge);
    schedModal.appendChild(reqStar);
    schedModal.appendChild(schedSub);
    schedModal.appendChild(trigTitle);
    schedModal.appendChild(atNode);
    schedModal.appendChild(instrTitle);
    schedModal.appendChild(instrArea);
    harness.mockDoc.body.appendChild(schedModal);

    // 5. 内置斜杠命令名称与描述（含 plan 不得误翻为套餐方案）
    const slashRowPlan = createMockElement('div', harness.mockDoc);
    const slashPlanName = createMockElement('span', harness.mockDoc);
    slashPlanName.textContent = 'plan';
    const slashPlanCap = createMockElement('span', harness.mockDoc);
    slashPlanCap.textContent = 'Plan';
    const slashPlanDesc = createMockElement('span', harness.mockDoc);
    slashPlanDesc.textContent = 'Plan carefully before executing a task.';
    slashRowPlan.appendChild(slashPlanName);
    slashRowPlan.appendChild(slashPlanCap);
    slashRowPlan.appendChild(slashPlanDesc);
    harness.mockDoc.body.appendChild(slashRowPlan);

    const slashCompact = createMockElement('span', harness.mockDoc);
    slashCompact.textContent = 'compact';
    const slashCompactDesc = createMockElement('span', harness.mockDoc);
    slashCompactDesc.textContent = 'Compact the conversation now (summarize history to free up the context window).';
    const slashGrill = createMockElement('span', harness.mockDoc);
    slashGrill.textContent = 'grill-me';
    const slashGrillDesc = createMockElement('span', harness.mockDoc);
    slashGrillDesc.textContent = 'Interview me to align on a plan.';
    const slashTeamwork = createMockElement('span', harness.mockDoc);
    slashTeamwork.textContent = 'teamwork';
    const slashTeamworkDesc = createMockElement('span', harness.mockDoc);
    slashTeamworkDesc.textContent = 'Invoke a team of agents to autonomously tackle large projects.';
    const slashLearn = createMockElement('span', harness.mockDoc);
    slashLearn.textContent = 'learn';
    const slashLearnDesc = createMockElement('span', harness.mockDoc);
    slashLearnDesc.textContent = 'Reflect on recent successes or corrections to capture reusable skills or rules.';
    const slashBoost = createMockElement('span', harness.mockDoc);
    slashBoost.textContent = 'boost';
    const slashBoostDesc = createMockElement('span', harness.mockDoc);
    slashBoostDesc.textContent = 'Deep thinking, strategic planning, multiple perspectives, and rigorous verification.';
    for (const el of [
      slashCompact, slashCompactDesc, slashGrill, slashGrillDesc,
      slashTeamwork, slashTeamworkDesc, slashLearn, slashLearnDesc,
      slashBoost, slashBoostDesc
    ]) {
      harness.mockDoc.body.appendChild(el);
    }

    // 6. 侧边栏动态会话标题
    const dynRow = createMockElement('div', harness.mockDoc);
    dynRow.setAttribute('data-testid', 'conversation-row-sidebar');
    dynRow.setAttribute('data-cascade-id', 'conv-dyn-1');
    const dynTitle = createMockElement('span', harness.mockDoc);
    dynTitle.setAttribute('data-testid', 'conversation-title');
    dynTitle.textContent = 'Fix sidebar translation sync';
    dynRow.appendChild(dynTitle);
    harness.mockDoc.body.appendChild(dynRow);

    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    // 验证初始中文翻译
    assert.equal(widthDefault.textContent, '默认');
    assert.equal(contrastDefault.textContent, '默认');
    assert.equal(permDefault.textContent, '默认');
    assert.equal(permReadOnly.textContent, '只读');
    assert.equal(permExecPolicy.textContent, '执行策略');
    assert.equal(permAgentDecides.textContent, '由智能体决定');
    assert.equal(modelText.textContent, 'Gemini 4 Neon (高)');
    assert.equal(changeBtn.textContent, '更改');
    assert.equal(storageOpt.textContent, '本地存储');
    assert.equal(sidebarSearch.getAttribute('placeholder'), '搜索...');
    assert.equal(sideQuestion.textContent, '旁路提问');

    assert.equal(reqBadge.textContent, '必填');
    assert.equal(reqStar.textContent, '* 必填');
    assert.equal(schedSub.textContent, '使用您的本地文件与工具。仅限定时任务。');
    assert.equal(trigTitle.textContent, '触发器');
    assert.equal(atNode.textContent, '于');
    assert.equal(instrTitle.textContent, '指令');
    assert.equal(
      instrArea.getAttribute('placeholder'),
      'Agent 每次运行时应执行什么操作？例如：汇总分配给我的新 Bug 以及夜间发生的所有变更。'
    );

    assert.equal(slashPlanName.textContent, '规划');
    assert.equal(slashPlanCap.textContent, '规划');
    assert.equal(slashPlanDesc.textContent, '在执行任务前仔细制定规划。');
    assert.equal(slashCompact.textContent, '压缩上下文');
    assert.equal(slashCompactDesc.textContent, '立即压缩当前会话（总结历史内容以释放上下文窗口）。');
    assert.equal(slashGrill.textContent, '深度访谈');
    assert.equal(slashGrillDesc.textContent, '通过交互式访谈与我对齐执行方案。');
    assert.equal(slashTeamwork.textContent, '团队协作');
    assert.equal(slashTeamworkDesc.textContent, '调用多个智能体协同团队，自主攻克大型项目。');
    assert.equal(slashLearn.textContent, '沉淀经验');
    assert.equal(slashLearnDesc.textContent, '复盘近期的成功经验或纠偏过程，沉淀为可复用的技能或规则。');
    assert.equal(slashBoost.textContent, '深度增强');
    assert.equal(slashBoostDesc.textContent, '深度思考、战略规划、多视角推演与严格验证。');

    // 验证 englishLabels=true：模型与权限保留英文，但对话宽度/对比度的 Default 仍保持中文「默认」
    await harness.updatePluginSettings('agy-daddy.zh-cn', { englishLabels: true });
    assert.equal(modelText.textContent, 'Gemini 4 Neon (High)');
    assert.equal(permDefault.textContent, 'Default');
    assert.equal(permReadOnly.textContent, 'Read Only');
    assert.equal(permAgentDecides.textContent, 'Agent Decides');
    assert.equal(widthDefault.textContent, '默认');
    assert.equal(contrastDefault.textContent, '默认');

    await harness.updatePluginSettings('agy-daddy.zh-cn', { englishLabels: false });
    assert.equal(modelText.textContent, 'Gemini 4 Neon (高)');
    assert.equal(permDefault.textContent, '默认');

    // 验证 brandTitle 三档在 textNode 与 leafEl 均实时生效
    await harness.updatePluginSettings('agy-daddy.zh-cn', { brandTitle: 'translated' });
    assert.equal(brandTextNode.nodeValue, '反重力');
    assert.equal(brandLeaf.textContent, '反重力');

    await harness.updatePluginSettings('agy-daddy.zh-cn', { brandTitle: 'hidden' });
    assert.equal(brandTextNode.nodeValue, '');
    assert.equal(brandLeaf.style.getPropertyValue('display'), 'none');

    await harness.updatePluginSettings('agy-daddy.zh-cn', { brandTitle: 'english' });
    assert.equal(brandTextNode.nodeValue, 'Antigravity');
    assert.equal(brandLeaf.style.getPropertyValue('display'), '');
    assert.equal(brandLeaf.textContent, 'Antigravity');

    // 验证远程会话标题翻译与开关切换即时还原/恢复
    assert.equal(fetchCalls.length, 0);
    await harness.updatePluginSettings('agy-daddy.zh-cn', { enableRemoteThinkingTranslation: true });
    assert.ok(await waitUntil(() => dynTitle.textContent === '[译] Fix sidebar translation sync'));
    assert.equal(fetchCalls.length, 1);

    await harness.updatePluginSettings('agy-daddy.zh-cn', { translateConversationTitles: false });
    assert.equal(dynTitle.textContent, 'Fix sidebar translation sync');

    await harness.updatePluginSettings('agy-daddy.zh-cn', { translateConversationTitles: true });
    assert.equal(dynTitle.textContent, '[译] Fix sidebar translation sync');
    assert.equal(fetchCalls.length, 1);

    await harness.unloadPlugin('agy-daddy.zh-cn');
    assert.equal(dynTitle.textContent, 'Fix sidebar translation sync');
    harness.assertCleanDispose('agy-daddy.zh-cn');
  } finally {
    await harness.cleanup();
  }
});
