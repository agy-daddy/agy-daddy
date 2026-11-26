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

function makeAppSyncedProjectId(normPath) {
  const digest = crypto.createHash('sha1').update(canonicalKey(normPath)).digest('hex').slice(0, 12);
  return `app:${digest}`;
}

function makeImplicitProjectId(normPath) {
  const digest = crypto.createHash('sha1').update(canonicalKey(normPath)).digest('hex').slice(0, 12);
  return `implicit:${digest}`;
}

function makeStableProjectId(normPath) {
  const digest = crypto.createHash('sha1').update(canonicalKey(normPath)).digest('hex').slice(0, 12);
  return `proj_${digest}`;
}

function dedupeStrings(arr) {
  return Array.from(new Set(
    (Array.isArray(arr) ? arr : [])
      .map((s) => String(s || '').trim())
      .filter(Boolean)
  ));
}

function sanitizeZoneOrder(raw) {
  return {
    pinned: dedupeStrings(raw?.pinned),
    normal: dedupeStrings(raw?.normal)
  };
}

function sanitizeRemoteMeta(raw) {
  if (!isPlainObject(raw)) return null;
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : '';
  if (!provider) return null;
  const out = { provider };
  for (const k of ['ownerRepo', 'repoUrl', 'branch', 'driveMode', 'account', 'remoteName', 'remoteFolderId']) {
    if (typeof raw[k] === 'string' && raw[k].trim()) {
      out[k] = raw[k].trim();
    }
  }
  return out;
}

function sanitizePinTimestamps(raw) {
  const out = { sessions: {}, projects: {}, groups: {} };
  if (!isPlainObject(raw)) return out;
  for (const bucket of ['sessions', 'projects', 'groups']) {
    if (!isPlainObject(raw[bucket])) continue;
    for (const [k, v] of Object.entries(raw[bucket])) {
      const ck = String(k || '').trim();
      if (ck && typeof v === 'string' && v.trim()) {
        out[bucket][ck] = v.trim();
      }
    }
  }
  return out;
}

function createEmptyPersistedOrg() {
  return {
    version: 2,
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    defaultSessionPath: null,
    groups: [],
    projects: [],
    pins: {
      sessions: [],
      projects: [],
      groups: []
    },
    pinTimestamps: {
      sessions: {},
      projects: {},
      groups: {}
    },
    projectGroupMap: {},
    sessionGroupMap: {},
    sessionProjectOverrides: {},
    groupOrder: {
      pinned: [],
      normal: []
    },
    projectOrder: {},
    sessionOrder: {},
    archivedSessions: {},
    deletedSessions: {},
    migrations: {
      workspaceMetaV1At: null
    }
  };
}

function sanitizePersistedOrg(raw) {
  const base = createEmptyPersistedOrg();
  if (!isPlainObject(raw)) return base;

  const rev = Number(raw.revision);
  base.revision = Number.isInteger(rev) && rev >= 0 ? rev : 0;
  base.updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt.trim() ? raw.updatedAt.trim() : null;
  base.updatedBy = typeof raw.updatedBy === 'string' && raw.updatedBy.trim() ? raw.updatedBy.trim() : null;
  base.defaultSessionPath = typeof raw.defaultSessionPath === 'string' && raw.defaultSessionPath.trim()
    ? (normalizeLocalPath(raw.defaultSessionPath) || null)
    : null;

  base.pins = {
    sessions: dedupeStrings(raw.pins?.sessions),
    projects: dedupeStrings(raw.pins?.projects),
    groups: dedupeStrings(raw.pins?.groups)
  };
  base.pinTimestamps = sanitizePinTimestamps(raw.pinTimestamps);

  const nowIso = base.updatedAt || new Date().toISOString();
  if (Array.isArray(raw.groups)) {
    const seen = new Set();
    base.groups = raw.groups
      .filter((g) => isPlainObject(g) && String(g.id || '').trim())
      .map((g, idx) => {
        const id = String(g.id).trim();
        if (seen.has(id)) return null;
        seen.add(id);
        return {
          id,
          name: String(g.name || id).trim() || id,
          source: g.source === 'host' ? 'host' : 'user',
          collapsed: Boolean(g.collapsed),
          order: Number.isFinite(Number(g.order)) ? Number(g.order) : (Number.isFinite(Number(g.sortOrder)) ? Number(g.sortOrder) : idx),
          projectIds: dedupeStrings(g.projectIds),
          workspaceUris: dedupeStrings(g.workspaceUris),
          sessionIds: dedupeStrings(g.sessionIds),
          createdAt: typeof g.createdAt === 'string' && g.createdAt.trim() ? g.createdAt.trim() : nowIso,
          updatedAt: typeof g.updatedAt === 'string' && g.updatedAt.trim() ? g.updatedAt.trim() : nowIso
        };
      })
      .filter(Boolean);
  }

  const groupIdSet = new Set(base.groups.map((g) => g.id));

  if (isPlainObject(raw.projectGroupMap)) {
    for (const [k, v] of Object.entries(raw.projectGroupMap)) {
      const ck = String(k || '').trim();
      const cv = String(v || '').trim();
      if (ck && cv) base.projectGroupMap[ck] = cv;
    }
  }

  if (Array.isArray(raw.projects)) {
    const seenIds = new Set();
    const seenPaths = new Set();
    for (const p of raw.projects) {
      if (!isPlainObject(p) || !String(p.id || '').trim()) continue;
      const id = String(p.id).trim();
      if (seenIds.has(id)) continue;
      const rootPath = normalizeLocalPath(p.rootPath || p.path || p.uri);
      if (!rootPath) continue;
      const pKey = canonicalKey(rootPath);
      if (seenPaths.has(pKey)) continue;
      seenIds.add(id);
      seenPaths.add(pKey);

      const rawGid = base.projectGroupMap[id] || (typeof p.groupId === 'string' ? p.groupId.trim() : '');
      const gid = rawGid && groupIdSet.has(rawGid) ? rawGid : null;
      if (gid) base.projectGroupMap[id] = gid;
      else delete base.projectGroupMap[id];

      const aliases = dedupeStrings([...(Array.isArray(p.aliases) ? p.aliases : [])]).filter((a) => a !== id);
      const remote = sanitizeRemoteMeta(p.remote);

      base.projects.push({
        id,
        aliases,
        name: String(p.name || path.basename(rootPath) || id).trim() || id,
        rootPath,
        uri: typeof p.uri === 'string' && p.uri.trim().startsWith('file://') ? p.uri.trim() : (pathToFileUri(rootPath) || ''),
        groupId: gid,
        source: typeof p.source === 'string' && p.source.trim() ? p.source.trim() : 'local',
        syncedFromApp: Boolean(p.syncedFromApp),
        ...(remote ? { remote } : {}),
        createdAt: typeof p.createdAt === 'string' && p.createdAt.trim() ? p.createdAt.trim() : nowIso,
        updatedAt: typeof p.updatedAt === 'string' && p.updatedAt.trim() ? p.updatedAt.trim() : nowIso
      });
    }
  }

  if (isPlainObject(raw.sessionGroupMap)) {
    for (const [k, v] of Object.entries(raw.sessionGroupMap)) {
      const ck = String(k || '').trim();
      const cv = String(v || '').trim();
      if (ck && cv) base.sessionGroupMap[ck] = cv;
    }
  }

  if (isPlainObject(raw.sessionProjectOverrides)) {
    for (const [k, v] of Object.entries(raw.sessionProjectOverrides)) {
      const ck = String(k || '').trim();
      if (!ck) continue;
      if (v === null) {
        base.sessionProjectOverrides[ck] = null;
      } else if (typeof v === 'string' && v.trim()) {
        base.sessionProjectOverrides[ck] = v.trim();
      }
    }
  }

  if (isPlainObject(raw.groupOrder)) {
    base.groupOrder = sanitizeZoneOrder(raw.groupOrder);
  }

  if (isPlainObject(raw.projectOrder)) {
    for (const [k, v] of Object.entries(raw.projectOrder)) {
      const ck = String(k || '').trim();
      if (ck && isPlainObject(v)) {
        base.projectOrder[ck] = sanitizeZoneOrder(v);
      }
    }
  }

  if (isPlainObject(raw.sessionOrder)) {
    for (const [k, v] of Object.entries(raw.sessionOrder)) {
      const ck = String(k || '').trim();
      if (!ck) continue;
      if (ck === '__pinned__' && Array.isArray(v)) {
        base.sessionOrder.__pinned__ = dedupeStrings(v);
      } else if (isPlainObject(v)) {
        base.sessionOrder[ck] = sanitizeZoneOrder(v);
      }
    }
  }

  if (isPlainObject(raw.archivedSessions)) {
    for (const [cid, entry] of Object.entries(raw.archivedSessions)) {
      const cleanCid = String(cid || '').trim();
      if (!cleanCid || !isPlainObject(entry)) continue;
      base.archivedSessions[cleanCid] = {
        archivedAt: typeof entry.archivedAt === 'string' && entry.archivedAt.trim() ? entry.archivedAt.trim() : nowIso,
        archivedAtStepCount: Number.isFinite(Number(entry.archivedAtStepCount)) ? Math.max(0, Math.floor(Number(entry.archivedAtStepCount))) : 0,
        archivedWasRunning: Boolean(entry.archivedWasRunning),
        projectId: typeof entry.projectId === 'string' && entry.projectId.trim() ? entry.projectId.trim() : null,
        projectName: typeof entry.projectName === 'string' && entry.projectName.trim() ? entry.projectName.trim() : null,
        titleSnapshot: typeof entry.titleSnapshot === 'string' ? entry.titleSnapshot : ''
      };
    }
  }

  if (isPlainObject(raw.deletedSessions)) {
    for (const [cid, entry] of Object.entries(raw.deletedSessions)) {
      const cleanCid = String(cid || '').trim();
      if (!cleanCid || !isPlainObject(entry)) continue;
      base.deletedSessions[cleanCid] = {
        deletedAt: typeof entry.deletedAt === 'string' && entry.deletedAt.trim() ? entry.deletedAt.trim() : nowIso,
        mode: entry.mode === 'host_deleted' ? 'host_deleted' : 'local_tombstone'
      };
    }
  }

  if (isPlainObject(raw.migrations)) {
    base.migrations = {
      workspaceMetaV1At: typeof raw.migrations.workspaceMetaV1At === 'string' && raw.migrations.workspaceMetaV1At.trim()
        ? raw.migrations.workspaceMetaV1At.trim()
        : null
    };
  }

  return base;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function isLockStale(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const ts = Number(parsed?.ts || 0);
    const pid = Number(parsed?.pid || 0);
    if (Date.now() - ts > LOCK_STALE_MS) return true;
    if (pid > 0 && !isProcessAlive(pid)) return true;
    return false;
  } catch {
    try {
      const st = fs.statSync(lockPath);
      return (Date.now() - st.mtimeMs) > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

function acquireFileLockSync(lockPath) {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }), 0, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (isLockStale(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {}
      }
      if (Date.now() >= deadline) {
        try { fs.unlinkSync(lockPath); } catch {}
        const fd = fs.openSync(lockPath, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }), 0, 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        return true;
      }
      sleepSync(LOCK_RETRY_WAIT_MS);
    }
  }
}

function writeJsonAtomicSync(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2), 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, targetPath);
}

function buildOrgBusSummary(org, updatedBy) {
  return {
    revision: org.revision,
    updatedAt: org.updatedAt,
    updatedBy: updatedBy || org.updatedBy || null,
    pins: org.pins,
    groups: org.groups,
    projectGroupMap: org.projectGroupMap,
    groupOrder: org.groupOrder,
    projectOrder: org.projectOrder,
    sessionOrder: org.sessionOrder,
    archivedCount: Object.keys(org.archivedSessions || {}).length
  };
}

function remapProjectIdReferences(org, oldId, canonicalId) {
  if (!oldId || !canonicalId || oldId === canonicalId) return;
  if (org.pins.projects.includes(oldId)) {
    org.pins.projects = dedupeStrings(org.pins.projects.map((id) => (id === oldId ? canonicalId : id)));
    if (org.pinTimestamps.projects[oldId] && !org.pinTimestamps.projects[canonicalId]) {
      org.pinTimestamps.projects[canonicalId] = org.pinTimestamps.projects[oldId];
    }
    delete org.pinTimestamps.projects[oldId];
  }
  if (org.projectGroupMap[oldId]) {
    if (!org.projectGroupMap[canonicalId]) {
      org.projectGroupMap[canonicalId] = org.projectGroupMap[oldId];
    }
    delete org.projectGroupMap[oldId];
  }
  for (const g of org.groups) {
    if (g.projectIds.includes(oldId)) {
      g.projectIds = dedupeStrings(g.projectIds.map((id) => (id === oldId ? canonicalId : id)));
    }
  }
  for (const container of Object.values(org.projectOrder)) {
    if (!isPlainObject(container)) continue;
    for (const zone of ['pinned', 'normal']) {
      if (Array.isArray(container[zone]) && container[zone].includes(oldId)) {
        container[zone] = dedupeStrings(container[zone].map((id) => (id === oldId ? canonicalId : id)));
      }
    }
  }
  for (const [cid, pid] of Object.entries(org.sessionProjectOverrides)) {
    if (pid === oldId) org.sessionProjectOverrides[cid] = canonicalId;
  }
  if (org.sessionOrder[oldId] && !org.sessionOrder[canonicalId]) {
    org.sessionOrder[canonicalId] = org.sessionOrder[oldId];
    delete org.sessionOrder[oldId];
  }
}

function findPersistedProject(org, { id, rootPath, workspaceUri } = {}) {
  const normPath = normalizeLocalPath(rootPath || workspaceUri);
  if (normPath) {
    const keys = getPathLookupKeys(normPath);
    for (const proj of org.projects) {
      const projKeys = getPathLookupKeys(proj.rootPath);
      if (projKeys.some((k) => keys.includes(k))) {
        return proj;
      }
    }
  }
  const cleanId = typeof id === 'string' ? id.trim() : '';
  if (cleanId) {
    const direct = org.projects.find((p) => p.id === cleanId);
    if (direct) return direct;
    const byAlias = org.projects.find((p) => Array.isArray(p.aliases) && p.aliases.includes(cleanId));
    if (byAlias) return byAlias;
  }
  return null;
}

function computeKnownAliasesForPath(normPath, extraIds = []) {
  const aliases = [...extraIds];
  if (normPath) {
    const wsId = deriveProjectIdFromWorkspace(normPath);
    const appId = makeAppSyncedProjectId(normPath);
    const impId = makeImplicitProjectId(normPath);
    if (wsId) aliases.push(wsId);
    if (appId) aliases.push(appId);
    if (impId) aliases.push(impId);
  }
  return dedupeStrings(aliases);
}

function removeFromOrderArray(arr, id) {
  if (!Array.isArray(arr)) return arr;
  return arr.filter((x) => x !== id);
}

function readConversationSummariesDb(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  const sql = `
    SELECT conversation_id, title, preview, step_count, last_modified_time,
           workspace_uris, status, source, project_id, agent_name,
           parent_conversation_id, nesting_depth, group_id
    FROM conversation_summaries
    ORDER BY last_modified_time DESC
    LIMIT 2000
  `;
  if (DatabaseSync) {
    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare(sql).all();
      return Array.isArray(rows) ? rows : [];
    } catch {
      // Fallback to sqlite3 CLI if node:sqlite encounters WAL/locking edge case
    } finally {
      try { db?.close(); } catch {}
    }
  }
  try {
    const out = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024
    });
    const parsed = JSON.parse(out || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Shared host-side session organization store (groups, projects, pins, DB enrichment).
 * Persisted to ~/.agy-daddy/session-org.json so Remote and Web stay in sync.
 */
function createSessionOrgStore(options = {}) {
  const explicitOrgPath = options.orgPath !== undefined
    ? options.orgPath
    : (process.env.AGY_DADDY_SESSION_ORG_PATH || '');
  const orgPath = explicitOrgPath
    ? path.resolve(explicitOrgPath)
    : (explicitOrgPath === null || isTestMode() ? null : path.join(os.homedir(), '.agy-daddy', 'session-org.json'));

  const explicitDbPath = options.dbPath !== undefined
    ? options.dbPath
    : (process.env.AGY_DADDY_CONVERSATION_DB_PATH || undefined);
  const dbPath = explicitDbPath !== undefined
    ? (explicitDbPath ? path.resolve(explicitDbPath) : null)
    : (isTestMode() ? null : path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db'));

  const getAllowedRoots = typeof options.getAllowedRoots === 'function' ? options.getAllowedRoots : () => [];
  const pluginId = typeof options.pluginId === 'string' && options.pluginId.trim()
    ? options.pluginId.trim()
    : 'agy-daddy.remote';
  const onOrgChanged = typeof options.onOrgChanged === 'function' ? options.onOrgChanged : null;
  const onExternalOrgChanged = typeof options.onExternalOrgChanged === 'function' ? options.onExternalOrgChanged : null;

  let memoryOrg = createEmptyPersistedOrg();
  let dbCache = { loadedAt: 0, rows: [] };
  let localLoadedRevision = 0;
  let fsWatcher = null;
  let watchDebounceTimer = null;
  const containerRevisions = new Map();

  function readDiskOrgRaw() {
    if (!orgPath || !fs.existsSync(orgPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(orgPath, 'utf8'));
    } catch {
      return null;
    }
  }

  function loadPersistedOrg() {
    if (!orgPath) {
      return sanitizePersistedOrg(memoryOrg);
    }
    const raw = readDiskOrgRaw();
    const org = raw ? sanitizePersistedOrg(raw) : createEmptyPersistedOrg();
    if (org.revision > localLoadedRevision) {
      localLoadedRevision = org.revision;
    }
    return org;
  }

  function mutateOrgAtomically(mutatorFn, opts = {}) {
    const updatedBy = opts.updatedBy || pluginId;
    const lockPath = orgPath ? `${orgPath}.lock` : null;
    if (lockPath) {
      acquireFileLockSync(lockPath);
    }
    try {
      const latest = loadPersistedOrg();
      const outcome = mutatorFn(latest);
      if (outcome && outcome.abort) {
        return outcome.result;
      }
      latest.revision = (Number.isInteger(latest.revision) ? latest.revision : 0) + 1;
      latest.updatedAt = new Date().toISOString();
      latest.updatedBy = updatedBy;
      const clean = sanitizePersistedOrg(latest);
      if (orgPath) {
        writeJsonAtomicSync(orgPath, clean);
      } else {
        memoryOrg = clean;
      }
      localLoadedRevision = clean.revision;
      if (opts.emitChange !== false && onOrgChanged) {
        try {
          onOrgChanged(clean, buildOrgBusSummary(clean, updatedBy));
        } catch {}
      }
      if (outcome && Object.prototype.hasOwnProperty.call(outcome, 'buildResult')) {
        return outcome.buildResult(clean);
      }
      return { ok: true, org: clean, revision: clean.revision };
    } finally {
      if (lockPath) {
        try { fs.unlinkSync(lockPath); } catch {}
      }
    }
  }

  function syncFromExternalSignal(payload = {}) {
    if (!orgPath) {
      const incomingRev = Number(payload?.revision || 0);
      if (incomingRev > localLoadedRevision) {
        localLoadedRevision = incomingRev;
        if (onExternalOrgChanged) {
          try {
            onExternalOrgChanged(loadPersistedOrg(), payload);
          } catch {}
        }
        return true;
      }
      return false;
    }
    const prevRev = localLoadedRevision;
    const disk = loadPersistedOrg();
    if (disk.revision > prevRev || Number(payload?.revision || 0) > prevRev) {
      localLoadedRevision = Math.max(prevRev, disk.revision);
      if (onExternalOrgChanged) {
        try {
          onExternalOrgChanged(disk, buildOrgBusSummary(disk, disk.updatedBy));
        } catch {}
      }
      return true;
    }
    return false;
  }

  function startWatching() {
    if (!orgPath || fsWatcher) return;
    if (isTestMode() && options.watchDisk !== true) return;
    try {
      const dir = path.dirname(orgPath);
      const base = path.basename(orgPath);
      fs.mkdirSync(dir, { recursive: true });
      fsWatcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
        if (filename && String(filename) !== base) return;
        if (watchDebounceTimer) clearTimeout(watchDebounceTimer);
        watchDebounceTimer = setTimeout(() => {
          watchDebounceTimer = null;
          const prevRev = localLoadedRevision;
          const disk = loadPersistedOrg();
          if (disk.revision > prevRev && onExternalOrgChanged) {
            try {
              onExternalOrgChanged(disk, buildOrgBusSummary(disk, disk.updatedBy));
            } catch {}
          }
        }, WATCH_DEBOUNCE_MS);
        watchDebounceTimer.unref?.();
      });
      fsWatcher.unref?.();
    } catch {
      fsWatcher = null;
    }
  }

  function dispose() {
    if (watchDebounceTimer) {
      clearTimeout(watchDebounceTimer);
      watchDebounceTimer = null;
    }
    if (fsWatcher) {
      try { fsWatcher.close(); } catch {}
      fsWatcher = null;
    }
  }

  if (options.watchDisk === true || (!isTestMode() && orgPath)) {
    startWatching();
  }

  function materializeProjectInOrg(org, candidate = {}) {
    const normPath = normalizeLocalPath(candidate.rootPath || candidate.path || candidate.workspaceUri);
    const existing = findPersistedProject(org, {
      id: candidate.id,
      rootPath: normPath,
      workspaceUri: candidate.workspaceUri
    });

    if (existing) {
      const extraAliases = [];
      if (candidate.id && candidate.id !== existing.id) extraAliases.push(candidate.id);
      if (Array.isArray(candidate.aliases)) extraAliases.push(...candidate.aliases);
      const mergedAliases = computeKnownAliasesForPath(existing.rootPath, [...(existing.aliases || []), ...extraAliases])
        .filter((a) => a !== existing.id);
      existing.aliases = mergedAliases;
      for (const alias of mergedAliases) {
        remapProjectIdReferences(org, alias, existing.id);
      }
      return existing;
    }

    if (!normPath) return null;

    const rawId = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    const stableId = rawId || makeStableProjectId(normPath);
    const aliases = computeKnownAliasesForPath(normPath, Array.isArray(candidate.aliases) ? candidate.aliases : [])
      .filter((a) => a !== stableId);

    const nowIso = new Date().toISOString();
    const gid = typeof candidate.groupId === 'string' && org.groups.some((g) => g.id === candidate.groupId.trim())
      ? candidate.groupId.trim()
      : null;

    const entry = {
      id: stableId,
      aliases,
      name: String(candidate.name || path.basename(normPath) || stableId).trim() || stableId,
      rootPath: normPath,
      uri: pathToFileUri(normPath) || '',
      groupId: gid,
      source: typeof candidate.source === 'string' && candidate.source.trim()
        ? candidate.source.trim()
        : (candidate.syncedFromApp ? 'app' : 'local'),
      syncedFromApp: Boolean(candidate.syncedFromApp),
      ...(sanitizeRemoteMeta(candidate.remote) ? { remote: sanitizeRemoteMeta(candidate.remote) } : {}),
      createdAt: typeof candidate.createdAt === 'string' && candidate.createdAt.trim() ? candidate.createdAt.trim() : nowIso,
      updatedAt: nowIso
    };
    org.projects.push(entry);

    for (const alias of aliases) {
      remapProjectIdReferences(org, alias, entry.id);
    }
    if (org.projectGroupMap[entry.id] && !entry.groupId) {
      const mappedGid = org.projectGroupMap[entry.id];
      if (org.groups.some((g) => g.id === mappedGid)) entry.groupId = mappedGid;
      else delete org.projectGroupMap[entry.id];
    } else if (entry.groupId) {
      org.projectGroupMap[entry.id] = entry.groupId;
    }
    if (entry.groupId) {
      const grp = org.groups.find((g) => g.id === entry.groupId);
      if (grp && !grp.projectIds.includes(entry.id)) {
        grp.projectIds.push(entry.id);
      }
    }
    return entry;
  }

  function reconcileSessionsLifecycle(sessions = [], { forceUnarchiveIds = [] } = {}) {
    const current = loadPersistedOrg();
    const archivedEntries = current.archivedSessions || {};
    const archivedIds = Object.keys(archivedEntries);
    if (archivedIds.length === 0) {
      return { changed: false, unarchivedIds: [], org: current };
    }

    const sessionById = new Map();
    for (const s of (Array.isArray(sessions) ? sessions : [])) {
      const cid = String(s?.cascadeId || s?.id || '').trim();
      if (cid) sessionById.set(cid, s);
    }

    const forceSet = new Set((Array.isArray(forceUnarchiveIds) ? forceUnarchiveIds : []).map((x) => String(x || '').trim()).filter(Boolean));
    const toUnarchive = [];
    const toClearWasRunning = [];

    for (const cid of archivedIds) {
      if (forceSet.has(cid)) {
        toUnarchive.push(cid);
        continue;
      }
      const s = sessionById.get(cid);
      if (!s) continue;
      const arch = archivedEntries[cid];
      const status = String(s.status || '');
      const isRunningNow = Boolean(s.isRunning || RUNNING_STATUS_RE.test(status) || s.notFullyIdle);
      const needsAttentionNow = Boolean(s.needsAttention || /PENDING|WAITING|ERROR/i.test(status));

      if (needsAttentionNow) {
        toUnarchive.push(cid);
      } else if (arch.archivedWasRunning && !isRunningNow) {
        toClearWasRunning.push(cid);
      } else if (!arch.archivedWasRunning && isRunningNow) {
        toUnarchive.push(cid);
      }
    }

    if (toUnarchive.length === 0 && toClearWasRunning.length === 0) {
      return { changed: false, unarchivedIds: [], org: current };
    }

    const unarchivedSet = new Set(toUnarchive);
    const clearSet = new Set(toClearWasRunning);
    return mutateOrgAtomically((org) => {
      let modified = false;
      for (const cid of unarchivedSet) {
        if (org.archivedSessions[cid]) {
          delete org.archivedSessions[cid];
          modified = true;
        }
      }
      for (const cid of clearSet) {
        if (org.archivedSessions[cid] && org.archivedSessions[cid].archivedWasRunning) {
          org.archivedSessions[cid].archivedWasRunning = false;
          modified = true;
        }
      }
      if (!modified) {
        return { abort: true, result: { changed: false, unarchivedIds: [], org } };
      }
      return {
        buildResult: (saved) => ({
          changed: true,
          unarchivedIds: Array.from(unarchivedSet),
          org: saved
        })
      };
    });
  }

  function loadDbRows(forceRefresh = false) {
    if (!dbPath) return [];
    const now = Date.now();
    if (!forceRefresh && now - dbCache.loadedAt < DB_CACHE_TTL_MS) {
      return dbCache.rows;
    }
    const rows = readConversationSummariesDb(dbPath);
    dbCache = { loadedAt: now, rows };
    return rows;
  }

  function enrichSessionsAndOrg({
    rpcSessions = [],
    allowedRoots = null,
    includeSubagents = false,
    includeArchived = false,
    limit = DEFAULT_SESSION_LIMIT
  } = {}) {
    const reconciled = reconcileSessionsLifecycle(rpcSessions);
    const persisted = reconciled.org || loadPersistedOrg();
    const dbRows = loadDbRows();
    const roots = Array.isArray(allowedRoots) ? allowedRoots : getAllowedRoots();

    const dbById = new Map();
    for (const row of dbRows) {
      const cid = String(row?.conversation_id || '').trim();
      if (cid) dbById.set(cid, row);
    }

    const pinnedSessions = new Set(persisted.pins.sessions);
    const pinnedProjects = new Set(persisted.pins.projects);
    const pinnedGroups = new Set(persisted.pins.groups);
    const archivedMap = persisted.archivedSessions || {};
    const deletedMap = persisted.deletedSessions || {};
    const overridesMap = persisted.sessionProjectOverrides || {};

    const groupBySession = new Map(Object.entries(persisted.sessionGroupMap));
    const groupByProject = new Map(Object.entries(persisted.projectGroupMap));
    const groupByWorkspace = new Map();
    for (const g of persisted.groups) {
      for (const sid of g.sessionIds) {
        if (!groupBySession.has(sid)) groupBySession.set(sid, g.id);
      }
      for (const pid of g.projectIds) {
        if (!groupByProject.has(pid)) groupByProject.set(pid, g.id);
      }
      for (const ws of g.workspaceUris) {
        const normPath = normalizeUriToPath(ws);
        if (normPath && !groupByWorkspace.has(normPath)) groupByWorkspace.set(normPath, g.id);
      }
    }

    const projectsById = new Map();
    const projectByPathKey = new Map();
    const projectIdByAlias = new Map();

    // 0. Seed persisted Schema v2 projects first (canonical source of truth)
    for (const pp of (persisted.projects || [])) {
      const normPath = normalizeUriToPath(pp.rootPath || pp.uri);
      const gid = groupByProject.get(pp.id) || pp.groupId || null;
      const entry = {
        id: pp.id,
        aliases: Array.isArray(pp.aliases) ? [...pp.aliases] : [],
        name: pp.name,
        uri: pp.uri || (normPath ? pathToFileUri(normPath) : null),
        path: normPath || null,
        rootPath: normPath || null,
        groupId: gid,
        pinned: pinnedProjects.has(pp.id),
        source: pp.source || 'local',
        syncedFromApp: Boolean(pp.syncedFromApp),
        ...(pp.remote ? { remote: pp.remote } : {}),
        branchName: null,
        sessionCount: 0,
        lastModifiedTime: null
      };
      projectsById.set(pp.id, entry);
      if (normPath) {
        for (const k of getPathLookupKeys(normPath)) {
          if (!projectByPathKey.has(k)) projectByPathKey.set(k, entry);
        }
      }
      for (const alias of entry.aliases) {
        if (!projectIdByAlias.has(alias)) projectIdByAlias.set(alias, pp.id);
      }
    }

    function registerProject({ id, uri, fsPath, name, branchName = null, lastModifiedTime = null, groupId = null }) {
      if (isTempBridgeWorkspace(fsPath || uri) || isTempBridgeWorkspace(name)) return null;
      const normPath = normalizeUriToPath(fsPath || uri);
      const normUri = uri && String(uri).startsWith('file://') ? String(uri).trim() : (normPath ? pathToFileUri(normPath) : null);

      // 1st priority: match by canonical path key against existing projects
      if (normPath) {
        for (const k of getPathLookupKeys(normPath)) {
          const pathHit = projectByPathKey.get(k);
          if (pathHit) {
            if (!pathHit.uri && normUri) pathHit.uri = normUri;
            if (!pathHit.branchName && branchName) pathHit.branchName = branchName;
            if (!pathHit.groupId && groupId) pathHit.groupId = groupId;
            if (lastModifiedTime && (!pathHit.lastModifiedTime || Date.parse(lastModifiedTime) > Date.parse(pathHit.lastModifiedTime))) {
              pathHit.lastModifiedTime = lastModifiedTime;
            }
            return pathHit;
          }
        }
      }

      // 2nd priority: match by id or alias
      let resolvedId = !isGenericDbProjectId(id) ? String(id).trim() : '';
      if (resolvedId && projectIdByAlias.has(resolvedId)) {
        resolvedId = projectIdByAlias.get(resolvedId);
      }
      if (resolvedId && projectsById.has(resolvedId)) {
        const hit = projectsById.get(resolvedId);
        if (!hit.uri && normUri) hit.uri = normUri;
        if (!hit.branchName && branchName) hit.branchName = branchName;
        if (!hit.groupId && groupId) hit.groupId = groupId;
        if (lastModifiedTime && (!hit.lastModifiedTime || Date.parse(lastModifiedTime) > Date.parse(hit.lastModifiedTime))) {
          hit.lastModifiedTime = lastModifiedTime;
        }
        return hit;
      }

      if (!resolvedId && normPath) {
        resolvedId = deriveProjectIdFromWorkspace(normPath);
      }
      if (!resolvedId) return null;

      const resolvedGroupId = groupByProject.get(resolvedId)
        || (normPath ? groupByWorkspace.get(normPath) : null)
        || groupId
        || null;

      const entry = {
        id: resolvedId,
        name: String(name || extractWorkspaceDisplayName(normPath || normUri) || resolvedId),
        uri: normUri,
        path: normPath || null,
        rootPath: normPath || null,
        groupId: resolvedGroupId,
        pinned: pinnedProjects.has(resolvedId),
        branchName: branchName || null,
        sessionCount: 0,
        lastModifiedTime: lastModifiedTime || null
      };
      projectsById.set(resolvedId, entry);
      if (normPath) {
        for (const k of getPathLookupKeys(normPath)) {
          if (!projectByPathKey.has(k)) projectByPathKey.set(k, entry);
        }
      }
      return entry;
    }

    // 1. Seed projects from DB rows
    const hostGroupIds = new Set();
    for (const row of dbRows) {
      const dbGroup = String(row?.group_id || '').trim();
      if (dbGroup) hostGroupIds.add(dbGroup);
      const uris = parseWorkspaceUrisField(row?.workspace_uris);
      const primaryUri = pickPrimaryWorkspaceUri(uris);
      const dbProjectId = String(row?.project_id || '').trim();
      if (primaryUri && !isTempBridgeWorkspace(primaryUri)) {
        registerProject({
          id: dbProjectId,
          uri: primaryUri,
          lastModifiedTime: row?.last_modified_time || null,
          groupId: dbGroup || null
        });
      } else if (!isGenericDbProjectId(dbProjectId)) {
        registerProject({
          id: dbProjectId,
          uri: primaryUri,
          lastModifiedTime: row?.last_modified_time || null,
          groupId: dbGroup || null
        });
      }
    }

    // 2. Seed projects from allowedRoots
    for (const root of (Array.isArray(roots) ? roots : [])) {
      const normPath = normalizeUriToPath(root);
      if (normPath) {
        registerProject({ fsPath: normPath, uri: pathToFileUri(normPath) });
      }
    }

    // 3. Enrich RPC sessions with DB & org metadata
    const enrichedAll = [];
    for (const s of (Array.isArray(rpcSessions) ? rpcSessions : [])) {
      if (!isPlainObject(s)) continue;
      const cid = String(s.cascadeId || s.id || '').trim();
      if (!cid || deletedMap[cid]) continue;

      const dbRow = dbById.get(cid) || null;
      const dbUris = dbRow ? parseWorkspaceUrisField(dbRow.workspace_uris) : [];
      const rpcUris = Array.isArray(s.workspaces)
        ? s.workspaces.map((ws) => (isPlainObject(ws) ? (ws.workspaceFolderAbsoluteUri || ws.workspaceUri || '') : '')).filter(Boolean)
        : [];
      const allWsUris = [s.workspaceUri, ...rpcUris, ...dbUris].filter(Boolean);
      const isInternalTempOnlySession = allWsUris.length > 0 && allWsUris.every((u) => isTempBridgeWorkspace(u));
      if (isInternalTempOnlySession && !pinnedSessions.has(cid)) continue;

      const rawWsUri = s.workspaceUri && !isTempBridgeWorkspace(s.workspaceUri) ? s.workspaceUri : null;
      const primaryWsUri = rawWsUri || pickPrimaryWorkspaceUri(rpcUris) || pickPrimaryWorkspaceUri(dbUris) || null;
      const normWsPath = normalizeUriToPath(primaryWsUri);
      const dbProjectId = String(dbRow?.project_id || '').trim();
      const dbGroupId = String(dbRow?.group_id || '').trim();
      if (dbGroupId) hostGroupIds.add(dbGroupId);

      let proj = null;
      if (Object.prototype.hasOwnProperty.call(overridesMap, cid)) {
        const overridePid = overridesMap[cid];
        if (overridePid) {
          const mappedPid = projectIdByAlias.get(overridePid) || overridePid;
          proj = projectsById.get(mappedPid) || null;
        }
      } else if ((primaryWsUri && !isTempBridgeWorkspace(primaryWsUri)) || !isGenericDbProjectId(dbProjectId)) {
        proj = registerProject({
          id: dbProjectId,
          uri: primaryWsUri,
          name: s.repoName || extractWorkspaceDisplayName(primaryWsUri),
          branchName: s.branchName || null,
          lastModifiedTime: s.lastModifiedTime || s.createdTime || dbRow?.last_modified_time || null,
          groupId: dbGroupId || null
        });
      }

      const projectId = proj?.id || (Object.prototype.hasOwnProperty.call(overridesMap, cid) ? overridesMap[cid] : (!isGenericDbProjectId(dbProjectId) ? dbProjectId : null));
      const projectName = proj?.name || (projectId === null ? null : (s.repoName || extractWorkspaceDisplayName(primaryWsUri) || null));
      const parentConversationId = String(dbRow?.parent_conversation_id || s.parentConversationId || '').trim() || null;
      const nestingDepth = Number.isFinite(Number(dbRow?.nesting_depth))
        ? Number(dbRow.nesting_depth)
        : (Number.isFinite(Number(s.nestingDepth)) ? Number(s.nestingDepth) : 0);
      const agentName = String(dbRow?.agent_name || s.agentName || '').trim() || null;
      const isSubagent = Boolean(s.isSubagent || parentConversationId || nestingDepth > 0);
      const archEntry = archivedMap[cid] || null;
      const archived = Boolean(archEntry);

      const groupId = groupBySession.get(cid)
        || (projectId ? groupByProject.get(projectId) : null)
        || (normWsPath ? groupByWorkspace.get(normWsPath) : null)
        || (dbGroupId || null)
        || (proj?.groupId || null);

      const pinned = pinnedSessions.has(cid);
      const pinnedAt = pinned ? (persisted.pinTimestamps?.sessions?.[cid] || null) : null;
      const enriched = {
        ...s,
        cascadeId: cid,
        workspaceUri: primaryWsUri,
        groupId: groupId || null,
        projectId: projectId || null,
        projectName,
        pinned,
        pinnedAt,
        archived,
        ...(archived ? { archivedAt: archEntry.archivedAt } : {}),
        parentConversationId,
        nestingDepth,
        agentName,
        isSubagent
      };
      enrichedAll.push(enriched);

      if (proj && !archived && (!isSubagent || includeSubagents)) {
        proj.sessionCount += 1;
      }
    }

    const visibleSessions = enrichedAll.filter((s) => {
      if (!includeSubagents && s.isSubagent) return false;
      if (!includeArchived && s.archived) return false;
      return true;
    });

    const pinnedGlobalOrder = Array.isArray(persisted.sessionOrder?.__pinned__) ? persisted.sessionOrder.__pinned__ : [];
    const pinnedGlobalIdx = new Map(pinnedGlobalOrder.map((id, idx) => [id, idx]));

    visibleSessions.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned && b.pinned) {
        if (pinnedGlobalIdx.has(a.cascadeId) && pinnedGlobalIdx.has(b.cascadeId)) {
          return pinnedGlobalIdx.get(a.cascadeId) - pinnedGlobalIdx.get(b.cascadeId);
        }
      }
      const tb = Date.parse(b.lastModifiedTime || b.createdTime || '') || 0;
      const ta = Date.parse(a.lastModifiedTime || a.createdTime || '') || 0;
      return tb - ta;
    });

    const parsedLimit = Number(limit);
    const effectiveLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(Math.floor(parsedLimit), MAX_SESSION_LIMIT)
      : DEFAULT_SESSION_LIMIT;
    const boundedSessions = visibleSessions.slice(0, effectiveLimit);

    // Assemble groups (persisted user groups + discovered host groups)
    const groupsById = new Map();
    for (const g of persisted.groups) {
      groupsById.set(g.id, {
        id: g.id,
        name: g.name,
        source: g.source || 'user',
        collapsed: Boolean(g.collapsed),
        pinned: pinnedGroups.has(g.id),
        order: g.order,
        projectIds: [...g.projectIds],
        workspaceUris: [...g.workspaceUris],
        sessionIds: [...g.sessionIds]
      });
    }
    let hostOrder = persisted.groups.length;
    for (const hgid of hostGroupIds) {
      if (!groupsById.has(hgid)) {
        groupsById.set(hgid, {
          id: hgid,
          name: hgid,
          source: 'host',
          collapsed: false,
          pinned: pinnedGroups.has(hgid),
          order: hostOrder++,
          projectIds: [],
          workspaceUris: [],
          sessionIds: []
        });
      }
    }

    for (const proj of projectsById.values()) {
      if (proj.groupId && groupsById.has(proj.groupId)) {
        const g = groupsById.get(proj.groupId);
        if (!g.projectIds.includes(proj.id)) g.projectIds.push(proj.id);
        if (proj.uri && !g.workspaceUris.includes(proj.uri)) g.workspaceUris.push(proj.uri);
      }
    }
    for (const s of visibleSessions) {
      if (s.groupId && groupsById.has(s.groupId)) {
        const g = groupsById.get(s.groupId);
        if (!g.sessionIds.includes(s.cascadeId)) g.sessionIds.push(s.cascadeId);
      }
    }

    // Sort projects using projectOrder per container if present, else pinned -> lastModifiedTime
    const projectOrderMap = persisted.projectOrder || {};
    const projects = Array.from(projectsById.values()).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const ga = a.groupId || '__ungrouped__';
      const gb = b.groupId || '__ungrouped__';
      if (ga === gb && projectOrderMap[ga]) {
        const zoneArr = a.pinned ? projectOrderMap[ga].pinned : projectOrderMap[ga].normal;
        if (Array.isArray(zoneArr) && zoneArr.length > 0) {
          const ia = zoneArr.indexOf(a.id);
          const ib = zoneArr.indexOf(b.id);
          if (ia >= 0 && ib >= 0) return ia - ib;
          if (ia >= 0) return 1; // New unpositioned item goes to top of normal zone
          if (ib >= 0) return -1;
        }
      }
      const tb = Date.parse(b.lastModifiedTime || '') || 0;
      const ta = Date.parse(a.lastModifiedTime || '') || 0;
      if (tb !== ta) return tb - ta;
      return a.name.localeCompare(b.name);
    });

    const grpPinnedIdx = new Map((persisted.groupOrder?.pinned || []).map((id, idx) => [id, idx]));
    const grpNormalIdx = new Map((persisted.groupOrder?.normal || []).map((id, idx) => [id, idx]));

    const groups = Array.from(groupsById.values()).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.pinned) {
        const ia = grpPinnedIdx.has(a.id) ? grpPinnedIdx.get(a.id) : Number.MAX_SAFE_INTEGER;
        const ib = grpPinnedIdx.has(b.id) ? grpPinnedIdx.get(b.id) : Number.MAX_SAFE_INTEGER;
        if (ia !== ib) return ia - ib;
      } else {
        const ia = grpNormalIdx.has(a.id) ? grpNormalIdx.get(a.id) : Number.MAX_SAFE_INTEGER;
        const ib = grpNormalIdx.has(b.id) ? grpNormalIdx.get(b.id) : Number.MAX_SAFE_INTEGER;
        if (ia !== ib) return ia - ib;
      }
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    });

    return {
      version: 2,
      revision: persisted.revision,
      sessions: boundedSessions,
      totalVisibleSessions: visibleSessions.length,
      groups,
      projects,
      pins: {
        sessions: [...persisted.pins.sessions],
        projects: [...persisted.pins.projects],
        groups: [...persisted.pins.groups]
      },
      pinTimestamps: persisted.pinTimestamps,
      projectGroupMap: persisted.projectGroupMap,
      sessionGroupMap: persisted.sessionGroupMap,
      sessionProjectOverrides: persisted.sessionProjectOverrides,
      groupOrder: persisted.groupOrder,
      projectOrder: persisted.projectOrder,
      sessionOrder: persisted.sessionOrder,
      archivedCount: Object.keys(archivedMap).length,
      ...(includeArchived ? { archivedSessions: archivedMap } : {}),
      defaultSessionPath: persisted.defaultSessionPath || path.join(os.homedir(), 'antigravity-workspace')
    };
  }

  function getOrg(opts = {}) {
    const res = enrichSessionsAndOrg({ ...opts, limit: MAX_SESSION_LIMIT });
    return {
      ok: true,
      version: 2,
      revision: res.revision,
      groups: res.groups,
      projects: res.projects,
      pins: res.pins,
      pinTimestamps: res.pinTimestamps,
      projectGroupMap: res.projectGroupMap,
      sessionGroupMap: res.sessionGroupMap,
      sessionProjectOverrides: res.sessionProjectOverrides,
      groupOrder: res.groupOrder,
      projectOrder: res.projectOrder,
      sessionOrder: res.sessionOrder,
      archivedCount: res.archivedCount,
      ...(opts?.includeArchived ? { archivedSessions: res.archivedSessions || {} } : {}),
      defaultSessionPath: res.defaultSessionPath
    };
  }

  function togglePin({ type, id, pinned, workspaceUri, rootPath, projectName } = {}) {
    const cleanType = String(type || '').trim().toLowerCase();
    const cleanId = String(id || '').trim();
    const bucketMap = {
      session: 'sessions',
      sessions: 'sessions',
      project: 'projects',
      projects: 'projects',
      group: 'groups',
      groups: 'groups'
    };
    const bucketKey = bucketMap[cleanType];
    if (!bucketKey || !cleanId) {
      return { ok: false, statusCode: 400, error: 'INVALID_PIN_PARAMS' };
    }

    return mutateOrgAtomically((org) => {
      if (bucketKey === 'sessions') {
        if (org.deletedSessions[cleanId]) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'SESSION_NOT_FOUND' } };
        }
        const willPin = typeof pinned === 'boolean' ? pinned : !org.pins.sessions.includes(cleanId);
        if (willPin && org.archivedSessions[cleanId]) {
          return { abort: true, result: { ok: false, statusCode: 409, error: 'SESSION_ARCHIVED' } };
        }
      }

      let resolvedId = cleanId;
      if (bucketKey === 'projects') {
        let proj = findPersistedProject(org, { id: cleanId, rootPath, workspaceUri });
        if (!proj && (rootPath || workspaceUri)) {
          proj = materializeProjectInOrg(org, {
            id: cleanId,
            rootPath,
            workspaceUri,
            name: projectName,
            syncedFromApp: cleanId.startsWith('app:'),
            source: cleanId.startsWith('app:') ? 'app' : (cleanId.startsWith('implicit:') ? 'implicit' : 'local')
          });
        }
        if (proj) {
          resolvedId = proj.id;
        }
      }

      const list = org.pins[bucketKey] || [];
      const exists = list.includes(resolvedId);
      const nextPinned = typeof pinned === 'boolean' ? pinned : !exists;
      const nowIso = new Date().toISOString();

      if (nextPinned && !exists) {
        list.push(resolvedId);
        org.pinTimestamps[bucketKey][resolvedId] = nowIso;
      } else if (!nextPinned && exists) {
        org.pins[bucketKey] = list.filter((x) => x !== resolvedId);
        delete org.pinTimestamps[bucketKey][resolvedId];
      } else {
        org.pins[bucketKey] = list;
        if (nextPinned && !org.pinTimestamps[bucketKey][resolvedId]) {
          org.pinTimestamps[bucketKey][resolvedId] = nowIso;
        }
      }

      if (bucketKey === 'groups') {
        org.groupOrder.pinned = removeFromOrderArray(org.groupOrder.pinned, resolvedId);
        org.groupOrder.normal = removeFromOrderArray(org.groupOrder.normal, resolvedId);
        if (nextPinned && org.groupOrder.pinned.length > 0) org.groupOrder.pinned.push(resolvedId);
        if (!nextPinned && org.groupOrder.normal.length > 0) org.groupOrder.normal.unshift(resolvedId);
      } else if (bucketKey === 'projects') {
        const gid = org.projectGroupMap[resolvedId] || '__ungrouped__';
        const ord = org.projectOrder[gid];
        if (ord) {
          ord.pinned = removeFromOrderArray(ord.pinned, resolvedId);
          ord.normal = removeFromOrderArray(ord.normal, resolvedId);
          if (nextPinned && ord.pinned.length > 0) ord.pinned.push(resolvedId);
          if (!nextPinned && ord.normal.length > 0) ord.normal.unshift(resolvedId);
        }
      } else if (bucketKey === 'sessions') {
        if (Array.isArray(org.sessionOrder.__pinned__)) {
          org.sessionOrder.__pinned__ = removeFromOrderArray(org.sessionOrder.__pinned__, resolvedId);
          if (nextPinned) org.sessionOrder.__pinned__.unshift(resolvedId);
        }
        for (const [ck, ord] of Object.entries(org.sessionOrder)) {
          if (ck === '__pinned__' || !isPlainObject(ord)) continue;
          const had = (ord.pinned || []).includes(resolvedId) || (ord.normal || []).includes(resolvedId);
          if (!had) continue;
          ord.pinned = removeFromOrderArray(ord.pinned, resolvedId);
          ord.normal = removeFromOrderArray(ord.normal, resolvedId);
          if (nextPinned) ord.pinned.push(resolvedId);
          else ord.normal.unshift(resolvedId);
        }
      }

      const singular = bucketKey.slice(0, -1);
      return {
        buildResult: (saved) => ({
          ok: true,
          type: singular,
          id: resolvedId,
          pinned: nextPinned,
          pinnedAt: saved.pinTimestamps[bucketKey][resolvedId] || null,
          pins: saved.pins,
          pinTimestamps: saved.pinTimestamps,
          revision: saved.revision
        })
      };
    });
  }

  function mutateGroup(body = {}) {
    if (!isPlainObject(body)) {
      return { ok: false, statusCode: 400, error: 'INVALID_GROUP_BODY' };
    }
    const action = String(body.action || 'upsert').trim().toLowerCase();

    return mutateOrgAtomically((org) => {
      if (action === 'delete') {
        const id = String(body.id || '').trim();
        if (!id) return { abort: true, result: { ok: false, statusCode: 400, error: 'MISSING_GROUP_ID' } };
        org.groups = org.groups.filter((g) => g.id !== id);
        org.pins.groups = org.pins.groups.filter((gid) => gid !== id);
        delete org.pinTimestamps.groups[id];
        org.groupOrder.pinned = removeFromOrderArray(org.groupOrder.pinned, id);
        org.groupOrder.normal = removeFromOrderArray(org.groupOrder.normal, id);
        for (const [k, v] of Object.entries(org.projectGroupMap)) {
          if (v === id) delete org.projectGroupMap[k];
        }
        for (const p of org.projects) {
          if (p.groupId === id) p.groupId = null;
        }
        for (const [k, v] of Object.entries(org.sessionGroupMap)) {
          if (v === id) delete org.sessionGroupMap[k];
        }
        if (org.projectOrder[id]) {
          const prevOrd = org.projectOrder[id];
          if (org.projectOrder.__ungrouped__) {
            org.projectOrder.__ungrouped__.pinned = dedupeStrings([...org.projectOrder.__ungrouped__.pinned, ...(prevOrd.pinned || [])]);
            org.projectOrder.__ungrouped__.normal = dedupeStrings([...org.projectOrder.__ungrouped__.normal, ...(prevOrd.normal || [])]);
          }
          delete org.projectOrder[id];
        }
        return {
          buildResult: (saved) => ({
            ok: true,
            action: 'delete',
            id,
            groups: saved.groups,
            pins: saved.pins,
            revision: saved.revision
          })
        };
      }

      if (action === 'assign') {
        const groupId = body.groupId ? String(body.groupId).trim() : null;
        let projectId = body.projectId ? String(body.projectId).trim() : '';
        const sessionId = body.sessionId ? String(body.sessionId).trim() : '';
        const workspaceUri = body.workspaceUri ? String(body.workspaceUri).trim() : '';
        const rootPath = body.rootPath ? String(body.rootPath).trim() : '';
        if (!projectId && !sessionId && !workspaceUri && !rootPath) {
          return { abort: true, result: { ok: false, statusCode: 400, error: 'MISSING_ASSIGN_TARGET' } };
        }
        if (groupId && !org.groups.some((g) => g.id === groupId)) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' } };
        }
        if (projectId || rootPath || workspaceUri) {
          let proj = findPersistedProject(org, { id: projectId, rootPath, workspaceUri });
          if (!proj && (rootPath || workspaceUri)) {
            proj = materializeProjectInOrg(org, { id: projectId, rootPath, workspaceUri });
          }
          if (proj) projectId = proj.id;
        }
        if (projectId) {
          const prevGid = org.projectGroupMap[projectId] || '__ungrouped__';
          if (groupId) org.projectGroupMap[projectId] = groupId;
          else delete org.projectGroupMap[projectId];
          for (const p of org.projects) {
            if (p.id === projectId) {
              p.groupId = groupId;
              p.updatedAt = new Date().toISOString();
            }
          }
          for (const g of org.groups) {
            g.projectIds = g.projectIds.filter((p) => p !== projectId);
            if (groupId && g.id === groupId) g.projectIds.push(projectId);
          }
          const nextGid = groupId || '__ungrouped__';
          if (prevGid !== nextGid) {
            const isPinned = org.pins.projects.includes(projectId);
            if (org.projectOrder[prevGid]) {
              org.projectOrder[prevGid].pinned = removeFromOrderArray(org.projectOrder[prevGid].pinned, projectId);
              org.projectOrder[prevGid].normal = removeFromOrderArray(org.projectOrder[prevGid].normal, projectId);
            }
            if (org.projectOrder[nextGid]) {
              if (isPinned) org.projectOrder[nextGid].pinned.push(projectId);
              else org.projectOrder[nextGid].normal.unshift(projectId);
            }
          }
        }
        if (sessionId) {
          if (groupId) org.sessionGroupMap[sessionId] = groupId;
          else delete org.sessionGroupMap[sessionId];
          for (const g of org.groups) {
            g.sessionIds = g.sessionIds.filter((s) => s !== sessionId);
            if (groupId && g.id === groupId) g.sessionIds.push(sessionId);
          }
        }
        if (workspaceUri) {
          const normPath = normalizeUriToPath(workspaceUri);
          for (const g of org.groups) {
            g.workspaceUris = g.workspaceUris.filter((u) => normalizeUriToPath(u) !== normPath);
            if (groupId && g.id === groupId) g.workspaceUris.push(workspaceUri);
          }
        }
        return {
          buildResult: (saved) => ({
            ok: true,
            action: 'assign',
            groupId,
            projectId: projectId || undefined,
            groups: saved.groups,
            pins: saved.pins,
            revision: saved.revision
          })
        };
      }

      const name = String(body.name || '').trim();
      const id = String(body.id || '').trim() || `grp_${crypto.randomBytes(4).toString('hex')}`;
      const existingIdx = org.groups.findIndex((g) => g.id === id);
      if (!name && existingIdx < 0) {
        return { abort: true, result: { ok: false, statusCode: 400, error: 'MISSING_GROUP_NAME' } };
      }
      const prev = existingIdx >= 0 ? org.groups[existingIdx] : null;
      const nowIso = new Date().toISOString();
      const nextGroup = {
        id,
        name: name || prev?.name || id,
        source: prev?.source || 'user',
        collapsed: typeof body.collapsed === 'boolean' ? body.collapsed : Boolean(prev?.collapsed),
        order: Number.isFinite(Number(body.order)) ? Number(body.order) : (prev ? prev.order : org.groups.length),
        projectIds: Array.isArray(body.projectIds) ? dedupeStrings(body.projectIds) : (prev?.projectIds || []),
        workspaceUris: Array.isArray(body.workspaceUris) ? dedupeStrings(body.workspaceUris) : (prev?.workspaceUris || []),
        sessionIds: Array.isArray(body.sessionIds) ? dedupeStrings(body.sessionIds) : (prev?.sessionIds || []),
        createdAt: prev?.createdAt || nowIso,
        updatedAt: nowIso
      };
      if (existingIdx >= 0) {
        org.groups[existingIdx] = nextGroup;
      } else {
        org.groups.push(nextGroup);
        if (org.groupOrder.normal.length > 0 && !org.groupOrder.normal.includes(id)) {
          org.groupOrder.normal.push(id);
        }
      }
      for (const pid of nextGroup.projectIds) {
        org.projectGroupMap[pid] = id;
        const pObj = org.projects.find((p) => p.id === pid);
        if (pObj) pObj.groupId = id;
      }
      for (const sid of nextGroup.sessionIds) org.sessionGroupMap[sid] = id;
      return {
        buildResult: (saved) => ({
          ok: true,
          action: 'upsert',
          group: nextGroup,
          groups: saved.groups,
          pins: saved.pins,
          revision: saved.revision
        })
      };
    });
  }

  function reorderOrg(body = {}) {
    if (!isPlainObject(body)) {
      return { ok: false, statusCode: 400, error: 'INVALID_REORDER_BODY' };
    }
    const targetType = String(body.targetType || '').trim();
    const zone = String(body.zone || '').trim();
    const containerId = body.containerId !== undefined && body.containerId !== null
      ? String(body.containerId).trim()
      : (targetType === 'project' ? '__ungrouped__' : (targetType === 'session' ? '__standalone__' : '__groups__'));
    const rawOrderedIds = Array.isArray(body.orderedIds) ? dedupeStrings(body.orderedIds) : null;
    const expectedRevision = Number.isInteger(Number(body.expectedRevision)) ? Number(body.expectedRevision) : null;
    const movedProject = isPlainObject(body.movedProject) ? body.movedProject : null;

    if (!['group', 'project', 'session'].includes(targetType)) {
      return { ok: false, statusCode: 400, error: 'INVALID_TARGET_TYPE' };
    }
    if (!['pinned', 'normal'].includes(zone)) {
      return { ok: false, statusCode: 400, error: 'INVALID_ZONE' };
    }
    if (!rawOrderedIds) {
      return { ok: false, statusCode: 400, error: 'INVALID_ORDERED_IDS' };
    }

    const containerKey = `${targetType}:${containerId}:${zone}`;

    return mutateOrgAtomically((org) => {
      if (expectedRevision !== null && expectedRevision < org.revision) {
        const lastContRev = containerRevisions.get(containerKey) || 0;
        if (lastContRev > expectedRevision) {
          return {
            abort: true,
            result: {
              ok: false,
              statusCode: 409,
              error: 'REVISION_CONFLICT',
              revision: org.revision,
              org: getOrg()
            }
          };
        }
      }

      if (targetType === 'group') {
        const pinnedSet = new Set(org.pins.groups);
        for (const id of rawOrderedIds) {
          if (pinnedSet.has(id) !== (zone === 'pinned')) {
            return {
              abort: true,
              result: { ok: false, statusCode: 409, error: 'ZONE_PIN_MISMATCH', id, zone, revision: org.revision }
            };
          }
        }
        org.groupOrder[zone] = rawOrderedIds;
        const fullSeq = [...org.groupOrder.pinned, ...org.groupOrder.normal];
        for (const g of org.groups) {
          const pos = fullSeq.indexOf(g.id);
          if (pos >= 0) g.order = pos;
        }
        return {
          buildResult: (saved) => {
            containerRevisions.set(containerKey, saved.revision);
            return { ok: true, revision: saved.revision, org: getOrg() };
          }
        };
      }

      if (targetType === 'project') {
        let movedCanonicalId = '';
        let toGroupId = containerId === '__ungrouped__' ? null : containerId;
        if (movedProject) {
          const rawToGid = movedProject.toGroupId === undefined ? toGroupId : movedProject.toGroupId;
          toGroupId = rawToGid && String(rawToGid).trim() && String(rawToGid).trim() !== '__ungrouped__'
            ? String(rawToGid).trim()
            : null;
          if (toGroupId && !org.groups.some((g) => g.id === toGroupId)) {
            return { abort: true, result: { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' } };
          }
          const rawPid = String(movedProject.projectId || '').trim();
          const wsUri = movedProject.workspaceUri ? String(movedProject.workspaceUri).trim() : '';
          let proj = findPersistedProject(org, { id: rawPid, workspaceUri: wsUri });
          if (!proj && wsUri) {
            proj = materializeProjectInOrg(org, {
              id: rawPid,
              workspaceUri: wsUri,
              syncedFromApp: rawPid.startsWith('app:'),
              source: rawPid.startsWith('app:') ? 'app' : (rawPid.startsWith('implicit:') ? 'implicit' : 'local')
            });
          }
          movedCanonicalId = proj ? proj.id : rawPid;
          if (!movedCanonicalId) {
            return { abort: true, result: { ok: false, statusCode: 400, error: 'MISSING_MOVED_PROJECT' } };
          }
          const fromGroupId = movedProject.fromGroupId ? String(movedProject.fromGroupId).trim() : (org.projectGroupMap[movedCanonicalId] || null);
          const fromKey = fromGroupId || '__ungrouped__';
          if (org.projectOrder[fromKey]) {
            org.projectOrder[fromKey].pinned = removeFromOrderArray(org.projectOrder[fromKey].pinned, movedCanonicalId);
            org.projectOrder[fromKey].normal = removeFromOrderArray(org.projectOrder[fromKey].normal, movedCanonicalId);
          }
          if (toGroupId) org.projectGroupMap[movedCanonicalId] = toGroupId;
          else delete org.projectGroupMap[movedCanonicalId];
          for (const p of org.projects) {
            if (p.id === movedCanonicalId) {
              p.groupId = toGroupId;
              p.updatedAt = new Date().toISOString();
            }
          }
          for (const g of org.groups) {
            g.projectIds = g.projectIds.filter((p) => p !== movedCanonicalId);
            if (toGroupId && g.id === toGroupId) g.projectIds.push(movedCanonicalId);
          }
        }

        const targetContainer = toGroupId || '__ungrouped__';
        if (targetContainer !== '__ungrouped__' && !org.groups.some((g) => g.id === targetContainer)) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' } };
        }

        const normalizedIds = rawOrderedIds.map((id) => {
          const found = findPersistedProject(org, { id });
          return found ? found.id : id;
        });
        if (movedCanonicalId && !normalizedIds.includes(movedCanonicalId)) {
          normalizedIds.push(movedCanonicalId);
        }

        const pinnedSet = new Set(org.pins.projects);
        for (const id of normalizedIds) {
          if (pinnedSet.has(id) !== (zone === 'pinned')) {
            return {
              abort: true,
              result: { ok: false, statusCode: 409, error: 'ZONE_PIN_MISMATCH', id, zone, revision: org.revision }
            };
          }
        }

        if (!org.projectOrder[targetContainer]) {
          org.projectOrder[targetContainer] = { pinned: [], normal: [] };
        }
        org.projectOrder[targetContainer][zone] = dedupeStrings(normalizedIds);

        return {
          buildResult: (saved) => {
            containerRevisions.set(containerKey, saved.revision);
            return { ok: true, revision: saved.revision, org: getOrg() };
          }
        };
      }

      const pinnedSet = new Set(org.pins.sessions);
      if (containerId === '__pinned__' && zone !== 'pinned') {
        return {
          abort: true,
          result: { ok: false, statusCode: 409, error: 'ZONE_PIN_MISMATCH', zone, revision: org.revision }
        };
      }
      for (const id of rawOrderedIds) {
        if (pinnedSet.has(id) !== (zone === 'pinned')) {
          return {
            abort: true,
            result: { ok: false, statusCode: 409, error: 'ZONE_PIN_MISMATCH', id, zone, revision: org.revision }
          };
        }
      }
      if (containerId === '__pinned__') {
        org.sessionOrder.__pinned__ = rawOrderedIds;
      } else {
        const foundProj = containerId === '__standalone__' ? null : findPersistedProject(org, { id: containerId });
        const resolvedCid = foundProj ? foundProj.id : containerId;
        if (!isPlainObject(org.sessionOrder[resolvedCid])) {
          org.sessionOrder[resolvedCid] = { pinned: [], normal: [] };
        }
        org.sessionOrder[resolvedCid][zone] = rawOrderedIds;
      }

      return {
        buildResult: (saved) => {
          containerRevisions.set(containerKey, saved.revision);
          return { ok: true, revision: saved.revision, org: getOrg() };
        }
      };
    });
  }

  function archiveSession(cascadeId, { archived, stepCount = 0, isRunning = false, projectId = null, projectName = null, titleSnapshot = '' } = {}) {
    const cleanId = String(cascadeId || '').trim();
    if (!cleanId) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }
    if (typeof archived !== 'boolean') {
      return { ok: false, statusCode: 400, error: 'INVALID_ARCHIVE_FLAG' };
    }

    return mutateOrgAtomically((org) => {
      if (org.deletedSessions[cleanId]) {
        return { abort: true, result: { ok: false, statusCode: 404, error: 'SESSION_NOT_FOUND' } };
      }

      let unpinned = false;
      if (archived) {
        const wasPinned = org.pins.sessions.includes(cleanId);
        if (wasPinned) {
          unpinned = true;
          org.pins.sessions = org.pins.sessions.filter((id) => id !== cleanId);
          delete org.pinTimestamps.sessions[cleanId];
          if (Array.isArray(org.sessionOrder.__pinned__)) {
            org.sessionOrder.__pinned__ = removeFromOrderArray(org.sessionOrder.__pinned__, cleanId);
          }
          for (const [ck, ord] of Object.entries(org.sessionOrder)) {
            if (ck === '__pinned__' || !isPlainObject(ord)) continue;
            ord.pinned = removeFromOrderArray(ord.pinned, cleanId);
          }
        }
        const prevArch = org.archivedSessions[cleanId];
        org.archivedSessions[cleanId] = {
          archivedAt: prevArch?.archivedAt || new Date().toISOString(),
          archivedAtStepCount: Number.isFinite(Number(stepCount)) ? Math.max(0, Math.floor(Number(stepCount))) : (prevArch?.archivedAtStepCount ?? 0),
          archivedWasRunning: Boolean(isRunning),
          projectId: projectId || prevArch?.projectId || null,
          projectName: projectName || prevArch?.projectName || null,
          titleSnapshot: typeof titleSnapshot === 'string' && titleSnapshot ? titleSnapshot : (prevArch?.titleSnapshot || '')
        };
      } else {
        delete org.archivedSessions[cleanId];
      }

      return {
        buildResult: (saved) => ({
          ok: true,
          cascadeId: cleanId,
          archived,
          unpinned,
          revision: saved.revision,
          archivedCount: Object.keys(saved.archivedSessions || {}).length
        })
      };
    });
  }

  function deleteSessionOrgRecord(cascadeId, { mode = 'host_deleted' } = {}) {
    const cleanId = String(cascadeId || '').trim();
    if (!cleanId) {
      return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
    }
    return mutateOrgAtomically((org) => {
      org.pins.sessions = org.pins.sessions.filter((id) => id !== cleanId);
      delete org.pinTimestamps.sessions[cleanId];
      delete org.archivedSessions[cleanId];
      delete org.sessionGroupMap[cleanId];
      delete org.sessionProjectOverrides[cleanId];
      if (Array.isArray(org.sessionOrder.__pinned__)) {
        org.sessionOrder.__pinned__ = removeFromOrderArray(org.sessionOrder.__pinned__, cleanId);
      }
      for (const [ck, ord] of Object.entries(org.sessionOrder)) {
        if (ck === '__pinned__' || !isPlainObject(ord)) continue;
        ord.pinned = removeFromOrderArray(ord.pinned, cleanId);
        ord.normal = removeFromOrderArray(ord.normal, cleanId);
      }
      if (mode === 'local_tombstone') {
        org.deletedSessions[cleanId] = {
          deletedAt: new Date().toISOString(),
          mode: 'local_tombstone'
        };
      }
      return {
        buildResult: (saved) => ({
          ok: true,
          cascadeId: cleanId,
          deletionMode: mode,
          hostCleaned: mode === 'host_deleted',
          revision: saved.revision,
          archivedCount: Object.keys(saved.archivedSessions || {}).length
        })
      };
    });
  }

  return {
    orgPath,
    dbPath,
    loadPersistedOrg,
    mutateOrgAtomically,
    materializeProjectInOrg,
    syncFromExternalSignal,
    startWatching,
    dispose,
    enrichSessionsAndOrg,
    getOrg,
    togglePin,
    mutateGroup,
    reorderOrg,
    archiveSession,
    deleteSessionOrgRecord,
    reconcileSessionsLifecycle
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
  createSessionOrgStore,
  createEmptyPersistedOrg,
  sanitizePersistedOrg,
  buildOrgBusSummary,
  normalizeLocalPath,
  canonicalKey,
  makeStableProjectId
};
