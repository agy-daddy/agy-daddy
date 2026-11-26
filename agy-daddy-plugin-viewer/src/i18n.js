'use strict';

const zhCN = require('../locales/zh-CN.json');
const enUS = require('../locales/en.json');

function pickLocaleBundle(doc) {
  const lang = String(
    doc?.documentElement?.getAttribute?.('lang')
    || globalThis.navigator?.language
    || 'zh-CN'
  ).toLowerCase();
  return lang.startsWith('en') ? enUS : zhCN;
}

function formatText(template, vars = {}) {
  let out = String(template || '');
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v ?? ''));
  }
  return out;
}

function createTranslator(doc) {
  const bundle = pickLocaleBundle(doc);
  return function t(key, vars) {
    const raw = bundle[key] !== undefined ? bundle[key] : (zhCN[key] !== undefined ? zhCN[key] : key);
    return vars ? formatText(raw, vars) : String(raw);
  };
}

module.exports = {
  zhCN,
  enUS,
  pickLocaleBundle,
  formatText,
  createTranslator
};
