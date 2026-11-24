import { Component, type ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Composer } from './chat/Composer';
import { ModelPickerSheet } from './chat/ModelPickerSheet';
import { PendingFloatingCard } from './chat/PendingFloatingCard';
import { VirtualChatList } from './chat/VirtualChatList';
import { LeftDrawer } from './drawers/LeftDrawer';
import { RightDrawer } from './drawers/RightDrawer';
import { SwipeDrawerShell } from './layout/SwipeDrawerShell';
import { TelemetryPanel } from './layout/TelemetryPanel';
import { TopBar } from './layout/TopBar';
import {
  formatCompactModelBadge,
  remoteStore,
  resolveUnifiedModelName,
  useRemoteStore
} from './store/useRemoteStore';
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
    remoteStore.toggleContextPanel(false);
    remoteStore.setModelPickerOpen(false);
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="ag-shell">
          <div className={styles.authCard} data-testid="error-boundary-fallback">
            <strong style={{ fontSize: 15 }}>界面渲染异常</strong>
            <div style={{ fontSize: 12.5, color: 'var(--ag-secondary)' }}>
              {this.state.error.message || '未知错误'}
            </div>
            <button
              type="button"
              className="ag-pill-btn ag-pill-btn-primary"
              onClick={this.handleReset}
            >
              重置界面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

function AppInner() {
  const s = useRemoteStore();
  const [manualToken, setManualToken] = useState('');

  useEffect(() => {
    remoteStore.init();
  }, []);

  const activeSessionSummary = useMemo(
    () => s.sessions.find((item) => item.cascadeId === s.activeSessionId) || null,
    [s.sessions, s.activeSessionId]
  );

  const attentionCount = useMemo(
    () => s.sessions.filter((item) => item.needsAttention && !item.isSubagent).length,
    [s.sessions]
  );

  const pendingEvent = useMemo(
    () => s.events.find((ev) => ev.status === 'pending') || null,
    [s.events]
  );

  const activeRoot = remoteStore.getActiveWorkspaceRoot();
  const running = remoteStore.isSessionRunning();
  const activeTitle =
    activeSessionSummary?.title ||
    (s.activeSessionId ? `会话 ${s.activeSessionId.slice(0, 8)}` : 'Agy-Daddy Remote');

  const catalogModels = useMemo(
    () => (s.models.length > 0 ? s.models : s.bootstrap?.models || []),
    [s.models, s.bootstrap?.models]
  );

  const modelBadge = useMemo(() => {
    const orchSel = s.activeOrchestratorMaster
      ? { master: s.activeOrchestratorMaster, thinkingMap: s.orchestratorThinking }
      : null;
    if (s.selectedModelId) {
      const bySelected = formatCompactModelBadge(
        s.selectedModelId,
        catalogModels,
        s.bootstrap?.modelGroups,
        orchSel
      );
      if (bySelected.name !== '选择模型') return bySelected;
    }
    const unified = resolveUnifiedModelName(
      s.telemetry,
      catalogModels,
      s.selectedModelId,
      s.bootstrap?.modelGroups
    );
    return formatCompactModelBadge(unified, catalogModels, s.bootstrap?.modelGroups, orchSel);
  }, [
    s.selectedModelId,
    s.telemetry,
    catalogModels,
    s.bootstrap?.modelGroups,
    s.activeOrchestratorMaster,
    s.orchestratorThinking
  ]);

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
          <strong style={{ fontSize: 16 }}>Agy-Daddy Remote</strong>
          <div style={{ fontSize: 12.5, color: 'var(--ag-secondary)' }}>
            {s.authError || '请扫码或输入配对访问令牌（Token）连接远程控制台。'}
          </div>
          <input
            type="password"
            className="ag-input"
            placeholder="输入配对 Token..."
            value={manualToken}
            onInput={(e) => setManualToken((e.target as HTMLInputElement).value)}
          />
          <button
            type="submit"
            className="ag-pill-btn ag-pill-btn-primary"
            style={{ minHeight: 38 }}
          >
            连接控制台
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
      leftContent={
        <LeftDrawer
          sessions={s.sessions}
          activeSessionId={s.activeSessionId}
          workspaces={s.bootstrap?.workspaces || []}
          groups={s.groups}
          projects={s.projects}
          pins={s.pins}
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
          onCycleAppearance={() => remoteStore.cycleAppearance()}
          onToggleSound={() => remoteStore.toggleSoundAlert()}
          onToggleVibrate={() => remoteStore.toggleVibrateAlert()}
          onTogglePush={() => remoteStore.togglePushSubscription()}
          onTestPush={() => remoteStore.sendTestPush()}
          onClose={() => remoteStore.setLeftOpen(false)}
        />
      }
      rightContent={
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
      }
    >
      <div className={styles.topAnchor}>
        <TopBar
          title={activeTitle}
          attentionCount={attentionCount}
          changedFilesCount={s.changedFilesCount}
          permissionLevel={s.permissionLevel}
          telemetry={s.telemetry}
          contextExpanded={s.contextExpanded}
          onOpenLeft={() => remoteStore.setLeftOpen(true)}
          onOpenRight={() => remoteStore.setRightOpen(true)}
          onToggleContext={() => remoteStore.toggleContextPanel()}
        />

        <TelemetryPanel
          open={s.contextExpanded}
          telemetry={s.telemetry}
          modelName={modelBadge.full}
          channel={s.channel}
          permissionLevel={s.permissionLevel}
          token={s.token}
          onClose={() => remoteStore.toggleContextPanel(false)}
        />
      </div>

      {!s.online && (
        <div className={styles.banner} role="status">
          当前处于离线状态：草稿与发送队列已缓存在本地，恢复连接后自动发送
        </div>
      )}

      <main className={styles.main}>
        <VirtualChatList
          events={s.events}
          loading={s.loadingSession}
          activeSessionId={s.activeSessionId}
          permissionLevel={s.permissionLevel}
          onInspectFile={(filePath) => remoteStore.inspectFileInDrawer(filePath)}
          onApprove={(seq, decision) => remoteStore.approveStep(seq, decision)}
          onAnswer={(seq, answers) => remoteStore.answerStep(seq, answers)}
          queue={s.queue}
          onSteerQueueItem={(id) => remoteStore.steerQueuedMessage(id)}
          onRemoveQueueItem={(id) => remoteStore.removeQueuedMessage(id)}
          onEditQueueItem={(id) => remoteStore.editQueuedMessage(id)}
          onRetryQueueItem={(id) => remoteStore.retryQueuedMessage(id)}
        />

        <PendingFloatingCard
          pendingEvent={pendingEvent}
          permissionLevel={s.permissionLevel}
          onApprove={(seq, decision) => remoteStore.approveStep(seq, decision)}
          onAnswer={(seq, answers) => remoteStore.answerStep(seq, answers)}
        />

        <Composer
          text={s.composerText}
          images={s.composerImages}
          presets={s.presets}
          models={catalogModels}
          modelGroups={s.modelGroups}
          selectedModelId={s.selectedModelId}
          orchestratorThinking={s.orchestratorThinking}
          activeOrchestratorMaster={s.activeOrchestratorMaster}
          chatMode={s.chatMode}
          permissionLevel={s.permissionLevel}
          permissionInfo={s.permissionInfo}
          running={running}
          voiceSupported={Boolean(s.bootstrap?.voiceSupported)}
          onTextChange={(next) => remoteStore.setComposerText(next)}
          onAddImage={(img) => remoteStore.addComposerImage(img)}
          onRemoveImage={(id) => remoteStore.removeComposerImage(id)}
          onModelChange={(id) => remoteStore.setModelId(id)}
          onSelectOrchestrator={(id, master, tier) =>
            remoteStore.setOrchestratorModel(id, master, tier)
          }
          onOpenModelPicker={() => remoteStore.setModelPickerOpen(true)}
          onChatModeChange={(mode) => remoteStore.setChatMode(mode)}
          onSend={(dm) => remoteStore.sendMessage(dm)}
          onCancel={() => remoteStore.cancelActiveSession()}
          onOptimize={() => remoteStore.optimizeComposerPrompt()}
        />
      </main>

      <ModelPickerSheet
        open={s.modelPickerOpen}
        models={catalogModels}
        modelGroups={s.modelGroups}
        backendModelGroups={s.bootstrap?.modelGroups}
        selectedModelId={s.selectedModelId}
        orchestratorThinking={s.orchestratorThinking}
        activeOrchestratorMaster={s.activeOrchestratorMaster}
        disabled={s.permissionLevel === 'L0'}
        onSelectModel={(id) => {
          remoteStore.setModelId(id);
          remoteStore.setModelPickerOpen(false);
        }}
        onSelectOrchestrator={(id, master, tier) => {
          remoteStore.setOrchestratorModel(id, master, tier);
          remoteStore.setModelPickerOpen(false);
        }}
        onClose={() => remoteStore.setModelPickerOpen(false)}
      />

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
                取消
              </button>
              <button
                type="button"
                className="ag-pill-btn ag-pill-btn-primary"
                onClick={() => s.confirmPrompt?.resolve(true)}
              >
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}

      {s.toast && (
        <div className={styles.toast} role="status">
          {s.toast}
        </div>
      )}
    </SwipeDrawerShell>
  );
}
