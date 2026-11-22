'use strict';

const { shouldBlockAutoAccept } = require('./high-risk-guard');
const {
  QUICK_PROMPT_GROUPS,
  BUILTIN_QUICK_POOL,
  truncateGhostLabel,
  getGhostSuggestions,
  optimizePromptText
} = require('./quick-prompts');

let disposers = [];

async function mount(ctx, options = {}) {
  let settings = {
    showQuickBar: true,
    ghostSuggest: true,
    autoAccept: false,
    autoCompact: false,
    autoCompactThresholdTokens: 240000,
    autoCompactCooldownMs: 300000,
    quickPoolState: Object.fromEntries(BUILTIN_QUICK_POOL.map((q) => [q.id, Boolean(q.defaultEnabled)])),
    customQuickPrompts: []
  };
  try {
    const res = await ctx.bridge.post('/settings', { action: 'get' });
    if (res?.ok && res.values) settings = { ...settings, ...res.values };
  } catch {}

  const doc = options.document
    || ctx.anchors.query('composer.root')?.ownerDocument
    || globalThis.document;

  const extraActions = new Map();
  let quickBarEl = null;
  let ghostEl = null;
  let optBtnEl = null;
  let undoBtnEl = null;
  let lastCompactAt = 0;
  let latestContextSnap = null;
  let ghostCandidates = getGhostSuggestions();
  let ghostIndex = 0;
  let ghostDismissed = false;
  let promptOptUndoState = null;

  function clearPromptOptUndoState() {
    promptOptUndoState = null;
    if (undoBtnEl) {
      undoBtnEl.hidden = true;
      undoBtnEl.setAttribute?.('hidden', 'true');
      undoBtnEl.setAttribute?.('data-visible', '0');
      if (undoBtnEl.style) undoBtnEl.style.display = 'none';
    }
  }

  function convertSlashToNativeCapsule(item, editorEl) {
    if (!item?.slash || !editorEl) return false;
    editorEl.setAttribute?.('data-agy-native-slash', item.slash);
    if (typeof options.onNativeSlashCommand === 'function') {
      return Boolean(options.onNativeSlashCommand(item.slash, item));
    }
    return true;
  }

  function insertTextIntoComposer(text, autoSend = false, itemMeta = null) {
    if (itemMeta?.builtinAction) {
      if (typeof options.onBuiltinAction === 'function') {
        options.onBuiltinAction(itemMeta.builtinAction, itemMeta);
      }
      return true;
    }
    const editor = ctx.anchors.query('composer.editor');
    if (editor && itemMeta?.slash) {
      convertSlashToNativeCapsule(itemMeta, editor);
    }
    if (autoSend && typeof ctx.hostDom?.sendText === 'function') {
      clearPromptOptUndoState();
      return ctx.hostDom.sendText(text);
    }
    if (!editor) return false;
    editor.textContent = String(text || '');
    return true;
  }

  function buildDualLineTooltip(item) {
    let tip = `${item.role || item.title || item.label}\n适用场景: ${item.scene || '日常高效交互'}`;
    if (item.id === 'compact' && latestContextSnap?.used) {
      const k = Math.round(latestContextSnap.used / 1000);
      tip += `\n当前上下文: ${k}K · 自动压缩${settings.autoCompact ? '已开启' : '未开启'}`;
    }
    return tip;
  }

  function renderGhostPill() {
    if (!ghostEl || !doc) return;
    if (!settings.ghostSuggest || ghostDismissed || !ghostCandidates.length) {
      ghostEl.textContent = '';
      ghostEl.hidden = true;
      ghostEl.setAttribute?.('hidden', 'true');
      if (ghostEl.style) ghostEl.style.display = 'none';
      return;
    }
    const fullText = ghostCandidates[ghostIndex % ghostCandidates.length] || '';
    ghostEl.hidden = false;
    if (typeof ghostEl.removeAttribute === 'function') ghostEl.removeAttribute('hidden');
    if (ghostEl.style) ghostEl.style.display = '';
    ghostEl.textContent = truncateGhostLabel(fullText, 8);
    ghostEl.setAttribute?.('title', `${fullText}（Tab/→ 填入 · ↑/↓ 切换 · Esc 隐藏）`);
    ghostEl.setAttribute?.('data-full-suggestion', fullText);
  }

  function acceptGhostSuggestion() {
    if (ghostDismissed || !ghostCandidates.length) return false;
    const full = ghostCandidates[ghostIndex % ghostCandidates.length];
    if (!full) return false;
    const ok = insertTextIntoComposer(full, false);
    if (ok) {
      ghostDismissed = true;
      renderGhostPill();
    }
    return ok;
  }

  function cycleGhostSuggestion(delta) {
    if (!ghostCandidates.length) return false;
    ghostDismissed = false;
    ghostIndex = (ghostIndex + delta + ghostCandidates.length) % ghostCandidates.length;
    renderGhostPill();
    return true;
  }

  async function runPromptOptimization() {
    const editor = ctx.anchors.query('composer.editor');
    const raw = String(editor?.textContent || '').trim();
    if (!raw) return { ok: false, error: 'EMPTY_PROMPT' };
    let optimized = '';
    try {
      const res = await ctx.bridge.post('/optimize-prompt', { text: raw });
      if (res?.ok && res.optimized) optimized = res.optimized;
    } catch {}
    if (!optimized) optimized = optimizePromptText(raw);
    if (!optimized || !editor) return { ok: false };
    promptOptUndoState = { original: raw, optimized };
    editor.textContent = optimized;
    if (undoBtnEl) {
      undoBtnEl.hidden = false;
      undoBtnEl.setAttribute?.('data-visible', '1');
      if (typeof undoBtnEl.removeAttribute === 'function') undoBtnEl.removeAttribute('hidden');
      if (undoBtnEl.style) undoBtnEl.style.display = '';
    }
    return { ok: true, original: raw, optimized };
  }

  function undoPromptOptimization() {
    if (!promptOptUndoState) return false;
    const editor = ctx.anchors.query('composer.editor');
    if (editor) editor.textContent = promptOptUndoState.original;
    clearPromptOptUndoState();
    return true;
  }

  function renderQuickBar(rootEl) {
    if (!doc?.createElement) return null;
    if (!settings.showQuickBar || !rootEl) {
      if (quickBarEl?.remove) quickBarEl.remove();
      quickBarEl = null;
      return null;
    }
    if (!quickBarEl) {
      quickBarEl = doc.createElement('div');
      quickBarEl.id = 'agy-quick-capsule-bar';
      quickBarEl.className = 'agy-quick-capsule-bar';
      rootEl.appendChild(quickBarEl);
    }
    quickBarEl.innerHTML = '';
    if (Array.isArray(quickBarEl.children)) quickBarEl.children.length = 0;

    const poolState = settings.quickPoolState || {};
    const orderedItems = [];
    for (const grp of QUICK_PROMPT_GROUPS) {
      for (const item of BUILTIN_QUICK_POOL) {
        if (item.group !== grp.id) continue;
        const enabled = typeof poolState[item.id] === 'boolean' ? poolState[item.id] : Boolean(item.defaultEnabled);
        if (enabled) orderedItems.push(item);
      }
    }
    for (const c of (Array.isArray(settings.customQuickPrompts) ? settings.customQuickPrompts : [])) {
      orderedItems.push(c);
    }

    for (const item of orderedItems) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = `agy-qcap-${item.id}`;
      btn.setAttribute?.('data-group', item.group || 'tools');
      btn.setAttribute?.('title', buildDualLineTooltip(item));
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        insertTextIntoComposer(item.text, item.id === 'compact', item);
      });
      quickBarEl.appendChild(btn);
    }

    for (const [id, act] of extraActions.entries()) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = `agy-qcap-ext-${id}`;
      btn.textContent = act.label || id;
      btn.addEventListener('click', () => {
        try { act.onClick?.({ insertText: insertTextIntoComposer }); } catch {}
      });
      quickBarEl.appendChild(btn);
    }

    // 提示词一键优化 + ↩ 撤回
    optBtnEl = doc.createElement('button');
    optBtnEl.type = 'button';
    optBtnEl.id = 'agy-prompt-opt-btn';
    optBtnEl.textContent = '✨ 优化';
    optBtnEl.setAttribute?.('title', '使用快模型润色优化当前输入内容');
    optBtnEl.addEventListener('click', () => { void runPromptOptimization(); });
    quickBarEl.appendChild(optBtnEl);

    undoBtnEl = doc.createElement('button');
    undoBtnEl.type = 'button';
    undoBtnEl.id = 'agy-prompt-undo-btn';
    undoBtnEl.textContent = '↩ 撤回';
    if (!promptOptUndoState) {
      undoBtnEl.hidden = true;
      undoBtnEl.setAttribute?.('hidden', 'true');
      undoBtnEl.setAttribute?.('data-visible', '0');
      if (undoBtnEl.style) undoBtnEl.style.display = 'none';
    } else {
      undoBtnEl.hidden = false;
      undoBtnEl.setAttribute?.('data-visible', '1');
    }
    undoBtnEl.addEventListener('click', () => { undoPromptOptimization(); });
    quickBarEl.appendChild(undoBtnEl);

    // Tab 下一步幽灵建议胶囊（截断至 8 字，完整文本在 title）
    if (settings.ghostSuggest) {
      ghostEl = doc.createElement('span');
      ghostEl.id = 'agy-next-step-ghost';
      ghostEl.addEventListener('click', () => { acceptGhostSuggestion(); });
      renderGhostPill();
      quickBarEl.appendChild(ghostEl);
    }
    return quickBarEl;
  }

  function evaluateActionApproval(buttonEl, contextText) {
    const check = shouldBlockAutoAccept(contextText);
    if (check.blocked) {
      buttonEl?.setAttribute?.('data-agy-high-risk', check.labels.join(','));
      if (buttonEl?.style?.setProperty) {
        buttonEl.style.setProperty('border-color', '#ef4444');
        buttonEl.style.setProperty('color', '#ef4444');
      }
      ctx.events.emit('composer:high-risk-detected@1', { labels: check.labels });
      return { executed: false, blocked: true, labels: check.labels };
    }
    if (!settings.autoAccept) {
      return { executed: false, blocked: false, reason: 'autoAccept_disabled' };
    }
    if (typeof buttonEl?.click === 'function') {
      buttonEl.click();
      return { executed: true, blocked: false };
    }
    return { executed: false, blocked: false, reason: 'no_clickable_button' };
  }

  function evaluateContextSnapshot(snap) {
    latestContextSnap = snap || null;
    if (!settings.autoCompact) return { triggered: false, reason: 'autoCompact_disabled' };
    if (!snap || typeof snap.used !== 'number') return { triggered: false, reason: 'no_usage' };
    const threshold = Number(settings.autoCompactThresholdTokens) > 0 ? Number(settings.autoCompactThresholdTokens) : 240000;
    const hitCliff = Boolean(snap.cacheDropDetected) || snap.used >= threshold;
    if (!hitCliff) return { triggered: false, reason: 'below_threshold' };
    if (ctx.hostDom?.isAssistantBusy?.()) return { triggered: false, reason: 'assistant_busy' };
    const cooldown = Number(settings.autoCompactCooldownMs) > 0 ? Number(settings.autoCompactCooldownMs) : 300000;
    const now = Date.now();
    if (lastCompactAt > 0 && now - lastCompactAt < cooldown) {
      return { triggered: false, reason: 'cooldown' };
    }
    const sent = ctx.hostDom?.sendText?.('/compact');
    if (sent) {
      lastCompactAt = now;
      ctx.events.emit('composer:auto-compact-triggered@1', { used: snap.used, threshold });
      return { triggered: true, sent: true };
    }
    return { triggered: false, reason: 'send_failed' };
  }

  const onDocKeyDown = (e) => {
    if (!e) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      clearPromptOptUndoState();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const ed = ctx.anchors.query('composer.editor');
    const isEditorEmpty = !String(ed?.textContent || '').trim();
    if (!settings.ghostSuggest || ghostDismissed || !isEditorEmpty) return;

    if (e.key === 'Tab' || e.key === 'ArrowRight') {
      if (acceptGhostSuggestion()) {
        e.preventDefault?.();
        e.stopPropagation?.();
      }
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (cycleGhostSuggestion(e.key === 'ArrowDown' ? 1 : -1)) {
        e.preventDefault?.();
        e.stopPropagation?.();
      }
    } else if (e.key === 'Escape') {
      ghostDismissed = true;
      renderGhostPill();
      e.preventDefault?.();
      e.stopPropagation?.();
    }
  };

  const onDocInput = () => {
    clearPromptOptUndoState();
  };

  doc?.addEventListener?.('keydown', onDocKeyDown, true);
  doc?.addEventListener?.('input', onDocInput, true);

  const stopComposerObs = ctx.anchors.observe('composer.root', (el) => {
    if (el) renderQuickBar(el);
  });

  const stopActionObs = ctx.anchors.observe('chat.actionButtons', () => {
    const btns = ctx.anchors.queryAll('chat.actionButtons');
    for (const btn of btns) {
      const txt = btn.getAttribute?.('data-command') || btn.parentElement?.textContent || btn.textContent || '';
      if (/^(?:Accept|Run|Allow|继续|运行|允许)/i.test(String(btn.textContent || '').trim()) || shouldBlockAutoAccept(txt).blocked) {
        evaluateActionApproval(btn, txt);
      }
    }
  });

  const stopContextSub = ctx.state.subscribe('state:context.snapshot@1', (snap) => {
    evaluateContextSnapshot(snap);
  });

  const stopSvc = ctx.services.provide('composer', {
    registerQuickAction(def) {
      if (!def?.id) throw new Error('registerQuickAction requires id');
      extraActions.set(def.id, def);
      renderQuickBar(ctx.anchors.query('composer.root'));
      return () => {
        extraActions.delete(def.id);
        renderQuickBar(ctx.anchors.query('composer.root'));
      };
    },
    optimizePrompt: runPromptOptimization,
    undoPromptOptimization,
    acceptGhostSuggestion,
    cycleGhostSuggestion,
    evaluateActionApproval,
    evaluateContextSnapshot,
    updateSettings(patch = {}) {
      settings = { ...settings, ...patch };
      renderQuickBar(ctx.anchors.query('composer.root'));
      return { ...settings };
    },
    getSettings: () => ({ ...settings })
  });

  const stopSection = ctx.settings.registerSection({
    id: 'composer-settings',
    title: { 'zh-CN': '输入框增强与安全自动化', en: 'Composer Enhancements' },
    values: settings,
    onChange(key, value) {
      settings = { ...settings, [key]: value };
      renderQuickBar(ctx.anchors.query('composer.root'));
      void ctx.bridge.post('/settings', { action: 'save', values: { [key]: value } }).catch(() => {});
    }
  });

  const initialRoot = ctx.anchors.query('composer.root');
  if (initialRoot) renderQuickBar(initialRoot);

  disposers.push(
    stopSvc,
    stopSection,
    stopComposerObs,
    stopActionObs,
    stopContextSub,
    () => doc?.removeEventListener?.('keydown', onDocKeyDown, true),
    () => doc?.removeEventListener?.('input', onDocInput, true),
    () => { if (quickBarEl?.remove) quickBarEl.remove(); quickBarEl = null; ghostEl = null; optBtnEl = null; undoBtnEl = null; },
    () => extraActions.clear()
  );
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  mount,
  dispose
};
