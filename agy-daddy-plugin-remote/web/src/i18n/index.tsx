import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useState } from 'preact/hooks';
import type { LocaleOptionDto, SupportedLocale } from '../types';
import { LOCALE_DICTS } from './locales';
import { SUPPORTED_LANGUAGES, type I18nKey, type I18nParams, type TranslateFn } from './types';

export type { I18nKey, I18nParams, TranslateFn };
export { SUPPORTED_LANGUAGES };

export const LOCALE_STORAGE_KEY = 'agy_remote_locale';

export function normalizeLocale(raw: unknown): SupportedLocale | null {
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

export function interpolate(template: string, params?: I18nParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_m, k) => {
    const val = params[k];
    return val === null || val === undefined ? '' : String(val);
  });
}

export function createTranslator(locale: SupportedLocale): TranslateFn {
  const dict = LOCALE_DICTS[locale] || LOCALE_DICTS['zh-CN'];
  return (key: I18nKey, params?: I18nParams) => {
    const template = dict[key] ?? LOCALE_DICTS['zh-CN'][key] ?? key;
    return interpolate(template, params);
  };
}

function readStoredLocale(): SupportedLocale | null {
  if (typeof window === 'undefined') return null;
  try {
    return normalizeLocale(window.localStorage?.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null;
  }
}

export interface I18nContextValue {
  locale: SupportedLocale;
  supportedLanguages: LocaleOptionDto[];
  setLocale: (next: SupportedLocale) => void;
  syncLocale: (raw: unknown, supported?: LocaleOptionDto[]) => void;
  t: TranslateFn;
}

const DEFAULT_FALLBACK_LOCALE: SupportedLocale = 'zh-CN';

const DEFAULT_I18N_CONTEXT: I18nContextValue = {
  locale: DEFAULT_FALLBACK_LOCALE,
  supportedLanguages: SUPPORTED_LANGUAGES,
  setLocale: () => {},
  syncLocale: () => {},
  t: createTranslator(DEFAULT_FALLBACK_LOCALE)
};

const I18nContext = createContext<I18nContextValue>(DEFAULT_I18N_CONTEXT);

export interface I18nProviderProps {
  children: ComponentChildren;
  locale?: SupportedLocale;
  onLocaleChange?: (next: SupportedLocale) => void;
}

export function I18nProvider({
  children,
  locale: controlledLocale,
  onLocaleChange
}: I18nProviderProps) {
  const [internalLocale, setInternalLocale] = useState<SupportedLocale>(
    () => controlledLocale ?? readStoredLocale() ?? DEFAULT_FALLBACK_LOCALE
  );
  const [supportedLanguages, setSupportedLanguages] = useState<LocaleOptionDto[]>(SUPPORTED_LANGUAGES);

  const locale = controlledLocale ?? internalLocale;

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const setLocale = useCallback(
    (next: SupportedLocale) => {
      setInternalLocale(next);
      try {
        window.localStorage?.setItem(LOCALE_STORAGE_KEY, next);
      } catch {}
      onLocaleChange?.(next);
    },
    [onLocaleChange]
  );

  const syncLocale = useCallback((raw: unknown, supported?: LocaleOptionDto[]) => {
    if (Array.isArray(supported) && supported.length > 0) {
      setSupportedLanguages(supported);
    }
    const parsed = normalizeLocale(raw);
    if (parsed) {
      setInternalLocale(parsed);
      try {
        window.localStorage?.setItem(LOCALE_STORAGE_KEY, parsed);
      } catch {}
    }
  }, []);

  const t = useMemo(() => createTranslator(locale), [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, supportedLanguages, setLocale, syncLocale, t }),
    [locale, supportedLanguages, setLocale, syncLocale, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}
