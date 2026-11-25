import type {
  AccessChannel,
  ApproveStepRequest,
  ApproveStepResponse,
  ArtifactPreviewersResponse,
  ArtifactReadResponse,
  ArtifactsListResponse,
  AssignSessionProjectResponse,
  AuthorizeWorkspaceRootResponse,
  BackgroundTaskDetailResponse,
  BackgroundTasksListResponse,
  CancelSessionResponse,
  ComposerStateResponse,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  CreateTerminalSessionRequest,
  CreateTerminalSessionResponse,
  DefaultSessionPathResponse,
  DeleteEntityResponse,
  DoctorReport,
  ExportMarkdownResponse,
  FsReadResponse,
  FsTreeResponse,
  FsWriteRequest,
  FsWriteResponse,
  GitCommitRequest,
  GitCommitResponse,
  GitDiffResponse,
  GitPushRequest,
  GitPushResponse,
  GitStageRequest,
  GitStageResponse,
  GitWorktreeMutationRequest,
  GitWorktreesResponse,
  HealthInfo,
  HostLocaleResponse,
  HostPluginAction,
  HostPluginActionResponse,
  HostPluginsResponse,
  HostSettingsResponse,
  MarkSessionReadResponse,
  ModelsResponse,
  OptimizePromptResponse,
  PinSessionResponse,
  PluginArtifactPreviewResponse,
  PluginSettingsResponse,
  ProjectGroupMutationResponse,
  ProjectMutationResponse,
  ProjectsResponse,
  RemoteStatusResponse,
  RunCommandRequest,
  RunCommandResponse,
  SendMessageRequest,
  SendMessageResponse,
  SessionDetailResponse,
  SessionEvent,
  SessionsListResponse,
  SideChatCancelResponse,
  SideChatCompletionRequest,
  SideChatDeltaEvent,
  SideChatDoneEvent,
  SideChatErrorEvent,
  SideChatMetaEvent,
  SseDeltaPayload,
  SseHeartbeatPayload,
  SseHostEventPayload,
  SseResyncPayload,
  SseStatePatchPayload,
  SseTaskUpdatedPayload,
  StopBackgroundTaskResponse,
  SwitchTicketResponse,
  TerminalCloseResponse,
  TerminalInputResponse,
  TerminalResizeResponse,
  TerminalSessionsListResponse,
  TerminalSseExitEvent,
  TerminalSseOutputEvent,
  TopbarResponse,
  UpdateProjectGroupRequest,
  UpdateProjectRequest,
  WebAccessStatusResponse,
  WebAuthResponse,
} from '../types';

export function getAppBasePrefix(
  pathname = typeof window !== 'undefined' ? window.location.pathname : '/',
): string {
  return pathname === '/pc' || pathname.startsWith('/pc/') ? '/pc' : '';
}

export function resolveApiUrl(logicalPath: string): string {
  const prefix = getAppBasePrefix();
  if (!prefix || !logicalPath.startsWith('/')) return logicalPath;
  if (logicalPath === '/pc' || logicalPath.startsWith('/pc/')) return logicalPath;
  return `${prefix}${logicalPath}`;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly payload?: unknown;

  constructor(message: string, status: number, code = 'API_ERROR', payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

const CSRF_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const CONFIRM_REFRESH_THRESHOLD_MS = 45_000;

export interface WriteConfirmChallenge {
  action: string;
  channel: string;
  confirmToken: string;
  confirmHint?: string;
  method: string;
  path: string;
}

export type ConfirmWriteHandler = (challenge: WriteConfirmChallenge) => Promise<boolean>;

let confirmWriteHandler: ConfirmWriteHandler | null = null;

export function setConfirmWriteHandler(handler: ConfirmWriteHandler | null): void {
  confirmWriteHandler = handler;
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  interactiveConfirm?: boolean;
  confirmToken?: string;
  onConfirmTokenRenewed?: (token: string) => void;
  _isConfirmRetry?: boolean;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  if (options.confirmToken && !headers['X-Agy-Confirm']) {
    headers['X-Agy-Confirm'] = options.confirmToken;
  }

  if (CSRF_METHODS.has(method)) {
    headers['X-Agy-Csrf'] = '1';
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  } else if (method === 'POST' || method === 'PUT') {
    headers['Content-Type'] = 'application/json';
    body = '{}';
  }

  const response = await fetch(resolveApiUrl(path), {
    method,
    credentials: 'same-origin',
    headers,
    body,
    signal: options.signal,
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { ok: false, error: text };
    }
  }

  const dataObj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;

  // Writes on the Cloudflare channel are challenged with an action-bound
  // confirm token and require explicit user confirmation before retrying.
  const confirmToken =
    response.status === 403 && dataObj?.error === 'CONFIRMATION_REQUIRED'
      ? dataObj.confirmToken
      : null;
  const canPromptConfirm = !options._isConfirmRetry && (!options.headers?.['X-Agy-Confirm']);
  if (
    typeof confirmToken === 'string' &&
    confirmToken &&
    canPromptConfirm &&
    options.interactiveConfirm !== false &&
    confirmWriteHandler
  ) {
    const challengedAt = Date.now();
    const action =
      typeof dataObj?.action === 'string' && dataObj.action
        ? dataObj.action
        : `${method} ${path.split('?')[0]}`;
    const challenge: WriteConfirmChallenge = {
      action,
      channel: typeof dataObj?.channel === 'string' && dataObj.channel ? dataObj.channel : 'cloudflare',
      confirmToken,
      confirmHint: typeof dataObj?.confirmHint === 'string' ? dataObj.confirmHint : undefined,
      method,
      path,
    };
    const approved = await confirmWriteHandler(challenge);
    if (!approved) {
      throw new ApiError('CONFIRMATION_CANCELLED', 403, 'CONFIRMATION_CANCELLED', parsed);
    }

    let tokenToUse = confirmToken;
    if (Date.now() - challengedAt > CONFIRM_REFRESH_THRESHOLD_MS && action) {
      try {
        const refreshed = await apiRequest<{ ok: boolean; confirmToken?: string }>(
          '/api/v1/confirm',
          {
            method: 'POST',
            body: { action },
            signal: options.signal,
          },
        );
        if (typeof refreshed?.confirmToken === 'string' && refreshed.confirmToken) {
          tokenToUse = refreshed.confirmToken;
        }
      } catch {
        // Fall back to original token if minting refresh fails
      }
    }

    options.onConfirmTokenRenewed?.(tokenToUse);

    return apiRequest<T>(path, {
      ...options,
      confirmToken: undefined,
      _isConfirmRetry: true,
      headers: { ...(options.headers || {}), 'X-Agy-Confirm': tokenToUse },
    });
  }

  if (!response.ok || dataObj?.ok === false) {
    const code = typeof dataObj?.error === 'string' ? dataObj.error : `HTTP_${response.status}`;
    const msg = typeof dataObj?.message === 'string' ? dataObj.message : code;
    throw new ApiError(msg, response.status, code, parsed);
  }

  return (parsed ?? { ok: true }) as T;
}

function buildQuery(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      search.set(k, String(v));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export function getHealth(signal?: AbortSignal): Promise<HealthInfo> {
  return apiRequest<HealthInfo>('/api/v1/health', { signal });
}

export interface ListSessionsOptions {
  limit?: number;
  projectId?: string;
  includeInternal?: boolean;
}

export function listSessions(limit?: number, signal?: AbortSignal): Promise<SessionsListResponse>;
export function listSessions(opts?: ListSessionsOptions, signal?: AbortSignal): Promise<SessionsListResponse>;
export function listSessions(
  optsOrLimit: number | ListSessionsOptions = 50,
  signal?: AbortSignal,
): Promise<SessionsListResponse> {
  const opts: ListSessionsOptions =
    typeof optsOrLimit === 'number' ? { limit: optsOrLimit } : optsOrLimit || {};
  const limit = opts.limit ?? 50;
  return apiRequest<SessionsListResponse>(
    `/api/v1/sessions${buildQuery({
      limit,
      projectId: opts.projectId,
      includeInternal: opts.includeInternal === true ? 1 : undefined,
    })}`,
    { signal },
  );
}

export function markSessionRead(
  cascadeId: string,
  payload?: { lastReadStepCount?: number; lastReadAt?: string },
): Promise<MarkSessionReadResponse> {
  return apiRequest<MarkSessionReadResponse>(
    `/api/v1/sessions/${encodeURIComponent(cascadeId)}/read`,
    {
      method: 'PUT',
      body: payload ?? {},
      interactiveConfirm: false,
    },
  );
}

export function createSession(req: CreateSessionRequest = {}): Promise<CreateSessionResponse> {
  return apiRequest<CreateSessionResponse>('/api/v1/sessions', {
    method: 'POST',
    body: req,
  });
}

export function pinSession(cascadeId: string, pinned: boolean): Promise<PinSessionResponse> {
  return apiRequest<PinSessionResponse>(`/api/v1/sessions/${encodeURIComponent(cascadeId)}/pin`, {
    method: 'PUT',
    body: { pinned },
  });
}

export function assignSessionProject(
  cascadeId: string,
  projectId: string | null,
): Promise<AssignSessionProjectResponse> {
  return apiRequest<AssignSessionProjectResponse>(
    `/api/v1/sessions/${encodeURIComponent(cascadeId)}/project`,
    {
      method: 'PUT',
      body: { projectId },
    },
  );
}

export function listProjects(signal?: AbortSignal): Promise<ProjectsResponse> {
  return apiRequest<ProjectsResponse>('/api/v1/projects', { signal });
}

export function createProject(payload: CreateProjectRequest): Promise<ProjectMutationResponse> {
  return apiRequest<ProjectMutationResponse>('/api/v1/projects', {
    method: 'POST',
    body: payload,
  });
}

export function updateProject(
  id: string,
  patch: UpdateProjectRequest,
): Promise<ProjectMutationResponse> {
  return apiRequest<ProjectMutationResponse>(`/api/v1/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

export function deleteProject(id: string): Promise<DeleteEntityResponse> {
  return apiRequest<DeleteEntityResponse>(`/api/v1/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function createProjectGroup(name: string): Promise<ProjectGroupMutationResponse> {
  return apiRequest<ProjectGroupMutationResponse>('/api/v1/project-groups', {
    method: 'POST',
    body: { name },
  });
}

export function updateProjectGroup(
  id: string,
  patch: UpdateProjectGroupRequest,
): Promise<ProjectGroupMutationResponse> {
  return apiRequest<ProjectGroupMutationResponse>(
    `/api/v1/project-groups/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: patch,
    },
  );
}

export function deleteProjectGroup(id: string): Promise<DeleteEntityResponse> {
  return apiRequest<DeleteEntityResponse>(`/api/v1/project-groups/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export function setDefaultSessionPath(
  defaultSessionPath: string,
): Promise<DefaultSessionPathResponse> {
  return apiRequest<DefaultSessionPathResponse>('/api/v1/workspace/default-path', {
    method: 'PUT',
    body: { defaultSessionPath },
  });
}

export function authorizeWorkspaceRoot(root: string): Promise<AuthorizeWorkspaceRootResponse> {
  return apiRequest<AuthorizeWorkspaceRootResponse>('/api/v1/workspace/authorize-root', {
    method: 'POST',
    body: { root },
  });
}

export function getSessionDetail(sessionId: string, signal?: AbortSignal): Promise<SessionDetailResponse> {
  return apiRequest<SessionDetailResponse>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { signal });
}

export function sendMessage(sessionId: string, req: SendMessageRequest): Promise<SendMessageResponse> {
  return apiRequest<SendMessageResponse>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST',
    body: req,
  });
}

export function cancelSession(sessionId: string): Promise<CancelSessionResponse> {
  return apiRequest<CancelSessionResponse>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: 'POST',
    body: {},
  });
}

export function approveStep(
  sessionId: string,
  stepIdx: number,
  req: ApproveStepRequest,
): Promise<ApproveStepResponse> {
  return apiRequest<ApproveStepResponse>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/steps/${stepIdx}/approve`,
    {
      method: 'POST',
      body: req,
    },
  );
}

export function listModels(signal?: AbortSignal): Promise<ModelsResponse> {
  return apiRequest<ModelsResponse>('/api/v1/models', { signal });
}

export function getFsTree(
  params: { root: string; path?: string; depth?: number },
  signal?: AbortSignal,
): Promise<FsTreeResponse> {
  return apiRequest<FsTreeResponse>(
    `/api/v1/fs/tree${buildQuery({ root: params.root, path: params.path, depth: params.depth })}`,
    { signal },
  );
}

export function readFsFile(
  params: { root: string; path: string },
  signal?: AbortSignal,
): Promise<FsReadResponse> {
  return apiRequest<FsReadResponse>(
    `/api/v1/fs/read${buildQuery({ root: params.root, path: params.path })}`,
    { signal },
  );
}

export function writeFsFile(req: FsWriteRequest): Promise<FsWriteResponse> {
  return apiRequest<FsWriteResponse>('/api/v1/fs/write', {
    method: 'PUT',
    body: req,
  });
}

export function getGitDiff(
  params: { root: string; path?: string },
  signal?: AbortSignal,
): Promise<GitDiffResponse> {
  return apiRequest<GitDiffResponse>(
    `/api/v1/git/diff${buildQuery({ root: params.root, path: params.path })}`,
    { signal },
  );
}

export function getGitWorktrees(
  params: { root: string },
  signal?: AbortSignal,
): Promise<GitWorktreesResponse> {
  return apiRequest<GitWorktreesResponse>(
    `/api/v1/git/worktrees${buildQuery({ root: params.root })}`,
    { signal },
  );
}

export function gitStage(req: GitStageRequest): Promise<GitStageResponse> {
  return apiRequest<GitStageResponse>('/api/v1/git/stage', {
    method: 'POST',
    body: req,
  });
}

export function gitCommit(req: GitCommitRequest): Promise<GitCommitResponse> {
  return apiRequest<GitCommitResponse>('/api/v1/git/commit', {
    method: 'POST',
    body: req,
  });
}

export function gitPush(req: GitPushRequest): Promise<GitPushResponse> {
  return apiRequest<GitPushResponse>('/api/v1/git/push', {
    method: 'POST',
    body: req,
  });
}

export function gitWorktree(req: GitWorktreeMutationRequest): Promise<GitWorktreesResponse> {
  return apiRequest<GitWorktreesResponse>('/api/v1/git/worktree', {
    method: 'POST',
    body: req,
  });
}

export function listArtifacts(sessionId: string, signal?: AbortSignal): Promise<ArtifactsListResponse> {
  return apiRequest<ArtifactsListResponse>(
    `/api/v1/artifacts${buildQuery({ sessionId })}`,
    { signal },
  );
}

export function readArtifact(
  sessionId: string,
  file: string,
  signal?: AbortSignal,
): Promise<ArtifactReadResponse> {
  return apiRequest<ArtifactReadResponse>(
    `/api/v1/artifacts${buildQuery({ sessionId, file })}`,
    { signal },
  );
}

export function getArtifactRawUrl(sessionId: string, file: string): string {
  return resolveApiUrl(`/api/v1/artifacts/${encodeURIComponent(sessionId)}/raw?file=${encodeURIComponent(file)}`);
}

export function listArtifactPreviewers(
  signal?: AbortSignal,
): Promise<ArtifactPreviewersResponse> {
  return apiRequest<ArtifactPreviewersResponse>('/api/v1/artifacts/previewers', { signal });
}

export function renderPluginArtifactPreview(
  sessionId: string,
  payload: { pluginId: string; file: string; mime?: string },
): Promise<PluginArtifactPreviewResponse> {
  return apiRequest<PluginArtifactPreviewResponse>(
    `/api/v1/artifacts/${encodeURIComponent(sessionId)}/plugin-preview`,
    {
      method: 'POST',
      body: payload,
    },
  );
}

export function getHostLocale(signal?: AbortSignal): Promise<HostLocaleResponse> {
  return apiRequest<HostLocaleResponse>('/api/v1/host/locale', { signal });
}

export function setHostLocale(locale: string): Promise<HostLocaleResponse> {
  return apiRequest<HostLocaleResponse>('/api/v1/host/locale', {
    method: 'PUT',
    body: { locale },
  });
}

export function getHostPlugins(signal?: AbortSignal): Promise<HostPluginsResponse>;
export function getHostPlugins(
  scope?: 'web' | 'all',
  signal?: AbortSignal,
): Promise<HostPluginsResponse>;
export function getHostPlugins(
  scopeOrSignal?: 'web' | 'all' | AbortSignal,
  maybeSignal?: AbortSignal,
): Promise<HostPluginsResponse> {
  const scope = typeof scopeOrSignal === 'string' ? scopeOrSignal : undefined;
  const signal = typeof scopeOrSignal === 'string' ? maybeSignal : scopeOrSignal;
  return apiRequest<HostPluginsResponse>(`/api/v1/host/plugins${buildQuery({ scope })}`, { signal });
}

export function runHostPluginAction(
  pluginId: string,
  action: HostPluginAction,
  body: Record<string, unknown> = {},
): Promise<HostPluginActionResponse> {
  return apiRequest<HostPluginActionResponse>(
    `/api/v1/host/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(action)}`,
    {
      method: 'POST',
      body,
    },
  );
}

export function getHostSettings(signal?: AbortSignal): Promise<HostSettingsResponse> {
  return apiRequest<HostSettingsResponse>('/api/v1/host/settings', { signal });
}

export function saveHostSettings(patch: Record<string, unknown>): Promise<HostSettingsResponse> {
  return apiRequest<HostSettingsResponse>('/api/v1/host/settings', {
    method: 'PUT',
    body: { patch },
  });
}

export function getPluginSettings(
  pluginId: string,
  signal?: AbortSignal,
): Promise<PluginSettingsResponse>;
export function getPluginSettings(
  pluginId: string,
  scope?: 'web' | 'all',
  signal?: AbortSignal,
): Promise<PluginSettingsResponse>;
export function getPluginSettings(
  pluginId: string,
  scopeOrSignal?: 'web' | 'all' | AbortSignal,
  maybeSignal?: AbortSignal,
): Promise<PluginSettingsResponse> {
  const scope = typeof scopeOrSignal === 'string' ? scopeOrSignal : undefined;
  const signal = typeof scopeOrSignal === 'string' ? maybeSignal : scopeOrSignal;
  return apiRequest<PluginSettingsResponse>(
    `/api/v1/host/plugins/${encodeURIComponent(pluginId)}/settings${buildQuery({ scope })}`,
    { signal },
  );
}

export function savePluginSettings(
  pluginId: string,
  patch: Record<string, unknown>,
): Promise<PluginSettingsResponse> {
  return apiRequest<PluginSettingsResponse>(
    `/api/v1/host/plugins/${encodeURIComponent(pluginId)}/settings`,
    {
      method: 'PUT',
      body: { patch },
    },
  );
}

export function runHostCommand(cmdId: string, req: RunCommandRequest = {}): Promise<RunCommandResponse> {
  return apiRequest<RunCommandResponse>(`/api/v1/host/commands/${encodeURIComponent(cmdId)}`, {
    method: 'POST',
    body: req,
  });
}

export function getHostDoctor(signal?: AbortSignal): Promise<DoctorReport> {
  return apiRequest<DoctorReport>('/api/v1/host/doctor', { signal });
}

export function getTopbar(signal?: AbortSignal): Promise<TopbarResponse> {
  return apiRequest<TopbarResponse>('/api/v1/topbar', { signal });
}

export function getRemoteStatus(signal?: AbortSignal): Promise<RemoteStatusResponse> {
  return apiRequest<RemoteStatusResponse>('/api/v1/remote/status', { signal });
}

export function getWebAccessStatus(signal?: AbortSignal): Promise<WebAccessStatusResponse> {
  return apiRequest<WebAccessStatusResponse>('/api/v1/web/status', { signal });
}

export function createChannelSwitchTicket(
  targetChannel: AccessChannel,
  sessionId?: string | null,
): Promise<SwitchTicketResponse> {
  return apiRequest<SwitchTicketResponse>('/api/v1/web/switch-ticket', {
    method: 'POST',
    body: {
      targetChannel,
      ...(sessionId ? { sessionId } : {}),
    },
  });
}

export function authenticateWithToken(token: string): Promise<WebAuthResponse> {
  return apiRequest<WebAuthResponse>('/api/v1/web/auth', {
    method: 'POST',
    body: { token },
  });
}

export async function probeChannelPing(
  probeUrl: string,
  timeoutMs = 2000,
): Promise<{ state: 'ok' | 'timeout' | 'unreachable'; rttMs?: number }> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  try {
    const sep = probeUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${probeUrl}${sep}_=${Date.now()}`, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    const end = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!res.ok) {
      return { state: 'unreachable' };
    }
    return {
      state: 'ok',
      rttMs: Math.max(1, Math.round(end - start)),
    };
  } catch (err) {
    const isAbort =
      controller.signal.aborted ||
      (err instanceof Error && err.name === 'AbortError');
    return { state: isAbort ? 'timeout' : 'unreachable' };
  } finally {
    globalThis.clearTimeout(timer);
  }
}

export async function copyTextWithFallback(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback for non-secure HTTP LAN contexts
  }
  if (typeof document === 'undefined' || !document.body) return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  let copied = false;
  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
  } catch {
    copied = false;
  } finally {
    textarea.remove();
  }
  return copied;
}

export interface SessionStreamHandlers {
  onDelta?: (payload: SseDeltaPayload, lastEventId?: string) => void;
  onStatePatch?: (payload: SseStatePatchPayload, lastEventId?: string) => void;
  onHostEvent?: (payload: SseHostEventPayload, lastEventId?: string) => void;
  onTaskUpdated?: (payload: SseTaskUpdatedPayload, lastEventId?: string) => void;
  onResync?: (payload: SseResyncPayload) => void;
  onHeartbeat?: (payload: SseHeartbeatPayload) => void;
  onOpen?: () => void;
  onError?: (event: Event) => void;
}

function parseSseJson<T>(event: Event): T | null {
  const msg = event as MessageEvent<string>;
  if (typeof msg.data !== 'string' || !msg.data) return null;
  try {
    return JSON.parse(msg.data) as T;
  } catch {
    return null;
  }
}

export function subscribeSessionStream(
  sessionId: string | null | undefined,
  handlers: SessionStreamHandlers,
): () => void {
  const url = resolveApiUrl(`/api/v1/stream${buildQuery({ sessionId: sessionId || undefined })}`);
  const es = new EventSource(url, { withCredentials: true });

  if (handlers.onOpen) {
    es.addEventListener('open', () => handlers.onOpen?.());
  }
  if (handlers.onError) {
    es.addEventListener('error', (ev) => handlers.onError?.(ev));
  }

  es.addEventListener('session.delta', (ev) => {
    const payload = parseSseJson<SseDeltaPayload>(ev);
    if (payload) handlers.onDelta?.(payload, (ev as MessageEvent).lastEventId);
  });

  es.addEventListener('state.patch', (ev) => {
    const payload = parseSseJson<SseStatePatchPayload>(ev);
    if (payload) handlers.onStatePatch?.(payload, (ev as MessageEvent).lastEventId);
  });

  es.addEventListener('host.event', (ev) => {
    const payload = parseSseJson<SseHostEventPayload>(ev);
    if (payload) handlers.onHostEvent?.(payload, (ev as MessageEvent).lastEventId);
  });

  es.addEventListener('task.updated', (ev) => {
    const payload = parseSseJson<SseTaskUpdatedPayload>(ev);
    if (payload) handlers.onTaskUpdated?.(payload, (ev as MessageEvent).lastEventId);
  });

  es.addEventListener('session.resync', (ev) => {
    const payload = parseSseJson<SseResyncPayload>(ev);
    if (payload) handlers.onResync?.(payload);
  });

  es.addEventListener('heartbeat', (ev) => {
    const payload = parseSseJson<SseHeartbeatPayload>(ev);
    if (payload) handlers.onHeartbeat?.(payload);
  });

  return () => {
    es.close();
  };
}

export function getComposerState(signal?: AbortSignal): Promise<ComposerStateResponse> {
  return apiRequest<ComposerStateResponse>('/api/v1/composer/state', { signal });
}

export function optimizePrompt(text: string): Promise<OptimizePromptResponse> {
  return apiRequest<OptimizePromptResponse>('/api/v1/composer/optimize', {
    method: 'POST',
    body: { text },
  });
}

export function exportSessionMarkdown(
  cascadeId: string,
  title?: string,
  events?: SessionEvent[],
): Promise<ExportMarkdownResponse> {
  return apiRequest<ExportMarkdownResponse>('/api/v1/composer/export', {
    method: 'POST',
    body: { cascadeId, title, events },
  });
}

export function listTerminalSessions(signal?: AbortSignal): Promise<TerminalSessionsListResponse> {
  return apiRequest<TerminalSessionsListResponse>('/api/v1/terminal/sessions', { signal });
}

export function createTerminalSession(
  req: CreateTerminalSessionRequest = {},
): Promise<CreateTerminalSessionResponse> {
  return apiRequest<CreateTerminalSessionResponse>('/api/v1/terminal/sessions', {
    method: 'POST',
    body: req,
  });
}

export interface TerminalStreamHandlers {
  afterSeq?: number;
  onOutput?: (payload: TerminalSseOutputEvent, lastEventId?: string) => void;
  onExit?: (payload: TerminalSseExitEvent) => void;
  onOpen?: () => void;
  onError?: (event: Event) => void;
}

export function subscribeTerminalStream(
  sessionId: string,
  handlers: TerminalStreamHandlers,
): () => void {
  const query = buildQuery({ afterSeq: handlers.afterSeq });
  const url = resolveApiUrl(`/api/v1/terminal/sessions/${encodeURIComponent(sessionId)}/stream${query}`);
  const es = new EventSource(url, { withCredentials: true });

  if (handlers.onOpen) {
    es.addEventListener('open', () => handlers.onOpen?.());
  }
  if (handlers.onError) {
    es.addEventListener('error', (ev) => handlers.onError?.(ev));
  }
  es.addEventListener('pty.output', (ev) => {
    const payload = parseSseJson<TerminalSseOutputEvent>(ev);
    if (payload) handlers.onOutput?.(payload, (ev as MessageEvent).lastEventId);
  });
  es.addEventListener('pty.exit', (ev) => {
    const payload = parseSseJson<TerminalSseExitEvent>(ev);
    if (payload) handlers.onExit?.(payload);
  });

  return () => {
    es.close();
  };
}

export function sendTerminalInput(
  sessionId: string,
  data: string,
  opts?: { confirmToken?: string; onConfirmTokenRenewed?: (token: string) => void },
): Promise<TerminalInputResponse> {
  return apiRequest<TerminalInputResponse>(
    `/api/v1/terminal/sessions/${encodeURIComponent(sessionId)}/input`,
    {
      method: 'POST',
      body: { data },
      confirmToken: opts?.confirmToken,
      onConfirmTokenRenewed: opts?.onConfirmTokenRenewed,
    },
  );
}

export function resizeTerminalSession(
  sessionId: string,
  cols: number,
  rows: number,
  opts?: { confirmToken?: string; onConfirmTokenRenewed?: (token: string) => void },
): Promise<TerminalResizeResponse> {
  return apiRequest<TerminalResizeResponse>(
    `/api/v1/terminal/sessions/${encodeURIComponent(sessionId)}/resize`,
    {
      method: 'POST',
      body: { cols, rows },
      confirmToken: opts?.confirmToken,
      onConfirmTokenRenewed: opts?.onConfirmTokenRenewed,
    },
  );
}

export function closeTerminalSession(sessionId: string): Promise<TerminalCloseResponse> {
  return apiRequest<TerminalCloseResponse>(
    `/api/v1/terminal/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE' },
  );
}

export interface SideChatStreamHandlers {
  signal?: AbortSignal;
  onMeta?: (payload: SideChatMetaEvent) => void;
  onDelta?: (payload: SideChatDeltaEvent) => void;
  onDone?: (payload: SideChatDoneEvent) => void;
  onError?: (payload: SideChatErrorEvent) => void;
}

export async function streamSideChatCompletion(
  req: SideChatCompletionRequest,
  handlers: SideChatStreamHandlers,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const path = '/api/v1/side-chat/completions';
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'X-Agy-Csrf': '1',
    ...extraHeaders,
  };

  const response = await fetch(resolveApiUrl(path), {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify(req),
    signal: handlers.signal,
  });

  if (!response.ok) {
    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = JSON.parse(text);
      if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    const confirmToken =
      response.status === 403 && parsed?.error === 'CONFIRMATION_REQUIRED'
        ? parsed.confirmToken
        : null;
    if (
      typeof confirmToken === 'string' &&
      confirmToken &&
      !headers['X-Agy-Confirm'] &&
      confirmWriteHandler
    ) {
      const challenge: WriteConfirmChallenge = {
        action: typeof parsed?.action === 'string' && parsed.action ? parsed.action : `POST ${path}`,
        channel: typeof parsed?.channel === 'string' && parsed.channel ? parsed.channel : 'cloudflare',
        confirmToken,
        confirmHint: typeof parsed?.confirmHint === 'string' ? parsed.confirmHint : undefined,
        method: 'POST',
        path,
      };
      const approved = await confirmWriteHandler(challenge);
      if (!approved) {
        throw new ApiError('CONFIRMATION_CANCELLED', 403, 'CONFIRMATION_CANCELLED', parsed);
      }
      return streamSideChatCompletion(req, handlers, {
        ...extraHeaders,
        'X-Agy-Confirm': confirmToken,
      });
    }

    const code = typeof parsed?.error === 'string' ? parsed.error : `HTTP_${response.status}`;
    const msg = typeof parsed?.message === 'string' ? parsed.message : code;
    throw new ApiError(msg, response.status, code, parsed);
  }

  const processBlock = (rawBlock: string) => {
    const lines = rawBlock.split('\n').filter((l) => l && !l.startsWith(':'));
    if (lines.length === 0) return;
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const rawData = dataLines.join('\n');
    if (!rawData) return;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return;
    }
    if (eventName === 'meta' && parsed) handlers.onMeta?.(parsed as SideChatMetaEvent);
    else if (eventName === 'delta' && parsed) handlers.onDelta?.(parsed as SideChatDeltaEvent);
    else if (eventName === 'done' && parsed) handlers.onDone?.(parsed as SideChatDoneEvent);
    else if (eventName === 'error' && parsed) handlers.onError?.(parsed as SideChatErrorEvent);
  };

  if (!response.body) {
    const full = await response.text();
    for (const block of full.split('\n\n')) processBlock(block);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        processBlock(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const block of buffer.split('\n\n')) processBlock(block);
    }
  } finally {
    reader.releaseLock?.();
  }
}

export function cancelSideChat(requestId: string): Promise<SideChatCancelResponse> {
  return apiRequest<SideChatCancelResponse>('/api/v1/side-chat/cancel', {
    method: 'POST',
    body: { requestId },
    interactiveConfirm: false,
  });
}

export function listBackgroundTasks(signal?: AbortSignal): Promise<BackgroundTasksListResponse> {
  return apiRequest<BackgroundTasksListResponse>('/api/v1/tasks', { signal });
}

export function getBackgroundTaskDetail(
  taskId: string,
  signal?: AbortSignal,
): Promise<BackgroundTaskDetailResponse> {
  return apiRequest<BackgroundTaskDetailResponse>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}`,
    { signal },
  );
}

export function stopBackgroundTask(taskId: string): Promise<StopBackgroundTaskResponse> {
  return apiRequest<StopBackgroundTaskResponse>(
    `/api/v1/tasks/${encodeURIComponent(taskId)}/stop`,
    {
      method: 'POST',
      body: {},
    },
  );
}

export const apiClient = {
  getHealth,
  listSessions,
  markSessionRead,
  createSession,
  pinSession,
  assignSessionProject,
  listProjects,
  createProject,
  updateProject,
  deleteProject,
  createProjectGroup,
  updateProjectGroup,
  deleteProjectGroup,
  setDefaultSessionPath,
  authorizeWorkspaceRoot,
  getSessionDetail,
  sendMessage,
  cancelSession,
  approveStep,
  listModels,
  getFsTree,
  readFsFile,
  writeFsFile,
  getGitDiff,
  getGitWorktrees,
  gitStage,
  gitCommit,
  gitPush,
  gitWorktree,
  listArtifacts,
  readArtifact,
  getArtifactRawUrl,
  listArtifactPreviewers,
  renderPluginArtifactPreview,
  getHostLocale,
  setHostLocale,
  getHostPlugins,
  runHostPluginAction,
  getHostSettings,
  saveHostSettings,
  getPluginSettings,
  savePluginSettings,
  runHostCommand,
  getHostDoctor,
  getTopbar,
  getRemoteStatus,
  getWebAccessStatus,
  createChannelSwitchTicket,
  authenticateWithToken,
  probeChannelPing,
  copyTextWithFallback,
  getAppBasePrefix,
  resolveApiUrl,
  getComposerState,
  optimizePrompt,
  exportSessionMarkdown,
  subscribeSessionStream,
  listTerminalSessions,
  createTerminalSession,
  subscribeTerminalStream,
  sendTerminalInput,
  resizeTerminalSession,
  closeTerminalSession,
  streamSideChatCompletion,
  cancelSideChat,
  listBackgroundTasks,
  getBackgroundTaskDetail,
  stopBackgroundTask,
  setConfirmWriteHandler,
};
