import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type {
  AskQuestionPayload,
  CheckpointPayload,
  CodeActionPayload,
  CommandEventPayload,
  ErrorMessagePayload,
  FileViewPayload,
  GenericToolPayload,
  PlannerResponsePayload,
  SessionEvent,
  SystemMessagePayload,
  UserEventPayload,
  WebSearchPayload,
} from '../types';
import { serializeEventsToMarkdown } from './composerUtils';
import { evaluateEventVisibility } from './messageVisibility';
import { isIntermediateThinkingEvent } from './timelineGrouping';
import styles from './ChatNavDock.module.css';

export { serializeEventsToMarkdown };

export interface ExportHtmlOptions {
  sessionId?: string | null;
  modelName?: string | null;
  expandThinking?: boolean;
  date?: Date;
}

export interface ChatSearchState {
  open: boolean;
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  matchSeqs: number[];
  activeMatchIndex: number;
  activeMatchSeq: number | null;
  invalidRegex: boolean;
}

export interface ChatNavDockProps {
  events: SessionEvent[];
  sessionId?: string | null;
  sessionTitle?: string;
  modelName?: string | null;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  thinkingExpandOverride?: boolean | null;
  onThinkingExpandChange?: (next: boolean | null) => void;
  searchQuery?: string;
  searchRegex?: boolean;
  searchCaseSensitive?: boolean;
  onSearchStateChange?: (state: ChatSearchState) => void;
  onScrollTop?: () => void;
  onScrollBottom?: () => void;
  onJumpToEventSeq?: (seq: number) => void;
  onExportMarkdown?: () => void | Promise<void>;
  onExportHtml?: () => void | Promise<void>;
  onPrintPdf?: () => void;
  exporting?: boolean;
}

function escapeHtml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeLinkHref(href: string): boolean {
  const trimmed = String(href || '').trim();
  return /^(?:https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+)$/i.test(trimmed);
}

function renderInlineMarkdownToHtml(rawLine: string): string {
  const codeTokens: string[] = [];
  const withPlaceholders = String(rawLine ?? '').replace(/`([^`\n]+)`/g, (_, code: string) => {
    const idx = codeTokens.length;
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00CODE_${idx}\x00`;
  });

  let escaped = escapeHtml(withPlaceholders);
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
    if (!isSafeLinkHref(url)) return label;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  escaped = escaped.replace(/\x00CODE_(\d+)\x00/g, (_, i: string) => codeTokens[Number(i)] || '');
  return escaped;
}

function renderMarkdownBlockToHtml(markdownText: string): string {
  const src = String(markdownText ?? '').replace(/\r\n/g, '\n');
  if (!src.trim()) return '';
  const lines = src.split('\n');
  const chunks: string[] = [];
  let inCodeFence = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let listType: '' | 'ul' | 'ol' = '';
  let listItems: string[] = [];

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

function extractUserMessageText(payload: UserEventPayload): string {
  if (typeof payload.userResponse === 'string' && payload.userResponse) {
    return payload.userResponse;
  }
  if (typeof payload.text === 'string' && payload.text) {
    return payload.text;
  }
  if (Array.isArray(payload.items)) {
    return payload.items
      .map((it) => (typeof it === 'string' ? it : it?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function extractPlannerResponseText(payload: PlannerResponsePayload): string {
  return (
    (typeof payload.modifiedResponse === 'string' && payload.modifiedResponse) ||
    (typeof payload.response === 'string' && payload.response) ||
    (typeof payload.text === 'string' && payload.text) ||
    ''
  );
}

export function serializeEventsToHtml(
  title: string,
  events: SessionEvent[],
  options: ExportHtmlOptions = {},
): string {
  const safeTitle = String(title || options.sessionId || 'Antigravity Conversation').trim();
  const expandThinking = Boolean(options.expandThinking);
  const metaPills: string[] = [];
  if (options.sessionId) {
    metaPills.push(`<span class="meta-pill">Session ID: <code>${escapeHtml(options.sessionId)}</code></span>`);
  }
  if (options.modelName) {
    metaPills.push(`<span class="meta-pill">Model: <code>${escapeHtml(options.modelName)}</code></span>`);
  }
  const exportedAt = (options.date instanceof Date ? options.date : new Date()).toISOString();
  metaPills.push(`<span class="meta-pill">Exported: <code>${escapeHtml(exportedAt)}</code></span>`);

  const turnHtml: string[] = [];
  for (const ev of events || []) {
    const payload = ev.payload || {};
    if (ev.kind === 'user') {
      const text = extractUserMessageText(payload as UserEventPayload).trim();
      turnHtml.push(
        `<section class="turn turn-user">` +
          `<header class="turn-head"><span class="role-badge role-user">#${ev.seq} · User</span></header>` +
          `<div class="turn-body">${renderMarkdownBlockToHtml(text)}</div>` +
          `</section>`,
      );
    } else if (ev.kind === 'thinking_and_text') {
      const p = payload as PlannerResponsePayload;
      const thinking = String(p.thinking || '').trim();
      const resp = extractPlannerResponseText(p).trim();
      const detailsAttrs = expandThinking ? 'class="thinking-box" open' : 'class="thinking-box"';
      const thinkingBlock = thinking
        ? `<details ${detailsAttrs}><summary>Thinking</summary><div class="thinking-body">${renderMarkdownBlockToHtml(thinking)}</div></details>`
        : '';
      turnHtml.push(
        `<section class="turn turn-assistant">` +
          `<header class="turn-head"><span class="role-badge role-assistant">#${ev.seq} · Assistant</span></header>` +
          `${thinkingBlock}` +
          `<div class="turn-body">${renderMarkdownBlockToHtml(resp)}</div>` +
          `</section>`,
      );
    } else if (ev.kind === 'command') {
      const p = payload as CommandEventPayload;
      const cmd = p.commandLine || p.proposedCommandLine || ev.title || '';
      const out = typeof p.combinedOutput === 'string' ? p.combinedOutput.slice(0, 4000) : '';
      turnHtml.push(
        `<section class="turn">` +
          `<header class="turn-head"><span class="role-badge">#${ev.seq} · Command</span></header>` +
          `<div class="turn-body">${cmd ? `<pre><code>$ ${escapeHtml(cmd)}</code></pre>` : ''}${out ? `<pre><code>${escapeHtml(out)}</code></pre>` : ''}</div>` +
          `</section>`,
      );
    } else {
      const jsonStr = (() => {
        try {
          return JSON.stringify(payload, null, 2).slice(0, 4000);
        } catch {
          return String(payload);
        }
      })();
      turnHtml.push(
        `<section class="turn">` +
          `<header class="turn-head"><span class="role-badge">#${ev.seq} · ${escapeHtml(ev.kind)}</span></header>` +
          `<div class="turn-body"><pre><code>${escapeHtml(jsonStr)}</code></pre></div>` +
          `</section>`,
      );
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(safeTitle)}</title>
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
      <h1 class="doc-title">${escapeHtml(safeTitle)}</h1>
      <div class="doc-meta">${metaPills.join('')}</div>
    </header>
    ${turnHtml.join('\n    ') || '<p style="color:#71717a;">(Empty conversation)</p>'}
  </main>
</body>
</html>
`;
}

export function extractEventSearchableText(event: SessionEvent): string {
  const parts: string[] = [];
  if (event.title) parts.push(event.title);
  const payload = event.payload || {};

  switch (event.kind) {
    case 'user': {
      const p = payload as UserEventPayload;
      const text = extractUserMessageText(p);
      if (text) parts.push(text);
      break;
    }
    case 'thinking_and_text': {
      const p = payload as PlannerResponsePayload;
      if (typeof p.thinking === 'string' && p.thinking) parts.push(p.thinking);
      const resp = extractPlannerResponseText(p);
      if (resp) parts.push(resp);
      break;
    }
    case 'command': {
      const p = payload as CommandEventPayload;
      if (p.commandLine) parts.push(p.commandLine);
      if (p.proposedCommandLine) parts.push(p.proposedCommandLine);
      if (p.cwd) parts.push(p.cwd);
      if (typeof p.combinedOutput === 'string' && p.combinedOutput) parts.push(p.combinedOutput);
      break;
    }
    case 'file_view': {
      const p = payload as FileViewPayload;
      if (p.absolutePathUri) parts.push(p.absolutePathUri);
      if (typeof p.content === 'string' && p.content) parts.push(p.content);
      break;
    }
    case 'code_action': {
      const p = payload as CodeActionPayload;
      if (p.actionSpec?.description) parts.push(p.actionSpec.description);
      if (p.actionSpec?.targetFile) parts.push(p.actionSpec.targetFile);
      if (p.actionSpec) parts.push(JSON.stringify(p.actionSpec));
      if (p.actionResult) parts.push(JSON.stringify(p.actionResult));
      break;
    }
    case 'ask_question': {
      const p = payload as AskQuestionPayload;
      if (Array.isArray(p.questions)) parts.push(JSON.stringify(p.questions));
      if (Array.isArray(p.completedInteractions)) parts.push(JSON.stringify(p.completedInteractions));
      break;
    }
    case 'web_search': {
      const p = payload as WebSearchPayload;
      if (p.query) parts.push(p.query);
      if (p.summary) parts.push(p.summary);
      if (Array.isArray(p.webDocuments)) parts.push(JSON.stringify(p.webDocuments));
      break;
    }
    case 'checkpoint': {
      const p = payload as CheckpointPayload;
      if (p.sessionSummary) parts.push(p.sessionSummary);
      if (Array.isArray(p.capturedUserRequests)) parts.push(JSON.stringify(p.capturedUserRequests));
      break;
    }
    case 'system': {
      const p = payload as SystemMessagePayload;
      if (p.eventType) parts.push(p.eventType);
      if (p.message) parts.push(p.message);
      if (p.renderInfo !== null && p.renderInfo !== undefined) parts.push(JSON.stringify(p.renderInfo));
      break;
    }
    case 'tool_generic': {
      const p = payload as GenericToolPayload;
      if (p.args !== null && p.args !== undefined) parts.push(JSON.stringify(p.args));
      if (p.result !== null && p.result !== undefined) parts.push(JSON.stringify(p.result));
      break;
    }
    case 'error': {
      const p = payload as ErrorMessagePayload;
      parts.push(JSON.stringify(p.error ?? p));
      break;
    }
    default: {
      parts.push(JSON.stringify(payload));
      break;
    }
  }

  return parts.join('\n');
}

export function findMatchingEventSeqs(
  events: SessionEvent[],
  query: string,
  opts: { regex?: boolean; caseSensitive?: boolean; includeHidden?: boolean } = {},
): { matchSeqs: number[]; invalidRegex: boolean } {
  const q = String(query || '').trim();
  if (!q) return { matchSeqs: [], invalidRegex: false };

  let matcher: ((txt: string) => boolean) | null = null;
  if (opts.regex) {
    try {
      const re = new RegExp(q, opts.caseSensitive ? '' : 'i');
      matcher = (txt) => re.test(txt);
    } catch {
      return { matchSeqs: [], invalidRegex: true };
    }
  } else {
    const needle = opts.caseSensitive ? q : q.toLowerCase();
    matcher = (txt) => (opts.caseSensitive ? txt.includes(needle) : txt.toLowerCase().includes(needle));
  }

  const matchSeqs: number[] = [];
  for (const ev of events) {
    if (!opts.includeHidden && evaluateEventVisibility(ev).visibility !== 'visible') continue;
    const text = extractEventSearchableText(ev);
    if (matcher(text)) {
      matchSeqs.push(ev.seq);
    }
  }
  return { matchSeqs, invalidRegex: false };
}

export function extractTurnSeqs(events: SessionEvent[]): number[] {
  const visible = events.filter((ev) => evaluateEventVisibility(ev).visibility === 'visible');
  const userSeqs = visible.filter((ev) => ev.kind === 'user').map((ev) => ev.seq);
  if (userSeqs.length > 0) return userSeqs;
  return visible
    .filter((ev) => ev.kind === 'thinking_and_text' && !isIntermediateThinkingEvent(ev))
    .map((ev) => ev.seq);
}

function buildDownloadFilename(title: string | undefined, sessionId: string | null | undefined, ext: string): string {
  const baseRaw = String(title || sessionId || 'conversation')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const slug = baseRaw || 'conversation';
  return `antigravity-${slug}.${ext}`;
}

function triggerBlobDownload(filename: string, content: string, mimeType: string): void {
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return;
  }
  const blob = new Blob([content], { type: mimeType });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(href);
  }
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback to execCommand below
    }
  }
  if (typeof document !== 'undefined' && typeof document.execCommand === 'function' && document.body) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = Boolean(document.execCommand('copy'));
      ta.remove();
      if (ok) return true;
    } catch {
      return false;
    }
  }
  return false;
}

function scrollContainerTo(el: HTMLElement | null, top: number): void {
  if (!el) return;
  const target = Math.max(0, top);
  if (typeof el.scrollTo === 'function') {
    try {
      el.scrollTo({ top: target, behavior: 'smooth' });
      return;
    } catch {
      // Fallback for non-standard scrollTo
    }
  }
  el.scrollTop = target;
}

export function ChatNavDock({
  events,
  sessionId,
  sessionTitle,
  modelName,
  scrollContainerRef,
  thinkingExpandOverride,
  onThinkingExpandChange,
  searchQuery: controlledSearchQuery,
  searchRegex: controlledSearchRegex,
  searchCaseSensitive: controlledSearchCaseSensitive,
  onSearchStateChange,
  onScrollTop,
  onScrollBottom,
  onJumpToEventSeq,
  onExportMarkdown,
  onExportHtml,
  onPrintPdf,
  exporting = false,
}: ChatNavDockProps) {
  const { t } = useI18n();

  const turnSeqs = useMemo(() => extractTurnSeqs(events), [events]);
  const [activeTurnIdx, setActiveTurnIdx] = useState<number>(() =>
    turnSeqs.length > 0 ? turnSeqs.length - 1 : -1,
  );
  const programmaticScrollUntilRef = useRef<number>(0);

  const [internalThinkingOverride, setInternalThinkingOverride] = useState<boolean | null>(null);
  const resolvedThinkingOverride =
    thinkingExpandOverride !== undefined ? thinkingExpandOverride : internalThinkingOverride;
  const thinkingExpanded = resolvedThinkingOverride === true;

  const [searchOpen, setSearchOpen] = useState(false);
  const [internalQuery, setInternalQuery] = useState('');
  const [internalRegex, setInternalRegex] = useState(false);
  const [internalCase, setInternalCase] = useState(false);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);

  const query = controlledSearchQuery !== undefined ? controlledSearchQuery : internalQuery;
  const regex = controlledSearchRegex !== undefined ? controlledSearchRegex : internalRegex;
  const caseSensitive =
    controlledSearchCaseSensitive !== undefined ? controlledSearchCaseSensitive : internalCase;

  const [copiedId, setCopiedId] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string>('');

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const exportWrapRef = useRef<HTMLDivElement | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMsg(msg);
    if (msg) {
      toastTimerRef.current = setTimeout(() => {
        toastTimerRef.current = null;
        setToastMsg('');
      }, 2200);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (turnSeqs.length === 0) {
      setActiveTurnIdx(-1);
    } else {
      setActiveTurnIdx((prev) => {
        if (prev < 0) return turnSeqs.length - 1;
        if (prev >= turnSeqs.length) return turnSeqs.length - 1;
        return prev;
      });
    }
  }, [turnSeqs.length]);

  useEffect(() => {
    setActiveTurnIdx(turnSeqs.length > 0 ? turnSeqs.length - 1 : -1);
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = scrollContainerRef?.current;
    if (!el || turnSeqs.length === 0) return;

    const handleScroll = () => {
      if (Date.now() < programmaticScrollUntilRef.current) return;
      const containerRect = el.getBoundingClientRect();
      if (!containerRect || containerRect.height <= 0) return;
      const thresholdY = containerRect.top + 48;
      let bestIdx = 0;
      for (let i = 0; i < turnSeqs.length; i++) {
        const node = el.querySelector(`[data-testid="session-event-${turnSeqs[i]}"]`);
        if (!node) continue;
        const rect = node.getBoundingClientRect();
        if (rect.top <= thresholdY) {
          bestIdx = i;
        } else {
          break;
        }
      }
      setActiveTurnIdx(bestIdx);
    };

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [scrollContainerRef, turnSeqs]);

  const scrollToEventSeq = useCallback(
    (seq: number) => {
      programmaticScrollUntilRef.current = Date.now() + 450;
      onJumpToEventSeq?.(seq);
      const container = scrollContainerRef?.current;
      const target =
        container?.querySelector<HTMLElement>(`[data-testid="session-event-${seq}"]`) ||
        (typeof document !== 'undefined'
          ? document.querySelector<HTMLElement>(`[data-testid="session-event-${seq}"]`)
          : null);
      if (target && typeof target.scrollIntoView === 'function') {
        try {
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return;
        } catch {
          target.scrollIntoView();
          return;
        }
      }
      if (container) {
        const idx = turnSeqs.indexOf(seq);
        if (idx >= 0) {
          const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
          const ratio = turnSeqs.length > 1 ? idx / (turnSeqs.length - 1) : 0;
          scrollContainerTo(container, Math.round(maxScroll * ratio));
        }
      }
    },
    [onJumpToEventSeq, scrollContainerRef, turnSeqs],
  );

  const handleScrollTop = () => {
    programmaticScrollUntilRef.current = Date.now() + 450;
    onScrollTop?.();
    scrollContainerTo(scrollContainerRef?.current ?? null, 0);
    if (turnSeqs.length > 0) setActiveTurnIdx(0);
  };

  const handleScrollBottom = () => {
    programmaticScrollUntilRef.current = Date.now() + 450;
    onScrollBottom?.();
    const container = scrollContainerRef?.current;
    if (container) {
      scrollContainerTo(container, container.scrollHeight);
    }
    if (turnSeqs.length > 0) setActiveTurnIdx(turnSeqs.length - 1);
  };

  const handleStepTurn = (delta: -1 | 1) => {
    if (turnSeqs.length === 0) return;
    const baseIdx = activeTurnIdx < 0 ? turnSeqs.length - 1 : activeTurnIdx;
    const nextIdx = Math.max(0, Math.min(turnSeqs.length - 1, baseIdx + delta));
    setActiveTurnIdx(nextIdx);
    scrollToEventSeq(turnSeqs[nextIdx]);
  };

  const handleToggleThinking = () => {
    const nextVal = resolvedThinkingOverride === true ? false : true;
    if (thinkingExpandOverride === undefined) {
      setInternalThinkingOverride(nextVal);
    }
    onThinkingExpandChange?.(nextVal);
  };

  const { matchSeqs, invalidRegex } = useMemo(
    () => findMatchingEventSeqs(events, query, { regex, caseSensitive }),
    [events, query, regex, caseSensitive],
  );

  useEffect(() => {
    if (!searchOpen || !query.trim() || matchSeqs.length === 0) {
      setActiveMatchIndex(-1);
      return;
    }
    setActiveMatchIndex(0);
    scrollToEventSeq(matchSeqs[0]);
  }, [searchOpen, query, regex, caseSensitive, matchSeqs]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeMatchSeq =
    activeMatchIndex >= 0 && activeMatchIndex < matchSeqs.length
      ? matchSeqs[activeMatchIndex]
      : null;

  useEffect(() => {
    onSearchStateChange?.({
      open: searchOpen,
      query: searchOpen ? query : '',
      regex,
      caseSensitive,
      matchSeqs: searchOpen ? matchSeqs : [],
      activeMatchIndex: searchOpen ? activeMatchIndex : -1,
      activeMatchSeq: searchOpen ? activeMatchSeq : null,
      invalidRegex,
    });
  }, [
    searchOpen,
    query,
    regex,
    caseSensitive,
    matchSeqs,
    activeMatchIndex,
    activeMatchSeq,
    invalidRegex,
    onSearchStateChange,
  ]);

  const stepMatch = (delta: -1 | 1) => {
    if (matchSeqs.length === 0) return;
    const base = activeMatchIndex < 0 ? 0 : activeMatchIndex;
    const next = (base + delta + matchSeqs.length) % matchSeqs.length;
    setActiveMatchIndex(next);
    scrollToEventSeq(matchSeqs[next]);
  };

  const openSearch = () => {
    setExportMenuOpen(false);
    setSearchOpen(true);
    setTimeout(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }, 0);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    if (controlledSearchQuery === undefined) setInternalQuery('');
    setActiveMatchIndex(-1);
  };

  const handleCopySessionId = async () => {
    if (!sessionId) return;
    const ok = await copyTextToClipboard(sessionId);
    if (ok) {
      setCopiedId(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopiedId(false);
      }, 1600);
      const shortId = sessionId.length > 10 ? `${sessionId.slice(0, 8)}...` : sessionId;
      showToast(`${t('chatNav.copied')}: ${shortId}`);
    }
  };

  useEffect(() => {
    if (!exportMenuOpen) return;
    const handlePointerDown = (ev: MouseEvent) => {
      if (exportWrapRef.current && !exportWrapRef.current.contains(ev.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [exportMenuOpen]);

  const handleExportMdClick = async () => {
    setExportMenuOpen(false);
    if (onExportMarkdown) {
      await onExportMarkdown();
      return;
    }
    const md = serializeEventsToMarkdown(sessionTitle || sessionId || 'Antigravity Session', events);
    triggerBlobDownload(
      buildDownloadFilename(sessionTitle, sessionId, 'md'),
      md,
      'text/markdown;charset=utf-8',
    );
  };

  const handleExportHtmlClick = async () => {
    setExportMenuOpen(false);
    if (onExportHtml) {
      await onExportHtml();
      return;
    }
    const html = serializeEventsToHtml(sessionTitle || sessionId || 'Antigravity Session', events, {
      sessionId,
      modelName,
      expandThinking: thinkingExpanded,
    });
    triggerBlobDownload(
      buildDownloadFilename(sessionTitle, sessionId, 'html'),
      html,
      'text/html;charset=utf-8',
    );
  };

  const handlePrintPdfClick = () => {
    setExportMenuOpen(false);
    if (onPrintPdf) {
      onPrintPdf();
      return;
    }
    if (typeof window !== 'undefined' && typeof window.print === 'function') {
      window.print();
    }
  };

  const turnDisplay =
    turnSeqs.length > 0
      ? t('chatNav.turnCounter', {
          current: Math.max(1, activeTurnIdx + 1),
          total: turnSeqs.length,
        })
      : t('chatNav.noMatches');

  const matchCountDisplay =
    matchSeqs.length > 0 && activeMatchIndex >= 0
      ? t('chatNav.matchCount', { current: activeMatchIndex + 1, total: matchSeqs.length })
      : t('chatNav.noMatches');

  return (
    <>
      {searchOpen && (
        <div
          className={styles.searchOverlay}
          role="search"
          aria-label={t('chatNav.search')}
          data-testid="chat-search-overlay"
        >
          <input
            ref={searchInputRef}
            type="text"
            className={`${styles.searchInput} ${invalidRegex ? styles.searchInputInvalid : ''}`}
            value={query}
            onChange={(ev) => {
              if (controlledSearchQuery === undefined) setInternalQuery(ev.target.value);
              else
                onSearchStateChange?.({
                  open: true,
                  query: ev.target.value,
                  regex,
                  caseSensitive,
                  matchSeqs,
                  activeMatchIndex,
                  activeMatchSeq,
                  invalidRegex,
                });
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                stepMatch(ev.shiftKey ? -1 : 1);
              } else if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                closeSearch();
              }
            }}
            placeholder={t('chatNav.searchPlaceholder')}
            aria-label={t('chatNav.searchPlaceholder')}
            data-testid="chat-search-input"
          />

          <button
            type="button"
            className={`${styles.searchToggleBtn} ${regex ? styles.searchToggleBtnActive : ''}`}
            aria-pressed={regex}
            title={t('chatNav.regexToggle')}
            aria-label={t('chatNav.regexToggle')}
            onClick={() => {
              const next = !regex;
              if (controlledSearchRegex === undefined) setInternalRegex(next);
              else
                onSearchStateChange?.({
                  open: true,
                  query,
                  regex: next,
                  caseSensitive,
                  matchSeqs,
                  activeMatchIndex,
                  activeMatchSeq,
                  invalidRegex,
                });
            }}
            data-testid="chat-search-regex"
          >
            .*
          </button>

          <button
            type="button"
            className={`${styles.searchToggleBtn} ${caseSensitive ? styles.searchToggleBtnActive : ''}`}
            aria-pressed={caseSensitive}
            title={t('chatNav.caseToggle')}
            aria-label={t('chatNav.caseToggle')}
            onClick={() => {
              const next = !caseSensitive;
              if (controlledSearchCaseSensitive === undefined) setInternalCase(next);
              else
                onSearchStateChange?.({
                  open: true,
                  query,
                  regex,
                  caseSensitive: next,
                  matchSeqs,
                  activeMatchIndex,
                  activeMatchSeq,
                  invalidRegex,
                });
            }}
            data-testid="chat-search-case"
          >
            Aa
          </button>

          <span
            className={`${styles.searchCount} ${query.trim() && matchSeqs.length === 0 ? styles.searchCountEmpty : ''}`}
            data-testid="chat-search-count"
          >
            {matchCountDisplay}
          </span>

          <button
            type="button"
            className={styles.searchNavBtn}
            disabled={matchSeqs.length === 0}
            title={t('chatNav.prevMatch')}
            aria-label={t('chatNav.prevMatch')}
            onClick={() => stepMatch(-1)}
            data-testid="chat-search-prev"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>

          <button
            type="button"
            className={styles.searchNavBtn}
            disabled={matchSeqs.length === 0}
            title={t('chatNav.nextMatch')}
            aria-label={t('chatNav.nextMatch')}
            onClick={() => stepMatch(1)}
            data-testid="chat-search-next"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>

          <button
            type="button"
            className={styles.searchNavBtn}
            title={t('chatNav.closeSearch')}
            aria-label={t('chatNav.closeSearch')}
            onClick={closeSearch}
            data-testid="chat-search-close"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      )}

      <nav
        className={styles.dock}
        role="toolbar"
        aria-label={t('chatNav.dockAria')}
        data-testid="chat-nav-dock"
      >
        <button
          type="button"
          className={styles.dockBtn}
          onClick={handleScrollTop}
          title={t('chatNav.top')}
          aria-label={t('chatNav.top')}
          data-testid="chat-nav-top"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 5h14" />
            <path d="M12 19V9" />
            <path d="m7 14 5-5 5 5" />
          </svg>
        </button>

        <button
          type="button"
          className={styles.dockBtn}
          onClick={() => handleStepTurn(-1)}
          disabled={turnSeqs.length === 0}
          title={t('chatNav.prevTurn')}
          aria-label={t('chatNav.prevTurn')}
          data-testid="chat-nav-prev-turn"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m18 15-6-6-6 6" />
          </svg>
        </button>

        <span className={styles.turnIndicator} data-testid="chat-nav-turn-indicator">
          {turnDisplay}
        </span>

        <button
          type="button"
          className={styles.dockBtn}
          onClick={() => handleStepTurn(1)}
          disabled={turnSeqs.length === 0}
          title={t('chatNav.nextTurn')}
          aria-label={t('chatNav.nextTurn')}
          data-testid="chat-nav-next-turn"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        <button
          type="button"
          className={styles.dockBtn}
          onClick={handleScrollBottom}
          title={t('chatNav.bottom')}
          aria-label={t('chatNav.bottom')}
          data-testid="chat-nav-bottom"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 19h14" />
            <path d="M12 5v10" />
            <path d="m7 10 5 5 5-5" />
          </svg>
        </button>

        <div className={styles.dockDivider} aria-hidden="true" />

        <button
          type="button"
          className={`${styles.dockBtn} ${thinkingExpanded ? styles.dockBtnActive : ''}`}
          onClick={handleToggleThinking}
          aria-pressed={thinkingExpanded}
          data-active={thinkingExpanded ? 'true' : 'false'}
          title={thinkingExpanded ? t('chatNav.collapseThinking') : t('chatNav.expandThinking')}
          aria-label={thinkingExpanded ? t('chatNav.collapseThinking') : t('chatNav.expandThinking')}
          data-testid="chat-nav-thinking"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" />
            <path d="M9 18h6" />
            <path d="M10 22h4" />
          </svg>
        </button>

        <button
          type="button"
          className={`${styles.dockBtn} ${searchOpen ? styles.dockBtnActive : ''}`}
          onClick={() => (searchOpen ? closeSearch() : openSearch())}
          aria-expanded={searchOpen}
          data-active={searchOpen ? 'true' : 'false'}
          title={t('chatNav.search')}
          aria-label={t('chatNav.search')}
          data-testid="chat-nav-search-toggle"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </button>

        <button
          type="button"
          className={`${styles.dockBtn} ${copiedId ? styles.dockBtnActive : ''}`}
          onClick={() => void handleCopySessionId()}
          disabled={!sessionId}
          data-active={copiedId ? 'true' : 'false'}
          title={copiedId ? t('chatNav.copied') : t('chatNav.copySessionId')}
          aria-label={copiedId ? t('chatNav.copied') : t('chatNav.copySessionId')}
          data-testid="chat-nav-copy-id"
        >
          {copiedId ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>

        <div ref={exportWrapRef} className={styles.exportWrap}>
          <button
            type="button"
            className={`${styles.dockBtn} ${exportMenuOpen ? styles.dockBtnActive : ''}`}
            onClick={() => setExportMenuOpen((prev) => !prev)}
            disabled={exporting}
            aria-haspopup="menu"
            aria-expanded={exportMenuOpen}
            data-active={exportMenuOpen ? 'true' : 'false'}
            title={t('chatNav.export')}
            aria-label={t('chatNav.export')}
            data-testid="chat-nav-export"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </button>

          {exportMenuOpen && (
            <div
              className={styles.exportMenu}
              role="menu"
              aria-label={t('chatNav.export')}
              data-testid="chat-nav-export-menu"
            >
              <div className={styles.exportMenuTitle}>{t('chatNav.export')}</div>
              <button
                type="button"
                role="menuitem"
                className={styles.exportMenuItem}
                onClick={() => void handleExportMdClick()}
                data-testid="chat-nav-export-md"
              >
                <span>{t('chatNav.exportMarkdown')}</span>
                <span className={styles.exportExt}>.md</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.exportMenuItem}
                onClick={() => void handleExportHtmlClick()}
                data-testid="chat-nav-export-html"
              >
                <span>{t('chatNav.exportHtml')}</span>
                <span className={styles.exportExt}>.html</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.exportMenuItem}
                onClick={handlePrintPdfClick}
                data-testid="chat-nav-export-pdf"
              >
                <span>{t('chatNav.printPdf')}</span>
                <span className={styles.exportExt}>PDF</span>
              </button>
            </div>
          )}
        </div>

        {toastMsg && (
          <div className={styles.toast} role="status" data-testid="chat-nav-toast">
            {toastMsg}
          </div>
        )}
      </nav>
    </>
  );
}
