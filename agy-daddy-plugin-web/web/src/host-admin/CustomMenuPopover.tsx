import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient } from '../api/client';
import { normalizeLocale, useI18n } from '../i18n';
import { useTheme } from '../theme/ThemeProvider';
import type { HostPluginItem, TopbarPanels } from '../types';
import type { ConnectionStatus, HostAdminTab } from './TopbarCapsules';
import styles from './CustomMenuPopover.module.css';

const PRIORITY_PLUGIN_IDS = [
  'agy-daddy.composer',
  'agy-daddy.context',
  'agy-daddy.zh-cn',
  'agy-daddy.remote',
  'agy-daddy.usage',
  'agy-daddy.quota',
  'agy-daddy.web',
];

export interface CustomMenuPopoverProps {
  connectionLabel: string;
  connectionStatus: ConnectionStatus;
  rpcConnected?: boolean;
  channelLabel: string;
  channel?: string;
  permissionLevel?: string;
  panels?: TopbarPanels | null;
  runningTasksCount?: number;
  onRefreshSession?: () => void;
  onOpenHostAdmin?: (initialTab?: HostAdminTab, selectedPluginId?: string) => void;
  onOpenMobileQr?: () => void;
  onOpenTasks?: () => void;
  onPluginsChanged?: () => void;
  onClose: () => void;
}

export function CustomMenuPopover({
  connectionLabel,
  connectionStatus,
  rpcConnected = true,
  channelLabel,
  channel = 'loopback',
  permissionLevel = 'L0',
  panels,
  runningTasksCount = 0,
  onRefreshSession,
  onOpenHostAdmin,
  onOpenMobileQr,
  onOpenTasks,
  onPluginsChanged,
  onClose,
}: CustomMenuPopoverProps) {
  const { locale, supportedLanguages, setLocale, t } = useI18n();
  const { preference, resolvedTheme, cycleTheme } = useTheme();

  const [plugins, setPlugins] = useState<HostPluginItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDisableWeb, setConfirmDisableWeb] = useState(false);

  const canManagePlugins = channel === 'loopback' || permissionLevel === 'L2';

  const loadPlugins = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.getHostPlugins('all');
      setPlugins(res.plugins || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.pluginsFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const sortedQuickPlugins = useMemo(() => {
    const rank = (id: string) => {
      const idx = PRIORITY_PLUGIN_IDS.indexOf(id);
      return idx === -1 ? 999 : idx;
    };
    return [...plugins].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id)).slice(0, 6);
  }, [plugins]);

  const handleTogglePlugin = async (plugin: HostPluginItem) => {
    if (!canManagePlugins) return;
    if (plugin.id === 'agy-daddy.web' && plugin.enabled && !confirmDisableWeb) {
      setConfirmDisableWeb(true);
      return;
    }
    setConfirmDisableWeb(false);
    setBusyId(plugin.id);
    setError(null);
    try {
      await apiClient.runHostPluginAction(plugin.id, plugin.enabled ? 'disable' : 'enable');
      await loadPlugins();
      onPluginsChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('admin.actionFailed', { action: plugin.enabled ? 'disable' : 'enable' }));
    } finally {
      setBusyId(null);
    }
  };

  const themeLabel =
    preference === 'system'
      ? `${t('theme.system')} (${resolvedTheme === 'light' ? '☀' : '☾'})`
      : preference === 'light'
        ? `☀ ${t('theme.light')}`
        : `☾ ${t('theme.dark')}`;

  return (
    <div
      className={styles.popover}
      role="menu"
      aria-label={t('menu.title')}
      data-testid="custom-menu-popover"
    >
      <div className={styles.header}>
        <span className={styles.title}>{t('menu.title')}</span>
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label={t('common.close')}
        >
          ×
        </button>
      </div>

      <div className={styles.body}>
        <div className={styles.section}>
          <div className={styles.summaryGrid}>
            <div className={styles.summaryItem}>
              <span className={styles.summaryKey}>{t('menu.connectionStatus')}</span>
              <span className={styles.summaryVal} data-connection={connectionStatus}>
                {connectionLabel}
                {!rpcConnected ? ` · ${t('topbar.rpc.disconnected')}` : ''}
              </span>
            </div>
            <div className={styles.summaryItem}>
              <span className={styles.summaryKey}>{t('menu.channelLabel')}</span>
              <span className={styles.summaryVal}>
                {channelLabel} · {channel === 'loopback' ? 'Local' : permissionLevel}
              </span>
            </div>
          </div>

          <div className={styles.narrowStats}>
            {panels?.usage?.available && (
              <span className={styles.statBadge}>
                Usage: {String((panels.usage.data as Record<string, unknown>)?.totalTokens ?? t('topbar.ready'))}
              </span>
            )}
            {panels?.quota?.available && (
              <span className={styles.statBadge}>
                Quota: {String((panels.quota.data as Record<string, unknown>)?.percentText ?? t('topbar.ready'))}
              </span>
            )}
          </div>

          {onRefreshSession && (
            <button
              type="button"
              role="menuitem"
              className={styles.actionRowBtn}
              onClick={() => {
                onRefreshSession();
                onClose();
              }}
              data-testid="menu-refresh-session-btn"
            >
              <span>↻ {t('menu.refreshSession')}</span>
            </button>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>{t('menu.pluginsSection')}</span>
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => {
                onOpenHostAdmin?.('plugins');
                onClose();
              }}
              data-testid="menu-open-full-plugins-btn"
            >
              {t('menu.openFullAdmin')}
            </button>
          </div>

          {!canManagePlugins && (
            <div className={styles.lockBanner} role="status" data-testid="menu-perm-locked-banner">
              {t('menu.permLockedL0L1', { tier: permissionLevel })}
            </div>
          )}

          {error && (
            <div className={styles.errorBanner} role="alert">
              {error}
            </div>
          )}

          {confirmDisableWeb && (
            <div className={styles.dangerBox} role="alertdialog" data-testid="menu-disable-web-confirm">
              <div className={styles.dangerTitle}>{t('menu.disableWebTitle')}</div>
              <p className={styles.dangerDesc}>{t('menu.disableWebConfirm')}</p>
              <div className={styles.dangerActions}>
                <button
                  type="button"
                  className={styles.dangerBtn}
                  onClick={() => {
                    const webPlugin = plugins.find((p) => p.id === 'agy-daddy.web');
                    if (webPlugin) void handleTogglePlugin(webPlugin);
                  }}
                  data-testid="menu-disable-web-confirm-btn"
                >
                  {t('menu.disableWebAction')}
                </button>
                <button
                  type="button"
                  className={styles.smallBtn}
                  onClick={() => setConfirmDisableWeb(false)}
                >
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}

          {loading && plugins.length === 0 ? (
            <div className={styles.mutedText}>{t('admin.loadingPlugins')}</div>
          ) : (
            <div className={styles.pluginList}>
              {sortedQuickPlugins.map((p) => {
                const isBusy = busyId === p.id;
                return (
                  <div key={p.id} className={styles.pluginRow} data-testid={`menu-plugin-row-${p.id}`}>
                    <div className={styles.pluginInfo}>
                      <span
                        className={`${styles.stateDot} ${
                          !p.enabled ? styles.dotOff : p.active ? styles.dotOn : styles.dotWarn
                        }`}
                        aria-hidden="true"
                      />
                      <span className={styles.pluginName} title={p.id}>
                        {p.displayName || p.id}
                      </span>
                      <span className={styles.pluginVersion}>v{p.version}</span>
                    </div>
                    <div className={styles.pluginControls}>
                      <button
                        type="button"
                        className={styles.gearBtn}
                        title={t('menu.pluginSettings')}
                        aria-label={`${p.displayName || p.id} ${t('menu.pluginSettings')}`}
                        onClick={() => {
                          onOpenHostAdmin?.('plugins', p.id);
                          onClose();
                        }}
                        data-testid={`menu-plugin-settings-${p.id}`}
                      >
                        ⚙
                      </button>
                      <button
                        type="button"
                        className={`${styles.toggleBtn} ${p.enabled ? styles.toggleOn : ''}`}
                        disabled={!canManagePlugins || isBusy}
                        aria-pressed={p.enabled}
                        onClick={() => void handleTogglePlugin(p)}
                        data-testid={`menu-plugin-toggle-${p.id}`}
                      >
                        {p.enabled ? t('admin.enabled') : t('admin.disabled')}
                      </button>
                    </div>
                  </div>
                );
              })}
              {plugins.length > sortedQuickPlugins.length && (
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => {
                    onOpenHostAdmin?.('plugins');
                    onClose();
                  }}
                >
                  {t('menu.viewAllPlugins', { count: plugins.length })}
                </button>
              )}
            </div>
          )}
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>{t('menu.preferencesSection')}</div>

          <div className={styles.prefRow}>
            <span className={styles.prefLabel}>{t('menu.themeMode')}</span>
            <button
              type="button"
              className={styles.smallBtn}
              onClick={cycleTheme}
              data-testid="theme-toggle-btn"
              data-theme-pref={preference}
            >
              {themeLabel}
            </button>
          </div>

          <div className={styles.prefRow}>
            <span className={styles.prefLabel}>{t('menu.language')}</span>
            <select
              className={styles.localeSelect}
              value={locale}
              onChange={(ev) => {
                setLocale(normalizeLocale(ev.target.value) || 'en');
              }}
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
          </div>

          <div className={styles.toolGrid}>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() => {
                onOpenHostAdmin?.('appearance');
                onClose();
              }}
              data-testid="topbar-appearance-btn"
            >
              {t('topbar.appearance')}
            </button>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() => {
                onOpenHostAdmin?.('commands');
                onClose();
              }}
              data-testid="menu-commands-btn"
            >
              {t('topbar.commands')} ⌘K
            </button>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() => {
                onOpenMobileQr?.();
              }}
              data-testid="topbar-mobile-qr-btn"
            >
              {t('topbar.mobileQr')}
            </button>
            <button
              type="button"
              className={styles.toolBtn}
              onClick={() => {
                onOpenHostAdmin?.('doctor');
                onClose();
              }}
              data-testid="menu-doctor-btn"
            >
              {t('topbar.doctor')}
            </button>
            {onOpenTasks && (
              <button
                type="button"
                className={styles.toolBtn}
                onClick={() => {
                  onOpenTasks();
                }}
                data-testid="menu-tasks-btn"
              >
                {t('menu.backgroundTasks')}
                {runningTasksCount > 0 ? ` (${runningTasksCount})` : ''}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
