'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { expandHomePath } = require('./file-service');

const EXPORT_FORMATS = Object.freeze(['md', 'html', 'pdf']);

function isTestEnv() {
  return process.env.AGY_DADDY_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
}

function normalizeExportFormat(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'markdown') return 'md';
  if (EXPORT_FORMATS.includes(s)) return s;
  return 'md';
}

function normalizeExportFormats(raw) {
  const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    let val = '';
    if (typeof item === 'string') val = item.trim();
    else if (item && typeof item === 'object') val = String(item.id || item.value || '').trim();
    const norm = val.toLowerCase() === 'markdown' ? 'md' : val.toLowerCase();
    if (!EXPORT_FORMATS.includes(norm) || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out.length > 0 ? out : ['md'];
}

function ensureFileExtension(filePath, format = 'md') {
  const clean = String(filePath || '').trim();
  if (!clean) return '';
  const fmt = normalizeExportFormat(format);
  const ext = `.${fmt}`;
  if (clean.toLowerCase().endsWith(ext)) return clean;
  return `${clean}${ext}`;
}

function getDefaultBrainDir(options = {}) {
  if (options.brainDir) return path.resolve(options.brainDir);
  if (process.env.AGY_DADDY_BRAIN_DIR) return path.resolve(process.env.AGY_DADDY_BRAIN_DIR);
  return path.join(options.homeDir || os.homedir(), '.gemini', 'antigravity', 'brain');
}

function listBrainSessions(options = {}) {
  const dir = getDefaultBrainDir(options);
  if (!dir || !fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^[a-z0-9-]{8,}$/i.test(e.name))
    .map((e) => {
      const full = path.join(dir, e.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
      return { id: e.name, path: full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function pickLatestCascadeId(summariesObj = {}) {
  if (!summariesObj || typeof summariesObj !== 'object') return null;
  const entries = Object.entries(summariesObj);
  if (!entries.length) return null;
  entries.sort((a, b) => {
    const tA = Date.parse(a[1]?.lastModifiedTime || a[1]?.updatedAt || a[1]?.createdTime || 0) || 0;
    const tB = Date.parse(b[1]?.lastModifiedTime || b[1]?.updatedAt || b[1]?.createdTime || 0) || 0;
    return tB - tA;
  });
  return entries[0][0] || null;
}

function sanitizeFilenamePart(raw, maxLen = 48) {
  const clean = String(raw || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!clean) return '';
  return Array.from(clean).slice(0, maxLen).join('');
}

function buildExportFilename(meta = {}) {
  const d = meta.date instanceof Date ? meta.date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const slug = sanitizeFilenamePart(meta.title, 40)
    || sanitizeFilenamePart(String(meta.cascadeId || '').slice(0, 8), 16)
    || 'conversation';
  const fmt = normalizeExportFormat(meta.format || 'md');
  return `antigravity-${slug}-${stamp}.${fmt}`;
}

function normalizeDomMessagesToSteps(domMessages = []) {
  if (!Array.isArray(domMessages)) return [];
  const steps = [];
  for (const msg of domMessages) {
    if (!msg || typeof msg !== 'object') continue;
    const text = String(msg.text || '').trim();
    if (!text) continue;
    if (msg.role === 'user') {
      steps.push({ userInput: { userResponse: text } });
    } else if (msg.role === 'assistant') {
      steps.push({ plannerResponse: { response: text } });
    }
  }
  return steps;
}

function exportConversationMarkdown(steps = [], meta = {}) {
  const title = String(meta.title || meta.cascadeId || 'Antigravity Conversation').trim();
  const lines = [`# ${title}`, ''];
  if (meta.cascadeId) lines.push(`- Session ID: \`${meta.cascadeId}\``);
  if (meta.model) lines.push(`- Model: \`${meta.model}\``);
  lines.push('');

  for (let i = 0; i < (Array.isArray(steps) ? steps.length : 0); i++) {
    const s = steps[i] || {};
    if (s.userInput) {
      const text = s.userInput.userResponse || (s.userInput.items || []).map((it) => it.text || '').join('\n');
      lines.push(`## Turn ${i + 1} · User`, '', String(text || '').trim(), '');
    } else if (s.plannerResponse) {
      const thinking = String(s.plannerResponse.thinking || '').trim();
      const resp = String(s.plannerResponse.modifiedResponse || s.plannerResponse.response || '').trim();
      lines.push(`## Turn ${i + 1} · Assistant`, '');
      if (thinking) {
        lines.push('<details><summary>Thinking</summary>', '', thinking, '', '</details>', '');
      }
      if (resp) lines.push(resp, '');
    }
  }
  return lines.join('\n').trim() + '\n';
}

function escapeHtml(raw) {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeLinkHref(href) {
  const trimmed = String(href || '').trim();
  return /^(?:https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+)$/i.test(trimmed);
}

function renderInlineMarkdownToHtml(rawLine) {
  const codeTokens = [];
  const withCodePlaceholders = String(rawLine ?? '').replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CODE_${idx}\x00`;
  });

  let escaped = escapeHtml(withCodePlaceholders);
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    if (!isSafeLinkHref(url)) return label;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/(^|[^\*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  escaped = escaped.replace(/\x00CODE_(\d+)\x00/g, (_, i) => codeTokens[Number(i)] || '');
  return escaped;
}

function renderMarkdownBlockToHtml(markdownText) {
  const src = String(markdownText ?? '').replace(/\r\n/g, '\n');
  if (!src.trim()) return '';
  const lines = src.split('\n');
  const chunks = [];
  let inCodeFence = false;
  let codeLang = '';
  let codeLines = [];
  let listType = '';
  let listItems = [];

  const flushList = () => {
    if (!listItems.length) return;
    const tag = listType === 'ol' ? 'ol' : 'ul';
    chunks.push(`<${tag}>${listItems.map((it) => `<li>${it}</li>`).join('')}</${tag}>`);
    listItems = [];
    listType = '';
  };

  for (const line of lines) {
    const fenceMatch = line.match(/^```([a-zA-Z0-9_-]*)\s*$/);
    if (fenceMatch) {
      flushList();
      if (!inCodeFence) {
        inCodeFence = true;
        codeLang = fenceMatch[1] || '';
        codeLines = [];
      } else {
        const langAttr = codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : '';
        chunks.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        inCodeFence = false;
        codeLang = '';
        codeLines = [];
      }
      continue;
    }

    if (inCodeFence) {
      codeLines.push(line);
      continue;
    }

    const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (ulMatch) {
      if (listType && listType !== 'ul') flushList();
      listType = 'ul';
      listItems.push(renderInlineMarkdownToHtml(ulMatch[1]));
      continue;
    }
    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      if (listType && listType !== 'ol') flushList();
      listType = 'ol';
      listItems.push(renderInlineMarkdownToHtml(olMatch[1]));
      continue;
    }
    flushList();

    if (!line.trim()) continue;
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = Math.min(6, headingMatch[1].length);
      chunks.push(`<h${level}>${renderInlineMarkdownToHtml(headingMatch[2])}</h${level}>`);
      continue;
    }
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      chunks.push(`<blockquote>${renderInlineMarkdownToHtml(quoteMatch[1])}</blockquote>`);
      continue;
    }
    chunks.push(`<p>${renderInlineMarkdownToHtml(line)}</p>`);
  }

  if (inCodeFence) {
    const langAttr = codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : '';
    chunks.push(`<pre><code${langAttr}>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }
  flushList();
  return chunks.join('\n');
}

function exportConversationHtml(steps = [], meta = {}) {
  const title = String(meta.title || meta.cascadeId || 'Antigravity Conversation').trim();
  const expandThinking = Boolean(meta.expandThinking);
  const metaPills = [];
  if (meta.cascadeId) metaPills.push(`<span class="meta-pill">Session ID: <code>${escapeHtml(meta.cascadeId)}</code></span>`);
  if (meta.model) metaPills.push(`<span class="meta-pill">Model: <code>${escapeHtml(meta.model)}</code></span>`);
  const exportedAt = (meta.date instanceof Date ? meta.date : new Date()).toISOString();
  metaPills.push(`<span class="meta-pill">Exported: <code>${escapeHtml(exportedAt)}</code></span>`);

  const turnHtml = [];
  for (let i = 0; i < (Array.isArray(steps) ? steps.length : 0); i++) {
    const s = steps[i] || {};
    if (s.userInput) {
      const text = s.userInput.userResponse || (s.userInput.items || []).map((it) => it.text || '').join('\n');
      turnHtml.push(
        `<section class="turn turn-user">` +
        `<header class="turn-head"><span class="role-badge role-user">Turn ${i + 1} · User</span></header>` +
        `<div class="turn-body">${renderMarkdownBlockToHtml(String(text || '').trim())}</div>` +
        `</section>`
      );
    } else if (s.plannerResponse) {
      const thinking = String(s.plannerResponse.thinking || '').trim();
      const resp = String(s.plannerResponse.modifiedResponse || s.plannerResponse.response || '').trim();
      const detailsAttrs = expandThinking ? 'class="thinking-box" open' : 'class="thinking-box"';
      const thinkingBlock = thinking
        ? `<details ${detailsAttrs}><summary>Thinking</summary><div class="thinking-body">${renderMarkdownBlockToHtml(thinking)}</div></details>`
        : '';
      turnHtml.push(
        `<section class="turn turn-assistant">` +
        `<header class="turn-head"><span class="role-badge role-assistant">Turn ${i + 1} · Assistant</span></header>` +
        `${thinkingBlock}` +
        `<div class="turn-body">${renderMarkdownBlockToHtml(resp)}</div>` +
        `</section>`
      );
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #ffffff;
      --surface: #f8fafc;
      --border: #e4e4e7;
      --text: #18181b;
      --muted: #71717a;
      --code-bg: #f4f4f5;
      --accent: #3f3f46;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px 20px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 14px;
      line-height: 1.65;
    }
    main { max-width: 860px; margin: 0 auto; }
    .doc-header { padding-bottom: 18px; margin-bottom: 24px; border-bottom: 1px solid var(--border); }
    .doc-title { margin: 0 0 10px 0; font-size: 22px; font-weight: 700; color: var(--text); }
    .doc-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--muted); }
    .meta-pill { padding: 3px 9px; border-radius: 999px; background: var(--code-bg); border: 1px solid var(--border); }
    .turn {
      margin-bottom: 18px;
      padding: 16px 18px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--bg);
      break-inside: avoid;
    }
    .turn-user { background: var(--surface); }
    .turn-head { margin-bottom: 10px; }
    .role-badge {
      display: inline-block;
      padding: 2px 9px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 600;
      background: var(--code-bg);
      color: var(--accent);
      border: 1px solid var(--border);
    }
    .role-user { background: #18181b; color: #ffffff; border-color: #18181b; }
    .turn-body p { margin: 0 0 10px 0; }
    .turn-body p:last-child { margin-bottom: 0; }
    .turn-body h1, .turn-body h2, .turn-body h3, .turn-body h4 { margin: 14px 0 8px 0; line-height: 1.35; }
    .turn-body ul, .turn-body ol { margin: 6px 0 10px 0; padding-left: 22px; }
    .turn-body blockquote {
      margin: 8px 0;
      padding: 6px 12px;
      border-left: 3px solid var(--border);
      color: var(--muted);
      background: var(--surface);
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12.5px;
      padding: 1px 5px;
      border-radius: 5px;
      background: var(--code-bg);
    }
    pre {
      margin: 10px 0;
      padding: 12px 14px;
      border-radius: 8px;
      background: var(--code-bg);
      border: 1px solid var(--border);
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    pre code { padding: 0; background: transparent; }
    .thinking-box {
      margin: 8px 0 12px 0;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px dashed var(--border);
      background: var(--surface);
    }
    .thinking-box summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--muted); }
    .thinking-body { margin-top: 8px; font-size: 13px; color: var(--muted); }
    a { color: #27272a; text-decoration: underline; }
    @media print {
      body { padding: 0; }
      .turn { border-color: #d4d4d8; break-inside: auto; }
      .thinking-box { break-inside: auto; }
      pre { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <main>
    <header class="doc-header">
      <h1 class="doc-title">${escapeHtml(title)}</h1>
      <div class="doc-meta">${metaPills.join('')}</div>
    </header>
    ${turnHtml.join('\n    ') || '<p style="color:#71717a;">(Empty conversation)</p>'}
  </main>
</body>
</html>
`;
}

function escapePdfLiteral(str) {
  return String(str ?? '')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildMinimalPdfBuffer(text = '', meta = {}) {
  const titleLine = String(meta.title || meta.cascadeId || 'Antigravity Conversation').trim();
  const rawText = String(text || '').replace(/\r\n/g, '\n');
  const rawLines = rawText ? rawText.split('\n') : [titleLine];
  const wrapped = [];
  for (const line of rawLines) {
    if (!line) {
      wrapped.push('');
      continue;
    }
    for (let i = 0; i < line.length; i += 88) {
      wrapped.push(line.slice(i, i + 88));
    }
  }
  const linesPerPage = 46;
  const pages = [];
  for (let i = 0; i < wrapped.length; i += linesPerPage) {
    pages.push(wrapped.slice(i, i + linesPerPage));
  }
  if (pages.length === 0) pages.push([titleLine]);

  const objects = [];
  const addObj = (body) => {
    objects.push(body);
    return objects.length;
  };

  const catalogId = addObj('');
  const pagesId = addObj('');
  const fontId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];

  for (const pageLines of pages) {
    const streamCmds = ['BT', '/F1 10 Tf', '48 760 Td', '14 TL'];
    for (let i = 0; i < pageLines.length; i++) {
      const lit = escapePdfLiteral(pageLines[i]);
      if (i === 0) streamCmds.push(`(${lit}) Tj`);
      else streamCmds.push(`T* (${lit}) Tj`);
    }
    streamCmds.push('ET');
    const streamStr = streamCmds.join('\n');
    const contentId = addObj(`<< /Length ${Buffer.byteLength(streamStr, 'utf8')} >>\nstream\n${streamStr}\nendstream`);
    const pageId = addObj(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];
  let byteLen = Buffer.byteLength(chunks[0], 'utf8');
  for (let i = 0; i < objects.length; i++) {
    offsets.push(byteLen);
    const entry = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    chunks.push(entry);
    byteLen += Buffer.byteLength(entry, 'utf8');
  }
  const xrefPos = byteLen;
  const xrefLines = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`];
  for (let i = 1; i < offsets.length; i++) {
    xrefLines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  }
  xrefLines.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);
  chunks.push(xrefLines.join(''));
  return Buffer.from(chunks.join(''), 'utf8');
}

function runExecFile(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 60000, env: opts.env || process.env }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err?.code ?? 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err?.message || ''
      });
    });
  });
}

function findHeadlessChromeBinary(customBin = '') {
  const candidates = [
    customBin,
    process.env.AGY_DADDY_PDF_CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Arc.app/Contents/MacOS/Arc',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return '';
}

async function renderHtmlToPdfBuffer(html, opts = {}) {
  if (typeof opts.pdfRenderer === 'function') {
    const customBuf = await opts.pdfRenderer(html, opts);
    return Buffer.isBuffer(customBuf) ? customBuf : Buffer.from(customBuf || '');
  }

  if (!isTestEnv() && opts.allowSystemPdf !== false) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cnav-pdf-'));
    const tmpHtml = path.join(tmpDir, 'export.html');
    const tmpPdf = path.join(tmpDir, 'export.pdf');
    try {
      fs.writeFileSync(tmpHtml, String(html || ''), 'utf8');
      const chromeBin = findHeadlessChromeBinary(opts.chromeBin);
      if (chromeBin) {
        const res = await runExecFile(chromeBin, [
          '--headless',
          '--disable-gpu',
          '--no-sandbox',
          '--no-pdf-header-footer',
          `--print-to-pdf=${tmpPdf}`,
          pathToFileURL(tmpHtml).href
        ], { timeout: 45000 });
        if (res.ok && fs.existsSync(tmpPdf)) {
          const buf = fs.readFileSync(tmpPdf);
          if (buf.length > 0 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
            return buf;
          }
        }
      }

      if (process.platform === 'darwin' && fs.existsSync('/usr/sbin/cupsfilter')) {
        const res = await runExecFile('/usr/sbin/cupsfilter', ['-m', 'application/pdf', tmpHtml], { timeout: 30000 });
        if (res.ok && res.stdout && res.stdout.startsWith('%PDF-')) {
          return Buffer.from(res.stdout, 'binary');
        }
      }
    } catch {} finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  }

  return buildMinimalPdfBuffer(opts.plainText || '', opts.meta || {});
}

function isUserCancelledOsascript(res) {
  const detail = `${res?.stderr || ''} ${res?.error || ''}`;
  return /\(-128\)|\bUser canceled\b/i.test(detail);
}

async function openSaveFileDialog(opts = {}) {
  const format = normalizeExportFormat(opts.format || 'md');
  const defaultName = String(opts.defaultName || buildExportFilename({ format })).trim();
  const defaultDir = expandHomePath(opts.defaultDir || '') || path.join(os.homedir(), 'Downloads');
  const promptText = String(opts.title || '导出对话记录').trim();

  if (typeof opts.saveDialogFn === 'function') {
    const res = await opts.saveDialogFn({ defaultDir, defaultName, format, title: promptText });
    if (res && res.ok === false) {
      return { ok: false, cancelled: false, path: '', error: String(res.error || '无法打开保存对话框') };
    }
    if (!res || res.cancelled || !res.path) {
      return { ok: true, cancelled: true, path: '' };
    }
    return { ok: true, cancelled: false, path: ensureFileExtension(expandHomePath(res.path), format) };
  }

  if (isTestEnv()) {
    const testResult = String(process.env.AGY_DADDY_TEST_SAVE_DIALOG_RESULT || '').trim();
    if (!testResult || testResult === '__CANCEL__') {
      return { ok: true, cancelled: true, path: '' };
    }
    return { ok: true, cancelled: false, path: ensureFileExtension(expandHomePath(testResult), format) };
  }

  const platform = opts.platform || process.platform;
  if (platform === 'darwin') {
    const hasDir = defaultDir && fs.existsSync(defaultDir);
    const script = hasDir
      ? [
          'on run argv',
          '  set pTitle to item 1 of argv',
          '  set pName to item 2 of argv',
          '  set pDir to item 3 of argv',
          '  tell current application to activate',
          '  return POSIX path of (choose file name with prompt pTitle default name pName default location ((POSIX file pDir) as alias))',
          'end run'
        ].join('\n')
      : [
          'on run argv',
          '  set pTitle to item 1 of argv',
          '  set pName to item 2 of argv',
          '  tell current application to activate',
          '  return POSIX path of (choose file name with prompt pTitle default name pName)',
          'end run'
        ].join('\n');
    const args = ['-e', script, '--', promptText, defaultName];
    if (hasDir) args.push(defaultDir);
    const res = await runExecFile('osascript', args, { timeout: 120000 });
    if (!res.ok) {
      if (isUserCancelledOsascript(res)) {
        return { ok: true, cancelled: true, path: '' };
      }
      return { ok: false, cancelled: false, path: '', error: (res.stderr || res.error || '无法打开保存对话框').trim() };
    }
    const picked = res.stdout.trim();
    return picked
      ? { ok: true, cancelled: false, path: ensureFileExtension(picked, format) }
      : { ok: true, cancelled: true, path: '' };
  }

  if (platform === 'win32') {
    const filterMap = {
      md: 'Markdown (*.md)|*.md|All files (*.*)|*.*',
      html: 'HTML (*.html)|*.html|All files (*.*)|*.*',
      pdf: 'PDF (*.pdf)|*.pdf|All files (*.*)|*.*'
    };
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$f = New-Object System.Windows.Forms.SaveFileDialog',
      '$f.Title = $env:AGY_DLG_TITLE',
      '$f.FileName = $env:AGY_DLG_NAME',
      'if ($env:AGY_DLG_DIR -and (Test-Path $env:AGY_DLG_DIR)) { $f.InitialDirectory = $env:AGY_DLG_DIR }',
      '$f.Filter = $env:AGY_DLG_FILTER',
      'if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }'
    ].join('; ');
    const res = await runExecFile('powershell.exe', ['-NoProfile', '-Command', psScript], {
      timeout: 120000,
      env: {
        ...process.env,
        AGY_DLG_TITLE: promptText,
        AGY_DLG_NAME: defaultName,
        AGY_DLG_DIR: defaultDir,
        AGY_DLG_FILTER: filterMap[format] || filterMap.md
      }
    });
    const picked = res.ok ? res.stdout.trim() : '';
    return picked
      ? { ok: true, cancelled: false, path: ensureFileExtension(picked, format) }
      : { ok: true, cancelled: true, path: '' };
  }

  const initialFile = path.join(defaultDir, defaultName);
  const zen = await runExecFile('zenity', ['--file-selection', '--save', '--confirm-overwrite', `--title=${promptText}`, `--filename=${initialFile}`], { timeout: 120000 });
  if (zen.ok && zen.stdout.trim()) {
    return { ok: true, cancelled: false, path: ensureFileExtension(zen.stdout.trim(), format) };
  }
  const kd = await runExecFile('kdialog', ['--getsavefilename', initialFile, `*.${format}`], { timeout: 120000 });
  if (kd.ok && kd.stdout.trim()) {
    return { ok: true, cancelled: false, path: ensureFileExtension(kd.stdout.trim(), format) };
  }
  return { ok: true, cancelled: true, path: '' };
}

async function openDirectoryDialog(opts = {}) {
  const defaultDir = expandHomePath(opts.defaultDir || '') || path.join(os.homedir(), 'Downloads');
  const promptText = String(opts.title || '选择默认导出保存文件夹').trim();

  if (typeof opts.dirPickerFn === 'function') {
    const res = await opts.dirPickerFn({ defaultDir, title: promptText });
    if (res && res.ok === false) {
      return { ok: false, cancelled: false, path: '', error: String(res.error || '无法打开文件夹选择对话框') };
    }
    if (!res || res.cancelled || !res.path) {
      return { ok: true, cancelled: true, path: '' };
    }
    return { ok: true, cancelled: false, path: expandHomePath(res.path) };
  }

  if (isTestEnv()) {
    const testResult = String(process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT || '').trim();
    if (!testResult || testResult === '__CANCEL__') {
      return { ok: true, cancelled: true, path: '' };
    }
    return { ok: true, cancelled: false, path: expandHomePath(testResult) };
  }

  const platform = opts.platform || process.platform;
  if (platform === 'darwin') {
    const hasDir = defaultDir && fs.existsSync(defaultDir);
    const script = hasDir
      ? [
          'on run argv',
          '  set pTitle to item 1 of argv',
          '  set pDir to item 2 of argv',
          '  tell current application to activate',
          '  return POSIX path of (choose folder with prompt pTitle default location ((POSIX file pDir) as alias))',
          'end run'
        ].join('\n')
      : [
          'on run argv',
          '  set pTitle to item 1 of argv',
          '  tell current application to activate',
          '  return POSIX path of (choose folder with prompt pTitle)',
          'end run'
        ].join('\n');
    const args = ['-e', script, '--', promptText];
    if (hasDir) args.push(defaultDir);
    const res = await runExecFile('osascript', args, { timeout: 120000 });
    if (!res.ok) {
      if (isUserCancelledOsascript(res)) {
        return { ok: true, cancelled: true, path: '' };
      }
      return { ok: false, cancelled: false, path: '', error: (res.stderr || res.error || '无法打开文件夹选择对话框').trim() };
    }
    const picked = res.stdout.trim().replace(/\/+$/, '');
    return picked
      ? { ok: true, cancelled: false, path: picked }
      : { ok: true, cancelled: true, path: '' };
  }

  if (platform === 'win32') {
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = $env:AGY_DLG_TITLE',
      'if ($env:AGY_DLG_DIR -and (Test-Path $env:AGY_DLG_DIR)) { $d.SelectedPath = $env:AGY_DLG_DIR }',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }'
    ].join('; ');
    const res = await runExecFile('powershell.exe', ['-NoProfile', '-Command', psScript], {
      timeout: 120000,
      env: { ...process.env, AGY_DLG_TITLE: promptText, AGY_DLG_DIR: defaultDir }
    });
    const picked = res.ok ? res.stdout.trim() : '';
    return picked ? { ok: true, cancelled: false, path: picked } : { ok: true, cancelled: true, path: '' };
  }

  const zen = await runExecFile('zenity', ['--file-selection', '--directory', `--title=${promptText}`, `--filename=${defaultDir}/`], { timeout: 120000 });
  if (zen.ok && zen.stdout.trim()) {
    return { ok: true, cancelled: false, path: zen.stdout.trim().replace(/\/+$/, '') };
  }
  const kd = await runExecFile('kdialog', ['--getexistingdirectory', defaultDir], { timeout: 120000 });
  if (kd.ok && kd.stdout.trim()) {
    return { ok: true, cancelled: false, path: kd.stdout.trim().replace(/\/+$/, '') };
  }
  return { ok: true, cancelled: true, path: '' };
}

module.exports = {
  EXPORT_FORMATS,
  normalizeExportFormat,
  normalizeExportFormats,
  ensureFileExtension,
  getDefaultBrainDir,
  listBrainSessions,
  pickLatestCascadeId,
  sanitizeFilenamePart,
  buildExportFilename,
  normalizeDomMessagesToSteps,
  exportConversationMarkdown,
  exportConversationHtml,
  buildMinimalPdfBuffer,
  renderHtmlToPdfBuffer,
  openSaveFileDialog,
  openDirectoryDialog
};
