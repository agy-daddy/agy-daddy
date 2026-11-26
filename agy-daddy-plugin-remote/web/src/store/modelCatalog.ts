import type {
  BackendModelGroup,
  CompactModelBadge,
  ModelCatalogTree,
  ModelOption,
  ModelPickerGroup,
  ModelPickerMasterGroup,
  ModelPickerVariant,
  ModelPreferences,
  ModelTreeLeafNode,
  ModelTreeNode,
  NormalizedModel,
  OrchestratorMasterKey,
  OrchestratorThinkingMap,
  OrchestratorThinkingTier,
  TelemetryPanels,
  ThinkingTier
} from '../types';

const ORCHESTRATOR_MASTER_META: Record<
  OrchestratorMasterKey,
  { name: string; provider: ModelPickerGroup['provider'] }
> = {
  carbon: { name: 'Carbon', provider: 'gemini' },
  argon: { name: 'Argon', provider: 'gemini' },
  neon: { name: 'Neon', provider: 'gemini' },
  'opus5.5': { name: 'Opus 5.5', provider: 'claude' }
};

export const DEFAULT_ORCHESTRATOR_THINKING: OrchestratorThinkingMap = {
  carbon: 'high',
  argon: 'high',
  neon: 'high',
  'opus5.5': 'high'
};

const THINKING_NUM_TO_LEVEL: Record<number, string> = {
  1: 'low',
  2: 'medium',
  3: 'high',
  100: 'xhigh'
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
  thinking: { key: 'thinking', label: 'Thinking', shortTag: 'Think', order: 4.5 },
  xhigh: { key: 'xhigh', label: 'XHigh', shortTag: 'XHigh', order: 5 },
  max: { key: 'max', label: 'Max', shortTag: 'Max', order: 6 }
};

export function canonicalizeTierKey(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return THINKING_NUM_TO_LEVEL[raw] || null;
  }
  const str = String(raw).trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) {
    return THINKING_NUM_TO_LEVEL[Number(str)] || null;
  }
  const s = str.toLowerCase().replace(/^thinking_level_/, '').replace(/\s+/g, ' ');
  if (s === 'none' || s === 'no thinking' || s === 'standard') return null;
  if (s === 'min' || s === 'minimal') return 'minimal';
  if (s === 'low' || s === 'fast') return 'low';
  if (s === 'med' || s === 'medium' || s === 'balanced') return 'medium';
  if (s === 'high') return 'high';
  if (
    s === 'xhigh' ||
    s === 'x-high' ||
    s === 'extra high' ||
    s === 'extra-high' ||
    s === 'extra_high' ||
    s === 'very high'
  ) {
    return 'xhigh';
  }
  if (s === 'max' || s === 'ultra') return 'max';
  if (
    s === 'thinking' ||
    s === 'think' ||
    s === 'deep' ||
    s === 'reason' ||
    s === 'reasoning' ||
    s === 'extended thinking'
  ) {
    return 'thinking';
  }
  return null;
}

function normalizeSupportedLevels(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const val =
      item && typeof item === 'object'
        ? (item as Record<string, unknown>).thinkingSuffix ??
          (item as Record<string, unknown>).thinkingLevel ??
          (item as Record<string, unknown>).level ??
          (item as Record<string, unknown>).id
        : item;
    const key = canonicalizeTierKey(val as string | number | null | undefined);
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

export function sanitizeOrchestratorThinkingMap(
  raw?: Partial<Record<string, string>> | null
): OrchestratorThinkingMap {
  const src = raw && typeof raw === 'object' ? raw : {};
  const pick = (v: unknown): OrchestratorThinkingTier => {
    const key = canonicalizeTierKey(typeof v === 'string' || typeof v === 'number' ? v : null);
    return key || 'high';
  };
  return {
    carbon: pick(src.carbon),
    argon: pick(src.argon),
    neon: pick(src.neon),
    'opus5.5': pick(src['opus5.5'] ?? src.opus)
  };
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

function sortTierKeys(tiers: string[]): string[] {
  return [...tiers].sort((a, b) => {
    const oa = TIER_CATALOG[a]?.order ?? 50;
    const ob = TIER_CATALOG[b]?.order ?? 50;
    if (oa !== ob) return oa - ob;
    return 0;
  });
}

function detectProvider(label: string, id: string, isOrchestrator: boolean): ModelPickerGroup['provider'] {
  if (isOrchestrator) return 'orchestrator';
  const hay = `${label} ${id}`.toLowerCase();
  if (hay.includes('claude') || hay.includes('opus') || hay.includes('sonnet') || hay.includes('haiku')) {
    return 'claude';
  }
  if (hay.includes('gemini') || hay.includes('neon') || hay.includes('carbon') || hay.includes('argon') || hay.includes('flash') || hay.includes('pro')) {
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

function slugifyKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stripOrchestratorToken(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:antigravity\s+|auto\s+)?(?:orchestrator|编排模型|编排)\s*[:\-·–—/]?\s*/i, '')
    .replace(/\s*[:\-·–—/]?\s*(?:orchestrator|编排模型|编排)$/i, '')
    .trim();
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

function parseOrchestratorInfo(
  id: string,
  label: string,
  explicitIsOrch?: boolean,
  explicitVariant?: string | null,
  explicitMaster?: string | null,
  explicitThinking?: ThinkingTier | number | null
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

  const bareTier = canonicalizeTierKey(masterCandidate);
  if (bareTier) {
    if (!thinkingLevel) thinkingLevel = bareTier;
    masterCandidate = '';
  } else if (/^(standard|auto|default|默认|标准|默认主控)$/i.test(masterCandidate)) {
    masterCandidate = '';
  }

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

function parseFamilyAndThinking(
  label: string,
  explicitFamily?: string | null,
  explicitThinking?: ThinkingTier | number | null
): { family: string; thinkingLevel: ThinkingTier | null } {
  const fromLabel = stripThinkingSuffixFromName(label);
  const fromExplicitFamily =
    explicitFamily && explicitFamily.trim() ? stripThinkingSuffixFromName(explicitFamily) : null;
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

interface IndexedTreeLeaf {
  leaf: ModelTreeLeafNode;
  isOrch: boolean;
  supportedThinkingLevels: string[] | null;
  defaultThinkingSuffix: string | null;
  requestedModel: string;
  stableModelId: string;
  plannerFamilyId: string;
}

interface IndexedTreeFamily {
  familyName: string;
  supportedThinkingLevels: string[] | null;
  leaves: IndexedTreeLeaf[];
}

interface IndexedModelTree {
  leafByRequestedId: Map<string, IndexedTreeLeaf>;
  leafByStableId: Map<string, IndexedTreeLeaf>;
  orchLeaves: IndexedTreeLeaf[];
  orchByMasterKey: Map<string, IndexedTreeLeaf>;
  familyBySlug: Map<string, IndexedTreeFamily>;
}

function indexModelTree(modelTree?: ModelCatalogTree | null): IndexedModelTree {
  const leafByRequestedId = new Map<string, IndexedTreeLeaf>();
  const leafByStableId = new Map<string, IndexedTreeLeaf>();
  const orchLeaves: IndexedTreeLeaf[] = [];
  const orchByMasterKey = new Map<string, IndexedTreeLeaf>();
  const familyBySlug = new Map<string, IndexedTreeFamily>();

  if (!modelTree || !Array.isArray(modelTree.nodes)) {
    return { leafByRequestedId, leafByStableId, orchLeaves, orchByMasterKey, familyBySlug };
  }

  const registerLeaf = (leaf: ModelTreeLeafNode, inOrchBranch: boolean, parentFamilyName?: string) => {
    const sel = leaf.selection && typeof leaf.selection === 'object' ? leaf.selection : {};
    const requestedModel = typeof sel.requestedModel === 'string' ? sel.requestedModel.trim() : '';
    const stableModelId = typeof sel.modelId === 'string' ? sel.modelId.trim() : '';
    const plannerFamilyId = typeof sel.plannerFamilyId === 'string' ? sel.plannerFamilyId.trim() : '';
    const isOrch =
      inOrchBranch ||
      sel.mode === 'orchestrator_preset' ||
      leaf.role === 'planner_model' ||
      leaf.key.startsWith('orch/');

    const entry: IndexedTreeLeaf = {
      leaf,
      isOrch,
      supportedThinkingLevels: normalizeSupportedLevels(leaf.supportedThinkingLevels),
      defaultThinkingSuffix: canonicalizeTierKey(leaf.defaultThinkingSuffix ?? leaf.thinkingLevel ?? sel.plannerThinkingSuffix),
      requestedModel,
      stableModelId,
      plannerFamilyId
    };

    if (requestedModel) leafByRequestedId.set(requestedModel, entry);
    if (stableModelId) leafByStableId.set(stableModelId.toLowerCase(), entry);

    if (isOrch) {
      orchLeaves.push(entry);
      const mk =
        matchOrchestratorMasterKey(`${plannerFamilyId} ${leaf.label} ${leaf.key} ${requestedModel}`) ||
        slugifyKey(plannerFamilyId || leaf.label || leaf.key);
      if (mk && !orchByMasterKey.has(mk)) {
        orchByMasterKey.set(mk, entry);
      }
    } else {
      const famName = parentFamilyName || stripThinkingSuffixFromName(leaf.label).base || leaf.label;
      const slug = slugifyKey(famName);
      if (slug) {
        let fam = familyBySlug.get(slug);
        if (!fam) {
          fam = {
            familyName: famName,
            supportedThinkingLevels: entry.supportedThinkingLevels,
            leaves: []
          };
          familyBySlug.set(slug, fam);
        } else if (fam.supportedThinkingLevels === null && entry.supportedThinkingLevels !== null) {
          fam.supportedThinkingLevels = entry.supportedThinkingLevels;
        }
        fam.leaves.push(entry);
      }
    }
  };

  const walk = (nodes: ModelTreeNode[], inOrchBranch: boolean, parentFamilyName?: string) => {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      if (node.kind === 'leaf') {
        registerLeaf(node, inOrchBranch, parentFamilyName);
      } else if (node.kind === 'branch' && Array.isArray(node.children)) {
        const nextOrch =
          inOrchBranch || node.key === 'orch' || node.role === 'orchestrator_root';
        const nextFamName =
          !nextOrch && (node.role === 'family' || node.key.startsWith('family/'))
            ? stripThinkingSuffixFromName(node.label).base || node.label
            : parentFamilyName;
        walk(node.children, nextOrch, nextFamName);
      }
    }
  };

  walk(modelTree.nodes, false);
  return { leafByRequestedId, leafByStableId, orchLeaves, orchByMasterKey, familyBySlug };
}

/**
 * Full model normalization preserving ALL real Antigravity models (including MODEL_PLACEHOLDER_*
 * IDs when they have valid human labels/displayNames) and preserving distinct thinking tiers &
 * orchestrator variants.
 */
export function normalizeModelCatalog(
  rawModels: Array<ModelOption | string> | null | undefined,
  backendGroups?: BackendModelGroup[] | null,
  modelTree?: ModelCatalogTree | null
): NormalizedModel[] {
  if (!Array.isArray(rawModels)) return [];

  const treeIdx = indexModelTree(modelTree);

  const groupHintById = new Map<
    string,
    {
      groupLabel?: string;
      isOrchestrator?: boolean;
      thinkingLevel?: ThinkingTier | null;
      supportedThinkingLevels?: string[] | null;
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
      const grpLevels = normalizeSupportedLevels(grp.supportedThinkingLevels);
      if (Array.isArray(grp.variants)) {
        for (const v of grp.variants) {
          if (!v || !v.modelId) continue;
          const vLevels = normalizeSupportedLevels(v.supportedThinkingLevels);
          groupHintById.set(v.modelId, {
            groupLabel: grpLabel,
            isOrchestrator: isOrch,
            thinkingLevel: v.thinkingLevel ?? null,
            supportedThinkingLevels: vLevels ?? grpLevels,
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
            isOrchestrator: isOrch,
            supportedThinkingLevels: grpLevels
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

    if (!humanLabel || PLACEHOLDER_RE.test(humanLabel)) continue;
    if (idIsPlaceholder && !extractRawHumanLabel(item)) continue;

    if (byId.has(id)) continue;

    const opt: ModelOption = typeof item === 'string' ? { id } : item;
    const hint = groupHintById.get(id);
    const stableIdLower = typeof opt.modelId === 'string' ? opt.modelId.trim().toLowerCase() : '';
    const treeLeaf =
      treeIdx.leafByRequestedId.get(id) ||
      (stableIdLower ? treeIdx.leafByStableId.get(stableIdLower) : undefined);

    const orch = parseOrchestratorInfo(
      id,
      humanLabel,
      opt.isOrchestrator ?? hint?.isOrchestrator,
      opt.orchestratorVariant ?? hint?.orchestratorVariant,
      opt.orchestratorMaster ?? hint?.orchestratorMaster,
      opt.thinkingLevel ?? hint?.thinkingLevel
    );

    const parsed = orch.isOrchestrator
      ? {
          family: '编排模型',
          thinkingLevel: orch.thinkingLevel || treeLeaf?.defaultThinkingSuffix || null
        }
      : parseFamilyAndThinking(
          humanLabel,
          opt.family || (hint?.groupLabel && !orch.isOrchestrator ? hint.groupLabel : undefined),
          opt.thinkingLevel ?? hint?.thinkingLevel
        );

    const supportedThinkingLevels =
      normalizeSupportedLevels(opt.supportedThinkingLevels) ??
      treeLeaf?.supportedThinkingLevels ??
      hint?.supportedThinkingLevels ??
      null;

    const thinkingMeta = parsed.thinkingLevel ? getTierMeta(parsed.thinkingLevel, opt.thinkingLabel) : null;

    byId.set(id, {
      ...opt,
      id,
      model: opt.model || id,
      label: humanLabel,
      displayName:
        typeof opt.displayName === 'string' && opt.displayName.trim() && !PLACEHOLDER_RE.test(opt.displayName)
          ? opt.displayName.trim()
          : humanLabel,
      family: parsed.family,
      thinkingLevel: parsed.thinkingLevel,
      thinkingLabel: thinkingMeta ? thinkingMeta.label : opt.thinkingLabel || null,
      supportedThinkingLevels,
      isOrchestrator: orch.isOrchestrator,
      orchestratorVariant: orch.variant,
      orchestratorMaster: orch.master,
      tagTitle: opt.tagTitle ?? hint?.tagTitle ?? null,
      disabled: Boolean(opt.disabled)
    });
  }

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
  const usageCounts =
    preferences.usageCounts && typeof preferences.usageCounts === 'object'
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

function resolveMasterDisplayName(
  masterKey: OrchestratorMasterKey | null,
  rawName: string | null | undefined,
  fallbackId: string
): string {
  if (masterKey && ORCHESTRATOR_MASTER_META[masterKey]) {
    return ORCHESTRATOR_MASTER_META[masterKey].name;
  }
  const clean = String(rawName || '').trim();
  if (clean) return clean;
  return titleCaseToken(fallbackId) || '默认主控';
}

function pickDefaultThinkingLevel(
  tiers: string[],
  preferred: string | null | undefined,
  variants: ModelPickerVariant[]
): string | null {
  if (tiers.length === 0) return null;
  const prefCanon = canonicalizeTierKey(preferred);
  if (prefCanon && tiers.includes(prefCanon)) {
    const match = variants.find((v) => v.resolvedThinkingLevel === prefCanon && !v.disabled);
    if (match) return prefCanon;
  }
  for (const fallback of ['high', 'medium']) {
    if (tiers.includes(fallback)) {
      const match = variants.find((v) => v.resolvedThinkingLevel === fallback && !v.disabled);
      if (match) return fallback;
    }
  }
  const firstEnabled = variants.find((v) => !v.disabled && v.resolvedThinkingLevel);
  if (firstEnabled?.resolvedThinkingLevel) return firstEnabled.resolvedThinkingLevel;
  return tiers[0] || null;
}

/**
 * Resolves a saved thinking tier for a master against its actually supported tiers,
 * smoothly falling back to the master's default/first available tier when unsupported.
 */
export function resolveMasterThinkingTier(
  master: ModelPickerMasterGroup | null | undefined,
  configuredTier?: string | null
): ThinkingTier | null {
  if (!master || master.variants.length === 0) return null;
  const availableTiers = master.variants
    .map((v) => v.resolvedThinkingLevel)
    .filter((t): t is string => Boolean(t));
  if (availableTiers.length === 0) return null;

  const normalized = canonicalizeTierKey(configuredTier);
  if (normalized) {
    const enabledExact = master.variants.find(
      (v) => v.resolvedThinkingLevel === normalized && !v.disabled
    );
    if (enabledExact) return normalized;
    if (availableTiers.includes(normalized)) return normalized;
  }

  if (master.defaultThinkingLevel && availableTiers.includes(master.defaultThinkingLevel)) {
    return master.defaultThinkingLevel;
  }

  const firstEnabled = master.variants.find((v) => !v.disabled && v.resolvedThinkingLevel);
  return firstEnabled?.resolvedThinkingLevel || availableTiers[0] || null;
}

/**
 * Reconciles a persisted OrchestratorThinkingMap against the actual supported tiers
 * of each master in the current model catalog.
 */
export function reconcileOrchestratorThinkingMap(
  currentMap: Partial<Record<string, string>> | null | undefined,
  groups: ModelPickerGroup[]
): OrchestratorThinkingMap {
  const sanitized = sanitizeOrchestratorThinkingMap(currentMap);
  const orchGroup = groups.find((g) => g.isOrchestrator);
  if (!orchGroup?.masterGroups || orchGroup.masterGroups.length === 0) {
    return sanitized;
  }

  const next: OrchestratorThinkingMap = { ...sanitized };
  for (const master of orchGroup.masterGroups) {
    const mKey = master.masterKey;
    if (!mKey) continue;
    const resolved = resolveMasterThinkingTier(master, next[mKey]);
    if (resolved) {
      next[mKey] = resolved;
    }
  }
  return next;
}

/**
 * Aggregates normalized models into a multi-level picker structure strictly reflecting
 * actual supported thinking levels from `modelTree`, `supportedThinkingLevels`, or
 * existing model variants — never padding fake tiers or non-existent masters.
 */
export function groupModelsForPicker(
  rawModels: Array<ModelOption | string> | null | undefined,
  backendGroups?: BackendModelGroup[] | null,
  preferences?: Partial<ModelPreferences> | null,
  modelTree?: ModelCatalogTree | null
): ModelPickerGroup[] {
  const models = normalizeModelCatalog(rawModels, backendGroups, modelTree);
  const treeIdx = indexModelTree(modelTree);
  if (models.length === 0 && treeIdx.orchLeaves.length === 0) return [];

  const backendGroupByFamilySlug = new Map<string, BackendModelGroup>();
  let backendOrchGroup: BackendModelGroup | null = null;
  if (Array.isArray(backendGroups)) {
    for (const grp of backendGroups) {
      if (!grp || typeof grp !== 'object') continue;
      if (grp.isOrchestrator || grp.kind === 'orchestrator') {
        backendOrchGroup = grp;
        continue;
      }
      const lbl = String(grp.label || grp.name || '').trim();
      if (lbl) backendGroupByFamilySlug.set(slugifyKey(lbl), grp);
      if (grp.id && grp.id.startsWith('family:')) {
        backendGroupByFamilySlug.set(slugifyKey(grp.id.slice('family:'.length)), grp);
      }
    }
  }

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
    const slug = slugifyKey(bucket.name);
    const treeFamily = treeIdx.familyBySlug.get(slug);
    const backendGrp = backendGroupByFamilySlug.get(slug);

    const bucketExplicitLevels = (() => {
      const withArray = bucket.models.filter((m) => Array.isArray(m.supportedThinkingLevels));
      if (withArray.length === 0) return null;
      const merged: string[] = [];
      const seen = new Set<string>();
      for (const m of withArray) {
        for (const lvl of m.supportedThinkingLevels || []) {
          const canon = canonicalizeTierKey(lvl);
          if (canon && !seen.has(canon)) {
            seen.add(canon);
            merged.push(canon);
          }
        }
      }
      return merged;
    })();

    const explicitLevels =
      treeFamily?.supportedThinkingLevels ??
      normalizeSupportedLevels(backendGrp?.supportedThinkingLevels) ??
      bucketExplicitLevels;

    let rawVariants: ModelPickerVariant[] = bucket.models.map((m, idx) => {
      const meta = getTierMeta(m.thinkingLevel, m.thinkingLabel);
      return {
        id: m.id,
        model: m,
        tierKey: m.thinkingLevel ? meta.key : `base_${idx}`,
        tierLabel: m.thinkingLevel ? meta.label : bucket.models.length > 1 ? '标准' : '',
        shortTag: m.thinkingLevel ? meta.shortTag : bucket.models.length > 1 ? '标准' : '',
        order: m.thinkingLevel ? meta.order : 0,
        disabled: m.disabled,
        tagTitle: m.tagTitle,
        quotaInfo: m.quotaInfo
      };
    });

    // If explicit supportedThinkingLevels are declared on tree/group, filter & order variants to match
    if (explicitLevels && explicitLevels.length > 0 && rawVariants.length > 1) {
      const allowedSet = new Set(explicitLevels);
      const filtered = rawVariants.filter((v) => allowedSet.has(v.tierKey));
      if (filtered.length > 0) {
        const idxMap = new Map(explicitLevels.map((lvl, i) => [lvl, i]));
        rawVariants = filtered.sort((a, b) => {
          const ia = idxMap.get(a.tierKey);
          const ib = idxMap.get(b.tierKey);
          if (ia !== undefined && ib !== undefined) return ia - ib;
          return a.order - b.order;
        });
      } else {
        rawVariants = rawVariants.sort((a, b) => a.order - b.order);
      }
    } else {
      rawVariants = rawVariants.sort((a, b) => a.order - b.order);
    }

    // Re-normalize single-variant tier labels if filtering reduced to 1 variant
    const hasMultiple = rawVariants.length > 1;
    const variants: ModelPickerVariant[] = rawVariants.map((v) => ({
      ...v,
      tierLabel: v.model.thinkingLevel ? v.tierLabel : hasMultiple ? '标准' : '',
      shortTag: v.model.thinkingLevel ? v.shortTag : hasMultiple ? '标准' : ''
    }));

    const anyThinking =
      variants.some((v) => Boolean(v.model.thinkingLevel)) ||
      Boolean(explicitLevels && explicitLevels.length > 0);

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

  // Build ONE unified Orchestrator group strictly from actual masters present in
  // modelTree / orchestratorModels / backendGroups (never hardcoding 4 masters or 4 tiers).
  if (orchestratorModels.length > 0 || treeIdx.orchLeaves.length > 0) {
    interface MasterBucket {
      bucketId: string;
      masterKey: OrchestratorMasterKey | null;
      name: string;
      provider: ModelPickerGroup['provider'];
      treeLeaf?: IndexedTreeLeaf;
      orchMatches: NormalizedModel[];
      backendLevels: string[] | null;
      backendExplicitEmpty: boolean;
    }

    const masterBucketMap = new Map<string, MasterBucket>();
    const masterBucketOrder: string[] = [];

    const ensureMasterBucket = (
      masterKey: OrchestratorMasterKey | null,
      rawName: string | null | undefined,
      fallbackId: string,
      treeLeaf?: IndexedTreeLeaf
    ): MasterBucket => {
      const bucketKey = masterKey || slugifyKey(rawName || fallbackId) || 'default';
      let bucket = masterBucketMap.get(bucketKey);
      if (!bucket) {
        const displayName = resolveMasterDisplayName(masterKey, rawName, fallbackId);
        const provider =
          masterKey && ORCHESTRATOR_MASTER_META[masterKey]
            ? ORCHESTRATOR_MASTER_META[masterKey].provider
            : detectProvider(displayName, fallbackId, false);
        bucket = {
          bucketId: `master:${bucketKey}`,
          masterKey,
          name: displayName,
          provider: provider === 'orchestrator' ? 'other' : provider,
          treeLeaf,
          orchMatches: [],
          backendLevels: null,
          backendExplicitEmpty: false
        };
        masterBucketMap.set(bucketKey, bucket);
        masterBucketOrder.push(bucketKey);
      } else if (!bucket.treeLeaf && treeLeaf) {
        bucket.treeLeaf = treeLeaf;
      }
      return bucket;
    };

    // 1) Seed from modelTree orch leaves in backend order
    for (const tLeaf of treeIdx.orchLeaves) {
      const hintStr = `${tLeaf.plannerFamilyId} ${tLeaf.leaf.label} ${tLeaf.leaf.key} ${tLeaf.requestedModel}`;
      const mKey = matchOrchestratorMasterKey(hintStr);
      const rawName = tLeaf.leaf.label || tLeaf.plannerFamilyId || tLeaf.leaf.key;
      ensureMasterBucket(mKey, rawName, tLeaf.plannerFamilyId || tLeaf.leaf.key, tLeaf);
    }

    // 2) Attach orchestratorModels into matching master buckets
    for (const m of orchestratorModels) {
      const hintStr = `${m.orchestratorMaster || ''} ${m.orchestratorVariant || ''} ${m.label} ${m.id}`;
      const mKey = matchOrchestratorMasterKey(hintStr);
      const cleanMaster =
        m.orchestratorMaster && m.orchestratorMaster !== '默认主控' ? m.orchestratorMaster : '';
      const bucket = ensureMasterBucket(mKey, cleanMaster, m.id);
      bucket.orchMatches.push(m);
    }

    // 3) Attach backendGroups orchestrator variant metadata (if any)
    if (backendOrchGroup && Array.isArray(backendOrchGroup.variants)) {
      for (const bv of backendOrchGroup.variants) {
        if (!bv) continue;
        const hintStr = `${bv.orchestratorMaster || ''} ${bv.orchestratorVariant || ''} ${bv.label || ''} ${bv.modelId}`;
        const mKey = matchOrchestratorMasterKey(hintStr);
        const bucketKey = mKey || slugifyKey(bv.orchestratorMaster || bv.modelId || 'default');
        const bucket = masterBucketMap.get(bucketKey);
        if (!bucket) continue;
        const bvLevels = normalizeSupportedLevels(bv.supportedThinkingLevels);
        if (bvLevels !== null) {
          if (bvLevels.length === 0) {
            bucket.backendExplicitEmpty = true;
          } else {
            const existing = new Set(bucket.backendLevels || []);
            const next = [...(bucket.backendLevels || [])];
            for (const lvl of bvLevels) {
              if (!existing.has(lvl)) {
                existing.add(lvl);
                next.push(lvl);
              }
            }
            bucket.backendLevels = next;
          }
        }
      }
    }

    const masterGroups: ModelPickerMasterGroup[] = masterBucketOrder.map((bKey) => {
      const bucket = masterBucketMap.get(bKey)!;
      const tLeaf = bucket.treeLeaf;

      const syntheticTreeModel: NormalizedModel | null = tLeaf
        ? {
            id: tLeaf.requestedModel || tLeaf.stableModelId || bucket.bucketId,
            model: tLeaf.requestedModel || tLeaf.stableModelId || bucket.bucketId,
            modelId: tLeaf.stableModelId || null,
            label: tLeaf.leaf.selectedDisplayLabel || `Orchestrator (${bucket.name})`,
            displayName: tLeaf.leaf.selectedDisplayLabel || `Orchestrator (${bucket.name})`,
            family: '编排模型',
            thinkingLevel: tLeaf.defaultThinkingSuffix || null,
            thinkingLabel: tLeaf.defaultThinkingSuffix
              ? getTierMeta(tLeaf.defaultThinkingSuffix).label
              : null,
            supportedThinkingLevels: tLeaf.supportedThinkingLevels,
            isOrchestrator: true,
            orchestratorVariant: bucket.name,
            orchestratorMaster: bucket.name,
            tagTitle: tLeaf.leaf.badge?.text || null,
            quotaInfo: tLeaf.leaf.quota || null,
            disabled: Boolean(tLeaf.leaf.disabled),
            isDefault: Boolean(tLeaf.leaf.isRecommended)
          }
        : null;

      const primaryModel =
        bucket.orchMatches.find((m) => m.isDefault && !m.disabled) ||
        bucket.orchMatches.find((m) => !m.disabled) ||
        bucket.orchMatches[0] ||
        syntheticTreeModel!;

      // Resolve actual supported thinking levels with strict priority:
      // 1) modelTree leaf.supportedThinkingLevels
      // 2) model/backendGroup supportedThinkingLevels
      // 3) derived solely from actual orchMatches variants
      let actualTiers: string[] = [];
      if (tLeaf && Array.isArray(tLeaf.supportedThinkingLevels)) {
        actualTiers = [...tLeaf.supportedThinkingLevels];
      } else {
        const modelExplicitLevels: string[] = [];
        const seenModelLevels = new Set<string>();
        let sawEmptyArray = false;
        for (const m of bucket.orchMatches) {
          if (Array.isArray(m.supportedThinkingLevels)) {
            if (m.supportedThinkingLevels.length === 0) {
              sawEmptyArray = true;
            } else {
              for (const lvl of m.supportedThinkingLevels) {
                const canon = canonicalizeTierKey(lvl);
                if (canon && !seenModelLevels.has(canon)) {
                  seenModelLevels.add(canon);
                  modelExplicitLevels.push(canon);
                }
              }
            }
          }
        }

        if (modelExplicitLevels.length > 0) {
          actualTiers = modelExplicitLevels;
        } else if (bucket.backendLevels && bucket.backendLevels.length > 0) {
          actualTiers = bucket.backendLevels;
        } else {
          // Derive only from actually existing orchestrator variants (never pad 4 fake tiers)
          const derived: string[] = [];
          const seenDerived = new Set<string>();
          for (const m of bucket.orchMatches) {
            const canon = canonicalizeTierKey(m.thinkingLevel);
            if (canon && !seenDerived.has(canon)) {
              seenDerived.add(canon);
              derived.push(canon);
            }
          }
          if (derived.length > 0) {
            actualTiers = derived;
          } else if (sawEmptyArray || bucket.backendExplicitEmpty) {
            actualTiers = [];
          } else {
            actualTiers = [];
          }
        }
      }

      const sortedTiers = sortTierKeys(actualTiers);

      const tierVariants: ModelPickerVariant[] =
        sortedTiers.length === 0
          ? [
              {
                id: primaryModel.id,
                model: primaryModel,
                tierKey: 'standard',
                tierLabel: '标准',
                shortTag: '标准',
                order: 0,
                disabled: Boolean(primaryModel.disabled),
                tagTitle: primaryModel.tagTitle ?? null,
                quotaInfo: primaryModel.quotaInfo ?? null,
                orchestratorMasterKey: bucket.masterKey
              }
            ]
          : sortedTiers.map((tierKey) => {
              const meta = getTierMeta(tierKey);
              const exactOrch =
                bucket.orchMatches.find((m) => m.thinkingLevel === tierKey && !m.disabled) ||
                bucket.orchMatches.find((m) => m.thinkingLevel === tierKey);
              const matched = exactOrch || primaryModel;
              return {
                id: matched.id,
                model: matched,
                tierKey,
                tierLabel: meta.label,
                shortTag: meta.shortTag,
                order: meta.order,
                disabled: Boolean(matched.disabled),
                tagTitle: exactOrch?.tagTitle ?? primaryModel.tagTitle ?? null,
                quotaInfo: exactOrch?.quotaInfo ?? primaryModel.quotaInfo ?? null,
                orchestratorMasterKey: bucket.masterKey,
                resolvedThinkingLevel: tierKey
              };
            });

      const defaultThinkingLevel = pickDefaultThinkingLevel(
        sortedTiers,
        tLeaf?.defaultThinkingSuffix ?? primaryModel.thinkingLevel,
        tierVariants
      );

      const defaultVar =
        (defaultThinkingLevel
          ? tierVariants.find((v) => v.resolvedThinkingLevel === defaultThinkingLevel && !v.disabled)
          : null) ||
        tierVariants.find((v) => !v.disabled) ||
        tierVariants[0];

      return {
        id: bucket.bucketId,
        masterKey: bucket.masterKey,
        name: bucket.name,
        provider: bucket.provider,
        defaultModelId: defaultVar.id,
        defaultThinkingLevel,
        supportedThinkingLevels: sortedTiers,
        hasSubLevels: tierVariants.length > 1,
        variants: tierVariants
      };
    });

    const flatVariants: ModelPickerVariant[] =
      orchestratorModels.length > 0
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
            disabled: mg.variants.every((v) => v.disabled)
          }));

    const defaultVariant =
      flatVariants.find((v) => v.model.isDefault && !v.disabled) ||
      flatVariants.find((v) => !v.disabled) ||
      flatVariants[0];

    groups.push({
      id: 'orchestrator',
      kind: 'orchestrator',
      name: '编排模型',
      subtitle:
        masterGroups.length > 0
          ? `Orchestrator · ${masterGroups.map((m) => m.name).join(' / ')}`
          : 'Orchestrator',
      provider: 'orchestrator',
      isOrchestrator: true,
      hasThinkingTiers: masterGroups.some((m) => (m.supportedThinkingLevels?.length || 0) > 0),
      hasSubLevels: masterGroups.length > 0,
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
  } | null,
  modelTree?: ModelCatalogTree | null
): CompactModelBadge {
  const catalog = models ? normalizeModelCatalog(models, backendGroups, modelTree) : [];
  let resolved: NormalizedModel | null = null;

  if (input && typeof input === 'object') {
    const found = catalog.find((m) => m.id === input.id);
    resolved = found || normalizeModelCatalog([input], backendGroups, modelTree)[0] || null;
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
    const masterKey = orchestratorSelection.master;
    const masterName = ORCHESTRATOR_MASTER_META[masterKey]?.name || masterKey;
    const configuredTier = orchestratorSelection.thinkingMap?.[masterKey] ?? resolved?.thinkingLevel ?? null;

    let masterGroup: ModelPickerMasterGroup | null = null;
    if ((models && models.length > 0) || modelTree) {
      const pickerGroups = groupModelsForPicker(models || [], backendGroups, undefined, modelTree);
      const orchGrp = pickerGroups.find((g) => g.isOrchestrator);
      masterGroup = orchGrp?.masterGroups?.find((m) => m.masterKey === masterKey) || null;
    }

    let finalTier: ThinkingTier | null = configuredTier || 'high';
    if (masterGroup) {
      finalTier = resolveMasterThinkingTier(masterGroup, configuredTier);
    }

    const tierMeta = finalTier ? getTierMeta(finalTier) : null;
    const tag = tierMeta ? `${masterName} · ${tierMeta.shortTag}` : masterName;
    return {
      name: '编排模型',
      shortName: '编排',
      tag,
      full: `编排 · ${tag}`,
      isOrchestrator: true,
      thinkingLevel: finalTier,
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
