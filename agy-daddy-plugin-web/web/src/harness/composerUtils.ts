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
  { id: 'git-force-push', label: 'git push --force', pattern: /\bgit\s+push\b[^\n]*(\s-f\b|--force)/i },
  { id: 'git-checkout', label: 'git checkout --', pattern: /\bgit\s+checkout\s+--\s/i },
  { id: 'disk-format', label: 'sudo/mkfs/dd', pattern: /\b(mkfs|dd\s+if=|sudo\s+rm)\b/i },
  { id: 'kill-9', label: 'kill -9', pattern: /\bkill\s+-9\b/i },
  {
    id: 'sql-drop',
    label: 'SQL DROP/TRUNCATE/DELETE',
    pattern: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*(;|$))/i,
  },
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
  { id: 'plan', label: '/plan', template: '/plan ', category: 'workflow', builtin: true },
  { id: 'goal', label: '/goal', template: '/goal ', category: 'workflow', builtin: true },
  { id: 'grill-me', label: '/grill-me', template: '/grill-me ', category: 'review', builtin: true },
  { id: 'btw', label: '/btw', template: '/btw ', category: 'context', builtin: true },
  { id: 'learn', label: '/learn', template: '/learn ', category: 'memory', builtin: true },
  { id: 'boost', label: '/boost', template: '/boost ', category: 'workflow', builtin: true },
  { id: 'swarm', label: '/swarm', template: '/swarm ', category: 'workflow', builtin: true },
];

export interface RawHostQuickPrompt {
  id?: string;
  label?: string;
  labelEn?: string;
  template?: string;
  text?: string;
  slash?: string;
  category?: string;
  group?: string;
  builtin?: boolean;
  enabled?: boolean;
}

export function resolveQuickPrompts(
  composerState?: ComposerStateResponse | null,
  locale = 'en',
): ComposerQuickPrompt[] {
  const rawList: RawHostQuickPrompt[] = [];
  if (composerState?.quickPrompts && composerState.quickPrompts.length > 0) {
    rawList.push(...composerState.quickPrompts);
  } else if (composerState) {
    const legacy = composerState as ComposerStateResponse & {
      builtins?: RawHostQuickPrompt[];
      custom?: RawHostQuickPrompt[];
    };
    if (Array.isArray(legacy.builtins)) rawList.push(...legacy.builtins);
    if (Array.isArray(legacy.custom)) rawList.push(...legacy.custom);
  }

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
      item.template ?? item.text ?? (item.slash ? `/${item.slash} ` : ''),
    );
    if (!id || !template.trim() || seen.has(id)) continue;
    seen.add(id);
    const label = isZh
      ? String(item.label || item.labelEn || id).trim()
      : String(item.labelEn || item.label || id).trim();
    resolved.push({
      id,
      label,
      template,
      category: item.category || item.group,
      builtin: item.builtin,
    });
  }

  return resolved.length > 0 ? resolved : DEFAULT_QUICK_PROMPTS;
}

export function getGhostSuggestions(options: {
  text: string;
  composerState?: ComposerStateResponse | null;
  quickPrompts?: ComposerQuickPrompt[];
  contextUsagePct?: number | null;
  autoCompactThreshold?: number;
}): string[] {
  const {
    text,
    composerState,
    quickPrompts = DEFAULT_QUICK_PROMPTS,
    contextUsagePct = null,
    autoCompactThreshold = 80,
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
    return candidates.slice(0, 6);
  }

  if (trimmed.length > 0) {
    return [];
  }

  if (typeof contextUsagePct === 'number' && contextUsagePct >= autoCompactThreshold) {
    addCandidate('/compact');
  }

  const frequent = composerState?.frequentPrompts;
  if (Array.isArray(frequent)) {
    for (const entry of frequent) {
      if (typeof entry === 'string') {
        addCandidate(entry);
      } else if (entry && typeof entry === 'object') {
        const obj = entry as RawHostQuickPrompt;
        addCandidate(String(obj.template ?? obj.text ?? obj.label ?? ''));
      }
    }
  }

  for (const item of quickPrompts) {
    const cmd = item.template.trim();
    if (cmd.startsWith('/')) {
      addCandidate(cmd);
    }
  }

  return candidates.slice(0, 6);
}

const SHORTCUT_KEY_ALIAS: Record<string, string> = {
  SPACE: 'SPACE',
  ' ': 'SPACE',
  ENTER: 'ENTER',
  RETURN: 'ENTER',
  TAB: 'TAB',
  ESC: 'ESCAPE',
  ESCAPE: 'ESCAPE',
  SLASH: '/',
};

function normalizeShortcutKey(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return SHORTCUT_KEY_ALIAS[upper] || upper;
}

export function matchesShortcutEvent(
  event: {
    key?: string;
    code?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  },
  shortcutSpec: string,
): boolean {
  const raw = String(shortcutSpec || '').trim();
  if (!raw) return false;
  const parts = raw
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return false;

  let ctrl = false;
  let meta = false;
  let mod = false;
  let alt = false;
  let shift = false;
  let targetKey = '';

  for (const part of parts) {
    const low = part.toLowerCase();
    if (low === 'ctrl' || low === 'control') ctrl = true;
    else if (low === 'cmd' || low === 'meta' || low === 'command' || low === 'super') meta = true;
    else if (low === 'mod' || low === 'cmdorctrl') mod = true;
    else if (low === 'alt' || low === 'option' || low === 'opt') alt = true;
    else if (low === 'shift') shift = true;
    else if (!targetKey) targetKey = normalizeShortcutKey(part);
    else return false;
  }

  if (!targetKey) return false;

  const evCtrl = Boolean(event.ctrlKey);
  const evMeta = Boolean(event.metaKey);
  if (mod) {
    if (!evCtrl && !evMeta) return false;
  } else {
    if (evCtrl !== ctrl || evMeta !== meta) return false;
  }
  if (Boolean(event.altKey) !== alt) return false;
  if (Boolean(event.shiftKey) !== shift) return false;

  const code = String(event.code || '');
  let codeKey = '';
  if (/^Key([A-Z])$/.test(code)) codeKey = code.slice(3);
  else if (/^Digit([0-9])$/.test(code)) codeKey = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code)) codeKey = code;

  const rawKey = normalizeShortcutKey(String(event.key || ''));
  return codeKey === targetKey || rawKey === targetKey;
}

export function isOptimizerShortcut(
  event: {
    key?: string;
    code?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
  },
  configuredShortcut?: string,
): boolean {
  if (matchesShortcutEvent(event, 'Mod+Shift+O')) return true;
  if (configuredShortcut && configuredShortcut.trim()) {
    return matchesShortcutEvent(event, configuredShortcut);
  }
  return false;
}

export function truncateGhostLabel(text: string, maxChars = 28): string {
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
      if (text) {
        lines.push('', text);
      }
    } else if (ev.kind === 'thinking_and_text') {
      const response =
        (typeof payload.modifiedResponse === 'string' && payload.modifiedResponse) ||
        (typeof payload.response === 'string' && payload.response) ||
        (typeof payload.text === 'string' && payload.text) ||
        '';
      if (typeof payload.thinking === 'string' && payload.thinking) {
        lines.push('', '<details>', '<summary>Thinking</summary>', '', payload.thinking, '', '</details>');
      }
      if (response) {
        lines.push('', response);
      }
    } else if (ev.kind === 'command') {
      const cmd =
        (typeof payload.commandLine === 'string' && payload.commandLine) ||
        (typeof payload.proposedCommandLine === 'string' && payload.proposedCommandLine) ||
        ev.title ||
        '';
      if (cmd) {
        lines.push('', '```bash', `$ ${cmd}`, '```');
      }
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
