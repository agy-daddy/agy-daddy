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
  permissionLevel: PermissionLevel;
  telemetry: TelemetryPanels;
  contextExpanded: boolean;
  onOpenLeft: () => void;
  onOpenRight: () => void;
  onToggleContext: () => void;
  onOpenModelPicker?: () => void;
}

function fmtTok(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '--';
  const n = Math.max(0, Number(v));
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

function parseQuotaPct(
  entry?: {
    percentText?: string;
    remainingPercent?: number | null;
    remainingFraction?: number | null;
  } | null
): number | null {
  if (!entry) return null;
  if (typeof entry.remainingPercent === 'number' && Number.isFinite(entry.remainingPercent)) {
    return Math.max(0, Math.min(100, Math.round(entry.remainingPercent)));
  }
  if (typeof entry.remainingFraction === 'number' && Number.isFinite(entry.remainingFraction)) {
    return Math.max(0, Math.min(100, Math.round(entry.remainingFraction * 100)));
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
        stroke="rgba(127,127,140,0.24)"
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
        stroke="rgba(127,127,140,0.18)"
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

export function TopBar({
  title,
  attentionCount,
  changedFilesCount,
  permissionLevel,
  telemetry,
  contextExpanded,
  onOpenLeft,
  onOpenRight,
  onToggleContext
}: TopBarProps) {
  const ctx = (telemetry?.context?.available ? telemetry.context.data : null) as
    | ContextTelemetryData
    | null;
  const quota = (telemetry?.quota?.available ? telemetry.quota.data : null) as
    | QuotaTelemetryData
    | null;

  const risk = ctx?.cacheDropDetected ? 'critical' : String(ctx?.cacheCliffRisk || 'none');
  const occ = Number(ctx?.percent || 0);
  const hit = Number(ctx?.cacheHitRate || 0);
  const ctxUsedLabel = ctx && ctx.used != null ? fmtTok(ctx.used) : permissionLevel;
  const ctxPctLabel =
    ctx && ctx.percent != null && Number.isFinite(Number(ctx.percent))
      ? `${Math.round(Number(ctx.percent))}%`
      : '';

  const geminiPct = parseQuotaPct(quota?.gemini?.fiveHour || quota?.gemini);
  const claudePct = parseQuotaPct(quota?.claude?.fiveHour || quota?.claude);
  const lowestQuota =
    geminiPct !== null && claudePct !== null
      ? Math.min(geminiPct, claudePct)
      : geminiPct ?? claudePct;
  const qTone = quotaTone(lowestQuota);

  return (
    <header className={styles.topbar}>
      <div className={styles.rowPrimary}>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label="打开左侧会话与导航抽屉"
          data-testid="open-left-drawer"
          onClick={onOpenLeft}
        >
          <span aria-hidden="true">☰</span>
          {attentionCount > 0 && (
            <span
              className={`ag-badge-dot ag-badge-danger ${styles.badge}`}
              data-testid="attention-badge"
            >
              {attentionCount > 99 ? '99+' : attentionCount}
            </span>
          )}
        </button>

        <button
          type="button"
          className={styles.titleBtn}
          onClick={onOpenLeft}
          title={title || '选择会话'}
        >
          <span className={styles.titleText}>{title || 'Agy-Daddy Remote'}</span>
        </button>

        <button
          type="button"
          className={styles.iconBtn}
          aria-label="打开右侧工作区抽屉"
          data-testid="open-right-drawer"
          onClick={onOpenRight}
        >
          <span aria-hidden="true">⌘</span>
          {changedFilesCount > 0 && (
            <span className={`ag-badge-dot ag-badge-neutral ${styles.badge}`}>
              {changedFilesCount > 99 ? '99+' : changedFilesCount}
            </span>
          )}
        </button>
      </div>

      <div className={styles.rowTelemetry}>
        <div className={styles.capsules}>
          <button
            type="button"
            className={styles.capsule}
            data-risk={risk}
            data-expanded={contextExpanded ? '1' : undefined}
            aria-expanded={contextExpanded}
            data-testid="context-capsule-btn"
            onClick={onToggleContext}
            title="展开上下文与配额监控面板"
          >
            <DualRingSvg occ={occ} hit={hit} risk={risk} />
            <span className={styles.capVal}>{ctxUsedLabel}</span>
            {ctxPctLabel && <span className={styles.capSub}>{ctxPctLabel}</span>}
          </button>

          <button
            type="button"
            className={styles.capsule}
            data-tone={qTone}
            data-expanded={contextExpanded ? '1' : undefined}
            aria-expanded={contextExpanded}
            data-testid="quota-capsule-btn"
            onClick={onToggleContext}
            title="展开配额与用量监控面板"
          >
            {geminiPct === null && claudePct === null ? (
              <span className={styles.capSub}>配额 --</span>
            ) : (
              <>
                {geminiPct !== null && (
                  <span className={styles.quotaPair} data-tone={quotaTone(geminiPct)}>
                    <span className={styles.quotaKey}>G</span>
                    <span className={styles.capVal}>{geminiPct}%</span>
                  </span>
                )}
                {geminiPct !== null && claudePct !== null && (
                  <span className={styles.quotaSep} aria-hidden="true" />
                )}
                {claudePct !== null && (
                  <span className={styles.quotaPair} data-tone={quotaTone(claudePct)}>
                    <span className={styles.quotaKey}>C</span>
                    <span className={styles.capVal}>{claudePct}%</span>
                  </span>
                )}
              </>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
