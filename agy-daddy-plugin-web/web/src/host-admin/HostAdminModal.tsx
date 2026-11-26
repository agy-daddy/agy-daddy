import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  apiClient,
  getHostDoctor,
  getHostPlugins,
  getPluginSettings,
  runHostCommand,
  runHostPluginAction,
  savePluginSettings,
} from '../api/client';
import { normalizeLocale, useI18n } from '../i18n';
import {
  normalizeColorTheme,
  normalizeDrawerSpeed,
  normalizeThemePreference,
  useTheme,
  type ColorTheme,
  type DrawerSpeed,
  type ThemePreference,
} from '../theme/ThemeProvider';
import type {
  DoctorReport,
  HostCatalogItem,
  HostMarketStats,
  HostPluginAction,
  HostPluginItem,
  PluginSettingsResponse,
  RunCommandResponse,
  SettingsSchema,
  SettingsSchemaAction,
} from '../types';
import { SchemaSettingsForm, localizeText } from './SchemaSettingsForm';
import type { HostAdminTab } from './TopbarCapsules';
import { WebAccessPanel } from './WebAccessPanel';
import {
  getNotificationPermission,
  isNotificationSupported,
  requestNotificationPermission,
  type NotificationPermissionState,
} from '../notifications/notificationManager';
import styles from './HostAdminModal.module.css';

export interface HostCommandSuggestion {
  commandId: string;
  label: string;
  pluginId?: string;
  description?: string;
}

export interface HostAdminModalProps {
  open: boolean;
  initialTab?: HostAdminTab;
  activeTab?: HostAdminTab;
  onTabChange?: (tab: HostAdminTab) => void;
  onClose: () => void;
  initialSelectedPluginId?: string | null;
  locale?: string;
  onPluginsChanged?: () => void;
  onWebSettingsUpdated?: (values: Record<string, unknown>) => void;
  onCommandExecuted?: (res: RunCommandResponse) => void;
  knownCommands?: HostCommandSuggestion[];
  channel?: string;
  permissionLevel?: string;
}

interface CommandHistoryEntry {
  id: string;
  commandId: string;
  pluginId?: string;
  ok: boolean;
  output: unknown;
  timestamp: string;
}

const COLOR_SWATCHES: Array<{ id: ColorTheme; hex: string }> = [
  { id: 'monochrome', hex: '#71717a' },
  { id: 'purple', hex: '#8b5cf6' },
  { id: 'blue', hex: '#3b82f6' },
  { id: 'green', hex: '#22c55e' },
  { id: 'amber', hex: '#eab308' },
  { id: 'red', hex: '#ef4444' },
];

const THEME_MODES: ThemePreference[] = ['system', 'dark', 'light'];
const DRAWER_SPEEDS: DrawerSpeed[] = ['fast', 'normal', 'smooth', 'off'];

function synthesizeSchemaFromValues(values: Record<string, unknown>, title: string): SettingsSchema {
  return {
    version: 1,
    title,
    fields: Object.entries(values).map(([key, val]) => ({
      key,
      type:
        typeof val === 'boolean'
          ? 'boolean'
          : typeof val === 'number'
            ? 'number'
            : Array.isArray(val)
              ? 'list'
              : 'string',
      label: key,
      default: val,
    })),
  };
}

export function HostAdminModal({
  open,
  initialTab = 'plugins',
  activeTab: controlledTab,
  onTabChange,
  onClose,
  initialSelectedPluginId = null,
  locale: localeProp,
  onPluginsChanged,
  onWebSettingsUpdated,
  onCommandExecuted,
  knownCommands,
  channel: channelProp,
  permissionLevel: permissionLevelProp,
}: HostAdminModalProps) {
  const { locale: ctxLocale, supportedLanguages, setLocale, t } = useI18n();
  const { preference, colorTheme, drawerSpeed, setTheme, setColorTheme, setDrawerSpeed } = useTheme();
  const locale = localeProp ?? ctxLocale;
  const [uncontrolledTab, setUncontrolledTab] = useState<HostAdminTab>(initialTab);
  const currentTab = controlledTab ?? uncontrolledTab;

  const setTab = useCallback(
    (next: HostAdminTab) => {
      if (controlledTab === undefined) {
        setUncontrolledTab(next);
      }
      onTabChange?.(next);
    },
    [controlledTab, onTabChange],
  );

  useEffect(() => {
    if (open && controlledTab === undefined) {
      setUncontrolledTab(initialTab);
    }
  }, [open, initialTab, controlledTab]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const defaultCommands = useMemo<HostCommandSuggestion[]>(
    () => [
      {
        commandId: 'agy-daddy.web.status',
        label: t('admin.cmd.statusLabel'),
        pluginId: 'agy-daddy.web',
        description: t('admin.cmd.statusDesc'),
      },
      {
        commandId: 'agy-daddy.context.rescan',
        label: t('admin.cmd.rescanLabel'),
        pluginId: 'agy-daddy.context',
        description: t('admin.cmd.rescanDesc'),
      },
      {
        commandId: 'agy-daddy.quota.refresh',
        label: t('admin.cmd.quotaLabel'),
        pluginId: 'agy-daddy.quota',
        description: t('admin.cmd.quotaDesc'),
      },
    ],
    [t],
  );

  const [plugins, setPlugins] = useState<HostPluginItem[]>([]);
  const [catalog, setCatalog] = useState<HostCatalogItem[]>([]);
  const [marketStats, setMarketStats] = useState<HostMarketStats | null>(null);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [pluginNotice, setPluginNotice] = useState<string | null>(null);
  const [pluginFilter, setPluginFilter] = useState('');
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [confirmUninstallId, setConfirmUninstallId] = useState<string | null>(null);
  const [confirmDisableWeb, setConfirmDisableWeb] = useState(false);
  const [pendingNativeUninstall, setPendingNativeUninstall] = useState<{
    id: string;
  } | null>(null);
  const [pendingPermissionInstall, setPendingPermissionInstall] = useState<{
    id: string;
    spec: string;
    permissions?: string[];
  } | null>(null);
  const [resolvedAccess, setResolvedAccess] = useState<{
    channel: string;
    permissionLevel: string;
  } | null>(null);

  const [showDesktopPlugins, setShowDesktopPlugins] = useState(false);
  const [hiddenDesktopCount, setHiddenDesktopCount] = useState(0);
  const [allPluginsCount, setAllPluginsCount] = useState(0);

  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(initialSelectedPluginId);
  const [settingsState, setSettingsState] = useState<PluginSettingsResponse | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [discoveredActions, setDiscoveredActions] = useState<HostCommandSuggestion[]>([]);

  const [appearanceNotice, setAppearanceNotice] = useState<string | null>(null);
  const [appearanceError, setAppearanceError] = useState<string | null>(null);
  const [appearanceSaving, setAppearanceSaving] = useState(false);
  const [webAccessRefreshToken, setWebAccessRefreshToken] = useState(0);
  const [notifPermission, setNotifPermission] = useState<NotificationPermissionState>(() =>
    getNotificationPermission(),
  );

  const [commandFilter, setCommandFilter] = useState('');
  const [cmdIdInput, setCmdIdInput] = useState('');
  const [cmdPluginInput, setCmdPluginInput] = useState('');
  const [cmdArgsInput, setCmdArgsInput] = useState('[]');
  const [cmdRunning, setCmdRunning] = useState(false);
  const [cmdError, setCmdError] = useState<string | null>(null);
  const [cmdHistory, setCmdHistory] = useState<CommandHistoryEntry[]>([]);

  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [doctorError, setDoctorError] = useState<string | null>(null);
  const [copiedDoctor, setCopiedDoctor] = useState(false);

  const loadPlugins = useCallback(async () => {
    setPluginsLoading(true);
    setPluginsError(null);
    try {
      const scope = showDesktopPlugins ? 'all' : 'web';
      const res = await getHostPlugins(scope);
      const nextPlugins = res.plugins || [];
      setPlugins(nextPlugins);
      setCatalog(res.catalog || []);
      setMarketStats(res.marketStats || null);
      setHiddenDesktopCount(typeof res.hiddenDesktopCount === 'number' ? res.hiddenDesktopCount : 0);
      setAllPluginsCount(
        typeof res.allPluginsCount === 'number' ? res.allPluginsCount : nextPlugins.length,
      );
      setSelectedPluginId((prev) => {
        if (prev && nextPlugins.some((p) => p.id === prev)) return prev;
        if (initialSelectedPluginId && nextPlugins.some((p) => p.id === initialSelectedPluginId)) {
          return initialSelectedPluginId;
        }
        return nextPlugins[0]?.id ?? null;
      });
    } catch (err) {
      setPluginsError(err instanceof Error ? err.message : t('errors.pluginsFailed'));
    } finally {
      setPluginsLoading(false);
    }
  }, [initialSelectedPluginId, showDesktopPlugins, t]);

  const loadPluginSettings = useCallback(
    async (pluginId: string) => {
      setSettingsLoading(true);
      setSettingsError(null);
      try {
        const scope = showDesktopPlugins ? 'all' : 'web';
        const res = await getPluginSettings(pluginId, scope);
        setSettingsState(res);
        if (res.schema?.actions && res.schema.actions.length > 0) {
          const added: HostCommandSuggestion[] = res.schema.actions.map((act) => ({
            commandId: act.commandId || act.id,
            label: localizeText(act.label, locale) || act.id,
            pluginId,
            description: localizeText(act.description, locale) || undefined,
          }));
          setDiscoveredActions((prev) => {
            const seen = new Set(prev.map((c) => c.commandId));
            const next = [...prev];
            for (const item of added) {
              if (!seen.has(item.commandId)) {
                seen.add(item.commandId);
                next.push(item);
              }
            }
            return next;
          });
        }
      } catch (err) {
        setSettingsError(err instanceof Error ? err.message : t('errors.settingsFailed'));
        setSettingsState(null);
      } finally {
        setSettingsLoading(false);
      }
    },
    [locale, showDesktopPlugins, t],
  );

  const loadDoctor = useCallback(async () => {
    setDoctorLoading(true);
    setDoctorError(null);
    try {
      const report = await getHostDoctor();
      setDoctorReport(report);
    } catch (err) {
      setDoctorError(err instanceof Error ? err.message : t('errors.doctorFailed'));
    } finally {
      setDoctorLoading(false);
    }
  }, [t]);

  const effectiveChannel = channelProp ?? resolvedAccess?.channel;
  const effectiveTier = permissionLevelProp ?? resolvedAccess?.permissionLevel;
  const isPermLocked = Boolean(
    effectiveChannel &&
      effectiveChannel !== 'loopback' &&
      effectiveTier &&
      effectiveTier !== 'L2',
  );

  useEffect(() => {
    if (!open) return;
    if (initialSelectedPluginId) {
      setSelectedPluginId(initialSelectedPluginId);
    }
  }, [open, initialSelectedPluginId]);

  useEffect(() => {
    if (!open || (channelProp !== undefined && permissionLevelProp !== undefined)) return;
    if (typeof apiClient.getWebAccessStatus !== 'function') return;
    let cancelled = false;
    void apiClient
      .getWebAccessStatus()
      .then((res) => {
        if (cancelled || !res) return;
        setResolvedAccess({
          channel: res.channel || 'loopback',
          permissionLevel: res.permissionLevel || 'L2',
        });
      })
      .catch(() => {
        // Ignore when web-access endpoint is unmocked or unavailable in unit tests
      });
    return () => {
      cancelled = true;
    };
  }, [open, channelProp, permissionLevelProp]);

  useEffect(() => {
    if (!open) return;
    if (currentTab === 'plugins') {
      void loadPlugins();
    } else if (currentTab === 'doctor') {
      void loadDoctor();
    }
  }, [open, currentTab, loadPlugins, loadDoctor]);

  useEffect(() => {
    if (!open || currentTab !== 'plugins' || !selectedPluginId) {
      return;
    }
    void loadPluginSettings(selectedPluginId);
  }, [open, currentTab, selectedPluginId, loadPluginSettings]);

  const handlePluginAction = async (
    pluginId: string,
    action: HostPluginAction,
    body: Record<string, unknown> = {},
  ) => {
    if (isPermLocked) {
      setPluginsError(t('admin.permLockedL0L1', { tier: effectiveTier || 'L1' }));
      return;
    }
    setBusyPluginId(pluginId);
    setPluginsError(null);
    setPluginNotice(null);
    try {
      const res = await runHostPluginAction(pluginId, action, body);
      if (res.needsPermissionConfirm) {
        setPendingPermissionInstall({
          id: pluginId,
          spec: String(body.spec || res.spec || pluginId),
          permissions: Array.isArray(res.trustPolicy?.requestedPermissions)
            ? (res.trustPolicy?.requestedPermissions as string[])
            : undefined,
        });
        return;
      }
      if (res.needsNativeUninstallConfirm) {
        setPendingNativeUninstall({ id: pluginId });
        return;
      }
      setPendingPermissionInstall(null);
      setPendingNativeUninstall(null);
      setConfirmDisableWeb(false);
      await loadPlugins();
      setPluginNotice(t('admin.actionDone', { id: pluginId, action }));
      onPluginsChanged?.();
    } catch (err) {
      setPluginsError(err instanceof Error ? err.message : t('admin.actionFailed', { action }));
    } finally {
      setBusyPluginId(null);
    }
  };

  const handleSavePluginSettings = async (patch: Record<string, unknown>) => {
    if (!selectedPluginId) return;
    const res = await savePluginSettings(selectedPluginId, patch);
    if (showDesktopPlugins || res.scope === 'web') {
      setSettingsState(res);
    } else {
      await loadPluginSettings(selectedPluginId);
    }
    if (selectedPluginId === 'agy-daddy.web') {
      setWebAccessRefreshToken((token) => token + 1);
      const nextTheme = normalizeThemePreference(patch.theme);
      if (nextTheme) setTheme(nextTheme);
      const nextColor = normalizeColorTheme(patch.colorTheme);
      if (nextColor) setColorTheme(nextColor);
      const nextSpeed = normalizeDrawerSpeed(patch.drawerSpeed);
      if (nextSpeed) setDrawerSpeed(nextSpeed);
      if (patch.enableNotifications === true) {
        void requestNotificationPermission().then((perm) => setNotifPermission(perm));
      } else {
        setNotifPermission(getNotificationPermission());
      }
      onWebSettingsUpdated?.(res?.values ?? patch);
    }
    onPluginsChanged?.();
    return res;
  };

  const persistAppearancePatch = async (patch: Record<string, unknown>) => {
    setAppearanceNotice(null);
    setAppearanceError(null);
    setAppearanceSaving(true);
    try {
      await savePluginSettings('agy-daddy.web', patch);
      setAppearanceNotice(t('theme.savedToHost'));
      onPluginsChanged?.();
    } catch (err) {
      setAppearanceError(err instanceof Error ? err.message : t('schema.saveFailed'));
    } finally {
      setAppearanceSaving(false);
    }
  };

  const handleRunSchemaAction = async (action: SettingsSchemaAction) => {
    if (!selectedPluginId) return;
    const cmdId = action.commandId || action.id;
    const res = await runHostCommand(cmdId, { pluginId: selectedPluginId, args: [] });
    onCommandExecuted?.(res);
  };

  const executeCommand = async (cmdId: string, pluginId?: string, args: unknown[] = []) => {
    const cleanCmd = cmdId.trim();
    if (!cleanCmd) {
      setCmdError(t('admin.cmd.idRequired'));
      return;
    }
    setCmdRunning(true);
    setCmdError(null);
    try {
      const res = await runHostCommand(cleanCmd, {
        pluginId: pluginId?.trim() || undefined,
        args,
      });
      setCmdHistory((prev) => [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          commandId: cleanCmd,
          pluginId: pluginId?.trim() || undefined,
          ok: res.ok !== false,
          output: res.result ?? res,
          timestamp: new Date().toLocaleTimeString(),
        },
        ...prev,
      ]);
      onCommandExecuted?.(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('admin.cmd.execFailed');
      setCmdError(message);
      setCmdHistory((prev) => [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          commandId: cleanCmd,
          pluginId: pluginId?.trim() || undefined,
          ok: false,
          output: { error: message },
          timestamp: new Date().toLocaleTimeString(),
        },
        ...prev,
      ]);
    } finally {
      setCmdRunning(false);
    }
  };

  const handleCommandFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    let parsedArgs: unknown[] = [];
    const rawArgs = cmdArgsInput.trim();
    if (rawArgs) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (!Array.isArray(parsed)) {
          setCmdError(t('admin.cmd.argsInvalid'));
          return;
        }
        parsedArgs = parsed;
      } catch {
        setCmdError(t('admin.cmd.argsInvalid'));
        return;
      }
    }
    void executeCommand(cmdIdInput, cmdPluginInput, parsedArgs);
  };

  const filteredPlugins = useMemo(() => {
    const q = pluginFilter.trim().toLowerCase();
    if (!q) return plugins;
    return plugins.filter(
      (p) =>
        p.id.toLowerCase().includes(q) ||
        (p.displayName || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q),
    );
  }, [plugins, pluginFilter]);

  const filteredCatalog = useMemo(() => {
    const q = pluginFilter.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter(
      (c) =>
        c.id.toLowerCase().includes(q) ||
        (c.displayName || '').toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q),
    );
  }, [catalog, pluginFilter]);

  const selectedPlugin = useMemo(
    () => plugins.find((p) => p.id === selectedPluginId) ?? null,
    [plugins, selectedPluginId],
  );

  const effectiveSchema = useMemo<SettingsSchema | null>(() => {
    if (!selectedPlugin) return null;
    if (settingsState?.schema) return settingsState.schema;
    if (settingsState?.values && Object.keys(settingsState.values).length > 0) {
      return synthesizeSchemaFromValues(
        settingsState.values,
        selectedPlugin.displayName || selectedPlugin.id,
      );
    }
    return null;
  }, [selectedPlugin, settingsState]);

  const allCommandSuggestions = useMemo(() => {
    const base = knownCommands && knownCommands.length > 0 ? knownCommands : defaultCommands;
    const seen = new Set<string>();
    const combined: HostCommandSuggestion[] = [];
    for (const item of [...base, ...discoveredActions]) {
      if (!seen.has(item.commandId)) {
        seen.add(item.commandId);
        combined.push(item);
      }
    }
    const q = commandFilter.trim().toLowerCase();
    if (!q) return combined;
    return combined.filter(
      (c) =>
        c.commandId.toLowerCase().includes(q) ||
        c.label.toLowerCase().includes(q) ||
        (c.pluginId || '').toLowerCase().includes(q),
    );
  }, [knownCommands, defaultCommands, discoveredActions, commandFilter]);

  if (!open) return null;

  return (
    <div
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="host-admin-modal-title"
      data-testid="host-admin-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <h2 id="host-admin-modal-title" className={styles.title}>
              {t('admin.title')}
            </h2>
            <div className={styles.tabs} role="tablist" aria-label={t('admin.tabsAria')}>
              <button
                type="button"
                role="tab"
                aria-selected={currentTab === 'plugins'}
                className={`${styles.tabBtn} ${currentTab === 'plugins' ? styles.tabBtnActive : ''}`.trim()}
                onClick={() => setTab('plugins')}
              >
                {t('admin.tab.plugins')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={currentTab === 'appearance'}
                className={`${styles.tabBtn} ${currentTab === 'appearance' ? styles.tabBtnActive : ''}`.trim()}
                onClick={() => setTab('appearance')}
                data-testid="admin-tab-appearance"
              >
                {t('admin.tab.appearance')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={currentTab === 'commands'}
                className={`${styles.tabBtn} ${currentTab === 'commands' ? styles.tabBtnActive : ''}`.trim()}
                onClick={() => setTab('commands')}
              >
                {t('admin.tab.commands')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={currentTab === 'doctor'}
                className={`${styles.tabBtn} ${currentTab === 'doctor' ? styles.tabBtnActive : ''}`.trim()}
                onClick={() => setTab('doctor')}
              >
                {t('admin.tab.doctor')}
              </button>
            </div>
          </div>

          <button
            type="button"
            className={styles.closeBtn}
            aria-label={t('admin.close')}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className={styles.body}>
          {currentTab === 'plugins' && (
            <>
              {isPermLocked && (
                <div
                  className={styles.bannerError}
                  role="alert"
                  data-testid="host-admin-perm-locked"
                >
                  {t('admin.permLockedL0L1', { tier: effectiveTier || 'L1' })}
                </div>
              )}
              {pluginsError && (
                <div className={styles.bannerError} role="alert">
                  {pluginsError}
                </div>
              )}
              {confirmDisableWeb && (
                <div
                  className={styles.bannerInfo}
                  role="alertdialog"
                  data-testid="host-admin-disable-web-confirm"
                >
                  <span>
                    <strong>{t('menu.disableWebTitle')}</strong> {t('menu.disableWebConfirm')}
                  </span>
                  <div className={styles.pluginActions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnDanger}`}
                      onClick={() => void handlePluginAction('agy-daddy.web', 'disable')}
                    >
                      {t('menu.disableWebAction')}
                    </button>
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() => setConfirmDisableWeb(false)}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}
              {pendingNativeUninstall && (
                <div
                  className={styles.bannerInfo}
                  role="alertdialog"
                  data-testid="host-admin-native-uninstall-confirm"
                >
                  <span>{t('admin.confirmNativeUninstall')}</span>
                  <div className={styles.pluginActions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnDanger}`}
                      onClick={() =>
                        void handlePluginAction(pendingNativeUninstall.id, 'uninstall', {
                          confirmed: true,
                          removeNativeExtensions: true,
                        })
                      }
                    >
                      {t('admin.confirmNativeUninstallYes')}
                    </button>
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() =>
                        void handlePluginAction(pendingNativeUninstall.id, 'uninstall', {
                          confirmed: true,
                          removeNativeExtensions: false,
                        })
                      }
                    >
                      {t('admin.confirmNativeUninstallNo')}
                    </button>
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() => setPendingNativeUninstall(null)}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}
              {pluginNotice && (
                <div className={styles.bannerInfo} role="status">
                  <span>{pluginNotice}</span>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => setPluginNotice(null)}
                  >
                    {t('admin.collapseNotice')}
                  </button>
                </div>
              )}
              {pendingPermissionInstall && (
                <div className={styles.bannerInfo} role="alert">
                  <span>
                    {t('admin.permissionRequest', {
                      id: pendingPermissionInstall.id,
                      perms: pendingPermissionInstall.permissions?.join(', ') || t('admin.permissionDefault'),
                    })}
                  </span>
                  <div className={styles.pluginActions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={() =>
                        void handlePluginAction(pendingPermissionInstall.id, 'install', {
                          spec: pendingPermissionInstall.spec,
                          confirmed: true,
                          approvePermissions: true,
                        })
                      }
                    >
                      {t('admin.approveInstall')}
                    </button>
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() => setPendingPermissionInstall(null)}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}

              <div
                className={styles.scopeBar}
                data-testid="web-plugin-scope-bar"
                data-hidden-count={hiddenDesktopCount}
                data-all-count={allPluginsCount}
              >
                <span className={styles.scopeNotice}>
                  {t('admin.webScopeNotice', { hidden: hiddenDesktopCount })}
                </span>
                <label className={styles.scopeToggleLabel}>
                  <input
                    type="checkbox"
                    className={styles.scopeCheckbox}
                    data-testid="toggle-desktop-plugins"
                    checked={showDesktopPlugins}
                    onChange={(e) => setShowDesktopPlugins(e.target.checked)}
                  />
                  <span>{t('admin.showDesktopPlugins')}</span>
                </label>
              </div>

              <div className={styles.pluginsLayout}>
                <div className={styles.pluginsSidebar}>
                  <div className={styles.sidebarToolbar}>
                    <div className={styles.statsRow}>
                      <span>
                        {t('admin.installedSummary', {
                          installed: marketStats?.installed ?? plugins.length,
                          active: marketStats?.active ?? plugins.filter((p) => p.active).length,
                        })}
                      </span>
                      <button
                        type="button"
                        className={styles.btn}
                        disabled={pluginsLoading}
                        onClick={() => void loadPlugins()}
                      >
                        {pluginsLoading ? t('common.refreshing') : t('common.refresh')}
                      </button>
                    </div>
                    <input
                      type="search"
                      className={styles.searchInput}
                      placeholder={t('admin.pluginsFilterPlaceholder')}
                      value={pluginFilter}
                      onChange={(e) => setPluginFilter(e.target.value)}
                    />
                  </div>

                  <div className={styles.pluginsList}>
                    {pluginsLoading && plugins.length === 0 ? (
                      <div className={styles.emptyState}>{t('admin.loadingPlugins')}</div>
                    ) : filteredPlugins.length === 0 ? (
                      <div className={styles.emptyState}>{t('admin.noMatchingPlugins')}</div>
                    ) : (
                      filteredPlugins.map((p) => {
                        const isSelected = p.id === selectedPluginId;
                        const isBusy = busyPluginId === p.id;
                        const confirmingUninstall = confirmUninstallId === p.id;
                        return (
                          <div
                            key={p.id}
                            className={`${styles.pluginCard} ${isSelected ? styles.pluginCardSelected : ''}`.trim()}
                            onClick={() => setSelectedPluginId(p.id)}
                          >
                            <div className={styles.pluginTop}>
                              <div className={styles.pluginTitleRow}>
                                <span className={styles.pluginName}>{p.displayName || p.id}</span>
                                <span className={styles.badge}>v{p.version}</span>
                                <span className={`${styles.badge} ${styles.badgeAccent}`}>
                                  {p.trustLevel}
                                </span>
                                <span
                                  className={`${styles.badge} ${
                                    p.enabled
                                      ? p.active
                                        ? styles.badgeActive
                                        : ''
                                      : styles.badgeDisabled
                                  }`.trim()}
                                >
                                  {!p.enabled
                                    ? t('admin.disabled')
                                    : p.active
                                      ? t('admin.active')
                                      : t('admin.inactive')}
                                </span>
                                {showDesktopPlugins && p.webRelevant === false && (
                                  <span
                                    className={styles.badgeDesktopOnly}
                                    data-testid={`desktop-only-badge-${p.id}`}
                                  >
                                    {t('admin.desktopOnlyBadge')}
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className={styles.pluginMeta}>
                              {p.id}
                              {p.world ? ` · ${p.world}` : ''}
                              {p.description ? ` · ${p.description}` : ''}
                            </div>

                            <div
                              className={styles.pluginActions}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                className={styles.btn}
                                disabled={isBusy || isPermLocked}
                                onClick={() => {
                                  if (p.id === 'agy-daddy.web' && p.enabled) {
                                    setConfirmDisableWeb(true);
                                    return;
                                  }
                                  void handlePluginAction(p.id, p.enabled ? 'disable' : 'enable');
                                }}
                              >
                                {p.enabled ? t('admin.disable') : t('admin.enable')}
                              </button>

                              {p.hasRollback && (
                                <button
                                  type="button"
                                  className={styles.btn}
                                  disabled={isBusy || isPermLocked}
                                  onClick={() => void handlePluginAction(p.id, 'rollback')}
                                >
                                  {t('admin.rollback')}
                                </button>
                              )}

                              {p.sourceKind !== 'memory' && (
                                <button
                                  type="button"
                                  className={`${styles.btn} ${confirmingUninstall ? styles.btnDanger : ''}`.trim()}
                                  disabled={isBusy || isPermLocked}
                                  onClick={() => {
                                    if (!confirmingUninstall) {
                                      setConfirmUninstallId(p.id);
                                      return;
                                    }
                                    setConfirmUninstallId(null);
                                    void handlePluginAction(p.id, 'uninstall');
                                  }}
                                >
                                  {confirmingUninstall ? t('admin.confirmUninstall') : t('admin.uninstall')}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}

                    {filteredCatalog.length > 0 && (
                      <>
                        <div className={styles.sectionLabel}>
                          {t('admin.catalogTitle', { count: filteredCatalog.length })}
                        </div>
                        {filteredCatalog.map((cat) => (
                          <div key={cat.id} className={styles.pluginCard}>
                            <div className={styles.pluginTop}>
                              <div className={styles.pluginTitleRow}>
                                <span className={styles.pluginName}>
                                  {cat.displayName || cat.id}
                                </span>
                                <span className={styles.badge}>v{cat.version}</span>
                                <span className={`${styles.badge} ${styles.badgeAccent}`}>
                                  {cat.trustLevel}
                                </span>
                                {showDesktopPlugins && cat.webRelevant === false && (
                                  <span className={styles.badgeDesktopOnly}>
                                    {t('admin.desktopOnlyBadge')}
                                  </span>
                                )}
                              </div>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnPrimary}`}
                                disabled={busyPluginId === cat.id || isPermLocked}
                                onClick={() =>
                                  void handlePluginAction(cat.id, 'install', {
                                    spec: cat.recommendedSpec,
                                  })
                                }
                              >
                                {busyPluginId === cat.id ? t('admin.installing') : `+ ${t('admin.install')}`}
                              </button>
                            </div>
                            <div className={styles.pluginMeta}>
                              {cat.id} · {cat.description || cat.recommendedSpec}
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </div>

                <div className={styles.pluginDetail}>
                  {!selectedPlugin ? (
                    <div className={styles.emptyState}>{t('admin.selectPluginPrompt')}</div>
                  ) : (
                    <>
                      <div className={styles.detailHeader}>
                        <h3 className={styles.detailTitle}>
                          {selectedPlugin.displayName || selectedPlugin.id}
                        </h3>
                        <div className={styles.detailMetaGrid}>
                          <span>ID: {selectedPlugin.id}</span>
                          <span>v{selectedPlugin.version}</span>
                          <span>{selectedPlugin.trustLevel}</span>
                          <span>{selectedPlugin.world}</span>
                          <span>{selectedPlugin.sourceKind}</span>
                          {selectedPlugin.permissions.length > 0 && (
                            <span>{selectedPlugin.permissions.join(', ')}</span>
                          )}
                        </div>
                      </div>

                      {settingsLoading ? (
                        <div className={styles.emptyState}>{t('admin.loadingSettings')}</div>
                      ) : settingsError ? (
                        <div className={styles.bannerError} role="alert">
                          {settingsError}
                        </div>
                      ) : (
                        <>
                          {typeof settingsState?.filteredDesktopFieldCount === 'number' &&
                            settingsState.filteredDesktopFieldCount > 0 && (
                              <div
                                className={styles.desktopFieldsNotice}
                                data-testid="desktop-fields-hidden-notice"
                                role="status"
                              >
                                {t('admin.desktopFieldsHidden', {
                                  count: settingsState.filteredDesktopFieldCount,
                                })}
                              </div>
                            )}
                          {effectiveSchema &&
                          ((effectiveSchema.fields && effectiveSchema.fields.length > 0) ||
                            (effectiveSchema.actions && effectiveSchema.actions.length > 0)) ? (
                            <>
                              {selectedPlugin.id === 'agy-daddy.web' && (
                                <WebAccessPanel refreshToken={webAccessRefreshToken} />
                              )}
                              {selectedPlugin.id === 'agy-daddy.web' &&
                                Boolean(settingsState?.values?.enableNotifications) && (
                                  <div
                                    className={styles.bannerInfo}
                                    role="status"
                                    data-testid="host-admin-notification-status"
                                  >
                                    <span>
                                      {!isNotificationSupported()
                                        ? t('notifications.unsupportedHint')
                                        : notifPermission === 'granted'
                                          ? t('notifications.permissionGrantedHint')
                                          : notifPermission === 'denied'
                                            ? t('notifications.permissionDeniedHint')
                                            : t('notifications.permissionPromptTitle')}
                                    </span>
                                    {isNotificationSupported() && notifPermission === 'default' && (
                                      <button
                                        type="button"
                                        className={`${styles.btn} ${styles.btnPrimary}`}
                                        data-testid="host-admin-notification-grant-btn"
                                        onClick={() => {
                                          void requestNotificationPermission().then((perm) =>
                                            setNotifPermission(perm),
                                          );
                                        }}
                                      >
                                        {t('notifications.permissionGrantBtn')}
                                      </button>
                                    )}
                                  </div>
                                )}
                              <SchemaSettingsForm
                                pluginId={selectedPlugin.id}
                                schema={effectiveSchema}
                                values={settingsState?.values || {}}
                                secretState={settingsState?.secretState}
                                locale={locale}
                                readOnly={isPermLocked}
                                onSave={handleSavePluginSettings}
                                onRunAction={handleRunSchemaAction}
                              />
                            </>
                          ) : (
                            <div className={styles.emptyState}>{t('admin.noSchemaSettings')}</div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}

          {currentTab === 'appearance' && (
            <div className={styles.appearanceWrap} data-testid="host-appearance-panel">
              <div className={styles.detailHeader}>
                <h3 className={styles.detailTitle}>{t('theme.appearanceTitle')}</h3>
                <p className={styles.summary}>{t('theme.appearanceDesc')}</p>
              </div>

              {appearanceError && (
                <div className={styles.bannerError} role="alert">
                  {appearanceError}
                </div>
              )}
              {appearanceNotice && (
                <div className={styles.bannerInfo} role="status">
                  <span>{appearanceNotice}</span>
                </div>
              )}

              <div className={styles.appearanceSection}>
                <span className={styles.appearanceLabel}>{t('theme.colorThemeLabel')}</span>
                <div className={styles.choiceGrid}>
                  {COLOR_SWATCHES.map((swatch) => {
                    const active = colorTheme === swatch.id;
                    return (
                      <button
                        key={swatch.id}
                        type="button"
                        disabled={appearanceSaving}
                        className={`${styles.choiceBtn} ${active ? styles.choiceBtnActive : ''}`}
                        onClick={() => {
                          setColorTheme(swatch.id);
                          void persistAppearancePatch({ colorTheme: swatch.id });
                        }}
                        data-testid={`color-theme-${swatch.id}`}
                        aria-pressed={active}
                      >
                        <span
                          className={styles.colorSwatch}
                          style={{ background: swatch.hex }}
                          aria-hidden="true"
                        />
                        <span>{t(`theme.color.${swatch.id}`)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={styles.appearanceSection}>
                <span className={styles.appearanceLabel}>{t('theme.modeLabel')}</span>
                <div className={styles.choiceGrid}>
                  {THEME_MODES.map((mode) => {
                    const active = preference === mode;
                    return (
                      <button
                        key={mode}
                        type="button"
                        disabled={appearanceSaving}
                        className={`${styles.choiceBtn} ${active ? styles.choiceBtnActive : ''}`}
                        onClick={() => {
                          setTheme(mode);
                          void persistAppearancePatch({ theme: mode });
                        }}
                        data-testid={`theme-mode-${mode}`}
                        aria-pressed={active}
                      >
                        <span>{t(`theme.${mode}`)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={styles.appearanceSection}>
                <span className={styles.appearanceLabel}>{t('theme.drawerSpeedLabel')}</span>
                <div className={styles.choiceGrid}>
                  {DRAWER_SPEEDS.map((spd) => {
                    const active = drawerSpeed === spd;
                    return (
                      <button
                        key={spd}
                        type="button"
                        disabled={appearanceSaving}
                        className={`${styles.choiceBtn} ${active ? styles.choiceBtnActive : ''}`}
                        onClick={() => {
                          setDrawerSpeed(spd);
                          void persistAppearancePatch({ drawerSpeed: spd });
                        }}
                        data-testid={`drawer-speed-${spd}`}
                        aria-pressed={active}
                      >
                        <span>{t(`theme.speed.${spd}`)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className={styles.appearanceSection}>
                <span className={styles.appearanceLabel}>{t('lang.label')}</span>
                <div className={styles.localeRow}>
                  <select
                    className={styles.localeSelect}
                    value={locale}
                    onChange={(e) => {
                      setLocale(normalizeLocale(e.target.value) || 'en');
                    }}
                    aria-label={t('lang.selectAria')}
                    data-testid="appearance-locale-select"
                  >
                    {supportedLanguages.map((lang) => (
                      <option key={lang.bcp47} value={lang.bcp47}>
                        {lang.nativeName || lang.shortLabel || lang.bcp47}
                      </option>
                    ))}
                  </select>
                  <span className={styles.localeHint}>{t('lang.syncedWithHost')}</span>
                </div>
              </div>
            </div>
          )}

          {currentTab === 'commands' && (
            <div className={styles.tabPane}>
              <form className={styles.commandForm} onSubmit={handleCommandFormSubmit}>
                <div className={styles.fieldCol}>
                  <label htmlFor="host-cmd-id" className={styles.fieldColLabel}>
                    {t('admin.cmd.idLabel')}
                  </label>
                  <input
                    id="host-cmd-id"
                    type="text"
                    className={styles.searchInput}
                    placeholder={t('admin.cmd.idPlaceholder')}
                    value={cmdIdInput}
                    onChange={(e) => setCmdIdInput(e.target.value)}
                  />
                </div>
                <div className={styles.fieldCol}>
                  <label htmlFor="host-cmd-plugin" className={styles.fieldColLabel}>
                    {t('admin.cmd.pluginLabel')}
                  </label>
                  <input
                    id="host-cmd-plugin"
                    type="text"
                    className={styles.searchInput}
                    placeholder={t('admin.cmd.pluginPlaceholder')}
                    value={cmdPluginInput}
                    onChange={(e) => setCmdPluginInput(e.target.value)}
                  />
                </div>
                <div className={styles.fieldCol}>
                  <label htmlFor="host-cmd-args" className={styles.fieldColLabel}>
                    {t('admin.cmd.argsLabel')}
                  </label>
                  <input
                    id="host-cmd-args"
                    type="text"
                    className={styles.searchInput}
                    placeholder="[]"
                    value={cmdArgsInput}
                    onChange={(e) => setCmdArgsInput(e.target.value)}
                  />
                </div>
                <button
                  type="submit"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={cmdRunning}
                >
                  {cmdRunning ? t('admin.cmd.running') : t('admin.cmd.run')}
                </button>
              </form>

              {cmdError && (
                <div className={styles.bannerError} role="alert">
                  {cmdError}
                </div>
              )}

              <div className={styles.fieldCol}>
                <input
                  type="search"
                  className={styles.searchInput}
                  placeholder={t('admin.cmd.filterPlaceholder')}
                  value={commandFilter}
                  onChange={(e) => setCommandFilter(e.target.value)}
                />
              </div>

              <div className={styles.suggestionsGrid}>
                {allCommandSuggestions.map((item) => (
                  <button
                    key={item.commandId}
                    type="button"
                    className={styles.suggestionCard}
                    disabled={cmdRunning}
                    onClick={() => {
                      setCmdIdInput(item.commandId);
                      setCmdPluginInput(item.pluginId || '');
                      void executeCommand(item.commandId, item.pluginId, []);
                    }}
                  >
                    <span className={styles.suggestionId}>{item.commandId}</span>
                    <span className={styles.pluginName}>{item.label}</span>
                    {item.description && (
                      <span className={styles.suggestionDesc}>{item.description}</span>
                    )}
                  </button>
                ))}
              </div>

              {cmdHistory.length > 0 && (
                <div className={styles.historyList}>
                  <div className={styles.sectionLabel}>{t('admin.cmd.historyTitle')}</div>
                  {cmdHistory.map((entry) => (
                    <div key={entry.id} className={styles.historyItem}>
                      <div className={styles.historyHead}>
                        <span className={styles.suggestionId}>
                          {entry.commandId}
                          {entry.pluginId ? ` (${entry.pluginId})` : ''}
                        </span>
                        <span>
                          <span
                            className={`${styles.badge} ${
                              entry.ok ? styles.badgeActive : styles.btnDanger
                            }`.trim()}
                          >
                            {entry.ok ? t('admin.cmd.success') : t('admin.cmd.failed')}
                          </span>{' '}
                          {entry.timestamp}
                        </span>
                      </div>
                      <pre className={styles.codeBlock}>
                        {JSON.stringify(entry.output, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {currentTab === 'doctor' && (
            <div className={styles.tabPane}>
              <div className={styles.doctorTop}>
                <div>
                  <span
                    className={`${styles.badge} ${
                      doctorReport?.ok ? styles.badgeActive : styles.btnDanger
                    }`.trim()}
                  >
                    {doctorLoading
                      ? t('admin.doctor.checking')
                      : doctorReport?.ok
                        ? t('admin.doctor.healthy')
                        : doctorReport
                          ? t('admin.doctor.unhealthy')
                          : t('admin.doctor.pending')}
                  </span>{' '}
                  {doctorReport && (
                    <span className={styles.pluginMeta}>
                      Host API {doctorReport.hostApiVersion} · {doctorReport.platform}/
                      {doctorReport.arch} · {doctorReport.generatedAt}
                    </span>
                  )}
                </div>
                <div className={styles.pluginActions}>
                  {doctorReport && (
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() => {
                        void navigator.clipboard?.writeText(JSON.stringify(doctorReport, null, 2));
                        setCopiedDoctor(true);
                        setTimeout(() => setCopiedDoctor(false), 1800);
                      }}
                    >
                      {copiedDoctor ? t('admin.doctor.copied') : t('admin.doctor.copy')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={doctorLoading}
                    onClick={() => void loadDoctor()}
                  >
                    {doctorLoading ? t('admin.doctor.checking') : t('admin.doctor.rerun')}
                  </button>
                </div>
              </div>

              {doctorError && (
                <div className={styles.bannerError} role="alert">
                  {doctorError}
                </div>
              )}

              {doctorReport && (
                <>
                  <div className={styles.doctorGrid}>
                    <div className={styles.doctorCard}>
                      <h4 className={styles.doctorCardTitle}>Antigravity RPC & CDP</h4>
                      <div className={styles.kvList}>
                        <div className={styles.kvRow}>
                          <span className={styles.kvKey}>{t('admin.doctor.cdpPort')}</span>
                          <span className={styles.kvVal}>
                            {doctorReport.antigravity?.cdpPort ?? 'N/A'}
                          </span>
                        </div>
                        <div className={styles.kvRow}>
                          <span className={styles.kvKey}>{t('admin.doctor.cdpTargets')}</span>
                          <span className={styles.kvVal}>
                            {doctorReport.antigravity?.cdpTargetsCount ?? 0}
                          </span>
                        </div>
                        <div className={styles.kvRow}>
                          <span className={styles.kvKey}>{t('admin.doctor.anchorsCount')}</span>
                          <span className={styles.kvVal}>
                            {doctorReport.anchors?.count ?? 0} (v
                            {doctorReport.anchors?.schemaVersion ?? '?'})
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className={styles.doctorCard}>
                      <h4 className={styles.doctorCardTitle}>{t('admin.doctor.daemonCard')}</h4>
                      <div className={styles.kvList}>
                        <div className={styles.kvRow}>
                          <span className={styles.kvKey}>{t('admin.doctor.daemonLock')}</span>
                          <span className={styles.kvVal}>
                            {doctorReport.daemon?.lockPresent
                              ? t('admin.doctor.lockHeld')
                              : t('admin.doctor.lockFree')}
                          </span>
                        </div>
                        <div className={styles.kvRow}>
                          <span className={styles.kvKey}>{t('admin.doctor.stateDir')}</span>
                          <span className={styles.kvVal}>{doctorReport.paths?.stateDir || '-'}</span>
                        </div>
                        <div className={styles.kvRow}>
                          <span className={styles.kvKey}>{t('admin.doctor.pluginsDir')}</span>
                          <span className={styles.kvVal}>
                            {doctorReport.paths?.pluginsDir || '-'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {doctorReport.plugins?.items && (
                    <div className={styles.doctorCard}>
                      <h4 className={styles.doctorCardTitle}>
                        {t('admin.doctor.registeredPlugins', { count: doctorReport.plugins.count })}
                      </h4>
                      <div className={styles.kvList}>
                        {doctorReport.plugins.items.map((item) => (
                          <div key={item.id} className={styles.kvRow}>
                            <span className={styles.kvKey}>
                              {item.id} (v{item.version})
                            </span>
                            <span className={styles.kvVal}>
                              {item.trustLevel} · {item.enabled ? t('admin.enabled') : t('admin.disabled')} ·{' '}
                              {item.world}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <details className={styles.doctorCard}>
                    <summary className={styles.doctorCardTitle}>{t('admin.doctor.rawJson')}</summary>
                    <pre className={styles.codeBlock}>{JSON.stringify(doctorReport, null, 2)}</pre>
                  </details>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
