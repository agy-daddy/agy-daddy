'use strict';

const { COMPOSER_STYLES } = require('./styles');
const { shouldBlockAutoAccept } = require('./high-risk-guard');
const {
  BUILTIN_QUICK_POOL,
  DEFAULT_QUICK_ITEMS,
  DEFAULT_OPTIMIZER_SHORTCUT,
  DEFAULT_OPTIMIZER_PROMPT,
  matchesShortcutEvent,
  truncateGhostLabel,
  parseSlashCommandText,
  formatQuickItemDisplayLabel,
  resolveConfiguredQuickItems,
  resolveContextualQuickItems,
  getGhostSuggestions,
  optimizePromptText
} = require('./quick-prompts');

const PROMPT_OPT_INTELLIGENT_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg>';
const PROMPT_OPT_LOADING_SVG = '<svg class="agy-opt-spin" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-opacity="0.24" stroke-width="1.8"/><path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const PROMPT_OPT_UNDO_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>';
const PERCEPTION_SPARK_SVG = '<svg width="11.5" height="11.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>';

const QUICK_ITEM_ICONS = Object.freeze({
  compact: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/></svg>',
  plan: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/></svg>',
  'grill-me': '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.8-2.5 2.2-2.5 3.8"/><path d="M12 17h.01"/></svg>',
  btw: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  learn: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  goal: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/></svg>',
  boost: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  swarm: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.2 7.5 15.8 7.5"/><path d="M7.3 8.2 10.7 15.8"/><path d="M16.7 8.2 13.3 15.8"/></svg>',
  teamwork: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="3"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a3 3 0 0 1 0 5.74"/></svg>',
  browser: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8"/><path d="M3.6 15h16.8"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>',
  schedule: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  reload: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
  slash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  default: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>'
});

function resolveQuickItemIconSvg(item) {
  const id = String(item?.id || '').trim();
  if (id && Object.prototype.hasOwnProperty.call(QUICK_ITEM_ICONS, id)) {
    return QUICK_ITEM_ICONS[id];
  }
  if (item?.slash || String(item?.text || '').trim().startsWith('/')) {
    return QUICK_ITEM_ICONS.slash;
  }
  return QUICK_ITEM_ICONS.default;
}

const SCHEMA_SETTING_KEYS = Object.freeze([
  'showQuickBar',
  'ghostSuggest',
  'contextAwareQuickItems',
  'quickItems',
  'showPromptOptimizer',
  'optimizerShortcut',
  'optimizerPrompt',
  'autoAccept'
]);

const DEFAULT_SETTINGS = Object.freeze({
  showQuickBar: true,
  ghostSuggest: true,
  contextAwareQuickItems: true,
  quickItems: [...DEFAULT_QUICK_ITEMS],
  showPromptOptimizer: true,
  optimizerShortcut: DEFAULT_OPTIMIZER_SHORTCUT,
  optimizerPrompt: DEFAULT_OPTIMIZER_PROMPT,
  autoAccept: false
});

let disposers = [];

async function mount(ctx, options = {}) {
  let settings = {
    ...DEFAULT_SETTINGS,
    quickPoolState: Object.fromEntries(BUILTIN_QUICK_POOL.map((q) => [q.id, Boolean(q.defaultEnabled)])),
    customQuickPrompts: [],
    ...(ctx.settings?.get?.() || {})
  };
  // 安全不变式：默认关闭自动批准
  settings.autoAccept = settings.autoAccept === true;
  settings.contextAwareQuickItems = settings.contextAwareQuickItems !== false;
  settings.showPromptOptimizer = settings.showPromptOptimizer !== false;
  settings.optimizerShortcut = typeof settings.optimizerShortcut === 'string'
    ? settings.optimizerShortcut.trim()
    : DEFAULT_OPTIMIZER_SHORTCUT;
  if (!Array.isArray(settings.quickItems)) {
    settings.quickItems = [...DEFAULT_QUICK_ITEMS];
  }

  const stopStyles = ctx.styles?.inject?.(COMPOSER_STYLES, {
    scope: 'document',
    id: 'composer-styles'
  });

  const doc = options.document
    || ctx.anchors.query('composer.root')?.ownerDocument
    || ctx.anchors.query('composer.editor')?.ownerDocument
    || globalThis.document;

  const extraActions = new Map();
  let ownBarNodes = [];
  let quickBarEl = null;
  let quickBarHostParent = null;
  let revokeQuickActionsSurface = null;
  let ghostEl = null;
  let ghostAcceptBtn = null;
  let ghostTextSpan = null;
  let ghostCycleBtn = null;
  let optWrapEl = null;
  let optStatusEl = null;
  let optBtnEl = null;
  let undoBtnEl = null;
  let toastEl = null;
  let floatToastEl = null;
  let toastTimer = null;
  let activeToastState = null;
  let latestContextSnap = null;
  let ghostCandidates = getGhostSuggestions('');
  let ghostIndex = 0;
  let ghostDismissed = false;
  let lastGhostSig = '';
  let promptOptUndoState = null;
  let promptOptLoading = false;
  let isProgrammaticFill = false;
  let lastRenderSig = '';
  let mutDebounceTimer = null;
  let slashConversionSeq = 0;
  let isDisposed = false;
  const slashConversionTimers = new Set();

  function waitTracked(ms) {
    return new Promise((resolve) => {
      const tid = setTimeout(() => {
        slashConversionTimers.delete(tid);
        resolve();
      }, ms);
      slashConversionTimers.add(tid);
    });
  }

  function clearOwnBarNodes() {
    while (ownBarNodes.length > 0) {
      const node = ownBarNodes.pop();
      if (node?.remove) node.remove();
    }
    ghostEl = null;
    ghostAcceptBtn = null;
    ghostTextSpan = null;
    ghostCycleBtn = null;
    toastEl = null;
  }

  function teardownPromptOptimizer() {
    if (optWrapEl?.remove) optWrapEl.remove();
    optWrapEl = null;
    optStatusEl = null;
    optBtnEl = null;
    undoBtnEl = null;
  }

  function removeFloatToast() {
    if (floatToastEl?.remove) floatToastEl.remove();
    floatToastEl = null;
  }

  function teardownQuickBar() {
    if (isDisposed && toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
      activeToastState = null;
    }
    clearOwnBarNodes();
    if (typeof revokeQuickActionsSurface === 'function') {
      try { revokeQuickActionsSurface(); } catch {}
      revokeQuickActionsSurface = null;
    }
    if (quickBarEl?.remove) quickBarEl.remove();
    quickBarEl = null;
    quickBarHostParent = null;
    lastRenderSig = '';
  }

  function getComposerEditor() {
    const direct = ctx.anchors.query('composer.editor');
    if (direct) return direct;
    if (typeof doc?.querySelector === 'function') {
      return (
        doc.querySelector('[data-lexical-editor="true"]')
        || doc.querySelector('[aria-label="Message input"][contenteditable="true"]')
        || doc.querySelector('[aria-label="消息输入"][contenteditable="true"]')
        || doc.querySelector('[role="textbox"][contenteditable="true"]')
        || doc.querySelector('[contenteditable="true"]')
      );
    }
    return null;
  }

  function getComposerText(editor) {
    if (!editor) return '';
    const raw = typeof editor.__lexicalTextContent === 'string'
      ? editor.__lexicalTextContent
      : (typeof editor.innerText === 'string' && editor.innerText.length > 0
          ? editor.innerText
          : (editor.textContent || ''));
    return String(raw).replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  function resolveComposerRoot() {
    let root = ctx.anchors.query('composer.root');
    if (root) {
      const isFooter = String(root.className || '').split(/\s+/).includes('agy-composer-footer');
      if (isFooter && typeof root.closest === 'function') {
        root = root.closest('.surface-composer, [data-testid="agent-input-box"]') || root.parentElement || root;
      }
      return root;
    }
    const ed = getComposerEditor();
    if (!ed) return null;
    if (typeof ed.closest === 'function') {
      const container = ed.closest('.surface-composer, [data-testid="agent-input-box"], form');
      if (container) return container;
    }
    let cur = ed.parentElement;
    for (let depth = 0; depth < 3 && cur && cur !== doc?.body && cur !== doc?.documentElement; depth++) {
      if (typeof cur.querySelector === 'function' && cur.querySelector('button')) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return ed.parentElement || null;
  }

  function normalizeTextForCompare(str = '') {
    return String(str ?? '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n+$/, '');
  }

  function normalizeCollapsedLines(str = '') {
    return normalizeTextForCompare(str)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function doesEditorMatchTarget(editor, targetStr = '') {
    const expected = normalizeTextForCompare(targetStr);
    if (!expected) return !hasPendingComposerContent(editor);
    const actual = normalizeTextForCompare(getComposerText(editor));
    if (actual === expected) return true;
    const expectedLines = normalizeCollapsedLines(expected);
    const actualLines = normalizeCollapsedLines(actual);
    if (expectedLines.length === 0 || actualLines.length !== expectedLines.length) return false;
    return expectedLines.every((line, idx) => actualLines[idx] === line);
  }

  function doesEditorAppendMatch(editor, beforeNormalized = '', appendedStr = '') {
    const expected = normalizeTextForCompare(appendedStr);
    if (!expected) return true;
    const actual = normalizeTextForCompare(getComposerText(editor));
    if (actual === beforeNormalized) return false;
    if (actual.endsWith(expected)) return true;
    const expectedLines = normalizeCollapsedLines(expected);
    const actualLines = normalizeCollapsedLines(actual);
    if (expectedLines.length === 0 || actualLines.length < expectedLines.length) return false;
    const tailOffset = actualLines.length - expectedLines.length;
    return expectedLines.every((line, idx) => actualLines[tailOffset + idx] === line);
  }

  function getSelectionSafe() {
    if (typeof globalThis.getSelection === 'function') return globalThis.getSelection();
    if (typeof doc?.defaultView?.getSelection === 'function') return doc.defaultView.getSelection();
    return null;
  }

  function getDomCtor(name) {
    if (typeof globalThis[name] === 'function') return globalThis[name];
    if (typeof doc?.defaultView?.[name] === 'function') return doc.defaultView[name];
    return null;
  }

  function dispatchSelectionChange() {
    const EventCtor = getDomCtor('Event');
    if (!EventCtor) return;
    try {
      doc?.dispatchEvent?.(new EventCtor('selectionchange'));
    } catch {}
  }

  function isNodeInsideEditor(node, editor) {
    if (!node || !editor) return false;
    if (node === editor) return true;
    if (typeof editor.contains === 'function') {
      try { return Boolean(editor.contains(node)); } catch {}
    }
    let cur = node.parentNode || node.parentElement || null;
    while (cur) {
      if (cur === editor) return true;
      cur = cur.parentNode || cur.parentElement || null;
    }
    return false;
  }

  function collapseCaretToEnd(editor) {
    if (!editor || !doc) return;
    try {
      const sel = getSelectionSafe();
      if (sel && typeof doc.createRange === 'function') {
        const range = doc.createRange();
        const lastEl = editor.lastElementChild || null;
        const canTargetLastChild = Boolean(
          lastEl
          && String(lastEl.tagName || '').toUpperCase() !== 'BR'
          && !lastEl.getAttribute?.('data-lexical-decorator')
          && !lastEl.getAttribute?.('data-uri')
          && !lastEl.querySelector?.('[data-lexical-decorator], [data-uri]')
        );
        range.selectNodeContents(canTargetLastChild ? lastEl : editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      dispatchSelectionChange();
    } catch {}
  }

  function hasPendingComposerContent(editor) {
    if (!editor) return false;
    if (getComposerText(editor).trim().length > 0) return true;
    return Boolean(editor.querySelector?.('[data-lexical-decorator], [data-uri]'));
  }

  function selectAllInComposer(editor, { triggerKeydown = false } = {}) {
    if (!editor || !doc) return;
    try {
      editor.focus?.();
      const sel = getSelectionSafe();
      if (sel && typeof doc.createRange === 'function') {
        const range = doc.createRange();
        range.selectNodeContents(editor);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      doc.execCommand?.('selectAll', false, null);
      if (sel && typeof doc.createRange === 'function' && !isNodeInsideEditor(sel.anchorNode, editor)) {
        const range = doc.createRange();
        range.selectNodeContents(editor);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      const KeyboardEventCtor = triggerKeydown ? getDomCtor('KeyboardEvent') : null;
      if (KeyboardEventCtor) {
        const isMac = typeof globalThis.navigator !== 'undefined'
          && /Mac|iPhone|iPad|iPod/i.test(String(globalThis.navigator.platform || globalThis.navigator.userAgent || ''));
        editor.dispatchEvent?.(new KeyboardEventCtor('keydown', {
          key: 'a',
          code: 'KeyA',
          keyCode: 65,
          which: 65,
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
          cancelable: true
        }));
      }
      dispatchSelectionChange();
    } catch {}
  }

  function deleteSelectionInComposer(editor) {
    if (!editor || !doc) return false;
    let ok = false;
    let capturedBeforeInput = null;
    const onBeforeInput = (ev) => {
      if (!ev) return;
      if (!ev.inputType || ev.inputType.startsWith('delete')) {
        capturedBeforeInput = ev;
      }
    };
    const canListenDoc = typeof doc.addEventListener === 'function' && typeof doc.removeEventListener === 'function';
    const canListenEd = typeof editor.addEventListener === 'function' && typeof editor.removeEventListener === 'function';
    if (canListenDoc) doc.addEventListener('beforeinput', onBeforeInput, true);
    if (canListenEd) editor.addEventListener('beforeinput', onBeforeInput, true);
    try {
      if (typeof doc.execCommand === 'function') {
        ok = Boolean(doc.execCommand('delete', false, null));
      }
    } finally {
      if (canListenDoc) doc.removeEventListener('beforeinput', onBeforeInput, true);
      if (canListenEd) editor.removeEventListener('beforeinput', onBeforeInput, true);
    }
    const prevented = Boolean(capturedBeforeInput && capturedBeforeInput.defaultPrevented);
    const InputEventCtor = getDomCtor('InputEvent');
    if (!ok && !prevented && hasPendingComposerContent(editor) && InputEventCtor) {
      try {
        editor.dispatchEvent?.(new InputEventCtor('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'deleteContentBackward'
        }));
      } catch {}
    }
    return Boolean(ok || prevented || !hasPendingComposerContent(editor));
  }

  async function clearComposerEditorAsync(editor) {
    if (!editor) return false;
    if (!hasPendingComposerContent(editor)) return true;
    if (typeof doc?.execCommand !== 'function') {
      isProgrammaticFill = true;
      try {
        editor.textContent = '';
      } finally {
        isProgrammaticFill = false;
      }
      return true;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      selectAllInComposer(editor, { triggerKeydown: attempt >= 1 });
      await waitTracked(18);
      if (isDisposed) return false;
      deleteSelectionInComposer(editor);
      await waitTracked(18);
      if (isDisposed) return false;
      if (!hasPendingComposerContent(editor)) return true;
    }
    return !hasPendingComposerContent(editor);
  }

  function tryPasteComposerText(editor, str) {
    if (!editor) return { supported: false, handled: false };
    const ClipboardEventCtor = getDomCtor('ClipboardEvent');
    const DataTransferCtor = getDomCtor('DataTransfer');
    if (!ClipboardEventCtor || !DataTransferCtor) {
      return { supported: false, handled: false };
    }
    try {
      const dt = new DataTransferCtor();
      dt.setData('text/plain', str);
      const pasteEv = new ClipboardEventCtor('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      if (!pasteEv.clipboardData) {
        try {
          Object.defineProperty(pasteEv, 'clipboardData', { value: dt, configurable: true });
        } catch {}
      }
      editor.dispatchEvent?.(pasteEv);
      return { supported: true, handled: Boolean(pasteEv.defaultPrevented) };
    } catch {
      return { supported: false, handled: false };
    }
  }

  function insertSoftLineBreak(editor) {
    if (!editor || !doc) return false;
    let ok = false;
    let capturedBeforeInput = null;
    const onBeforeInput = (ev) => {
      if (!ev) return;
      if (!ev.inputType || ev.inputType === 'insertLineBreak' || ev.inputType === 'insertParagraph') {
        capturedBeforeInput = ev;
      }
    };
    const canListenDoc = typeof doc.addEventListener === 'function' && typeof doc.removeEventListener === 'function';
    const canListenEd = typeof editor.addEventListener === 'function' && typeof editor.removeEventListener === 'function';
    if (canListenDoc) doc.addEventListener('beforeinput', onBeforeInput, true);
    if (canListenEd) editor.addEventListener('beforeinput', onBeforeInput, true);
    try {
      if (typeof doc.execCommand === 'function') {
        ok = Boolean(doc.execCommand('insertLineBreak', false, null));
      }
    } finally {
      if (canListenDoc) doc.removeEventListener('beforeinput', onBeforeInput, true);
      if (canListenEd) editor.removeEventListener('beforeinput', onBeforeInput, true);
    }
    const prevented = Boolean(capturedBeforeInput && capturedBeforeInput.defaultPrevented);
    if (ok || prevented) return true;
    const InputEventCtor = getDomCtor('InputEvent');
    if (InputEventCtor) {
      try {
        const inp = new InputEventCtor('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertLineBreak'
        });
        editor.dispatchEvent?.(inp);
        if (inp.defaultPrevented) return true;
      } catch {}
    }
    const KeyboardEventCtor = getDomCtor('KeyboardEvent');
    if (KeyboardEventCtor) {
      try {
        const shiftEnter = new KeyboardEventCtor('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          shiftKey: true,
          bubbles: true,
          cancelable: true
        });
        editor.dispatchEvent?.(shiftEnter);
        return Boolean(shiftEnter.defaultPrevented);
      } catch {}
    }
    return false;
  }

  function insertRawComposerText(editor, str) {
    if (!editor || !doc) return false;
    const targetStr = String(str ?? '');
    const beforeText = getComposerText(editor).replace(/\r?\n$/, '');
    let ok = false;
    let capturedBeforeInput = null;
    if (typeof doc.execCommand === 'function') {
      const onBeforeInput = (ev) => {
        if (!ev) return;
        if (!ev.inputType || ev.inputType === 'insertText') {
          capturedBeforeInput = ev;
        }
      };
      const canListenDoc = typeof doc.addEventListener === 'function' && typeof doc.removeEventListener === 'function';
      const canListenEd = typeof editor.addEventListener === 'function' && typeof editor.removeEventListener === 'function';
      if (canListenDoc) doc.addEventListener('beforeinput', onBeforeInput, true);
      if (canListenEd) editor.addEventListener('beforeinput', onBeforeInput, true);
      try {
        ok = Boolean(doc.execCommand('insertText', false, targetStr));
      } finally {
        if (canListenDoc) doc.removeEventListener('beforeinput', onBeforeInput, true);
        if (canListenEd) editor.removeEventListener('beforeinput', onBeforeInput, true);
      }
    }
    const prevented = Boolean(capturedBeforeInput && capturedBeforeInput.defaultPrevented);
    const afterText = getComposerText(editor).replace(/\r?\n$/, '');
    const textApplied = Boolean(targetStr) && afterText !== beforeText && (afterText === targetStr || afterText.endsWith(targetStr));
    const InputEventCtor = getDomCtor('InputEvent');
    if (!ok && !prevented && !textApplied && InputEventCtor) {
      try {
        editor.dispatchEvent?.(new InputEventCtor('beforeinput', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: targetStr
        }));
      } catch {}
    }
    return Boolean(ok || prevented || textApplied);
  }

  function fillComposerText(editor, text, fillOpts = {}) {
    if (!editor) return false;
    const str = String(text ?? '');
    const append = fillOpts?.append === true;
    isProgrammaticFill = true;
    try {
      if (typeof doc?.execCommand === 'function') {
        try {
          editor.focus?.();
          if (!append) {
            selectAllInComposer(editor);
            deleteSelectionInComposer(editor);
          }
          collapseCaretToEnd(editor);
          const ok = insertRawComposerText(editor, str);
          const normalizedCurrent = getComposerText(editor).replace(/\r?\n$/, '');
          const normalizedTarget = str.replace(/\r?\n$/, '');
          if (ok || !str || normalizedCurrent === normalizedTarget) {
            return true;
          }
        } catch {}
      }
      editor.textContent = append ? (getComposerText(editor) + str) : str;
      return true;
    } finally {
      isProgrammaticFill = false;
    }
  }

  async function replaceComposerTextAsync(editor, text, fillOpts = {}) {
    if (!editor) return false;
    const str = String(text ?? '').replace(/\r\n?/g, '\n');
    const append = fillOpts?.append === true;

    if (typeof doc?.execCommand !== 'function') {
      isProgrammaticFill = true;
      try {
        editor.textContent = append ? (getComposerText(editor) + str) : str;
        return true;
      } finally {
        isProgrammaticFill = false;
      }
    }

    isProgrammaticFill = true;
    try {
      if (!append) {
        await clearComposerEditorAsync(editor);
        if (isDisposed) return false;
      }
      if (!str) {
        return !hasPendingComposerContent(editor);
      }

      editor.focus?.();
      const sel = getSelectionSafe();
      if (append || !sel || !isNodeInsideEditor(sel.anchorNode, editor)) {
        collapseCaretToEnd(editor);
        await waitTracked(16);
        if (isDisposed) return false;
      } else {
        dispatchSelectionChange();
      }

      const beforeText = normalizeTextForCompare(getComposerText(editor));
      const checkApplied = () => (append
        ? doesEditorAppendMatch(editor, beforeText, str)
        : doesEditorMatchTarget(editor, str));

      // 策略 1：多行或显式要求时优先使用原子纯文本粘贴，避免 Blink 拆分换行引发 Lexical 乱序
      if (fillOpts?.preferPaste || str.includes('\n')) {
        const pasteRes = tryPasteComposerText(editor, str);
        if (pasteRes.supported) {
          if (pasteRes.handled) {
            for (const delayMs of [24, 30, 40]) {
              await waitTracked(delayMs);
              if (isDisposed) return false;
              if (checkApplied()) return true;
            }
          } else {
            await waitTracked(20);
            if (isDisposed) return false;
            if (checkApplied()) return true;
          }
          if (!append && hasPendingComposerContent(editor)) {
            await clearComposerEditorAsync(editor);
            if (isDisposed) return false;
            collapseCaretToEnd(editor);
            await waitTracked(16);
            if (isDisposed) return false;
          }
        }
      }

      // 策略 2：逐行单行插入 + 软换行，绝不向 execCommand('insertText') 传入含 \n 的字符串
      if (!str.includes('\n')) {
        insertRawComposerText(editor, str);
        await waitTracked(18);
        if (isDisposed) return false;
        if (checkApplied()) return true;
      } else {
        const lines = str.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.length > 0) {
            insertRawComposerText(editor, line);
            await waitTracked(16);
            if (isDisposed) return false;
          }
          if (i < lines.length - 1) {
            insertSoftLineBreak(editor);
            await waitTracked(16);
            if (isDisposed) return false;
          }
        }
        if (checkApplied()) return true;
      }

      // 策略 3：仅在普通非事件驱动编辑器仍为空时回退 textContent
      if (!hasPendingComposerContent(editor)) {
        editor.textContent = append ? (getComposerText(editor) + str) : str;
        return true;
      }
      return checkApplied();
    } finally {
      isProgrammaticFill = false;
    }
  }

  function formatPromptOptError(rawErr, res = null, meta = {}) {
    const raw = String(rawErr || '').trim();
    const fromBridgeTransport = Boolean(meta?.fromBridgeTransport);
    let message = '';
    if (!raw) {
      message = '提示词优化失败，请重试';
    } else if (/Forbidden token|Forbidden origin/i.test(raw)) {
      message = '底座桥接鉴权已过期，请重载插件或刷新窗口';
    } else if (/Route not found/i.test(raw)) {
      message = '提示词优化路由未注册，请重载插件';
    } else if (fromBridgeTransport && /Bridge unavailable|Failed to fetch|ECONNREFUSED|NetworkError/i.test(raw)) {
      message = '底座桥接服务不可用，请确认 Agy-Daddy 已运行';
    } else if (!fromBridgeTransport && /Unable to resolve LanguageServer RPC credentials|ECONNREFUSED|ECONNRESET|socket hang up/i.test(raw)) {
      message = '未能连接 Antigravity 语言服务，请确认已登录并重试';
    } else if (/HTTP 401|HTTP 403/i.test(raw)) {
      message = 'Antigravity 登录态已失效，请重新登录后重试';
    } else if (/ROUTE_TIMEOUT|\bETIMEDOUT\b|timeout|HTTP 502|HTTP 504/i.test(raw)) {
      const attemptSuffix = (raw.match(/（已尝试\s*\d+\s*个模型）/) || [])[0] || '';
      message = `提示词优化超时，请稍后重试${attemptSuffix}`;
    } else if (/(?:失败|超时|先输入|无需|未能|不可用|错误)/.test(raw)) {
      message = raw;
    } else {
      message = `优化失败：${raw}`;
    }
    const detail = String(res?.detail || '').trim();
    const title = detail && detail !== message ? `${message}\n${detail}` : message;
    return { message, title };
  }

  function syncQuickBarToastVisible(toastVisible) {
    if (!quickBarEl) return;
    const val = toastVisible ? 'true' : 'false';
    quickBarEl.setAttribute?.('data-toast-visible', val);
    if (quickBarEl.dataset) {
      quickBarEl.dataset.toastVisible = val;
    }
  }

  function applyToastElementState(el, stateObj) {
    if (!el) return;
    const msg = stateObj && typeof stateObj.message === 'string' ? stateObj.message.trim() : '';
    if (el === toastEl) {
      syncQuickBarToastVisible(Boolean(msg));
    }
    if (!msg) {
      el.textContent = '';
      el.hidden = true;
      el.setAttribute?.('hidden', 'true');
      el.removeAttribute?.('data-tone');
      el.removeAttribute?.('title');
      return;
    }
    el.textContent = msg;
    el.hidden = false;
    el.removeAttribute?.('hidden');
    if (el.style) el.style.display = '';
    if (stateObj.tone) el.setAttribute?.('data-tone', stateObj.tone);
    else el.removeAttribute?.('data-tone');
    el.setAttribute?.('title', String(stateObj.title || msg));
  }

  function ensureFloatToastEl() {
    if (!doc?.createElement) return null;
    const rootEl = resolveComposerRoot();
    const mountParent = rootEl?.parentElement || doc.body || null;
    if (!mountParent) return null;
    if (!floatToastEl) {
      floatToastEl = doc.createElement('div');
      floatToastEl.id = 'agy-composer-float-toast';
      floatToastEl.setAttribute?.('role', 'status');
      floatToastEl.setAttribute?.('aria-live', 'polite');
      floatToastEl.hidden = true;
      floatToastEl.setAttribute?.('hidden', 'true');
      floatToastEl.addEventListener('mousedown', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
      });
      floatToastEl.addEventListener('click', () => {
        showQuickToast('');
      });
    }
    const kids = Array.from(mountParent.children || []);
    const fIdx = kids.indexOf(floatToastEl);
    const rIdx = rootEl ? kids.indexOf(rootEl) : -1;
    const needMove = floatToastEl.parentElement !== mountParent || (rootEl && rIdx >= 0 && fIdx !== rIdx - 1);
    if (needMove) {
      if (rootEl && rootEl.parentElement === mountParent && typeof mountParent.insertBefore === 'function') {
        mountParent.insertBefore(floatToastEl, rootEl);
      } else {
        mountParent.appendChild?.(floatToastEl);
      }
    }
    return floatToastEl;
  }

  function showQuickToast(message, opts = {}) {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    const msg = String(message || '').trim();
    if (!msg) {
      activeToastState = null;
      applyToastElementState(toastEl, null);
      syncQuickBarToastVisible(false);
      applyToastElementState(optStatusEl, null);
      removeFloatToast();
      optBtnEl?.removeAttribute?.('data-error');
      return;
    }
    const durationMs = Number(opts.durationMs) > 0
      ? Number(opts.durationMs)
      : (opts.tone === 'error' ? 5000 : 2800);
    const stateObj = {
      message: msg,
      tone: opts.tone || '',
      title: String(opts.title || msg),
      target: opts.target || 'quick',
      expiresAt: opts.persistent ? Infinity : (Date.now() + durationMs)
    };
    activeToastState = stateObj;

    const isOptimizerToast = stateObj.target === 'optimizer';
    let shownInQuick = false;
    let shownInOpt = false;
    if (isOptimizerToast) {
      if (optStatusEl) {
        applyToastElementState(optStatusEl, stateObj);
        shownInOpt = true;
        applyToastElementState(toastEl, null);
      } else if (toastEl) {
        applyToastElementState(toastEl, stateObj);
        shownInQuick = true;
      }
      if (optBtnEl) {
        if (stateObj.tone === 'error') optBtnEl.setAttribute?.('data-error', 'true');
        else optBtnEl.removeAttribute?.('data-error');
      }
    } else {
      applyToastElementState(optStatusEl, null);
      optBtnEl?.removeAttribute?.('data-error');
      if (toastEl) {
        applyToastElementState(toastEl, stateObj);
        shownInQuick = true;
      }
    }

    if (!shownInQuick && !shownInOpt) {
      syncQuickBarToastVisible(false);
      const fEl = ensureFloatToastEl();
      applyToastElementState(fEl, stateObj);
    } else {
      syncQuickBarToastVisible(shownInQuick);
      removeFloatToast();
    }

    if (!opts.persistent) {
      toastTimer = setTimeout(() => {
        toastTimer = null;
        showQuickToast('');
      }, durationMs);
    }
  }

  function setButtonVisible(btn, visible) {
    if (!btn) return;
    btn.hidden = !visible;
    if (visible) {
      btn.removeAttribute?.('hidden');
      btn.setAttribute?.('data-visible', '1');
      if (btn.style) btn.style.display = '';
    } else {
      btn.setAttribute?.('hidden', 'true');
      btn.setAttribute?.('data-visible', '0');
      if (btn.style) btn.style.display = 'none';
    }
  }

  function syncPromptOptimizerUI() {
    const ed = getComposerEditor();
    const curText = getComposerText(ed);
    const hasText = curText.trim().length > 0;
    if (!hasText && !promptOptLoading && promptOptUndoState) {
      promptOptUndoState = null;
    }
    const isUndoVisible = Boolean(promptOptUndoState && !promptOptLoading && hasText);
    const shortcutLabel = typeof settings.optimizerShortcut === 'string' ? settings.optimizerShortcut.trim() : '';
    const shortcutHint = shortcutLabel ? `（${shortcutLabel}）` : '';

    if (optBtnEl) {
      if (isUndoVisible) {
        setButtonVisible(optBtnEl, false);
        optBtnEl.disabled = true;
        optBtnEl.removeAttribute?.('data-loading');
        optBtnEl.removeAttribute?.('aria-busy');
        optBtnEl.setAttribute?.('title', `优化提示词${shortcutHint}`);
        optBtnEl.setAttribute?.('aria-label', '优化提示词');
      } else {
        setButtonVisible(optBtnEl, true);
        if (promptOptLoading) {
          optBtnEl.disabled = true;
          optBtnEl.setAttribute?.('data-loading', 'true');
          optBtnEl.setAttribute?.('aria-busy', 'true');
          if (optBtnEl.getAttribute?.('data-icon-state') !== 'loading') {
            optBtnEl.innerHTML = PROMPT_OPT_LOADING_SVG;
            optBtnEl.setAttribute?.('data-icon-state', 'loading');
          }
          optBtnEl.setAttribute?.('title', '正在优化提示词，请稍候…');
          optBtnEl.setAttribute?.('aria-label', '正在优化提示词');
        } else {
          optBtnEl.removeAttribute?.('data-loading');
          optBtnEl.removeAttribute?.('aria-busy');
          optBtnEl.disabled = !hasText;
          if (optBtnEl.getAttribute?.('data-icon-state') !== 'idle') {
            optBtnEl.innerHTML = PROMPT_OPT_INTELLIGENT_SVG;
            optBtnEl.setAttribute?.('data-icon-state', 'idle');
          }
          optBtnEl.setAttribute?.('title', hasText
            ? `优化提示词${shortcutHint}`
            : `先输入提示词草稿，再点击优化${shortcutHint}`);
          optBtnEl.setAttribute?.('aria-label', '优化提示词');
        }
      }
    }

    if (undoBtnEl) {
      if (isUndoVisible) {
        setButtonVisible(undoBtnEl, true);
        undoBtnEl.disabled = false;
        if (undoBtnEl.getAttribute?.('data-icon-state') !== 'undo') {
          undoBtnEl.innerHTML = PROMPT_OPT_UNDO_SVG;
          undoBtnEl.setAttribute?.('data-icon-state', 'undo');
        }
        undoBtnEl.setAttribute?.('title', `撤回优化，恢复原始草稿${shortcutHint}`);
        undoBtnEl.setAttribute?.('aria-label', '撤回优化');
      } else {
        setButtonVisible(undoBtnEl, false);
        undoBtnEl.disabled = true;
      }
    }
  }

  function clearPromptOptUndoState() {
    promptOptUndoState = null;
    syncPromptOptimizerUI();
  }

  function findMatchingSlashOption(cmdName) {
    const lower = String(cmdName || '').trim().replace(/^\/+/, '').toLowerCase();
    if (!lower || typeof doc?.querySelectorAll !== 'function') return null;
    const withSlash = `/${lower}`;
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundaryRe = new RegExp(`^\\/?${escaped}(?:$|\\s|[\\u4e00-\\u9fff])`, 'i');
    const rawOpts = Array.from(doc.querySelectorAll('[role="listbox"] [role="option"], [role="menu"] [role="menuitem"], [role="option"]') || []);
    const opts = rawOpts.filter((opt) => {
      if (!opt) return false;
      if (opt.hidden === true || opt.getAttribute?.('aria-hidden') === 'true') return false;
      if (opt.closest?.('#agy-daddy-host, #agy-quick-capsule-bar')) return false;
      return true;
    });

    for (const opt of opts) {
      const cmdAttr = String(
        opt.getAttribute?.('data-command')
        || opt.getAttribute?.('data-slash-command')
        || opt.getAttribute?.('data-value')
        || ''
      ).trim().toLowerCase();
      if (cmdAttr && (cmdAttr === lower || cmdAttr === withSlash)) return opt;
      const leaves = Array.from(opt.querySelectorAll?.('span, div, code, strong, p') || []);
      const hasExactLeaf = leaves.some((el) => {
        if (el.children && el.children.length > 0) return false;
        const txt = String(el.textContent || '').trim().toLowerCase();
        return txt === lower || txt === withSlash;
      });
      if (hasExactLeaf) return opt;
    }

    for (const opt of opts) {
      const full = String(opt.textContent || '').replace(/\s+/g, ' ').trim();
      if (boundaryRe.test(full)) {
        return opt;
      }
    }
    return null;
  }

  function triggerSlashOptionClick(opt) {
    if (!opt) return false;
    const clickTarget = opt.querySelector?.('div.cursor-pointer') || opt;
    try {
      const ev = typeof globalThis.MouseEvent === 'function'
        ? new globalThis.MouseEvent('mousedown', { bubbles: true, cancelable: true })
        : { type: 'mousedown', bubbles: true, cancelable: true };
      clickTarget.dispatchEvent?.(ev);
    } catch {}
    clickTarget.click?.();
    return true;
  }

  function submitComposerIfPending(editor) {
    if (!editor || !hasPendingComposerContent(editor)) return false;
    const sendBtn = ctx.anchors.query('composer.sendButton')
      || doc?.querySelector?.('[data-testid="input-send-button"], [data-testid="send-button"], .agy-send-button, button[aria-label*="Send"], button[aria-label*="发送"]');
    if (sendBtn && !sendBtn.disabled && typeof sendBtn.click === 'function') {
      sendBtn.click();
      return true;
    }
    if (typeof editor.dispatchEvent === 'function') {
      try {
        const enterEv = typeof globalThis.KeyboardEvent === 'function'
          ? new globalThis.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
          : { type: 'keydown', key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        editor.dispatchEvent(enterEv);
        return true;
      } catch {}
    }
    return false;
  }

  async function finishNativeSlashConversion(seq, editor, parsed, autoSend, hadExistingContent) {
    if (hadExistingContent) {
      await waitTracked(20);
      if (isDisposed || seq !== slashConversionSeq) return;
      if (hasPendingComposerContent(editor)) {
        await clearComposerEditorAsync(editor);
        if (isDisposed || seq !== slashConversionSeq) return;
      }
      isProgrammaticFill = true;
      try {
        editor.focus?.();
        collapseCaretToEnd(editor);
        insertRawComposerText(editor, parsed.commandText);
      } finally {
        isProgrammaticFill = false;
      }
      syncPromptOptimizerUI();
    }

    let matchedOpt = findMatchingSlashOption(parsed.slash);
    for (let i = 0; !matchedOpt && i < 10; i++) {
      await waitTracked(30);
      if (isDisposed || seq !== slashConversionSeq) return;
      matchedOpt = findMatchingSlashOption(parsed.slash);
    }

    if (matchedOpt) {
      triggerSlashOptionClick(matchedOpt);
      await waitTracked(40);
      if (isDisposed || seq !== slashConversionSeq) return;
      collapseCaretToEnd(editor);
      if (parsed.restText) {
        const curText = getComposerText(editor).replace(/\r?\n$/, '');
        const prefix = (curText && !/[ \t]$/.test(curText)) ? ' ' : '';
        const restPayload = `${prefix}${parsed.restText}`;
        if (restPayload.includes('\n') && typeof doc?.execCommand === 'function') {
          await replaceComposerTextAsync(editor, restPayload, { append: true, preferPaste: true });
          if (isDisposed || seq !== slashConversionSeq) return;
        } else {
          fillComposerText(editor, restPayload, { append: true });
        }
      }
      if (autoSend) {
        clearPromptOptUndoState();
        submitComposerIfPending(editor);
        showQuickToast(`已触发 /${parsed.slash} 指令`);
      } else {
        showQuickToast(`已激活 /${parsed.slash} 命令`);
      }
    } else {
      if (parsed.restText) {
        const fullFallback = `${parsed.commandText} ${parsed.restText}`;
        if (fullFallback.includes('\n') && typeof doc?.execCommand === 'function') {
          await replaceComposerTextAsync(editor, fullFallback, { preferPaste: true });
          if (isDisposed || seq !== slashConversionSeq) return;
        } else {
          fillComposerText(editor, fullFallback);
        }
      }
      if (autoSend) {
        clearPromptOptUndoState();
        const submitted = submitComposerIfPending(editor);
        if (!submitted && typeof ctx.hostDom?.sendText === 'function') {
          ctx.hostDom.sendText(parsed.restText ? `${parsed.commandText} ${parsed.restText}` : parsed.commandText);
        }
        showQuickToast(`已发送 /${parsed.slash}`);
      } else {
        showQuickToast(`已填入 /${parsed.slash}，按回车或继续输入`);
      }
    }
    syncPromptOptimizerUI();
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
    const editor = getComposerEditor();
    const parsed = parseSlashCommandText(text, itemMeta);
    if (!parsed.slash) {
      if (autoSend && typeof ctx.hostDom?.sendText === 'function') {
        clearPromptOptUndoState();
        return ctx.hostDom.sendText(text);
      }
      if (!editor) return false;
      promptOptUndoState = null;
      const str = String(text || '');
      if (typeof doc?.execCommand === 'function' && (str.includes('\n') || hasPendingComposerContent(editor))) {
        void replaceComposerTextAsync(editor, str, { preferPaste: str.includes('\n') }).finally(() => {
          if (!isDisposed) syncPromptOptimizerUI();
        });
        return true;
      }
      const ok = fillComposerText(editor, str);
      syncPromptOptimizerUI();
      return ok;
    }

    if (!editor) {
      if (autoSend && typeof ctx.hostDom?.sendText === 'function') {
        clearPromptOptUndoState();
        return ctx.hostDom.sendText(parsed.restText ? `${parsed.commandText} ${parsed.restText}` : parsed.commandText);
      }
      return false;
    }

    convertSlashToNativeCapsule(itemMeta?.slash ? itemMeta : { ...(itemMeta || {}), slash: parsed.slash, text }, editor);
    promptOptUndoState = null;
    const seq = ++slashConversionSeq;
    const canPollNativeMenu = typeof doc?.execCommand === 'function';

    if (!canPollNativeMenu) {
      const immediateOpt = findMatchingSlashOption(parsed.slash);
      if (immediateOpt) {
        fillComposerText(editor, parsed.commandText);
        triggerSlashOptionClick(immediateOpt);
        if (parsed.restText) {
          const curText = getComposerText(editor).replace(/\r?\n$/, '');
          const prefix = (curText && !/[ \t]$/.test(curText)) ? ' ' : '';
          fillComposerText(editor, `${prefix}${parsed.restText}`, { append: true });
        }
        if (autoSend) {
          clearPromptOptUndoState();
          submitComposerIfPending(editor);
          showQuickToast(`已触发 /${parsed.slash} 指令`);
        } else {
          showQuickToast(`已激活 /${parsed.slash} 命令`);
        }
        syncPromptOptimizerUI();
        return true;
      }
      const fallbackText = parsed.restText ? `${parsed.commandText} ${parsed.restText}` : parsed.commandText;
      if (autoSend && typeof ctx.hostDom?.sendText === 'function') {
        clearPromptOptUndoState();
        return ctx.hostDom.sendText(fallbackText);
      }
      const ok = fillComposerText(editor, fallbackText);
      syncPromptOptimizerUI();
      return ok;
    }

    const hadExistingContent = hasPendingComposerContent(editor);
    if (!hadExistingContent) {
      fillComposerText(editor, parsed.commandText);
    } else {
      isProgrammaticFill = true;
      try {
        selectAllInComposer(editor);
        deleteSelectionInComposer(editor);
      } catch {} finally {
        isProgrammaticFill = false;
      }
    }
    syncPromptOptimizerUI();
    void finishNativeSlashConversion(seq, editor, parsed, autoSend, hadExistingContent);
    return true;
  }

  function buildDualLineTooltip(item) {
    let tip = `${item.role || item.title || item.label}\n适用场景: ${item.scene || '日常高效交互'}`;
    if (!item.builtin && item.text && item.text !== item.label) {
      tip += `\n实际填充: ${item.text}`;
    }
    if (item.contextReason) {
      tip += `\n上下文推荐: ${item.contextReason}`;
    }
    if (item.id === 'compact' && latestContextSnap?.used) {
      const k = Math.round(latestContextSnap.used / 1000);
      tip += `\n当前上下文: ${k}K`;
    }
    return tip;
  }

  function renderGhostPill() {
    if (!ghostEl || !doc) return;
    if (!settings.ghostSuggest || ghostDismissed || !ghostCandidates.length) {
      if (ghostTextSpan) ghostTextSpan.textContent = '';
      ghostEl.hidden = true;
      ghostEl.setAttribute?.('hidden', 'true');
      if (ghostEl.style) ghostEl.style.display = 'none';
      return;
    }
    const fullText = ghostCandidates[ghostIndex % ghostCandidates.length] || '';
    const shortText = truncateGhostLabel(fullText, 20);
    ghostEl.hidden = false;
    if (typeof ghostEl.removeAttribute === 'function') ghostEl.removeAttribute('hidden');
    if (ghostEl.style) ghostEl.style.display = '';
    if (ghostTextSpan) ghostTextSpan.textContent = shortText;
    if (ghostCycleBtn) {
      if (ghostCandidates.length > 1) {
        ghostCycleBtn.hidden = false;
        ghostCycleBtn.removeAttribute?.('hidden');
        if (ghostCycleBtn.style) ghostCycleBtn.style.display = '';
        ghostCycleBtn.textContent = `↓ ${(ghostIndex % ghostCandidates.length) + 1}/${ghostCandidates.length}`;
      } else {
        ghostCycleBtn.hidden = true;
        ghostCycleBtn.setAttribute?.('hidden', 'true');
        if (ghostCycleBtn.style) ghostCycleBtn.style.display = 'none';
      }
    }
    const titleTip = `${fullText}（Tab / → 填入 · ↑ / ↓ 切换 · Esc 隐藏）`;
    ghostEl.setAttribute?.('title', titleTip);
    ghostEl.setAttribute?.('data-full-suggestion', fullText);
    ghostAcceptBtn?.setAttribute?.('title', titleTip);
    ghostAcceptBtn?.setAttribute?.('data-full-suggestion', fullText);
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
    // 严格禁止加载期间重复点击或重复触发
    if (promptOptLoading) {
      return { ok: false, busy: true };
    }

    const editor = getComposerEditor();
    const raw = getComposerText(editor).trim();
    if (!raw) {
      showQuickToast('先输入提示词草稿，再点击优化', {
        tone: 'error',
        durationMs: 3200,
        target: 'optimizer'
      });
      syncPromptOptimizerUI();
      return { ok: false, error: 'EMPTY_PROMPT' };
    }

    promptOptLoading = true;
    optBtnEl?.removeAttribute?.('data-error');
    showQuickToast('');
    syncPromptOptimizerUI();

    try {
      let res = null;
      if (typeof ctx.bridge?.post === 'function') {
        res = await ctx.bridge.post('/optimize-prompt', {
          text: raw,
          customPrompt: typeof settings.optimizerPrompt === 'string' ? settings.optimizerPrompt : undefined,
          allowLocalFallback: options.allowLocalFallback === true
        });
      }

      let optimized = '';
      if (res?.ok && res.optimized) {
        optimized = String(res.optimized).trim();
      } else if (options.allowLocalFallback === true) {
        optimized = optimizePromptText(raw);
      }

      if (!optimized || !editor) {
        const hasBridgePost = typeof ctx.bridge?.post === 'function';
        const missingBridge = !res && !hasBridgePost && options.allowLocalFallback !== true;
        const rawErr = res?.message
          || res?.error
          || (missingBridge
            ? 'Bridge unavailable'
            : (!editor ? '未检测到对话输入框，请重试' : '提示词优化失败，请重试'));
        const formatted = formatPromptOptError(rawErr, res, { fromBridgeTransport: missingBridge });
        promptOptLoading = false;
        syncPromptOptimizerUI();
        showQuickToast(formatted.message, {
          tone: 'error',
          durationMs: 5000,
          title: formatted.title,
          target: 'optimizer'
        });
        return { ok: false, error: formatted.message, detail: res?.detail || '' };
      }

      const applied = await replaceComposerTextAsync(editor, optimized, { preferPaste: true });
      if (isDisposed) return { ok: false, error: 'DISPOSED' };

      promptOptLoading = false;
      const actualFilled = getComposerText(editor);
      if (!applied && !doesEditorMatchTarget(editor, optimized)) {
        syncPromptOptimizerUI();
        const errMsg = '优化结果写入输入框失败，请重试';
        showQuickToast(errMsg, { tone: 'error', durationMs: 5000, target: 'optimizer' });
        return { ok: false, error: 'EDITOR_WRITE_FAILED', message: errMsg };
      }
      promptOptUndoState = { original: raw, optimized: actualFilled || optimized };
      syncPromptOptimizerUI();
      showQuickToast('已优化，可点击撤回恢复原草稿', { target: 'optimizer' });
      return { ok: true, original: raw, optimized: actualFilled || optimized, model: res?.model || res?.candidate || '' };
    } catch (err) {
      if (isDisposed) return { ok: false, error: 'DISPOSED' };
      promptOptLoading = false;
      syncPromptOptimizerUI();
      const formatted = formatPromptOptError(err?.message || '提示词优化失败', null, { fromBridgeTransport: true });
      showQuickToast(formatted.message, {
        tone: 'error',
        durationMs: 5000,
        title: formatted.title,
        target: 'optimizer'
      });
      return { ok: false, error: formatted.message };
    }
  }

  function undoPromptOptimization() {
    if (!promptOptUndoState || promptOptLoading) return false;
    const orig = promptOptUndoState.original;
    promptOptUndoState = null;
    const editor = getComposerEditor();
    if (!editor) {
      syncPromptOptimizerUI();
      showQuickToast('已恢复原始草稿', { target: 'optimizer' });
      return true;
    }
    if (typeof doc?.execCommand !== 'function') {
      fillComposerText(editor, orig);
      syncPromptOptimizerUI();
      showQuickToast('已恢复原始草稿', { target: 'optimizer' });
      return true;
    }
    promptOptLoading = true;
    syncPromptOptimizerUI();
    return replaceComposerTextAsync(editor, orig, { preferPaste: true }).catch(() => false).finally(() => {
      if (isDisposed) return;
      promptOptLoading = false;
      syncPromptOptimizerUI();
      showQuickToast('已恢复原始草稿', { target: 'optimizer' });
    });
  }

  function appendOwnNode(node) {
    if (!quickBarEl || !node) return;
    const firstExternal = Array.from(quickBarEl.children || []).find((ch) => !ownBarNodes.includes(ch)) || null;
    if (firstExternal && typeof quickBarEl.insertBefore === 'function') {
      quickBarEl.insertBefore(node, firstExternal);
    } else {
      quickBarEl.appendChild(node);
    }
    ownBarNodes.push(node);
  }

  function readContextSignals() {
    const sessionId = ctx.hostDom?.getSessionId?.() || '';
    const turnEls = typeof doc?.querySelectorAll === 'function'
      ? doc.querySelectorAll('[data-testid="user-message"], [data-testid="agent-response"]')
      : [];
    const msgList = ctx.anchors.query('chat.messageList');
    const hasEmptyChatContainer = Boolean(msgList) && (!turnEls || turnEls.length === 0);
    const isNewChat = (!sessionId && (!turnEls || turnEls.length === 0))
      || (hasEmptyChatContainer && !Number(latestContextSnap?.used || 0));
    const assistantEls = typeof doc?.querySelectorAll === 'function'
      ? doc.querySelectorAll('[data-testid="agent-response"]')
      : [];
    const lastAssistantEl = assistantEls && assistantEls.length > 0 ? assistantEls[assistantEls.length - 1] : null;
    const lastAssistantText = String(lastAssistantEl?.innerText || lastAssistantEl?.textContent || '').trim();
    const isAssistantBusy = Boolean(ctx.hostDom?.isAssistantBusy?.());
    return { isNewChat, isAssistantBusy, lastAssistantText };
  }

  function ensurePromptOptimizerMounted(rootEl) {
    if (!doc?.createElement || !rootEl) return false;

    if (optWrapEl && (!optWrapEl.parentElement || optWrapEl.isConnected === false)) {
      teardownPromptOptimizer();
    }

    const footer = typeof rootEl.querySelector === 'function'
      ? rootEl.querySelector('.agy-composer-footer')
      : null;
    const sendBtn = ctx.anchors.query('composer.sendButton')
      || (typeof rootEl.querySelector === 'function'
        ? rootEl.querySelector('[data-testid="input-send-button"], [data-testid="send-button"], .agy-send-button, button[aria-label*="Send"], button[aria-label*="发送"], [data-testid="input-cancel-button"]')
        : null);

    let mountParent = rootEl;
    let mountRef = null;
    if (footer) {
      mountParent = footer.parentElement || rootEl;
      mountRef = footer;
    } else if (sendBtn && sendBtn.parentElement && sendBtn.parentElement !== rootEl) {
      mountParent = sendBtn.parentElement.parentElement || rootEl;
      mountRef = sendBtn.parentElement;
    } else if (sendBtn && sendBtn.parentElement === rootEl) {
      mountParent = rootEl;
      mountRef = sendBtn;
    }

    if (!optWrapEl) {
      if (typeof doc.querySelectorAll === 'function') {
        for (const stale of Array.from(doc.querySelectorAll('#agy-prompt-opt-wrap') || [])) {
          stale?.remove?.();
        }
      }
      optWrapEl = doc.createElement('div');
      optWrapEl.id = 'agy-prompt-opt-wrap';
      optWrapEl.setAttribute?.('data-position', 'above-send');

      optStatusEl = doc.createElement('span');
      optStatusEl.id = 'agy-prompt-opt-status';
      optStatusEl.setAttribute?.('role', 'status');
      optStatusEl.setAttribute?.('aria-live', 'polite');
      optStatusEl.hidden = true;
      optStatusEl.setAttribute?.('hidden', 'true');
      optStatusEl.addEventListener('mousedown', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
      });
      optStatusEl.addEventListener('click', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        showQuickToast('');
      });

      optBtnEl = doc.createElement('button');
      optBtnEl.type = 'button';
      optBtnEl.id = 'agy-prompt-opt-btn';
      optBtnEl.innerHTML = PROMPT_OPT_INTELLIGENT_SVG;
      optBtnEl.setAttribute?.('data-icon-state', 'idle');
      optBtnEl.addEventListener('mousedown', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
      });
      optBtnEl.addEventListener('click', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        void runPromptOptimization();
      });

      undoBtnEl = doc.createElement('button');
      undoBtnEl.type = 'button';
      undoBtnEl.id = 'agy-prompt-undo-btn';
      undoBtnEl.innerHTML = PROMPT_OPT_UNDO_SVG;
      undoBtnEl.setAttribute?.('data-icon-state', 'undo');
      setButtonVisible(undoBtnEl, false);
      undoBtnEl.addEventListener('mousedown', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
      });
      undoBtnEl.addEventListener('click', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        undoPromptOptimization();
      });

      optWrapEl.appendChild(optStatusEl);
      optWrapEl.appendChild(optBtnEl);
      optWrapEl.appendChild(undoBtnEl);
    }

    const parentKids = Array.from(mountParent.children || []);
    const wIdx = parentKids.indexOf(optWrapEl);
    const rIdx = mountRef ? parentKids.indexOf(mountRef) : -1;
    const needMove = optWrapEl.parentElement !== mountParent
      || (mountRef && rIdx >= 0 && wIdx !== rIdx - 1);

    if (needMove) {
      if (mountRef && typeof mountParent.insertBefore === 'function') {
        mountParent.insertBefore(optWrapEl, mountRef);
      } else {
        mountParent.appendChild(optWrapEl);
      }
    }

    try {
      if (
        sendBtn
        && typeof mountParent.getBoundingClientRect === 'function'
        && typeof sendBtn.getBoundingClientRect === 'function'
      ) {
        const pRect = mountParent.getBoundingClientRect();
        const sRect = sendBtn.getBoundingClientRect();
        if (pRect && sRect && pRect.width > 0 && sRect.width > 0 && pRect.right >= sRect.right) {
          const rightOffset = Math.max(8, Math.min(48, Math.round(pRect.right - sRect.right)));
          if (optWrapEl.style) optWrapEl.style.paddingRight = `${rightOffset}px`;
        }
      }
    } catch {}

    if (activeToastState && Date.now() < activeToastState.expiresAt && activeToastState.target === 'optimizer') {
      applyToastElementState(optStatusEl, activeToastState);
      applyToastElementState(toastEl, null);
      removeFloatToast();
      if (activeToastState.tone === 'error') optBtnEl?.setAttribute?.('data-error', 'true');
    }

    syncPromptOptimizerUI();
    return true;
  }

  function ensureQuickBarMounted(rootEl) {
    if (!doc?.createElement || !rootEl) return false;
    const mountParent = rootEl.parentElement || rootEl;
    const mountRef = rootEl.parentElement ? rootEl : (rootEl.firstChild || null);

    // 若宿主重渲染导致 quickBarEl 从 DOM 脱离，清理旧实例并重挂
    if (quickBarEl && (!quickBarEl.parentElement || quickBarEl.isConnected === false)) {
      if (typeof revokeQuickActionsSurface === 'function') {
        try { revokeQuickActionsSurface(); } catch {}
        revokeQuickActionsSurface = null;
      }
      quickBarEl = null;
      quickBarHostParent = null;
      lastRenderSig = '';
    }

    if (!quickBarEl) {
      if (typeof doc.querySelectorAll === 'function') {
        for (const stale of Array.from(doc.querySelectorAll('#agy-quick-capsule-bar') || [])) {
          stale?.remove?.();
        }
      }
      quickBarEl = doc.createElement('div');
      quickBarEl.id = 'agy-quick-capsule-bar';
      quickBarEl.className = 'agy-quick-capsule-bar';
      quickBarEl.setAttribute?.('data-position', 'above-composer');
      syncQuickBarToastVisible(false);
      quickBarEl.addEventListener?.('mousedown', (e) => {
        e?.preventDefault?.();
      });
      quickBarEl.addEventListener?.('wheel', (e) => {
        if (!e || quickBarEl.scrollWidth <= quickBarEl.clientWidth) return;
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          quickBarEl.scrollLeft += e.deltaY;
          e.preventDefault?.();
        }
      }, { passive: false });
    }

    const children = Array.from(mountParent.children || []);
    const qIdx = children.indexOf(quickBarEl);
    const rIdx = mountRef ? children.indexOf(mountRef) : -1;
    const needMove = quickBarEl.parentElement !== mountParent
      || (mountRef && rIdx >= 0 && qIdx !== rIdx - 1);

    if (needMove) {
      if (mountRef && typeof mountParent.insertBefore === 'function') {
        mountParent.insertBefore(quickBarEl, mountRef);
      } else {
        mountParent.appendChild(quickBarEl);
      }
    }
    quickBarHostParent = mountParent;

    // 必须先将 quickBarEl 挂载入 DOM 树，再向底座注册 composer.quickActions 插槽
    if (!revokeQuickActionsSurface && ctx.surfaces && typeof ctx.surfaces.provide === 'function') {
      revokeQuickActionsSurface = ctx.surfaces.provide('composer.quickActions', quickBarEl);
    }
    return true;
  }

  function renderQuickBar(rootEl, force = false) {
    if (!doc?.createElement) return null;
    const targetRoot = rootEl || resolveComposerRoot();
    if (!targetRoot) {
      teardownQuickBar();
      teardownPromptOptimizer();
      return null;
    }

    // 提示词优化按钮独立挂载在发送按钮上方，受 showPromptOptimizer 开关控制
    if (settings.showPromptOptimizer !== false) {
      ensurePromptOptimizerMounted(targetRoot);
    } else {
      teardownPromptOptimizer();
    }

    if (!settings.showQuickBar) {
      teardownQuickBar();
      return null;
    }

    ensureQuickBarMounted(targetRoot);

    const signals = readContextSignals();
    const baseItems = resolveConfiguredQuickItems({
      quickItems: settings.quickItems,
      quickPoolState: settings.quickPoolState,
      customQuickPrompts: settings.customQuickPrompts
    });
    const finalItems = resolveContextualQuickItems({
      baseItems,
      contextSnap: latestContextSnap,
      isNewChat: signals.isNewChat,
      isAssistantBusy: signals.isAssistantBusy,
      lastAssistantText: signals.lastAssistantText,
      enabled: settings.contextAwareQuickItems !== false
    });

    const nextCandidates = getGhostSuggestions(signals.lastAssistantText, {
      contextSnap: latestContextSnap,
      isNewChat: signals.isNewChat
    });
    const ghostSig = `${signals.isNewChat ? '1' : '0'}|${nextCandidates.join('|')}`;
    if (ghostSig !== lastGhostSig) {
      lastGhostSig = ghostSig;
      ghostCandidates = nextCandidates;
      ghostIndex = 0;
      ghostDismissed = false;
    } else {
      ghostCandidates = nextCandidates;
    }

    const sig = JSON.stringify({
      items: finalItems.map((i) => `${i.id}:${formatQuickItemDisplayLabel(i.label, i)}:${i.risk || ''}:${i.contextSuggested ? 1 : 0}`),
      extra: Array.from(extraActions.keys()),
      ghost: Boolean(settings.ghostSuggest)
    });

    if (!force && sig === lastRenderSig && ownBarNodes.length > 0 && quickBarEl?.parentElement === quickBarHostParent) {
      syncPromptOptimizerUI();
      renderGhostPill();
      return quickBarEl;
    }
    lastRenderSig = sig;

    // 仅清理本插件自建节点，保留外部插件通过 ctx.surfaces.mount('composer.quickActions') 挂入的节点
    clearOwnBarNodes();

    for (const item of finalItems) {
      const displayLabel = formatQuickItemDisplayLabel(item.label, item) || String(item.label || item.id || '');
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = `agy-qcap-${item.id}`;
      btn.className = 'agy-qcap-btn';
      btn.setAttribute?.('data-group', item.group || 'tools');
      btn.setAttribute?.('data-kind', item.slash || String(item.text || '').trim().startsWith('/') ? 'slash' : (item.source === 'frequent' ? 'frequent' : 'prompt'));
      btn.setAttribute?.('aria-label', displayLabel);
      if (item.contextSuggested) btn.setAttribute?.('data-context-suggested', 'true');
      if (item.risk) btn.setAttribute?.('data-risk', item.risk);
      btn.setAttribute?.('title', buildDualLineTooltip({ ...item, label: displayLabel }));

      const iconSpan = doc.createElement('span');
      iconSpan.className = 'agy-qcap-icon';
      iconSpan.setAttribute?.('aria-hidden', 'true');
      iconSpan.innerHTML = resolveQuickItemIconSvg(item);
      const labelSpan = doc.createElement('span');
      labelSpan.className = 'agy-qcap-label';
      labelSpan.textContent = displayLabel;
      btn.appendChild(iconSpan);
      btn.appendChild(labelSpan);

      btn.addEventListener('mousedown', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
      });
      btn.addEventListener('click', () => {
        insertTextIntoComposer(item.text, item.autoSend === true || item.id === 'compact', item);
      });
      appendOwnNode(btn);
    }

    for (const [id, act] of extraActions.entries()) {
      const displayLabel = formatQuickItemDisplayLabel(act.label || id, { id }) || String(act.label || id);
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.id = `agy-qcap-ext-${id}`;
      btn.className = 'agy-qcap-btn';
      btn.setAttribute?.('data-kind', 'extension');
      btn.setAttribute?.('aria-label', displayLabel);

      const iconSpan = doc.createElement('span');
      iconSpan.className = 'agy-qcap-icon';
      iconSpan.setAttribute?.('aria-hidden', 'true');
      iconSpan.innerHTML = QUICK_ITEM_ICONS.default;
      const labelSpan = doc.createElement('span');
      labelSpan.className = 'agy-qcap-label';
      labelSpan.textContent = displayLabel;
      btn.appendChild(iconSpan);
      btn.appendChild(labelSpan);

      btn.addEventListener('mousedown', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
      });
      btn.addEventListener('click', () => {
        try { act.onClick?.({ insertText: insertTextIntoComposer }); } catch {}
      });
      appendOwnNode(btn);
    }

    // 最右侧感知提示胶囊（感知提示 + 8字建议 + Tab / → 快捷键提示 + ↑/↓ 切换）
    if (settings.ghostSuggest) {
      ghostEl = doc.createElement('span');
      ghostEl.id = 'agy-next-step-ghost';
      ghostEl.addEventListener('click', () => { acceptGhostSuggestion(); });

      ghostAcceptBtn = doc.createElement('button');
      ghostAcceptBtn.type = 'button';
      ghostAcceptBtn.className = 'agy-ns-accept';
      const iconSpan = doc.createElement('span');
      iconSpan.className = 'agy-ns-icon';
      iconSpan.innerHTML = PERCEPTION_SPARK_SVG;
      const prefixSpan = doc.createElement('span');
      prefixSpan.className = 'agy-ns-prefix';
      prefixSpan.textContent = '感知提示';
      ghostTextSpan = doc.createElement('span');
      ghostTextSpan.className = 'agy-ns-text';
      const kbdSpan = doc.createElement('span');
      kbdSpan.className = 'agy-ns-kbd';
      kbdSpan.textContent = 'Tab / →';
      ghostAcceptBtn.appendChild(iconSpan);
      ghostAcceptBtn.appendChild(prefixSpan);
      ghostAcceptBtn.appendChild(ghostTextSpan);
      ghostAcceptBtn.appendChild(kbdSpan);
      ghostAcceptBtn.addEventListener('mousedown', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
      });
      ghostAcceptBtn.addEventListener('click', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        acceptGhostSuggestion();
      });

      ghostCycleBtn = doc.createElement('button');
      ghostCycleBtn.type = 'button';
      ghostCycleBtn.className = 'agy-ns-cycle';
      ghostCycleBtn.setAttribute?.('title', '点击或按 ↑ / ↓ 切换下一条感知提示');
      ghostCycleBtn.addEventListener('mousedown', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
      });
      ghostCycleBtn.addEventListener('click', (e) => {
        e?.preventDefault?.();
        e?.stopPropagation?.();
        cycleGhostSuggestion(1);
      });

      ghostEl.appendChild(ghostAcceptBtn);
      ghostEl.appendChild(ghostCycleBtn);
      renderGhostPill();
      appendOwnNode(ghostEl);
    }

    toastEl = doc.createElement('span');
    toastEl.id = 'agy-qcap-toast';
    toastEl.setAttribute?.('role', 'status');
    toastEl.setAttribute?.('aria-live', 'polite');
    toastEl.hidden = true;
    toastEl.setAttribute?.('hidden', 'true');
    toastEl.addEventListener('mousedown', (e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
    });
    toastEl.addEventListener('click', () => {
      showQuickToast('');
    });
    appendOwnNode(toastEl);
    if (activeToastState && Date.now() < activeToastState.expiresAt && !(activeToastState.target === 'optimizer' && optStatusEl)) {
      applyToastElementState(toastEl, activeToastState);
    } else {
      syncQuickBarToastVisible(false);
    }

    syncPromptOptimizerUI();
    return quickBarEl;
  }

  function evaluateActionApproval(buttonOrSelector, contextText) {
    const buttonEl = typeof buttonOrSelector === 'string'
      ? doc?.querySelector?.(buttonOrSelector)
      : buttonOrSelector;
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

  function scanActionButtons() {
    const btns = ctx.anchors.queryAll('chat.actionButtons');
    const results = [];
    for (const btn of btns) {
      const txt = btn.getAttribute?.('data-command') || btn.parentElement?.textContent || btn.textContent || '';
      if (/^(?:Accept|Run|Allow|继续|运行|允许)/i.test(String(btn.textContent || '').trim()) || shouldBlockAutoAccept(txt).blocked) {
        results.push(evaluateActionApproval(btn, txt));
      }
    }
    return results;
  }

  const onDocKeyDown = (e) => {
    if (!e) return;
    const shortcutSpec = typeof settings.optimizerShortcut === 'string' ? settings.optimizerShortcut.trim() : '';
    if (shortcutSpec && matchesShortcutEvent(e, shortcutSpec)) {
      const target = e.target;
      const inSettingsUi = Boolean(
        target?.getAttribute?.('data-shortcut-input')
        || target?.getAttribute?.('data-field-modal-textarea')
        || target?.closest?.('#agy-daddy-host, #agy-native-settings-mount, .ag-modal-dialog, .ag-field-modal-dialog')
      );
      if (!inSettingsUi) {
        e.preventDefault?.();
        e.stopPropagation?.();
        if (promptOptLoading) return;
        const ed = getComposerEditor();
        const curText = getComposerText(ed);
        if (promptOptUndoState && curText === promptOptUndoState.optimized && curText.trim().length > 0) {
          undoPromptOptimization();
        } else {
          void runPromptOptimization();
        }
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      clearPromptOptUndoState();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const ed = getComposerEditor();
    const isEditorEmpty = !getComposerText(ed).trim();
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
    if (isProgrammaticFill) return;
    const ed = getComposerEditor();
    const cur = getComposerText(ed);
    if (promptOptUndoState && cur !== promptOptUndoState.optimized) {
      promptOptUndoState = null;
    }
    optBtnEl?.removeAttribute?.('data-error');
    syncPromptOptimizerUI();
  };

  const onDocEditorSync = () => {
    if (isProgrammaticFill) return;
    const ed = getComposerEditor();
    const cur = getComposerText(ed);
    if (promptOptUndoState && cur !== promptOptUndoState.optimized) {
      promptOptUndoState = null;
    }
    syncPromptOptimizerUI();
  };

  doc?.addEventListener?.('keydown', onDocKeyDown, true);
  doc?.addEventListener?.('input', onDocInput, true);
  doc?.addEventListener?.('keyup', onDocEditorSync, true);
  doc?.addEventListener?.('paste', onDocEditorSync, true);
  doc?.addEventListener?.('compositionend', onDocEditorSync, true);
  doc?.addEventListener?.('focus', onDocEditorSync, true);

  const stopComposerObs = ctx.anchors.observe('composer.root', (el) => {
    if (el) renderQuickBar(resolveComposerRoot() || el);
  });

  const stopEditorObs = ctx.anchors.observe('composer.editor', () => {
    const root = resolveComposerRoot();
    if (root) renderQuickBar(root);
  });

  const stopActionObs = ctx.anchors.observe('chat.actionButtons', () => {
    scanActionButtons();
  });

  let domHealObserver = null;
  if (typeof globalThis.MutationObserver === 'function' && doc?.body) {
    try {
      domHealObserver = new globalThis.MutationObserver((records) => {
        const nodesReady = Boolean(
          optWrapEl
          && optWrapEl.isConnected !== false
          && (!settings.showQuickBar || (quickBarEl && quickBarEl.isConnected !== false))
        );
        if (nodesReady && Array.isArray(records) && records.length > 0) {
          const allSelfMutations = records.every((rec) => {
            const t = rec?.target;
            if (!t) return false;
            return Boolean(optWrapEl?.contains?.(t) || quickBarEl?.contains?.(t));
          });
          if (allSelfMutations) return;
        }
        if (mutDebounceTimer) return;
        mutDebounceTimer = setTimeout(() => {
          mutDebounceTimer = null;
          renderQuickBar(resolveComposerRoot());
        }, 120);
      });
      domHealObserver.observe(doc.body, { childList: true, subtree: true });
    } catch {}
  }

  const stopContextSub = ctx.state.subscribe('state:context.snapshot@1', (snap) => {
    latestContextSnap = snap || null;
    renderQuickBar(resolveComposerRoot());
  });

  const stopSettings = ctx.settings?.onChange?.((nextValues) => {
    const incoming = nextValues && typeof nextValues === 'object' ? nextValues : {};
    settings = {
      ...settings,
      ...incoming,
      autoAccept: incoming.autoAccept !== undefined ? incoming.autoAccept === true : settings.autoAccept === true,
      contextAwareQuickItems: incoming.contextAwareQuickItems !== undefined
        ? incoming.contextAwareQuickItems !== false
        : settings.contextAwareQuickItems !== false,
      showPromptOptimizer: incoming.showPromptOptimizer !== undefined
        ? incoming.showPromptOptimizer !== false
        : settings.showPromptOptimizer !== false,
      optimizerShortcut: incoming.optimizerShortcut !== undefined
        ? String(incoming.optimizerShortcut || '').trim()
        : settings.optimizerShortcut,
      quickItems: Array.isArray(incoming.quickItems) ? [...incoming.quickItems] : settings.quickItems
    };
    renderQuickBar(resolveComposerRoot(), true);
  });

  const stopSvc = ctx.services.provide('composer', {
    registerQuickAction(def) {
      if (!def?.id) throw new Error('registerQuickAction requires id');
      extraActions.set(def.id, def);
      renderQuickBar(resolveComposerRoot(), true);
      return () => {
        extraActions.delete(def.id);
        renderQuickBar(resolveComposerRoot(), true);
      };
    },
    optimizePrompt: runPromptOptimization,
    undoPromptOptimization,
    acceptGhostSuggestion,
    cycleGhostSuggestion,
    evaluateActionApproval,
    scanActionButtons,
    refreshQuickBar: () => Boolean(renderQuickBar(resolveComposerRoot(), true)),
    async updateSettings(patch = {}) {
      settings = {
        ...settings,
        ...(patch && typeof patch === 'object' ? patch : {})
      };
      settings.autoAccept = settings.autoAccept === true;
      settings.contextAwareQuickItems = settings.contextAwareQuickItems !== false;
      settings.showPromptOptimizer = settings.showPromptOptimizer !== false;
      settings.optimizerShortcut = typeof settings.optimizerShortcut === 'string'
        ? settings.optimizerShortcut.trim()
        : DEFAULT_OPTIMIZER_SHORTCUT;
      const schemaPatch = {};
      for (const k of SCHEMA_SETTING_KEYS) {
        if (patch && k in patch) schemaPatch[k] = patch[k];
      }
      if (Object.keys(schemaPatch).length > 0 && typeof ctx.settings?.update === 'function') {
        try { await ctx.settings.update(schemaPatch); } catch {}
      }
      renderQuickBar(resolveComposerRoot(), true);
      return { ...settings };
    },
    getSettings: () => ({ ...settings })
  });

  const initialRoot = resolveComposerRoot();
  if (initialRoot) renderQuickBar(initialRoot, true);

  // 后台异步加载自定义快捷指令（兼容旧 quick-prompts.json 存储）
  if (typeof ctx.bridge?.post === 'function') {
    void ctx.bridge.post('/quick-prompts', {}).then((res) => {
      if (!res || typeof res !== 'object') return;
      let changed = false;
      if (res.quickPoolState && typeof res.quickPoolState === 'object') {
        settings.quickPoolState = { ...settings.quickPoolState, ...res.quickPoolState };
        changed = true;
      }
      if (Array.isArray(res.custom) && res.custom.length > 0) {
        settings.customQuickPrompts = res.custom;
        changed = true;
      }
      if (changed) {
        renderQuickBar(resolveComposerRoot(), true);
      }
    }).catch(() => {});
  }

  disposers.push(
    stopSvc,
    stopSettings,
    stopStyles,
    stopComposerObs,
    stopEditorObs,
    stopActionObs,
    stopContextSub,
    () => {
      isDisposed = true;
      slashConversionSeq += 1;
      for (const tid of slashConversionTimers) {
        clearTimeout(tid);
      }
      slashConversionTimers.clear();
      if (mutDebounceTimer) {
        clearTimeout(mutDebounceTimer);
        mutDebounceTimer = null;
      }
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      activeToastState = null;
      removeFloatToast();
      if (domHealObserver) {
        try { domHealObserver.disconnect(); } catch {}
        domHealObserver = null;
      }
    },
    () => doc?.removeEventListener?.('keydown', onDocKeyDown, true),
    () => doc?.removeEventListener?.('input', onDocInput, true),
    () => doc?.removeEventListener?.('keyup', onDocEditorSync, true),
    () => doc?.removeEventListener?.('paste', onDocEditorSync, true),
    () => doc?.removeEventListener?.('compositionend', onDocEditorSync, true),
    () => doc?.removeEventListener?.('focus', onDocEditorSync, true),
    teardownQuickBar,
    teardownPromptOptimizer,
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
