import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ModelItem, SessionEvent, SessionEventStatus, SessionSummary } from '../types';
import { Composer, SessionSidebar, SessionStream } from './index';

function makeAllElevenEvents(): SessionEvent[] {
  return [
    {
      seq: 0,
      kind: 'user',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
      payload: {
        items: [{ text: 'Inspect the repo and run tests' }],
        text: 'Inspect the repo and run tests',
      },
    },
    {
      seq: 1,
      kind: 'thinking_and_text',
      status: 'generating',
      rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      payload: {
        thinking: 'Checking package scripts before running tests.',
        thinkingDuration: '1.2s',
        response: 'I will check the files and run the test suite.',
        toolCalls: [{ id: 'tc-1' }],
        stopReason: 'STOP_REASON_TOOL_CALL',
      },
    },
    {
      seq: 2,
      kind: 'command',
      status: 'pending',
      rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      title: 'npm test',
      payload: {
        commandLine: 'npm test',
        cwd: '/workspace/app',
        exitCode: 0,
        combinedOutput: 'All 12 tests passed',
        shellName: 'zsh',
      },
    },
    {
      seq: 3,
      kind: 'file_view',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_VIEW_FILE',
      title: 'src/index.ts',
      payload: {
        absolutePathUri: 'file:///workspace/app/src/index.ts',
        startLine: 1,
        endLine: 20,
        numLines: 20,
        numBytes: 420,
        content: 'export const ready = true;',
      },
    },
    {
      seq: 4,
      kind: 'code_action',
      status: 'running',
      rawType: 'CORTEX_STEP_TYPE_CODE_ACTION',
      title: 'Update greeting',
      payload: {
        actionSpec: {
          description: 'Add hello helper',
          targetFile: 'src/greeting.ts',
        },
        diffStats: {
          additions: 14,
          deletions: 3,
        },
        actionResult: {
          applied: true,
        },
      },
    },
    {
      seq: 5,
      kind: 'ask_question',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_ASK_QUESTION',
      payload: {
        questions: [
          {
            header: 'Target Env',
            question: 'Which environment should we deploy to?',
            options: [{ label: 'Staging' }, { label: 'Production' }],
          },
        ],
        completedInteractions: [{ answer: 'Staging' }],
      },
    },
    {
      seq: 6,
      kind: 'web_search',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_SEARCH_WEB',
      title: 'Vitest jsdom scroll',
      payload: {
        query: 'vitest jsdom scrollTop',
        searchType: 'web',
        summary: 'Found JSDOM scrollHeight notes.',
        webDocuments: [
          {
            title: 'Vitest Docs',
            url: 'https://vitest.dev',
            snippet: 'Testing React components with jsdom.',
          },
        ],
      },
    },
    {
      seq: 7,
      kind: 'checkpoint',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_CHECKPOINT',
      title: 'Milestone 1',
      payload: {
        includedStepIndexEnd: 6,
        sessionSummary: 'Verified tests and edited greeting helper.',
        artifactSnapshots: [{ name: 'plan.md' }],
        capturedUserRequests: ['Inspect the repo'],
        totalSubagentCount: 2,
      },
    },
    {
      seq: 8,
      kind: 'system',
      status: 'canceled',
      rawType: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
      payload: {
        eventType: 'SYSTEM_NOTICE',
        message: 'Session paused by user.',
      },
    },
    {
      seq: 9,
      kind: 'tool_generic',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_CUSTOM_TOOL',
      title: 'Custom MCP Tool',
      payload: {
        args: { id: 42 },
        result: { ok: true },
      },
    },
    {
      seq: 10,
      kind: 'error',
      status: 'error',
      rawType: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
      payload: {
        error: { code: 'RPC_TIMEOUT', message: 'Upstream RPC timed out' },
      },
    },
  ];
}

describe('SessionStream & SessionEventCard', () => {
  it('renders empty and loading states', () => {
    const { rerender } = render(<SessionStream events={[]} loading={true} />);
    expect(screen.getByTestId('session-stream-loading')).toHaveTextContent(/Loading session timeline/i);

    rerender(
      <SessionStream
        events={[]}
        loading={false}
        emptyTitle="Nothing yet"
        emptyDescription="Start a prompt below."
      />,
    );
    expect(screen.getByTestId('session-stream-empty')).toHaveTextContent('Nothing yet');
    expect(screen.getByTestId('session-stream-empty')).toHaveTextContent('Start a prompt below.');
  });

  it('aggregates consecutive tool calls collapsed by default, supports 2-level lazy expansion, and renders all 11 kinds + 6 statuses', () => {
    const events = makeAllElevenEvents();
    render(<SessionStream events={events} sessionId="cid-1" />);

    expect(events).toHaveLength(11);

    // Non-tool single cards render directly
    expect(screen.getByTestId('session-event-0')).toHaveAttribute('data-event-kind', 'user');
    expect(screen.getByTestId('session-event-1')).toHaveAttribute('data-event-kind', 'thinking_and_text');
    expect(screen.getByTestId('session-event-5')).toHaveAttribute('data-event-kind', 'ask_question');
    expect(screen.getByTestId('session-event-7')).toHaveAttribute('data-event-kind', 'checkpoint');
    expect(screen.getByTestId('session-event-8')).toHaveAttribute('data-event-kind', 'system');
    expect(screen.getByTestId('session-event-10')).toHaveAttribute('data-event-kind', 'error');

    // Consecutive tool calls (seq 2, 3, 4) start collapsed at Level 0 with no detail card in DOM
    const group2 = screen.getByTestId('tool-group-tg-2');
    expect(group2).toHaveAttribute('data-expanded', 'false');
    expect(group2).toHaveAttribute('data-group-size', '3');
    expect(screen.queryByTestId('tool-group-list-tg-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-event-2')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-event-3')).not.toBeInTheDocument();
    expect(screen.queryByTestId('session-event-4')).not.toBeInTheDocument();

    // Level 1: clicking group shows brief list, details still lazily unmounted
    fireEvent.click(screen.getByTestId('tool-group-toggle-tg-2'));
    expect(screen.getByTestId('tool-group-list-tg-2')).toBeInTheDocument();
    expect(screen.getByTestId('tool-item-toggle-2')).toBeInTheDocument();
    expect(screen.getByTestId('tool-item-toggle-3')).toBeInTheDocument();
    expect(screen.getByTestId('tool-item-toggle-4')).toBeInTheDocument();
    expect(screen.queryByTestId('session-event-2')).not.toBeInTheDocument();

    // Level 2: expand each grouped item + single tool groups (tg-6, tg-9)
    fireEvent.click(screen.getByTestId('tool-item-toggle-2'));
    fireEvent.click(screen.getByTestId('tool-item-toggle-3'));
    fireEvent.click(screen.getByTestId('tool-item-toggle-4'));
    fireEvent.click(screen.getByTestId('tool-group-toggle-tg-6'));
    fireEvent.click(screen.getByTestId('tool-item-toggle-6'));
    fireEvent.click(screen.getByTestId('tool-group-toggle-tg-9'));
    fireEvent.click(screen.getByTestId('tool-item-toggle-9'));

    // Verify all 11 event kinds are now mounted
    for (const ev of events) {
      const card = screen.getByTestId(`session-event-${ev.seq}`);
      expect(card).toHaveAttribute('data-event-kind', ev.kind);
      expect(card).toHaveAttribute('data-event-status', ev.status);
    }

    // Verify all 6 statuses are represented
    const statuses: SessionEventStatus[] = [
      'pending',
      'running',
      'generating',
      'done',
      'error',
      'canceled',
    ];
    for (const status of statuses) {
      expect(screen.getAllByTestId(`event-status-${status}`).length).toBeGreaterThan(0);
    }

    // Collapsible thinking block starts collapsed and expands on click
    expect(screen.queryByTestId('thinking-content')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('thinking-toggle'));
    expect(screen.getByTestId('thinking-content')).toHaveTextContent(
      'Checking package scripts before running tests.',
    );

    // Command details: commandLine, cwd, exitCode, combinedOutput
    const commandCard = screen.getByTestId('session-event-2');
    expect(commandCard).toHaveTextContent('$ npm test');
    expect(commandCard).toHaveTextContent('cwd: /workspace/app');
    expect(screen.getByTestId('command-exit-code')).toHaveTextContent('exit 0');
    expect(screen.getByTestId('command-output')).toHaveTextContent('All 12 tests passed');

    // Pending approval notice mentioning 2.34 read-only limitation
    const pendingNotice = screen.getByTestId('pending-approval-notice');
    expect(pendingNotice).toHaveTextContent(/2\.34/);
    expect(pendingNotice).toHaveTextContent(/read-only/i);

    // File view, code action, ask_question, web_search, checkpoint, system, tool_generic, error
    expect(screen.getByTestId('session-event-3')).toHaveTextContent('export const ready = true;');
    expect(screen.getByTestId('session-event-3')).toHaveTextContent('L1-20');

    expect(screen.getByTestId('session-event-4')).toHaveTextContent('+14');
    expect(screen.getByTestId('session-event-4')).toHaveTextContent('-3');
    expect(screen.getByTestId('session-event-4')).toHaveTextContent('src/greeting.ts');
    expect(screen.getByTestId('session-event-4')).toHaveTextContent('"applied": true');

    expect(screen.getByTestId('session-event-5')).toHaveTextContent(
      'Which environment should we deploy to?',
    );
    expect(screen.getByTestId('session-event-6')).toHaveTextContent('vitest jsdom scrollTop');
    expect(screen.getByTestId('session-event-6')).toHaveTextContent('Vitest Docs');
    expect(screen.getByTestId('session-event-7')).toHaveTextContent(
      'Verified tests and edited greeting helper.',
    );
    expect(screen.getByTestId('session-event-8')).toHaveTextContent('Session paused by user.');
    expect(screen.getByTestId('session-event-9')).toHaveTextContent('"id": 42');
    expect(screen.getByTestId('error-payload')).toHaveTextContent('Upstream RPC timed out');
  });

  it('extracts nested code_action diff lines & targetFile and triggers onReviewDiff CTA', () => {
    const onReviewDiff = vi.fn();
    const events: SessionEvent[] = [
      {
        seq: 12,
        kind: 'code_action',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_CODE_ACTION',
        title: 'Code Action',
        payload: {
          actionSpec: {
            command: {
              targetFile: '/repo/src/daemon.js',
            },
          },
          actionResult: {
            result: {
              diff: {
                unifiedDiff: {
                  lines: [
                    { type: 'UNIFIED_DIFF_LINE_TYPE_UNCHANGED', text: 'const a = 1;' },
                    { type: 'UNIFIED_DIFF_LINE_TYPE_REMOVED', text: 'const b = 2;' },
                    { type: 'UNIFIED_DIFF_LINE_TYPE_ADDED', text: 'const b = 3;' },
                    { type: 'UNIFIED_DIFF_LINE_TYPE_ADDED', text: 'const c = 4;' },
                  ],
                },
              },
            },
          },
        },
      },
    ];

    render(<SessionStream events={events} sessionId="cid-diff-cta" onReviewDiff={onReviewDiff} />);
    const groupToggle = screen.getByTestId('tool-group-toggle-tg-12');
    expect(groupToggle).toHaveTextContent('1 edit(s)');
    expect(groupToggle).toHaveTextContent('+2');
    expect(groupToggle).toHaveTextContent('-1');

    fireEvent.click(groupToggle);
    expect(screen.getByTestId('tool-item-toggle-12')).toHaveTextContent('Edit …/src/daemon.js');
    fireEvent.click(screen.getByTestId('tool-item-toggle-12'));

    expect(screen.getByTestId('code-action-diff-12')).toHaveTextContent('const b = 3;');
    fireEvent.click(screen.getByTestId('review-diff-btn-12'));
    expect(onReviewDiff).toHaveBeenCalledWith('/repo/src/daemon.js');
  });

  it('extracts Antigravity 2.34 command.file.absoluteUri and edit.diff.unifiedDiff.lines, and hides done pill on error cards', () => {
    const onReviewDiff = vi.fn();
    const events: SessionEvent[] = [
      {
        seq: 213,
        kind: 'code_action',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_CODE_ACTION',
        title: 'Code Action',
        payload: {
          actionSpec: {
            command: {
              file: {
                absoluteUri: 'file:///Volumes/external/Projects/agy-daddy/agy-daddy-host/src/core/launcher.js',
              },
            },
          },
          actionResult: {
            edit: {
              diff: {
                unifiedDiff: {
                  lines: [
                    { type: 'UNIFIED_DIFF_LINE_TYPE_DELETE', text: 'const tray = null;' },
                    { type: 'UNIFIED_DIFF_LINE_TYPE_INSERT', text: 'const tray = createTray();' },
                  ],
                },
              },
            },
          },
        },
      },
      {
        seq: 434,
        kind: 'error',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
        title: 'Error',
        payload: { error: { message: 'Model quota exhausted' } },
      },
    ];

    render(<SessionStream events={events} onReviewDiff={onReviewDiff} />);

    expect(screen.getByTestId('tool-group-toggle-tg-213')).toHaveTextContent('launcher.js');
    expect(screen.getByTestId('tool-group-toggle-tg-213')).toHaveTextContent('+1 -1');
    fireEvent.click(screen.getByTestId('tool-group-toggle-tg-213'));

    expect(screen.getByTestId('tool-item-toggle-213')).toHaveTextContent('launcher.js');
    fireEvent.click(screen.getByTestId('tool-item-toggle-213'));
    expect(screen.getByTestId('code-action-diff-213')).toHaveTextContent('const tray = createTray();');
    fireEvent.click(screen.getByTestId('review-diff-btn-213'));
    expect(onReviewDiff).toHaveBeenCalledWith('/Volumes/external/Projects/agy-daddy/agy-daddy-host/src/core/launcher.js');

    const errorCard = screen.getByTestId('session-event-434');
    const doneBadge = errorCard.querySelector('[data-testid="event-status-done"]');
    expect(doneBadge).not.toBeNull();
    expect(doneBadge?.className).toContain('srOnly');
  });

  it('implements smart auto-scroll and shows jump-to-latest when scrolled up', () => {
    const initialEvents = makeAllElevenEvents().slice(0, 2);
    const { rerender } = render(<SessionStream events={initialEvents} sessionId="cid-scroll" />);

    const scrollEl = screen.getByTestId('session-stream-scroll');
    Object.defineProperty(scrollEl, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollEl, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollEl, 'scrollTop', { value: 100, writable: true, configurable: true });

    // User scrolls up away from bottom (1000 - 100 - 400 = 500 > 64)
    fireEvent.scroll(scrollEl);

    // New event arrives while scrolled up -> should not snap scrollTop to 1000 and should show jump button
    rerender(<SessionStream events={makeAllElevenEvents().slice(0, 3)} sessionId="cid-scroll" />);
    expect(scrollEl.scrollTop).toBe(100);
    const jumpBtn = screen.getByTestId('jump-to-latest-btn');
    expect(jumpBtn).toBeInTheDocument();

    // Clicking jump button scrolls to bottom and hides the button
    fireEvent.click(jumpBtn);
    expect(scrollEl.scrollTop).toBe(1000);
    expect(screen.queryByTestId('jump-to-latest-btn')).not.toBeInTheDocument();
  });

  it('suppresses hidden [swarm] events, keeps tool call grouping continuous across them, and toggles visibility', () => {
    const events: SessionEvent[] = [
      {
        seq: 1,
        kind: 'command',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        title: 'ls -la',
        payload: { commandLine: 'ls -la', exitCode: 0, combinedOutput: 'ok' },
      },
      {
        seq: 2,
        kind: 'system',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
        payload: {
          message:
            '[Message] timestamp=2026-11-23T11:19:59Z sender=93d62427-0000-0000-0000-000000000000 content=[swarm] new board message #1',
          renderInfo: { hidden: true },
        },
      },
      {
        seq: 3,
        kind: 'file_view',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_VIEW_FILE',
        title: 'package.json',
        payload: { absolutePathUri: 'file:///workspace/package.json', content: '{}' },
      },
    ];

    const { rerender } = render(<SessionStream events={events} sessionId="cid-hidden-1" />);

    // Hidden swarm event is suppressed by default and does NOT split the tool group
    expect(screen.queryByTestId('session-event-2')).not.toBeInTheDocument();
    const mergedGroup = screen.getByTestId('tool-group-tg-1');
    expect(mergedGroup).toHaveAttribute('data-group-size', '2');
    expect(screen.queryByTestId('tool-group-tg-3')).not.toBeInTheDocument();

    // Compact toggle bar is shown with hidden count 1
    const toggleBtn = screen.getByTestId('toggle-hidden-system-events');
    expect(toggleBtn).toHaveTextContent('Show 1 hidden internal events');
    expect(toggleBtn).toHaveAttribute('aria-pressed', 'false');

    // Clicking toggle reveals the hidden [swarm] event and splits the tool groups
    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-pressed', 'true');
    expect(toggleBtn).toHaveTextContent('Hide 1 internal events');
    expect(screen.getByTestId('session-event-2')).toBeInTheDocument();
    expect(screen.getByTestId('tool-group-tg-1')).toHaveAttribute('data-group-size', '1');
    expect(screen.getByTestId('tool-group-tg-3')).toHaveAttribute('data-group-size', '1');

    // Clicking toggle again hides it and merges the tool group back
    fireEvent.click(toggleBtn);
    expect(toggleBtn).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('session-event-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('tool-group-tg-1')).toHaveAttribute('data-group-size', '2');

    // Switching sessionId resets showHiddenEvents back to false
    fireEvent.click(toggleBtn);
    expect(screen.getByTestId('session-event-2')).toBeInTheDocument();
    rerender(<SessionStream events={events} sessionId="cid-hidden-2" />);
    expect(screen.queryByTestId('session-event-2')).not.toBeInTheDocument();
    expect(screen.getByTestId('toggle-hidden-system-events')).toHaveAttribute('aria-pressed', 'false');
  });

  it('merges interleaved intermediate thoughts and tool calls into one work group, expands thought content at Level 2, and hides STOP_REASON chips', () => {
    const events: SessionEvent[] = [
      {
        seq: 875,
        kind: 'user',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'Investigate and fix' },
      },
      {
        seq: 876,
        kind: 'thinking_and_text',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        payload: {
          thinking: 'Step 1: inspect files first',
          thinkingDuration: '2.1s',
          toolCalls: [{ id: 'tc-1' }],
          stopReason: 'STOP_REASON_TOOL_CALL',
        },
      },
      {
        seq: 877,
        kind: 'file_view',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_VIEW_FILE',
        payload: { absolutePathUri: 'file:///repo/src/a.ts' },
      },
      {
        seq: 878,
        kind: 'command',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        payload: { commandLine: 'npx vitest run', exitCode: 0 },
      },
      {
        seq: 879,
        kind: 'tool_generic',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_GREP_SEARCH',
        payload: { args: { query: 'foo' } },
      },
      {
        seq: 880,
        kind: 'thinking_and_text',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        payload: {
          thinking: 'Step 2: apply the code edit',
          thinkingDuration: '8.365740s',
        },
      },
      {
        seq: 881,
        kind: 'code_action',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_CODE_ACTION',
        payload: { actionSpec: { targetFile: 'src/a.ts' }, diffStats: { additions: 3, deletions: 1 } },
      },
      {
        seq: 882,
        kind: 'web_search',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_SEARCH_WEB',
        payload: { query: 'vitest' },
      },
      {
        seq: 883,
        kind: 'thinking_and_text',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        payload: {
          thinking: 'Step 3: everything verified',
          thinkingDuration: 1.5,
        },
      },
      {
        seq: 884,
        kind: 'thinking_and_text',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        payload: {
          thinking: 'Final reasoning',
          thinkingDuration: '0.5s',
          response: 'All issues are resolved.',
          stopReason: 'STOP_REASON_STOP_PATTERN',
        },
      },
    ];

    render(<SessionStream events={events} sessionId="cid-merged-work" />);

    // Think #876 -> 3 Tools #877-#879 -> Think #880 -> 2 Tools #881-#882 -> Think #883 merge into ONE group
    const mergedGroup = screen.getByTestId('tool-group-tg-876');
    expect(mergedGroup).toHaveAttribute('data-group-size', '8');
    expect(mergedGroup).toHaveAttribute('data-thought-count', '3');
    expect(mergedGroup).toHaveAttribute('data-tool-count', '5');
    expect(mergedGroup).toHaveAttribute('data-expanded', 'false');
    expect(mergedGroup).toHaveTextContent('3 thinking · 5 tools');
    expect(screen.getByTestId('work-group-duration')).toHaveTextContent('12s');

    // Final assistant response #884 stays standalone and does NOT render STOP_REASON_STOP_PATTERN
    const finalCard = screen.getByTestId('session-event-884');
    expect(finalCard).toHaveTextContent('All issues are resolved.');
    expect(finalCard).not.toHaveTextContent('STOP_REASON_STOP_PATTERN');
    expect(finalCard).not.toHaveTextContent('stop:');

    // Level 1: click group summary -> renders 8 items in chronological order
    fireEvent.click(screen.getByTestId('tool-group-toggle-tg-876'));
    const list = screen.getByTestId('tool-group-list-tg-876');
    expect(list).toBeInTheDocument();
    expect(screen.getByTestId('tool-item-toggle-876')).toHaveTextContent('Step 1: inspect files first');
    expect(screen.getByTestId('tool-item-toggle-879')).toHaveTextContent('Tool: Grep Search');
    expect(screen.getByTestId('tool-item-toggle-880')).toHaveTextContent('Step 2: apply the code edit');
    expect(screen.getByTestId('tool-item-toggle-883')).toHaveTextContent('Step 3: everything verified');

    // Level 2: click collapsed thought row #876 -> thinking content is immediately expanded
    fireEvent.click(screen.getByTestId('tool-item-toggle-876'));
    const detail876 = screen.getByTestId('tool-item-detail-876');
    expect(detail876).toHaveTextContent('Step 1: inspect files first');
    expect(detail876.querySelector('[data-testid="thinking-content"]')).toHaveTextContent(
      'Step 1: inspect files first',
    );
    expect(detail876).not.toHaveTextContent('STOP_REASON_TOOL_CALL');
  });

  it('renders thoughts-only work group summary with duration chip', () => {
    const events: SessionEvent[] = [
      {
        seq: 10,
        kind: 'thinking_and_text',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        payload: { thinking: 'First thought', thinkingDuration: '1.2s' },
      },
      {
        seq: 11,
        kind: 'thinking_and_text',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        payload: { thinking: 'Second thought', thinkingDuration: '2.3s' },
      },
    ];

    render(<SessionStream events={events} sessionId="cid-thoughts-only" />);
    const group = screen.getByTestId('tool-group-tg-10');
    expect(group).toHaveAttribute('data-group-size', '2');
    expect(group).toHaveAttribute('data-thought-count', '2');
    expect(group).toHaveAttribute('data-tool-count', '0');
    expect(group).toHaveTextContent('2 thinking steps');
    expect(screen.getByTestId('work-group-duration')).toHaveTextContent('3.5s');
  });

  it('respects thinkingExpandOverride and highlights search matches cleanly', () => {
    const events = makeAllElevenEvents();
    const { rerender } = render(
      <SessionStream
        events={events}
        sessionId="cid-override"
        thinkingExpandOverride={null}
      />,
    );

    expect(screen.queryByTestId('thinking-content')).not.toBeInTheDocument();

    rerender(
      <SessionStream
        events={events}
        sessionId="cid-override"
        thinkingExpandOverride={true}
        searchQuery="package scripts"
        activeSearchMatchSeq={1}
      />,
    );

    expect(screen.getByTestId('thinking-content')).toHaveTextContent(
      'Checking package scripts before running tests.',
    );
    const card1 = screen.getByTestId('session-event-1');
    expect(card1).toHaveAttribute('data-search-hit', 'active');
    expect(card1.querySelector('mark')?.textContent).toBe('package scripts');

    rerender(
      <SessionStream
        events={events}
        sessionId="cid-override"
        thinkingExpandOverride={false}
        searchQuery=""
        activeSearchMatchSeq={null}
      />,
    );

    expect(screen.queryByTestId('thinking-content')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-event-1')).not.toHaveAttribute('data-search-hit');
  });
});

describe('SessionSidebar', () => {
  const sessions: SessionSummary[] = [
    {
      cascadeId: 's-old',
      title: 'Older session',
      summary: '',
      status: 'CASCADE_RUN_STATUS_IDLE',
      stepCount: 4,
      lastModifiedTime: '2026-11-24T01:00:00Z',
      createdTime: '2026-11-24T00:00:00Z',
      workspaceUri: 'file:///Users/dev/alpha',
      gitRootUri: null,
      repoName: 'alpha-repo',
      branchName: 'main',
      workspaces: [],
    },
    {
      cascadeId: 's-new',
      title: 'Newest running session',
      summary: '',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      stepCount: 9,
      lastModifiedTime: '2026-11-24T08:00:00Z',
      createdTime: '2026-11-24T07:00:00Z',
      workspaceUri: 'file:///Users/dev/beta',
      gitRootUri: null,
      repoName: 'beta-repo',
      branchName: 'feat/harness',
      workspaces: [],
    },
  ];

  it('sorts by recency, filters by search, highlights active, and creates new session', () => {
    const onSelectSession = vi.fn();
    const onCreateSession = vi.fn();

    render(
      <SessionSidebar
        sessions={sessions}
        activeSessionId="s-new"
        onSelectSession={onSelectSession}
        onCreateSession={onCreateSession}
      />,
    );

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-session-id', 's-new');
    expect(items[0]).toHaveAttribute('data-active', 'true');
    expect(items[0]).toHaveTextContent('Newest running session');
    expect(items[1]).toHaveAttribute('data-session-id', 's-old');

    fireEvent.click(screen.getByTestId('new-session-btn'));
    expect(onCreateSession).toHaveBeenCalledTimes(1);

    fireEvent.click(items[1]);
    expect(onSelectSession).toHaveBeenCalledWith('s-old');

    fireEvent.click(screen.getByTestId('sidebar-filter-toggle'));
    fireEvent.change(screen.getByTestId('session-search-input'), { target: { value: 'beta' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('listitem')).toHaveAttribute('data-session-id', 's-new');
  });
});

describe('Composer', () => {
  const models: ModelItem[] = [
    {
      id: 'model-fast',
      model: 'model-fast',
      label: 'Fast Model',
      displayName: 'Fast Model',
      maxTokens: 32000,
      disabled: false,
      supportsImages: false,
      isDefault: false,
      quotaInfo: null,
    },
    {
      id: 'model-pro',
      model: 'model-pro',
      label: 'Pro Model',
      displayName: 'Pro Model',
      maxTokens: 128000,
      disabled: false,
      supportsImages: true,
      isDefault: true,
      quotaInfo: null,
    },
  ];

  it('handles Enter to send, Shift+Enter newline, model selector, and Stop button when running', () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();

    render(
      <Composer
        models={models}
        onSend={onSend}
        onCancel={onCancel}
        isRunning={true}
      />,
    );

    const trigger = screen.getByTestId('model-picker-trigger');
    expect(trigger).toHaveTextContent('Pro Model');
    fireEvent.click(trigger);
    const popover = screen.getByTestId('model-picker-popover');
    expect(popover).toBeInTheDocument();
    fireEvent.click(popover.querySelector('[data-node-key="family/model-fast"]') as HTMLElement);
    expect(trigger).toHaveTextContent('Fast Model');

    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'Line 1' } });

    // Shift+Enter does not submit
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    // Enter submits with selected model and clears textarea
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledWith('Line 1', 'model-fast');
    expect(textarea.value).toBe('');

    // Stop button triggers onCancel while running
    fireEvent.click(screen.getByTestId('composer-cancel-btn'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('supports quick prompt bar, high-risk guard banner, and optimize button', async () => {
    const onSend = vi.fn();
    const onOptimizePrompt = vi.fn().mockResolvedValue('Refactor src/app.ts with unit tests');

    render(
      <Composer
        models={models}
        onSend={onSend}
        contextUsagePct={88}
        onOptimizePrompt={onOptimizePrompt}
      />,
    );

    expect(screen.getByTestId('composer-quick-bar')).toBeInTheDocument();
    expect(screen.getByTestId('composer-compact-recommended')).toBeInTheDocument();

    const textarea = screen.getByTestId('composer-textarea') as HTMLTextAreaElement;
    fireEvent.click(screen.getByTestId('quick-prompt-compact'));
    expect(textarea.value).toBe('/compact ');

    fireEvent.change(textarea, { target: { value: 'please run rm -rf /tmp/demo' } });
    const riskBanner = screen.getByTestId('composer-high-risk-banner');
    expect(riskBanner).toHaveTextContent('rm -rf');

    fireEvent.click(screen.getByTestId('composer-optimize-btn'));
    expect(onOptimizePrompt).toHaveBeenCalledWith('please run rm -rf /tmp/demo');
    await vi.waitFor(() => {
      expect(textarea.value).toBe('Refactor src/app.ts with unit tests');
    });
  });
});
