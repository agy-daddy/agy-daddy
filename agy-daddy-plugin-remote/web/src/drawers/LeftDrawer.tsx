import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  type DragItemMeta,
  partitionAndOrderItems,
  type ReorderMenuAction,
  reorderWithinZone,
  sortPinnedQuickSessions,
  useDrawerDragSort
} from '../hooks/useDrawerDragSort';
import { useI18n } from '../i18n';
import type {
  AppearanceMode,
  BootstrapResponse,
  HostProject,
  OrgReorderRequest,
  PermissionLevel,
  PinKind,
  SessionGroup,
  SessionOrderMap,
  SessionPins,
  SessionSummary,
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
  onCreateSession: (title?: string, workspaceUri?: string) => Promise<void>;
  onTogglePin?: (kind: PinKind, id: string, nextPinned?: boolean) => Promise<void>;
  onCreateGroup?: (name: string) => Promise<void>;
  onRenameGroup?: (groupId: string, name: string) => Promise<void>;
  onDeleteGroup?: (groupId: string) => Promise<void>;
  onToggleGroupCollapsed?: (groupId: string, collapsed?: boolean) => Promise<void>;
  onAssignProjectGroup?: (
    groupId: string | null,
    target: { projectId?: string; sessionId?: string; workspaceUri?: string }
  ) => Promise<void>;
  onRenameProject?: (projectId: string, name: string) => Promise<void>;
  onRemoveProject?: (projectId: string) => Promise<void>;
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
      kind: 'session';
      session: SessionSummary;
      containerId: string;
      zone: 'pinned' | 'normal';
      zoneIds: string[];
    };

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
  onDeleteGroup,
  onToggleGroupCollapsed,
  onAssignProjectGroup,
  onRenameProject,
  onRemoveProject,
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
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [localCollapsedGroups, setLocalCollapsedGroups] = useState<Record<string, boolean>>({});
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
  const [creating, setCreating] = useState(false);
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [footerOpen, setFooterOpen] = useState(false);

  const [actionSheet, setActionSheet] = useState<ActionSheetTarget | null>(null);
  const [renameMode, setRenameMode] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [moveToGroupMode, setMoveToGroupMode] = useState(false);
  const [confirmRemoveProject, setConfirmRemoveProject] = useState(false);
  const [deleteModal, setDeleteModal] = useState<DeleteModalState | null>(null);

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

  const { sessionsByProject, standaloneZones } = useMemo(() => {
    const byProj = new Map<string, SessionSummary[]>();
    const standalone: SessionSummary[] = [];
    for (const s of visibleSessions) {
      const matched =
        (s.projectId && projectByUriOrId.byId.get(s.projectId)) ||
        projectByUriOrId.byUri.get(normalizeUriPath(s.workspaceUri));
      if (matched) {
        const arr = byProj.get(matched.id) || [];
        arr.push(s);
        byProj.set(matched.id, arr);
      } else {
        standalone.push(s);
      }
    }
    return {
      sessionsByProject: byProj,
      standaloneZones: orderedSessionZones(standalone, '__standalone__')
    };
  }, [visibleSessions, projectByUriOrId, orderedSessionZones]);

  // Group -> { pinned: HostProject[], normal: HostProject[] }
  const projectsByContainer = useMemo(() => {
    const buckets = new Map<string, HostProject[]>();
    buckets.set('__ungrouped__', []);
    for (const g of groups) buckets.set(g.id, []);

    for (const p of projects) {
      const matchedSessions = sessionsByProject.get(p.id) || [];
      if ((normalizedSearch || statusFilter !== 'all') && matchedSessions.length === 0) {
        const projMatchesSearch =
          normalizedSearch &&
          `${p.name} ${p.path || ''} ${p.branchName || ''}`.toLowerCase().includes(normalizedSearch);
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

  const isGroupCollapsed = useCallback(
    (g: SessionGroup): boolean => {
      if (Object.prototype.hasOwnProperty.call(localCollapsedGroups, g.id)) {
        return Boolean(localCollapsedGroups[g.id]);
      }
      return Boolean(g.collapsed);
    },
    [localCollapsedGroups]
  );

  const handleToggleGroupCollapse = useCallback(
    (g: SessionGroup) => {
      const next = !isGroupCollapsed(g);
      setLocalCollapsedGroups((prev) => ({ ...prev, [g.id]: next }));
      if (permissionLevel !== 'L0') {
        void onToggleGroupCollapsed?.(g.id, next);
      }
    },
    [isGroupCollapsed, onToggleGroupCollapsed, permissionLevel]
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
      const zoned = orderedSessionZones(sessionsByProject.get(containerId) || [], containerId);
      return (zone === 'pinned' ? zoned.pinned : zoned.normal).map((s) => s.cascadeId);
    },
    [
      orderedGroups,
      projectsByContainer,
      pinnedQuickSessions,
      standaloneZones,
      sessionsByProject,
      orderedSessionZones
    ]
  );

  const handleDragLongPressActionSheet = useCallback(
    (item: DragItemMeta) => {
      suppressRowClickRef.current = true;
      window.setTimeout(() => {
        suppressRowClickRef.current = false;
      }, 200);
      setRenameMode(false);
      setMoveToGroupMode(false);
      setConfirmRemoveProject(false);

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
    [groups, projects, sessions, getZoneIds, getProjectGroupId]
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
        setLocalCollapsedGroups((prev) => ({ ...prev, [gid]: false }));
      },
      onDraggingChange: onDraggingOrgChange,
      onLongPressActionSheet: handleDragLongPressActionSheet
    });

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
        setRenameMode(false);
        setMoveToGroupMode(false);
        setConfirmRemoveProject(false);
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
    setRenameMode(false);
    setMoveToGroupMode(false);
    setConfirmRemoveProject(false);
    setActionSheet({
      kind: 'group',
      group,
      zone,
      zoneIds: getZoneIds('group', 'groups', zone)
    });
  };

  const openProjectActionSheet = (project: HostProject, containerId: string) => {
    const zone: 'pinned' | 'normal' = isProjectPinned(project) ? 'pinned' : 'normal';
    setRenameMode(false);
    setMoveToGroupMode(false);
    setConfirmRemoveProject(false);
    setActionSheet({
      kind: 'project',
      project,
      groupId: getProjectGroupId(project),
      containerId,
      zone,
      zoneIds: getZoneIds('project', containerId, zone)
    });
  };

  const openSessionActionSheet = (
    session: SessionSummary,
    containerId: string,
    zone: 'pinned' | 'normal'
  ) => {
    setRenameMode(false);
    setMoveToGroupMode(false);
    setConfirmRemoveProject(false);
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
      await onCreateSession(newTitle.trim() || undefined, newWorkspaceUri || undefined);
      setNewTitle('');
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
      await onCreateGroup?.(clean);
      setNewGroupName('');
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

  const renderProjectCard = (p: HostProject, groupId: string | null, containerId: string) => {
    const pinned = isProjectPinned(p);
    const zone: 'pinned' | 'normal' = pinned ? 'pinned' : 'normal';
    const collapsed = Boolean(collapsedProjects[p.id]);
    const sessionZones = orderedSessionZones(sessionsByProject.get(p.id) || [], p.id);
    const listCount = sessionZones.pinned.length + sessionZones.normal.length;
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
            onClick={() => {
              if (suppressRowClickRef.current || draggingItem) return;
              setCollapsedProjects((prev) => ({ ...prev, [p.id]: !collapsed }));
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
                {p.name}
              </span>
              <span className={styles.projectSub}>
                {p.branchName ? `${p.branchName} · ` : ''}
                {listCount}
              </span>
            </span>
          </button>

          <button
            type="button"
            className={styles.actionBtn}
            aria-label={t('left.newInProject', { name: p.name })}
            disabled={permissionLevel === 'L0'}
            onClick={() => {
              setNewWorkspaceUri(p.uri || p.path || '');
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

        {!collapsed && (
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
        )}
      </div>
    );
  };

  const renderGroupSection = (g: SessionGroup) => {
    const pinned = isGroupPinned(g);
    const zone: 'pinned' | 'normal' = pinned ? 'pinned' : 'normal';
    const collapsed = isGroupCollapsed(g);
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
            onClick={() => {
              if (suppressRowClickRef.current || draggingItem) return;
              handleToggleGroupCollapse(g);
            }}
          >
            <span className={styles.chevron}>{collapsed ? '▸' : '▾'}</span>
            {pinned && (
              <span className={styles.pinIconActive}>
                <PinGlyph filled />
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
            onClick={() => setShowNewSession((v) => !v)}
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
          <input
            type="text"
            className="ag-input"
            placeholder={t('left.sessionTitlePlaceholder')}
            value={newTitle}
            onInput={(e) => setNewTitle((e.target as HTMLInputElement).value)}
          />
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
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="ag-pill-btn"
              onClick={() => setShowNewSession(false)}
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="ag-pill-btn ag-pill-btn-primary"
              disabled={creating}
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
          <input
            type="text"
            className="ag-input"
            placeholder={t('left.groupNamePlaceholder')}
            value={newGroupName}
            onInput={(e) => setNewGroupName((e.target as HTMLInputElement).value)}
          />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="ag-pill-btn"
              onClick={() => setShowNewGroup(false)}
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
                  : actionSheet.session.title}
            </div>

            {renameMode && (actionSheet.kind === 'group' || actionSheet.kind === 'project') ? (
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
                    <button
                      type="button"
                      className={`${styles.actionSheetBtn} ${styles.actionSheetBtnDanger}`}
                      disabled={permissionLevel === 'L0'}
                      onClick={async () => {
                        await onDeleteGroup?.(actionSheet.group.id);
                        setActionSheet(null);
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
                    <button
                      type="button"
                      className={styles.actionSheetBtn}
                      disabled={permissionLevel === 'L0'}
                      onClick={() => setMoveToGroupMode(true)}
                    >
                      <span>{t('left.moveToGroup')}</span>
                      <span>›</span>
                    </button>
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

                {actionSheet.zoneIds.length > 1 && permissionLevel !== 'L0' && (
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
