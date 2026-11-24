import type {
  ApproveStepRequest,
  ApproveStepResponse,
  ArtifactPreviewersResponse,
  ArtifactReadResponse,
  ArtifactsListResponse,
  AssignSessionProjectResponse,
  AuthorizeWorkspaceRootResponse,
  CancelSessionResponse,
  ComposerStateResponse,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  DefaultSessionPathResponse,
  DeleteEntityResponse,
  DoctorReport,
  ExportMarkdownResponse,
  FsReadResponse,
  FsTreeResponse,
  FsWriteRequest,
  FsWriteResponse,
  GitDiffResponse,
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
  SseDeltaPayload,
  SseHeartbeatPayload,
  SseHostEventPayload,
  SseResyncPayload,
  SseStatePatchPayload,
  TopbarResponse,
  UpdateProjectGroupRequest,
  UpdateProjectRequest,
} from '../types';

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

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

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

  const response = await fetch(path, {
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
  return `/api/v1/artifacts/${encodeURIComponent(sessionId)}/raw?file=${encodeURIComponent(file)}`;
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

export interface SessionStreamHandlers {
  onDelta?: (payload: SseDeltaPayload, lastEventId?: string) => void;
  onStatePatch?: (payload: SseStatePatchPayload, lastEventId?: string) => void;
  onHostEvent?: (payload: SseHostEventPayload, lastEventId?: string) => void;
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
  const url = `/api/v1/stream${buildQuery({ sessionId: sessionId || undefined })}`;
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
  getComposerState,
  optimizePrompt,
  exportSessionMarkdown,
  subscribeSessionStream,
};
