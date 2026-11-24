import type {
  BackendModelGroup,
  CompactModelBadge,
  ModelOption,
  ModelPickerGroup,
  ModelPickerMasterGroup,
  ModelPickerVariant,
  ModelPreferences,
  NormalizedModel,
  OrchestratorMasterKey,
  OrchestratorThinkingMap,
  OrchestratorThinkingTier,
  TelemetryPanels,
  ThinkingTier
} from '../types';

export const CANONICAL_ORCHESTRATOR_MASTERS: ReadonlyArray<{
  key: OrchestratorMasterKey;
  name: string;
  provider: ModelPickerGroup['provider'];
}> = [
  { key: 'carbon', name: 'Carbon', provider: 'gemini' },
  { key: 'argon', name: 'Argon', provider: 'gemini' },
  { key: 'neon', name: 'Neon', provider: 'gemini' },
  { key: 'opus5.5', name: 'Opus 5.5', provider: 'claude' }
];

export const ORCHESTRATOR_THINKING_TIERS: readonly OrchestratorThinkingTier[] = [
  'low',
  'medium',
  'high',
  'xhigh'
];

export const DEFAULT_ORCHESTRATOR_THINKING: OrchestratorThinkingMap = {
  carbon: 'high',
  argon: 'high',
  neon: 'high',
  'opus5.5': 'high'
};

export function matchOrchestratorMasterKey(raw: string | null | undefined): OrchestratorMasterKey | null {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('carbon') || s.includes('m670')) return 'carbon';
  if (s.includes('argon') || s.includes('m668')) return 'argon';
  if (s.includes('neon')) return 'neon';
  if (s.includes('opus5.5') || s.includes('opus 5.5') || s.includes('opus-5.5') || s.includes('opus')) {
    return 'opus5.5';
  }
  return null;
}

export function sanitizeOrchestratorThinkingMap(
  raw?: Partial<Record<string, string>> | null
): OrchestratorThinkingMap {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (v: unknown): OrchestratorThinkingTier => {
    const s = String(v || '').trim().toLowerCase();
    return ORCHESTRATOR_THINKING_TIERS.includes(s as OrchestratorThinkingTier)
      ? (s as OrchestratorThinkingTier)
      : 'high';
  };
  return {
    carbon: pick(src.carbon),
    argon: pick(src.argon),
    neon: pick(src.neon),
    'opus5.5': pick(src['opus5.5'] ?? src.opus)
  };
}

const PLACEHOLDER_RE = /^MODEL_PLACEHOLDER_/i;

interface TierMeta {
  key: string;
  label: string;
  shortTag: string;
  order: number;
}

const TIER_CATALOG: Record<string, TierMeta> = {
  standard: { key: 'standard', label: '标准', shortTag: '标准', order: 0 },
  minimal: { key: 'minimal', label: 'Minimal', shortTag: 'Min', order: 1 },
  low: { key: 'low', label: 'Low', shortTag: 'Low', order: 2 },
  medium: { key: 'medium', label: 'Medium', shortTag: 'Med', order: 3 },
  high: { key: 'high', label: 'High', shortTag: 'High', order: 4 },
  xhigh: { key: 'xhigh', label: 'XHigh', shortTag: 'XHigh', order: 5 },
  max: { key: 'max', label: 'Max', shortTag: 'Max', order: 6 },
  thinking: { key: 'thinking', label: 'Thinking', shortTag: 'Think', order: 4.5 }
};

function canonicalizeTierKey(raw: string | null | undefined): string | null {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'min' || s === 'minimal') return 'minimal';
  if (s === 'low' || s === 'fast') return 'low';
  if (s === 'med' || s === 'medium' || s === 'balanced') return 'medium';
  if (s === 'high') return 'high';
  if (s === 'xhigh' || s === 'x-high' || s === 'extra high' || s === 'extra-high' || s === 'very high') {
    return 'xhigh';
  }
  if (s === 'max' || s === 'ultra') return 'max';
  if (s === 'thinking' || s === 'think' || s === 'deep' || s === 'reason' || s === 'reasoning') {
    return 'thinking';
  }
  return null;
}

function getTierMeta(tierKey: string | null | undefined, customLabel?: string | null): TierMeta {
  const key = canonicalizeTierKey(tierKey);
  if (key && TIER_CATALOG[key]) {
    const base = TIER_CATALOG[key];
    return customLabel ? { ...base, label: customLabel } : base;
  }
  if (customLabel && customLabel.trim()) {
    const clean = customLabel.trim();
    return { key: clean.toLowerCase(), label: clean, shortTag: clean, order: 50 };
  }
  return TIER_CATALOG.standard;
}

function detectProvider(label: string, id: string, isOrchestrator: boolean): ModelPickerGroup['provider'] {
  if (isOrchestrator) return 'orchestrator';
  const hay = `${label} ${id}`.toLowerCase();
  if (hay.includes('claude') || hay.includes('opus') || hay.includes('sonnet') || hay.includes('haiku')) {
    return 'claude';
  }
  if (hay.includes('gemini') || hay.includes('neon') || hay.includes('flash') || hay.includes('pro')) {
    return 'gemini';
  }
  if (hay.includes('gpt') || hay.includes('openai') || /\bo[134]\b/.test(hay)) {
    return 'openai';
  }
  return 'other';
}

function titleCaseToken(raw: string): string {
  const clean = raw.trim();
  if (!clean) return '';
  if (/[A-Z]/.test(clean) && /[a-z]/.test(clean)) return clean;
  return clean
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function stripOrchestratorToken(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:antigravity\s+|auto\s+)?(?:orchestrator|编排模型|编排)\s*[:\-·–—/]?\s*/i, '')
    .replace(/\s*[:\-·–—/]?\s*(?:orchestrator|编排模型|编排)$/i, '')
    .trim();
}

function parseOrchestratorInfo(
  id: string,
  label: string,
  explicitIsOrch?: boolean,
  explicitVariant?: string | null,
  explicitMaster?: string | null,
  explicitThinking?: ThinkingTier | null
): {
  isOrchestrator: boolean;
  master: string | null;
  thinkingLevel: string | null;
  variant: string | null;
} {
  const looksLikeOrch =
    explicitIsOrch === true ||
    Boolean(explicitVariant && String(explicitVariant).trim()) ||
    Boolean(explicitMaster && String(explicitMaster).trim()) ||
    /orchestrator|编排/i.test(label) ||
    /orchestrator/i.test(id);

  if (!looksLikeOrch) {
    return { isOrchestrator: false, master: null, thinkingLevel: null, variant: null };
  }

  let thinkingLevel = canonicalizeTierKey(explicitThinking);
  let body = label.trim();

  // Unwrap outer "Orchestrator (...)" / "编排模型 (...)" so nested "(High)" or "Carbon - High" is preserved
  const outerParen = body.match(/^(?:antigravity\s+|auto\s+)?(?:orchestrator|编排模型|编排)\s*\((.+)\)\s*$/i);
  if (outerParen && outerParen[1].trim()) {
    body = outerParen[1].trim();
  }

  const strippedTier = stripThinkingSuffixFromName(body);
  if (strippedTier.tier && !thinkingLevel) {
    thinkingLevel = strippedTier.tier;
  }

  let masterCandidate = stripOrchestratorToken(strippedTier.base);
  if (masterCandidate.startsWith('(') && masterCandidate.endsWith(')')) {
    masterCandidate = masterCandidate.slice(1, -1).trim();
  }

  // Handle cases like "Orchestrator (High)" / "Orchestrator (Fast)" where body itself is only a tier word
  const bareTier = canonicalizeTierKey(masterCandidate);
  if (bareTier) {
    if (!thinkingLevel) thinkingLevel = bareTier;
    masterCandidate = '';
  } else if (/^(standard|auto|default|默认|标准|默认主控)$/i.test(masterCandidate)) {
    masterCandidate = '';
  }

  // Fallback: extract master from explicitMaster, or id like gemini-pro-orchestrator-argon
  let master = explicitMaster && String(explicitMaster).trim() ? String(explicitMaster).trim() : masterCandidate;
  if (!master) {
    const idMatch = id.match(/orchestrator[-_/:]+([a-z0-9._-]+)$/i);
    if (idMatch && idMatch[1].trim()) {
      const idTok = idMatch[1].trim();
      const idTier = canonicalizeTierKey(idTok);
      if (idTier) {
        if (!thinkingLevel) thinkingLevel = idTier;
      } else {
        master = titleCaseToken(idTok);
      }
    }
  }

  if (!master && explicitVariant && String(explicitVariant).trim()) {
    const expVar = String(explicitVariant).trim();
    const expParsed = stripThinkingSuffixFromName(expVar);
    if (expParsed.tier && !thinkingLevel) thinkingLevel = expParsed.tier;
    const expClean = stripOrchestratorToken(expParsed.base);
    if (expClean && !canonicalizeTierKey(expClean) && !/^(standard|auto|default|默认|标准|默认主控)$/i.test(expClean)) {
      master = expClean;
    }
  }

  const resolvedMaster = master || '默认主控';
  const tierMeta = thinkingLevel ? getTierMeta(thinkingLevel) : null;
  const variant =
    explicitVariant && String(explicitVariant).trim()
      ? String(explicitVariant).trim()
      : master
        ? (tierMeta ? `${master} · ${tierMeta.label}` : master)
        : (tierMeta ? tierMeta.label : '标准');

  return {
    isOrchestrator: true,
    master: resolvedMaster,
    thinkingLevel,
    variant
  };
}

function stripThinkingSuffixFromName(raw: string): { base: string; tier: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { base: '', tier: null };

  // 1) Parenthesized suffix, e.g. "(High)", "(XHigh)", "(Thinking)", "(Thinking · High)", "(High Thinking)"
  const parenMatch = trimmed.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    const base = parenMatch[1].trim();
    const inside = parenMatch[2].trim();
    const directTier = canonicalizeTierKey(inside);
    if (directTier) {
      return { base: base || trimmed, tier: directTier };
    }
    const tokens = inside
      .split(/[\s,·/|+-]+/)
      .map((t) => canonicalizeTierKey(t))
      .filter((t): t is string => Boolean(t));
    if (tokens.length > 0) {
      const specific = tokens.find((t) => t !== 'thinking') || tokens[0];
      return { base: base || trimmed, tier: specific };
    }
  }

  // 2) Trailing dash/slash tier token, e.g. "Gemini 3.8 Flash - High"
  const dashMatch = trimmed.match(/^(.*?)\s*[-·/]\s*(minimal|low|medium|high|x-?high|extra\s+high|max|thinking)\s*$/i);
  if (dashMatch && dashMatch[1].trim()) {
    const tier = canonicalizeTierKey(dashMatch[2]);
    if (tier) return { base: dashMatch[1].trim(), tier };
  }

  // 3) Trailing space tier word, e.g. "GPT-OSS 120B Medium"
  const trailingWordMatch = trimmed.match(/^(.*\S)\s+(minimal|low|medium|high|x-?high|max|thinking)$/i);
  if (trailingWordMatch && trailingWordMatch[1].trim()) {
    const tier = canonicalizeTierKey(trailingWordMatch[2]);
    if (tier) return { base: trailingWordMatch[1].trim(), tier };
  }

  return { base: trimmed, tier: null };
}

function parseFamilyAndThinking(
  label: string,
  explicitFamily?: string | null,
  explicitThinking?: ThinkingTier | null
): { family: string; thinkingLevel: ThinkingTier | null } {
  const fromLabel = stripThinkingSuffixFromName(label);
  const fromExplicitFamily = explicitFamily && explicitFamily.trim()
    ? stripThinkingSuffixFromName(explicitFamily)
    : null;
  const explicitTier = canonicalizeTierKey(explicitThinking);

  const family = (fromExplicitFamily && fromExplicitFamily.base) || fromLabel.base || label.trim();
  const thinkingLevel = explicitTier || fromLabel.tier || fromExplicitFamily?.tier || null;

  return { family, thinkingLevel };
}

function extractRawHumanLabel(item: ModelOption | string): string {
  if (typeof item === 'string') return item.trim();
  const candidates = [item.displayName, item.label, item.name, item.shortName];
  for (const cand of candidates) {
    if (typeof cand === 'string') {
      const s = cand.trim();
      if (s && !PLACEHOLDER_RE.test(s)) {
        return s;
      }
    }
  }
  return '';
}

function pickPreferredDisplayLabel(item: ModelOption | string): string {
  if (typeof item === 'string') return item.trim();
  // Prefer shortName ONLY when displayName/label/name aren't richer, or match legacy expectations:
  // If displayName or label is provided and non-placeholder, use it so thinking tiers "(High)" are never lost.
  const ordered = [item.displayName, item.label, item.name, item.shortName];
  for (const cand of ordered) {
    if (typeof cand === 'string') {
      const s = cand.trim();
      if (s && !PLACEHOLDER_RE.test(s)) {
        return s;
      }
    }
  }
  return '';
}

/**
 * Full model normalization preserving ALL real Antigravity models (including MODEL_PLACEHOLDER_*
 * IDs when they have valid human labels/displayNames) and preserving distinct thinking tiers &
 * orchestrator variants.
 */
export function normalizeModelCatalog(
  rawModels: Array<ModelOption | string> | null | undefined,
  backendGroups?: BackendModelGroup[] | null
): NormalizedModel[] {
  if (!Array.isArray(rawModels)) return [];

  // Index optional backend group metadata by modelId for enrichment
  const groupHintById = new Map<
    string,
    {
      groupLabel?: string;
      isOrchestrator?: boolean;
      thinkingLevel?: ThinkingTier | null;
      orchestratorVariant?: string | null;
      orchestratorMaster?: string | null;
      tagTitle?: string | null;
    }
  >();

  if (Array.isArray(backendGroups)) {
    for (const grp of backendGroups) {
      if (!grp || typeof grp !== 'object') continue;
      const isOrch = Boolean(grp.isOrchestrator || grp.kind === 'orchestrator');
      const grpLabel = String(grp.label || grp.name || '').trim() || undefined;
      if (Array.isArray(grp.variants)) {
        for (const v of grp.variants) {
          if (!v || !v.modelId) continue;
          groupHintById.set(v.modelId, {
            groupLabel: grpLabel,
            isOrchestrator: isOrch,
            thinkingLevel: v.thinkingLevel ?? null,
            orchestratorVariant: v.orchestratorVariant ?? null,
            orchestratorMaster: v.orchestratorMaster ?? null,
            tagTitle: v.tagTitle ?? null
          });
        }
      }
      if (Array.isArray(grp.modelIds)) {
        for (const mid of grp.modelIds) {
          if (!mid || groupHintById.has(mid)) continue;
          groupHintById.set(mid, {
            groupLabel: grpLabel,
            isOrchestrator: isOrch
          });
        }
      }
    }
  }

  const byId = new Map<string, NormalizedModel>();

  for (const item of rawModels) {
    if (!item) continue;
    const rawId = typeof item === 'string' ? item : item.id || item.model || '';
    const id = typeof rawId === 'string' ? rawId.trim() : '';
    if (!id) continue;

    const humanLabel = pickPreferredDisplayLabel(item);
    const idIsPlaceholder = PLACEHOLDER_RE.test(id);

    // Drop ONLY if label/displayName is missing/placeholder (or string entry itself is placeholder)
    if (!humanLabel || PLACEHOLDER_RE.test(humanLabel)) continue;
    if (idIsPlaceholder && !extractRawHumanLabel(item)) continue;

    if (byId.has(id)) continue;

    const opt: ModelOption = typeof item === 'string' ? { id } : item;
    const hint = groupHintById.get(id);

    const orch = parseOrchestratorInfo(
      id,
      humanLabel,
      opt.isOrchestrator ?? hint?.isOrchestrator,
      opt.orchestratorVariant ?? hint?.orchestratorVariant,
      opt.orchestratorMaster ?? hint?.orchestratorMaster,
      opt.thinkingLevel ?? hint?.thinkingLevel
    );

    const parsed = orch.isOrchestrator
      ? { family: '编排模型', thinkingLevel: orch.thinkingLevel }
      : parseFamilyAndThinking(
          humanLabel,
          opt.family || (hint?.groupLabel && !orch.isOrchestrator ? hint.groupLabel : undefined),
          opt.thinkingLevel ?? hint?.thinkingLevel
        );

    const thinkingMeta = parsed.thinkingLevel ? getTierMeta(parsed.thinkingLevel, opt.thinkingLabel) : null;

    byId.set(id, {
      ...opt,
      id,
      model: opt.model || id,
      label: humanLabel,
      displayName: (typeof opt.displayName === 'string' && opt.displayName.trim() && !PLACEHOLDER_RE.test(opt.displayName))
        ? opt.displayName.trim()
        : humanLabel,
      family: parsed.family,
      thinkingLevel: parsed.thinkingLevel,
      thinkingLabel: thinkingMeta ? thinkingMeta.label : (opt.thinkingLabel || null),
      isOrchestrator: orch.isOrchestrator,
      orchestratorVariant: orch.variant,
      orchestratorMaster: orch.master,
      tagTitle: opt.tagTitle ?? hint?.tagTitle ?? null,
      disabled: Boolean(opt.disabled)
    });
  }

  // Deduplicate ONLY exact duplicates that share identical (label, thinkingLevel, orchestratorVariant, orchestratorMaster).
  // Distinct thinking levels or orchestrator variants are NEVER merged/dropped.
  const seenSignature = new Map<string, NormalizedModel>();
  const result: NormalizedModel[] = [];

  for (const model of byId.values()) {
    const sig = [
      model.label.trim().toLowerCase(),
      model.thinkingLevel || '',
      model.isOrchestrator ? 'orch' : 'std',
      (model.orchestratorVariant || '').trim().toLowerCase(),
      (model.orchestratorMaster || '').trim().toLowerCase()
    ].join('|');

    const existing = seenSignature.get(sig);
    if (!existing) {
      seenSignature.set(sig, model);
      result.push(model);
      continue;
    }

    const scoreNew = (model.isDefault ? 2 : 0) + (!model.disabled ? 1 : 0);
    const scoreOld = (existing.isDefault ? 2 : 0) + (!existing.disabled ? 1 : 0);
    if (scoreNew > scoreOld) {
      const idx = result.indexOf(existing);
      if (idx >= 0) result[idx] = model;
      seenSignature.set(sig, model);
    }
  }

  return result;
}

/**
 * Backward-compatible minimal model list helper (`{ id, label }`).
 */
export function normalizeModels(
  rawModels: Array<ModelOption | string> | null | undefined
): Array<{ id: string; label: string }> {
  return normalizeModelCatalog(rawModels).map((m) => ({
    id: m.id,
    label: m.label
  }));
}

const PROVIDER_SORT_ORDER: Record<ModelPickerGroup['provider'], number> = {
  gemini: 0,
  claude: 1,
  openai: 2,
  orchestrator: 3,
  other: 4
};

export function applyModelPreferences(
  groups: ModelPickerGroup[],
  preferences?: Partial<ModelPreferences> | null
): ModelPickerGroup[] {
  if (!Array.isArray(groups) || groups.length === 0) return [];
  if (!preferences || typeof preferences !== 'object') return groups;

  const filterOrder = Array.isArray(preferences.filterOrder) ? preferences.filterOrder : [];
  const hiddenIds = new Set<string>();
  const customRank = new Map<string, number>();

  for (const rawEntry of filterOrder) {
    const s = String(rawEntry || '').trim();
    if (!s) continue;
    if (s.startsWith('!')) {
      const hid = s.slice(1).trim();
      if (hid) hiddenIds.add(hid.toLowerCase());
    } else if (!customRank.has(s.toLowerCase())) {
      customRank.set(s.toLowerCase(), customRank.size);
    }
  }

  let visible = groups.filter((g) => !hiddenIds.has(g.id.toLowerCase()));
  if (visible.length === 0) visible = [...groups];

  const sortMode = preferences.sortMode || 'custom';
  const usageCounts = preferences.usageCounts && typeof preferences.usageCounts === 'object'
    ? preferences.usageCounts
    : {};

  const getFreq = (g: ModelPickerGroup): number => {
    let total = Number(usageCounts[g.id] || 0);
    for (const v of g.variants) {
      total += Number(usageCounts[v.id] || 0);
    }
    return total;
  };

  if (sortMode === 'name_asc') {
    return [...visible].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }
  if (sortMode === 'name_desc') {
    return [...visible].sort((a, b) => b.name.localeCompare(a.name, 'zh-CN'));
  }
  if (sortMode === 'provider') {
    return [...visible].sort((a, b) => {
      const pa = PROVIDER_SORT_ORDER[a.provider] ?? 99;
      const pb = PROVIDER_SORT_ORDER[b.provider] ?? 99;
      if (pa !== pb) return pa - pb;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }
  if (sortMode === 'frequency') {
    return [...visible].sort((a, b) => {
      const diff = getFreq(b) - getFreq(a);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name, 'zh-CN');
    });
  }

  if (customRank.size > 0) {
    return visible
      .map((g, idx) => ({
        g,
        idx,
        rank: customRank.has(g.id.toLowerCase()) ? customRank.get(g.id.toLowerCase())! : 1e6 + idx
      }))
      .sort((a, b) => a.rank - b.rank)
      .map((x) => x.g);
  }

  return visible;
}

/**
 * Aggregates normalized models into a multi-level picker structure:
 * - Orchestrator models -> ONE "编排模型" group strictly containing the 4 canonical masters
 *   (carbon, argon, neon, opus5.5), each with independent thinking tiers (low/medium/high/xhigh)
 * - Models sharing a family with thinking tiers -> ONE family row with right-slide tier selector
 * - Standalone models -> single selectable row
 */
export function groupModelsForPicker(
  rawModels: Array<ModelOption | string> | null | undefined,
  backendGroups?: BackendModelGroup[] | null,
  preferences?: Partial<ModelPreferences> | null
): ModelPickerGroup[] {
  const models = normalizeModelCatalog(rawModels, backendGroups);
  if (models.length === 0) return [];

  const orchestratorModels: NormalizedModel[] = [];
  const familyBuckets = new Map<string, { name: string; models: NormalizedModel[] }>();
  const familyOrder: string[] = [];

  for (const m of models) {
    if (m.isOrchestrator) {
      orchestratorModels.push(m);
      continue;
    }
    const key = m.family.trim().toLowerCase();
    let bucket = familyBuckets.get(key);
    if (!bucket) {
      bucket = { name: m.family.trim(), models: [] };
      familyBuckets.set(key, bucket);
      familyOrder.push(key);
    }
    bucket.models.push(m);
  }

  const groups: ModelPickerGroup[] = [];

  // Build non-orchestrator family/single groups preserving natural catalog order
  for (const key of familyOrder) {
    const bucket = familyBuckets.get(key)!;
    const hasMultiple = bucket.models.length > 1;
    const anyThinking = bucket.models.some((m) => Boolean(m.thinkingLevel));

    const variants: ModelPickerVariant[] = bucket.models
      .map((m, idx) => {
        const meta = getTierMeta(m.thinkingLevel, m.thinkingLabel);
        return {
          id: m.id,
          model: m,
          tierKey: m.thinkingLevel ? meta.key : `base_${idx}`,
          tierLabel: m.thinkingLevel ? meta.label : (hasMultiple ? '标准' : ''),
          shortTag: m.thinkingLevel ? meta.shortTag : (hasMultiple ? '标准' : ''),
          order: m.thinkingLevel ? meta.order : 0,
          disabled: m.disabled,
          tagTitle: m.tagTitle,
          quotaInfo: m.quotaInfo
        };
      })
      .sort((a, b) => a.order - b.order);

    const defaultVariant =
      variants.find((v) => v.model.isDefault && !v.disabled) ||
      variants.find((v) => v.tierKey === 'high' && !v.disabled) ||
      variants.find((v) => v.tierKey === 'medium' && !v.disabled) ||
      variants.find((v) => !v.disabled) ||
      variants[0];

    groups.push({
      id: `family:${key}`,
      kind: hasMultiple ? 'thinking_family' : 'single',
      name: bucket.name,
      provider: detectProvider(bucket.name, defaultVariant.id, false),
      isOrchestrator: false,
      hasThinkingTiers: anyThinking,
      hasSubLevels: hasMultiple,
      defaultModelId: defaultVariant.id,
      variants
    });
  }

  // Build ONE unified Orchestrator group strictly scoped to the 4 canonical masters:
  // carbon, argon, neon, opus5.5 — each with independent thinking tiers.
  if (orchestratorModels.length > 0) {
    const genericOrchModel =
      orchestratorModels.find((m) => m.isDefault && !m.disabled) ||
      orchestratorModels.find((m) => !m.disabled) ||
      orchestratorModels[0];

    const masterGroups: ModelPickerMasterGroup[] = CANONICAL_ORCHESTRATOR_MASTERS.map((masterDef) => {
      const orchMatches = orchestratorModels.filter(
        (m) => matchOrchestratorMasterKey(`${m.orchestratorMaster || ''} ${m.orchestratorVariant || ''} ${m.label} ${m.id}`) === masterDef.key
      );
      const familyMatches = models.filter(
        (m) => !m.isOrchestrator && matchOrchestratorMasterKey(`${m.family} ${m.label} ${m.id}`) === masterDef.key
      );

      const baseModelForMaster =
        orchMatches.find((m) => m.isDefault && !m.disabled) ||
        orchMatches.find((m) => m.thinkingLevel === 'high' && !m.disabled) ||
        orchMatches.find((m) => !m.disabled) ||
        orchMatches[0] ||
        familyMatches.find((m) => m.thinkingLevel === 'high' && !m.disabled) ||
        familyMatches.find((m) => !m.disabled) ||
        familyMatches[0] ||
        genericOrchModel;

      const tierVariants: ModelPickerVariant[] = ORCHESTRATOR_THINKING_TIERS.map((tierKey) => {
        const meta = getTierMeta(tierKey);
        const exactOrch = orchMatches.find((m) => m.thinkingLevel === tierKey && !m.disabled)
          || orchMatches.find((m) => m.thinkingLevel === tierKey);
        const exactFamily = familyMatches.find((m) => m.thinkingLevel === tierKey && !m.disabled)
          || familyMatches.find((m) => m.thinkingLevel === tierKey);
        const matched = exactOrch || exactFamily || baseModelForMaster;

        return {
          id: matched.id,
          model: matched,
          tierKey,
          tierLabel: meta.label,
          shortTag: meta.shortTag,
          order: meta.order,
          disabled: Boolean(matched.disabled),
          tagTitle: exactOrch?.tagTitle || exactFamily?.tagTitle || null,
          quotaInfo: exactOrch?.quotaInfo || exactFamily?.quotaInfo || matched.quotaInfo || null,
          orchestratorMasterKey: masterDef.key,
          resolvedThinkingLevel: tierKey
        };
      });

      const defaultVar =
        tierVariants.find((v) => v.tierKey === 'high' && !v.disabled) ||
        tierVariants.find((v) => !v.disabled) ||
        tierVariants[0];

      return {
        id: `master:${masterDef.key}`,
        masterKey: masterDef.key,
        name: masterDef.name,
        provider: masterDef.provider,
        defaultModelId: defaultVar.id,
        variants: tierVariants
      };
    });

    const flatVariants: ModelPickerVariant[] = orchestratorModels.length > 0
      ? orchestratorModels.map((m, idx) => {
          const variantLabel = (m.orchestratorVariant || m.orchestratorMaster || '标准').trim();
          return {
            id: m.id,
            model: m,
            tierKey: variantLabel.toLowerCase(),
            tierLabel: variantLabel,
            shortTag: variantLabel,
            order: idx,
            disabled: m.disabled,
            tagTitle: m.tagTitle,
            quotaInfo: m.quotaInfo
          };
        })
      : masterGroups.map((mg, idx) => ({
          id: mg.defaultModelId,
          model: mg.variants[0].model,
          tierKey: mg.masterKey || mg.id,
          tierLabel: mg.name,
          shortTag: mg.name,
          order: idx,
          disabled: false
        }));

    const defaultVariant =
      flatVariants.find((v) => v.model.isDefault && !v.disabled) ||
      flatVariants.find((v) => !v.disabled) ||
      flatVariants[0];

    groups.push({
      id: 'orchestrator',
      kind: 'orchestrator',
      name: '编排模型',
      subtitle: 'Orchestrator · Carbon / Argon / Neon / Opus 5.5',
      provider: 'orchestrator',
      isOrchestrator: true,
      hasThinkingTiers: true,
      hasSubLevels: true,
      defaultModelId: defaultVariant.id,
      variants: flatVariants,
      masterGroups
    });
  }

  return applyModelPreferences(groups, preferences);
}

/**
 * Resolves the unified full model name from telemetry + catalog + selectedModelId.
 * Handles MODEL_PLACEHOLDER_* IDs in telemetry by mapping them through the catalog first.
 */
export function resolveUnifiedModelName(
  telemetry: TelemetryPanels,
  models: Array<ModelOption | string> | null | undefined,
  selectedModelId: string,
  backendGroups?: BackendModelGroup[] | null
): string {
  const catalog = normalizeModelCatalog(models, backendGroups);
  const ctxModelRaw = telemetry?.context?.available ? telemetry.context.data?.model : '';
  const ctxModel = typeof ctxModelRaw === 'string' ? ctxModelRaw.trim() : '';

  if (ctxModel && ctxModel.toLowerCase() !== 'unknown') {
    const matched = catalog.find(
      (m) => m.id === ctxModel || m.model === ctxModel || m.label === ctxModel || m.displayName === ctxModel
    );
    if (matched) return matched.label;
    if (!PLACEHOLDER_RE.test(ctxModel)) return ctxModel;
  }

  const selected = catalog.find((m) => m.id === selectedModelId || m.model === selectedModelId);
  if (selected) return selected.label;
  return catalog[0]?.label || '';
}

function shortenFamilyName(family: string): string {
  const clean = family.trim();
  if (!clean) return '';
  // Compact mobile-friendly display while preserving clear identity:
  // "Gemini 4 Neon" -> "Gemini 4 Neon" (or short "4 Neon")
  // "Claude Opus 5.5" -> "Opus 5.5"
  // "Claude Sonnet 4.6" -> "Sonnet 4.6"
  // "Gemini 3.8 Flash" -> "3.8 Flash"
  const claudeMatch = clean.match(/^Claude\s+(.+)$/i);
  if (claudeMatch) return claudeMatch[1].trim();
  const geminiMatch = clean.match(/^Gemini\s+(.+)$/i);
  if (geminiMatch) return geminiMatch[1].trim();
  return clean;
}

/**
 * Formats any model ID / ModelOption / unified label into a consistent compact badge
 * for TopBar and Composer triggers.
 */
export function formatCompactModelBadge(
  input: string | ModelOption | NormalizedModel | null | undefined,
  models?: Array<ModelOption | string> | null,
  backendGroups?: BackendModelGroup[] | null,
  orchestratorSelection?: {
    master: OrchestratorMasterKey | null;
    thinkingMap?: Partial<OrchestratorThinkingMap> | null;
  } | null
): CompactModelBadge {
  const catalog = models ? normalizeModelCatalog(models, backendGroups) : [];
  let resolved: NormalizedModel | null = null;

  if (input && typeof input === 'object') {
    const found = catalog.find((m) => m.id === input.id);
    resolved = found || normalizeModelCatalog([input], backendGroups)[0] || null;
  } else if (typeof input === 'string' && input.trim()) {
    const key = input.trim();
    resolved =
      catalog.find((m) => m.id === key || m.model === key || m.label === key || m.displayName === key) ||
      null;
    if (!resolved && !PLACEHOLDER_RE.test(key)) {
      resolved = normalizeModelCatalog([{ id: key, label: key }])[0] || null;
    }
  }

  if (orchestratorSelection?.master) {
    const masterDef = CANONICAL_ORCHESTRATOR_MASTERS.find((m) => m.key === orchestratorSelection.master);
    const masterName = masterDef?.name || orchestratorSelection.master;
    const tier = orchestratorSelection.thinkingMap?.[orchestratorSelection.master] || resolved?.thinkingLevel || 'high';
    const tierMeta = getTierMeta(tier);
    const tag = `${masterName} · ${tierMeta.shortTag}`;
    return {
      name: '编排模型',
      shortName: '编排',
      tag,
      full: `编排 · ${tag}`,
      isOrchestrator: true,
      thinkingLevel: tier,
      orchestratorVariant: masterName
    };
  }

  if (!resolved) {
    return {
      name: '选择模型',
      shortName: '模型',
      tag: '',
      full: '选择模型',
      isOrchestrator: false,
      thinkingLevel: null,
      orchestratorVariant: null
    };
  }

  if (resolved.isOrchestrator) {
    const tierMeta = resolved.thinkingLevel ? getTierMeta(resolved.thinkingLevel, resolved.thinkingLabel) : null;
    const rawMaster =
      resolved.orchestratorMaster && resolved.orchestratorMaster !== '默认主控'
        ? resolved.orchestratorMaster.trim()
        : '';
    const fallbackVariant = (resolved.orchestratorVariant || '标准').trim();
    const tag = rawMaster
      ? (tierMeta ? `${rawMaster} · ${tierMeta.shortTag}` : rawMaster)
      : (tierMeta ? tierMeta.label : fallbackVariant);
    return {
      name: '编排模型',
      shortName: '编排',
      tag,
      full: `编排 · ${tag}`,
      isOrchestrator: true,
      thinkingLevel: resolved.thinkingLevel,
      orchestratorVariant: resolved.orchestratorVariant || rawMaster || fallbackVariant
    };
  }

  const tierMeta = resolved.thinkingLevel ? getTierMeta(resolved.thinkingLevel, resolved.thinkingLabel) : null;
  const tag = tierMeta ? tierMeta.label : '';
  const name = resolved.family || resolved.label;
  const shortName = shortenFamilyName(name);
  const full = tag ? `${name} · ${tag}` : name;

  return {
    name,
    shortName,
    tag,
    full,
    isOrchestrator: false,
    thinkingLevel: resolved.thinkingLevel,
    orchestratorVariant: null
  };
}
