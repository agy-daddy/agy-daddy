import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { Composer } from './chat/Composer';
import { StepCard } from './chat/StepCard';
import { VirtualChatList } from './chat/VirtualChatList';
import DiffViewer from './lazy/DiffViewer';
import PtyTerminal from './lazy/PtyTerminal';
import { extractTokenAndScrubUrl } from './store/token';
import { normalizeModels, resolveUnifiedModelName, sanitizePresets } from './store/useRemoteStore';
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
