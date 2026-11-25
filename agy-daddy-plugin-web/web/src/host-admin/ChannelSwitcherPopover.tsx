import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  copyTextWithFallback,
  createChannelSwitchTicket,
  probeChannelPing,
} from '../api/client';
import { useI18n } from '../i18n';
import type { AccessChannel, ChannelEndpointMeta, WebAccessStatusResponse } from '../types';
import {
  ACCESS_CHANNEL_ORDER,
  CHANNEL_LABEL_KEY,
  CHANNEL_SHORT_LABEL_KEY,
  formatCloudflareGuidance,
} from './webAccessHelpers';
import styles from './ChannelSwitcherPopover.module.css';

export interface ChannelProbeEntry {
  state: 'probing' | 'ok' | 'https_restricted' | 'timeout' | 'unreachable';
  rttMs?: number;
  cachedRttMs?: number;
}

export interface ChannelSwitcherPopoverProps {
  status?: WebAccessStatusResponse | null;
  activeSessionId?: string | null;
  probeCache: Record<string, ChannelProbeEntry>;
  onProbeCacheChange: (
    updater:
      | Record<string, ChannelProbeEntry>
      | ((prev: Record<string, ChannelProbeEntry>) => Record<string, ChannelProbeEntry>),
  ) => void;
  onRefreshStatus?: () => void;
  onNavigate?: (url: string) => void;
  onClose: () => void;
}

function getCurrentProtocol(): string {
  return typeof window !== 'undefined' ? window.location.protocol : 'http:';
}

function getCurrentHost(): string {
  return typeof window !== 'undefined' && window.location.host ? window.location.host : 'localhost';
}

export function ChannelSwitcherPopover({
  status,
  activeSessionId,
  probeCache,
  onProbeCacheChange,
  onRefreshStatus,
  onNavigate,
  onClose,
}: ChannelSwitcherPopoverProps) {
  const { t } = useI18n();
  const [probing, setProbing] = useState(false);
  const [switchingKey, setSwitchingKey] = useState<AccessChannel | null>(null);
  const [copiedKey, setCopiedKey] = useState<AccessChannel | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [fallbackLink, setFallbackLink] = useState<{ key: AccessChannel; url: string } | null>(null);
  const probingRef = useRef(false);
  const mountedRef = useRef(true);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const endpoints = useMemo(() => {
    const map = status?.channelEndpoints || {};
    const list: ChannelEndpointMeta[] = [];
    for (const key of ACCESS_CHANNEL_ORDER) {
      const ep = map[key];
      if (ep) list.push(ep);
    }
    return list;
  }, [status?.channelEndpoints]);

  const currentProtocol = getCurrentProtocol();
  const hasHttpsToHttp =
    currentProtocol === 'https:' && endpoints.some((ep) => ep.origin.startsWith('http://'));

  const runProbes = useCallback(async () => {
    if (probingRef.current || endpoints.length === 0) return;
    probingRef.current = true;
    setProbing(true);

    const protocol = getCurrentProtocol();
    onProbeCacheChange((prev) => {
      const next: Record<string, ChannelProbeEntry> = { ...prev };
      for (const ep of endpoints) {
        if (protocol === 'https:' && ep.origin.startsWith('http://')) {
          next[ep.key] = { state: 'https_restricted' };
        } else {
          const prevEntry = prev[ep.key];
          const cachedRtt =
            prevEntry?.state === 'ok' && typeof prevEntry.rttMs === 'number'
              ? prevEntry.rttMs
              : prevEntry?.cachedRttMs;
          next[ep.key] = { state: 'probing', cachedRttMs: cachedRtt };
        }
      }
      return next;
    });

    try {
      await Promise.all(
        endpoints.map(async (ep) => {
          if (protocol === 'https:' && ep.origin.startsWith('http://')) {
            return;
          }
          const result = await probeChannelPing(ep.probeUrl, 2000);
          if (!mountedRef.current) return;
          onProbeCacheChange((prev) => ({
            ...prev,
            [ep.key]:
              result.state === 'ok'
                ? { state: 'ok', rttMs: result.rttMs }
                : { state: result.state },
          }));
        }),
      );
    } finally {
      probingRef.current = false;
      if (mountedRef.current) {
        setProbing(false);
      }
    }
  }, [endpoints, onProbeCacheChange]);

  useEffect(() => {
    void runProbes();
  }, [runProbes]);

  const recommendedKey = useMemo<AccessChannel | null>(() => {
    let bestKey: AccessChannel | null = null;
    let bestRtt = Infinity;
    for (const ep of endpoints) {
      const probe = probeCache[ep.key];
      if (probe?.state === 'ok' && typeof probe.rttMs === 'number' && probe.rttMs < bestRtt) {
        bestRtt = probe.rttMs;
        bestKey = ep.key;
      }
    }
    return bestKey;
  }, [endpoints, probeCache]);

  const currentChannel = (status?.channel as AccessChannel | undefined) || undefined;
  const currentChannelLabel =
    currentChannel && CHANNEL_SHORT_LABEL_KEY[currentChannel]
      ? t(CHANNEL_SHORT_LABEL_KEY[currentChannel])
      : t('webAccess.unknownChannel');

  const cfGuidance = formatCloudflareGuidance(status?.cloudflareState, t);

  const handleSwitch = async (ep: ChannelEndpointMeta) => {
    setSwitchError(null);
    setFallbackLink(null);
    setSwitchingKey(ep.key);

    const isHttpsToHttp = currentProtocol === 'https:' && ep.origin.startsWith('http://');
    let popup: Window | null = null;
    if (isHttpsToHttp && typeof window !== 'undefined' && typeof window.open === 'function') {
      popup = window.open('about:blank', '_blank');
    }

    try {
      const ticketRes = await createChannelSwitchTicket(ep.key, activeSessionId);
      const targetUrl = ticketRes.switchUrl;
      if (isHttpsToHttp) {
        if (popup) {
          try {
            popup.opener = null;
          } catch {
            // Ignore cross-origin opener restrictions
          }
          popup.location.replace(targetUrl);
        } else {
          setFallbackLink({ key: ep.key, url: targetUrl });
        }
      } else if (onNavigate) {
        onNavigate(targetUrl);
      } else if (typeof window !== 'undefined') {
        window.location.assign(targetUrl);
      }
    } catch (err) {
      if (popup) {
        try {
          popup.close();
        } catch {
          // Ignore close failure
        }
      }
      setSwitchError(
        err instanceof Error && err.message ? err.message : t('channelSwitcher.switchFailed'),
      );
    } finally {
      if (mountedRef.current) {
        setSwitchingKey(null);
      }
    }
  };

  const handleCopy = async (ep: ChannelEndpointMeta) => {
    const existingUrl = status?.urls?.[ep.key] || '';
    let valueToCopy = existingUrl;
    if (!existingUrl.includes('token=')) {
      try {
        const ticketRes = await createChannelSwitchTicket(ep.key, activeSessionId);
        valueToCopy = ticketRes.switchUrl;
      } catch {
        valueToCopy = existingUrl || `${ep.origin}${ep.basePath}/`;
      }
    }
    await copyTextWithFallback(valueToCopy);
    if (!mountedRef.current) return;
    setCopiedKey(ep.key);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      if (mountedRef.current) setCopiedKey(null);
    }, 1500);
  };

  const renderProbeStatus = (ep: ChannelEndpointMeta) => {
    const probe = probeCache[ep.key];
    if (!probe || probe.state === 'probing') {
      if (typeof probe?.cachedRttMs === 'number') {
        return (
          <div className={styles.probeWrap} data-testid={`channel-probe-${ep.key}`}>
            <span className={`${styles.probeBadge} ${styles.probeMuted}`}>
              {t('channelSwitcher.probe.ms', { ms: probe.cachedRttMs })}
            </span>
            <span className={styles.probeSub}>{t('channelSwitcher.probe.probing')}</span>
          </div>
        );
      }
      return (
        <div className={styles.probeWrap} data-testid={`channel-probe-${ep.key}`}>
          <span className={`${styles.probeBadge} ${styles.probeMuted}`}>
            {t('channelSwitcher.probe.probing')}
          </span>
        </div>
      );
    }
    if (probe.state === 'ok') {
      return (
        <div className={styles.probeWrap} data-testid={`channel-probe-${ep.key}`}>
          <span className={`${styles.probeBadge} ${styles.probeOk}`}>
            {t('channelSwitcher.probe.ms', { ms: probe.rttMs ?? 1 })}
          </span>
        </div>
      );
    }
    if (probe.state === 'https_restricted') {
      return (
        <div className={styles.probeWrap} data-testid={`channel-probe-${ep.key}`}>
          <span className={`${styles.probeBadge} ${styles.probeWarn}`}>
            {t('channelSwitcher.probe.httpsRestricted')}
          </span>
          <span className={styles.probeSub}>{t('channelSwitcher.probe.httpsRestrictedSub')}</span>
        </div>
      );
    }
    if (probe.state === 'timeout') {
      return (
        <div className={styles.probeWrap} data-testid={`channel-probe-${ep.key}`}>
          <span className={`${styles.probeBadge} ${styles.probeDanger}`}>
            {t('channelSwitcher.probe.timeout')}
          </span>
        </div>
      );
    }
    return (
      <div className={styles.probeWrap} data-testid={`channel-probe-${ep.key}`}>
        <span className={`${styles.probeBadge} ${styles.probeDanger}`}>
          {t('channelSwitcher.probe.unreachable')}
        </span>
      </div>
    );
  };

  return (
    <div
      className={styles.popover}
      role="dialog"
      aria-label={t('channelSwitcher.title')}
      data-testid="channel-switcher-popover"
    >
      <div className={styles.header}>
        <div className={styles.titleBlock}>
          <h3 className={styles.title}>{t('channelSwitcher.title')}</h3>
          <span className={styles.subtitle}>
            {t('channelSwitcher.currentHost', {
              channel: currentChannelLabel,
              host: getCurrentHost(),
            })}
          </span>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.retestBtn}
            onClick={() => {
              onRefreshStatus?.();
              void runProbes();
            }}
            disabled={probing}
            data-testid="channel-switcher-retest-btn"
          >
            {probing ? t('channelSwitcher.testing') : t('channelSwitcher.retest')}
          </button>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </div>
      </div>

      <div className={styles.body}>
        {hasHttpsToHttp && (
          <div className={`${styles.notice} ${styles.noticeWarn}`} data-testid="channel-switcher-https-notice">
            {t('channelSwitcher.httpsNotice')}
          </div>
        )}

        {cfGuidance && status?.cloudflareState?.mode !== 'shared_ready' && (
          <div
            className={`${styles.notice} ${cfGuidance.tone === 'warn' ? styles.noticeWarn : ''}`.trim()}
            data-testid="channel-switcher-cf-notice"
          >
            {cfGuidance.message}
          </div>
        )}

        {switchError && (
          <div className={styles.errorText} role="alert">
            {switchError}
          </div>
        )}

        {endpoints.length === 0 ? (
          <div className={styles.empty}>{t('channelSwitcher.empty')}</div>
        ) : (
          <ul className={styles.list}>
            {endpoints.map((ep) => {
              const isCurrent = currentChannel === ep.key;
              const isRecommended = recommendedKey === ep.key;
              const isSwitching = switchingKey === ep.key;
              return (
                <li
                  key={ep.key}
                  className={`${styles.row} ${isCurrent ? styles.rowActive : ''}`.trim()}
                  data-testid={`channel-row-${ep.key}`}
                >
                  <div className={styles.rowTop}>
                    <div className={styles.rowTitleWrap}>
                      <span className={styles.rowTitle}>{t(CHANNEL_LABEL_KEY[ep.key])}</span>
                      {isCurrent && (
                        <span className={styles.badge} data-testid={`channel-current-${ep.key}`}>
                          {t('channelSwitcher.badge.current')}
                        </span>
                      )}
                      {isRecommended && (
                        <span
                          className={`${styles.badge} ${styles.badgeRecommended}`}
                          data-testid={`channel-recommended-${ep.key}`}
                        >
                          {t('channelSwitcher.badge.recommended')}
                        </span>
                      )}
                    </div>
                    {renderProbeStatus(ep)}
                  </div>

                  <div className={styles.rowBottom}>
                    <div className={styles.hostMeta}>
                      <span className={styles.displayHost} title={ep.displayHost}>
                        {ep.displayHost}
                      </span>
                      {ep.key === 'loopback' && currentChannel !== 'loopback' && (
                        <span className={styles.localOnlyHint}>
                          {t('channelSwitcher.loopbackLocalOnly')}
                        </span>
                      )}
                    </div>

                    <div className={styles.rowActions}>
                      {isCurrent ? (
                        <button
                          type="button"
                          className={styles.actionBtn}
                          disabled
                          data-testid={`channel-active-${ep.key}`}
                        >
                          {t('channelSwitcher.action.inUse')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={`${styles.actionBtn} ${styles.switchBtn}`}
                          onClick={() => void handleSwitch(ep)}
                          disabled={isSwitching}
                          data-testid={`channel-switch-${ep.key}`}
                        >
                          {isSwitching
                            ? t('channelSwitcher.action.switching')
                            : t('channelSwitcher.action.switch')}
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.actionBtn}
                        onClick={() => void handleCopy(ep)}
                        data-testid={`channel-copy-${ep.key}`}
                      >
                        {copiedKey === ep.key ? t('webAccess.copied') : t('webAccess.copy')}
                      </button>
                    </div>
                  </div>

                  {fallbackLink?.key === ep.key && (
                    <a
                      href={fallbackLink.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={styles.fallbackLink}
                      data-testid={`channel-fallback-link-${ep.key}`}
                    >
                      {t('channelSwitcher.action.openInNewTab')}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
