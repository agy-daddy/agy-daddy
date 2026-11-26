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
const {
  THINKING_TRANSLATION_MODES,
  THINKING_DISPLAY_MODES,
  THINKING_TARGET_LANG_FOLLOW,
  DEFAULT_THINKING_API_BASE_URL,
  DEFAULT_THINKING_API_MODEL,
  normalizeThinkingTranslationMode,
  normalizeThinkingDisplayMode,
  normalizeThinkingTargetLang,
  resolveEffectiveCotTargetLang
} = require('./cot-utils');
const {
  openFileInHost,
  createCotTranslationManager
} = require('./cot-service');

let disposers = [];

function normalizeManagedSettings(raw = {}) {
  const enableRemote = Boolean(raw.enableRemoteThinkingTranslation);
  return {
    lang: normalizeLang(raw.lang, DEFAULT_LANG),
    brandTitle: normalizeBrandTitleMode(raw.brandTitle || BRAND_TITLE_MODES.ENGLISH),
    englishLabels: Boolean(raw.englishLabels),
    translateThinking: raw.translateThinking !== false,
    translateConversationTitles: raw.translateConversationTitles !== false,
    enableRemoteThinkingTranslation: enableRemote,
    thinkingTranslationMode: normalizeThinkingTranslationMode(raw.thinkingTranslationMode, false),
    thinkingTargetLang: normalizeThinkingTargetLang(raw.thinkingTargetLang, normalizeLang),
    thinkingDisplayMode: normalizeThinkingDisplayMode(raw.thinkingDisplayMode),
    thinkingAntigravityModel: typeof raw.thinkingAntigravityModel === 'string'
      ? raw.thinkingAntigravityModel.trim()
      : '',
    thinkingApiBaseUrl: typeof raw.thinkingApiBaseUrl === 'string' && raw.thinkingApiBaseUrl.trim()
      ? raw.thinkingApiBaseUrl.trim()
      : DEFAULT_THINKING_API_BASE_URL,
    thinkingApiKey: typeof raw.thinkingApiKey === 'string' ? raw.thinkingApiKey : '',
    thinkingApiModel: typeof raw.thinkingApiModel === 'string' && raw.thinkingApiModel.trim()
      ? raw.thinkingApiModel.trim()
      : DEFAULT_THINKING_API_MODEL
  };
}

async function activate(host, options = {}) {
  let config = normalizeManagedSettings(host.settings.get());
  let lastNonEnLang = config.lang !== 'en' ? config.lang : DEFAULT_LANG;
  let syncingSettings = false;

  let translationCache = host.storage.readJson('zh-translation-cache.json', {}).data || {};
  let customTitles = host.storage.readJson('custom-conversation-titles.json', {}).data || {};
  let customRulesRaw = [];

  const cotManager = createCotTranslationManager({
    getConfig: () => config,
    getLanguageMeta,
    normalizeLang,
    fetch: (url, init) => host.net.fetch(url, init),
    rpc: host.rpc,
    services: host.services,
    storage: host.storage
  });

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
      enableRemoteThinkingTranslation: config.enableRemoteThinkingTranslation,
      thinkingTranslationMode: config.thinkingTranslationMode,
      thinkingTargetLang: config.thinkingTargetLang,
      effectiveCotTargetLang: resolveEffectiveCotTargetLang(config, normalizeLang),
      thinkingDisplayMode: config.thinkingDisplayMode,
      thinkingAntigravityModel: config.thinkingAntigravityModel,
      thinkingApiBaseUrl: config.thinkingApiBaseUrl,
      thinkingApiModel: config.thinkingApiModel,
      hasThinkingApiKey: Boolean(config.thinkingApiKey)
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
    if (patch.thinkingTranslationMode !== undefined) {
      managedPatch.thinkingTranslationMode = normalizeThinkingTranslationMode(patch.thinkingTranslationMode, false);
    }
    if (patch.thinkingTargetLang !== undefined) {
      managedPatch.thinkingTargetLang = normalizeThinkingTargetLang(patch.thinkingTargetLang, normalizeLang);
    }
    if (patch.thinkingDisplayMode !== undefined) {
      managedPatch.thinkingDisplayMode = normalizeThinkingDisplayMode(patch.thinkingDisplayMode);
    }
    if (patch.thinkingAntigravityModel !== undefined) {
      managedPatch.thinkingAntigravityModel = String(patch.thinkingAntigravityModel || '').trim();
    }
    if (patch.thinkingApiBaseUrl !== undefined) {
      managedPatch.thinkingApiBaseUrl = String(patch.thinkingApiBaseUrl || '').trim() || DEFAULT_THINKING_API_BASE_URL;
    }
    if (patch.thinkingApiKey !== undefined) {
      managedPatch.thinkingApiKey = String(patch.thinkingApiKey || '');
    }
    if (patch.thinkingApiModel !== undefined) {
      managedPatch.thinkingApiModel = String(patch.thinkingApiModel || '').trim() || DEFAULT_THINKING_API_MODEL;
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
    const { thinkingApiKey: _redactedKey, ...safePublicConfig } = config;
    return { ...safePublicConfig, hasThinkingApiKey: Boolean(config.thinkingApiKey) };
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
      const { thinkingApiKey: _redactedKey, ...safeConfig } = config;
      return {
        ...safeConfig,
        hasThinkingApiKey: Boolean(config.thinkingApiKey),
        effectiveCotTargetLang: resolveEffectiveCotTargetLang(config, normalizeLang),
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

      if (options.kind === 'thinking' && config.thinkingTranslationMode === THINKING_TRANSLATION_MODES.ANTIGRAVITY) {
        const cotTarget = options.lang !== undefined
          ? targetLang
          : resolveEffectiveCotTargetLang(config, normalizeLang);
        const agyRes = await cotManager.startOrGetJob({
          text: raw,
          targetLang: cotTarget,
          mode: THINKING_TRANSLATION_MODES.ANTIGRAVITY,
          initialWaitMs: 250
        });
        let finalRes = agyRes;
        while (finalRes && !finalRes.done && finalRes.jobId) {
          finalRes = await cotManager.pollJob({ jobId: finalRes.jobId, cursor: finalRes.cursor, waitMs: 1500 });
        }
        return {
          ok: Boolean(finalRes?.ok),
          text: finalRes?.translatedText || raw,
          source: finalRes?.source || 'antigravity',
          lang: cotTarget,
          ...(finalRes?.model ? { model: finalRes.model } : {}),
          ...(finalRes?.error ? { error: finalRes.error } : {})
        };
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

      const allowRemote = Boolean(
        config.enableRemoteThinkingTranslation
        || options.optInRemote === true
        || (options.kind === 'thinking' && config.thinkingTranslationMode === THINKING_TRANSLATION_MODES.FREE)
      );
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
    },
    async listAntigravityModels(opts = {}) {
      return await cotManager.listAntigravityModelOptions(opts);
    },
    async startCotTranslation(params = {}) {
      return await cotManager.startOrGetJob(params);
    },
    async pollCotTranslation(params = {}) {
      return await cotManager.pollJob(params);
    },
    cancelCotTranslation(jobId) {
      return cotManager.cancelJob(jobId);
    },
    async testCotEndpoint(override = {}) {
      return await cotManager.testCustomEndpoint(override);
    },
    async openFileTarget(target = {}) {
      return await openFileInHost(target, { openFileImpl: options.openFileImpl });
    }
  };

  const stopSvc = host.services.provide('zh-cn', serviceMethods, { realm: 'node', version: '1.0.0' });

  const stopCotTranslateRoute = await host.bridge.registerRoute('/cot/translate', async (body) => {
    return await cotManager.startOrGetJob(body || {});
  }, { timeoutMs: 30000 });
  const stopCotPollRoute = await host.bridge.registerRoute('/cot/poll', async (body) => {
    return await cotManager.pollJob(body || {});
  }, { timeoutMs: 15000 });
  const stopCotCancelRoute = await host.bridge.registerRoute('/cot/cancel', async (body) => {
    return cotManager.cancelJob(body?.jobId);
  });
  const stopCotOpenFileRoute = await host.bridge.registerRoute('/cot/open-file', async (body) => {
    return await openFileInHost(body || {}, { openFileImpl: options.openFileImpl });
  });
  const stopCotTestApiRoute = await host.bridge.registerRoute('/cot/test-api', async (body) => {
    return await cotManager.testCustomEndpoint(body || {});
  }, { timeoutMs: 15000 });

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
  const stopToggleDisplayCmd = host.commands.register('zh-cn.toggle-thinking-display', async () => {
    const nextMode = config.thinkingDisplayMode === THINKING_DISPLAY_MODES.TRANSLATED
      ? THINKING_DISPLAY_MODES.BILINGUAL
      : THINKING_DISPLAY_MODES.TRANSLATED;
    const updated = await applyConfigPatch({ thinkingDisplayMode: nextMode }, true);
    return {
      ok: true,
      thinkingDisplayMode: updated.thinkingDisplayMode,
      message: updated.thinkingDisplayMode === THINKING_DISPLAY_MODES.TRANSLATED
        ? '已切换为沉浸式纯译文'
        : '已切换为双语上下对照'
    };
  });
  const stopTestApiCmd = host.commands.register('zh-cn.test-thinking-api', async (arg = {}) => {
    const res = await cotManager.testCustomEndpoint(arg && typeof arg === 'object' ? arg : {});
    return {
      ...res,
      message: res.ok
        ? `连接成功 (${res.model}, ${res.latencyMs}ms)`
        : `连接失败: ${res.error}`
    };
  });
  const stopListAgyModelsCmd = host.commands.register('zh-cn.list-antigravity-models', async (arg = {}) => {
    return await cotManager.listAntigravityModelOptions(arg && typeof arg === 'object' ? arg : {});
  });

  publishLangState();

  disposers.push(
    () => cotManager.dispose(),
    stopSettingsSub,
    stopSvc,
    stopCotTranslateRoute,
    stopCotPollRoute,
    stopCotCancelRoute,
    stopCotOpenFileRoute,
    stopCotTestApiRoute,
    stopToggleCmd,
    stopSetLangCmd,
    stopGetRendererStateCmd,
    stopTranslateTitlesCmd,
    stopToggleDisplayCmd,
    stopTestApiCmd,
    stopListAgyModelsCmd
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
  deactivate,
  THINKING_TARGET_LANG_FOLLOW
};
