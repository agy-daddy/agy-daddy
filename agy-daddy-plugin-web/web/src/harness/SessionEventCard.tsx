import React, { useEffect, useMemo, useState } from 'react';
import { humanizeEnum, useI18n, type I18nKey } from '../i18n';
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
  SessionEventStatus,
  SystemMessagePayload,
  UserEventPayload,
  WebSearchPayload,
} from '../types';
import {
  extractCodeActionDiffLines,
  extractCodeActionDiffStats,
  extractCodeActionTargetFile,
} from './codeActionUtils';
import { MarkdownContent } from './MarkdownContent';
import styles from './SessionEventCard.module.css';

export interface SessionEventCardProps {
  event: SessionEvent;
  defaultThinkingExpanded?: boolean;
  thinkingExpandOverride?: boolean | null;
  searchMatchState?: 'hit' | 'active' | null;
  searchQuery?: string;
  searchRegex?: boolean;
  searchCaseSensitive?: boolean;
  onInspectFile?: (filePath: string) => void;
  onReviewDiff?: (filePath?: string) => void;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildHighlightRegex(
  query: string | undefined,
  regexMode: boolean,
  caseSensitive: boolean,
): RegExp | null {
  const trimmed = String(query || '').trim();
  if (!trimmed) return null;
  try {
    const source = regexMode ? trimmed : escapeRegExp(trimmed);
    return new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch {
    return null;
  }
}

function highlightText(
  text: string,
  regex: RegExp | null,
  markClassName: string,
): React.ReactNode {
  if (!regex || !text) return text;
  const re = new RegExp(regex.source, regex.flags);
  const nodes: React.ReactNode[] = [];
  let lastIdx = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > lastIdx) {
      nodes.push(text.slice(lastIdx, m.index));
    }
    nodes.push(
      <mark key={`m-${count}`} className={markClassName}>
        {m[0]}
      </mark>,
    );
    lastIdx = m.index + m[0].length;
    count += 1;
    if (count >= 200) break;
  }
  if (count === 0) return text;
  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx));
  }
  return nodes;
}

function getStatusClass(status: SessionEventStatus): string {
  switch (status) {
    case 'pending':
      return styles.statusPending;
    case 'running':
      return styles.statusRunning;
    case 'generating':
      return styles.statusGenerating;
    case 'done':
      return styles.statusDone;
    case 'error':
      return styles.statusError;
    case 'canceled':
      return styles.statusCanceled;
    default:
      return styles.statusCanceled;
  }
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractUserText(payload: UserEventPayload): string {
  if (typeof payload.userResponse === 'string' && payload.userResponse) {
    return payload.userResponse;
  }
  if (typeof payload.text === 'string' && payload.text) {
    return payload.text;
  }
  if (Array.isArray(payload.items)) {
    return payload.items
      .map((item) => (typeof item === 'string' ? item : item?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function renderQuestionItem(q: unknown, index: number): React.ReactNode {
  if (typeof q === 'string') {
    return (
      <div key={index} className={styles.subItem}>
        <div className={styles.prose}>{q}</div>
      </div>
    );
  }
  if (q && typeof q === 'object') {
    const obj = q as Record<string, unknown>;
    const header = typeof obj.header === 'string' ? obj.header : undefined;
    const text =
      (typeof obj.question === 'string' && obj.question) ||
      (typeof obj.prompt === 'string' && obj.prompt) ||
      (typeof obj.text === 'string' && obj.text) ||
      formatJson(obj);
    const options = Array.isArray(obj.options) ? obj.options : [];
    return (
      <div key={index} className={styles.subItem}>
        {header && <div className={styles.subItemTitle}>{header}</div>}
        <div className={styles.prose}>{text}</div>
        {options.length > 0 && (
          <div className={styles.metaRow} style={{ marginTop: 6 }}>
            {options.map((opt, idx) => {
              const label =
                typeof opt === 'string'
                  ? opt
                  : opt && typeof opt === 'object' && 'label' in opt
                    ? String((opt as { label: unknown }).label)
                    : formatJson(opt);
              return (
                <span key={idx} className={styles.chip}>
                  {label}
                </span>
              );
            })}
          </div>
        )}
      </div>
    );
  }
  return (
    <div key={index} className={styles.subItem}>
      {String(q)}
    </div>
  );
}

function renderWebDoc(doc: unknown, index: number): React.ReactNode {
  if (doc && typeof doc === 'object') {
    const obj = doc as Record<string, unknown>;
    const title =
      (typeof obj.title === 'string' && obj.title) ||
      (typeof obj.url === 'string' && obj.url) ||
      `Result ${index + 1}`;
    const url = typeof obj.url === 'string' ? obj.url : null;
    const snippet =
      (typeof obj.snippet === 'string' && obj.snippet) ||
      (typeof obj.summary === 'string' && obj.summary) ||
      '';
    return (
      <div key={index} className={styles.subItem}>
        <div className={styles.subItemTitle}>
          {url ? (
            <a href={url} target="_blank" rel="noreferrer">
              {title}
            </a>
          ) : (
            title
          )}
        </div>
        {url && <div className={styles.subItemMeta}>{url}</div>}
        {snippet && <div className={styles.prose}>{snippet}</div>}
      </div>
    );
  }
  return (
    <div key={index} className={styles.subItem}>
      <div className={styles.prose}>{String(doc)}</div>
    </div>
  );
}

export const SessionEventCard = React.memo(function SessionEventCard({
  event,
  defaultThinkingExpanded = false,
  thinkingExpandOverride = null,
  searchMatchState = null,
  searchQuery,
  searchRegex = false,
  searchCaseSensitive = false,
  onInspectFile,
  onReviewDiff,
}: SessionEventCardProps) {
  const { t } = useI18n();
  const [thinkingOpen, setThinkingOpen] = useState<boolean>(() =>
    thinkingExpandOverride !== null && thinkingExpandOverride !== undefined
      ? thinkingExpandOverride
      : defaultThinkingExpanded,
  );
  const [copiedMsg, setCopiedMsg] = useState(false);

  useEffect(() => {
    if (thinkingExpandOverride !== null && thinkingExpandOverride !== undefined) {
      setThinkingOpen(thinkingExpandOverride);
    }
  }, [thinkingExpandOverride]);

  const highlightRegex = useMemo(
    () => buildHighlightRegex(searchQuery, searchRegex, searchCaseSensitive),
    [searchQuery, searchRegex, searchCaseSensitive],
  );
  const markClassName =
    searchMatchState === 'active' ? styles.searchMarkActive : styles.searchMark;
  const hl = (val: string) => highlightText(val, highlightRegex, markClassName);

  useEffect(() => {
    if (searchMatchState !== 'active' || !highlightRegex || event.kind !== 'thinking_and_text') {
      return;
    }
    const p = event.payload as PlannerResponsePayload;
    const thinking = typeof p.thinking === 'string' ? p.thinking : '';
    if (thinking && new RegExp(highlightRegex.source, highlightRegex.flags).test(thinking)) {
      setThinkingOpen(true);
    }
  }, [searchMatchState, highlightRegex, event.kind, event.payload]);

  const kindKey = `event.kind.${event.kind}` as I18nKey;
  const translatedKind = t(kindKey);
  const kindLabel =
    event.kind === 'tool_generic' && event.rawType && event.rawType !== 'CORTEX_STEP_TYPE_GENERIC'
      ? humanizeEnum(event.rawType)
      : translatedKind !== kindKey
        ? translatedKind
        : humanizeEnum(event.rawType || event.kind);
  const statusKey = `event.status.${event.status}` as I18nKey;
  const statusLabel = t(statusKey) !== statusKey ? t(statusKey) : event.status;
  const isUser = event.kind === 'user';
  const isOptimistic = isUser && Boolean((event.payload as UserEventPayload | undefined)?.optimistic);
  const isAssistant = event.kind === 'thinking_and_text';
  const isError = event.kind === 'error' || event.status === 'error';
  const isPending = event.status === 'pending' && !isOptimistic;

  const handleCopyPlainText = async (content: string) => {
    if (!content) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      }
      setCopiedMsg(true);
      window.setTimeout(() => setCopiedMsg(false), 1600);
    } catch {
      // Ignore clipboard failures
    }
  };

  const renderStatusNode = (alwaysVisible = false) => {
    if (!alwaysVisible && event.status === 'done') {
      return (
        <span className={styles.srOnly} data-testid={`event-status-${event.status}`}>
          {statusLabel}
        </span>
      );
    }
    return (
      <span
        className={`${styles.statusBadge} ${getStatusClass(event.status)}`}
        data-testid={`event-status-${event.status}`}
      >
        {statusLabel}
      </span>
    );
  };

  // Conversational User Bubble (Right-aligned)
  if (isUser) {
    const p = event.payload as UserEventPayload;
    const text = extractUserText(p);
    const bubbleClasses = [
      styles.userBubble,
      isOptimistic ? styles.userBubbleOptimistic : '',
      isPending ? styles.cardPending : '',
      isError ? styles.cardError : '',
      searchMatchState === 'hit' ? styles.cardSearchHit : '',
      searchMatchState === 'active' ? styles.cardSearchActive : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <article
        className={bubbleClasses}
        data-testid={`session-event-${event.seq}`}
        data-event-kind={event.kind}
        data-event-status={event.status}
        data-optimistic={isOptimistic ? 'true' : undefined}
        data-search-hit={searchMatchState || undefined}
      >
        <div className={styles.userBody}>
          {text ? (
            <MarkdownContent
              text={text}
              compact
              highlightRegex={highlightRegex}
              markClassName={markClassName}
              onInspectFile={onInspectFile}
            />
          ) : (
            <div className={styles.prose}>{t('stream.emptyMessage')}</div>
          )}
        </div>
        <footer className={styles.userMeta}>
          {isOptimistic ? (
            <span className={styles.optimisticSending} data-testid="event-status-optimistic">
              {t('composer.sending')}
            </span>
          ) : (
            <>
              {renderStatusNode(false)}
              <span className={styles.seqMuted}>#{event.seq}</span>
            </>
          )}
          {text && (
            <button
              type="button"
              className={styles.subtleActionBtn}
              onClick={() => void handleCopyPlainText(text)}
              title={t('stream.copyMessage')}
            >
              {copiedMsg ? t('stream.copiedMessage') : t('stream.copyMessage')}
            </button>
          )}
        </footer>
      </article>
    );
  }

  // Conversational Assistant Turn (Left-aligned clean prose flow)
  if (isAssistant) {
    const p = event.payload as PlannerResponsePayload;
    const thinking = typeof p.thinking === 'string' ? p.thinking : '';
    const text =
      (typeof p.modifiedResponse === 'string' && p.modifiedResponse) ||
      (typeof p.response === 'string' && p.response) ||
      (typeof p.text === 'string' && p.text) ||
      '';

    const assistantClasses = [
      styles.assistantTurn,
      isPending ? styles.cardPending : '',
      isError ? styles.cardError : '',
      searchMatchState === 'hit' ? styles.cardSearchHit : '',
      searchMatchState === 'active' ? styles.cardSearchActive : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <article
        className={assistantClasses}
        data-testid={`session-event-${event.seq}`}
        data-event-kind={event.kind}
        data-event-status={event.status}
        data-search-hit={searchMatchState || undefined}
      >
        {thinking && (
          <div className={styles.thinkingInline} data-testid="thinking-block">
            <button
              type="button"
              className={styles.thinkingPill}
              aria-expanded={thinkingOpen}
              onClick={() => setThinkingOpen((prev) => !prev)}
              data-testid="thinking-toggle"
            >
              <span className={styles.thinkingChevron}>{thinkingOpen ? '▾' : '▸'}</span>
              <span>{t('stream.thinkingLabel')}</span>
              {p.thinkingDuration !== null && p.thinkingDuration !== undefined && (
                <span className={styles.thinkingDur}>{String(p.thinkingDuration)}</span>
              )}
              <span className={styles.thinkingActionHint}>
                {thinkingOpen ? t('stream.thinkingHide') : t('stream.thinkingShow')}
              </span>
            </button>
            {thinkingOpen && (
              <pre className={styles.thinkingContent} data-testid="thinking-content">
                {hl(thinking)}
              </pre>
            )}
          </div>
        )}

        {text && (
          <div className={styles.assistantProse}>
            <MarkdownContent
              text={text}
              highlightRegex={highlightRegex}
              markClassName={markClassName}
              onInspectFile={onInspectFile}
            />
          </div>
        )}

        <footer className={styles.assistantMeta}>
          <div className={styles.assistantMetaLeft}>
            <span className={styles.seqMuted}>#{event.seq}</span>
            {renderStatusNode(false)}
          </div>
          {text && (
            <button
              type="button"
              className={styles.subtleActionBtn}
              onClick={() => void handleCopyPlainText(text)}
              title={t('stream.copyMessage')}
            >
              {copiedMsg ? t('stream.copiedMessage') : t('stream.copyMessage')}
            </button>
          )}
        </footer>
      </article>
    );
  }

  const cardClasses = [
    styles.card,
    isPending ? styles.cardPending : '',
    isError ? styles.cardError : '',
    searchMatchState === 'hit' ? styles.cardSearchHit : '',
    searchMatchState === 'active' ? styles.cardSearchActive : '',
  ]
    .filter(Boolean)
    .join(' ');

  const kindBadgeClasses = [
    styles.kindBadge,
    event.kind === 'error' ? styles.kindError : '',
  ]
    .filter(Boolean)
    .join(' ');

  const renderBody = () => {
    switch (event.kind) {
      case 'command': {
        const p = event.payload as CommandEventPayload;
        const cmd = p.commandLine || p.proposedCommandLine || event.title || '';
        const hasExit = p.exitCode !== null && p.exitCode !== undefined;
        return (
          <>
            {cmd && <pre className={styles.commandLine}>$ {hl(cmd)}</pre>}
            <div className={styles.metaRow}>
              {p.cwd && (
                <span className={styles.chip}>{t('stream.commandCwd', { cwd: p.cwd })}</span>
              )}
              {p.shellName && <span className={styles.chip}>{p.shellName}</span>}
              {hasExit && (
                <span
                  className={`${styles.chip} ${p.exitCode === 0 ? styles.chipSuccess : styles.chipDanger}`}
                  data-testid="command-exit-code"
                >
                  {t('stream.commandExit', { code: p.exitCode! })}
                </span>
              )}
            </div>
            {typeof p.combinedOutput === 'string' && p.combinedOutput.length > 0 && (
              <pre className={styles.codeBlock} data-testid="command-output">
                {hl(p.combinedOutput)}
              </pre>
            )}
          </>
        );
      }

      case 'file_view': {
        const p = event.payload as FileViewPayload;
        const filePath = p.absolutePathUri || event.title || '';
        const hasRange =
          p.startLine !== null &&
          p.startLine !== undefined &&
          p.endLine !== null &&
          p.endLine !== undefined;
        return (
          <>
            <div className={styles.metaRow}>
              {filePath &&
                (onInspectFile ? (
                  <button
                    type="button"
                    className={styles.fileBtn}
                    onClick={() => onInspectFile(filePath)}
                  >
                    {filePath}
                  </button>
                ) : (
                  <span className={styles.chip}>{filePath}</span>
                ))}
              {hasRange && (
                <span className={styles.chip}>
                  {t('stream.fileViewLines', { start: p.startLine!, end: p.endLine! })}
                </span>
              )}
              {p.numLines !== null && p.numLines !== undefined && (
                <span className={styles.chip}>
                  {t('stream.fileLinesCount', { count: p.numLines })}
                </span>
              )}
              {p.numBytes !== null && p.numBytes !== undefined && (
                <span className={styles.chip}>{p.numBytes} B</span>
              )}
            </div>
            {typeof p.content === 'string' && p.content.length > 0 && (
              <pre className={styles.codeBlock}>{hl(p.content)}</pre>
            )}
          </>
        );
      }

      case 'code_action': {
        const p = event.payload as CodeActionPayload;
        const spec = p.actionSpec;
        const targetFile = extractCodeActionTargetFile(p, event.title);
        const { additions, deletions } = extractCodeActionDiffStats(p);
        const diffLines = extractCodeActionDiffLines(p);
        const hasRawDetails = Boolean(spec || p.actionResult || p.diffStats);

        return (
          <>
            {spec?.description && (
              <div className={styles.prose}>{hl(String(spec.description))}</div>
            )}
            <div className={styles.metaRow}>
              {targetFile &&
                (onInspectFile ? (
                  <button
                    type="button"
                    className={styles.fileBtn}
                    onClick={() => onInspectFile(targetFile)}
                  >
                    {targetFile}
                  </button>
                ) : (
                  <span className={styles.chip}>{targetFile}</span>
                ))}
              {additions !== null && (
                <span className={`${styles.chip} ${styles.chipAdd}`}>+{additions}</span>
              )}
              {deletions !== null && (
                <span className={`${styles.chip} ${styles.chipDel}`}>-{deletions}</span>
              )}
              {onReviewDiff && (
                <button
                  type="button"
                  className={styles.reviewCtaBtn}
                  onClick={() => onReviewDiff(targetFile || undefined)}
                  data-testid={`review-diff-btn-${event.seq}`}
                >
                  {t('review.viewInDiff')}
                </button>
              )}
            </div>
            {diffLines.length > 0 && (
              <div className={styles.inlineDiffBox} data-testid={`code-action-diff-${event.seq}`}>
                {diffLines.map((line, idx) => (
                  <div
                    key={idx}
                    className={`${styles.inlineDiffLine} ${
                      line.kind === 'add'
                        ? styles.inlineDiffAdd
                        : line.kind === 'del'
                          ? styles.inlineDiffDel
                          : line.kind === 'hunk'
                            ? styles.inlineDiffHunk
                            : ''
                    }`}
                  >
                    <span className={styles.inlineDiffPrefix}>
                      {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                    </span>
                    <span className={styles.inlineDiffText}>{line.text || ' '}</span>
                  </div>
                ))}
              </div>
            )}
            {hasRawDetails && (
              <details className={styles.rawDetails}>
                <summary className={styles.rawSummary}>{t('review.rawPayload')}</summary>
                <div className={styles.rawBody}>
                  {p.diffStats && additions === null && deletions === null && (
                    <div>
                      <div className={styles.sectionLabel}>{t('stream.diffStats')}</div>
                      <pre className={styles.codeBlock}>{formatJson(p.diffStats)}</pre>
                    </div>
                  )}
                  {spec && (
                    <div>
                      <div className={styles.sectionLabel}>{t('stream.actionSpec')}</div>
                      <pre className={styles.codeBlock}>{formatJson(spec)}</pre>
                    </div>
                  )}
                  {p.actionResult && (
                    <div>
                      <div className={styles.sectionLabel}>{t('stream.actionResult')}</div>
                      <pre className={styles.codeBlock}>{formatJson(p.actionResult)}</pre>
                    </div>
                  )}
                </div>
              </details>
            )}
          </>
        );
      }

      case 'ask_question': {
        const p = event.payload as AskQuestionPayload;
        const questions = Array.isArray(p.questions) ? p.questions : [];
        const completed = Array.isArray(p.completedInteractions) ? p.completedInteractions : [];
        return (
          <>
            {questions.length > 0 && (
              <div className={styles.subList}>{questions.map(renderQuestionItem)}</div>
            )}
            {completed.length > 0 && (
              <div>
                <div className={styles.sectionLabel}>{t('stream.completedInteractions')}</div>
                <pre className={styles.codeBlock}>{formatJson(completed)}</pre>
              </div>
            )}
            {questions.length === 0 && completed.length === 0 && (
              <div className={styles.prose}>{t('stream.noQuestionDetails')}</div>
            )}
          </>
        );
      }

      case 'web_search': {
        const p = event.payload as WebSearchPayload;
        const docs = Array.isArray(p.webDocuments) ? p.webDocuments : [];
        return (
          <>
            <div className={styles.metaRow}>
              {p.query && (
                <span className={styles.chip}>{t('stream.queryPrefix', { query: p.query })}</span>
              )}
              {p.searchType && <span className={styles.chip}>{p.searchType}</span>}
              {docs.length > 0 && (
                <span className={styles.chip}>
                  {t('stream.sourcesCount', { count: docs.length })}
                </span>
              )}
            </div>
            {p.summary && (
              <MarkdownContent
                text={p.summary}
                compact
                highlightRegex={highlightRegex}
                markClassName={markClassName}
                onInspectFile={onInspectFile}
              />
            )}
            {docs.length > 0 && <div className={styles.subList}>{docs.map(renderWebDoc)}</div>}
          </>
        );
      }

      case 'checkpoint': {
        const p = event.payload as CheckpointPayload;
        const snapshots = Array.isArray(p.artifactSnapshots) ? p.artifactSnapshots : [];
        const requests = Array.isArray(p.capturedUserRequests) ? p.capturedUserRequests : [];
        return (
          <>
            {p.sessionSummary && (
              <MarkdownContent
                text={p.sessionSummary}
                compact
                highlightRegex={highlightRegex}
                markClassName={markClassName}
                onInspectFile={onInspectFile}
              />
            )}
            <div className={styles.metaRow}>
              {p.includedStepIndexEnd !== null && p.includedStepIndexEnd !== undefined && (
                <span className={styles.chip}>
                  {t('stream.throughStep', { step: p.includedStepIndexEnd })}
                </span>
              )}
              {typeof p.totalSubagentCount === 'number' && p.totalSubagentCount > 0 && (
                <span className={styles.chip}>
                  {t('stream.subagentsCount', { count: p.totalSubagentCount })}
                </span>
              )}
              {snapshots.length > 0 && (
                <span className={styles.chip}>
                  {t('stream.artifactsCount', { count: snapshots.length })}
                </span>
              )}
              {requests.length > 0 && (
                <span className={styles.chip}>
                  {t('stream.capturedRequestsCount', { count: requests.length })}
                </span>
              )}
            </div>
          </>
        );
      }

      case 'system': {
        const p = event.payload as SystemMessagePayload;
        return (
          <>
            {p.eventType && (
              <div className={styles.metaRow}>
                <span className={styles.chip}>{p.eventType}</span>
              </div>
            )}
            {p.message && <div className={styles.prose}>{hl(p.message)}</div>}
            {p.renderInfo !== null && p.renderInfo !== undefined && (
              <pre className={styles.codeBlock}>{hl(formatJson(p.renderInfo))}</pre>
            )}
          </>
        );
      }

      case 'tool_generic': {
        const p = event.payload as GenericToolPayload;
        const hasArgs = p.args !== null && p.args !== undefined;
        const hasResult = p.result !== null && p.result !== undefined;
        return (
          <>
            {hasArgs && (
              <div>
                <div className={styles.sectionLabel}>{t('stream.argsLabel')}</div>
                <pre className={styles.codeBlock}>{hl(formatJson(p.args))}</pre>
              </div>
            )}
            {hasResult && (
              <div>
                <div className={styles.sectionLabel}>{t('stream.resultLabel')}</div>
                <pre className={styles.codeBlock}>{hl(formatJson(p.result))}</pre>
              </div>
            )}
            {!hasArgs && !hasResult && (
              <pre className={styles.codeBlock}>{hl(formatJson(p))}</pre>
            )}
          </>
        );
      }

      case 'error': {
        const p = event.payload as ErrorMessagePayload;
        const errText = formatJson(p.error ?? p);
        return (
          <pre className={styles.codeBlock} data-testid="error-payload">
            {errText ? hl(errText) : t('stream.unknownError')}
          </pre>
        );
      }

      default:
        return <pre className={styles.codeBlock}>{hl(formatJson(event.payload))}</pre>;
    }
  };

  return (
    <article
      className={cardClasses}
      data-testid={`session-event-${event.seq}`}
      data-event-kind={event.kind}
      data-event-status={event.status}
      data-search-hit={searchMatchState || undefined}
    >
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.seq}>#{event.seq}</span>
          <span className={kindBadgeClasses}>{kindLabel}</span>
          {event.title && (
            <span className={styles.title} title={event.title}>
              {hl(event.title)}
            </span>
          )}
        </div>
        {renderStatusNode(event.kind !== 'error')}
      </header>

      {isPending && (
        <div
          className={styles.pendingNotice}
          role="status"
          data-testid="pending-approval-notice"
        >
          <span className={styles.pendingNoticeTitle}>{t('event.status.pending')}</span>
          <span>{t('stream.pendingReadOnly')}</span>
        </div>
      )}

      <div className={styles.body}>{renderBody()}</div>
    </article>
  );
});
