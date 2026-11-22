'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  BUILTIN_QUICK_POOL,
  selectOptimizerCandidates,
  optimizePromptText,
  exportConversationMarkdown
} = require('./quick-prompts');

let disposers = [];

function getDefaultBrainDir(options = {}) {
  if (options.brainDir) return path.resolve(options.brainDir);
  if (process.env.AGY_DADDY_BRAIN_DIR) return path.resolve(process.env.AGY_DADDY_BRAIN_DIR);
  return path.join(options.homeDir || os.homedir(), '.gemini', 'antigravity', 'brain');
}

function listBrainSessions(options = {}) {
  const dir = getDefaultBrainDir(options);
  if (!dir || !fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && /^[a-z0-9-]{8,}$/i.test(e.name))
    .map((e) => {
      const full = path.join(dir, e.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
      return { id: e.name, path: full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function activate(host) {
  let settings = {
    showQuickBar: true,
    ghostSuggest: true,
    autoAccept: false,
    autoCompact: false,
    autoCompactThresholdTokens: 240000,
    autoCompactCooldownMs: 300000,
    quickPoolState: Object.fromEntries(BUILTIN_QUICK_POOL.map((q) => [q.id, Boolean(q.defaultEnabled)])),
    customQuickPrompts: [],
    ...(host.storage.readJson('settings.json', {}).data || {})
  };

  // 安全不变式：未明确设置时强制关闭自动化危险动作
  if (settings.autoAccept !== true) settings.autoAccept = false;
  if (settings.autoCompact !== true) settings.autoCompact = false;
  if (!Array.isArray(settings.customQuickPrompts)) settings.customQuickPrompts = [];

  const serviceMethods = {
    getSettings() {
      return { ...settings };
    },
    saveSettings(patch = {}) {
      settings = { ...settings, ...patch };
      host.storage.writeJson('settings.json', settings);
      return { ...settings };
    },
    listQuickPrompts() {
      const poolState = settings.quickPoolState || {};
      const builtins = BUILTIN_QUICK_POOL.map((item) => ({
        ...item,
        enabled: typeof poolState[item.id] === 'boolean' ? poolState[item.id] : Boolean(item.defaultEnabled),
        builtin: true
      }));
      return { builtins, custom: [...settings.customQuickPrompts] };
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
      settings.customQuickPrompts = settings.customQuickPrompts.filter((c) => c.id !== id).concat([entry]);
      host.storage.writeJson('settings.json', settings);
      return { ok: true, item: entry, custom: [...settings.customQuickPrompts] };
    },
    removeCustomPrompt(id) {
      const targetId = String(id || '').trim();
      const before = settings.customQuickPrompts.length;
      settings.customQuickPrompts = settings.customQuickPrompts.filter((c) => c.id !== targetId);
      host.storage.writeJson('settings.json', settings);
      return { ok: true, removed: settings.customQuickPrompts.length < before, custom: [...settings.customQuickPrompts] };
    },
    async optimizePrompt(rawText = '', opts = {}) {
      const text = String(rawText || '').trim();
      if (!text) return { ok: false, error: 'EMPTY_PROMPT' };

      let availableModels = Array.isArray(opts.availableModels) ? opts.availableModels : [];
      if (availableModels.length === 0) {
        try {
          const res = await host.rpc.call('GetAvailableModels', { forceRefresh: false });
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

      const candidates = selectOptimizerCandidates(availableModels, quotaSnap);
      const optimized = optimizePromptText(text);
      return {
        ok: true,
        original: text,
        optimized,
        candidate: candidates[0]?.model || 'local-structurer',
        candidates: candidates.map((c) => c.model)
      };
    },
    listBrainSessions(opts = {}) {
      return listBrainSessions(opts);
    },
    async exportMarkdown(opts = {}) {
      let steps = Array.isArray(opts.steps) ? opts.steps : null;
      if (!steps && opts.cascadeId) {
        try {
          const resp = await host.rpc.call('GetCascadeTrajectory', { cascadeId: opts.cascadeId });
          steps = resp?.steps || resp?.trajectory?.steps || [];
        } catch {
          steps = [];
        }
      }
      return {
        ok: true,
        markdown: exportConversationMarkdown(steps || [], opts)
      };
    }
  };

  const stopSvc = host.services.provide('composer-node', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopSettingsRoute = await host.bridge.registerRoute('/settings', async (body) => {
    if (body?.action === 'save' && body.values) return { ok: true, values: serviceMethods.saveSettings(body.values) };
    return { ok: true, values: serviceMethods.getSettings() };
  });
  const stopQuickRoute = await host.bridge.registerRoute('/quick-prompts', async (body) => {
    if (body?.action === 'add') return serviceMethods.addCustomPrompt(body.item);
    if (body?.action === 'remove') return serviceMethods.removeCustomPrompt(body.id);
    return serviceMethods.listQuickPrompts();
  });
  const stopOptRoute = await host.bridge.registerRoute('/optimize-prompt', async (body) => {
    return serviceMethods.optimizePrompt(body?.text || '', body || {});
  });
  const stopExportRoute = await host.bridge.registerRoute('/export-md', async (body) => serviceMethods.exportMarkdown(body || {}));
  const stopBrainRoute = await host.bridge.registerRoute('/brain-sessions', async () => serviceMethods.listBrainSessions());

  disposers.push(stopSvc, stopSettingsRoute, stopQuickRoute, stopOptRoute, stopExportRoute, stopBrainRoute);
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  getDefaultBrainDir,
  listBrainSessions,
  activate,
  deactivate
};
