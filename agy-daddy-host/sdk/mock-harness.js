'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { FourRealmBus } = require('../src/core/bus');
const { DynamicBridgeServer } = require('../src/core/bridge');
const { PluginDataStore } = require('../src/core/storage');
const { createScopedRpcClient } = require('../src/core/rpc');
const { loadAnchorsRegistry } = require('../src/core/anchors');
const { validateManifest, validateSettingsSchema, evaluateTrustPolicy } = require('../src/contracts/manifest-validator');
const { createHostRuntime } = require('../src/renderer/host-runtime');
const { createScopedNetFetch } = require('../src/core/plugin-worker');

function matchSimpleSelector(el, sel) {
  if (!el || !sel) return false;
  const s = sel.trim();
  if (s.startsWith('#')) return el.id === s.slice(1);
  if (s.startsWith('.')) {
    const cls = s.slice(1).split('.')[0].replace(/\\(.)/g, '$1');
    return String(el.className || '').split(/\s+/).includes(cls);
  }
  const attrMatch = s.match(/\[([^\]=~*^$]+)(?:([*^$]?=)"?([^"\]]*)"?)?\]/);
  if (attrMatch) {
    const [, attr, op, val] = attrMatch;
    const actual = el.getAttribute(attr);
    if (actual == null) return false;
    if (!op) return true;
    if (op === '=') return actual === val;
    if (op === '*=') return actual.includes(val);
    return false;
  }
  return el.tagName?.toLowerCase() === s.toLowerCase();
}

function createMockElement(tagName, ownerDoc) {
  const attrs = new Map();
  const listeners = new Map();
  const styleProps = new Map();
  const children = [];
  let rawText = '';
  let rawHtml = '';
  const el = {
    tagName: String(tagName || 'div').toUpperCase(),
    ownerDocument: ownerDoc,
    parentElement: null,
    children,
    childNodes: children,
    id: '',
    className: '',
    get textContent() {
      if (children.length > 0) return children.map((c) => c.textContent || '').join('');
      if (rawHtml && !rawText) return rawHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      return rawText;
    },
    set textContent(v) {
      rawText = String(v ?? '');
      rawHtml = '';
      for (const ch of children) ch.parentElement = null;
      children.length = 0;
    },
    get innerHTML() {
      if (children.length > 0) return children.map((c) => c.outerHTML || c.textContent || '').join('');
      return rawHtml;
    },
    set innerHTML(v) {
      rawHtml = String(v ?? '');
      rawText = '';
      for (const ch of children) ch.parentElement = null;
      children.length = 0;
    },
    hidden: false,
    disabled: false,
    checked: false,
    value: '',
    type: '',
    placeholder: '',
    contains(target) {
      let cur = target;
      while (cur) {
        if (cur === el) return true;
        cur = cur.parentElement || null;
      }
      return false;
    },
    style: {
      setProperty(k, v) { styleProps.set(k, v); },
      getPropertyValue(k) { return styleProps.get(k) || ''; },
      removeProperty(k) { styleProps.delete(k); }
    },
    get firstChild() { return children[0] || null; },
    get lastElementChild() { return children[children.length - 1] || null; },
    setAttribute(k, v) {
      attrs.set(k, String(v));
      if (k === 'id') el.id = String(v);
      if (k === 'class') el.className = String(v);
    },
    removeAttribute(k) {
      attrs.delete(k);
      if (k === 'id') el.id = '';
      if (k === 'class') el.className = '';
    },
    getAttribute(k) {
      if (k === 'id' && el.id) return el.id;
      if (k === 'class' && el.className) return el.className;
      return attrs.has(k) ? attrs.get(k) : null;
    },
    appendChild(child) {
      if (child.parentElement) {
        const idx = child.parentElement.children.indexOf(child);
        if (idx >= 0) child.parentElement.children.splice(idx, 1);
      }
      child.parentElement = el;
      children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      if (child.parentElement) {
        const curIdx = child.parentElement.children.indexOf(child);
        if (curIdx >= 0) child.parentElement.children.splice(curIdx, 1);
      }
      const idx = children.indexOf(ref);
      if (idx < 0) {
        child.parentElement = el;
        children.push(child);
        return child;
      }
      child.parentElement = el;
      children.splice(idx, 0, child);
      return child;
    },
    remove() {
      if (el.parentElement) {
        const idx = el.parentElement.children.indexOf(el);
        if (idx >= 0) el.parentElement.children.splice(idx, 1);
        el.parentElement = null;
      }
    },
    attachShadow() {
      const sr = createMockElement('#shadow-root', ownerDoc);
      sr.host = el;
      el.shadowRoot = sr;
      return sr;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      const set = listeners.get(ev.type);
      if (set) for (const fn of Array.from(set)) fn(ev);
      return true;
    },
    click() {
      el.dispatchEvent({ type: 'click', target: el });
    },
    querySelectorAll(selector) {
      const parts = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
      const found = [];
      function walk(node) {
        for (const ch of node.children || []) {
          if (parts.some((p) => {
            const subTokens = p.match(/(?:\[[^\]]*\]|"[^"]*"|'[^']*'|\S)+/g) || [];
            return matchSimpleSelector(ch, subTokens[subTokens.length - 1]);
          })) {
            found.push(ch);
          }
          walk(ch);
        }
      }
      walk(el);
      return found;
    },
    querySelector(selector) {
      return el.querySelectorAll(selector)[0] || null;
    }
  };
  return el;
}

function createMockDocument(seedAnchors = []) {
  const docListeners = new Map();
  const doc = {
    hidden: false,
    documentElement: null,
    body: null,
    createElement(tag) { return createMockElement(tag, doc); },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev) {
      const set = docListeners.get(ev.type);
      if (set) for (const fn of Array.from(set)) fn(ev);
      return true;
    },
    querySelectorAll(selector) {
      return doc.documentElement ? doc.documentElement.querySelectorAll(selector) : [];
    },
    querySelector(selector) {
      if (!doc.documentElement) return null;
      return doc.documentElement.querySelector(selector);
    },
    getElementById(id) {
      return doc.querySelector(`#${id}`);
    }
  };
  doc.documentElement = createMockElement('html', doc);
  doc.head = createMockElement('head', doc);
  doc.body = createMockElement('body', doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  // 种子锚点元素
  const topbar = createMockElement('div', doc);
  topbar.setAttribute('data-testid', 'toggle-aux-sidebar');
  const titlebar = createMockElement('div', doc);
  titlebar.className = '@container/titlebar';
  const shrink = createMockElement('div', doc);
  shrink.className = 'shrink-0';
  shrink.appendChild(topbar);
  titlebar.appendChild(shrink);
  doc.body.appendChild(titlebar);

  const composer = createMockElement('div', doc);
  composer.className = 'surface-composer';
  const editor = createMockElement('div', doc);
  editor.setAttribute('data-lexical-editor', 'true');
  editor.setAttribute('contenteditable', 'true');
  const sendBtn = createMockElement('button', doc);
  sendBtn.setAttribute('data-testid', 'input-send-button');
  composer.appendChild(editor);
  composer.appendChild(sendBtn);
  doc.body.appendChild(composer);

  for (const extra of seedAnchors) {
    const el = createMockElement(extra.tag || 'div', doc);
    if (extra.attr && extra.val) el.setAttribute(extra.attr, extra.val);
    doc.body.appendChild(el);
  }
  return doc;
}

function createMockHostHarness(options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-daddy-mock-'));
  const stateDir = path.join(tempRoot, 'state');
  const bus = new FourRealmBus({ timeoutMs: options.busTimeoutMs || 3000 });
  const bridge = new DynamicBridgeServer({ origin: '*' });
  const anchorsRegistry = options.anchorsRegistry || loadAnchorsRegistry();
  const mockDoc = options.document || createMockDocument(options.seedAnchors);
  const mockMainWin = {
    location: { href: options.pageUrl || 'https://127.0.0.1:51410/11111111-2222-3333-4444-555555555555' },
    __APP_CONFIG__: { csrfToken: 'mock-csrf-secret-should-not-leak' }
  };
  const rendererHost = createHostRuntime({
    document: mockDoc,
    window: mockMainWin,
    anchorsRegistry,
    antigravityVersion: options.antigravityVersion || '2.33.0'
  });

  const rpcCalls = [];
  const rpcTransport = options.rpcTransport || {
    async getOrigin() { return 'https://127.0.0.1:51410'; },
    async call(method, body) {
      rpcCalls.push({ method, body });
      if (typeof options.onRpc === 'function') return options.onRpc(method, body);
      return { ok: true, method, mock: true };
    }
  };

  const activePlugins = new Map();
  const isolatedWorlds = new Map();

  async function loadAndRunPlugin(pluginDir, opts = {}) {
    const manifestPath = path.join(pluginDir, 'agy-plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const mRes = validateManifest(manifest);
    if (!mRes.ok) {
      throw new Error(`Manifest invalid: ${mRes.errors.join('; ')}`);
    }

    const trustLevel = opts.trustLevel || (manifest.publisher === 'agy-daddy' ? 'T0' : 'T2');
    const trust = evaluateTrustPolicy(manifest, trustLevel, opts.grantedPermissions || manifest.permissions || []);
    if (!trust.allowed) {
      throw new Error(`Trust denied: ${trust.denied.join(', ')}`);
    }

    if (manifest.contributes?.settings?.schema) {
      const schema = JSON.parse(fs.readFileSync(path.join(pluginDir, manifest.contributes.settings.schema), 'utf8'));
      const sRes = validateSettingsSchema(schema);
      if (!sRes.ok) throw new Error(`Settings schema invalid: ${sRes.errors.join('; ')}`);
    }

    const store = new PluginDataStore(manifest.id, { stateDir });
    const pluginToken = bridge.issuePluginToken(manifest.id);
    const rpcClient = createScopedRpcClient(manifest.id, trust.granted, rpcTransport);
    let nodeMod = null;

    if (manifest.main) {
      const mainFile = path.resolve(pluginDir, manifest.main);
      delete require.cache[require.resolve(mainFile)];
      nodeMod = require(mainFile);
      const hostApi = {
        pluginId: manifest.id,
        manifest,
        permissions: [...trust.granted],
        storage: store,
        bridge: {
          registerRoute: (subPath, handler) => bridge.registerPluginRoute(manifest.id, subPath, handler)
        },
        rpc: rpcClient,
        services: {
          provide: (name, methods, sOpts = {}) => bus.provideService(manifest.id, name, methods, sOpts),
          call: (name, method, args = [], sOpts = {}) => bus.callService(name, method, args, { ...sOpts, callerRealm: 'node' }),
          get: (name, sOpts = {}) => bus.getServiceProxy(name, { ...sOpts, callerRealm: 'node' })
        },
        events: {
          emit: (topic, payload) => bus.emitEvent(manifest.id, topic, payload),
          on: (topic, fn) => bus.onEvent(manifest.id, topic, fn)
        },
        state: {
          set: (key, val) => bus.setState(manifest.id, key, val),
          get: (key) => bus.getState(key),
          subscribe: (key, fn) => bus.subscribeState(manifest.id, key, fn)
        },
        hooks: {
          register: (hookName, fn) => bus.registerHook(manifest.id, hookName, fn)
        },
        net: {
          fetch: createScopedNetFetch(manifest.id, trust.granted, bus, options.fetch)
        }
      };
      if (typeof nodeMod?.activate === 'function') {
        await nodeMod.activate(hostApi);
      }
    }

    let rendererMod = null;
    if (manifest.renderer) {
      const rendererFile = path.resolve(pluginDir, manifest.renderer);
      const code = fs.readFileSync(rendererFile, 'utf8');
      if (trust.world === 'isolated' && !opts.inProcessRenderer) {
        // 用独立 vm.Context 模拟 CDP Page.createIsolatedWorld：共享 DOM，不共享页面 JS 全局
        const worldCtx = vm.createContext({
          document: mockDoc,
          console,
          setTimeout,
          clearTimeout,
          setInterval,
          clearInterval,
          JSON,
          Promise,
          module: { exports: {} },
          exports: {}
        });
        vm.runInContext(code, worldCtx, { filename: rendererFile });
        rendererMod = worldCtx.module.exports;
        isolatedWorlds.set(manifest.id, worldCtx);
      } else {
        delete require.cache[require.resolve(rendererFile)];
        rendererMod = require(rendererFile);
      }
      await rendererHost.mountPlugin(manifest.id, rendererMod, { pluginToken });
    }

    activePlugins.set(manifest.id, { manifest, nodeMod, rendererMod, trust, pluginDir });
    return { manifest, trust, pluginToken };
  }

  async function unloadPlugin(pluginId) {
    const rec = activePlugins.get(pluginId);
    if (!rec) return;
    activePlugins.delete(pluginId);
    await rendererHost.disposePlugin(pluginId);
    if (typeof rec.nodeMod?.deactivate === 'function') {
      await rec.nodeMod.deactivate();
    }
    bus.disposePlugin(pluginId);
    bridge.unregisterPluginRoutes(pluginId);
    isolatedWorlds.delete(pluginId);
  }

  function assertCleanDispose(pluginId) {
    const busLeft = bus.countRegistrations(pluginId);
    assert.equal(busLeft, 0, `Plugin ${pluginId} leaked ${busLeft} bus registrations`);
    const routeLeft = bridge.countPluginRoutes(pluginId);
    assert.equal(routeLeft, 0, `Plugin ${pluginId} leaked ${routeLeft} bridge routes`);
    const uiStats = rendererHost.getPluginUsageStats(pluginId);
    assert.deepEqual(
      uiStats,
      { domNodes: 0, observers: 0, timers: 0, events: 0, services: 0 },
      `Plugin ${pluginId} leaked renderer resources: ${JSON.stringify(uiStats)}`
    );
  }

  async function cleanup() {
    for (const id of Array.from(activePlugins.keys())) {
      await unloadPlugin(id);
    }
    await rendererHost.dispose();
    await bridge.stop();
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  }

  return {
    tempRoot,
    stateDir,
    bus,
    bridge,
    rpcCalls,
    mockDoc,
    mockMainWin,
    rendererHost,
    isolatedWorlds,
    loadAndRunPlugin,
    unloadPlugin,
    assertCleanDispose,
    cleanup
  };
}

module.exports = {
  createMockElement,
  createMockDocument,
  createMockHostHarness
};
