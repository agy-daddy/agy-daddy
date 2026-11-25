import { useCallback, useEffect, useRef, useState } from 'react';
import { getWebAccessStatus } from '../api/client';
import { useI18n, type I18nKey } from '../i18n';
import type { AccessChannel, WebAccessStatusResponse } from '../types';
import styles from './WebAccessPanel.module.css';

const CHANNEL_ORDER: AccessChannel[] = ['loopback', 'lan', 'tailscale', 'bonjour', 'cloudflare'];

const CHANNEL_LABEL_KEY: Record<AccessChannel, I18nKey> = {
  loopback: 'webAccess.channel.loopback',
  lan: 'webAccess.channel.lan',
  tailscale: 'webAccess.channel.tailscale',
  bonjour: 'webAccess.channel.bonjour',
  cloudflare: 'webAccess.channel.cloudflare',
};

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
    try {
      await navigator.clipboard?.writeText?.(value);
    } catch {
      // Clipboard can be blocked in non-secure LAN contexts; selection still works.
    }
    setCopiedKey(key);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => setCopiedKey(null), 1500);
  };

  const entries = CHANNEL_ORDER.map((key) => ({
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

          {isLoopback && nonLoopbackActive && (
            <p className={styles.note}>{t('webAccess.openFromOtherDevice')}</p>
          )}

          <ul className={styles.list}>
            {entries.map(({ key, url }) => (
              <li key={key} className={styles.row}>
                <span className={styles.rowLabel}>
                  {t(CHANNEL_LABEL_KEY[key as AccessChannel])}
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
            ))}
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
