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

const { createMockHostHarness, createMockElement } = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));
const { readFileSafe, writeFileSafe, resolveSafeEditablePath } = require('../src/file-service');
const { isSafeExternalUrl } = require('../src/renderer');

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

test('插件契约：主题门禁、悬浮导航、⌘1~⌘9 切换与角标、⌘⇧[]/⌃Tab 轮换、行内编辑 ⌘S 与零残留 dispose', async () => {
  const forbidden = [/#10b981/i, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#fb923c/i, /#c2410c/i];
  for (const file of fs.readdirSync(path.join(PLUGIN_ROOT, 'src'))) {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'src', file), 'utf8');
    for (const re of forbidden) assert.equal(re.test(src), false, `${file} violated theme gate: ${re}`);
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

    await harness.loadAndRunPlugin(PLUGIN_ROOT, { trustLevel: 'T0', inProcessRenderer: true });

    const dock = harness.mockDoc.getElementById('agy-chat-nav-float');
    assert.ok(dock);
    const editBtn = harness.mockDoc.getElementById('agy-file-editor-controls');
    assert.ok(editBtn);

    let chatNavApi = null;
    await harness.rendererHost.mountPlugin('test.ext.consumer', {
      mount(ctx) { chatNavApi = ctx.services.get('chat-nav'); }
    });
    assert.ok(chatNavApi);

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
    await new Promise((r) => setTimeout(r, 20));
    const ta = harness.mockDoc.getElementById('agy-inline-file-textarea');
    assert.ok(ta);
    assert.equal(ta.value, '# 原内容');
    ta.value = '# 新修订内容';
    harness.mockDoc.dispatchEvent({ type: 'keydown', key: 's', metaKey: true, shiftKey: false, ctrlKey: false, altKey: false });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(fs.readFileSync(editFilePath, 'utf8'), '# 新修订内容');
    harness.mockDoc.getElementById('agy-inline-file-done').click();
    assert.equal(harness.mockDoc.getElementById('agy-inline-file-editor-panel'), null);

    // 验证思考展开、扩展按钮与 search slot
    const expanded = chatNavApi.expandThinking();
    assert.equal(expanded, 1);
    assert.equal(thinkingEvents.length, 1);

    let extClicked = 0;
    const rmExtBtn = chatNavApi.registerNavButton({ id: 'bookmark', label: '★', onClick: () => { extClicked++; } });
    harness.mockDoc.getElementById('agy-nav-ext-bookmark').click();
    assert.equal(extClicked, 1);
    rmExtBtn();
    assert.equal(harness.mockDoc.getElementById('agy-nav-ext-bookmark'), null);

    let searchArg = '';
    const rmSearch = chatNavApi.registerSearchProvider({ id: 'demo', onSearch: (q) => { searchArg = q; } });
    const searchInput = harness.mockDoc.getElementById('agy-chat-search-input');
    searchInput.value = 'foo';
    searchInput.dispatchEvent({ type: 'change', target: searchInput });
    assert.equal(searchArg, 'foo');
    rmSearch();

    await harness.rendererHost.disposePlugin('test.zh.mock');
    await harness.rendererHost.disposePlugin('test.ext.consumer');
    await harness.unloadPlugin('agy-daddy.chat-nav');
    assert.equal(harness.mockDoc.getElementById('agy-chat-nav-float'), null);
    assert.equal(harness.mockDoc.getElementById('agy-file-editor-controls'), null);
    harness.assertCleanDispose('agy-daddy.chat-nav');
  } finally {
    await harness.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
