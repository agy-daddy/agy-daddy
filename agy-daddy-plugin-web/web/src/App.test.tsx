import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent, SseDeltaPayload } from './types';
import { ThemeProvider } from './theme/ThemeProvider';
import { I18nProvider } from './i18n';

const mockSseCallbacks: {
  onOpen?: () => void;
  onError?: () => void;
  onHeartbeat?: () => void;
  onDelta?: (delta: SseDeltaPayload) => void;
  onResync?: () => void;
} = {};

const mocks = vi.hoisted(() => ({
  getHealth: vi.fn(),
  listSessions: vi.fn(),
  markSessionRead: vi.fn(),
  createSession: vi.fn(),
  listModels: vi.fn(),
  getTopbar: vi.fn(),
  getPluginSettings: vi.fn(),
  getHostLocale: vi.fn(),
  listProjects: vi.fn(),
  getComposerState: vi.fn(),
  getRemoteStatus: vi.fn(),
  getWebAccessStatus: vi.fn(),
  authenticateWithToken: vi.fn(),
  getSessionDetail: vi.fn(),
  sendMessage: vi.fn(),
  cancelSession: vi.fn(),
  getGitDiff: vi.fn(),
  getFsTree: vi.fn(),
  listArtifacts: vi.fn(),
  subscribeSessionStream: vi.fn(),
  setConfirmWriteHandler: vi.fn(),
}));

vi.mock('./api/client', () => {
  class MockApiError extends Error {
    status: number;
    code: string;
    constructor(message: string, status = 500, code = 'API_ERROR') {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError: MockApiError,
    apiClient: {
      getHealth: mocks.getHealth,
      listSessions: mocks.listSessions,
      markSessionRead: mocks.markSessionRead,
      createSession: mocks.createSession,
      pinSession: vi.fn().mockResolvedValue({ ok: true }),
      assignSessionProject: vi.fn().mockResolvedValue({ ok: true }),
      listProjects: mocks.listProjects,
      createProject: vi.fn().mockResolvedValue({ ok: true }),
      updateProject: vi.fn().mockResolvedValue({ ok: true }),
      deleteProject: vi.fn().mockResolvedValue({ ok: true }),
      createProjectGroup: vi.fn().mockResolvedValue({ ok: true }),
      updateProjectGroup: vi.fn().mockResolvedValue({ ok: true }),
      deleteProjectGroup: vi.fn().mockResolvedValue({ ok: true }),
      setDefaultSessionPath: vi.fn().mockResolvedValue({ ok: true }),
      authorizeWorkspaceRoot: vi.fn().mockResolvedValue({ ok: true }),
      getSessionDetail: mocks.getSessionDetail,
      sendMessage: mocks.sendMessage,
      cancelSession: mocks.cancelSession,
      approveStep: vi.fn().mockResolvedValue({ ok: true, supported: true }),
      listModels: mocks.listModels,
      getFsTree: mocks.getFsTree,
      readFsFile: vi.fn().mockResolvedValue({ ok: true, content: '' }),
      writeFsFile: vi.fn().mockResolvedValue({ ok: true }),
      getGitDiff: mocks.getGitDiff,
      listArtifacts: mocks.listArtifacts,
      readArtifact: vi.fn().mockResolvedValue({ ok: true, content: '' }),
      getArtifactRawUrl: vi.fn().mockReturnValue(''),
      listArtifactPreviewers: vi.fn().mockResolvedValue({ ok: true, previewers: [] }),
      renderPluginArtifactPreview: vi.fn().mockResolvedValue({ ok: true, html: '' }),
      getHostLocale: mocks.getHostLocale,
      setHostLocale: vi.fn().mockResolvedValue({ ok: true }),
      getHostPlugins: vi.fn().mockResolvedValue({ ok: true, plugins: [] }),
      runHostPluginAction: vi.fn().mockResolvedValue({ ok: true }),
      getHostSettings: vi.fn().mockResolvedValue({ ok: true, values: {} }),
      saveHostSettings: vi.fn().mockResolvedValue({ ok: true }),
      getPluginSettings: mocks.getPluginSettings,
      savePluginSettings: vi.fn().mockResolvedValue({ ok: true }),
      runHostCommand: vi.fn().mockResolvedValue({ ok: true }),
      getHostDoctor: vi.fn().mockResolvedValue({ ok: true, checks: [] }),
      getTopbar: mocks.getTopbar,
      getRemoteStatus: mocks.getRemoteStatus,
      getWebAccessStatus: mocks.getWebAccessStatus,
      authenticateWithToken: mocks.authenticateWithToken,
      getComposerState: mocks.getComposerState,
      optimizePrompt: vi.fn().mockResolvedValue({ ok: true, optimizedText: '' }),
      exportSessionMarkdown: vi.fn().mockResolvedValue({ ok: true, markdown: '' }),
      subscribeSessionStream: mocks.subscribeSessionStream,
      setConfirmWriteHandler: mocks.setConfirmWriteHandler,
    },
  };
});

import { App, mergeEventsBySeq, reconcileFullSessionEvents } from './App';
import { ApiError } from './api/client';

function makeUserEvent(seq: number, text: string, extraPayload: Record<string, unknown> = {}): SessionEvent {
  return {
    seq,
    kind: 'user',
    status: seq < 0 ? 'pending' : 'done',
    rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
    payload: {
      text,
      userResponse: text,
      items: [{ text }],
      ...extraPayload,
    },
  };
}

function makeAssistantEvent(seq: number, response: string): SessionEvent {
  return {
    seq,
    kind: 'thinking_and_text',
    status: 'done',
    rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    payload: { response },
  };
}

function renderApp() {
  return render(
    <ThemeProvider>
      <I18nProvider defaultLocale="en">
        <App />
      </I18nProvider>
    </ThemeProvider>,
  );
}

describe('mergeEventsBySeq & reconcileFullSessionEvents', () => {
  it('keeps real events sorted ascending before negative optimistic events in insertion order', () => {
    const prev: SessionEvent[] = [
      makeUserEvent(-1, 'first opt', { clientTempId: 'opt_1', optimistic: true }),
      makeUserEvent(-2, 'second opt', { clientTempId: 'opt_2', optimistic: true }),
      makeUserEvent(0, 'server zero'),
    ];
    const incoming: SessionEvent[] = [makeAssistantEvent(1, 'assistant reply')];

    const merged = mergeEventsBySeq(prev, incoming);
    expect(merged.map((e) => e.seq)).toEqual([0, 1, -1, -2]);
  });

  it('deduplicates optimistic user event by normalized text and falls back to FIFO', () => {
    const prev: SessionEvent[] = [
      makeUserEvent(0, 'old user'),
      makeUserEvent(-1, 'hello   world', { clientTempId: 'opt_1', optimistic: true }),
      makeUserEvent(-2, 'second msg', { clientTempId: 'opt_2', optimistic: true }),
    ];

    // Normalized whitespace match consumes -2 first
    const afterMatch = mergeEventsBySeq(prev, [makeUserEvent(2, 'second\n  msg')]);
    expect(afterMatch.map((e) => e.seq)).toEqual([0, 2, -1]);

    // Existing seq 0 repeated does not consume -1; new seq 3 with different text consumes -1 via FIFO
    const afterRepeat = mergeEventsBySeq(afterMatch, [makeUserEvent(0, 'old user')]);
    expect(afterRepeat.map((e) => e.seq)).toEqual([0, 2, -1]);

    const afterFifo = mergeEventsBySeq(afterRepeat, [makeUserEvent(3, 'normalized by server')]);
    expect(afterFifo.map((e) => e.seq)).toEqual([0, 2, 3]);
  });

  it('reconciles full session refresh without wiping in-flight optimistic events', () => {
    const prev = [makeUserEvent(0, 'history')];
    const optBeforeLoad = makeUserEvent(-1, 'sent before load', {
      clientTempId: 'opt_1',
      optimistic: true,
    });
    const optDuringLoad = makeUserEvent(-2, 'history', {
      clientTempId: 'opt_2',
      optimistic: true,
    });

    // Server does not have opt_1 yet, and opt_2 was created after detailSeqAtStart=1
    const keptBoth = reconcileFullSessionEvents(
      prev,
      [makeUserEvent(0, 'history'), makeAssistantEvent(1, 'reply')],
      [optBeforeLoad, optDuringLoad],
      1,
    );
    expect(keptBoth.map((e) => e.seq)).toEqual([0, 1, -1, -2]);

    // Server now returns seq 2 matching opt_1
    const reconciled = reconcileFullSessionEvents(
      keptBoth,
      [
        makeUserEvent(0, 'history'),
        makeAssistantEvent(1, 'reply'),
        makeUserEvent(2, 'sent before load'),
      ],
      [optBeforeLoad],
      2,
    );
    expect(reconciled.map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('appends and patches 200-step tail increments via O(K) fast path and falls back on out-of-order replay', () => {
    const history: SessionEvent[] = Array.from({ length: 200 }, (_, seq) =>
      seq % 2 === 0 ? makeUserEvent(seq, `user-${seq}`) : makeAssistantEvent(seq, `assistant-${seq}`),
    );

    const tailUpdate = makeAssistantEvent(199, 'assistant-199-updated');
    const tailAppend = makeUserEvent(200, 'user-200');
    const fastMerged = mergeEventsBySeq(history, [tailUpdate, tailAppend]);

    expect(fastMerged).toHaveLength(201);
    expect(fastMerged[199]).toEqual(tailUpdate);
    expect(fastMerged[200]).toEqual(tailAppend);
    expect(fastMerged.slice(0, 199)).toEqual(history.slice(0, 199));

    // Out-of-order incoming falls back cleanly to full Map + sort
    const outOfOrder = mergeEventsBySeq(fastMerged, [
      makeAssistantEvent(202, 'assistant-202'),
      makeUserEvent(201, 'user-201'),
    ]);
    expect(outOfOrder.slice(199).map((e) => e.seq)).toEqual([199, 200, 201, 202]);

    // Earlier replay falls back cleanly
    const replayed = mergeEventsBySeq(outOfOrder, [makeAssistantEvent(50, 'user-50-replayed')]);
    expect(replayed).toHaveLength(203);
    expect(replayed[50].payload).toEqual({ response: 'user-50-replayed' });
  });
});

describe('App optimistic send flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mockSseCallbacks.onOpen = undefined;
    mockSseCallbacks.onError = undefined;
    mockSseCallbacks.onHeartbeat = undefined;
    mockSseCallbacks.onDelta = undefined;
    mockSseCallbacks.onResync = undefined;

    mocks.getHealth.mockResolvedValue({
      ok: true,
      rpcConnected: true,
      allowedRoots: ['/workspace/demo'],
      defaultSessionPath: '/workspace/demo',
    });
    mocks.listSessions.mockResolvedValue({
      ok: true,
      sessions: [
        {
          cascadeId: 'sess-1',
          shortId: 'sess-1',
          hasTitle: true,
          titleSource: 'title',
          title: 'Demo Session',
          summary: '',
          status: 'CASCADE_RUN_STATUS_IDLE',
          stepCount: 2,
          lastModifiedTime: '2026-11-25T00:00:00Z',
          createdTime: '2026-11-25T00:00:00Z',
          workspaceUri: 'file:///workspace/demo',
          gitRootUri: null,
          repoName: 'demo',
          branchName: 'main',
          workspaces: [{ workspaceUri: 'file:///workspace/demo' }],
        },
      ],
      hiddenInternalCount: 0,
    });
    mocks.markSessionRead.mockResolvedValue({ ok: true });
    mocks.listModels.mockResolvedValue({
      ok: true,
      defaultModelId: 'model-1',
      models: [
        {
          id: 'model-1',
          model: 'model-1',
          label: 'Demo Model',
          displayName: 'Demo Model',
          maxTokens: 128000,
          disabled: false,
          supportsImages: true,
          isDefault: true,
          quotaInfo: null,
        },
      ],
    });
    mocks.getTopbar.mockResolvedValue({
      ok: true,
      panels: {
        context: { available: false },
        usage: { available: false },
        quota: { available: false },
      },
    });
    mocks.getPluginSettings.mockResolvedValue({ ok: true, values: {} });
    mocks.getHostLocale.mockResolvedValue({
      ok: true,
      locale: 'en',
      supportedLanguages: ['en', 'zh-CN'],
    });
    mocks.listProjects.mockResolvedValue({
      ok: true,
      projects: [],
      groups: [],
      defaultSessionPath: '/workspace/demo',
    });
    mocks.getComposerState.mockResolvedValue({
      ok: true,
      enabled: true,
      settings: {},
      quickPrompts: [],
      frequentPrompts: [],
    });
    mocks.getRemoteStatus.mockResolvedValue({ ok: true, available: false });
    mocks.getWebAccessStatus.mockResolvedValue({
      ok: true,
      channel: 'loopback',
      permissionLevel: 'L0',
      channelEndpoints: {},
    });
    mocks.authenticateWithToken.mockResolvedValue({ ok: true, channel: 'cloudflare' });
    mocks.getSessionDetail.mockResolvedValue({
      ok: true,
      session: {
        cascadeId: 'sess-1',
        trajectoryId: null,
        trajectoryType: null,
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 2,
        source: null,
        metadata: null,
        generatorMetadata: [],
      },
      events: [
        makeUserEvent(0, 'Initial question'),
        makeAssistantEvent(1, 'Initial answer'),
      ],
    });
    mocks.getGitDiff.mockResolvedValue({ ok: true, isGitRepo: false, branch: '', files: [] });
    mocks.getFsTree.mockResolvedValue({ ok: true, entries: [] });
    mocks.listArtifacts.mockResolvedValue({ ok: true, artifacts: [] });
    mocks.subscribeSessionStream.mockImplementation((_sessionId, callbacks) => {
      Object.assign(mockSseCallbacks, callbacks);
      return () => {};
    });
  });

  it('renders optimistic user bubble immediately while sendMessage is pending, scrolls to bottom, and deduplicates on SSE delta', async () => {
    let resolveSend!: (value: { ok: boolean; cascadeId: string }) => void;
    mocks.sendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );

    renderApp();

    await waitFor(
      () => {
        expect(screen.getByTestId('session-event-0')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    const scrollArea = screen.getByTestId('session-stream-scroll');
    Object.defineProperty(scrollArea, 'scrollHeight', { value: 900, configurable: true });
    scrollArea.scrollTop = 0;

    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Ship optimistic UI' } });
    fireEvent.click(screen.getByTestId('composer-send-btn'));

    // Immediately visible in timeline & composer cleared while sendMessage has NOT resolved yet
    await waitFor(
      () => {
        expect(screen.getByTestId('session-event--1')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    const optCard = screen.getByTestId('session-event--1');
    expect(optCard).toHaveAttribute('data-optimistic', 'true');
    expect(optCard).toHaveTextContent('Ship optimistic UI');
    expect(textarea.value).toBe('');
    expect(scrollArea.scrollTop).toBe(900);
    expect(screen.getByTestId('composer-cancel-btn')).toBeInTheDocument();

    // SSE delta delivers real USER_INPUT (seq=2) and assistant step (seq=3)
    act(() => {
      mockSseCallbacks.onDelta?.({
        cascadeId: 'sess-1',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        totalSteps: 4,
        events: [
          makeUserEvent(2, 'Ship optimistic UI'),
          makeAssistantEvent(3, 'Working on it.'),
        ],
      });
    });

    expect(screen.queryByTestId('session-event--1')).not.toBeInTheDocument();
    const realCard = screen.getByTestId('session-event-2');
    expect(realCard).toHaveTextContent('Ship optimistic UI');
    expect(screen.getAllByText('Ship optimistic UI')).toHaveLength(1);
    expect(screen.getByTestId('session-event-3')).toHaveTextContent('Working on it.');

    await act(async () => {
      resolveSend({ ok: true, cascadeId: 'sess-1' });
    });
  });

  it('rolls back optimistic bubble, status, error banner, and restores draft on sendMessage failure', async () => {
    let rejectSend!: (err: Error) => void;
    mocks.sendMessage.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectSend = reject;
        }),
    );

    renderApp();

    await waitFor(
      () => {
        expect(screen.getByTestId('session-event-0')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Failed prompt' } });
    fireEvent.click(screen.getByTestId('composer-send-btn'));

    await waitFor(
      () => {
        expect(screen.getByTestId('session-event--1')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    expect(screen.getByTestId('composer-cancel-btn')).toBeInTheDocument();
    expect(textarea.value).toBe('');

    await act(async () => {
      rejectSend(new ApiError('Bad Gateway', 502, 'HTTP_502'));
    });

    await waitFor(
      () => {
        expect(screen.queryByTestId('session-event--1')).not.toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    expect(screen.queryByTestId('composer-cancel-btn')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Bad Gateway');
    expect(textarea.value).toBe('Failed prompt');
  });

  it('preserves and deduplicates optimistic message across SSE resync full refresh', async () => {
    let resolveSend!: (value: { ok: boolean; cascadeId: string }) => void;
    mocks.sendMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );

    renderApp();

    await waitFor(
      () => {
        expect(screen.getByTestId('session-event-0')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Resync test msg' } });
    fireEvent.click(screen.getByTestId('composer-send-btn'));

    await waitFor(
      () => {
        expect(screen.getByTestId('session-event--1')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // 1. Resync before server persists user step -> optimistic bubble must stay
    await act(async () => {
      mockSseCallbacks.onResync?.();
    });
    expect(screen.getByTestId('session-event--1')).toBeInTheDocument();

    // 2. Resync after server persists user step (seq=2) -> optimistic bubble replaced, no duplicate
    mocks.getSessionDetail.mockResolvedValueOnce({
      ok: true,
      session: {
        cascadeId: 'sess-1',
        trajectoryId: null,
        trajectoryType: null,
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 3,
        source: null,
        metadata: null,
        generatorMetadata: [],
      },
      events: [
        makeUserEvent(0, 'Initial question'),
        makeAssistantEvent(1, 'Initial answer'),
        makeUserEvent(2, 'Resync test msg'),
      ],
    });
    await act(async () => {
      mockSseCallbacks.onResync?.();
    });

    await waitFor(
      () => {
        expect(screen.getByTestId('session-event-2')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    expect(screen.queryByTestId('session-event--1')).not.toBeInTheDocument();
    expect(screen.getAllByText('Resync test msg')).toHaveLength(1);

    await act(async () => {
      resolveSend({ ok: true, cascadeId: 'sess-1' });
    });
  });

  it('shows WriteConfirmModal on Cloudflare write challenges and settles confirm/cancel sequentially', async () => {
    mocks.getSessionDetail.mockResolvedValue({
      ok: true,
      session: {
        cascadeId: 'sess-1',
        trajectoryId: null,
        trajectoryType: null,
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        source: null,
        metadata: null,
        generatorMetadata: [],
      },
      events: [makeUserEvent(0, 'Hello')],
    });
    mocks.subscribeSessionStream.mockReturnValue(() => {});

    renderApp();

    await waitFor(() => {
      expect(mocks.setConfirmWriteHandler).toHaveBeenCalledWith(expect.any(Function));
    });

    const registeredHandler = mocks.setConfirmWriteHandler.mock.calls[0]?.[0] as (challenge: {
      action: string;
      channel: string;
      confirmToken: string;
      method: string;
      path: string;
    }) => Promise<boolean>;

    let p1!: Promise<boolean>;
    let p2!: Promise<boolean>;
    await act(async () => {
      p1 = registeredHandler({
        action: 'POST /api/v1/sessions/sess-1/messages',
        channel: 'cloudflare',
        confirmToken: 'tok-1',
        method: 'POST',
        path: '/api/v1/sessions/sess-1/messages',
      });
      p2 = registeredHandler({
        action: 'PUT /api/v1/fs/write',
        channel: 'cloudflare',
        confirmToken: 'tok-2',
        method: 'PUT',
        path: '/api/v1/fs/write',
      });
    });

    expect(screen.getByTestId('cloudflare-confirm-modal')).toBeInTheDocument();
    expect(screen.getByTestId('cloudflare-confirm-action')).toHaveTextContent(
      'POST /api/v1/sessions/sess-1/messages',
    );

    fireEvent.click(screen.getByTestId('cloudflare-confirm-submit'));
    await expect(p1).resolves.toBe(true);

    expect(screen.getByTestId('cloudflare-confirm-action')).toHaveTextContent(
      'PUT /api/v1/fs/write',
    );

    fireEvent.click(screen.getByTestId('cloudflare-confirm-cancel'));
    await expect(p2).resolves.toBe(false);
    expect(screen.queryByTestId('cloudflare-confirm-modal')).toBeNull();
  });

  it('opens settings modal on /pc/settings and unlocks via 401 token card', async () => {
    const origLocation = window.location;
    Object.defineProperty(window, 'location', {
      value: { pathname: '/pc/settings', search: '', origin: 'https://ag.example.com' },
      configurable: true,
    });
    try {
      mocks.getHealth.mockRejectedValueOnce(new ApiError('UNAUTHORIZED', 401, 'UNAUTHORIZED'));
      mocks.listSessions.mockRejectedValueOnce(new ApiError('UNAUTHORIZED', 401, 'UNAUTHORIZED'));

      renderApp();

      await waitFor(() => {
        expect(screen.getByTestId('auth-unlock-card')).toBeInTheDocument();
      });
      // HostAdminModal also initializes open on /pc/settings
      expect(screen.getByRole('dialog', { name: /Host Admin/i })).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('auth-unlock-token-input'), {
        target: { value: 'shared-tok-xyz' },
      });
      fireEvent.click(screen.getByTestId('auth-unlock-submit-btn'));

      await waitFor(() => {
        expect(mocks.authenticateWithToken).toHaveBeenCalledWith('shared-tok-xyz');
      });
      await waitFor(() => {
        expect(screen.queryByTestId('auth-unlock-card')).toBeNull();
      });
    } finally {
      Object.defineProperty(window, 'location', {
        value: origLocation,
        configurable: true,
      });
    }
  });
});
