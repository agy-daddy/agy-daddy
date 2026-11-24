import { useRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '../types';
import {
  ChatNavDock,
  serializeEventsToHtml,
  type ChatSearchState,
} from './ChatNavDock';
import { SessionStream } from './SessionStream';

function makeMultiTurnEvents(): SessionEvent[] {
  return [
    {
      seq: 0,
      kind: 'user',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
      payload: { text: 'First turn: check Alpha module' },
    },
    {
      seq: 1,
      kind: 'thinking_and_text',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      payload: {
        thinking: 'Analyzing alpha dependencies and err-101 logs.',
        thinkingDuration: '1.4s',
        response: 'Alpha module looks healthy.',
      },
    },
    {
      seq: 2,
      kind: 'user',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
      payload: { text: 'Second turn: run build' },
    },
    {
      seq: 3,
      kind: 'thinking_and_text',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      payload: {
        thinking: 'Checking build script before running.',
        thinkingDuration: '0.8s',
        toolCalls: [{ id: 'tc-1' }],
      },
    },
    {
      seq: 4,
      kind: 'command',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      title: 'npm run build',
      payload: {
        commandLine: 'npm run build',
        exitCode: 0,
        combinedOutput: 'Build complete with err-202 warning',
      },
    },
    {
      seq: 5,
      kind: 'thinking_and_text',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      payload: {
        thinking: 'Reviewing final build output.',
        response: 'Build succeeded cleanly for alpha.',
      },
    },
    {
      seq: 6,
      kind: 'user',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
      payload: { text: 'Third turn: summarize changes' },
    },
    {
      seq: 7,
      kind: 'thinking_and_text',
      status: 'done',
      rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      payload: {
        response: 'Summary ready.',
      },
    },
  ];
}

function StreamWithDockHarness({
  events,
  sessionId = 'sess-abc-123456',
  onExportMarkdown,
  onExportHtml,
  onPrintPdf,
}: {
  events: SessionEvent[];
  sessionId?: string | null;
  onExportMarkdown?: () => void;
  onExportHtml?: () => void;
  onPrintPdf?: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [thinkingOverride, setThinkingOverride] = useState<boolean | null>(null);
  const [searchState, setSearchState] = useState<ChatSearchState>({
    open: false,
    query: '',
    regex: false,
    caseSensitive: false,
    matchSeqs: [],
    activeMatchIndex: -1,
    activeMatchSeq: null,
    invalidRegex: false,
  });
  const [jumpSeq, setJumpSeq] = useState<number | null>(null);
  const [jumpNonce, setJumpNonce] = useState(0);

  return (
    <div style={{ position: 'relative', height: 600 }}>
      <SessionStream
        events={events}
        sessionId={sessionId}
        scrollContainerRef={scrollRef}
        thinkingExpandOverride={thinkingOverride}
        searchQuery={searchState.open ? searchState.query : ''}
        searchRegex={searchState.regex}
        searchCaseSensitive={searchState.caseSensitive}
        activeSearchMatchSeq={searchState.open ? searchState.activeMatchSeq : null}
        scrollToSeq={jumpSeq}
        scrollToSeqNonce={jumpNonce}
      />
      <ChatNavDock
        events={events}
        sessionId={sessionId}
        sessionTitle="Test Session"
        modelName="Gemini Pro"
        scrollContainerRef={scrollRef}
        thinkingExpandOverride={thinkingOverride}
        onThinkingExpandChange={setThinkingOverride}
        onSearchStateChange={setSearchState}
        onJumpToEventSeq={(seq) => {
          setJumpSeq(seq);
          setJumpNonce((n) => n + 1);
        }}
        onExportMarkdown={onExportMarkdown}
        onExportHtml={onExportHtml}
        onPrintPdf={onPrintPdf}
      />
    </div>
  );
}

describe('ChatNavDock', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('navigates between user turns and scrolls to top and bottom', () => {
    const events = makeMultiTurnEvents();
    const onJumpToEventSeq = vi.fn();
    const onScrollTop = vi.fn();
    const onScrollBottom = vi.fn();
    const scrollIntoViewMock = vi.fn();

    const scrollContainer = document.createElement('div');
    Object.defineProperty(scrollContainer, 'scrollHeight', { value: 1200, configurable: true });
    Object.defineProperty(scrollContainer, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scrollContainer, 'scrollTop', { value: 800, writable: true, configurable: true });

    for (const seq of [0, 2, 6]) {
      const card = document.createElement('article');
      card.setAttribute('data-testid', `session-event-${seq}`);
      card.scrollIntoView = scrollIntoViewMock;
      scrollContainer.appendChild(card);
    }

    const scrollRef = { current: scrollContainer };

    render(
      <ChatNavDock
        events={events}
        sessionId="sess-nav-1"
        scrollContainerRef={scrollRef}
        onJumpToEventSeq={onJumpToEventSeq}
        onScrollTop={onScrollTop}
        onScrollBottom={onScrollBottom}
      />,
    );

    expect(screen.getByTestId('chat-nav-dock')).toBeInTheDocument();
    expect(screen.getByTestId('chat-nav-turn-indicator')).toHaveTextContent('3 / 3');

    fireEvent.click(screen.getByTestId('chat-nav-prev-turn'));
    expect(screen.getByTestId('chat-nav-turn-indicator')).toHaveTextContent('2 / 3');
    expect(onJumpToEventSeq).toHaveBeenLastCalledWith(2);

    fireEvent.click(screen.getByTestId('chat-nav-prev-turn'));
    expect(screen.getByTestId('chat-nav-turn-indicator')).toHaveTextContent('1 / 3');
    expect(onJumpToEventSeq).toHaveBeenLastCalledWith(0);

    fireEvent.click(screen.getByTestId('chat-nav-next-turn'));
    expect(screen.getByTestId('chat-nav-turn-indicator')).toHaveTextContent('2 / 3');
    expect(onJumpToEventSeq).toHaveBeenLastCalledWith(2);

    fireEvent.click(screen.getByTestId('chat-nav-top'));
    expect(onScrollTop).toHaveBeenCalledTimes(1);
    expect(scrollContainer.scrollTop).toBe(0);
    expect(screen.getByTestId('chat-nav-turn-indicator')).toHaveTextContent('1 / 3');

    fireEvent.click(screen.getByTestId('chat-nav-bottom'));
    expect(onScrollBottom).toHaveBeenCalledTimes(1);
    expect(scrollContainer.scrollTop).toBe(1200);
    expect(screen.getByTestId('chat-nav-turn-indicator')).toHaveTextContent('3 / 3');
  });

  it('toggles global thinking blocks across SessionStream and SessionEventCard', () => {
    const events = makeMultiTurnEvents();
    render(<StreamWithDockHarness events={events} />);

    // Initially standalone thinking blocks are collapsed
    expect(screen.queryByTestId('thinking-content')).not.toBeInTheDocument();

    const thinkBtn = screen.getByTestId('chat-nav-thinking');
    expect(thinkBtn).toHaveAttribute('aria-pressed', 'false');

    // Expand all thinking blocks (standalone + intermediate work group thoughts)
    fireEvent.click(thinkBtn);
    expect(thinkBtn).toHaveAttribute('aria-pressed', 'true');
    const expandedBlocks = screen.getAllByTestId('thinking-content');
    expect(expandedBlocks.length).toBeGreaterThanOrEqual(2);
    expect(expandedBlocks.some((el) => el.textContent?.includes('Analyzing alpha dependencies'))).toBe(
      true,
    );

    // Collapse all thinking blocks
    fireEvent.click(thinkBtn);
    expect(thinkBtn).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('thinking-content')).not.toBeInTheDocument();
  });

  it('supports in-chat search with normal, case-sensitive, regex, match navigation, and Escape close', () => {
    const events = makeMultiTurnEvents();
    render(<StreamWithDockHarness events={events} />);

    // Open search overlay
    fireEvent.click(screen.getByTestId('chat-nav-search-toggle'));
    const overlay = screen.getByTestId('chat-search-overlay');
    expect(overlay).toBeInTheDocument();

    const input = screen.getByTestId('chat-search-input');
    // Case-insensitive search for "alpha" -> matches seq 0, seq 1, seq 5
    fireEvent.change(input, { target: { value: 'alpha' } });
    expect(screen.getByTestId('chat-search-count')).toHaveTextContent('1 / 3');
    expect(screen.getByTestId('session-event-0')).toHaveAttribute('data-search-hit', 'active');
    expect(screen.getByTestId('session-event-1')).toHaveAttribute('data-search-hit', 'hit');
    expect(screen.getByTestId('session-event-5')).toHaveAttribute('data-search-hit', 'hit');

    // Navigate to next match -> seq 1 becomes active
    fireEvent.click(screen.getByTestId('chat-search-next'));
    expect(screen.getByTestId('chat-search-count')).toHaveTextContent('2 / 3');
    expect(screen.getByTestId('session-event-1')).toHaveAttribute('data-search-hit', 'active');

    // Navigate back with Shift+Enter -> seq 0 becomes active again
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.getByTestId('chat-search-count')).toHaveTextContent('1 / 3');
    expect(screen.getByTestId('session-event-0')).toHaveAttribute('data-search-hit', 'active');

    // Enable case-sensitive (Aa) -> "alpha" no longer matches "Alpha" in seq 0, only seq 1 & 5
    fireEvent.click(screen.getByTestId('chat-search-case'));
    expect(screen.getByTestId('chat-search-count')).toHaveTextContent('1 / 2');
    expect(screen.getByTestId('session-event-0')).not.toHaveAttribute('data-search-hit');
    expect(screen.getByTestId('session-event-1')).toHaveAttribute('data-search-hit', 'active');

    // Enable regex (.*) and search for err-\d+ -> matches seq 1 and seq 4 (inside tool group)
    fireEvent.click(screen.getByTestId('chat-search-regex'));
    fireEvent.change(input, { target: { value: 'err-\\d+' } });
    expect(screen.getByTestId('chat-search-count')).toHaveTextContent('1 / 2');
    expect(screen.getByTestId('session-event-1')).toHaveAttribute('data-search-hit', 'active');

    // Navigate to second regex match (seq 4 inside tool group auto-expands)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(screen.getByTestId('chat-search-count')).toHaveTextContent('2 / 2');
    expect(screen.getByTestId('session-event-4')).toBeInTheDocument();
    expect(screen.getByTestId('tool-group-tg-3').parentElement).toHaveAttribute(
      'data-search-hit',
      'active',
    );

    // Invalid regex does not crash and shows 0 / 0
    fireEvent.change(input, { target: { value: '[unclosed' } });
    expect(screen.getByTestId('chat-search-count')).toHaveTextContent('0 / 0');

    // Pressing Escape closes search and clears highlights
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('chat-search-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('session-event-0')).not.toHaveAttribute('data-search-hit');
  });

  it('copies session ID to clipboard and shows toast feedback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<ChatNavDock events={makeMultiTurnEvents()} sessionId="cid-998877665544" />);

    const copyBtn = screen.getByTestId('chat-nav-copy-id');
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('cid-998877665544');
    });
    expect(copyBtn).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('chat-nav-toast')).toHaveTextContent(/cid-9988/i);
  });

  it('opens export dropdown menu and triggers Markdown, HTML, and PDF exports', () => {
    const onExportMarkdown = vi.fn();
    const onExportHtml = vi.fn();
    const onPrintPdf = vi.fn();

    render(
      <ChatNavDock
        events={makeMultiTurnEvents()}
        sessionId="cid-export"
        sessionTitle="Export Demo"
        onExportMarkdown={onExportMarkdown}
        onExportHtml={onExportHtml}
        onPrintPdf={onPrintPdf}
      />,
    );

    const exportBtn = screen.getByTestId('chat-nav-export');
    fireEvent.click(exportBtn);
    expect(screen.getByTestId('chat-nav-export-menu')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('chat-nav-export-md'));
    expect(onExportMarkdown).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('chat-nav-export-menu')).not.toBeInTheDocument();

    fireEvent.click(exportBtn);
    fireEvent.click(screen.getByTestId('chat-nav-export-html'));
    expect(onExportHtml).toHaveBeenCalledTimes(1);

    fireEvent.click(exportBtn);
    fireEvent.click(screen.getByTestId('chat-nav-export-pdf'));
    expect(onPrintPdf).toHaveBeenCalledTimes(1);
  });

  it('falls back to window.print for PDF export when onPrintPdf is omitted', () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<ChatNavDock events={makeMultiTurnEvents()} sessionId="cid-print" />);

    fireEvent.click(screen.getByTestId('chat-nav-export'));
    fireEvent.click(screen.getByTestId('chat-nav-export-pdf'));
    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('serializes events to safe standalone HTML with optional expanded thinking', () => {
    const events: SessionEvent[] = [
      {
        seq: 0,
        kind: 'user',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'Hello <script>alert(1)</script> [click](javascript:alert(2))' },
      },
      {
        seq: 1,
        kind: 'thinking_and_text',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        payload: {
          thinking: 'Internal reasoning step',
          response: 'Here is **bold** and `code` with [docs](https://example.com).',
        },
      },
      {
        seq: 2,
        kind: 'command',
        status: 'done',
        rawType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        payload: { commandLine: 'npm test', combinedOutput: 'PASS' },
      },
    ];

    const htmlCollapsed = serializeEventsToHtml('Demo <Title>', events, {
      sessionId: 'sess-html-1',
      modelName: 'Gemini Pro',
      expandThinking: false,
    });
    expect(htmlCollapsed).toContain('<!DOCTYPE html>');
    expect(htmlCollapsed).toContain('Demo &lt;Title&gt;');
    expect(htmlCollapsed).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(htmlCollapsed).not.toContain('javascript:alert(2)');
    expect(htmlCollapsed).toContain('<strong>bold</strong>');
    expect(htmlCollapsed).toContain('<code>code</code>');
    expect(htmlCollapsed).toContain('href="https://example.com"');
    expect(htmlCollapsed).toContain('<details class="thinking-box">');
    expect(htmlCollapsed).toContain('$ npm test');

    const htmlExpanded = serializeEventsToHtml('Demo', events, { expandThinking: true });
    expect(htmlExpanded).toContain('<details class="thinking-box" open>');
  });
});
