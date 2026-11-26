import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  formatRelativeTime,
  formatSessionTitle,
  useI18n,
  type Locale,
  type TranslateFn,
} from '../i18n';
import type {
  OrgReorderRequest,
  ProjectGroup,
  ProjectItem,
  SessionOrderMap,
  SessionSummary,
  ZoneOrder,
} from '../types';
import {
  partitionAndOrderItems,
  reorderWithinZone,
  sortPinnedQuickSessions,
  useSidebarDragSort,
  type DndTargetType,
  type DndZone,
  type DragItemMeta,
  type ReorderMenuAction,
} from './useSidebarDragSort';
import { EntityIcon, EntityIconPicker } from './EntityIcon';
import styles from './SessionSidebar.module.css';

export interface SessionSidebarProps {
  sessions: SessionSummary[];
  activeSessionId?: string | null;
  onSelectSession: (cascadeId: string) => void;
  onCreateSession: (opts?: {
    projectId?: string | null;
    workspaceUri?: string;
    standalone?: boolean;
  }) => void;
  loading?: boolean;
  creating?: boolean;
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
  projects?: ProjectItem[];
  projectGroups?: ProjectGroup[];
  selectedProjectFilter?: string;
  onSelectProjectFilter?: (filter: string) => void;
  defaultSessionPath?: string;
  hiddenInternalCount?: number;
  includeInternal?: boolean;
  onToggleIncludeInternal?: (next: boolean) => void;
  permissionLevel?: 'L0' | 'L1' | 'L2' | string;
  channel?: string;
  groupOrder?: ZoneOrder;
  projectOrder?: Record<string, ZoneOrder>;
  sessionOrder?: SessionOrderMap;
  archivedCount?: number;
  archivedSessions?: SessionSummary[];
  loadingArchived?: boolean;
  viewMode?: 'active' | 'archived';
  onViewModeChange?: (mode: 'active' | 'archived') => void;
  onPinSession?: (cascadeId: string, pinned: boolean) => Promise<void> | void;
  onPinProject?: (project: ProjectItem, pinned: boolean) => Promise<void> | void;
  onPinGroup?: (group: ProjectGroup, pinned: boolean) => Promise<void> | void;
  onAssignSessionProject?: (cascadeId: string, projectId: string | null) => Promise<void> | void;
  onArchiveSession?: (session: SessionSummary, archived: boolean) => Promise<void> | void;
  onRequestDeleteSession?: (session: SessionSummary) => void;
  onReorderOrg?: (req: OrgReorderRequest) => Promise<void> | void;
  onOpenNewProjectModal?: () => void;
  onDraggingChange?: (dragging: boolean) => void;
  onCreateProject?: (payload: {
    name: string;
    rootPath: string;
    groupId?: string | null;
    createDir?: boolean;
  }) => Promise<void> | void;
  onUpdateProject?: (
    id: string,
    patch: {
      name?: string;
      groupId?: string | null;
      icon?: string | null;
      workspaceUri?: string;
      rootPath?: string;
    },
  ) => Promise<void> | void;
  onDeleteProject?: (id: string) => Promise<void> | void;
  onCreateGroup?: (name: string, icon?: string | null) => Promise<void> | void;
  onToggleGroupCollapsed?: (id: string, collapsed: boolean) => Promise<void> | void;
  onRenameGroup?: (id: string, name: string) => Promise<void> | void;
  onUpdateGroup?: (
    id: string,
    patch: { name?: string; collapsed?: boolean; icon?: string | null },
  ) => Promise<void> | void;
  onDeleteGroup?: (id: string) => Promise<void> | void;
  onMarkSessionRead?: (cascadeId: string) => Promise<void> | void;
}

function parseTimestamp(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function extractWorkspaceName(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const cleaned = uri.replace(/^file:\/\//i, '').replace(/\/+$/, '');
  if (!cleaned) return null;
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : cleaned;
}

function toWorkspaceUri(rootPath?: string | null): string | undefined {
  const trimmed = typeof rootPath === 'string' ? rootPath.trim() : '';
  if (!trimmed) return undefined;
  if (/^file:\/\//i.test(trimmed)) return trimmed;
  return `file://${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
}

function isSyncedAppProject(project: ProjectItem): boolean {
  return Boolean(project.syncedFromApp || project.source === 'app');
}

function isSessionRunning(session: SessionSummary): boolean {
  if (session.isRunning === true) return true;
  const normalized = String(session.status || '').toUpperCase();
  return normalized.includes('RUNNING') || normalized.includes('GENERATING');
}

function EditGlyph() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M11.4 2.6a1.4 1.4 0 0 1 2 2L5.5 12.5 2.5 13.5l1-3 7.9-7.9Z" />
    </svg>
  );
}

function PinGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z" />
    </svg>
  );
}

function DragDotsGlyph() {
  return (
    <svg width="10" height="12" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
      <circle cx="2.5" cy="2.5" r="1.1" />
      <circle cx="7.5" cy="2.5" r="1.1" />
      <circle cx="2.5" cy="7" r="1.1" />
      <circle cx="7.5" cy="7" r="1.1" />
      <circle cx="2.5" cy="11.5" r="1.1" />
      <circle cx="7.5" cy="11.5" r="1.1" />
    </svg>
  );
}

function FolderGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.75 3.75A1.25 1.25 0 0 1 3 2.5h2.6a1.25 1.25 0 0 1 .95.44l.7.81h5.75A1.25 1.25 0 0 1 14.25 5v7.25A1.25 1.25 0 0 1 13 13.5H3a1.25 1.25 0 0 1-1.25-1.25V3.75Z" />
    </svg>
  );
}

function FolderPlusGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.75 3.75A1.25 1.25 0 0 1 3 2.5h2.5a1.25 1.25 0 0 1 .95.44l.7.81H13A1.25 1.25 0 0 1 14.25 5v7.25A1.25 1.25 0 0 1 13 13.5H3a1.25 1.25 0 0 1-1.25-1.25V3.75Z" />
      <path d="M8 6.75v3.5M6.25 8.5h3.5" />
    </svg>
  );
}

function GroupPlusGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 4.5 8 1.75 14 4.5 8 7.25 2 4.5Z" />
      <path d="M2 8l6 2.75L14 8" />
      <path d="M2 11.5l3.5 1.6" />
      <path d="M11.75 10.5v3.5M10 12.25h3.5" />
    </svg>
  );
}

function FilterGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.25 3.25h11.5L9.5 8.25v4l-3 1.5v-5.5L2.25 3.25Z" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M8 3.25v9.5M3.25 8h9.5" />
    </svg>
  );
}

function MoreDotsGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}

function ChevronGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${styles.chevronIcon} ${expanded ? styles.chevronExpanded : ''}`}
      aria-hidden="true"
    >
      <path d="M6 3.75L10.25 8 6 12.25" />
    </svg>
  );
}

function RunningFourDot({ cascadeId, label }: { cascadeId: string; label: string }) {
  return (
    <span
      className={styles.runningGrid}
      data-testid={`session-running-${cascadeId}`}
      role="status"
      aria-label={label}
      title={label}
    >
      <span className={`${styles.runningDot} ${styles.runningDot1}`} />
      <span className={`${styles.runningDot} ${styles.runningDot2}`} />
      <span className={`${styles.runningDot} ${styles.runningDot3}`} />
      <span className={`${styles.runningDot} ${styles.runningDot4}`} />
    </span>
  );
}

interface SessionSidebarRowProps {
  session: SessionSummary;
  isActive: boolean;
  showProjectSubtitle?: boolean;
  projectLabel?: string;
  locale: Locale;
  t: TranslateFn;
  projects: ProjectItem[];
  isMenuOpen: boolean;
  canMutateOrg: boolean;
  canAdminWorkspace: boolean;
  isL0: boolean;
  isL1: boolean;
  canDragReorder: boolean;
  containerId: string;
  zone: DndZone;
  zoneIndex: number;
  zoneTotal: number;
  isDragSource: boolean;
  isKeyboardReordering: boolean;
  onToggleMenu: (cascadeId: string) => void;
  onSelectSession: (cascadeId: string) => void;
  onPinSession?: (cascadeId: string, pinned: boolean) => Promise<void> | void;
  onAssignSessionProject?: (cascadeId: string, projectId: string | null) => Promise<void> | void;
  onMarkSessionRead?: (cascadeId: string) => Promise<void> | void;
  onArchiveSession?: (session: SessionSummary, archived: boolean) => Promise<void> | void;
  onRequestDeleteSession?: (session: SessionSummary) => void;
  onReorderAction?: (
    targetType: DndTargetType,
    containerId: string,
    zone: DndZone,
    id: string,
    action: ReorderMenuAction,
  ) => void;
  onPointerDragStart?: (
    ev: React.PointerEvent,
    item: DragItemMeta,
    isHandle: boolean,
  ) => void;
  onHandleKeyDown?: (ev: React.KeyboardEvent, item: DragItemMeta) => void;
}

const SessionSidebarRow = React.memo(function SessionSidebarRow({
  session,
  isActive,
  showProjectSubtitle = false,
  projectLabel,
  locale,
  t,
  projects,
  isMenuOpen,
  canMutateOrg,
  canAdminWorkspace,
  isL0,
  isL1,
  canDragReorder,
  containerId,
  zone,
  zoneIndex,
  zoneTotal,
  isDragSource,
  isKeyboardReordering,
  onToggleMenu,
  onSelectSession,
  onPinSession,
  onAssignSessionProject,
  onMarkSessionRead,
  onArchiveSession,
  onRequestDeleteSession,
  onReorderAction,
  onPointerDragStart,
  onHandleKeyDown,
}: SessionSidebarRowProps) {
  const [copiedId, setCopiedId] = useState(false);
  const running = isSessionRunning(session);
  const unread = !running && session.unread === true;
  const timeLabel = formatRelativeTime(
    session.lastCompletedTime || session.lastModifiedTime || session.createdTime,
    locale,
  );
  const displayTitle = formatSessionTitle(session, t);
  const isPinned = session.pinned === true;
  const hasKnownProject = Boolean(
    session.projectId && projects.some((proj) => proj.id === session.projectId),
  );
  const hasActions = Boolean(
    onPinSession ||
      onAssignSessionProject ||
      onMarkSessionRead ||
      onArchiveSession ||
      onRequestDeleteSession ||
      onReorderAction,
  );
  const hasMoreMenu = Boolean(
    onAssignSessionProject ||
      onMarkSessionRead ||
      onArchiveSession ||
      onRequestDeleteSession ||
      onReorderAction,
  );

  const dragMeta: DragItemMeta = {
    targetType: 'session',
    id: session.cascadeId,
    label: displayTitle,
    zone,
    containerId,
  };

  const handleCopySessionId = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(session.cascadeId);
      }
      setCopiedId(true);
      window.setTimeout(() => setCopiedId(false), 1500);
    } catch {
      // Ignore clipboard failures
    }
  };

  const isFirstInZone = zoneIndex <= 0;
  const isLastInZone = zoneTotal <= 1 || zoneIndex >= zoneTotal - 1;

  return (
    <div
      role="listitem"
      className={`${styles.item} ${isActive ? styles.itemActive : ''} ${isMenuOpen ? styles.itemMenuOpen : ''} ${isDragSource ? styles.dragSourcePlaceholder : ''} ${isKeyboardReordering ? styles.keyboardReordering : ''}`}
      onClick={() => onSelectSession(session.cascadeId)}
      onContextMenu={(e) => {
        if (!hasMoreMenu) return;
        e.preventDefault();
        e.stopPropagation();
        onToggleMenu(session.cascadeId);
      }}
      onPointerDown={(e) => {
        if (canDragReorder) onPointerDragStart?.(e, dragMeta, false);
      }}
      data-active={isActive ? 'true' : 'false'}
      data-session-id={session.cascadeId}
      data-pinned={isPinned ? 'true' : 'false'}
      data-dnd-item="1"
      data-dnd-type="session"
      data-dnd-id={session.cascadeId}
      data-dnd-container={containerId}
      data-dnd-zone={zone}
    >
      <div className={styles.itemLine1}>
        {canDragReorder && (
          <button
            type="button"
            className={styles.dragHandleBtn}
            data-drag-handle="1"
            data-testid={`drag-handle-session-${session.cascadeId}`}
            aria-label={t('sidebarOrg.dragHandleAria')}
            title={t('sidebarOrg.dragHandleAria')}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => onPointerDragStart?.(e, dragMeta, true)}
            onKeyDown={(e) => onHandleKeyDown?.(e, dragMeta)}
          >
            <DragDotsGlyph />
          </button>
        )}

        <button
          type="button"
          className={styles.itemTitleBtn}
          aria-current={isActive ? 'true' : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onSelectSession(session.cascadeId);
          }}
          title={displayTitle}
        >
          {displayTitle}
        </button>

        <div className={styles.itemRight}>
          <div className={styles.itemStatusMeta}>
            {isPinned && (
              <span
                className={styles.pinnedBadgeIcon}
                data-testid={`session-pinned-badge-${session.cascadeId}`}
                aria-hidden="true"
              >
                <PinGlyph />
              </span>
            )}
            {running ? (
              <RunningFourDot cascadeId={session.cascadeId} label={t('sidebar.runningAria')} />
            ) : (
              <>
                {unread && (
                  <span
                    className={styles.unreadDot}
                    data-testid={`session-unread-${session.cascadeId}`}
                    aria-label={t('sidebar.unreadBadge')}
                    title={t('sidebar.unreadBadge')}
                  />
                )}
                {timeLabel && <span className={styles.timeLabel}>{timeLabel}</span>}
              </>
            )}
          </div>

          {hasActions && (
            <div
              className={`${styles.rowActions} ${isMenuOpen ? styles.rowActionsVisible : ''}`}
              onClick={(e) => e.stopPropagation()}
              data-no-drag="1"
            >
              {onPinSession && (
                <button
                  type="button"
                  className={`${styles.rowActionBtn} ${isPinned ? styles.pinBtnActive : ''}`}
                  data-testid={`pin-session-${session.cascadeId}`}
                  aria-pressed={isPinned}
                  disabled={!canMutateOrg}
                  title={
                    isL0
                      ? t('sidebarOrg.l0ReadOnlyHint')
                      : isPinned
                        ? t('sidebar.unpinSession')
                        : t('sidebar.pinSession')
                  }
                  aria-label={isPinned ? t('sidebar.unpinSession') : t('sidebar.pinSession')}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!canMutateOrg) return;
                    void onPinSession(session.cascadeId, !isPinned);
                  }}
                >
                  <PinGlyph />
                </button>
              )}
              {hasMoreMenu && (
                <button
                  type="button"
                  className={`${styles.rowActionBtn} ${isMenuOpen ? styles.rowActionBtnActive : ''}`}
                  data-testid={`session-actions-${session.cascadeId}`}
                  aria-expanded={isMenuOpen}
                  title={t('sidebar.moreActions')}
                  aria-label={t('sidebar.moreActions')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleMenu(session.cascadeId);
                  }}
                >
                  <MoreDotsGlyph />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {showProjectSubtitle && (
        <div className={styles.pinnedSubtitle}>
          <span className={styles.pinnedFolderIcon}>
            <FolderGlyph size={11} />
          </span>
          <span className={styles.pinnedProjectName}>{projectLabel || t('sidebar.noProject')}</span>
        </div>
      )}

      {isMenuOpen && (
        <div
          className={styles.rowActionsPopover}
          onClick={(e) => e.stopPropagation()}
          data-no-drag="1"
        >
          {onAssignSessionProject && (
            <label className={styles.assignField}>
              <span className={styles.assignFieldLabel}>{t('sidebar.assignProject')}</span>
              <select
                className={styles.assignSelect}
                data-testid={`assign-project-${session.cascadeId}`}
                aria-label={t('sidebar.assignProject')}
                title={t('sidebar.assignProject')}
                disabled={!canMutateOrg}
                value={session.projectId ?? ''}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  e.stopPropagation();
                  if (!canMutateOrg) return;
                  const nextVal = e.target.value;
                  void onAssignSessionProject(session.cascadeId, nextVal ? nextVal : null);
                  onToggleMenu(session.cascadeId);
                }}
              >
                <option value="">{t('sidebar.noProject')}</option>
                {!hasKnownProject && session.projectId && (
                  <option value={session.projectId}>
                    {session.projectName || session.projectId}
                  </option>
                )}
                {projects.map((proj) => (
                  <option key={proj.id} value={proj.id}>
                    {proj.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {onReorderAction && canDragReorder && zoneTotal > 1 && (
            <>
              <div className={styles.popoverDivider} />
              <div className={styles.popoverReorderRow}>
                <button
                  type="button"
                  className={styles.popoverMiniBtn}
                  disabled={isFirstInZone}
                  data-testid={`reorder-session-first-${session.cascadeId}`}
                  onClick={() => {
                    onReorderAction('session', containerId, zone, session.cascadeId, 'first');
                    onToggleMenu(session.cascadeId);
                  }}
                >
                  {t('sidebarOrg.moveFirst')}
                </button>
                <button
                  type="button"
                  className={styles.popoverMiniBtn}
                  disabled={isFirstInZone}
                  data-testid={`reorder-session-up-${session.cascadeId}`}
                  onClick={() => {
                    onReorderAction('session', containerId, zone, session.cascadeId, 'up');
                    onToggleMenu(session.cascadeId);
                  }}
                >
                  {t('sidebarOrg.moveUp')}
                </button>
                <button
                  type="button"
                  className={styles.popoverMiniBtn}
                  disabled={isLastInZone}
                  data-testid={`reorder-session-down-${session.cascadeId}`}
                  onClick={() => {
                    onReorderAction('session', containerId, zone, session.cascadeId, 'down');
                    onToggleMenu(session.cascadeId);
                  }}
                >
                  {t('sidebarOrg.moveDown')}
                </button>
                <button
                  type="button"
                  className={styles.popoverMiniBtn}
                  disabled={isLastInZone}
                  data-testid={`reorder-session-last-${session.cascadeId}`}
                  onClick={() => {
                    onReorderAction('session', containerId, zone, session.cascadeId, 'last');
                    onToggleMenu(session.cascadeId);
                  }}
                >
                  {t('sidebarOrg.moveLast')}
                </button>
              </div>
            </>
          )}

          <div className={styles.popoverActionRow}>
            {unread && onMarkSessionRead && (
              <button
                type="button"
                className={styles.popoverMiniBtn}
                onClick={(e) => {
                  e.stopPropagation();
                  void onMarkSessionRead(session.cascadeId);
                  onToggleMenu(session.cascadeId);
                }}
              >
                {t('sidebar.markRead')}
              </button>
            )}
            <button
              type="button"
              className={styles.popoverMiniBtn}
              onClick={(e) => {
                e.stopPropagation();
                void handleCopySessionId();
              }}
            >
              {copiedId ? t('sidebar.copiedId') : t('sidebar.copySessionId')}
            </button>
            {onArchiveSession && (
              <button
                type="button"
                className={styles.popoverMiniBtn}
                data-testid={`archive-session-${session.cascadeId}`}
                disabled={!canMutateOrg}
                title={isL0 ? t('sidebarOrg.l0ReadOnlyHint') : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!canMutateOrg) return;
                  onToggleMenu(session.cascadeId);
                  void onArchiveSession(session, true);
                }}
              >
                {t('sidebarOrg.archiveSession')}
              </button>
            )}
            {onRequestDeleteSession && (
              <button
                type="button"
                className={`${styles.popoverMiniBtn} ${styles.popoverDangerBtn}`}
                data-testid={`delete-session-${session.cascadeId}`}
                disabled={!canAdminWorkspace}
                title={
                  isL0
                    ? t('sidebarOrg.l0ReadOnlyHint')
                    : isL1
                      ? t('sidebarOrg.l1DeleteDisabledHint')
                      : undefined
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (!canAdminWorkspace) return;
                  onToggleMenu(session.cascadeId);
                  onRequestDeleteSession(session);
                }}
              >
                {t('sidebarOrg.deleteSession')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

interface ProjectTreeItemProps {
  project: ProjectItem;
  sessions: SessionSummary[];
  totalSessionCount: number;
  runningCount?: number;
  unreadCount?: number;
  isExpanded: boolean;
  isFilterSelected: boolean;
  creating: boolean;
  groups: ProjectGroup[];
  t: TranslateFn;
  canMutateOrg: boolean;
  canAdminWorkspace: boolean;
  isL0: boolean;
  canDragReorder: boolean;
  containerId: string;
  zone: DndZone;
  zoneIndex: number;
  zoneTotal: number;
  isMenuOpen: boolean;
  isDragSource: boolean;
  isKeyboardReordering: boolean;
  onToggleMenu: (projectId: string) => void;
  onHeaderClick: (projectId: string) => void;
  onCreateSession: (opts?: {
    projectId?: string | null;
    workspaceUri?: string;
    standalone?: boolean;
  }) => void;
  onPinProject?: (project: ProjectItem, pinned: boolean) => Promise<void> | void;
  onUpdateProject?: (
    id: string,
    patch: {
      name?: string;
      groupId?: string | null;
      icon?: string | null;
      workspaceUri?: string;
      rootPath?: string;
    },
  ) => Promise<void> | void;
  onDeleteProject?: (id: string) => Promise<void> | void;
  onReorderAction?: (
    targetType: DndTargetType,
    containerId: string,
    zone: DndZone,
    id: string,
    action: ReorderMenuAction,
  ) => void;
  onPointerDragStart?: (
    ev: React.PointerEvent,
    item: DragItemMeta,
    isHandle: boolean,
  ) => void;
  onHandleKeyDown?: (ev: React.KeyboardEvent, item: DragItemMeta) => void;
  renderSessionRow: (
    session: SessionSummary,
    containerId: string,
    zone: DndZone,
    idx: number,
    total: number,
  ) => React.ReactNode;
}

const ProjectTreeItem = React.memo(function ProjectTreeItem({
  project,
  sessions,
  totalSessionCount,
  runningCount = 0,
  unreadCount = 0,
  isExpanded,
  isFilterSelected,
  creating,
  groups,
  t,
  canMutateOrg,
  canAdminWorkspace,
  isL0,
  canDragReorder,
  containerId,
  zone,
  zoneIndex,
  zoneTotal,
  isMenuOpen,
  isDragSource,
  isKeyboardReordering,
  onToggleMenu,
  onHeaderClick,
  onCreateSession,
  onPinProject,
  onUpdateProject,
  onDeleteProject,
  onReorderAction,
  onPointerDragStart,
  onHandleKeyDown,
  renderSessionRow,
}: ProjectTreeItemProps) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(project.name);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const syncedFromApp = isSyncedAppProject(project);
  const isPinned = project.pinned === true;
  const canMoveToGroup =
    (!project.implicit || syncedFromApp) && Boolean(onUpdateProject) && groups.length > 0;
  const canRename = (!project.implicit || syncedFromApp) && Boolean(onUpdateProject);
  const canEditIcon = Boolean(onUpdateProject);
  const workspaceUri = toWorkspaceUri(project.rootPath);

  useEffect(() => {
    if (!isMenuOpen) {
      setShowIconPicker(false);
    }
  }, [isMenuOpen]);

  const handleSetProjectIcon = (nextIcon: string | null) => {
    if (!canMutateOrg || !onUpdateProject) return;
    void onUpdateProject(project.id, {
      icon: nextIcon,
      ...(project.implicit || syncedFromApp
        ? { workspaceUri, rootPath: project.rootPath }
        : {}),
    });
    setShowIconPicker(false);
    onToggleMenu(project.id);
  };

  const dragMeta: DragItemMeta = {
    targetType: 'project',
    id: project.id,
    label: project.name,
    zone,
    containerId,
    fromGroupId: project.groupId ?? null,
    workspaceUri,
  };

  const isFirstInZone = zoneIndex <= 0;
  const isLastInZone = zoneTotal <= 1 || zoneIndex >= zoneTotal - 1;

  const handleRenameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const nextName = nameDraft.trim();
    if (nextName && nextName !== project.name) {
      void onUpdateProject?.(project.id, { name: nextName });
    }
    setEditingName(false);
  };

  return (
    <div className={styles.projectNode}>
      {editingName ? (
        <form
          className={styles.inlineRenameRow}
          onSubmit={handleRenameSubmit}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            className={styles.inlineRenameInput}
            value={nameDraft}
            autoFocus
            aria-label={t('sidebar.renameProject')}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setNameDraft(project.name);
                setEditingName(false);
              }
            }}
          />
          <button type="submit" className={styles.inlineRenameSaveBtn}>
            {t('common.save')}
          </button>
          <button
            type="button"
            className={styles.inlineRenameCancelBtn}
            onClick={() => {
              setNameDraft(project.name);
              setEditingName(false);
            }}
          >
            ×
          </button>
        </form>
      ) : (
        <div
          className={`${styles.projectItem} ${isFilterSelected ? styles.projectItemActive : ''} ${isDragSource ? styles.dragSourcePlaceholder : ''} ${isKeyboardReordering ? styles.keyboardReordering : ''}`}
          data-testid={`project-item-${project.id}`}
          data-active={isFilterSelected ? 'true' : 'false'}
          data-expanded={isExpanded ? 'true' : 'false'}
          data-pinned={isPinned ? 'true' : 'false'}
          data-source={syncedFromApp ? 'app' : project.implicit ? 'implicit' : 'custom'}
          data-dnd-item="1"
          data-dnd-type="project"
          data-dnd-id={project.id}
          data-dnd-container={containerId}
          data-dnd-zone={zone}
          onClick={() => onHeaderClick(project.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleMenu(project.id);
          }}
          onPointerDown={(e) => {
            if (canDragReorder) onPointerDragStart?.(e, dragMeta, false);
          }}
        >
          {canDragReorder && (
            <button
              type="button"
              className={styles.dragHandleBtn}
              data-drag-handle="1"
              data-testid={`drag-handle-project-${project.id}`}
              aria-label={t('sidebarOrg.dragHandleAria')}
              title={t('sidebarOrg.dragHandleAria')}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => onPointerDragStart?.(e, dragMeta, true)}
              onKeyDown={(e) => onHandleKeyDown?.(e, dragMeta)}
            >
              <DragDotsGlyph />
            </button>
          )}
          <button
            type="button"
            className={styles.projectMainBtn}
            aria-expanded={isExpanded}
            title={project.rootPath || project.name}
            onClick={(e) => {
              e.stopPropagation();
              onHeaderClick(project.id);
            }}
          >
            <span className={styles.projectFolderIcon} data-testid={`project-icon-${project.id}`}>
              <EntityIcon icon={project.icon} kind="project" size={13} />
            </span>
            <span className={styles.projectName}>{project.name}</span>
            <span className={styles.projectMeta}>
              {isPinned && (
                <span
                  className={styles.pinnedBadgeIcon}
                  data-testid={`project-pinned-badge-${project.id}`}
                  aria-hidden="true"
                >
                  <PinGlyph />
                </span>
              )}
              {runningCount > 0 && (
                <span
                  className={styles.projectRunningDot}
                  title={t('sidebar.filterRunning')}
                  aria-label={t('sidebar.filterRunning')}
                />
              )}
              {runningCount === 0 && unreadCount > 0 && (
                <span
                  className={styles.projectUnreadDot}
                  title={t('sidebar.unreadBadge')}
                  aria-label={t('sidebar.unreadBadge')}
                />
              )}
              {syncedFromApp && (
                <span
                  className={styles.appSyncBadge}
                  data-testid={`project-app-badge-${project.id}`}
                  title={t('sidebar.syncedFromApp')}
                >
                  {t('sidebar.syncedFromApp')}
                </span>
              )}
              <span
                className={styles.projectSessionCount}
                data-testid={`project-session-count-${project.id}`}
                aria-label={t('sidebar.sessionCount')}
              >
                {totalSessionCount}
              </span>
            </span>
          </button>
          <div
            className={styles.projectActions}
            onClick={(e) => e.stopPropagation()}
            data-no-drag="1"
          >
            {onPinProject && (
              <button
                type="button"
                className={`${styles.iconBtn} ${isPinned ? styles.pinBtnActive : ''}`}
                data-testid={`pin-project-${project.id}`}
                aria-pressed={isPinned}
                disabled={!canMutateOrg}
                title={
                  isL0
                    ? t('sidebarOrg.l0ReadOnlyHint')
                    : isPinned
                      ? t('sidebarOrg.unpinProject')
                      : t('sidebarOrg.pinProject')
                }
                aria-label={
                  isPinned ? t('sidebarOrg.unpinProject') : t('sidebarOrg.pinProject')
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (!canMutateOrg) return;
                  void onPinProject(project, !isPinned);
                }}
              >
                <PinGlyph />
              </button>
            )}
            <button
              type="button"
              className={styles.iconBtn}
              data-testid={`project-new-session-${project.id}`}
              title={t('sidebar.newSessionInProject')}
              aria-label={t('sidebar.newSessionInProject')}
              disabled={creating}
              onClick={(e) => {
                e.stopPropagation();
                onCreateSession({
                  projectId: project.id,
                  workspaceUri,
                });
              }}
            >
              +
            </button>
            {canRename && (
              <button
                type="button"
                className={styles.iconBtn}
                data-testid={`rename-project-${project.id}`}
                disabled={!canMutateOrg}
                title={isL0 ? t('sidebarOrg.l0ReadOnlyHint') : t('sidebar.renameProject')}
                aria-label={`${t('sidebar.renameProject')} ${project.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!canMutateOrg) return;
                  setNameDraft(project.name);
                  setEditingName(true);
                }}
              >
                <EditGlyph />
              </button>
            )}
            {canMoveToGroup && onUpdateProject && (
              <select
                className={styles.projectMoveSelect}
                data-testid={`move-project-group-${project.id}`}
                aria-label={t('sidebar.moveToGroup')}
                title={isL0 ? t('sidebarOrg.l0ReadOnlyHint') : t('sidebar.moveToGroup')}
                disabled={!canMutateOrg}
                value={project.groupId ?? ''}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  e.stopPropagation();
                  if (!canMutateOrg) return;
                  const nextGroupId = e.target.value || null;
                  void onUpdateProject(project.id, { groupId: nextGroupId });
                }}
              >
                <option value="">{t('sidebar.ungroupedProjects')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className={styles.iconBtn}
              data-testid={`project-actions-${project.id}`}
              aria-expanded={isMenuOpen}
              title={t('sidebar.moreActions')}
              aria-label={t('sidebar.moreActions')}
              onClick={(e) => {
                e.stopPropagation();
                onToggleMenu(project.id);
              }}
            >
              <MoreDotsGlyph />
            </button>
            {!project.implicit && onDeleteProject && (
              <button
                type="button"
                className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                data-testid={`delete-project-${project.id}`}
                disabled={!canAdminWorkspace}
                title={
                  isL0
                    ? t('sidebarOrg.l0ReadOnlyHint')
                    : !canAdminWorkspace
                      ? t('sidebarOrg.l1NewProjectDisabledHint')
                      : t('sidebar.deleteProject')
                }
                aria-label={t('sidebar.deleteProject')}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!canAdminWorkspace) return;
                  void onDeleteProject(project.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
      )}

      {isMenuOpen && !editingName && (
        <div
          className={styles.projectMenuPopover}
          onClick={(e) => e.stopPropagation()}
          data-no-drag="1"
        >
          {onUpdateProject && groups.length > 0 && (
            <label className={styles.assignField}>
              <span className={styles.assignFieldLabel}>{t('sidebar.moveToGroup')}</span>
              <select
                className={styles.assignSelect}
                disabled={!canMutateOrg}
                value={project.groupId ?? ''}
                onChange={(e) => {
                  if (!canMutateOrg) return;
                  const nextGroupId = e.target.value || null;
                  void onUpdateProject(project.id, { groupId: nextGroupId });
                  onToggleMenu(project.id);
                }}
              >
                <option value="">{t('sidebar.ungroupedProjects')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {onReorderAction && canDragReorder && zoneTotal > 1 && (
            <div className={styles.popoverReorderRow}>
              <button
                type="button"
                className={styles.popoverMiniBtn}
                disabled={isFirstInZone}
                data-testid={`reorder-project-first-${project.id}`}
                onClick={() => {
                  onReorderAction('project', containerId, zone, project.id, 'first');
                  onToggleMenu(project.id);
                }}
              >
                {t('sidebarOrg.moveFirst')}
              </button>
              <button
                type="button"
                className={styles.popoverMiniBtn}
                disabled={isFirstInZone}
                data-testid={`reorder-project-up-${project.id}`}
                onClick={() => {
                  onReorderAction('project', containerId, zone, project.id, 'up');
                  onToggleMenu(project.id);
                }}
              >
                {t('sidebarOrg.moveUp')}
              </button>
              <button
                type="button"
                className={styles.popoverMiniBtn}
                disabled={isLastInZone}
                data-testid={`reorder-project-down-${project.id}`}
                onClick={() => {
                  onReorderAction('project', containerId, zone, project.id, 'down');
                  onToggleMenu(project.id);
                }}
              >
                {t('sidebarOrg.moveDown')}
              </button>
              <button
                type="button"
                className={styles.popoverMiniBtn}
                disabled={isLastInZone}
                data-testid={`reorder-project-last-${project.id}`}
                onClick={() => {
                  onReorderAction('project', containerId, zone, project.id, 'last');
                  onToggleMenu(project.id);
                }}
              >
                {t('sidebarOrg.moveLast')}
              </button>
            </div>
          )}
          <div className={styles.popoverActionRow}>
            {onPinProject && (
              <button
                type="button"
                className={styles.popoverMiniBtn}
                disabled={!canMutateOrg}
                onClick={() => {
                  if (!canMutateOrg) return;
                  void onPinProject(project, !isPinned);
                  onToggleMenu(project.id);
                }}
              >
                {isPinned ? t('sidebarOrg.unpinProject') : t('sidebarOrg.pinProject')}
              </button>
            )}
            {canEditIcon && (
              <button
                type="button"
                className={styles.popoverMiniBtn}
                data-testid={`set-project-icon-${project.id}`}
                aria-expanded={showIconPicker}
                disabled={!canMutateOrg}
                onClick={() => {
                  if (!canMutateOrg) return;
                  setShowIconPicker((prev) => !prev);
                }}
              >
                {t('sidebar.setIcon')}
              </button>
            )}
            {canRename && (
              <button
                type="button"
                className={styles.popoverMiniBtn}
                disabled={!canMutateOrg}
                onClick={() => {
                  if (!canMutateOrg) return;
                  setNameDraft(project.name);
                  setEditingName(true);
                  onToggleMenu(project.id);
                }}
              >
                {t('sidebar.renameProject')}
              </button>
            )}
            {!project.implicit && onDeleteProject && (
              <button
                type="button"
                className={`${styles.popoverMiniBtn} ${styles.popoverDangerBtn}`}
                disabled={!canAdminWorkspace}
                onClick={() => {
                  if (!canAdminWorkspace) return;
                  onToggleMenu(project.id);
                  void onDeleteProject(project.id);
                }}
              >
                {t('sidebar.deleteProject')}
              </button>
            )}
          </div>
          {showIconPicker && canEditIcon && (
            <EntityIconPicker
              value={project.icon}
              disabled={!canMutateOrg}
              t={t}
              testIdPrefix={`project-icon-${project.id}`}
              onSelect={handleSetProjectIcon}
              onClose={() => setShowIconPicker(false)}
            />
          )}
        </div>
      )}

      {isExpanded && (
        <div
          className={styles.projectSessions}
          data-testid={`project-sessions-${project.id}`}
        >
          {sessions.length > 0 ? (
            sessions.map((s, idx) => renderSessionRow(s, project.id, 'normal', idx, sessions.length))
          ) : (
            <div className={styles.emptyProjectRow}>
              <span className={styles.emptyProjectHint}>{t('sidebar.noSessionsInProject')}</span>
              <button
                type="button"
                className={styles.emptyProjectNewBtn}
                disabled={creating}
                onClick={() =>
                  onCreateSession({
                    projectId: project.id,
                    workspaceUri,
                  })
                }
              >
                + {t('sidebar.startFirstSession')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export const SessionSidebar = React.memo(function SessionSidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  loading = false,
  creating = false,
  searchQuery,
  onSearchQueryChange,
  projects = [],
  projectGroups = [],
  selectedProjectFilter,
  onSelectProjectFilter,
  defaultSessionPath,
  hiddenInternalCount = 0,
  includeInternal = false,
  onToggleIncludeInternal,
  permissionLevel = 'L2',
  channel = 'loopback',
  groupOrder,
  projectOrder,
  sessionOrder,
  archivedCount = 0,
  archivedSessions = [],
  loadingArchived = false,
  viewMode: controlledViewMode,
  onViewModeChange,
  onPinSession,
  onPinProject,
  onPinGroup,
  onAssignSessionProject,
  onArchiveSession,
  onRequestDeleteSession,
  onReorderOrg,
  onOpenNewProjectModal,
  onDraggingChange,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  onCreateGroup,
  onToggleGroupCollapsed,
  onRenameGroup,
  onUpdateGroup,
  onDeleteGroup,
  onMarkSessionRead,
}: SessionSidebarProps) {
  const { locale, t } = useI18n();
  const [internalQuery, setInternalQuery] = useState('');
  const [internalFilter, setInternalFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'unread'>('all');
  const [internalViewMode, setInternalViewMode] = useState<'active' | 'archived'>('active');
  const [localGroupCollapsed, setLocalGroupCollapsed] = useState<Record<string, boolean>>({});
  const [tempExpandedGroups, setTempExpandedGroups] = useState<Record<string, boolean>>({});
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [quietProjectsExpanded, setQuietProjectsExpanded] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState('');
  const [openActionSessionId, setOpenActionSessionId] = useState<string | null>(null);
  const [openActionProjectId, setOpenActionProjectId] = useState<string | null>(null);
  const [openActionGroupId, setOpenActionGroupId] = useState<string | null>(null);
  const [showFilterDrawer, setShowFilterDrawer] = useState(false);

  const [showNewProjectForm, setShowNewProjectForm] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectPath, setProjectPath] = useState(defaultSessionPath || '');
  const [projectGroupId, setProjectGroupId] = useState('');
  const [projectCreateDir, setProjectCreateDir] = useState(false);
  const [submittingProject, setSubmittingProject] = useState(false);

  const [showNewGroupForm, setShowNewGroupForm] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [newGroupIcon, setNewGroupIcon] = useState<string | null>(null);
  const [showNewGroupIconPicker, setShowNewGroupIconPicker] = useState(false);
  const [iconPickerGroupId, setIconPickerGroupId] = useState<string | null>(null);
  const [submittingGroup, setSubmittingGroup] = useState(false);

  const listContainerRef = useRef<HTMLDivElement | null>(null);

  const isLoopback = !channel || channel === 'loopback';
  const isL0 = !isLoopback && permissionLevel === 'L0';
  const isL1 = !isLoopback && permissionLevel === 'L1';
  const canMutateOrg = !isL0;
  const canAdminWorkspace = isLoopback || (!isL0 && !isL1);

  const viewMode = controlledViewMode ?? internalViewMode;
  const setViewMode = useCallback(
    (next: 'active' | 'archived') => {
      if (controlledViewMode === undefined) setInternalViewMode(next);
      onViewModeChange?.(next);
    },
    [controlledViewMode, onViewModeChange],
  );

  const effectiveQuery = searchQuery !== undefined ? searchQuery : internalQuery;
  const deferredQuery = useDeferredValue(effectiveQuery);
  const effectiveFilter = selectedProjectFilter !== undefined ? selectedProjectFilter : internalFilter;
  const hasActiveFilterState = Boolean(
    effectiveQuery.trim() ||
      effectiveFilter !== 'all' ||
      includeInternal ||
      statusFilter !== 'all' ||
      viewMode === 'archived',
  );

  const handleSearchChange = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const next = ev.target.value;
    if (searchQuery === undefined) {
      setInternalQuery(next);
    }
    onSearchQueryChange?.(next);
  };

  const handleFilterChange = (nextFilter: string) => {
    if (selectedProjectFilter === undefined) {
      setInternalFilter(nextFilter);
    }
    onSelectProjectFilter?.(nextFilter);
  };

  const handleToggleProjectForm = () => {
    if (!canAdminWorkspace) return;
    if (onOpenNewProjectModal) {
      setShowNewGroupForm(false);
      onOpenNewProjectModal();
      return;
    }
    setShowNewProjectForm((prev) => {
      const next = !prev;
      if (next) {
        setShowNewGroupForm(false);
        if (!projectPath && defaultSessionPath) {
          setProjectPath(defaultSessionPath);
        }
      }
      return next;
    });
  };

  const handleToggleGroupForm = () => {
    if (!canMutateOrg) return;
    setShowNewGroupForm((prev) => {
      const next = !prev;
      if (next) {
        setShowNewProjectForm(false);
      }
      return next;
    });
  };

  const handleCreateProjectSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!onCreateProject || submittingProject || !canAdminWorkspace) return;
    const trimmedName = projectName.trim();
    const trimmedPath = (projectPath || defaultSessionPath || '').trim();
    if (!trimmedName || !trimmedPath) return;

    setSubmittingProject(true);
    try {
      await onCreateProject({
        name: trimmedName,
        rootPath: trimmedPath,
        groupId: projectGroupId ? projectGroupId : null,
        createDir: projectCreateDir,
      });
      setProjectName('');
      setProjectPath(defaultSessionPath || '');
      setProjectGroupId('');
      setProjectCreateDir(false);
      setShowNewProjectForm(false);
    } finally {
      setSubmittingProject(false);
    }
  };

  const handleCreateGroupSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!onCreateGroup || submittingGroup || !canMutateOrg) return;
    const trimmedName = groupName.trim();
    if (!trimmedName) return;

    setSubmittingGroup(true);
    try {
      if (newGroupIcon) {
        await onCreateGroup(trimmedName, newGroupIcon);
      } else {
        await onCreateGroup(trimmedName);
      }
      setGroupName('');
      setNewGroupIcon(null);
      setShowNewGroupIconPicker(false);
      setShowNewGroupForm(false);
    } finally {
      setSubmittingGroup(false);
    }
  };

  const projectById = useMemo(() => {
    const map = new Map<string, ProjectItem>();
    for (const proj of projects) {
      map.set(proj.id, proj);
    }
    return map;
  }, [projects]);

  const { pinnedGroups, normalGroups, sortedGroups } = useMemo(() => {
    const { pinned, normal } = partitionAndOrderItems({
      items: projectGroups,
      isPinned: (g) => g.pinned === true,
      getId: (g) => g.id,
      order: groupOrder,
      defaultPinnedCompare: (a, b) =>
        parseTimestamp(b.pinnedAt) - parseTimestamp(a.pinnedAt) ||
        a.sortOrder - b.sortOrder ||
        a.name.localeCompare(b.name),
      defaultNormalCompare: (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    });
    return {
      pinnedGroups: pinned,
      normalGroups: normal,
      sortedGroups: [...pinned, ...normal],
    };
  }, [projectGroups, groupOrder]);

  const activeSessions = useMemo(
    () => sessions.filter((s) => s.archived !== true),
    [sessions],
  );

  const effectiveArchivedList = useMemo(() => {
    if (archivedSessions.length > 0) return archivedSessions;
    return sessions.filter((s) => s.archived === true);
  }, [archivedSessions, sessions]);

  const effectiveArchivedCount = Math.max(archivedCount, effectiveArchivedList.length);

  const projectActivityById = useMemo(() => {
    const map = new Map<
      string,
      {
        hasActive: boolean;
        runningCount: number;
        unreadCount: number;
        loadedCount: number;
        latestActivityMs: number;
      }
    >();
    for (const s of activeSessions) {
      if (!s.projectId) continue;
      const cur = map.get(s.projectId) ?? {
        hasActive: false,
        runningCount: 0,
        unreadCount: 0,
        loadedCount: 0,
        latestActivityMs: 0,
      };
      cur.loadedCount += 1;
      if (s.cascadeId === activeSessionId) cur.hasActive = true;
      const running = isSessionRunning(s);
      if (running) cur.runningCount += 1;
      else if (s.unread === true) cur.unreadCount += 1;
      const ts = Math.max(
        parseTimestamp(s.lastCompletedTime),
        parseTimestamp(s.lastModifiedTime),
        parseTimestamp(s.createdTime),
      );
      if (ts > cur.latestActivityMs) cur.latestActivityMs = ts;
      map.set(s.projectId, cur);
    }
    return map;
  }, [activeSessions, activeSessionId]);

  const compareProjectsSmart = useMemo(() => {
    return (a: ProjectItem, b: ProjectItem): number => {
      const ma = projectActivityById.get(a.id);
      const mb = projectActivityById.get(b.id);
      const aHasActive = ma?.hasActive ? 1 : 0;
      const bHasActive = mb?.hasActive ? 1 : 0;
      if (bHasActive !== aHasActive) return bHasActive - aHasActive;

      const aRunning = (ma?.runningCount ?? 0) > 0 ? 1 : 0;
      const bRunning = (mb?.runningCount ?? 0) > 0 ? 1 : 0;
      if (bRunning !== aRunning) return bRunning - aRunning;

      const aUnread = (ma?.unreadCount ?? 0) > 0 ? 1 : 0;
      const bUnread = (mb?.unreadCount ?? 0) > 0 ? 1 : 0;
      if (bUnread !== aUnread) return bUnread - aUnread;

      const aLoaded = (ma?.loadedCount ?? 0) > 0 ? 1 : 0;
      const bLoaded = (mb?.loadedCount ?? 0) > 0 ? 1 : 0;
      if (bLoaded !== aLoaded) return bLoaded - aLoaded;

      const aLatest = Math.max(
        ma?.latestActivityMs ?? 0,
        parseTimestamp(a.lastModifiedTime),
        parseTimestamp(a.updatedAt),
      );
      const bLatest = Math.max(
        mb?.latestActivityMs ?? 0,
        parseTimestamp(b.lastModifiedTime),
        parseTimestamp(b.updatedAt),
      );
      if (bLatest !== aLatest) return bLatest - aLatest;

      const aCount = Math.max(ma?.loadedCount ?? 0, a.sessionCount ?? 0);
      const bCount = Math.max(mb?.loadedCount ?? 0, b.sessionCount ?? 0);
      if ((bCount > 0 ? 1 : 0) !== (aCount > 0 ? 1 : 0)) {
        return bCount > 0 ? 1 : -1;
      }
      return 0;
    };
  }, [projectActivityById]);

  const { projectsByGroup, ungroupedPartitioned } = useMemo(() => {
    const groupIds = new Set(sortedGroups.map((g) => g.id));
    const groupedRaw = new Map<string, ProjectItem[]>();
    const ungroupedRaw: ProjectItem[] = [];
    for (const proj of projects) {
      if (proj.groupId && groupIds.has(proj.groupId)) {
        const list = groupedRaw.get(proj.groupId) ?? [];
        list.push(proj);
        groupedRaw.set(proj.groupId, list);
      } else {
        ungroupedRaw.push(proj);
      }
    }

    const grouped = new Map<string, { pinned: ProjectItem[]; normal: ProjectItem[] }>();
    for (const gid of groupIds) {
      const list = groupedRaw.get(gid) ?? [];
      grouped.set(
        gid,
        partitionAndOrderItems({
          items: list,
          isPinned: (p) => p.pinned === true,
          getId: (p) => p.id,
          order: projectOrder?.[gid],
          defaultPinnedCompare: (a, b) =>
            parseTimestamp(b.pinnedAt) - parseTimestamp(a.pinnedAt) || compareProjectsSmart(a, b),
          defaultNormalCompare: compareProjectsSmart,
        }),
      );
    }

    const ungrouped = partitionAndOrderItems({
      items: ungroupedRaw,
      isPinned: (p) => p.pinned === true,
      getId: (p) => p.id,
      order: projectOrder?.__ungrouped__,
      defaultPinnedCompare: (a, b) =>
        parseTimestamp(b.pinnedAt) - parseTimestamp(a.pinnedAt) || compareProjectsSmart(a, b),
      defaultNormalCompare: compareProjectsSmart,
    });

    return { projectsByGroup: grouped, ungroupedPartitioned: ungrouped };
  }, [projects, sortedGroups, projectOrder, compareProjectsSmart]);

  const compareSessionsTimeDesc = useCallback((a: SessionSummary, b: SessionSummary) => {
    const tb = parseTimestamp(b.lastModifiedTime) || parseTimestamp(b.createdTime);
    const ta = parseTimestamp(a.lastModifiedTime) || parseTimestamp(a.createdTime);
    return tb - ta;
  }, []);

  const compareSessionsPinnedDefault = useCallback(
    (a: SessionSummary, b: SessionSummary) => {
      const pa =
        parseTimestamp(a.pinnedAt) ||
        parseTimestamp(a.lastModifiedTime) ||
        parseTimestamp(a.createdTime);
      const pb =
        parseTimestamp(b.pinnedAt) ||
        parseTimestamp(b.lastModifiedTime) ||
        parseTimestamp(b.createdTime);
      if (pb !== pa) return pb - pa;
      return compareSessionsTimeDesc(a, b);
    },
    [compareSessionsTimeDesc],
  );

  const totalRunningCount = useMemo(
    () => activeSessions.filter((s) => isSessionRunning(s)).length,
    [activeSessions],
  );
  const totalUnreadCount = useMemo(
    () => activeSessions.filter((s) => !isSessionRunning(s) && s.unread === true).length,
    [activeSessions],
  );

  const matchesSessionSearch = useCallback(
    (s: SessionSummary, q: string) => {
      if (!q) return true;
      const wsName = extractWorkspaceName(s.workspaceUri) || '';
      const displayTitle = formatSessionTitle(s, t);
      const projName = s.projectId ? projectById.get(s.projectId)?.name || s.projectName || '' : '';
      const haystack = [
        displayTitle,
        s.title,
        s.summary,
        s.shortId || '',
        s.repoName || '',
        s.branchName || '',
        projName,
        wsName,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    },
    [projectById, t],
  );

  const filteredActiveSessions = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return activeSessions.filter((s) => {
      if (statusFilter === 'running' && !isSessionRunning(s)) return false;
      if (statusFilter === 'unread' && (isSessionRunning(s) || s.unread !== true)) return false;

      if (effectiveFilter === '__none__') {
        if (s.projectId) return false;
      } else if (effectiveFilter && effectiveFilter !== 'all') {
        if (s.projectId !== effectiveFilter) return false;
      }

      return matchesSessionSearch(s, q);
    });
  }, [activeSessions, statusFilter, effectiveFilter, deferredQuery, matchesSessionSearch]);

  const filteredArchivedSessions = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return [...effectiveArchivedList]
      .filter((s) => matchesSessionSearch(s, q))
      .sort(
        (a, b) =>
          parseTimestamp(b.archivedAt || b.lastModifiedTime) -
          parseTimestamp(a.archivedAt || a.lastModifiedTime),
      );
  }, [effectiveArchivedList, deferredQuery, matchesSessionSearch]);

  const archivedSearchMatchesCount = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return 0;
    return effectiveArchivedList.filter((s) => matchesSessionSearch(s, q)).length;
  }, [effectiveArchivedList, deferredQuery, matchesSessionSearch]);

  const allSessionCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of activeSessions) {
      if (s.projectId) {
        counts.set(s.projectId, (counts.get(s.projectId) ?? 0) + 1);
      }
    }
    return counts;
  }, [activeSessions]);

  const { pinnedSessions, regularByProject, standaloneRegularSessions } = useMemo(() => {
    const rawPinned: SessionSummary[] = [];
    const byProjectRaw = new Map<string, SessionSummary[]>();
    const standaloneRaw: SessionSummary[] = [];

    for (const s of filteredActiveSessions) {
      if (s.pinned === true) {
        rawPinned.push(s);
        continue;
      }
      if (s.projectId && projectById.has(s.projectId)) {
        const list = byProjectRaw.get(s.projectId) ?? [];
        list.push(s);
        byProjectRaw.set(s.projectId, list);
      } else {
        standaloneRaw.push(s);
      }
    }

    const pinned = sortPinnedQuickSessions(
      rawPinned,
      sessionOrder?.__pinned__,
      compareSessionsPinnedDefault,
    );

    const byProject = new Map<string, SessionSummary[]>();
    for (const [pid, list] of byProjectRaw.entries()) {
      const containerOrder = sessionOrder?.[pid] as ZoneOrder | undefined;
      byProject.set(
        pid,
        partitionAndOrderItems({
          items: list,
          isPinned: () => false,
          getId: (s) => s.cascadeId,
          order: containerOrder,
          defaultPinnedCompare: compareSessionsPinnedDefault,
          defaultNormalCompare: compareSessionsTimeDesc,
        }).normal,
      );
    }

    const standalone = partitionAndOrderItems({
      items: standaloneRaw,
      isPinned: () => false,
      getId: (s) => s.cascadeId,
      order: sessionOrder?.__standalone__,
      defaultPinnedCompare: compareSessionsPinnedDefault,
      defaultNormalCompare: compareSessionsTimeDesc,
    }).normal;

    return {
      pinnedSessions: pinned,
      regularByProject: byProject,
      standaloneRegularSessions: standalone,
    };
  }, [
    filteredActiveSessions,
    projectById,
    sessionOrder,
    compareSessionsPinnedDefault,
    compareSessionsTimeDesc,
  ]);

  const hasProjectsOrGroups = projects.length > 0 || projectGroups.length > 0;
  const isSearching = deferredQuery.trim().length > 0;
  const isSpecificProjectFilter = effectiveFilter !== 'all' && effectiveFilter !== '__none__';
  const canDragReorder =
    canMutateOrg &&
    Boolean(onReorderOrg) &&
    viewMode === 'active' &&
    !isSearching &&
    statusFilter === 'all' &&
    !isSpecificProjectFilter;

  const getZoneIds = useCallback(
    (targetType: DndTargetType, containerId: string, zone: DndZone): string[] => {
      if (targetType === 'group') {
        return (zone === 'pinned' ? pinnedGroups : normalGroups).map((g) => g.id);
      }
      if (targetType === 'project') {
        const part =
          containerId === '__ungrouped__'
            ? ungroupedPartitioned
            : projectsByGroup.get(containerId);
        if (!part) return [];
        return (zone === 'pinned' ? part.pinned : part.normal).map((p) => p.id);
      }
      if (containerId === '__pinned__') {
        return pinnedSessions.map((s) => s.cascadeId);
      }
      if (containerId === '__standalone__') {
        return standaloneRegularSessions.map((s) => s.cascadeId);
      }
      return (regularByProject.get(containerId) ?? []).map((s) => s.cascadeId);
    },
    [
      normalGroups,
      pinnedGroups,
      pinnedSessions,
      projectsByGroup,
      regularByProject,
      standaloneRegularSessions,
      ungroupedPartitioned,
    ],
  );

  const handleCommitReorder = useCallback(
    async (req: OrgReorderRequest) => {
      if (!onReorderOrg) return;
      await onReorderOrg(req);
    },
    [onReorderOrg],
  );

  const handleReorderAction = useCallback(
    (
      targetType: DndTargetType,
      containerId: string,
      zone: DndZone,
      id: string,
      action: ReorderMenuAction,
    ) => {
      if (!onReorderOrg || !canMutateOrg) return;
      const zoneIds = getZoneIds(targetType, containerId, zone);
      const next = reorderWithinZone(zoneIds, id, action);
      if (!next) return;
      void onReorderOrg({
        targetType,
        containerId,
        zone,
        orderedIds: next,
      });
    },
    [canMutateOrg, getZoneIds, onReorderOrg],
  );

  const drag = useSidebarDragSort({
    disabled: !canDragReorder,
    scrollContainerRef: listContainerRef,
    getZoneIds,
    onCommitReorder: handleCommitReorder,
    onTempExpandGroup: (gid) => {
      setTempExpandedGroups((prev) => ({ ...prev, [gid]: true }));
    },
    onDraggingChange: (dragging) => {
      if (!dragging) {
        setTempExpandedGroups({});
      }
      onDraggingChange?.(dragging);
    },
    formatAnnouncement: (kind, info) => {
      if (kind === 'active') return t('sidebarOrg.keyboardReorderActive', info);
      if (kind === 'moved') return t('sidebarOrg.keyboardReorderMoved', info);
      if (kind === 'saved') return t('sidebarOrg.keyboardReorderSaved', info);
      return t('sidebarOrg.keyboardReorderCancelled', info);
    },
  });

  useEffect(() => {
    if (!activeSessionId) return;
    const active = activeSessions.find((s) => s.cascadeId === activeSessionId);
    if (active?.projectId) {
      setCollapsedProjects((prev) =>
        prev[active.projectId!] ? { ...prev, [active.projectId!]: false } : prev,
      );
    }
  }, [activeSessionId, activeSessions]);

  const handleToggleGroup = (group: ProjectGroup) => {
    setTempExpandedGroups((prev) => {
      if (!prev[group.id]) return prev;
      const copy = { ...prev };
      delete copy[group.id];
      return copy;
    });
    if (onToggleGroupCollapsed) {
      void onToggleGroupCollapsed(group.id, !group.collapsed);
    } else {
      setLocalGroupCollapsed((prev) => ({
        ...prev,
        [group.id]: !(prev[group.id] ?? group.collapsed),
      }));
    }
  };

  const handleProjectHeaderClick = (projectId: string) => {
    if (effectiveFilter !== 'all' && effectiveFilter !== projectId) {
      handleFilterChange(projectId);
      return;
    }
    setCollapsedProjects((prev) => ({
      ...prev,
      [projectId]: !prev[projectId],
    }));
  };

  const handleToggleSessionMenu = useCallback((cascadeId: string) => {
    setOpenActionProjectId(null);
    setOpenActionGroupId(null);
    setOpenActionSessionId((prev) => (prev === cascadeId ? null : cascadeId));
  }, []);

  const handleToggleProjectMenu = useCallback((projectId: string) => {
    setOpenActionSessionId(null);
    setOpenActionGroupId(null);
    setOpenActionProjectId((prev) => (prev === projectId ? null : projectId));
  }, []);

  const handleToggleGroupMenu = useCallback((groupId: string) => {
    setOpenActionSessionId(null);
    setOpenActionProjectId(null);
    setOpenActionGroupId((prev) => {
      const next = prev === groupId ? null : groupId;
      if (next !== groupId) {
        setIconPickerGroupId((cur) => (cur === groupId ? null : cur));
      }
      return next;
    });
  }, []);

  const handleSelectSessionWithExpand = useCallback(
    (cascadeId: string) => {
      const target = activeSessions.find((s) => s.cascadeId === cascadeId);
      if (target?.projectId) {
        setCollapsedProjects((prev) =>
          prev[target.projectId!] ? { ...prev, [target.projectId!]: false } : prev,
        );
        const proj = projectById.get(target.projectId);
        if (proj?.groupId) {
          const grp = projectGroups.find((g) => g.id === proj.groupId);
          if (grp?.collapsed) {
            setTempExpandedGroups((prev) => ({ ...prev, [grp.id]: true }));
          }
        }
      }
      onSelectSession(cascadeId);
    },
    [activeSessions, onSelectSession, projectById, projectGroups],
  );

  const renderSessionRow = (
    session: SessionSummary,
    containerId: string,
    zone: DndZone,
    idx: number,
    total: number,
    isPinnedContext = false,
  ) => {
    const resolvedProjectLabel = session.projectId
      ? projectById.get(session.projectId)?.name || session.projectName || t('sidebar.noProject')
      : t('sidebar.noProject');

    const isDragSource =
      drag.draggingItem?.targetType === 'session' &&
      drag.draggingItem.id === session.cascadeId &&
      drag.draggingItem.containerId === containerId;
    const isKeyboardReordering =
      drag.keyboardState?.targetType === 'session' &&
      drag.keyboardState.id === session.cascadeId &&
      drag.keyboardState.containerId === containerId;

    return (
      <SessionSidebarRow
        key={`${containerId}:${session.cascadeId}`}
        session={session}
        isActive={session.cascadeId === activeSessionId}
        showProjectSubtitle={isPinnedContext}
        projectLabel={resolvedProjectLabel}
        locale={locale}
        t={t}
        projects={projects}
        isMenuOpen={openActionSessionId === session.cascadeId}
        canMutateOrg={canMutateOrg}
        canAdminWorkspace={canAdminWorkspace}
        isL0={isL0}
        isL1={isL1}
        canDragReorder={canDragReorder}
        containerId={containerId}
        zone={zone}
        zoneIndex={idx}
        zoneTotal={total}
        isDragSource={isDragSource}
        isKeyboardReordering={isKeyboardReordering}
        onToggleMenu={handleToggleSessionMenu}
        onSelectSession={handleSelectSessionWithExpand}
        onPinSession={onPinSession}
        onAssignSessionProject={onAssignSessionProject}
        onMarkSessionRead={onMarkSessionRead}
        onArchiveSession={onArchiveSession}
        onRequestDeleteSession={onRequestDeleteSession}
        onReorderAction={onReorderOrg ? handleReorderAction : undefined}
        onPointerDragStart={drag.startPointerCandidate}
        onHandleKeyDown={drag.handleHandleKeyDown}
      />
    );
  };

  const shouldRenderProject = useCallback(
    (proj: ProjectItem): boolean => {
      if (effectiveFilter === '__none__') return false;
      if (isSpecificProjectFilter) return proj.id === effectiveFilter;
      if (statusFilter !== 'all') {
        return (regularByProject.get(proj.id)?.length ?? 0) > 0;
      }
      if (isSearching) {
        const q = deferredQuery.trim().toLowerCase();
        const matchesProjectMeta =
          proj.name.toLowerCase().includes(q) ||
          (proj.rootPath || '').toLowerCase().includes(q);
        return matchesProjectMeta || (regularByProject.get(proj.id)?.length ?? 0) > 0;
      }
      return true;
    },
    [deferredQuery, effectiveFilter, isSearching, isSpecificProjectFilter, regularByProject, statusFilter],
  );

  const renderProjectNode = (
    proj: ProjectItem,
    containerId: string,
    zone: DndZone,
    idx: number,
    total: number,
  ) => {
    if (!shouldRenderProject(proj)) return null;
    const projSessions = regularByProject.get(proj.id) ?? [];
    const activity = projectActivityById.get(proj.id);
    const totalSessionCount = Math.max(
      allSessionCountByProject.get(proj.id) ?? 0,
      typeof proj.sessionCount === 'number' ? proj.sessionCount : 0,
    );
    const isExpanded =
      isSearching || isSpecificProjectFilter || statusFilter !== 'all'
        ? true
        : !collapsedProjects[proj.id];

    const isDragSource =
      drag.draggingItem?.targetType === 'project' && drag.draggingItem.id === proj.id;
    const isKeyboardReordering =
      drag.keyboardState?.targetType === 'project' && drag.keyboardState.id === proj.id;

    return (
      <ProjectTreeItem
        key={proj.id}
        project={proj}
        sessions={projSessions}
        totalSessionCount={totalSessionCount}
        runningCount={activity?.runningCount ?? 0}
        unreadCount={activity?.unreadCount ?? 0}
        isExpanded={isExpanded}
        isFilterSelected={effectiveFilter === proj.id}
        creating={creating}
        groups={sortedGroups}
        t={t}
        canMutateOrg={canMutateOrg}
        canAdminWorkspace={canAdminWorkspace}
        isL0={isL0}
        canDragReorder={canDragReorder}
        containerId={containerId}
        zone={zone}
        zoneIndex={idx}
        zoneTotal={total}
        isMenuOpen={openActionProjectId === proj.id}
        isDragSource={isDragSource}
        isKeyboardReordering={isKeyboardReordering}
        onToggleMenu={handleToggleProjectMenu}
        onHeaderClick={handleProjectHeaderClick}
        onCreateSession={onCreateSession}
        onPinProject={onPinProject}
        onUpdateProject={onUpdateProject}
        onDeleteProject={onDeleteProject}
        onReorderAction={onReorderOrg ? handleReorderAction : undefined}
        onPointerDragStart={drag.startPointerCandidate}
        onHandleKeyDown={drag.handleHandleKeyDown}
        renderSessionRow={(s, cid, z, sIdx, sTotal) =>
          renderSessionRow(s, cid, z, sIdx, sTotal, false)
        }
      />
    );
  };

  const { activeUngroupedNormal, quietUngroupedNormal } = useMemo(() => {
    const visibleNormal = ungroupedPartitioned.normal.filter(shouldRenderProject);
    if (isSearching || isSpecificProjectFilter || statusFilter !== 'all') {
      return { activeUngroupedNormal: visibleNormal, quietUngroupedNormal: [] as ProjectItem[] };
    }
    const activeList: ProjectItem[] = [];
    const quietList: ProjectItem[] = [];
    for (const p of visibleNormal) {
      const act = projectActivityById.get(p.id);
      const isActiveOrExplicit =
        Boolean(act?.hasActive) ||
        (act?.loadedCount ?? 0) > 0 ||
        (!isSyncedAppProject(p) && !p.implicit);
      if (isActiveOrExplicit) {
        activeList.push(p);
      } else {
        quietList.push(p);
      }
    }
    if (quietList.length < 4) {
      return { activeUngroupedNormal: visibleNormal, quietUngroupedNormal: [] as ProjectItem[] };
    }
    return { activeUngroupedNormal: activeList, quietUngroupedNormal: quietList };
  }, [
    ungroupedPartitioned.normal,
    shouldRenderProject,
    isSearching,
    isSpecificProjectFilter,
    statusFilter,
    projectActivityById,
  ]);

  const visiblePinnedUngrouped = useMemo(
    () => ungroupedPartitioned.pinned.filter(shouldRenderProject),
    [ungroupedPartitioned.pinned, shouldRenderProject],
  );

  const showInternalToggle = Boolean(onToggleIncludeInternal || hiddenInternalCount > 0);
  const hasVisibleProjects =
    effectiveFilter !== '__none__' && projects.some(shouldRenderProject);
  const showEmptyFilteredState =
    filteredActiveSessions.length === 0 &&
    ((isSearching && !hasVisibleProjects) ||
      effectiveFilter === '__none__' ||
      !hasProjectsOrGroups);

  const renderGroupNode = (
    group: ProjectGroup,
    zone: DndZone,
    zoneIdx: number,
    zoneTotal: number,
  ) => {
    const baseCollapsed = onToggleGroupCollapsed
      ? group.collapsed
      : (localGroupCollapsed[group.id] ?? group.collapsed);
    const isTempExpanded = Boolean(tempExpandedGroups[group.id]);
    const isCollapsed = isTempExpanded ? false : baseCollapsed;

    const part = projectsByGroup.get(group.id) ?? { pinned: [], normal: [] };
    const visiblePinned = part.pinned.filter(shouldRenderProject);
    const visibleNormal = part.normal.filter(shouldRenderProject);
    const allGroupProjects = [...part.pinned, ...part.normal];
    const visibleCount = visiblePinned.length + visibleNormal.length;

    if (isSpecificProjectFilter && visibleCount === 0) {
      return null;
    }
    if (isSearching && visibleCount === 0) {
      return null;
    }

    const effectiveCollapsed =
      isSearching || isSpecificProjectFilter ? false : isCollapsed;

    const isPinned = group.pinned === true;
    const isGroupMenuOpen = openActionGroupId === group.id;
    const isDragSource =
      drag.draggingItem?.targetType === 'group' && drag.draggingItem.id === group.id;
    const isKeyboardReordering =
      drag.keyboardState?.targetType === 'group' && drag.keyboardState.id === group.id;
    const isGroupDropHighlight =
      drag.dropTarget?.kind === 'group-header' && drag.dropTarget.groupId === group.id;

    let groupRunning = 0;
    let groupUnread = 0;
    for (const p of allGroupProjects) {
      const act = projectActivityById.get(p.id);
      if (act) {
        groupRunning += act.runningCount;
        groupUnread += act.unreadCount;
      }
    }

    const dragMeta: DragItemMeta = {
      targetType: 'group',
      id: group.id,
      label: group.name,
      zone,
      containerId: '__groups__',
    };
    const isFirstInZone = zoneIdx <= 0;
    const isLastInZone = zoneTotal <= 1 || zoneIdx >= zoneTotal - 1;

    return (
      <div
        key={group.id}
        className={`${styles.projectGroup} ${isDragSource ? styles.dragSourcePlaceholder : ''} ${isKeyboardReordering ? styles.keyboardReordering : ''}`}
        data-testid={`project-group-${group.id}`}
        data-collapsed={effectiveCollapsed ? 'true' : 'false'}
        data-pinned={isPinned ? 'true' : 'false'}
        data-dnd-item="1"
        data-dnd-type="group"
        data-dnd-id={group.id}
        data-dnd-container="__groups__"
        data-dnd-zone={zone}
      >
        <div
          className={`${styles.groupHeader} ${isGroupDropHighlight ? styles.groupHeaderDropTarget : ''}`}
          data-dnd-collapsed-group={effectiveCollapsed ? group.id : undefined}
          data-dnd-group-name={group.name}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleToggleGroupMenu(group.id);
          }}
          onPointerDown={(e) => {
            if (canDragReorder && editingGroupId !== group.id) {
              drag.startPointerCandidate(e, dragMeta, false);
            }
          }}
        >
          {editingGroupId === group.id ? (
            <form
              className={styles.inlineRenameRow}
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = groupNameDraft.trim();
                if (trimmed && trimmed !== group.name) {
                  void onRenameGroup?.(group.id, trimmed);
                }
                setEditingGroupId(null);
              }}
            >
              <input
                type="text"
                className={styles.inlineRenameInput}
                value={groupNameDraft}
                autoFocus
                aria-label={t('sidebar.renameGroup')}
                onChange={(e) => setGroupNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setEditingGroupId(null);
                  }
                }}
              />
              <button type="submit" className={styles.inlineRenameSaveBtn}>
                {t('common.save')}
              </button>
              <button
                type="button"
                className={styles.inlineRenameCancelBtn}
                onClick={() => setEditingGroupId(null)}
              >
                ×
              </button>
            </form>
          ) : (
            <>
              {canDragReorder && (
                <button
                  type="button"
                  className={styles.dragHandleBtn}
                  data-drag-handle="1"
                  data-testid={`drag-handle-group-${group.id}`}
                  aria-label={t('sidebarOrg.dragHandleAria')}
                  title={t('sidebarOrg.dragHandleAria')}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => drag.startPointerCandidate(e, dragMeta, true)}
                  onKeyDown={(e) => drag.handleHandleKeyDown(e, dragMeta)}
                >
                  <DragDotsGlyph />
                </button>
              )}
              <button
                type="button"
                className={styles.groupToggleBtn}
                data-testid={`toggle-group-${group.id}`}
                aria-expanded={!effectiveCollapsed}
                aria-label={
                  effectiveCollapsed ? t('sidebar.expandGroup') : t('sidebar.collapseGroup')
                }
                onClick={() => handleToggleGroup(group)}
              >
                <ChevronGlyph expanded={!effectiveCollapsed} />
                {group.icon && (
                  <span
                    className={styles.groupCustomIcon}
                    data-testid={`group-icon-${group.id}`}
                    aria-hidden="true"
                  >
                    <EntityIcon icon={group.icon} kind="group" size={13} />
                  </span>
                )}
                <span className={styles.groupName}>{group.name}</span>
                {isPinned && (
                  <span
                    className={styles.pinnedBadgeIcon}
                    data-testid={`group-pinned-badge-${group.id}`}
                    aria-hidden="true"
                  >
                    <PinGlyph />
                  </span>
                )}
                {effectiveCollapsed && groupRunning > 0 && (
                  <span className={styles.projectRunningDot} aria-hidden="true" />
                )}
                {effectiveCollapsed && groupRunning === 0 && groupUnread > 0 && (
                  <span className={styles.projectUnreadDot} aria-hidden="true" />
                )}
                <span className={styles.groupCount}>{allGroupProjects.length}</span>
              </button>
              {isGroupDropHighlight && (
                <span className={styles.groupDropBadge}>
                  {t('sidebarOrg.dropInGroupHint', { name: group.name })}
                </span>
              )}
              <div className={styles.groupActions} data-no-drag="1">
                {onPinGroup && (
                  <button
                    type="button"
                    className={`${styles.iconBtn} ${styles.groupDeleteBtn} ${isPinned ? styles.pinBtnActive : ''}`}
                    data-testid={`pin-group-${group.id}`}
                    aria-pressed={isPinned}
                    disabled={!canMutateOrg}
                    title={
                      isL0
                        ? t('sidebarOrg.l0ReadOnlyHint')
                        : isPinned
                          ? t('sidebarOrg.unpinGroup')
                          : t('sidebarOrg.pinGroup')
                    }
                    aria-label={
                      isPinned ? t('sidebarOrg.unpinGroup') : t('sidebarOrg.pinGroup')
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!canMutateOrg) return;
                      void onPinGroup(group, !isPinned);
                    }}
                  >
                    <PinGlyph />
                  </button>
                )}
                {onRenameGroup && (
                  <button
                    type="button"
                    className={`${styles.iconBtn} ${styles.groupDeleteBtn}`}
                    data-testid={`rename-group-${group.id}`}
                    disabled={!canMutateOrg}
                    title={isL0 ? t('sidebarOrg.l0ReadOnlyHint') : t('sidebar.renameGroup')}
                    aria-label={`${t('sidebar.renameGroup')} ${group.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!canMutateOrg) return;
                      setGroupNameDraft(group.name);
                      setEditingGroupId(group.id);
                    }}
                  >
                    <EditGlyph />
                  </button>
                )}
                <button
                  type="button"
                  className={`${styles.iconBtn} ${styles.groupDeleteBtn}`}
                  data-testid={`group-actions-${group.id}`}
                  aria-expanded={isGroupMenuOpen}
                  title={t('sidebar.moreActions')}
                  aria-label={t('sidebar.moreActions')}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleGroupMenu(group.id);
                  }}
                >
                  <MoreDotsGlyph />
                </button>
                {onDeleteGroup && (
                  <button
                    type="button"
                    className={`${styles.iconBtn} ${styles.iconBtnDanger} ${styles.groupDeleteBtn}`}
                    data-testid={`delete-group-${group.id}`}
                    disabled={!canMutateOrg}
                    title={isL0 ? t('sidebarOrg.l0ReadOnlyHint') : t('sidebar.deleteGroup')}
                    aria-label={t('sidebar.deleteGroup')}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!canMutateOrg) return;
                      void onDeleteGroup(group.id);
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {isGroupMenuOpen && editingGroupId !== group.id && (
          <div
            className={styles.groupMenuPopover}
            onClick={(e) => e.stopPropagation()}
            data-no-drag="1"
          >
            {onReorderOrg && canDragReorder && zoneTotal > 1 && (
              <div className={styles.popoverReorderRow}>
                <button
                  type="button"
                  className={styles.popoverMiniBtn}
                  disabled={isFirstInZone}
                  data-testid={`reorder-group-first-${group.id}`}
                  onClick={() => {
                    handleReorderAction('group', '__groups__', zone, group.id, 'first');
                    handleToggleGroupMenu(group.id);
                  }}
                >
                  {t('sidebarOrg.moveFirst')}
                </button>
                <button
                  type="button"
                  className={styles.popoverMiniBtn}
                  disabled={isFirstInZone}
                  data-testid={`reorder-group-up-${group.id}`}
                  onClick={() => {
                    handleReorderAction('group', '__groups__', zone, group.id, 'up');
                    handleToggleGroupMenu(group.id);
                  }}
                >
                  {t('sidebarOrg.moveUp')}
                </button>
                <button
                  type="button"
                  className={styles.popoverMiniBtn}
                  disabled={isLastInZone}
                  data-testid={`reorder-group-down-${group.id}`}
                  onClick={() => {
                    handleReorderAction('group', '__groups__', zone, group.id, 'down');
                    handleToggleGroupMenu(group.id);
                  }}
                >
                  {t('sidebarOrg.moveDown')}
                </button>
                <button
                  type="button"
                  className={styles.popoverMiniBtn}
                  disabled={isLastInZone}
                  data-testid={`reorder-group-last-${group.id}`}
                  onClick={() => {
                    handleReorderAction('group', '__groups__', zone, group.id, 'last');
                    handleToggleGroupMenu(group.id);
                  }}
                >
                  {t('sidebarOrg.moveLast')}
                </button>
              </div>
            )}
            <div className={styles.popoverActionRow}>
              {onPinGroup && (
                <button
                  type="button"
                  className={styles.popoverMiniBtn}
                  disabled={!canMutateOrg}
                  onClick={() => {
                    if (!canMutateOrg) return;
                    void onPinGroup(group, !isPinned);
                    handleToggleGroupMenu(group.id);
                  }}
                >
                  {isPinned ? t('sidebarOrg.unpinGroup') : t('sidebarOrg.pinGroup')}
                </button>
              )}
              {onUpdateGroup && (
                <button
                  type="button"
                  className={styles.popoverMiniBtn}
                  data-testid={`set-group-icon-${group.id}`}
                  aria-expanded={iconPickerGroupId === group.id}
                  disabled={!canMutateOrg}
                  onClick={() => {
                    if (!canMutateOrg) return;
                    setIconPickerGroupId((prev) => (prev === group.id ? null : group.id));
                  }}
                >
                  {t('sidebar.setIcon')}
                </button>
              )}
              {onRenameGroup && (
                <button
                  type="button"
                  className={styles.popoverMiniBtn}
                  disabled={!canMutateOrg}
                  onClick={() => {
                    if (!canMutateOrg) return;
                    setGroupNameDraft(group.name);
                    setEditingGroupId(group.id);
                    handleToggleGroupMenu(group.id);
                  }}
                >
                  {t('sidebar.renameGroup')}
                </button>
              )}
              {onDeleteGroup && (
                <button
                  type="button"
                  className={`${styles.popoverMiniBtn} ${styles.popoverDangerBtn}`}
                  disabled={!canMutateOrg}
                  onClick={() => {
                    if (!canMutateOrg) return;
                    handleToggleGroupMenu(group.id);
                    void onDeleteGroup(group.id);
                  }}
                >
                  {t('sidebar.deleteGroup')}
                </button>
              )}
            </div>
            {onUpdateGroup && iconPickerGroupId === group.id && (
              <EntityIconPicker
                value={group.icon}
                disabled={!canMutateOrg}
                t={t}
                testIdPrefix={`group-icon-${group.id}`}
                onSelect={(nextIcon) => {
                  if (!canMutateOrg) return;
                  void onUpdateGroup(group.id, { icon: nextIcon });
                  setIconPickerGroupId(null);
                  handleToggleGroupMenu(group.id);
                }}
                onClose={() => setIconPickerGroupId(null)}
              />
            )}
          </div>
        )}

        {!effectiveCollapsed && (
          <div className={styles.groupItems} data-dnd-project-container={group.id}>
            {visiblePinned.map((p, idx) =>
              renderProjectNode(p, group.id, 'pinned', idx, visiblePinned.length),
            )}
            {visiblePinned.length > 0 && visibleNormal.length > 0 && (
              <div
                className={styles.zoneDivider}
                data-testid={`project-zone-divider-${group.id}`}
              />
            )}
            {visibleNormal.map((p, idx) =>
              renderProjectNode(p, group.id, 'normal', idx, visibleNormal.length),
            )}
            {visibleCount === 0 && drag.draggingItem?.targetType === 'project' && (
              <div
                className={styles.emptyGroupDropSlot}
                data-dnd-drop-container={group.id}
                data-testid={`empty-group-drop-${group.id}`}
              >
                {t('sidebarOrg.emptyGroupDropHint')}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.sidebar} data-testid="session-sidebar">
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <h2 className={styles.heading}>{t('sidebar.projectsSection')}</h2>
          <span
            className={styles.count}
            data-testid="sidebar-project-count"
            title={t('sidebar.projectCount')}
            aria-label={t('sidebar.projectCount')}
          >
            {projects.length}
          </span>
          <span
            className={`${styles.count} ${styles.countMuted}`}
            data-testid="sidebar-session-count"
            title={t('sidebar.sessionCount')}
            aria-label={t('sidebar.sessionCount')}
          >
            {activeSessions.length}
          </span>
        </div>
        <div className={styles.headerActions} data-testid="sidebar-header-actions">
          <button
            type="button"
            className={`${styles.toolbarIconBtn} ${showFilterDrawer ? styles.toolbarIconBtnActive : ''}`}
            onClick={() => setShowFilterDrawer((prev) => !prev)}
            aria-expanded={showFilterDrawer}
            title={t('sidebar.filterToggle')}
            aria-label={t('sidebar.filterToggle')}
            data-testid="sidebar-filter-toggle"
          >
            <FilterGlyph />
            {hasActiveFilterState && <span className={styles.filterActiveDot} aria-hidden="true" />}
          </button>
          {onCreateGroup && (
            <button
              type="button"
              className={`${styles.toolbarIconBtn} ${showNewGroupForm ? styles.toolbarIconBtnActive : ''}`}
              onClick={handleToggleGroupForm}
              disabled={!canMutateOrg}
              aria-expanded={showNewGroupForm}
              title={isL0 ? t('sidebarOrg.l0ReadOnlyHint') : t('sidebar.newGroupTooltip')}
              aria-label={t('sidebar.newGroupTooltip')}
              data-testid="open-new-group-btn"
            >
              <GroupPlusGlyph />
            </button>
          )}
          {(onCreateProject || onOpenNewProjectModal) && (
            <button
              type="button"
              className={`${styles.toolbarIconBtn} ${showNewProjectForm ? styles.toolbarIconBtnActive : ''}`}
              onClick={handleToggleProjectForm}
              disabled={!canAdminWorkspace}
              aria-expanded={showNewProjectForm}
              title={
                isL0
                  ? t('sidebarOrg.l0ReadOnlyHint')
                  : isL1
                    ? t('sidebarOrg.l1NewProjectDisabledHint')
                    : t('sidebar.newProject')
              }
              aria-label={t('sidebar.newProject')}
              data-testid="open-new-project-btn"
            >
              <FolderPlusGlyph />
            </button>
          )}
          <button
            type="button"
            className={`${styles.toolbarIconBtn} ${styles.toolbarIconBtnPrimary}`}
            onClick={() => onCreateSession({ standalone: true })}
            disabled={creating || isL0}
            title={
              isL0
                ? t('sidebarOrg.l0ReadOnlyHint')
                : creating
                  ? t('sidebar.creating')
                  : t('sidebar.newStandaloneSession')
            }
            aria-label={creating ? t('sidebar.creating') : t('sidebar.newStandaloneSession')}
            data-testid="new-session-btn"
          >
            <PlusGlyph />
          </button>
        </div>
      </div>

      {isL0 && (
        <div className={styles.l0NoticeBar} data-testid="sidebar-l0-notice">
          {t('sidebarOrg.l0ReadOnlyHint')}
        </div>
      )}

      {(totalRunningCount > 0 ||
        totalUnreadCount > 0 ||
        statusFilter !== 'all' ||
        effectiveArchivedCount > 0 ||
        viewMode === 'archived') && (
        <div className={styles.quickAttentionBar} data-testid="sidebar-attention-filters">
          <button
            type="button"
            className={`${styles.attentionChip} ${viewMode === 'active' && statusFilter === 'all' ? styles.attentionChipActive : ''}`}
            onClick={() => {
              setViewMode('active');
              setStatusFilter('all');
            }}
          >
            {t('sidebar.allProjects')}
          </button>
          {totalRunningCount > 0 && (
            <button
              type="button"
              className={`${styles.attentionChip} ${viewMode === 'active' && statusFilter === 'running' ? styles.attentionChipActive : ''}`}
              onClick={() => {
                setViewMode('active');
                setStatusFilter((prev) => (prev === 'running' ? 'all' : 'running'));
              }}
              data-testid="sidebar-filter-running"
            >
              <span className={styles.attentionDotRunning} aria-hidden="true" />
              <span>{t('sidebar.filterRunning')}</span>
              <span className={styles.attentionCount}>{totalRunningCount}</span>
            </button>
          )}
          {totalUnreadCount > 0 && (
            <button
              type="button"
              className={`${styles.attentionChip} ${viewMode === 'active' && statusFilter === 'unread' ? styles.attentionChipActive : ''}`}
              onClick={() => {
                setViewMode('active');
                setStatusFilter((prev) => (prev === 'unread' ? 'all' : 'unread'));
              }}
              data-testid="sidebar-filter-unread"
            >
              <span className={styles.attentionDotUnread} aria-hidden="true" />
              <span>{t('sidebar.filterUnread')}</span>
              <span className={styles.attentionCount}>{totalUnreadCount}</span>
            </button>
          )}
          {(effectiveArchivedCount > 0 || viewMode === 'archived') && (
            <button
              type="button"
              className={`${styles.attentionChip} ${viewMode === 'archived' ? styles.attentionChipActive : ''}`}
              onClick={() => setViewMode(viewMode === 'archived' ? 'active' : 'archived')}
              data-testid="sidebar-filter-archived"
            >
              <span>
                {effectiveArchivedCount > 0
                  ? t('sidebarOrg.archivedCountFilter', { count: effectiveArchivedCount })
                  : t('sidebarOrg.archivedFilter')}
              </span>
            </button>
          )}
          {hasActiveFilterState && (
            <button
              type="button"
              className={styles.attentionResetBtn}
              onClick={() => {
                setViewMode('active');
                setStatusFilter('all');
                if (searchQuery === undefined) setInternalQuery('');
                onSearchQueryChange?.('');
                handleFilterChange('all');
              }}
            >
              {t('sidebar.resetFilters')}
            </button>
          )}
        </div>
      )}

      {showFilterDrawer && (
        <div className={styles.filterDrawer} data-testid="sidebar-filter-drawer">
          <input
            type="search"
            className={styles.searchInput}
            placeholder={t('sidebar.filterPlaceholder')}
            aria-label={t('sidebar.filterAria')}
            value={effectiveQuery}
            onChange={handleSearchChange}
            data-testid="session-search-input"
          />

          <div className={styles.filterPills}>
            <button
              type="button"
              className={`${styles.filterPill} ${viewMode === 'active' && effectiveFilter === 'all' ? styles.filterPillActive : ''}`}
              aria-pressed={viewMode === 'active' && effectiveFilter === 'all'}
              onClick={() => {
                setViewMode('active');
                handleFilterChange('all');
              }}
              data-testid="project-filter-all"
            >
              {t('sidebar.allProjects')}
            </button>
            <button
              type="button"
              className={`${styles.filterPill} ${viewMode === 'active' && effectiveFilter === '__none__' ? styles.filterPillActive : ''}`}
              aria-pressed={viewMode === 'active' && effectiveFilter === '__none__'}
              onClick={() => {
                setViewMode('active');
                handleFilterChange('__none__');
              }}
              data-testid="project-filter-none"
            >
              {t('sidebar.standaloneSessions')}
            </button>
            <button
              type="button"
              className={`${styles.filterPill} ${viewMode === 'archived' ? styles.filterPillActive : ''}`}
              aria-pressed={viewMode === 'archived'}
              onClick={() => setViewMode(viewMode === 'archived' ? 'active' : 'archived')}
              data-testid="sidebar-drawer-archived"
            >
              {effectiveArchivedCount > 0
                ? t('sidebarOrg.archivedCountFilter', { count: effectiveArchivedCount })
                : t('sidebarOrg.archivedFilter')}
            </button>
          </div>

          {showInternalToggle && (
            <label className={styles.internalToggleRow}>
              <input
                type="checkbox"
                checked={Boolean(includeInternal)}
                onChange={(ev) => onToggleIncludeInternal?.(ev.target.checked)}
                data-testid="toggle-internal-sessions"
              />
              <span className={styles.internalToggleText}>{t('sidebar.showInternalSessions')}</span>
              {hiddenInternalCount > 0 && (
                <span className={styles.internalCountBadge}>
                  {t('sidebar.hiddenInternalCount', { count: hiddenInternalCount })}
                </span>
              )}
            </label>
          )}
        </div>
      )}

      {showNewProjectForm && onCreateProject && !onOpenNewProjectModal && (
        <form
          className={styles.inlineForm}
          onSubmit={(ev) => void handleCreateProjectSubmit(ev)}
          data-testid="new-project-form"
        >
          <input
            type="text"
            className={styles.formInput}
            placeholder={t('sidebar.projectNamePlaceholder')}
            aria-label={t('sidebar.projectNamePlaceholder')}
            value={projectName}
            onChange={(ev) => setProjectName(ev.target.value)}
            data-testid="new-project-name"
          />
          <input
            type="text"
            className={styles.formInput}
            placeholder={defaultSessionPath || t('sidebar.projectPathPlaceholder')}
            aria-label={t('sidebar.projectPathPlaceholder')}
            title={defaultSessionPath ? `${t('sidebar.defaultPathLabel')}: ${defaultSessionPath}` : undefined}
            value={projectPath}
            onChange={(ev) => {
              const nextPath = ev.target.value;
              setProjectPath(nextPath);
              if (!projectName.trim()) {
                const derived = extractWorkspaceName(nextPath);
                if (derived) setProjectName(derived);
              }
            }}
            data-testid="new-project-path"
          />
          <select
            className={styles.formSelect}
            aria-label={t('sidebar.projectsSection')}
            value={projectGroupId}
            onChange={(ev) => setProjectGroupId(ev.target.value)}
            data-testid="new-project-group"
          >
            <option value="">{t('sidebar.ungroupedProjects')}</option>
            {sortedGroups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={projectCreateDir}
              onChange={(ev) => setProjectCreateDir(ev.target.checked)}
              data-testid="new-project-createdir"
            />
            <span>{t('sidebar.createDirLabel')}</span>
          </label>
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.formCancelBtn}
              onClick={() => setShowNewProjectForm(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className={styles.formSubmitBtn}
              disabled={
                submittingProject ||
                !projectName.trim() ||
                !(projectPath || defaultSessionPath || '').trim()
              }
              data-testid="create-project-submit"
            >
              {t('sidebar.create')}
            </button>
          </div>
        </form>
      )}

      {showNewGroupForm && onCreateGroup && (
        <form
          className={styles.inlineForm}
          onSubmit={(ev) => void handleCreateGroupSubmit(ev)}
          data-testid="new-group-form"
        >
          <div className={styles.newGroupInputRow}>
            <button
              type="button"
              className={styles.newGroupIconTrigger}
              aria-label={t('sidebar.groupIconAria')}
              title={t('sidebar.groupIconAria')}
              aria-expanded={showNewGroupIconPicker}
              data-testid="new-group-icon-btn"
              onClick={() => setShowNewGroupIconPicker((prev) => !prev)}
            >
              <EntityIcon icon={newGroupIcon || 'preset:layers'} kind="group" size={13} />
            </button>
            <input
              type="text"
              className={styles.formInput}
              placeholder={t('sidebar.groupNamePlaceholder')}
              aria-label={t('sidebar.groupNamePlaceholder')}
              value={groupName}
              onChange={(ev) => setGroupName(ev.target.value)}
              data-testid="new-group-name"
            />
          </div>
          {showNewGroupIconPicker && (
            <EntityIconPicker
              value={newGroupIcon}
              disabled={submittingGroup}
              t={t}
              testIdPrefix="new-group-icon"
              onSelect={(icon) => {
                setNewGroupIcon(icon);
                setShowNewGroupIconPicker(false);
              }}
              onClose={() => setShowNewGroupIconPicker(false)}
            />
          )}
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.formCancelBtn}
              onClick={() => {
                setShowNewGroupForm(false);
                setShowNewGroupIconPicker(false);
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className={styles.formSubmitBtn}
              disabled={submittingGroup || !groupName.trim()}
              data-testid="create-group-submit"
            >
              {t('sidebar.create')}
            </button>
          </div>
        </form>
      )}

      {drag.dropTarget?.kind === 'slot' && drag.dropTarget.crossZoneBlocked && (
        <div className={styles.zoneClampNotice} data-testid="dnd-zone-clamp-notice">
          {drag.dropTarget.zone === 'pinned'
            ? t('sidebarOrg.zoneClampHint')
            : t('sidebarOrg.zoneClampNormalHint')}
        </div>
      )}

      <div
        ref={listContainerRef}
        className={styles.list}
        role="list"
        aria-label={t('sidebar.sessions')}
      >
        {viewMode === 'archived' ? (
          <div className={styles.archivedList} data-testid="archived-sessions-view">
            {loadingArchived ? (
              <div className={styles.stateBox}>{t('sidebar.loading')}</div>
            ) : filteredArchivedSessions.length === 0 ? (
              <div className={styles.stateBox} data-testid="archived-empty">
                {t('sidebarOrg.archivedEmpty')}
              </div>
            ) : (
              filteredArchivedSessions.map((s) => {
                const title = formatSessionTitle(s, t);
                const projLabel = s.projectId
                  ? projectById.get(s.projectId)?.name || s.projectName || t('sidebar.noProject')
                  : s.projectName || t('sidebar.noProject');
                const archTime = formatRelativeTime(s.archivedAt || s.lastModifiedTime, locale);
                return (
                  <div
                    key={s.cascadeId}
                    className={styles.archivedRow}
                    data-testid={`archived-session-row-${s.cascadeId}`}
                  >
                    <div className={styles.archivedRowTitle} title={title}>
                      {title}
                    </div>
                    <div className={styles.archivedRowMeta}>
                      <span className={styles.archivedProjectBadge}>{projLabel}</span>
                      {archTime && <span>{t('sidebarOrg.archivedAtLabel', { time: archTime })}</span>}
                    </div>
                    <div className={styles.archivedRowActions}>
                      {onArchiveSession && (
                        <button
                          type="button"
                          className={styles.popoverMiniBtn}
                          data-testid={`restore-session-${s.cascadeId}`}
                          disabled={!canMutateOrg}
                          onClick={() => {
                            if (!canMutateOrg) return;
                            void onArchiveSession(s, false);
                          }}
                        >
                          {t('sidebarOrg.restoreSession')}
                        </button>
                      )}
                      {onRequestDeleteSession && (
                        <button
                          type="button"
                          className={`${styles.popoverMiniBtn} ${styles.popoverDangerBtn}`}
                          data-testid={`delete-archived-session-${s.cascadeId}`}
                          disabled={!canAdminWorkspace}
                          title={
                            isL0
                              ? t('sidebarOrg.l0ReadOnlyHint')
                              : isL1
                                ? t('sidebarOrg.l1DeleteDisabledHint')
                                : undefined
                          }
                          onClick={() => {
                            if (!canAdminWorkspace) return;
                            onRequestDeleteSession(s);
                          }}
                        >
                          {t('sidebarOrg.deleteSession')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : loading && activeSessions.length === 0 && !hasProjectsOrGroups ? (
          <div className={styles.stateBox} data-testid="sidebar-loading">
            {t('sidebar.loading')}
          </div>
        ) : showEmptyFilteredState ? (
          <>
            <div className={styles.stateBox} data-testid="sidebar-empty">
              {isSearching || effectiveFilter !== 'all'
                ? t('sidebar.emptyFiltered')
                : t('sidebar.empty')}
            </div>
            {isSearching && archivedSearchMatchesCount > 0 && (
              <button
                type="button"
                className={styles.archivedSearchJump}
                data-testid="archived-search-jump"
                onClick={() => setViewMode('archived')}
              >
                {t('sidebarOrg.archivedSearchHint', { count: archivedSearchMatchesCount })}
              </button>
            )}
          </>
        ) : (
          <>
            {pinnedSessions.length > 0 && (
              <div className={styles.pinnedSection} data-testid="pinned-sessions-section">
                <div className={styles.sectionHeader}>{t('sidebar.pinnedSection')}</div>
                {pinnedSessions.map((s, idx) =>
                  renderSessionRow(s, '__pinned__', 'pinned', idx, pinnedSessions.length, true),
                )}
              </div>
            )}

            {effectiveFilter !== '__none__' && (
              <>
                {pinnedGroups.map((g, idx) => renderGroupNode(g, 'pinned', idx, pinnedGroups.length))}
                {pinnedGroups.length > 0 && normalGroups.length > 0 && (
                  <div className={styles.zoneDivider} data-testid="group-zone-divider" />
                )}
                {normalGroups.map((g, idx) => renderGroupNode(g, 'normal', idx, normalGroups.length))}
              </>
            )}

            {effectiveFilter !== '__none__' &&
              (visiblePinnedUngrouped.length > 0 || activeUngroupedNormal.length > 0) && (
                <div
                  className={styles.ungroupedSection}
                  data-dnd-project-container="__ungrouped__"
                >
                  {visiblePinnedUngrouped.map((p, idx) =>
                    renderProjectNode(
                      p,
                      '__ungrouped__',
                      'pinned',
                      idx,
                      visiblePinnedUngrouped.length,
                    ),
                  )}
                  {visiblePinnedUngrouped.length > 0 && activeUngroupedNormal.length > 0 && (
                    <div
                      className={styles.zoneDivider}
                      data-testid="project-zone-divider-__ungrouped__"
                    />
                  )}
                  {activeUngroupedNormal.map((p, idx) =>
                    renderProjectNode(
                      p,
                      '__ungrouped__',
                      'normal',
                      idx,
                      activeUngroupedNormal.length,
                    ),
                  )}
                </div>
              )}

            {effectiveFilter !== '__none__' &&
              sortedGroups.length > 0 &&
              drag.draggingItem?.targetType === 'project' &&
              Boolean(drag.draggingItem.fromGroupId) && (
                <div
                  className={`${styles.ungroupedDropSlot} ${drag.dropTarget?.kind === 'drop-zone' && drag.dropTarget.containerId === '__ungrouped__' ? styles.ungroupedDropSlotActive : ''}`}
                  data-dnd-drop-container="__ungrouped__"
                  data-testid="ungrouped-drop-slot"
                >
                  {t('sidebarOrg.ungroupedDropHint')}
                </div>
              )}

            {effectiveFilter !== '__none__' && quietUngroupedNormal.length > 0 && (
              <div className={styles.quietProjectsSection} data-testid="quiet-projects-section">
                <button
                  type="button"
                  className={styles.quietProjectsToggle}
                  aria-expanded={quietProjectsExpanded}
                  onClick={() => setQuietProjectsExpanded((prev) => !prev)}
                  data-testid="quiet-projects-toggle"
                >
                  <ChevronGlyph expanded={quietProjectsExpanded} />
                  <span>{t('sidebar.otherProjects', { count: quietUngroupedNormal.length })}</span>
                </button>
                {quietProjectsExpanded && (
                  <div
                    className={styles.ungroupedSection}
                    data-dnd-project-container="__ungrouped__"
                  >
                    {quietUngroupedNormal.map((p, idx) =>
                      renderProjectNode(
                        p,
                        '__ungrouped__',
                        'normal',
                        idx,
                        quietUngroupedNormal.length,
                      ),
                    )}
                  </div>
                )}
              </div>
            )}

            {(standaloneRegularSessions.length > 0 || effectiveFilter === '__none__') &&
              (hasProjectsOrGroups ? (
                <div
                  className={styles.standaloneSection}
                  data-testid="standalone-sessions-section"
                >
                  <div className={styles.sectionHeader}>{t('sidebar.standaloneSessions')}</div>
                  {standaloneRegularSessions.length > 0 ? (
                    standaloneRegularSessions.map((s, idx) =>
                      renderSessionRow(
                        s,
                        '__standalone__',
                        'normal',
                        idx,
                        standaloneRegularSessions.length,
                        false,
                      ),
                    )
                  ) : (
                    <div className={styles.emptyProjectHint}>{t('sidebar.emptyFiltered')}</div>
                  )}
                </div>
              ) : (
                standaloneRegularSessions.map((s, idx) =>
                  renderSessionRow(
                    s,
                    '__standalone__',
                    'normal',
                    idx,
                    standaloneRegularSessions.length,
                    false,
                  ),
                )
              ))}

            {isSearching && archivedSearchMatchesCount > 0 && (
              <button
                type="button"
                className={styles.archivedSearchJump}
                data-testid="archived-search-jump"
                onClick={() => setViewMode('archived')}
              >
                {t('sidebarOrg.archivedSearchHint', { count: archivedSearchMatchesCount })}
              </button>
            )}
          </>
        )}
      </div>

      {drag.draggingItem && drag.ghostPos && (
        <div
          className={styles.dragGhost}
          style={{ left: drag.ghostPos.x, top: drag.ghostPos.y }}
          data-testid="dnd-drag-ghost"
        >
          <span>{drag.draggingItem.label}</span>
        </div>
      )}

      {drag.dropTarget?.kind === 'slot' && (
        <div
          className={styles.dropLine}
          style={{
            top: drag.dropTarget.lineTop,
            left: drag.dropTarget.lineLeft,
            width: drag.dropTarget.lineWidth,
          }}
          data-testid="dnd-drop-line"
        />
      )}

      <div className={styles.srOnly} role="status" aria-live="polite" data-testid="dnd-aria-live">
        {drag.liveAnnouncement}
      </div>
    </div>
  );
});
