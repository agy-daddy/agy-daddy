import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../api/client';
import { useI18n, type I18nKey } from '../i18n';
import type { ModelItem, SessionSummary, SideChatSelectionContext } from '../types';
import { ArtifactsPanel } from './ArtifactsPanel';
import { normalizeWorkspacePath, truncateSelectionSnippet } from './dockUtils';
import { FileTreePanel } from './FileTreePanel';
import { GitDiffPanel } from './GitDiffPanel';
import { SideChatPanel } from './SideChatPanel';
import { TerminalPanel } from './TerminalPanel';
import { WorkspacePicker, type WorkspacePickerOption } from './WorkspacePicker';
import styles from './RightDock.module.css';

export type RightDockTab = 'files' | 'diff' | 'artifacts' | 'terminal' | 'sideChat';

export interface RightDockProps {
  activeSessionId?: string | null;
  activeSession?: SessionSummary | null;
  sessionWorkspaceUri?: string | null;
  allowedRoots?: string[];
  workspaceRoot?: string;
  defaultWorkspaceRoot?: string;
  onWorkspaceRootChange?: (root: string) => void;
  onAuthorizeRoot?: (root: string) => Promise<void> | void;
  activeTab?: RightDockTab;
  defaultTab?: RightDockTab;
  onTabChange?: (tab: RightDockTab) => void;
  refreshKey?: number | string;
  diffBadgeCount?: number;
  focusedDiffFile?: { path: string; nonce: number } | null;
  focusedFilePath?: { path: string; nonce: number } | null;
  channel?: string;
  permissionLevel?: string;
  models?: ModelItem[];
  activeModelId?: string | null;
  onInsertToComposer?: (text: string) => void;
  onGitMutated?: () => void;
}

function extractRootBaseName(rootPath: string): string {
  const parts = rootPath.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : rootPath;
}

const TAB_KEYS: Array<{ id: RightDockTab; labelKey: I18nKey }> = [
  { id: 'files', labelKey: 'dock.tab.files' },
  { id: 'diff', labelKey: 'dock.tab.diff' },
  { id: 'artifacts', labelKey: 'dock.tab.artifacts' },
  { id: 'terminal', labelKey: 'dock.tab.terminal' },
  { id: 'sideChat', labelKey: 'dock.tab.sideChat' },
];

function TabIcon({ id }: { id: RightDockTab }) {
  const props = {
    width: 13,
    height: 13,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };
  if (id === 'files') {
    return (
      <svg {...props}>
        <path d="M2.5 4.2h4.1l1.2 1.4h5.7v6.7H2.5z" />
      </svg>
    );
  }
  if (id === 'diff') {
    return (
      <svg {...props}>
        <circle cx="4.5" cy="4.2" r="1.4" />
        <circle cx="4.5" cy="11.8" r="1.4" />
        <circle cx="11.5" cy="8" r="1.4" />
        <path d="M4.5 5.6v4.8M5.9 4.7c2.4.2 4.2 1.2 4.6 2.1" />
      </svg>
    );
  }
  if (id === 'artifacts') {
    return (
      <svg {...props}>
        <rect x="3" y="2.5" width="10" height="11" rx="1.6" />
        <path d="M5.5 6h5M5.5 8.8h5M5.5 11.4h3" />
      </svg>
    );
  }
  if (id === 'terminal') {
    return (
      <svg {...props}>
        <rect x="2" y="3" width="12" height="10" rx="1.6" />
        <path d="m4.8 6.4 2.1 1.6-2.1 1.6M8.3 9.8h3" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <path d="M3 3.5h10v7.2H6.6L3.6 13v-2.3H3z" />
    </svg>
  );
}

function isRootInsideAllowed(candidate: string, allowedRoots: string[]): boolean {
  if (allowedRoots.length === 0) return true;
  const lowerCandidate = candidate.toLowerCase();
  return allowedRoots.some((allowed) => {
    if (allowed === '/') return true;
    const lowerAllowed = allowed.toLowerCase();
    return lowerCandidate === lowerAllowed || lowerCandidate.startsWith(`${lowerAllowed}/`);
  });
}

function toRelativeWorkspacePath(rawTarget: string, root: string): string | null {
  const cleaned = rawTarget.trim().replace(/^file:\/\//i, '').replace(/\/+$/, '');
  const normRoot = root.replace(/\/+$/, '');
  if (!cleaned || !normRoot || cleaned === normRoot) return null;
  const relPath = cleaned.startsWith(`${normRoot}/`) ? cleaned.slice(normRoot.length + 1) : cleaned;
  return relPath && !relPath.startsWith('/') ? relPath : null;
}

export function RightDock({
  activeSessionId,
  activeSession,
  sessionWorkspaceUri,
  allowedRoots,
  workspaceRoot: controlledRoot,
  defaultWorkspaceRoot,
  onWorkspaceRootChange,
  onAuthorizeRoot,
  activeTab: controlledTab,
  defaultTab = 'files',
  onTabChange,
  refreshKey,
  diffBadgeCount = 0,
  focusedDiffFile = null,
  focusedFilePath = null,
  channel = 'loopback',
  permissionLevel = 'L2',
  models = [],
  activeModelId = null,
  onInsertToComposer,
  onGitMutated,
}: RightDockProps) {
  const { t } = useI18n();
  const [uncontrolledTab, setUncontrolledTab] = useState<RightDockTab>(defaultTab);
  const currentTab = controlledTab ?? uncontrolledTab;

  const normalizedAllowedRoots = useMemo(() => {
    if (!allowedRoots || allowedRoots.length === 0) return [];
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const raw of allowedRoots) {
      const p = normalizeWorkspacePath(raw);
      if (p && !seen.has(p)) {
        seen.add(p);
        normalized.push(p);
      }
    }
    return normalized;
  }, [allowedRoots]);

  const sessionRoots = useMemo(() => {
    const rawList: Array<string | null | undefined> = [
      sessionWorkspaceUri,
      activeSession?.workspaceUri,
      activeSession?.gitRootUri,
    ];
    if (activeSession?.workspaces) {
      for (const ws of activeSession.workspaces) {
        rawList.push(
          ws.workspaceFolderAbsoluteUri,
          ws.workspaceUri,
          ws.gitRootAbsoluteUri,
          ws.gitRootUri,
        );
      }
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const raw of rawList) {
      const p = normalizeWorkspacePath(raw);
      if (p && !seen.has(p) && isRootInsideAllowed(p, normalizedAllowedRoots)) {
        seen.add(p);
        normalized.push(p);
      }
    }
    return normalized;
  }, [sessionWorkspaceUri, activeSession, normalizedAllowedRoots]);

  const rootOptions = useMemo<WorkspacePickerOption[]>(() => {
    const sessionSet = new Set(sessionRoots);
    const seen = new Set<string>();
    const options: WorkspacePickerOption[] = [];

    const pushOption = (rawPath: string | undefined | null) => {
      const normalized = normalizeWorkspacePath(rawPath);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      const fromSession = sessionSet.has(normalized);
      options.push({
        value: normalized,
        name: extractRootBaseName(normalized),
        path: normalized,
        fromSession,
      });
    };

    for (const sRoot of sessionRoots) {
      pushOption(sRoot);
    }
    for (const allowed of normalizedAllowedRoots) {
      pushOption(allowed);
    }
    if (controlledRoot) {
      pushOption(controlledRoot);
    }
    if (defaultWorkspaceRoot) {
      pushOption(defaultWorkspaceRoot);
    }

    return options;
  }, [sessionRoots, normalizedAllowedRoots, controlledRoot, defaultWorkspaceRoot]);

  const primaryDefaultRoot = useMemo(() => {
    if (defaultWorkspaceRoot) {
      const norm = normalizeWorkspacePath(defaultWorkspaceRoot);
      if (norm && isRootInsideAllowed(norm, normalizedAllowedRoots)) return norm;
    }
    if (sessionRoots.length > 0) return sessionRoots[0];
    return rootOptions[0]?.value || '';
  }, [defaultWorkspaceRoot, normalizedAllowedRoots, sessionRoots, rootOptions]);

  const [uncontrolledRoot, setUncontrolledRoot] = useState<string>(primaryDefaultRoot);
  const effectiveSessionId = activeSession?.cascadeId ?? activeSessionId ?? null;
  const primarySessionRoot = sessionRoots[0] || '';
  const lastSessionIdRef = useRef<string | null | undefined>(undefined);
  const lastPrimarySessionRootRef = useRef<string>('');

  // Sync uncontrolled root when active session changes or session root first becomes available
  useEffect(() => {
    if (controlledRoot !== undefined) return;

    const sessionChanged = lastSessionIdRef.current !== effectiveSessionId;
    const primaryRootChanged = lastPrimarySessionRootRef.current !== primarySessionRoot;
    lastSessionIdRef.current = effectiveSessionId;
    lastPrimarySessionRootRef.current = primarySessionRoot;

    if ((sessionChanged || primaryRootChanged) && primarySessionRoot) {
      setUncontrolledRoot(primarySessionRoot);
      return;
    }

    setUncontrolledRoot((prev) => {
      if (prev && rootOptions.some((o) => o.value === prev)) return prev;
      return primarySessionRoot || rootOptions[0]?.value || '';
    });
  }, [effectiveSessionId, primarySessionRoot, rootOptions, controlledRoot]);

  const currentRoot = controlledRoot !== undefined
    ? normalizeWorkspacePath(controlledRoot)
    : uncontrolledRoot;

  const [manualRefreshCount, setManualRefreshCount] = useState(0);
  const [filesBumpCount, setFilesBumpCount] = useState(0);
  const [diffBumpCount, setDiffBumpCount] = useState(0);

  const combinedRefreshKey = `${refreshKey ?? ''}:${manualRefreshCount}`;
  const filesRefreshKey = `${combinedRefreshKey}:${filesBumpCount}`;
  const diffRefreshKey = `${combinedRefreshKey}:${diffBumpCount}`;

  const handleSelectTab = (tab: RightDockTab) => {
    if (controlledTab === undefined) {
      setUncontrolledTab(tab);
    }
    onTabChange?.(tab);
  };

  const handleSelectRoot = (nextRoot: string) => {
    if (controlledRoot === undefined) {
      setUncontrolledRoot(nextRoot);
    }
    onWorkspaceRootChange?.(nextRoot);
  };

  const handleAuthorizeRoot = useCallback(
    async (targetRoot: string) => {
      if (!onAuthorizeRoot) return;
      await onAuthorizeRoot(targetRoot);
      setManualRefreshCount((n) => n + 1);
    },
    [onAuthorizeRoot],
  );

  const resolvedOnAuthorizeRoot = onAuthorizeRoot ? handleAuthorizeRoot : undefined;
  const [fileSelection, setFileSelection] = useState<SideChatSelectionContext | null>(null);
  const [diffSelection, setDiffSelection] = useState<SideChatSelectionContext | null>(null);
  const [preferredSelectionKind, setPreferredSelectionKind] = useState<'file' | 'diff' | null>(null);

  useEffect(() => {
    setFileSelection(null);
    setDiffSelection(null);
    setPreferredSelectionKind(null);
  }, [currentRoot]);

  useEffect(() => {
    if (!focusedDiffFile?.path) return;
    setPreferredSelectionKind('diff');
    if (currentTab === 'diff' || !currentRoot) return;
    const relPath = toRelativeWorkspacePath(focusedDiffFile.path, currentRoot);
    if (!relPath) return;
    const controller = new AbortController();
    void apiClient
      .getGitDiff({ root: currentRoot }, controller.signal)
      .then((res) => {
        if (controller.signal.aborted || !res.isGitRepo || !res.diffText?.trim()) return;
        const blocks = res.diffText.split(/(?=^diff --git )/m);
        const matched = blocks.find((b) => {
          const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(b);
          return m && (m[2] === relPath || m[2].endsWith(`/${relPath}`));
        });
        const snippet = truncateSelectionSnippet((matched || res.diffText).trim());
        if (snippet) {
          setDiffSelection({ path: relPath, snippet, kind: 'diff' });
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [focusedDiffFile?.path, focusedDiffFile?.nonce, currentTab, currentRoot]);

  useEffect(() => {
    if (!focusedFilePath?.path) return;
    setPreferredSelectionKind('file');
    if (currentTab === 'files' || !currentRoot) return;
    const relPath = toRelativeWorkspacePath(focusedFilePath.path, currentRoot);
    if (!relPath) return;
    const controller = new AbortController();
    void apiClient
      .readFsFile({ root: currentRoot, path: relPath }, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setFileSelection({
          path: relPath,
          snippet: truncateSelectionSnippet(res.content || ''),
          kind: 'file',
        });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [focusedFilePath?.path, focusedFilePath?.nonce, currentTab, currentRoot]);

  const handleFileSelectionChange = useCallback((next: SideChatSelectionContext | null) => {
    setFileSelection(next);
    if (next) {
      setPreferredSelectionKind('file');
    }
  }, []);

  const handleDiffSelectionChange = useCallback((next: SideChatSelectionContext | null) => {
    setDiffSelection(next);
    if (next) {
      setPreferredSelectionKind('diff');
    }
  }, []);

  const activeSelectionContext = useMemo<SideChatSelectionContext | null>(() => {
    const primary =
      preferredSelectionKind === 'diff'
        ? diffSelection
        : preferredSelectionKind === 'file'
          ? fileSelection
          : null;
    const picked = primary || diffSelection || fileSelection;
    if (picked) {
      return {
        ...picked,
        snippet: truncateSelectionSnippet(picked.snippet),
      };
    }
    const filePath = focusedDiffFile?.path || focusedFilePath?.path;
    if (!filePath) return null;
    return {
      path: filePath,
      snippet: '',
      kind: focusedDiffFile?.path ? 'diff' : 'file',
    };
  }, [
    preferredSelectionKind,
    diffSelection,
    fileSelection,
    focusedDiffFile?.path,
    focusedFilePath?.path,
  ]);

  return (
    <div className={styles.dock} data-testid="right-dock">
      <div className={styles.topControls}>
        <div className={styles.tabBar} role="tablist" aria-label={t('dock.panelAria')}>
          {TAB_KEYS.map((tab) => {
            const active = currentTab === tab.id;
            const label = t(tab.labelKey);
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={label}
                title={label}
                className={`${styles.tabBtn} ${active ? styles.tabBtnActive : ''}`}
                onClick={() => handleSelectTab(tab.id)}
                data-testid={`dock-tab-${tab.id}`}
              >
                <span className={styles.tabIcon}>
                  <TabIcon id={tab.id} />
                </span>
                <span className={styles.tabLabel}>{label}</span>
                {tab.id === 'diff' && diffBadgeCount > 0 && (
                  <span className={styles.tabBadge} data-testid="dock-diff-badge">
                    {diffBadgeCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className={styles.rootBar}>
          <label
            id="right-dock-root-label"
            className={styles.rootLabel}
            htmlFor="right-dock-root-select"
          >
            {t('dock.workspaceLabel')}
          </label>
          <WorkspacePicker
            id="right-dock-root-select"
            ariaLabelledBy="right-dock-root-label"
            options={rootOptions}
            value={currentRoot}
            onChange={handleSelectRoot}
          />
          <button
            type="button"
            className={styles.refreshIconBtn}
            onClick={() => setManualRefreshCount((n) => n + 1)}
            title={t('dock.refresh')}
            aria-label={t('dock.refresh')}
            data-testid="dock-refresh-btn"
          >
            ↻
          </button>
        </div>
      </div>

      <div className={styles.body} role="tabpanel">
        {currentTab === 'files' && (
          <FileTreePanel
            root={currentRoot}
            refreshKey={filesRefreshKey}
            onFileSaved={() => setDiffBumpCount((n) => n + 1)}
            onAuthorizeRoot={resolvedOnAuthorizeRoot}
            focusedFile={focusedFilePath}
            onSelectionChange={handleFileSelectionChange}
          />
        )}
        {currentTab === 'diff' && (
          <GitDiffPanel
            root={currentRoot}
            refreshKey={diffRefreshKey}
            onAuthorizeRoot={resolvedOnAuthorizeRoot}
            focusedFile={focusedDiffFile}
            onSelectionChange={handleDiffSelectionChange}
            channel={channel}
            permissionLevel={permissionLevel}
            onInsertToComposer={onInsertToComposer}
            onSelectWorkspaceRoot={handleSelectRoot}
            onGitMutated={() => {
              setFilesBumpCount((n) => n + 1);
              onGitMutated?.();
            }}
          />
        )}
        {currentTab === 'artifacts' && (
          <ArtifactsPanel sessionId={effectiveSessionId} refreshKey={combinedRefreshKey} />
        )}
        <div className={styles.keepalivePane} hidden={currentTab !== 'terminal'}>
          <TerminalPanel
            activeRoot={currentRoot}
            channel={channel}
            permissionLevel={permissionLevel}
            refreshKey={combinedRefreshKey}
          />
        </div>
        <div className={styles.keepalivePane} hidden={currentTab !== 'sideChat'}>
          <SideChatPanel
            activeSessionId={effectiveSessionId}
            models={models}
            activeModelId={activeModelId}
            channel={channel}
            permissionLevel={permissionLevel}
            activeSelectionContext={activeSelectionContext}
            onInsertToComposer={onInsertToComposer}
          />
        </div>
      </div>
    </div>
  );
}
