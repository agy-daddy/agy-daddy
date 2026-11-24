import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n, type I18nKey } from '../i18n';
import type { SessionSummary } from '../types';
import { ArtifactsPanel } from './ArtifactsPanel';
import { normalizeWorkspacePath } from './dockUtils';
import { FileTreePanel } from './FileTreePanel';
import { GitDiffPanel } from './GitDiffPanel';
import styles from './RightDock.module.css';

export type RightDockTab = 'files' | 'diff' | 'artifacts';

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
}

interface RootOption {
  value: string;
  label: string;
  fromSession: boolean;
}

const TAB_KEYS: Array<{ id: RightDockTab; labelKey: I18nKey }> = [
  { id: 'files', labelKey: 'dock.tab.files' },
  { id: 'diff', labelKey: 'dock.tab.diff' },
  { id: 'artifacts', labelKey: 'dock.tab.artifacts' },
];

function formatRootLabel(rootPath: string, fromSession: boolean, sessionSuffix: string): string {
  const parts = rootPath.split('/').filter(Boolean);
  const base = parts.length > 0 ? parts[parts.length - 1] : rootPath;
  return fromSession ? `${base}${sessionSuffix} — ${rootPath}` : `${base} — ${rootPath}`;
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

  const rootOptions = useMemo<RootOption[]>(() => {
    const sessionSet = new Set(sessionRoots);
    const seen = new Set<string>();
    const options: RootOption[] = [];

    const pushOption = (rawPath: string | undefined | null) => {
      const normalized = normalizeWorkspacePath(rawPath);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      const fromSession = sessionSet.has(normalized);
      options.push({
        value: normalized,
        label: formatRootLabel(normalized, fromSession, t('dock.workspaceSessionSuffix')),
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
  }, [sessionRoots, normalizedAllowedRoots, controlledRoot, defaultWorkspaceRoot, t]);

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
  const [diffBumpCount, setDiffBumpCount] = useState(0);

  const combinedRefreshKey = `${refreshKey ?? ''}:${manualRefreshCount}`;
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

  return (
    <div className={styles.dock} data-testid="right-dock">
      <div className={styles.topControls}>
        <div className={styles.tabBar} role="tablist" aria-label={t('dock.panelAria')}>
          {TAB_KEYS.map((tab) => {
            const active = currentTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                className={`${styles.tabBtn} ${active ? styles.tabBtnActive : ''}`}
                onClick={() => handleSelectTab(tab.id)}
                data-testid={`dock-tab-${tab.id}`}
              >
                <span>{t(tab.labelKey)}</span>
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
          <label className={styles.rootLabel} htmlFor="right-dock-root-select">
            {t('dock.workspaceLabel')}
          </label>
          <select
            id="right-dock-root-select"
            className={styles.rootSelect}
            value={currentRoot}
            onChange={(ev) => handleSelectRoot(ev.target.value)}
            disabled={rootOptions.length === 0}
            title={currentRoot || t('dock.workspaceEmpty')}
            data-testid="dock-root-select"
          >
            {rootOptions.length === 0 ? (
              <option value="">{t('dock.workspaceEmpty')}</option>
            ) : (
              rootOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))
            )}
          </select>
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
            refreshKey={combinedRefreshKey}
            onFileSaved={() => setDiffBumpCount((n) => n + 1)}
            onAuthorizeRoot={resolvedOnAuthorizeRoot}
            focusedFile={focusedFilePath}
          />
        )}
        {currentTab === 'diff' && (
          <GitDiffPanel
            root={currentRoot}
            refreshKey={diffRefreshKey}
            onAuthorizeRoot={resolvedOnAuthorizeRoot}
            focusedFile={focusedDiffFile}
          />
        )}
        {currentTab === 'artifacts' && (
          <ArtifactsPanel sessionId={effectiveSessionId} refreshKey={combinedRefreshKey} />
        )}
      </div>
    </div>
  );
}
