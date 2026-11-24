export type PermissionLevel = 'L0' | 'L1' | 'L2';
export type AppearanceMode = 'auto' | 'light' | 'dark';
export type ChatMode = 'chat' | 'plan';
export type DispatchMode = 'steer' | 'queue';
export type RightTabId = 'diff' | 'files' | 'git' | 'artifacts' | 'pty';
export type PinKind = 'session' | 'project' | 'group';

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

export interface ContextTelemetryData {
  hasSession?: boolean;
  used: number | null;
  budget: number | null;
  percent?: number | null;
  remainPercent?: number | null;
  cacheHitRate?: number | null;
  cachedTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  warnThresholdTokens?: number;
  cliffThresholdTokens?: number;
  cacheCliffRisk?: 'none' | 'warn' | 'critical' | string;
  cacheDropDetected?: boolean;
  alerts?: Array<{ level?: string; message?: string }>;
  model?: string;
  status?: string;
  tokPerSec?: number | null;
  speed?: {
    tps?: number | null;
    streamingTps?: number | null;
    ttft?: number | null;
  } | null;
  sessionUsage?: {
    callsCount?: number;
    totalTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    inputTokens?: number;
    avgTps?: number | null;
  } | null;
}

export interface UsageTelemetryData {
  totalTokens?: number;
  currencySymbol?: string;
  totalDisplayCost?: number;
  totalUsd?: number;
}

export interface QuotaWindowSlot {
  percentText?: string;
  usedPercentText?: string;
  remainingPercent?: number | null;
  remainingFraction?: number | null;
  countdownText?: string;
  resetTimeText?: string;
}

export interface QuotaModelEntry extends QuotaWindowSlot {
  fiveHour?: QuotaWindowSlot | null;
  weekly?: QuotaWindowSlot | null;
  fiveHourBucket?: QuotaWindowSlot | null;
  weeklyBucket?: QuotaWindowSlot | null;
}

export interface QuotaTelemetryData {
  gemini?: QuotaModelEntry | null;
  claude?: QuotaModelEntry | null;
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
  permissionInfo?: PermissionInfo | null;
  models: Array<ModelOption | string>;
  modelGroups?: BackendModelGroup[];
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
  telemetry?: { panels?: TelemetryPanels; channel?: string } | null;
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
  category?: string;
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
