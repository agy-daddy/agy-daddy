import { useEffect, useRef, useState } from 'preact/hooks';
import { LOCALE_STORAGE_KEY, normalizeLocale } from '../i18n';
import {
  COLOR_THEME_STORAGE_KEY,
  DRAWER_SPEED_STORAGE_KEY,
  normalizeColorTheme,
  normalizeDrawerSpeed
} from '../theme/ThemeProvider';
import type {
  ActiveSheetId,
  AppearanceMode,
  BootstrapResponse,
  ChannelEntryDto,
  ChatMode,
  ColorThemeId,
  ComposerPreset,
  ComposerQuickPrompt,
  ComposerSettingsDto,
  ConfirmPromptState,
  DispatchMode,
  DrawerSpeedId,
  HostProject,
  ImageAttachment,
  ModelPickerGroup,
  ModelPreferences,
  NormalizedModel,
  OptimisticUserPayload,
  OrchestratorMasterKey,
  OrchestratorThinkingMap,
  OrchestratorThinkingTier,
  PermissionInfo,
  PermissionLevel,
  PinKind,
  QueuedMessage,
  RightTabId,
  SessionDetail,
  SessionEvent,
  SessionGroup,
  SessionPins,
  SessionSummary,
  SupportedLocale,
  TelemetryPanels
} from '../types';
import { api, configureApiClient, getApiBaseOrigin, setApiBaseOrigin } from './api';
import {
  flushDraftSave,
  flushSnapshotSave,
  loadDraft,
  loadQueue,
  loadSessionsCache,
  loadSessionSnapshot,
  saveDraft,
  saveQueue,
  saveSessionsCache,
  saveSessionSnapshot,
  scheduleDraftSave,
  scheduleSnapshotSave
} from './idb';
import {
  applyModelPreferences,
  DEFAULT_ORCHESTRATOR_THINKING,
  formatCompactModelBadge,
  groupModelsForPicker,
  matchOrchestratorMasterKey,
  normalizeModelCatalog,
  normalizeModels,
  resolveUnifiedModelName,
  sanitizeOrchestratorThinkingMap
} from './modelCatalog';
import {
  getActivePushSubscription,
  subscribeWebPush,
  triggerForegroundAlert,
  unsubscribeWebPush
} from './push';
import { RemoteSseClient, type SseStatus } from './sse';
import {
  clearSavedToken,
  extractTokenAndScrubUrl,
  saveToken,
  scrubSwitchTicketFromUrl
} from './token';

export {
  applyModelPreferences,
  formatCompactModelBadge,
  groupModelsForPicker,
  normalizeModelCatalog,
  normalizeModels,
  resolveUnifiedModelName
};

const APPEARANCE_KEY = 'agy_remote_appearance';
const SOUND_KEY = 'agy_remote_sound_alert';
const VIBRATE_KEY = 'agy_remote_vibrate_alert';
const PINS_CACHE_KEY = 'agy_remote_pins_v1';
const GROUPS_CACHE_KEY = 'agy_remote_groups_v1';
const ORCH_THINKING_KEY = 'agy_remote_orch_thinking_v1';
const ORCH_ACTIVE_MASTER_KEY = 'agy_remote_orch_master_v1';

const EMPTY_PINS: SessionPins = { sessions: [], projects: [], groups: [] };

export interface RemoteState {
  token: string;
  enteredFromLanding: boolean;
  ready: boolean;
  authError: string;
  online: boolean;
  rpcConnected: boolean;
  sseStatus: SseStatus;
  bootstrap: BootstrapResponse | null;
  channel: string;
  apiBaseOrigin: string;
  permissionLevel: PermissionLevel;
  permissionInfo: PermissionInfo | null;
  models: NormalizedModel[];
  modelGroups: ModelPickerGroup[];
  modelPickerOpen: boolean;
  orchestratorThinking: OrchestratorThinkingMap;
  activeOrchestratorMaster: OrchestratorMasterKey | null;
  modelPreferences: ModelPreferences;
  sessions: SessionSummary[];
  groups: SessionGroup[];
  projects: HostProject[];
  pins: SessionPins;
  activeSessionId: string;
  activeSession: SessionDetail | null;
  events: SessionEvent[];
  loadingSession: boolean;
  telemetry: TelemetryPanels;
  runningTasksCount: number;
  presets: ComposerPreset[];
  quickPrompts: ComposerQuickPrompt[];
  frequentPrompts: string[];
  composerSettings: ComposerSettingsDto;
  selectedModelId: string;
  chatMode: ChatMode;
  dispatchMode: DispatchMode;
  composerText: string;
  composerImages: ImageAttachment[];
  queue: QueuedMessage[];
  changedFilesCount: number;
  appearance: AppearanceMode;
  colorTheme: ColorThemeId;
  drawerSpeed: DrawerSpeedId;
  locale: SupportedLocale;
  soundAlert: boolean;
  vibrateAlert: boolean;
  pushSubscribed: boolean;
  pushBusy: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  rightTab: RightTabId;
  contextExpanded: boolean;
  activeSheet: ActiveSheetId;
  telemetryTab: 'context' | 'usage' | 'quota';
  hideSystemEvents: boolean;
  thinkingExpandVersion: number;
  thinkingExpandTarget: boolean | null;
  confirmPrompt: ConfirmPromptState | null;
  toast: string;
  inspectTargetFile: string;
}

function readBoolPref(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage?.getItem(key);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch {}
  return fallback;
}

function readJsonPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage?.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {}
  return fallback;
}

function writeJsonPref(key: string, val: unknown): void {
  try {
    window.localStorage?.setItem(key, JSON.stringify(val));
  } catch {}
}

function readAppearance(): AppearanceMode {
  try {
    const v = window.localStorage?.getItem(APPEARANCE_KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {}
  return 'auto';
}

function applyAppearance(mode: AppearanceMode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-appearance', mode);
  }
}

function normalizePins(raw: Partial<SessionPins> | null | undefined): SessionPins {
  return {
    sessions: Array.isArray(raw?.sessions) ? Array.from(new Set(raw.sessions.map(String))) : [],
    projects: Array.isArray(raw?.projects) ? Array.from(new Set(raw.projects.map(String))) : [],
    groups: Array.isArray(raw?.groups) ? Array.from(new Set(raw.groups.map(String))) : []
  };
}

function applyPinsToOrg(
  sessions: SessionSummary[],
  projects: HostProject[],
  groups: SessionGroup[],
  pins: SessionPins
): { sessions: SessionSummary[]; projects: HostProject[]; groups: SessionGroup[] } {
  const sessSet = new Set(pins.sessions);
  const projSet = new Set(pins.projects);
  const grpSet = new Set(pins.groups);
  return {
    sessions: sessions.map((s) => ({ ...s, pinned: sessSet.has(s.cascadeId) })),
    projects: projects.map((p) => ({ ...p, pinned: projSet.has(p.id) })),
    groups: groups.map((g) => ({ ...g, pinned: grpSet.has(g.id) }))
  };
}

const INTERNAL_TEMP_WORKSPACE_PATH_RE =
  /(?:^|\/)(?:(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/|(?:private\/)?tmp\/)(?:magpie-agy-bridge-|agy-model-probe-|agy-probe-|antigravity-probe-|route-score-|omb-claude-background-)/i;
const INTERNAL_TEMP_WORKSPACE_DIR_RE =
  /^(?:magpie-agy-bridge-|agy-model-probe-|agy-probe-|antigravity-probe-|route-score-|omb-claude-background-)[A-Za-z0-9_-]*$/i;

function isInternalTempWorkspacePath(uriOrPath: string | null | undefined): boolean {
  const clean = normalizeRootUri(uriOrPath).replace(/\/+$/, '');
  if (!clean) return false;
  if (INTERNAL_TEMP_WORKSPACE_PATH_RE.test(clean)) return true;
  const parts = clean.split('/').filter(Boolean);
  const base = parts[parts.length - 1] || '';
  return INTERNAL_TEMP_WORKSPACE_DIR_RE.test(base);
}

function buildFallbackProjects(
  sessions: SessionSummary[],
  workspaces: BootstrapResponse['workspaces'] | undefined,
  pins: SessionPins
): HostProject[] {
  const map = new Map<string, HostProject>();
  const pinSet = new Set(pins.projects);

  const upsert = (uriOrPath: string | null | undefined, branch?: string | null, nameHint?: string | null, lastMod?: string | null) => {
    const pathStr = normalizeRootUri(uriOrPath);
    if (!pathStr || isInternalTempWorkspacePath(pathStr)) return;
    const id = pathStr;
    const existing = map.get(id);
    const segments = pathStr.replace(/\/+$/, '').split('/');
    const derivedName = nameHint || segments[segments.length - 1] || pathStr;
    if (!existing) {
      map.set(id, {
        id,
        name: derivedName,
        uri: uriOrPath?.startsWith('file://') ? uriOrPath : `file://${pathStr}`,
        path: pathStr,
        groupId: null,
        pinned: pinSet.has(id),
        branchName: branch || null,
        sessionCount: 0,
        lastModifiedTime: lastMod || null
      });
    } else {
      if (!existing.branchName && branch) existing.branchName = branch;
      if (lastMod && (!existing.lastModifiedTime || lastMod > existing.lastModifiedTime)) {
        existing.lastModifiedTime = lastMod;
      }
    }
  };

  if (Array.isArray(workspaces)) {
    for (const ws of workspaces) {
      if (typeof ws === 'string') {
        upsert(ws);
      } else if (ws && typeof ws === 'object') {
        upsert(ws.uri || ws.path, ws.branchName, ws.name);
      }
    }
  }

  for (const s of sessions) {
    const key = normalizeRootUri(s.workspaceUri);
    if (!key) continue;
    upsert(s.workspaceUri, s.branchName, s.projectName, s.lastModifiedTime);
    const proj = map.get(key);
    if (proj) {
      proj.sessionCount = (proj.sessionCount || 0) + 1;
      if (s.groupId && !proj.groupId) proj.groupId = s.groupId;
    }
  }

  return Array.from(map.values());
}

function normalizeQueueItem(raw: unknown, fallbackSessionId: string): QueuedMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id || r.queueId || '').trim();
  const sessionId = String(r.sessionId || r.cascadeId || fallbackSessionId || '').trim();
  const text = typeof r.text === 'string' ? r.text : '';
  if (!id || !sessionId) return null;
  const rawStatus = String(r.status || 'queued').toLowerCase();
  const status: QueuedMessage['status'] =
    rawStatus === 'sending' || rawStatus === 'dispatching'
      ? 'sending'
      : rawStatus === 'failed'
        ? 'failed'
        : 'queued';
  return {
    id,
    queueId: String(r.queueId || id),
    sessionId,
    cascadeId: sessionId,
    text,
    modelId: typeof r.modelId === 'string' ? r.modelId : undefined,
    mode: r.mode === 'plan' ? 'plan' : 'chat',
    images: Array.isArray(r.images) ? (r.images as Array<{ dataUrl: string; mime: string }>) : undefined,
    dispatchMode: r.dispatchMode === 'steer' ? 'steer' : 'queue',
    createdAt: Number(r.createdAt || r.enqueuedAt || Date.now()),
    enqueuedAt: Number(r.enqueuedAt || r.createdAt || Date.now()),
    status,
    error: typeof r.error === 'string' ? r.error : undefined,
    source: r.source === 'local' ? 'local' : 'server'
  };
}

function compareSessionEvents(a: SessionEvent, b: SessionEvent): number {
  const aNeg = a.seq < 0;
  const bNeg = b.seq < 0;
  if (aNeg !== bNeg) return aNeg ? 1 : -1;
  // Negative optimistic seqs (-1, -2, ...) sort by creation order (FIFO): -1 before -2
  if (aNeg) return b.seq - a.seq;
  return a.seq - b.seq;
}

function normalizeComparableUserText(ev: SessionEvent): string {
  const p = ev.payload || {};
  let raw = '';
  if (typeof p.userResponse === 'string' && p.userResponse) {
    raw = p.userResponse;
  } else if (typeof p.text === 'string' && p.text) {
    raw = p.text;
  } else if (Array.isArray(p.items)) {
    raw = p.items
      .map((item) =>
        typeof item === 'string' ? item : String((item as { text?: string })?.text || '')
      )
      .filter(Boolean)
      .join('\n');
  }
  return raw.trim().replace(/\s+/g, ' ');
}

function mergeSameSeqEvent(existing: SessionEvent, incoming: SessionEvent): SessionEvent {
  if (existing.kind === incoming.kind && existing.payload && incoming.payload) {
    // In-place merge preserving any fields omitted in lightweight delta patches
    return {
      ...existing,
      ...incoming,
      payload: {
        ...existing.payload,
        ...incoming.payload
      }
    };
  }
  return incoming;
}

export function mergeEvents(prev: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
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
          next[next.length - 1] = mergeSameSeqEvent(tail, ev);
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
  // Ensure FIFO consumption order (-1 created before -2)
  optimisticUsers.sort(compareSessionEvents);

  for (const ev of incoming) {
    if (ev.seq >= 0 && ev.kind === 'user' && !prevSeqs.has(ev.seq)) {
      prevSeqs.add(ev.seq);
      if (optimisticUsers.length > 0) {
        const incomingText = normalizeComparableUserText(ev);
        const matchIdx = optimisticUsers.findIndex(
          (opt) => normalizeComparableUserText(opt) === incomingText
        );
        const [removed] = optimisticUsers.splice(matchIdx >= 0 ? matchIdx : 0, 1);
        if (removed) {
          bySeq.delete(removed.seq);
        }
      }
    }

    const existing = bySeq.get(ev.seq);
    bySeq.set(ev.seq, existing ? mergeSameSeqEvent(existing, ev) : ev);
  }
  return Array.from(bySeq.values()).sort(compareSessionEvents);
}

export function normalizeRootUri(uriOrPath: string | null | undefined): string {
  const s = String(uriOrPath || '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(s).pathname);
    } catch {
      return s.slice(7);
    }
  }
  return s;
}

export function sanitizePresets(raw: unknown): ComposerPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: ComposerPreset[] = [];
  const seenPrompts = new Set<string>();
  for (const item of raw) {
    if (!item) continue;
    if (typeof item === 'string') {
      const s = item.trim();
      const lower = s.toLowerCase();
      if (s && lower !== '/plan' && !seenPrompts.has(lower)) {
        seenPrompts.add(lower);
        out.push({ label: s, prompt: s });
      }
      continue;
    }
    if (typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : undefined;
    const prompt =
      typeof rec.prompt === 'string'
        ? rec.prompt.trim()
        : typeof rec.text === 'string'
          ? rec.text.trim()
          : '';
    const rawLabel =
      typeof rec.label === 'string'
        ? rec.label.trim()
        : typeof rec.title === 'string'
          ? rec.title.trim()
          : typeof rec.name === 'string'
            ? rec.name.trim()
            : '';
    const label = rawLabel || prompt;
    const finalPrompt = prompt || label;
    if (!label && !finalPrompt) continue;
    const lowerPrompt = finalPrompt.toLowerCase();
    // 手机端已提供原生 Plan 模式开关（presets-plan-toggle），过滤重复的 /plan 快捷词入口
    if (lowerPrompt === '/plan') continue;
    if (id && id.toLowerCase() === 'plan' && /^\/?plan$/i.test(lowerPrompt)) continue;
    if (seenPrompts.has(lowerPrompt)) continue;
    seenPrompts.add(lowerPrompt);
    out.push({
      id,
      label,
      prompt: finalPrompt,
      category: typeof rec.category === 'string' ? rec.category : undefined
    });
  }
  return out;
}

function buildDefaultPermissionInfo(level: PermissionLevel): PermissionInfo {
  return {
    level,
    canRead: true,
    canChat: level === 'L1' || level === 'L2',
    canWriteFsGitPty: level === 'L2',
    hostOnlyElevation: true,
    levels: [
      { level: 'L0', label: 'L0 只读', description: '仅查看对话、文件、Diff 与监控指标' },
      { level: 'L1', label: 'L1 对话审批', description: '可发消息、插队、审批命令与回答提问' },
      { level: 'L2', label: 'L2 完整操作', description: '含文件写入、Git 提交推送与 PTY 终端（仅主机端开启）' }
    ]
  };
}

export class RemoteStoreController {
  private state: RemoteState;
  private listeners = new Set<() => void>();
  private sse: RemoteSseClient | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private flushingQueue = false;
  private prevAttentionIds = new Set<string>();
  private initialized = false;
  private pendingUserModelId = '';
  private optimisticSeq = 0;
  private pendingSwitchTicket = '';

  constructor() {
    const urlInit = extractTokenAndScrubUrl();
    this.pendingSwitchTicket = urlInit.switchTicket;
    const appearance = readAppearance();
    applyAppearance(appearance);
    let colorTheme: ColorThemeId = 'monochrome';
    let drawerSpeed: DrawerSpeedId = 'normal';
    let locale: SupportedLocale = 'zh-CN';
    try {
      colorTheme =
        normalizeColorTheme(window.localStorage?.getItem(COLOR_THEME_STORAGE_KEY)) || 'monochrome';
      drawerSpeed =
        normalizeDrawerSpeed(window.localStorage?.getItem(DRAWER_SPEED_STORAGE_KEY)) || 'normal';
      locale = normalizeLocale(window.localStorage?.getItem(LOCALE_STORAGE_KEY)) || 'zh-CN';
    } catch {}
    const cachedPins = normalizePins(readJsonPref<SessionPins>(PINS_CACHE_KEY, EMPTY_PINS));
    const cachedGroups = readJsonPref<SessionGroup[]>(GROUPS_CACHE_KEY, []);
    const cachedOrchThinking = sanitizeOrchestratorThinkingMap(
      readJsonPref<Partial<OrchestratorThinkingMap>>(ORCH_THINKING_KEY, DEFAULT_ORCHESTRATOR_THINKING)
    );
    const cachedOrchMaster = readJsonPref<OrchestratorMasterKey | null>(ORCH_ACTIVE_MASTER_KEY, null);

    this.state = {
      token: urlInit.token,
      enteredFromLanding: urlInit.enteredFromLanding,
      ready: false,
      authError: '',
      online: typeof navigator !== 'undefined' ? navigator.onLine !== false : true,
      rpcConnected: true,
      sseStatus: 'disconnected',
      bootstrap: null,
      channel: 'loopback',
      apiBaseOrigin: getApiBaseOrigin(),
      permissionLevel: 'L0',
      permissionInfo: buildDefaultPermissionInfo('L0'),
      models: [],
      modelGroups: [],
      modelPickerOpen: false,
      orchestratorThinking: cachedOrchThinking,
      activeOrchestratorMaster: matchOrchestratorMasterKey(cachedOrchMaster),
      modelPreferences: { sortMode: 'custom', filterOrder: [], usageCounts: {} },
      sessions: [],
      groups: Array.isArray(cachedGroups) ? cachedGroups : [],
      projects: [],
      pins: cachedPins,
      activeSessionId: urlInit.sessionId,
      activeSession: null,
      events: [],
      loadingSession: false,
      telemetry: {},
      runningTasksCount: 0,
      presets: [],
      quickPrompts: [],
      frequentPrompts: [],
      composerSettings: { showQuickBar: true, ghostSuggest: true, showPromptOptimizer: true },
      selectedModelId: '',
      chatMode: 'chat',
      dispatchMode: 'queue',
      composerText: '',
      composerImages: [],
      queue: [],
      changedFilesCount: 0,
      appearance,
      colorTheme,
      drawerSpeed,
      locale,
      soundAlert: readBoolPref(SOUND_KEY, true),
      vibrateAlert: readBoolPref(VIBRATE_KEY, true),
      pushSubscribed: false,
      pushBusy: false,
      leftOpen: false,
      rightOpen: false,
      rightTab: 'diff',
      contextExpanded: false,
      activeSheet: null,
      telemetryTab: 'context',
      hideSystemEvents: false,
      thinkingExpandVersion: 0,
      thinkingExpandTarget: null,
      confirmPrompt: null,
      toast: '',
      inspectTargetFile: ''
    };

    configureApiClient({
      getToken: () => this.state.token,
      onConfirmRequired: (hint) => this.requestConfirm(hint)
    });
  }

  public getState = (): RemoteState => this.state;

  public subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private setState(patch: Partial<RemoteState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  public showToast(msg: string, ms = 2600): void {
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.setState({ toast: msg });
    this.toastTimer = setTimeout(() => {
      this.setState({ toast: '' });
      this.toastTimer = null;
    }, ms);
  }

  private requestConfirm(hint: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.setState({
        confirmPrompt: {
          title: '高危操作二次确认',
          hint,
          resolve: (confirmed: boolean) => {
            this.setState({ confirmPrompt: null });
            resolve(confirmed);
          }
        }
      });
    });
  }

  public async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const refreshed = extractTokenAndScrubUrl();
    const switchTicket = this.pendingSwitchTicket || refreshed.switchTicket;
    if (switchTicket) {
      this.pendingSwitchTicket = '';
      try {
        const redeemed = await api.redeemSwitchTicket(switchTicket);
        if (redeemed?.authToken) {
          saveToken(redeemed.authToken);
          this.setState({
            token: redeemed.authToken,
            activeSessionId: redeemed.sessionId || this.state.activeSessionId || refreshed.sessionId,
            composerText: redeemed.draftText || this.state.composerText,
            enteredFromLanding: true
          });
          if (redeemed.sessionId && redeemed.draftText) {
            saveDraft(redeemed.sessionId, redeemed.draftText).catch(() => {});
          }
        }
      } catch {
        this.showToast('跨协议切通道票据已过期，请重新扫码或输入令牌');
      } finally {
        scrubSwitchTicketFromUrl();
      }
    } else if (!this.state.token && refreshed.token) {
      this.setState({
        token: refreshed.token,
        activeSessionId: this.state.activeSessionId || refreshed.sessionId,
        enteredFromLanding: refreshed.enteredFromLanding
      });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.setState({ online: true });
        this.flushPendingQueue();
      });
      window.addEventListener('offline', () => {
        this.setState({ online: false });
      });
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (ev) => {
          const data = ev.data as { type?: string; sessionId?: string } | null;
          if (data?.type === 'NAVIGATE_SESSION' && data.sessionId) {
            this.selectSession(data.sessionId);
          }
        });
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    this.sse = new RemoteSseClient({
      onStatusChange: (sseStatus) => this.setState({ sseStatus }),
      onSessionDelta: (payload) => this.handleSessionDelta(payload),
      onAttentionUpdate: (payload) => this.handleAttentionUpdate(payload),
      onTelemetryPatch: (payload) => this.handleTelemetryPatch(payload),
      onQueueUpdate: (payload) => this.handleQueueUpdate(payload),
      onStatePatch: (payload) => this.handleStatePatch(payload),
      onTaskUpdated: (payload) => this.handleTaskUpdated(payload)
    });

    const [cachedSessions, cachedQueue, cachedDraft] = await Promise.all([
      loadSessionsCache(),
      loadQueue(),
      loadDraft(this.state.activeSessionId)
    ]);

    const initialSessionId =
      this.state.activeSessionId || (cachedSessions[0]?.cascadeId ?? '');
    let cachedSnap = null;
    if (initialSessionId) {
      cachedSnap = await loadSessionSnapshot(initialSessionId);
    }

    this.setState({
      sessions: cachedSessions.length > 0 ? cachedSessions : this.state.sessions,
      activeSessionId: initialSessionId,
      activeSession: cachedSnap?.session ?? null,
      events: cachedSnap?.events ?? [],
      queue: cachedQueue,
      composerText: cachedDraft || this.state.composerText,
      ready: cachedSessions.length > 0
    });

    getActivePushSubscription()
      .then((sub) => this.setState({ pushSubscribed: Boolean(sub) }))
      .catch(() => {});

    if (this.state.token) {
      await this.connectAndSync();
    } else {
      this.setState({ ready: true });
    }
  }

  private handleVisibilityChange = (): void => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden' || document.hidden) {
      void flushDraftSave().catch(() => {});
      void flushSnapshotSave().catch(() => {});
    }
  };

  public destroy(): void {
    this.sse?.destroy();
    this.sse = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    void flushDraftSave().catch(() => {});
    void flushSnapshotSave().catch(() => {});
    this.initialized = false;
  }

  public async submitManualToken(rawToken: string): Promise<void> {
    const clean = rawToken.trim();
    if (!clean) return;
    saveToken(clean);
    this.setState({ token: clean, authError: '' });
    await this.connectAndSync();
  }

  public logoutToken(): void {
    clearSavedToken();
    this.sse?.destroy();
    void flushDraftSave().catch(() => {});
    void flushSnapshotSave().catch(() => {});
    this.setState({
      token: '',
      bootstrap: null,
      authError: '',
      sseStatus: 'disconnected',
      activeSessionId: '',
      activeSession: null,
      events: [],
      sessions: [],
      queue: [],
      composerText: '',
      composerImages: []
    });
  }

  public async connectAndSync(): Promise<void> {
    if (!this.state.token) return;
    try {
      const boot = await api.bootstrap();
      const initialTelemetry: TelemetryPanels =
        boot.telemetry?.panels || boot.panels || this.state.telemetry;

      const modelPreferences: ModelPreferences = {
        sortMode: boot.modelPreferences?.sortMode || 'custom',
        filterOrder: Array.isArray(boot.modelPreferences?.filterOrder) ? boot.modelPreferences.filterOrder : [],
        usageCounts: boot.modelPreferences?.usageCounts || {}
      };
      const orchestratorThinking = boot.orchestratorThinking
        ? sanitizeOrchestratorThinkingMap({ ...this.state.orchestratorThinking, ...boot.orchestratorThinking })
        : this.state.orchestratorThinking;
      writeJsonPref(ORCH_THINKING_KEY, orchestratorThinking);

      // Preserve ALL real Antigravity models (including MODEL_PLACEHOLDER_* with valid labels)
      // and build multi-level thinking + 4-master orchestrator groups with filter/sort preferences
      const catalog = normalizeModelCatalog(boot.models, boot.modelGroups);
      const modelGroups = groupModelsForPicker(boot.models, boot.modelGroups, modelPreferences);

      const currentValid = catalog.some((m) => m.id === this.state.selectedModelId)
        ? this.state.selectedModelId
        : '';
      const bootDefault =
        boot.defaultModelId && catalog.some((m) => m.id === boot.defaultModelId)
          ? boot.defaultModelId
          : '';
      const selectedModelId =
        currentValid ||
        bootDefault ||
        catalog.find((m) => m.isDefault && !m.disabled)?.id ||
        catalog.find((m) => !m.disabled)?.id ||
        catalog[0]?.id ||
        '';

      const permissionLevel: PermissionLevel =
        boot.permissionLevel || (boot.writeEnabled ? 'L1' : 'L0');
      const permissionInfo: PermissionInfo =
        boot.permissionInfo || buildDefaultPermissionInfo(permissionLevel);

      const bootPins = boot.pins ? normalizePins(boot.pins) : this.state.pins;
      const bootGroups = Array.isArray(boot.groups) ? boot.groups : this.state.groups;
      const bootProjects = Array.isArray(boot.projects) ? boot.projects : this.state.projects;

      this.setState({
        bootstrap: { ...boot, models: catalog },
        models: catalog,
        modelGroups,
        orchestratorThinking,
        modelPreferences,
        channel: boot.channel || 'loopback',
        rpcConnected: boot.rpcConnected !== false,
        runningTasksCount: Number(boot.runningTasksCount ?? boot.telemetry?.runningTasksCount ?? 0),
        permissionLevel,
        permissionInfo,
        selectedModelId,
        telemetry: initialTelemetry,
        groups: bootGroups,
        projects: bootProjects,
        pins: bootPins,
        authError: '',
        ready: true
      });

      const [sessRes, presetsRes] = await Promise.all([
        api.listSessions({ limit: 200 }),
        api.getPresets().catch(() => null)
      ]);

      const rawSessions = Array.isArray(sessRes.sessions) ? sessRes.sessions : [];
      const resolvedPins = normalizePins(sessRes.pins || boot.pins || this.state.pins);
      const resolvedGroups = Array.isArray(sessRes.groups)
        ? sessRes.groups
        : bootGroups;
      const resolvedProjects = Array.isArray(sessRes.projects) && sessRes.projects.length > 0
        ? sessRes.projects
        : bootProjects.length > 0
          ? bootProjects
          : buildFallbackProjects(rawSessions, boot.workspaces, resolvedPins);

      const pinnedOrg = applyPinsToOrg(rawSessions, resolvedProjects, resolvedGroups, resolvedPins);
      saveSessionsCache(pinnedOrg.sessions).catch(() => {});
      writeJsonPref(PINS_CACHE_KEY, resolvedPins);
      writeJsonPref(GROUPS_CACHE_KEY, pinnedOrg.groups);
      this.recordAttentionSet(pinnedOrg.sessions);

      const presets: ComposerPreset[] = presetsRes
        ? sanitizePresets([
            ...(Array.isArray(presetsRes.presets) ? presetsRes.presets : []),
            ...(Array.isArray(presetsRes.quickPrompts) ? presetsRes.quickPrompts : []),
            ...(Array.isArray(presetsRes.frequentPrompts) ? presetsRes.frequentPrompts : [])
          ])
        : [];
      const quickPrompts: ComposerQuickPrompt[] = Array.isArray(presetsRes?.quickPrompts)
        ? presetsRes.quickPrompts
            .map((item, idx) => {
              const r = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
              const tpl = String(r.template ?? r.prompt ?? r.text ?? '').trim();
              const lbl = String(r.label ?? r.title ?? tpl).trim();
              if (!tpl || !lbl) return null;
              return {
                id: String(r.id || `qp-${idx}`),
                label: lbl,
                template: tpl,
                category: typeof r.category === 'string' ? r.category : undefined
              } as ComposerQuickPrompt;
            })
            .filter((x): x is ComposerQuickPrompt => Boolean(x))
        : [];
      const frequentPrompts: string[] = Array.isArray(presetsRes?.frequentPrompts)
        ? presetsRes.frequentPrompts
            .map((item) => {
              if (typeof item === 'string') return item.trim();
              if (item && typeof item === 'object') {
                const r = item as Record<string, unknown>;
                return String(r.template ?? r.prompt ?? r.text ?? r.label ?? '').trim();
              }
              return '';
            })
            .filter(Boolean)
        : [];
      const composerSettings: ComposerSettingsDto = presetsRes?.settings
        ? {
            showQuickBar: presetsRes.settings.showQuickBar !== false,
            ghostSuggest: presetsRes.settings.ghostSuggest !== false,
            showPromptOptimizer: presetsRes.settings.showPromptOptimizer !== false,
            ...(presetsRes.settings.autoCompactThresholdTokens !== undefined
              ? { autoCompactThresholdTokens: presetsRes.settings.autoCompactThresholdTokens }
              : {})
          }
        : this.state.composerSettings;

      const targetId =
        (this.state.activeSessionId &&
          pinnedOrg.sessions.some((s) => s.cascadeId === this.state.activeSessionId) &&
          this.state.activeSessionId) ||
        pinnedOrg.sessions[0]?.cascadeId ||
        this.state.activeSessionId;

      this.setState({
        sessions: pinnedOrg.sessions,
        groups: pinnedOrg.groups,
        projects: pinnedOrg.projects,
        pins: resolvedPins,
        presets,
        quickPrompts,
        frequentPrompts,
        composerSettings,
        rpcConnected: sessRes.rpcConnected !== false && boot.rpcConnected !== false,
        activeSessionId: targetId
      });

      if (targetId) {
        await this.loadSessionDetail(targetId);
        this.syncSessionQueue(targetId);
      }

      this.sse?.connect(this.state.token, targetId || '', this.state.apiBaseOrigin);
      this.refreshDiffBadge();
      if (!initialTelemetry?.context) {
        api
          .snapshotFallback()
          .then((snap) => {
            if (snap?.panels) this.setState({ telemetry: snap.panels });
          })
          .catch(() => {});
      }
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 401 || e.status === 403) {
        this.setState({ authError: '访问令牌无效或通道未授权', ready: true });
      } else {
        this.setState({ ready: true });
        this.showToast(`连接失败: ${e.message || '网络不可达'}`);
      }
    }
  }

  public async refreshSessionsAndOrg(): Promise<void> {
    if (!this.state.token) return;
    try {
      const sessRes = await api.listSessions({ limit: 200 });
      const rawSessions = Array.isArray(sessRes.sessions) ? sessRes.sessions : this.state.sessions;
      const resolvedPins = normalizePins(sessRes.pins || this.state.pins);
      const resolvedGroups = Array.isArray(sessRes.groups) ? sessRes.groups : this.state.groups;
      const resolvedProjects =
        Array.isArray(sessRes.projects) && sessRes.projects.length > 0
          ? sessRes.projects
          : buildFallbackProjects(rawSessions, this.state.bootstrap?.workspaces, resolvedPins);
      const pinnedOrg = applyPinsToOrg(rawSessions, resolvedProjects, resolvedGroups, resolvedPins);
      saveSessionsCache(pinnedOrg.sessions).catch(() => {});
      writeJsonPref(PINS_CACHE_KEY, resolvedPins);
      writeJsonPref(GROUPS_CACHE_KEY, pinnedOrg.groups);
      this.setState({
        sessions: pinnedOrg.sessions,
        groups: pinnedOrg.groups,
        projects: pinnedOrg.projects,
        pins: resolvedPins
      });
    } catch {}
  }

  public async togglePin(kind: PinKind, id: string, explicitPinned?: boolean): Promise<void> {
    if (!id) return;
    const key = kind === 'session' ? 'sessions' : kind === 'project' ? 'projects' : 'groups';
    const currentList = this.state.pins[key];
    const isCurrentlyPinned = currentList.includes(id);
    const targetPinned = typeof explicitPinned === 'boolean' ? explicitPinned : !isCurrentlyPinned;

    const optimisticPins: SessionPins = {
      ...this.state.pins,
      [key]: targetPinned
        ? Array.from(new Set([id, ...currentList]))
        : currentList.filter((item) => item !== id)
    };
    const optimisticOrg = applyPinsToOrg(
      this.state.sessions,
      this.state.projects,
      this.state.groups,
      optimisticPins
    );
    this.setState({
      pins: optimisticPins,
      sessions: optimisticOrg.sessions,
      projects: optimisticOrg.projects,
      groups: optimisticOrg.groups
    });
    writeJsonPref(PINS_CACHE_KEY, optimisticPins);

    if (this.state.token && this.state.online) {
      try {
        const res = await api.toggleSessionPin({ type: kind, id, pinned: targetPinned });
        if (res.pins) {
          const syncedPins = normalizePins(res.pins);
          const syncedOrg = applyPinsToOrg(
            this.state.sessions,
            this.state.projects,
            this.state.groups,
            syncedPins
          );
          this.setState({
            pins: syncedPins,
            sessions: syncedOrg.sessions,
            projects: syncedOrg.projects,
            groups: syncedOrg.groups
          });
          writeJsonPref(PINS_CACHE_KEY, syncedPins);
        }
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === 'PERMISSION_DENIED') {
          this.showToast('当前为 L0 只读模式，置顶已暂存本地');
        }
      }
    }
  }

  public async createGroup(
    name: string,
    opts?: { projectIds?: string[]; workspaceUris?: string[]; sessionIds?: string[] }
  ): Promise<void> {
    const clean = name.trim();
    if (!clean) return;
    if (this.state.token && this.state.online) {
      try {
        const res = await api.mutateSessionGroups({
          action: 'upsert',
          name: clean,
          projectIds: opts?.projectIds,
          workspaceUris: opts?.workspaceUris,
          sessionIds: opts?.sessionIds
        });
        if (Array.isArray(res.groups)) {
          const syncedPins = res.pins ? normalizePins(res.pins) : this.state.pins;
          const syncedOrg = applyPinsToOrg(
            this.state.sessions,
            this.state.projects,
            res.groups,
            syncedPins
          );
          this.setState({
            groups: syncedOrg.groups,
            pins: syncedPins
          });
          writeJsonPref(GROUPS_CACHE_KEY, syncedOrg.groups);
          this.showToast(`已创建分组「${clean}」`);
          return;
        }
      } catch (err) {
        this.showToast(`创建分组失败: ${(err as Error).message}`);
        return;
      }
    }
    // Offline fallback
    const localGroup: SessionGroup = {
      id: `grp_${Date.now()}`,
      name: clean,
      source: 'user',
      pinned: false,
      order: this.state.groups.length,
      projectIds: opts?.projectIds || [],
      workspaceUris: opts?.workspaceUris || [],
      sessionIds: opts?.sessionIds || []
    };
    const nextGroups = [...this.state.groups, localGroup];
    this.setState({ groups: nextGroups });
    writeJsonPref(GROUPS_CACHE_KEY, nextGroups);
    this.showToast(`已在本地创建分组「${clean}」`);
  }

  public async deleteGroup(groupId: string): Promise<void> {
    if (!groupId) return;
    const prevGroups = this.state.groups;
    const nextGroups = prevGroups.filter((g) => g.id !== groupId);
    this.setState({ groups: nextGroups });
    writeJsonPref(GROUPS_CACHE_KEY, nextGroups);
    if (this.state.token && this.state.online) {
      try {
        const res = await api.mutateSessionGroups({ action: 'delete', id: groupId });
        if (Array.isArray(res.groups)) {
          this.setState({ groups: res.groups });
          writeJsonPref(GROUPS_CACHE_KEY, res.groups);
        }
      } catch (err) {
        this.setState({ groups: prevGroups });
        this.showToast(`删除分组失败: ${(err as Error).message}`);
      }
    }
  }

  public async assignProjectGroup(
    groupId: string | null,
    target: { projectId?: string; sessionId?: string; workspaceUri?: string }
  ): Promise<void> {
    if (this.state.token && this.state.online) {
      try {
        const res = await api.mutateSessionGroups({
          action: 'assign',
          groupId,
          projectId: target.projectId,
          sessionId: target.sessionId,
          workspaceUri: target.workspaceUri
        });
        if (Array.isArray(res.groups)) {
          const syncedPins = res.pins ? normalizePins(res.pins) : this.state.pins;
          const nextProjects = this.state.projects.map((p) =>
            target.projectId && p.id === target.projectId ? { ...p, groupId } : p
          );
          const nextSessions = this.state.sessions.map((s) =>
            target.sessionId && s.cascadeId === target.sessionId ? { ...s, groupId } : s
          );
          const syncedOrg = applyPinsToOrg(nextSessions, nextProjects, res.groups, syncedPins);
          this.setState({
            groups: syncedOrg.groups,
            projects: syncedOrg.projects,
            sessions: syncedOrg.sessions,
            pins: syncedPins
          });
          writeJsonPref(GROUPS_CACHE_KEY, syncedOrg.groups);
          return;
        }
      } catch (err) {
        this.showToast(`分组调整失败: ${(err as Error).message}`);
        return;
      }
    }
    const nextProjects = this.state.projects.map((p) =>
      target.projectId && p.id === target.projectId ? { ...p, groupId } : p
    );
    this.setState({ projects: nextProjects });
  }

  public async selectSession(cascadeId: string): Promise<void> {
    if (!cascadeId) return;
    const prevId = this.state.activeSessionId;
    await Promise.all([
      flushDraftSave(prevId).catch(() => {}),
      prevId !== cascadeId ? flushSnapshotSave().catch(() => {}) : Promise.resolve()
    ]);
    const [snap, draft] = await Promise.all([
      loadSessionSnapshot(cascadeId),
      loadDraft(cascadeId)
    ]);

    this.setState({
      activeSessionId: cascadeId,
      activeSession: snap?.session ?? null,
      events: snap?.events ?? [],
      composerText: draft,
      leftOpen: false
    });

    if (this.state.token) {
      this.sse?.connect(this.state.token, cascadeId);
      await this.loadSessionDetail(cascadeId);
      this.syncSessionQueue(cascadeId);
      this.refreshDiffBadge();
    }
  }

  public async loadSessionDetail(cascadeId: string): Promise<void> {
    if (!cascadeId || !this.state.token) return;
    const seqAtStart = this.optimisticSeq;
    this.setState({ loadingSession: true });
    try {
      const res = await api.getSession(cascadeId);
      if (this.state.activeSessionId !== cascadeId) return;
      const serverEvents = Array.isArray(res.events) ? res.events : [];
      const inFlightOptimistic = this.state.events.filter(
        (ev) => ev.seq < 0 && Math.abs(ev.seq) > seqAtStart
      );
      const events =
        inFlightOptimistic.length > 0
          ? mergeEvents(serverEvents, inFlightOptimistic)
          : serverEvents.slice().sort(compareSessionEvents);
      this.setState({
        activeSession: res.session || null,
        events,
        loadingSession: false
      });
      saveSessionSnapshot(
        cascadeId,
        res.session || null,
        events.filter((ev) => ev.seq >= 0)
      ).catch(() => {});
    } catch {
      this.setState({ loadingSession: false });
    }
  }

  public async syncSessionQueue(cascadeId: string): Promise<void> {
    if (!cascadeId || !this.state.token || !this.state.online) return;
    try {
      const res = await api.listSessionQueue(cascadeId);
      if (Array.isArray(res.queue)) {
        this.replaceServerQueueForSession(cascadeId, res.queue);
      }
    } catch {}
  }

  private replaceServerQueueForSession(
    sessionId: string,
    rawQueue: unknown[],
    eventsOverride?: SessionEvent[]
  ): void {
    const normalizedServer = rawQueue
      .map((item) => normalizeQueueItem(item, sessionId))
      .filter((item): item is QueuedMessage => Boolean(item));
    const others = this.state.queue.filter(
      (q) => q.sessionId !== sessionId || (q.source === 'local' && !this.state.online)
    );
    const next = [...others, ...normalizedServer];
    const unchanged =
      next.length === this.state.queue.length &&
      next.every((item, idx) => {
        const cur = this.state.queue[idx];
        return (
          cur &&
          cur.id === item.id &&
          cur.queueId === item.queueId &&
          cur.status === item.status &&
          cur.dispatchMode === item.dispatchMode &&
          cur.text === item.text &&
          cur.source === item.source
        );
      });
    if (unchanged) {
      if (eventsOverride) {
        this.setState({ events: eventsOverride });
      }
      return;
    }
    this.setState(eventsOverride ? { queue: next, events: eventsOverride } : { queue: next });
    saveQueue(next).catch(() => {});
  }

  public async createNewSession(title?: string, workspaceUri?: string): Promise<void> {
    try {
      const res = await api.createSession({ title, workspaceUri });
      await this.refreshSessionsAndOrg();
      if (res.cascadeId) {
        await this.selectSession(res.cascadeId);
      }
    } catch (err) {
      this.showToast(`新建会话失败: ${(err as Error).message}`);
    }
  }

  public getActiveWorkspaceRoot(): string {
    const active = this.state.sessions.find((s) => s.cascadeId === this.state.activeSessionId);
    const fromSession = normalizeRootUri(active?.workspaceUri);
    if (fromSession) return fromSession;
    const firstProj = this.state.projects[0];
    if (firstProj?.path || firstProj?.uri) return normalizeRootUri(firstProj.path || firstProj.uri);
    const firstWs = this.state.bootstrap?.workspaces?.[0];
    if (typeof firstWs === 'string') return normalizeRootUri(firstWs);
    return normalizeRootUri(firstWs?.path || firstWs?.uri);
  }

  public async refreshDiffBadge(): Promise<void> {
    const root = this.getActiveWorkspaceRoot();
    if (!root || !this.state.token) return;
    try {
      const diff = await api.getGitDiff(root);
      this.setState({ changedFilesCount: Array.isArray(diff.files) ? diff.files.length : 0 });
    } catch {}
  }

  private recordAttentionSet(sessions: SessionSummary[]): void {
    const nextIds = new Set<string>();
    let newlyTriggered = false;
    for (const s of sessions) {
      if (s.needsAttention) {
        nextIds.add(s.cascadeId);
        if (!this.prevAttentionIds.has(s.cascadeId)) {
          newlyTriggered = true;
        }
      }
    }
    this.prevAttentionIds = nextIds;
    if (newlyTriggered) {
      triggerForegroundAlert({
        sound: this.state.soundAlert,
        vibrate: this.state.vibrateAlert
      });
    }
  }

  private handleSessionDelta(payload: Record<string, unknown>): void {
    const sessObj =
      payload.session && typeof payload.session === 'object'
        ? (payload.session as Record<string, unknown>)
        : null;

    const cascadeId = String(
      payload.cascadeId || payload.sessionId || sessObj?.cascadeId || ''
    ).trim();
    const status = String(
      (typeof payload.status === 'string' && payload.status) ||
        (typeof sessObj?.status === 'string' && sessObj.status) ||
        ''
    );
    const rawTotal = payload.totalSteps ?? sessObj?.numTotalSteps;
    const totalSteps =
      typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : undefined;
    const incomingEvents = Array.isArray(payload.events) ? (payload.events as SessionEvent[]) : [];

    const patch: Partial<RemoteState> = {};

    if (cascadeId) {
      let sessionsChanged = false;
      const nextSessions = this.state.sessions.map((s) => {
        if (s.cascadeId !== cascadeId) return s;
        const nextStatus = status || s.status;
        const nextStepCount = totalSteps !== undefined ? totalSteps : s.stepCount;
        if (nextStatus === s.status && nextStepCount === s.stepCount) {
          return s;
        }
        sessionsChanged = true;
        return {
          ...s,
          status: nextStatus,
          stepCount: nextStepCount
        };
      });
      if (sessionsChanged) {
        patch.sessions = nextSessions;
      }
    }

    const isActive = Boolean(cascadeId && cascadeId === this.state.activeSessionId);
    let mergedEvents = this.state.events;
    let nextDetail = this.state.activeSession;

    if (isActive) {
      mergedEvents = mergeEvents(this.state.events, incomingEvents);
      if (mergedEvents !== this.state.events) {
        patch.events = mergedEvents;
      }

      if (this.state.activeSession) {
        const nextStatus = status || this.state.activeSession.status;
        const nextNumTotalSteps =
          totalSteps !== undefined ? totalSteps : this.state.activeSession.numTotalSteps;
        if (
          nextStatus !== this.state.activeSession.status ||
          nextNumTotalSteps !== this.state.activeSession.numTotalSteps
        ) {
          nextDetail = {
            ...this.state.activeSession,
            status: nextStatus,
            numTotalSteps: nextNumTotalSteps
          };
          patch.activeSession = nextDetail;
        }
      } else if (sessObj) {
        nextDetail = {
          cascadeId,
          trajectoryId: typeof sessObj.trajectoryId === 'string' ? sessObj.trajectoryId : null,
          status: status || 'IDLE',
          numTotalSteps: totalSteps ?? mergedEvents.length,
          metadata:
            sessObj.metadata && typeof sessObj.metadata === 'object'
              ? (sessObj.metadata as Record<string, unknown>)
              : null
        };
        patch.activeSession = nextDetail;
      }
    }

    if (Object.keys(patch).length > 0) {
      this.setState(patch);
    }

    if (isActive) {
      const activeSummaryStatus =
        this.state.sessions.find((s) => s.cascadeId === cascadeId)?.status || '';
      const effectiveStatus = (status || nextDetail?.status || activeSummaryStatus).toUpperCase();
      const isStreaming =
        effectiveStatus.includes('RUNNING') || effectiveStatus.includes('GENERATING');
      const confirmedEvents = mergedEvents.filter((ev) => ev.seq >= 0);
      if (isStreaming) {
        scheduleSnapshotSave(cascadeId, nextDetail, confirmedEvents);
      } else {
        scheduleSnapshotSave(cascadeId, nextDetail, confirmedEvents);
        void flushSnapshotSave(cascadeId).catch(() => {});
      }

      if (status && status.toUpperCase().includes('IDLE')) {
        this.flushPendingQueue();
      }
    }
  }

  private handleAttentionUpdate(payload: Record<string, unknown>): void {
    if (Array.isArray(payload.sessions)) {
      const list = payload.sessions as SessionSummary[];
      const pinnedOrg = applyPinsToOrg(list, this.state.projects, this.state.groups, this.state.pins);
      this.recordAttentionSet(pinnedOrg.sessions);
      this.setState({ sessions: pinnedOrg.sessions });
      saveSessionsCache(pinnedOrg.sessions).catch(() => {});
      return;
    }
    const cascadeId = String(payload.cascadeId || payload.sessionId || '');
    if (!cascadeId) return;
    const nextSessions = this.state.sessions.map((s) =>
      s.cascadeId === cascadeId
        ? {
            ...s,
            status: typeof payload.status === 'string' && payload.status ? payload.status : s.status,
            needsAttention: Boolean(payload.needsAttention),
            attentionReason:
              typeof payload.attentionReason === 'string'
                ? payload.attentionReason
                : s.attentionReason
          }
        : s
    );
    this.recordAttentionSet(nextSessions);
    this.setState({ sessions: nextSessions });
  }

  private handleTelemetryPatch(payload: Record<string, unknown>): void {
    const panels = (payload.panels as TelemetryPanels | undefined) || (payload as TelemetryPanels);
    const merged: TelemetryPanels = { ...this.state.telemetry, ...panels };
    if (this.pendingUserModelId && merged.context?.available && merged.context.data) {
      const chosen = this.state.models.find((m) => m.id === this.pendingUserModelId);
      merged.context = {
        ...merged.context,
        data: {
          ...merged.context.data,
          model: chosen?.label || this.pendingUserModelId
        }
      };
    }
    const patch: Partial<RemoteState> = { telemetry: merged };
    if (typeof payload.runningTasksCount === 'number' && Number.isFinite(payload.runningTasksCount)) {
      patch.runningTasksCount = payload.runningTasksCount;
    }
    this.setState(patch);
  }

  private handleStatePatch(payload: Record<string, unknown>): void {
    const key = typeof payload.key === 'string' ? payload.key : '';
    const val = payload.value as Record<string, unknown> | undefined;
    if (key === 'state:host.locale@1' && val) {
      const nextLocale = normalizeLocale(val.bcp47 || val.locale || val.lang);
      if (nextLocale) {
        try {
          window.localStorage?.setItem(LOCALE_STORAGE_KEY, nextLocale);
        } catch {}
        if (typeof document !== 'undefined') document.documentElement.lang = nextLocale;
        this.setState({ locale: nextLocale });
      }
    } else if (key === 'state:composer.settings@1' && val) {
      const raw = (val.settings && typeof val.settings === 'object'
        ? val.settings
        : val) as Record<string, unknown>;
      this.setState({
        composerSettings: {
          showQuickBar: raw.showQuickBar !== false,
          ghostSuggest: raw.ghostSuggest !== false,
          showPromptOptimizer: raw.showPromptOptimizer !== false,
          ...(Number.isFinite(Number(raw.autoCompactThresholdTokens))
            ? { autoCompactThresholdTokens: Number(raw.autoCompactThresholdTokens) }
            : {})
        }
      });
    }
  }

  private handleTaskUpdated(payload: Record<string, unknown>): void {
    if (typeof payload.runningCount === 'number' && Number.isFinite(payload.runningCount)) {
      this.setState({ runningTasksCount: payload.runningCount });
    }
  }

  private handleQueueUpdate(payload: Record<string, unknown>): void {
    const cascadeId = String(payload.cascadeId || payload.sessionId || this.state.activeSessionId || '');
    if (Array.isArray(payload.queue)) {
      if (cascadeId) {
        this.replaceServerQueueForSession(cascadeId, payload.queue);
      } else {
        const next = payload.queue
          .map((item) => normalizeQueueItem(item, this.state.activeSessionId))
          .filter((item): item is QueuedMessage => Boolean(item));
        this.setState({ queue: next });
        saveQueue(next).catch(() => {});
      }
      return;
    }
    const action = String(payload.action || '');
    const item = normalizeQueueItem(payload.item, cascadeId);
    if (!item) return;
    if (action === 'removed' || action === 'dispatched' || action === 'steered') {
      const next = this.state.queue.filter((q) => q.id !== item.id && q.queueId !== item.id);
      this.setState({ queue: next });
      saveQueue(next).catch(() => {});
    } else if (action === 'failed') {
      const next = this.state.queue.map((q) =>
        q.id === item.id || q.queueId === item.id
          ? {
              ...q,
              status: 'failed' as const,
              error: typeof payload.error === 'string' ? payload.error : '发送失败'
            }
          : q
      );
      this.setState({ queue: next });
      saveQueue(next).catch(() => {});
    } else if (action === 'dispatching') {
      const next = this.state.queue.map((q) =>
        q.id === item.id || q.queueId === item.id ? { ...q, status: 'sending' as const } : q
      );
      this.setState({ queue: next });
      saveQueue(next).catch(() => {});
    }
  }

  public setComposerText(text: string): void {
    this.setState({ composerText: text });
    scheduleDraftSave(this.state.activeSessionId, text);
  }

  public injectQuoteToComposer(snippet: string): void {
    const prev = this.state.composerText.trim();
    const next = prev ? `${prev}\n\n${snippet}\n` : `${snippet}\n`;
    this.setComposerText(next);
    this.setState({ rightOpen: false });
    this.showToast('已回注到输入框');
  }

  public addComposerImage(img: ImageAttachment): void {
    this.setState({ composerImages: [...this.state.composerImages, img].slice(0, 4) });
  }

  public removeComposerImage(id: string): void {
    this.setState({
      composerImages: this.state.composerImages.filter((i) => i.id !== id)
    });
  }

  public setModelId(modelId: string): void {
    this.pendingUserModelId = modelId;
    const chosen = this.state.models.find((m) => m.id === modelId);
    const nextMaster = chosen?.isOrchestrator
      ? (matchOrchestratorMasterKey(chosen.orchestratorMaster || chosen.orchestratorVariant || chosen.label || modelId) ?? this.state.activeOrchestratorMaster)
      : null;
    writeJsonPref(ORCH_ACTIVE_MASTER_KEY, nextMaster);
    const nextTelemetry: TelemetryPanels =
      this.state.telemetry.context?.available && this.state.telemetry.context.data
        ? {
            ...this.state.telemetry,
            context: {
              ...this.state.telemetry.context,
              data: {
                ...this.state.telemetry.context.data,
                model: chosen?.label || modelId
              }
            }
          }
        : this.state.telemetry;
    this.setState({
      selectedModelId: modelId,
      activeOrchestratorMaster: nextMaster,
      telemetry: nextTelemetry
    });
  }

  public async setOrchestratorModel(
    modelId: string,
    masterKey: OrchestratorMasterKey,
    thinkingLevel: OrchestratorThinkingTier
  ): Promise<void> {
    const nextMap: OrchestratorThinkingMap = {
      ...this.state.orchestratorThinking,
      [masterKey]: thinkingLevel
    };
    writeJsonPref(ORCH_THINKING_KEY, nextMap);
    writeJsonPref(ORCH_ACTIVE_MASTER_KEY, masterKey);
    this.pendingUserModelId = modelId;

    const chosen = this.state.models.find((m) => m.id === modelId);
    const displayLabel = `编排 · ${masterKey} · ${thinkingLevel}`;
    const nextTelemetry: TelemetryPanels =
      this.state.telemetry.context?.available && this.state.telemetry.context.data
        ? {
            ...this.state.telemetry,
            context: {
              ...this.state.telemetry.context,
              data: {
                ...this.state.telemetry.context.data,
                model: chosen?.label || displayLabel
              }
            }
          }
        : this.state.telemetry;

    this.setState({
      selectedModelId: modelId,
      orchestratorThinking: nextMap,
      activeOrchestratorMaster: masterKey,
      telemetry: nextTelemetry
    });

    if (
      this.state.token &&
      this.state.online &&
      (this.state.permissionLevel === 'L1' || this.state.permissionLevel === 'L2')
    ) {
      try {
        const res = await api.updateOrchestratorThinking({ master: masterKey, thinkingLevel });
        if (res?.orchestratorThinking) {
          const synced = sanitizeOrchestratorThinkingMap(res.orchestratorThinking);
          writeJsonPref(ORCH_THINKING_KEY, synced);
          this.setState({ orchestratorThinking: synced });
        }
      } catch {}
    }
  }

  public setChatMode(chatMode: ChatMode): void {
    this.setState({ chatMode });
  }

  public setDispatchMode(dispatchMode: DispatchMode): void {
    this.setState({ dispatchMode });
  }

  public isSessionRunning(): boolean {
    const active = this.state.sessions.find((s) => s.cascadeId === this.state.activeSessionId);
    const st = (this.state.activeSession?.status || active?.status || '').toUpperCase();
    return st.includes('RUNNING');
  }

  public async sendMessage(overrideDispatch?: DispatchMode): Promise<void> {
    const text = this.state.composerText.trim();
    const images = this.state.composerImages;
    if (!text && images.length === 0) return;

    const initialActiveId = this.state.activeSessionId;
    let sessionId = initialActiveId;
    if (!sessionId && this.state.online && this.state.token) {
      const created = await api.createSession({ title: text.slice(0, 32) });
      sessionId = created.cascadeId;
      this.setState({ activeSessionId: sessionId });
      this.sse?.connect(this.state.token, sessionId);
    }
    if (!sessionId) {
      this.showToast('请先创建或选择会话');
      return;
    }

    const mode = this.state.chatMode;
    const modelId = this.state.selectedModelId || undefined;
    // Default while running is 'queue'; switching to 'steer' happens on the queued item after sending.
    const dispatchMode: DispatchMode = overrideDispatch || 'queue';
    const payloadImages = images.map((i) => ({ dataUrl: i.dataUrl, mime: i.mime }));

    if (!this.state.online) {
      const qItem: QueuedMessage = {
        id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        sessionId,
        cascadeId: sessionId,
        text,
        modelId,
        mode,
        images: payloadImages.length > 0 ? payloadImages : undefined,
        dispatchMode,
        createdAt: Date.now(),
        status: 'queued',
        source: 'local'
      };
      const nextQ = [...this.state.queue, qItem];
      this.setState({ queue: nextQ, composerText: '', composerImages: [] });
      await Promise.all([
        saveQueue(nextQ),
        saveDraft(sessionId, ''),
        initialActiveId !== sessionId ? saveDraft(initialActiveId, '') : Promise.resolve()
      ]);
      this.showToast('离线草稿已入队，恢复后自动发送');
      return;
    }

    const nextOptId = ++this.optimisticSeq;
    const clientTempId = `opt_${Date.now()}_${nextOptId}`;
    const optimisticEvent: SessionEvent<OptimisticUserPayload> = {
      seq: -nextOptId,
      kind: 'user',
      status: 'pending',
      rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
      payload: {
        text,
        images: payloadImages,
        clientTempId,
        optimistic: true
      }
    };

    try {
      this.pendingUserModelId = '';
      const optimisticEvents =
        this.state.activeSessionId === sessionId
          ? [...this.state.events, optimisticEvent].sort(compareSessionEvents)
          : this.state.events;
      this.setState({
        composerText: '',
        composerImages: [],
        events: optimisticEvents
      });
      saveDraft(sessionId, '').catch(() => {});
      if (initialActiveId !== sessionId) {
        saveDraft(initialActiveId, '').catch(() => {});
      }

      const res = await api.sendMessage(sessionId, {
        text,
        modelId,
        mode,
        images: payloadImages.length > 0 ? payloadImages : undefined,
        dispatchMode
      });

      if (res.queued) {
        const cleanedEvents = this.state.events.filter(
          (ev) => ev.payload?.clientTempId !== clientTempId
        );
        if (Array.isArray(res.queue)) {
          this.replaceServerQueueForSession(sessionId, res.queue, cleanedEvents);
        } else {
          const item = normalizeQueueItem(
            res.item || {
              id: res.queueId || `q_${Date.now()}`,
              queueId: res.queueId,
              sessionId,
              text,
              modelId,
              mode,
              images: payloadImages.length > 0 ? payloadImages : undefined,
              dispatchMode,
              createdAt: Date.now(),
              status: 'queued',
              source: 'server'
            },
            sessionId
          );
          const exists = item ? this.state.queue.some((q) => q.id === item.id) : true;
          const nextQ = item && !exists ? [...this.state.queue, item] : this.state.queue;
          this.setState({
            events: cleanedEvents,
            ...(nextQ !== this.state.queue ? { queue: nextQ } : {})
          });
          if (item && !exists) {
            await saveQueue(nextQ);
          }
        }
        this.showToast('已加入发送队列，可在消息上点「立即插队」');
        return;
      }

      if (this.state.sseStatus !== 'connected') {
        void this.loadSessionDetail(sessionId);
      }
    } catch (err) {
      const cleanedEvents = this.state.events.filter(
        (ev) => ev.payload?.clientTempId !== clientTempId
      );
      const canRestoreComposer =
        this.state.activeSessionId === sessionId &&
        !this.state.composerText &&
        this.state.composerImages.length === 0;
      this.setState({
        events: cleanedEvents,
        ...(canRestoreComposer ? { composerText: text, composerImages: images } : {})
      });
      if (canRestoreComposer && text) {
        saveDraft(sessionId, text).catch(() => {});
      }
      this.showToast(`发送失败: ${(err as Error).message}`);
    }
  }

  public async steerQueuedMessage(id: string): Promise<void> {
    const target = this.state.queue.find((q) => q.id === id || q.queueId === id);
    if (!target) return;

    // Mark sending optimistically
    this.setState({
      queue: this.state.queue.map((q) =>
        q.id === target.id ? { ...q, status: 'sending' as const, dispatchMode: 'steer' } : q
      )
    });

    try {
      if (this.state.online && this.state.token && target.source !== 'local') {
        const res = await api.steerQueuedMessage(target.sessionId, target.queueId || target.id);
        if (Array.isArray(res.queue)) {
          this.replaceServerQueueForSession(target.sessionId, res.queue);
        } else {
          const remaining = this.state.queue.filter((q) => q.id !== target.id);
          this.setState({ queue: remaining });
          await saveQueue(remaining);
        }
        this.showToast('已立即插队发送');
        if (this.state.sseStatus !== 'connected') {
          void this.loadSessionDetail(target.sessionId);
        }
        return;
      }

      // Local-only queue item fallback: send directly as steer
      await api.sendMessage(target.sessionId, {
        text: target.text,
        modelId: target.modelId,
        mode: target.mode,
        images: target.images,
        dispatchMode: 'steer'
      });
      const remaining = this.state.queue.filter((q) => q.id !== target.id);
      this.setState({ queue: remaining });
      await saveQueue(remaining);
      this.showToast('已立即插队发送');
      if (this.state.sseStatus !== 'connected') {
        void this.loadSessionDetail(target.sessionId);
      }
    } catch (err) {
      const failed = this.state.queue.map((q) =>
        q.id === target.id
          ? { ...q, status: 'failed' as const, error: (err as Error).message }
          : q
      );
      this.setState({ queue: failed });
      await saveQueue(failed);
      this.showToast(`插队失败: ${(err as Error).message}`);
    }
  }

  public async editQueuedMessage(id: string): Promise<void> {
    const target = this.state.queue.find((q) => q.id === id || q.queueId === id);
    if (!target) return;
    const prevText = this.state.composerText.trim();
    const mergedText = prevText ? `${target.text}\n${prevText}` : target.text;
    this.setComposerText(mergedText);
    if (target.mode === 'plan') {
      this.setChatMode('plan');
    }
    await this.removeQueuedMessage(target.id);
    this.showToast('已移回输入框编辑');
  }

  public async retryQueuedMessage(id: string): Promise<void> {
    const target = this.state.queue.find((q) => q.id === id || q.queueId === id);
    if (!target) return;
    if (!this.state.online) {
      this.showToast('当前离线，恢复网络后将自动重试');
      return;
    }
    this.setState({
      queue: this.state.queue.map((q) =>
        q.id === target.id ? { ...q, status: 'sending' as const, error: undefined } : q
      )
    });
    try {
      const res = await api.sendMessage(target.sessionId, {
        text: target.text,
        modelId: target.modelId,
        mode: target.mode,
        images: target.images,
        dispatchMode: target.dispatchMode || 'queue'
      });
      if (res.queued && Array.isArray(res.queue)) {
        this.replaceServerQueueForSession(target.sessionId, res.queue);
      } else {
        const remaining = this.state.queue.filter((q) => q.id !== target.id);
        this.setState({ queue: remaining });
        await saveQueue(remaining);
        if (this.state.sseStatus !== 'connected') {
          void this.loadSessionDetail(target.sessionId);
        }
      }
    } catch (err) {
      const failed = this.state.queue.map((q) =>
        q.id === target.id
          ? { ...q, status: 'failed' as const, error: (err as Error).message }
          : q
      );
      this.setState({ queue: failed });
      await saveQueue(failed);
      this.showToast(`重试失败: ${(err as Error).message}`);
    }
  }

  public async flushPendingQueue(): Promise<void> {
    if (this.flushingQueue || !this.state.online || !this.state.token) return;
    if (this.isSessionRunning()) return;
    // Only flush locally-queued items (server-queued items are dispatched by sse-broker)
    const pending = this.state.queue.filter(
      (q) =>
        q.status === 'queued' &&
        q.source === 'local' &&
        q.sessionId === this.state.activeSessionId
    );
    if (pending.length === 0) return;

    this.flushingQueue = true;
    try {
      const next = pending[0];
      const updating = this.state.queue.map((q) =>
        q.id === next.id ? { ...q, status: 'sending' as const } : q
      );
      this.setState({ queue: updating });

      await api.sendMessage(next.sessionId, {
        text: next.text,
        modelId: next.modelId,
        mode: next.mode,
        images: next.images,
        dispatchMode: next.dispatchMode
      });

      const remaining = this.state.queue.filter((q) => q.id !== next.id);
      this.setState({ queue: remaining });
      await saveQueue(remaining);
      if (this.state.sseStatus !== 'connected') {
        void this.loadSessionDetail(next.sessionId);
      }
    } catch (err) {
      const failed = this.state.queue.map((q) =>
        q.status === 'sending'
          ? { ...q, status: 'failed' as const, error: (err as Error).message }
          : q
      );
      this.setState({ queue: failed });
      await saveQueue(failed);
    } finally {
      this.flushingQueue = false;
    }
  }

  public async removeQueuedMessage(id: string): Promise<void> {
    const target = this.state.queue.find((q) => q.id === id || q.queueId === id);
    const next = this.state.queue.filter((q) => q.id !== id && q.queueId !== id);
    this.setState({ queue: next });
    await saveQueue(next);
    if (target && this.state.online && this.state.token && target.source !== 'local') {
      try {
        const res = await api.removeQueuedMessage(target.sessionId, target.queueId || target.id);
        if (Array.isArray(res.queue)) {
          this.replaceServerQueueForSession(target.sessionId, res.queue);
        }
      } catch {}
    }
  }

  public async cancelActiveSession(): Promise<void> {
    if (!this.state.activeSessionId) return;
    try {
      await api.cancelSession(this.state.activeSessionId);
      this.showToast('已发送中断请求');
    } catch (err) {
      this.showToast(`中断失败: ${(err as Error).message}`);
    }
  }

  public async approveStep(seq: number, decision: 'allow' | 'deny'): Promise<void> {
    if (!this.state.activeSessionId) return;
    try {
      await api.approveStep(this.state.activeSessionId, seq, decision);
      await this.loadSessionDetail(this.state.activeSessionId);
    } catch (err) {
      this.showToast(`审批失败: ${(err as Error).message}`);
    }
  }

  public async answerStep(seq: number, answers: unknown): Promise<void> {
    if (!this.state.activeSessionId) return;
    try {
      await api.answerStep(this.state.activeSessionId, seq, answers);
      await this.loadSessionDetail(this.state.activeSessionId);
    } catch (err) {
      this.showToast(`提交回答失败: ${(err as Error).message}`);
    }
  }

  public async optimizeComposerPrompt(): Promise<string | null> {
    const text = this.state.composerText.trim();
    if (!text) return null;
    try {
      const res = await api.optimizePrompt(text);
      const next = res.optimizedText || res.text || text;
      this.setComposerText(next);
      this.showToast(res.unchanged ? '提示词已足够清晰' : '已优化提示词');
      return next;
    } catch (err) {
      this.showToast(`优化失败: ${(err as Error).message}`);
      return null;
    }
  }

  public setAppearance(next: AppearanceMode): void {
    applyAppearance(next);
    try {
      window.localStorage?.setItem(APPEARANCE_KEY, next);
    } catch {}
    this.setState({ appearance: next });
  }

  public cycleAppearance(): void {
    const order: AppearanceMode[] = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(this.state.appearance) + 1) % order.length];
    this.setAppearance(next);
  }

  public setColorTheme(next: ColorThemeId): void {
    try {
      window.localStorage?.setItem(COLOR_THEME_STORAGE_KEY, next);
    } catch {}
    this.setState({ colorTheme: next });
  }

  public setDrawerSpeed(next: DrawerSpeedId): void {
    try {
      window.localStorage?.setItem(DRAWER_SPEED_STORAGE_KEY, next);
    } catch {}
    this.setState({ drawerSpeed: next });
  }

  public async setLocale(next: SupportedLocale): Promise<void> {
    try {
      window.localStorage?.setItem(LOCALE_STORAGE_KEY, next);
    } catch {}
    if (typeof document !== 'undefined') {
      document.documentElement.lang = next;
    }
    this.setState({ locale: next });
    if (this.state.token && this.state.online) {
      try {
        const res = await api.setLocale(next);
        if (res?.localOnly) {
          this.showToast('当前为 L0 模式，语言已在手机本地生效');
        }
      } catch {}
    }
  }

  public toggleSoundAlert(): void {
    const next = !this.state.soundAlert;
    try {
      window.localStorage?.setItem(SOUND_KEY, next ? '1' : '0');
    } catch {}
    this.setState({ soundAlert: next });
  }

  public toggleVibrateAlert(): void {
    const next = !this.state.vibrateAlert;
    try {
      window.localStorage?.setItem(VIBRATE_KEY, next ? '1' : '0');
    } catch {}
    this.setState({ vibrateAlert: next });
  }

  public async togglePushSubscription(): Promise<void> {
    this.setState({ pushBusy: true });
    try {
      if (this.state.pushSubscribed) {
        await unsubscribeWebPush();
        this.setState({ pushSubscribed: false, pushBusy: false });
        this.showToast('已关闭锁屏推送');
      } else {
        await subscribeWebPush(this.state.bootstrap?.vapidPublicKey);
        this.setState({ pushSubscribed: true, pushBusy: false });
        this.showToast('已开启锁屏推送');
      }
    } catch (err) {
      this.setState({ pushBusy: false });
      this.showToast((err as Error).message || '推送设置失败');
    }
  }

  public async sendTestPush(): Promise<void> {
    try {
      await api.testPush();
      this.showToast('已触发测试推送');
    } catch (err) {
      this.showToast(`测试推送失败: ${(err as Error).message}`);
    }
  }

  public setLeftOpen(open: boolean): void {
    this.setState({ leftOpen: open, rightOpen: open ? false : this.state.rightOpen });
  }

  public setRightOpen(open: boolean, tab?: RightTabId): void {
    this.setState({
      rightOpen: open,
      leftOpen: open ? false : this.state.leftOpen,
      rightTab: tab || this.state.rightTab
    });
  }

  public setRightTab(tab: RightTabId): void {
    this.setState({ rightTab: tab });
  }

  public inspectFileInDrawer(filePath: string): void {
    this.setState({
      inspectTargetFile: filePath,
      rightOpen: true,
      leftOpen: false,
      rightTab: 'files'
    });
  }

  public openRightDrawerDiffForFile(filePath: string): void {
    this.setState({
      inspectTargetFile: filePath,
      rightOpen: true,
      leftOpen: false,
      rightTab: 'diff'
    });
  }

  public setModelPickerOpen(open: boolean): void {
    this.setState({
      modelPickerOpen: open,
      activeSheet: open ? 'modelPicker' : this.state.activeSheet === 'modelPicker' ? null : this.state.activeSheet
    });
  }

  public setActiveSheet(sheet: ActiveSheetId, telemetryTab?: 'context' | 'usage' | 'quota'): void {
    this.setState({
      activeSheet: sheet,
      contextExpanded: sheet === 'telemetry',
      modelPickerOpen: sheet === 'modelPicker',
      ...(telemetryTab ? { telemetryTab } : {})
    });
  }

  public setTelemetryTab(tab: 'context' | 'usage' | 'quota'): void {
    this.setState({ telemetryTab: tab });
  }

  public toggleContextPanel(force?: boolean): void {
    const next = typeof force === 'boolean' ? force : !this.state.contextExpanded;
    this.setState({
      contextExpanded: next,
      activeSheet: next ? 'telemetry' : this.state.activeSheet === 'telemetry' ? null : this.state.activeSheet
    });
  }

  public setHideSystemEvents(hide: boolean): void {
    this.setState({ hideSystemEvents: hide });
  }

  public setThinkingExpandAll(expand: boolean): void {
    this.setState({
      thinkingExpandVersion: this.state.thinkingExpandVersion + 1,
      thinkingExpandTarget: expand
    });
  }

  public setRunningTasksCount(runningTasksCount: number): void {
    this.setState({ runningTasksCount: Math.max(0, Number(runningTasksCount) || 0) });
  }

  public reconnectSse(): void {
    this.sse?.reconnect();
    if (this.state.token) {
      void this.connectAndSync();
    }
  }

  public async compactActiveSession(): Promise<boolean> {
    if (!this.state.activeSessionId) {
      this.showToast('请先选择一个会话');
      return false;
    }
    try {
      await api.compactSession(this.state.activeSessionId);
      this.showToast('已派发 /compact 上下文压缩');
      return true;
    } catch (err) {
      this.showToast(`压缩失败: ${(err as Error).message}`);
      return false;
    }
  }

  public async switchApiChannelInPage(entry: ChannelEntryDto): Promise<void> {
    setApiBaseOrigin(entry.origin);
    this.setState({
      channel: entry.key,
      apiBaseOrigin: entry.origin
    });
    this.sse?.setBaseOrigin(entry.origin);
    this.sse?.reconnect();
    this.showToast(`已切换至 ${entry.label}`);
    try {
      const boot = await api.bootstrap();
      const nextTelemetry = boot.telemetry?.panels || boot.panels || this.state.telemetry;
      this.setState({
        bootstrap: { ...boot, models: this.state.models.length > 0 ? this.state.models : normalizeModelCatalog(boot.models, boot.modelGroups) },
        channel: boot.channel || entry.key,
        telemetry: nextTelemetry,
        runningTasksCount: Number(boot.runningTasksCount ?? this.state.runningTasksCount ?? 0),
        rpcConnected: boot.rpcConnected !== false
      });
    } catch {}
  }

  public async switchChannelWithTicket(entry: ChannelEntryDto): Promise<void> {
    const res = await api.createSwitchTicket({
      targetChannel: entry.key,
      sessionId: this.state.activeSessionId || null,
      draftText: this.state.composerText || ''
    });
    const nextUrl = `${entry.origin.replace(/\/+$/, '')}/?enter=1&switch_ticket=${encodeURIComponent(res.ticket)}`;
    if (typeof window !== 'undefined') {
      window.location.assign(nextUrl);
    }
  }
}

export const remoteStore = new RemoteStoreController();

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) return false;
    }
    return true;
  }
  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    ) {
      return false;
    }
  }
  return true;
}

export function useRemoteSelector<T>(
  selector: (s: RemoteState) => T,
  isEqual: (a: T, b: T) => boolean = shallowEqual
): T {
  const selectorRef = useRef(selector);
  const isEqualRef = useRef(isEqual);
  selectorRef.current = selector;
  isEqualRef.current = isEqual;

  const [slice, setSlice] = useState<T>(() => selector(remoteStore.getState()));
  const sliceRef = useRef(slice);
  sliceRef.current = slice;

  useEffect(() => {
    const syncIfChanged = () => {
      const next = selectorRef.current(remoteStore.getState());
      if (!isEqualRef.current(sliceRef.current, next)) {
        sliceRef.current = next;
        setSlice(() => next);
      }
    };
    syncIfChanged();
    return remoteStore.subscribe(syncIfChanged);
  }, []);

  return slice;
}

export function useRemoteStore(): RemoteState {
  const [snap, setSnap] = useState<RemoteState>(remoteStore.getState);
  useEffect(() => remoteStore.subscribe(() => setSnap(remoteStore.getState())), []);
  return snap;
}
