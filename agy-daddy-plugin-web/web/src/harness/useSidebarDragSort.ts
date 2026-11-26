import { useCallback, useEffect, useRef, useState } from 'react';
import type { OrgReorderRequest, SessionSummary, ZoneOrder } from '../types';

export type DndTargetType = 'group' | 'project' | 'session';
export type DndZone = 'pinned' | 'normal';
export type ReorderMenuAction = 'up' | 'down' | 'first' | 'last';

export interface DragItemMeta {
  targetType: DndTargetType;
  id: string;
  label: string;
  zone: DndZone;
  containerId: string;
  fromGroupId?: string | null;
  workspaceUri?: string;
}

export type ActiveDropTarget =
  | {
      kind: 'slot';
      targetType: DndTargetType;
      containerId: string;
      zone: DndZone;
      insertIndex: number;
      lineTop: number;
      lineLeft: number;
      lineWidth: number;
      crossZoneBlocked: boolean;
      movedFromGroupId?: string | null;
      toGroupId?: string | null;
      zoneIds: string[];
    }
  | {
      kind: 'group-header';
      groupId: string;
      groupName: string;
    }
  | {
      kind: 'drop-zone';
      containerId: string;
      toGroupId: string | null;
    };

export interface KeyboardReorderState {
  targetType: DndTargetType;
  id: string;
  label: string;
  zone: DndZone;
  containerId: string;
  initialIds: string[];
  previewIds: string[];
  index: number;
}

export function partitionAndOrderItems<T>(opts: {
  items: T[];
  isPinned: (item: T) => boolean;
  getId: (item: T) => string;
  order?: ZoneOrder | null;
  defaultPinnedCompare: (a: T, b: T) => number;
  defaultNormalCompare: (a: T, b: T) => number;
}): { pinned: T[]; normal: T[] } {
  const pinnedItems: T[] = [];
  const normalItems: T[] = [];
  for (const item of opts.items) {
    if (opts.isPinned(item)) pinnedItems.push(item);
    else normalItems.push(item);
  }

  const orderZone = <U>(
    list: U[],
    savedOrder: string[] | undefined,
    compareFallback: (a: U, b: U) => number,
    newItemsAtTop: boolean,
  ): U[] => {
    if (!savedOrder || savedOrder.length === 0) {
      return [...list].sort(compareFallback);
    }
    const rank = new Map<string, number>();
    savedOrder.forEach((id, idx) => rank.set(id, idx));
    const listed: U[] = [];
    const unlisted: U[] = [];
    for (const item of list) {
      if (rank.has(opts.getId(item as unknown as T))) {
        listed.push(item);
      } else {
        unlisted.push(item);
      }
    }
    listed.sort(
      (a, b) =>
        (rank.get(opts.getId(a as unknown as T)) ?? 0) -
        (rank.get(opts.getId(b as unknown as T)) ?? 0),
    );
    unlisted.sort(compareFallback);
    return newItemsAtTop ? [...unlisted, ...listed] : [...listed, ...unlisted];
  };

  return {
    pinned: orderZone(pinnedItems, opts.order?.pinned, opts.defaultPinnedCompare, false),
    normal: orderZone(normalItems, opts.order?.normal, opts.defaultNormalCompare, true),
  };
}

export function sortPinnedQuickSessions(
  sessions: SessionSummary[],
  pinnedOrder: string[] | undefined,
  defaultCompare: (a: SessionSummary, b: SessionSummary) => number,
): SessionSummary[] {
  if (!pinnedOrder || pinnedOrder.length === 0) {
    return [...sessions].sort(defaultCompare);
  }
  const rank = new Map<string, number>();
  pinnedOrder.forEach((id, idx) => rank.set(id, idx));
  const listed: SessionSummary[] = [];
  const unlisted: SessionSummary[] = [];
  for (const s of sessions) {
    if (rank.has(s.cascadeId)) listed.push(s);
    else unlisted.push(s);
  }
  listed.sort((a, b) => (rank.get(a.cascadeId) ?? 0) - (rank.get(b.cascadeId) ?? 0));
  unlisted.sort(defaultCompare);
  return [...unlisted, ...listed];
}

export function reorderWithinZone(
  zoneIds: string[],
  itemId: string,
  action: ReorderMenuAction | { toIndex: number },
): string[] | null {
  const curIdx = zoneIds.indexOf(itemId);
  if (curIdx < 0 || zoneIds.length <= 1) return null;

  let nextIdx = curIdx;
  if (action === 'up') nextIdx = curIdx - 1;
  else if (action === 'down') nextIdx = curIdx + 1;
  else if (action === 'first') nextIdx = 0;
  else if (action === 'last') nextIdx = zoneIds.length - 1;
  else if (typeof action === 'object' && Number.isFinite(action.toIndex)) {
    nextIdx = Math.max(0, Math.min(zoneIds.length - 1, Math.floor(action.toIndex)));
  }

  if (nextIdx < 0 || nextIdx >= zoneIds.length || nextIdx === curIdx) {
    return null;
  }

  const next = zoneIds.slice();
  const [moved] = next.splice(curIdx, 1);
  next.splice(nextIdx, 0, moved);
  return next;
}

export function buildOrderedIdsAfterDrop(
  zoneIds: string[],
  draggedId: string,
  insertIndex: number,
): string[] | null {
  const existingIdx = zoneIds.indexOf(draggedId);
  const filtered = zoneIds.filter((id) => id !== draggedId);
  let targetIdx = Math.max(0, Math.min(zoneIds.length, insertIndex));
  if (existingIdx >= 0 && existingIdx < targetIdx) {
    targetIdx -= 1;
  }
  targetIdx = Math.max(0, Math.min(filtered.length, targetIdx));
  const next = filtered.slice();
  next.splice(targetIdx, 0, draggedId);
  if (
    existingIdx >= 0 &&
    next.length === zoneIds.length &&
    next.every((id, idx) => id === zoneIds[idx])
  ) {
    return null;
  }
  return next;
}

function parseSessionTimeMs(s: SessionSummary): number {
  const raw = s.lastCompletedTime || s.lastModifiedTime || s.createdTime;
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

export function resolveNextActiveSessionId(
  sessions: SessionSummary[],
  targetId: string,
  activeSessionId: string | null | undefined,
): string | null {
  if (!activeSessionId || targetId !== activeSessionId) {
    return activeSessionId ?? null;
  }
  const target = sessions.find((s) => s.cascadeId === targetId);
  const activeCandidates = sessions.filter(
    (s) => !s.archived && s.cascadeId !== targetId,
  );
  if (activeCandidates.length === 0) return null;

  if (target?.projectId) {
    const sameProjectAll = sessions.filter(
      (s) => !s.archived && s.projectId === target.projectId,
    );
    const idx = sameProjectAll.findIndex((s) => s.cascadeId === targetId);
    if (idx >= 0) {
      const nextSame = sameProjectAll[idx + 1] ?? sameProjectAll[idx - 1];
      if (nextSame && nextSame.cascadeId !== targetId) {
        return nextSame.cascadeId;
      }
    }
  }

  const sortedByActivity = [...activeCandidates].sort(
    (a, b) => parseSessionTimeMs(b) - parseSessionTimeMs(a),
  );
  return sortedByActivity[0]?.cascadeId ?? null;
}

export interface UseSidebarDragSortOptions {
  disabled: boolean;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  getZoneIds: (targetType: DndTargetType, containerId: string, zone: DndZone) => string[];
  onCommitReorder: (req: OrgReorderRequest) => Promise<void> | void;
  onTempExpandGroup?: (groupId: string) => void;
  onDraggingChange?: (dragging: boolean) => void;
  formatAnnouncement?: (
    kind: 'active' | 'moved' | 'saved' | 'cancelled',
    info: { name: string; pos: number; total: number },
  ) => string;
}

interface PendingPointerDrag {
  item: DragItemMeta;
  startX: number;
  startY: number;
  threshold: number;
  active: boolean;
}

export function useSidebarDragSort({
  disabled,
  scrollContainerRef,
  getZoneIds,
  onCommitReorder,
  onTempExpandGroup,
  onDraggingChange,
  formatAnnouncement,
}: UseSidebarDragSortOptions) {
  const [draggingItem, setDraggingItem] = useState<DragItemMeta | null>(null);
  const [ghostPos, setGhostPos] = useState<{ x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<ActiveDropTarget | null>(null);
  const [keyboardState, setKeyboardState] = useState<KeyboardReorderState | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>('');

  const pendingRef = useRef<PendingPointerDrag | null>(null);
  const dropTargetRef = useRef<ActiveDropTarget | null>(null);
  dropTargetRef.current = dropTarget;
  const hoverGroupTimerRef = useRef<{ groupId: string; timer: number } | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);
  const pointerClientYRef = useRef<number>(0);

  const optsRef = useRef({
    disabled,
    getZoneIds,
    onCommitReorder,
    onTempExpandGroup,
    onDraggingChange,
  });
  optsRef.current = {
    disabled,
    getZoneIds,
    onCommitReorder,
    onTempExpandGroup,
    onDraggingChange,
  };

  const clearHoverExpandTimer = useCallback(() => {
    if (hoverGroupTimerRef.current) {
      window.clearTimeout(hoverGroupTimerRef.current.timer);
      hoverGroupTimerRef.current = null;
    }
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRafRef.current !== null) {
      window.cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  const computeDropTargetAtPoint = useCallback(
    (item: DragItemMeta, clientX: number, clientY: number): ActiveDropTarget | null => {
      const container = scrollContainerRef.current;
      if (!container) return null;

      // 1. Check collapsed group header or dedicated drop-zone when dragging a project
      if (item.targetType === 'project') {
        const dropZones = Array.from(
          container.querySelectorAll<HTMLElement>('[data-dnd-drop-container]'),
        );
        for (const dz of dropZones) {
          const rect = dz.getBoundingClientRect();
          if (
            clientY >= rect.top &&
            clientY <= rect.bottom &&
            clientX >= rect.left &&
            clientX <= rect.right
          ) {
            const cid = dz.dataset.dndDropContainer || '__ungrouped__';
            return {
              kind: 'drop-zone',
              containerId: cid,
              toGroupId: cid === '__ungrouped__' ? null : cid,
            };
          }
        }

        const collapsedHeaders = Array.from(
          container.querySelectorAll<HTMLElement>('[data-dnd-collapsed-group]'),
        );
        for (const hdr of collapsedHeaders) {
          const rect = hdr.getBoundingClientRect();
          if (
            clientY >= rect.top &&
            clientY <= rect.bottom &&
            clientX >= rect.left &&
            clientX <= rect.right
          ) {
            const gid = hdr.dataset.dndCollapsedGroup || '';
            if (gid) {
              return {
                kind: 'group-header',
                groupId: gid,
                groupName: hdr.dataset.dndGroupName || gid,
              };
            }
          }
        }
      }

      // 2. Scan candidate rows matching item.targetType
      const allRows = Array.from(
        container.querySelectorAll<HTMLElement>(`[data-dnd-item="1"][data-dnd-type="${item.targetType}"]`),
      );
      if (allRows.length === 0) return null;

      // Determine target containerId: groups/sessions stay strictly inside item.containerId;
      // projects can move into whichever container the pointer is over.
      let targetContainerId = item.containerId;
      if (item.targetType === 'project') {
        const containerBlocks = Array.from(
          container.querySelectorAll<HTMLElement>('[data-dnd-project-container]'),
        );
        for (const blk of containerBlocks) {
          const rect = blk.getBoundingClientRect();
          if (clientY >= rect.top && clientY <= rect.bottom) {
            targetContainerId = blk.dataset.dndProjectContainer || '__ungrouped__';
            break;
          }
        }
      }

      const containerRows = allRows.filter(
        (el) => (el.dataset.dndContainer || '') === targetContainerId,
      );
      if (containerRows.length === 0) {
        if (item.targetType === 'project' && targetContainerId !== item.containerId) {
          return {
            kind: 'drop-zone',
            containerId: targetContainerId,
            toGroupId: targetContainerId === '__ungrouped__' ? null : targetContainerId,
          };
        }
        return null;
      }

      const pinnedRows = containerRows.filter((el) => el.dataset.dndZone === 'pinned');
      const normalRows = containerRows.filter((el) => el.dataset.dndZone === 'normal');

      const matchingRows = item.zone === 'pinned' ? pinnedRows : normalRows;
      const oppositeRows = item.zone === 'pinned' ? normalRows : pinnedRows;

      const toGroupId =
        item.targetType === 'project'
          ? targetContainerId === '__ungrouped__'
            ? null
            : targetContainerId
          : undefined;
      const movedFromGroupId =
        item.targetType === 'project' && targetContainerId !== item.containerId
          ? item.fromGroupId ?? null
          : undefined;

      // If target container has no items in the matching zone yet (cross-group move into zone)
      if (matchingRows.length === 0) {
        if (item.targetType === 'project' && targetContainerId !== item.containerId) {
          const zoneIds = optsRef.current.getZoneIds('project', targetContainerId, item.zone);
          const refRow = oppositeRows[0];
          const refRect = refRow?.getBoundingClientRect();
          const lineTop = refRect
            ? item.zone === 'pinned'
              ? refRect.top
              : refRect.bottom
            : container.getBoundingClientRect().top;
          return {
            kind: 'slot',
            targetType: 'project',
            containerId: targetContainerId,
            zone: item.zone,
            insertIndex: 0,
            lineTop,
            lineLeft: refRect?.left ?? container.getBoundingClientRect().left + 8,
            lineWidth: refRect?.width ?? Math.max(120, container.clientWidth - 16),
            crossZoneBlocked: false,
            movedFromGroupId,
            toGroupId,
            zoneIds,
          };
        }
        return null;
      }

      // Check whether pointer crossed into the opposite zone -> clamp strictly inside matching zone
      let crossZoneBlocked = false;
      if (oppositeRows.length > 0) {
        if (item.zone === 'pinned') {
          const firstNormalRect = oppositeRows[0].getBoundingClientRect();
          const lastPinnedRect = matchingRows[matchingRows.length - 1].getBoundingClientRect();
          const boundaryY = (lastPinnedRect.bottom + firstNormalRect.top) / 2;
          if (clientY > boundaryY) {
            crossZoneBlocked = true;
          }
        } else {
          const lastPinnedRect = oppositeRows[oppositeRows.length - 1].getBoundingClientRect();
          const firstNormalRect = matchingRows[0].getBoundingClientRect();
          const boundaryY = (lastPinnedRect.bottom + firstNormalRect.top) / 2;
          if (clientY < boundaryY) {
            crossZoneBlocked = true;
          }
        }
      }

      const zoneIds = optsRef.current.getZoneIds(item.targetType, targetContainerId, item.zone);

      if (crossZoneBlocked) {
        const edgeRow =
          item.zone === 'pinned' ? matchingRows[matchingRows.length - 1] : matchingRows[0];
        const edgeRect = edgeRow.getBoundingClientRect();
        return {
          kind: 'slot',
          targetType: item.targetType,
          containerId: targetContainerId,
          zone: item.zone,
          insertIndex: item.zone === 'pinned' ? matchingRows.length : 0,
          lineTop: item.zone === 'pinned' ? edgeRect.bottom : edgeRect.top,
          lineLeft: edgeRect.left,
          lineWidth: edgeRect.width,
          crossZoneBlocked: true,
          movedFromGroupId,
          toGroupId,
          zoneIds,
        };
      }

      let insertIndex = matchingRows.length;
      let lineTop = matchingRows[matchingRows.length - 1].getBoundingClientRect().bottom;
      let lineLeft = matchingRows[0].getBoundingClientRect().left;
      let lineWidth = matchingRows[0].getBoundingClientRect().width;

      for (let i = 0; i < matchingRows.length; i++) {
        const r = matchingRows[i].getBoundingClientRect();
        const midY = r.top + r.height / 2;
        if (clientY <= midY) {
          insertIndex = i;
          lineTop = r.top;
          lineLeft = r.left;
          lineWidth = r.width;
          break;
        }
      }

      return {
        kind: 'slot',
        targetType: item.targetType,
        containerId: targetContainerId,
        zone: item.zone,
        insertIndex,
        lineTop,
        lineLeft,
        lineWidth,
        crossZoneBlocked: false,
        movedFromGroupId,
        toGroupId,
        zoneIds,
      };
    },
    [scrollContainerRef],
  );

  const startAutoScrollIfNeeded = useCallback(
    (clientY: number) => {
      pointerClientYRef.current = clientY;
      if (autoScrollRafRef.current !== null) return;

      const tick = () => {
        const container = scrollContainerRef.current;
        const pending = pendingRef.current;
        if (!container || !pending || !pending.active) {
          autoScrollRafRef.current = null;
          return;
        }
        const rect = container.getBoundingClientRect();
        const y = pointerClientYRef.current;
        const hotZone = 40;
        let delta = 0;
        if (y - rect.top < hotZone) {
          const ratio = Math.max(0, Math.min(1, (hotZone - (y - rect.top)) / hotZone));
          delta = -(4 + Math.round(ratio * 8));
        } else if (rect.bottom - y < hotZone) {
          const ratio = Math.max(0, Math.min(1, (hotZone - (rect.bottom - y)) / hotZone));
          delta = 4 + Math.round(ratio * 8);
        }
        if (delta !== 0) {
          container.scrollTop += delta;
        }
        autoScrollRafRef.current = window.requestAnimationFrame(tick);
      };
      autoScrollRafRef.current = window.requestAnimationFrame(tick);
    },
    [scrollContainerRef],
  );

  const finishDrag = useCallback(
    (commit: boolean) => {
      const pending = pendingRef.current;
      const currentTarget = dropTargetRef.current;
      pendingRef.current = null;
      clearHoverExpandTimer();
      stopAutoScroll();

      if (pending?.active) {
        setDraggingItem(null);
        setGhostPos(null);
        setDropTarget(null);
        optsRef.current.onDraggingChange?.(false);
      }

      if (!commit || !pending?.active || !currentTarget) return;

      const item = pending.item;
      if (currentTarget.kind === 'group-header' && item.targetType === 'project') {
        const destIds = optsRef.current.getZoneIds('project', currentTarget.groupId, item.zone);
        const filtered = destIds.filter((id) => id !== item.id);
        const orderedIds =
          item.zone === 'pinned' ? [...filtered, item.id] : [item.id, ...filtered];
        void optsRef.current.onCommitReorder({
          targetType: 'project',
          containerId: currentTarget.groupId,
          zone: item.zone,
          orderedIds,
          movedProject: {
            projectId: item.id,
            workspaceUri: item.workspaceUri,
            fromGroupId: item.fromGroupId ?? null,
            toGroupId: currentTarget.groupId,
          },
        });
        return;
      }

      if (currentTarget.kind === 'drop-zone' && item.targetType === 'project') {
        const destIds = optsRef.current.getZoneIds('project', currentTarget.containerId, item.zone);
        const filtered = destIds.filter((id) => id !== item.id);
        const orderedIds =
          item.zone === 'pinned' ? [...filtered, item.id] : [item.id, ...filtered];
        void optsRef.current.onCommitReorder({
          targetType: 'project',
          containerId: currentTarget.containerId,
          zone: item.zone,
          orderedIds,
          movedProject: {
            projectId: item.id,
            workspaceUri: item.workspaceUri,
            fromGroupId: item.fromGroupId ?? null,
            toGroupId: currentTarget.toGroupId,
          },
        });
        return;
      }

      if (currentTarget.kind === 'slot') {
        const isCrossGroup =
          currentTarget.targetType === 'project' &&
          currentTarget.containerId !== item.containerId;
        const baseIds = currentTarget.zoneIds;
        const orderedIds = buildOrderedIdsAfterDrop(baseIds, item.id, currentTarget.insertIndex);
        if (!orderedIds && !isCrossGroup) return;

        void optsRef.current.onCommitReorder({
          targetType: currentTarget.targetType,
          containerId: currentTarget.containerId,
          zone: currentTarget.zone,
          orderedIds: orderedIds ?? baseIds,
          ...(isCrossGroup
            ? {
                movedProject: {
                  projectId: item.id,
                  workspaceUri: item.workspaceUri,
                  fromGroupId: item.fromGroupId ?? null,
                  toGroupId:
                    currentTarget.containerId === '__ungrouped__'
                      ? null
                      : currentTarget.containerId,
                },
              }
            : {}),
        });
      }
    },
    [clearHoverExpandTimer, stopAutoScroll],
  );

  useEffect(() => {
    const handlePointerMove = (ev: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending) return;

      if (!pending.active) {
        const dx = ev.clientX - pending.startX;
        const dy = ev.clientY - pending.startY;
        if (Math.hypot(dx, dy) < pending.threshold) return;
        pending.active = true;
        setDraggingItem(pending.item);
        optsRef.current.onDraggingChange?.(true);
      }

      setGhostPos({ x: ev.clientX, y: ev.clientY });
      startAutoScrollIfNeeded(ev.clientY);

      const nextTarget = computeDropTargetAtPoint(pending.item, ev.clientX, ev.clientY);
      setDropTarget(nextTarget);

      if (nextTarget?.kind === 'group-header' && optsRef.current.onTempExpandGroup) {
        if (hoverGroupTimerRef.current?.groupId !== nextTarget.groupId) {
          clearHoverExpandTimer();
          const gid = nextTarget.groupId;
          const timer = window.setTimeout(() => {
            hoverGroupTimerRef.current = null;
            optsRef.current.onTempExpandGroup?.(gid);
          }, 600);
          hoverGroupTimerRef.current = { groupId: gid, timer };
        }
      } else {
        clearHoverExpandTimer();
      }
    };

    const handlePointerUp = () => {
      if (pendingRef.current) {
        finishDrag(true);
      }
    };

    const handlePointerCancel = () => {
      if (pendingRef.current) {
        finishDrag(false);
      }
    };

    const handleKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && pendingRef.current?.active) {
        ev.preventDefault();
        finishDrag(false);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('keydown', handleKeyDown);
      clearHoverExpandTimer();
      stopAutoScroll();
    };
  }, [
    clearHoverExpandTimer,
    computeDropTargetAtPoint,
    finishDrag,
    startAutoScrollIfNeeded,
    stopAutoScroll,
  ]);

  const startPointerCandidate = useCallback(
    (ev: React.PointerEvent, item: DragItemMeta, isHandle: boolean) => {
      if (optsRef.current.disabled) return;
      if (ev.button !== 0) return;

      if (!isHandle) {
        const targetEl = ev.target as HTMLElement | null;
        if (
          targetEl?.closest(
            'button, a, input, select, textarea, option, [role="menuitem"], [data-no-drag="1"]',
          )
        ) {
          return;
        }
        const selectionText = typeof window !== 'undefined' ? window.getSelection()?.toString() : '';
        if (selectionText && selectionText.length > 0) return;
      } else {
        ev.stopPropagation();
      }

      pendingRef.current = {
        item,
        startX: ev.clientX,
        startY: ev.clientY,
        threshold: isHandle ? 4 : 6,
        active: false,
      };
    },
    [],
  );

  const handleHandleKeyDown = useCallback(
    (ev: React.KeyboardEvent, item: DragItemMeta) => {
      if (optsRef.current.disabled) return;
      const isActiveForItem =
        keyboardState &&
        keyboardState.targetType === item.targetType &&
        keyboardState.id === item.id &&
        keyboardState.containerId === item.containerId;

      if (!isActiveForItem) {
        if (ev.key === ' ' || ev.key === 'Enter') {
          ev.preventDefault();
          ev.stopPropagation();
          const zoneIds = optsRef.current.getZoneIds(item.targetType, item.containerId, item.zone);
          const idx = zoneIds.indexOf(item.id);
          if (idx < 0 || zoneIds.length <= 1) return;
          setKeyboardState({
            targetType: item.targetType,
            id: item.id,
            label: item.label,
            zone: item.zone,
            containerId: item.containerId,
            initialIds: zoneIds,
            previewIds: zoneIds,
            index: idx,
          });
          setLiveAnnouncement(
            formatAnnouncement?.('active', {
              name: item.label,
              pos: idx + 1,
              total: zoneIds.length,
            }) ?? '',
          );
        }
        return;
      }

      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        ev.stopPropagation();
        const delta = ev.key === 'ArrowUp' ? -1 : 1;
        const nextIdx = Math.max(
          0,
          Math.min(keyboardState.previewIds.length - 1, keyboardState.index + delta),
        );
        if (nextIdx === keyboardState.index) return;
        const nextPreview = keyboardState.previewIds.slice();
        const [moved] = nextPreview.splice(keyboardState.index, 1);
        nextPreview.splice(nextIdx, 0, moved);
        setKeyboardState({
          ...keyboardState,
          previewIds: nextPreview,
          index: nextIdx,
        });
        setLiveAnnouncement(
          formatAnnouncement?.('moved', {
            name: keyboardState.label,
            pos: nextIdx + 1,
            total: nextPreview.length,
          }) ?? '',
        );
      } else if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        ev.stopPropagation();
        const changed = !keyboardState.previewIds.every(
          (id, idx) => id === keyboardState.initialIds[idx],
        );
        setKeyboardState(null);
        setLiveAnnouncement(
          formatAnnouncement?.('saved', {
            name: keyboardState.label,
            pos: keyboardState.index + 1,
            total: keyboardState.previewIds.length,
          }) ?? '',
        );
        if (changed) {
          void optsRef.current.onCommitReorder({
            targetType: keyboardState.targetType,
            containerId: keyboardState.containerId,
            zone: keyboardState.zone,
            orderedIds: keyboardState.previewIds,
          });
        }
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        const origIdx = keyboardState.initialIds.indexOf(keyboardState.id);
        setKeyboardState(null);
        setLiveAnnouncement(
          formatAnnouncement?.('cancelled', {
            name: keyboardState.label,
            pos: Math.max(1, origIdx + 1),
            total: keyboardState.initialIds.length,
          }) ?? '',
        );
      }
    },
    [formatAnnouncement, keyboardState],
  );

  return {
    draggingItem,
    ghostPos,
    dropTarget,
    keyboardState,
    liveAnnouncement,
    startPointerCandidate,
    handleHandleKeyDown,
  };
}
