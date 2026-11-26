import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeReviewStrip } from './chat/ChangeReviewStrip';
import { ChatNavDock } from './chat/ChatNavDock';
import { Composer } from './chat/Composer';
import { normalizeCacheHitRatePct } from './chat/composerUtils';
import { ModelPickerSheet } from './chat/ModelPickerSheet';
import { PendingFloatingCard } from './chat/PendingFloatingCard';
import { StepCard } from './chat/StepCard';
import { ToolGroupCard } from './chat/ToolGroupCard';
import { VirtualChatList } from './chat/VirtualChatList';
import { LeftDrawer } from './drawers/LeftDrawer';
import { RightDrawer } from './drawers/RightDrawer';
import { I18nProvider, useI18n } from './i18n';
import { BottomSheet } from './layout/BottomSheet';
import { TopBar } from './layout/TopBar';
import { BackgroundTasksSheet } from './sheets/BackgroundTasksSheet';
import { ChannelSwitcherSheet } from './sheets/ChannelSwitcherSheet';
import { CustomMenuSheet } from './sheets/CustomMenuSheet';
import { TelemetrySheet } from './sheets/TelemetrySheet';
import { api } from './store/api';
import { ThemeProvider, useTheme } from './theme/ThemeProvider';
import type {
  ChannelEntryDto,
  ChannelsListResponse,
  ModelOption,
  SessionEvent,
  TelemetryPanels
} from './types';

function makeTouchEventInit(x: number, y: number): TouchEventInit {
  const touch = { identifier: 1, clientX: x, clientY: y } as Touch;
  return {
    bubbles: true,
    cancelable: true,
    touches: [touch],
    targetTouches: [touch],
    changedTouches: [touch]
  };
}

function makeTelemetry(displayLocation: 'topbar' | 'composer' = 'topbar'): TelemetryPanels {
  return {
    context: {
      available: true,
      data: {
        displayLocation,
        used: 90000,
        budget: 100000,
        usedTokens: 90000,
        maxTokens: 100000,
        percent: 90,
        usageRatio: 0.9,
        cacheHitRate: 0.72,
        cacheCliffRisk: 'warn',
        riskLevel: 'warn',
        modelLabel: 'Claude 4.5 Sonnet'
      }
    },
    usage: {
      available: true,
      data: {
        totalDisplayCost: 1.42,
        totalUsd: 1.42,
        periods: {
          today: { totalTokens: 15200, totalUsd: 1.42, inputTokens: 12000, outputTokens: 3200 }
        }
      }
    },
    quota: {
      available: true,
      data: {
        tightestFraction: 0.65,
        gemini: { fiveHour: { percentText: '82%' } },
        claude: { fiveHour: { percentText: '65%' } }
      }
    }
  };
}

const SAMPLE_MODELS: ModelOption[] = [
  { id: 'claude-4.5-sonnet', name: 'Claude 4.5 Sonnet', label: 'Claude 4.5 Sonnet' },
  {
    id: 'gemini-3-pro-high',
    name: 'Gemini 3 Pro (High)',
    label: 'Gemini 3 Pro',
    groupId: 'gemini-3-pro',
    thinkingLevel: 'High',
    orchestratorMaster: 'gemini-3-pro'
  },
  {
    id: 'gemini-3-pro-low',
    name: 'Gemini 3 Pro (Low)',
    label: 'Gemini 3 Pro',
    groupId: 'gemini-3-pro',
    thinkingLevel: 'Low',
    orchestratorMaster: 'gemini-3-pro'
  }
];

describe('HUB-276 Mobile PWA UI & Full-Parity Suite', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-appearance');
    document.documentElement.removeAttribute('data-color-theme');
    document.documentElement.removeAttribute('data-drawer-speed');
    document.documentElement.style.removeProperty('--ag-drawer-duration');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('ThemeProvider sets 6 color themes, appearance modes, and drawer speeds (0ms for off)', () => {
    function ThemeProbe() {
      const theme = useTheme();
      return (
        <div>
          <span data-testid="probe-duration">{theme.drawerDurationMs}</span>
          <button type="button" onClick={() => theme.setColorTheme('purple')}>
            color-purple
          </button>
          <button type="button" onClick={() => theme.setAppearance('light')}>
            mode-light
          </button>
          <button type="button" onClick={() => theme.setDrawerSpeed('off')}>
            speed-off
          </button>
        </div>
      );
    }

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>
    );

    expect(document.documentElement.dataset.colorTheme).toBe('monochrome');
    expect(document.documentElement.style.getPropertyValue('--ag-drawer-duration')).toBe('200ms');

    fireEvent.click(screen.getByText('color-purple'));
    fireEvent.click(screen.getByText('mode-light'));
    fireEvent.click(screen.getByText('speed-off'));

    expect(document.documentElement.dataset.colorTheme).toBe('purple');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.drawerSpeed).toBe('off');
    expect(document.documentElement.style.getPropertyValue('--ag-drawer-duration')).toBe('0ms');
    expect(screen.getByTestId('probe-duration').textContent).toBe('0');
  });

  it('I18nProvider translates across supported locales and updates document lang', () => {
    function I18nProbe() {
      const { locale, setLocale, t } = useI18n();
      return (
        <div>
          <span data-testid="i18n-locale">{locale}</span>
          <span data-testid="i18n-menu">{t('menu.title')}</span>
          <button type="button" onClick={() => setLocale('en')}>
            lang-en
          </button>
          <button type="button" onClick={() => setLocale('ja')}>
            lang-ja
          </button>
        </div>
      );
    }

    render(
      <I18nProvider>
        <I18nProbe />
      </I18nProvider>
    );

    expect(screen.getByTestId('i18n-menu').textContent).toBe('设置与工具');
    fireEvent.click(screen.getByText('lang-en'));
    expect(screen.getByTestId('i18n-locale').textContent).toBe('en');
    expect(screen.getByTestId('i18n-menu').textContent).toBe('Settings & Tools');
    expect(document.documentElement.lang).toBe('en');

    fireEvent.click(screen.getByText('lang-ja'));
    expect(screen.getByTestId('i18n-locale').textContent).toBe('ja');
    expect(document.documentElement.lang).toBe('ja');
  });

  it('TopBar honors context.displayLocation, connection dot states, and running tasks badge', () => {
    const onOpenTasks = vi.fn();
    const onOpenMenu = vi.fn();
    const onReconnect = vi.fn();

    const { rerender } = render(
      <I18nProvider locale="zh-CN">
        <TopBar
          title="Main Session"
          attentionCount={0}
          changedFilesCount={2}
          runningTasksCount={3}
          permissionLevel="L1"
          telemetry={makeTelemetry('topbar')}
          contextExpanded={false}
          online={true}
          sseStatus="connected"
          rpcConnected={true}
          onOpenLeft={vi.fn()}
          onOpenRight={vi.fn()}
          onToggleContext={vi.fn()}
          onOpenTasks={onOpenTasks}
          onOpenMenu={onOpenMenu}
          onReconnect={onReconnect}
        />
      </I18nProvider>
    );

    expect(screen.getByTestId('context-capsule-btn')).toBeTruthy();
    expect(screen.getByTestId('quota-capsule-btn')).toBeTruthy();
    expect(screen.getByTestId('topbar-conn-dot').getAttribute('data-tone')).toBe('ok');
    expect(screen.getByTestId('topbar-tasks-btn').textContent).toContain('3');

    fireEvent.click(screen.getByTestId('topbar-tasks-btn'));
    fireEvent.click(screen.getByTestId('topbar-menu-btn'));
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
    expect(onOpenMenu).toHaveBeenCalledTimes(1);

    rerender(
      <I18nProvider locale="zh-CN">
        <TopBar
          title="Main Session"
          attentionCount={0}
          changedFilesCount={0}
          runningTasksCount={0}
          permissionLevel="L1"
          telemetry={makeTelemetry('composer')}
          contextExpanded={false}
          online={false}
          sseStatus="disconnected"
          rpcConnected={false}
          onOpenLeft={vi.fn()}
          onOpenRight={vi.fn()}
          onToggleContext={vi.fn()}
          onReconnect={onReconnect}
        />
      </I18nProvider>
    );

    expect(screen.queryByTestId('context-capsule-btn')).toBeNull();
    expect(screen.queryByTestId('topbar-tasks-btn')).toBeNull();
    expect(screen.getByTestId('topbar-conn-dot').getAttribute('data-tone')).toBe('danger');

    fireEvent.click(screen.getByTestId('topbar-status-btn'));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('TelemetrySheet switches Context/Usage/Quota tabs and dispatches /compact', async () => {
    const onSelectTab = vi.fn();
    const onRunCompact = vi.fn().mockResolvedValue(true);

    render(
      <I18nProvider locale="zh-CN">
        <TelemetrySheet
          open={true}
          activeTab="context"
          telemetry={makeTelemetry('topbar')}
          modelName="Claude 4.5 Sonnet"
          permissionLevel="L1"
          hasActiveSession={true}
          onSelectTab={onSelectTab}
          onRunCompact={onRunCompact}
          onClose={vi.fn()}
        />
      </I18nProvider>
    );

    expect(screen.getByTestId('telemetry-sheet')).toBeTruthy();
    fireEvent.click(screen.getByTestId('telemetry-compact-btn'));
    await waitFor(() => expect(onRunCompact).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('tab', { name: /用量/ }));
    expect(onSelectTab).toHaveBeenCalledWith('usage');
  });

  it('ChannelSwitcherSheet fetches /api/channels, switches locally and via ticket without /entry?t= links', async () => {
    const localEntry: ChannelEntryDto = {
      key: 'lan',
      label: 'LAN 直连',
      origin: 'http://192.168.1.20:8787',
      protocol: 'http:',
      displayHost: '192.168.1.20:8787',
      probeUrl: 'http://192.168.1.20:8787/api/health',
      isCurrent: false,
      requiresTicketRedirect: false
    };
    const tunnelEntry: ChannelEntryDto = {
      key: 'cloudflare',
      label: 'Cloudflare Tunnel',
      origin: 'https://demo.trycloudflare.com',
      protocol: 'https:',
      displayHost: 'demo.trycloudflare.com',
      probeUrl: 'https://demo.trycloudflare.com/api/health',
      isCurrent: true,
      requiresTicketRedirect: true
    };
    const channelsResp: ChannelsListResponse = {
      ok: true,
      currentChannel: 'cloudflare',
      currentOrigin: 'https://demo.trycloudflare.com',
      tunnelMode: 'quick',
      tunnelState: 'running',
      entries: [localEntry, tunnelEntry]
    };
    vi.spyOn(api, 'getChannels').mockResolvedValue(channelsResp);
    vi.spyOn(api, 'pingLatency').mockResolvedValue(14);

    const onSwitchInPage = vi.fn().mockResolvedValue(undefined);
    const onSwitchWithTicket = vi.fn().mockResolvedValue(undefined);

    const { container } = render(
      <I18nProvider locale="zh-CN">
        <ChannelSwitcherSheet
          open={true}
          onSwitchInPage={onSwitchInPage}
          onSwitchWithTicket={onSwitchWithTicket}
          onClose={vi.fn()}
        />
      </I18nProvider>
    );

    await waitFor(() => expect(screen.getByText('LAN 直连')).toBeTruthy());
    expect(container.querySelector('a[href*="/entry?t="]')).toBeNull();

    fireEvent.click(screen.getByTestId('channel-switch-lan'));
    await waitFor(() => expect(onSwitchInPage).toHaveBeenCalledWith(localEntry));
  });

  it('CustomMenuSheet loads diagnostics and runs whitelisted safe commands', async () => {
    vi.spyOn(api, 'getDiagnostics').mockResolvedValue({
      ok: true,
      mode: 'L2',
      hostControlAvailable: true,
      checkedAt: Date.now(),
      summary: { okCount: 1, warnCount: 0, failCount: 0 },
      checks: [{ id: 'sse', label: 'SSE 连接正常', status: 'ok', detail: 'connected' }]
    });
    vi.spyOn(api, 'listCommands').mockResolvedValue({
      ok: true,
      commands: [{ id: 'refresh-sessions', title: '刷新会话列表', minLevel: 'L0', allowed: true }]
    });
    const runSpy = vi
      .spyOn(api, 'runCommand')
      .mockResolvedValue({ ok: true, commandId: 'refresh-sessions' });
    const onShowToast = vi.fn();

    render(
      <I18nProvider locale="zh-CN">
        <CustomMenuSheet
          open={true}
          channel="lan"
          permissionLevel="L1"
          runningTasksCount={1}
          appearance="dark"
          colorTheme="monochrome"
          drawerSpeed="normal"
          soundAlert={true}
          vibrateAlert={true}
          pushSubscribed={false}
          pushBusy={false}
          onSetAppearance={vi.fn()}
          onSetColorTheme={vi.fn()}
          onSetDrawerSpeed={vi.fn()}
          onSetLocale={vi.fn()}
          onToggleSound={vi.fn()}
          onToggleVibrate={vi.fn()}
          onTogglePush={vi.fn()}
          onTestPush={vi.fn()}
          onOpenChannels={vi.fn()}
          onOpenTasks={vi.fn()}
          onShowToast={onShowToast}
          onClose={vi.fn()}
        />
      </I18nProvider>
    );

    fireEvent.click(screen.getByTestId('menu-diagnostics-toggle'));
    await waitFor(() => expect(screen.getByText('SSE 连接正常')).toBeTruthy());

    fireEvent.click(screen.getByTestId('safe-cmd-refresh-sessions'));
    await waitFor(() => expect(runSpy).toHaveBeenCalledWith('refresh-sessions'));
    expect(onShowToast).toHaveBeenCalledWith('refresh-sessions ✓');
  });

  it('BackgroundTasksSheet renders list/log detail and enforces two-step stop confirmation', async () => {
    vi.spyOn(api, 'listTasks').mockResolvedValue({
      ok: true,
      runningCount: 1,
      running: [
        {
          id: 't-1',
          kind: 'command',
          title: 'vitest run',
          status: 'running',
          startedAt: Date.now() - 5000,
          stopCapability: { canStop: true, requiredLevel: 'L1' }
        }
      ],
      recent: []
    });
    vi.spyOn(api, 'getTaskDetail').mockResolvedValue({
      ok: true,
      task: {
        id: 't-1',
        kind: 'command',
        title: 'vitest run',
        status: 'running',
        startedAt: Date.now() - 5000,
        stopCapability: { canStop: true, requiredLevel: 'L1' },
        logText: 'PASS 10 tests',
        truncated: false,
        totalBytes: 13,
        retainedBytes: 13
      }
    });
    const stopSpy = vi.spyOn(api, 'stopTask').mockResolvedValue({
      ok: true,
      taskId: 't-1',
      alreadyFinished: false,
      status: 'stopped'
    });

    render(
      <I18nProvider locale="zh-CN">
        <BackgroundTasksSheet open={true} onClose={vi.fn()} />
      </I18nProvider>
    );

    await waitFor(() => expect(screen.getByTestId('bg-task-t-1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('bg-task-log-t-1'));
    await waitFor(() => expect(screen.getByTestId('bg-task-detail')).toBeTruthy());
    expect(screen.getByTestId('bg-task-detail').textContent).toContain('PASS 10 tests');

    fireEvent.click(screen.getByTestId('bg-tasks-back'));
    await waitFor(() => expect(screen.getByTestId('bg-task-stop-t-1')).toBeTruthy());
    const stopBtn = screen.getByTestId('bg-task-stop-t-1');
    fireEvent.click(stopBtn);
    expect(stopSpy).not.toHaveBeenCalled();

    fireEvent.click(stopBtn);
    await waitFor(() => expect(stopSpy).toHaveBeenCalledWith('t-1'));
  });

  it('BottomSheet closes when dragged down beyond 84px via touch gestures', async () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open={true} title="Test Sheet" testId="swipe-sheet" onClose={onClose}>
        <div>Body</div>
      </BottomSheet>
    );

    const backdrop = screen.getByTestId('swipe-sheet');
    const sheet = backdrop.firstElementChild as HTMLElement;
    const handle = screen.getByTestId('swipe-sheet-handle');

    fireEvent(handle, new TouchEvent('touchstart', makeTouchEventInit(120, 100)));
    fireEvent(handle, new TouchEvent('touchmove', makeTouchEventInit(122, 220)));
    await waitFor(() => expect(sheet.style.getPropertyValue('--sheet-drag-y')).toBe('120.0px'));

    fireEvent(handle, new TouchEvent('touchend', makeTouchEventInit(122, 220)));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ModelPickerSheet navigates into subpane and supports horizontal right-swipe back', () => {
    render(
      <ModelPickerSheet
        open={true}
        models={SAMPLE_MODELS}
        selectedModelId="claude-4.5-sonnet"
        onSelectModel={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const groupBtn = screen.getByTestId('model-group-orchestrator').querySelector('button');
    expect(groupBtn).toBeTruthy();
    fireEvent.click(groupBtn!);
    const track = screen.getByTestId('model-picker-track');
    expect(track.dataset.depth).toBe('1');

    fireEvent(track, new TouchEvent('touchstart', makeTouchEventInit(20, 200)));
    fireEvent(track, new TouchEvent('touchmove', makeTouchEventInit(110, 204)));
    fireEvent(track, new TouchEvent('touchend', makeTouchEventInit(110, 204)));
    expect(track.dataset.depth).toBe('0');
  });

  it('StepCard, ToolGroupCard, ChangeReviewStrip, VirtualChatList & ChatNavDock cover copy, highlight, diff link, and filter', () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        kind: 'user',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'Inspect gateway error 502' }
      },
      {
        seq: 2,
        kind: 'thinking_and_text',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        payload: {
          thinking: 'Checking nginx timeout configuration',
          text: 'Found error 502 in proxy upstream.'
        }
      },
      {
        seq: 3,
        kind: 'code_action',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_CODE_ACTION',
        payload: {
          actionSpec: { filePath: 'src/proxy.ts' },
          filePath: 'src/proxy.ts',
          diffText: '--- a/src/proxy.ts\n+++ b/src/proxy.ts\n@@ -1,2 +1,2 @@\n-timeout: 1s\n+timeout: 15s'
        }
      },
      {
        seq: 4,
        kind: 'checkpoint',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_CHECKPOINT',
        payload: { label: 'INTERNAL_CHECKPOINT' }
      }
    ];

    const onViewDiffFile = vi.fn();
    const standaloneAssistantEvent: SessionEvent = {
      ...events[1],
      seq: 99
    };
    const { container } = render(
      <I18nProvider locale="zh-CN">
        <div>
          <ChangeReviewStrip events={events} onReviewFile={onViewDiffFile} onOpenDiffDrawer={vi.fn()} />
          <StepCard
            event={standaloneAssistantEvent}
            searchQuery={'error\\s+502'}
            searchRegex={true}
            thinkingExpandVersion={1}
            thinkingExpandTarget={true}
          />
          <ToolGroupCard
            id="tg-standalone"
            events={[events[2]]}
            onViewDiffFile={onViewDiffFile}
          />
          <VirtualChatList events={events} hideSystemEvents={true} />
          <ChatNavDock
            events={events}
            sessionId="sess-1"
            sessionTitle="Proxy Debug"
            hideSystemEvents={true}
            thinkingExpandedAll={false}
            searchQuery="error"
            searchRegex={false}
            searchCaseSensitive={false}
            onSearchChange={vi.fn()}
            onJumpToSeq={vi.fn()}
            onScrollTop={vi.fn()}
            onScrollBottom={vi.fn()}
            onToggleThinkingAll={vi.fn()}
            onToggleHideSystem={vi.fn()}
          />
        </div>
      </I18nProvider>
    );

    // Search highlight <mark>
    const marks = container.querySelectorAll('mark');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].textContent).toMatch(/error\s+502/);

    // Copy button rendered on assistant step
    expect(screen.getByTestId('step-copy-99')).toBeTruthy();

    // ChangeReviewStrip + expand ToolGroupCard to inspect diff preview link
    expect(screen.getByTestId('change-review-strip')).toBeTruthy();
    fireEvent.click(screen.getByTestId('tool-group-toggle-tg-standalone'));
    fireEvent.click(screen.getByTestId('tool-group-item-3').querySelector('button')!);
    expect(screen.getByTestId('tool-group-diff-3')).toBeTruthy();

    const diffButtons = screen.getAllByText(/在 Diff 中查看/);
    fireEvent.click(diffButtons[0]);
    expect(onViewDiffFile).toHaveBeenCalledWith('src/proxy.ts');

    // hideSystemEvents hides seq 4 internal checkpoint
    expect(screen.queryByTestId('step-card-4')).toBeNull();
    expect(screen.getByTestId('chat-nav-dock-trigger')).toBeTruthy();
  });

  it('Composer supports quick prompts, ghost suggestion, optimize undo, high-risk guard, bottom ContextBar, and hides mic when unsupported', async () => {
    const onTextChange = vi.fn();
    const onSend = vi.fn();
    const onCompact = vi.fn().mockResolvedValue(true);
    const onOptimize = vi.fn().mockResolvedValue('Optimized git status prompt');

    const { rerender } = render(
      <I18nProvider locale="zh-CN">
        <Composer
          text="git st"
          images={[]}
          presets={[]}
          quickPrompts={[{ id: 'qp-status', label: '仓库状态', template: 'git status && git diff --stat' }]}
          frequentPrompts={['git status --short']}
          models={SAMPLE_MODELS}
          selectedModelId="claude-4.5-sonnet"
          chatMode="chat"
          permissionLevel="L2"
          telemetry={makeTelemetry('composer')}
          composerSettings={{
            showQuickBar: true,
            ghostSuggest: true,
            showPromptOptimizer: true,
            autoCompactThresholdTokens: 80000
          }}
          running={false}
          voiceSupported={false}
          onTextChange={onTextChange}
          onAddImage={vi.fn()}
          onRemoveImage={vi.fn()}
          onModelChange={vi.fn()}
          onChatModeChange={vi.fn()}
          onSend={onSend}
          onCancel={vi.fn()}
          onOptimize={onOptimize}
          onCompact={onCompact}
        />
      </I18nProvider>
    );

    // voiceSupported=false hides voice button
    expect(screen.queryByTestId('voice-input-btn')).toBeNull();

    // displayLocation='composer' shows bottom ContextBar and /compact button
    expect(screen.getByTestId('composer-context-bar')).toBeTruthy();
    fireEvent.click(screen.getByTestId('composer-compact-btn'));
    await waitFor(() => expect(onCompact).toHaveBeenCalledTimes(1));

    // Ghost suggestion accepts matching frequent prompt
    const ghostBtn = screen.getByTestId('composer-ghost-btn');
    fireEvent.click(ghostBtn);
    expect(onTextChange).toHaveBeenCalledWith('git status --short');

    // Optimize prompt renders undo pill and restores pre-optimize text
    fireEvent.click(screen.getByTestId('composer-optimize-btn'));
    await waitFor(() => expect(screen.getByTestId('composer-undo-optimize-btn')).toBeTruthy());
    fireEvent.click(screen.getByTestId('composer-undo-optimize-btn'));
    expect(onTextChange).toHaveBeenLastCalledWith('git st');

    // High-risk command triggers guard banner before sending
    rerender(
      <I18nProvider locale="zh-CN">
        <Composer
          text="rm -rf /tmp/prod-data"
          images={[]}
          presets={[]}
          models={SAMPLE_MODELS}
          selectedModelId="claude-4.5-sonnet"
          chatMode="chat"
          permissionLevel="L2"
          telemetry={makeTelemetry('composer')}
          running={false}
          voiceSupported={false}
          onTextChange={onTextChange}
          onAddImage={vi.fn()}
          onRemoveImage={vi.fn()}
          onModelChange={vi.fn()}
          onChatModeChange={vi.fn()}
          onSend={onSend}
          onCancel={vi.fn()}
          onOptimize={onOptimize}
        />
      </I18nProvider>
    );

    fireEvent.click(screen.getByTestId('composer-send-btn'));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('composer-high-risk-banner')).toBeTruthy();

    fireEvent.click(screen.getByTestId('composer-high-risk-confirm'));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('normalizes cacheHitRate across decimal (0..1) and percentage (0..100) forms in TelemetrySheet and Composer', () => {
    expect(normalizeCacheHitRatePct(0)).toBe(0);
    expect(normalizeCacheHitRatePct(1)).toBe(100);
    expect(normalizeCacheHitRatePct(0.92)).toBe(92);
    expect(normalizeCacheHitRatePct(92)).toBe(92);
    expect(normalizeCacheHitRatePct(0.725)).toBe(73);
    expect(normalizeCacheHitRatePct(150)).toBe(100);
    expect(normalizeCacheHitRatePct(-1)).toBeNull();
    expect(normalizeCacheHitRatePct(undefined)).toBeNull();

    const withRate = (cacheHitRate: number, displayLocation: 'topbar' | 'composer' = 'topbar'): TelemetryPanels => {
      const base = makeTelemetry(displayLocation);
      return {
        ...base,
        context: {
          available: true,
          data: {
            ...base.context!.data!,
            cacheHitRate
          }
        }
      };
    };

    const { rerender } = render(
      <I18nProvider locale="en">
        <TelemetrySheet
          open={true}
          activeTab="context"
          telemetry={withRate(0.92)}
          modelName="Claude 4.5 Sonnet"
          permissionLevel="L1"
          hasActiveSession={true}
          onSelectTab={vi.fn()}
          onRunCompact={vi.fn().mockResolvedValue(true)}
          onClose={vi.fn()}
        />
      </I18nProvider>
    );
    expect(screen.getByTestId('telemetry-hit-rate').textContent).toBe('92%');

    for (const [input, expected] of [
      [1, '100%'],
      [0, '0%'],
      [92, '92%']
    ] as const) {
      rerender(
        <I18nProvider locale="en">
          <TelemetrySheet
            open={true}
            activeTab="context"
            telemetry={withRate(input)}
            modelName="Claude 4.5 Sonnet"
            permissionLevel="L1"
            hasActiveSession={true}
            onSelectTab={vi.fn()}
            onRunCompact={vi.fn().mockResolvedValue(true)}
            onClose={vi.fn()}
          />
        </I18nProvider>
      );
      expect(screen.getByTestId('telemetry-hit-rate').textContent).toBe(expected);
    }

    render(
      <I18nProvider locale="en">
        <Composer
          text=""
          images={[]}
          presets={[]}
          models={SAMPLE_MODELS}
          selectedModelId="claude-4.5-sonnet"
          chatMode="chat"
          permissionLevel="L1"
          telemetry={withRate(0.92, 'composer')}
          running={false}
          voiceSupported={false}
          onTextChange={vi.fn()}
          onAddImage={vi.fn()}
          onRemoveImage={vi.fn()}
          onModelChange={vi.fn()}
          onChatModeChange={vi.fn()}
          onSend={vi.fn()}
          onCancel={vi.fn()}
          onOptimize={vi.fn().mockResolvedValue(null)}
        />
      </I18nProvider>
    );
    expect(screen.getByTestId('composer-context-bar').textContent).toContain('92%');
  });

  it('renders English locale across chat cards, drawers, Composer, and ModelPickerSheet without hardcoded Chinese', () => {
    const pendingCmd: SessionEvent = {
      seq: 11,
      kind: 'command',
      status: 'pending',
      rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      payload: {
        proposedCommandLine: 'npm run verify',
        cwd: '/Volumes/external/very-long-workspace-path/agy-daddy/agy-daddy-plugin-remote'
      }
    };
    const askEv: SessionEvent = {
      seq: 12,
      kind: 'ask_question',
      status: 'pending',
      rawType: 'CORTEX_STEP_TYPE_ASK_QUESTION',
      payload: {
        questions: [
          {
            question: 'Deploy staging build?',
            options: [{ label: 'Yes' }, { label: 'No' }]
          }
        ]
      }
    };
    const toolEv: SessionEvent = {
      seq: 13,
      kind: 'code_action',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_CODE_ACTION',
      payload: { path: 'src/index.ts', diff: '+const ok = true;' }
    };

    const { container } = render(
      <I18nProvider locale="en">
        <div>
          <PendingFloatingCard
            pendingEvent={pendingCmd}
            permissionLevel="L1"
            onApprove={vi.fn().mockResolvedValue(undefined)}
            onAnswer={vi.fn().mockResolvedValue(undefined)}
          />
          <StepCard
            event={pendingCmd}
            permissionLevel="L1"
            onApprove={vi.fn().mockResolvedValue(undefined)}
          />
          <StepCard
            event={askEv}
            permissionLevel="L1"
            onAnswer={vi.fn().mockResolvedValue(undefined)}
          />
          <ToolGroupCard
            id="tg-en"
            events={[toolEv]}
            onViewDiffFile={vi.fn()}
          />
          <Composer
            text=""
            images={[]}
            presets={[]}
            models={SAMPLE_MODELS}
            selectedModelId="claude-4.5-sonnet"
            chatMode="chat"
            permissionLevel="L1"
            telemetry={makeTelemetry('composer')}
            running={false}
            voiceSupported={false}
            onTextChange={vi.fn()}
            onAddImage={vi.fn()}
            onRemoveImage={vi.fn()}
            onModelChange={vi.fn()}
            onChatModeChange={vi.fn()}
            onSend={vi.fn()}
            onCancel={vi.fn()}
            onOptimize={vi.fn().mockResolvedValue(null)}
          />
          <ModelPickerSheet
            open={true}
            models={SAMPLE_MODELS}
            selectedModelId="claude-4.5-sonnet"
            orchestratorThinking={{ carbon: 'medium', argon: 'high', neon: 'high', 'opus5.5': 'xhigh' }}
            activeOrchestratorMaster="carbon"
            onSelectModel={vi.fn()}
            onSelectOrchestrator={vi.fn()}
            onClose={vi.fn()}
          />
          <LeftDrawer
            sessions={[
              {
                cascadeId: 's-en-1',
                title: 'Fix touch targets',
                summary: '',
                status: 'RUNNING',
                stepCount: 4,
                lastModifiedTime: '',
                workspaceUri: 'file:///repo',
                branchName: 'main',
                needsAttention: true
              }
            ]}
            activeSessionId="s-en-1"
            workspaces={['/repo']}
            groups={[
              {
                id: 'grp-1',
                name: 'Workstation',
                source: 'user',
                projectIds: [],
                workspaceUris: [],
                sessionIds: []
              }
            ]}
            projects={[{ id: 'proj-1', name: 'agy-daddy', path: '/repo', uri: 'file:///repo' }]}
            channel="loopback"
            permissionLevel="L2"
            token="tok"
            appearance="dark"
            soundAlert={true}
            vibrateAlert={true}
            pushSubscribed={false}
            pushBusy={false}
            onSelectSession={vi.fn()}
            onCreateSession={vi.fn().mockResolvedValue(undefined)}
            onCycleAppearance={vi.fn()}
            onToggleSound={vi.fn()}
            onToggleVibrate={vi.fn()}
            onTogglePush={vi.fn().mockResolvedValue(undefined)}
            onTestPush={vi.fn().mockResolvedValue(undefined)}
            onClose={vi.fn()}
          />
          <RightDrawer
            open={true}
            activeTab="diff"
            rootPath=""
            sessionId="s-en-1"
            permissionLevel="L1"
            token="tok"
            inspectTargetFile=""
            onSelectTab={vi.fn()}
            onClose={vi.fn()}
            onInjectQuote={vi.fn()}
            onShowToast={vi.fn()}
            onRefreshDiffBadge={vi.fn()}
          />
        </div>
      </I18nProvider>
    );

    const renderedText = container.textContent || '';
    expect(renderedText).toContain('Pending');
    expect(renderedText).toContain('Workspaces & Sessions');
    expect(renderedText).toContain('Files');
    expect(renderedText).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
