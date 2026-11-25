import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { ApiError, apiClient } from '../api/client';
import { useI18n, type I18nKey } from '../i18n';
import type {
  DiffFile,
  DiffFileStatus,
  GitDiffResponse,
  GitWorktreeItem,
  SideChatSelectionContext,
} from '../types';
import { formatDockError, truncateSelectionSnippet } from './dockUtils';
import styles from './GitDiffPanel.module.css';

export interface GitDiffPanelProps {
  root: string;
  refreshKey?: number | string;
  onAuthorizeRoot?: (root: string) => Promise<void> | void;
  focusedFile?: { path: string; nonce: number } | null;
  onSelectionChange?: (selection: SideChatSelectionContext | null) => void;
  channel?: string;
  permissionLevel?: string;
  onInsertToComposer?: (text: string) => void;
  onSelectWorkspaceRoot?: (root: string) => void;
  onGitMutated?: () => void;
}

export interface ParsedDiffLine {
  kind: 'meta' | 'hunk' | 'add' | 'del' | 'context';
  text: string;
  lineNo: number | null;
  oldLineNo: number | null;
  newLineNo: number | null;
}

export interface ParsedDiffSection {
  filePath: string;
  headerLines: string[];
  lines: ParsedDiffLine[];
}

interface ActiveLineCommentTarget {
  sectionIdx: number;
  lineIdx: number;
  filePath: string;
  lineNo: number;
  rawText: string;
}

const STATUS_BADGE: Record<DiffFileStatus, { code: string; labelKey: I18nKey }> = {
  modified: { code: 'M', labelKey: 'diff.status.modified' },
  added: { code: 'A', labelKey: 'diff.status.added' },
  deleted: { code: 'D', labelKey: 'diff.status.deleted' },
  renamed: { code: 'R', labelKey: 'diff.status.renamed' },
  untracked: { code: '?', labelKey: 'diff.status.untracked' },
};

function extractPathFromDiffHeader(line: string): string {
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (match) return match[2];
  return line;
}

function classifyDiffLine(line: string): ParsedDiffLine['kind'] {
  if (
    line.startsWith('diff --git ') ||
    line.startsWith('index ') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ') ||
    line.startsWith('new file mode ') ||
    line.startsWith('deleted file mode ') ||
    line.startsWith('similarity index ') ||
    line.startsWith('rename from ') ||
    line.startsWith('rename to ') ||
    line.startsWith('\\ No newline at end of file')
  ) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

export function parseUnifiedDiff(diffText: string): ParsedDiffSection[] {
  if (!diffText.trim()) return [];
  const rawLines = diffText.split(/\r?\n/);
  const sections: ParsedDiffSection[] = [];
  let current: ParsedDiffSection | null = null;
  let oldCursor = 0;
  let newCursor = 0;
  let inHunk = false;
  let fallbackLineNo = 0;

  for (const line of rawLines) {
    if (line.startsWith('diff --git ')) {
      current = {
        filePath: extractPathFromDiffHeader(line),
        headerLines: [line],
        lines: [],
      };
      sections.push(current);
      oldCursor = 0;
      newCursor = 0;
      inHunk = false;
      fallbackLineNo = 0;
      continue;
    }

    if (!current) {
      current = {
        filePath: '',
        headerLines: [],
        lines: [],
      };
      sections.push(current);
    }

    if (line.startsWith('+++ ')) {
      const plusTarget = line.slice(4).trim();
      if (plusTarget && plusTarget !== '/dev/null') {
        current.filePath = plusTarget.startsWith('b/') ? plusTarget.slice(2) : plusTarget;
      }
    }

    const kind = classifyDiffLine(line);
    if (kind === 'hunk') {
      const hunkMatch = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      oldCursor = hunkMatch ? Number.parseInt(hunkMatch[1], 10) : 1;
      newCursor = hunkMatch ? Number.parseInt(hunkMatch[2], 10) : 1;
      inHunk = true;
      current.lines.push({
        kind,
        text: line,
        lineNo: null,
        oldLineNo: null,
        newLineNo: null,
      });
      continue;
    }

    if (kind === 'meta') {
      current.lines.push({
        kind,
        text: line,
        lineNo: null,
        oldLineNo: null,
        newLineNo: null,
      });
      continue;
    }

    if (!inHunk) {
      fallbackLineNo += 1;
      current.lines.push({
        kind,
        text: line,
        lineNo: fallbackLineNo,
        oldLineNo: null,
        newLineNo: fallbackLineNo,
      });
      continue;
    }

    if (kind === 'add') {
      const nextNew = newCursor;
      newCursor += 1;
      current.lines.push({
        kind,
        text: line,
        lineNo: nextNew,
        oldLineNo: null,
        newLineNo: nextNew,
      });
    } else if (kind === 'del') {
      const nextOld = oldCursor;
      oldCursor += 1;
      current.lines.push({
        kind,
        text: line,
        lineNo: nextOld,
        oldLineNo: nextOld,
        newLineNo: null,
      });
    } else {
      const nextOld = oldCursor;
      const nextNew = newCursor;
      oldCursor += 1;
      newCursor += 1;
      current.lines.push({
        kind,
        text: line,
        lineNo: nextNew,
        oldLineNo: nextOld,
        newLineNo: nextNew,
      });
    }
  }

  return sections;
}

export function formatInlineDiffQuote(
  filePath: string,
  lineNo: number,
  rawLineText: string,
  commentText: string,
): string {
  const cleanCode = rawLineText.replace(/^[+-]/, '').trim();
  if (!cleanCode) {
    return `\`${filePath}:${lineNo}\`\n${commentText}`;
  }
  const codeSpan = cleanCode.includes('`') ? `\`\` ${cleanCode} \`\`` : `\`${cleanCode}\``;
  return `\`${filePath}:${lineNo}\`\n> ${codeSpan}\n${commentText}`;
}

export function GitDiffPanel({
  root,
  refreshKey,
  onAuthorizeRoot,
  focusedFile,
  onSelectionChange,
  channel = 'loopback',
  permissionLevel = 'L2',
  onInsertToComposer,
  onSelectWorkspaceRoot,
  onGitMutated,
}: GitDiffPanelProps) {
  const { t } = useI18n();
  const [data, setData] = useState<GitDiffResponse | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktreeItem[]>([]);
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [gitBusy, setGitBusy] = useState<'stage' | 'commit' | 'push' | 'worktree' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  const [commitMsg, setCommitMsg] = useState('');
  const [wtPath, setWtPath] = useState('');
  const [wtBranch, setWtBranch] = useState('');
  const [wtCreateBranch, setWtCreateBranch] = useState(true);

  const [activeComment, setActiveComment] = useState<ActiveLineCommentTarget | null>(null);
  const [commentDraft, setCommentDraft] = useState('');

  const abortRef = useRef<AbortController | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canWriteGit = channel === 'loopback' || permissionLevel === 'L2';
  const isL0CommentLocked = channel !== 'loopback' && permissionLevel === 'L0';
  const canQuoteDiff = Boolean(onInsertToComposer);

  const showTransientNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimerRef.current) {
      clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, 3000);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimerRef.current) {
        clearTimeout(noticeTimerRef.current);
      }
    },
    [],
  );

  const loadDiff = useCallback(async () => {
    abortRef.current?.abort();
    if (!root) {
      setData(null);
      setWorktrees([]);
      setError(null);
      setErrorCode(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setErrorCode(null);

    try {
      const [res, wtRes] = await Promise.all([
        apiClient.getGitDiff({ root }, controller.signal),
        typeof apiClient.getGitWorktrees === 'function'
          ? apiClient
              .getGitWorktrees({ root }, controller.signal)
              .catch(() => ({ ok: true, isGitRepo: false, worktrees: [] }))
          : Promise.resolve({ ok: true, isGitRepo: false, worktrees: [] }),
      ]);
      if (controller.signal.aborted) return;
      setData(res);
      setWorktrees(Array.isArray(wtRes.worktrees) ? wtRes.worktrees : []);
      setSelectedFilePath((prev) =>
        prev && res.files.some((f) => f.path === prev) ? prev : null,
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(formatDockError(err, t('dockErr.requestFailed'), t));
      setErrorCode(err instanceof ApiError ? err.code : null);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [root, t]);

  const handleAuthorizeRoot = useCallback(async () => {
    if (!onAuthorizeRoot || !root || authorizing) return;
    setAuthorizing(true);
    try {
      await onAuthorizeRoot(root);
      await loadDiff();
    } catch (err) {
      setError(formatDockError(err, t('dockErr.requestFailed'), t));
      setErrorCode(err instanceof ApiError ? err.code : null);
    } finally {
      setAuthorizing(false);
    }
  }, [onAuthorizeRoot, root, authorizing, loadDiff, t]);

  useEffect(() => {
    setSelectedFilePath(null);
    setActiveComment(null);
    setCommentDraft('');
  }, [root]);

  useEffect(() => {
    void loadDiff();
    return () => {
      abortRef.current?.abort();
    };
  }, [loadDiff, refreshKey]);

  useEffect(() => {
    const targetRaw = focusedFile?.path?.trim();
    if (!targetRaw || !data?.files || data.files.length === 0) return;
    const normalized = targetRaw.replace(/^file:\/\//i, '').replace(/\/+$/, '');
    const exact = data.files.find((f) => f.path === normalized);
    if (exact) {
      setSelectedFilePath(exact.path);
      return;
    }
    const suffixMatch = data.files.find(
      (f) => normalized.endsWith(`/${f.path}`) || f.path.endsWith(`/${normalized}`),
    );
    if (suffixMatch) {
      setSelectedFilePath(suffixMatch.path);
    }
  }, [focusedFile?.path, focusedFile?.nonce, data?.files]);

  const totals = useMemo(() => {
    const files = data?.files || [];
    let stagedCount = 0;
    let unstagedCount = 0;
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      additions += file.additions || 0;
      deletions += file.deletions || 0;
      if (file.staged) stagedCount += 1;
      if (file.unstaged ?? !file.staged) unstagedCount += 1;
    }
    return { additions, deletions, stagedCount, unstagedCount };
  }, [data]);

  const parsedSections = useMemo(
    () => parseUnifiedDiff(data?.diffText || ''),
    [data?.diffText],
  );

  const visibleSections = useMemo(() => {
    if (!selectedFilePath) return parsedSections;
    return parsedSections.filter(
      (sec) => sec.filePath === selectedFilePath || sec.filePath.endsWith(`/${selectedFilePath}`),
    );
  }, [parsedSections, selectedFilePath]);

  const selectedFileMeta: DiffFile | null = useMemo(() => {
    if (!selectedFilePath || !data?.files) return null;
    return data.files.find((f) => f.path === selectedFilePath) || null;
  }, [selectedFilePath, data]);

  const activeDiffSelection = useMemo<SideChatSelectionContext | null>(() => {
    if (!data || !data.isGitRepo || visibleSections.length === 0) return null;
    const text = visibleSections
      .map((sec) => [...sec.headerLines, ...sec.lines.map((l) => l.text)].join('\n'))
      .join('\n')
      .trim();
    if (!text) return null;
    const targetPath =
      selectedFilePath ||
      visibleSections.find((sec) => sec.filePath)?.filePath ||
      data.files[0]?.path ||
      'git.diff';
    return {
      path: targetPath,
      snippet: truncateSelectionSnippet(text),
      kind: 'diff',
    };
  }, [data, visibleSections, selectedFilePath]);

  const hasEmittedSelectionRef = useRef(false);
  useEffect(() => {
    if (!onSelectionChange) return;
    if (activeDiffSelection) {
      hasEmittedSelectionRef.current = true;
      onSelectionChange(activeDiffSelection);
    } else if (hasEmittedSelectionRef.current) {
      hasEmittedSelectionRef.current = false;
      onSelectionChange(null);
    }
  }, [activeDiffSelection, onSelectionChange]);

  const handleStageFile = useCallback(
    async (file: DiffFile) => {
      if (!canWriteGit || !root || gitBusy) return;
      setGitBusy('stage');
      setError(null);
      try {
        await apiClient.gitStage({
          root,
          paths: [file.path],
          unstage: Boolean(file.staged),
        });
        await loadDiff();
        onGitMutated?.();
      } catch (err) {
        setError(formatDockError(err, t('dockErr.requestFailed'), t));
        setErrorCode(err instanceof ApiError ? err.code : null);
      } finally {
        setGitBusy(null);
      }
    },
    [canWriteGit, root, gitBusy, loadDiff, onGitMutated, t],
  );

  const handleStageAll = useCallback(
    async (unstage: boolean) => {
      if (!canWriteGit || !root || gitBusy) return;
      setGitBusy('stage');
      setError(null);
      try {
        await apiClient.gitStage({ root, all: true, unstage });
        await loadDiff();
        onGitMutated?.();
      } catch (err) {
        setError(formatDockError(err, t('dockErr.requestFailed'), t));
        setErrorCode(err instanceof ApiError ? err.code : null);
      } finally {
        setGitBusy(null);
      }
    },
    [canWriteGit, root, gitBusy, loadDiff, onGitMutated, t],
  );

  const handleCommit = useCallback(async () => {
    const trimmed = commitMsg.trim();
    if (!canWriteGit || !root || !trimmed || totals.stagedCount === 0 || gitBusy) return;
    setGitBusy('commit');
    setError(null);
    try {
      const res = await apiClient.gitCommit({ root, message: trimmed });
      setCommitMsg('');
      const shortSha = res.commitSha ? res.commitSha.slice(0, 7) : 'HEAD';
      showTransientNotice(t('diff.committedNotice', { sha: shortSha }));
      await loadDiff();
      onGitMutated?.();
    } catch (err) {
      setError(formatDockError(err, t('dockErr.requestFailed'), t));
      setErrorCode(err instanceof ApiError ? err.code : null);
    } finally {
      setGitBusy(null);
    }
  }, [canWriteGit, root, commitMsg, totals.stagedCount, gitBusy, showTransientNotice, t, loadDiff, onGitMutated]);

  const handlePush = useCallback(async () => {
    if (!canWriteGit || !root || gitBusy) return;
    setGitBusy('push');
    setError(null);
    try {
      const branchArg = data?.branch && data.branch !== 'HEAD' ? data.branch : undefined;
      await apiClient.gitPush({ root, branch: branchArg, setUpstream: true });
      showTransientNotice(t('diff.pushedNotice'));
      await loadDiff();
      onGitMutated?.();
    } catch (err) {
      setError(formatDockError(err, t('dockErr.requestFailed'), t));
      setErrorCode(err instanceof ApiError ? err.code : null);
    } finally {
      setGitBusy(null);
    }
  }, [canWriteGit, root, gitBusy, data?.branch, showTransientNotice, t, loadDiff, onGitMutated]);

  const handleCreateWorktree = useCallback(async () => {
    const targetPath = wtPath.trim();
    if (!canWriteGit || !root || !targetPath || gitBusy) return;
    const targetBranch = wtBranch.trim();
    setGitBusy('worktree');
    setError(null);
    try {
      const res = await apiClient.gitWorktree({
        root,
        action: 'add',
        path: targetPath,
        branch: targetBranch || undefined,
        createBranch: Boolean(targetBranch && wtCreateBranch),
      });
      setWtPath('');
      setWtBranch('');
      if (Array.isArray(res.worktrees)) {
        setWorktrees(res.worktrees);
      } else {
        await loadDiff();
      }
      showTransientNotice(t('diff.worktreeCreatedNotice'));
      onGitMutated?.();
    } catch (err) {
      setError(formatDockError(err, t('dockErr.requestFailed'), t));
      setErrorCode(err instanceof ApiError ? err.code : null);
    } finally {
      setGitBusy(null);
    }
  }, [canWriteGit, root, wtPath, wtBranch, wtCreateBranch, gitBusy, loadDiff, showTransientNotice, t, onGitMutated]);

  const handleRemoveWorktree = useCallback(
    async (targetPath: string) => {
      if (!canWriteGit || !root || !targetPath || gitBusy) return;
      setGitBusy('worktree');
      setError(null);
      try {
        const res = await apiClient.gitWorktree({
          root,
          action: 'remove',
          path: targetPath,
        });
        if (Array.isArray(res.worktrees)) {
          setWorktrees(res.worktrees);
        } else {
          await loadDiff();
        }
        showTransientNotice(t('diff.worktreeRemovedNotice'));
        onGitMutated?.();
      } catch (err) {
        setError(formatDockError(err, t('dockErr.requestFailed'), t));
        setErrorCode(err instanceof ApiError ? err.code : null);
      } finally {
        setGitBusy(null);
      }
    },
    [canWriteGit, root, gitBusy, loadDiff, showTransientNotice, t, onGitMutated],
  );

  const handlePruneWorktrees = useCallback(async () => {
    if (!canWriteGit || !root || gitBusy) return;
    setGitBusy('worktree');
    setError(null);
    try {
      const res = await apiClient.gitWorktree({ root, action: 'prune' });
      if (Array.isArray(res.worktrees)) {
        setWorktrees(res.worktrees);
      } else {
        await loadDiff();
      }
      showTransientNotice(t('diff.worktreePrunedNotice'));
    } catch (err) {
      setError(formatDockError(err, t('dockErr.requestFailed'), t));
      setErrorCode(err instanceof ApiError ? err.code : null);
    } finally {
      setGitBusy(null);
    }
  }, [canWriteGit, root, gitBusy, loadDiff, showTransientNotice, t]);

  const handleSwitchWorktree = useCallback(
    async (wt: GitWorktreeItem) => {
      if (!onSelectWorkspaceRoot || wt.isCurrent) return;
      if (wt.allowed === false && onAuthorizeRoot) {
        try {
          await onAuthorizeRoot(wt.path);
        } catch (err) {
          setError(formatDockError(err, t('dockErr.requestFailed'), t));
          return;
        }
      }
      onSelectWorkspaceRoot(wt.path);
    },
    [onSelectWorkspaceRoot, onAuthorizeRoot, t],
  );

  const handleToggleLineComment = useCallback(
    (sectionIdx: number, lineIdx: number, filePath: string, line: ParsedDiffLine) => {
      if (!canQuoteDiff || line.lineNo === null || !filePath) return;
      const lineNo = line.lineNo;
      setActiveComment((prev) => {
        if (prev && prev.sectionIdx === sectionIdx && prev.lineIdx === lineIdx) {
          return null;
        }
        setCommentDraft('');
        return {
          sectionIdx,
          lineIdx,
          filePath,
          lineNo,
          rawText: line.text,
        };
      });
    },
    [canQuoteDiff],
  );

  const handleSubmitLineComment = useCallback(() => {
    if (!activeComment || !onInsertToComposer || isL0CommentLocked) return;
    const bodyText = commentDraft.trim() || t('diff.commentDefaultPrompt');
    const quote = formatInlineDiffQuote(
      activeComment.filePath,
      activeComment.lineNo,
      activeComment.rawText,
      bodyText,
    );
    onInsertToComposer(quote);
    setActiveComment(null);
    setCommentDraft('');
    showTransientNotice(t('diff.commentInsertedNotice'));
  }, [activeComment, onInsertToComposer, isL0CommentLocked, commentDraft, t, showTransientNotice]);

  const handleCommentKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLInputElement>) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        setActiveComment(null);
        setCommentDraft('');
        return;
      }
      if (ev.key === 'Enter' && !ev.nativeEvent.isComposing) {
        ev.preventDefault();
        handleSubmitLineComment();
      }
    },
    [handleSubmitLineComment],
  );

  if (!root) {
    return (
      <div className={styles.emptyState} data-testid="git-diff-no-root">
        <div className={styles.emptyTitle}>{t('diff.noRootTitle')}</div>
        <div className={styles.emptyDesc}>{t('diff.noRootDesc')}</div>
      </div>
    );
  }

  const hasPrunableWorktrees = worktrees.some((w) => w.prunable);

  return (
    <div className={styles.panel} data-testid="git-diff-panel">
      <header className={styles.header}>
        <div className={styles.branchGroup}>
          <span className={styles.branchBadge} data-testid="git-branch-name">
            {data?.isGitRepo === false ? t('diff.nonGitBadge') : data?.branch || 'HEAD'}
          </span>
          {data?.isGitRepo && !canWriteGit && (
            <span className={styles.readOnlyBadge} data-testid="git-readonly-badge">
              {t('diff.permReadOnly', { tier: permissionLevel })}
            </span>
          )}
          {data?.isGitRepo && (
            <span className={styles.summaryStats}>
              <span>{t('diff.filesCount', { count: data.files.length })}</span>
              {totals.stagedCount > 0 && (
                <span className={styles.statStaged}>
                  {t('diff.stagedCount', { count: totals.stagedCount })}
                </span>
              )}
              <span className={styles.statAdd}>+{totals.additions}</span>
              <span className={styles.statDel}>-{totals.deletions}</span>
            </span>
          )}
        </div>

        <div className={styles.headerActions}>
          {data?.isGitRepo && (
            <button
              type="button"
              className={`${styles.refreshBtn} ${worktreesOpen ? styles.actionBtnActive : ''}`}
              onClick={() => setWorktreesOpen((v) => !v)}
              aria-expanded={worktreesOpen}
              data-testid="git-worktrees-toggle-btn"
            >
              {t('diff.worktreesBtn', { count: worktrees.length || 1 })}
            </button>
          )}
          {data?.isGitRepo && canWriteGit && (
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => void handlePush()}
              disabled={loading || gitBusy !== null}
              data-testid="git-push-btn"
            >
              {gitBusy === 'push' ? t('diff.pushing') : t('diff.pushBtn')}
            </button>
          )}
          <button
            type="button"
            className={styles.refreshBtn}
            onClick={() => void loadDiff()}
            disabled={loading || gitBusy !== null}
            data-testid="git-refresh-btn"
          >
            {loading ? t('common.refreshing') : t('common.refresh')}
          </button>
        </div>
      </header>

      {notice && (
        <div className={styles.noticeBanner} role="status" data-testid="git-action-notice">
          <span>{notice}</span>
        </div>
      )}

      {error && (
        <div className={styles.errorBanner} role="alert" data-testid="git-diff-error">
          <span>{error}</span>
          <div className={styles.bannerActions}>
            {errorCode === 'PATH_OUTSIDE_WORKSPACE' && onAuthorizeRoot && root ? (
              <button
                type="button"
                className={styles.retryBtn}
                onClick={() => void handleAuthorizeRoot()}
                disabled={authorizing}
                data-testid="dock-authorize-root-btn"
              >
                {authorizing ? t('dock.authorizingRoot') : t('dock.authorizeRoot')}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.retryBtn}
              onClick={() => void loadDiff()}
              disabled={authorizing}
            >
              {t('common.retry')}
            </button>
          </div>
        </div>
      )}

      {data?.isGitRepo && worktreesOpen && (
        <section className={styles.worktreesSection} data-testid="git-worktrees-panel">
          <div className={styles.subHeader}>
            <span>{t('diff.worktreesTitle', { count: worktrees.length })}</span>
            {canWriteGit && hasPrunableWorktrees && (
              <button
                type="button"
                className={styles.clearFilterBtn}
                onClick={() => void handlePruneWorktrees()}
                disabled={gitBusy !== null}
                data-testid="git-worktree-prune-btn"
              >
                {t('diff.worktreePrune')}
              </button>
            )}
          </div>

          <div className={styles.worktreeList}>
            {worktrees.map((wt) => {
              const shortHead = wt.head ? wt.head.slice(0, 7) : '';
              const branchLabel = wt.branch || (wt.detached ? t('diff.worktreeDetached') : shortHead || 'HEAD');
              return (
                <div
                  key={wt.path}
                  className={`${styles.worktreeRow} ${wt.isCurrent ? styles.worktreeRowCurrent : ''}`}
                  data-testid={`git-worktree-row-${wt.path}`}
                >
                  <div className={styles.worktreeMeta}>
                    <span className={styles.worktreeBranch}>{branchLabel}</span>
                    <span className={styles.worktreePath} title={wt.path}>
                      {wt.path}
                    </span>
                  </div>
                  <div className={styles.worktreeRowActions}>
                    {wt.isCurrent ? (
                      <span className={styles.currentBadge}>{t('diff.worktreeCurrent')}</span>
                    ) : (
                      <>
                        {onSelectWorkspaceRoot && !wt.bare && (
                          <button
                            type="button"
                            className={styles.miniActionBtn}
                            onClick={() => void handleSwitchWorktree(wt)}
                            disabled={gitBusy !== null}
                            data-testid={`git-worktree-switch-${wt.path}`}
                          >
                            {t('diff.worktreeSwitch')}
                          </button>
                        )}
                        {canWriteGit && !wt.bare && (
                          <button
                            type="button"
                            className={`${styles.miniActionBtn} ${styles.miniDangerBtn}`}
                            onClick={() => void handleRemoveWorktree(wt.path)}
                            disabled={gitBusy !== null}
                            data-testid={`git-worktree-remove-${wt.path}`}
                          >
                            {t('diff.worktreeRemove')}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {canWriteGit && (
            <div className={styles.worktreeForm}>
              <input
                type="text"
                className={styles.compactInput}
                placeholder={t('diff.worktreePathPlaceholder')}
                value={wtPath}
                onChange={(ev) => setWtPath(ev.target.value)}
                disabled={gitBusy !== null}
                data-testid="git-worktree-path-input"
              />
              <input
                type="text"
                className={`${styles.compactInput} ${styles.branchInput}`}
                placeholder={t('diff.worktreeBranchPlaceholder')}
                value={wtBranch}
                onChange={(ev) => setWtBranch(ev.target.value)}
                disabled={gitBusy !== null}
                data-testid="git-worktree-branch-input"
              />
              <label className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={wtCreateBranch}
                  onChange={(ev) => setWtCreateBranch(ev.target.checked)}
                  disabled={gitBusy !== null || !wtBranch.trim()}
                  data-testid="git-worktree-new-branch-checkbox"
                />
                <span>{t('diff.worktreeCreateBranch')}</span>
              </label>
              <button
                type="button"
                className={styles.miniActionBtn}
                onClick={() => void handleCreateWorktree()}
                disabled={gitBusy !== null || !wtPath.trim()}
                data-testid="git-worktree-create-btn"
              >
                {t('diff.worktreeCreateBtn')}
              </button>
            </div>
          )}
        </section>
      )}

      {!error && loading && !data ? (
        <div className={styles.mutedPlaceholder}>{t('diff.loading')}</div>
      ) : null}

      {!error && data && data.isGitRepo === false && (
        <div className={styles.emptyState} data-testid="git-non-repo-state">
          <div className={styles.emptyIcon} aria-hidden="true">
            ⎇
          </div>
          <div className={styles.emptyTitle}>{t('diff.nonGitTitle')}</div>
          <div className={styles.emptyDesc}>
            <code className={styles.inlineCode}>{root}</code> · {t('diff.nonGitDesc', { root })}
          </div>
        </div>
      )}

      {!error && data && data.isGitRepo && data.files.length === 0 && !data.diffText.trim() && (
        <div className={styles.emptyState} data-testid="git-clean-state">
          <div className={styles.emptyTitle}>{t('diff.cleanTitle')}</div>
          <div className={styles.emptyDesc}>{t('diff.cleanDesc', { branch: data.branch || 'HEAD' })}</div>
        </div>
      )}

      {!error && data && data.isGitRepo && (data.files.length > 0 || Boolean(data.diffText.trim())) && (
        <div className={styles.contentSplit}>
          <div className={styles.filesListSection} data-testid="git-changed-files">
            <div className={styles.subHeader}>
              <span>{t('diff.changedFiles', { count: data.files.length })}</span>
              <div className={styles.subHeaderActions}>
                {canWriteGit && totals.unstagedCount > 0 && (
                  <button
                    type="button"
                    className={styles.clearFilterBtn}
                    onClick={() => void handleStageAll(false)}
                    disabled={gitBusy !== null}
                    data-testid="git-stage-all-btn"
                  >
                    {t('diff.stageAll')}
                  </button>
                )}
                {canWriteGit && totals.stagedCount > 0 && (
                  <button
                    type="button"
                    className={styles.clearFilterBtn}
                    onClick={() => void handleStageAll(true)}
                    disabled={gitBusy !== null}
                    data-testid="git-unstage-all-btn"
                  >
                    {t('diff.unstageAll')}
                  </button>
                )}
                {selectedFilePath && (
                  <button
                    type="button"
                    className={styles.clearFilterBtn}
                    onClick={() => setSelectedFilePath(null)}
                  >
                    {t('diff.viewAll')}
                  </button>
                )}
              </div>
            </div>

            <div className={styles.filesList}>
              {data.files.map((file) => {
                const badge = STATUS_BADGE[file.status] || STATUS_BADGE.modified;
                const active = selectedFilePath === file.path;
                const isStaged = Boolean(file.staged);
                return (
                  <div
                    key={file.path}
                    className={`${styles.fileRowWrap} ${active ? styles.fileRowActive : ''}`}
                  >
                    <button
                      type="button"
                      className={styles.fileRow}
                      onClick={() => setSelectedFilePath(active ? null : file.path)}
                      title={`${t(badge.labelKey)}: ${file.path}`}
                      data-testid={`git-file-${file.path}`}
                    >
                      <span className={`${styles.statusBadge} ${styles[`status_${file.status}`]}`}>
                        {badge.code}
                      </span>
                      <span className={styles.filePath}>{file.path}</span>
                      {isStaged && (
                        <span className={styles.stagedPill} title={t('diff.stagedBadge')}>
                          S
                        </span>
                      )}
                      <span className={styles.fileDelta}>
                        {file.additions > 0 && <span className={styles.statAdd}>+{file.additions}</span>}
                        {file.deletions > 0 && <span className={styles.statDel}>-{file.deletions}</span>}
                      </span>
                    </button>
                    {canWriteGit && (
                      <button
                        type="button"
                        className={`${styles.miniActionBtn} ${isStaged ? styles.miniActionActive : ''}`}
                        onClick={() => void handleStageFile(file)}
                        disabled={gitBusy !== null}
                        data-testid={`git-stage-file-${file.path}`}
                      >
                        {isStaged ? t('diff.unstage') : t('diff.stage')}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {canWriteGit && data.files.length > 0 && (
              <div className={styles.commitBar} data-testid="git-commit-bar">
                <input
                  type="text"
                  className={styles.compactInput}
                  placeholder={
                    totals.stagedCount > 0
                      ? t('diff.commitPlaceholder')
                      : t('diff.commitNeedStaged')
                  }
                  value={commitMsg}
                  onChange={(ev) => setCommitMsg(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' && !ev.nativeEvent.isComposing) {
                      ev.preventDefault();
                      void handleCommit();
                    }
                  }}
                  disabled={gitBusy !== null}
                  data-testid="git-commit-input"
                />
                <button
                  type="button"
                  className={styles.primaryBtn}
                  onClick={() => void handleCommit()}
                  disabled={gitBusy !== null || totals.stagedCount === 0 || !commitMsg.trim()}
                  data-testid="git-commit-btn"
                >
                  {gitBusy === 'commit' ? t('diff.committing') : t('diff.commitBtn')}
                </button>
              </div>
            )}
          </div>

          <div className={styles.diffViewerSection} data-testid="git-diff-viewer">
            {canQuoteDiff && visibleSections.length > 0 && (
              <div className={styles.quoteHintBar}>{t('diff.commentHint')}</div>
            )}
            {visibleSections.length === 0 ? (
              <div className={styles.mutedPlaceholder}>
                {selectedFileMeta?.status === 'untracked'
                  ? t('diff.untrackedHint', { path: selectedFileMeta.path })
                  : t('diff.noTextDiff')}
              </div>
            ) : (
              visibleSections.map((section, idx) => (
                <div key={`${section.filePath || 'diff'}-${idx}`} className={styles.diffSection}>
                  {section.filePath && (
                    <div className={styles.diffSectionHeader}>{section.filePath}</div>
                  )}
                  <div className={styles.diffLines}>
                    {section.lines.map((line, lineIdx) => {
                      const clickable =
                        canQuoteDiff &&
                        Boolean(section.filePath) &&
                        line.lineNo !== null &&
                        (line.kind === 'add' || line.kind === 'del' || line.kind === 'context');
                      const isCommenting =
                        activeComment !== null &&
                        activeComment.sectionIdx === idx &&
                        activeComment.lineIdx === lineIdx;
                      return (
                        <Fragment key={lineIdx}>
                          <div
                            role={clickable ? 'button' : undefined}
                            tabIndex={clickable ? 0 : undefined}
                            data-diff-line={clickable ? '1' : undefined}
                            data-testid={
                              clickable
                                ? `diff-line-${section.filePath}-${line.kind}-${line.lineNo}`
                                : undefined
                            }
                            onClick={
                              clickable
                                ? () =>
                                    handleToggleLineComment(idx, lineIdx, section.filePath, line)
                                : undefined
                            }
                            onKeyDown={
                              clickable
                                ? (ev) => {
                                    if (ev.key === 'Enter' || ev.key === ' ') {
                                      ev.preventDefault();
                                      handleToggleLineComment(idx, lineIdx, section.filePath, line);
                                    }
                                  }
                                : undefined
                            }
                            className={`${styles.diffLine} ${styles[`diffLine_${line.kind}`]} ${
                              clickable ? styles.diffLineClickable : ''
                            } ${isCommenting ? styles.diffLineSelected : ''}`}
                          >
                            <span className={styles.diffLineNum}>
                              {clickable && <span className={styles.commentPlusIcon}>+</span>}
                              <span>{line.lineNo ?? '··'}</span>
                            </span>
                            <span className={styles.diffLineText}>{line.text || ' '}</span>
                          </div>

                          {isCommenting && activeComment && (
                            <div
                              className={styles.inlineCommentBox}
                              data-testid="diff-inline-comment-box"
                            >
                              <div className={styles.inlineCommentHead}>
                                <span className={styles.inlineCommentTarget}>
                                  {t('diff.commentTarget', {
                                    file: activeComment.filePath,
                                    line: activeComment.lineNo,
                                  })}
                                </span>
                                <button
                                  type="button"
                                  className={styles.miniActionBtn}
                                  onClick={() => {
                                    setActiveComment(null);
                                    setCommentDraft('');
                                  }}
                                  data-testid="diff-inline-comment-cancel"
                                >
                                  {t('common.cancel')}
                                </button>
                              </div>
                              {isL0CommentLocked ? (
                                <div className={styles.inlineCommentLocked}>
                                  {t('diff.commentL0Disabled')}
                                </div>
                              ) : (
                                <div className={styles.inlineCommentRow}>
                                  <input
                                    type="text"
                                    className={styles.compactInput}
                                    placeholder={t('diff.commentPlaceholder')}
                                    value={commentDraft}
                                    onChange={(ev) => setCommentDraft(ev.target.value)}
                                    onKeyDown={handleCommentKeyDown}
                                    autoFocus
                                    data-testid="diff-inline-comment-input"
                                  />
                                  <button
                                    type="button"
                                    className={styles.primaryBtn}
                                    onClick={handleSubmitLineComment}
                                    data-testid="diff-inline-comment-submit"
                                  >
                                    {t('diff.commentSubmit')}
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
