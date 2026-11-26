import { createTranslator, LOCALE_STORAGE_KEY, normalizeLocale } from '../i18n';
import type {
  ArchiveSessionRequest,
  ArchiveSessionResponse,
  ArtifactItem,
  ArchivedSessionMeta,
  BackgroundTaskDetailDto,
  BackgroundTasksListResponse,
  BootstrapResponse,
  CancelRemoteJobResponse,
  ChannelsListResponse,
  ChatMode,
  ComposerStateResponse,
  DeleteSessionResponse,
  DiagnosticsResponse,
  DispatchMode,
  FsTreeEntry,
  GetRemoteJobResponse,
  GitDiffResponse,
  GithubReposResponse,
  GitWorktreeInfo,
  HostProject,
  LocaleResponse,
  OrchestratorMasterKey,
  OrchestratorThinkingMap,
  OrchestratorThinkingTier,
  OrgReorderRequest,
  OrgReorderResponse,
  PinKind,
  ProjectRemoteMeta,
  PtySessionInfo,
  QueuedMessage,
  RedeemTicketResponse,
  RemotePreflightResponse,
  SafeCommandsResponse,
  SessionDetail,
  SessionEvent,
  SessionGroup,
  SessionOrderMap,
  SessionOrgSnapshot,
  SessionPins,
  SessionSummary,
  StartRemoteJobRequest,
  StartRemoteJobResponse,
  StopBackgroundTaskResponse,
  SupportedLocale,
  SwitchTicketResponse,
  TelemetryPanels,
  WorkspaceBrowseResponse,
  WorkspaceMkdirResponse,
  ZoneOrder
} from '../types';
import { getClientId, getDeviceHint } from './token';

export interface ApiError extends Error {
  status?: number;
  code?: string;
  confirmHint?: string;
  reasonCode?: string;
  canFallbackLocalHide?: boolean;
  data?: Record<string, unknown>;
}

export type ConfirmCallback = (hint: string) => Promise<boolean>;

const API_ORIGIN_KEY = 'agy_remote_api_origin';

let tokenProvider: () => string = () => '';
let confirmCallback: ConfirmCallback = async () => false;
let lastConfirmedToken = '';
let apiBaseOrigin = '';

try {
  if (typeof window !== 'undefined') {
    const saved = window.sessionStorage?.getItem(API_ORIGIN_KEY) || '';
    if (saved) apiBaseOrigin = saved.replace(/\/+$/, '');
  }
} catch {}

export function setApiBaseOrigin(origin: string): void {
  apiBaseOrigin = String(origin || '').trim().replace(/\/+$/, '');
  try {
    if (typeof window !== 'undefined') {
      if (apiBaseOrigin) window.sessionStorage?.setItem(API_ORIGIN_KEY, apiBaseOrigin);
      else window.sessionStorage?.removeItem(API_ORIGIN_KEY);
    }
  } catch {}
}

export function getApiBaseOrigin(): string {
  return apiBaseOrigin;
}

export function resolveApiUrl(path: string): string {
  if (!path.startsWith('/')) return path;
  if (!apiBaseOrigin) return path;
  try {
    if (typeof window !== 'undefined' && window.location?.origin === apiBaseOrigin) {
      return path;
    }
  } catch {}
  return `${apiBaseOrigin}${path}`;
}

export function configureApiClient(opts: {
  getToken: () => string;
  onConfirmRequired: ConfirmCallback;
}): void {
  tokenProvider = opts.getToken;
  confirmCallback = opts.onConfirmRequired;
}

export function getLastL2ConfirmToken(): string {
  return lastConfirmedToken;
}

async function requestJson<T>(
  path: string,
  init: RequestInit & { confirmable?: boolean; skipAuth?: boolean } = {}
): Promise<T> {
  const token = init.skipAuth ? '' : tokenProvider();
  const headers = new Headers(init.headers || {});
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  headers.set('X-AG-Client-Id', getClientId());
  headers.set('X-AG-Device-Hint', getDeviceHint());
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const targetUrl = resolveApiUrl(path);

  const doFetch = async (extraConfirm?: string) => {
    const reqHeaders = new Headers(headers);
    if (extraConfirm) {
      reqHeaders.set('X-Agy-Confirm', extraConfirm);
    }
    const res = await fetch(targetUrl, { ...init, headers: reqHeaders, cache: 'no-store' });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      data = {};
    }
    return { res, data };
  };

  let { res, data } = await doFetch();

  if (
    res.status === 403 &&
    data.error === 'CONFIRMATION_REQUIRED' &&
    init.confirmable !== false
  ) {
    const fallbackConfirmHint = (() => {
      const stored =
        typeof window !== 'undefined'
          ? normalizeLocale(window.localStorage?.getItem(LOCALE_STORAGE_KEY))
          : null;
      return createTranslator(stored || 'zh-CN')('store.l2ConfirmHint');
    })();
    const hint =
      typeof data.confirmHint === 'string' && data.confirmHint
        ? data.confirmHint
        : fallbackConfirmHint;
    const approved = await confirmCallback(hint);
    if (approved) {
      const confirmToken =
        typeof data.confirmToken === 'string' && data.confirmToken
          ? data.confirmToken
          : 'confirmed';
      lastConfirmedToken = confirmToken;
      ({ res, data } = await doFetch(confirmToken));
    }
  }

  if (!res.ok || data.ok === false) {
    const err = new Error(
      typeof data.message === 'string' && data.message
        ? data.message
        : typeof data.error === 'string'
          ? data.error
          : `HTTP_${res.status}`
    ) as ApiError;
    err.status = res.status;
    err.code = typeof data.error === 'string' ? data.error : `HTTP_${res.status}`;
    if (typeof data.confirmHint === 'string') {
      err.confirmHint = data.confirmHint;
    }
    if (typeof data.reasonCode === 'string') {
      err.reasonCode = data.reasonCode;
    }
    if (typeof data.canFallbackLocalHide === 'boolean') {
      err.canFallbackLocalHide = data.canFallbackLocalHide;
    }
    err.data = data;
    throw err;
  }

  return data as unknown as T;
}

export const api = {
  bootstrap: () => requestJson<BootstrapResponse>('/api/v1/bootstrap'),

  snapshotFallback: () =>
    requestJson<{ ok?: boolean; panels?: TelemetryPanels; channel?: string }>('/api/snapshot'),

  listSessions: (opts?: { limit?: number; includeSubagents?: boolean; includeArchived?: boolean }) => {
    const params = new URLSearchParams();
    params.set('limit', String(opts?.limit ?? 200));
    if (opts?.includeSubagents) params.set('includeSubagents', 'true');
    if (opts?.includeArchived) params.set('includeArchived', 'true');
    const qs = params.toString();
    return requestJson<{
      ok: boolean;
      version?: number;
      revision?: number;
      rpcConnected?: boolean;
      offline?: boolean;
      sessions: SessionSummary[];
      groups?: SessionGroup[];
      projects?: HostProject[];
      pins?: SessionPins;
      groupOrder?: ZoneOrder;
      projectOrder?: Record<string, ZoneOrder>;
      sessionOrder?: SessionOrderMap;
      archivedCount?: number;
      archivedSessions?: Record<string, ArchivedSessionMeta>;
      defaultSessionPath?: string;
    }>(`/api/v1/sessions${qs ? `?${qs}` : ''}`);
  },

  getSessionOrg: (includeArchived = false) =>
    requestJson<SessionOrgSnapshot>(
      `/api/v1/sessions/org${includeArchived ? '?includeArchived=1' : ''}`
    ),

  toggleSessionPin: (payload: {
    type: PinKind;
    id: string;
    pinned?: boolean;
    workspaceUri?: string;
    rootPath?: string;
    projectName?: string;
  }) =>
    requestJson<{
      ok: boolean;
      type: PinKind;
      id: string;
      pinned: boolean;
      pinnedAt?: string | null;
      pins: SessionPins;
      revision?: number;
    }>('/api/v1/sessions/pin', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  mutateSessionGroups: (
    payload:
      | {
          action?: 'upsert';
          id?: string;
          name?: string;
          collapsed?: boolean;
          projectIds?: string[];
          workspaceUris?: string[];
          sessionIds?: string[];
          order?: number;
        }
      | { action: 'delete'; id: string }
      | {
          action: 'assign';
          groupId: string | null;
          projectId?: string;
          sessionId?: string;
          workspaceUri?: string;
          rootPath?: string;
        }
  ) =>
    requestJson<{
      ok: boolean;
      groups: SessionGroup[];
      pins?: SessionPins;
      revision?: number;
    }>('/api/v1/sessions/groups', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  reorderOrg: (payload: OrgReorderRequest) =>
    requestJson<OrgReorderResponse>('/api/v1/sessions/org/reorder', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  archiveSession: (cascadeId: string, payload: ArchiveSessionRequest) =>
    requestJson<ArchiveSessionResponse>(
      `/api/v1/sessions/${encodeURIComponent(cascadeId)}/archive`,
      {
        method: 'POST',
        body: JSON.stringify(payload)
      }
    ),

  deleteSession: (cascadeId: string, mode: 'auto' | 'local_hide' = 'auto') =>
    requestJson<DeleteSessionResponse>(
      `/api/v1/sessions/${encodeURIComponent(cascadeId)}?mode=${encodeURIComponent(mode)}`,
      {
        method: 'DELETE'
      }
    ),

  createProject: (payload: {
    name: string;
    rootPath: string;
    groupId?: string | null;
    createDir?: boolean;
    source?: string;
    remote?: ProjectRemoteMeta | null;
  }) =>
    requestJson<{
      ok: boolean;
      project: HostProject;
      projects?: HostProject[];
      groups?: SessionGroup[];
      pins?: SessionPins;
      revision?: number;
      defaultSessionPath?: string;
    }>('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  updateProject: (
    id: string,
    patch: {
      name?: string;
      groupId?: string | null;
      pinned?: boolean;
      workspaceUri?: string;
      rootPath?: string;
    }
  ) =>
    requestJson<{
      ok: boolean;
      project: HostProject;
      revision?: number;
    }>(`/api/v1/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    }),

  deleteProject: (id: string) =>
    requestJson<{ ok: boolean; id?: string; deleted?: boolean; revision?: number }>(
      `/api/v1/projects/${encodeURIComponent(id)}`,
      {
        method: 'DELETE'
      }
    ),

  browseWorkspace: (path?: string, showHidden = false, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (path) params.set('path', path);
    if (showHidden) params.set('showHidden', '1');
    const qs = params.toString();
    return requestJson<WorkspaceBrowseResponse>(
      `/api/v1/workspace/browse${qs ? `?${qs}` : ''}`,
      { signal }
    );
  },

  mkdirWorkspace: (parentDir: string, name: string) =>
    requestJson<WorkspaceMkdirResponse>('/api/v1/workspace/mkdir', {
      method: 'POST',
      body: JSON.stringify({ parentDir, name })
    }),

  getRemotePreflight: (
    provider: 'all' | 'github' | 'gdrive' = 'all',
    signal?: AbortSignal
  ) =>
    requestJson<RemotePreflightResponse>(
      `/api/v1/workspace/remote-preflight?provider=${encodeURIComponent(provider)}`,
      { signal }
    ),

  listGithubRepos: (owner?: string, limit = 30, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (owner) params.set('owner', owner);
    params.set('limit', String(limit));
    return requestJson<GithubReposResponse>(
      `/api/v1/workspace/github-repos?${params.toString()}`,
      { signal }
    );
  },

  startRemoteProjectJob: (payload: StartRemoteJobRequest) =>
    requestJson<StartRemoteJobResponse>('/api/v1/projects/remote-jobs', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  getRemoteProjectJob: (jobId: string, signal?: AbortSignal) =>
    requestJson<GetRemoteJobResponse>(
      `/api/v1/projects/remote-jobs/${encodeURIComponent(jobId)}`,
      { signal }
    ),

  cancelRemoteProjectJob: (jobId: string) =>
    requestJson<CancelRemoteJobResponse>(
      `/api/v1/projects/remote-jobs/${encodeURIComponent(jobId)}/cancel`,
      {
        method: 'POST',
        confirmable: false,
        body: '{}'
      }
    ),

  getSession: (id: string) =>
    requestJson<{ ok: boolean; session: SessionDetail; events: SessionEvent[] }>(
      `/api/v1/sessions/${encodeURIComponent(id)}`
    ),

  createSession: (payload: { title?: string; workspaceUri?: string }) =>
    requestJson<{ ok: boolean; cascadeId: string; session?: SessionSummary }>('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  sendMessage: (
    sessionId: string,
    payload: {
      text: string;
      modelId?: string;
      mode?: ChatMode;
      images?: Array<{ dataUrl: string; mime: string }>;
      dispatchMode?: DispatchMode;
    }
  ) =>
    requestJson<{
      ok: boolean;
      queued?: boolean;
      queueId?: string;
      item?: QueuedMessage;
      queue?: QueuedMessage[];
    }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  compactSession: (sessionId: string) =>
    requestJson<{ ok: boolean; action?: string; sessionId?: string; dispatched?: boolean }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/compact`,
      {
        method: 'POST',
        confirmable: true,
        body: '{}'
      }
    ),

  listSessionQueue: (sessionId: string) =>
    requestJson<{ ok: boolean; cascadeId: string; queue: QueuedMessage[] }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/queue`
    ),

  removeQueuedMessage: (sessionId: string, queueId: string) =>
    requestJson<{
      ok: boolean;
      removed?: boolean;
      cascadeId?: string;
      queueId?: string;
      queue?: QueuedMessage[];
    }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}`,
      {
        method: 'DELETE'
      }
    ),

  steerQueuedMessage: (sessionId: string, queueId: string) =>
    requestJson<{
      ok: boolean;
      steered?: boolean;
      cascadeId?: string;
      queueId?: string;
      queue?: QueuedMessage[];
    }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(queueId)}/steer`,
      {
        method: 'POST',
        body: '{}'
      }
    ),

  cancelSession: (sessionId: string) =>
    requestJson<{ ok: boolean }>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: 'POST',
      body: '{}'
    }),

  approveStep: (sessionId: string, seq: number, decision: 'allow' | 'deny') =>
    requestJson<{ ok: boolean; supported?: boolean }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/steps/${seq}/approve`,
      {
        method: 'POST',
        body: JSON.stringify({ decision })
      }
    ),

  answerStep: (sessionId: string, seq: number, answers: unknown) =>
    requestJson<{ ok: boolean }>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/steps/${seq}/answer`,
      {
        method: 'POST',
        body: JSON.stringify({ answers })
      }
    ),

  getPresets: () => requestJson<ComposerStateResponse>('/api/v1/composer/presets'),

  getComposerState: () => requestJson<ComposerStateResponse>('/api/v1/composer/state'),

  optimizePrompt: (text: string) =>
    requestJson<{
      ok: boolean;
      optimizedText?: string;
      text?: string;
      source?: string;
      unchanged?: boolean;
    }>('/api/v1/composer/optimize', {
      method: 'POST',
      body: JSON.stringify({ text })
    }),

  updateOrchestratorThinking: (payload: {
    master?: OrchestratorMasterKey;
    thinkingLevel?: OrchestratorThinkingTier;
    map?: Partial<OrchestratorThinkingMap>;
  }) =>
    requestJson<{ ok: boolean; orchestratorThinking: OrchestratorThinkingMap }>(
      '/api/v1/orchestrator/thinking',
      {
        method: 'POST',
        body: JSON.stringify(payload)
      }
    ),

  getGitDiff: (root: string) =>
    requestJson<GitDiffResponse>(`/api/v1/git/diff?root=${encodeURIComponent(root)}`),

  getFsTree: (root: string, path = '') =>
    requestJson<{ ok: boolean; root?: string; path?: string; entries: FsTreeEntry[] }>(
      `/api/v1/fs/tree?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
    ),

  readFsFile: (root: string, path: string) =>
    requestJson<{ ok: boolean; path: string; size?: number; truncated?: boolean; content: string }>(
      `/api/v1/fs/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`
    ),

  writeFsFile: (root: string, path: string, content: string) =>
    requestJson<{ ok: boolean; path: string; bytes?: number }>('/api/v1/fs/write', {
      method: 'PUT',
      confirmable: true,
      body: JSON.stringify({ root, path, content })
    }),

  getGitWorktrees: (root: string) =>
    requestJson<{ ok: boolean; worktrees: GitWorktreeInfo[]; current?: string }>(
      `/api/v1/git/worktrees?root=${encodeURIComponent(root)}`
    ),

  gitStage: (root: string, paths: string[], unstage = false) =>
    requestJson<{ ok: boolean }>('/api/v1/git/stage', {
      method: 'POST',
      confirmable: true,
      body: JSON.stringify({ root, paths, unstage })
    }),

  gitCommit: (root: string, message: string) =>
    requestJson<{ ok: boolean; hash?: string }>('/api/v1/git/commit', {
      method: 'POST',
      confirmable: true,
      body: JSON.stringify({ root, message })
    }),

  gitPush: (root: string, remote?: string, branch?: string) =>
    requestJson<{ ok: boolean }>('/api/v1/git/push', {
      method: 'POST',
      confirmable: true,
      body: JSON.stringify({ root, remote, branch })
    }),

  gitWorktree: (payload: {
    root: string;
    action: 'create' | 'switch' | 'remove';
    path: string;
    branch?: string;
    createBranch?: boolean;
  }) =>
    requestJson<{ ok: boolean; worktrees?: GitWorktreeInfo[] }>('/api/v1/git/worktree', {
      method: 'POST',
      confirmable: true,
      body: JSON.stringify(payload)
    }),

  listArtifacts: (sessionId: string) =>
    requestJson<{ ok: boolean; sessionId: string; items: ArtifactItem[] }>(
      `/api/v1/artifacts?sessionId=${encodeURIComponent(sessionId)}`
    ),

  readArtifact: (sessionId: string, name: string) =>
    requestJson<{ ok: boolean; name: string; mime?: string; content?: string; dataUrl?: string }>(
      `/api/v1/artifacts/${encodeURIComponent(sessionId)}/${encodeURIComponent(name)}`
    ),

  listPtySessions: () =>
    requestJson<{ ok: boolean; sessions: PtySessionInfo[] }>('/api/v1/pty/sessions'),

  listTasks: (params?: { sessionId?: string | null; project?: string | null }) => {
    const qs = new URLSearchParams();
    if (params?.sessionId?.trim()) qs.set('sessionId', params.sessionId.trim());
    if (params?.project?.trim()) qs.set('project', params.project.trim());
    const suffix = qs.toString();
    return requestJson<BackgroundTasksListResponse>(
      suffix ? `/api/v1/tasks?${suffix}` : '/api/v1/tasks'
    );
  },

  getTaskDetail: (taskId: string) =>
    requestJson<{ ok: boolean; task: BackgroundTaskDetailDto }>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}`
    ),

  stopTask: (taskId: string) =>
    requestJson<StopBackgroundTaskResponse>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}/stop`,
      {
        method: 'POST',
        confirmable: true,
        body: '{}'
      }
    ),

  getChannels: () => requestJson<ChannelsListResponse>('/api/v1/channels'),

  createSwitchTicket: (payload: {
    targetChannel: string;
    sessionId?: string | null;
    draftText?: string;
  }) =>
    requestJson<SwitchTicketResponse>('/api/v1/channels/switch-ticket', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),

  redeemSwitchTicket: (ticket: string) =>
    requestJson<RedeemTicketResponse>('/api/v1/channels/redeem-ticket', {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({ ticket })
    }),

  getLocale: () => requestJson<LocaleResponse>('/api/v1/locale'),

  setLocale: (locale: SupportedLocale) =>
    requestJson<{
      ok: boolean;
      locale: SupportedLocale;
      syncedToHost: boolean;
      localOnly: boolean;
    }>('/api/v1/locale', {
      method: 'PUT',
      body: JSON.stringify({ locale })
    }),

  getDiagnostics: () => requestJson<DiagnosticsResponse>('/api/v1/diagnostics'),

  listCommands: () => requestJson<SafeCommandsResponse>('/api/v1/commands'),

  runCommand: (commandId: string) =>
    requestJson<{ ok: boolean; commandId: string; result?: unknown }>('/api/v1/commands/run', {
      method: 'POST',
      body: JSON.stringify({ commandId })
    }),

  getVapidKey: () =>
    requestJson<{
      ok: boolean;
      publicKey?: string;
      vapidPublicKey?: string;
      enablePushNotifications?: boolean;
      enableAppBadge?: boolean;
    }>('/api/v1/push/vapid-key'),

  getPushStatus: () =>
    requestJson<{
      ok: boolean;
      available?: boolean;
      enablePushNotifications: boolean;
      enableAppBadge: boolean;
      subscriptionsCount?: number;
    }>('/api/v1/push/status'),

  subscribePush: (subscription: PushSubscriptionJSON) =>
    requestJson<{ ok: boolean }>('/api/v1/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription })
    }),

  unsubscribePush: (endpoint: string) =>
    requestJson<{ ok: boolean }>('/api/v1/push/subscribe', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint })
    }),

  testPush: () =>
    requestJson<{
      ok: boolean;
      sent?: number;
      disabled?: boolean;
      skipped?: boolean;
      reason?: string;
    }>('/api/v1/push/test', {
      method: 'POST',
      body: '{}'
    }),

  pingLatency: async (probeUrl?: string, timeoutMs = 2200): Promise<number> => {
    const target = probeUrl || resolveApiUrl('/api/ping');
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetch(target, {
        cache: 'no-store',
        signal: ctrl?.signal
      });
      if (!res.ok) throw new Error('PING_FAILED');
      const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      return Math.max(1, Math.round(t1 - t0));
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
};
