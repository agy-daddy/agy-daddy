import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { SessionSummary } from '../types';
import { SUPPORTED_LANGUAGES } from './locales/catalog';
import { en } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { it as itLocale } from './locales/it';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { pt } from './locales/pt';
import { ru } from './locales/ru';
import { zhCN } from './locales/zh-CN';
import { zhTW } from './locales/zh-TW';
import type {
  I18nKey,
  I18nMessages,
  I18nParams,
  Locale,
  SupportedLanguageOption,
  TranslateFn,
} from './types';

export type { I18nKey, I18nMessages, I18nParams, Locale, SupportedLanguageOption, TranslateFn };
export { SUPPORTED_LANGUAGES };

export const LOCALE_STORAGE_KEY = 'agy.web.locale';

const DICTIONARIES: Record<Locale, Partial<I18nMessages>> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  ja,
  ko,
  es,
  pt,
  fr,
  ru,
  it: itLocale,
};

export function normalizeLocale(raw: unknown): Locale | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!trimmed) return null;
  if (trimmed === 'en' || trimmed.startsWith('en-')) return 'en';
  if (
    trimmed === 'zh-tw' ||
    trimmed === 'zh-hant' ||
    trimmed.startsWith('zh-hant-') ||
    trimmed === 'zh-hk' ||
    trimmed === 'zh-mo'
  ) {
    return 'zh-TW';
  }
  if (trimmed === 'zh' || trimmed === 'zh-cn' || trimmed.startsWith('zh-')) return 'zh-CN';
  if (trimmed === 'ja' || trimmed.startsWith('ja-')) return 'ja';
  if (trimmed === 'ko' || trimmed.startsWith('ko-')) return 'ko';
  if (trimmed === 'es' || trimmed.startsWith('es-')) return 'es';
  if (trimmed === 'pt' || trimmed.startsWith('pt-')) return 'pt';
  if (trimmed === 'fr' || trimmed.startsWith('fr-')) return 'fr';
  if (trimmed === 'ru' || trimmed.startsWith('ru-')) return 'ru';
  if (trimmed === 'it' || trimmed.startsWith('it-')) return 'it';
  return null;
}

function readStoredLocale(): Locale | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function detectInitialLocale(fallback: Locale = 'en'): Locale {
  const stored = readStoredLocale();
  if (stored) return stored;
  return fallback;
}

export function interpolate(template: string, params?: I18nParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_m, k) => {
    const val = params[k];
    return val === null || val === undefined ? '' : String(val);
  });
}

export function createTranslator(locale: Locale): TranslateFn {
  const dict = DICTIONARIES[locale] || DICTIONARIES.en;
  return (key: I18nKey, params?: I18nParams) => {
    const template = dict[key] ?? DICTIONARIES.en[key] ?? key;
    return interpolate(template, params);
  };
}

export function formatRelativeTime(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  const t = createTranslator(locale);
  if (diffSec < 60) return t('sidebar.justNow');

  if (typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function') {
    try {
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' });
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return rtf.format(-diffMin, 'minute');
      const diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return rtf.format(-diffHr, 'hour');
      const diffDay = Math.floor(diffHr / 24);
      if (diffDay < 30) return rtf.format(-diffDay, 'day');
    } catch {
      // fall back to translator strings below
    }
  }

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return t('sidebar.minutesAgo', { count: diffMin });
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return t('sidebar.hoursAgo', { count: diffHr });
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return t('sidebar.daysAgo', { count: diffDay });
  return new Date(ms).toLocaleDateString(locale);
}

const UUID_LIKE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatSessionTitle(session: SessionSummary | null | undefined, t: TranslateFn): string {
  if (!session) return t('session.noneSelected');
  const rawTitle = typeof session.title === 'string' ? session.title.trim() : '';
  if (rawTitle && !UUID_LIKE_RE.test(rawTitle) && rawTitle !== session.cascadeId) {
    return rawTitle;
  }
  const summary = typeof session.summary === 'string' ? session.summary.trim() : '';
  if (summary && !UUID_LIKE_RE.test(summary) && summary !== session.cascadeId) {
    return summary;
  }
  const shortId = session.shortId || String(session.cascadeId || '').slice(0, 8) || 'session';
  const repo = session.repoName?.trim();
  if (repo) {
    return t('session.untitledWithRepo', { repo, shortId });
  }
  return t('session.untitled', { shortId });
}

export function humanizeEnum(raw: string | null | undefined): string {
  if (!raw) return '';
  return String(raw)
    .replace(/^CORTEX_STEP_TYPE_/, '')
    .replace(/^CASCADE_RUN_STATUS_/, '')
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export interface HostLanguageInput {
  code: string;
  bcp47: string;
  nativeName: string;
  shortLabel: string;
}

export interface I18nContextValue {
  locale: Locale;
  supportedLanguages: SupportedLanguageOption[];
  setLocale: (next: Locale) => void;
  toggleLocale: () => void;
  syncHostLocale: (rawLang: unknown, nextSupported?: ReadonlyArray<HostLanguageInput>) => void;
  t: TranslateFn;
}

const DEFAULT_FALLBACK_LOCALE: Locale = 'en';

const DEFAULT_I18N_CONTEXT: I18nContextValue = {
  locale: DEFAULT_FALLBACK_LOCALE,
  supportedLanguages: SUPPORTED_LANGUAGES,
  setLocale: () => {},
  toggleLocale: () => {},
  syncHostLocale: () => {},
  t: createTranslator(DEFAULT_FALLBACK_LOCALE),
};

const I18nContext = createContext<I18nContextValue>(DEFAULT_I18N_CONTEXT);

export interface I18nProviderProps {
  children: React.ReactNode;
  defaultLocale?: Locale;
  onLocaleChange?: (next: Locale) => void;
}

export function I18nProvider({ children, defaultLocale, onLocaleChange }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(
    () => defaultLocale ?? detectInitialLocale(DEFAULT_FALLBACK_LOCALE),
  );
  const [supportedLanguages, setSupportedLanguages] = useState<SupportedLanguageOption[]>(
    () => SUPPORTED_LANGUAGES,
  );

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
        } catch {
          // ignore storage errors
        }
      }
      onLocaleChange?.(next);
    },
    [onLocaleChange],
  );

  const toggleLocale = useCallback(() => {
    setLocale(locale === 'en' ? 'zh-CN' : 'en');
  }, [locale, setLocale]);

  const syncHostLocale = useCallback(
    (rawLang: unknown, nextSupported?: ReadonlyArray<HostLanguageInput>) => {
      if (Array.isArray(nextSupported) && nextSupported.length > 0) {
        const normalized = nextSupported
          .map((item) => {
            const bcp47 = normalizeLocale(item.bcp47) ?? normalizeLocale(item.code);
            if (!bcp47) return null;
            return {
              code: item.code,
              bcp47,
              nativeName: item.nativeName,
              shortLabel: item.shortLabel,
            };
          })
          .filter((item): item is SupportedLanguageOption => item !== null);
        if (normalized.length > 0) {
          setSupportedLanguages(normalized);
        }
      }
      const parsed = normalizeLocale(rawLang);
      if (parsed) {
        setLocaleState(parsed);
      }
    },
    [],
  );

  const t = useMemo(() => createTranslator(locale), [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, supportedLanguages, setLocale, toggleLocale, syncHostLocale, t }),
    [locale, supportedLanguages, setLocale, toggleLocale, syncHostLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
