'use strict';

const {
  DEFAULT_LANG,
  BRAND_TITLE_MODES,
  normalizeLang,
  getLanguageMeta,
  normalizeBrandTitleMode,
  parseCustomRules,
  translateText
} = require('./dictionary');
const {
  THINKING_TRANSLATION_MODES,
  THINKING_TARGET_LANG_FOLLOW,
  DEFAULT_THINKING_API_MODEL,
  normalizeThinkingTranslationMode,
  normalizeThinkingDisplayMode,
  normalizeThinkingTargetLang
} = require('./cot-utils');
const {
  createCotOverlayController
} = require('./cot-overlay');

let disposers = [];

function isProtectedContainer(el) {
  let cur = el;
  while (cur) {
    if (cur.id === 'agy-daddy-host' || cur.id === 'agy-native-settings-mount') return true;
    const tag = String(cur.tagName || cur.nodeName || '').toUpperCase();
    if (tag === 'CODE' || tag === 'PRE' || tag === 'SCRIPT' || tag === 'STYLE') {
      return true;
    }
    if (typeof cur.getAttribute === 'function' && (cur.getAttribute('data-uri') || cur.getAttribute('data-agy-no-translate') === '1')) {
      return true;
    }
    cur = cur.parentElement || cur.parentNode || null;
  }
  return false;
}

function isProtectedDomNode(el) {
  let cur = el;
  while (cur) {
    if (cur.id === 'agy-daddy-host' || cur.id === 'agy-native-settings-mount') return true;
    const tag = String(cur.tagName || cur.nodeName || '').toUpperCase();
    if (tag === 'CODE' || tag === 'PRE' || tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SCRIPT' || tag === 'STYLE') {
      return true;
    }
    if (typeof cur.getAttribute === 'function' && (cur.getAttribute('data-uri') || cur.getAttribute('data-agy-no-translate') === '1')) {
      return true;
    }
    cur = cur.parentElement || cur.parentNode || null;
  }
  return false;
}

function getCascadeIdFromRow(el) {
  let cur = el;
  while (cur) {
    if (typeof cur.getAttribute === 'function') {
      const cid = cur.getAttribute('data-cascade-id') || cur.getAttribute('data-conversation-id');
      if (cid) return cid;
    }
    cur = cur.parentElement || cur.parentNode || null;
  }
  return '';
}

function isThinkingNode(el, sourceText = '') {
  if (/^(?:Thought\s+for\b|Thinking\b)/i.test(String(sourceText || '').trim())) {
    return true;
  }
  let cur = el;
  while (cur) {
    if (typeof cur.getAttribute === 'function') {
      const testId = String(cur.getAttribute('data-testid') || '').toLowerCase();
      if (testId.includes('thinking') || testId.includes('thought')) return true;
    }
    const cls = String(cur.className || '').toLowerCase();
    if (cls.includes('thinking') || cls.includes('thought')) return true;
    cur = cur.parentElement || cur.parentNode || null;
  }
  return false;
}

function isConversationTitleNode(el) {
  let cur = el;
  while (cur) {
    if (typeof cur.getAttribute === 'function') {
      if (cur.getAttribute('data-cascade-id') || cur.getAttribute('data-conversation-id')) return true;
      const testId = cur.getAttribute('data-testid');
      if (
        testId === 'conversation-list-row' ||
        testId === 'conversation-row-sidebar' ||
        testId === 'conversation-title'
      ) {
        return true;
      }
    }
    cur = cur.parentElement || cur.parentNode || null;
  }
  return false;
}

function setElementDisplay(el, displayVal) {
  if (!el || !el.style) return;
  if (displayVal) {
    if (typeof el.style.setProperty === 'function') el.style.setProperty('display', displayVal);
    try { el.style.display = displayVal; } catch {}
  } else {
    if (typeof el.style.removeProperty === 'function') el.style.removeProperty('display');
    try { el.style.display = ''; } catch {}
  }
}

function getElementDisplay(el) {
  if (!el || !el.style) return '';
  if (typeof el.style.getPropertyValue === 'function') {
    const pv = el.style.getPropertyValue('display');
    if (pv) return pv;
  }
  return typeof el.style.display === 'string' ? el.style.display : '';
}

function createDomTranslator(options = {}) {
  const doc = options.doc || globalThis.document;
  const origTextNodes = new WeakMap();
  const origLeafEls = new WeakMap();
  const origAttrs = new WeakMap();
  const hiddenBrandEls = new WeakMap();
  const rewrittenEls = new Set();

  function collectLeafAndTextTargets(root) {
    const textNodes = [];
    const leafEls = [];
    const allEls = [];
    const stack = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (isProtectedContainer(node)) continue;
      if (node.nodeType === 3) {
        textNodes.push(node);
        continue;
      }
      const tag = String(node.tagName || node.nodeName || '').toUpperCase();
      allEls.push(node);
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        continue;
      }
      const kids = Array.from(node.childNodes || node.children || []);
      if (kids.length === 0 && typeof node.textContent === 'string' && node.textContent.trim()) {
        leafEls.push(node);
      } else {
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
    }
    return { textNodes, leafEls, allEls };
  }

  function applyBrandMode(el, brandMode) {
    if (brandMode === BRAND_TITLE_MODES.HIDDEN) {
      if (!hiddenBrandEls.has(el)) {
        hiddenBrandEls.set(el, getElementDisplay(el));
      }
      setElementDisplay(el, 'none');
      rewrittenEls.add(el);
      return true;
    }
    if (hiddenBrandEls.has(el)) {
      const prevDisplay = hiddenBrandEls.get(el);
      setElementDisplay(el, prevDisplay || '');
      hiddenBrandEls.delete(el);
    }
    return false;
  }

  function applyTranslations(opts = {}, rootOverride = null) {
    const root = rootOverride || (doc ? (doc.body || doc.documentElement) : null);
    if (!root || isProtectedContainer(root)) return 0;
    const lang = normalizeLang(opts.lang, DEFAULT_LANG);
    const allowThinking = opts.translateThinking !== false;
    const allowTitles = opts.translateConversationTitles !== false;
    const customRules = parseCustomRules(opts.customRules || []);
    const customTitles = (opts.titles && typeof opts.titles === 'object') ? opts.titles : {};
    const brandMode = normalizeBrandTitleMode(opts.brandTitle || BRAND_TITLE_MODES.ENGLISH);
    const { textNodes, leafEls, allEls } = collectLeafAndTextTargets(root);
    let count = 0;

    for (const tn of textNodes) {
      const cur = tn.nodeValue || '';
      const rec = origTextNodes.get(tn);
      const sourceText = rec && rec.translated === cur ? rec.orig : cur;
      const ownerEl = tn.parentElement || tn.parentNode || null;
      if ((!allowThinking && isThinkingNode(ownerEl, sourceText)) || (!allowTitles && isConversationTitleNode(ownerEl))) {
        if (rec && cur !== rec.orig) {
          tn.nodeValue = rec.orig;
          origTextNodes.delete(tn);
        }
        continue;
      }
      const nextText = translateText(sourceText, {
        lang,
        englishLabels: opts.englishLabels,
        brandTitle: brandMode,
        customRules
      });
      if (nextText !== sourceText) {
        origTextNodes.set(tn, { orig: sourceText, translated: nextText });
        if (tn.nodeValue !== nextText) tn.nodeValue = nextText;
        count++;
      } else if (rec && cur !== rec.orig) {
        tn.nodeValue = rec.orig;
        origTextNodes.delete(tn);
      }
    }

    for (const el of leafEls) {
      const cur = el.textContent || '';
      const rec = origLeafEls.get(el);
      const sourceText = rec && rec.translated === cur ? rec.orig : cur;

      // 用户手动重命名过的会话标题强制保留
      const cid = getCascadeIdFromRow(el);
      if (cid && customTitles[cid]) {
        if (cur !== customTitles[cid]) {
          origLeafEls.set(el, { orig: sourceText, translated: customTitles[cid] });
          rewrittenEls.add(el);
          el.textContent = customTitles[cid];
          count++;
        }
        continue;
      }

      if ((!allowThinking && isThinkingNode(el, sourceText)) || (!allowTitles && isConversationTitleNode(el))) {
        if (rec && cur !== rec.orig) {
          el.textContent = rec.orig;
          origLeafEls.delete(el);
        }
        continue;
      }

      if (/^antigravity$/i.test(sourceText.trim())) {
        if (applyBrandMode(el, brandMode)) {
          count++;
          continue;
        }
      }

      const nextText = translateText(sourceText, {
        lang,
        englishLabels: opts.englishLabels,
        brandTitle: brandMode,
        customRules
      });
      if (nextText !== sourceText) {
        origLeafEls.set(el, { orig: sourceText, translated: nextText });
        rewrittenEls.add(el);
        if (el.textContent !== nextText) el.textContent = nextText;
        count++;
      } else if (rec && cur !== rec.orig) {
        el.textContent = rec.orig;
        origLeafEls.delete(el);
      }
    }

    for (const el of allEls) {
      if (typeof el.getAttribute !== 'function' || typeof el.setAttribute !== 'function') continue;
      for (const attr of ['aria-label', 'title', 'placeholder']) {
        const curAttr = el.getAttribute(attr);
        if (!curAttr) continue;
        let attrMap = origAttrs.get(el);
        const rec = attrMap?.get(attr);
        const origVal = rec && rec.translated === curAttr ? rec.orig : curAttr;
        if ((!allowThinking && isThinkingNode(el, origVal)) || (!allowTitles && isConversationTitleNode(el))) {
          if (rec && curAttr !== rec.orig) {
            el.setAttribute(attr, rec.orig);
            attrMap.delete(attr);
          }
          continue;
        }
        const nextAttr = translateText(origVal, {
          lang,
          englishLabels: opts.englishLabels,
          brandTitle: brandMode,
          customRules
        });
        if (nextAttr !== origVal) {
          if (!attrMap) { attrMap = new Map(); origAttrs.set(el, attrMap); }
          attrMap.set(attr, { orig: origVal, translated: nextAttr });
          rewrittenEls.add(el);
          if (el.getAttribute(attr) !== nextAttr) el.setAttribute(attr, nextAttr);
          count++;
        } else if (rec && curAttr !== rec.orig) {
          el.setAttribute(attr, rec.orig);
          attrMap.delete(attr);
        }
      }
    }
    return count;
  }

  function restoreAll() {
    if (doc) {
      const root = doc.body || doc.documentElement;
      if (root) {
        const { textNodes } = collectLeafAndTextTargets(root);
        for (const tn of textNodes) {
          const rec = origTextNodes.get(tn);
          if (rec && tn.nodeValue === rec.translated) tn.nodeValue = rec.orig;
          origTextNodes.delete(tn);
        }
      }
    }
    for (const el of Array.from(rewrittenEls)) {
      const rec = origLeafEls.get(el);
      if (rec && el.textContent === rec.translated) el.textContent = rec.orig;
      origLeafEls.delete(el);
      if (hiddenBrandEls.has(el)) {
        const prevDisplay = hiddenBrandEls.get(el);
        setElementDisplay(el, prevDisplay || '');
        hiddenBrandEls.delete(el);
      }
      const attrMap = origAttrs.get(el);
      if (attrMap) {
        for (const [attr, aRec] of attrMap.entries()) {
          if (el.getAttribute(attr) === aRec.translated) el.setAttribute(attr, aRec.orig);
        }
        origAttrs.delete(el);
      }
    }
    rewrittenEls.clear();
  }

  return { applyTranslations, restoreAll };
}

function mergeManagedSettings(raw = {}, base = {}) {
  return {
    ...base,
    lang: normalizeLang(raw.lang, base.lang || DEFAULT_LANG),
    brandTitle: normalizeBrandTitleMode(raw.brandTitle || base.brandTitle || BRAND_TITLE_MODES.ENGLISH),
    englishLabels: raw.englishLabels !== undefined ? Boolean(raw.englishLabels) : Boolean(base.englishLabels),
    translateThinking: raw.translateThinking !== undefined
      ? Boolean(raw.translateThinking)
      : (base.translateThinking !== undefined ? Boolean(base.translateThinking) : true),
    translateConversationTitles: raw.translateConversationTitles !== undefined
      ? Boolean(raw.translateConversationTitles)
      : (base.translateConversationTitles !== undefined ? Boolean(base.translateConversationTitles) : true),
    enableRemoteThinkingTranslation: raw.enableRemoteThinkingTranslation !== undefined
      ? Boolean(raw.enableRemoteThinkingTranslation)
      : Boolean(base.enableRemoteThinkingTranslation),
    thinkingTranslationMode: raw.thinkingTranslationMode !== undefined
      ? normalizeThinkingTranslationMode(raw.thinkingTranslationMode, false)
      : normalizeThinkingTranslationMode(base.thinkingTranslationMode, false),
    thinkingTargetLang: raw.thinkingTargetLang !== undefined
      ? normalizeThinkingTargetLang(raw.thinkingTargetLang, normalizeLang)
      : normalizeThinkingTargetLang(base.thinkingTargetLang || THINKING_TARGET_LANG_FOLLOW, normalizeLang),
    thinkingDisplayMode: raw.thinkingDisplayMode !== undefined
      ? normalizeThinkingDisplayMode(raw.thinkingDisplayMode)
      : normalizeThinkingDisplayMode(base.thinkingDisplayMode),
    thinkingAntigravityModel: raw.thinkingAntigravityModel !== undefined
      ? String(raw.thinkingAntigravityModel || '').trim()
      : String(base.thinkingAntigravityModel || '').trim(),
    thinkingApiModel: typeof raw.thinkingApiModel === 'string' && raw.thinkingApiModel.trim()
      ? raw.thinkingApiModel.trim()
      : (base.thinkingApiModel || DEFAULT_THINKING_API_MODEL)
  };
}

async function mount(ctx, options = {}) {
  dispose();

  let cfg = mergeManagedSettings(ctx.settings.get(), {
    lang: DEFAULT_LANG,
    brandTitle: BRAND_TITLE_MODES.ENGLISH,
    englishLabels: false,
    translateThinking: true,
    translateConversationTitles: true,
    enableRemoteThinkingTranslation: false,
    thinkingTranslationMode: THINKING_TRANSLATION_MODES.OFF,
    thinkingTargetLang: THINKING_TARGET_LANG_FOLLOW,
    thinkingDisplayMode: 'bilingual',
    thinkingAntigravityModel: '',
    thinkingApiModel: DEFAULT_THINKING_API_MODEL,
    customRules: [],
    titles: {}
  });

  const docRef = ctx.anchors.query('sidebar.conversationRows')?.ownerDocument
    || ctx.anchors.query('topbar.rightCluster')?.ownerDocument
    || globalThis.document;
  const translator = createDomTranslator({ doc: docRef });
  const cotOverlay = createCotOverlayController({
    ctx,
    doc: docRef,
    getConfig: () => cfg,
    onOpenFile: options.onOpenFile,
    trailingDebounceMs: options.cotDebounceMs
  });
  let thinkingEventsHandled = 0;
  let disposed = false;
  let isApplying = false;
  let flushTimer = null;
  const pendingNodes = new Set();
  let domObserver = null;

  function runWithMutationGuard(fn) {
    isApplying = true;
    try {
      return fn();
    } finally {
      try { domObserver?.takeRecords?.(); } catch {}
      isApplying = false;
    }
  }

  function hasAncestorInSet(node, set) {
    let cur = node?.parentElement || node?.parentNode || null;
    while (cur) {
      if (set.has(cur)) return true;
      cur = cur.parentElement || cur.parentNode || null;
    }
    return false;
  }

  function enqueueMutationNode(node) {
    if (!node || (node.nodeType !== undefined && node.nodeType !== 1 && node.nodeType !== 3)) return;
    if (isProtectedContainer(node)) return;
    pendingNodes.add(node);
  }

  function flushPendingMutations() {
    flushTimer = null;
    const cotEnabled = cfg.thinkingTranslationMode !== THINKING_TRANSLATION_MODES.OFF;
    if (disposed || (cfg.lang === 'en' && !cotEnabled) || pendingNodes.size === 0) {
      pendingNodes.clear();
      return;
    }
    const nodes = Array.from(pendingNodes);
    pendingNodes.clear();
    let touchedThinking = false;
    if (cfg.lang !== 'en') {
      runWithMutationGuard(() => {
        if (nodes.length > 60) {
          translator.applyTranslations(cfg);
          touchedThinking = true;
          return;
        }
        const nodeSet = new Set(nodes);
        for (const node of nodes) {
          if (!node || hasAncestorInSet(node, nodeSet)) continue;
          if (node.isConnected === false) continue;
          if (!touchedThinking && isThinkingNode(node.parentElement || node)) {
            touchedThinking = true;
          }
          translator.applyTranslations(cfg, node);
        }
      });
    } else {
      for (const node of nodes) {
        if (node && isThinkingNode(node.parentElement || node)) {
          touchedThinking = true;
          break;
        }
      }
    }
    if (touchedThinking && cotEnabled) {
      cotOverlay.scheduleScan(30);
    }
  }

  function syncDom() {
    runWithMutationGuard(() => {
      if (cfg.lang === 'en') {
        translator.restoreAll();
      } else {
        translator.applyTranslations(cfg);
      }
    });
    if (cfg.thinkingTranslationMode === THINKING_TRANSLATION_MODES.OFF) {
      cotOverlay.clearAll();
    } else {
      cotOverlay.scanNow();
    }
    const meta = getLanguageMeta(cfg.lang);
    try {
      const langPayload = { lang: cfg.lang, bcp47: meta.bcp47, shortLabel: meta.shortLabel };
      void Promise.resolve(ctx.state.set('state:zh-cn.lang@1', langPayload)).catch(() => {});
      void Promise.resolve(ctx.state.set('state:host.locale@1', { ...langPayload, locale: meta.bcp47 })).catch(() => {});
    } catch {}
  }

  const stopSettingsSub = ctx.settings.onChange((nextValues) => {
    cfg = mergeManagedSettings(nextValues, cfg);
    syncDom();
  });

  // 订阅 chat-nav 广播的思考展开事件，消除模块间循环依赖
  const stopThinkingSub = ctx.events.on('chat:thinking-expanded@1', () => {
    thinkingEventsHandled++;
    if (cfg.lang !== 'en' && cfg.translateThinking !== false) {
      runWithMutationGuard(() => translator.applyTranslations(cfg));
    }
    if (cfg.thinkingTranslationMode !== THINKING_TRANSLATION_MODES.OFF) {
      cotOverlay.scheduleScan(20);
    }
  });

  const stopThinkingAnchor = ctx.anchors.observe('chat.thinkingTrigger', () => {
    if (cfg.thinkingTranslationMode !== THINKING_TRANSLATION_MODES.OFF) {
      cotOverlay.scheduleScan(30);
    }
  });

  const stopAnchor = ctx.anchors.observe('sidebar.conversationRows', () => {
    if (cfg.lang !== 'en') {
      runWithMutationGuard(() => translator.applyTranslations(cfg));
    }
  });

  const MutationObserverCtor = typeof MutationObserver === 'function'
    ? MutationObserver
    : (docRef?.defaultView && typeof docRef.defaultView.MutationObserver === 'function'
      ? docRef.defaultView.MutationObserver
      : null);
  const observeRoot = docRef?.documentElement || docRef?.body || null;
  if (MutationObserverCtor && observeRoot) {
    domObserver = new MutationObserverCtor((records) => {
      const cotEnabled = cfg.thinkingTranslationMode !== THINKING_TRANSLATION_MODES.OFF;
      if (disposed || isApplying || (cfg.lang === 'en' && !cotEnabled) || !Array.isArray(records)) return;
      let queued = false;
      for (const rec of records) {
        if (!rec) continue;
        if (rec.type === 'childList' && rec.addedNodes) {
          for (const node of Array.from(rec.addedNodes)) {
            enqueueMutationNode(node);
            queued = true;
          }
        } else if ((rec.type === 'characterData' || rec.type === 'attributes') && rec.target) {
          enqueueMutationNode(rec.target);
          queued = true;
        }
      }
      if (queued && pendingNodes.size > 0 && flushTimer === null) {
        flushTimer = setTimeout(flushPendingMutations, 16);
      }
    });
    try {
      domObserver.observe(observeRoot, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['aria-label', 'title', 'placeholder', 'aria-expanded', 'data-state', 'hidden']
      });
    } catch {
      domObserver = null;
    }
  }

  syncDom();

  disposers.push(
    () => {
      disposed = true;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      pendingNodes.clear();
      if (domObserver) {
        try { domObserver.disconnect(); } catch {}
        domObserver = null;
      }
    },
    () => cotOverlay.dispose(),
    stopSettingsSub,
    stopThinkingSub,
    stopThinkingAnchor,
    stopAnchor,
    () => translator.restoreAll()
  );

  return {
    getThinkingEventsHandled: () => thinkingEventsHandled,
    getActiveCotPanelCount: () => cotOverlay.getActivePanelCount(),
    scanCotNow: () => cotOverlay.scanNow()
  };
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  isProtectedDomNode,
  createDomTranslator,
  mount,
  dispose
};
