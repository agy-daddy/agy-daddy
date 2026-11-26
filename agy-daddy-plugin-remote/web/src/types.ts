export type PermissionLevel = 'L0' | 'L1' | 'L2';
export type AppearanceMode = 'auto' | 'light' | 'dark';
export type ColorThemeId = 'monochrome' | 'purple' | 'blue' | 'green' | 'amber' | 'red';
export type DrawerSpeedId = 'fast' | 'normal' | 'slow' | 'off';
export type SupportedLocale = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'es' | 'pt' | 'fr' | 'ru' | 'it';
export type ChatMode = 'chat' | 'plan';
export type DispatchMode = 'steer' | 'queue';
export type RightTabId = 'diff' | 'files' | 'git' | 'artifacts' | 'pty';
export type PinKind = 'session' | 'project' | 'group';
export type ActiveSheetId =
  | null
  | 'telemetry'
  | 'channels'
  | 'menu'
  | 'tasks'
  | 'modelPicker'
  | 'newProject';

export type ThinkingTier =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'thinking'
  | string;

export type OrchestratorMasterKey = 'carbon' | 'argon' | 'neon' | 'opus5.5';
export type OrchestratorThinkingTier = 'low' | 'medium' | 'high' | 'xhigh';
export type OrchestratorThinkingMap = Record<OrchestratorMasterKey, OrchestratorThinkingTier>;
export type ModelSortMode = 'custom' | 'name_asc' | 'name_desc' | 'provider' | 'frequency';

export interface ModelPreferences {
  sortMode: ModelSortMode;
  filterOrder: string[];
  usageCounts?: Record<string, number>;
}

export interface ModelQuotaInfo {
  remainingFraction?: number | null;
  remainingPercent?: number | null;
  resetTime?: string | null;
  [key: string]: unknown;
}

export interface ModelOption {
  id: string;
  model?: string;
  label?: string;
  displayName?: string;
  name?: string;
  shortName?: string;
  family?: string | null;
  thinkingLevel?: ThinkingTier | null;
  thinkingLabel?: string | null;
  isOrchestrator?: boolean;
  orchestratorVariant?: string | null;
  orchestratorMaster?: string | null;
  tagTitle?: string | null;
  quotaInfo?: ModelQuotaInfo | null;
  maxTokens?: number | null;
  supportsImages?: boolean;
  disabled?: boolean;
  isDefault?: boolean;
  groupId?: string | null;
}

export interface NormalizedModel extends ModelOption {
  id: string;
  label: string;
  displayName: string;
  family: string;
  thinkingLevel: ThinkingTier | null;
  thinkingLabel: string | null;
  isOrchestrator: boolean;
  orchestratorVariant: string | null;
  orchestratorMaster: string | null;
  disabled: boolean;
}

export interface BackendModelGroupVariant {
  modelId: string;
  label?: string;
  thinkingLevel?: ThinkingTier | null;
  orchestratorVariant?: string | null;
  orchestratorMaster?: string | null;
  tagTitle?: string | null;
  disabled?: boolean;
}

export interface BackendModelGroup {
  id: string;
  label?: string;
  name?: string;
  kind?: 'orchestrator' | 'thinking_family' | 'single' | 'host_group' | string;
  isOrchestrator?: boolean;
  hasThinkingTiers?: boolean;
  defaultModelId?: string;
  modelIds?: string[];
  variants?: BackendModelGroupVariant[];
  [key: string]: unknown;
}

export interface ModelPickerVariant {
  id: string;
  model: NormalizedModel;
  tierKey: string;
  tierLabel: string;
  shortTag: string;
  order: number;
  disabled: boolean;
  tagTitle?: string | null;
  quotaInfo?: ModelQuotaInfo | null;
  orchestratorMasterKey?: OrchestratorMasterKey;
  resolvedThinkingLevel?: OrchestratorThinkingTier;
}

export interface ModelPickerMasterGroup {
  id: string;
  masterKey?: OrchestratorMasterKey;
  name: string;
  provider: 'gemini' | 'claude' | 'openai' | 'orchestrator' | 'other';
  defaultModelId: string;
  variants: ModelPickerVariant[];
}

export interface ModelPickerGroup {
  id: string;
  kind: 'orchestrator' | 'thinking_family' | 'single';
  name: string;
  subtitle?: string;
  provider: 'gemini' | 'claude' | 'openai' | 'orchestrator' | 'other';
  isOrchestrator: boolean;
  hasThinkingTiers: boolean;
  hasSubLevels: boolean;
  defaultModelId: string;
  variants: ModelPickerVariant[];
  masterGroups?: ModelPickerMasterGroup[];
}

export interface CompactModelBadge {
  name: string;
  shortName: string;
  tag: string;
  full: string;
  isOrchestrator: boolean;
  thinkingLevel: ThinkingTier | null;
  orchestratorVariant: string | null;
}

export interface WorkspaceOption {
  uri: string;
  path?: string;
  name?: string;
  branchName?: string | null;
}

export interface ProjectRemoteMeta {
  provider?: string;
  ownerRepo?: string;
  repoUrl?: string;
  branch?: string;
  driveMode?: 'mount' | 'cli' | string;
  account?: string;
  remoteName?: string;
  remoteFolderId?: string;
}

export interface SessionPins {
  sessions: string[];
  projects: string[];
  groups: string[];
}

export interface ZoneOrder {
  pinned: string[];
  normal: string[];
}

export type SessionOrderMap = {
  __pinned__?: string[];
  __standalone__?: ZoneOrder;
  [containerId: string]: ZoneOrder | string[] | undefined;
};

export interface SessionGroup {
  id: string;
  name: string;
  source?: 'host' | 'user' | string;
  pinned?: boolean;
  pinnedAt?: string | null;
  collapsed?: boolean;
  order?: number;
  sortOrder?: number;
  projectIds: string[];
  workspaceUris: string[];
  sessionIds: string[];
}

export interface HostProject {
  id: string;
  name: string;
  uri: string | null;
  path: string | null;
  rootPath?: string | null;
  groupId?: string | null;
  pinned?: boolean;
  pinnedAt?: string | null;
  implicit?: boolean;
  syncedFromApp?: boolean;
  source?: string;
  remote?: ProjectRemoteMeta | null;
  branchName?: string | null;
  sessionCount?: number;
  lastModifiedTime?: string | null;
  archived?: boolean;
}

export interface ArchivedSessionMeta {
  archivedAt: string;
  archivedAtStepCount?: number;
  archivedWasRunning?: boolean;
  projectId?: string | null;
  projectName?: string | null;
  titleSnapshot?: string;
}

export interface SessionOrgSnapshot {
  ok: boolean;
  version?: number;
  revision?: number;
  groups: SessionGroup[];
  projects: HostProject[];
  pins: SessionPins;
  pinTimestamps?: {
    sessions?: Record<string, string>;
    projects?: Record<string, string>;
    groups?: Record<string, string>;
  };
  projectGroupMap?: Record<string, string>;
  sessionGroupMap?: Record<string, string>;
  groupOrder?: ZoneOrder;
  projectOrder?: Record<string, ZoneOrder>;
  sessionOrder?: SessionOrderMap;
  archivedCount?: number;
  archivedSessions?: Record<string, ArchivedSessionMeta>;
  defaultSessionPath?: string;
}

export interface OrgReorderRequest {
  targetType: 'group' | 'project' | 'session';
  containerId?: string;
  zone: 'pinned' | 'normal';
  orderedIds: string[];
  movedProject?: {
    projectId: string;
    workspaceUri?: string;
    fromGroupId?: string | null;
    toGroupId?: string | null;
  };
  expectedRevision?: number;
}

export interface OrgReorderResponse {
  ok: boolean;
  revision?: number;
  org?: SessionOrgSnapshot;
}

export interface ArchiveSessionRequest {
  archived: boolean;
  stepCount?: number;
  isRunning?: boolean;
  projectId?: string | null;
  projectName?: string | null;
  titleSnapshot?: string;
}

export interface ArchiveSessionResponse {
  ok: boolean;
  cascadeId: string;
  archived: boolean;
  unpinned: boolean;
  revision?: number;
  archivedCount?: number;
}

export interface DeleteSessionResponse {
  ok: boolean;
  cascadeId: string;
  deletionMode: 'host_deleted' | 'local_tombstone' | string;
  hostCleaned: boolean;
  revision?: number;
  archivedCount?: number;
}

export interface WorkspaceBrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  isSymlink: boolean;
}

export interface WorkspaceBreadcrumb {
  name: string;
  path: string;
}

export interface WorkspaceShortcut {
  kind: 'home' | 'default' | 'projects_parent' | 'desktop' | 'documents' | 'gdrive' | string;
  label: string;
  path: string;
}

export interface WorkspaceBrowseResponse {
  ok: boolean;
  requestedPath: string;
  resolvedPath: string;
  exists: boolean;
  willCreateRelative: string;
  parentPath: string | null;
  breadcrumbs: WorkspaceBreadcrumb[];
  entries: WorkspaceBrowseEntry[];
  shortcuts: WorkspaceShortcut[];
}

export interface WorkspaceMkdirResponse {
  ok: boolean;
  name: string;
  path: string;
  parentPath: string;
}

export interface GithubPreflightInfo {
  gitInstalled: boolean;
  gitVersion: string | null;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  activeAccount: string | null;
  accounts: string[];
  orgs: string[];
  canClonePublicOrSsh: boolean;
  canCreateRepo: boolean;
  installHints: {
    git?: string;
    ghLogin?: string;
  };
}

export interface GoogleDriveMountInfo {
  id: string;
  account: string | null;
  rootPath: string;
  myDrivePath: string;
  responsive: boolean;
}

export interface GoogleDrivePreflightInfo {
  tier: 'mount' | 'cli' | 'unavailable';
  mounts: GoogleDriveMountInfo[];
  rclone: {
    installed: boolean;
    driveRemotes: string[];
  };
  gdriveCli: {
    installed: boolean;
    authenticated: boolean;
    account: string | null;
  };
  setupHints: string[];
}

export interface RemotePreflightResponse {
  ok: boolean;
  github?: GithubPreflightInfo;
  gdrive?: GoogleDrivePreflightInfo;
}

export interface GithubRepoItem {
  nameWithOwner: string;
  url: string;
  sshUrl?: string;
  isPrivate: boolean;
  defaultBranchRef?: { name?: string } | null;
  updatedAt?: string;
}

export interface GithubReposResponse {
  ok: boolean;
  repos: GithubRepoItem[];
}

export type RemoteProvisionMode =
  | 'gh_clone'
  | 'gh_create_and_clone'
  | 'gdrive_mount_select'
  | 'gdrive_mount_mkdir'
  | 'gdrive_cli_pull'
  | 'gdrive_cli_mkdir';

export interface StartRemoteJobRequest {
  provider: 'github' | 'gdrive';
  mode: RemoteProvisionMode;
  parentDir: string;
  localDirName?: string;
  projectName: string;
  groupId?: string | null;
  github?: {
    repoSpec?: string;
    newRepoName?: string;
    owner?: string;
    visibility?: 'private' | 'public';
    description?: string;
    addReadme?: boolean;
    branch?: string;
  };
  gdrive?: {
    mountPath?: string;
    account?: string;
    cliTool?: 'rclone' | 'gdrive';
    remoteName?: string;
    folderIdOrPath?: string;
  };
}

export interface RemoteProvisionJob {
  jobId: string;
  provider: 'github' | 'gdrive';
  mode: RemoteProvisionMode;
  projectName: string;
  localDirName: string;
  groupId: string | null;
  targetDir: string;
  createdTargetDir: string | null;
  remoteCreated: {
    ownerRepo: string;
    cloneUrl: string;
    htmlUrl: string;
  } | null;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  step:
    | 'validating'
    | 'creating_remote'
    | 'cloning'
    | 'preparing_mount'
    | 'pulling'
    | 'registering'
    | 'done'
    | 'cancelled'
    | string;
  error: string | null;
  message: string | null;
  project: HostProject | null;
  startedAt: string;
  updatedAt: string;
  elapsedMs: number;
}

export interface StartRemoteJobResponse {
  ok: boolean;
  jobId: string;
  job: RemoteProvisionJob;
}

export interface GetRemoteJobResponse {
  ok: boolean;
  job: RemoteProvisionJob;
}

export interface CancelRemoteJobResponse {
  ok: boolean;
  jobId: string;
  cancelled: boolean;
  job: RemoteProvisionJob;
}

export interface PermissionLevelDetail {
  level: PermissionLevel;
  label: string;
  description: string;
}

export interface PermissionInfo {
  level: PermissionLevel;
  canRead: boolean;
  canChat: boolean;
  canWriteFsGitPty: boolean;
  hostOnlyElevation?: boolean;
  levels?: PermissionLevelDetail[];
}

export interface ContextGroupItem {
  id: string;
  label: string;
  tokens: number;
  share?: number;
}

export interface ContextAlertItem {
  level: 'info' | 'warn' | 'critical' | string;
  code?: string;
  message: string;
}

export interface ContextTelemetryData {
  hasSession?: boolean;
  hasActiveSession?: boolean;
  sessionTitle?: string;
  modelLabel?: string | null;
  used: number | null;
  usedTokens?: number | null;
  budget: number | null;
  maxTokens?: number | null;
  usageRatio?: number | null;
  percent?: number | null;
  remainPercent?: number | null;
  cacheHitRate?: number | null;
  cachedTokens?: number | null;
  inputTokens?: number | null;
  uncachedInput?: number | null;
  outputTokens?: number | null;
  warnThresholdTokens?: number;
  cliffThresholdTokens?: number;
  cacheCliffRisk?: 'none' | 'warn' | 'critical' | string;
  riskLevel?: 'none' | 'warn' | 'critical' | string;
  cacheDropDetected?: boolean;
  displayLocation?: 'topbar' | 'composer';
  showSpeed?: boolean;
  compactPolicy?: string;
  groups?: ContextGroupItem[] | Record<string, unknown>;
  alerts?: Array<ContextAlertItem | string>;
  model?: string;
  status?: string;
  tokPerSec?: number | null;
  speed?:
    | number
    | {
        tps?: number | null;
        streamingTps?: number | null;
        ttft?: number | null;
      }
    | null;
  sessionUsage?: {
    callsCount?: number;
    totalTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    inputTokens?: number;
    avgTps?: number | null;
  } | null;
}

export interface UsagePeriodBucket {
  totalTokens?: number;
  tokens?: number;
  inputTokens?: number;
  cachedTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  totalUsd?: number;
  totalDisplayCost?: number;
  costUSD?: number;
  cost?: number;
  roi?: { savedUsd?: number; effectiveSavedUsd?: number; cacheHitRatio?: number | null };
}

export interface UsageByModelItem {
  model: string;
  label?: string;
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  totalTokens: number;
  costUsd?: number;
  costUSD?: number;
}

export interface UsageTelemetryData {
  totalTokens?: number;
  todayTokens?: number;
  todayCostUsd?: number;
  weekTokens?: number;
  weekCostUsd?: number;
  cacheReadTokens?: number;
  currencySymbol?: string;
  currency?: string;
  exchangeRate?: number;
  totalDisplayCost?: number;
  totalUsd?: number;
  periods?: {
    today?: UsagePeriodBucket;
    month?: UsagePeriodBucket;
    year?: UsagePeriodBucket;
    allTime?: UsagePeriodBucket;
    days7?: UsagePeriodBucket;
    days30?: UsagePeriodBucket;
    roi?: { savedUsd?: number; cacheHitRatio?: number | null };
  };
  byModel?: UsageByModelItem[] | Record<string, unknown>;
}

export interface QuotaWindowSlot {
  percentText?: string;
  usedPercentText?: string;
  remainingPercent?: number | null;
  remainingFraction?: number | null;
  fraction?: number | null;
  countdownText?: string;
  resetIn?: string;
  resetInHuman?: string;
  resetTime?: string;
  resetTimeIso?: string;
  resetTimeText?: string;
}

export interface QuotaModelEntry extends QuotaWindowSlot {
  fiveHour?: QuotaWindowSlot | null;
  weekly?: QuotaWindowSlot | null;
  fiveHourBucket?: QuotaWindowSlot | null;
  weeklyBucket?: QuotaWindowSlot | null;
}

export interface QuotaPoolDto {
  id?: string;
  title: string;
  models?: string[];
  tightestFraction?: number | null;
  tightestPercentText?: string;
  fiveHourBucket?: QuotaWindowSlot | null;
  weeklyBucket?: QuotaWindowSlot | null;
  buckets?: QuotaWindowSlot[];
}

export interface QuotaTelemetryData {
  gemini?: QuotaModelEntry | null;
  claude?: QuotaModelEntry | null;
  planTier?: string;
  ultraSubTier?: string | null;
  quotaMultiplier?: number | null;
  tightestFraction?: number | null;
  tightestPercentText?: string | null;
  pools?: QuotaPoolDto[];
}

export interface TelemetryPanels {
  context?: { available?: boolean; data?: ContextTelemetryData | null };
  usage?: { available?: boolean; data?: UsageTelemetryData | null };
  quota?: { available?: boolean; data?: QuotaTelemetryData | null };
  [key: string]: unknown;
}

export interface BootstrapResponse {
  ok: boolean;
  channel: string;
  permissionLevel: PermissionLevel;
  writeEnabled: boolean;
  rpcConnected?: boolean;
  permissionInfo?: PermissionInfo | null;
  models: Array<ModelOption | string>;
  modelGroups?: BackendModelGroup[];
  defaultModelId?: string;
  orchestratorThinking?: Partial<OrchestratorThinkingMap>;
  modelPreferences?: Partial<ModelPreferences>;
  workspaces: Array<WorkspaceOption | string>;
  version?: number;
  revision?: number;
  groups?: SessionGroup[];
  projects?: HostProject[];
  pins?: SessionPins;
  groupOrder?: ZoneOrder;
  projectOrder?: Record<string, ZoneOrder>;
  sessionOrder?: SessionOrderMap;
  archivedCount?: number;
  archivedSessions?: Record<string, ArchivedSessionMeta>;
  defaultSessionPath?: string;
  vapidPublicKey?: string | null;
  voiceSupported?: boolean;
  pcWebHidden?: boolean;
  runningTasksCount?: number;
  telemetry?: { panels?: TelemetryPanels; runningTasksCount?: number; channel?: string } | null;
  panels?: TelemetryPanels;
}

export interface SessionSummary {
  cascadeId: string;
  title: string;
  summary: string;
  status: string;
  needsAttention?: boolean;
  attentionReason?: string | null;
  stepCount: number;
  lastModifiedTime: string | null;
  workspaceUri: string | null;
  branchName: string | null;
  groupId?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  pinned?: boolean;
  pinnedAt?: string | null;
  archived?: boolean;
  archivedAt?: string | null;
  parentConversationId?: string | null;
  nestingDepth?: number;
  agentName?: string | null;
  isSubagent?: boolean;
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

export interface OptimisticUserPayload extends Record<string, unknown> {
  text: string;
  images?: Array<{ dataUrl: string; mime: string }>;
  clientTempId: string;
  optimistic: true;
}

export interface CodeActionPayload extends Record<string, unknown> {
  actionSpec?: {
    targetFile?: string;
    filePath?: string;
    absolutePathUri?: string;
    path?: string;
    description?: string;
    [key: string]: unknown;
  };
  actionResult?: Record<string, unknown>;
  diffStats?: {
    additions?: number;
    deletions?: number;
    linesAdded?: number;
    linesRemoved?: number;
    added?: number;
    removed?: number;
  };
  diffText?: string;
  unifiedDiff?: {
    lines?: Array<Record<string, unknown>>;
  };
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
  trajectoryId?: string | null;
  status: string;
  numTotalSteps: number;
  metadata?: Record<string, unknown> | null;
}

export interface ImageAttachment {
  id: string;
  name: string;
  dataUrl: string;
  mime: string;
  bytes: number;
}

export interface QueuedMessage {
  id: string;
  queueId?: string;
  sessionId: string;
  cascadeId?: string;
  text: string;
  modelId?: string;
  mode: ChatMode;
  images?: Array<{ dataUrl: string; mime: string }>;
  dispatchMode: DispatchMode;
  createdAt: number;
  enqueuedAt?: number;
  status: 'queued' | 'sending' | 'failed';
  error?: string;
  source?: 'local' | 'server';
}

export interface ComposerPreset {
  id?: string;
  label: string;
  prompt: string;
  text?: string;
  category?: string;
}

export interface ComposerQuickPrompt {
  id: string;
  label: string;
  template: string;
  category?: string;
  builtin?: boolean;
}

export interface ComposerSettingsDto {
  showQuickBar: boolean;
  ghostSuggest: boolean;
  showPromptOptimizer: boolean;
  autoCompactThresholdTokens?: number;
}

export interface ComposerStateResponse {
  ok: boolean;
  available?: boolean;
  settings?: ComposerSettingsDto;
  presets?: ComposerPreset[];
  quickPrompts?: Array<ComposerPreset | ComposerQuickPrompt | Record<string, unknown>>;
  frequentPrompts?: Array<ComposerPreset | string | Record<string, unknown>>;
}

export interface FsTreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FsTreeEntry[];
}

export interface GitDiffFile {
  path: string;
  status?: string;
  staged?: boolean;
  unstaged?: boolean;
  additions?: number | null;
  deletions?: number | null;
}

export interface GitDiffResponse {
  ok: boolean;
  isGitRepo?: boolean;
  branch?: string;
  files?: GitDiffFile[];
  diffText?: string;
  truncated?: boolean;
}

export interface GitWorktreeInfo {
  path: string;
  branch?: string;
  head?: string;
  isMain?: boolean;
  isCurrent?: boolean;
}

export interface ArtifactItem {
  name: string;
  path: string;
  size: number;
  mime: string;
  modifiedAt?: string;
}

export interface PtySessionInfo {
  id: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  createdAt?: number;
}

export interface ConfirmPromptState {
  title: string;
  hint: string;
  resolve: (confirmed: boolean) => void;
}

export type BackgroundTaskKind = 'pty' | 'session' | 'command';
export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface StopCapability {
  canStop: boolean;
  requiredLevel?: 'L1' | 'L2';
  reason?: string;
}

export interface BackgroundTaskDto {
  id: string;
  kind: BackgroundTaskKind;
  title: string;
  subtitle?: string;
  status: BackgroundTaskStatus;
  sessionId?: string;
  sessionTitle?: string | null;
  cwd?: string;
  projectPath?: string | null;
  projectName?: string | null;
  startedAt: number;
  endedAt?: number | null;
  exitCode?: number | null;
  stopCapability: StopCapability;
}

export interface BackgroundTaskDetailDto extends BackgroundTaskDto {
  logText: string;
  truncated: boolean;
  totalBytes: number;
  retainedBytes: number;
}

export interface BackgroundTasksFilterProject {
  key: string;
  name: string;
  path: string;
  count: number;
}

export interface BackgroundTasksFilterSession {
  id: string;
  title: string;
  projectPath: string | null;
  count: number;
}

export interface BackgroundTasksFilters {
  projects: BackgroundTasksFilterProject[];
  sessions: BackgroundTasksFilterSession[];
}

export interface BackgroundTasksListResponse {
  ok: boolean;
  runningCount: number;
  totalRunningCount?: number;
  running: BackgroundTaskDto[];
  recent: BackgroundTaskDto[];
  filters?: BackgroundTasksFilters;
}

export interface StopBackgroundTaskResponse {
  ok: boolean;
  taskId: string;
  alreadyFinished: boolean;
  status: BackgroundTaskStatus;
  exitCode?: number | null;
  task?: BackgroundTaskDto;
}

export type ChannelKey = 'local' | 'loopback' | 'lan' | 'bonjour' | 'tailscale' | 'cloudflare';

export interface ChannelEntryDto {
  key: ChannelKey;
  label: string;
  origin: string;
  protocol: 'http:' | 'https:' | string;
  displayHost: string;
  probeUrl: string;
  fallbackProbeUrl?: string;
  isCurrent: boolean;
  requiresTicketRedirect: boolean;
}

export interface ChannelsListResponse {
  ok: boolean;
  currentChannel: ChannelKey | string;
  currentOrigin: string;
  tunnelMode: 'quick' | 'named' | string;
  tunnelState: 'stopped' | 'starting' | 'running' | 'error' | string;
  entries: ChannelEntryDto[];
}

export interface SwitchTicketResponse {
  ok: boolean;
  ticket: string;
  expiresInMs: number;
}

export interface RedeemTicketResponse {
  ok: boolean;
  authToken: string;
  sessionId: string | null;
  draftText: string;
  targetChannel?: string;
}

export interface LocaleOptionDto {
  code: string;
  bcp47: SupportedLocale;
  nativeName: string;
  shortLabel: string;
}

export interface LocaleResponse {
  ok: boolean;
  locale: SupportedLocale;
  supportedLocales: LocaleOptionDto[];
}

export interface DiagnosticsCheckItem {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface DiagnosticsResponse {
  ok: boolean;
  mode: string;
  hostControlAvailable: boolean;
  checkedAt: number;
  summary: { okCount: number; warnCount: number; failCount: number };
  checks: DiagnosticsCheckItem[];
}

export interface SafeCommandItem {
  id: string;
  minLevel: PermissionLevel;
  title: string;
  allowed: boolean;
}

export interface SafeCommandsResponse {
  ok: boolean;
  commands: SafeCommandItem[];
}
