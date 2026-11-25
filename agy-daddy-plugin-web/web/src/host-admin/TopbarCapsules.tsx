import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n, type TranslateFn } from '../i18n';
import type {
  AccessChannel,
  BackgroundTasksListResponse,
  ContextDisplayLocation,
  RemoteStatusResponse,
  StopBackgroundTaskResponse,
  TopbarPanelSlot,
  TopbarPanels,
  WebAccessStatusResponse,
} from '../types';
import { BackgroundTasksPopover } from './BackgroundTasksPopover';
import { ChannelSwitcherPopover, type ChannelProbeEntry } from './ChannelSwitcherPopover';
import { CustomMenuPopover } from './CustomMenuPopover';
import { MobileQrPopover } from './MobileQrPopover';
import { TopbarPopover, type TopbarPopoverKind } from './TopbarPopover';
import { CHANNEL_SHORT_LABEL_KEY } from './webAccessHelpers';
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
  webAccessStatus?: WebAccessStatusResponse | null;
  activeSessionId?: string | null;
  sessionTitle?: string | null;
  sessionRunning?: boolean;
  workspaceName?: string | null;
  branchName?: string | null;
  diffCount?: number;
  contextDisplayLocation?: ContextDisplayLocation;
  tasksData?: BackgroundTasksListResponse | null;
  tasksLoading?: boolean;
  onRefreshTasks?: () => void;
  onStopTask?: (taskId: string) => Promise<StopBackgroundTaskResponse | void>;
  onSelectTaskSession?: (sessionId: string) => void;
  onRefreshSession?: () => void;
  onOpenDiffReview?: () => void;
  onPluginsChanged?: () => void;
  onRefreshTopbar?: () => void;
  onRefreshRemote?: () => void;
  onRefreshWebAccess?: () => void;
  onNavigateChannelUrl?: (url: string) => void;
  onRunCompact?: () => void;
  onOpenHostAdmin?: (initialTab?: HostAdminTab, selectedPluginId?: string) => void;
  onOpenPlugins?: () => void;
  onOpenCommandPalette?: () => void;
  onOpenDoctor?: () => void;
  onCapsuleClick?: (panelKey: 'context' | 'usage' | 'quota', slot: TopbarPanelSlot) => void;
  className?: string;
}

type CapsuleTone = 'muted' | 'accent' | 'warning' | 'danger' | 'neutral';
type ActivePopoverKey =
  | TopbarPopoverKind
  | 'mobile-qr'
  | 'channel-switcher'
  | 'tasks'
  | 'custom-menu'
  | null;

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

function MenuHamburgerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 4.25h11M2.5 8h11M2.5 11.75h11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TasksPulseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.35" />
      <path d="M5 7l2 2 4-3.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
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
  webAccessStatus,
  activeSessionId,
  sessionTitle,
  sessionRunning = false,
  workspaceName,
  branchName,
  diffCount = 0,
  contextDisplayLocation,
  tasksData,
  tasksLoading = false,
  onRefreshTasks,
  onStopTask,
  onSelectTaskSession,
  onRefreshSession,
  onOpenDiffReview,
  onPluginsChanged,
  onRefreshTopbar,
  onRefreshRemote,
  onRefreshWebAccess,
  onNavigateChannelUrl,
  onRunCompact,
  onOpenHostAdmin,
  onOpenPlugins,
  onOpenCommandPalette,
  onOpenDoctor,
  onCapsuleClick,
  className,
}: TopbarCapsulesProps) {
  const { t } = useI18n();

  const [activePopover, setActivePopover] = useState<ActivePopoverKey>(null);
  const [anchorLeft, setAnchorLeft] = useState<number>(0);
  const [channelProbeCache, setChannelProbeCache] = useState<Record<string, ChannelProbeEntry>>({});

  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverLayerRef = useRef<HTMLDivElement | null>(null);
  const mobileQrAnchorRef = useRef<HTMLDivElement | null>(null);
  const channelSwitcherAnchorRef = useRef<HTMLDivElement | null>(null);
  const tasksAnchorRef = useRef<HTMLDivElement | null>(null);
  const customMenuAnchorRef = useRef<HTMLDivElement | null>(null);
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
      } else if (activePopover === 'channel-switcher') {
        if (channelSwitcherAnchorRef.current?.contains(target)) return;
      } else if (activePopover === 'tasks') {
        if (tasksAnchorRef.current?.contains(target)) return;
      } else if (activePopover === 'custom-menu') {
        if (customMenuAnchorRef.current?.contains(target)) return;
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

  const panelLocation: ContextDisplayLocation =
    panels?.context?.settings?.displayLocation === 'composer' ? 'composer' : 'topbar';
  const effectiveContextLocation: ContextDisplayLocation = contextDisplayLocation ?? panelLocation;
  const showContextCapsule = Boolean(
    panels?.context?.available === true && effectiveContextLocation === 'topbar',
  );

  useEffect(() => {
    if (!showContextCapsule && activePopover === 'context') {
      setActivePopover(null);
    }
  }, [showContextCapsule, activePopover]);

  const capsules: FormattedCapsule[] = [
    ...(showContextCapsule ? [formatContextCapsule(panels?.context, t)] : []),
    formatUsageCapsule(panels?.usage, t),
    formatQuotaCapsule(panels?.quota, t),
  ];

  const conn = getConnectionMeta(connectionStatus, t);
  const hasConnectionAlert = connectionStatus !== 'connected' || !rpcConnected;
  const runningTasksCount =
    tasksData?.runningCount ??
    (tasksData?.running ? tasksData.running.length : 0);

  const openTab = (tab: HostAdminTab, selectedPluginId?: string, dedicated?: () => void) => {
    setActivePopover(null);
    if (dedicated && !selectedPluginId) {
      dedicated();
      return;
    }
    onOpenHostAdmin?.(tab, selectedPluginId);
  };

  const activeCapsuleSlot =
    activePopover === 'context'
      ? panels?.context
      : activePopover === 'usage'
        ? panels?.usage
        : activePopover === 'quota'
          ? panels?.quota
          : undefined;

  const currentWebChannel = (webAccessStatus?.channel as AccessChannel | undefined) || undefined;
  const currentChannelLabel =
    currentWebChannel && CHANNEL_SHORT_LABEL_KEY[currentWebChannel]
      ? t(CHANNEL_SHORT_LABEL_KEY[currentWebChannel])
      : t('webAccess.channelShort.loopback');
  const currentChannelProbe = currentWebChannel ? channelProbeCache[currentWebChannel] : undefined;
  const currentChannelRtt =
    currentChannelProbe?.state === 'ok' && typeof currentChannelProbe.rttMs === 'number'
      ? currentChannelProbe.rttMs
      : currentChannelProbe?.cachedRttMs;
  const channelCapsuleText =
    typeof currentChannelRtt === 'number'
      ? `${currentChannelLabel} · ${currentChannelRtt} ms`
      : currentChannelLabel;

  return (
    <div ref={rootRef} className={`${styles.root} ${className || ''}`.trim()}>
      <div className={styles.leftGroup}>
        <span className={styles.brandMark} aria-hidden="true">
          A
        </span>
        {sessionTitle && (
          <>
            <span
              className={styles.sessionTitle}
              title={sessionTitle}
              data-testid="topbar-session-title"
            >
              {sessionTitle}
            </span>
            <span
              className={`${styles.sessionStatusBadge} ${
                sessionRunning ? styles.sessionStatusRunning : styles.sessionStatusIdle
              }`}
              data-testid="topbar-session-status"
            >
              <span className={styles.sessionStatusDot} aria-hidden="true" />
              <span>{sessionRunning ? t('topbar.sessionRunning') : t('topbar.sessionIdle')}</span>
            </span>
          </>
        )}
        {(workspaceName || branchName) && (
          <span
            className={styles.workspaceChip}
            title={[workspaceName, branchName].filter(Boolean).join(' · ')}
            data-testid="topbar-workspace-chip"
          >
            {workspaceName && <span className={styles.workspaceName}>{workspaceName}</span>}
            {branchName && <span className={styles.branchTag}>{branchName}</span>}
          </span>
        )}
        {diffCount > 0 && onOpenDiffReview && (
          <button
            type="button"
            className={styles.diffBadgeBtn}
            onClick={onOpenDiffReview}
            data-testid="topbar-review-btn"
          >
            {t('topbar.diffReview', { count: diffCount })}
          </button>
        )}
      </div>

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

      {activePopover &&
        activePopover !== 'mobile-qr' &&
        activePopover !== 'channel-switcher' &&
        activePopover !== 'tasks' &&
        activePopover !== 'custom-menu' && (
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
          className={`${styles.statusPill} ${hasConnectionAlert ? styles.statusPillAlert : ''}`.trim()}
          data-connection={connectionStatus}
          data-alert={hasConnectionAlert ? 'true' : 'false'}
          title={hubOrigin ? `${conn.label} · Hub: ${hubOrigin}` : conn.label}
        >
          <span className={`${styles.statusDot} ${conn.dotClass}`} aria-hidden="true" />
          <span className={styles.statusLabelText}>{conn.label}</span>
          {!rpcConnected && <span className={styles.rpcWarn}>· {t('topbar.rpc.disconnected')}</span>}
        </div>

        <div ref={channelSwitcherAnchorRef} className={styles.mobileQrAnchor}>
          <button
            type="button"
            className={`${styles.triggerBtn} ${activePopover === 'channel-switcher' ? styles.triggerBtnActive : ''}`.trim()}
            onClick={() => {
              const next = activePopover === 'channel-switcher' ? null : 'channel-switcher';
              setActivePopover(next);
              if (next === 'channel-switcher') onRefreshWebAccess?.();
            }}
            title={t('channelSwitcher.title')}
            aria-haspopup="dialog"
            aria-expanded={activePopover === 'channel-switcher'}
            data-testid="topbar-channel-switcher-btn"
          >
            <span>{channelCapsuleText}</span>
            <span aria-hidden="true">▾</span>
          </button>

          {activePopover === 'channel-switcher' && (
            <ChannelSwitcherPopover
              status={webAccessStatus}
              activeSessionId={activeSessionId}
              probeCache={channelProbeCache}
              onProbeCacheChange={setChannelProbeCache}
              onRefreshStatus={onRefreshWebAccess}
              onNavigate={onNavigateChannelUrl}
              onClose={closePopover}
            />
          )}
        </div>

        <div ref={tasksAnchorRef} className={styles.mobileQrAnchor}>
          <button
            type="button"
            className={`${styles.triggerBtn} ${runningTasksCount > 0 ? styles.triggerBtnAccent : ''} ${activePopover === 'tasks' ? styles.triggerBtnActive : ''}`.trim()}
            onClick={() => {
              const next = activePopover === 'tasks' ? null : 'tasks';
              setActivePopover(next);
              if (next === 'tasks') onRefreshTasks?.();
            }}
            title={t('topbar.tasks')}
            aria-haspopup="dialog"
            aria-expanded={activePopover === 'tasks'}
            data-testid="topbar-tasks-btn"
          >
            <TasksPulseIcon />
            <span className={styles.tasksBtnLabel}>{t('topbar.tasks')}</span>
            {runningTasksCount > 0 && (
              <span className={styles.tasksCountBadge} data-testid="topbar-tasks-badge">
                {runningTasksCount}
              </span>
            )}
          </button>

          {activePopover === 'tasks' && (
            <BackgroundTasksPopover
              tasksData={tasksData}
              loading={tasksLoading}
              channel={webAccessStatus?.channel || 'loopback'}
              permissionLevel={webAccessStatus?.permissionLevel || 'L2'}
              onRefresh={onRefreshTasks}
              onStopTask={onStopTask}
              onSelectSession={onSelectTaskSession}
              onClose={closePopover}
            />
          )}
        </div>

        <div ref={mobileQrAnchorRef} className={styles.mobileQrAnchor}>
          {activePopover === 'mobile-qr' && (
            <MobileQrPopover
              remoteStatus={remoteStatus}
              remoteLoading={remoteLoading}
              onRefreshRemote={onRefreshRemote}
              onClose={closePopover}
            />
          )}
        </div>

        <div ref={customMenuAnchorRef} className={styles.mobileQrAnchor}>
          <button
            type="button"
            className={`${styles.triggerBtn} ${styles.menuTriggerBtn} ${activePopover === 'custom-menu' ? styles.triggerBtnActive : ''}`.trim()}
            onClick={() => setActivePopover((prev) => (prev === 'custom-menu' ? null : 'custom-menu'))}
            title={t('topbar.customMenu')}
            aria-label={t('topbar.customMenu')}
            aria-haspopup="menu"
            aria-expanded={activePopover === 'custom-menu'}
            data-testid="topbar-custom-menu-btn"
          >
            <MenuHamburgerIcon />
          </button>

          {activePopover === 'custom-menu' && (
            <CustomMenuPopover
              connectionLabel={conn.label}
              connectionStatus={connectionStatus}
              rpcConnected={rpcConnected}
              channelLabel={channelCapsuleText}
              channel={webAccessStatus?.channel || 'loopback'}
              permissionLevel={webAccessStatus?.permissionLevel || 'L2'}
              panels={panels}
              runningTasksCount={runningTasksCount}
              onRefreshSession={onRefreshSession}
              onOpenHostAdmin={(tab, pluginId) => {
                if (tab === 'plugins') {
                  openTab('plugins', pluginId, onOpenPlugins);
                } else if (tab === 'commands') {
                  openTab('commands', undefined, onOpenCommandPalette);
                } else if (tab === 'doctor') {
                  openTab('doctor', undefined, onOpenDoctor);
                } else {
                  openTab(tab || 'appearance', pluginId);
                }
              }}
              onOpenMobileQr={() => setActivePopover('mobile-qr')}
              onOpenTasks={() => {
                setActivePopover('tasks');
                onRefreshTasks?.();
              }}
              onPluginsChanged={onPluginsChanged}
              onClose={closePopover}
            />
          )}
        </div>
      </div>
    </div>
  );
}
