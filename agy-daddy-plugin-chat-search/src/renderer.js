'use strict';

let disposers = [];

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

async function mount(ctx, options = {}) {
  let settings = { regexMode: false, caseSensitive: false };
  try {
    const res = await ctx.bridge.post('/settings', { action: 'get' });
    if (res?.ok && res.values) settings = { ...settings, ...res.values };
  } catch {}

  const doc = options.document
    || ctx.anchors.query('chat.messageList')?.ownerDocument
    || ctx.anchors.query('chat.scrollViewport')?.ownerDocument
    || globalThis.document;

  let rootBox = null;
  let countLabel = null;
  let inputEl = null;
  let matches = [];
  let activeIdx = -1;

  function clearHighlights() {
    for (const m of matches) {
      if (m.removeAttribute) m.removeAttribute('data-agy-search-hit');
      else m.setAttribute?.('data-agy-search-hit', '');
    }
    matches = [];
    activeIdx = -1;
    if (countLabel) countLabel.textContent = '0/0';
  }

  function focusMatch(idx) {
    if (!matches.length) return -1;
    activeIdx = (idx + matches.length) % matches.length;
    for (let i = 0; i < matches.length; i++) {
      matches[i].setAttribute?.('data-agy-search-hit', i === activeIdx ? 'active' : 'hit');
    }
    const target = matches[activeIdx];
    const vp = ctx.anchors.query('chat.scrollViewport');
    if (vp) vp.scrollTop = activeIdx * 180;
    if (typeof target?.scrollIntoView === 'function') {
      try { target.scrollIntoView({ block: 'center' }); } catch {}
    }
    if (countLabel) countLabel.textContent = `${activeIdx + 1}/${matches.length}`;
    return activeIdx;
  }

  function runSearch(query) {
    clearHighlights();
    const fn = createSearchMatcher(query, settings.regexMode, settings.caseSensitive);
    if (!fn) {
      ctx.state.set('state:chat-search.query@1', { query: '', total: 0 });
      return 0;
    }
    const listEl = ctx.anchors.query('chat.messageList') || ctx.anchors.query('chat.scrollViewport');
    const children = listEl?.children || [];
    for (const node of children) {
      const txt = String(node?.textContent || '');
      if (fn(txt)) {
        node.setAttribute?.('data-agy-search-hit', 'hit');
        matches.push(node);
      }
    }
    ctx.state.set('state:chat-search.query@1', { query: String(query || ''), total: matches.length });
    if (matches.length > 0) focusMatch(0);
    return matches.length;
  }

  function ensureSearchUi() {
    if (!doc?.createElement) return null;
    if (rootBox) return rootBox;

    // 优先挂入 chat-nav 提供的 chat.search 表面容器，若无 chat-nav 则降级挂到 chat.scrollViewport 父容器
    const slot = (doc.getElementById ? doc.getElementById('agy-chat-search-slot') : null)
      || ctx.anchors.query('chat.scrollViewport')?.parentElement
      || doc.body;
    if (!slot) return null;

    rootBox = doc.createElement('div');
    rootBox.id = 'agy-community-chat-search';

    inputEl = doc.createElement('input');
    inputEl.id = 'agy-community-search-input';
    inputEl.type = 'text';
    inputEl.placeholder = '搜索对话...';
    inputEl.className = 'settings-input';
    inputEl.addEventListener('change', () => runSearch(inputEl.value));
    rootBox.appendChild(inputEl);

    const prevBtn = doc.createElement('button');
    prevBtn.type = 'button';
    prevBtn.id = 'agy-community-search-prev';
    prevBtn.textContent = '↑';
    prevBtn.addEventListener('click', () => focusMatch(activeIdx - 1));
    rootBox.appendChild(prevBtn);

    const nextBtn = doc.createElement('button');
    nextBtn.type = 'button';
    nextBtn.id = 'agy-community-search-next';
    nextBtn.textContent = '↓';
    nextBtn.addEventListener('click', () => focusMatch(activeIdx + 1));
    rootBox.appendChild(nextBtn);

    countLabel = doc.createElement('span');
    countLabel.id = 'agy-community-search-count';
    countLabel.textContent = '0/0';
    rootBox.appendChild(countLabel);

    const clearBtn = doc.createElement('button');
    clearBtn.type = 'button';
    clearBtn.id = 'agy-community-search-clear';
    clearBtn.textContent = '✕';
    clearBtn.addEventListener('click', () => {
      if (inputEl) inputEl.value = '';
      clearHighlights();
    });
    rootBox.appendChild(clearBtn);

    slot.appendChild(rootBox);
    return rootBox;
  }

  ensureSearchUi();

  const stopSection = ctx.settings.registerSection({
    id: 'chat-search-settings',
    title: { 'zh-CN': '对话全文检索', en: 'Conversation Search' },
    values: settings,
    onChange(key, value) {
      settings = { ...settings, [key]: value };
      void ctx.bridge.post('/settings', { action: 'save', values: { [key]: value } }).catch(() => {});
      if (inputEl?.value) runSearch(inputEl.value);
    }
  });

  disposers.push(
    stopSection,
    clearHighlights,
    () => { if (rootBox?.remove) rootBox.remove(); rootBox = null; inputEl = null; countLabel = null; }
  );

  return { runSearch, focusMatch, clearHighlights };
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  createSearchMatcher,
  mount,
  dispose
};
