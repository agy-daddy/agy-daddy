'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMockDocument, createMockElement } = require('../sdk/mock-harness');
const { createHostRuntime } = require('../src/renderer/host-runtime');

const HOST_ROOT = path.resolve(__dirname, '..');

function buildFullAnchorsRegistry() {
  return {
    schemaVersion: 1,
    anchors: {
      'topbar.rightCluster': { versions: [{ range: '>=2.0.0', selectors: ['[data-testid="toggle-aux-sidebar"]'] }] },
      'composer.root': { versions: [{ range: '>=2.0.0', selectors: ['.surface-composer'] }] },
      'composer.editor': { versions: [{ range: '>=2.0.0', selectors: ['[data-lexical-editor="true"]'] }] },
      'composer.sendButton': { versions: [{ range: '>=2.0.0', selectors: ['[data-testid="input-send-button"]'] }] },
      'chat.scrollViewport': { versions: [{ range: '>=2.0.0', selectors: ['[data-testid="autoscroll-viewport"]'] }] },
      'chat.messageList': { versions: [{ range: '>=2.0.0', selectors: ['[data-testid="turn-cards-container"]'] }] },
      'chat.thinkingTrigger': { versions: [{ range: '>=2.0.0', selectors: ['[data-testid="thinking-collapsible-trigger"]'] }] },
      'chat.actionButtons': { versions: [{ range: '>=2.0.0', selectors: ['[data-testid="agent-response"] button'] }] },
      'sidebar.conversationRows': { versions: [{ range: '>=2.0.0', selectors: ['[data-testid="conversation-row-sidebar"]'] }] },
      'sidebar.root': { versions: [{ range: '>=2.0.0', selectors: ['aside[data-testid="sidebar-panel"].bg-sidebar', 'aside[data-testid="sidebar-panel"]'] }] },
      'fileViewer.header': { versions: [{ range: '>=2.0.0', selectors: ['[aria-label="File Viewer header"]'] }] },
      'settings.dialog': {
        versions: [{
          range: '>=2.0.0',
          selectors: [
            '[data-testid="settings-dialog"]',
            '[role="dialog"][aria-label*="Settings"]',
            '[role="dialog"][aria-label*="设置"]',
            '[role="dialog"]'
          ]
        }]
      },
      'settings.nav': {
        versions: [{
          range: '>=2.0.0',
          selectors: [
            '[data-testid="settings-nav"]',
            '[role="dialog"] nav',
            '[role="dialog"] [role="tablist"]',
            '[role="dialog"] aside'
          ]
        }]
      },
      'settings.content': {
        versions: [{
          range: '>=2.0.0',
          selectors: [
            '[data-testid="settings-content"]',
            '[role="dialog"] main',
            '[role="dialog"] [role="tabpanel"]'
          ]
        }]
      },
      'settings.openTrigger': {
        versions: [{
          range: '>=2.0.0',
          selectors: [
            '[data-testid="open-settings-button"]',
            'button[aria-label="Settings"]',
            'button[aria-label="Open Settings"]',
            'button[aria-label="设置"]',
            'button[aria-label="打开设置"]'
          ]
        }]
      }
    }
  };
}

function attachNativeSettingsDialog(doc, initialContentDisplay = 'flex') {
  const dialog = createMockElement('div', doc);
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('data-testid', 'settings-dialog');
  dialog.setAttribute('aria-label', 'Settings');

  const nav = createMockElement('nav', doc);
  nav.setAttribute('data-testid', 'settings-nav');

  const generalBtn = createMockElement('button', doc);
  generalBtn.textContent = 'General';
  const accountBtn = createMockElement('button', doc);
  accountBtn.textContent = 'Account';
  nav.appendChild(generalBtn);
  nav.appendChild(accountBtn);

  const content = createMockElement('main', doc);
  content.setAttribute('data-testid', 'settings-content');
  if (initialContentDisplay) {
    content.style.setProperty('display', initialContentDisplay);
    content.style.display = initialContentDisplay;
  }
  const reactChild1 = createMockElement('div', doc);
  reactChild1.id = 'native-react-child-1';
  reactChild1.textContent = 'React General Pane';
  const reactChild2 = createMockElement('div', doc);
  reactChild2.id = 'native-react-child-2';
  content.appendChild(reactChild1);
  content.appendChild(reactChild2);

  dialog.appendChild(nav);
  dialog.appendChild(content);
  doc.body.appendChild(dialog);
  return { dialog, nav, content, generalBtn, accountBtn, reactChild1, reactChild2 };
}

function createMockBridgeFetch(handlers = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ path: parsed.pathname, headers: init.headers || {}, body });
    const handler = handlers[parsed.pathname];
    const data = typeof handler === 'function'
      ? await handler(body, init)
      : { ok: true };
    return {
      ok: data?.httpOk !== undefined ? Boolean(data.httpOk) : true,
      status: data?.httpStatus || 200,
      async json() { return data; }
    };
  };
  return { calls, fetchFn };
}

function createXworldClient(doc, nonce) {
  const channelName = `__agy_xworld_${nonce}`;
  const events = [];
  const pending = new Map();
  let seq = 0;

  const listener = (ev) => {
    const detail = ev?.detail;
    if (!detail || detail.direction !== 'to-isolated') return;
    if (detail.reqId && pending.has(detail.reqId)) {
      const p = pending.get(detail.reqId);
      pending.delete(detail.reqId);
      if (detail.reply?.ok) p.resolve(detail.reply.value);
      else p.reject(new Error(detail.reply?.error || 'XWORLD_ERR'));
      return;
    }
    events.push(detail);
  };
  doc.addEventListener(channelName, listener);

  function send(payload) {
    const reqId = `req-${++seq}`;
    return new Promise((resolve, reject) => {
      pending.set(reqId, { resolve, reject });
      doc.dispatchEvent({
        type: channelName,
        detail: { direction: 'to-main', reqId, ...payload }
      });
    });
  }

  return {
    channelName,
    events,
    send,
    dispose() { doc.removeEventListener(channelName, listener); }
  };
}

test('彻底去插件化与紫色主题静态门禁（lightdom-styles / styles / host-runtime / dist）', () => {
  const lightCss = fs.readFileSync(path.join(HOST_ROOT, 'src', 'renderer', 'lightdom-styles.css'), 'utf8');
  const shadowCss = fs.readFileSync(path.join(HOST_ROOT, 'src', 'renderer', 'styles.css'), 'utf8');
  const runtimeJs = fs.readFileSync(path.join(HOST_ROOT, 'src', 'renderer', 'host-runtime.js'), 'utf8');
  const distJs = fs.readFileSync(path.join(HOST_ROOT, 'dist', 'host-renderer.js'), 'utf8');

  // lightdom-styles.css 仅含原生设置注入极简样式，绝不含任何插件私有 ID
  assert.match(lightCss, /\[data-agy-native-nav="true"\]/);
  assert.match(lightCss, /#agy-native-settings-mount/);
  for (const bannedId of [
    '#agy-pulse-context-capsule',
    '#agy-quick-capsule-bar',
    '#agy-prompt-opt-btn',
    '#agy-next-step-ghost',
    '#agy-chat-nav-float',
    '#agy-chat-search-slot',
    '#agy-chat-search-box',
    '#agy-community-chat-search',
    '#agy-file-editor-controls',
    '#agy-inline-file-editor-panel'
  ]) {
    assert.equal(lightCss.includes(bannedId), false, `lightdom-styles.css must not contain ${bannedId}`);
  }

  // styles.css 移除插件专属样式，保留宿主 token 与通用原子类
  for (const removedCls of ['.ag-heatmap-box', '.ag-qr-box', '.term-option-card']) {
    assert.equal(shadowCss.includes(removedCls), false, `styles.css must not contain ${removedCls}`);
  }
  for (const keptCls of ['.ag-panel', '.ag-btn', '.ag-chip', '.settings-card-box', '.ag-kpi-grid', '.ag-progress-track', '.ag-toggle-label', '.settings-input', '.switch-pill-btn', '.ag-modal-dialog', '.agy-settings-view']) {
    assert.ok(shadowCss.includes(keptCls), `styles.css missing required class ${keptCls}`);
  }
  assert.match(shadowCss, /\.ag-panel\s*\{[\s\S]*?flex-direction:\s*column;[\s\S]*?overflow:\s*hidden;/);
  assert.match(shadowCss, /\.ag-panel-head\s*\{[\s\S]*?flex-shrink:\s*0;/);
  assert.match(shadowCss, /\.ag-panel-body\s*\{[\s\S]*?overflow-y:\s*auto;/);

  // host-runtime.js 与 dist 不含历史耦合与禁用色值
  const forbiddenTokens = ['FRIENDLY_SETTING_LABELS', 'inferSchemaFromTab', 'disposeLegacyGlobals', 'registerSection', "icon === 'terminal'"];
  const forbiddenColors = [/#10b981/i, /16,\s*185,\s*129/, /#34d399/i, /#059669/i, /#38bdf8/i, /#7dd3fc/i, /#0369a1/i, /#0c4a6e/i, /#fb923c/i, /#c2410c/i];
  for (const src of [lightCss, shadowCss, runtimeJs, distJs]) {
    for (const tok of forbiddenTokens) assert.equal(src.includes(tok), false, `Found forbidden token: ${tok}`);
    for (const re of forbiddenColors) assert.equal(re.test(src), false, `Found forbidden color: ${re}`);
  }
});

test('原生设置弹窗融合：防重复注入、零修改 React 子树、切回无损恢复原 display', async () => {
  const doc = createMockDocument();
  const win = { location: { href: 'https://127.0.0.1:51410/' } };
  const host = createHostRuntime({
    document: doc,
    window: win,
    anchorsRegistry: buildFullAnchorsRegistry()
  });

  try {
    const { dialog, nav, content, generalBtn, reactChild1, reactChild2 } = attachNativeSettingsDialog(doc, 'flex');

    // 多次同步仅注入 1 个 Agy-Daddy 导航按钮
    assert.equal(host.syncNativeSettings(), true);
    assert.equal(host.syncNativeSettings(), true);
    const agyNavBtns = nav.querySelectorAll('[data-agy-native-nav="true"]');
    assert.equal(agyNavBtns.length, 1);
    assert.equal(agyNavBtns[0].textContent, 'Agy-Daddy');

    // 点击 Agy-Daddy 激活原生融合视图
    agyNavBtns[0].click();
    assert.equal(host.getSettingsMode(), 'native');
    assert.equal(agyNavBtns[0].getAttribute('data-active'), 'true');
    assert.equal(content.style.getPropertyValue('display'), 'none');

    // 原生 settings.content 内部 React 子树一字不动
    assert.equal(content.children.length, 2);
    assert.equal(content.children[0], reactChild1);
    assert.equal(content.children[1], reactChild2);

    // 同级挂载 Shadow DOM 容器并渲染两段式 <agy-settings-view>（通用 / 外观）
    const mountEl = dialog.querySelector('#agy-native-settings-mount');
    assert.ok(mountEl);
    assert.equal(mountEl.parentElement, dialog);
    assert.equal(mountEl.hidden, false);
    const nativeShadow = mountEl.shadowRoot;
    assert.ok(nativeShadow.querySelector('#agy-tab-plugins'));
    assert.ok(nativeShadow.querySelector('#agy-tab-appearance'));
    assert.equal(nativeShadow.querySelector('#agy-tab-diagnostics'), null);
    assert.ok(nativeShadow.querySelector('#agy-settings-search'));

    // 点击原生导航任意其他按钮 -> 隐藏 Agy 容器并无损恢复原生 display: flex
    generalBtn.click();
    assert.equal(host.getSettingsMode(), 'closed');
    assert.equal(mountEl.hidden, true);
    assert.equal(agyNavBtns[0].getAttribute('data-active'), 'false');
    assert.equal(content.style.getPropertyValue('display'), 'flex');
    assert.equal(content.children.length, 2);

    // 再次激活后关闭原生弹窗 -> 清理状态
    agyNavBtns[0].click();
    assert.equal(host.getSettingsMode(), 'native');
    dialog.remove();
    assert.equal(host.syncNativeSettings(), false);
    assert.equal(host.getSettingsMode(), 'closed');
  } finally {
    await host.dispose();
  }
});

test('openSettings 触发原生 openTrigger 切入 与 锚点失效时降级为居中独立模态窗（Esc/遮罩关闭）', async () => {
  // 1. 命中 settings.openTrigger -> 点击弹出原生弹窗并直达指定插件详情页
  const doc1 = createMockDocument();
  const triggerBtn = createMockElement('button', doc1);
  triggerBtn.setAttribute('data-testid', 'open-settings-button');
  let triggerClicks = 0;
  triggerBtn.addEventListener('click', () => {
    triggerClicks++;
    attachNativeSettingsDialog(doc1, 'block');
  });
  doc1.body.appendChild(triggerBtn);

  const host1 = createHostRuntime({
    document: doc1,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'demo.alpha': {
        id: 'demo.alpha',
        displayName: 'Alpha 插件',
        description: '测试详情直跳',
        version: '1.2.0',
        trustLevel: 'T0',
        settingsSchema: {
          title: 'Alpha 设置',
          fields: [{ key: 'enabledFeature', type: 'boolean', default: true, label: '启用特性' }]
        },
        settingsValues: { enabledFeature: true }
      }
    }
  });

  try {
    const res1 = await host1.openSettings({ tab: 'plugins', pluginId: 'demo.alpha' });
    assert.equal(triggerClicks, 1);
    assert.equal(res1.mode, 'native');
    const mountShadow = doc1.querySelector('#agy-native-settings-mount').shadowRoot;
    assert.ok(mountShadow.querySelector('#agy-detail-back-btn'));
    assert.equal(mountShadow.querySelector('#agy-plugin-detail-header').getAttribute('data-detail-plugin-id'), 'demo.alpha');
  } finally {
    await host1.dispose();
  }

  // 2. 无原生弹窗且无 openTrigger -> 自动降级居中独立模态窗，支持 Esc 与遮罩点击关闭
  const doc2 = createMockDocument();
  const host2 = createHostRuntime({
    document: doc2,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    anchorsRegistry: buildFullAnchorsRegistry()
  });

  try {
    const res2 = await host2.openSettings({ tab: 'appearance' });
    assert.equal(res2.mode, 'modal');
    assert.equal(host2.getSettingsMode(), 'modal');

    const shadow = doc2.getElementById('agy-daddy-host').shadowRoot;
    const backdrop = shadow.querySelector('#agy-settings-modal-backdrop');
    assert.equal(backdrop.hidden, false);
    assert.equal(shadow.querySelector('#agy-settings-close-btn').hidden, false);
    assert.ok(shadow.querySelector('#agy-topbar-layout-card'));
    assert.equal(shadow.querySelector('#agy-theme-settings-card'), null);

    // Esc 关闭
    doc2.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(host2.getSettingsMode(), 'closed');
    assert.equal(backdrop.hidden, true);

    // 重新打开后点击半透明遮罩关闭
    await host2.openSettings({ tab: 'plugins' });
    assert.equal(backdrop.hidden, false);
    backdrop.click();
    assert.equal(host2.getSettingsMode(), 'closed');
    assert.equal(backdrop.hidden, true);
  } finally {
    await host2.dispose();
  }
});

test('三段式下钻设置中心：实时搜索、5 类声明式表单控件校验、Action 命令调用与双端配置同步', async () => {
  const doc = createMockDocument();
  const nonce = 'test-settings-nonce-1';
  const pluginValues = {
    gatewayEnabled: true,
    mode: 'direct',
    gatewayPort: 18766,
    upstreamUrl: '',
    allowList: ['alpha.local']
  };
  const { calls, fetchFn } = createMockBridgeFetch({
    '/host/plugins': () => ({ ok: true, plugins: [], catalog: [] }),
    '/host/settings': (body) => {
      Object.assign(pluginValues, body.values || {});
      return { ok: true, values: { ...pluginValues }, changedKeys: Object.keys(body.values || {}) };
    },
    '/host/commands/run': (body) => ({
      ok: true,
      result: { ok: true, message: `Probed ${body.commandId}` }
    })
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19999,
    hostToken: 'secret-host-token',
    xworldNonce: nonce,
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'agy-daddy.proxy': {
        id: 'agy-daddy.proxy',
        displayName: '网络代理网关',
        description: '本地固定转发代理',
        version: '1.0.0',
        trustLevel: 'T0',
        permissions: ['net:listen', 'host:launch-args'],
        topbarUnits: [{ id: 'proxy-pill', order: 20 }],
        settingsSchema: {
          title: { 'zh-CN': '代理网关配置', en: 'Proxy Config' },
          fields: [
            { key: 'gatewayEnabled', type: 'boolean', default: true, label: { 'zh-CN': '启用代理网关', en: 'Enable Gateway' } },
            {
              key: 'mode',
              type: 'enum',
              default: 'direct',
              label: '转发模式',
              options: [
                { value: 'direct', label: { 'zh-CN': '直连模式', en: 'Direct' } },
                { value: 'upstream', label: { 'zh-CN': '上游代理', en: 'Upstream' } }
              ]
            },
            { key: 'gatewayPort', type: 'number', min: 1024, max: 65535, default: 18766, label: '本地端口' },
            { key: 'upstreamUrl', type: 'string', default: '', label: '上游地址' },
            { key: 'allowList', type: 'list', maxItems: 3, default: ['alpha.local'], label: '白名单域名' }
          ],
          actions: [
            { id: 'probe', command: 'proxy.probe', label: { 'zh-CN': '测试代理连通性', en: 'Test Proxy' } }
          ]
        },
        settingsValues: { ...pluginValues }
      },
      'agy-daddy.silent': {
        id: 'agy-daddy.silent',
        displayName: '静默辅助',
        description: '无顶栏胶囊插件',
        version: '1.0.0',
        trustLevel: 'T0',
        topbarUnits: [],
        settingsSchema: { fields: [{ key: 'silentFlag', type: 'boolean', default: false, label: '静默标记' }] },
        settingsValues: { silentFlag: false }
      }
    }
  });

  const xclient = createXworldClient(doc, nonce);
  try {
    const localChangeEvents = [];
    await host.mountPlugin('agy-daddy.proxy', {
      mount(ctx) {
        ctx.settings.onChange((vals, keys) => localChangeEvents.push({ vals, keys }));
      }
    });

    await host.openSettings({ tab: 'plugins' });
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 仅含 topbarUnits 的插件显示 📌 按钮
    assert.ok(shadow.querySelector('[data-plugin-pin="agy-daddy.proxy"]'));
    assert.equal(shadow.querySelector('[data-plugin-pin="agy-daddy.silent"]'), null);

    // 实时搜索跨字段名筛选（搜索「白名单」只匹配 proxy）
    const searchEl = shadow.querySelector('#agy-settings-search');
    searchEl.value = '白名单';
    searchEl.dispatchEvent({ type: 'input', target: searchEl });
    assert.ok(shadow.querySelector('[data-plugin-id="agy-daddy.proxy"]'));
    assert.equal(shadow.querySelector('[data-plugin-id="agy-daddy.silent"]'), null);

    // 清空搜索并下钻进入 proxy 二级详情页
    searchEl.value = '';
    searchEl.dispatchEvent({ type: 'input', target: searchEl });
    shadow.querySelector('[data-plugin-detail="agy-daddy.proxy"]').click();
    assert.ok(shadow.querySelector('#agy-detail-back-btn'));
    assert.ok(shadow.querySelector('#agy-detail-health-summary'));

    // 1. boolean 切换
    const boolInput = shadow.querySelector('[data-setting-key="gatewayEnabled"]');
    boolInput.checked = false;
    boolInput.dispatchEvent({ type: 'change', target: boolInput });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.getPluginSettings('agy-daddy.proxy').gatewayEnabled, false);

    // 2. enum 下拉切换
    const enumSel = shadow.querySelector('[data-setting-key="mode"]');
    enumSel.value = 'upstream';
    enumSel.dispatchEvent({ type: 'change', target: enumSel });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.getPluginSettings('agy-daddy.proxy').mode, 'upstream');

    // 3. number min/max 校验（先填非法值 80 -> 显示错误且不发请求，再填合法值 18888 -> 成功保存）
    const beforeSettingsCalls = calls.filter((c) => c.path === '/host/settings').length;
    const numInput = shadow.querySelector('[data-setting-key="gatewayPort"]');
    numInput.value = '80';
    numInput.dispatchEvent({ type: 'change', target: numInput });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(shadow.querySelector('[data-field-error="gatewayPort"]'));
    assert.equal(calls.filter((c) => c.path === '/host/settings').length, beforeSettingsCalls);

    const numInput2 = shadow.querySelector('[data-setting-key="gatewayPort"]');
    numInput2.value = '18888';
    numInput2.dispatchEvent({ type: 'change', target: numInput2 });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(shadow.querySelector('[data-field-error="gatewayPort"]'), null);
    assert.equal(host.getPluginSettings('agy-daddy.proxy').gatewayPort, 18888);

    // 4. string 输入
    const strInput = shadow.querySelector('[data-setting-key="upstreamUrl"]');
    strInput.value = 'http://127.0.0.1:7890';
    strInput.dispatchEvent({ type: 'change', target: strInput });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.getPluginSettings('agy-daddy.proxy').upstreamUrl, 'http://127.0.0.1:7890');

    // 5. list 增删列表
    const listInput = shadow.querySelector('[data-list-input="allowList"]');
    listInput.value = 'beta.local';
    shadow.querySelector('[data-list-add="allowList"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(host.getPluginSettings('agy-daddy.proxy').allowList, ['alpha.local', 'beta.local']);

    shadow.querySelector('[data-list-remove="allowList:0"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(host.getPluginSettings('agy-daddy.proxy').allowList, ['beta.local']);

    // 校验已通过跨世界通道广播 settings.changed
    const xChanged = xclient.events.filter((e) => e.event === 'settings.changed' && e.pluginId === 'agy-daddy.proxy');
    assert.ok(xChanged.length >= 4);
    assert.equal(xChanged[xChanged.length - 1].values.gatewayPort, 18888);

    // 6. 声明式 Action 按钮 -> POST /host/commands/run
    const actBtn = shadow.querySelector('[data-schema-action="probe"]');
    assert.ok(actBtn);
    actBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    const cmdCall = calls.find((c) => c.path === '/host/commands/run');
    assert.ok(cmdCall);
    assert.equal(cmdCall.body.pluginId, 'agy-daddy.proxy');
    assert.equal(cmdCall.body.commandId, 'proxy.probe');
    assert.match(shadow.querySelector('#agy-manage-toast').textContent, /Probed proxy\.probe/);

    // 7. 外部 Node 端主动调用 api.notifyPluginSettingsChanged -> 同步双端
    host.notifyPluginSettingsChanged('agy-daddy.proxy', { ...pluginValues, upstreamUrl: 'socks5://127.0.0.1:1080' }, ['upstreamUrl']);
    assert.equal(host.getPluginSettings('agy-daddy.proxy').upstreamUrl, 'socks5://127.0.0.1:1080');
    assert.ok(localChangeEvents.some((e) => e.vals.upstreamUrl === 'socks5://127.0.0.1:1080'));
    assert.ok(xclient.events.some((e) => e.event === 'settings.changed' && e.values.upstreamUrl === 'socks5://127.0.0.1:1080'));
  } finally {
    xclient.dispose();
    await host.dispose();
  }
});

test('顶栏 Pin/Unpin、顺序调整、maxVisibleUnits 溢出菜单与 Popover 统一头部 ⚙ 直跳详情页', async () => {
  const doc = createMockDocument();
  const { calls, fetchFn } = createMockBridgeFetch({
    '/host/host-settings': (body) => ({ ok: true, values: body.values }),
    '/host/plugins': () => ({ ok: true, plugins: [], catalog: [] })
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19998,
    hostToken: 'secret-token',
    anchorsRegistry: buildFullAnchorsRegistry(),
    hostSettings: {
      themeMode: 'dark',
      heatPreset: 'purple',
      topbarPins: {},
      topbarOrder: [],
      maxVisibleUnits: 2
    },
    pluginMeta: {
      'p.one': { id: 'p.one', displayName: '插件一', topbarUnits: [{ id: 'u1' }] },
      'p.two': { id: 'p.two', displayName: '插件二', topbarUnits: [{ id: 'u2' }] },
      'p.three': { id: 'p.three', displayName: '插件三', topbarUnits: [{ id: 'u3' }] }
    }
  });

  try {
    let popCtrl = null;
    await host.mountPlugin('p.one', {
      mount(ctx) {
        ctx.topbar.registerUnit({ id: 'u1', order: 10, label: 'U1' });
        popCtrl = ctx.topbar.registerPopover({
          id: 'pop1',
          anchorId: 'u1',
          title: '插件一面板',
          render(bodyEl) {
            const inner = doc.createElement('div');
            inner.id = 'p1-business-body';
            inner.textContent = 'Live Stats';
            bodyEl.appendChild(inner);
          }
        });
      }
    });
    await host.mountPlugin('p.two', { mount(ctx) { ctx.topbar.registerUnit({ id: 'u2', order: 20, label: 'U2' }); } });
    await host.mountPlugin('p.three', { mount(ctx) { ctx.topbar.registerUnit({ id: 'u3', order: 30, label: 'U3' }); } });

    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    const barEl = shadow.querySelector('#agy-topbar-slots');
    const overflowBtn = shadow.querySelector('#agy-topbar-overflow-btn');
    const overflowList = shadow.querySelector('#agy-topbar-overflow-list');

    // maxVisibleUnits=2 -> 前 2 个平铺，第 3 个收进 ⋯ 溢出菜单且 slotSelector 仍可达
    const visibleUnitIds = barEl.children.filter((c) => c.getAttribute('data-unit-id')).map((c) => c.getAttribute('data-unit-id'));
    assert.deepEqual(visibleUnitIds, ['u1', 'u2']);
    assert.equal(overflowBtn.hidden, false);
    assert.equal(overflowBtn.getAttribute('data-overflow-count'), '1');
    assert.equal(overflowList.children.length, 1);
    assert.ok(shadow.querySelector('[data-agy-slot="unit:p.three:u3"]'));

    // 点击 ⋯ 展开溢出菜单，并校验统一头部（标题 + ⚙ + ✕）
    overflowBtn.click();
    const overflowMenu = shadow.querySelector('#agy-topbar-overflow-menu');
    assert.equal(overflowMenu.hidden, false);
    const ovActions = overflowMenu.querySelector('.ag-panel-head .ag-panel-actions');
    assert.ok(ovActions, 'Overflow menu head must use .ag-panel-actions');
    const ovGearBtn = ovActions.querySelector('.ag-popover-settings-btn[data-popover-settings="host"]');
    const ovCloseBtn = ovActions.querySelector('.ag-popover-close-btn[data-popover-close="__overflow__"]');
    assert.ok(ovGearBtn, 'Overflow menu must include settings button');
    assert.ok(ovCloseBtn, 'Overflow menu must include close button');

    // 点击溢出菜单右上角 ⚙ -> 关闭溢出菜单并打开外观设置页
    ovGearBtn.click();
    assert.equal(overflowMenu.hidden, true);
    assert.equal(host.getSettingsMode(), 'modal');
    shadow.querySelector('#agy-settings-close-btn').click();
    assert.equal(host.getSettingsMode(), 'closed');

    // 验证 Popover 统一包壳头部（标题 + ⚙ + ✕）与业务内容槽位
    popCtrl.toggle(true);
    const popEl = shadow.querySelector('[data-agy-popover="p.one:pop1"]');
    assert.equal(popEl.hidden, false);
    assert.equal(popEl.querySelector('.ag-panel-title').textContent, '插件一面板');
    assert.ok(popEl.querySelector('[data-agy-slot="popover:p.one:pop1"] #p1-business-body'));
    const gearBtn = popEl.querySelector('[data-popover-settings="p.one"]');
    assert.ok(gearBtn);
    assert.ok(popEl.querySelector('[data-popover-close="p.one:pop1"]'));

    // 点击 Popover 右上角 ⚙ -> 关闭 Popover 并直跳 p.one 插件详情页
    gearBtn.click();
    assert.equal(popEl.hidden, true);
    assert.equal(host.getSettingsMode(), 'modal');
    assert.equal(shadow.querySelector('#agy-plugin-detail-header').getAttribute('data-detail-plugin-id'), 'p.one');

    // 切到「外观与底座」测试胶囊名称展示插件名、文案“顶栏显示胶囊上限”、取消固定、上下调序与修改 maxVisibleUnits 并持久化至 /host/host-settings
    shadow.querySelector('#agy-tab-appearance').click();
    const layoutCard = shadow.querySelector('#agy-topbar-layout-card');
    assert.match(layoutCard.textContent, /顶栏显示胶囊上限/);
    assert.equal(layoutCard.textContent.includes('最大平铺胶囊数'), false);
    const orderRow1Name = shadow.querySelector('[data-order-unit="p.one:u1"]').querySelector('.ag-plugin-name');
    const orderRow2Name = shadow.querySelector('[data-order-unit="p.two:u2"]').querySelector('.ag-plugin-name');
    const orderRow3Name = shadow.querySelector('[data-order-unit="p.three:u3"]').querySelector('.ag-plugin-name');
    assert.equal(orderRow1Name.textContent, '插件一');
    assert.equal(orderRow2Name.textContent, '插件二');
    assert.equal(orderRow3Name.textContent, '插件三');

    // 验证胶囊动态更新 label 后，外观页列表仍展示插件名称而非具体内容
    shadow.querySelector('#agy-tab-plugins').click();
    await host.mountPlugin('p.one', { mount(ctx) { ctx.topbar.registerUnit({ id: 'u1', order: 10, label: '累计 4816.81M · $1306.95' }); } });
    shadow.querySelector('#agy-tab-appearance').click();
    assert.equal(shadow.querySelector('[data-order-unit="p.one:u1"]').querySelector('.ag-plugin-name').textContent, '插件一');

    shadow.querySelector('[data-order-pin="p.one:u1"]').click();
    const visibleAfterUnpin = barEl.children.filter((c) => c.getAttribute('data-unit-id')).map((c) => c.getAttribute('data-unit-id'));
    assert.deepEqual(visibleAfterUnpin, ['u2', 'u3']);

    // 已移除上下箭头按钮，统一使用拖拽手柄 + 整行拖拽调整顺序
    assert.equal(shadow.querySelector('[data-order-up]'), null);
    assert.equal(shadow.querySelector('[data-order-down]'), null);
    const orderRow2 = shadow.querySelector('[data-order-unit="p.two:u2"]');
    const orderRow3 = shadow.querySelector('[data-order-unit="p.three:u3"]');
    assert.equal(orderRow2.getAttribute('draggable'), 'true');
    assert.ok(orderRow2.querySelector('.ag-drag-handle'));

    // 将 u2 拖拽到 u3 之后，验证调序与持久化
    orderRow2.dispatchEvent({ type: 'dragstart', dataTransfer: { setData() {} } });
    assert.equal(orderRow2.getAttribute('data-dragging'), 'true');
    orderRow3.dispatchEvent({ type: 'dragover', preventDefault() {} });
    assert.equal(orderRow3.getAttribute('data-drop-position'), 'after');
    orderRow3.dispatchEvent({ type: 'drop', preventDefault() {}, dataTransfer: { getData: () => '1' } });
    const visibleAfterSwap = barEl.children.filter((c) => c.getAttribute('data-unit-id')).map((c) => c.getAttribute('data-unit-id'));
    assert.deepEqual(visibleAfterSwap, ['u3', 'u2']);

    // 筛选状态下禁用拖拽调整顺序，清空筛选后恢复
    const searchInput = shadow.querySelector('#agy-settings-search');
    searchInput.value = '插件二';
    searchInput.dispatchEvent({ type: 'input', target: searchInput });
    const filteredRow2 = shadow.querySelector('[data-order-unit="p.two:u2"]');
    assert.equal(filteredRow2.getAttribute('draggable'), 'false');
    assert.equal(filteredRow2.getAttribute('data-drag-disabled'), 'true');
    searchInput.value = '';
    searchInput.dispatchEvent({ type: 'input', target: searchInput });
    assert.equal(shadow.querySelector('[data-order-unit="p.two:u2"]').getAttribute('draggable'), 'true');

    // 修改 maxVisibleUnits 为 4 并把 u1 重新固定
    const maxInput = shadow.querySelector('#agy-max-visible-units');
    maxInput.value = '4';
    maxInput.dispatchEvent({ type: 'change', target: maxInput });
    shadow.querySelector('[data-order-pin="p.one:u1"]').click();
    assert.equal(overflowBtn.hidden, true);

    await new Promise((r) => setTimeout(r, 20));
    const hostSettingsCalls = calls.filter((c) => c.path === '/host/host-settings');
    assert.ok(hostSettingsCalls.length >= 3);
    assert.equal(hostSettingsCalls.every((c) => c.body.action === 'save'), true);
    assert.equal(host.getHostSettings().maxVisibleUnits, 4);
  } finally {
    await host.dispose();
  }
});

test('诊断分段：插件熔断解除、全量锚点健康矩阵与脱敏诊断包导出', async () => {
  const doc = createMockDocument();
  const { calls, fetchFn } = createMockBridgeFetch({
    '/host/diagnostics/export': () => ({ ok: true, path: '/tmp/agy-daddy-diagnostic-bundle.json' }),
    '/host/reload': () => ({ ok: true, plugins: [], catalog: [] })
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19997,
    hostToken: 'secret-token',
    anchorsRegistry: buildFullAnchorsRegistry()
  });

  try {
    // 触发 3 次崩溃使插件进入熔断态
    for (let i = 0; i < 3; i++) {
      await host.mountPlugin('crash.plugin', { mount() { throw new Error(`crash-${i}`); } });
    }
    assert.equal(host.getMetrics('crash.plugin').crashes, 3);

    await host.openSettings({ tab: 'diagnostics' });
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 1. 熔断徽章与一键解除熔断
    const resetBtn = shadow.querySelector('[data-reset-circuit="crash.plugin"]');
    assert.ok(resetBtn);
    resetBtn.click();
    assert.equal(host.getMetrics('crash.plugin').crashes, 0);
    await new Promise((r) => setTimeout(r, 30));

    // 2. 锚点健康矩阵覆盖全部 15 个锚点并正确区分命中/未命中
    const anchorCells = shadow.querySelectorAll('.ag-anchor-item');
    assert.equal(anchorCells.length, 15);
    assert.equal(shadow.querySelector('[data-anchor-name="composer.editor"]').getAttribute('data-anchor-matched'), 'true');
    assert.equal(shadow.querySelector('[data-anchor-name="settings.dialog"]').getAttribute('data-anchor-matched'), 'false');

    // 3. 导出脱敏诊断包
    shadow.querySelector('#agy-export-diagnostics-btn').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(calls.some((c) => c.path === '/host/diagnostics/export'));
    assert.match(shadow.querySelector('#agy-diagnostics-export-status').textContent, /agy-daddy-diagnostic-bundle\.json/);
  } finally {
    await host.dispose();
  }
});

test('跨世界通道 __agy_xworld_<nonce> 全量主世界响应与 dispose 零泄漏', async () => {
  const doc = createMockDocument();
  const nonce = 'xworld-full-test-999';
  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    xworldNonce: nonce,
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'iso.a': {
        id: 'iso.a',
        displayName: 'Iso A',
        settingsSchema: { fields: [{ key: 'flag', type: 'boolean', default: true, label: 'Flag' }] },
        settingsValues: { flag: true }
      }
    }
  });
  const xclient = createXworldClient(doc, nonce);

  try {
    // 1. topbar.registerUnit / updateUnit / unit.click / disposeUnit + SVG 安全过滤
    const uReg = await xclient.send({
      action: 'topbar.registerUnit',
      pluginId: 'iso.a',
      unit: {
        id: 'pill',
        order: 10,
        label: 'IsoPill',
        iconSvg: '<svg width="12" height="12"><circle cx="6" cy="6" r="4"/></svg>',
        badge: '3',
        tone: 'warn'
      }
    });
    assert.equal(uReg.ok, true);
    assert.equal(uReg.slotSelector, '[data-agy-slot="unit:iso.a:pill"]');
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    const unitBtn = shadow.querySelector(uReg.slotSelector);
    assert.ok(unitBtn);
    assert.equal(unitBtn.getAttribute('data-tone'), 'warn');
    assert.ok(unitBtn.querySelector('.ag-unit-icon')?.innerHTML.includes('<svg'));

    unitBtn.click();
    assert.ok(xclient.events.some((e) => e.event === 'unit.click' && e.pluginId === 'iso.a' && e.unitId === 'pill'));

    // 恶意 script SVG 被过滤掉
    await xclient.send({
      action: 'topbar.updateUnit',
      pluginId: 'iso.a',
      unitId: 'pill',
      patch: { label: 'Updated', iconSvg: '<svg onload="alert(1)"><script>x</script></svg>', badge: '9', tone: 'danger' }
    });
    assert.equal(unitBtn.getAttribute('data-tone'), 'danger');
    assert.equal(unitBtn.querySelector('.ag-unit-icon'), null);
    assert.match(unitBtn.textContent, /Updated/);

    // 2. topbar.registerPopover / togglePopover / popover.toggle
    const pReg = await xclient.send({
      action: 'topbar.registerPopover',
      pluginId: 'iso.a',
      popover: { id: 'card', anchorId: 'pill', title: 'Iso Card' }
    });
    assert.equal(pReg.slotSelector, '[data-agy-slot="popover:iso.a:card"]');
    assert.equal(pReg.panelSelector, '[data-agy-popover="iso.a:card"]');
    assert.ok(shadow.querySelector(pReg.slotSelector));
    const tog = await xclient.send({ action: 'topbar.togglePopover', pluginId: 'iso.a', popoverId: 'card', force: true });
    assert.equal(tog.open, true);
    assert.ok(xclient.events.some((e) => e.event === 'popover.toggle' && e.popoverId === 'card' && e.open === true));

    // 3. styles.inject (document & shadow) & styles.dispose
    const stDoc = await xclient.send({ action: 'styles.inject', pluginId: 'iso.a', styleId: 's1', css: '.a{color:red}', scope: 'document' });
    assert.equal(stDoc.ok, true);
    assert.ok(doc.head.querySelector('[data-agy-style="iso.a"]'));
    const stSh = await xclient.send({ action: 'styles.inject', pluginId: 'iso.a', styleId: 's2', css: '.b{opacity:1}', scope: 'shadow' });
    assert.equal(stSh.ok, true);
    assert.ok(shadow.querySelector('[data-agy-style="iso.a"]'));

    // 4. surfaces.subscribe / provide / revoke -> surface.changed
    const subSurf = await xclient.send({ action: 'surfaces.subscribe', pluginId: 'iso.b', surfaceName: 'chat.search' });
    assert.equal(subSurf.available, false);
    const surfEl = createMockElement('div', doc);
    surfEl.setAttribute('data-agy-surface', 'chat.search');
    doc.body.appendChild(surfEl);
    await xclient.send({ action: 'surfaces.provide', pluginId: 'iso.a', surfaceName: 'chat.search' });
    assert.ok(xclient.events.some((e) => e.event === 'surface.changed' && e.pluginId === 'iso.b' && e.surfaceName === 'chat.search' && e.available === true));
    await xclient.send({ action: 'surfaces.revoke', pluginId: 'iso.a', surfaceName: 'chat.search' });
    assert.ok(xclient.events.some((e) => e.event === 'surface.changed' && e.pluginId === 'iso.b' && e.surfaceName === 'chat.search' && e.available === false));

    // 5. settings.get / update / open
    const curSettings = await xclient.send({ action: 'settings.get', pluginId: 'iso.a' });
    assert.equal(curSettings.flag, true);
    const updSettings = await xclient.send({ action: 'settings.update', pluginId: 'iso.a', values: { flag: false }, patch: { flag: false } });
    assert.equal(updSettings.ok, true);
    assert.equal(updSettings.values.flag, false);
    const opened = await xclient.send({ action: 'settings.open', pluginId: 'iso.a', tab: 'plugins' });
    assert.equal(opened.ok, true);
    assert.equal(host.getSettingsMode(), 'modal');

    // 6. events.subscribe / emit / unsubscribe
    await xclient.send({ action: 'events.subscribe', pluginId: 'iso.b', topic: 'demo:ping@1' });
    const emRes = await xclient.send({ action: 'events.emit', pluginId: 'iso.a', topic: 'demo:ping@1', payload: { n: 42 } });
    assert.equal(emRes.delivered, 1);
    assert.ok(xclient.events.some((e) => e.event === 'bus.event' && e.pluginId === 'iso.b' && e.topic === 'demo:ping@1' && e.payload.n === 42));
    await xclient.send({ action: 'events.unsubscribe', pluginId: 'iso.b', topic: 'demo:ping@1' });

    // 7. state.set / get / subscribe (持续推送 + replay) / unsubscribe
    await xclient.send({ action: 'state.set', pluginId: 'iso.a', key: 'state:demo.x@1', value: { v: 1 } });
    const gotSt = await xclient.send({ action: 'state.get', pluginId: 'iso.b', key: 'state:demo.x@1' });
    assert.equal(gotSt.value.v, 1);
    await xclient.send({ action: 'state.subscribe', pluginId: 'iso.b', key: 'state:demo.x@1' });
    assert.ok(xclient.events.some((e) => e.event === 'bus.state' && e.pluginId === 'iso.b' && e.replay === true && e.value.v === 1));
    await xclient.send({ action: 'state.set', pluginId: 'iso.a', key: 'state:demo.x@1', value: { v: 2 } });
    assert.ok(xclient.events.some((e) => e.event === 'bus.state' && e.pluginId === 'iso.b' && e.replay === false && e.version === 2 && e.value.v === 2));
    await xclient.send({ action: 'state.unsubscribe', pluginId: 'iso.b', key: 'state:demo.x@1' });

    // 8. services.provide / service.invoke / service.reply / services.call
    await xclient.send({ action: 'services.provide', pluginId: 'iso.a', name: 'calc', methods: ['add'] });
    const invokeHandler = (ev) => {
      const d = ev?.detail;
      if (d?.direction === 'to-isolated' && d.event === 'service.invoke' && d.service === 'calc') {
        const sum = Number(d.args[0]) + Number(d.args[1]);
        doc.dispatchEvent({
          type: xclient.channelName,
          detail: { direction: 'to-main', action: 'service.reply', pluginId: 'iso.a', invokeId: d.invokeId, ok: true, value: { sum } }
        });
      }
    };
    doc.addEventListener(xclient.channelName, invokeHandler);
    const callRes = await xclient.send({ action: 'services.call', pluginId: 'iso.b', service: 'calc', method: 'add', args: [7, 8] });
    doc.removeEventListener(xclient.channelName, invokeHandler);
    assert.deepEqual(callRes, { sum: 15 });

    // 9. commands.execute (本地已注册命令)
    await host.mountPlugin('cmd.host', {
      mount(ctx) {
        ctx.commands.register('demo.echo', (x) => ({ echoed: x }));
      }
    });
    const cmdRes = await xclient.send({ action: 'commands.execute', pluginId: 'iso.a', commandId: 'demo.echo', args: ['hello'] });
    assert.deepEqual(cmdRes, { ok: true, result: { echoed: 'hello' } });

    // 10. plugin.dispose 自动清理全部单元、浮窗、样式、服务、订阅
    await xclient.send({ action: 'plugin.dispose', pluginId: 'iso.a' });
    assert.deepEqual(host.getPluginUsageStats('iso.a'), { domNodes: 0, observers: 0, timers: 0, events: 0, services: 0 });
    assert.equal(doc.head.querySelector('[data-agy-style="iso.a"]'), null);
    assert.equal(shadow.querySelector('[data-agy-style="iso.a"]'), null);
    assert.equal(shadow.querySelector('[data-agy-slot="unit:iso.a:pill"]'), null);
    assert.equal(shadow.querySelector('[data-agy-popover="iso.a:card"]'), null);
  } finally {
    xclient.dispose();
    await host.dispose();
  }
});

test('审计回归：解除熔断传 resetCircuit 不吞错、topbarPins 显式 null 清子键、在线修改不重复 onChange、settings.open 兼容双入参', async () => {
  // 1. 解除熔断：成功传 resetCircuit:true 并应用 payload；失败暴露错误 toast 不吞错
  {
    const doc = createMockDocument();
    let failNextReload = false;
    const { calls, fetchFn } = createMockBridgeFetch({
      '/host/reload': (body) => {
        if (failNextReload) return { ok: false, httpOk: false, httpStatus: 500, error: 'RELOAD_BOOM' };
        return {
          ok: true,
          plugins: [{ id: body.pluginId, displayName: 'Recovered', enabled: true, active: true, health: { crashesInWindow: 0, circuitOpen: false } }],
          catalog: []
        };
      }
    });
    const host = createHostRuntime({
      document: doc,
      window: { location: { href: 'https://127.0.0.1:51410/' } },
      fetch: fetchFn,
      bridgePort: 19991,
      hostToken: 'secret-token',
      anchorsRegistry: buildFullAnchorsRegistry()
    });
    try {
      for (let i = 0; i < 3; i++) {
        await host.mountPlugin('cb.plugin', { mount() { throw new Error('boom'); } });
      }
      await host.openSettings({ tab: 'diagnostics' });
      const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
      shadow.querySelector('[data-reset-circuit="cb.plugin"]').click();
      await new Promise((r) => setTimeout(r, 30));

      const reloadCall = calls.find((c) => c.path === '/host/reload');
      assert.ok(reloadCall);
      assert.equal(reloadCall.body.pluginId, 'cb.plugin');
      assert.equal(reloadCall.body.resetCircuit, true);
      assert.match(shadow.querySelector('#agy-manage-toast').textContent, /已解除 cb\.plugin 熔断/);

      // 再次触发熔断并模拟 /host/reload 失败 -> 必须展示 error toast 而非静默吞错
      for (let i = 0; i < 3; i++) {
        await host.mountPlugin('cb.fail', { mount() { throw new Error('boom2'); } });
      }
      failNextReload = true;
      await host.openSettings({ tab: 'diagnostics' });
      shadow.querySelector('[data-reset-circuit="cb.fail"]').click();
      await new Promise((r) => setTimeout(r, 30));
      const errToast = shadow.querySelector('#agy-manage-toast');
      assert.equal(errToast.getAttribute('data-tone'), 'error');
      assert.match(errToast.textContent, /RELOAD_BOOM/);
    } finally {
      await host.dispose();
    }
  }

  // 2. topbarPins 持久化漂移回归：单元级取消固定后，插件级重新固定必须显式传 null 清除 `${pluginId}:*` 旧键
  {
    const doc = createMockDocument();
    const { calls, fetchFn } = createMockBridgeFetch({
      '/host/host-settings': (body) => ({ ok: true, values: body.values }),
      '/host/plugins': () => ({ ok: true, plugins: [], catalog: [] })
    });
    const host = createHostRuntime({
      document: doc,
      window: { location: { href: 'https://127.0.0.1:51410/' } },
      fetch: fetchFn,
      bridgePort: 19992,
      hostToken: 'secret-token',
      anchorsRegistry: buildFullAnchorsRegistry(),
      pluginMeta: {
        'pkg.demo': { id: 'pkg.demo', displayName: 'Demo', topbarUnits: [{ id: 'u1' }] }
      }
    });
    try {
      await host.mountPlugin('pkg.demo', {
        mount(ctx) { ctx.topbar.registerUnit({ id: 'u1', order: 10, label: 'U1' }); }
      });
      await host.openSettings({ tab: 'appearance' });
      const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
      // 单元级取消固定 -> topbarPins['pkg.demo:u1'] = false
      shadow.querySelector('[data-order-pin="pkg.demo:u1"]').click();
      assert.equal(host.getHostSettings().topbarPins['pkg.demo:u1'], false);

      // 切回插件列表点插件级 📌 重新固定 -> 发往 /host/host-settings 的 patch 必须含 'pkg.demo': true 且 'pkg.demo:u1': null
      shadow.querySelector('#agy-tab-plugins').click();
      await new Promise((r) => setTimeout(r, 20));
      shadow.querySelector('[data-plugin-pin="pkg.demo"]').click();
      await new Promise((r) => setTimeout(r, 20));

      const pinCalls = calls.filter((c) => c.path === '/host/host-settings' && c.body?.values?.topbarPins);
      const lastPatch = pinCalls[pinCalls.length - 1].body.values.topbarPins;
      assert.equal(lastPatch['pkg.demo'], true);
      assert.equal(lastPatch['pkg.demo:u1'], null);
      // 本地状态不残留 null 键
      assert.equal(host.getHostSettings().topbarPins['pkg.demo'], true);
      assert.equal('pkg.demo:u1' in host.getHostSettings().topbarPins, false);
    } finally {
      await host.dispose();
    }
  }

  // 3. 在线 CDP 通知去重：daemon 返回 rendererNotified: 1 时，ctx.settings.onChange 与 xworld settings.changed 仅触发 1 次
  {
    const doc = createMockDocument();
    const nonce = 'dedup-onchange-nonce';
    let hostRef = null;
    const { fetchFn } = createMockBridgeFetch({
      '/host/settings': (body) => {
        const nextValues = { enabled: body.values.enabled };
        // 模拟 Node daemon.js 通过 CDP injector 主动下发通知
        hostRef.notifyPluginSettingsChanged(body.pluginId, nextValues, ['enabled']);
        return { ok: true, values: nextValues, changedKeys: ['enabled'], rendererNotified: 1 };
      }
    });
    const host = createHostRuntime({
      document: doc,
      window: { location: { href: 'https://127.0.0.1:51410/' } },
      fetch: fetchFn,
      bridgePort: 19993,
      hostToken: 'secret-token',
      xworldNonce: nonce,
      anchorsRegistry: buildFullAnchorsRegistry(),
      pluginMeta: {
        'dedup.p': {
          id: 'dedup.p',
          displayName: 'Dedup',
          settingsSchema: { fields: [{ key: 'enabled', type: 'boolean', default: true, label: 'Enabled' }] },
          settingsValues: { enabled: true }
        }
      }
    });
    hostRef = host;
    const xclient = createXworldClient(doc, nonce);
    try {
      let localCalls = 0;
      let pluginCtx = null;
      await host.mountPlugin('dedup.p', {
        mount(ctx) {
          pluginCtx = ctx;
          ctx.settings.onChange(() => { localCalls++; });
        }
      });
      await pluginCtx.settings.update({ enabled: false });
      assert.equal(localCalls, 1);
      const xEvents = xclient.events.filter((e) => e.event === 'settings.changed' && e.pluginId === 'dedup.p');
      assert.equal(xEvents.length, 1);
      assert.equal(host.getPluginSettings('dedup.p').enabled, false);
    } finally {
      xclient.dispose();
      await host.dispose();
    }
  }

  // 4. ctx.settings.open 兼容 string 与 { tab, pluginId } 两种入参（主世界 + 跨世界）
  {
    const doc = createMockDocument();
    const nonce = 'settings-open-compat-nonce';
    const host = createHostRuntime({
      document: doc,
      window: { location: { href: 'https://127.0.0.1:51410/' } },
      xworldNonce: nonce,
      anchorsRegistry: buildFullAnchorsRegistry(),
      pluginMeta: {
        'open.a': { id: 'open.a', displayName: 'Open A' },
        'open.b': { id: 'open.b', displayName: 'Open B' }
      }
    });
    const xclient = createXworldClient(doc, nonce);
    try {
      let ctxA = null;
      await host.mountPlugin('open.a', { mount(ctx) { ctxA = ctx; } });
      const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

      const r1 = await ctxA.settings.open({ tab: 'appearance' });
      assert.equal(r1.tab, 'appearance');
      assert.ok(shadow.querySelector('#agy-topbar-layout-card'));
      assert.equal(shadow.querySelector('#agy-theme-settings-card'), null);

      const r2 = await ctxA.settings.open('diagnostics');
      assert.equal(r2.tab, 'plugins');
      assert.ok(shadow.querySelector('#agy-anchor-health-card'));
      assert.equal(shadow.querySelector('#agy-diagnostics-detail-body').hidden, false);

      const r3 = await ctxA.settings.open({ tab: 'plugins', pluginId: 'open.b' });
      assert.equal(r3.tab, 'plugins');
      assert.equal(r3.pluginId, 'open.b');
      assert.equal(shadow.querySelector('#agy-plugin-detail-header').getAttribute('data-detail-plugin-id'), 'open.b');

      const r4 = await xclient.send({ action: 'settings.open', pluginId: 'open.a', tab: 'appearance' });
      assert.equal(r4.tab, 'appearance');

      const r5 = await xclient.send({ action: 'settings.open', pluginId: 'open.a', tab: 'plugins', targetPluginId: 'open.b' });
      assert.equal(r5.tab, 'plugins');
      assert.equal(r5.pluginId, 'open.b');
    } finally {
      xclient.dispose();
      await host.dispose();
    }
  }
});

test('适配 Antigravity 2.x 真实设置弹窗分栏结构（settings-sidebar + 无 nav/main + settings-button）', async () => {
  const { loadAnchorsRegistry, buildResolvedAnchorsMap } = require('../src/core/anchors');
  const resolvedAnchors = buildResolvedAnchorsMap(loadAnchorsRegistry(), '2.33.0');
  const doc = createMockDocument();

  // 1. 真实 settings-button 触发按钮
  const openBtn = createMockElement('button', doc);
  openBtn.setAttribute('data-testid', 'settings-button');
  openBtn.textContent = '设置';
  doc.body.appendChild(openBtn);

  // 2. 真实 Antigravity 2.x 设置分栏 DOM（外层无 role="dialog"，左侧 data-testid="settings-sidebar"，右侧 .overflow-auto，中间有 resizer）
  const modalWrap = createMockElement('div', doc);
  modalWrap.className = 'relative w-full h-full flex flex-col overflow-hidden';

  const splitRow = createMockElement('div', doc);
  splitRow.className = 'flex-1 min-h-0 w-full relative flex';

  // 左栏 settings-sidebar
  const sidebar = createMockElement('div', doc);
  sidebar.className = 'h-full w-full flex flex-col bg-sidebar';
  sidebar.setAttribute('data-testid', 'settings-sidebar');

  const scrollList = createMockElement('div', doc);
  scrollList.className = 'flex-1 flex flex-col gap-1 py-3 overflow-y-auto';

  const settingsHead = createMockElement('div', doc);
  settingsHead.className = 'px-4';
  settingsHead.textContent = 'Settings';
  scrollList.appendChild(settingsHead);

  const settingsGroup = createMockElement('div', doc);
  settingsGroup.className = 'flex flex-col gap-0.5';
  const generalRow = createMockElement('div', doc);
  generalRow.className = 'relative group/nav-item mx-2';
  const generalBtn = createMockElement('button', doc);
  generalBtn.setAttribute('data-testid', 'settings-nav-item-General');
  generalBtn.textContent = 'General';
  generalRow.appendChild(generalBtn);
  settingsGroup.appendChild(generalRow);
  scrollList.appendChild(settingsGroup);

  const projectsHead = createMockElement('div', doc);
  projectsHead.className = 'px-4 mt-2';
  projectsHead.textContent = 'Projects';
  scrollList.appendChild(projectsHead);

  const spacer = createMockElement('div', doc);
  spacer.className = 'flex-1';
  scrollList.appendChild(spacer);

  const feedbackRow = createMockElement('div', doc);
  feedbackRow.className = 'relative group/nav-item mx-2';
  const feedbackBtn = createMockElement('button', doc);
  feedbackBtn.setAttribute('data-testid', 'settings-nav-item-Provide Feedback');
  feedbackBtn.textContent = 'Give Feedback';
  feedbackRow.appendChild(feedbackBtn);
  scrollList.appendChild(feedbackRow);

  const accountFooter = createMockElement('div', doc);
  accountFooter.className = 'flex flex-col border-t py-2';
  accountFooter.textContent = 'Hubert Ai';

  sidebar.appendChild(scrollList);
  sidebar.appendChild(accountFooter);

  // 分割线 resizer（空叶子节点，不应被误识别为 contentEl）
  const resizer = createMockElement('div', doc);
  resizer.className = 'w-px bg-border cursor-col-resize';

  // 右栏容器（外层 flex-col，内部 .overflow-auto 为 React 设置正文滚动区）
  const rightPane = createMockElement('div', doc);
  rightPane.className = 'relative w-full h-full min-h-0 flex-grow flex flex-col';
  const scrollContent = createMockElement('div', doc);
  scrollContent.className = 'flex w-full h-full overflow-auto min-h-0';
  scrollContent.style.setProperty('display', 'flex');
  const reactInner = createMockElement('div', doc);
  reactInner.className = 'grow w-full';
  reactInner.textContent = 'General Interface Layout';
  scrollContent.appendChild(reactInner);
  rightPane.appendChild(scrollContent);

  splitRow.appendChild(sidebar);
  splitRow.appendChild(resizer);
  splitRow.appendChild(rightPane);
  modalWrap.appendChild(splitRow);

  openBtn.addEventListener('click', () => {
    doc.body.appendChild(modalWrap);
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    anchorsRegistry: resolvedAnchors,
    pluginMeta: {
      'agy-daddy.proxy': { id: 'agy-daddy.proxy', displayName: '代理网关', version: '1.0.0', trustLevel: 'T0' }
    }
  });

  try {
    // 先初始化底座壳与全局触发监听，模拟用户直接点击左下角 settings-button（不调 openSettings）
    await host.mountPlugin('noop.boot', {});
    openBtn.click();
    doc.dispatchEvent({ type: 'click', target: openBtn });
    await new Promise((r) => setTimeout(r, 50));

    // 验证捕获点击钩子自动完成注入，且 Agy-Daddy 插在 Projects 标题之前（紧随 Settings 组下方），且无紫点
    const projectsIdx = scrollList.children.indexOf(projectsHead);
    const wrapIdx = scrollList.children.findIndex((c) => c.getAttribute?.('data-agy-native-nav-wrap') === 'true');
    assert.ok(wrapIdx >= 2 && wrapIdx < projectsIdx, `expected wrapIdx (${wrapIdx}) before projectsIdx (${projectsIdx})`);
    const agyNavBtn = scrollList.querySelector('[data-agy-native-nav="true"]');
    assert.ok(agyNavBtn);
    assert.equal(scrollList.querySelector('[data-agy-native-nav="true"] .ag-native-nav-dot'), null);

    // 再通过 openSettings 直跳具体插件详情页
    const openRes = await host.openSettings({ tab: 'plugins', pluginId: 'agy-daddy.proxy' });
    assert.equal(openRes.mode, 'native');
    assert.equal(host.getSettingsMode(), 'native');
    assert.equal(sidebar.getAttribute('data-agy-nav-active'), 'true');
    assert.equal(agyNavBtn.getAttribute('data-active'), 'true');

    // 仅隐藏 React 的 scrollContent（保留 reactInner 不变），同级挂载 #agy-native-settings-mount，并隐藏重复关闭按钮
    assert.equal(scrollContent.style.getPropertyValue('display'), 'none');
    assert.equal(scrollContent.children.length, 1);
    assert.equal(scrollContent.children[0], reactInner);
    const mountEl = rightPane.querySelector('#agy-native-settings-mount');
    assert.ok(mountEl);
    assert.equal(mountEl.hidden, false);
    assert.equal(mountEl.shadowRoot.querySelector('#agy-settings-close-btn').hidden, true);
    assert.equal(mountEl.shadowRoot.querySelector('#agy-settings-tab-bar').hidden, true);
    assert.equal(mountEl.shadowRoot.querySelector('#agy-settings-search-wrap').hidden, true);
    assert.equal(mountEl.shadowRoot.querySelector('#agy-settings-topbar').hidden, true);
    assert.equal(mountEl.shadowRoot.querySelector('#agy-plugin-detail-header').getAttribute('data-detail-plugin-id'), 'agy-daddy.proxy');
    mountEl.shadowRoot.querySelector('#agy-detail-back-btn').click();
    assert.equal(mountEl.shadowRoot.querySelector('#agy-settings-tab-bar').hidden, false);
    assert.equal(mountEl.shadowRoot.querySelector('#agy-settings-search-wrap').hidden, false);
    assert.equal(mountEl.shadowRoot.querySelector('#agy-settings-topbar').hidden, false);

    // 点回原生 General 菜单 -> 无损恢复 scrollContent 原 display，并清除 data-agy-nav-active 恢复原生高亮
    generalBtn.click();
    assert.equal(host.getSettingsMode(), 'closed');
    assert.equal(sidebar.getAttribute('data-agy-nav-active'), null);
    assert.equal(agyNavBtn.getAttribute('data-active'), 'false');
    assert.equal(scrollContent.style.getPropertyValue('display'), 'flex');
    assert.equal(mountEl.hidden, true);

    // 再次激活后关闭原生弹窗 -> 自动清除 data-agy-nav-active
    agyNavBtn.click();
    assert.equal(sidebar.getAttribute('data-agy-nav-active'), 'true');
    modalWrap.remove();
    assert.equal(host.syncNativeSettings(), false);
    assert.equal(sidebar.getAttribute('data-agy-nav-active'), null);
  } finally {
    await host.dispose();
  }
});

test('设置页 Antigravity 交互对齐：页头下钻切换、无 emoji 矢量图标、可关闭与跨页自动清理提示条、全标签实时检索', async () => {
  const doc = createMockDocument();
  const { fetchFn } = createMockBridgeFetch({
    '/host/plugins': () => ({ ok: true, plugins: [], catalog: [] }),
    '/host/diagnostics/export': () => ({ ok: true, path: '/tmp/diag.json' })
  });
  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19995,
    hostToken: 'secret-token',
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'agy-daddy.proxy': {
        id: 'agy-daddy.proxy',
        displayName: '免重启网络代理网关',
        description: '本地固定转发代理',
        version: '1.0.0',
        trustLevel: 'T0',
        topbarUnits: [{ id: 'proxy' }]
      },
      'agy-daddy.cli': {
        id: 'agy-daddy.cli',
        displayName: 'CLI 终端启动器',
        version: '1.0.0',
        trustLevel: 'T0',
        topbarUnits: [{ id: 'cli' }]
      }
    }
  });

  try {
    await host.mountPlugin('agy-daddy.proxy', { mount(ctx) { ctx.topbar.registerUnit({ id: 'proxy', order: 10, label: 'Proxy' }); } });
    await host.mountPlugin('agy-daddy.cli', { mount(ctx) { ctx.topbar.registerUnit({ id: 'cli', order: 20, label: 'CLI' }); } });

    await host.openSettings({ tab: 'plugins' });
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 1. 顶层页头显示 Agy-Daddy，列表置顶且 Pin 按钮使用矢量 SVG 而非 📌 emoji
    const hero = shadow.querySelector('#agy-settings-hero');
    assert.ok(hero);
    assert.equal(hero.hidden, false);
    assert.equal(shadow.querySelector('#agy-settings-page-title').textContent, 'Agy-Daddy');
    const pinBtn = shadow.querySelector('[data-plugin-pin="agy-daddy.proxy"]');
    assert.ok(pinBtn);
    assert.equal(pinBtn.textContent.includes('📌'), false);
    assert.ok(pinBtn.querySelector('.ag-svg-icon')?.innerHTML.includes('<svg'));

    // 2. 键盘 Enter 下钻进入详情页 -> 隐藏外层 hero、tab 切换器与搜索栏，保留模态窗关闭按钮；返回列表后恢复
    const mainRow = shadow.querySelector('[data-plugin-open-detail="agy-daddy.proxy"]');
    mainRow.dispatchEvent({ type: 'keydown', key: 'Enter' });
    assert.equal(hero.hidden, true);
    assert.equal(shadow.querySelector('#agy-settings-tab-bar').hidden, true);
    assert.equal(shadow.querySelector('#agy-settings-search-wrap').hidden, true);
    assert.equal(shadow.querySelector('#agy-settings-topbar').hidden, false);
    assert.equal(shadow.querySelector('#agy-settings-close-btn').hidden, false);
    assert.equal(shadow.querySelector('#agy-plugin-detail-header').getAttribute('data-detail-plugin-id'), 'agy-daddy.proxy');
    shadow.querySelector('#agy-detail-back-btn').click();
    assert.equal(hero.hidden, false);
    assert.equal(shadow.querySelector('#agy-settings-tab-bar').hidden, false);
    assert.equal(shadow.querySelector('#agy-settings-search-wrap').hidden, false);

    // 3. 搜索清空按钮 + 跨标签筛选（底座与顶栏 / 诊断）
    const searchEl = shadow.querySelector('#agy-settings-search');
    const clearBtn = shadow.querySelector('#agy-settings-search-clear');
    assert.equal(clearBtn.hidden, true);
    searchEl.value = 'proxy';
    searchEl.dispatchEvent({ type: 'input', target: searchEl });
    assert.equal(clearBtn.hidden, false);

    shadow.querySelector('#agy-tab-appearance').click();
    assert.ok(shadow.querySelector('[data-order-unit="agy-daddy.proxy:proxy"]'));
    assert.equal(shadow.querySelector('[data-order-unit="agy-daddy.cli:cli"]'), null);

    clearBtn.click();
    assert.equal(searchEl.value, '');
    assert.equal(clearBtn.hidden, true);
    assert.ok(shadow.querySelector('[data-order-unit="agy-daddy.cli:cli"]'));

    // 4. 切回通用页查看底部运行与诊断区：默认折叠明细，点击展开明细、导出产生可关闭 toast，且切换至外观再切回时自动清理陈旧 info 提示
    shadow.querySelector('#agy-tab-plugins').click();
    await new Promise((r) => setTimeout(r, 20));
    const diagBody = shadow.querySelector('#agy-diagnostics-detail-body');
    assert.equal(diagBody.hidden, true);
    shadow.querySelector('#agy-diagnostics-detail-toggle').click();
    assert.equal(shadow.querySelector('#agy-diagnostics-detail-body').hidden, false);

    shadow.querySelector('#agy-export-diagnostics-btn').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(shadow.querySelector('#agy-manage-toast'));
    assert.ok(shadow.querySelector('#agy-manage-toast-dismiss'));

    shadow.querySelector('#agy-tab-appearance').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(shadow.querySelector('#agy-manage-toast'), null);

    // 手动关闭 toast 同样生效
    shadow.querySelector('#agy-tab-plugins').click();
    await new Promise((r) => setTimeout(r, 20));
    shadow.querySelector('#agy-export-diagnostics-btn').click();
    await new Promise((r) => setTimeout(r, 30));
    shadow.querySelector('#agy-manage-toast-dismiss').click();
    assert.equal(shadow.querySelector('#agy-manage-toast'), null);

    // 5. 市场预览 3 卡 + 「更多」下钻市场全量视图
    const previewGrid = shadow.querySelector('#agy-plugin-marketplace-preview .ag-market-grid');
    assert.ok(previewGrid);
    assert.equal(previewGrid.children.length, 2);
    shadow.querySelector('#agy-marketplace-more-btn').click();
    assert.equal(hero.hidden, true);
    assert.ok(shadow.querySelector('#agy-marketplace-full-grid'));
    shadow.querySelector('#agy-marketplace-back-btn').click();
    assert.equal(hero.hidden, false);
  } finally {
    await host.dispose();
  }
});

test('插件设置分组渲染 (group / placeholder / unit) 与 Popover 矢量图标页头', async () => {
  const doc = createMockDocument();
  const { fetchFn } = createMockBridgeFetch({
    '/host/plugins': () => ({ ok: true, plugins: [], catalog: [] })
  });
  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19996,
    hostToken: 'secret-token',
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'agy-daddy.grouped': {
        id: 'agy-daddy.grouped',
        displayName: '分组配置测试插件',
        description: '用于验证分组卡片、placeholder、unit 与 Popover SVG 页头',
        version: '1.0.0',
        trustLevel: 'T0',
        topbarUnits: [{ id: 'gunit' }],
        settingsSchema: {
          title: { 'zh-CN': '分组插件配置' },
          fields: [
            {
              key: 'port',
              type: 'number',
              min: 1024,
              max: 65535,
              default: 18766,
              group: { 'zh-CN': '网络与端口' },
              unit: { 'zh-CN': '端口' },
              placeholder: '18766',
              label: { 'zh-CN': '监听端口' }
            },
            {
              key: 'upstream',
              type: 'string',
              default: '',
              group: { 'zh-CN': '上游规则' },
              placeholder: 'http://127.0.0.1:7890',
              label: { 'zh-CN': '上游地址' }
            }
          ]
        }
      }
    }
  });

  try {
    await host.mountPlugin('agy-daddy.grouped', {
      mount(ctx) {
        ctx.topbar.registerUnit({ id: 'gunit', order: 10, label: 'Grouped' });
        ctx.topbar.registerPopover({
          id: 'gpop',
          anchorId: 'gunit',
          title: '分组弹窗',
          render(body) { body.textContent = 'ok'; }
        });
      }
    });

    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    const gearBtn = shadow.querySelector('[data-popover-settings="agy-daddy.grouped"]');
    const closeBtn = shadow.querySelector('[data-popover-close="agy-daddy.grouped:gpop"]');
    assert.ok(gearBtn && closeBtn);
    assert.equal(gearBtn.textContent.includes('⚙'), false);
    assert.equal(closeBtn.textContent.includes('✕'), false);
    assert.ok(gearBtn.querySelector('.ag-svg-icon')?.innerHTML.includes('<svg'));
    assert.ok(closeBtn.querySelector('.ag-svg-icon')?.innerHTML.includes('<svg'));

    await host.openSettings({ tab: 'plugins', pluginId: 'agy-daddy.grouped' });
    const formGroups = shadow.querySelector('#agy-plugin-detail-form.ag-sv-form-groups');
    assert.ok(formGroups);
    const titles = Array.from(formGroups.querySelectorAll('.ag-sv-group-title')).map((el) => el.textContent);
    assert.deepEqual(titles, ['网络与端口', '上游规则']);

    const portInput = formGroups.querySelector('[data-setting-key="port"]');
    const upstreamInput = formGroups.querySelector('[data-setting-key="upstream"]');
    assert.equal(portInput.placeholder, '18766');
    assert.equal(upstreamInput.placeholder, 'http://127.0.0.1:7890');
    const unitEl = formGroups.querySelector('.ag-input-unit-wrap .ag-input-unit');
    assert.ok(unitEl);
    assert.equal(unitEl.textContent, '端口');
  } finally {
    await host.dispose();
  }
});

test('Popover 就近定位：支持 anchorRect 与 top/bottom 方向切换', async () => {
  const doc = createMockDocument();
  const host = createHostRuntime({
    document: doc,
    window: { innerWidth: 1280, innerHeight: 800, location: { href: 'https://127.0.0.1:51410/' } },
    anchorsRegistry: buildFullAnchorsRegistry()
  });

  try {
    let pop = null;
    await host.mountPlugin('agy-daddy.pos-test', {
      mount(ctx) {
        ctx.topbar.registerUnit({ id: 'punit', order: 10, label: 'Pos' });
        pop = ctx.topbar.registerPopover({
          id: 'ppop',
          anchorId: 'punit',
          title: '定位测试',
          render(body) { body.textContent = 'pos'; }
        });
      }
    });

    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    const panel = shadow.querySelector('[data-agy-popover="agy-daddy.pos-test:ppop"]');
    assert.ok(panel);

    // 底部胶囊锚点向上弹出
    pop.toggle(true, {
      anchorRect: { top: 720, left: 900, right: 1180, bottom: 748, width: 280, height: 28 },
      placement: 'top'
    });
    assert.equal(panel.hidden, false);
    assert.equal(panel.getAttribute('data-placement'), 'top');
    assert.equal(panel.style.getPropertyValue('top'), 'auto');
    assert.equal(panel.style.getPropertyValue('bottom'), '88px');
    assert.equal(panel.style.getPropertyValue('right'), '100px');

    // 切回顶栏向下弹出时清理 bottom 与 max-height
    const unitBtn = shadow.querySelector('[data-unit-id="punit"]');
    assert.ok(unitBtn);
    unitBtn.getBoundingClientRect = () => ({ top: 8, left: 1050, right: 1140, bottom: 32, width: 90, height: 24 });
    pop.toggle(true, { placement: 'bottom' });
    assert.equal(panel.getAttribute('data-placement'), 'bottom');
    assert.equal(panel.style.getPropertyValue('bottom'), '');
    assert.equal(panel.style.getPropertyValue('max-height'), '');
    assert.equal(panel.style.getPropertyValue('top'), '40px');

    // 靠近视口左侧时按 panelW=400 夹紧，不超出左边界
    pop.toggle(true, {
      anchorRect: { top: 720, left: 20, right: 120, bottom: 748, width: 100, height: 28 },
      placement: 'top'
    });
    assert.equal(panel.style.getPropertyValue('right'), '868px');

    // 多段 icon+数字 顶栏单元渲染与 SVG 消毒
    await host.mountPlugin('agy-daddy.seg-test', {
      mount(ctx) {
        ctx.topbar.registerUnit({
          id: 'sunit',
          order: 20,
          title: '多段提示',
          segments: [
            { iconSvg: '<svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>', text: '249k/512k' },
            { iconSvg: '<svg onclick="alert(1)"></svg>', text: '7.96M', tone: 'warn' }
          ]
        });
      }
    });
    const segBtn = shadow.querySelector('[data-unit-id="sunit"]');
    assert.ok(segBtn);
    assert.equal(segBtn.getAttribute('title'), '多段提示');
    const segEls = segBtn.querySelectorAll('.ag-unit-seg');
    assert.equal(segEls.length, 2);
    assert.equal(segEls[0].querySelectorAll('.ag-unit-icon').length, 1);
    assert.equal(segEls[1].querySelectorAll('.ag-unit-icon').length, 0);
    assert.equal(segEls[1].getAttribute('data-tone'), 'warn');
  } finally {
    await host.dispose();
  }
});

test('运行时未挂载顶栏胶囊的插件自动隐藏「顶栏胶囊固定」，切回顶栏后即时恢复', async () => {
  const doc = createMockDocument();
  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'agy-daddy.switchable': {
        id: 'agy-daddy.switchable',
        displayName: '可切位置插件',
        version: '1.0.0',
        trustLevel: 'T0',
        topbarUnits: [{ id: 'ring' }]
      }
    }
  });

  try {
    let regFn = null;
    let disposeFn = null;
    await host.mountPlugin('agy-daddy.switchable', {
      mount(ctx) {
        ctx.topbar.setAvailable(false);
        regFn = () => {
          disposeFn = ctx.topbar.registerUnit({ id: 'ring', order: 10, label: 'Ctx' });
        };
      }
    });

    // 插件声明了 topbarUnits，但运行时处于非顶栏模式未注册单元 -> 列表与详情页均隐藏「顶栏胶囊固定」
    await host.openSettings({ tab: 'plugins' });
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    assert.equal(shadow.querySelector('[data-plugin-pin="agy-daddy.switchable"]'), null);

    await host.openSettings({ tab: 'plugins', pluginId: 'agy-daddy.switchable' });
    assert.equal(shadow.querySelector('[data-plugin-pin="agy-daddy.switchable"]'), null);
    assert.equal(shadow.textContent.includes('顶栏胶囊固定'), false);

    // 切回顶栏并注册单元 -> 设置详情页即时出现「顶栏胶囊固定」
    regFn();
    assert.ok(shadow.querySelector('[data-plugin-pin="agy-daddy.switchable"]'));
    assert.ok(shadow.textContent.includes('顶栏胶囊固定'));

    // 再次卸载单元 -> 即时隐藏
    disposeFn();
    assert.equal(shadow.querySelector('[data-plugin-pin="agy-daddy.switchable"]'), null);
  } finally {
    await host.dispose();
  }
});

test('插件设置详情页支持 visibleWhen 条件显隐与 writeOnly 仅写保存/清除', async () => {
  const doc = createMockDocument();
  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'agy-daddy.tunnel-ui': {
        id: 'agy-daddy.tunnel-ui',
        displayName: '远程访问',
        version: '1.0.0',
        trustLevel: 'T0',
        settingsValues: { tunnelMode: 'quick', tunnelHostname: '', tunnelToken: '' },
        settingsSchema: {
          title: '远程访问设置',
          fields: [
            {
              key: 'tunnelMode',
              type: 'enum',
              default: 'quick',
              options: [
                { value: 'quick', label: 'Quick' },
                { value: 'named', label: 'Named' }
              ],
              label: 'Cloudflare 隧道模式'
            },
            {
              key: 'tunnelHostname',
              type: 'string',
              default: '',
              visibleWhen: { key: 'tunnelMode', equals: 'named' },
              label: '固定隧道域名'
            },
            {
              key: 'tunnelToken',
              type: 'string',
              default: '',
              secret: true,
              writeOnly: true,
              visibleWhen: { key: 'tunnelMode', equals: 'named' },
              label: 'Cloudflare Tunnel Token'
            }
          ]
        }
      }
    }
  });

  try {
    await host.openSettings({ tab: 'plugins', pluginId: 'agy-daddy.tunnel-ui' });
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 默认 quick 模式：不渲染 tunnelHostname 与 tunnelToken
    const modeSelect = shadow.querySelector('[data-setting-key="tunnelMode"]');
    assert.ok(modeSelect);
    assert.equal(shadow.querySelector('[data-setting-key="tunnelHostname"]'), null);
    assert.equal(shadow.querySelector('[data-setting-key="tunnelToken"]'), null);

    // 切换为 named 模式：立即显示域名与仅写 Token 输入框（无明文显示按钮，有保存按钮）
    modeSelect.value = 'named';
    modeSelect.dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 20));

    const hostInput = shadow.querySelector('[data-setting-key="tunnelHostname"]');
    const tokenInput = shadow.querySelector('[data-setting-key="tunnelToken"]');
    const saveBtn = shadow.querySelector('[data-secret-save="tunnelToken"]');
    assert.ok(hostInput);
    assert.ok(tokenInput);
    assert.ok(saveBtn);
    assert.equal(tokenInput.type, 'password');
    assert.equal(tokenInput.getAttribute('data-write-only'), 'true');
    assert.equal(tokenInput.value, '');
    assert.equal(shadow.querySelector('[data-secret-toggle="tunnelToken"]'), null);
    assert.equal(shadow.querySelector('[data-secret-configured="tunnelToken"]'), null);
    assert.equal(shadow.querySelector('[data-secret-clear="tunnelToken"]'), null);

    // 空值点击保存 -> 提示错误且不标记为已保存
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(shadow.querySelector('[data-field-error="tunnelToken"]'));
    assert.equal(shadow.querySelector('[data-secret-configured="tunnelToken"]'), null);

    // 输入 Token 并点击保存 -> 清空输入框、显示「已保存」与「清除」，渲染层不保留明文
    const tokenInput2 = shadow.querySelector('[data-setting-key="tunnelToken"]');
    tokenInput2.value = 'secret-tunnel-token-xyz';
    shadow.querySelector('[data-secret-save="tunnelToken"]').click();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(host.getPluginSettings('agy-daddy.tunnel-ui').tunnelToken, '');
    assert.equal(shadow.querySelector('[data-setting-key="tunnelToken"]').value, '');
    assert.equal(shadow.querySelector('[data-secret-configured="tunnelToken"]')?.textContent, '已保存');
    const clearBtn = shadow.querySelector('[data-secret-clear="tunnelToken"]');
    assert.ok(clearBtn);

    // 点击清除 -> 移除「已保存」标记与清除按钮
    clearBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(shadow.querySelector('[data-secret-configured="tunnelToken"]'), null);
    assert.equal(shadow.querySelector('[data-secret-clear="tunnelToken"]'), null);
  } finally {
    await host.dispose();
  }
});

test('插件设置详情页支持 threshold-color-rule 声明式可视化规则编辑器（新增、上下排序、删除与恢复默认）', async () => {
  const doc = createMockDocument();
  const host = createHostRuntime({
    window: {},
    document: doc,
    pluginMeta: {
      'demo.rules': {
        id: 'demo.rules',
        displayName: '规则测试插件',
        trustLevel: 'T0',
        world: 'isolated',
        enabled: true,
        active: true,
        settingsSchema: {
          title: '规则配置',
          fields: [
            {
              key: 'colorRules',
              type: 'list',
              default: ['any:remaining<=15:#ef4444'],
              label: '胶囊颜色规则',
              itemEditor: {
                kind: 'threshold-color-rule',
                unit: '%',
                defaultRule: { target: 'any', metric: 'remaining<=', threshold: 20, color: '#ef4444' },
                targets: [
                  { value: 'any', label: '任意限额' },
                  { value: 'claude_weekly', label: 'Claude Week' }
                ],
                metrics: [
                  { value: 'remaining<=', label: '剩余 ≤' },
                  { value: 'used>=', label: '已用 ≥' }
                ],
                colors: [
                  { value: '#ef4444', label: '红色' },
                  { value: '#8b5cf6', label: '紫色' }
                ]
              }
            }
          ]
        }
      }
    }
  });

  try {
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.rules' });
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    const editor = shadow.querySelector('[data-rule-editor="colorRules"]');
    assert.ok(editor);

    // 新增第二条规则：Claude Week 已用 >= 60% 紫色
    editor.querySelector('[data-rule-target="colorRules"]').value = 'claude_weekly';
    editor.querySelector('[data-rule-metric="colorRules"]').value = 'used>=';
    editor.querySelector('[data-rule-threshold="colorRules"]').value = '60';
    editor.querySelector('[data-rule-color-preset="colorRules:#8b5cf6"]').click();
    editor.querySelector('[data-list-add="colorRules"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      host.getPluginSettings('demo.rules').colorRules,
      ['any:remaining<=15:#ef4444', 'claude_weekly:used>=60:#8b5cf6']
    );

    // 已移除上下箭头，改为统一拖拽调整规则顺序；且行内交互控件（select/input）不触发误拖
    assert.equal(shadow.querySelector('[data-rule-up]'), null);
    assert.equal(shadow.querySelector('[data-rule-down]'), null);
    const ruleRow0 = shadow.querySelector('[data-rule-item="colorRules:0"]');
    const ruleRow1 = shadow.querySelector('[data-rule-item="colorRules:1"]');
    assert.equal(ruleRow0.getAttribute('draggable'), 'true');
    assert.ok(ruleRow0.querySelector('.ag-drag-handle'));

    // 行内 select 触发 pointerdown 后，dragstart 应被阻止以防误拖
    const ruleSelect0 = shadow.querySelector('[data-rule-item-target="colorRules:0"]');
    let prevented = false;
    ruleRow0.dispatchEvent({ type: 'pointerdown', target: ruleSelect0 });
    ruleRow0.dispatchEvent({ type: 'dragstart', preventDefault() { prevented = true; }, dataTransfer: { setData() {} } });
    assert.equal(prevented, true);
    ruleRow0.dispatchEvent({ type: 'pointerup', target: ruleSelect0 });

    // 将第二条规则拖拽到第一条之前
    ruleRow1.dispatchEvent({ type: 'dragstart', dataTransfer: { setData() {} } });
    ruleRow0.dispatchEvent({ type: 'dragover', preventDefault() {} });
    ruleRow0.dispatchEvent({ type: 'drop', preventDefault() {}, dataTransfer: { getData: () => '1' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      host.getPluginSettings('demo.rules').colorRules,
      ['claude_weekly:used>=60:#8b5cf6', 'any:remaining<=15:#ef4444']
    );

    // 原地编辑第一条规则的阈值、颜色、目标与条件
    const thr0 = shadow.querySelector('[data-rule-item-threshold="colorRules:0"]');
    assert.ok(thr0);
    thr0.value = '75';
    thr0.dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      host.getPluginSettings('demo.rules').colorRules,
      ['claude_weekly:used>=75:#8b5cf6', 'any:remaining<=15:#ef4444']
    );

    const color0 = shadow.querySelector('[data-rule-item-color="colorRules:0"]');
    assert.ok(color0);
    color0.value = '#22c55e';
    color0.dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      host.getPluginSettings('demo.rules').colorRules,
      ['claude_weekly:used>=75:#22c55e', 'any:remaining<=15:#ef4444']
    );

    const target0 = shadow.querySelector('[data-rule-item-target="colorRules:0"]');
    const metric0 = shadow.querySelector('[data-rule-item-metric="colorRules:0"]');
    assert.ok(target0 && metric0);
    target0.value = 'any';
    target0.dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 20));
    const metric0After = shadow.querySelector('[data-rule-item-metric="colorRules:0"]');
    metric0After.value = 'remaining<=';
    metric0After.dispatchEvent({ type: 'change' });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      host.getPluginSettings('demo.rules').colorRules,
      ['any:remaining<=75:#22c55e', 'any:remaining<=15:#ef4444']
    );

    // 恢复默认
    shadow.querySelector('[data-rule-reset="colorRules"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(
      host.getPluginSettings('demo.rules').colorRules,
      ['any:remaining<=15:#ef4444']
    );
  } finally {
    await host.dispose();
  }
});

test('外观设置：右上角 Agy-Daddy 入口显隐与注入原生设置面板开关实时生效并持久化', async () => {
  const doc = createMockDocument();
  const triggerBtn = createMockElement('button', doc);
  triggerBtn.setAttribute('data-testid', 'open-settings-button');
  let triggerClicks = 0;
  triggerBtn.addEventListener('click', () => {
    triggerClicks++;
    attachNativeSettingsDialog(doc, 'flex');
  });
  doc.body.appendChild(triggerBtn);

  const { calls, fetchFn } = createMockBridgeFetch({
    '/host/host-settings': (body) => ({ ok: true, values: body.values }),
    '/host/plugins': () => ({ ok: true, plugins: [], catalog: [] })
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19996,
    hostToken: 'secret-token',
    anchorsRegistry: buildFullAnchorsRegistry()
  });

  try {
    // 1. 先打开原生融合设置并切到外观页
    const res1 = await host.openSettings({ tab: 'appearance' });
    assert.equal(res1.mode, 'native');
    assert.equal(triggerClicks, 1);

    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    const settingsBtn = shadow.querySelector('#agy-btn-settings');
    assert.ok(settingsBtn);
    assert.equal(settingsBtn.hidden, false);
    assert.equal(settingsBtn.getAttribute('title'), 'Agy-Daddy 设置');
    assert.equal(settingsBtn.getAttribute('aria-label'), 'Agy-Daddy 设置');
    const settingsIcon = settingsBtn.querySelector('.ag-svg-icon');
    assert.ok(settingsIcon, 'Expected SVG icon inside #agy-btn-settings');
    assert.match(settingsIcon.innerHTML, /<svg\b/);
    assert.equal(settingsBtn.querySelector('.ag-unit-label')?.textContent, 'Agy-Daddy 设置');

    // 更新提示状态同步更新悬浮文案且保留小红点
    host.setUpdateInfo({ hasUpdate: true, currentVersion: '1.0.0', latestVersion: '1.1.0' });
    assert.equal(shadow.querySelector('#agy-update-dot').hidden, false);
    assert.equal(settingsBtn.getAttribute('title'), 'Agy-Daddy 设置（有新版本可用）');
    host.setUpdateInfo({ hasUpdate: false, currentVersion: '1.0.0', latestVersion: '1.0.0' });
    assert.equal(shadow.querySelector('#agy-update-dot').hidden, true);
    assert.equal(settingsBtn.getAttribute('title'), 'Agy-Daddy 设置');

    const mountEl = doc.querySelector('#agy-native-settings-mount');
    assert.ok(mountEl);
    const nativeShadow = mountEl.shadowRoot;
    const topbarEntryToggle = nativeShadow.querySelector('#agy-show-topbar-entry');
    const hideTrayToggle = nativeShadow.querySelector('#agy-hide-tray-icon');
    const injectNativeToggle = nativeShadow.querySelector('#agy-inject-native-settings');
    assert.ok(topbarEntryToggle);
    assert.ok(hideTrayToggle);
    assert.ok(injectNativeToggle);
    assert.equal(topbarEntryToggle.checked, true);
    assert.equal(hideTrayToggle.checked, false);
    assert.equal(injectNativeToggle.checked, true);

    // 1.5 开启隐藏通知栏图标 -> 状态同步并持久化，再关闭恢复
    hideTrayToggle.checked = true;
    hideTrayToggle.dispatchEvent({ type: 'change', target: hideTrayToggle });
    assert.equal(host.getHostSettings().hideTrayIcon, true);
    const hideTrayToggleAfter = doc.querySelector('#agy-native-settings-mount').shadowRoot.querySelector('#agy-hide-tray-icon');
    assert.equal(hideTrayToggleAfter.checked, true);
    hideTrayToggleAfter.checked = false;
    hideTrayToggleAfter.dispatchEvent({ type: 'change', target: hideTrayToggleAfter });
    assert.equal(host.getHostSettings().hideTrayIcon, false);

    // 2. 关闭右上角 Agy-Daddy 入口 -> #agy-btn-settings 隐藏并持久化
    topbarEntryToggle.checked = false;
    topbarEntryToggle.dispatchEvent({ type: 'change', target: topbarEntryToggle });
    assert.equal(settingsBtn.hidden, true);
    assert.equal(host.getHostSettings().showTopbarEntry, false);

    // 3. 在原生融合态下关闭「注入原生设置面板」-> 卸载原生注入节点并平滑切换到独立模态窗
    const dialog = doc.querySelector('[data-testid="settings-dialog"]');
    const content = dialog.querySelector('[data-testid="settings-content"]');
    injectNativeToggle.checked = false;
    injectNativeToggle.dispatchEvent({ type: 'change', target: injectNativeToggle });

    assert.equal(doc.querySelector('#agy-native-settings-mount'), null);
    assert.equal(dialog.querySelector('[data-agy-native-nav="true"]'), null);
    assert.equal(content.style.getPropertyValue('display'), 'flex');
    assert.equal(host.getSettingsMode(), 'modal');
    assert.equal(host.getHostSettings().injectNativeSettings, false);

    // 同时关闭两者后应显示提示横幅
    const modalToast = shadow.querySelector('#agy-manage-toast');
    assert.ok(modalToast);
    assert.match(modalToast.textContent, /可通过插件浮窗右上角/);

    // 4. 关闭后再次 openSettings 不应点击原生设置按钮，直接打开模态窗
    host.closeSettings();
    assert.equal(host.getSettingsMode(), 'closed');
    const res2 = await host.openSettings({ tab: 'appearance' });
    assert.equal(res2.mode, 'modal');
    assert.equal(triggerClicks, 1);

    // 5. 重新开启注入原生设置与右上角入口
    const modalTopbarToggle = shadow.querySelector('#agy-show-topbar-entry');
    const modalNativeToggle = shadow.querySelector('#agy-inject-native-settings');
    modalTopbarToggle.checked = true;
    modalTopbarToggle.dispatchEvent({ type: 'change', target: modalTopbarToggle });
    assert.equal(settingsBtn.hidden, false);

    modalNativeToggle.checked = true;
    modalNativeToggle.dispatchEvent({ type: 'change', target: modalNativeToggle });
    assert.ok(doc.querySelector('#agy-native-settings-mount'));
    assert.ok(dialog.querySelector('[data-agy-native-nav="true"]'));

    await new Promise((r) => setTimeout(r, 20));
    const hsCalls = calls.filter((c) => c.path === '/host/host-settings');
    assert.ok(hsCalls.some((c) => c.body?.values?.showTopbarEntry === false));
    assert.ok(hsCalls.some((c) => c.body?.values?.hideTrayIcon === true));
    assert.ok(hsCalls.some((c) => c.body?.values?.hideTrayIcon === false));
    assert.ok(hsCalls.some((c) => c.body?.values?.injectNativeSettings === false));
    assert.ok(hsCalls.some((c) => c.body?.values?.showTopbarEntry === true));
    assert.ok(hsCalls.some((c) => c.body?.values?.injectNativeSettings === true));
  } finally {
    await host.dispose();
  }
});

test('插件设置详情页支持 Combobox 可输入下拉框、路径自动探测+浏览选择 与 command-preset 命令编辑器', async () => {
  const doc = createMockDocument();
  let currentSettings = {
    terminalApp: 'auto',
    exePath: '',
    modelName: '',
    quickCmds: []
  };
  let detectMode = 'hit';
  let browseMode = 'ok';

  const { fetchFn } = createMockBridgeFetch({
    '/host/plugins': () => ({ ok: true, plugins: [], catalog: [] }),
    '/host/settings': (body) => {
      Object.assign(currentSettings, body.values || {});
      return { ok: true, values: { ...currentSettings }, changedKeys: Object.keys(body.values || {}) };
    },
    '/host/commands/run': (body) => {
      if (body.commandId === 'demo.listModels') {
        return {
          ok: true,
          result: {
            ok: true,
            options: [
              { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro' }
            ]
          }
        };
      }
      if (body.commandId === 'demo.detectPath') {
        const arg = (body.args && body.args[0]) || {};
        if (arg.trigger === 'watch' && arg.values?.terminalApp === 'ghostty' && detectMode === 'miss') {
          return { ok: true, result: { ok: true, found: false, path: '', error: '未检测到 Ghostty 路径，请手动输入或浏览选择' } };
        }
        if (arg.trigger === 'edit' && arg.values?.exePath === '/custom/bin/term') {
          return { ok: true, result: { ok: true, found: true, path: '/custom/bin/term', message: '路径有效：/custom/bin/term' } };
        }
        return { ok: true, result: { ok: true, found: true, path: '/Applications/iTerm.app', message: '已检测到：/Applications/iTerm.app' } };
      }
      if (body.commandId === 'demo.browsePath') {
        if (browseMode === 'fail') {
          return { ok: true, result: { ok: false, cancelled: false, path: '', error: 'DIALOG_DENIED' } };
        }
        return { ok: true, result: { ok: true, cancelled: false, path: '/custom/bin/term' } };
      }
      return { ok: true, result: {} };
    }
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19995,
    hostToken: 'secret-token',
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'demo.controls': {
        id: 'demo.controls',
        displayName: '高级声明式控件测试',
        trustLevel: 'T0',
        world: 'isolated',
        enabled: true,
        active: true,
        settingsSchema: {
          title: '控件验证',
          fields: [
            {
              key: 'terminalApp',
              type: 'enum',
              default: 'auto',
              label: '终端',
              options: [
                { value: 'auto', label: '自动' },
                { value: 'iterm2', label: 'iTerm2' },
                { value: 'ghostty', label: 'Ghostty' }
              ]
            },
            {
              key: 'exePath',
              type: 'string',
              default: '',
              label: '程序路径',
              probe: {
                command: 'demo.detectPath',
                watchKeys: ['terminalApp'],
                autoFill: true,
                runOnOpen: true,
                buttonLabel: '重新检测'
              },
              browse: {
                command: 'demo.browsePath',
                label: '浏览选择'
              }
            },
            {
              key: 'modelName',
              type: 'string',
              default: '',
              label: '模型',
              options: [
                { value: '', label: '默认模型' },
                { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro' }
              ],
              optionsCommand: 'demo.listModels'
            },
            {
              key: 'quickCmds',
              type: 'list',
              default: [],
              label: '快捷命令',
              itemEditor: {
                kind: 'command-preset',
                allowPinToTopbar: true
              }
            }
          ]
        },
        settingsValues: { ...currentSettings }
      }
    }
  });

  try {
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.controls' });
    await new Promise((r) => setTimeout(r, 30));
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 1. 打开详情页自动 probe 回显
    assert.equal(host.getPluginSettings('demo.controls').exePath, '/Applications/iTerm.app');
    assert.equal(shadow.querySelector('[data-field-probe-status="ok"]')?.getAttribute('data-field-probe-key'), 'exePath');

    // 2. 切换终端且检测失败 -> 清空路径并展示红色错误提示
    detectMode = 'miss';
    const termSel = shadow.querySelector('[data-setting-key="terminalApp"]');
    termSel.value = 'ghostty';
    termSel.dispatchEvent({ type: 'change', target: termSel });
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(host.getPluginSettings('demo.controls').exePath, '');
    const errProbe = shadow.querySelector('[data-field-probe-status="error"]');
    assert.ok(errProbe);
    assert.match(errProbe.textContent, /未检测到 Ghostty 路径/);
    assert.equal(shadow.querySelector('[data-setting-key="exePath"]').getAttribute('data-invalid'), 'true');

    // 3. 点击浏览选择 -> 回填路径并校验成功；若返回 ok:false 必须在字段下方展示行内错误并恢复按钮状态
    shadow.querySelector('[data-field-browse="exePath"]').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(host.getPluginSettings('demo.controls').exePath, '/custom/bin/term');
    assert.equal(shadow.querySelector('[data-field-probe-status="ok"]')?.getAttribute('data-field-probe-key'), 'exePath');

    browseMode = 'fail';
    const browseBtnFail = shadow.querySelector('[data-field-browse="exePath"]');
    browseBtnFail.click();
    await new Promise((r) => setTimeout(r, 40));
    const browseErr = shadow.querySelector('[data-field-error="exePath"]');
    assert.ok(browseErr);
    assert.match(browseErr.textContent, /DIALOG_DENIED/);
    assert.equal(shadow.querySelector('[data-field-browse="exePath"]').disabled, false);
    browseMode = 'ok';

    // 4. Combobox：聚焦/展开下拉（卡片与行标记 data-combobox-open="true" 防止裁剪）、键盘 ArrowDown+Enter 选择动态模型 + 自由输入自定义模型
    const comboInputInit = shadow.querySelector('[data-combobox-input="modelName"]');
    comboInputInit.dispatchEvent({ type: 'focus', target: comboInputInit });
    assert.equal(shadow.querySelector('[data-combobox="modelName"]').getAttribute('data-open'), 'true');
    assert.equal(shadow.querySelector('[data-field-key="modelName"]').getAttribute('data-combobox-open'), 'true');
    assert.equal(shadow.querySelector('[data-field-key="modelName"]').parentElement.getAttribute('data-combobox-open'), 'true');
    const dynOpt = shadow.querySelector('[data-option-value="gemini-3-pro-preview"]');
    assert.ok(dynOpt);
    comboInputInit.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {} });
    comboInputInit.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {} });
    comboInputInit.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {} });
    comboInputInit.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.getPluginSettings('demo.controls').modelName, 'gemini-3-pro-preview');

    const comboInput = shadow.querySelector('[data-combobox-input="modelName"]');
    assert.equal(comboInput.value, 'Gemini 3 Pro');
    assert.equal(comboInput.getAttribute('data-setting-value'), 'gemini-3-pro-preview');
    comboInput.value = 'my-custom-model-v9';
    comboInput.dispatchEvent({ type: 'change', target: comboInput });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.getPluginSettings('demo.controls').modelName, 'my-custom-model-v9');

    // 5. command-preset 列表编辑器：新增、切换顶栏固定、上下调序、原地编辑名称和命令、删除
    const nameIn = shadow.querySelector('[data-cmd-name="quickCmds"]');
    const cmdIn = shadow.querySelector('[data-cmd-command="quickCmds"]');
    nameIn.value = 'Claude';
    nameIn.dispatchEvent({ type: 'input', target: nameIn });
    cmdIn.value = 'claude --continue | tee /tmp/out.log';
    cmdIn.dispatchEvent({ type: 'input', target: cmdIn });
    shadow.querySelector('[data-list-add="quickCmds"]').click();
    await new Promise((r) => setTimeout(r, 20));

    const nameIn2 = shadow.querySelector('[data-cmd-name="quickCmds"]');
    const cmdIn2 = shadow.querySelector('[data-cmd-command="quickCmds"]');
    nameIn2.value = 'Logs';
    nameIn2.dispatchEvent({ type: 'input', target: nameIn2 });
    cmdIn2.value = 'tail -f app.log';
    cmdIn2.dispatchEvent({ type: 'input', target: cmdIn2 });
    shadow.querySelector('[data-list-add="quickCmds"]').click();
    await new Promise((r) => setTimeout(r, 20));

    let listVal = host.getPluginSettings('demo.controls').quickCmds;
    assert.equal(listVal.length, 2);
    assert.equal(JSON.parse(listVal[0]).command, 'claude --continue | tee /tmp/out.log');
    assert.equal(JSON.parse(listVal[0]).pinToTopbar, true);

    // 取消第一项顶栏固定 -> 收纳至菜单
    shadow.querySelector('[data-cmd-pin-toggle="quickCmds:0"]').click();
    await new Promise((r) => setTimeout(r, 20));
    listVal = host.getPluginSettings('demo.controls').quickCmds;
    assert.equal(JSON.parse(listVal[0]).pinToTopbar, false);

    // 原地编辑第一项名称和命令（先取消再保存，验证保留 pinToTopbar=false）
    shadow.querySelector('[data-cmd-edit="quickCmds:0"]').click();
    assert.ok(shadow.querySelector('[data-cmd-editing="quickCmds:0"]'));
    shadow.querySelector('[data-cmd-edit-cancel="quickCmds:0"]').click();
    assert.equal(shadow.querySelector('[data-cmd-editing="quickCmds:0"]'), null);

    shadow.querySelector('[data-cmd-edit="quickCmds:0"]').click();
    const editNameIn = shadow.querySelector('[data-cmd-edit-name="quickCmds:0"]');
    const editCmdIn = shadow.querySelector('[data-cmd-edit-command="quickCmds:0"]');
    editNameIn.value = 'ClaudePro';
    editNameIn.dispatchEvent({ type: 'input', target: editNameIn });
    editCmdIn.value = 'claude --resume';
    editCmdIn.dispatchEvent({ type: 'input', target: editCmdIn });
    shadow.querySelector('[data-cmd-edit-save="quickCmds:0"]').click();
    await new Promise((r) => setTimeout(r, 20));
    listVal = host.getPluginSettings('demo.controls').quickCmds;
    assert.equal(JSON.parse(listVal[0]).name, 'ClaudePro');
    assert.equal(JSON.parse(listVal[0]).command, 'claude --resume');
    assert.equal(JSON.parse(listVal[0]).pinToTopbar, false);

    // 已移除上下箭头，改为拖拽调整命令顺序（并清理内联编辑状态）
    assert.equal(shadow.querySelector('[data-cmd-up]'), null);
    assert.equal(shadow.querySelector('[data-cmd-down]'), null);
    const cmdRow0 = shadow.querySelector('[data-cmd-item="quickCmds:0"]');
    const cmdRow1 = shadow.querySelector('[data-cmd-item="quickCmds:1"]');
    assert.equal(cmdRow0.getAttribute('draggable'), 'true');
    assert.ok(cmdRow0.querySelector('.ag-drag-handle'));
    cmdRow1.dispatchEvent({ type: 'dragstart', dataTransfer: { setData() {} } });
    cmdRow0.dispatchEvent({ type: 'dragover', preventDefault() {} });
    cmdRow0.dispatchEvent({ type: 'drop', preventDefault() {}, dataTransfer: { getData: () => '1' } });
    await new Promise((r) => setTimeout(r, 20));
    listVal = host.getPluginSettings('demo.controls').quickCmds;
    assert.equal(JSON.parse(listVal[0]).name, 'Logs');

    // 删除第一项
    shadow.querySelector('[data-list-remove="quickCmds:0"]').click();
    await new Promise((r) => setTimeout(r, 20));
    listVal = host.getPluginSettings('demo.controls').quickCmds;
    assert.equal(listVal.length, 1);
    assert.equal(JSON.parse(listVal[0]).name, 'ClaudePro');
  } finally {
    await host.dispose();
  }
});

test('热重注复用已有 #agy-native-settings-mount 时自动同步最新阴影样式表', async () => {
  const doc = createMockDocument();
  const { dialog, content } = attachNativeSettingsDialog(doc, 'flex');

  // 预先模拟旧版宿主残留的 mountHost 与陈旧 <style>
  const staleMount = createMockElement('div', doc);
  staleMount.id = 'agy-native-settings-mount';
  const staleShadow = staleMount.attachShadow({ mode: 'open' });
  const staleStyle = createMockElement('style', doc);
  staleStyle.textContent = '/* stale css */';
  const staleRoot = createMockElement('div', doc);
  staleRoot.id = 'agy-native-settings-root';
  staleShadow.appendChild(staleStyle);
  staleShadow.appendChild(staleRoot);
  dialog.insertBefore(staleMount, content.nextSibling || null);

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    anchorsRegistry: buildFullAnchorsRegistry()
  });
  try {
    assert.equal(host.syncNativeSettings(), true);
    const updatedStyle = staleShadow.querySelector('style');
    assert.ok(updatedStyle);
    assert.notEqual(updatedStyle.textContent, '/* stale css */');
  } finally {
    await host.dispose();
  }
});

test('插件设置详情页支持 multiline 多行提示词编辑器（保存与恢复默认）与 ordered-preset-list（增删排序自定义与恢复默认）', async () => {
  const doc = createMockDocument();
  const anchorsRegistry = buildFullAnchorsRegistry();
  let currentSettings = {
    promptTpl: 'DEFAULT_PROMPT',
    quickItems: ['plan', 'goal']
  };
  const DEFAULT_PROMPT = 'DEFAULT_PROMPT';
  const DEFAULT_ITEMS = ['plan', 'goal'];

  const { fetchFn } = createMockBridgeFetch({
    '/host/plugins/settings': async (body) => {
      currentSettings = { ...currentSettings, ...(body.values || {}) };
      return { ok: true, values: { ...currentSettings } };
    }
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19999,
    hostToken: 'tok-rich-controls',
    anchorsRegistry,
    pluginMeta: {
      'demo.composer': {
        id: 'demo.composer',
        displayName: 'Rich Composer',
        version: '1.0.0',
        trustLevel: 'T0',
        settingsSchema: {
          title: 'Rich Composer',
          fields: [
            {
              key: 'promptTpl',
              type: 'string',
              multiline: true,
              rows: 6,
              resetToDefault: true,
              default: DEFAULT_PROMPT,
              label: '优化提示词模板'
            },
            {
              key: 'quickItems',
              type: 'list',
              default: DEFAULT_ITEMS,
              label: '快捷输入条目与顺序',
              itemEditor: {
                kind: 'ordered-preset-list',
                allowCustom: true,
                presets: [
                  { id: 'plan', label: '/plan 规划', tag: '先谋后动' },
                  { id: 'goal', label: '/goal 持续', tag: '长程' },
                  { id: 'compact', label: '/compact 压缩', tag: '防卡死' }
                ]
              }
            }
          ]
        },
        settingsValues: { ...currentSettings }
      }
    }
  });

  try {
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.composer' });
    await new Promise((r) => setTimeout(r, 30));
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 1. multiline textarea 编辑保存 & 恢复默认
    const ta = shadow.querySelector('textarea[data-setting-key="promptTpl"]');
    assert.ok(ta);
    assert.equal(ta.value, DEFAULT_PROMPT);
    ta.value = 'CUSTOM_PROMPT_LINE_1\n{{draft}}';
    shadow.querySelector('[data-textarea-save="promptTpl"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.getPluginSettings('demo.composer').promptTpl, 'CUSTOM_PROMPT_LINE_1\n{{draft}}');

    shadow.querySelector('[data-string-reset="promptTpl"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.getPluginSettings('demo.composer').promptTpl, DEFAULT_PROMPT);

    // 2. ordered-preset-list：从预设池添加 compact、拖拽排序、添加自定义条目、移除与恢复默认
    assert.equal(shadow.querySelector('[data-preset-up]'), null);
    assert.equal(shadow.querySelector('[data-preset-down]'), null);
    shadow.querySelector('[data-preset-add="quickItems:compact"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(host.getPluginSettings('demo.composer').quickItems, ['plan', 'goal', 'compact']);

    // 拖拽排序：将索引 2 (compact) 拖到索引 1 (goal) 之前 -> ['plan', 'compact', 'goal']
    const initRow1 = shadow.querySelector('[data-preset-item="quickItems:1"]');
    const initRow2 = shadow.querySelector('[data-preset-item="quickItems:2"]');
    initRow2.dispatchEvent({ type: 'dragstart', dataTransfer: { setData() {} } });
    initRow1.dispatchEvent({ type: 'dragover', preventDefault() {} });
    initRow1.dispatchEvent({ type: 'drop', preventDefault() {}, dataTransfer: { getData: () => '2' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(host.getPluginSettings('demo.composer').quickItems, ['plan', 'compact', 'goal']);

    // 2.5 拖动调整顺序：将索引 2 (goal) 拖到索引 0 (plan) 之前，再将索引 0 (goal) 拖到索引 2 (compact) 之后
    const row0 = shadow.querySelector('[data-preset-item="quickItems:0"]');
    const row2 = shadow.querySelector('[data-preset-item="quickItems:2"]');
    assert.equal(row0.getAttribute('draggable'), 'true');
    assert.ok(row0.querySelector('.ag-drag-handle'));
    row2.dispatchEvent({ type: 'dragstart', dataTransfer: { setData() {} } });
    row0.dispatchEvent({ type: 'dragover', preventDefault() {} });
    row0.dispatchEvent({ type: 'drop', preventDefault() {}, dataTransfer: { getData: () => '2' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(host.getPluginSettings('demo.composer').quickItems, ['goal', 'plan', 'compact']);

    const afterRow0 = shadow.querySelector('[data-preset-item="quickItems:0"]');
    const afterRow2 = shadow.querySelector('[data-preset-item="quickItems:2"]');
    afterRow0.dispatchEvent({ type: 'dragstart', dataTransfer: { setData() {} } });
    afterRow2.dispatchEvent({ type: 'dragover', preventDefault() {} });
    afterRow2.dispatchEvent({ type: 'drop', preventDefault() {}, dataTransfer: { getData: () => '0' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(host.getPluginSettings('demo.composer').quickItems, ['plan', 'compact', 'goal']);

    const lblIn = shadow.querySelector('[data-preset-custom-label="quickItems"]');
    const txtIn = shadow.querySelector('[data-preset-custom-text="quickItems"]');
    lblIn.value = '代码审查';
    lblIn.dispatchEvent({ type: 'input', target: lblIn });
    txtIn.value = '请审查改动';
    txtIn.dispatchEvent({ type: 'input', target: txtIn });
    shadow.querySelector('[data-list-add="quickItems"]').click();
    await new Promise((r) => setTimeout(r, 20));
    const itemsAfterCustom = host.getPluginSettings('demo.composer').quickItems;
    assert.equal(itemsAfterCustom.length, 4);
    assert.equal(JSON.parse(itemsAfterCustom[3]).label, '代码审查');

    shadow.querySelector('[data-list-remove="quickItems:0"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(host.getPluginSettings('demo.composer').quickItems[0], 'compact');

    shadow.querySelector('[data-preset-reset="quickItems"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(host.getPluginSettings('demo.composer').quickItems, DEFAULT_ITEMS);
  } finally {
    await host.dispose();
  }
});

test('插件设置详情页支持 markdown-modal 弹窗渲染编辑与 shortcut 快捷键录入（Esc 仅关子弹窗/取消录制）', async () => {
  const doc = createMockDocument();
  const anchorsRegistry = buildFullAnchorsRegistry();
  const DEFAULT_MD = [
    '# 提示词说明',
    '1. **清晰表达**：输入 `{{draft}}`',
    '   - 保持语言一致',
    '> **限制**：仅输出正文'
  ].join('\n');
  let currentSettings = {
    optShortcut: 'Alt+Shift+O',
    promptModal: DEFAULT_MD
  };

  const { fetchFn } = createMockBridgeFetch({
    '/host/plugins/settings': async (body) => {
      currentSettings = { ...currentSettings, ...(body.values || {}) };
      return { ok: true, values: { ...currentSettings } };
    }
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19999,
    hostToken: 'tok-modal-shortcut',
    anchorsRegistry,
    pluginMeta: {
      'demo.promptui': {
        id: 'demo.promptui',
        displayName: 'Prompt Modal Demo',
        trustLevel: 'T0',
        enabled: true,
        active: true,
        settingsSchema: {
          fields: [
            {
              key: 'optShortcut',
              type: 'string',
              editorMode: 'shortcut',
              resetToDefault: true,
              default: 'Alt+Shift+O',
              label: '优化快捷键'
            },
            {
              key: 'promptModal',
              type: 'string',
              editorMode: 'markdown-modal',
              resetToDefault: true,
              openButtonLabel: '查看 / 编辑提示词',
              modalTitle: '优化指令模板',
              default: DEFAULT_MD,
              label: '优化指令'
            }
          ]
        },
        settingsValues: { ...currentSettings }
      }
    }
  });

  try {
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.promptui' });
    await new Promise((r) => setTimeout(r, 30));
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 1. markdown-modal 在详情页只渲染入口按钮与状态，不内联截断 input 或大 textarea
    assert.equal(shadow.querySelector('textarea[data-setting-key="promptModal"]'), null);
    assert.equal(shadow.querySelector('input[data-setting-key="promptModal"]'), null);
    const metaChip = shadow.querySelector('[data-markdown-modal-meta="promptModal"]');
    assert.ok(metaChip);
    assert.match(metaChip.textContent, /默认/);

    const openBtn = shadow.querySelector('[data-markdown-modal-open="promptModal"]');
    assert.ok(openBtn);
    assert.match(openBtn.textContent, /查看 \/ 编辑提示词/);
    openBtn.click();

    const modalBackdrop = shadow.querySelector('#agy-field-modal-backdrop');
    assert.ok(modalBackdrop);
    const previewEl = shadow.querySelector('[data-field-modal-preview="true"]');
    assert.ok(previewEl);
    assert.match(previewEl.innerHTML, /<h1 class="ag-md-h1">提示词说明<\/h1>/);
    assert.match(previewEl.innerHTML, /<ol class="ag-md-ol"><li><strong>清晰表达<\/strong>/);
    assert.match(previewEl.innerHTML, /<code class="ag-md-code">\{\{draft\}\}<\/code>/);
    assert.match(previewEl.innerHTML, /<ul class="ag-md-ul ag-md-ul-nested"><li>保持语言一致<\/li><\/ul>/);
    assert.match(previewEl.innerHTML, /<blockquote class="ag-md-quote"><strong>限制<\/strong>：仅输出正文<\/blockquote>/);

    // 2. 切到编辑模式：注入 XSS 脚本验证转义，切回预览后转义生效且未被执行
    shadow.querySelector('[data-field-modal-tab="edit"]').click();
    const modalTa = shadow.querySelector('[data-field-modal-textarea="promptModal"]');
    assert.ok(modalTa);
    modalTa.value = '## 新模板\n<script>alert(1)</script>\n\n**加粗** `code` {{draft}}';
    modalTa.dispatchEvent({ type: 'input', target: modalTa });

    shadow.querySelector('[data-field-modal-tab="preview"]').click();
    const previewAfter = shadow.querySelector('[data-field-modal-preview="true"]');
    assert.match(previewAfter.innerHTML, /<h2 class="ag-md-h2">新模板<\/h2>/);
    assert.match(previewAfter.innerHTML, /<span class="ag-md-var">\{\{draft\}\}<\/span>/);
    assert.ok(!previewAfter.innerHTML.includes('<script>'));
    assert.match(previewAfter.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

    // 按 Escape 仅关闭子弹窗，设置弹窗必须保持打开
    let escStopped = false;
    doc.dispatchEvent({
      type: 'keydown',
      key: 'Escape',
      preventDefault() {},
      stopPropagation() { escStopped = true; }
    });
    assert.equal(escStopped, true);
    assert.equal(shadow.querySelector('#agy-field-modal-backdrop'), null);
    assert.equal(host.getSettingsMode(), 'modal');

    // 重新打开后编辑保存 -> 状态转为“已自定义”，再打开恢复默认并保存
    shadow.querySelector('[data-markdown-modal-open="promptModal"]').click();
    shadow.querySelector('[data-field-modal-tab="edit"]').click();
    const ta2 = shadow.querySelector('[data-field-modal-textarea="promptModal"]');
    ta2.value = 'CUSTOM_MD\n{{draft}}';
    ta2.dispatchEvent({ type: 'input', target: ta2 });
    shadow.querySelector('[data-field-modal-save="promptModal"]').click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(host.getPluginSettings('demo.promptui').promptModal, 'CUSTOM_MD\n{{draft}}');
    assert.match(shadow.querySelector('[data-markdown-modal-meta="promptModal"]').textContent, /已自定义/);

    shadow.querySelector('[data-markdown-modal-open="promptModal"]').click();
    shadow.querySelector('[data-field-modal-reset="promptModal"]').click();
    shadow.querySelector('[data-field-modal-save="promptModal"]').click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(host.getPluginSettings('demo.promptui').promptModal, DEFAULT_MD);

    // 3. shortcut 快捷键录入、校验拒绝纯单键、Escape 取消录制、清除与恢复默认
    const scInput = shadow.querySelector('[data-shortcut-input="optShortcut"]');
    assert.ok(scInput);
    assert.equal(scInput.value, 'Alt+Shift+O');

    scInput.dispatchEvent({ type: 'focus', target: scInput });
    assert.equal(scInput.getAttribute('data-recording'), 'true');

    // 纯字母无修饰键应拒绝
    scInput.dispatchEvent({
      type: 'keydown',
      key: 'a',
      code: 'KeyA',
      preventDefault() {},
      stopPropagation() {}
    });
    assert.ok(shadow.textContent.includes('修饰键'));
    assert.equal(host.getPluginSettings('demo.promptui').optShortcut, 'Alt+Shift+O');

    // Escape 仅取消录制，不关闭设置窗
    doc.dispatchEvent({
      type: 'keydown',
      key: 'Escape',
      preventDefault() {},
      stopPropagation() {}
    });
    assert.equal(host.getSettingsMode(), 'modal');

    // 重新录制 Alt+Shift+K（模拟 macOS Option key 字符 '˚'）
    const scInput2 = shadow.querySelector('[data-shortcut-input="optShortcut"]');
    scInput2.dispatchEvent({ type: 'focus', target: scInput2 });
    scInput2.dispatchEvent({
      type: 'keydown',
      key: '˚',
      code: 'KeyK',
      altKey: true,
      shiftKey: true,
      preventDefault() {},
      stopPropagation() {}
    });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(host.getPluginSettings('demo.promptui').optShortcut, 'Alt+Shift+K');
    assert.equal(shadow.querySelector('[data-shortcut-input="optShortcut"]').value, 'Alt+Shift+K');

    // 清除与恢复默认
    shadow.querySelector('[data-shortcut-clear="optShortcut"]').click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(host.getPluginSettings('demo.promptui').optShortcut, '');

    shadow.querySelector('[data-shortcut-reset="optShortcut"]').click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(host.getPluginSettings('demo.promptui').optShortcut, 'Alt+Shift+O');
  } finally {
    await host.dispose();
  }
});

test('插件市场卡片展示 GitHub 收藏数与 GitHub/npm 下载次数，本地安装插件不统计', async () => {
  const doc = createMockDocument();
  const { calls, fetchFn } = createMockBridgeFetch({
    '/host/plugins': () => ({
      ok: true,
      plugins: [
        {
          id: 'local.installed',
          displayName: '本地插件',
          description: '本地目录软链安装',
          version: '1.0.0',
          trustLevel: 'T2',
          enabled: true,
          active: true,
          sourceKind: 'local',
          sourceSpec: 'local:/tmp/local-installed'
        }
      ],
      catalog: [
        {
          id: 'agy-daddy.cli',
          displayName: 'CLI 终端启动器',
          description: '顶栏 CLI 胶囊',
          version: '1.0.0',
          trustLevel: 'T0',
          recommendedSpec: 'cli',
          repo: 'https://github.com/agy-daddy/agy-daddy.git',
          npmPackage: '@agy-daddy/plugin-cli'
        },
        {
          id: 'community.notes',
          displayName: '社区笔记',
          description: '仅 GitHub 发布',
          version: '1.2.0',
          trustLevel: 'T1',
          recommendedSpec: 'github:alice/agy-notes'
        }
      ],
      marketStats: {}
    }),
    '/host/marketplace/stats': (body) => {
      const mult = body?.forceRefresh ? 2 : 1;
      return {
        ok: true,
        stats: {
          'agy-daddy.cli': {
            eligible: true,
            githubRepo: 'agy-daddy/agy-daddy',
            npmPackage: '@agy-daddy/plugin-cli',
            githubStars: 1250 * mult,
            downloads: 3500 * mult,
            githubDownloads: 1000 * mult,
            npmDownloads: 2500 * mult,
            fetchedAt: Date.now()
          },
          'community.notes': {
            eligible: true,
            githubRepo: 'alice/agy-notes',
            npmPackage: null,
            githubStars: 42 * mult,
            downloads: 310 * mult,
            githubDownloads: 310 * mult,
            npmDownloads: null,
            fetchedAt: Date.now()
          },
          'local.installed': {
            eligible: false,
            githubRepo: null,
            npmPackage: null,
            githubStars: null,
            downloads: null,
            githubDownloads: null,
            npmDownloads: null,
            fetchedAt: null
          }
        }
      };
    }
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19995,
    hostToken: 'secret-token',
    anchorsRegistry: buildFullAnchorsRegistry()
  });

  try {
    await host.openSettings({ tab: 'plugins' });
    await new Promise((r) => setTimeout(r, 40));

    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    assert.ok(calls.some((c) => c.path === '/host/marketplace/stats' && c.body?.forceRefresh === false));

    // 预览区前 3 张卡片正确渲染 GitHub 收藏数、下载次数与本地排除态
    const cliCard = shadow.querySelector('[data-catalog-id="agy-daddy.cli"]');
    assert.ok(cliCard);
    const cliStars = cliCard.querySelector('[data-market-stat="stars"]');
    const cliDownloads = cliCard.querySelector('[data-market-stat="downloads"]');
    assert.ok(cliStars && cliDownloads);
    assert.equal(cliStars.textContent, '1.3k');
    assert.equal(cliDownloads.textContent, '3.5k');
    assert.match(cliDownloads.getAttribute('title'), /GitHub 1000 \+ npm 2500/);
    assert.match(cliDownloads.getAttribute('title'), /不含本地安装/);

    const notesCard = shadow.querySelector('[data-catalog-id="community.notes"]');
    assert.ok(notesCard);
    assert.equal(notesCard.querySelector('[data-market-stat="stars"]').textContent, '42');
    assert.equal(notesCard.querySelector('[data-market-stat="downloads"]').textContent, '310');

    const localCard = shadow.querySelector('[data-market-installed-id="local.installed"]');
    assert.ok(localCard);
    assert.equal(localCard.querySelector('[data-market-stat="stars"]'), null);
    assert.equal(localCard.querySelector('[data-market-stat="downloads"]'), null);
    const localBadge = localCard.querySelector('[data-market-stat="local"]');
    assert.ok(localBadge);
    assert.equal(localBadge.textContent, '仅本地安装');

    // 进入完整市场视图并点击「刷新目录」应携带 forceRefresh: true 并更新展示
    shadow.querySelector('#agy-marketplace-more-btn').click();
    const fullGrid = shadow.querySelector('#agy-marketplace-full-grid');
    assert.ok(fullGrid);
    const refreshBtn = shadow.querySelector('#agy-marketplace-refresh-btn');
    assert.ok(refreshBtn);
    refreshBtn.click();
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(calls.some((c) => c.path === '/host/marketplace/stats' && c.body?.forceRefresh === true));
    const cliCardAfter = shadow.querySelector('#agy-marketplace-full-grid').querySelector('[data-catalog-id="agy-daddy.cli"]');
    assert.equal(cliCardAfter.querySelector('[data-market-stat="stars"]').textContent, '2.5k');
    assert.equal(cliCardAfter.querySelector('[data-market-stat="downloads"]').textContent, '7k');
  } finally {
    await host.dispose();
  }
});

test('插件设置详情页支持 boolean field.probe (onlyWhenTruthy) 结构化提示与声明式 field.guide', async () => {
  const doc = createMockDocument();
  let curSettings = { enableTunnel: false, hostName: '' };
  let foundBinary = false;
  const { fetchFn } = createMockBridgeFetch({
    '/host/plugins': async () => ({ ok: true, plugins: [], catalog: [] }),
    '/host/settings': async (body) => {
      if (body?.action === 'update') {
        curSettings = { ...curSettings, ...(body.values || {}) };
      }
      return { ok: true, values: { ...curSettings }, changedKeys: Object.keys(body?.values || {}), rendererNotified: 0 };
    },
    '/host/commands/run': async (body) => {
      if (body?.commandId === 'demo.checkBin') {
        if (foundBinary) {
          return { ok: true, result: { ok: true, found: true, path: '/opt/homebrew/bin/tool', message: '已检测到：/opt/homebrew/bin/tool' } };
        }
        return {
          ok: true,
          result: {
            ok: true,
            found: false,
            error: 'BIN_MISSING',
            title: '未检测到辅助程序',
            message: '请先安装辅助程序：',
            commands: [{ label: 'macOS', command: 'brew install demo-tool' }],
            links: [{ label: '前往控制台', url: 'https://example.com/console' }]
          }
        };
      }
      return { ok: true, result: {} };
    }
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19995,
    hostToken: 'secret-token',
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'demo.callout': {
        id: 'demo.callout',
        displayName: '引导提示测试',
        version: '1.0.0',
        trustLevel: 'T0',
        settingsValues: { ...curSettings },
        settingsSchema: {
          title: '引导测试',
          fields: [
            {
              key: 'enableTunnel',
              type: 'boolean',
              default: false,
              label: '启用隧道',
              probe: {
                command: 'demo.checkBin',
                runOnOpen: true,
                onlyWhenTruthy: true,
                buttonLabel: '重新检测'
              }
            },
            {
              key: 'hostName',
              type: 'string',
              default: '',
              label: '固定域名',
              guide: {
                title: '配置指引',
                steps: ['打开控制台创建隧道', '配置路由 127.0.0.1:18765'],
                commands: [{ label: '服务地址', command: '127.0.0.1:18765' }],
                links: [{ label: '前往控制台', url: 'https://one.dash.cloudflare.com/?to=/:account/networks/tunnels' }]
              }
            }
          ]
        }
      }
    }
  });

  try {
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.callout' });
    await new Promise((r) => setTimeout(r, 30));
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 1. onlyWhenTruthy: false 时不触发 probe 告警框；guide 正常展示
    assert.equal(shadow.querySelector('[data-callout-kind="probe"]'), null);
    const guideBox = shadow.querySelector('[data-callout-kind="guide"]');
    assert.ok(guideBox);
    assert.match(guideBox.textContent, /配置指引/);
    assert.equal(guideBox.querySelector('[data-selectable-code="true"]')?.textContent, '127.0.0.1:18765');
    assert.ok(guideBox.querySelector('[data-callout-copy="hostName:0"]'));
    assert.equal(
      guideBox.querySelector('[data-callout-link="hostName:0"]')?.getAttribute('href'),
      'https://one.dash.cloudflare.com/?to=/:account/networks/tunnels'
    );

    // 2. 开启开关 -> 触发 probe，缺程序时渲染可选中命令与一键复制按钮及外链
    const toggle = shadow.querySelector('[data-setting-key="enableTunnel"]');
    toggle.checked = true;
    toggle.dispatchEvent({ type: 'change', target: toggle });
    await new Promise((r) => setTimeout(r, 40));

    const probeBox = shadow.querySelector('[data-callout-kind="probe"]');
    assert.ok(probeBox);
    assert.equal(probeBox.querySelector('[data-selectable-code="true"]')?.textContent, 'brew install demo-tool');
    const copyBtn = probeBox.querySelector('[data-callout-copy="enableTunnel:0"]');
    assert.ok(copyBtn);
    copyBtn.click();
    assert.equal(copyBtn.textContent, '已复制');
    assert.equal(probeBox.querySelector('[data-callout-link="enableTunnel:0"]')?.getAttribute('href'), 'https://example.com/console');

    // 3. 安装后点「重新检测」-> 变为 ok 提示
    foundBinary = true;
    probeBox.querySelector('[data-field-probe="enableTunnel"]').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(shadow.querySelector('[data-callout-kind="probe"]'), null);
    assert.equal(shadow.querySelector('[data-field-probe-status="ok"]')?.getAttribute('data-field-probe-key'), 'enableTunnel');

    // 4. 关闭开关 -> 清理 probe 提示
    const toggleOff = shadow.querySelector('[data-setting-key="enableTunnel"]');
    toggleOff.checked = false;
    toggleOff.dispatchEvent({ type: 'change', target: toggleOff });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(shadow.querySelector('[data-field-probe-status="ok"]'), null);
  } finally {
    await host.dispose();
  }
});

test('ordered-preset-list 支持动态可添加池、内联触发按钮与 Key-Value 名称/命令序列化', async () => {
  const doc = createMockDocument();
  const anchorsRegistry = buildFullAnchorsRegistry();
  let currentSettings = { quickItems: ['plan'] };
  let dynamicPoolItems = [];
  let summarizeCalls = 0;

  const { fetchFn } = createMockBridgeFetch({
    '/host/commands/run': (body) => {
      if (body?.commandId === 'demo.listFreq') {
        return {
          ok: true,
          result: {
            ok: true,
            presets: dynamicPoolItems,
            meta: { sessionsScanned: summarizeCalls > 0 ? 12 : 0, messagesScanned: summarizeCalls > 0 ? 48 : 0 }
          }
        };
      }
      if (body?.commandId === 'demo.summarizeFreq') {
        summarizeCalls++;
        dynamicPoolItems = [
          {
            id: 'freq_1',
            label: '提交 PR',
            text: '请运行测试后提交 PR 并推送',
            tag: '高频·5次',
            description: '提交 PR',
            source: 'llm-summary'
          }
        ];
        return {
          ok: true,
          result: { ok: true, message: '已提炼 1 条高频词', presets: dynamicPoolItems }
        };
      }
      return { ok: true, result: null };
    },
    '/host/plugins/settings': (body) => {
      currentSettings = { ...currentSettings, ...(body.values || {}) };
      return { ok: true, values: { ...currentSettings } };
    }
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19999,
    hostToken: 'tok-dyn-presets',
    anchorsRegistry,
    pluginMeta: {
      'demo.dyn': {
        id: 'demo.dyn',
        displayName: 'Dynamic Presets',
        version: '1.0.0',
        trustLevel: 'T0',
        settingsSchema: {
          title: 'Dynamic Presets',
          fields: [
            {
              key: 'quickItems',
              type: 'list',
              default: ['plan'],
              label: '快捷条目',
              itemEditor: {
                kind: 'ordered-preset-list',
                allowCustom: true,
                dynamicPresetsCommand: 'demo.listFreq',
                dynamicPoolTitle: '历史高频词',
                dynamicEmptyHint: '暂无高频词',
                dynamicAction: {
                  id: 'summarize-btn',
                  command: 'demo.summarizeFreq',
                  label: '手动总结高频手动发送词'
                },
                presets: [{ id: 'plan', label: '/plan 规划', text: '/plan ' }]
              }
            }
          ]
        },
        settingsValues: { ...currentSettings }
      }
    }
  });

  try {
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.dyn' });
    await new Promise((r) => setTimeout(r, 30));
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    const dynPool = shadow.querySelector('[data-preset-dynamic-pool="quickItems"]');
    assert.ok(dynPool);
    assert.match(dynPool.textContent, /暂无高频词/);

    const triggerBtn = shadow.querySelector('[data-preset-dynamic-action="quickItems"]');
    assert.ok(triggerBtn);
    assert.match(triggerBtn.textContent, /手动总结高频手动发送词/);
    triggerBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(summarizeCalls, 1);

    const addFreqChip = shadow.querySelector('[data-preset-add="quickItems:freq_1"]');
    assert.ok(addFreqChip);
    assert.equal(addFreqChip.getAttribute('data-preset-dynamic'), 'true');
    assert.match(addFreqChip.textContent, /\+ 提交 PR/);
    assert.match(addFreqChip.getAttribute('title') || '', /实际填充：请运行测试后提交 PR 并推送/);

    addFreqChip.click();
    await new Promise((r) => setTimeout(r, 30));
    const saved = host.getPluginSettings('demo.dyn').quickItems;
    assert.equal(saved.length, 2);
    const parsedAdded = JSON.parse(saved[1]);
    assert.equal(parsedAdded.label, '提交 PR');
    assert.equal(parsedAdded.text, '请运行测试后提交 PR 并推送');
    assert.equal(parsedAdded.source, 'llm-summary');

    const activeRow = shadow.querySelector('[data-preset-item="quickItems:1"]');
    assert.ok(activeRow);
    assert.match(activeRow.textContent, /提交 PR/);
    assert.match(activeRow.textContent, /实际填充：请运行测试后提交 PR 并推送/);
  } finally {
    await host.dispose();
  }
});

test('Combobox 选中态显示标签并持久化 ID、声明式 field.composer 拼接编辑恢复默认及关闭后顶栏点击不失效', async () => {
  const doc = createMockDocument();
  let currentSettings = {
    modelId: 'MODEL_PLACEHOLDER_M537',
    permMode: 'skip-permissions',
    composedCmd: ''
  };
  let unitClicks = [];
  const composeFrom = (vals) => {
    const parts = ['agy'];
    if (vals.permMode === 'skip-permissions') parts.push('--dangerously-skip-permissions');
    else if (vals.permMode === 'auto') parts.push('--mode', 'auto');
    if (vals.modelId) {
      const m = String(vals.modelId).trim();
      if (m) {
        parts.push('--model', /^[a-zA-Z0-9._:@/=+-]+$/.test(m) ? m : `'${m.replace(/'/g, "'\\''")}'`);
      }
    }
    return parts.join(' ');
  };

  const { fetchFn } = createMockBridgeFetch({
    '/host/plugins': () => ({ ok: true, plugins: [], catalog: [] }),
    '/host/settings': (body) => {
      Object.assign(currentSettings, body.values || {});
      return { ok: true, values: { ...currentSettings }, changedKeys: Object.keys(body.values || {}), rendererNotified: 0 };
    },
    '/host/commands/run': (body) => {
      if (body.commandId === 'demo.models') {
        return {
          ok: true,
          result: {
            ok: true,
            options: [
              { value: 'MODEL_PLACEHOLDER_M537', label: 'Gemini 4 Neon' },
              { value: 'MODEL_CLAUDE_46', label: 'Claude Opus 4.6' }
            ]
          }
        };
      }
      if (body.commandId === 'demo.composeCmd') {
        const arg = (body.args && body.args[0]) || {};
        const vals = arg.values || currentSettings;
        const cmd = composeFrom(vals);
        return { ok: true, result: { ok: true, value: cmd, command: cmd } };
      }
      return { ok: true, result: {} };
    }
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19996,
    hostToken: 'secret-token',
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'demo.compose': {
        id: 'demo.compose',
        displayName: 'Composer & Combobox 测试',
        trustLevel: 'T0',
        world: 'main',
        enabled: true,
        active: true,
        settingsSchema: {
          title: 'Composer 测试',
          fields: [
            {
              key: 'modelId',
              type: 'string',
              default: '',
              label: '模型',
              options: [{ value: '', label: '沿用默认（留空）' }],
              optionsCommand: 'demo.models'
            },
            {
              key: 'permMode',
              type: 'enum',
              default: 'default',
              label: '权限模式',
              options: [
                { value: 'default', label: '默认' },
                { value: 'auto', label: '自动执行' },
                { value: 'skip-permissions', label: '免审核' }
              ]
            },
            {
              key: 'composedCmd',
              type: 'string',
              default: '',
              label: '默认启动命令',
              composer: {
                command: 'demo.composeCmd',
                watchKeys: ['modelId', 'permMode'],
                resetLabel: '恢复默认',
                runOnOpen: true
              }
            }
          ]
        },
        settingsValues: { ...currentSettings }
      }
    }
  });

  try {
    await host.mountPlugin('demo.compose', {
      mount(ctx) {
        const stop = ctx.topbar.registerUnit({
          id: 'main',
          order: 10,
          label: 'Demo',
          onClick() {
            unitClicks.push('clicked');
          }
        });
        return stop;
      }
    });

    await host.openSettings({ tab: 'plugins', pluginId: 'demo.compose' });
    await new Promise((r) => setTimeout(r, 40));
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 1. Combobox 初始回显与动态选项加载后，输入框显示 Display Name 而非内部 ID
    const comboInput1 = shadow.querySelector('[data-combobox-input="modelId"]');
    assert.equal(comboInput1.value, 'Gemini 4 Neon');
    assert.equal(comboInput1.getAttribute('data-setting-value'), 'MODEL_PLACEHOLDER_M537');
    assert.equal(host.getPluginSettings('demo.compose').modelId, 'MODEL_PLACEHOLDER_M537');

    // 且初次打开空白 composedCmd 时自动按当前选项拼接填充
    assert.equal(
      host.getPluginSettings('demo.compose').composedCmd,
      'agy --dangerously-skip-permissions --model MODEL_PLACEHOLDER_M537'
    );
    assert.equal(
      shadow.querySelector('[data-composer-input="composedCmd"]').value,
      'agy --dangerously-skip-permissions --model MODEL_PLACEHOLDER_M537'
    );

    // 2. 点击下拉选项 Claude Opus 4.6 -> 输入框显示名称，底层存 ID，同时自动联动更新命令输入框
    comboInput1.dispatchEvent({ type: 'focus', target: comboInput1 });
    const claudeOpt = shadow.querySelector('[data-option-value="MODEL_CLAUDE_46"]');
    assert.ok(claudeOpt);
    claudeOpt.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(host.getPluginSettings('demo.compose').modelId, 'MODEL_CLAUDE_46');
    assert.equal(shadow.querySelector('[data-combobox-input="modelId"]').value, 'Claude Opus 4.6');
    assert.equal(
      shadow.querySelector('[data-composer-input="composedCmd"]').value,
      'agy --dangerously-skip-permissions --model MODEL_CLAUDE_46'
    );

    // 3. 切换为带空格/特殊字符的自定义模型后，安全引用并可直接在命令输入框手动编辑追加参数
    const comboInput2 = shadow.querySelector('[data-combobox-input="modelId"]');
    comboInput2.value = "custom 'model' $v2";
    comboInput2.dispatchEvent({ type: 'change', target: comboInput2 });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(
      shadow.querySelector('[data-composer-input="composedCmd"]').value,
      "agy --dangerously-skip-permissions --model 'custom '\\''model'\\'' $v2'"
    );

    const cmdInput = shadow.querySelector('[data-composer-input="composedCmd"]');
    cmdInput.value = `${cmdInput.value} --sandbox`;
    cmdInput.dispatchEvent({ type: 'change', target: cmdInput });
    await new Promise((r) => setTimeout(r, 30));
    assert.match(host.getPluginSettings('demo.compose').composedCmd, /--sandbox$/);

    // 4. 点「恢复默认」按钮：清空手工追加，按当前配置项重新生成并覆盖回输入框
    shadow.querySelector('[data-field-composer-reset="composedCmd"]').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(
      shadow.querySelector('[data-composer-input="composedCmd"]').value,
      "agy --dangerously-skip-permissions --model 'custom '\\''model'\\'' $v2'"
    );

    // 5. 空参数边界：选中空模型 + 默认权限 -> 生成纯 'agy'，不抛错且下拉框显示空 placeholder
    const permSel = shadow.querySelector('[data-setting-key="permMode"]');
    permSel.value = 'default';
    permSel.dispatchEvent({ type: 'change', target: permSel });
    await new Promise((r) => setTimeout(r, 30));

    const comboInput3 = shadow.querySelector('[data-combobox-input="modelId"]');
    comboInput3.dispatchEvent({ type: 'focus', target: comboInput3 });
    shadow.querySelector('[data-option-value=""]').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(host.getPluginSettings('demo.compose').modelId, '');
    assert.equal(shadow.querySelector('[data-combobox-input="modelId"]').value, '');
    assert.equal(shadow.querySelector('[data-composer-input="composedCmd"]').value, 'agy');

    // 6. 关闭设置面板后，验证顶栏单元仍正常响应点击
    host.closeSettings();
    const topBtn = shadow.querySelector('[data-agy-slot="unit:demo.compose:main"]');
    assert.ok(topBtn);
    topBtn.click();
    assert.deepEqual(unitClicks, ['clicked']);
  } finally {
    await host.dispose();
  }
});

test('运行与诊断：全量重新载入、重启守护进程、initialView 自动恢复与 dispose 竞态保护', async () => {
  const doc = createMockDocument();
  let resolveSlowReload = null;
  const { calls, fetchFn } = createMockBridgeFetch({
    '/host/reload-all': (body) => {
      if (body?.restoreView?.diagnosticsExpanded === true && resolveSlowReload === 'pending') {
        return new Promise((resolve) => {
          resolveSlowReload = resolve;
        });
      }
      return {
        ok: true,
        rendererRebuilt: true,
        reloadedCount: 2,
        activationErrors: [],
        plugins: [],
        catalog: []
      };
    },
    '/host/daemon/restart': () => ({
      ok: true,
      scheduled: false,
      dryRun: true,
      mode: 'test',
      rendererRebuilt: true
    })
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19998,
    hostToken: 'tok-diag-reload',
    anchorsRegistry: buildFullAnchorsRegistry()
  });

  try {
    await host.openSettings({ tab: 'plugins' });
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    const reloadAllBtn = shadow.querySelector('#agy-reload-all-btn');
    const restartDaemonBtn = shadow.querySelector('#agy-restart-daemon-btn');
    assert.ok(reloadAllBtn);
    assert.ok(restartDaemonBtn);
    assert.equal(reloadAllBtn.disabled, false);
    assert.equal(restartDaemonBtn.disabled, false);

    // 1. 点击「重新载入」
    reloadAllBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    const reloadCall = calls.find((c) => c.path === '/host/reload-all');
    assert.ok(reloadCall);
    assert.equal(reloadCall.body.rebuildRenderer, true);
    assert.deepEqual(reloadCall.body.restoreView, {
      open: true,
      tab: 'plugins',
      diagnosticsExpanded: false
    });
    assert.match(shadow.querySelector('#agy-manage-toast')?.textContent || '', /已重新载入最新代码（2 个插件 · 渲染层已重建）/);

    // 2. 点击「重启守护进程」
    shadow.querySelector('#agy-restart-daemon-btn').click();
    await new Promise((r) => setTimeout(r, 30));
    const restartCall = calls.find((c) => c.path === '/host/daemon/restart');
    assert.ok(restartCall);
    assert.equal(restartCall.body.rebuildRenderer, true);
    assert.match(shadow.querySelector('#agy-manage-toast')?.textContent || '', /测试模式已跳过守护进程重启/);

    // 3. 验证 runManageAction 在请求未完成时宿主被 dispose() 不抛异常
    shadow.querySelector('#agy-diagnostics-detail-toggle').click();
    resolveSlowReload = 'pending';
    shadow.querySelector('#agy-reload-all-btn').click();
    await host.dispose();
    if (typeof resolveSlowReload === 'function') {
      resolveSlowReload({ ok: true, reloadedCount: 0, activationErrors: [] });
    }
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    await host.dispose();
  }

  // 4. 验证 initialView 自动打开设置页、展开诊断明细并显示 toast
  const doc2 = createMockDocument();
  const host2 = createHostRuntime({
    document: doc2,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    anchorsRegistry: buildFullAnchorsRegistry(),
    initialView: {
      open: true,
      tab: 'plugins',
      diagnosticsExpanded: true,
      toast: { tone: 'info', text: '已重新载入最新代码（1 个插件）' }
    }
  });
  try {
    await new Promise((r) => setTimeout(r, 30));
    assert.notEqual(host2.getSettingsMode(), 'closed');
    const shadow2 = doc2.getElementById('agy-daddy-host').shadowRoot;
    assert.equal(shadow2.querySelector('#agy-diagnostics-detail-body').hidden, false);
    assert.match(shadow2.querySelector('#agy-manage-toast')?.textContent || '', /已重新载入最新代码（1 个插件）/);
  } finally {
    await host2.dispose();
  }
});

test('通用排序交互边界：普通 list 拖拽、键盘 ↑/↓ 无障碍排序、跨列表拦截与单元素禁用态', async () => {
  const doc = createMockDocument();
  const anchorsRegistry = buildFullAnchorsRegistry();
  let currentSettings = {
    tagsA: ['alpha', 'beta', 'gamma'],
    tagsB: ['only-one']
  };

  const { fetchFn } = createMockBridgeFetch({
    '/host/plugins/settings': async (body) => {
      currentSettings = { ...currentSettings, ...(body.values || {}) };
      return { ok: true, values: { ...currentSettings } };
    }
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19999,
    hostToken: 'tok-drag-edge',
    anchorsRegistry,
    pluginMeta: {
      'demo.lists': {
        id: 'demo.lists',
        displayName: 'List Edge Demo',
        version: '1.0.0',
        trustLevel: 'T0',
        settingsSchema: {
          title: 'List Edge Demo',
          fields: [
            { key: 'tagsA', type: 'list', label: '列表 A', default: [] },
            { key: 'tagsB', type: 'list', label: '列表 B', default: [] }
          ]
        },
        settingsValues: { ...currentSettings }
      }
    }
  });

  try {
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.lists' });
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 1. 单元素列表应禁用拖拽手柄
    const singleRow = shadow.querySelector('[data-list-item="tagsB:0"]');
    const singleHandle = singleRow.querySelector('.ag-drag-handle');
    assert.equal(singleRow.getAttribute('draggable'), 'false');
    assert.equal(singleRow.getAttribute('data-drag-disabled'), 'true');
    assert.equal(singleHandle.getAttribute('aria-disabled'), 'true');

    // 2. 通用 list 拖拽：将 gamma (2) 拖到 alpha (0) 之前 -> ['gamma', 'alpha', 'beta']
    const row0 = shadow.querySelector('[data-list-item="tagsA:0"]');
    const row2 = shadow.querySelector('[data-list-item="tagsA:2"]');
    assert.equal(row0.getAttribute('draggable'), 'true');
    row2.dispatchEvent({ type: 'dragstart', dataTransfer: { setData() {} } });
    // 跨列表落位到 tagsB:0 不应破坏任一列表
    singleRow.dispatchEvent({ type: 'dragover', preventDefault() {} });
    singleRow.dispatchEvent({ type: 'drop', preventDefault() {}, dataTransfer: { getData: () => '2' } });
    assert.deepEqual(host.getPluginSettings('demo.lists').tagsA, ['alpha', 'beta', 'gamma']);
    assert.deepEqual(host.getPluginSettings('demo.lists').tagsB, ['only-one']);

    // 落位到同列表目标 row0
    row0.dispatchEvent({ type: 'dragover', preventDefault() {} });
    row0.dispatchEvent({ type: 'drop', preventDefault() {}, dataTransfer: { getData: () => '2' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(host.getPluginSettings('demo.lists').tagsA, ['gamma', 'alpha', 'beta']);

    // 3. 键盘无障碍备用：聚焦手柄按 ArrowDown / ArrowUp 调整顺序
    const handle0 = shadow.querySelector('[data-drag-handle="demo.lists:tagsA:0"]');
    assert.equal(handle0.getAttribute('role'), 'button');
    assert.equal(handle0.getAttribute('tabindex'), '0');
    handle0.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(host.getPluginSettings('demo.lists').tagsA, ['alpha', 'gamma', 'beta']);

    const handle2 = shadow.querySelector('[data-drag-handle="demo.lists:tagsA:2"]');
    handle2.dispatchEvent({ type: 'keydown', key: 'ArrowUp', preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(host.getPluginSettings('demo.lists').tagsA, ['alpha', 'beta', 'gamma']);
  } finally {
    await host.dispose();
  }
});

test('Settings UI: list 类型字段配置 browse 后渲染「浏览」按钮，支持选择目录添加、去重、取消与错误恢复', async () => {
  const { validateSettingsSchema } = require('../src/contracts/manifest-validator');
  const validSchema = validateSettingsSchema({
    fields: [
      {
        key: 'allowedRoots',
        type: 'list',
        default: [],
        label: '允许访问的工作区根目录白名单',
        browse: { command: 'demo.browseRoot', label: '浏览' }
      }
    ]
  });
  assert.equal(validSchema.ok, true, `Expected valid schema: ${validSchema.errors.join('; ')}`);

  const invalidSchema = validateSettingsSchema({
    fields: [
      {
        key: 'badNum',
        type: 'number',
        browse: { command: 'demo.browseRoot' }
      }
    ]
  });
  assert.equal(invalidSchema.ok, false);

  const doc = createMockDocument();
  const anchorsRegistry = buildFullAnchorsRegistry();
  let currentSettings = { allowedRoots: ['/repo/alpha'] };
  let browseState = 'pick_beta';

  const { fetchFn } = createMockBridgeFetch({
    '/host/plugins/settings': async (body) => {
      currentSettings = { ...currentSettings, ...(body.values || {}) };
      return { ok: true, values: { ...currentSettings } };
    },
    '/host/commands/run': async (body) => {
      if (body.commandId === 'demo.browseRoot') {
        if (browseState === 'pick_beta') return { ok: true, result: { ok: true, cancelled: false, path: '/repo/beta' } };
        if (browseState === 'pick_dup') return { ok: true, result: { ok: true, cancelled: false, path: '/repo/beta' } };
        if (browseState === 'cancel') return { ok: true, result: { ok: true, cancelled: true, path: '' } };
        if (browseState === 'fail') return { ok: true, result: { ok: false, error: 'DIALOG_FAILED' } };
      }
      return { ok: false, error: 'UNKNOWN_COMMAND' };
    }
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19999,
    hostToken: 'tok-list-browse',
    anchorsRegistry,
    pluginMeta: {
      'demo.roots': {
        id: 'demo.roots',
        displayName: 'Roots Demo',
        version: '1.0.0',
        trustLevel: 'T0',
        settingsSchema: {
          title: 'Roots Demo',
          fields: [
            {
              key: 'allowedRoots',
              type: 'list',
              default: [],
              label: '允许访问的工作区根目录白名单',
              browse: { command: 'demo.browseRoot', label: '浏览' }
            }
          ]
        },
        settingsValues: { ...currentSettings }
      }
    }
  });

  try {
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.roots' });
    await new Promise((r) => setTimeout(r, 20));
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    const browseBtn = shadow.querySelector('[data-list-browse="allowedRoots"]');
    assert.ok(browseBtn);
    assert.equal(browseBtn.getAttribute('data-field-browse'), 'allowedRoots');

    // 1. 浏览添加新目录 /repo/beta
    browseBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(host.getPluginSettings('demo.roots').allowedRoots, ['/repo/alpha', '/repo/beta']);

    // 2. 重复选择 /repo/beta 不重复插入
    browseState = 'pick_dup';
    shadow.querySelector('[data-list-browse="allowedRoots"]').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(host.getPluginSettings('demo.roots').allowedRoots, ['/repo/alpha', '/repo/beta']);
    assert.match(shadow.querySelector('#agy-manage-toast').textContent, /已在白名单中/);

    // 3. 取消选择不修改列表
    browseState = 'cancel';
    shadow.querySelector('[data-list-browse="allowedRoots"]').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(host.getPluginSettings('demo.roots').allowedRoots, ['/repo/alpha', '/repo/beta']);

    // 4. 失败时展示行内错误并恢复按钮可用
    browseState = 'fail';
    shadow.querySelector('[data-list-browse="allowedRoots"]').click();
    await new Promise((r) => setTimeout(r, 30));
    const errEl = shadow.querySelector('[data-field-error="allowedRoots"]');
    assert.ok(errEl);
    assert.match(errEl.textContent, /DIALOG_FAILED/);
    assert.equal(shadow.querySelector('[data-list-browse="allowedRoots"]').disabled, false);
  } finally {
    await host.dispose();
  }
});

test('Settings UI: catalog-filter-sort 支持模型名称/维度过滤、重置筛选、多规则排序与显示/排序持久化', async () => {
  const { validateSettingsSchema } = require('../src/contracts/manifest-validator');
  const validSchema = validateSettingsSchema({
    fields: [
      {
        key: 'modelSortMode',
        type: 'enum',
        default: 'custom',
        options: [
          { value: 'custom', label: '自定义排序' },
          { value: 'name_asc', label: '名称 A → Z' },
          { value: 'name_desc', label: '名称 Z → A' },
          { value: 'frequency', label: '按使用频率' }
        ]
      },
      {
        key: 'modelFilterOrder',
        type: 'list',
        default: [],
        itemEditor: {
          kind: 'catalog-filter-sort',
          itemsCommand: 'demo.listCatalogModels',
          sortModeKey: 'modelSortMode',
          filterDimensions: [
            { id: 'all', label: '全部' },
            { id: 'gemini', label: 'Gemini' },
            { id: 'claude', label: 'Claude' },
            { id: 'hidden', label: '仅已隐藏' }
          ]
        }
      }
    ]
  });
  assert.equal(validSchema.ok, true, `Expected valid schema: ${validSchema.errors.join('; ')}`);

  const badSchema = validateSettingsSchema({
    fields: [
      {
        key: 'broken',
        type: 'list',
        itemEditor: { kind: 'catalog-filter-sort' }
      }
    ]
  });
  assert.equal(badSchema.ok, false);

  const doc = createMockDocument();
  const anchorsRegistry = buildFullAnchorsRegistry();
  let currentSettings = { modelSortMode: 'custom', modelFilterOrder: [] };
  const catalogItems = [
    { id: 'm-neon', label: 'Gemini 4 Neon', category: 'gemini', frequency: 5 },
    { id: 'm-opus', label: 'Claude Opus 5.5', category: 'claude', frequency: 20 },
    { id: 'm-argon', label: 'Argon Flash', category: 'gemini', frequency: 2 }
  ];

  const { fetchFn } = createMockBridgeFetch({
    '/host/plugins/settings': async (body) => {
      currentSettings = { ...currentSettings, ...(body.values || {}) };
      return { ok: true, values: { ...currentSettings } };
    },
    '/host/commands/run': async (body) => {
      if (body.commandId === 'demo.listCatalogModels') {
        return { ok: true, result: { ok: true, items: catalogItems } };
      }
      return { ok: false, error: 'UNKNOWN_COMMAND' };
    }
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19999,
    hostToken: 'tok-catalog-filter',
    anchorsRegistry,
    pluginMeta: {
      'demo.catalog': {
        id: 'demo.catalog',
        displayName: 'Catalog Demo',
        version: '1.0.0',
        trustLevel: 'T0',
        settingsSchema: {
          title: 'Catalog Demo',
          fields: [
            {
              key: 'modelSortMode',
              type: 'enum',
              default: 'custom',
              label: '排序方式',
              options: [
                { value: 'custom', label: '自定义排序' },
                { value: 'name_asc', label: '名称 A → Z' },
                { value: 'name_desc', label: '名称 Z → A' },
                { value: 'frequency', label: '按使用频率' }
              ]
            },
            {
              key: 'modelFilterOrder',
              type: 'list',
              default: [],
              label: '模型过滤与排序',
              itemEditor: {
                kind: 'catalog-filter-sort',
                itemsCommand: 'demo.listCatalogModels',
                sortModeKey: 'modelSortMode',
                filterDimensions: [
                  { id: 'all', label: '全部' },
                  { id: 'gemini', label: 'Gemini' },
                  { id: 'claude', label: 'Claude' },
                  { id: 'hidden', label: '仅已隐藏' }
                ]
              }
            }
          ]
        },
        settingsValues: { ...currentSettings }
      }
    }
  });

  try {
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.catalog' });
    await new Promise((r) => setTimeout(r, 40));
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    // 1. 初始加载 3 项
    const rowsWrap = shadow.querySelector('[data-catalog-rows="modelFilterOrder"]');
    assert.ok(rowsWrap);
    assert.equal(rowsWrap.querySelectorAll('[data-catalog-item]').length, 3);

    // 2. 关键字过滤 + 维度过滤 + 重置筛选
    const searchInput = shadow.querySelector('[data-catalog-search="modelFilterOrder"]');
    searchInput.value = 'Opus';
    searchInput.dispatchEvent({ type: 'input', target: searchInput });
    assert.equal(rowsWrap.querySelectorAll('[data-catalog-item]').length, 1);
    assert.ok(rowsWrap.querySelector('[data-catalog-item="modelFilterOrder:m-opus"]'));

    shadow.querySelector('[data-catalog-filter-reset="modelFilterOrder"]').click();
    assert.equal(rowsWrap.querySelectorAll('[data-catalog-item]').length, 3);

    shadow.querySelector('[data-catalog-dim="modelFilterOrder:gemini"]').click();
    assert.equal(rowsWrap.querySelectorAll('[data-catalog-item]').length, 2);
    shadow.querySelector('[data-catalog-dim="modelFilterOrder:all"]').click();

    // 3. 排序规则切换（按频率降序 -> Opus (20) 第一；按名称降序 -> Neon 第一）
    const sortSel = shadow.querySelector('[data-catalog-sort="modelFilterOrder"]');
    sortSel.value = 'frequency';
    sortSel.dispatchEvent({ type: 'change', target: sortSel });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(host.getPluginSettings('demo.catalog').modelSortMode, 'frequency');
    const firstFreqItem = shadow.querySelector('[data-catalog-rows="modelFilterOrder"] [data-catalog-item]');
    assert.equal(firstFreqItem.getAttribute('data-catalog-item'), 'modelFilterOrder:m-opus');

    // 4. 隐藏 m-argon 并自定义上移 m-argon/m-neon
    const toggleArgon = shadow.querySelector('[data-catalog-toggle="modelFilterOrder:m-argon"]');
    toggleArgon.checked = false;
    toggleArgon.dispatchEvent({ type: 'change', target: toggleArgon });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(host.getPluginSettings('demo.catalog').modelFilterOrder.includes('!m-argon'));

    shadow.querySelector('[data-catalog-dim="modelFilterOrder:hidden"]').click();
    assert.equal(shadow.querySelectorAll('[data-catalog-rows="modelFilterOrder"] [data-catalog-item]').length, 1);
    shadow.querySelector('[data-catalog-dim="modelFilterOrder:all"]').click();

    // 上移第二项 (m-neon) 到第一位，自动切换为 custom 排序并持久化
    const upNeon = shadow.querySelector('[data-catalog-up="modelFilterOrder:m-neon"]');
    upNeon.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(host.getPluginSettings('demo.catalog').modelSortMode, 'custom');
    assert.equal(host.getPluginSettings('demo.catalog').modelFilterOrder[0], 'm-neon');
  } finally {
    await host.dispose();
  }
});

test('enum 字段支持 optionsCommand 动态选项、新档位校验、已选值保留、不支持提示与离线回退', async () => {
  const doc = createMockDocument();
  let mode = 'dynamic'; // 'dynamic' | 'empty' | 'fallback' | 'error'
  const currentSettings = {
    carbonThinking: 'high',
    argonThinking: 'xhigh',
    neonThinking: 'high'
  };

  const { fetchFn } = createMockBridgeFetch({
    '/host/plugins': () => ({ ok: true, plugins: [], catalog: [] }),
    '/host/settings': (body) => {
      Object.assign(currentSettings, body.values || {});
      return { ok: true, values: { ...currentSettings }, changedKeys: Object.keys(body.values || {}) };
    },
    '/host/commands/run': (body) => {
      if (body.commandId !== 'demo.listThinking') return { ok: true, result: {} };
      const arg = (body.args && body.args[0]) || {};
      if (mode === 'error') {
        return { ok: false, error: 'HOST_OFFLINE' };
      }
      if (mode === 'fallback') {
        return {
          ok: true,
          result: {
            ok: true,
            fallback: true,
            options: [
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'xhigh', label: 'XHigh' }
            ]
          }
        };
      }
      if (mode === 'empty' && arg.fieldKey === 'neonThinking') {
        return {
          ok: true,
          result: {
            ok: true,
            fallback: false,
            supported: false,
            emptyReason: '当前主控模型不支持调节思考等级',
            options: []
          }
        };
      }
      if (arg.fieldKey === 'carbonThinking') {
        return {
          ok: true,
          result: {
            ok: true,
            options: [
              { value: 'minimal', label: 'Minimal · 极速' },
              { value: 'low', label: 'Low · 快速' }
            ]
          }
        };
      }
      if (arg.fieldKey === 'argonThinking') {
        return {
          ok: true,
          result: {
            ok: true,
            options: [
              { value: 'off', label: 'Off · 关闭' },
              { value: 'medium', label: 'Medium · 均衡' },
              { value: 'high', label: 'High · 深度' }
            ]
          }
        };
      }
      return {
        ok: true,
        result: {
          ok: true,
          options: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        }
      };
    }
  });

  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    fetch: fetchFn,
    bridgePort: 19997,
    hostToken: 'secret-token',
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'demo.thinking': {
        id: 'demo.thinking',
        displayName: '动态思考等级测试',
        trustLevel: 'T0',
        world: 'isolated',
        enabled: true,
        active: true,
        settingsSchema: {
          title: '思考等级',
          fields: [
            {
              key: 'carbonThinking',
              type: 'enum',
              default: 'high',
              label: 'Carbon 思考等级',
              options: [
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
                { value: 'xhigh', label: 'XHigh' }
              ],
              optionsCommand: 'demo.listThinking'
            },
            {
              key: 'argonThinking',
              type: 'enum',
              default: 'high',
              label: 'Argon 思考等级',
              options: [
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
                { value: 'xhigh', label: 'XHigh' }
              ],
              optionsCommand: 'demo.listThinking'
            },
            {
              key: 'neonThinking',
              type: 'enum',
              default: 'high',
              label: 'Neon 思考等级',
              options: [
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
                { value: 'xhigh', label: 'XHigh' }
              ],
              optionsCommand: 'demo.listThinking'
            }
          ]
        },
        settingsValues: { ...currentSettings }
      }
    }
  });

  try {
    // 1. 动态渲染真实支持档位 + 保留不在动态列表中的已选值
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.thinking' });
    await new Promise((r) => setTimeout(r, 40));
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;

    const carbonSel = shadow.querySelector('[data-setting-key="carbonThinking"]');
    assert.equal(carbonSel.getAttribute('data-options-source'), 'dynamic');
    assert.equal(carbonSel.getAttribute('data-preserved-value'), 'high');
    assert.equal(carbonSel.value, 'high');
    // 已保留 high + 动态返回 minimal, low 共 3 项（不硬编码补齐 medium/xhigh）
    assert.deepEqual(Array.from(carbonSel.children).map((o) => o.value), ['high', 'minimal', 'low']);

    // 切换至动态新档位 minimal，不被本地校验拦截
    carbonSel.value = 'minimal';
    carbonSel.dispatchEvent({ type: 'change', target: carbonSel });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(host.getPluginSettings('demo.thinking').carbonThinking, 'minimal');

    const argonSel = shadow.querySelector('[data-setting-key="argonThinking"]');
    argonSel.value = 'off';
    argonSel.dispatchEvent({ type: 'change', target: argonSel });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(host.getPluginSettings('demo.thinking').argonThinking, 'off');

    // 2. 不支持思考等级时如实展示提示且不伪造 4 档（同时保留原值可见）
    host.closeSettings();
    mode = 'empty';
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.thinking' });
    await new Promise((r) => setTimeout(r, 40));
    const neonSelEmpty = shadow.querySelector('[data-setting-key="neonThinking"]');
    assert.equal(neonSelEmpty.getAttribute('data-options-source'), 'dynamic');
    assert.equal(neonSelEmpty.getAttribute('data-preserved-value'), 'high');
    assert.deepEqual(Array.from(neonSelEmpty.children).map((o) => o.value), ['high']);
    assert.match(shadow.querySelector('[data-enum-options-hint="neonThinking"]')?.textContent || '', /不支持/);

    // 3. 命令报错时优雅回退至静态 field.options，且保留当前已保存的 off 值
    host.closeSettings();
    mode = 'error';
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.thinking' });
    await new Promise((r) => setTimeout(r, 40));
    const argonFallback = shadow.querySelector('[data-setting-key="argonThinking"]');
    assert.equal(argonFallback.getAttribute('data-options-source'), 'fallback');
    assert.equal(argonFallback.getAttribute('data-preserved-value'), 'off');
    assert.equal(argonFallback.value, 'off');
    assert.ok(shadow.querySelector('[data-enum-options-hint="argonThinking"]'));
  } finally {
    await host.dispose();
  }
});

test('插件详情页与插件市场返回栏作为 .ag-sv-body 直接子节点固定吸顶不随滚动消失', async () => {
  const doc = createMockDocument();
  const host = createHostRuntime({
    document: doc,
    window: { location: { href: 'https://127.0.0.1:51410/' } },
    anchorsRegistry: buildFullAnchorsRegistry(),
    pluginMeta: {
      'demo.sticky': {
        id: 'demo.sticky',
        displayName: 'Sticky Back Demo',
        version: '1.0.0',
        trustLevel: 'T0'
      }
    }
  });

  try {
    await host.mountPlugin('demo.sticky', { mount() {} });

    // 1. 插件详情页：.ag-sv-breadcrumb 直接挂载在 #agy-settings-body 下，位于 #agy-plugin-detail-header 之外
    await host.openSettings({ tab: 'plugins', pluginId: 'demo.sticky' });
    const shadow = doc.getElementById('agy-daddy-host').shadowRoot;
    const bodyEl = shadow.querySelector('#agy-settings-body');
    const detailHeader = shadow.querySelector('#agy-plugin-detail-header');
    const detailBackBtn = shadow.querySelector('#agy-detail-back-btn');
    const detailCrumb = detailBackBtn?.parentElement;
    assert.ok(bodyEl && detailHeader && detailBackBtn && detailCrumb);
    assert.equal(detailCrumb.className, 'ag-sv-breadcrumb');
    assert.equal(detailCrumb.parentElement, bodyEl);
    assert.notEqual(detailCrumb.parentElement, detailHeader);
    assert.equal(bodyEl.children[0], detailCrumb);
    assert.equal(bodyEl.children[1], detailHeader);

    // 2. 插件市场页：点击返回插件列表后，进入市场页时 .ag-sv-breadcrumb 同样直接挂载在 #agy-settings-body 下
    detailBackBtn.click();
    const marketBtn = shadow.querySelector('#agy-open-marketplace-btn');
    if (marketBtn) {
      marketBtn.click();
      const marketHeader = shadow.querySelector('#agy-marketplace-header');
      const marketBackBtn = shadow.querySelector('#agy-marketplace-back-btn');
      const marketCrumb = marketBackBtn?.parentElement;
      assert.ok(marketHeader && marketBackBtn && marketCrumb);
      assert.equal(marketCrumb.className, 'ag-sv-breadcrumb');
      assert.equal(marketCrumb.parentElement, bodyEl);
      assert.notEqual(marketCrumb.parentElement, marketHeader);
    }

    // 3. 样式表包含 position: sticky; top: 0; 与不透明背景
    const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
    const breadcrumbMatch = stylesCss.match(/\.ag-sv-breadcrumb\s*\{[^}]*\}/);
    assert.ok(breadcrumbMatch, 'missing .ag-sv-breadcrumb rule in styles.css');
    assert.match(breadcrumbMatch[0], /position:\s*sticky\b/);
    assert.match(breadcrumbMatch[0], /top:\s*0\b/);
    assert.match(breadcrumbMatch[0], /background:\s*var\(--ag-bg-panel\)/);
  } finally {
    await host.dispose();
  }
});
