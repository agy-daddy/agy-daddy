import React, { useMemo } from 'react';
import { humanizeEnum, useI18n, type I18nKey, type TranslateFn } from '../i18n';
import type { CodeActionPayload, SessionEvent, SessionEventStatus } from '../types';
import { extractCodeActionTargetFile } from './codeActionUtils';
import { SessionEventCard } from './SessionEventCard';
import {
  formatThinkingSeconds,
  formatToolBrief,
  summarizeWorkGroup,
} from './timelineGrouping';
import styles from './ToolCallGroupCard.module.css';

function formatEventStatus(status: SessionEventStatus, t: TranslateFn): string {
  const statusKey = `event.status.${status}` as I18nKey;
  const translated = t(statusKey);
  return translated !== statusKey ? translated : humanizeEnum(status);
}

export interface ToolCallGroupCardProps {
  groupId: string;
  events: SessionEvent[];
  thoughtCount?: number;
  toolCount?: number;
  totalThinkingSeconds?: number;
  editCount?: number;
  totalAdditions?: number;
  totalDeletions?: number;
  groupExpanded: boolean;
  expandedSeqs: ReadonlySet<number>;
  onToggleGroup: (groupId: string) => void;
  onToggleItem: (seq: number) => void;
  onInspectFile?: (filePath: string) => void;
  onReviewDiff?: (filePath?: string) => void;
}

function summarizeGroupStatus(events: SessionEvent[]): SessionEventStatus | null {
  if (events.some((e) => e.status === 'error')) return 'error';
  if (events.some((e) => e.status === 'pending')) return 'pending';
  if (events.some((e) => e.status === 'running' || e.status === 'generating')) return 'running';
  return null;
}

function getStatusPillClass(status: SessionEventStatus): string {
  switch (status) {
    case 'error':
      return styles.statusError;
    case 'pending':
      return styles.statusPending;
    case 'running':
    case 'generating':
      return styles.statusRunning;
    default:
      return '';
  }
}

export const ToolCallGroupCard = React.memo(function ToolCallGroupCard({
  groupId,
  events,
  thoughtCount,
  toolCount,
  totalThinkingSeconds,
  editCount,
  totalAdditions,
  totalDeletions,
  groupExpanded,
  expandedSeqs,
  onToggleGroup,
  onToggleItem,
  onInspectFile,
  onReviewDiff,
}: ToolCallGroupCardProps) {
  const { t } = useI18n();

  const derivedSummary = useMemo(() => summarizeWorkGroup(events), [events]);

  const resolvedThoughtCount = thoughtCount ?? derivedSummary.thoughtCount;
  const resolvedToolCount = toolCount ?? derivedSummary.toolCount;
  const resolvedThinkingSeconds = totalThinkingSeconds ?? derivedSummary.totalThinkingSeconds;
  const resolvedEditCount = editCount ?? derivedSummary.editCount ?? 0;
  const resolvedAdditions = totalAdditions ?? derivedSummary.totalAdditions ?? 0;
  const resolvedDeletions = totalDeletions ?? derivedSummary.totalDeletions ?? 0;

  const countLabel =
    resolvedThoughtCount > 0 && resolvedToolCount > 0
      ? t('tools.workSummaryMixed', {
          thoughts: resolvedThoughtCount,
          tools: resolvedToolCount,
        })
      : resolvedThoughtCount > 0 && resolvedToolCount === 0
        ? t('tools.workSummaryThoughtsOnly', { count: resolvedThoughtCount })
        : events.length === 1
          ? t('tools.groupSingle')
          : t('tools.groupPlural', { count: events.length });

  const durationLabel =
    resolvedThinkingSeconds > 0
      ? t('tools.thoughtDuration', { sec: formatThinkingSeconds(resolvedThinkingSeconds) })
      : null;

  const aggregateStatus = useMemo(() => summarizeGroupStatus(events), [events]);

  const previewText = useMemo(() => {
    const sample = events.slice(0, 2).map((ev) => formatToolBrief(ev, t).brief);
    return sample.join(' · ');
  }, [events, t]);

  return (
    <div
      className={`${styles.group} ${groupExpanded ? styles.groupExpanded : ''}`}
      data-testid={`tool-group-${groupId}`}
      data-expanded={groupExpanded ? 'true' : 'false'}
      data-group-size={events.length}
      data-thought-count={resolvedThoughtCount}
      data-tool-count={resolvedToolCount}
    >
      <button
        type="button"
        className={styles.summaryBtn}
        aria-expanded={groupExpanded}
        onClick={() => onToggleGroup(groupId)}
        data-testid={`tool-group-toggle-${groupId}`}
      >
        <div className={styles.summaryLeft}>
          <span className={styles.chevron} aria-hidden="true">
            {groupExpanded ? '▾' : '▸'}
          </span>
          <span className={styles.countBadge}>{countLabel}</span>
          {durationLabel && (
            <span className={styles.durationChip} data-testid="work-group-duration">
              {durationLabel}
            </span>
          )}
          {resolvedEditCount > 0 && (
            <span className={styles.editSummaryChip}>
              {t('review.groupEdits', { count: resolvedEditCount })}
              {(resolvedAdditions > 0 || resolvedDeletions > 0) && (
                <>
                  {' '}
                  <span className={styles.statAdd}>+{resolvedAdditions}</span>
                  {' '}
                  <span className={styles.statDel}>-{resolvedDeletions}</span>
                </>
              )}
            </span>
          )}
          {!groupExpanded && (
            <span className={styles.previewText} title={previewText}>
              {previewText}
            </span>
          )}
        </div>
        <div className={styles.summaryRight}>
          {aggregateStatus && (
            <span className={`${styles.statusDot} ${getStatusPillClass(aggregateStatus)}`}>
              {formatEventStatus(aggregateStatus, t)}
            </span>
          )}
          <span className={styles.actionLabel}>
            {groupExpanded ? t('tools.collapseAll') : t('tools.expandAll')}
          </span>
        </div>
      </button>

      {groupExpanded && (
        <div className={styles.briefList} data-testid={`tool-group-list-${groupId}`}>
          {events.map((ev) => {
            const brief = formatToolBrief(ev, t);
            const itemExpanded = expandedSeqs.has(ev.seq);
            const statusText = formatEventStatus(ev.status, t);
            const isThought = ev.kind === 'thinking_and_text';
            const isCodeAction = ev.kind === 'code_action';
            const editTargetFile = isCodeAction
              ? extractCodeActionTargetFile(ev.payload as CodeActionPayload, ev.title)
              : '';

            return (
              <div
                key={ev.seq}
                className={styles.briefItemWrap}
                data-testid={`tool-item-${ev.seq}`}
                data-expanded={itemExpanded ? 'true' : 'false'}
              >
                <div className={styles.briefRowContainer}>
                  <button
                    type="button"
                    className={styles.briefRow}
                    aria-expanded={itemExpanded}
                    onClick={() => onToggleItem(ev.seq)}
                    data-testid={`tool-item-toggle-${ev.seq}`}
                  >
                    <div className={styles.briefRowLeft}>
                      <span className={styles.chevron} aria-hidden="true">
                        {itemExpanded ? '▾' : '▸'}
                      </span>
                      <span className={styles.briefIcon} aria-hidden="true">
                        {brief.icon}
                      </span>
                      <span className={styles.briefSeq}>#{ev.seq}</span>
                      <span
                        className={`${styles.briefText} ${isThought ? styles.briefTextThought : ''}`}
                        title={brief.brief}
                      >
                        {brief.brief}
                      </span>
                    </div>
                    <div className={styles.briefRowRight}>
                      {brief.hint && (
                        <span className={`${styles.hintChip} ${isCodeAction ? styles.hintChipDiff : ''}`}>
                          {brief.hint}
                        </span>
                      )}
                      {ev.status !== 'done' && (
                        <span className={`${styles.statusDot} ${getStatusPillClass(ev.status)}`}>
                          {statusText}
                        </span>
                      )}
                    </div>
                  </button>
                  {isCodeAction && onReviewDiff && editTargetFile && (
                    <button
                      type="button"
                      className={styles.inlineReviewBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        onReviewDiff(editTargetFile);
                      }}
                      title={t('review.viewInDiff')}
                    >
                      {t('review.openDiff')}
                    </button>
                  )}
                </div>

                {itemExpanded && (
                  <div
                    className={styles.itemDetail}
                    data-testid={`tool-item-detail-${ev.seq}`}
                  >
                    <SessionEventCard
                      event={ev}
                      defaultThinkingExpanded={isThought}
                      onInspectFile={onInspectFile}
                      onReviewDiff={onReviewDiff}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
