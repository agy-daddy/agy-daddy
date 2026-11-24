'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LANG = 'zh';

const SUPPORTED_LANGUAGES = Object.freeze([
  Object.freeze({
    code: 'zh',
    bcp47: 'zh-CN',
    nativeName: '简体中文',
    zhName: '简体中文',
    enName: 'Simplified Chinese',
    shortLabel: '中',
    googleTl: 'zh-CN',
    brandTranslated: '反重力',
    dataFile: 'zh-CN.json',
    aliases: ['zh', 'zh-cn', 'zh_cn', 'zh-hans', 'cn']
  }),
  Object.freeze({
    code: 'zh-TW',
    bcp47: 'zh-TW',
    nativeName: '繁體中文',
    zhName: '繁体中文',
    enName: 'Traditional Chinese',
    shortLabel: '繁',
    googleTl: 'zh-TW',
    brandTranslated: '反重力',
    dataFile: 'zh-TW.json',
    aliases: ['zh-tw', 'zh_tw', 'zh-hant', 'zh-hk', 'zh_hk', 'tw', 'hk']
  }),
  Object.freeze({
    code: 'ja',
    bcp47: 'ja',
    nativeName: '日本語',
    zhName: '日语',
    enName: 'Japanese',
    shortLabel: '日',
    googleTl: 'ja',
    brandTranslated: 'アンチグラビティ',
    dataFile: 'ja.json',
    aliases: ['ja', 'ja-jp', 'ja_jp', 'jp']
  }),
  Object.freeze({
    code: 'ko',
    bcp47: 'ko',
    nativeName: '한국어',
    zhName: '韩语',
    enName: 'Korean',
    shortLabel: '한',
    googleTl: 'ko',
    brandTranslated: '안티그래비티',
    dataFile: 'ko.json',
    aliases: ['ko', 'ko-kr', 'ko_kr', 'kr']
  }),
  Object.freeze({
    code: 'es',
    bcp47: 'es',
    nativeName: 'Español',
    zhName: '西班牙语',
    enName: 'Spanish',
    shortLabel: 'ES',
    googleTl: 'es',
    brandTranslated: 'Antigravedad',
    dataFile: 'es.json',
    aliases: ['es', 'es-es', 'es_es', 'es-419', 'es-mx']
  }),
  Object.freeze({
    code: 'pt',
    bcp47: 'pt',
    nativeName: 'Português',
    zhName: '葡萄牙语',
    enName: 'Portuguese',
    shortLabel: 'PT',
    googleTl: 'pt',
    brandTranslated: 'Antigravidade',
    dataFile: 'pt.json',
    aliases: ['pt', 'pt-br', 'pt_br', 'pt-pt', 'pt_pt']
  }),
  Object.freeze({
    code: 'fr',
    bcp47: 'fr',
    nativeName: 'Français',
    zhName: '法语',
    enName: 'French',
    shortLabel: 'FR',
    googleTl: 'fr',
    brandTranslated: 'Antigravité',
    dataFile: 'fr.json',
    aliases: ['fr', 'fr-fr', 'fr_fr', 'fr-ca']
  }),
  Object.freeze({
    code: 'ru',
    bcp47: 'ru',
    nativeName: 'Русский',
    zhName: '俄语',
    enName: 'Russian',
    shortLabel: 'RU',
    googleTl: 'ru',
    brandTranslated: 'Антигравитация',
    dataFile: 'ru.json',
    aliases: ['ru', 'ru-ru', 'ru_ru']
  }),
  Object.freeze({
    code: 'it',
    bcp47: 'it',
    nativeName: 'Italiano',
    zhName: '意大利语',
    enName: 'Italian',
    shortLabel: 'IT',
    googleTl: 'it',
    brandTranslated: 'Antigravità',
    dataFile: 'it.json',
    aliases: ['it', 'it-it', 'it_it']
  }),
  Object.freeze({
    code: 'en',
    bcp47: 'en',
    nativeName: 'English',
    zhName: '英文 (原文)',
    enName: 'English (Original)',
    shortLabel: 'EN',
    googleTl: 'en',
    brandTranslated: 'Antigravity',
    dataFile: null,
    aliases: ['en', 'en-us', 'en_us', 'en-gb', 'en_gb']
  })
]);

const LANGUAGE_MAP = Object.freeze(
  SUPPORTED_LANGUAGES.reduce((acc, item) => {
    acc[item.code] = item;
    return acc;
  }, {})
);

const ALIAS_TO_LANG = new Map();
for (const item of SUPPORTED_LANGUAGES) {
  ALIAS_TO_LANG.set(item.code.toLowerCase(), item.code);
  ALIAS_TO_LANG.set(item.bcp47.toLowerCase(), item.code);
  for (const a of item.aliases) {
    ALIAS_TO_LANG.set(String(a).toLowerCase(), item.code);
  }
}

function normalizeLang(raw, fallback = DEFAULT_LANG) {
  if (typeof raw === 'string') {
    const clean = raw.trim().toLowerCase().replace(/_/g, '-');
    if (ALIAS_TO_LANG.has(clean)) return ALIAS_TO_LANG.get(clean);
    const primary = clean.split('-')[0];
    if (primary && ALIAS_TO_LANG.has(primary)) return ALIAS_TO_LANG.get(primary);
  }
  const fb = typeof fallback === 'string' ? fallback.trim().toLowerCase() : DEFAULT_LANG;
  return ALIAS_TO_LANG.get(fb) || DEFAULT_LANG;
}

function getLanguageMeta(lang) {
  const code = normalizeLang(lang, DEFAULT_LANG);
  return LANGUAGE_MAP[code] || LANGUAGE_MAP[DEFAULT_LANG];
}

const ENGLISH_LABELS_PRESET = new Set([
  'This Conversation',
  'Request Review',
  'Default',
  'Auto',
  'Turbo',
  'High',
  'Medium',
  'Low'
].map((s) => s.toLowerCase()));

const BRAND_TITLE_MODES = Object.freeze({
  ENGLISH: 'english',
  HIDDEN: 'hidden',
  TRANSLATED: 'translated'
});

const FALLBACK_EXACT_BY_LANG = {
  zh: {
    'New Chat': '新建对话',
    'New Conversation': '新建对话',
    'Ask anything': '尽管提问',
    'Review Changes': '审查更改',
    'Accept All': '全部接受',
    'Reject All': '全部拒绝',
    'Accept': '接受',
    'Reject': '拒绝',
    'Run command': '运行命令',
    'Thought for': '已思考',
    'Thinking': '思考中',
    'Planning': '规划模式',
    'Fast': '快速模式',
    'Default': '默认',
    'Request Review': '请求审查',
    'This Conversation': '仅限本对话',
    'Auto': '自动',
    'Turbo': '无限',
    'High': '高',
    'Medium': '中',
    'Low': '低',
    'Settings': '设置',
    'Copy': '复制',
    'Copied': '已复制',
    'Cancel': '取消',
    'Submit': '发送',
    'Send': '发送'
  },
  'zh-TW': {
    'New Chat': '新增對話',
    'New Conversation': '新增對話',
    'Ask anything': '儘管提問',
    'Review Changes': '審查變更',
    'Accept All': '全部接受',
    'Reject All': '全部拒絕',
    'Accept': '接受',
    'Reject': '拒絕',
    'Run command': '執行命令',
    'Thought for': '已思考',
    'Thinking': '思考中',
    'Planning': '規劃模式',
    'Fast': '快速模式',
    'Default': '預設',
    'Request Review': '請求審查',
    'This Conversation': '僅限本對話',
    'Auto': '自動',
    'Turbo': '無限',
    'High': '高',
    'Medium': '中',
    'Low': '低',
    'Settings': '設定',
    'Copy': '複製',
    'Copied': '已複製',
    'Cancel': '取消',
    'Submit': '送出',
    'Send': '傳送'
  },
  ja: {
    'New Chat': '新しいチャット',
    'New Conversation': '新しい会話',
    'Ask anything': '何でも質問してください',
    'Review Changes': '変更をレビュー',
    'Accept All': 'すべて承認',
    'Reject All': 'すべて拒否',
    'Accept': '承認',
    'Reject': '拒否',
    'Run command': 'コマンドを実行',
    'Thought for': '思考時間',
    'Thinking': '思考中',
    'Planning': 'プランニングモード',
    'Fast': '高速モード',
    'Default': 'デフォルト',
    'Request Review': 'レビューをリクエスト',
    'This Conversation': 'この会話のみ',
    'Auto': '自動',
    'Turbo': 'ターボ',
    'High': '高',
    'Medium': '中',
    'Low': '低',
    'Settings': '設定',
    'Copy': 'コピー',
    'Copied': 'コピーしました',
    'Cancel': 'キャンセル',
    'Submit': '送信',
    'Send': '送信'
  },
  ko: {
    'New Chat': '새 채팅',
    'New Conversation': '새 대화',
    'Ask anything': '무엇이든 질문하세요',
    'Review Changes': '변경 사항 검토',
    'Accept All': '모두 수락',
    'Reject All': '모두 거부',
    'Accept': '수락',
    'Reject': '거부',
    'Run command': '명령 실행',
    'Thought for': '생각 시간',
    'Thinking': '생각하는 중',
    'Planning': '계획 모드',
    'Fast': '빠른 모드',
    'Default': '기본값',
    'Request Review': '검토 요청',
    'This Conversation': '이 대화만',
    'Auto': '자동',
    'Turbo': '터보',
    'High': '높음',
    'Medium': '중간',
    'Low': '낮음',
    'Settings': '설정',
    'Copy': '복사',
    'Copied': '복사됨',
    'Cancel': '취소',
    'Submit': '전송',
    'Send': '전송'
  },
  es: {
    'New Chat': 'Nuevo chat',
    'New Conversation': 'Nueva conversación',
    'Ask anything': 'Pregunta lo que quieras',
    'Review Changes': 'Revisar cambios',
    'Accept All': 'Aceptar todo',
    'Reject All': 'Rechazar todo',
    'Accept': 'Aceptar',
    'Reject': 'Rechazar',
    'Run command': 'Ejecutar comando',
    'Thought for': 'Pensó durante',
    'Thinking': 'Pensando',
    'Planning': 'Modo planificación',
    'Fast': 'Modo rápido',
    'Default': 'Predeterminado',
    'Request Review': 'Solicitar revisión',
    'This Conversation': 'Esta conversación',
    'Auto': 'Automático',
    'Turbo': 'Turbo',
    'High': 'Alto',
    'Medium': 'Medio',
    'Low': 'Bajo',
    'Settings': 'Configuración',
    'Copy': 'Copiar',
    'Copied': 'Copiado',
    'Cancel': 'Cancelar',
    'Submit': 'Enviar',
    'Send': 'Enviar'
  },
  pt: {
    'New Chat': 'Novo chat',
    'New Conversation': 'Nova conversa',
    'Ask anything': 'Pergunte qualquer coisa',
    'Review Changes': 'Revisar alterações',
    'Accept All': 'Aceitar tudo',
    'Reject All': 'Rejeitar tudo',
    'Accept': 'Aceitar',
    'Reject': 'Rejeitar',
    'Run command': 'Executar comando',
    'Thought for': 'Pensou por',
    'Thinking': 'Pensando',
    'Planning': 'Modo de planejamento',
    'Fast': 'Modo rápido',
    'Default': 'Padrão',
    'Request Review': 'Solicitar revisão',
    'This Conversation': 'Esta conversa',
    'Auto': 'Automático',
    'Turbo': 'Turbo',
    'High': 'Alto',
    'Medium': 'Médio',
    'Low': 'Baixo',
    'Settings': 'Configurações',
    'Copy': 'Copiar',
    'Copied': 'Copiado',
    'Cancel': 'Cancelar',
    'Submit': 'Enviar',
    'Send': 'Enviar'
  },
  fr: {
    'New Chat': 'Nouvelle discussion',
    'New Conversation': 'Nouvelle conversation',
    'Ask anything': 'Posez n’importe quelle question',
    'Review Changes': 'Examiner les modifications',
    'Accept All': 'Tout accepter',
    'Reject All': 'Tout refuser',
    'Accept': 'Accepter',
    'Reject': 'Refuser',
    'Run command': 'Exécuter la commande',
    'Thought for': 'A réfléchi pendant',
    'Thinking': 'Réflexion en cours',
    'Planning': 'Mode planification',
    'Fast': 'Mode rapide',
    'Default': 'Par défaut',
    'Request Review': 'Demander une révision',
    'This Conversation': 'Cette conversation',
    'Auto': 'Automatique',
    'Turbo': 'Turbo',
    'High': 'Élevé',
    'Medium': 'Moyen',
    'Low': 'Faible',
    'Settings': 'Paramètres',
    'Copy': 'Copier',
    'Copied': 'Copié',
    'Cancel': 'Annuler',
    'Submit': 'Envoyer',
    'Send': 'Envoyer'
  },
  ru: {
    'New Chat': 'Новый чат',
    'New Conversation': 'Новый диалог',
    'Ask anything': 'Спросите что угодно',
    'Review Changes': 'Проверить изменения',
    'Accept All': 'Принять все',
    'Reject All': 'Отклонить все',
    'Accept': 'Принять',
    'Reject': 'Отклонить',
    'Run command': 'Выполнить команду',
    'Thought for': 'Размышлял',
    'Thinking': 'Размышление',
    'Planning': 'Режим планирования',
    'Fast': 'Быстрый режим',
    'Default': 'По умолчанию',
    'Request Review': 'Запросить проверку',
    'This Conversation': 'Только этот диалог',
    'Auto': 'Авто',
    'Turbo': 'Турбо',
    'High': 'Высокий',
    'Medium': 'Средний',
    'Low': 'Низкий',
    'Settings': 'Настройки',
    'Copy': 'Копировать',
    'Copied': 'Скопировано',
    'Cancel': 'Отмена',
    'Submit': 'Отправить',
    'Send': 'Отправить'
  },
  it: {
    'New Chat': 'Nuova chat',
    'New Conversation': 'Nuova conversazione',
    'Ask anything': 'Chiedi qualsiasi cosa',
    'Review Changes': 'Esamina modifiche',
    'Accept All': 'Accetta tutto',
    'Reject All': 'Rifiuta tutto',
    'Accept': 'Accetta',
    'Reject': 'Rifiuta',
    'Run command': 'Esegui comando',
    'Thought for': 'Ha riflettuto per',
    'Thinking': 'Riflessione in corso',
    'Planning': 'Modalità pianificazione',
    'Fast': 'Modalità rapida',
    'Default': 'Predefinito',
    'Request Review': 'Richiedi revisione',
    'This Conversation': 'Questa conversazione',
    'Auto': 'Automatico',
    'Turbo': 'Turbo',
    'High': 'Alto',
    'Medium': 'Medio',
    'Low': 'Basso',
    'Settings': 'Impostazioni',
    'Copy': 'Copia',
    'Copied': 'Copiato',
    'Cancel': 'Annulla',
    'Submit': 'Invia',
    'Send': 'Invia'
  }
};

function makeFallbackPatterns(lang) {
  const tpl = {
    zh: [(_, n) => `已思考 ${n} 秒`, (_, n) => `已查阅 ${n} 个文件`, (_, n) => `已修改 ${n} 个文件`],
    'zh-TW': [(_, n) => `已思考 ${n} 秒`, (_, n) => `已查閱 ${n} 個檔案`, (_, n) => `已修改 ${n} 個檔案`],
    ja: [(_, n) => `${n} 秒思考しました`, (_, n) => `${n} 個のファイルを確認しました`, (_, n) => `${n} 個のファイルを編集しました`],
    ko: [(_, n) => `${n}초 동안 생각함`, (_, n) => `파일 ${n}개 검토됨`, (_, n) => `파일 ${n}개 수정됨`],
    es: [(_, n) => `Pensó durante ${n} s`, (_, n) => `Se revisaron ${n} archivos`, (_, n) => `Se editaron ${n} archivos`],
    pt: [(_, n) => `Pensou por ${n} s`, (_, n) => `${n} arquivos analisados`, (_, n) => `${n} arquivos editados`],
    fr: [(_, n) => `A réfléchi pendant ${n} s`, (_, n) => `${n} fichiers examinés`, (_, n) => `${n} fichiers modifiés`],
    ru: [(_, n) => `Размышлял ${n} с`, (_, n) => `Просмотрено файлов: ${n}`, (_, n) => `Изменено файлов: ${n}`],
    it: [(_, n) => `Ha riflettuto per ${n} s`, (_, n) => `${n} file esaminati`, (_, n) => `${n} file modificati`]
  }[lang];
  if (!tpl) return [];
  return [
    {
      source: '^Thought\\s+for\\s+(\\d+(?:\\.\\d+)?)\\s*(?:sec|seconds?)$',
      re: /^Thought\s+for\s+(\d+(?:\.\d+)?)\s*(?:sec|seconds?)$/i,
      replace: tpl[0]
    },
    {
      source: '^Reviewed\\s+(\\d+)\\s+files?$',
      re: /^Reviewed\s+(\d+)\s+files?$/i,
      replace: tpl[1]
    },
    {
      source: '^Edited\\s+(\\d+)\\s+files?$',
      re: /^Edited\s+(\d+)\s+files?$/i,
      replace: tpl[2]
    }
  ];
}

function loadJsonFallback(fileName) {
  try {
    const p = path.resolve(__dirname, '..', 'data', fileName);
    if (fs && typeof fs.existsSync === 'function' && fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}
  return { exact: {}, patterns: [] };
}

// IMPORTANT: Static require literals are required so bundlePluginRendererSource()
// in agy-daddy-host/src/core/injector.js can statically detect and inline all packs.
const PACK_LOADERS = {
  zh: () => {
    try { const r = require('../data/zh-CN.json'); if (r && typeof r === 'object') return r; } catch {}
    return loadJsonFallback('zh-CN.json');
  },
  'zh-TW': () => {
    try { const r = require('../data/zh-TW.json'); if (r && typeof r === 'object') return r; } catch {}
    return loadJsonFallback('zh-TW.json');
  },
  ja: () => {
    try { const r = require('../data/ja.json'); if (r && typeof r === 'object') return r; } catch {}
    return loadJsonFallback('ja.json');
  },
  ko: () => {
    try { const r = require('../data/ko.json'); if (r && typeof r === 'object') return r; } catch {}
    return loadJsonFallback('ko.json');
  },
  es: () => {
    try { const r = require('../data/es.json'); if (r && typeof r === 'object') return r; } catch {}
    return loadJsonFallback('es.json');
  },
  pt: () => {
    try { const r = require('../data/pt.json'); if (r && typeof r === 'object') return r; } catch {}
    return loadJsonFallback('pt.json');
  },
  fr: () => {
    try { const r = require('../data/fr.json'); if (r && typeof r === 'object') return r; } catch {}
    return loadJsonFallback('fr.json');
  },
  ru: () => {
    try { const r = require('../data/ru.json'); if (r && typeof r === 'object') return r; } catch {}
    return loadJsonFallback('ru.json');
  },
  it: () => {
    try { const r = require('../data/it.json'); if (r && typeof r === 'object') return r; } catch {}
    return loadJsonFallback('it.json');
  }
};

const SUB_FRAGMENT_REGEX_SOURCES = new Set([
  '(\\d+) days?, (\\d+) hours?',
  '(\\d+) hours?, (\\d+) minutes?',
  '(\\d+) days?',
  '(\\d+) hours?',
  '(\\d+) minutes?'
]);

function isSubFragmentRuleSource(source) {
  if (!source || source.startsWith('^')) return false;
  if (SUB_FRAGMENT_REGEX_SOURCES.has(source)) return true;
  if (/^\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|AM|PM)\\b/.test(source)) return true;
  if (source.includes('AM\\b') || source.includes('PM\\b')) return true;
  return false;
}

function compilePatternRules(patterns = []) {
  const rules = [];
  for (const p of patterns) {
    if (!p || typeof p.regex !== 'string' || typeof p.replacement !== 'string') continue;
    try {
      const re = new RegExp(p.regex, typeof p.flags === 'string' ? p.flags : '');
      rules.push({
        source: p.regex,
        re,
        replace: p.replacement,
        isSubFragment: isSubFragmentRuleSource(p.regex)
      });
    } catch {}
  }
  return rules;
}

const compiledDictCache = new Map();

function getLanguageDictionary(lang = DEFAULT_LANG) {
  const code = normalizeLang(lang, DEFAULT_LANG);
  if (compiledDictCache.has(code)) {
    return compiledDictCache.get(code);
  }
  if (code === 'en') {
    const emptyDict = {
      lang: 'en',
      exactMap: new Map(),
      exactLowerMap: new Map(),
      regexRules: [],
      primaryRegexRules: [],
      subFragmentRegexRules: []
    };
    compiledDictCache.set('en', emptyDict);
    return emptyDict;
  }

  const loader = PACK_LOADERS[code];
  const rawPack = typeof loader === 'function' ? loader() : { exact: {}, patterns: [] };
  const fallbackExact = FALLBACK_EXACT_BY_LANG[code] || {};
  const exactMap = new Map(Object.entries({
    ...fallbackExact,
    ...(rawPack && rawPack.exact && typeof rawPack.exact === 'object' ? rawPack.exact : {})
  }));

  const exactLowerMap = new Map();
  for (const [k, v] of exactMap.entries()) {
    const lower = String(k).toLowerCase();
    if (!exactLowerMap.has(lower)) {
      exactLowerMap.set(lower, v);
    }
  }

  const regexRules = [
    ...compilePatternRules(Array.isArray(rawPack?.patterns) ? rawPack.patterns : []),
    ...makeFallbackPatterns(code)
  ];
  const primaryRegexRules = regexRules.filter((r) => !r.isSubFragment);
  const subFragmentRegexRules = regexRules.filter((r) => r.isSubFragment);

  const compiled = {
    lang: code,
    exactMap,
    exactLowerMap,
    regexRules,
    primaryRegexRules,
    subFragmentRegexRules
  };
  compiledDictCache.set(code, compiled);
  return compiled;
}

const defaultZhDict = getLanguageDictionary('zh');
const EXACT_DICTIONARY = defaultZhDict.exactMap;
const REGEX_DICTIONARY = defaultZhDict.regexRules;

function getDictionaryStats(lang = DEFAULT_LANG) {
  if (lang === 'all') {
    const languages = SUPPORTED_LANGUAGES.map((meta) => {
      if (meta.code === 'en') {
        return { lang: 'en', exactCount: 0, regexCount: 0 };
      }
      const d = getLanguageDictionary(meta.code);
      return {
        lang: meta.code,
        exactCount: d.exactMap.size,
        regexCount: d.regexRules.length
      };
    });
    return {
      defaultLang: DEFAULT_LANG,
      totalLanguages: SUPPORTED_LANGUAGES.length,
      languages
    };
  }
  const code = normalizeLang(lang, DEFAULT_LANG);
  const d = getLanguageDictionary(code);
  return {
    lang: code,
    exactCount: d.exactMap.size,
    regexCount: d.regexRules.length
  };
}

function isProtectedPathOrCode(text, exactMap = EXACT_DICTIONARY) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  if (/^(?:https?|wss?|file|mailto|data):\/\//i.test(trimmed)) return true;
  if (/^(?:\/|~\/|\.\.?\/)[A-Za-z0-9._/@-]+$/.test(trimmed)) return true;
  if (/^[A-Za-z]:\\/.test(trimmed)) return true;
  if (/^(?:git|npm|pnpm|yarn|node|python3?|bash|zsh|curl|cd|ls)\s+\S+/.test(trimmed) && !exactMap.has(trimmed)) {
    return true;
  }
  return false;
}

function parseCustomRules(rawTextOrPairs) {
  const map = new Map();
  if (Array.isArray(rawTextOrPairs)) {
    for (const item of rawTextOrPairs) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const src = String(item[0] ?? '').trim().toLowerCase();
      const dst = String(item[1] ?? '').trim();
      if (src) map.set(src, dst);
    }
    return map;
  }
  if (typeof rawTextOrPairs === 'string') {
    for (const line of rawTextOrPairs.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith('#')) continue;
      const sep = clean.includes('=>') ? '=>' : (clean.includes('=') ? '=' : null);
      if (!sep) continue;
      const idx = clean.indexOf(sep);
      const src = clean.slice(0, idx).trim().toLowerCase();
      const dst = clean.slice(idx + sep.length).trim();
      if (src) map.set(src, dst);
    }
  }
  return map;
}

function normalizeBrandTitleMode(mode) {
  if (mode === BRAND_TITLE_MODES.HIDDEN || mode === BRAND_TITLE_MODES.TRANSLATED) return mode;
  return BRAND_TITLE_MODES.ENGLISH;
}

function translateBrandTitle(raw, brandTitle = BRAND_TITLE_MODES.ENGLISH, lang = DEFAULT_LANG) {
  const trimmed = String(raw || '').trim();
  if (!/^antigravity$/i.test(trimmed)) return null;
  const mode = normalizeBrandTitleMode(brandTitle);
  if (mode === BRAND_TITLE_MODES.HIDDEN) return '';
  if (mode === BRAND_TITLE_MODES.TRANSLATED) {
    const meta = getLanguageMeta(lang);
    return meta.brandTranslated || trimmed;
  }
  return trimmed;
}

function translateText(raw, options = {}) {
  const input = String(raw ?? '');
  const trimmed = input.trim();
  if (!trimmed) return input;

  const lang = normalizeLang(options.lang, DEFAULT_LANG);
  const meta = getLanguageMeta(lang);

  // 左上角品牌标题优先处理（保留英文 / 显示本地化品牌名 / 隐藏）
  if (/^antigravity$/i.test(trimmed)) {
    const mode = normalizeBrandTitleMode(options.brandTitle);
    if (mode === BRAND_TITLE_MODES.HIDDEN) return '';
    if (mode === BRAND_TITLE_MODES.TRANSLATED) {
      const targetBrand = meta.brandTranslated || trimmed;
      if (targetBrand === trimmed) return input;
      const lead = input.slice(0, input.indexOf(trimmed));
      const tail = input.slice(input.indexOf(trimmed) + trimmed.length);
      return `${lead}${targetBrand}${tail}`;
    }
    if (options.brandTitle !== undefined) return input;
  }

  if (lang === 'en') {
    return input;
  }

  const dict = getLanguageDictionary(lang);
  const customRules = options.customRules instanceof Map
    ? options.customRules
    : parseCustomRules(options.customRules);
  const lower = trimmed.toLowerCase();

  let translated = null;

  // 1. 个人自定义规则最高优先级（空译文代表保留英文原文）
  if (customRules.has(lower)) {
    const customTarget = customRules.get(lower);
    if (!customTarget) return input;
    translated = customTarget;
  }

  // 2. 路径 / URI / 命令保护，避免误翻代码片段或本地文件路径
  if (translated === null && isProtectedPathOrCode(trimmed, dict.exactMap)) {
    return input;
  }

  // 3. 选项名保留英文开关
  if (translated === null && options.englishLabels && ENGLISH_LABELS_PRESET.has(lower)) {
    return input;
  }

  // 4. 精确词典（先精确大小写命中，再大小写不敏感命中）
  if (translated === null && dict.exactMap.has(trimmed)) {
    translated = dict.exactMap.get(trimmed);
  } else if (translated === null && dict.exactLowerMap.has(lower)) {
    translated = dict.exactLowerMap.get(lower);
  }

  // 5. 正则规则（两阶段级联：主规则优先整句匹配，随后替换嵌套时长/月份/AM-PM子片段）
  if (translated === null) {
    const primaries = dict.primaryRegexRules || dict.regexRules;
    for (const rule of primaries) {
      if (rule.re.test(trimmed)) {
        translated = trimmed.replace(rule.re, rule.replace);
        break;
      }
    }
    const candidate = translated !== null ? translated : trimmed;
    const subRules = dict.subFragmentRegexRules || [];
    if (
      subRules.length > 0 &&
      /(?:\d\s*(?:days?|hours?|minutes?)|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|AM|PM)\b)/i.test(candidate)
    ) {
      let cascaded = candidate;
      let pairDurationMatched = false;
      for (const subRule of subRules) {
        const isPair = subRule.source === '(\\d+) days?, (\\d+) hours?' || subRule.source === '(\\d+) hours?, (\\d+) minutes?';
        const isSingleDur = subRule.source === '(\\d+) days?' || subRule.source === '(\\d+) hours?' || subRule.source === '(\\d+) minutes?';
        if (isSingleDur && pairDurationMatched && !/\d+\s+(?:days?|hours?|minutes?)(?!\()\b/i.test(cascaded)) {
          continue;
        }
        if (subRule.re.test(cascaded)) {
          cascaded = cascaded.replace(subRule.re, subRule.replace);
          if (isPair) pairDurationMatched = true;
        }
      }
      if (cascaded !== candidate) {
        translated = cascaded;
      }
    }
  }

  if (translated === null || translated === trimmed) return input;
  const lead = input.slice(0, input.indexOf(trimmed));
  const tail = input.slice(input.indexOf(trimmed) + trimmed.length);
  return `${lead}${translated}${tail}`;
}

module.exports = {
  DEFAULT_LANG,
  SUPPORTED_LANGUAGES,
  LANGUAGE_MAP,
  ENGLISH_LABELS_PRESET,
  BRAND_TITLE_MODES,
  EXACT_DICTIONARY,
  REGEX_DICTIONARY,
  normalizeLang,
  getLanguageMeta,
  getLanguageDictionary,
  getDictionaryStats,
  isProtectedPathOrCode,
  normalizeBrandTitleMode,
  translateBrandTitle,
  parseCustomRules,
  translateText
};
