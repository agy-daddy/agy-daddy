'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { resolveActiveCdpTarget, CdpClient } = require('./cdp');
const { loadAnchorsRegistry, loadHealthAnchorsRegistry, buildResolvedAnchorsMap } = require('./anchors');

const DEFAULT_HOST_BUNDLE_PATH = path.resolve(__dirname, '..', '..', 'dist', 'host-renderer.js');
const HOST_PKG_VERSION = require('../../package.json').version;

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

  return `(async function(){
'use strict';
var module = { exports: {} };
var exports = module.exports;
${rendererSource}
var host = globalThis.__AGYDaddyHost;
if (!host || typeof host.mountPlugin !== 'function') {
  throw new Error('__AGYDaddyHost not initialized before mounting ' + ${pidJson});
}
return await host.mountPlugin(${pidJson}, module.exports, {
  pluginToken: ${tokenJson}
});
})();`;
}

function buildIsolatedWorldPluginScript(pluginId, rendererSource, options = {}) {
  const pidJson = JSON.stringify(pluginId);
  const channelJson = JSON.stringify(options.xworldChannelName || '');
  const xworldNonceJson = JSON.stringify(options.xworldNonce || (String(options.xworldChannelName || '').startsWith('__agy_xworld_') ? String(options.xworldChannelName).slice('__agy_xworld_'.length) : ''));
  const bridgePortNum = Number(options.bridgePort || 0);
  const tokenJson = JSON.stringify(options.pluginToken || '');
  const anchorsJson = JSON.stringify(options.anchorsRegistry || { anchors: {} });
  const hostVersionJson = JSON.stringify(options.hostVersion || HOST_PKG_VERSION);
  const initialSettingsJson = JSON.stringify(options.initialSettings && typeof options.initialSettings === 'object' ? options.initialSettings : {});

  return `(async function(){
'use strict';
if (typeof globalThis.__agyIsolatedDispose === 'function') {
  try { await globalThis.__agyIsolatedDispose(); } catch {}
}

var pluginId = ${pidJson};
var channelName = ${channelJson};
var lifecycleEventName = '__agy_xworld_lifecycle__';
var myNonce = ${xworldNonceJson};
var instanceId = pluginId + ':' + Date.now().toString(36) + ':' + Math.random().toString(36).slice(2);
var bridgePort = ${bridgePortNum};
var privateToken = ${tokenJson};
var anchorsRegistry = ${anchorsJson};
var hostVersion = ${hostVersionJson};
var currentSettings = ${initialSettingsJson};
var doc = globalThis.document;
var fetchFn = globalThis.fetch;

var reqSeq = 0;
var styleSeq = 0;
var pendingReqs = new Map();
var unitClickHandlers = new Map();
var popoverToggleHandlers = new Map();
var settingsChangeHandlers = new Set();
var eventHandlers = new Map();
var stateHandlers = new Map();
var providedServices = new Map();
var providedSurfaces = new Map();
var surfaceSubs = new Map();
var injectedStyleIds = new Set();
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

function findShadowNode(selector) {
  if (!doc || !selector) return null;
  var hostEl = typeof doc.getElementById === 'function'
    ? doc.getElementById('agy-daddy-host')
    : (typeof doc.querySelector === 'function' ? doc.querySelector('#agy-daddy-host') : null);
  if (!hostEl || !hostEl.shadowRoot || typeof hostEl.shadowRoot.querySelector !== 'function') return null;
  try { return hostEl.shadowRoot.querySelector(selector); } catch { return null; }
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

function observeAnchor(anchorName, fn) {
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

function findSurfaceElement(surfaceName, selector) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  if (selector) {
    try {
      var direct = doc.querySelector(selector);
      if (direct) return direct;
    } catch {}
  }
  try {
    return doc.querySelector('[data-agy-surface="' + surfaceName + '"]');
  } catch {
    return null;
  }
}

function teardownSurfaceSub(sub) {
  if (typeof sub.currentCleanup === 'function') {
    try { sub.currentCleanup(); } catch {}
  }
  sub.currentCleanup = null;
  sub.currentEl = null;
  sub.usingFallback = false;
}

function syncSurfaceSub(sub, available, selector) {
  if (sub.disposed || disposed) return;
  if (available) {
    var el = findSurfaceElement(sub.surfaceName, selector);
    if (el) {
      if (sub.currentEl === el && !sub.usingFallback) return;
      teardownSurfaceSub(sub);
      if (sub.stopFallbackObs) {
        try { sub.stopFallbackObs(); } catch {}
        sub.stopFallbackObs = null;
      }
      sub.currentEl = el;
      sub.usingFallback = false;
      try {
        var cleanup = sub.mountFn(el, { surfaceName: sub.surfaceName, fallback: false });
        if (typeof cleanup === 'function') sub.currentCleanup = cleanup;
      } catch {}
      return;
    }
  }
  if (!sub.usingFallback && sub.currentEl) {
    teardownSurfaceSub(sub);
  }
  if (sub.fallbackAnchor) {
    var mountFallback = function(anchorEl) {
      if (sub.disposed || disposed || (sub.currentEl && !sub.usingFallback)) return;
      if (anchorEl && sub.currentEl !== anchorEl) {
        teardownSurfaceSub(sub);
        sub.currentEl = anchorEl;
        sub.usingFallback = true;
        try {
          var fc = sub.mountFn(anchorEl, { surfaceName: sub.surfaceName, fallback: true });
          if (typeof fc === 'function') sub.currentCleanup = fc;
        } catch {}
      }
    };
    var fallbackEl = queryAnchor(sub.fallbackAnchor);
    if (fallbackEl) mountFallback(fallbackEl);
    if (!sub.stopFallbackObs) {
      sub.stopFallbackObs = observeAnchor(sub.fallbackAnchor, mountFallback);
    }
  }
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
  if (detail.event === 'popover.toggle' && detail.pluginId === pluginId) {
    var toggleFn = popoverToggleHandlers.get(detail.popoverId);
    if (typeof toggleFn === 'function') {
      try { toggleFn(Boolean(detail.open)); } catch {}
    }
    return;
  }
  if (detail.event === 'settings.changed' && detail.pluginId === pluginId) {
    var nextValues = detail.values && typeof detail.values === 'object' ? Object.assign({}, detail.values) : {};
    var changedKeys = Array.isArray(detail.changedKeys) ? detail.changedKeys.slice() : [];
    currentSettings = nextValues;
    Array.from(settingsChangeHandlers).forEach(function(fn) {
      try { fn(Object.assign({}, currentSettings), changedKeys.slice()); } catch {}
    });
    return;
  }
  if (detail.event === 'surface.changed' && (!detail.pluginId || detail.pluginId === pluginId)) {
    var subs = surfaceSubs.get(detail.surfaceName);
    if (subs) {
      Array.from(subs).forEach(function(sub) {
        syncSurfaceSub(sub, Boolean(detail.available), detail.selector || null);
      });
    }
    return;
  }
  if (detail.event === 'bus.event' && (!detail.pluginId || detail.pluginId === pluginId)) {
    var evSet = eventHandlers.get(detail.topic);
    if (evSet) {
      Array.from(evSet).forEach(function(fn) {
        try { fn(detail.payload, { topic: detail.topic }); } catch {}
      });
    }
    return;
  }
  if (detail.event === 'bus.state' && (!detail.pluginId || detail.pluginId === pluginId)) {
    var stSet = stateHandlers.get(detail.key);
    if (stSet) {
      Array.from(stSet).forEach(function(entry) {
        if (typeof detail.version === 'number' && detail.version <= entry.lastVersion) return;
        if (typeof detail.version === 'number') entry.lastVersion = detail.version;
        try {
          entry.fn(detail.value, { key: detail.key, version: detail.version, replay: Boolean(detail.replay) });
        } catch {}
      });
    }
    return;
  }
  if (detail.event === 'service.invoke' && detail.pluginId === pluginId) {
    var svcName = detail.service || detail.name;
    var svcMethods = providedServices.get(svcName);
    void (async function() {
      try {
        if (!svcMethods || typeof svcMethods[detail.method] !== 'function') {
          throw new Error('SERVICE_METHOD_NOT_FOUND: ' + svcName + '.' + detail.method);
        }
        var out = await svcMethods[detail.method].apply(svcMethods, Array.isArray(detail.args) ? detail.args : []);
        var safeOut = out === undefined ? null : JSON.parse(JSON.stringify(out));
        dispatchToMain({
          direction: 'to-main',
          action: 'service.reply',
          pluginId: pluginId,
          invokeId: detail.invokeId,
          ok: true,
          value: safeOut
        });
      } catch (err) {
        dispatchToMain({
          direction: 'to-main',
          action: 'service.reply',
          pluginId: pluginId,
          invokeId: detail.invokeId,
          ok: false,
          error: (err && err.message) || String(err)
        });
      }
    })();
  }
}

function onLifecycleEvent(ev) {
  var d = ev && ev.detail;
  if (!d || typeof d !== 'object' || disposed) return;
  if (d.type === 'host.reset' && d.nextNonce && d.nextNonce !== myNonce) {
    if (typeof globalThis.__agyIsolatedDispose === 'function') {
      void globalThis.__agyIsolatedDispose();
    }
    return;
  }
  if (d.type === 'host.dispose' && (!d.nonce || d.nonce === myNonce)) {
    if (typeof globalThis.__agyIsolatedDispose === 'function') {
      void globalThis.__agyIsolatedDispose();
    }
    return;
  }
  if (d.type === 'plugin.dispose' && d.pluginId === pluginId && d.instanceId !== instanceId) {
    if (typeof globalThis.__agyIsolatedDispose === 'function') {
      void globalThis.__agyIsolatedDispose();
    }
  }
}

if (doc && typeof doc.dispatchEvent === 'function') {
  var evPre = typeof CustomEvent === 'function'
    ? new CustomEvent(lifecycleEventName, { detail: { type: 'plugin.dispose', pluginId: pluginId, instanceId: instanceId } })
    : { type: lifecycleEventName, detail: { type: 'plugin.dispose', pluginId: pluginId, instanceId: instanceId } };
  try { doc.dispatchEvent(evPre); } catch {}
}

if (doc && typeof doc.addEventListener === 'function') {
  doc.addEventListener(channelName, onChannelMessage);
  doc.addEventListener(lifecycleEventName, onLifecycleEvent);
}

var sendTextSeq = 0;

var hostDom = {
  getSessionId: function() {
    var href = String((globalThis.location && globalThis.location.href) || (doc && doc.URL) || '');
    var m = href.match(/([0-9a-f]{8}-[0-9a-f-]{27,})/i);
    return m ? m[1] : null;
  },
  getComposer: function() {
    return queryAnchor('composer.editor') || queryAnchor('composer.root');
  },
  getScrollViewport: function() {
    return queryAnchor('chat.scrollViewport');
  },
  getSidebarRows: function() {
    return queryAnchorAll('sidebar.conversationRows');
  },
  isAssistantBusy: function() {
    var cancelBtn = doc && typeof doc.querySelector === 'function'
      ? doc.querySelector('.surface-composer [data-testid="input-cancel-button"], [data-testid="input-cancel-button"]')
      : null;
    return Boolean(cancelBtn && !cancelBtn.disabled);
  },
  sendText: function(text) {
    var editor = queryAnchor('composer.editor');
    if (!editor) return false;
    var raw = String(text || '');
    if (!doc || typeof doc.execCommand !== 'function') {
      if ('textContent' in editor) editor.textContent = raw;
      var sendBtn = queryAnchor('composer.sendButton');
      if (sendBtn && !sendBtn.disabled && typeof sendBtn.click === 'function') {
        sendBtn.click();
        return true;
      }
      return false;
    }

    var seq = ++sendTextSeq;
    var trimmed = raw.trim();
    var slashMatch = trimmed.match(/^\\/([a-zA-Z0-9][a-zA-Z0-9_-]*)$/);
    var insertStr = slashMatch ? ('/' + slashMatch[1]) : raw;

    function readNormalizedEditorText(ed) {
      if (!ed) return '';
      var cur = String((typeof ed.innerText === 'string' && ed.innerText.length > 0 ? ed.innerText : ed.textContent) || '');
      return cur.replace(/[\\u200B-\\u200D\\uFEFF]/g, '').replace(/\\r?\\n$/, '');
    }

    function insertTextSafely(ed, str) {
      var beforeText = readNormalizedEditorText(ed);
      var capturedBeforeInput = null;
      var onBeforeInput = function(ev) {
        if (!ev) return;
        if (!ev.inputType || ev.inputType === 'insertText') {
          capturedBeforeInput = ev;
        }
      };
      var canListenDoc = typeof doc.addEventListener === 'function' && typeof doc.removeEventListener === 'function';
      var canListenEd = ed && typeof ed.addEventListener === 'function' && typeof ed.removeEventListener === 'function';
      if (canListenDoc) doc.addEventListener('beforeinput', onBeforeInput, true);
      if (canListenEd) ed.addEventListener('beforeinput', onBeforeInput, true);
      var inserted = false;
      try {
        inserted = Boolean(doc.execCommand('insertText', false, str));
      } finally {
        if (canListenDoc) doc.removeEventListener('beforeinput', onBeforeInput, true);
        if (canListenEd) ed.removeEventListener('beforeinput', onBeforeInput, true);
      }
      var prevented = Boolean(capturedBeforeInput && capturedBeforeInput.defaultPrevented);
      var afterText = readNormalizedEditorText(ed);
      var textApplied = Boolean(str) && afterText !== beforeText && (afterText === str || afterText.endsWith(str));
      if (!inserted && !prevented && !textApplied && typeof globalThis.InputEvent === 'function') {
        ed.dispatchEvent && ed.dispatchEvent(new globalThis.InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: str
        }));
      }
      return Boolean(inserted || prevented || textApplied);
    }

    function hasPendingContent() {
      var cur = readNormalizedEditorText(editor).trim();
      if (cur.length > 0) return true;
      return Boolean(editor.querySelector && editor.querySelector('[data-lexical-decorator], [data-uri]'));
    }

    function clickSendIfReady() {
      if (!hasPendingContent()) return false;
      var btn = queryAnchor('composer.sendButton');
      if (btn && !btn.disabled && typeof btn.click === 'function') {
        btn.click();
        return true;
      }
      return false;
    }

    function findSlashOption(cmdName) {
      var lower = String(cmdName || '').trim().toLowerCase();
      if (!lower || typeof doc.querySelectorAll !== 'function') return null;
      var withSlash = '/' + lower;
      var escaped = lower.replace(/[.*+?^$\{}()|[\\]\\\\]/g, '\\\\$&');
      var boundaryRe = new RegExp('^\\\\/?' + escaped + '(?:$|\\\\s|[\\\\u4e00-\\\\u9fff])', 'i');
      var opts = Array.prototype.slice.call(doc.querySelectorAll('[role="listbox"] [role="option"], [role="menu"] [role="menuitem"], [role="option"]') || []).filter(function(opt) {
        if (!opt) return false;
        if (opt.hidden === true || (opt.getAttribute && opt.getAttribute('aria-hidden') === 'true')) return false;
        if (opt.closest && opt.closest('#agy-daddy-host, [data-agy-surface]')) return false;
        return true;
      });
      for (var i = 0; i < opts.length; i++) {
        var opt = opts[i];
        var cmdAttr = String((opt.getAttribute && (opt.getAttribute('data-command') || opt.getAttribute('data-slash-command') || opt.getAttribute('data-value'))) || '').trim().toLowerCase();
        if (cmdAttr && (cmdAttr === lower || cmdAttr === withSlash)) return opt;
        var leaves = Array.prototype.slice.call((opt.querySelectorAll && opt.querySelectorAll('span, div, code, strong, p')) || []);
        for (var j = 0; j < leaves.length; j++) {
          var leaf = leaves[j];
          if (leaf.children && leaf.children.length > 0) continue;
          var txt = String(leaf.textContent || '').trim().toLowerCase();
          if (txt === lower || txt === withSlash) return opt;
        }
      }
      for (var k = 0; k < opts.length; k++) {
        var full = String(opts[k].textContent || '').replace(/\\s+/g, ' ').trim();
        if (boundaryRe.test(full)) return opts[k];
      }
      return null;
    }

    function trackTimeout(fn, ms) {
      var entry = { id: null, kind: 'timeout' };
      entry.id = setTimeout(function() {
        localTimers.delete(entry);
        if (!disposed && seq === sendTextSeq) fn();
      }, ms);
      localTimers.add(entry);
    }

    function runInsertAndSend() {
      if (disposed || seq !== sendTextSeq) return;
      try {
        editor.focus && editor.focus();
        var sel = typeof globalThis.getSelection === 'function' ? globalThis.getSelection() : null;
        if (sel && typeof doc.createRange === 'function') {
          var r = doc.createRange();
          r.selectNodeContents(editor);
          r.collapse(false);
          sel.removeAllRanges();
          sel.addRange(r);
        }
        insertTextSafely(editor, insertStr);
      } catch {
        if ('textContent' in editor) editor.textContent = insertStr;
      }

      if (slashMatch) {
        var cmd = slashMatch[1];
        var attempt = 0;
        var pollSlash = function() {
          if (seq !== sendTextSeq) return;
          var opt = findSlashOption(cmd);
          if (opt) {
            var target = (opt.querySelector && opt.querySelector('div.cursor-pointer')) || opt;
            try {
              if (typeof globalThis.MouseEvent === 'function') {
                target.dispatchEvent && target.dispatchEvent(new globalThis.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
              }
            } catch {}
            target.click && target.click();
            trackTimeout(function() {
              clickSendIfReady();
            }, 40);
            return;
          }
          if (attempt++ < 6) {
            trackTimeout(pollSlash, 35);
          } else {
            clickSendIfReady();
          }
        };
        pollSlash();
        return;
      }

      if (!clickSendIfReady()) {
        trackTimeout(function() {
          clickSendIfReady();
        }, 35);
      }
    }

    if (hasPendingContent()) {
      try {
        editor.focus && editor.focus();
        doc.execCommand('selectAll', false, null);
        doc.execCommand('delete', false, null);
      } catch {}
      if (!hasPendingContent()) {
        runInsertAndSend();
      } else {
        trackTimeout(runInsertAndSend, 20);
      }
    } else {
      runInsertAndSend();
    }
    return true;
  }
};

var ctx = {
  pluginId: pluginId,
  hostVersion: hostVersion,
  hostDom: hostDom,
  anchors: {
    query: queryAnchor,
    queryAll: queryAnchorAll,
    observe: observeAnchor
  },
  styles: {
    inject: function(cssText, opts) {
      var o = opts && typeof opts === 'object' ? opts : {};
      var styleId = o.id ? String(o.id) : (pluginId + ':style:' + (++styleSeq));
      var scope = o.scope === 'shadow' ? 'shadow' : 'document';
      injectedStyleIds.add(styleId);
      var op = sendToMain({
        action: 'styles.inject',
        styleId: styleId,
        css: String(cssText || ''),
        scope: scope
      });
      pendingSyncOps.push(op);
      return function() {
        injectedStyleIds.delete(styleId);
        if (!disposed) {
          void sendToMain({ action: 'styles.dispose', styleId: styleId }).catch(function(){});
        }
      };
    }
  },
  topbar: {
    registerUnit: function(def) {
      if (!def || !def.id) throw new Error('registerUnit requires id');
      var handlerFn = typeof def.onClick === 'function' ? def.onClick : null;
      if (handlerFn) {
        unitClickHandlers.set(def.id, handlerFn);
      }
      var op = sendToMain({
        action: 'topbar.registerUnit',
        unit: {
          id: def.id,
          order: def.order,
          label: def.label !== undefined ? def.label : def.id,
          iconSvg: def.iconSvg || null,
          segments: Array.isArray(def.segments) ? def.segments : null,
          title: typeof def.title === 'string' ? def.title : undefined,
          badge: def.badge !== undefined ? def.badge : null,
          tone: def.tone || null,
          accentColor: def.accentColor || null
        }
      }).then(function(res) {
        if (!disposed && typeof def.render === 'function' && res && res.slotSelector) {
          var node = findShadowNode(res.slotSelector);
          if (node) {
            try { def.render(node); } catch {}
          }
        }
        return res;
      });
      pendingSyncOps.push(op);
      return function() {
        if (!handlerFn || unitClickHandlers.get(def.id) === handlerFn) {
          unitClickHandlers.delete(def.id);
        }
        if (!disposed) {
          void sendToMain({ action: 'topbar.disposeUnit', unitId: def.id }).catch(function(){});
        }
      };
    },
    updateUnit: function(unitId, patch) {
      if (!unitId) return Promise.resolve({ ok: false });
      var p = patch && typeof patch === 'object' ? patch : {};
      if (typeof p.onClick === 'function') {
        unitClickHandlers.set(unitId, p.onClick);
      }
      var cleanPatch = {};
      if (p.label !== undefined) cleanPatch.label = p.label;
      if (p.iconSvg !== undefined) cleanPatch.iconSvg = p.iconSvg;
      if (p.segments !== undefined) cleanPatch.segments = Array.isArray(p.segments) ? p.segments : null;
      if (p.title !== undefined) cleanPatch.title = p.title;
      if (p.badge !== undefined) cleanPatch.badge = p.badge;
      if (p.tone !== undefined) cleanPatch.tone = p.tone;
      if (p.accentColor !== undefined) cleanPatch.accentColor = p.accentColor;
      if (p.order !== undefined) cleanPatch.order = p.order;
      return sendToMain({
        action: 'topbar.updateUnit',
        unitId: unitId,
        patch: cleanPatch
      }).then(function(res) {
        if (!disposed && typeof p.render === 'function' && res && res.slotSelector) {
          var node = findShadowNode(res.slotSelector);
          if (node) {
            try { p.render(node); } catch {}
          }
        }
        return res;
      });
    },
    setAvailable: function(available) {
      void sendToMain({ action: 'topbar.setAvailable', available: available !== false }).catch(function(){});
    },
    registerPopover: function(def) {
      if (!def || !def.id) throw new Error('registerPopover requires id');
      if (typeof def.onToggle === 'function') {
        popoverToggleHandlers.set(def.id, def.onToggle);
      }
      var op = sendToMain({
        action: 'topbar.registerPopover',
        popover: {
          id: def.id,
          anchorId: def.anchorId || null,
          title: def.title || def.id
        }
      }).then(function(res) {
        if (!disposed && typeof def.render === 'function' && res && res.slotSelector) {
          var bodyNode = findShadowNode(res.slotSelector);
          if (bodyNode) {
            try { def.render(bodyNode); } catch {}
          }
        }
        return res;
      });
      pendingSyncOps.push(op);
      return {
        toggle: function(force, opts) {
          var resolvedForce = force;
          var resolvedOpts = opts && typeof opts === 'object' ? opts : {};
          if (force && typeof force === 'object') {
            resolvedOpts = force;
            resolvedForce = force.force;
          }
          var cleanRect = null;
          var rawRect = resolvedOpts.anchorRect;
          if (rawRect && typeof rawRect === 'object') {
            var rt = Number(rawRect.top), rl = Number(rawRect.left), rr = Number(rawRect.right), rb = Number(rawRect.bottom), rw = Number(rawRect.width), rh = Number(rawRect.height);
            if (isFinite(rt) && isFinite(rl) && isFinite(rr) && isFinite(rb) && isFinite(rw) && isFinite(rh) && (rw > 0 || rh > 0)) {
              cleanRect = { top: rt, left: rl, right: rr, bottom: rb, width: rw, height: rh };
            }
          }
          return sendToMain({
            action: 'topbar.togglePopover',
            popoverId: def.id,
            force: typeof resolvedForce === 'boolean' ? resolvedForce : undefined,
            anchorRect: cleanRect,
            placement: typeof resolvedOpts.placement === 'string' ? resolvedOpts.placement : undefined
          });
        },
        dispose: function() {
          popoverToggleHandlers.delete(def.id);
          if (!disposed) {
            void sendToMain({ action: 'topbar.disposePopover', popoverId: def.id }).catch(function(){});
          }
        }
      };
    }
  },
  surfaces: {
    provide: function(surfaceName, el) {
      if (!surfaceName || !el) throw new Error('surfaces.provide requires surfaceName and element');
      if (typeof el.setAttribute === 'function') {
        el.setAttribute('data-agy-surface', surfaceName);
      }
      providedSurfaces.set(surfaceName, el);
      var op = sendToMain({ action: 'surfaces.provide', surfaceName: surfaceName });
      pendingSyncOps.push(op);
      return function() {
        if (providedSurfaces.get(surfaceName) === el) providedSurfaces.delete(surfaceName);
        if (typeof el.removeAttribute === 'function' && typeof el.getAttribute === 'function' && el.getAttribute('data-agy-surface') === surfaceName) {
          el.removeAttribute('data-agy-surface');
        }
        if (!disposed) {
          void sendToMain({ action: 'surfaces.revoke', surfaceName: surfaceName }).catch(function(){});
        }
      };
    },
    mount: function(surfaceName, mountFn, opts) {
      if (!surfaceName || typeof mountFn !== 'function') {
        throw new Error('surfaces.mount requires surfaceName and mountFn');
      }
      var sub = {
        surfaceName: surfaceName,
        mountFn: mountFn,
        fallbackAnchor: opts && opts.fallbackAnchor ? opts.fallbackAnchor : null,
        currentEl: null,
        currentCleanup: null,
        usingFallback: false,
        stopFallbackObs: null,
        disposed: false
      };
      if (!surfaceSubs.has(surfaceName)) surfaceSubs.set(surfaceName, new Set());
      surfaceSubs.get(surfaceName).add(sub);
      var op = sendToMain({ action: 'surfaces.subscribe', surfaceName: surfaceName }).then(function(res) {
        if (!sub.disposed && !disposed) {
          syncSurfaceSub(sub, Boolean(res && res.available), res && res.selector ? res.selector : null);
        }
        return res;
      }).catch(function() {
        if (!sub.disposed && !disposed) {
          syncSurfaceSub(sub, false, null);
        }
      });
      pendingSyncOps.push(op);
      return function() {
        sub.disposed = true;
        teardownSurfaceSub(sub);
        if (sub.stopFallbackObs) {
          try { sub.stopFallbackObs(); } catch {}
          sub.stopFallbackObs = null;
        }
        var set = surfaceSubs.get(surfaceName);
        if (set) {
          set.delete(sub);
          if (set.size === 0) {
            surfaceSubs.delete(surfaceName);
            if (!disposed) {
              void sendToMain({ action: 'surfaces.unsubscribe', surfaceName: surfaceName }).catch(function(){});
            }
          }
        }
      };
    }
  },
  settings: {
    get: function() {
      return Object.assign({}, currentSettings);
    },
    update: function(patch) {
      var p = patch && typeof patch === 'object' ? patch : {};
      return sendToMain({ action: 'settings.update', values: p, patch: p }).then(function(res) {
        if (res && typeof res === 'object') {
          if (res.ok !== false && res.values && typeof res.values === 'object') {
            currentSettings = Object.assign({}, res.values);
          } else if (res.ok === undefined) {
            currentSettings = Object.assign({}, res);
          }
        }
        return res;
      });
    },
    onChange: function(fn) {
      if (typeof fn !== 'function') return function() {};
      settingsChangeHandlers.add(fn);
      return function() {
        settingsChangeHandlers.delete(fn);
      };
    },
    open: function(opts) {
      var tab = 'plugins';
      var targetPluginId = pluginId;
      if (typeof opts === 'string' && opts.trim()) {
        tab = opts.trim();
        if (tab !== 'plugins') targetPluginId = undefined;
      } else if (opts && typeof opts === 'object') {
        if (typeof opts.tab === 'string' && opts.tab.trim()) tab = opts.tab.trim();
        if ('pluginId' in opts) {
          targetPluginId = typeof opts.pluginId === 'string' && opts.pluginId.trim() ? opts.pluginId.trim() : undefined;
        } else if (tab !== 'plugins') {
          targetPluginId = undefined;
        }
      }
      return sendToMain({
        action: 'settings.open',
        tab: tab,
        pluginId: targetPluginId,
        targetPluginId: targetPluginId
      });
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
    provide: function(name, methods) {
      if (!name || !methods || typeof methods !== 'object') {
        throw new Error('services.provide requires name and methods object');
      }
      providedServices.set(name, methods);
      var methodNames = Object.keys(methods).filter(function(k) { return typeof methods[k] === 'function'; });
      var op = sendToMain({
        action: 'services.provide',
        name: name,
        service: name,
        methods: methodNames
      });
      pendingSyncOps.push(op);
      return function() {
        if (providedServices.get(name) === methods) providedServices.delete(name);
        if (!disposed) {
          void sendToMain({ action: 'services.revoke', name: name, service: name }).catch(function(){});
        }
      };
    },
    call: function(service, method, args) {
      return sendToMain({
        action: 'services.call',
        service: service,
        name: service,
        method: method,
        args: Array.isArray(args) ? args : []
      });
    },
    get: function(service) {
      return new Proxy({}, {
        get: function(_, prop) {
          if (prop === 'then') return undefined;
          return function() {
            var args = Array.prototype.slice.call(arguments);
            return sendToMain({
              action: 'services.call',
              service: service,
              name: service,
              method: String(prop),
              args: args
            });
          };
        }
      });
    }
  },
  events: {
    emit: function(topic, payload) {
      return sendToMain({ action: 'events.emit', topic: topic, payload: payload });
    },
    on: function(topic, fn) {
      if (typeof fn !== 'function') return function() {};
      var first = !eventHandlers.has(topic);
      if (first) eventHandlers.set(topic, new Set());
      eventHandlers.get(topic).add(fn);
      if (first) {
        var op = sendToMain({ action: 'events.subscribe', topic: topic });
        pendingSyncOps.push(op);
      }
      return function() {
        var set = eventHandlers.get(topic);
        if (set) {
          set.delete(fn);
          if (set.size === 0) {
            eventHandlers.delete(topic);
            if (!disposed) {
              void sendToMain({ action: 'events.unsubscribe', topic: topic }).catch(function(){});
            }
          }
        }
      };
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
      if (typeof fn !== 'function') return function() {};
      var entry = { fn: fn, lastVersion: -1 };
      var first = !stateHandlers.has(key);
      if (first) stateHandlers.set(key, new Set());
      stateHandlers.get(key).add(entry);
      var op = sendToMain({ action: 'state.subscribe', key: key }).then(function(res) {
        if (!disposed && res && typeof res === 'object' && 'value' in res) {
          if (typeof res.version !== 'number' || res.version > entry.lastVersion) {
            if (typeof res.version === 'number') entry.lastVersion = res.version;
            try { entry.fn(res.value, { key: key, version: res.version, replay: true }); } catch {}
          }
        }
      }).catch(function(){});
      pendingSyncOps.push(op);
      return function() {
        var set = stateHandlers.get(key);
        if (set) {
          set.delete(entry);
          if (set.size === 0) {
            stateHandlers.delete(key);
            if (!disposed) {
              void sendToMain({ action: 'state.unsubscribe', key: key }).catch(function(){});
            }
          }
        }
      };
    }
  },
  commands: {
    execute: function(commandId, args) {
      return sendToMain({
        action: 'commands.execute',
        commandId: commandId,
        args: Array.isArray(args) ? args : []
      });
    }
  },
  bridge: {
    post: async function(subPath, payload, opts) {
      if (!bridgePort || typeof fetchFn !== 'function') {
        throw new Error('Bridge unavailable in isolated world');
      }
      var clean = String(subPath || '/').startsWith('/') ? String(subPath) : '/' + String(subPath);
      var fetchInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AGY-Plugin-Token': privateToken
        },
        body: JSON.stringify(payload === undefined ? {} : payload)
      };
      if (opts && opts.signal) fetchInit.signal = opts.signal;
      var resp = await fetchFn.call(globalThis, 'http://127.0.0.1:' + bridgePort + '/plugins/' + pluginId + clean, fetchInit);
      if (typeof resp.text === 'function') {
        var rawText = await resp.text();
        if (rawText) {
          try {
            return JSON.parse(rawText);
          } catch {}
        }
        if (!resp.ok) {
          return {
            ok: false,
            status: resp.status,
            error: 'HTTP ' + resp.status + (rawText ? ': ' + rawText.slice(0, 200) : '')
          };
        }
        return { ok: true };
      }
      if (typeof resp.json === 'function') {
        return await resp.json();
      }
      return { ok: Boolean(resp.ok), status: resp.status };
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
  surfaceSubs.forEach(function(set) {
    set.forEach(function(sub) {
      sub.disposed = true;
      teardownSurfaceSub(sub);
      if (sub.stopFallbackObs) {
        try { sub.stopFallbackObs(); } catch {}
        sub.stopFallbackObs = null;
      }
    });
  });
  surfaceSubs.clear();
  providedSurfaces.forEach(function(el, surfaceName) {
    try {
      if (el && typeof el.removeAttribute === 'function' && el.getAttribute('data-agy-surface') === surfaceName) {
        el.removeAttribute('data-agy-surface');
      }
    } catch {}
  });
  providedSurfaces.clear();
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
  popoverToggleHandlers.clear();
  settingsChangeHandlers.clear();
  eventHandlers.clear();
  stateHandlers.clear();
  providedServices.clear();
  injectedStyleIds.clear();
  if (doc && typeof doc.removeEventListener === 'function') {
    doc.removeEventListener(channelName, onChannelMessage);
    doc.removeEventListener(lifecycleEventName, onLifecycleEvent);
  }
  dispatchToMain({ direction: 'to-main', action: 'plugin.dispose', pluginId: pluginId });
  try { delete globalThis.__agyIsolatedDispose; } catch {}
};

if (module.exports && typeof module.exports.mount === 'function') {
  await module.exports.mount(ctx);
}
while (pendingSyncOps.length > 0) {
  var batch = pendingSyncOps.splice(0, pendingSyncOps.length);
  await Promise.all(batch);
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
    this.healthAnchors = loadHealthAnchorsRegistry(options);
    this.antigravityVersion = options.antigravityVersion || '2.33.0';
    this.bus = options.bus || null;
    this.WebSocketCtor = options.WebSocket || globalThis.WebSocket;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000;
    this.cdpOptions = options.cdpOptions || {};
    this.reinjectDebounceMs = Number(options.reinjectDebounceMs) >= 0 ? Number(options.reinjectDebounceMs) : 150;
    this.getHostSettingsOption = options.getHostSettings || null;
    this.getPluginMetaMapOption = options.getPluginMetaMap || null;
    this.getPluginSettingsOption = options.getPluginSettings || null;
    this.onPluginInjectError = typeof options.onPluginInjectError === 'function' ? options.onPluginInjectError : null;
    this.onPluginInjectSuccess = typeof options.onPluginInjectSuccess === 'function' ? options.onPluginInjectSuccess : null;
    this.sessions = new Map();
    this.lastActivePlugins = [];
    this.lastCdpPort = null;
  }

  getHostSettings() {
    if (typeof this.getHostSettingsOption === 'function') {
      return this.getHostSettingsOption();
    }
    return this.getHostSettingsOption || null;
  }

  getPluginMetaMap() {
    if (typeof this.getPluginMetaMapOption === 'function') {
      return this.getPluginMetaMapOption() || {};
    }
    return this.getPluginMetaMapOption || {};
  }

  getPluginSettings(pluginId, fallback = {}) {
    if (typeof this.getPluginSettingsOption === 'function') {
      try {
        return this.getPluginSettingsOption(pluginId) || fallback;
      } catch {
        return fallback;
      }
    }
    return fallback;
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

  async refreshHealthProbes(targets = []) {
    if (targets.length === 0) return;
    const registry = buildResolvedAnchorsMap(this.healthAnchors, this.antigravityVersion);
    const anchorSelectors = Object.fromEntries(Object.entries(registry.anchors).map(([name, def]) => [
      name, def.versions[0].selectors
    ]));
    const probes = targets.map(async (target) => {
      const session = this.sessions.get(target.id || target.webSocketDebuggerUrl);
      if (!session?.readyForNavEvents || session.closed || session.reinjectInFlight ||
          session.target.webSocketDebuggerUrl !== target.webSocketDebuggerUrl) return;
      const reportId = session.xworldNonce;
      const result = await session.client.evaluate(`(() => {
        const host = globalThis.__AGYDaddyHost;
        if (!host || !document.body) return null;
        const items = Object.entries(${JSON.stringify(anchorSelectors)}).map(([name, selectors]) => {
          const matchedSelector = selectors.find((selector) => {
            try {
              return Array.from(document.querySelectorAll(selector)).some((el) =>
                !el.closest('#agy-daddy-host,#agy-native-settings-mount,#agy-settings-modal,#agy-popover-browser-occluder'));
            } catch { return false; }
          }) || null;
          return { name, matchedSelector };
        });
        const settingsExpected = host.getSettingsMode?.() === 'native' ||
          Boolean(document.querySelector('[data-testid="settings-dialog"],[data-testid="settings-sidebar"],[data-testid="settings-content"]'));
        return { items, settingsExpected };
      })()`).catch(() => null);
      if (session.closed || session.xworldNonce !== reportId) return;
      session.healthProbe = Array.isArray(result?.items) ? result : null;
    });
    await Promise.all(probes);
  }

  readHostBundleSource() {
    if (!fs.existsSync(this.hostBundlePath)) {
      throw new Error(`Missing host renderer bundle at ${this.hostBundlePath}; run npm run build:renderer first`);
    }
    return fs.readFileSync(this.hostBundlePath, 'utf8');
  }

  async injectHostShell(session, extraBootOptions = {}) {
    session.xworldNonce = crypto.randomBytes(16).toString('hex');
    session.xworldChannelName = `__agy_xworld_${session.xworldNonce}`;
    session.healthProbe = null;
    session.runtimeHealthReport = null;
    session.anchorsRegistry = this.getResolvedAnchors();
    const bundleSource = this.readHostBundleSource();
    const hostSettings = this.getHostSettings();
    const pluginMeta = this.getPluginMetaMap();
    const bootScript = buildHostBootstrapScript(bundleSource, {
      antigravityVersion: this.antigravityVersion,
      anchorsRegistry: session.anchorsRegistry,
      bridgePort: this.getBridgePort(),
      hostToken: this.getHostToken(),
      xworldNonce: session.xworldNonce,
      healthTargetId: session.targetId,
      healthReportId: session.xworldNonce,
      healthAnchors: buildResolvedAnchorsMap(this.healthAnchors, this.antigravityVersion),
      ...(hostSettings ? { hostSettings } : {}),
      pluginMeta,
      ...(extraBootOptions && extraBootOptions.initialView ? { initialView: extraBootOptions.initialView } : {})
    });
    const result = await session.client.evaluate(bootScript);
    if (result?.ok === false) throw new Error('Host renderer bootstrap did not mount');
    return result;
  }

  async notifyPluginSettingsChanged(pluginId, values = {}, changedKeys = [], secretState = null) {
    let notified = 0;
    const expr = `globalThis.__AGYDaddyHost && typeof globalThis.__AGYDaddyHost.notifyPluginSettingsChanged === 'function' ? globalThis.__AGYDaddyHost.notifyPluginSettingsChanged(${JSON.stringify(pluginId)}, ${JSON.stringify(values || {})}, ${JSON.stringify(Array.isArray(changedKeys) ? changedKeys : [])}, ${JSON.stringify(secretState && typeof secretState === 'object' ? secretState : null)}) : false`;
    for (const session of this.sessions.values()) {
      if (session.closed || !session.client?.ws) continue;
      try {
        await session.client.evaluate(expr);
        notified++;
      } catch {}
    }
    return { ok: true, notified };
  }

  async syncPluginMeta(pluginMetaMap = null, targetSession = null) {
    const meta = pluginMetaMap || this.getPluginMetaMap();
    const expr = `globalThis.__AGYDaddyHost && typeof globalThis.__AGYDaddyHost.syncPluginStates === 'function' ? globalThis.__AGYDaddyHost.syncPluginStates(${JSON.stringify(meta)}) : false`;
    const list = targetSession ? [targetSession] : Array.from(this.sessions.values());
    let notified = 0;
    for (const session of list) {
      if (!session || session.closed || !session.client?.ws) continue;
      try {
        await session.client.evaluate(expr);
        notified++;
      } catch {}
    }
    return { ok: true, notified };
  }

  async openSettingsPanel(opts = {}) {
    let openedCount = 0;
    const payload = {
      tab: typeof opts?.tab === 'string' && opts.tab.trim() ? opts.tab.trim() : 'plugins',
      ...(typeof opts?.pluginId === 'string' && opts.pluginId.trim() ? { pluginId: opts.pluginId.trim() } : {})
    };
    const expr = `globalThis.__AGYDaddyHost && typeof globalThis.__AGYDaddyHost.openSettings === 'function' ? globalThis.__AGYDaddyHost.openSettings(${JSON.stringify(payload)}) : false`;
    for (const session of this.sessions.values()) {
      if (session.closed || !session.client?.ws) continue;
      try {
        const res = await session.client.evaluate(expr);
        if (res !== false) openedCount++;
      } catch {}
    }
    return { ok: true, openedCount };
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
      const initialSettings = this.getPluginSettings(activeEntry.id, activeEntry.settingsValues || {});
      const isoScript = buildIsolatedWorldPluginScript(activeEntry.id, rendererSource, {
        xworldChannelName: session.xworldChannelName,
        xworldNonce: session.xworldNonce || '',
        bridgePort: this.getBridgePort(),
        pluginToken: activeEntry.pluginToken || '',
        anchorsRegistry,
        hostVersion: HOST_PKG_VERSION,
        initialSettings
      });
      const evalRes = await session.client.evaluate(isoScript, { contextId });
      if (evalRes?.ok === false) throw new Error(evalRes.error || 'Renderer mount failed');
      session.mountedPlugins.set(activeEntry.id, {
        world: 'isolated',
        contextId,
        version: activeEntry.manifest.version
      });
      session.mountErrors?.delete(activeEntry.id);
      this.onPluginInjectSuccess?.(activeEntry.id, session.targetId);
      return { ok: true, world: 'isolated', contextId, evalRes };
    }

    const mainScript = buildMainWorldPluginScript(activeEntry.id, rendererSource, {
      pluginToken: activeEntry.pluginToken || ''
    });
    const evalRes = await session.client.evaluate(mainScript);
    if (evalRes?.ok === false) throw new Error(evalRes.error || 'Renderer mount failed');
    session.mountedPlugins.set(activeEntry.id, {
      world: 'main',
      contextId: null,
      version: activeEntry.manifest.version
    });
    session.mountErrors?.delete(activeEntry.id);
    this.onPluginInjectSuccess?.(activeEntry.id, session.targetId);
    return { ok: true, world: 'main', evalRes };
  }

  recordMountError(session, pluginId, err) {
    session.mountErrors.set(pluginId, { message: err?.message || String(err), stack: err?.stack || null, at: Date.now() });
    this.onPluginInjectError?.(pluginId, err, session.targetId);
  }

  async disposePluginFromSession(session, pluginId) {
    session.mountErrors?.delete(pluginId);
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
      for (const pid of Array.from(session.mountedPlugins.keys())) {
        await this.disposePluginFromSession(session, pid).catch(() => {});
      }
      session.mountedPlugins.clear();
      session.mountErrors?.clear();
      session.frameId = await session.client.getMainFrameId();
      await this.injectHostShell(session);
      const errors = [];
      let pluginsInjected = 0;
      for (const entry of session.activePlugins) {
        try {
          const res = await this.injectPluginIntoSession(session, entry);
          if (!res.skipped) pluginsInjected++;
        } catch (err) {
          this.recordMountError(session, entry.id, err);
          errors.push({ pluginId: entry.id, error: err?.message || String(err) });
        }
      }
      if (errors.length > 0) {
        await this.syncPluginMeta(null, session).catch(() => {});
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
      void this.reinjectSession(session).catch((err) => {
        if (this.sessions.get(session.targetId) === session) {
          this.emit('reinjectionFailed', { targetId: session.targetId, error: err?.message || String(err) });
          void this.detachSession(session.targetId).catch(() => {});
        }
      });
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
      mountErrors: new Map(),
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
      if (this.sessions.get(targetId) === session) this.sessions.delete(targetId);
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
          this.recordMountError(session, entry.id, err);
          errors.push({ pluginId: entry.id, error: err?.message || String(err) });
        }
      }
      if (errors.length > 0) {
        await this.syncPluginMeta(null, session).catch(() => {});
      }
      session.readyForNavEvents = true;
      if (Array.isArray(activePlugins) && activePlugins.length > 0) {
        this.lastActivePlugins = Array.from(activePlugins);
      }
      const wsMatch = String(target.webSocketDebuggerUrl || '').match(/127\.0\.0\.1:(\d+)/);
      if (wsMatch) {
        const parsedPort = Number(wsMatch[1]);
        if (Number.isInteger(parsedPort) && parsedPort > 0) {
          this.lastCdpPort = parsedPort;
        }
      }

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
    let discovery = options.discovery || null;

    if (!targets) {
      discovery = await resolveActiveCdpTarget({ ...this.cdpOptions, ...(options.cdpOptions || {}) });
      port = discovery.port;
      targets = discovery.targets;
    }

    if (port) {
      this.lastCdpPort = Number(port);
    } else if ((!targets || targets.length === 0) && this.sessions.size === 0) {
      this.lastCdpPort = null;
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
      discovery: discovery || { port, targets },
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
        this.recordMountError(session, pluginId, err);
        errors.push({ targetId: session.targetId, error: err?.message || String(err) });
      }
    }
    return { ok: errors.length === 0, sessionsUpdated, errors };
  }

  async reloadAllSessions(activePlugins = [], options = {}) {
    this.lastActivePlugins = Array.from(activePlugins || []);
    let sessionsUpdated = 0;
    let pluginsInjected = 0;
    const errors = [];

    for (const session of this.sessions.values()) {
      if (session.closed || !session.client?.ws) continue;
      try {
        for (const pid of Array.from(session.mountedPlugins.keys())) {
          await this.disposePluginFromSession(session, pid);
        }
        session.mountedPlugins.clear();
        session.mountErrors?.clear();
        session.activePlugins = Array.from(this.lastActivePlugins);
        try {
          session.frameId = await session.client.getMainFrameId();
        } catch {}

        await this.injectHostShell(
          session,
          options?.restoreView ? { initialView: options.restoreView } : {}
        );

        let sessionPluginsInjected = 0;
        const sessionErrors = [];
        for (const entry of session.activePlugins) {
          try {
            const res = await this.injectPluginIntoSession(session, entry);
            if (!res.skipped) {
              sessionPluginsInjected++;
              pluginsInjected++;
            }
          } catch (err) {
            const msg = err?.message || String(err);
            this.recordMountError(session, entry.id, err);
            sessionErrors.push({ pluginId: entry.id, error: msg });
            errors.push({ targetId: session.targetId, pluginId: entry.id, error: msg });
          }
        }
        if (sessionErrors.length > 0) {
          await this.syncPluginMeta(null, session).catch(() => {});
        }
        sessionsUpdated++;
        this.emit('reinjected', {
          targetId: session.targetId,
          xworldNonce: session.xworldNonce,
          pluginsInjected: sessionPluginsInjected,
          errors: sessionErrors
        });
      } catch (err) {
        errors.push({ targetId: session.targetId, error: err?.message || String(err) });
      }
    }

    return { ok: errors.length === 0, sessionsUpdated, pluginsInjected, errors };
  }

  getActiveCdpSnapshot() {
    let port = this.lastCdpPort ? Number(this.lastCdpPort) : null;
    if (!port) {
      for (const session of this.sessions.values()) {
        const wsUrl = String(session?.target?.webSocketDebuggerUrl || session?.wsUrl || '');
        const match = wsUrl.match(/127\.0\.0\.1:(\d+)/);
        if (match) {
          port = Number(match[1]);
          break;
        }
      }
    }
    return {
      port: port && Number.isFinite(port) ? port : null,
      targetsCount: this.sessions.size
    };
  }

  async disposeAll() {
    const ids = Array.from(this.sessions.keys());
    for (const id of ids) {
      await this.detachSession(id);
    }
    this.lastCdpPort = null;
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
