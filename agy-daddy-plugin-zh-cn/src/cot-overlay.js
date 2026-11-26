'use strict';

const {
  THINKING_TRANSLATION_MODES,
  THINKING_DISPLAY_MODES,
  normalizeThinkingTranslationMode,
  normalizeThinkingDisplayMode,
  hashCotKey,
  tokenizeTextWithFileLinks,
  parseThinkingSegments
} = require('./cot-utils');

const COT_OVERLAY_STYLES = `
/* Agy-Daddy CoT Streaming Translator Overlay (MIT Clean-Room, follows host --ag-* theme tokens) */
.agy-cot-panel {
  margin: 8px 0 6px 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--ag-bg-panel, rgba(127, 127, 127, 0.08));
  border: 1px solid var(--ag-border-panel, rgba(127, 127, 127, 0.22));
  color: var(--ag-text-primary, inherit);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
  font-size: 12.5px;
  line-height: 1.55;
  contain: layout style;
}

.agy-cot-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--ag-border-panel, rgba(127, 127, 127, 0.16));
}

.agy-cot-header-left {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.agy-cot-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  background: var(--ag-bg-control-hover, rgba(127, 127, 127, 0.16));
  color: var(--ag-text-secondary, inherit);
  white-space: nowrap;
}

.agy-cot-status {
  font-size: 11px;
  color: var(--ag-text-muted, #71717a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agy-cot-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.agy-cot-btn {
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid var(--ag-border-panel, rgba(127, 127, 127, 0.24));
  background: transparent;
  color: var(--ag-text-secondary, inherit);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  line-height: 1.4;
}

.agy-cot-btn:hover {
  background: var(--ag-bg-control-hover, rgba(127, 127, 127, 0.14));
  color: var(--ag-text-primary, inherit);
}

.agy-cot-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  contain: layout style;
}

.agy-cot-segment {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.agy-cot-segment[data-state="streaming"] {
  opacity: 0.92;
}

.agy-cot-segment[data-state="error"] {
  color: var(--ag-text-muted, #71717a);
}

.agy-cot-file-link {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  margin: 0 2px;
  border-radius: 5px;
  border: 1px solid var(--ag-border-panel, rgba(127, 127, 127, 0.28));
  background: var(--ag-bg-control-hover, rgba(127, 127, 127, 0.12));
  color: var(--ag-text-primary, inherit);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11.5px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.agy-cot-file-link:hover,
.agy-cot-file-link[data-jumped="true"] {
  background: var(--ag-bg-control-hover, rgba(127, 127, 127, 0.24));
}
`;

function getNextElementSibling(el) {
  if (!el) return null;
  if (el.nextElementSibling !== undefined) return el.nextElementSibling;
  const parent = el.parentElement;
  if (!parent || !Array.isArray(parent.children)) return null;
  const idx = parent.children.indexOf(el);
  return idx >= 0 && idx + 1 < parent.children.length ? parent.children[idx + 1] : null;
}

function getElementDisplaySafe(el) {
  if (!el || !el.style) return '';
  if (typeof el.style.getPropertyValue === 'function') {
    const pv = el.style.getPropertyValue('display');
    if (pv) return pv;
  }
  return typeof el.style.display === 'string' ? el.style.display : '';
}

function setElementDisplaySafe(el, val) {
  if (!el || !el.style) return;
  if (val) {
    if (typeof el.style.setProperty === 'function') el.style.setProperty('display', val);
    try { el.style.display = val; } catch {}
  } else {
    if (typeof el.style.removeProperty === 'function') el.style.removeProperty('display');
    try { el.style.display = ''; } catch {}
  }
}

function isInIgnoredHostTree(el) {
  let cur = el;
  while (cur) {
    if (cur.id === 'agy-daddy-host' || cur.id === 'agy-native-settings-mount') return true;
    if (typeof cur.getAttribute === 'function' && cur.getAttribute('data-agy-cot-panel') === '1') return true;
    cur = cur.parentElement || cur.parentNode || null;
  }
  return false;
}

function isElementVisiblyCollapsed(el) {
  if (!el) return true;
  if (el.hidden === true) return true;
  if (typeof el.getAttribute === 'function' && el.getAttribute('hidden') !== null) return true;
  if (getElementDisplaySafe(el) === 'none') return true;
  return false;
}

function isTriggerExpanded(triggerEl, bodyEl) {
  if (!triggerEl) return !isElementVisiblyCollapsed(bodyEl);
  const aria = triggerEl.getAttribute?.('aria-expanded');
  if (aria === 'false') return false;
  if (aria === 'true') return true;
  const ds = triggerEl.getAttribute?.('data-state') || triggerEl.closest?.('[data-state]')?.getAttribute?.('data-state');
  if (ds === 'closed') return false;
  if (ds === 'open') return true;
  if (bodyEl && isElementVisiblyCollapsed(bodyEl)) return false;
  return Boolean(bodyEl);
}

function findBodyForTrigger(doc, triggerEl) {
  if (!triggerEl) return null;
  const ctrlId = triggerEl.getAttribute?.('aria-controls');
  if (ctrlId && doc?.getElementById) {
    const ctrlEl = doc.getElementById(ctrlId);
    if (ctrlEl && !isInIgnoredHostTree(ctrlEl)) return ctrlEl;
  }
  const next = getNextElementSibling(triggerEl);
  if (next && !isInIgnoredHostTree(next)) {
    const nextTestId = String(next.getAttribute?.('data-testid') || '').toLowerCase();
    if (!nextTestId.includes('trigger')) return next;
  }
  const parent = triggerEl.parentElement;
  if (parent) {
    const candidates = parent.querySelectorAll?.(
      '[data-testid="thinking-content"], [data-testid="thought-content"], [data-agy-thinking-body], .thinking-content, .thought-content'
    ) || [];
    for (const c of candidates) {
      if (c && c !== triggerEl && !isInIgnoredHostTree(c)) return c;
    }
  }
  return null;
}

function extractBodySourceText(bodyEl) {
  if (!bodyEl) return '';
  return String(bodyEl.textContent || '').replace(/\r\n/g, '\n').trim();
}

function createCotOverlayController(options = {}) {
  const ctx = options.ctx;
  const doc = options.doc || globalThis.document;
  const getConfig = typeof options.getConfig === 'function' ? options.getConfig : () => ({});
  const onOpenFile = typeof options.onOpenFile === 'function' ? options.onOpenFile : null;
  const trailingDebounceMs = Number.isFinite(Number(options.trailingDebounceMs))
    ? Math.max(0, Number(options.trailingDebounceMs))
    : 180;

  let disposed = false;
  let stopStyleFn = null;
  let scanTimer = null;
  let rafPending = false;
  const dirtyPanels = new Set();
  const records = new Map(); // bodyEl -> record
  const activePollCancels = new Set();

  function ensureStylesInjected() {
    if (stopStyleFn || disposed || !ctx?.styles?.inject) return;
    try {
      stopStyleFn = ctx.styles.inject(COT_OVERLAY_STYLES, {
        scope: 'document',
        id: 'agy-zh-cn-cot-overlay'
      });
    } catch {}
  }

  function removeStylesInjected() {
    if (typeof stopStyleFn === 'function') {
      try { stopStyleFn(); } catch {}
      stopStyleFn = null;
    }
  }

  function scheduleRender(rec) {
    if (disposed || !rec) return;
    dirtyPanels.add(rec);
    if (rafPending) return;
    rafPending = true;
    const flush = () => {
      rafPending = false;
      if (disposed) {
        dirtyPanels.clear();
        return;
      }
      const list = Array.from(dirtyPanels);
      dirtyPanels.clear();
      for (const item of list) {
        renderPanel(item);
      }
    };
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 0);
    }
  }

  function clearSegmentElements(el) {
    if (!el) return;
    while (el.firstChild) {
      if (typeof el.firstChild.remove === 'function') {
        el.firstChild.remove();
      } else if (Array.isArray(el.children)) {
        el.children.length = 0;
        break;
      } else {
        break;
      }
    }
  }

  function appendTokenizedSegmentContent(pEl, text, bodyEl) {
    clearSegmentElements(pEl);
    const tokens = tokenizeTextWithFileLinks(text);
    if (tokens.length === 0) {
      pEl.textContent = text;
      return;
    }
    for (const tok of tokens) {
      if (tok.type === 'text') {
        if (typeof doc.createTextNode === 'function') {
          pEl.appendChild(doc.createTextNode(tok.text));
        } else {
          const span = doc.createElement('span');
          span.textContent = tok.text;
          pEl.appendChild(span);
        }
      } else if (tok.type === 'file-link') {
        const a = doc.createElement('a');
        a.className = 'agy-cot-file-link';
        a.setAttribute('href', tok.uri);
        a.setAttribute('data-agy-file-uri', tok.uri);
        a.setAttribute('data-file-path', tok.path);
        a.setAttribute('data-file-line', String(tok.line));
        if (tok.endLine) a.setAttribute('data-file-end-line', String(tok.endLine));
        a.setAttribute('title', `点击定位源码: ${tok.path}#L${tok.line}`);
        a.textContent = tok.label;
        a.addEventListener('click', (ev) => {
          ev?.preventDefault?.();
          ev?.stopPropagation?.();
          a.setAttribute('data-jumped', 'true');
          void handleFileLinkClick(tok, bodyEl);
        });
        pEl.appendChild(a);
      }
    }
  }

  async function handleFileLinkClick(tok, bodyEl) {
    if (onOpenFile) {
      try { await onOpenFile(tok, bodyEl); } catch {}
    }
    if (ctx?.bridge?.post) {
      try {
        const res = await ctx.bridge.post('/cot/open-file', {
          uri: tok.uri,
          path: tok.path,
          line: tok.line,
          endLine: tok.endLine
        });
        if (res?.ok && res.method === 'uri-fallback') {
          const nativeAnchors = bodyEl?.querySelectorAll?.('[data-uri], a[href^="file://"]') || [];
          let clickedNative = false;
          for (const na of nativeAnchors) {
            const naUri = na.getAttribute?.('data-uri') || na.getAttribute?.('href') || '';
            if (naUri && (naUri === tok.uri || naUri.includes(tok.path))) {
              if (typeof na.click === 'function') {
                na.click();
                clickedNative = true;
                break;
              }
            }
          }
          if (!clickedNative && res.editorUri && typeof globalThis.open === 'function') {
            globalThis.open(res.editorUri, '_blank', 'noopener,noreferrer');
          }
        }
        return res;
      } catch {}
    }
    return { ok: false };
  }

  function applyBodyVisibility(rec, cfg) {
    if (!rec || !rec.bodyEl) return;
    const displayMode = normalizeThinkingDisplayMode(cfg.thinkingDisplayMode);
    if (displayMode === THINKING_DISPLAY_MODES.TRANSLATED) {
      if (!rec.bodyHidden) {
        rec.origBodyDisplay = getElementDisplaySafe(rec.bodyEl);
        setElementDisplaySafe(rec.bodyEl, 'none');
        rec.bodyHidden = true;
      }
    } else if (rec.bodyHidden) {
      setElementDisplaySafe(rec.bodyEl, rec.origBodyDisplay || '');
      rec.bodyHidden = false;
    }
  }

  function restoreBodyVisibility(rec) {
    if (!rec || !rec.bodyEl) return;
    if (rec.bodyHidden) {
      setElementDisplaySafe(rec.bodyEl, rec.origBodyDisplay || '');
      rec.bodyHidden = false;
    }
  }

  function cancelRecordJobs(rec) {
    if (!rec) return;
    if (rec.debounceTimer) {
      clearTimeout(rec.debounceTimer);
      rec.debounceTimer = null;
    }
    for (const seg of rec.segments) {
      if (seg.cancelPoll) {
        try { seg.cancelPoll(); } catch {}
        seg.cancelPoll = null;
      }
    }
  }

  function destroyRecord(bodyEl) {
    const rec = records.get(bodyEl);
    if (!rec) return;
    records.delete(bodyEl);
    dirtyPanels.delete(rec);
    cancelRecordJobs(rec);
    restoreBodyVisibility(rec);
    if (rec.panelEl && typeof rec.panelEl.remove === 'function') {
      try { rec.panelEl.remove(); } catch {}
    }
  }

  function createPanelForRecord(bodyEl) {
    const panelEl = doc.createElement('div');
    panelEl.className = 'agy-cot-panel';
    panelEl.setAttribute('data-agy-cot-panel', '1');
    panelEl.setAttribute('data-agy-no-translate', '1');

    const headerEl = doc.createElement('div');
    headerEl.className = 'agy-cot-header';

    const leftEl = doc.createElement('div');
    leftEl.className = 'agy-cot-header-left';
    const badgeEl = doc.createElement('span');
    badgeEl.className = 'agy-cot-badge';
    badgeEl.setAttribute('data-cot-badge', '1');
    const statusEl = doc.createElement('span');
    statusEl.className = 'agy-cot-status';
    statusEl.setAttribute('data-cot-status', '1');
    leftEl.appendChild(badgeEl);
    leftEl.appendChild(statusEl);

    const actionsEl = doc.createElement('div');
    actionsEl.className = 'agy-cot-actions';
    const toggleBtn = doc.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'agy-cot-btn';
    toggleBtn.setAttribute('data-cot-display-toggle', '1');
    actionsEl.appendChild(toggleBtn);

    headerEl.appendChild(leftEl);
    headerEl.appendChild(actionsEl);

    const contentEl = doc.createElement('div');
    contentEl.className = 'agy-cot-body';
    contentEl.setAttribute('data-cot-body', '1');

    panelEl.appendChild(headerEl);
    panelEl.appendChild(contentEl);

    const parent = bodyEl.parentElement;
    if (parent) {
      const nextSib = getNextElementSibling(bodyEl);
      if (nextSib && typeof parent.insertBefore === 'function') {
        parent.insertBefore(panelEl, nextSib);
      } else if (typeof parent.appendChild === 'function') {
        parent.appendChild(panelEl);
      }
    }

    const rec = {
      bodyEl,
      triggerEl: null,
      panelEl,
      badgeEl,
      statusEl,
      toggleBtn,
      contentEl,
      bodyHidden: false,
      origBodyDisplay: '',
      segments: [],
      pEls: [],
      debounceTimer: null
    };

    toggleBtn.addEventListener('click', () => {
      const cfg = getConfig();
      const cur = normalizeThinkingDisplayMode(cfg.thinkingDisplayMode);
      const next = cur === THINKING_DISPLAY_MODES.TRANSLATED
        ? THINKING_DISPLAY_MODES.BILINGUAL
        : THINKING_DISPLAY_MODES.TRANSLATED;
      applyBodyVisibility(rec, { ...cfg, thinkingDisplayMode: next });
      renderHeader(rec, { ...cfg, thinkingDisplayMode: next });
      if (ctx?.settings?.update) {
        void ctx.settings.update({ thinkingDisplayMode: next }).catch(() => {});
      }
    });

    records.set(bodyEl, rec);
    return rec;
  }

  function renderHeader(rec, cfg) {
    const mode = normalizeThinkingTranslationMode(cfg.thinkingTranslationMode, cfg.enableRemoteThinkingTranslation);
    const displayMode = normalizeThinkingDisplayMode(cfg.thinkingDisplayMode);
    const modeText = mode === THINKING_TRANSLATION_MODES.CUSTOM_API ? 'AI 流式转译' : '免配置机翻';
    const displayText = displayMode === THINKING_DISPLAY_MODES.TRANSLATED ? '纯译文' : '双语对照';
    rec.badgeEl.textContent = `${modeText} · ${displayText}`;
    rec.panelEl.setAttribute('data-cot-mode', mode);
    rec.panelEl.setAttribute('data-cot-display', displayMode);
    rec.toggleBtn.textContent = displayMode === THINKING_DISPLAY_MODES.TRANSLATED ? '切换双语对照' : '切换纯译文';

    const hasStreaming = rec.segments.some((s) => s.status === 'streaming');
    const hasError = rec.segments.some((s) => s.status === 'error');
    if (hasStreaming) {
      rec.statusEl.textContent = '流式转译中…';
    } else if (hasError) {
      rec.statusEl.textContent = '部分段落转译失败';
    } else if (rec.segments.length > 0) {
      rec.statusEl.textContent = '已转译';
    } else {
      rec.statusEl.textContent = '';
    }
  }

  function renderPanel(rec) {
    if (disposed || !rec || !rec.panelEl) return;
    const cfg = getConfig();
    applyBodyVisibility(rec, cfg);
    renderHeader(rec, cfg);

    // Grow or shrink paragraph slots minimally to avoid full subtree teardown
    while (rec.pEls.length < rec.segments.length) {
      const pEl = doc.createElement('p');
      pEl.className = 'agy-cot-segment';
      rec.contentEl.appendChild(pEl);
      rec.pEls.push(pEl);
    }
    while (rec.pEls.length > rec.segments.length) {
      const dead = rec.pEls.pop();
      if (dead?.remove) dead.remove();
    }

    for (let i = 0; i < rec.segments.length; i++) {
      const seg = rec.segments[i];
      const pEl = rec.pEls[i];
      const displayStr = seg.translatedText || (seg.status === 'error' ? `[转译失败] ${seg.sourceText}` : '正在转译…');
      const renderKey = `${seg.status}::${displayStr}`;
      if (seg.lastRenderedKey === renderKey) continue;
      seg.lastRenderedKey = renderKey;
      pEl.setAttribute('data-state', seg.status);
      appendTokenizedSegmentContent(pEl, displayStr, rec.bodyEl);
    }
  }

  async function translateSegment(rec, seg, cfg) {
    if (disposed || !ctx?.bridge?.post) return;
    let cancelled = false;
    const cancelFn = () => {
      cancelled = true;
      if (seg.jobId) {
        void ctx.bridge.post('/cot/cancel', { jobId: seg.jobId }).catch(() => {});
      }
    };
    seg.cancelPoll = cancelFn;
    activePollCancels.add(cancelFn);

    try {
      const startRes = await ctx.bridge.post('/cot/translate', {
        text: seg.sourceText,
        targetLang: cfg.lang || 'zh',
        mode: normalizeThinkingTranslationMode(cfg.thinkingTranslationMode, cfg.enableRemoteThinkingTranslation),
        initialWaitMs: 80
      });
      if (cancelled || disposed) return;
      if (!startRes || startRes.ok === false) {
        seg.status = 'error';
        seg.error = startRes?.error || startRes?.reason || 'TRANSLATE_FAILED';
        scheduleRender(rec);
        return;
      }
      if (typeof startRes.translatedText === 'string' && startRes.translatedText) {
        seg.translatedText = startRes.translatedText;
      }
      if (startRes.done) {
        seg.status = 'done';
        scheduleRender(rec);
        return;
      }
      seg.jobId = startRes.jobId;
      let cursor = Number(startRes.cursor) || 0;
      scheduleRender(rec);

      while (!cancelled && !disposed && seg.jobId) {
        const pollRes = await ctx.bridge.post('/cot/poll', {
          jobId: seg.jobId,
          cursor,
          waitMs: 300
        });
        if (cancelled || disposed) return;
        if (!pollRes || pollRes.ok === false) {
          seg.status = 'error';
          seg.error = pollRes?.error || 'POLL_FAILED';
          scheduleRender(rec);
          return;
        }
        if (typeof pollRes.translatedText === 'string' && pollRes.translatedText) {
          seg.translatedText = pollRes.translatedText;
        }
        cursor = Number(pollRes.cursor) || cursor;
        if (pollRes.done) {
          seg.status = pollRes.status === 'error' ? 'error' : 'done';
          scheduleRender(rec);
          return;
        }
        scheduleRender(rec);
      }
    } catch (err) {
      if (!cancelled && !disposed) {
        seg.status = 'error';
        seg.error = err?.message || String(err);
        scheduleRender(rec);
      }
    } finally {
      activePollCancels.delete(cancelFn);
      if (seg.cancelPoll === cancelFn) seg.cancelPoll = null;
    }
  }

  function syncThinkingBlock(bodyEl, triggerEl, cfg) {
    if (!bodyEl || isInIgnoredHostTree(bodyEl)) return;
    const expanded = isTriggerExpanded(triggerEl, bodyEl);
    if (!expanded) {
      destroyRecord(bodyEl);
      return;
    }
    const sourceText = extractBodySourceText(bodyEl);
    if (!sourceText) {
      destroyRecord(bodyEl);
      return;
    }

    ensureStylesInjected();
    const rec = records.get(bodyEl) || createPanelForRecord(bodyEl);
    rec.triggerEl = triggerEl || rec.triggerEl;

    const mode = normalizeThinkingTranslationMode(cfg.thinkingTranslationMode, cfg.enableRemoteThinkingTranslation);
    const targetLang = cfg.lang || 'zh';
    const modelKey = mode === THINKING_TRANSLATION_MODES.CUSTOM_API ? String(cfg.thinkingApiModel || '') : 'mt';
    const rawSegs = parseThinkingSegments(sourceText);

    const prevSegments = rec.segments;
    const nextSegments = [];
    let changed = prevSegments.length !== rawSegs.length;

    for (let i = 0; i < rawSegs.length; i++) {
      const segText = rawSegs[i];
      const segKey = hashCotKey(`${mode}::${targetLang}::${modelKey}::${segText}`);
      const prev = prevSegments[i];
      if (prev && prev.segKey === segKey) {
        nextSegments.push(prev);
        continue;
      }
      changed = true;
      if (prev && prev.cancelPoll) {
        try { prev.cancelPoll(); } catch {}
      }
      nextSegments.push({
        segKey,
        sourceText: segText,
        translatedText: '',
        status: 'streaming',
        jobId: null,
        cancelPoll: null,
        lastRenderedKey: ''
      });
    }

    for (let i = rawSegs.length; i < prevSegments.length; i++) {
      if (prevSegments[i]?.cancelPoll) {
        try { prevSegments[i].cancelPoll(); } catch {}
      }
    }

    rec.segments = nextSegments;
    applyBodyVisibility(rec, cfg);
    if (changed) {
      scheduleRender(rec);
    } else {
      renderHeader(rec, cfg);
    }

    // Start finalized earlier segments immediately
    for (let i = 0; i < nextSegments.length - 1; i++) {
      const seg = nextSegments[i];
      if (seg.status === 'streaming' && !seg.cancelPoll && !seg.jobId) {
        void translateSegment(rec, seg, cfg);
      }
    }

    // Trailing segment: short debounce so live host streaming does not flood requests
    const lastSeg = nextSegments[nextSegments.length - 1];
    if (lastSeg && lastSeg.status === 'streaming' && !lastSeg.cancelPoll && !lastSeg.jobId) {
      if (rec.debounceTimer) clearTimeout(rec.debounceTimer);
      if (trailingDebounceMs === 0) {
        void translateSegment(rec, lastSeg, cfg);
      } else {
        rec.debounceTimer = setTimeout(() => {
          rec.debounceTimer = null;
          if (!disposed && rec.segments.includes(lastSeg) && lastSeg.status === 'streaming' && !lastSeg.cancelPoll) {
            void translateSegment(rec, lastSeg, getConfig());
          }
        }, trailingDebounceMs);
      }
    }
  }

  function scanNow() {
    if (disposed || !doc) return;
    const cfg = getConfig();
    const mode = normalizeThinkingTranslationMode(cfg.thinkingTranslationMode, cfg.enableRemoteThinkingTranslation);
    if (cfg.lang === 'en' || mode === THINKING_TRANSLATION_MODES.OFF) {
      clearAll();
      return;
    }

    const discovered = new Map(); // bodyEl -> triggerEl
    const triggers = [
      ...(ctx?.anchors?.queryAll?.('chat.thinkingTrigger') || []),
      ...(doc.querySelectorAll?.('[data-testid="thinking-collapsible-trigger"], [data-testid="worked-for-collapsible"]') || [])
    ];
    for (const trig of triggers) {
      if (!trig || isInIgnoredHostTree(trig)) continue;
      const bodyEl = findBodyForTrigger(doc, trig);
      if (bodyEl && !discovered.has(bodyEl)) {
        discovered.set(bodyEl, trig);
      }
    }

    const standaloneBodies = doc.querySelectorAll?.(
      '[data-testid="thinking-content"], [data-testid="thought-content"], [data-agy-thinking-body], .thinking-content, .thought-content'
    ) || [];
    for (const bodyEl of standaloneBodies) {
      if (!bodyEl || isInIgnoredHostTree(bodyEl)) continue;
      if (!discovered.has(bodyEl)) discovered.set(bodyEl, null);
    }

    for (const existingBody of Array.from(records.keys())) {
      if (!discovered.has(existingBody) || existingBody.isConnected === false) {
        destroyRecord(existingBody);
      }
    }

    for (const [bodyEl, trigEl] of discovered.entries()) {
      syncThinkingBlock(bodyEl, trigEl, cfg);
    }
  }

  function scheduleScan(delayMs = 30) {
    if (disposed) return;
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanNow();
    }, delayMs);
  }

  function clearAll() {
    if (scanTimer !== null) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    for (const bodyEl of Array.from(records.keys())) {
      destroyRecord(bodyEl);
    }
    for (const cancelFn of Array.from(activePollCancels)) {
      try { cancelFn(); } catch {}
    }
    activePollCancels.clear();
    dirtyPanels.clear();
    removeStylesInjected();
  }

  function dispose() {
    disposed = true;
    clearAll();
  }

  return {
    scanNow,
    scheduleScan,
    clearAll,
    dispose,
    getActivePanelCount: () => records.size
  };
}

module.exports = {
  COT_OVERLAY_STYLES,
  createCotOverlayController
};
