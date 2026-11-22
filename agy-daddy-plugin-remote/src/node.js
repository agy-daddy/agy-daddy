'use strict';

const os = require('node:os');
const {
  DEFAULT_REMOTE_PORT,
  DEFAULT_CHANNELS,
  DEFAULT_REMOTE_DISPLAY_CONFIG,
  sanitizeRemoteDisplayConfig,
  normalizeChannelConfig,
  validateCloudflareTunnelToken,
  validateTunnelHostname,
  generatePairingToken
} = require('./tunnel-security');
const { generateQrSvg, generateQrAscii } = require('./qr-svg');
const { CloudflaredManager } = require('./cloudflared');
const { MobileRemoteServer } = require('./pwa-server');

let disposers = [];

function isTestMode() {
  return process.env.AGY_DADDY_TEST_MODE === '1';
}

async function activate(host) {
  const loaded = host.storage.readJson('remote-config.json', null);
  const existing = (loaded.ok && loaded.data && typeof loaded.data === 'object') ? loaded.data : {};

  let token = (typeof existing.token === 'string' && existing.token.length >= 24)
    ? existing.token
    : '';
  let changed = !loaded.ok || !token;
  if (!token) token = generatePairingToken();

  let config = {
    port: Number.isInteger(existing.port) && existing.port > 0 && existing.port < 65536
      ? existing.port
      : DEFAULT_REMOTE_PORT,
    token,
    allowRemoteWrite: existing.allowRemoteWrite === true,
    channels: normalizeChannelConfig(existing.channels || DEFAULT_CHANNELS),
    tunnelMode: existing.tunnelMode === 'named' ? 'named' : 'quick',
    tunnelToken: '',
    tunnelHostname: '',
    remoteDisplay: sanitizeRemoteDisplayConfig(existing.remoteDisplay || DEFAULT_REMOTE_DISPLAY_CONFIG),
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

  function persistConfig() {
    config.updatedAt = new Date().toISOString();
    host.storage.writeJson('remote-config.json', config);
  }
  if (changed) persistConfig();

  const extraPanels = new Map();
  const extraActions = new Map();
  const cloudflared = new CloudflaredManager();

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

  async function collectAggregatedSnapshot() {
    const [contextPanel, usagePanel, quotaPanel] = await Promise.all([
      safeFetchPanel('context', 'getMobileSnapshot'),
      safeFetchPanel('usage', 'getMobileSnapshot'),
      safeFetchPanel('quota', 'getMobileSnapshot')
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
      writeEnabled: config.allowRemoteWrite === true,
      channels: { ...config.channels },
      display: { ...config.remoteDisplay },
      panels,
      actions: Array.from(extraActions.values()).map((a) => ({
        id: a.id,
        title: a.title || a.id,
        requiresWrite: a.requiresWrite !== false
      }))
    };
  }

  let server = null;

  function buildChannelUrls() {
    const localUrl = server?.getLocalUrl() || '';
    const urls = {};
    if (localUrl && config.channels.loopback) {
      urls.loopback = `${localUrl}/?t=${config.token}`;
    }
    if (server?.port && config.channels.lan) {
      const ifaces = os.networkInterfaces();
      for (const list of Object.values(ifaces)) {
        for (const info of (list || [])) {
          if (info.family === 'IPv4' && !info.internal) {
            urls.lan = `http://${info.address}:${server.port}/?t=${config.token}`;
            break;
          }
        }
        if (urls.lan) break;
      }
    }
    if (server?.port && config.channels.bonjour) {
      const hostName = os.hostname().replace(/\.local$/i, '');
      urls.bonjour = `http://${hostName}.local:${server.port}/?t=${config.token}`;
    }
    if (config.channels.cloudflare) {
      const cfState = cloudflared.getState();
      const pubUrl = cfState.publicUrl || config.tunnelHostname;
      if (pubUrl) urls.cloudflare = `${pubUrl}/?t=${config.token}`;
    }
    return urls;
  }

  function buildStatus() {
    const boundPort = server?.port || null;
    const localUrl = server?.getLocalUrl() || '';
    const tracked = server ? server.getTrackedDevices() : { devices: [], clients: [] };
    return {
      running: Boolean(server && boundPort),
      host: server?.host || '127.0.0.1',
      port: boundPort,
      configuredPort: config.port,
      url: localUrl,
      allowRemoteWrite: config.allowRemoteWrite === true,
      channels: { ...config.channels },
      tunnelMode: config.tunnelMode,
      tunnelHostname: config.tunnelHostname,
      hasTunnelToken: Boolean(config.tunnelToken),
      tunnelState: cloudflared.getState(),
      remoteDisplay: { ...config.remoteDisplay },
      devicesCount: tracked.devices.length,
      clientsCount: tracked.clients.length,
      tokenPreview: `${config.token.slice(0, 6)}...${config.token.slice(-4)}`,
      registeredPanels: Array.from(extraPanels.keys()),
      registeredActions: Array.from(extraActions.keys()),
      updatedAt: Date.now()
    };
  }

  function publishStatus() {
    const st = buildStatus();
    host.state.set('state:remote.status@1', st);
    return st;
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
      const res = await host.services.call('composer', 'triggerCompact', [], { optional: true });
      return { ok: Boolean(res?.ok), action: 'compact', result: res };
    }
    return { ok: false, error: 'UNKNOWN_ACTION', action: actionId };
  }

  const bindHost = config.channels.lan ? '0.0.0.0' : '127.0.0.1';
  const listenPort = isTestMode() ? 0 : config.port;
  server = new MobileRemoteServer({
    host: bindHost,
    port: listenPort,
    getToken: () => config.token,
    getSnapshot: collectAggregatedSnapshot,
    getChannels: () => config.channels,
    getTunnelHostname: () => config.tunnelHostname,
    isWriteEnabled: () => config.allowRemoteWrite === true,
    onAction: handleRemoteAction
  });

  if (config.channels.loopback !== false || config.channels.lan === true) {
    await server.start();
  }

  const serviceMethods = {
    getStatus() {
      return buildStatus();
    },
    getPairingToken() {
      return config.token;
    },
    getPairingBundle() {
      const urls = buildChannelUrls();
      const primaryUrl = urls.cloudflare || urls.tailscale || urls.bonjour || urls.lan || urls.loopback || server?.getLocalUrl() || '';
      return {
        ok: true,
        primaryUrl,
        urls,
        qrSvg: primaryUrl ? generateQrSvg(primaryUrl) : '',
        qrAscii: primaryUrl ? generateQrAscii(primaryUrl) : '',
        channels: { ...config.channels },
        tunnelState: cloudflared.getState()
      };
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
      for (const ch of ['loopback', 'lan', 'tailscale', 'bonjour', 'cloudflare']) {
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
      if (mode === 'named') {
        if (!config.tunnelToken) return { ok: false, error: 'MISSING_TUNNEL_TOKEN' };
        return await cloudflared.startNamedTunnel(config.tunnelToken, config.tunnelHostname, { dryRun });
      }
      return await cloudflared.startQuickTunnel(server.port, { dryRun });
    },
    async stopTunnel() {
      await cloudflared.stop();
      return publishStatus();
    },
    async getSnapshot() {
      return await collectAggregatedSnapshot();
    },
    rotateToken() {
      config.token = generatePairingToken();
      persistConfig();
      const status = publishStatus();
      return { ok: true, token: config.token, status };
    },
    setAllowRemoteWrite(enabled) {
      config.allowRemoteWrite = enabled === true;
      persistConfig();
      const status = publishStatus();
      return { ok: true, allowRemoteWrite: config.allowRemoteWrite, status };
    },
    setChannelConfig(patch = {}) {
      if (patch.channels && typeof patch.channels === 'object') {
        config.channels = normalizeChannelConfig({ ...config.channels, ...patch.channels });
      }
      for (const chKey of ['loopback', 'lan', 'tailscale', 'bonjour', 'cloudflare']) {
        if (typeof patch[chKey] === 'boolean') {
          config.channels[chKey] = patch[chKey];
        }
      }
      if (patch.tunnelMode === 'quick' || patch.tunnelMode === 'named') {
        config.tunnelMode = patch.tunnelMode;
      }
      if (typeof patch.tunnelToken === 'string') {
        if (!patch.tunnelToken.trim()) {
          config.tunnelToken = '';
        } else {
          const check = validateCloudflareTunnelToken(patch.tunnelToken);
          if (!check.ok) return { ok: false, error: check.error };
          config.tunnelToken = check.token;
        }
      }
      if (typeof patch.tunnelHostname === 'string') {
        if (!patch.tunnelHostname.trim()) {
          config.tunnelHostname = '';
        } else {
          const check = validateTunnelHostname(patch.tunnelHostname);
          if (!check.ok) return { ok: false, error: check.error };
          config.tunnelHostname = check.origin;
        }
      }
      if (patch.remoteDisplay && typeof patch.remoteDisplay === 'object') {
        config.remoteDisplay = sanitizeRemoteDisplayConfig({ ...config.remoteDisplay, ...patch.remoteDisplay });
      }
      persistConfig();
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
    async stopServer() {
      await cloudflared.stop();
      await server.stop();
      return publishStatus();
    }
  };

  publishStatus();

  const stopSvc = host.services.provide('remote', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopStatusRoute = await host.bridge.registerRoute('/status', async () => serviceMethods.getStatus());
  const stopSnapshotRoute = await host.bridge.registerRoute('/snapshot', async () => await serviceMethods.getSnapshot());
  const stopPairingRoute = await host.bridge.registerRoute('/pairing', async () => serviceMethods.getPairingBundle());
  const stopDevicesRoute = await host.bridge.registerRoute('/devices', async (body) => {
    if (body?.action === 'kick') return serviceMethods.kickDevices();
    return serviceMethods.getDevices();
  });
  const stopRotateRoute = await host.bridge.registerRoute('/rotate-token', async () => serviceMethods.rotateToken());
  const stopChannelRoute = await host.bridge.registerRoute('/channel', async (body) => serviceMethods.setChannelConfig(body || {}));
  const stopWriteRoute = await host.bridge.registerRoute('/set-write', async (body) => serviceMethods.setAllowRemoteWrite(body?.enabled === true));
  const stopActionsRoute = await host.bridge.registerRoute('/actions', async () => ({
    ok: true,
    allowRemoteWrite: config.allowRemoteWrite === true,
    actions: serviceMethods.listActions()
  }));

  disposers.push(
    async () => { await cloudflared.stop(); },
    async () => { await server.stop(); },
    stopSvc,
    stopStatusRoute,
    stopSnapshotRoute,
    stopPairingRoute,
    stopDevicesRoute,
    stopRotateRoute,
    stopChannelRoute,
    stopWriteRoute,
    stopActionsRoute
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
  deactivate
};
