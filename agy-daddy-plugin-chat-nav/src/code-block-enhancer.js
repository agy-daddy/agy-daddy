'use strict';

const CODE_COPY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CODE_FOLD_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
const CODE_EXPAND_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

const EXCLUDED_ANCESTOR_SELECTOR = [
  '#agy-chat-nav-float',
  '#agy-chat-outline-rail',
  '#agy-chat-outline-popover',
  '#agy-inline-file-editor-panel',
  '[data-testid="settings-dialog"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  'dialog',
  '.monaco-editor',
  '.cm-editor',
  '.CodeMirror'
].join(', ');

const CODE_CONTAINER_SELECTORS = [
  '[data-testid="autoscroll-viewport"] pre',
  '[data-testid="user-message"] pre',
  '[data-testid="agent-response"] pre',
  '[data-testid*="artifact"] pre',
  '[aria-label*="Artifact"] pre',
  '[aria-label*="artifact"] pre',
  '[aria-label*="产物"] pre',
  '[aria-label*="File Viewer"] pre',
  '[aria-label*="文件查看器"] pre',
  '.artifact-content pre',
  '.markdown-body pre',
  '.prose pre'
].join(', ');

function getPrevElementSibling(el) {
  if (!el) return null;
  if (el.previousElementSibling !== undefined) return el.previousElementSibling;
  const children = el.parentElement?.children;
  if (!Array.isArray(children)) return null;
  const idx = children.indexOf(el);
  return idx > 0 ? children[idx - 1] : null;
}

function getNextElementSibling(el) {
  if (!el) return null;
  if (el.nextElementSibling !== undefined) return el.nextElementSibling;
  const children = el.parentElement?.children;
  if (!Array.isArray(children)) return null;
  const idx = children.indexOf(el);
  return idx >= 0 && idx + 1 < children.length ? children[idx + 1] : null;
}

function getRectSafe(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  try {
    return el.getBoundingClientRect() || null;
  } catch {
    return null;
  }
}

function countCodeLines(rawText) {
  const str = String(rawText ?? '').replace(/\r\n/g, '\n');
  if (!str) return 0;
  const normalized = str.endsWith('\n') ? str.slice(0, -1) : str;
  if (!normalized) return 0;
  return normalized.split('\n').length;
}

function extractCodeText(preEl) {
  if (!preEl) return '';
  const codeEl = preEl.querySelector?.('code') || preEl;
  return String(codeEl?.textContent ?? preEl.textContent ?? '');
}

function extractCodeLanguage(preEl, nativeHeaderEl = null) {
  const codeEl = preEl?.querySelector?.('code');
  const candidates = [
    codeEl?.getAttribute?.('data-language'),
    codeEl?.getAttribute?.('data-lang'),
    preEl?.getAttribute?.('data-language'),
    preEl?.getAttribute?.('data-lang'),
    codeEl?.className,
    preEl?.className
  ];
  for (const cand of candidates) {
    if (!cand) continue;
    const str = String(cand);
    const match = /(?:^|\s)(?:language-|lang-)([a-zA-Z0-9_+#.-]+)/i.exec(str);
    if (match) return match[1].toLowerCase();
    if (!/\s/.test(str) && /^[a-zA-Z0-9_+#.-]{1,24}$/.test(str) && !/^(hljs|shiki|prose|not-prose)$/i.test(str)) {
      return str.toLowerCase();
    }
  }
  if (nativeHeaderEl) {
    const hdrText = String(nativeHeaderEl.textContent || '')
      .replace(/复制代码|复制|copy code|copy|折叠|展开|collapse|expand/gi, ' ')
      .trim();
    const firstToken = hdrText.split(/\s+/).find((t) => /^[a-zA-Z0-9_+#.-]{1,20}$/.test(t));
    if (firstToken) return firstToken.toLowerCase();
  }
  return 'code';
}

function isCodeBlockCompleted(preEl, opts = {}) {
  if (!preEl) return false;
  if (preEl.getAttribute?.('data-streaming') === 'true' || preEl.closest?.('[data-streaming="true"]')) {
    return false;
  }
  if (!opts.isAssistantBusy) return true;
  const doc = opts.doc || preEl.ownerDocument;
  const vp = opts.viewport || doc?.querySelector?.('[data-testid="autoscroll-viewport"]');
  const responses = vp?.querySelectorAll
    ? Array.from(vp.querySelectorAll('[data-testid="agent-response"]') || [])
    : (doc?.querySelectorAll ? Array.from(doc.querySelectorAll('[data-testid="agent-response"]') || []) : []);
  if (responses.length === 0) return true;
  const lastResp = responses[responses.length - 1];
  if (!lastResp || (lastResp !== preEl && !lastResp.contains?.(preEl))) {
    return true;
  }
  const presInLast = Array.from(lastResp.querySelectorAll?.('pre') || []);
  if (presInLast.length === 0) return true;
  return presInLast[presInLast.length - 1] !== preEl;
}

function computeCollapseScrollCompensation({
  blockTop = 0,
  blockHeightBefore = 0,
  blockHeightAfter = 0,
  viewportTop = 0,
  scrollTop = 0
} = {}) {
  const curTop = Math.max(0, Number(scrollTop) || 0);
  const deltaHeight = Math.max(0, (Number(blockHeightBefore) || 0) - (Number(blockHeightAfter) || 0));
  if (deltaHeight <= 0) return curTop;
  const overlapAbove = Math.max(0, (Number(viewportTop) || 0) - (Number(blockTop) || 0));
  if (overlapAbove <= 0) return curTop;
  const compensate = Math.min(overlapAbove, deltaHeight);
  return Math.max(0, Math.round(curTop - compensate));
}

function isMessageRootElement(el) {
  if (!el) return false;
  const tid = el.getAttribute?.('data-testid');
  if (tid === 'user-message' || tid === 'agent-response' || tid === 'autoscroll-viewport' || tid === 'turn-cards-container') {
    return true;
  }
  const tag = String(el.tagName || '').toLowerCase();
  return tag === 'body' || tag === 'html' || tag === 'main' || tag === 'article';
}

function findNativeCodeHeader(preEl) {
  const parent = preEl?.parentElement;
  if (!parent || isMessageRootElement(parent)) return null;
  const prev = getPrevElementSibling(preEl);
  if (!prev || prev.getAttribute?.('data-agy-code-injected') === '1') return null;
  const prevTag = String(prev.tagName || '').toLowerCase();
  if (prevTag === 'pre' || prevTag === 'p' || prevTag === 'ul' || prevTag === 'ol' || /^h[1-6]$/.test(prevTag)) {
    return null;
  }
  const hasCopyBtn = Boolean(
    prev.querySelector?.('button[aria-label*="copy" i], button[title*="copy" i], button[aria-label*="复制"], button[title*="复制"], [data-testid*="copy"]')
  );
  const nonInjectedSiblings = Array.from(parent.children || []).filter(
    (ch) => ch && ch.getAttribute?.('data-agy-code-injected') !== '1' && ch.getAttribute?.('data-agy-code-collapsed-bar') !== '1'
  );
  const compactHeader = nonInjectedSiblings.length <= 3 && String(prev.textContent || '').trim().length <= 64;
  if (hasCopyBtn || compactHeader) {
    return prev;
  }
  return null;
}

function createCodeBlockEnhancer(deps = {}) {
  const {
    doc,
    win,
    anchors,
    hostDom,
    copyText,
    showToast,
    getSettings,
    onDomMutated
  } = deps;

  const trackedBlocks = new Map(); // preEl -> record
  let domObserver = null;
  let refreshTimer = null;
  let rafId = null;
  let onViewportScroll = null;
  let observedScrollEl = null;
  let disposed = false;

  function readSettings() {
    const raw = typeof getSettings === 'function' ? (getSettings() || {}) : {};
    const minLines = Number(raw.codeFoldMinLines);
    return {
      enableCodeBlockSticky: raw.enableCodeBlockSticky !== false,
      enableCodeBlockFold: raw.enableCodeBlockFold !== false,
      codeFoldMinLines: Number.isFinite(minLines) && minLines >= 12 ? Math.min(500, Math.round(minLines)) : 48
    };
  }

  function findNearestScrollViewport(el) {
    const chatVp = anchors?.query?.('chat.scrollViewport') || null;
    if (chatVp && chatVp.contains?.(el)) return chatVp;
    let cur = el?.parentElement;
    while (cur && cur !== doc?.body && cur !== doc?.documentElement) {
      if (typeof win?.getComputedStyle === 'function') {
        try {
          const ov = String(win.getComputedStyle(cur)?.overflowY || '');
          if (ov === 'auto' || ov === 'scroll') return cur;
        } catch {}
      }
      if (Number(cur.scrollHeight || 0) > Number(cur.clientHeight || 0) + 8) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return chatVp;
  }

  function updateRecordUi(rec, cfg) {
    const { preEl, wrapEl, headerEl, isNativeHeader, foldBtn, collapsedBar, linesEl, lineCount, completed } = rec;
    const canFold = cfg.enableCodeBlockFold && completed && lineCount >= cfg.codeFoldMinLines;
    const isCollapsed = canFold && rec.collapsed;

    if (wrapEl) {
      if (cfg.enableCodeBlockSticky) wrapEl.setAttribute?.('data-agy-code-wrap', '1');
      else wrapEl.removeAttribute?.('data-agy-code-wrap');
      if (isCollapsed) wrapEl.setAttribute?.('data-agy-code-collapsed', 'true');
      else wrapEl.removeAttribute?.('data-agy-code-collapsed');
    }

    if (headerEl) {
      if (cfg.enableCodeBlockSticky) {
        headerEl.setAttribute?.('data-agy-code-header', isNativeHeader ? 'native' : 'injected');
      } else if (isNativeHeader) {
        headerEl.removeAttribute?.('data-agy-code-header');
      } else {
        headerEl.setAttribute?.('data-agy-code-header', 'static');
      }
      headerEl.hidden = !isNativeHeader && !cfg.enableCodeBlockSticky && !canFold;
      if (headerEl.hidden) headerEl.setAttribute?.('hidden', 'true');
      else headerEl.removeAttribute?.('hidden');
    }

    if (linesEl) {
      linesEl.textContent = `${lineCount} 行`;
    }

    if (foldBtn) {
      foldBtn.hidden = !canFold;
      if (!canFold) {
        foldBtn.setAttribute?.('hidden', 'true');
      } else {
        foldBtn.removeAttribute?.('hidden');
        foldBtn.setAttribute?.('aria-expanded', isCollapsed ? 'false' : 'true');
        foldBtn.setAttribute?.('data-collapsed', isCollapsed ? 'true' : 'false');
        const label = isCollapsed ? `展开 (${lineCount} 行)` : '折叠';
        foldBtn.setAttribute?.('title', isCollapsed ? `展开代码块 (${lineCount} 行)` : `折叠长代码块 (${lineCount} 行)`);
        foldBtn.setAttribute?.('aria-label', label);
        foldBtn.innerHTML = `${isCollapsed ? CODE_EXPAND_ICON : CODE_FOLD_ICON}<span>${label}</span>`;
      }
    }

    if (isCollapsed) {
      preEl.setAttribute?.('data-agy-code-collapsed', 'true');
    } else {
      preEl.removeAttribute?.('data-agy-code-collapsed');
    }

    if (collapsedBar) {
      collapsedBar.hidden = !isCollapsed;
      if (!isCollapsed) collapsedBar.setAttribute?.('hidden', 'true');
      else {
        collapsedBar.removeAttribute?.('hidden');
        collapsedBar.textContent = `已折叠 ${lineCount} 行代码 · 点击展开`;
      }
    }
  }

  function setRecordCollapsed(rec, nextCollapsed) {
    if (!rec || rec.collapsed === Boolean(nextCollapsed)) return false;
    const cfg = readSettings();
    const canFold = cfg.enableCodeBlockFold && rec.completed && rec.lineCount >= cfg.codeFoldMinLines;
    if (nextCollapsed && !canFold) return false;

    const vp = findNearestScrollViewport(rec.preEl);
    const vpRect = getRectSafe(vp);
    const targetBlock = rec.wrapEl || rec.preEl;
    const beforeRect = getRectSafe(targetBlock);
    const beforeScrollTop = vp ? Number(vp.scrollTop || 0) : 0;

    rec.collapsed = Boolean(nextCollapsed);
    updateRecordUi(rec, cfg);

    if (rec.collapsed && vp && vpRect && beforeRect && beforeRect.height > 0) {
      const afterRect = getRectSafe(targetBlock);
      const afterHeight = afterRect ? Number(afterRect.height || 0) : 36;
      const nextTop = computeCollapseScrollCompensation({
        blockTop: beforeRect.top,
        blockHeightBefore: beforeRect.height,
        blockHeightAfter: afterHeight,
        viewportTop: vpRect.top,
        scrollTop: beforeScrollTop
      });
      if (nextTop !== beforeScrollTop) {
        vp.scrollTop = nextTop;
      }
    }
    if (rec.headerEl) {
      rec.headerEl.removeAttribute?.('data-agy-sticky-ended');
    }
    return true;
  }

  function syncBareStickyHeaders() {
    const vp = anchors?.query?.('chat.scrollViewport');
    const vpRect = getRectSafe(vp);
    if (!vpRect) return;
    for (const rec of trackedBlocks.values()) {
      if (!rec.headerEl || rec.hasDedicatedWrapper || rec.isNativeHeader) continue;
      const preRect = getRectSafe(rec.preEl);
      const hdrRect = getRectSafe(rec.headerEl);
      if (!preRect || !hdrRect) continue;
      const ended = preRect.bottom < vpRect.top + hdrRect.height + 4;
      if (ended) rec.headerEl.setAttribute?.('data-agy-sticky-ended', 'true');
      else rec.headerEl.removeAttribute?.('data-agy-sticky-ended');
    }
  }

  function cleanupRecord(preEl) {
    const rec = trackedBlocks.get(preEl);
    if (!rec) return;
    trackedBlocks.delete(preEl);
    if (rec.foldBtn?.remove) rec.foldBtn.remove();
    if (rec.collapsedBar?.remove) rec.collapsedBar.remove();
    if (!rec.isNativeHeader && rec.headerEl?.remove) rec.headerEl.remove();
    if (rec.isNativeHeader && rec.headerEl) {
      rec.headerEl.removeAttribute?.('data-agy-code-header');
      rec.headerEl.removeAttribute?.('data-agy-sticky-ended');
    }
    if (rec.wrapEl) {
      rec.wrapEl.removeAttribute?.('data-agy-code-wrap');
      rec.wrapEl.removeAttribute?.('data-agy-code-collapsed');
    }
    preEl?.removeAttribute?.('data-agy-code-collapsed');
    preEl?.removeAttribute?.('data-agy-code-enhanced');
  }

  function enhancePre(preEl, cfg, isBusy) {
    if (!preEl || !doc?.createElement) return;
    if (preEl.closest?.(EXCLUDED_ANCESTOR_SELECTOR)) return;

    const rawText = extractCodeText(preEl);
    const lineCount = countCodeLines(rawText);
    const completed = isCodeBlockCompleted(preEl, {
      isAssistantBusy: isBusy,
      doc,
      viewport: anchors?.query?.('chat.scrollViewport')
    });

    const existing = trackedBlocks.get(preEl);
    if (existing) {
      existing.lineCount = lineCount;
      existing.completed = completed;
      if (!completed && existing.collapsed) existing.collapsed = false;
      updateRecordUi(existing, cfg);
      return;
    }

    const nativeHeader = findNativeCodeHeader(preEl);
    const parent = preEl.parentElement;
    if (!parent) return;

    const nonInjectedSiblings = Array.from(parent.children || []).filter(
      (ch) => ch && ch.getAttribute?.('data-agy-code-injected') !== '1' && ch.getAttribute?.('data-agy-code-collapsed-bar') !== '1'
    );
    const hasDedicatedWrapper = !isMessageRootElement(parent) && nonInjectedSiblings.length <= (nativeHeader ? 3 : 2);
    const wrapEl = hasDedicatedWrapper ? parent : null;
    const lang = extractCodeLanguage(preEl, nativeHeader);

    let headerEl = nativeHeader;
    let linesEl = null;
    let foldBtn = null;

    if (!headerEl) {
      headerEl = doc.createElement('div');
      headerEl.className = 'agy-code-header';
      headerEl.setAttribute?.('data-agy-code-injected', '1');
      headerEl.setAttribute?.('data-agy-code-header', 'injected');

      const leftGroup = doc.createElement('div');
      leftGroup.className = 'agy-code-header-left';
      const langEl = doc.createElement('span');
      langEl.className = 'agy-code-lang';
      langEl.textContent = lang;
      leftGroup.appendChild(langEl);

      linesEl = doc.createElement('span');
      linesEl.className = 'agy-code-lines';
      linesEl.textContent = `${lineCount} 行`;
      leftGroup.appendChild(linesEl);

      const rightGroup = doc.createElement('div');
      rightGroup.className = 'agy-code-header-actions';

      foldBtn = doc.createElement('button');
      foldBtn.type = 'button';
      foldBtn.className = 'agy-code-fold-btn';
      foldBtn.setAttribute?.('data-agy-code-fold', '1');
      rightGroup.appendChild(foldBtn);

      const copyBtn = doc.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'agy-code-copy-btn';
      copyBtn.setAttribute?.('aria-label', '复制代码');
      copyBtn.setAttribute?.('title', '复制代码');
      copyBtn.innerHTML = `${CODE_COPY_ICON}<span>复制</span>`;
      copyBtn.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        const txt = extractCodeText(preEl);
        if (typeof copyText === 'function') {
          Promise.resolve(copyText(txt)).then((ok) => {
            if (ok !== false) showToast?.('已复制代码');
          }).catch(() => {});
        }
      });
      rightGroup.appendChild(copyBtn);

      headerEl.appendChild(leftGroup);
      headerEl.appendChild(rightGroup);
      parent.insertBefore(headerEl, preEl);
    } else {
      foldBtn = doc.createElement('button');
      foldBtn.type = 'button';
      foldBtn.className = 'agy-code-fold-btn';
      foldBtn.setAttribute?.('data-agy-code-fold', '1');
      const existingCopy = nativeHeader.querySelector?.('button[aria-label*="copy" i], button[title*="copy" i], button[aria-label*="复制"], button[title*="复制"], button');
      const actionHost = existingCopy?.parentElement && existingCopy.parentElement !== nativeHeader
        ? existingCopy.parentElement
        : nativeHeader;
      if (existingCopy && existingCopy.parentElement === actionHost) {
        actionHost.insertBefore(foldBtn, existingCopy);
      } else {
        actionHost.appendChild(foldBtn);
      }
    }

    const collapsedBar = doc.createElement('button');
    collapsedBar.type = 'button';
    collapsedBar.className = 'agy-code-collapsed-bar';
    collapsedBar.setAttribute?.('data-agy-code-collapsed-bar', '1');
    collapsedBar.hidden = true;
    collapsedBar.setAttribute?.('hidden', 'true');
    const nextSib = getNextElementSibling(preEl);
    if (nextSib) parent.insertBefore(collapsedBar, nextSib);
    else parent.appendChild(collapsedBar);

    const rec = {
      preEl,
      wrapEl,
      headerEl,
      isNativeHeader: Boolean(nativeHeader),
      hasDedicatedWrapper,
      linesEl,
      foldBtn,
      collapsedBar,
      lineCount,
      completed,
      collapsed: false
    };

    foldBtn.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      setRecordCollapsed(rec, !rec.collapsed);
    });
    collapsedBar.addEventListener('click', (e) => {
      e?.stopPropagation?.();
      setRecordCollapsed(rec, false);
    });

    preEl.setAttribute?.('data-agy-code-enhanced', '1');
    trackedBlocks.set(preEl, rec);
    updateRecordUi(rec, cfg);
  }

  function queryTargetPres() {
    const seen = new Set();
    const out = [];
    const add = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };
    const vp = anchors?.query?.('chat.scrollViewport');
    if (vp?.querySelectorAll) {
      for (const el of vp.querySelectorAll('pre') || []) add(el);
    }
    if (doc?.querySelectorAll) {
      try {
        for (const el of doc.querySelectorAll(CODE_CONTAINER_SELECTORS) || []) add(el);
      } catch {
        for (const el of doc.querySelectorAll('pre') || []) add(el);
      }
    }
    return out;
  }

  function attachViewportScrollListener() {
    const vp = anchors?.query?.('chat.scrollViewport') || null;
    if (vp === observedScrollEl) return;
    if (observedScrollEl && onViewportScroll) {
      try { observedScrollEl.removeEventListener?.('scroll', onViewportScroll); } catch {}
    }
    observedScrollEl = vp;
    if (vp && vp.addEventListener) {
      onViewportScroll = () => syncBareStickyHeaders();
      vp.addEventListener('scroll', onViewportScroll, { passive: true });
    } else {
      onViewportScroll = null;
    }
  }

  function refresh() {
    if (disposed) return 0;
    attachViewportScrollListener();
    const cfg = readSettings();
    const isBusy = Boolean(hostDom?.isAssistantBusy?.());

    if (!cfg.enableCodeBlockSticky && !cfg.enableCodeBlockFold) {
      for (const preEl of Array.from(trackedBlocks.keys())) {
        cleanupRecord(preEl);
      }
      return 0;
    }

    const activePres = new Set(queryTargetPres());
    for (const preEl of Array.from(trackedBlocks.keys())) {
      if (!activePres.has(preEl) || !preEl.parentElement) {
        cleanupRecord(preEl);
      }
    }
    for (const preEl of activePres) {
      enhancePre(preEl, cfg, isBusy);
    }
    syncBareStickyHeaders();
    return trackedBlocks.size;
  }

  function scheduleRefresh() {
    if (disposed || refreshTimer !== null) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
      if (typeof onDomMutated === 'function') {
        try { onDomMutated(); } catch {}
      }
    }, 60);
  }

  function isPluginOwnedNode(node) {
    if (!node || typeof node.getAttribute !== 'function') return false;
    return Boolean(
      node.getAttribute('data-agy-code-injected') === '1'
      || node.getAttribute('data-agy-code-fold') === '1'
      || node.getAttribute('data-agy-code-collapsed-bar') === '1'
      || node.id === 'agy-chat-nav-float'
      || node.id === 'agy-chat-outline-rail'
      || node.id === 'agy-chat-outline-popover'
    );
  }

  function toggleAllLongBlocks(forceState) {
    const cfg = readSettings();
    if (!cfg.enableCodeBlockFold) return 0;
    const eligible = Array.from(trackedBlocks.values()).filter(
      (r) => r.completed && r.lineCount >= cfg.codeFoldMinLines
    );
    if (eligible.length === 0) return 0;
    const targetCollapsed = typeof forceState === 'boolean'
      ? forceState
      : eligible.some((r) => !r.collapsed);
    let changed = 0;
    for (const rec of eligible) {
      if (setRecordCollapsed(rec, targetCollapsed)) changed++;
    }
    return changed;
  }

  function startObserver() {
    const MO = win?.MutationObserver || globalThis.MutationObserver;
    const root = doc?.body || doc?.documentElement;
    if (typeof MO !== 'function' || !root) return;
    domObserver = new MO((records) => {
      let relevant = false;
      for (const rec of records || []) {
        if (isPluginOwnedNode(rec.target)) continue;
        const nodes = [...Array.from(rec.addedNodes || []), ...Array.from(rec.removedNodes || [])];
        if (nodes.length === 0 || nodes.some((n) => !isPluginOwnedNode(n))) {
          relevant = true;
          break;
        }
      }
      if (relevant) scheduleRefresh();
    });
    try {
      domObserver.observe(root, { childList: true, subtree: true });
    } catch {
      domObserver = null;
    }
  }

  function dispose() {
    disposed = true;
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (rafId !== null && typeof win?.cancelAnimationFrame === 'function') {
      try { win.cancelAnimationFrame(rafId); } catch {}
      rafId = null;
    }
    if (domObserver) {
      try { domObserver.disconnect(); } catch {}
      domObserver = null;
    }
    if (observedScrollEl && onViewportScroll) {
      try { observedScrollEl.removeEventListener?.('scroll', onViewportScroll); } catch {}
    }
    observedScrollEl = null;
    onViewportScroll = null;
    for (const preEl of Array.from(trackedBlocks.keys())) {
      cleanupRecord(preEl);
    }
    trackedBlocks.clear();
  }

  startObserver();
  refresh();

  return {
    refresh,
    scheduleRefresh,
    toggleAllLongBlocks,
    getTrackedBlocks: () => Array.from(trackedBlocks.values()),
    setBlockCollapsed: (preEl, collapsed) => {
      const rec = trackedBlocks.get(preEl);
      return rec ? setRecordCollapsed(rec, collapsed) : false;
    },
    dispose
  };
}

module.exports = {
  countCodeLines,
  extractCodeLanguage,
  isCodeBlockCompleted,
  computeCollapseScrollCompensation,
  findNativeCodeHeader,
  createCodeBlockEnhancer
};
