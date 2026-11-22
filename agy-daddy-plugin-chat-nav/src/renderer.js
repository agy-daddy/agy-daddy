'use strict';

let disposers = [];

function isSafeExternalUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const u = new URL(rawUrl.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
  } catch {
    return false;
  }
}

async function mount(ctx, options = {}) {
  let settings = {
    showFloatDock: true,
    keepThinkingExpanded: false,
    enableInlineFileEditor: true,
    enableCmdClickLinks: true
  };
  try {
    const res = await ctx.bridge.post('/settings', { action: 'get' });
    if (res?.ok && res.values) settings = { ...settings, ...res.values };
  } catch {}

  const doc = options.document
    || ctx.anchors.query('chat.scrollViewport')?.ownerDocument
    || ctx.anchors.query('composer.root')?.ownerDocument
    || ctx.anchors.query('sidebar.conversationRows')?.ownerDocument
    || globalThis.document;
  const win = options.window || (typeof globalThis.window !== 'undefined' ? globalThis.window : null);

  const customButtons = new Map();
  const searchProviders = new Map();
  const mountedBadges = [];
  let dockEl = null;
  let extraButtonsSlot = null;
  let searchSlot = null;
  let editorControlEl = null;
  let editorPanelEl = null;
  let editorTextareaEl = null;
  let activeEditorPath = '';
  let activeConvIndex = 0;

  function ensureDock() {
    if (!doc?.createElement) return null;
    if (!settings.showFloatDock) {
      if (dockEl?.remove) dockEl.remove();
      dockEl = null;
      return null;
    }
    if (dockEl) return dockEl;

    dockEl = doc.createElement('div');
    dockEl.id = 'agy-chat-nav-float';
    dockEl.className = 'agy-chat-nav-float';

    const actions = [
      { id: 'top', label: '顶', title: '滚动到对话顶部', fn: () => scrollTop() },
      { id: 'prev', label: '上轮', title: '上一轮对话', fn: () => stepTurn(-1) },
      { id: 'next', label: '下轮', title: '下一轮对话', fn: () => stepTurn(1) },
      { id: 'bottom', label: '底', title: '滚动到对话底部', fn: () => scrollBottom() },
      { id: 'think', label: '思', title: '展开思考过程', fn: () => expandThinking() }
    ];
    for (const act of actions) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = `agy-nav-${act.id}`;
      btn.textContent = act.label;
      btn.setAttribute?.('title', act.title);
      btn.addEventListener('click', act.fn);
      dockEl.appendChild(btn);
    }

    extraButtonsSlot = doc.createElement('div');
    extraButtonsSlot.id = 'agy-chat-nav-extra';
    dockEl.appendChild(extraButtonsSlot);

    let searchOpen = false;
    const searchToggleBtn = doc.createElement('button');
    searchToggleBtn.type = 'button';
    searchToggleBtn.id = 'agy-nav-search-toggle';
    searchToggleBtn.textContent = '搜';
    searchToggleBtn.setAttribute?.('title', '搜索对话记录');
    searchToggleBtn.setAttribute?.('data-active', 'false');

    searchSlot = doc.createElement('div');
    searchSlot.id = 'agy-chat-search-slot';
    searchSlot.className = 'agy-search-collapsed';

    searchToggleBtn.addEventListener('click', () => {
      searchOpen = !searchOpen;
      searchSlot.className = searchOpen ? 'agy-search-open' : 'agy-search-collapsed';
      searchToggleBtn.setAttribute?.('data-active', searchOpen ? 'true' : 'false');
      if (searchOpen) {
        const inp = searchSlot.querySelector?.('input');
        inp?.focus?.();
      }
    });
    dockEl.appendChild(searchToggleBtn);
    dockEl.appendChild(searchSlot);

    const mountRoot = doc.body || doc.documentElement;
    mountRoot?.appendChild?.(dockEl);
    renderCustomButtons();
    renderSearchSlot();
    return dockEl;
  }

  function renderCustomButtons() {
    if (!extraButtonsSlot || !doc?.createElement) return;
    extraButtonsSlot.innerHTML = '';
    if (Array.isArray(extraButtonsSlot.children)) extraButtonsSlot.children.length = 0;
    for (const [id, def] of customButtons.entries()) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = `agy-nav-ext-${id}`;
      btn.textContent = def.label || id;
      if (typeof def.onClick === 'function') btn.addEventListener('click', def.onClick);
      extraButtonsSlot.appendChild(btn);
    }
  }

  function renderSearchSlot() {
    if (!searchSlot || !doc?.createElement) return;
    searchSlot.innerHTML = '';
    if (Array.isArray(searchSlot.children)) searchSlot.children.length = 0;
    if (searchProviders.size === 0) return;
    const provider = Array.from(searchProviders.values())[0];
    if (typeof provider.render === 'function') {
      provider.render(searchSlot, doc);
      return;
    }
    const input = doc.createElement('input');
    input.type = 'text';
    input.id = 'agy-chat-search-input';
    input.className = 'settings-input';
    input.addEventListener('change', () => {
      try { provider.onSearch?.(input.value); } catch {}
    });
    searchSlot.appendChild(input);
  }

  function scrollTop() {
    const vp = ctx.anchors.query('chat.scrollViewport');
    if (vp) vp.scrollTop = 0;
    return Boolean(vp);
  }

  function scrollBottom() {
    const vp = ctx.anchors.query('chat.scrollViewport');
    if (vp) vp.scrollTop = Number(vp.scrollHeight || 999999);
    return Boolean(vp);
  }

  function stepTurn(delta) {
    const list = ctx.anchors.query('chat.messageList') || ctx.anchors.query('chat.scrollViewport');
    if (!list) return false;
    const cur = Number(list.scrollTop || 0);
    list.scrollTop = Math.max(0, cur + delta * 360);
    return true;
  }

  function expandThinking() {
    const triggers = ctx.anchors.queryAll('chat.thinkingTrigger');
    let expandedCount = 0;
    for (const t of triggers) {
      const expanded = t.getAttribute?.('aria-expanded');
      if (expanded !== 'true') {
        t.setAttribute?.('data-agy-keep-expanded', '1');
        if (typeof t.click === 'function') t.click();
        t.setAttribute?.('aria-expanded', 'true');
        expandedCount++;
      }
    }
    ctx.events.emit('chat:thinking-expanded@1', { expandedCount, total: triggers.length });
    return expandedCount;
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
        badge.style.setProperty('background', 'var(--ag-accent-bg, rgba(167, 139, 250, 0.14))');
        badge.style.setProperty('color', 'var(--ag-custom-token-accent, #a78bfa)');
        badge.style.setProperty('border-color', 'var(--ag-accent-border, rgba(167, 139, 250, 0.34))');
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

  async function openInlineEditor(headerEl) {
    if (!doc?.createElement) return false;
    activeEditorPath = headerEl?.getAttribute?.('data-file-path')
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
    saveBtn.textContent = '💾 保存 (⌘S)';
    saveBtn.addEventListener('click', () => { void saveInlineFile(); });
    editorPanelEl.appendChild(saveBtn);

    const doneBtn = doc.createElement('button');
    doneBtn.type = 'button';
    doneBtn.id = 'agy-inline-file-done';
    doneBtn.textContent = '↩️ 完成';
    doneBtn.addEventListener('click', () => closeInlineEditor(true));
    editorPanelEl.appendChild(doneBtn);

    const mountTarget = headerEl?.parentElement || headerEl || doc.body;
    mountTarget?.appendChild?.(editorPanelEl);
    return true;
  }

  const stopThinkingGuard = ctx.anchors.observe('chat.thinkingTrigger', () => {
    if (settings.keepThinkingExpanded) {
      expandThinking();
    }
  });

  const stopFileHeaderObserver = ctx.anchors.observe('fileViewer.header', (headerEl) => {
    if (!settings.enableInlineFileEditor || !headerEl || !doc?.createElement) return;
    if (headerEl.querySelector?.('#agy-file-editor-controls')) return;
    editorControlEl = doc.createElement('button');
    editorControlEl.type = 'button';
    editorControlEl.id = 'agy-file-editor-controls';
    editorControlEl.textContent = '✏️ 编辑';
    editorControlEl.addEventListener('click', () => { void openInlineEditor(headerEl); });
    headerEl.appendChild(editorControlEl);
  });

  const onKeyDown = (e) => {
    if (!e) return;
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

  ensureDock();

  const stopSvc = ctx.services.provide('chat-nav', {
    scrollTop,
    scrollBottom,
    stepTurn,
    expandThinking,
    switchConversation,
    cycleConversation,
    showConvBadges,
    hideConvBadges,
    openInlineEditor,
    saveInlineFile,
    closeInlineEditor,
    isSafeExternalUrl,
    registerNavButton(def) {
      if (!def?.id) throw new Error('registerNavButton requires id');
      customButtons.set(def.id, def);
      renderCustomButtons();
      return () => {
        customButtons.delete(def.id);
        renderCustomButtons();
      };
    },
    registerSearchProvider(def) {
      const id = def?.id || 'default';
      searchProviders.set(id, def);
      renderSearchSlot();
      return () => {
        searchProviders.delete(id);
        renderSearchSlot();
      };
    }
  });

  const stopSection = ctx.settings.registerSection({
    id: 'chat-nav-settings',
    title: { 'zh-CN': '对话栏增强', en: 'Chat Navigation' },
    values: settings,
    onChange(key, value) {
      settings = { ...settings, [key]: value };
      ensureDock();
      void ctx.bridge.post('/settings', { action: 'save', values: { [key]: value } }).catch(() => {});
    }
  });

  disposers.push(
    stopSvc,
    stopSection,
    stopThinkingGuard,
    stopFileHeaderObserver,
    () => doc?.removeEventListener?.('click', onDocClick),
    () => doc?.removeEventListener?.('keydown', onKeyDown, true),
    () => doc?.removeEventListener?.('keyup', onKeyUp, true),
    () => win?.removeEventListener?.('blur', onBlur),
    hideConvBadges,
    () => closeInlineEditor(false),
    () => { if (dockEl?.remove) dockEl.remove(); dockEl = null; },
    () => { if (editorControlEl?.remove) editorControlEl.remove(); editorControlEl = null; },
    () => { customButtons.clear(); searchProviders.clear(); }
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
  mount,
  dispose
};
