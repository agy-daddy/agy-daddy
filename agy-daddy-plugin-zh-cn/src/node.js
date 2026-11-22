'use strict';

const {
  BRAND_TITLE_MODES,
  EXACT_DICTIONARY,
  REGEX_DICTIONARY,
  normalizeBrandTitleMode,
  parseCustomRules,
  translateText
} = require('./dictionary');

let disposers = [];

async function activate(host) {
  let config = {
    lang: 'zh',
    brandTitle: BRAND_TITLE_MODES.ENGLISH,
    englishLabels: false,
    enableRemoteThinkingTranslation: false,
    ...(host.storage.readJson('config.json', {}).data || {})
  };
  config.brandTitle = normalizeBrandTitleMode(config.brandTitle);

  let translationCache = host.storage.readJson('zh-translation-cache.json', {}).data || {};
  let customTitles = host.storage.readJson('custom-conversation-titles.json', {}).data || {};
  let customRulesRaw = [];

  function saveConfig(patch = {}) {
    config = {
      ...config,
      ...patch
    };
    config.brandTitle = normalizeBrandTitleMode(config.brandTitle);
    host.storage.writeJson('config.json', config);
    host.state.set('state:zh-cn.lang@1', {
      lang: config.lang,
      brandTitle: config.brandTitle,
      englishLabels: config.englishLabels,
      enableRemoteThinkingTranslation: config.enableRemoteThinkingTranslation
    });
    return { ...config };
  }

  const serviceMethods = {
    getDictionaryStats() {
      return {
        exactCount: EXACT_DICTIONARY.size,
        regexCount: REGEX_DICTIONARY.length
      };
    },
    getConfig() {
      return {
        ...config,
        customRules: customRulesRaw,
        titles: { ...customTitles },
        dictionaryStats: {
          exactCount: EXACT_DICTIONARY.size,
          regexCount: REGEX_DICTIONARY.length
        }
      };
    },
    setLang(nextLang) {
      const normalized = nextLang === 'en' ? 'en' : 'zh';
      return saveConfig({ lang: normalized });
    },
    setConfig(patch = {}) {
      if (Array.isArray(patch.customRules)) {
        customRulesRaw = patch.customRules;
      }
      return saveConfig(patch);
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

      const dictResult = translateText(raw, {
        englishLabels: config.englishLabels,
        brandTitle: config.brandTitle,
        customRules: parseCustomRules(customRulesRaw)
      });
      if (dictResult !== raw) {
        return { ok: true, text: dictResult, source: 'dictionary' };
      }

      if (translationCache[raw]) {
        return { ok: true, text: translationCache[raw], source: 'cache' };
      }

      const allowRemote = Boolean(config.enableRemoteThinkingTranslation || options.optInRemote === true);
      if (!allowRemote) {
        return {
          ok: false,
          blocked: true,
          reason: 'REMOTE_TRANSLATION_DISABLED',
          text: raw
        };
      }

      const targetLang = options.tl || 'zh-CN';
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(raw)}`;
      const resp = await host.net.fetch(url);
      if (!resp || resp.ok === false) {
        return { ok: false, error: `HTTP ${resp?.status || 'error'}`, text: raw };
      }
      const data = await resp.json();
      const translated = Array.isArray(data?.[0])
        ? data[0].map((seg) => (Array.isArray(seg) ? String(seg[0] || '') : '')).join('')
        : raw;

      if (translated && translated !== raw) {
        translationCache[raw] = translated;
        host.storage.writeJson('zh-translation-cache.json', translationCache);
      }
      return { ok: true, text: translated || raw, source: 'remote' };
    },
    async translateConversationTitle(cascadeId, rawTitle, options = {}) {
      const cid = String(cascadeId || '').trim();
      if (cid && customTitles[cid]) {
        return { ok: true, cascadeId: cid, title: customTitles[cid], source: 'custom' };
      }
      const res = await serviceMethods.translateSnippet(rawTitle, options);
      return { ...res, cascadeId: cid, title: res.text };
    }
  };

  const stopSvc = host.services.provide('zh-cn', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopCfgRoute = await host.bridge.registerRoute('/config', async () => serviceMethods.getConfig());
  const stopLangRoute = await host.bridge.registerRoute('/set-lang', async (body) => serviceMethods.setLang(body?.lang));
  const stopSetCfgRoute = await host.bridge.registerRoute('/set-config', async (body) => serviceMethods.setConfig(body || {}));
  const stopTransRoute = await host.bridge.registerRoute('/translate', async (body) => serviceMethods.translateSnippet(body?.text, body || {}));
  const stopTitleTransRoute = await host.bridge.registerRoute('/translate-title', async (body) => {
    return serviceMethods.translateConversationTitle(body?.cascadeId, body?.title, body || {});
  });
  const stopDictStatsRoute = await host.bridge.registerRoute('/dictionary-stats', async () => serviceMethods.getDictionaryStats());
  const stopTitlesRoute = await host.bridge.registerRoute('/titles', async (body) => {
    if (body?.action === 'set') return serviceMethods.setCustomTitle(body.cascadeId, body.title);
    return { titles: { ...customTitles } };
  });

  saveConfig({});
  disposers.push(
    stopSvc,
    stopCfgRoute,
    stopLangRoute,
    stopSetCfgRoute,
    stopTransRoute,
    stopTitleTransRoute,
    stopDictStatsRoute,
    stopTitlesRoute
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
