'use strict';

const fs = require('fs');
const path = require('path');

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

const FALLBACK_EXACT = {
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
};

function loadUpstreamDictionaryJson() {
  try {
    // 浏览器环境由底座构建内联包加载，Node 环境同步可用
    const req = require('../data/zh-CN.json');
    if (req && typeof req === 'object') return req;
  } catch {}
  try {
    const candidates = [
      path.resolve(__dirname, '..', 'data', 'zh-CN.json')
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (parsed && typeof parsed === 'object') return parsed;
      }
    }
  } catch {}
  return { exact: {}, patterns: [] };
}

const upstreamData = loadUpstreamDictionaryJson();

const EXACT_DICTIONARY = new Map(Object.entries({
  ...FALLBACK_EXACT,
  ...(upstreamData.exact && typeof upstreamData.exact === 'object' ? upstreamData.exact : {})
}));

const EXACT_LOWER_DICTIONARY = new Map();
for (const [k, v] of EXACT_DICTIONARY.entries()) {
  const lower = String(k).toLowerCase();
  if (!EXACT_LOWER_DICTIONARY.has(lower)) {
    EXACT_LOWER_DICTIONARY.set(lower, v);
  }
}

function compilePatternRules(patterns = []) {
  const rules = [];
  for (const p of patterns) {
    if (!p || typeof p.regex !== 'string' || typeof p.replacement !== 'string') continue;
    try {
      const re = new RegExp(p.regex, typeof p.flags === 'string' ? p.flags : '');
      const repStr = p.replacement;
      rules.push({
        source: p.regex,
        re,
        replace: repStr
      });
    } catch {}
  }
  return rules;
}

const REGEX_DICTIONARY = [
  ...compilePatternRules(Array.isArray(upstreamData.patterns) ? upstreamData.patterns : []),
  {
    source: '^Thought\\s+for\\s+(\\d+(?:\\.\\d+)?)\\s*(?:sec|seconds?)$',
    re: /^Thought\s+for\s+(\d+(?:\.\d+)?)\s*(?:sec|seconds?)$/i,
    replace: (_, n) => `已思考 ${n} 秒`
  },
  {
    source: '^Reviewed\\s+(\\d+)\\s+files?$',
    re: /^Reviewed\s+(\d+)\s+files?$/i,
    replace: (_, n) => `已查阅 ${n} 个文件`
  },
  {
    source: '^Edited\\s+(\\d+)\\s+files?$',
    re: /^Edited\s+(\d+)\s+files?$/i,
    replace: (_, n) => `已修改 ${n} 个文件`
  }
];

function isProtectedPathOrCode(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  if (/^(?:https?|wss?|file|mailto|data):\/\//i.test(trimmed)) return true;
  if (/^(?:\/|~\/|\.\.?\/)[A-Za-z0-9._/@-]+$/.test(trimmed)) return true;
  if (/^[A-Za-z]:\\/.test(trimmed)) return true;
  if (/^(?:git|npm|pnpm|yarn|node|python3?|bash|zsh|curl|cd|ls)\s+\S+/.test(trimmed) && !EXACT_DICTIONARY.has(trimmed)) {
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

function translateBrandTitle(raw, brandTitle = BRAND_TITLE_MODES.ENGLISH) {
  const trimmed = String(raw || '').trim();
  if (!/^antigravity$/i.test(trimmed)) return null;
  const mode = normalizeBrandTitleMode(brandTitle);
  if (mode === BRAND_TITLE_MODES.HIDDEN) return '';
  if (mode === BRAND_TITLE_MODES.TRANSLATED) return '反重力';
  return trimmed;
}

function translateText(raw, options = {}) {
  const input = String(raw ?? '');
  const trimmed = input.trim();
  if (!trimmed) return input;

  // 左上角品牌标题优先处理（保留英文 / 显示反重力 / 隐藏）
  if (/^antigravity$/i.test(trimmed)) {
    const mode = normalizeBrandTitleMode(options.brandTitle);
    if (mode === BRAND_TITLE_MODES.HIDDEN) return '';
    if (mode === BRAND_TITLE_MODES.TRANSLATED) {
      const lead = input.slice(0, input.indexOf(trimmed));
      const tail = input.slice(input.indexOf(trimmed) + trimmed.length);
      return `${lead}反重力${tail}`;
    }
    if (options.brandTitle !== undefined) return input;
  }

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
  if (translated === null && isProtectedPathOrCode(trimmed)) {
    return input;
  }

  // 3. 选项名保留英文开关
  if (translated === null && options.englishLabels && ENGLISH_LABELS_PRESET.has(lower)) {
    return input;
  }

  // 4. 精确词典（先精确大小写命中，再大小写不敏感命中）
  if (translated === null && EXACT_DICTIONARY.has(trimmed)) {
    translated = EXACT_DICTIONARY.get(trimmed);
  } else if (translated === null && EXACT_LOWER_DICTIONARY.has(lower)) {
    translated = EXACT_LOWER_DICTIONARY.get(lower);
  }

  // 5. 正则规则
  if (translated === null) {
    for (const rule of REGEX_DICTIONARY) {
      if (rule.re.test(trimmed)) {
        translated = trimmed.replace(rule.re, rule.replace);
        break;
      }
    }
  }

  if (translated === null || translated === trimmed) return input;
  const lead = input.slice(0, input.indexOf(trimmed));
  const tail = input.slice(input.indexOf(trimmed) + trimmed.length);
  return `${lead}${translated}${tail}`;
}

module.exports = {
  ENGLISH_LABELS_PRESET,
  BRAND_TITLE_MODES,
  EXACT_DICTIONARY,
  REGEX_DICTIONARY,
  isProtectedPathOrCode,
  normalizeBrandTitleMode,
  translateBrandTitle,
  parseCustomRules,
  translateText
};
