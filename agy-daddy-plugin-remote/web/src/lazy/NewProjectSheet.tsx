import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import { BottomSheet } from '../layout/BottomSheet';
import { api } from '../store/api';
import type {
  GithubRepoItem,
  HostProject,
  PermissionLevel,
  RemotePreflightResponse,
  RemoteProvisionJob,
  RemoteProvisionMode,
  SessionGroup,
  StartRemoteJobRequest,
  WorkspaceBrowseResponse
} from '../types';
import styles from './NewProjectSheet.module.css';

type TabKind = 'local' | 'github' | 'gdrive';

export interface NewProjectSheetProps {
  open: boolean;
  permissionLevel: PermissionLevel;
  groups: SessionGroup[];
  defaultSessionPath?: string;
  latestJobEvent?: RemoteProvisionJob | null;
  onCreateLocalProject: (req: {
    name?: string;
    rootPath: string;
    groupId?: string | null;
    createDir?: boolean;
  }) => Promise<HostProject | null>;
  onRemoteCreated: (project?: HostProject | null) => Promise<void>;
  onShowToast: (msg: string) => void;
  onClose: () => void;
}

function basenameOf(p: string): string {
  const clean = p.replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

interface DirBrowserPaneProps {
  selectedPath: string;
  initialPath?: string;
  onSelectPath: (path: string) => void;
  onShowToast: (msg: string) => void;
}

function DirBrowserPane({
  selectedPath,
  initialPath,
  onSelectPath,
  onShowToast
}: DirBrowserPaneProps) {
  const { t } = useI18n();
  const [browse, setBrowse] = useState<WorkspaceBrowseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [showMkdir, setShowMkdir] = useState(false);
  const [mkdirName, setMkdirName] = useState('');
  const [mkdirBusy, setMkdirBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadPath = useCallback(
    async (targetPath?: string, hidden = showHidden) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const res = await api.browseWorkspace(targetPath || undefined, hidden, ctrl.signal);
        if (!ctrl.signal.aborted) {
          setBrowse(res);
          if (!targetPath && res.resolvedPath) {
            onSelectPath(res.resolvedPath);
          }
        }
      } catch (err) {
        if ((err as { name?: string })?.name !== 'AbortError') {
          onShowToast((err as Error).message);
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    [onSelectPath, onShowToast, showHidden]
  );

  useEffect(() => {
    void loadPath(initialPath || undefined, showHidden);
    return () => abortRef.current?.abort();
  }, [initialPath, showHidden, loadPath]);

  const activeDir = browse?.resolvedPath || selectedPath;

  const handleMkdir = async () => {
    const clean = mkdirName.trim();
    if (!clean || !activeDir) return;
    setMkdirBusy(true);
    try {
      const res = await api.mkdirWorkspace(activeDir, clean);
      setMkdirName('');
      setShowMkdir(false);
      onSelectPath(res.path);
      await loadPath(res.path, showHidden);
    } catch (err) {
      onShowToast((err as Error).message);
    } finally {
      setMkdirBusy(false);
    }
  };

  return (
    <div className={styles.card} data-testid="dir-browser-pane">
      {browse?.shortcuts && browse.shortcuts.length > 0 && (
        <div className={styles.hScroll} data-hscroll="1">
          {browse.shortcuts.map((sc) => (
            <button
              key={`${sc.kind}:${sc.path}`}
              type="button"
              className={styles.chipBtn}
              onClick={() => {
                onSelectPath(sc.path);
                void loadPath(sc.path, showHidden);
              }}
            >
              {sc.kind === 'home'
                ? t('newProject.shortcutHome')
                : sc.kind === 'default'
                  ? t('newProject.shortcutDefault')
                  : sc.label}
            </button>
          ))}
        </div>
      )}

      {browse?.breadcrumbs && browse.breadcrumbs.length > 0 && (
        <div className={styles.hScroll} data-hscroll="1">
          {browse.breadcrumbs.map((bc) => (
            <button
              key={bc.path}
              type="button"
              className={styles.chipBtn}
              onClick={() => {
                onSelectPath(bc.path);
                void loadPath(bc.path, showHidden);
              }}
            >
              {bc.name || '/'}
            </button>
          ))}
        </div>
      )}

      <div className={styles.toolbarRow}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            className={styles.btn}
            disabled={!browse?.parentPath || loading}
            onClick={() => {
              if (!browse?.parentPath) return;
              onSelectPath(browse.parentPath);
              void loadPath(browse.parentPath, showHidden);
            }}
          >
            ↑ {t('newProject.upDir')}
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={() => setShowMkdir((v) => !v)}
          >
            {t('newProject.newFolderBtn')}
          </button>
        </div>

        <label className={styles.checkboxRow} style={{ minHeight: 44 }}>
          <input
            type="checkbox"
            className={styles.checkboxInput}
            checked={showHidden}
            onChange={(e) => setShowHidden((e.target as HTMLInputElement).checked)}
          />
          <span style={{ fontSize: 12 }}>{t('newProject.showHidden')}</span>
        </label>
      </div>

      {showMkdir && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="text"
            className="ag-input"
            placeholder={t('newProject.newFolderPlaceholder')}
            value={mkdirName}
            onInput={(e) => setMkdirName((e.target as HTMLInputElement).value)}
          />
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={mkdirBusy || !mkdirName.trim()}
            onClick={handleMkdir}
          >
            {t('newProject.newFolderCreate')}
          </button>
        </div>
      )}

      {browse && !browse.exists && browse.willCreateRelative && (
        <div className={styles.hint}>
          {t('newProject.willCreateHint', { rel: browse.willCreateRelative })}
        </div>
      )}

      <div className={styles.dirList}>
        {loading && !browse ? (
          <div style={{ padding: 12 }} className={styles.hint}>
            {t('newProject.browseLoading')}
          </div>
        ) : !browse || browse.entries.length === 0 ? (
          <div style={{ padding: 12 }} className={styles.hint}>
            {t('newProject.emptyDir')}
          </div>
        ) : (
          browse.entries.map((entry) => {
            const isSel = selectedPath === entry.path;
            return (
              <div
                key={entry.path}
                className={`${styles.dirRow} ${isSel ? styles.dirRowSelected : ''}`}
              >
                <button
                  type="button"
                  className={styles.dirPickBtn}
                  onClick={() => onSelectPath(entry.path)}
                >
                  <span className={styles.dirName}>{entry.name}</span>
                  {entry.isGitRepo && (
                    <span className={styles.gitBadge}>{t('newProject.gitBadge')}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={styles.enterBtn}
                  aria-label={t('newProject.enterDirAria', { name: entry.name })}
                  onClick={() => {
                    onSelectPath(entry.path);
                    void loadPath(entry.path, showHidden);
                  }}
                >
                  ›
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export function NewProjectSheet({
  open,
  permissionLevel,
  groups,
  defaultSessionPath = '',
  latestJobEvent,
  onCreateLocalProject,
  onRemoteCreated,
  onShowToast,
  onClose
}: NewProjectSheetProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<TabKind>('local');
  const [groupId, setGroupId] = useState<string>('');

  // Local tab state
  const [localPath, setLocalPath] = useState(defaultSessionPath);
  const [browseSyncTarget, setBrowseSyncTarget] = useState(defaultSessionPath);
  const [projectName, setProjectName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [createDir, setCreateDir] = useState(true);
  const [localSubmitting, setLocalSubmitting] = useState(false);

  // Remote preflight
  const [preflight, setPreflight] = useState<RemotePreflightResponse | null>(null);
  const [checkingPreflight, setCheckingPreflight] = useState(false);

  // GitHub tab state
  const [ghMode, setGhMode] = useState<'gh_clone' | 'gh_create_and_clone'>('gh_clone');
  const [ghRepoSpec, setGhRepoSpec] = useState('');
  const [ghBranch, setGhBranch] = useState('');
  const [ghNewRepoName, setGhNewRepoName] = useState('');
  const [ghOwner, setGhOwner] = useState('');
  const [ghVisibility, setGhVisibility] = useState<'private' | 'public'>('private');
  const [ghDesc, setGhDesc] = useState('');
  const [ghAddReadme, setGhAddReadme] = useState(false);
  const [repos, setRepos] = useState<GithubRepoItem[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [showRepoPicker, setShowRepoPicker] = useState(false);

  // Google Drive tab state
  const [gdMountMode, setGdMountMode] = useState<'gdrive_mount_select' | 'gdrive_mount_mkdir'>(
    'gdrive_mount_select'
  );
  const [gdSelectedMountPath, setGdSelectedMountPath] = useState('');
  const [gdCliMode, setGdCliMode] = useState<'gdrive_cli_pull' | 'gdrive_cli_mkdir'>(
    'gdrive_cli_pull'
  );
  const [gdRemoteName, setGdRemoteName] = useState('gdrive');
  const [gdFolderIdOrPath, setGdFolderIdOrPath] = useState('');

  // Shared remote target parent & folder
  const [parentDir, setParentDir] = useState(defaultSessionPath);
  const [localDirName, setLocalDirName] = useState('');

  // Async job state
  const [activeJob, setActiveJob] = useState<RemoteProvisionJob | null>(null);
  const [startingJob, setStartingJob] = useState(false);
  const [cancellingJob, setCancellingJob] = useState(false);

  const isL2 = permissionLevel === 'L2';

  useEffect(() => {
    if (!open) return;
    if (defaultSessionPath) {
      setLocalPath((prev) => prev || defaultSessionPath);
      setBrowseSyncTarget((prev) => prev || defaultSessionPath);
      setParentDir((prev) => prev || defaultSessionPath);
    }
  }, [open, defaultSessionPath]);

  // Debounce typed local path -> browse pane sync
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (localPath.trim()) setBrowseSyncTarget(localPath.trim());
    }, 400);
    return () => window.clearTimeout(timer);
  }, [localPath]);

  // Derive default project name when path changes
  useEffect(() => {
    if (!nameEdited && localPath.trim()) {
      const derived = basenameOf(localPath.trim());
      if (derived) setProjectName(derived);
    }
  }, [localPath, nameEdited]);

  const loadPreflight = useCallback(async () => {
    setCheckingPreflight(true);
    try {
      const res = await api.getRemotePreflight('all');
      setPreflight(res);
      const firstMount = res.gdrive?.mounts?.[0];
      if (firstMount && !gdSelectedMountPath) {
        setGdSelectedMountPath(firstMount.myDrivePath || firstMount.rootPath);
      }
      const firstRemote = res.gdrive?.rclone?.driveRemotes?.[0];
      if (firstRemote) setGdRemoteName(firstRemote);
    } catch (err) {
      onShowToast((err as Error).message);
    } finally {
      setCheckingPreflight(false);
    }
  }, [gdSelectedMountPath, onShowToast]);

  useEffect(() => {
    if (open && (tab === 'github' || tab === 'gdrive') && !preflight) {
      void loadPreflight();
    }
  }, [open, tab, preflight, loadPreflight]);

  // Reconcile SSE job updates
  useEffect(() => {
    if (!latestJobEvent || !activeJob || latestJobEvent.jobId !== activeJob.jobId) return;
    setActiveJob(latestJobEvent);
    if (latestJobEvent.status === 'succeeded') {
      void onRemoteCreated(latestJobEvent.project).then(() => onClose());
    }
  }, [latestJobEvent, activeJob, onRemoteCreated, onClose]);

  // Poll job while running
  useEffect(() => {
    if (!open || !activeJob || activeJob.status !== 'running') return;
    const ctrl = new AbortController();
    const timer = window.setInterval(async () => {
      try {
        const res = await api.getRemoteProjectJob(activeJob.jobId, ctrl.signal);
        if (res?.job) {
          setActiveJob(res.job);
          if (res.job.status === 'succeeded') {
            window.clearInterval(timer);
            await onRemoteCreated(res.job.project);
            onClose();
          }
        }
      } catch {}
    }, 900);
    return () => {
      ctrl.abort();
      window.clearInterval(timer);
    };
  }, [open, activeJob, onRemoteCreated, onClose]);

  const handleBrowsePickLocal = useCallback(
    (p: string) => {
      setLocalPath(p);
      if (!nameEdited) {
        const derived = basenameOf(p);
        if (derived) setProjectName(derived);
      }
    },
    [nameEdited]
  );

  const handleLocalSubmit = async () => {
    const cleanPath = localPath.trim();
    if (!cleanPath || !isL2) return;
    setLocalSubmitting(true);
    try {
      const created = await onCreateLocalProject({
        rootPath: cleanPath,
        name: projectName.trim() || basenameOf(cleanPath) || cleanPath,
        groupId: groupId || null,
        createDir
      });
      if (created) onClose();
    } finally {
      setLocalSubmitting(false);
    }
  };

  const handleLoadRepos = async () => {
    setShowRepoPicker(true);
    setLoadingRepos(true);
    try {
      const res = await api.listGithubRepos(undefined, 30);
      setRepos(Array.isArray(res.repos) ? res.repos : []);
    } catch (err) {
      onShowToast((err as Error).message);
    } finally {
      setLoadingRepos(false);
    }
  };

  const startJob = async (req: StartRemoteJobRequest) => {
    if (!isL2) return;
    setStartingJob(true);
    try {
      const res = await api.startRemoteProjectJob(req);
      setActiveJob(res.job);
    } catch (err) {
      onShowToast((err as Error).message);
    } finally {
      setStartingJob(false);
    }
  };

  const handleGithubSubmit = async () => {
    const partialRepo =
      activeJob?.status === 'failed' && activeJob.remoteCreated?.ownerRepo
        ? activeJob.remoteCreated.ownerRepo
        : '';

    const mode: RemoteProvisionMode = partialRepo ? 'gh_clone' : ghMode;
    const repoSpec = partialRepo || ghRepoSpec.trim();
    const dirName =
      localDirName.trim() ||
      (mode === 'gh_clone'
        ? basenameOf(repoSpec.replace(/\.git$/, ''))
        : ghNewRepoName.trim());
    const finalName = projectName.trim() || dirName;

    await startJob({
      provider: 'github',
      mode,
      parentDir: parentDir.trim() || defaultSessionPath,
      localDirName: dirName,
      projectName: finalName,
      groupId: groupId || null,
      github:
        mode === 'gh_clone'
          ? {
              repoSpec,
              branch: ghBranch.trim() || undefined
            }
          : {
              newRepoName: ghNewRepoName.trim(),
              owner: ghOwner || undefined,
              visibility: ghVisibility,
              description: ghDesc.trim() || undefined,
              addReadme: ghAddReadme
            }
    });
  };

  const handleGdriveSubmit = async () => {
    const gd = preflight?.gdrive;
    if (!gd || gd.tier === 'unavailable') return;
    const isMount = gd.tier === 'mount';
    const mode: RemoteProvisionMode = isMount ? gdMountMode : gdCliMode;
    const activeMount = gd.mounts[0];
    const dirName = localDirName.trim() || basenameOf(gdSelectedMountPath) || projectName.trim();
    const finalName = projectName.trim() || dirName || 'drive-project';

    await startJob({
      provider: 'gdrive',
      mode,
      parentDir: isMount
        ? gdSelectedMountPath || activeMount?.myDrivePath || activeMount?.rootPath || ''
        : parentDir.trim() || defaultSessionPath,
      localDirName: dirName,
      projectName: finalName,
      groupId: groupId || null,
      gdrive: isMount
        ? {
            mountPath: gdSelectedMountPath || activeMount?.myDrivePath || activeMount?.rootPath,
            account: activeMount?.account || undefined
          }
        : {
            cliTool: gd.rclone.installed ? 'rclone' : 'gdrive',
            remoteName: gdRemoteName.trim() || undefined,
            folderIdOrPath: gdFolderIdOrPath.trim() || undefined
          }
    });
  };

  const stepLabel = useMemo(() => {
    const step = activeJob?.step || '';
    switch (step) {
      case 'validating':
        return t('newProject.jobStepValidating');
      case 'creating_remote':
        return t('newProject.jobStepCreatingRemote');
      case 'cloning':
        return t('newProject.jobStepCloning');
      case 'preparing_mount':
        return t('newProject.jobStepPreparingMount');
      case 'pulling':
        return t('newProject.jobStepPulling');
      case 'registering':
        return t('newProject.jobStepRegistering');
      default:
        return activeJob?.message || step;
    }
  }, [activeJob, t]);

  const jobRunning = activeJob?.status === 'running';
  const gh = preflight?.github;
  const gd = preflight?.gdrive;

  return (
    <BottomSheet
      open={open}
      title={t('newProject.title')}
      testId="new-project-sheet"
      maxHeightCss="92dvh"
      onClose={onClose}
    >
      <div className={styles.content}>
        {!isL2 && <div className={styles.warnCard}>{t('newProject.l2RequiredHint')}</div>}

        <div className={styles.segmented} role="tablist">
          {(
            [
              ['local', t('newProject.tabLocal')],
              ['github', t('newProject.tabGithub')],
              ['gdrive', t('newProject.tabGdrive')]
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`${styles.segBtn} ${tab === id ? styles.segBtnActive : ''}`}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        {activeJob && (
          <div className={activeJob.status === 'failed' ? styles.errorCard : styles.jobBox}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <strong>{stepLabel}</strong>
              {jobRunning && (
                <button
                  type="button"
                  className={styles.btn}
                  disabled={cancellingJob}
                  onClick={async () => {
                    setCancellingJob(true);
                    try {
                      await api.cancelRemoteProjectJob(activeJob.jobId);
                    } finally {
                      setCancellingJob(false);
                    }
                  }}
                >
                  {cancellingJob ? t('newProject.jobCancelling') : t('newProject.jobCancel')}
                </button>
              )}
            </div>
            {activeJob.status === 'failed' && activeJob.remoteCreated?.ownerRepo && (
              <div>
                {t('newProject.ghPartialCreated', { repo: activeJob.remoteCreated.ownerRepo })}
              </div>
            )}
            {activeJob.error && <div>{activeJob.error}</div>}
          </div>
        )}

        {tab === 'local' && (
          <>
            <div className={styles.card}>
              <label className={styles.field}>
                <span className={styles.label}>{t('newProject.pathLabel')}</span>
                <input
                  type="text"
                  className="ag-input"
                  placeholder={t('newProject.pathPlaceholder')}
                  value={localPath}
                  onInput={(e) => setLocalPath((e.target as HTMLInputElement).value)}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>{t('newProject.nameLabel')}</span>
                <input
                  type="text"
                  className="ag-input"
                  placeholder={t('newProject.namePlaceholder')}
                  value={projectName}
                  onInput={(e) => {
                    setNameEdited(true);
                    setProjectName((e.target as HTMLInputElement).value);
                  }}
                />
              </label>
              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  className={styles.checkboxInput}
                  checked={createDir}
                  onChange={(e) => setCreateDir((e.target as HTMLInputElement).checked)}
                />
                <span>{t('newProject.createDirMissing')}</span>
              </label>
            </div>

            <DirBrowserPane
              selectedPath={localPath}
              initialPath={browseSyncTarget}
              onSelectPath={handleBrowsePickLocal}
              onShowToast={onShowToast}
            />
          </>
        )}

        {tab === 'github' && (
          <>
            <div className={styles.toolbarRow}>
              <span className={styles.hint}>
                {gh?.ghAuthenticated && gh.activeAccount
                  ? t('newProject.ghAuthedAs', { account: gh.activeAccount })
                  : checkingPreflight
                    ? t('newProject.checkingEnv')
                    : ''}
              </span>
              <button
                type="button"
                className={styles.btn}
                disabled={checkingPreflight}
                onClick={() => void loadPreflight()}
              >
                {checkingPreflight ? t('newProject.checkingEnv') : t('newProject.recheckEnv')}
              </button>
            </div>

            {gh && !gh.gitInstalled ? (
              <div className={styles.warnCard}>
                <div>{t('newProject.ghGitMissing', { hint: gh.installHints?.git || 'git' })}</div>
                {gh.installHints?.git && <code>{gh.installHints.git}</code>}
              </div>
            ) : (
              <>
                <div className={`${styles.segmented} ${styles.segmentedTwo}`}>
                  <button
                    type="button"
                    className={`${styles.segBtn} ${ghMode === 'gh_clone' ? styles.segBtnActive : ''}`}
                    onClick={() => setGhMode('gh_clone')}
                  >
                    {t('newProject.ghModeClone')}
                  </button>
                  <button
                    type="button"
                    className={`${styles.segBtn} ${
                      ghMode === 'gh_create_and_clone' ? styles.segBtnActive : ''
                    }`}
                    onClick={() => setGhMode('gh_create_and_clone')}
                  >
                    {t('newProject.ghModeCreate')}
                  </button>
                </div>

                {ghMode === 'gh_create_and_clone' && gh && !gh.ghAuthenticated && (
                  <div className={styles.warnCard}>
                    <div>
                      {t('newProject.ghNotAuthed', {
                        hint: gh.installHints?.ghLogin || 'gh auth login'
                      })}
                    </div>
                    {gh.installHints?.ghLogin && <code>{gh.installHints.ghLogin}</code>}
                  </div>
                )}

                <div className={styles.card}>
                  {ghMode === 'gh_clone' ? (
                    <>
                      <label className={styles.field}>
                        <span className={styles.label}>{t('newProject.ghRepoSpecLabel')}</span>
                        <input
                          type="text"
                          className="ag-input"
                          placeholder={t('newProject.ghRepoSpecPlaceholder')}
                          value={ghRepoSpec}
                          onInput={(e) => setGhRepoSpec((e.target as HTMLInputElement).value)}
                        />
                      </label>
                      {gh?.ghAuthenticated && (
                        <div>
                          <button type="button" className={styles.btn} onClick={handleLoadRepos}>
                            {loadingRepos
                              ? t('newProject.ghLoadingRepos')
                              : t('newProject.ghPickMyRepo')}
                          </button>
                        </div>
                      )}
                      {showRepoPicker && repos.length > 0 && (
                        <div className={styles.repoList}>
                          {repos.map((r) => (
                            <button
                              key={r.nameWithOwner}
                              type="button"
                              className={styles.repoRow}
                              onClick={() => {
                                setGhRepoSpec(r.nameWithOwner);
                                if (!localDirName) {
                                  setLocalDirName(r.nameWithOwner.split('/').pop() || '');
                                }
                                if (!nameEdited) {
                                  setProjectName(r.nameWithOwner.split('/').pop() || '');
                                }
                                setShowRepoPicker(false);
                              }}
                            >
                              <span>{r.nameWithOwner}</span>
                              <span className={styles.hint}>
                                {r.isPrivate
                                  ? t('newProject.ghVisibilityPrivate')
                                  : t('newProject.ghVisibilityPublic')}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                      <label className={styles.field}>
                        <span className={styles.label}>{t('newProject.ghBranchLabel')}</span>
                        <input
                          type="text"
                          className="ag-input"
                          placeholder={t('newProject.ghBranchPlaceholder')}
                          value={ghBranch}
                          onInput={(e) => setGhBranch((e.target as HTMLInputElement).value)}
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <label className={styles.field}>
                        <span className={styles.label}>{t('newProject.ghNewRepoNameLabel')}</span>
                        <input
                          type="text"
                          className="ag-input"
                          placeholder={t('newProject.ghNewRepoNamePlaceholder')}
                          value={ghNewRepoName}
                          onInput={(e) => {
                            const v = (e.target as HTMLInputElement).value;
                            setGhNewRepoName(v);
                            if (!localDirName) setLocalDirName(v);
                            if (!nameEdited) setProjectName(v);
                          }}
                        />
                      </label>
                      <label className={styles.field}>
                        <span className={styles.label}>{t('newProject.ghOwnerLabel')}</span>
                        <select
                          className="ag-select"
                          value={ghOwner}
                          onChange={(e) => setGhOwner((e.target as HTMLSelectElement).value)}
                        >
                          <option value="">
                            {t('newProject.ghPersonalAccount', {
                              account: gh?.activeAccount || 'personal'
                            })}
                          </option>
                          {(gh?.orgs || []).map((org) => (
                            <option key={org} value={org}>
                              {org}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.field}>
                        <span className={styles.label}>{t('newProject.ghVisibilityLabel')}</span>
                        <select
                          className="ag-select"
                          value={ghVisibility}
                          onChange={(e) =>
                            setGhVisibility(
                              (e.target as HTMLSelectElement).value as 'private' | 'public'
                            )
                          }
                        >
                          <option value="private">{t('newProject.ghVisibilityPrivate')}</option>
                          <option value="public">{t('newProject.ghVisibilityPublic')}</option>
                        </select>
                      </label>
                      <label className={styles.field}>
                        <span className={styles.label}>{t('newProject.ghDescLabel')}</span>
                        <input
                          type="text"
                          className="ag-input"
                          placeholder={t('newProject.ghDescPlaceholder')}
                          value={ghDesc}
                          onInput={(e) => setGhDesc((e.target as HTMLInputElement).value)}
                        />
                      </label>
                      <label className={styles.checkboxRow}>
                        <input
                          type="checkbox"
                          className={styles.checkboxInput}
                          checked={ghAddReadme}
                          onChange={(e) => setGhAddReadme((e.target as HTMLInputElement).checked)}
                        />
                        <span>{t('newProject.ghAddReadme')}</span>
                      </label>
                    </>
                  )}

                  <label className={styles.field}>
                    <span className={styles.label}>{t('newProject.parentDirLabel')}</span>
                    <input
                      type="text"
                      className="ag-input"
                      value={parentDir}
                      onInput={(e) => setParentDir((e.target as HTMLInputElement).value)}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.label}>{t('newProject.folderNameLabel')}</span>
                    <input
                      type="text"
                      className="ag-input"
                      placeholder={t('newProject.folderNamePlaceholder')}
                      value={localDirName}
                      onInput={(e) => setLocalDirName((e.target as HTMLInputElement).value)}
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.label}>{t('newProject.nameLabel')}</span>
                    <input
                      type="text"
                      className="ag-input"
                      placeholder={t('newProject.namePlaceholder')}
                      value={projectName}
                      onInput={(e) => {
                        setNameEdited(true);
                        setProjectName((e.target as HTMLInputElement).value);
                      }}
                    />
                  </label>
                </div>
              </>
            )}
          </>
        )}

        {tab === 'gdrive' && (
          <>
            <div className={styles.toolbarRow}>
              <span className={styles.hint}>
                {checkingPreflight ? t('newProject.checkingEnv') : ''}
              </span>
              <button
                type="button"
                className={styles.btn}
                disabled={checkingPreflight}
                onClick={() => void loadPreflight()}
              >
                {checkingPreflight ? t('newProject.checkingEnv') : t('newProject.recheckEnv')}
              </button>
            </div>

            {gd?.tier === 'mount' && (
              <>
                <div className={styles.card}>
                  <strong>{t('newProject.gdMountTierTitle')}</strong>
                  <div className={styles.hint}>{t('newProject.gdMountSyncNote')}</div>
                  <div className={`${styles.segmented} ${styles.segmentedTwo}`}>
                    <button
                      type="button"
                      className={`${styles.segBtn} ${
                        gdMountMode === 'gdrive_mount_select' ? styles.segBtnActive : ''
                      }`}
                      onClick={() => setGdMountMode('gdrive_mount_select')}
                    >
                      {t('newProject.gdMountModeSelect')}
                    </button>
                    <button
                      type="button"
                      className={`${styles.segBtn} ${
                        gdMountMode === 'gdrive_mount_mkdir' ? styles.segBtnActive : ''
                      }`}
                      onClick={() => setGdMountMode('gdrive_mount_mkdir')}
                    >
                      {t('newProject.gdMountModeMkdir')}
                    </button>
                  </div>
                  <label className={styles.field}>
                    <span className={styles.label}>{t('newProject.gdSelectMount')}</span>
                    <select
                      className="ag-select"
                      value={gdSelectedMountPath}
                      onChange={(e) =>
                        setGdSelectedMountPath((e.target as HTMLSelectElement).value)
                      }
                    >
                      {gd.mounts.map((m) => (
                        <option key={m.id} value={m.myDrivePath || m.rootPath}>
                          {m.account || m.id} ({m.myDrivePath || m.rootPath})
                        </option>
                      ))}
                    </select>
                  </label>
                  {gdMountMode === 'gdrive_mount_mkdir' && (
                    <label className={styles.field}>
                      <span className={styles.label}>{t('newProject.folderNameLabel')}</span>
                      <input
                        type="text"
                        className="ag-input"
                        placeholder={t('newProject.folderNamePlaceholder')}
                        value={localDirName}
                        onInput={(e) => setLocalDirName((e.target as HTMLInputElement).value)}
                      />
                    </label>
                  )}
                  <label className={styles.field}>
                    <span className={styles.label}>{t('newProject.nameLabel')}</span>
                    <input
                      type="text"
                      className="ag-input"
                      placeholder={t('newProject.namePlaceholder')}
                      value={projectName}
                      onInput={(e) => {
                        setNameEdited(true);
                        setProjectName((e.target as HTMLInputElement).value);
                      }}
                    />
                  </label>
                </div>
                {gdSelectedMountPath && (
                  <DirBrowserPane
                    selectedPath={gdSelectedMountPath}
                    initialPath={gdSelectedMountPath}
                    onSelectPath={setGdSelectedMountPath}
                    onShowToast={onShowToast}
                  />
                )}
              </>
            )}

            {gd?.tier === 'cli' && (
              <div className={styles.card}>
                <strong>
                  {t('newProject.gdCliTierTitle', {
                    tool: gd.rclone?.installed ? 'rclone' : 'gdrive'
                  })}
                </strong>
                <div className={styles.hint}>{t('newProject.gdCliSyncNote')}</div>
                <div className={`${styles.segmented} ${styles.segmentedTwo}`}>
                  <button
                    type="button"
                    className={`${styles.segBtn} ${
                      gdCliMode === 'gdrive_cli_pull' ? styles.segBtnActive : ''
                    }`}
                    onClick={() => setGdCliMode('gdrive_cli_pull')}
                  >
                    {t('newProject.gdCliModePull')}
                  </button>
                  <button
                    type="button"
                    className={`${styles.segBtn} ${
                      gdCliMode === 'gdrive_cli_mkdir' ? styles.segBtnActive : ''
                    }`}
                    onClick={() => setGdCliMode('gdrive_cli_mkdir')}
                  >
                    {t('newProject.gdCliModeMkdir')}
                  </button>
                </div>
                <label className={styles.field}>
                  <span className={styles.label}>{t('newProject.gdRemoteLabel')}</span>
                  <input
                    type="text"
                    className="ag-input"
                    value={gdRemoteName}
                    onInput={(e) => setGdRemoteName((e.target as HTMLInputElement).value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>{t('newProject.gdFolderIdLabel')}</span>
                  <input
                    type="text"
                    className="ag-input"
                    placeholder={t('newProject.gdFolderIdPlaceholder')}
                    value={gdFolderIdOrPath}
                    onInput={(e) => setGdFolderIdOrPath((e.target as HTMLInputElement).value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>{t('newProject.parentDirLabel')}</span>
                  <input
                    type="text"
                    className="ag-input"
                    value={parentDir}
                    onInput={(e) => setParentDir((e.target as HTMLInputElement).value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>{t('newProject.folderNameLabel')}</span>
                  <input
                    type="text"
                    className="ag-input"
                    placeholder={t('newProject.folderNamePlaceholder')}
                    value={localDirName}
                    onInput={(e) => setLocalDirName((e.target as HTMLInputElement).value)}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>{t('newProject.nameLabel')}</span>
                  <input
                    type="text"
                    className="ag-input"
                    placeholder={t('newProject.namePlaceholder')}
                    value={projectName}
                    onInput={(e) => {
                      setNameEdited(true);
                      setProjectName((e.target as HTMLInputElement).value);
                    }}
                  />
                </label>
              </div>
            )}

            {(!gd || gd.tier === 'unavailable') && (
              <div className={styles.card} data-testid="gdrive-unavailable-card">
                <strong>{t('newProject.gdUnavailableTitle')}</strong>
                <div className={styles.hint}>{t('newProject.gdUnavailableDesc')}</div>
                <div className={styles.checkList}>
                  <div>• {t('newProject.gdCheckMountMissing')}</div>
                  <div>• {t('newProject.gdCheckRcloneMissing')}</div>
                  <div>• {t('newProject.gdCheckGdriveMissing')}</div>
                  {gd?.setupHints?.map((hint, idx) => (
                    <div key={idx}>• {hint}</div>
                  ))}
                </div>
                <div className={styles.footerActions}>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => void loadPreflight()}
                  >
                    {t('newProject.recheckEnv')}
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => setTab('local')}
                  >
                    {t('newProject.gdSwitchToLocal')}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        <div className={styles.card}>
          <label className={styles.field}>
            <span className={styles.label}>{t('newProject.groupLabel')}</span>
            <select
              className="ag-select"
              value={groupId}
              onChange={(e) => setGroupId((e.target as HTMLSelectElement).value)}
            >
              <option value="">{t('left.unassigned')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className={styles.footerActions}>
          <button type="button" className={styles.btn} onClick={onClose}>
            {t('common.cancel')}
          </button>

          {tab === 'local' && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={!isL2 || localSubmitting || !localPath.trim()}
              onClick={() => void handleLocalSubmit()}
            >
              {localSubmitting ? t('newProject.submitting') : t('newProject.submitLocal')}
            </button>
          )}

          {tab === 'github' && gh?.gitInstalled && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={
                !isL2 ||
                startingJob ||
                jobRunning ||
                (activeJob?.status === 'failed' && activeJob.remoteCreated?.ownerRepo
                  ? false
                  : ghMode === 'gh_clone'
                    ? !ghRepoSpec.trim()
                    : !gh.ghAuthenticated || !ghNewRepoName.trim())
              }
              onClick={() => void handleGithubSubmit()}
            >
              {activeJob?.status === 'failed' && activeJob.remoteCreated?.ownerRepo
                ? t('newProject.ghRetryClone')
                : startingJob || jobRunning
                  ? t('newProject.submitting')
                  : ghMode === 'gh_create_and_clone'
                    ? t('newProject.ghSubmitCreate')
                    : t('newProject.ghSubmitClone')}
            </button>
          )}

          {tab === 'gdrive' && gd && gd.tier !== 'unavailable' && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={!isL2 || startingJob || jobRunning}
              onClick={() => void handleGdriveSubmit()}
            >
              {startingJob || jobRunning
                ? t('newProject.submitting')
                : gd.tier === 'mount'
                  ? t('newProject.gdSubmitMount')
                  : t('newProject.gdSubmitCli')}
            </button>
          )}
        </div>
      </div>
    </BottomSheet>
  );
}

export default NewProjectSheet;
