import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient } from '../api/client';
import { useI18n } from '../i18n';
import type {
  BackgroundTaskDetailDto,
  BackgroundTaskDto,
  BackgroundTasksFilterProject,
  BackgroundTasksFilterSession,
  BackgroundTasksListResponse,
  StopBackgroundTaskResponse,
} from '../types';
import styles from './BackgroundTasksPopover.module.css';

export interface BackgroundTasksFilterState {
  project: string;
  sessionId: string;
}

export interface BackgroundTasksPopoverProps {
  tasksData?: BackgroundTasksListResponse | null;
  loading?: boolean;
  channel?: string;
  permissionLevel?: string;
  activeSessionId?: string | null;
  activeSessionTitle?: string | null;
  activeProjectPath?: string | null;
  activeProjectName?: string | null;
  filterProject?: string;
  filterSessionId?: string;
  onFiltersChange?: (next: BackgroundTasksFilterState) => void;
  onRefresh?: () => void;
  onStopTask?: (taskId: string) => Promise<StopBackgroundTaskResponse | void>;
  onSelectSession?: (sessionId: string) => void;
  onClose: () => void;
}

function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '--:--';
  const totalSec = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getLiveDurationMs(task: BackgroundTaskDto, nowMs: number): number | null {
  if (task.status === 'running' || task.status === 'pending' || task.status === 'stopping') {
    const startMs = task.startedAt ? Date.parse(task.startedAt) : NaN;
    if (Number.isFinite(startMs)) {
      return Math.max(0, nowMs - startMs);
    }
  }
  return task.durationMs;
}

function normalizeFilterPath(raw?: string | null): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/^file:\/\//i, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function extractPathBasename(raw: string): string {
  const cleaned = raw.replace(/^file:\/\//i, '').replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : cleaned;
}

export function BackgroundTasksPopover({
  tasksData,
  loading = false,
  channel = 'loopback',
  permissionLevel = 'L0',
  activeSessionId = null,
  activeSessionTitle = null,
  activeProjectPath = null,
  activeProjectName = null,
  filterProject,
  filterSessionId,
  onFiltersChange,
  onRefresh,
  onStopTask,
  onSelectSession,
  onClose,
}: BackgroundTasksPopoverProps) {
  const { t } = useI18n();
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BackgroundTaskDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copiedLog, setCopiedLog] = useState(false);
  const [confirmStopTask, setConfirmStopTask] = useState<BackgroundTaskDto | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Record<string, boolean>>({});
  const [neutralNotice, setNeutralNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [internalProject, setInternalProject] = useState<string>('');
  const [internalSessionId, setInternalSessionId] = useState<string>('');
  const logBoxRef = useRef<HTMLPreElement | null>(null);

  const currentProject = filterProject !== undefined ? filterProject : internalProject;
  const currentSessionId = filterSessionId !== undefined ? filterSessionId : internalSessionId;
  const hasActiveFilter = Boolean(currentProject || currentSessionId);

  const runningList = tasksData?.running || [];
  const recentList = tasksData?.recent || [];

  const normalizedActiveProject = normalizeFilterPath(activeProjectPath);

  const projectOptions = useMemo<BackgroundTasksFilterProject[]>(() => {
    const base: BackgroundTasksFilterProject[] = tasksData?.filters?.projects
      ? tasksData.filters.projects.map((p) => ({ ...p }))
      : (() => {
          const map = new Map<string, BackgroundTasksFilterProject>();
          for (const task of [...runningList, ...recentList]) {
            const pPath = task.projectPath || '';
            const key = normalizeFilterPath(pPath);
            if (!key) continue;
            const existing = map.get(key);
            if (existing) {
              existing.count += 1;
            } else {
              map.set(key, {
                key,
                name: task.projectName || extractPathBasename(pPath),
                path: pPath,
                count: 1,
              });
            }
          }
          return Array.from(map.values());
        })();

    if (
      normalizedActiveProject &&
      activeProjectPath &&
      !base.some((p) => normalizeFilterPath(p.key || p.path) === normalizedActiveProject)
    ) {
      base.unshift({
        key: normalizedActiveProject,
        name: activeProjectName || extractPathBasename(activeProjectPath),
        path: activeProjectPath,
        count: 0,
      });
    }
    return base;
  }, [
    tasksData?.filters?.projects,
    runningList,
    recentList,
    normalizedActiveProject,
    activeProjectPath,
    activeProjectName,
  ]);

  const allSessionOptions = useMemo<BackgroundTasksFilterSession[]>(() => {
    const base: BackgroundTasksFilterSession[] = tasksData?.filters?.sessions
      ? tasksData.filters.sessions.map((s) => ({ ...s }))
      : (() => {
          const map = new Map<string, BackgroundTasksFilterSession>();
          for (const task of [...runningList, ...recentList]) {
            if (!task.sessionId) continue;
            const existing = map.get(task.sessionId);
            if (existing) {
              existing.count += 1;
            } else {
              map.set(task.sessionId, {
                id: task.sessionId,
                title: task.sessionTitle || task.title || task.sessionId,
                projectPath: task.projectPath ?? null,
                count: 1,
              });
            }
          }
          return Array.from(map.values());
        })();

    if (activeSessionId && !base.some((s) => s.id === activeSessionId)) {
      base.unshift({
        id: activeSessionId,
        title: activeSessionTitle || activeSessionId,
        projectPath: activeProjectPath || null,
        count: 0,
      });
    }
    return base;
  }, [
    tasksData?.filters?.sessions,
    runningList,
    recentList,
    activeSessionId,
    activeSessionTitle,
    activeProjectPath,
  ]);

  const normalizedCurrentProject = normalizeFilterPath(currentProject);

  const visibleSessionOptions = useMemo(() => {
    if (!normalizedCurrentProject) return allSessionOptions;
    return allSessionOptions.filter(
      (s) =>
        s.id === currentSessionId ||
        normalizeFilterPath(s.projectPath) === normalizedCurrentProject,
    );
  }, [allSessionOptions, normalizedCurrentProject, currentSessionId]);

  const commitFilters = useCallback(
    (next: BackgroundTasksFilterState) => {
      if (filterProject === undefined) setInternalProject(next.project);
      if (filterSessionId === undefined) setInternalSessionId(next.sessionId);
      onFiltersChange?.(next);
    },
    [filterProject, filterSessionId, onFiltersChange],
  );

  const handleProjectSelect = (nextProject: string) => {
    const nextNorm = normalizeFilterPath(nextProject);
    let nextSessionId = currentSessionId;
    if (nextNorm && nextSessionId) {
      const matchedSess = allSessionOptions.find((s) => s.id === nextSessionId);
      if (matchedSess && normalizeFilterPath(matchedSess.projectPath) !== nextNorm) {
        nextSessionId = '';
      }
    }
    commitFilters({ project: nextProject, sessionId: nextSessionId });
  };

  const handleSessionSelect = (nextSessionId: string) => {
    commitFilters({ project: currentProject, sessionId: nextSessionId });
  };

  const handleToggleCurrentProject = () => {
    if (!activeProjectPath) return;
    const isSame = normalizedCurrentProject === normalizedActiveProject;
    handleProjectSelect(isSame ? '' : (normalizedActiveProject || activeProjectPath));
  };

  const handleToggleCurrentSession = () => {
    if (!activeSessionId) return;
    if (currentSessionId === activeSessionId) {
      commitFilters({ project: currentProject, sessionId: '' });
      return;
    }
    let nextProject = currentProject;
    if (normalizedCurrentProject && normalizedActiveProject && normalizedCurrentProject !== normalizedActiveProject) {
      nextProject = '';
    }
    commitFilters({ project: nextProject, sessionId: activeSessionId });
  };

  const handleClearFilters = () => {
    commitFilters({ project: '', sessionId: '' });
  };

  const displayedRunning = useMemo(() => {
    if (onFiltersChange || !hasActiveFilter) return runningList;
    return runningList.filter((task) => {
      if (currentSessionId && task.sessionId !== currentSessionId) return false;
      if (normalizedCurrentProject && normalizeFilterPath(task.projectPath) !== normalizedCurrentProject) {
        return false;
      }
      return true;
    });
  }, [onFiltersChange, hasActiveFilter, runningList, currentSessionId, normalizedCurrentProject]);

  const displayedRecent = useMemo(() => {
    if (onFiltersChange || !hasActiveFilter) return recentList;
    return recentList.filter((task) => {
      if (currentSessionId && task.sessionId !== currentSessionId) return false;
      if (normalizedCurrentProject && normalizeFilterPath(task.projectPath) !== normalizedCurrentProject) {
        return false;
      }
      return true;
    });
  }, [onFiltersChange, hasActiveFilter, recentList, currentSessionId, normalizedCurrentProject]);

  useEffect(() => {
    if (runningList.length === 0 && !selectedTaskId) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runningList.length, selectedTaskId]);

  const loadDetail = useCallback(async (taskId: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await apiClient.getBackgroundTaskDetail(taskId);
      setDetail(res.task);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : t('dockErr.requestFailed'));
    } finally {
      setDetailLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!selectedTaskId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedTaskId);
  }, [selectedTaskId, loadDetail]);

  useEffect(() => {
    if (!selectedTaskId || !detail) return;
    if (detail.status !== 'running' && detail.status !== 'pending') return;
    const timer = window.setInterval(() => {
      void loadDetail(selectedTaskId);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [selectedTaskId, detail?.status, loadDetail]);

  useEffect(() => {
    if (autoScroll && logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [detail?.logText, autoScroll]);

  const isStopPermitted = (task: BackgroundTaskDto): { allowed: boolean; reason: string | null } => {
    if (channel === 'loopback') return { allowed: true, reason: null };
    if (permissionLevel === 'L0') {
      return { allowed: false, reason: t('tasks.l0StopDisabled') };
    }
    if (task.stopCapability.requiredPermission === 'L2' && permissionLevel !== 'L2') {
      return { allowed: false, reason: t('tasks.l1PtyStopDisabled') };
    }
    return { allowed: true, reason: null };
  };

  const executeStop = async (task: BackgroundTaskDto) => {
    setConfirmStopTask(null);
    setErrorNotice(null);
    setNeutralNotice(null);
    setStoppingIds((prev) => ({ ...prev, [task.taskId]: true }));
    try {
      const res = onStopTask
        ? await onStopTask(task.taskId)
        : await apiClient.stopBackgroundTask(task.taskId);
      if (res && res.alreadyFinished) {
        const statusText = t(`tasks.status.${res.status}`);
        setNeutralNotice(t('tasks.alreadyFinishedNotice', { status: statusText }));
      }
      onRefresh?.();
      if (selectedTaskId === task.taskId) {
        await loadDetail(task.taskId);
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : t('dockErr.actionFailed'));
    } finally {
      setStoppingIds((prev) => ({ ...prev, [task.taskId]: false }));
    }
  };

  const renderTaskRow = (task: BackgroundTaskDto) => {
    const isStopping = Boolean(stoppingIds[task.taskId]);
    const effectiveStatus = isStopping ? 'stopping' : task.status;
    const perm = isStopPermitted(task);
    const canShowStop = task.stopCapability.canStop && !isStopping;

    return (
      <div
        key={task.taskId}
        className={styles.row}
        data-testid={`task-row-${task.taskId}`}
      >
        <div className={styles.rowMain}>
          <div className={styles.rowTop}>
            <span className={styles.kindBadge}>{t(`tasks.kind.${task.kind}`)}</span>
            <span className={styles.rowTitle} title={task.commandLine || task.title}>
              {task.title}
            </span>
          </div>
          <div className={styles.rowMeta}>
            <span
              className={[
                styles.statusBadge,
                effectiveStatus === 'running' || effectiveStatus === 'stopping'
                  ? styles.statusRunning
                  : effectiveStatus === 'pending'
                    ? styles.statusPending
                    : effectiveStatus === 'error'
                      ? styles.statusError
                      : styles.statusMuted,
              ].join(' ')}
            >
              {t(`tasks.status.${effectiveStatus}`)}
            </span>
            <span className={styles.duration}>
              {formatDurationMs(getLiveDurationMs(task, nowMs))}
            </span>
            {task.projectName && (
              <span className={styles.projectHint} title={task.projectPath || task.projectName}>
                {task.projectName}
              </span>
            )}
            {task.sessionTitle && (
              <span className={styles.sessionHint} title={task.sessionTitle}>
                {task.sessionTitle}
              </span>
            )}
          </div>
        </div>

        <div className={styles.rowActions}>
          <button
            type="button"
            className={styles.btn}
            onClick={() => setSelectedTaskId(task.taskId)}
            data-testid={`task-detail-btn-${task.taskId}`}
          >
            {t('tasks.viewDetail')}
          </button>
          {canShowStop && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              disabled={!perm.allowed || isStopping}
              title={perm.reason || t('tasks.stop')}
              onClick={() => setConfirmStopTask(task)}
              data-testid={`task-stop-btn-${task.taskId}`}
            >
              {isStopping ? t('tasks.status.stopping') : t('tasks.stop')}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div
      className={styles.popover}
      role="dialog"
      aria-label={t('tasks.title')}
      data-testid="background-tasks-popover"
    >
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          {selectedTaskId && (
            <button
              type="button"
              className={styles.backBtn}
              onClick={() => setSelectedTaskId(null)}
              data-testid="tasks-back-btn"
            >
              ‹ {t('tasks.backToList')}
            </button>
          )}
          <h3 className={styles.title}>{selectedTaskId && detail ? detail.title : t('tasks.title')}</h3>
        </div>
        <div className={styles.headerActions}>
          {onRefresh && (
            <button
              type="button"
              className={styles.btn}
              disabled={loading}
              onClick={() => {
                onRefresh();
                if (selectedTaskId) void loadDetail(selectedTaskId);
              }}
              data-testid="tasks-refresh-btn"
            >
              {loading ? t('common.refreshing') : t('common.refresh')}
            </button>
          )}
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>
      </div>

      {neutralNotice && (
        <div className={styles.neutralBanner} role="status" data-testid="tasks-neutral-notice">
          <span>{neutralNotice}</span>
          <button type="button" className={styles.closeBtn} onClick={() => setNeutralNotice(null)}>
            ×
          </button>
        </div>
      )}

      {errorNotice && (
        <div className={styles.errorBanner} role="alert" data-testid="tasks-error-notice">
          <span>{errorNotice}</span>
          <button type="button" className={styles.closeBtn} onClick={() => setErrorNotice(null)}>
            ×
          </button>
        </div>
      )}

      {confirmStopTask && (
        <div className={styles.confirmBox} role="alertdialog" data-testid="tasks-stop-confirm">
          <div className={styles.confirmTitle}>{t('tasks.stopConfirmTitle')}</div>
          <div className={styles.confirmTarget}>{confirmStopTask.title}</div>
          <p className={styles.confirmScope}>
            {confirmStopTask.stopCapability.stopScope === 'cascade_invocation' &&
            confirmStopTask.kind === 'command'
              ? t('tasks.stopConfirmSessionScope')
              : confirmStopTask.stopCapability.stopScope === 'pty_session'
                ? t('tasks.stopConfirmPtyScope')
                : t('tasks.stopConfirmDefaultScope')}
          </p>
          <div className={styles.confirmActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              onClick={() => void executeStop(confirmStopTask)}
              data-testid="tasks-stop-confirm-submit"
            >
              {t('tasks.stop')}
            </button>
            <button
              type="button"
              className={styles.btn}
              onClick={() => setConfirmStopTask(null)}
              data-testid="tasks-stop-confirm-cancel"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {!selectedTaskId && (
        <div className={styles.filterBar} data-testid="tasks-filter-bar">
          <div className={styles.filterSelectRow}>
            <select
              className={styles.filterSelect}
              value={currentProject}
              onChange={(ev) => handleProjectSelect(ev.target.value)}
              aria-label={t('tasks.filterProjectAria')}
              data-testid="tasks-filter-project-select"
            >
              <option value="">{t('tasks.filterAllProjects')}</option>
              {projectOptions.map((proj) => (
                <option key={proj.key} value={proj.key}>
                  {proj.count > 0 ? `${proj.name} (${proj.count})` : proj.name}
                </option>
              ))}
            </select>
            <select
              className={styles.filterSelect}
              value={currentSessionId}
              onChange={(ev) => handleSessionSelect(ev.target.value)}
              aria-label={t('tasks.filterSessionAria')}
              data-testid="tasks-filter-session-select"
            >
              <option value="">{t('tasks.filterAllSessions')}</option>
              {visibleSessionOptions.map((sess) => (
                <option key={sess.id} value={sess.id}>
                  {sess.count > 0 ? `${sess.title} (${sess.count})` : sess.title}
                </option>
              ))}
            </select>
          </div>
          {(activeProjectPath || activeSessionId || hasActiveFilter) && (
            <div className={styles.filterChipRow}>
              {activeProjectPath && (
                <button
                  type="button"
                  className={`${styles.filterChip} ${
                    normalizedCurrentProject === normalizedActiveProject ? styles.filterChipActive : ''
                  }`}
                  onClick={handleToggleCurrentProject}
                  aria-pressed={normalizedCurrentProject === normalizedActiveProject}
                  data-testid="tasks-filter-current-project"
                >
                  {t('tasks.filterCurrentProject')}
                </button>
              )}
              {activeSessionId && (
                <button
                  type="button"
                  className={`${styles.filterChip} ${
                    currentSessionId === activeSessionId ? styles.filterChipActive : ''
                  }`}
                  onClick={handleToggleCurrentSession}
                  aria-pressed={currentSessionId === activeSessionId}
                  data-testid="tasks-filter-current-session"
                >
                  {t('tasks.filterCurrentSession')}
                </button>
              )}
              {hasActiveFilter && (
                <button
                  type="button"
                  className={styles.filterClearBtn}
                  onClick={handleClearFilters}
                  data-testid="tasks-filter-clear"
                >
                  {t('tasks.filterClear')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className={styles.body}>
        {selectedTaskId ? (
          detailLoading && !detail ? (
            <div className={styles.empty}>{t('sidebar.loading')}</div>
          ) : detailError ? (
            <div className={styles.errorBanner}>{detailError}</div>
          ) : detail ? (
            <div className={styles.detailWrap} data-testid="task-detail-view">
              <div className={styles.metaGrid}>
                <div>
                  <span className={styles.metaKey}>ID</span>
                  <span className={styles.metaVal}>{detail.taskId}</span>
                </div>
                <div>
                  <span className={styles.metaKey}>{t(`tasks.kind.${detail.kind}`)}</span>
                  <span className={styles.metaVal}>{t(`tasks.status.${detail.status}`)}</span>
                </div>
                {detail.cwd && (
                  <div>
                    <span className={styles.metaKey}>CWD</span>
                    <span className={styles.metaVal}>{detail.cwd}</span>
                  </div>
                )}
                {detail.exitCode !== null && (
                  <div>
                    <span className={styles.metaKey}>Exit</span>
                    <span className={styles.metaVal}>{detail.exitCode}</span>
                  </div>
                )}
              </div>

              <div className={styles.detailBar}>
                <div className={styles.detailBarLeft}>
                  {detail.sessionId && onSelectSession && (
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() => {
                        onSelectSession(detail.sessionId!);
                        onClose();
                      }}
                      data-testid="task-jump-session-btn"
                    >
                      {t('tasks.jumpToSession')}
                    </button>
                  )}
                  {detail.stopCapability.canStop && (
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnDanger}`}
                      disabled={!isStopPermitted(detail).allowed || Boolean(stoppingIds[detail.taskId])}
                      title={isStopPermitted(detail).reason || t('tasks.stop')}
                      onClick={() => setConfirmStopTask(detail)}
                      data-testid="task-detail-stop-btn"
                    >
                      {stoppingIds[detail.taskId] ? t('tasks.status.stopping') : t('tasks.stop')}
                    </button>
                  )}
                </div>
                <div className={styles.detailBarRight}>
                  <label className={styles.autoScrollLabel}>
                    <input
                      type="checkbox"
                      checked={autoScroll}
                      onChange={(e) => setAutoScroll(e.target.checked)}
                    />
                    <span>{t('tasks.autoScroll')}</span>
                  </label>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => {
                      void apiClient.copyTextWithFallback(detail.logText || '');
                      setCopiedLog(true);
                      setTimeout(() => setCopiedLog(false), 1500);
                    }}
                  >
                    {copiedLog ? t('sideChat.copied') : t('tasks.copyLog')}
                  </button>
                </div>
              </div>

              {detail.truncated && (
                <div className={styles.truncatedBanner} data-testid="task-log-truncated-banner">
                  {t('tasks.truncatedNotice')}
                </div>
              )}

              <pre
                ref={logBoxRef}
                className={styles.logBox}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                  if (!nearBottom && autoScroll) setAutoScroll(false);
                }}
                data-testid="task-detail-log"
              >
                {detail.logText || t('tasks.noOutput')}
              </pre>
            </div>
          ) : null
        ) : displayedRunning.length === 0 && displayedRecent.length === 0 ? (
          <div className={styles.empty} data-testid="tasks-empty">
            <p className={styles.emptyText}>
              {hasActiveFilter ? t('tasks.filterEmpty') : t('tasks.empty')}
            </p>
            {hasActiveFilter && (
              <button
                type="button"
                className={styles.btn}
                onClick={handleClearFilters}
                data-testid="tasks-empty-clear-btn"
              >
                {t('tasks.filterClear')}
              </button>
            )}
          </div>
        ) : (
          <div className={styles.listWrap}>
            {displayedRunning.length > 0 && (
              <div className={styles.section}>
                <div className={styles.sectionTitle}>
                  {t('tasks.runningSection', { count: displayedRunning.length })}
                </div>
                {displayedRunning.map(renderTaskRow)}
              </div>
            )}
            {displayedRecent.length > 0 && (
              <div className={styles.section}>
                <div className={styles.sectionTitle}>
                  {t('tasks.recentSection', { count: displayedRecent.length })}
                </div>
                {displayedRecent.map(renderTaskRow)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
