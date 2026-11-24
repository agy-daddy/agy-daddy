import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { PermissionLevel, RightTabId } from '../types';
import styles from './RightDrawer.module.css';

interface RightDrawerProps {
  open: boolean;
  activeTab: RightTabId;
  rootPath: string;
  sessionId: string;
  permissionLevel: PermissionLevel;
  token: string;
  inspectTargetFile: string;
  onSelectTab: (tab: RightTabId) => void;
  onClose: () => void;
  onInjectQuote: (snippet: string) => void;
  onShowToast: (msg: string) => void;
  onRefreshDiffBadge: () => void;
}

const TABS: Array<{ id: RightTabId; label: string }> = [
  { id: 'diff', label: 'Diff' },
  { id: 'files', label: '文件' },
  { id: 'git', label: 'Git' },
  { id: 'artifacts', label: '产物' },
  { id: 'pty', label: '终端' }
];

type LazyComp = ComponentType<Record<string, unknown>>;

export function RightDrawer(props: RightDrawerProps) {
  const {
    open,
    activeTab,
    rootPath,
    sessionId,
    permissionLevel,
    token,
    inspectTargetFile,
    onSelectTab,
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
          setLoadError(`模块加载失败: ${(err as Error).message}`);
        }
      }
    };
    load();
    return () => {
      canceled = true;
    };
  }, [open, activeTab, loaded]);

  const ActiveComp = loaded[activeTab];

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.tabs} data-hscroll="1" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={activeTab === t.id}
              className={`${styles.tabBtn} ${activeTab === t.id ? styles.tabActive : ''}`}
              onClick={() => onSelectTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.closeBtn}
          aria-label="关闭右侧工作区抽屉"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className={styles.content}>
        {!open ? null : loadError ? (
          <div className="ag-empty">{loadError}</div>
        ) : !ActiveComp ? (
          <div className="ag-empty">正在按需加载 {activeTab} 模块...</div>
        ) : (
          <ActiveComp
            rootPath={rootPath}
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
