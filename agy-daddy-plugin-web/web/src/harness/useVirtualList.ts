import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface UseVirtualListOptions<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  scrollRef: React.RefObject<HTMLElement | null>;
  estimateHeight: (item: T) => number;
  gap?: number;
  overscanCount?: number;
  virtualizeThreshold?: number;
}

export interface VirtualRangeResult<T> {
  visibleItems: Array<{ item: T; index: number; key: string }>;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  isVirtualized: boolean;
  measureRef: (key: string) => (el: HTMLElement | null) => void;
}

function findFirstIndexAtOrAfter(offsets: number[], target: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] < target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

export function useVirtualList<T>({
  items,
  getKey,
  scrollRef,
  estimateHeight,
  gap = 12,
  overscanCount = 6,
  virtualizeThreshold = 20,
}: UseVirtualListOptions<T>): VirtualRangeResult<T> {
  const heightCacheRef = useRef<Map<string, number>>(new Map());
  const nodeMapRef = useRef<Map<string, HTMLElement>>(new Map());
  const observerRef = useRef<ResizeObserver | null>(null);
  const rafMeasureRef = useRef<number>(0);

  const [measureTick, setMeasureTick] = useState(0);
  const [scrollState, setScrollState] = useState<{ scrollTop: number; clientHeight: number }>({
    scrollTop: 0,
    clientHeight: 0,
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const syncViewport = () => {
      const nextTop = el.scrollTop || 0;
      const nextHeight = el.clientHeight || 0;
      setScrollState((prev) =>
        prev.scrollTop === nextTop && prev.clientHeight === nextHeight
          ? prev
          : { scrollTop: nextTop, clientHeight: nextHeight },
      );
    };

    syncViewport();

    let scrollRaf = 0;
    const onScroll = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        syncViewport();
      });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(syncViewport) : null;
    ro?.observe(el);

    return () => {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, [scrollRef]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const key = target.dataset.virtualKey;
        if (!key) continue;
        const measured = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
        if (measured > 0 && heightCacheRef.current.get(key) !== measured) {
          heightCacheRef.current.set(key, measured);
          changed = true;
        }
      }
      if (changed && !rafMeasureRef.current) {
        rafMeasureRef.current = requestAnimationFrame(() => {
          rafMeasureRef.current = 0;
          setMeasureTick((v) => v + 1);
        });
      }
    });
    observerRef.current = ro;
    for (const node of nodeMapRef.current.values()) {
      ro.observe(node);
    }
    return () => {
      if (rafMeasureRef.current) {
        cancelAnimationFrame(rafMeasureRef.current);
        rafMeasureRef.current = 0;
      }
      ro.disconnect();
      observerRef.current = null;
    };
  }, []);

  const measureRef = useCallback(
    (key: string) => (el: HTMLElement | null) => {
      const prevEl = nodeMapRef.current.get(key);
      if (prevEl && prevEl !== el) {
        observerRef.current?.unobserve(prevEl);
        nodeMapRef.current.delete(key);
      }
      if (el) {
        el.dataset.virtualKey = key;
        nodeMapRef.current.set(key, el);
        observerRef.current?.observe(el);
        const h = Math.round(el.getBoundingClientRect().height);
        if (h > 0 && heightCacheRef.current.get(key) !== h) {
          heightCacheRef.current.set(key, h);
        }
      }
    },
    [],
  );

  const isVirtualized =
    items.length > virtualizeThreshold && scrollState.clientHeight > 0;

  return useMemo(() => {
    if (!isVirtualized) {
      return {
        visibleItems: items.map((item, index) => ({ item, index, key: getKey(item) })),
        topSpacerHeight: 0,
        bottomSpacerHeight: 0,
        isVirtualized: false,
        measureRef,
      };
    }

    const n = items.length;
    const starts = new Array<number>(n);
    const ends = new Array<number>(n);
    let cursor = 0;

    for (let i = 0; i < n; i++) {
      const key = getKey(items[i]);
      const h = heightCacheRef.current.get(key) ?? estimateHeight(items[i]);
      starts[i] = cursor;
      ends[i] = cursor + h;
      cursor += h + (i < n - 1 ? gap : 0);
    }

    const totalHeight = cursor;
    const viewTop = scrollState.scrollTop;
    const viewBottom = viewTop + scrollState.clientHeight;

    const firstVisible = findFirstIndexAtOrAfter(ends, viewTop);
    let lastVisible = findFirstIndexAtOrAfter(starts, viewBottom);
    if (lastVisible < firstVisible) lastVisible = firstVisible;

    const startIdx = Math.max(0, firstVisible - overscanCount);
    const endIdx = Math.min(n - 1, lastVisible + overscanCount);

    const topSpacerHeight = Math.max(0, starts[startIdx] - (startIdx > 0 ? gap : 0));
    const bottomSpacerHeight = Math.max(
      0,
      totalHeight - ends[endIdx] - (endIdx < n - 1 ? gap : 0),
    );

    const visibleItems: Array<{ item: T; index: number; key: string }> = [];
    for (let i = startIdx; i <= endIdx; i++) {
      visibleItems.push({ item: items[i], index: i, key: getKey(items[i]) });
    }

    return {
      visibleItems,
      topSpacerHeight,
      bottomSpacerHeight,
      isVirtualized: true,
      measureRef,
    };
    // measureTick intentionally triggers recomputation after ResizeObserver batches
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isVirtualized,
    items,
    getKey,
    estimateHeight,
    gap,
    overscanCount,
    scrollState.scrollTop,
    scrollState.clientHeight,
    measureTick,
    measureRef,
  ]);
}
