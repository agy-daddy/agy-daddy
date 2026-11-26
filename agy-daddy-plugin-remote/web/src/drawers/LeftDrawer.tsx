import { useMemo, useState } from 'preact/hooks';
import { useI18n, type I18nKey, type TranslateFn } from '../i18n';
import { normalizeRootUri } from '../store/useRemoteStore';
import type {
  AppearanceMode,
  HostProject,
  PermissionLevel,
  PinKind,
  SessionGroup,
  SessionPins,
  SessionSummary,
  WorkspaceOption
} from '../types';
import styles from './LeftDrawer.module.css';

export interface LeftDrawerProps {
  sessions: SessionSummary[];
  activeSessionId: string;
  workspaces: Array<WorkspaceOption | string>;
  groups?: SessionGroup[];
  projects?: HostProject[];
  pins?: SessionPins;
  channel: string;
  permissionLevel: PermissionLevel;
  token: string;
  appearance: AppearanceMode;
  soundAlert: boolean;
  vibrateAlert: boolean;
  pushSubscribed: boolean;
  pushBusy: boolean;
  onSelectSession: (id: string) => void;
  onCreateSession: (title?: string, workspaceUri?: string) => Promise<void>;
  onTogglePin?: (type: PinKind, id: string, nextPinned?: boolean) => Promise<void> | void;
  onCreateGroup?: (name: string) => Promise<void> | void;
  onCycleAppearance: () => void;
  onToggleSound: () => void;
  onToggleVibrate: () => void;
  onTogglePush: () => Promise<void>;
  onTestPush: () => Promise<void>;
  onOpenChannels?: () => void;
  onClose: () => void;
}

const PERM_DESC_KEYS: Record<PermissionLevel, I18nKey> = {
  L0: 'left.permDescL0',
  L1: 'left.permDescL1',
  L2: 'left.permDescL2'
};

const APPEARANCE_KEYS: Record<AppearanceMode, I18nKey> = {
  auto: 'menu.appearanceAuto',
  dark: 'menu.appearanceDark',
  light: 'menu.appearanceLight'
};

const UNASSIGNED_PROJECT_ID = '__unassigned__';

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M9.8 2.2L13.8 6.2L12.6 7.4L11.4 6.8L8.8 9.4L9.4 11.4L8.2 12.6L5.8 10.2L2.6 13.4L2.6 13.4L5.8 10.2L3.4 7.8L4.6 6.6L6.6 7.2L9.2 4.6L8.6 3.4L9.8 2.2Z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="7.2" cy="7.2" r="4.8" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.9 10.9L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}
    >
      <path
        d="M6 3.5L10.5 8L6 12.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function basenameOf(uriOrPath: string | null | undefined): string {
  const norm = normalizeRootUri(uriOrPath);
  if (!norm) return '';
  const parts = norm.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || norm;
}

function formatRelTime(iso: string | null | undefined, t: TranslateFn): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return t('left.justNow');
  if (diffSec < 3600) return t('left.minsAgo', { n: Math.floor(diffSec / 60) });
  if (diffSec < 86400) return t('left.hoursAgo', { n: Math.floor(diffSec / 3600) });
  return t('left.daysAgo', { n: Math.floor(diffSec / 86400) });
}

interface ProjectBucket {
  id: string;
  name: string;
  uri: string | null;
  branchName: string | null;
  groupId: string | null;
  pinned: boolean;
  isFallback: boolean;
  sessions: SessionSummary[];
  latestTs: number;
}

export function LeftDrawer(props: LeftDrawerProps) {
  const { t } = useI18n();
  const {
    sessions,
    activeSessionId,
    workspaces,
    groups = [],
    projects = [],
    pins,
    channel,
    permissionLevel,
    appearance,
    soundAlert,
    vibrateAlert,
    pushSubscribed,
    pushBusy,
    onSelectSession,
    onCreateSession,
    onTogglePin,
    onCreateGroup,
    onCycleAppearance,
    onToggleSound,
    onToggleVibrate,
    onTogglePush,
    onTestPush,
    onClose
  } = props;

  const [searchQuery, setSearchQuery] = useState('');
  const [activeGroupId, setActiveGroupId] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'running' | 'attention'>('all');
  const [showSubagents, setShowSubagents] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newWs, setNewWs] = useState('');

  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [submittingGroup, setSubmittingGroup] = useState(false);

  const pinnedSessionSet = useMemo(() => {
    const set = new Set<string>(pins?.sessions || []);
    for (const s of sessions) {
      if (s.pinned) set.add(s.cascadeId);
    }
    return set;
  }, [pins?.sessions, sessions]);

  const pinnedProjectSet = useMemo(() => {
    const set = new Set<string>(pins?.projects || []);
    for (const p of projects) {
      if (p.pinned) set.add(p.id);
    }
    return set;
  }, [pins?.projects, projects]);

  const pinnedGroupSet = useMemo(() => {
    const set = new Set<string>(pins?.groups || []);
    for (const g of groups) {
      if (g.pinned) set.add(g.id);
    }
    return set;
  }, [pins?.groups, groups]);

  const subagentCount = useMemo(
    () => sessions.filter((s) => Boolean(s.isSubagent)).length,
    [sessions]
  );

  const baseSessions = useMemo(
    () => (showSubagents ? sessions : sessions.filter((s) => !s.isSubagent)),
    [sessions, showSubagents]
  );

  const attentionSessions = useMemo(
    () => baseSessions.filter((s) => s.needsAttention),
    [baseSessions]
  );

  const runningCount = useMemo(
    () => baseSessions.filter((s) => String(s.status || '').includes('RUNNING')).length,
    [baseSessions]
  );

  const uniqueWorkspaces = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) {
      const uri = p.uri || p.path || '';
      if (uri) map.set(uri, p.name || basenameOf(uri) || uri);
    }
    for (const w of workspaces) {
      const uri = typeof w === 'string' ? w : w.uri || w.path || '';
      const name =
        typeof w === 'string'
          ? basenameOf(w) || w
          : w.name || basenameOf(uri) || uri;
      if (uri && !map.has(uri)) map.set(uri, name);
    }
    for (const s of sessions) {
      if (s.workspaceUri && !map.has(s.workspaceUri)) {
        map.set(s.workspaceUri, s.projectName || basenameOf(s.workspaceUri) || s.workspaceUri);
      }
    }
    return Array.from(map.entries());
  }, [projects, workspaces, sessions]);

  // Sorted host + user groups
  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) => {
      const ap = pinnedGroupSet.has(a.id) ? 1 : 0;
      const bp = pinnedGroupSet.has(b.id) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      const ao = typeof a.order === 'number' ? a.order : 9999;
      const bo = typeof b.order === 'number' ? b.order : 9999;
      if (ao !== bo) return ao - bo;
      return a.name.localeCompare(b.name);
    });
  }, [groups, pinnedGroupSet]);

  const activeGroup = useMemo(
    () => sortedGroups.find((g) => g.id === activeGroupId) || null,
    [sortedGroups, activeGroupId]
  );

  const projectById = useMemo(() => {
    const map = new Map<string, HostProject>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  const projectByNormUri = useMemo(() => {
    const map = new Map<string, HostProject>();
    for (const p of projects) {
      const n1 = normalizeRootUri(p.uri);
      const n2 = normalizeRootUri(p.path);
      if (n1) map.set(n1, p);
      if (n2) map.set(n2, p);
    }
    return map;
  }, [projects]);

  const sessionBelongsToGroup = (s: SessionSummary, g: SessionGroup): boolean => {
    if (s.groupId && s.groupId === g.id) return true;
    if (Array.isArray(g.sessionIds) && g.sessionIds.includes(s.cascadeId)) return true;
    if (s.projectId && Array.isArray(g.projectIds) && g.projectIds.includes(s.projectId)) return true;
    const normWs = normalizeRootUri(s.workspaceUri);
    if (normWs && Array.isArray(g.workspaceUris)) {
      if (g.workspaceUris.some((u) => normalizeRootUri(u) === normWs)) return true;
    }
    if (s.projectId) {
      const p = projectById.get(s.projectId);
      if (p?.groupId === g.id) return true;
    }
    if (normWs) {
      const p = projectByNormUri.get(normWs);
      if (p?.groupId === g.id) return true;
    }
    return false;
  };

  const groupSessionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of sortedGroups) {
      let c = 0;
      for (const s of baseSessions) {
        if (sessionBelongsToGroup(s, g)) c++;
      }
      counts.set(g.id, c);
    }
    return counts;
  }, [sortedGroups, baseSessions, projectById, projectByNormUri]);

  // Filter sessions by search, group, status
  const queryLower = searchQuery.trim().toLowerCase();

  const matchingSessions = useMemo(() => {
    return baseSessions.filter((s) => {
      if (activeGroup && !sessionBelongsToGroup(s, activeGroup)) return false;
      if (statusFilter === 'running' && !String(s.status || '').includes('RUNNING')) return false;
      if (statusFilter === 'attention' && !s.needsAttention) return false;
      if (queryLower) {
        const hay = [
          s.title,
          s.summary,
          s.branchName,
          s.projectName,
          basenameOf(s.workspaceUri),
          s.cascadeId
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(queryLower)) return false;
      }
      return true;
    });
  }, [baseSessions, activeGroup, statusFilter, queryLower, projectById, projectByNormUri]);

  // Pinned sessions & pinned projects (shown in floating Pinned section at top)
  const pinnedSessions = useMemo(() => {
    return matchingSessions.filter((s) => pinnedSessionSet.has(s.cascadeId));
  }, [matchingSessions, pinnedSessionSet]);

  const pinnedProjects = useMemo(() => {
    return projects.filter((p) => {
      if (!pinnedProjectSet.has(p.id)) return false;
      if (activeGroup) {
        const inGroup =
          p.groupId === activeGroup.id ||
          (Array.isArray(activeGroup.projectIds) && activeGroup.projectIds.includes(p.id));
        if (!inGroup) return false;
      }
      if (queryLower) {
        const hay = `${p.name} ${p.branchName || ''}`.toLowerCase();
        if (!hay.includes(queryLower)) return false;
      }
      return true;
    });
  }, [projects, pinnedProjectSet, activeGroup, queryLower]);

  // Build Project Accordions
  const projectBuckets = useMemo<ProjectBucket[]>(() => {
    const map = new Map<string, ProjectBucket>();

    // Seed with host projects matching active group (and search if query matches project name)
    for (const p of projects) {
      if (activeGroup) {
        const inGroup =
          p.groupId === activeGroup.id ||
          (Array.isArray(activeGroup.projectIds) && activeGroup.projectIds.includes(p.id)) ||
          (p.uri &&
            Array.isArray(activeGroup.workspaceUris) &&
            activeGroup.workspaceUris.some((u) => normalizeRootUri(u) === normalizeRootUri(p.uri)));
        if (!inGroup) continue;
      }
      const ts = p.lastModifiedTime ? Date.parse(p.lastModifiedTime) || 0 : 0;
      map.set(p.id, {
        id: p.id,
        name: p.name || basenameOf(p.uri || p.path) || p.id,
        uri: p.uri || p.path || null,
        branchName: p.branchName || null,
        groupId: p.groupId || null,
        pinned: pinnedProjectSet.has(p.id),
        isFallback: false,
        sessions: [],
        latestTs: ts
      });
    }

    // Assign matching sessions into project buckets
    for (const s of matchingSessions) {
      let bucket: ProjectBucket | undefined;
      if (s.projectId && map.has(s.projectId)) {
        bucket = map.get(s.projectId);
      } else if (s.workspaceUri) {
        const normWs = normalizeRootUri(s.workspaceUri);
        const matchedProj = projectByNormUri.get(normWs);
        if (matchedProj && map.has(matchedProj.id)) {
          bucket = map.get(matchedProj.id);
        } else {
          const synthId = `ws:${normWs || s.workspaceUri}`;
          bucket = map.get(synthId);
          if (!bucket) {
            bucket = {
              id: synthId,
              name: s.projectName || basenameOf(s.workspaceUri) || s.workspaceUri,
              uri: s.workspaceUri,
              branchName: s.branchName || null,
              groupId: s.groupId || null,
              pinned: pinnedProjectSet.has(synthId),
              isFallback: false,
              sessions: [],
              latestTs: 0
            };
            map.set(synthId, bucket);
          }
        }
      }

      if (!bucket) {
        bucket = map.get(UNASSIGNED_PROJECT_ID);
        if (!bucket) {
          bucket = {
            id: UNASSIGNED_PROJECT_ID,
            name: t('left.unassigned'),
            uri: null,
            branchName: null,
            groupId: null,
            pinned: false,
            isFallback: true,
            sessions: [],
            latestTs: 0
          };
          map.set(UNASSIGNED_PROJECT_ID, bucket);
        }
      }

      bucket.sessions.push(s);
      const st = s.lastModifiedTime ? Date.parse(s.lastModifiedTime) || 0 : 0;
      if (st > bucket.latestTs) bucket.latestTs = st;
      if (!bucket.branchName && s.branchName) bucket.branchName = s.branchName;
    }

    // Filter out empty buckets when filtering by search/status, unless project name itself matches search
    const list = Array.from(map.values()).filter((b) => {
      if (b.sessions.length > 0) return true;
      if (statusFilter !== 'all') return false;
      if (queryLower) {
        return (
          b.name.toLowerCase().includes(queryLower) ||
          (b.branchName || '').toLowerCase().includes(queryLower)
        );
      }
      // Show non-fallback empty host projects only when no restrictive filter is active
      return !b.isFallback;
    });

    // Sort sessions inside each bucket: pinned first, then needsAttention, then running, then recent
    for (const b of list) {
      b.sessions.sort((a, c) => {
        const ap = pinnedSessionSet.has(a.cascadeId) ? 1 : 0;
        const cp = pinnedSessionSet.has(c.cascadeId) ? 1 : 0;
        if (ap !== cp) return cp - ap;
        const aa = a.needsAttention ? 1 : 0;
        const ca = c.needsAttention ? 1 : 0;
        if (aa !== ca) return ca - aa;
        const at = a.lastModifiedTime ? Date.parse(a.lastModifiedTime) || 0 : 0;
        const ct = c.lastModifiedTime ? Date.parse(c.lastModifiedTime) || 0 : 0;
        return ct - at;
      });
    }

    // Sort buckets: fallback always last; pinned first; active session bucket next; then latest activity
    list.sort((a, b) => {
      if (a.isFallback !== b.isFallback) return a.isFallback ? 1 : -1;
      if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
      const aHasActive = a.sessions.some((s) => s.cascadeId === activeSessionId) ? 1 : 0;
      const bHasActive = b.sessions.some((s) => s.cascadeId === activeSessionId) ? 1 : 0;
      if (aHasActive !== bHasActive) return bHasActive - aHasActive;
      if (a.sessions.length === 0 && b.sessions.length > 0) return 1;
      if (b.sessions.length === 0 && a.sessions.length > 0) return -1;
      return b.latestTs - a.latestTs;
    });

    return list;
  }, [
    projects,
    matchingSessions,
    activeGroup,
    pinnedProjectSet,
    pinnedSessionSet,
    projectByNormUri,
    statusFilter,
    queryLower,
    activeSessionId
  ]);

  const handleCreate = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onCreateSession(newTitle.trim() || undefined, newWs || undefined);
      setNewTitle('');
      setCreating(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleQuickCreateInProject = (workspaceUri: string | null) => {
    setNewWs(workspaceUri || '');
    setNewTitle('');
    setCreating(true);
  };

  const handleCreateGroup = async () => {
    const clean = newGroupName.trim();
    if (!clean || submittingGroup || !onCreateGroup) return;
    setSubmittingGroup(true);
    try {
      await onCreateGroup(clean);
      setNewGroupName('');
      setCreatingGroup(false);
    } finally {
      setSubmittingGroup(false);
    }
  };

  const toggleProjectCollapsed = (projectId: string) => {
    setCollapsedProjects((prev) => ({ ...prev, [projectId]: !prev[projectId] }));
  };

  const canWrite = permissionLevel !== 'L0';

  const renderSessionRow = (s: SessionSummary, showProjectBadge: boolean) => {
    const isRunning = String(s.status || '').includes('RUNNING');
    const active = s.cascadeId === activeSessionId;
    const isPinned = pinnedSessionSet.has(s.cascadeId);
    const rel = formatRelTime(s.lastModifiedTime, t);
    const projLabel = s.projectName || basenameOf(s.workspaceUri);

    return (
      <div
        key={s.cascadeId}
        className={`${styles.sessRow} ${active ? styles.sessActive : ''}`}
      >
        <button
          type="button"
          className={styles.sessMainBtn}
          onClick={() => onSelectSession(s.cascadeId)}
        >
          <div className={styles.sessTop}>
            <span
              className={`${styles.dot} ${s.needsAttention ? styles.dotAttn : isRunning ? styles.dotRun : ''}`}
              aria-hidden="true"
            />
            <span className={styles.sessTitle}>{s.title || s.cascadeId}</span>
            {s.needsAttention && (
              <span className="ag-chip" data-tone="danger">
                {s.attentionReason || t('left.filterAttention')}
              </span>
            )}
          </div>
          <div className={styles.sessMeta}>
            {showProjectBadge && projLabel && (
              <span className={styles.projTag}>{projLabel}</span>
            )}
            {s.branchName && <span className={styles.branchTag}>{s.branchName}</span>}
            <span>{t('left.stepsCount', { count: s.stepCount })}</span>
            {rel && <span>· {rel}</span>}
          </div>
        </button>

        {canWrite && onTogglePin && (
          <button
            type="button"
            className={`${styles.pinBtn} ${isPinned ? styles.pinActive : ''}`}
            data-testid={`pin-session-${s.cascadeId}`}
            aria-label={isPinned ? t('left.unpinSession') : t('left.pinSession')}
            title={isPinned ? t('left.unpinSession') : t('left.pinSession')}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin('session', s.cascadeId, !isPinned);
            }}
          >
            <PinIcon filled={isPinned} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div className={styles.wrap}>
      {/* Sticky Drawer Header */}
      <div className={styles.head}>
        <div className={styles.headTitle}>
          <strong>{t('left.title')}</strong>
          <span className={styles.headCount}>{baseSessions.length}</span>
        </div>
        <div className={styles.headActions}>
          {canWrite && (
            <button
              type="button"
              className="ag-pill-btn ag-pill-btn-primary"
              onClick={() => {
                setNewWs('');
                setCreating((v) => !v);
              }}
            >
              {t('left.newSessionBtn')}
            </button>
          )}
          <button
            type="button"
            className={styles.closeBtn}
            aria-label={t('left.closeDrawer')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Search + Segmented Status Filter */}
      <div className={styles.controlsBar}>
        <div className={styles.searchWrap}>
          <span className={styles.searchIcon}>
            <SearchIcon />
          </span>
          <input
            type="search"
            className={styles.searchInput}
            data-testid="left-search-input"
            placeholder={t('left.searchPlaceholder')}
            value={searchQuery}
            onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
          />
          {searchQuery && (
            <button
              type="button"
              className={styles.clearBtn}
              aria-label={t('left.clearSearch')}
              onClick={() => setSearchQuery('')}
            >
              ✕
            </button>
          )}
        </div>

        <div className={styles.segmented} role="tablist" aria-label={t('left.filterAria')}>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'all'}
            className={`${styles.segBtn} ${statusFilter === 'all' ? styles.segActive : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            {t('left.filterAll')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'running'}
            className={`${styles.segBtn} ${statusFilter === 'running' ? styles.segActive : ''}`}
            onClick={() => setStatusFilter('running')}
          >
            {t('left.filterRunning')}
            {runningCount > 0 ? ` ${runningCount}` : ''}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={statusFilter === 'attention'}
            className={`${styles.segBtn} ${statusFilter === 'attention' ? styles.segActive : ''}`}
            onClick={() => setStatusFilter('attention')}
          >
            {t('left.filterAttention')}
            {attentionSessions.length > 0 ? ` ${attentionSessions.length}` : ''}
          </button>
        </div>

        {/* Horizontal Scrollable Group Filter Pills */}
        {(sortedGroups.length > 0 || (canWrite && onCreateGroup)) && (
          <div
            className={styles.groupBar}
            data-hscroll="1"
            data-testid="group-filter-bar"
            role="tablist"
            aria-label={t('left.groupFilterAria')}
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeGroupId === 'all'}
              className={`${styles.groupPill} ${activeGroupId === 'all' ? styles.groupPillActive : ''}`}
              onClick={() => setActiveGroupId('all')}
            >
              <span>{t('left.allGroups')}</span>
              <span className={styles.pillCount}>{baseSessions.length}</span>
            </button>

            {sortedGroups.map((g) => {
              const selected = activeGroupId === g.id;
              const isPinned = pinnedGroupSet.has(g.id);
              const cnt = groupSessionCounts.get(g.id) ?? 0;
              return (
                <div
                  key={g.id}
                  className={`${styles.groupPillWrap} ${selected ? styles.groupPillActive : ''}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={styles.groupPillBtn}
                    onClick={() => setActiveGroupId(g.id)}
                  >
                    {isPinned && <span className={styles.groupPinDot} aria-hidden="true">•</span>}
                    <span className={styles.groupName}>{g.name}</span>
                    <span className={styles.pillCount}>{cnt}</span>
                  </button>
                  {selected && canWrite && onTogglePin && (
                    <button
                      type="button"
                      className={styles.groupInlinePin}
                      aria-label={isPinned ? t('left.unpinGroup') : t('left.pinGroup')}
                      title={isPinned ? t('left.unpinGroup') : t('left.pinGroup')}
                      onClick={(e) => {
                        e.stopPropagation();
                        onTogglePin('group', g.id, !isPinned);
                      }}
                    >
                      <PinIcon filled={isPinned} />
                    </button>
                  )}
                </div>
              );
            })}

            {canWrite && onCreateGroup && (
              <button
                type="button"
                className={styles.groupAddBtn}
                onClick={() => setCreatingGroup((v) => !v)}
              >
                {t('left.addGroup')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Main Scrollable Content */}
      <div className={styles.body}>
        {/* New Session Card */}
        {creating && (
          <div className={styles.inlineFormCard}>
            <div className={styles.formHeader}>{t('left.newSessionTitle')}</div>
            <input
              type="text"
              className="ag-input"
              placeholder={t('left.sessionTitlePlaceholder')}
              value={newTitle}
              onInput={(e) => setNewTitle((e.target as HTMLInputElement).value)}
            />
            {uniqueWorkspaces.length > 0 && (
              <select
                className="ag-input"
                value={newWs}
                onChange={(e) => setNewWs((e.target as HTMLSelectElement).value)}
              >
                <option value="">{t('left.defaultWorkspace')}</option>
                {uniqueWorkspaces.map(([uri, name]) => (
                  <option key={uri} value={uri}>
                    {name}
                  </option>
                ))}
              </select>
            )}
            <div className={styles.formActions}>
              <button
                type="button"
                className="ag-pill-btn"
                disabled={submitting}
                onClick={() => setCreating(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="ag-pill-btn ag-pill-btn-primary"
                disabled={submitting}
                onClick={handleCreate}
              >
                {submitting
                  ? t('left.creating')
                  : newTitle.trim()
                    ? t('left.createSession')
                    : t('left.createBlankSession')}
              </button>
            </div>
          </div>
        )}

        {/* New Group Card */}
        {creatingGroup && canWrite && onCreateGroup && (
          <div className={styles.inlineFormCard}>
            <div className={styles.formHeader}>{t('left.newGroupTitle')}</div>
            <input
              type="text"
              className="ag-input"
              placeholder={t('left.groupNamePlaceholder')}
              value={newGroupName}
              onInput={(e) => setNewGroupName((e.target as HTMLInputElement).value)}
            />
            <div className={styles.formActions}>
              <button
                type="button"
                className="ag-pill-btn"
                disabled={submittingGroup}
                onClick={() => setCreatingGroup(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="ag-pill-btn ag-pill-btn-primary"
                disabled={submittingGroup || !newGroupName.trim()}
                onClick={handleCreateGroup}
              >
                {submittingGroup ? t('left.saving') : t('left.createGroup')}
              </button>
            </div>
          </div>
        )}

        {/* Compact Needs Attention Banner */}
        {attentionSessions.length > 0 && (
          <div className={styles.attnBox} data-testid="needs-attention-queue">
            <div className={styles.attnHead}>
              <span>{t('left.pendingTitle', { count: attentionSessions.length })}</span>
            </div>
            <div className={styles.attnList}>
              {attentionSessions.map((s) => (
                <button
                  key={s.cascadeId}
                  type="button"
                  className={styles.attnItem}
                  onClick={() => onSelectSession(s.cascadeId)}
                >
                  <span className={styles.sessTitle}>{s.title || s.cascadeId}</span>
                  <span className="ag-chip" data-tone="danger">
                    {s.attentionReason || t('left.pendingApprove')}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Pinned Sessions & Projects Section */}
        {(pinnedSessions.length > 0 || pinnedProjects.length > 0) && (
          <section className={styles.section} data-testid="pinned-section">
            <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>
                <PinIcon filled />{' '}
                {t('left.pinnedTitle', { count: pinnedSessions.length + pinnedProjects.length })}
              </span>
            </div>
            {pinnedProjects.length > 0 && (
              <div className={styles.pinnedProjRow}>
                {pinnedProjects.map((proj) => (
                  <div key={proj.id} className={styles.pinnedProjChip}>
                    <button
                      type="button"
                      className={styles.pinnedProjMain}
                      onClick={() => {
                        setCollapsedProjects((prev) => ({ ...prev, [proj.id]: false }));
                        const firstSess = matchingSessions.find(
                          (s) =>
                            s.projectId === proj.id ||
                            (proj.uri && normalizeRootUri(s.workspaceUri) === normalizeRootUri(proj.uri))
                        );
                        if (firstSess) onSelectSession(firstSess.cascadeId);
                      }}
                    >
                      <span className={styles.pinnedProjName}>{proj.name}</span>
                      {proj.branchName && <span className={styles.branchTag}>{proj.branchName}</span>}
                    </button>
                    {canWrite && (
                      <button
                        type="button"
                        className={styles.iconMiniBtn}
                        aria-label={t('left.newInProject', { name: proj.name })}
                        title={t('left.newSessionTitle')}
                        onClick={() => handleQuickCreateInProject(proj.uri || proj.path || null)}
                      >
                        +
                      </button>
                    )}
                    {canWrite && onTogglePin && (
                      <button
                        type="button"
                        className={`${styles.iconMiniBtn} ${styles.pinActive}`}
                        aria-label={t('left.unpinProject')}
                        title={t('left.unpinProject')}
                        onClick={() => onTogglePin('project', proj.id, false)}
                      >
                        <PinIcon filled />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {pinnedSessions.length > 0 && (
              <div className={styles.sessList}>
                {pinnedSessions.map((s) => renderSessionRow(s, true))}
              </div>
            )}
          </section>
        )}

        {/* Collapsible Project Accordions */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>
              {t('left.projectsSessions', { count: matchingSessions.length })}
            </span>
            {subagentCount > 0 && (
              <button
                type="button"
                className={styles.subToggle}
                onClick={() => setShowSubagents((v) => !v)}
              >
                {showSubagents ? t('left.hideSubagents') : t('left.showSubagents', { count: subagentCount })}
              </button>
            )}
          </div>

          {projectBuckets.length === 0 ? (
            <div className="ag-empty">{t('left.noMatches')}</div>
          ) : (
            <div className={styles.projectList}>
              {projectBuckets.map((proj) => {
                const isCollapsed = Boolean(collapsedProjects[proj.id]);
                const hasRunning = proj.sessions.some((s) =>
                  String(s.status || '').includes('RUNNING')
                );
                return (
                  <div
                    key={proj.id}
                    className={styles.projectCard}
                    data-testid={`project-accordion-${proj.id}`}
                  >
                    <div className={styles.projectHead}>
                      <button
                        type="button"
                        className={styles.projectToggle}
                        aria-expanded={!isCollapsed}
                        onClick={() => toggleProjectCollapsed(proj.id)}
                      >
                        <ChevronIcon open={!isCollapsed} />
                        <span className={styles.projectName}>{proj.name}</span>
                        {hasRunning && <span className={`${styles.dot} ${styles.dotRun}`} />}
                        {proj.branchName && (
                          <span className={styles.branchTag}>{proj.branchName}</span>
                        )}
                        <span className={styles.projCount}>{proj.sessions.length}</span>
                      </button>

                      <div className={styles.projectActions}>
                        {canWrite && onTogglePin && !proj.isFallback && (
                          <button
                            type="button"
                            className={`${styles.iconMiniBtn} ${proj.pinned ? styles.pinActive : ''}`}
                            aria-label={proj.pinned ? t('left.unpinProject') : t('left.pinProject')}
                            title={proj.pinned ? t('left.unpinProject') : t('left.pinProject')}
                            onClick={(e) => {
                              e.stopPropagation();
                              onTogglePin('project', proj.id, !proj.pinned);
                            }}
                          >
                            <PinIcon filled={proj.pinned} />
                          </button>
                        )}
                        {canWrite && (
                          <button
                            type="button"
                            className={styles.iconMiniBtn}
                            aria-label={t('left.newInProject', { name: proj.name })}
                            title={t('left.newInProject', { name: proj.name })}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleQuickCreateInProject(proj.uri);
                            }}
                          >
                            +
                          </button>
                        )}
                      </div>
                    </div>

                    {!isCollapsed && (
                      <div className={styles.projectBody}>
                        {proj.sessions.length === 0 ? (
                          <div className={styles.projectEmpty}>{t('left.projectEmpty')}</div>
                        ) : (
                          proj.sessions.map((s) => renderSessionRow(s, false))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Collapsible System, Notifications & Permissions Footer */}
      <div className={styles.footerWrap}>
        <button
          type="button"
          className={styles.footerToggle}
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((v) => !v)}
        >
          <span className={styles.footerLabel}>{t('left.footerTitle')}</span>
          <span className={styles.footerSummary}>
            {channel} · {permissionLevel} · {t(APPEARANCE_KEYS[appearance])}
            <ChevronIcon open={settingsOpen} />
          </span>
        </button>

        {settingsOpen && (
          <div className={styles.settingsCard}>
            <div className={styles.settingRow}>
              <span>{t('left.currentChannel', { channel })}</span>
              <button
                type="button"
                className="ag-pill-btn"
                onClick={() => {
                  onClose();
                  props.onOpenChannels?.();
                }}
              >
                {t('left.switchChannel')}
              </button>
            </div>
            <div className={styles.settingRow}>
              <span>{t('left.appearanceTheme')}</span>
              <button type="button" className="ag-pill-btn" onClick={onCycleAppearance}>
                {t(APPEARANCE_KEYS[appearance])}
              </button>
            </div>
            <div className={styles.settingRow}>
              <span>{t('menu.pushLockScreen')}</span>
              <div style={{ display: 'flex', gap: 5 }}>
                <button
                  type="button"
                  className="ag-pill-btn"
                  disabled={pushBusy}
                  onClick={onTogglePush}
                >
                  {pushSubscribed ? t('menu.pushEnabled') : t('menu.pushEnable')}
                </button>
                <button type="button" className="ag-pill-btn" onClick={onTestPush}>
                  {t('menu.pushTest')}
                </button>
              </div>
            </div>
            <div className={styles.settingRow}>
              <span>{t('left.foregroundAlerts')}</span>
              <div style={{ display: 'flex', gap: 5 }}>
                <button type="button" className="ag-pill-btn" onClick={onToggleSound}>
                  {t('left.soundShort', { state: soundAlert ? t('left.on') : t('left.off') })}
                </button>
                <button type="button" className="ag-pill-btn" onClick={onToggleVibrate}>
                  {t('left.vibrateShort', { state: vibrateAlert ? t('left.on') : t('left.off') })}
                </button>
              </div>
            </div>
            <div className={styles.permHint}>{t(PERM_DESC_KEYS[permissionLevel])}</div>
          </div>
        )}
      </div>
    </div>
  );
}
