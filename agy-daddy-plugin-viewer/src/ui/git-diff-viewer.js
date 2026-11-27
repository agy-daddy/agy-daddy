'use strict';

const { ERROR_CODES } = require('../constants');
const { VIEWER_DRAWER_STYLES } = require('../styles');
const {
  createEl,
  clearNode,
  createShadowHost,
  formatBytes,
  renderStatusCard
} = require('./dom-helpers');

const DRAWER_HOST_ID = 'agy-viewer-drawer-host';
const SECURITY_CODES = new Set([
  ERROR_CODES.PATH_OUT_OF_BOUNDS,
  ERROR_CODES.UNC_PATH_BLOCKED,
  ERROR_CODES.SYMLINK_ESCAPE,
  ERROR_CODES.SENSITIVE_PATH_BLOCKED
]);

function appendTextWithWordSpans(doc, parent, content, wordSpans, lineType) {
  const str = String(content ?? '');
  if (!Array.isArray(wordSpans) || wordSpans.length === 0) {
    parent.textContent = str;
    return;
  }
  const cls = lineType === 'del' ? 'agy-v-word-del' : 'agy-v-word-add';
  let cursor = 0;
  for (const span of wordSpans) {
    const start = Math.max(cursor, Number(span.start) || 0);
    const end = Math.min(str.length, Number(span.end) || 0);
    if (start > cursor) {
      const plain = doc.createElement('span');
      plain.textContent = str.slice(cursor, start);
      parent.appendChild(plain);
    }
    if (end > start) {
      const hi = doc.createElement('span');
      hi.className = cls;
      hi.textContent = str.slice(start, end);
      parent.appendChild(hi);
      cursor = end;
    }
  }
  if (cursor < str.length) {
    const tail = doc.createElement('span');
    tail.textContent = str.slice(cursor);
    parent.appendChild(tail);
  }
}

function buildSplitRows(lines) {
  const rows = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === 'ctx') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels = [];
    const adds = [];
    while (i < lines.length && lines[i].type === 'del') {
      dels.push(lines[i]);
      i++;
    }
    while (i < lines.length && lines[i].type === 'add') {
      adds.push(lines[i]);
      i++;
    }
    const maxLen = Math.max(dels.length, adds.length);
    for (let k = 0; k < maxLen; k++) {
      rows.push({ left: dels[k] || null, right: adds[k] || null });
    }
    if (maxLen === 0 && i < lines.length) {
      rows.push({ left: lines[i], right: null });
      i++;
    }
  }
  return rows;
}

function createUnifiedLineEl(doc, line) {
  const sigil = line.type === 'add' ? '+' : (line.type === 'del' ? '-' : ' ');
  const contentEl = createEl(doc, 'span');
  appendTextWithWordSpans(doc, contentEl, line.content, line.wordSpans, line.type);
  return createEl(doc, 'div', {
    className: 'agy-v-diff-line',
    attrs: { 'data-type': line.type }
  }, [
    createEl(doc, 'span', { className: 'agy-v-ln', text: line.oldLine ?? '' }),
    createEl(doc, 'span', { className: 'agy-v-ln', text: line.newLine ?? '' }),
    createEl(doc, 'span', { className: 'agy-v-sigil', text: sigil }),
    contentEl
  ]);
}

function createSplitRowEl(doc, pair) {
  const makeCell = (line, isRight) => {
    if (!line) {
      return createEl(doc, 'div', { className: 'agy-v-diff-split-cell' }, [
        createEl(doc, 'span', { className: 'agy-v-ln', text: '' }),
        createEl(doc, 'span', { className: 'agy-v-sigil', text: '' }),
        createEl(doc, 'span', { text: '' })
      ]);
    }
    const sigil = line.type === 'add' ? '+' : (line.type === 'del' ? '-' : ' ');
    const contentEl = createEl(doc, 'span');
    appendTextWithWordSpans(doc, contentEl, line.content, line.wordSpans, line.type);
    return createEl(doc, 'div', {
      className: 'agy-v-diff-split-cell',
      attrs: { 'data-type': line.type }
    }, [
      createEl(doc, 'span', { className: 'agy-v-ln', text: (isRight ? line.newLine : line.oldLine) ?? '' }),
      createEl(doc, 'span', { className: 'agy-v-sigil', text: sigil }),
      contentEl
    ]);
  };

  return createEl(doc, 'div', { className: 'agy-v-diff-split-row' }, [
    makeCell(pair.left, false),
    makeCell(pair.right, true)
  ]);
}

async function mountDiffStage({
  ctx,
  doc,
  t,
  rootEl,
  filePath,
  settings,
  signal,
  onBackToNative,
  onOpenInOmni
}) {
  clearNode(rootEl);

  let scope = settings?.diffDefaultScope || 'head';
  let layout = settings?.diffDefaultLayout || 'unified';
  let currentHunkIdx = 0;
  let hunkElements = [];

  async function loadAndRender() {
    if (signal?.aborted) return;
    clearNode(rootEl);

    let res;
    try {
      res = await ctx.bridge.post('/diff/file', {
        filePath,
        scope,
        contextLines: settings?.diffContextLines ?? 3,
        wordHighlight: settings?.diffShowWordHighlight !== false
      });
    } catch (err) {
      if (signal?.aborted) return;
      rootEl.appendChild(renderStatusCard(doc, {
        title: t('error.loadFailed', { message: err?.message || 'DIFF_BRIDGE_ERROR' }),
        actions: [
          { label: t('common.retry'), onClick: () => void loadAndRender() },
          { label: t('common.backToNative'), onClick: () => onBackToNative?.() }
        ]
      }));
      return;
    }

    if (signal?.aborted) return;

    if (!res?.ok) {
      const isSecurity = SECURITY_CODES.has(res?.errorCode);
      const actions = [];
      if (isSecurity) {
        actions.push({
          label: t('common.openSettings'),
          onClick: () => ctx?.settings?.open?.({ tab: 'plugins' })
        });
      } else {
        actions.push({ label: t('common.retry'), onClick: () => void loadAndRender() });
      }
      if (onBackToNative) {
        actions.push({ label: t('diff.backToFile'), onClick: () => onBackToNative() });
      }
      rootEl.appendChild(renderStatusCard(doc, {
        title: isSecurity ? t('error.pathOutOfBounds') : t('error.loadFailed', { message: res?.message || res?.errorCode || 'ERROR' }),
        danger: isSecurity,
        actions
      }));
      return;
    }

    const state = res.state || 'OK';

    // Top toolbar
    const hunkCounter = createEl(doc, 'span', {
      className: 'agy-v-badge',
      text: t('diff.hunkProgress', { current: 0, total: res.hunks?.length || 0 })
    });

    const scopeSelect = createEl(doc, 'select', {
      className: 'agy-v-select',
      on: {
        change: (e) => {
          scope = e.target.value || 'head';
          void loadAndRender();
        }
      }
    }, [
      createEl(doc, 'option', { value: 'head', text: t('diff.scope.head') }),
      createEl(doc, 'option', { value: 'unstaged', text: t('diff.scope.unstaged') }),
      createEl(doc, 'option', { value: 'staged', text: t('diff.scope.staged') })
    ]);
    scopeSelect.value = scope;

    const layoutBtn = createEl(doc, 'button', {
      type: 'button',
      className: 'agy-v-btn',
      text: layout === 'unified' ? t('diff.layout.unified') : t('diff.layout.split'),
      on: {
        click: () => {
          layout = layout === 'unified' ? 'split' : 'unified';
          void loadAndRender();
        }
      }
    });

    const jumpHunk = (delta) => {
      if (hunkElements.length === 0) return;
      currentHunkIdx = (currentHunkIdx + delta + hunkElements.length) % hunkElements.length;
      const target = hunkElements[currentHunkIdx];
      target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      hunkCounter.textContent = t('diff.hunkProgress', {
        current: currentHunkIdx + 1,
        total: hunkElements.length
      });
    };

    const toolbar = createEl(doc, 'div', { className: 'agy-v-toolbar' }, [
      res.repoName ? createEl(doc, 'span', { className: 'agy-v-badge', text: `${res.repoName} · ${res.branch || ''}` }) : null,
      res.status ? createEl(doc, 'span', { className: 'agy-v-badge', text: res.status }) : null,
      res.oldRelPath ? createEl(doc, 'span', { className: 'agy-v-badge', text: `${res.oldRelPath} → ${res.relPath}` }) : null,
      createEl(doc, 'span', {
        className: 'agy-v-badge',
        text: `+${res.stats?.additions || 0} -${res.stats?.deletions || 0}`
      }),
      createEl(doc, 'span', { className: 'agy-v-badge', text: t('common.readonlyBadge') }),
      scopeSelect,
      layoutBtn,
      (res.hunks?.length > 0) ? createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: t('diff.prevHunk'),
        on: { click: () => jumpHunk(-1) }
      }) : null,
      (res.hunks?.length > 0) ? createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: t('diff.nextHunk'),
        on: { click: () => jumpHunk(1) }
      }) : null,
      (res.hunks?.length > 0) ? hunkCounter : null,
      createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: t('common.refresh'),
        on: { click: () => void loadAndRender() }
      }),
      (res.omniCategory && onOpenInOmni) ? createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: t('capsule.omni'),
        on: { click: () => onOpenInOmni(res.omniCategory) }
      }) : null,
      createEl(doc, 'div', { className: 'agy-v-toolbar-spacer' }),
      onBackToNative ? createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: t('diff.backToFile'),
        on: { click: () => onBackToNative() }
      }) : null
    ]);
    rootEl.appendChild(toolbar);

    if (state === 'NOT_A_GIT_REPO') {
      rootEl.appendChild(renderStatusCard(doc, {
        title: t('diff.notGitRepo'),
        desc: t('diff.notGitRepoDesc'),
        actions: [
          { label: t('diff.retryDetect'), onClick: () => void loadAndRender() },
          ...(onBackToNative ? [{ label: t('diff.backToFile'), onClick: () => onBackToNative() }] : [])
        ]
      }));
      return;
    }

    if (state === 'NO_CHANGES') {
      rootEl.appendChild(renderStatusCard(doc, {
        title: t('diff.noChanges'),
        desc: t('diff.noChangesDesc', { branch: res.branch || 'HEAD' }),
        actions: [
          { label: t('common.refresh'), onClick: () => void loadAndRender() },
          ...(onBackToNative ? [{ label: t('diff.backToFile'), onClick: () => onBackToNative() }] : [])
        ]
      }));
      return;
    }

    if (state === 'BINARY_FILE') {
      const sizeDesc = (res.oldSize != null || res.newSize != null)
        ? `${formatBytes(res.oldSize || 0)} → ${formatBytes(res.newSize || 0)}`
        : '';
      const actions = [];
      if (res.omniCategory && onOpenInOmni) {
        actions.push({ label: t('diff.openInOmni'), onClick: () => onOpenInOmni(res.omniCategory) });
      }
      if (onBackToNative) {
        actions.push({ label: t('diff.backToFile'), onClick: () => onBackToNative() });
      }
      rootEl.appendChild(renderStatusCard(doc, {
        title: t('diff.binaryFile'),
        desc: sizeDesc,
        actions
      }));
      return;
    }

    if (state === 'DIFF_TRUNCATED' || res.truncated) {
      const meta = res.truncationMeta || {};
      const detail = meta.fileSize
        ? formatBytes(meta.fileSize)
        : `${meta.totalLines || res.stats?.additions || ''} lines`;
      const warnBar = createEl(doc, 'div', { className: 'agy-v-banner-warn' }, [
        createEl(doc, 'span', { text: t('diff.truncated', { detail }) }),
        (res.omniCategory && onOpenInOmni) ? createEl(doc, 'button', {
          type: 'button',
          className: 'agy-v-btn',
          text: t('diff.openInOmni'),
          on: { click: () => onOpenInOmni(res.omniCategory) }
        }) : null
      ]);
      rootEl.appendChild(warnBar);
    }

    const scrollEl = createEl(doc, 'div', { className: 'agy-v-diff-scroll' });
    rootEl.appendChild(scrollEl);
    hunkElements = [];
    currentHunkIdx = 0;

    for (const hunk of (res.hunks || [])) {
      if (hunk.canExpandBefore && hunk.expandBeforeRange) {
        const count = Math.max(1, (hunk.expandBeforeRange.endLine - hunk.expandBeforeRange.startLine) + 1);
        const expandWrap = createEl(doc, 'div');
        const expandBtn = createEl(doc, 'button', {
          type: 'button',
          className: 'agy-v-diff-expand',
          text: t('diff.expandContext', { count }),
          on: {
            click: async () => {
              expandBtn.disabled = true;
              try {
                const ctxRes = await ctx.bridge.post('/diff/context', {
                  filePath,
                  scope,
                  startLine: hunk.expandBeforeRange.startLine,
                  endLine: hunk.expandBeforeRange.endLine
                });
                if (!signal?.aborted && ctxRes?.ok && Array.isArray(ctxRes.lines)) {
                  clearNode(expandWrap);
                  if (layout === 'split') {
                    for (const ln of ctxRes.lines) {
                      expandWrap.appendChild(createSplitRowEl(doc, { left: ln, right: ln }));
                    }
                  } else {
                    for (const ln of ctxRes.lines) {
                      expandWrap.appendChild(createUnifiedLineEl(doc, ln));
                    }
                  }
                }
              } catch {
                expandBtn.disabled = false;
              }
            }
          }
        });
        expandWrap.appendChild(expandBtn);
        scrollEl.appendChild(expandWrap);
      }

      const hunkHeaderEl = createEl(doc, 'div', {
        className: 'agy-v-hunk-bar',
        text: hunk.header
      });
      hunkElements.push(hunkHeaderEl);
      scrollEl.appendChild(hunkHeaderEl);

      if (layout === 'split') {
        const splitRows = buildSplitRows(hunk.lines || []);
        for (const pair of splitRows) {
          scrollEl.appendChild(createSplitRowEl(doc, pair));
        }
      } else {
        for (const ln of (hunk.lines || [])) {
          scrollEl.appendChild(createUnifiedLineEl(doc, ln));
        }
      }
    }

    if (hunkElements.length > 0) {
      hunkCounter.textContent = t('diff.hunkProgress', { current: 1, total: hunkElements.length });
    }
  }

  await loadAndRender();
}

function createWorkspaceDiffDrawer({ ctx, doc, t, getSettings, onOpenFileInOmni }) {
  let hostEl = null;
  let rootEl = null;
  let openState = false;
  let currentScope = null;
  let filterText = '';
  let selectedFilePath = '';
  let abortCtrl = null;

  function close() {
    openState = false;
    if (abortCtrl) {
      try { abortCtrl.abort(); } catch {}
      abortCtrl = null;
    }
    if (hostEl) {
      hostEl.remove?.();
      hostEl = null;
    }
    rootEl = null;
  }

  async function renderDrawer({ rootHint = '', anchorHeaderEl = null } = {}) {
    const settings = getSettings();
    currentScope = currentScope || settings.diffDefaultScope || 'head';

    if (!hostEl || !hostEl.parentElement) {
      const created = createShadowHost(doc, DRAWER_HOST_ID, VIEWER_DRAWER_STYLES);
      hostEl = created.hostEl;
      rootEl = created.rootEl;
      const mountTarget = anchorHeaderEl?.parentElement || doc.body;
      mountTarget.appendChild(hostEl);
    }

    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    const signal = abortCtrl.signal;

    clearNode(rootEl);

    const scopeSelect = createEl(doc, 'select', {
      className: 'agy-v-select',
      on: {
        change: (e) => {
          currentScope = e.target.value || 'head';
          void renderDrawer({ rootHint, anchorHeaderEl });
        }
      }
    }, [
      createEl(doc, 'option', { value: 'head', text: t('diff.scope.head') }),
      createEl(doc, 'option', { value: 'unstaged', text: t('diff.scope.unstaged') }),
      createEl(doc, 'option', { value: 'staged', text: t('diff.scope.staged') })
    ]);
    scopeSelect.value = currentScope;

    const filterInput = createEl(doc, 'input', {
      type: 'text',
      className: 'agy-v-input',
      value: filterText,
      placeholder: t('diff.filterPlaceholder'),
      style: { flex: '1 1 140px' },
      on: {
        input: (e) => {
          filterText = String(e.target.value || '');
          void refreshFileList();
        }
      }
    });

    const repoBadge = createEl(doc, 'span', { className: 'agy-v-badge', text: t('diff.drawerTitle') });
    const countBadge = createEl(doc, 'span', { className: 'agy-v-badge', text: t('common.loading') });

    const topBar = createEl(doc, 'div', { className: 'agy-v-toolbar' }, [
      repoBadge,
      countBadge,
      scopeSelect,
      filterInput,
      createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: t('common.refresh'),
        on: { click: () => void renderDrawer({ rootHint, anchorHeaderEl }) }
      }),
      createEl(doc, 'div', { className: 'agy-v-toolbar-spacer' }),
      createEl(doc, 'button', {
        type: 'button',
        className: 'agy-v-btn',
        text: t('common.close'),
        on: { click: () => close() }
      })
    ]);

    const listEl = createEl(doc, 'div', { className: 'agy-v-drawer-list' });
    const diffPaneEl = createEl(doc, 'div', {
      className: 'agy-v-stage-root',
      style: { flex: '1 1 auto', minHeight: '0' }
    });

    rootEl.appendChild(topBar);
    rootEl.appendChild(listEl);
    rootEl.appendChild(diffPaneEl);

    async function loadSelectedFileDiff(fileEntry) {
      if (!fileEntry) {
        clearNode(diffPaneEl);
        diffPaneEl.appendChild(renderStatusCard(doc, { title: t('diff.selectFileHint') }));
        return;
      }
      selectedFilePath = fileEntry.filePath;
      await mountDiffStage({
        ctx,
        doc,
        t,
        rootEl: diffPaneEl,
        filePath: fileEntry.filePath,
        settings: { ...settings, diffDefaultScope: currentScope },
        signal,
        onBackToNative: null,
        onOpenInOmni: fileEntry.omniCategory ? () => onOpenFileInOmni?.(fileEntry) : null
      });
    }

    async function refreshFileList() {
      let res;
      try {
        res = await ctx.bridge.post('/diff/workspace', {
          rootHint,
          scope: currentScope,
          filterText
        });
      } catch (err) {
        if (signal.aborted) return;
        clearNode(listEl);
        clearNode(diffPaneEl);
        diffPaneEl.appendChild(renderStatusCard(doc, {
          title: t('error.loadFailed', { message: err?.message || 'WORKSPACE_DIFF_ERROR' }),
          actions: [{ label: t('common.retry'), onClick: () => void refreshFileList() }]
        }));
        return;
      }
      if (signal.aborted) return;

      clearNode(listEl);

      if (!res?.ok) {
        const isSecurity = SECURITY_CODES.has(res?.errorCode);
        countBadge.textContent = '0';
        clearNode(diffPaneEl);
        diffPaneEl.appendChild(renderStatusCard(doc, {
          title: isSecurity ? t('error.pathOutOfBounds') : t('error.loadFailed', { message: res?.message || res?.errorCode || 'ERROR' }),
          danger: isSecurity,
          actions: isSecurity ? [{
            label: t('common.openSettings'),
            onClick: () => ctx?.settings?.open?.({ tab: 'plugins' })
          }] : []
        }));
        return;
      }

      if (res.state === 'NOT_A_GIT_REPO' || !res.isGitRepo) {
        countBadge.textContent = '0';
        clearNode(diffPaneEl);
        diffPaneEl.appendChild(renderStatusCard(doc, {
          title: t('diff.notGitRepo'),
          desc: t('diff.notGitRepoDesc'),
          actions: [{ label: t('diff.retryDetect'), onClick: () => void refreshFileList() }]
        }));
        return;
      }

      repoBadge.textContent = `${res.repoName || ''} (${res.branch || 'HEAD'})`;
      const files = Array.isArray(res.files) ? res.files : [];
      countBadge.textContent = t('diff.changedCount', { count: files.length });

      if (files.length === 0) {
        clearNode(diffPaneEl);
        diffPaneEl.appendChild(renderStatusCard(doc, {
          title: t('diff.noChanges'),
          desc: t('diff.noChangesDesc', { branch: res.branch || 'HEAD' })
        }));
        return;
      }

      let activeEntry = files.find((f) => f.filePath === selectedFilePath) || files[0];
      for (const entry of files) {
        const itemBtn = createEl(doc, 'button', {
          type: 'button',
          className: 'agy-v-drawer-item',
          attrs: { 'data-selected': entry.filePath === activeEntry.filePath ? 'true' : 'false' },
          on: {
            click: () => {
              for (const row of listEl.children || []) {
                row.setAttribute?.('data-selected', 'false');
              }
              itemBtn.setAttribute('data-selected', 'true');
              void loadSelectedFileDiff(entry);
            }
          }
        }, [
          createEl(doc, 'span', { className: 'agy-v-status-badge', text: entry.status || 'M' }),
          createEl(doc, 'span', { text: entry.relPath, style: { flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' } }),
          entry.omniCategory ? createEl(doc, 'span', { className: 'agy-v-badge', text: entry.omniCategory }) : null,
          createEl(doc, 'span', { className: 'agy-v-badge', text: `+${entry.additions || 0} -${entry.deletions || 0}` })
        ]);
        listEl.appendChild(itemBtn);
      }

      await loadSelectedFileDiff(activeEntry);
    }

    await refreshFileList();
  }

  async function open(opts = {}) {
    openState = true;
    await renderDrawer(opts);
  }

  return {
    open,
    close,
    isOpen: () => openState,
    getHostElement: () => hostEl,
    dispose: close
  };
}

module.exports = {
  DRAWER_HOST_ID,
  appendTextWithWordSpans,
  buildSplitRows,
  mountDiffStage,
  createWorkspaceDiffDrawer
};
