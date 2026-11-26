import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, apiClient } from '../api/client';
import { useI18n, type TranslateFn } from '../i18n';
import type {
  CreateProjectRequest,
  GithubRepoItem,
  ProjectGroup,
  ProjectItem,
  RemotePreflightResponse,
  RemoteProvisionJob,
  StartRemoteJobRequest,
  WorkspaceBrowseResponse,
} from '../types';
import styles from './NewProjectModal.module.css';

export type NewProjectTab = 'local' | 'github' | 'gdrive';

export interface NewProjectModalProps {
  open: boolean;
  groups: ProjectGroup[];
  defaultSessionPath?: string;
  canAdminWorkspace: boolean;
  latestJobEvent?: RemoteProvisionJob | null;
  onClose: () => void;
  onCreateLocalProject: (payload: CreateProjectRequest) => Promise<ProjectItem | null>;
  onProjectCreated: (project: ProjectItem) => void;
}

function basenameOfPath(rawPath: string): string {
  const cleaned = rawPath.replace(/[\\/]+$/, '');
  if (!cleaned) return '';
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

function joinLocalPath(parentDir: string, folderName: string): string {
  const cleanParent = parentDir.replace(/[\\/]+$/, '');
  const cleanName = folderName.replace(/^[\\/]+/, '');
  if (!cleanParent) return cleanName;
  if (!cleanName) return cleanParent;
  const sep = cleanParent.includes('\\') && !cleanParent.includes('/') ? '\\' : '/';
  return `${cleanParent}${sep}${cleanName}`;
}

function extractRepoNameFromSpec(spec: string): string {
  const trimmed = spec.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!trimmed) return '';
  const parts = trimmed.split(/[/:]/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

interface DirBrowserPaneProps {
  currentPath: string;
  selectedPath: string;
  t: TranslateFn;
  disabled?: boolean;
  onSelectDir: (dirPath: string) => void;
  onEnterDir: (dirPath: string) => void;
  onBrowseError: (msg: string | null) => void;
}

function DirBrowserPane({
  currentPath,
  selectedPath,
  t,
  disabled = false,
  onSelectDir,
  onEnterDir,
  onBrowseError,
}: DirBrowserPaneProps) {
  const [browseData, setBrowseData] = useState<WorkspaceBrowseResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [showMkdir, setShowMkdir] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);

  const loadDir = useCallback(
    async (targetPath: string | undefined, hiddenFlag: boolean, signal?: AbortSignal) => {
      if (typeof apiClient.browseWorkspace !== 'function') return;
      setLoading(true);
      try {
        const res = await apiClient.browseWorkspace(targetPath, hiddenFlag, signal);
        if (signal?.aborted) return;
        setBrowseData(res);
        onBrowseError(null);
      } catch (err) {
        if (signal?.aborted) return;
        const msg = err instanceof ApiError ? err.message || err.code : String(err);
        onBrowseError(msg);
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [onBrowseError],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadDir(currentPath || undefined, showHidden, controller.signal);
    return () => controller.abort();
  }, [currentPath, showHidden, loadDir]);

  const handleMkdir = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const parent = browseData?.resolvedPath || currentPath;
    const cleanName = newFolderName.trim();
    if (!parent || !cleanName || creatingFolder || typeof apiClient.mkdirWorkspace !== 'function') {
      return;
    }
    setCreatingFolder(true);
    try {
      const res = await apiClient.mkdirWorkspace(parent, cleanName);
      setNewFolderName('');
      setShowMkdir(false);
      onBrowseError(null);
      onSelectDir(res.path);
      onEnterDir(res.path);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message || err.code : String(err);
      onBrowseError(msg);
    } finally {
      setCreatingFolder(false);
    }
  };

  return (
    <div className={styles.browserCard} data-testid="dir-browser-pane">
      {browseData?.shortcuts && browseData.shortcuts.length > 0 && (
        <div className={styles.shortcutsBar} data-testid="dir-browser-shortcuts">
          {browseData.shortcuts.map((sc) => (
            <button
              key={sc.path}
              type="button"
              className={styles.shortcutChip}
              disabled={disabled}
              data-testid={`dir-shortcut-${sc.kind}`}
              onClick={() => {
                onSelectDir(sc.path);
                onEnterDir(sc.path);
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

      <div className={styles.browserNav}>
        <div className={styles.breadcrumbs} data-testid="dir-browser-breadcrumbs">
          {browseData?.breadcrumbs?.map((crumb, idx) => (
            <React.Fragment key={crumb.path}>
              {idx > 0 && <span className={styles.crumbSep}>/</span>}
              <button
                type="button"
                className={styles.crumbBtn}
                disabled={disabled}
                onClick={() => {
                  onSelectDir(crumb.path);
                  onEnterDir(crumb.path);
                }}
              >
                {crumb.name}
              </button>
            </React.Fragment>
          ))}
        </div>
        <div className={styles.browserTools}>
          {browseData?.parentPath && (
            <button
              type="button"
              className={styles.miniBtn}
              disabled={disabled}
              data-testid="dir-browser-up"
              onClick={() => {
                if (browseData.parentPath) {
                  onSelectDir(browseData.parentPath);
                  onEnterDir(browseData.parentPath);
                }
              }}
            >
              .. {t('newProject.upDir')}
            </button>
          )}
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={showHidden}
              disabled={disabled}
              data-testid="dir-browser-show-hidden"
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            <span>{t('newProject.showHidden')}</span>
          </label>
          <button
            type="button"
            className={styles.miniBtn}
            disabled={disabled}
            data-testid="dir-browser-mkdir-toggle"
            onClick={() => setShowMkdir((prev) => !prev)}
          >
            {t('newProject.newFolderBtn')}
          </button>
        </div>
      </div>

      {showMkdir && (
        <form
          className={styles.mkdirForm}
          onSubmit={(ev) => void handleMkdir(ev)}
          data-testid="dir-browser-mkdir-form"
        >
          <input
            type="text"
            className={styles.input}
            placeholder={t('newProject.newFolderPlaceholder')}
            value={newFolderName}
            disabled={disabled || creatingFolder}
            onChange={(e) => setNewFolderName(e.target.value)}
            data-testid="dir-browser-mkdir-input"
          />
          <button
            type="submit"
            className={styles.miniBtn}
            disabled={disabled || creatingFolder || !newFolderName.trim()}
            data-testid="dir-browser-mkdir-submit"
          >
            {t('newProject.newFolderCreate')}
          </button>
        </form>
      )}

      {browseData?.willCreateRelative && (
        <div className={styles.infoBox} data-testid="dir-browser-will-create">
          {t('newProject.willCreateHint', { rel: browseData.willCreateRelative })}
        </div>
      )}

      <div className={styles.dirList} data-testid="dir-browser-entries">
        {loading ? (
          <div className={styles.emptyDir}>{t('newProject.browseLoading')}</div>
        ) : !browseData || browseData.entries.length === 0 ? (
          <div className={styles.emptyDir}>{t('newProject.emptyDir')}</div>
        ) : (
          browseData.entries.map((ent) => {
            const isSelected = selectedPath === ent.path;
            return (
              <button
                key={ent.path}
                type="button"
                className={`${styles.dirRow} ${isSelected ? styles.dirRowSelected : ''}`}
                disabled={disabled}
                data-testid={`dir-entry-${ent.name}`}
                onClick={() => onSelectDir(ent.path)}
                onDoubleClick={() => {
                  onSelectDir(ent.path);
                  onEnterDir(ent.path);
                }}
              >
                <span className={styles.dirName}>{ent.name}</span>
                {ent.isGitRepo && (
                  <span className={styles.gitBadge}>{t('newProject.gitBadge')}</span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export function NewProjectModal({
  open,
  groups,
  defaultSessionPath = '',
  canAdminWorkspace,
  latestJobEvent,
  onClose,
  onCreateLocalProject,
  onProjectCreated,
}: NewProjectModalProps) {
  const { t } = useI18n();
  const titleId = useId();
  const [activeTab, setActiveTab] = useState<NewProjectTab>('local');
  const [groupId, setGroupId] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Local directory state
  const [localName, setLocalName] = useState('');
  const [localNameEdited, setLocalNameEdited] = useState(false);
  const [localPath, setLocalPath] = useState(defaultSessionPath);
  const [browsePath, setBrowsePath] = useState(defaultSessionPath);
  const [localCreateDir, setLocalCreateDir] = useState(false);
  const [submittingLocal, setSubmittingLocal] = useState(false);
  const pathDebounceRef = useRef<number | null>(null);

  // Preflight state
  const [preflight, setPreflight] = useState<RemotePreflightResponse | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [githubRepos, setGithubRepos] = useState<GithubRepoItem[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);

  // GitHub state
  const [ghMode, setGhMode] = useState<'clone' | 'create'>('clone');
  const [ghRepoSpec, setGhRepoSpec] = useState('');
  const [ghBranch, setGhBranch] = useState('');
  const [ghNewRepoName, setGhNewRepoName] = useState('');
  const [ghVisibility, setGhVisibility] = useState<'private' | 'public'>('private');
  const [ghOwner, setGhOwner] = useState('');
  const [ghDescription, setGhDescription] = useState('');
  const [ghAddReadme, setGhAddReadme] = useState(true);
  const [ghParentDir, setGhParentDir] = useState(defaultSessionPath);
  const [ghBrowsePath, setGhBrowsePath] = useState(defaultSessionPath);
  const [ghLocalDirName, setGhLocalDirName] = useState('');
  const [ghProjectName, setGhProjectName] = useState('');
  const [ghProjectNameEdited, setGhProjectNameEdited] = useState(false);
  const [showGhBrowser, setShowGhBrowser] = useState(false);

  // Google Drive state
  const [gdSelectedMountPath, setGdSelectedMountPath] = useState('');
  const [gdMountBrowsePath, setGdMountBrowsePath] = useState('');
  const [gdMountSelectedDir, setGdMountSelectedDir] = useState('');
  const [gdMountMode, setGdMountMode] = useState<'select' | 'mkdir'>('select');
  const [gdMountNewFolder, setGdMountNewFolder] = useState('');
  const [gdCliMode, setGdCliMode] = useState<'pull' | 'mkdir'>('pull');
  const [gdCliTool, setGdCliTool] = useState<'rclone' | 'gdrive'>('rclone');
  const [gdRemoteName, setGdRemoteName] = useState('');
  const [gdFolderIdOrPath, setGdFolderIdOrPath] = useState('');
  const [gdParentDir, setGdParentDir] = useState(defaultSessionPath);
  const [gdLocalDirName, setGdLocalDirName] = useState('');
  const [gdProjectName, setGdProjectName] = useState('');
  const [gdProjectNameEdited, setGdProjectNameEdited] = useState(false);

  // Async job state
  const [activeJob, setActiveJob] = useState<RemoteProvisionJob | null>(null);
  const [cancellingJob, setCancellingJob] = useState(false);
  const handledJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrorMsg(null);
    if (!localPath && defaultSessionPath) setLocalPath(defaultSessionPath);
    if (!browsePath && defaultSessionPath) setBrowsePath(defaultSessionPath);
    if (!ghParentDir && defaultSessionPath) setGhParentDir(defaultSessionPath);
    if (!ghBrowsePath && defaultSessionPath) setGhBrowsePath(defaultSessionPath);
    if (!gdParentDir && defaultSessionPath) setGdParentDir(defaultSessionPath);
  }, [open, defaultSessionPath, localPath, browsePath, ghParentDir, ghBrowsePath, gdParentDir]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && activeJob?.status !== 'running') {
        ev.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, activeJob?.status, onClose]);

  const loadPreflight = useCallback(async (provider: 'all' | 'github' | 'gdrive') => {
    if (!canAdminWorkspace || typeof apiClient.getRemotePreflight !== 'function') return;
    setPreflightLoading(true);
    try {
      const res = await apiClient.getRemotePreflight(provider);
      setPreflight((prev) => ({
        ok: res.ok,
        github: res.github ?? prev?.github,
        gdrive: res.gdrive ?? prev?.gdrive,
      }));
      if (res.gdrive?.mounts?.length && !gdSelectedMountPath) {
        const firstMount = res.gdrive.mounts.find((m) => m.responsive) || res.gdrive.mounts[0];
        if (firstMount) {
          setGdSelectedMountPath(firstMount.myDrivePath);
          setGdMountBrowsePath(firstMount.myDrivePath);
          setGdMountSelectedDir(firstMount.myDrivePath);
        }
      }
      if (res.gdrive?.tier === 'cli') {
        if (res.gdrive.rclone?.driveRemotes?.length) {
          setGdCliTool('rclone');
          setGdRemoteName((prev) => prev || res.gdrive!.rclone.driveRemotes[0]);
        } else if (res.gdrive.gdriveCli?.authenticated) {
          setGdCliTool('gdrive');
        }
      }
      if (res.github?.ghAuthenticated && typeof apiClient.listGithubRepos === 'function') {
        setLoadingRepos(true);
        void apiClient
          .listGithubRepos(undefined, 30)
          .then((r) => setGithubRepos(r.repos || []))
          .catch(() => {})
          .finally(() => setLoadingRepos(false));
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message || err.code : String(err);
      setErrorMsg(msg);
    } finally {
      setPreflightLoading(false);
    }
  }, [canAdminWorkspace, gdSelectedMountPath]);

  useEffect(() => {
    if (!open || !canAdminWorkspace) return;
    if (activeTab === 'github' && !preflight?.github) {
      void loadPreflight('github');
    } else if (activeTab === 'gdrive' && !preflight?.gdrive) {
      void loadPreflight('gdrive');
    }
  }, [open, activeTab, canAdminWorkspace, preflight?.github, preflight?.gdrive, loadPreflight]);

  const applyJobState = useCallback(
    (job: RemoteProvisionJob) => {
      setActiveJob(job);
      if (job.status === 'succeeded' && job.project) {
        if (handledJobIdRef.current !== job.jobId) {
          handledJobIdRef.current = job.jobId;
          setCancellingJob(false);
          onProjectCreated(job.project);
        }
      } else if (job.status === 'failed') {
        setCancellingJob(false);
        setErrorMsg(job.message || job.error || 'PROVISION_FAILED');
      } else if (job.status === 'cancelled') {
        setCancellingJob(false);
        setErrorMsg(null);
      }
    },
    [onProjectCreated],
  );

  // Sync SSE project.job updates
  useEffect(() => {
    if (!latestJobEvent || !activeJob || latestJobEvent.jobId !== activeJob.jobId) return;
    applyJobState(latestJobEvent);
  }, [latestJobEvent, activeJob, applyJobState]);

  // Poll job status while running as fallback
  useEffect(() => {
    if (!open || !activeJob || activeJob.status !== 'running') return undefined;
    if (typeof apiClient.getRemoteProjectJob !== 'function') return undefined;

    const interval = window.setInterval(() => {
      void apiClient
        .getRemoteProjectJob(activeJob.jobId)
        .then((res) => {
          if (res?.job) applyJobState(res.job);
        })
        .catch(() => {});
    }, 800);

    return () => window.clearInterval(interval);
  }, [open, activeJob, applyJobState]);

  const handleLocalPathChange = (nextPath: string) => {
    setLocalPath(nextPath);
    if (!localNameEdited) {
      const derived = basenameOfPath(nextPath);
      if (derived) setLocalName(derived);
    }
    if (pathDebounceRef.current) window.clearTimeout(pathDebounceRef.current);
    pathDebounceRef.current = window.setTimeout(() => {
      if (nextPath.trim()) {
        setBrowsePath(nextPath.trim());
      }
    }, 400);
  };

  const handleLocalSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!canAdminWorkspace || submittingLocal) return;
    const trimmedPath = localPath.trim();
    const trimmedName = (localName.trim() || basenameOfPath(trimmedPath)).trim();
    if (!trimmedPath || !trimmedName) return;
    setSubmittingLocal(true);
    setErrorMsg(null);
    try {
      const created = await onCreateLocalProject({
        name: trimmedName,
        rootPath: trimmedPath,
        groupId: groupId || null,
        createDir: localCreateDir,
      });
      if (created) {
        onProjectCreated(created);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message || err.code : String(err);
      setErrorMsg(msg);
    } finally {
      setSubmittingLocal(false);
    }
  };

  const startAsyncJob = async (req: StartRemoteJobRequest) => {
    if (!canAdminWorkspace || typeof apiClient.startRemoteProjectJob !== 'function') return;
    setErrorMsg(null);
    handledJobIdRef.current = null;
    try {
      const res = await apiClient.startRemoteProjectJob(req);
      applyJobState(res.job);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message || err.code : String(err);
      setErrorMsg(msg);
    }
  };

  const handleGithubSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (activeJob?.status === 'running') return;
    const isCreate = ghMode === 'create';
    const dirName = (
      ghLocalDirName.trim() ||
      (isCreate ? ghNewRepoName.trim() : extractRepoNameFromSpec(ghRepoSpec))
    ).trim();
    const projName = (ghProjectName.trim() || dirName).trim();
    if (!ghParentDir.trim() || !projName) return;

    await startAsyncJob({
      provider: 'github',
      mode: isCreate ? 'gh_create_and_clone' : 'gh_clone',
      parentDir: ghParentDir.trim(),
      localDirName: dirName || undefined,
      projectName: projName,
      groupId: groupId || null,
      github: isCreate
        ? {
            newRepoName: ghNewRepoName.trim(),
            owner: ghOwner.trim() || undefined,
            visibility: ghVisibility,
            description: ghDescription.trim() || undefined,
            addReadme: ghAddReadme,
          }
        : {
            repoSpec: ghRepoSpec.trim(),
            branch: ghBranch.trim() || undefined,
          },
    });
  };

  const handleRetryGithubCloneOnly = async () => {
    if (!activeJob?.remoteCreated?.cloneUrl) return;
    const cloneUrl = activeJob.remoteCreated.cloneUrl;
    setGhMode('clone');
    setGhRepoSpec(cloneUrl);
    const dirName = (
      ghLocalDirName.trim() || extractRepoNameFromSpec(cloneUrl)
    ).trim();
    const projName = (ghProjectName.trim() || dirName).trim();
    await startAsyncJob({
      provider: 'github',
      mode: 'gh_clone',
      parentDir: ghParentDir.trim(),
      localDirName: dirName || undefined,
      projectName: projName,
      groupId: groupId || null,
      github: {
        repoSpec: cloneUrl,
      },
    });
  };

  const handleGdriveSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (activeJob?.status === 'running') return;
    const gdInfo = preflight?.gdrive;
    if (!gdInfo || gdInfo.tier === 'unavailable') return;

    if (gdInfo.tier === 'mount') {
      const mountObj = gdInfo.mounts.find((m) => m.myDrivePath === gdSelectedMountPath) || gdInfo.mounts[0];
      if (gdMountMode === 'select') {
        const target = gdMountSelectedDir.trim() || gdMountBrowsePath.trim();
        const projName = (gdProjectName.trim() || basenameOfPath(target)).trim();
        if (!target || !projName) return;
        await startAsyncJob({
          provider: 'gdrive',
          mode: 'gdrive_mount_select',
          parentDir: target,
          projectName: projName,
          groupId: groupId || null,
          gdrive: {
            mountPath: target,
            account: mountObj?.account || undefined,
          },
        });
      } else {
        const parent = gdMountBrowsePath.trim() || gdSelectedMountPath;
        const folder = gdMountNewFolder.trim();
        const projName = (gdProjectName.trim() || folder).trim();
        if (!parent || !folder || !projName) return;
        await startAsyncJob({
          provider: 'gdrive',
          mode: 'gdrive_mount_mkdir',
          parentDir: parent,
          localDirName: folder,
          projectName: projName,
          groupId: groupId || null,
          gdrive: {
            mountPath: parent,
            account: mountObj?.account || undefined,
          },
        });
      }
      return;
    }

    const dirName = (gdLocalDirName.trim() || basenameOfPath(gdFolderIdOrPath) || 'drive-project').trim();
    const projName = (gdProjectName.trim() || dirName).trim();
    if (!gdParentDir.trim() || !projName) return;
    await startAsyncJob({
      provider: 'gdrive',
      mode: gdCliMode === 'mkdir' ? 'gdrive_cli_mkdir' : 'gdrive_cli_pull',
      parentDir: gdParentDir.trim(),
      localDirName: dirName,
      projectName: projName,
      groupId: groupId || null,
      gdrive: {
        cliTool: gdCliTool,
        remoteName: gdRemoteName.trim() || undefined,
        folderIdOrPath: gdFolderIdOrPath.trim() || undefined,
      },
    });
  };

  const handleCancelJob = async () => {
    if (!activeJob || activeJob.status !== 'running' || cancellingJob) return;
    if (typeof apiClient.cancelRemoteProjectJob !== 'function') return;
    setCancellingJob(true);
    try {
      const res = await apiClient.cancelRemoteProjectJob(activeJob.jobId);
      if (res?.job) applyJobState(res.job);
    } catch {
      setCancellingJob(false);
    }
  };

  const isRunningJob = activeJob?.status === 'running';
  const ghInfo = preflight?.github;
  const gdInfo = preflight?.gdrive;

  const jobStepLabel = useMemo(() => {
    if (!activeJob) return '';
    switch (activeJob.step) {
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
        return activeJob.step;
    }
  }, [activeJob, t]);

  if (!open) return null;

  const ghPreviewFolder =
    ghLocalDirName.trim() ||
    (ghMode === 'create' ? ghNewRepoName.trim() : extractRepoNameFromSpec(ghRepoSpec));
  const ghTargetPreview = joinLocalPath(ghParentDir.trim(), ghPreviewFolder);
  const canCreateGhRepo = Boolean(ghInfo?.canCreateRepo);
  const isPartialCloneError =
    activeJob?.status === 'failed' &&
    activeJob.error === 'CLONE_AFTER_CREATE_FAILED' &&
    Boolean(activeJob.remoteCreated?.cloneUrl);

  return (
    <div
      className={styles.backdrop}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget && !isRunningJob) onClose();
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="new-project-modal"
      >
        <div className={styles.header}>
          <h3 id={titleId} className={styles.title}>
            {t('newProject.title')}
          </h3>
          <button
            type="button"
            className={styles.closeBtn}
            disabled={isRunningJob}
            onClick={onClose}
            aria-label={t('common.close')}
            data-testid="new-project-modal-close"
          >
            ×
          </button>
        </div>

        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'local'}
            className={`${styles.tabBtn} ${activeTab === 'local' ? styles.tabBtnActive : ''}`}
            disabled={isRunningJob}
            data-testid="new-project-tab-local"
            onClick={() => {
              setErrorMsg(null);
              setActiveTab('local');
            }}
          >
            {t('newProject.tabLocal')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'github'}
            className={`${styles.tabBtn} ${activeTab === 'github' ? styles.tabBtnActive : ''}`}
            disabled={isRunningJob}
            data-testid="new-project-tab-github"
            onClick={() => {
              setErrorMsg(null);
              setActiveTab('github');
            }}
          >
            {t('newProject.tabGithub')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'gdrive'}
            className={`${styles.tabBtn} ${activeTab === 'gdrive' ? styles.tabBtnActive : ''}`}
            disabled={isRunningJob}
            data-testid="new-project-tab-gdrive"
            onClick={() => {
              setErrorMsg(null);
              setActiveTab('gdrive');
            }}
          >
            {t('newProject.tabGdrive')}
          </button>
        </div>

        <div className={styles.body}>
          {!canAdminWorkspace && (
            <div className={styles.warnBox} data-testid="new-project-l2-warning">
              {t('newProject.l2RequiredHint')}
            </div>
          )}

          {errorMsg && (
            <div className={styles.errorBox} role="alert" data-testid="new-project-error">
              {errorMsg}
            </div>
          )}

          {isRunningJob && activeJob && (
            <div className={styles.jobBox} data-testid="new-project-job-progress">
              <div className={styles.jobHeader}>
                <span>{jobStepLabel}</span>
                <span>{(activeJob.elapsedMs / 1000).toFixed(1)}s</span>
              </div>
              <div className={styles.jobSteps}>
                {['validating', activeJob.mode === 'gh_create_and_clone' ? 'creating_remote' : 'cloning', 'registering'].map((step) => (
                  <span
                    key={step}
                    className={`${styles.jobStepPill} ${activeJob.step === step ? styles.jobStepPillActive : ''}`}
                  >
                    {step}
                  </span>
                ))}
              </div>
              <div>
                <button
                  type="button"
                  className={styles.cancelBtn}
                  disabled={cancellingJob}
                  data-testid="new-project-job-cancel"
                  onClick={() => void handleCancelJob()}
                >
                  {cancellingJob ? t('newProject.jobCancelling') : t('newProject.jobCancel')}
                </button>
              </div>
            </div>
          )}

          {activeTab === 'local' && (
            <form
              id="new-project-local-form"
              onSubmit={(ev) => void handleLocalSubmit(ev)}
              className={styles.field}
            >
              <div className={styles.fieldGrid}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('newProject.nameLabel')}</span>
                  <input
                    type="text"
                    className={styles.input}
                    placeholder={t('newProject.namePlaceholder')}
                    value={localName}
                    disabled={!canAdminWorkspace || submittingLocal}
                    data-testid="local-project-name-input"
                    onChange={(e) => {
                      setLocalName(e.target.value);
                      setLocalNameEdited(e.target.value.trim().length > 0);
                    }}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('newProject.pathLabel')}</span>
                  <input
                    type="text"
                    className={styles.input}
                    placeholder={t('newProject.pathPlaceholder')}
                    value={localPath}
                    disabled={!canAdminWorkspace || submittingLocal}
                    data-testid="local-project-path-input"
                    onChange={(e) => handleLocalPathChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && localPath.trim()) {
                        setBrowsePath(localPath.trim());
                      }
                    }}
                  />
                </label>
              </div>

              <label className={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={localCreateDir}
                  disabled={!canAdminWorkspace || submittingLocal}
                  data-testid="local-project-createdir"
                  onChange={(e) => setLocalCreateDir(e.target.checked)}
                />
                <span>{t('newProject.createDirMissing')}</span>
              </label>

              {canAdminWorkspace && (
                <DirBrowserPane
                  currentPath={browsePath}
                  selectedPath={localPath}
                  t={t}
                  disabled={submittingLocal}
                  onBrowseError={setErrorMsg}
                  onSelectDir={(dirPath) => {
                    setLocalPath(dirPath);
                    if (!localNameEdited) {
                      const derived = basenameOfPath(dirPath);
                      if (derived) setLocalName(derived);
                    }
                  }}
                  onEnterDir={(dirPath) => setBrowsePath(dirPath)}
                />
              )}
            </form>
          )}

          {activeTab === 'github' && (
            <form
              id="new-project-github-form"
              onSubmit={(ev) => void handleGithubSubmit(ev)}
              className={styles.field}
            >
              <div className={styles.subModeBar}>
                <div className={styles.segmented}>
                  <button
                    type="button"
                    className={`${styles.segBtn} ${ghMode === 'clone' ? styles.segBtnActive : ''}`}
                    disabled={isRunningJob}
                    data-testid="gh-mode-clone"
                    onClick={() => setGhMode('clone')}
                  >
                    {t('newProject.ghModeClone')}
                  </button>
                  <button
                    type="button"
                    className={`${styles.segBtn} ${ghMode === 'create' ? styles.segBtnActive : ''}`}
                    disabled={isRunningJob || (ghInfo ? !canCreateGhRepo : false)}
                    data-testid="gh-mode-create"
                    onClick={() => setGhMode('create')}
                  >
                    {t('newProject.ghModeCreate')}
                  </button>
                </div>
                <button
                  type="button"
                  className={styles.miniBtn}
                  disabled={preflightLoading || isRunningJob}
                  data-testid="gh-recheck-btn"
                  onClick={() => void loadPreflight('github')}
                >
                  {preflightLoading ? t('newProject.checkingEnv') : t('newProject.recheckEnv')}
                </button>
              </div>

              {ghInfo && !ghInfo.gitInstalled && (
                <div className={styles.warnBox} data-testid="gh-git-missing">
                  {t('newProject.ghGitMissing', { hint: ghInfo.installHints?.git || 'git' })}
                </div>
              )}

              {ghInfo && ghInfo.gitInstalled && !ghInfo.ghAuthenticated && (
                <div className={styles.warnBox} data-testid="gh-not-authed">
                  {t('newProject.ghNotAuthed', {
                    hint: ghInfo.installHints?.ghLogin || 'gh auth login',
                  })}
                </div>
              )}

              {ghInfo?.ghAuthenticated && ghInfo.activeAccount && (
                <div className={styles.infoBox} data-testid="gh-authed-info">
                  {t('newProject.ghAuthedAs', { account: ghInfo.activeAccount })}
                </div>
              )}

              {isPartialCloneError && activeJob?.remoteCreated && (
                <div className={styles.warnBox} data-testid="gh-partial-created-box">
                  <span>
                    {t('newProject.ghPartialCreated', {
                      repo: activeJob.remoteCreated.ownerRepo,
                    })}
                  </span>
                  <div>
                    <button
                      type="button"
                      className={styles.submitBtn}
                      data-testid="gh-retry-clone-btn"
                      onClick={() => void handleRetryGithubCloneOnly()}
                    >
                      {t('newProject.ghRetryClone')}
                    </button>
                  </div>
                </div>
              )}

              {ghMode === 'clone' ? (
                <>
                  <div className={styles.fieldGrid}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>{t('newProject.ghRepoSpecLabel')}</span>
                      <input
                        type="text"
                        className={styles.input}
                        placeholder={t('newProject.ghRepoSpecPlaceholder')}
                        value={ghRepoSpec}
                        disabled={isRunningJob}
                        data-testid="gh-repo-spec-input"
                        onChange={(e) => {
                          const val = e.target.value;
                          setGhRepoSpec(val);
                          const derived = extractRepoNameFromSpec(val);
                          if (derived && !ghProjectNameEdited) {
                            setGhLocalDirName(derived);
                            setGhProjectName(derived);
                          }
                        }}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>{t('newProject.ghBranchLabel')}</span>
                      <input
                        type="text"
                        className={styles.input}
                        placeholder={t('newProject.ghBranchPlaceholder')}
                        value={ghBranch}
                        disabled={isRunningJob}
                        data-testid="gh-branch-input"
                        onChange={(e) => setGhBranch(e.target.value)}
                      />
                    </label>
                  </div>

                  {ghInfo?.ghAuthenticated && (githubRepos.length > 0 || loadingRepos) && (
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>{t('newProject.ghPickMyRepo')}</span>
                      <select
                        className={styles.select}
                        disabled={isRunningJob || loadingRepos}
                        value=""
                        data-testid="gh-pick-repo-select"
                        onChange={(e) => {
                          const selected = githubRepos.find(
                            (r) => r.nameWithOwner === e.target.value,
                          );
                          if (!selected) return;
                          setGhRepoSpec(selected.nameWithOwner);
                          const derived = extractRepoNameFromSpec(selected.nameWithOwner);
                          if (derived) {
                            setGhLocalDirName(derived);
                            if (!ghProjectNameEdited) setGhProjectName(derived);
                          }
                        }}
                      >
                        <option value="">
                          {loadingRepos ? t('newProject.ghLoadingRepos') : '—'}
                        </option>
                        {githubRepos.map((repo) => (
                          <option key={repo.nameWithOwner} value={repo.nameWithOwner}>
                            {repo.nameWithOwner} ({repo.isPrivate ? 'private' : 'public'})
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              ) : (
                <>
                  <div className={styles.fieldGrid}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>
                        {t('newProject.ghNewRepoNameLabel')}
                      </span>
                      <input
                        type="text"
                        className={styles.input}
                        placeholder={t('newProject.ghNewRepoNamePlaceholder')}
                        value={ghNewRepoName}
                        disabled={isRunningJob}
                        data-testid="gh-new-repo-name-input"
                        onChange={(e) => {
                          const val = e.target.value;
                          setGhNewRepoName(val);
                          setGhLocalDirName(val.trim());
                          if (!ghProjectNameEdited) setGhProjectName(val.trim());
                        }}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>{t('newProject.ghVisibilityLabel')}</span>
                      <select
                        className={styles.select}
                        value={ghVisibility}
                        disabled={isRunningJob}
                        data-testid="gh-visibility-select"
                        onChange={(e) =>
                          setGhVisibility(e.target.value === 'public' ? 'public' : 'private')
                        }
                      >
                        <option value="private">{t('newProject.ghVisibilityPrivate')}</option>
                        <option value="public">{t('newProject.ghVisibilityPublic')}</option>
                      </select>
                    </label>
                  </div>

                  <div className={styles.fieldGrid}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>{t('newProject.ghOwnerLabel')}</span>
                      <select
                        className={styles.select}
                        value={ghOwner}
                        disabled={isRunningJob}
                        data-testid="gh-owner-select"
                        onChange={(e) => setGhOwner(e.target.value)}
                      >
                        <option value="">
                          {t('newProject.ghPersonalAccount', {
                            account: ghInfo?.activeAccount || 'me',
                          })}
                        </option>
                        {(ghInfo?.orgs || []).map((org) => (
                          <option key={org} value={org}>
                            {org}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>{t('newProject.ghDescLabel')}</span>
                      <input
                        type="text"
                        className={styles.input}
                        placeholder={t('newProject.ghDescPlaceholder')}
                        value={ghDescription}
                        disabled={isRunningJob}
                        data-testid="gh-desc-input"
                        onChange={(e) => setGhDescription(e.target.value)}
                      />
                    </label>
                  </div>

                  <label className={styles.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={ghAddReadme}
                      disabled={isRunningJob}
                      data-testid="gh-readme-checkbox"
                      onChange={(e) => setGhAddReadme(e.target.checked)}
                    />
                    <span>{t('newProject.ghAddReadme')}</span>
                  </label>
                </>
              )}

              <div className={styles.fieldGrid}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('newProject.parentDirLabel')}</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <input
                      type="text"
                      className={styles.input}
                      value={ghParentDir}
                      disabled={isRunningJob}
                      data-testid="gh-parent-dir-input"
                      onChange={(e) => setGhParentDir(e.target.value)}
                    />
                    <button
                      type="button"
                      className={styles.miniBtn}
                      onClick={() => {
                        setGhBrowsePath(ghParentDir || defaultSessionPath);
                        setShowGhBrowser((prev) => !prev);
                      }}
                    >
                      …
                    </button>
                  </div>
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('newProject.folderNameLabel')}</span>
                  <input
                    type="text"
                    className={styles.input}
                    placeholder={t('newProject.folderNamePlaceholder')}
                    value={ghLocalDirName}
                    disabled={isRunningJob}
                    data-testid="gh-folder-name-input"
                    onChange={(e) => setGhLocalDirName(e.target.value)}
                  />
                </label>
              </div>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('newProject.nameLabel')}</span>
                <input
                  type="text"
                  className={styles.input}
                  placeholder={t('newProject.namePlaceholder')}
                  value={ghProjectName}
                  disabled={isRunningJob}
                  data-testid="gh-project-name-input"
                  onChange={(e) => {
                    setGhProjectName(e.target.value);
                    setGhProjectNameEdited(e.target.value.trim().length > 0);
                  }}
                />
              </label>

              {showGhBrowser && canAdminWorkspace && (
                <DirBrowserPane
                  currentPath={ghBrowsePath}
                  selectedPath={ghParentDir}
                  t={t}
                  disabled={isRunningJob}
                  onBrowseError={setErrorMsg}
                  onSelectDir={(dir) => setGhParentDir(dir)}
                  onEnterDir={(dir) => setGhBrowsePath(dir)}
                />
              )}

              {ghTargetPreview && (
                <div className={styles.previewPath} data-testid="gh-target-preview">
                  {t('newProject.ghTargetPreview', { path: ghTargetPreview })}
                </div>
              )}
            </form>
          )}

          {activeTab === 'gdrive' && (
            <form
              id="new-project-gdrive-form"
              onSubmit={(ev) => void handleGdriveSubmit(ev)}
              className={styles.field}
            >
              <div className={styles.subModeBar}>
                <span className={styles.fieldLabel}>
                  {preflightLoading ? t('newProject.checkingEnv') : 'Google Drive'}
                </span>
                <button
                  type="button"
                  className={styles.miniBtn}
                  disabled={preflightLoading || isRunningJob}
                  data-testid="gd-recheck-btn"
                  onClick={() => void loadPreflight('gdrive')}
                >
                  {preflightLoading ? t('newProject.checkingEnv') : t('newProject.recheckEnv')}
                </button>
              </div>

              {gdInfo?.tier === 'mount' && (
                <>
                  <div className={styles.infoBox} data-testid="gd-mount-tier">
                    <strong>{t('newProject.gdMountTierTitle')}</strong>
                    <span>{t('newProject.gdMountSyncNote')}</span>
                  </div>

                  <div className={styles.subModeBar}>
                    <div className={styles.segmented}>
                      <button
                        type="button"
                        className={`${styles.segBtn} ${gdMountMode === 'select' ? styles.segBtnActive : ''}`}
                        onClick={() => setGdMountMode('select')}
                      >
                        {t('newProject.gdMountModeSelect')}
                      </button>
                      <button
                        type="button"
                        className={`${styles.segBtn} ${gdMountMode === 'mkdir' ? styles.segBtnActive : ''}`}
                        onClick={() => setGdMountMode('mkdir')}
                      >
                        {t('newProject.gdMountModeMkdir')}
                      </button>
                    </div>
                  </div>

                  {gdInfo.mounts.length > 0 && (
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>{t('newProject.gdSelectMount')}</span>
                      <select
                        className={styles.select}
                        value={gdSelectedMountPath}
                        onChange={(e) => {
                          setGdSelectedMountPath(e.target.value);
                          setGdMountBrowsePath(e.target.value);
                          setGdMountSelectedDir(e.target.value);
                        }}
                      >
                        {gdInfo.mounts.map((m) => (
                          <option key={m.id} value={m.myDrivePath}>
                            {m.account || m.myDrivePath}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {canAdminWorkspace && gdMountBrowsePath && (
                    <DirBrowserPane
                      currentPath={gdMountBrowsePath}
                      selectedPath={gdMountSelectedDir}
                      t={t}
                      disabled={isRunningJob}
                      onBrowseError={setErrorMsg}
                      onSelectDir={(dir) => {
                        setGdMountSelectedDir(dir);
                        if (gdMountMode === 'select' && !gdProjectNameEdited) {
                          setGdProjectName(basenameOfPath(dir));
                        }
                      }}
                      onEnterDir={(dir) => setGdMountBrowsePath(dir)}
                    />
                  )}

                  {gdMountMode === 'mkdir' && (
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>{t('newProject.folderNameLabel')}</span>
                      <input
                        type="text"
                        className={styles.input}
                        value={gdMountNewFolder}
                        onChange={(e) => {
                          setGdMountNewFolder(e.target.value);
                          if (!gdProjectNameEdited) setGdProjectName(e.target.value.trim());
                        }}
                      />
                    </label>
                  )}

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>{t('newProject.nameLabel')}</span>
                    <input
                      type="text"
                      className={styles.input}
                      value={gdProjectName}
                      onChange={(e) => {
                        setGdProjectName(e.target.value);
                        setGdProjectNameEdited(e.target.value.trim().length > 0);
                      }}
                    />
                  </label>
                </>
              )}

              {gdInfo?.tier === 'cli' && (
                <>
                  <div className={styles.infoBox} data-testid="gd-cli-tier">
                    <strong>{t('newProject.gdCliTierTitle', { tool: gdCliTool })}</strong>
                    <span>{t('newProject.gdCliSyncNote')}</span>
                  </div>

                  <div className={styles.segmented}>
                    <button
                      type="button"
                      className={`${styles.segBtn} ${gdCliMode === 'pull' ? styles.segBtnActive : ''}`}
                      onClick={() => setGdCliMode('pull')}
                    >
                      {t('newProject.gdCliModePull')}
                    </button>
                    <button
                      type="button"
                      className={`${styles.segBtn} ${gdCliMode === 'mkdir' ? styles.segBtnActive : ''}`}
                      onClick={() => setGdCliMode('mkdir')}
                    >
                      {t('newProject.gdCliModeMkdir')}
                    </button>
                  </div>

                  <div className={styles.fieldGrid}>
                    {gdInfo.rclone.driveRemotes.length > 0 && (
                      <label className={styles.field}>
                        <span className={styles.fieldLabel}>{t('newProject.gdRemoteLabel')}</span>
                        <select
                          className={styles.select}
                          value={gdRemoteName}
                          onChange={(e) => setGdRemoteName(e.target.value)}
                        >
                          {gdInfo.rclone.driveRemotes.map((rem) => (
                            <option key={rem} value={rem}>
                              {rem}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>{t('newProject.gdFolderIdLabel')}</span>
                      <input
                        type="text"
                        className={styles.input}
                        placeholder={t('newProject.gdFolderIdPlaceholder')}
                        value={gdFolderIdOrPath}
                        onChange={(e) => setGdFolderIdOrPath(e.target.value)}
                      />
                    </label>
                  </div>

                  <div className={styles.fieldGrid}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>{t('newProject.parentDirLabel')}</span>
                      <input
                        type="text"
                        className={styles.input}
                        value={gdParentDir}
                        onChange={(e) => setGdParentDir(e.target.value)}
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>{t('newProject.folderNameLabel')}</span>
                      <input
                        type="text"
                        className={styles.input}
                        value={gdLocalDirName}
                        onChange={(e) => {
                          setGdLocalDirName(e.target.value);
                          if (!gdProjectNameEdited) setGdProjectName(e.target.value.trim());
                        }}
                      />
                    </label>
                  </div>

                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>{t('newProject.nameLabel')}</span>
                    <input
                      type="text"
                      className={styles.input}
                      value={gdProjectName}
                      onChange={(e) => {
                        setGdProjectName(e.target.value);
                        setGdProjectNameEdited(e.target.value.trim().length > 0);
                      }}
                    />
                  </label>
                </>
              )}

              {gdInfo?.tier === 'unavailable' && (
                <div className={styles.infoBox} data-testid="gd-unavailable-tier">
                  <strong>{t('newProject.gdUnavailableTitle')}</strong>
                  <span>{t('newProject.gdUnavailableDesc')}</span>
                  <ul className={styles.unavailableList}>
                    <li>{t('newProject.gdCheckMountMissing')}</li>
                    <li>{t('newProject.gdCheckRcloneMissing')}</li>
                    <li>{t('newProject.gdCheckGdriveMissing')}</li>
                  </ul>
                  <div>
                    <button
                      type="button"
                      className={styles.miniBtn}
                      data-testid="gd-switch-local-btn"
                      onClick={() => setActiveTab('local')}
                    >
                      {t('newProject.gdSwitchToLocal')}
                    </button>
                  </div>
                </div>
              )}
            </form>
          )}
        </div>

        <div className={styles.footer}>
          <div className={styles.footerGroup}>
            <select
              className={styles.select}
              aria-label={t('newProject.groupLabel')}
              disabled={isRunningJob || !canAdminWorkspace}
              value={groupId}
              data-testid="new-project-group-select"
              onChange={(e) => setGroupId(e.target.value)}
            >
              <option value="">{t('sidebar.ungroupedProjects')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.footerActions}>
            <button
              type="button"
              className={styles.cancelBtn}
              disabled={isRunningJob}
              onClick={onClose}
            >
              {t('common.cancel')}
            </button>

            {activeTab === 'local' && (
              <button
                type="submit"
                form="new-project-local-form"
                className={styles.submitBtn}
                disabled={
                  !canAdminWorkspace ||
                  submittingLocal ||
                  !localPath.trim() ||
                  !(localName.trim() || basenameOfPath(localPath))
                }
                data-testid="new-project-submit-local"
              >
                {submittingLocal ? t('newProject.submitting') : t('newProject.submitLocal')}
              </button>
            )}

            {activeTab === 'github' && (
              <button
                type="submit"
                form="new-project-github-form"
                className={styles.submitBtn}
                disabled={
                  !canAdminWorkspace ||
                  isRunningJob ||
                  !ghInfo?.gitInstalled ||
                  !ghParentDir.trim() ||
                  (ghMode === 'clone' ? !ghRepoSpec.trim() : !canCreateGhRepo || !ghNewRepoName.trim())
                }
                data-testid="new-project-submit-github"
              >
                {isRunningJob
                  ? t('newProject.submitting')
                  : ghMode === 'create'
                    ? t('newProject.ghSubmitCreate')
                    : t('newProject.ghSubmitClone')}
              </button>
            )}

            {activeTab === 'gdrive' && gdInfo && gdInfo.tier !== 'unavailable' && (
              <button
                type="submit"
                form="new-project-gdrive-form"
                className={styles.submitBtn}
                disabled={
                  !canAdminWorkspace ||
                  isRunningJob ||
                  (gdInfo.tier === 'mount'
                    ? gdMountMode === 'mkdir'
                      ? !gdMountNewFolder.trim()
                      : !gdMountSelectedDir.trim()
                    : !gdParentDir.trim())
                }
                data-testid="new-project-submit-gdrive"
              >
                {isRunningJob
                  ? t('newProject.submitting')
                  : gdInfo.tier === 'mount'
                    ? t('newProject.gdSubmitMount')
                    : t('newProject.gdSubmitCli')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default NewProjectModal;
