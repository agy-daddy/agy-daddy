import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import type { SessionEvent, UserEventPayload } from '../types';
import {
  findMatchingEventSeqs,
  serializeEventsToHtml,
  serializeEventsToMarkdown,
} from './ChatNavDock';
import { SessionEventCard } from './SessionEventCard';
import { partitionTimelineEvents } from './messageVisibility';
import { groupTimelineEvents, type TimelineEntry } from './timelineGrouping';
import { ToolCallGroupCard } from './ToolCallGroupCard';
import { useVirtualList } from './useVirtualList';
import styles from './SessionStream.module.css';

export { serializeEventsToHtml, serializeEventsToMarkdown };

export interface SessionStreamProps {
  events: SessionEvent[];
  sessionId?: string | null;
  loading?: boolean;
  error?: string | null;
  emptyTitle?: string;
  emptyDescription?: string;
  onInspectFile?: (filePath: string) => void;
  onReviewDiff?: (filePath?: string) => void;
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  thinkingExpandOverride?: boolean | null;
  searchQuery?: string;
  searchRegex?: boolean;
  searchCaseSensitive?: boolean;
  activeSearchMatchSeq?: number | null;
  scrollToSeq?: number | null;
  scrollToSeqNonce?: number;
}

const AUTO_SCROLL_THRESHOLD_PX = 64;
const EMPTY_SEQ_SET: ReadonlySet<number> = new Set<number>();

function computeLightweightEventFingerprint(ev: SessionEvent | null): string {
  if (!ev) return '';
  const p = ev.payload || {};
  const textLen = typeof p.text === 'string' ? p.text.length : 0;
  const respLen = typeof p.response === 'string' ? p.response.length : 0;
  const modLen = typeof p.modifiedResponse === 'string' ? p.modifiedResponse.length : 0;
  const thinkLen = typeof p.thinking === 'string' ? p.thinking.length : 0;
  const outLen = typeof p.combinedOutput === 'string' ? p.combinedOutput.length : 0;
  return `${ev.seq}:${ev.status}:${ev.kind}:${textLen}:${respLen}:${modLen}:${thinkLen}:${outLen}`;
}

function estimateEntryHeight(entry: TimelineEntry): number {
  if (entry.type === 'tool_group') {
    return 44;
  }
  const ev = entry.event;
  if (ev.kind === 'user') return 72;
  if (ev.kind === 'thinking_and_text') return 140;
  return 96;
}

export const SessionStream = React.memo(function SessionStream({
  events,
  sessionId,
  loading = false,
  error = null,
  emptyTitle,
  emptyDescription,
  onInspectFile,
  onReviewDiff,
  scrollContainerRef,
  thinkingExpandOverride = null,
  searchQuery,
  searchRegex = false,
  searchCaseSensitive = false,
  activeSearchMatchSeq = null,
  scrollToSeq = null,
  scrollToSeqNonce = 0,
}: SessionStreamProps) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const setScrollAreaRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      if (scrollContainerRef && 'current' in scrollContainerRef) {
        (scrollContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    },
    [scrollContainerRef],
  );
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const stickyBottomRef = useRef<boolean>(true);
  const [showHiddenEvents, setShowHiddenEvents] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set());
  const [expandedSeqsByGroup, setExpandedSeqsByGroup] = useState<Record<string, Set<number>>>({});

  const resolvedEmptyTitle = emptyTitle ?? t('stream.emptyTitleDefault');
  const resolvedEmptyDesc = emptyDescription ?? t('stream.emptyDescDefault');

  const { visibleEvents, hiddenCount } = useMemo(
    () => partitionTimelineEvents(events, showHiddenEvents),
    [events, showHiddenEvents],
  );
  const prevCountRef = useRef<number>(visibleEvents.length);

  const timelineEntries = useMemo(() => groupTimelineEvents(visibleEvents), [visibleEvents]);

  const { matchSeqs: searchMatchSeqs } = useMemo(
    () =>
      findMatchingEventSeqs(events, searchQuery || '', {
        regex: searchRegex,
        caseSensitive: searchCaseSensitive,
        includeHidden: showHiddenEvents,
      }),
    [events, searchQuery, searchRegex, searchCaseSensitive, showHiddenEvents],
  );
  const searchMatchSeqSet = useMemo(() => new Set<number>(searchMatchSeqs), [searchMatchSeqs]);

  const seqToGroupId = useMemo(() => {
    const map = new Map<number, string>();
    for (const entry of timelineEntries) {
      if (entry.type === 'tool_group') {
        for (const ev of entry.events) {
          map.set(ev.seq, entry.id);
        }
      }
    }
    return map;
  }, [timelineEntries]);

  useEffect(() => {
    if (thinkingExpandOverride === true) {
      const nextGroupIds = new Set<string>();
      const nextSeqsByGroup: Record<string, Set<number>> = {};
      for (const entry of timelineEntries) {
        if (entry.type === 'tool_group' && entry.thoughtCount > 0) {
          nextGroupIds.add(entry.id);
          const thoughtSeqs = new Set<number>();
          for (const ev of entry.events) {
            if (ev.kind === 'thinking_and_text') {
              thoughtSeqs.add(ev.seq);
            }
          }
          if (thoughtSeqs.size > 0) {
            nextSeqsByGroup[entry.id] = thoughtSeqs;
          }
        }
      }
      if (nextGroupIds.size > 0) {
        setExpandedGroupIds((prev) => new Set([...prev, ...nextGroupIds]));
        setExpandedSeqsByGroup((prev) => {
          const merged = { ...prev };
          for (const [gid, seqSet] of Object.entries(nextSeqsByGroup)) {
            merged[gid] = new Set([...(merged[gid] || []), ...seqSet]);
          }
          return merged;
        });
      }
    } else if (thinkingExpandOverride === false) {
      setExpandedGroupIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        let changed = false;
        for (const entry of timelineEntries) {
          if (entry.type === 'tool_group' && entry.toolCount === 0 && next.has(entry.id)) {
            next.delete(entry.id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      setExpandedSeqsByGroup((prev) => {
        let changed = false;
        const next: Record<string, Set<number>> = {};
        for (const entry of timelineEntries) {
          if (entry.type !== 'tool_group') continue;
          const existing = prev[entry.id];
          if (!existing || existing.size === 0) continue;
          const filtered = new Set<number>();
          for (const ev of entry.events) {
            if (existing.has(ev.seq) && ev.kind !== 'thinking_and_text') {
              filtered.add(ev.seq);
            } else if (existing.has(ev.seq)) {
              changed = true;
            }
          }
          if (filtered.size > 0) next[entry.id] = filtered;
        }
        return changed ? next : prev;
      });
    }
  }, [thinkingExpandOverride]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeSearchMatchSeq === null || activeSearchMatchSeq === undefined) return;
    const gid = seqToGroupId.get(activeSearchMatchSeq);
    if (gid) {
      setExpandedGroupIds((prev) => {
        if (prev.has(gid)) return prev;
        const next = new Set(prev);
        next.add(gid);
        return next;
      });
      setExpandedSeqsByGroup((prev) => {
        const cur = prev[gid];
        if (cur?.has(activeSearchMatchSeq)) return prev;
        const nextSet = new Set(cur ? cur : []);
        nextSet.add(activeSearchMatchSeq);
        return { ...prev, [gid]: nextSet };
      });
    }
  }, [activeSearchMatchSeq, seqToGroupId]);

  const handleToggleGroup = useCallback((groupId: string) => {
    setExpandedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const handleToggleItem = useCallback(
    (seq: number) => {
      const groupId = seqToGroupId.get(seq) || '__ungrouped__';
      setExpandedSeqsByGroup((prev) => {
        const current = prev[groupId];
        const nextSet = new Set(current ? current : []);
        if (nextSet.has(seq)) {
          nextSet.delete(seq);
        } else {
          nextSet.add(seq);
        }
        return { ...prev, [groupId]: nextSet };
      });
    },
    [seqToGroupId],
  );

  const getEntryKey = useCallback((entry: TimelineEntry) => entry.id, []);

  const { visibleItems, topSpacerHeight, bottomSpacerHeight, measureRef } = useVirtualList({
    items: timelineEntries,
    getKey: getEntryKey,
    scrollRef,
    estimateHeight: estimateEntryHeight,
    gap: 12,
    overscanCount: 6,
    virtualizeThreshold: 20,
  });

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    bottomRef.current?.scrollIntoView?.({ block: 'end' });
    stickyBottomRef.current = true;
    setShowJumpToLatest(false);
  }, []);

  useEffect(() => {
    stickyBottomRef.current = true;
    prevCountRef.current = 0;
    setShowJumpToLatest(false);
    setShowHiddenEvents(false);
    setExpandedGroupIds(new Set());
    setExpandedSeqsByGroup({});
  }, [sessionId]);

  const lastEvent = visibleEvents.length > 0 ? visibleEvents[visibleEvents.length - 1] : null;
  const lastEventFingerprint = computeLightweightEventFingerprint(lastEvent);
  const isLastEventOptimistic =
    lastEvent?.kind === 'user' &&
    Boolean((lastEvent.payload as UserEventPayload | undefined)?.optimistic);

  useEffect(() => {
    const grew = visibleEvents.length > prevCountRef.current;
    prevCountRef.current = visibleEvents.length;

    if (visibleEvents.length === 0) {
      stickyBottomRef.current = true;
      setShowJumpToLatest(false);
      return;
    }

    if (stickyBottomRef.current || (grew && isLastEventOptimistic)) {
      scrollToBottom();
    } else if (grew) {
      setShowJumpToLatest(true);
    }
  }, [visibleEvents.length, lastEventFingerprint, isLastEventOptimistic, scrollToBottom]);

  const jumpTargetSeq = scrollToSeq ?? activeSearchMatchSeq ?? null;

  useEffect(() => {
    if (jumpTargetSeq === null || jumpTargetSeq === undefined) return;
    const container = scrollRef.current;
    if (!container) return;
    stickyBottomRef.current = false;

    const scrollToMountedEl = (): boolean => {
      const directEl = container.querySelector<HTMLElement>(
        `[data-testid="session-event-${jumpTargetSeq}"]`,
      );
      if (directEl && typeof directEl.scrollIntoView === 'function') {
        try {
          directEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch {
          directEl.scrollIntoView();
        }
        return true;
      }
      return false;
    };

    if (scrollToMountedEl()) return;

    const entryIndex = timelineEntries.findIndex((entry) =>
      entry.type === 'tool_group'
        ? entry.events.some((ev) => ev.seq === jumpTargetSeq)
        : entry.event.seq === jumpTargetSeq,
    );
    if (entryIndex >= 0) {
      let approxTop = 0;
      for (let i = 0; i < entryIndex; i++) {
        approxTop += estimateEntryHeight(timelineEntries[i]) + 12;
      }
      if (typeof container.scrollTo === 'function') {
        try {
          container.scrollTo({ top: approxTop, behavior: 'smooth' });
        } catch {
          container.scrollTop = approxTop;
        }
      } else {
        container.scrollTop = approxTop;
      }
      const timer = setTimeout(() => {
        scrollToMountedEl();
      }, 30);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [jumpTargetSeq, scrollToSeqNonce, timelineEntries]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceFromBottom <= AUTO_SCROLL_THRESHOLD_PX;
    stickyBottomRef.current = isNearBottom;
    if (isNearBottom) {
      setShowJumpToLatest(false);
    }
  }, []);

  return (
    <div className={styles.wrapper} data-testid="session-stream">
      <div
        ref={setScrollAreaRef}
        className={styles.scrollArea}
        onScroll={handleScroll}
        role="log"
        aria-label="Session timeline"
        aria-live="polite"
        data-testid="session-stream-scroll"
      >
        {error && (
          <div className={styles.errorBanner} role="alert" data-testid="session-stream-error">
            {error}
          </div>
        )}

        {hiddenCount > 0 && (
          <div className={styles.hiddenEventsBar}>
            <button
              type="button"
              className={styles.hiddenEventsToggle}
              onClick={() => setShowHiddenEvents((prev) => !prev)}
              aria-pressed={showHiddenEvents}
              data-testid="toggle-hidden-system-events"
            >
              {showHiddenEvents
                ? t('stream.hiddenEventsHide', { count: hiddenCount })
                : t('stream.hiddenEventsShow', { count: hiddenCount })}
            </button>
          </div>
        )}

        {loading && events.length === 0 ? (
          <div className={styles.stateCard} data-testid="session-stream-loading">
            <h3 className={styles.stateTitle}>{t('stream.loadingTitle')}</h3>
            <p className={styles.stateDesc}>{t('stream.loadingDesc')}</p>
          </div>
        ) : events.length === 0 || (visibleEvents.length === 0 && !loading) ? (
          <div className={styles.stateCard} data-testid="session-stream-empty">
            <h3 className={styles.stateTitle}>{resolvedEmptyTitle}</h3>
            <p className={styles.stateDesc}>{resolvedEmptyDesc}</p>
          </div>
        ) : (
          <div className={styles.timeline} data-testid="session-stream-timeline">
            {topSpacerHeight > 0 && (
              <div style={{ height: `${topSpacerHeight}px` }} aria-hidden="true" />
            )}
            {visibleItems.map(({ item, key }) => {
              const groupSearchState =
                item.type === 'tool_group'
                  ? item.events.some((ev) => ev.seq === activeSearchMatchSeq)
                    ? 'active'
                    : item.events.some((ev) => searchMatchSeqSet.has(ev.seq))
                      ? 'hit'
                      : null
                  : null;
              const slotClassName = [
                styles.entrySlot,
                groupSearchState === 'hit' ? styles.entrySearchHit : '',
                groupSearchState === 'active' ? styles.entrySearchActive : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div
                  key={key}
                  ref={measureRef(key)}
                  className={slotClassName}
                  data-search-hit={groupSearchState || undefined}
                >
                  {item.type === 'tool_group' ? (
                    <ToolCallGroupCard
                      groupId={item.id}
                      events={item.events}
                      thoughtCount={item.thoughtCount}
                      toolCount={item.toolCount}
                      totalThinkingSeconds={item.totalThinkingSeconds}
                      editCount={item.editCount}
                      totalAdditions={item.totalAdditions}
                      totalDeletions={item.totalDeletions}
                      groupExpanded={expandedGroupIds.has(item.id)}
                      expandedSeqs={expandedSeqsByGroup[item.id] ?? EMPTY_SEQ_SET}
                      onToggleGroup={handleToggleGroup}
                      onToggleItem={handleToggleItem}
                      onInspectFile={onInspectFile}
                      onReviewDiff={onReviewDiff}
                    />
                  ) : (
                    <SessionEventCard
                      event={item.event}
                      thinkingExpandOverride={thinkingExpandOverride}
                      searchMatchState={
                        activeSearchMatchSeq === item.event.seq
                          ? 'active'
                          : searchMatchSeqSet.has(item.event.seq)
                            ? 'hit'
                            : null
                      }
                      searchQuery={searchQuery}
                      searchRegex={searchRegex}
                      searchCaseSensitive={searchCaseSensitive}
                      onInspectFile={onInspectFile}
                      onReviewDiff={onReviewDiff}
                    />
                  )}
                </div>
              );
            })}
            {bottomSpacerHeight > 0 && (
              <div style={{ height: `${bottomSpacerHeight}px` }} aria-hidden="true" />
            )}
            {loading && (
              <div className={styles.loadingInline} data-testid="session-stream-syncing">
                {t('stream.syncing')}
              </div>
            )}
            <div ref={bottomRef} aria-hidden="true" />
          </div>
        )}
      </div>

      {showJumpToLatest && (
        <button
          type="button"
          className={styles.jumpBtn}
          onClick={scrollToBottom}
          data-testid="jump-to-latest-btn"
        >
          {t('stream.jumpToLatest')}
        </button>
      )}
    </div>
  );
});
