import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiClient } from '../api/client';
import { useI18n, type I18nKey } from '../i18n';
import type { DiffFile, DiffFileStatus, GitDiffResponse, SideChatSelectionContext } from '../types';
import { formatDockError, truncateSelectionSnippet } from './dockUtils';
import styles from './GitDiffPanel.module.css';

export interface GitDiffPanelProps {
  root: string;
  refreshKey?: number | string;
  onAuthorizeRoot?: (root: string) => Promise<void> | void;
  focusedFile?: { path: string; nonce: number } | null;
  onSelectionChange?: (selection: SideChatSelectionContext | null) => void;
}

interface ParsedDiffLine {
  kind: 'meta' | 'hunk' | 'add' | 'del' | 'context';
  text: string;
  lineNo: number;
}

interface ParsedDiffSection {
  filePath: string;
  headerLines: string[];
  lines: ParsedDiffLine[];
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
    line.startsWith('rename to ')
  ) {
    return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}

function parseUnifiedDiff(diffText: string): ParsedDiffSection[] {
  if (!diffText.trim()) return [];
  const rawLines = diffText.split(/\r?\n/);
  const sections: ParsedDiffSection[] = [];
  let current: ParsedDiffSection | null = null;
  let lineNo = 0;

  for (const line of rawLines) {
    if (line.startsWith('diff --git ')) {
      current = {
        filePath: extractPathFromDiffHeader(line),
        headerLines: [line],
        lines: [],
      };
      sections.push(current);
      lineNo = 0;
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

    lineNo += 1;
    current.lines.push({
      kind: classifyDiffLine(line),
      text: line,
      lineNo,
    });
  }

  return sections;
}

export function GitDiffPanel({
  root,
  refreshKey,
  onAuthorizeRoot,
  focusedFile,
  onSelectionChange,
}: GitDiffPanelProps) {
  const { t } = useI18n();
  const [data, setData] = useState<GitDiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const loadDiff = useCallback(async () => {
    abortRef.current?.abort();
    if (!root) {
      setData(null);
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
      const res = await apiClient.getGitDiff({ root }, controller.signal);
      if (controller.signal.aborted) return;
      setData(res);
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
    return files.reduce(
      (acc, file) => ({
        additions: acc.additions + (file.additions || 0),
        deletions: acc.deletions + (file.deletions || 0),
      }),
      { additions: 0, deletions: 0 },
    );
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

  if (!root) {
    return (
      <div className={styles.emptyState} data-testid="git-diff-no-root">
        <div className={styles.emptyTitle}>{t('diff.noRootTitle')}</div>
        <div className={styles.emptyDesc}>{t('diff.noRootDesc')}</div>
      </div>
    );
  }

  return (
    <div className={styles.panel} data-testid="git-diff-panel">
      <header className={styles.header}>
        <div className={styles.branchGroup}>
          <span className={styles.branchBadge} data-testid="git-branch-name">
            {data?.isGitRepo === false ? t('diff.nonGitBadge') : data?.branch || 'HEAD'}
          </span>
          {data?.isGitRepo && (
            <span className={styles.summaryStats}>
              <span>{t('diff.filesCount', { count: data.files.length })}</span>
              <span className={styles.statAdd}>+{totals.additions}</span>
              <span className={styles.statDel}>-{totals.deletions}</span>
            </span>
          )}
        </div>

        <button
          type="button"
          className={styles.refreshBtn}
          onClick={() => void loadDiff()}
          disabled={loading}
          data-testid="git-refresh-btn"
        >
          {loading ? t('common.refreshing') : t('common.refresh')}
        </button>
      </header>

      {error && (
        <div className={styles.errorBanner} role="alert" data-testid="git-diff-error">
          <span>{error}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
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

            <div className={styles.filesList}>
              {data.files.map((file) => {
                const badge = STATUS_BADGE[file.status] || STATUS_BADGE.modified;
                const active = selectedFilePath === file.path;
                return (
                  <button
                    key={file.path}
                    type="button"
                    className={`${styles.fileRow} ${active ? styles.fileRowActive : ''}`}
                    onClick={() => setSelectedFilePath(active ? null : file.path)}
                    title={`${t(badge.labelKey)}: ${file.path}`}
                    data-testid={`git-file-${file.path}`}
                  >
                    <span className={`${styles.statusBadge} ${styles[`status_${file.status}`]}`}>
                      {badge.code}
                    </span>
                    <span className={styles.filePath}>{file.path}</span>
                    <span className={styles.fileDelta}>
                      {file.additions > 0 && <span className={styles.statAdd}>+{file.additions}</span>}
                      {file.deletions > 0 && <span className={styles.statDel}>-{file.deletions}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className={styles.diffViewerSection} data-testid="git-diff-viewer">
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
                    {section.lines.map((line, lineIdx) => (
                      <div
                        key={lineIdx}
                        className={`${styles.diffLine} ${styles[`diffLine_${line.kind}`]}`}
                      >
                        <span className={styles.diffLineNum}>{line.lineNo}</span>
                        <span className={styles.diffLineText}>{line.text || ' '}</span>
                      </div>
                    ))}
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
