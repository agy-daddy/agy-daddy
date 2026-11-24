import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import type { QueuedMessage, SessionEvent } from '../types';
import { buildDisplayTimeline, isInternalAgentEvent } from './chatFilter';
import { Markdown } from './Markdown';
import { PendingFloatingCard } from './PendingFloatingCard';
import { StepCard } from './StepCard';
import { ToolGroupCard } from './ToolGroupCard';
import { VirtualChatList } from './VirtualChatList';

describe('chatFilter & buildDisplayTimeline', () => {
  it('filters internal agent/swarm/system/IPC messages while keeping real chat & errors & pending steps', () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        kind: 'system',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
        payload: { eventType: 'plan_review', message: '[plan review] internal prompt' }
      },
      {
        seq: 2,
        kind: 'system',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
        payload: { message: 'BROWSER_HOST_FACTS: viewport=1280x720' }
      },
      {
        seq: 3,
        kind: 'user',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: {
          text: '<SYSTEM_MESSAGE>[Message] timestamp=2026-11-24T00:00:00Z sender=abc content=[swarm] new board message #5</SYSTEM_MESSAGE>'
        }
      },
      {
        seq: 4,
        kind: 'user',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: '请帮我检查登录接口' }
      },
      {
        seq: 5,
        kind: 'tool_generic',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_GENERIC',
        title: 'post_message',
        payload: { toolName: 'post_message', args: { text: '@coordinator done' } }
      },
      {
        seq: 6,
        kind: 'tool_generic',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_UPDATE_FOCUS',
        payload: { toolName: 'update_focus', args: { focus: 'Checking code' } }
      },
      {
        seq: 7,
        kind: 'thinking_and_text',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        payload: { response: '', thinking: '' }
      },
      {
        seq: 8,
        kind: 'thinking_and_text',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        payload: { response: '我来帮你检查。', thinking: '先看看 auth.ts' }
      },
      {
        seq: 9,
        kind: 'error',
        status: 'error',
        rawType: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        payload: { error: 'Network timeout' }
      }
    ];

    expect(isInternalAgentEvent(events[0])).toBe(true);
    expect(isInternalAgentEvent(events[1])).toBe(true);
    expect(isInternalAgentEvent(events[2])).toBe(true);
    expect(isInternalAgentEvent(events[3])).toBe(false);
    expect(isInternalAgentEvent(events[4])).toBe(true);
    expect(isInternalAgentEvent(events[5])).toBe(true);
    expect(isInternalAgentEvent(events[6])).toBe(true);
    expect(isInternalAgentEvent(events[7])).toBe(false);
    expect(isInternalAgentEvent(events[8])).toBe(false);

    const timeline = buildDisplayTimeline(events);
    expect(timeline).toHaveLength(3);
    expect(timeline.map((t) => (t.type === 'step' ? t.event.seq : t.id))).toEqual([4, 8, 9]);
  });

  it('filters nested toolCall and raw.toolCall IPC steps so they never leak into ToolGroupCard', () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        kind: 'file_view',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_VIEW_FILE',
        payload: { absolutePathUri: '/repo/a.ts' }
      },
      {
        seq: 2,
        kind: 'tool_generic',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_TOOL_CALL',
        payload: { toolCall: { name: 'post_message', args: { text: '@verifier done' } } }
      },
      {
        seq: 3,
        kind: 'tool_generic',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_TOOL_CALL',
        payload: { raw: { toolCall: { name: 'default_api:swarm_wait' } } }
      },
      {
        seq: 4,
        kind: 'tool_generic',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_GENERIC',
        payload: { raw: { name: 'read_board' } }
      },
      {
        seq: 5,
        kind: 'command',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        payload: { commandLine: 'npm test', exitCode: 0 }
      }
    ];

    expect(isInternalAgentEvent(events[1])).toBe(true);
    expect(isInternalAgentEvent(events[2])).toBe(true);
    expect(isInternalAgentEvent(events[3])).toBe(true);

    const timeline = buildDisplayTimeline(events);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].type).toBe('tool_group');
    if (timeline[0].type === 'tool_group') {
      expect(timeline[0].events.map((e) => e.seq)).toEqual([1, 5]);
    }
  });

  it('merges 2+ consecutive non-pending tool calls (even across thinking-only planner steps) but keeps pending tool separate', () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        kind: 'file_view',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_VIEW_FILE',
        payload: { absolutePathUri: '/repo/a.ts' }
      },
      {
        seq: 2,
        kind: 'thinking_and_text',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        payload: { thinking: 'Now check b.ts', response: '' }
      },
      {
        seq: 3,
        kind: 'file_view',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_VIEW_FILE',
        payload: { absolutePathUri: '/repo/b.ts' }
      },
      {
        seq: 4,
        kind: 'command',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        payload: { commandLine: 'npm test', exitCode: 0 }
      },
      {
        seq: 5,
        kind: 'code_action',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_CODE_ACTION',
        payload: { actionSpec: { targetFile: '/repo/a.ts' }, diffStats: { additions: 3, deletions: 1 } }
      },
      {
        seq: 6,
        kind: 'command',
        status: 'pending',
        rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        payload: { commandLine: 'rm -rf dist' }
      }
    ];

    const timeline = buildDisplayTimeline(events);
    expect(timeline).toHaveLength(2);
    expect(timeline[0].type).toBe('tool_group');
    if (timeline[0].type === 'tool_group') {
      expect(timeline[0].events.map((e) => e.seq)).toEqual([1, 3, 4, 5]);
      expect(timeline[0].thinkingNotes).toHaveLength(1);
    }
    expect(timeline[1].type).toBe('step');
    if (timeline[1].type === 'step') {
      expect(timeline[1].event.seq).toBe(6);
    }
  });
});

describe('ToolGroupCard & StepCard collapsed defaults + inline interactions', () => {
  it('renders ToolGroupCard collapsed by default with concise summary and expands on click', () => {
    const onInspect = vi.fn();
    const events: SessionEvent[] = [
      {
        seq: 10,
        kind: 'file_view',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_VIEW_FILE',
        payload: { absolutePathUri: '/repo/src/index.ts', content: 'export const a = 1;' }
      },
      {
        seq: 11,
        kind: 'command',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        payload: { commandLine: 'npm test', exitCode: 0, combinedOutput: 'ALL PASS' }
      }
    ];

    render(<ToolGroupCard id="tg-10" events={events} onInspectFile={onInspect} />);
    const toggle = screen.getByTestId('tool-group-toggle-tg-10');
    expect(toggle).toHaveTextContent('已调用 2 个工具 · 读文件×1 · 命令×1');
    expect(screen.queryByTestId('tool-group-body-tg-10')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByTestId('tool-group-body-tg-10')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle('查看 /repo/src/index.ts'));
    expect(onInspect).toHaveBeenCalledWith('/repo/src/index.ts');
  });

  it('keeps thinking collapsed by default and renders streaming Markdown safely with unclosed fences', () => {
    const ev: SessionEvent = {
      seq: 20,
      kind: 'thinking_and_text',
      status: 'generating',
      rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      payload: {
        thinking: 'Deep analysis...',
        response: 'Here is code:\n```ts\nconst x = 1;'
      }
    };

    const { rerender } = render(<StepCard event={ev} />);
    expect(screen.queryByTestId('thinking-body-20')).toBeNull();
    expect(screen.getByText('const x = 1;')).toBeInTheDocument();

    // Streaming update MUST re-render even for same seq
    const updated: SessionEvent = {
      ...ev,
      payload: {
        ...ev.payload,
        response: 'Here is code:\n```ts\nconst x = 1;\nconst y = 2;\n```'
      }
    };
    rerender(<StepCard event={updated} />);
    expect(screen.getByText(/const y = 2;/)).toBeInTheDocument();
  });

  it('renders inline ask_question for multi-select + write-in when pending, and clean summary when done', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    const pendingEv: SessionEvent = {
      seq: 30,
      kind: 'ask_question',
      status: 'pending',
      rawType: 'CORTEX_STEP_TYPE_ASK_QUESTION',
      payload: {
        questions: [
          {
            question: '选择要启用的模块',
            isMultiSelect: true,
            options: [
              { id: 'auth', label: '认证模块' },
              { id: 'logs', label: '日志模块' }
            ]
          }
        ]
      }
    };

    const { rerender } = render(
      <StepCard event={pendingEv} permissionLevel="L1" onAnswer={onAnswer} />
    );

    fireEvent.click(screen.getByText('认证模块'));
    fireEvent.click(screen.getByText('日志模块'));
    fireEvent.click(screen.getByTestId('inline-answer-submit-30'));
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0][1][0].selectedOptionIds).toEqual(['auth', 'logs']);

    // When done, displays clean chips instead of raw JSON
    const doneEv: SessionEvent = {
      ...pendingEv,
      status: 'done',
      payload: {
        ...pendingEv.payload,
        completedInteractions: [
          {
            askQuestion: {
              responses: [
                {
                  question: '选择要启用的模块',
                  selectedOptionIds: ['auth', 'logs'],
                  writeInResponse: ''
                }
              ]
            }
          }
        ]
      }
    };
    rerender(<StepCard event={doneEv} permissionLevel="L1" onAnswer={onAnswer} />);
    expect(screen.getByText('✓ 认证模块')).toBeInTheDocument();
    expect(screen.getByText('✓ 日志模块')).toBeInTheDocument();
  });

  it('renders queued messages at bottom of VirtualChatList with Steer, Edit, Remove, Retry actions', () => {
    const onSteer = vi.fn();
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const onRetry = vi.fn();

    const queue: QueuedMessage[] = [
      {
        id: 'q1',
        sessionId: 's1',
        text: '顺便修复测试',
        mode: 'plan',
        dispatchMode: 'queue',
        createdAt: Date.now(),
        status: 'queued'
      },
      {
        id: 'q2',
        sessionId: 's1',
        text: '重试发送这条',
        mode: 'chat',
        dispatchMode: 'queue',
        createdAt: Date.now(),
        status: 'failed',
        error: '网络超时'
      },
      {
        id: 'q3',
        sessionId: 'other-session',
        text: '别的会话',
        mode: 'chat',
        dispatchMode: 'queue',
        createdAt: Date.now(),
        status: 'queued'
      }
    ];

    render(
      <VirtualChatList
        events={[]}
        activeSessionId="s1"
        permissionLevel="L1"
        queue={queue}
        onSteerQueueItem={onSteer}
        onEditQueueItem={onEdit}
        onRemoveQueueItem={onRemove}
        onRetryQueueItem={onRetry}
      />
    );

    expect(screen.getByTestId('queued-msg-q1')).toBeInTheDocument();
    expect(screen.getByTestId('queued-msg-q2')).toBeInTheDocument();
    expect(screen.queryByTestId('queued-msg-q3')).toBeNull();

    fireEvent.click(screen.getByTestId('queue-steer-q1'));
    expect(onSteer).toHaveBeenCalledWith('q1');

    fireEvent.click(screen.getByTestId('queue-edit-q1'));
    expect(onEdit).toHaveBeenCalledWith('q1');

    fireEvent.click(screen.getByTestId('queue-remove-q1'));
    expect(onRemove).toHaveBeenCalledWith('q1');

    fireEvent.click(screen.getByTestId('queue-retry-q2'));
    expect(onRetry).toHaveBeenCalledWith('q2');
  });

  it('renders compact PendingFloatingCard and supports quick approve & jump', () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const onAnswer = vi.fn().mockResolvedValue(undefined);
    const onJump = vi.fn();

    const pendingCmd: SessionEvent = {
      seq: 5,
      kind: 'command',
      status: 'pending',
      rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      payload: { commandLine: 'git status' }
    };

    render(
      <PendingFloatingCard
        pendingEvent={pendingCmd}
        permissionLevel="L1"
        onApprove={onApprove}
        onAnswer={onAnswer}
        onJumpToStep={onJump}
      />
    );

    expect(screen.getByTestId('pending-floating-card')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pending-quick-allow'));
    expect(onApprove).toHaveBeenCalledWith(5, 'allow');
  });

  it('renders Markdown with streaming cursor safely', () => {
    const { container } = render(<Markdown text="Hello **stream**" streaming={true} />);
    expect(container.textContent).toContain('Hello stream');
  });
});
