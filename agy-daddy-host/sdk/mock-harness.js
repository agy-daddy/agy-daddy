'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');
const { FourRealmBus } = require('../src/core/bus');
const { DynamicBridgeServer } = require('../src/core/bridge');
const { PluginDataStore } = require('../src/core/storage');
const { createScopedRpcClient } = require('../src/core/rpc');
const { loadAnchorsRegistry } = require('../src/core/anchors');
const {
  validateManifest,
  validateSettingsSchema,
  validateSettingsValues,
  redactWriteOnlySettings,
  evaluateTrustPolicy
} = require('../src/contracts/manifest-validator');
const { createHostRuntime } = require('../src/renderer/host-runtime');
const { createScopedNetFetch } = require('../src/core/plugin-worker');
const { bundlePluginRendererSource, buildIsolatedWorldPluginScript } = require('../src/core/injector');
const { DEFAULT_HOST_SETTINGS, normalizeHostSettings, createScopedHostControl } = require('../src/core/daemon');

function matchSimpleSelector(el, sel) {
  if (!el || !sel) return false;
  let s = sel.trim();
  if (!s) return false;

  // 1. 校验全部属性选择器 [attr], [attr="v"], [attr*="v"], [attr^="v"], [attr$="v"]
  const attrRe = /\[([^\]=~*^$]+)(?:([*^$]?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let attrMatch;
  while ((attrMatch = attrRe.exec(s)) !== null) {
    const attr = attrMatch[1].trim();
    const op = attrMatch[2] || '';
    const val = attrMatch[3] !== undefined ? attrMatch[3] : (attrMatch[4] !== undefined ? attrMatch[4] : (attrMatch[5] || ''));
    const actual = el.getAttribute(attr);
    if (actual == null) return false;
    if (op === '=' && actual !== val) return false;
    if (op === '*=' && !actual.includes(val)) return false;
    if (op === '^=' && !actual.startsWith(val)) return false;
    if (op === '$=' && !actual.endsWith(val)) return false;
  }
  const rest = s.replace(attrRe, '');
  if (!rest) return true;

  // 2. 校验可选 tag / #id / .class 组合
  const unescaped = rest.replace(/\\(.)/g, '$1');
  const tokens = unescaped.match(/([#.][^#.]+|[^#.]+)/g) || [];
  const classList = String(el.className || '').split(/\s+/).filter(Boolean);
  for (const tok of tokens) {
    if (tok.startsWith('#')) {
      if (el.id !== tok.slice(1)) return false;
    } else if (tok.startsWith('.')) {
      if (!classList.includes(tok.slice(1))) return false;
    } else if (tok !== '*') {
      if (String(el.tagName || '').toLowerCase() !== tok.toLowerCase()) return false;
    }
  }
  return true;
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
    },
    matches(selector) {
      const parts = String(selector).split(',').map((s) => s.trim()).filter(Boolean);
      return parts.some((p) => {
        const subTokens = p.match(/(?:\[[^\]]*\]|"[^"]*"|'[^']*'|\S)+/g) || [];
        return matchSimpleSelector(el, subTokens[subTokens.length - 1]);
      });
    },
    closest(selector) {
      let cur = el;
      while (cur) {
        if (typeof cur.matches === 'function' && cur.matches(selector)) return cur;
        cur = cur.parentElement || null;
      }
      return null;
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
  const pageUrl = options.pageUrl || 'https://127.0.0.1:51410/11111111-2222-3333-4444-555555555555';
  mockDoc.URL = pageUrl;
  const mockMainWin = {
    location: { href: pageUrl },
    __APP_CONFIG__: { csrfToken: 'mock-csrf-secret-should-not-leak' }
  };
  const xworldNonce = options.xworldNonce || crypto.randomBytes(8).toString('hex');
  const xworldChannelName = `__agy_xworld_${xworldNonce}`;
  let hostSettings = normalizeHostSettings(options.hostSettings || {}, DEFAULT_HOST_SETTINGS);
  const pluginMeta = {};
  const pluginSchemas = new Map();
  const settingsListeners = new Map();
  const commands = new Map();

  const rendererHost = createHostRuntime({
    document: mockDoc,
    window: mockMainWin,
    anchorsRegistry,
    antigravityVersion: options.antigravityVersion || '2.33.0',
    xworldNonce,
    hostSettings,
    pluginMeta
  });

  function resolveSettings(pluginId) {
    const store = new PluginDataStore(pluginId, { stateDir });
    const raw = store.readJson('settings.json', {}).data || {};
    const schema = pluginSchemas.get(pluginId) || null;
    if (!schema) return { ...raw };
    const checked = validateSettingsValues(schema, raw);
    if (checked.ok) return { ...checked.values };
    const out = {};
    for (const f of schema.fields || []) {
      const single = validateSettingsValues({ fields: [f] }, { [f.key]: raw[f.key] });
      if (single.ok && f.key in single.values) out[f.key] = single.values[f.key];
      else if (f.default !== undefined) out[f.key] = f.default;
    }
    return out;
  }

  async function updateSettings(pluginId, patch = {}) {
    const store = new PluginDataStore(pluginId, { stateDir });
    const prev = resolveSettings(pluginId);
    const candidate = { ...prev, ...(patch && typeof patch === 'object' ? patch : {}) };
    const schema = pluginSchemas.get(pluginId) || null;
    let next = candidate;
    if (schema) {
      const checked = validateSettingsValues(schema, candidate);
      if (!checked.ok) return { ok: false, errors: checked.errors };
      next = checked.values;
    }
    const changedKeys = Array.from(new Set([...Object.keys(prev), ...Object.keys(next)])).filter(
      (k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k])
    );
    store.writeJson('settings.json', next);
    const redacted = redactWriteOnlySettings(schema, next);
    if (pluginMeta[pluginId]) {
      pluginMeta[pluginId].settingsValues = { ...redacted.values };
      pluginMeta[pluginId].settingsSecretState = { ...redacted.secretState };
    }
    const set = settingsListeners.get(pluginId);
    if (set) {
      for (const fn of Array.from(set)) {
        try { fn({ ...next }, [...changedKeys]); } catch {}
      }
    }
    let rendererNotified = 0;
    if (typeof rendererHost.notifyPluginSettingsChanged === 'function') {
      try {
        rendererHost.notifyPluginSettingsChanged(pluginId, { ...redacted.values }, [...changedKeys], { ...redacted.secretState });
        rendererNotified = 1;
      } catch {}
    }
    return { ok: true, values: next, redactedValues: redacted.values, secretState: redacted.secretState, changedKeys, rendererNotified };
  }

  function registerCommand(pluginId, commandId, handler) {
    const rec = { pluginId, commandId, handler };
    commands.set(commandId, rec);
    return () => {
      if (commands.get(commandId) === rec) commands.delete(commandId);
    };
  }

  async function executeCommand(commandId, args = [], opts = {}) {
    let rec = opts.pluginId ? commands.get(`${opts.pluginId}:${commandId}`) : null;
    if (!rec) rec = commands.get(commandId);
    if (!rec) throw new Error(`COMMAND_NOT_FOUND: ${commandId}`);
    const out = await rec.handler(...(Array.isArray(args) ? args : []));
    return out === undefined ? null : out;
  }

  bridge.registerHostRoute('/host/host-settings', async (body) => {
    if (body?.action === 'save' || body?.action === 'update') {
      hostSettings = normalizeHostSettings(body?.values || body?.patch || {}, hostSettings);
    }
    return { ok: true, values: hostSettings };
  });
  bridge.registerHostRoute('/host/settings', async (body) => {
    const pid = String(body?.pluginId || '');
    const schema = pluginSchemas.get(pid) || null;
    if (body?.action === 'update' || body?.action === 'save') {
      const res = await updateSettings(pid, body?.values || body?.patch || {});
      if (!res?.ok) return res;
      const hasSecretState = res.secretState && Object.keys(res.secretState).length > 0;
      const out = {
        ...res,
        values: res.redactedValues || redactWriteOnlySettings(schema, res.values).values
      };
      if (!hasSecretState) delete out.secretState;
      return out;
    }
    const redacted = redactWriteOnlySettings(schema, resolveSettings(pid));
    const hasSecretState = Object.keys(redacted.secretState).length > 0;
    return {
      ok: true,
      values: redacted.values,
      ...(hasSecretState ? { secretState: redacted.secretState } : {}),
      schema
    };
  });
  bridge.registerHostRoute('/host/commands/run', async (body) => {
    const result = await executeCommand(String(body?.commandId || ''), body?.args || [], { pluginId: body?.pluginId || null });
    return { ok: true, result };
  });
  bridge.registerPluginSystemRoute('/__settings', async (body, meta) => {
    const schema = pluginSchemas.get(meta.pluginId) || null;
    if (body?.action === 'update' || body?.action === 'save') {
      const res = await updateSettings(meta.pluginId, body?.values || body?.patch || {});
      if (!res?.ok) return res;
      const hasSecretState = res.secretState && Object.keys(res.secretState).length > 0;
      const out = {
        ...res,
        values: res.redactedValues || redactWriteOnlySettings(schema, res.values).values
      };
      if (!hasSecretState) delete out.secretState;
      return out;
    }
    const redacted = redactWriteOnlySettings(schema, resolveSettings(meta.pluginId));
    const hasSecretState = Object.keys(redacted.secretState).length > 0;
    return {
      ok: true,
      values: redacted.values,
      ...(hasSecretState ? { secretState: redacted.secretState } : {})
    };
  });
  bridge.registerPluginSystemRoute('/__command', async (body, meta) => {
    const result = await executeCommand(String(body?.commandId || ''), body?.args || [], { pluginId: meta.pluginId });
    return { ok: true, result };
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

    let settingsSchema = null;
    if (manifest.contributes?.settings?.schema) {
      settingsSchema = JSON.parse(fs.readFileSync(path.join(pluginDir, manifest.contributes.settings.schema), 'utf8'));
      const sRes = validateSettingsSchema(settingsSchema);
      if (!sRes.ok) throw new Error(`Settings schema invalid: ${sRes.errors.join('; ')}`);
      pluginSchemas.set(manifest.id, settingsSchema);
    }

    const initialSettings = resolveSettings(manifest.id);
    const initialRedacted = redactWriteOnlySettings(settingsSchema, initialSettings);
    const displayName = typeof manifest.displayName === 'string'
      ? manifest.displayName
      : (manifest.displayName?.['zh-CN'] || manifest.displayName?.en || manifest.id);
    const description = typeof manifest.description === 'string'
      ? manifest.description
      : (manifest.description?.['zh-CN'] || manifest.description?.en || '');
    pluginMeta[manifest.id] = {
      id: manifest.id,
      displayName,
      description,
      version: manifest.version,
      trustLevel: trust.trustLevel,
      settingsSchema,
      settingsValues: initialRedacted.values,
      settingsSecretState: initialRedacted.secretState,
      commands: Array.isArray(manifest.contributes?.commands) ? manifest.contributes.commands : [],
      topbarUnits: Array.isArray(manifest.contributes?.['topbar.units']) ? manifest.contributes['topbar.units'] : []
    };

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
          get: (name, sOpts = {}) => bus.getServiceProxy(name, { ...sOpts, callerRealm: 'node' }),
          has: (name) => bus.hasService(name)
        },
        events: {
          emit: (topic, payload) => bus.emitEvent(manifest.id, topic, payload),
          on: (topic, fn) => bus.onEvent(manifest.id, topic, fn),
          onAny: (fn) => bus.onAny(manifest.id, fn)
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
        },
        control: createScopedHostControl(
          manifest.id,
          trust.granted,
          async (normalized, body) => {
            if (typeof options.onHostControl === 'function') {
              return await options.onHostControl(normalized, body);
            }
            return await bridge.invokeHostRoute(normalized, body, { pluginId: manifest.id, via: 'host.control' });
          }
        ),
        settings: {
          get: () => resolveSettings(manifest.id),
          update: async (patch) => {
            const res = await updateSettings(manifest.id, patch);
            if (!res.ok) throw new Error((res.errors || []).join('; ') || 'Invalid settings');
            return res;
          },
          save: (values, schemaOverride = null) => {
            const effSchema = schemaOverride || pluginSchemas.get(manifest.id) || null;
            const prev = resolveSettings(manifest.id);
            const candidate = { ...prev, ...(values && typeof values === 'object' ? values : {}) };
            let toSave = candidate;
            if (effSchema) {
              const checked = validateSettingsValues(effSchema, candidate);
              if (!checked.ok) throw new Error(checked.errors.join('; '));
              toSave = checked.values;
            }
            const wr = store.writeJson('settings.json', toSave);
            if (pluginMeta[manifest.id]) {
              const redactedSave = redactWriteOnlySettings(effSchema, toSave);
              pluginMeta[manifest.id].settingsValues = { ...redactedSave.values };
              pluginMeta[manifest.id].settingsSecretState = { ...redactedSave.secretState };
            }
            return wr;
          },
          onChange: (fn) => {
            if (!settingsListeners.has(manifest.id)) settingsListeners.set(manifest.id, new Set());
            settingsListeners.get(manifest.id).add(fn);
            return () => settingsListeners.get(manifest.id)?.delete(fn);
          }
        },
        commands: {
          register: (commandId, handler) => registerCommand(manifest.id, commandId, handler),
          execute: (commandId, args = []) => executeCommand(commandId, args)
        }
      };
      if (typeof nodeMod?.activate === 'function') {
        await nodeMod.activate(hostApi);
      }
    }

    let rendererMod = null;
    if (manifest.renderer) {
      const rendererFile = path.resolve(pluginDir, manifest.renderer);
      const code = bundlePluginRendererSource(rendererFile, pluginDir);
      if (trust.world === 'isolated' && !opts.inProcessRenderer) {
        // 用独立 vm.Context + __agy_xworld_<nonce> 通道模拟 CDP Page.createIsolatedWorld
        class MockCustomEvent {
          constructor(type, init = {}) {
            this.type = type;
            this.detail = init.detail;
          }
        }
        class MockMutationObserver {
          observe() {}
          disconnect() {}
        }
        const isoScript = buildIsolatedWorldPluginScript(manifest.id, code, {
          xworldChannelName,
          bridgePort: bridge.port,
          pluginToken,
          anchorsRegistry,
          hostVersion: '1.0.0',
          initialSettings: resolveSettings(manifest.id)
        });
        const worldCtx = vm.createContext({
          document: mockDoc,
          location: { href: pageUrl },
          fetch: options.fetch || globalThis.fetch,
          CustomEvent: MockCustomEvent,
          MutationObserver: MockMutationObserver,
          console,
          setTimeout,
          clearTimeout,
          setInterval,
          clearInterval,
          AbortController: globalThis.AbortController,
          JSON,
          Promise
        });
        worldCtx.globalThis = worldCtx;
        worldCtx.self = worldCtx;
        await vm.runInContext(isoScript, worldCtx, { filename: rendererFile });
        isolatedWorlds.set(manifest.id, worldCtx);
      } else {
        delete require.cache[require.resolve(rendererFile)];
        rendererMod = require(rendererFile);
        await rendererHost.mountPlugin(manifest.id, rendererMod, { pluginToken });
      }
    }

    activePlugins.set(manifest.id, { manifest, nodeMod, rendererMod, trust, pluginDir });
    return { manifest, trust, pluginToken };
  }

  async function unloadPlugin(pluginId) {
    const rec = activePlugins.get(pluginId);
    if (!rec) return;
    activePlugins.delete(pluginId);
    const isoCtx = isolatedWorlds.get(pluginId);
    if (isoCtx && typeof isoCtx.__agyIsolatedDispose === 'function') {
      try { await isoCtx.__agyIsolatedDispose(); } catch {}
    }
    isolatedWorlds.delete(pluginId);
    await rendererHost.disposePlugin(pluginId);
    if (typeof rec.nodeMod?.deactivate === 'function') {
      await rec.nodeMod.deactivate();
    }
    bus.disposePlugin(pluginId);
    bridge.unregisterPluginRoutes(pluginId);
    for (const [cmdId, cmdRec] of Array.from(commands.entries())) {
      if (cmdRec.pluginId === pluginId) commands.delete(cmdId);
    }
    settingsListeners.delete(pluginId);
  }

  function assertCleanDispose(pluginId) {
    const busLeft = bus.countRegistrations(pluginId);
    assert.equal(busLeft, 0, `Plugin ${pluginId} leaked ${busLeft} bus registrations`);
    const routeLeft = bridge.countPluginRoutes(pluginId);
    assert.equal(routeLeft, 0, `Plugin ${pluginId} leaked ${routeLeft} bridge routes`);
    let cmdLeft = 0;
    for (const rec of commands.values()) if (rec.pluginId === pluginId) cmdLeft++;
    assert.equal(cmdLeft, 0, `Plugin ${pluginId} leaked ${cmdLeft} commands`);
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
    xworldNonce,
    xworldChannelName,
    commands,
    getPluginSettings: resolveSettings,
    updatePluginSettings: updateSettings,
    executeCommand,
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
