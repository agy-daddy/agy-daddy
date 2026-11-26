'use strict';

const {
  DEFAULT_LANG,
  SUPPORTED_LANGUAGES,
  BRAND_TITLE_MODES,
  normalizeLang,
  getLanguageMeta,
  getDictionaryStats,
  normalizeBrandTitleMode,
  parseCustomRules,
  translateText
} = require('./dictionary');

let disposers = [];

function normalizeManagedSettings(raw = {}) {
  return {
    lang: normalizeLang(raw.lang, DEFAULT_LANG),
    brandTitle: normalizeBrandTitleMode(raw.brandTitle || BRAND_TITLE_MODES.ENGLISH),
    englishLabels: Boolean(raw.englishLabels),
    translateThinking: raw.translateThinking !== false,
    translateConversationTitles: raw.translateConversationTitles !== false,
    enableRemoteThinkingTranslation: Boolean(raw.enableRemoteThinkingTranslation)
  };
}

async function activate(host) {
  let config = normalizeManagedSettings(host.settings.get());
  let lastNonEnLang = config.lang !== 'en' ? config.lang : DEFAULT_LANG;
  let syncingSettings = false;

  let translationCache = host.storage.readJson('zh-translation-cache.json', {}).data || {};
  let customTitles = host.storage.readJson('custom-conversation-titles.json', {}).data || {};
  let customRulesRaw = [];

  function publishLangState() {
    if (config.lang !== 'en') {
      lastNonEnLang = config.lang;
    }
    const meta = getLanguageMeta(config.lang);
    host.state.set('state:zh-cn.lang@1', {
      lang: config.lang,
      bcp47: meta.bcp47,
      shortLabel: meta.shortLabel,
      lastNonEnLang,
      brandTitle: config.brandTitle,
      englishLabels: config.englishLabels,
      translateThinking: config.translateThinking,
      translateConversationTitles: config.translateConversationTitles,
      enableRemoteThinkingTranslation: config.enableRemoteThinkingTranslation
    });
  }

  async function applyConfigPatch(patch = {}, persistManaged = true) {
    if (Array.isArray(patch.customRules)) {
      customRulesRaw = patch.customRules;
    }
    const managedPatch = {};
    if (patch.lang !== undefined) managedPatch.lang = normalizeLang(patch.lang, DEFAULT_LANG);
    if (patch.brandTitle !== undefined) managedPatch.brandTitle = normalizeBrandTitleMode(patch.brandTitle);
    if (patch.englishLabels !== undefined) managedPatch.englishLabels = Boolean(patch.englishLabels);
    if (patch.translateThinking !== undefined) managedPatch.translateThinking = Boolean(patch.translateThinking);
    if (patch.translateConversationTitles !== undefined) {
      managedPatch.translateConversationTitles = Boolean(patch.translateConversationTitles);
    }
    if (patch.enableRemoteThinkingTranslation !== undefined) {
      managedPatch.enableRemoteThinkingTranslation = Boolean(patch.enableRemoteThinkingTranslation);
    }

    config = normalizeManagedSettings({ ...config, ...managedPatch });
    publishLangState();

    if (persistManaged && Object.keys(managedPatch).length > 0) {
      syncingSettings = true;
      try {
        await host.settings.update(managedPatch);
      } finally {
        syncingSettings = false;
      }
    }
    return { ...config };
  }

  const stopSettingsSub = host.settings.onChange((nextValues) => {
    if (syncingSettings) return;
    config = normalizeManagedSettings(nextValues);
    publishLangState();
  });

  const serviceMethods = {
    getSupportedLanguages() {
      return SUPPORTED_LANGUAGES.map((item) => ({ ...item }));
    },
    getDictionaryStats(targetLang) {
      if (targetLang === 'all') {
        return getDictionaryStats('all');
      }
      const lang = targetLang
        ? normalizeLang(targetLang, DEFAULT_LANG)
        : (config.lang === 'en' ? lastNonEnLang : config.lang);
      const single = getDictionaryStats(lang);
      const all = getDictionaryStats('all');
      return {
        ...single,
        languages: all.languages
      };
    },
    getConfig() {
      const activeDictLang = config.lang === 'en' ? lastNonEnLang : config.lang;
      return {
        ...config,
        lastNonEnLang,
        supportedLanguages: SUPPORTED_LANGUAGES.map((l) => l.code),
        customRules: customRulesRaw,
        titles: { ...customTitles },
        dictionaryStats: getDictionaryStats(activeDictLang)
      };
    },
    async setLang(nextLang) {
      const normalized = normalizeLang(nextLang, DEFAULT_LANG);
      return await applyConfigPatch({ lang: normalized }, true);
    },
    async setConfig(patch = {}) {
      return await applyConfigPatch(patch, true);
    },
    getCustomTitle(cascadeId) {
      return customTitles[String(cascadeId || '')] || null;
    },
    setCustomTitle(cascadeId, title) {
      const cid = String(cascadeId || '').trim();
      if (!cid) throw new Error('cascadeId required');
      const next = String(title || '').trim();
      if (next) customTitles[cid] = next;
      else delete customTitles[cid];
      host.storage.writeJson('custom-conversation-titles.json', customTitles);
      return { ok: true, cascadeId: cid, title: next || null };
    },
    async translateSnippet(text, options = {}) {
      const raw = String(text || '').trim();
      if (!raw) return { ok: true, text: '', source: 'empty' };

      const targetLang = options.lang !== undefined
        ? normalizeLang(options.lang, DEFAULT_LANG)
        : (options.tl
          ? normalizeLang(options.tl, lastNonEnLang)
          : config.lang);

      if (options.kind === 'thinking' && !config.translateThinking) {
        return { ok: true, text: raw, source: 'disabled', lang: targetLang };
      }

      if (targetLang !== 'en') {
        const dictResult = translateText(raw, {
          lang: targetLang,
          englishLabels: config.englishLabels,
          brandTitle: config.brandTitle,
          customRules: parseCustomRules(customRulesRaw)
        });
        if (dictResult !== raw) {
          return { ok: true, text: dictResult, source: 'dictionary', lang: targetLang };
        }
      }

      const cacheKey = `${targetLang}::${raw}`;
      if (typeof translationCache[cacheKey] === 'string' && translationCache[cacheKey]) {
        return { ok: true, text: translationCache[cacheKey], source: 'cache', lang: targetLang };
      }
      if (targetLang === 'zh' && typeof translationCache[raw] === 'string' && translationCache[raw]) {
        return { ok: true, text: translationCache[raw], source: 'cache', lang: 'zh' };
      }

      const allowRemote = Boolean(config.enableRemoteThinkingTranslation || options.optInRemote === true);
      if (!allowRemote) {
        return {
          ok: false,
          blocked: true,
          reason: 'REMOTE_TRANSLATION_DISABLED',
          text: raw,
          lang: targetLang
        };
      }

      const remoteLang = targetLang === 'en' ? lastNonEnLang : targetLang;
      const targetTl = options.tl || getLanguageMeta(remoteLang).googleTl;
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetTl)}&dt=t&q=${encodeURIComponent(raw)}`;
      const resp = await host.net.fetch(url);
      if (!resp || resp.ok === false) {
        return { ok: false, error: `HTTP ${resp?.status || 'error'}`, text: raw, lang: targetLang };
      }
      const data = await resp.json();
      const translated = Array.isArray(data?.[0])
        ? data[0].map((seg) => (Array.isArray(seg) ? String(seg[0] || '') : '')).join('')
        : raw;

      if (translated && translated !== raw) {
        translationCache[cacheKey] = translated;
        host.storage.writeJson('zh-translation-cache.json', translationCache);
      }
      return { ok: true, text: translated || raw, source: 'remote', lang: targetLang, tl: targetTl };
    },
    async translateConversationTitle(cascadeId, rawTitle, options = {}) {
      const cid = String(cascadeId || '').trim();
      if (cid && customTitles[cid]) {
        return { ok: true, cascadeId: cid, title: customTitles[cid], source: 'custom' };
      }
      if (!config.translateConversationTitles) {
        const raw = String(rawTitle || '').trim();
        return { ok: true, cascadeId: cid, title: raw, text: raw, source: 'disabled', lang: config.lang };
      }
      const res = await serviceMethods.translateSnippet(rawTitle, options);
      return { ...res, cascadeId: cid, title: res.text };
    }
  };

  const stopSvc = host.services.provide('zh-cn', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopToggleCmd = host.commands.register('zh-cn.toggle-lang', async () => {
    const nextLang = config.lang === 'en' ? lastNonEnLang : 'en';
    const updated = await applyConfigPatch({ lang: nextLang }, true);
    const meta = getLanguageMeta(updated.lang);
    return {
      ok: true,
      lang: updated.lang,
      label: meta.shortLabel,
      message: `已切换至 ${meta.nativeName}`
    };
  });
  const stopSetLangCmd = host.commands.register('zh-cn.set-lang', async (nextLang) => {
    const normalized = normalizeLang(nextLang, DEFAULT_LANG);
    const updated = await applyConfigPatch({ lang: normalized }, true);
    const meta = getLanguageMeta(updated.lang);
    return {
      ok: true,
      lang: updated.lang,
      label: meta.shortLabel,
      message: `已切换至 ${meta.nativeName}`
    };
  });
  const stopGetRendererStateCmd = host.commands.register('zh-cn.get-renderer-state', async () => ({
    ...config,
    lastNonEnLang,
    customRules: customRulesRaw,
    titles: { ...customTitles }
  }));
  const stopTranslateTitlesCmd = host.commands.register('zh-cn.translate-titles', async (items = [], options = {}) => {
    const list = Array.isArray(items) ? items.slice(0, 50) : [];
    const results = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const cid = String(item.cascadeId || '').trim();
      const raw = String(item.text || '').trim();
      if (!raw) continue;
      const res = await serviceMethods.translateConversationTitle(cid, raw, options);
      results.push({
        cascadeId: cid,
        text: raw,
        translated: res.title || res.text || raw,
        source: res.source || 'unknown',
        blocked: Boolean(res.blocked),
        ok: res.ok !== false
      });
    }
    return { ok: true, lang: config.lang, results };
  });

  publishLangState();

  disposers.push(
    stopSettingsSub,
    stopSvc,
    stopToggleCmd,
    stopSetLangCmd,
    stopGetRendererStateCmd,
    stopTranslateTitlesCmd
  );
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  activate,
  deactivate
};
