import type { ComposerQuickPrompt, ComposerStateResponse, SessionEvent } from '../types';

export interface HighRiskRule {
  id: string;
  label: string;
  pattern: RegExp;
}

export const HIGH_RISK_PATTERNS: HighRiskRule[] = [
  { id: 'rm-rf', label: 'rm -rf', pattern: /\brm\s+-[a-z]*[rf]{2}[a-z]*\b|\brm\s+-r\s+-f\b/i },
  { id: 'git-reset', label: 'git reset --hard', pattern: /\bgit\s+reset\s+--hard\b/i },
  { id: 'git-clean', label: 'git clean -f', pattern: /\bgit\s+clean\s+-[a-z]*f/i },
  {
    id: 'git-force-push',
    label: 'git push --force',
    pattern: /\bgit\s+push\b[^\n]*(\s-f\b|--force)/i
  },
  { id: 'git-checkout', label: 'git checkout --', pattern: /\bgit\s+checkout\s+--\s/i },
  { id: 'disk-format', label: 'sudo/mkfs/dd', pattern: /\b(mkfs|dd\s+if=|sudo\s+rm)\b/i },
  { id: 'kill-9', label: 'kill -9', pattern: /\bkill\s+-9\b/i },
  {
    id: 'sql-drop',
    label: 'SQL DROP/TRUNCATE/DELETE',
    pattern: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*(;|$))/i
  }
];

export function detectHighRiskPrompt(text: string): { risky: boolean; labels: string[] } {
  if (!text || !text.trim()) {
    return { risky: false, labels: [] };
  }
  const labels: string[] = [];
  for (const rule of HIGH_RISK_PATTERNS) {
    if (rule.pattern.test(text)) {
      labels.push(rule.label);
    }
  }
  return { risky: labels.length > 0, labels };
}

export const DEFAULT_QUICK_PROMPTS: ComposerQuickPrompt[] = [
  { id: 'compact', label: '/compact', template: '/compact ', category: 'context', builtin: true },
  { id: 'goal', label: '/goal', template: '/goal ', category: 'workflow', builtin: true },
  { id: 'grill-me', label: '/grill-me', template: '/grill-me ', category: 'review', builtin: true },
  { id: 'btw', label: '/btw', template: '/btw ', category: 'context', builtin: true },
  { id: 'learn', label: '/learn', template: '/learn ', category: 'memory', builtin: true },
  { id: 'boost', label: '/boost', template: '/boost ', category: 'workflow', builtin: true },
  { id: 'swarm', label: '/swarm', template: '/swarm ', category: 'workflow', builtin: true }
];

export interface RawHostQuickPrompt {
  id?: string;
  label?: string;
  labelEn?: string;
  template?: string;
  text?: string;
  prompt?: string;
  slash?: string;
  category?: string;
  group?: string;
  builtin?: boolean;
  enabled?: boolean;
}

export function resolveQuickPrompts(
  quickPrompts?: ReadonlyArray<ComposerQuickPrompt | RawHostQuickPrompt>,
  locale = 'zh-CN'
): ComposerQuickPrompt[] {
  const rawList: RawHostQuickPrompt[] = Array.isArray(quickPrompts)
    ? (quickPrompts as RawHostQuickPrompt[])
    : [];

  if (rawList.length === 0) {
    return DEFAULT_QUICK_PROMPTS;
  }

  const isZh = locale.toLowerCase().startsWith('zh');
  const seen = new Set<string>();
  const resolved: ComposerQuickPrompt[] = [];

  for (const item of rawList) {
    if (!item || item.enabled === false) continue;
    const id = String(item.id || item.slash || item.label || '').trim();
    const template = String(
      item.template ?? item.prompt ?? item.text ?? (item.slash ? `/${item.slash} ` : '')
    );
    if (!id || !template.trim() || seen.has(id)) continue;
    if (template.trim().toLowerCase() === '/plan') continue;
    seen.add(id);
    const label = isZh
      ? String(item.label || item.labelEn || id).trim()
      : String(item.labelEn || item.label || id).trim();
    resolved.push({
      id,
      label,
      template,
      category: item.category || item.group,
      builtin: item.builtin
    });
  }

  return resolved.length > 0 ? resolved : DEFAULT_QUICK_PROMPTS;
}

export function getGhostSuggestions(options: {
  text: string;
  frequentPrompts?: string[];
  quickPrompts?: ComposerQuickPrompt[];
  composerState?: ComposerStateResponse | null;
  contextUsagePct?: number | null;
  autoCompactThreshold?: number;
}): string[] {
  const {
    text,
    frequentPrompts = [],
    quickPrompts = DEFAULT_QUICK_PROMPTS,
    composerState,
    contextUsagePct = null,
    autoCompactThreshold = 80
  } = options;

  const trimmed = text.trim();
  const candidates: string[] = [];
  const addCandidate = (value: string) => {
    const clean = value.trim();
    if (!clean || candidates.includes(clean)) return;
    candidates.push(clean);
  };

  if (trimmed.startsWith('/')) {
    const lower = trimmed.toLowerCase();
    const pool = [...quickPrompts, ...DEFAULT_QUICK_PROMPTS];
    for (const item of pool) {
      const cmd = item.template.trim();
      if (!cmd.startsWith('/')) continue;
      if (cmd.toLowerCase().startsWith(lower) && cmd.toLowerCase() !== lower) {
        addCandidate(cmd);
      }
    }
    return candidates.slice(0, 4);
  }

  if (trimmed.length > 0) {
    const lower = trimmed.toLowerCase();
    for (const entry of frequentPrompts) {
      const clean = entry.trim();
      if (clean && clean.toLowerCase().startsWith(lower) && clean.toLowerCase() !== lower) {
        addCandidate(clean);
      }
    }
    return candidates.slice(0, 3);
  }

  if (typeof contextUsagePct === 'number' && contextUsagePct >= autoCompactThreshold) {
    addCandidate('/compact');
  }

  for (const entry of frequentPrompts) {
    addCandidate(entry);
  }

  const stateFreq = composerState?.frequentPrompts;
  if (Array.isArray(stateFreq)) {
    for (const entry of stateFreq) {
      if (typeof entry === 'string') {
        addCandidate(entry);
      } else if (entry && typeof entry === 'object') {
        const obj = entry as RawHostQuickPrompt;
        addCandidate(String(obj.template ?? obj.prompt ?? obj.text ?? obj.label ?? ''));
      }
    }
  }

  return candidates.slice(0, 4);
}

export function truncateGhostLabel(text: string, maxChars = 24): string {
  const clean = text.trim();
  const chars = Array.from(clean);
  if (chars.length <= maxChars) return clean;
  return `${chars.slice(0, maxChars).join('')}…`;
}

export function serializeEventsToMarkdown(title: string, events: SessionEvent[]): string {
  const safeTitle = title?.trim() || 'Antigravity Session';
  const lines: string[] = [`# ${safeTitle}`, '', `Exported: ${new Date().toISOString()}`, ''];

  for (const ev of events) {
    lines.push(`## #${ev.seq} [${ev.kind}] (${ev.status})`);
    const payload = ev.payload || {};

    if (ev.kind === 'user') {
      const text =
        (typeof payload.userResponse === 'string' && payload.userResponse) ||
        (typeof payload.text === 'string' && payload.text) ||
        '';
      if (text) lines.push('', text);
    } else if (ev.kind === 'thinking_and_text') {
      const response =
        (typeof payload.modifiedResponse === 'string' && payload.modifiedResponse) ||
        (typeof payload.response === 'string' && payload.response) ||
        (typeof payload.text === 'string' && payload.text) ||
        '';
      if (typeof payload.thinking === 'string' && payload.thinking) {
        lines.push('', '<details>', '<summary>Thinking</summary>', '', payload.thinking, '', '</details>');
      }
      if (response) lines.push('', response);
    } else if (ev.kind === 'command') {
      const cmd =
        (typeof payload.commandLine === 'string' && payload.commandLine) ||
        (typeof payload.proposedCommandLine === 'string' && payload.proposedCommandLine) ||
        ev.title ||
        '';
      if (cmd) lines.push('', '```bash', `$ ${cmd}`, '```');
      if (typeof payload.combinedOutput === 'string' && payload.combinedOutput) {
        lines.push('', '```text', payload.combinedOutput.slice(0, 4000), '```');
      }
    } else {
      lines.push('', '```json', JSON.stringify(payload, null, 2).slice(0, 4000), '```');
    }
    lines.push('');
  }

  return lines.join('\n');
}
