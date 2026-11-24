import React, { useMemo } from 'react';
import { humanizeEnum, useI18n, type I18nKey, type TranslateFn } from '../i18n';
import type { SessionEvent, SessionEventStatus } from '../types';
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
  groupExpanded: boolean;
  expandedSeqs: ReadonlySet<number>;
  onToggleGroup: (groupId: string) => void;
  onToggleItem: (seq: number) => void;
  onInspectFile?: (filePath: string) => void;
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
  groupExpanded,
  expandedSeqs,
  onToggleGroup,
  onToggleItem,
  onInspectFile,
}: ToolCallGroupCardProps) {
  const { t } = useI18n();

  const firstSeq = events[0]?.seq ?? 0;
  const lastSeq = events[events.length - 1]?.seq ?? firstSeq;
  const seqRange = events.length === 1 ? `#${firstSeq}` : `#${firstSeq}–#${lastSeq}`;

  const derivedSummary = useMemo(() => {
    if (
      thoughtCount !== undefined &&
      toolCount !== undefined &&
      totalThinkingSeconds !== undefined
    ) {
      return { thoughtCount, toolCount, totalThinkingSeconds };
    }
    return summarizeWorkGroup(events);
  }, [events, thoughtCount, toolCount, totalThinkingSeconds]);

  const resolvedThoughtCount = thoughtCount ?? derivedSummary.thoughtCount;
  const resolvedToolCount = toolCount ?? derivedSummary.toolCount;
  const resolvedThinkingSeconds = totalThinkingSeconds ?? derivedSummary.totalThinkingSeconds;

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
          <span className={styles.seqRange}>{seqRange}</span>
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

            return (
              <div
                key={ev.seq}
                className={styles.briefItemWrap}
                data-testid={`tool-item-${ev.seq}`}
                data-expanded={itemExpanded ? 'true' : 'false'}
              >
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
                    {brief.hint && <span className={styles.hintChip}>{brief.hint}</span>}
                    <span className={`${styles.statusDot} ${getStatusPillClass(ev.status)}`}>
                      {statusText}
                    </span>
                  </div>
                </button>

                {itemExpanded && (
                  <div
                    className={styles.itemDetail}
                    data-testid={`tool-item-detail-${ev.seq}`}
                  >
                    <SessionEventCard
                      event={ev}
                      defaultThinkingExpanded={isThought}
                      onInspectFile={onInspectFile}
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
