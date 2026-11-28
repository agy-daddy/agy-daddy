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

export type WorktreeStatus = 'ready' | 'detached' | 'locked' | 'bare' | 'missing';

export interface WorktreeDto {
  worktreeId: string;
  path: string;
  canonicalKey?: string;
  uri: string;
  displaySubpath: string;
  head: string;
  headShort: string;
  branch: string;
  displayLabel: string;
  isMain: boolean;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  exists: boolean;
  status: WorktreeStatus;
  collapsed: boolean;
  allowed: boolean;
  isCurrent?: boolean;
  sessionCount?: number;
  runningCount?: number;
  needsAttentionCount?: number;
}

export interface CollapsedNodesState {
  projects: Record<string, boolean>;
  worktrees: Record<string, boolean>;
}

export interface WorktreeTombstoneDto {
  repoRootPath: string;
  path: string;
  branch?: string;
  lastSeenAt?: string;
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
  archived?: boolean;
  archivedAt?: string | null;
  groupId?: string | null;
  worktreeId?: string | null;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  worktreeStatus?: WorktreeStatus | string | null;
  workspacePath?: string | null;
}

export interface SessionsListResponse {
  ok: boolean;
  sessions: SessionSummary[];
  hiddenInternalCount?: number;
  archivedCount?: number;
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
  worktreePath?: string;
  projectId?: string | null;
  standalone?: boolean;
}

export interface CreateSessionResponse {
  ok: boolean;
  cascadeId: string;
  title?: string;
  workspaceUri?: string;
  worktreeId?: string;
  worktreePath?: string;
  projectId?: string | null;
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

export interface ProjectItem {
  id: string;
  name: string;
  icon?: string | null;
  rootPath: string;
  groupId: string | null;
  pinned?: boolean;
  pinnedAt?: string | null;
  collapsed?: boolean;
  implicit?: boolean;
  syncedFromApp?: boolean;
  source?: string;
  remote?: ProjectRemoteMeta | null;
  sessionCount?: number;
  createdAt?: string;
  updatedAt?: string;
  lastModifiedTime?: string | null;
  archived?: boolean;
  repoRootPath?: string | null;
  isMultiWorktree?: boolean;
  worktrees?: WorktreeDto[];
  mergedProjectIds?: string[];
}

export interface ProjectGroup {
  id: string;
  name: string;
  icon?: string | null;
  sortOrder: number;
  collapsed: boolean;
  pinned?: boolean;
  pinnedAt?: string | null;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
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

export interface SessionOrgPins {
  sessions: string[];
  projects: string[];
  groups: string[];
}

export interface ProjectsResponse {
  ok: boolean;
  version?: number;
  revision?: number;
  projects: ProjectItem[];
  groups: ProjectGroup[];
  collapsedNodes?: CollapsedNodesState;
  pins?: SessionOrgPins;
  groupOrder?: ZoneOrder;
  projectOrder?: Record<string, ZoneOrder>;
  sessionOrder?: SessionOrderMap;
  worktreeTombstones?: Record<string, WorktreeTombstoneDto>;
  archivedCount?: number;
  defaultSessionPath: string;
}

export interface CreateProjectRequest {
  name: string;
  rootPath: string;
  groupId?: string | null;
  createDir?: boolean;
  source?: string;
  remote?: ProjectRemoteMeta | null;
  icon?: string | null;
}

export interface UpdateProjectRequest {
  name?: string;
  groupId?: string | null;
  archived?: boolean;
  icon?: string | null;
  workspaceUri?: string;
  rootPath?: string;
}

export interface UpdateProjectGroupRequest {
  name?: string;
  collapsed?: boolean;
  sortOrder?: number;
  icon?: string | null;
}

export interface ProjectMutationResponse {
  ok: boolean;
  project?: ProjectItem;
  projects?: ProjectItem[];
  groups?: ProjectGroup[];
  pins?: SessionOrgPins;
  revision?: number;
  defaultSessionPath?: string;
}

export interface ProjectGroupMutationResponse {
  ok: boolean;
  group?: ProjectGroup;
  projects?: ProjectItem[];
  groups?: ProjectGroup[];
  pins?: SessionOrgPins;
  projectOrder?: Record<string, ZoneOrder>;
  movedProjectCount?: number;
  movedProjectIds?: string[];
  revision?: number;
}

export interface CollapseNodeRequest {
  nodeType: 'group' | 'project' | 'worktree';
  id: string;
  collapsed: boolean;
}

export interface CollapseNodeResponse {
  ok: boolean;
  nodeType: 'group' | 'project' | 'worktree';
  id: string;
  collapsed: boolean;
  collapsedNodes?: CollapsedNodesState;
  groups?: ProjectGroup[];
  revision?: number;
}

export interface DeleteEntityResponse {
  ok: boolean;
  id?: string;
  deleted?: boolean;
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
  groups: ProjectGroup[];
  projects: ProjectItem[];
  collapsedNodes?: CollapsedNodesState;
  worktreeTombstones?: Record<string, WorktreeTombstoneDto>;
  pins: SessionOrgPins;
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

export interface ToggleOrgPinRequest {
  type: 'group' | 'project' | 'session';
  id: string;
  pinned?: boolean;
  workspaceUri?: string;
  rootPath?: string;
  projectName?: string;
}

export interface ToggleOrgPinResponse {
  ok: boolean;
  type: 'group' | 'project' | 'session';
  id: string;
  pinned: boolean;
  pinnedAt: string | null;
  pins?: SessionOrgPins;
  revision?: number;
}

export interface OrgGroupMutationRequest {
  action?: 'upsert' | 'delete' | 'assign';
  id?: string;
  name?: string;
  icon?: string | null;
  collapsed?: boolean;
  order?: number;
  groupId?: string | null;
  projectId?: string;
  sessionId?: string;
  rootPath?: string;
  workspaceUri?: string;
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
  project: ProjectItem | null;
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
  staged?: boolean;
  unstaged?: boolean;
}

export interface GitDiffResponse {
  ok: boolean;
  isGitRepo: boolean;
  branch: string;
  files: DiffFile[];
  diffText: string;
}

export interface GitWorktreeItem {
  path: string;
  head: string;
  branch: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  isCurrent: boolean;
  allowed?: boolean;
}

export interface GitWorktreesResponse {
  ok: boolean;
  isGitRepo: boolean;
  worktrees: GitWorktreeItem[];
  action?: string;
  targetPath?: string;
}

export interface GitStageRequest {
  root: string;
  paths?: string[];
  unstage?: boolean;
  all?: boolean;
}

export interface GitStageResponse {
  ok: boolean;
  staged: boolean;
  all?: boolean;
  paths: string[];
}

export interface GitCommitRequest {
  root: string;
  message: string;
}

export interface GitCommitResponse {
  ok: boolean;
  commitSha: string;
  branch: string;
  message: string;
  stdout: string;
}

export interface GitPushRequest {
  root: string;
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
}

export interface GitPushResponse {
  ok: boolean;
  remote: string;
  branch: string;
  stdout: string;
  stderr: string;
}

export type GitWorktreeAction = 'list' | 'add' | 'create' | 'remove' | 'prune';

export interface GitWorktreeMutationRequest {
  root: string;
  action: GitWorktreeAction;
  path?: string;
  branch?: string;
  createBranch?: boolean;
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

export interface HostUpdateTargetInfo {
  targetId: string;
  kind?: 'host' | 'registry' | 'plugin' | string;
  installMode?: 'wrapper' | 'npm-global' | 'git' | string;
  writable?: boolean;
  dirtyWorktree?: boolean;
  trustLevel?: string;
  pinned?: boolean;
  sourceKind?: string;
  sourceSpec?: string;
  currentVersion?: string | null;
  latestVersion?: string | null;
  majorUpdateAvailable?: string | null;
  currentCommit?: string | null;
  latestCommit?: string | null;
  status: 'up_to_date' | 'available' | 'blocked' | 'failed' | string;
  blockReason?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  addedPermissions?: string[];
  addedHighRiskPermissions?: string[];
  requiredHostApi?: string | null;
  autoSafeEligible?: boolean;
  requiresHostRestart?: boolean;
  requiresDaemonRestart?: boolean;
  wrapperUpdateRecommended?: boolean;
  wrapperMinVersion?: string | null;
  releaseNotesUrl?: string | null;
  hasRollback?: boolean;
  lastFailedVersion?: string | null;
}

export interface HostUpdatesSummary {
  availableCount: number;
  pluginAvailableCount: number;
  hostAvailable: boolean;
  registryAvailable: boolean;
  blockedCount: number;
}

export type HostUpdateChannel = 'stable' | 'next';
export type HostAutoUpdateMode = 'notify' | 'auto-safe' | 'manual';
export type HostUpdateCheckInterval = '1h' | '6h' | '12h' | '24h';
export type HostUpdateSourcePreference = 'auto' | 'npm' | 'github';

export interface HostUpdateSettings {
  updateChannel: HostUpdateChannel | string;
  autoUpdateMode: HostAutoUpdateMode | string;
  updateCheckInterval: HostUpdateCheckInterval | string;
  updateSourcePreference: HostUpdateSourcePreference | string;
  npmRegistryUrl: string;
}

export interface HostUpdateSchedulerState {
  enabled: boolean;
  runningCheck: boolean;
  applyingUpdate: boolean;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
}

export interface HostUpdateHistoryEntry {
  timestamp?: string;
  runId?: string;
  trigger?: string;
  targetId?: string;
  sourceKind?: string;
  sourceUrl?: string;
  channel?: string;
  fromVersion?: string | null;
  toVersion?: string | null;
  phase?: string;
  durationMs?: number;
  outcome?: 'up_to_date' | 'available' | 'succeeded' | 'blocked' | 'rolled_back' | 'failed' | string;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface HostUpdatesStatusResponse {
  ok: boolean;
  hostVersion: string;
  hostApiVersion?: string;
  anchorsVersion?: string;
  installMode?: 'wrapper' | 'npm-global' | 'git' | string;
  writable?: boolean;
  dirtyWorktree?: boolean;
  settings?: Partial<HostUpdateSettings>;
  scheduler?: HostUpdateSchedulerState;
  summary?: HostUpdatesSummary;
  targets?: Record<string, HostUpdateTargetInfo>;
  recentHistory?: HostUpdateHistoryEntry[];
}

export interface HostUpdatesCheckRequest {
  targets?: string | string[];
  channel?: string;
  sourcePreference?: string;
  npmRegistryUrl?: string;
  forceRefresh?: boolean;
}

export interface HostUpdatesCheckResponse extends HostUpdatesStatusResponse {
  checkedNow?: boolean;
  debounced?: boolean;
  errors?: Array<{
    targetId?: string;
    errorCode?: string;
    code?: string;
    errorMessage?: string;
    message?: string;
  }>;
}

export interface HostUpdateConfirmItem {
  pluginId: string;
  displayName?: string;
  trustLevel?: string;
  fromVersion?: string;
  toVersion?: string;
  majorUpdate?: boolean;
  currentPermissions?: string[];
  addedPermissions?: string[];
  addedHighRiskPermissions?: string[];
}

export interface HostUpdatesApplyRequest {
  targets: string[];
  channel?: string;
  sourcePreference?: string;
  npmRegistryUrl?: string;
  grantedPermissions?: Record<string, string[]>;
  allowMajor?: boolean;
  dryRun?: boolean;
}

export interface HostUpdateApplyResultItem {
  targetId: string;
  outcome: 'succeeded' | 'rolled_back' | 'blocked' | 'failed' | string;
  fromVersion?: string | null;
  toVersion?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface HostUpdatesApplyResponse {
  ok: boolean;
  runId?: string;
  handoff?: boolean;
  deferredReload?: boolean;
  hostRestartRequired?: boolean;
  targetVersion?: string;
  results?: HostUpdateApplyResultItem[];
  summary?: HostUpdatesSummary;
  plugins?: HostPluginItem[];
  hostRestartNotice?: Record<string, unknown> | null;
  errorCode?: string;
  error?: string;
  message?: string;
  needsPermissionConfirm?: boolean;
  needsMajorConfirm?: boolean;
  confirmations?: HostUpdateConfirmItem[];
}

export interface HostUpdatesRollbackResponse {
  ok: boolean;
  target: string;
  restoredVersion?: string;
  handoff?: boolean;
  plugins?: HostPluginItem[];
  errorCode?: string;
  error?: string;
  message?: string;
}

export interface HostUpdatesPinResponse {
  ok: boolean;
  pluginId: string;
  pinned: boolean;
  plugins?: HostPluginItem[];
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
  pinned?: boolean;
  updateInfo?: HostUpdateTargetInfo | null;
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
  updatesSummary?: HostUpdatesSummary;
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
  updatesSummary?: HostUpdatesSummary;
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
  group?: LocalizedText;
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
  updates?: Record<string, unknown>;
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
  enableNotifications?: boolean;
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
  realCwd?: string;
  worktreeId?: string;
  branchName?: string;
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

export interface SseOrgUpdatedPayload {
  revision?: number;
  updatedAt?: string;
  updatedBy?: string;
  groups?: ProjectGroup[];
  collapsedNodes?: CollapsedNodesState;
  pins?: SessionOrgPins;
  groupOrder?: ZoneOrder;
  projectOrder?: Record<string, ZoneOrder>;
  sessionOrder?: SessionOrderMap;
}

export interface SseWorktreeUpdatedPayload {
  repoRootPath?: string;
  repoRoot?: string;
  action?: string;
  isMultiWorktree?: boolean;
  worktrees?: WorktreeDto[];
  updatedAt?: string;
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
  projectPath?: string | null;
  projectName?: string | null;
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
  totalRunningCount?: number;
  taskId?: string;
  status?: BackgroundTaskStatus;
}

export type PetAnimState =
  | 'idle'
  | 'thinking'
  | 'walking'
  | 'trotting'
  | 'sprinting'
  | 'approval'
  | 'error'
  | 'sleeping';

export type PetRoamMode = 'none' | 'bottom-edge' | 'screen-edges' | 'free-workarea';

export interface PetAttentionItem {
  id: string;
  kind: 'approval' | 'reply' | 'error';
  cascadeId: string;
  sessionTitle: string;
  stepIndex?: number;
  summary: string;
  timestamp: number;
}

export interface PetBusState {
  enabled: boolean;
  desktopVisible: boolean;
  webVisible: boolean;
  themeId: string;
  petScale: number;
  roamMode: PetRoamMode;
  webAnchor: { xRatio: number; yRatio: number };
  motion: {
    animState: PetAnimState;
    tps: number;
    speedFactor: number;
    roamSpeedPxPerSec: number;
    primarySessionId: string | null;
    primarySessionTitle: string;
    watchedRunningCount: number;
  };
  attention: {
    pendingApprovals: PetAttentionItem[];
    unreadReplies: PetAttentionItem[];
    activeBubble: PetAttentionItem | null;
  };
  orgCatalog?: {
    projects: Array<{ id: string; name: string }>;
    groups: Array<{ id: string; name: string }>;
  };
  updatedAt: number;
}

export interface PetSceneSpec {
  sceneId: string;
  viewBox?: { width: number; height: number };
  fps?: { active?: number; idle?: number; sleep?: number };
  hitBox?: { x: number; y: number; width: number; height: number };
  particles?: { preset?: string; color?: string };
  layers: Array<Record<string, unknown>>;
}

export interface PetThemeSummary {
  id: string;
  name: Record<string, string> | string;
  description?: Record<string, string> | string;
  accentHex?: string;
  builtin: boolean;
  usesHostAccent?: boolean;
}

export interface PetStateResponse {
  ok: boolean;
  available: boolean;
  overlaySupported?: { supported: boolean; backend: string };
  state: PetBusState | null;
  scene: PetSceneSpec | null;
  themes: PetThemeSummary[];
  error?: string;
}

export interface PetInteractRequest {
  action: string;
  cascadeId?: string | null;
  bubbleId?: string;
  webAnchor?: { xRatio: number; yRatio: number };
  themeId?: string;
  fileName?: string;
  jsonText?: string;
  svgText?: string;
  archiveBase64?: string;
}
