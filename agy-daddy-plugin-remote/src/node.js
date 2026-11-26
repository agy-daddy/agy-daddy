'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const {
  DEFAULT_REMOTE_PORT,
  DEFAULT_CHANNELS,
  DEFAULT_REMOTE_DISPLAY_CONFIG,
  normalizePermissionLevel,
  isPermissionAtLeast,
  sanitizeRemoteDisplayConfig,
  normalizeChannelConfig,
  isTailscaleIp,
  isLanIp,
  parseTailscaleServeHttpsUrl,
  validateCloudflareTunnelToken,
  validateTunnelHostname,
  generatePairingToken
} = require('./tunnel-security');
const { generateQrSvg, generateQrAscii } = require('./qr-svg');
const { detectCloudflaredBinary, getCloudflaredInstallHints, CloudflaredManager } = require('./cloudflared');
const { MobileRemoteServer, stripPairingSecrets } = require('./pwa-server');
const { createWebPushManager } = require('./web-push');
const { createPtyManager } = require('./pty-bridge');
const { createTaskManager } = require('./task-manager');
const { createMobileWorkspaceService } = require('./mobile-workspace');
const {
  createWorkspaceBrowser,
  normalizeLocalPath,
  isForbiddenSystemRoot
} = require('./workspace-browser');
const { createRemoteProjectProvisioner } = require('./remote-project-provisioner');
const { createSseBroker } = require('./sse-broker');
const {
  DEFAULT_SESSION_LIMIT,
  isTempBridgeWorkspace,
  sanitizeModelCatalogResult,
  resolveWorkspaceOrg,
  createSessionOrgStore,
  canonicalKey,
  matchWorktreeByLongestPrefix
} = require('./session-org-store');

const CHANNEL_KEYS = ['loopback', 'lan', 'tailscale', 'bonjour', 'cloudflare'];
const PRIMARY_CHANNEL_ORDER = ['cloudflare', 'tailscale', 'lan', 'bonjour', 'loopback'];
const CHANNEL_DISPLAY_NAMES = Object.freeze({
  loopback: '本地',
  lan: '局域网',
  bonjour: '局域网',
  tailscale: 'Tailscale',
  cloudflare: 'Cloudflare',
  offline: '离线'
});
const DEFAULT_RPC_METADATA = Object.freeze({
  ideName: 'antigravity',
  extensionName: 'antigravity'
});
const TERMINAL_STEP_STATUSES = new Set(['done', 'error', 'canceled']);
const STEP_STATUS_MAP = Object.freeze({
  CORTEX_STEP_STATUS_DONE: 'done',
  CORTEX_STEP_STATUS_GENERATING: 'generating',
  CORTEX_STEP_STATUS_RUNNING: 'running',
  CORTEX_STEP_STATUS_PENDING: 'pending',
  CORTEX_STEP_STATUS_ERROR: 'error',
  CORTEX_STEP_STATUS_CANCELED: 'canceled',
  CORTEX_STEP_STATUS_CANCELLED: 'canceled',
  done: 'done',
  generating: 'generating',
  running: 'running',
  pending: 'pending',
  error: 'error',
  canceled: 'canceled',
  cancelled: 'canceled'
});
const STEP_KIND_MAP = Object.freeze({
  CORTEX_STEP_TYPE_USER_INPUT: { kind: 'user', field: 'userInput' },
  CORTEX_STEP_TYPE_PLANNER_RESPONSE: { kind: 'thinking_and_text', field: 'plannerResponse' },
  CORTEX_STEP_TYPE_RUN_COMMAND: { kind: 'command', field: 'runCommand' },
  CORTEX_STEP_TYPE_VIEW_FILE: { kind: 'file_view', field: 'viewFile' },
  CORTEX_STEP_TYPE_CODE_ACTION: { kind: 'code_action', field: 'codeAction' },
  CORTEX_STEP_TYPE_ASK_QUESTION: { kind: 'ask_question', field: 'askQuestion' },
  CORTEX_STEP_TYPE_SEARCH_WEB: { kind: 'web_search', field: 'searchWeb' },
  CORTEX_STEP_TYPE_CHECKPOINT: { kind: 'checkpoint', field: 'checkpoint' },
  CORTEX_STEP_TYPE_SYSTEM_MESSAGE: { kind: 'system', field: 'systemMessage' },
  CORTEX_STEP_TYPE_GENERIC: { kind: 'tool_generic', field: 'generic' },
  CORTEX_STEP_TYPE_ERROR_MESSAGE: { kind: 'error', field: 'errorMessage' }
});
const CONFIRM_INTERACTION_FIELDS = [
  'approvalInteraction',
  'mcp',
  'openBrowserUrl',
  'executeBrowserJavaScript',
  'captureBrowserScreenshot',
  'clickBrowserPixel',
  'readUrlContent',
  'sendCommandInput'
];

let disposers = [];

const ORCHESTRATOR_MASTER_KEYS = Object.freeze(['carbon', 'argon', 'neon', 'opus5.5']);
const ORCHESTRATOR_THINKING_LEVELS = Object.freeze(['off', 'none', 'minimal', 'low', 'medium', 'thinking', 'high', 'xhigh', 'max']);
const ORCHESTRATOR_THINKING_FALLBACK_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh']);
const ORCHESTRATOR_THINKING_OPTION_LABELS = Object.freeze({
  off: Object.freeze({ 'zh-CN': 'Off · 关闭思考', en: 'Off' }),
  none: Object.freeze({ 'zh-CN': 'None · 不思考', en: 'None' }),
  minimal: Object.freeze({ 'zh-CN': 'Minimal · 极速轻思考', en: 'Minimal' }),
  low: Object.freeze({ 'zh-CN': 'Low · 快速响应', en: 'Low' }),
  medium: Object.freeze({ 'zh-CN': 'Medium · 均衡推理', en: 'Medium' }),
  thinking: Object.freeze({ 'zh-CN': 'Thinking · 思考模式', en: 'Thinking' }),
  high: Object.freeze({ 'zh-CN': 'High · 深度推理', en: 'High' }),
  xhigh: Object.freeze({ 'zh-CN': 'XHigh · 超强推理', en: 'XHigh' }),
  max: Object.freeze({ 'zh-CN': 'Max · 极限推理', en: 'Max' })
});
const ORCHESTRATOR_THINKING_ORDER = Object.freeze({
  off: 0,
  none: 0,
  standard: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  thinking: 4,
  high: 5,
  xhigh: 6,
  max: 7
});
const ORCHESTRATOR_SETTING_KEY_MAP = Object.freeze({
  carbon: 'orchestratorCarbonThinking',
  argon: 'orchestratorArgonThinking',
  neon: 'orchestratorNeonThinking',
  'opus5.5': 'orchestratorOpusThinking'
});
const ORCHESTRATOR_FIELD_TO_MASTER = Object.freeze({
  orchestratorCarbonThinking: 'carbon',
  orchestratorArgonThinking: 'argon',
  orchestratorNeonThinking: 'neon',
  orchestratorOpusThinking: 'opus5.5'
});
const MODEL_SORT_MODES = Object.freeze(['custom', 'name_asc', 'name_desc', 'provider', 'frequency']);

const SUPPORTED_LOCALES = Object.freeze([
  Object.freeze({ code: 'en', bcp47: 'en', nativeName: 'English', shortLabel: 'EN' }),
  Object.freeze({ code: 'zh', bcp47: 'zh-CN', nativeName: '简体中文', shortLabel: '简中' }),
  Object.freeze({ code: 'zh-TW', bcp47: 'zh-TW', nativeName: '繁體中文', shortLabel: '繁中' }),
  Object.freeze({ code: 'ja', bcp47: 'ja', nativeName: '日本語', shortLabel: '日本語' }),
  Object.freeze({ code: 'ko', bcp47: 'ko', nativeName: '한국어', shortLabel: '한국어' }),
  Object.freeze({ code: 'es', bcp47: 'es', nativeName: 'Español', shortLabel: 'ES' }),
  Object.freeze({ code: 'pt', bcp47: 'pt', nativeName: 'Português', shortLabel: 'PT' }),
  Object.freeze({ code: 'fr', bcp47: 'fr', nativeName: 'Français', shortLabel: 'FR' }),
  Object.freeze({ code: 'ru', bcp47: 'ru', nativeName: 'Русский', shortLabel: 'RU' }),
  Object.freeze({ code: 'it', bcp47: 'it', nativeName: 'Italiano', shortLabel: 'IT' })
]);
const SUPPORTED_LOCALE_SET = new Set(SUPPORTED_LOCALES.map((l) => l.bcp47));

const SAFE_MOBILE_COMMANDS = Object.freeze([
  Object.freeze({ id: 'remote.status', minLevel: 'L0', title: { 'zh-CN': '查看远程通道状态', en: 'Check Remote Channel Status' } }),
  Object.freeze({ id: 'remote.check-cloudflared', minLevel: 'L0', title: { 'zh-CN': '检测 cloudflared 安装状态', en: 'Check cloudflared Installation' } }),
  Object.freeze({ id: 'context.rescan', minLevel: 'L1', title: { 'zh-CN': '重扫当前会话上下文', en: 'Rescan Context' } }),
  Object.freeze({ id: 'quota.refresh', minLevel: 'L1', title: { 'zh-CN': '刷新模型配额', en: 'Refresh Quota' } })
]);
const SAFE_MOBILE_COMMAND_MAP = new Map(SAFE_MOBILE_COMMANDS.map((c) => [c.id, c]));

const CONTEXT_GROUP_LABELS = Object.freeze({
  user: 'User',
  assistant: 'Assistant',
  thinking: 'Thinking',
  tools: 'Tools',
  summaries: 'Summaries',
  system: 'System',
  history: 'History',
  files: 'Files'
});

function unwrapStateEntry(entry) {
  if (entry === null || entry === undefined) return null;
  if (
    isPlainObject(entry) &&
    'value' in entry &&
    (typeof entry.key === 'string' ||
      typeof entry.version === 'number' ||
      typeof entry.updatedAt === 'number' ||
      Object.keys(entry).length <= 3)
  ) {
    return entry.value ?? null;
  }
  return entry;
}

function normalizeLocaleWhitelist(raw) {
  if (raw === undefined || raw === null) return null;
  const candidate = isPlainObject(raw) ? (raw.bcp47 ?? raw.locale ?? raw.lang ?? raw.code) : raw;
  if (typeof candidate !== 'string') return null;
  const clean = candidate.trim();
  if (SUPPORTED_LOCALE_SET.has(clean)) {
    return SUPPORTED_LOCALES.find((l) => l.bcp47 === clean) || null;
  }
  const lower = clean.replace(/_/g, '-').toLowerCase();
  if (lower === 'zh' || lower === 'zh-cn') {
    return SUPPORTED_LOCALES.find((l) => l.bcp47 === 'zh-CN') || null;
  }
  if (lower === 'zh-tw') {
    return SUPPORTED_LOCALES.find((l) => l.bcp47 === 'zh-TW') || null;
  }
  return SUPPORTED_LOCALES.find((l) => l.bcp47.toLowerCase() === lower || l.code.toLowerCase() === lower) || null;
}

function localOptimizePrompt(rawText) {
  const clean = String(rawText || '').trim();
  if (!clean) {
    return { ok: false, statusCode: 400, error: 'EMPTY_PROMPT', message: '先输入提示词草稿，再点击优化' };
  }
  if (/^\/\S*$/.test(clean)) {
    return { ok: false, statusCode: 400, error: 'SLASH_ONLY', message: '当前仅包含斜杠命令，无需优化' };
  }
  if (clean.length < 6 || clean.includes('\n')) {
    return {
      ok: true,
      original: clean,
      optimizedText: clean,
      text: clean,
      source: 'local-fallback',
      unchanged: true
    };
  }
  const optimized = `Goal:\n${clean}\n\nRequirements:\n- Inspect relevant code before editing\n- Verify changes with tests or checks\n- Summarize files changed and verification results`;
  return {
    ok: true,
    original: clean,
    optimizedText: optimized,
    text: optimized,
    source: 'local-fallback',
    unchanged: false
  };
}

async function callServiceWithTimeout(host, serviceName, method, args = [], timeoutMs = 1500) {
  if (!host?.services || typeof host.services.call !== 'function') {
    return { ok: false, unavailable: true, error: 'SERVICE_UNAVAILABLE' };
  }
  let timer = null;
  try {
    const callPromise = host.services.call(serviceName, method, args, { optional: true, timeoutMs });
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: 'SERVICE_TIMEOUT' }), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    return await Promise.race([callPromise, timeoutPromise]);
  } catch (err) {
    return { ok: false, error: err?.message || 'SERVICE_ERROR' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeContextGroups(rawGroups) {
  if (Array.isArray(rawGroups)) {
    const total = rawGroups.reduce((acc, g) => acc + Math.max(0, Number(g?.tokens || 0) || 0), 0);
    return rawGroups.map((g, idx) => {
      const tokens = Math.max(0, Number(g?.tokens ?? g?.high ?? 0) || 0);
      return {
        id: String(g?.id || g?.key || `group-${idx}`),
        label: String(g?.label || CONTEXT_GROUP_LABELS[g?.id] || g?.id || `Group ${idx + 1}`),
        tokens,
        share: typeof g?.share === 'number' ? g.share : (total > 0 ? Number((tokens / total).toFixed(4)) : 0)
      };
    });
  }
  if (!isPlainObject(rawGroups)) return [];
  const entries = Object.entries(rawGroups).map(([id, val]) => {
    const tokens = isPlainObject(val)
      ? Math.max(0, Number(val.tokens ?? val.high ?? val.low ?? 0) || 0)
      : Math.max(0, Number(val || 0) || 0);
    return { id, label: CONTEXT_GROUP_LABELS[id] || id, tokens };
  });
  const total = entries.reduce((acc, g) => acc + g.tokens, 0);
  return entries.map((g) => ({
    ...g,
    share: total > 0 ? Number((g.tokens / total).toFixed(4)) : 0
  }));
}

function normalizeContextAlerts(rawAlerts) {
  if (!Array.isArray(rawAlerts)) return [];
  return rawAlerts
    .filter((a) => a && typeof a === 'object')
    .map((a) => {
      const rawLvl = String(a.level || 'info').toLowerCase();
      const level = (rawLvl === 'danger' || rawLvl === 'critical' || rawLvl === 'error')
        ? 'critical'
        : (rawLvl === 'warn' || rawLvl === 'warning' ? 'warn' : 'info');
      return {
        level,
        ...(a.code ? { code: String(a.code) } : {}),
        message: String(a.message || '')
      };
    });
}

function normalizeUsageByModel(rawByModel) {
  if (Array.isArray(rawByModel)) {
    return rawByModel.map((m) => ({
      model: String(m?.model || m?.id || 'unknown'),
      label: String(m?.label || m?.model || m?.id || 'unknown'),
      inputTokens: Number(m?.inputTokens || 0),
      cachedTokens: Number(m?.cachedTokens ?? m?.cacheReadTokens ?? 0),
      outputTokens: Number(m?.outputTokens || 0),
      totalTokens: Number(m?.totalTokens ?? m?.tokens ?? 0),
      costUsd: Number(m?.costUsd ?? m?.costUSD ?? 0)
    }));
  }
  if (!isPlainObject(rawByModel)) return [];
  return Object.entries(rawByModel).map(([model, stats]) => ({
    model,
    label: String(stats?.label || model),
    inputTokens: Number(stats?.inputTokens || 0),
    cachedTokens: Number(stats?.cachedTokens ?? stats?.cacheReadTokens ?? 0),
    outputTokens: Number(stats?.outputTokens || 0),
    totalTokens: Number(stats?.totalTokens ?? stats?.tokens ?? 0),
    costUsd: Number(stats?.costUsd ?? stats?.costUSD ?? 0)
  }));
}

function normalizeQuotaBucket(b) {
  if (!isPlainObject(b)) return null;
  const resetInHuman = b.resetInHuman || b.countdownText || undefined;
  return {
    ...b,
    ...(resetInHuman ? { resetInHuman } : {})
  };
}

function normalizeOrchestratorMasterKey(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'carbon') return 'carbon';
  if (s === 'argon') return 'argon';
  if (s === 'neon') return 'neon';
  if (s === 'opus5.5' || s === 'opus 5.5' || s === 'opus-5.5' || s === 'opus') return 'opus5.5';
  return null;
}

function normalizeOrchestratorThinkingLevel(raw, fallback = 'high', { allowCustom = false } = {}) {
  const rawStr = String(raw || '').trim().toLowerCase().replace(/^thinking_level_/, '');
  if (!rawStr) return fallback;
  let s = rawStr;
  if (s === 'x-high' || s === 'extra high' || s === 'extra_high') s = 'xhigh';
  else if (s === 'med' || s === 'balanced') s = 'medium';
  else if (s === 'min') s = 'minimal';
  else if (s === 'fast') s = 'low';
  else if (s === 'think' || s === 'extended thinking') s = 'thinking';
  if (ORCHESTRATOR_THINKING_LEVELS.includes(s)) return s;
  if (allowCustom && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(s)) return s;
  return fallback;
}

function formatOrchestratorThinkingOption(level) {
  const clean = normalizeOrchestratorThinkingLevel(level, '', { allowCustom: true });
  if (!clean) return null;
  const known = ORCHESTRATOR_THINKING_OPTION_LABELS[clean];
  return {
    value: clean,
    label: known ? { ...known } : { 'zh-CN': clean, en: clean }
  };
}

function sortAndDedupeThinkingLevels(rawLevels = []) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(rawLevels) ? rawLevels : []) {
    const rawVal = isPlainObject(item)
      ? (item.thinkingSuffix ?? item.thinkingLevel ?? item.level ?? item.value ?? item.id ?? '')
      : item;
    const norm = normalizeOrchestratorThinkingLevel(rawVal, '', { allowCustom: true });
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  out.sort((a, b) => {
    const oa = ORCHESTRATOR_THINKING_ORDER[a] ?? 50;
    const ob = ORCHESTRATOR_THINKING_ORDER[b] ?? 50;
    if (oa !== ob) return oa - ob;
    return a.localeCompare(b);
  });
  return out;
}

function matchesOrchestratorMaster(master, text) {
  const hay = String(text || '').trim().toLowerCase();
  if (!hay) return false;
  if (master === 'opus5.5') {
    return /opus/i.test(hay);
  }
  if (master === 'carbon' || master === 'argon' || master === 'neon') {
    return new RegExp(`(?:^|[^a-z0-9])${master}(?:$|[^a-z0-9])`, 'i').test(hay);
  }
  return false;
}

function resolveOrchestratorMasterThinkingLevels(modelsRes, fieldKeyOrMaster) {
  const rawKey = String(fieldKeyOrMaster || '').trim();
  const master = ORCHESTRATOR_FIELD_TO_MASTER[rawKey] || normalizeOrchestratorMasterKey(rawKey) || 'carbon';
  const fieldKey = ORCHESTRATOR_SETTING_KEY_MAP[master] || rawKey;

  const rawModels = Array.isArray(modelsRes?.models) ? modelsRes.models : [];
  const rawGroups = Array.isArray(modelsRes?.groups)
    ? modelsRes.groups
    : (Array.isArray(modelsRes?.modelGroups) ? modelsRes.modelGroups : []);
  const treeNodes = Array.isArray(modelsRes?.tree?.nodes) ? modelsRes.tree.nodes : [];
  const hasCatalog = Boolean(
    modelsRes
    && modelsRes.ok !== false
    && (rawModels.length > 0 || rawGroups.length > 0 || treeNodes.length > 0)
  );

  if (!hasCatalog) {
    return {
      ok: true,
      fieldKey,
      master,
      hostReady: false,
      fallback: true,
      supported: true,
      options: ORCHESTRATOR_THINKING_FALLBACK_LEVELS.map(formatOrchestratorThinkingOption).filter(Boolean)
    };
  }

  const cleanModels = sanitizeModelCatalogResult({
    models: rawModels,
    defaultModelId: modelsRes.defaultModelId || '',
    rawGroups,
    modelTree: modelsRes.tree || null
  });

  const buildResult = (levels, { discovered = true } = {}) => {
    const sortedLevels = sortAndDedupeThinkingLevels(levels);
    const options = sortedLevels.map(formatOrchestratorThinkingOption).filter(Boolean);
    return {
      ok: true,
      fieldKey,
      master,
      hostReady: true,
      fallback: false,
      discovered,
      supported: options.length > 0,
      ...(options.length === 0
        ? {
            emptyReason: {
              'zh-CN': discovered ? '当前主控模型不支持调节思考等级' : '当前宿主模型目录未发现该主控模型',
              en: discovered ? 'This master model does not support thinking levels' : 'Master model not found in host catalog'
            }
          }
        : {}),
      options
    };
  };

  // 1. Check modelTree orchestrator leaves (web-harness tree preserves exact per-master supportedThinkingLevels)
  const orchBranch = treeNodes.find((n) => n?.kind === 'branch' && (n.key === 'orch' || n.role === 'orchestrator_root'));
  if (orchBranch && Array.isArray(orchBranch.children)) {
    const matchedLeaf = orchBranch.children.find((leaf) => leaf?.kind === 'leaf' && (
      matchesOrchestratorMaster(master, leaf.key)
      || matchesOrchestratorMaster(master, leaf.selection?.plannerFamilyId)
      || matchesOrchestratorMaster(master, leaf.selection?.requestedModel)
      || matchesOrchestratorMaster(master, leaf.selection?.modelId)
      || matchesOrchestratorMaster(master, leaf.label)
    ));
    if (matchedLeaf && Array.isArray(matchedLeaf.supportedThinkingLevels)) {
      return buildResult(matchedLeaf.supportedThinkingLevels, { discovered: true });
    }
  }

  // 2. Check orchestrator model group variants
  const orchGroup = cleanModels.modelGroups.find((g) => g?.id === 'orchestrator' || g?.isOrchestrator);
  if (orchGroup && Array.isArray(orchGroup.variants)) {
    const matchedVariants = orchGroup.variants.filter((v) => (
      normalizeOrchestratorMasterKey(v.orchestratorMaster) === master
      || matchesOrchestratorMaster(master, v.orchestratorMaster)
      || matchesOrchestratorMaster(master, v.modelId)
      || matchesOrchestratorMaster(master, v.orchestratorVariant)
      || matchesOrchestratorMaster(master, v.label)
    ));
    if (matchedVariants.length > 0) {
      const explicitLevels = matchedVariants.flatMap((v) => (Array.isArray(v.supportedThinkingLevels) ? v.supportedThinkingLevels : []));
      const variantLevels = matchedVariants.map((v) => v.thinkingLevel).filter(Boolean);
      const combined = explicitLevels.length > 0 ? explicitLevels : variantLevels;
      return buildResult(combined, { discovered: true });
    }
  }

  // 3. Check backing family group in cleanModels.modelGroups
  const backingGroup = cleanModels.modelGroups.find((g) => !g?.isOrchestrator && (
    matchesOrchestratorMaster(master, g.id)
    || matchesOrchestratorMaster(master, g.label)
  ));
  if (backingGroup) {
    const groupLevels = Array.isArray(backingGroup.supportedThinkingLevels) && backingGroup.supportedThinkingLevels.length > 0
      ? backingGroup.supportedThinkingLevels
      : (Array.isArray(backingGroup.variants) ? backingGroup.variants.map((v) => v.thinkingLevel).filter(Boolean) : []);
    return buildResult(groupLevels, { discovered: true });
  }

  // 4. Check rawGroups metadata directly (e.g. groupedModels entry with explicit supportedThinkingLevels)
  const flatRawGroups = [];
  for (const g of rawGroups) {
    if (!isPlainObject(g)) continue;
    flatRawGroups.push(g);
    if (Array.isArray(g.groups)) {
      for (const sub of g.groups) {
        if (isPlainObject(sub)) flatRawGroups.push(sub);
      }
    }
  }
  const matchedRawGroup = flatRawGroups.find((rg) => (
    Array.isArray(rg.supportedThinkingLevels)
    && (
      matchesOrchestratorMaster(master, rg.groupId || rg.familyId || rg.id)
      || matchesOrchestratorMaster(master, rg.displayName || rg.label)
    )
  ));
  if (matchedRawGroup) {
    return buildResult(matchedRawGroup.supportedThinkingLevels, { discovered: true });
  }

  // 5. Fallback scan across individual discovered models matching master
  const matchedModels = cleanModels.models.filter((m) => (
    matchesOrchestratorMaster(master, m.id)
    || matchesOrchestratorMaster(master, m.modelId)
    || matchesOrchestratorMaster(master, m.family)
    || matchesOrchestratorMaster(master, m.displayName)
    || matchesOrchestratorMaster(master, m.label)
  ));
  if (matchedModels.length > 0) {
    const explicit = matchedModels.flatMap((m) => (Array.isArray(m.supportedThinkingLevels) ? m.supportedThinkingLevels : []));
    const tiers = matchedModels.map((m) => m.thinkingLevel).filter(Boolean);
    return buildResult(explicit.length > 0 ? explicit : tiers, { discovered: true });
  }

  return buildResult([], { discovered: false });
}

function sanitizeOrchestratorThinkingMap(raw = {}) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    carbon: normalizeOrchestratorThinkingLevel(src.carbon, 'high'),
    argon: normalizeOrchestratorThinkingLevel(src.argon, 'high'),
    neon: normalizeOrchestratorThinkingLevel(src.neon, 'high'),
    'opus5.5': normalizeOrchestratorThinkingLevel(src['opus5.5'] ?? src.opus, 'high')
  };
}

function normalizeModelSortMode(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return MODEL_SORT_MODES.includes(s) ? s : 'custom';
}

function sanitizeModelFilterOrder(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const s = String(item || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function inferModelProviderCategory(nameOrId = '') {
  const hay = String(nameOrId || '').toLowerCase();
  if (hay.includes('orchestrator') || hay.includes('编排')) return 'orchestrator';
  if (hay.includes('claude') || hay.includes('opus') || hay.includes('sonnet') || hay.includes('haiku')) return 'claude';
  if (hay.includes('gemini') || hay.includes('neon') || hay.includes('flash') || hay.includes('carbon') || hay.includes('argon')) return 'gemini';
  if (hay.includes('gpt') || hay.includes('openai') || /\bo[134]\b/.test(hay)) return 'openai';
  return 'other';
}

function isTestMode() {
  return process.env.AGY_DADDY_TEST_MODE === '1';
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function normalizePickedDirPath(rawPath) {
  const raw = String(rawPath || '').trim();
  if (!raw) return '';
  let expanded = raw;
  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }
  if (expanded === '/') return '/';
  return expanded.replace(/[\\/]+$/, '') || '/';
}

function runExecFileAsync(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, {
      timeout: opts.timeout ?? 120000,
      maxBuffer: opts.maxBuffer ?? 1024 * 1024,
      env: opts.env || process.env,
      encoding: 'utf8'
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({
          ok: false,
          code: err.code ?? null,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err.message || String(err)
        });
        return;
      }
      resolve({
        ok: true,
        code: 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      });
    });
  });
}

function isUserCancelledOsascript(res) {
  const text = `${res?.stderr || ''} ${res?.error || ''}`;
  return /-128\b|user canceled|用户已取消/i.test(text);
}

async function openAllowedRootDirectoryDialog(opts = {}) {
  const defaultDir = normalizePickedDirPath(opts.defaultDir || '') || os.homedir();
  const promptText = String(opts.title || '选择允许访问的工作区根目录').trim();

  if (typeof opts.dirPickerFn === 'function') {
    const res = await opts.dirPickerFn({ defaultDir, title: promptText });
    if (res && res.ok === false) {
      return { ok: false, cancelled: false, path: '', error: String(res.error || '无法打开文件夹选择对话框') };
    }
    if (!res || res.cancelled || !res.path) {
      return { ok: true, cancelled: true, path: '' };
    }
    return { ok: true, cancelled: false, path: normalizePickedDirPath(res.path) };
  }

  if (isTestMode() || process.env.NODE_ENV === 'test' || process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT !== undefined) {
    const testResult = String(process.env.AGY_DADDY_TEST_DIR_DIALOG_RESULT || '').trim();
    if (!testResult || testResult === '__CANCEL__') {
      return { ok: true, cancelled: true, path: '' };
    }
    return { ok: true, cancelled: false, path: normalizePickedDirPath(testResult) };
  }

  const platform = opts.platform || process.platform;
  if (platform === 'darwin') {
    const hasDir = defaultDir && fs.existsSync(defaultDir);
    const script = hasDir
      ? [
          'on run argv',
          '  set pTitle to item 1 of argv',
          '  set pDir to item 2 of argv',
          '  tell current application to activate',
          '  return POSIX path of (choose folder with prompt pTitle default location ((POSIX file pDir) as alias))',
          'end run'
        ].join('\n')
      : [
          'on run argv',
          '  set pTitle to item 1 of argv',
          '  tell current application to activate',
          '  return POSIX path of (choose folder with prompt pTitle)',
          'end run'
        ].join('\n');
    const args = ['-e', script, '--', promptText];
    if (hasDir) args.push(defaultDir);
    const res = await runExecFileAsync('osascript', args, { timeout: 120000 });
    if (!res.ok) {
      if (isUserCancelledOsascript(res)) {
        return { ok: true, cancelled: true, path: '' };
      }
      return { ok: false, cancelled: false, path: '', error: (res.stderr || res.error || '无法打开文件夹选择对话框').trim() };
    }
    const picked = normalizePickedDirPath(res.stdout);
    return picked
      ? { ok: true, cancelled: false, path: picked }
      : { ok: true, cancelled: true, path: '' };
  }

  if (platform === 'win32') {
    const psScript = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = $env:AGY_DLG_TITLE',
      'if ($env:AGY_DLG_DIR -and (Test-Path $env:AGY_DLG_DIR)) { $d.SelectedPath = $env:AGY_DLG_DIR }',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }'
    ].join('; ');
    const res = await runExecFileAsync('powershell.exe', ['-NoProfile', '-Command', psScript], {
      timeout: 120000,
      env: { ...process.env, AGY_DLG_TITLE: promptText, AGY_DLG_DIR: defaultDir }
    });
    if (!res.ok && !res.stdout.trim()) {
      return { ok: false, cancelled: false, path: '', error: (res.stderr || res.error || '无法打开文件夹选择对话框').trim() };
    }
    const picked = normalizePickedDirPath(res.stdout);
    return picked ? { ok: true, cancelled: false, path: picked } : { ok: true, cancelled: true, path: '' };
  }

  const zen = await runExecFileAsync('zenity', ['--file-selection', '--directory', `--title=${promptText}`, `--filename=${defaultDir}/`], { timeout: 120000 });
  if (zen.ok && zen.stdout.trim()) {
    return { ok: true, cancelled: false, path: normalizePickedDirPath(zen.stdout) };
  }
  const kd = await runExecFileAsync('kdialog', ['--getexistingdirectory', defaultDir, '--title', promptText], { timeout: 120000 });
  if (kd.ok && kd.stdout.trim()) {
    return { ok: true, cancelled: false, path: normalizePickedDirPath(kd.stdout) };
  }
  if (!zen.ok && !kd.ok && (zen.code !== 1 && kd.code !== 1)) {
    return { ok: false, cancelled: false, path: '', error: (zen.stderr || kd.stderr || zen.error || kd.error || '无法打开文件夹选择对话框').trim() };
  }
  return { ok: true, cancelled: true, path: '' };
}

function scrubTokenFromUrl(rawUrl) {
  const str = String(rawUrl || '').trim();
  if (!str) return '';
  try {
    const u = new URL(str);
    if (!u.searchParams.has('token') && !u.searchParams.has('t')) {
      return str;
    }
    u.searchParams.delete('token');
    u.searchParams.delete('t');
    return u.toString();
  } catch {
    return str;
  }
}

function normalizeIpOrHost(raw) {
  let clean = String(raw || '').trim().replace(/^\[|\]$/g, '');
  if (!clean) return '';
  const zoneIdx = clean.indexOf('%');
  if (zoneIdx >= 0) clean = clean.slice(0, zoneIdx);
  clean = clean.replace(/^::ffff:/i, '').toLowerCase();
  if (clean.includes(':')) {
    try {
      const parsed = new URL(`http://[${clean}]`);
      return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    } catch {
      return clean;
    }
  }
  return clean.replace(/\.$/, '');
}

function extractLegacyCloudflareOrigin(raw) {
  if (!raw || typeof raw !== 'object') return '';
  if (raw.cloudflareState?.mode !== 'legacy_standalone') return '';
  const rawHost = typeof raw.tunnelHostname === 'string' ? raw.tunnelHostname.trim() : '';
  if (!rawHost) return '';
  try {
    const u = new URL(rawHost);
    if (u.protocol !== 'https:') return '';
    const statePub = typeof raw.cloudflareState?.publicOrigin === 'string' ? raw.cloudflareState.publicOrigin.trim() : '';
    if (statePub) {
      try {
        if (new URL(statePub).origin !== u.origin) return '';
      } catch {
        return '';
      }
    }
    return u.origin;
  } catch {
    return '';
  }
}

function isAllowedPcWebUrl(rawUrl, allowCtx = {}) {
  const str = String(rawUrl || '').trim();
  if (!str) return false;
  let u;
  try {
    u = new URL(str);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = normalizeIpOrHost(u.hostname);

  // 1. loopback
  if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(host)) {
    return true;
  }
  // 2. cloudflare shared tunnel (/pc or /pc/) or verified legacy_standalone
  if (
    u.protocol === 'https:' &&
    allowCtx.tunnelPublicOrigin &&
    u.origin === allowCtx.tunnelPublicOrigin &&
    (u.pathname === '/pc' || u.pathname.startsWith('/pc/'))
  ) {
    return true;
  }
  if (
    u.protocol === 'https:' &&
    allowCtx.legacyCloudflareOrigin &&
    u.origin === allowCtx.legacyCloudflareOrigin
  ) {
    return true;
  }
  // 3. tailscale (IPv4, canonical IPv6, and *.ts.net)
  if (isTailscaleIp(host) && allowCtx.localTailscaleIps?.has?.(host)) {
    return true;
  }
  if (u.protocol === 'https:' && allowCtx.tailscaleHttpsOrigin) {
    try {
      const tsUrl = new URL(allowCtx.tailscaleHttpsOrigin.includes('://')
        ? allowCtx.tailscaleHttpsOrigin
        : `https://${allowCtx.tailscaleHttpsOrigin}`);
      if (u.origin === tsUrl.origin) return true;
      const tsHost = normalizeIpOrHost(tsUrl.hostname);
      if (host.endsWith('.ts.net') && tsHost && host === tsHost) return true;
    } catch {}
  }
  // 4. lan
  if (u.protocol === 'http:' && allowCtx.localLanIps?.has?.(host)) {
    return true;
  }
  // 5. bonjour
  if (u.protocol === 'http:' && allowCtx.bonjourHost && host === normalizeIpOrHost(allowCtx.bonjourHost)) {
    return true;
  }
  return false;
}

function normalizeRootUriToPath(uriOrPath) {
  const s = String(uriOrPath || '').trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(s).pathname);
    } catch {
      return s.slice(7);
    }
  }
  return s;
}

function isExistingDirectory(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return false;
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function normalizePcWebInfo(raw, allowCtx = {}) {
  const empty = {
    available: false,
    running: false,
    proxyRunning: false,
    host: '127.0.0.1',
    port: null,
    url: '',
    pairingUrl: '',
    primaryChannel: 'offline',
    primaryUrl: '',
    channels: {},
    tunnelHostname: '',
    cloudflareState: null
  };
  if (!raw || typeof raw !== 'object' || raw.ok === false) {
    return empty;
  }
  const serviceRunning = Boolean(raw.running);
  const host = typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : '127.0.0.1';
  const port = Number.isInteger(raw.port) && raw.port > 0 && raw.port <= 65535 ? raw.port : null;
  const channels = raw.channels && typeof raw.channels === 'object' ? { ...raw.channels } : {};
  const cloudflareState = raw.cloudflareState && typeof raw.cloudflareState === 'object' ? { ...raw.cloudflareState } : null;
  const legacyCloudflareOrigin = allowCtx.legacyCloudflareOrigin || extractLegacyCloudflareOrigin(raw);
  const effectiveAllowCtx = legacyCloudflareOrigin
    ? { ...allowCtx, legacyCloudflareOrigin }
    : allowCtx;

  const rawUrls = raw.urls && typeof raw.urls === 'object' ? raw.urls : {};
  const rawAuthUrls = raw.authUrls && typeof raw.authUrls === 'object' ? raw.authUrls : {};

  let chosenChannel = '';
  let chosenCleanUrl = '';
  let chosenPairingUrl = '';

  for (const ch of PRIMARY_CHANNEL_ORDER) {
    const authCand = isAllowedPcWebUrl(rawAuthUrls[ch], effectiveAllowCtx) ? String(rawAuthUrls[ch]).trim() : '';
    const pubCand = isAllowedPcWebUrl(rawUrls[ch], effectiveAllowCtx) ? String(rawUrls[ch]).trim() : '';
    if (authCand || pubCand) {
      chosenChannel = ch;
      chosenCleanUrl = pubCand ? scrubTokenFromUrl(pubCand) : scrubTokenFromUrl(authCand);
      chosenPairingUrl = authCand || pubCand;
      break;
    }
  }

  if (!chosenCleanUrl && !chosenPairingUrl) {
    const fallbackClean = isAllowedPcWebUrl(raw.url, effectiveAllowCtx) ? String(raw.url).trim() : '';
    const fallbackPrimary = isAllowedPcWebUrl(raw.primaryUrl, effectiveAllowCtx) ? String(raw.primaryUrl).trim() : '';
    const fallbackPairing = isAllowedPcWebUrl(raw.pairingUrl, effectiveAllowCtx) ? String(raw.pairingUrl).trim() : '';
    if (fallbackClean || fallbackPrimary || fallbackPairing) {
      chosenCleanUrl = fallbackClean || scrubTokenFromUrl(fallbackPrimary || fallbackPairing);
      chosenPairingUrl = fallbackPairing || fallbackPrimary || fallbackClean;
      chosenChannel = typeof raw.primaryChannel === 'string' && PRIMARY_CHANNEL_ORDER.includes(raw.primaryChannel)
        ? raw.primaryChannel
        : 'loopback';
    }
  }

  const isDisplayRunning = Boolean(serviceRunning && (chosenPairingUrl || chosenCleanUrl));
  return {
    available: true,
    running: isDisplayRunning,
    proxyRunning: Boolean(serviceRunning && port),
    host,
    port,
    url: chosenCleanUrl,
    pairingUrl: chosenPairingUrl,
    primaryChannel: isDisplayRunning ? (chosenChannel || 'loopback') : 'offline',
    primaryUrl: chosenCleanUrl,
    channels,
    tunnelHostname: legacyCloudflareOrigin || (typeof raw.tunnelHostname === 'string' ? raw.tunnelHostname.trim() : ''),
    cloudflareState
  };
}

function openLocalBrowserUrl(url, allowCtx = {}) {
  if (!isAllowedPcWebUrl(url, allowCtx)) {
    return { ok: false, error: 'INVALID_PC_WEB_URL' };
  }
  const safeUrl = String(url).trim();
  if (isTestMode()) {
    return { ok: true, opened: false, dryRun: true, url: safeUrl };
  }
  try {
    const spec = process.platform === 'darwin'
      ? { bin: 'open', args: [safeUrl] }
      : (process.platform === 'win32'
        ? { bin: 'cmd', args: ['/c', 'start', '', safeUrl], windowsHide: true }
        : { bin: 'xdg-open', args: [safeUrl] });
    const child = spawn(spec.bin, spec.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: Boolean(spec.windowsHide)
    });
    child.unref();
    return { ok: true, opened: true, dryRun: false, url: safeUrl };
  } catch (err) {
    return { ok: false, error: err?.message || 'OPEN_BROWSER_FAILED' };
  }
}

function isRedundantPlanPreset(item) {
  if (!item) return false;
  const id = String(item.id || '').trim().toLowerCase();
  const prompt = String(item.prompt || '').trim().toLowerCase();
  if (prompt === '/plan') return true;
  if (id === 'plan' && (prompt === '' || prompt === 'plan' || prompt === '/plan')) return true;
  return false;
}

function sanitizePresetItem(item, fallbackCat, idx) {
  if (typeof item === 'string') {
    const text = item.trim();
    if (!text) return null;
    return {
      id: `${fallbackCat}_${idx}`,
      label: text,
      prompt: text,
      category: fallbackCat
    };
  }
  if (!isPlainObject(item)) return null;
  const label = String(item.label ?? item.title ?? item.name ?? '').trim();
  const prompt = String(item.prompt ?? item.text ?? item.content ?? '').trim();
  if (!label && !prompt) return null;
  const id = item.id !== undefined && item.id !== null && String(item.id).trim()
    ? String(item.id).trim()
    : `${fallbackCat}_${idx}`;
  return {
    id,
    label: label || prompt,
    prompt: prompt || label,
    category: String(item.category || item.group || fallbackCat)
  };
}

function isVirtualInterfaceName(name) {
  return /^(?:lo\d*|utun\d*|bridge\d*|docker\d*|veth|br-|virbr|vmnet|vboxnet|awdl|llw|anpi|ap\d*)/i.test(String(name || ''));
}

function normalizeStepEvent(step, idx) {
  const safe = isPlainObject(step) ? step : {};
  const seq = Number.isInteger(safe.stepIndex) ? safe.stepIndex : idx;
  const rawType = typeof safe.type === 'string' && safe.type.trim() ? safe.type.trim() : 'CORTEX_STEP_TYPE_GENERIC';
  const rawStatus = typeof safe.status === 'string' ? safe.status.trim() : '';
  const status = STEP_STATUS_MAP[rawStatus] || STEP_STATUS_MAP[rawStatus.toUpperCase()] || 'pending';
  const spec = STEP_KIND_MAP[rawType];
  if (spec) {
    const rawPayload = isPlainObject(safe[spec.field]) ? safe[spec.field] : {};
    const payload = { ...rawPayload };
    if (spec.kind === 'user' && payload.text === undefined) {
      payload.text = payload.userResponse || (Array.isArray(payload.items)
        ? payload.items.map((it) => (typeof it === 'string' ? it : (it?.text || ''))).filter(Boolean).join('\n')
        : '');
    }
    if (spec.kind === 'thinking_and_text' && payload.text === undefined) {
      payload.text = payload.modifiedResponse ?? payload.response ?? '';
    }
    if (isPlainObject(safe.requestedInteraction) && payload.requestedInteraction === undefined) {
      payload.requestedInteraction = safe.requestedInteraction;
    }
    if (Array.isArray(safe.completedInteractions) && payload.completedInteractions === undefined) {
      payload.completedInteractions = safe.completedInteractions;
    }
    if (isPlainObject(safe.sourceTrajectoryStepInfo) && payload.sourceTrajectoryStepInfo === undefined) {
      payload.sourceTrajectoryStepInfo = safe.sourceTrajectoryStepInfo;
    }
    if (isPlainObject(safe.metadata) && payload.metadata === undefined) {
      payload.metadata = safe.metadata;
    }
    return {
      seq,
      kind: spec.kind,
      status,
      rawType,
      ...(safe.title ? { title: safe.title } : {}),
      payload
    };
  }
  return {
    seq,
    kind: 'tool_generic',
    status,
    rawType,
    ...(safe.title ? { title: safe.title } : {}),
    payload: { ...safe }
  };
}

function normalizeSummary(cascadeId, item) {
  const entry = isPlainObject(item) ? item : {};
  const workspaces = Array.isArray(entry.workspaces) ? entry.workspaces : [];
  const ws0 =
    workspaces.find((ws) => {
      if (!isPlainObject(ws)) return false;
      const u = ws.workspaceFolderAbsoluteUri || ws.workspaceUri || '';
      return Boolean(u) && !isTempBridgeWorkspace(u);
    }) ||
    (isPlainObject(workspaces[0]) ? workspaces[0] : {});
  const rawStatus = entry.status || 'CASCADE_RUN_STATUS_IDLE';
  const upper = String(rawStatus).toUpperCase();
  const needsAttention = Boolean(
    entry.needsAttention || entry.pendingInteraction || upper.includes('PENDING') || upper.includes('WAITING') || upper.includes('ERROR')
  );
  const attentionReason = entry.attentionReason || (upper.includes('ERROR') ? '运行出错' : (needsAttention ? '等待处理' : null));
  return {
    cascadeId,
    title: entry.annotations?.title || entry.title || entry.summary || cascadeId,
    summary: entry.summary || '',
    status: rawStatus,
    needsAttention,
    attentionReason,
    stepCount: Number(entry.stepCount || 0),
    lastModifiedTime: entry.lastModifiedTime || entry.createdTime || null,
    createdTime: entry.createdTime || null,
    workspaceUri: ws0.workspaceFolderAbsoluteUri || ws0.workspaceUri || null,
    gitRootUri: ws0.gitRootAbsoluteUri || ws0.gitRootUri || null,
    repoName: ws0.repository?.computedName || ws0.repository?.name || ws0.repoName || null,
    branchName: ws0.branchName || null,
    workspaces
  };
}

/**
 * Derives the delta cursor for a freshly loaded trajectory: the contiguous terminal prefix is
 * already on screen, so polling resumes right after it, with fingerprints for everything observed.
 */
function buildSeededCursor(events) {
  const fingerprints = new Map();
  for (const ev of events) {
    fingerprints.set(ev.seq, crypto.createHash('sha1').update(JSON.stringify(ev)).digest('hex'));
  }
  let stepOffset = 0;
  for (const ev of events) {
    if (ev.seq !== stepOffset || !TERMINAL_STEP_STATUSES.has(ev.status)) break;
    stepOffset += 1;
  }
  return { stepOffset, fingerprints };
}

function createStandaloneRpcAdapter(rpc) {
  const cursors = new Map();

  function ensureRpc() {
    if (!rpc || typeof rpc.call !== 'function') {
      const err = new Error('RPC_UNAVAILABLE');
      err.statusCode = 503;
      err.code = 'RPC_UNAVAILABLE';
      throw err;
    }
  }

  return {
    async listSessions({ limit = DEFAULT_SESSION_LIMIT } = {}) {
      ensureRpc();
      const resp = await rpc.call('GetAllCascadeTrajectories', {});
      const summaries = isPlainObject(resp?.trajectorySummaries) ? resp.trajectorySummaries : {};
      const sessions = Object.entries(summaries)
        .map(([id, item]) => normalizeSummary(id, item))
        .sort((a, b) => (Date.parse(b.lastModifiedTime || '') || 0) - (Date.parse(a.lastModifiedTime || '') || 0));
      return { ok: true, sessions: sessions.slice(0, Math.max(1, Number(limit) || DEFAULT_SESSION_LIMIT)) };
    },
    async getSessionDetail(cascadeId) {
      ensureRpc();
      const resp = await rpc.call('GetCascadeTrajectory', { cascadeId });
      const trajectory = isPlainObject(resp?.trajectory) ? resp.trajectory : (isPlainObject(resp) ? resp : {});
      const rawSteps = Array.isArray(trajectory.steps) ? trajectory.steps : (Array.isArray(resp?.steps) ? resp.steps : []);
      const events = rawSteps.map((s, idx) => normalizeStepEvent(s, idx));
      // Seed the delta cursor from the detail we just built: the client already rendered the
      // terminal prefix, so the first delta poll must not re-pull the whole trajectory from 0.
      cursors.set(cascadeId, buildSeededCursor(events));
      return {
        ok: true,
        session: {
          cascadeId: trajectory.cascadeId || cascadeId,
          trajectoryId: trajectory.trajectoryId || null,
          status: resp?.status || trajectory.status || 'CASCADE_RUN_STATUS_IDLE',
          numTotalSteps: Number.isFinite(Number(resp?.numTotalSteps)) ? Number(resp.numTotalSteps) : rawSteps.length,
          metadata: trajectory.metadata || null
        },
        events
      };
    },
    async getSessionDelta(cascadeId, { afterSeq } = {}) {
      ensureRpc();
      let cursor = cursors.get(cascadeId);
      if (!cursor) {
        cursor = { stepOffset: 0, fingerprints: new Map() };
        cursors.set(cascadeId, cursor);
      }
      const hasExplicitAfter = afterSeq !== undefined && afterSeq !== null && Number.isInteger(Number(afterSeq));
      const reqOffset = hasExplicitAfter ? Math.max(0, Number(afterSeq) + 1) : cursor.stepOffset;
      const resp = await rpc.call('GetCascadeTrajectorySteps', { cascadeId, stepOffset: reqOffset });
      const rawSteps = Array.isArray(resp?.steps) ? resp.steps : (Array.isArray(resp?.trajectory?.steps) ? resp.trajectory.steps : []);
      const normalized = rawSteps.map((s, i) => normalizeStepEvent(s, Number.isInteger(s?.stepIndex) ? s.stepIndex : reqOffset + i));
      const emitted = [];
      for (const ev of normalized) {
        if (hasExplicitAfter) {
          emitted.push(ev);
          continue;
        }
        const fp = crypto.createHash('sha1').update(JSON.stringify(ev)).digest('hex');
        if (cursor.fingerprints.get(ev.seq) !== fp) {
          cursor.fingerprints.set(ev.seq, fp);
          emitted.push(ev);
        }
      }
      let nextOffset = reqOffset;
      for (const ev of normalized) {
        if (ev.seq !== nextOffset || !TERMINAL_STEP_STATUSES.has(ev.status)) break;
        nextOffset++;
      }
      if (!hasExplicitAfter) cursor.stepOffset = nextOffset;
      const hasNonTerminal = normalized.some((ev) => !TERMINAL_STEP_STATUSES.has(ev.status));
      const status = resp?.status || resp?.trajectory?.status || (hasNonTerminal ? 'CASCADE_RUN_STATUS_RUNNING' : 'CASCADE_RUN_STATUS_IDLE');
      const totalSteps = Number.isFinite(Number(resp?.numTotalSteps))
        ? Number(resp.numTotalSteps)
        : Math.max(reqOffset + normalized.length, nextOffset);
      return {
        ok: true,
        cascadeId,
        status,
        totalSteps,
        stepOffset: hasExplicitAfter ? nextOffset : cursor.stepOffset,
        events: emitted,
        hasChanges: emitted.length > 0
      };
    },
    async createSession({ title, workspaceUri } = {}) {
      ensureRpc();
      const cleanUri = typeof workspaceUri === 'string' && workspaceUri.trim() ? workspaceUri.trim() : '';
      const params = {
        source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
        metadata: { ...DEFAULT_RPC_METADATA },
        ...(cleanUri ? { workspaceUris: [cleanUri] } : {})
      };
      const resp = await rpc.call('StartCascade', params);
      return {
        ok: true,
        cascadeId: resp?.cascadeId || '',
        ...(title ? { title } : {}),
        ...(cleanUri ? { workspaceUri: cleanUri } : {})
      };
    },
    async sendMessage(cascadeId, { text, modelId, mode, images, attachments } = {}) {
      ensureRpc();
      const items = [];
      if (typeof text === 'string' && text.trim()) items.push({ text });
      if (Array.isArray(attachments)) {
        for (const a of attachments) {
          if (typeof a === 'string' && a.trim()) items.push({ text: a });
          else if (isPlainObject(a) && typeof a.text === 'string') items.push({ text: a.text });
        }
      }
      const normImages = [];
      if (Array.isArray(images)) {
        for (const img of images) {
          if (isPlainObject(img) && typeof img.dataUrl === 'string') {
            const m = img.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (m) normImages.push({ mimeType: img.mime || m[1], inlineData: m[2] });
          }
        }
      }
      const params = { cascadeId, items, metadata: { ...DEFAULT_RPC_METADATA } };
      if (normImages.length > 0) params.images = normImages;
      const plannerConfig = {};
      if (typeof modelId === 'string' && modelId.trim()) {
        plannerConfig.requestedModel = { model: modelId.trim() };
      }
      const cleanMode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
      if (cleanMode === 'plan') {
        plannerConfig.conversational = { plannerMode: 'CONVERSATIONAL_PLANNER_MODE_READ_ONLY', agenticMode: false };
      } else if (cleanMode === 'chat') {
        plannerConfig.conversational = { plannerMode: 'CONVERSATIONAL_PLANNER_MODE_DEFAULT', agenticMode: true };
      }
      if (Object.keys(plannerConfig).length > 0) params.cascadeConfig = { plannerConfig };
      await rpc.call('SendUserCascadeMessage', params);
      return { ok: true, cascadeId };
    },
    async cancelSession(cascadeId) {
      ensureRpc();
      await rpc.call('CancelCascadeInvocation', { cascadeId });
      return { ok: true, cascadeId };
    },
    async deleteSession(cascadeId) {
      ensureRpc();
      await rpc.call('DeleteCascadeTrajectory', { cascadeId });
      cursors.delete(cascadeId);
      return { ok: true, cascadeId, hostCleaned: true };
    },
    async approveStep(cascadeId, stepIdx, decision = 'allow', payload = {}) {
      ensureRpc();
      const allow = typeof decision === 'boolean'
        ? decision
        : !['deny', 'reject', 'false', '0', 'cancel'].includes(String(decision || 'allow').trim().toLowerCase());
      const detail = await rpc.call('GetCascadeTrajectory', { cascadeId });
      const trajectory = isPlainObject(detail?.trajectory) ? detail.trajectory : (isPlainObject(detail) ? detail : {});
      const steps = Array.isArray(trajectory.steps) ? trajectory.steps : (Array.isArray(detail?.steps) ? detail.steps : []);
      const step = steps.find((s, i) => (Number.isInteger(s?.stepIndex) ? s.stepIndex : i) === stepIdx) || steps[stepIdx] || null;
      const trajectoryId = step?.sourceTrajectoryStepInfo?.trajectoryId || payload?.trajectoryId || trajectory.trajectoryId || cascadeId;
      const resolvedStepIndex = Number.isInteger(step?.sourceTrajectoryStepInfo?.stepIndex)
        ? step.sourceTrajectoryStepInfo.stepIndex
        : (Number.isInteger(step?.stepIndex) ? step.stepIndex : stepIdx);
      const reqInt = step?.requestedInteraction?.interaction || step?.requestedInteraction || payload?.requestedInteraction || {};

      let interactionType = 'permission';
      let interactionBody = { allow, scope: payload?.scope || 'PERMISSION_SCOPE_ONCE' };
      const matchedConfirm = CONFIRM_INTERACTION_FIELDS.find((f) => reqInt[f] !== undefined);
      if (matchedConfirm) {
        interactionType = matchedConfirm;
        interactionBody = { confirm: allow };
      } else if (reqInt.filePermission !== undefined) {
        interactionType = 'filePermission';
        interactionBody = {
          allow,
          scope: payload?.scope || 'PERMISSION_SCOPE_ONCE',
          absolutePathUri: reqInt.filePermission?.absolutePathUri || payload?.absolutePathUri || ''
        };
      } else if (reqInt.runCommand !== undefined || (reqInt.permission === undefined && step?.type === 'CORTEX_STEP_TYPE_RUN_COMMAND')) {
        interactionType = 'runCommand';
        const cmd = payload?.submittedCommandLine || reqInt.runCommand?.proposedCommandLine || step?.runCommand?.commandLine || '';
        interactionBody = { confirm: allow, ...(cmd ? { proposedCommandLine: cmd, submittedCommandLine: cmd } : {}) };
      }

      await rpc.call('HandleCascadeUserInteraction', {
        cascadeId,
        interaction: { trajectoryId, stepIndex: resolvedStepIndex, [interactionType]: interactionBody }
      });
      return { ok: true, supported: true, cascadeId, stepIndex: resolvedStepIndex, trajectoryId, interactionType };
    },
    async answerQuestion(cascadeId, stepIdx, answers = [], payload = {}) {
      ensureRpc();
      const detail = await rpc.call('GetCascadeTrajectory', { cascadeId });
      const trajectory = isPlainObject(detail?.trajectory) ? detail.trajectory : (isPlainObject(detail) ? detail : {});
      const steps = Array.isArray(trajectory.steps) ? trajectory.steps : (Array.isArray(detail?.steps) ? detail.steps : []);
      const step = steps.find((s, i) => (Number.isInteger(s?.stepIndex) ? s.stepIndex : i) === stepIdx) || steps[stepIdx] || null;
      const trajectoryId = step?.sourceTrajectoryStepInfo?.trajectoryId || payload?.trajectoryId || trajectory.trajectoryId || cascadeId;
      const resolvedStepIndex = Number.isInteger(step?.sourceTrajectoryStepInfo?.stepIndex)
        ? step.sourceTrajectoryStepInfo.stepIndex
        : (Number.isInteger(step?.stepIndex) ? step.stepIndex : stepIdx);
      const stepQs = step?.requestedInteraction?.interaction?.askQuestion?.questions
        || step?.requestedInteraction?.askQuestion?.questions
        || step?.askQuestion?.questions
        || [];
      const ansArr = Array.isArray(answers) ? answers : (isPlainObject(answers) && Array.isArray(answers.responses) ? null : [answers]);
      const responses = ansArr === null
        ? answers.responses
        : Array.from({ length: Math.max(stepQs.length, ansArr.length) }, (_, idx) => {
          const qRaw = stepQs[idx];
          const qObj = isPlainObject(qRaw) ? qRaw : {};
          const aRaw = ansArr.find((a) => isPlainObject(a) && a.index === idx) ?? ansArr[idx];
          const aObj = isPlainObject(aRaw) ? aRaw : {};
          const opts = Array.isArray(qObj.options)
            ? qObj.options.map((o, j) => (typeof o === 'string' ? { id: o, text: o } : { id: String(o?.id || o?.label || o?.text || j), text: String(o?.text || o?.label || o?.id || '') }))
            : [];
          const ansText = typeof aRaw === 'string' ? aRaw : (typeof aObj.answer === 'string' ? aObj.answer : '');
          const matchedOpt = opts.find((o) => o.id === ansText || o.text === ansText);
          return {
            question: String((typeof qRaw === 'string' ? qRaw : qObj.question || qObj.prompt || qObj.text) || aObj.question || `Question ${idx + 1}`),
            options: opts,
            isMultiSelect: Boolean(qObj.isMultiSelect),
            selectedOptionIds: Array.isArray(aObj.selectedOptionIds) ? aObj.selectedOptionIds : (matchedOpt ? [matchedOpt.id] : []),
            writeInResponse: typeof aObj.writeInResponse === 'string' ? aObj.writeInResponse : (matchedOpt ? '' : ansText),
            skipped: Boolean(aObj.skipped)
          };
        });
      await rpc.call('HandleCascadeUserInteraction', {
        cascadeId,
        interaction: {
          trajectoryId,
          stepIndex: resolvedStepIndex,
          askQuestion: { responses, cancelled: Boolean(payload?.cancelled || answers?.cancelled) }
        }
      });
      return { ok: true, supported: true, cascadeId, stepIndex: resolvedStepIndex, trajectoryId, responses };
    },
    async listModels() {
      ensureRpc();
      const [uRes, aRes] = await Promise.allSettled([
        rpc.call('GetUserStatus', { metadata: { ...DEFAULT_RPC_METADATA } }),
        rpc.call('GetAvailableModels', { forceRefresh: false })
      ]);
      if (uRes.status === 'rejected' && aRes.status === 'rejected') {
        throw aRes.reason || uRes.reason;
      }
      const uVal = uRes.status === 'fulfilled' ? (uRes.value?.userStatus || uRes.value || {}) : {};
      const aVal = aRes.status === 'fulfilled' ? (aRes.value?.response || aRes.value || {}) : {};
      const rawDefaultId = String(
        aVal.defaultAgentModelId
        || uVal.cascadeModelConfigData?.defaultOverrideModelConfig?.modelOrAlias?.model
        || ''
      ).trim() || null;
      const byId = new Map();
      const rawModels = aVal.models;
      const entries = Array.isArray(rawModels)
        ? rawModels.map((m) => [m?.modelId || m?.model || m?.id || '', m])
        : (isPlainObject(rawModels) ? Object.entries(rawModels) : []);
      for (const [k, item] of entries) {
        if (!isPlainObject(item)) continue;
        const id = String(item.model || item.id || item.modelOrAlias?.model || item.modelId || k || '').trim();
        if (!id) continue;
        const stableModelId = String(item.modelId || (!Array.isArray(rawModels) ? k : '') || '').trim() || null;
        const rawLabel = typeof item.label === 'string' ? item.label.trim() : '';
        const rawShort = typeof item.shortName === 'string' ? item.shortName.trim() : '';
        const rawName = typeof item.displayName === 'string' ? item.displayName.trim() : (typeof item.name === 'string' ? item.name.trim() : '');
        byId.set(id, {
          ...item,
          id,
          model: id,
          modelId: stableModelId,
          label: rawLabel || rawName || rawShort,
          name: rawName || rawLabel || rawShort,
          displayName: rawName || rawLabel || rawShort,
          shortName: rawShort || rawLabel || rawName,
          thinkingLevel: item.thinkingLevel ?? null,
          tagTitle: item.tagTitle || null,
          quotaInfo: item.quotaInfo || null,
          maxTokens: Number.isFinite(Number(item.maxTokens)) ? Number(item.maxTokens) : null,
          supportsImages: Boolean(item.supportsImages),
          disabled: Boolean(item.disabled || item.enabled === false)
        });
      }
      for (const cfg of (uVal.cascadeModelConfigData?.clientModelConfigs || [])) {
        if (!isPlainObject(cfg)) continue;
        const id = String(cfg?.modelOrAlias?.model || cfg?.model || cfg?.modelId || '').trim();
        if (!id) continue;
        const cfgLabel = typeof cfg.label === 'string' ? cfg.label.trim() : '';
        const cfgDisplay = typeof cfg.displayName === 'string' ? cfg.displayName.trim() : '';
        const stableModelId = String(cfg.modelId || '').trim() || null;
        const prev = byId.get(id) || { id, model: id, modelId: stableModelId, label: '', name: '', displayName: '', disabled: false };
        byId.set(id, {
          ...prev,
          modelId: stableModelId || prev.modelId || null,
          label: cfgLabel || prev.label || cfgDisplay,
          name: prev.name || cfgDisplay || cfgLabel,
          displayName: prev.displayName || cfgDisplay || cfgLabel,
          shortName: prev.shortName || cfgLabel || cfgDisplay,
          thinkingLevel: cfg.thinkingLevel ?? prev.thinkingLevel ?? null,
          tagTitle: cfg.tagTitle || prev.tagTitle || null,
          quotaInfo: cfg.quotaInfo || prev.quotaInfo || null,
          maxTokens: Number.isFinite(Number(cfg.maxTokens)) ? Number(cfg.maxTokens) : (prev.maxTokens ?? null),
          supportsImages: Boolean(cfg.supportsImages || prev.supportsImages),
          disabled: Boolean(cfg.disabled || cfg.enabled === false || prev.disabled)
        });
      }
      const groupedModelsMap = {};
      if (isPlainObject(aVal.groupedModels)) {
        Object.assign(groupedModelsMap, aVal.groupedModels);
      }
      if (isPlainObject(uVal.cascadeModelConfigData?.groupedModels)) {
        Object.assign(groupedModelsMap, uVal.cascadeModelConfigData.groupedModels);
      }
      const rawGroups = [
        ...(Array.isArray(aVal.groupedModels) ? aVal.groupedModels : []),
        ...(Array.isArray(uVal.cascadeModelConfigData?.groupedModels) ? uVal.cascadeModelConfigData.groupedModels : []),
        ...Object.entries(groupedModelsMap).map(([groupId, g]) => ({
          groupId,
          ...(isPlainObject(g) ? g : {})
        })),
        ...(Array.isArray(aVal.agentModelSorts) ? aVal.agentModelSorts : []),
        ...(Array.isArray(uVal.cascadeModelConfigData?.agentModelSorts) ? uVal.cascadeModelConfigData.agentModelSorts : [])
      ];
      const cleaned = sanitizeModelCatalogResult({
        models: Array.from(byId.values()),
        defaultModelId: rawDefaultId,
        rawGroups
      });
      return {
        ok: true,
        defaultModelId: cleaned.defaultModelId,
        models: cleaned.models,
        modelGroups: cleaned.modelGroups,
        groups: rawGroups
      };
    }
  };
}

function applyManagedSettingsToConfig(config, managed = {}, opts = {}) {
  if (!managed || typeof managed !== 'object') return { tunnelConfigError: '', syncBackPatch: {} };
  const isInit = opts.isInit === true;
  const syncBackPatch = {};

  if (Array.isArray(managed.allowedRoots)) {
    config.allowedRoots = managed.allowedRoots.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
  }

  for (const masterKey of ORCHESTRATOR_MASTER_KEYS) {
    const settingKey = ORCHESTRATOR_SETTING_KEY_MAP[masterKey];
    if (typeof managed[settingKey] === 'string') {
      const normalized = normalizeOrchestratorThinkingLevel(managed[settingKey], '', { allowCustom: true });
      if (normalized) {
        config.orchestratorThinking[masterKey] = normalized;
      }
    }
  }
  if (typeof managed.modelSortMode === 'string') {
    config.modelSortMode = normalizeModelSortMode(managed.modelSortMode);
  }
  if (Array.isArray(managed.modelFilterOrder)) {
    config.modelFilterOrder = sanitizeModelFilterOrder(managed.modelFilterOrder);
  }

  // Bidirectional permissionLevel <-> allowRemoteWrite resolution
  const hasPermField = typeof managed.permissionLevel === 'string' && ['L0', 'L1', 'L2'].includes(managed.permissionLevel.trim().toUpperCase());
  const managedPerm = hasPermField ? normalizePermissionLevel(managed.permissionLevel) : null;
  const hasWriteField = typeof managed.allowRemoteWrite === 'boolean';

  if (isInit) {
    if (managedPerm === 'L2') {
      config.permissionLevel = 'L2';
      config.allowRemoteWrite = true;
    } else if (managedPerm === 'L1') {
      config.permissionLevel = 'L1';
      config.allowRemoteWrite = true;
    } else if (hasWriteField && managed.allowRemoteWrite === true) {
      config.permissionLevel = config.permissionLevel === 'L2' ? 'L2' : 'L1';
      config.allowRemoteWrite = true;
      syncBackPatch.permissionLevel = config.permissionLevel;
    } else if (managedPerm === 'L0') {
      config.permissionLevel = 'L0';
      config.allowRemoteWrite = false;
    }
  } else {
    const permChanged = managedPerm !== null && managedPerm !== config.permissionLevel;
    const writeChanged = hasWriteField && managed.allowRemoteWrite !== config.allowRemoteWrite;

    if (permChanged) {
      config.permissionLevel = managedPerm;
      config.allowRemoteWrite = isPermissionAtLeast(managedPerm, 'L1');
      if (hasWriteField && managed.allowRemoteWrite !== config.allowRemoteWrite) {
        syncBackPatch.allowRemoteWrite = config.allowRemoteWrite;
      }
    } else if (writeChanged) {
      config.allowRemoteWrite = managed.allowRemoteWrite;
      config.permissionLevel = config.allowRemoteWrite ? (config.permissionLevel === 'L2' ? 'L2' : 'L1') : 'L0';
      if (managedPerm !== config.permissionLevel) {
        syncBackPatch.permissionLevel = config.permissionLevel;
      }
    }
  }

  const chPatch = {};
  for (const chKey of CHANNEL_KEYS) {
    if (typeof managed[chKey] === 'boolean') {
      chPatch[chKey] = managed[chKey];
    }
  }
  if (Object.keys(chPatch).length > 0) {
    config.channels = normalizeChannelConfig({ ...config.channels, ...chPatch });
  }
  if (managed.tunnelMode === 'quick' || managed.tunnelMode === 'named') {
    config.tunnelMode = managed.tunnelMode;
  }

  let hostnameErr = '';
  let tokenErr = '';

  if (typeof managed.tunnelHostname === 'string') {
    const rawHost = managed.tunnelHostname.trim();
    if (!isInit || rawHost) {
      if (!rawHost) {
        config.tunnelHostname = '';
      } else {
        const hostCheck = validateTunnelHostname(rawHost);
        if (hostCheck.ok) {
          config.tunnelHostname = hostCheck.origin;
        } else {
          hostnameErr = hostCheck.error || 'INVALID_TUNNEL_HOSTNAME';
        }
      }
    }
  }

  if (typeof managed.tunnelToken === 'string') {
    const rawToken = managed.tunnelToken.trim();
    if (!isInit || rawToken) {
      if (!rawToken) {
        config.tunnelToken = '';
      } else {
        const tkCheck = validateCloudflareTunnelToken(rawToken);
        if (tkCheck.ok) {
          config.tunnelToken = tkCheck.token;
        } else {
          tokenErr = tkCheck.error || 'INVALID_TUNNEL_TOKEN';
        }
      }
    }
  }

  const tunnelConfigError = config.tunnelMode === 'named'
    ? (hostnameErr || tokenErr || '')
    : '';
  return { tunnelConfigError, syncBackPatch };
}

async function activate(host) {
  const loaded = host.storage.readJson('remote-config.json', null);
  const existing = (loaded.ok && loaded.data && typeof loaded.data === 'object') ? loaded.data : {};
  const managedInit = host.settings.get() || {};

  let token = (typeof existing.token === 'string' && existing.token.length >= 24)
    ? existing.token
    : '';
  let confirmSecret = (typeof existing.confirmSecret === 'string' && existing.confirmSecret.length >= 24)
    ? existing.confirmSecret
    : '';
  let changed = !loaded.ok || !token || !confirmSecret;
  if (!token) token = generatePairingToken();
  if (!confirmSecret) confirmSecret = generatePairingToken();

  const initialAllowWrite = existing.allowRemoteWrite === true;
  let config = {
    port: Number.isInteger(existing.port) && existing.port > 0 && existing.port < 65536
      ? existing.port
      : DEFAULT_REMOTE_PORT,
    token,
    confirmSecret,
    permissionLevel: normalizePermissionLevel(existing.permissionLevel, initialAllowWrite),
    allowRemoteWrite: initialAllowWrite,
    allowedRoots: Array.isArray(existing.allowedRoots)
      ? existing.allowedRoots.filter((r) => typeof r === 'string' && r.trim())
      : [],
    channels: normalizeChannelConfig(existing.channels || DEFAULT_CHANNELS),
    tunnelMode: existing.tunnelMode === 'named' ? 'named' : 'quick',
    tunnelToken: '',
    tunnelHostname: '',
    remoteDisplay: sanitizeRemoteDisplayConfig(existing.remoteDisplay || DEFAULT_REMOTE_DISPLAY_CONFIG),
    orchestratorThinking: sanitizeOrchestratorThinkingMap(existing.orchestratorThinking),
    modelSortMode: normalizeModelSortMode(existing.modelSortMode),
    modelFilterOrder: sanitizeModelFilterOrder(existing.modelFilterOrder),
    modelUsageCounts: isPlainObject(existing.modelUsageCounts) ? { ...existing.modelUsageCounts } : {},
    updatedAt: existing.updatedAt || new Date().toISOString()
  };

  if (existing.tunnelToken) {
    const tkCheck = validateCloudflareTunnelToken(existing.tunnelToken);
    if (tkCheck.ok) config.tunnelToken = tkCheck.token;
  }
  if (existing.tunnelHostname) {
    const hostCheck = validateTunnelHostname(existing.tunnelHostname);
    if (hostCheck.ok) config.tunnelHostname = hostCheck.origin;
  }

  const initApply = applyManagedSettingsToConfig(config, managedInit, { isInit: true });
  let tunnelConfigError = initApply.tunnelConfigError;

  function persistConfig() {
    config.updatedAt = new Date().toISOString();
    host.storage.writeJson('remote-config.json', config);
  }
  if (changed) persistConfig();

  let syncingSettings = false;
  async function syncManagedSettings(patch = {}) {
    if (!patch || Object.keys(patch).length === 0) return;
    syncingSettings = true;
    try {
      await host.settings.update(patch);
    } finally {
      syncingSettings = false;
    }
  }

  if (Object.keys(initApply.syncBackPatch).length > 0) {
    void syncManagedSettings(initApply.syncBackPatch).catch(() => {});
  }
  if (config.tunnelToken && !String(managedInit.tunnelToken || '').trim()) {
    void syncManagedSettings({ tunnelToken: config.tunnelToken }).catch(() => {});
  }

  const extraPanels = new Map();
  const extraActions = new Map();
  const discoveredSessionRoots = new Set();
  const standaloneRpcAdapter = createStandaloneRpcAdapter(host.rpc);
  const workspaceOrg = resolveWorkspaceOrg(host);
  const worktreeDiscovery = host?.workspaceOrg?.worktreeDiscovery
    || workspaceOrg.createWorktreeDiscoveryService();

  let server = null;
  let publishStatus = () => buildStatus();
  let authEpoch = 1;
  const proxySecret = crypto.randomBytes(32).toString('hex');
  let tailscaleHttpsUrl = '';
  let lastTailscaleCheckAt = 0;
  let tailscaleRefreshPromise = null;
  let latestPcWeb = normalizePcWebInfo(null);
  const cloudflared = new CloudflaredManager({
    onStateChange: () => publishStatus()
  });

  function getTunnelPublicOrigin() {
    if (!config.channels.cloudflare || tunnelConfigError) return '';
    const cfState = cloudflared.getState();
    if (!cfState.active || cfState.error) return '';
    const rawPublic = cfState.publicUrl || (config.tunnelMode === 'named' ? config.tunnelHostname : '');
    if (!rawPublic) return '';
    try {
      const u = new URL(rawPublic);
      return u.protocol === 'https:' ? u.origin : '';
    } catch {
      return '';
    }
  }

  function buildPcWebAllowContext(pcWebSource = latestPcWeb) {
    const localLanIps = new Set();
    const localTailscaleIps = new Set();
    try {
      const ifaces = os.networkInterfaces();
      for (const list of Object.values(ifaces)) {
        for (const info of (list || [])) {
          if (!info || info.internal || !info.address) continue;
          const addr = normalizeIpOrHost(info.address);
          if (!addr) continue;
          if (isTailscaleIp(addr)) {
            localTailscaleIps.add(addr);
          } else if (info.family === 'IPv4' || isLanIp(addr)) {
            localLanIps.add(addr);
          }
        }
      }
    } catch {}
    let tailscaleHttpsOrigin = '';
    if (tailscaleHttpsUrl) {
      try { tailscaleHttpsOrigin = new URL(tailscaleHttpsUrl).origin; } catch {}
    }
    const bonjourHost = `${os.hostname().replace(/\.local$/i, '').toLowerCase()}.local`;
    const legacyCloudflareOrigin = extractLegacyCloudflareOrigin(pcWebSource);
    return {
      tunnelPublicOrigin: getTunnelPublicOrigin(),
      legacyCloudflareOrigin,
      tailscaleHttpsOrigin,
      localTailscaleIps,
      localLanIps,
      bonjourHost
    };
  }

  function getEffectiveAllowedRoots() {
    const org = sessionOrgStore ? sessionOrgStore.loadPersistedOrg() : null;
    const persistedRoots = Array.isArray(org?.projects)
      ? org.projects.map((p) => p.rootPath).filter(Boolean)
      : [];
    const baseRoots = (Array.isArray(config.allowedRoots) && config.allowedRoots.length > 0)
      ? config.allowedRoots
      : Array.from(discoveredSessionRoots);
    const seeds = Array.from(new Set([...baseRoots, ...persistedRoots]));
    return worktreeDiscovery
      ? worktreeDiscovery.getAuthorizedWorktreeRoots(seeds)
      : seeds;
  }

  const brainDir = process.env.AGY_DADDY_BRAIN_DIR
    ? path.resolve(process.env.AGY_DADDY_BRAIN_DIR)
    : path.join(os.homedir(), '.gemini', 'antigravity', 'brain');

  const webPush = createWebPushManager({
    storage: host.storage,
    isTestMode: isTestMode()
  });

  let ptyManagerRef = null;
  const mobileWorkspace = createMobileWorkspaceService({
    getAllowedRoots: getEffectiveAllowedRoots,
    brainDir,
    worktreeDiscovery,
    hasRunningSessionInPath: async (targetPath) => {
      if (ptyManagerRef && typeof ptyManagerRef.listSessions === 'function') {
        const ptys = ptyManagerRef.listSessions({ cwd: targetPath });
        if (ptys.length > 0) return true;
      }
      try {
        const res = await safeListSessions({ limit: DEFAULT_SESSION_LIMIT });
        const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
        return sessions.some((s) => {
          const st = String(s?.status || '');
          const running = Boolean(s?.isRunning || /RUNNING|GENERATING/i.test(st) || s?.notFullyIdle);
          if (!running) return false;
          const rawWs = s.workspacePath || s.workspaceUri || '';
          const normWs = normalizeLocalPath(rawWs);
          const normTarget = normalizeLocalPath(targetPath);
          return Boolean(normWs && normTarget && workspaceOrg.isSameOrInside(normWs, normTarget));
        });
      } catch {
        return false;
      }
    }
  });

  let taskManager = null;

  const ptyManager = createPtyManager({
    allowedRoots: getEffectiveAllowedRoots,
    idleTimeoutMs: isTestMode() ? 60000 : 600000,
    worktreeDiscovery,
    onTaskEvent: ({ taskId, status }) => {
      if (!taskManager) return;
      void taskManager.listTasks(config.permissionLevel).then((listRes) => {
        const all = [...(listRes.running || []), ...(listRes.recent || [])];
        const task = all.find((t) => t.id === taskId) || { id: taskId, taskId, kind: 'pty', status };
        sseBroker.emit('task.updated', {
          runningCount: listRes.runningCount ?? 0,
          task
        });
      }).catch(() => {});
    }
  });
  ptyManagerRef = ptyManager;

  var sessionOrgStore = null;
  let sseBrokerRef = null;
  sessionOrgStore = createSessionOrgStore({
    host,
    pluginId: 'agy-daddy.remote',
    worktreeDiscovery,
    getAllowedRoots: getEffectiveAllowedRoots,
    onOrgChanged: (_org, summary) => {
      if (typeof host?.state?.set === 'function') {
        host.state.set('state:session.org@1', summary);
      }
      if (sseBrokerRef) {
        sseBrokerRef.emit('state.patch', { key: 'state:session.org@1', value: summary });
        sseBrokerRef.emit('org.updated', summary);
      }
    },
    onExternalOrgChanged: (_org, summary) => {
      if (sseBrokerRef) {
        sseBrokerRef.emit('state.patch', { key: 'state:session.org@1', value: summary });
        sseBrokerRef.emit('org.updated', summary);
      }
    }
  });
  const stopWorktreeSub = worktreeDiscovery.onWorktreeUpdated((payload) => {
    if (sseBrokerRef) {
      sseBrokerRef.emit('worktree.updated', payload);
    }
  });

  function createProjectInOrg({ name, rootPath, groupId = null, createDir = false, source = 'local', remote = null } = {}) {
    const normalizedRoot = normalizeLocalPath(rootPath);
    if (!normalizedRoot) {
      return { ok: false, statusCode: 400, error: 'INVALID_PATH' };
    }
    if (isForbiddenSystemRoot(normalizedRoot)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }

    if (createDir) {
      let cur = normalizedRoot;
      let ancestor = null;
      while (cur) {
        if (fs.existsSync(cur)) {
          ancestor = cur;
          break;
        }
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      let realAncestor = null;
      try {
        realAncestor = ancestor ? workspaceOrg.resolveRealPath(ancestor) : null;
      } catch {}
      if (!realAncestor || isForbiddenSystemRoot(realAncestor)) {
        return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
      }
      try {
        fs.mkdirSync(normalizedRoot, { recursive: true });
      } catch (err) {
        return {
          ok: false,
          statusCode: 400,
          error: 'CREATE_DIR_FAILED',
          message: err?.message || 'CREATE_DIR_FAILED'
        };
      }
    }

    let realRoot;
    try {
      realRoot = workspaceOrg.resolveRealPath(normalizedRoot);
    } catch {
      return { ok: false, statusCode: 404, error: 'ROOT_NOT_FOUND' };
    }
    if (isForbiddenSystemRoot(realRoot)) {
      return { ok: false, statusCode: 403, error: 'FORBIDDEN_SYSTEM_ROOT' };
    }
    try {
      if (!fs.statSync(realRoot).isDirectory()) {
        return { ok: false, statusCode: 400, error: 'ROOT_NOT_DIRECTORY' };
      }
    } catch {
      return { ok: false, statusCode: 404, error: 'ROOT_NOT_FOUND' };
    }

    const cleanName = typeof name === 'string' && name.trim()
      ? name.trim()
      : (path.basename(normalizedRoot) || normalizedRoot);
    const cleanSource = typeof source === 'string' && source.trim() ? source.trim() : 'local';
    const normKey = canonicalKey(normalizedRoot);
    const realKey = canonicalKey(realRoot);

    return sessionOrgStore.mutateOrgAtomically((org) => {
      let resolvedGroupId = null;
      if (groupId !== undefined && groupId !== null && groupId !== '') {
        const cleanGid = String(groupId).trim();
        if (!org.groups.some((g) => g.id === cleanGid)) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' } };
        }
        resolvedGroupId = cleanGid;
      }

      const duplicate = (org.projects || []).find((p) => {
        const pk = canonicalKey(p?.rootPath);
        return pk && (pk === normKey || pk === realKey);
      }) || null;
      if (duplicate) {
        return {
          abort: true,
          result: {
            ok: false,
            statusCode: 409,
            error: 'PROJECT_ALREADY_EXISTS',
            projectId: duplicate.id,
            project: { ...duplicate }
          }
        };
      }

      const project = sessionOrgStore.materializeProjectInOrg(org, {
        id: `proj_${crypto.randomUUID()}`,
        name: cleanName,
        rootPath: normalizedRoot,
        groupId: resolvedGroupId,
        source: cleanSource,
        remote,
        syncedFromApp: false
      });

      const containerKey = resolvedGroupId || '__ungrouped__';
      if (org.projectOrder[containerKey] && Array.isArray(org.projectOrder[containerKey].normal)) {
        org.projectOrder[containerKey].normal = [
          project.id,
          ...org.projectOrder[containerKey].normal.filter((x) => x !== project.id)
        ];
      }

      return {
        buildResult: (saved) => ({
          ok: true,
          project: { ...project, archived: false },
          revision: saved.revision,
          projects: saved.projects,
          groups: saved.groups,
          pins: saved.pins,
          defaultSessionPath: saved.defaultSessionPath || ''
        })
      };
    });
  }

  const workspaceBrowser = createWorkspaceBrowser({
    getDefaultSessionPath: () => sessionOrgStore.loadPersistedOrg().defaultSessionPath || '',
    getProjectRootPaths: () => (sessionOrgStore.loadPersistedOrg().projects || []).map((p) => p.rootPath)
  });

  const remoteProvisioner = createRemoteProjectProvisioner({
    getProjectRootPaths: () => (sessionOrgStore.loadPersistedOrg().projects || []).map((p) => p.rootPath),
    checkDuplicateProjectFn: (target) => {
      const rawRoot = typeof target === 'string' ? target : target?.rootPath;
      const k = canonicalKey(normalizeLocalPath(rawRoot));
      if (!k) return null;
      const org = sessionOrgStore.loadPersistedOrg();
      return (org.projects || []).find((p) => canonicalKey(p?.rootPath) === k) || null;
    },
    createProjectFn: (payload) => createProjectInOrg(payload),
    authorizeRootFn: (rootPath) => {
      if (rootPath) discoveredSessionRoots.add(rootPath);
      return { ok: true, rootPath };
    },
    onJobUpdated: (job) => {
      if (sseBrokerRef) {
        sseBrokerRef.emit('project.job', job);
      }
    }
  });

  async function callHarness(method, args = []) {
    if (typeof host?.services?.call === 'function') {
      try {
        const res = await host.services.call('web-harness', method, args, { optional: true });
        if (res && res.ok) {
          return res.value;
        }
        const errMsg = String(res?.error || '');
        const isMissing = res?.unavailable || errMsg.includes('SERVICE_NOT_FOUND') || errMsg.includes('SERVICE_METHOD_NOT_FOUND');
        if (res && !isMissing && res.error) {
          const err = new Error(res.error);
          err.statusCode = res.statusCode || 502;
          throw err;
        }
      } catch (err) {
        const msg = String(err?.message || '');
        if (!msg.includes('SERVICE_NOT_FOUND') && !msg.includes('SERVICE_METHOD_NOT_FOUND') && !msg.includes('unavailable')) {
          throw err;
        }
      }
    }
    if (typeof standaloneRpcAdapter[method] === 'function') {
      return await standaloneRpcAdapter[method](...args);
    }
    const err = new Error(`HARNESS_METHOD_UNSUPPORTED: ${method}`);
    err.statusCode = 501;
    throw err;
  }

  function recordDiscoveredRootsFromSessions(sessions) {
    if (!Array.isArray(sessions)) return;
    for (const s of sessions) {
      for (const rawUri of [s?.workspaceUri, s?.gitRootUri]) {
        const p = normalizeRootUriToPath(rawUri);
        if (p && !isTempBridgeWorkspace(p) && isExistingDirectory(p)) {
          discoveredSessionRoots.add(p);
        }
      }
    }
  }

  async function safeListSessions(opts = {}) {
    const requestedLimit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0
      ? Number(opts.limit)
      : DEFAULT_SESSION_LIMIT;
    const includeSubagents = Boolean(opts.includeSubagents);
    const includeArchived = Boolean(opts.includeArchived);
    const refreshWorktrees = Boolean(opts.refreshWorktrees);
    try {
      const res = await callHarness('listSessions', [{ limit: Math.max(requestedLimit, DEFAULT_SESSION_LIMIT), includeSubagents }]);
      const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
      recordDiscoveredRootsFromSessions(sessions);
      if (worktreeDiscovery) {
        await worktreeDiscovery.warmRoots(getEffectiveAllowedRoots(), {
          refresh: refreshWorktrees,
          softTimeoutMs: refreshWorktrees ? 1200 : 120
        }).catch(() => {});
      }
      const enriched = sessionOrgStore.enrichSessionsAndOrg({
        rpcSessions: sessions,
        allowedRoots: getEffectiveAllowedRoots(),
        includeSubagents,
        includeArchived,
        limit: requestedLimit
      });
      return {
        ok: true,
        version: 2,
        revision: enriched.revision,
        rpcConnected: true,
        offline: false,
        sessions: enriched.sessions,
        groups: enriched.groups,
        projects: enriched.projects,
        collapsedNodes: enriched.collapsedNodes || { projects: {}, worktrees: {} },
        pins: enriched.pins,
        groupOrder: enriched.groupOrder,
        projectOrder: enriched.projectOrder,
        sessionOrder: enriched.sessionOrder,
        worktreeTombstones: enriched.worktreeTombstones || {},
        archivedCount: enriched.archivedCount,
        ...(includeArchived ? { archivedSessions: enriched.archivedSessions } : {}),
        defaultSessionPath: enriched.defaultSessionPath
      };
    } catch {
      if (worktreeDiscovery) {
        await worktreeDiscovery.warmRoots(getEffectiveAllowedRoots(), {
          refresh: refreshWorktrees,
          softTimeoutMs: refreshWorktrees ? 1200 : 120
        }).catch(() => {});
      }
      const enriched = sessionOrgStore.enrichSessionsAndOrg({
        rpcSessions: [],
        allowedRoots: getEffectiveAllowedRoots(),
        includeSubagents,
        includeArchived,
        limit: requestedLimit
      });
      return {
        ok: true,
        version: 2,
        revision: enriched.revision,
        rpcConnected: false,
        offline: true,
        sessions: [],
        groups: enriched.groups,
        projects: enriched.projects,
        collapsedNodes: enriched.collapsedNodes || { projects: {}, worktrees: {} },
        pins: enriched.pins,
        groupOrder: enriched.groupOrder,
        projectOrder: enriched.projectOrder,
        sessionOrder: enriched.sessionOrder,
        worktreeTombstones: enriched.worktreeTombstones || {},
        archivedCount: enriched.archivedCount,
        ...(includeArchived ? { archivedSessions: enriched.archivedSessions } : {}),
        defaultSessionPath: enriched.defaultSessionPath
      };
    }
  }

  async function refreshPcWebStatus() {
    try {
      if (config.channels.tailscale) {
        await refreshTailscaleServeUrl();
      }
      const res = await host.services.call('web-harness', 'getStatus', [], { optional: true });
      if (res?.ok && res.value) {
        latestPcWeb = normalizePcWebInfo(res.value, buildPcWebAllowContext(res.value));
      } else {
        latestPcWeb = normalizePcWebInfo(null);
      }
    } catch {
      latestPcWeb = normalizePcWebInfo(null);
    }
    return latestPcWeb;
  }

  function execTailscaleServeStatus(bin) {
    return new Promise((resolve) => {
      execFile(bin, ['serve', 'status', '--json'], { timeout: 2000 }, (err, stdout) => {
        if (err) {
          resolve({ ok: false, code: err.code || '', stdout: '' });
          return;
        }
        resolve({ ok: true, code: '', stdout: String(stdout || '') });
      });
    });
  }

  async function refreshTailscaleServeUrl(force = false) {
    if (isTestMode() || !config.channels.tailscale || !server?.port) return tailscaleHttpsUrl;
    const now = Date.now();
    if (!force && now - lastTailscaleCheckAt < 15000) return tailscaleHttpsUrl;
    if (tailscaleRefreshPromise) return tailscaleRefreshPromise;

    tailscaleRefreshPromise = (async () => {
      lastTailscaleCheckAt = Date.now();
      let res = await execTailscaleServeStatus('tailscale');
      if (!res.ok && process.platform === 'darwin') {
        res = await execTailscaleServeStatus('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
      }
      const nextUrl = res.ok ? parseTailscaleServeHttpsUrl(res.stdout, server.port) : '';
      if (nextUrl !== tailscaleHttpsUrl) {
        tailscaleHttpsUrl = nextUrl;
        publishStatus();
      }
      return tailscaleHttpsUrl;
    })().finally(() => {
      tailscaleRefreshPromise = null;
    });
    return tailscaleRefreshPromise;
  }

  async function safeFetchPanel(serviceName, method = 'getMobileSnapshot') {
    try {
      const res = await host.services.call(serviceName, method, [], { optional: true });
      if (res && res.ok) {
        return { available: true, data: res.value };
      }
      return { available: false, reason: res?.error || 'SERVICE_UNAVAILABLE' };
    } catch (err) {
      return { available: false, reason: err?.message || 'SERVICE_ERROR' };
    }
  }

  async function fetchContextPanel() {
    const [snapRes, settingsRes] = await Promise.all([
      callServiceWithTimeout(host, 'context', 'getSnapshot', [], 1500),
      callServiceWithTimeout(host, 'context', 'getSettings', [], 800)
    ]);
    let data = snapRes?.ok && isPlainObject(snapRes.value) ? snapRes.value : null;
    const settings = settingsRes?.ok && isPlainObject(settingsRes.value) ? settingsRes.value : null;
    if (!data) {
      const stateVal = unwrapStateEntry(host.state?.get?.('state:context.snapshot@1'));
      if (isPlainObject(stateVal)) data = stateVal;
    }
    if (!data) {
      const mobRes = await callServiceWithTimeout(host, 'context', 'getMobileSnapshot', [], 1500);
      if (mobRes?.ok && isPlainObject(mobRes.value)) data = mobRes.value;
    }
    if (!data) {
      return { available: false, reason: snapRes?.error || 'SERVICE_UNAVAILABLE' };
    }
    const rawLoc = data.displayLocation ?? settings?.displayLocation;
    const displayLocation = rawLoc === 'composer' ? 'composer' : 'topbar';
    const rawShowSpeed = data.showSpeed ?? settings?.showSpeed;
    const showSpeed = typeof rawShowSpeed === 'boolean' ? rawShowSpeed : true;
    const compactPolicy = String(data.compactPolicy || settings?.compactPolicy || 'remind');
    const used = data.used ?? data.usedTokens ?? null;
    const budget = data.budget ?? data.maxTokens ?? null;
    const usageRatio = data.usageRatio ?? (
      data.percent !== null && data.percent !== undefined
        ? Number((Number(data.percent) / 100).toFixed(4))
        : (used !== null && Number(budget) > 0 ? Number((Number(used) / Number(budget)).toFixed(4)) : null)
    );
    const speedVal = data.speed !== undefined ? data.speed : (data.tokPerSec ?? null);
    const riskLevel = data.riskLevel ?? data.cacheCliffRisk ?? 'none';

    return {
      available: true,
      data: {
        ...data,
        hasSession: Boolean(data.hasSession ?? data.hasActiveSession),
        hasActiveSession: Boolean(data.hasActiveSession ?? data.hasSession),
        sessionTitle: String(data.sessionTitle ?? data.title ?? ''),
        modelLabel: data.modelLabel ?? data.model ?? null,
        used,
        usedTokens: data.usedTokens ?? used,
        budget,
        maxTokens: data.maxTokens ?? budget,
        usageRatio,
        riskLevel,
        cacheCliffRisk: data.cacheCliffRisk ?? riskLevel,
        displayLocation,
        showSpeed,
        compactPolicy,
        inputTokens: Number(data.inputTokens ?? 0),
        cachedTokens: Number(data.cachedTokens ?? 0),
        uncachedInput: data.uncachedInput ?? null,
        outputTokens: Number(data.outputTokens ?? 0),
        cacheHitRate: data.cacheHitRate ?? null,
        speed: speedVal,
        groups: normalizeContextGroups(data.groups),
        alerts: normalizeContextAlerts(data.alerts)
      }
    };
  }

  async function fetchUsagePanel() {
    const sumRes = await callServiceWithTimeout(host, 'usage', 'getSummary', [], 1800);
    let data = sumRes?.ok && isPlainObject(sumRes.value) ? sumRes.value : null;
    if (!data) {
      const stateVal = unwrapStateEntry(host.state?.get?.('state:usage.summary@1'));
      if (isPlainObject(stateVal)) data = stateVal;
    }
    if (!data) {
      const mobRes = await callServiceWithTimeout(host, 'usage', 'getMobileSnapshot', [], 1800);
      if (mobRes?.ok && isPlainObject(mobRes.value)) data = mobRes.value;
    }
    if (!data) {
      return { available: false, reason: sumRes?.error || 'SERVICE_UNAVAILABLE' };
    }
    const rawPeriods = isPlainObject(data.periods) ? data.periods : {};
    const roiFromPeriod = rawPeriods.roi || rawPeriods.allTime?.roi || rawPeriods.month?.roi || rawPeriods.today?.roi || null;
    const periods = {
      ...(rawPeriods.today ? { today: rawPeriods.today } : {}),
      ...(rawPeriods.month ? { month: rawPeriods.month } : {}),
      ...(rawPeriods.year ? { year: rawPeriods.year } : {}),
      ...(rawPeriods.allTime ? { allTime: rawPeriods.allTime } : {}),
      ...(roiFromPeriod ? {
        roi: {
          ...roiFromPeriod,
          savedUsd: roiFromPeriod.savedUsd ?? roiFromPeriod.effectiveSavedUsd ?? 0,
          cacheHitRatio: roiFromPeriod.cacheHitRatio ?? null
        }
      } : {})
    };
    const byModel = normalizeUsageByModel(data.byModel);
    const todayTokens = data.todayTokens ?? rawPeriods.today?.totalTokens ?? null;
    const todayCostUsd = data.todayCostUsd ?? rawPeriods.today?.totalUsd ?? null;
    const weekTokens = data.weekTokens ?? rawPeriods.month?.totalTokens ?? null;
    const weekCostUsd = data.weekCostUsd ?? rawPeriods.month?.totalUsd ?? null;

    return {
      available: true,
      data: {
        ...data,
        ...(todayTokens !== null ? { todayTokens } : {}),
        ...(todayCostUsd !== null ? { todayCostUsd } : {}),
        ...(weekTokens !== null ? { weekTokens } : {}),
        ...(weekCostUsd !== null ? { weekCostUsd } : {}),
        cacheReadTokens: Number(data.cacheReadTokens ?? 0),
        periods,
        byModel
      }
    };
  }

  async function fetchQuotaPanel() {
    const qRes = await callServiceWithTimeout(host, 'quota', 'getSnapshot', [], 1800);
    let data = qRes?.ok && isPlainObject(qRes.value) ? qRes.value : null;
    if (!data) {
      const stateVal = unwrapStateEntry(host.state?.get?.('state:quota.snapshot@1'));
      if (isPlainObject(stateVal)) data = stateVal;
    }
    if (!data) {
      const mobRes = await callServiceWithTimeout(host, 'quota', 'getMobileSnapshot', [], 1800);
      if (mobRes?.ok && isPlainObject(mobRes.value)) data = mobRes.value;
    }
    if (!data) {
      return { available: false, reason: qRes?.error || 'SERVICE_UNAVAILABLE' };
    }
    const rawPools = Array.isArray(data.pools) ? data.pools : [];
    const pools = rawPools.map((p, idx) => ({
      id: p?.id || `pool-${idx}`,
      title: String(p?.title || p?.name || `Pool ${idx + 1}`),
      ...(Array.isArray(p?.models) ? { models: p.models } : {}),
      tightestFraction: typeof p?.tightestFraction === 'number' ? p.tightestFraction : null,
      ...(p?.tightestPercentText ? { tightestPercentText: p.tightestPercentText } : {}),
      fiveHourBucket: normalizeQuotaBucket(p?.fiveHourBucket),
      weeklyBucket: normalizeQuotaBucket(p?.weeklyBucket)
    }));
    const ultraSubTier = data.ultraSubTier ?? null;
    const planTier = String(data.planTier || (ultraSubTier ? 'ultra' : 'free'));
    const quotaMultiplier = data.quotaMultiplier ?? null;

    return {
      available: true,
      data: {
        ...data,
        planTier,
        ultraSubTier,
        quotaMultiplier,
        tightestFraction: data.tightestFraction ?? null,
        tightestPercentText: data.tightestPercentText ?? null,
        pools
      }
    };
  }

  async function collectAggregatedSnapshot() {
    const [contextPanel, usagePanel, quotaPanel, taskListRes] = await Promise.all([
      fetchContextPanel(),
      fetchUsagePanel(),
      fetchQuotaPanel(),
      taskManager ? taskManager.listTasks(config.permissionLevel).catch(() => null) : Promise.resolve(null)
    ]);

    const panels = {
      context: contextPanel,
      usage: usagePanel,
      quota: quotaPanel
    };

    for (const [panelId, def] of extraPanels.entries()) {
      if (def.service) {
        panels[panelId] = await safeFetchPanel(def.service, def.method || 'getMobileSnapshot');
      }
    }

    return {
      ok: true,
      timestamp: Date.now(),
      permissionLevel: config.permissionLevel,
      writeEnabled: config.allowRemoteWrite === true,
      channels: { ...config.channels },
      display: { ...config.remoteDisplay },
      runningTasksCount: taskListRes?.runningCount ?? 0,
      panels,
      actions: Array.from(extraActions.values()).map((a) => ({
        id: a.id,
        title: a.title || a.id,
        requiresWrite: a.requiresWrite !== false
      }))
    };
  }

  const sseBroker = createSseBroker({
    pollIntervalMs: isTestMode() ? 80 : 400,
    activePollIntervalMs: isTestMode() ? 45 : 70,
    metaPollIntervalMs: isTestMode() ? 100 : 1200,
    burstWindowMs: 2500,
    heartbeatIntervalMs: 15000,
    async getDelta(sessionId, _offset) {
      try {
        const res = await callHarness('getSessionDelta', [sessionId, {}]);
        if (!res || typeof res !== 'object') return null;
        const status = res.status || 'CASCADE_RUN_STATUS_IDLE';
        return {
          cascadeId: sessionId,
          sessionId,
          status,
          totalSteps: res.totalSteps,
          events: stripPairingSecrets(res.events || []),
          nextOffset: res.stepOffset,
          stepOffset: res.stepOffset,
          session: {
            cascadeId: sessionId,
            status,
            numTotalSteps: res.totalSteps
          }
        };
      } catch {
        return null;
      }
    },
    async listSessions() {
      const res = await safeListSessions({ limit: DEFAULT_SESSION_LIMIT });
      const normalizeBrokerStatus = (raw) => {
        const up = String(raw || '').trim().toUpperCase();
        if (!up) return 'IDLE';
        if (up.includes('RUNNING') || up.includes('GENERATING')) return 'RUNNING';
        if (up.includes('PENDING') || up.includes('WAITING')) return 'PENDING';
        if (up.includes('ERROR') || up.includes('FAIL')) return 'ERROR';
        if (up.includes('IDLE')) return 'IDLE';
        if (up.includes('DONE')) return 'DONE';
        return up;
      };
      return stripPairingSecrets((res.sessions || []).map((s) => ({
        ...s,
        status: normalizeBrokerStatus(s.status)
      })));
    },
    async getTelemetry() {
      const snap = await collectAggregatedSnapshot();
      return stripPairingSecrets({
        panels: snap.panels,
        runningTasksCount: snap.runningTasksCount ?? 0
      });
    },
    async dispatchMessage(cascadeId, item) {
      return await callHarness('sendMessage', [cascadeId, item]);
    },
    async onAttentionTransition(payload) {
      if (!payload) return;
      if (payload.needsAttention || payload.status === 'PENDING' || payload.status === 'ERROR' || payload.status === 'DONE') {
        await webPush.sendNotification({
          type: 'attention',
          sessionId: payload.cascadeId,
          title: payload.title || 'Agy-Daddy Remote',
          body: payload.attentionReason || `会话状态变更: ${payload.status}`,
          status: payload.status
        });
      }
    }
  });
  sseBrokerRef = sseBroker;

  function buildChannelUrls() {
    const localUrl = server?.getLocalUrl() || '';
    const urls = {};
    if (localUrl && config.channels.loopback) {
      urls.loopback = `${localUrl}/?t=${config.token}`;
    }
    const needLan = Boolean(server?.port && config.channels.lan);
    const needTailscale = Boolean(server?.port && config.channels.tailscale);
    if (needTailscale && tailscaleHttpsUrl) {
      urls.tailscale = `${tailscaleHttpsUrl}/?t=${config.token}`;
    }
    if (needLan || needTailscale) {
      const ifaces = os.networkInterfaces();
      let lanPreferred = '';
      let lanSecondary = '';
      let lanFallback = '';
      let tsIpv6Fallback = '';
      for (const [ifName, list] of Object.entries(ifaces)) {
        const isVirtual = isVirtualInterfaceName(ifName);
        const isPhysical = /^(?:en\d+|wlan\d+|eth\d+|wi-fi)$/i.test(ifName);
        for (const info of (list || [])) {
          if (info.internal || !info.address) continue;
          if (info.family === 'IPv4') {
            if (needTailscale && !urls.tailscale && isTailscaleIp(info.address)) {
              urls.tailscale = `http://${info.address}:${server.port}/?t=${config.token}`;
            } else if (needLan && isLanIp(info.address)) {
              const cand = `http://${info.address}:${server.port}/?t=${config.token}`;
              if (isPhysical && !lanPreferred) lanPreferred = cand;
              else if (!isVirtual && !lanSecondary) lanSecondary = cand;
              else if (!lanFallback) lanFallback = cand;
            } else if (needLan && !lanFallback && !isVirtual && !isTailscaleIp(info.address)) {
              lanFallback = `http://${info.address}:${server.port}/?t=${config.token}`;
            }
          } else if (info.family === 'IPv6' && needTailscale && !tsIpv6Fallback && isTailscaleIp(info.address)) {
            tsIpv6Fallback = `http://[${info.address}]:${server.port}/?t=${config.token}`;
          }
        }
      }
      if (needLan) {
        const pickedLan = lanPreferred || lanSecondary || lanFallback;
        if (pickedLan) urls.lan = pickedLan;
      }
      if (needTailscale && !urls.tailscale && tsIpv6Fallback) urls.tailscale = tsIpv6Fallback;
    }
    if (server?.port && config.channels.bonjour) {
      const hostName = os.hostname().replace(/\.local$/i, '');
      urls.bonjour = `http://${hostName}.local:${server.port}/?t=${config.token}`;
    }
    if (config.channels.cloudflare) {
      const cfState = cloudflared.getState();
      const pubUrl = cfState.publicUrl || (config.tunnelMode === 'named' ? config.tunnelHostname : '');
      if (pubUrl) urls.cloudflare = `${pubUrl}/?t=${config.token}`;
    }
    return urls;
  }

  function resolvePrimaryChannel(urls = buildChannelUrls(), channels = config.channels) {
    for (const key of PRIMARY_CHANNEL_ORDER) {
      if (urls[key]) {
        return { primaryChannel: key, primaryUrl: urls[key] };
      }
    }
    for (const key of PRIMARY_CHANNEL_ORDER) {
      if (channels?.[key]) {
        return { primaryChannel: key, primaryUrl: urls.loopback || server?.getLocalUrl() || '' };
      }
    }
    return { primaryChannel: 'offline', primaryUrl: '' };
  }

  function buildStatus() {
    const boundPort = server?.port || null;
    const localUrl = server?.getLocalUrl() || '';
    const tracked = server ? server.getTrackedDevices() : { devices: [], clients: [] };
    const urls = buildChannelUrls();
    const { primaryChannel, primaryUrl } = resolvePrimaryChannel(urls, config.channels);
    return {
      running: Boolean(server && boundPort),
      host: server?.host || '127.0.0.1',
      port: boundPort,
      configuredPort: config.port,
      url: localUrl,
      primaryChannel,
      primaryUrl,
      permissionLevel: config.permissionLevel,
      allowRemoteWrite: config.allowRemoteWrite === true,
      allowedRoots: getEffectiveAllowedRoots(),
      channels: { ...config.channels },
      tunnelMode: config.tunnelMode,
      tunnelHostname: config.tunnelHostname,
      hasTunnelToken: Boolean(config.tunnelToken),
      tunnelConfigError,
      tunnelState: cloudflared.getState(),
      remoteDisplay: { ...config.remoteDisplay },
      devicesCount: tracked.devices.length,
      clientsCount: tracked.clients.length,
      tokenPreview: `${config.token.slice(0, 6)}...${config.token.slice(-4)}`,
      pcWeb: {
        available: latestPcWeb.available,
        running: latestPcWeb.running,
        port: latestPcWeb.port,
        url: latestPcWeb.url,
        primaryChannel: latestPcWeb.primaryChannel,
        primaryUrl: latestPcWeb.primaryUrl,
        cloudflareState: latestPcWeb.cloudflareState
      },
      registeredPanels: Array.from(extraPanels.keys()),
      registeredActions: Array.from(extraActions.keys()),
      updatedAt: Date.now()
    };
  }

  publishStatus = function publishStatusImpl() {
    const st = buildStatus();
    host.state.set('state:remote.status@1', st);
    return st;
  };

  taskManager = createTaskManager({
    ptyManager,
    listSessions: (opts) => safeListSessions(opts),
    getAllowedRoots: getEffectiveAllowedRoots,
    worktreeDiscovery,
    getSessionSteps: async (cascadeId) => {
      const detail = await callHarness('getSessionDetail', [cascadeId]);
      return Array.isArray(detail?.events) ? detail.events : [];
    },
    cancelSession: (cascadeId) => callHarness('cancelSession', [cascadeId]),
    approveStep: (cascadeId, seq, decision) => callHarness('approveStep', [cascadeId, seq, decision, {}]),
    callRpc: (method, params) => host.rpc?.call?.(method, params)
  });

  async function dispatchCompactForSession(rawSessionId = '') {
    let sessionId = String(rawSessionId || '').trim();
    if (sessionId === 'null' || sessionId === 'undefined') sessionId = '';
    if (!sessionId) {
      const sessRes = await safeListSessions({ limit: 20 });
      const list = Array.isArray(sessRes?.sessions) ? sessRes.sessions : [];
      const active = list.find((s) => String(s?.status || '').toUpperCase().includes('RUNNING')) || list[0];
      sessionId = String(active?.cascadeId || '').trim();
    }
    if (!sessionId) {
      return {
        ok: false,
        statusCode: 400,
        error: 'SESSION_REQUIRED',
        message: '请先选择一个会话再执行 /compact'
      };
    }
    await callHarness('sendMessage', [sessionId, { cascadeId: sessionId, text: '/compact', dispatchMode: 'queue' }]);
    sseBroker.triggerPoll(sessionId);
    return {
      ok: true,
      action: 'compact',
      sessionId,
      dispatched: true
    };
  }

  async function handleRemoteAction(body = {}) {
    if (config.allowRemoteWrite !== true) {
      return { ok: false, error: 'REMOTE_WRITE_DISABLED' };
    }
    const actionId = String(body.action || '').trim();
    if (!actionId) {
      return { ok: false, error: 'MISSING_ACTION' };
    }
    if (extraActions.has(actionId)) {
      const def = extraActions.get(actionId);
      const res = await host.services.call(def.service, def.method, [body.payload || {}], { optional: true });
      if (!res?.ok) {
        return { ok: false, action: actionId, error: res?.error || 'ACTION_FAILED' };
      }
      return { ok: true, action: actionId, result: res.value };
    }
    if (actionId === 'compact') {
      const reqSessionId = body.sessionId || body.cascadeId || body.payload?.sessionId || body.payload?.cascadeId || '';
      return await dispatchCompactForSession(reqSessionId);
    }
    return { ok: false, error: 'UNKNOWN_ACTION', action: actionId };
  }

  function buildLandingChannelEntries(providedToken = '', reqCtx = {}) {
    if (!providedToken) {
      return {
        tunnelMode: config.tunnelMode,
        writeEnabled: config.allowRemoteWrite === true,
        entries: []
      };
    }
    if (config.channels.tailscale && !isTestMode()) {
      void refreshTailscaleServeUrl();
    }
    const urls = buildChannelUrls();
    const specs = [
      { key: 'lan', label: '局域网 (Wi-Fi)', subtitle: '同 Wi-Fi 直连低延迟访问' },
      { key: 'bonjour', label: 'Bonjour (.local)', subtitle: '局域网 mDNS 零 IP 访问' },
      { key: 'tailscale', label: 'Tailscale 私网', subtitle: '加密点对点虚拟私网' },
      { key: 'cloudflare', label: 'Cloudflare Tunnel', subtitle: '公网 HTTPS 穿透（移动网络可用）' },
      { key: 'loopback', label: '本机回环 (127.0.0.1)', subtitle: '当前宿主本机调试入口' }
    ];
    const entries = [];
    for (const sp of specs) {
      if (!config.channels[sp.key]) continue;
      if (sp.key === 'loopback' && reqCtx?.channel === 'cloudflare') continue;
      if (sp.key === 'cloudflare') {
        const cfBaseUrl = String(
          cloudflared.getState().publicUrl ||
          (config.tunnelMode === 'named' ? config.tunnelHostname : '') ||
          ''
        ).replace(/\/+$/, '');
        const cfPub = urls.cloudflare || cfBaseUrl;
        let displayHost = reqCtx?.channel === 'cloudflare'
          ? String(reqCtx?.req?.headers?.host || '').trim()
          : '';
        if (!displayHost && cfPub) {
          try { displayHost = new URL(cfPub).host; } catch {}
        }
        const useAbsCf = reqCtx?.channel !== 'cloudflare' && Boolean(cfBaseUrl);
        entries.push({
          key: 'cloudflare',
          label: sp.label,
          subtitle: sp.subtitle,
          displayHost,
          enterUrl: useAbsCf
            ? `${cfBaseUrl}/?t=${encodeURIComponent(providedToken)}&enter=1`
            : `/?t=${encodeURIComponent(providedToken)}&enter=1`,
          probeUrl: useAbsCf ? `${cfBaseUrl}/api/ping` : '/api/ping',
          fallbackProbeUrl: '',
          httpEntryUrl: '',
          isCurrent: reqCtx?.channel === 'cloudflare'
        });
        continue;
      }
      const rawUrl = urls[sp.key];
      if (!rawUrl) continue;
      try {
        const u = new URL(rawUrl);
        entries.push({
          key: sp.key,
          label: sp.label,
          subtitle: sp.subtitle,
          displayHost: u.host,
          enterUrl: rawUrl,
          probeUrl: `${u.origin}/api/ping`,
          fallbackProbeUrl: `${u.origin}/api/ping-gif`,
          httpEntryUrl: u.protocol === 'http:' ? `${u.origin}/entry?t=${encodeURIComponent(providedToken)}` : '',
          isCurrent: reqCtx?.channel === sp.key
        });
      } catch {}
    }
    return {
      tunnelMode: config.tunnelMode,
      writeEnabled: config.allowRemoteWrite === true,
      entries
    };
  }

  function buildCleanChannelEntries(reqCtx = {}) {
    if (config.channels.tailscale && !isTestMode()) {
      void refreshTailscaleServeUrl();
    }
    const urls = buildChannelUrls();
    const req = reqCtx?.req;
    const channel = reqCtx?.channel || 'loopback';
    const isHttpsReq =
      channel === 'cloudflare' ||
      String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase().includes('https') ||
      Boolean(req?.socket?.encrypted) ||
      String(req?.headers?.origin || '').startsWith('https://');
    const specs = [
      { key: 'lan', label: '局域网 (Wi-Fi)' },
      { key: 'bonjour', label: 'Bonjour (.local)' },
      { key: 'tailscale', label: 'Tailscale 私网' },
      { key: 'cloudflare', label: 'Cloudflare Tunnel' },
      { key: 'loopback', label: '本机回环 (127.0.0.1)' }
    ];
    const entries = [];
    for (const sp of specs) {
      if (!config.channels[sp.key]) continue;
      if (sp.key === 'cloudflare') {
        const cfBaseUrl = String(
          cloudflared.getState().publicUrl ||
          (config.tunnelMode === 'named' ? config.tunnelHostname : '') ||
          ''
        ).replace(/\/+$/, '');
        const rawCf = urls.cloudflare || cfBaseUrl;
        let origin = '';
        let displayHost = channel === 'cloudflare' ? String(req?.headers?.host || '').trim() : '';
        if (rawCf) {
          try {
            const u = new URL(rawCf);
            origin = u.origin;
            if (!displayHost) displayHost = u.host;
          } catch {}
        }
        if (!origin && displayHost) {
          origin = `https://${displayHost}`;
        }
        if (!origin) continue;
        entries.push({
          key: 'cloudflare',
          label: sp.label,
          origin,
          protocol: 'https:',
          displayHost: displayHost || origin.replace(/^https?:\/\//, ''),
          probeUrl: `${origin}/api/ping`,
          fallbackProbeUrl: `${origin}/api/ping-gif`,
          isCurrent: channel === 'cloudflare',
          requiresTicketRedirect: false
        });
        continue;
      }
      const rawUrl = urls[sp.key];
      if (!rawUrl) continue;
      try {
        const u = new URL(rawUrl);
        entries.push({
          key: sp.key,
          label: sp.label,
          origin: u.origin,
          protocol: u.protocol === 'https:' ? 'https:' : 'http:',
          displayHost: u.host,
          probeUrl: `${u.origin}/api/ping`,
          fallbackProbeUrl: `${u.origin}/api/ping-gif`,
          isCurrent: channel === sp.key,
          requiresTicketRedirect: isHttpsReq && u.protocol === 'http:' && sp.key !== 'loopback'
        });
      } catch {}
    }
    const cfState = cloudflared.getState();
    const tunnelState = cfState.error
      ? 'error'
      : (cfState.active ? (cfState.publicUrl || config.tunnelMode === 'named' ? 'running' : 'starting') : 'stopped');
    const hostHdr = String(req?.headers?.host || '').trim();
    const currentOrigin = hostHdr
      ? `${isHttpsReq ? 'https' : 'http'}://${hostHdr}`
      : (entries.find((e) => e.isCurrent)?.origin || server?.getLocalUrl() || '');
    return {
      ok: true,
      currentChannel: channel,
      currentOrigin,
      tunnelMode: config.tunnelMode,
      tunnelState,
      entries
    };
  }

  let telemetryDebounceTimer = null;
  function broadcastTelemetryNow() {
    return collectAggregatedSnapshot().then((snap) => {
      const payload = stripPairingSecrets({
        panels: snap.panels,
        runningTasksCount: snap.runningTasksCount ?? 0
      });
      sseBroker.emitTelemetryPatch(payload);
      return snap;
    }).catch(() => null);
  }

  function scheduleTelemetryBroadcast() {
    if (telemetryDebounceTimer) {
      clearTimeout(telemetryDebounceTimer);
    }
    telemetryDebounceTimer = setTimeout(() => {
      telemetryDebounceTimer = null;
      void broadcastTelemetryNow();
    }, 120);
    if (typeof telemetryDebounceTimer.unref === 'function') {
      telemetryDebounceTimer.unref();
    }
  }

  const v1Handlers = {
    async getBootstrap({ channel, permissionLevel }) {
      const [snap, sessionsRes, modelsRes] = await Promise.all([
        collectAggregatedSnapshot(),
        safeListSessions({ limit: DEFAULT_SESSION_LIMIT }),
        callHarness('listModels', []).catch(() => null)
      ]);
      const rootItems = mobileWorkspace.listRoots().roots.map((r) => ({
        uri: `file://${r.path}`,
        path: r.path,
        name: r.name,
        isGitRepo: r.isGitRepo
      }));
      const cleanModels = sanitizeModelCatalogResult({
        models: Array.isArray(modelsRes?.models) ? modelsRes.models : [],
        defaultModelId: modelsRes?.defaultModelId || '',
        rawGroups: Array.isArray(modelsRes?.groups) ? modelsRes.groups : [],
        modelTree: modelsRes?.tree || null
      });
      return {
        ok: true,
        channel,
        permissionLevel,
        permissionInfo: {
          level: permissionLevel,
          canRead: true,
          canChat: isPermissionAtLeast(permissionLevel, 'L1'),
          canWriteFsGitPty: isPermissionAtLeast(permissionLevel, 'L2'),
          hostOnlyElevation: true,
          levels: [
            { level: 'L0', label: '只读观察', description: '仅查看会话、文件、Diff 与监控面板' },
            { level: 'L1', label: '对话与审批', description: '可发送消息、队列插队、审批步骤与回答提问' },
            { level: 'L2', label: '工作区与终端', description: '允许文件写入、Git 提交推送与 PTY 终端（需宿主机授权）' }
          ]
        },
        writeEnabled: isPermissionAtLeast(permissionLevel, 'L1'),
        rpcConnected: Boolean(sessionsRes.rpcConnected || modelsRes?.ok),
        models: cleanModels.models,
        modelGroups: cleanModels.modelGroups,
        ...(modelsRes?.tree ? { modelTree: modelsRes.tree } : {}),
        defaultModelId: cleanModels.defaultModelId || undefined,
        orchestratorThinking: { ...config.orchestratorThinking },
        modelPreferences: {
          sortMode: config.modelSortMode,
          filterOrder: [...config.modelFilterOrder],
          usageCounts: { ...config.modelUsageCounts }
        },
        workspaces: rootItems,
        version: 2,
        revision: sessionsRes.revision ?? 0,
        groups: sessionsRes.groups || [],
        projects: sessionsRes.projects || [],
        collapsedNodes: sessionsRes.collapsedNodes || { projects: {}, worktrees: {} },
        pins: sessionsRes.pins || { sessions: [], projects: [], groups: [] },
        groupOrder: sessionsRes.groupOrder || { pinned: [], normal: [] },
        projectOrder: sessionsRes.projectOrder || {},
        sessionOrder: sessionsRes.sessionOrder || {},
        worktreeTombstones: sessionsRes.worktreeTombstones || {},
        archivedCount: sessionsRes.archivedCount ?? 0,
        defaultSessionPath: sessionsRes.defaultSessionPath,
        vapidPublicKey: webPush.getPublicKey(),
        voiceSupported: false,
        runningTasksCount: snap.runningTasksCount ?? 0,
        telemetry: { panels: snap.panels, runningTasksCount: snap.runningTasksCount ?? 0, channel }
      };
    },
    async listSessions(opts) {
      return await safeListSessions(opts);
    },
    async getSessionOrg(opts = {}) {
      const includeArchived = Boolean(opts?.includeArchived);
      const refreshWorktrees = Boolean(opts?.refreshWorktrees);
      const res = await safeListSessions({ limit: DEFAULT_SESSION_LIMIT, includeArchived, refreshWorktrees });
      return {
        ok: true,
        version: 2,
        revision: res.revision ?? 0,
        groups: res.groups || [],
        projects: res.projects || [],
        collapsedNodes: res.collapsedNodes || { projects: {}, worktrees: {} },
        pins: res.pins || { sessions: [], projects: [], groups: [] },
        groupOrder: res.groupOrder || { pinned: [], normal: [] },
        projectOrder: res.projectOrder || {},
        sessionOrder: res.sessionOrder || {},
        worktreeTombstones: res.worktreeTombstones || {},
        archivedCount: res.archivedCount ?? 0,
        ...(includeArchived ? { archivedSessions: res.archivedSessions || {} } : {}),
        defaultSessionPath: res.defaultSessionPath
      };
    },
    async togglePin(body) {
      return sessionOrgStore.togglePin(body);
    },
    async mutateGroup(body) {
      return sessionOrgStore.mutateGroup(body);
    },
    async setNodeCollapsed(body) {
      return sessionOrgStore.setNodeCollapsed(body);
    },
    async reorderOrg(body) {
      return sessionOrgStore.reorderOrg(body);
    },
    async assignSessionProject(id, body = {}) {
      const cleanId = String(id || '').trim();
      if (!cleanId) return { ok: false, statusCode: 400, error: 'INVALID_CASCADE_ID' };
      const targetPid = body?.projectId ? String(body.projectId).trim() : null;
      const targetWtId = typeof body?.worktreeId === 'string' && body.worktreeId.trim() ? body.worktreeId.trim() : null;
      let existingSession = null;
      try {
        const listRes = await safeListSessions({ limit: DEFAULT_SESSION_LIMIT, includeArchived: true });
        existingSession = Array.isArray(listRes?.sessions) ? listRes.sessions.find((s) => s?.cascadeId === cleanId) : null;
      } catch {}
      return sessionOrgStore.mutateOrgAtomically((org) => {
        const binding = org.sessionWorktreeBindings?.[cleanId] || null;
        const sourceWtId = binding?.worktreeId || existingSession?.worktreeId || null;
        if (targetWtId && sourceWtId && targetWtId !== sourceWtId) {
          return { abort: true, result: { ok: false, statusCode: 409, error: 'CROSS_CONTAINER_SESSION_MOVE_FORBIDDEN' } };
        }
        if (targetPid === null) {
          if (sourceWtId) {
            return { abort: true, result: { ok: false, statusCode: 409, error: 'CROSS_CONTAINER_SESSION_MOVE_FORBIDDEN' } };
          }
          org.sessionProjectOverrides[cleanId] = null;
          return { buildResult: (saved) => ({ ok: true, cascadeId: cleanId, projectId: null, revision: saved.revision }) };
        }
        const targetProj = (org.projects || []).find((p) => p.id === targetPid || (Array.isArray(p.aliases) && p.aliases.includes(targetPid)));
        if (!targetProj) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'PROJECT_NOT_FOUND' } };
        }
        if (sourceWtId && targetProj.rootPath) {
          const boundPath = normalizeLocalPath(binding?.workspacePath || existingSession?.worktreePath || existingSession?.workspaceUri || '');
          const normTarget = normalizeLocalPath(targetProj.rootPath);
          let sameRepo = Boolean(boundPath && normTarget && canonicalKey(boundPath) === canonicalKey(normTarget));
          if (!sameRepo && worktreeDiscovery && boundPath && normTarget) {
            const snapA = worktreeDiscovery.getCachedSnapshot(boundPath);
            const snapB = worktreeDiscovery.getCachedSnapshot(normTarget);
            if (snapA?.isGitRepo && snapB?.isGitRepo && canonicalKey(snapA.repoRoot) === canonicalKey(snapB.repoRoot)) {
              sameRepo = true;
            }
          }
          if (!sameRepo) {
            return { abort: true, result: { ok: false, statusCode: 409, error: 'CROSS_CONTAINER_SESSION_MOVE_FORBIDDEN' } };
          }
        }
        org.sessionProjectOverrides[cleanId] = targetProj.id;
        return { buildResult: (saved) => ({ ok: true, cascadeId: cleanId, projectId: targetProj.id, revision: saved.revision }) };
      });
    },
    async archiveSession(id, body = {}) {
      if (typeof body.archived !== 'boolean') {
        return { ok: false, statusCode: 400, error: 'INVALID_ARCHIVE_FLAG' };
      }
      let stepCount = Number.isFinite(Number(body.stepCount)) ? Number(body.stepCount) : 0;
      let isRunning = Boolean(body.isRunning);
      let projectId = body.projectId || null;
      let projectName = body.projectName || null;
      let titleSnapshot = typeof body.titleSnapshot === 'string' ? body.titleSnapshot : '';
      if (body.archived && !body.skipLookup) {
        try {
          const listRes = await safeListSessions({ limit: DEFAULT_SESSION_LIMIT, includeArchived: true });
          const found = Array.isArray(listRes?.sessions) ? listRes.sessions.find((s) => s?.cascadeId === id) : null;
          if (found) {
            stepCount = Number.isFinite(Number(found.stepCount)) ? Number(found.stepCount) : stepCount;
            isRunning = /RUNNING|GENERATING/i.test(String(found.status || '')) || Boolean(found.notFullyIdle);
            projectId = projectId || found.projectId || null;
            projectName = projectName || found.projectName || null;
            titleSnapshot = titleSnapshot || found.title || '';
          }
        } catch {}
      }
      return sessionOrgStore.archiveSession(id, {
        archived: body.archived,
        stepCount,
        isRunning,
        projectId,
        projectName,
        titleSnapshot
      });
    },
    async deleteSession(id, { mode = 'auto' } = {}) {
      const cleanMode = String(mode || 'auto').trim().toLowerCase();
      if (cleanMode !== 'auto' && cleanMode !== 'local_hide') {
        return { ok: false, statusCode: 400, error: 'INVALID_DELETE_MODE' };
      }
      if (cleanMode === 'local_hide') {
        return sessionOrgStore.deleteSessionOrgRecord(id, { mode: 'local_tombstone' });
      }
      try {
        try {
          const listRes = await safeListSessions({ limit: DEFAULT_SESSION_LIMIT, includeArchived: true });
          const cur = Array.isArray(listRes?.sessions) ? listRes.sessions.find((s) => s?.cascadeId === id) : null;
          if (cur && (/RUNNING|GENERATING/i.test(String(cur.status || '')) || cur.notFullyIdle)) {
            await callHarness('cancelSession', [id]).catch(() => {});
          }
        } catch {}
        await callHarness('deleteSession', [id]);
        return sessionOrgStore.deleteSessionOrgRecord(id, { mode: 'host_deleted' });
      } catch (err) {
        const raw = `${err?.code || ''} ${err?.message || ''}`.trim();
        let reasonCode = 'RPC_ERROR';
        if (/RPC_UNAVAILABLE|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|fetch failed|not connected|no hub/i.test(raw)) {
          reasonCode = 'RPC_OFFLINE';
        } else if (/RPC_METHOD_BLOCKED|RPC_PERMISSION_DENIED|UNIMPLEMENTED|404|501|HARNESS_METHOD_UNSUPPORTED|not supported/i.test(raw)) {
          reasonCode = 'RPC_UNSUPPORTED';
        }
        return {
          ok: false,
          statusCode: 503,
          error: 'HOST_DELETE_UNAVAILABLE',
          reasonCode,
          canFallbackLocalHide: true,
          message: err?.message || 'Host session delete unavailable'
        };
      }
    },
    async listProjects() {
      const res = await safeListSessions({ limit: DEFAULT_SESSION_LIMIT });
      return {
        ok: true,
        version: 2,
        revision: res.revision ?? 0,
        projects: res.projects || [],
        groups: res.groups || [],
        pins: res.pins || { sessions: [], projects: [], groups: [] },
        defaultSessionPath: res.defaultSessionPath
      };
    },
    async createProject(body = {}) {
      return createProjectInOrg(body);
    },
    async updateProject(id, patch = {}) {
      const cleanId = String(id || '').trim();
      if (!cleanId || !isPlainObject(patch)) {
        return { ok: false, statusCode: 400, error: 'INVALID_PATCH' };
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'name') && (!String(patch.name || '').trim())) {
        return { ok: false, statusCode: 400, error: 'INVALID_PROJECT_NAME' };
      }
      return sessionOrgStore.mutateOrgAtomically((org) => {
        let proj = org.projects.find((p) => p.id === cleanId || (Array.isArray(p.aliases) && p.aliases.includes(cleanId))) || null;
        if (!proj) {
          const wsUri = patch.workspaceUri || patch.rootPath;
          if (!wsUri) {
            return { abort: true, result: { ok: false, statusCode: 404, error: 'PROJECT_NOT_FOUND' } };
          }
          proj = sessionOrgStore.materializeProjectInOrg(org, {
            id: cleanId,
            rootPath: patch.rootPath,
            workspaceUri: patch.workspaceUri,
            syncedFromApp: cleanId.startsWith('app:'),
            source: cleanId.startsWith('app:') ? 'app' : 'local'
          });
        }
        if (!proj) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'PROJECT_NOT_FOUND' } };
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
          proj.name = String(patch.name).trim();
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'groupId')) {
          const nextGid = patch.groupId ? String(patch.groupId).trim() : null;
          if (nextGid && !org.groups.some((g) => g.id === nextGid)) {
            return { abort: true, result: { ok: false, statusCode: 404, error: 'GROUP_NOT_FOUND' } };
          }
          proj.groupId = nextGid;
          if (nextGid) org.projectGroupMap[proj.id] = nextGid;
          else delete org.projectGroupMap[proj.id];
          for (const g of org.groups) {
            g.projectIds = g.projectIds.filter((pid) => pid !== proj.id);
            if (nextGid && g.id === nextGid) g.projectIds.push(proj.id);
          }
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'pinned')) {
          const shouldPin = Boolean(patch.pinned);
          if (shouldPin && !org.pins.projects.includes(proj.id)) {
            org.pins.projects.push(proj.id);
            org.pinTimestamps.projects[proj.id] = new Date().toISOString();
          } else if (!shouldPin) {
            org.pins.projects = org.pins.projects.filter((pid) => pid !== proj.id);
            delete org.pinTimestamps.projects[proj.id];
          }
        }
        proj.updatedAt = new Date().toISOString();
        return {
          buildResult: (saved) => ({
            ok: true,
            project: { ...proj, pinned: saved.pins.projects.includes(proj.id) },
            revision: saved.revision
          })
        };
      });
    },
    async deleteProject(id) {
      const cleanId = String(id || '').trim();
      return sessionOrgStore.mutateOrgAtomically((org) => {
        const idx = org.projects.findIndex((p) => p.id === cleanId || (Array.isArray(p.aliases) && p.aliases.includes(cleanId)));
        if (idx < 0) {
          return { abort: true, result: { ok: false, statusCode: 404, error: 'PROJECT_NOT_FOUND' } };
        }
        const targetId = org.projects[idx].id;
        const removeIds = new Set([cleanId, targetId, ...(org.projects[idx].aliases || [])]);
        org.projects.splice(idx, 1);
        org.pins.projects = org.pins.projects.filter((pid) => !removeIds.has(pid));
        for (const rid of removeIds) {
          delete org.pinTimestamps.projects[rid];
          delete org.projectGroupMap[rid];
          delete org.sessionOrder[rid];
        }
        for (const g of org.groups) {
          g.projectIds = g.projectIds.filter((pid) => !removeIds.has(pid));
        }
        for (const ord of Object.values(org.projectOrder)) {
          if (!ord) continue;
          ord.pinned = (ord.pinned || []).filter((pid) => !removeIds.has(pid));
          ord.normal = (ord.normal || []).filter((pid) => !removeIds.has(pid));
        }
        for (const [cid, pid] of Object.entries(org.sessionProjectOverrides)) {
          if (removeIds.has(pid)) delete org.sessionProjectOverrides[cid];
        }
        return {
          buildResult: (saved) => ({ ok: true, id: targetId, deleted: true, revision: saved.revision })
        };
      });
    },
    async createSession(body = {}) {
      const target = await workspaceOrg.resolveAndValidateSessionTarget(body, {
        getAllowedRoots: getEffectiveAllowedRoots,
        worktreeDiscovery,
        resolveProjectById: (cleanId) => {
          const org = sessionOrgStore.loadPersistedOrg();
          return (org.projects || []).find((p) => p.id === cleanId || (Array.isArray(p.aliases) && p.aliases.includes(cleanId))) || null;
        },
        defaultSessionPath: body?.standalone === false ? '' : (sessionOrgStore.loadPersistedOrg().defaultSessionPath || '')
      });
      if (!target.ok) {
        return { ok: false, statusCode: target.statusCode, error: target.error };
      }
      const nextBody = {
        ...(isPlainObject(body) ? body : {}),
        ...(target.workspaceUri ? { workspaceUri: target.workspaceUri } : {})
      };
      const created = await callHarness('createSession', [nextBody]);
      if (created?.ok !== false && created?.cascadeId) {
        if (target.worktreeId || target.workspacePath) {
          sessionOrgStore.bindSessionWorkspace(created.cascadeId, {
            worktreeId: target.worktreeId,
            workspacePath: target.workspacePath,
            workspaceUri: target.workspaceUri
          });
        }
        if (target.projectId) {
          sessionOrgStore.mutateOrgAtomically((org) => {
            org.sessionProjectOverrides[created.cascadeId] = target.projectId;
            return { buildResult: (saved) => saved };
          });
        }
      }
      return {
        ...created,
        ...(target.workspaceUri ? { workspaceUri: target.workspaceUri } : {}),
        ...(target.worktreeId ? { worktreeId: target.worktreeId } : {}),
        ...(target.projectId ? { projectId: target.projectId, projectName: target.projectName } : {})
      };
    },
    async getSessionDetail(id) {
      return await callHarness('getSessionDetail', [id]);
    },
    async listQueue(id) {
      return {
        ok: true,
        cascadeId: id,
        queue: sseBroker.listQueue(id)
      };
    },
    async removeQueuedMessage(id, queueId) {
      return sseBroker.removeQueuedMessage(id, queueId);
    },
    async steerQueuedMessage(id, queueId) {
      return await sseBroker.steerQueuedMessage(id, queueId);
    },
    async updateOrchestratorThinking(body = {}) {
      const patch = {};
      if (isPlainObject(body.map)) {
        for (const [k, v] of Object.entries(body.map)) {
          const mk = normalizeOrchestratorMasterKey(k);
          const lvl = normalizeOrchestratorThinkingLevel(v, '', { allowCustom: true });
          if (mk && lvl) {
            config.orchestratorThinking[mk] = lvl;
            patch[ORCHESTRATOR_SETTING_KEY_MAP[mk]] = lvl;
          }
        }
      } else {
        const mk = normalizeOrchestratorMasterKey(body.master);
        const lvl = normalizeOrchestratorThinkingLevel(body.thinkingLevel, '', { allowCustom: true });
        if (!mk || !lvl) {
          return { ok: false, statusCode: 400, error: 'INVALID_ORCHESTRATOR_THINKING_PARAMS' };
        }
        config.orchestratorThinking[mk] = lvl;
        patch[ORCHESTRATOR_SETTING_KEY_MAP[mk]] = lvl;
      }
      persistConfig();
      await syncManagedSettings(patch);
      return {
        ok: true,
        orchestratorThinking: { ...config.orchestratorThinking }
      };
    },
    async sendMessage(id, body) {
      if (typeof body?.modelId === 'string' && body.modelId.trim()) {
        const mid = body.modelId.trim();
        config.modelUsageCounts[mid] = (Number(config.modelUsageCounts[mid]) || 0) + 1;
        if (typeof body?.groupId === 'string' && body.groupId.trim()) {
          const gid = body.groupId.trim();
          config.modelUsageCounts[gid] = (Number(config.modelUsageCounts[gid]) || 0) + 1;
        }
        persistConfig();
      }
      const dispatchMode = String(body?.dispatchMode || 'steer').toLowerCase();
      if (dispatchMode === 'queue') {
        const sessRes = await safeListSessions({ limit: DEFAULT_SESSION_LIMIT });
        const cur = (sessRes.sessions || []).find((s) => s.cascadeId === id);
        const upperSt = String(cur?.status || '').toUpperCase();
        const isRunning = upperSt.includes('RUNNING') || upperSt.includes('GENERATING');
        if (isRunning) {
          const enq = sseBroker.enqueueMessage(id, {
            text: body.text || '',
            modelId: body.modelId,
            mode: body.mode,
            images: body.images,
            dispatchMode: 'queue'
          });
          return { ok: enq.ok, queued: true, queueId: enq.queueId, item: enq.item, queue: enq.queue };
        }
      }
      const res = await callHarness('sendMessage', [id, body]);
      if (!res || res.ok !== false) {
        sessionOrgStore.reconcileSessionsLifecycle([], { forceUnarchiveIds: [id] });
      }
      sseBroker.triggerPoll(id);
      return { ...(isPlainObject(res) ? res : { ok: true }), queued: false };
    },
    async cancelSession(id) {
      const res = await callHarness('cancelSession', [id]);
      sseBroker.triggerPoll(id);
      return res;
    },
    async approveStep(id, seq, decision, payload) {
      const res = await callHarness('approveStep', [id, seq, decision, payload]);
      sseBroker.triggerPoll(id);
      return res;
    },
    async answerStep(id, seq, answers, payload) {
      const res = await callHarness('answerQuestion', [id, seq, answers, payload]);
      sseBroker.triggerPoll(id);
      return res;
    },
    async getComposerPresets() {
      const [quickRes, freqRes, settingsRes] = await Promise.all([
        host.services.call('composer-node', 'listQuickPrompts', [], { optional: true }).catch(() => null),
        host.services.call('composer-node', 'listFrequentPrompts', [], { optional: true }).catch(() => null),
        host.services.call('composer-node', 'getSettings', [], { optional: true }).catch(() => null)
      ]);
      const stateSnap = unwrapStateEntry(host.state?.get?.('state:composer.settings@1'));
      const rawSettings = (settingsRes?.ok && isPlainObject(settingsRes.value))
        ? settingsRes.value
        : (isPlainObject(stateSnap?.settings) ? stateSnap.settings : {});
      const available = Boolean(quickRes?.ok || freqRes?.ok || settingsRes?.ok || stateSnap?.available);
      const settings = {
        showQuickBar: rawSettings.showQuickBar !== false,
        ghostSuggest: rawSettings.ghostSuggest !== false,
        showPromptOptimizer: rawSettings.showPromptOptimizer !== false,
        ...(Number.isFinite(Number(rawSettings.autoCompactThresholdTokens))
          ? { autoCompactThresholdTokens: Number(rawSettings.autoCompactThresholdTokens) }
          : {})
      };
      const quickSource = quickRes?.ok && quickRes.value
        ? quickRes.value
        : (isPlainObject(stateSnap) ? stateSnap : null);
      const quickList = quickSource
        ? [
            ...(Array.isArray(quickSource.builtins) ? quickSource.builtins.filter((b) => b && b.enabled !== false) : []),
            ...(Array.isArray(quickSource.custom) ? quickSource.custom : [])
          ]
            .map((it, idx) => sanitizePresetItem(it, 'quick', idx))
            .filter((it) => Boolean(it) && !isRedundantPlanPreset(it))
            .map((it) => ({ ...it, text: it.prompt }))
        : [];
      const freqRaw = freqRes?.ok && freqRes.value
        ? (Array.isArray(freqRes.value.presets) ? freqRes.value.presets : (Array.isArray(freqRes.value.items) ? freqRes.value.items : []))
        : [];
      const freqList = freqRaw
        .map((it, idx) => sanitizePresetItem(it, 'frequent', idx))
        .filter((it) => Boolean(it) && !isRedundantPlanPreset(it))
        .map((it) => ({ ...it, text: it.prompt }));
      return {
        ok: true,
        available,
        settings,
        presets: [...quickList, ...freqList],
        quickPrompts: quickList,
        frequentPrompts: freqList
      };
    },
    async optimizePrompt(text, opts = {}) {
      const clean = String(text || '').trim();
      if (!clean) {
        return { ok: false, statusCode: 400, error: 'EMPTY_PROMPT', message: '先输入提示词草稿，再点击优化' };
      }
      const res = await host.services.call('composer-node', 'optimizePrompt', [text, opts], { optional: true, timeoutMs: 50000 }).catch(() => null);
      if (!res?.ok) {
        return localOptimizePrompt(text);
      }
      const val = res.value || {};
      if (val.ok === false) {
        if (val.error === 'SLASH_ONLY' || val.error === 'EMPTY_PROMPT') {
          return { ...val, statusCode: 400 };
        }
        return localOptimizePrompt(text);
      }
      const outText = val.optimized || val.optimizedText || val.text || text;
      return {
        ...val,
        ok: true,
        source: val.source === 'local-fallback' ? 'local-fallback' : 'plugin',
        optimizedText: outText,
        text: outText
      };
    },
    async compactSession(id) {
      const cleanId = String(id || '').trim();
      if (!cleanId || cleanId === 'null' || cleanId === 'undefined') {
        return { ok: false, statusCode: 400, error: 'SESSION_REQUIRED', message: '请先选择一个会话再执行 /compact' };
      }
      return await dispatchCompactForSession(cleanId);
    },
    async listTasks({ permissionLevel, sessionId, project } = {}) {
      return await taskManager.listTasks(permissionLevel, { sessionId, project });
    },
    async getTaskDetail(taskId, { permissionLevel }) {
      return await taskManager.getTaskDetail(taskId, permissionLevel);
    },
    async stopTask(taskId, { permissionLevel }) {
      return await taskManager.stopTask(taskId, permissionLevel);
    },
    async getChannels({ req, channel }) {
      return buildCleanChannelEntries({ req, channel });
    },
    async getLocale() {
      let entry = null;
      const hostLocale = unwrapStateEntry(host.state?.get?.('state:host.locale@1'));
      entry = normalizeLocaleWhitelist(hostLocale);
      if (!entry) {
        const zhCnState = unwrapStateEntry(host.state?.get?.('state:zh-cn.lang@1'));
        entry = normalizeLocaleWhitelist(zhCnState);
      }
      if (!entry) {
        const cfgRes = await callServiceWithTimeout(host, 'zh-cn', 'getConfig', [], 800);
        if (cfgRes?.ok) {
          entry = normalizeLocaleWhitelist(cfgRes.value);
        }
      }
      return {
        ok: true,
        locale: (entry || SUPPORTED_LOCALES[0]).bcp47,
        supportedLocales: SUPPORTED_LOCALES.map((l) => ({ ...l }))
      };
    },
    async setLocale(body = {}, { permissionLevel } = {}) {
      const raw = body?.locale ?? body?.lang;
      const entry = normalizeLocaleWhitelist(raw);
      if (!entry || !SUPPORTED_LOCALE_SET.has(entry.bcp47)) {
        return { ok: false, statusCode: 400, error: 'INVALID_LOCALE' };
      }
      if (!isPermissionAtLeast(permissionLevel, 'L1')) {
        return {
          ok: true,
          locale: entry.bcp47,
          syncedToHost: false,
          localOnly: true
        };
      }
      const stateVal = { bcp47: entry.bcp47, locale: entry.bcp47, lang: entry.code };
      host.state?.set?.('state:host.locale@1', stateVal);
      await callServiceWithTimeout(host, 'zh-cn', 'setLang', [entry.code], 800);
      sseBroker.emit('state.patch', {
        key: 'state:host.locale@1',
        value: stateVal
      });
      return {
        ok: true,
        locale: entry.bcp47,
        syncedToHost: true,
        localOnly: false
      };
    },
    async getDiagnostics() {
      const [sessionsRes, snap] = await Promise.all([
        safeListSessions({ limit: 1 }),
        collectAggregatedSnapshot()
      ]);
      const hasWebHarness = Boolean(host.services?.has?.('web-harness'));
      const ctxOk = Boolean(snap.panels?.context?.available);
      const usageOk = Boolean(snap.panels?.usage?.available);
      const quotaOk = Boolean(snap.panels?.quota?.available);
      const cfState = cloudflared.getState();
      const roots = getEffectiveAllowedRoots();
      const readableRoots = roots.filter((r) => isExistingDirectory(r));

      const checks = [
        {
          id: 'rpc',
          label: 'Antigravity RPC',
          status: sessionsRes.rpcConnected ? 'ok' : 'fail',
          detail: sessionsRes.rpcConnected ? 'Connected' : 'RPC unreachable'
        },
        {
          id: 'harness',
          label: 'Session Harness',
          status: hasWebHarness ? 'ok' : (sessionsRes.rpcConnected ? 'warn' : 'fail'),
          detail: hasWebHarness ? 'web-harness online' : 'Using standalone RPC adapter'
        },
        {
          id: 'telemetry_services',
          label: 'Telemetry Services',
          status: (ctxOk && usageOk && quotaOk) ? 'ok' : ((ctxOk || usageOk || quotaOk) ? 'warn' : 'fail'),
          detail: `context:${ctxOk ? 'ok' : 'off'} usage:${usageOk ? 'ok' : 'off'} quota:${quotaOk ? 'ok' : 'off'}`
        },
        {
          id: 'channels_tunnel',
          label: 'Channels & Tunnel',
          status: tunnelConfigError || cfState.error ? 'fail' : (config.channels.cloudflare && !cfState.active ? 'warn' : 'ok'),
          detail: tunnelConfigError || cfState.error || (cfState.publicUrl ? `Tunnel active (${cfState.mode})` : 'Local/LAN channels active')
        },
        {
          id: 'workspace_roots',
          label: 'Workspace Roots',
          status: readableRoots.length > 0 ? 'ok' : 'warn',
          detail: `${readableRoots.length}/${roots.length} readable root(s)`
        },
        {
          id: 'push_sse',
          label: 'SSE & Web Push',
          status: sseBroker ? 'ok' : 'warn',
          detail: webPush?.getPublicKey?.() ? 'SSE + VAPID Push ready' : 'SSE ready'
        }
      ];
      const summary = {
        okCount: checks.filter((c) => c.status === 'ok').length,
        warnCount: checks.filter((c) => c.status === 'warn').length,
        failCount: checks.filter((c) => c.status === 'fail').length
      };
      return {
        ok: true,
        mode: 'readonly-safe',
        hostControlAvailable: false,
        checkedAt: Date.now(),
        summary,
        checks
      };
    },
    async listCommands({ permissionLevel }) {
      return {
        ok: true,
        commands: SAFE_MOBILE_COMMANDS.map((c) => ({
          id: c.id,
          minLevel: c.minLevel,
          title: c.title,
          allowed: isPermissionAtLeast(permissionLevel, c.minLevel)
        }))
      };
    },
    async runCommand(body = {}, { permissionLevel } = {}) {
      const commandId = String(body?.commandId || body?.id || '').trim();
      const spec = SAFE_MOBILE_COMMAND_MAP.get(commandId);
      if (!spec) {
        return { ok: false, statusCode: 403, error: 'COMMAND_FORBIDDEN_ON_MOBILE', commandId };
      }
      if (!isPermissionAtLeast(permissionLevel, spec.minLevel)) {
        return {
          ok: false,
          statusCode: 403,
          error: 'PERMISSION_DENIED',
          required: spec.minLevel,
          current: permissionLevel
        };
      }
      if (commandId === 'remote.status') {
        const st = buildStatus();
        return { ok: true, commandId, result: st };
      }
      if (commandId === 'remote.check-cloudflared') {
        const bin = detectCloudflaredBinary();
        return {
          ok: true,
          commandId,
          result: {
            ok: true,
            found: Boolean(bin.found),
            path: bin.path,
            tunnelState: cloudflared.getState()
          }
        };
      }
      if (commandId === 'context.rescan') {
        const res = await callServiceWithTimeout(host, 'context', 'rescan', [body?.payload || {}], 3000);
        await broadcastTelemetryNow();
        return { ok: true, commandId, result: res?.ok ? res.value : { ok: false, error: res?.error || 'CONTEXT_UNAVAILABLE' } };
      }
      if (commandId === 'quota.refresh') {
        const res = await callServiceWithTimeout(host, 'quota', 'refresh', [body?.payload || {}], 3000);
        await broadcastTelemetryNow();
        return { ok: true, commandId, result: res?.ok ? res.value : { ok: false, error: res?.error || 'QUOTA_UNAVAILABLE' } };
      }
      return { ok: false, statusCode: 403, error: 'COMMAND_FORBIDDEN_ON_MOBILE', commandId };
    }
  };

  const bindHost = (config.channels.lan || config.channels.tailscale || config.channels.bonjour) ? '0.0.0.0' : '127.0.0.1';
  const listenPort = isTestMode() ? 0 : config.port;
  server = new MobileRemoteServer({
    host: bindHost,
    port: listenPort,
    getToken: () => config.token,
    getConfirmSecret: () => config.confirmSecret,
    getPermissionLevel: () => config.permissionLevel,
    getSnapshot: collectAggregatedSnapshot,
    getChannels: () => config.channels,
    getChannelEntries: buildLandingChannelEntries,
    getTunnelHostname: () => config.tunnelHostname,
    getProxySecret: () => proxySecret,
    getPcWebProxyTarget: () => latestPcWeb,
    isWriteEnabled: () => config.allowRemoteWrite === true,
    onAction: handleRemoteAction,
    v1Handlers,
    sseBroker,
    ptyManager,
    taskManager,
    webPush,
    mobileWorkspace,
    workspaceBrowser,
    remoteProvisioner
  });

  if (
    config.channels.loopback !== false ||
    config.channels.lan === true ||
    config.channels.tailscale === true ||
    config.channels.bonjour === true ||
    config.channels.cloudflare === true
  ) {
    await server.start();
  }

  if (config.channels.tailscale && !isTestMode()) {
    void refreshTailscaleServeUrl(true);
  }

  async function reconcileServerBindHost() {
    if (isTestMode() || !server) return;
    const wantHost = (config.channels.lan || config.channels.tailscale || config.channels.bonjour) ? '0.0.0.0' : '127.0.0.1';
    if (server.host === wantHost) return;
    try {
      await server.stop();
      server.host = wantHost;
      await server.start();
      publishStatus();
    } catch {}
  }

  async function syncTunnelWithConfig() {
    if (isTestMode()) return;
    if (!config.channels.cloudflare) {
      await cloudflared.stop();
      return;
    }
    if (!server?.port) return;
    if (config.tunnelMode === 'named') {
      if (!config.tunnelToken) {
        await cloudflared.stop();
        if (!tunnelConfigError) tunnelConfigError = 'MISSING_TUNNEL_TOKEN';
        return;
      }
      await cloudflared.startNamedTunnel(config.tunnelToken, config.tunnelHostname, { dryRun: false });
      return;
    }
    await cloudflared.startQuickTunnel(server.port, { dryRun: false });
  }

  if (config.channels.cloudflare && !isTestMode()) {
    void syncTunnelWithConfig().then(() => { publishStatus(); }).catch(() => {});
  }

  const stopSettingsSub = host.settings.onChange((nextValues) => {
    if (syncingSettings) return;
    const prevCf = config.channels.cloudflare;
    const prevMode = config.tunnelMode;
    const prevHost = config.tunnelHostname;
    const prevTok = config.tunnelToken;
    const applied = applyManagedSettingsToConfig(config, nextValues, { isInit: false });
    tunnelConfigError = applied.tunnelConfigError;
    persistConfig();
    publishStatus();
    if (Object.keys(applied.syncBackPatch).length > 0) {
      void syncManagedSettings(applied.syncBackPatch).catch(() => {});
    }
    if (!isTestMode()) {
      void reconcileServerBindHost();
      if (config.channels.tailscale) {
        void refreshTailscaleServeUrl(true);
      } else if (tailscaleHttpsUrl) {
        tailscaleHttpsUrl = '';
        publishStatus();
      }
    }
    const cfRelevantChanged =
      prevCf !== config.channels.cloudflare ||
      (config.channels.cloudflare && (
        prevMode !== config.tunnelMode ||
        prevHost !== config.tunnelHostname ||
        prevTok !== config.tunnelToken
      ));
    if (cfRelevantChanged && !isTestMode()) {
      void syncTunnelWithConfig().then(() => { publishStatus(); }).catch(() => {});
    }
  });

  const serviceMethods = {
    getStatus() {
      return buildStatus();
    },
    getPairingToken() {
      return config.token;
    },
    getConfirmSecret() {
      return config.confirmSecret;
    },
    getSharedAuthBundle() {
      const cfState = cloudflared.getState();
      return {
        ok: true,
        available: true,
        running: Boolean(server && server.port),
        port: server?.port || null,
        authEpoch,
        token: config.token,
        confirmSecret: config.confirmSecret,
        proxySecret,
        cloudflareEnabled: Boolean(config.channels.cloudflare),
        tunnelMode: config.tunnelMode,
        tunnelPublicOrigin: getTunnelPublicOrigin(),
        tunnelState: {
          active: Boolean(cfState.active),
          mode: cfState.mode,
          publicUrl: cfState.publicUrl || '',
          error: cfState.error || null
        },
        tunnelConfigError: tunnelConfigError || cfState.error || ''
      };
    },
    getPairingBundle() {
      const urls = buildChannelUrls();
      const { primaryChannel, primaryUrl } = resolvePrimaryChannel(urls, config.channels);
      return {
        ok: true,
        primaryChannel,
        primaryUrl,
        urls,
        qrSvg: primaryUrl ? generateQrSvg(primaryUrl) : '',
        qrAscii: primaryUrl ? generateQrAscii(primaryUrl) : '',
        channels: { ...config.channels },
        permissionLevel: config.permissionLevel,
        tunnelState: cloudflared.getState(),
        pcWeb: {
          available: latestPcWeb.available,
          running: latestPcWeb.running,
          port: latestPcWeb.port,
          url: latestPcWeb.url,
          pairingUrl: latestPcWeb.pairingUrl,
          primaryChannel: latestPcWeb.primaryChannel,
          primaryUrl: latestPcWeb.primaryUrl,
          cloudflareState: latestPcWeb.cloudflareState
        }
      };
    },
    async getPcWebStatus() {
      const info = await refreshPcWebStatus();
      return { ok: true, ...info };
    },
    async openPcWeb() {
      const info = await refreshPcWebStatus();
      const targetUrl = info.pairingUrl || info.url;
      const allowCtx = buildPcWebAllowContext(info);
      if (!info.running || !isAllowedPcWebUrl(targetUrl, allowCtx)) {
        return { ok: false, error: 'PC_WEB_UNAVAILABLE' };
      }
      return openLocalBrowserUrl(targetUrl, allowCtx);
    },
    async syncPcWebChannels() {
      const remoteChannels = {};
      for (const ch of ['lan', 'tailscale', 'bonjour', 'cloudflare']) {
        if (config.channels[ch] === true) {
          remoteChannels[ch] = true;
        }
      }
      if (Object.keys(remoteChannels).length === 0) {
        const pcWeb = await refreshPcWebStatus();
        const status = publishStatus();
        return { ok: false, error: 'NO_NON_LOOPBACK_CHANNEL', pcWeb, status };
      }
      try {
        const res = await host.services.call('web-harness', 'syncChannels', [remoteChannels], { optional: true });
        if (!res?.ok) {
          return {
            ok: false,
            error: res?.unavailable ? 'PC_WEB_UNAVAILABLE' : (res?.error || 'SYNC_PC_WEB_FAILED')
          };
        }
        const pcWeb = await refreshPcWebStatus();
        const status = publishStatus();
        const pairing = serviceMethods.getPairingBundle();
        return {
          ok: true,
          syncedChannels: Object.keys(remoteChannels),
          pcWeb,
          status,
          pairing
        };
      } catch (err) {
        return { ok: false, error: String(err?.message || 'SYNC_PC_WEB_FAILED') };
      }
    },
    getDevices() {
      return server ? server.getTrackedDevices() : { devices: [], clients: [] };
    },
    kickDevices() {
      server?.clearTrackedDevices();
      return serviceMethods.rotateToken();
    },
    async probeChannels() {
      const urls = buildChannelUrls();
      const results = [];
      for (const ch of CHANNEL_KEYS) {
        results.push({
          channel: ch,
          enabled: Boolean(config.channels[ch]),
          url: urls[ch] || null,
          latencyMs: urls[ch] ? 1 : null
        });
      }
      return { ok: true, results };
    },
    async startTunnel(opts = {}) {
      if (!server?.port) return { ok: false, error: 'SERVER_NOT_RUNNING' };
      const mode = opts.mode || config.tunnelMode;
      const dryRun = opts.dryRun !== undefined ? Boolean(opts.dryRun) : isTestMode();
      let res;
      if (mode === 'named') {
        if (!config.tunnelToken) return { ok: false, error: 'MISSING_TUNNEL_TOKEN' };
        res = await cloudflared.startNamedTunnel(config.tunnelToken, config.tunnelHostname, { dryRun });
      } else {
        res = await cloudflared.startQuickTunnel(server.port, { dryRun });
      }
      publishStatus();
      return res;
    },
    async stopTunnel() {
      await cloudflared.stop();
      return publishStatus();
    },
    async getSnapshot() {
      return await collectAggregatedSnapshot();
    },
    rotateToken() {
      authEpoch += 1;
      config.token = generatePairingToken();
      config.confirmSecret = generatePairingToken();
      persistConfig();
      const status = publishStatus();
      return { ok: true, token: config.token, authEpoch, status };
    },
    async setAllowRemoteWrite(enabled) {
      config.allowRemoteWrite = enabled === true;
      config.permissionLevel = config.allowRemoteWrite
        ? (config.permissionLevel === 'L2' ? 'L2' : 'L1')
        : 'L0';
      persistConfig();
      await syncManagedSettings({
        allowRemoteWrite: config.allowRemoteWrite,
        permissionLevel: config.permissionLevel
      });
      const status = publishStatus();
      return { ok: true, allowRemoteWrite: config.allowRemoteWrite, permissionLevel: config.permissionLevel, status };
    },
    async setPermissionLevel(level) {
      config.permissionLevel = normalizePermissionLevel(level);
      config.allowRemoteWrite = isPermissionAtLeast(config.permissionLevel, 'L1');
      persistConfig();
      await syncManagedSettings({
        permissionLevel: config.permissionLevel,
        allowRemoteWrite: config.allowRemoteWrite
      });
      const status = publishStatus();
      return { ok: true, permissionLevel: config.permissionLevel, allowRemoteWrite: config.allowRemoteWrite, status };
    },
    async setChannelConfig(patch = {}) {
      const managedPatch = {};
      if (patch.channels && typeof patch.channels === 'object') {
        config.channels = normalizeChannelConfig({ ...config.channels, ...patch.channels });
        for (const chKey of CHANNEL_KEYS) {
          if (typeof patch.channels[chKey] === 'boolean') {
            managedPatch[chKey] = config.channels[chKey];
          }
        }
      }
      for (const chKey of CHANNEL_KEYS) {
        if (typeof patch[chKey] === 'boolean') {
          config.channels[chKey] = patch[chKey];
          managedPatch[chKey] = patch[chKey];
        }
      }
      if (patch.tunnelMode === 'quick' || patch.tunnelMode === 'named') {
        config.tunnelMode = patch.tunnelMode;
        managedPatch.tunnelMode = patch.tunnelMode;
      }
      if (typeof patch.permissionLevel === 'string') {
        config.permissionLevel = normalizePermissionLevel(patch.permissionLevel);
        config.allowRemoteWrite = isPermissionAtLeast(config.permissionLevel, 'L1');
        managedPatch.permissionLevel = config.permissionLevel;
        managedPatch.allowRemoteWrite = config.allowRemoteWrite;
      } else if (typeof patch.allowRemoteWrite === 'boolean') {
        config.allowRemoteWrite = patch.allowRemoteWrite;
        config.permissionLevel = config.allowRemoteWrite ? (config.permissionLevel === 'L2' ? 'L2' : 'L1') : 'L0';
        managedPatch.allowRemoteWrite = config.allowRemoteWrite;
        managedPatch.permissionLevel = config.permissionLevel;
      }
      if (Array.isArray(patch.allowedRoots)) {
        config.allowedRoots = patch.allowedRoots.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
        managedPatch.allowedRoots = config.allowedRoots;
      }
      if (typeof patch.tunnelToken === 'string') {
        if (!patch.tunnelToken.trim()) {
          config.tunnelToken = '';
          managedPatch.tunnelToken = '';
        } else {
          const check = validateCloudflareTunnelToken(patch.tunnelToken);
          if (!check.ok) return { ok: false, error: check.error };
          config.tunnelToken = check.token;
          managedPatch.tunnelToken = check.token;
        }
      }
      if (typeof patch.tunnelHostname === 'string') {
        if (!patch.tunnelHostname.trim()) {
          config.tunnelHostname = '';
          managedPatch.tunnelHostname = '';
        } else {
          const check = validateTunnelHostname(patch.tunnelHostname);
          if (!check.ok) return { ok: false, error: check.error };
          config.tunnelHostname = check.origin;
          managedPatch.tunnelHostname = check.origin;
        }
      }
      tunnelConfigError = '';
      if (patch.remoteDisplay && typeof patch.remoteDisplay === 'object') {
        config.remoteDisplay = sanitizeRemoteDisplayConfig({ ...config.remoteDisplay, ...patch.remoteDisplay });
      }
      persistConfig();
      await syncManagedSettings(managedPatch);
      const status = publishStatus();
      return { ok: true, status };
    },
    registerPanel(def = {}) {
      const id = String(def.id || '').trim();
      const service = String(def.service || '').trim();
      if (!id || !service) return { ok: false, error: 'INVALID_PANEL_DEF' };
      extraPanels.set(id, { id, service, method: String(def.method || 'getMobileSnapshot') });
      publishStatus();
      return { ok: true, id };
    },
    unregisterPanel(id) {
      const removed = extraPanels.delete(String(id || '').trim());
      if (removed) publishStatus();
      return { ok: removed };
    },
    listPanels() {
      return ['context', 'usage', 'quota', ...Array.from(extraPanels.keys())];
    },
    registerAction(def = {}) {
      const id = String(def.id || '').trim();
      const service = String(def.service || '').trim();
      const method = String(def.method || '').trim();
      if (!id || !service || !method) return { ok: false, error: 'INVALID_ACTION_DEF' };
      extraActions.set(id, { id, title: def.title || id, requiresWrite: def.requiresWrite !== false, service, method });
      publishStatus();
      return { ok: true, id };
    },
    unregisterAction(id) {
      const removed = extraActions.delete(String(id || '').trim());
      if (removed) publishStatus();
      return { ok: removed };
    },
    listActions() {
      return Array.from(extraActions.keys());
    },
    emitSseEvent(eventName, data, opts = {}) {
      return sseBroker.emit(eventName, stripPairingSecrets(data), opts);
    },
    async browseAllowedRoot(opts = {}) {
      const valueRoots = Array.isArray(opts?.values?.allowedRoots) ? opts.values.allowedRoots : [];
      const currentRoots = valueRoots.length > 0
        ? valueRoots
        : (Array.isArray(config.allowedRoots) ? config.allowedRoots : []);
      const lastRoot = currentRoots.length > 0 ? String(currentRoots[currentRoots.length - 1] || '').trim() : '';
      let defaultDir = typeof opts.defaultDir === 'string' && opts.defaultDir.trim()
        ? opts.defaultDir.trim()
        : '';
      if (!defaultDir && lastRoot) {
        defaultDir = fs.existsSync(lastRoot) ? lastRoot : path.dirname(lastRoot);
      }
      return openAllowedRootDirectoryDialog({
        defaultDir: defaultDir || os.homedir(),
        title: opts.title || '选择允许访问的工作区根目录',
        dirPickerFn: opts.dirPickerFn
      });
    },
    async listModelsForSettings() {
      const modelsRes = await callHarness('listModels', []).catch(() => null);
      const cleanModels = sanitizeModelCatalogResult({
        models: Array.isArray(modelsRes?.models) ? modelsRes.models : [],
        defaultModelId: modelsRes?.defaultModelId || '',
        rawGroups: Array.isArray(modelsRes?.groups) ? modelsRes.groups : []
      });
      const items = [];
      for (const g of cleanModels.modelGroups) {
        const label = g.isOrchestrator ? '编排模型 (Orchestrator)' : g.label;
        const category = g.isOrchestrator ? 'orchestrator' : inferModelProviderCategory(`${g.label} ${g.defaultModelId || ''}`);
        const freq = (g.modelIds || []).reduce(
          (acc, mid) => acc + (Number(config.modelUsageCounts[mid]) || 0),
          Number(config.modelUsageCounts[g.id]) || 0
        );
        items.push({
          id: g.id,
          label,
          category,
          description: g.isOrchestrator
            ? '支持 Carbon / Argon / Neon / Opus 5.5 主控编排'
            : (g.variants?.length > 1 ? `${g.variants.length} 档思考等级` : '单模型'),
          frequency: freq
        });
      }
      if (items.length === 0) {
        items.push(
          { id: 'family:gemini-4-neon', label: 'Gemini 4 Neon', category: 'gemini', description: 'Gemini 旗舰推理模型', frequency: Number(config.modelUsageCounts['family:gemini-4-neon']) || 0 },
          { id: 'family:claude-opus-5-5', label: 'Claude Opus 5.5', category: 'claude', description: 'Claude 高阶推理模型', frequency: Number(config.modelUsageCounts['family:claude-opus-5-5']) || 0 },
          { id: 'orchestrator', label: '编排模型 (Orchestrator)', category: 'orchestrator', description: '支持 Carbon / Argon / Neon / Opus 5.5 主控编排', frequency: Number(config.modelUsageCounts.orchestrator) || 0 }
        );
      }
      return { ok: true, items };
    },
    async listOrchestratorThinkingLevelsForSettings(opts = {}) {
      const modelsRes = await callHarness('listModels', []).catch(() => null);
      const fieldKeyOrMaster = opts?.fieldKey || opts?.master || 'orchestratorCarbonThinking';
      return resolveOrchestratorMasterThinkingLevels(modelsRes, fieldKeyOrMaster);
    },
    async stopServer() {
      sseBroker.dispose();
      ptyManager.disposeAll();
      await cloudflared.stop();
      await server.stop();
      return publishStatus();
    }
  };

  const stopSvc = host.services.provide('remote', serviceMethods, { realm: 'node', version: '1.0.0' });

  await refreshPcWebStatus();
  publishStatus();

  const stopWebStateSub = host.state?.subscribe?.('state:web.status@1', () => {
    const prevPcWebJson = JSON.stringify(latestPcWeb);
    void refreshPcWebStatus().then((nextPcWeb) => {
      if (JSON.stringify(nextPcWeb) !== prevPcWebJson) {
        publishStatus();
      }
    }).catch(() => {});
  });
  const stopContextStateSub = host.state?.subscribe?.('state:context.snapshot@1', () => {
    scheduleTelemetryBroadcast();
  });
  const stopUsageStateSub = host.state?.subscribe?.('state:usage.summary@1', () => {
    scheduleTelemetryBroadcast();
  });
  const stopQuotaStateSub = host.state?.subscribe?.('state:quota.snapshot@1', () => {
    scheduleTelemetryBroadcast();
  });
  const stopComposerStateSub = host.state?.subscribe?.('state:composer.settings@1', (rawVal) => {
    sseBroker.emit('state.patch', {
      key: 'state:composer.settings@1',
      value: unwrapStateEntry(rawVal)
    });
    scheduleTelemetryBroadcast();
  });
  const stopLocaleStateSub = host.state?.subscribe?.('state:host.locale@1', (rawVal) => {
    sseBroker.emit('state.patch', {
      key: 'state:host.locale@1',
      value: unwrapStateEntry(rawVal)
    });
    scheduleTelemetryBroadcast();
  });
  const stopOrgStateSub = host.state?.subscribe?.('state:session.org@1', (val, meta) => {
    if (meta?.publisher === 'agy-daddy.remote') return;
    sessionOrgStore.syncFromExternalSignal(val);
  });
  const stopStatusRoute = await host.bridge.registerRoute('/status', async () => {
    await refreshPcWebStatus();
    return serviceMethods.getStatus();
  });
  const stopSnapshotRoute = await host.bridge.registerRoute('/snapshot', async () => await serviceMethods.getSnapshot());
  const stopPairingRoute = await host.bridge.registerRoute('/pairing', async () => {
    await refreshPcWebStatus();
    return serviceMethods.getPairingBundle();
  });
  const stopOpenPcWebRoute = await host.bridge.registerRoute('/open-pc-web', async () => await serviceMethods.openPcWeb());
  const stopSyncPcWebChannelsRoute = await host.bridge.registerRoute('/sync-pc-web-channels', async () => await serviceMethods.syncPcWebChannels());
  const stopDevicesRoute = await host.bridge.registerRoute('/devices', async (body) => {
    if (body?.action === 'kick') return serviceMethods.kickDevices();
    return serviceMethods.getDevices();
  });
  const stopRotateRoute = await host.bridge.registerRoute('/rotate-token', async () => serviceMethods.rotateToken());
  const stopChannelRoute = await host.bridge.registerRoute('/channel', async (body) => await serviceMethods.setChannelConfig(body || {}));
  const stopActionsRoute = await host.bridge.registerRoute('/actions', async () => ({
    ok: true,
    permissionLevel: config.permissionLevel,
    allowRemoteWrite: config.allowRemoteWrite === true,
    actions: serviceMethods.listActions()
  }));

  const stopRotateCmd = host.commands.register('remote.rotate-token', async () => {
    const res = serviceMethods.rotateToken();
    return {
      ...res,
      message: `新令牌已生效 (${res.status?.tokenPreview || ''})`
    };
  });

  const stopStatusCmd = host.commands.register('remote.status', async () => {
    const st = serviceMethods.getStatus();
    const channelLabel = CHANNEL_DISPLAY_NAMES[st.primaryChannel] || st.primaryChannel || '离线';
    const errPart = st.tunnelConfigError ? ` · 隧道提示: ${st.tunnelConfigError}` : '';
    return {
      ...st,
      message: `${st.running ? '监听中' : '未启动'}${st.port ? ` :${st.port}` : ''} · 通道:${channelLabel} · ${st.devicesCount}台设备 · ${st.permissionLevel} (${st.allowRemoteWrite ? '可写' : '只读'}) · 令牌:${st.tokenPreview}${errPart}`
    };
  });

  const stopKickCmd = host.commands.register('remote.kick-devices', async () => {
    const res = serviceMethods.kickDevices();
    return {
      ...res,
      message: `已断开全部设备并轮换令牌 (${res.status?.tokenPreview || ''})`
    };
  });

  const stopCheckCfCmd = host.commands.register('remote.check-cloudflared', async () => {
    const bin = detectCloudflaredBinary();
    const hints = getCloudflaredInstallHints();
    if (bin.found) {
      return {
        ok: true,
        found: true,
        path: bin.path,
        message: `已检测到 cloudflared：${bin.path}`
      };
    }
    const platformLabel = process.platform === 'darwin'
      ? 'macOS (Homebrew)'
      : (process.platform === 'win32' ? 'Windows (winget)' : 'Linux');
    const installCmd = process.platform === 'darwin'
      ? hints.darwin
      : (process.platform === 'win32' ? hints.win32 : hints.linux);
    return {
      ok: true,
      found: false,
      error: 'CLOUDFLARED_NOT_INSTALLED',
      title: '未检测到 cloudflared 程序',
      message: '启用 Cloudflare Tunnel 需要先在本机安装 cloudflared。请选中或一键复制下方命令在终端运行安装，完成后点击「重新检测」：',
      commands: [
        { label: platformLabel, command: installCmd }
      ],
      links: [
        { label: '查看官方下载文档', url: hints.docsUrl },
        { label: '前往 Cloudflare 控制台 · 零信任隧道', url: 'https://one.dash.cloudflare.com/?to=/:account/networks/tunnels' }
      ]
    };
  });

  const stopBrowseRootCmd = host.commands.register('remote.browse-allowed-root', async (opts = {}) => {
    return serviceMethods.browseAllowedRoot(opts || {});
  });

  const stopListModelsCmd = host.commands.register('remote.list-models', async () => {
    return serviceMethods.listModelsForSettings();
  });

  const stopListOrchestratorThinkingCmd = host.commands.register('remote.list-orchestrator-thinking-levels', async (opts = {}) => {
    return serviceMethods.listOrchestratorThinkingLevelsForSettings(opts || {});
  });

  disposers.push(
    stopSettingsSub,
    stopWebStateSub,
    stopContextStateSub,
    stopUsageStateSub,
    stopQuotaStateSub,
    stopComposerStateSub,
    stopLocaleStateSub,
    () => {
      if (telemetryDebounceTimer) {
        clearTimeout(telemetryDebounceTimer);
        telemetryDebounceTimer = null;
      }
    },
    stopOrgStateSub,
    stopWorktreeSub,
    () => { sessionOrgStore.dispose(); },
    () => { remoteProvisioner.dispose(); },
    () => { sseBroker.dispose(); },
    () => { ptyManager.disposeAll(); },
    async () => { await cloudflared.stop(); },
    async () => { await server.stop(); },
    stopSvc,
    stopStatusRoute,
    stopSnapshotRoute,
    stopPairingRoute,
    stopOpenPcWebRoute,
    stopSyncPcWebChannelsRoute,
    stopDevicesRoute,
    stopRotateRoute,
    stopChannelRoute,
    stopActionsRoute,
    stopRotateCmd,
    stopStatusCmd,
    stopKickCmd,
    stopCheckCfCmd,
    stopBrowseRootCmd,
    stopListModelsCmd,
    stopListOrchestratorThinkingCmd,
    () => {
      try {
        host.state?.set?.('state:remote.status@1', {
          running: false,
          deactivated: true,
          updatedAt: Date.now()
        });
      } catch {}
    }
  );
}

async function deactivate() {
  for (const fn of disposers) {
    try {
      if (typeof fn === 'function') await fn();
    } catch {}
  }
  disposers = [];
}

module.exports = {
  activate,
  deactivate,
  normalizeIpOrHost,
  isAllowedPcWebUrl,
  normalizePcWebInfo
};
