'use strict';

const {
  DEFAULT_LANG,
  BRAND_TITLE_MODES,
  normalizeLang,
  getLanguageMeta,
  normalizeBrandTitleMode,
  isProtectedPathOrCode,
  parseCustomRules,
  translateText
} = require('./dictionary');

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

function isBrandTitleText(text) {
  return /^antigravity$/i.test(String(text || '').trim());
}

function isSingleBrandTextNode(tn, ownerEl) {
  if (!ownerEl) return false;
  if (typeof ownerEl.getAttribute === 'function' && ownerEl.getAttribute('data-testid') === 'brand-title') {
    return true;
  }
  const elChildren = Array.from(ownerEl.children || []);
  if (elChildren.length > 0) return false;
  const childNodes = Array.from(ownerEl.childNodes || []);
  for (const child of childNodes) {
    if (child && child.nodeType === 3 && child !== tn && String(child.nodeValue || '').trim()) {
      return false;
    }
  }
  return true;
}

function isModelOrPermissionContext(el) {
  let cur = el;
  let depth = 0;
  while (cur && depth < 8) {
    if (typeof cur.getAttribute === 'function') {
      const testId = String(cur.getAttribute('data-testid') || '').toLowerCase();
      const id = String(cur.id || '').toLowerCase();
      const ariaLabel = String(cur.getAttribute('aria-label') || '').toLowerCase();
      const combined = `${testId} ${id} ${ariaLabel} ${String(cur.className || '').toLowerCase()}`;
      if (
        /(?:model[-_ ]?(?:selector|option|picker|list|dropdown)|permission|execution[-_ ]?policy|review[-_ ]?policy|preset[-_ ]?selector|mode[-_ ]?option|mode[-_ ]?selector)/.test(combined)
      ) {
        return true;
      }
      const role = String(cur.getAttribute('role') || '').toLowerCase();
      if ((role === 'option' || role === 'listbox' || role === 'menu' || role === 'menuitem' || role === 'menuitemradio') &&
          /(?:model|permission|policy|preset|mode)/.test(combined)) {
        return true;
      }
      if (testId === 'settings-dialog') break;
    }
    cur = cur.parentElement || cur.parentNode || null;
    depth++;
  }
  return false;
}

function isSlashCommandContext(el) {
  let cur = el;
  let depth = 0;
  while (cur && depth < 4) {
    if (typeof cur.getAttribute === 'function') {
      const testId = String(cur.getAttribute('data-testid') || '').toLowerCase();
      const ariaLabel = String(cur.getAttribute('aria-label') || '').toLowerCase();
      const cls = String(cur.className || '').toLowerCase();
      if (/slash|command[-_ ]?(?:menu|list|item|palette|popover)/.test(`${testId} ${ariaLabel} ${cls}`)) {
        return true;
      }
    }
    if (depth >= 1 && depth <= 2 && typeof cur.textContent === 'string') {
      const txt = cur.textContent;
      if (txt.length <= 240 && (
        txt.includes('Plan carefully before executing a task.') ||
        txt.includes('在执行任务前仔细制定规划')
      )) {
        return true;
      }
    }
    cur = cur.parentElement || cur.parentNode || null;
    depth++;
  }
  return false;
}

function isTranslatableConversationTitleText(text) {
  const t = String(text || '').trim();
  if (t.length < 2 || t.length > 200) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  if (isBrandTitleText(t) || isProtectedPathOrCode(t)) return false;
  if (/^\d+(?:\.\d+)?\s*(?:s|m|h|d|w|ms|sec|min|hr|hrs|days?|hours?|minutes?|seconds?|files?)(?:\s+ago)?$/i.test(t)) {
    return false;
  }
  if (/^(?:just\s+now|today|yesterday|\d{1,2}:\d{2}(?:\s*[ap]m)?)$/i.test(t)) {
    return false;
  }
  return true;
}

function isPrimaryConversationTitleTarget(tn, ownerEl) {
  if (!ownerEl) return false;
  if (typeof ownerEl.getAttribute === 'function' && ownerEl.getAttribute('data-testid') === 'conversation-title') {
    return true;
  }
  const elChildren = Array.from(ownerEl.children || []);
  if (elChildren.length > 0) return false;
  const childNodes = Array.from(ownerEl.childNodes || []);
  for (const child of childNodes) {
    if (child && child.nodeType === 3 && child !== tn && String(child.nodeValue || '').trim()) {
      return false;
    }
  }
  return true;
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
  const remoteTitleCache = new Map(); // `${lang}::${cid}::${orig}` -> { translated, blocked }
  const pendingTitleKeys = new Set();

  function clearRemoteTitleCache(onlyBlocked = false) {
    if (!onlyBlocked) {
      remoteTitleCache.clear();
      return;
    }
    for (const [k, v] of Array.from(remoteTitleCache.entries())) {
      if (v && v.blocked) remoteTitleCache.delete(k);
    }
  }

  function applyResolvedTitleEntries(opts = {}, entries = []) {
    const lang = normalizeLang(opts.lang, DEFAULT_LANG);
    const allowTitles = opts.translateConversationTitles !== false;
    let count = 0;
    for (const entry of entries) {
      if (!entry || !entry.node) continue;
      if (entry.node.isConnected === false) continue;
      const key = `${lang}::${entry.cascadeId || ''}::${entry.sourceText}`;
      const cached = remoteTitleCache.get(key);
      if (!allowTitles || lang === 'en' || !cached || cached.blocked || !cached.translated || cached.translated === entry.sourceText) {
        continue;
      }
      if (entry.isTextNode) {
        const cur = entry.node.nodeValue || '';
        const rec = origTextNodes.get(entry.node);
        const curOrig = rec && rec.translated === cur ? rec.orig : cur;
        if (curOrig !== entry.sourceText) continue;
        origTextNodes.set(entry.node, { orig: entry.sourceText, translated: cached.translated });
        if (entry.node.nodeValue !== cached.translated) entry.node.nodeValue = cached.translated;
        count++;
      } else {
        const cur = entry.node.textContent || '';
        const rec = origLeafEls.get(entry.node);
        const curOrig = rec && rec.translated === cur ? rec.orig : cur;
        if (curOrig !== entry.sourceText) continue;
        origLeafEls.set(entry.node, { orig: entry.sourceText, translated: cached.translated });
        rewrittenEls.add(entry.node);
        if (entry.node.textContent !== cached.translated) entry.node.textContent = cached.translated;
        count++;
      }
    }
    return count;
  }

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
    const isEnBrandHideOnly = lang === 'en' && brandMode === BRAND_TITLE_MODES.HIDDEN;
    const { textNodes, leafEls, allEls } = collectLeafAndTextTargets(root);
    const untranslatedTitleTargets = [];
    let count = 0;

    for (const tn of textNodes) {
      const cur = tn.nodeValue || '';
      const rec = origTextNodes.get(tn);
      const sourceText = rec && rec.translated === cur ? rec.orig : cur;
      const ownerEl = tn.parentElement || tn.parentNode || null;

      if (isBrandTitleText(sourceText)) {
        const singleBrand = isSingleBrandTextNode(tn, ownerEl);
        if (singleBrand && ownerEl && applyBrandMode(ownerEl, brandMode)) {
          count++;
          continue;
        }
        if (ownerEl) applyBrandMode(ownerEl, brandMode);
      }

      if (isEnBrandHideOnly) {
        if (!isBrandTitleText(sourceText)) continue;
      }

      if (isConversationTitleNode(ownerEl)) {
        const cid = getCascadeIdFromRow(ownerEl);
        if (cid && customTitles[cid] && isPrimaryConversationTitleTarget(tn, ownerEl)) {
          if (cur !== customTitles[cid]) {
            origTextNodes.set(tn, { orig: sourceText, translated: customTitles[cid] });
            if (tn.nodeValue !== customTitles[cid]) tn.nodeValue = customTitles[cid];
            count++;
          }
          continue;
        }
      }

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
        inOptionContext: isModelOrPermissionContext(ownerEl),
        slashCommandContext: isSlashCommandContext(ownerEl),
        customRules
      });
      if (nextText !== sourceText) {
        origTextNodes.set(tn, { orig: sourceText, translated: nextText });
        if (tn.nodeValue !== nextText) tn.nodeValue = nextText;
        count++;
      } else if (
        allowTitles &&
        lang !== 'en' &&
        isConversationTitleNode(ownerEl) &&
        isTranslatableConversationTitleText(sourceText)
      ) {
        const cid = getCascadeIdFromRow(ownerEl);
        const trimmedSrc = sourceText.trim();
        const cacheKey = `${lang}::${cid}::${trimmedSrc}`;
        const cached = remoteTitleCache.get(cacheKey);
        if (cached && !cached.blocked && cached.translated && cached.translated !== trimmedSrc) {
          const lead = sourceText.slice(0, sourceText.indexOf(trimmedSrc));
          const tail = sourceText.slice(sourceText.indexOf(trimmedSrc) + trimmedSrc.length);
          const fullNext = `${lead}${cached.translated}${tail}`;
          origTextNodes.set(tn, { orig: sourceText, translated: fullNext });
          if (tn.nodeValue !== fullNext) tn.nodeValue = fullNext;
          count++;
        } else {
          if (rec && cur !== rec.orig) {
            tn.nodeValue = rec.orig;
            origTextNodes.delete(tn);
          }
          if (!cached && !pendingTitleKeys.has(cacheKey)) {
            untranslatedTitleTargets.push({ node: tn, isTextNode: true, cascadeId: cid, sourceText: trimmedSrc, rawText: sourceText });
          }
        }
      } else if (rec && cur !== rec.orig) {
        tn.nodeValue = rec.orig;
        origTextNodes.delete(tn);
      }
    }

    for (const el of leafEls) {
      const cur = el.textContent || '';
      const rec = origLeafEls.get(el);
      const sourceText = rec && rec.translated === cur ? rec.orig : cur;

      if (isBrandTitleText(sourceText)) {
        if (applyBrandMode(el, brandMode)) {
          count++;
          continue;
        }
      }

      if (isEnBrandHideOnly) continue;

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

      const nextText = translateText(sourceText, {
        lang,
        englishLabels: opts.englishLabels,
        brandTitle: brandMode,
        inOptionContext: isModelOrPermissionContext(el),
        slashCommandContext: isSlashCommandContext(el),
        customRules
      });
      if (nextText !== sourceText) {
        origLeafEls.set(el, { orig: sourceText, translated: nextText });
        rewrittenEls.add(el);
        if (el.textContent !== nextText) el.textContent = nextText;
        count++;
      } else if (
        allowTitles &&
        lang !== 'en' &&
        isConversationTitleNode(el) &&
        isTranslatableConversationTitleText(sourceText)
      ) {
        const trimmedSrc = sourceText.trim();
        const cacheKey = `${lang}::${cid}::${trimmedSrc}`;
        const cached = remoteTitleCache.get(cacheKey);
        if (cached && !cached.blocked && cached.translated && cached.translated !== trimmedSrc) {
          const lead = sourceText.slice(0, sourceText.indexOf(trimmedSrc));
          const tail = sourceText.slice(sourceText.indexOf(trimmedSrc) + trimmedSrc.length);
          const fullNext = `${lead}${cached.translated}${tail}`;
          origLeafEls.set(el, { orig: sourceText, translated: fullNext });
          rewrittenEls.add(el);
          if (el.textContent !== fullNext) el.textContent = fullNext;
          count++;
        } else {
          if (rec && cur !== rec.orig) {
            el.textContent = rec.orig;
            origLeafEls.delete(el);
          }
          if (!cached && !pendingTitleKeys.has(cacheKey)) {
            untranslatedTitleTargets.push({ node: el, isTextNode: false, cascadeId: cid, sourceText: trimmedSrc, rawText: sourceText });
          }
        }
      } else if (rec && cur !== rec.orig) {
        el.textContent = rec.orig;
        origLeafEls.delete(el);
      }
    }

    if (!isEnBrandHideOnly) {
      for (const el of allEls) {
        if (typeof el.getAttribute !== 'function' || typeof el.setAttribute !== 'function') continue;
        for (const attr of ['aria-label', 'title', 'placeholder', 'aria-placeholder', 'data-placeholder']) {
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
            brandTitle: brandMode === BRAND_TITLE_MODES.HIDDEN ? BRAND_TITLE_MODES.ENGLISH : brandMode,
            inOptionContext: isModelOrPermissionContext(el),
            slashCommandContext: isSlashCommandContext(el),
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
    }

    if (untranslatedTitleTargets.length > 0 && typeof opts.onUntranslatedTitles === 'function') {
      opts.onUntranslatedTitles(untranslatedTitleTargets);
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

  return {
    applyTranslations,
    restoreAll,
    remoteTitleCache,
    pendingTitleKeys,
    clearRemoteTitleCache,
    applyResolvedTitleEntries
  };
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
      : Boolean(base.enableRemoteThinkingTranslation)
  };
}

async function mount(ctx) {
  dispose();

  let cfg = mergeManagedSettings(ctx.settings.get(), {
    lang: DEFAULT_LANG,
    brandTitle: BRAND_TITLE_MODES.ENGLISH,
    englishLabels: false,
    translateThinking: true,
    translateConversationTitles: true,
    enableRemoteThinkingTranslation: false,
    customRules: [],
    titles: {}
  });

  const docRef = ctx.anchors.query('sidebar.conversationRows')?.ownerDocument
    || ctx.anchors.query('topbar.rightCluster')?.ownerDocument
    || globalThis.document;
  const translator = createDomTranslator({ doc: docRef });
  let thinkingEventsHandled = 0;
  let disposed = false;
  let isApplying = false;
  let flushTimer = null;
  const pendingNodes = new Set();
  let domObserver = null;

  async function invokeNodeCommand(commandId, args = []) {
    try {
      if (ctx.commands && typeof ctx.commands.execute === 'function') {
        const res = await ctx.commands.execute(commandId, args);
        return (res && typeof res === 'object' && 'result' in res) ? res.result : res;
      }
    } catch {}
    try {
      if (ctx.bridge && typeof ctx.bridge.post === 'function') {
        const res = await ctx.bridge.post('/__command', { commandId, args });
        if (res && res.ok && 'result' in res) return res.result;
      }
    } catch {}
    return null;
  }

  async function resolveUntranslatedTitles(targets) {
    if (disposed || cfg.lang === 'en' || cfg.translateConversationTitles === false) return;
    const reqLang = cfg.lang;
    const unique = new Map();
    const validTargets = [];
    for (const item of targets) {
      if (!item || !item.sourceText) continue;
      const cacheKey = `${reqLang}::${item.cascadeId || ''}::${item.sourceText}`;
      if (translator.remoteTitleCache.has(cacheKey) || translator.pendingTitleKeys.has(cacheKey)) continue;
      translator.pendingTitleKeys.add(cacheKey);
      validTargets.push({ ...item, cacheKey });
      if (!unique.has(cacheKey)) {
        unique.set(cacheKey, { cascadeId: item.cascadeId || '', text: item.sourceText, cacheKey });
      }
    }
    if (unique.size === 0) return;

    const batch = Array.from(unique.values()).slice(0, 50);
    try {
      const res = await invokeNodeCommand('zh-cn.translate-titles', [
        batch.map(({ cascadeId, text }) => ({ cascadeId, text })),
        { lang: reqLang }
      ]);
      if (disposed) return;
      const list = Array.isArray(res?.results) ? res.results : [];
      for (const r of list) {
        const key = `${reqLang}::${r.cascadeId || ''}::${r.text}`;
        translator.remoteTitleCache.set(key, {
          translated: r.translated || r.text,
          blocked: Boolean(r.blocked)
        });
      }
      if (cfg.lang === reqLang && cfg.translateConversationTitles !== false) {
        runWithMutationGuard(() => {
          translator.applyResolvedTitleEntries(cfg, validTargets);
        });
      }
    } finally {
      for (const item of validTargets) {
        translator.pendingTitleKeys.delete(item.cacheKey);
      }
    }
  }

  function buildApplyOptions() {
    return {
      ...cfg,
      onUntranslatedTitles: (targets) => {
        void resolveUntranslatedTitles(targets);
      }
    };
  }

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
    if (disposed || (cfg.lang === 'en' && cfg.brandTitle !== BRAND_TITLE_MODES.HIDDEN) || pendingNodes.size === 0) {
      pendingNodes.clear();
      return;
    }
    const nodes = Array.from(pendingNodes);
    pendingNodes.clear();
    runWithMutationGuard(() => {
      const applyOpts = buildApplyOptions();
      if (nodes.length > 60) {
        translator.applyTranslations(applyOpts);
        return;
      }
      const nodeSet = new Set(nodes);
      for (const node of nodes) {
        if (!node || hasAncestorInSet(node, nodeSet)) continue;
        if (node.isConnected === false) continue;
        translator.applyTranslations(applyOpts, node);
      }
    });
  }

  function syncDom() {
    runWithMutationGuard(() => {
      if (cfg.lang === 'en') {
        translator.restoreAll();
        if (cfg.brandTitle === BRAND_TITLE_MODES.HIDDEN) {
          translator.applyTranslations(buildApplyOptions());
        }
      } else {
        translator.applyTranslations(buildApplyOptions());
      }
    });
    const meta = getLanguageMeta(cfg.lang);
    try {
      const langPayload = { lang: cfg.lang, bcp47: meta.bcp47, shortLabel: meta.shortLabel };
      void Promise.resolve(ctx.state.set('state:zh-cn.lang@1', langPayload)).catch(() => {});
      void Promise.resolve(ctx.state.set('state:host.locale@1', { ...langPayload, locale: meta.bcp47 })).catch(() => {});
    } catch {}
  }

  const stopSettingsSub = ctx.settings.onChange((nextValues) => {
    const prevRemote = cfg.enableRemoteThinkingTranslation;
    cfg = mergeManagedSettings(nextValues, cfg);
    if (!prevRemote && cfg.enableRemoteThinkingTranslation) {
      translator.clearRemoteTitleCache(true);
    }
    syncDom();
  });

  // 订阅 chat-nav 广播的思考展开事件，消除模块间循环依赖
  const stopThinkingSub = ctx.events.on('chat:thinking-expanded@1', () => {
    thinkingEventsHandled++;
    if (cfg.lang !== 'en' && cfg.translateThinking !== false) {
      runWithMutationGuard(() => translator.applyTranslations(buildApplyOptions()));
    }
  });

  const stopAnchor = ctx.anchors.observe('sidebar.conversationRows', () => {
    if (cfg.lang !== 'en') {
      runWithMutationGuard(() => translator.applyTranslations(buildApplyOptions()));
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
      if (disposed || isApplying || (cfg.lang === 'en' && cfg.brandTitle !== BRAND_TITLE_MODES.HIDDEN) || !Array.isArray(records)) return;
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
        attributeFilter: ['aria-label', 'title', 'placeholder', 'aria-placeholder', 'data-placeholder']
      });
    } catch {
      domObserver = null;
    }
  }

  syncDom();

  void invokeNodeCommand('zh-cn.get-renderer-state').then((nodeState) => {
    if (disposed || !nodeState || typeof nodeState !== 'object') return;
    let dirty = false;
    if (Array.isArray(nodeState.customRules) && nodeState.customRules.length > 0) {
      cfg.customRules = nodeState.customRules;
      dirty = true;
    }
    if (nodeState.titles && typeof nodeState.titles === 'object' && Object.keys(nodeState.titles).length > 0) {
      cfg.titles = nodeState.titles;
      dirty = true;
    }
    if (dirty && cfg.lang !== 'en') {
      syncDom();
    }
  });

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
    stopSettingsSub,
    stopThinkingSub,
    stopAnchor,
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
