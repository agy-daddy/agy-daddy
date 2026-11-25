export interface HealthInfo {
  ok: boolean;
  rpcConnected: boolean;
  hubOrigin: string | null;
  pluginVersion: string;
  allowedRoots?: string[];
  configuredAllowedRoots?: string[];
  defaultSessionPath?: string;
}

export type SessionRunStatus =
  | 'CASCADE_RUN_STATUS_IDLE'
  | 'CASCADE_RUN_STATUS_RUNNING'
  | string;

export interface SessionWorkspaceInfo {
  workspaceFolderAbsoluteUri?: string;
  workspaceUri?: string;
  gitRootAbsoluteUri?: string;
  gitRootUri?: string;
  repository?: {
    computedName?: string;
    name?: string;
  };
  repoName?: string;
  branchName?: string;
}

export interface SessionSummary {
  cascadeId: string;
  shortId?: string;
  hasTitle?: boolean;
  titleSource?: 'annotation' | 'title' | 'summary' | 'none' | string;
  title: string;
  summary: string;
  status: SessionRunStatus;
  stepCount: number;
  lastModifiedTime: string | null;
  createdTime: string | null;
  workspaceUri: string | null;
  gitRootUri: string | null;
  repoName: string | null;
  branchName: string | null;
  workspaces: SessionWorkspaceInfo[];
  pinned?: boolean;
  pinnedAt?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  isSubagent?: boolean;
  isInternalSession?: boolean;
  parentConversationId?: string | null;
  agentName?: string | null;
  nestingDepth?: number;
  unread?: boolean;
  lastCompletedTime?: string | null;
  lastReadAt?: string | null;
  isRunning?: boolean;
}

export interface SessionsListResponse {
  ok: boolean;
  sessions: SessionSummary[];
  hiddenInternalCount?: number;
}

export type SessionListResponse = SessionsListResponse;

export interface MarkSessionReadResponse {
  ok: boolean;
  cascadeId: string;
  lastReadAt: string;
  lastReadStepCount: number;
}

export interface CreateSessionRequest {
  title?: string;
  workspaceUri?: string;
  projectId?: string | null;
  standalone?: boolean;
}

export interface CreateSessionResponse {
  ok: boolean;
  cascadeId: string;
  title?: string;
  workspaceUri?: string;
  projectId?: string | null;
}

export interface ProjectItem {
  id: string;
  name: string;
  rootPath: string;
  groupId: string | null;
  implicit?: boolean;
  syncedFromApp?: boolean;
  source?: string;
  sessionCount?: number;
  createdAt?: string;
  updatedAt?: string;
  lastModifiedTime?: string | null;
  archived?: boolean;
}

export interface ProjectGroup {
  id: string;
  name: string;
  sortOrder: number;
  collapsed: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProjectsResponse {
  ok: boolean;
  projects: ProjectItem[];
  groups: ProjectGroup[];
  defaultSessionPath: string;
}

export interface CreateProjectRequest {
  name: string;
  rootPath: string;
  groupId?: string | null;
  createDir?: boolean;
}

export interface UpdateProjectRequest {
  name?: string;
  groupId?: string | null;
  archived?: boolean;
}

export interface UpdateProjectGroupRequest {
  name?: string;
  collapsed?: boolean;
  sortOrder?: number;
}

export interface ProjectMutationResponse {
  ok: boolean;
  project?: ProjectItem;
  projects?: ProjectItem[];
  groups?: ProjectGroup[];
  defaultSessionPath?: string;
}

export interface ProjectGroupMutationResponse {
  ok: boolean;
  group?: ProjectGroup;
  projects?: ProjectItem[];
  groups?: ProjectGroup[];
}

export interface DeleteEntityResponse {
  ok: boolean;
  id?: string;
  deleted?: boolean;
}

export interface PinSessionResponse {
  ok: boolean;
  cascadeId?: string;
  pinned?: boolean;
  pinnedAt?: string | null;
}

export interface AssignSessionProjectResponse {
  ok: boolean;
  cascadeId?: string;
  projectId?: string | null;
}

export interface DefaultSessionPathResponse {
  ok: boolean;
  defaultSessionPath: string;
  allowedRoots?: string[];
}

export interface AuthorizeWorkspaceRootResponse {
  ok: boolean;
  root: string;
  allowedRoots: string[];
  configuredAllowedRoots?: string[];
  added?: boolean;
}

export type SessionEventKind =
  | 'user'
  | 'thinking_and_text'
  | 'command'
  | 'file_view'
  | 'code_action'
  | 'ask_question'
  | 'web_search'
  | 'checkpoint'
  | 'system'
  | 'tool_generic'
  | 'error';

export type SessionEventStatus =
  | 'pending'
  | 'running'
  | 'generating'
  | 'done'
  | 'error'
  | 'canceled';

export interface UserEventPayload extends Record<string, unknown> {
  items?: Array<string | { text?: string }>;
  userResponse?: string | null;
  text?: string;
  clientMessageId?: string | null;
  clientTempId?: string;
  optimistic?: boolean;
}

export interface PlannerResponsePayload extends Record<string, unknown> {
  thinking?: string;
  messageId?: string | null;
  toolCalls?: unknown[];
  thinkingDuration?: number | string | null;
  stopReason?: string | null;
  response?: string;
  modifiedResponse?: string | null;
  text?: string;
}

export interface CommandEventPayload extends Record<string, unknown> {
  commandLine?: string;
  proposedCommandLine?: string | null;
  cwd?: string | null;
  waitMsBeforeAsync?: number | null;
  blocking?: boolean | null;
  exitCode?: number | null;
  combinedOutput?: string;
  shellName?: string | null;
}

export interface FileViewPayload extends Record<string, unknown> {
  absolutePathUri?: string | null;
  startLine?: number | null;
  endLine?: number | null;
  content?: string;
  lineRangeBytes?: number | null;
  numLines?: number | null;
  numBytes?: number | null;
}

export interface CodeActionPayload extends Record<string, unknown> {
  actionSpec?: {
    description?: string;
    targetFile?: string;
    [key: string]: unknown;
  } | null;
  actionResult?: Record<string, unknown> | null;
  diffStats?: Record<string, unknown> | null;
}

export interface AskQuestionPayload extends Record<string, unknown> {
  questions?: unknown[];
  completedInteractions?: unknown[];
}

export interface WebSearchPayload extends Record<string, unknown> {
  query?: string;
  webDocuments?: unknown[];
  summary?: string;
  thirdPartyConfig?: unknown;
  searchType?: string | null;
}

export interface CheckpointPayload extends Record<string, unknown> {
  includedStepIndexEnd?: number | null;
  sessionSummary?: string;
  artifactSnapshots?: unknown[];
  capturedUserRequests?: unknown[];
  totalSubagentCount?: number;
  accumulatedSections?: unknown[];
}

export interface SystemMessagePayload extends Record<string, unknown> {
  message?: string;
  renderInfo?: unknown;
  eventType?: string | null;
}

export interface GenericToolPayload extends Record<string, unknown> {
  args?: unknown;
  result?: unknown;
}

export interface ErrorMessagePayload extends Record<string, unknown> {
  error?: unknown;
}

export interface SessionEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  seq: number;
  kind: SessionEventKind;
  status: SessionEventStatus;
  rawType: string;
  title?: string;
  payload: TPayload;
}

export interface SessionDetail {
  cascadeId: string;
  trajectoryId: string | null;
  trajectoryType: string | null;
  status: SessionRunStatus;
  numTotalSteps: number;
  source: string | null;
  metadata: Record<string, unknown> | null;
  generatorMetadata: unknown[];
}

export interface SessionDetailResponse {
  ok: boolean;
  session: SessionDetail;
  events: SessionEvent[];
}

export interface SendMessageRequest {
  text: string;
  modelId?: string;
  thinkingLevel?: string | null;
  attachments?: Array<string | { text: string }>;
}

export interface SendMessageResponse {
  ok: boolean;
  cascadeId: string;
}

export interface CancelSessionResponse {
  ok: boolean;
  cascadeId: string;
}

export interface ApproveStepRequest {
  decision: 'accept' | 'reject';
  payload?: Record<string, unknown>;
}

export interface ApproveStepResponse {
  ok: boolean;
  supported: boolean;
  error?: string;
}

export interface SseDeltaPayload {
  cascadeId: string;
  status: SessionRunStatus;
  totalSteps: number;
  stepOffset?: number;
  events: SessionEvent[];
  hasChanges?: boolean;
}

export interface SseStatePatchPayload {
  key: string;
  value: unknown;
  meta?: Record<string, unknown>;
}

export interface SseHostEventPayload {
  topic: string;
  payload: unknown;
  meta?: Record<string, unknown>;
}

export interface SseResyncPayload {
  reason: string;
  lastEventId: number;
  oldestBufferedId: number | null;
  latestEventId: number;
}

export interface SseHeartbeatPayload {
  ts: number;
}

export type ModelBadgeKind = 'new' | 'leaving_soon' | 'notice' | 'beta';

export interface ModelBadge {
  kind: ModelBadgeKind;
  labelKey: string;
  rawTitle?: string;
  description?: string;
}

export interface ModelQuotaSummary {
  remainingFraction: number;
  resetTime?: string | null;
}

export type ModelTreeLayerRole =
  | 'family'
  | 'thinking_level'
  | 'orchestrator_root'
  | 'planner_model'
  | 'executor_model'
  | 'planner_thinking';

export type ModelSelectionPayload =
  | {
      mode: 'single';
      requestedModel: string;
      modelId: string;
    }
  | {
      mode: 'orchestrator_preset';
      requestedModel: string;
      modelId: string;
      plannerFamilyId: string;
      executorFamilyId: string;
      plannerThinkingSuffix: string;
      backingModels?: Record<string, string>;
    };

export interface ModelTreeNodeBase {
  key: string;
  role: ModelTreeLayerRole;
  label: string;
  secondaryLabel?: string;
  badge?: ModelBadge;
  quota?: ModelQuotaSummary | null;
  disabled?: boolean;
  isRecommended?: boolean;
}

export interface ModelTreeBranchNode extends ModelTreeNodeBase {
  kind: 'branch';
  defaultChildKey?: string;
  children: ModelTreeNode[];
}

export interface ModelTreeLeafNode extends ModelTreeNodeBase {
  kind: 'leaf';
  selectedDisplayLabel: string;
  selection: ModelSelectionPayload;
  supportedThinkingLevels?: string[];
  defaultThinkingSuffix?: string;
  thinkingLevel?: number | string | null;
}

export type ModelTreeNode = ModelTreeBranchNode | ModelTreeLeafNode;

export interface ModelCatalogTree {
  supportsCustomOrchestrator: boolean;
  defaultSelectionKey: string | null;
  nodes: ModelTreeNode[];
}

export interface ModelItem {
  id: string;
  model: string;
  modelId?: string | null;
  label: string;
  displayName: string;
  maxTokens: number | null;
  disabled: boolean;
  supportsImages: boolean;
  isDefault: boolean;
  tagTitle?: string | null;
  tagDescription?: string | null;
  quotaInfo: Record<string, unknown> | null;
}

export interface ModelsResponse {
  ok: boolean;
  defaultModelId: string | null;
  models: ModelItem[];
  groups: unknown[];
  tree?: ModelCatalogTree;
}

export interface FsNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size?: number;
  children?: FsNode[];
}

export interface FsTreeResponse {
  ok: boolean;
  root: string;
  path: string;
  entries: FsNode[];
}

export interface FsReadResponse {
  ok: boolean;
  path: string;
  size: number;
  truncated: boolean;
  content: string;
}

export interface FsWriteRequest {
  root: string;
  path: string;
  content: string;
}

export interface FsWriteResponse {
  ok: boolean;
  path: string;
  bytes: number;
}

export type DiffFileStatus = 'untracked' | 'renamed' | 'added' | 'deleted' | 'modified';

export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
}

export interface GitDiffResponse {
  ok: boolean;
  isGitRepo: boolean;
  branch: string;
  files: DiffFile[];
  diffText: string;
}

export interface ArtifactItem {
  name: string;
  path: string;
  size: number;
  mime: string;
  modifiedAt: string;
}

export interface ArtifactsListResponse {
  ok: boolean;
  sessionId: string;
  items: ArtifactItem[];
}

export interface ArtifactReadResponse {
  ok: boolean;
  name: string;
  path: string;
  mime: string;
  size: number;
  truncated: boolean;
  content: string;
}

export interface ArtifactPreviewerDescriptor {
  id: string;
  name: string;
  extensions: string[];
  mimeTypes: string[];
  source: 'builtin' | 'plugin';
  pluginId?: string;
  renderKind?:
    | 'markdown'
    | 'image'
    | 'svg'
    | 'html'
    | 'pdf'
    | 'plugin_iframe'
    | 'plugin_html'
    | 'plugin_markdown';
  iframeUrlTemplate?: string;
}

export interface ArtifactPreviewersResponse {
  ok: boolean;
  builtins: ArtifactPreviewerDescriptor[];
  plugins: ArtifactPreviewerDescriptor[];
}

export interface PluginArtifactPreviewResponse {
  ok: boolean;
  kind?: 'html' | 'markdown' | 'iframe' | 'text';
  content?: string;
  url?: string;
  mime?: string;
}

export interface HostLanguageOption {
  code: string;
  bcp47: string;
  nativeName: string;
  shortLabel: string;
}

export interface HostLocaleResponse {
  ok: boolean;
  locale: string;
  hostLang: string;
  source?: string;
  supportedLanguages: HostLanguageOption[];
}

export interface HostPluginItem {
  id: string;
  displayName: string;
  description: string;
  version: string;
  trustLevel: 'T0' | 'T1' | 'T2' | string;
  badge: string;
  world: 'isolated' | 'page-main' | string;
  nodeIsolation?: string;
  enabled: boolean;
  active: boolean;
  hasNative: boolean;
  hasRollback: boolean;
  permissions: string[];
  sourceKind: string;
  sourceSpec: string;
  health?: Record<string, unknown>;
  webRelevant?: boolean;
  webRelevanceReason?: string | null;
  webVisibleFields?: string[] | '*' | null;
}

export interface HostCatalogItem {
  id: string;
  displayName: string;
  description: string;
  version: string;
  trustLevel: string;
  hasNative: boolean;
  permissions: string[];
  recommendedSpec: string;
  webRelevant?: boolean;
  webRelevanceReason?: string | null;
  webVisibleFields?: string[] | '*' | null;
}

export interface HostMarketStats {
  total: number;
  installed: number;
  active: number;
  catalogCount: number;
}

export interface HostPluginsResponse {
  ok: boolean;
  plugins: HostPluginItem[];
  catalog: HostCatalogItem[];
  marketStats: HostMarketStats;
  scope?: 'web' | 'all';
  hiddenDesktopCount?: number;
  allPluginsCount?: number;
}

export type HostPluginAction = 'enable' | 'disable' | 'install' | 'uninstall' | 'rollback';

export interface HostPluginActionResponse {
  ok: boolean;
  needsPermissionConfirm?: boolean;
  needsNativeUninstallConfirm?: boolean;
  error?: string;
  spec?: string;
  trustPolicy?: Record<string, unknown>;
  plugins?: HostPluginItem[];
  catalog?: HostCatalogItem[];
  marketStats?: HostMarketStats;
  [key: string]: unknown;
}

export type LocalizedText =
  | string
  | {
      'zh-CN'?: string;
      en?: string;
      [locale: string]: string | undefined;
    };

export type SettingsFieldType = 'boolean' | 'enum' | 'string' | 'number' | 'list';

export interface SettingsEnumOption {
  value: string;
  label: LocalizedText;
}

export interface SettingsSchemaField {
  key: string;
  type: SettingsFieldType;
  label?: LocalizedText;
  description?: LocalizedText;
  default?: unknown;
  min?: number;
  max?: number;
  maxItems?: number;
  placeholder?: LocalizedText;
  writeOnly?: boolean;
  secret?: boolean;
  options?: Array<SettingsEnumOption | string>;
}

export interface SettingsSchemaAction {
  id: string;
  commandId?: string;
  label: LocalizedText;
  description?: LocalizedText;
  danger?: boolean;
}

export interface SettingsSchema {
  version?: number;
  title?: LocalizedText;
  description?: LocalizedText;
  fields: SettingsSchemaField[];
  actions?: SettingsSchemaAction[];
}

export interface SecretFieldState {
  configured?: boolean;
  masked?: string;
  [key: string]: unknown;
}

export interface HostSettingsResponse {
  ok: boolean;
  values: Record<string, unknown>;
  errors?: string[];
}

export interface PluginSettingsResponse {
  ok: boolean;
  values: Record<string, unknown>;
  secretState?: Record<string, SecretFieldState | boolean>;
  schema?: SettingsSchema;
  errors?: string[];
  scope?: 'web' | 'all';
  filteredDesktopFieldCount?: number;
}

export interface RunCommandRequest {
  args?: unknown[];
  pluginId?: string;
}

export interface RunCommandResponse {
  ok: boolean;
  commandId: string;
  result?: unknown;
  error?: string;
  message?: string;
}

export interface DoctorReport {
  ok: boolean;
  generatedAt: string;
  hostApiVersion: string;
  platform: string;
  arch: string;
  paths: {
    stateDir: string;
    pluginsDir: string;
  };
  runtime: Record<string, unknown>;
  antigravity: {
    hostProcess: Record<string, unknown>;
    cdpPort: number | null;
    cdpTargetsCount: number;
  };
  anchors: {
    schemaVersion: number;
    count: number;
    sourcePath: string;
  };
  plugins: {
    count: number;
    items: Array<{
      id: string;
      version: string;
      trustLevel: string;
      enabled: boolean;
      world: string;
      nodeIsolation: string;
    }>;
  };
  daemon: {
    lockPresent: boolean;
    lock: Record<string, unknown> | null;
  };
  migration: {
    completed: boolean;
    migratedAt: string | null;
  };
  legacySuite: Record<string, unknown>;
}

export type ContextDisplayLocation = 'composer' | 'topbar';

export interface ContextPluginSettingsSummary {
  displayLocation: ContextDisplayLocation;
  showSpeed: boolean;
  compactPolicy?: 'remind' | 'idle_prompt' | 'cliff_auto' | 'idle_and_cliff' | string;
}

export interface TopbarPanelSlot<T = Record<string, unknown>> {
  available: boolean;
  source?: 'service' | 'state' | string;
  data?: T;
  settings?: ContextPluginSettingsSummary;
}

export interface TopbarPanels {
  context: TopbarPanelSlot & { settings?: ContextPluginSettingsSummary };
  usage: TopbarPanelSlot;
  quota: TopbarPanelSlot;
  [key: string]: TopbarPanelSlot;
}

export interface TopbarResponse {
  ok: boolean;
  panels: TopbarPanels;
}

export interface ComposerQuickPrompt {
  id: string;
  label: string;
  template: string;
  category?: string;
  builtin?: boolean;
}

export interface ComposerSettings {
  quickPromptsEnabled?: boolean;
  quickPromptBarVisible?: boolean;
  autoCompactEnabled?: boolean;
  autoCompactThreshold?: number;
  highRiskGuardEnabled?: boolean;
  promptOptimizerEnabled?: boolean;
  exportMarkdownEnabled?: boolean;
  optimizerShortcut?: string;
  [key: string]: unknown;
}

export interface ComposerStateResponse {
  ok: boolean;
  enabled: boolean;
  installed?: boolean;
  settings: ComposerSettings;
  quickPrompts: ComposerQuickPrompt[];
  frequentPrompts?: Array<string | ComposerQuickPrompt>;
}

export interface RemoteStatusResponse {
  ok: boolean;
  available: boolean;
  running?: boolean;
  port?: number | null;
  url?: string;
  pairingUrl?: string;
  qrSvg?: string;
  primaryChannel?: string;
  permissionLevel?: string;
  allowRemoteWrite?: boolean;
  channels?: Record<string, boolean>;
  deviceCount?: number;
}

export type AccessChannel = 'loopback' | 'lan' | 'tailscale' | 'bonjour' | 'cloudflare';

export interface CloudflareStateInfo {
  mode:
    | 'shared_ready'
    | 'web_disabled'
    | 'remote_pending'
    | 'remote_error'
    | 'remote_tunnel_off'
    | 'legacy_standalone'
    | 'remote_unavailable'
    | 'disabled';
  tunnelMode?: 'quick' | 'named' | null;
  publicOrigin?: string;
  mountPath?: '/pc' | '/';
  reasonCode?: string;
  tokenSource: 'remote' | 'local';
}

export interface ChannelEndpointMeta {
  key: AccessChannel;
  origin: string;
  basePath: string;
  displayHost: string;
  probeUrl: string;
}

export interface SwitchTicketResponse {
  ok: boolean;
  targetChannel: AccessChannel;
  switchUrl: string;
  expiresInMs: number;
}

export interface WebAuthResponse {
  ok: boolean;
  channel?: string;
}

export interface WebAccessStatusResponse {
  ok: boolean;
  running?: boolean;
  host?: string;
  bindHost?: string;
  connectHost?: string;
  port?: number | null;
  url?: string;
  pairingUrl?: string;
  /** Channel the caller came in on, as classified by the server. */
  channel?: string;
  channels?: Record<string, boolean>;
  activeChannels?: string[];
  urls?: Partial<Record<AccessChannel, string>>;
  channelEndpoints?: Partial<Record<AccessChannel, ChannelEndpointMeta>>;
  primaryChannel?: string;
  primaryUrl?: string;
  permissionLevel?: string;
  allowRemoteWrite?: boolean;
  tunnelHostname?: string;
  cloudflareState?: CloudflareStateInfo | null;
}

export interface OptimizePromptResponse {
  ok: boolean;
  optimized: string;
  changed: boolean;
  source?: string;
}

export interface ExportMarkdownResponse {
  ok: boolean;
  markdown: string;
  filename: string;
  stepCount?: number;
}

export interface TerminalSessionDto {
  sessionId: string;
  title: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  alive: boolean;
  exitCode: number | null;
  signal: string | null;
  createdAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  latestSeq: number;
}

export interface TerminalSessionsListResponse {
  ok: boolean;
  runtimeAvailable: boolean;
  unavailableReason?: string | null;
  writable: boolean;
  requiredPermission: 'L2' | string;
  maxSessions: number;
  sessions: TerminalSessionDto[];
}

export interface CreateTerminalSessionRequest {
  cwd?: string;
  sessionId?: string;
  title?: string;
  cols?: number;
  rows?: number;
}

export interface CreateTerminalSessionResponse {
  ok: boolean;
  created: boolean;
  session: TerminalSessionDto;
  writeConfirmToken?: string;
  writeConfirmExpiresAt?: number;
}

export interface TerminalInputResponse {
  ok: boolean;
  sessionId: string;
}

export interface TerminalResizeResponse {
  ok: boolean;
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalCloseResponse {
  ok: boolean;
  closed: boolean;
  alreadyClosed?: boolean;
}

export interface TerminalSseOutputEvent {
  seq: number;
  chunk: string;
  alive: boolean;
}

export interface TerminalSseExitEvent {
  exitCode: number | null;
  signal: string | null;
  endedAt: number | null;
}

export type SideChatContextScope = 'none' | 'session_summary' | 'active_selection';

export interface SideChatTurnInput {
  role: 'user' | 'assistant';
  content: string;
}

export interface SideChatSelectionContext {
  path: string;
  snippet: string;
  kind: 'file' | 'diff';
}

export interface SideChatCompletionRequest {
  prompt: string;
  history?: SideChatTurnInput[];
  model?: string;
  contextScope?: SideChatContextScope;
  sessionId?: string | null;
  selectionContext?: SideChatSelectionContext | null;
}

export interface SideChatMetaEvent {
  requestId: string;
  model: string;
  label: string;
  contextScope: SideChatContextScope;
}

export interface SideChatDeltaEvent {
  delta: string;
}

export interface SideChatDoneEvent {
  requestId: string;
  text: string;
  model: string;
  label: string;
  durationMs: number;
}

export interface SideChatErrorEvent {
  error: string;
  message: string;
}

export interface SideChatCancelResponse {
  ok: boolean;
  cancelled: boolean;
  requestId?: string;
}

export type BackgroundTaskKind = 'command' | 'session' | 'subagent' | 'pty';
export type BackgroundTaskStatus = 'running' | 'pending' | 'stopping' | 'done' | 'error' | 'canceled';

export interface BackgroundTaskStopCapability {
  canStop: boolean;
  requiredPermission: 'L1' | 'L2';
  stopScope: 'pty_session' | 'step_approval_deny' | 'cascade_invocation' | 'none';
  affectsSessionId?: string | null;
}

export interface BackgroundTaskDto {
  taskId: string;
  kind: BackgroundTaskKind;
  title: string;
  commandLine?: string | null;
  cwd?: string | null;
  sessionId?: string | null;
  sessionTitle?: string | null;
  status: BackgroundTaskStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  stopCapability: BackgroundTaskStopCapability;
}

export interface BackgroundTaskDetailDto extends BackgroundTaskDto {
  logText: string;
  truncated: boolean;
  totalBytes: number;
  retainedBytes: number;
}

export interface BackgroundTasksListResponse {
  ok: boolean;
  runningCount: number;
  running: BackgroundTaskDto[];
  recent: BackgroundTaskDto[];
  serverTime: number;
}

export interface BackgroundTaskDetailResponse {
  ok: boolean;
  task: BackgroundTaskDetailDto;
}

export interface StopBackgroundTaskResponse {
  ok: boolean;
  taskId: string;
  alreadyFinished: boolean;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  task?: BackgroundTaskDto;
}

export interface SseTaskUpdatedPayload {
  runningCount: number;
  taskId?: string;
  status?: BackgroundTaskStatus;
}
