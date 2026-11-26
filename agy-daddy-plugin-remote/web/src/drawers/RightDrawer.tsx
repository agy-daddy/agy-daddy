import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import type { I18nKey } from '../i18n/types';
import type { PermissionLevel, RightTabId } from '../types';
import styles from './RightDrawer.module.css';

interface RightDrawerProps {
  open: boolean;
  activeTab: RightTabId;
  rootPath: string;
  worktreeId?: string | null;
  worktreeBranch?: string | null;
  isMissingWorktree?: boolean;
  missingWorktreePath?: string | null;
  isOverrideRoot?: boolean;
  sessionId: string;
  permissionLevel: PermissionLevel;
  token: string;
  inspectTargetFile: string;
  onSelectTab: (tab: RightTabId) => void;
  onResetOverride?: () => void;
  onClose: () => void;
  onInjectQuote: (snippet: string) => void;
  onShowToast: (msg: string) => void;
  onRefreshDiffBadge: () => void;
}

const TABS: Array<{ id: RightTabId; labelKey: I18nKey }> = [
  { id: 'diff', labelKey: 'right.tabDiff' },
  { id: 'files', labelKey: 'right.tabFiles' },
  { id: 'git', labelKey: 'right.tabGit' },
  { id: 'artifacts', labelKey: 'right.tabArtifacts' },
  { id: 'pty', labelKey: 'right.tabPty' }
];

type LazyComp = ComponentType<Record<string, unknown>>;

export function RightDrawer(props: RightDrawerProps) {
  const { t } = useI18n();
  const {
    open,
    activeTab,
    rootPath,
    worktreeId,
    worktreeBranch,
    isMissingWorktree,
    missingWorktreePath,
    isOverrideRoot,
    sessionId,
    permissionLevel,
    token,
    inspectTargetFile,
    onSelectTab,
    onResetOverride,
    onClose,
    onInjectQuote,
    onShowToast,
    onRefreshDiffBadge
  } = props;

  const [loaded, setLoaded] = useState<Partial<Record<RightTabId, LazyComp>>>({});
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!open) return;
    if (loaded[activeTab]) return;
    let canceled = false;
    setLoadError('');

    const load = async () => {
      try {
        let mod: { default: LazyComp };
        switch (activeTab) {
          case 'diff':
            mod = (await import('../lazy/DiffViewer')) as unknown as { default: LazyComp };
            break;
          case 'files':
            mod = (await import('../lazy/FileBrowser')) as unknown as { default: LazyComp };
            break;
          case 'git':
            mod = (await import('../lazy/GitWorkbench')) as unknown as { default: LazyComp };
            break;
          case 'artifacts':
            mod = (await import('../lazy/ArtifactsViewer')) as unknown as { default: LazyComp };
            break;
          case 'pty':
            mod = (await import('../lazy/PtyTerminal')) as unknown as { default: LazyComp };
            break;
        }
        if (!canceled && mod?.default) {
          setLoaded((prev) => ({ ...prev, [activeTab]: mod.default }));
        }
      } catch (err) {
        if (!canceled) {
          setLoadError(t('right.loadFailed', { msg: (err as Error).message }));
        }
      }
    };
    load();
    return () => {
      canceled = true;
    };
  }, [open, activeTab, loaded, t]);

  const ActiveComp = loaded[activeTab];
  const activeTabDef = TABS.find((tab) => tab.id === activeTab);
  const activeTabLabel = activeTabDef ? t(activeTabDef.labelKey) : activeTab;
  const blockedByMissing = Boolean(isMissingWorktree && activeTab !== 'artifacts');
  const sandboxLabel = worktreeBranch
    ? `${worktreeBranch} · ${rootPath || missingWorktreePath || ''}`
    : rootPath || missingWorktreePath || '';

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.tabs} data-hscroll="1" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`${styles.tabBtn} ${activeTab === tab.id ? styles.tabActive : ''}`}
              onClick={() => onSelectTab(tab.id)}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.closeBtn}
          aria-label={t('topbar.rightDrawer')}
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      {(sandboxLabel || isOverrideRoot) && (
        <div className={styles.sandboxBar} data-testid="right-drawer-sandbox-pill">
          <span className={styles.sandboxPath} title={rootPath || missingWorktreePath || ''}>
            {isOverrideRoot
              ? t('right.sandboxOverrideHint', { path: rootPath })
              : t('right.sandboxLocked', { label: sandboxLabel })}
          </span>
          {isOverrideRoot && onResetOverride && (
            <button
              type="button"
              className={styles.sandboxResetBtn}
              data-testid="right-drawer-reset-override"
              onClick={onResetOverride}
            >
              {t('right.sandboxResetBtn')}
            </button>
          )}
        </div>
      )}

      <div className={styles.content}>
        {!open ? null : blockedByMissing ? (
          <div className={styles.missingCard} data-testid="right-drawer-missing-worktree">
            <strong className={styles.missingTitle}>{t('right.sandboxMissingTitle')}</strong>
            <div className={styles.missingDesc}>
              {t('right.sandboxMissingDesc', {
                path: missingWorktreePath || rootPath || ''
              })}
            </div>
          </div>
        ) : loadError ? (
          <div className="ag-empty">{loadError}</div>
        ) : !ActiveComp ? (
          <div className="ag-empty">{t('right.loadingModule', { tab: activeTabLabel })}</div>
        ) : (
          <ActiveComp
            rootPath={rootPath}
            worktreeId={worktreeId}
            worktreeBranch={worktreeBranch}
            sessionId={sessionId}
            permissionLevel={permissionLevel}
            token={token}
            inspectTargetFile={inspectTargetFile}
            onInjectQuote={onInjectQuote}
            onShowToast={onShowToast}
            onRefreshDiffBadge={onRefreshDiffBadge}
          />
        )}
      </div>
    </div>
  );
}
