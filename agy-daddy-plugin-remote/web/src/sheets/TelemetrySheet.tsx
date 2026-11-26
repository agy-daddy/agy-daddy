import { useState } from 'preact/hooks';
import { normalizeCacheHitRatePct } from '../chat/composerUtils';
import { useI18n } from '../i18n';
import { BottomSheet } from '../layout/BottomSheet';
import type {
  ContextGroupItem,
  ContextTelemetryData,
  PermissionLevel,
  QuotaModelEntry,
  QuotaPoolDto,
  QuotaTelemetryData,
  QuotaWindowSlot,
  TelemetryPanels,
  UsageByModelItem,
  UsageTelemetryData
} from '../types';
import styles from './SheetCommon.module.css';

export interface TelemetrySheetProps {
  open: boolean;
  activeTab: 'context' | 'usage' | 'quota';
  telemetry: TelemetryPanels;
  modelName: string;
  permissionLevel: PermissionLevel;
  hasActiveSession: boolean;
  onSelectTab: (tab: 'context' | 'usage' | 'quota') => void;
  onRunCompact: () => Promise<boolean>;
  onClose: () => void;
}

function fmtTok(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '--';
  const n = Math.max(0, Number(v));
  if (n >= 1e6) return `${(n / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(Math.round(n));
}

function fmtCost(v: number | null | undefined, sym = '$'): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '--';
  const num = Number(v);
  return `${sym}${num.toFixed(Math.abs(num) > 0 && Math.abs(num) < 1 ? 3 : 2)}`;
}

function parseQuota(
  entry?: QuotaWindowSlot | null
): { pct: number | null; text: string; countdown: string } {
  if (!entry) return { pct: null, text: '--', countdown: '' };
  const countdown = String(
    entry.countdownText || entry.resetInHuman || entry.resetIn || entry.resetTimeText || ''
  ).trim();
  if (typeof entry.remainingPercent === 'number' && Number.isFinite(entry.remainingPercent)) {
    const pct = Math.max(0, Math.min(100, Math.round(entry.remainingPercent)));
    return { pct, text: entry.percentText || `${pct}%`, countdown };
  }
  const frac = entry.remainingFraction ?? entry.fraction;
  if (typeof frac === 'number' && Number.isFinite(frac)) {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    return { pct, text: entry.percentText || `${pct}%`, countdown };
  }
  if (typeof entry.percentText === 'string' && entry.percentText.trim()) {
    const m = entry.percentText.match(/(\d+(?:\.\d+)?)/);
    const pct = m ? Math.max(0, Math.min(100, Math.round(Number(m[1])))) : null;
    return { pct, text: entry.percentText.trim(), countdown };
  }
  return { pct: null, text: '--', countdown };
}

function resolveLegacyQuota(entry?: QuotaModelEntry | null) {
  if (!entry) {
    return {
      fiveHour: { pct: null, text: '--', countdown: '' },
      weekly: { pct: null, text: '--', countdown: '' }
    };
  }
  const raw5h = entry.fiveHour || entry.fiveHourBucket || null;
  const rawWeekly = entry.weekly || entry.weeklyBucket || null;
  const hasExplicit = Boolean(raw5h || rawWeekly);
  return {
    fiveHour: parseQuota(raw5h || (!hasExplicit ? entry : null)),
    weekly: parseQuota(rawWeekly)
  };
}

function toneForPct(pct: number | null): 'danger' | 'warn' | 'ok' {
  if (pct === null) return 'ok';
  if (pct <= 15) return 'danger';
  if (pct <= 35) return 'warn';
  return 'ok';
}

const GROUP_PALETTE = [
  'var(--ag-group-1)',
  'var(--ag-group-2)',
  'var(--ag-group-3)',
  'var(--ag-group-4)',
  'var(--ag-group-5)'
];

function normalizeGroups(raw: ContextTelemetryData['groups']): ContextGroupItem[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((g) => g && Number(g.tokens) > 0)
      .map((g) => ({
        id: String(g.id || g.label),
        label: String(g.label || g.id),
        tokens: Number(g.tokens || 0),
        share: g.share
      }));
  }
  if (typeof raw === 'object') {
    return Object.entries(raw)
      .map(([k, v]) => {
        const tok =
          typeof v === 'number'
            ? v
            : v && typeof v === 'object'
              ? Number((v as Record<string, unknown>).tokens ?? (v as Record<string, unknown>).high ?? 0)
              : 0;
        return { id: k, label: k, tokens: tok };
      })
      .filter((g) => g.tokens > 0);
  }
  return [];
}

function normalizeByModel(raw: UsageTelemetryData['byModel']): UsageByModelItem[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .filter((m) => m && Number(m.totalTokens) > 0)
      .slice()
      .sort((a, b) => Number(b.totalTokens) - Number(a.totalTokens));
  }
  if (typeof raw === 'object') {
    return Object.entries(raw)
      .map(([model, val]) => {
        const rec = (val && typeof val === 'object' ? val : {}) as Record<string, unknown>;
        return {
          model,
          label: model,
          totalTokens: Number(rec.tokens ?? rec.totalTokens ?? (typeof val === 'number' ? val : 0)),
          costUsd: Number(rec.costUSD ?? rec.costUsd ?? rec.cost ?? 0)
        };
      })
      .filter((m) => m.totalTokens > 0)
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }
  return [];
}

export function TelemetrySheet({
  open,
  activeTab,
  telemetry,
  modelName,
  permissionLevel,
  hasActiveSession,
  onSelectTab,
  onRunCompact,
  onClose
}: TelemetrySheetProps) {
  const { t } = useI18n();
  const [compacting, setCompacting] = useState(false);

  const ctx = (telemetry?.context?.available ? telemetry.context.data : null) as
    | ContextTelemetryData
    | null;
  const usage = (telemetry?.usage?.available ? telemetry.usage.data : null) as
    | UsageTelemetryData
    | null;
  const quota = (telemetry?.quota?.available ? telemetry.quota.data : null) as
    | QuotaTelemetryData
    | null;

  const used = ctx?.used ?? ctx?.usedTokens ?? null;
  const budget = ctx?.budget ?? ctx?.maxTokens ?? null;
  const occPct =
    ctx?.percent != null
      ? Number(ctx.percent)
      : used != null && budget && budget > 0
        ? (Number(used) / Number(budget)) * 100
        : 0;
  const clampedPct = Math.max(0, Math.min(100, occPct));
  const warnTok = Number(ctx?.warnThresholdTokens) || 240_000;
  const cliffTok = Number(ctx?.cliffThresholdTokens) || 328_000;
  const risk = ctx?.cacheDropDetected ? 'critical' : String(ctx?.cacheCliffRisk || ctx?.riskLevel || 'none');
  const ctxTone = risk === 'critical' ? 'danger' : risk === 'warn' ? 'warn' : 'ok';
  const riskLabel =
    risk === 'critical'
      ? t('telemetry.riskCritical')
      : risk === 'warn'
        ? t('telemetry.riskWarn')
        : t('telemetry.riskNone');

  const speedTps =
    typeof ctx?.speed === 'number'
      ? ctx.speed
      : ctx?.speed && typeof ctx.speed === 'object'
        ? ctx.speed.tps
        : ctx?.tokPerSec ?? null;

  const groups = normalizeGroups(ctx?.groups);
  const groupsTotal = groups.reduce((acc, g) => acc + g.tokens, 0) || 1;
  const alerts = Array.isArray(ctx?.alerts)
    ? ctx.alerts
        .map((a) =>
          typeof a === 'string'
            ? { level: 'warn', message: a }
            : a && typeof a === 'object' && a.message
              ? { level: String(a.level || 'warn'), message: String(a.message) }
              : null
        )
        .filter((x): x is { level: string; message: string } => Boolean(x))
    : [];

  const currencySym = usage?.currencySymbol || (usage?.currency === 'CNY' ? '¥' : '$');
  const periods = usage?.periods;
  const periodCards = [
    {
      key: 'today',
      label: t('telemetry.today'),
      tokens: periods?.today?.totalTokens ?? periods?.today?.tokens ?? usage?.todayTokens ?? null,
      cost:
        periods?.today?.totalDisplayCost ??
        periods?.today?.totalUsd ??
        usage?.todayCostUsd ??
        null
    },
    {
      key: 'month',
      label: t('telemetry.month'),
      tokens: periods?.month?.totalTokens ?? periods?.days30?.totalTokens ?? usage?.weekTokens ?? null,
      cost:
        periods?.month?.totalDisplayCost ??
        periods?.month?.totalUsd ??
        periods?.days30?.totalUsd ??
        usage?.weekCostUsd ??
        null
    },
    {
      key: 'year',
      label: t('telemetry.year'),
      tokens: periods?.year?.totalTokens ?? null,
      cost: periods?.year?.totalDisplayCost ?? periods?.year?.totalUsd ?? null
    },
    {
      key: 'allTime',
      label: t('telemetry.allTime'),
      tokens: periods?.allTime?.totalTokens ?? usage?.totalTokens ?? null,
      cost:
        periods?.allTime?.totalDisplayCost ??
        periods?.allTime?.totalUsd ??
        usage?.totalDisplayCost ??
        usage?.totalUsd ??
        null
    }
  ];
  const byModel = normalizeByModel(usage?.byModel);
  const byModelTotal = byModel.reduce((acc, m) => acc + m.totalTokens, 0) || 1;

  const pools: QuotaPoolDto[] = Array.isArray(quota?.pools) ? quota.pools : [];
  const geminiW = resolveLegacyQuota(quota?.gemini);
  const claudeW = resolveLegacyQuota(quota?.claude);

  const handleCompact = async () => {
    if (compacting || permissionLevel === 'L0' || !hasActiveSession) return;
    setCompacting(true);
    try {
      await onRunCompact();
    } finally {
      setCompacting(false);
    }
  };

  return (
    <BottomSheet
      open={open}
      title={t('telemetry.title')}
      subtitle={modelName || undefined}
      testId="telemetry-panel"
      onClose={onClose}
    >
      <div className={styles.content} data-testid="telemetry-sheet">
        <div className={styles.segmented} role="tablist">
          {(['context', 'usage', 'quota'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={`${styles.segBtn} ${activeTab === tab ? styles.segBtnActive : ''}`}
              data-testid={`telemetry-tab-${tab}`}
              onClick={() => onSelectTab(tab)}
            >
              {tab === 'context'
                ? t('telemetry.contextTab')
                : tab === 'usage'
                  ? t('telemetry.usageTab')
                  : t('telemetry.quotaTab')}
            </button>
          ))}
        </div>

        {activeTab === 'context' && (
          <div className={styles.card} data-testid="context-panel-card">
            <div className={styles.rowBetween}>
              <span className={styles.sectionTitle}>{t('telemetry.contextTab')}</span>
              <span className="ag-chip" data-tone={ctxTone}>
                {riskLabel}
              </span>
            </div>

            {!ctx ? (
              <div className="ag-empty">{t('telemetry.noData')}</div>
            ) : (
              <>
                <div className={styles.kpiHero}>
                  <span className={styles.kpiBig}>
                    {fmtTok(used)} <span className={styles.kpiSub}>/ {fmtTok(budget)}</span>
                  </span>
                  <span className={styles.kpiBig}>{Math.round(clampedPct)}%</span>
                </div>

                <div className={styles.track} aria-hidden="true">
                  <div
                    className={styles.fill}
                    data-tone={ctxTone}
                    style={{ width: `${clampedPct}%` }}
                  />
                  {budget && budget > 0 && (
                    <>
                      <span
                        className={styles.tick}
                        style={{ left: `${Math.min(98, (warnTok / budget) * 100)}%` }}
                      />
                      <span
                        className={`${styles.tick} ${styles.tickCliff}`}
                        style={{ left: `${Math.min(98, (cliffTok / budget) * 100)}%` }}
                      />
                    </>
                  )}
                </div>

                <div className={styles.grid3}>
                  <div className={styles.metricCell}>
                    <span className={styles.metricLabel}>{t('telemetry.input')}</span>
                    <span className={styles.metricVal}>
                      {fmtTok(ctx.inputTokens ?? ctx.sessionUsage?.inputTokens)}
                    </span>
                  </div>
                  <div className={styles.metricCell}>
                    <span className={styles.metricLabel}>{t('telemetry.cached')}</span>
                    <span className={styles.metricVal}>
                      {fmtTok(ctx.cachedTokens ?? ctx.sessionUsage?.cachedTokens)}
                    </span>
                  </div>
                  <div className={styles.metricCell}>
                    <span className={styles.metricLabel}>{t('telemetry.hitRate')}</span>
                    <span className={styles.metricVal} data-testid="telemetry-hit-rate">
                      {(() => {
                        const hitPct = normalizeCacheHitRatePct(ctx.cacheHitRate);
                        return hitPct !== null ? `${hitPct}%` : '--';
                      })()}
                    </span>
                  </div>
                  <div className={styles.metricCell}>
                    <span className={styles.metricLabel}>{t('telemetry.output')}</span>
                    <span className={styles.metricVal}>
                      {fmtTok(ctx.outputTokens ?? ctx.sessionUsage?.outputTokens)}
                    </span>
                  </div>
                  <div className={styles.metricCell}>
                    <span className={styles.metricLabel}>{t('telemetry.speed')}</span>
                    <span className={styles.metricVal}>
                      {speedTps != null && Number(speedTps) > 0
                        ? `${Math.round(Number(speedTps))} t/s`
                        : '--'}
                    </span>
                  </div>
                  <div className={styles.metricCell}>
                    <span className={styles.metricLabel}>{t('telemetry.cliff')}</span>
                    <span className={styles.metricVal}>{fmtTok(cliffTok)}</span>
                  </div>
                </div>

                {groups.length > 0 && (
                  <>
                    <span className={styles.sectionTitle}>{t('telemetry.groups')}</span>
                    <div className={styles.segBar} data-testid="context-groups-bar">
                      {groups.map((g, i) => (
                        <div
                          key={g.id}
                          style={{
                            width: `${Math.max(2, (g.tokens / groupsTotal) * 100)}%`,
                            background: GROUP_PALETTE[i % GROUP_PALETTE.length]
                          }}
                          title={`${g.label}: ${fmtTok(g.tokens)}`}
                        />
                      ))}
                    </div>
                    <div className={styles.legend}>
                      {groups.map((g, i) => (
                        <span key={g.id} className={styles.legendItem}>
                          <span
                            className={styles.dot}
                            style={{ background: GROUP_PALETTE[i % GROUP_PALETTE.length] }}
                          />
                          <span>
                            {g.label} {fmtTok(g.tokens)}
                          </span>
                        </span>
                      ))}
                    </div>
                  </>
                )}

                {alerts.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {alerts.map((al, idx) => (
                      <div
                        key={idx}
                        className={`${styles.alertBox} ${al.level === 'critical' ? styles.alertCritical : ''}`}
                      >
                        {al.message}
                      </div>
                    ))}
                  </div>
                )}

                <button
                  type="button"
                  className={`${styles.actionBtn} ${styles.actionPrimary}`}
                  disabled={compacting || permissionLevel === 'L0' || !hasActiveSession}
                  onClick={handleCompact}
                  data-testid="telemetry-compact-btn"
                >
                  {compacting ? t('telemetry.compacting') : t('telemetry.compact')}
                </button>
              </>
            )}
          </div>
        )}

        {activeTab === 'usage' && (
          <div className={styles.card} data-testid="usage-panel-card">
            <div className={styles.rowBetween}>
              <span className={styles.sectionTitle}>{t('telemetry.usageTab')}</span>
              {periods?.roi?.savedUsd != null && (
                <span className="ag-chip" data-tone="ok">
                  {t('telemetry.roiSaved')} {fmtCost(periods.roi.savedUsd, currencySym)}
                </span>
              )}
            </div>

            {!usage ? (
              <div className="ag-empty">{t('telemetry.noData')}</div>
            ) : (
              <>
                <div className={styles.grid2}>
                  {periodCards.map((p) => (
                    <div key={p.key} className={styles.metricCell} data-testid={`usage-period-${p.key}`}>
                      <span className={styles.metricLabel}>{p.label}</span>
                      <span className={styles.metricVal}>{fmtCost(p.cost, currencySym)}</span>
                      <span className={styles.metricLabel}>{fmtTok(p.tokens)} tok</span>
                    </div>
                  ))}
                </div>

                {byModel.length > 0 && (
                  <>
                    <span className={styles.sectionTitle}>{t('telemetry.byModel')}</span>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {byModel.slice(0, 6).map((m) => {
                        const pct = Math.max(
                          2,
                          Math.min(100, Math.round((m.totalTokens / byModelTotal) * 100))
                        );
                        return (
                          <div key={m.model} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <div className={styles.rowBetween}>
                              <span style={{ fontSize: 12, fontWeight: 550 }}>
                                {m.label || m.model}
                              </span>
                              <span className={styles.kpiSub}>
                                {fmtTok(m.totalTokens)}
                                {(m.costUsd ?? m.costUSD) != null
                                  ? ` · ${fmtCost(m.costUsd ?? m.costUSD, currencySym)}`
                                  : ''}
                              </span>
                            </div>
                            <div className={styles.track}>
                              <div className={styles.fill} style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {activeTab === 'quota' && (
          <div className={styles.card} data-testid="quota-panel-card">
            <div className={styles.rowBetween}>
              <span className={styles.sectionTitle}>{t('telemetry.pools')}</span>
              {(quota?.planTier || quota?.quotaMultiplier != null) && (
                <span className="ag-chip" data-tone="accent" data-testid="quota-plan-badge">
                  {[
                    quota.ultraSubTier ? `${quota.planTier || 'Ultra'} ${quota.ultraSubTier}` : quota.planTier,
                    quota.quotaMultiplier != null ? `${quota.quotaMultiplier}x` : null
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
            </div>

            {pools.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {pools.map((pool, idx) => {
                  const w5 = parseQuota(pool.fiveHourBucket);
                  const ww = parseQuota(pool.weeklyBucket);
                  const fallback = !pool.fiveHourBucket && !pool.weeklyBucket
                    ? parseQuota({
                        remainingFraction: pool.tightestFraction,
                        percentText: pool.tightestPercentText
                      })
                    : null;
                  return (
                    <div
                      key={pool.id || idx}
                      className={styles.metricCell}
                      style={{ gap: 8 }}
                      data-testid={`quota-pool-${pool.id || idx}`}
                    >
                      <strong style={{ fontSize: 13 }}>{pool.title}</strong>
                      {(pool.fiveHourBucket || fallback) && (
                        <div>
                          <div className={styles.rowBetween}>
                            <span className={styles.metricLabel}>{t('telemetry.fiveHour')}</span>
                            <span className={styles.metricLabel}>
                              {(w5.countdown || fallback?.countdown) &&
                                `${t('telemetry.resetIn', { time: w5.countdown || fallback?.countdown })} · `}
                              <strong>{(pool.fiveHourBucket ? w5 : fallback!).text}</strong>
                            </span>
                          </div>
                          <div className={styles.track}>
                            <div
                              className={styles.fill}
                              data-tone={toneForPct((pool.fiveHourBucket ? w5 : fallback!).pct)}
                              style={{ width: `${(pool.fiveHourBucket ? w5 : fallback!).pct ?? 0}%` }}
                            />
                          </div>
                        </div>
                      )}
                      {pool.weeklyBucket && (
                        <div>
                          <div className={styles.rowBetween}>
                            <span className={styles.metricLabel}>{t('telemetry.weekly')}</span>
                            <span className={styles.metricLabel}>
                              {ww.countdown && `${t('telemetry.resetIn', { time: ww.countdown })} · `}
                              <strong>{ww.text}</strong>
                            </span>
                          </div>
                          <div className={styles.track}>
                            <div
                              className={styles.fill}
                              data-tone={toneForPct(ww.pct)}
                              style={{ width: `${ww.pct ?? 0}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className={styles.grid2}>
                {[
                  { key: 'gemini', title: 'Gemini', w: geminiW },
                  { key: 'claude', title: 'Claude', w: claudeW }
                ].map((g) => (
                  <div key={g.key} className={styles.metricCell} style={{ gap: 8 }}>
                    <strong style={{ fontSize: 13 }}>{g.title}</strong>
                    <div data-testid={`quota-${g.key}-5h`}>
                      <div className={styles.rowBetween}>
                        <span className={styles.metricLabel}>5h</span>
                        <span className={styles.metricLabel}>
                          {g.w.fiveHour.countdown ? `${g.w.fiveHour.countdown} · ` : ''}
                          <strong>{g.w.fiveHour.text}</strong>
                        </span>
                      </div>
                      <div className={styles.track}>
                        <div
                          className={styles.fill}
                          data-tone={toneForPct(g.w.fiveHour.pct)}
                          style={{ width: `${g.w.fiveHour.pct ?? 0}%` }}
                        />
                      </div>
                    </div>
                    <div data-testid={`quota-${g.key}-weekly`}>
                      <div className={styles.rowBetween}>
                        <span className={styles.metricLabel}>Week</span>
                        <span className={styles.metricLabel}>
                          {g.w.weekly.countdown ? `${g.w.weekly.countdown} · ` : ''}
                          <strong>{g.w.weekly.text}</strong>
                        </span>
                      </div>
                      <div className={styles.track}>
                        <div
                          className={styles.fill}
                          data-tone={toneForPct(g.w.weekly.pct)}
                          style={{ width: `${g.w.weekly.pct ?? 0}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
