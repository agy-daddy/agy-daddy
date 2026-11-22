'use strict';

const fs = require('fs');
const path = require('path');
const { measure } = require('./context-analyzer');

const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/javascript', 'application/typescript', 'application/x-yaml', 'application/csv'];
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.csv', '.tsv',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.css', '.scss', '.html', '.xml', '.svg',
  '.sql', '.sh', '.zsh', '.bash', '.toml', '.ini', '.conf', '.log'
]);

function uriToLocalPath(uri) {
  if (!uri || typeof uri !== 'string') return null;
  if (uri.startsWith('inline:')) return null;
  if (uri.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return uri.slice('file://'.length);
    }
  }
  if (path.isAbsolute(uri)) return uri;
  return null;
}

function isReadableTextFile(filePath, mime) {
  const cleanMime = String(mime || '').toLowerCase();
  if (cleanMime && TEXT_MIME_PREFIXES.some((p) => cleanMime.startsWith(p))) return true;
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * 只读审计附件目录与引用体量，绝不返回原始文本内容
 */
function auditAttachments(mediaList = [], options = {}) {
  const maxFileBytes = Number(options.maxFileBytes) > 0 ? Number(options.maxFileBytes) : DEFAULT_MAX_FILE_BYTES;
  const list = Array.isArray(mediaList) ? mediaList : [];
  const items = [];
  const totals = {
    count: 0,
    userCount: 0,
    assistantCount: 0,
    measuredCount: 0,
    unknownCount: 0,
    chars: 0,
    bytes: 0,
    low: 0,
    high: 0
  };

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const source = raw.source === 'user' ? 'user' : 'assistant';
    const localPath = uriToLocalPath(raw.uri);
    totals.count++;
    if (source === 'user') totals.userCount++;
    else totals.assistantCount++;

    if (!localPath || !fs.existsSync(localPath)) {
      totals.unknownCount++;
      items.push({
        name: raw.name || 'unknown',
        mime: raw.mime || '',
        source,
        references: Number(raw.references || 1),
        status: raw.uri?.startsWith('inline:') ? 'inline_unmeasured' : 'missing',
        chars: 0,
        bytes: 0,
        low: 0,
        high: 0
      });
      continue;
    }

    let stat;
    try {
      stat = fs.statSync(localPath);
    } catch {
      totals.unknownCount++;
      items.push({
        name: raw.name || path.basename(localPath),
        mime: raw.mime || '',
        source,
        references: Number(raw.references || 1),
        status: 'unreadable',
        chars: 0,
        bytes: 0,
        low: 0,
        high: 0
      });
      continue;
    }

    if (!stat.isFile() || stat.size > maxFileBytes || !isReadableTextFile(localPath, raw.mime)) {
      totals.unknownCount++;
      totals.bytes += stat.isFile() ? stat.size : 0;
      items.push({
        name: raw.name || path.basename(localPath),
        mime: raw.mime || '',
        source,
        references: Number(raw.references || 1),
        status: stat.size > maxFileBytes ? 'oversized' : 'binary_or_unparsed',
        chars: 0,
        bytes: stat.size,
        low: 0,
        high: 0
      });
      continue;
    }

    let text = '';
    try {
      text = fs.readFileSync(localPath, 'utf8');
    } catch {
      totals.unknownCount++;
      items.push({
        name: raw.name || path.basename(localPath),
        mime: raw.mime || '',
        source,
        references: Number(raw.references || 1),
        status: 'read_error',
        chars: 0,
        bytes: stat.size,
        low: 0,
        high: 0
      });
      continue;
    }

    const est = measure(text);
    totals.measuredCount++;
    totals.chars += est.chars;
    totals.bytes += est.bytes;
    totals.low += est.low;
    totals.high += est.high;

    items.push({
      name: raw.name || path.basename(localPath),
      mime: raw.mime || '',
      source,
      references: Number(raw.references || 1),
      status: 'measured',
      chars: est.chars,
      bytes: est.bytes,
      low: est.low,
      high: est.high
    });
  }

  return { items, totals };
}

module.exports = {
  DEFAULT_MAX_FILE_BYTES,
  uriToLocalPath,
  isReadableTextFile,
  auditAttachments
};
