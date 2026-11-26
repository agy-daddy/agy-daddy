import type { ComponentType } from 'preact';
import { Component, type ComponentChildren } from 'preact';
import { memo } from 'preact/compat';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { ChangeReviewStrip } from './chat/ChangeReviewStrip';
import { ChatNavDock } from './chat/ChatNavDock';
import { Composer } from './chat/Composer';
import { ModelPickerSheet } from './chat/ModelPickerSheet';
import { PendingFloatingCard } from './chat/PendingFloatingCard';
import { VirtualChatList } from './chat/VirtualChatList';
import { LeftDrawer } from './drawers/LeftDrawer';
import { RightDrawer } from './drawers/RightDrawer';
import { createTranslator, I18nProvider, useI18n } from './i18n';
import { SwipeDrawerShell } from './layout/SwipeDrawerShell';
import { TopBar } from './layout/TopBar';
import { BackgroundTasksSheet } from './sheets/BackgroundTasksSheet';
import { ChannelSwitcherSheet } from './sheets/ChannelSwitcherSheet';
import { CustomMenuSheet } from './sheets/CustomMenuSheet';
import { TelemetrySheet } from './sheets/TelemetrySheet';
import {
  formatCompactModelBadge,
  remoteStore,
  resolveUnifiedModelName,
  useRemoteSelector
} from './store/useRemoteStore';
import { ThemeProvider } from './theme/ThemeProvider';
import styles from './App.module.css';

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ComponentChildren }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  private handleReset = () => {
    remoteStore.setLeftOpen(false);
    remoteStore.setRightOpen(false);
    remoteStore.setActiveSheet(null);
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      const tr = createTranslator(remoteStore.getState().locale);
      return (
        <div className="ag-shell">
          <div className={styles.authCard} data-testid="error-boundary-fallback">
            <strong style={{ fontSize: 15 }}>{tr('app.errorTitle')}</strong>
            <div style={{ fontSize: 12.5, color: 'var(--ag-secondary)' }}>
              {this.state.error.message || tr('chat.unknownError')}
            </div>
            <button
              type="button"
              className="ag-pill-btn ag-pill-btn-primary"
              onClick={this.handleReset}
            >
              {tr('app.resetUi')}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function ConnectedProviders({ children }: { children: ComponentChildren }) {
  const s = useRemoteSelector((st) => ({
    appearance: st.appearance,
    colorTheme: st.colorTheme,
    drawerSpeed: st.drawerSpeed,
    locale: st.locale
  }));

  return (
    <I18nProvider
      locale={s.locale}
      onLocaleChange={(next) => {
        void remoteStore.setLocale(next);
      }}
    >
      <ThemeProvider
        appearance={s.appearance}
        colorTheme={s.colorTheme}
        drawerSpeed={s.drawerSpeed}
        onAppearanceChange={(next) => remoteStore.setAppearance(next)}
        onColorThemeChange={(next) => remoteStore.setColorTheme(next)}
        onDrawerSpeedChange={(next) => remoteStore.setDrawerSpeed(next)}
      >
        {children}
      </ThemeProvider>
    </I18nProvider>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <ConnectedProviders>
        <AppInner />
      </ConnectedProviders>
    </ErrorBoundary>
  );
}

const EMPTY_WORKSPACES: never[] = [];

const ConnectedLeftDrawer = memo(function ConnectedLeftDrawer() {
  const s = useRemoteSelector((st) => ({
    sessions: st.sessions,
    archivedList: st.archivedList,
    archivedCount: st.archivedCount,
    activeSessionId: st.activeSessionId,
    bootstrapWorkspaces: st.bootstrap?.workspaces,
    groups: st.groups,
    projects: st.projects,
    pins: st.pins,
    groupOrder: st.groupOrder,
    projectOrder: st.projectOrder,
    sessionOrder: st.sessionOrder,
    channel: st.channel,
    permissionLevel: st.permissionLevel,
    token: st.token,
    appearance: st.appearance,
    soundAlert: st.soundAlert,
    vibrateAlert: st.vibrateAlert,
    pushSubscribed: st.pushSubscribed,
    pushBusy: st.pushBusy
  }));

  return (
    <LeftDrawer
      sessions={s.sessions}
      archivedList={s.archivedList}
      archivedCount={s.archivedCount}
      activeSessionId={s.activeSessionId}
      workspaces={s.bootstrapWorkspaces || EMPTY_WORKSPACES}
      groups={s.groups}
      projects={s.projects}
      pins={s.pins}
      groupOrder={s.groupOrder}
      projectOrder={s.projectOrder}
      sessionOrder={s.sessionOrder}
      channel={s.channel}
      permissionLevel={s.permissionLevel}
      token={s.token}
      appearance={s.appearance}
      soundAlert={s.soundAlert}
      vibrateAlert={s.vibrateAlert}
      pushSubscribed={s.pushSubscribed}
      pushBusy={s.pushBusy}
      onSelectSession={(id) => remoteStore.selectSession(id)}
      onCreateSession={(title, ws) => remoteStore.createNewSession(title, ws)}
      onTogglePin={(kind, id, nextPinned) => remoteStore.togglePin(kind, id, nextPinned)}
      onCreateGroup={(name) => remoteStore.createGroup(name)}
      onRenameGroup={(groupId, name) => remoteStore.renameGroup(groupId, name)}
      onDeleteGroup={(groupId) => remoteStore.deleteGroup(groupId)}
      onToggleGroupCollapsed={(groupId, collapsed) =>
        remoteStore.toggleGroupCollapsed(groupId, collapsed)
      }
      onAssignProjectGroup={(groupId, target) => remoteStore.assignProjectGroup(groupId, target)}
      onRenameProject={(projectId, name) => remoteStore.renameProject(projectId, name)}
      onRemoveProject={(projectId) => remoteStore.removeProject(projectId)}
      onReorderOrg={(req) => remoteStore.reorderOrg(req)}
      onArchiveSession={(cascadeId, archived) => remoteStore.archiveSession(cascadeId, archived)}
      onDeleteSession={(cascadeId, mode) => remoteStore.deleteSession(cascadeId, mode)}
      onLoadArchived={() => remoteStore.loadArchivedSessions()}
      onDraggingOrgChange={(dragging) => remoteStore.setDraggingOrg(dragging)}
      onOpenNewProject={() => remoteStore.setActiveSheet('newProject')}
      onCycleAppearance={() => remoteStore.cycleAppearance()}
      onToggleSound={() => remoteStore.toggleSoundAlert()}
      onToggleVibrate={() => remoteStore.toggleVibrateAlert()}
      onTogglePush={() => remoteStore.togglePushSubscription()}
      onTestPush={() => remoteStore.sendTestPush()}
      onOpenChannels={() => remoteStore.setActiveSheet('channels')}
      onClose={() => remoteStore.setLeftOpen(false)}
    />
  );
});

const ConnectedRightDrawer = memo(function ConnectedRightDrawer() {
  const s = useRemoteSelector((st) => ({
    rightOpen: st.rightOpen,
    rightTab: st.rightTab,
    activeSessionId: st.activeSessionId,
    activeSessionMeta: st.activeSession?.metadata,
    sessions: st.sessions,
    bootstrapWorkspaces: st.bootstrap?.workspaces,
    permissionLevel: st.permissionLevel,
    token: st.token,
    inspectTargetFile: st.inspectTargetFile
  }));

  const activeRoot = useMemo(() => remoteStore.getActiveWorkspaceRoot(), [
    s.activeSessionId,
    s.activeSessionMeta,
    s.sessions,
    s.bootstrapWorkspaces
  ]);

  return (
    <RightDrawer
      open={s.rightOpen}
      activeTab={s.rightTab}
      rootPath={activeRoot}
      sessionId={s.activeSessionId}
      permissionLevel={s.permissionLevel}
      token={s.token}
      inspectTargetFile={s.inspectTargetFile}
      onSelectTab={(tab) => remoteStore.setRightTab(tab)}
      onClose={() => remoteStore.setRightOpen(false)}
      onInjectQuote={(snippet) => remoteStore.injectQuoteToComposer(snippet)}
      onShowToast={(msg) => remoteStore.showToast(msg)}
      onRefreshDiffBadge={() => remoteStore.refreshDiffBadge()}
    />
  );
});

const ConnectedTopBar = memo(function ConnectedTopBar() {
  const { t } = useI18n();
  const s = useRemoteSelector((st) => ({
    sessions: st.sessions,
    activeSessionId: st.activeSessionId,
    changedFilesCount: st.changedFilesCount,
    runningTasksCount: st.runningTasksCount,
    permissionLevel: st.permissionLevel,
    telemetry: st.telemetry,
    activeSheet: st.activeSheet,
    telemetryTab: st.telemetryTab
  }));

  const activeSessionSummary = useMemo(
    () => s.sessions.find((item) => item.cascadeId === s.activeSessionId) || null,
    [s.sessions, s.activeSessionId]
  );

  const attentionCount = useMemo(
    () => s.sessions.filter((item) => item.needsAttention && !item.isSubagent).length,
    [s.sessions]
  );

  const activeTitle =
    activeSessionSummary?.title ||
    (s.activeSessionId
      ? t('app.sessionFallback', { id: s.activeSessionId.slice(0, 8) })
      : t('app.title'));

  return (
    <TopBar
      title={activeTitle}
      attentionCount={attentionCount}
      changedFilesCount={s.changedFilesCount}
      runningTasksCount={s.runningTasksCount}
      permissionLevel={s.permissionLevel}
      telemetry={s.telemetry}
      contextExpanded={s.activeSheet === 'telemetry'}
      onOpenLeft={() => remoteStore.setLeftOpen(true)}
      onOpenRight={() => remoteStore.setRightOpen(true)}
      onToggleContext={(tab) => {
        if (s.activeSheet === 'telemetry' && (!tab || s.telemetryTab === tab)) {
          remoteStore.setActiveSheet(null);
        } else {
          remoteStore.setActiveSheet('telemetry', tab || 'context');
        }
      }}
      onOpenTasks={() => remoteStore.setActiveSheet('tasks')}
      onOpenMenu={() => remoteStore.setActiveSheet('menu')}
      onReconnect={() => remoteStore.reconnectSse()}
    />
  );
});

const ConnectedChangeStrip = memo(function ConnectedChangeStrip() {
  const s = useRemoteSelector((st) => ({
    events: st.events,
    changedFilesCount: st.changedFilesCount
  }));

  return (
    <ChangeReviewStrip
      events={s.events}
      changedFilesCount={s.changedFilesCount}
      onReviewFile={(filePath) => remoteStore.openRightDrawerDiffForFile(filePath)}
      onOpenDiffDrawer={() => remoteStore.setRightOpen(true, 'diff')}
    />
  );
});

interface StreamNavProps {
  searchQuery: string;
  searchRegex: boolean;
  searchCaseSensitive: boolean;
  jumpTarget: { seq: number; nonce: number } | null;
  scrollBottomNonce: number;
  scrollTopNonce: number;
}

const ConnectedVirtualChatList = memo(function ConnectedVirtualChatList({
  searchQuery,
  searchRegex,
  searchCaseSensitive,
  jumpTarget,
  scrollBottomNonce,
  scrollTopNonce
}: StreamNavProps) {
  const s = useRemoteSelector((st) => ({
    events: st.events,
    loadingSession: st.loadingSession,
    activeSessionId: st.activeSessionId,
    permissionLevel: st.permissionLevel,
    queue: st.queue,
    hideSystemEvents: st.hideSystemEvents,
    thinkingExpandVersion: st.thinkingExpandVersion,
    thinkingExpandTarget: st.thinkingExpandTarget
  }));

  return (
    <VirtualChatList
      events={s.events}
      loading={s.loadingSession}
      activeSessionId={s.activeSessionId}
      permissionLevel={s.permissionLevel}
      hideSystemEvents={s.hideSystemEvents}
      thinkingExpandVersion={s.thinkingExpandVersion}
      thinkingExpandTarget={s.thinkingExpandTarget}
      searchQuery={searchQuery}
      searchRegex={searchRegex}
      searchCaseSensitive={searchCaseSensitive}
      currentMatchSeq={jumpTarget?.seq ?? null}
      jumpTarget={jumpTarget}
      scrollBottomNonce={scrollBottomNonce}
      scrollTopNonce={scrollTopNonce}
      onInspectFile={(filePath) => remoteStore.inspectFileInDrawer(filePath)}
      onViewDiffFile={(filePath) => remoteStore.openRightDrawerDiffForFile(filePath)}
      onApprove={(seq, decision) => remoteStore.approveStep(seq, decision)}
      onAnswer={(seq, answers) => remoteStore.answerStep(seq, answers)}
      queue={s.queue}
      onSteerQueueItem={(id) => remoteStore.steerQueuedMessage(id)}
      onRemoveQueueItem={(id) => remoteStore.removeQueuedMessage(id)}
      onEditQueueItem={(id) => remoteStore.editQueuedMessage(id)}
      onRetryQueueItem={(id) => remoteStore.retryQueuedMessage(id)}
    />
  );
});

const ConnectedChatNavDock = memo(function ConnectedChatNavDock({
  searchQuery,
  searchRegex,
  searchCaseSensitive,
  onSearchChange,
  onJumpToSeq,
  onScrollTop,
  onScrollBottom
}: {
  searchQuery: string;
  searchRegex: boolean;
  searchCaseSensitive: boolean;
  onSearchChange: (next: { query: string; regex: boolean; caseSensitive: boolean }) => void;
  onJumpToSeq: (seq: number) => void;
  onScrollTop: () => void;
  onScrollBottom: () => void;
}) {
  const { t } = useI18n();
  const s = useRemoteSelector((st) => ({
    events: st.events,
    activeSessionId: st.activeSessionId,
    sessions: st.sessions,
    hideSystemEvents: st.hideSystemEvents,
    thinkingExpandTarget: st.thinkingExpandTarget,
    telemetry: st.telemetry,
    models: st.models,
    bootstrapModels: st.bootstrap?.models,
    bootstrapModelGroups: st.bootstrap?.modelGroups,
    selectedModelId: st.selectedModelId
  }));

  const activeSessionSummary = useMemo(
    () => s.sessions.find((item) => item.cascadeId === s.activeSessionId) || null,
    [s.sessions, s.activeSessionId]
  );

  const catalogModels = useMemo(
    () => (s.models.length > 0 ? s.models : s.bootstrapModels || []),
    [s.models, s.bootstrapModels]
  );

  const modelName = useMemo(
    () =>
      resolveUnifiedModelName(
        s.telemetry,
        catalogModels,
        s.selectedModelId,
        s.bootstrapModelGroups
      ),
    [s.telemetry, catalogModels, s.selectedModelId, s.bootstrapModelGroups]
  );

  return (
    <ChatNavDock
      events={s.events}
      sessionId={s.activeSessionId}
      sessionTitle={activeSessionSummary?.title || t('app.title')}
      modelName={modelName}
      hideSystemEvents={s.hideSystemEvents}
      thinkingExpandedAll={s.thinkingExpandTarget === true}
      searchQuery={searchQuery}
      searchRegex={searchRegex}
      searchCaseSensitive={searchCaseSensitive}
      onSearchChange={onSearchChange}
      onJumpToSeq={onJumpToSeq}
      onScrollTop={onScrollTop}
      onScrollBottom={onScrollBottom}
      onToggleThinkingAll={(expand) => remoteStore.setThinkingExpandAll(expand)}
      onToggleHideSystem={(hide) => remoteStore.setHideSystemEvents(hide)}
      onShowToast={(msg) => remoteStore.showToast(msg)}
    />
  );
});

const ConnectedStreamStage = memo(function ConnectedStreamStage() {
  const [search, setSearch] = useState({ query: '', regex: false, caseSensitive: false });
  const [jumpTarget, setJumpTarget] = useState<{ seq: number; nonce: number } | null>(null);
  const [scrollBottomNonce, setScrollBottomNonce] = useState(0);
  const [scrollTopNonce, setScrollTopNonce] = useState(0);

  const handleJumpToSeq = useCallback((seq: number) => {
    setJumpTarget((prev) => ({ seq, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  const handleScrollTop = useCallback(() => setScrollTopNonce((n) => n + 1), []);
  const handleScrollBottom = useCallback(() => setScrollBottomNonce((n) => n + 1), []);

  return (
    <div className={styles.streamStage}>
      <ConnectedVirtualChatList
        searchQuery={search.query}
        searchRegex={search.regex}
        searchCaseSensitive={search.caseSensitive}
        jumpTarget={jumpTarget}
        scrollBottomNonce={scrollBottomNonce}
        scrollTopNonce={scrollTopNonce}
      />
      <ConnectedChatNavDock
        searchQuery={search.query}
        searchRegex={search.regex}
        searchCaseSensitive={search.caseSensitive}
        onSearchChange={setSearch}
        onJumpToSeq={handleJumpToSeq}
        onScrollTop={handleScrollTop}
        onScrollBottom={handleScrollBottom}
      />
    </div>
  );
});

const ConnectedPendingFloatingCard = memo(function ConnectedPendingFloatingCard() {
  const s = useRemoteSelector((st) => ({
    events: st.events,
    permissionLevel: st.permissionLevel
  }));

  const pendingEvent = useMemo(
    () =>
      s.events.find(
        (ev) => ev.status === 'pending' && ev.kind !== 'user' && ev.payload?.optimistic !== true
      ) || null,
    [s.events]
  );

  return (
    <PendingFloatingCard
      pendingEvent={pendingEvent}
      permissionLevel={s.permissionLevel}
      onApprove={(seq, decision) => remoteStore.approveStep(seq, decision)}
      onAnswer={(seq, answers) => remoteStore.answerStep(seq, answers)}
    />
  );
});

const ConnectedComposer = memo(function ConnectedComposer() {
  const s = useRemoteSelector((st) => {
    const activeSummary = st.sessions.find((item) => item.cascadeId === st.activeSessionId);
    const statusUpper = (st.activeSession?.status || activeSummary?.status || '').toUpperCase();
    return {
      composerText: st.composerText,
      composerImages: st.composerImages,
      presets: st.presets,
      quickPrompts: st.quickPrompts,
      frequentPrompts: st.frequentPrompts,
      composerSettings: st.composerSettings,
      models: st.models,
      bootstrapModels: st.bootstrap?.models,
      bootstrapModelGroups: st.bootstrap?.modelGroups,
      bootstrapModelTree: st.bootstrap?.modelTree,
      voiceSupported: Boolean(st.bootstrap?.voiceSupported),
      modelGroups: st.modelGroups,
      selectedModelId: st.selectedModelId,
      orchestratorThinking: st.orchestratorThinking,
      activeOrchestratorMaster: st.activeOrchestratorMaster,
      chatMode: st.chatMode,
      dispatchMode: st.dispatchMode,
      permissionLevel: st.permissionLevel,
      permissionInfo: st.permissionInfo,
      telemetry: st.telemetry,
      queue: st.queue,
      running: statusUpper.includes('RUNNING')
    };
  });

  const catalogModels = useMemo(
    () => (s.models.length > 0 ? s.models : s.bootstrapModels || []),
    [s.models, s.bootstrapModels]
  );

  return (
    <Composer
      text={s.composerText}
      images={s.composerImages}
      presets={s.presets}
      quickPrompts={s.quickPrompts}
      frequentPrompts={s.frequentPrompts}
      composerSettings={s.composerSettings}
      models={catalogModels}
      modelGroups={s.modelGroups}
      backendModelGroups={s.bootstrapModelGroups}
      modelTree={s.bootstrapModelTree}
      selectedModelId={s.selectedModelId}
      orchestratorThinking={s.orchestratorThinking}
      activeOrchestratorMaster={s.activeOrchestratorMaster}
      chatMode={s.chatMode}
      dispatchMode={s.dispatchMode}
      permissionLevel={s.permissionLevel}
      permissionInfo={s.permissionInfo}
      telemetry={s.telemetry}
      queue={s.queue}
      running={s.running}
      voiceSupported={s.voiceSupported}
      onTextChange={(next) => remoteStore.setComposerText(next)}
      onAddImage={(img) => remoteStore.addComposerImage(img)}
      onRemoveImage={(id) => remoteStore.removeComposerImage(id)}
      onModelChange={(id) => remoteStore.setModelId(id)}
      onSelectOrchestrator={(id, master, tier) =>
        remoteStore.setOrchestratorModel(id, master, tier)
      }
      onOpenModelPicker={() => remoteStore.setActiveSheet('modelPicker')}
      onOpenTelemetry={() => remoteStore.setActiveSheet('telemetry', 'context')}
      onCompact={() => remoteStore.compactActiveSession()}
      onChatModeChange={(mode) => remoteStore.setChatMode(mode)}
      onDispatchModeChange={(mode) => remoteStore.setDispatchMode(mode)}
      onSend={(dm) => remoteStore.sendMessage(dm)}
      onCancel={() => remoteStore.cancelActiveSession()}
      onOptimize={() => remoteStore.optimizeComposerPrompt()}
      onRemoveQueueItem={(id) => {
        void remoteStore.removeQueuedMessage(id);
      }}
    />
  );
});

type LazyNewProjectSheet = ComponentType<Record<string, unknown>>;

const ConnectedSheets = memo(function ConnectedSheets() {
  const { t } = useI18n();
  const s = useRemoteSelector((st) => ({
    activeSheet: st.activeSheet,
    telemetryTab: st.telemetryTab,
    telemetry: st.telemetry,
    models: st.models,
    bootstrapModels: st.bootstrap?.models,
    bootstrapModelGroups: st.bootstrap?.modelGroups,
    bootstrapModelTree: st.bootstrap?.modelTree,
    modelGroups: st.modelGroups,
    selectedModelId: st.selectedModelId,
    orchestratorThinking: st.orchestratorThinking,
    activeOrchestratorMaster: st.activeOrchestratorMaster,
    permissionLevel: st.permissionLevel,
    activeSessionId: st.activeSessionId,
    sessions: st.sessions,
    projects: st.projects,
    groups: st.groups,
    defaultSessionPath: st.defaultSessionPath,
    latestJobEvent: st.latestJobEvent,
    channel: st.channel,
    runningTasksCount: st.runningTasksCount,
    appearance: st.appearance,
    colorTheme: st.colorTheme,
    drawerSpeed: st.drawerSpeed,
    soundAlert: st.soundAlert,
    vibrateAlert: st.vibrateAlert,
    pushSubscribed: st.pushSubscribed,
    pushBusy: st.pushBusy
  }));
  const [NewProjectComp, setNewProjectComp] = useState<LazyNewProjectSheet | null>(null);

  useEffect(() => {
    if (s.activeSheet !== 'newProject' || NewProjectComp) return;
    let canceled = false;
    void import('./lazy/NewProjectSheet')
      .then((mod) => {
        if (!canceled && mod?.default) {
          setNewProjectComp(() => mod.default as unknown as LazyNewProjectSheet);
        }
      })
      .catch((err) => {
        if (!canceled) {
          remoteStore.showToast((err as Error).message);
        }
      });
    return () => {
      canceled = true;
    };
  }, [s.activeSheet, NewProjectComp]);

  const catalogModels = useMemo(
    () => (s.models.length > 0 ? s.models : s.bootstrapModels || []),
    [s.models, s.bootstrapModels]
  );

  const modelBadge = useMemo(() => {
    const orchSel = s.activeOrchestratorMaster
      ? { master: s.activeOrchestratorMaster, thinkingMap: s.orchestratorThinking }
      : null;
    if (s.selectedModelId) {
      const bySelected = formatCompactModelBadge(
        s.selectedModelId,
        catalogModels,
        s.bootstrapModelGroups,
        orchSel,
        s.bootstrapModelTree
      );
      if (bySelected.name !== '选择模型') return bySelected;
    }
    const unified = resolveUnifiedModelName(
      s.telemetry,
      catalogModels,
      s.selectedModelId,
      s.bootstrapModelGroups
    );
    const rawBadge = formatCompactModelBadge(
      unified,
      catalogModels,
      s.bootstrapModelGroups,
      orchSel,
      s.bootstrapModelTree
    );
    return rawBadge;
  }, [
    s.selectedModelId,
    s.telemetry,
    catalogModels,
    s.bootstrapModelGroups,
    s.bootstrapModelTree,
    s.activeOrchestratorMaster,
    s.orchestratorThinking
  ]);

  const localizedModelFull = useMemo(() => {
    if (modelBadge.isOrchestrator && modelBadge.shortName === '编排') {
      const sub =
        modelBadge.tag === '标准'
          ? t('model.standard')
          : modelBadge.tag || modelBadge.name;
      return `${t('model.orchestratorShort')} · ${sub}`;
    }
    if (modelBadge.name === '选择模型') {
      return t('model.selectTitle');
    }
    return modelBadge.full;
  }, [modelBadge, t]);

  const activeSessionSummary = useMemo(
    () => s.sessions.find((item) => item.cascadeId === s.activeSessionId) || null,
    [s.sessions, s.activeSessionId]
  );

  const activeProject = useMemo(
    () =>
      activeSessionSummary?.projectId
        ? s.projects.find((proj) => proj.id === activeSessionSummary.projectId) || null
        : null,
    [s.projects, activeSessionSummary]
  );

  const activeProjectPath =
    activeProject?.rootPath ||
    activeProject?.path ||
    activeProject?.uri ||
    activeSessionSummary?.workspaceUri ||
    null;

  const closeSheet = useCallback(() => remoteStore.setActiveSheet(null), []);

  return (
    <>
      <ModelPickerSheet
        open={s.activeSheet === 'modelPicker'}
        models={catalogModels}
        modelGroups={s.modelGroups}
        backendModelGroups={s.bootstrapModelGroups}
        modelTree={s.bootstrapModelTree}
        selectedModelId={s.selectedModelId}
        orchestratorThinking={s.orchestratorThinking}
        activeOrchestratorMaster={s.activeOrchestratorMaster}
        disabled={s.permissionLevel === 'L0'}
        onSelectModel={(id) => {
          remoteStore.setModelId(id);
          remoteStore.setActiveSheet(null);
        }}
        onSelectOrchestrator={(id, master, tier) => {
          remoteStore.setOrchestratorModel(id, master, tier);
          remoteStore.setActiveSheet(null);
        }}
        onClose={closeSheet}
      />

      <TelemetrySheet
        open={s.activeSheet === 'telemetry'}
        activeTab={s.telemetryTab}
        telemetry={s.telemetry}
        modelName={localizedModelFull}
        permissionLevel={s.permissionLevel}
        hasActiveSession={Boolean(s.activeSessionId)}
        onSelectTab={(tab) => remoteStore.setTelemetryTab(tab)}
        onRunCompact={() => remoteStore.compactActiveSession()}
        onClose={closeSheet}
      />

      <ChannelSwitcherSheet
        open={s.activeSheet === 'channels'}
        onSwitchInPage={(entry) => remoteStore.switchApiChannelInPage(entry)}
        onSwitchWithTicket={(entry) => remoteStore.switchChannelWithTicket(entry)}
        onClose={closeSheet}
      />

      <CustomMenuSheet
        open={s.activeSheet === 'menu'}
        channel={s.channel}
        permissionLevel={s.permissionLevel}
        runningTasksCount={s.runningTasksCount}
        appearance={s.appearance}
        colorTheme={s.colorTheme}
        drawerSpeed={s.drawerSpeed}
        soundAlert={s.soundAlert}
        vibrateAlert={s.vibrateAlert}
        pushSubscribed={s.pushSubscribed}
        pushBusy={s.pushBusy}
        onSetAppearance={(next) => remoteStore.setAppearance(next)}
        onSetColorTheme={(next) => remoteStore.setColorTheme(next)}
        onSetDrawerSpeed={(next) => remoteStore.setDrawerSpeed(next)}
        onSetLocale={(next) => {
          void remoteStore.setLocale(next);
        }}
        onToggleSound={() => remoteStore.toggleSoundAlert()}
        onToggleVibrate={() => remoteStore.toggleVibrateAlert()}
        onTogglePush={() => {
          void remoteStore.togglePushSubscription();
        }}
        onTestPush={() => {
          void remoteStore.sendTestPush();
        }}
        onOpenChannels={() => remoteStore.setActiveSheet('channels')}
        onOpenTasks={() => remoteStore.setActiveSheet('tasks')}
        onShowToast={(msg) => remoteStore.showToast(msg)}
        onClose={closeSheet}
      />

      <BackgroundTasksSheet
        open={s.activeSheet === 'tasks'}
        activeSessionId={s.activeSessionId || null}
        activeSessionTitle={activeSessionSummary?.title || null}
        activeProjectPath={activeProjectPath}
        activeProjectName={activeProject?.name || activeSessionSummary?.projectName || null}
        onRunningCountChange={(count) => remoteStore.setRunningTasksCount(count)}
        onShowToast={(msg) => remoteStore.showToast(msg)}
        onClose={closeSheet}
      />

      {NewProjectComp && s.activeSheet === 'newProject' && (
        <NewProjectComp
          open={true}
          permissionLevel={s.permissionLevel}
          groups={s.groups}
          defaultSessionPath={s.defaultSessionPath}
          latestJobEvent={s.latestJobEvent}
          onCreateLocalProject={(req: {
            name?: string;
            rootPath: string;
            groupId?: string | null;
            createDir?: boolean;
          }) => remoteStore.createLocalProject(req)}
          onRemoteCreated={(project: unknown) =>
            remoteStore.handleRemoteProjectCreated(project as never)
          }
          onShowToast={(msg: string) => remoteStore.showToast(msg)}
          onClose={closeSheet}
        />
      )}
    </>
  );
});

function AppInner() {
  const { t } = useI18n();
  const s = useRemoteSelector((st) => ({
    token: st.token,
    authError: st.authError,
    ready: st.ready,
    online: st.online,
    leftOpen: st.leftOpen,
    rightOpen: st.rightOpen,
    confirmPrompt: st.confirmPrompt,
    toast: st.toast,
    toastAction: st.toastAction,
    hasActiveSession: Boolean(st.activeSessionId),
    hasSessions: st.sessions.length > 0
  }));
  const [manualToken, setManualToken] = useState('');

  useEffect(() => {
    remoteStore.init();
  }, []);

  if (!s.token || s.authError) {
    return (
      <div className="ag-shell">
        <form
          className={styles.authCard}
          onSubmit={(e) => {
            e.preventDefault();
            remoteStore.submitManualToken(manualToken);
          }}
        >
          <strong style={{ fontSize: 16 }}>{t('app.title')}</strong>
          <div style={{ fontSize: 12.5, color: 'var(--ag-secondary)' }}>
            {s.authError || t('app.authPrompt')}
          </div>
          <input
            type="password"
            className="ag-input"
            placeholder={t('app.tokenPlaceholder')}
            value={manualToken}
            onInput={(e) => setManualToken((e.target as HTMLInputElement).value)}
          />
          <button
            type="submit"
            className="ag-pill-btn ag-pill-btn-primary"
            style={{ minHeight: 44 }}
          >
            {t('app.connect')}
          </button>
        </form>
      </div>
    );
  }

  return (
    <SwipeDrawerShell
      leftOpen={s.leftOpen}
      rightOpen={s.rightOpen}
      onSetLeft={(open) => remoteStore.setLeftOpen(open)}
      onSetRight={(open) => remoteStore.setRightOpen(open)}
      leftContent={<ConnectedLeftDrawer />}
      rightContent={<ConnectedRightDrawer />}
    >
      <div className={styles.topAnchor}>
        <ConnectedTopBar />
      </div>

      {!s.online && (
        <div className={styles.banner} role="status">
          {t('app.offlineBanner')}
        </div>
      )}

      <main className={styles.main}>
        <ConnectedChangeStrip />
        {s.ready && !s.hasActiveSession && !s.hasSessions && (
          <div className={styles.emptySessionBanner} data-testid="empty-sessions-cta">
            <span>{t('left.emptyChatState')}</span>
            <button
              type="button"
              className="ag-pill-btn ag-pill-btn-primary"
              style={{ minHeight: 44 }}
              onClick={() => void remoteStore.createNewSession()}
            >
              {t('left.emptyChatNewBtn')}
            </button>
          </div>
        )}
        <ConnectedStreamStage />
        <ConnectedPendingFloatingCard />
        <ConnectedComposer />
      </main>

      <ConnectedSheets />

      {s.confirmPrompt && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={styles.modalCard} data-testid="l2-confirm-modal">
            <strong style={{ fontSize: 15 }}>{s.confirmPrompt.title}</strong>
            <div style={{ fontSize: 12.5, color: 'var(--ag-secondary)' }}>
              {s.confirmPrompt.hint}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                className="ag-pill-btn"
                onClick={() => s.confirmPrompt?.resolve(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="ag-pill-btn ag-pill-btn-primary"
                onClick={() => s.confirmPrompt?.resolve(true)}
              >
                {t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {s.toast && (
        <div
          className={`${styles.toast} ${s.toastAction ? styles.toastInteractive : ''}`}
          role="status"
          data-testid="app-toast"
        >
          <span className={styles.toastText}>{s.toast}</span>
          {s.toastAction && (
            <button
              type="button"
              className={styles.toastActionBtn}
              data-testid="app-toast-action"
              onClick={() => {
                const act = s.toastAction;
                remoteStore.dismissToast();
                act?.onAction();
              }}
            >
              {s.toastAction.label}
            </button>
          )}
        </div>
      )}
    </SwipeDrawerShell>
  );
}
