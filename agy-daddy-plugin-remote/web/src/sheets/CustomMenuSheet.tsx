import { useEffect, useState } from 'preact/hooks';
import { SUPPORTED_LANGUAGES, useI18n } from '../i18n';
import { BottomSheet } from '../layout/BottomSheet';
import { api } from '../store/api';
import type {
  AppearanceMode,
  ColorThemeId,
  DiagnosticsResponse,
  DrawerSpeedId,
  PermissionLevel,
  SafeCommandItem,
  SupportedLocale
} from '../types';
import styles from './SheetCommon.module.css';

export interface CustomMenuSheetProps {
  open: boolean;
  channel: string;
  permissionLevel: PermissionLevel;
  runningTasksCount: number;
  appearance: AppearanceMode;
  colorTheme: ColorThemeId;
  drawerSpeed: DrawerSpeedId;
  soundAlert: boolean;
  vibrateAlert: boolean;
  pushSubscribed: boolean;
  pushBusy: boolean;
  onSetAppearance: (next: AppearanceMode) => void;
  onSetColorTheme: (next: ColorThemeId) => void;
  onSetDrawerSpeed: (next: DrawerSpeedId) => void;
  onSetLocale: (next: SupportedLocale) => void;
  onToggleSound: () => void;
  onToggleVibrate: () => void;
  onTogglePush: () => void;
  onTestPush: () => void;
  onOpenChannels: () => void;
  onOpenTasks: () => void;
  onShowToast: (msg: string) => void;
  onClose: () => void;
}

const COLOR_THEMES: Array<{ id: ColorThemeId; swatchCls: string }> = [
  { id: 'monochrome', swatchCls: styles.swatchMonochrome },
  { id: 'purple', swatchCls: styles.swatchPurple },
  { id: 'blue', swatchCls: styles.swatchBlue },
  { id: 'green', swatchCls: styles.swatchGreen },
  { id: 'amber', swatchCls: styles.swatchAmber },
  { id: 'red', swatchCls: styles.swatchRed }
];

const DRAWER_SPEEDS: DrawerSpeedId[] = ['fast', 'normal', 'slow', 'off'];

export function CustomMenuSheet({
  open,
  channel,
  permissionLevel,
  runningTasksCount,
  appearance,
  colorTheme,
  drawerSpeed,
  soundAlert,
  vibrateAlert,
  pushSubscribed,
  pushBusy,
  onSetAppearance,
  onSetColorTheme,
  onSetDrawerSpeed,
  onSetLocale,
  onToggleSound,
  onToggleVibrate,
  onTogglePush,
  onTestPush,
  onOpenChannels,
  onOpenTasks,
  onShowToast,
  onClose
}: CustomMenuSheetProps) {
  const { locale, setLocale, t } = useI18n();
  const [diagOpen, setDiagOpen] = useState(false);
  const [diag, setDiag] = useState<DiagnosticsResponse | null>(null);
  const [commands, setCommands] = useState<SafeCommandItem[]>([]);
  const [runningCmdId, setRunningCmdId] = useState('');

  useEffect(() => {
    if (!open || !diagOpen) return;
    let canceled = false;
    Promise.all([
      api.getDiagnostics().catch(() => null),
      api.listCommands().catch(() => null)
    ]).then(([dRes, cRes]) => {
      if (canceled) return;
      if (dRes) setDiag(dRes);
      if (cRes?.commands) setCommands(cRes.commands);
    });
    return () => {
      canceled = true;
    };
  }, [open, diagOpen]);

  const handleRunCmd = async (cmdId: string) => {
    if (runningCmdId) return;
    setRunningCmdId(cmdId);
    try {
      await api.runCommand(cmdId);
      onShowToast(`${cmdId} ✓`);
      const dRes = await api.getDiagnostics().catch(() => null);
      if (dRes) setDiag(dRes);
    } catch (err) {
      onShowToast((err as Error).message);
    } finally {
      setRunningCmdId('');
    }
  };

  return (
    <BottomSheet
      open={open}
      title={t('menu.title')}
      subtitle={`${channel} · ${permissionLevel}`}
      testId="custom-menu-sheet"
      onClose={onClose}
    >
      <div className={styles.content}>
        {/* Quick Navigation */}
        <div className={styles.card}>
          <button
            type="button"
            className={styles.rowBtn}
            onClick={() => {
              onClose();
              onOpenChannels();
            }}
            data-testid="menu-open-channels-btn"
          >
            <span>{t('menu.channelsEntry')}</span>
            <span className="ag-chip">{channel}</span>
          </button>

          <button
            type="button"
            className={styles.rowBtn}
            onClick={() => {
              onClose();
              onOpenTasks();
            }}
            data-testid="menu-open-tasks-btn"
          >
            <span>{t('menu.tasksEntry')}</span>
            <span className="ag-chip" data-tone={runningTasksCount > 0 ? 'accent' : undefined}>
              {runningTasksCount}
            </span>
          </button>
        </div>

        {/* Appearance & Theme */}
        <div className={styles.card}>
          <span className={styles.sectionTitle}>{t('menu.appearance')}</span>
          <div className={styles.segmented}>
            {(
              [
                { id: 'auto', label: t('menu.appearanceAuto') },
                { id: 'dark', label: t('menu.appearanceDark') },
                { id: 'light', label: t('menu.appearanceLight') }
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                className={`${styles.segBtn} ${appearance === item.id ? styles.segBtnActive : ''}`}
                data-testid={`appearance-${item.id}`}
                onClick={() => onSetAppearance(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <span className={styles.sectionTitle}>{t('menu.colorTheme')}</span>
          <div className={styles.colorGrid}>
            {COLOR_THEMES.map((ct) => (
              <button
                key={ct.id}
                type="button"
                className={`${styles.colorPill} ${colorTheme === ct.id ? styles.colorPillActive : ''}`}
                data-testid={`color-theme-${ct.id}`}
                onClick={() => onSetColorTheme(ct.id)}
              >
                <span className={`${styles.swatch} ${ct.swatchCls}`} aria-hidden="true" />
                <span>{t(`menu.color.${ct.id}`)}</span>
              </button>
            ))}
          </div>

          <span className={styles.sectionTitle}>{t('menu.drawerSpeed')}</span>
          <div className={styles.choiceWrap}>
            {DRAWER_SPEEDS.map((sp) => (
              <button
                key={sp}
                type="button"
                className={`${styles.choiceBtn} ${drawerSpeed === sp ? styles.choiceBtnActive : ''}`}
                data-testid={`drawer-speed-${sp}`}
                onClick={() => onSetDrawerSpeed(sp)}
              >
                {t(`menu.speed.${sp}`)}
              </button>
            ))}
          </div>
        </div>

        {/* 10-Language Selector */}
        <div className={styles.card}>
          <div className={styles.rowBetween}>
            <span className={styles.sectionTitle}>{t('menu.language')}</span>
            {permissionLevel === 'L0' && (
              <span className={styles.noteText}>{t('menu.languageLocalOnly')}</span>
            )}
          </div>
          <div className={styles.choiceWrap}>
            {SUPPORTED_LANGUAGES.map((lang) => (
              <button
                key={lang.bcp47}
                type="button"
                className={`${styles.choiceBtn} ${locale === lang.bcp47 ? styles.choiceBtnActive : ''}`}
                data-testid={`locale-btn-${lang.bcp47}`}
                onClick={() => {
                  setLocale(lang.bcp47);
                  onSetLocale(lang.bcp47);
                }}
              >
                {lang.nativeName}
              </button>
            ))}
          </div>
        </div>

        {/* Notifications */}
        <div className={styles.card}>
          <span className={styles.sectionTitle}>{t('menu.notifications')}</span>
          <div className={styles.choiceWrap}>
            <button
              type="button"
              className={`${styles.choiceBtn} ${pushSubscribed ? styles.choiceBtnActive : ''}`}
              disabled={pushBusy}
              onClick={onTogglePush}
            >
              {t('menu.pushLockScreen')}: {pushSubscribed ? t('menu.pushEnabled') : t('menu.pushEnable')}
            </button>
            <button type="button" className={styles.choiceBtn} onClick={onTestPush}>
              {t('menu.pushTest')}
            </button>
            <button
              type="button"
              className={`${styles.choiceBtn} ${soundAlert ? styles.choiceBtnActive : ''}`}
              onClick={onToggleSound}
            >
              {t('menu.sound')}: {soundAlert ? 'ON' : 'OFF'}
            </button>
            <button
              type="button"
              className={`${styles.choiceBtn} ${vibrateAlert ? styles.choiceBtnActive : ''}`}
              onClick={onToggleVibrate}
            >
              {t('menu.vibrate')}: {vibrateAlert ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        {/* Read-Only Diagnostics & Safe Whitelist Commands */}
        <div className={styles.card}>
          <button
            type="button"
            className={styles.rowBtn}
            aria-expanded={diagOpen}
            onClick={() => setDiagOpen((v) => !v)}
            data-testid="menu-diagnostics-toggle"
          >
            <span>{t('menu.diagnostics')}</span>
            <span>{diagOpen ? '▾' : '▸'}</span>
          </button>

          {diagOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(Array.isArray(diag?.checks) ? diag.checks : []).map((c) => (
                <div key={c.id} className={styles.rowBetween}>
                  <span style={{ fontSize: 12.5 }}>{c.label}</span>
                  <span
                    className="ag-chip"
                    data-tone={c.status === 'ok' ? 'ok' : c.status === 'warn' ? 'warn' : 'danger'}
                  >
                    {c.detail}
                  </span>
                </div>
              ))}

              {commands.length > 0 && (
                <>
                  <span className={styles.sectionTitle}>{t('menu.commands')}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {commands.map((cmd) => (
                      <div key={cmd.id} className={styles.rowBetween}>
                        <span style={{ fontSize: 12.5 }}>{cmd.title}</span>
                        <button
                          type="button"
                          className="ag-pill-btn"
                          disabled={!cmd.allowed || Boolean(runningCmdId)}
                          onClick={() => void handleRunCmd(cmd.id)}
                          data-testid={`safe-cmd-${cmd.id}`}
                        >
                          {runningCmdId === cmd.id ? '…' : t('menu.runCommand')}
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className={styles.noteText}>{t('menu.hostBoundaryNote')}</div>
            </div>
          )}
        </div>
      </div>
    </BottomSheet>
  );
}
