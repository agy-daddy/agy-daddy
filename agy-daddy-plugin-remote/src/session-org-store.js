'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const DEFAULT_SESSION_LIMIT = 200;
const MAX_SESSION_LIMIT = 1000;
const DB_CACHE_TTL_MS = 1500;
const PLACEHOLDER_MODEL_RE = /^MODEL_PLACEHOLDER_/i;

const THINKING_LEVEL_ORDER = Object.freeze({
  '': 0,
  standard: 0,
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  thinking: 4,
  high: 5,
  xhigh: 6,
  max: 7
});

const THINKING_LABEL_MAP = Object.freeze({
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  thinking: 'Thinking'
});

const IS_CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const PERCENT_ENCODED_RE = /%[0-9A-Fa-f]{2}/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const RUNNING_STATUS_RE = /RUNNING|GENERATING/i;
const LOCK_STALE_MS = 2000;
const LOCK_RETRY_WAIT_MS = 15;
const LOCK_TIMEOUT_MS = 500;
const WATCH_DEBOUNCE_MS = 120;
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  try {
    Atomics.wait(SLEEP_BUF, 0, 0, Math.max(1, ms));
  } catch {
    const end = Date.now() + Math.max(1, ms);
    while (Date.now() < end) {
      // Fallback
    }
  }
}

function isTestMode() {
  return (
    process.env.AGY_DADDY_TEST_MODE === '1'
    || process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function expandTilde(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function safeRealpath(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function canonicalKey(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const trimmed = s.length > 1 && !/^[A-Za-z]:\/$/.test(s) ? s.replace(/\/+$/, '') : s;
  return IS_CASE_INSENSITIVE_FS ? trimmed.toLowerCase() : trimmed;
}

function getPathLookupKeys(normalizedPath) {
  if (!normalizedPath) return [];
  const keys = [canonicalKey(normalizedPath)];
  const real = safeRealpath(normalizedPath);
  if (real) {
    const realKey = canonicalKey(real);
    if (!keys.includes(realKey)) keys.push(realKey);
  }
  return keys;
}

function normalizeLocalPath(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (!s || s.includes('\0')) return '';

  let fromFileUrl = false;
  if (/^file:\/\//i.test(s)) {
    fromFileUrl = true;
    try {
      s = decodeURIComponent(new URL(s).pathname);
      if (WINDOWS_DRIVE_RE.test(s.slice(1))) s = s.slice(1);
    } catch {
      s = s.replace(/^file:\/\//i, '');
      if (/^localhost\//i.test(s)) s = s.slice('localhost'.length);
      if (PERCENT_ENCODED_RE.test(s)) {
        try { s = decodeURIComponent(s); } catch {}
      }
    }
  }

  if (!fromFileUrl && PERCENT_ENCODED_RE.test(s)) {
    const expandedRaw = expandTilde(s);
    if (!fs.existsSync(expandedRaw)) {
      try { s = decodeURIComponent(s); } catch {}
    }
  }

  s = expandTilde(s);
  if (!s || s.includes('\0')) return '';

  if (WINDOWS_DRIVE_RE.test(s) && process.platform !== 'win32') {
    const slashed = s.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    return slashed.length > 3 ? slashed.replace(/\/+$/, '') : slashed;
  }

  return path.resolve(s);
}

function normalizeUriToPath(uriOrPath) {
  const s = String(uriOrPath || '').trim();
  if (!s) return '';
  const norm = normalizeLocalPath(s);
  if (!norm) return '';
  return norm.length > 1 && !/^[A-Za-z]:[\\/]$/.test(norm) ? norm.replace(/[\\/]+$/, '') : norm;
}

function pathToFileUri(fsPath) {
  const clean = normalizeUriToPath(fsPath);
  if (!clean) return null;
  if (clean.startsWith('file://')) return clean;
  return `file://${encodeURI(clean).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

const INTERNAL_TEMP_WORKSPACE_RE = /(?:^|\/)(?:(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/|(?:private\/)?tmp\/)(?:magpie-agy-bridge-|agy-model-probe-|agy-probe-|antigravity-probe-|route-score-|omb-claude-background-)/i;
const INTERNAL_TEMP_DIRNAME_RE = /^(?:magpie-agy-bridge-|agy-model-probe-|agy-probe-|antigravity-probe-|route-score-|omb-claude-background-)[A-Za-z0-9_-]*$/i;

function isTempBridgeWorkspace(uriOrPath) {
  const p = normalizeUriToPath(uriOrPath);
  if (!p) return false;
  const slashed = p.replace(/\\/g, '/');
  if (INTERNAL_TEMP_WORKSPACE_RE.test(slashed)) return true;
  const base = extractWorkspaceDisplayName(slashed);
  return INTERNAL_TEMP_DIRNAME_RE.test(base);
}

function extractWorkspaceDisplayName(uriOrPath) {
  const p = normalizeUriToPath(uriOrPath);
  if (!p) return '';
  const slashed = p.replace(/\\/g, '/');
  const parts = slashed.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : slashed;
}

function parseWorkspaceUrisField(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x || '').trim()).filter(Boolean);
  }
  const str = String(raw || '').trim();
  if (!str) return [];
  if (str.startsWith('[')) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x || '').trim()).filter(Boolean);
      }
    } catch {}
  }
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

function pickPrimaryWorkspaceUri(uris) {
  if (!Array.isArray(uris) || uris.length === 0) return null;
  const nonTemp = uris.find((u) => u && !isTempBridgeWorkspace(u));
  return nonTemp || null;
}

function deriveProjectIdFromWorkspace(uriOrPath) {
  const p = normalizeUriToPath(uriOrPath);
  if (!p) return null;
  const hash = crypto.createHash('sha1').update(p).digest('hex').slice(0, 12);
  const base = extractWorkspaceDisplayName(p).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 32) || 'workspace';
  return `ws:${base}:${hash}`;
}

function isGenericDbProjectId(projectId) {
  const p = String(projectId || '').trim().toLowerCase();
  return !p || p === 'default-cli-project' || p === 'outside-of-project' || p === 'default';
}

function slugifyKey(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

function stripThinkingSuffixStore(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { base: '', thinkingLevel: null, thinkingLabel: null };

  const parenMatch = trimmed.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (parenMatch) {
    const basePart = parenMatch[1].trim();
    const inner = parenMatch[2].trim();
    const innerLower = inner.toLowerCase();
    const tierMatch = innerLower.match(/^(minimal|low|medium|med|high|xhigh|x-high|extra\s*high|max|thinking|extended\s*thinking|no\s*thinking|none)(?:\s+thinking)?$/i);
    if (tierMatch) {
      const tok = tierMatch[1].replace(/\s+/g, ' ').toLowerCase();
      let level = tok;
      if (tok === 'med') level = 'medium';
      else if (tok === 'x-high' || tok === 'extra high') level = 'xhigh';
      else if (tok === 'extended thinking') level = 'thinking';
      else if (tok === 'no thinking' || tok === 'none') level = null;
      const lbl = level ? (THINKING_LABEL_MAP[level] || inner) : null;
      return { base: basePart, thinkingLevel: level, thinkingLabel: lbl };
    }
  }

  const dashMatch = trimmed.match(/^(.*?)\s*[-·–—]\s*(Minimal|Low|Medium|Med|High|XHigh|X-High|Extra\s+High|Max|Thinking)\s*$/i);
  if (dashMatch && dashMatch[1].trim()) {
    const suffixLower = dashMatch[2].trim().replace(/\s+/g, ' ').toLowerCase();
    const normalizedTier = (suffixLower === 'x-high' || suffixLower === 'extra high')
      ? 'xhigh'
      : (suffixLower === 'med' ? 'medium' : suffixLower);
    return {
      base: dashMatch[1].trim(),
      thinkingLevel: normalizedTier,
      thinkingLabel: THINKING_LABEL_MAP[normalizedTier] || dashMatch[2].trim()
    };
  }

  const spaceMatch = trimmed.match(/^(.*\S)\s+(Minimal|Low|Medium|High|XHigh|Max|Thinking)$/i);
  if (spaceMatch && spaceMatch[1].trim()) {
    const normalizedTier = spaceMatch[2].trim().toLowerCase();
    return {
      base: spaceMatch[1].trim(),
      thinkingLevel: normalizedTier,
      thinkingLabel: THINKING_LABEL_MAP[normalizedTier] || spaceMatch[2].trim()
    };
  }

  return { base: trimmed, thinkingLevel: null, thinkingLabel: null };
}

function stripOrchestratorKeyword(raw) {
  return String(raw || '')
    .trim()
    .replace(/^(?:antigravity\s+|auto\s+)?(?:orchestrator|编排模型|编排)\s*[:\-·–—/]?\s*/i, '')
    .replace(/\s*[:\-·–—/]?\s*(?:orchestrator|编排模型|编排)$/i, '')
    .trim();
}

const THINKING_NUM_TO_LEVEL = Object.freeze({
  1: 'low',
  2: 'medium',
  3: 'high',
  100: 'xhigh'
});

function normalizeThinkingLevelValue(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return THINKING_NUM_TO_LEVEL[raw] || null;
  }
  const str = String(raw).trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) {
    return THINKING_NUM_TO_LEVEL[Number(str)] || null;
  }
  const lower = str.toLowerCase().replace(/^thinking_level_/, '').replace(/\s+/g, ' ');
  if (lower === 'no thinking' || lower === 'none' || lower === 'standard') return null;
  if (lower === 'min' || lower === 'minimal') return 'minimal';
  if (lower === 'low' || lower === 'fast') return 'low';
  if (lower === 'med' || lower === 'medium' || lower === 'balanced') return 'medium';
  if (lower === 'high') return 'high';
  if (lower === 'xhigh' || lower === 'x-high' || lower === 'extra high' || lower === 'extra_high') return 'xhigh';
  if (lower === 'max' || lower === 'ultra') return 'max';
  if (lower === 'thinking' || lower === 'think' || lower === 'extended thinking') return 'thinking';
  return lower;
}

function normalizeSupportedThinkingLevels(rawLevels) {
  if (!Array.isArray(rawLevels)) return null;
  const out = [];
  const seen = new Set();
  for (const entry of rawLevels) {
    const rawVal = (entry && typeof entry === 'object')
      ? (entry.thinkingSuffix ?? entry.thinkingLevel ?? entry.level ?? entry.id ?? '')
      : entry;
    const norm = normalizeThinkingLevelValue(rawVal);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

function resolveOrchestratorFamilyId(modelId = '', master = '') {
  const cleanId = String(modelId || '').trim();
  const orchMatch = cleanId.match(/^gemini-pro-orchestrator-(.+)$/i);
  if (orchMatch && orchMatch[1]) {
    const suffix = orchMatch[1].trim().toLowerCase();
    return suffix.startsWith('gemini-') ? suffix : `gemini-4-${suffix}`;
  }
  if (/^gemini-pro-orchestrator$/i.test(cleanId)) {
    return 'gemini-4-carbon';
  }
  const cleanMaster = String(master || '').trim().toLowerCase();
  if (!cleanMaster) return '';
  if (cleanMaster.includes('opus')) return 'claude-opus-5-5';
  if (cleanMaster.startsWith('gemini')) return slugifyKey(cleanMaster);
  if (['carbon', 'argon', 'neon'].includes(cleanMaster)) return `gemini-4-${cleanMaster}`;
  return slugifyKey(cleanMaster);
}

/**
 * Parses Antigravity model display label & ID into structured family,
 * thinking tier, and orchestrator metadata for 2-level model pickers.
 */
function parseModelMetadata(item = {}) {
  const id = String(item.id || item.model || item.modelId || '').trim();
  const label = String(item.label || item.shortName || item.displayName || item.name || '').trim();
  const displayName = String(item.displayName || item.name || item.label || item.shortName || '').trim();
  const tagTitle = typeof item.tagTitle === 'string' && item.tagTitle.trim() ? item.tagTitle.trim() : null;
  const primaryText = displayName || label;

  const isOrchestrator = Boolean(
    item.isOrchestrator === true
    || /\borchestrator\b|\bmulti[- ]?agent\b|\bagent[-_ ]?router\b|编排/i.test(primaryText)
    || /\borchestrator\b|\bmulti[- ]?agent\b/i.test(id)
    || (tagTitle && /\borchestrator\b|编排/i.test(tagTitle))
  );

  let thinkingLevel = normalizeThinkingLevelValue(item.thinkingLevel);
  let thinkingLabel = typeof item.thinkingLabel === 'string' && item.thinkingLabel.trim()
    ? item.thinkingLabel.trim()
    : null;
  let orchestratorVariant = typeof item.orchestratorVariant === 'string' && item.orchestratorVariant.trim()
    ? item.orchestratorVariant.trim()
    : null;
  let orchestratorMaster = typeof item.orchestratorMaster === 'string' && item.orchestratorMaster.trim()
    ? item.orchestratorMaster.trim()
    : null;

  let family = typeof item.family === 'string' && item.family.trim()
    ? item.family.trim()
    : primaryText;

  if (isOrchestrator) {
    // 1) Unwrap outer "Orchestrator (...)" if wrapped around a composite body
    let body = primaryText;
    const outerOrchParen = primaryText.match(/^(?:antigravity\s+|auto\s+)?(?:orchestrator|编排模型|编排)\s*\((.+)\)\s*$/i);
    if (outerOrchParen) {
      body = outerOrchParen[1].trim();
    }
    const tierParsed = stripThinkingSuffixStore(body);
    if (tierParsed.thinkingLevel && !thinkingLevel) {
      thinkingLevel = tierParsed.thinkingLevel;
      thinkingLabel = tierParsed.thinkingLabel;
    }
    let masterCandidate = stripOrchestratorKeyword(tierParsed.base);
    if (masterCandidate.startsWith('(') && masterCandidate.endsWith(')')) {
      masterCandidate = masterCandidate.slice(1, -1).trim();
    }
    if (!orchestratorMaster && masterCandidate && !/^(fast|balanced|pro|auto|standard|默认|标准|minimal|low|medium|high|xhigh|max|thinking)$/i.test(masterCandidate)) {
      orchestratorMaster = masterCandidate;
    }
    if (!orchestratorVariant) {
      if (orchestratorMaster && thinkingLabel) {
        orchestratorVariant = `${orchestratorMaster} · ${thinkingLabel}`;
      } else if (orchestratorMaster) {
        orchestratorVariant = orchestratorMaster;
      } else if (masterCandidate) {
        orchestratorVariant = masterCandidate;
      } else if (thinkingLabel) {
        orchestratorVariant = thinkingLabel;
      } else {
        const idMatch = id.match(/orchestrator[-_/:]+([a-z0-9._-]+)$/i);
        if (idMatch && idMatch[1].trim()) {
          orchestratorVariant = idMatch[1].trim();
        }
      }
    }
    family = 'Orchestrator';
  } else {
    const tierParsed = stripThinkingSuffixStore(primaryText);
    if (tierParsed.thinkingLevel) {
      if (!thinkingLevel) thinkingLevel = tierParsed.thinkingLevel;
      if (!thinkingLabel) thinkingLabel = tierParsed.thinkingLabel;
      if (tierParsed.base) family = tierParsed.base;
    }
  }

  if (!thinkingLabel && thinkingLevel) {
    thinkingLabel = THINKING_LABEL_MAP[thinkingLevel] || thinkingLevel;
  }

  const shortName = typeof item.shortName === 'string' && item.shortName.trim()
    ? item.shortName.trim()
    : (label || displayName);

  return {
    family: family || primaryText,
    shortName,
    thinkingLevel,
    thinkingLabel,
    isOrchestrator,
    orchestratorVariant: orchestratorVariant || null,
    orchestratorMaster: orchestratorMaster || null,
    tagTitle
  };
}

function dedupeThinkingLevels(levels) {
  const out = [];
  const seen = new Set();
  for (const lvl of levels) {
    const norm = normalizeThinkingLevelValue(lvl);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

function buildModelGroups(models = [], rawHostGroups = []) {
  if (!Array.isArray(models) || models.length === 0) return [];

  // Map modelId -> host group index/name if host provided groupedModels or agentModelSorts
  const hostOrderMap = new Map();
  let orderCounter = 0;
  const hostGroupEntries = Array.isArray(rawHostGroups)
    ? rawHostGroups
    : (isPlainObject(rawHostGroups)
      ? Object.entries(rawHostGroups).map(([groupId, g]) => ({ groupId, ...(isPlainObject(g) ? g : {}) }))
      : []);
  for (const g of hostGroupEntries) {
    if (!isPlainObject(g)) continue;
    const nestedGroups = Array.isArray(g.groups) ? g.groups : [g];
    for (const sub of nestedGroups) {
      if (!isPlainObject(sub)) continue;
      const ids = Array.isArray(sub.modelIds)
        ? sub.modelIds
        : (Array.isArray(sub.models)
          ? sub.models.map((m) => (typeof m === 'string' ? m : (m?.id || m?.model || m?.modelId || '')))
          : []);
      for (const mid of ids) {
        const clean = String(mid || '').trim();
        if (clean && !hostOrderMap.has(clean)) {
          hostOrderMap.set(clean, orderCounter++);
        }
      }
    }
  }

  const orchestratorModels = [];
  const familyBuckets = new Map();

  for (const m of models) {
    if (!m || !m.id) continue;
    if (m.isOrchestrator) {
      orchestratorModels.push(m);
      continue;
    }
    const fam = m.family || m.displayName || m.label;
    const key = slugifyKey(fam);
    let bucket = familyBuckets.get(key);
    if (!bucket) {
      bucket = { id: `family:${key}`, label: fam, models: [], firstOrder: hostOrderMap.has(m.id) ? hostOrderMap.get(m.id) : 1e9 };
      familyBuckets.set(key, bucket);
    }
    if (hostOrderMap.has(m.id)) {
      bucket.firstOrder = Math.min(bucket.firstOrder, hostOrderMap.get(m.id));
    }
    bucket.models.push(m);
  }

  const sortVariants = (list) => [...list].sort((a, b) => {
    const oa = THINKING_LEVEL_ORDER[a.thinkingLevel || ''] ?? 99;
    const ob = THINKING_LEVEL_ORDER[b.thinkingLevel || ''] ?? 99;
    if (oa !== ob) return oa - ob;
    return String(a.label || '').localeCompare(String(b.label || ''));
  });

  const groups = [];

  if (orchestratorModels.length > 0) {
    const sorted = sortVariants(orchestratorModels);
    const defaultItem = sorted.find((m) => m.isDefault) || sorted.find((m) => !m.disabled) || sorted[0];
    const variantsByMaster = new Map();
    for (const m of sorted) {
      const mKey = m.orchestratorMaster ? slugifyKey(m.orchestratorMaster) : '';
      if (!mKey) continue;
      if (!variantsByMaster.has(mKey)) variantsByMaster.set(mKey, []);
      if (m.thinkingLevel) variantsByMaster.get(mKey).push(m.thinkingLevel);
    }

    const orchVariants = sorted.map((m) => {
      const mKey = m.orchestratorMaster ? slugifyKey(m.orchestratorMaster) : '';
      const masterDerived = mKey ? dedupeThinkingLevels(variantsByMaster.get(mKey) || []) : [];
      const explicitLevels = Array.isArray(m.supportedThinkingLevels) ? [...m.supportedThinkingLevels] : null;
      const supportedThinkingLevels = explicitLevels && explicitLevels.length > 0
        ? explicitLevels
        : (masterDerived.length > 0
          ? masterDerived
          : (m.thinkingLevel ? [m.thinkingLevel] : []));
      return {
        modelId: m.id,
        label: m.orchestratorVariant || m.thinkingLabel || m.label,
        thinkingLevel: m.thinkingLevel || null,
        supportedThinkingLevels,
        orchestratorVariant: m.orchestratorVariant || null,
        orchestratorMaster: m.orchestratorMaster || null,
        tagTitle: m.tagTitle || null,
        disabled: Boolean(m.disabled)
      };
    });

    const orchGroupLevels = dedupeThinkingLevels([
      ...orchVariants.flatMap((v) => v.supportedThinkingLevels || []),
      ...sorted.map((m) => m.thinkingLevel).filter(Boolean)
    ]);

    groups.push({
      id: 'orchestrator',
      label: 'Orchestrator',
      kind: 'orchestrator',
      isOrchestrator: true,
      hasThinkingTiers: sorted.some((m) => Boolean(m.thinkingLevel)) || orchGroupLevels.length > 0,
      supportedThinkingLevels: orchGroupLevels,
      defaultModelId: defaultItem.id,
      modelIds: sorted.map((m) => m.id),
      variants: orchVariants
    });
  }

  const orderedBuckets = Array.from(familyBuckets.values()).sort((a, b) => {
    if (a.firstOrder !== b.firstOrder) return a.firstOrder - b.firstOrder;
    return 0;
  });

  for (const bucket of orderedBuckets) {
    const sorted = sortVariants(bucket.models);
    const defaultItem = sorted.find((m) => m.isDefault) || sorted.find((m) => !m.disabled) || sorted[0];
    const explicitLevels = dedupeThinkingLevels(
      sorted.flatMap((m) => (Array.isArray(m.supportedThinkingLevels) ? m.supportedThinkingLevels : []))
    );
    const derivedLevels = dedupeThinkingLevels(sorted.map((m) => m.thinkingLevel).filter(Boolean));
    const groupSupportedLevels = explicitLevels.length > 0 ? explicitLevels : derivedLevels;
    const hasTiers = sorted.length > 1 || sorted.some((m) => Boolean(m.thinkingLevel)) || groupSupportedLevels.length > 0;
    groups.push({
      id: bucket.id,
      label: bucket.label,
      kind: sorted.length > 1 ? 'thinking_family' : 'single',
      isOrchestrator: false,
      hasThinkingTiers: hasTiers,
      supportedThinkingLevels: groupSupportedLevels,
      defaultModelId: defaultItem.id,
      modelIds: sorted.map((m) => m.id),
      variants: sorted.map((m) => ({
        modelId: m.id,
        label: m.thinkingLabel || (sorted.length > 1 ? 'Standard' : m.label),
        thinkingLevel: m.thinkingLevel || null,
        supportedThinkingLevels: (Array.isArray(m.supportedThinkingLevels) && m.supportedThinkingLevels.length > 0)
          ? [...m.supportedThinkingLevels]
          : [...groupSupportedLevels],
        orchestratorVariant: null,
        tagTitle: m.tagTitle || null,
        disabled: Boolean(m.disabled)
      }))
    });
  }

  return groups;
}

/**
 * Normalizes and enriches model catalog entries while preserving real Antigravity
 * MODEL_PLACEHOLDER_* IDs that carry human labels, without over-deduplicating
 * distinct thinking tiers or orchestrator variants.
 */
function sanitizeModelCatalogResult({ models = [], defaultModelId = '', rawGroups = [], modelTree = null } = {}) {
  const rawDefault = typeof defaultModelId === 'string' ? defaultModelId.trim() : '';
  const byId = new Map();

  // Index explicit supportedThinkingLevels from rawGroups (groupedModels / web-harness groups) and modelTree
  const groupMetaByFamilyId = new Map();
  const groupMetaByNameSlug = new Map();
  const variantMetaByModelId = new Map();
  const treeLeafByRequestedId = new Map();
  const treeLeafByModelId = new Map();
  const treeOrchByFamilyId = new Map();

  const registerGroupMeta = (familyIdRaw, gObj) => {
    if (!isPlainObject(gObj)) return;
    const levels = normalizeSupportedThinkingLevels(gObj.supportedThinkingLevels);
    const displayName = typeof gObj.displayName === 'string' && gObj.displayName.trim()
      ? gObj.displayName.trim()
      : (typeof gObj.label === 'string' && gObj.label.trim() ? gObj.label.trim() : '');
    const familyId = String(familyIdRaw || gObj.groupId || gObj.id || '').trim();
    if (!levels) return;
    const entry = { familyId, displayName, supportedThinkingLevels: levels };
    if (familyId) {
      groupMetaByFamilyId.set(familyId.toLowerCase(), entry);
      groupMetaByNameSlug.set(slugifyKey(familyId), entry);
      for (const sfx of levels) {
        variantMetaByModelId.set(`${familyId.toLowerCase()}-${sfx}`, { ...entry, thinkingLevel: sfx });
      }
    }
    if (displayName) {
      groupMetaByNameSlug.set(slugifyKey(displayName), entry);
    }
  };

  if (isPlainObject(rawGroups)) {
    for (const [fid, g] of Object.entries(rawGroups)) {
      registerGroupMeta(fid, g);
    }
  } else if (Array.isArray(rawGroups)) {
    for (const g of rawGroups) {
      if (!isPlainObject(g)) continue;
      registerGroupMeta(g.groupId || g.familyId || g.id, g);
      if (Array.isArray(g.groups)) {
        for (const sub of g.groups) {
          registerGroupMeta(sub?.groupId || sub?.familyId || sub?.id, sub);
        }
      }
    }
  }

  if (isPlainObject(modelTree) && Array.isArray(modelTree.nodes)) {
    const visitTreeNodes = (nodes) => {
      for (const node of nodes) {
        if (!isPlainObject(node)) continue;
        if (node.kind === 'leaf') {
          const levels = normalizeSupportedThinkingLevels(node.supportedThinkingLevels);
          const defaultSuffix = normalizeThinkingLevelValue(node.defaultThinkingSuffix ?? node.thinkingLevel);
          const sel = isPlainObject(node.selection) ? node.selection : {};
          const reqId = typeof sel.requestedModel === 'string' ? sel.requestedModel.trim() : '';
          const stableId = typeof sel.modelId === 'string' ? sel.modelId.trim() : '';
          const plannerFamilyId = typeof sel.plannerFamilyId === 'string' ? sel.plannerFamilyId.trim() : '';
          const leafInfo = {
            supportedThinkingLevels: levels,
            defaultThinkingSuffix: defaultSuffix,
            plannerFamilyId,
            label: typeof node.label === 'string' ? node.label.trim() : ''
          };
          if (reqId) treeLeafByRequestedId.set(reqId, leafInfo);
          if (stableId) treeLeafByModelId.set(stableId.toLowerCase(), leafInfo);
          if (plannerFamilyId) treeOrchByFamilyId.set(plannerFamilyId.toLowerCase(), leafInfo);
        } else if (Array.isArray(node.children)) {
          visitTreeNodes(node.children);
        }
      }
    };
    visitTreeNodes(modelTree.nodes);
  }

  for (const item of (Array.isArray(models) ? models : [])) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (!id || PLACEHOLDER_MODEL_RE.test(id)) continue;
      if (!byId.has(id)) {
        const meta = parseModelMetadata({ id, label: id, displayName: id });
        byId.set(id, {
          id,
          model: id,
          modelId: null,
          label: id,
          name: id,
          displayName: id,
          disabled: false,
          quotaInfo: null,
          maxTokens: null,
          supportsImages: false,
          ...meta,
          supportedThinkingLevels: null
        });
      }
      continue;
    }
    if (!isPlainObject(item)) continue;
    const id = String(item.id || item.model || item.modelOrAlias?.model || item.modelId || '').trim();
    if (!id) continue;
    const stableModelId = typeof item.modelId === 'string' && item.modelId.trim() ? item.modelId.trim() : null;
    const label = String(item.label || item.shortName || item.displayName || item.name || '').trim();
    const displayName = String(item.displayName || item.name || item.label || item.shortName || '').trim();
    if (!label && !displayName) continue;
    if (PLACEHOLDER_MODEL_RE.test(label) || PLACEHOLDER_MODEL_RE.test(displayName)) continue;
    if (PLACEHOLDER_MODEL_RE.test(id) && (!label || PLACEHOLDER_MODEL_RE.test(label))) continue;

    const existing = byId.get(id);
    const mergedRaw = existing
      ? {
          ...existing,
          ...item,
          id,
          modelId: stableModelId || existing.modelId || null,
          label: label || existing.label,
          displayName: displayName || existing.displayName
        }
      : { ...item, id, modelId: stableModelId, label, displayName };
    const meta = parseModelMetadata(mergedRaw);

    const lowerStable = (mergedRaw.modelId || '').toLowerCase();
    const variantMeta = lowerStable ? variantMetaByModelId.get(lowerStable) : null;
    const treeLeaf = treeLeafByRequestedId.get(id)
      || (lowerStable ? treeLeafByModelId.get(lowerStable) : null)
      || (meta.isOrchestrator
        ? treeOrchByFamilyId.get(resolveOrchestratorFamilyId(mergedRaw.modelId || id, meta.orchestratorMaster))
        : null);
    const orchFamilyId = meta.isOrchestrator
      ? resolveOrchestratorFamilyId(mergedRaw.modelId || id, meta.orchestratorMaster)
      : '';
    const familyGroupMeta = variantMeta
      || (orchFamilyId ? groupMetaByFamilyId.get(orchFamilyId.toLowerCase()) : null)
      || (meta.isOrchestrator ? null : groupMetaByNameSlug.get(slugifyKey(meta.family)));

    const explicitLevels = normalizeSupportedThinkingLevels(mergedRaw.supportedThinkingLevels)
      || (treeLeaf?.supportedThinkingLevels ? [...treeLeaf.supportedThinkingLevels] : null)
      || (familyGroupMeta?.supportedThinkingLevels ? [...familyGroupMeta.supportedThinkingLevels] : null);

    const resolvedThinkingLevel = meta.thinkingLevel
      || variantMeta?.thinkingLevel
      || (meta.isOrchestrator ? treeLeaf?.defaultThinkingSuffix : null)
      || null;
    const resolvedThinkingLabel = meta.thinkingLabel
      || (resolvedThinkingLevel ? (THINKING_LABEL_MAP[resolvedThinkingLevel] || resolvedThinkingLevel) : null);
    const resolvedFamily = (!meta.isOrchestrator && familyGroupMeta?.displayName)
      ? familyGroupMeta.displayName
      : meta.family;

    byId.set(id, {
      ...mergedRaw,
      id,
      model: id,
      modelId: mergedRaw.modelId || null,
      label: mergedRaw.label || mergedRaw.displayName,
      name: mergedRaw.displayName || mergedRaw.label,
      displayName: mergedRaw.displayName || mergedRaw.label,
      shortName: meta.shortName,
      family: resolvedFamily,
      thinkingLevel: resolvedThinkingLevel,
      thinkingLabel: resolvedThinkingLabel,
      supportedThinkingLevels: explicitLevels,
      isOrchestrator: meta.isOrchestrator,
      orchestratorVariant: meta.orchestratorVariant,
      orchestratorMaster: meta.orchestratorMaster,
      tagTitle: meta.tagTitle,
      quotaInfo: mergedRaw.quotaInfo || null,
      maxTokens: Number.isFinite(Number(mergedRaw.maxTokens)) ? Number(mergedRaw.maxTokens) : null,
      supportsImages: Boolean(mergedRaw.supportsImages),
      disabled: Boolean(mergedRaw.disabled || mergedRaw.enabled === false)
    });
  }

  // Deduplicate ONLY truly duplicate entries with identical label + variant metadata
  const bySignature = new Map();
  for (const model of byId.values()) {
    const sig = [
      (model.displayName || model.label).trim().toLowerCase(),
      model.thinkingLevel || '',
      model.isOrchestrator ? '1' : '0',
      (model.orchestratorVariant || '').toLowerCase(),
      (model.orchestratorMaster || '').toLowerCase(),
      (model.tagTitle || '').toLowerCase()
    ].join('|');
    const existing = bySignature.get(sig);
    if (!existing) {
      bySignature.set(sig, model);
      continue;
    }
    const modelScore = (model.id === rawDefault ? 4 : 0) + (!model.disabled ? 2 : 0) + (model.quotaInfo ? 1 : 0);
    const existingScore = (existing.id === rawDefault ? 4 : 0) + (!existing.disabled ? 2 : 0) + (existing.quotaInfo ? 1 : 0);
    if (modelScore > existingScore) {
      bySignature.set(sig, model);
    }
  }

  const deduped = Array.from(bySignature.values());
  const resolvedDefault = (
    rawDefault && deduped.some((m) => m.id === rawDefault)
      ? rawDefault
      : (deduped.find((m) => !m.disabled)?.id || deduped[0]?.id || '')
  );

  const enrichedModels = deduped.map((m) => ({
    ...m,
    isDefault: Boolean(resolvedDefault && m.id === resolvedDefault)
  }));

  const modelGroups = buildModelGroups(enrichedModels, rawGroups);
  const groupIdByModel = new Map();
  const groupLevelsByModel = new Map();
  for (const g of modelGroups) {
    for (const mid of g.modelIds) {
      groupIdByModel.set(mid, g.id);
    }
    for (const v of (g.variants || [])) {
      if (v.modelId && Array.isArray(v.supportedThinkingLevels)) {
        groupLevelsByModel.set(v.modelId, [...v.supportedThinkingLevels]);
      }
    }
  }
  for (const m of enrichedModels) {
    m.groupId = groupIdByModel.get(m.id) || null;
    if (!Array.isArray(m.supportedThinkingLevels)) {
      m.supportedThinkingLevels = groupLevelsByModel.get(m.id) || [];
    }
  }

  return {
    models: enrichedModels,
    defaultModelId: resolvedDefault,
    modelGroups
  };
}
function resolveWorkspaceOrg(host) {
  if (host && host.workspaceOrg) return host.workspaceOrg;
  if (process.env.AGY_DADDY_HOST_DIR) {
    try {
      return require(path.join(process.env.AGY_DADDY_HOST_DIR, "src", "core", "workspace-org"));
    } catch {}
  }
  return require(path.resolve(__dirname, "..", "..", "agy-daddy-host", "src", "core", "workspace-org"));
}

const defaultWorkspaceOrg = resolveWorkspaceOrg(null);

function createSessionOrgStore(options = {}) {
  const workspaceOrg = resolveWorkspaceOrg(options.host);
  const explicitDbPath = options.dbPath !== undefined
    ? options.dbPath
    : (process.env.AGY_DADDY_CONVERSATION_DB_PATH || undefined);
  const resolvedDbPath = explicitDbPath !== undefined
    ? (explicitDbPath ? path.resolve(explicitDbPath) : null)
    : (isTestMode() ? null : path.join(os.homedir(), ".gemini", "antigravity", "conversation_summaries.db"));
  const effectiveWorktreeDiscovery = options.worktreeDiscovery !== undefined
    ? options.worktreeDiscovery
    : (options.host?.workspaceOrg?.worktreeDiscovery || null);

  const core = workspaceOrg.createSessionOrgCore({
    pluginId: "agy-daddy.remote",
    useEnrichInGetOrg: true,
    ...options,
    worktreeDiscovery: effectiveWorktreeDiscovery
  });

  return {
    ...core,
    dbPath: resolvedDbPath,
    worktreeDiscovery: effectiveWorktreeDiscovery
  };
}

module.exports = {
  DEFAULT_SESSION_LIMIT,
  MAX_SESSION_LIMIT,
  PLACEHOLDER_MODEL_RE,
  isTempBridgeWorkspace,
  parseModelMetadata,
  buildModelGroups,
  sanitizeModelCatalogResult,
  resolveWorkspaceOrg,
  createSessionOrgStore,
  createEmptyPersistedOrg: defaultWorkspaceOrg.createEmptyPersistedOrg,
  sanitizePersistedOrg: defaultWorkspaceOrg.sanitizePersistedOrg,
  buildOrgBusSummary: defaultWorkspaceOrg.buildOrgBusSummary,
  aggregateWorktreeProjects: defaultWorkspaceOrg.aggregateWorktreeProjects,
  normalizeLocalPath: defaultWorkspaceOrg.normalizeLocalPath,
  canonicalizePath: defaultWorkspaceOrg.canonicalizePath,
  canonicalKey: defaultWorkspaceOrg.canonicalKey,
  makeStableProjectId: defaultWorkspaceOrg.makeStableProjectId,
  makeWorktreeId: defaultWorkspaceOrg.makeWorktreeId,
  matchWorktreeByLongestPrefix: defaultWorkspaceOrg.matchWorktreeByLongestPrefix
};
