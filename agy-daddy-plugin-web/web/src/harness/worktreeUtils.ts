import type { ProjectItem, SessionSummary, WorktreeDto } from '../types';

/**
 * Normalizes a local filesystem path or `file://` URI for client-side comparison.
 */
export function normalizeClientPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s) return '';

  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\//i, '');
    if (/^localhost\//i.test(s)) {
      s = s.slice('localhost'.length);
    }
    if (/^\/[A-Za-z]:[\\/]/.test(s)) {
      s = s.slice(1);
    }
    if (/%[0-9A-Fa-f]{2}/.test(s)) {
      try {
        s = decodeURIComponent(s);
      } catch {
        // Keep raw if malformed percent-encoding
      }
    }
  }

  s = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) {
    s = s.replace(/\/+$/, '');
  }
  return s;
}

/**
 * Generates a platform-tolerant comparison key (case-insensitive for Windows drive paths).
 */
export function toClientCompareKey(raw: string | null | undefined): string {
  const norm = normalizeClientPath(raw);
  if (!norm) return '';
  if (/^[A-Za-z]:/.test(norm)) {
    return norm.toLowerCase();
  }
  if (typeof navigator !== 'undefined' && /mac|win/i.test(navigator.platform || '')) {
    return norm.toLowerCase();
  }
  return norm;
}

export function isSameOrInsideClientPath(
  targetRaw: string | null | undefined,
  baseRaw: string | null | undefined,
): boolean {
  const target = toClientCompareKey(targetRaw);
  const base = toClientCompareKey(baseRaw);
  if (!target || !base) return false;
  if (target === base) return true;
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return target.startsWith(prefix);
}

/**
 * Matches a path against known Worktrees using longest-prefix-first matching
 * so nested worktrees (e.g. `<repo>/.worktrees/wt-inner`) never fall into the parent repo.
 */
export function matchWorktreeByLongestPrefix(
  rawPath: string | null | undefined,
  worktrees: ReadonlyArray<WorktreeDto>,
): WorktreeDto | null {
  const targetKey = toClientCompareKey(rawPath);
  if (!targetKey || worktrees.length === 0) return null;

  const sorted = [...worktrees].sort((a, b) => {
    const ka = toClientCompareKey(a.path);
    const kb = toClientCompareKey(b.path);
    if (kb.length !== ka.length) return kb.length - ka.length;
    return ka.localeCompare(kb);
  });

  for (const wt of sorted) {
    const wtKey = toClientCompareKey(wt.path);
    if (!wtKey) continue;
    const prefix = wtKey.endsWith('/') ? wtKey : `${wtKey}/`;
    if (targetKey === wtKey || targetKey.startsWith(prefix)) {
      return wt;
    }
  }
  return null;
}

/**
 * Resolves which Worktree a session belongs to inside a multi-worktree project.
 */
export function resolveSessionWorktree(
  session: SessionSummary,
  worktrees: ReadonlyArray<WorktreeDto>,
): WorktreeDto | null {
  if (worktrees.length === 0) return null;
  if (session.worktreeId) {
    const byId = worktrees.find((w) => w.worktreeId === session.worktreeId);
    if (byId) return byId;
  }

  const candidatePaths: Array<string | null | undefined> = [
    session.worktreePath,
    session.workspacePath,
    session.workspaceUri,
    session.gitRootUri,
  ];
  if (Array.isArray(session.workspaces)) {
    for (const ws of session.workspaces) {
      candidatePaths.push(
        ws.workspaceFolderAbsoluteUri,
        ws.workspaceUri,
        ws.gitRootAbsoluteUri,
        ws.gitRootUri,
      );
    }
  }

  for (const cand of candidatePaths) {
    if (!cand) continue;
    const matched = matchWorktreeByLongestPrefix(cand, worktrees);
    if (matched) return matched;
  }
  return null;
}

/**
 * Picks the default writable Worktree for a project's top-level `+` quick-create button.
 */
export function pickDefaultWorktreeForProject(project: ProjectItem): WorktreeDto | null {
  const wts = project.worktrees;
  if (!project.isMultiWorktree || !Array.isArray(wts) || wts.length === 0) {
    return null;
  }
  return (
    wts.find((w) => w.isMain && !w.bare && w.exists && !w.prunable && w.status !== 'missing') ||
    wts.find((w) => !w.bare && w.exists && !w.prunable && w.status !== 'missing') ||
    wts.find((w) => !w.bare) ||
    wts[0] ||
    null
  );
}

/**
 * Suggests a sibling directory path (`<repoParent>/<repoName>-<branchSlug>`) when creating a new Worktree.
 */
export function suggestSiblingWorktreePath(repoRootPath: string, branch: string): string {
  const cleanRoot = normalizeClientPath(repoRootPath);
  const cleanBranch = branch
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!cleanRoot) return cleanBranch ? `../wt-${cleanBranch}` : '';
  const idx = cleanRoot.lastIndexOf('/');
  const parent = idx > 0 ? cleanRoot.slice(0, idx) : '';
  const base = idx >= 0 ? cleanRoot.slice(idx + 1) : cleanRoot;
  const suffix = cleanBranch || 'wt';
  return parent ? `${parent}/${base}-${suffix}` : `${base}-${suffix}`;
}
