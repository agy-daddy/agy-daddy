import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeLocale, useI18n, type TranslateFn } from '../i18n';
import { useTheme } from '../theme/ThemeProvider';
import type { RemoteStatusResponse, TopbarPanelSlot, TopbarPanels } from '../types';
import { MobileQrPopover } from './MobileQrPopover';
import { TopbarPopover, type TopbarPopoverKind } from './TopbarPopover';
import styles from './TopbarCapsules.module.css';

export type ConnectionStatus = 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'error';

export type HostAdminTab = 'plugins' | 'appearance' | 'commands' | 'doctor';

export interface TopbarCapsulesProps {
  panels?: TopbarPanels | null;
  loading?: boolean;
  connectionStatus?: ConnectionStatus;
  rpcConnected?: boolean;
  hubOrigin?: string | null;
  remoteStatus?: RemoteStatusResponse | null;
  remoteLoading?: boolean;
  onRefreshTopbar?: () => void;
  onRefreshRemote?: () => void;
  onRunCompact?: () => void;
  onOpenHostAdmin?: (initialTab?: HostAdminTab) => void;
  onOpenPlugins?: () => void;
  onOpenCommandPalette?: () => void;
  onOpenDoctor?: () => void;
  onCapsuleClick?: (panelKey: 'context' | 'usage' | 'quota', slot: TopbarPanelSlot) => void;
  className?: string;
}

type CapsuleTone = 'muted' | 'accent' | 'warning' | 'danger' | 'neutral';
type ActivePopoverKey = TopbarPopoverKind | 'mobile-qr' | null;

interface FormattedCapsule {
  key: 'context' | 'usage' | 'quota';
  label: string;
  valueText: string;
  available: boolean;
  tone: CapsuleTone;
  title: string;
  slot: TopbarPanelSlot;
}

function asFiniteNumber(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function formatCompactNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(Math.round(num));
}

function formatContextCapsule(slot: TopbarPanelSlot | undefined, t: TranslateFn): FormattedCapsule {
  const safeSlot: TopbarPanelSlot = slot || { available: false };
  if (!safeSlot.available) {
    return {
      key: 'context',
      label: 'Context',
      valueText: 'N/A',
      available: false,
      tone: 'muted',
      title: t('topbar.unavailable', { panel: 'Context' }),
      slot: safeSlot,
    };
  }

  const data = (safeSlot.data && typeof safeSlot.data === 'object' ? safeSlot.data : {}) as Record<string, unknown>;
  const used = asFiniteNumber(data.used ?? data.usedTokens);
  const budget = asFiniteNumber(data.budget);
  let percent = asFiniteNumber(data.percent ?? data.pct);
  if (percent === null && used !== null && budget !== null && budget > 0) {
    percent = (used / budget) * 100;
  }
  const speedObj = data.speed && typeof data.speed === 'object' ? (data.speed as Record<string, unknown>) : null;
  const speed = asFiniteNumber(speedObj?.tps ?? data.speed ?? data.tokPerSec);

  let valueText = t('topbar.ready');
  if (used !== null && percent !== null) {
    valueText = `${formatCompactNumber(used)} · ${Math.round(percent)}%`;
  } else if (percent !== null) {
    valueText = `${Math.round(percent)}%`;
  } else if (used !== null) {
    valueText = `${formatCompactNumber(used)} tok`;
  }
  if (speed !== null && speed > 0) {
    valueText += ` · ${Math.round(speed)}t/s`;
  }

  let tone: CapsuleTone = 'accent';
  if (percent !== null && percent >= 90) tone = 'danger';
  else if (percent !== null && percent >= 75) tone = 'warning';

  const modelStr =
    typeof data.model === 'string' && data.model
      ? ` · ${t('topbar.modelPrefix', { model: data.model })}`
      : '';
  return {
    key: 'context',
    label: 'Context',
    valueText,
    available: true,
    tone,
    title: `Context (${t('topbar.sourcePrefix', { source: safeSlot.source || 'host' })})${modelStr}`,
    slot: safeSlot,
  };
}

function formatUsageCapsule(slot: TopbarPanelSlot | undefined, t: TranslateFn): FormattedCapsule {
  const safeSlot: TopbarPanelSlot = slot || { available: false };
  if (!safeSlot.available) {
    return {
      key: 'usage',
      label: 'Usage',
      valueText: 'N/A',
      available: false,
      tone: 'muted',
      title: t('topbar.unavailable', { panel: 'Usage' }),
      slot: safeSlot,
    };
  }

  const data = (safeSlot.data && typeof safeSlot.data === 'object' ? safeSlot.data : {}) as Record<string, unknown>;
  const periods = data.periods && typeof data.periods === 'object' ? (data.periods as Record<string, unknown>) : null;
  const todayBucket = periods?.today && typeof periods.today === 'object' ? (periods.today as Record<string, unknown>) : null;
  const cost = asFiniteNumber(
    data.todayCost ?? todayBucket?.totalDisplayCost ?? todayBucket?.totalUsd ?? data.totalCost ?? data.totalUsd ?? data.costUsd ?? data.cost,
  );
  const tokens = asFiniteNumber(data.totalTokens ?? data.tokens);
  const calls = asFiniteNumber(data.callCount ?? data.calls ?? data.callsCount);
  const currencySymbol =
    typeof data.currencySymbol === 'string' && data.currencySymbol
      ? data.currencySymbol
      : data.currency === 'CNY'
        ? '¥'
        : '$';

  let valueText = t('topbar.ready');
  if (cost !== null) {
    valueText = `${currencySymbol}${cost.toFixed(cost > 0 && cost < 1 ? 3 : 2)}`;
  } else if (tokens !== null) {
    valueText = `${formatCompactNumber(tokens)} tok`;
  } else if (calls !== null) {
    valueText = t('topbar.calls', { count: calls });
  }

  return {
    key: 'usage',
    label: 'Usage',
    valueText,
    available: true,
    tone: 'neutral',
    title: `Usage (${t('topbar.sourcePrefix', { source: safeSlot.source || 'host' })})`,
    slot: safeSlot,
  };
}

function formatQuotaCapsule(slot: TopbarPanelSlot | undefined, t: TranslateFn): FormattedCapsule {
  const safeSlot: TopbarPanelSlot = slot || { available: false };
  if (!safeSlot.available) {
    return {
      key: 'quota',
      label: 'Quota',
      valueText: 'N/A',
      available: false,
      tone: 'muted',
      title: t('topbar.unavailable', { panel: 'Quota' }),
      slot: safeSlot,
    };
  }

  const data = (safeSlot.data && typeof safeSlot.data === 'object' ? safeSlot.data : {}) as Record<string, unknown>;
  const gemini = data.gemini && typeof data.gemini === 'object' ? (data.gemini as Record<string, unknown>) : null;
  const claude = data.claude && typeof data.claude === 'object' ? (data.claude as Record<string, unknown>) : null;

  let valueText = t('topbar.ready');
  let minFraction: number | null = null;

  if (gemini || claude) {
    const gf = asFiniteNumber(gemini?.remainingFraction ?? gemini?.fraction);
    const cf = asFiniteNumber(claude?.remainingFraction ?? claude?.fraction);
    const gText =
      typeof gemini?.percentText === 'string' && gemini.percentText
        ? gemini.percentText
        : gf !== null
          ? `${Math.round(gf * 100)}%`
          : null;
    const cText =
      typeof claude?.percentText === 'string' && claude.percentText
        ? claude.percentText
        : cf !== null
          ? `${Math.round(cf * 100)}%`
          : null;
    const parts: string[] = [];
    if (gText) parts.push(`G ${gText}`);
    if (cText) parts.push(`C ${cText}`);
    if (parts.length > 0) valueText = parts.join(' · ');

    const fracs = [gf, cf].filter((v): v is number => v !== null);
    if (fracs.length > 0) minFraction = Math.min(...fracs);
  } else if (typeof data.percentText === 'string' && data.percentText) {
    valueText = data.percentText;
  } else {
    const pct = asFiniteNumber(data.percent ?? data.pct);
    if (pct !== null) {
      valueText = `${Math.round(pct)}%`;
      minFraction = pct / 100;
    }
  }

  let tone: CapsuleTone = 'neutral';
  if (minFraction !== null) {
    if (minFraction <= 0.1) tone = 'danger';
    else if (minFraction <= 0.25) tone = 'warning';
  }

  return {
    key: 'quota',
    label: 'Quota',
    valueText,
    available: true,
    tone,
    title: `Quota (${t('topbar.sourcePrefix', { source: safeSlot.source || 'host' })})`,
    slot: safeSlot,
  };
}

function getToneClass(tone: CapsuleTone): string {
  switch (tone) {
    case 'muted':
      return styles.capsuleMuted;
    case 'accent':
      return styles.capsuleAccent;
    case 'warning':
      return styles.capsuleWarning;
    case 'danger':
      return styles.capsuleDanger;
    default:
      return '';
  }
}

function getConnectionMeta(status: ConnectionStatus, t: TranslateFn): { label: string; dotClass: string } {
  switch (status) {
    case 'connected':
      return { label: t('topbar.sse.connected'), dotClass: styles.dotConnected };
    case 'connecting':
      return { label: t('topbar.sse.connecting'), dotClass: styles.dotConnecting };
    case 'reconnecting':
      return { label: t('topbar.sse.reconnecting'), dotClass: styles.dotConnecting };
    case 'error':
      return { label: t('topbar.sse.error'), dotClass: styles.dotDisconnected };
    default:
      return { label: t('topbar.sse.disconnected'), dotClass: styles.dotDisconnected };
  }
}

function MobileQrIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="1.5" width="7.5" height="13" rx="1.6" stroke="currentColor" strokeWidth="1.35" />
      <circle cx="5.75" cy="12" r="0.75" fill="currentColor" />
      <rect x="10.5" y="2.5" width="3.5" height="3.5" rx="0.5" stroke="currentColor" strokeWidth="1.2" />
      <rect x="10.5" y="8" width="1.6" height="1.6" fill="currentColor" />
      <rect x="12.6" y="8" width="1.6" height="1.6" fill="currentColor" />
      <rect x="10.5" y="10.2" width="3.7" height="1.6" fill="currentColor" />
      <rect x="12.4" y="12.2" width="1.8" height="1.8" fill="currentColor" />
    </svg>
  );
}

export function TopbarCapsules({
  panels,
  loading = false,
  connectionStatus = 'connected',
  rpcConnected = true,
  hubOrigin,
  remoteStatus,
  remoteLoading = false,
  onRefreshTopbar,
  onRefreshRemote,
  onRunCompact,
  onOpenHostAdmin,
  onOpenPlugins,
  onOpenCommandPalette,
  onOpenDoctor,
  onCapsuleClick,
  className,
}: TopbarCapsulesProps) {
  const { locale, supportedLanguages, setLocale, t } = useI18n();
  const { preference, resolvedTheme, cycleTheme } = useTheme();

  const [activePopover, setActivePopover] = useState<ActivePopoverKey>(null);
  const [anchorLeft, setAnchorLeft] = useState<number>(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverLayerRef = useRef<HTMLDivElement | null>(null);
  const mobileQrAnchorRef = useRef<HTMLDivElement | null>(null);
  const capsuleRefs = useRef<Partial<Record<'context' | 'usage' | 'quota', HTMLButtonElement | null>>>({});

  const closePopover = useCallback(() => {
    setActivePopover(null);
  }, []);

  useEffect(() => {
    if (!activePopover) return;

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setActivePopover(null);
      }
    };

    const onPointerDown = (ev: MouseEvent) => {
      const target = ev.target as Node | null;
      if (!target) return;

      if (activePopover === 'mobile-qr') {
        if (mobileQrAnchorRef.current?.contains(target)) return;
      } else {
        const triggerBtn = capsuleRefs.current[activePopover];
        if (triggerBtn?.contains(target)) return;
        if (popoverLayerRef.current?.contains(target)) return;
      }

      setActivePopover(null);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [activePopover]);

  const handleCapsuleToggle = (cap: FormattedCapsule) => {
    onCapsuleClick?.(cap.key, cap.slot);

    if (activePopover === cap.key) {
      setActivePopover(null);
      return;
    }

    const rootEl = rootRef.current;
    const btnEl = capsuleRefs.current[cap.key];
    if (rootEl && btnEl) {
      const rootRect = rootEl.getBoundingClientRect();
      const btnRect = btnEl.getBoundingClientRect();
      const rawLeft = btnRect.left - rootRect.left;
      const maxLeft = Math.max(0, rootRect.width - 360);
      setAnchorLeft(Math.max(0, Math.min(rawLeft, maxLeft)));
    } else {
      setAnchorLeft(0);
    }

    setActivePopover(cap.key);
  };

  const capsules: FormattedCapsule[] = [
    formatContextCapsule(panels?.context, t),
    formatUsageCapsule(panels?.usage, t),
    formatQuotaCapsule(panels?.quota, t),
  ];

  const conn = getConnectionMeta(connectionStatus, t);
  const themeLabel =
    preference === 'system'
      ? `${t('theme.system')} (${resolvedTheme === 'light' ? '☀' : '☾'})`
      : preference === 'light'
        ? `☀ ${t('theme.light')}`
        : `☾ ${t('theme.dark')}`;

  const openTab = (tab: HostAdminTab, dedicated?: () => void) => {
    setActivePopover(null);
    if (dedicated) {
      dedicated();
      return;
    }
    onOpenHostAdmin?.(tab);
  };

  const activeCapsuleSlot =
    activePopover === 'context'
      ? panels?.context
      : activePopover === 'usage'
        ? panels?.usage
        : activePopover === 'quota'
          ? panels?.quota
          : undefined;

  return (
    <div ref={rootRef} className={`${styles.root} ${className || ''}`.trim()}>
      <div className={styles.capsules} aria-label={t('topbar.capsulesAria')}>
        {capsules.map((cap) => {
          const toneClass = getToneClass(cap.tone);
          const isActive = activePopover === cap.key;
          return (
            <button
              key={cap.key}
              ref={(el) => {
                capsuleRefs.current[cap.key] = el;
              }}
              type="button"
              data-capsule={cap.key}
              data-available={cap.available ? 'true' : 'false'}
              aria-haspopup="dialog"
              aria-expanded={isActive}
              title={cap.title}
              className={`${styles.capsule} ${toneClass} ${styles.capsuleInteractive} ${isActive ? styles.capsuleActive : ''}`.trim()}
              onClick={() => handleCapsuleToggle(cap)}
            >
              <span className={styles.capsuleLabel}>{cap.label}</span>
              <span className={styles.capsuleValue}>{loading && !panels ? '...' : cap.valueText}</span>
            </button>
          );
        })}
        {onRefreshTopbar && (
          <button
            type="button"
            className={styles.triggerBtn}
            title={t('topbar.refresh')}
            aria-label={t('topbar.refresh')}
            disabled={loading}
            onClick={onRefreshTopbar}
          >
            ↻
          </button>
        )}
      </div>

      {activePopover && activePopover !== 'mobile-qr' && (
        <div ref={popoverLayerRef}>
          <TopbarPopover
            kind={activePopover}
            slot={activeCapsuleSlot}
            loading={loading}
            anchorLeft={anchorLeft}
            onRefresh={onRefreshTopbar}
            onRunCompact={
              onRunCompact
                ? () => {
                    onRunCompact();
                    closePopover();
                  }
                : undefined
            }
            onClose={closePopover}
          />
        </div>
      )}

      <div className={styles.rightGroup}>
        <div
          className={styles.statusPill}
          data-connection={connectionStatus}
          title={hubOrigin ? `Hub: ${hubOrigin}` : undefined}
        >
          <span className={`${styles.statusDot} ${conn.dotClass}`} aria-hidden="true" />
          <span>{conn.label}</span>
          {!rpcConnected && <span className={styles.rpcWarn}>· {t('topbar.rpc.disconnected')}</span>}
        </div>

        <div ref={mobileQrAnchorRef} className={styles.mobileQrAnchor}>
          <button
            type="button"
            className={`${styles.triggerBtn} ${activePopover === 'mobile-qr' ? styles.triggerBtnActive : ''}`.trim()}
            onClick={() => setActivePopover((prev) => (prev === 'mobile-qr' ? null : 'mobile-qr'))}
            title={t('topbar.mobileQrTitle')}
            aria-haspopup="dialog"
            aria-expanded={activePopover === 'mobile-qr'}
            data-testid="topbar-mobile-qr-btn"
          >
            <MobileQrIcon />
            <span>{t('topbar.mobileQr')}</span>
          </button>

          {activePopover === 'mobile-qr' && (
            <MobileQrPopover
              remoteStatus={remoteStatus}
              remoteLoading={remoteLoading}
              onRefreshRemote={onRefreshRemote}
              onClose={closePopover}
            />
          )}
        </div>

        <button
          type="button"
          className={styles.triggerBtn}
          onClick={cycleTheme}
          title={t('theme.toggleTitle', { current: themeLabel })}
          aria-label={t('theme.toggleTitle', { current: themeLabel })}
          data-testid="theme-toggle-btn"
          data-theme-pref={preference}
        >
          <span>{themeLabel}</span>
        </button>

        <select
          className={styles.triggerBtn}
          value={locale}
          onChange={(ev) => {
            setLocale(normalizeLocale(ev.target.value) || 'en');
          }}
          title={t('lang.syncedWithHost')}
          aria-label={t('lang.selectAria')}
          data-testid="topbar-locale-select"
          data-locale={locale}
        >
          {supportedLanguages.map((lang) => (
            <option key={lang.bcp47} value={lang.bcp47}>
              {lang.nativeName || lang.shortLabel || lang.bcp47}
            </option>
          ))}
        </select>

        <button
          type="button"
          className={`${styles.triggerBtn} ${styles.triggerBtnAccent}`}
          onClick={() => openTab('plugins', onOpenPlugins)}
        >
          <span>{t('topbar.plugins')}</span>
        </button>

        <button
          type="button"
          className={styles.triggerBtn}
          onClick={() => openTab('appearance')}
          data-testid="topbar-appearance-btn"
        >
          <span>{t('topbar.appearance')}</span>
        </button>

        <button
          type="button"
          className={styles.triggerBtn}
          onClick={() => openTab('commands', onOpenCommandPalette)}
        >
          <span>{t('topbar.commands')}</span>
          <kbd className={styles.kbd}>⌘K</kbd>
        </button>

        <button
          type="button"
          className={styles.triggerBtn}
          onClick={() => openTab('doctor', onOpenDoctor)}
        >
          <span>{t('topbar.doctor')}</span>
        </button>
      </div>
    </div>
  );
}
