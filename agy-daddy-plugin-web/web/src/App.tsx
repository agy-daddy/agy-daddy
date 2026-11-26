import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiClient, type WriteConfirmChallenge } from './api/client';
import { RightDock, type RightDockTab } from './dock';
import {
  ChatNavDock,
  collectSessionEditedFiles,
  Composer,
  serializeEventsToHtml,
  serializeEventsToMarkdown,
  SessionSidebar,
  SessionStream,
  type ChatSearchState,
} from './harness';
import { resolveNextActiveSessionId } from './harness/useSidebarDragSort';
import {
  HostAdminModal,
  TopbarCapsules,
  WriteConfirmModal,
  type ConnectionStatus,
  type HostAdminTab,
} from './host-admin';
import { formatSessionTitle, useI18n, type TranslateFn } from './i18n';
import { ThreeColumnShell } from './layout/ThreeColumnShell';
import { WebPetOverlay } from './pet/WebPetOverlay';
import {
  createNotificationManager,
  getNotificationPermission,
  isNotificationSupported,
  requestNotificationPermission,
  type NotificationManager,
  type NotificationPermissionState,
} from './notifications/notificationManager';
import { useTheme } from './theme/ThemeProvider';
import type {
  BackgroundTaskStatus,
  BackgroundTasksListResponse,
  CollapsedNodesState,
  ComposerStateResponse,
  ContextDisplayLocation,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  GitWorktreeMutationRequest,
  GitWorktreesResponse,
  HealthInfo,
  ModelCatalogTree,
  ModelItem,
  ModelTreeLeafNode,
  ModelTreeNode,
  OrgReorderRequest,
  PetBusState,
  PetStateResponse,
  ProjectGroup,
  ProjectItem,
  RemoteProvisionJob,
  RemoteStatusResponse,
  SessionDetail,
  SessionEvent,
  SessionOrderMap,
  SessionRunStatus,
  SessionSummary,
  StopBackgroundTaskResponse,
  TopbarPanels,
  UpdateProjectRequest,
  UserEventPayload,
  WebAccessStatusResponse,
  ZoneOrder,
} from './types';
import styles from './App.module.css';

const LazyNewProjectModal = lazy(() => import('./harness/NewProjectModal'));

function isUnauthorizedError(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === 401 || err.code === 'UNAUTHORIZED';
  }
  if (err && typeof err === 'object') {
    const rec = err as { status?: unknown; code?: unknown };
    return rec.status === 401 || rec.code === 'UNAUTHORIZED';
  }
  return false;
}

const MODEL_STORAGE_KEY = 'agy.web.selectedModel';
const THINKING_STORAGE_KEY = 'agy.web.selectedThinkingLevel';
const RECENT_SESSION_TTL_MS = 30_000;

function readStoredModelId(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(MODEL_STORAGE_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

function writeStoredModelId(modelId: string): void {
  try {
    if (typeof window !== 'undefined' && modelId) {
      window.localStorage.setItem(MODEL_STORAGE_KEY, modelId);
    }
  } catch {
    // Ignore storage failures in restricted contexts
  }
}

function readStoredThinkingLevel(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(THINKING_STORAGE_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

function writeStoredThinkingLevel(level: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (level && level.trim()) {
      window.localStorage.setItem(THINKING_STORAGE_KEY, level.trim());
    } else {
      window.localStorage.removeItem(THINKING_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures in restricted contexts
  }
}

function readSessionIdFromUrl(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    const val = new URLSearchParams(window.location.search).get('session');
    return val && val.trim() ? val.trim() : null;
  } catch {
    return null;
  }
}

function syncSessionUrl(cascadeId: string | null): void {
  try {
    if (typeof window === 'undefined' || !window.history?.replaceState) return;
    const url = new URL(window.location.href);
    if (cascadeId) {
      url.searchParams.set('session', cascadeId);
    } else {
      url.searchParams.delete('session');
    }
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, '', nextUrl);
  } catch {
    // Ignore history API restrictions
  }
}

function buildOptimisticSession(
  created: CreateSessionResponse,
  projects: ProjectItem[],
  fallbackWorkspaceUri?: string | null,
  fallbackProjectId?: string | null,
  fallbackWorktreePath?: string | null,
): SessionSummary {
  const nowIso = new Date().toISOString();
  const resolvedProjectId = created.projectId !== undefined ? created.projectId : (fallbackProjectId ?? null);
  const matchedProj = resolvedProjectId
    ? projects.find((p) => p.id === resolvedProjectId)
    : undefined;
  const resolvedWorkspaceUri =
    created.workspaceUri ||
    fallbackWorkspaceUri ||
    (matchedProj?.rootPath ? `file://${matchedProj.rootPath}` : null);
  const resolvedWorktreePath =
    created.worktreePath !== undefined ? created.worktreePath : (fallbackWorktreePath ?? null);
  const title = typeof created.title === 'string' && created.title.trim() ? created.title.trim() : '';

  return {
    cascadeId: created.cascadeId,
    shortId: created.cascadeId.slice(0, 8),
    hasTitle: Boolean(title),
    titleSource: title ? 'title' : 'none',
    title: title || created.cascadeId,
    summary: '',
    status: 'CASCADE_RUN_STATUS_IDLE',
    stepCount: 0,
    lastModifiedTime: nowIso,
    createdTime: nowIso,
    workspaceUri: resolvedWorkspaceUri,
    gitRootUri: null,
    repoName: matchedProj?.name ?? null,
    branchName: null,
    workspaces: resolvedWorkspaceUri ? [{ workspaceUri: resolvedWorkspaceUri }] : [],
    projectId: resolvedProjectId,
    projectName: matchedProj?.name ?? null,
    worktreeId: created.worktreeId ?? null,
    worktreePath: resolvedWorktreePath,
    worktreeBranch: null,
  };
}

function collectModelTreeLeaves(nodes: ModelTreeNode[] | undefined): ModelTreeLeafNode[] {
  if (!Array.isArray(nodes)) return [];
  const leaves: ModelTreeLeafNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'leaf') {
      leaves.push(node);
    } else if (Array.isArray(node.children)) {
      leaves.push(...collectModelTreeLeaves(node.children));
    }
  }
  return leaves;
}

function resolveValidModelId(
  candidate: string | null,
  models: ModelItem[],
  tree: ModelCatalogTree | null,
): string | null {
  if (!candidate) return null;
  const direct = models.find(
    (m) => !m.disabled && (m.id === candidate || m.model === candidate || m.modelId === candidate),
  );
  if (direct) return direct.id;
  const leaves = collectModelTreeLeaves(tree?.nodes);
  const leaf = leaves.find(
    (l) =>
      !l.disabled &&
      (l.selection.requestedModel === candidate || l.selection.modelId === candidate),
  );
  if (leaf) return leaf.selection.requestedModel;
  if (candidate.startsWith('orchestrator:')) {
    const familyId = candidate.slice('orchestrator:'.length).trim();
    const hasFamily = models.some(
      (m) =>
        !m.disabled &&
        String(m.modelId || '').toLowerCase().startsWith(`${familyId.toLowerCase()}-`),
    );
    if (hasFamily) return candidate;
  }
  return null;
}

function resolveModelDisplayLabel(
  selectedModelId: string | null,
  models: ModelItem[],
  tree: ModelCatalogTree | null,
): string | null {
  if (!selectedModelId) return null;
  const leaves = collectModelTreeLeaves(tree?.nodes);
  const matchingLeaf = leaves.find(
    (l) => l.selection.requestedModel === selectedModelId || l.selection.modelId === selectedModelId,
  );
  if (matchingLeaf?.selectedDisplayLabel) {
    return matchingLeaf.selectedDisplayLabel;
  }
  if (selectedModelId.startsWith('orchestrator:')) {
    const familyId = selectedModelId.slice('orchestrator:'.length).trim();
    const backing = models.find((m) =>
      String(m.modelId || '').toLowerCase().startsWith(`${familyId.toLowerCase()}-`),
    );
    const cleanName =
      String(backing?.displayName || backing?.label || familyId)
        .replace(/\s*\((?:low|medium|high|xhigh)\)\s*$/i, '')
        .trim() || familyId;
    return `Orchestrator · ${cleanName}`;
  }
  const matchingModel = models.find(
    (m) => m.id === selectedModelId || m.model === selectedModelId || m.modelId === selectedModelId,
  );
  return matchingModel?.label || selectedModelId;
}

function extractContextUsagePct(panels: TopbarPanels | null): number | null {
  const data = panels?.context?.data;
  if (!data) return null;
  for (const key of ['pct', 'percent', 'usagePct', 'usedPercent']) {
    const val = data[key];
    if (typeof val === 'number' && Number.isFinite(val)) return val;
  }
  const used = typeof data.used === 'number' ? data.used : null;
  const limit = typeof data.limit === 'number' ? data.limit : null;
  if (used !== null && limit !== null && limit > 0) {
    return Math.round((used / limit) * 100);
  }
  return null;
}

function isRunningStatus(status: SessionRunStatus | null | undefined): boolean {
  const upper = String(status || '').toUpperCase();
  return upper.includes('RUNNING') || upper.includes('GENERATING');
}

export function compareSessionEvents(a: SessionEvent, b: SessionEvent): number {
  const aNeg = a.seq < 0;
  const bNeg = b.seq < 0;
  if (aNeg !== bNeg) return aNeg ? 1 : -1;
  // Negative optimistic seqs (-1, -2, ...) preserve insertion order (FIFO): -1 before -2
  if (aNeg) return b.seq - a.seq;
  return a.seq - b.seq;
}

function normalizeComparableUserText(ev: SessionEvent): string {
  const p = (ev.payload || {}) as UserEventPayload;
  let raw = '';
  if (typeof p.userResponse === 'string' && p.userResponse) {
    raw = p.userResponse;
  } else if (typeof p.text === 'string' && p.text) {
    raw = p.text;
  } else if (Array.isArray(p.items)) {
    raw = p.items
      .map((item) => (typeof item === 'string' ? item : String((item as { text?: string })?.text || '')))
      .filter(Boolean)
      .join('\n');
  }
  return raw.trim().replace(/\s+/g, ' ');
}

function consumeMatchingOptimistic(
  ev: SessionEvent,
  optimisticUsers: SessionEvent[],
  bySeq: Map<number, SessionEvent>,
): void {
  if (optimisticUsers.length === 0) return;
  const incomingText = normalizeComparableUserText(ev);
  const matchIdx = optimisticUsers.findIndex(
    (opt) => normalizeComparableUserText(opt) === incomingText,
  );
  const [removed] = optimisticUsers.splice(matchIdx >= 0 ? matchIdx : 0, 1);
  if (removed) {
    bySeq.delete(removed.seq);
  }
}

export function mergeEventsBySeq(prev: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  if (!incoming || incoming.length === 0) return prev;
  if (prev.length === 0) {
    return incoming.slice().sort(compareSessionEvents);
  }

  // O(K) streaming tail fast path: prev has no pending negative optimistic events,
  // and incoming is non-decreasing at or after the tail of prev.
  const lastPrev = prev[prev.length - 1];
  if (prev[0].seq >= 0 && lastPrev.seq >= 0 && incoming[0].seq >= lastPrev.seq) {
    let isAscending = true;
    for (let i = 1; i < incoming.length; i++) {
      if (incoming[i].seq < incoming[i - 1].seq) {
        isAscending = false;
        break;
      }
    }
    if (isAscending) {
      const next = prev.slice();
      for (const ev of incoming) {
        const tail = next[next.length - 1];
        if (tail && ev.seq === tail.seq) {
          next[next.length - 1] = ev;
        } else {
          next.push(ev);
        }
      }
      return next;
    }
  }

  const prevSeqs = new Set<number>();
  const bySeq = new Map<number, SessionEvent>();
  const optimisticUsers: SessionEvent[] = [];
  for (const ev of prev) {
    prevSeqs.add(ev.seq);
    bySeq.set(ev.seq, ev);
    if (ev.seq < 0 && ev.kind === 'user') {
      optimisticUsers.push(ev);
    }
  }
  optimisticUsers.sort(compareSessionEvents);

  for (const ev of incoming) {
    if (ev.seq >= 0 && ev.kind === 'user' && !prevSeqs.has(ev.seq)) {
      prevSeqs.add(ev.seq);
      consumeMatchingOptimistic(ev, optimisticUsers, bySeq);
    }
    bySeq.set(ev.seq, ev);
  }
  return Array.from(bySeq.values()).sort(compareSessionEvents);
}

export function reconcileFullSessionEvents(
  prev: SessionEvent[],
  serverEvents: SessionEvent[],
  pendingOptimistic: SessionEvent[],
  detailSeqAtStart: number,
): SessionEvent[] {
  const serverSorted = serverEvents.slice().sort(compareSessionEvents);
  if (pendingOptimistic.length === 0) {
    return serverSorted;
  }
  const prevPositiveSeqs = new Set<number>();
  for (const ev of prev) {
    if (ev.seq >= 0) prevPositiveSeqs.add(ev.seq);
  }
  const bySeq = new Map<number, SessionEvent>();
  for (const ev of serverSorted) {
    bySeq.set(ev.seq, ev);
  }
  const reconcileCandidates: SessionEvent[] = [];
  for (const opt of pendingOptimistic) {
    bySeq.set(opt.seq, opt);
    if (Math.abs(opt.seq) <= detailSeqAtStart) {
      reconcileCandidates.push(opt);
    }
  }
  reconcileCandidates.sort(compareSessionEvents);

  if (reconcileCandidates.length > 0) {
    for (const ev of serverSorted) {
      if (ev.seq >= 0 && ev.kind === 'user' && !prevPositiveSeqs.has(ev.seq)) {
        prevPositiveSeqs.add(ev.seq);
        consumeMatchingOptimistic(ev, reconcileCandidates, bySeq);
      }
    }
  }
  return Array.from(bySeq.values()).sort(compareSessionEvents);
}

function formatWorkspaceChip(session: SessionSummary | null): string | null {
  if (!session) return null;
  if (session.repoName) return session.repoName;
  const raw = session.workspaceUri || session.gitRootUri;
  if (!raw) return null;
  const cleaned = raw.replace(/^file:\/\//i, '').replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : cleaned;
}

function formatErrorMessage(err: unknown, fallback: string, t: TranslateFn): string {
  if (err instanceof ApiError) {
    if (err.status === 401) {
      return t('errors.authExpired');
    }
    if (err.code === 'CONFIRMATION_CANCELLED') {
      return t('errors.confirmationCancelled');
    }
    if (err.code === 'SESSION_DETAIL_TIMEOUT' || err.status === 504) {
      return t('errors.sessionDetailTimeout');
    }
    return `${fallback}: ${err.message || err.code}`;
  }
  if (err instanceof Error && err.message) {
    return `${fallback}: ${err.message}`;
  }
  return fallback;
}

export function App() {
  const { syncHostLocale, t } = useI18n();
  const { hydrateFromSettings } = useTheme();
  const tRef = useRef<TranslateFn>(t);
  tRef.current = t;

  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState<boolean>(true);
  const [creatingSession, setCreatingSession] = useState<boolean>(false);
  const [includeInternal, setIncludeInternal] = useState<boolean>(false);
  const [hiddenInternalCount, setHiddenInternalCount] = useState<number>(0);
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [groupOrder, setGroupOrder] = useState<ZoneOrder | undefined>(undefined);
  const [projectOrder, setProjectOrder] = useState<Record<string, ZoneOrder> | undefined>(undefined);
  const [sessionOrder, setSessionOrder] = useState<SessionOrderMap | undefined>(undefined);
  const [archivedCount, setArchivedCount] = useState<number>(0);
  const [archivedSessions, setArchivedSessions] = useState<SessionSummary[]>([]);
  const [loadingArchived, setLoadingArchived] = useState<boolean>(false);
  const [sidebarViewMode, setSidebarViewMode] = useState<'active' | 'archived'>('active');
  const [newProjectModalOpen, setNewProjectModalOpen] = useState<boolean>(false);
  const [latestProjectJob, setLatestProjectJob] = useState<RemoteProvisionJob | null>(null);
  const [deleteModalState, setDeleteModalState] = useState<{
    session: SessionSummary;
    stage: 'confirm' | 'fallback';
    reasonCode?: string;
    submitting?: boolean;
  } | null>(null);
  const [sidebarToast, setSidebarToast] = useState<{
    id: number;
    message: string;
    actionLabel?: string;
    onAction?: () => void;
  } | null>(null);
  const [defaultSessionPath, setDefaultSessionPath] = useState<string>('');
  const [selectedProjectFilter, setSelectedProjectFilter] = useState<string>('all');
  const [orgRevision, setOrgRevision] = useState<number>(0);
  const [collapsedNodes, setCollapsedNodes] = useState<CollapsedNodesState>({
    projects: {},
    worktrees: {},
  });
  const [requestedDockRoot, setRequestedDockRoot] = useState<{ root: string; nonce: number } | null>(
    null,
  );
  const [dockWorkspaceRoot, setDockWorkspaceRoot] = useState<string>('');

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [models, setModels] = useState<ModelItem[]>([]);
  const [modelTree, setModelTree] = useState<ModelCatalogTree | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(() => readStoredModelId());
  const [selectedThinkingLevel, setSelectedThinkingLevel] = useState<string | null>(() =>
    readStoredThinkingLevel(),
  );
  const [sending, setSending] = useState<boolean>(false);
  const [canceling, setCanceling] = useState<boolean>(false);
  const [composerState, setComposerState] = useState<ComposerStateResponse | null>(null);
  const [exportingMarkdown, setExportingMarkdown] = useState<boolean>(false);

  const [topbarPanels, setTopbarPanels] = useState<TopbarPanels | null>(null);
  const [topbarLoading, setTopbarLoading] = useState<boolean>(true);
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatusResponse | null>(null);
  const [remoteLoading, setRemoteLoading] = useState<boolean>(true);
  const [webAccessStatus, setWebAccessStatus] = useState<WebAccessStatusResponse | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [authLocked, setAuthLocked] = useState<boolean>(false);
  const [unlockToken, setUnlockToken] = useState<string>('');
  const [unlockLoading, setUnlockLoading] = useState<boolean>(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [bootstrapNonce, setBootstrapNonce] = useState<number>(0);

  const [thinkingExpandOverride, setThinkingExpandOverride] = useState<boolean | null>(null);
  const [chatSearchState, setChatSearchState] = useState<ChatSearchState | null>(null);
  const [scrollToSeqState, setScrollToSeqState] = useState<{ seq: number; nonce: number }>({
    seq: 0,
    nonce: 0,
  });

  const [rightbarOpen, setRightbarOpen] = useState<boolean>(true);
  const [dockTab, setDockTab] = useState<RightDockTab>('files');
  const [dockRefreshKey, setDockRefreshKey] = useState<number>(0);
  const [gitSummaryNonce, setGitSummaryNonce] = useState<number>(0);
  const [focusedDiffFile, setFocusedDiffFile] = useState<{ path: string; nonce: number } | null>(null);
  const [focusedFilePath, setFocusedFilePath] = useState<{ path: string; nonce: number } | null>(null);
  const [gitDiffSummary, setGitDiffSummary] = useState<{
    isGitRepo: boolean;
    branch: string;
    files: Array<{ path: string; additions: number; deletions: number }>;
  } | null>(null);
  const [reviewBarDismissedSessionId, setReviewBarDismissedSessionId] = useState<string | null>(null);

  const [adminOpen, setAdminOpen] = useState<boolean>(
    () =>
      typeof window !== 'undefined' &&
      (window.location.pathname === '/settings' || window.location.pathname === '/pc/settings'),
  );
  const [adminTab, setAdminTab] = useState<HostAdminTab>('plugins');
  const [adminSelectedPluginId, setAdminSelectedPluginId] = useState<string | null>(null);
  const [tasksData, setTasksData] = useState<BackgroundTasksListResponse | null>(null);
  const [tasksLoading, setTasksLoading] = useState<boolean>(false);
  const [taskFilters, setTaskFilters] = useState<{ project: string; sessionId: string }>({
    project: '',
    sessionId: '',
  });
  const taskFiltersRef = useRef<{ project: string; sessionId: string }>(taskFilters);
  taskFiltersRef.current = taskFilters;
  const [composerDraftPatch, setComposerDraftPatch] = useState<{ text: string; nonce: number } | null>(null);
  const [contextLocationOverride, setContextLocationOverride] = useState<ContextDisplayLocation | null>(null);
  const [contextShowSpeedOverride, setContextShowSpeedOverride] = useState<boolean | null>(null);
  const [petData, setPetData] = useState<PetStateResponse | null>(null);

  const refreshPet = useCallback(async () => {
    if (typeof apiClient.getPetState !== 'function') return;
    try {
      const res = await apiClient.getPetState();
      setPetData(res);
    } catch {
      // Companion pet soft-degrades when plugin is disabled
    }
  }, []);
  const [enableNotifications, setEnableNotifications] = useState<boolean>(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>(() =>
    getNotificationPermission(),
  );
  const [notificationPromptDismissed, setNotificationPromptDismissed] = useState<boolean>(false);
  const [focusedTaskRequest, setFocusedTaskRequest] = useState<{ taskId: string; nonce: number } | null>(null);
  const notificationManagerRef = useRef<NotificationManager | null>(null);
  if (!notificationManagerRef.current) {
    notificationManagerRef.current = createNotificationManager(false);
  }
  const prevTaskStatusesRef = useRef<Map<string, BackgroundTaskStatus> | null>(null);
  const recentSessionNotifyRef = useRef<Map<string, number>>(new Map());
  const notifiedApprovalKeysRef = useRef<Set<string>>(new Set());

  const [bannerError, setBannerError] = useState<string | null>(null);
  const [confirmQueue, setConfirmQueue] = useState<
    Array<{ challenge: WriteConfirmChallenge; resolve: (confirmed: boolean) => void }>
  >([]);
  const confirmQueueRef = useRef<
    Array<{ challenge: WriteConfirmChallenge; resolve: (confirmed: boolean) => void }>
  >([]);
  confirmQueueRef.current = confirmQueue;

  useEffect(() => {
    apiClient.setConfirmWriteHandler?.((challenge) =>
      new Promise<boolean>((resolve) => {
        setConfirmQueue((prev) => [...prev, { challenge, resolve }]);
      }),
    );
    return () => {
      apiClient.setConfirmWriteHandler?.(null);
      for (const item of confirmQueueRef.current) {
        item.resolve(false);
      }
    };
  }, []);

  const settleCurrentConfirm = useCallback((confirmed: boolean) => {
    setConfirmQueue((prev) => {
      const [current, ...rest] = prev;
      if (current) {
        current.resolve(confirmed);
      }
      return rest;
    });
  }, []);

  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = activeSessionId;

  const sessionDetailRef = useRef<SessionDetail | null>(sessionDetail);
  sessionDetailRef.current = sessionDetail;

  const sessionsRef = useRef<SessionSummary[]>(sessions);
  sessionsRef.current = sessions;

  const projectsRef = useRef<ProjectItem[]>(projects);
  projectsRef.current = projects;

  const projectGroupsRef = useRef<ProjectGroup[]>(projectGroups);
  projectGroupsRef.current = projectGroups;

  const isDraggingRef = useRef<boolean>(false);
  const pendingOrgPatchRef = useRef<boolean>(false);
  const sidebarViewModeRef = useRef<'active' | 'archived'>(sidebarViewMode);
  sidebarViewModeRef.current = sidebarViewMode;
  const toastTimerRef = useRef<number | null>(null);

  const includeInternalRef = useRef<boolean>(includeInternal);
  includeInternalRef.current = includeInternal;

  const streamScrollRef = useRef<HTMLDivElement | null>(null);
  const recentCreatedSessionsRef = useRef<
    Map<string, { session: SessionSummary; expiresAt: number }>
  >(new Map());

  const optimisticSeqRef = useRef<number>(0);
  const optimisticEventsRef = useRef<
    Map<string, { sessionId: string; event: SessionEvent<UserEventPayload> }>
  >(new Map());
  const detailAbortControllerRef = useRef<AbortController | null>(null);
  const eventsSessionIdRef = useRef<string | null>(null);

  const syncOptimisticRefForSession = useCallback((sessionId: string, nextEvents: SessionEvent[]) => {
    const activeTempIds = new Set<string>();
    for (const ev of nextEvents) {
      const tempId = (ev.payload as UserEventPayload | undefined)?.clientTempId;
      if (typeof tempId === 'string' && tempId) {
        activeTempIds.add(tempId);
      }
    }
    for (const [tempId, entry] of optimisticEventsRef.current.entries()) {
      if (entry.sessionId === sessionId && !activeTempIds.has(tempId)) {
        optimisticEventsRef.current.delete(tempId);
      }
    }
  }, []);

  const lastMarkedReadRef = useRef<{ cascadeId: string; stepCount: number } | null>(null);

  const prevRunningRef = useRef<boolean>(false);

  const applyWebPluginSettings = useCallback(
    (values: Record<string, unknown> | null | undefined) => {
      if (!values || typeof values !== 'object') return;
      hydrateFromSettings(values);
      if (typeof values.enableNotifications === 'boolean') {
        setEnableNotifications(values.enableNotifications);
        notificationManagerRef.current?.setEnabled(values.enableNotifications);
        if (values.enableNotifications) {
          setNotificationPromptDismissed(false);
        }
        setNotificationPermission(getNotificationPermission());
      }
    },
    [hydrateFromSettings],
  );

  useEffect(() => {
    notificationManagerRef.current?.setEnabled(enableNotifications);
  }, [enableNotifications]);

  const markActiveSessionAsRead = useCallback(
    (sessionId: string, stepCount?: number, force = false) => {
      if (!sessionId) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      const session = sessionsRef.current.find((s) => s.cascadeId === sessionId);
      const resolvedStep =
        typeof stepCount === 'number' && Number.isFinite(stepCount)
          ? Math.max(0, Math.floor(stepCount))
          : session?.stepCount ?? 0;

      const prevMarked = lastMarkedReadRef.current;
      const alreadyMarkedSame =
        prevMarked?.cascadeId === sessionId && prevMarked.stepCount === resolvedStep;

      if (!force && !session?.unread && alreadyMarkedSame) {
        return;
      }
      if (
        !force &&
        !session?.unread &&
        prevMarked?.cascadeId === sessionId &&
        resolvedStep <= prevMarked.stepCount
      ) {
        return;
      }

      lastMarkedReadRef.current = { cascadeId: sessionId, stepCount: resolvedStep };
      setSessions((prev) =>
        prev.map((s) =>
          s.cascadeId === sessionId && s.unread
            ? { ...s, unread: false, lastReadAt: new Date().toISOString() }
            : s,
        ),
      );
      void apiClient
        .markSessionRead(sessionId, { lastReadStepCount: resolvedStep })
        .catch(() => {});
    },
    [],
  );

  const refreshHealth = useCallback(async () => {
    try {
      const res = await apiClient.getHealth();
      setHealth(res);
    } catch (err) {
      setBannerError(formatErrorMessage(err, t('errors.healthFailed'), t));
    }
  }, [t]);

  const refreshTopbar = useCallback(async () => {
    setTopbarLoading(true);
    try {
      const res = await apiClient.getTopbar();
      setTopbarPanels(res.panels);
    } catch {
      // Topbar panels soft-degrade cleanly when unavailable
    } finally {
      setTopbarLoading(false);
    }
  }, []);

  const refreshRemoteStatus = useCallback(async () => {
    setRemoteLoading(true);
    try {
      const res = await apiClient.getRemoteStatus();
      setRemoteStatus(res);
    } catch {
      // Remote status soft-degrades cleanly when unavailable
    } finally {
      setRemoteLoading(false);
    }
  }, []);

  const refreshWebAccessStatus = useCallback(async () => {
    if (typeof apiClient.getWebAccessStatus !== 'function') return;
    try {
      const res = await apiClient.getWebAccessStatus();
      setWebAccessStatus(res);
    } catch (err) {
      if (isUnauthorizedError(err)) {
        setAuthLocked(true);
      }
    }
  }, []);

  const refreshTasks = useCallback(
    async (overrideFilters?: { project?: string; sessionId?: string }) => {
      if (typeof apiClient.listBackgroundTasks !== 'function') return;
      const active = overrideFilters
        ? {
            project: overrideFilters.project ?? '',
            sessionId: overrideFilters.sessionId ?? '',
          }
        : taskFiltersRef.current;
      setTasksLoading(true);
      try {
        const hasAny = Boolean(active.project || active.sessionId);
        const res = hasAny
          ? await apiClient.listBackgroundTasks({
              project: active.project || undefined,
              sessionId: active.sessionId || undefined,
            })
          : await apiClient.listBackgroundTasks();
        setTasksData(res);
      } catch {
        // Background tasks panel soft-degrades cleanly when unavailable
      } finally {
        setTasksLoading(false);
      }
    },
    [],
  );

  const handleTaskFiltersChange = useCallback(
    (next: { project: string; sessionId: string }) => {
      taskFiltersRef.current = next;
      setTaskFilters(next);
      void refreshTasks(next);
    },
    [refreshTasks],
  );

  const handleStopTask = useCallback(
    async (taskId: string): Promise<StopBackgroundTaskResponse | void> => {
      if (typeof apiClient.stopBackgroundTask !== 'function') return;
      const res = await apiClient.stopBackgroundTask(taskId);
      await refreshTasks();
      return res;
    },
    [refreshTasks],
  );

  const mergeRecentCreatedSessions = useCallback((incoming: SessionSummary[]): SessionSummary[] => {
    const now = Date.now();
    const incomingIds = new Set(incoming.map((s) => s.cascadeId));
    const preserved: SessionSummary[] = [];
    for (const [cascadeId, entry] of recentCreatedSessionsRef.current.entries()) {
      if (incomingIds.has(cascadeId) || entry.expiresAt <= now) {
        recentCreatedSessionsRef.current.delete(cascadeId);
      } else {
        preserved.push(entry.session);
      }
    }
    return preserved.length > 0 ? [...preserved, ...incoming] : incoming;
  }, []);

  const refreshSessions = useCallback(
    async (overrideIncludeInternal?: boolean) => {
      setSessionsLoading(true);
      const effectiveIncludeInternal =
        overrideIncludeInternal !== undefined
          ? overrideIncludeInternal
          : includeInternalRef.current;
      try {
        const res = await apiClient.listSessions({
          limit: 80,
          includeInternal: effectiveIncludeInternal,
        });
        const merged = mergeRecentCreatedSessions(res.sessions);
        setSessions(merged);
        setHiddenInternalCount(res.hiddenInternalCount ?? 0);
        if (typeof res.archivedCount === 'number') {
          setArchivedCount(res.archivedCount);
        }
        setActiveSessionId((prev) => {
          if (prev && merged.some((s) => s.cascadeId === prev)) {
            return prev;
          }
          const firstVisible =
            merged.find((s) => !s.isInternalSession) || merged[0] || null;
          const nextId = firstVisible ? firstVisible.cascadeId : null;
          if (nextId !== prev) {
            syncSessionUrl(nextId);
          }
          return nextId;
        });
        return merged;
      } catch (err) {
        if (isUnauthorizedError(err)) {
          setAuthLocked(true);
        }
        setBannerError(formatErrorMessage(err, t('errors.sessionsFailed'), t));
        return null;
      } finally {
        setSessionsLoading(false);
      }
    },
    [mergeRecentCreatedSessions, t],
  );

  const refreshArchivedSessions = useCallback(async () => {
    setLoadingArchived(true);
    try {
      const res = await apiClient.listSessions({
        limit: 200,
        includeInternal: includeInternalRef.current,
        includeArchived: true,
      });
      const onlyArchived = (res.sessions || []).filter((s) => s.archived === true);
      setArchivedSessions(onlyArchived);
      if (typeof res.archivedCount === 'number') {
        setArchivedCount(res.archivedCount);
      } else {
        setArchivedCount(onlyArchived.length);
      }
    } catch {
      // Soft-ignore archived list load failure
    } finally {
      setLoadingArchived(false);
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const res = await apiClient.listProjects();
      setProjects(res.projects);
      setProjectGroups(res.groups);
      if (res.groupOrder) setGroupOrder(res.groupOrder);
      if (res.projectOrder) setProjectOrder(res.projectOrder);
      if (res.sessionOrder) setSessionOrder(res.sessionOrder);
      if (typeof res.archivedCount === 'number') setArchivedCount(res.archivedCount);
      if (res.defaultSessionPath) {
        setDefaultSessionPath(res.defaultSessionPath);
      }
      if (typeof res.revision === 'number') {
        setOrgRevision(res.revision);
      }
      if (res.collapsedNodes) {
        setCollapsedNodes(res.collapsedNodes);
      }
      return res;
    } catch {
      return null;
    }
  }, []);

  const loadSessionDetail = useCallback(
    async (sessionId: string) => {
      detailAbortControllerRef.current?.abort();
      const controller = new AbortController();
      detailAbortControllerRef.current = controller;
      const detailSeqAtStart = optimisticSeqRef.current;
      setDetailLoading(true);
      setDetailError(null);
      try {
        const res = await apiClient.getSessionDetail(sessionId, controller.signal);
        if (controller.signal.aborted || activeSessionIdRef.current !== sessionId) return;
        setSessionDetail(res.session);
        const prevWasSameSession = eventsSessionIdRef.current === sessionId;
        eventsSessionIdRef.current = sessionId;
        const pendingForSession = Array.from(optimisticEventsRef.current.values())
          .filter((entry) => entry.sessionId === sessionId)
          .map((entry) => entry.event);
        setEvents((prev) => {
          const next = reconcileFullSessionEvents(
            prevWasSameSession ? prev : [],
            res.events,
            pendingForSession,
            detailSeqAtStart,
          );
          syncOptimisticRefForSession(sessionId, next);
          return next;
        });
        for (const ev of res.events) {
          if (
            ev.seq >= 0 &&
            ev.kind !== 'user' &&
            (ev.status === 'pending' || (ev.kind === 'ask_question' && ev.status === 'running'))
          ) {
            notifiedApprovalKeysRef.current.add(`${sessionId}:${ev.seq}`);
          }
        }
        prevRunningRef.current = isRunningStatus(res.session.status);
        markActiveSessionAsRead(sessionId, res.session.numTotalSteps);
      } catch (err) {
        if (controller.signal.aborted || activeSessionIdRef.current !== sessionId) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setDetailError(formatErrorMessage(err, t('errors.sessionDetailFailed'), t));
      } finally {
        if (detailAbortControllerRef.current === controller) {
          detailAbortControllerRef.current = null;
        }
        if (!controller.signal.aborted && activeSessionIdRef.current === sessionId) {
          setDetailLoading(false);
        }
      }
    },
    [markActiveSessionAsRead, syncOptimisticRefForSession, t],
  );

  // Initial parallel bootstrap (runs once on mount)
  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      setSessionsLoading(true);
      setTopbarLoading(true);
      setRemoteLoading(true);
      const initialUrlSessionId = readSessionIdFromUrl();

      const [
        healthRes,
        sessionsRes,
        modelsRes,
        topbarRes,
        webSettingsRes,
        hostLocaleRes,
        projectsRes,
        composerRes,
        remoteRes,
        webAccessRes,
        tasksRes,
        petRes,
      ] = await Promise.allSettled([
        apiClient.getHealth(),
        apiClient.listSessions({ limit: 80, includeInternal: false }),
        apiClient.listModels(),
        apiClient.getTopbar(),
        apiClient.getPluginSettings('agy-daddy.web'),
        apiClient.getHostLocale(),
        apiClient.listProjects(),
        apiClient.getComposerState(),
        apiClient.getRemoteStatus(),
        typeof apiClient.getWebAccessStatus === 'function'
          ? apiClient.getWebAccessStatus()
          : Promise.resolve(null),
        typeof apiClient.listBackgroundTasks === 'function'
          ? apiClient.listBackgroundTasks()
          : Promise.resolve(null),
        typeof apiClient.getPetState === 'function'
          ? apiClient.getPetState()
          : Promise.resolve(null),
      ]);

      if (cancelled) return;
      const translate = tRef.current;

      if (healthRes.status === 'fulfilled') {
        setHealth(healthRes.value);
        if (healthRes.value.defaultSessionPath) {
          setDefaultSessionPath((prev) => prev || healthRes.value.defaultSessionPath || '');
        }
      } else {
        if (isUnauthorizedError(healthRes.reason)) {
          setAuthLocked(true);
        }
        setBannerError(formatErrorMessage(healthRes.reason, translate('errors.healthFailed'), translate));
      }

      if (sessionsRes.status === 'fulfilled') {
        const list = mergeRecentCreatedSessions(sessionsRes.value.sessions);
        setSessions(list);
        setHiddenInternalCount(sessionsRes.value.hiddenInternalCount ?? 0);
        if (typeof sessionsRes.value.archivedCount === 'number') {
          setArchivedCount(sessionsRes.value.archivedCount);
        }
        const urlMatched =
          initialUrlSessionId &&
          (list.some((s) => s.cascadeId === initialUrlSessionId) || list.length === 0)
            ? initialUrlSessionId
            : null;
        const firstVisible = list.find((s) => !s.isInternalSession) || list[0] || null;
        const targetInitialId = urlMatched || firstVisible?.cascadeId || null;
        if (targetInitialId) {
          setActiveSessionId((prev) => prev || targetInitialId);
          syncSessionUrl(targetInitialId);
        }
      } else {
        if (isUnauthorizedError(sessionsRes.reason)) {
          setAuthLocked(true);
        }
        if (initialUrlSessionId) {
          setActiveSessionId((prev) => prev || initialUrlSessionId);
        }
        setBannerError(
          formatErrorMessage(sessionsRes.reason, translate('errors.sessionsFailed'), translate),
        );
      }
      setSessionsLoading(false);

      if (modelsRes.status === 'fulfilled') {
        const nextModels = modelsRes.value.models;
        const nextTree = modelsRes.value.tree || null;
        setModels(nextModels);
        setModelTree(nextTree);
        const fallbackModel =
          modelsRes.value.defaultModelId ||
          nextModels.find((m) => m.isDefault && !m.disabled)?.id ||
          nextModels.find((m) => !m.disabled)?.id ||
          null;
        setSelectedModelId((prev) => {
          const valid = resolveValidModelId(prev, nextModels, nextTree);
          if (valid) return valid;
          const resolvedFallback = resolveValidModelId(fallbackModel, nextModels, nextTree) || fallbackModel;
          if (resolvedFallback) writeStoredModelId(resolvedFallback);
          return resolvedFallback;
        });
      }

      if (topbarRes.status === 'fulfilled') {
        setTopbarPanels(topbarRes.value.panels);
      }
      setTopbarLoading(false);

      if (webSettingsRes.status === 'fulfilled' && webSettingsRes.value?.values) {
        applyWebPluginSettings(webSettingsRes.value.values);
      }

      if (hostLocaleRes.status === 'fulfilled') {
        syncHostLocale(hostLocaleRes.value.locale, hostLocaleRes.value.supportedLanguages);
      }

      if (projectsRes.status === 'fulfilled') {
        setProjects(projectsRes.value.projects);
        setProjectGroups(projectsRes.value.groups);
        if (projectsRes.value.groupOrder) setGroupOrder(projectsRes.value.groupOrder);
        if (projectsRes.value.projectOrder) setProjectOrder(projectsRes.value.projectOrder);
        if (projectsRes.value.sessionOrder) setSessionOrder(projectsRes.value.sessionOrder);
        if (typeof projectsRes.value.archivedCount === 'number') {
          setArchivedCount(projectsRes.value.archivedCount);
        }
        if (projectsRes.value.defaultSessionPath) {
          setDefaultSessionPath(projectsRes.value.defaultSessionPath);
        }
        if (typeof projectsRes.value.revision === 'number') {
          setOrgRevision(projectsRes.value.revision);
        }
        if (projectsRes.value.collapsedNodes) {
          setCollapsedNodes(projectsRes.value.collapsedNodes);
        }
      }

      if (typeof apiClient.getSessionOrg === 'function') {
        void apiClient
          .getSessionOrg({ includeArchived: false })
          .then((org) => {
            if (cancelled) return;
            if (Array.isArray(org.projects)) setProjects(org.projects);
            if (Array.isArray(org.groups)) setProjectGroups(org.groups);
            if (typeof org.revision === 'number') setOrgRevision(org.revision);
            if (org.collapsedNodes) setCollapsedNodes(org.collapsedNodes);
          })
          .catch(() => {});
      }

      if (composerRes.status === 'fulfilled') {
        setComposerState(composerRes.value);
      }

      if (remoteRes.status === 'fulfilled') {
        setRemoteStatus(remoteRes.value);
      }
      setRemoteLoading(false);

      if (webAccessRes.status === 'fulfilled' && webAccessRes.value) {
        setWebAccessStatus(webAccessRes.value);
        const hasExplicitSetting =
          webSettingsRes.status === 'fulfilled' &&
          typeof webSettingsRes.value?.values?.enableNotifications === 'boolean';
        if (!hasExplicitSetting && typeof webAccessRes.value.enableNotifications === 'boolean') {
          setEnableNotifications(webAccessRes.value.enableNotifications);
          notificationManagerRef.current?.setEnabled(webAccessRes.value.enableNotifications);
        }
      }

      if (tasksRes.status === 'fulfilled' && tasksRes.value) {
        setTasksData(tasksRes.value);
      }

      if (petRes.status === 'fulfilled' && petRes.value) {
        setPetData(petRes.value);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applyWebPluginSettings, bootstrapNonce, mergeRecentCreatedSessions, syncHostLocale]);

  // Load detail whenever activeSessionId changes
  useEffect(() => {
    setThinkingExpandOverride(null);
    setScrollToSeqState({ seq: 0, nonce: 0 });
    if (!activeSessionId) {
      detailAbortControllerRef.current?.abort();
      detailAbortControllerRef.current = null;
      setDetailLoading(false);
      setSessionDetail(null);
      eventsSessionIdRef.current = null;
      setEvents([]);
      setDetailError(null);
      prevRunningRef.current = false;
      return;
    }
    if (eventsSessionIdRef.current !== activeSessionId) {
      eventsSessionIdRef.current = activeSessionId;
      setSessionDetail(null);
      setEvents([]);
      setDetailError(null);
    }
    void loadSessionDetail(activeSessionId);
    return () => {
      detailAbortControllerRef.current?.abort();
      detailAbortControllerRef.current = null;
    };
  }, [activeSessionId, loadSessionDetail]);

  useEffect(() => {
    if (typeof apiClient.interactPet !== 'function') return;
    void apiClient
      .interactPet({ action: 'set-active-session', cascadeId: activeSessionId || null })
      .catch(() => {});
  }, [activeSessionId]);

  // Live SSE subscription per active session
  useEffect(() => {
    if (!activeSessionId) {
      setConnectionStatus('disconnected');
      return;
    }

    setConnectionStatus('connecting');
    let topbarRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleTopbarRefresh = () => {
      if (topbarRefreshTimer) return;
      topbarRefreshTimer = setTimeout(() => {
        topbarRefreshTimer = null;
        void refreshTopbar();
      }, 250);
    };

    const unsubscribe = apiClient.subscribeSessionStream(activeSessionId, {
      onOpen: () => {
        setConnectionStatus('connected');
      },
      onError: () => {
        setConnectionStatus('reconnecting');
      },
      onHeartbeat: () => {
        setConnectionStatus('connected');
      },
      onDelta: (delta) => {
        setConnectionStatus('connected');
        if (delta.cascadeId && delta.cascadeId !== activeSessionId) return;

        if (Array.isArray(delta.events) && delta.events.length > 0) {
          const prevWasSameSession = eventsSessionIdRef.current === activeSessionId;
          eventsSessionIdRef.current = activeSessionId;
          setDetailError(null);
          setEvents((prev) => {
            const next = mergeEventsBySeq(prevWasSameSession ? prev : [], delta.events);
            syncOptimisticRefForSession(activeSessionId, next);
            return next;
          });
        }

        setSessionDetail((prev) => {
          if (!prev) return prev;
          if (prev.status === delta.status && prev.numTotalSteps === delta.totalSteps) {
            return prev;
          }
          return {
            ...prev,
            status: delta.status,
            numTotalSteps: delta.totalSteps,
          };
        });

        setSessions((prev) => {
          const target = prev.find((s) => s.cascadeId === activeSessionId);
          if (target && target.status === delta.status && target.stepCount === delta.totalSteps) {
            return prev;
          }
          const nowIso = new Date().toISOString();
          return prev.map((s) =>
            s.cascadeId === activeSessionId
              ? {
                  ...s,
                  status: delta.status,
                  stepCount: delta.totalSteps,
                  lastModifiedTime: nowIso,
                }
              : s,
          );
        });

        const wasRunning = prevRunningRef.current;
        const nowRunning = isRunningStatus(delta.status);
        const deltaSessionId = delta.cascadeId || activeSessionId;
        const translate = tRef.current;
        const deltaSessionSummary =
          sessionsRef.current.find((s) => s.cascadeId === deltaSessionId) ?? null;
        const deltaSessionTitle = formatSessionTitle(deltaSessionSummary, translate);

        if (Array.isArray(delta.events)) {
          for (const ev of delta.events) {
            const needsIntervention =
              ev.seq >= 0 &&
              ev.kind !== 'user' &&
              (ev.status === 'pending' || (ev.kind === 'ask_question' && ev.status === 'running'));
            if (!needsIntervention) continue;
            const approvalKey = `${deltaSessionId}:${ev.seq}`;
            if (notifiedApprovalKeysRef.current.has(approvalKey)) continue;
            notifiedApprovalKeysRef.current.add(approvalKey);
            notificationManagerRef.current?.notify({
              id: `approval:${approvalKey}`,
              title: translate('notifications.approvalTitle', { session: deltaSessionTitle }),
              body: ev.title ? String(ev.title) : translate('notifications.approvalBody'),
              tag: `approval:${deltaSessionId}`,
              onClick: () => {
                setActiveSessionId(deltaSessionId);
                syncSessionUrl(deltaSessionId);
                setScrollToSeqState((prev) => ({ seq: ev.seq, nonce: prev.nonce + 1 }));
              },
            });
          }
        }

        if (wasRunning && !nowRunning) {
          recentSessionNotifyRef.current.set(deltaSessionId, Date.now());
          const tailEv =
            Array.isArray(delta.events) && delta.events.length > 0
              ? delta.events[delta.events.length - 1]
              : null;
          const hasError = tailEv?.kind === 'error' || tailEv?.status === 'error';
          notificationManagerRef.current?.notify({
            id: `session-done:${deltaSessionId}:${delta.totalSteps}`,
            title: translate(
              hasError ? 'notifications.sessionErrorTitle' : 'notifications.sessionDoneTitle',
              { session: deltaSessionTitle },
            ),
            body: translate(
              hasError ? 'notifications.sessionErrorBody' : 'notifications.sessionDoneBody',
            ),
            tag: `session-done:${deltaSessionId}`,
            onClick: () => {
              setActiveSessionId(deltaSessionId);
              syncSessionUrl(deltaSessionId);
              if (tailEv && tailEv.seq >= 0) {
                setScrollToSeqState((prev) => ({ seq: tailEv.seq, nonce: prev.nonce + 1 }));
              }
            },
          });
          setDockRefreshKey((k) => k + 1);
          markActiveSessionAsRead(activeSessionId, delta.totalSteps, true);
          void refreshSessions();
        } else if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          markActiveSessionAsRead(activeSessionId, delta.totalSteps);
        }
        prevRunningRef.current = nowRunning;
      },
      onResync: () => {
        setConnectionStatus('connected');
        void loadSessionDetail(activeSessionId);
      },
      onTaskUpdated: () => {
        void refreshTasks();
      },
      onProjectJob: (job) => {
        setLatestProjectJob(job);
      },
      onStatePatch: (patch) => {
        if (patch.key === 'state:host.locale@1' || patch.key === 'state:zh-cn.lang@1') {
          const valObj =
            patch.value && typeof patch.value === 'object'
              ? (patch.value as Record<string, unknown>)
              : null;
          syncHostLocale(
            valObj ? (valObj.bcp47 || valObj.locale || valObj.lang) : patch.value,
          );
          return;
        }
        if (patch.key === 'state:session.readState@1') {
          const val =
            patch.value && typeof patch.value === 'object'
              ? (patch.value as Record<string, unknown>)
              : null;
          const readMap = (
            (val?.sessions && typeof val.sessions === 'object' ? val.sessions : null) ||
            (val?.sessionReadState && typeof val.sessionReadState === 'object'
              ? val.sessionReadState
              : null)
          ) as Record<string, { lastReadAt?: string; lastReadStepCount?: number }> | null;
          const completedSessionId =
            typeof val?.completedSessionId === 'string' ? val.completedSessionId : null;

          if (readMap) {
            setSessions((prev) =>
              prev.map((s) => {
                const entry = readMap[s.cascadeId];
                if (!entry) return s;
                const readMs = entry.lastReadAt ? Date.parse(entry.lastReadAt) : NaN;
                const completedMs = Date.parse(
                  s.lastCompletedTime || s.lastModifiedTime || '',
                );
                const timeOk =
                  Number.isFinite(readMs) &&
                  (!Number.isFinite(completedMs) || readMs >= completedMs);
                const stepOk =
                  typeof entry.lastReadStepCount === 'number' &&
                  s.stepCount <= entry.lastReadStepCount;
                if (s.unread && timeOk && stepOk) {
                  return {
                    ...s,
                    unread: false,
                    lastReadAt: entry.lastReadAt || s.lastReadAt,
                  };
                }
                return s;
              }),
            );
          }

          if (completedSessionId) {
            const lastNotifiedAt = recentSessionNotifyRef.current.get(completedSessionId);
            if (lastNotifiedAt === undefined || Date.now() - lastNotifiedAt >= 5000) {
              recentSessionNotifyRef.current.set(completedSessionId, Date.now());
              const translate = tRef.current;
              const targetSummary =
                sessionsRef.current.find((s) => s.cascadeId === completedSessionId) ?? null;
              const sessionTitle = formatSessionTitle(targetSummary, translate);
              notificationManagerRef.current?.notify({
                id: `session-done:${completedSessionId}`,
                title: translate('notifications.sessionDoneTitle', { session: sessionTitle }),
                body: translate('notifications.sessionDoneBody'),
                tag: `session-done:${completedSessionId}`,
                onClick: () => {
                  setActiveSessionId(completedSessionId);
                  syncSessionUrl(completedSessionId);
                  markActiveSessionAsRead(completedSessionId, undefined, true);
                },
              });
            }
          }

          if (completedSessionId && completedSessionId !== activeSessionIdRef.current) {
            setSessions((prev) =>
              prev.map((s) =>
                s.cascadeId === completedSessionId
                  ? {
                      ...s,
                      unread: true,
                      isRunning: false,
                      status: 'CASCADE_RUN_STATUS_IDLE',
                      lastCompletedTime: new Date().toISOString(),
                    }
                  : s,
              ),
            );
            void refreshSessions();
          } else if (completedSessionId && completedSessionId === activeSessionIdRef.current) {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
              void refreshSessions();
            } else {
              const current = sessionsRef.current.find(
                (s) => s.cascadeId === completedSessionId,
              );
              markActiveSessionAsRead(completedSessionId, current?.stepCount, true);
            }
          }
          return;
        }
        if (patch.key === 'state:web.status@1') {
          void refreshWebAccessStatus();
          return;
        }
        if (patch.key === 'state:remote.status@1') {
          const valObj =
            patch.value && typeof patch.value === 'object'
              ? (patch.value as Record<string, unknown>)
              : null;
          if (valObj) {
            setRemoteStatus((prev) => ({
              ok: true,
              available: true,
              ...(prev || {}),
              ...(valObj as Partial<RemoteStatusResponse>),
            }));
          } else {
            void refreshRemoteStatus();
          }
          void refreshWebAccessStatus();
          return;
        }
        if (
          patch.key === 'state:session.org@1' ||
          patch.key === 'state:projects@1' ||
          patch.key === 'state:workspaces@1'
        ) {
          if (isDraggingRef.current) {
            pendingOrgPatchRef.current = true;
            return;
          }
          void Promise.all([refreshProjects(), refreshSessions()]);
          if (sidebarViewModeRef.current === 'archived') {
            void refreshArchivedSessions();
          }
          return;
        }
        if (patch.key === 'state:composer.settings@1') {
          void apiClient
            .getComposerState()
            .then((res) => setComposerState(res))
            .catch(() => {});
          return;
        }
        if (patch.key === 'state:pet.state@1') {
          const valObj =
            patch.value && typeof patch.value === 'object'
              ? (patch.value as PetBusState)
              : null;
          if (valObj) {
            let needsSceneRefresh = false;
            setPetData((prev) => {
              if (!prev) {
                needsSceneRefresh = true;
                return { ok: true, available: true, state: valObj, scene: null, themes: [] };
              }
              if (prev.state?.themeId !== valObj.themeId || !prev.scene) {
                needsSceneRefresh = true;
              }
              return { ...prev, available: true, state: valObj };
            });
            if (needsSceneRefresh) {
              void refreshPet();
            }
          }
          return;
        }
        if (patch.key === 'state:host.plugins@1') {
          void refreshHealth();
          void refreshTopbar();
          void apiClient
            .getComposerState()
            .then((res) => setComposerState(res))
            .catch(() => {});
          return;
        }
        if (patch.key === 'state:plugin.settings@1') {
          const valObj =
            patch.value && typeof patch.value === 'object'
              ? (patch.value as Record<string, unknown>)
              : null;
          const targetPlugin = typeof valObj?.pluginId === 'string' ? valObj.pluginId : '';
          const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
            Boolean(v) && typeof v === 'object' && !Array.isArray(v);
          const pSettings = isPlainRecord(valObj?.values)
            ? valObj.values
            : isPlainRecord(valObj?.settings)
              ? valObj.settings
              : null;
          if (targetPlugin === 'agy-daddy.context' && pSettings) {
            if (pSettings.displayLocation === 'composer' || pSettings.displayLocation === 'topbar') {
              setContextLocationOverride(pSettings.displayLocation);
            }
            if (typeof pSettings.showSpeed === 'boolean') {
              setContextShowSpeedOverride(pSettings.showSpeed);
            }
            void refreshTopbar();
          } else if (targetPlugin === 'agy-daddy.web' && pSettings) {
            applyWebPluginSettings(pSettings);
          } else if (targetPlugin === 'agy-daddy.composer') {
            void apiClient
              .getComposerState()
              .then((res) => setComposerState(res))
              .catch(() => {});
          } else if (targetPlugin === 'agy-daddy.pet') {
            void refreshPet();
          }
          return;
        }
        const match = /^state:(context|usage|quota)\.(snapshot|status|summary)@1$/.exec(patch.key);
        if (match) {
          const panelKey = match[1] as 'context' | 'usage' | 'quota';
          const valObj =
            patch.value && typeof patch.value === 'object'
              ? (patch.value as Record<string, unknown>)
              : undefined;
          if (panelKey === 'context' && valObj) {
            if (valObj.displayLocation === 'composer' || valObj.displayLocation === 'topbar') {
              setContextLocationOverride(valObj.displayLocation);
            }
            if (typeof valObj.showSpeed === 'boolean') {
              setContextShowSpeedOverride(valObj.showSpeed);
            }
          }
          setTopbarPanels((prev) => {
            const base: TopbarPanels = prev || {
              context: { available: false },
              usage: { available: false },
              quota: { available: false },
            };
            return {
              ...base,
              [panelKey]: {
                available: Boolean(valObj),
                source: 'state',
                data: valObj,
                ...(panelKey === 'context' && valObj
                  ? {
                      settings: {
                        displayLocation:
                          valObj.displayLocation === 'composer' ? 'composer' : 'topbar',
                        showSpeed: Boolean(valObj.showSpeed),
                        compactPolicy:
                          typeof valObj.compactPolicy === 'string'
                            ? valObj.compactPolicy
                            : undefined,
                      },
                    }
                  : {}),
              },
            };
          });
        }
        scheduleTopbarRefresh();
      },
      onOrgUpdated: (evt) => {
        if (isDraggingRef.current) {
          pendingOrgPatchRef.current = true;
          return;
        }
        if (typeof evt.revision === 'number') {
          setOrgRevision(evt.revision);
        }
        if (evt.collapsedNodes) {
          setCollapsedNodes(evt.collapsedNodes);
        }
        void refreshProjects();
      },
      onWorktreeUpdated: () => {
        if (isDraggingRef.current) {
          pendingOrgPatchRef.current = true;
          return;
        }
        void refreshProjects();
      },
    });

    return () => {
      if (topbarRefreshTimer) clearTimeout(topbarRefreshTimer);
      unsubscribe();
    };
  }, [
    activeSessionId,
    applyWebPluginSettings,
    loadSessionDetail,
    markActiveSessionAsRead,
    refreshHealth,
    refreshPet,
    refreshProjects,
    refreshRemoteStatus,
    refreshSessions,
    refreshTasks,
    refreshTopbar,
    syncHostLocale,
    syncOptimisticRefForSession,
  ]);

  // Keep App-synced projects fresh on window focus and via 30s visibility-aware polling
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshProjects();
      }
    };
    const timer = window.setInterval(refreshIfVisible, 30_000);
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [refreshProjects]);

  // Mark active session read when tab regains focus or visibility
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const handleFocusOrVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const currentId = activeSessionIdRef.current;
      if (!currentId) return;
      const current = sessionsRef.current.find((s) => s.cascadeId === currentId);
      if (current?.unread) {
        markActiveSessionAsRead(currentId, current.stepCount, true);
      }
    };
    window.addEventListener('focus', handleFocusOrVisible);
    document.addEventListener('visibilitychange', handleFocusOrVisible);
    return () => {
      window.removeEventListener('focus', handleFocusOrVisible);
      document.removeEventListener('visibilitychange', handleFocusOrVisible);
    };
  }, [markActiveSessionAsRead]);

  // Notify when background tasks transition from running -> done/error/pending while page is inactive
  useEffect(() => {
    if (!tasksData) return;
    const allTasks = [...(tasksData.running || []), ...(tasksData.recent || [])];
    const nextMap = new Map<string, BackgroundTaskStatus>();
    for (const task of allTasks) {
      nextMap.set(task.taskId, task.status);
    }

    const prevMap = prevTaskStatusesRef.current;
    prevTaskStatusesRef.current = nextMap;
    if (!prevMap) {
      return;
    }

    const translate = tRef.current;
    for (const task of allTasks) {
      const prevStatus = prevMap.get(task.taskId);
      if (prevStatus !== 'running') continue;

      if (task.status === 'done' || task.status === 'error') {
        if (task.kind === 'session' && task.sessionId) {
          const lastAt = recentSessionNotifyRef.current.get(task.sessionId);
          if (lastAt !== undefined && Date.now() - lastAt < 5000) {
            continue;
          }
          recentSessionNotifyRef.current.set(task.sessionId, Date.now());
        }

        const kindLabel = translate(`tasks.kind.${task.kind}` as Parameters<TranslateFn>[0]);
        notificationManagerRef.current?.notify({
          id: `task:${task.taskId}:${task.status}`,
          title: translate(
            task.status === 'error' ? 'notifications.taskErrorTitle' : 'notifications.taskDoneTitle',
            { title: task.title },
          ),
          body: translate(
            task.status === 'error' ? 'notifications.taskErrorBody' : 'notifications.taskDoneBody',
            { kind: kindLabel },
          ),
          tag: `task:${task.taskId}`,
          onClick: () => {
            if (task.sessionId) {
              setActiveSessionId(task.sessionId);
              syncSessionUrl(task.sessionId);
              markActiveSessionAsRead(task.sessionId);
            }
            setFocusedTaskRequest((prev) => ({
              taskId: task.taskId,
              nonce: (prev?.nonce ?? 0) + 1,
            }));
          },
        });
      } else if (task.status === 'pending') {
        const sessionLabel = task.sessionTitle || task.title;
        notificationManagerRef.current?.notify({
          id: `task-approval:${task.taskId}`,
          title: translate('notifications.approvalTitle', { session: sessionLabel }),
          body: task.commandLine || translate('notifications.approvalBody'),
          tag: `task-approval:${task.taskId}`,
          onClick: () => {
            if (task.sessionId) {
              setActiveSessionId(task.sessionId);
              syncSessionUrl(task.sessionId);
            }
            setFocusedTaskRequest((prev) => ({
              taskId: task.taskId,
              nonce: (prev?.nonce ?? 0) + 1,
            }));
          },
        });
      }
    }
  }, [markActiveSessionAsRead, tasksData]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.cascadeId === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const activeWorkspaceRoot = useMemo(() => {
    const raw =
      activeSession?.workspaceUri ||
      activeSession?.gitRootUri ||
      health?.allowedRoots?.[0] ||
      defaultSessionPath ||
      '';
    if (!raw) return '';
    return raw.replace(/^file:\/\//i, '').replace(/\/+$/, '');
  }, [activeSession?.workspaceUri, activeSession?.gitRootUri, health?.allowedRoots, defaultSessionPath]);

  useEffect(() => {
    setReviewBarDismissedSessionId(null);
    if (!activeWorkspaceRoot) {
      setGitDiffSummary(null);
      return;
    }
    const controller = new AbortController();
    void apiClient
      .getGitDiff({ root: activeWorkspaceRoot }, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setGitDiffSummary({
          isGitRepo: Boolean(res.isGitRepo),
          branch: res.branch || '',
          files: Array.isArray(res.files) ? res.files : [],
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setGitDiffSummary(null);
        }
      });
    return () => {
      controller.abort();
    };
  }, [activeWorkspaceRoot, activeSessionId, dockRefreshKey, gitSummaryNonce]);

  const effectiveStatus: SessionRunStatus =
    sessionDetail?.status || activeSession?.status || 'CASCADE_RUN_STATUS_IDLE';
  const isRunning = isRunningStatus(effectiveStatus);

  const handleSelectSession = useCallback(
    (cascadeId: string) => {
      setActiveSessionId(cascadeId);
      syncSessionUrl(cascadeId);
      setBannerError(null);
      markActiveSessionAsRead(cascadeId);
    },
    [markActiveSessionAsRead],
  );

  const handleToggleIncludeInternal = useCallback(
    (next: boolean) => {
      includeInternalRef.current = next;
      setIncludeInternal(next);
      void Promise.all([refreshSessions(next), refreshProjects()]);
    },
    [refreshProjects, refreshSessions],
  );

  const handleCreateSession = useCallback(
    async (opts?: {
      projectId?: string | null;
      workspaceUri?: string;
      worktreePath?: string;
      standalone?: boolean;
    }) => {
      setCreatingSession(true);
      setBannerError(null);
      try {
        const payload: CreateSessionRequest = {};
        if (opts?.projectId !== undefined) {
          payload.projectId = opts.projectId;
        }
        if (opts?.standalone !== undefined) {
          payload.standalone = opts.standalone;
        }
        if (opts?.worktreePath) {
          payload.worktreePath = opts.worktreePath;
        }
        if (opts?.workspaceUri) {
          payload.workspaceUri = opts.workspaceUri;
        } else if (opts?.worktreePath) {
          payload.workspaceUri = `file://${opts.worktreePath}`;
        } else if (opts?.projectId) {
          const matchedProject = projectsRef.current.find((p) => p.id === opts.projectId);
          if (matchedProject?.rootPath) {
            payload.workspaceUri = `file://${matchedProject.rootPath}`;
          }
        } else if (!opts?.standalone) {
          const workspaceRoot = health?.allowedRoots?.[0];
          if (workspaceRoot) {
            payload.workspaceUri = `file://${workspaceRoot}`;
          }
        }
        const created = await apiClient.createSession(payload);
        const optimistic = buildOptimisticSession(
          created,
          projectsRef.current,
          payload.workspaceUri,
          opts?.projectId,
          opts?.worktreePath,
        );
        recentCreatedSessionsRef.current.set(created.cascadeId, {
          session: optimistic,
          expiresAt: Date.now() + RECENT_SESSION_TTL_MS,
        });
        setSessions((prev) => [
          optimistic,
          ...prev.filter((s) => s.cascadeId !== created.cascadeId),
        ]);
        eventsSessionIdRef.current = created.cascadeId;
        setEvents([]);
        setSessionDetail(null);
        setDetailError(null);
        activeSessionIdRef.current = created.cascadeId;
        setActiveSessionId(created.cascadeId);
        syncSessionUrl(created.cascadeId);
        await Promise.all([refreshSessions(), refreshProjects()]);
      } catch (err) {
        setBannerError(formatErrorMessage(err, t('errors.createSessionFailed'), t));
      } finally {
        setCreatingSession(false);
      }
    },
    [health?.allowedRoots, refreshProjects, refreshSessions, t],
  );

  const showSidebarToast = useCallback(
    (message: string, opts?: { actionLabel?: string; onAction?: () => void; durationMs?: number }) => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
      const id = Date.now();
      setSidebarToast({
        id,
        message,
        actionLabel: opts?.actionLabel,
        onAction: opts?.onAction,
      });
      const duration = opts?.durationMs ?? 4500;
      toastTimerRef.current = window.setTimeout(() => {
        setSidebarToast((prev) => (prev?.id === id ? null : prev));
        toastTimerRef.current = null;
      }, duration);
    },
    [],
  );

  const handleDraggingChange = useCallback(
    (dragging: boolean) => {
      isDraggingRef.current = dragging;
      if (!dragging && pendingOrgPatchRef.current) {
        pendingOrgPatchRef.current = false;
        void Promise.all([refreshProjects(), refreshSessions()]);
      }
    },
    [refreshProjects, refreshSessions],
  );

  const handleViewModeChange = useCallback(
    (mode: 'active' | 'archived') => {
      setSidebarViewMode(mode);
      if (mode === 'archived') {
        void refreshArchivedSessions();
      }
    },
    [refreshArchivedSessions],
  );

  const handleSidebarSearchChange = useCallback(
    (query: string) => {
      if (query.trim() && archivedCount > 0 && archivedSessions.length === 0) {
        void refreshArchivedSessions();
      }
    },
    [archivedCount, archivedSessions.length, refreshArchivedSessions],
  );

  const handlePinSession = useCallback(
    async (cascadeId: string, pinned: boolean) => {
      setBannerError(null);
      const prevSessions = sessionsRef.current;
      setSessions((prev) =>
        prev.map((s) =>
          s.cascadeId === cascadeId
            ? {
                ...s,
                pinned,
                pinnedAt: pinned ? new Date().toISOString() : null,
              }
            : s,
        ),
      );
      try {
        const res =
          typeof apiClient.toggleOrgPin === 'function'
            ? await apiClient.toggleOrgPin({ type: 'session', id: cascadeId, pinned })
            : await apiClient.pinSession(cascadeId, pinned);
        setSessions((prev) =>
          prev.map((s) =>
            s.cascadeId === cascadeId
              ? {
                  ...s,
                  pinned,
                  pinnedAt: res.pinnedAt ?? (pinned ? new Date().toISOString() : null),
                }
              : s,
          ),
        );
        await Promise.all([refreshSessions(), refreshProjects()]);
      } catch (err) {
        setSessions(prevSessions);
        setBannerError(formatErrorMessage(err, t('errors.sessionsFailed'), t));
      }
    },
    [refreshProjects, refreshSessions, t],
  );

  const handlePinProject = useCallback(
    async (project: ProjectItem, pinned: boolean) => {
      setBannerError(null);
      const prevProjects = projectsRef.current;
      setProjects((prev) =>
        prev.map((p) =>
          p.id === project.id
            ? { ...p, pinned, pinnedAt: pinned ? new Date().toISOString() : null }
            : p,
        ),
      );
      try {
        if (typeof apiClient.toggleOrgPin === 'function') {
          await apiClient.toggleOrgPin({
            type: 'project',
            id: project.id,
            pinned,
            rootPath: project.rootPath,
            projectName: project.name,
          });
        }
        await refreshProjects();
      } catch (err) {
        setProjects(prevProjects);
        setBannerError(formatErrorMessage(err, t('dockErr.requestFailed'), t));
      }
    },
    [refreshProjects, t],
  );

  const handlePinGroup = useCallback(
    async (group: ProjectGroup, pinned: boolean) => {
      setBannerError(null);
      const prevGroups = projectGroupsRef.current;
      setProjectGroups((prev) =>
        prev.map((g) =>
          g.id === group.id
            ? { ...g, pinned, pinnedAt: pinned ? new Date().toISOString() : null }
            : g,
        ),
      );
      try {
        if (typeof apiClient.toggleOrgPin === 'function') {
          await apiClient.toggleOrgPin({ type: 'group', id: group.id, pinned });
        }
        await refreshProjects();
      } catch (err) {
        setProjectGroups(prevGroups);
        setBannerError(formatErrorMessage(err, t('dockErr.requestFailed'), t));
      }
    },
    [refreshProjects, t],
  );

  const handleReorderOrg = useCallback(
    async (req: OrgReorderRequest) => {
      if (typeof apiClient.reorderOrg !== 'function') return;
      setBannerError(null);
      const prevProjects = projectsRef.current;
      const prevGroups = projectGroupsRef.current;
      const prevGroupOrder = groupOrder;
      const prevProjectOrder = projectOrder;
      const prevSessionOrder = sessionOrder;

      if (req.targetType === 'group') {
        setGroupOrder((prev) => ({
          pinned: prev?.pinned ?? [],
          normal: prev?.normal ?? [],
          [req.zone]: req.orderedIds,
        }));
      } else if (req.targetType === 'project') {
        const cid = req.containerId || '__ungrouped__';
        if (req.movedProject) {
          const toGid = req.movedProject.toGroupId ?? null;
          setProjects((prev) =>
            prev.map((p) =>
              p.id === req.movedProject!.projectId ? { ...p, groupId: toGid } : p,
            ),
          );
        }
        setProjectOrder((prev) => ({
          ...(prev || {}),
          [cid]: {
            pinned: prev?.[cid]?.pinned ?? [],
            normal: prev?.[cid]?.normal ?? [],
            [req.zone]: req.orderedIds,
          },
        }));
      } else if (req.targetType === 'session') {
        const cid = req.containerId || '__standalone__';
        setSessionOrder((prev) => {
          const next = { ...(prev || {}) };
          if (cid === '__pinned__') {
            next.__pinned__ = req.orderedIds;
          } else {
            const curZone = next[cid] && !Array.isArray(next[cid]) ? (next[cid] as ZoneOrder) : undefined;
            next[cid] = {
              pinned: curZone?.pinned ?? [],
              normal: curZone?.normal ?? [],
              [req.zone]: req.orderedIds,
            };
          }
          return next;
        });
      }

      try {
        await apiClient.reorderOrg(req);
        await Promise.all([refreshProjects(), refreshSessions()]);
      } catch (err) {
        setProjects(prevProjects);
        setProjectGroups(prevGroups);
        setGroupOrder(prevGroupOrder);
        setProjectOrder(prevProjectOrder);
        setSessionOrder(prevSessionOrder);
        setBannerError(formatErrorMessage(err, t('dockErr.requestFailed'), t));
      }
    },
    [groupOrder, projectOrder, refreshProjects, refreshSessions, sessionOrder, t],
  );

  const handleArchiveSession = useCallback(
    async (session: SessionSummary, archived: boolean) => {
      if (typeof apiClient.archiveSession !== 'function') return;
      setBannerError(null);
      const prevSessions = sessionsRef.current;
      const prevArchived = archivedSessions;
      const prevActiveId = activeSessionIdRef.current;
      const prevCount = archivedCount;

      if (archived) {
        const nextActiveId = resolveNextActiveSessionId(
          prevSessions,
          session.cascadeId,
          prevActiveId,
        );
        setSessions((prev) => prev.filter((s) => s.cascadeId !== session.cascadeId));
        setArchivedSessions((prev) => [
          { ...session, archived: true, pinned: false, archivedAt: new Date().toISOString() },
          ...prev.filter((s) => s.cascadeId !== session.cascadeId),
        ]);
        setArchivedCount((c) => c + 1);
        if (nextActiveId !== prevActiveId) {
          setActiveSessionId(nextActiveId);
          syncSessionUrl(nextActiveId);
        }
      } else {
        setArchivedSessions((prev) => prev.filter((s) => s.cascadeId !== session.cascadeId));
        setArchivedCount((c) => Math.max(0, c - 1));
      }

      try {
        await apiClient.archiveSession(session.cascadeId, {
          archived,
          stepCount: session.stepCount,
          isRunning: isRunningStatus(session.status),
          projectId: session.projectId ?? null,
          projectName: session.projectName ?? null,
          titleSnapshot: session.title,
        });
        await Promise.all([refreshSessions(), refreshProjects()]);
        if (sidebarViewModeRef.current === 'archived' || !archived) {
          await refreshArchivedSessions();
        }
        if (archived) {
          showSidebarToast(t('sidebarOrg.archivedToast'), {
            actionLabel: t('sidebarOrg.undo'),
            durationMs: 5000,
            onAction: () => {
              setSidebarToast(null);
              void handleArchiveSession(session, false);
            },
          });
        }
      } catch (err) {
        setSessions(prevSessions);
        setArchivedSessions(prevArchived);
        setArchivedCount(prevCount);
        setActiveSessionId(prevActiveId);
        syncSessionUrl(prevActiveId);
        setBannerError(formatErrorMessage(err, t('errors.sessionsFailed'), t));
      }
    },
    [
      archivedCount,
      archivedSessions,
      refreshArchivedSessions,
      refreshProjects,
      refreshSessions,
      showSidebarToast,
      t,
    ],
  );

  const handleRequestDeleteSession = useCallback((session: SessionSummary) => {
    setDeleteModalState({ session, stage: 'confirm', submitting: false });
  }, []);

  const handleConfirmDeleteSession = useCallback(
    async (mode: 'auto' | 'local_hide') => {
      const current = deleteModalState;
      if (!current || current.submitting || typeof apiClient.deleteSession !== 'function') return;
      const target = current.session;
      setDeleteModalState({ ...current, submitting: true });

      const prevSessions = sessionsRef.current;
      const prevArchived = archivedSessions;
      const prevActiveId = activeSessionIdRef.current;
      const prevCount = archivedCount;

      try {
        const res = await apiClient.deleteSession(target.cascadeId, mode);
        const nextActiveId = resolveNextActiveSessionId(
          prevSessions,
          target.cascadeId,
          prevActiveId,
        );
        setSessions((prev) => prev.filter((s) => s.cascadeId !== target.cascadeId));
        setArchivedSessions((prev) => prev.filter((s) => s.cascadeId !== target.cascadeId));
        if (target.archived) {
          setArchivedCount((c) => Math.max(0, c - 1));
        }
        if (nextActiveId !== prevActiveId) {
          setActiveSessionId(nextActiveId);
          syncSessionUrl(nextActiveId);
        }
        setDeleteModalState(null);
        showSidebarToast(
          res.deletionMode === 'local_tombstone'
            ? t('sidebarOrg.deletedLocalToast')
            : t('sidebarOrg.deletedHostToast'),
        );
        await Promise.all([refreshSessions(), refreshProjects()]);
      } catch (err) {
        const payload = err instanceof ApiError ? (err.payload as Record<string, unknown> | undefined) : undefined;
        if (
          mode === 'auto' &&
          err instanceof ApiError &&
          (err.code === 'HOST_DELETE_UNAVAILABLE' || payload?.canFallbackLocalHide === true)
        ) {
          const reasonCode =
            typeof payload?.reasonCode === 'string' ? payload.reasonCode : 'RPC_OFFLINE';
          setDeleteModalState({
            session: target,
            stage: 'fallback',
            reasonCode,
            submitting: false,
          });
          return;
        }
        setSessions(prevSessions);
        setArchivedSessions(prevArchived);
        setArchivedCount(prevCount);
        setActiveSessionId(prevActiveId);
        syncSessionUrl(prevActiveId);
        setDeleteModalState(null);
        setBannerError(formatErrorMessage(err, t('errors.sessionsFailed'), t));
      }
    },
    [
      archivedCount,
      archivedSessions,
      deleteModalState,
      refreshProjects,
      refreshSessions,
      showSidebarToast,
      t,
    ],
  );

  const handleCreateLocalProjectFromModal = useCallback(
    async (payload: CreateProjectRequest): Promise<ProjectItem | null> => {
      const res = await apiClient.createProject(payload);
      return res.project || null;
    },
    [],
  );

  const handleProjectCreatedFromModal = useCallback(
    (project: ProjectItem) => {
      setNewProjectModalOpen(false);
      setSidebarViewMode('active');
      setSelectedProjectFilter('all');
      void Promise.all([refreshProjects(), refreshHealth(), refreshSessions()]);
      showSidebarToast(t('newProject.createdToast', { name: project.name }), {
        actionLabel: t('newProject.createdNewSession'),
        durationMs: 6000,
        onAction: () => {
          setSidebarToast(null);
          void handleCreateSession({
            projectId: project.id,
            workspaceUri: project.rootPath ? `file://${project.rootPath}` : undefined,
          });
        },
      });
    },
    [handleCreateSession, refreshHealth, refreshProjects, refreshSessions, showSidebarToast, t],
  );

  const handleAssignSessionProject = useCallback(
    async (cascadeId: string, projectId: string | null) => {
      setBannerError(null);
      try {
        await apiClient.assignSessionProject(cascadeId, projectId);
        await Promise.all([refreshSessions(), refreshProjects()]);
      } catch (err) {
        setBannerError(formatErrorMessage(err, t('errors.sessionsFailed'), t));
      }
    },
    [refreshProjects, refreshSessions, t],
  );

  const handleCreateProject = useCallback(
    async (payload: CreateProjectRequest) => {
      setBannerError(null);
      try {
        await apiClient.createProject(payload);
        await Promise.all([refreshProjects(), refreshHealth(), refreshSessions()]);
      } catch (err) {
        setBannerError(formatErrorMessage(err, t('dockErr.requestFailed'), t));
      }
    },
    [refreshHealth, refreshProjects, refreshSessions, t],
  );

  const handleUpdateProject = useCallback(
    async (id: string, patch: UpdateProjectRequest) => {
      setBannerError(null);
      try {
        await apiClient.updateProject(id, patch);
        await Promise.all([refreshProjects(), refreshSessions()]);
      } catch (err) {
        setBannerError(formatErrorMessage(err, t('dockErr.requestFailed'), t));
      }
    },
    [refreshProjects, refreshSessions, t],
  );

  const handleDeleteProject = useCallback(
    async (id: string) => {
      setBannerError(null);
      try {
        await apiClient.deleteProject(id);
        setSelectedProjectFilter((prev) => (prev === id ? 'all' : prev));
        await Promise.all([refreshProjects(), refreshSessions(), refreshHealth()]);
      } catch (err) {
        setBannerError(formatErrorMessage(err, t('dockErr.requestFailed'), t));
      }
    },
    [refreshHealth, refreshProjects, refreshSessions, t],
  );

  const handleCreateGroup = useCallback(
    async (name: string, icon?: string | null) => {
      setBannerError(null);
      try {
        await apiClient.createProjectGroup(name, icon);
        await refreshProjects();
      } catch (err) {
        setBannerError(formatErrorMessage(err, t('dockErr.requestFailed'), t));
      }
    },
    [refreshProjects, t],
  );

  const handleUpdateGroup = useCallback(
    async (id: string, patch: { name?: string; collapsed?: boolean; icon?: string | null }) => {
      setBannerError(null);
      try {
        await apiClient.updateProjectGroup(id, patch);
        await refreshProjects();
      } catch (err) {
        setBannerError(formatErrorMessage(err, t('dockErr.requestFailed'), t));
      }
    },
    [refreshProjects, t],
  );

  const handleToggleGroupCollapsed = useCallback(
    async (id: string, collapsed: boolean) => {
      setProjectGroups((prev) =>
        prev.map((g) => (g.id === id ? { ...g, collapsed } : g)),
      );
      try {
        await apiClient.updateProjectGroup(id, { collapsed });
        await refreshProjects();
      } catch (err) {
        setBannerError(formatErrorMessage(err, t('dockErr.requestFailed'), t));
        await refreshProjects();
      }
    },
    [refreshProjects, t],
  );

  const handleRenameGroup = useCallback(
    async (id: string, name: string) => {
      setBannerError(null);
      try {
        await apiClient.updateProjectGroup(id, { name });
        await refreshProjects();
      } catch (err) {
        setBannerError(formatErrorMessage(err, t('dockErr.requestFailed'), t));
      }
    },
    [refreshProjects, t],
  );

  const handleDeleteGroup = useCallback(
    async (id: string) => {
      setBannerError(null);
      try {
        await apiClient.deleteProjectGroup(id);
        await refreshProjects();
      } catch (err) {
        setBannerError(formatErrorMessage(err, t('dockErr.requestFailed'), t));
      }
    },
    [refreshProjects, t],
  );

  const handleToggleNodeCollapsed = useCallback(
    async (nodeType: 'group' | 'project' | 'worktree', id: string, collapsed: boolean) => {
      if (nodeType === 'group') {
        setProjectGroups((prev) => prev.map((g) => (g.id === id ? { ...g, collapsed } : g)));
      } else {
        setCollapsedNodes((prev) => {
          const bucket = nodeType === 'project' ? 'projects' : 'worktrees';
          const nextBucket = { ...prev[bucket] };
          if (collapsed) {
            nextBucket[id] = true;
          } else {
            delete nextBucket[id];
          }
          return { ...prev, [bucket]: nextBucket };
        });
      }
      try {
        if (typeof apiClient.setOrgNodeCollapsed === 'function') {
          const res = await apiClient.setOrgNodeCollapsed({ nodeType, id, collapsed });
          if (typeof res.revision === 'number') setOrgRevision(res.revision);
          if (res.collapsedNodes) setCollapsedNodes(res.collapsedNodes);
        } else if (nodeType === 'group') {
          await apiClient.updateProjectGroup(id, { collapsed });
        }
        await refreshProjects();
      } catch (err) {
        setBannerError(formatErrorMessage(err, t('dockErr.requestFailed'), t));
        await refreshProjects();
      }
    },
    [refreshProjects, t],
  );

  const handleRefreshWorktrees = useCallback(async () => {
    try {
      if (typeof apiClient.getSessionOrg === 'function') {
        const org = await apiClient.getSessionOrg({ refreshWorktrees: true });
        if (Array.isArray(org.projects)) setProjects(org.projects);
        if (Array.isArray(org.groups)) setProjectGroups(org.groups);
        if (typeof org.revision === 'number') setOrgRevision(org.revision);
        if (org.collapsedNodes) setCollapsedNodes(org.collapsedNodes);
      } else {
        await refreshProjects();
      }
    } catch {
      await refreshProjects();
    }
  }, [refreshProjects]);

  const handleMutateWorktree = useCallback(
    async (req: GitWorktreeMutationRequest): Promise<GitWorktreesResponse | void> => {
      setBannerError(null);
      try {
        const res = await apiClient.gitWorktree(req);
        if (req.action === 'add') {
          showSidebarToast(t('worktree.createdToast', { branch: req.branch || req.path || '' }));
        } else if (req.action === 'remove') {
          showSidebarToast(t('worktree.removedToast', { path: req.path || '' }));
        } else if (req.action === 'prune') {
          showSidebarToast(t('worktree.prunedToast'));
        }
        await Promise.all([handleRefreshWorktrees(), refreshSessions()]);
        return res;
      } catch (err) {
        const msg = formatErrorMessage(err, t('dockErr.requestFailed'), t);
        showSidebarToast(msg);
        throw err;
      }
    },
    [handleRefreshWorktrees, refreshSessions, showSidebarToast, t],
  );

  const handleOpenWorktreeTerminal = useCallback((worktreePath: string) => {
    setRightbarOpen(true);
    setDockTab('terminal');
    setRequestedDockRoot((prev) => ({ root: worktreePath, nonce: (prev?.nonce ?? 0) + 1 }));
    setDockWorkspaceRoot(worktreePath);
  }, []);

  const handleOpenWorktreeDiff = useCallback((worktreePath: string) => {
    setRightbarOpen(true);
    setDockTab('diff');
    setRequestedDockRoot((prev) => ({ root: worktreePath, nonce: (prev?.nonce ?? 0) + 1 }));
    setDockWorkspaceRoot(worktreePath);
  }, []);

  const handleAuthorizeRoot = useCallback(
    async (root: string) => {
      await apiClient.authorizeWorkspaceRoot(root);
      await refreshHealth();
    },
    [refreshHealth],
  );

  const handleSendMessage = useCallback(
    async (text: string, modelId?: string, thinkingLevel?: string | null) => {
      setSending(true);
      setBannerError(null);
      let targetSessionId = activeSessionId;
      let clientTempId: string | null = null;
      let prevSessionStatus: SessionRunStatus = 'CASCADE_RUN_STATUS_IDLE';
      let prevDetailStatus: SessionRunStatus | undefined;
      let prevRunning = prevRunningRef.current;

      try {
        let createdNewSession = false;
        if (!targetSessionId) {
          const workspaceRoot = health?.allowedRoots?.[0];
          const workspaceUri = workspaceRoot ? `file://${workspaceRoot}` : undefined;
          const created = await apiClient.createSession(
            workspaceUri ? { workspaceUri } : {},
          );
          targetSessionId = created.cascadeId;
          createdNewSession = true;
          const optimistic = buildOptimisticSession(
            created,
            projectsRef.current,
            workspaceUri,
          );
          recentCreatedSessionsRef.current.set(created.cascadeId, {
            session: optimistic,
            expiresAt: Date.now() + RECENT_SESSION_TTL_MS,
          });
          setSessions((prev) => [
            optimistic,
            ...prev.filter((s) => s.cascadeId !== created.cascadeId),
          ]);
          eventsSessionIdRef.current = targetSessionId;
          setEvents([]);
          setSessionDetail(null);
          setDetailError(null);
          activeSessionIdRef.current = targetSessionId;
          setActiveSessionId(targetSessionId);
          syncSessionUrl(targetSessionId);
          void Promise.all([refreshSessions(), refreshProjects()]);
        }

        const existingSession = sessionsRef.current.find(
          (s) => s.cascadeId === targetSessionId,
        );
        prevSessionStatus = existingSession?.status ?? 'CASCADE_RUN_STATUS_IDLE';
        prevDetailStatus =
          sessionDetailRef.current?.cascadeId === targetSessionId
            ? sessionDetailRef.current.status
            : undefined;
        prevRunning = prevRunningRef.current;

        const nextOptSeq = ++optimisticSeqRef.current;
        clientTempId = `opt_${Date.now()}_${nextOptSeq}`;
        const optimisticEvent: SessionEvent<UserEventPayload> = {
          seq: -nextOptSeq,
          kind: 'user',
          status: 'pending',
          rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
          payload: {
            text,
            userResponse: text,
            items: [{ text }],
            clientTempId,
            optimistic: true,
          },
        };
        optimisticEventsRef.current.set(clientTempId, {
          sessionId: targetSessionId,
          event: optimisticEvent,
        });

        if (activeSessionIdRef.current === targetSessionId) {
          const sameSession = !createdNewSession && eventsSessionIdRef.current === targetSessionId;
          eventsSessionIdRef.current = targetSessionId;
          setEvents((prev) => mergeEventsBySeq(sameSession ? prev : [], [optimisticEvent]));
          prevRunningRef.current = true;
        }
        setSessionDetail((prev) =>
          prev && prev.cascadeId === targetSessionId
            ? { ...prev, status: 'CASCADE_RUN_STATUS_RUNNING' }
            : prev,
        );
        setSessions((prev) =>
          prev.map((s) =>
            s.cascadeId === targetSessionId
              ? {
                  ...s,
                  status: 'CASCADE_RUN_STATUS_RUNNING',
                  lastModifiedTime: new Date().toISOString(),
                }
              : s,
          ),
        );

        const effectiveThinkingLevel =
          thinkingLevel !== undefined ? thinkingLevel : selectedThinkingLevel;
        await apiClient.sendMessage(targetSessionId, {
          text,
          modelId: modelId || selectedModelId || undefined,
          thinkingLevel: effectiveThinkingLevel ?? undefined,
        });
      } catch (err) {
        if (targetSessionId && clientTempId) {
          const failedTempId = clientTempId;
          const rollbackSessionId = targetSessionId;
          optimisticEventsRef.current.delete(failedTempId);
          setEvents((prev) =>
            prev.filter(
              (ev) => (ev.payload as UserEventPayload | undefined)?.clientTempId !== failedTempId,
            ),
          );
          if (activeSessionIdRef.current === rollbackSessionId) {
            prevRunningRef.current = prevRunning;
          }
          setSessionDetail((prev) =>
            prev && prev.cascadeId === rollbackSessionId
              ? { ...prev, status: prevDetailStatus ?? prevSessionStatus }
              : prev,
          );
          setSessions((prev) =>
            prev.map((s) =>
              s.cascadeId === rollbackSessionId ? { ...s, status: prevSessionStatus } : s,
            ),
          );
        }
        setBannerError(formatErrorMessage(err, t('errors.sendMessageFailed'), t));
        throw err;
      } finally {
        setSending(false);
      }
    },
    [
      activeSessionId,
      health?.allowedRoots,
      refreshProjects,
      refreshSessions,
      selectedModelId,
      selectedThinkingLevel,
      t,
    ],
  );

  const handleCancelSession = useCallback(async () => {
    if (!activeSessionId) return;
    setCanceling(true);
    setBannerError(null);
    try {
      await apiClient.cancelSession(activeSessionId);
    } catch (err) {
      setBannerError(formatErrorMessage(err, t('errors.cancelSessionFailed'), t));
    } finally {
      setCanceling(false);
    }
  }, [activeSessionId, t]);

  const handleSelectModel = useCallback((nextId: string) => {
    setSelectedModelId(nextId);
    writeStoredModelId(nextId);
  }, []);

  const handleSelectThinkingLevel = useCallback((nextLevel: string | null) => {
    setSelectedThinkingLevel(nextLevel);
    writeStoredThinkingLevel(nextLevel);
  }, []);

  const handleRunCompact = useCallback(() => {
    if (sending || creatingSession) return;
    void handleSendMessage('/compact');
  }, [creatingSession, handleSendMessage, sending]);

  const handleOpenAdmin = useCallback((tab: HostAdminTab = 'plugins', selectedPluginId?: string) => {
    setAdminSelectedPluginId(selectedPluginId ?? null);
    setAdminTab(tab);
    setAdminOpen(true);
  }, []);

  const handleInsertFromSideChat = useCallback((text: string) => {
    setComposerDraftPatch((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const handlePluginsChanged = useCallback(() => {
    void refreshHealth();
    void refreshTopbar();
    void refreshRemoteStatus();
    void apiClient
      .getComposerState()
      .then((res) => setComposerState(res))
      .catch(() => {});
    void apiClient
      .getHostLocale()
      .then((res) => syncHostLocale(res.locale, res.supportedLanguages))
      .catch(() => {});
    void refreshPet();
    void apiClient
      .getPluginSettings('agy-daddy.web')
      .then((res) => {
        if (res?.values) applyWebPluginSettings(res.values);
      })
      .catch(() => {});
  }, [applyWebPluginSettings, refreshHealth, refreshPet, refreshRemoteStatus, refreshTopbar, syncHostLocale]);

  const handleCommandExecuted = useCallback(() => {
    void refreshTopbar();
    void refreshRemoteStatus();
    void refreshHealth();
  }, [refreshHealth, refreshRemoteStatus, refreshTopbar]);

  const handleInspectFile = useCallback((filePath: string) => {
    setRightbarOpen(true);
    setDockTab('files');
    if (filePath) {
      setFocusedFilePath((prev) => ({ path: filePath, nonce: (prev?.nonce ?? 0) + 1 }));
    }
  }, []);

  const handleReviewDiff = useCallback((filePath?: string) => {
    setRightbarOpen(true);
    setDockTab('diff');
    if (filePath) {
      setFocusedDiffFile((prev) => ({ path: filePath, nonce: (prev?.nonce ?? 0) + 1 }));
    }
  }, []);

  const sessionEditedFiles = useMemo(() => collectSessionEditedFiles(events), [events]);

  const reviewFilesSummary = useMemo(() => {
    if (gitDiffSummary?.isGitRepo && gitDiffSummary.files.length > 0) {
      let additions = 0;
      let deletions = 0;
      const items = gitDiffSummary.files.map((f) => {
        additions += f.additions || 0;
        deletions += f.deletions || 0;
        const parts = f.path.split('/').filter(Boolean);
        return {
          path: f.path,
          basename: parts.length > 0 ? parts[parts.length - 1] : f.path,
          additions: f.additions || 0,
          deletions: f.deletions || 0,
        };
      });
      return {
        source: 'git' as const,
        count: items.length,
        additions,
        deletions,
        files: items,
      };
    }
    if (sessionEditedFiles.length > 0) {
      let additions = 0;
      let deletions = 0;
      for (const f of sessionEditedFiles) {
        additions += f.additions;
        deletions += f.deletions;
      }
      return {
        source: 'session' as const,
        count: sessionEditedFiles.length,
        additions,
        deletions,
        files: sessionEditedFiles,
      };
    }
    return null;
  }, [gitDiffSummary, sessionEditedFiles]);

  const showReviewBar =
    Boolean(reviewFilesSummary && reviewFilesSummary.count > 0) &&
    reviewBarDismissedSessionId !== (activeSessionId || '__none__');

  const workspaceChip = formatWorkspaceChip(activeSession);
  const headerTitle = formatSessionTitle(activeSession, t);
  const activeModelLabel = useMemo(
    () => resolveModelDisplayLabel(selectedModelId, models, modelTree),
    [selectedModelId, models, modelTree],
  );
  const contextUsagePct = useMemo(() => extractContextUsagePct(topbarPanels), [topbarPanels]);

  const handleOptimizePrompt = useCallback(async (text: string): Promise<string | null> => {
    try {
      const res = await apiClient.optimizePrompt(text);
      return typeof res.optimized === 'string' && res.optimized.trim() ? res.optimized : null;
    } catch {
      return null;
    }
  }, []);

  const handleExportMarkdown = useCallback(async () => {
    const targetId = activeSessionId || 'session';
    setExportingMarkdown(true);
    try {
      let markdown = '';
      let filename = `${targetId}.md`;
      try {
        const res = await apiClient.exportSessionMarkdown(targetId, headerTitle, events);
        markdown = res.markdown || '';
        if (res.filename) filename = res.filename;
      } catch {
        markdown = serializeEventsToMarkdown(headerTitle, events);
      }
      if (!markdown) {
        markdown = serializeEventsToMarkdown(headerTitle, events);
      }
      if (typeof document !== 'undefined' && typeof URL !== 'undefined') {
        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(href);
      }
    } finally {
      setExportingMarkdown(false);
    }
  }, [activeSessionId, events, headerTitle]);

  const handleExportHtml = useCallback(() => {
    const targetId = activeSessionId || 'session';
    const html = serializeEventsToHtml(headerTitle, events, {
      sessionId: activeSessionId,
      modelName: activeModelLabel,
      expandThinking: thinkingExpandOverride === true,
    });
    if (typeof document !== 'undefined' && typeof URL !== 'undefined') {
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = `${targetId}.html`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(href);
    }
  }, [activeModelLabel, activeSessionId, events, headerTitle, thinkingExpandOverride]);

  const handleJumpToEventSeq = useCallback((seq: number) => {
    setScrollToSeqState((prev) => ({ seq, nonce: prev.nonce + 1 }));
  }, []);

  const effectiveContextDisplayLocation: ContextDisplayLocation =
    contextLocationOverride ??
    (topbarPanels?.context?.settings?.displayLocation === 'composer' ? 'composer' : 'topbar');
  const effectiveContextShowSpeed =
    contextShowSpeedOverride ?? Boolean(topbarPanels?.context?.settings?.showSpeed);

  return (
    <>
      <ThreeColumnShell
        rightbarOpen={rightbarOpen}
        onRightbarOpenChange={setRightbarOpen}
        onOpenSettings={() => handleOpenAdmin('plugins')}
        topbar={
          <div className={styles.topbarWrap}>
            <TopbarCapsules
              panels={topbarPanels}
              loading={topbarLoading}
              connectionStatus={connectionStatus}
              rpcConnected={Boolean(health?.rpcConnected)}
              hubOrigin={health?.hubOrigin ?? null}
              remoteStatus={remoteStatus}
              remoteLoading={remoteLoading}
              webAccessStatus={webAccessStatus}
              activeSessionId={activeSessionId}
              sessionTitle={headerTitle}
              sessionRunning={isRunning}
              workspaceName={workspaceChip}
              branchName={activeSession?.branchName || null}
              diffCount={reviewFilesSummary?.count ?? 0}
              contextDisplayLocation={effectiveContextDisplayLocation}
              tasksData={tasksData}
              tasksLoading={tasksLoading}
              activeProjectPath={activeWorkspaceRoot || null}
              activeProjectName={workspaceChip || null}
              taskFilters={taskFilters}
              onTaskFiltersChange={handleTaskFiltersChange}
              onRefreshTasks={() => void refreshTasks()}
              onStopTask={handleStopTask}
              onSelectTaskSession={(sid) => handleSelectSession(sid)}
              focusedTaskRequest={focusedTaskRequest}
              onRefreshSession={
                activeSessionId ? () => void loadSessionDetail(activeSessionId) : undefined
              }
              onOpenDiffReview={() => handleReviewDiff()}
              onPluginsChanged={handlePluginsChanged}
              onRefreshTopbar={() => void refreshTopbar()}
              onRefreshRemote={() => void refreshRemoteStatus()}
              onRefreshWebAccess={() => void refreshWebAccessStatus()}
              onRunCompact={handleRunCompact}
              onOpenHostAdmin={handleOpenAdmin}
              onOpenPlugins={() => handleOpenAdmin('plugins')}
              onOpenCommandPalette={() => handleOpenAdmin('commands')}
              onOpenDoctor={() => handleOpenAdmin('doctor')}
            />
          </div>
        }
        sidebar={
          <SessionSidebar
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={handleSelectSession}
            onCreateSession={(opts) => void handleCreateSession(opts)}
            loading={sessionsLoading}
            creating={creatingSession}
            onSearchQueryChange={handleSidebarSearchChange}
            projects={projects}
            projectGroups={projectGroups}
            selectedProjectFilter={selectedProjectFilter}
            onSelectProjectFilter={setSelectedProjectFilter}
            defaultSessionPath={defaultSessionPath || health?.defaultSessionPath}
            hiddenInternalCount={hiddenInternalCount}
            includeInternal={includeInternal}
            onToggleIncludeInternal={handleToggleIncludeInternal}
            permissionLevel={webAccessStatus?.permissionLevel || 'L2'}
            channel={webAccessStatus?.channel || 'loopback'}
            orgRevision={orgRevision}
            collapsedNodes={collapsedNodes}
            activeWorkspaceRoot={dockWorkspaceRoot || undefined}
            groupOrder={groupOrder}
            projectOrder={projectOrder}
            sessionOrder={sessionOrder}
            archivedCount={archivedCount}
            archivedSessions={archivedSessions}
            loadingArchived={loadingArchived}
            viewMode={sidebarViewMode}
            onViewModeChange={handleViewModeChange}
            onPinSession={handlePinSession}
            onPinProject={handlePinProject}
            onPinGroup={handlePinGroup}
            onAssignSessionProject={handleAssignSessionProject}
            onArchiveSession={handleArchiveSession}
            onRequestDeleteSession={handleRequestDeleteSession}
            onReorderOrg={handleReorderOrg}
            onToggleNodeCollapsed={handleToggleNodeCollapsed}
            onRefreshWorktrees={handleRefreshWorktrees}
            onMutateWorktree={handleMutateWorktree}
            onOpenWorktreeTerminal={handleOpenWorktreeTerminal}
            onOpenWorktreeDiff={handleOpenWorktreeDiff}
            onOpenNewProjectModal={() => setNewProjectModalOpen(true)}
            onDraggingChange={handleDraggingChange}
            onCreateProject={handleCreateProject}
            onUpdateProject={handleUpdateProject}
            onDeleteProject={handleDeleteProject}
            onCreateGroup={handleCreateGroup}
            onToggleGroupCollapsed={handleToggleGroupCollapsed}
            onRenameGroup={handleRenameGroup}
            onUpdateGroup={handleUpdateGroup}
            onDeleteGroup={handleDeleteGroup}
            onMarkSessionRead={(cid) => markActiveSessionAsRead(cid, undefined, true)}
          />
        }
        sidebarCollapsedContent={
          <div className={styles.collapsedRail}>
            <button
              type="button"
              className={`${styles.railBtn} ${styles.railBtnPrimary}`}
              onClick={() =>
                void handleCreateSession(
                  selectedProjectFilter !== 'all' && selectedProjectFilter !== '__none__'
                    ? { projectId: selectedProjectFilter }
                    : { standalone: true },
                )
              }
              disabled={creatingSession}
              title={t('sidebar.newSession')}
              aria-label={t('sidebar.newSession')}
            >
              +
            </button>
          </div>
        }
        center={
          <div className={styles.centerColumn}>
            {bannerError && (
              <div className={styles.errorBanner} role="alert">
                <span>{bannerError}</span>
                <button
                  type="button"
                  className={styles.dismissBtn}
                  onClick={() => setBannerError(null)}
                >
                  {t('common.close')}
                </button>
              </div>
            )}

            {enableNotifications &&
              isNotificationSupported() &&
              notificationPermission === 'default' &&
              !notificationPromptDismissed && (
                <div
                  className={styles.notificationBanner}
                  role="status"
                  data-testid="notification-permission-banner"
                >
                  <span>{t('notifications.permissionPromptTitle')}</span>
                  <div className={styles.notificationBannerActions}>
                    <button
                      type="button"
                      className={styles.notificationGrantBtn}
                      data-testid="notification-grant-btn"
                      onClick={() => {
                        void requestNotificationPermission().then((perm) => {
                          setNotificationPermission(perm);
                        });
                      }}
                    >
                      {t('notifications.permissionGrantBtn')}
                    </button>
                    <button
                      type="button"
                      className={styles.dismissBtn}
                      aria-label={t('common.close')}
                      onClick={() => setNotificationPromptDismissed(true)}
                    >
                      ×
                    </button>
                  </div>
                </div>
              )}

            <div className={styles.streamRegion}>
              <SessionStream
                events={events}
                sessionId={activeSessionId}
                loading={detailLoading}
                error={detailError}
                emptyTitle={
                  activeSessionId ? t('session.emptyTitleNoSteps') : t('session.emptyTitleNoSession')
                }
                emptyDescription={
                  activeSessionId ? t('session.emptyDescNoSteps') : t('session.emptyDescNoSession')
                }
                onRetry={activeSessionId ? () => void loadSessionDetail(activeSessionId) : undefined}
                onInspectFile={handleInspectFile}
                onReviewDiff={handleReviewDiff}
                scrollContainerRef={streamScrollRef}
                thinkingExpandOverride={thinkingExpandOverride}
                searchQuery={chatSearchState?.open ? chatSearchState.query : undefined}
                searchRegex={chatSearchState?.regex ?? false}
                searchCaseSensitive={chatSearchState?.caseSensitive ?? false}
                activeSearchMatchSeq={chatSearchState?.open ? chatSearchState.activeMatchSeq : null}
                scrollToSeq={scrollToSeqState.nonce > 0 ? scrollToSeqState.seq : null}
                scrollToSeqNonce={scrollToSeqState.nonce}
              />
              <ChatNavDock
                events={events}
                sessionId={activeSessionId}
                sessionTitle={headerTitle}
                modelName={activeModelLabel}
                scrollContainerRef={streamScrollRef}
                thinkingExpandOverride={thinkingExpandOverride}
                onThinkingExpandChange={setThinkingExpandOverride}
                onSearchStateChange={setChatSearchState}
                onJumpToEventSeq={handleJumpToEventSeq}
                onExportMarkdown={handleExportMarkdown}
                onExportHtml={handleExportHtml}
                exporting={exportingMarkdown}
              />
            </div>

            {showReviewBar && reviewFilesSummary && (
              <div className={styles.reviewStrip} data-testid="change-review-bar">
                <div className={styles.reviewStripLeft}>
                  <span className={styles.reviewBadge}>
                    {reviewFilesSummary.source === 'git'
                      ? t('review.barTitle', { count: reviewFilesSummary.count })
                      : t('review.sessionEdits', { count: reviewFilesSummary.count })}
                  </span>
                  {(reviewFilesSummary.additions > 0 || reviewFilesSummary.deletions > 0) && (
                    <span className={styles.reviewStats}>
                      <span className={styles.diffAddText}>+{reviewFilesSummary.additions}</span>
                      <span className={styles.diffDelText}>-{reviewFilesSummary.deletions}</span>
                    </span>
                  )}
                  <div className={styles.reviewFileChips}>
                    {reviewFilesSummary.files.slice(0, 3).map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        className={styles.reviewFileChip}
                        title={file.path}
                        onClick={() => handleReviewDiff(file.path)}
                      >
                        {file.basename}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={styles.reviewStripRight}>
                  <button
                    type="button"
                    className={styles.reviewOpenBtn}
                    onClick={() => handleReviewDiff()}
                    data-testid="change-review-open-btn"
                  >
                    {t('review.openDiff')}
                  </button>
                  <button
                    type="button"
                    className={styles.reviewDismissBtn}
                    onClick={() => setReviewBarDismissedSessionId(activeSessionId || '__none__')}
                    aria-label={t('review.dismiss')}
                    title={t('review.dismiss')}
                  >
                    ×
                  </button>
                </div>
              </div>
            )}

            <div className={styles.composerRegion}>
              <Composer
                models={models}
                modelTree={modelTree}
                selectedModelId={selectedModelId}
                onSelectModel={handleSelectModel}
                selectedThinkingLevel={selectedThinkingLevel}
                onSelectThinkingLevel={handleSelectThinkingLevel}
                onSend={handleSendMessage}
                onCancel={() => void handleCancelSession()}
                isRunning={isRunning}
                disabled={creatingSession}
                sending={sending}
                canceling={canceling}
                composerState={composerState}
                contextUsagePct={contextUsagePct}
                contextPanel={topbarPanels?.context ?? null}
                contextDisplayLocation={effectiveContextDisplayLocation}
                contextShowSpeed={effectiveContextShowSpeed}
                onRefreshContext={() => void refreshTopbar()}
                onRunCompact={handleRunCompact}
                externalDraftPatch={composerDraftPatch}
                onOptimizePrompt={handleOptimizePrompt}
                onExportMarkdown={handleExportMarkdown}
                exportingMarkdown={exportingMarkdown}
              />
            </div>
          </div>
        }
        rightbar={
          <RightDock
            activeSessionId={activeSessionId}
            activeSession={activeSession}
            allowedRoots={health?.allowedRoots}
            projects={projects}
            defaultWorkspaceRoot={health?.defaultSessionPath || defaultSessionPath || undefined}
            requestedRoot={requestedDockRoot}
            onWorkspaceRootChange={setDockWorkspaceRoot}
            onAuthorizeRoot={handleAuthorizeRoot}
            activeTab={dockTab}
            onTabChange={setDockTab}
            refreshKey={dockRefreshKey}
            diffBadgeCount={reviewFilesSummary?.source === 'git' ? reviewFilesSummary.count : 0}
            focusedDiffFile={focusedDiffFile}
            focusedFilePath={focusedFilePath}
            channel={webAccessStatus?.channel || 'loopback'}
            permissionLevel={webAccessStatus?.permissionLevel || 'L2'}
            models={models}
            activeModelId={selectedModelId}
            onInsertToComposer={handleInsertFromSideChat}
            onGitMutated={() => setGitSummaryNonce((n) => n + 1)}
          />
        }
      />

      <HostAdminModal
        open={adminOpen}
        activeTab={adminTab}
        initialSelectedPluginId={adminSelectedPluginId}
        onTabChange={setAdminTab}
        channel={webAccessStatus?.channel}
        permissionLevel={webAccessStatus?.permissionLevel}
        onClose={() => {
          setAdminOpen(false);
          setAdminSelectedPluginId(null);
          void refreshWebAccessStatus();
        }}
        onPluginsChanged={handlePluginsChanged}
        onWebSettingsUpdated={applyWebPluginSettings}
        onCommandExecuted={handleCommandExecuted}
      />

      <WriteConfirmModal
        challenge={confirmQueue[0]?.challenge ?? null}
        onConfirm={() => settleCurrentConfirm(true)}
        onCancel={() => settleCurrentConfirm(false)}
      />

      {newProjectModalOpen && (
        <Suspense fallback={null}>
          <LazyNewProjectModal
            open={newProjectModalOpen}
            groups={projectGroups}
            defaultSessionPath={defaultSessionPath || health?.defaultSessionPath}
            canAdminWorkspace={
              !webAccessStatus?.channel ||
              webAccessStatus.channel === 'loopback' ||
              webAccessStatus.permissionLevel === 'L2'
            }
            latestJobEvent={latestProjectJob}
            onClose={() => setNewProjectModalOpen(false)}
            onCreateLocalProject={handleCreateLocalProjectFromModal}
            onProjectCreated={handleProjectCreatedFromModal}
          />
        </Suspense>
      )}

      {deleteModalState && (
        <div
          className={styles.modalBackdrop}
          onClick={(ev) => {
            if (ev.target === ev.currentTarget && !deleteModalState.submitting) {
              setDeleteModalState(null);
            }
          }}
        >
          <div
            className={styles.confirmDialog}
            role="dialog"
            aria-modal="true"
            data-testid="delete-session-modal"
          >
            <h3 className={styles.confirmTitle}>
              {deleteModalState.stage === 'fallback'
                ? t('sidebarOrg.deleteModalFallbackTitle')
                : t('sidebarOrg.deleteModalTitle')}
            </h3>
            <p className={styles.confirmDesc}>
              {deleteModalState.stage === 'fallback'
                ? t('sidebarOrg.deleteModalFallbackDesc', {
                    title: formatSessionTitle(deleteModalState.session, t),
                    reason: deleteModalState.reasonCode || 'RPC_OFFLINE',
                  })
                : t('sidebarOrg.deleteModalDesc', {
                    title: formatSessionTitle(deleteModalState.session, t),
                  })}
            </p>
            {deleteModalState.session.projectName && (
              <div className={styles.confirmMeta}>
                {t('sidebarOrg.deleteModalProject', {
                  name: deleteModalState.session.projectName,
                })}
              </div>
            )}
            <div className={styles.confirmFooter}>
              <button
                type="button"
                className={styles.confirmCancelBtn}
                disabled={deleteModalState.submitting}
                data-testid="delete-session-cancel"
                onClick={() => setDeleteModalState(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className={styles.confirmDangerBtn}
                disabled={deleteModalState.submitting}
                data-testid={
                  deleteModalState.stage === 'fallback'
                    ? 'delete-session-hide-local'
                    : 'delete-session-confirm'
                }
                onClick={() =>
                  void handleConfirmDeleteSession(
                    deleteModalState.stage === 'fallback' ? 'local_hide' : 'auto',
                  )
                }
              >
                {deleteModalState.stage === 'fallback'
                  ? t('sidebarOrg.deleteModalHideLocal')
                  : t('sidebarOrg.deleteModalConfirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {sidebarToast && (
        <div className={styles.toastStack} role="status" data-testid="sidebar-toast">
          <div className={styles.toastCard}>
            <span>{sidebarToast.message}</span>
            {sidebarToast.actionLabel && sidebarToast.onAction && (
              <button
                type="button"
                className={styles.toastActionBtn}
                data-testid="sidebar-toast-action"
                onClick={sidebarToast.onAction}
              >
                {sidebarToast.actionLabel}
              </button>
            )}
            <button
              type="button"
              className={styles.toastDismissBtn}
              aria-label={t('common.close')}
              onClick={() => setSidebarToast(null)}
            >
              ×
            </button>
          </div>
        </div>
      )}

      {authLocked && (
        <div className={styles.authUnlockOverlay} role="dialog" aria-modal="true" data-testid="auth-unlock-card">
          <form
            className={styles.authUnlockCard}
            onSubmit={(ev) => {
              ev.preventDefault();
              const trimmed = unlockToken.trim();
              if (!trimmed || unlockLoading || typeof apiClient.authenticateWithToken !== 'function') return;
              setUnlockLoading(true);
              setUnlockError(null);
              void apiClient
                .authenticateWithToken(trimmed)
                .then(() => {
                  setAuthLocked(false);
                  setUnlockToken('');
                  setBannerError(null);
                  setBootstrapNonce((n) => n + 1);
                })
                .catch(() => {
                  setUnlockError(t('authUnlock.invalid'));
                })
                .finally(() => {
                  setUnlockLoading(false);
                });
            }}
          >
            <h2 className={styles.authUnlockTitle}>{t('authUnlock.title')}</h2>
            <p className={styles.authUnlockDesc}>{t('authUnlock.description')}</p>
            <input
              type="password"
              className={styles.authUnlockInput}
              value={unlockToken}
              onChange={(ev) => setUnlockToken(ev.target.value)}
              placeholder={t('authUnlock.placeholder')}
              autoFocus
              data-testid="auth-unlock-token-input"
            />
            {unlockError && (
              <div className={styles.authUnlockError} role="alert" data-testid="auth-unlock-error">
                {unlockError}
              </div>
            )}
            <button
              type="submit"
              className={styles.authUnlockSubmit}
              disabled={unlockLoading || !unlockToken.trim()}
              data-testid="auth-unlock-submit-btn"
            >
              {unlockLoading ? t('authUnlock.submitting') : t('authUnlock.submit')}
            </button>
          </form>
        </div>
      )}
      <WebPetOverlay
        petData={petData}
        onSelectSession={handleSelectSession}
        onOpenSettings={() => handleOpenAdmin('plugins', 'agy-daddy.pet')}
        onRefreshPet={refreshPet}
      />
    </>
  );
}

export default App;
