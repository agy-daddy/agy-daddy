import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, apiClient } from '../api/client';
import { useI18n } from '../i18n';
import type { FsNode, SideChatSelectionContext } from '../types';
import { formatBytes, formatDockError, truncateSelectionSnippet } from './dockUtils';
import styles from './FileTreePanel.module.css';

export interface FileTreePanelProps {
  root: string;
  refreshKey?: number | string;
  onFileSaved?: (path: string, bytes: number) => void;
  onAuthorizeRoot?: (root: string) => Promise<void> | void;
  focusedFile?: { path: string; nonce: number } | null;
  onSelectionChange?: (selection: SideChatSelectionContext | null) => void;
}

function mergeNodeChildren(nodes: FsNode[], targetPath: string, children: FsNode[]): FsNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children };
    }
    if (node.children && node.children.length > 0 && targetPath.startsWith(`${node.path}/`)) {
      return {
        ...node,
        children: mergeNodeChildren(node.children, targetPath, children),
      };
    }
    return node;
  });
}

function collectDefaultExpanded(nodes: FsNode[]): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const node of nodes) {
    if (node.type === 'directory' && node.children && node.children.length > 0) {
      next[node.path] = true;
    }
  }
  return next;
}

export function FileTreePanel({
  root,
  refreshKey,
  onFileSaved,
  onAuthorizeRoot,
  focusedFile,
  onSelectionChange,
}: FileTreePanelProps) {
  const { t } = useI18n();
  const [treeEntries, setTreeEntries] = useState<FsNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const [loadingDirs, setLoadingDirs] = useState<Record<string, boolean>>({});
  const [treeCollapsed, setTreeCollapsed] = useState(false);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number>(0);
  const [fileTruncated, setFileTruncated] = useState(false);
  const [originalContent, setOriginalContent] = useState('');
  const [draftContent, setDraftContent] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  const treeAbortRef = useRef<AbortController | null>(null);
  const fileAbortRef = useRef<AbortController | null>(null);
  const hasEmittedSelectionRef = useRef(false);

  useEffect(() => {
    if (!onSelectionChange) return;
    if (selectedPath && !fileLoading && !fileError) {
      hasEmittedSelectionRef.current = true;
      onSelectionChange({
        path: selectedPath,
        snippet: truncateSelectionSnippet(draftContent),
        kind: 'file',
      });
    } else if (!selectedPath && hasEmittedSelectionRef.current) {
      hasEmittedSelectionRef.current = false;
      onSelectionChange(null);
    }
  }, [selectedPath, draftContent, fileLoading, fileError, onSelectionChange]);

  const loadTree = useCallback(async () => {
    treeAbortRef.current?.abort();
    if (!root) {
      setTreeEntries([]);
      setTreeError(null);
      setErrorCode(null);
      setTreeLoading(false);
      return;
    }

    const controller = new AbortController();
    treeAbortRef.current = controller;
    setTreeLoading(true);
    setTreeError(null);
    setErrorCode(null);

    try {
      const res = await apiClient.getFsTree({ root, depth: 2 }, controller.signal);
      if (controller.signal.aborted) return;
      setTreeEntries(res.entries || []);
      setExpandedDirs((prev) =>
        Object.keys(prev).length > 0 ? prev : collectDefaultExpanded(res.entries || []),
      );
    } catch (err) {
      if (controller.signal.aborted) return;
      setTreeEntries([]);
      setTreeError(formatDockError(err, t('dockErr.requestFailed'), t));
      setErrorCode(err instanceof ApiError ? err.code : null);
    } finally {
      if (!controller.signal.aborted) {
        setTreeLoading(false);
      }
    }
  }, [root, t]);

  const loadFile = useCallback(
    async (filePath: string) => {
      fileAbortRef.current?.abort();
      if (!root || !filePath) return;

      const controller = new AbortController();
      fileAbortRef.current = controller;
      setSelectedPath(filePath);
      setFileLoading(true);
      setFileError(null);
      setSaveNotice(null);

      try {
        const res = await apiClient.readFsFile({ root, path: filePath }, controller.signal);
        if (controller.signal.aborted) return;
        setFileSize(res.size);
        setFileTruncated(Boolean(res.truncated));
        setOriginalContent(res.content);
        setDraftContent(res.content);
      } catch (err) {
        if (controller.signal.aborted) return;
        setFileError(formatDockError(err, t('dockErr.requestFailed'), t));
        setFileTruncated(false);
        setOriginalContent('');
        setDraftContent('');
      } finally {
        if (!controller.signal.aborted) {
          setFileLoading(false);
        }
      }
    },
    [root, t],
  );

  useEffect(() => {
    setSelectedPath(null);
    setExpandedDirs({});
    setFileError(null);
    setSaveNotice(null);
    setFileTruncated(false);
    setOriginalContent('');
    setDraftContent('');
  }, [root]);

  useEffect(() => {
    void loadTree();
    return () => {
      treeAbortRef.current?.abort();
    };
  }, [loadTree, refreshKey]);

  useEffect(() => {
    const rawTarget = focusedFile?.path?.trim();
    if (!rawTarget || !root) return;
    const cleaned = rawTarget.replace(/^file:\/\//i, '').replace(/\/+$/, '');
    const normRoot = root.replace(/\/+$/, '');
    let relPath = cleaned;
    if (cleaned === normRoot) return;
    if (cleaned.startsWith(`${normRoot}/`)) {
      relPath = cleaned.slice(normRoot.length + 1);
    }
    if (relPath && !relPath.startsWith('/')) {
      void loadFile(relPath);
    }
  }, [focusedFile?.path, focusedFile?.nonce, root, loadFile]);

  useEffect(() => {
    return () => {
      fileAbortRef.current?.abort();
    };
  }, []);

  const handleToggleDir = async (node: FsNode) => {
    const nextExpanded = !expandedDirs[node.path];
    setExpandedDirs((prev) => ({ ...prev, [node.path]: nextExpanded }));

    if (nextExpanded && node.children === undefined && root) {
      setLoadingDirs((prev) => ({ ...prev, [node.path]: true }));
      try {
        const res = await apiClient.getFsTree({ root, path: node.path, depth: 2 });
        setTreeEntries((prev) => mergeNodeChildren(prev, node.path, res.entries || []));
      } catch (err) {
        setTreeError(formatDockError(err, t('dockErr.requestFailed'), t));
        setErrorCode(err instanceof ApiError ? err.code : null);
      } finally {
        setLoadingDirs((prev) => ({ ...prev, [node.path]: false }));
      }
    }
  };

  const handleAuthorizeRoot = useCallback(async () => {
    if (!onAuthorizeRoot || !root || authorizing) return;
    setAuthorizing(true);
    try {
      await onAuthorizeRoot(root);
      await loadTree();
    } catch (err) {
      setTreeError(formatDockError(err, t('dockErr.requestFailed'), t));
      setErrorCode(err instanceof ApiError ? err.code : null);
    } finally {
      setAuthorizing(false);
    }
  }, [onAuthorizeRoot, root, authorizing, loadTree, t]);

  const isDirty = useMemo(
    () => selectedPath !== null && !fileTruncated && draftContent !== originalContent,
    [selectedPath, fileTruncated, draftContent, originalContent],
  );

  const handleSave = useCallback(async () => {
    if (!root || !selectedPath || fileTruncated || saving || !isDirty) return;
    setSaving(true);
    setFileError(null);
    setSaveNotice(null);
    try {
      const res = await apiClient.writeFsFile({
        root,
        path: selectedPath,
        content: draftContent,
      });
      setOriginalContent(draftContent);
      setFileSize(res.bytes);
      setSaveNotice(t('files.savedNotice', { bytes: formatBytes(res.bytes) }));
      onFileSaved?.(res.path, res.bytes);
    } catch (err) {
      setFileError(formatDockError(err, t('dockErr.requestFailed'), t));
    } finally {
      setSaving(false);
    }
  }, [root, selectedPath, fileTruncated, saving, isDirty, draftContent, onFileSaved, t]);

  const handleEditorKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      void handleSave();
    }
  };

  const renderTreeNodes = (nodes: FsNode[], depth = 0): React.ReactNode =>
    nodes.map((node) => {
      const isDir = node.type === 'directory';
      const isExpanded = Boolean(expandedDirs[node.path]);
      const isDirLoading = Boolean(loadingDirs[node.path]);
      const isSelected = !isDir && selectedPath === node.path;

      return (
        <div key={node.path} className={styles.treeNodeGroup}>
          <button
            type="button"
            className={`${styles.treeRow} ${isSelected ? styles.treeRowActive : ''}`}
            style={{ paddingLeft: `${10 + depth * 14}px` }}
            onClick={() => (isDir ? void handleToggleDir(node) : void loadFile(node.path))}
            title={node.path}
            data-testid={`fs-node-${node.path}`}
          >
            <span className={styles.treeChevron} aria-hidden="true">
              {isDir ? (isDirLoading ? '⋯' : isExpanded ? '▾' : '▸') : ''}
            </span>
            <span className={`${styles.treeIcon} ${isDir ? styles.treeIconDir : styles.treeIconFile}`}>
              {isDir ? '📁' : '📄'}
            </span>
            <span className={styles.treeName}>{node.name}</span>
            {!isDir && node.size !== undefined && (
              <span className={styles.treeMeta}>{formatBytes(node.size)}</span>
            )}
          </button>

          {isDir && isExpanded && (
            <div className={styles.treeChildren}>
              {node.children && node.children.length > 0 ? (
                renderTreeNodes(node.children, depth + 1)
              ) : (
                <div
                  className={styles.treeEmptyDir}
                  style={{ paddingLeft: `${26 + depth * 14}px` }}
                >
                  {isDirLoading ? '...' : '—'}
                </div>
              )}
            </div>
          )}
        </div>
      );
    });

  if (!root) {
    return (
      <div className={styles.emptyState} data-testid="file-tree-no-root">
        <div className={styles.emptyTitle}>{t('files.noRootTitle')}</div>
        <div className={styles.emptyDesc}>{t('files.noRootDesc')}</div>
      </div>
    );
  }

  return (
    <div className={styles.panel} data-testid="file-tree-panel">
      <section
        className={`${styles.treeSection} ${selectedPath && !treeCollapsed ? styles.treeSectionSplit : ''} ${
          treeCollapsed ? styles.treeSectionCollapsed : ''
        }`}
      >
        <div className={styles.sectionHeader}>
          <button
            type="button"
            className={styles.collapseBtn}
            onClick={() => setTreeCollapsed((v) => !v)}
            title={treeCollapsed ? t('files.expandTree') : t('files.collapseTree')}
          >
            <span>{treeCollapsed ? '▸' : '▾'}</span>
            <span>{t('dock.tab.files')}</span>
          </button>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.actionBtn}
              onClick={() => void loadTree()}
              disabled={treeLoading}
              title={t('files.refreshTree')}
              data-testid="fs-refresh-tree-btn"
            >
              {treeLoading ? t('common.refreshing') : t('common.refresh')}
            </button>
          </div>
        </div>

        {!treeCollapsed && (
          <div className={styles.treeBody} data-testid="fs-tree-list">
            {treeError && (
              <div className={styles.errorBanner} role="alert" data-testid="fs-tree-error">
                <span>{treeError}</span>
                <div className={styles.editorActions}>
                  {errorCode === 'PATH_OUTSIDE_WORKSPACE' && onAuthorizeRoot && root ? (
                    <button
                      type="button"
                      className={styles.saveBtn}
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
                    onClick={() => void loadTree()}
                    disabled={authorizing}
                  >
                    {t('files.retry')}
                  </button>
                </div>
              </div>
            )}

            {!treeError && treeLoading && treeEntries.length === 0 ? (
              <div className={styles.mutedPlaceholder}>{t('files.loadingTree')}</div>
            ) : null}

            {!treeError && !treeLoading && treeEntries.length === 0 ? (
              <div className={styles.mutedPlaceholder}>{t('files.emptyTree')}</div>
            ) : null}

            {treeEntries.length > 0 && renderTreeNodes(treeEntries)}
          </div>
        )}
      </section>

      {selectedPath && (
        <section className={styles.editorSection} data-testid="fs-editor-section">
          <div className={styles.editorHeader}>
            <div className={styles.editorTitleWrap}>
              <span className={styles.editorPath} title={selectedPath}>
                {selectedPath}
              </span>
              <span className={styles.editorMeta}>
                {formatBytes(fileSize)}
                {isDirty ? <span className={styles.dirtyBadge}>· {t('files.unsavedBadge')}</span> : null}
              </span>
            </div>

            <div className={styles.editorActions}>
              <button
                type="button"
                className={styles.actionBtn}
                onClick={() => void loadFile(selectedPath)}
                disabled={fileLoading || saving}
                title={t('common.refresh')}
              >
                {t('common.refresh')}
              </button>
              {isDirty && (
                <button
                  type="button"
                  className={styles.actionBtn}
                  onClick={() => {
                    setDraftContent(originalContent);
                    setSaveNotice(null);
                  }}
                  disabled={saving}
                >
                  {t('files.revert')}
                </button>
              )}
              <button
                type="button"
                className={styles.saveBtn}
                onClick={() => void handleSave()}
                disabled={!isDirty || saving || fileLoading || fileTruncated}
                data-testid="fs-save-btn"
              >
                {saving ? t('files.saving') : t('files.save')}
              </button>
            </div>
          </div>

          {fileTruncated && (
            <div className={styles.warningBanner} role="status" data-testid="fs-truncated-banner">
              {t('files.truncatedWarning', { size: formatBytes(fileSize) })}
            </div>
          )}

          {saveNotice && (
            <div className={styles.successBanner} role="status" data-testid="fs-save-notice">
              {saveNotice}
            </div>
          )}

          {fileError && (
            <div className={styles.errorBanner} role="alert" data-testid="fs-file-error">
              <span>{fileError}</span>
              <button
                type="button"
                className={styles.retryBtn}
                onClick={() => void loadFile(selectedPath)}
              >
                {t('files.retry')}
              </button>
            </div>
          )}

          {fileLoading ? (
            <div className={styles.mutedPlaceholder}>{t('files.loadingFile')}</div>
          ) : (
            <textarea
              className={styles.editorTextarea}
              value={draftContent}
              onChange={(ev) => {
                setDraftContent(ev.target.value);
                if (saveNotice) setSaveNotice(null);
              }}
              onKeyDown={handleEditorKeyDown}
              readOnly={fileTruncated}
              spellCheck={false}
              aria-label={selectedPath}
              data-testid="fs-editor-textarea"
            />
          )}
        </section>
      )}
    </div>
  );
}
