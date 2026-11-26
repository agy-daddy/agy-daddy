import type { CodeActionPayload, SessionEvent } from '../types';

export interface CodeActionDiffStats {
  additions: number | null;
  deletions: number | null;
}

export interface CodeActionDiffLine {
  kind: 'add' | 'del' | 'context' | 'hunk';
  text: string;
}

export interface SessionEditedFileSummary {
  path: string;
  basename: string;
  additions: number;
  deletions: number;
  editCount: number;
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function pickCleanPathString(val: unknown): string {
  if (typeof val !== 'string') return '';
  const trimmed = val.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower === 'code action' || lower === 'code' || lower === 'edit') return '';
  return trimmed.replace(/^file:\/\//i, '');
}

function extractNumericStat(
  stats: Record<string, unknown> | null | undefined,
  keys: string[]
): number | null {
  if (!stats) return null;
  for (const key of keys) {
    const val = stats[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
  }
  return null;
}

export function extractCodeActionTargetFile(
  payload: CodeActionPayload | Record<string, unknown> | null | undefined,
  fallbackTitle?: string
): string {
  const p = asRecord(payload);
  const spec = asRecord(p?.actionSpec);
  const specFile = asRecord(spec?.file);
  const specCmd = asRecord(spec?.command);
  const specCmdFile = asRecord(specCmd?.file);
  const res = asRecord(p?.actionResult);
  const resInner = asRecord(res?.result);
  const resEdit = asRecord(res?.edit);
  const resEditFile = asRecord(resEdit?.file);
  const resDiff = asRecord(resEdit?.diff) || asRecord(resInner?.diff) || asRecord(res?.diff);

  const candidates = [
    spec?.targetFile,
    spec?.filePath,
    spec?.absolutePathUri,
    spec?.path,
    specFile?.absoluteUri,
    specFile?.path,
    specCmd?.targetFile,
    specCmd?.TargetFile,
    specCmd?.filePath,
    specCmd?.absolutePathUri,
    specCmdFile?.absoluteUri,
    specCmdFile?.path,
    resEditFile?.absoluteUri,
    resEditFile?.path,
    resDiff?.path,
    resDiff?.targetFile,
    res?.filePath,
    res?.targetFile,
    p?.targetFile,
    p?.filePath,
    fallbackTitle
  ];

  for (const candidate of candidates) {
    const cleaned = pickCleanPathString(candidate);
    if (cleaned) return cleaned;
  }
  return '';
}

function findStructuredDiffLines(
  payload: CodeActionPayload | Record<string, unknown> | null | undefined
): Array<Record<string, unknown>> {
  const p = asRecord(payload);
  if (!p) return [];
  const res = asRecord(p.actionResult);
  const resInner = asRecord(res?.result);
  const resEdit = asRecord(res?.edit);
  const resDiff =
    asRecord(resEdit?.diff) || asRecord(resInner?.diff) || asRecord(res?.diff) || asRecord(p.diff);
  const unifiedDiff =
    asRecord(resDiff?.unifiedDiff) || asRecord(res?.unifiedDiff) || asRecord(p.unifiedDiff);

  if (Array.isArray(unifiedDiff?.lines)) {
    return unifiedDiff.lines.filter((line): line is Record<string, unknown> =>
      Boolean(asRecord(line))
    );
  }

  const spec = asRecord(p.actionSpec);
  const specDiff = asRecord(spec?.unifiedDiff);
  if (Array.isArray(specDiff?.lines)) {
    return specDiff.lines.filter((line): line is Record<string, unknown> =>
      Boolean(asRecord(line))
    );
  }

  return [];
}

export function extractCodeActionDiffLines(
  payload: CodeActionPayload | Record<string, unknown> | null | undefined,
  maxLines = 80
): CodeActionDiffLine[] {
  const rawLines = findStructuredDiffLines(payload);
  if (rawLines.length > 0) {
    const out: CodeActionDiffLine[] = [];
    for (const item of rawLines) {
      const rawType = String(item.type || item.lineType || '').toUpperCase();
      const text =
        typeof item.text === 'string'
          ? item.text
          : typeof item.content === 'string'
            ? item.content
            : '';
      let kind: CodeActionDiffLine['kind'] = 'context';
      if (rawType.includes('ADDED') || rawType.includes('ADD') || rawType.includes('INSERT')) {
        kind = 'add';
      } else if (rawType.includes('REMOVED') || rawType.includes('DEL')) {
        kind = 'del';
      } else if (rawType.includes('HUNK')) {
        kind = 'hunk';
      }
      out.push({ kind, text });
      if (out.length >= maxLines) break;
    }
    return out;
  }

  const p = asRecord(payload);
  const res = asRecord(p?.actionResult);
  const resInner = asRecord(res?.result);
  const rawPatch =
    (typeof resInner?.diffText === 'string' && resInner.diffText) ||
    (typeof res?.diffText === 'string' && res.diffText) ||
    (typeof p?.diffText === 'string' && p.diffText) ||
    '';

  if (!rawPatch.trim()) return [];
  const lines = rawPatch.split(/\r?\n/).slice(0, maxLines);
  return lines.map((line) => {
    if (line.startsWith('@@')) return { kind: 'hunk', text: line };
    if (line.startsWith('+') && !line.startsWith('+++')) return { kind: 'add', text: line.slice(1) };
    if (line.startsWith('-') && !line.startsWith('---')) return { kind: 'del', text: line.slice(1) };
    return { kind: 'context', text: line };
  });
}

export function extractCodeActionDiffStats(
  payload: CodeActionPayload | Record<string, unknown> | null | undefined
): CodeActionDiffStats {
  const p = asRecord(payload);
  const diffStats = asRecord(p?.diffStats);
  const additions = extractNumericStat(diffStats, ['additions', 'linesAdded', 'added']);
  const deletions = extractNumericStat(diffStats, ['deletions', 'linesRemoved', 'removed']);
  if (additions !== null || deletions !== null) {
    return { additions, deletions };
  }

  const lines = findStructuredDiffLines(p);
  if (lines.length === 0) return { additions: null, deletions: null };
  let addCount = 0;
  let delCount = 0;
  for (const line of lines) {
    const t = String(line.type || line.lineType || '').toUpperCase();
    if (t.includes('ADDED') || t.includes('ADD') || t.includes('INSERT')) addCount += 1;
    else if (t.includes('REMOVED') || t.includes('DEL')) delCount += 1;
  }
  return addCount > 0 || delCount > 0
    ? { additions: addCount, deletions: delCount }
    : { additions: null, deletions: null };
}

export function getFileBasename(filePath: string): string {
  const cleaned = filePath.replace(/^file:\/\//i, '').replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : cleaned;
}

export function collectSessionEditedFiles(
  events: readonly SessionEvent[]
): SessionEditedFileSummary[] {
  const byPath = new Map<string, SessionEditedFileSummary>();
  for (const ev of events) {
    if (ev.kind !== 'code_action') continue;
    const p = ev.payload as CodeActionPayload;
    const filePath = extractCodeActionTargetFile(p, ev.title);
    if (!filePath) continue;
    const stats = extractCodeActionDiffStats(p);
    const existing = byPath.get(filePath);
    if (existing) {
      existing.additions += stats.additions ?? 0;
      existing.deletions += stats.deletions ?? 0;
      existing.editCount += 1;
    } else {
      byPath.set(filePath, {
        path: filePath,
        basename: getFileBasename(filePath),
        additions: stats.additions ?? 0,
        deletions: stats.deletions ?? 0,
        editCount: 1
      });
    }
  }
  return Array.from(byPath.values());
}
