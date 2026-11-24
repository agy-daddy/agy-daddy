import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '../types';
import {
  createTranslator,
  formatSessionTitle,
  I18nProvider,
  LOCALE_STORAGE_KEY,
  normalizeLocale,
  SUPPORTED_LANGUAGES,
  useI18n,
} from './index';
import { en } from './locales/en';
import { zhCN } from './locales/zh-CN';
import type { I18nKey, Locale } from './types';

const RAW_SOURCE_FILES = import.meta.glob<string>(
  ['../**/*.ts', '../**/*.tsx', '!../i18n/locales/**', '!../**/*.test.ts', '!../**/*.test.tsx'],
  { query: '?raw', import: 'default', eager: true },
);

function I18nProbe({ session }: { session: SessionSummary }) {
  const { locale, supportedLanguages, setLocale, toggleLocale, syncHostLocale, t } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="lang-count">{supportedLanguages.length}</span>
      <span data-testid="first-lang">{supportedLanguages[0]?.bcp47}</span>
      <span data-testid="heading">{t('sidebar.sessions')}</span>
      <span data-testid="hidden-show">{t('stream.hiddenEventsShow', { count: 3 })}</span>
      <span data-testid="session-title">{formatSessionTitle(session, t)}</span>
      <button type="button" onClick={toggleLocale} data-testid="toggle-lang">
        toggle
      </button>
      <button type="button" onClick={() => setLocale('ja')} data-testid="set-ja">
        set-ja
      </button>
      <button type="button" onClick={() => syncHostLocale('zh-CN')} data-testid="sync-host-zh">
        sync-zh
      </button>
      <button
        type="button"
        onClick={() =>
          syncHostLocale('fr', [
            { code: 'fr', bcp47: 'fr', nativeName: 'Français', shortLabel: 'FR' },
            { code: 'en', bcp47: 'en', nativeName: 'English', shortLabel: 'EN' },
          ])
        }
        data-testid="sync-host-fr"
      >
        sync-fr
      </button>
    </div>
  );
}

describe('I18nProvider & formatSessionTitle', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  const untitledSession: SessionSummary = {
    cascadeId: '1050fb4f-4c80-4df1-ac7d-d640eb91ddf5',
    shortId: '1050fb4f',
    hasTitle: false,
    titleSource: 'none',
    title: '1050fb4f-4c80-4df1-ac7d-d640eb91ddf5',
    summary: '',
    status: 'CASCADE_RUN_STATUS_IDLE',
    stepCount: 5,
    lastModifiedTime: null,
    createdTime: null,
    workspaceUri: null,
    gitRootUri: null,
    repoName: 'agy-daddy/agy-daddy',
    branchName: 'main',
    workspaces: [],
  };

  it('defaults to English baseline and switches cleanly between en and zh-CN', () => {
    render(
      <I18nProvider>
        <I18nProbe session={untitledSession} />
      </I18nProvider>,
    );

    expect(screen.getByTestId('locale')).toHaveTextContent('en');
    expect(screen.getByTestId('lang-count')).toHaveTextContent('10');
    expect(screen.getByTestId('heading')).toHaveTextContent('Sessions');
    expect(screen.getByTestId('hidden-show')).toHaveTextContent('Show 3 hidden internal events');
    expect(screen.getByTestId('session-title')).toHaveTextContent('Untitled · agy-daddy/agy-daddy #1050fb4f');
    expect(screen.getByTestId('session-title').textContent).not.toContain('4c80-4df1');

    fireEvent.click(screen.getByTestId('sync-host-zh'));
    expect(screen.getByTestId('locale')).toHaveTextContent('zh-CN');
    expect(screen.getByTestId('heading')).toHaveTextContent('会话列表');

    fireEvent.click(screen.getByTestId('toggle-lang'));
    expect(screen.getByTestId('locale')).toHaveTextContent('en');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
  });

  it('invokes onLocaleChange on setLocale and lets syncHostLocale override manual choice immediately', () => {
    const onLocaleChange = vi.fn();
    render(
      <I18nProvider onLocaleChange={onLocaleChange}>
        <I18nProbe session={untitledSession} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('set-ja'));
    expect(screen.getByTestId('locale')).toHaveTextContent('ja');
    expect(screen.getByTestId('heading')).toHaveTextContent('セッション');
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ja');
    expect(onLocaleChange).toHaveBeenCalledTimes(1);
    expect(onLocaleChange).toHaveBeenCalledWith('ja');

    // Host locale push must always update active locale even after manual setLocale
    fireEvent.click(screen.getByTestId('sync-host-fr'));
    expect(screen.getByTestId('locale')).toHaveTextContent('fr');
    expect(screen.getByTestId('lang-count')).toHaveTextContent('2');
    expect(screen.getByTestId('first-lang')).toHaveTextContent('fr');
    // syncHostLocale should not loop back via onLocaleChange
    expect(onLocaleChange).toHaveBeenCalledTimes(1);
  });

  it('normalizes and translates all 10 supported host locales with English fallback', () => {
    const cases: Array<[string, Locale]> = [
      ['zh', 'zh-CN'],
      ['zh-CN', 'zh-CN'],
      ['zh-tw', 'zh-TW'],
      ['zh_Hant', 'zh-TW'],
      ['ja', 'ja'],
      ['ja-JP', 'ja'],
      ['ko', 'ko'],
      ['es', 'es'],
      ['pt', 'pt'],
      ['fr', 'fr'],
      ['ru', 'ru'],
      ['it', 'it'],
      ['en', 'en'],
    ];
    for (const [raw, expected] of cases) {
      expect(normalizeLocale(raw)).toBe(expected);
    }
    expect(normalizeLocale('unknown-xx')).toBeNull();
    expect(SUPPORTED_LANGUAGES.map((l) => l.bcp47)).toEqual([
      'zh-CN',
      'zh-TW',
      'ja',
      'ko',
      'es',
      'pt',
      'fr',
      'ru',
      'it',
      'en',
    ]);

    const expectedHeadings: Record<Locale, string> = {
      en: 'Sessions',
      'zh-CN': '会话列表',
      'zh-TW': '工作階段列表',
      ja: 'セッション',
      ko: '세션',
      es: 'Sesiones',
      pt: 'Sessões',
      fr: 'Sessions',
      ru: 'Сессии',
      it: 'Sessioni',
    };

    for (const loc of Object.keys(expectedHeadings) as Locale[]) {
      const t = createTranslator(loc);
      expect(t('sidebar.sessions')).toBe(expectedHeadings[loc]);
      // Partial dictionaries fall back cleanly to English for omitted keys
      expect(t('admin.doctor.rawJson')).toBeTruthy();
      expect(t('admin.doctor.rawJson')).not.toBe('admin.doctor.rawJson');
    }

    // Verify all en keys are also defined in zh-CN
    for (const key of Object.keys(en) as I18nKey[]) {
      expect(zhCN[key]).toBeTruthy();
    }
  });

  it('contains zero hardcoded CJK characters outside i18n/locales and test files', () => {
    const fileEntries = Object.entries(RAW_SOURCE_FILES);
    expect(fileEntries.length).toBeGreaterThan(20);

    const cjkRe = /[\u4e00-\u9fff]/;
    const offenders: string[] = [];
    for (const [filePath, content] of fileEntries) {
      if (cjkRe.test(content)) {
        offenders.push(filePath);
      }
    }

    expect(offenders).toEqual([]);
  });
});
