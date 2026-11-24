import type { SupportedLanguageOption } from '../types';

export const SUPPORTED_LANGUAGES: SupportedLanguageOption[] = [
  { code: 'zh', bcp47: 'zh-CN', nativeName: '简体中文', shortLabel: '简中' },
  { code: 'zh-TW', bcp47: 'zh-TW', nativeName: '繁體中文', shortLabel: '繁中' },
  { code: 'ja', bcp47: 'ja', nativeName: '日本語', shortLabel: '日本語' },
  { code: 'ko', bcp47: 'ko', nativeName: '한국어', shortLabel: '한국어' },
  { code: 'es', bcp47: 'es', nativeName: 'Español', shortLabel: 'ES' },
  { code: 'pt', bcp47: 'pt', nativeName: 'Português', shortLabel: 'PT' },
  { code: 'fr', bcp47: 'fr', nativeName: 'Français', shortLabel: 'FR' },
  { code: 'ru', bcp47: 'ru', nativeName: 'Русский', shortLabel: 'RU' },
  { code: 'it', bcp47: 'it', nativeName: 'Italiano', shortLabel: 'IT' },
  { code: 'en', bcp47: 'en', nativeName: 'English', shortLabel: 'EN' },
];
