'use strict';

let disposers = [];

function matchMessages(messages = [], query = '', options = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, matches: [], total: 0 };
  let matcher = null;
  if (options.regexMode) {
    try {
      matcher = new RegExp(q, options.caseSensitive ? '' : 'i');
    } catch (err) {
      return { ok: false, error: `INVALID_REGEX: ${err.message}`, matches: [], total: 0 };
    }
  }
  const needle = options.caseSensitive ? q : q.toLowerCase();
  const matches = [];
  for (let i = 0; i < (Array.isArray(messages) ? messages.length : 0); i++) {
    const text = String(messages[i] ?? '');
    const hit = matcher ? matcher.test(text) : (options.caseSensitive ? text.includes(needle) : text.toLowerCase().includes(needle));
    if (hit) matches.push({ index: i, preview: text.slice(0, 120) });
  }
  return { ok: true, matches, total: matches.length };
}

async function activate(host) {
  let settings = {
    regexMode: false,
    caseSensitive: false,
    ...(host.storage.readJson('settings.json', {}).data || {})
  };

  const serviceMethods = {
    search(query = '', messages = [], opts = {}) {
      const merged = { regexMode: settings.regexMode, caseSensitive: settings.caseSensitive, ...opts };
      const res = matchMessages(messages, query, merged);
      host.state.set('state:chat-search.query@1', { query, total: res.total, regexMode: Boolean(merged.regexMode) });
      return res;
    },
    getSettings() {
      return { ...settings };
    },
    saveSettings(patch = {}) {
      settings = { ...settings, ...patch };
      host.storage.writeJson('settings.json', settings);
      return { ...settings };
    }
  };

  const stopSvc = host.services.provide('chat-search', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopSearchRoute = await host.bridge.registerRoute('/search', async (body) => {
    return serviceMethods.search(body?.query || '', body?.messages || [], body || {});
  });
  const stopSettingsRoute = await host.bridge.registerRoute('/settings', async (body) => {
    if (body?.action === 'save' && body.values) return { ok: true, values: serviceMethods.saveSettings(body.values) };
    return { ok: true, values: serviceMethods.getSettings() };
  });

  disposers.push(stopSvc, stopSearchRoute, stopSettingsRoute);
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = {
  matchMessages,
  activate,
  deactivate
};
