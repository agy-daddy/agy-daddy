'use strict';

const fs = require('node:fs');
const {
  SVG_MAX_BYTES,
  SVG_SOURCE_FULL_MAX_BYTES,
  SVG_SOURCE_TRUNCATE_BYTES,
  ERROR_CODES,
  safeErrorPayload
} = require('./constants');

const DANGEROUS_PAIR_TAGS = [
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'applet',
  'meta',
  'link',
  'base'
];

const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[a-z0-9+/=\s]+$/i;

function isSafeSvgResourceRef(rawRef) {
  const val = String(rawRef || '').trim();
  if (!val) return false;
  if (val.startsWith('#')) {
    return /^#[A-Za-z_][\w:.-]*$/.test(val);
  }
  return SAFE_DATA_IMAGE_RE.test(val);
}

function sanitizeStyleCssText(cssText) {
  let out = String(cssText || '');
  // Strip CSS @import rules and IE expression()
  out = out.replace(/@import\b[^;]*(?:;|$)/gi, '');
  out = out.replace(/expression\s*\([^)]*\)/gi, 'none');
  // Strip javascript:/vbscript:/http(s):/data:text/data:image/svg+xml inside url(...)
  out = out.replace(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (_full, _q, target) => {
    const cleaned = String(target || '').trim();
    if (isSafeSvgResourceRef(cleaned)) {
      return `url("${cleaned}")`;
    }
    return 'none';
  });
  return out;
}

function sanitizeSvgString(rawSvg) {
  let svg = String(rawSvg || '');

  // Strip BOM
  if (svg.charCodeAt(0) === 0xFEFF) {
    svg = svg.slice(1);
  }

  // Remove XML stylesheets, DOCTYPE/ENTITY declarations (prevent XXE / external DTD / stylesheet injection)
  svg = svg.replace(/<\?xml-stylesheet\b[\s\S]*?\?>/gi, '');
  svg = svg.replace(/<!DOCTYPE\b[\s\S]*?(?:\[[\s\S]*?\]\s*)?>/gi, '');
  svg = svg.replace(/<!ENTITY\b[\s\S]*?>/gi, '');

  // Remove dangerous tags and their subtrees
  for (const tag of DANGEROUS_PAIR_TAGS) {
    const pairRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
    const selfClosingRe = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
    svg = svg.replace(pairRe, '');
    svg = svg.replace(selfClosingRe, '');
  }

  // Remove all inline on* event handler attributes (quoted double, single, or unquoted)
  svg = svg.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Sanitize href / xlink:href / src / action / formaction attributes
  svg = svg.replace(
    /(\s+(?:xlink:href|href|src|action|formaction)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (_full, prefix, dq, sq, uq) => {
      const val = dq !== undefined ? dq : (sq !== undefined ? sq : (uq || ''));
      if (isSafeSvgResourceRef(val)) {
        return `${prefix}"${val.trim()}"`;
      }
      return '';
    }
  );

  // Sanitize inline style="..." attributes
  svg = svg.replace(
    /(\s+style\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
    (_full, prefix, dq, sq) => {
      const val = dq !== undefined ? dq : (sq || '');
      return `${prefix}"${sanitizeStyleCssText(val).replace(/"/g, '&quot;')}"`;
    }
  );

  // Sanitize <style>...</style> blocks
  svg = svg.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (_full, open, body, close) => {
    return `${open}${sanitizeStyleCssText(body)}${close}`;
  });

  return svg;
}

function parseNumericSvgAttr(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.endsWith('%')) return null;
  const m = trimmed.match(/^([+-]?\d+(?:\.\d+)?)(?:px)?$/i);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractSvgMetadata(svgText) {
  const tagMatch = String(svgText || '').match(/<svg\b([^>]*)>/i);
  if (!tagMatch) {
    return { viewBox: null, naturalWidth: null, naturalHeight: null };
  }
  const attrs = tagMatch[1] || '';

  const vbMatch = attrs.match(/\bviewBox\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const viewBox = vbMatch ? (vbMatch[1] ?? vbMatch[2] ?? '').trim() : null;

  const wMatch = attrs.match(/\bwidth\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  const hMatch = attrs.match(/\bheight\s*=\s*(?:"([^"]*)"|'([^']*)')/i);

  let naturalWidth = parseNumericSvgAttr(wMatch ? (wMatch[1] ?? hMatch?.[2] ?? wMatch[2]) : null);
  let naturalHeight = parseNumericSvgAttr(hMatch ? (hMatch[1] ?? hMatch[2]) : null);

  if (viewBox && (naturalWidth === null || naturalHeight === null)) {
    const parts = viewBox.split(/[\s,]+/).map((p) => Number.parseFloat(p));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      if (naturalWidth === null && parts[2] > 0) naturalWidth = parts[2];
      if (naturalHeight === null && parts[3] > 0) naturalHeight = parts[3];
    }
  }

  return {
    viewBox: viewBox || null,
    naturalWidth,
    naturalHeight
  };
}

function readSvgPayload(realPath, stat, mode = 'sanitized') {
  const fileSize = Number(stat?.size ?? 0);
  if (fileSize > SVG_MAX_BYTES) {
    return { ok: false, statusCode: 413, ...safeErrorPayload(ERROR_CODES.SVG_TOO_LARGE) };
  }

  const normalizedMode = mode === 'source' ? 'source' : 'sanitized';

  if (normalizedMode === 'source' && fileSize > SVG_SOURCE_FULL_MAX_BYTES) {
    const fd = fs.openSync(realPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(Math.min(fileSize, SVG_SOURCE_TRUNCATE_BYTES));
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const rawText = new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(0, bytesRead));
      const meta = extractSvgMetadata(rawText);
      return {
        ok: true,
        statusCode: 200,
        mode: 'source',
        fileSize,
        ...meta,
        truncated: true,
        content: rawText
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  const buf = fs.readFileSync(realPath);
  const rawText = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (normalizedMode === 'source') {
    const meta = extractSvgMetadata(rawText);
    return {
      ok: true,
      statusCode: 200,
      mode: 'source',
      fileSize,
      ...meta,
      truncated: false,
      content: rawText
    };
  }

  const sanitized = sanitizeSvgString(rawText);
  const meta = extractSvgMetadata(sanitized);
  return {
    ok: true,
    statusCode: 200,
    mode: 'sanitized',
    fileSize,
    ...meta,
    truncated: false,
    content: sanitized
  };
}

module.exports = {
  isSafeSvgResourceRef,
  sanitizeStyleCssText,
  sanitizeSvgString,
  extractSvgMetadata,
  readSvgPayload
};
