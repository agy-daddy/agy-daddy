import { humanizeEnum, type I18nKey } from '../i18n';
import type {
  CodeActionPayload,
  CommandEventPayload,
  FileViewPayload,
  GenericToolPayload,
  PlannerResponsePayload,
  SessionEvent,
  SessionEventKind,
  WebSearchPayload,
} from '../types';

export const TOOL_CALL_KINDS: ReadonlySet<SessionEventKind> = new Set<SessionEventKind>([
  'command',
  'file_view',
  'code_action',
  'web_search',
  'tool_generic',
]);

export function isToolCallEvent(event: SessionEvent): boolean {
  return TOOL_CALL_KINDS.has(event.kind);
}

function extractVisibleAssistantText(payload: PlannerResponsePayload | undefined): string {
  if (!payload) return '';
  const candidates = [payload.modifiedResponse, payload.response, payload.text];
  for (const val of candidates) {
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return '';
}

export function isIntermediateThinkingEvent(event: SessionEvent): boolean {
  if (event.kind !== 'thinking_and_text') return false;
  return extractVisibleAssistantText(event.payload as PlannerResponsePayload | undefined) === '';
}

export function isCollapsibleWorkEvent(event: SessionEvent): boolean {
  return isToolCallEvent(event) || isIntermediateThinkingEvent(event);
}

export function parseThinkingDurationSeconds(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (!trimmed) return 0;

  const msMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*ms$/i);
  if (msMatch) {
    const val = Number.parseFloat(msMatch[1]) / 1000;
    return Number.isFinite(val) && val > 0 ? val : 0;
  }

  const secMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*s?$/i);
  if (secMatch) {
    const val = Number.parseFloat(secMatch[1]);
    return Number.isFinite(val) && val > 0 ? val : 0;
  }

  return 0;
}

export function formatThinkingSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0';
  if (seconds < 0.01) return '<0.1';
  if (seconds < 0.1) return String(Number(seconds.toFixed(2)));
  return seconds.toFixed(1).replace(/\.0$/, '');
}

export interface WorkGroupSummary {
  thoughtCount: number;
  toolCount: number;
  totalThinkingSeconds: number;
}

export function summarizeWorkGroup(events: readonly SessionEvent[]): WorkGroupSummary {
  let thoughtCount = 0;
  let toolCount = 0;
  let totalThinkingSeconds = 0;

  for (const ev of events) {
    if (isIntermediateThinkingEvent(ev)) {
      thoughtCount += 1;
      const p = ev.payload as PlannerResponsePayload | undefined;
      totalThinkingSeconds += parseThinkingDurationSeconds(p?.thinkingDuration);
    } else {
      toolCount += 1;
    }
  }

  return { thoughtCount, toolCount, totalThinkingSeconds };
}

export type TimelineEntry =
  | {
      type: 'single';
      id: string;
      event: SessionEvent;
    }
  | {
      type: 'tool_group';
      id: string;
      events: SessionEvent[];
      firstSeq: number;
      lastSeq: number;
      thoughtCount: number;
      toolCount: number;
      totalThinkingSeconds: number;
    };

export function groupTimelineEvents(events: SessionEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let currentGroup: SessionEvent[] = [];

  const flushGroup = () => {
    if (currentGroup.length === 0) return;
    const firstSeq = currentGroup[0].seq;
    const lastSeq = currentGroup[currentGroup.length - 1].seq;
    const summary = summarizeWorkGroup(currentGroup);
    entries.push({
      type: 'tool_group',
      id: `tg-${firstSeq}`,
      events: currentGroup,
      firstSeq,
      lastSeq,
      ...summary,
    });
    currentGroup = [];
  };

  for (const event of events) {
    if (isCollapsibleWorkEvent(event)) {
      currentGroup.push(event);
    } else {
      flushGroup();
      entries.push({
        type: 'single',
        id: `ev-${event.seq}`,
        event,
      });
    }
  }
  flushGroup();

  return entries;
}

function truncateText(text: string, maxLen: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(0, maxLen - 1))}…`;
}

function shortenPath(rawPath: string): string {
  if (!rawPath) return '';
  const stripped = rawPath.replace(/^file:\/\//, '');
  const parts = stripped.split('/').filter(Boolean);
  if (parts.length <= 2) return stripped;
  return `…/${parts.slice(-2).join('/')}`;
}

export interface ToolBriefInfo {
  icon: string;
  brief: string;
  hint?: string;
}

export function formatToolBrief(
  event: SessionEvent,
  t: (key: I18nKey, vars?: Record<string, string | number>) => string,
): ToolBriefInfo {
  switch (event.kind) {
    case 'command': {
      const p = event.payload as CommandEventPayload;
      const cmd = truncateText(p.commandLine || p.proposedCommandLine || event.title || 'command', 64);
      const hint =
        p.exitCode !== null && p.exitCode !== undefined
          ? t('stream.commandExit', { code: p.exitCode })
          : undefined;
      return {
        icon: '⌘',
        brief: t('tools.briefCommand', { cmd }),
        hint,
      };
    }

    case 'file_view': {
      const p = event.payload as FileViewPayload;
      const file = shortenPath(p.absolutePathUri || event.title || 'file');
      const hasRange =
        p.startLine !== null &&
        p.startLine !== undefined &&
        p.endLine !== null &&
        p.endLine !== undefined;
      const hint = hasRange
        ? t('stream.fileViewLines', { start: p.startLine!, end: p.endLine! })
        : undefined;
      return {
        icon: '📄',
        brief: t('tools.briefFileView', { file }),
        hint,
      };
    }

    case 'code_action': {
      const p = event.payload as CodeActionPayload;
      const file = shortenPath(p.actionSpec?.targetFile || event.title || 'code');
      const stats = p.diffStats;
      const add =
        typeof stats?.additions === 'number'
          ? stats.additions
          : typeof stats?.linesAdded === 'number'
            ? stats.linesAdded
            : null;
      const del =
        typeof stats?.deletions === 'number'
          ? stats.deletions
          : typeof stats?.linesRemoved === 'number'
            ? stats.linesRemoved
            : null;
      const hint = add !== null || del !== null ? `+${add ?? 0}/-${del ?? 0}` : undefined;
      return {
        icon: '✏️',
        brief: t('tools.briefCodeAction', { file }),
        hint,
      };
    }

    case 'web_search': {
      const p = event.payload as WebSearchPayload;
      const query = truncateText(p.query || event.title || 'web', 56);
      return {
        icon: '🔍',
        brief: t('tools.briefWebSearch', { query }),
      };
    }

    case 'thinking_and_text': {
      const p = event.payload as PlannerResponsePayload;
      const rawThinking = typeof p.thinking === 'string' ? p.thinking : '';
      const firstNonEmptyLine = rawThinking
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      const brief = firstNonEmptyLine
        ? truncateText(firstNonEmptyLine, 64)
        : t('tools.briefThought');
      const sec = parseThinkingDurationSeconds(p.thinkingDuration);
      const hint =
        sec > 0
          ? t('tools.thoughtDuration', { sec: formatThinkingSeconds(sec) })
          : undefined;
      return {
        icon: '💭',
        brief,
        ...(hint ? { hint } : {}),
      };
    }

    case 'tool_generic':
    default: {
      const p = event.payload as GenericToolPayload;
      const rawToolName = typeof p.toolName === 'string' ? p.toolName.trim() : '';
      const rawNameField = typeof p.name === 'string' ? p.name.trim() : '';
      const humanizedRawType =
        event.rawType &&
        event.rawType !== 'CORTEX_STEP_TYPE_GENERIC' &&
        event.rawType !== 'TEST_TOOL_GENERIC'
          ? humanizeEnum(event.rawType)
          : '';
      const cleanTitle =
        typeof event.title === 'string' && event.title.trim().toLowerCase() !== 'tool'
          ? event.title.trim()
          : '';
      const name = truncateText(
        rawToolName || rawNameField || humanizedRawType || cleanTitle || event.title || 'tool',
        56,
      );
      const rawPathHint =
        (typeof p.targetFile === 'string' && p.targetFile.trim()) ||
        (typeof p.path === 'string' && p.path.trim()) ||
        (typeof p.directoryPath === 'string' && p.directoryPath.trim()) ||
        (typeof p.absolutePathUri === 'string' && p.absolutePathUri.trim()) ||
        '';
      const rawQueryHint =
        (typeof p.query === 'string' && p.query.trim()) ||
        (typeof p.pattern === 'string' && p.pattern.trim()) ||
        '';
      const hint = rawPathHint
        ? shortenPath(rawPathHint)
        : rawQueryHint
          ? truncateText(rawQueryHint, 32)
          : undefined;
      return {
        icon: '🔧',
        brief: t('tools.briefGeneric', { name }),
        ...(hint ? { hint } : {}),
      };
    }
  }
}
