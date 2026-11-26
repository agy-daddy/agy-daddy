'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOST_ROOT = process.env.AGY_DADDY_HOST_DIR
  ? path.resolve(process.env.AGY_DADDY_HOST_DIR)
  : path.resolve(PLUGIN_ROOT, '..', 'agy-daddy-host');

const { createMockHostHarness, createMockElement, createMockDocument } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const { readFileSafe, writeFileSafe, writeBinaryFileSafe, resolveSafeEditablePath } = require('../src/file-service');
const { matchMessages, exportConversationMarkdown, exportConversationHtml } = require('../src/node');
const {
  buildExportFilename,
  normalizeDomMessagesToSteps,
  pickLatestCascadeId,
  normalizeExportFormats,
  ensureFileExtension,
  buildMinimalPdfBuffer,
  renderHtmlToPdfBuffer,
  openSaveFileDialog,
  openDirectoryDialog
} = require('../src/conversation-export');
const { isSafeExternalUrl, mount: mountChatNav, dispose: disposeChatNav } = require('../src/renderer');
const {
  countCodeLines,
  extractCodeLanguage,
  isCodeBlockCompleted,
  computeCollapseScrollCompensation
} = require('../src/code-block-enhancer');
const {
  isEditableElement,
  isKeyQuestionText,
  extractOutlineItems,
  filterOutlineItems
} = require('../src/outline-rail');

test('file-service 安全原子读写与系统黑名单/凭据目录/大小/外链协议守卫', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cnav-file-'));
  try {
    const fPath = path.join(tmp, 'note.md');
    const w = writeFileSafe(`file://${fPath}`, '# 标题\n正文');
    assert.equal(w.ok, true);

    const r = readFileSafe(fPath);
    assert.equal(r.ok, true);
    assert.match(r.content, /# 标题/);

    assert.equal(readFileSafe('relative/bad.txt').ok, false);
    assert.equal(writeFileSafe('/tmp/x\0y', 'a').ok, false);
    assert.equal(writeFileSafe(fPath, 'a'.repeat(100), { maxBytes: 50 }).ok, false);

    // 系统关键目录与凭据目录全拦截
    for (const blocked of [
      '/etc/hosts',
      '/System/Library/CoreServices/SystemVersion.plist',
      '/usr/bin/env',
      '/Applications/Antigravity.app/Contents/Info.plist',
      '/Users/tester/.ssh/id_ed25519',
      '/Users/tester/.gnupg/secring.gpg',
      '/Users/tester/.aws/credentials',
      '/Users/tester/Library/Application Support/1Password/vault.db'
    ]) {
      assert.equal(resolveSafeEditablePath(blocked), null, `should block ${blocked}`);
      assert.equal(readFileSafe(blocked).ok, false);
      assert.equal(writeFileSafe(blocked, 'evil').ok, false);
    }

    assert.equal(isSafeExternalUrl('https://github.com/agy-daddy'), true);
    assert.equal(isSafeExternalUrl('http://localhost:8080'), true);
    assert.equal(isSafeExternalUrl('mailto:dev@example.com'), true);
    assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
    assert.equal(isSafeExternalUrl('file:///etc/passwd'), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('微内核契约 v2：isolated 世界、主题门禁、样式自注入、ctx.surfaces 插槽、托管设置与命令、快捷键/行内编辑与零残留 dispose', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'agy-plugin.json'), 'utf8'));
  assert.equal(manifest.world, 'isolated');
  assert.equal((manifest.permissions || []).includes('page:main-world'), false);
  assert.equal(manifest.contributes?.migrations, undefined);

  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
    assert.equal(src.includes('registerSection'), false, `${file} must not use deprecated registerSection`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cnav-ed-'));
  const editFilePath = path.join(tmpDir, 'plan.md');
  fs.writeFileSync(editFilePath, '# 原内容', 'utf8');

  const thinkingEvents = [];
  const rowClicks = [];
  const harness = createMockHostHarness({
    seedAnchors: [
      { tag: 'div', attr: 'data-testid', val: 'autoscroll-viewport' },
      { tag: 'div', attr: 'data-testid', val: 'turn-cards-container' },
      { tag: 'button', attr: 'data-testid', val: 'thinking-collapsible-trigger' },
      { tag: 'div', attr: 'aria-label', val: '文件查看器标题栏' }
    ]
  });

  // 添加 3 个侧栏会话行测试 ⌘1~⌘9 与角标
  const rows = [0, 1, 2].map((idx) => {
    const row = createMockElement('div', harness.mockDoc);
    row.setAttribute('data-testid', 'conversation-row-sidebar');
    row.setAttribute('aria-selected', idx === 0 ? 'true' : 'false');
    row.addEventListener('click', () => rowClicks.push(idx));
    harness.mockDoc.body.appendChild(row);
    return row;
  });

  // 设置文件路径给文件查看器标题栏
  const headerEl = harness.mockDoc.querySelector('[aria-label="文件查看器标题栏"]');
  headerEl.setAttribute('data-file-path', editFilePath);

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    await harness.rendererHost.mountPlugin('test.zh.mock', {
      mount(ctx) { ctx.events.on('chat:thinking-expanded@1', (p) => thinkingEvents.push(p)); }
    });

    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.equal(loaded.trust.world, 'isolated');
    assert.ok(harness.isolatedWorlds.has('agy-daddy.chat-nav'));

    // 验证样式已自注入 document head
    const injectedStyle = harness.mockDoc.head.querySelector('[data-agy-style="agy-daddy.chat-nav"]');
    assert.ok(injectedStyle);
    assert.match(injectedStyle.textContent, /#agy-chat-nav-float/);
    assert.match(injectedStyle.textContent, /#agy-inline-file-editor-panel/);

    const dock = harness.mockDoc.getElementById('agy-chat-nav-float');
    assert.ok(dock);
    for (const btnId of ['agy-nav-top', 'agy-nav-prev', 'agy-nav-next', 'agy-nav-bottom', 'agy-nav-think', 'agy-nav-copy-id', 'agy-nav-export-md', 'agy-nav-search-toggle']) {
      const btn = harness.mockDoc.getElementById(btnId);
      assert.ok(btn, `missing ${btnId}`);
      assert.match(btn.innerHTML, /<svg\b/i, `${btnId} should render SVG icon`);
      assert.equal(btn.textContent.trim(), '', `${btnId} should not render plain text`);
      assert.ok(btn.getAttribute('title'), `${btnId} should have title`);
      assert.ok(btn.getAttribute('aria-label'), `${btnId} should have aria-label`);
    }
    const editBtn = harness.mockDoc.getElementById('agy-file-editor-controls');
    assert.ok(editBtn);

    // 验证私有 /settings 路由已移除
    const legacySettingsResp = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.chat-nav/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AGY-Plugin-Token': loaded.pluginToken },
      body: '{}'
    });
    assert.equal(legacySettingsResp.status, 404);

    // 验证命令已注册
    const topRes = await harness.executeCommand('chat-nav.scroll-top');
    assert.equal(topRes.ok, true);
    const bottomRes = await harness.executeCommand('chat-nav.scroll-bottom');
    assert.equal(bottomRes.ok, true);
    const expandCmdRes = await harness.executeCommand('chat-nav.expand-thinking');
    assert.equal(expandCmdRes.ok, true);

    // 验证 ctx.surfaces 提供 chat.navButtons，且悬浮条内置全文检索框（零跨插件依赖）
    const surfaceMounted = [];
    let chatNavApi = null;
    await harness.rendererHost.mountPlugin('test.ext.consumer', {
      mount(ctx) {
        chatNavApi = ctx.services.get('chat-nav');
        ctx.surfaces.mount('chat.navButtons', (slotEl) => {
          const btn = createMockElement('button', harness.mockDoc);
          btn.id = 'test-navbtn-surface-child';
          slotEl.appendChild(btn);
          surfaceMounted.push('chat.navButtons');
          return () => btn.remove();
        });
      }
    });
    assert.ok(chatNavApi);
    assert.deepEqual(surfaceMounted, ['chat.navButtons']);
    assert.ok(harness.mockDoc.getElementById('agy-chat-search-slot').querySelector('#agy-chat-search-box'));
    assert.ok(harness.mockDoc.getElementById('agy-chat-nav-extra').querySelector('#test-navbtn-surface-child'));

    // 验证托管设置热更新：隐藏悬浮导航条撤销插槽，重新开启自动恢复插槽与内置检索框挂载
    await harness.updatePluginSettings('agy-daddy.chat-nav', { showFloatDock: false });
    assert.equal(harness.mockDoc.getElementById('agy-chat-nav-float'), null);
    assert.equal(harness.mockDoc.getElementById('agy-chat-search-box'), null);
    await harness.updatePluginSettings('agy-daddy.chat-nav', { showFloatDock: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(harness.mockDoc.getElementById('agy-chat-nav-float'));
    assert.ok(harness.mockDoc.getElementById('agy-chat-search-slot').querySelector('#agy-chat-search-box'));
    assert.ok(harness.mockDoc.getElementById('agy-chat-nav-extra').querySelector('#test-navbtn-surface-child'));

    // 验证按住 ⌘ 展示序号角标并在松开后消失
    harness.mockDoc.dispatchEvent({ type: 'keydown', key: 'Meta', metaKey: true, shiftKey: false, ctrlKey: false, altKey: false });
    assert.equal(rows[0].children.some((c) => c.getAttribute('data-agy-conv-badge') === '1'), true);
    assert.equal(rows[2].children.some((c) => c.getAttribute('data-agy-conv-badge') === '3'), true);
    harness.mockDoc.dispatchEvent({ type: 'keyup', key: 'Meta', metaKey: false });
    assert.equal(rows[0].children.some((c) => c.getAttribute('data-agy-conv-badge') === '1'), false);

    // ⌘2 切换到第二个会话；⌘⇧3 截图热键必须跳过不被劫持
    let screenshotPrevented = false;
    harness.mockDoc.dispatchEvent({
      type: 'keydown',
      key: '3',
      code: 'Digit3',
      metaKey: true,
      shiftKey: true,
      ctrlKey: false,
      altKey: false,
      preventDefault() { screenshotPrevented = true; }
    });
    assert.equal(screenshotPrevented, false);

    harness.mockDoc.dispatchEvent({ type: 'keydown', key: '2', code: 'Digit2', metaKey: true, shiftKey: false, ctrlKey: false, altKey: false });
    assert.deepEqual(rowClicks, [1]);
    assert.equal(rows[1].getAttribute('aria-selected'), 'true');

    // ⌃Tab 循环到第三个会话；⌘⇧[ 返回第二个
    harness.mockDoc.dispatchEvent({ type: 'keydown', key: 'Tab', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false });
    assert.deepEqual(rowClicks, [1, 2]);
    harness.mockDoc.dispatchEvent({ type: 'keydown', key: '[', code: 'BracketLeft', metaKey: true, shiftKey: true, ctrlKey: false, altKey: false });
    assert.deepEqual(rowClicks, [1, 2, 1]);

    // 行内文件编辑 ✏️ -> 修改 -> ⌘S 保存 -> ↩️ 完成
    editBtn.click();
    await new Promise((r) => setTimeout(r, 25));
    const ta = harness.mockDoc.getElementById('agy-inline-file-textarea');
    assert.ok(ta);
    assert.equal(ta.value, '# 原内容');
    ta.value = '# 新修订内容';
    harness.mockDoc.dispatchEvent({ type: 'keydown', key: 's', metaKey: true, shiftKey: false, ctrlKey: false, altKey: false });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fs.readFileSync(editFilePath, 'utf8'), '# 新修订内容');
    harness.mockDoc.getElementById('agy-inline-file-done').click();
    assert.equal(harness.mockDoc.getElementById('agy-inline-file-editor-panel'), null);

    // 验证隔离世界跨世界服务调用（expandThinking + 广播事件）
    const expanded = await chatNavApi.expandThinking();
    assert.equal(expanded, 1);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(thinkingEvents.length, 1);

    await harness.rendererHost.disposePlugin('test.zh.mock');
    await harness.rendererHost.disposePlugin('test.ext.consumer');
    await harness.unloadPlugin('agy-daddy.chat-nav');
    assert.equal(harness.mockDoc.getElementById('agy-chat-nav-float'), null);
    assert.equal(harness.mockDoc.getElementById('agy-file-editor-controls'), null);
    assert.equal(harness.mockDoc.head.querySelector('[data-agy-style="agy-daddy.chat-nav"]'), null);
    harness.assertCleanDispose('agy-daddy.chat-nav');
  } finally {
    await harness.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('上轮/下轮在 turn-cards-container 为空时基于 autoscroll-viewport 内轮次坐标精准跳转', async () => {
  const doc = createMockDocument([]);
  const vp = createMockElement('div', doc);
  vp.setAttribute('data-testid', 'autoscroll-viewport');
  vp.scrollTop = 0;
  vp.scrollHeight = 2000;
  vp.clientHeight = 500;
  vp.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 800, width: 800, height: 500 });
  doc.body.appendChild(vp);

  const emptyTcc = createMockElement('div', doc);
  emptyTcc.setAttribute('data-testid', 'turn-cards-container');
  vp.appendChild(emptyTcc);

  const turnPositions = [100, 600, 1200];
  for (const pos of turnPositions) {
    const turn = createMockElement('div', doc);
    turn.setAttribute('data-testid', 'user-message');
    turn.getBoundingClientRect = () => ({ top: pos - vp.scrollTop, bottom: pos - vp.scrollTop + 60, left: 40, right: 760, width: 720, height: 60 });
    vp.appendChild(turn);
  }

  const ctx = {
    anchors: {
      query: (n) => (n === 'chat.scrollViewport' ? vp : (n === 'chat.messageList' ? emptyTcc : null)),
      queryAll: () => [],
      observe: () => () => {}
    },
    events: { emit: () => {}, on: () => () => {} },
    services: { provide: () => () => {} },
    surfaces: { provide: () => () => {} },
    styles: { inject: () => () => {} },
    settings: { get: () => ({ showFloatDock: true }), onChange: () => () => {} },
    bridge: { post: async () => ({ ok: true }) }
  };

  try {
    await mountChatNav(ctx, { document: doc, window: { innerWidth: 1200, innerHeight: 800 } });
    const nextBtn = doc.getElementById('agy-nav-next');
    const prevBtn = doc.getElementById('agy-nav-prev');

    nextBtn.click();
    assert.equal(vp.scrollTop, 88);
    nextBtn.click();
    assert.equal(vp.scrollTop, 588);
    nextBtn.click();
    assert.equal(vp.scrollTop, 1188);

    prevBtn.click();
    assert.equal(vp.scrollTop, 588);
    prevBtn.click();
    assert.equal(vp.scrollTop, 88);
  } finally {
    disposeChatNav();
  }
});

test('思按钮支持展开与收起双向切换，兼容 worked-for-collapsible 且不伪造 aria-expanded', async () => {
  const doc = createMockDocument([]);
  const vp = createMockElement('div', doc);
  vp.setAttribute('data-testid', 'autoscroll-viewport');
  doc.body.appendChild(vp);

  const workedTrigger = createMockElement('button', doc);
  workedTrigger.setAttribute('data-testid', 'worked-for-collapsible');
  workedTrigger.setAttribute('aria-expanded', 'false');
  let workedClicks = 0;
  workedTrigger.addEventListener('click', () => {
    workedClicks++;
    const cur = workedTrigger.getAttribute('aria-expanded') === 'true';
    workedTrigger.setAttribute('aria-expanded', cur ? 'false' : 'true');
  });
  vp.appendChild(workedTrigger);

  const stateTrigger = createMockElement('button', doc);
  stateTrigger.setAttribute('data-testid', 'thinking-collapsible-trigger');
  stateTrigger.setAttribute('data-state', 'closed');
  let stateClicks = 0;
  stateTrigger.addEventListener('click', () => {
    stateClicks++;
    const cur = stateTrigger.getAttribute('data-state') === 'open';
    stateTrigger.setAttribute('data-state', cur ? 'closed' : 'open');
  });
  vp.appendChild(stateTrigger);

  const emitted = [];
  const ctx = {
    anchors: {
      query: (n) => (n === 'chat.scrollViewport' ? vp : null),
      queryAll: (n) => (n === 'chat.thinkingTrigger' ? [stateTrigger] : []),
      observe: () => () => {}
    },
    events: { emit: (topic, payload) => emitted.push({ topic, payload }), on: () => () => {} },
    services: { provide: () => () => {} },
    surfaces: { provide: () => () => {} },
    styles: { inject: () => () => {} },
    settings: { get: () => ({ showFloatDock: true }), onChange: () => () => {} },
    bridge: { post: async () => ({ ok: true }) }
  };

  try {
    await mountChatNav(ctx, { document: doc, window: { innerWidth: 1200, innerHeight: 800 } });
    const thinkBtn = doc.getElementById('agy-nav-think');

    // 第一次点击：展开全部思考块，且不向 stateTrigger 伪造写入 aria-expanded
    thinkBtn.click();
    assert.equal(workedTrigger.getAttribute('aria-expanded'), 'true');
    assert.equal(stateTrigger.getAttribute('data-state'), 'open');
    assert.equal(stateTrigger.getAttribute('aria-expanded'), null);
    assert.equal(thinkBtn.getAttribute('data-active'), 'true');
    assert.equal(emitted.at(-1).topic, 'chat:thinking-expanded@1');

    // 第二次点击：全部已展开，转为收起
    thinkBtn.click();
    assert.equal(workedTrigger.getAttribute('aria-expanded'), 'false');
    assert.equal(stateTrigger.getAttribute('data-state'), 'closed');
    assert.equal(thinkBtn.getAttribute('data-active'), 'false');
    assert.equal(emitted.at(-1).topic, 'chat:thinking-collapsed@1');

    // 第三次点击：再次展开
    thinkBtn.click();
    assert.equal(workedTrigger.getAttribute('aria-expanded'), 'true');
    assert.equal(stateTrigger.getAttribute('data-state'), 'open');
    assert.equal(workedClicks, 3);
    assert.equal(stateClicks, 3);
  } finally {
    disposeChatNav();
  }
});

test('悬浮栏位置动态紧贴对话区右边框，且响应 chat:search-close@1 关闭搜索框', async () => {
  const doc = createMockDocument([]);
  const vp = createMockElement('div', doc);
  vp.setAttribute('data-testid', 'autoscroll-viewport');
  let vpRight = 760;
  vp.getBoundingClientRect = () => ({ top: 40, bottom: 840, left: 260, right: vpRight, width: vpRight - 260, height: 800 });
  doc.body.appendChild(vp);

  const listeners = new Map();
  let providedSvc = null;
  const ctx = {
    anchors: {
      query: (n) => (n === 'chat.scrollViewport' ? vp : null),
      queryAll: () => [],
      observe: () => () => {}
    },
    events: {
      emit: () => {},
      on: (topic, fn) => {
        if (!listeners.has(topic)) listeners.set(topic, new Set());
        listeners.get(topic).add(fn);
        return () => listeners.get(topic)?.delete(fn);
      }
    },
    services: { provide: (_name, svc) => { providedSvc = svc; return () => {}; } },
    surfaces: { provide: () => () => {} },
    styles: { inject: () => () => {} },
    settings: { get: () => ({ showFloatDock: true }), onChange: () => () => {} },
    bridge: { post: async () => ({ ok: true }) }
  };

  try {
    await mountChatNav(ctx, { document: doc, window: { innerWidth: 1400, innerHeight: 900 } });
    const dock = doc.getElementById('agy-chat-nav-float');
    assert.equal(dock.style.right, '646px');
    assert.equal(dock.style.top, '440px');
    assert.equal(dock.style.getPropertyValue('--agy-chat-area-width'), '500px');

    // 右侧分栏关闭，对话区右边界扩展到 1392
    vpRight = 1392;
    providedSvc.syncDockPosition();
    assert.equal(dock.style.right, '14px');
    assert.equal(dock.style.getPropertyValue('--agy-chat-area-width'), '1132px');

    // 搜索按钮打开后，收到 chat:search-close@1 立即收起
    const toggleBtn = doc.getElementById('agy-nav-search-toggle');
    const slot = doc.getElementById('agy-chat-search-slot');
    toggleBtn.click();
    assert.equal(slot.className, 'agy-search-open');
    assert.equal(toggleBtn.getAttribute('data-active'), 'true');

    for (const fn of listeners.get('chat:search-close@1') || []) {
      fn({ reason: 'close-button' });
    }
    assert.equal(slot.className, 'agy-search-collapsed');
    assert.equal(toggleBtn.getAttribute('data-active'), 'false');
  } finally {
    disposeChatNav();
  }
});

test('matchMessages 关键字与正则全文检索逻辑及非法正则兜底', () => {
  const msgs = ['Check auth middleware', 'Fix database pool leak', 'AUTH retry token'];
  const plain = matchMessages(msgs, 'auth');
  assert.equal(plain.ok, true);
  assert.equal(plain.total, 2);

  const rx = matchMessages(msgs, 'auth.*(middleware|retry)', { regexMode: true });
  assert.equal(rx.ok, true);
  assert.equal(rx.total, 2);

  const sensitive = matchMessages(msgs, 'AUTH', { caseSensitive: true });
  assert.equal(sensitive.ok, true);
  assert.equal(sensitive.total, 1);

  const badRx = matchMessages(msgs, '[unclosed', { regexMode: true });
  assert.equal(badRx.ok, false);
});

test('内置对话全文检索：Node 命令、实时搜索跳转、托管设置热更新、关闭与卸载零残留', async () => {
  const harness = createMockHostHarness({
    seedAnchors: [
      { tag: 'div', attr: 'data-testid', val: 'autoscroll-viewport' },
      { tag: 'div', attr: 'data-testid', val: 'turn-cards-container' },
      { tag: 'button', attr: 'data-testid', val: 'thinking-collapsible-trigger' }
    ]
  });

  const vp = harness.mockDoc.querySelector('[data-testid="autoscroll-viewport"]');
  const emptyTcc = harness.mockDoc.querySelector('[data-testid="turn-cards-container"]');
  const streamWrap = createMockElement('div', harness.mockDoc);
  vp.appendChild(streamWrap);

  const u1 = createMockElement('div', harness.mockDoc);
  u1.setAttribute('data-testid', 'user-message');
  u1.textContent = 'First turn: setup database';
  const r1 = createMockElement('div', harness.mockDoc);
  r1.setAttribute('data-testid', 'agent-response');
  r1.textContent = 'Second turn: verify proxy gateway';
  const r2 = createMockElement('div', harness.mockDoc);
  r2.setAttribute('data-testid', 'agent-response');
  r2.textContent = 'Third turn: finalize DATABASE index';
  streamWrap.appendChild(u1);
  streamWrap.appendChild(r1);
  streamWrap.appendChild(r2);

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });

    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    assert.equal(emptyTcc.children.length, 0);

    // 验证 Node 侧 chat-nav.search 命令
    const cmdRes = await harness.executeCommand('chat-nav.search', ['gateway', ['alpha', 'proxy gateway']]);
    assert.equal(cmdRes.total, 1);

    const toggleBtn = harness.mockDoc.getElementById('agy-nav-search-toggle');
    const searchSlot = harness.mockDoc.getElementById('agy-chat-search-slot');
    const input = harness.mockDoc.getElementById('agy-chat-search-input');
    const countEl = harness.mockDoc.getElementById('agy-chat-search-count');
    const nextBtn = harness.mockDoc.getElementById('agy-chat-search-next');
    const clearBtn = harness.mockDoc.getElementById('agy-chat-search-clear');

    // 打开搜索框 -> 输入 "database" 命中 2 条（u1, r2）
    toggleBtn.click();
    assert.equal(searchSlot.className, 'agy-search-open');
    assert.equal(toggleBtn.getAttribute('data-active'), 'true');

    input.value = 'database';
    input.dispatchEvent({ type: 'input', target: input });
    assert.equal(countEl.textContent, '1/2');
    assert.equal(u1.getAttribute('data-agy-search-hit'), 'active');

    // 下一条按钮与 Enter / Shift+Enter 循环跳转
    nextBtn.click();
    assert.equal(countEl.textContent, '2/2');
    assert.equal(r2.getAttribute('data-agy-search-hit'), 'active');

    input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: true });
    assert.equal(countEl.textContent, '1/2');
    assert.equal(u1.getAttribute('data-agy-search-hit'), 'active');

    input.dispatchEvent({ type: 'keydown', key: 'Enter', shiftKey: false });
    assert.equal(countEl.textContent, '2/2');
    assert.equal(r2.getAttribute('data-agy-search-hit'), 'active');

    // 验证托管设置热更新：searchCaseSensitive / searchRegexMode
    await harness.updatePluginSettings('agy-daddy.chat-nav', { searchCaseSensitive: true });
    assert.equal(countEl.textContent, '1/1');
    assert.equal(u1.getAttribute('data-agy-search-hit'), 'active');

    await harness.updatePluginSettings('agy-daddy.chat-nav', { searchCaseSensitive: false, searchRegexMode: true });
    input.value = 'setup.*database|finalize';
    input.dispatchEvent({ type: 'change', target: input });
    assert.equal(countEl.textContent, '1/2');

    // 点击关闭按钮 × -> 清空检索并收起搜索框
    clearBtn.click();
    assert.equal(input.value, '');
    assert.equal(countEl.textContent, '0/0');
    assert.equal(u1.getAttribute('data-agy-search-hit'), null);
    assert.equal(r2.getAttribute('data-agy-search-hit'), null);
    assert.equal(searchSlot.className, 'agy-search-collapsed');
    assert.equal(toggleBtn.getAttribute('data-active'), 'false');

    // 再次打开并用 Escape 清空关闭
    toggleBtn.click();
    assert.equal(searchSlot.className, 'agy-search-open');
    input.value = 'gateway';
    input.dispatchEvent({ type: 'input', target: input });
    assert.equal(countEl.textContent, '1/1');
    assert.equal(r1.getAttribute('data-agy-search-hit'), 'active');

    input.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(countEl.textContent, '0/0');
    assert.equal(r1.getAttribute('data-agy-search-hit'), null);
    assert.equal(searchSlot.className, 'agy-search-collapsed');
    assert.equal(toggleBtn.getAttribute('data-active'), 'false');

    // 搜索命中状态下隐藏悬浮条（showFloatDock: false）也必须清理高亮
    toggleBtn.click();
    input.value = 'gateway';
    input.dispatchEvent({ type: 'input', target: input });
    assert.equal(r1.getAttribute('data-agy-search-hit'), 'active');
    await harness.updatePluginSettings('agy-daddy.chat-nav', { showFloatDock: false });
    assert.equal(r1.getAttribute('data-agy-search-hit'), null);

    // 卸载清理校验
    await harness.unloadPlugin('agy-daddy.chat-nav');
    assert.equal(r1.getAttribute('data-agy-search-hit'), null);
    harness.assertCleanDispose('agy-daddy.chat-nav');
  } finally {
    await harness.cleanup();
  }
});

test('conversation-export 纯函数：Markdown/HTML/PDF 渲染、格式归一化、二进制安全写入与文件名生成', async () => {
  const md = exportConversationMarkdown([
    { userInput: { userResponse: '你好' } },
    { plannerResponse: { thinking: '内部推理', response: '已完成' } }
  ], { cascadeId: 'cid-9', model: 'gemini-4', title: '测试归档' });
  assert.match(md, /^# 测试归档/);
  assert.match(md, /Session ID: `cid-9`/);
  assert.match(md, /Model: `gemini-4`/);
  assert.match(md, /<summary>Thinking<\/summary>/);
  assert.match(md, /已完成/);

  const html = exportConversationHtml([
    { userInput: { userResponse: '<script>alert(1)</script>\n\n```js\nconst a = 1;\n```' } },
    { plannerResponse: { thinking: '内部思考', response: '完成 [链接](https://example.com) 与 [坏链](javascript:alert(1))' } }
  ], { cascadeId: 'cid-9', model: 'gemini-4', title: 'HTML <测试>' });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('javascript:alert(1)'), false);
  assert.match(html, /https:\/\/example\.com/);
  assert.match(html, /<pre><code data-lang="js">/);
  assert.match(html, /<details class="thinking-box"><summary>Thinking<\/summary>/);
  assert.equal(html.includes('<details class="thinking-box" open>'), false);

  const expandedHtml = exportConversationHtml([
    { plannerResponse: { thinking: '需要展开的思考', response: '结论' } }
  ], { cascadeId: 'cid-9', expandThinking: true });
  assert.match(expandedHtml, /<details class="thinking-box" open><summary>Thinking<\/summary>/);

  const pdfBuf = await renderHtmlToPdfBuffer(html, { plainText: md, meta: { title: 'Test PDF' } });
  assert.equal(Buffer.isBuffer(pdfBuf), true);
  assert.equal(pdfBuf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.match(pdfBuf.toString('ascii'), /%%EOF/);

  const minPdf = buildMinimalPdfBuffer('Line 1\nLine 2 (test)', { title: 'Min' });
  assert.equal(minPdf.subarray(0, 8).toString('ascii'), '%PDF-1.4');

  const tmpBin = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cnav-bin-'));
  try {
    const pdfPath = path.join(tmpBin, 'out.pdf');
    const wb = writeBinaryFileSafe(pdfPath, pdfBuf);
    assert.equal(wb.ok, true);
    assert.equal(Buffer.compare(fs.readFileSync(pdfPath), pdfBuf), 0);
    assert.equal(writeBinaryFileSafe('/etc/evil.pdf', pdfBuf).ok, false);
  } finally {
    fs.rmSync(tmpBin, { recursive: true, force: true });
  }

  assert.deepEqual(normalizeExportFormats(['pdf', 'md', 'pdf', 'bad', 'html']), ['pdf', 'md', 'html']);
  assert.deepEqual(normalizeExportFormats([]), ['md']);
  assert.equal(ensureFileExtension('/tmp/chat', 'pdf'), '/tmp/chat.pdf');
  assert.equal(ensureFileExtension('/tmp/chat.html', 'html'), '/tmp/chat.html');

  const fname = buildExportFilename({
    title: 'Fix: auth/token?*',
    cascadeId: '12345678-abcd-efgh',
    format: 'pdf',
    date: new Date(2026, 10, 23, 22, 30, 5)
  });
  assert.equal(fname, 'antigravity-Fix-auth-token-20261123-223005.pdf');

  const steps = normalizeDomMessagesToSteps([
    { role: 'user', text: '用户提问' },
    { role: 'assistant', text: '助手回答' }
  ]);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].userInput.userResponse, '用户提问');
  assert.equal(steps[1].plannerResponse.response, '助手回答');

  const latest = pickLatestCascadeId({
    'old-id': { lastModifiedTime: '2026-11-20T10:00:00Z' },
    'new-id': { lastModifiedTime: '2026-11-23T10:00:00Z' }
  });
  assert.equal(latest, 'new-id');

  const dlgErr = await openSaveFileDialog({
    saveDialogFn: async () => ({ ok: false, error: 'DIALOG_ERR' })
  });
  assert.equal(dlgErr.ok, false);
  assert.equal(dlgErr.cancelled, false);
  assert.equal(dlgErr.error, 'DIALOG_ERR');

  const dirErr = await openDirectoryDialog({
    dirPickerFn: async () => ({ ok: false, error: 'DIR_ERR' })
  });
  assert.equal(dirErr.ok, false);
  assert.equal(dirErr.cancelled, false);
  assert.equal(dirErr.error, 'DIR_ERR');
});

test('复制会话 ID 与多格式对话导出（保存对话框默认行为、默认路径直存、单选直出/多选先选格式、目录浏览与零残留）', async () => {
  async function waitUntil(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error('waitUntil timed out');
  }
  const tmpExportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cnav-export-'));
  const tmpCustomDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cnav-custom-'));
  const prevExportDir = process.env.AGY_DADDY_EXPORT_DIR;
  const prevDlgRes = process.env.AGY_DADDY_TEST_SAVE_DIALOG_RESULT;
  const prevDirDlgRes = process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT;
  process.env.AGY_DADDY_EXPORT_DIR = tmpExportDir;

  const sessionUuid = '11111111-2222-3333-4444-555555555555';
  const fallbackUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let useRpcTrajectory = true;

  const harness = createMockHostHarness({
    pageUrl: `https://127.0.0.1:51410/cascade/${sessionUuid}`,
    seedAnchors: [
      { tag: 'div', attr: 'data-testid', val: 'autoscroll-viewport' },
      { tag: 'div', attr: 'data-testid', val: 'turn-cards-container' },
      { tag: 'button', attr: 'data-testid', val: 'thinking-collapsible-trigger' }
    ],
    onRpc(method, body) {
      if (method === 'GetAllCascadeTrajectories') {
        return {
          trajectorySummaries: {
            [fallbackUuid]: { lastModifiedTime: '2026-11-23T22:00:00Z', summary: 'RPC 回退会话' }
          }
        };
      }
      if (method === 'GetCascadeTrajectory') {
        if (!useRpcTrajectory) return { steps: [] };
        return {
          steps: [
            { userInput: { userResponse: `请排查 ${body.cascadeId}` } },
            { plannerResponse: { thinking: '分析日志', response: '已定位并修复' } }
          ]
        };
      }
      return { ok: true };
    }
  });

  const vp = harness.mockDoc.querySelector('[data-testid="autoscroll-viewport"]');
  const uEl = createMockElement('div', harness.mockDoc);
  uEl.setAttribute('data-testid', 'user-message');
  uEl.textContent = 'DOM 兜底问题';
  const aEl = createMockElement('div', harness.mockDoc);
  aEl.setAttribute('data-testid', 'agent-response');
  aEl.textContent = 'DOM 兜底答复';
  vp.appendChild(uEl);
  vp.appendChild(aEl);

  const copiedTexts = [];
  const mockClipboard = {
    clipboard: {
      async writeText(txt) {
        copiedTexts.push(String(txt));
      }
    }
  };

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    const loaded = await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });
    const worldCtx = harness.isolatedWorlds.get('agy-daddy.chat-nav');
    if (worldCtx) worldCtx.navigator = mockClipboard;

    // 1. 命令与服务验证：chat-nav.copy-id / chat-nav.export-md / chat-nav.browseExportDir / chat-nav-node
    const copyCmdRes = await harness.executeCommand('chat-nav.copy-id');
    assert.equal(copyCmdRes.ok, true);
    assert.equal(copyCmdRes.cascadeId, fallbackUuid);

    const expCmdRes = await harness.executeCommand('chat-nav.export-md', [{
      cascadeId: 'cid-cmd',
      steps: [{ userInput: { userResponse: '命令导出内容' } }]
    }]);
    assert.equal(expCmdRes.ok, true);
    assert.match(expCmdRes.markdown, /命令导出内容/);

    process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT = tmpCustomDir;
    const browseRes = await harness.executeCommand('chat-nav.browseExportDir');
    assert.equal(browseRes.ok, true);
    assert.equal(browseRes.cancelled, false);
    assert.equal(browseRes.path, tmpCustomDir);

    const chatNavNode = harness.bus.getServiceProxy('chat-nav-node');
    const sessRes = await chatNavNode.getActiveSessionId();
    assert.equal(sessRes.ok, true);
    assert.equal(sessRes.cascadeId, fallbackUuid);

    // 2. 点击右侧悬浮栏「复制会话 ID」按钮
    const copyBtn = harness.mockDoc.getElementById('agy-nav-copy-id');
    const toastEl = harness.mockDoc.getElementById('agy-chat-nav-toast');
    assert.ok(copyBtn);
    copyBtn.click();
    await waitUntil(() => copiedTexts.length >= 1 && !toastEl.hidden);
    assert.equal(copiedTexts[0], sessionUuid);
    assert.equal(copyBtn.getAttribute('data-active'), 'true');
    assert.equal(toastEl.hidden, false);
    assert.match(toastEl.textContent, /已复制会话 ID/);

    // 3. 默认设置（单选 ['md'] + exportSaveBehavior: 'dialog'）：不弹格式选择菜单，直接触发保存对话框
    const exportBtn = harness.mockDoc.getElementById('agy-nav-export-md');
    const fmtMenu = harness.mockDoc.getElementById('agy-export-format-menu');
    assert.ok(exportBtn);
    assert.ok(fmtMenu);
    assert.equal(fmtMenu.hidden, true);

    // 3a. 对话框取消：提示已取消导出且不写盘
    process.env.AGY_DADDY_TEST_SAVE_DIALOG_RESULT = '__CANCEL__';
    exportBtn.click();
    await waitUntil(() => !exportBtn.disabled && /已取消导出/.test(toastEl.textContent));
    assert.equal(fmtMenu.hidden, true);
    assert.equal(exportBtn.disabled, false);
    assert.match(toastEl.textContent, /已取消导出/);
    assert.equal(fs.readdirSync(tmpExportDir).length, 0);

    // 3b. 对话框选择路径：写入对应 .md 文件并复制到剪贴板
    const dialogMdPath = path.join(tmpExportDir, 'dialog-picked');
    process.env.AGY_DADDY_TEST_SAVE_DIALOG_RESULT = dialogMdPath;
    exportBtn.click();
    await waitUntil(() => !exportBtn.disabled && fs.existsSync(`${dialogMdPath}.md`) && copiedTexts.length >= 2);
    assert.equal(exportBtn.disabled, false);
    assert.equal(fs.existsSync(`${dialogMdPath}.md`), true);
    assert.match(fs.readFileSync(`${dialogMdPath}.md`, 'utf8'), new RegExp(`请排查 ${sessionUuid}`));
    assert.equal(copiedTexts.length, 2);
    assert.match(copiedTexts[1], /已定位并修复/);

    // 4. 修改默认行为为 direct + 自定义默认保存路径：直接写入该目录，不弹对话框
    process.env.AGY_DADDY_TEST_SAVE_DIALOG_RESULT = '__CANCEL__';
    await harness.updatePluginSettings('agy-daddy.chat-nav', {
      exportSaveBehavior: 'direct',
      exportSaveDir: tmpCustomDir
    });
    exportBtn.click();
    await waitUntil(() => !exportBtn.disabled && fs.readdirSync(tmpCustomDir).some((f) => f.endsWith('.md')));
    const directMdFiles = fs.readdirSync(tmpCustomDir).filter((f) => f.endsWith('.md'));
    assert.equal(directMdFiles.length, 1);
    assert.match(fs.readFileSync(path.join(tmpCustomDir, directMdFiles[0]), 'utf8'), /已定位并修复/);

    // 5. 多选格式 ['md', 'html', 'pdf']：点击导出先弹出格式选择浮层，再按默认保存交互执行
    await harness.updatePluginSettings('agy-daddy.chat-nav', {
      exportFormats: ['md', 'html', 'pdf'],
      exportSaveBehavior: 'direct',
      exportSaveDir: tmpCustomDir
    });
    exportBtn.click();
    assert.equal(fmtMenu.hidden, false);
    assert.ok(harness.mockDoc.getElementById('agy-export-fmt-md'));
    assert.ok(harness.mockDoc.getElementById('agy-export-fmt-html'));
    assert.ok(harness.mockDoc.getElementById('agy-export-fmt-pdf'));
    const allFmtBtn = harness.mockDoc.getElementById('agy-export-fmt-all');
    assert.ok(allFmtBtn);
    assert.match(allFmtBtn.textContent, /全部保存/);

    // 5a. 点击 HTML 格式选项 -> 收起菜单并直接保存为 .html
    harness.mockDoc.getElementById('agy-export-fmt-html').click();
    assert.equal(fmtMenu.hidden, true);
    await waitUntil(() => !exportBtn.disabled && fs.readdirSync(tmpCustomDir).some((f) => f.endsWith('.html')));
    const htmlFiles = fs.readdirSync(tmpCustomDir).filter((f) => f.endsWith('.html'));
    assert.equal(htmlFiles.length, 1);
    assert.match(fs.readFileSync(path.join(tmpCustomDir, htmlFiles[0]), 'utf8'), /<!DOCTYPE html>/);

    // 5b. 再次打开菜单并切回 dialog 模式导出 PDF -> 验证合法 %PDF- 文件落盘
    await harness.updatePluginSettings('agy-daddy.chat-nav', {
      exportSaveBehavior: 'dialog'
    });
    const dialogPdfPath = path.join(tmpExportDir, 'picked-pdf');
    process.env.AGY_DADDY_TEST_SAVE_DIALOG_RESULT = dialogPdfPath;
    exportBtn.click();
    assert.equal(fmtMenu.hidden, false);
    harness.mockDoc.getElementById('agy-export-fmt-pdf').click();
    await waitUntil(() => !exportBtn.disabled && fs.existsSync(`${dialogPdfPath}.pdf`));
    assert.equal(fs.existsSync(`${dialogPdfPath}.pdf`), true);
    assert.equal(fs.readFileSync(`${dialogPdfPath}.pdf`).subarray(0, 5).toString('ascii'), '%PDF-');

    // 5c. 点击「全部保存」（dialog 模式）：先取消文件夹选择，再选定独立目录一次性写入 .md / .html / .pdf
    const batchDialogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cnav-batch-dlg-'));
    const batchDirectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cnav-batch-dir-'));
    try {
      process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT = '__CANCEL__';
      exportBtn.click();
      assert.equal(fmtMenu.hidden, false);
      harness.mockDoc.getElementById('agy-export-fmt-all').click();
      assert.equal(fmtMenu.hidden, true);
      await waitUntil(() => !exportBtn.disabled && /已取消导出/.test(toastEl.textContent));
      assert.match(toastEl.textContent, /已取消导出/);
      assert.equal(fs.readdirSync(batchDialogDir).length, 0);

      process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT = batchDialogDir;
      exportBtn.click();
      harness.mockDoc.getElementById('agy-export-fmt-all').click();
      await waitUntil(() => !exportBtn.disabled && fs.readdirSync(batchDialogDir).length === 3);
      assert.equal(exportBtn.disabled, false);
      assert.match(toastEl.textContent, /已全部保存 3 个文件/);
      const dlgFiles = fs.readdirSync(batchDialogDir).sort();
      assert.equal(dlgFiles.length, 3);
      const baseStems = new Set(dlgFiles.map((f) => f.replace(/\.(md|html|pdf)$/, '')));
      assert.equal(baseStems.size, 1);
      assert.equal(dlgFiles.some((f) => f.endsWith('.md')), true);
      assert.equal(dlgFiles.some((f) => f.endsWith('.html')), true);
      assert.equal(dlgFiles.some((f) => f.endsWith('.pdf')), true);
      assert.equal(fs.readFileSync(path.join(batchDialogDir, dlgFiles.find((f) => f.endsWith('.pdf')))).subarray(0, 5).toString('ascii'), '%PDF-');

      // 5d. direct 模式下点击「全部保存」：不弹对话框直接批量写入目标目录
      await harness.updatePluginSettings('agy-daddy.chat-nav', {
        exportSaveBehavior: 'direct',
        exportSaveDir: batchDirectDir
      });
      process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT = '__CANCEL__';
      exportBtn.click();
      harness.mockDoc.getElementById('agy-export-fmt-all').click();
      await waitUntil(() => !exportBtn.disabled && fs.readdirSync(batchDirectDir).length === 3);
      const dirFiles = fs.readdirSync(batchDirectDir).sort();
      assert.equal(dirFiles.length, 3);

      // 5e. 部分失败容错：chat-nav.export-all 当 PDF 渲染抛错时，MD 与 HTML 仍成功落盘且 partial === true
      const partialRes = await harness.executeCommand('chat-nav.export-all', [{
        formats: ['md', 'html', 'pdf'],
        saveBehavior: 'direct',
        outputDir: batchDirectDir,
        cascadeId: sessionUuid,
        pdfRenderer() { throw new Error('MOCK_PDF_RENDER_FAIL'); }
      }]);
      assert.equal(partialRes.ok, true);
      assert.equal(partialRes.partial, true);
      assert.equal(partialRes.succeeded.length, 2);
      assert.equal(partialRes.failed.length, 1);
      assert.equal(partialRes.failed[0].format, 'pdf');
      assert.match(partialRes.failed[0].error, /MOCK_PDF_RENDER_FAIL/);

      // 5f. PDF 强制展开全部思考块，而独立 HTML 仍保持折叠
      let singlePdfHtml = '';
      const singlePdfRes = await harness.executeCommand('chat-nav.export', [{
        format: 'pdf',
        saveBehavior: 'direct',
        outputDir: batchDirectDir,
        cascadeId: sessionUuid,
        pdfRenderer(htmlInput) {
          singlePdfHtml = String(htmlInput || '');
          return Buffer.from('%PDF-1.4\n%%EOF\n', 'ascii');
        }
      }]);
      assert.equal(singlePdfRes.ok, true);
      assert.match(singlePdfHtml, /<details class="thinking-box" open><summary>Thinking<\/summary>/);

      let batchPdfHtml = '';
      const batchPdfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cnav-batch-open-'));
      try {
        const batchOpenRes = await harness.executeCommand('chat-nav.export-all', [{
          formats: ['html', 'pdf'],
          saveBehavior: 'direct',
          outputDir: batchPdfDir,
          cascadeId: sessionUuid,
          pdfRenderer(htmlInput) {
            batchPdfHtml = String(htmlInput || '');
            return Buffer.from('%PDF-1.4\n%%EOF\n', 'ascii');
          }
        }]);
        assert.equal(batchOpenRes.ok, true);
        assert.match(batchPdfHtml, /<details class="thinking-box" open><summary>Thinking<\/summary>/);
        const savedHtmlFile = fs.readdirSync(batchPdfDir).find((f) => f.endsWith('.html'));
        assert.ok(savedHtmlFile);
        const savedHtmlText = fs.readFileSync(path.join(batchPdfDir, savedHtmlFile), 'utf8');
        assert.match(savedHtmlText, /<details class="thinking-box"><summary>Thinking<\/summary>/);
        assert.equal(savedHtmlText.includes('<details class="thinking-box" open>'), false);
      } finally {
        fs.rmSync(batchPdfDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(batchDialogDir, { recursive: true, force: true });
      fs.rmSync(batchDirectDir, { recursive: true, force: true });
    }

    // 6. 改回单选 ['pdf'] + direct：点击导出直接触发保存交互，不再弹格式菜单
    await harness.updatePluginSettings('agy-daddy.chat-nav', {
      exportFormats: ['pdf'],
      exportSaveBehavior: 'direct',
      exportSaveDir: tmpCustomDir
    });
    exportBtn.click();
    assert.equal(fmtMenu.hidden, true);
    await waitUntil(() => !exportBtn.disabled && fs.readdirSync(tmpCustomDir).some((f) => f.endsWith('.pdf')));
    const directPdfFiles = fs.readdirSync(tmpCustomDir).filter((f) => f.endsWith('.pdf'));
    assert.equal(directPdfFiles.length, 1);
    assert.equal(fs.readFileSync(path.join(tmpCustomDir, directPdfFiles[0])).subarray(0, 5).toString('ascii'), '%PDF-');

    // 7. RPC 返回空步骤时自动降级 DOM 消息导出
    useRpcTrajectory = false;
    const domRes = await fetch(`http://127.0.0.1:${port}/plugins/agy-daddy.chat-nav/export-md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AGY-Plugin-Token': loaded.pluginToken },
      body: JSON.stringify({
        cascadeId: sessionUuid,
        domMessages: [
          { role: 'user', text: 'DOM 兜底问题' },
          { role: 'assistant', text: 'DOM 兜底答复' }
        ]
      })
    });
    const domJson = await domRes.json();
    assert.equal(domJson.ok, true);
    assert.match(domJson.markdown, /DOM 兜底问题/);
    assert.match(domJson.markdown, /DOM 兜底答复/);

    await harness.unloadPlugin('agy-daddy.chat-nav');
    harness.assertCleanDispose('agy-daddy.chat-nav');
  } finally {
    if (prevExportDir === undefined) delete process.env.AGY_DADDY_EXPORT_DIR;
    else process.env.AGY_DADDY_EXPORT_DIR = prevExportDir;
    if (prevDlgRes === undefined) delete process.env.AGY_DADDY_TEST_SAVE_DIALOG_RESULT;
    else process.env.AGY_DADDY_TEST_SAVE_DIALOG_RESULT = prevDlgRes;
    if (prevDirDlgRes === undefined) delete process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT;
    else process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT = prevDirDlgRes;
    await harness.cleanup();
    fs.rmSync(tmpExportDir, { recursive: true, force: true });
    fs.rmSync(tmpCustomDir, { recursive: true, force: true });
  }
});

test('悬浮栏 z-index 低于弹窗/浮层，并在原生弹窗打开时自动让位及收起导出菜单', async () => {
  const { CHAT_NAV_STYLES } = require('../src/styles');
  assert.equal(/z-index:\s*214748/.test(CHAT_NAV_STYLES), false, 'CHAT_NAV_STYLES must not use 214748xxxx z-index');
  assert.match(CHAT_NAV_STYLES, /#agy-chat-nav-float\s*\{[\s\S]*?z-index:\s*20;/);
  assert.match(CHAT_NAV_STYLES, /#agy-chat-nav-float\[data-under-dialog="true"\]\s*\{\s*z-index:\s*1;\s*\}/);

  const doc = createMockDocument([]);
  const vp = createMockElement('div', doc);
  vp.setAttribute('data-testid', 'autoscroll-viewport');
  vp.getBoundingClientRect = () => ({ top: 40, bottom: 840, left: 260, right: 1000, width: 740, height: 800 });
  doc.body.appendChild(vp);

  const dialogObservers = new Set();
  let providedSvc = null;
  const ctx = {
    anchors: {
      query: (n) => (n === 'chat.scrollViewport' ? vp : null),
      queryAll: () => [],
      observe: (anchorName, fn) => {
        if (anchorName === 'settings.dialog') {
          dialogObservers.add(fn);
          return () => dialogObservers.delete(fn);
        }
        return () => {};
      }
    },
    events: { emit: () => {}, on: () => () => {} },
    services: { provide: (_name, svc) => { providedSvc = svc; return () => {}; } },
    surfaces: { provide: () => () => {} },
    styles: { inject: () => () => {} },
    settings: {
      get: () => ({ showFloatDock: true, exportFormats: ['md', 'html'] }),
      onChange: () => () => {}
    },
    bridge: { post: async () => ({ ok: true }) }
  };

  try {
    await mountChatNav(ctx, { document: doc, window: { innerWidth: 1400, innerHeight: 900 } });
    const dock = doc.getElementById('agy-chat-nav-float');
    assert.ok(dock);
    assert.equal(dock.getAttribute('data-under-dialog'), 'false');

    // 先打开导出格式菜单，随后出现可见 [role="dialog"] 时应自动让位并关闭导出菜单
    const exportBtn = doc.getElementById('agy-nav-export-md');
    const fmtMenu = doc.getElementById('agy-export-format-menu');
    exportBtn.click();
    assert.equal(fmtMenu.hidden, false);

    const dialogEl = createMockElement('div', doc);
    dialogEl.setAttribute('role', 'dialog');
    doc.body.appendChild(dialogEl);
    for (const fn of dialogObservers) fn(dialogEl);
    assert.equal(dock.getAttribute('data-under-dialog'), 'true');
    assert.equal(fmtMenu.hidden, true);

    // 隐藏的弹窗不应触发让位
    dialogEl.hidden = true;
    assert.equal(providedSvc.syncDockDialogLayering(), false);
    assert.equal(dock.getAttribute('data-under-dialog'), 'false');

    dialogEl.hidden = false;
    dialogEl.setAttribute('aria-hidden', 'true');
    assert.equal(providedSvc.syncDockDialogLayering(), false);
    assert.equal(dock.getAttribute('data-under-dialog'), 'false');

    // 移除原弹窗，校验 alertdialog 与 dialog[open] 同样触发让位
    dialogEl.remove();
    assert.equal(providedSvc.syncDockDialogLayering(), false);
    assert.equal(dock.getAttribute('data-under-dialog'), 'false');

    const alertDialog = createMockElement('div', doc);
    alertDialog.setAttribute('role', 'alertdialog');
    doc.body.appendChild(alertDialog);
    assert.equal(providedSvc.syncDockDialogLayering(), true);
    assert.equal(dock.getAttribute('data-under-dialog'), 'true');
    alertDialog.remove();

    const nativeDialog = createMockElement('dialog', doc);
    nativeDialog.setAttribute('open', '');
    doc.body.appendChild(nativeDialog);
    assert.equal(providedSvc.syncDockDialogLayering(), true);
    assert.equal(dock.getAttribute('data-under-dialog'), 'true');
    nativeDialog.remove();

    for (const fn of dialogObservers) fn(null);
    assert.equal(dock.getAttribute('data-under-dialog'), 'false');
  } finally {
    disposeChatNav();
    assert.equal(dialogObservers.size, 0);
  }
});

test('code-block-enhancer 与 outline-rail 纯函数：行数统计、语言提取、完成态判定、滚动补偿与关键提问识别', () => {
  assert.equal(countCodeLines(''), 0);
  assert.equal(countCodeLines('a\nb\n'), 2);
  assert.equal(countCodeLines('line1\nline2\nline3'), 3);

  const doc = createMockDocument([]);
  const pre = createMockElement('pre', doc);
  const code = createMockElement('code', doc);
  code.className = 'language-TypeScript';
  pre.appendChild(code);
  assert.equal(extractCodeLanguage(pre), 'typescript');

  const nativeWrap = createMockElement('div', doc);
  const nativeHdr = createMockElement('div', doc);
  nativeHdr.textContent = 'python 复制代码';
  const barePre = createMockElement('pre', doc);
  nativeWrap.appendChild(nativeHdr);
  nativeWrap.appendChild(barePre);
  assert.equal(extractCodeLanguage(barePre, nativeHdr), 'python');

  // 滚动补偿：块顶在视口上方 300px，高度从 1000 折叠到 40（差 960），scrollTop=800 -> 500（零跳动）
  assert.equal(computeCollapseScrollCompensation({
    blockTop: -260,
    blockHeightBefore: 1000,
    blockHeightAfter: 40,
    viewportTop: 40,
    scrollTop: 800
  }), 500);

  // 块顶已在视口下方时不改变 scrollTop
  assert.equal(computeCollapseScrollCompensation({
    blockTop: 120,
    blockHeightBefore: 1000,
    blockHeightAfter: 40,
    viewportTop: 40,
    scrollTop: 200
  }), 200);

  // 流式输出中最后一个 agent-response 的尾代码块未完成，前序块已完成
  const vp = createMockElement('div', doc);
  vp.setAttribute('data-testid', 'autoscroll-viewport');
  doc.body.appendChild(vp);
  const r1 = createMockElement('div', doc);
  r1.setAttribute('data-testid', 'agent-response');
  const p1 = createMockElement('pre', doc);
  r1.appendChild(p1);
  const r2 = createMockElement('div', doc);
  r2.setAttribute('data-testid', 'agent-response');
  const p2 = createMockElement('pre', doc);
  const p3 = createMockElement('pre', doc);
  r2.appendChild(p2);
  r2.appendChild(p3);
  vp.appendChild(r1);
  vp.appendChild(r2);

  assert.equal(isCodeBlockCompleted(p1, { isAssistantBusy: true, doc, viewport: vp }), true);
  assert.equal(isCodeBlockCompleted(p2, { isAssistantBusy: true, doc, viewport: vp }), true);
  assert.equal(isCodeBlockCompleted(p3, { isAssistantBusy: true, doc, viewport: vp }), false);
  assert.equal(isCodeBlockCompleted(p3, { isAssistantBusy: false, doc, viewport: vp }), true);

  // 关键提问与可编辑节点判断
  assert.equal(isKeyQuestionText('为什么这里会出现内存泄漏？'), true);
  assert.equal(isKeyQuestionText('How should we migrate this service?'), true);
  assert.equal(isKeyQuestionText('请继续执行构建'), false);

  const ta = createMockElement('textarea', doc);
  const lex = createMockElement('div', doc);
  lex.setAttribute('data-lexical-editor', 'true');
  const plainDiv = createMockElement('div', doc);
  assert.equal(isEditableElement(ta, doc), true);
  assert.equal(isEditableElement(lex, doc), true);
  assert.equal(isEditableElement(plainDiv, doc), false);

  const u1 = createMockElement('div', doc);
  u1.setAttribute('data-testid', 'user-message');
  u1.textContent = '为什么 SSE 断连没有重连？';
  const u2 = createMockElement('div', doc);
  u2.setAttribute('data-testid', 'user-message');
  u2.textContent = '继续补全单元测试';
  vp.appendChild(u1);
  vp.appendChild(u2);
  const items = extractOutlineItems(vp);
  assert.equal(items.length, 4);
  assert.equal(filterOutlineItems(items, 'questions').length, 1);
  assert.equal(filterOutlineItems(items, 'code').length, 2);
});

test('代码块 Sticky 吸顶与长代码块折叠（含 Markdown/Artifacts、流式门禁、滚动补偿及零残留）', async () => {
  const doc = createMockDocument([]);
  const vp = createMockElement('div', doc);
  vp.setAttribute('data-testid', 'autoscroll-viewport');
  vp.scrollTop = 500;
  vp.scrollHeight = 3000;
  vp.clientHeight = 600;
  vp.getBoundingClientRect = () => ({ top: 100, bottom: 700, left: 40, right: 840, width: 800, height: 600 });
  doc.body.appendChild(vp);

  // 短代码块（10 行，不显示折叠按钮）
  const resp1 = createMockElement('div', doc);
  resp1.setAttribute('data-testid', 'agent-response');
  const shortPre = createMockElement('pre', doc);
  const shortCode = createMockElement('code', doc);
  shortCode.className = 'language-json';
  shortCode.textContent = Array.from({ length: 10 }, (_, i) => `  "k${i}": ${i}`).join('\n');
  shortPre.appendChild(shortCode);
  resp1.appendChild(shortPre);
  vp.appendChild(resp1);

  // 长代码块（60 行，带原生外壳与复制按钮）
  const resp2 = createMockElement('div', doc);
  resp2.setAttribute('data-testid', 'agent-response');
  const nativeCard = createMockElement('div', doc);
  let collapsedState = false;
  nativeCard.getBoundingClientRect = () => ({
    top: -150,
    bottom: collapsedState ? -110 : 850,
    left: 60,
    right: 800,
    width: 740,
    height: collapsedState ? 40 : 1000
  });
  const nativeHdr = createMockElement('div', doc);
  const langTxt = createMockElement('span', doc);
  langTxt.textContent = 'ts';
  const nativeCopy = createMockElement('button', doc);
  nativeCopy.setAttribute('aria-label', 'Copy code');
  nativeHdr.appendChild(langTxt);
  nativeHdr.appendChild(nativeCopy);
  const longPre = createMockElement('pre', doc);
  const longCode = createMockElement('code', doc);
  longCode.className = 'language-ts';
  longCode.textContent = Array.from({ length: 60 }, (_, i) => `const line${i} = ${i};`).join('\n');
  longPre.appendChild(longCode);
  nativeCard.appendChild(nativeHdr);
  nativeCard.appendChild(longPre);
  resp2.appendChild(nativeCard);
  vp.appendChild(resp2);

  // Artifact 中的长代码块（52 行，无原生顶栏，需注入吸顶顶栏）
  const artifactBox = createMockElement('div', doc);
  artifactBox.setAttribute('data-testid', 'artifact-panel');
  const artPre = createMockElement('pre', doc);
  const artCode = createMockElement('code', doc);
  artCode.className = 'language-python';
  artCode.textContent = Array.from({ length: 52 }, (_, i) => `def fn_${i}(): return ${i}`).join('\n');
  artPre.appendChild(artCode);
  artifactBox.appendChild(artPre);
  doc.body.appendChild(artifactBox);

  let busy = true;
  let svc = null;
  let settingsHandler = null;
  let currentSettings = {
    showFloatDock: false,
    showOutlineRail: false,
    enableCodeBlockSticky: true,
    enableCodeBlockFold: true,
    codeFoldMinLines: 48
  };

  const ctx = {
    hostDom: { isAssistantBusy: () => busy },
    anchors: {
      query: (n) => (n === 'chat.scrollViewport' ? vp : null),
      queryAll: () => [],
      observe: () => () => {}
    },
    events: { emit: () => {}, on: () => () => {} },
    services: { provide: (_name, api) => { svc = api; return () => {}; } },
    surfaces: { provide: () => () => {} },
    styles: { inject: () => () => {} },
    settings: {
      get: () => currentSettings,
      onChange: (fn) => { settingsHandler = fn; return () => {}; }
    },
    bridge: { post: async () => ({ ok: true }) }
  };

  try {
    await mountChatNav(ctx, { document: doc, window: { innerWidth: 1200, innerHeight: 800 } });

    // 短代码块注入了吸顶顶栏，但不显示折叠开关
    const shortHeader = resp1.querySelector('[data-agy-code-header="injected"]');
    assert.ok(shortHeader);
    assert.equal(shortHeader.querySelector('.agy-code-lang').textContent, 'json');
    assert.equal(shortHeader.querySelector('.agy-code-fold-btn').hidden, true);

    // 处于流式生成中（busy=true），resp2 最后一个代码块尚不可折叠；Artifact 块已完成可折叠
    assert.equal(nativeHdr.getAttribute('data-agy-code-header'), 'native');
    assert.equal(nativeCard.getAttribute('data-agy-code-wrap'), '1');
    const nativeFoldBtn = nativeHdr.querySelector('[data-agy-code-fold="1"]');
    assert.ok(nativeFoldBtn);
    assert.equal(nativeFoldBtn.hidden, true);

    const artFoldBtn = artifactBox.querySelector('[data-agy-code-fold="1"]');
    assert.ok(artFoldBtn);
    assert.equal(artFoldBtn.hidden, false);

    // 生成结束后刷新，长代码块出现折叠开关
    busy = false;
    svc.refreshCodeBlocks();
    assert.equal(nativeFoldBtn.hidden, false);

    // 点击折叠：标记 collapsed，同时视口 scrollTop 从 500 精确补偿到 250（100 - (-150) = 250）
    const origSetAttr = longPre.setAttribute.bind(longPre);
    longPre.setAttribute = (k, v) => {
      origSetAttr(k, v);
      if (k === 'data-agy-code-collapsed') collapsedState = v === 'true';
    };
    const origRemoveAttr = longPre.removeAttribute.bind(longPre);
    longPre.removeAttribute = (k) => {
      origRemoveAttr(k);
      if (k === 'data-agy-code-collapsed') collapsedState = false;
    };

    nativeFoldBtn.click();
    assert.equal(longPre.getAttribute('data-agy-code-collapsed'), 'true');
    assert.equal(nativeCard.getAttribute('data-agy-code-collapsed'), 'true');
    assert.equal(vp.scrollTop, 250);

    const collapsedBar = nativeCard.querySelector('[data-agy-code-collapsed-bar="1"]');
    assert.ok(collapsedBar);
    assert.equal(collapsedBar.hidden, false);

    // 点击折叠条展开
    collapsedBar.click();
    assert.equal(longPre.getAttribute('data-agy-code-collapsed'), null);
    assert.equal(collapsedBar.hidden, true);

    // 动态调高阈值到 80 行后，60 行代码块隐藏折叠按钮
    currentSettings = { ...currentSettings, codeFoldMinLines: 80 };
    settingsHandler(currentSettings);
    assert.equal(nativeFoldBtn.hidden, true);

    disposeChatNav();
    assert.equal(resp1.querySelector('[data-agy-code-injected="1"]'), null);
    assert.equal(nativeHdr.querySelector('[data-agy-code-fold="1"]'), null);
    assert.equal(nativeHdr.getAttribute('data-agy-code-header'), null);
    assert.equal(nativeCard.getAttribute('data-agy-code-wrap'), null);
  } finally {
    disposeChatNav();
  }
});

test('左侧会话导轨章节刻度、悬停大纲、关键提问筛选与 Alt+↑/↓ 非编辑态快捷键跳转', async () => {
  const harness = createMockHostHarness({
    seedAnchors: [
      { tag: 'div', attr: 'data-testid', val: 'autoscroll-viewport' },
      { tag: 'div', attr: 'data-testid', val: 'turn-cards-container' },
      { tag: 'button', attr: 'data-testid', val: 'thinking-collapsible-trigger' }
    ]
  });

  const vp = harness.mockDoc.querySelector('[data-testid="autoscroll-viewport"]');
  vp.scrollTop = 0;
  vp.scrollHeight = 2400;
  vp.clientHeight = 600;
  vp.getBoundingClientRect = () => ({ top: 40, bottom: 640, left: 240, right: 1040, width: 800, height: 600 });

  const u1 = createMockElement('div', harness.mockDoc);
  u1.setAttribute('data-testid', 'user-message');
  u1.textContent = '如何优化长会话渲染性能？';
  u1.getBoundingClientRect = () => ({ top: 100 - vp.scrollTop, bottom: 150 - vp.scrollTop, left: 260, right: 1000, width: 740, height: 50 });

  const a1 = createMockElement('div', harness.mockDoc);
  a1.setAttribute('data-testid', 'agent-response');
  const h2 = createMockElement('h2', harness.mockDoc);
  h2.textContent = '虚拟列表与吸顶优化';
  h2.getBoundingClientRect = () => ({ top: 260 - vp.scrollTop, bottom: 290 - vp.scrollTop, left: 260, right: 1000, width: 740, height: 30 });
  const codeBlock = createMockElement('pre', harness.mockDoc);
  codeBlock.textContent = 'const x = 1;';
  a1.appendChild(h2);
  a1.appendChild(codeBlock);

  const u2 = createMockElement('div', harness.mockDoc);
  u2.setAttribute('data-testid', 'user-message');
  u2.textContent = '帮我更新配置文件';
  u2.getBoundingClientRect = () => ({ top: 900 - vp.scrollTop, bottom: 950 - vp.scrollTop, left: 260, right: 1000, width: 740, height: 50 });

  const a2 = createMockElement('div', harness.mockDoc);
  a2.setAttribute('data-testid', 'agent-response');
  a2.textContent = '已更新完毕';

  vp.appendChild(u1);
  vp.appendChild(a1);
  vp.appendChild(u2);
  vp.appendChild(a2);

  // 加入一个输入框测试编辑焦点隔离
  const composerInput = createMockElement('div', harness.mockDoc);
  composerInput.setAttribute('contenteditable', 'true');
  composerInput.setAttribute('data-lexical-editor', 'true');
  harness.mockDoc.body.appendChild(composerInput);

  try {
    const { port } = await harness.bridge.start(0);
    harness.rendererHost.configure({ bridgePort: port });
    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0' });

    const rail = harness.mockDoc.getElementById('agy-chat-outline-rail');
    const popover = harness.mockDoc.getElementById('agy-chat-outline-popover');
    assert.ok(rail);
    assert.ok(popover);
    assert.equal(rail.hidden, false);
    assert.equal(rail.style.left, '246px');
    assert.equal(popover.hidden, true);

    const ticks = rail.querySelectorAll('.agy-rail-tick');
    assert.equal(ticks.length, 2);
    assert.equal(ticks[0].getAttribute('data-key-question'), 'true');
    assert.equal(ticks[1].getAttribute('data-key-question'), 'false');

    // 悬停导轨展开大纲索引，支持「全部 / 关键提问 / 含代码」筛选与章节跳转
    rail.dispatchEvent({ type: 'mouseenter' });
    assert.equal(popover.hidden, false);
    assert.equal(popover.querySelectorAll('.agy-outline-item').length, 2);
    assert.equal(popover.querySelectorAll('.agy-outline-subheading').length, 1);

    const qFilterBtn = harness.mockDoc.getElementById('agy-outline-filter-questions');
    qFilterBtn.click();
    assert.equal(popover.querySelectorAll('.agy-outline-item').length, 1);

    const allFilterBtn = harness.mockDoc.getElementById('agy-outline-filter-all');
    allFilterBtn.click();
    const outlineItems = popover.querySelectorAll('.agy-outline-item');
    assert.equal(outlineItems.length, 2);
    outlineItems[1].click();
    assert.equal(vp.scrollTop, 848);

    // 键盘 Alt+↑ / Alt+↓ 在非编辑焦点下跳转，不阻断事件冒泡；编辑焦点下不拦截
    let preventedNonEdit = false;
    let stoppedNonEdit = false;
    harness.mockDoc.dispatchEvent({
      type: 'keydown',
      key: 'ArrowUp',
      code: 'ArrowUp',
      altKey: true,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      target: vp,
      preventDefault() { preventedNonEdit = true; },
      stopPropagation() { stoppedNonEdit = true; }
    });
    assert.equal(preventedNonEdit, true);
    assert.equal(stoppedNonEdit, false);
    assert.equal(vp.scrollTop, 48);

    let preventedInEditor = false;
    harness.mockDoc.dispatchEvent({
      type: 'keydown',
      key: 'ArrowDown',
      code: 'ArrowDown',
      altKey: true,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      target: composerInput,
      preventDefault() { preventedInEditor = true; }
    });
    assert.equal(preventedInEditor, false);
    assert.equal(vp.scrollTop, 48);

    // Escape 关闭大纲浮层
    harness.mockDoc.dispatchEvent({
      type: 'keydown',
      key: 'Escape',
      target: vp,
      preventDefault() {}
    });
    assert.equal(popover.hidden, true);

    // 验证新增命令 chat-nav.toggle-outline / chat-nav.turn-next / chat-nav.collapse-long-code
    const toggleOutlineRes = await harness.executeCommand('chat-nav.toggle-outline');
    assert.equal(toggleOutlineRes.ok, true);
    const turnNextRes = await harness.executeCommand('chat-nav.turn-next');
    assert.equal(turnNextRes.ok, true);
    const collapseCodeRes = await harness.executeCommand('chat-nav.collapse-long-code');
    assert.equal(collapseCodeRes.ok, true);

    // 卸载清理零残留
    await harness.unloadPlugin('agy-daddy.chat-nav');
    assert.equal(harness.mockDoc.getElementById('agy-chat-outline-rail'), null);
    assert.equal(harness.mockDoc.getElementById('agy-chat-outline-popover'), null);
    harness.assertCleanDispose('agy-daddy.chat-nav');
  } finally {
    await harness.cleanup();
  }
});
