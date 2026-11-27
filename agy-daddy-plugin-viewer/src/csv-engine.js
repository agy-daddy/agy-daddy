'use strict';

const fs = require('node:fs');
const {
  CSV_CHECKPOINT_STRIDE,
  CSV_SCAN_CHUNK_BYTES,
  CSV_CELL_PREVIEW_MAX_CHARS,
  CSV_CELL_FULL_MAX_CHARS,
  CSV_INSPECT_SAMPLE_BYTES,
  CSV_DEFAULT_CHUNK_SIZE,
  CSV_MAX_CHUNK_SIZE,
  ERROR_CODES,
  safeErrorPayload
} = require('./constants');

const UTF8_CHECK_BYTES = 8192;

function normalizeDelimiterParam(raw) {
  if (!raw || raw === 'auto') return 'auto';
  if (raw === ',' || raw === 'comma') return ',';
  if (raw === '\t' || raw === 'tab' || raw === '\\t') return '\t';
  if (raw === ';' || raw === 'semicolon') return ';';
  return 'auto';
}

function hasUtf8Bom(buf) {
  return Boolean(buf && buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF);
}

function checkUtf8ValidSample(buf) {
  if (!buf || buf.length === 0) return true;
  // Trim trailing partial multi-byte UTF-8 sequence up to 3 bytes so boundary does not false-positive
  let end = Math.min(buf.length, UTF8_CHECK_BYTES);
  if (buf.length > end) {
    let back = 0;
    while (back < 3 && end - back > 0 && (buf[end - 1 - back] & 0xC0) === 0x80) {
      back++;
    }
    if (back > 0 && end - back > 0 && (buf[end - 1 - back] & 0xC0) === 0xC0) {
      end = end - 1 - back;
    } else if (end > 0 && (buf[end - 1] & 0xC0) === 0xC0) {
      end -= 1;
    }
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}

function detectDelimiterFromSample(text) {
  const candidates = [',', '\t', ';'];
  const lines = [];
  let inQuotes = false;
  let cur = '';
  for (let i = 0; i < text.length && lines.length < 10; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '""';
        i++;
      } else {
        inQuotes = !inQuotes;
        cur += ch;
      }
    } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      lines.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0 && lines.length < 10) lines.push(cur);
  if (lines.length === 0) return ',';

  let bestDelim = ',';
  let bestScore = -1;

  for (const delim of candidates) {
    const counts = lines.map((line) => {
      let c = 0;
      let q = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') q = !q;
        else if (!q && line[i] === delim) c++;
      }
      return c;
    });
    const first = counts[0] || 0;
    if (first === 0) continue;
    const consistent = counts.every((c) => c === first);
    const score = first * (consistent ? 100 : 10);
    if (score > bestScore) {
      bestScore = score;
      bestDelim = delim;
    }
  }
  return bestDelim;
}

/**
 * Parses a single RFC 4180 CSV logical row buffer into string cells.
 */
function parseCsvRowBuffer(rowBuf, delimiterByte) {
  const cells = [];
  let fieldBytes = [];
  let inQuotes = false;
  let fieldStart = true;

  for (let i = 0; i < rowBuf.length; i++) {
    const b = rowBuf[i];
    if (inQuotes) {
      if (b === 0x22) {
        if (i + 1 < rowBuf.length && rowBuf[i + 1] === 0x22) {
          fieldBytes.push(0x22);
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        fieldBytes.push(b);
      }
    } else if (fieldStart && b === 0x22) {
      inQuotes = true;
      fieldStart = false;
    } else if (b === delimiterByte) {
      cells.push(Buffer.from(fieldBytes).toString('utf8'));
      fieldBytes = [];
      fieldStart = true;
    } else {
      fieldBytes.push(b);
      fieldStart = false;
    }
  }
  cells.push(Buffer.from(fieldBytes).toString('utf8'));
  return cells;
}

function formatPreviewRow(rowNumber, rawCells) {
  const truncatedCols = [];
  const cells = rawCells.map((val, colIdx) => {
    if (val.length > CSV_CELL_PREVIEW_MAX_CHARS) {
      truncatedCols.push({ col: colIdx, totalChars: val.length });
      return val.slice(0, CSV_CELL_PREVIEW_MAX_CHARS);
    }
    return val;
  });
  return { rowNumber, cells, truncatedCols };
}

/**
 * Lightweight 64KB header sample line estimator for /file/inspect.
 */
function inspectCsvHeaderSample(realPath, fileSize) {
  const sampleLen = Math.min(Number(fileSize) || 0, CSV_INSPECT_SAMPLE_BYTES);
  if (sampleLen === 0) return { estimatedLines: 0 };

  const fd = fs.openSync(realPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(sampleLen);
    const bytesRead = fs.readSync(fd, buf, 0, sampleLen, 0);
    const start = hasUtf8Bom(buf.subarray(0, bytesRead)) ? 3 : 0;
    let inQuotes = false;
    let logicalLines = 0;
    for (let i = start; i < bytesRead; i++) {
      const b = buf[i];
      if (b === 0x22) {
        if (inQuotes && i + 1 < bytesRead && buf[i + 1] === 0x22) {
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (!inQuotes && (b === 0x0A || b === 0x0D)) {
        if (b === 0x0D && i + 1 < bytesRead && buf[i + 1] === 0x0A) {
          i++;
        }
        logicalLines++;
      }
    }
    // Count trailing non-empty line if file ends within sample
    if (bytesRead < fileSize) {
      const ratio = fileSize / Math.max(1, bytesRead - start);
      return { estimatedLines: Math.max(logicalLines, Math.round(logicalLines * ratio)) };
    }
    if (bytesRead > start && buf[bytesRead - 1] !== 0x0A && buf[bytesRead - 1] !== 0x0D) {
      logicalLines++;
    }
    return { estimatedLines: logicalLines };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Iterates logical RFC 4180 rows from a byte offset using exact byte boundaries.
 * Callback `onRow(rowBuf, rowStartOffset, nextRowOffset)` returns false to stop early.
 */
async function streamLogicalRowsFromOffset(realPath, startByteOffset, options = {}) {
  const chunkSize = Number(options.chunkBytes) > 0 ? Number(options.chunkBytes) : CSV_SCAN_CHUNK_BYTES;
  const yieldBetweenChunks = options.yieldBetweenChunks !== false;
  const signal = options.signal || null;
  const onRow = options.onRow;
  const onChunkProgress = options.onChunkProgress;

  const fh = await fs.promises.open(realPath, 'r');
  try {
    const stat = await fh.stat();
    const totalSize = stat.size;
    let offset = Math.max(0, startByteOffset);
    let inQuotes = false;
    let pendingChunks = [];
    let pendingRowStart = offset;
    let pendingCR = false;

    const flushRow = (endExclusiveByte, nextStartByte) => {
      const rowBuf = pendingChunks.length === 1 ? pendingChunks[0] : Buffer.concat(pendingChunks);
      pendingChunks = [];
      const res = onRow(rowBuf, pendingRowStart, nextStartByte, endExclusiveByte);
      pendingRowStart = nextStartByte;
      return res !== false;
    };

    const readBuf = Buffer.allocUnsafe(chunkSize);
    while (offset < totalSize) {
      if (signal?.aborted) {
        return { aborted: true, scannedBytes: offset, totalSize };
      }

      const { bytesRead } = await fh.read(readBuf, 0, chunkSize, offset);
      if (bytesRead <= 0) break;

      const chunk = readBuf.subarray(0, bytesRead);
      let sliceStart = 0;

      for (let i = 0; i < bytesRead; i++) {
        const absPos = offset + i;
        const b = chunk[i];

        if (pendingCR) {
          pendingCR = false;
          if (b === 0x0A) {
            // Complete CRLF across chunk boundary
            const cont = flushRow(absPos - 1, absPos + 1);
            sliceStart = i + 1;
            if (!cont) return { aborted: false, stoppedEarly: true, scannedBytes: absPos + 1, totalSize };
            continue;
          } else {
            const cont = flushRow(absPos - 1, absPos);
            sliceStart = i;
            if (!cont) return { aborted: false, stoppedEarly: true, scannedBytes: absPos, totalSize };
          }
        }

        if (b === 0x22) {
          // Toggle quote state (escaped "" toggles twice and restores state)
          inQuotes = !inQuotes;
        } else if (!inQuotes && b === 0x0A) {
          if (i > sliceStart) pendingChunks.push(Buffer.from(chunk.subarray(sliceStart, i)));
          const cont = flushRow(absPos, absPos + 1);
          sliceStart = i + 1;
          if (!cont) return { aborted: false, stoppedEarly: true, scannedBytes: absPos + 1, totalSize };
        } else if (!inQuotes && b === 0x0D) {
          if (i > sliceStart) pendingChunks.push(Buffer.from(chunk.subarray(sliceStart, i)));
          if (i + 1 < bytesRead) {
            if (chunk[i + 1] === 0x0A) {
              const cont = flushRow(absPos, absPos + 2);
              i++;
              sliceStart = i + 1;
              if (!cont) return { aborted: false, stoppedEarly: true, scannedBytes: absPos + 2, totalSize };
            } else {
              const cont = flushRow(absPos, absPos + 1);
              sliceStart = i + 1;
              if (!cont) return { aborted: false, stoppedEarly: true, scannedBytes: absPos + 1, totalSize };
            }
          } else {
            pendingCR = true;
            sliceStart = bytesRead;
          }
        }
      }

      if (sliceStart < bytesRead) {
        pendingChunks.push(Buffer.from(chunk.subarray(sliceStart, bytesRead)));
      }

      offset += bytesRead;
      if (typeof onChunkProgress === 'function') {
        onChunkProgress(offset, totalSize);
      }

      if (yieldBetweenChunks && offset < totalSize) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    if (pendingCR) {
      pendingCR = false;
      flushRow(offset - 1, offset);
    } else if (pendingChunks.length > 0) {
      const tailBuf = Buffer.concat(pendingChunks);
      if (tailBuf.length > 0) {
        pendingChunks = [tailBuf];
        flushRow(offset, offset);
      }
    }

    return { aborted: false, stoppedEarly: false, scannedBytes: offset, totalSize };
  } finally {
    await fh.close().catch(() => {});
  }
}

class CsvFileIndexer {
  constructor(realPath, stat, options = {}) {
    this.realPath = realPath;
    this.fileSize = Number(stat.size);
    this.mtimeMs = Number(stat.mtimeMs);
    this.hasBom = false;
    this.encodingWarning = false;
    this.detectedDelimiter = ',';
    this.startOffset = 0;
    this.checkpoints = [];
    this.totalLogicalRows = 0;
    this.scannedBytes = 0;
    this.complete = this.fileSize === 0;
    this.error = null;
    this.firstRowCells = null;
    this.columnCount = 0;
    this._abortCtrl = new AbortController();
    this._waiters = [];
    this._scanStarted = false;
    this._chunkBytes = Number(options.chunkBytes) > 0 ? Number(options.chunkBytes) : CSV_SCAN_CHUNK_BYTES;
  }

  dispose() {
    this._abortCtrl.abort();
    this._notifyWaiters();
  }

  _notifyWaiters() {
    const list = this._waiters;
    this._waiters = [];
    for (const resolve of list) {
      try { resolve(); } catch {}
    }
  }

  _probeHeaderSampleSync() {
    const sampleSize = Math.min(this.fileSize, 65536);
    if (sampleSize === 0) {
      this.hasBom = false;
      this.encodingWarning = false;
      this.startOffset = 0;
      this.detectedDelimiter = ',';
      this.checkpoints = [{ rowIndex: 0, byteOffset: 0 }];
      this.complete = true;
      return;
    }

    const fd = fs.openSync(this.realPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(sampleSize);
      const bytesRead = fs.readSync(fd, buf, 0, sampleSize, 0);
      const sample = buf.subarray(0, bytesRead);
      this.hasBom = hasUtf8Bom(sample);
      this.startOffset = this.hasBom ? 3 : 0;
      this.encodingWarning = !checkUtf8ValidSample(sample.subarray(this.startOffset));
      const text = new TextDecoder('utf-8', { fatal: false }).decode(sample.subarray(this.startOffset));
      this.detectedDelimiter = detectDelimiterFromSample(text);
      this.checkpoints = [{ rowIndex: 0, byteOffset: this.startOffset }];
    } finally {
      fs.closeSync(fd);
    }
  }

  startBackgroundScan() {
    if (this._scanStarted) return;
    this._scanStarted = true;
    this._probeHeaderSampleSync();

    if (this.fileSize <= this.startOffset) {
      this.complete = true;
      this.scannedBytes = this.fileSize;
      this._notifyWaiters();
      return;
    }

    const delimByte = this.detectedDelimiter.charCodeAt(0);
    let logicalRowCount = 0;

    void streamLogicalRowsFromOffset(this.realPath, this.startOffset, {
      chunkBytes: this._chunkBytes,
      signal: this._abortCtrl.signal,
      yieldBetweenChunks: true,
      onRow: (rowBuf, _rowStart, nextRowOffset) => {
        if (logicalRowCount === 0) {
          this.firstRowCells = parseCsvRowBuffer(rowBuf, delimByte);
          this.columnCount = this.firstRowCells.length;
        }
        logicalRowCount++;
        this.totalLogicalRows = logicalRowCount;
        if (logicalRowCount % CSV_CHECKPOINT_STRIDE === 0) {
          this.checkpoints.push({ rowIndex: logicalRowCount, byteOffset: nextRowOffset });
        }
        if (logicalRowCount === 250 || logicalRowCount % 512 === 0) {
          this._notifyWaiters();
        }
        return true;
      },
      onChunkProgress: (scanned) => {
        this.scannedBytes = scanned;
        this._notifyWaiters();
      }
    }).then((res) => {
      if (!res?.aborted) {
        this.scannedBytes = this.fileSize;
        this.complete = true;
      }
      this._notifyWaiters();
    }).catch((err) => {
      this.error = err;
      this.complete = true;
      this._notifyWaiters();
    });
  }

  async waitUntilRowsOrComplete(minLogicalRows) {
    this.startBackgroundScan();
    while (!this.complete && this.totalLogicalRows < minLogicalRows && !this._abortCtrl.signal.aborted) {
      await new Promise((resolve) => this._waiters.push(resolve));
    }
  }

  getIndexingSnapshot(firstRowHeader = true) {
    const dataRows = firstRowHeader
      ? Math.max(0, this.totalLogicalRows - 1)
      : this.totalLogicalRows;
    const progressRatio = this.fileSize === 0
      ? 1
      : Math.min(1, Math.round((this.scannedBytes / this.fileSize) * 1000) / 1000);
    return {
      complete: this.complete,
      indexedDataRows: dataRows,
      scannedBytes: this.scannedBytes,
      progressRatio
    };
  }

  _findCheckpointForLogicalRow(targetRow) {
    let chosen = this.checkpoints[0] || { rowIndex: 0, byteOffset: this.startOffset };
    // Binary search over checkpoints
    let lo = 0;
    let hi = this.checkpoints.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const cp = this.checkpoints[mid];
      if (cp.rowIndex <= targetRow) {
        chosen = cp;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return chosen;
  }

  async readLogicalRowRange(startLogicalRow, count, delimiterChar) {
    this.startBackgroundScan();
    await this.waitUntilRowsOrComplete(startLogicalRow + count);

    const cp = this._findCheckpointForLogicalRow(startLogicalRow);
    const delimByte = delimiterChar.charCodeAt(0);
    const rows = [];
    let currentRow = cp.rowIndex;

    await streamLogicalRowsFromOffset(this.realPath, cp.byteOffset, {
      chunkBytes: Math.min(this._chunkBytes, 256 * 1024),
      yieldBetweenChunks: false,
      onRow: (rowBuf) => {
        if (currentRow >= startLogicalRow && rows.length < count) {
          rows.push({
            logicalRow: currentRow,
            cells: parseCsvRowBuffer(rowBuf, delimByte)
          });
        }
        currentRow++;
        return rows.length < count;
      }
    });

    return rows;
  }
}

function createCsvEngine(options = {}) {
  const indexes = new Map();

  function getOrCreateIndex(realPath, stat) {
    const existing = indexes.get(realPath);
    if (existing && existing.mtimeMs === Number(stat.mtimeMs) && existing.fileSize === Number(stat.size)) {
      return existing;
    }
    if (existing) {
      existing.dispose();
      indexes.delete(realPath);
    }
    const created = new CsvFileIndexer(realPath, stat, options);
    indexes.set(realPath, created);
    return created;
  }

  function resolveEffectiveDelimiter(idx, delimiterParam) {
    const norm = normalizeDelimiterParam(delimiterParam);
    return norm === 'auto' ? idx.detectedDelimiter : norm;
  }

  function buildHeaders(idx, delimiter, firstRowHeader, sampleRow) {
    const rawFirst = (delimiter === idx.detectedDelimiter && idx.firstRowCells)
      ? idx.firstRowCells
      : (sampleRow ? sampleRow.cells : []);
    const colCount = rawFirst.length || idx.columnCount || 0;
    if (firstRowHeader) {
      return { headers: rawFirst, columnCount: colCount };
    }
    const headers = [];
    for (let i = 1; i <= colCount; i++) {
      headers.push(`C${i}`);
    }
    return { headers, columnCount: colCount };
  }

  async function getMeta(realPath, stat, query = {}) {
    const idx = getOrCreateIndex(realPath, stat);
    const firstRowHeader = query.firstRowHeader !== '0' && query.firstRowHeader !== false;
    const limit = Math.max(1, Math.min(CSV_MAX_CHUNK_SIZE, Number.parseInt(query.limit ?? CSV_DEFAULT_CHUNK_SIZE, 10) || CSV_DEFAULT_CHUNK_SIZE));
    idx.startBackgroundScan();
    const minLogical = (firstRowHeader ? 1 : 0) + limit;
    await idx.waitUntilRowsOrComplete(minLogical);

    const activeDelimiter = resolveEffectiveDelimiter(idx, query.delimiter);
    const startLogical = firstRowHeader ? 1 : 0;
    const rawFirstRow = firstRowHeader
      ? (await idx.readLogicalRowRange(0, 1, activeDelimiter))[0]
      : null;
    const dataSlice = await idx.readLogicalRowRange(startLogical, limit, activeDelimiter);
    const { headers, columnCount } = buildHeaders(idx, activeDelimiter, firstRowHeader, rawFirstRow || dataSlice[0]);

    const rows = dataSlice.map((entry, i) => formatPreviewRow(i + 1, entry.cells));
    return {
      ok: true,
      fileSize: idx.fileSize,
      hasBom: idx.hasBom,
      encodingWarning: idx.encodingWarning,
      detectedDelimiter: idx.detectedDelimiter,
      activeDelimiter,
      firstRowHeader,
      headers,
      columnCount,
      indexing: idx.getIndexingSnapshot(firstRowHeader),
      chunk: {
        offset: 0,
        limit,
        rows
      }
    };
  }

  async function getRows(realPath, stat, query = {}) {
    const idx = getOrCreateIndex(realPath, stat);
    const firstRowHeader = query.firstRowHeader !== '0' && query.firstRowHeader !== false;
    const offset = Math.max(0, Number.parseInt(query.offset ?? 0, 10) || 0);
    const limit = Math.max(1, Math.min(CSV_MAX_CHUNK_SIZE, Number.parseInt(query.limit ?? CSV_DEFAULT_CHUNK_SIZE, 10) || CSV_DEFAULT_CHUNK_SIZE));
    idx.startBackgroundScan();

    const activeDelimiter = resolveEffectiveDelimiter(idx, query.delimiter);
    const startLogical = (firstRowHeader ? 1 : 0) + offset;
    const dataSlice = await idx.readLogicalRowRange(startLogical, limit, activeDelimiter);
    const rows = dataSlice.map((entry, i) => formatPreviewRow(offset + i + 1, entry.cells));

    return {
      ok: true,
      offset,
      limit,
      rows,
      indexing: idx.getIndexingSnapshot(firstRowHeader)
    };
  }

  async function getCell(realPath, stat, query = {}) {
    const idx = getOrCreateIndex(realPath, stat);
    const firstRowHeader = query.firstRowHeader !== '0' && query.firstRowHeader !== false;
    const rowNumber = Number.parseInt(query.rowNumber, 10);
    const col = Number.parseInt(query.col, 10);
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || !Number.isInteger(col) || col < 0) {
      return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.INVALID_ARGUMENT, 'rowNumber 与 col 参数无效') };
    }

    idx.startBackgroundScan();
    const activeDelimiter = resolveEffectiveDelimiter(idx, query.delimiter);
    const targetLogical = (firstRowHeader ? 1 : 0) + (rowNumber - 1);
    const slice = await idx.readLogicalRowRange(targetLogical, 1, activeDelimiter);
    if (slice.length === 0) {
      return { ok: false, statusCode: 404, ...safeErrorPayload(ERROR_CODES.NOT_FOUND, '目标单元格行不存在') };
    }
    const rawVal = slice[0].cells[col] ?? '';
    const truncatedAt256KB = rawVal.length > CSV_CELL_FULL_MAX_CHARS;
    return {
      ok: true,
      rowNumber,
      col,
      content: truncatedAt256KB ? rawVal.slice(0, CSV_CELL_FULL_MAX_CHARS) : rawVal,
      truncatedAt256KB
    };
  }

  async function search(realPath, stat, query = {}, signal = null) {
    const idx = getOrCreateIndex(realPath, stat);
    idx.startBackgroundScan();
    await idx.waitUntilRowsOrComplete(1);

    const q = String(query.q ?? '');
    if (q.length > 500) {
      return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.INVALID_ARGUMENT, '检索关键字过长') };
    }
    const col = query.col !== undefined ? Number.parseInt(query.col, 10) : -1;
    const caseSensitive = query.caseSensitive === '1' || query.caseSensitive === true;
    const useRegex = query.regex === '1' || query.regex === true;
    const offset = Math.max(0, Number.parseInt(query.offset ?? 0, 10) || 0);
    const limit = Math.max(1, Math.min(CSV_MAX_CHUNK_SIZE, Number.parseInt(query.limit ?? CSV_DEFAULT_CHUNK_SIZE, 10) || CSV_DEFAULT_CHUNK_SIZE));
    const firstRowHeader = query.firstRowHeader !== '0' && query.firstRowHeader !== false;
    const activeDelimiter = resolveEffectiveDelimiter(idx, query.delimiter);
    const delimByte = activeDelimiter.charCodeAt(0);

    let matcherRegex = null;
    if (useRegex) {
      try {
        matcherRegex = new RegExp(q, caseSensitive ? '' : 'i');
      } catch {
        return { ok: false, statusCode: 400, ...safeErrorPayload(ERROR_CODES.INVALID_REGEX) };
      }
    }
    const needle = caseSensitive ? q : q.toLowerCase();

    const matches = [];
    let totalMatched = 0;
    let scannedDataRows = 0;
    let logicalRow = 0;

    const cellMatches = (val) => {
      if (!q) return true;
      if (matcherRegex) {
        matcherRegex.lastIndex = 0;
        return matcherRegex.test(val);
      }
      return (caseSensitive ? val : val.toLowerCase()).includes(needle);
    };

    const res = await streamLogicalRowsFromOffset(realPath, idx.startOffset, {
      chunkBytes: idx._chunkBytes,
      yieldBetweenChunks: true,
      signal,
      onRow: (rowBuf) => {
        if (signal?.aborted) return false;
        const curLogical = logicalRow++;
        if (firstRowHeader && curLogical === 0) return true;
        const dataRowNumber = firstRowHeader ? curLogical : curLogical + 1;
        scannedDataRows++;

        const rawCells = parseCsvRowBuffer(rowBuf, delimByte);
        let hit = false;
        if (col >= 0) {
          if (col < rawCells.length && cellMatches(rawCells[col])) hit = true;
        } else {
          for (let c = 0; c < rawCells.length; c++) {
            if (cellMatches(rawCells[c])) {
              hit = true;
              break;
            }
          }
        }

        if (hit) {
          if (totalMatched >= offset && matches.length < limit) {
            matches.push(formatPreviewRow(dataRowNumber, rawCells));
          }
          totalMatched++;
        }
        return true;
      }
    });

    return {
      ok: true,
      query: q,
      col,
      totalMatched,
      scannedRows: scannedDataRows,
      complete: !res.aborted,
      matches
    };
  }

  function invalidate(realPath) {
    if (realPath) {
      const idx = indexes.get(realPath);
      if (idx) {
        idx.dispose();
        indexes.delete(realPath);
      }
      return;
    }
    for (const idx of indexes.values()) {
      idx.dispose();
    }
    indexes.clear();
  }

  function getIndexedCount() {
    return indexes.size;
  }

  return {
    getMeta,
    getRows,
    getCell,
    search,
    invalidate,
    getIndexedCount
  };
}

module.exports = {
  normalizeDelimiterParam,
  hasUtf8Bom,
  checkUtf8ValidSample,
  detectDelimiterFromSample,
  parseCsvRowBuffer,
  inspectCsvHeaderSample,
  createCsvEngine
};
