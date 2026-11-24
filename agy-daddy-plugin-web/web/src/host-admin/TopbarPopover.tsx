import { useI18n, type TranslateFn } from '../i18n';
import type { TopbarPanelSlot } from '../types';
import styles from './TopbarPopover.module.css';

export type TopbarPopoverKind = 'context' | 'usage' | 'quota';

export interface TopbarPopoverProps {
  kind: TopbarPopoverKind;
  slot?: TopbarPanelSlot;
  loading?: boolean;
  anchorLeft?: number;
  onRefresh?: () => void;
  onRunCompact?: () => void;
  onClose: () => void;
}

function asNumber(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function formatCompactTokens(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '--';
  const num = Math.max(0, val);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(num));
}

function formatCost(val: number | null | undefined, currencySymbol = '$'): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '--';
  const abs = Math.abs(val);
  const digits = abs > 0 && abs < 1 ? 3 : 2;
  return `${currencySymbol}${val.toFixed(digits)}`;
}

function getSemaphoreTone(fraction: number | null): 'ok' | 'warn' | 'danger' {
  if (fraction === null) return 'ok';
  if (fraction <= 0.15) return 'danger';
  if (fraction <= 0.35) return 'warn';
  return 'ok';
}

function formatResetDisplay(
  bucket: Record<string, unknown> | null,
  t: TranslateFn,
): string | null {
  if (!bucket) return null;
  const countdown =
    typeof bucket.countdownText === 'string' && bucket.countdownText
      ? bucket.countdownText
      : typeof bucket.resetIn === 'string' && bucket.resetIn
        ? bucket.resetIn
        : null;
  if (countdown) return t('popover.resetTime', { time: countdown });

  const resetIso =
    typeof bucket.resetTime === 'string' && bucket.resetTime
      ? bucket.resetTime
      : typeof bucket.resetTimeIso === 'string' && bucket.resetTimeIso
        ? bucket.resetTimeIso
        : null;
  if (resetIso) {
    const ms = Date.parse(resetIso);
    if (Number.isFinite(ms)) {
      const diffMs = ms - Date.now();
      if (diffMs <= 0) {
        return t('popover.resetTime', { time: '0m' });
      }
      const totalMin = Math.ceil(diffMs / 60_000);
      const days = Math.floor(totalMin / 1440);
      const hours = Math.floor((totalMin % 1440) / 60);
      const mins = totalMin % 60;
      const formatted =
        days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      return t('popover.resetTime', { time: formatted });
    }
    return t('popover.resetTime', { time: resetIso });
  }

  const resetText =
    typeof bucket.resetTimeText === 'string' && bucket.resetTimeText ? bucket.resetTimeText : null;
  return resetText ? t('popover.resetTime', { time: resetText }) : null;
}

const GROUP_COLORS = [
  'var(--accent)',
  'var(--status-info)',
  'var(--status-success)',
  'var(--status-warning)',
  'var(--text-muted)',
];

function ContextPopoverBody({
  data,
  available,
  onRunCompact,
  t,
}: {
  data: Record<string, unknown>;
  available: boolean;
  onRunCompact?: () => void;
  t: TranslateFn;
}) {
  const used = asNumber(data.used ?? data.usedTokens);
  const budget = asNumber(data.budget ?? data.limit);
  let percent = asNumber(data.percent ?? data.pct);
  if (percent === null && used !== null && budget !== null && budget > 0) {
    percent = Math.round((used / budget) * 100);
  }
  const hasExplicitNoSession = data.hasSession === false && used === null && percent === null;

  if ((!available && used === null && percent === null) || hasExplicitNoSession) {
    return (
      <div className={styles.emptyState} data-testid="popover-empty-context">
        {t('popover.noData')}
      </div>
    );
  }

  const warnTokens = asNumber(data.warnThresholdTokens) ?? 240_000;
  const cliffTokens = asNumber(data.cliffThresholdTokens) ?? 328_000;

  const sessionUsage = asRecord(data.sessionUsage);
  const inputTokens = asNumber(data.inputTokens ?? sessionUsage?.inputTokens);
  const cachedTokens = asNumber(data.cachedTokens ?? sessionUsage?.cachedTokens);
  const outputTokens = asNumber(data.outputTokens ?? sessionUsage?.outputTokens);
  let cacheHitRate = asNumber(data.cacheHitRate);
  if (cacheHitRate === null && inputTokens !== null && inputTokens > 0 && cachedTokens !== null) {
    cacheHitRate = Math.round((cachedTokens / inputTokens) * 100);
  }

  const speedObj = asRecord(data.speed);
  const speedTps = asNumber(speedObj?.tps ?? data.speed ?? data.tokPerSec);

  const clampedPct = Math.max(0, Math.min(100, percent ?? 0));
  const risk = String(data.cacheCliffRisk || '');
  const isDanger =
    risk === 'critical' ||
    data.cacheDropDetected === true ||
    clampedPct >= 90 ||
    (used !== null && used >= cliffTokens);
  const isWarn =
    !isDanger &&
    (risk === 'warn' || clampedPct >= 75 || (used !== null && used >= warnTokens));

  const warnPct =
    budget !== null && budget > 0 ? Math.min(98, Math.max(2, (warnTokens / budget) * 100)) : null;
  const cliffPct =
    budget !== null && budget > 0 ? Math.min(98, Math.max(2, (cliffTokens / budget) * 100)) : null;

  const rawGroups = asRecord(data.groups);
  const groupKeys = ['system', 'user', 'assistant', 'tool', 'tools', 'thinking', 'summaries'];
  const groups: Array<{ key: string; tokens: number }> = [];
  if (rawGroups) {
    const seen = new Set<string>();
    for (const k of groupKeys) {
      const normalizedKey = k === 'tools' ? 'tool' : k === 'summaries' ? 'thinking' : k;
      if (seen.has(normalizedKey)) continue;
      const rawVal = rawGroups[k];
      if (rawVal === undefined) continue;
      const rec = asRecord(rawVal);
      const tok = asNumber(rec ? rec.tokens ?? rec.high ?? rec.low : rawVal);
      if (tok !== null && tok > 0) {
        seen.add(normalizedKey);
        groups.push({ key: normalizedKey, tokens: tok });
      }
    }
    groups.sort((a, b) => b.tokens - a.tokens);
  }
  const groupsTotal = groups.reduce((acc, g) => acc + g.tokens, 0) || 1;

  const alertsRaw = Array.isArray(data.alerts) ? data.alerts : [];
  const alerts = alertsRaw
    .map((item) => {
      if (typeof item === 'string') return { level: 'warn', message: item };
      const rec = asRecord(item);
      if (!rec) return null;
      const msg = String(rec.message || rec.text || '').trim();
      if (!msg) return null;
      return { level: String(rec.level || 'warn'), message: msg };
    })
    .filter((item): item is { level: string; message: string } => item !== null);

  return (
    <>
      <div className={styles.section}>
        <div className={styles.heroRow}>
          <div className={styles.heroValue}>
            <span data-testid="context-used-value">{formatCompactTokens(used)}</span>
            <span className={styles.heroBudget}>
              / {formatCompactTokens(budget)} {t('popover.budgetTokens')}
            </span>
          </div>
          <span
            className={`${styles.heroPct} ${isDanger ? styles.toneDanger : isWarn ? styles.toneWarn : ''}`}
          >
            {percent !== null ? `${Math.round(percent)}%` : '--'}
          </span>
        </div>

        <div className={styles.progressTrack} data-testid="context-progress-track">
          <div
            className={`${styles.progressFill} ${isDanger ? styles.fillDanger : isWarn ? styles.fillWarn : ''}`}
            style={{ width: `${clampedPct}%` }}
          />
          {warnPct !== null && (
            <span
              className={styles.markerTick}
              style={{ left: `${warnPct.toFixed(1)}%` }}
              title={t('popover.warnMarker')}
              data-testid="context-warn-marker"
            />
          )}
          {cliffPct !== null && (
            <span
              className={`${styles.markerTick} ${styles.markerTickCliff}`}
              style={{ left: `${cliffPct.toFixed(1)}%` }}
              title={t('popover.cliffMarker')}
              data-testid="context-cliff-marker"
            />
          )}
        </div>

        <div className={styles.markerLegend}>
          <span className={styles.markerItem}>
            <span className={styles.markerDot} style={{ background: 'var(--status-warning)' }} />
            <span>{t('popover.warnMarker')}</span>
          </span>
          <span className={styles.markerItem}>
            <span className={styles.markerDot} style={{ background: 'var(--status-danger)' }} />
            <span>{t('popover.cliffMarker')}</span>
          </span>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.metricsGrid}>
          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>{t('popover.inputTokens')}</span>
            <span className={styles.metricValue}>{formatCompactTokens(inputTokens)}</span>
          </div>
          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>{t('popover.cachedTokens')}</span>
            <span className={styles.metricValue}>{formatCompactTokens(cachedTokens)}</span>
          </div>
          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>{t('popover.cacheHitRate')}</span>
            <span className={styles.metricValue}>
              {cacheHitRate !== null ? `${Math.round(cacheHitRate)}%` : '--'}
            </span>
          </div>
          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>{t('popover.outputTokens')}</span>
            <span className={styles.metricValue}>{formatCompactTokens(outputTokens)}</span>
          </div>
          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>{t('popover.speed')}</span>
            <span className={styles.metricValue}>
              {speedTps !== null && speedTps > 0 ? `${Math.round(speedTps)} t/s` : '--'}
            </span>
          </div>
          <div className={styles.metricCell}>
            <span className={styles.metricLabel}>{t('popover.usedTokens')}</span>
            <span className={styles.metricValue}>{formatCompactTokens(used)}</span>
          </div>
        </div>
      </div>

      {groups.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{t('popover.categories')}</span>
          </div>
          <div className={styles.segTrack}>
            {groups.map((g, idx) => (
              <div
                key={g.key}
                style={{
                  width: `${Math.max(2, (g.tokens / groupsTotal) * 100).toFixed(1)}%`,
                  background: GROUP_COLORS[idx % GROUP_COLORS.length],
                }}
                title={`${g.key}: ${formatCompactTokens(g.tokens)}`}
              />
            ))}
          </div>
          <div className={styles.segLegend}>
            {groups.map((g, idx) => (
              <span key={g.key} className={styles.segLegendItem}>
                <span
                  className={styles.segDot}
                  style={{ background: GROUP_COLORS[idx % GROUP_COLORS.length] }}
                />
                <span>
                  {g.key} {formatCompactTokens(g.tokens)}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}

      {alerts.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{t('popover.alerts')}</span>
          </div>
          <div className={styles.alertsList}>
            {alerts.map((al, idx) => (
              <div
                key={`${al.level}-${idx}`}
                className={`${styles.alertRow} ${al.level === 'danger' ? styles.alertDanger : styles.alertWarn}`}
              >
                <span>{al.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.compactRow}>
          <button
            type="button"
            className={styles.compactBtn}
            onClick={onRunCompact}
            disabled={!onRunCompact}
            data-testid="popover-run-compact-btn"
          >
            {t('popover.runCompact')}
          </button>
        </div>
      </div>
    </>
  );
}

function UsagePopoverBody({
  data,
  available,
  t,
}: {
  data: Record<string, unknown>;
  available: boolean;
  t: TranslateFn;
}) {
  const periods = asRecord(data.periods);
  const currencySymbol =
    typeof data.currencySymbol === 'string' && data.currencySymbol
      ? data.currencySymbol
      : data.currency === 'CNY'
        ? '¥'
        : '$';
  const exchangeRate = asNumber(data.exchangeRate) ?? 1;

  const resolveBucket = (
    periodKeys: string[],
    costKeys: string[],
    tokenKeys: string[],
    allowTopLevelFallback = false,
  ) => {
    let bucket: Record<string, unknown> | null = null;
    if (periods) {
      for (const pk of periodKeys) {
        const candidate = asRecord(periods[pk]);
        if (candidate) {
          bucket = candidate;
          break;
        }
      }
    }
    let cost = bucket
      ? asNumber(bucket.totalDisplayCost ?? bucket.totalUsd ?? bucket.costUSD ?? bucket.cost)
      : null;
    if (cost !== null && bucket && bucket.totalDisplayCost === undefined && exchangeRate !== 1) {
      cost = cost * exchangeRate;
    }
    if (cost === null) {
      for (const ck of costKeys) {
        const v = asNumber(data[ck]);
        if (v !== null) {
          cost = v;
          break;
        }
      }
    }

    let tokens = bucket ? asNumber(bucket.totalTokens ?? bucket.tokens) : null;
    if (tokens === null) {
      for (const tk of tokenKeys) {
        const v = asNumber(data[tk]);
        if (v !== null) {
          tokens = v;
          break;
        }
      }
    }
    if (allowTopLevelFallback) {
      if (cost === null) cost = asNumber(data.totalCost ?? data.totalUsd ?? data.costUsd ?? data.cost);
      if (tokens === null) tokens = asNumber(data.totalTokens ?? data.tokens);
    }
    return { cost, tokens };
  };

  const todayStats = resolveBucket(['today'], ['todayCost'], ['todayTokens']);
  const days7Stats = resolveBucket(
    ['days7', 'last7Days', 'week', 'sevenDays'],
    ['days7Cost', 'weekCost'],
    ['days7Tokens', 'weekTokens'],
  );
  const days30Stats = resolveBucket(
    ['days30', 'last30Days', 'month', 'thirtyDays'],
    ['days30Cost', 'monthCost'],
    ['days30Tokens', 'monthTokens'],
  );
  const totalStats = resolveBucket(
    ['allTime', 'total'],
    ['totalCost', 'totalUsd', 'costUsd', 'cost'],
    ['totalTokens', 'tokens'],
    true,
  );

  const hasAnyStats = [todayStats, days7Stats, days30Stats, totalStats].some(
    (s) => s.cost !== null || s.tokens !== null,
  );

  if (!available && !hasAnyStats) {
    return (
      <div className={styles.emptyState} data-testid="popover-empty-usage">
        {t('popover.noData')}
      </div>
    );
  }

  const periodCards = [
    { key: 'today', label: t('popover.today'), ...todayStats },
    { key: 'days7', label: t('popover.days7'), ...days7Stats },
    { key: 'days30', label: t('popover.days30'), ...days30Stats },
    { key: 'total', label: t('popover.total'), ...totalStats },
  ];

  const bucketForModels = asRecord(periods?.allTime) || data;
  const rawByModel = asRecord(bucketForModels.byModel ?? data.byModel);
  const modelRows: Array<{ name: string; tokens: number; cost: number | null }> = [];
  if (rawByModel) {
    for (const [name, val] of Object.entries(rawByModel)) {
      const rec = asRecord(val);
      const tok = asNumber(rec ? rec.tokens ?? rec.totalTokens : val) ?? 0;
      const c = rec ? asNumber(rec.costUSD ?? rec.cost ?? rec.totalUsd) : null;
      modelRows.push({ name, tokens: tok, cost: c });
    }
    modelRows.sort((a, b) => b.tokens - a.tokens);
  }
  const modelTotalTok =
    modelRows.reduce((acc, m) => acc + m.tokens, 0) || totalStats.tokens || 1;

  const rawDaily =
    data.dailyActivity ?? data.daily ?? data.recentDays ?? data.days ?? periods?.daily;
  const dailyRows: Array<{ date: string; value: number }> = [];
  if (Array.isArray(rawDaily)) {
    for (const entry of rawDaily) {
      const rec = asRecord(entry);
      if (!rec) continue;
      const date = String(rec.date || rec.day || '');
      const val = asNumber(rec.tokens ?? rec.totalTokens ?? rec.cost ?? rec.costUSD) ?? 0;
      dailyRows.push({ date, value: val });
    }
  } else {
    const dailyRec = asRecord(rawDaily);
    if (dailyRec) {
      for (const [date, entry] of Object.entries(dailyRec)) {
        const rec = asRecord(entry);
        const val = asNumber(rec ? rec.tokens ?? rec.totalTokens ?? rec.cost : entry) ?? 0;
        dailyRows.push({ date, value: val });
      }
      dailyRows.sort((a, b) => a.date.localeCompare(b.date));
    }
  }
  const recentDaily = dailyRows.slice(-14);
  const maxDailyVal = recentDaily.reduce((m, d) => Math.max(m, d.value), 0) || 1;

  return (
    <>
      <div className={styles.section}>
        <div className={styles.periodGrid}>
          {periodCards.map((card) => (
            <div key={card.key} className={styles.periodCard} data-testid={`usage-card-${card.key}`}>
              <span className={styles.periodLabel}>{card.label}</span>
              <span className={styles.periodCost}>
                {card.cost !== null ? formatCost(card.cost, currencySymbol) : '--'}
              </span>
              <span className={styles.periodTokens}>
                {formatCompactTokens(card.tokens)} {t('popover.tokens')}
              </span>
            </div>
          ))}
        </div>
      </div>

      {modelRows.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{t('popover.modelBreakdown')}</span>
          </div>
          <div className={styles.barList}>
            {modelRows.slice(0, 6).map((row) => {
              const pct = Math.max(0, Math.min(100, Math.round((row.tokens / modelTotalTok) * 100)));
              return (
                <div key={row.name} className={styles.barRow}>
                  <div className={styles.barMeta}>
                    <span className={styles.barName} title={row.name}>
                      {row.name}
                    </span>
                    <span className={styles.barStat}>
                      {formatCompactTokens(row.tokens)}
                      {row.cost !== null ? ` · ${formatCost(row.cost, currencySymbol)}` : ''}
                    </span>
                  </div>
                  <div className={styles.progressTrack}>
                    <div className={styles.progressFill} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {recentDaily.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{t('popover.dailyActivity')}</span>
          </div>
          <div className={styles.dailyBars} data-testid="usage-daily-bars">
            {recentDaily.map((d, idx) => {
              const heightPct = Math.max(8, Math.round((d.value / maxDailyVal) * 100));
              return (
                <div
                  key={`${d.date}-${idx}`}
                  className={styles.dailyBarCol}
                  title={`${d.date}: ${formatCompactTokens(d.value)}`}
                >
                  <div className={styles.dailyBarFill} style={{ height: `${heightPct}%` }} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

interface NormalizedPoolBar {
  id: string;
  label: string;
  remainingFraction: number | null;
  percentText: string;
  resetDisplay: string | null;
}

interface NormalizedPool {
  id: string;
  title: string;
  bars: NormalizedPoolBar[];
}

function QuotaPopoverBody({
  data,
  available,
  t,
}: {
  data: Record<string, unknown>;
  available: boolean;
  t: TranslateFn;
}) {
  const tierRaw =
    typeof data.planTier === 'string' && data.planTier
      ? data.planTier
      : typeof data.ultraSubTier === 'string' && data.ultraSubTier
        ? `Ultra ${data.ultraSubTier}`
        : typeof data.plan === 'string' && data.plan
          ? data.plan
          : typeof data.tier === 'string' && data.tier
            ? data.tier
            : null;
  const multiplier = asNumber(data.quotaMultiplier ?? data.multiplier);

  const normalizedPools: NormalizedPool[] = [];
  const rawPools = Array.isArray(data.pools) ? data.pools : null;

  const extractBucketBar = (
    id: string,
    label: string,
    bucket: Record<string, unknown>,
  ): NormalizedPoolBar => {
    let frac = asNumber(bucket.remainingFraction ?? bucket.fraction);
    if (frac === null) {
      const pct = asNumber(bucket.percent ?? bucket.pct);
      if (pct !== null) frac = Math.max(0, Math.min(1, pct / 100));
    }
    const percentText =
      typeof bucket.percentText === 'string' && bucket.percentText
        ? bucket.percentText
        : frac !== null
          ? `${Math.round(frac * 100)}%`
          : '--';
    return {
      id,
      label,
      remainingFraction: frac,
      percentText,
      resetDisplay: formatResetDisplay(bucket, t),
    };
  };

  if (rawPools && rawPools.length > 0) {
    rawPools.forEach((rawPool, idx) => {
      const p = asRecord(rawPool);
      if (!p) return;
      const title = String(p.title || p.name || p.label || p.id || `Pool ${idx + 1}`);
      const bars: NormalizedPoolBar[] = [];
      const fiveHour = asRecord(p.fiveHourBucket);
      const weekly = asRecord(p.weeklyBucket);
      if (fiveHour) bars.push(extractBucketBar(`${title}-5h`, '5h', fiveHour));
      if (weekly) bars.push(extractBucketBar(`${title}-weekly`, 'Weekly', weekly));
      if (bars.length === 0 && Array.isArray(p.buckets)) {
        p.buckets.forEach((rawB, bIdx) => {
          const b = asRecord(rawB);
          if (!b) return;
          const bLabel = String(b.windowShort || b.windowKey || b.label || `W${bIdx + 1}`);
          bars.push(extractBucketBar(`${title}-${bIdx}`, bLabel, b));
        });
      }
      if (bars.length === 0) {
        const frac = asNumber(p.tightestFraction ?? p.remainingFraction ?? p.fraction);
        bars.push(
          extractBucketBar(`${title}-main`, t('popover.remaining'), {
            ...p,
            remainingFraction: frac,
            percentText: p.tightestPercentText ?? p.percentText,
          }),
        );
      }
      normalizedPools.push({ id: String(p.id || p.key || idx), title, bars });
    });
  } else {
    const gemini = asRecord(data.gemini);
    const claude = asRecord(data.claude);
    if (gemini) {
      normalizedPools.push({
        id: 'gemini',
        title: 'Gemini',
        bars: [extractBucketBar('gemini', t('popover.remaining'), gemini)],
      });
    }
    if (claude) {
      normalizedPools.push({
        id: 'claude',
        title: 'Claude',
        bars: [extractBucketBar('claude', t('popover.remaining'), claude)],
      });
    }
    if (!gemini && !claude) {
      const fallbackPct = asNumber(data.percent ?? data.pct);
      const fallbackFrac = asNumber(data.remainingFraction ?? data.fraction);
      if (fallbackPct !== null || fallbackFrac !== null || typeof data.percentText === 'string') {
        normalizedPools.push({
          id: 'default',
          title: t('popover.pools'),
          bars: [extractBucketBar('default', t('popover.remaining'), data)],
        });
      }
    }
  }

  if (!available && normalizedPools.length === 0) {
    return (
      <div className={styles.emptyState} data-testid="popover-empty-quota">
        {t('popover.noData')}
      </div>
    );
  }

  return (
    <>
      {(tierRaw || multiplier !== null) && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{t('popover.planTier')}</span>
            <span className={styles.badge} data-testid="quota-plan-badge">
              {[tierRaw, multiplier !== null ? `${multiplier}x` : null].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>{t('popover.pools')}</span>
        </div>
        {normalizedPools.length === 0 ? (
          <div className={styles.emptyState}>{t('popover.noData')}</div>
        ) : (
          normalizedPools.map((pool) => (
            <div key={pool.id} className={styles.poolCard} data-testid={`quota-pool-${pool.id}`}>
              <div className={styles.poolHeader}>
                <span className={styles.poolTitle}>{pool.title}</span>
              </div>
              {pool.bars.map((bar) => {
                const tone = getSemaphoreTone(bar.remainingFraction);
                const fillPct =
                  bar.remainingFraction !== null
                    ? Math.max(0, Math.min(100, Math.round(bar.remainingFraction * 100)))
                    : 0;
                const fillToneClass =
                  tone === 'danger'
                    ? styles.fillDanger
                    : tone === 'warn'
                      ? styles.fillWarn
                      : styles.fillOk;
                const textToneClass =
                  tone === 'danger'
                    ? styles.toneDanger
                    : tone === 'warn'
                      ? styles.toneWarn
                      : styles.toneOk;
                return (
                  <div key={bar.id} className={styles.barRow}>
                    <div className={styles.barMeta}>
                      <span className={styles.barName}>
                        {bar.label}: <strong className={textToneClass}>{bar.percentText}</strong>
                      </span>
                      {bar.resetDisplay && <span className={styles.barStat}>{bar.resetDisplay}</span>}
                    </div>
                    <div className={styles.progressTrack}>
                      <div
                        className={`${styles.progressFill} ${fillToneClass}`}
                        data-tone={tone}
                        style={{ width: `${fillPct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </>
  );
}

export function TopbarPopover({
  kind,
  slot,
  loading = false,
  anchorLeft = 0,
  onRefresh,
  onRunCompact,
  onClose,
}: TopbarPopoverProps) {
  const { t } = useI18n();
  const safeSlot: TopbarPanelSlot = slot || { available: false };
  const data = asRecord(safeSlot.data) || {};

  const title =
    kind === 'context'
      ? t('popover.contextTitle')
      : kind === 'usage'
        ? t('popover.usageTitle')
        : t('popover.quotaTitle');

  const modelName = kind === 'context' && typeof data.model === 'string' ? data.model : null;

  return (
    <div
      className={styles.popover}
      style={{ left: `${Math.max(0, anchorLeft)}px` }}
      role="dialog"
      aria-label={title}
      data-testid={`topbar-popover-${kind}`}
    >
      <div className={styles.header}>
        <div className={styles.headerTitleGroup}>
          <h3 className={styles.title}>{title}</h3>
          {modelName && (
            <span className={styles.badge} title={modelName}>
              {modelName}
            </span>
          )}
        </div>
        <div className={styles.headerActions}>
          {onRefresh && (
            <button
              type="button"
              className={styles.iconBtn}
              onClick={onRefresh}
              disabled={loading}
              data-testid={`popover-refresh-${kind}`}
            >
              {t('popover.refresh')}
            </button>
          )}
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label={t('common.close')}
            data-testid={`popover-close-${kind}`}
          >
            ×
          </button>
        </div>
      </div>

      <div className={styles.body}>
        {kind === 'context' && (
          <ContextPopoverBody
            data={data}
            available={safeSlot.available}
            onRunCompact={onRunCompact}
            t={t}
          />
        )}
        {kind === 'usage' && (
          <UsagePopoverBody data={data} available={safeSlot.available} t={t} />
        )}
        {kind === 'quota' && (
          <QuotaPopoverBody data={data} available={safeSlot.available} t={t} />
        )}
      </div>
    </div>
  );
}
