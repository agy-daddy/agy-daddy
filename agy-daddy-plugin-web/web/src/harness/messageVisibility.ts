import type { SessionEvent } from '../types';

export type VisibilityReason =
  | 'render_info_hidden'
  | 'swarm_envelope'
  | 'internal_message_envelope'
  | 'plan_review_envelope'
  | 'browser_host_facts'
  | 'empty_system_event';

export interface VisibilityDecision {
  visibility: 'visible' | 'hidden_by_default';
  reason?: VisibilityReason;
}

const SWARM_ENVELOPE_RE = /\[swarm\]/i;
const INTERNAL_MESSAGE_ENVELOPE_RE = /^\[Message\]\s+timestamp=.*?\bsender=/im;
const PLAN_REVIEW_ENVELOPE_RE = /\[plan review(?:\s+due)?\]/i;
const BROWSER_HOST_FACTS_RE = /BROWSER_HOST_FACTS/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractContentBlockTexts(renderInfo: Record<string, unknown> | null): string[] {
  if (!renderInfo || !Array.isArray(renderInfo.contentBlocks)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of renderInfo.contentBlocks) {
    if (!isRecord(block)) continue;
    if (typeof block.markdown === 'string') {
      texts.push(block.markdown);
    }
    if (typeof block.text === 'string') {
      texts.push(block.text);
    }
  }
  return texts;
}

function extractCandidateSegments(
  event: SessionEvent,
  payload: Record<string, unknown>,
  renderInfo: Record<string, unknown> | null,
): { segments: string[]; contentBlockTexts: string[] } {
  const segments: string[] = [];
  if (typeof payload.message === 'string') segments.push(payload.message);
  if (typeof payload.text === 'string') segments.push(payload.text);
  if (typeof payload.userResponse === 'string') segments.push(payload.userResponse);
  if (typeof event.title === 'string') segments.push(event.title);

  const contentBlockTexts = extractContentBlockTexts(renderInfo);
  segments.push(...contentBlockTexts);

  return { segments, contentBlockTexts };
}

export function evaluateEventVisibility(event: SessionEvent): VisibilityDecision {
  if (event.kind === 'error') {
    return { visibility: 'visible' };
  }

  const payload = isRecord(event.payload) ? event.payload : {};
  const renderInfo = isRecord(payload.renderInfo) ? payload.renderInfo : null;

  if (renderInfo && renderInfo.hidden === true) {
    return { visibility: 'hidden_by_default', reason: 'render_info_hidden' };
  }

  const { segments, contentBlockTexts } = extractCandidateSegments(event, payload, renderInfo);

  if (event.kind === 'system' || event.kind === 'user') {
    if (segments.some((seg) => SWARM_ENVELOPE_RE.test(seg))) {
      return { visibility: 'hidden_by_default', reason: 'swarm_envelope' };
    }
    if (segments.some((seg) => INTERNAL_MESSAGE_ENVELOPE_RE.test(seg.trimStart()))) {
      return { visibility: 'hidden_by_default', reason: 'internal_message_envelope' };
    }
    if (segments.some((seg) => PLAN_REVIEW_ENVELOPE_RE.test(seg))) {
      return { visibility: 'hidden_by_default', reason: 'plan_review_envelope' };
    }
    if (segments.some((seg) => BROWSER_HOST_FACTS_RE.test(seg))) {
      return { visibility: 'hidden_by_default', reason: 'browser_host_facts' };
    }
  }

  if (event.kind === 'system') {
    const hasText = segments.some((seg) => seg.trim().length > 0);
    const hasContentBlocks = contentBlockTexts.some((seg) => seg.trim().length > 0);
    if (!hasText && !hasContentBlocks) {
      return { visibility: 'hidden_by_default', reason: 'empty_system_event' };
    }
  }

  return { visibility: 'visible' };
}

export function partitionTimelineEvents(
  events: SessionEvent[],
  includeHidden = false,
): { visibleEvents: SessionEvent[]; hiddenCount: number } {
  const visibleEvents: SessionEvent[] = [];
  let hiddenCount = 0;

  for (const event of events) {
    const decision = evaluateEventVisibility(event);
    if (decision.visibility === 'hidden_by_default') {
      hiddenCount += 1;
      if (includeHidden) {
        visibleEvents.push(event);
      }
    } else {
      visibleEvents.push(event);
    }
  }

  return { visibleEvents, hiddenCount };
}
