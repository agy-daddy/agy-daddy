'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { resolveActiveCdpTarget, CdpClient } = require('./cdp');
const { loadAnchorsRegistry, buildResolvedAnchorsMap } = require('./anchors');

const DEFAULT_HOST_BUNDLE_PATH = path.resolve(__dirname, '..', '..', 'dist', 'host-renderer.js');

function buildHostBootstrapScript(bundleSource, bootOptions = {}) {
  const serialized = JSON.stringify(bootOptions);
  return `(function(){
'use strict';
globalThis.__AGY_DADDY_BOOT_OPTIONS__ = ${serialized};
${bundleSource}
return { ok: Boolean(globalThis.__AGYDaddyHost), version: globalThis.__AGYDaddyHost && globalThis.__AGYDaddyHost.version ? globalThis.__AGYDaddyHost.version : null };
})();`;
}

function resolveLocalModuleFile(fromFile, reqSpec, pluginRoot) {
  if (!reqSpec.startsWith('./') && !reqSpec.startsWith('../')) return null;
  const base = path.resolve(path.dirname(fromFile), reqSpec);
  const candidates = [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')];
  const rootPrefix = pluginRoot.endsWith(path.sep) ? pluginRoot : `${pluginRoot}${path.sep}`;
  for (const cand of candidates) {
    if (cand !== pluginRoot && !cand.startsWith(rootPrefix)) continue;
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

function bundlePluginRendererSource(rendererPath, pluginRoot = path.dirname(path.dirname(rendererPath))) {
  const entryAbs = path.resolve(rendererPath);
  const rootAbs = path.resolve(pluginRoot);
  const entrySrc = fs.readFileSync(entryAbs, 'utf8');
  if (!/require\(\s*['"]\.\.?\/[^'"]+['"]\s*\)/.test(entrySrc)) {
    return entrySrc;
  }

  const modules = new Map();
  const visit = (fileAbs) => {
    const relKey = './' + path.relative(rootAbs, fileAbs).replace(/\\/g, '/');
    if (modules.has(relKey)) return;
    const raw = fs.readFileSync(fileAbs, 'utf8');
    if (fileAbs.endsWith('.json')) {
      modules.set(relKey, { isJson: true, code: raw, map: {} });
      return;
    }
    const localMap = {};
    const reqRe = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
    let m;
    const nextFiles = [];
    while ((m = reqRe.exec(raw)) !== null) {
      const spec = m[1];
      const target = resolveLocalModuleFile(fileAbs, spec, rootAbs);
      if (target) {
        const targetRel = './' + path.relative(rootAbs, target).replace(/\\/g, '/');
        localMap[spec] = targetRel;
        nextFiles.push(target);
      }
    }
    modules.set(relKey, { isJson: false, code: raw, map: localMap });
    for (const nf of nextFiles) visit(nf);
  };

  visit(entryAbs);
  const entryKey = './' + path.relative(rootAbs, entryAbs).replace(/\\/g, '/');
  const factories = [];
  for (const [key, mod] of modules.entries()) {
    const mapJson = JSON.stringify(mod.map);
    if (mod.isJson) {
      factories.push(`${JSON.stringify(key)}: function(module){ module.exports = ${mod.code}; }`);
    } else {
      factories.push(
        `${JSON.stringify(key)}: function(module, exports, require, __dirname, __filename){ var __map = ${mapJson}; var __localReq = function(id){ return require(__map[id] || id, id); }; (function(require){ ${mod.code}\n })(__localReq); }`
      );
    }
  }

  return `(function(){
  var __mods = { ${factories.join(',\n')} };
  var __cache = {};
  function __req(id) {
    if (!Object.prototype.hasOwnProperty.call(__mods, id)) {
      if (typeof require === 'function' && !id.startsWith('.')) {
        try { return require(id); } catch {}
      }
      return {};
    }
    if (__cache[id]) return __cache[id].exports;
    var m = { exports: {} };
    __cache[id] = m;
    __mods[id](m, m.exports, __req, '/', id);
    return m.exports;
  }
  module.exports = __req(${JSON.stringify(entryKey)});
})();`;
}

function buildMainWorldPluginScript(pluginId, rendererSource, options = {}) {
  const pidJson = JSON.stringify(pluginId);
  const tokenJson = JSON.stringify(options.pluginToken || '');
  const partsJson = options.legacyBundleParts ? JSON.stringify(options.legacyBundleParts) : 'null';
  const bridgeJson = options.liveBridgeInfo ? JSON.stringify(options.liveBridgeInfo) : 'null';

  return `(async function(){
'use strict';
var module = { exports: {} };
var exports = module.exports;
${rendererSource}
var host = globalThis.__AGYDaddyHost;
if (!host || typeof host.mountPlugin !== 'function') {
  throw new Error('__AGYDaddyHost not initialized before mounting ' + ${pidJson});
}
var legacyParts = ${partsJson};
var legacyBridge = ${bridgeJson};
var mountOptions = {};
if (legacyParts) {
  mountOptions.bundleParts = legacyParts;
  mountOptions.evalCode = function(code) { return (0, eval)(code); };
}
if (legacyBridge) {
  mountOptions.liveBridgeInfo = legacyBridge;
}
return await host.mountPlugin(${pidJson}, module.exports, {
  pluginToken: ${tokenJson},
  mountOptions: mountOptions
});
})();`;
}

function buildIsolatedWorldPluginScript(pluginId, rendererSource, options = {}) {
  const pidJson = JSON.stringify(pluginId);
  const channelJson = JSON.stringify(options.xworldChannelName || '');
  const bridgePortNum = Number(options.bridgePort || 0);
  const tokenJson = JSON.stringify(options.pluginToken || '');
  const anchorsJson = JSON.stringify(options.anchorsRegistry || { anchors: {} });
  const hostVersionJson = JSON.stringify(options.hostVersion || '1.0.0');

  return `(async function(){
'use strict';
if (typeof globalThis.__agyIsolatedDispose === 'function') {
  try { await globalThis.__agyIsolatedDispose(); } catch {}
}

var pluginId = ${pidJson};
var channelName = ${channelJson};
var bridgePort = ${bridgePortNum};
var privateToken = ${tokenJson};
var anchorsRegistry = ${anchorsJson};
var hostVersion = ${hostVersionJson};
var doc = globalThis.document;
var fetchFn = globalThis.fetch;

var reqSeq = 0;
var pendingReqs = new Map();
var unitClickHandlers = new Map();
var settingsHandlers = new Map();
var localTimers = new Set();
var localObservers = new Set();
var pendingSyncOps = [];
var disposed = false;

function dispatchToMain(detail) {
  if (!doc || typeof doc.dispatchEvent !== 'function') return;
  var ev = typeof CustomEvent === 'function'
    ? new CustomEvent(channelName, { detail: detail })
    : { type: channelName, detail: detail };
  doc.dispatchEvent(ev);
}

function sendToMain(payload, timeoutMs) {
  if (disposed) return Promise.reject(new Error('Isolated plugin disposed'));
  var reqId = pluginId + ':' + (++reqSeq) + ':' + Math.random().toString(36).slice(2);
  var limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 5000;
  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      pendingReqs.delete(reqId);
      reject(new Error('XWORLD_TIMEOUT: ' + (payload.action || 'request')));
    }, limit);
    pendingReqs.set(reqId, { resolve: resolve, reject: reject, timer: timer });
    dispatchToMain(Object.assign({ direction: 'to-main', reqId: reqId, pluginId: pluginId }, payload));
  });
}

function onChannelMessage(ev) {
  var detail = ev && ev.detail;
  if (!detail || detail.direction !== 'to-isolated') return;
  if (detail.reqId && pendingReqs.has(detail.reqId)) {
    var pending = pendingReqs.get(detail.reqId);
    pendingReqs.delete(detail.reqId);
    clearTimeout(pending.timer);
    if (detail.reply && detail.reply.ok) {
      pending.resolve(detail.reply.value);
    } else {
      pending.reject(new Error((detail.reply && detail.reply.error) || 'Cross-world call failed'));
    }
    return;
  }
  if (detail.event === 'unit.click' && detail.pluginId === pluginId) {
    var clickFn = unitClickHandlers.get(detail.unitId);
    if (typeof clickFn === 'function') {
      try { clickFn(); } catch {}
    }
    return;
  }
  if (detail.event === 'settings.change' && detail.pluginId === pluginId) {
    var changeFn = settingsHandlers.get(detail.sectionId || 'default');
    if (typeof changeFn === 'function') {
      try { changeFn(detail.key, detail.value, detail.values); } catch {}
    }
  }
}

if (doc && typeof doc.addEventListener === 'function') {
  doc.addEventListener(channelName, onChannelMessage);
}

function resolveAnchorSelectors(anchorName) {
  var def = anchorsRegistry && anchorsRegistry.anchors && anchorsRegistry.anchors[anchorName];
  if (!def || !Array.isArray(def.versions) || !def.versions.length) return [];
  return def.versions[0].selectors || [];
}

function queryAnchor(anchorName) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  var sels = resolveAnchorSelectors(anchorName);
  for (var i = 0; i < sels.length; i++) {
    try {
      var el = doc.querySelector(sels[i]);
      if (el) return el;
    } catch {}
  }
  return null;
}

function queryAnchorAll(anchorName) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return [];
  var sels = resolveAnchorSelectors(anchorName);
  for (var i = 0; i < sels.length; i++) {
    try {
      var list = Array.from(doc.querySelectorAll(sels[i]));
      if (list.length > 0) return list;
    } catch {}
  }
  return [];
}

var ctx = {
  pluginId: pluginId,
  hostVersion: hostVersion,
  anchors: {
    query: queryAnchor,
    queryAll: queryAnchorAll,
    observe: function(anchorName, fn) {
      var lastHit = queryAnchor(anchorName);
      if (lastHit && typeof fn === 'function') {
        try { fn(lastHit); } catch {}
      }
      var observer = null;
      if (typeof MutationObserver === 'function' && doc && doc.documentElement) {
        observer = new MutationObserver(function() {
          var nextHit = queryAnchor(anchorName);
          if (nextHit !== lastHit) {
            lastHit = nextHit;
            try { fn(nextHit); } catch {}
          }
        });
        try { observer.observe(doc.documentElement, { childList: true, subtree: true }); } catch {}
        localObservers.add(observer);
      }
      return function() {
        if (observer) {
          try { observer.disconnect(); } catch {}
          localObservers.delete(observer);
        }
      };
    }
  },
  topbar: {
    registerUnit: function(def) {
      if (!def || !def.id) throw new Error('registerUnit requires id');
      if (typeof def.onClick === 'function') {
        unitClickHandlers.set(def.id, def.onClick);
      }
      var op = sendToMain({
        action: 'topbar.registerUnit',
        unit: { id: def.id, order: def.order, label: def.label || def.id, icon: def.icon || null }
      });
      pendingSyncOps.push(op);
      return function() {
        unitClickHandlers.delete(def.id);
        if (!disposed) {
          void sendToMain({ action: 'topbar.disposeUnit', unitId: def.id }).catch(function(){});
        }
      };
    }
  },
  settings: {
    registerSection: function(def) {
      var sectionId = (def && def.id) || 'default';
      if (typeof def.onChange === 'function') {
        settingsHandlers.set(sectionId, def.onChange);
      }
      var op = sendToMain({
        action: 'settings.registerSection',
        section: {
          id: sectionId,
          title: def && def.title,
          schema: def && def.schema,
          values: (def && def.values) || {}
        }
      });
      pendingSyncOps.push(op);
      return function() {
        settingsHandlers.delete(sectionId);
      };
    }
  },
  schedule: {
    every: function(ms, fn) {
      var intervalMs = Math.max(50, Number(ms) || 1000);
      var id = setInterval(function() {
        if (disposed) return;
        if (doc && doc.hidden && intervalMs < 2000) return;
        try { fn(); } catch {}
      }, intervalMs);
      var rec = { kind: 'interval', id: id };
      localTimers.add(rec);
      return function() {
        clearInterval(id);
        localTimers.delete(rec);
      };
    },
    idle: function(fn) {
      var rec = { kind: 'timeout', id: null };
      rec.id = setTimeout(function() {
        localTimers.delete(rec);
        if (disposed) return;
        try { fn(); } catch {}
      }, 50);
      localTimers.add(rec);
      return function() {
        clearTimeout(rec.id);
        localTimers.delete(rec);
      };
    }
  },
  services: {
    call: function(service, method, args) {
      return sendToMain({ action: 'service.call', service: service, method: method, args: Array.isArray(args) ? args : [] });
    },
    get: function(service) {
      return new Proxy({}, {
        get: function(_, prop) {
          if (prop === 'then') return undefined;
          return function() {
            var args = Array.prototype.slice.call(arguments);
            return sendToMain({ action: 'service.call', service: service, method: String(prop), args: args });
          };
        }
      });
    }
  },
  events: {
    emit: function(topic, payload) {
      return sendToMain({ action: 'events.emit', topic: topic, payload: payload });
    }
  },
  state: {
    set: function(key, value) {
      return sendToMain({ action: 'state.set', key: key, value: value });
    },
    get: function(key) {
      return sendToMain({ action: 'state.get', key: key });
    },
    subscribe: function(key, fn) {
      var op = sendToMain({ action: 'state.get', key: key }).then(function(entry) {
        if (!disposed && entry && typeof fn === 'function') {
          try { fn(entry.value, { version: entry.version, replay: true }); } catch {}
        }
      }).catch(function(){});
      pendingSyncOps.push(op);
      return function() {};
    }
  },
  bridge: {
    post: async function(subPath, payload) {
      if (!bridgePort || typeof fetchFn !== 'function') {
        throw new Error('Bridge unavailable in isolated world');
      }
      var clean = String(subPath || '/').startsWith('/') ? String(subPath) : '/' + String(subPath);
      var resp = await fetchFn('http://127.0.0.1:' + bridgePort + '/plugins/' + pluginId + clean, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AGY-Plugin-Token': privateToken
        },
        body: JSON.stringify(payload === undefined ? {} : payload)
      });
      return resp.json();
    }
  }
};

var module = { exports: {} };
var exports = module.exports;
${rendererSource}

globalThis.__agyIsolatedDispose = async function() {
  if (disposed) return;
  disposed = true;
  if (module.exports && typeof module.exports.dispose === 'function') {
    try { await module.exports.dispose(); } catch {}
  }
  localTimers.forEach(function(t) {
    if (t.kind === 'interval') clearInterval(t.id);
    else clearTimeout(t.id);
  });
  localTimers.clear();
  localObservers.forEach(function(obs) {
    try { obs.disconnect(); } catch {}
  });
  localObservers.clear();
  pendingReqs.forEach(function(entry) {
    clearTimeout(entry.timer);
    entry.reject(new Error('Isolated plugin disposed'));
  });
  pendingReqs.clear();
  unitClickHandlers.clear();
  settingsHandlers.clear();
  if (doc && typeof doc.removeEventListener === 'function') {
    doc.removeEventListener(channelName, onChannelMessage);
  }
  dispatchToMain({ direction: 'to-main', action: 'plugin.dispose', pluginId: pluginId });
  try { delete globalThis.__agyIsolatedDispose; } catch {}
};

if (module.exports && typeof module.exports.mount === 'function') {
  await module.exports.mount(ctx);
}
if (pendingSyncOps.length > 0) {
  await Promise.all(pendingSyncOps);
}
return { ok: true, pluginId: pluginId, world: 'isolated' };
})();`;
}

class CdpInjector extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.hostBundlePath = options.hostBundlePath || DEFAULT_HOST_BUNDLE_PATH;
    this.bridgePortOption = options.bridgePort || 0;
    this.hostTokenOption = options.hostToken || '';
    this.stateDir = options.stateDir;
    this.anchorsPath = options.anchorsPath;
    this.antigravityVersion = options.antigravityVersion || '2.33.0';
    this.bus = options.bus || null;
    this.WebSocketCtor = options.WebSocket || globalThis.WebSocket;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000;
    this.cdpOptions = options.cdpOptions || {};
    this.reinjectDebounceMs = Number(options.reinjectDebounceMs) >= 0 ? Number(options.reinjectDebounceMs) : 150;
    this.sessions = new Map();
    this.lastActivePlugins = [];
  }

  getBridgePort() {
    if (typeof this.bridgePortOption === 'function') {
      return Number(this.bridgePortOption() || 0);
    }
    return Number(this.bridgePortOption || 0);
  }

  getHostToken() {
    if (typeof this.hostTokenOption === 'function') {
      return String(this.hostTokenOption() || '');
    }
    return String(this.hostTokenOption || '');
  }

  getResolvedAnchors() {
    const raw = loadAnchorsRegistry({ stateDir: this.stateDir, anchorsPath: this.anchorsPath });
    return buildResolvedAnchorsMap(raw, this.antigravityVersion);
  }

  readHostBundleSource() {
    if (!fs.existsSync(this.hostBundlePath)) {
      throw new Error(`Missing host renderer bundle at ${this.hostBundlePath}; run npm run build:renderer first`);
    }
    return fs.readFileSync(this.hostBundlePath, 'utf8');
  }

  async injectHostShell(session) {
    session.xworldNonce = crypto.randomBytes(16).toString('hex');
    session.xworldChannelName = `__agy_xworld_${session.xworldNonce}`;
    session.anchorsRegistry = this.getResolvedAnchors();
    const bundleSource = this.readHostBundleSource();
    const bootScript = buildHostBootstrapScript(bundleSource, {
      antigravityVersion: this.antigravityVersion,
      anchorsRegistry: session.anchorsRegistry,
      bridgePort: this.getBridgePort(),
      hostToken: this.getHostToken(),
      xworldNonce: session.xworldNonce
    });
    return session.client.evaluate(bootScript);
  }

  async injectPluginIntoSession(session, activeEntry) {
    if (!activeEntry?.manifest?.renderer) {
      return { ok: true, skipped: true };
    }
    const rendererPath = path.resolve(activeEntry.record.installPath, activeEntry.manifest.renderer);
    if (!fs.existsSync(rendererPath)) {
      throw new Error(`Renderer entry not found for ${activeEntry.id}: ${rendererPath}`);
    }
    const rendererSource = bundlePluginRendererSource(rendererPath, activeEntry.record.installPath);

    if (session.mountedPlugins.has(activeEntry.id)) {
      await this.disposePluginFromSession(session, activeEntry.id);
    }

    const world = activeEntry.trustPolicy?.world || 'isolated';
    if (world === 'isolated') {
      if (!session.frameId) {
        session.frameId = await session.client.getMainFrameId();
      }
      const contextId = await session.client.createIsolatedWorld(
        session.frameId,
        `agy-daddy:${activeEntry.id}`
      );
      const anchorsRegistry = session.anchorsRegistry || this.getResolvedAnchors();
      const isoScript = buildIsolatedWorldPluginScript(activeEntry.id, rendererSource, {
        xworldChannelName: session.xworldChannelName,
        bridgePort: this.getBridgePort(),
        pluginToken: activeEntry.pluginToken || '',
        anchorsRegistry,
        hostVersion: '1.0.0'
      });
      const evalRes = await session.client.evaluate(isoScript, { contextId });
      session.mountedPlugins.set(activeEntry.id, {
        world: 'isolated',
        contextId,
        version: activeEntry.manifest.version
      });
      return { ok: true, world: 'isolated', contextId, evalRes };
    }

    let legacyBundleParts = null;
    if (activeEntry.id === 'agy-daddy.legacy-suite' && this.bus) {
      const bundleRes = await this.bus.callService('legacy-suite', 'getBundle', [], { optional: true });
      if (bundleRes?.ok && Array.isArray(bundleRes.value?.parts)) {
        legacyBundleParts = bundleRes.value.parts;
      }
    }

    const mainScript = buildMainWorldPluginScript(activeEntry.id, rendererSource, {
      pluginToken: activeEntry.pluginToken || '',
      legacyBundleParts
    });
    const evalRes = await session.client.evaluate(mainScript);
    session.mountedPlugins.set(activeEntry.id, {
      world: 'main',
      contextId: null,
      version: activeEntry.manifest.version
    });
    return { ok: true, world: 'main', evalRes };
  }

  async disposePluginFromSession(session, pluginId) {
    const mounted = session.mountedPlugins.get(pluginId);
    session.mountedPlugins.delete(pluginId);
    if (!session.client?.ws) return false;

    if (mounted?.world === 'isolated' && typeof mounted.contextId === 'number') {
      try {
        await session.client.evaluate(
          'typeof globalThis.__agyIsolatedDispose === "function" ? globalThis.__agyIsolatedDispose() : false',
          { contextId: mounted.contextId }
        );
      } catch {}
    }

    try {
      await session.client.evaluate(
        `globalThis.__AGYDaddyHost && typeof globalThis.__AGYDaddyHost.disposePlugin === 'function' ? globalThis.__AGYDaddyHost.disposePlugin(${JSON.stringify(pluginId)}) : false`
      );
    } catch {}
    return true;
  }

  async reinjectSession(session) {
    if (session.closed || session.reinjectInFlight) return;
    session.reinjectInFlight = true;
    try {
      session.mountedPlugins.clear();
      session.frameId = await session.client.getMainFrameId();
      await this.injectHostShell(session);
      const errors = [];
      let pluginsInjected = 0;
      for (const entry of session.activePlugins) {
        try {
          const res = await this.injectPluginIntoSession(session, entry);
          if (!res.skipped) pluginsInjected++;
        } catch (err) {
          errors.push({ pluginId: entry.id, error: err?.message || String(err) });
        }
      }
      this.emit('reinjected', {
        targetId: session.targetId,
        xworldNonce: session.xworldNonce,
        pluginsInjected,
        errors
      });
    } finally {
      session.reinjectInFlight = false;
    }
  }

  scheduleReinject(session) {
    if (session.closed || !session.readyForNavEvents) return;
    if (session.reinjectTimer) {
      clearTimeout(session.reinjectTimer);
    }
    session.reinjectTimer = setTimeout(() => {
      session.reinjectTimer = null;
      void this.reinjectSession(session);
    }, this.reinjectDebounceMs);
  }

  async attachTarget(target, activePlugins = [], options = {}) {
    if (!target?.webSocketDebuggerUrl) {
      throw new Error('Target missing webSocketDebuggerUrl');
    }
    const targetId = target.id || target.webSocketDebuggerUrl;
    if (this.sessions.has(targetId)) {
      await this.detachSession(targetId);
    }

    const client = new CdpClient(target.webSocketDebuggerUrl, {
      WebSocket: options.WebSocket || this.WebSocketCtor,
      timeoutMs: options.timeoutMs || this.timeoutMs
    });

    const session = {
      targetId,
      target,
      client,
      frameId: null,
      xworldNonce: '',
      xworldChannelName: '',
      anchorsRegistry: null,
      mountedPlugins: new Map(),
      activePlugins: Array.from(activePlugins || []),
      reinjectTimer: null,
      reinjectInFlight: false,
      readyForNavEvents: false,
      closed: false
    };
    this.sessions.set(targetId, session);

    client.on('executionContextsCleared', () => this.scheduleReinject(session));
    client.on('frameNavigated', (params) => {
      if (!params?.frame?.parentId) {
        this.scheduleReinject(session);
      }
    });
    client.on('close', () => {
      session.closed = true;
      if (session.reinjectTimer) {
        clearTimeout(session.reinjectTimer);
        session.reinjectTimer = null;
      }
      this.sessions.delete(targetId);
    });

    try {
      await client.connect();
      await client.enable();
      session.frameId = await client.getMainFrameId();
      await this.injectHostShell(session);

      const errors = [];
      let pluginsInjected = 0;
      for (const entry of session.activePlugins) {
        try {
          const res = await this.injectPluginIntoSession(session, entry);
          if (!res.skipped) pluginsInjected++;
        } catch (err) {
          errors.push({ pluginId: entry.id, error: err?.message || String(err) });
        }
      }
      session.readyForNavEvents = true;

      return { targetId, url: target.url || '', pluginsInjected, errors, xworldNonce: session.xworldNonce };
    } catch (err) {
      await this.detachSession(targetId);
      throw err;
    }
  }

  async detachSession(targetId) {
    const session = this.sessions.get(targetId);
    if (!session) return false;
    session.closed = true;
    if (session.reinjectTimer) {
      clearTimeout(session.reinjectTimer);
      session.reinjectTimer = null;
    }
    this.sessions.delete(targetId);
    if (session.client?.ws) {
      for (const [pluginId, mounted] of session.mountedPlugins.entries()) {
        if (mounted.world === 'isolated' && typeof mounted.contextId === 'number') {
          try {
            await session.client.evaluate(
              'typeof globalThis.__agyIsolatedDispose === "function" ? globalThis.__agyIsolatedDispose() : false',
              { contextId: mounted.contextId }
            );
          } catch {}
        }
        session.mountedPlugins.delete(pluginId);
      }
      try {
        await session.client.evaluate(
          'globalThis.__AGYDaddyHost && typeof globalThis.__AGYDaddyHost.dispose === "function" ? globalThis.__AGYDaddyHost.dispose() : false'
        );
      } catch {}
      session.client.close();
    }
    return true;
  }

  async injectAllActiveTargets(activePlugins = [], options = {}) {
    this.lastActivePlugins = Array.from(activePlugins || []);
    let port = options.port || null;
    let targets = Array.isArray(options.targets) ? options.targets : null;

    if (!targets) {
      const resolved = await resolveActiveCdpTarget({ ...this.cdpOptions, ...(options.cdpOptions || {}) });
      port = resolved.port;
      targets = resolved.targets;
    }

    const results = [];
    const errors = [];
    let targetsInjected = 0;
    let pluginsInjected = 0;

    for (const target of targets || []) {
      try {
        const res = await this.attachTarget(target, this.lastActivePlugins, options);
        results.push(res);
        targetsInjected++;
        pluginsInjected += res.pluginsInjected;
        for (const e of res.errors) {
          errors.push({ targetId: res.targetId, ...e });
        }
      } catch (err) {
        errors.push({ targetId: target?.id || 'unknown', error: err?.message || String(err) });
      }
    }

    return {
      ok: true,
      port,
      targetsFound: (targets || []).length,
      targetsInjected,
      pluginsInjected,
      results,
      errors
    };
  }

  async reloadPlugin(pluginId, activeEntry = null) {
    this.lastActivePlugins = this.lastActivePlugins.filter((p) => p.id !== pluginId);
    if (activeEntry) {
      this.lastActivePlugins.push(activeEntry);
    }

    let sessionsUpdated = 0;
    const errors = [];
    for (const session of this.sessions.values()) {
      session.activePlugins = session.activePlugins.filter((p) => p.id !== pluginId);
      if (activeEntry) {
        session.activePlugins.push(activeEntry);
      }
      try {
        await this.disposePluginFromSession(session, pluginId);
        if (activeEntry?.manifest?.renderer) {
          await this.injectPluginIntoSession(session, activeEntry);
        }
        sessionsUpdated++;
      } catch (err) {
        errors.push({ targetId: session.targetId, error: err?.message || String(err) });
      }
    }
    return { ok: errors.length === 0, sessionsUpdated, errors };
  }

  async disposeAll() {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.detachSession(id);
    }
  }
}

module.exports = {
  DEFAULT_HOST_BUNDLE_PATH,
  bundlePluginRendererSource,
  buildHostBootstrapScript,
  buildMainWorldPluginScript,
  buildIsolatedWorldPluginScript,
  CdpInjector
};
