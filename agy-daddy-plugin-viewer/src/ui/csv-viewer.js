'use strict';

const { TOKEN_HEADER_CANONICAL, CSV_DEFAULT_CHUNK_SIZE } = require('../constants');
const {
  createEl,
  clearNode,
  formatBytes,
  copyText,
  renderStatusCard,
  buildQueryString
} = require('./dom-helpers');

const ROW_HEIGHT_PX = 28;
const MAX_BROWSER_SCROLL_PX = 16_000_000;
const VIEWPORT_BUFFER_ROWS = 15;
const MAX_LRU_CHUNKS = 6;

function appendHighlightedCellText(doc, parent, text, query, caseSensitive, useRegex) {
  const str = String(text ?? '');
  if (!query) {
    parent.textContent = str;
    return;
  }
  let re = null;
  try {
    const pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
  } catch {
    parent.textContent = str;
    return;
  }
  let lastIdx = 0;
  let match;
  let guard = 0;
  while ((match = re.exec(str)) !== null && guard++ < 50) {
    if (match[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (match.index > lastIdx) {
      const plain = doc.createElement('span');
      plain.textContent = str.slice(lastIdx, match.index);
      parent.appendChild(plain);
    }
    const mark = doc.createElement('mark');
    mark.className = 'agy-v-csv-mark';
    mark.textContent = match[0];
    parent.appendChild(mark);
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx === 0) {
    parent.textContent = str;
  } else if (lastIdx < str.length) {
    const tail = doc.createElement('span');
    tail.textContent = str.slice(lastIdx);
    parent.appendChild(tail);
  }
}

async function mountCsvViewer({
  doc,
  t,
  rootEl,
  ticket,
  settings,
  signal,
  trackCleanup,
  onBackToNative,
  onRetry
}) {
  clearNode(rootEl);

  const chunkSize = Math.max(50, Math.min(2000, Number(settings?.csvChunkSize ?? CSV_DEFAULT_CHUNK_SIZE)));
  let delimiter = 'auto';
  let firstRowHeader = settings?.csvFirstRowHeader !== false;
  let headers = [];
  let columnCount = 0;
  let indexing = { complete: false, indexedDataRows: 0, progressRatio: 0 };
  let encodingWarning = false;

  // Virtual scroll & LRU chunk cache
  const chunkCache = new Map(); // chunkIdx -> rows[]
  const pendingChunkFetches = new Set();
  let searchMode = false;
  let searchQuery = '';
  let searchCol = -1;
  let caseSensitive = false;
  let useRegex = false;
  let searchResults = [];
  let searchTotalMatched = 0;
  let searchScannedRows = 0;
  let searchAbortCtrl = null;
  let searchDebounceTimer = null;
  let pollTimer = null;
  let cellPopoverEl = null;

  trackCleanup(() => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    if (pollTimer) clearTimeout(pollTimer);
    if (searchAbortCtrl) searchAbortCtrl.abort();
  });

  function lruSetChunk(chunkIdx, rows) {
    if (chunkCache.has(chunkIdx)) chunkCache.delete(chunkIdx);
    chunkCache.set(chunkIdx, rows);
    while (chunkCache.size > MAX_LRU_CHUNKS) {
      const oldestKey = chunkCache.keys().next().value;
      chunkCache.delete(oldestKey);
    }
  }

  function getCachedRow(rowIdx) {
    const chunkIdx = Math.floor(rowIdx / chunkSize);
    const list = chunkCache.get(chunkIdx);
    if (!list) return null;
    // Touch LRU
    chunkCache.delete(chunkIdx);
    chunkCache.set(chunkIdx, list);
    return list[rowIdx % chunkSize] || null;
  }

  // Toolbar & filter bar
  const statusBadge = createEl(doc, 'span', { className: 'agy-v-badge', text: t('common.loading') });
  const encodingBadge = createEl(doc, 'span', {
    className: 'agy-v-badge',
    text: t('csv.encodingWarn'),
    style: { display: 'none' }
  });

  const delimSelect = createEl(doc, 'select', {
    className: 'agy-v-select',
    on: {
      change: (e) => {
        delimiter = e.target.value || 'auto';
        void reloadMeta();
      }
    }
  }, [
    createEl(doc, 'option', { value: 'auto', text: t('csv.delimiter.auto') }),
    createEl(doc, 'option', { value: ',', text: t('csv.delimiter.comma') }),
    createEl(doc, 'option', { value: '\t', text: t('csv.delimiter.tab') }),
    createEl(doc, 'option', { value: ';', text: t('csv.delimiter.semi') })
  ]);

  const headerCheckbox = createEl(doc, 'input', {
    type: 'checkbox',
    checked: firstRowHeader,
    on: {
      change: (e) => {
        firstRowHeader = Boolean(e.target.checked);
        void reloadMeta();
      }
    }
  });

  const colSelect = createEl(doc, 'select', {
    className: 'agy-v-select',
    on: {
      change: (e) => {
        searchCol = Number.parseInt(e.target.value, 10);
        if (searchQuery) scheduleSearch();
      }
    }
  });

  const searchInput = createEl(doc, 'input', {
    type: 'text',
    className: 'agy-v-input',
    placeholder: t('csv.searchPlaceholder'),
    style: { width: '160px' },
    on: {
      input: (e) => {
        searchQuery = String(e.target.value || '');
        scheduleSearch();
      }
    }
  });

  const caseCheckbox = createEl(doc, 'input', {
    type: 'checkbox',
    checked: false,
    on: {
      change: (e) => {
        caseSensitive = Boolean(e.target.checked);
        if (searchQuery) scheduleSearch();
      }
    }
  });

  const regexCheckbox = createEl(doc, 'input', {
    type: 'checkbox',
    checked: false,
    on: {
      change: (e) => {
        useRegex = Boolean(e.target.checked);
        if (searchQuery) scheduleSearch();
      }
    }
  });

  const clearBtn = createEl(doc, 'button', {
    type: 'button',
    className: 'agy-v-btn',
    text: t('csv.clearFilter'),
    style: { display: 'none' },
    on: {
      click: () => {
        searchQuery = '';
        searchInput.value = '';
        searchMode = false;
        searchResults = [];
        clearBtn.style.display = 'none';
        searchHitBadge.style.display = 'none';
        renderVisibleRows();
      }
    }
  });

  const searchHitBadge = createEl(doc, 'span', {
    className: 'agy-v-badge',
    style: { display: 'none' }
  });

  const toolbarTop = createEl(doc, 'div', { className: 'agy-v-toolbar' }, [
    createEl(doc, 'span', { className: 'agy-v-badge', text: `${ticket.fileMeta?.name || 'csv'} · ${formatBytes(ticket.fileMeta?.size)}` }),
    statusBadge,
    encodingBadge,
    delimSelect,
    createEl(doc, 'label', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11px' } }, [
      headerCheckbox,
      t('csv.firstRowHeader')
    ]),
    createEl(doc, 'div', { className: 'agy-v-toolbar-spacer' }),
    createEl(doc, 'button', {
      type: 'button',
      className: 'agy-v-btn',
      text: t('common.backToNative'),
      on: { click: () => onBackToNative?.() }
    })
  ]);

  const toolbarFilter = createEl(doc, 'div', { className: 'agy-v-toolbar' }, [
    colSelect,
    searchInput,
    createEl(doc, 'label', { style: { display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '11px' } }, [
      caseCheckbox,
      t('csv.caseSensitive')
    ]),
    createEl(doc, 'label', { style: { display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '11px' } }, [
      regexCheckbox,
      t('csv.regex')
    ]),
    clearBtn,
    searchHitBadge
  ]);

  const viewport = createEl(doc, 'div', {
    className: 'agy-v-csv-viewport',
    on: {
      scroll: () => renderVisibleRows()
    }
  });
  const spacer = createEl(doc, 'div', { className: 'agy-v-csv-spacer' });
  const tableEl = createEl(doc, 'table', { className: 'agy-v-csv-table' });
  const theadEl = createEl(doc, 'thead', { className: 'agy-v-csv-thead' });
  const tbodyEl = createEl(doc, 'tbody');
  tableEl.appendChild(theadEl);
  tableEl.appendChild(tbodyEl);
  spacer.appendChild(tableEl);
  viewport.appendChild(spacer);

  rootEl.appendChild(toolbarTop);
  rootEl.appendChild(toolbarFilter);
  rootEl.appendChild(viewport);

  function updateColumnOptions() {
    clearNode(colSelect);
    colSelect.appendChild(createEl(doc, 'option', { value: '-1', text: t('csv.allColumns') }));
    headers.forEach((h, idx) => {
      colSelect.appendChild(createEl(doc, 'option', {
        value: String(idx),
        text: h || `C${idx + 1}`
      }));
    });
    colSelect.value = String(searchCol);
  }

  function renderTableHeader() {
    clearNode(theadEl);
    const tr = createEl(doc, 'tr');
    tr.appendChild(createEl(doc, 'th', { className: 'agy-v-csv-th agy-v-csv-rownum', text: '#' }));
    const count = Math.max(columnCount, headers.length);
    for (let i = 0; i < count; i++) {
      tr.appendChild(createEl(doc, 'th', {
        className: 'agy-v-csv-th',
        text: headers[i] || `C${i + 1}`,
        title: headers[i] || `C${i + 1}`
      }));
    }
    theadEl.appendChild(tr);
  }

  function updateStatusBadges() {
    if (indexing.complete) {
      statusBadge.textContent = t('csv.indexedDone', {
        rows: indexing.indexedDataRows.toLocaleString(),
        cols: columnCount
      });
    } else {
      const pct = Math.round((indexing.progressRatio || 0) * 100);
      statusBadge.textContent = t('csv.indexing', {
        rows: indexing.indexedDataRows.toLocaleString(),
        percent: pct
      });
    }
    encodingBadge.style.display = encodingWarning ? 'inline-flex' : 'none';
  }

  function closeCellPopover() {
    if (cellPopoverEl) {
      cellPopoverEl.remove?.();
      cellPopoverEl = null;
    }
  }

  async function openCellDetail(rowNumber, colIdx, previewVal, isTruncated) {
    closeCellPopover();
    let displayText = String(previewVal ?? '');
    let truncated256 = false;
    if (isTruncated) {
      try {
        const qs = buildQueryString({
          rowNumber: String(rowNumber),
          col: String(colIdx),
          delimiter,
          firstRowHeader: firstRowHeader ? '1' : '0'
        });
        const resp = await globalThis.fetch(`${ticket.baseUrl}/v1/csv/${ticket.ticketId}/cell?${qs}`, {
          headers: { [TOKEN_HEADER_CANONICAL]: ticket.token },
          signal
        });
        const data = await resp.json();
        if (data?.ok) {
          displayText = data.content || '';
          truncated256 = Boolean(data.truncatedAt256KB);
        }
      } catch {}
    }
    if (signal?.aborted) return;

    const colName = headers[colIdx] || `C${colIdx + 1}`;
    const copyBtn = createEl(doc, 'button', {
      type: 'button',
      className: 'agy-v-btn',
      text: t('common.copy'),
      on: {
        click: async () => {
          await copyText(displayText);
          copyBtn.textContent = t('common.copied');
        }
      }
    });

    cellPopoverEl = createEl(doc, 'div', { className: 'agy-v-popover' }, [
      createEl(doc, 'div', { className: 'agy-v-toolbar' }, [
        createEl(doc, 'span', { className: 'agy-v-badge', text: t('csv.cellDetailTitle', { row: rowNumber, col: colName }) }),
        createEl(doc, 'div', { className: 'agy-v-toolbar-spacer' }),
        copyBtn,
        createEl(doc, 'button', {
          type: 'button',
          className: 'agy-v-btn',
          text: t('common.close'),
          on: { click: () => closeCellPopover() }
        })
      ]),
      truncated256 ? createEl(doc, 'div', { className: 'agy-v-banner-warn', text: t('csv.cellTruncatedAt256KB') }) : null,
      createEl(doc, 'div', { className: 'agy-v-popover-body', text: displayText })
    ]);
    rootEl.appendChild(cellPopoverEl);
  }

  async function fetchChunk(chunkIdx) {
    if (pendingChunkFetches.has(chunkIdx) || signal?.aborted) return;
    pendingChunkFetches.add(chunkIdx);
    const offset = chunkIdx * chunkSize;
    try {
      const qs = buildQueryString({
        offset: String(offset),
        limit: String(chunkSize),
        delimiter,
        firstRowHeader: firstRowHeader ? '1' : '0'
      });
      const resp = await globalThis.fetch(`${ticket.baseUrl}/v1/csv/${ticket.ticketId}/rows?${qs}`, {
        headers: { [TOKEN_HEADER_CANONICAL]: ticket.token },
        signal
      });
      const data = await resp.json();
      if (!signal?.aborted && data?.ok && Array.isArray(data.rows)) {
        lruSetChunk(chunkIdx, data.rows);
        if (data.indexing) indexing = data.indexing;
        updateStatusBadges();
        renderVisibleRows();
      }
    } catch {} finally {
      pendingChunkFetches.delete(chunkIdx);
    }
  }

  function renderVisibleRows() {
    const activeRows = searchMode ? searchResults : null;
    const totalRows = searchMode ? activeRows.length : Math.max(0, indexing.indexedDataRows || 0);
    const logicalHeight = totalRows * ROW_HEIGHT_PX;
    const scrollScale = logicalHeight > MAX_BROWSER_SCROLL_PX ? (MAX_BROWSER_SCROLL_PX / logicalHeight) : 1;
    const virtualHeight = Math.max(ROW_HEIGHT_PX, Math.round(logicalHeight * scrollScale));
    spacer.style.height = `${virtualHeight}px`;

    const scrollTop = Number(viewport.scrollTop || 0);
    const viewHeight = Number(viewport.clientHeight || 480);
    const firstVisible = Math.max(0, Math.floor((scrollTop / Math.max(1e-6, scrollScale)) / ROW_HEIGHT_PX) - VIEWPORT_BUFFER_ROWS);
    const visibleCount = Math.ceil(viewHeight / ROW_HEIGHT_PX) + VIEWPORT_BUFFER_ROWS * 2;
    const endVisible = Math.min(totalRows, firstVisible + visibleCount);

    tableEl.style.transform = `translateY(${Math.round(firstVisible * ROW_HEIGHT_PX * scrollScale)}px)`;
    clearNode(tbodyEl);

    if (totalRows === 0) {
      const tr = createEl(doc, 'tr', { attrs: { 'data-row-number': String(rowObj.rowNumber) } });
      tr.appendChild(createEl(doc, 'td', {
        className: 'agy-v-csv-td',
        text: t('csv.emptyRows'),
        attrs: { colspan: String(Math.max(1, columnCount + 1)) }
      }));
      tbodyEl.appendChild(tr);
      return;
    }

    const colSpan = Math.max(columnCount, headers.length);
    for (let i = firstVisible; i < endVisible; i++) {
      let rowObj = searchMode ? activeRows[i] : getCachedRow(i);
      if (!rowObj && !searchMode) {
        void fetchChunk(Math.floor(i / chunkSize));
        rowObj = { rowNumber: i + 1, cells: [], truncatedCols: [] };
      }
      const tr = createEl(doc, 'tr', { attrs: { 'data-row-number': String(rowObj.rowNumber) } });
      tr.appendChild(createEl(doc, 'td', {
        className: 'agy-v-csv-td agy-v-csv-rownum',
        text: String(rowObj.rowNumber)
      }));

      const truncMap = new Map((rowObj.truncatedCols || []).map((tc) => [tc.col, tc.totalChars]));
      for (let c = 0; c < colSpan; c++) {
        const val = rowObj.cells?.[c] ?? '';
        const isTruncated = truncMap.has(c);
        const td = createEl(doc, 'td', {
          className: 'agy-v-csv-td',
          title: isTruncated ? t('csv.truncatedHint', { chars: truncMap.get(c) }) : val,
          on: {
            click: () => void openCellDetail(rowObj.rowNumber, c, val, isTruncated)
          }
        });
        if (searchMode && searchQuery && (searchCol < 0 || searchCol === c)) {
          appendHighlightedCellText(doc, td, val, searchQuery, caseSensitive, useRegex);
        } else {
          td.textContent = val;
        }
        tr.appendChild(td);
      }
      tbodyEl.appendChild(tr);
    }
  }

  function scheduleSearch() {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    if (!searchQuery.trim()) {
      searchMode = false;
      searchResults = [];
      clearBtn.style.display = 'none';
      searchHitBadge.style.display = 'none';
      renderVisibleRows();
      return;
    }
    clearBtn.style.display = 'inline-flex';
    searchDebounceTimer = setTimeout(() => {
      void executeSearch();
    }, 250);
  }

  async function executeSearch() {
    if (searchAbortCtrl) searchAbortCtrl.abort();
    searchAbortCtrl = new AbortController();
    const localSignal = searchAbortCtrl.signal;

    const qs = buildQueryString({
      q: searchQuery,
      col: String(searchCol),
      caseSensitive: caseSensitive ? '1' : '0',
      regex: useRegex ? '1' : '0',
      offset: '0',
      limit: String(Math.min(2000, Math.max(chunkSize, 500))),
      delimiter,
      firstRowHeader: firstRowHeader ? '1' : '0'
    });

    try {
      const resp = await globalThis.fetch(`${ticket.baseUrl}/v1/csv/${ticket.ticketId}/search?${qs}`, {
        headers: { [TOKEN_HEADER_CANONICAL]: ticket.token },
        signal: localSignal
      });
      const data = await resp.json();
      if (localSignal.aborted || signal?.aborted) return;
      if (!data?.ok) {
        searchHitBadge.style.display = 'inline-flex';
        searchHitBadge.textContent = data?.errorCode === 'INVALID_REGEX' ? t('csv.invalidRegex') : (data?.message || 'ERROR');
        return;
      }
      searchMode = true;
      searchResults = data.matches || [];
      searchTotalMatched = Number(data.totalMatched || 0);
      searchScannedRows = Number(data.scannedRows || 0);
      searchHitBadge.style.display = 'inline-flex';
      searchHitBadge.textContent = t('csv.searchHitSummary', {
        matched: searchTotalMatched.toLocaleString(),
        scanned: searchScannedRows.toLocaleString()
      });
      viewport.scrollTop = 0;
      renderVisibleRows();
    } catch {}
  }

  function scheduleIndexPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    if (indexing.complete || signal?.aborted) return;
    pollTimer = setTimeout(async () => {
      if (signal?.aborted) return;
      try {
        const qs = buildQueryString({
          offset: '0',
          limit: '1',
          delimiter,
          firstRowHeader: firstRowHeader ? '1' : '0'
        });
        const resp = await globalThis.fetch(`${ticket.baseUrl}/v1/csv/${ticket.ticketId}/rows?${qs}`, {
          headers: { [TOKEN_HEADER_CANONICAL]: ticket.token },
          signal
        });
        const data = await resp.json();
        if (!signal?.aborted && data?.ok && data.indexing) {
          indexing = data.indexing;
          updateStatusBadges();
          renderVisibleRows();
          scheduleIndexPolling();
        }
      } catch {}
    }, 350);
  }

  async function reloadMeta() {
    chunkCache.clear();
    closeCellPopover();
    try {
      const qs = buildQueryString({
        delimiter,
        firstRowHeader: firstRowHeader ? '1' : '0',
        limit: String(chunkSize)
      });
      const resp = await globalThis.fetch(`${ticket.baseUrl}/v1/csv/${ticket.ticketId}/meta?${qs}`, {
        headers: { [TOKEN_HEADER_CANONICAL]: ticket.token },
        signal
      });
      const data = await resp.json();
      if (signal?.aborted) return;
      if (!data?.ok) {
        clearNode(rootEl);
        rootEl.appendChild(renderStatusCard(doc, {
          title: t('error.loadFailed', { message: data?.message || data?.errorCode || 'CSV_META_FAILED' }),
          actions: [
            { label: t('common.retry'), onClick: () => onRetry?.() },
            { label: t('common.backToNative'), onClick: () => onBackToNative?.() }
          ]
        }));
        return;
      }

      headers = Array.isArray(data.headers) ? data.headers : [];
      columnCount = Number(data.columnCount || headers.length || 0);
      encodingWarning = Boolean(data.encodingWarning);
      indexing = data.indexing || indexing;
      if (Array.isArray(data.chunk?.rows)) {
        lruSetChunk(0, data.chunk.rows);
      }

      updateColumnOptions();
      renderTableHeader();
      updateStatusBadges();
      if (searchMode && searchQuery) {
        void executeSearch();
      } else {
        renderVisibleRows();
      }
      scheduleIndexPolling();
    } catch (err) {
      if (signal?.aborted) return;
      clearNode(rootEl);
      rootEl.appendChild(renderStatusCard(doc, {
        title: t('error.loadFailed', { message: err?.message || 'CSV_FETCH_ERROR' }),
        actions: [
          { label: t('common.retry'), onClick: () => onRetry?.() },
          { label: t('common.backToNative'), onClick: () => onBackToNative?.() }
        ]
      }));
    }
  }

  await reloadMeta();
}

module.exports = {
  ROW_HEIGHT_PX,
  appendHighlightedCellText,
  mountCsvViewer
};
