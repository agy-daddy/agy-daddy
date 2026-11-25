import { useEffect, useMemo, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import { BottomSheet } from '../layout/BottomSheet';
import type { SessionEvent } from '../types';
import { extractPlannerText, extractUserText, isInternalAgentEvent } from './chatFilter';
import { serializeEventsToMarkdown } from './composerUtils';
import styles from './ChatNavDock.module.css';

export interface ChatNavDockProps {
  events: SessionEvent[];
  sessionId: string;
  sessionTitle: string;
  modelName?: string;
  hideSystemEvents: boolean;
  thinkingExpandedAll: boolean;
  searchQuery: string;
  searchRegex: boolean;
  searchCaseSensitive: boolean;
  onSearchChange: (next: { query: string; regex: boolean; caseSensitive: boolean }) => void;
  onJumpToSeq: (seq: number) => void;
  onScrollTop: () => void;
  onScrollBottom: () => void;
  onToggleThinkingAll: (expand: boolean) => void;
  onToggleHideSystem: (hide: boolean) => void;
  onShowToast?: (msg: string) => void;
}

function escapeHtml(raw: string): string {
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractEventSearchText(ev: SessionEvent): string {
  const p = ev.payload || {};
  const parts: string[] = [];
  if (ev.title) parts.push(ev.title);
  if (ev.kind === 'user') parts.push(extractUserText(p));
  else if (ev.kind === 'thinking_and_text') {
    if (typeof p.thinking === 'string') parts.push(p.thinking);
    parts.push(extractPlannerText(p));
  } else {
    try {
      parts.push(JSON.stringify(p));
    } catch {}
  }
  return parts.join('\n');
}

function downloadBlob(filename: string, content: string, mime: string): void {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return;
  const blob = new Blob([content], { type: mime });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL?.(href);
}

export function serializeEventsToHtml(
  title: string,
  events: SessionEvent[],
  sessionId?: string,
  modelName?: string
): string {
  const rows = events.map((ev) => {
    const p = ev.payload || {};
    const body =
      ev.kind === 'user'
        ? extractUserText(p)
        : ev.kind === 'thinking_and_text'
          ? extractPlannerText(p)
          : JSON.stringify(p, null, 2);
    return `<section class="turn"><h3>#${ev.seq} · ${escapeHtml(ev.kind)}</h3><pre>${escapeHtml(body)}</pre></section>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:sans-serif;max-width:820px;margin:24px auto;padding:0 16px}pre{white-space:pre-wrap;background:rgba(128,128,128,0.12);padding:12px;border-radius:8px}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(sessionId || '')} ${escapeHtml(modelName || '')}</p>${rows.join('\n')}</body></html>`;
}

export function ChatNavDock({
  events,
  sessionId,
  sessionTitle,
  modelName,
  hideSystemEvents,
  thinkingExpandedAll,
  searchQuery,
  searchRegex,
  searchCaseSensitive,
  onSearchChange,
  onJumpToSeq,
  onScrollTop,
  onScrollBottom,
  onToggleThinkingAll,
  onToggleHideSystem,
  onShowToast
}: ChatNavDockProps) {
  const { t } = useI18n();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [matchIdx, setMatchIdx] = useState(-1);
  const [turnIdx, setTurnIdx] = useState(-1);
  const [copiedId, setCopiedId] = useState(false);

  const visibleEvents = useMemo(
    () =>
      events.filter(
        (ev) => !isInternalAgentEvent(ev) && (!hideSystemEvents || ev.kind !== 'system')
      ),
    [events, hideSystemEvents]
  );

  const systemCount = useMemo(
    () => events.filter((ev) => !isInternalAgentEvent(ev) && ev.kind === 'system').length,
    [events]
  );

  const turnSeqs = useMemo(() => {
    const users = visibleEvents.filter((ev) => ev.kind === 'user').map((ev) => ev.seq);
    if (users.length > 0) return users;
    return visibleEvents.filter((ev) => ev.kind === 'thinking_and_text').map((ev) => ev.seq);
  }, [visibleEvents]);

  const { matchSeqs, invalidRegex } = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return { matchSeqs: [] as number[], invalidRegex: false };
    let matcher: (text: string) => boolean;
    if (searchRegex) {
      try {
        const re = new RegExp(q, searchCaseSensitive ? '' : 'i');
        matcher = (txt) => re.test(txt);
      } catch {
        return { matchSeqs: [] as number[], invalidRegex: true };
      }
    } else {
      const needle = searchCaseSensitive ? q : q.toLowerCase();
      matcher = (txt) =>
        searchCaseSensitive ? txt.includes(needle) : txt.toLowerCase().includes(needle);
    }
    const hits: number[] = [];
    for (const ev of visibleEvents) {
      if (matcher(extractEventSearchText(ev))) hits.push(ev.seq);
    }
    return { matchSeqs: hits, invalidRegex: false };
  }, [visibleEvents, searchQuery, searchRegex, searchCaseSensitive]);

  useEffect(() => {
    if (matchSeqs.length === 0) {
      setMatchIdx(-1);
    } else {
      setMatchIdx(0);
    }
  }, [matchSeqs.length, searchQuery, searchRegex, searchCaseSensitive]);

  useEffect(() => {
    setTurnIdx(turnSeqs.length > 0 ? turnSeqs.length - 1 : -1);
  }, [sessionId, turnSeqs.length]);

  const stepMatch = (delta: number) => {
    if (matchSeqs.length === 0) return;
    const base = matchIdx < 0 ? 0 : matchIdx;
    const next = (base + delta + matchSeqs.length) % matchSeqs.length;
    setMatchIdx(next);
    onJumpToSeq(matchSeqs[next]);
  };

  const stepTurn = (delta: number) => {
    if (turnSeqs.length === 0) return;
    const base = turnIdx < 0 ? turnSeqs.length - 1 : turnIdx;
    const next = Math.max(0, Math.min(turnSeqs.length - 1, base + delta));
    setTurnIdx(next);
    onJumpToSeq(turnSeqs[next]);
  };

  const handleCopySessionId = async () => {
    if (!sessionId) return;
    try {
      await navigator.clipboard?.writeText(sessionId);
      setCopiedId(true);
      onShowToast?.(t('common.copied'));
      setTimeout(() => setCopiedId(false), 1500);
    } catch {}
  };

  const handleExportMd = () => {
    const md = serializeEventsToMarkdown(sessionTitle || sessionId, visibleEvents);
    downloadBlob(`agy-${(sessionId || 'session').slice(0, 12)}.md`, md, 'text/markdown;charset=utf-8');
  };

  const handleExportHtml = () => {
    const html = serializeEventsToHtml(sessionTitle || sessionId, visibleEvents, sessionId, modelName);
    downloadBlob(`agy-${(sessionId || 'session').slice(0, 12)}.html`, html, 'text/html;charset=utf-8');
  };

  const handlePrint = () => {
    const html = serializeEventsToHtml(sessionTitle || sessionId, visibleEvents, sessionId, modelName);
    const win = window.open('', '_blank');
    if (win) {
      win.document.open();
      win.document.write(html);
      win.document.close();
      win.print?.();
    } else {
      window.print?.();
    }
  };

  return (
    <>
      <div className={styles.fabWrap}>
        <div className={styles.fabRow}>
          {matchSeqs.length > 0 && (
            <>
              <button
                type="button"
                className={styles.pillBtn}
                aria-label={t('nav.prevMatch')}
                onClick={() => stepMatch(-1)}
                data-testid="nav-quick-prev-match"
              >
                ↑
              </button>
              <button
                type="button"
                className={styles.pillBtn}
                aria-label={t('nav.nextMatch')}
                onClick={() => stepMatch(1)}
                data-testid="nav-quick-next-match"
              >
                ↓
              </button>
            </>
          )}

          <button
            type="button"
            className={styles.pillBtn}
            aria-label={t('nav.title')}
            data-testid="chat-nav-dock-trigger"
            onClick={() => setSheetOpen(true)}
          >
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.5 10.5L13.75 13.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            {matchSeqs.length > 0 && (
              <span>
                {matchIdx + 1}/{matchSeqs.length}
              </span>
            )}
          </button>
        </div>
      </div>

      <BottomSheet
        open={sheetOpen}
        title={t('nav.title')}
        testId="chat-nav-dock-sheet"
        onClose={() => setSheetOpen(false)}
      >
        <div className={styles.sheetBody}>
          <div className={styles.searchRow}>
            <input
              type="search"
              className={`${styles.searchInput} ${invalidRegex ? styles.searchInputInvalid : ''}`}
              placeholder={t('nav.searchPlaceholder')}
              value={searchQuery}
              onInput={(e) =>
                onSearchChange({
                  query: (e.target as HTMLInputElement).value,
                  regex: searchRegex,
                  caseSensitive: searchCaseSensitive
                })
              }
              data-testid="chat-nav-search-input"
            />
            <button
              type="button"
              className={`${styles.toggleBtn} ${searchCaseSensitive ? styles.toggleBtnActive : ''}`}
              aria-pressed={searchCaseSensitive}
              aria-label={t('nav.caseSensitive')}
              onClick={() =>
                onSearchChange({
                  query: searchQuery,
                  regex: searchRegex,
                  caseSensitive: !searchCaseSensitive
                })
              }
              data-testid="chat-nav-case-btn"
            >
              Aa
            </button>
            <button
              type="button"
              className={`${styles.toggleBtn} ${searchRegex ? styles.toggleBtnActive : ''}`}
              aria-pressed={searchRegex}
              aria-label={t('nav.regex')}
              onClick={() =>
                onSearchChange({
                  query: searchQuery,
                  regex: !searchRegex,
                  caseSensitive: searchCaseSensitive
                })
              }
              data-testid="chat-nav-regex-btn"
            >
              .*
            </button>
          </div>

          {searchQuery.trim() && (
            <div className={styles.matchBar}>
              <span className={styles.matchCount} data-testid="chat-nav-match-count">
                {invalidRegex
                  ? 'Invalid Regex'
                  : matchSeqs.length > 0
                    ? `${matchIdx + 1} / ${matchSeqs.length}`
                    : '0 / 0'}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className={styles.navBtn}
                  disabled={matchSeqs.length === 0}
                  onClick={() => stepMatch(-1)}
                  data-testid="chat-nav-prev-match"
                >
                  ↑ {t('nav.prevMatch')}
                </button>
                <button
                  type="button"
                  className={styles.navBtn}
                  disabled={matchSeqs.length === 0}
                  onClick={() => stepMatch(1)}
                  data-testid="chat-nav-next-match"
                >
                  ↓ {t('nav.nextMatch')}
                </button>
              </div>
            </div>
          )}

          <div className={styles.grid4}>
            <button
              type="button"
              className={styles.navBtn}
              onClick={() => {
                onScrollTop();
                setSheetOpen(false);
              }}
              data-testid="chat-nav-top"
            >
              ⤒ {t('nav.top')}
            </button>
            <button
              type="button"
              className={styles.navBtn}
              disabled={turnSeqs.length === 0}
              onClick={() => stepTurn(-1)}
              data-testid="chat-nav-prev-turn"
            >
              ↑ {t('nav.prevTurn')}
            </button>
            <button
              type="button"
              className={styles.navBtn}
              disabled={turnSeqs.length === 0}
              onClick={() => stepTurn(1)}
              data-testid="chat-nav-next-turn"
            >
              ↓ {t('nav.nextTurn')}
            </button>
            <button
              type="button"
              className={styles.navBtn}
              onClick={() => {
                onScrollBottom();
                setSheetOpen(false);
              }}
              data-testid="chat-nav-bottom"
            >
              ⤓ {t('nav.bottom')}
            </button>
          </div>

          <div className={styles.grid2}>
            <button
              type="button"
              className={`${styles.navBtn} ${thinkingExpandedAll ? styles.navBtnActive : ''}`}
              onClick={() => onToggleThinkingAll(!thinkingExpandedAll)}
              data-testid="chat-nav-toggle-thinking"
            >
              {thinkingExpandedAll ? t('nav.collapseThinking') : t('nav.expandThinking')}
            </button>
            <button
              type="button"
              className={`${styles.navBtn} ${hideSystemEvents ? styles.navBtnActive : ''}`}
              onClick={() => onToggleHideSystem(!hideSystemEvents)}
              data-testid="chat-nav-toggle-system"
            >
              {hideSystemEvents
                ? t('nav.showSystem', { count: systemCount })
                : t('nav.hideSystem', { count: systemCount })}
            </button>
          </div>

          <div className={styles.grid2}>
            <button
              type="button"
              className={styles.navBtn}
              disabled={!sessionId}
              onClick={() => void handleCopySessionId()}
              data-testid="chat-nav-copy-id"
            >
              {copiedId ? t('common.copied') : t('nav.copySessionId')}
            </button>
            <button
              type="button"
              className={styles.navBtn}
              onClick={handleExportMd}
              data-testid="chat-nav-export-md"
            >
              {t('nav.exportMd')}
            </button>
            <button
              type="button"
              className={styles.navBtn}
              onClick={handleExportHtml}
              data-testid="chat-nav-export-html"
            >
              {t('nav.exportHtml')}
            </button>
            <button
              type="button"
              className={styles.navBtn}
              onClick={handlePrint}
              data-testid="chat-nav-print"
            >
              {t('nav.printPdf')}
            </button>
          </div>
        </div>
      </BottomSheet>
    </>
  );
}
