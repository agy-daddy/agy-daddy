'use strict';

const THINKING_TRANSLATION_MODES = Object.freeze({
  OFF: 'off',
  FREE: 'free',
  ANTIGRAVITY: 'antigravity',
  CUSTOM_API: 'custom_api'
});

const THINKING_DISPLAY_MODES = Object.freeze({
  BILINGUAL: 'bilingual',
  TRANSLATED: 'translated'
});

const THINKING_TARGET_LANG_FOLLOW = 'follow';
const DEFAULT_THINKING_API_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_THINKING_API_MODEL = 'qwen2.5:7b';

const COT_OVERLAY_I18N = Object.freeze({
  zh: {
    modeFree: '免配置机翻',
    modeAntigravity: 'Antigravity 模型',
    modeCustomApi: 'AI 流式转译',
    displayBilingual: '双语对照',
    displayTranslated: '纯译文',
    switchToTranslated: '切换纯译文',
    switchToBilingual: '切换双语对照',
    statusStreaming: '流式转译中…',
    statusPartialError: '部分段落转译失败',
    statusDone: '已转译',
    translatingSegment: '正在转译…',
    failedPrefix: '[转译失败]',
    jumpTitlePrefix: '点击定位源码'
  },
  'zh-TW': {
    modeFree: '免設定機翻',
    modeAntigravity: 'Antigravity 模型',
    modeCustomApi: 'AI 串流轉譯',
    displayBilingual: '雙語對照',
    displayTranslated: '純譯文',
    switchToTranslated: '切換純譯文',
    switchToBilingual: '切換雙語對照',
    statusStreaming: '串流轉譯中…',
    statusPartialError: '部分段落轉譯失敗',
    statusDone: '已轉譯',
    translatingSegment: '正在轉譯…',
    failedPrefix: '[轉譯失敗]',
    jumpTitlePrefix: '點擊定位原始碼'
  },
  ja: {
    modeFree: '機械翻訳',
    modeAntigravity: 'Antigravity モデル',
    modeCustomApi: 'AI ストリーム翻訳',
    displayBilingual: '対訳表示',
    displayTranslated: '翻訳のみ',
    switchToTranslated: '翻訳のみに切替',
    switchToBilingual: '対訳表示に切替',
    statusStreaming: '翻訳ストリーミング中…',
    statusPartialError: '一部の段落で翻訳に失敗',
    statusDone: '翻訳済み',
    translatingSegment: '翻訳中…',
    failedPrefix: '[翻訳失敗]',
    jumpTitlePrefix: 'ソースを開く'
  },
  ko: {
    modeFree: '기계 번역',
    modeAntigravity: 'Antigravity 모델',
    modeCustomApi: 'AI 스트리밍 번역',
    displayBilingual: '이중 언어',
    displayTranslated: '번역만',
    switchToTranslated: '번역만 보기',
    switchToBilingual: '이중 언어 보기',
    statusStreaming: '스트리밍 번역 중…',
    statusPartialError: '일부 단락 번역 실패',
    statusDone: '번역 완료',
    translatingSegment: '번역 중…',
    failedPrefix: '[번역 실패]',
    jumpTitlePrefix: '소스 위치로 이동'
  },
  es: {
    modeFree: 'Traducción auto',
    modeAntigravity: 'Modelo Antigravity',
    modeCustomApi: 'Traducción IA',
    displayBilingual: 'Bilingüe',
    displayTranslated: 'Solo traducción',
    switchToTranslated: 'Solo traducción',
    switchToBilingual: 'Modo bilingüe',
    statusStreaming: 'Traduciendo en streaming…',
    statusPartialError: 'Error en algunos párrafos',
    statusDone: 'Traducido',
    translatingSegment: 'Traduciendo…',
    failedPrefix: '[Error de traducción]',
    jumpTitlePrefix: 'Abrir origen'
  },
  pt: {
    modeFree: 'Tradução auto',
    modeAntigravity: 'Modelo Antigravity',
    modeCustomApi: 'Tradução IA',
    displayBilingual: 'Bilíngue',
    displayTranslated: 'Só tradução',
    switchToTranslated: 'Só tradução',
    switchToBilingual: 'Modo bilíngue',
    statusStreaming: 'Traduzindo em streaming…',
    statusPartialError: 'Falha em alguns parágrafos',
    statusDone: 'Traduzido',
    translatingSegment: 'Traduzindo…',
    failedPrefix: '[Falha na tradução]',
    jumpTitlePrefix: 'Abrir origem'
  },
  fr: {
    modeFree: 'Traduction auto',
    modeAntigravity: 'Modèle Antigravity',
    modeCustomApi: 'Traduction IA',
    displayBilingual: 'Bilingue',
    displayTranslated: 'Traduction seule',
    switchToTranslated: 'Traduction seule',
    switchToBilingual: 'Mode bilingue',
    statusStreaming: 'Traduction en streaming…',
    statusPartialError: 'Échec sur certains paragraphes',
    statusDone: 'Traduit',
    translatingSegment: 'Traduction…',
    failedPrefix: '[Échec de traduction]',
    jumpTitlePrefix: 'Ouvrir la source'
  },
  ru: {
    modeFree: 'Машинный перевод',
    modeAntigravity: 'Модель Antigravity',
    modeCustomApi: 'Поток ИИ',
    displayBilingual: 'Двуязычный',
    displayTranslated: 'Только перевод',
    switchToTranslated: 'Только перевод',
    switchToBilingual: 'Двуязычный',
    statusStreaming: 'Потоковый перевод…',
    statusPartialError: 'Ошибка в части абзацев',
    statusDone: 'Переведено',
    translatingSegment: 'Перевод…',
    failedPrefix: '[Ошибка перевода]',
    jumpTitlePrefix: 'Перейти к коду'
  },
  it: {
    modeFree: 'Traduzione auto',
    modeAntigravity: 'Modello Antigravity',
    modeCustomApi: 'Traduzione IA',
    displayBilingual: 'Bilingue',
    displayTranslated: 'Solo traduzione',
    switchToTranslated: 'Solo traduzione',
    switchToBilingual: 'Modalità bilingue',
    statusStreaming: 'Traduzione in streaming…',
    statusPartialError: 'Errore in alcuni paragrafi',
    statusDone: 'Tradotto',
    translatingSegment: 'Traduzione…',
    failedPrefix: '[Errore di traduzione]',
    jumpTitlePrefix: 'Apri sorgente'
  },
  en: {
    modeFree: 'Machine Translation',
    modeAntigravity: 'Antigravity Model',
    modeCustomApi: 'AI Stream',
    displayBilingual: 'Bilingual',
    displayTranslated: 'Translated Only',
    switchToTranslated: 'Translated Only',
    switchToBilingual: 'Bilingual View',
    statusStreaming: 'Streaming translation…',
    statusPartialError: 'Some segments failed',
    statusDone: 'Translated',
    translatingSegment: 'Translating…',
    failedPrefix: '[Translation failed]',
    jumpTitlePrefix: 'Jump to source'
  }
});

function getCotOverlayLabels(lang = 'zh') {
  return COT_OVERLAY_I18N[lang] || COT_OVERLAY_I18N.zh;
}

function normalizeThinkingTranslationMode(raw, legacyRemoteFlag = false) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'off' || s === 'disabled' || s === 'none') return THINKING_TRANSLATION_MODES.OFF;
  if (s === 'free' || s === 'mt' || s === 'machine' || s === 'google') return THINKING_TRANSLATION_MODES.FREE;
  if (s === 'antigravity' || s === 'agy' || s === 'host' || s === 'rpc') return THINKING_TRANSLATION_MODES.ANTIGRAVITY;
  if (s === 'custom_api' || s === 'custom' || s === 'api' || s === 'openai' || s === 'llm') {
    return THINKING_TRANSLATION_MODES.CUSTOM_API;
  }
  return legacyRemoteFlag ? THINKING_TRANSLATION_MODES.FREE : THINKING_TRANSLATION_MODES.OFF;
}

function normalizeThinkingDisplayMode(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'translated' || s === 'immersive' || s === 'translation_only' || s === 'pure') {
    return THINKING_DISPLAY_MODES.TRANSLATED;
  }
  return THINKING_DISPLAY_MODES.BILINGUAL;
}

function normalizeThinkingTargetLang(raw, normalizeLangFn = null) {
  const s = String(raw || '').trim();
  if (!s || s.toLowerCase() === THINKING_TARGET_LANG_FOLLOW) {
    return THINKING_TARGET_LANG_FOLLOW;
  }
  if (typeof normalizeLangFn === 'function') {
    return normalizeLangFn(s, THINKING_TARGET_LANG_FOLLOW);
  }
  return s;
}

function resolveEffectiveCotTargetLang(cfg = {}, normalizeLangFn = null) {
  const rawTarget = cfg.thinkingTargetLang;
  const normalizedTarget = normalizeThinkingTargetLang(rawTarget, normalizeLangFn);
  if (normalizedTarget && normalizedTarget !== THINKING_TARGET_LANG_FOLLOW) {
    return normalizedTarget;
  }
  if (typeof normalizeLangFn === 'function') {
    return normalizeLangFn(cfg.lang, 'zh');
  }
  return cfg.lang || 'zh';
}

function normalizeApiBaseUrl(rawUrl) {
  const raw = String(rawUrl || '').trim();
  const candidate = raw || DEFAULT_THINKING_API_BASE_URL;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: 'INVALID_API_BASE_URL', url: '' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'UNSUPPORTED_API_PROTOCOL', url: '' };
  }
  const cleanHref = parsed.href.replace(/\/+$/, '');
  const lowerPath = parsed.pathname.replace(/\/+$/, '').toLowerCase();
  let chatCompletionsUrl;
  if (lowerPath.endsWith('/chat/completions')) {
    chatCompletionsUrl = cleanHref;
  } else if (lowerPath.endsWith('/v1') || /\/v\d+$/.test(lowerPath)) {
    chatCompletionsUrl = `${cleanHref}/chat/completions`;
  } else if (lowerPath === '' || lowerPath === '/') {
    chatCompletionsUrl = `${parsed.origin}/v1/chat/completions`;
  } else {
    chatCompletionsUrl = `${cleanHref}/chat/completions`;
  }
  return {
    ok: true,
    baseUrl: cleanHref,
    chatCompletionsUrl,
    hostname: parsed.hostname
  };
}

function hashCotKey(input) {
  const str = String(input || '');
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= (ch + i);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0')) + ((h2 >>> 0).toString(16).padStart(8, '0'));
}

function parseFileUriTarget(rawUri) {
  const s = String(rawUri || '').trim();
  if (!/^file:\/\//i.test(s) || s.includes('\0')) {
    return { ok: false, error: 'INVALID_FILE_URI' };
  }
  const hashIdx = s.indexOf('#');
  const uriWithoutHash = hashIdx >= 0 ? s.slice(0, hashIdx) : s;
  const fragment = hashIdx >= 0 ? s.slice(hashIdx + 1) : '';

  let line = 1;
  let endLine = null;
  if (fragment) {
    const lineMatch = fragment.match(/^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i);
    if (lineMatch) {
      const parsedStart = Number(lineMatch[1]);
      if (Number.isInteger(parsedStart) && parsedStart >= 1) line = parsedStart;
      if (lineMatch[2]) {
        const parsedEnd = Number(lineMatch[2]);
        if (Number.isInteger(parsedEnd) && parsedEnd >= line) endLine = parsedEnd;
      }
    }
  }

  let fsPath = '';
  const winDriveMatch = uriWithoutHash.match(/^file:\/\/\/?([A-Za-z]:[\\/].*)$/i);
  if (winDriveMatch) {
    try {
      fsPath = decodeURIComponent(winDriveMatch[1]).replace(/\//g, '\\');
    } catch {
      fsPath = winDriveMatch[1].replace(/\//g, '\\');
    }
  } else {
    const posixMatch = uriWithoutHash.match(/^file:\/\/([^/?#]*)(\/.*)$/i);
    if (!posixMatch) {
      return { ok: false, error: 'MALFORMED_FILE_URI' };
    }
    const hostPart = posixMatch[1] || '';
    if (hostPart && hostPart.toLowerCase() !== 'localhost') {
      return { ok: false, error: 'UNC_HOST_NOT_ALLOWED' };
    }
    try {
      fsPath = decodeURIComponent(posixMatch[2] || '');
    } catch {
      fsPath = posixMatch[2] || '';
    }
  }

  if (!fsPath || fsPath.includes('\0')) {
    return { ok: false, error: 'EMPTY_FILE_PATH' };
  }
  const segments = fsPath.split(/[\\/]+/).filter(Boolean);
  if (segments.includes('..')) {
    return { ok: false, error: 'PATH_TRAVERSAL_NOT_ALLOWED' };
  }
  const isAbsPosix = fsPath.startsWith('/');
  const isAbsWin = /^[A-Za-z]:[\\/]/.test(fsPath);
  if (!isAbsPosix && !isAbsWin) {
    return { ok: false, error: 'RELATIVE_PATH_NOT_ALLOWED' };
  }

  const baseName = segments[segments.length - 1] || fsPath;
  const lineSuffix = fragment && /^L\d+/i.test(fragment) ? `#${fragment}` : '';
  const normalizedPathForUri = fsPath.replace(/\\/g, '/');
  const encodedUriPath = encodeURI(normalizedPathForUri.startsWith('/') ? normalizedPathForUri : `/${normalizedPathForUri}`)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
  const editorUri = `antigravity://file${encodedUriPath}:${line}`;

  return {
    ok: true,
    uri: s,
    path: fsPath,
    line,
    endLine,
    baseName,
    displayLabel: `${baseName}${lineSuffix}`,
    editorUri
  };
}

const FILE_REF_RE = /\[([^\]]+)\]\((file:\/\/[^\s)]+)\)|(file:\/\/[^\s"'<>)\],;]+)/gi;

function protectFileUrisForTranslation(text) {
  const raw = String(text || '');
  const tokens = [];
  const maskedText = raw.replace(FILE_REF_RE, (fullMatch) => {
    const idx = tokens.length;
    tokens.push(fullMatch);
    return `[[AGY_FILE_REF_${idx}]]`;
  });
  return { maskedText, tokens };
}

function restoreProtectedFileUris(translatedText, tokens) {
  let out = String(translatedText || '');
  if (!Array.isArray(tokens) || tokens.length === 0) return out;
  for (let i = 0; i < tokens.length; i++) {
    const placeholderRe = new RegExp(`\\[\\s*\\[\\s*AGY_FILE_REF_${i}\\s*\\]\\s*\\]`, 'g');
    out = out.replace(placeholderRe, () => tokens[i]);
  }
  return out;
}

function tokenizeTextWithFileLinks(text) {
  const raw = String(text || '');
  if (!raw) return [];
  const out = [];
  const re = new RegExp(FILE_REF_RE.source, 'gi');
  let lastIdx = 0;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > lastIdx) {
      out.push({ type: 'text', text: raw.slice(lastIdx, m.index) });
    }
    const mdLabel = m[1];
    const mdUri = m[2];
    const bareUri = m[3];
    let uri = mdUri || bareUri || '';
    let trailing = '';
    if (!mdUri && bareUri) {
      const trailMatch = bareUri.match(/([.,:;!?]+)$/);
      if (trailMatch) {
        trailing = trailMatch[1];
        uri = bareUri.slice(0, -trailing.length);
      }
    }
    const parsed = parseFileUriTarget(uri);
    if (parsed.ok) {
      out.push({
        type: 'file-link',
        label: mdLabel ? mdLabel : parsed.displayLabel,
        uri: parsed.uri,
        path: parsed.path,
        line: parsed.line,
        endLine: parsed.endLine,
        editorUri: parsed.editorUri
      });
      if (trailing) out.push({ type: 'text', text: trailing });
    } else {
      out.push({ type: 'text', text: m[0] });
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < raw.length) {
    out.push({ type: 'text', text: raw.slice(lastIdx) });
  }
  return out;
}

function parseThinkingSegments(rawText, maxSegmentChars = 1200) {
  const normalized = String(rawText || '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const rawParas = normalized.split(/\n{2,}/);
  const out = [];
  for (const para of rawParas) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (trimmed.length <= maxSegmentChars) {
      out.push(trimmed);
      continue;
    }
    const lines = trimmed.split('\n');
    let buf = '';
    for (const line of lines) {
      const next = buf ? `${buf}\n${line}` : line;
      if (next.length > maxSegmentChars && buf) {
        out.push(buf);
        buf = line;
      } else {
        buf = next;
      }
    }
    if (buf) out.push(buf);
  }
  return out;
}

module.exports = {
  THINKING_TRANSLATION_MODES,
  THINKING_DISPLAY_MODES,
  THINKING_TARGET_LANG_FOLLOW,
  DEFAULT_THINKING_API_BASE_URL,
  DEFAULT_THINKING_API_MODEL,
  COT_OVERLAY_I18N,
  getCotOverlayLabels,
  normalizeThinkingTranslationMode,
  normalizeThinkingDisplayMode,
  normalizeThinkingTargetLang,
  resolveEffectiveCotTargetLang,
  normalizeApiBaseUrl,
  hashCotKey,
  parseFileUriTarget,
  protectFileUrisForTranslation,
  restoreProtectedFileUris,
  tokenizeTextWithFileLinks,
  parseThinkingSegments
};
