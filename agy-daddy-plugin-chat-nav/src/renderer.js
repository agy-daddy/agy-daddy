'use strict';

const { CHAT_NAV_STYLES } = require('./styles');
const { createCodeBlockEnhancer } = require('./code-block-enhancer');
const { isEditableElement, createOutlineRail } = require('./outline-rail');

const DEFAULT_SETTINGS = Object.freeze({
  showFloatDock: true,
  keepThinkingExpanded: false,
  enableInlineFileEditor: true,
  enableCmdClickLinks: true,
  enableCodeBlockSticky: true,
  enableCodeBlockFold: true,
  codeFoldMinLines: 48,
  showOutlineRail: true,
  enableTurnShortcuts: true,
  searchRegexMode: false,
  searchCaseSensitive: false,
  exportSaveBehavior: 'dialog',
  exportSaveDir: '',
  exportFormats: ['md']
});

const EXPORT_FORMAT_META = Object.freeze({
  md: { id: 'md', label: 'Markdown', ext: '.md' },
  html: { id: 'html', label: '网页 HTML', ext: '.html' },
  pdf: { id: 'pdf', label: 'PDF 文档', ext: '.pdf' }
});

function normalizeExportFormats(raw) {
  const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    let val = '';
    if (typeof item === 'string') val = item.trim();
    else if (item && typeof item === 'object') val = String(item.id || item.value || '').trim();
    const norm = val.toLowerCase() === 'markdown' ? 'md' : val.toLowerCase();
    if (!EXPORT_FORMAT_META[norm] || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.length > 0 ? out : ['md'];
}

function normalizeRendererSettings(raw = {}) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(raw && typeof raw === 'object' ? raw : {})
  };
  const minLines = Number(merged.codeFoldMinLines);
  merged.codeFoldMinLines = Number.isFinite(minLines) && minLines >= 12 ? Math.min(500, Math.round(minLines)) : 48;
  merged.enableCodeBlockSticky = merged.enableCodeBlockSticky !== false;
  merged.enableCodeBlockFold = merged.enableCodeBlockFold !== false;
  merged.showOutlineRail = merged.showOutlineRail !== false;
  merged.enableTurnShortcuts = merged.enableTurnShortcuts !== false;
  merged.exportSaveBehavior = merged.exportSaveBehavior === 'direct' ? 'direct' : 'dialog';
  merged.exportSaveDir = typeof merged.exportSaveDir === 'string' ? merged.exportSaveDir.trim() : '';
  merged.exportFormats = normalizeExportFormats(merged.exportFormats);
  return merged;
}

function createSearchMatcher(query, regexMode, caseSensitive) {
  const q = String(query || '').trim();
  if (!q) return null;
  if (regexMode) {
    try {
      const re = new RegExp(q, caseSensitive ? '' : 'i');
      return (txt) => re.test(txt);
    } catch {
      return () => false;
    }
  }
  const needle = caseSensitive ? q : q.toLowerCase();
  return (txt) => (caseSensitive ? txt.includes(needle) : txt.toLowerCase().includes(needle));
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findRangesInText(text, query, regexMode, caseSensitive, maxHits = 2000) {
  const q = String(query || '').trim();
  if (!q || !text) return [];
  let re;
  try {
    const source = regexMode ? q : escapeRegExp(q);
    re = new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch {
    return [];
  }
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
    if (out.length >= maxHits) break;
  }
  return out;
}

const NAV_ICONS = Object.freeze({
  top: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14"/><path d="M12 19V9"/><path d="m7 14 5-5 5 5"/></svg>',
  prev: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>',
  next: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  bottom: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19h14"/><path d="M12 5v10"/><path d="m7 10 5 5 5-5"/></svg>',
  think: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  copyId: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  exportMd: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
});

let disposers = [];

function isSafeExternalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (typeof URL === 'function') {
    try {
      const u = new URL(trimmed);
      return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
    } catch {
      return false;
    }
  }
  return /^(?:https?:\/\/[^\s/$.?#][^\s]*|mailto:[^\s@]+@[^\s@]+)$/i.test(trimmed);
}

async function mount(ctx, options = {}) {
  let settings = normalizeRendererSettings(ctx.settings?.get?.() || {});

  const stopStyles = ctx.styles?.inject?.(CHAT_NAV_STYLES, {
    scope: 'document',
    id: 'chat-nav-styles'
  });

  const doc = options.document
    || ctx.anchors.query('chat.scrollViewport')?.ownerDocument
    || ctx.anchors.query('composer.root')?.ownerDocument
    || ctx.anchors.query('sidebar.conversationRows')?.ownerDocument
    || globalThis.document;
  const win = options.window || (typeof globalThis.window !== 'undefined' ? globalThis.window : null);

  const customButtons = new Map();
  const customButtonNodes = [];
  const mountedBadges = [];
  let dockEl = null;
  let extraButtonsSlot = null;
  let searchSlot = null;
  let searchBoxEl = null;
  let searchInputEl = null;
  let searchCountEl = null;
  let searchPrevBtn = null;
  let searchNextBtn = null;
  let searchToggleBtn = null;
  let thinkBtn = null;
  let copyIdBtn = null;
  let exportBtnEl = null;
  let exportMenuEl = null;
  let exportMenuOpen = false;
  let toastEl = null;
  let toastTimer = null;
  let copyFeedbackTimer = null;
  let exportLoading = false;
  let latestContextCascadeId = null;
  let searchOpen = false;
  let searchMatches = [];
  let searchMode = 'block';
  let searchActiveIdx = -1;
  let lastSearchQuery = '';
  let thinkingToggleFallback = false;
  let pendingThinkTimer = null;
  let lastTurnNav = null;
  let dockResizeObserver = null;
  let observedAreaEl = null;
  let dockRafId = null;
  let dockRafUsingTimeout = false;
  let onSearchSlotKeyDown = null;
  let revokeNavButtonsSurface = null;
  let editorControlEl = null;
  let editorPanelEl = null;
  let editorTextareaEl = null;
  let activeEditorPath = '';
  let activeConvIndex = 0;
  let codeBlockEnhancer = null;
  let outlineRail = null;

  function clearNodes(list) {
    while (list.length > 0) {
      const node = list.pop();
      if (node?.remove) node.remove();
    }
  }

  function cancelScheduledSync() {
    if (dockRafId !== null) {
      if (dockRafUsingTimeout) {
        clearTimeout(dockRafId);
      } else if (win && typeof win.cancelAnimationFrame === 'function') {
        try { win.cancelAnimationFrame(dockRafId); } catch {}
      } else if (typeof globalThis.cancelAnimationFrame === 'function') {
        try { globalThis.cancelAnimationFrame(dockRafId); } catch {}
      }
      dockRafId = null;
      dockRafUsingTimeout = false;
    }
  }

  function clearPendingThinkTimer() {
    if (pendingThinkTimer !== null) {
      clearTimeout(pendingThinkTimer);
      pendingThinkTimer = null;
    }
  }

  function clearToastTimer() {
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  function clearCopyFeedbackTimer() {
    if (copyFeedbackTimer !== null) {
      clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = null;
    }
  }

  function showDockToast(message, opts = {}) {
    clearToastTimer();
    const msg = String(message || '').trim();
    if (!toastEl) return;
    if (!msg) {
      toastEl.textContent = '';
      toastEl.hidden = true;
      toastEl.setAttribute?.('hidden', 'true');
      toastEl.removeAttribute?.('data-tone');
      return;
    }
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.removeAttribute?.('hidden');
    if (toastEl.style) toastEl.style.display = '';
    if (opts.tone) toastEl.setAttribute?.('data-tone', opts.tone);
    else toastEl.removeAttribute?.('data-tone');
    if (!opts.persistent) {
      toastTimer = setTimeout(() => {
        toastTimer = null;
        showDockToast('');
      }, Number(opts.durationMs) > 0 ? Number(opts.durationMs) : 2600);
    }
  }

  async function copyTextToClipboard(text) {
    const str = String(text ?? '');
    if (!str) return false;
    if (typeof options.copyText === 'function') {
      const res = await options.copyText(str);
      return res !== false;
    }
    const nav = win?.navigator || doc?.defaultView?.navigator || globalThis.navigator;
    if (typeof nav?.clipboard?.writeText === 'function') {
      try {
        await nav.clipboard.writeText(str);
        return true;
      } catch {}
    }
    if (typeof doc?.createElement === 'function' && typeof doc?.execCommand === 'function' && doc?.body) {
      try {
        const ta = doc.createElement('textarea');
        ta.value = str;
        if (ta.style) {
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          ta.style.pointerEvents = 'none';
        }
        doc.body.appendChild(ta);
        ta.focus?.();
        ta.select?.();
        const ok = Boolean(doc.execCommand('copy'));
        ta.remove?.();
        if (ok) return true;
      } catch {}
    }
    return false;
  }

  function collectDomMessages() {
    const scope = ctx.anchors.query('chat.scrollViewport') || doc;
    if (typeof scope?.querySelectorAll !== 'function') return [];
    const nodes = Array.from(scope.querySelectorAll('[data-testid="user-message"], [data-testid="agent-response"]') || []);
    const out = [];
    for (const node of nodes) {
      const text = String(node?.innerText || node?.textContent || '').trim();
      if (!text) continue;
      const tid = node.getAttribute?.('data-testid');
      out.push({
        role: tid === 'user-message' ? 'user' : 'assistant',
        text
      });
    }
    return out;
  }

  async function resolveSessionId() {
    const fromOpt = typeof options.getSessionId === 'function' ? String(options.getSessionId() || '').trim() : '';
    if (fromOpt) return fromOpt;
    const fromHostDom = String(ctx.hostDom?.getSessionId?.() || '').trim();
    if (fromHostDom) return fromHostDom;
    if (latestContextCascadeId) return String(latestContextCascadeId).trim();
    if (typeof ctx.bridge?.post === 'function') {
      try {
        const res = await ctx.bridge.post('/session-id', {});
        if (res?.ok && res.cascadeId) return String(res.cascadeId).trim();
      } catch {}
    }
    return '';
  }

  async function copyConversationId() {
    const cascadeId = await resolveSessionId();
    if (!cascadeId) {
      showDockToast('未检测到当前会话 ID', { tone: 'error', durationMs: 2800 });
      return { ok: false, error: 'NO_SESSION_ID' };
    }
    const copied = await copyTextToClipboard(cascadeId);
    if (copyIdBtn) {
      clearCopyFeedbackTimer();
      copyIdBtn.setAttribute?.('data-active', 'true');
      copyFeedbackTimer = setTimeout(() => {
        copyFeedbackTimer = null;
        copyIdBtn?.setAttribute?.('data-active', 'false');
      }, 1500);
    }
    const shortId = cascadeId.length > 12 ? `${cascadeId.slice(0, 8)}…` : cascadeId;
    showDockToast(copied ? `已复制会话 ID: ${shortId}` : `会话 ID: ${shortId}`);
    ctx.events?.emit?.('chat:session-id-copied@1', { cascadeId, copied });
    return { ok: true, cascadeId, copied };
  }

  function getConfiguredExportFormats() {
    return normalizeExportFormats(settings.exportFormats);
  }

  function updateExportButtonMeta() {
    if (!exportBtnEl) return;
    const formats = getConfiguredExportFormats();
    const title = formats.length > 1
      ? `导出对话 (${formats.map((f) => f.toUpperCase()).join(' / ')})`
      : `导出当前对话为 ${EXPORT_FORMAT_META[formats[0]]?.label || formats[0].toUpperCase()}`;
    exportBtnEl.setAttribute?.('title', title);
    exportBtnEl.setAttribute?.('aria-label', title);
    exportBtnEl.setAttribute?.('aria-haspopup', formats.length > 1 ? 'menu' : 'false');
    exportBtnEl.setAttribute?.('aria-expanded', exportMenuOpen ? 'true' : 'false');
    exportBtnEl.setAttribute?.('data-active', exportMenuOpen ? 'true' : 'false');
  }

  function renderExportFormatMenu() {
    if (!exportMenuEl || !doc?.createElement) return;
    while (exportMenuEl.children?.length > 0) {
      const ch = exportMenuEl.children[exportMenuEl.children.length - 1];
      if (ch?.remove) ch.remove();
      else break;
    }
    if (Array.isArray(exportMenuEl.children)) exportMenuEl.children.length = 0;

    const head = doc.createElement('div');
    head.className = 'agy-export-format-title';
    head.textContent = '选择导出格式';
    exportMenuEl.appendChild(head);

    const formats = getConfiguredExportFormats();
    for (const fmt of formats) {
      const meta = EXPORT_FORMAT_META[fmt] || { id: fmt, label: fmt.toUpperCase(), ext: `.${fmt}` };
      const itemBtn = doc.createElement('button');
      itemBtn.type = 'button';
      itemBtn.id = `agy-export-fmt-${fmt}`;
      itemBtn.setAttribute?.('data-export-format', fmt);
      itemBtn.setAttribute?.('role', 'menuitem');

      const lblSpan = doc.createElement('span');
      lblSpan.textContent = meta.label;
      const extSpan = doc.createElement('span');
      extSpan.className = 'agy-export-format-ext';
      extSpan.textContent = meta.ext;
      itemBtn.appendChild(lblSpan);
      itemBtn.appendChild(extSpan);

      itemBtn.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        setExportMenuOpen(false);
        void exportConversation({ format: fmt });
      });
      exportMenuEl.appendChild(itemBtn);
    }

    if (formats.length > 1) {
      const divider = doc.createElement('div');
      divider.className = 'agy-export-format-divider';
      divider.setAttribute?.('aria-hidden', 'true');
      exportMenuEl.appendChild(divider);

      const allBtn = doc.createElement('button');
      allBtn.type = 'button';
      allBtn.id = 'agy-export-fmt-all';
      allBtn.className = 'agy-export-format-all';
      allBtn.setAttribute?.('data-export-format', 'all');
      allBtn.setAttribute?.('role', 'menuitem');

      const allLbl = doc.createElement('span');
      allLbl.textContent = '全部保存';
      const allCount = doc.createElement('span');
      allCount.className = 'agy-export-format-ext';
      allCount.textContent = `${formats.length} 种格式`;
      allBtn.appendChild(allLbl);
      allBtn.appendChild(allCount);

      allBtn.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        setExportMenuOpen(false);
        void exportAllConversations();
      });
      exportMenuEl.appendChild(allBtn);
    }
  }

  function setExportMenuOpen(open) {
    const formats = getConfiguredExportFormats();
    const nextOpen = Boolean(open) && formats.length > 1;
    exportMenuOpen = nextOpen;
    if (nextOpen) {
      if (searchOpen) setSearchOpen(false, { silent: true, reason: 'export-menu' });
      renderExportFormatMenu();
    }
    if (exportMenuEl) {
      exportMenuEl.hidden = !nextOpen;
      if (nextOpen) exportMenuEl.removeAttribute?.('hidden');
      else exportMenuEl.setAttribute?.('hidden', 'true');
    }
    updateExportButtonMeta();
    return exportMenuOpen;
  }

  function handleExportButtonClick(e) {
    e?.stopPropagation?.();
    if (exportLoading) return;
    const formats = getConfiguredExportFormats();
    if (formats.length > 1) {
      setExportMenuOpen(!exportMenuOpen);
      return;
    }
    setExportMenuOpen(false);
    void exportConversation({ format: formats[0] });
  }

  function setExportButtonLoading(loading) {
    exportLoading = Boolean(loading);
    if (!exportBtnEl) return;
    exportBtnEl.disabled = exportLoading;
    if (exportLoading) {
      exportBtnEl.setAttribute?.('data-loading', 'true');
    } else {
      exportBtnEl.removeAttribute?.('data-loading');
    }
  }

  async function collectExportRequestMeta(exportOpts = {}) {
    const saveBehavior = (exportOpts.saveBehavior === 'dialog' || exportOpts.saveBehavior === 'direct' || exportOpts.saveBehavior === 'none')
      ? exportOpts.saveBehavior
      : (settings.exportSaveBehavior === 'direct' ? 'direct' : 'dialog');
    const cascadeId = (typeof exportOpts.cascadeId === 'string' && exportOpts.cascadeId.trim())
      ? exportOpts.cascadeId.trim()
      : await resolveSessionId();
    const domMessages = Array.isArray(exportOpts.domMessages) ? exportOpts.domMessages : collectDomMessages();
    const title = typeof exportOpts.title === 'string' && exportOpts.title.trim()
      ? exportOpts.title.trim()
      : String(doc?.title || '').trim();
    const outputDir = exportOpts.outputDir || options.exportDir || settings.exportSaveDir || undefined;
    return { saveBehavior, cascadeId, domMessages, title, outputDir };
  }

  async function exportConversation(exportOpts = {}) {
    if (exportLoading) return { ok: false, error: 'EXPORT_IN_PROGRESS' };
    setExportMenuOpen(false);
    const formats = getConfiguredExportFormats();
    const format = String(exportOpts.format || formats[0] || 'md').trim().toLowerCase();
    const saveBehaviorHint = (exportOpts.saveBehavior === 'dialog' || exportOpts.saveBehavior === 'direct' || exportOpts.saveBehavior === 'none')
      ? exportOpts.saveBehavior
      : (settings.exportSaveBehavior === 'direct' ? 'direct' : 'dialog');

    setExportButtonLoading(true);
    showDockToast(saveBehaviorHint === 'dialog' ? '正在打开保存对话框…' : '正在导出对话…', { persistent: true });
    try {
      const { saveBehavior, cascadeId, domMessages, title, outputDir } = await collectExportRequestMeta(exportOpts);

      if (typeof ctx.bridge?.post !== 'function') {
        showDockToast('导出服务不可用', { tone: 'error', durationMs: 3200 });
        return { ok: false, error: 'NO_BRIDGE' };
      }
      const res = await ctx.bridge.post('/export-md', {
        format,
        saveBehavior,
        cascadeId: cascadeId || undefined,
        title: title || undefined,
        domMessages,
        outputDir
      });
      if (res?.cancelled) {
        showDockToast('已取消导出', { durationMs: 2000 });
        return { ok: true, cancelled: true, format };
      }
      if (!res?.ok) {
        const errMsg = String(res?.error || res?.saveError || '导出对话失败');
        showDockToast(errMsg, { tone: 'error', durationMs: 3200 });
        return { ok: false, error: errMsg };
      }

      const copied = format === 'md' && res.markdown ? await copyTextToClipboard(res.markdown) : false;
      const fileName = res.filePath ? String(res.filePath).split(/[\\/]/).pop() : '';
      let toastMsg = '';
      if (res.saveError) {
        toastMsg = copied ? `已复制 Markdown，写盘失败：${res.saveError}` : `保存失败：${res.saveError}`;
        showDockToast(toastMsg, { tone: 'error', durationMs: 3600 });
      } else {
        if (fileName && copied) toastMsg = `已保存并复制：${fileName}`;
        else if (fileName) toastMsg = `已保存：${fileName}`;
        else if (copied) toastMsg = '已复制 Markdown 到剪贴板';
        else toastMsg = `已导出 ${format.toUpperCase()}`;
        showDockToast(toastMsg, { durationMs: 3000 });
      }

      ctx.events?.emit?.('chat:conversation-exported@1', {
        format,
        saveBehavior,
        cascadeId: res.cascadeId || cascadeId || null,
        filePath: res.filePath || null,
        copied
      });
      return { ...res, copied };
    } catch (err) {
      const errMsg = String(err?.message || '导出对话失败');
      showDockToast(errMsg, { tone: 'error', durationMs: 3200 });
      return { ok: false, error: errMsg };
    } finally {
      setExportButtonLoading(false);
    }
  }

  async function exportAllConversations(exportOpts = {}) {
    if (exportLoading) return { ok: false, error: 'EXPORT_IN_PROGRESS' };
    setExportMenuOpen(false);
    const formats = Array.isArray(exportOpts.formats) && exportOpts.formats.length > 0
      ? normalizeExportFormats(exportOpts.formats)
      : getConfiguredExportFormats();
    const saveBehaviorHint = (exportOpts.saveBehavior === 'dialog' || exportOpts.saveBehavior === 'direct' || exportOpts.saveBehavior === 'none')
      ? exportOpts.saveBehavior
      : (settings.exportSaveBehavior === 'direct' ? 'direct' : 'dialog');

    setExportButtonLoading(true);
    showDockToast(saveBehaviorHint === 'dialog' ? '正在选择保存文件夹…' : '正在批量导出对话…', { persistent: true });
    try {
      const { saveBehavior, cascadeId, domMessages, title, outputDir } = await collectExportRequestMeta(exportOpts);

      if (typeof ctx.bridge?.post !== 'function') {
        showDockToast('导出服务不可用', { tone: 'error', durationMs: 3200 });
        return { ok: false, error: 'NO_BRIDGE' };
      }
      const res = await ctx.bridge.post('/export-all', {
        formats,
        saveBehavior,
        cascadeId: cascadeId || undefined,
        title: title || undefined,
        domMessages,
        outputDir
      });
      if (res?.cancelled) {
        showDockToast('已取消导出', { durationMs: 2000 });
        return { ok: true, cancelled: true, formats };
      }
      if (!res?.ok) {
        const errMsg = String(res?.error || '批量导出失败');
        showDockToast(`批量导出失败：${errMsg}`, { tone: 'error', durationMs: 3600 });
        return { ...res, ok: false, error: errMsg };
      }

      const copied = formats.includes('md') && res.markdown ? await copyTextToClipboard(res.markdown) : false;
      const succeeded = Array.isArray(res.succeeded) ? res.succeeded : [];
      const failed = Array.isArray(res.failed) ? res.failed : [];
      if (res.partial && failed.length > 0) {
        const failedNames = failed.map((f) => String(f.format || '').toUpperCase()).join(' / ');
        showDockToast(`部分保存成功 (${succeeded.length}/${formats.length})，失败：${failedNames}`, { tone: 'error', durationMs: 4200 });
      } else {
        const fmtText = formats.map((f) => f.toUpperCase()).join(' / ');
        showDockToast(`已全部保存 ${succeeded.length || formats.length} 个文件（${fmtText}）`, { durationMs: 3200 });
      }

      ctx.events?.emit?.('chat:conversation-exported@1', {
        batch: true,
        formats,
        saveBehavior,
        cascadeId: res.cascadeId || cascadeId || null,
        targetDir: res.targetDir || null,
        results: res.results || [],
        copied
      });
      return { ...res, copied };
    } catch (err) {
      const errMsg = String(err?.message || '批量导出失败');
      showDockToast(`批量导出失败：${errMsg}`, { tone: 'error', durationMs: 3600 });
      return { ok: false, error: errMsg };
    } finally {
      setExportButtonLoading(false);
    }
  }

  function getRect(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    try {
      const r = el.getBoundingClientRect();
      return r || null;
    } catch {
      return null;
    }
  }

  function findChatAreaElement() {
    const vp = ctx.anchors.query('chat.scrollViewport');
    const vpRect = getRect(vp);
    if (vp && vpRect && vpRect.width > 40 && vpRect.height > 40) {
      return vp;
    }
    const conv = doc?.querySelector?.('[data-testid="conversation-view"], .agy-home');
    const convRect = getRect(conv);
    if (conv && convRect && convRect.width > 40 && convRect.height > 40) {
      return conv;
    }
    const comp = ctx.anchors.query('composer.root');
    if (!comp) return null;
    let cur = comp;
    let best = null;
    for (let i = 0; i < 12 && cur && cur !== doc?.body && cur !== doc?.documentElement; i++) {
      const curRect = getRect(cur);
      if (curRect && curRect.width > 40 && curRect.height > 40) {
        best = cur;
      }
      const parent = cur.parentElement;
      if (!parent || parent === doc?.body || parent === doc?.documentElement) break;
      const parentRect = getRect(parent);
      const baseRect = (curRect && curRect.width > 40) ? curRect : getRect(best);
      if (baseRect && parentRect && parentRect.width > 40) {
        const siblings = Array.from(parent.children || []).filter((c) => c && c !== cur);
        const hasRightPaneSibling = siblings.some((sib) => {
          const sr = getRect(sib);
          return sr && sr.width >= 80 && sr.height > 40 && sr.left >= baseRect.right - 8;
        });
        let parentIsRow = false;
        if (typeof win?.getComputedStyle === 'function') {
          try {
            const cs = win.getComputedStyle(parent);
            parentIsRow = String(cs?.display || '').includes('flex') && cs?.flexDirection !== 'column';
          } catch {}
        }
        if (hasRightPaneSibling || (parentRect.right - baseRect.right > 24 && (parentIsRow || siblings.length > 0))) {
          break;
        }
      }
      cur = parent;
    }
    return best;
  }

  function hasOpenDialog() {
    if (!doc?.querySelectorAll) return false;
    let dialogs = [];
    try {
      dialogs = Array.from(doc.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]') || []);
    } catch {
      return false;
    }
    for (const d of dialogs) {
      if (!d) continue;
      if (dockEl && (d === dockEl || dockEl.contains?.(d))) continue;
      if (d.hidden || d.getAttribute?.('aria-hidden') === 'true') continue;
      if (d.closest?.('[hidden], [aria-hidden="true"]')) continue;
      if (typeof win?.getComputedStyle === 'function') {
        try {
          const cs = win.getComputedStyle(d);
          if (cs?.display === 'none' || cs?.visibility === 'hidden' || cs?.opacity === '0') continue;
        } catch {}
      }
      return true;
    }
    return false;
  }

  function syncDockDialogLayering() {
    const open = hasOpenDialog();
    if (dockEl) {
      dockEl.setAttribute?.('data-under-dialog', open ? 'true' : 'false');
      if (open && exportMenuOpen) {
        setExportMenuOpen(false);
      }
    }
    outlineRail?.syncPosition?.();
    return open;
  }

  function syncDockPosition() {
    syncDockDialogLayering();
    outlineRail?.syncPosition?.();
    if (!dockEl) return false;
    const areaEl = findChatAreaElement();
    if (dockResizeObserver && areaEl && observedAreaEl !== areaEl) {
      if (observedAreaEl) {
        try { dockResizeObserver.unobserve(observedAreaEl); } catch {}
      }
      try {
        dockResizeObserver.observe(areaEl);
        observedAreaEl = areaEl;
      } catch {}
    }
    const rect = getRect(areaEl);
    const winW = Number(win?.innerWidth || doc?.documentElement?.clientWidth || 0);
    const winH = Number(win?.innerHeight || doc?.documentElement?.clientHeight || 0);
    if (!rect || rect.width <= 40 || rect.height <= 40 || !winW || !winH) {
      return false;
    }
    const rightPx = Math.max(6, Math.round(winW - rect.right) + 6);
    const topPx = Math.max(120, Math.min(Math.max(120, winH - 120), Math.round(rect.top + rect.height / 2)));
    if (dockEl.style) {
      dockEl.style.right = `${rightPx}px`;
      dockEl.style.top = `${topPx}px`;
      dockEl.style.setProperty?.('--agy-chat-area-width', `${Math.round(rect.width)}px`);
    }
    return true;
  }

  function scheduleSyncDockPosition() {
    if ((!dockEl && !outlineRail) || dockRafId !== null) return;
    const raf = (win && typeof win.requestAnimationFrame === 'function')
      ? win.requestAnimationFrame.bind(win)
      : (typeof globalThis.requestAnimationFrame === 'function' ? globalThis.requestAnimationFrame : null);
    if (raf) {
      dockRafUsingTimeout = false;
      dockRafId = raf(() => {
        dockRafId = null;
        dockRafUsingTimeout = false;
        syncDockPosition();
      });
    } else {
      dockRafUsingTimeout = true;
      dockRafId = setTimeout(() => {
        dockRafId = null;
        dockRafUsingTimeout = false;
        syncDockPosition();
      }, 16);
    }
  }

  function getHighlightsApi() {
    const view = doc?.defaultView || win || globalThis;
    const HighlightCtor = view?.Highlight || globalThis.Highlight;
    const cssHighlights = view?.CSS?.highlights || globalThis.CSS?.highlights;
    if (typeof HighlightCtor === 'function' && cssHighlights) {
      return { HighlightCtor, cssHighlights };
    }
    return null;
  }

  function updateSearchNavButtonsState() {
    const disabled = searchMatches.length === 0;
    if (searchPrevBtn) searchPrevBtn.disabled = disabled;
    if (searchNextBtn) searchNextBtn.disabled = disabled;
  }

  function clearHighlights() {
    for (const m of searchMatches) {
      const el = m?.blockEl || m?.el || m;
      if (el?.removeAttribute) el.removeAttribute('data-agy-search-hit');
      else el?.setAttribute?.('data-agy-search-hit', '');
    }
    const hl = getHighlightsApi();
    if (hl) {
      try { hl.cssHighlights.delete('agy-search-hit'); } catch {}
      try { hl.cssHighlights.delete('agy-search-active'); } catch {}
    }
    searchMatches = [];
    searchMode = 'block';
    searchActiveIdx = -1;
    if (searchCountEl) {
      searchCountEl.textContent = '0/0';
      searchCountEl.removeAttribute?.('data-empty');
    }
    updateSearchNavButtonsState();
  }

  function focusMatch(idx) {
    if (!searchMatches.length) return -1;
    searchActiveIdx = (idx + searchMatches.length) % searchMatches.length;
    if (searchMode === 'range') {
      for (const m of searchMatches) {
        m.blockEl?.removeAttribute?.('data-agy-search-hit');
      }
      searchMatches[searchActiveIdx].blockEl?.setAttribute?.('data-agy-search-hit', 'active');
      const hl = getHighlightsApi();
      if (hl && searchMatches[searchActiveIdx].range) {
        try {
          hl.cssHighlights.set('agy-search-active', new hl.HighlightCtor(searchMatches[searchActiveIdx].range));
        } catch {}
      }
    } else {
      for (let i = 0; i < searchMatches.length; i++) {
        const el = searchMatches[i].el || searchMatches[i];
        el?.setAttribute?.('data-agy-search-hit', i === searchActiveIdx ? 'active' : 'hit');
      }
    }

    const cur = searchMatches[searchActiveIdx];
    const targetEl = cur.blockEl || cur.el || cur;
    const vp = ctx.anchors.query('chat.scrollViewport');
    const vpRect = getRect(vp);
    if (vp && vpRect && vpRect.height > 0) {
      const rangeRect = typeof cur.range?.getBoundingClientRect === 'function' ? cur.range.getBoundingClientRect() : null;
      const elRect = getRect(targetEl);
      const targetRect = (rangeRect && (rangeRect.height > 0 || rangeRect.width > 0)) ? rangeRect : elRect;
      if (targetRect && (targetRect.height > 0 || targetRect.width > 0)) {
        const targetTop = Math.max(
          0,
          Number(vp.scrollTop || 0) + (targetRect.top - vpRect.top) - vpRect.height / 2 + targetRect.height / 2
        );
        scrollViewportTo(vp, targetTop);
      } else if (typeof targetEl?.scrollIntoView === 'function') {
        try { targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
      }
    } else if (typeof targetEl?.scrollIntoView === 'function') {
      try { targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch {}
    } else if (vp) {
      vp.scrollTop = searchActiveIdx * 180;
    }

    if (searchCountEl) {
      searchCountEl.textContent = `${searchActiveIdx + 1}/${searchMatches.length}`;
      searchCountEl.removeAttribute?.('data-empty');
    }
    updateSearchNavButtonsState();
    return searchActiveIdx;
  }

  function runSearch(query) {
    lastSearchQuery = String(query || '');
    clearHighlights();
    const trimmed = lastSearchQuery.trim();
    if (!trimmed) {
      ctx.state?.set?.('state:chat-nav.search@1', { query: '', total: 0 });
      return 0;
    }

    const vp = ctx.anchors.query('chat.scrollViewport');
    const msgNodes = vp?.querySelectorAll
      ? Array.from(vp.querySelectorAll('[data-testid="user-message"], [data-testid="agent-response"]') || [])
      : [];
    const canWalk = msgNodes.length > 0 && typeof doc?.createTreeWalker === 'function' && typeof doc?.createRange === 'function';

    if (canWalk) {
      searchMode = 'range';
      const showText = globalThis.NodeFilter?.SHOW_TEXT ?? 4;
      const maxHits = 2000;
      for (const msg of msgNodes) {
        if (searchMatches.length >= maxHits) break;
        const walker = doc.createTreeWalker(msg, showText);
        let textNode;
        while ((textNode = walker.nextNode())) {
          const parentEl = textNode.parentElement;
          if (!parentEl) continue;
          if (parentEl.closest?.('style, script, noscript, [data-find-ignore="true"], .sr-only, [hidden], #agy-chat-search-box, #agy-chat-nav-float')) {
            continue;
          }
          const val = textNode.nodeValue || '';
          const hitRanges = findRangesInText(val, trimmed, settings.searchRegexMode, settings.searchCaseSensitive, maxHits - searchMatches.length);
          for (const hr of hitRanges) {
            const range = doc.createRange();
            range.setStart(textNode, hr.start);
            range.setEnd(textNode, hr.end);
            if (typeof range.getClientRects === 'function' && range.getClientRects().length === 0) {
              continue;
            }
            const blockEl = parentEl.closest?.('[data-testid="user-message-content"], p, li, tr, pre, blockquote, h1, h2, h3, h4, h5, h6') || parentEl;
            searchMatches.push({ range, blockEl });
            if (searchMatches.length >= maxHits) break;
          }
          if (searchMatches.length >= maxHits) break;
        }
      }
      if (searchMatches.length > 0) {
        const hl = getHighlightsApi();
        if (hl) {
          try {
            hl.cssHighlights.set('agy-search-hit', new hl.HighlightCtor(...searchMatches.map((m) => m.range)));
          } catch {}
        }
      }
    } else {
      searchMode = 'block';
      const fn = createSearchMatcher(trimmed, settings.searchRegexMode, settings.searchCaseSensitive);
      if (fn) {
        const ml = ctx.anchors.query('chat.messageList');
        const listEl = (ml && ml.children && ml.children.length > 0) ? ml : vp;
        const candidates = msgNodes.length > 0 ? msgNodes : (listEl?.children || []);
        for (const node of candidates) {
          if (!node || node === searchBoxEl || node.id === 'agy-chat-search-box' || node.id === 'agy-chat-nav-float') continue;
          const txt = String(node.textContent || '');
          if (fn(txt)) {
            node.setAttribute?.('data-agy-search-hit', 'hit');
            searchMatches.push({ el: node, blockEl: node });
          }
        }
      }
    }

    ctx.state?.set?.('state:chat-nav.search@1', { query: lastSearchQuery, total: searchMatches.length });
    if (searchMatches.length > 0) {
      focusMatch(0);
    } else {
      if (searchCountEl) {
        searchCountEl.textContent = '0/0';
        searchCountEl.setAttribute?.('data-empty', 'true');
      }
      updateSearchNavButtonsState();
    }
    return searchMatches.length;
  }

  function clearAndClose(reason = 'close-button') {
    if (searchInputEl) searchInputEl.value = '';
    lastSearchQuery = '';
    clearHighlights();
    ctx.state?.set?.('state:chat-nav.search@1', { query: '', total: 0 });
    setSearchOpen(false, { reason });
  }

  function setSearchOpen(open, opts = {}) {
    const nextOpen = Boolean(open);
    const silent = Boolean(opts.silent);
    const reason = opts.reason || 'toggle';
    searchOpen = nextOpen;
    if (searchSlot) {
      searchSlot.className = nextOpen ? 'agy-search-open' : 'agy-search-collapsed';
    }
    if (searchToggleBtn) {
      searchToggleBtn.setAttribute?.('data-active', nextOpen ? 'true' : 'false');
      searchToggleBtn.setAttribute?.('aria-expanded', nextOpen ? 'true' : 'false');
    }
    if (nextOpen) {
      searchInputEl?.focus?.();
      searchInputEl?.select?.();
      if (searchInputEl?.value) {
        runSearch(searchInputEl.value);
      }
      if (!silent) {
        ctx.events?.emit?.('chat:search-opened@1', { reason });
      }
    } else {
      clearHighlights();
      if (!silent) {
        ctx.events?.emit?.('chat:search-closed@1', { reason });
      }
    }
    return searchOpen;
  }

  function buildBuiltinSearchBox() {
    const box = doc.createElement('div');
    box.id = 'agy-chat-search-box';

    const inp = doc.createElement('input');
    inp.id = 'agy-chat-search-input';
    inp.type = 'text';
    inp.placeholder = '搜索对话...';
    inp.className = 'settings-input';
    inp.addEventListener('change', () => runSearch(inp.value));
    inp.addEventListener('input', () => runSearch(inp.value));
    inp.addEventListener('keydown', (e) => {
      if (!e) return;
      if (e.key === 'Enter') {
        e.preventDefault?.();
        if (searchMatches.length > 0) {
          focusMatch(e.shiftKey ? searchActiveIdx - 1 : searchActiveIdx + 1);
        } else if (inp.value) {
          runSearch(inp.value);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault?.();
        e.stopPropagation?.();
        clearAndClose('escape');
      }
    });
    box.appendChild(inp);

    const prevBtn = doc.createElement('button');
    prevBtn.type = 'button';
    prevBtn.id = 'agy-chat-search-prev';
    prevBtn.disabled = true;
    prevBtn.setAttribute('aria-label', '上一条匹配');
    prevBtn.setAttribute('title', '上一条匹配 (Shift+Enter)');
    prevBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';
    prevBtn.addEventListener('click', () => focusMatch(searchActiveIdx - 1));
    box.appendChild(prevBtn);

    const nextBtn = doc.createElement('button');
    nextBtn.type = 'button';
    nextBtn.id = 'agy-chat-search-next';
    nextBtn.disabled = true;
    nextBtn.setAttribute('aria-label', '下一条匹配');
    nextBtn.setAttribute('title', '下一条匹配 (Enter)');
    nextBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    nextBtn.addEventListener('click', () => focusMatch(searchActiveIdx + 1));
    box.appendChild(nextBtn);

    const countEl = doc.createElement('span');
    countEl.id = 'agy-chat-search-count';
    countEl.textContent = '0/0';
    box.appendChild(countEl);

    const clearBtn = doc.createElement('button');
    clearBtn.type = 'button';
    clearBtn.id = 'agy-chat-search-clear';
    clearBtn.setAttribute('aria-label', '关闭搜索');
    clearBtn.setAttribute('title', '清除并关闭搜索 (Esc)');
    clearBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    clearBtn.addEventListener('click', () => {
      clearAndClose('close-button');
    });
    box.appendChild(clearBtn);

    return { box, inp, countEl, prevBtn, nextBtn };
  }

  function teardownDock() {
    cancelScheduledSync();
    clearPendingThinkTimer();
    clearToastTimer();
    clearCopyFeedbackTimer();
    clearHighlights();
    if (dockResizeObserver) {
      try { dockResizeObserver.disconnect(); } catch {}
      dockResizeObserver = null;
    }
    observedAreaEl = null;
    if (searchSlot && onSearchSlotKeyDown) {
      try { searchSlot.removeEventListener?.('keydown', onSearchSlotKeyDown); } catch {}
    }
    onSearchSlotKeyDown = null;
    clearNodes(customButtonNodes);
    if (typeof revokeNavButtonsSurface === 'function') {
      try { revokeNavButtonsSurface(); } catch {}
      revokeNavButtonsSurface = null;
    }
    if (searchBoxEl?.remove) searchBoxEl.remove();
    if (exportMenuEl?.remove) exportMenuEl.remove();
    if (toastEl?.remove) toastEl.remove();
    if (dockEl?.remove) dockEl.remove();
    dockEl = null;
    extraButtonsSlot = null;
    searchSlot = null;
    searchBoxEl = null;
    searchInputEl = null;
    searchCountEl = null;
    searchPrevBtn = null;
    searchNextBtn = null;
    searchToggleBtn = null;
    thinkBtn = null;
    copyIdBtn = null;
    exportBtnEl = null;
    exportMenuEl = null;
    exportMenuOpen = false;
    toastEl = null;
    exportLoading = false;
    searchOpen = false;
  }

  function ensureDock() {
    if (!doc?.createElement) return null;
    if (!settings.showFloatDock) {
      teardownDock();
      return null;
    }
    if (dockEl) return dockEl;

    dockEl = doc.createElement('div');
    dockEl.id = 'agy-chat-nav-float';
    dockEl.className = 'agy-chat-nav-float';

    const actions = [
      { id: 'top', icon: NAV_ICONS.top, title: '滚动到对话顶部', fn: () => scrollTop() },
      { id: 'prev', icon: NAV_ICONS.prev, title: '上一轮对话', fn: () => stepTurn(-1) },
      { id: 'next', icon: NAV_ICONS.next, title: '下一轮对话', fn: () => stepTurn(1) },
      { id: 'bottom', icon: NAV_ICONS.bottom, title: '滚动到对话底部', fn: () => scrollBottom() },
      { id: 'think', icon: NAV_ICONS.think, title: '展开/收起思考过程', fn: () => toggleThinking() },
      { id: 'copy-id', icon: NAV_ICONS.copyId, title: '复制当前会话 ID', fn: () => { void copyConversationId(); } },
      { id: 'export-md', icon: NAV_ICONS.exportMd, title: '导出对话', fn: handleExportButtonClick }
    ];
    for (const act of actions) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = `agy-nav-${act.id}`;
      btn.innerHTML = act.icon;
      btn.setAttribute?.('title', act.title);
      btn.setAttribute?.('aria-label', act.title);
      if (act.id === 'think') {
        btn.setAttribute?.('data-active', 'false');
        thinkBtn = btn;
      } else if (act.id === 'copy-id') {
        btn.setAttribute?.('data-active', 'false');
        copyIdBtn = btn;
      } else if (act.id === 'export-md') {
        exportBtnEl = btn;
        updateExportButtonMeta();
      }
      btn.addEventListener('click', act.fn);
      dockEl.appendChild(btn);
    }

    extraButtonsSlot = doc.createElement('div');
    extraButtonsSlot.id = 'agy-chat-nav-extra';
    dockEl.appendChild(extraButtonsSlot);

    searchOpen = false;
    searchToggleBtn = doc.createElement('button');
    searchToggleBtn.type = 'button';
    searchToggleBtn.id = 'agy-nav-search-toggle';
    searchToggleBtn.innerHTML = NAV_ICONS.search;
    searchToggleBtn.setAttribute?.('title', '搜索对话记录');
    searchToggleBtn.setAttribute?.('aria-label', '搜索对话记录');
    searchToggleBtn.setAttribute?.('aria-expanded', 'false');
    searchToggleBtn.setAttribute?.('data-active', 'false');

    searchSlot = doc.createElement('div');
    searchSlot.id = 'agy-chat-search-slot';
    searchSlot.className = 'agy-search-collapsed';

    onSearchSlotKeyDown = (e) => {
      if (e?.key === 'Escape') {
        e.preventDefault?.();
        e.stopPropagation?.();
        clearAndClose('escape');
      }
    };
    searchSlot.addEventListener('keydown', onSearchSlotKeyDown);

    const builtinSearch = buildBuiltinSearchBox();
    searchBoxEl = builtinSearch.box;
    searchInputEl = builtinSearch.inp;
    searchCountEl = builtinSearch.countEl;
    searchPrevBtn = builtinSearch.prevBtn;
    searchNextBtn = builtinSearch.nextBtn;
    searchSlot.appendChild(searchBoxEl);
    if (lastSearchQuery) {
      searchInputEl.value = lastSearchQuery;
    }

    searchToggleBtn.addEventListener('click', () => {
      setSearchOpen(!searchOpen, { reason: 'toggle' });
    });
    dockEl.appendChild(searchToggleBtn);
    dockEl.appendChild(searchSlot);

    exportMenuEl = doc.createElement('div');
    exportMenuEl.id = 'agy-export-format-menu';
    exportMenuEl.setAttribute?.('role', 'menu');
    exportMenuEl.hidden = true;
    exportMenuEl.setAttribute?.('hidden', 'true');
    renderExportFormatMenu();
    dockEl.appendChild(exportMenuEl);

    toastEl = doc.createElement('div');
    toastEl.id = 'agy-chat-nav-toast';
    toastEl.hidden = true;
    toastEl.setAttribute?.('hidden', 'true');
    dockEl.appendChild(toastEl);

    const mountRoot = doc.body || doc.documentElement;
    mountRoot?.appendChild?.(dockEl);

    // 必须先将宿主插槽挂载入文档树，再向底座注册 ctx.surfaces（供跨世界查询与订阅）
    if (ctx.surfaces && typeof ctx.surfaces.provide === 'function') {
      revokeNavButtonsSurface = ctx.surfaces.provide('chat.navButtons', extraButtonsSlot);
    }

    renderCustomButtons();

    const RO = win?.ResizeObserver || globalThis.ResizeObserver;
    if (typeof RO === 'function') {
      try {
        dockResizeObserver = new RO(() => scheduleSyncDockPosition());
        if (doc.body) dockResizeObserver.observe(doc.body);
      } catch {
        dockResizeObserver = null;
      }
    }
    syncDockPosition();
    return dockEl;
  }

  function renderCustomButtons() {
    if (!extraButtonsSlot || !doc?.createElement) return;
    clearNodes(customButtonNodes);
    for (const [id, def] of customButtons.entries()) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = `agy-nav-ext-${id}`;
      btn.textContent = def.label || id;
      if (typeof def.onClick === 'function') btn.addEventListener('click', def.onClick);
      extraButtonsSlot.appendChild(btn);
      customButtonNodes.push(btn);
    }
  }

  function scrollViewportTo(vp, top) {
    if (!vp) return;
    const target = Math.max(0, Number(top) || 0);
    if (typeof vp.scrollTo === 'function') {
      try {
        vp.scrollTo({ top: target, behavior: 'smooth' });
        return;
      } catch {}
    }
    vp.scrollTop = target;
  }

  function scrollTop() {
    const vp = ctx.anchors.query('chat.scrollViewport');
    if (vp) {
      lastTurnNav = null;
      scrollViewportTo(vp, 0);
    }
    return Boolean(vp);
  }

  function scrollBottom() {
    const vp = ctx.anchors.query('chat.scrollViewport');
    if (vp) {
      lastTurnNav = null;
      const maxTop = Math.max(0, Number(vp.scrollHeight || 999999) - Number(vp.clientHeight || 0));
      scrollViewportTo(vp, vp.scrollHeight ? maxTop : 999999);
    }
    return Boolean(vp);
  }

  function getTurnElements(vp) {
    if (vp && typeof vp.querySelectorAll === 'function') {
      const userMsgs = Array.from(vp.querySelectorAll('[data-testid="user-message"]') || []);
      const agentResps = Array.from(vp.querySelectorAll('[data-testid="agent-response"]') || []);
      if (userMsgs.length > 0) {
        const firstUser = userMsgs[0];
        const leadingResps = agentResps.filter((r) => {
          if (typeof r.compareDocumentPosition === 'function') {
            return (r.compareDocumentPosition(firstUser) & 4) !== 0;
          }
          return false;
        });
        const combined = [...leadingResps, ...userMsgs];
        if (combined.length > 1 && typeof combined[0].compareDocumentPosition === 'function') {
          combined.sort((a, b) => {
            if (a === b) return 0;
            return (a.compareDocumentPosition(b) & 4) !== 0 ? -1 : 1;
          });
        }
        return combined;
      }
      if (agentResps.length > 0) return agentResps;
    }
    const list = ctx.anchors.query('chat.messageList');
    const children = Array.from(list?.children || []).filter((c) => {
      if (!c) return false;
      return (c.textContent || '').length > 0 || (c.children?.length || 0) > 0;
    });
    return children;
  }

  function stepTurn(delta) {
    const vp = ctx.anchors.query('chat.scrollViewport') || ctx.anchors.query('chat.messageList');
    if (!vp) return false;
    const vpRect = getRect(vp);
    if (vpRect && vpRect.height > 0) {
      const turns = getTurnElements(vp);
      const curScrollTop = Number(vp.scrollTop || 0);
      const turnsWithTop = [];
      for (const el of turns) {
        const r = getRect(el);
        if (!r) continue;
        const top = Math.round(r.top - vpRect.top + curScrollTop);
        turnsWithTop.push({ el, top });
      }
      if (turnsWithTop.length > 0) {
        turnsWithTop.sort((a, b) => a.top - b.top);
        const now = Date.now();
        const baseTop = (lastTurnNav && (now - lastTurnNav.ts) < 500) ? lastTurnNav.top : curScrollTop;
        const maxScroll = Math.max(0, Number(vp.scrollHeight || 0) - Number(vp.clientHeight || vpRect.height || 0));
        let target = baseTop;
        if (delta < 0) {
          let found = null;
          for (let i = turnsWithTop.length - 1; i >= 0; i--) {
            if (turnsWithTop[i].top < baseTop - 16) {
              found = turnsWithTop[i];
              break;
            }
          }
          target = found ? Math.max(0, found.top - 12) : 0;
        } else {
          const found = turnsWithTop.find((t) => t.top > baseTop + 16);
          target = found ? Math.min(maxScroll, Math.max(0, found.top - 12)) : maxScroll;
        }
        lastTurnNav = { top: target, ts: now };
        scrollViewportTo(vp, target);
        outlineRail?.syncActiveTurnFromScroll?.();
        return true;
      }
    }
    const cur = Number(vp.scrollTop || 0);
    vp.scrollTop = Math.max(0, cur + delta * 360);
    outlineRail?.syncActiveTurnFromScroll?.();
    return true;
  }

  function getThinkingTriggers() {
    const seen = new Set();
    const out = [];
    const add = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      out.push(el);
    };
    for (const el of ctx.anchors.queryAll('chat.thinkingTrigger') || []) add(el);
    const vp = ctx.anchors.query('chat.scrollViewport');
    const worked = vp?.querySelectorAll?.('[data-testid="worked-for-collapsible"]')
      || doc?.querySelectorAll?.('[data-testid="worked-for-collapsible"]')
      || [];
    for (const el of worked) add(el);
    if (out.length > 1 && typeof out[0]?.compareDocumentPosition === 'function') {
      out.sort((a, b) => {
        if (a === b) return 0;
        return (a.compareDocumentPosition(b) & 4) !== 0 ? -1 : 1;
      });
    }
    return out;
  }

  function getTriggerExpandedState(t) {
    if (!t) return null;
    const aria = t.getAttribute?.('aria-expanded');
    if (aria === 'true') return true;
    if (aria === 'false') return false;

    const ds = t.getAttribute?.('data-state') || t.closest?.('[data-state]')?.getAttribute?.('data-state');
    if (ds === 'open') return true;
    if (ds === 'closed') return false;

    const ctrlId = t.getAttribute?.('aria-controls');
    if (ctrlId && doc?.getElementById) {
      const ctrlEl = doc.getElementById(ctrlId);
      if (ctrlEl) {
        if (ctrlEl.hidden || ctrlEl.getAttribute?.('hidden') !== null) return false;
        const cr = getRect(ctrlEl);
        if (cr) return cr.height > 0;
      }
    }

    const nextSib = t.nextElementSibling;
    if (nextSib) {
      const nr = getRect(nextSib);
      if (nr && nr.height > 0) return true;
    }
    if (t.parentElement?.children?.length === 1 && getRect(t)) {
      return false;
    }
    return null;
  }

  function updateThinkButtonVisual(active) {
    if (!thinkBtn) return;
    thinkBtn.setAttribute?.('data-active', active ? 'true' : 'false');
    const title = active ? '收起思考过程' : '展开思考过程';
    thinkBtn.setAttribute?.('title', title);
    thinkBtn.setAttribute?.('aria-label', title);
  }

  function expandThinking() {
    const triggers = getThinkingTriggers();
    let expandedCount = 0;
    let clickedWorked = false;
    for (const t of triggers) {
      if (getTriggerExpandedState(t) !== true) {
        t.setAttribute?.('data-agy-keep-expanded', '1');
        if (t.getAttribute?.('data-testid') === 'worked-for-collapsible') {
          clickedWorked = true;
        }
        if (typeof t.click === 'function') t.click();
        expandedCount++;
      }
    }
    if (clickedWorked) {
      clearPendingThinkTimer();
      pendingThinkTimer = setTimeout(() => {
        pendingThinkTimer = null;
        const nested = ctx.anchors.queryAll('chat.thinkingTrigger') || [];
        for (const nt of nested) {
          if (getTriggerExpandedState(nt) !== true) {
            nt.setAttribute?.('data-agy-keep-expanded', '1');
            if (typeof nt.click === 'function') nt.click();
          }
        }
      }, 120);
    }
    updateThinkButtonVisual(true);
    ctx.events.emit('chat:thinking-expanded@1', { expandedCount, total: triggers.length });
    return expandedCount;
  }

  function collapseThinking() {
    clearPendingThinkTimer();
    const triggers = getThinkingTriggers();
    let collapsedCount = 0;
    for (const t of triggers) {
      if (getTriggerExpandedState(t) === true) {
        t.removeAttribute?.('data-agy-keep-expanded');
        if (typeof t.click === 'function') t.click();
        collapsedCount++;
      }
    }
    updateThinkButtonVisual(false);
    ctx.events.emit('chat:thinking-collapsed@1', { collapsedCount, total: triggers.length });
    return collapsedCount;
  }

  function toggleThinking() {
    const triggers = getThinkingTriggers();
    const states = triggers.map((t) => getTriggerExpandedState(t));
    if (states.some((s) => s === false)) {
      return expandThinking();
    }
    if (states.some((s) => s === true)) {
      return collapseThinking();
    }
    thinkingToggleFallback = !thinkingToggleFallback;
    for (const t of triggers) {
      if (thinkingToggleFallback) t.setAttribute?.('data-agy-keep-expanded', '1');
      else t.removeAttribute?.('data-agy-keep-expanded');
      if (typeof t.click === 'function') t.click();
    }
    updateThinkButtonVisual(thinkingToggleFallback);
    ctx.events.emit(
      thinkingToggleFallback ? 'chat:thinking-expanded@1' : 'chat:thinking-collapsed@1',
      thinkingToggleFallback
        ? { expandedCount: triggers.length, total: triggers.length }
        : { collapsedCount: triggers.length, total: triggers.length }
    );
    return triggers.length;
  }

  function getConversationRows() {
    return ctx.anchors.queryAll('sidebar.conversationRows') || [];
  }

  function switchConversation(index) {
    const rows = getConversationRows();
    if (!rows.length || index < 0 || index >= rows.length) return false;
    for (let i = 0; i < rows.length; i++) {
      rows[i].setAttribute?.('aria-selected', i === index ? 'true' : 'false');
    }
    const target = rows[index];
    activeConvIndex = index;
    if (typeof target.click === 'function') target.click();
    if (typeof options.onConversationSwitch === 'function') {
      options.onConversationSwitch(index, target);
    }
    return true;
  }

  function cycleConversation(delta) {
    const rows = getConversationRows();
    if (!rows.length) return false;
    let cur = rows.findIndex((r) => r.getAttribute?.('aria-selected') === 'true' || r.getAttribute?.('aria-current') === 'true');
    if (cur < 0) cur = activeConvIndex;
    const next = (cur + delta + rows.length) % rows.length;
    return switchConversation(next);
  }

  function showConvBadges() {
    hideConvBadges();
    if (!doc?.createElement) return 0;
    const rows = getConversationRows();
    const limit = Math.min(rows.length, 9);
    for (let i = 0; i < limit; i++) {
      const badge = doc.createElement('span');
      badge.className = 'agy-conv-shortcut-badge';
      badge.setAttribute('data-agy-conv-badge', String(i + 1));
      badge.textContent = String(i + 1);
      if (badge.style?.setProperty) {
        badge.style.setProperty('background', 'var(--ag-bg-control, rgba(113, 113, 122, 0.14))');
        badge.style.setProperty('color', 'var(--ag-text-primary, currentColor)');
        badge.style.setProperty('border-color', 'var(--ag-border-card, rgba(113, 113, 122, 0.24))');
      }
      rows[i].appendChild?.(badge);
      mountedBadges.push(badge);
    }
    return limit;
  }

  function hideConvBadges() {
    while (mountedBadges.length > 0) {
      const b = mountedBadges.pop();
      if (b?.remove) b.remove();
    }
  }

  function closeInlineEditor(refreshPreview = false) {
    if (editorPanelEl?.remove) editorPanelEl.remove();
    editorPanelEl = null;
    editorTextareaEl = null;
    if (refreshPreview && typeof options.onEditorExit === 'function') {
      options.onEditorExit(activeEditorPath);
    }
  }

  async function saveInlineFile() {
    if (!editorTextareaEl || !activeEditorPath) return { ok: false, error: 'NO_ACTIVE_FILE' };
    const res = await ctx.bridge.post('/file/write', {
      path: activeEditorPath,
      content: editorTextareaEl.value || ''
    });
    if (res?.ok && typeof options.onFileSaved === 'function') {
      options.onFileSaved(activeEditorPath, res);
    }
    return res;
  }

  async function openInlineEditor(headerOrPath) {
    if (!doc?.createElement) return false;
    const headerEl = (headerOrPath && typeof headerOrPath === 'object')
      ? headerOrPath
      : ctx.anchors.query('fileViewer.header');
    activeEditorPath = (typeof headerOrPath === 'string' && headerOrPath)
      || headerEl?.getAttribute?.('data-file-path')
      || headerEl?.getAttribute?.('data-uri')
      || options.activeFilePath
      || '';
    if (editorPanelEl) {
      closeInlineEditor(false);
      return false;
    }
    let initialContent = '';
    if (activeEditorPath) {
      try {
        const readRes = await ctx.bridge.post('/file/read', { path: activeEditorPath });
        if (readRes?.ok) initialContent = readRes.content || '';
      } catch {}
    }

    editorPanelEl = doc.createElement('div');
    editorPanelEl.id = 'agy-inline-file-editor-panel';
    editorTextareaEl = doc.createElement('textarea');
    editorTextareaEl.id = 'agy-inline-file-textarea';
    editorTextareaEl.value = initialContent;
    editorPanelEl.appendChild(editorTextareaEl);

    const saveBtn = doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.id = 'agy-inline-file-save';
    saveBtn.textContent = '保存 (⌘S)';
    saveBtn.addEventListener('click', () => { void saveInlineFile(); });
    editorPanelEl.appendChild(saveBtn);

    const doneBtn = doc.createElement('button');
    doneBtn.type = 'button';
    doneBtn.id = 'agy-inline-file-done';
    doneBtn.textContent = '完成';
    doneBtn.addEventListener('click', () => closeInlineEditor(true));
    editorPanelEl.appendChild(doneBtn);

    const mountTarget = headerEl?.parentElement || headerEl || doc.body;
    mountTarget?.appendChild?.(editorPanelEl);
    return true;
  }

  function attachFileEditorControl(headerEl) {
    if (!settings.enableInlineFileEditor || !headerEl || !doc?.createElement) return;
    if (headerEl.querySelector?.('#agy-file-editor-controls')) return;
    editorControlEl = doc.createElement('button');
    editorControlEl.type = 'button';
    editorControlEl.id = 'agy-file-editor-controls';
    editorControlEl.textContent = '编辑';
    editorControlEl.addEventListener('click', () => { void openInlineEditor(headerEl); });
    headerEl.appendChild(editorControlEl);
  }

  const stopThinkingGuard = ctx.anchors.observe('chat.thinkingTrigger', () => {
    if (settings.keepThinkingExpanded) {
      expandThinking();
    }
  });

  const stopViewportObserver = ctx.anchors.observe('chat.scrollViewport', () => {
    scheduleSyncDockPosition();
    codeBlockEnhancer?.scheduleRefresh?.();
    outlineRail?.refresh?.();
  });

  const stopMessageListObserver = ctx.anchors.observe('chat.messageList', () => {
    codeBlockEnhancer?.scheduleRefresh?.();
    outlineRail?.refresh?.();
  });

  const stopSendBtnObserver = ctx.anchors.observe('composer.sendButton', () => {
    codeBlockEnhancer?.scheduleRefresh?.();
  });

  const stopComposerObserver = ctx.anchors.observe('composer.root', () => {
    scheduleSyncDockPosition();
  });

  const stopFileHeaderObserver = ctx.anchors.observe('fileViewer.header', (headerEl) => {
    attachFileEditorControl(headerEl);
  });

  const stopDialogObserver = ctx.anchors.observe('settings.dialog', () => {
    syncDockDialogLayering();
  });

  const stopSearchCloseSub = ctx.events?.on?.('chat:search-close@1', () => {
    setSearchOpen(false, { silent: true, reason: 'external-close' });
  });

  const stopNavCmdSub = ctx.events?.on?.('chat-nav:command@1', (payload) => {
    const cmd = payload?.command;
    if (cmd === 'scroll-top') scrollTop();
    else if (cmd === 'scroll-bottom') scrollBottom();
    else if (cmd === 'expand-thinking') expandThinking();
    else if (cmd === 'turn-prev') stepTurn(-1);
    else if (cmd === 'turn-next') stepTurn(1);
    else if (cmd === 'toggle-outline') outlineRail?.setPopoverOpen?.(!outlineRail.isPopoverOpen());
    else if (cmd === 'collapse-long-code') codeBlockEnhancer?.toggleAllLongBlocks?.();
  });

  const stopContextSub = ctx.state?.subscribe?.('state:context.snapshot@1', (snap) => {
    latestContextCascadeId = snap?.cascadeId ? String(snap.cascadeId) : null;
  });

  const onWinResize = () => scheduleSyncDockPosition();

  const onKeyDown = (e) => {
    if (!e) return;
    if (e.key === 'Escape' && exportMenuOpen) {
      setExportMenuOpen(false);
      e.preventDefault?.();
      e.stopPropagation?.();
      return;
    }
    if (e.key === 'Escape' && outlineRail?.isPopoverOpen?.()) {
      outlineRail.setPopoverOpen(false);
      e.preventDefault?.();
      return;
    }
    if (settings.enableTurnShortcuts && e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      const isUp = e.key === 'ArrowUp' || e.code === 'ArrowUp';
      const isDown = e.key === 'ArrowDown' || e.code === 'ArrowDown';
      if (isUp || isDown) {
        if (!hasOpenDialog() && !isEditableElement(e.target, doc)) {
          if (stepTurn(isUp ? -1 : 1)) {
            e.preventDefault?.();
          }
        }
        return;
      }
    }
    // 按住 ⌘（无其他修饰键）浮现左侧 1~9 序号角标
    if ((e.key === 'Meta' || (e.metaKey && !e.key)) && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      showConvBadges();
      return;
    }

    // ⌘1~⌘9 快速切换对话（显式避开 ⌘⇧3/4/5 系统截图）
    if (e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      const mCode = typeof e.code === 'string' && /^Digit([1-9])$/.exec(e.code);
      const digit = mCode ? Number(mCode[1]) : (/^[1-9]$/.test(String(e.key || '')) ? Number(e.key) : 0);
      if (digit >= 1 && digit <= 9) {
        if (switchConversation(digit - 1)) {
          e.preventDefault?.();
          e.stopPropagation?.();
          e.stopImmediatePropagation?.();
          hideConvBadges();
        }
        return;
      }
      if (String(e.key || '').toLowerCase() === 's' && editorPanelEl) {
        e.preventDefault?.();
        e.stopPropagation?.();
        void saveInlineFile();
        return;
      }
    }

    // ⌘⇧[ / ⌘⇧] 与 ⌃Tab / ⌃⇧Tab 循环切换对话
    if (e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey) {
      if (e.key === '[' || e.key === '{' || e.code === 'BracketLeft') {
        if (cycleConversation(-1)) {
          e.preventDefault?.();
          e.stopPropagation?.();
          hideConvBadges();
        }
        return;
      }
      if (e.key === ']' || e.key === '}' || e.code === 'BracketRight') {
        if (cycleConversation(1)) {
          e.preventDefault?.();
          e.stopPropagation?.();
          hideConvBadges();
        }
        return;
      }
    }

    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
      if (cycleConversation(e.shiftKey ? -1 : 1)) {
        e.preventDefault?.();
        e.stopPropagation?.();
      }
    }
  };

  const onKeyUp = (e) => {
    if (!e || e.key === 'Meta' || !e.metaKey) {
      hideConvBadges();
    }
  };

  const onBlur = () => hideConvBadges();

  const onDocClick = (ev) => {
    if (exportMenuOpen) {
      const target = ev?.target;
      const inMenu = target && (target === exportMenuEl || target === exportBtnEl || exportMenuEl?.contains?.(target) || exportBtnEl?.contains?.(target));
      if (!inMenu) {
        setExportMenuOpen(false);
      }
    }
    if (!settings.enableCmdClickLinks) return;
    const isMod = Boolean(ev?.metaKey || ev?.ctrlKey);
    if (!isMod) return;
    const href = ev?.target?.getAttribute?.('href') || ev?.href || '';
    if (!href) return;
    if (!isSafeExternalUrl(href)) return;
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    if (typeof options.onOpenExternal === 'function') {
      options.onOpenExternal(href);
    } else if (typeof globalThis.open === 'function') {
      globalThis.open(href, '_blank', 'noopener,noreferrer');
    }
  };

  doc?.addEventListener?.('click', onDocClick);
  doc?.addEventListener?.('keydown', onKeyDown, true);
  doc?.addEventListener?.('keyup', onKeyUp, true);
  win?.addEventListener?.('blur', onBlur);
  win?.addEventListener?.('resize', onWinResize);

  ensureDock();

  outlineRail = createOutlineRail({
    doc,
    win,
    anchors: ctx.anchors,
    findChatAreaElement,
    hasOpenDialog,
    scrollViewportTo,
    getSettings: () => settings
  });

  codeBlockEnhancer = createCodeBlockEnhancer({
    doc,
    win,
    anchors: ctx.anchors,
    hostDom: ctx.hostDom,
    copyText: copyTextToClipboard,
    showToast: showDockToast,
    getSettings: () => settings,
    onDomMutated: () => {
      outlineRail?.refresh?.();
    }
  });

  const stopSvc = ctx.services.provide('chat-nav', {
    scrollTop,
    scrollBottom,
    stepTurn,
    expandThinking,
    collapseThinking,
    toggleThinking,
    setSearchOpen,
    runSearch,
    focusMatch,
    clearHighlights,
    syncDockPosition,
    syncDockDialogLayering,
    switchConversation,
    cycleConversation,
    showConvBadges,
    hideConvBadges,
    openInlineEditor,
    saveInlineFile,
    closeInlineEditor,
    isSafeExternalUrl,
    copyConversationId,
    exportConversation,
    exportAllConversations,
    setExportMenuOpen,
    getConfiguredExportFormats,
    refreshCodeBlocks: () => codeBlockEnhancer?.refresh?.() ?? 0,
    toggleAllLongCodeBlocks: (forceState) => codeBlockEnhancer?.toggleAllLongBlocks?.(forceState) ?? 0,
    setCodeBlockCollapsed: (preEl, collapsed) => codeBlockEnhancer?.setBlockCollapsed?.(preEl, collapsed) ?? false,
    refreshOutlineRail: () => outlineRail?.refresh?.() ?? [],
    setOutlineOpen: (open) => outlineRail?.setPopoverOpen?.(open) ?? false,
    setOutlineFilter: (mode) => outlineRail?.setFilterMode?.(mode),
    getOutlineItems: () => outlineRail?.getOutlineItems?.() ?? [],
    getSettings: () => ({ ...settings }),
    registerNavButton(def) {
      if (!def?.id) throw new Error('registerNavButton requires id');
      customButtons.set(def.id, def);
      renderCustomButtons();
      return () => {
        customButtons.delete(def.id);
        renderCustomButtons();
      };
    }
  });

  const stopSettingsChange = ctx.settings?.onChange?.((nextValues) => {
    settings = normalizeRendererSettings(nextValues || {});
    ensureDock();
    codeBlockEnhancer?.refresh?.();
    outlineRail?.refresh?.();
    updateExportButtonMeta();
    if (exportMenuOpen) {
      if (getConfiguredExportFormats().length <= 1) {
        setExportMenuOpen(false);
      } else {
        renderExportFormatMenu();
      }
    }
    if (searchInputEl?.value && (searchOpen || searchMatches.length > 0)) {
      runSearch(searchInputEl.value);
    }
    if (!settings.enableInlineFileEditor) {
      closeInlineEditor(false);
      if (editorControlEl?.remove) editorControlEl.remove();
      editorControlEl = null;
    } else {
      attachFileEditorControl(ctx.anchors.query('fileViewer.header'));
    }
    if (settings.keepThinkingExpanded) {
      expandThinking();
    }
  });

  disposers.push(
    stopSvc,
    stopSettingsChange,
    stopStyles,
    stopThinkingGuard,
    stopViewportObserver,
    stopMessageListObserver,
    stopSendBtnObserver,
    stopComposerObserver,
    stopFileHeaderObserver,
    stopDialogObserver,
    stopSearchCloseSub,
    stopNavCmdSub,
    stopContextSub,
    () => doc?.removeEventListener?.('click', onDocClick),
    () => doc?.removeEventListener?.('keydown', onKeyDown, true),
    () => doc?.removeEventListener?.('keyup', onKeyUp, true),
    () => win?.removeEventListener?.('blur', onBlur),
    () => win?.removeEventListener?.('resize', onWinResize),
    hideConvBadges,
    () => closeInlineEditor(false),
    clearHighlights,
    () => { codeBlockEnhancer?.dispose?.(); codeBlockEnhancer = null; },
    () => { outlineRail?.dispose?.(); outlineRail = null; },
    teardownDock,
    () => { if (editorControlEl?.remove) editorControlEl.remove(); editorControlEl = null; },
    () => { customButtons.clear(); }
  );
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  isSafeExternalUrl,
  createSearchMatcher,
  mount,
  dispose
};
