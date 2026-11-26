import type { ComponentType } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { EntityIcon, EntityIconPicker } from '../components/EntityIcon';
import {
  type DragItemMeta,
  partitionAndOrderItems,
  type ReorderMenuAction,
  reorderWithinZone,
  sortPinnedQuickSessions,
  useDrawerDragSort
} from '../hooks/useDrawerDragSort';
import { useI18n } from '../i18n';
import type { WorktreeSheetProps } from '../lazy/WorktreeSheet';
import type {
  AppearanceMode,
  BootstrapResponse,
  CollapsedNodes,
  HostProject,
  OrgReorderRequest,
  PermissionLevel,
  PinKind,
  SessionGroup,
  SessionOrderMap,
  SessionPins,
  SessionSummary,
  WorktreeDto,
  ZoneOrder
} from '../types';
import styles from './LeftDrawer.module.css';

type StatusFilter = 'all' | 'running' | 'attention' | 'archived';
const SUBAGENT_VISIBLE_STORAGE_KEY = 'agy_remote_show_subagents';

const EMPTY_PIN_LIST: SessionPins = { sessions: [], projects: [], groups: [] };
const EMPTY_ZONE: ZoneOrder = { pinned: [], normal: [] };

export interface DeleteSessionOutcome {
  ok: boolean;
  canFallbackLocalHide?: boolean;
  reasonCode?: string;
  message?: string;
}

export interface LeftDrawerProps {
  sessions: SessionSummary[];
  archivedList?: SessionSummary[];
  archivedCount?: number;
  activeSessionId: string;
  workspaces: BootstrapResponse['workspaces'];
  groups: SessionGroup[];
  projects: HostProject[];
  collapsedNodes?: CollapsedNodes;
  orgRevision?: number;
  pins?: SessionPins;
  groupOrder?: ZoneOrder;
  projectOrder?: Record<string, ZoneOrder>;
  sessionOrder?: SessionOrderMap;
  channel: string;
  permissionLevel: PermissionLevel;
  token: string;
  appearance: AppearanceMode;
  soundAlert: boolean;
  vibrateAlert: boolean;
  enablePushNotifications?: boolean;
  pushSubscribed: boolean;
  pushBusy: boolean;
  onSelectSession: (cascadeId: string) => void;
  onCreateSession: (
    title?: string,
    workspaceUri?: string,
    opts?: { worktreePath?: string; projectId?: string | null; standalone?: boolean }
  ) => Promise<void>;
  onTogglePin?: (kind: PinKind, id: string, nextPinned?: boolean) => Promise<void>;
  onCreateGroup?: (name: string, icon?: string | null) => Promise<void>;
  onRenameGroup?: (groupId: string, name: string) => Promise<void>;
  onSetGroupIcon?: (groupId: string, icon: string | null) => Promise<void>;
  onDeleteGroup?: (groupId: string) => Promise<void>;
  onToggleGroupCollapsed?: (groupId: string, collapsed?: boolean) => Promise<void>;
  onToggleNodeCollapsed?: (
    nodeType: 'group' | 'project' | 'worktree',
    id: string,
    collapsed: boolean
  ) => Promise<void>;
  onAssignProjectGroup?: (
    groupId: string | null,
    target: { projectId?: string; sessionId?: string; workspaceUri?: string }
  ) => Promise<void>;
  onAssignSessionProject?: (cascadeId: string, projectId: string | null) => Promise<boolean | void>;
  onRenameProject?: (projectId: string, name: string) => Promise<void>;
  onSetProjectIcon?: (projectId: string, icon: string | null) => Promise<void>;
  onRemoveProject?: (projectId: string) => Promise<void>;
  onRefreshWorktrees?: (rootPath?: string) => Promise<void>;
  onMutateWorktree?: (payload: {
    root: string;
    action: 'add' | 'remove' | 'prune';
    path?: string;
    branch?: string;
    createBranch?: boolean;
  }) => Promise<boolean>;
  onOpenWorktreeInRightDrawer?: (
    worktreePath: string,
    tab: 'pty' | 'diff' | 'files' | 'git'
  ) => void;
  onShowToast?: (msg: string) => void;
  onReorderOrg?: (req: OrgReorderRequest) => Promise<void>;
  onArchiveSession?: (cascadeId: string, archived: boolean) => Promise<boolean | void>;
  onDeleteSession?: (
    cascadeId: string,
    mode?: 'auto' | 'local_hide'
  ) => Promise<DeleteSessionOutcome>;
  onLoadArchived?: () => Promise<void> | void;
  onDraggingOrgChange?: (dragging: boolean) => void;
  onOpenNewProject?: () => void;
  onCycleAppearance: () => void;
  onToggleSound: () => void;
  onToggleVibrate: () => void;
  onTogglePush: () => void;
  onTestPush: () => void;
  onOpenChannels?: () => void;
  onClose: () => void;
}

type ActionSheetTarget =
  | { kind: 'group'; group: SessionGroup; zone: 'pinned' | 'normal'; zoneIds: string[] }
  | {
      kind: 'project';
      project: HostProject;
      groupId: string | null;
      containerId: string;
      zone: 'pinned' | 'normal';
      zoneIds: string[];
    }
  | {
      kind: 'worktree';
      project: HostProject;
      worktree: WorktreeDto;
    }
  | {
      kind: 'session';
      session: SessionSummary;
      containerId: string;
      zone: 'pinned' | 'normal';
      zoneIds: string[];
    };

interface OptimisticCollapseEntry {
  collapsed: boolean;
  baseRevision: number;
  serverValueAtClick: boolean;
}

function getWorktreeDisplayLabel(
  wt: WorktreeDto,
  t: (
    key: 'left.wtBare' | 'left.wtDetached',
    params?: { sha: string }
  ) => string
): string {
  if (wt.bare) return t('left.wtBare');
  if (wt.detached) {
    const sha = wt.headShort || (wt.head ? wt.head.slice(0, 7) : 'HEAD');
    return t('left.wtDetached', { sha });
  }
  return wt.branch || wt.displayLabel || wt.displaySubpath || wt.path;
}

function isWorktreeMissing(wt: WorktreeDto): boolean {
  return Boolean(wt.status === 'missing' || wt.prunable === true || wt.exists === false);
}

interface DeleteModalState {
  session: SessionSummary;
  step: 'confirm' | 'fallback_local';
  busy: boolean;
  reasonCode?: string;
  errorMsg?: string;
}

function normalizeUriPath(uriOrPath: string | null | undefined): string {
  const s = String(uriOrPath || '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      return decodeURIComponent(s.replace(/^file:\/\//, '')).replace(/\/+$/, '');
    } catch {
      return s.replace(/^file:\/\//, '').replace(/\/+$/, '');
    }
  }
  return s.replace(/\/+$/, '');
}

function formatRelTime(
  iso: string | null | undefined,
  t: (
    key: 'left.justNow' | 'left.minsAgo' | 'left.hoursAgo' | 'left.daysAgo',
    params?: { n: number }
  ) => string
): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return '';
  const diffMin = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (diffMin < 1) return t('left.justNow');
  if (diffMin < 60) return t('left.minsAgo', { n: diffMin });
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return t('left.hoursAgo', { n: diffHr });
  return t('left.daysAgo', { n: Math.round(diffHr / 24) });
}

function parseTs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ts = Date.parse(iso);
  return Number.isFinite(ts) ? ts : 0;
}

function isSessionRunning(s: SessionSummary): boolean {
  const st = String(s.status || '').toUpperCase();
  return st.includes('RUNNING') || st.includes('GENERATING');
}

function getSessionZoneOrder(
  map: SessionOrderMap | undefined,
  containerId: string
): ZoneOrder | null {
  const entry = map?.[containerId];
  if (!entry || Array.isArray(entry)) return null;
  return entry;
}

function PinGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M14 3l7 7-2.5 2.5-1.5-.8-3.8 3.8.8 3.5-2 2-4.2-4.2L4 20.6 3.4 20l3.8-3.8L3 12l2-2 3.5.8 3.8-3.8-.8-1.5L14 3z"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GripGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="5.5" cy="4" r="1.2" fill="currentColor" />
      <circle cx="10.5" cy="4" r="1.2" fill="currentColor" />
      <circle cx="5.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="10.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="5.5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="10.5" cy="12" r="1.2" fill="currentColor" />
    </svg>
  );
}

export function LeftDrawer({
  sessions,
  archivedList = [],
  archivedCount = 0,
  activeSessionId,
  workspaces,
  groups,
  projects,
  collapsedNodes,
  orgRevision = 0,
  pins = EMPTY_PIN_LIST,
  groupOrder = EMPTY_ZONE,
  projectOrder = {},
  sessionOrder = {},
  channel,
  permissionLevel,
  appearance,
  soundAlert,
  vibrateAlert,
  enablePushNotifications = true,
  pushSubscribed,
  pushBusy,
  onSelectSession,
  onCreateSession,
  onTogglePin,
  onCreateGroup,
  onRenameGroup,
  onSetGroupIcon,
  onDeleteGroup,
  onToggleGroupCollapsed,
  onToggleNodeCollapsed,
  onAssignProjectGroup,
  onAssignSessionProject,
  onRenameProject,
  onSetProjectIcon,
  onRemoveProject,
  onRefreshWorktrees,
  onMutateWorktree,
  onOpenWorktreeInRightDrawer,
  onShowToast,
  onReorderOrg,
  onArchiveSession,
  onDeleteSession,
  onLoadArchived,
  onDraggingOrgChange,
  onOpenNewProject,
  onCycleAppearance,
  onToggleSound,
  onToggleVibrate,
  onTogglePush,
  onTestPush,
  onOpenChannels,
  onClose
}: LeftDrawerProps) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedGroupFilter, setSelectedGroupFilter] = useState<string>('__all__');
  const [optimisticCollapse, setOptimisticCollapse] = useState<
    Record<string, OptimisticCollapseEntry>
  >({});
  const [transientExpandedIds, setTransientExpandedIds] = useState<Set<string>>(() => new Set());
  const [showSubagents, setShowSubagents] = useState<boolean>(() => {
    try {
      return window.localStorage?.getItem(SUBAGENT_VISIBLE_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [showNewSession, setShowNewSession] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newWorkspaceUri, setNewWorkspaceUri] = useState('');
  const [newWorktreeTarget, setNewWorktreeTarget] = useState<{
    projectId: string;
    worktree: WorktreeDto;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupIcon, setNewGroupIcon] = useState<string | null>(null);
  const [showNewGroupIconPicker, setShowNewGroupIconPicker] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [footerOpen, setFooterOpen] = useState(false);

  const [actionSheet, setActionSheet] = useState<ActionSheetTarget | null>(null);
  const [renameMode, setRenameMode] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [iconPickerMode, setIconPickerMode] = useState(false);
  const [moveToGroupMode, setMoveToGroupMode] = useState(false);
  const [assignSessionProjectMode, setAssignSessionProjectMode] = useState(false);
  const [confirmRemoveProject, setConfirmRemoveProject] = useState(false);
  const [confirmRemoveWorktree, setConfirmRemoveWorktree] = useState(false);
  const [deleteModal, setDeleteModal] = useState<DeleteModalState | null>(null);
  const [deleteGroupModal, setDeleteGroupModal] = useState<{
    group: SessionGroup;
    projectCount: number;
  } | null>(null);
  const [worktreeSheetTarget, setWorktreeSheetTarget] = useState<{
    repoRoot: string;
    repoName: string;
  } | null>(null);
  const [LazyWorktreeSheet, setLazyWorktreeSheet] =
    useState<ComponentType<WorktreeSheetProps> | null>(null);

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pillHoldRef = useRef<{
    groupId: string;
    startX: number;
    startY: number;
    timer: number | null;
    fired: boolean;
  } | null>(null);
  const suppressPillClickRef = useRef<string | null>(null);
  const suppressRowClickRef = useRef(false);

  const workspaceOptions = useMemo(
    () =>
      (workspaces || [])
        .map((w) =>
          typeof w === 'string'
            ? { uri: w, name: w, path: w }
            : { uri: w?.uri || w?.path || '', name: w?.name || w?.path || w?.uri || '', path: w?.path }
        )
        .filter((w) => Boolean(w.uri)),
    [workspaces]
  );

  useEffect(() => {
    const firstValid = workspaceOptions[0]?.uri || '';
    if (!newWorkspaceUri && firstValid) setNewWorkspaceUri(firstValid);
  }, [workspaceOptions, newWorkspaceUri]);

  useEffect(() => {
    if (statusFilter === 'archived') {
      void onLoadArchived?.();
    }
  }, [statusFilter, onLoadArchived]);

  useEffect(() => {
    if (!worktreeSheetTarget || LazyWorktreeSheet) return;
    let canceled = false;
    void import('../lazy/WorktreeSheet')
      .then((mod) => {
        if (!canceled && mod?.default) {
          setLazyWorktreeSheet(() => mod.default as ComponentType<WorktreeSheetProps>);
        }
      })
      .catch((err) => {
        if (!canceled) {
          onShowToast?.((err as Error).message);
        }
      });
    return () => {
      canceled = true;
    };
  }, [worktreeSheetTarget, LazyWorktreeSheet, onShowToast]);

  const toggleShowSubagents = () => {
    setShowSubagents((prev) => {
      const next = !prev;
      try {
        window.localStorage?.setItem(SUBAGENT_VISIBLE_STORAGE_KEY, next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  const sessionGroupPinSet = useMemo(() => new Set(pins?.groups || []), [pins]);
  const sessionProjPinSet = useMemo(() => new Set(pins?.projects || []), [pins]);
  const sessionPinSet = useMemo(() => new Set(pins?.sessions || []), [pins]);

  const isGroupPinned = useCallback(
    (g: SessionGroup) => Boolean(g.pinned || sessionGroupPinSet.has(g.id)),
    [sessionGroupPinSet]
  );
  const isProjectPinned = useCallback(
    (p: HostProject) => Boolean(p.pinned || sessionProjPinSet.has(p.id)),
    [sessionProjPinSet]
  );
  const isSessionPinned = useCallback(
    (s: SessionSummary) => Boolean(s.pinned || sessionPinSet.has(s.cascadeId)),
    [sessionPinSet]
  );

  // Ordered groups (pinned tier + normal tier)
  const orderedGroups = useMemo(() => {
    return partitionAndOrderItems({
      items: groups,
      isPinned: isGroupPinned,
      getId: (g) => g.id,
      order: groupOrder,
      defaultPinnedCompare: (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name),
      defaultNormalCompare: (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name)
    });
  }, [groups, groupOrder, isGroupPinned]);

  const allOrderedGroups = useMemo(
    () => [...orderedGroups.pinned, ...orderedGroups.normal],
    [orderedGroups]
  );

  // Resolve project -> groupId from either p.groupId or group memberships
  const projectGroupLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) {
      for (const pid of g.projectIds || []) map.set(pid, g.id);
      for (const uri of g.workspaceUris || []) {
        const clean = normalizeUriPath(uri);
        if (clean) map.set(`uri:${clean}`, g.id);
      }
    }
    return map;
  }, [groups]);

  const getProjectGroupId = useCallback(
    (p: HostProject): string | null => {
      if (p.groupId && groups.some((g) => g.id === p.groupId)) return p.groupId;
      const byId = projectGroupLookup.get(p.id);
      if (byId) return byId;
      const clean = normalizeUriPath(p.uri || p.path);
      if (clean) {
        const byUri = projectGroupLookup.get(`uri:${clean}`);
        if (byUri) return byUri;
      }
      return null;
    },
    [groups, projectGroupLookup]
  );

  const orderedSessionZones = useCallback(
    (list: SessionSummary[], containerId: string) => {
      return partitionAndOrderItems({
        items: list,
        isPinned: isSessionPinned,
        getId: (s) => s.cascadeId,
        order: getSessionZoneOrder(sessionOrder, containerId),
        defaultPinnedCompare: (a, b) => parseTs(b.lastModifiedTime) - parseTs(a.lastModifiedTime),
        defaultNormalCompare: (a, b) => parseTs(b.lastModifiedTime) - parseTs(a.lastModifiedTime)
      });
    },
    [sessionOrder, isSessionPinned]
  );

  const normalizedSearch = search.trim().toLowerCase();

  // Filter active sessions
  const hiddenSubagentCount = useMemo(
    () => sessions.filter((s) => s.isSubagent).length,
    [sessions]
  );
  const subagentFilteredSessions = useMemo(
    () => (showSubagents ? sessions : sessions.filter((s) => !s.isSubagent)),
    [sessions, showSubagents]
  );

  const visibleSessions = useMemo(() => {
    if (statusFilter === 'archived') return [];
    return subagentFilteredSessions.filter((s) => {
      if (statusFilter === 'running' && !isSessionRunning(s)) return false;
      if (statusFilter === 'attention' && !s.needsAttention) return false;
      if (normalizedSearch) {
        const hay = `${s.title} ${s.projectName || ''} ${s.workspaceUri || ''} ${s.cascadeId}`.toLowerCase();
        if (!hay.includes(normalizedSearch)) return false;
      }
      return true;
    });
  }, [subagentFilteredSessions, statusFilter, normalizedSearch]);

  const visibleArchived = useMemo(() => {
    const base = showSubagents ? archivedList : archivedList.filter((s) => !s.isSubagent);
    return base.filter((s) => {
      if (normalizedSearch) {
        const hay = `${s.title} ${s.projectName || ''} ${s.workspaceUri || ''} ${s.cascadeId}`.toLowerCase();
        if (!hay.includes(normalizedSearch)) return false;
      }
      return true;
    });
  }, [archivedList, showSubagents, normalizedSearch]);

  const pendingSessions = useMemo(
    () => visibleSessions.filter((s) => s.needsAttention),
    [visibleSessions]
  );

  const pinnedQuickSessions = useMemo(() => {
    const pinnedOnly = visibleSessions.filter(isSessionPinned);
    const rawPinnedOrder = Array.isArray(sessionOrder?.__pinned__)
      ? sessionOrder.__pinned__
      : undefined;
    return sortPinnedQuickSessions(
      pinnedOnly,
      rawPinnedOrder,
      (a, b) => parseTs(b.lastModifiedTime) - parseTs(a.lastModifiedTime)
    );
  }, [visibleSessions, isSessionPinned, sessionOrder]);

  // Bucket sessions to projects vs standalone
  const projectByUriOrId = useMemo(() => {
    const byId = new Map<string, HostProject>();
    const byUri = new Map<string, HostProject>();
    for (const p of projects) {
      byId.set(p.id, p);
      const u = normalizeUriPath(p.uri || p.path);
      if (u) byUri.set(u, p);
    }
    return { byId, byUri };
  }, [projects]);

  const { sessionsByProject, sessionsByWorktree, standaloneZones } = useMemo(() => {
    const byProj = new Map<string, SessionSummary[]>();
    const byWt = new Map<string, SessionSummary[]>();
    const standalone: SessionSummary[] = [];
    for (const s of visibleSessions) {
      const matched =
        (s.projectId && projectByUriOrId.byId.get(s.projectId)) ||
        projectByUriOrId.byUri.get(normalizeUriPath(s.workspaceUri));
      if (matched) {
        const arr = byProj.get(matched.id) || [];
        arr.push(s);
        byProj.set(matched.id, arr);

        if (matched.isMultiWorktree && Array.isArray(matched.worktrees) && matched.worktrees.length > 0) {
          const sPath = normalizeUriPath(s.worktreePath || s.workspaceUri);
          const wtHit =
            (s.worktreeId
              ? matched.worktrees.find((w) => w.worktreeId === s.worktreeId)
              : undefined) ||
            (sPath
              ? matched.worktrees.find((w) => normalizeUriPath(w.path) === sPath)
              : undefined) ||
            matched.worktrees.find((w) => w.isMain && !w.bare) ||
            matched.worktrees.find((w) => !w.bare) ||
            matched.worktrees[0];
          if (wtHit) {
            const wtArr = byWt.get(wtHit.worktreeId) || [];
            wtArr.push(s);
            byWt.set(wtHit.worktreeId, wtArr);
          }
        }
      } else {
        standalone.push(s);
      }
    }
    return {
      sessionsByProject: byProj,
      sessionsByWorktree: byWt,
      standaloneZones: orderedSessionZones(standalone, '__standalone__')
    };
  }, [visibleSessions, projectByUriOrId, orderedSessionZones]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.cascadeId === activeSessionId) || null,
    [sessions, activeSessionId]
  );

  // Group -> { pinned: HostProject[], normal: HostProject[] }
  const projectsByContainer = useMemo(() => {
    const buckets = new Map<string, HostProject[]>();
    buckets.set('__ungrouped__', []);
    for (const g of groups) buckets.set(g.id, []);

    for (const p of projects) {
      const matchedSessions = sessionsByProject.get(p.id) || [];
      if ((normalizedSearch || statusFilter !== 'all') && matchedSessions.length === 0) {
        const wtHay = (p.worktrees || [])
          .map((w) => `${w.branch || ''} ${w.displayLabel || ''} ${w.path || ''}`)
          .join(' ');
        const projMatchesSearch =
          normalizedSearch &&
          `${p.name} ${p.path || ''} ${p.branchName || ''} ${wtHay}`
            .toLowerCase()
            .includes(normalizedSearch);
        if (!projMatchesSearch || statusFilter !== 'all') continue;
      }
      const gid = getProjectGroupId(p);
      const key = gid && buckets.has(gid) ? gid : '__ungrouped__';
      buckets.get(key)!.push(p);
    }

    const out = new Map<string, { pinned: HostProject[]; normal: HostProject[] }>();
    for (const [cid, list] of buckets.entries()) {
      out.set(
        cid,
        partitionAndOrderItems({
          items: list,
          isPinned: isProjectPinned,
          getId: (p) => p.id,
          order: projectOrder?.[cid],
          defaultPinnedCompare: (a, b) => a.name.localeCompare(b.name),
          defaultNormalCompare: (a, b) =>
            parseTs(b.lastModifiedTime) - parseTs(a.lastModifiedTime) ||
            a.name.localeCompare(b.name)
        })
      );
    }
    return out;
  }, [
    groups,
    projects,
    sessionsByProject,
    normalizedSearch,
    statusFilter,
    getProjectGroupId,
    isProjectPinned,
    projectOrder
  ]);

  const isFilterAutoExpand =
    Boolean(normalizedSearch) || (statusFilter !== 'all' && statusFilter !== 'archived');

  const getServerCollapsed = useCallback(
    (nodeType: 'group' | 'project' | 'worktree', id: string): boolean => {
      if (nodeType === 'group') {
        return Boolean(groups.find((g) => g.id === id)?.collapsed);
      }
      if (nodeType === 'project') {
        if (collapsedNodes?.projects && Object.prototype.hasOwnProperty.call(collapsedNodes.projects, id)) {
          return Boolean(collapsedNodes.projects[id]);
        }
        return Boolean(projects.find((p) => p.id === id)?.collapsed);
      }
      if (collapsedNodes?.worktrees && Object.prototype.hasOwnProperty.call(collapsedNodes.worktrees, id)) {
        return Boolean(collapsedNodes.worktrees[id]);
      }
      for (const p of projects) {
        const wt = p.worktrees?.find((w) => w.worktreeId === id);
        if (wt) return Boolean(wt.collapsed);
      }
      return false;
    },
    [groups, projects, collapsedNodes]
  );

  // Drop stale optimistic collapse entries whenever server revision advances or server value diverges
  useEffect(() => {
    setOptimisticCollapse((prev) => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      let changed = false;
      const next: Record<string, OptimisticCollapseEntry> = {};
      for (const key of keys) {
        const entry = prev[key];
        const sepIdx = key.indexOf(':');
        const nodeType = key.slice(0, sepIdx) as 'group' | 'project' | 'worktree';
        const id = key.slice(sepIdx + 1);
        const serverVal = getServerCollapsed(nodeType, id);
        if (orgRevision > entry.baseRevision || serverVal !== entry.serverValueAtClick) {
          changed = true;
        } else {
          next[key] = entry;
        }
      }
      return changed ? next : prev;
    });
  }, [orgRevision, getServerCollapsed]);

  const isNodeCollapsed = useCallback(
    (nodeType: 'group' | 'project' | 'worktree', id: string): boolean => {
      const key = `${nodeType}:${id}`;
      if (isFilterAutoExpand || transientExpandedIds.has(key)) {
        return false;
      }
      const serverVal = getServerCollapsed(nodeType, id);
      const opt = optimisticCollapse[key];
      if (opt && orgRevision <= opt.baseRevision && serverVal === opt.serverValueAtClick) {
        return opt.collapsed;
      }
      return serverVal;
    },
    [isFilterAutoExpand, transientExpandedIds, getServerCollapsed, optimisticCollapse, orgRevision]
  );

  const handleToggleNodeCollapse = useCallback(
    (nodeType: 'group' | 'project' | 'worktree', id: string) => {
      const key = `${nodeType}:${id}`;
      const serverVal = getServerCollapsed(nodeType, id);
      const curCollapsed = isNodeCollapsed(nodeType, id);
      const nextCollapsed = !curCollapsed;
      if (transientExpandedIds.has(key)) {
        setTransientExpandedIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
      setOptimisticCollapse((prev) => ({
        ...prev,
        [key]: {
          collapsed: nextCollapsed,
          baseRevision: orgRevision,
          serverValueAtClick: serverVal
        }
      }));
      if (permissionLevel !== 'L0') {
        if (onToggleNodeCollapsed) {
          void onToggleNodeCollapsed(nodeType, id, nextCollapsed);
        } else if (nodeType === 'group') {
          void onToggleGroupCollapsed?.(id, nextCollapsed);
        }
      }
    },
    [
      getServerCollapsed,
      isNodeCollapsed,
      transientExpandedIds,
      orgRevision,
      permissionLevel,
      onToggleNodeCollapsed,
      onToggleGroupCollapsed
    ]
  );

  // Drag-and-drop hook
  const getZoneIds = useCallback(
    (targetType: 'group' | 'project' | 'session', containerId: string, zone: 'pinned' | 'normal') => {
      if (targetType === 'group') {
        return (zone === 'pinned' ? orderedGroups.pinned : orderedGroups.normal).map((g) => g.id);
      }
      if (targetType === 'project') {
        const b = projectsByContainer.get(containerId);
        if (!b) return [];
        return (zone === 'pinned' ? b.pinned : b.normal).map((p) => p.id);
      }
      if (containerId === '__pinned__') {
        return pinnedQuickSessions.map((s) => s.cascadeId);
      }
      if (containerId === '__standalone__') {
        return (zone === 'pinned' ? standaloneZones.pinned : standaloneZones.normal).map(
          (s) => s.cascadeId
        );
      }
      if (sessionsByWorktree.has(containerId)) {
        const zoned = orderedSessionZones(sessionsByWorktree.get(containerId) || [], containerId);
        return (zone === 'pinned' ? zoned.pinned : zoned.normal).map((s) => s.cascadeId);
      }
      const zoned = orderedSessionZones(sessionsByProject.get(containerId) || [], containerId);
      return (zone === 'pinned' ? zoned.pinned : zoned.normal).map((s) => s.cascadeId);
    },
    [
      orderedGroups,
      projectsByContainer,
      pinnedQuickSessions,
      standaloneZones,
      sessionsByWorktree,
      sessionsByProject,
      orderedSessionZones
    ]
  );

  const resetSheetSubModes = useCallback(() => {
    setRenameMode(false);
    setIconPickerMode(false);
    setMoveToGroupMode(false);
    setAssignSessionProjectMode(false);
    setConfirmRemoveProject(false);
    setConfirmRemoveWorktree(false);
  }, []);

  const handleDragLongPressActionSheet = useCallback(
    (item: DragItemMeta) => {
      suppressRowClickRef.current = true;
      window.setTimeout(() => {
        suppressRowClickRef.current = false;
      }, 200);
      resetSheetSubModes();

      if (item.targetType === 'group') {
        const g = groups.find((x) => x.id === item.id);
        if (g) {
          setActionSheet({
            kind: 'group',
            group: g,
            zone: item.zone,
            zoneIds: getZoneIds('group', 'groups', item.zone)
          });
        }
      } else if (item.targetType === 'project') {
        const p = projects.find((x) => x.id === item.id);
        if (p) {
          setActionSheet({
            kind: 'project',
            project: p,
            groupId: item.fromGroupId ?? getProjectGroupId(p),
            containerId: item.containerId,
            zone: item.zone,
            zoneIds: getZoneIds('project', item.containerId, item.zone)
          });
        }
      } else {
        const s = sessions.find((x) => x.cascadeId === item.id);
        if (s) {
          setActionSheet({
            kind: 'session',
            session: s,
            containerId: item.containerId,
            zone: item.zone,
            zoneIds: getZoneIds('session', item.containerId, item.zone)
          });
        }
      }
    },
    [groups, projects, sessions, getZoneIds, getProjectGroupId, resetSheetSubModes]
  );

  const dragDisabled = permissionLevel === 'L0' || Boolean(normalizedSearch) || statusFilter === 'archived';

  const { armedItem, draggingItem, ghostPos, dropTarget, startHandleDrag, startRowPress } =
    useDrawerDragSort({
      disabled: dragDisabled,
      scrollContainerRef: bodyRef,
      getZoneIds,
      onCommitReorder: async (req) => {
        await onReorderOrg?.(req);
      },
      onTempExpandGroup: (gid) => {
        setTransientExpandedIds((prev) => {
          const key = `group:${gid}`;
          if (prev.has(key)) return prev;
          const next = new Set(prev);
          next.add(key);
          return next;
        });
      },
      onDraggingChange: onDraggingOrgChange,
      onLongPressActionSheet: handleDragLongPressActionSheet
    });

  useEffect(() => {
    if (!draggingItem && transientExpandedIds.size > 0) {
      setTransientExpandedIds(new Set());
    }
  }, [draggingItem, transientExpandedIds.size]);

  // Group pill long-press (450ms) works EVEN when unselected or when drag is disabled
  const startGroupPillHold = (group: SessionGroup, clientX: number, clientY: number) => {
    if (pillHoldRef.current?.timer) {
      window.clearTimeout(pillHoldRef.current.timer);
    }
    const zone: 'pinned' | 'normal' = isGroupPinned(group) ? 'pinned' : 'normal';
    const state = {
      groupId: group.id,
      startX: clientX,
      startY: clientY,
      fired: false,
      timer: window.setTimeout(() => {
        state.fired = true;
        suppressPillClickRef.current = group.id;
        try {
          navigator.vibrate?.(15);
        } catch {}
        resetSheetSubModes();
        setActionSheet({
          kind: 'group',
          group,
          zone,
          zoneIds: getZoneIds('group', 'groups', zone)
        });
      }, 450)
    };
    pillHoldRef.current = state;
  };

  const moveGroupPillHold = (clientX: number, clientY: number) => {
    const cur = pillHoldRef.current;
    if (!cur || !cur.timer) return;
    if (Math.hypot(clientX - cur.startX, clientY - cur.startY) >= 8) {
      window.clearTimeout(cur.timer);
      pillHoldRef.current = null;
    }
  };

  const endGroupPillHold = () => {
    const cur = pillHoldRef.current;
    if (cur?.timer) {
      window.clearTimeout(cur.timer);
    }
    pillHoldRef.current = null;
  };

  const openGroupActionSheet = (group: SessionGroup) => {
    const zone: 'pinned' | 'normal' = isGroupPinned(group) ? 'pinned' : 'normal';
    resetSheetSubModes();
    setActionSheet({
      kind: 'group',
      group,
      zone,
      zoneIds: getZoneIds('group', 'groups', zone)
    });
  };

  const openProjectActionSheet = (project: HostProject, containerId: string) => {
    const zone: 'pinned' | 'normal' = isProjectPinned(project) ? 'pinned' : 'normal';
    resetSheetSubModes();
    setActionSheet({
      kind: 'project',
      project,
      groupId: getProjectGroupId(project),
      containerId,
      zone,
      zoneIds: getZoneIds('project', containerId, zone)
    });
  };

  const openWorktreeActionSheet = (project: HostProject, worktree: WorktreeDto) => {
    resetSheetSubModes();
    setActionSheet({
      kind: 'worktree',
      project,
      worktree
    });
  };

  const openSessionActionSheet = (
    session: SessionSummary,
    containerId: string,
    zone: 'pinned' | 'normal'
  ) => {
    resetSheetSubModes();
    setActionSheet({
      kind: 'session',
      session,
      containerId,
      zone,
      zoneIds: getZoneIds('session', containerId, zone)
    });
  };

  const handleReorderMenu = async (
    targetType: 'group' | 'project' | 'session',
    containerId: string,
    zone: 'pinned' | 'normal',
    zoneIds: string[],
    itemId: string,
    action: ReorderMenuAction,
    groupId?: string | null,
    workspaceUri?: string | null
  ) => {
    const orderedIds = reorderWithinZone(zoneIds, itemId, action);
    if (!orderedIds) return;
    setActionSheet(null);
    await onReorderOrg?.({
      targetType,
      containerId,
      zone,
      orderedIds,
      ...(targetType === 'project'
        ? {
            movedProject: {
              projectId: itemId,
              workspaceUri: workspaceUri || undefined,
              fromGroupId: groupId ?? null,
              toGroupId: groupId ?? null
            }
          }
        : {})
    });
  };

  const openDeleteSessionModal = (session: SessionSummary) => {
    setActionSheet(null);
    setDeleteModal({ session, step: 'confirm', busy: false });
  };

  const confirmDeleteSession = async () => {
    if (!deleteModal || deleteModal.busy) return;
    const mode = deleteModal.step === 'fallback_local' ? 'local_hide' : 'auto';
    setDeleteModal((prev) => (prev ? { ...prev, busy: true, errorMsg: undefined } : null));
    const outcome = await onDeleteSession?.(deleteModal.session.cascadeId, mode);
    if (!outcome || outcome.ok) {
      setDeleteModal(null);
      return;
    }
    if (outcome.canFallbackLocalHide && mode === 'auto') {
      setDeleteModal((prev) =>
        prev
          ? {
              ...prev,
              step: 'fallback_local',
              busy: false,
              reasonCode: outcome.reasonCode,
              errorMsg: outcome.message
            }
          : null
      );
      return;
    }
    setDeleteModal(null);
  };

  // Visibility filter for groups/ungrouped/standalone
  const filteredPinnedGroups = orderedGroups.pinned.filter(
    (g) => selectedGroupFilter === '__all__' || selectedGroupFilter === g.id
  );
  const filteredNormalGroups = orderedGroups.normal.filter(
    (g) => selectedGroupFilter === '__all__' || selectedGroupFilter === g.id
  );
  const ungroupedBucket = projectsByContainer.get('__ungrouped__') || { pinned: [], normal: [] };
  const showUngroupedSection =
    selectedGroupFilter === '__all__' || selectedGroupFilter === '__ungrouped__';
  const showStandaloneSection =
    (selectedGroupFilter === '__all__' || selectedGroupFilter === '__ungrouped__') &&
    (standaloneZones.pinned.length > 0 || standaloneZones.normal.length > 0);

  // Count rendered active rows for empty-search archived jump hint
  const hasVisibleActiveResults = useMemo(() => {
    if (statusFilter === 'archived') return visibleArchived.length > 0;
    if (visibleSessions.length > 0) return true;
    const checkBucket = (b?: { pinned: HostProject[]; normal: HostProject[] }) =>
      Boolean(b && (b.pinned.length > 0 || b.normal.length > 0));
    for (const g of [...filteredPinnedGroups, ...filteredNormalGroups]) {
      if (checkBucket(projectsByContainer.get(g.id))) return true;
    }
    if (showUngroupedSection && checkBucket(ungroupedBucket)) return true;
    return false;
  }, [
    statusFilter,
    visibleArchived.length,
    visibleSessions.length,
    filteredPinnedGroups,
    filteredNormalGroups,
    projectsByContainer,
    showUngroupedSection,
    ungroupedBucket
  ]);

  // If active search returns 0 active results and archivedCount > 0, prefetch archived matches
  useEffect(() => {
    if (
      statusFilter !== 'archived' &&
      normalizedSearch &&
      !hasVisibleActiveResults &&
      archivedCount > 0 &&
      archivedList.length === 0
    ) {
      void onLoadArchived?.();
    }
  }, [
    statusFilter,
    normalizedSearch,
    hasVisibleActiveResults,
    archivedCount,
    archivedList.length,
    onLoadArchived
  ]);

  const handleCreateSession = async () => {
    setCreating(true);
    try {
      await onCreateSession(
        newTitle.trim() || undefined,
        newWorkspaceUri || undefined,
        newWorktreeTarget
          ? {
              worktreePath: newWorktreeTarget.worktree.path,
              projectId: newWorktreeTarget.projectId
            }
          : undefined
      );
      setNewTitle('');
      setNewWorktreeTarget(null);
      setShowNewSession(false);
    } finally {
      setCreating(false);
    }
  };

  const handleCreateGroup = async () => {
    const clean = newGroupName.trim();
    if (!clean) return;
    setCreatingGroup(true);
    try {
      if (newGroupIcon) {
        await onCreateGroup?.(clean, newGroupIcon);
      } else {
        await onCreateGroup?.(clean);
      }
      setNewGroupName('');
      setNewGroupIcon(null);
      setShowNewGroupIconPicker(false);
      setShowNewGroup(false);
    } finally {
      setCreatingGroup(false);
    }
  };

  const renderSessionRow = (
    s: SessionSummary,
    containerId: string,
    zone: 'pinned' | 'normal',
    isQuick = false
  ) => {
    const active = s.cascadeId === activeSessionId;
    const pinned = isSessionPinned(s);
    const isArmed = armedItem?.targetType === 'session' && armedItem.id === s.cascadeId && armedItem.containerId === containerId;
    const isDraggingSource = draggingItem?.targetType === 'session' && draggingItem.id === s.cascadeId && draggingItem.containerId === containerId;
    const dragMeta: DragItemMeta = {
      targetType: 'session',
      id: s.cascadeId,
      label: s.title,
      zone,
      containerId
    };

    return (
      <div
        key={`${containerId}:${s.cascadeId}`}
        data-dnd-item="1"
        data-dnd-type="session"
        data-dnd-id={s.cascadeId}
        data-dnd-container={containerId}
        data-dnd-zone={zone}
        className={`${styles.sessionRowWrap} ${isQuick ? styles.quickRowWrap : ''} ${
          active ? styles.sessionRowWrapActive : ''
        } ${isArmed ? styles.rowArmed : ''} ${
          isDraggingSource ? styles.rowDraggingGhostSource : ''
        }`}
        onTouchStart={(e) => {
          const t0 = e.touches[0];
          if (t0) startRowPress(t0.clientX, t0.clientY, dragMeta, true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          openSessionActionSheet(s, containerId, zone);
        }}
      >
        <button
          type="button"
          className={styles.sessionRow}
          onClick={() => {
            if (suppressRowClickRef.current || draggingItem) return;
            onSelectSession(s.cascadeId);
            onClose();
          }}
        >
          <span
            className={`${styles.dot} ${
              s.needsAttention
                ? styles.dotAttention
                : isSessionRunning(s)
                  ? styles.dotRunning
                  : ''
            }`}
          />
          <span className={styles.sessionContent}>
            <span className={styles.sessionTitle}>
              {s.title}
              {pinned ? (
                <span className={styles.pinIconActive} style={{ marginLeft: 5 }}>
                  <PinGlyph filled />
                </span>
              ) : null}
            </span>
            <span className={styles.sessionMeta}>
              {s.projectName && <span>{s.projectName}</span>}
              {s.lastModifiedTime && <span>{formatRelTime(s.lastModifiedTime, t)}</span>}
              <span>{t('left.stepsCount', { count: s.stepCount })}</span>
            </span>
          </span>
        </button>

        {!dragDisabled && (
          <button
            type="button"
            className={styles.dragHandleBtn}
            data-drag-handle="1"
            aria-label={t('left.dragHandleAria')}
            onTouchStart={(e) => {
              e.stopPropagation();
              const t0 = e.touches[0];
              if (t0) startHandleDrag(t0.clientX, t0.clientY, dragMeta);
            }}
            onPointerDown={(e) => {
              if (e.pointerType === 'touch') return;
              e.stopPropagation();
              startHandleDrag(e.clientX, e.clientY, dragMeta);
            }}
          >
            <GripGlyph />
          </button>
        )}

        <button
          type="button"
          className={styles.actionBtn}
          aria-label={t('left.moreActions')}
          data-testid={`session-more-${s.cascadeId}`}
          onClick={(e) => {
            e.stopPropagation();
            openSessionActionSheet(s, containerId, zone);
          }}
        >
          ···
        </button>
      </div>
    );
  };

  const renderWorktreeCard = (p: HostProject, wt: WorktreeDto) => {
    const wtCollapsed = isNodeCollapsed('worktree', wt.worktreeId);
    const wtSessions = sessionsByWorktree.get(wt.worktreeId) || [];
    const wtZones = orderedSessionZones(wtSessions, wt.worktreeId);
    const wtCount = wtSessions.length;
    const missing = isWorktreeMissing(wt);
    const bare = Boolean(wt.bare);
    const locked = Boolean(wt.locked);
    const wtLabel = getWorktreeDisplayLabel(wt, t);
    const hasRunning = (wt.runningCount ?? 0) > 0 || wtSessions.some(isSessionRunning);
    const hasAttention =
      (wt.needsAttentionCount ?? 0) > 0 || wtSessions.some((s) => Boolean(s.needsAttention));
    const isActiveWt = Boolean(
      activeSession &&
        (activeSession.worktreeId === wt.worktreeId ||
          (wt.path &&
            normalizeUriPath(activeSession.worktreePath || activeSession.workspaceUri) ===
              normalizeUriPath(wt.path)))
    );

    return (
      <div
        key={wt.worktreeId}
        className={styles.wtCard}
        data-testid={`worktree-card-${wt.worktreeId}`}
      >
        <div
          className={`${styles.wtHeader} ${isActiveWt ? styles.wtHeaderActive : ''}`}
          onContextMenu={(e) => {
            e.preventDefault();
            openWorktreeActionSheet(p, wt);
          }}
        >
          <button
            type="button"
            className={styles.wtToggle}
            data-testid={`wt-toggle-${wt.worktreeId}`}
            onClick={() => handleToggleNodeCollapse('worktree', wt.worktreeId)}
          >
            <span className={styles.chevron}>{wtCollapsed ? '▸' : '▾'}</span>
            <span className={styles.wtToggleBody}>
              <span className={styles.wtRow1}>
                {(hasAttention || hasRunning) && (
                  <span
                    className={`${styles.dot} ${
                      hasAttention ? styles.dotAttention : styles.dotRunning
                    }`}
                    style={{ marginTop: 0 }}
                  />
                )}
                <span className={styles.wtBranchText}>{wtLabel}</span>
                {wt.isMain && !bare && (
                  <span className={`${styles.wtBadge} ${styles.wtBadgeMain}`}>
                    {t('left.wtMainTag')}
                  </span>
                )}
                {locked && (
                  <span className={`${styles.wtBadge} ${styles.wtBadgeLocked}`}>
                    {t('left.wtLocked')}
                  </span>
                )}
                {missing && (
                  <span className={`${styles.wtBadge} ${styles.wtBadgeWarn}`}>
                    {t('left.wtMissing')}
                  </span>
                )}
                <span className={styles.wtCount}>{wtCount}</span>
              </span>
              <span className={styles.wtRow2} title={wt.path}>
                {wt.displaySubpath || wt.path}
              </span>
            </span>
          </button>

          <button
            type="button"
            className={styles.actionBtn}
            aria-label={t('left.wtNewSession')}
            data-testid={`wt-new-session-${wt.worktreeId}`}
            disabled={permissionLevel === 'L0' || bare || missing}
            onClick={() => {
              setNewWorkspaceUri(wt.uri || wt.path || '');
              setNewWorktreeTarget({ projectId: p.id, worktree: wt });
              setShowNewSession(true);
            }}
          >
            +
          </button>

          <button
            type="button"
            className={styles.actionBtn}
            aria-label={t('left.moreActions')}
            data-testid={`wt-more-${wt.worktreeId}`}
            onClick={() => openWorktreeActionSheet(p, wt)}
          >
            ···
          </button>
        </div>

        {!wtCollapsed && (
          <div className={styles.wtSessionList}>
            {missing && (
              <div className={styles.wtInlineBanner} data-testid={`wt-missing-hint-${wt.worktreeId}`}>
                {t('left.wtMissingHint')}
              </div>
            )}
            {wtCount === 0 ? (
              !bare && (
                <div className={styles.empty} style={{ padding: '8px' }}>
                  {t('left.projectEmpty')}
                </div>
              )
            ) : (
              <>
                {wtZones.pinned.map((s) => renderSessionRow(s, wt.worktreeId, 'pinned'))}
                {wtZones.pinned.length > 0 && wtZones.normal.length > 0 && (
                  <div className={styles.subDivider} aria-hidden="true" />
                )}
                {wtZones.normal.map((s) => renderSessionRow(s, wt.worktreeId, 'normal'))}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderProjectCard = (p: HostProject, groupId: string | null, containerId: string) => {
    const pinned = isProjectPinned(p);
    const zone: 'pinned' | 'normal' = pinned ? 'pinned' : 'normal';
    const collapsed = isNodeCollapsed('project', p.id);
    const isMultiWt = Boolean(p.isMultiWorktree && Array.isArray(p.worktrees) && p.worktrees.length > 0);
    const projSessions = sessionsByProject.get(p.id) || [];
    const sessionZones = orderedSessionZones(projSessions, p.id);
    const listCount = isMultiWt ? projSessions.length : sessionZones.pinned.length + sessionZones.normal.length;
    const defaultWt = isMultiWt
      ? p.worktrees!.find((w) => w.isMain && !w.bare && !isWorktreeMissing(w)) ||
        p.worktrees!.find((w) => !w.bare && !isWorktreeMissing(w)) ||
        null
      : null;
    const visibleWorktrees = isMultiWt
      ? p.worktrees!.filter((wt) => {
          if (!normalizedSearch && statusFilter === 'all') return true;
          const wtSess = sessionsByWorktree.get(wt.worktreeId) || [];
          if (wtSess.length > 0) return true;
          if (statusFilter === 'all' && normalizedSearch) {
            return `${wt.branch || ''} ${wt.displayLabel || ''} ${wt.path || ''}`
              .toLowerCase()
              .includes(normalizedSearch);
          }
          return false;
        })
      : [];
    const isArmed = armedItem?.targetType === 'project' && armedItem.id === p.id;
    const isDraggingSource = draggingItem?.targetType === 'project' && draggingItem.id === p.id;
    const dragMeta: DragItemMeta = {
      targetType: 'project',
      id: p.id,
      label: p.name,
      zone,
      containerId,
      fromGroupId: groupId,
      workspaceUri: p.uri || undefined
    };

    return (
      <div
        key={p.id}
        data-dnd-item="1"
        data-dnd-type="project"
        data-dnd-id={p.id}
        data-dnd-container={containerId}
        data-dnd-zone={zone}
        className={`${styles.projectCard} ${isArmed ? styles.rowArmed : ''} ${
          isDraggingSource ? styles.rowDraggingGhostSource : ''
        }`}
      >
        <div
          className={styles.projectHeader}
          onTouchStart={(e) => {
            const t0 = e.touches[0];
            if (t0) startRowPress(t0.clientX, t0.clientY, dragMeta, true);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            openProjectActionSheet(p, containerId);
          }}
        >
          <button
            type="button"
            className={styles.projectToggle}
            data-testid={`project-toggle-${p.id}`}
            onClick={() => {
              if (suppressRowClickRef.current || draggingItem) return;
              handleToggleNodeCollapse('project', p.id);
            }}
          >
            <span className={styles.chevron}>{collapsed ? '▸' : '▾'}</span>
            <span className={styles.projectMeta}>
              <span className={styles.projectName}>
                {pinned && (
                  <span className={styles.pinIconActive}>
                    <PinGlyph filled />
                  </span>
                )}
                {p.icon && (
                  <span className={styles.entityIconBadge} data-testid={`project-icon-${p.id}`}>
                    <EntityIcon icon={p.icon} size={14} />
                  </span>
                )}
                {p.name}
                {isMultiWt && (
                  <span className={styles.projWtBadge} data-testid={`project-wt-badge-${p.id}`}>
                    {t('left.wtBadgeCount', { count: p.worktrees!.length })}
                  </span>
                )}
              </span>
              <span className={styles.projectSub}>
                {!isMultiWt && p.branchName ? `${p.branchName} · ` : ''}
                {listCount}
              </span>
            </span>
          </button>

          <button
            type="button"
            className={styles.actionBtn}
            aria-label={t('left.newInProject', { name: p.name })}
            disabled={permissionLevel === 'L0' || (isMultiWt && !defaultWt)}
            onClick={() => {
              if (isMultiWt && defaultWt) {
                setNewWorkspaceUri(defaultWt.uri || defaultWt.path || '');
                setNewWorktreeTarget({ projectId: p.id, worktree: defaultWt });
              } else {
                setNewWorkspaceUri(p.uri || p.path || '');
                setNewWorktreeTarget(null);
              }
              setShowNewSession(true);
            }}
          >
            +
          </button>

          {!dragDisabled && (
            <button
              type="button"
              className={styles.dragHandleBtn}
              data-drag-handle="1"
              aria-label={t('left.dragHandleAria')}
              onTouchStart={(e) => {
                e.stopPropagation();
                const t0 = e.touches[0];
                if (t0) startHandleDrag(t0.clientX, t0.clientY, dragMeta);
              }}
              onPointerDown={(e) => {
                if (e.pointerType === 'touch') return;
                e.stopPropagation();
                startHandleDrag(e.clientX, e.clientY, dragMeta);
              }}
            >
              <GripGlyph />
            </button>
          )}

          <button
            type="button"
            className={styles.actionBtn}
            aria-label={t('left.moreActions')}
            data-testid={`project-more-${p.id}`}
            onClick={() => openProjectActionSheet(p, containerId)}
          >
            ···
          </button>
        </div>

        {!collapsed &&
          (isMultiWt ? (
            <div className={styles.wtList} data-testid={`project-wt-list-${p.id}`}>
              {(visibleWorktrees.length > 0 ? visibleWorktrees : p.worktrees!).map((wt) =>
                renderWorktreeCard(p, wt)
              )}
            </div>
          ) : (
            <div className={styles.sessionList}>
              {listCount === 0 ? (
                <div className={styles.empty} style={{ padding: '10px 8px' }}>
                  {t('left.projectEmpty')}
                </div>
              ) : (
                <>
                  {sessionZones.pinned.map((s) => renderSessionRow(s, p.id, 'pinned'))}
                  {sessionZones.pinned.length > 0 && sessionZones.normal.length > 0 && (
                    <div className={styles.subDivider} aria-hidden="true" />
                  )}
                  {sessionZones.normal.map((s) => renderSessionRow(s, p.id, 'normal'))}
                </>
              )}
            </div>
          ))}
      </div>
    );
  };

  const renderGroupSection = (g: SessionGroup) => {
    const pinned = isGroupPinned(g);
    const zone: 'pinned' | 'normal' = pinned ? 'pinned' : 'normal';
    const collapsed = isNodeCollapsed('group', g.id);
    const bucket = projectsByContainer.get(g.id) || { pinned: [], normal: [] };
    const totalCount = bucket.pinned.length + bucket.normal.length;
    const isDropHighlighted =
      (dropTarget?.kind === 'group-header' && dropTarget.groupId === g.id) ||
      (dropTarget?.kind === 'drop-zone' && dropTarget.containerId === g.id);
    const isArmed = armedItem?.targetType === 'group' && armedItem.id === g.id;
    const isDraggingSource = draggingItem?.targetType === 'group' && draggingItem.id === g.id;
    const dragMeta: DragItemMeta = {
      targetType: 'group',
      id: g.id,
      label: g.name,
      zone,
      containerId: 'groups'
    };

    return (
      <section key={g.id} className={styles.groupSection} data-group-id={g.id}>
        <div
          data-dnd-item="1"
          data-dnd-type="group"
          data-dnd-id={g.id}
          data-dnd-container="groups"
          data-dnd-zone={zone}
          data-dnd-collapsed-group={collapsed ? g.id : undefined}
          data-dnd-group-name={collapsed ? g.name : undefined}
          className={`${styles.groupHeaderRow} ${
            isDropHighlighted ? styles.groupHeaderRowHighlight : ''
          } ${isArmed ? styles.rowArmed : ''} ${
            isDraggingSource ? styles.rowDraggingGhostSource : ''
          }`}
          onTouchStart={(e) => {
            const t0 = e.touches[0];
            if (t0) startRowPress(t0.clientX, t0.clientY, dragMeta, true);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            openGroupActionSheet(g);
          }}
        >
          <button
            type="button"
            className={styles.groupToggleBtn}
            data-testid={`group-toggle-${g.id}`}
            onClick={() => {
              if (suppressRowClickRef.current || draggingItem) return;
              handleToggleNodeCollapse('group', g.id);
            }}
          >
            <span className={styles.chevron}>{collapsed ? '▸' : '▾'}</span>
            {pinned && (
              <span className={styles.pinIconActive}>
                <PinGlyph filled />
              </span>
            )}
            {g.icon && (
              <span className={styles.entityIconBadge} data-testid={`group-icon-${g.id}`}>
                <EntityIcon icon={g.icon} size={14} />
              </span>
            )}
            <span className={styles.groupNameText}>{g.name}</span>
            <span className={styles.groupCountBadge}>{totalCount}</span>
          </button>

          {!dragDisabled && (
            <button
              type="button"
              className={styles.dragHandleBtn}
              data-drag-handle="1"
              aria-label={t('left.dragHandleAria')}
              onTouchStart={(e) => {
                e.stopPropagation();
                const t0 = e.touches[0];
                if (t0) startHandleDrag(t0.clientX, t0.clientY, dragMeta);
              }}
              onPointerDown={(e) => {
                if (e.pointerType === 'touch') return;
                e.stopPropagation();
                startHandleDrag(e.clientX, e.clientY, dragMeta);
              }}
            >
              <GripGlyph />
            </button>
          )}

          <button
            type="button"
            className={styles.actionBtn}
            aria-label={t('left.moreActions')}
            data-testid={`group-more-${g.id}`}
            onClick={() => openGroupActionSheet(g)}
          >
            ···
          </button>
        </div>

        {!collapsed && (
          <div className={styles.groupBody} data-dnd-project-container={g.id}>
            {bucket.pinned.map((p) => renderProjectCard(p, g.id, g.id))}
            {bucket.pinned.length > 0 && bucket.normal.length > 0 && (
              <div className={styles.subDivider} aria-hidden="true" />
            )}
            {bucket.normal.map((p) => renderProjectCard(p, g.id, g.id))}
            {totalCount === 0 && (
              <div
                data-dnd-drop-container={g.id}
                className={`${styles.emptyDropSlot} ${
                  dropTarget?.kind === 'drop-zone' && dropTarget.containerId === g.id
                    ? styles.emptyDropSlotActive
                    : ''
                }`}
              >
                {t('left.emptyGroupDropHint')}
              </div>
            )}
          </div>
        )}
      </section>
    );
  };

  return (
    <div className={styles.drawer}>
      <header className={styles.header}>
        <span className={styles.brand}>{t('left.title')}</span>
        <div className={styles.headerActions}>
          {onOpenNewProject && (
            <button
              type="button"
              className={styles.iconBtn}
              data-testid="left-new-project-btn"
              onClick={onOpenNewProject}
              disabled={permissionLevel === 'L0'}
              title={permissionLevel !== 'L2' ? t('newProject.l2RequiredHint') : undefined}
            >
              {t('left.newProjectBtn')}
            </button>
          )}
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => {
              setNewWorktreeTarget(null);
              setShowNewSession((v) => !v);
            }}
            disabled={permissionLevel === 'L0'}
          >
            {t('left.newSessionBtn')}
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            onClick={onClose}
            aria-label={t('left.closeDrawer')}
          >
            ✕
          </button>
        </div>
      </header>

      <div className={styles.filters}>
        <div className={styles.searchRow}>
          <input
            type="search"
            className={styles.searchInput}
            placeholder={t('left.searchPlaceholder')}
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
          {search && (
            <button
              type="button"
              className={styles.clearBtn}
              onClick={() => setSearch('')}
              aria-label={t('left.clearSearch')}
            >
              ✕
            </button>
          )}
        </div>

        <div className={styles.segmented} role="tablist" aria-label={t('left.filterAria')}>
          {(
            [
              ['all', t('left.filterAll')],
              ['running', t('left.filterRunning')],
              ['attention', t('left.filterAttention')],
              [
                'archived',
                archivedCount > 0
                  ? t('left.filterArchivedCount', { count: archivedCount })
                  : t('left.filterArchived')
              ]
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={statusFilter === id}
              className={`${styles.segBtn} ${statusFilter === id ? styles.segBtnActive : ''}`}
              onClick={() => setStatusFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div
          className={styles.groupBar}
          data-hscroll="1"
          role="group"
          aria-label={t('left.groupFilterAria')}
        >
          <button
            type="button"
            className={`${styles.groupPill} ${
              selectedGroupFilter === '__all__' ? styles.groupPillActive : ''
            }`}
            onClick={() => setSelectedGroupFilter('__all__')}
          >
            {t('left.allGroups')}
          </button>

          {orderedGroups.pinned.map((g) => (
            <button
              key={g.id}
              type="button"
              data-testid={`group-pill-${g.id}`}
              className={`${styles.groupPill} ${
                selectedGroupFilter === g.id ? styles.groupPillActive : ''
              }`}
              onTouchStart={(e) => {
                const t0 = e.touches[0];
                if (t0) startGroupPillHold(g, t0.clientX, t0.clientY);
              }}
              onTouchMove={(e) => {
                const t0 = e.touches[0];
                if (t0) moveGroupPillHold(t0.clientX, t0.clientY);
              }}
              onTouchEnd={endGroupPillHold}
              onTouchCancel={endGroupPillHold}
              onPointerDown={(e) => {
                if (e.pointerType !== 'touch') startGroupPillHold(g, e.clientX, e.clientY);
              }}
              onPointerMove={(e) => {
                if (e.pointerType !== 'touch') moveGroupPillHold(e.clientX, e.clientY);
              }}
              onPointerUp={endGroupPillHold}
              onPointerCancel={endGroupPillHold}
              onContextMenu={(e) => {
                e.preventDefault();
                openGroupActionSheet(g);
              }}
              onClick={() => {
                if (suppressPillClickRef.current === g.id) {
                  suppressPillClickRef.current = null;
                  return;
                }
                setSelectedGroupFilter(g.id);
              }}
            >
              <PinGlyph filled />
              {g.icon && <EntityIcon icon={g.icon} size={13} />}
              <span>{g.name}</span>
            </button>
          ))}

          {orderedGroups.pinned.length > 0 && orderedGroups.normal.length > 0 && (
            <span className={styles.groupPillDivider} aria-hidden="true" />
          )}

          {orderedGroups.normal.map((g) => (
            <button
              key={g.id}
              type="button"
              data-testid={`group-pill-${g.id}`}
              className={`${styles.groupPill} ${
                selectedGroupFilter === g.id ? styles.groupPillActive : ''
              }`}
              onTouchStart={(e) => {
                const t0 = e.touches[0];
                if (t0) startGroupPillHold(g, t0.clientX, t0.clientY);
              }}
              onTouchMove={(e) => {
                const t0 = e.touches[0];
                if (t0) moveGroupPillHold(t0.clientX, t0.clientY);
              }}
              onTouchEnd={endGroupPillHold}
              onTouchCancel={endGroupPillHold}
              onPointerDown={(e) => {
                if (e.pointerType !== 'touch') startGroupPillHold(g, e.clientX, e.clientY);
              }}
              onPointerMove={(e) => {
                if (e.pointerType !== 'touch') moveGroupPillHold(e.clientX, e.clientY);
              }}
              onPointerUp={endGroupPillHold}
              onPointerCancel={endGroupPillHold}
              onContextMenu={(e) => {
                e.preventDefault();
                openGroupActionSheet(g);
              }}
              onClick={() => {
                if (suppressPillClickRef.current === g.id) {
                  suppressPillClickRef.current = null;
                  return;
                }
                setSelectedGroupFilter(g.id);
              }}
            >
              {g.icon && <EntityIcon icon={g.icon} size={13} />}
              <span>{g.name}</span>
            </button>
          ))}

          <button
            type="button"
            className={`${styles.groupPill} ${
              selectedGroupFilter === '__ungrouped__' ? styles.groupPillActive : ''
            }`}
            onClick={() => setSelectedGroupFilter('__ungrouped__')}
          >
            {t('left.unassigned')}
          </button>

          {permissionLevel !== 'L0' && (
            <button
              type="button"
              className={styles.groupPill}
              onClick={() => setShowNewGroup((v) => !v)}
              aria-label={t('left.addGroup')}
            >
              +
            </button>
          )}
        </div>
      </div>

      {dropTarget?.kind === 'slot' && dropTarget.crossZoneBlocked && draggingItem && (
        <div className={styles.zoneClampBanner} role="status">
          {draggingItem.zone === 'pinned' ? t('left.zoneClampHint') : t('left.zoneClampNormalHint')}
        </div>
      )}

      {showNewSession && (
        <div className={styles.newCard}>
          <strong style={{ fontSize: 12.5 }}>{t('left.newSessionTitle')}</strong>
          {newWorktreeTarget ? (
            <div className={styles.wtLockedChip} data-testid="new-session-wt-chip" title={newWorktreeTarget.worktree.path}>
              {t('left.wtNewSessionLockedHint', {
                label: getWorktreeDisplayLabel(newWorktreeTarget.worktree, t)
              })}
            </div>
          ) : null}
          <input
            type="text"
            className="ag-input"
            placeholder={t('left.sessionTitlePlaceholder')}
            value={newTitle}
            onInput={(e) => setNewTitle((e.target as HTMLInputElement).value)}
          />
          {!newWorktreeTarget && (
            <select
              className="ag-select"
              value={newWorkspaceUri}
              onChange={(e) => setNewWorkspaceUri((e.target as HTMLSelectElement).value)}
            >
              <option value="">{t('left.defaultWorkspace')}</option>
              {workspaceOptions.map((w) => (
                <option key={w.uri} value={w.uri}>
                  {w.name || w.path || w.uri}
                </option>
              ))}
            </select>
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="ag-pill-btn"
              onClick={() => {
                setShowNewSession(false);
                setNewWorktreeTarget(null);
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="ag-pill-btn ag-pill-btn-primary"
              disabled={creating}
              data-testid="confirm-create-session-btn"
              onClick={handleCreateSession}
            >
              {creating ? t('left.creating') : t('left.createSession')}
            </button>
          </div>
        </div>
      )}

      {showNewGroup && (
        <div className={styles.newCard}>
          <strong style={{ fontSize: 12.5 }}>{t('left.newGroupTitle')}</strong>
          <div className={styles.newGroupRow}>
            <button
              type="button"
              className={styles.iconBtn}
              aria-label={t('left.groupIconAria')}
              aria-expanded={showNewGroupIconPicker}
              data-testid="new-group-icon-btn"
              onClick={() => setShowNewGroupIconPicker((v) => !v)}
            >
              <EntityIcon icon={newGroupIcon || 'preset:layers'} size={15} />
            </button>
            <input
              type="text"
              className="ag-input"
              placeholder={t('left.groupNamePlaceholder')}
              value={newGroupName}
              onInput={(e) => setNewGroupName((e.target as HTMLInputElement).value)}
            />
          </div>
          {showNewGroupIconPicker && (
            <EntityIconPicker
              value={newGroupIcon}
              disabled={creatingGroup}
              testIdPrefix="new-group-icon"
              onSelect={(icon) => {
                setNewGroupIcon(icon);
                setShowNewGroupIconPicker(false);
              }}
              onCancel={() => setShowNewGroupIconPicker(false)}
            />
          )}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="ag-pill-btn"
              onClick={() => {
                setShowNewGroup(false);
                setShowNewGroupIconPicker(false);
              }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="ag-pill-btn ag-pill-btn-primary"
              disabled={creatingGroup || !newGroupName.trim()}
              onClick={handleCreateGroup}
            >
              {creatingGroup ? t('left.saving') : t('left.createGroup')}
            </button>
          </div>
        </div>
      )}

      <div
        ref={bodyRef}
        className={`${styles.body} ${draggingItem ? styles.bodyDragging : ''}`}
        data-drag-active={draggingItem ? '1' : undefined}
      >
        {statusFilter === 'archived' ? (
          <>
            <div className={styles.sectionHeader}>
              <span>{t('left.filterArchived')}</span>
              <span>{visibleArchived.length}</span>
            </div>
            {visibleArchived.length === 0 ? (
              <div className={styles.empty}>
                {normalizedSearch ? t('left.noMatches') : t('left.archivedEmpty')}
              </div>
            ) : (
              visibleArchived.map((s) => (
                <div key={s.cascadeId} className={styles.archivedRow} data-testid={`archived-row-${s.cascadeId}`}>
                  <div className={styles.sessionContent}>
                    <span className={styles.sessionTitle}>{s.title}</span>
                    <span className={styles.sessionMeta}>
                      {s.projectName && <span>{s.projectName}</span>}
                      {s.archivedAt && (
                        <span>
                          {t('left.archivedAt', { time: formatRelTime(s.archivedAt, t) })}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className={styles.archivedRowActions}>
                    <button
                      type="button"
                      className={styles.restoreBtn}
                      disabled={permissionLevel === 'L0'}
                      onClick={() => void onArchiveSession?.(s.cascadeId, false)}
                    >
                      {t('left.restoreSession')}
                    </button>
                    {onDeleteSession && (
                      <button
                        type="button"
                        className={styles.dangerBtn}
                        disabled={permissionLevel !== 'L2'}
                        title={permissionLevel === 'L1' ? t('store.l1DeleteDisabled') : undefined}
                        onClick={() => openDeleteSessionModal(s)}
                      >
                        {t('left.deleteSession')}
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </>
        ) : (
          <>
            {pendingSessions.length > 0 && (
              <div className={styles.pendingBox}>
                <div className={styles.pendingTitle}>
                  <span>{t('left.pendingTitle', { count: pendingSessions.length })}</span>
                  <span>{t('left.pendingApprove')}</span>
                </div>
                {pendingSessions.map((s) => renderSessionRow(s, 'pending', 'normal', true))}
              </div>
            )}

            {pinnedQuickSessions.length > 0 && (
              <>
                <div className={styles.sectionHeader}>
                  <span>{t('left.pinnedTitle', { count: pinnedQuickSessions.length })}</span>
                </div>
                <div className={styles.quickPinnedList}>
                  {pinnedQuickSessions.map((s) =>
                    renderSessionRow(s, '__pinned__', 'pinned', true)
                  )}
                </div>
              </>
            )}

            <div className={styles.sectionHeader}>
              <span>{t('left.projectsSessions', { count: visibleSessions.length })}</span>
              <button
                type="button"
                className={styles.subagentToggleBtn}
                onClick={toggleShowSubagents}
              >
                {showSubagents
                  ? t('left.hideSubagents')
                  : t('left.showSubagents', { count: hiddenSubagentCount })}
              </button>
            </div>

            {filteredPinnedGroups.map((g) => renderGroupSection(g))}

            {filteredPinnedGroups.length > 0 && filteredNormalGroups.length > 0 && (
              <div className={styles.tierDivider} data-testid="group-tier-divider" aria-hidden="true" />
            )}

            {filteredNormalGroups.map((g) => renderGroupSection(g))}

            {showUngroupedSection && (
              <div className={styles.groupSection} data-dnd-project-container="__ungrouped__">
                {(filteredPinnedGroups.length > 0 || filteredNormalGroups.length > 0) &&
                  (ungroupedBucket.pinned.length > 0 ||
                    ungroupedBucket.normal.length > 0 ||
                    draggingItem?.targetType === 'project') && (
                    <div className={styles.sectionHeader}>
                      <span>{t('left.ungroupedProjects')}</span>
                    </div>
                  )}
                {ungroupedBucket.pinned.map((p) => renderProjectCard(p, null, '__ungrouped__'))}
                {ungroupedBucket.pinned.length > 0 && ungroupedBucket.normal.length > 0 && (
                  <div className={styles.subDivider} aria-hidden="true" />
                )}
                {ungroupedBucket.normal.map((p) => renderProjectCard(p, null, '__ungrouped__'))}
                {draggingItem?.targetType === 'project' && draggingItem.fromGroupId && (
                  <div
                    data-dnd-drop-container="__ungrouped__"
                    className={`${styles.ungroupedDropSlot} ${
                      dropTarget?.kind === 'drop-zone' && dropTarget.containerId === '__ungrouped__'
                        ? styles.ungroupedDropSlotActive
                        : ''
                    }`}
                  >
                    {t('left.ungroupedDropHint')}
                  </div>
                )}
              </div>
            )}

            {showStandaloneSection && (
              <div className={styles.groupSection}>
                <div className={styles.sectionHeader}>
                  <span>{t('left.standaloneSessions')}</span>
                </div>
                {standaloneZones.pinned.map((s) =>
                  renderSessionRow(s, '__standalone__', 'pinned', true)
                )}
                {standaloneZones.pinned.length > 0 && standaloneZones.normal.length > 0 && (
                  <div className={styles.subDivider} aria-hidden="true" />
                )}
                {standaloneZones.normal.map((s) =>
                  renderSessionRow(s, '__standalone__', 'normal', true)
                )}
              </div>
            )}

            {!hasVisibleActiveResults && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className={styles.empty}>{t('left.noMatches')}</div>
                {normalizedSearch && (visibleArchived.length > 0 || archivedCount > 0) && (
                  <button
                    type="button"
                    className={styles.archivedHintBanner}
                    data-testid="archived-search-jump"
                    onClick={() => {
                      setStatusFilter('archived');
                      void onLoadArchived?.();
                    }}
                  >
                    {t('left.archivedSearchHint', {
                      count: visibleArchived.length > 0 ? visibleArchived.length : archivedCount
                    })}
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {dropTarget?.kind === 'slot' && (
        <div
          className={styles.dragInsertionLine}
          style={{
            top: `${dropTarget.lineTop}px`,
            left: `${dropTarget.lineLeft}px`,
            width: `${dropTarget.lineWidth}px`
          }}
        />
      )}

      {draggingItem && ghostPos && (
        <div
          className={styles.dragGhostPill}
          style={{ left: `${ghostPos.x}px`, top: `${ghostPos.y}px` }}
        >
          {dropTarget?.kind === 'group-header'
            ? t('left.dropInGroupHint', { name: dropTarget.groupName })
            : draggingItem.label}
        </div>
      )}

      {actionSheet && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          onClick={() => setActionSheet(null)}
        >
          <div
            className={styles.actionSheetCard}
            data-testid="left-action-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.actionSheetTitle}>
              {actionSheet.kind === 'group'
                ? actionSheet.group.name
                : actionSheet.kind === 'project'
                  ? actionSheet.project.name
                  : actionSheet.kind === 'worktree'
                    ? `${actionSheet.project.name} · ${getWorktreeDisplayLabel(actionSheet.worktree, t)}`
                    : actionSheet.session.title}
            </div>
            {actionSheet.kind === 'worktree' && (
              <div className={styles.wtSubInfo} title={actionSheet.worktree.path}>
                {actionSheet.worktree.path}
              </div>
            )}

            {iconPickerMode &&
            (actionSheet.kind === 'group' || actionSheet.kind === 'project') ? (
              <EntityIconPicker
                value={
                  actionSheet.kind === 'group'
                    ? actionSheet.group.icon
                    : actionSheet.project.icon
                }
                disabled={permissionLevel === 'L0'}
                testIdPrefix={
                  actionSheet.kind === 'group'
                    ? `sheet-group-icon-${actionSheet.group.id}`
                    : `sheet-project-icon-${actionSheet.project.id}`
                }
                onSelect={async (nextIcon) => {
                  if (actionSheet.kind === 'group') {
                    await onSetGroupIcon?.(actionSheet.group.id, nextIcon);
                  } else {
                    await onSetProjectIcon?.(actionSheet.project.id, nextIcon);
                  }
                  setIconPickerMode(false);
                  setActionSheet(null);
                }}
                onCancel={() => setIconPickerMode(false)}
              />
            ) : renameMode && (actionSheet.kind === 'group' || actionSheet.kind === 'project') ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input
                  type="text"
                  className="ag-input"
                  value={renameDraft}
                  onInput={(e) => setRenameDraft((e.target as HTMLInputElement).value)}
                />
                <div className={styles.modalActions}>
                  <button
                    type="button"
                    className="ag-pill-btn"
                    onClick={() => setRenameMode(false)}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    className="ag-pill-btn ag-pill-btn-primary"
                    disabled={!renameDraft.trim()}
                    onClick={async () => {
                      const nextName = renameDraft.trim();
                      if (!nextName) return;
                      if (actionSheet.kind === 'group') {
                        await onRenameGroup?.(actionSheet.group.id, nextName);
                      } else {
                        await onRenameProject?.(actionSheet.project.id, nextName);
                      }
                      setRenameMode(false);
                      setActionSheet(null);
                    }}
                  >
                    {t('common.confirm')}
                  </button>
                </div>
              </div>
            ) : moveToGroupMode && actionSheet.kind === 'project' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {allOrderedGroups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className={styles.actionSheetBtn}
                    onClick={async () => {
                      await onAssignProjectGroup?.(g.id, {
                        projectId: actionSheet.project.id,
                        workspaceUri: actionSheet.project.uri || undefined
                      });
                      setMoveToGroupMode(false);
                      setActionSheet(null);
                    }}
                  >
                    <span>{g.name}</span>
                    {actionSheet.groupId === g.id && <span>✓</span>}
                  </button>
                ))}
                <button
                  type="button"
                  className={styles.actionSheetBtn}
                  onClick={async () => {
                    await onAssignProjectGroup?.(null, {
                      projectId: actionSheet.project.id,
                      workspaceUri: actionSheet.project.uri || undefined
                    });
                    setMoveToGroupMode(false);
                    setActionSheet(null);
                  }}
                >
                  <span>{t('left.unassigned')}</span>
                  {!actionSheet.groupId && <span>✓</span>}
                </button>
                <button
                  type="button"
                  className="ag-pill-btn"
                  onClick={() => setMoveToGroupMode(false)}
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : assignSessionProjectMode && actionSheet.kind === 'session' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {actionSheet.session.worktreeId && (
                  <div style={{ fontSize: 11.5, color: 'var(--ag-muted)', padding: '0 4px' }}>
                    {t('left.assignSessionWorktreeHint')}
                  </div>
                )}
                {projects.map((proj) => (
                  <button
                    key={proj.id}
                    type="button"
                    className={styles.actionSheetBtn}
                    data-testid={`assign-session-proj-${proj.id}`}
                    onClick={async () => {
                      await onAssignSessionProject?.(actionSheet.session.cascadeId, proj.id);
                      setAssignSessionProjectMode(false);
                      setActionSheet(null);
                    }}
                  >
                    <span>{proj.name}</span>
                    {actionSheet.session.projectId === proj.id && <span>✓</span>}
                  </button>
                ))}
                <button
                  type="button"
                  className={styles.actionSheetBtn}
                  data-testid="assign-session-proj-standalone"
                  onClick={async () => {
                    await onAssignSessionProject?.(actionSheet.session.cascadeId, null);
                    setAssignSessionProjectMode(false);
                    setActionSheet(null);
                  }}
                >
                  <span>{t('left.assignSessionStandalone')}</span>
                  {!actionSheet.session.projectId && <span>✓</span>}
                </button>
                <button
                  type="button"
                  className="ag-pill-btn"
                  style={{ minHeight: 44 }}
                  onClick={() => setAssignSessionProjectMode(false)}
                >
                  {t('common.cancel')}
                </button>
              </div>
            ) : confirmRemoveWorktree && actionSheet.kind === 'worktree' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12.5, color: 'var(--ag-secondary)', wordBreak: 'break-all' }}>
                  {t('left.wtRemoveConfirm', {
                    label: getWorktreeDisplayLabel(actionSheet.worktree, t),
                    path: actionSheet.worktree.path
                  })}
                </div>
                <div className={styles.modalActions}>
                  <button
                    type="button"
                    className="ag-pill-btn"
                    style={{ minHeight: 44 }}
                    onClick={() => setConfirmRemoveWorktree(false)}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    className={styles.dangerBtn}
                    data-testid="confirm-remove-worktree-btn"
                    onClick={async () => {
                      const repoRoot =
                        actionSheet.project.repoRootPath ||
                        actionSheet.project.path ||
                        actionSheet.worktree.path;
                      await onMutateWorktree?.({
                        root: repoRoot,
                        action: 'remove',
                        path: actionSheet.worktree.path
                      });
                      setConfirmRemoveWorktree(false);
                      setActionSheet(null);
                    }}
                  >
                    {t('left.wtRemove')}
                  </button>
                </div>
              </div>
            ) : confirmRemoveProject && actionSheet.kind === 'project' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12.5, color: 'var(--ag-secondary)' }}>
                  {t('left.removeProjectConfirm', { name: actionSheet.project.name })}
                </div>
                <div className={styles.modalActions}>
                  <button
                    type="button"
                    className="ag-pill-btn"
                    onClick={() => setConfirmRemoveProject(false)}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    className={styles.dangerBtn}
                    onClick={async () => {
                      await onRemoveProject?.(actionSheet.project.id);
                      setConfirmRemoveProject(false);
                      setActionSheet(null);
                    }}
                  >
                    {t('left.removeProject')}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {actionSheet.kind === 'group' && (
                  <>
                    <button
                      type="button"
                      className={styles.actionSheetBtn}
                      disabled={permissionLevel === 'L0'}
                      onClick={async () => {
                        await onTogglePin?.(
                          'group',
                          actionSheet.group.id,
                          !isGroupPinned(actionSheet.group)
                        );
                        setActionSheet(null);
                      }}
                    >
                      <span>
                        {isGroupPinned(actionSheet.group)
                          ? t('left.unpinGroup')
                          : t('left.pinGroup')}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.actionSheetBtn}
                      disabled={permissionLevel === 'L0'}
                      onClick={() => {
                        setRenameDraft(actionSheet.group.name);
                        setRenameMode(true);
                      }}
                    >
                      <span>{t('left.renameGroup')}</span>
                    </button>
                    {onSetGroupIcon && (
                      <button
                        type="button"
                        className={styles.actionSheetBtn}
                        disabled={permissionLevel === 'L0'}
                        data-testid="action-set-group-icon"
                        onClick={() => setIconPickerMode(true)}
                      >
                        <span>{t('left.setIcon')}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${styles.actionSheetBtn} ${styles.actionSheetBtnDanger}`}
                      disabled={permissionLevel === 'L0'}
                      data-testid="action-delete-group"
                      onClick={async () => {
                        const targetGroup = actionSheet.group;
                        const count = projects.filter(
                          (p) => getProjectGroupId(p) === targetGroup.id
                        ).length;
                        setActionSheet(null);
                        if (count === 0) {
                          await onDeleteGroup?.(targetGroup.id);
                        } else {
                          setDeleteGroupModal({ group: targetGroup, projectCount: count });
                        }
                      }}
                    >
                      <span>{t('left.deleteGroup')}</span>
                    </button>
                  </>
                )}

                {actionSheet.kind === 'project' && (
                  <>
                    <button
                      type="button"
                      className={styles.actionSheetBtn}
                      disabled={permissionLevel === 'L0'}
                      onClick={async () => {
                        await onTogglePin?.(
                          'project',
                          actionSheet.project.id,
                          !isProjectPinned(actionSheet.project)
                        );
                        setActionSheet(null);
                      }}
                    >
                      <span>
                        {isProjectPinned(actionSheet.project)
                          ? t('left.unpinProject')
                          : t('left.pinProject')}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={styles.actionSheetBtn}
                      disabled={permissionLevel === 'L0'}
                      onClick={() => {
                        setRenameDraft(actionSheet.project.name);
                        setRenameMode(true);
                      }}
                    >
                      <span>{t('left.renameProject')}</span>
                    </button>
                    {onSetProjectIcon && (
                      <button
                        type="button"
                        className={styles.actionSheetBtn}
                        disabled={permissionLevel === 'L0'}
                        data-testid="action-set-project-icon"
                        onClick={() => setIconPickerMode(true)}
                      >
                        <span>{t('left.setIcon')}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.actionSheetBtn}
                      disabled={permissionLevel === 'L0'}
                      onClick={() => setMoveToGroupMode(true)}
                    >
                      <span>{t('left.moveToGroup')}</span>
                      <span>›</span>
                    </button>
                    {onRefreshWorktrees &&
                      (actionSheet.project.repoRootPath || actionSheet.project.path) && (
                        <button
                          type="button"
                          className={styles.actionSheetBtn}
                          data-testid="action-refresh-worktrees"
                          onClick={async () => {
                            const root =
                              actionSheet.project.repoRootPath || actionSheet.project.path || '';
                            setActionSheet(null);
                            await onRefreshWorktrees(root);
                          }}
                        >
                          <span>{t('left.wtRefresh')}</span>
                        </button>
                      )}
                    {onMutateWorktree &&
                      (actionSheet.project.repoRootPath || actionSheet.project.path) && (
                        <button
                          type="button"
                          className={styles.actionSheetBtn}
                          disabled={permissionLevel !== 'L2'}
                          title={permissionLevel !== 'L2' ? t('wtSheet.l2Hint') : undefined}
                          data-testid="action-new-worktree"
                          onClick={() => {
                            const repoRoot =
                              actionSheet.project.repoRootPath || actionSheet.project.path || '';
                            const repoName = actionSheet.project.name;
                            setActionSheet(null);
                            setWorktreeSheetTarget({ repoRoot, repoName });
                          }}
                        >
                          <span>{t('left.wtNew')}</span>
                        </button>
                      )}
                    {onMutateWorktree &&
                      actionSheet.project.worktrees?.some((w) => isWorktreeMissing(w)) && (
                        <button
                          type="button"
                          className={styles.actionSheetBtn}
                          disabled={permissionLevel !== 'L2'}
                          data-testid="action-prune-worktrees"
                          onClick={async () => {
                            const root =
                              actionSheet.project.repoRootPath || actionSheet.project.path || '';
                            setActionSheet(null);
                            await onMutateWorktree({ root, action: 'prune' });
                          }}
                        >
                          <span>{t('left.wtPrune')}</span>
                        </button>
                      )}
                    {onRemoveProject && (
                      <button
                        type="button"
                        className={`${styles.actionSheetBtn} ${styles.actionSheetBtnDanger}`}
                        disabled={permissionLevel !== 'L2'}
                        title={permissionLevel === 'L1' ? t('store.l1DeleteDisabled') : undefined}
                        onClick={() => setConfirmRemoveProject(true)}
                      >
                        <span>{t('left.removeProject')}</span>
                      </button>
                    )}
                  </>
                )}

                {actionSheet.kind === 'worktree' &&
                  (() => {
                    const wt = actionSheet.worktree;
                    const proj = actionSheet.project;
                    const missing = isWorktreeMissing(wt);
                    const bare = Boolean(wt.bare);
                    const locked = Boolean(wt.locked);
                    const wtSess = sessionsByWorktree.get(wt.worktreeId) || [];
                    const hasRunning =
                      (wt.runningCount ?? 0) > 0 || wtSess.some(isSessionRunning);
                    const removeDisabledReason = locked
                      ? t('left.wtLockedHint')
                      : hasRunning
                        ? t('left.wtRunningHint')
                        : undefined;
                    const repoRoot = proj.repoRootPath || proj.path || wt.path;
                    const hasAnyMissing =
                      missing || Boolean(proj.worktrees?.some((w) => isWorktreeMissing(w)));
                    return (
                      <>
                        <button
                          type="button"
                          className={styles.actionSheetBtn}
                          disabled={permissionLevel === 'L0' || bare || missing}
                          data-testid="wt-action-new-session"
                          onClick={() => {
                            setNewWorkspaceUri(wt.uri || wt.path || '');
                            setNewWorktreeTarget({ projectId: proj.id, worktree: wt });
                            setShowNewSession(true);
                            setActionSheet(null);
                          }}
                        >
                          <span>{t('left.wtNewSession')}</span>
                        </button>
                        {onOpenWorktreeInRightDrawer && (
                          <>
                            <button
                              type="button"
                              className={styles.actionSheetBtn}
                              disabled={permissionLevel !== 'L2' || bare || missing}
                              data-testid="wt-action-open-terminal"
                              onClick={() => {
                                setActionSheet(null);
                                onOpenWorktreeInRightDrawer(wt.path, 'pty');
                                onClose();
                              }}
                            >
                              <span>{t('left.wtOpenTerminal')}</span>
                            </button>
                            <button
                              type="button"
                              className={styles.actionSheetBtn}
                              disabled={bare || missing}
                              data-testid="wt-action-open-diff"
                              onClick={() => {
                                setActionSheet(null);
                                onOpenWorktreeInRightDrawer(wt.path, 'diff');
                                onClose();
                              }}
                            >
                              <span>{t('left.wtOpenFilesDiff')}</span>
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className={styles.actionSheetBtn}
                          data-testid="wt-action-copy-path"
                          onClick={async () => {
                            try {
                              await navigator.clipboard?.writeText(wt.path);
                              onShowToast?.(t('left.wtPathCopied'));
                            } catch {}
                            setActionSheet(null);
                          }}
                        >
                          <span>{t('left.wtCopyPath')}</span>
                        </button>
                        {onMutateWorktree && !wt.isMain && !bare && !missing && (
                          <button
                            type="button"
                            className={`${styles.actionSheetBtn} ${styles.actionSheetBtnDanger}`}
                            disabled={permissionLevel !== 'L2' || locked || hasRunning}
                            title={removeDisabledReason}
                            data-testid="wt-action-remove"
                            onClick={() => setConfirmRemoveWorktree(true)}
                          >
                            <span>{t('left.wtRemove')}</span>
                          </button>
                        )}
                        {onMutateWorktree && hasAnyMissing && (
                          <button
                            type="button"
                            className={styles.actionSheetBtn}
                            disabled={permissionLevel !== 'L2'}
                            data-testid="wt-action-prune"
                            onClick={async () => {
                              setActionSheet(null);
                              await onMutateWorktree({ root: repoRoot, action: 'prune' });
                            }}
                          >
                            <span>{t('left.wtPrune')}</span>
                          </button>
                        )}
                      </>
                    );
                  })()}

                {actionSheet.kind === 'session' && (
                  <>
                    <button
                      type="button"
                      className={styles.actionSheetBtn}
                      disabled={permissionLevel === 'L0'}
                      onClick={async () => {
                        await onTogglePin?.(
                          'session',
                          actionSheet.session.cascadeId,
                          !isSessionPinned(actionSheet.session)
                        );
                        setActionSheet(null);
                      }}
                    >
                      <span>
                        {isSessionPinned(actionSheet.session)
                          ? t('left.unpinSession')
                          : t('left.pinSession')}
                      </span>
                    </button>
                    {onAssignSessionProject && (
                      <button
                        type="button"
                        className={styles.actionSheetBtn}
                        disabled={permissionLevel === 'L0'}
                        data-testid="action-assign-session-project"
                        onClick={() => setAssignSessionProjectMode(true)}
                      >
                        <span>{t('left.assignSessionProject')}</span>
                        <span>›</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.actionSheetBtn}
                      disabled={permissionLevel === 'L0'}
                      onClick={async () => {
                        await onArchiveSession?.(
                          actionSheet.session.cascadeId,
                          !actionSheet.session.archived
                        );
                        setActionSheet(null);
                      }}
                    >
                      <span>
                        {actionSheet.session.archived
                          ? t('left.restoreSession')
                          : t('left.archiveSession')}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={`${styles.actionSheetBtn} ${styles.actionSheetBtnDanger}`}
                      disabled={permissionLevel !== 'L2'}
                      title={permissionLevel === 'L1' ? t('store.l1DeleteDisabled') : undefined}
                      onClick={() => openDeleteSessionModal(actionSheet.session)}
                    >
                      <span>{t('left.deleteSession')}</span>
                    </button>
                  </>
                )}

                {actionSheet.kind !== 'worktree' &&
                  actionSheet.zoneIds.length > 1 &&
                  permissionLevel !== 'L0' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div className={styles.sectionHeader} style={{ paddingTop: 4 }}>
                      <span>{t('left.reorderSection')}</span>
                    </div>
                    <div className={styles.reorderGrid}>
                      {(
                        [
                          ['up', t('left.moveUp')],
                          ['down', t('left.moveDown')],
                          ['first', t('left.moveFirst')],
                          ['last', t('left.moveLast')]
                        ] as const
                      ).map(([act, lbl]) => {
                        const itemId =
                          actionSheet.kind === 'group'
                            ? actionSheet.group.id
                            : actionSheet.kind === 'project'
                              ? actionSheet.project.id
                              : actionSheet.session.cascadeId;
                        const idx = actionSheet.zoneIds.indexOf(itemId);
                        const atStart = idx <= 0 && (act === 'up' || act === 'first');
                        const atEnd =
                          idx >= actionSheet.zoneIds.length - 1 &&
                          (act === 'down' || act === 'last');
                        return (
                          <button
                            key={act}
                            type="button"
                            className={styles.actionSheetBtn}
                            disabled={idx < 0 || atStart || atEnd}
                            onClick={() =>
                              void handleReorderMenu(
                                actionSheet.kind,
                                actionSheet.kind === 'group' ? 'groups' : actionSheet.containerId,
                                actionSheet.zone,
                                actionSheet.zoneIds,
                                itemId,
                                act,
                                actionSheet.kind === 'project' ? actionSheet.groupId : undefined,
                                actionSheet.kind === 'project' ? actionSheet.project.uri : undefined
                              )
                            }
                          >
                            {lbl}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  className={styles.actionSheetBtn}
                  style={{ justifyContent: 'center' }}
                  onClick={() => setActionSheet(null)}
                >
                  {t('common.cancel')}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {deleteGroupModal && (
        <div
          className={`${styles.modalBackdrop} ${styles.centerBackdrop}`}
          role="dialog"
          aria-modal="true"
          onClick={() => setDeleteGroupModal(null)}
        >
          <div
            className={styles.modalDialog}
            data-testid="delete-group-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <strong style={{ fontSize: 15 }}>{t('left.deleteGroupModalTitle')}</strong>
            <div style={{ fontSize: 12.5, color: 'var(--ag-secondary)', lineHeight: 1.45 }}>
              {t('left.deleteGroupModalDesc', {
                name: deleteGroupModal.group.name,
                count: deleteGroupModal.projectCount
              })}
            </div>
            <div className={styles.modalActions}>
              <button
                type="button"
                className="ag-pill-btn"
                style={{ minHeight: 44 }}
                onClick={() => setDeleteGroupModal(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={styles.dangerBtn}
                data-testid="confirm-delete-group-btn"
                onClick={async () => {
                  const gid = deleteGroupModal.group.id;
                  setDeleteGroupModal(null);
                  await onDeleteGroup?.(gid);
                }}
              >
                {t('left.deleteGroupModalConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {worktreeSheetTarget && LazyWorktreeSheet && onMutateWorktree && (
        <LazyWorktreeSheet
          open={true}
          repoRoot={worktreeSheetTarget.repoRoot}
          repoName={worktreeSheetTarget.repoName}
          permissionLevel={permissionLevel}
          onSubmit={(payload) => onMutateWorktree(payload)}
          onClose={() => setWorktreeSheetTarget(null)}
        />
      )}

      {deleteModal && (
        <div
          className={`${styles.modalBackdrop} ${styles.centerBackdrop}`}
          role="dialog"
          aria-modal="true"
          onClick={() => {
            if (!deleteModal.busy) setDeleteModal(null);
          }}
        >
          <div
            className={styles.modalDialog}
            data-testid="delete-session-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <strong style={{ fontSize: 15 }}>
              {deleteModal.step === 'fallback_local'
                ? t('left.deleteModalFallbackTitle')
                : t('left.deleteModalTitle')}
            </strong>
            <div style={{ fontSize: 12.5, color: 'var(--ag-secondary)', lineHeight: 1.45 }}>
              {deleteModal.step === 'fallback_local'
                ? t('left.deleteModalFallbackDesc', {
                    reason:
                      deleteModal.errorMsg || deleteModal.reasonCode || 'HOST_DELETE_UNAVAILABLE',
                    title: deleteModal.session.title
                  })
                : t('left.deleteModalDesc', { title: deleteModal.session.title })}
            </div>
            {deleteModal.step === 'confirm' && deleteModal.session.projectName && (
              <div style={{ fontSize: 12, color: 'var(--ag-muted)' }}>
                {t('left.deleteModalProject', { name: deleteModal.session.projectName })}
              </div>
            )}
            <div className={styles.modalActions}>
              <button
                type="button"
                className="ag-pill-btn"
                disabled={deleteModal.busy}
                onClick={() => setDeleteModal(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={styles.dangerBtn}
                disabled={deleteModal.busy}
                data-testid="confirm-delete-session-btn"
                onClick={() => void confirmDeleteSession()}
              >
                {deleteModal.step === 'fallback_local'
                  ? t('left.deleteModalHideLocal')
                  : t('left.deleteModalConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className={styles.footer}>
        <button
          type="button"
          className={styles.footerToggle}
          onClick={() => setFooterOpen((v) => !v)}
        >
          <span>{t('left.footerTitle')}</span>
          <span>
            {permissionLevel} · {footerOpen ? '▾' : '▴'}
          </span>
        </button>

        {footerOpen && (
          <div className={styles.footerBody}>
            <div className={styles.footerRow}>
              <span style={{ fontSize: 12 }}>
                {t('left.currentChannel', { channel })}
              </span>
              <button type="button" className="ag-pill-btn" onClick={() => onOpenChannels?.()}>
                {t('left.switchChannel')}
              </button>
            </div>
            <div className={styles.footerRow}>
              <span style={{ fontSize: 12 }}>{t('left.appearanceTheme')}</span>
              <button type="button" className="ag-pill-btn" onClick={onCycleAppearance}>
                {appearance === 'light'
                  ? t('menu.appearanceLight')
                  : appearance === 'dark'
                    ? t('menu.appearanceDark')
                    : t('menu.appearanceAuto')}
              </button>
            </div>
            <div className={styles.footerRow}>
              <span style={{ fontSize: 12 }}>{t('left.foregroundAlerts')}</span>
              <div className={styles.footerActions}>
                <button
                  type="button"
                  className={`ag-pill-btn ${soundAlert ? 'ag-pill-btn-primary' : ''}`}
                  onClick={onToggleSound}
                >
                  {t('left.soundShort', { state: soundAlert ? t('left.on') : t('left.off') })}
                </button>
                <button
                  type="button"
                  className={`ag-pill-btn ${vibrateAlert ? 'ag-pill-btn-primary' : ''}`}
                  onClick={onToggleVibrate}
                >
                  {t('left.vibrateShort', { state: vibrateAlert ? t('left.on') : t('left.off') })}
                </button>
              </div>
            </div>
            <div className={styles.footerRow}>
              <button
                type="button"
                className={`ag-pill-btn ${pushSubscribed && enablePushNotifications ? 'ag-pill-btn-primary' : ''}`}
                disabled={pushBusy || (!enablePushNotifications && !pushSubscribed)}
                onClick={onTogglePush}
                data-testid="left-push-toggle-btn"
              >
                {!enablePushNotifications && !pushSubscribed
                  ? t('menu.pushHostDisabledNote')
                  : pushSubscribed
                    ? t('menu.pushEnabled')
                    : t('menu.pushEnable')}
              </button>
              {pushSubscribed && enablePushNotifications && (
                <button type="button" className="ag-pill-btn" onClick={onTestPush}>
                  {t('menu.pushTest')}
                </button>
              )}
            </div>
            <div className={styles.permNote}>
              {permissionLevel === 'L0'
                ? t('left.permDescL0')
                : permissionLevel === 'L1'
                  ? t('left.permDescL1')
                  : t('left.permDescL2')}
            </div>
          </div>
        )}
      </footer>
    </div>
  );
}
