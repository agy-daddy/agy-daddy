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

function isTestMode() {
  return process.env.AGY_DADDY_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function normalizeUriToPath(uriOrPath) {
  const s = String(uriOrPath || '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(s).pathname).replace(/\/+$/, '') || '/';
    } catch {
      return s.slice(7).replace(/\/+$/, '') || '/';
    }
  }
  return s.replace(/\/+$/, '') || '/';
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
  if (INTERNAL_TEMP_WORKSPACE_RE.test(p)) return true;
  const base = extractWorkspaceDisplayName(p);
  return INTERNAL_TEMP_DIRNAME_RE.test(base);
}

function extractWorkspaceDisplayName(uriOrPath) {
  const p = normalizeUriToPath(uriOrPath);
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
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

  let thinkingLevel = typeof item.thinkingLevel === 'string' && item.thinkingLevel.trim()
    ? item.thinkingLevel.trim().toLowerCase()
    : null;
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

function buildModelGroups(models = [], rawHostGroups = []) {
  if (!Array.isArray(models) || models.length === 0) return [];

  // Map modelId -> host group index/name if host provided groupedModels or agentModelSorts
  const hostOrderMap = new Map();
  let orderCounter = 0;
  for (const g of (Array.isArray(rawHostGroups) ? rawHostGroups : [])) {
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
    groups.push({
      id: 'orchestrator',
      label: 'Orchestrator',
      kind: 'orchestrator',
      isOrchestrator: true,
      hasThinkingTiers: sorted.some((m) => Boolean(m.thinkingLevel)),
      defaultModelId: defaultItem.id,
      modelIds: sorted.map((m) => m.id),
      variants: sorted.map((m) => ({
        modelId: m.id,
        label: m.orchestratorVariant || m.thinkingLabel || m.label,
        thinkingLevel: m.thinkingLevel || null,
        orchestratorVariant: m.orchestratorVariant || null,
        orchestratorMaster: m.orchestratorMaster || null,
        tagTitle: m.tagTitle || null,
        disabled: Boolean(m.disabled)
      }))
    });
  }

  const orderedBuckets = Array.from(familyBuckets.values()).sort((a, b) => {
    if (a.firstOrder !== b.firstOrder) return a.firstOrder - b.firstOrder;
    return 0;
  });

  for (const bucket of orderedBuckets) {
    const sorted = sortVariants(bucket.models);
    const defaultItem = sorted.find((m) => m.isDefault) || sorted.find((m) => !m.disabled) || sorted[0];
    const hasTiers = sorted.length > 1 || sorted.some((m) => Boolean(m.thinkingLevel));
    groups.push({
      id: bucket.id,
      label: bucket.label,
      kind: sorted.length > 1 ? 'thinking_family' : 'single',
      isOrchestrator: false,
      hasThinkingTiers: hasTiers,
      defaultModelId: defaultItem.id,
      modelIds: sorted.map((m) => m.id),
      variants: sorted.map((m) => ({
        modelId: m.id,
        label: m.thinkingLabel || (sorted.length > 1 ? 'Standard' : m.label),
        thinkingLevel: m.thinkingLevel || null,
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
function sanitizeModelCatalogResult({ models = [], defaultModelId = '', rawGroups = [] } = {}) {
  const rawDefault = typeof defaultModelId === 'string' ? defaultModelId.trim() : '';
  const byId = new Map();

  for (const item of (Array.isArray(models) ? models : [])) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (!id || PLACEHOLDER_MODEL_RE.test(id)) continue;
      if (!byId.has(id)) {
        const meta = parseModelMetadata({ id, label: id, displayName: id });
        byId.set(id, {
          id,
          model: id,
          label: id,
          name: id,
          displayName: id,
          disabled: false,
          quotaInfo: null,
          maxTokens: null,
          supportsImages: false,
          ...meta
        });
      }
      continue;
    }
    if (!isPlainObject(item)) continue;
    const id = String(item.id || item.model || item.modelId || item.modelOrAlias?.model || '').trim();
    if (!id) continue;
    const label = String(item.label || item.shortName || item.displayName || item.name || '').trim();
    const displayName = String(item.displayName || item.name || item.label || item.shortName || '').trim();
    if (!label && !displayName) continue;
    if (PLACEHOLDER_MODEL_RE.test(label) || PLACEHOLDER_MODEL_RE.test(displayName)) continue;
    if (PLACEHOLDER_MODEL_RE.test(id) && (!label || PLACEHOLDER_MODEL_RE.test(label))) continue;

    const existing = byId.get(id);
    const mergedRaw = existing ? { ...existing, ...item, id, label: label || existing.label, displayName: displayName || existing.displayName } : { ...item, id, label, displayName };
    const meta = parseModelMetadata(mergedRaw);
    byId.set(id, {
      ...mergedRaw,
      id,
      model: id,
      label: mergedRaw.label || mergedRaw.displayName,
      name: mergedRaw.displayName || mergedRaw.label,
      displayName: mergedRaw.displayName || mergedRaw.label,
      shortName: meta.shortName,
      family: meta.family,
      thinkingLevel: meta.thinkingLevel,
      thinkingLabel: meta.thinkingLabel,
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
  for (const g of modelGroups) {
    for (const mid of g.modelIds) groupIdByModel.set(mid, g.id);
  }
  for (const m of enrichedModels) {
    m.groupId = groupIdByModel.get(m.id) || null;
  }

  return {
    models: enrichedModels,
    defaultModelId: resolvedDefault,
    modelGroups
  };
}

function createEmptyPersistedOrg() {
  return {
    version: 1,
    groups: [],
    pins: {
      sessions: [],
      projects: [],
      groups: []
    },
    projectGroupMap: {},
    sessionGroupMap: {},
    updatedAt: null
  };
}

function sanitizePersistedOrg(raw) {
  const base = createEmptyPersistedOrg();
  if (!isPlainObject(raw)) return base;

  const dedupeStrings = (arr) => Array.from(new Set(
    (Array.isArray(arr) ? arr : [])
      .map((s) => String(s || '').trim())
      .filter(Boolean)
  ));

  base.pins = {
    sessions: dedupeStrings(raw.pins?.sessions),
    projects: dedupeStrings(raw.pins?.projects),
    groups: dedupeStrings(raw.pins?.groups)
  };

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
          order: Number.isFinite(Number(g.order)) ? Number(g.order) : idx,
          projectIds: dedupeStrings(g.projectIds),
          workspaceUris: dedupeStrings(g.workspaceUris),
          sessionIds: dedupeStrings(g.sessionIds)
        };
      })
      .filter(Boolean);
  }

  if (isPlainObject(raw.projectGroupMap)) {
    for (const [k, v] of Object.entries(raw.projectGroupMap)) {
      const ck = String(k || '').trim();
      const cv = String(v || '').trim();
      if (ck && cv) base.projectGroupMap[ck] = cv;
    }
  }

  if (isPlainObject(raw.sessionGroupMap)) {
    for (const [k, v] of Object.entries(raw.sessionGroupMap)) {
      const ck = String(k || '').trim();
      const cv = String(v || '').trim();
      if (ck && cv) base.sessionGroupMap[ck] = cv;
    }
  }

  base.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  return base;
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
  const explicitOrgPath = options.orgPath || process.env.AGY_DADDY_SESSION_ORG_PATH || '';
  const orgPath = explicitOrgPath
    ? path.resolve(explicitOrgPath)
    : (isTestMode() ? null : path.join(os.homedir(), '.agy-daddy', 'session-org.json'));

  const explicitDbPath = options.dbPath !== undefined
    ? options.dbPath
    : (process.env.AGY_DADDY_CONVERSATION_DB_PATH || undefined);
  const dbPath = explicitDbPath !== undefined
    ? (explicitDbPath ? path.resolve(explicitDbPath) : null)
    : (isTestMode() ? null : path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db'));

  const getAllowedRoots = typeof options.getAllowedRoots === 'function' ? options.getAllowedRoots : () => [];

  let memoryOrg = createEmptyPersistedOrg();
  let dbCache = { loadedAt: 0, rows: [] };

  function loadPersistedOrg() {
    if (!orgPath) {
      return sanitizePersistedOrg(memoryOrg);
    }
    try {
      if (!fs.existsSync(orgPath)) return createEmptyPersistedOrg();
      const raw = JSON.parse(fs.readFileSync(orgPath, 'utf8'));
      return sanitizePersistedOrg(raw);
    } catch {
      return createEmptyPersistedOrg();
    }
  }

  function savePersistedOrg(nextOrg) {
    const clean = sanitizePersistedOrg({
      ...nextOrg,
      updatedAt: new Date().toISOString()
    });
    if (!orgPath) {
      memoryOrg = clean;
      return clean;
    }
    const dir = path.dirname(orgPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${orgPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
    fs.renameSync(tmp, orgPath);
    return clean;
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
    limit = DEFAULT_SESSION_LIMIT
  } = {}) {
    const persisted = loadPersistedOrg();
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

    // Map group membership from persisted groups
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

    // Build project registry keyed by canonical projectId (or canonical workspace path)
    const projectsById = new Map();
    const projectIdByPath = new Map();

    function registerProject({ id, uri, fsPath, name, branchName = null, lastModifiedTime = null, groupId = null }) {
      if (isTempBridgeWorkspace(fsPath || uri) || isTempBridgeWorkspace(name)) return null;
      const normPath = normalizeUriToPath(fsPath || uri);
      const normUri = uri && String(uri).startsWith('file://') ? String(uri).trim() : (normPath ? pathToFileUri(normPath) : null);
      let resolvedId = !isGenericDbProjectId(id) ? String(id).trim() : '';

      if (!resolvedId && normPath) {
        resolvedId = projectIdByPath.get(normPath) || deriveProjectIdFromWorkspace(normPath);
      }
      if (!resolvedId) return null;

      // Unify same path under existing DB project_id if already registered
      if (normPath && projectIdByPath.has(normPath)) {
        const existingId = projectIdByPath.get(normPath);
        if (existingId && projectsById.has(existingId)) {
          resolvedId = existingId;
        }
      } else if (normPath) {
        projectIdByPath.set(normPath, resolvedId);
      }

      const existing = projectsById.get(resolvedId);
      const resolvedGroupId = groupByProject.get(resolvedId)
        || (normPath ? groupByWorkspace.get(normPath) : null)
        || groupId
        || existing?.groupId
        || null;

      if (!existing) {
        projectsById.set(resolvedId, {
          id: resolvedId,
          name: String(name || extractWorkspaceDisplayName(normPath || normUri) || resolvedId),
          uri: normUri,
          path: normPath || null,
          groupId: resolvedGroupId,
          pinned: pinnedProjects.has(resolvedId),
          branchName: branchName || null,
          sessionCount: 0,
          lastModifiedTime: lastModifiedTime || null
        });
      } else {
        if (!existing.uri && normUri) existing.uri = normUri;
        if (!existing.path && normPath) existing.path = normPath;
        if (!existing.branchName && branchName) existing.branchName = branchName;
        if (!existing.groupId && resolvedGroupId) existing.groupId = resolvedGroupId;
        if (lastModifiedTime && (!existing.lastModifiedTime || Date.parse(lastModifiedTime) > Date.parse(existing.lastModifiedTime))) {
          existing.lastModifiedTime = lastModifiedTime;
        }
      }
      return projectsById.get(resolvedId);
    }

    // 1. Seed projects from DB rows (for accurate project_id <-> workspace path mapping)
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
      if (!cid) continue;
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

      const proj = ((primaryWsUri && !isTempBridgeWorkspace(primaryWsUri)) || !isGenericDbProjectId(dbProjectId))
        ? registerProject({
            id: dbProjectId,
            uri: primaryWsUri,
            name: s.repoName || extractWorkspaceDisplayName(primaryWsUri),
            branchName: s.branchName || null,
            lastModifiedTime: s.lastModifiedTime || s.createdTime || dbRow?.last_modified_time || null,
            groupId: dbGroupId || null
          })
        : null;

      const projectId = proj?.id || (!isGenericDbProjectId(dbProjectId) ? dbProjectId : null);
      const projectName = proj?.name || s.repoName || extractWorkspaceDisplayName(primaryWsUri) || null;
      const parentConversationId = String(dbRow?.parent_conversation_id || s.parentConversationId || '').trim() || null;
      const nestingDepth = Number.isFinite(Number(dbRow?.nesting_depth))
        ? Number(dbRow.nesting_depth)
        : (Number.isFinite(Number(s.nestingDepth)) ? Number(s.nestingDepth) : 0);
      const agentName = String(dbRow?.agent_name || s.agentName || '').trim() || null;
      const isSubagent = Boolean(s.isSubagent || parentConversationId || nestingDepth > 0);

      const groupId = groupBySession.get(cid)
        || (projectId ? groupByProject.get(projectId) : null)
        || (normWsPath ? groupByWorkspace.get(normWsPath) : null)
        || (dbGroupId || null)
        || (proj?.groupId || null);

      const pinned = pinnedSessions.has(cid);
      const enriched = {
        ...s,
        cascadeId: cid,
        workspaceUri: primaryWsUri,
        groupId: groupId || null,
        projectId: projectId || null,
        projectName,
        pinned,
        parentConversationId,
        nestingDepth,
        agentName,
        isSubagent
      };
      enrichedAll.push(enriched);

      if (proj && (!isSubagent || includeSubagents)) {
        proj.sessionCount += 1;
      }
    }

    // Filter subagents unless explicitly requested
    const visibleSessions = includeSubagents
      ? enrichedAll
      : enrichedAll.filter((s) => !s.isSubagent);

    // Sort: pinned first, then lastModifiedTime desc
    visibleSessions.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
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
          pinned: pinnedGroups.has(hgid),
          order: hostOrder++,
          projectIds: [],
          workspaceUris: [],
          sessionIds: []
        });
      }
    }

    // Populate group membership arrays from resolved projects & sessions
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

    const projects = Array.from(projectsById.values()).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const tb = Date.parse(b.lastModifiedTime || '') || 0;
      const ta = Date.parse(a.lastModifiedTime || '') || 0;
      if (tb !== ta) return tb - ta;
      return a.name.localeCompare(b.name);
    });

    const groups = Array.from(groupsById.values()).sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.order !== b.order) return a.order - b.order;
      return a.name.localeCompare(b.name);
    });

    return {
      sessions: boundedSessions,
      totalVisibleSessions: visibleSessions.length,
      groups,
      projects,
      pins: {
        sessions: [...persisted.pins.sessions],
        projects: [...persisted.pins.projects],
        groups: [...persisted.pins.groups]
      }
    };
  }

  function getOrg(opts = {}) {
    const res = enrichSessionsAndOrg({ ...opts, limit: MAX_SESSION_LIMIT });
    return {
      ok: true,
      groups: res.groups,
      projects: res.projects,
      pins: res.pins
    };
  }

  function togglePin({ type, id, pinned } = {}) {
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
    const org = loadPersistedOrg();
    const list = org.pins[bucketKey] || [];
    const exists = list.includes(cleanId);
    const nextPinned = typeof pinned === 'boolean' ? pinned : !exists;
    if (nextPinned && !exists) {
      list.push(cleanId);
    } else if (!nextPinned && exists) {
      org.pins[bucketKey] = list.filter((x) => x !== cleanId);
    } else {
      org.pins[bucketKey] = list;
    }
    const saved = savePersistedOrg(org);
    const singular = bucketKey.slice(0, -1);
    return {
      ok: true,
      type: singular,
      id: cleanId,
      pinned: nextPinned,
      pins: saved.pins
    };
  }

  function mutateGroup(body = {}) {
    if (!isPlainObject(body)) {
      return { ok: false, statusCode: 400, error: 'INVALID_GROUP_BODY' };
    }
    const action = String(body.action || 'upsert').trim().toLowerCase();
    const org = loadPersistedOrg();

    if (action === 'delete') {
      const id = String(body.id || '').trim();
      if (!id) return { ok: false, statusCode: 400, error: 'MISSING_GROUP_ID' };
      org.groups = org.groups.filter((g) => g.id !== id);
      org.pins.groups = org.pins.groups.filter((gid) => gid !== id);
      for (const [k, v] of Object.entries(org.projectGroupMap)) {
        if (v === id) delete org.projectGroupMap[k];
      }
      for (const [k, v] of Object.entries(org.sessionGroupMap)) {
        if (v === id) delete org.sessionGroupMap[k];
      }
      const saved = savePersistedOrg(org);
      return { ok: true, action: 'delete', id, groups: saved.groups, pins: saved.pins };
    }

    if (action === 'assign') {
      const groupId = body.groupId ? String(body.groupId).trim() : null;
      const projectId = body.projectId ? String(body.projectId).trim() : '';
      const sessionId = body.sessionId ? String(body.sessionId).trim() : '';
      const workspaceUri = body.workspaceUri ? String(body.workspaceUri).trim() : '';
      if (!projectId && !sessionId && !workspaceUri) {
        return { ok: false, statusCode: 400, error: 'MISSING_ASSIGN_TARGET' };
      }
      if (projectId) {
        if (groupId) org.projectGroupMap[projectId] = groupId;
        else delete org.projectGroupMap[projectId];
        for (const g of org.groups) {
          g.projectIds = g.projectIds.filter((p) => p !== projectId);
          if (groupId && g.id === groupId) g.projectIds.push(projectId);
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
      const saved = savePersistedOrg(org);
      return { ok: true, action: 'assign', groupId, groups: saved.groups, pins: saved.pins };
    }

    // Default: upsert group
    const name = String(body.name || '').trim();
    const id = String(body.id || '').trim() || `grp_${crypto.randomBytes(4).toString('hex')}`;
    if (!name && !org.groups.some((g) => g.id === id)) {
      return { ok: false, statusCode: 400, error: 'MISSING_GROUP_NAME' };
    }
    const existingIdx = org.groups.findIndex((g) => g.id === id);
    const prev = existingIdx >= 0 ? org.groups[existingIdx] : null;
    const nextGroup = {
      id,
      name: name || prev?.name || id,
      source: prev?.source || 'user',
      order: Number.isFinite(Number(body.order)) ? Number(body.order) : (prev ? prev.order : org.groups.length),
      projectIds: Array.isArray(body.projectIds) ? body.projectIds.map((x) => String(x || '').trim()).filter(Boolean) : (prev?.projectIds || []),
      workspaceUris: Array.isArray(body.workspaceUris) ? body.workspaceUris.map((x) => String(x || '').trim()).filter(Boolean) : (prev?.workspaceUris || []),
      sessionIds: Array.isArray(body.sessionIds) ? body.sessionIds.map((x) => String(x || '').trim()).filter(Boolean) : (prev?.sessionIds || [])
    };
    if (existingIdx >= 0) {
      org.groups[existingIdx] = nextGroup;
    } else {
      org.groups.push(nextGroup);
    }
    for (const pid of nextGroup.projectIds) org.projectGroupMap[pid] = id;
    for (const sid of nextGroup.sessionIds) org.sessionGroupMap[sid] = id;
    const saved = savePersistedOrg(org);
    return { ok: true, action: 'upsert', group: nextGroup, groups: saved.groups, pins: saved.pins };
  }

  return {
    orgPath,
    dbPath,
    enrichSessionsAndOrg,
    getOrg,
    togglePin,
    mutateGroup
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
  createSessionOrgStore
};
