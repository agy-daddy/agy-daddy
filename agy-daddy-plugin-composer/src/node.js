'use strict';

const {
  BUILTIN_QUICK_POOL,
  DEFAULT_QUICK_ITEMS,
  DEFAULT_OPTIMIZER_SHORTCUT,
  DEFAULT_OPTIMIZER_PROMPT,
  splitSlashDraft,
  buildPromptOptimizeInstruction,
  cleanOptimizedPromptOutput,
  buildOptimizeModelCandidates,
  selectOptimizerCandidates,
  optimizePromptText
} = require('./quick-prompts');
const {
  collectManualUserMessages,
  buildFrequentPromptsInstruction,
  parseFrequentPromptsResponse
} = require('./frequent-prompts');

const SCHEMA_SETTING_KEYS = Object.freeze([
  'showQuickBar',
  'ghostSuggest',
  'contextAwareQuickItems',
  'autoSummarizeFrequentPrompts',
  'quickItems',
  'showPromptOptimizer',
  'optimizerShortcut',
  'optimizerPrompt',
  'autoAccept'
]);

const DEFAULT_SETTINGS = Object.freeze({
  showQuickBar: true,
  ghostSuggest: true,
  contextAwareQuickItems: true,
  autoSummarizeFrequentPrompts: false,
  quickItems: [...DEFAULT_QUICK_ITEMS],
  showPromptOptimizer: true,
  optimizerShortcut: DEFAULT_OPTIMIZER_SHORTCUT,
  optimizerPrompt: DEFAULT_OPTIMIZER_PROMPT,
  autoAccept: false
});

const DEFAULT_QUICK_POOL_STATE = Object.freeze(
  Object.fromEntries(BUILTIN_QUICK_POOL.map((q) => [q.id, Boolean(q.defaultEnabled)]))
);

let disposers = [];

function normalizeHostedSettings(raw = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  // 安全不变式：未明确开启时强制关闭自动化危险动作
  merged.autoAccept = merged.autoAccept === true;
  merged.contextAwareQuickItems = merged.contextAwareQuickItems !== false;
  merged.autoSummarizeFrequentPrompts = merged.autoSummarizeFrequentPrompts === true;
  merged.showPromptOptimizer = merged.showPromptOptimizer !== false;
  merged.optimizerShortcut = typeof merged.optimizerShortcut === 'string'
    ? merged.optimizerShortcut.trim()
    : DEFAULT_OPTIMIZER_SHORTCUT;
  if (!Array.isArray(merged.quickItems)) {
    merged.quickItems = [...DEFAULT_QUICK_ITEMS];
  } else {
    merged.quickItems = merged.quickItems.filter((it) => it !== 'copyid' && it !== 'export');
  }
  if (typeof merged.optimizerPrompt !== 'string') {
    merged.optimizerPrompt = DEFAULT_OPTIMIZER_PROMPT;
  }
  return merged;
}

async function activate(host) {
  let hostedSettings = normalizeHostedSettings(host.settings?.get?.() || {});
  let modelCache = { candidates: [], fetchedAt: 0 };
  let summarizeInFlight = null;
  let autoSummarizeTimer = null;

  // 自定义快捷提示词与内置开关池独立持久化在 quick-prompts.json，避免被托管 schema 校验裁掉
  const savedPrompts = host.storage.readJson('quick-prompts.json', {}).data || {};
  let quickPoolState = {
    ...DEFAULT_QUICK_POOL_STATE,
    ...(savedPrompts.quickPoolState && typeof savedPrompts.quickPoolState === 'object' ? savedPrompts.quickPoolState : {})
  };
  let customQuickPrompts = Array.isArray(savedPrompts.customQuickPrompts) ? [...savedPrompts.customQuickPrompts] : [];

  const savedFrequent = host.storage.readJson('frequent-prompts.json', {}).data || {};
  let frequentPromptsCache = {
    items: Array.isArray(savedFrequent.items) ? [...savedFrequent.items] : [],
    meta: savedFrequent.meta && typeof savedFrequent.meta === 'object' ? { ...savedFrequent.meta } : {}
  };

  function persistFrequentPrompts() {
    host.storage.writeJson('frequent-prompts.json', {
      items: frequentPromptsCache.items,
      meta: frequentPromptsCache.meta
    });
  }

  function persistQuickPrompts() {
    host.storage.writeJson('quick-prompts.json', {
      quickPoolState,
      customQuickPrompts
    });
  }

  function getCombinedSettings() {
    hostedSettings = normalizeHostedSettings(host.settings?.get?.() || hostedSettings);
    return {
      ...hostedSettings,
      quickPoolState: { ...quickPoolState },
      customQuickPrompts: [...customQuickPrompts]
    };
  }

  async function resolveFastModelCandidates(opts = {}) {
    let candidates = [];
    if (!opts.forceRefreshModels && modelCache.candidates.length > 0 && (Date.now() - modelCache.fetchedAt) < 60000) {
      candidates = modelCache.candidates;
    }

    if (candidates.length === 0 && !Array.isArray(opts.availableModels)) {
      try {
        const userStatus = await host.rpc.call('GetUserStatus', {}, { timeoutMs: 8000 });
        const cfgData = userStatus?.userStatus?.cascadeModelConfigData || userStatus?.cascadeModelConfigData || null;
        const built = buildOptimizeModelCandidates(cfgData);
        if (built.length > 0) {
          candidates = built;
          modelCache = { candidates: built, fetchedAt: Date.now() };
        }
      } catch {}
    }

    if (candidates.length === 0) {
      let availableModels = Array.isArray(opts.availableModels) ? opts.availableModels : [];
      if (availableModels.length === 0) {
        try {
          const res = await host.rpc.call('GetAvailableModels', { forceRefresh: false }, { timeoutMs: 8000 });
          availableModels = res?.response?.models || res?.models || [];
        } catch {}
      }
      let quotaSnap = opts.quotaSnapshot || null;
      if (!quotaSnap) {
        try {
          const qRes = await host.services.call('quota', 'getSnapshot', [], { optional: true });
          if (qRes?.ok) quotaSnap = qRes.value;
        } catch {}
      }
      candidates = selectOptimizerCandidates(availableModels, quotaSnap);
    }

    return candidates;
  }

  const serviceMethods = {
    getSettings() {
      return getCombinedSettings();
    },
    async saveSettings(patch = {}) {
      const schemaPatch = {};
      let quickDirty = false;
      for (const [k, v] of Object.entries(patch || {})) {
        if (SCHEMA_SETTING_KEYS.includes(k)) {
          schemaPatch[k] = v;
        } else if (k === 'quickPoolState' && v && typeof v === 'object') {
          quickPoolState = { ...quickPoolState, ...v };
          quickDirty = true;
        } else if (k === 'customQuickPrompts' && Array.isArray(v)) {
          customQuickPrompts = [...v];
          quickDirty = true;
        }
      }
      if (quickDirty) persistQuickPrompts();
      if (Object.keys(schemaPatch).length > 0 && host.settings?.update) {
        const res = await host.settings.update(schemaPatch);
        hostedSettings = normalizeHostedSettings(res?.values || host.settings.get());
      }
      return getCombinedSettings();
    },
    listQuickPrompts() {
      const builtins = BUILTIN_QUICK_POOL.map((item) => ({
        ...item,
        enabled: typeof quickPoolState[item.id] === 'boolean' ? quickPoolState[item.id] : Boolean(item.defaultEnabled),
        builtin: true
      }));
      return { builtins, custom: [...customQuickPrompts], quickPoolState: { ...quickPoolState } };
    },
    addCustomPrompt(item = {}) {
      const label = String(item.label || '').trim();
      const text = String(item.text || '').trim();
      if (!label || !text) return { ok: false, error: 'INVALID_PROMPT' };
      const id = String(item.id || `custom_${Date.now().toString(36)}`).trim();
      const entry = {
        id,
        group: 'custom',
        label,
        text,
        slash: item.slash ? String(item.slash) : '',
        title: String(item.title || label),
        builtin: false
      };
      customQuickPrompts = customQuickPrompts.filter((c) => c.id !== id).concat([entry]);
      persistQuickPrompts();
      return { ok: true, item: entry, custom: [...customQuickPrompts] };
    },
    removeCustomPrompt(id) {
      const targetId = String(id || '').trim();
      const before = customQuickPrompts.length;
      customQuickPrompts = customQuickPrompts.filter((c) => c.id !== targetId);
      persistQuickPrompts();
      return { ok: true, removed: customQuickPrompts.length < before, custom: [...customQuickPrompts] };
    },
    async optimizePrompt(rawText = '', opts = {}) {
      const text = String(rawText || '').trim();
      if (!text) return { ok: false, error: 'EMPTY_PROMPT', message: '先输入提示词草稿，再点击优化' };

      const { slashPrefix, draftBody, isSlashOnly } = splitSlashDraft(text);
      if (isSlashOnly) {
        return { ok: false, error: 'SLASH_ONLY', message: '当前仅包含斜杠命令，无需优化' };
      }

      const startedAt = Date.now();
      const overallBudgetMs = Number(opts.overallTimeoutMs) > 0 ? Number(opts.overallTimeoutMs) : 45000;
      const attemptTimeoutMs = Number(opts.attemptTimeoutMs) > 0 ? Number(opts.attemptTimeoutMs) : 18000;
      const candidates = await resolveFastModelCandidates(opts);

      const liveSettings = host.settings?.get?.();
      const customTemplate = opts.customPrompt !== undefined
        ? String(opts.customPrompt || '')
        : String(liveSettings?.optimizerPrompt ?? hostedSettings.optimizerPrompt ?? '');
      const prompt = buildPromptOptimizeInstruction(draftBody, customTemplate);
      const attempts = [];

      for (const cand of candidates.slice(0, 4)) {
        const remainingMs = overallBudgetMs - (Date.now() - startedAt);
        if (remainingMs <= 500) break;
        const modelEnum = String(cand?.model || '').trim();
        if (!modelEnum) continue;
        const callTimeoutMs = Math.max(1, Math.min(attemptTimeoutMs, remainingMs));
        try {
          const resPayload = await host.rpc.call(
            'GetModelResponse',
            { prompt, model: modelEnum },
            { timeoutMs: callTimeoutMs, retryOnTimeout: false }
          );
          const rawResp = resPayload?.response ?? resPayload?.text ?? '';
          const cleaned = cleanOptimizedPromptOutput(rawResp, slashPrefix);
          if (!cleaned) {
            const emptyErr = new Error('模型未返回有效优化文本');
            emptyErr.status = 200;
            throw emptyErr;
          }
          return {
            ok: true,
            source: 'llm',
            original: text,
            optimized: cleaned,
            candidate: modelEnum,
            model: modelEnum,
            label: cand.label || cand.displayName || modelEnum,
            candidates: candidates.map((c) => c.model),
            attempts
          };
        } catch (err) {
          const msg = String(err?.message || 'failed');
          const statusMatch = msg.match(/\bHTTP\s+(\d{3})\b/i);
          const status = Number(err?.status || (statusMatch ? statusMatch[1] : 0));
          attempts.push({
            model: modelEnum,
            label: cand.label || cand.displayName || modelEnum,
            status,
            error: msg
          });
          if (status === 401 || status === 403) break;
        }
      }

      if (opts.allowLocalFallback === true) {
        const fallbackText = optimizePromptText(draftBody);
        const optimized = slashPrefix ? `${slashPrefix} ${fallbackText}` : fallbackText;
        return {
          ok: true,
          source: 'local-fallback',
          original: text,
          optimized,
          candidate: 'local-structurer',
          candidates: candidates.map((c) => c.model),
          attempts
        };
      }

      modelCache.fetchedAt = 0;

      const lastAttempt = attempts[attempts.length - 1];
      const summary = lastAttempt
        ? `${lastAttempt.error}${attempts.length > 1 ? `（已尝试 ${attempts.length} 个模型）` : ''}`
        : '未能连接语言模型服务，请确认 Antigravity 已登录且模型可用';
      return {
        ok: false,
        error: summary,
        message: summary,
        detail: attempts.map((a) => `${a.label || a.model}: ${a.error}`).join(' | '),
        attempts
      };
    },
    listFrequentPrompts() {
      return {
        ok: true,
        presets: [...frequentPromptsCache.items],
        items: [...frequentPromptsCache.items],
        meta: { ...frequentPromptsCache.meta }
      };
    },
    async summarizeFrequentPrompts(opts = {}) {
      if (summarizeInFlight) {
        return summarizeInFlight;
      }
      const run = async () => {
        const stats = await collectManualUserMessages({
          brainDirs: opts.brainDirs,
          rpc: host.rpc,
          skipDiskScan: opts.skipDiskScan,
          builtinPool: BUILTIN_QUICK_POOL,
          maxSessions: opts.maxSessions || 500
        });
        if (!stats.messagesScanned) {
          return {
            ok: false,
            error: 'NO_MANUAL_MESSAGES',
            message: '未在历史会话中扫描到足够的手动发送记录',
            presets: [...frequentPromptsCache.items],
            items: [...frequentPromptsCache.items],
            meta: { ...frequentPromptsCache.meta }
          };
        }

        const startedAt = Date.now();
        const overallBudgetMs = Number(opts.overallTimeoutMs) > 0 ? Number(opts.overallTimeoutMs) : 45000;
        const attemptTimeoutMs = Number(opts.attemptTimeoutMs) > 0 ? Number(opts.attemptTimeoutMs) : 20000;
        const candidates = await resolveFastModelCandidates(opts);
        const prompt = buildFrequentPromptsInstruction(stats, BUILTIN_QUICK_POOL);
        const attempts = [];

        for (const cand of candidates.slice(0, 4)) {
          if ((Date.now() - startedAt) >= overallBudgetMs) break;
          const modelEnum = String(cand?.model || '').trim();
          if (!modelEnum) continue;
          try {
            const resPayload = await host.rpc.call(
              'GetModelResponse',
              { prompt, model: modelEnum },
              { timeoutMs: attemptTimeoutMs }
            );
            const rawResp = resPayload?.response ?? resPayload?.text ?? '';
            const nowIso = new Date().toISOString();
            const parsedItems = parseFrequentPromptsResponse(rawResp, BUILTIN_QUICK_POOL, nowIso);
            if (parsedItems.length === 0) {
              const emptyErr = new Error('模型未返回有效高频指令 JSON 列表');
              emptyErr.status = 200;
              throw emptyErr;
            }
            const meta = {
              sessionsScanned: stats.sessionsScanned,
              messagesScanned: stats.messagesScanned,
              uniqueCount: stats.uniqueCount,
              model: modelEnum,
              label: cand.label || cand.displayName || modelEnum,
              trigger: String(opts.trigger || 'manual'),
              updatedAt: nowIso
            };
            frequentPromptsCache = { items: parsedItems, meta };
            persistFrequentPrompts();
            return {
              ok: true,
              message: `已从 ${stats.sessionsScanned} 个会话提炼 ${parsedItems.length} 条高频指令`,
              presets: [...parsedItems],
              items: [...parsedItems],
              meta
            };
          } catch (err) {
            const msg = String(err?.message || 'failed');
            const statusMatch = msg.match(/\bHTTP\s+(\d{3})\b/i);
            const status = Number(err?.status || (statusMatch ? statusMatch[1] : 0));
            attempts.push({
              model: modelEnum,
              label: cand.label || cand.displayName || modelEnum,
              status,
              error: msg
            });
            if (status === 401 || status === 403) break;
          }
        }

        modelCache.fetchedAt = 0;

      const lastAttempt = attempts[attempts.length - 1];
        const summary = lastAttempt
          ? `${lastAttempt.error}${attempts.length > 1 ? `（已尝试 ${attempts.length} 个模型）` : ''}`
          : '未能连接语言模型服务，请确认 Antigravity 已登录且模型可用';
        return {
          ok: false,
          error: summary,
          message: summary,
          detail: attempts.map((a) => `${a.label || a.model}: ${a.error}`).join(' | '),
          attempts,
          presets: [...frequentPromptsCache.items],
          items: [...frequentPromptsCache.items],
          meta: { ...frequentPromptsCache.meta }
        };
      };

      summarizeInFlight = run().finally(() => {
        summarizeInFlight = null;
      });
      return summarizeInFlight;
    }
  };

  const stopSettings = host.settings?.onChange?.((nextValues) => {
    const prevAuto = hostedSettings.autoSummarizeFrequentPrompts;
    hostedSettings = normalizeHostedSettings(nextValues);
    if (!prevAuto && hostedSettings.autoSummarizeFrequentPrompts && host.rpc) {
      void serviceMethods.summarizeFrequentPrompts({ trigger: 'auto' }).catch(() => {});
    }
  });

  const isTestEnv = process.env.AGY_DADDY_TEST_MODE === '1' || Boolean(process.env.NODE_TEST_CONTEXT);
  if (!isTestEnv) {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const STALE_MS = 24 * 60 * 60 * 1000;
    if (hostedSettings.autoSummarizeFrequentPrompts && host.rpc) {
      const updatedMs = Date.parse(frequentPromptsCache.meta?.updatedAt || '') || 0;
      if (frequentPromptsCache.items.length === 0 || (Date.now() - updatedMs) > STALE_MS) {
        void serviceMethods.summarizeFrequentPrompts({ trigger: 'startup' }).catch(() => {});
      }
    }
    autoSummarizeTimer = setInterval(() => {
      if (!hostedSettings.autoSummarizeFrequentPrompts || !host.rpc) return;
      const updatedMs = Date.parse(frequentPromptsCache.meta?.updatedAt || '') || 0;
      if ((Date.now() - updatedMs) > STALE_MS) {
        void serviceMethods.summarizeFrequentPrompts({ trigger: 'schedule' }).catch(() => {});
      }
    }, SIX_HOURS_MS);
    autoSummarizeTimer.unref?.();
  }

  const stopSvc = await host.services.provide('composer-node', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopQuickRoute = await host.bridge.registerRoute('/quick-prompts', async (body) => {
    if (body?.action === 'add') return serviceMethods.addCustomPrompt(body.item);
    if (body?.action === 'remove') return serviceMethods.removeCustomPrompt(body.id);
    return serviceMethods.listQuickPrompts();
  });
  const stopFrequentRoute = await host.bridge.registerRoute('/frequent-prompts', async (body) => {
    if (body?.action === 'summarize') return serviceMethods.summarizeFrequentPrompts(body || {});
    return serviceMethods.listFrequentPrompts();
  }, { timeoutMs: 50000 });
  const stopOptRoute = await host.bridge.registerRoute('/optimize-prompt', async (body) => {
    return serviceMethods.optimizePrompt(body?.text || '', body || {});
  }, { timeoutMs: 50000 });

  const stopCmdCompact = await host.commands.register('composer.compact', () => {
    host.events.emit('composer:command@1', { command: 'compact', text: '/compact' });
    return { ok: true, command: 'composer.compact', text: '/compact' };
  });
  const stopCmdListFrequent = await host.commands.register('composer.listFrequentPrompts', () => {
    return serviceMethods.listFrequentPrompts();
  });
  const stopCmdSummarizeFrequent = await host.commands.register('composer.summarizeFrequentPrompts', (arg = {}) => {
    return serviceMethods.summarizeFrequentPrompts(arg && typeof arg === 'object' ? arg : {});
  });

  disposers.push(
    () => {
      if (autoSummarizeTimer) {
        clearInterval(autoSummarizeTimer);
        autoSummarizeTimer = null;
      }
    },
    stopSettings,
    stopSvc,
    stopQuickRoute,
    stopFrequentRoute,
    stopOptRoute,
    stopCmdCompact,
    stopCmdListFrequent,
    stopCmdSummarizeFrequent
  );
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  activate,
  deactivate
};
