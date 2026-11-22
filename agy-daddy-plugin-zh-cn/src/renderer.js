'use strict';

const { BRAND_TITLE_MODES, parseCustomRules, translateText } = require('./dictionary');

let disposers = [];

function isProtectedDomNode(el) {
  let cur = el;
  while (cur) {
    if (cur.id === 'agy-daddy-host') return true;
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
      if (isProtectedDomNode(node)) continue;
      if (node.nodeType === 3) {
        textNodes.push(node);
        continue;
      }
      allEls.push(node);
      const kids = Array.from(node.childNodes || node.children || []);
      if (kids.length === 0 && typeof node.textContent === 'string' && node.textContent.trim()) {
        leafEls.push(node);
      } else {
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
      }
    }
    return { textNodes, leafEls, allEls };
  }

  function applyBrandMode(el, origVal, brandMode) {
    if (brandMode === BRAND_TITLE_MODES.HIDDEN) {
      if (!hiddenBrandEls.has(el)) {
        hiddenBrandEls.set(el, el.style?.display ?? '');
      }
      if (el.style && typeof el.style.setProperty === 'function') {
        el.style.setProperty('display', 'none');
      } else if (el.style) {
        el.style.display = 'none';
      }
      rewrittenEls.add(el);
      return true;
    }
    if (hiddenBrandEls.has(el)) {
      const prevDisplay = hiddenBrandEls.get(el);
      if (el.style) el.style.display = prevDisplay || '';
      hiddenBrandEls.delete(el);
    }
    return false;
  }

  function applyTranslations(opts = {}) {
    if (!doc) return 0;
    const root = doc.body || doc.documentElement;
    if (!root) return 0;
    const customRules = parseCustomRules(opts.customRules || []);
    const customTitles = (opts.titles && typeof opts.titles === 'object') ? opts.titles : {};
    const brandMode = opts.brandTitle || BRAND_TITLE_MODES.ENGLISH;
    const { textNodes, leafEls, allEls } = collectLeafAndTextTargets(root);
    let count = 0;

    for (const tn of textNodes) {
      const cur = tn.nodeValue || '';
      const rec = origTextNodes.get(tn);
      const sourceText = rec && rec.zh === cur ? rec.orig : cur;
      const zh = translateText(sourceText, {
        englishLabels: opts.englishLabels,
        brandTitle: brandMode,
        customRules
      });
      if (zh !== sourceText) {
        origTextNodes.set(tn, { orig: sourceText, zh });
        tn.nodeValue = zh;
        count++;
      }
    }

    for (const el of leafEls) {
      const cur = el.textContent || '';
      const rec = origLeafEls.get(el);
      const sourceText = rec && rec.zh === cur ? rec.orig : cur;

      // 用户手动重命名过的会话标题强制保留
      const cid = getCascadeIdFromRow(el);
      if (cid && customTitles[cid]) {
        if (cur !== customTitles[cid]) {
          origLeafEls.set(el, { orig: sourceText, zh: customTitles[cid] });
          rewrittenEls.add(el);
          el.textContent = customTitles[cid];
          count++;
        }
        continue;
      }

      if (/^antigravity$/i.test(sourceText.trim()) && applyBrandMode(el, sourceText, brandMode)) {
        count++;
        continue;
      }

      const zh = translateText(sourceText, {
        englishLabels: opts.englishLabels,
        brandTitle: brandMode,
        customRules
      });
      if (zh !== sourceText) {
        origLeafEls.set(el, { orig: sourceText, zh });
        rewrittenEls.add(el);
        el.textContent = zh;
        count++;
      } else if (rec && cur !== rec.orig && brandMode === BRAND_TITLE_MODES.ENGLISH) {
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
        const origVal = rec && rec.zh === curAttr ? rec.orig : curAttr;
        const zhAttr = translateText(origVal, {
          englishLabels: opts.englishLabels,
          brandTitle: brandMode,
          customRules
        });
        if (zhAttr !== origVal) {
          if (!attrMap) { attrMap = new Map(); origAttrs.set(el, attrMap); }
          attrMap.set(attr, { orig: origVal, zh: zhAttr });
          rewrittenEls.add(el);
          el.setAttribute(attr, zhAttr);
          count++;
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
          if (rec && tn.nodeValue === rec.zh) tn.nodeValue = rec.orig;
          origTextNodes.delete(tn);
        }
      }
    }
    for (const el of Array.from(rewrittenEls)) {
      const rec = origLeafEls.get(el);
      if (rec && el.textContent === rec.zh) el.textContent = rec.orig;
      origLeafEls.delete(el);
      if (hiddenBrandEls.has(el)) {
        const prevDisplay = hiddenBrandEls.get(el);
        if (el.style) el.style.display = prevDisplay || '';
        hiddenBrandEls.delete(el);
      }
      const attrMap = origAttrs.get(el);
      if (attrMap) {
        for (const [attr, aRec] of attrMap.entries()) {
          if (el.getAttribute(attr) === aRec.zh) el.setAttribute(attr, aRec.orig);
        }
        origAttrs.delete(el);
      }
    }
    rewrittenEls.clear();
  }

  return { applyTranslations, restoreAll };
}

async function mount(ctx) {
  let cfg = {
    lang: 'zh',
    brandTitle: BRAND_TITLE_MODES.ENGLISH,
    englishLabels: false,
    enableRemoteThinkingTranslation: false,
    customRules: [],
    titles: {}
  };
  try {
    const res = await ctx.bridge.post('/config', {});
    if (res && typeof res === 'object') cfg = { ...cfg, ...res };
  } catch {}

  const docRef = ctx.anchors.query('sidebar.conversationRows')?.ownerDocument
    || ctx.anchors.query('topbar.rightCluster')?.ownerDocument
    || globalThis.document;
  const translator = createDomTranslator({ doc: docRef });
  let unitNode = null;
  let thinkingEventsHandled = 0;

  function syncDom() {
    if (cfg.lang === 'zh') {
      translator.applyTranslations(cfg);
    } else {
      translator.restoreAll();
    }
    if (unitNode) {
      unitNode.textContent = cfg.lang === 'zh' ? '中' : 'EN';
    }
  }

  const stopUnit = ctx.topbar.registerUnit({
    id: 'lang-toggle',
    order: 75,
    label: cfg.lang === 'zh' ? '中' : 'EN',
    render(node) {
      unitNode = node;
    },
    onClick() {
      const next = cfg.lang === 'zh' ? 'en' : 'zh';
      cfg.lang = next;
      syncDom();
      void ctx.bridge.post('/set-lang', { lang: next }).catch(() => {});
    }
  });

  // 订阅 chat-nav 广播的思考展开事件，消除模块间循环依赖
  const stopThinkingSub = ctx.events.on('chat:thinking-expanded@1', () => {
    thinkingEventsHandled++;
    if (cfg.lang === 'zh') translator.applyTranslations(cfg);
  });

  const stopAnchor = ctx.anchors.observe('sidebar.conversationRows', () => {
    if (cfg.lang === 'zh') translator.applyTranslations(cfg);
  });

  const stopSection = ctx.settings.registerSection({
    id: 'zh-cn-settings',
    title: { 'zh-CN': '客户端中文汉化', en: 'Chinese Localization' },
    values: {
      lang: cfg.lang,
      brandTitle: cfg.brandTitle,
      englishLabels: cfg.englishLabels,
      enableRemoteThinkingTranslation: cfg.enableRemoteThinkingTranslation
    },
    onChange(key, value) {
      cfg = { ...cfg, [key]: value };
      syncDom();
      void ctx.bridge.post('/set-config', { [key]: value }).catch(() => {});
    }
  });

  syncDom();

  disposers.push(
    stopUnit,
    stopThinkingSub,
    stopAnchor,
    stopSection,
    () => translator.restoreAll()
  );

  return {
    getThinkingEventsHandled: () => thinkingEventsHandled
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
