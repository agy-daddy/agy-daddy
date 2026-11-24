import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { Composer } from './chat/Composer';
import { StepCard } from './chat/StepCard';
import { VirtualChatList } from './chat/VirtualChatList';
import DiffViewer from './lazy/DiffViewer';
import PtyTerminal from './lazy/PtyTerminal';
import { extractTokenAndScrubUrl } from './store/token';
import {
  mergeEvents,
  normalizeModels,
  RemoteStoreController,
  remoteStore,
  resolveUnifiedModelName,
  sanitizePresets
} from './store/useRemoteStore';
import type { ComposerPreset, SessionEvent, SessionEventKind } from './types';

describe('Token extraction & scrub', () => {
  it('extracts t from URL and scrubs it via replaceState', () => {
    window.history.replaceState(null, '', '/?t=secret123&session=abc');
    const res = extractTokenAndScrubUrl();
    expect(res.token).toBe('secret123');
    expect(res.sessionId).toBe('abc');
    expect(window.location.search).toBe('?session=abc');
  });
});

describe('StepCard & VirtualChatList', () => {
  const ALL_KINDS: SessionEventKind[] = [
    'user',
    'thinking_and_text',
    'command',
    'file_view',
    'code_action',
    'ask_question',
    'web_search',
    'checkpoint',
    'system',
    'tool_generic',
    'error'
  ];

  it('renders all 11 step kinds cleanly', () => {
    for (let i = 0; i < ALL_KINDS.length; i++) {
      const kind = ALL_KINDS[i];
      const ev: SessionEvent = {
        seq: i + 1,
        kind,
        status: kind === 'error' ? 'error' : 'done',
        rawType: `CORTEX_STEP_TYPE_${kind.toUpperCase()}`,
        title: `step-${kind}`,
        payload: {
          text: 'hello **world**',
          thinking: 'pondering',
          response: 'answer text',
          commandLine: 'ls -la',
          exitCode: 0,
          absolutePathUri: '/repo/a.ts',
          actionSpec: { targetFile: '/repo/a.ts', description: 'edit' },
          questions: [{ question: 'Proceed?', options: ['Yes', 'No'] }],
          query: 'preact',
          webDocuments: [{ title: 'Preact', url: 'https://preactjs.com' }],
          sessionSummary: 'checkpoint ok',
          message: 'system ok',
          args: { a: 1 },
          error: 'boom'
        }
      };
      const { unmount } = render(<StepCard event={ev} />);
      expect(screen.getByTestId(`step-card-${i + 1}`)).toBeInTheDocument();
      unmount();
    }
  });

  it('virtualizes 520 steps so only a bounded window mounts in DOM', () => {
    const events: SessionEvent[] = Array.from({ length: 520 }, (_, i) => ({
      seq: i + 1,
      kind: 'thinking_and_text',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      payload: { response: `step ${i + 1}` }
    }));
    render(<VirtualChatList events={events} />);
    const mounted = screen.getAllByTestId(/^step-card-/);
    expect(mounted.length).toBeLessThan(40);
  });
});

describe('Composer controls', () => {
  it('hides voice button when voiceSupported is false and renders when true', () => {
    const baseProps = {
      text: '',
      images: [],
      presets: [{ label: '审查', prompt: '请审查代码' }],
      models: [{ id: 'm1', shortName: 'Gemini 2.5' }],
      selectedModelId: 'm1',
      chatMode: 'chat' as const,
      dispatchMode: 'queue' as const,
      permissionLevel: 'L1' as const,
      running: false,
      voiceSupported: false,
      queue: [],
      onTextChange: vi.fn(),
      onAddImage: vi.fn(),
      onRemoveImage: vi.fn(),
      onModelChange: vi.fn(),
      onChatModeChange: vi.fn(),
      onDispatchModeChange: vi.fn(),
      onSend: vi.fn(),
      onCancel: vi.fn(),
      onOptimize: vi.fn().mockResolvedValue(undefined),
      onRemoveQueueItem: vi.fn()
    };

    const { rerender } = render(<Composer {...baseProps} />);
    expect(screen.queryByTestId('voice-input-btn')).toBeNull();

    rerender(<Composer {...baseProps} voiceSupported={true} />);
    expect(screen.getByTestId('voice-input-btn')).toBeInTheDocument();
  });
});

describe('Lazy modules: DiffViewer & PtyTerminal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('injects path:line quote into composer on diff line tap', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          ok: true,
          branch: 'main',
          files: [{ path: 'src/app.ts', status: 'M' }],
          diffText: 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -10,1 +10,2 @@\n+const x = 42;'
        })
    });
    vi.stubGlobal('fetch', mockFetch);

    const onInject = vi.fn();
    render(<DiffViewer rootPath="/repo" onInjectQuote={onInject} />);

    const lineBtn = await screen.findByText('+const x = 42;');
    fireEvent.click(lineBtn);

    const bar = await screen.findByTestId('inline-comment-bar');
    const input = bar.querySelector('input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: '请改为常量名' } });
    fireEvent.click(screen.getByText('回注对话'));

    expect(onInject).toHaveBeenCalledTimes(1);
    const quote = onInject.mock.calls[0][0] as string;
    expect(quote).toContain('`src/app.ts:10`');
    expect(quote).toContain('const x = 42;');
    expect(quote).toContain('请改为常量名');
  });

  it('gates PtyTerminal when permissionLevel is L0/L1', () => {
    render(
      <PtyTerminal rootPath="/repo" sessionId="s1" permissionLevel="L1" token="tok" />
    );
    expect(screen.getByTestId('pty-l2-locked')).toBeInTheDocument();
  });
});

describe('App end-to-end bootstrap & approval flow', () => {
  afterEach(() => {
    remoteStore.logoutToken();
    remoteStore.destroy();
    vi.unstubAllGlobals();
  });

  it('renders bootstrap session, topbar attention badge, and floating allow action', async () => {
    window.history.replaceState(null, '', '/?t=test-tok');
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/bootstrap')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              channel: 'lan',
              permissionLevel: 'L1',
              writeEnabled: true,
              models: [{ id: 'g25', shortName: 'G2.5' }],
              defaultModelId: 'g25',
              workspaces: ['/repo'],
              voiceSupported: false,
              telemetry: {
                panels: {
                  context: {
                    available: true,
                    data: {
                      hasSession: true,
                      used: 120000,
                      budget: 400000,
                      percent: 30,
                      cacheHitRate: 85,
                      warnThresholdTokens: 240000,
                      cliffThresholdTokens: 328000,
                      model: 'G2.5'
                    }
                  },
                  quota: {
                    available: true,
                    data: {
                      gemini: {
                        remainingPercent: 72,
                        percentText: '72%',
                        fiveHour: { remainingPercent: 72, percentText: '72%', countdownText: '2小时10分' },
                        weekly: { remainingPercent: 85, percentText: '85%', countdownText: '3天4小时' }
                      },
                      claude: {
                        remainingPercent: 45,
                        percentText: '45%',
                        fiveHour: { remainingPercent: 90, percentText: '90%', countdownText: '1小时30分' },
                        weekly: { remainingPercent: 45, percentText: '45%', countdownText: '2天1小时' }
                      }
                    }
                  }
                }
              }
            })
        };
      }
      if (url.includes('/api/v1/sessions/s1/steps/2/approve')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
      }
      if (url.includes('/api/v1/sessions/s1')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: { cascadeId: 's1', status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 2 },
              events: [
                {
                  seq: 1,
                  kind: 'user',
                  status: 'done',
                  rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
                  payload: { text: 'run tests' }
                },
                {
                  seq: 2,
                  kind: 'command',
                  status: 'pending',
                  rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
                  payload: { commandLine: 'npm test' }
                }
              ]
            })
        };
      }
      if (url.includes('/api/v1/sessions')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              sessions: [
                {
                  cascadeId: 's1',
                  title: 'Test Session',
                  summary: '',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  needsAttention: true,
                  attentionReason: '等待审批',
                  stepCount: 2,
                  lastModifiedTime: null,
                  workspaceUri: '/repo',
                  branchName: 'main'
                }
              ]
            })
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, files: [] }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const badge = await screen.findByTestId('attention-badge');
    expect(badge.textContent).toBe('1');

    // TopBar no longer renders topbar-model-btn; model selection stays in Composer
    expect(screen.queryByTestId('topbar-model-btn')).toBeNull();
    expect(screen.getByTestId('composer-model-btn')).toBeInTheDocument();

    // Opening quota panel displays both Gemini and Claude 5h + Week quotas
    fireEvent.click(screen.getByTestId('quota-capsule-btn'));
    const quotaCard = await screen.findByTestId('quota-panel-card');
    expect(quotaCard).toBeInTheDocument();
    expect(screen.getByTestId('quota-gemini-5h')).toHaveTextContent('72%');
    expect(screen.getByTestId('quota-gemini-weekly')).toHaveTextContent('85%');
    expect(screen.getByTestId('quota-claude-5h')).toHaveTextContent('90%');
    expect(screen.getByTestId('quota-claude-weekly')).toHaveTextContent('45%');

    const floatCard = await screen.findByTestId('pending-floating-card');
    expect(floatCard).toBeInTheDocument();

    fireEvent.click(screen.getByText('允许 Allow'));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes('/api/v1/sessions/s1/steps/2/approve'))
      ).toBe(true);
    });
  });
});

describe('Regression suite (P01-P07)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('P01: handles null/malformed presets cleanly and keeps drawers working', () => {
    const rawPresets = [
      null,
      undefined,
      42,
      { label: '', prompt: '' },
      { prompt: '检查边界条件' },
      { label: '代码审查', text: '请审查变更' }
    ];
    const clean = sanitizePresets(rawPresets);
    expect(clean).toHaveLength(2);
    expect(clean[0].label).toBe('检查边界条件');
    expect(clean[1].label).toBe('代码审查');
    expect(clean[1].prompt).toBe('请审查变更');

    render(
      <Composer
        text=""
        images={[]}
        presets={rawPresets as unknown as ComposerPreset[]}
        models={[{ id: 'm1', shortName: 'G2.5' }]}
        selectedModelId="m1"
        chatMode="chat"
        dispatchMode="queue"
        permissionLevel="L1"
        running={false}
        voiceSupported={false}
        queue={[]}
        onTextChange={vi.fn()}
        onAddImage={vi.fn()}
        onRemoveImage={vi.fn()}
        onModelChange={vi.fn()}
        onChatModeChange={vi.fn()}
        onDispatchModeChange={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        onOptimize={vi.fn().mockResolvedValue(undefined)}
        onRemoveQueueItem={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('/ 快捷词'));
    const pop = screen.getByTestId('presets-popover');
    expect(pop).toHaveTextContent('检查边界条件');
    expect(pop).toHaveTextContent('代码审查');
  });

  it('P02: 200-file diff defaults to first file and caps DOM lines at 300 with load-more', async () => {
    const files = Array.from({ length: 200 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      status: 'M'
    }));
    const bigDiffLines = Array.from({ length: 350 }, (_, j) => `+const v${j} = ${j};`).join('\n');
    const diffText = files
      .map((f, idx) =>
        idx === 0
          ? `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1,1 +1,350 @@\n${bigDiffLines}`
          : `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1,1 +1,2 @@\n+export const x${idx} = ${idx};`
      )
      .join('\n');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ ok: true, branch: 'main', files, diffText })
      })
    );

    const { container } = render(<DiffViewer rootPath="/repo" />);
    await screen.findByText('+const v0 = 0;');

    const renderedLines = container.querySelectorAll('[data-diff-line="1"]');
    expect(renderedLines.length).toBe(299);
    expect(screen.getByText(/加载更多（剩余 51 行）/)).toBeInTheDocument();

    fireEvent.click(screen.getByText(/加载更多/));
    expect(container.querySelectorAll('[data-diff-line="1"]').length).toBe(350);
  });

  it('P03 & P07: filters placeholder/empty models, picks valid default, and unifies model label', () => {
    const filtered = normalizeModels([
      '',
      { id: '', label: 'bad' },
      { id: 'MODEL_PLACEHOLDER_M18', shortName: 'MODEL_PLACEHOLDER_M18' },
      { id: 'g25', shortName: 'Gemini 2.5' },
      { id: 'g25-dup', shortName: 'Gemini 2.5' },
      { id: 'c4', name: 'Claude 4' }
    ]);
    expect(filtered).toEqual([
      { id: 'g25', label: 'Gemini 2.5' },
      { id: 'c4', label: 'Claude 4' }
    ]);

    expect(
      resolveUnifiedModelName(
        { context: { available: true, data: { used: 10, budget: 100, model: 'g25' } } },
        filtered,
        'c4'
      )
    ).toBe('Gemini 2.5');
  });

  it('P04: keeps Queue/Steer button mounted and disabled while running with empty input', () => {
    render(
      <Composer
        text=""
        images={[]}
        presets={[]}
        models={[{ id: 'm1', shortName: 'G2.5' }]}
        selectedModelId="m1"
        chatMode="chat"
        dispatchMode="queue"
        permissionLevel="L1"
        running={true}
        voiceSupported={false}
        queue={[]}
        onTextChange={vi.fn()}
        onAddImage={vi.fn()}
        onRemoveImage={vi.fn()}
        onModelChange={vi.fn()}
        onChatModeChange={vi.fn()}
        onDispatchModeChange={vi.fn()}
        onSend={vi.fn()}
        onCancel={vi.fn()}
        onOptimize={vi.fn().mockResolvedValue(undefined)}
        onRemoveQueueItem={vi.fn()}
      />
    );

    expect(screen.getByTestId('composer-stop-btn')).toBeInTheDocument();
    const sendBtn = screen.getByTestId('composer-send-btn');
    expect(sendBtn).toBeInTheDocument();
    expect(sendBtn).toBeDisabled();
    expect(sendBtn.textContent).toBe('入队');
  });
});

class MockEventSource {
  public static instances: MockEventSource[] = [];
  public url: string;
  public onopen: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  public closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    queueMicrotask(() => {
      if (!this.closed && this.onopen) {
        this.onopen();
      }
    });
  }

  public addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  public emit(type: string, data: unknown, lastEventId = ''): void {
    const list = this.listeners.get(type) || [];
    const ev = { data: JSON.stringify(data), lastEventId } as MessageEvent;
    for (const fn of list) fn(ev);
  }

  public close(): void {
    this.closed = true;
  }
}

function createAppSessionFetchMock(
  sessionId: string,
  opts?: {
    onSendMessage?: (body: Record<string, unknown>) => Promise<{
      ok: boolean;
      status?: number;
      body: Record<string, unknown>;
    }>;
  }
) {
  let getSessionCalls = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();

    if (url.includes('/api/v1/bootstrap')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ok: true,
            channel: 'lan',
            permissionLevel: 'L1',
            writeEnabled: true,
            models: [{ id: 'g25', shortName: 'G2.5' }],
            defaultModelId: 'g25',
            workspaces: ['/repo'],
            voiceSupported: false
          })
      };
    }

    if (url.includes(`/api/v1/sessions/${sessionId}/messages`) && method === 'POST') {
      const parsedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (opts?.onSendMessage) {
        const custom = await opts.onSendMessage(parsedBody);
        return {
          ok: custom.ok,
          status: custom.status ?? (custom.ok ? 200 : 500),
          text: async () => JSON.stringify(custom.body)
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true })
      };
    }

    if (url.includes(`/api/v1/sessions/${sessionId}/queue`)) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, cascadeId: sessionId, queue: [] })
      };
    }

    if (url.includes(`/api/v1/sessions/${sessionId}`)) {
      getSessionCalls++;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ok: true,
            session: { cascadeId: sessionId, status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 1 },
            events: [
              {
                seq: 0,
                kind: 'user',
                status: 'done',
                rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
                payload: { text: 'initial prompt' }
              }
            ]
          })
      };
    }

    if (url.includes('/api/v1/sessions')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ok: true,
            sessions: [
              {
                cascadeId: sessionId,
                title: `Session ${sessionId}`,
                summary: '',
                status: 'CASCADE_RUN_STATUS_IDLE',
                needsAttention: false,
                stepCount: 1,
                lastModifiedTime: null,
                workspaceUri: '/repo',
                branchName: 'main'
              }
            ]
          })
      };
    }

    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, files: [] }) };
  });

  return { fetchMock, getSessionCalls: () => getSessionCalls };
}

describe('Optimistic UI: mergeEvents, StepCard & App send lifecycle', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    remoteStore.logoutToken();
    remoteStore.destroy();
    vi.unstubAllGlobals();
  });

  it('sorts real events (>=0) ascending before negative optimistic events in creation order', () => {
    const prev: SessionEvent[] = [
      {
        seq: 0,
        kind: 'user',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'first real' }
      },
      {
        seq: -1,
        kind: 'user',
        status: 'pending',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'opt 1', clientTempId: 't1', optimistic: true }
      }
    ];
    const incoming: SessionEvent[] = [
      {
        seq: -2,
        kind: 'user',
        status: 'pending',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'opt 2', clientTempId: 't2', optimistic: true }
      },
      {
        seq: 1,
        kind: 'thinking_and_text',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        payload: { response: 'reply' }
      }
    ];

    const merged = mergeEvents(prev, incoming);
    expect(merged.map((e) => e.seq)).toEqual([0, 1, -1, -2]);
  });

  it('reconciles optimistic user events by normalized text first, then FIFO, ignoring existing seqs', () => {
    const prev: SessionEvent[] = [
      {
        seq: 0,
        kind: 'user',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'earlier' }
      },
      {
        seq: -1,
        kind: 'user',
        status: 'pending',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'first msg', clientTempId: 't1', optimistic: true }
      },
      {
        seq: -2,
        kind: 'user',
        status: 'pending',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'second   msg', clientTempId: 't2', optimistic: true }
      }
    ];

    // Updating existing seq 0 must NOT consume pending optimistic events
    const afterExistingUpdate = mergeEvents(prev, [
      {
        seq: 0,
        kind: 'user',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'earlier' }
      }
    ]);
    expect(afterExistingUpdate.map((e) => e.seq)).toEqual([0, -1, -2]);

    // New seq 2 matching normalized text of seq -2 removes seq -2 and keeps seq -1
    const afterTextMatch = mergeEvents(afterExistingUpdate, [
      {
        seq: 2,
        kind: 'user',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'second msg' }
      }
    ]);
    expect(afterTextMatch.map((e) => e.seq)).toEqual([0, 2, -1]);

    // New seq 3 with different text falls back to FIFO and removes seq -1
    const afterFifo = mergeEvents(afterTextMatch, [
      {
        seq: 3,
        kind: 'user',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'rewritten prompt' }
      }
    ]);
    expect(afterFifo.map((e) => e.seq)).toEqual([0, 2, 3]);
  });

  it('renders optimistic user StepCard as user bubble with sending badge instead of pending approval card', () => {
    const optimisticEv: SessionEvent = {
      seq: -1,
      kind: 'user',
      status: 'pending',
      rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
      payload: {
        text: '优化远程响应速度',
        clientTempId: 'opt_1',
        optimistic: true
      }
    };

    const { rerender } = render(<StepCard event={optimisticEv} />);
    const card = screen.getByTestId('step-card--1');
    expect(card).toHaveAttribute('data-kind', 'user');
    expect(card).toHaveAttribute('data-optimistic', 'true');
    expect(screen.queryByTestId('inline-approval--1')).toBeNull();
    expect(screen.getByText('发送中…')).toBeInTheDocument();
    expect(screen.getByText('优化远程响应速度')).toBeInTheDocument();

    const realEv: SessionEvent = {
      seq: 4,
      kind: 'user',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
      payload: { text: '优化远程响应速度' }
    };
    rerender(<StepCard event={realEv} />);
    const realCard = screen.getByTestId('step-card-4');
    expect(realCard).not.toHaveAttribute('data-optimistic');
    expect(screen.queryByText('发送中…')).toBeNull();
  });

  it('renders optimistic user bubble immediately before delayed sendMessage resolves, then reconciles on SSE delta without reloading detail', async () => {
    window.history.replaceState(null, '', '/?t=tok-opt-1');
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);

    let resolveSend!: (val: { ok: boolean; body: Record<string, unknown> }) => void;
    const { fetchMock, getSessionCalls } = createAppSessionFetchMock('s-opt-1', {
      onSendMessage: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, body: { ok: true } }), 300);
          resolveSend = resolve;
        })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await screen.findByText('initial prompt');
    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });
    const detailCallsBeforeSend = getSessionCalls();

    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'hello optimistic' } });
    fireEvent.click(screen.getByTestId('composer-send-btn'));

    // Immediately before the 300ms Promise resolves: input is cleared, bubble is visible, no floating approval card
    expect(textarea.value).toBe('');
    const optCard = await screen.findByTestId('step-card--1');
    expect(optCard).toHaveTextContent('hello optimistic');
    expect(optCard).toHaveTextContent('发送中…');
    expect(screen.queryByTestId('pending-floating-card')).toBeNull();

    // Resolve delayed sendMessage
    await act(async () => {
      resolveSend({ ok: true, body: { ok: true } });
    });

    // Connected SSE must NOT trigger redundant loadSessionDetail
    expect(getSessionCalls()).toBe(detailCallsBeforeSend);

    // Emit real user step via SSE session.delta -> only 1 user message remains for the new message
    await act(async () => {
      MockEventSource.instances[0].emit('session.delta', {
        cascadeId: 's-opt-1',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        totalSteps: 2,
        events: [
          {
            seq: 1,
            kind: 'user',
            status: 'done',
            rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
            payload: { text: 'hello optimistic' }
          }
        ]
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId('step-card--1')).toBeNull();
      expect(screen.getByTestId('step-card-1')).toHaveTextContent('hello optimistic');
    });
    expect(screen.getAllByText('hello optimistic')).toHaveLength(1);
    expect(screen.queryByText('发送中…')).toBeNull();
  });

  it('removes optimistic bubble and shows only queue card when backend returns queued: true', async () => {
    window.history.replaceState(null, '', '/?t=tok-opt-2');
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);

    let resolveSend!: (val: { ok: boolean; body: Record<string, unknown> }) => void;
    const { fetchMock } = createAppSessionFetchMock('s-opt-2', {
      onSendMessage: () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
    await screen.findByText('initial prompt');

    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'queued task' } });
    fireEvent.click(screen.getByTestId('composer-send-btn'));

    const optBubble = await screen.findByText('queued task');
    const optCard = optBubble.closest('[data-optimistic="true"]');
    expect(optCard).not.toBeNull();
    expect(optCard?.getAttribute('data-testid')).toMatch(/^step-card--\d+$/);

    await act(async () => {
      resolveSend({
        ok: true,
        body: {
          ok: true,
          queued: true,
          queue: [
            {
              id: 'q-srv-1',
              sessionId: 's-opt-2',
              text: 'queued task',
              mode: 'chat',
              dispatchMode: 'queue',
              status: 'queued',
              createdAt: Date.now()
            }
          ]
        }
      });
    });

    await waitFor(() => {
      expect(document.querySelector('[data-optimistic="true"]')).toBeNull();
      expect(screen.getByTestId('queued-msg-q-srv-1')).toHaveTextContent('queued task');
    });
    expect(screen.getAllByText('queued task')).toHaveLength(1);
  });

  it('rolls back optimistic bubble and restores draft on sendMessage rejection without overwriting new typing', async () => {
    window.history.replaceState(null, '', '/?t=tok-opt-3');
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);

    let rejectCount = 0;
    let triggerReject!: () => void;
    const { fetchMock } = createAppSessionFetchMock('s-opt-3', {
      onSendMessage: () =>
        new Promise((resolve) => {
          rejectCount++;
          triggerReject = () =>
            resolve({ ok: false, status: 500, body: { ok: false, error: 'NETWORK_FAIL' } });
        })
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(MockEventSource.instances.length).toBeGreaterThan(0));
    await screen.findByText('initial prompt');

    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'draft to restore' } });
    fireEvent.click(screen.getByTestId('composer-send-btn'));

    const optText = await screen.findByText('draft to restore');
    expect(optText.closest('[data-optimistic="true"]')).not.toBeNull();
    expect(textarea.value).toBe('');

    await act(async () => {
      triggerReject();
    });

    await waitFor(() => {
      expect(document.querySelector('[data-optimistic="true"]')).toBeNull();
      expect(textarea.value).toBe('draft to restore');
    });
    expect(screen.getByRole('status')).toHaveTextContent('发送失败');

    // Second attempt: user starts typing new text before failure -> must NOT overwrite new text
    fireEvent.click(screen.getByTestId('composer-send-btn'));
    expect(await screen.findByText('发送中…')).toBeInTheDocument();
    fireEvent.input(textarea, { target: { value: 'newer user input' } });

    await act(async () => {
      triggerReject();
    });

    await waitFor(() => {
      expect(screen.queryByText('发送中…')).toBeNull();
    });
    expect(rejectCount).toBe(2);
    expect(textarea.value).toBe('newer user input');
  });

  it('skips redundant loadSessionDetail when SSE is connected for send/steer/retry/flush and falls back when disconnected', async () => {
    window.history.replaceState(null, '', '/?t=tok-ctrl-1&session=s-ctrl');
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);

    let getSessionCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/api/v1/bootstrap')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              channel: 'lan',
              permissionLevel: 'L1',
              writeEnabled: true,
              models: [{ id: 'g25', shortName: 'G2.5' }],
              defaultModelId: 'g25',
              workspaces: ['/repo']
            })
        };
      }
      if (url.includes('/api/v1/sessions/s-ctrl/queue/') && url.includes('/steer')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, queue: [] }) };
      }
      if (url.includes('/api/v1/sessions/s-ctrl/queue')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, queue: [] }) };
      }
      if (url.includes('/api/v1/sessions/s-ctrl/messages') && method === 'POST') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
      }
      if (url.includes('/api/v1/sessions/s-ctrl')) {
        getSessionCalls++;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              session: { cascadeId: 's-ctrl', status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 1 },
              events: [
                {
                  seq: 0,
                  kind: 'user',
                  status: 'done',
                  rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
                  payload: { text: 'synced from fallback' }
                }
              ]
            })
        };
      }
      if (url.includes('/api/v1/sessions')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              sessions: [
                {
                  cascadeId: 's-ctrl',
                  title: 'Ctrl Session',
                  summary: '',
                  status: 'CASCADE_RUN_STATUS_IDLE',
                  stepCount: 1,
                  lastModifiedTime: null,
                  workspaceUri: '/repo',
                  branchName: 'main'
                }
              ]
            })
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const store = new RemoteStoreController();
    await store.init();
    await waitFor(() => expect(store.getState().sseStatus).toBe('connected'));

    const baselineGets = getSessionCalls;

    // 1. sendMessage with connected SSE: no loadSessionDetail
    store.setComposerText('msg one');
    await store.sendMessage();
    expect(getSessionCalls).toBe(baselineGets);
    expect(store.getState().events.some((e) => e.seq === -1 && e.payload?.optimistic === true)).toBe(true);

    // 2. steerQueuedMessage (server) with connected SSE: no loadSessionDetail
    store.getState().queue.push({
      id: 'q-srv-steer',
      queueId: 'q-srv-steer',
      sessionId: 's-ctrl',
      text: 'steer me',
      mode: 'chat',
      dispatchMode: 'queue',
      createdAt: Date.now(),
      status: 'queued',
      source: 'server'
    });
    await store.steerQueuedMessage('q-srv-steer');
    expect(getSessionCalls).toBe(baselineGets);

    // 3. retryQueuedMessage with connected SSE: no loadSessionDetail
    store.getState().queue.push({
      id: 'q-retry-1',
      sessionId: 's-ctrl',
      text: 'retry me',
      mode: 'chat',
      dispatchMode: 'queue',
      createdAt: Date.now(),
      status: 'failed',
      source: 'local'
    });
    await store.retryQueuedMessage('q-retry-1');
    expect(getSessionCalls).toBe(baselineGets);

    // 4. flushPendingQueue with connected SSE: no loadSessionDetail
    store.getState().queue.push({
      id: 'q-flush-1',
      sessionId: 's-ctrl',
      text: 'flush me',
      mode: 'chat',
      dispatchMode: 'queue',
      createdAt: Date.now(),
      status: 'queued',
      source: 'local'
    });
    await store.flushPendingQueue();
    expect(getSessionCalls).toBe(baselineGets);

    // 5. When SSE is disconnected, sendMessage triggers non-blocking fallback loadSessionDetail
    MockEventSource.instances[0]?.onerror?.();
    await waitFor(() => expect(store.getState().sseStatus).toBe('disconnected'));

    store.setComposerText('offline sse fallback');
    await store.sendMessage();
    await waitFor(() => expect(getSessionCalls).toBe(baselineGets + 1));
    store.destroy();
  });
});
