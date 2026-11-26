export type PermissionLevel = 'L0' | 'L1' | 'L2';
export type AppearanceMode = 'auto' | 'light' | 'dark';
export type ColorThemeId = 'monochrome' | 'purple' | 'blue' | 'green' | 'amber' | 'red';
export type DrawerSpeedId = 'fast' | 'normal' | 'slow' | 'off';
export type SupportedLocale = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'es' | 'pt' | 'fr' | 'ru' | 'it';
export type ChatMode = 'chat' | 'plan';
export type DispatchMode = 'steer' | 'queue';
export type RightTabId = 'diff' | 'files' | 'git' | 'artifacts' | 'pty';
export type PinKind = 'session' | 'project' | 'group';
export type ActiveSheetId = null | 'telemetry' | 'channels' | 'menu' | 'tasks' | 'modelPicker';

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
export type OrchestratorThinkingTier = ThinkingTier;
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
  modelId?: string | null;
  label?: string;
  displayName?: string;
  name?: string;
  shortName?: string;
  family?: string | null;
  thinkingLevel?: ThinkingTier | null;
  thinkingLabel?: string | null;
  supportedThinkingLevels?: ThinkingTier[] | null;
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
  supportedThinkingLevels?: ThinkingTier[] | null;
  isOrchestrator: boolean;
  orchestratorVariant: string | null;
  orchestratorMaster: string | null;
  disabled: boolean;
}

export interface BackendModelGroupVariant {
  modelId: string;
  label?: string;
  thinkingLevel?: ThinkingTier | null;
  supportedThinkingLevels?: ThinkingTier[] | null;
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
  supportedThinkingLevels?: ThinkingTier[] | null;
  defaultModelId?: string;
  modelIds?: string[];
  variants?: BackendModelGroupVariant[];
  [key: string]: unknown;
}

export interface ModelTreeSelectionPayload {
  mode?: 'single' | 'orchestrator_preset' | string;
  requestedModel?: string;
  modelId?: string;
  plannerFamilyId?: string;
  executorFamilyId?: string;
  plannerThinkingSuffix?: string;
  backingModels?: Record<string, string>;
}

export interface ModelTreeNodeBase {
  key: string;
  role?: string;
  label: string;
  secondaryLabel?: string;
  badge?: { text?: string; tone?: string } | null;
  quota?: ModelQuotaInfo | null;
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
  selectedDisplayLabel?: string;
  selection?: ModelTreeSelectionPayload;
  supportedThinkingLevels?: ThinkingTier[] | null;
  defaultThinkingSuffix?: string | null;
  thinkingLevel?: number | string | null;
}

export type ModelTreeNode = ModelTreeBranchNode | ModelTreeLeafNode;

export interface ModelCatalogTree {
  supportsCustomOrchestrator?: boolean;
  defaultSelectionKey?: string | null;
  nodes: ModelTreeNode[];
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
  orchestratorMasterKey?: OrchestratorMasterKey | null;
  resolvedThinkingLevel?: OrchestratorThinkingTier;
}

export interface ModelPickerMasterGroup {
  id: string;
  masterKey?: OrchestratorMasterKey | null;
  name: string;
  provider: 'gemini' | 'claude' | 'openai' | 'orchestrator' | 'other';
  defaultModelId: string;
  defaultThinkingLevel?: ThinkingTier | null;
  supportedThinkingLevels?: ThinkingTier[];
  hasSubLevels?: boolean;
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

export interface SessionPins {
  sessions: string[];
  projects: string[];
  groups: string[];
}

export interface SessionGroup {
  id: string;
  name: string;
  source?: 'host' | 'user' | string;
  pinned?: boolean;
  order?: number;
  projectIds: string[];
  workspaceUris: string[];
  sessionIds: string[];
}

export interface HostProject {
  id: string;
  name: string;
  uri: string | null;
  path: string | null;
  groupId?: string | null;
  pinned?: boolean;
  branchName?: string | null;
  sessionCount?: number;
  lastModifiedTime?: string | null;
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
  modelTree?: ModelCatalogTree | null;
  defaultModelId?: string;
  orchestratorThinking?: Partial<OrchestratorThinkingMap>;
  modelPreferences?: Partial<ModelPreferences>;
  workspaces: Array<WorkspaceOption | string>;
  groups?: SessionGroup[];
  projects?: HostProject[];
  pins?: SessionPins;
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
  cwd?: string;
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

export interface BackgroundTasksListResponse {
  ok: boolean;
  runningCount: number;
  running: BackgroundTaskDto[];
  recent: BackgroundTaskDto[];
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
