import type { SessionEvent, SessionEventKind } from '../types';

export interface BridgedThinkingNote {
  seq: number;
  thinking: string;
  duration?: unknown;
}

export type DisplayTimelineItem =
  | { type: 'step'; event: SessionEvent }
  | {
      type: 'tool_group';
      id: string;
      events: SessionEvent[];
      thinkingNotes?: BridgedThinkingNote[];
    };

export const TOOL_EVENT_KINDS = new Set<SessionEventKind>([
  'command',
  'file_view',
  'code_action',
  'web_search',
  'tool_generic',
  'checkpoint'
]);

export const KIND_LABELS: Record<SessionEventKind, string> = {
  user: '用户',
  thinking_and_text: '助手',
  command: '命令',
  file_view: '读文件',
  code_action: '改代码',
  ask_question: '提问',
  web_search: '检索',
  checkpoint: '快照',
  system: '系统',
  tool_generic: '工具',
  error: '异常'
};

const INTERNAL_IPC_TOOLS = new Set([
  'send_message',
  'post_message',
  'read_board',
  'swarm_wait',
  'swarm',
  'update_focus',
  'update_steps',
  'check_board',
  'wait_for_message',
  'agent_message',
  'relay_message',
  'report_status',
  'ping_parent',
  'subagent_ping',
  'subagent_status'
]);

const INTERNAL_RAW_TYPE_RE =
  /(?:SEND_MESSAGE|POST_MESSAGE|READ_BOARD|SWARM_WAIT|SWARM_|UPDATE_FOCUS|UPDATE_STEPS|EPHEMERAL_MESSAGE|CONVERSATION_HISTORY|SUBAGENT_STATUS|AGENT_MESSAGE|SYSTEM_NOTIFICATION|PLAN_REVIEW|BROWSER_HOST_FACTS|INTERNAL_|HIDDEN_PROMPT|PROMPT_WRAPPER)/i;

const INTERNAL_EVENT_TYPE_RE =
  /(?:plan[\s_-]*review|browser[\s_-]*host[\s_-]*facts|swarm|board|subagent|agent[\s_-]*message|agent[\s_-]*relay|system[\s_-]*notification|status[\s_-]*ping|heartbeat|ephemeral|prompt[\s_-]*wrapper|hidden|internal|metadata|telemetry|hook|context[\s_-]*injection|memory[\s_-]*injection|tool[\s_-]*routing)/i;

const INTERNAL_CONTENT_PATTERNS: RegExp[] = [
  /\[plan\s+review\]/i,
  /\bBROWSER_HOST_FACTS\b/,
  /<\/?(?:swarm_worker|agent_message|system_notification|SYSTEM_MESSAGE|system-reminder|ephemeral_message|task[-_]notification|hidden_prompt|prompt_wrapper)\b/i,
  /\[swarm\]\s*(?:new\s+board\s+message|board\s+message)/i,
  /\[board\]\s*the\s+latest\s+message\s+is\s+#\d+/i,
  /\[Message\]\s+timestamp=[^\s]+\s+sender=/i,
  /You\s+have\s+just\s+started\.\s+Your\s+assignment\s+\(recorded\s+on\s+the\s+board/i,
  /\bParent\s+session\s+agent\s+ID:/i,
  /\bAGENTCOMPASS_WORKER\b/,
  /\bsubagent_status\b/i
];

const INTERNAL_USER_SOURCE_RE = /^(?:system|subagent|swarm|agent|internal|relay|ephemeral|board)$/i;

export function extractUserText(p: Record<string, unknown> | undefined | null): string {
  if (!p) return '';
  if (typeof p.userResponse === 'string' && p.userResponse) return p.userResponse;
  if (typeof p.text === 'string' && p.text) return p.text;
  if (Array.isArray(p.items)) {
    return p.items
      .map((item) =>
        typeof item === 'string' ? item : String((item as { text?: string })?.text || '')
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function extractPlannerText(p: Record<string, unknown> | undefined | null): string {
  if (!p) return '';
  if (typeof p.modifiedResponse === 'string' && p.modifiedResponse) return p.modifiedResponse;
  if (typeof p.response === 'string' && p.response) return p.response;
  if (typeof p.text === 'string' && p.text) return p.text;
  return '';
}

function normalizeToolIdentifier(raw: string): string {
  const cleaned = raw.trim().replace(/^[a-z0-9_.-]+:/i, '');
  return cleaned.replace(/^CORTEX_STEP_TYPE_/i, '').toLowerCase();
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function extractToolName(ev: SessionEvent): string {
  const p = ev.payload || {};
  const generic = asRecord(p.generic);
  const genericToolCall = asRecord(generic?.toolCall);
  const mcp = asRecord(p.mcp);
  const fnCall = asRecord(p.functionCall);
  const toolCall = asRecord(p.toolCall);
  const call = asRecord(p.call);
  const raw = asRecord(p.raw);
  const rawToolCall = asRecord(raw?.toolCall);
  const rawFnCall = asRecord(raw?.functionCall);

  const candidates = [
    p.toolName,
    p.functionName,
    p.name,
    p.tool,
    toolCall?.name,
    toolCall?.toolName,
    toolCall?.functionName,
    call?.name,
    call?.toolName,
    fnCall?.name,
    generic?.toolName,
    generic?.name,
    genericToolCall?.name,
    genericToolCall?.toolName,
    mcp?.toolName,
    rawToolCall?.name,
    rawToolCall?.toolName,
    rawToolCall?.functionName,
    rawFnCall?.name,
    raw?.toolName,
    raw?.name,
    ev.title
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return c.trim();
    }
  }
  return '';
}

function matchesInternalContent(text: string): boolean {
  if (!text) return false;
  for (const re of INTERNAL_CONTENT_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

export function isToolEvent(ev: SessionEvent): boolean {
  return TOOL_EVENT_KINDS.has(ev.kind);
}

/**
 * Returns true if an event is purely internal agent/swarm/subagent communication
 * or empty metadata-only noise that should be hidden from the user chat stream.
 *
 * Always preserves pending user-approval/ask_question steps, real errors,
 * real user prompts, and real assistant responses.
 */
export function isInternalAgentEvent(ev: SessionEvent): boolean {
  if (!ev) return true;

  // Never hide interactive pending actions, real errors, or ask_question prompts.
  if (ev.status === 'pending') return false;
  if (ev.kind === 'error' || ev.kind === 'ask_question') return false;

  const p = ev.payload || {};
  const rawType = String(ev.rawType || '');
  const title = String(ev.title || '');

  // Explicit internal / hidden / ephemeral flags from host or relay.
  if (p.isInternal === true || p.internal === true || p.hidden === true || p.ephemeral === true) {
    return true;
  }

  // Raw step type explicitly marks internal agent/swarm IPC or plumbing.
  if (INTERNAL_RAW_TYPE_RE.test(rawType)) {
    return true;
  }

  if (ev.kind === 'system') {
    const eventType = String(p.eventType || p.type || p.subtype || '');
    const message = String(p.message || p.text || p.content || '');
    if (eventType && INTERNAL_EVENT_TYPE_RE.test(eventType)) return true;
    if (matchesInternalContent(message) || matchesInternalContent(title)) return true;
    // Metadata-only / empty system step with no user-facing message.
    if (!message.trim()) return true;
    return false;
  }

  if (ev.kind === 'user') {
    const source = String(p.source || p.senderType || p.role || '');
    if (source && INTERNAL_USER_SOURCE_RE.test(source.trim())) return true;
    const text = extractUserText(p);
    if (matchesInternalContent(text) || matchesInternalContent(title)) return true;
    const hasImages = Array.isArray(p.images) && p.images.length > 0;
    const hasAttachments = Array.isArray(p.attachments) && p.attachments.length > 0;
    if (!text.trim() && !hasImages && !hasAttachments) return true;
    return false;
  }

  if (ev.kind === 'thinking_and_text') {
    const thinking = typeof p.thinking === 'string' ? p.thinking : '';
    const text = extractPlannerText(p);
    if (text && matchesInternalContent(text)) return true;
    const isActive = ev.status === 'generating' || ev.status === 'running';
    // Empty / metadata-only planner step (e.g. only carries toolCalls or stopReason).
    if (!isActive && !text.trim() && !thinking.trim()) return true;
    return false;
  }

  // Internal agent-to-agent IPC tool calls.
  if (ev.kind === 'tool_generic' || ev.kind === 'command') {
    const toolName = extractToolName(ev);
    const normTool = toolName ? normalizeToolIdentifier(toolName) : '';
    if (normTool && INTERNAL_IPC_TOOLS.has(normTool)) return true;

    const normRaw = normalizeToolIdentifier(rawType);
    if (normRaw && INTERNAL_IPC_TOOLS.has(normRaw)) return true;

    if (ev.kind === 'tool_generic') {
      const args = p.args && typeof p.args === 'object' ? (p.args as Record<string, unknown>) : null;
      const argTool = typeof args?.tool === 'string' ? normalizeToolIdentifier(args.tool) : '';
      if (argTool && INTERNAL_IPC_TOOLS.has(argTool)) return true;

      if (title && matchesInternalContent(title)) return true;
      if (typeof p.message === 'string' && matchesInternalContent(p.message)) return true;
    }
  }

  return false;
}

function isThinkingOnlyBridge(ev: SessionEvent): boolean {
  if (ev.kind !== 'thinking_and_text') return false;
  if (ev.status === 'generating' || ev.status === 'running' || ev.status === 'pending') {
    return false;
  }
  const text = extractPlannerText(ev.payload);
  return !text.trim();
}

function isMergeableToolEvent(ev: SessionEvent): boolean {
  return isToolEvent(ev) && ev.status !== 'pending';
}

/**
 * Pure timeline builder:
 * 1. Filters out internal agent/swarm/subagent communication & empty metadata noise.
 * 2. Merges 2+ consecutive non-pending tool calls (including across empty or
 *    thinking-only terminal planner bridge steps) into a single `tool_group`.
 * 3. Preserves pending tool calls and standalone single tool calls as `step` items.
 */
export function buildDisplayTimeline(events: SessionEvent[]): DisplayTimelineItem[] {
  if (!Array.isArray(events) || events.length === 0) return [];

  const visible = events.filter((ev) => !isInternalAgentEvent(ev));
  const out: DisplayTimelineItem[] = [];

  let toolRun: SessionEvent[] = [];
  let bridgedThinking: BridgedThinkingNote[] = [];
  let pendingBridges: SessionEvent[] = [];

  const flushRun = () => {
    if (toolRun.length >= 2) {
      out.push({
        type: 'tool_group',
        id: `tg-${toolRun[0].seq}`,
        events: toolRun,
        ...(bridgedThinking.length > 0 ? { thinkingNotes: bridgedThinking } : {})
      });
    } else if (toolRun.length === 1) {
      out.push({ type: 'step', event: toolRun[0] });
    }
    toolRun = [];
    bridgedThinking = [];

    if (pendingBridges.length > 0) {
      for (const b of pendingBridges) {
        out.push({ type: 'step', event: b });
      }
      pendingBridges = [];
    }
  };

  for (const ev of visible) {
    if (isMergeableToolEvent(ev)) {
      if (toolRun.length > 0 && pendingBridges.length > 0) {
        for (const b of pendingBridges) {
          const thinking = typeof b.payload?.thinking === 'string' ? b.payload.thinking.trim() : '';
          if (thinking) {
            bridgedThinking.push({
              seq: b.seq,
              thinking,
              duration: b.payload?.thinkingDuration
            });
          }
        }
        pendingBridges = [];
      }
      toolRun.push(ev);
      continue;
    }

    if (toolRun.length > 0 && isThinkingOnlyBridge(ev)) {
      pendingBridges.push(ev);
      continue;
    }

    flushRun();
    out.push({ type: 'step', event: ev });
  }

  flushRun();
  return out;
}

export function formatBasename(rawPath: string): string {
  const clean = rawPath.replace(/^file:\/\//, '').replace(/\/+$/, '');
  const parts = clean.split('/');
  return parts[parts.length - 1] || clean;
}

export function summarizeToolEvent(ev: SessionEvent): string {
  const p = ev.payload || {};
  switch (ev.kind) {
    case 'command': {
      const cmd = String(p.commandLine || p.proposedCommandLine || ev.title || '').trim();
      return cmd ? `$ ${cmd}` : '执行命令';
    }
    case 'file_view': {
      const filePath = String(p.absolutePathUri || ev.title || '').trim();
      const base = filePath ? formatBasename(filePath) : '查看文件';
      const hasRange = p.startLine != null && p.endLine != null;
      return hasRange ? `${base} L${p.startLine}-${p.endLine}` : base;
    }
    case 'code_action': {
      const spec = (p.actionSpec as Record<string, unknown> | undefined) || null;
      const targetFile = typeof spec?.targetFile === 'string' ? spec.targetFile : '';
      if (targetFile) return formatBasename(targetFile);
      if (typeof spec?.description === 'string' && spec.description.trim()) {
        return spec.description.trim();
      }
      return ev.title || '修改代码';
    }
    case 'web_search': {
      if (typeof p.query === 'string' && p.query.trim()) return p.query.trim();
      return ev.title || '网络检索';
    }
    case 'checkpoint': {
      if (p.includedStepIndexEnd != null) return `至步骤 #${String(p.includedStepIndexEnd)}`;
      return ev.title || '会话快照';
    }
    case 'tool_generic': {
      const name = extractToolName(ev);
      return name || ev.rawType.replace(/^CORTEX_STEP_TYPE_/i, '') || '工具调用';
    }
    default:
      return ev.title || KIND_LABELS[ev.kind] || ev.kind;
  }
}

export function summarizeToolGroup(events: SessionEvent[]): {
  headline: string;
  activeEvent: SessionEvent | null;
  hasError: boolean;
} {
  const activeEvent =
    events.find((e) => e.status === 'running' || e.status === 'generating') || null;
  const hasError = events.some((e) => e.status === 'error');

  if (activeEvent) {
    const kindLabel = KIND_LABELS[activeEvent.kind] || activeEvent.kind;
    const detail = summarizeToolEvent(activeEvent);
    return {
      headline: `正在执行 (${events.length}) · ${kindLabel}: ${detail}`,
      activeEvent,
      hasError
    };
  }

  const order: SessionEventKind[] = [];
  const counts = new Map<SessionEventKind, number>();
  for (const ev of events) {
    if (!counts.has(ev.kind)) order.push(ev.kind);
    counts.set(ev.kind, (counts.get(ev.kind) || 0) + 1);
  }
  const breakdown = order
    .map((k) => `${KIND_LABELS[k] || k}×${counts.get(k)}`)
    .join(' · ');

  return {
    headline: `已调用 ${events.length} 个工具 · ${breakdown}`,
    activeEvent: null,
    hasError
  };
}
