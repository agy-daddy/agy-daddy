import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { TopbarPopover } from '../host-admin/TopbarPopover';
import type { TopbarPanelSlot } from '../types';
import styles from './ComposerContextBar.module.css';

export interface ComposerContextBarProps {
  slot?: TopbarPanelSlot | null;
  showSpeed?: boolean;
  isRunning?: boolean;
  hasDraft?: boolean;
  loading?: boolean;
  onRefresh?: () => void;
  onRunCompact?: () => void;
}

function asNum(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function fmtCompact(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(Math.round(num));
}

export function ComposerContextBar({
  slot,
  showSpeed = true,
  isRunning = false,
  hasDraft = false,
  loading = false,
  onRefresh,
  onRunCompact,
}: ComposerContextBarProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!slot?.available) {
      setOpen(false);
    }
  }, [slot?.available]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setOpen(false);
      }
    };
    const onPointerDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  if (!slot?.available) return null;

  const data = (slot.data && typeof slot.data === 'object' ? slot.data : {}) as Record<string, unknown>;
  const used = asNum(data.used ?? data.usedTokens);
  const budget = asNum(data.budget ?? data.maxTokens);
  let pct = asNum(data.percent ?? data.pct);
  if (pct === null && used !== null && budget !== null && budget > 0) {
    pct = (used / budget) * 100;
  }
  const cacheHit = asNum(data.cacheHitRate);
  const speedObj = data.speed && typeof data.speed === 'object' ? (data.speed as Record<string, unknown>) : null;
  const speed = asNum(speedObj?.tps ?? data.speed ?? data.tokPerSec);
  const cliffRisk = typeof data.cacheCliffRisk === 'string' ? data.cacheCliffRisk : '';
  const policy = slot.settings?.compactPolicy || (typeof data.compactPolicy === 'string' ? data.compactPolicy : 'remind');

  const isDanger = cliffRisk === 'cliff' || cliffRisk === 'danger' || (pct !== null && pct >= 90);
  const isWarn = !isDanger && (cliffRisk === 'warn' || (pct !== null && pct >= 75));

  const ringPct = Math.max(0, Math.min(100, pct ?? 0));
  const cacheRingPct = Math.max(0, Math.min(100, cacheHit ?? 0));
  const outerR = 7;
  const innerR = 4.2;
  const outerC = 2 * Math.PI * outerR;
  const innerC = 2 * Math.PI * innerR;

  const showQuickCompact =
    Boolean(onRunCompact) &&
    (isWarn || isDanger) &&
    !isRunning &&
    !hasDraft &&
    (policy === 'idle_prompt' || policy === 'idle_and_cliff' || isDanger);

  return (
    <div ref={rootRef} className={styles.wrap} data-testid="composer-context-bar">
      {open && (
        <TopbarPopover
          kind="context"
          slot={slot}
          loading={loading}
          anchorLeft={0}
          placement="top"
          onRefresh={onRefresh}
          onRunCompact={
            onRunCompact
              ? () => {
                  onRunCompact();
                  setOpen(false);
                }
              : undefined
          }
          onClose={() => setOpen(false)}
        />
      )}

      <button
        type="button"
        className={[
          styles.pill,
          isDanger ? styles.pillDanger : isWarn ? styles.pillWarn : '',
          open ? styles.pillActive : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="composer-context-trigger"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" className={styles.ringSvg} aria-hidden="true">
          <circle cx="9" cy="9" r={outerR} className={styles.ringTrack} strokeWidth="2" fill="none" />
          <circle
            cx="9"
            cy="9"
            r={outerR}
            className={styles.ringFill}
            strokeWidth="2"
            fill="none"
            strokeDasharray={outerC}
            strokeDashoffset={outerC * (1 - ringPct / 100)}
            transform="rotate(-90 9 9)"
          />
          {cacheHit !== null && (
            <>
              <circle cx="9" cy="9" r={innerR} className={styles.ringTrack} strokeWidth="1.6" fill="none" />
              <circle
                cx="9"
                cy="9"
                r={innerR}
                className={styles.ringCache}
                strokeWidth="1.6"
                fill="none"
                strokeDasharray={innerC}
                strokeDashoffset={innerC * (1 - cacheRingPct / 100)}
                transform="rotate(-90 9 9)"
              />
            </>
          )}
        </svg>

        <span className={styles.label}>{t('contextBar.label')}</span>
        <span className={styles.metric}>
          {used !== null && budget !== null
            ? `${fmtCompact(used)} / ${fmtCompact(budget)}`
            : used !== null
              ? `${fmtCompact(used)} tok`
              : t('topbar.ready')}
          {pct !== null ? ` (${Math.round(pct)}%)` : ''}
        </span>

        {cacheHit !== null && (
          <span className={styles.subMetric}>
            {t('contextBar.cacheHit')} {Math.round(cacheHit)}%
          </span>
        )}

        {showSpeed && speed !== null && speed > 0 && (
          <span className={styles.subMetric} data-testid="composer-context-speed">
            {t('contextBar.speed', { rate: Math.round(speed) })}
          </span>
        )}

        {isDanger && <span className={styles.riskTag}>{t('contextBar.cliffLabel')}</span>}
        {!isDanger && isWarn && <span className={styles.riskTag}>{t('contextBar.warnLabel')}</span>}
      </button>

      {showQuickCompact && (
        <button
          type="button"
          className={styles.compactBtn}
          onClick={() => onRunCompact?.()}
          data-testid="composer-context-compact-btn"
        >
          {t('contextBar.compactBtn')}
        </button>
      )}
    </div>
  );
}
