import { useI18n } from '../i18n';
import type { SseStatus } from '../store/sse';
import { useRemoteSelector } from '../store/useRemoteStore';
import type {
  ContextTelemetryData,
  PermissionLevel,
  QuotaTelemetryData,
  TelemetryPanels
} from '../types';
import styles from './TopBar.module.css';

export interface TopBarProps {
  title: string;
  modelName?: string;
  modelTag?: string | null;
  attentionCount: number;
  changedFilesCount: number;
  runningTasksCount?: number;
  permissionLevel: PermissionLevel;
  telemetry: TelemetryPanels;
  contextExpanded: boolean;
  online?: boolean;
  sseStatus?: SseStatus;
  rpcConnected?: boolean;
  onOpenLeft: () => void;
  onOpenRight: () => void;
  onToggleContext: (tab?: 'context' | 'usage' | 'quota') => void;
  onOpenTasks?: () => void;
  onOpenMenu?: () => void;
  onReconnect?: () => void;
  onOpenModelPicker?: () => void;
}

function parseQuotaPct(
  entry?: {
    percentText?: string;
    remainingPercent?: number | null;
    remainingFraction?: number | null;
    tightestFraction?: number | null;
  } | null
): number | null {
  if (!entry) return null;
  if (typeof entry.remainingPercent === 'number' && Number.isFinite(entry.remainingPercent)) {
    return Math.max(0, Math.min(100, Math.round(entry.remainingPercent)));
  }
  if (typeof entry.remainingFraction === 'number' && Number.isFinite(entry.remainingFraction)) {
    return Math.max(0, Math.min(100, Math.round(entry.remainingFraction * 100)));
  }
  if (typeof entry.tightestFraction === 'number' && Number.isFinite(entry.tightestFraction)) {
    return Math.max(0, Math.min(100, Math.round(entry.tightestFraction * 100)));
  }
  if (typeof entry.percentText === 'string') {
    const m = entry.percentText.match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
    }
  }
  return null;
}

function quotaTone(pct: number | null): 'danger' | 'warn' | 'ok' | undefined {
  if (pct === null) return undefined;
  if (pct <= 15) return 'danger';
  if (pct <= 35) return 'warn';
  return 'ok';
}

function DualRingSvg({ occ, hit, risk }: { occ: number; hit: number; risk: string }) {
  const p = Math.max(0, Math.min(100, Math.round(occ || 0)));
  const h = Math.max(0, Math.min(100, Math.round(hit || 0)));
  const rO = 6.2;
  const rI = 3.4;
  const cO = Number((2 * Math.PI * rO).toFixed(2));
  const cI = Number((2 * Math.PI * rI).toFixed(2));
  const dO = Number(((p / 100) * cO).toFixed(2));
  const dI = Number(((h / 100) * cI).toFixed(2));
  const stroke =
    risk === 'critical' || p >= 80
      ? 'var(--ag-danger)'
      : risk === 'warn' || p >= 55
        ? 'var(--ag-warn)'
        : 'var(--ag-accent)';

  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" className={styles.ringSvg}>
      <circle
        cx="8"
        cy="8"
        r={rO}
        fill="none"
        stroke="var(--ag-border)"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r={rO}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${dO} ${cO}`}
        transform="rotate(-90 8 8)"
      />
      <circle
        cx="8"
        cy="8"
        r={rI}
        fill="none"
        stroke="var(--ag-border-sub)"
        strokeWidth="1.7"
      />
      <circle
        cx="8"
        cy="8"
        r={rI}
        fill="none"
        stroke="var(--ag-ok)"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeDasharray={`${dI} ${cI}`}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

interface TopBarStatusButtonProps {
  title: string;
  onlineProp?: boolean;
  sseStatusProp?: SseStatus;
  rpcConnectedProp?: boolean;
  onReconnect?: () => void;
  onOpenLeft: () => void;
}

function TopBarStatusButton({
  title,
  onlineProp,
  sseStatusProp,
  rpcConnectedProp,
  onReconnect,
  onOpenLeft
}: TopBarStatusButtonProps) {
  const { t } = useI18n();
  const storeConn = useRemoteSelector((st) => ({
    online: st.online,
    sseStatus: st.sseStatus,
    rpcConnected: st.rpcConnected
  }));
  const online = onlineProp ?? storeConn.online;
  const sseStatus = sseStatusProp ?? storeConn.sseStatus;
  const rpcConnected = rpcConnectedProp ?? storeConn.rpcConnected;

  const connTone: 'ok' | 'warn' | 'danger' =
    !online || sseStatus === 'disconnected'
      ? 'danger'
      : sseStatus === 'connecting' || sseStatus === 'suspended' || !rpcConnected
        ? 'warn'
        : 'ok';
  const connLabel =
    connTone === 'ok'
      ? t('topbar.connOk')
      : connTone === 'warn'
        ? t('topbar.connWarn')
        : t('topbar.connDanger');

  return (
    <button
      type="button"
      className={styles.titleBtn}
      data-testid="topbar-status-btn"
      onClick={() => {
        if (connTone !== 'ok' && onReconnect) {
          onReconnect();
        } else {
          onOpenLeft();
        }
      }}
      title={`${title || t('app.title')} · ${connLabel}`}
    >
      <span
        className={styles.statusDot}
        data-tone={connTone}
        data-testid="topbar-conn-dot"
        aria-label={connLabel}
      />
      <span className={styles.titleText}>{title || t('app.title')}</span>
    </button>
  );
}

export function TopBar({
  title,
  attentionCount,
  changedFilesCount,
  runningTasksCount = 0,
  telemetry,
  contextExpanded,
  online,
  sseStatus,
  rpcConnected,
  onOpenLeft,
  onOpenRight,
  onToggleContext,
  onOpenTasks,
  onOpenMenu,
  onReconnect
}: TopBarProps) {
  const { t } = useI18n();
  const ctx = (telemetry?.context?.available ? telemetry.context.data : null) as
    | ContextTelemetryData
    | null;
  const quota = (telemetry?.quota?.available ? telemetry.quota.data : null) as
    | QuotaTelemetryData
    | null;

  const displayLocation = ctx?.displayLocation === 'composer' ? 'composer' : 'topbar';
  const risk = ctx?.cacheDropDetected ? 'critical' : String(ctx?.cacheCliffRisk || ctx?.riskLevel || 'none');
  const occ =
    ctx?.percent != null
      ? Number(ctx.percent)
      : ctx?.usageRatio != null
        ? Number(ctx.usageRatio) * 100
        : ctx?.used != null && ctx?.budget
          ? (Number(ctx.used) / Number(ctx.budget)) * 100
          : 0;
  const hit = Number(ctx?.cacheHitRate || 0);
  const ctxPctLabel = Number.isFinite(occ) && ctx && (ctx.used != null || ctx.percent != null)
    ? `${Math.round(occ)}%`
    : '--';

  const poolTightest =
    typeof quota?.tightestFraction === 'number'
      ? Math.max(0, Math.min(100, Math.round(quota.tightestFraction * 100)))
      : Array.isArray(quota?.pools) && quota.pools.length > 0
        ? quota.pools
            .map((p) => parseQuotaPct(p.fiveHourBucket || p))
            .filter((n): n is number => n !== null)
            .reduce<number | null>((min, n) => (min === null ? n : Math.min(min, n)), null)
        : null;
  const geminiPct = parseQuotaPct(quota?.gemini?.fiveHour || quota?.gemini);
  const claudePct = parseQuotaPct(quota?.claude?.fiveHour || quota?.claude);
  const lowestQuota =
    poolTightest ??
    (geminiPct !== null && claudePct !== null
      ? Math.min(geminiPct, claudePct)
      : geminiPct ?? claudePct);
  const qTone = quotaTone(lowestQuota);

  return (
    <header className={styles.topbar} data-testid="topbar">
      <button
        type="button"
        className={styles.iconBtn}
        aria-label={t('topbar.leftDrawer')}
        data-testid="open-left-drawer"
        onClick={onOpenLeft}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2.5 5.25H13.5M2.5 10.75H10.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
        {attentionCount > 0 && (
          <span
            className={`ag-badge-dot ag-badge-danger ${styles.badge}`}
            data-testid="attention-badge"
          >
            {attentionCount > 99 ? '99+' : attentionCount}
          </span>
        )}
      </button>

      <TopBarStatusButton
        title={title}
        onlineProp={online}
        sseStatusProp={sseStatus}
        rpcConnectedProp={rpcConnected}
        onReconnect={onReconnect}
        onOpenLeft={onOpenLeft}
      />

      <div className={styles.rightGroup}>
        {displayLocation === 'topbar' && (
          <button
            type="button"
            className={styles.capsule}
            data-risk={risk}
            data-expanded={contextExpanded ? '1' : undefined}
            aria-expanded={contextExpanded}
            data-testid="context-capsule-btn"
            onClick={() => onToggleContext('context')}
            title={t('telemetry.contextTab')}
          >
            <DualRingSvg occ={occ} hit={hit} risk={risk} />
            <span className={styles.capVal}>{ctxPctLabel}</span>
          </button>
        )}

        <button
          type="button"
          className={styles.capsule}
          data-tone={qTone}
          data-expanded={contextExpanded ? '1' : undefined}
          aria-expanded={contextExpanded}
          data-testid="quota-capsule-btn"
          onClick={() => onToggleContext('quota')}
          title={t('telemetry.quotaTab')}
        >
          <span className={styles.capVal}>
            {lowestQuota !== null ? `${lowestQuota}%` : t('topbar.quota')}
          </span>
        </button>

        {runningTasksCount > 0 && (
          <button
            type="button"
            className={styles.tasksBtn}
            aria-label={t('topbar.tasks')}
            data-testid="topbar-tasks-btn"
            onClick={onOpenTasks}
            title={`${t('topbar.tasks')} (${runningTasksCount})`}
          >
            <span className={styles.taskPulse} aria-hidden="true" />
            <span>{runningTasksCount > 99 ? '99+' : runningTasksCount}</span>
          </button>
        )}

        <button
          type="button"
          className={styles.iconBtn}
          aria-label={t('topbar.menu')}
          data-testid="topbar-menu-btn"
          onClick={onOpenMenu}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1.35" />
            <circle cx="8" cy="8" r="1.35" />
            <circle cx="12.5" cy="8" r="1.35" />
          </svg>
        </button>

        <button
          type="button"
          className={styles.iconBtn}
          aria-label={t('topbar.rightDrawer')}
          data-testid="open-right-drawer"
          onClick={onOpenRight}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2.25 4.25C2.25 3.42 2.92 2.75 3.75 2.75H6.4L7.75 4.25H12.25C13.08 4.25 13.75 4.92 13.75 5.75V11.75C13.75 12.58 13.08 13.25 12.25 13.25H3.75C2.92 13.25 2.25 12.58 2.25 11.75V4.25Z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path
              d="M6.25 8.75L5 9.95L6.25 11.15M9.75 8.75L11 9.95L9.75 11.15"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {changedFilesCount > 0 && (
            <span className={`ag-badge-dot ag-badge-neutral ${styles.badge}`}>
              {changedFilesCount > 99 ? '99+' : changedFilesCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}
