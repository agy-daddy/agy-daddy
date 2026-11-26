import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import { BottomSheet } from '../layout/BottomSheet';
import { api } from '../store/api';
import type {
  BackgroundTaskDetailDto,
  BackgroundTaskDto,
  BackgroundTasksFilterProject,
  BackgroundTasksFilterSession,
  BackgroundTasksListResponse
} from '../types';
import styles from './SheetCommon.module.css';

export interface BackgroundTasksSheetProps {
  open: boolean;
  activeSessionId?: string | null;
  activeSessionTitle?: string | null;
  activeProjectPath?: string | null;
  activeProjectName?: string | null;
  onRunningCountChange?: (count: number) => void;
  onShowToast?: (msg: string) => void;
  onClose: () => void;
}

function fmtDuration(startedAt: number, endedAt?: number | null): string {
  const end = endedAt || Date.now();
  const sec = Math.max(0, Math.floor((end - startedAt) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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

export function BackgroundTasksSheet({
  open,
  activeSessionId = null,
  activeSessionTitle = null,
  activeProjectPath = null,
  activeProjectName = null,
  onRunningCountChange,
  onShowToast,
  onClose
}: BackgroundTasksSheetProps) {
  const { t } = useI18n();
  const [list, setList] = useState<BackgroundTasksListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BackgroundTaskDetailDto | null>(null);
  const [armedStopId, setArmedStopId] = useState<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const [filterProject, setFilterProject] = useState<string>('');
  const [filterSessionId, setFilterSessionId] = useState<string>('');
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const normalizedFilterProject = normalizeFilterPath(filterProject);
  const normalizedActiveProject = normalizeFilterPath(activeProjectPath);
  const hasActiveFilter = Boolean(filterProject || filterSessionId);

  const loadList = useCallback(
    async (override?: { project?: string; sessionId?: string }) => {
      const nextProj = override ? (override.project ?? '') : filterProject;
      const nextSess = override ? (override.sessionId ?? '') : filterSessionId;
      setLoading(true);
      try {
        const res =
          nextProj || nextSess
            ? await api.listTasks({
                project: nextProj || undefined,
                sessionId: nextSess || undefined
              })
            : await api.listTasks();
        setList(res);
        onRunningCountChange?.(res.totalRunningCount ?? res.runningCount ?? 0);
      } catch {
        // ignore transient error
      } finally {
        setLoading(false);
      }
    },
    [filterProject, filterSessionId, onRunningCountChange]
  );

  const loadDetail = useCallback(async (taskId: string) => {
    try {
      const res = await api.getTaskDetail(taskId);
      setDetail(res.task);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setDetail(null);
      setArmedStopId(null);
      return;
    }
    void loadList();
  }, [open, loadList]);

  useEffect(() => {
    if (!open || !selectedId) return;
    void loadDetail(selectedId);
    const timer = setInterval(() => {
      void loadDetail(selectedId);
    }, 2500);
    return () => clearInterval(timer);
  }, [open, selectedId, loadDetail]);

  useEffect(() => {
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, []);

  const handleStopClick = async (task: BackgroundTaskDto) => {
    if (!task.stopCapability.canStop || stoppingId) return;
    if (armedStopId !== task.id) {
      setArmedStopId(task.id);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      armTimerRef.current = setTimeout(() => setArmedStopId(null), 3000);
      return;
    }
    setArmedStopId(null);
    setStoppingId(task.id);
    try {
      const res = await api.stopTask(task.id);
      if (res.alreadyFinished) {
        onShowToast?.(t('tasks.alreadyFinished'));
      }
      await loadList();
      if (selectedId === task.id) {
        await loadDetail(task.id);
      }
    } catch (err) {
      onShowToast?.((err as Error).message);
    } finally {
      setStoppingId(null);
    }
  };

  const running = list?.running || [];
  const recent = list?.recent || [];

  const projectOptions = useMemo<BackgroundTasksFilterProject[]>(() => {
    const base: BackgroundTasksFilterProject[] = list?.filters?.projects
      ? list.filters.projects.map((p) => ({ ...p }))
      : [];
    if (
      normalizedActiveProject &&
      activeProjectPath &&
      !base.some((p) => normalizeFilterPath(p.key || p.path) === normalizedActiveProject)
    ) {
      base.unshift({
        key: normalizedActiveProject,
        name: activeProjectName || extractPathBasename(activeProjectPath),
        path: activeProjectPath,
        count: 0
      });
    }
    return base;
  }, [list?.filters?.projects, normalizedActiveProject, activeProjectPath, activeProjectName]);

  const allSessionOptions = useMemo<BackgroundTasksFilterSession[]>(() => {
    const base: BackgroundTasksFilterSession[] = list?.filters?.sessions
      ? list.filters.sessions.map((s) => ({ ...s }))
      : [];
    if (activeSessionId && !base.some((s) => s.id === activeSessionId)) {
      base.unshift({
        id: activeSessionId,
        title: activeSessionTitle || activeSessionId,
        projectPath: activeProjectPath || null,
        count: 0
      });
    }
    return base;
  }, [list?.filters?.sessions, activeSessionId, activeSessionTitle, activeProjectPath]);

  const visibleSessionOptions = useMemo(() => {
    if (!normalizedFilterProject) return allSessionOptions;
    return allSessionOptions.filter(
      (s) =>
        s.id === filterSessionId ||
        normalizeFilterPath(s.projectPath) === normalizedFilterProject
    );
  }, [allSessionOptions, normalizedFilterProject, filterSessionId]);

  const handleProjectChange = (nextProject: string) => {
    const nextNorm = normalizeFilterPath(nextProject);
    let nextSess = filterSessionId;
    if (nextNorm && nextSess) {
      const matched = allSessionOptions.find((s) => s.id === nextSess);
      if (matched && normalizeFilterPath(matched.projectPath) !== nextNorm) {
        nextSess = '';
      }
    }
    setFilterProject(nextProject);
    setFilterSessionId(nextSess);
  };

  const handleSessionChange = (nextSessionId: string) => {
    setFilterSessionId(nextSessionId);
  };

  const handleToggleCurrentProject = () => {
    if (!activeProjectPath) return;
    const isSame = normalizedFilterProject === normalizedActiveProject;
    handleProjectChange(isSame ? '' : (normalizedActiveProject || activeProjectPath));
  };

  const handleToggleCurrentSession = () => {
    if (!activeSessionId) return;
    if (filterSessionId === activeSessionId) {
      setFilterSessionId('');
      return;
    }
    if (
      normalizedFilterProject &&
      normalizedActiveProject &&
      normalizedFilterProject !== normalizedActiveProject
    ) {
      setFilterProject('');
    }
    setFilterSessionId(activeSessionId);
  };

  const handleClearFilters = () => {
    setFilterProject('');
    setFilterSessionId('');
  };

  const renderTaskCard = (task: BackgroundTaskDto) => {
    const isArmed = armedStopId === task.id;
    const isStopping = stoppingId === task.id;
    const statusTone =
      task.status === 'running'
        ? 'accent'
        : task.status === 'failed'
          ? 'danger'
          : task.status === 'completed'
            ? 'ok'
            : undefined;

    return (
      <div key={task.id} className={styles.card} data-testid={`bg-task-${task.id}`}>
        <div className={styles.rowBetween}>
          <div className={styles.taskBadgeRow}>
            <span className="ag-chip">{t(`tasks.kind.${task.kind}`)}</span>
            <span className="ag-chip" data-tone={statusTone}>
              {t(`tasks.status.${task.status}`)}
            </span>
            {task.projectName && (
              <span className="ag-chip">
                <span className="ag-chip-ellipsis">{task.projectName}</span>
              </span>
            )}
          </div>
          <span className={styles.kpiSub}>{fmtDuration(task.startedAt, task.endedAt)}</span>
        </div>

        <strong className={styles.taskCardTitle}>{task.title}</strong>
        {(task.sessionTitle || task.subtitle) && (
          <div className={styles.monoSmall}>{task.sessionTitle || task.subtitle}</div>
        )}

        <div className={styles.choiceWrap}>
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => setSelectedId(task.id)}
            data-testid={`bg-task-log-${task.id}`}
          >
            {t('tasks.viewLog')}
          </button>

          {task.status === 'running' && (
            <button
              type="button"
              className={`${styles.actionBtn} ${styles.actionDanger}`}
              disabled={!task.stopCapability.canStop || isStopping}
              title={task.stopCapability.reason}
              onClick={() => void handleStopClick(task)}
              data-testid={`bg-task-stop-${task.id}`}
            >
              {isStopping ? '…' : isArmed ? t('tasks.confirmStop') : t('tasks.stop')}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <BottomSheet
      open={open}
      title={selectedId && detail ? detail.title : t('tasks.title')}
      headerLeft={
        selectedId ? (
          <button
            type="button"
            className="ag-pill-btn"
            onClick={() => {
              setSelectedId(null);
              setDetail(null);
            }}
            data-testid="bg-tasks-back"
          >
            ‹ {t('common.back')}
          </button>
        ) : undefined
      }
      headerActions={
        <button
          type="button"
          className="ag-pill-btn"
          disabled={loading}
          onClick={() => {
            void loadList();
            if (selectedId) void loadDetail(selectedId);
          }}
        >
          {loading ? t('common.refreshing') : t('common.refresh')}
        </button>
      }
      testId="background-tasks-sheet"
      onClose={onClose}
    >
      <div className={styles.content}>
        {!selectedId && (
          <div className={styles.taskFilterCard} data-testid="bg-tasks-filter-bar">
            <div className={styles.taskFilterGrid}>
              <select
                className={styles.taskFilterSelect}
                value={filterProject}
                onChange={(ev) => handleProjectChange(ev.currentTarget.value)}
                aria-label={t('tasks.filterProjectAria')}
                data-testid="bg-tasks-filter-project-select"
              >
                <option value="">{t('tasks.filterAllProjects')}</option>
                {projectOptions.map((proj) => (
                  <option key={proj.key} value={proj.key}>
                    {proj.count > 0 ? `${proj.name} (${proj.count})` : proj.name}
                  </option>
                ))}
              </select>
              <select
                className={styles.taskFilterSelect}
                value={filterSessionId}
                onChange={(ev) => handleSessionChange(ev.currentTarget.value)}
                aria-label={t('tasks.filterSessionAria')}
                data-testid="bg-tasks-filter-session-select"
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
              <div className={styles.choiceWrap}>
                {activeProjectPath && (
                  <button
                    type="button"
                    className={`${styles.choiceBtn} ${
                      normalizedFilterProject === normalizedActiveProject ? styles.choiceBtnActive : ''
                    }`}
                    onClick={handleToggleCurrentProject}
                    aria-pressed={normalizedFilterProject === normalizedActiveProject}
                    data-testid="bg-tasks-filter-current-project"
                  >
                    {t('tasks.filterCurrentProject')}
                  </button>
                )}
                {activeSessionId && (
                  <button
                    type="button"
                    className={`${styles.choiceBtn} ${
                      filterSessionId === activeSessionId ? styles.choiceBtnActive : ''
                    }`}
                    onClick={handleToggleCurrentSession}
                    aria-pressed={filterSessionId === activeSessionId}
                    data-testid="bg-tasks-filter-current-session"
                  >
                    {t('tasks.filterCurrentSession')}
                  </button>
                )}
                {hasActiveFilter && (
                  <button
                    type="button"
                    className={styles.choiceBtn}
                    onClick={handleClearFilters}
                    data-testid="bg-tasks-filter-clear"
                  >
                    {t('tasks.filterClear')}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {selectedId ? (
          detail ? (
            <div className={styles.card} data-testid="bg-task-detail">
              <div className={styles.rowBetween}>
                <span className="ag-chip">{t(`tasks.kind.${detail.kind}`)}</span>
                <span className="ag-chip">{t(`tasks.status.${detail.status}`)}</span>
              </div>
              {detail.truncated && (
                <div className={styles.alertBox}>{t('tasks.truncatedLog')}</div>
              )}
              <pre className={styles.logPre} data-hscroll="1">
                {detail.logText || t('tasks.noLogs')}
              </pre>
            </div>
          ) : (
            <div className="ag-empty">{t('common.refreshing')}</div>
          )
        ) : running.length === 0 && recent.length === 0 ? (
          <div className="ag-empty" data-testid="bg-tasks-empty">
            <div>{hasActiveFilter ? t('tasks.filterEmpty') : t('tasks.empty')}</div>
            {hasActiveFilter && (
              <div className={styles.emptyActionWrap}>
                <button
                  type="button"
                  className={styles.actionBtn}
                  onClick={handleClearFilters}
                  data-testid="bg-tasks-empty-clear"
                >
                  {t('tasks.filterClear')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {running.length > 0 && (
              <>
                <span className={styles.sectionTitle}>
                  {t('tasks.running')} ({running.length})
                </span>
                {running.map(renderTaskCard)}
              </>
            )}
            {recent.length > 0 && (
              <>
                <span className={styles.sectionTitle}>
                  {t('tasks.recent')} ({recent.length})
                </span>
                {recent.map(renderTaskCard)}
              </>
            )}
          </>
        )}
      </div>
    </BottomSheet>
  );
}
