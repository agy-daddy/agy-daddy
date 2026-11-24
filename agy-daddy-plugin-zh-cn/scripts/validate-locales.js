'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PLUGIN_ROOT, 'data');
const BASE_FILE = path.join(DATA_DIR, 'zh-CN.json');

const LANG_SPECS = {
  'zh': { code: 'zh', bcp47: 'zh-CN', file: 'zh-CN.json' },
  'zh-TW': { code: 'zh-TW', bcp47: 'zh-TW', file: 'zh-TW.json' },
  'ja': { code: 'ja', bcp47: 'ja', file: 'ja.json' },
  'ko': { code: 'ko', bcp47: 'ko', file: 'ko.json' },
  'es': { code: 'es', bcp47: 'es', file: 'es.json' },
  'pt': { code: 'pt', bcp47: 'pt', file: 'pt.json' },
  'fr': { code: 'fr', bcp47: 'fr', file: 'fr.json' },
  'ru': { code: 'ru', bcp47: 'ru', file: 'ru.json' },
  'it': { code: 'it', bcp47: 'it', file: 'it.json' }
};

function resolveCanonicalLang(raw) {
  const s = String(raw || '').trim();
  const lower = s.toLowerCase();
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh_cn') return 'zh';
  if (lower === 'zh-tw' || lower === 'zh_tw' || lower === 'zh-hant') return 'zh-TW';
  if (lower === 'ja' || lower === 'ja-jp') return 'ja';
  if (lower === 'ko' || lower === 'ko-kr') return 'ko';
  if (lower === 'es' || lower === 'es-es' || lower === 'es-419') return 'es';
  if (lower === 'pt' || lower === 'pt-br' || lower === 'pt-pt') return 'pt';
  if (lower === 'fr' || lower === 'fr-fr') return 'fr';
  if (lower === 'ru' || lower === 'ru-ru') return 'ru';
  if (lower === 'it' || lower === 'it-it') return 'it';
  return s;
}

function countCaptureGroups(reStr) {
  let count = 0;
  let inCharClass = false;
  for (let i = 0; i < reStr.length; i++) {
    const ch = reStr[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inCharClass) {
      if (ch === ']') inCharClass = false;
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      continue;
    }
    if (ch === '(') {
      if (reStr[i + 1] === '?') {
        // Named capturing group (?<name>...) counts, lookbehind (?<=...) / (?<!...) does not
        if (reStr[i + 2] === '<' && reStr[i + 3] !== '=' && reStr[i + 3] !== '!') {
          count++;
        }
      } else {
        count++;
      }
    }
  }
  return count;
}

function validateLocaleData(langCode, targetData, baseData) {
  const errors = [];
  const warnings = [];
  const canonical = resolveCanonicalLang(langCode);
  if (!LANG_SPECS[canonical]) {
    return { ok: false, errors: [`Unsupported language for validation: ${langCode}`], warnings, stats: {} };
  }

  if (!targetData || typeof targetData !== 'object' || Array.isArray(targetData)) {
    return { ok: false, errors: ['Root JSON must be an object'], warnings, stats: {} };
  }
  if (!targetData.exact || typeof targetData.exact !== 'object' || Array.isArray(targetData.exact)) {
    errors.push('Missing or invalid "exact" dictionary object');
  }
  if (!Array.isArray(targetData.patterns)) {
    errors.push('Missing or invalid "patterns" array');
  }
  if (errors.length > 0) {
    return { ok: false, errors, warnings, stats: {} };
  }

  const baseExactKeys = Object.keys(baseData.exact || {});
  const targetExactKeys = Object.keys(targetData.exact);
  const baseKeySet = new Set(baseExactKeys);
  const targetKeySet = new Set(targetExactKeys);

  const missingKeys = [];
  for (const k of baseExactKeys) {
    if (!targetKeySet.has(k)) missingKeys.push(k);
  }
  const extraKeys = [];
  for (const k of targetExactKeys) {
    if (!baseKeySet.has(k)) extraKeys.push(k);
  }
  if (missingKeys.length > 0) {
    errors.push(`Missing ${missingKeys.length} exact keys (sample: ${missingKeys.slice(0, 5).map((x) => JSON.stringify(x)).join(', ')})`);
  }
  if (extraKeys.length > 0) {
    errors.push(`Found ${extraKeys.length} extra exact keys (sample: ${extraKeys.slice(0, 5).map((x) => JSON.stringify(x)).join(', ')})`);
  }

  let emptyValues = 0;
  const emptySamples = [];
  let forbiddenTodo = 0;
  const todoSamples = [];
  let whitespaceErrors = 0;
  const whitespaceSamples = [];

  let multiWordTotal = 0;
  let multiWordTranslated = 0;
  let scriptMatched = 0;
  let diffFromZhCn = 0;
  let tradCharHits = 0;

  const FORBIDDEN_MARKER_RE = /\b(?:TODO\s*:|FIXME\s*:)|\[UNTRANSLATED\]/;
  const TRAD_SAMPLE_RE = /[設檔資預搜複貼終碼復檢視窗選執除載擴鍵代語]/;
  const JA_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;
  const KO_RE = /[\uAC00-\uD7AF]/;
  const RU_RE = /[\u0400-\u04FF]/;

  for (const k of baseExactKeys) {
    if (!targetKeySet.has(k)) continue;
    const val = targetData.exact[k];
    const zhVal = baseData.exact[k];

    if (typeof val !== 'string' || val.trim().length === 0) {
      emptyValues++;
      if (emptySamples.length < 5) emptySamples.push(k);
      continue;
    }

    if (FORBIDDEN_MARKER_RE.test(val) && !FORBIDDEN_MARKER_RE.test(k)) {
      forbiddenTodo++;
      if (todoSamples.length < 5) todoSamples.push(`${k} => ${val}`);
    }

    if (/^\s/.test(zhVal) && !/^\s/.test(val)) {
      whitespaceErrors++;
      if (whitespaceSamples.length < 5) whitespaceSamples.push(`missing leading space: ${JSON.stringify(k)}`);
    }
    if (/\s$/.test(zhVal) && !/\s$/.test(val)) {
      whitespaceErrors++;
      if (whitespaceSamples.length < 5) whitespaceSamples.push(`missing trailing space: ${JSON.stringify(k)}`);
    }

    if (/\s/.test(k.trim()) && /[A-Za-z]/.test(k)) {
      multiWordTotal++;
      if (val.trim() !== k.trim()) {
        multiWordTranslated++;
      }
    }

    if (canonical === 'zh-TW') {
      if (val !== zhVal) diffFromZhCn++;
      if (TRAD_SAMPLE_RE.test(val)) tradCharHits++;
    } else if (canonical === 'ja' && JA_RE.test(val)) {
      scriptMatched++;
    } else if (canonical === 'ko' && KO_RE.test(val)) {
      scriptMatched++;
    } else if (canonical === 'ru' && RU_RE.test(val)) {
      scriptMatched++;
    }
  }

  if (emptyValues > 0) {
    errors.push(`Found ${emptyValues} empty/non-string exact values (sample: ${emptySamples.map((x) => JSON.stringify(x)).join(', ')})`);
  }
  if (forbiddenTodo > 0) {
    errors.push(`Found ${forbiddenTodo} placeholder markers like TODO/FIXME/[UNTRANSLATED] (sample: ${todoSamples.join(' | ')})`);
  }
  if (whitespaceErrors > 0) {
    errors.push(`Found ${whitespaceErrors} leading/trailing whitespace mismatches (sample: ${whitespaceSamples.join(', ')})`);
  }

  const basePatterns = Array.isArray(baseData.patterns) ? baseData.patterns : [];
  if (targetData.patterns.length !== basePatterns.length) {
    errors.push(`Pattern count mismatch: expected ${basePatterns.length}, got ${targetData.patterns.length}`);
  } else {
    for (let i = 0; i < basePatterns.length; i++) {
      const bp = basePatterns[i];
      const tp = targetData.patterns[i];
      if (!tp || typeof tp !== 'object') {
        errors.push(`Pattern[${i}] must be an object`);
        continue;
      }
      if (tp.regex !== bp.regex || (tp.flags || '') !== (bp.flags || '')) {
        errors.push(`Pattern[${i}] regex/flags mismatch (expected ${JSON.stringify(bp.regex)})`);
        continue;
      }
      try {
        new RegExp(tp.regex, tp.flags || '');
      } catch (e) {
        errors.push(`Pattern[${i}] failed to compile: ${e.message}`);
        continue;
      }
      if (typeof tp.replacement !== 'string' || tp.replacement.trim().length === 0) {
        errors.push(`Pattern[${i}] has empty replacement`);
        continue;
      }
      if (FORBIDDEN_MARKER_RE.test(tp.replacement)) {
        errors.push(`Pattern[${i}] contains forbidden placeholder marker: ${tp.replacement}`);
      }
      if (canonical !== 'zh') {
        const groupCount = countCaptureGroups(tp.regex);
        for (let g = 1; g <= groupCount; g++) {
          if (!tp.replacement.includes(`$${g}`)) {
            errors.push(`Pattern[${i}] missing capture placeholder $${g} in replacement: ${JSON.stringify(tp.replacement)} (regex=${JSON.stringify(tp.regex)})`);
          }
        }
      }
    }
  }

  const totalExact = baseExactKeys.length;
  const multiWordRatio = multiWordTotal > 0 ? multiWordTranslated / multiWordTotal : 1;
  const scriptRatio = totalExact > 0 ? scriptMatched / totalExact : 0;

  if (canonical === 'zh-TW') {
    if (diffFromZhCn < 2200) {
      errors.push(`zh-TW differs from zh-CN in only ${diffFromZhCn} entries (expected >= 2200)`);
    }
    if (tradCharHits < 500) {
      errors.push(`zh-TW contains too few traditional Chinese characters (${tradCharHits} hits, expected >= 500)`);
    }
  } else if (canonical === 'ja' || canonical === 'ko' || canonical === 'ru') {
    if (scriptRatio < 0.75) {
      errors.push(`${canonical} script coverage too low: ${(scriptRatio * 100).toFixed(1)}% (expected >= 75%)`);
    }
    if (multiWordRatio < 0.85) {
      errors.push(`${canonical} multi-word translation ratio too low: ${(multiWordRatio * 100).toFixed(1)}% (expected >= 85%)`);
    }
  } else if (canonical === 'es' || canonical === 'pt' || canonical === 'fr' || canonical === 'it') {
    if (multiWordRatio < 0.80) {
      errors.push(`${canonical} multi-word translation ratio too low: ${(multiWordRatio * 100).toFixed(1)}% (expected >= 80%)`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      lang: canonical,
      exactCount: targetExactKeys.length,
      patternsCount: targetData.patterns.length,
      multiWordTranslatedPct: Number((multiWordRatio * 100).toFixed(1)),
      scriptCoveragePct: (canonical === 'ja' || canonical === 'ko' || canonical === 'ru')
        ? Number((scriptRatio * 100).toFixed(1))
        : undefined,
      diffFromZhCn: canonical === 'zh-TW' ? diffFromZhCn : undefined
    }
  };
}

function validateAllLocales() {
  const baseData = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8'));
  const results = [];
  const loadedByLang = {};
  let hasError = false;

  for (const [langCode, spec] of Object.entries(LANG_SPECS)) {
    const filePath = path.join(DATA_DIR, spec.file);
    if (!fs.existsSync(filePath)) {
      hasError = true;
      results.push({ lang: langCode, ok: false, errors: [`Missing data file: ${filePath}`], stats: {} });
      continue;
    }
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      hasError = true;
      results.push({ lang: langCode, ok: false, errors: [`Invalid JSON in ${spec.file}: ${e.message}`], stats: {} });
      continue;
    }
    loadedByLang[langCode] = data;
    const res = validateLocaleData(langCode, data, baseData);
    if (!res.ok) hasError = true;
    results.push({ lang: langCode, ...res });
  }

  // Pairwise differentiation check across es/pt/fr/it to prevent accidental copies
  const latinLangs = ['es', 'pt', 'fr', 'it'].filter((l) => loadedByLang[l]?.exact);
  const baseKeys = Object.keys(baseData.exact || {});
  for (let i = 0; i < latinLangs.length; i++) {
    for (let j = i + 1; j < latinLangs.length; j++) {
      const a = latinLangs[i];
      const b = latinLangs[j];
      let diff = 0;
      for (const k of baseKeys) {
        if (loadedByLang[a].exact[k] !== loadedByLang[b].exact[k]) diff++;
      }
      const ratio = baseKeys.length > 0 ? diff / baseKeys.length : 0;
      if (ratio < 0.60) {
        hasError = true;
        const msg = `Pairwise difference between ${a} and ${b} too low: ${(ratio * 100).toFixed(1)}% (expected >= 60%)`;
        const target = results.find((r) => r.lang === b);
        if (target) {
          target.ok = false;
          target.errors.push(msg);
        }
      }
    }
  }

  return { ok: !hasError, results };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let langArg = null;
  let fileArg = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--lang' && args[i + 1]) { langArg = args[++i]; }
    else if (args[i] === '--file' && args[i + 1]) { fileArg = args[++i]; }
  }

  if (langArg || fileArg) {
    if (!langArg || !fileArg) {
      console.error('Usage: node scripts/validate-locales.js [--lang <code> --file <path>]');
      process.exit(1);
    }
    const baseData = JSON.parse(fs.readFileSync(BASE_FILE, 'utf8'));
    const targetData = JSON.parse(fs.readFileSync(path.resolve(fileArg), 'utf8'));
    const res = validateLocaleData(langArg, targetData, baseData);
    console.log(JSON.stringify(res, null, 2));
    if (!res.ok) process.exit(1);
  } else {
    const summary = validateAllLocales();
    for (const r of summary.results) {
      if (r.ok) {
        console.log(`✔ ${r.lang}: ${JSON.stringify(r.stats)}`);
      } else {
        console.error(`✖ ${r.lang}: ${r.errors.join(' | ')}`);
      }
    }
    if (!summary.ok) process.exit(1);
  }
}

module.exports = {
  LANG_SPECS,
  resolveCanonicalLang,
  countCaptureGroups,
  validateLocaleData,
  validateAllLocales
};
