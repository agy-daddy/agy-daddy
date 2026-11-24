import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../types';
import { evaluateEventVisibility, partitionTimelineEvents } from './messageVisibility';

function makeEvent(overrides: Partial<SessionEvent>): SessionEvent {
  return {
    seq: 1,
    kind: 'system',
    status: 'done',
    rawType: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE',
    payload: {},
    ...overrides,
  };
}

describe('messageVisibility', () => {
  it('hides the exact user swarm sample with renderInfo.hidden: true and contentBlocks', () => {
    const event = makeEvent({
      seq: 12,
      kind: 'system',
      payload: {
        eventType: 'SYSTEM_MESSAGE_TYPE_UNSPECIFIED',
        message:
          '[Message] timestamp=2026-11-23T11:19:59Z sender=93d62427-0000-0000-0000-000000000000 content=[swarm] new board message #1',
        renderInfo: {
          hidden: true,
          contentBlocks: [
            {
              markdown:
                '[Message] timestamp=2026-11-23T11:19:59Z sender=93d62427-0000-0000-0000-000000000000 content=[swarm] new board message #1',
            },
          ],
        },
      },
    });

    expect(evaluateEventVisibility(event)).toEqual({
      visibility: 'hidden_by_default',
      reason: 'render_info_hidden',
    });
  });

  it('hides internal envelope variants on system and user events', () => {
    const swarmSystem = makeEvent({
      kind: 'system',
      payload: { message: 'Notification: [swarm] new board message #45' },
    });
    expect(evaluateEventVisibility(swarmSystem)).toEqual({
      visibility: 'hidden_by_default',
      reason: 'swarm_envelope',
    });

    const internalUser = makeEvent({
      kind: 'user',
      rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
      payload: {
        userResponse:
          '[Message] timestamp=2026-11-23T11:19:59Z sender=93d62427-1111-2222-3333-444444444444 content=ping',
      },
    });
    expect(evaluateEventVisibility(internalUser)).toEqual({
      visibility: 'hidden_by_default',
      reason: 'internal_message_envelope',
    });

    const planReview = makeEvent({
      kind: 'user',
      rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
      payload: {
        renderInfo: {
          contentBlocks: [{ text: '[plan review due] Please inspect updated architecture.' }],
        },
      },
    });
    expect(evaluateEventVisibility(planReview)).toEqual({
      visibility: 'hidden_by_default',
      reason: 'plan_review_envelope',
    });

    const browserFacts = makeEvent({
      kind: 'system',
      payload: {
        text: 'BROWSER_HOST_FACTS: {"os":"macOS"}',
      },
    });
    expect(evaluateEventVisibility(browserFacts)).toEqual({
      visibility: 'hidden_by_default',
      reason: 'browser_host_facts',
    });

    const emptySystem = makeEvent({
      kind: 'system',
      payload: {
        message: '   ',
        renderInfo: { contentBlocks: [{ markdown: '  ' }] },
      },
    });
    expect(evaluateEventVisibility(emptySystem)).toEqual({
      visibility: 'hidden_by_default',
      reason: 'empty_system_event',
    });
  });

  it('keeps user-facing normal system events without hidden: true visible', () => {
    const normalSystem = makeEvent({
      kind: 'system',
      payload: {
        eventType: 'SYSTEM_NOTICE',
        message: 'Session paused by user.',
        renderInfo: {
          hidden: false,
          contentBlocks: [{ markdown: 'Session paused by user.' }],
        },
      },
    });

    expect(evaluateEventVisibility(normalSystem)).toEqual({
      visibility: 'visible',
    });
  });

  it('always keeps error events visible even if text mentions [swarm]', () => {
    const errorEvent = makeEvent({
      kind: 'error',
      status: 'error',
      rawType: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
      title: '[swarm] failure',
      payload: {
        message: '[swarm] worker crashed',
        renderInfo: { hidden: true },
        error: { message: '[swarm] RPC error' },
      },
    });

    expect(evaluateEventVisibility(errorEvent)).toEqual({
      visibility: 'visible',
    });
  });

  it('partitions hidden events and respects includeHidden flag while preserving hiddenCount', () => {
    const visibleUser = makeEvent({
      seq: 1,
      kind: 'user',
      rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
      payload: { text: 'Run tests' },
    });
    const hiddenSwarm = makeEvent({
      seq: 2,
      kind: 'system',
      payload: { message: '[swarm] new board message #2' },
    });
    const visibleSystem = makeEvent({
      seq: 3,
      kind: 'system',
      payload: { message: 'Session resumed.' },
    });

    const hiddenByDefault = partitionTimelineEvents([visibleUser, hiddenSwarm, visibleSystem]);
    expect(hiddenByDefault.hiddenCount).toBe(1);
    expect(hiddenByDefault.visibleEvents.map((e) => e.seq)).toEqual([1, 3]);

    const withHidden = partitionTimelineEvents([visibleUser, hiddenSwarm, visibleSystem], true);
    expect(withHidden.hiddenCount).toBe(1);
    expect(withHidden.visibleEvents.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
});
