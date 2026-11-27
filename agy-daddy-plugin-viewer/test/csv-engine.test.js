'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ERROR_CODES } = require('../src/constants');
const {
  inspectCsvHeaderSample,
  createCsvEngine
} = require('../src/csv-engine');

test('csv-engine: handles UTF-8 BOM, RFC 4180 quoted newlines/escapes, sparse checkpoints & pagination', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-viewer-csv-'));
  try {
    const csvPath = path.join(tmp, 'records.csv');
    const lines = ['id,note,long_col'];
    const hugeVal = 'X'.repeat(5000);
    for (let i = 1; i <= 700; i++) {
      if (i === 2) {
        lines.push(`${i},"multi\nline ""quoted"" text",ok`);
      } else if (i === 520) {
        lines.push(`${i},"中文列,含逗号","${hugeVal}"`);
      } else {
        lines.push(`${i},row_${i},val_${i}`);
      }
    }
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    fs.writeFileSync(csvPath, Buffer.concat([bom, Buffer.from(lines.join('\n') + '\n', 'utf8')]));
    const stat = fs.statSync(csvPath);

    const sample = inspectCsvHeaderSample(csvPath, stat.size);
    assert.ok(sample.estimatedLines >= 600);

    const engine = createCsvEngine({ chunkBytes: 4096 });
    const meta = await engine.getMeta(csvPath, stat, { firstRowHeader: '1', limit: '50' });
    assert.equal(meta.ok, true);
    assert.equal(meta.hasBom, true);
    assert.equal(meta.detectedDelimiter, ',');
    assert.deepEqual(meta.headers, ['id', 'note', 'long_col']);
    assert.equal(meta.chunk.rows.length, 50);
    assert.equal(meta.chunk.rows[1].rowNumber, 2);
    assert.deepEqual(meta.chunk.rows[1].cells, ['2', 'multi\nline "quoted" text', 'ok']);

    // Seek across multiple 256-row sparse checkpoints
    const page = await engine.getRows(csvPath, stat, { offset: '518', limit: '5', firstRowHeader: '1' });
    assert.equal(page.ok, true);
    assert.equal(page.rows.length, 5);
    const row520 = page.rows.find((r) => r.rowNumber === 520);
    assert.ok(row520);
    assert.equal(row520.cells[1], '中文列,含逗号');
    assert.equal(row520.cells[2].length, 4096);
    assert.deepEqual(row520.truncatedCols, [{ col: 2, totalChars: 5000 }]);

    // Fetch full untruncated cell
    const cellRes = await engine.getCell(csvPath, stat, { rowNumber: '520', col: '2', firstRowHeader: '1' });
    assert.equal(cellRes.ok, true);
    assert.equal(cellRes.content.length, 5000);
    assert.equal(cellRes.truncatedAt256KB, false);

    // firstRowHeader = 0 -> C1..Cn headers
    const noHdr = await engine.getMeta(csvPath, stat, { firstRowHeader: '0', limit: '3' });
    assert.deepEqual(noHdr.headers, ['C1', 'C2', 'C3']);
    assert.deepEqual(noHdr.chunk.rows[0].cells, ['id', 'note', 'long_col']);

    engine.invalidate();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('csv-engine: supports column/regex search, rejects invalid regex, and respects AbortController', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-viewer-csv-search-'));
  try {
    const tsvPath = path.join(tmp, 'logs.tsv');
    const rows = ['ts\tlevel\tmsg'];
    for (let i = 1; i <= 1000; i++) {
      rows.push(`t${i}\t${i % 10 === 0 ? 'ERROR' : 'INFO'}\tevent_${i}`);
    }
    fs.writeFileSync(tsvPath, rows.join('\n') + '\n', 'utf8');
    const stat = fs.statSync(tsvPath);

    const engine = createCsvEngine({ chunkBytes: 2048 });
    const meta = await engine.getMeta(tsvPath, stat, { limit: '10' });
    assert.equal(meta.detectedDelimiter, '\t');

    const colSearch = await engine.search(tsvPath, stat, { q: 'error', col: '1', caseSensitive: '0', limit: '20' });
    assert.equal(colSearch.ok, true);
    assert.equal(colSearch.totalMatched, 100);
    assert.equal(colSearch.matches.length, 20);
    assert.equal(colSearch.matches[0].rowNumber, 10);

    const regexSearch = await engine.search(tsvPath, stat, { q: '^event_99[0-9]$', col: '2', regex: '1' });
    assert.equal(regexSearch.ok, true);
    assert.equal(regexSearch.totalMatched, 10);

    const badRegex = await engine.search(tsvPath, stat, { q: '[unclosed', regex: '1' });
    assert.equal(badRegex.ok, false);
    assert.equal(badRegex.statusCode, 400);
    assert.equal(badRegex.errorCode, ERROR_CODES.INVALID_REGEX);

    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const aborted = await engine.search(tsvPath, stat, { q: 'INFO' }, abortCtrl.signal);
    assert.equal(aborted.ok, true);
    assert.equal(aborted.complete, false);

    engine.invalidate();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
