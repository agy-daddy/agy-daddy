import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/api';
import type {
  ContextTelemetryData,
  PermissionLevel,
  QuotaModelEntry,
  QuotaTelemetryData,
  QuotaWindowSlot,
  TelemetryPanels,
  UsageTelemetryData
} from '../types';
import styles from './TelemetryPanel.module.css';

export interface TelemetryPanelProps {
  open: boolean;
  telemetry: TelemetryPanels;
  modelName: string;
  channel: string;
  permissionLevel: PermissionLevel;
  token: string;
  onClose: () => void;
}

function fmtTok(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '--';
  const n = Math.max(0, Number(v));
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

function parseQuota(
  entry?: QuotaWindowSlot | null
): { pct: number | null; text: string; countdown: string } {
  if (!entry) return { pct: null, text: '--', countdown: '' };
  const countdown = typeof entry.countdownText === 'string' ? entry.countdownText.trim() : '';
  if (typeof entry.remainingPercent === 'number' && Number.isFinite(entry.remainingPercent)) {
    const pct = Math.max(0, Math.min(100, Math.round(entry.remainingPercent)));
    return { pct, text: entry.percentText || `${pct}%`, countdown };
  }
  if (typeof entry.remainingFraction === 'number' && Number.isFinite(entry.remainingFraction)) {
    const pct = Math.max(0, Math.min(100, Math.round(entry.remainingFraction * 100)));
    return { pct, text: entry.percentText || `${pct}%`, countdown };
  }
  if (typeof entry.percentText === 'string' && entry.percentText.trim()) {
    const m = entry.percentText.match(/(\d+(?:\.\d+)?)/);
    const pct = m ? Math.max(0, Math.min(100, Math.round(Number(m[1])))) : null;
    return { pct, text: entry.percentText.trim(), countdown };
  }
  return { pct: null, text: '--', countdown };
}

function resolveQuotaWindows(entry?: QuotaModelEntry | null): {
  fiveHour: { pct: number | null; text: string; countdown: string };
  weekly: { pct: number | null; text: string; countdown: string };
} {
  if (!entry) {
    return {
      fiveHour: { pct: null, text: '--', countdown: '' },
      weekly: { pct: null, text: '--', countdown: '' }
    };
  }
  const raw5h = entry.fiveHour || entry.fiveHourBucket || null;
  const rawWeekly = entry.weekly || entry.weeklyBucket || null;
  // Legacy fallback: if upstream only provides top-level percentage without 5h/weekly split, show it under 5h
  const hasExplicitWindows = Boolean(raw5h || rawWeekly);
  return {
    fiveHour: parseQuota(raw5h || (!hasExplicitWindows ? entry : null)),
    weekly: parseQuota(rawWeekly)
  };
}

function barTone(pct: number | null): 'danger' | 'warn' | 'ok' {
  if (pct === null) return 'ok';
  if (pct <= 15) return 'danger';
  if (pct <= 35) return 'warn';
  return 'ok';
}

export function TelemetryPanel({
  open,
  telemetry,
  modelName,
  channel,
  permissionLevel,
  token,
  onClose
}: TelemetryPanelProps) {
  const [latencyState, setLatencyState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [latencyText, setLatencyText] = useState('测速');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const ctx = (telemetry?.context?.available ? telemetry.context.data : null) as
    | ContextTelemetryData
    | null;
  const usage = (telemetry?.usage?.available ? telemetry.usage.data : null) as
    | UsageTelemetryData
    | null;
  const quota = (telemetry?.quota?.available ? telemetry.quota.data : null) as
    | QuotaTelemetryData
    | null;

  const warnTok = Number(ctx?.warnThresholdTokens) || 240000;
  const cliffTok = Number(ctx?.cliffThresholdTokens) || 328000;
  const budget = Number(ctx?.budget || 0);
  const pct = Math.max(0, Math.min(100, Number(ctx?.percent || 0)));
  const risk = ctx?.cacheDropDetected ? 'critical' : String(ctx?.cacheCliffRisk || 'none');
  const ctxTone = risk === 'critical' ? 'danger' : risk === 'warn' ? 'warn' : 'ok';
  const riskLabel =
    ctx?.cacheDropDetected
      ? '缓存骤降'
      : risk === 'critical'
        ? '断崖风险'
        : risk === 'warn'
          ? '接近预警'
          : '缓存正常';

  const warnPos = budget > 0 ? (warnTok / budget) * 100 : 0;
  const cliffPos = budget > 0 ? (cliffTok / budget) * 100 : 0;
  const speedTps = ctx?.speed?.tps ?? ctx?.tokPerSec ?? null;

  const geminiW = resolveQuotaWindows(quota?.gemini);
  const claudeW = resolveQuotaWindows(quota?.claude);

  const runProbe = async () => {
    if (latencyState === 'busy') return;
    setLatencyState('busy');
    setLatencyText('测速中...');
    try {
      const ms = await api.pingLatency();
      setLatencyState('done');
      setLatencyText(`${ms} ms`);
    } catch {
      setLatencyState('error');
      setLatencyText('失败');
    }
  };

  const entryHref = token ? `/entry?t=${encodeURIComponent(token)}` : '/entry';

  return (
    <>
      <div className={styles.dismissMask} aria-hidden="true" onClick={onClose} />
      <section
        className={styles.panel}
        role="region"
        aria-label="上下文与配额监控面板"
        data-testid="telemetry-panel"
      >
        <div className={styles.card}>
          <div className={styles.row}>
            <span className={styles.cardTitle}>
              上下文窗口
              {modelName ? <span className={styles.modelInline}> · {modelName}</span> : null}
            </span>
            <span className="ag-chip" data-tone={ctxTone}>
              {riskLabel}
            </span>
          </div>

          <div className={styles.kpiRow}>
            <div className={styles.kpiPrimary}>
              <span className={styles.kpiBig}>{fmtTok(ctx?.used)}</span>
              <span className={styles.kpiBudget}>/ {fmtTok(ctx?.budget)}</span>
            </div>
            <div className={styles.kpiRight}>
              <span className={styles.kpiStat}>
                {ctx?.percent != null ? `${Math.round(Number(ctx.percent))}%` : '--'}
              </span>
              <span className={styles.dotSep}>·</span>
              <span className={styles.kpiStat}>命中 {ctx?.cacheHitRate ?? 0}%</span>
              {speedTps != null && Number(speedTps) > 0 && (
                <>
                  <span className={styles.dotSep}>·</span>
                  <span className={styles.kpiStat}>{Number(speedTps).toFixed(0)} tok/s</span>
                </>
              )}
            </div>
          </div>

          <div className={styles.track} aria-hidden="true">
            <div
              className={styles.fill}
              data-tone={ctxTone}
              style={{ width: `${pct}%` }}
            />
            {warnPos >= 6 && warnPos <= 94 && (
              <span className={styles.tick} style={{ left: `${warnPos.toFixed(1)}%` }} />
            )}
            {cliffPos >= 6 && cliffPos <= 94 && (
              <span className={`${styles.tick} ${styles.tickCliff}`} style={{ left: `${cliffPos.toFixed(1)}%` }} />
            )}
          </div>
        </div>

        <div className={styles.card} data-testid="quota-panel-card">
          <div className={styles.row}>
            <span className={styles.cardTitle}>剩余配额</span>
            <span className={styles.meta}>
              {usage
                ? `累计 ${fmtTok(usage.totalTokens || 0)} · ${usage.currencySymbol || '$'}${Number(usage.totalDisplayCost ?? usage.totalUsd ?? 0).toFixed(2)}`
                : '暂无累计账本'}
            </span>
          </div>

          <div className={styles.quotaGrid}>
            {[
              { key: 'gemini', title: 'Gemini', windows: geminiW },
              { key: 'claude', title: 'Claude', windows: claudeW }
            ].map((group) => (
              <div key={group.key} className={styles.quotaBox}>
                <div className={styles.quotaGroupTitle}>{group.title}</div>

                <div className={styles.quotaWinRow} data-testid={`quota-${group.key}-5h`}>
                  <div className={styles.quotaHead}>
                    <span className={styles.quotaWinLabel}>5h</span>
                    <span className={styles.quotaRightMeta}>
                      {group.windows.fiveHour.countdown && (
                        <span className={styles.quotaCountdown}>{group.windows.fiveHour.countdown}</span>
                      )}
                      <span className={styles.quotaPct} data-tone={barTone(group.windows.fiveHour.pct)}>
                        {group.windows.fiveHour.text}
                      </span>
                    </span>
                  </div>
                  <div className={styles.quotaTrack}>
                    <div
                      className={styles.quotaFill}
                      data-tone={barTone(group.windows.fiveHour.pct)}
                      style={{ width: `${group.windows.fiveHour.pct ?? 0}%` }}
                    />
                  </div>
                </div>

                <div className={styles.quotaWinRow} data-testid={`quota-${group.key}-weekly`}>
                  <div className={styles.quotaHead}>
                    <span className={styles.quotaWinLabel}>Week</span>
                    <span className={styles.quotaRightMeta}>
                      {group.windows.weekly.countdown && (
                        <span className={styles.quotaCountdown}>{group.windows.weekly.countdown}</span>
                      )}
                      <span className={styles.quotaPct} data-tone={barTone(group.windows.weekly.pct)}>
                        {group.windows.weekly.text}
                      </span>
                    </span>
                  </div>
                  <div className={styles.quotaTrack}>
                    <div
                      className={styles.quotaFill}
                      data-tone={barTone(group.windows.weekly.pct)}
                      style={{ width: `${group.windows.weekly.pct ?? 0}%` }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.footer}>
          <span className="ag-chip" data-tone={permissionLevel === 'L0' ? 'warn' : 'accent'}>
            {channel} · {permissionLevel}
          </span>
          <div className={styles.actions}>
            <button
              type="button"
              className="ag-pill-btn"
              disabled={latencyState === 'busy'}
              onClick={runProbe}
            >
              {latencyText}
            </button>
            <a className="ag-pill-btn" href={entryHref} style={{ textDecoration: 'none' }}>
              /entry 切换
            </a>
            <button type="button" className="ag-pill-btn" onClick={onClose}>
              收起
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
