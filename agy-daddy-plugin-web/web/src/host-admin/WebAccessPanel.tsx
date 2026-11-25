import { useCallback, useEffect, useRef, useState } from 'react';
import { copyTextWithFallback, getWebAccessStatus } from '../api/client';
import { useI18n } from '../i18n';
import type { AccessChannel, WebAccessStatusResponse } from '../types';
import {
  ACCESS_CHANNEL_ORDER,
  CHANNEL_LABEL_KEY,
  formatCloudflareGuidance,
} from './webAccessHelpers';
import styles from './WebAccessPanel.module.css';

export interface WebAccessPanelProps {
  /** Bump to re-read the status, e.g. right after saving settings. */
  refreshToken?: number;
  className?: string;
}

/**
 * Shows which access channels are enabled, the entry URL for each one, and the
 * permission tier applied to non-loopback requests. Reads GET /api/v1/web/status.
 */
export function WebAccessPanel({ refreshToken = 0, className }: WebAccessPanelProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<WebAccessStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await getWebAccessStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const handleCopy = async (key: string, value: string) => {
    await copyTextWithFallback(value);
    setCopiedKey(key);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => setCopiedKey(null), 1500);
  };

  const entries = ACCESS_CHANNEL_ORDER.map((key) => ({
    key,
    url: status?.urls?.[key] || '',
  })).filter((entry) => Boolean(entry.url));
  const isLoopback = status?.channel === 'loopback';
  const permissionLevel = status?.permissionLevel || 'L0';
  const nonLoopbackActive = Boolean(
    status?.activeChannels?.some((key) => key !== 'loopback'),
  );
  const channelLabel = status?.channel && CHANNEL_LABEL_KEY[status.channel as AccessChannel]
    ? t(CHANNEL_LABEL_KEY[status.channel as AccessChannel])
    : t('webAccess.unknownChannel');
  const primaryChannelKey = (status?.primaryChannel as AccessChannel | undefined) || undefined;
  const primaryEntryUrl = status?.primaryUrl || '';
  const cfGuidance = formatCloudflareGuidance(status?.cloudflareState, t);

  return (
    <section
      className={`${styles.panel} ${className || ''}`.trim()}
      data-testid="web-access-panel"
    >
      <div className={styles.header}>
        <h4 className={styles.title}>{t('webAccess.title')}</h4>
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? t('common.refreshing') : t('popover.refresh')}
        </button>
      </div>

      {error && (
        <div className={styles.error} role="alert">
          {t('webAccess.loadFailed')}: {error}
        </div>
      )}

      {!error && status && (
        <>
          <div className={styles.summary}>
            <span className={styles.summaryItem}>
              {t('webAccess.currentChannel')}:{' '}
              <strong>{channelLabel}</strong>
            </span>
            <span className={styles.summaryItem}>
              {t('webAccess.permissionLevel')}:{' '}
              <strong>{permissionLevel}</strong>
              <span className={styles.permissionHint}>
                {nonLoopbackActive
                  ? t(
                      status.allowRemoteWrite
                        ? 'webAccess.writableHint'
                        : 'webAccess.readOnlyHint',
                    )
                  : t('webAccess.loopbackOnlyHint')}
              </span>
            </span>
          </div>

          {primaryEntryUrl && primaryChannelKey && CHANNEL_LABEL_KEY[primaryChannelKey] && (
            <div className={styles.primaryCard} data-testid="web-access-primary-card">
              <div className={styles.primaryHead}>
                <span className={styles.primaryTitle}>{t('webAccess.primaryTitle')}</span>
                <span className={styles.primaryBadge} data-testid="web-access-primary-channel">
                  {t(CHANNEL_LABEL_KEY[primaryChannelKey])}
                </span>
              </div>
              <div className={styles.primaryRow}>
                <code className={styles.url} title={primaryEntryUrl}>
                  {primaryEntryUrl}
                </code>
                <div className={styles.primaryActions}>
                  <a
                    href={primaryEntryUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={styles.openBtn}
                    data-testid="web-access-primary-open"
                  >
                    {t('webAccess.open')}
                  </a>
                  <button
                    type="button"
                    className={styles.copyBtn}
                    onClick={() => void handleCopy('primary', primaryEntryUrl)}
                    data-testid="web-access-primary-copy"
                  >
                    {copiedKey === 'primary' ? t('webAccess.copied') : t('webAccess.copy')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {cfGuidance && (
            <div
              className={`${styles.cfNotice} ${cfGuidance.tone === 'warn' ? styles.cfNoticeWarn : ''}`.trim()}
              data-testid="web-access-cf-notice"
            >
              {cfGuidance.message}
            </div>
          )}

          {isLoopback && nonLoopbackActive && (
            <p className={styles.note}>{t('webAccess.openFromOtherDevice')}</p>
          )}

          <ul className={styles.list}>
            {entries.map(({ key, url }) => {
              const isCurrent = status.channel === key;
              return (
                <li
                  key={key}
                  className={`${styles.row} ${isCurrent ? styles.rowCurrent : ''}`.trim()}
                  data-testid={`web-access-row-${key}`}
                >
                  <span className={styles.rowLabel}>
                    {t(CHANNEL_LABEL_KEY[key as AccessChannel])}
                    {isCurrent && (
                      <span className={styles.currentBadge}>{t('webAccess.currentBadge')}</span>
                    )}
                  </span>
                  <code className={styles.url} title={url}>
                    {url}
                  </code>
                  <button
                    type="button"
                    className={styles.copyBtn}
                    onClick={() => void handleCopy(key, url)}
                    data-testid={`web-access-copy-${key}`}
                  >
                    {copiedKey === key ? t('webAccess.copied') : t('webAccess.copy')}
                  </button>
                </li>
              );
            })}
            {entries.length === 0 && (
              <li className={styles.empty}>{t('webAccess.noChannels')}</li>
            )}
          </ul>
        </>
      )}
    </section>
  );
}

export default WebAccessPanel;
