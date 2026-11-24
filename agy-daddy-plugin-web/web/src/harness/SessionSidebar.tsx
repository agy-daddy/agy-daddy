import React, { useDeferredValue, useMemo, useState } from 'react';
import {
  formatRelativeTime,
  formatSessionTitle,
  useI18n,
  type Locale,
  type TranslateFn,
} from '../i18n';
import type {
  ProjectGroup,
  ProjectItem,
  SessionSummary,
} from '../types';
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
  onPinSession?: (cascadeId: string, pinned: boolean) => Promise<void> | void;
  onAssignSessionProject?: (cascadeId: string, projectId: string | null) => Promise<void> | void;
  onCreateProject?: (payload: {
    name: string;
    rootPath: string;
    groupId?: string | null;
    createDir?: boolean;
  }) => Promise<void> | void;
  onUpdateProject?: (
    id: string,
    patch: { name?: string; groupId?: string | null },
  ) => Promise<void> | void;
  onDeleteProject?: (id: string) => Promise<void> | void;
  onCreateGroup?: (name: string) => Promise<void> | void;
  onToggleGroupCollapsed?: (id: string, collapsed: boolean) => Promise<void> | void;
  onDeleteGroup?: (id: string) => Promise<void> | void;
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

function PinGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z" />
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
  onToggleMenu: (cascadeId: string) => void;
  onSelectSession: (cascadeId: string) => void;
  onPinSession?: (cascadeId: string, pinned: boolean) => Promise<void> | void;
  onAssignSessionProject?: (cascadeId: string, projectId: string | null) => Promise<void> | void;
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
  onToggleMenu,
  onSelectSession,
  onPinSession,
  onAssignSessionProject,
}: SessionSidebarRowProps) {
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
  const hasActions = Boolean(onPinSession || onAssignSessionProject);

  return (
    <div
      role="listitem"
      className={`${styles.item} ${isActive ? styles.itemActive : ''} ${isMenuOpen ? styles.itemMenuOpen : ''}`}
      onClick={() => onSelectSession(session.cascadeId)}
      data-active={isActive ? 'true' : 'false'}
      data-session-id={session.cascadeId}
      data-pinned={isPinned ? 'true' : 'false'}
    >
      <div className={styles.itemLine1}>
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
            >
              {onPinSession && (
                <button
                  type="button"
                  className={`${styles.rowActionBtn} ${isPinned ? styles.pinBtnActive : ''}`}
                  data-testid={`pin-session-${session.cascadeId}`}
                  aria-pressed={isPinned}
                  title={isPinned ? t('sidebar.unpinSession') : t('sidebar.pinSession')}
                  aria-label={isPinned ? t('sidebar.unpinSession') : t('sidebar.pinSession')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void onPinSession(session.cascadeId, !isPinned);
                  }}
                >
                  <PinGlyph />
                </button>
              )}
              {onAssignSessionProject && (
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

      {isMenuOpen && onAssignSessionProject && (
        <div className={styles.rowActionsPopover} onClick={(e) => e.stopPropagation()}>
          <label className={styles.assignField}>
            <span className={styles.assignFieldLabel}>{t('sidebar.assignProject')}</span>
            <select
              className={styles.assignSelect}
              data-testid={`assign-project-${session.cascadeId}`}
              aria-label={t('sidebar.assignProject')}
              title={t('sidebar.assignProject')}
              value={session.projectId ?? ''}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
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
        </div>
      )}
    </div>
  );
});

interface ProjectTreeItemProps {
  project: ProjectItem;
  sessions: SessionSummary[];
  totalSessionCount: number;
  isExpanded: boolean;
  isFilterSelected: boolean;
  creating: boolean;
  groups: ProjectGroup[];
  t: TranslateFn;
  onHeaderClick: (projectId: string) => void;
  onCreateSession: (opts?: {
    projectId?: string | null;
    workspaceUri?: string;
    standalone?: boolean;
  }) => void;
  onUpdateProject?: (
    id: string,
    patch: { name?: string; groupId?: string | null },
  ) => Promise<void> | void;
  onDeleteProject?: (id: string) => Promise<void> | void;
  renderSessionRow: (session: SessionSummary) => React.ReactNode;
}

const ProjectTreeItem = React.memo(function ProjectTreeItem({
  project,
  sessions,
  totalSessionCount,
  isExpanded,
  isFilterSelected,
  creating,
  groups,
  t,
  onHeaderClick,
  onCreateSession,
  onUpdateProject,
  onDeleteProject,
  renderSessionRow,
}: ProjectTreeItemProps) {
  const syncedFromApp = isSyncedAppProject(project);
  const canMoveToGroup = (!project.implicit || syncedFromApp) && Boolean(onUpdateProject) && groups.length > 0;
  const workspaceUri = toWorkspaceUri(project.rootPath);

  return (
    <div className={styles.projectNode}>
      <div
        className={`${styles.projectItem} ${isFilterSelected ? styles.projectItemActive : ''}`}
        data-testid={`project-item-${project.id}`}
        data-active={isFilterSelected ? 'true' : 'false'}
        data-expanded={isExpanded ? 'true' : 'false'}
        data-source={syncedFromApp ? 'app' : project.implicit ? 'implicit' : 'custom'}
        onClick={() => onHeaderClick(project.id)}
      >
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
          <span className={styles.projectFolderIcon}>
            <FolderGlyph size={13} />
          </span>
          <span className={styles.projectName}>{project.name}</span>
          <span className={styles.projectMeta}>
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
        <div className={styles.projectActions} onClick={(e) => e.stopPropagation()}>
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
          {canMoveToGroup && onUpdateProject && (
            <select
              className={styles.projectMoveSelect}
              data-testid={`move-project-group-${project.id}`}
              aria-label={t('sidebar.moveToGroup')}
              title={t('sidebar.moveToGroup')}
              value={project.groupId ?? ''}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
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
          {!project.implicit && onDeleteProject && (
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
              data-testid={`delete-project-${project.id}`}
              title={t('sidebar.deleteProject')}
              aria-label={t('sidebar.deleteProject')}
              onClick={(e) => {
                e.stopPropagation();
                void onDeleteProject(project.id);
              }}
            >
              ×
            </button>
          )}
        </div>
      </div>

      {isExpanded && (
        <div
          className={styles.projectSessions}
          data-testid={`project-sessions-${project.id}`}
        >
          {sessions.length > 0 ? (
            sessions.map(renderSessionRow)
          ) : (
            <div className={styles.emptyProjectHint}>{t('sidebar.noSessionsInProject')}</div>
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
  onPinSession,
  onAssignSessionProject,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  onCreateGroup,
  onToggleGroupCollapsed,
  onDeleteGroup,
}: SessionSidebarProps) {
  const { locale, t } = useI18n();
  const [internalQuery, setInternalQuery] = useState('');
  const [internalFilter, setInternalFilter] = useState<string>('all');
  const [localGroupCollapsed, setLocalGroupCollapsed] = useState<Record<string, boolean>>({});
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [openActionSessionId, setOpenActionSessionId] = useState<string | null>(null);
  const [showFilterDrawer, setShowFilterDrawer] = useState(false);

  const [showNewProjectForm, setShowNewProjectForm] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectPath, setProjectPath] = useState(defaultSessionPath || '');
  const [projectGroupId, setProjectGroupId] = useState('');
  const [projectCreateDir, setProjectCreateDir] = useState(false);
  const [submittingProject, setSubmittingProject] = useState(false);

  const [showNewGroupForm, setShowNewGroupForm] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [submittingGroup, setSubmittingGroup] = useState(false);

  const effectiveQuery = searchQuery !== undefined ? searchQuery : internalQuery;
  const deferredQuery = useDeferredValue(effectiveQuery);
  const effectiveFilter = selectedProjectFilter !== undefined ? selectedProjectFilter : internalFilter;
  const hasActiveFilterState = Boolean(
    effectiveQuery.trim() || effectiveFilter !== 'all' || includeInternal,
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
    if (!onCreateProject || submittingProject) return;
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
    if (!onCreateGroup || submittingGroup) return;
    const trimmedName = groupName.trim();
    if (!trimmedName) return;

    setSubmittingGroup(true);
    try {
      await onCreateGroup(trimmedName);
      setGroupName('');
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

  const sortedGroups = useMemo(
    () =>
      [...projectGroups].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      ),
    [projectGroups],
  );

  const { projectsByGroup, ungroupedProjects } = useMemo(() => {
    const groupIds = new Set(sortedGroups.map((g) => g.id));
    const grouped = new Map<string, ProjectItem[]>();
    const ungrouped: ProjectItem[] = [];
    for (const proj of projects) {
      if (proj.groupId && groupIds.has(proj.groupId)) {
        const list = grouped.get(proj.groupId) ?? [];
        list.push(proj);
        grouped.set(proj.groupId, list);
      } else {
        ungrouped.push(proj);
      }
    }
    return { projectsByGroup: grouped, ungroupedProjects: ungrouped };
  }, [projects, sortedGroups]);

  const sortedSessions = useMemo(
    () =>
      [...sessions].sort((a, b) => {
        const aPinned = a.pinned === true;
        const bPinned = b.pinned === true;
        if (aPinned !== bPinned) {
          return aPinned ? -1 : 1;
        }
        if (aPinned && bPinned) {
          const pa =
            parseTimestamp(a.pinnedAt) ||
            parseTimestamp(a.lastModifiedTime) ||
            parseTimestamp(a.createdTime);
          const pb =
            parseTimestamp(b.pinnedAt) ||
            parseTimestamp(b.lastModifiedTime) ||
            parseTimestamp(b.createdTime);
          if (pb !== pa) return pb - pa;
        }
        const tb = parseTimestamp(b.lastModifiedTime) || parseTimestamp(b.createdTime);
        const ta = parseTimestamp(a.lastModifiedTime) || parseTimestamp(a.createdTime);
        return tb - ta;
      }),
    [sessions],
  );

  const sortedAndFiltered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return sortedSessions.filter((s) => {
      if (effectiveFilter === '__none__') {
        if (s.projectId) return false;
      } else if (effectiveFilter && effectiveFilter !== 'all') {
        if (s.projectId !== effectiveFilter) return false;
      }

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
    });
  }, [sortedSessions, effectiveFilter, deferredQuery, projectById, t]);

  const allSessionCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      if (s.projectId) {
        counts.set(s.projectId, (counts.get(s.projectId) ?? 0) + 1);
      }
    }
    return counts;
  }, [sessions]);

  const { pinnedSessions, regularByProject, standaloneRegularSessions } = useMemo(() => {
    const pinned: SessionSummary[] = [];
    const byProject = new Map<string, SessionSummary[]>();
    const standalone: SessionSummary[] = [];

    for (const s of sortedAndFiltered) {
      if (s.pinned === true) {
        pinned.push(s);
        continue;
      }
      if (s.projectId && projectById.has(s.projectId)) {
        const list = byProject.get(s.projectId) ?? [];
        list.push(s);
        byProject.set(s.projectId, list);
      } else {
        standalone.push(s);
      }
    }

    return {
      pinnedSessions: pinned,
      regularByProject: byProject,
      standaloneRegularSessions: standalone,
    };
  }, [sortedAndFiltered, projectById]);

  const hasProjectsOrGroups = projects.length > 0 || projectGroups.length > 0;
  const isSearching = deferredQuery.trim().length > 0;
  const isSpecificProjectFilter =
    effectiveFilter !== 'all' && effectiveFilter !== '__none__';

  const handleToggleGroup = (group: ProjectGroup) => {
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

  const handleToggleRowMenu = (cascadeId: string) => {
    setOpenActionSessionId((prev) => (prev === cascadeId ? null : cascadeId));
  };

  const renderSessionRow = (session: SessionSummary, isPinnedContext = false) => {
    const resolvedProjectLabel = session.projectId
      ? projectById.get(session.projectId)?.name || session.projectName || t('sidebar.noProject')
      : t('sidebar.noProject');

    return (
      <SessionSidebarRow
        key={session.cascadeId}
        session={session}
        isActive={session.cascadeId === activeSessionId}
        showProjectSubtitle={isPinnedContext}
        projectLabel={resolvedProjectLabel}
        locale={locale}
        t={t}
        projects={projects}
        isMenuOpen={openActionSessionId === session.cascadeId}
        onToggleMenu={handleToggleRowMenu}
        onSelectSession={onSelectSession}
        onPinSession={onPinSession}
        onAssignSessionProject={onAssignSessionProject}
      />
    );
  };

  const shouldRenderProject = (proj: ProjectItem): boolean => {
    if (effectiveFilter === '__none__') return false;
    if (isSpecificProjectFilter) return proj.id === effectiveFilter;
    if (isSearching) {
      const q = deferredQuery.trim().toLowerCase();
      const matchesProjectMeta =
        proj.name.toLowerCase().includes(q) ||
        (proj.rootPath || '').toLowerCase().includes(q);
      return matchesProjectMeta || (regularByProject.get(proj.id)?.length ?? 0) > 0;
    }
    return true;
  };

  const renderProjectNode = (proj: ProjectItem) => {
    if (!shouldRenderProject(proj)) return null;
    const projSessions = regularByProject.get(proj.id) ?? [];
    const totalSessionCount = Math.max(
      allSessionCountByProject.get(proj.id) ?? 0,
      typeof proj.sessionCount === 'number' ? proj.sessionCount : 0,
    );
    const isExpanded = isSearching || isSpecificProjectFilter ? true : !collapsedProjects[proj.id];

    return (
      <ProjectTreeItem
        key={proj.id}
        project={proj}
        sessions={projSessions}
        totalSessionCount={totalSessionCount}
        isExpanded={isExpanded}
        isFilterSelected={effectiveFilter === proj.id}
        creating={creating}
        groups={sortedGroups}
        t={t}
        onHeaderClick={handleProjectHeaderClick}
        onCreateSession={onCreateSession}
        onUpdateProject={onUpdateProject}
        onDeleteProject={onDeleteProject}
        renderSessionRow={(s) => renderSessionRow(s, false)}
      />
    );
  };

  const showInternalToggle = Boolean(onToggleIncludeInternal || hiddenInternalCount > 0);
  const hasVisibleProjects =
    effectiveFilter !== '__none__' && projects.some(shouldRenderProject);
  const showEmptyFilteredState =
    sortedAndFiltered.length === 0 &&
    ((isSearching && !hasVisibleProjects) ||
      effectiveFilter === '__none__' ||
      !hasProjectsOrGroups);

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
            {sessions.length}
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
              aria-expanded={showNewGroupForm}
              title={t('sidebar.newGroupTooltip')}
              aria-label={t('sidebar.newGroupTooltip')}
              data-testid="open-new-group-btn"
            >
              <GroupPlusGlyph />
            </button>
          )}
          {onCreateProject && (
            <button
              type="button"
              className={`${styles.toolbarIconBtn} ${showNewProjectForm ? styles.toolbarIconBtnActive : ''}`}
              onClick={handleToggleProjectForm}
              aria-expanded={showNewProjectForm}
              title={t('sidebar.newProject')}
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
            disabled={creating}
            title={creating ? t('sidebar.creating') : t('sidebar.newStandaloneSession')}
            aria-label={creating ? t('sidebar.creating') : t('sidebar.newStandaloneSession')}
            data-testid="new-session-btn"
          >
            <PlusGlyph />
          </button>
        </div>
      </div>

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
              className={`${styles.filterPill} ${effectiveFilter === 'all' ? styles.filterPillActive : ''}`}
              aria-pressed={effectiveFilter === 'all'}
              onClick={() => handleFilterChange('all')}
              data-testid="project-filter-all"
            >
              {t('sidebar.allProjects')}
            </button>
            <button
              type="button"
              className={`${styles.filterPill} ${effectiveFilter === '__none__' ? styles.filterPillActive : ''}`}
              aria-pressed={effectiveFilter === '__none__'}
              onClick={() => handleFilterChange('__none__')}
              data-testid="project-filter-none"
            >
              {t('sidebar.standaloneSessions')}
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

      {showNewProjectForm && onCreateProject && (
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
            onChange={(ev) => setProjectPath(ev.target.value)}
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
          <input
            type="text"
            className={styles.formInput}
            placeholder={t('sidebar.groupNamePlaceholder')}
            aria-label={t('sidebar.groupNamePlaceholder')}
            value={groupName}
            onChange={(ev) => setGroupName(ev.target.value)}
            data-testid="new-group-name"
          />
          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.formCancelBtn}
              onClick={() => setShowNewGroupForm(false)}
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

      <div className={styles.list} role="list" aria-label={t('sidebar.sessions')}>
        {loading && sessions.length === 0 && !hasProjectsOrGroups ? (
          <div className={styles.stateBox} data-testid="sidebar-loading">
            {t('sidebar.loading')}
          </div>
        ) : showEmptyFilteredState ? (
          <div className={styles.stateBox} data-testid="sidebar-empty">
            {isSearching || effectiveFilter !== 'all'
              ? t('sidebar.emptyFiltered')
              : t('sidebar.empty')}
          </div>
        ) : (
          <>
            {pinnedSessions.length > 0 && (
              <div className={styles.pinnedSection} data-testid="pinned-sessions-section">
                <div className={styles.sectionHeader}>{t('sidebar.pinnedSection')}</div>
                {pinnedSessions.map((s) => renderSessionRow(s, true))}
              </div>
            )}

            {effectiveFilter !== '__none__' &&
              sortedGroups.map((group) => {
                const isCollapsed = onToggleGroupCollapsed
                  ? group.collapsed
                  : (localGroupCollapsed[group.id] ?? group.collapsed);
                const groupProjects = projectsByGroup.get(group.id) ?? [];
                const visibleProjects = groupProjects.filter(shouldRenderProject);

                if (isSpecificProjectFilter && visibleProjects.length === 0) {
                  return null;
                }
                if (isSearching && visibleProjects.length === 0) {
                  return null;
                }

                const effectiveCollapsed =
                  isSearching || isSpecificProjectFilter ? false : isCollapsed;

                return (
                  <div
                    key={group.id}
                    className={styles.projectGroup}
                    data-testid={`project-group-${group.id}`}
                    data-collapsed={effectiveCollapsed ? 'true' : 'false'}
                  >
                    <div className={styles.groupHeader}>
                      <button
                        type="button"
                        className={styles.groupToggleBtn}
                        data-testid={`toggle-group-${group.id}`}
                        aria-expanded={!effectiveCollapsed}
                        aria-label={
                          effectiveCollapsed
                            ? t('sidebar.expandGroup')
                            : t('sidebar.collapseGroup')
                        }
                        onClick={() => handleToggleGroup(group)}
                      >
                        <ChevronGlyph expanded={!effectiveCollapsed} />
                        <span className={styles.groupName}>{group.name}</span>
                        <span className={styles.groupCount}>{groupProjects.length}</span>
                      </button>
                      {onDeleteGroup && (
                        <button
                          type="button"
                          className={`${styles.iconBtn} ${styles.iconBtnDanger} ${styles.groupDeleteBtn}`}
                          data-testid={`delete-group-${group.id}`}
                          title={t('sidebar.deleteGroup')}
                          aria-label={t('sidebar.deleteGroup')}
                          onClick={(e) => {
                            e.stopPropagation();
                            void onDeleteGroup(group.id);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {!effectiveCollapsed && visibleProjects.length > 0 && (
                      <div className={styles.groupItems}>
                        {visibleProjects.map(renderProjectNode)}
                      </div>
                    )}
                  </div>
                );
              })}

            {effectiveFilter !== '__none__' &&
              ungroupedProjects.some(shouldRenderProject) && (
                <div className={styles.ungroupedSection}>
                  {ungroupedProjects.map(renderProjectNode)}
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
                    standaloneRegularSessions.map((s) => renderSessionRow(s, false))
                  ) : (
                    <div className={styles.emptyProjectHint}>{t('sidebar.emptyFiltered')}</div>
                  )}
                </div>
              ) : (
                standaloneRegularSessions.map((s) => renderSessionRow(s, false))
              ))}
          </>
        )}
      </div>
    </div>
  );
});
