import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import { BottomSheet } from '../layout/BottomSheet';
import { api } from '../store/api';
import type {
  BackgroundTaskDetailDto,
  BackgroundTaskDto,
  BackgroundTasksListResponse
} from '../types';
import styles from './SheetCommon.module.css';

export interface BackgroundTasksSheetProps {
  open: boolean;
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

export function BackgroundTasksSheet({
  open,
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
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listTasks();
      setList(res);
      onRunningCountChange?.(res.runningCount ?? 0);
    } catch {
      // ignore transient error
    } finally {
      setLoading(false);
    }
  }, [onRunningCountChange]);

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="ag-chip">{t(`tasks.kind.${task.kind}`)}</span>
            <span className="ag-chip" data-tone={statusTone}>
              {t(`tasks.status.${task.status}`)}
            </span>
          </div>
          <span className={styles.kpiSub}>{fmtDuration(task.startedAt, task.endedAt)}</span>
        </div>

        <strong style={{ fontSize: 13.5, wordBreak: 'break-word' }}>{task.title}</strong>
        {task.subtitle && <div className={styles.monoSmall}>{task.subtitle}</div>}

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
          <div className="ag-empty">{t('tasks.empty')}</div>
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
