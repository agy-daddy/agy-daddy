import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../types';
import { createTranslator } from '../i18n';
import {
  formatToolBrief,
  groupTimelineEvents,
  isCollapsibleWorkEvent,
  isIntermediateThinkingEvent,
  isToolCallEvent,
} from './timelineGrouping';

function makeEvent(
  seq: number,
  kind: SessionEvent['kind'],
  payload: Record<string, unknown> = {},
  extra: Partial<SessionEvent> = {},
): SessionEvent {
  return {
    seq,
    kind,
    status: 'done',
    rawType: `TEST_${kind.toUpperCase()}`,
    payload,
    ...extra,
  };
}

describe('timelineGrouping', () => {
  it('merges consecutive tool calls into tool_group entries with stable firstSeq IDs', () => {
    const events: SessionEvent[] = [
      makeEvent(0, 'user', { text: 'Run checks' }),
      makeEvent(1, 'thinking_and_text', { response: 'Sure' }),
      makeEvent(2, 'command', { commandLine: 'npm test', exitCode: 0 }),
      makeEvent(3, 'file_view', { absolutePathUri: '/repo/src/app.ts', startLine: 1, endLine: 20 }),
      makeEvent(4, 'code_action', { actionSpec: { targetFile: 'src/app.ts' }, diffStats: { additions: 5, deletions: 1 } }),
      makeEvent(5, 'thinking_and_text', { response: 'All done' }),
      makeEvent(6, 'web_search', { query: 'vitest virtual scroll' }),
    ];

    expect(isToolCallEvent(events[0])).toBe(false);
    expect(isToolCallEvent(events[2])).toBe(true);

    const grouped = groupTimelineEvents(events);
    expect(grouped).toHaveLength(5);
    expect(grouped[0].type).toBe('single');
    expect(grouped[1].type).toBe('single');
    expect(grouped[2]).toMatchObject({ type: 'tool_group', id: 'tg-2', firstSeq: 2, lastSeq: 4 });
    if (grouped[2].type === 'tool_group') {
      expect(grouped[2].events).toHaveLength(3);
    }
    expect(grouped[3].type).toBe('single');
    expect(grouped[4]).toMatchObject({ type: 'tool_group', id: 'tg-6', firstSeq: 6, lastSeq: 6 });
  });

  it('formats concise English briefs for all tool call kinds', () => {
    const t = createTranslator('en');
    expect(formatToolBrief(makeEvent(1, 'command', { commandLine: 'npm run build', exitCode: 0 }), t)).toEqual({
      icon: '⌘',
      brief: 'Run `npm run build`',
      hint: 'exit 0',
    });
    expect(
      formatToolBrief(
        makeEvent(2, 'file_view', { absolutePathUri: '/a/b/c/index.ts', startLine: 10, endLine: 30 }),
        t,
      ),
    ).toEqual({
      icon: '📄',
      brief: 'Read …/c/index.ts',
      hint: 'L10-30',
    });
    expect(
      formatToolBrief(
        makeEvent(3, 'code_action', {
          actionSpec: { targetFile: 'src/index.ts' },
          diffStats: { additions: 4, deletions: 2 },
        }),
        t,
      ),
    ).toEqual({
      icon: '✏️',
      brief: 'Edit src/index.ts',
      hint: '+4/-2',
    });
    expect(formatToolBrief(makeEvent(4, 'web_search', { query: 'react memo' }), t)).toEqual({
      icon: '🔍',
      brief: 'Search "react memo"',
    });
    expect(formatToolBrief(makeEvent(5, 'tool_generic', { toolName: 'mcp_lookup' }), t)).toEqual({
      icon: '🔧',
      brief: 'Tool: mcp_lookup',
    });
    expect(
      formatToolBrief(
        makeEvent(6, 'tool_generic', {}, { rawType: 'CORTEX_STEP_TYPE_GREP_SEARCH' }),
        t,
      ),
    ).toEqual({
      icon: '🔧',
      brief: 'Tool: Grep Search',
    });
    expect(
      formatToolBrief(
        makeEvent(7, 'thinking_and_text', {
          thinking: '\n  Inspecting timeline grouping logic\nSecond detail line',
          thinkingDuration: '8.365740s',
        }),
        t,
      ),
    ).toEqual({
      icon: '💭',
      brief: 'Inspecting timeline grouping logic',
      hint: '8.4s',
    });
    expect(formatToolBrief(makeEvent(8, 'thinking_and_text', { thinking: '' }), t)).toEqual({
      icon: '💭',
      brief: 'Thinking',
    });
  });

  it('merges interleaved intermediate thinking and tool calls into one work group while keeping visible assistant responses standalone', () => {
    const intermediateThought = makeEvent(876, 'thinking_and_text', {
      thinking: 'Planning initial inspection',
      thinkingDuration: '2.1s',
      toolCalls: [{ id: 'tc-1' }],
    });
    const finalAnswer = makeEvent(884, 'thinking_and_text', {
      thinking: 'Wrapping up answer',
      thinkingDuration: '1.0s',
      response: 'Here is the final answer.',
      stopReason: 'STOP_REASON_STOP_PATTERN',
    });

    expect(isIntermediateThinkingEvent(intermediateThought)).toBe(true);
    expect(isCollapsibleWorkEvent(intermediateThought)).toBe(true);
    expect(
      isIntermediateThinkingEvent(makeEvent(99, 'thinking_and_text', { modifiedResponse: 'Edited answer' })),
    ).toBe(false);
    expect(
      isIntermediateThinkingEvent(makeEvent(100, 'thinking_and_text', { text: '   ', thinking: 'Wait' })),
    ).toBe(true);
    expect(isIntermediateThinkingEvent(finalAnswer)).toBe(false);
    expect(isCollapsibleWorkEvent(finalAnswer)).toBe(false);

    const events: SessionEvent[] = [
      makeEvent(875, 'user', { text: 'Fix the timeline' }),
      intermediateThought,
      makeEvent(877, 'file_view', { absolutePathUri: '/repo/src/a.ts' }),
      makeEvent(878, 'command', { commandLine: 'npm test', exitCode: 0 }),
      makeEvent(879, 'tool_generic', {}, { rawType: 'CORTEX_STEP_TYPE_LIST_DIR' }),
      makeEvent(880, 'thinking_and_text', {
        thinking: 'Checking results before editing',
        thinkingDuration: '8.365740s',
      }),
      makeEvent(881, 'code_action', { actionSpec: { targetFile: 'src/a.ts' } }),
      makeEvent(882, 'web_search', { query: 'vitest' }),
      makeEvent(883, 'thinking_and_text', {
        thinking: 'All checks passed',
        thinkingDuration: 1.5,
      }),
      finalAnswer,
    ];

    const grouped = groupTimelineEvents(events);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toMatchObject({ type: 'single', id: 'ev-875' });
    expect(grouped[1]).toMatchObject({
      type: 'tool_group',
      id: 'tg-876',
      firstSeq: 876,
      lastSeq: 883,
      thoughtCount: 3,
      toolCount: 5,
    });
    if (grouped[1].type === 'tool_group') {
      expect(grouped[1].events).toHaveLength(8);
      expect(grouped[1].totalThinkingSeconds).toBeCloseTo(11.96574, 4);
    }
    expect(grouped[2]).toMatchObject({ type: 'single', id: 'ev-884' });
  });
});
