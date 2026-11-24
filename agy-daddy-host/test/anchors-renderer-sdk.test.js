'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('vm');
const { loadAnchorsRegistry, resolveAnchorSelectors, checkAnchorHealth, checkPluginAnchors } = require('../src/core/anchors');
const { KNOWN_ANCHORS } = require('../src/contracts/constants');
const { createMockHostHarness, createMockDocument } = require('../sdk/mock-harness');
const { createHostRuntime } = require('../src/renderer/host-runtime');

const HOST_ROOT = path.resolve(__dirname, '..');

test('anchors.json 覆盖全部具名锚点并可检测缺失禁用', () => {
  const registry = loadAnchorsRegistry();
  for (const name of KNOWN_ANCHORS) {
    assert.ok(registry.anchors[name], `Missing anchor definition: ${name}`);
    const resolved = resolveAnchorSelectors(name, '2.33.0', registry);
    assert.equal(resolved.found, true);
    assert.ok(resolved.selectors.length >= 1);
  }

  const doc = createMockDocument();
  const health = checkAnchorHealth(registry, '2.33.0', (sel) => doc.querySelector(sel));
  assert.ok(health.matched['topbar.rightCluster']);
  assert.ok(health.matched['composer.editor']);

  const okCheck = checkPluginAnchors({ requires: { anchors: ['topbar.rightCluster', 'composer.editor'] } }, health);
  assert.equal(okCheck.ok, true);
  const missCheck = checkPluginAnchors({ requires: { anchors: ['fileViewer.header'] } }, health);
  assert.equal(missCheck.ok, false);
  assert.deepEqual(missCheck.missing, ['fileViewer.header']);
});

test('UI 主题色系一致性、去插件化静态门禁与渲染层产物编译', () => {
  const uiFiles = [
    path.join(HOST_ROOT, 'src', 'renderer', 'styles.css'),
    path.join(HOST_ROOT, 'src', 'renderer', 'lightdom-styles.css'),
    path.join(HOST_ROOT, 'src', 'renderer', 'host-runtime.js'),
    path.join(HOST_ROOT, 'dist', 'host-renderer.js')
  ];
  const forbiddenColors = [
    /#10b981/i,
    /16,\s*185,\s*129/,
    /#34d399/i,
    /#059669/i,
    /#38bdf8/i,
    /56,\s*189,\s*248/,
    /2,\s*132,\s*199/,
    /#7dd3fc/i,
    /#(?:0369a1|0c4a6e)/i,
    /#(?:fb923c|c2410c)|249,\s*115,\s*22|234,\s*88,\s*12/i
  ];
  const forbiddenCoupling = [
    'FRIENDLY_SETTING_LABELS',
    'inferSchemaFromTab',
    'disposeLegacyGlobals',
    'registerSection',
    'agy-pulse-context-capsule',
    'agy-quick-capsule-bar',
    'agy-prompt-opt-btn',
    'agy-next-step-ghost',
    'agy-chat-nav-float',
    'agy-chat-search-slot',
    'agy-chat-search-box',
    'agy-community-chat-search',
    'agy-file-editor-controls',
    'agy-inline-file-editor-panel',
    'ag-heatmap-box',
    'ag-qr-box',
    'term-option-card',
    "icon === 'terminal'"
  ];
  for (const f of uiFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of forbiddenColors) {
      assert.equal(re.test(src), false, `${path.basename(f)} violated theme color gate: ${re}`);
    }
    for (const tok of forbiddenCoupling) {
      assert.equal(src.includes(tok), false, `${path.basename(f)} violated host decoupling gate: ${tok}`);
    }
  }
  const bundle = fs.readFileSync(uiFiles[3], 'utf8');
  assert.doesNotThrow(() => new vm.Script(bundle, { filename: 'host-renderer.js' }));
  assert.equal(/#a78bfa|#7c3aed/i.test(bundle), false, 'host-renderer.js should not contain purple theme hex colors');
  assert.match(bundle, /data-agy-nav-active/);
  assert.match(bundle, /--sidebar-secondary/);
});

test('渲染底座纯净微内核：无旧全局耦合、不泄露全局 Token、熔断隔离故障插件', async () => {
  const doc = createMockDocument();
  const win = {
    location: { href: 'https://127.0.0.1:51410/abc' }
  };

  const host = createHostRuntime({
    document: doc,
    window: win,
    anchorsRegistry: loadAnchorsRegistry()
  });

  try {
    // 1. 不得在 window 暴露全局 bridge token 或历史兼容函数
    assert.equal(win.__AGYDaddyHost.bridgeToken, undefined);
    assert.equal(win.__AGYDaddyHost.hostToken, undefined);
    assert.equal(win.__AGYDaddyHost.disposeLegacyGlobals, undefined);

    // 2. 挂载正常插件与故障插件，故障插件崩溃不影响正常插件
    await host.mountPlugin('good.plugin', {
      mount(ctx) {
        assert.equal(ctx.settings.registerSection, undefined);
        ctx.topbar.registerUnit({ id: 'ok', order: 1, label: 'OK' });
      },
      dispose() {}
    });

    const badRes = await host.mountPlugin('bad.plugin', {
      mount() { throw new Error('boom'); }
    });
    assert.equal(badRes.ok, false);
    assert.equal(host.getPluginUsageStats('good.plugin').domNodes, 1);
    assert.equal(host.getPluginUsageStats('bad.plugin').domNodes, 0);
  } finally {
    await host.dispose();
  }
});

test('SDK Mock Harness 端到端运行模板插件 example.hello（隔离世界校验 + 零泄漏 dispose）', async () => {
  const harness = createMockHostHarness();
  try {
    const templateDir = path.join(HOST_ROOT, 'templates', 'plugin-template');
    const loaded = await harness.loadAndRunPlugin(templateDir, {
      trustLevel: 'T2',
      grantedPermissions: ['dom:write', 'bridge:route']
    });
    assert.equal(loaded.manifest.id, 'example.hello');
    assert.equal(loaded.trust.world, 'isolated');
    assert.ok(harness.isolatedWorlds.has('example.hello'));

    // 隔离世界不能读取主世界的 __APP_CONFIG__.csrfToken
    const isoWinCheck = vm.runInContext('typeof __APP_CONFIG__', harness.isolatedWorlds.get('example.hello'));
    assert.equal(isoWinCheck, 'undefined');

    // 验证 Node 服务与粘性状态
    const greetRes = await harness.bus.callService('hello', 'greet', ['World']);
    assert.equal(greetRes.value, 'Hi, World!');
    assert.equal(harness.bus.getState('state:hello.greeting@1').value.ready, true);

    // 卸载并严格断言零残留
    await harness.unloadPlugin('example.hello');
    harness.assertCleanDispose('example.hello');
  } finally {
    await harness.cleanup();
  }
});

test('hostDom.sendText 在 Lexical beforeinput preventDefault 返回 false 场景下不重复注入且 sendTextSeq 取消过期定时器', async () => {
  const { buildIsolatedWorldPluginScript } = require('../src/core/injector');
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

  function setupLexicalEnv() {
    const doc = createMockDocument();
    const editor = doc.querySelector('[contenteditable="true"]');
    const sendBtn = doc.querySelector('[data-testid="input-send-button"]');
    const sentPayloads = [];
    const beforeInputEvents = [];
    let listboxEl = null;

    function clearSlashMenu() {
      if (listboxEl) {
        listboxEl.remove();
        listboxEl = null;
      }
    }

    function showSlashMenuFor(cmdText) {
      clearSlashMenu();
      const name = cmdText.slice(1);
      if (name !== 'compact' && name !== 'plan') return;
      listboxEl = doc.createElement('div');
      listboxEl.setAttribute('role', 'listbox');
      const opt = doc.createElement('div');
      opt.setAttribute('role', 'option');
      const inner = doc.createElement('div');
      inner.className = 'cursor-pointer';
      const label = doc.createElement('span');
      label.textContent = name === 'compact' ? 'compact 压缩上下文' : '/plan';
      inner.appendChild(label);
      opt.appendChild(inner);
      inner.addEventListener('click', () => {
        editor.textContent = `[pill:${name}]`;
        clearSlashMenu();
      });
      listboxEl.appendChild(opt);
      doc.body.appendChild(listboxEl);
    }

    editor.addEventListener('beforeinput', (ev) => {
      beforeInputEvents.push({ type: ev.inputType, data: ev.data, prevented: ev.defaultPrevented });
      if (ev.inputType === 'insertText' && typeof ev.data === 'string') {
        ev.preventDefault();
        editor.textContent = `${editor.textContent || ''}${ev.data}`;
      }
    });

    sendBtn.addEventListener('click', () => {
      sentPayloads.push(editor.textContent);
      editor.textContent = '';
    });

    doc.execCommand = (cmd, _ui, val) => {
      if (cmd === 'selectAll') return true;
      if (cmd === 'delete') {
        editor.textContent = '';
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
        if (/^\/[a-z0-9-]+$/i.test(editor.textContent)) {
          showSlashMenuFor(editor.textContent);
        } else {
          clearSlashMenu();
        }
        return !ev.defaultPrevented;
      }
      return false;
    };

    return { doc, editor, sentPayloads, beforeInputEvents };
  }

  const prevInputEvent = globalThis.InputEvent;
  globalThis.InputEvent = MockInputEvent;
  try {
    // 1. Main-world host-runtime.js
    const mainEnv = setupLexicalEnv();
    const host = createHostRuntime({
      document: mainEnv.doc,
      window: { location: { href: 'https://127.0.0.1:51410/abc' } },
      anchorsRegistry: loadAnchorsRegistry()
    });
    let mainHostDom = null;
    try {
      await host.mountPlugin('test.main.sendtext', {
        mount(ctx) {
          mainHostDom = ctx.hostDom;
        }
      });
      assert.equal(mainHostDom.sendText('/compact'), true);
      await new Promise((r) => setTimeout(r, 90));
      assert.equal(mainEnv.beforeInputEvents.length, 1);
      assert.equal(mainEnv.beforeInputEvents[0].data, '/compact');
      assert.deepEqual(mainEnv.sentPayloads, ['[pill:compact]']);

      mainEnv.sentPayloads.length = 0;
      mainEnv.editor.textContent = 'draft';
      mainHostDom.sendText('/compact');
      mainHostDom.sendText('/plan');
      await new Promise((r) => setTimeout(r, 90));
      assert.deepEqual(mainEnv.sentPayloads, ['[pill:plan]']);
    } finally {
      await host.dispose();
    }

    // 2. Isolated-world injector.js runtime
    const isoEnv = setupLexicalEnv();
    const isoScript = buildIsolatedWorldPluginScript(
      'test.iso.sendtext',
      'module.exports = { mount(ctx) { globalThis.__isoSend = (t) => ctx.hostDom.sendText(t); } };',
      {
        xworldChannelName: '__agy_xworld_test_sendtext',
        bridgePort: 0,
        pluginToken: 'tok',
        anchorsRegistry: loadAnchorsRegistry(),
        hostVersion: '1.0.0',
        initialSettings: {}
      }
    );
    const isoCtx = vm.createContext({
      document: isoEnv.doc,
      InputEvent: MockInputEvent,
      CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      console
    });
    isoCtx.globalThis = isoCtx;
    isoCtx.window = isoCtx;
    await vm.runInContext(isoScript, isoCtx);
    assert.equal(typeof isoCtx.__isoSend, 'function');
    assert.equal(isoCtx.__isoSend('/compact'), true);
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(isoEnv.beforeInputEvents.length, 1);
    assert.equal(isoEnv.beforeInputEvents[0].data, '/compact');
    assert.deepEqual(isoEnv.sentPayloads, ['[pill:compact]']);
    await isoCtx.__agyIsolatedDispose();
  } finally {
    if (prevInputEvent === undefined) delete globalThis.InputEvent;
    else globalThis.InputEvent = prevInputEvent;
  }
});
