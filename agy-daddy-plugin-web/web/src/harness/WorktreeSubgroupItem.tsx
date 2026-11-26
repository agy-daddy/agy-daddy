import React, { useState } from 'react';
import type { TranslateFn } from '../i18n';
import type { ProjectItem, SessionSummary, WorktreeDto } from '../types';
import type { DndZone } from './useSidebarDragSort';
import styles from './SessionSidebar.module.css';

function BranchGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="6.5" r="1.5" />
      <path d="M4.5 5v6M4.5 9c0-2 5.5-1 7-1" />
    </svg>
  );
}

function LockGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

function ChevronSmallGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10"
      height="10"
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

function DotsGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}

export interface WorktreeSubgroupItemProps {
  project: ProjectItem;
  worktree: WorktreeDto;
  sessions: SessionSummary[];
  isExpanded: boolean;
  isActiveWorktree: boolean;
  isMenuOpen: boolean;
  creating: boolean;
  canMutateOrg: boolean;
  canAdminWorkspace: boolean;
  isL0: boolean;
  t: TranslateFn;
  onToggleExpand: (worktreeId: string) => void;
  onToggleMenu: (worktreeId: string) => void;
  onCreateSession: (opts?: {
    projectId?: string | null;
    workspaceUri?: string;
    worktreePath?: string;
    standalone?: boolean;
  }) => void;
  onOpenWorktreeTerminal?: (worktreePath: string) => void;
  onOpenWorktreeDiff?: (worktreePath: string) => void;
  onRequestRemoveWorktree?: (project: ProjectItem, worktree: WorktreeDto) => void;
  onPruneWorktrees?: (project: ProjectItem) => void;
  renderSessionRow: (
    session: SessionSummary,
    containerId: string,
    zone: DndZone,
    idx: number,
    total: number,
  ) => React.ReactNode;
}

export const WorktreeSubgroupItem = React.memo(function WorktreeSubgroupItem({
  project,
  worktree,
  sessions,
  isExpanded,
  isActiveWorktree,
  isMenuOpen,
  creating,
  canMutateOrg,
  canAdminWorkspace,
  isL0,
  t,
  onToggleExpand,
  onToggleMenu,
  onCreateSession,
  onOpenWorktreeTerminal,
  onOpenWorktreeDiff,
  onRequestRemoveWorktree,
  onPruneWorktrees,
  renderSessionRow,
}: WorktreeSubgroupItemProps) {
  const [copiedPath, setCopiedPath] = useState(false);

  const isMissing = worktree.status === 'missing' || worktree.prunable || worktree.exists === false;
  const isBare = worktree.bare === true || worktree.status === 'bare';
  const canCreateInWorktree = canMutateOrg && !creating && !isMissing && !isBare;
  const canUseSandbox = !isMissing && !isBare;

  const runningCount = sessions.reduce((acc, s) => {
    const running =
      s.isRunning === true || /RUNNING|GENERATING/i.test(String(s.status || ''));
    return acc + (running ? 1 : 0);
  }, 0);
  const unreadCount = sessions.reduce((acc, s) => {
    const running =
      s.isRunning === true || /RUNNING|GENERATING/i.test(String(s.status || ''));
    return acc + (!running && s.unread === true ? 1 : 0);
  }, 0);
  const hasRunning = runningCount > 0;
  const displayCount = Math.max(sessions.length, worktree.sessionCount ?? 0);

  const primaryLabel = isBare
    ? t('worktree.bareTag')
    : worktree.detached
      ? t('worktree.detachedAt', {
          sha: worktree.headShort || (worktree.head ? worktree.head.slice(0, 7) : 'HEAD'),
        })
      : worktree.branch || worktree.displayLabel || worktree.displaySubpath;

  const removeDisabledReason = worktree.locked
    ? t('worktree.lockedRemoveHint')
    : hasRunning
      ? t('worktree.runningRemoveHint')
      : !canAdminWorkspace
        ? t('worktree.l2RequiredHint')
        : undefined;

  const canRemove =
    !worktree.isMain && !isBare && !worktree.locked && !hasRunning && canAdminWorkspace;

  const handleCopyPath = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(worktree.path);
      }
      setCopiedPath(true);
      window.setTimeout(() => setCopiedPath(false), 1500);
    } catch {
      // Ignore clipboard failures
    }
  };

  return (
    <div
      className={`${styles.worktreeNode} ${isMissing ? styles.worktreeNodeMissing : ''}`}
      data-testid={`worktree-subgroup-${worktree.worktreeId}`}
      data-worktree-status={worktree.status}
      data-expanded={isExpanded ? 'true' : 'false'}
    >
      <div
        className={`${styles.worktreeHeader} ${isActiveWorktree ? styles.worktreeHeaderActive : ''}`}
        data-testid={`worktree-header-${worktree.worktreeId}`}
        onClick={() => onToggleExpand(worktree.worktreeId)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onToggleMenu(worktree.worktreeId);
        }}
      >
        <button
          type="button"
          className={styles.worktreeMainBtn}
          aria-expanded={isExpanded}
          title={worktree.path}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(worktree.worktreeId);
          }}
        >
          <ChevronSmallGlyph expanded={isExpanded} />
          <span className={styles.worktreeIcon}>
            <BranchGlyph />
          </span>
          <span className={styles.worktreeLabelWrap}>
            <span className={styles.worktreeTitleLine}>
              <span className={styles.worktreeBranchName}>{primaryLabel}</span>
              {worktree.isMain && !isBare && (
                <span
                  className={styles.worktreeTag}
                  data-testid={`worktree-main-badge-${worktree.worktreeId}`}
                >
                  {t('worktree.mainTag')}
                </span>
              )}
              {worktree.locked && (
                <span
                  className={`${styles.worktreeTag} ${styles.worktreeTagLocked}`}
                  title={t('worktree.lockedRemoveHint')}
                  data-testid={`worktree-locked-badge-${worktree.worktreeId}`}
                >
                  <LockGlyph />
                  <span>{t('worktree.lockedTag')}</span>
                </span>
              )}
              {isMissing && (
                <span
                  className={`${styles.worktreeTag} ${styles.worktreeTagMissing}`}
                  title={t('worktree.missingDisabledHint')}
                  data-testid={`worktree-missing-badge-${worktree.worktreeId}`}
                >
                  {t('worktree.missingTag')}
                </span>
              )}
            </span>
            <span className={styles.worktreeSubpath}>{worktree.displaySubpath}</span>
          </span>
          <span className={styles.worktreeMeta}>
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
            <span
              className={styles.worktreeSessionCount}
              data-testid={`worktree-session-count-${worktree.worktreeId}`}
            >
              {displayCount}
            </span>
          </span>
        </button>

        <div
          className={styles.worktreeActions}
          onClick={(e) => e.stopPropagation()}
          data-no-drag="1"
        >
          {!isBare && (
            <button
              type="button"
              className={styles.iconBtn}
              data-testid={`worktree-new-session-${worktree.worktreeId}`}
              disabled={!canCreateInWorktree}
              title={
                isL0
                  ? t('sidebarOrg.l0ReadOnlyHint')
                  : isMissing
                    ? t('worktree.missingDisabledHint')
                    : t('worktree.newSessionIn', { branch: primaryLabel })
              }
              aria-label={t('worktree.newSessionIn', { branch: primaryLabel })}
              onClick={(e) => {
                e.stopPropagation();
                if (!canCreateInWorktree) return;
                onCreateSession({
                  projectId: project.id,
                  workspaceUri: worktree.uri,
                  worktreePath: worktree.path,
                });
              }}
            >
              +
            </button>
          )}
          <button
            type="button"
            className={styles.iconBtn}
            data-testid={`worktree-actions-${worktree.worktreeId}`}
            aria-expanded={isMenuOpen}
            title={t('sidebar.moreActions')}
            aria-label={t('sidebar.moreActions')}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMenu(worktree.worktreeId);
            }}
          >
            <DotsGlyph />
          </button>
        </div>
      </div>

      {isMenuOpen && (
        <div
          className={styles.worktreeMenuPopover}
          onClick={(e) => e.stopPropagation()}
          data-no-drag="1"
          data-testid={`worktree-menu-${worktree.worktreeId}`}
        >
          <div className={styles.popoverActionRow}>
            {!isBare && (
              <button
                type="button"
                className={styles.popoverMiniBtn}
                disabled={!canCreateInWorktree}
                data-testid={`worktree-menu-new-session-${worktree.worktreeId}`}
                title={
                  isL0
                    ? t('sidebarOrg.l0ReadOnlyHint')
                    : isMissing
                      ? t('worktree.missingDisabledHint')
                      : undefined
                }
                onClick={() => {
                  if (!canCreateInWorktree) return;
                  onToggleMenu(worktree.worktreeId);
                  onCreateSession({
                    projectId: project.id,
                    workspaceUri: worktree.uri,
                    worktreePath: worktree.path,
                  });
                }}
              >
                {t('worktree.newSessionIn', { branch: primaryLabel })}
              </button>
            )}
            {onOpenWorktreeTerminal && (
              <button
                type="button"
                className={styles.popoverMiniBtn}
                disabled={!canUseSandbox || !canAdminWorkspace}
                data-testid={`worktree-open-terminal-${worktree.worktreeId}`}
                title={
                  !canUseSandbox
                    ? isBare
                      ? t('worktree.bareDisabledHint')
                      : t('worktree.missingDisabledHint')
                    : !canAdminWorkspace
                      ? t('worktree.l2RequiredHint')
                      : undefined
                }
                onClick={() => {
                  if (!canUseSandbox || !canAdminWorkspace) return;
                  onToggleMenu(worktree.worktreeId);
                  onOpenWorktreeTerminal(worktree.path);
                }}
              >
                {t('worktree.openTerminal')}
              </button>
            )}
            {onOpenWorktreeDiff && (
              <button
                type="button"
                className={styles.popoverMiniBtn}
                disabled={!canUseSandbox}
                data-testid={`worktree-open-diff-${worktree.worktreeId}`}
                title={
                  !canUseSandbox
                    ? isBare
                      ? t('worktree.bareDisabledHint')
                      : t('worktree.missingDisabledHint')
                    : undefined
                }
                onClick={() => {
                  if (!canUseSandbox) return;
                  onToggleMenu(worktree.worktreeId);
                  onOpenWorktreeDiff(worktree.path);
                }}
              >
                {t('worktree.openDiff')}
              </button>
            )}
            <button
              type="button"
              className={styles.popoverMiniBtn}
              data-testid={`worktree-copy-path-${worktree.worktreeId}`}
              onClick={() => {
                void handleCopyPath();
              }}
            >
              {copiedPath ? t('worktree.copiedPath') : t('worktree.copyPath')}
            </button>
            {isMissing && onPruneWorktrees && (
              <button
                type="button"
                className={styles.popoverMiniBtn}
                disabled={!canAdminWorkspace}
                data-testid={`worktree-prune-${worktree.worktreeId}`}
                title={!canAdminWorkspace ? t('worktree.l2RequiredHint') : undefined}
                onClick={() => {
                  if (!canAdminWorkspace) return;
                  onToggleMenu(worktree.worktreeId);
                  onPruneWorktrees(project);
                }}
              >
                {t('worktree.pruneWorktrees')}
              </button>
            )}
            {!worktree.isMain && !isBare && onRequestRemoveWorktree && (
              <button
                type="button"
                className={`${styles.popoverMiniBtn} ${styles.popoverDangerBtn}`}
                disabled={!canRemove}
                data-testid={`worktree-remove-${worktree.worktreeId}`}
                title={removeDisabledReason}
                onClick={() => {
                  if (!canRemove) return;
                  onToggleMenu(worktree.worktreeId);
                  onRequestRemoveWorktree(project, worktree);
                }}
              >
                {t('worktree.removeWorktree')}
              </button>
            )}
          </div>
        </div>
      )}

      {isExpanded && !isBare && (
        <div
          className={styles.worktreeSessions}
          data-testid={`worktree-sessions-${worktree.worktreeId}`}
        >
          {sessions.length > 0 ? (
            sessions.map((s, idx) =>
              renderSessionRow(s, worktree.worktreeId, 'normal', idx, sessions.length),
            )
          ) : (
            <div className={styles.emptyProjectRow}>
              <span className={styles.emptyProjectHint}>{t('worktree.noSessions')}</span>
              {!isMissing && (
                <button
                  type="button"
                  className={styles.emptyProjectNewBtn}
                  disabled={!canCreateInWorktree}
                  onClick={() => {
                    if (!canCreateInWorktree) return;
                    onCreateSession({
                      projectId: project.id,
                      workspaceUri: worktree.uri,
                      worktreePath: worktree.path,
                    });
                  }}
                >
                  + {t('sidebar.startFirstSession')}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
