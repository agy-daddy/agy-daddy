import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import { BottomSheet } from '../layout/BottomSheet';
import { api } from '../store/api';
import type { ChannelEntryDto, ChannelsListResponse } from '../types';
import styles from './SheetCommon.module.css';

export interface ChannelSwitcherSheetProps {
  open: boolean;
  onSwitchInPage: (entry: ChannelEntryDto) => Promise<void>;
  onSwitchWithTicket: (entry: ChannelEntryDto) => Promise<void>;
  onClose: () => void;
}

type ProbeResult = {
  status: 'probing' | 'ok' | 'blocked' | 'error';
  rttMs?: number;
};

export function ChannelSwitcherSheet({
  open,
  onSwitchInPage,
  onSwitchWithTicket,
  onClose
}: ChannelSwitcherSheetProps) {
  const { t } = useI18n();
  const [data, setData] = useState<ChannelsListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({});
  const [switchingKey, setSwitchingKey] = useState('');
  const [error, setError] = useState('');

  const runProbes = useCallback(async (entries: ChannelEntryDto[]) => {
    const initial: Record<string, ProbeResult> = {};
    for (const ep of entries) {
      initial[ep.key] = ep.requiresTicketRedirect ? { status: 'blocked' } : { status: 'probing' };
    }
    setProbes(initial);

    await Promise.all(
      entries.map(async (ep) => {
        if (ep.requiresTicketRedirect) return;
        try {
          const rtt = await api.pingLatency(ep.probeUrl);
          setProbes((prev) => ({ ...prev, [ep.key]: { status: 'ok', rttMs: rtt } }));
        } catch {
          setProbes((prev) => ({ ...prev, [ep.key]: { status: 'error' } }));
        }
      })
    );
  }, []);

  const loadChannels = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.getChannels();
      setData(res);
      void runProbes(res.entries || []);
    } catch (err) {
      setError((err as Error).message || t('channels.switchFailed'));
    } finally {
      setLoading(false);
    }
  }, [runProbes, t]);

  useEffect(() => {
    if (open) void loadChannels();
  }, [open, loadChannels]);

  const entries = data?.entries || [];

  const recommendedKey = useMemo(() => {
    let bestKey = '';
    let bestRtt = Infinity;
    for (const ep of entries) {
      const p = probes[ep.key];
      if (p?.status === 'ok' && typeof p.rttMs === 'number' && p.rttMs < bestRtt) {
        bestRtt = p.rttMs;
        bestKey = ep.key;
      }
    }
    return bestKey;
  }, [entries, probes]);

  const handleSelect = async (entry: ChannelEntryDto) => {
    if (switchingKey) return;
    setSwitchingKey(entry.key);
    setError('');
    try {
      if (entry.requiresTicketRedirect) {
        await onSwitchWithTicket(entry);
      } else {
        await onSwitchInPage(entry);
        onClose();
      }
    } catch (err) {
      setError((err as Error).message || t('channels.switchFailed'));
    } finally {
      setSwitchingKey('');
    }
  };

  return (
    <BottomSheet
      open={open}
      title={t('channels.title')}
      subtitle={data?.currentOrigin || undefined}
      testId="channel-switcher-sheet"
      headerActions={
        <button
          type="button"
          className="ag-pill-btn"
          disabled={loading}
          onClick={() => (entries.length > 0 ? void runProbes(entries) : void loadChannels())}
          data-testid="channel-retest-btn"
        >
          {loading ? t('channels.testing') : t('channels.retest')}
        </button>
      }
      onClose={onClose}
    >
      <div className={styles.content}>
        {entries.some((e) => e.requiresTicketRedirect) && (
          <div className={styles.alertBox}>{t('channels.crossProtoNote')}</div>
        )}

        {error && (
          <div className={`${styles.alertBox} ${styles.alertCritical}`} role="alert">
            {error}
          </div>
        )}

        {entries.length === 0 ? (
          <div className="ag-empty">{loading ? t('channels.testing') : t('telemetry.noData')}</div>
        ) : (
          entries.map((ep) => {
            const p = probes[ep.key];
            const isBest = ep.key === recommendedKey;
            const rttTone =
              p?.status === 'ok'
                ? (p.rttMs || 0) <= 60
                  ? 'ok'
                  : (p.rttMs || 0) <= 220
                    ? 'warn'
                    : 'danger'
                : p?.status === 'blocked'
                  ? 'warn'
                  : p?.status === 'error'
                    ? 'danger'
                    : undefined;

            return (
              <div key={ep.key} className={styles.card} data-testid={`channel-card-${ep.key}`}>
                <div className={styles.rowBetween}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 14 }}>{ep.label}</strong>
                    {ep.isCurrent && (
                      <span className="ag-chip" data-tone="accent">
                        {t('channels.current')}
                      </span>
                    )}
                    {isBest && !ep.isCurrent && (
                      <span className="ag-chip" data-tone="ok">
                        {t('channels.recommended')}
                      </span>
                    )}
                  </div>
                  <span className="ag-chip" data-tone={rttTone}>
                    {p?.status === 'ok'
                      ? `${p.rttMs} ms`
                      : p?.status === 'blocked'
                        ? t('channels.httpsRestricted')
                        : p?.status === 'error'
                          ? t('channels.unreachable')
                          : t('channels.testing')}
                  </span>
                </div>

                <div className={styles.monoSmall}>{ep.origin}</div>

                {!ep.isCurrent && (
                  <button
                    type="button"
                    className={`${styles.actionBtn} ${isBest ? styles.actionPrimary : ''}`}
                    disabled={Boolean(switchingKey)}
                    onClick={() => void handleSelect(ep)}
                    data-testid={`channel-switch-${ep.key}`}
                  >
                    {ep.requiresTicketRedirect
                      ? t('channels.switchTicket')
                      : t('channels.switchInPage')}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </BottomSheet>
  );
}
