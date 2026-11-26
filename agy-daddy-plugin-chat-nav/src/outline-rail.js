'use strict';

const QUESTION_CUE_RE = /[?？]|(?:^|[\s，。；：])(?:为什么|怎么|如何|是否|能否|哪里|哪些|哪个|请问|可以吗|行不行|对吗|对不对|what|why|how|when|where|which|can\s|could\s|should\s|would\s|is\s|are\s|do\s|does\s)/i;

function isEditableElement(el, doc) {
  const candidates = [el, doc?.activeElement].filter(Boolean);
  for (const node of candidates) {
    if (!node) continue;
    const tag = String(node.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (node.isContentEditable === true) return true;
    const ce = node.getAttribute?.('contenteditable');
    if (ce === 'true' || ce === '') return true;
    if (node.getAttribute?.('data-lexical-editor') === 'true') return true;
    if (node.getAttribute?.('role') === 'textbox') return true;
    if (typeof node.closest === 'function') {
      const editableAncestor = node.closest(
        'input, textarea, select, [contenteditable="true"], [contenteditable=""], [data-lexical-editor="true"], [role="textbox"], .monaco-editor, .cm-editor, .CodeMirror'
      );
      if (editableAncestor) return true;
    }
  }
  return false;
}

function isKeyQuestionText(text) {
  const clean = String(text || '').trim();
  if (!clean) return false;
  return QUESTION_CUE_RE.test(clean);
}

function summarizeTitle(text, maxLen = 58) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const first = (lines[0] || '').replace(/\s+/g, ' ');
  if (!first) return '对话轮次';
  return first.length > maxLen ? `${first.slice(0, maxLen - 1)}…` : first;
}

function getRectSafe(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  try {
    return el.getBoundingClientRect() || null;
  } catch {
    return null;
  }
}

function extractHeadingsFromElement(el, maxHeadings = 4) {
  if (!el || typeof el.querySelectorAll !== 'function') return [];
  const nodes = Array.from(el.querySelectorAll('h1, h2, h3') || []);
  const out = [];
  for (const h of nodes) {
    if (h.closest?.('[data-agy-code-injected="1"]')) continue;
    const text = String(h.textContent || '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const tag = String(h.tagName || 'h2').toLowerCase();
    out.push({
      el: h,
      level: Number(tag.slice(1)) || 2,
      text: text.length > 44 ? `${text.slice(0, 43)}…` : text
    });
    if (out.length >= maxHeadings) break;
  }
  return out;
}

function extractOutlineItems(vp, opts = {}) {
  if (!vp || typeof vp.querySelectorAll !== 'function') return [];
  const nodes = Array.from(vp.querySelectorAll('[data-testid="user-message"], [data-testid="agent-response"]') || []);
  if (nodes.length === 0) return [];

  const vpRect = getRectSafe(vp);
  const scrollHeight = Math.max(1, Number(vp.scrollHeight || vpRect?.height || 1));
  const curScrollTop = Number(vp.scrollTop || 0);

  const items = [];
  let currentRound = null;

  for (const node of nodes) {
    const tid = node.getAttribute?.('data-testid');
    if (tid === 'user-message') {
      const rawText = String(node.innerText || node.textContent || '').trim();
      const idx = items.length + 1;
      const r = getRectSafe(node);
      const offsetTop = (r && vpRect) ? Math.max(0, Math.round(r.top - vpRect.top + curScrollTop)) : null;
      currentRound = {
        index: idx,
        el: node,
        responseEl: null,
        role: 'user',
        title: summarizeTitle(rawText),
        rawText,
        isKeyQuestion: isKeyQuestionText(rawText),
        codeCount: Array.from(node.querySelectorAll?.('pre') || []).length,
        headings: [],
        offsetTop,
        ratio: 0
      };
      items.push(currentRound);
    } else if (tid === 'agent-response') {
      const pres = Array.from(node.querySelectorAll?.('pre') || []).length;
      const headings = extractHeadingsFromElement(node);
      if (currentRound && !currentRound.responseEl) {
        currentRound.responseEl = node;
        currentRound.codeCount += pres;
        currentRound.headings = headings;
      } else {
        const rawText = String(node.innerText || node.textContent || '').trim();
        const idx = items.length + 1;
        const r = getRectSafe(node);
        const offsetTop = (r && vpRect) ? Math.max(0, Math.round(r.top - vpRect.top + curScrollTop)) : null;
        currentRound = {
          index: idx,
          el: node,
          responseEl: node,
          role: 'assistant',
          title: headings[0]?.text || summarizeTitle(rawText),
          rawText,
          isKeyQuestion: false,
          codeCount: pres,
          headings,
          offsetTop,
          ratio: 0
        };
        items.push(currentRound);
      }
    }
  }

  const total = items.length;
  for (let i = 0; i < total; i++) {
    const it = items[i];
    if (it.offsetTop !== null && scrollHeight > 1) {
      it.ratio = Math.max(0.02, Math.min(0.98, it.offsetTop / scrollHeight));
    } else {
      it.ratio = total === 1 ? 0.08 : (0.04 + (i / Math.max(1, total - 1)) * 0.92);
    }
  }

  return opts.maxItems > 0 ? items.slice(0, opts.maxItems) : items;
}

function filterOutlineItems(items = [], filterMode = 'all') {
  if (!Array.isArray(items)) return [];
  if (filterMode === 'questions') return items.filter((it) => Boolean(it.isKeyQuestion));
  if (filterMode === 'code') return items.filter((it) => Number(it.codeCount || 0) > 0);
  return items;
}

function createOutlineRail(deps = {}) {
  const {
    doc,
    win,
    anchors,
    findChatAreaElement,
    hasOpenDialog,
    scrollViewportTo,
    getSettings
  } = deps;

  let railEl = null;
  let tracksEl = null;
  let popoverEl = null;
  let headerTitleEl = null;
  let filterBarEl = null;
  let listEl = null;
  let filterMode = 'all';
  let popoverOpen = false;
  let closeTimer = null;
  let observedVp = null;
  let onVpScroll = null;
  let activeIndex = -1;
  let cachedItems = [];
  let disposed = false;

  function isEnabled() {
    const s = typeof getSettings === 'function' ? (getSettings() || {}) : {};
    return s.showOutlineRail !== false;
  }

  function clearCloseTimer() {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function scheduleClosePopover() {
    clearCloseTimer();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      setPopoverOpen(false);
    }, 180);
  }

  function findNativeRailHost() {
    if (!doc?.querySelector) return null;
    return doc.querySelector('[data-testid="conversation-rail"], [data-testid="chat-rail"], [data-testid="minimap-rail"]');
  }

  function teardown() {
    clearCloseTimer();
    if (observedVp && onVpScroll) {
      try { observedVp.removeEventListener?.('scroll', onVpScroll); } catch {}
    }
    observedVp = null;
    onVpScroll = null;
    if (popoverEl?.remove) popoverEl.remove();
    if (railEl?.remove) railEl.remove();
    railEl = null;
    tracksEl = null;
    popoverEl = null;
    headerTitleEl = null;
    filterBarEl = null;
    listEl = null;
    popoverOpen = false;
  }

  function scrollToTargetElement(el, index) {
    if (!el) return false;
    const vp = anchors?.query?.('chat.scrollViewport') || anchors?.query?.('chat.messageList');
    if (vp) {
      const vpRect = getRectSafe(vp);
      const elRect = getRectSafe(el);
      if (vpRect && elRect && vpRect.height > 0) {
        const targetTop = Math.max(0, Math.round(Number(vp.scrollTop || 0) + (elRect.top - vpRect.top) - 12));
        if (typeof scrollViewportTo === 'function') scrollViewportTo(vp, targetTop);
        else vp.scrollTop = targetTop;
      } else if (typeof el.scrollIntoView === 'function') {
        try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch {}
      } else {
        const idxPos = Math.max(0, Number(index) - 1) * 180;
        vp.scrollTop = idxPos;
      }
    } else if (typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch {}
    }
    if (Number.isFinite(index) && index > 0) {
      setActiveTurnIndex(index);
    }
    return true;
  }

  function setActiveTurnIndex(idx) {
    activeIndex = idx;
    if (tracksEl) {
      for (const tick of tracksEl.children || []) {
        const tIdx = Number(tick.getAttribute?.('data-turn-index'));
        tick.setAttribute?.('data-active', tIdx === activeIndex ? 'true' : 'false');
      }
    }
    if (listEl) {
      for (const row of listEl.children || []) {
        const rIdx = Number(row.getAttribute?.('data-turn-index'));
        row.setAttribute?.('data-active', rIdx === activeIndex ? 'true' : 'false');
      }
    }
  }

  function syncActiveTurnFromScroll() {
    if (!cachedItems.length) return;
    const vp = anchors?.query?.('chat.scrollViewport');
    const vpRect = getRectSafe(vp);
    if (!vp || !vpRect || vpRect.height <= 0) {
      if (activeIndex < 1) setActiveTurnIndex(cachedItems[0].index);
      return;
    }
    const anchorY = vpRect.top + 36;
    let best = cachedItems[0].index;
    for (const item of cachedItems) {
      const r = getRectSafe(item.el);
      if (!r) continue;
      if (r.top <= anchorY) best = item.index;
      else break;
    }
    setActiveTurnIndex(best);
  }

  function attachScrollListener() {
    const vp = anchors?.query?.('chat.scrollViewport') || null;
    if (vp === observedVp) return;
    if (observedVp && onVpScroll) {
      try { observedVp.removeEventListener?.('scroll', onVpScroll); } catch {}
    }
    observedVp = vp;
    if (vp && vp.addEventListener) {
      onVpScroll = () => syncActiveTurnFromScroll();
      vp.addEventListener('scroll', onVpScroll, { passive: true });
    } else {
      onVpScroll = null;
    }
  }

  function clearChildren(container) {
    if (!container) return;
    while (container.children?.length > 0) {
      const ch = container.children[container.children.length - 1];
      if (ch?.remove) ch.remove();
      else break;
    }
    if (Array.isArray(container.children)) container.children.length = 0;
  }

  function renderPopoverContent() {
    if (!popoverEl || !doc?.createElement) return;
    const allCount = cachedItems.length;
    const qCount = filterOutlineItems(cachedItems, 'questions').length;
    const cCount = filterOutlineItems(cachedItems, 'code').length;
    const filtered = filterOutlineItems(cachedItems, filterMode);

    if (headerTitleEl) {
      headerTitleEl.textContent = `会话大纲 (${allCount} 轮)`;
    }

    if (filterBarEl) {
      clearChildren(filterBarEl);
      const filters = [
        { id: 'all', label: `全部 ${allCount}` },
        { id: 'questions', label: `关键提问 ${qCount}` },
        { id: 'code', label: `含代码 ${cCount}` }
      ];
      for (const f of filters) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'agy-outline-filter-btn';
        btn.id = `agy-outline-filter-${f.id}`;
        btn.setAttribute?.('data-filter', f.id);
        btn.setAttribute?.('data-active', filterMode === f.id ? 'true' : 'false');
        btn.textContent = f.label;
        btn.addEventListener('click', (e) => {
          e?.stopPropagation?.();
          filterMode = f.id;
          renderPopoverContent();
        });
        filterBarEl.appendChild(btn);
      }
    }

    if (listEl) {
      clearChildren(listEl);
      if (filtered.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'agy-outline-empty';
        empty.textContent = filterMode === 'questions' ? '暂无匹配的关键提问' : '暂无匹配章节';
        listEl.appendChild(empty);
        return;
      }
      for (const item of filtered) {
        const row = doc.createElement('button');
        row.type = 'button';
        row.className = 'agy-outline-item';
        row.setAttribute?.('data-turn-index', String(item.index));
        row.setAttribute?.('data-key-question', item.isKeyQuestion ? 'true' : 'false');
        row.setAttribute?.('data-active', item.index === activeIndex ? 'true' : 'false');

        const badge = doc.createElement('span');
        badge.className = 'agy-outline-idx';
        badge.textContent = `#${item.index}`;
        row.appendChild(badge);

        const titleSpan = doc.createElement('span');
        titleSpan.className = 'agy-outline-text';
        titleSpan.textContent = item.title;
        row.appendChild(titleSpan);

        if (item.codeCount > 0) {
          const codeTag = doc.createElement('span');
          codeTag.className = 'agy-outline-code-tag';
          codeTag.textContent = `${item.codeCount}段代码`;
          row.appendChild(codeTag);
        }

        row.addEventListener('click', (e) => {
          e?.stopPropagation?.();
          scrollToTargetElement(item.el, item.index);
        });
        listEl.appendChild(row);

        if (filterMode === 'all' && Array.isArray(item.headings) && item.headings.length > 0) {
          for (const hd of item.headings) {
            const sub = doc.createElement('button');
            sub.type = 'button';
            sub.className = 'agy-outline-subheading';
            sub.setAttribute?.('data-heading-level', String(hd.level));
            sub.setAttribute?.('data-turn-index', String(item.index));
            sub.textContent = hd.text;
            sub.addEventListener('click', (e) => {
              e?.stopPropagation?.();
              scrollToTargetElement(hd.el, item.index);
            });
            listEl.appendChild(sub);
          }
        }
      }
    }
  }

  function renderRailTicks() {
    if (!tracksEl || !doc?.createElement) return;
    clearChildren(tracksEl);
    for (const item of cachedItems) {
      const tick = doc.createElement('button');
      tick.type = 'button';
      tick.className = 'agy-rail-tick';
      tick.setAttribute?.('data-turn-index', String(item.index));
      tick.setAttribute?.('data-key-question', item.isKeyQuestion ? 'true' : 'false');
      tick.setAttribute?.('data-has-code', item.codeCount > 0 ? 'true' : 'false');
      tick.setAttribute?.('data-active', item.index === activeIndex ? 'true' : 'false');
      tick.setAttribute?.('title', `#${item.index} ${item.title}`);
      tick.setAttribute?.('aria-label', `跳转到第 ${item.index} 轮: ${item.title}`);
      if (tick.style) {
        tick.style.top = `${Math.round(item.ratio * 100)}%`;
      }
      tick.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        scrollToTargetElement(item.el, item.index);
      });
      tracksEl.appendChild(tick);
    }
  }

  function setPopoverOpen(open) {
    const next = Boolean(open) && isEnabled() && cachedItems.length > 0 && !(typeof hasOpenDialog === 'function' && hasOpenDialog());
    popoverOpen = next;
    if (popoverEl) {
      popoverEl.hidden = !next;
      if (next) {
        popoverEl.removeAttribute?.('hidden');
        renderPopoverContent();
      } else {
        popoverEl.setAttribute?.('hidden', 'true');
      }
    }
    if (railEl) {
      railEl.setAttribute?.('data-outline-open', next ? 'true' : 'false');
    }
    return popoverOpen;
  }

  function ensureRail() {
    if (disposed || !doc?.createElement) return null;
    if (!isEnabled()) {
      teardown();
      return null;
    }
    if (railEl) return railEl;

    railEl = doc.createElement('nav');
    railEl.id = 'agy-chat-outline-rail';
    railEl.className = 'agy-chat-outline-rail';
    railEl.setAttribute?.('aria-label', '会话大纲导轨');
    railEl.setAttribute?.('data-outline-open', 'false');

    tracksEl = doc.createElement('div');
    tracksEl.id = 'agy-chat-outline-tracks';
    tracksEl.className = 'agy-chat-outline-tracks';
    railEl.appendChild(tracksEl);

    popoverEl = doc.createElement('div');
    popoverEl.id = 'agy-chat-outline-popover';
    popoverEl.className = 'agy-chat-outline-popover';
    popoverEl.setAttribute?.('role', 'region');
    popoverEl.setAttribute?.('aria-label', '会话快速大纲');
    popoverEl.hidden = true;
    popoverEl.setAttribute?.('hidden', 'true');

    const hdr = doc.createElement('div');
    hdr.className = 'agy-outline-header';
    headerTitleEl = doc.createElement('span');
    headerTitleEl.className = 'agy-outline-title';
    headerTitleEl.textContent = '会话大纲';
    hdr.appendChild(headerTitleEl);
    popoverEl.appendChild(hdr);

    filterBarEl = doc.createElement('div');
    filterBarEl.className = 'agy-outline-filters';
    popoverEl.appendChild(filterBarEl);

    listEl = doc.createElement('div');
    listEl.className = 'agy-outline-list';
    popoverEl.appendChild(listEl);

    railEl.appendChild(popoverEl);

    const onEnter = () => {
      clearCloseTimer();
      setPopoverOpen(true);
    };
    const onLeave = () => {
      scheduleClosePopover();
    };
    railEl.addEventListener('mouseenter', onEnter);
    railEl.addEventListener('mouseleave', onLeave);
    railEl.addEventListener('focusin', onEnter);
    popoverEl.addEventListener('mouseenter', onEnter);
    popoverEl.addEventListener('mouseleave', onLeave);

    const nativeHost = findNativeRailHost();
    const mountRoot = nativeHost || doc.body || doc.documentElement;
    if (nativeHost) railEl.setAttribute?.('data-native-rail', 'true');
    mountRoot?.appendChild?.(railEl);

    return railEl;
  }

  function syncPosition() {
    if (!railEl) return false;
    const dialogOpen = typeof hasOpenDialog === 'function' ? hasOpenDialog() : false;
    railEl.setAttribute?.('data-under-dialog', dialogOpen ? 'true' : 'false');
    if (dialogOpen && popoverOpen) {
      setPopoverOpen(false);
    }

    const empty = cachedItems.length === 0;
    railEl.hidden = empty;
    if (empty) {
      railEl.setAttribute?.('hidden', 'true');
      return false;
    }
    railEl.removeAttribute?.('hidden');

    if (railEl.getAttribute?.('data-native-rail') === 'true') {
      return true;
    }

    const areaEl = typeof findChatAreaElement === 'function' ? findChatAreaElement() : anchors?.query?.('chat.scrollViewport');
    const rect = getRectSafe(areaEl);
    const winH = Number(win?.innerHeight || doc?.documentElement?.clientHeight || 0);
    if (!rect || rect.width <= 40 || rect.height <= 40) {
      return false;
    }
    const leftPx = Math.max(6, Math.round(rect.left) + 6);
    const topPx = Math.max(56, Math.round(rect.top) + 48);
    const availH = Math.max(120, Math.min(rect.height - 96, (winH > 0 ? winH - topPx - 64 : rect.height - 96)));
    if (railEl.style) {
      railEl.style.left = `${leftPx}px`;
      railEl.style.top = `${topPx}px`;
      railEl.style.height = `${Math.round(availH)}px`;
    }
    return true;
  }

  function refresh() {
    if (disposed) return [];
    if (!isEnabled()) {
      teardown();
      return [];
    }
    ensureRail();
    attachScrollListener();
    const vp = anchors?.query?.('chat.scrollViewport');
    cachedItems = extractOutlineItems(vp);
    if (cachedItems.length > 0 && activeIndex < 1) {
      activeIndex = cachedItems[0].index;
    }
    renderRailTicks();
    if (popoverOpen) {
      renderPopoverContent();
    }
    syncActiveTurnFromScroll();
    syncPosition();
    return cachedItems;
  }

  function dispose() {
    disposed = true;
    teardown();
    cachedItems = [];
    activeIndex = -1;
  }

  refresh();

  return {
    refresh,
    syncPosition,
    setPopoverOpen,
    isPopoverOpen: () => popoverOpen,
    setFilterMode: (mode) => {
      filterMode = (mode === 'questions' || mode === 'code') ? mode : 'all';
      if (popoverOpen) renderPopoverContent();
    },
    getFilterMode: () => filterMode,
    getOutlineItems: () => [...cachedItems],
    syncActiveTurnFromScroll,
    dispose
  };
}

module.exports = {
  isEditableElement,
  isKeyQuestionText,
  extractOutlineItems,
  filterOutlineItems,
  createOutlineRail
};
