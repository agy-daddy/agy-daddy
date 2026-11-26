import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import type { PermissionLevel, QueuedMessage, SessionEvent } from '../types';
import { buildDisplayTimeline, type DisplayTimelineItem } from './chatFilter';
import { StepCard } from './StepCard';
import { ToolGroupCard } from './ToolGroupCard';
import styles from './VirtualChatList.module.css';

export interface VirtualChatListProps {
  events: SessionEvent[];
  loading?: boolean;
  activeSessionId?: string;
  permissionLevel?: PermissionLevel;
  hideSystemEvents?: boolean;
  thinkingExpandVersion?: number;
  thinkingExpandTarget?: boolean | null;
  searchQuery?: string;
  searchRegex?: boolean;
  searchCaseSensitive?: boolean;
  currentMatchSeq?: number | null;
  jumpTarget?: { seq: number; nonce: number } | null;
  scrollBottomNonce?: number;
  scrollTopNonce?: number;
  onInspectFile?: (filePath: string) => void;
  onViewDiffFile?: (filePath: string) => void;
  onApprove?: (seq: number, decision: 'allow' | 'deny') => Promise<void> | void;
  onAnswer?: (seq: number, answers: unknown) => Promise<void> | void;
  queue?: QueuedMessage[];
  onSteerQueueItem?: (id: string) => Promise<void> | void;
  onRemoveQueueItem?: (id: string) => Promise<void> | void;
  onEditQueueItem?: (id: string) => void;
  onRetryQueueItem?: (id: string) => Promise<void> | void;
}

const DEFAULT_ESTIMATED_HEIGHT = 112;
const OVERSCAN = 6;
const VIRTUALIZE_THRESHOLD = 40;

function getItemKey(item: DisplayTimelineItem): string {
  return item.type === 'tool_group' ? item.id : `step-${item.event.seq}`;
}

function getTailSignature(items: DisplayTimelineItem[]): string {
  if (items.length === 0) return '';
  const last = items[items.length - 1];
  if (last.type === 'tool_group') {
    const tailEv = last.events[last.events.length - 1];
    return `tg:${last.id}:${last.events.length}:${tailEv?.seq}:${tailEv?.status}`;
  }
  const ev = last.event;
  const p = ev.payload || {};
  const textLen =
    (typeof p.modifiedResponse === 'string' ? p.modifiedResponse.length : 0) +
    (typeof p.response === 'string' ? p.response.length : 0) +
    (typeof p.text === 'string' ? p.text.length : 0) +
    (typeof p.thinking === 'string' ? p.thinking.length : 0) +
    (typeof p.combinedOutput === 'string' ? p.combinedOutput.length : 0);
  return `st:${ev.seq}:${ev.status}:${textLen}`;
}

export function VirtualChatList({
  events,
  loading,
  activeSessionId,
  permissionLevel = 'L1',
  hideSystemEvents = false,
  thinkingExpandVersion = 0,
  thinkingExpandTarget = null,
  searchQuery,
  searchRegex = false,
  searchCaseSensitive = false,
  currentMatchSeq = null,
  jumpTarget = null,
  scrollBottomNonce = 0,
  scrollTopNonce = 0,
  onInspectFile,
  onViewDiffFile,
  onApprove,
  onAnswer,
  queue,
  onSteerQueueItem,
  onRemoveQueueItem,
  onEditQueueItem,
  onRetryQueueItem
}: VirtualChatListProps) {
  const { t } = useI18n();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const stickBottomRef = useRef<boolean>(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);
  const [stickBottom, setStickBottom] = useState(true);
  const [busyQueueIds, setBusyQueueIds] = useState<Record<string, boolean>>({});
  const [, setMeasureTick] = useState(0);

  const visibleEvents = useMemo(
    () => (hideSystemEvents ? events.filter((ev) => ev.kind !== 'system') : events),
    [events, hideSystemEvents]
  );

  const displayItems = useMemo(() => buildDisplayTimeline(visibleEvents), [visibleEvents]);

  const sessionQueue = useMemo(() => {
    if (!Array.isArray(queue) || queue.length === 0) return [];
    if (!activeSessionId) return queue;
    return queue.filter((q) => {
      const sid = q.sessionId || q.cascadeId || '';
      return !sid || sid === activeSessionId;
    });
  }, [queue, activeSessionId]);

  const tailSignature = useMemo(() => getTailSignature(displayItems), [displayItems]);

  const pinToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  // Reset layout measurements and re-stick to bottom on session switch
  useEffect(() => {
    heightsRef.current.clear();
    stickBottomRef.current = true;
    setStickBottom(true);
    setScrollTop(0);
    pinToBottom();
  }, [activeSessionId, pinToBottom]);

  // Observe scroller viewport height AND inner content height for smooth streaming auto-scroll
  useEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller) return;

    const updateSize = () => setViewportHeight(scroller.clientHeight || 640);
    updateSize();

    if (typeof ResizeObserver === 'undefined') return undefined;

    let rafId = 0;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === scroller) {
          updateSize();
        } else if (entry.target === content && stickBottomRef.current) {
          if (rafId) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            if (stickBottomRef.current && scrollerRef.current) {
              scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
            }
          });
        }
      }
    });

    ro.observe(scroller);
    if (content) ro.observe(content);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [displayItems.length === 0 && sessionQueue.length === 0]);

  useEffect(() => {
    if (!stickBottom) return;
    pinToBottom();
  }, [displayItems.length, tailSignature, sessionQueue.length, stickBottom, pinToBottom]);

  useEffect(() => {
    if (!scrollBottomNonce) return;
    stickBottomRef.current = true;
    setStickBottom(true);
    pinToBottom();
  }, [scrollBottomNonce, pinToBottom]);

  useEffect(() => {
    if (!scrollTopNonce) return;
    stickBottomRef.current = false;
    setStickBottom(false);
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = 0;
      setScrollTop(0);
    }
  }, [scrollTopNonce]);

  useEffect(() => {
    if (!jumpTarget || !jumpTarget.nonce) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    stickBottomRef.current = false;
    setStickBottom(false);

    const scrollTargetIntoView = () => {
      const node = scroller.querySelector(
        `[data-testid="step-card-${jumpTarget.seq}"], [data-testid="tool-group-item-${jumpTarget.seq}"]`
      );
      if (node && typeof (node as HTMLElement).scrollIntoView === 'function') {
        (node as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
        return true;
      }
      return false;
    };

    if (scrollTargetIntoView()) return;

    const itemIdx = displayItems.findIndex((item) =>
      item.type === 'tool_group'
        ? item.events.some((e) => e.seq === jumpTarget.seq)
        : item.event.seq === jumpTarget.seq
    );
    if (itemIdx >= 0) {
      let approxY = 0;
      for (let i = 0; i < itemIdx; i++) {
        approxY += heightsRef.current.get(getItemKey(displayItems[i])) || DEFAULT_ESTIMATED_HEIGHT;
      }
      scroller.scrollTop = Math.max(0, approxY - viewportHeight / 3);
      setScrollTop(scroller.scrollTop);
      const raf = requestAnimationFrame(() => {
        scrollTargetIntoView();
      });
      return () => cancelAnimationFrame(raf);
    }
  }, [jumpTarget, displayItems, viewportHeight]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNear = distFromBottom < 76;
    stickBottomRef.current = isNear;
    setStickBottom(isNear);
  }, []);

  const measureItem = useCallback((key: string, node: HTMLDivElement | null) => {
    if (!node) return;
    const h = node.getBoundingClientRect().height;
    if (h > 0 && Math.abs((heightsRef.current.get(key) || 0) - h) > 2) {
      heightsRef.current.set(key, h);
      setMeasureTick((t) => (t + 1) % 100000);
    }
  }, []);

  const layout = useMemo(() => {
    const count = displayItems.length;
    if (count <= VIRTUALIZE_THRESHOLD) {
      return { start: 0, end: count, topPad: 0, bottomPad: 0 };
    }
    const offsets = new Array<number>(count + 1);
    offsets[0] = 0;
    for (let i = 0; i < count; i++) {
      const h = heightsRef.current.get(getItemKey(displayItems[i])) || DEFAULT_ESTIMATED_HEIGHT;
      offsets[i + 1] = offsets[i] + h;
    }

    const totalHeight = offsets[count];
    const viewEnd = scrollTop + viewportHeight;

    let lo = 0;
    let hi = count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] < scrollTop) lo = mid + 1;
      else hi = mid;
    }
    const start = Math.max(0, lo - OVERSCAN);

    let endIdx = start;
    while (endIdx < count && offsets[endIdx] < viewEnd) {
      endIdx++;
    }
    const end = Math.min(count, endIdx + OVERSCAN);

    return {
      start,
      end,
      topPad: offsets[start],
      bottomPad: Math.max(0, totalHeight - offsets[end])
    };
  }, [displayItems, scrollTop, viewportHeight]);

  const runQueueAction = useCallback(
    async (id: string, fn?: (itemId: string) => Promise<void> | void) => {
      if (!fn) return;
      setBusyQueueIds((prev) => ({ ...prev, [id]: true }));
      try {
        await fn(id);
      } finally {
        setBusyQueueIds((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    },
    []
  );

  if (displayItems.length === 0 && sessionQueue.length === 0) {
    return (
      <div ref={scrollerRef} className={styles.scroller} data-testid="chat-scroller">
        <div className="ag-empty">
          {loading ? t('chat.loadingHistory') : t('chat.emptyHistory')}
        </div>
      </div>
    );
  }

  const visibleSlice = displayItems.slice(layout.start, layout.end);
  const isReadOnly = permissionLevel === 'L0';

  return (
    <div
      ref={scrollerRef}
      className={styles.scroller}
      onScroll={onScroll}
      data-testid="chat-scroller"
    >
      <div ref={contentRef} className={styles.content}>
        {layout.topPad > 0 && <div style={{ height: `${layout.topPad}px` }} aria-hidden="true" />}

        {visibleSlice.map((item) => {
          const key = getItemKey(item);
          return (
            <div key={key} ref={(node) => measureItem(key, node)}>
              {item.type === 'tool_group' ? (
                <ToolGroupCard
                  id={item.id}
                  events={item.events}
                  thinkingNotes={item.thinkingNotes}
                  onInspectFile={onInspectFile}
                  onViewDiffFile={onViewDiffFile}
                  searchQuery={searchQuery}
                  searchRegex={searchRegex}
                  searchCaseSensitive={searchCaseSensitive}
                  currentMatchSeq={currentMatchSeq}
                />
              ) : (
                <StepCard
                  event={item.event}
                  permissionLevel={permissionLevel}
                  onInspectFile={onInspectFile}
                  onViewDiffFile={onViewDiffFile}
                  onApprove={onApprove}
                  onAnswer={onAnswer}
                  thinkingExpandVersion={thinkingExpandVersion}
                  thinkingExpandTarget={thinkingExpandTarget}
                  searchQuery={searchQuery}
                  searchRegex={searchRegex}
                  searchCaseSensitive={searchCaseSensitive}
                  isCurrentMatch={item.event.seq === currentMatchSeq}
                />
              )}
            </div>
          );
        })}

        {layout.bottomPad > 0 && (
          <div style={{ height: `${layout.bottomPad}px` }} aria-hidden="true" />
        )}

        {sessionQueue.length > 0 && (
          <section
            className={styles.queueSection}
            data-testid="chat-queue-list"
            aria-label={t('chat.queueRegion')}
          >
            {sessionQueue.map((q) => {
              const isBusy = Boolean(busyQueueIds[q.id]) || q.status === 'sending';
              const isFailed = q.status === 'failed';
              return (
                <article
                  key={q.id}
                  className={[styles.queuedCard, isFailed ? styles.queuedCardFailed : '']
                    .filter(Boolean)
                    .join(' ')}
                  data-testid={`queued-msg-${q.id}`}
                  data-status={q.status}
                >
                  <header className={styles.queuedHead}>
                    <div className={styles.queuedHeadLeft}>
                      <span
                        className={[
                          styles.queuedBadge,
                          isFailed
                            ? styles.queuedBadgeFailed
                            : q.status === 'sending'
                              ? styles.queuedBadgeSending
                              : styles.queuedBadgeWaiting
                        ].join(' ')}
                      >
                        {isFailed
                          ? t('chat.queueFailed')
                          : q.status === 'sending'
                            ? t('chat.sending')
                            : t('chat.queueQueued')}
                      </span>
                      {q.mode === 'plan' && <span className={styles.modeTag}>Plan</span>}
                      {q.images && q.images.length > 0 && (
                        <span className="ag-chip">
                          {t('chat.imagesCount', { count: q.images.length })}
                        </span>
                      )}
                    </div>
                  </header>

                  {q.text && <div className={styles.queuedText}>{q.text}</div>}

                  {isFailed && q.error && <div className={styles.queuedError}>{q.error}</div>}

                  <div className={styles.queuedActions}>
                    {q.status === 'queued' && onSteerQueueItem && (
                      <button
                        type="button"
                        className={`${styles.qBtn} ${styles.qBtnPrimary}`}
                        disabled={isReadOnly || isBusy}
                        onClick={() => runQueueAction(q.id, onSteerQueueItem)}
                        data-testid={`queue-steer-${q.id}`}
                      >
                        {t('chat.steerNow')}
                      </button>
                    )}

                    {isFailed && onRetryQueueItem && (
                      <button
                        type="button"
                        className={`${styles.qBtn} ${styles.qBtnPrimary}`}
                        disabled={isReadOnly || isBusy}
                        onClick={() => runQueueAction(q.id, onRetryQueueItem)}
                        data-testid={`queue-retry-${q.id}`}
                      >
                        {t('chat.retry')}
                      </button>
                    )}

                    {q.status !== 'sending' && onEditQueueItem && (
                      <button
                        type="button"
                        className={styles.qBtn}
                        disabled={isBusy}
                        onClick={() => onEditQueueItem(q.id)}
                        data-testid={`queue-edit-${q.id}`}
                      >
                        {t('chat.edit')}
                      </button>
                    )}

                    {q.status !== 'sending' && onRemoveQueueItem && (
                      <button
                        type="button"
                        className={`${styles.qBtn} ${styles.qBtnDanger}`}
                        disabled={isBusy}
                        onClick={() => runQueueAction(q.id, onRemoveQueueItem)}
                        data-testid={`queue-remove-${q.id}`}
                      >
                        {t('chat.withdraw')}
                      </button>
                    )}
                  </div>
                </article>
              );
            })}
          </section>
        )}
      </div>

      {!stickBottom && (
        <button
          type="button"
          className={styles.jumpBottom}
          onClick={() => {
            stickBottomRef.current = true;
            setStickBottom(true);
            pinToBottom();
          }}
          data-testid="jump-bottom-btn"
        >
          ↓ {t('chat.jumpBottom')}
        </button>
      )}
    </div>
  );
}
