import { memo } from 'preact/compat';
import { useState } from 'preact/hooks';
import type { SessionEvent } from '../types';
import {
  type BridgedThinkingNote,
  formatBasename,
  KIND_LABELS,
  summarizeToolEvent,
  summarizeToolGroup
} from './chatFilter';
import { Markdown } from './Markdown';
import styles from './ToolGroupCard.module.css';

export interface ToolGroupCardProps {
  id: string;
  events: SessionEvent[];
  thinkingNotes?: BridgedThinkingNote[];
  onInspectFile?: (filePath: string) => void;
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

function extractNum(
  stats: Record<string, unknown> | null | undefined,
  keys: string[]
): number | null {
  if (!stats) return null;
  for (const k of keys) {
    if (typeof stats[k] === 'number' && Number.isFinite(stats[k])) return stats[k] as number;
  }
  return null;
}

function renderToolDetail(ev: SessionEvent, onInspectFile?: (filePath: string) => void) {
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
            {typeof p.cwd === 'string' && p.cwd && <span className="ag-chip">cwd: {p.cwd}</span>}
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
                <span className="ag-chip">{filePath}</span>
              ))}
            {hasRange && (
              <span className="ag-chip">
                L{String(p.startLine)}-{String(p.endLine)}
              </span>
            )}
            {typeof p.numLines === 'number' && <span className="ag-chip">{p.numLines} 行</span>}
          </div>
          {typeof p.content === 'string' && p.content && (
            <pre className={styles.codeBlock} data-hscroll="1">
              {p.content}
            </pre>
          )}
        </div>
      );
    }

    case 'code_action': {
      const spec = (p.actionSpec as Record<string, unknown> | undefined) || null;
      const targetFile = typeof spec?.targetFile === 'string' ? spec.targetFile : '';
      const diffStats = (p.diffStats as Record<string, unknown> | undefined) || null;
      const additions = extractNum(diffStats, ['additions', 'linesAdded', 'added']);
      const deletions = extractNum(diffStats, ['deletions', 'linesRemoved', 'removed']);
      return (
        <div className={styles.detailBody}>
          {typeof spec?.description === 'string' && spec.description && (
            <Markdown text={spec.description} />
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
          </div>
          {spec && !spec.description && (
            <pre className={styles.codeBlock} data-hscroll="1">
              {formatJson(spec)}
            </pre>
          )}
        </div>
      );
    }

    case 'web_search': {
      const docs = Array.isArray(p.webDocuments) ? p.webDocuments : [];
      return (
        <div className={styles.detailBody}>
          <div className={styles.metaRow}>
            {typeof p.query === 'string' && p.query && (
              <span className="ag-chip">检索: {p.query}</span>
            )}
            {docs.length > 0 && <span className="ag-chip">{docs.length} 条来源</span>}
          </div>
          {typeof p.summary === 'string' && p.summary && <Markdown text={p.summary} />}
          {docs.length > 0 && (
            <div className={styles.webList}>
              {docs.slice(0, 6).map((d, idx) => {
                const doc = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
                const title = String(doc.title || doc.url || `结果 ${idx + 1}`);
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
              <span className="ag-chip">至步骤 #{String(p.includedStepIndexEnd)}</span>
            )}
            {typeof p.totalSubagentCount === 'number' && p.totalSubagentCount > 0 && (
              <span className="ag-chip">{p.totalSubagentCount} 子代理</span>
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
    const spec = (p.actionSpec as Record<string, unknown> | undefined) || null;
    if (typeof spec?.targetFile === 'string' && spec.targetFile) return spec.targetFile;
  }
  return '';
}

function ToolSubRow({
  event,
  onInspectFile
}: {
  event: SessionEvent;
  onInspectFile?: (filePath: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const p = event.payload || {};
  const isRunning = event.status === 'running' || event.status === 'generating';
  const isError = event.status === 'error';
  const filePath = getInspectableFilePath(event);
  const summary = summarizeToolEvent(event);

  const diffStats =
    event.kind === 'code_action'
      ? ((p.diffStats as Record<string, unknown> | undefined) || null)
      : null;
  const additions = extractNum(diffStats, ['additions', 'linesAdded', 'added']);
  const deletions = extractNum(diffStats, ['deletions', 'linesRemoved', 'removed']);
  const hasExit = event.kind === 'command' && typeof p.exitCode === 'number';

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
          <span className={styles.subKind}>{KIND_LABELS[event.kind] || event.kind}</span>
          <span className={styles.subSummary}>{summary}</span>
        </button>

        <div className={styles.subRight}>
          {filePath && onInspectFile && (
            <button
              type="button"
              className={styles.inspectQuickBtn}
              title={`查看 ${filePath}`}
              onClick={(e) => {
                e.stopPropagation();
                onInspectFile(filePath);
              }}
            >
              {formatBasename(filePath)}
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
            aria-label={expanded ? '收起工具详情' : '展开工具详情'}
            onClick={() => setExpanded((prev) => !prev)}
          >
            <span className={[styles.chevron, expanded ? styles.chevronOpen : ''].join(' ')}>
              ▸
            </span>
          </button>
        </div>
      </div>

      {expanded && <div className={styles.subDetail}>{renderToolDetail(event, onInspectFile)}</div>}
    </div>
  );
}

function ToolGroupCardInner({ id, events, thinkingNotes, onInspectFile }: ToolGroupCardProps) {
  const [open, setOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const { headline, activeEvent, hasError } = summarizeToolGroup(events);

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
            <ToolSubRow key={ev.seq} event={ev} onInspectFile={onInspectFile} />
          ))}

          {thinkingNotes && thinkingNotes.length > 0 && (
            <div className={styles.notesBox}>
              <button
                type="button"
                className={styles.notesToggle}
                aria-expanded={notesOpen}
                onClick={() => setNotesOpen((prev) => !prev)}
              >
                <span>中间思考记录 ({thinkingNotes.length})</span>
                <span>{notesOpen ? '收起' : '展开'}</span>
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
