import type { LocaleOptionDto, SupportedLocale } from '../types';

export type I18nParams = Record<string, string | number | boolean | null | undefined>;

export const SUPPORTED_LANGUAGES: LocaleOptionDto[] = [
  { code: 'zh', bcp47: 'zh-CN', nativeName: '简体中文', shortLabel: '简中' },
  { code: 'zh-TW', bcp47: 'zh-TW', nativeName: '繁體中文', shortLabel: '繁中' },
  { code: 'en', bcp47: 'en', nativeName: 'English', shortLabel: 'EN' },
  { code: 'ja', bcp47: 'ja', nativeName: '日本語', shortLabel: '日本語' },
  { code: 'ko', bcp47: 'ko', nativeName: '한국어', shortLabel: '한국어' },
  { code: 'es', bcp47: 'es', nativeName: 'Español', shortLabel: 'ES' },
  { code: 'pt', bcp47: 'pt', nativeName: 'Português', shortLabel: 'PT' },
  { code: 'fr', bcp47: 'fr', nativeName: 'Français', shortLabel: 'FR' },
  { code: 'ru', bcp47: 'ru', nativeName: 'Русский', shortLabel: 'RU' },
  { code: 'it', bcp47: 'it', nativeName: 'Italiano', shortLabel: 'IT' }
];

export type TranslateFn = (key: I18nKey, params?: I18nParams) => string;

export interface I18nMessages {
  'app.title': string;
  'app.offlineBanner': string;
  'app.errorTitle': string;
  'app.resetUi': string;
  'app.authPrompt': string;
  'app.tokenPlaceholder': string;
  'app.connect': string;
  'common.close': string;
  'common.cancel': string;
  'common.confirm': string;
  'common.refresh': string;
  'common.refreshing': string;
  'common.copy': string;
  'common.copied': string;
  'common.back': string;
  'common.more': string;

  'topbar.leftDrawer': string;
  'topbar.rightDrawer': string;
  'topbar.telemetry': string;
  'topbar.tasks': string;
  'topbar.menu': string;
  'topbar.connOk': string;
  'topbar.connWarn': string;
  'topbar.connDanger': string;
  'topbar.reconnect': string;
  'topbar.quota': string;

  'drawer.edgeHint': string;
  'drawer.edgeHintDismiss': string;

  'telemetry.title': string;
  'telemetry.contextTab': string;
  'telemetry.usageTab': string;
  'telemetry.quotaTab': string;
  'telemetry.used': string;
  'telemetry.input': string;
  'telemetry.cached': string;
  'telemetry.hitRate': string;
  'telemetry.output': string;
  'telemetry.speed': string;
  'telemetry.cliff': string;
  'telemetry.groups': string;
  'telemetry.alerts': string;
  'telemetry.compact': string;
  'telemetry.compacting': string;
  'telemetry.compactSent': string;
  'telemetry.riskNone': string;
  'telemetry.riskWarn': string;
  'telemetry.riskCritical': string;
  'telemetry.today': string;
  'telemetry.month': string;
  'telemetry.year': string;
  'telemetry.allTime': string;
  'telemetry.roiSaved': string;
  'telemetry.byModel': string;
  'telemetry.planTier': string;
  'telemetry.pools': string;
  'telemetry.fiveHour': string;
  'telemetry.weekly': string;
  'telemetry.resetIn': string;
  'telemetry.noData': string;

  'channels.title': string;
  'channels.current': string;
  'channels.recommended': string;
  'channels.retest': string;
  'channels.testing': string;
  'channels.switchInPage': string;
  'channels.switchTicket': string;
  'channels.switchedToast': string;
  'channels.crossProtoNote': string;
  'channels.httpsRestricted': string;
  'channels.unreachable': string;
  'channels.switchFailed': string;

  'menu.title': string;
  'menu.appearance': string;
  'menu.appearanceAuto': string;
  'menu.appearanceDark': string;
  'menu.appearanceLight': string;
  'menu.colorTheme': string;
  'menu.color.monochrome': string;
  'menu.color.purple': string;
  'menu.color.blue': string;
  'menu.color.green': string;
  'menu.color.amber': string;
  'menu.color.red': string;
  'menu.drawerSpeed': string;
  'menu.speed.fast': string;
  'menu.speed.normal': string;
  'menu.speed.slow': string;
  'menu.speed.off': string;
  'menu.language': string;
  'menu.languageLocalOnly': string;
  'menu.channelsEntry': string;
  'menu.tasksEntry': string;
  'menu.notifications': string;
  'menu.pushLockScreen': string;
  'menu.pushEnable': string;
  'menu.pushEnabled': string;
  'menu.pushTest': string;
  'menu.sound': string;
  'menu.vibrate': string;
  'menu.diagnostics': string;
  'menu.commands': string;
  'menu.runCommand': string;
  'menu.hostBoundaryNote': string;

  'tasks.title': string;
  'tasks.running': string;
  'tasks.recent': string;
  'tasks.empty': string;
  'tasks.kind.pty': string;
  'tasks.kind.session': string;
  'tasks.kind.command': string;
  'tasks.status.running': string;
  'tasks.status.completed': string;
  'tasks.status.failed': string;
  'tasks.status.stopped': string;
  'tasks.viewLog': string;
  'tasks.stop': string;
  'tasks.confirmStop': string;
  'tasks.alreadyFinished': string;
  'tasks.truncatedLog': string;
  'tasks.noLogs': string;

  'chat.thinking': string;
  'chat.thinkingLive': string;
  'chat.expand': string;
  'chat.collapse': string;
  'chat.sending': string;
  'chat.viewInDiff': string;
  'chat.filesChanged': string;
  'chat.reviewDiff': string;
  'chat.jumpBottom': string;

  'nav.title': string;
  'nav.searchPlaceholder': string;
  'nav.caseSensitive': string;
  'nav.regex': string;
  'nav.prevMatch': string;
  'nav.nextMatch': string;
  'nav.top': string;
  'nav.prevTurn': string;
  'nav.nextTurn': string;
  'nav.bottom': string;
  'nav.expandThinking': string;
  'nav.collapseThinking': string;
  'nav.hideSystem': string;
  'nav.showSystem': string;
  'nav.copySessionId': string;
  'nav.exportMd': string;
  'nav.exportHtml': string;
  'nav.printPdf': string;

  'composer.placeholder': string;
  'composer.placeholderPlan': string;
  'composer.placeholderRunning': string;
  'composer.placeholderReadOnly': string;
  'composer.presetsBtn': string;
  'composer.optimize': string;
  'composer.undoOptimize': string;
  'composer.send': string;
  'composer.enqueue': string;
  'composer.stop': string;
  'composer.highRiskTitle': string;
  'composer.sendAnyway': string;
  'composer.ghostApply': string;
}

export type I18nKey = keyof I18nMessages;
export type LocaleDict = Record<I18nKey, string>;
export type SupportedLocaleId = SupportedLocale;
