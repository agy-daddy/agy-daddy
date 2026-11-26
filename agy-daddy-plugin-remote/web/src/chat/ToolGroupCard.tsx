import { memo } from 'preact/compat';
import { useState } from 'preact/hooks';
import { type TranslateFn, useI18n } from '../i18n';
import type { SessionEvent } from '../types';
import {
  type BridgedThinkingNote,
  formatBasename,
  summarizeToolEvent,
  summarizeToolGroup
} from './chatFilter';
import {
  extractCodeActionDiffLines,
  extractCodeActionDiffStats,
  extractCodeActionTargetFile
} from './codeActionUtils';
import { Markdown } from './Markdown';
import styles from './ToolGroupCard.module.css';

export interface ToolGroupCardProps {
  id: string;
  events: SessionEvent[];
  thinkingNotes?: BridgedThinkingNote[];
  onInspectFile?: (filePath: string) => void;
  onViewDiffFile?: (filePath: string) => void;
  searchQuery?: string;
  searchRegex?: boolean;
  searchCaseSensitive?: boolean;
  currentMatchSeq?: number | null;
}

function formatJson(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function CodeActionToolDetail({
  ev,
  t,
  onInspectFile,
  onViewDiffFile,
  searchQuery,
  searchRegex,
  searchCaseSensitive,
  isCurrentMatch
}: {
  ev: SessionEvent;
  t: TranslateFn;
  onInspectFile?: (filePath: string) => void;
  onViewDiffFile?: (filePath: string) => void;
  searchQuery?: string;
  searchRegex?: boolean;
  searchCaseSensitive?: boolean;
  isCurrentMatch?: boolean;
}) {
  const [diffExpanded, setDiffExpanded] = useState(false);
  const p = ev.payload || {};
  const spec = (p.actionSpec as Record<string, unknown> | undefined) || null;
  const targetFile = extractCodeActionTargetFile(p, ev.title);
  const { additions, deletions } = extractCodeActionDiffStats(p);
  const diffLines = extractCodeActionDiffLines(p, 80);
  const visibleLines = diffExpanded ? diffLines : diffLines.slice(0, 16);
  const openDiff = onViewDiffFile || onInspectFile;

  return (
    <div className={styles.detailBody}>
      {typeof spec?.description === 'string' && spec.description && (
        <Markdown
          text={spec.description}
          highlightQuery={searchQuery}
          highlightRegex={searchRegex}
          highlightCaseSensitive={searchCaseSensitive}
          isCurrentMatch={isCurrentMatch}
        />
      )}
      <div className={styles.metaRow}>
        {targetFile &&
          (onInspectFile ? (
            <button
              type="button"
              className={styles.fileBtn}
              onClick={(e) => {
                e.stopPropagation();
                onInspectFile(targetFile);
              }}
            >
              {targetFile}
            </button>
          ) : (
            <span className="ag-chip">{targetFile}</span>
          ))}
        {additions !== null && (
          <span className="ag-chip" data-tone="ok">
            +{additions}
          </span>
        )}
        {deletions !== null && (
          <span className="ag-chip" data-tone="danger">
            -{deletions}
          </span>
        )}
        {targetFile && openDiff && (
          <button
            type="button"
            className={styles.viewDiffBtn}
            onClick={(e) => {
              e.stopPropagation();
              openDiff(targetFile);
            }}
            data-testid={`tool-group-diff-${ev.seq}`}
          >
            {t('chat.viewInDiff')} ↗
          </button>
        )}
      </div>
      {visibleLines.length > 0 ? (
        <div className={styles.diffPreviewWrap} data-testid={`tool-group-diff-lines-${ev.seq}`}>
          {visibleLines.map((line, i) => (
            <div
              key={i}
              className={[
                styles.diffLine,
                line.kind === 'add'
                  ? styles.diffLineAdd
                  : line.kind === 'del'
                    ? styles.diffLineDel
                    : line.kind === 'hunk'
                      ? styles.diffLineHunk
                      : styles.diffLineCtx
              ].join(' ')}
            >
              <span className={styles.diffSign}>
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
              </span>
              <span>{line.text}</span>
            </div>
          ))}
          {diffLines.length > 16 && (
            <button
              type="button"
              className={styles.diffExpandBtn}
              onClick={(e) => {
                e.stopPropagation();
                setDiffExpanded((v) => !v);
              }}
            >
              {diffExpanded
                ? t('chat.collapsePreview')
                : t('chat.expandLines', { count: diffLines.length - 16 })}
            </button>
          )}
        </div>
      ) : (
        spec &&
        !spec.description && (
          <pre className={styles.codeBlock} data-hscroll="1">
            {formatJson(spec)}
          </pre>
        )
      )}
    </div>
  );
}

function renderToolDetail(
  ev: SessionEvent,
  t: TranslateFn,
  onInspectFile?: (filePath: string) => void,
  onViewDiffFile?: (filePath: string) => void,
  searchQuery?: string,
  searchRegex?: boolean,
  searchCaseSensitive?: boolean,
  isCurrentMatch?: boolean
) {
  const p = ev.payload || {};

  switch (ev.kind) {
    case 'command': {
      const cmd = String(p.commandLine || p.proposedCommandLine || ev.title || '');
      const hasExit = typeof p.exitCode === 'number';
      return (
        <div className={styles.detailBody}>
          {cmd && (
            <pre className={styles.codeBlock} data-hscroll="1">
              $ {cmd}
            </pre>
          )}
          <div className={styles.metaRow}>
            {typeof p.cwd === 'string' && p.cwd && (
              <span className="ag-chip ag-chip-ellipsis" title={`cwd: ${p.cwd}`}>
                cwd: {p.cwd}
              </span>
            )}
            {hasExit && (
              <span className="ag-chip" data-tone={p.exitCode === 0 ? 'ok' : 'danger'}>
                exit {String(p.exitCode)}
              </span>
            )}
          </div>
          {typeof p.combinedOutput === 'string' && p.combinedOutput.length > 0 && (
            <pre className={styles.codeBlock} data-hscroll="1">
              {p.combinedOutput}
            </pre>
          )}
        </div>
      );
    }

    case 'file_view': {
      const filePath = String(p.absolutePathUri || ev.title || '');
      const hasRange = p.startLine != null && p.endLine != null;
      return (
        <div className={styles.detailBody}>
          <div className={styles.metaRow}>
            {filePath &&
              (onInspectFile ? (
                <button
                  type="button"
                  className={styles.fileBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    onInspectFile(filePath);
                  }}
                >
                  {filePath}
                </button>
              ) : (
                <span className="ag-chip ag-chip-ellipsis" title={filePath}>
                  {filePath}
                </span>
              ))}
            {hasRange && (
              <span className="ag-chip">
                L{String(p.startLine)}-{String(p.endLine)}
              </span>
            )}
            {typeof p.numLines === 'number' && (
              <span className="ag-chip">{t('chat.linesCount', { count: p.numLines })}</span>
            )}
          </div>
          {typeof p.content === 'string' && p.content && (
            <pre className={styles.codeBlock} data-hscroll="1">
              {p.content}
            </pre>
          )}
        </div>
      );
    }

    case 'code_action':
      return (
        <CodeActionToolDetail
          ev={ev}
          t={t}
          onInspectFile={onInspectFile}
          onViewDiffFile={onViewDiffFile}
          searchQuery={searchQuery}
          searchRegex={searchRegex}
          searchCaseSensitive={searchCaseSensitive}
          isCurrentMatch={isCurrentMatch}
        />
      );

    case 'web_search': {
      const docs = Array.isArray(p.webDocuments) ? p.webDocuments : [];
      return (
        <div className={styles.detailBody}>
          <div className={styles.metaRow}>
            {typeof p.query === 'string' && p.query && (
              <span className="ag-chip ag-chip-ellipsis" title={p.query}>
                {t('chat.searchQuery')}: {p.query}
              </span>
            )}
            {docs.length > 0 && (
              <span className="ag-chip">{t('chat.sourcesCount', { count: docs.length })}</span>
            )}
          </div>
          {typeof p.summary === 'string' && p.summary && <Markdown text={p.summary} />}
          {docs.length > 0 && (
            <div className={styles.webList}>
              {docs.slice(0, 6).map((d, idx) => {
                const doc = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
                const title = String(doc.title || doc.url || t('chat.resultIndex', { index: idx + 1 }));
                const url = typeof doc.url === 'string' ? doc.url : '';
                return (
                  <div key={idx} className={styles.webItem}>
                    <div className={styles.webTitle}>
                      {url && (url.startsWith('http://') || url.startsWith('https://')) ? (
                        <a href={url} target="_blank" rel="noreferrer noopener">
                          {title}
                        </a>
                      ) : (
                        title
                      )}
                    </div>
                    {typeof doc.snippet === 'string' && (
                      <div className={styles.webSnippet}>{doc.snippet}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }

    case 'checkpoint': {
      return (
        <div className={styles.detailBody}>
          {typeof p.sessionSummary === 'string' && p.sessionSummary && (
            <Markdown text={p.sessionSummary} />
          )}
          <div className={styles.metaRow}>
            {p.includedStepIndexEnd != null && (
              <span className="ag-chip">
                {t('chat.toStep', { seq: String(p.includedStepIndexEnd) })}
              </span>
            )}
            {typeof p.totalSubagentCount === 'number' && p.totalSubagentCount > 0 && (
              <span className="ag-chip">
                {t('chat.subagentsCount', { count: p.totalSubagentCount })}
              </span>
            )}
          </div>
        </div>
      );
    }

    default: {
      return (
        <div className={styles.detailBody}>
          {p.args !== undefined && (
            <pre className={styles.codeBlock} data-hscroll="1">
              {formatJson(p.args)}
            </pre>
          )}
          {p.result !== undefined && (
            <pre className={styles.codeBlock} data-hscroll="1">
              {formatJson(p.result)}
            </pre>
          )}
          {p.args === undefined && p.result === undefined && (
            <pre className={styles.codeBlock} data-hscroll="1">
              {formatJson(p)}
            </pre>
          )}
        </div>
      );
    }
  }
}

function getInspectableFilePath(ev: SessionEvent): string {
  const p = ev.payload || {};
  if (ev.kind === 'file_view' && typeof p.absolutePathUri === 'string' && p.absolutePathUri) {
    return p.absolutePathUri;
  }
  if (ev.kind === 'code_action') {
    return extractCodeActionTargetFile(p, ev.title);
  }
  return '';
}

function ToolSubRow({
  event,
  t,
  onInspectFile,
  onViewDiffFile,
  searchQuery,
  searchRegex,
  searchCaseSensitive,
  isCurrentMatch
}: {
  event: SessionEvent;
  t: TranslateFn;
  onInspectFile?: (filePath: string) => void;
  onViewDiffFile?: (filePath: string) => void;
  searchQuery?: string;
  searchRegex?: boolean;
  searchCaseSensitive?: boolean;
  isCurrentMatch?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const p = event.payload || {};
  const isRunning = event.status === 'running' || event.status === 'generating';
  const isError = event.status === 'error';
  const filePath = getInspectableFilePath(event);
  const summary = summarizeToolEvent(event, t);

  const { additions, deletions } =
    event.kind === 'code_action'
      ? extractCodeActionDiffStats(p)
      : { additions: null, deletions: null };
  const hasExit = event.kind === 'command' && typeof p.exitCode === 'number';
  const chipHandler =
    event.kind === 'code_action' && onViewDiffFile ? onViewDiffFile : onInspectFile;

  return (
    <div
      className={[styles.subRow, isError ? styles.subRowError : ''].filter(Boolean).join(' ')}
      data-testid={`tool-group-item-${event.seq}`}
      data-kind={event.kind}
      data-status={event.status}
    >
      <div className={styles.subHeader}>
        <button
          type="button"
          className={styles.subToggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {isRunning ? (
            <span className={styles.spinnerSm} aria-hidden="true" />
          ) : (
            <span
              className={[styles.dot, isError ? styles.dotError : styles.dotDone].join(' ')}
              aria-hidden="true"
            />
          )}
          <span className={styles.subKind}>{t(`kind.${event.kind}`)}</span>
          <span className={styles.subSummary}>{summary}</span>
        </button>

        <div className={styles.subRight}>
          {filePath && chipHandler && (
            <button
              type="button"
              className={styles.inspectQuickBtn}
              title={t('chat.inspectFile', { path: filePath })}
              onClick={(e) => {
                e.stopPropagation();
                chipHandler(filePath);
              }}
            >
              <span className={styles.inspectQuickText}>{formatBasename(filePath)}</span>
            </button>
          )}
          {hasExit && (
            <span className="ag-chip" data-tone={p.exitCode === 0 ? 'ok' : 'danger'}>
              {String(p.exitCode)}
            </span>
          )}
          {additions !== null && (
            <span className="ag-chip" data-tone="ok">
              +{additions}
            </span>
          )}
          {deletions !== null && (
            <span className="ag-chip" data-tone="danger">
              -{deletions}
            </span>
          )}
          <button
            type="button"
            className={styles.chevronBtn}
            aria-label={expanded ? t('chat.collapse') : t('chat.expand')}
            onClick={() => setExpanded((prev) => !prev)}
          >
            <span className={[styles.chevron, expanded ? styles.chevronOpen : ''].join(' ')}>
              ▸
            </span>
          </button>
        </div>
      </div>

      {expanded && (
        <div className={styles.subDetail}>
          {renderToolDetail(
            event,
            t,
            onInspectFile,
            onViewDiffFile,
            searchQuery,
            searchRegex,
            searchCaseSensitive,
            isCurrentMatch
          )}
        </div>
      )}
    </div>
  );
}

function ToolGroupCardInner({
  id,
  events,
  thinkingNotes,
  onInspectFile,
  onViewDiffFile,
  searchQuery,
  searchRegex,
  searchCaseSensitive,
  currentMatchSeq
}: ToolGroupCardProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const { headline, activeEvent, hasError } = summarizeToolGroup(events, t);

  return (
    <section
      className={[
        styles.groupCard,
        activeEvent ? styles.groupRunning : '',
        hasError ? styles.groupError : ''
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={`tool-group-${id}`}
      data-count={events.length}
    >
      <button
        type="button"
        className={styles.groupToggle}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        data-testid={`tool-group-toggle-${id}`}
      >
        <div className={styles.groupLeft}>
          {activeEvent ? (
            <span className={styles.spinner} aria-hidden="true" />
          ) : (
            <span
              className={[styles.groupIcon, hasError ? styles.groupIconError : ''].join(' ')}
              aria-hidden="true"
            >
              ⚙
            </span>
          )}
          <span className={styles.headline}>{headline}</span>
        </div>
        <div className={styles.groupRight}>
          <span className={styles.countPill}>{events.length}</span>
          <span className={[styles.chevron, open ? styles.chevronOpen : ''].join(' ')}>▸</span>
        </div>
      </button>

      {open && (
        <div className={styles.groupBody} data-testid={`tool-group-body-${id}`}>
          {events.map((ev) => (
            <ToolSubRow
              key={ev.seq}
              event={ev}
              t={t}
              onInspectFile={onInspectFile}
              onViewDiffFile={onViewDiffFile}
              searchQuery={searchQuery}
              searchRegex={searchRegex}
              searchCaseSensitive={searchCaseSensitive}
              isCurrentMatch={ev.seq === currentMatchSeq}
            />
          ))}

          {thinkingNotes && thinkingNotes.length > 0 && (
            <div className={styles.notesBox}>
              <button
                type="button"
                className={styles.notesToggle}
                aria-expanded={notesOpen}
                onClick={() => setNotesOpen((prev) => !prev)}
              >
                <span>{t('chat.bridgedThinking', { count: thinkingNotes.length })}</span>
                <span>{notesOpen ? t('chat.collapse') : t('chat.expand')}</span>
              </button>
              {notesOpen && (
                <div className={styles.notesList}>
                  {thinkingNotes.map((n) => (
                    <pre key={n.seq} className={styles.noteText}>
                      {n.thinking}
                    </pre>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export const ToolGroupCard = memo(ToolGroupCardInner, (prev, next) => {
  if (
    prev.id !== next.id ||
    prev.onInspectFile !== next.onInspectFile ||
    prev.onViewDiffFile !== next.onViewDiffFile ||
    prev.searchQuery !== next.searchQuery ||
    prev.searchRegex !== next.searchRegex ||
    prev.searchCaseSensitive !== next.searchCaseSensitive ||
    prev.currentMatchSeq !== next.currentMatchSeq ||
    prev.events.length !== next.events.length ||
    (prev.thinkingNotes?.length || 0) !== (next.thinkingNotes?.length || 0)
  ) {
    return false;
  }
  for (let i = 0; i < next.events.length; i++) {
    const a = prev.events[i];
    const b = next.events[i];
    if (a !== b) {
      if (b.status === 'running' || b.status === 'generating' || b.status === 'pending') {
        return false;
      }
      if (a.seq !== b.seq || a.status !== b.status || a.payload !== b.payload) {
        return false;
      }
    }
  }
  return true;
});
