'use strict';

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createHarnessAdapter } = require('./harness-adapter');
const { createWorkspaceService, normalizeInputRoot, isForbiddenSystemRoot } = require('./workspace-service');
const { createWorkspaceMetaStore, normalizeLocalPath } = require('./workspace-meta-store');
const { createSessionOrgBridge } = require('./session-org-bridge');
const { createHostProxy } = require('./host-proxy');
const { createWebServer } = require('./web-server');
const {
  normalizeBindHostMode,
  normalizeChannelConfig,
  normalizePermissionLevel,
  normalizeTunnelHostname,
  resolveBindHost
} = require('./channel-config');

const DEFAULT_WEB_PORT = 18767;
const PLUGIN_VERSION = '1.0.0';
const SESSION_ROOTS_TTL_MS = 15_000;
const IS_CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

let activeRuntime = null;

function isTestMode() {
  return (
    process.env.AGY_DADDY_TEST_MODE === '1'
    || process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
  );
}

function readStoredSettings(host) {
  if (typeof host?.settings?.get === 'function') {
    const val = host.settings.get();
    if (val && typeof val === 'object') return val;
  }
  const read = host?.storage?.readJson?.('settings.json', {});
  return read?.data && typeof read.data === 'object' ? read.data : {};
}

function readAndEnsureWebConfig(host) {
  const existing = host?.storage?.readJson?.('web-config.json', {})?.data;
  const cfg = existing && typeof existing === 'object' ? { ...existing } : {};
  let changed = false;
  if (typeof cfg.token !== 'string' || !cfg.token.trim()) {
    cfg.token = crypto.randomBytes(24).toString('hex');
    changed = true;
  }
  if (changed && typeof host?.storage?.writeJson === 'function') {
    cfg.updatedAt = new Date().toISOString();
    host.storage.writeJson('web-config.json', cfg);
  }
  return cfg;
}

function resolveListenPort(settings, webConfig) {
  const settingsPort = Number(settings?.port);
  if (isTestMode()) {
    if (
      Number.isInteger(settingsPort)
      && settingsPort > 0
      && settingsPort <= 65535
      && settingsPort !== DEFAULT_WEB_PORT
    ) {
      return settingsPort;
    }
    return 0;
  }
  if (Number.isInteger(settingsPort) && settingsPort > 0 && settingsPort <= 65535) {
    return settingsPort;
  }
  const cfgPort = Number(webConfig?.port);
  if (Number.isInteger(cfgPort) && cfgPort > 0 && cfgPort <= 65535) {
    return cfgPort;
  }
  return DEFAULT_WEB_PORT;
}

/**
 * Read the multi-channel access policy from managed settings. Absent keys fall
 * back to loopback-only, so an upgraded install keeps its old behaviour.
 */
function readAccessSettings(settings) {
  const channels = normalizeChannelConfig({
    loopback: settings?.loopback,
    lan: settings?.lan,
    tailscale: settings?.tailscale,
    bonjour: settings?.bonjour,
    cloudflare: settings?.cloudflare
  });
  if (!Object.values(channels).some(Boolean)) {
    // A fully-disabled channel set would brick the console: fall back to the
    // safest channel instead of refusing to serve.
    channels.loopback = true;
  }
  let bindHostMode = normalizeBindHostMode(settings?.bindHost);
  const hasNonLoopback = Boolean(
    channels.lan || channels.tailscale || channels.bonjour || channels.cloudflare
  );
  if (bindHostMode === 'lan' && !hasNonLoopback) {
    bindHostMode = 'auto';
  }
  return {
    bindHostMode,
    channels,
    permissionLevel: normalizePermissionLevel(settings?.remotePermissionLevel),
    tunnelHostname: normalizeTunnelHostname(settings?.tunnelHostname)
  };
}

function buildPublicStatus(runtime) {
  const port = runtime.webServer?.port || null;
  const access = runtime.webServer?.getAccessStatus ? runtime.webServer.getAccessStatus() : null;
  return {
    ok: true,
    running: Boolean(runtime.webServer && port),
    host: runtime.webServer?.host || '127.0.0.1',
    port,
    url: runtime.webServer?.getLocalUrl() || '',
    channels: access?.channels || {},
    activeChannels: access?.activeChannels || [],
    urls: access?.urls || {},
    primaryChannel: access?.primaryChannel || 'offline',
    primaryUrl: access?.primaryUrl || '',
    permissionLevel: access?.permissionLevel || 'L0',
    allowRemoteWrite: access?.allowRemoteWrite || false,
    tunnelHostname: access?.tunnelHostname || '',
    rpcConnected: Boolean(runtime.lastHubOrigin),
    hubOrigin: runtime.lastHubOrigin || null,
    pluginVersion: PLUGIN_VERSION
  };
}

/**
 * Activate the agy-daddy.web plugin in the isolated Node host runtime.
 */
async function activate(host) {
  if (activeRuntime) {
    await deactivate();
  }

  const settings = readStoredSettings(host);
  const webConfig = readAndEnsureWebConfig(host);
  const listenPort = resolveListenPort(settings, webConfig);
  const pairingToken = webConfig.token;
  let runtimeAccess = readAccessSettings(settings);

  const workspaceMetaStore = createWorkspaceMetaStore({ storage: host.storage });
  let discoveredSessionRoots = [];
  let discoveredSessionRootsUpdatedAt = 0;

  function deduplicateSafeRoots(candidates) {
    const out = [];
    const seen = new Set();
    for (const raw of candidates) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const norm = normalizeInputRoot(raw) || normalizeLocalPath(raw);
      if (!norm || isForbiddenSystemRoot(norm)) continue;
      const key = IS_CASE_INSENSITIVE_FS ? norm.toLowerCase() : norm;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(norm);
    }
    return out;
  }

  function refreshSessionRoots(sessions = []) {
    if (!Array.isArray(sessions)) return discoveredSessionRoots;
    const rawRoots = [];
    for (const session of sessions) {
      if (!session || typeof session !== 'object') continue;
      if (typeof session.workspaceUri === 'string' && session.workspaceUri.trim()) {
        rawRoots.push(session.workspaceUri);
      }
      if (Array.isArray(session.workspaces)) {
        for (const ws of session.workspaces) {
          const uri = ws?.workspaceFolderAbsoluteUri || ws?.workspaceUri;
          if (typeof uri === 'string' && uri.trim()) {
            rawRoots.push(uri);
          }
        }
      }
    }
    discoveredSessionRoots = deduplicateSafeRoots(rawRoots);
    discoveredSessionRootsUpdatedAt = Date.now();
    return [...discoveredSessionRoots];
  }

  function getConfiguredAllowedRoots() {
    const live = readStoredSettings(host);
    return Array.isArray(live.allowedRoots)
      ? live.allowedRoots.filter((r) => typeof r === 'string' && r.trim())
      : [];
  }

  function getAllowedRoots() {
    const defaultSessionPath = workspaceMetaStore.getState().defaultSessionPath;
    return deduplicateSafeRoots([
      ...getConfiguredAllowedRoots(),
      ...workspaceMetaStore.getProjectRootPaths(),
      defaultSessionPath,
      ...discoveredSessionRoots
    ]);
  }

  const brainDir = typeof settings.brainDir === 'string' && settings.brainDir.trim()
    ? settings.brainDir.trim()
    : (process.env.AGY_DADDY_BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'brain'));
  const staticDir = path.resolve(__dirname, '..', 'dist', 'web');

  const harnessAdapter = createHarnessAdapter({ rpc: host.rpc });
  const workspaceService = createWorkspaceService({ getAllowedRoots, brainDir });
  const sessionOrgBridge = createSessionOrgBridge();

  const runtime = {
    host,
    pairingToken,
    lastHubOrigin: null,
    harnessAdapter,
    workspaceService,
    workspaceMetaStore,
    sessionOrgBridge,
    hostProxy: null,
    webServer: null,
    disposeOnAny: null,
    disposeSettings: null,
    disposeService: null
  };
  activeRuntime = runtime;

  const getStatus = () => ({
    ...buildPublicStatus(runtime),
    pairingUrl: runtime.webServer?.getPairingUrl() || '',
    pairingToken: runtime.pairingToken
  });

  function publishStatus() {
    if (typeof host?.state?.set === 'function') {
      host.state.set('state:web.status@1', buildPublicStatus(runtime));
    }
    return buildPublicStatus(runtime);
  }

  /**
   * Apply a settings change to the live server. Only a change that alters the
   * listen address needs a rebind; permission/channel policy applies
   * immediately on the next request.
   */
  async function reconcileAccess() {
    if (!runtime.webServer) return;
    const next = readAccessSettings(readStoredSettings(host));
    const previousAccess = runtimeAccess;
    const previousHost = runtime.webServer.host;
    const previousBindHostMode = runtime.webServer.bindHostMode;
    const previousChannels = { ...runtime.webServer.channels };
    let result;
    try {
      result = runtime.webServer.updateAccessConfig({
        bindHostMode: next.bindHostMode,
        channels: next.channels,
        permissionLevel: next.permissionLevel,
        tunnelHostname: next.tunnelHostname
      });
    } catch {
      // updateAccessConfig validates before committing, so the live policy is
      // still the previous one; publish status and wait for the next change.
      publishStatus();
      return;
    }
    runtimeAccess = next;
    if (!result.rebind || result.host === previousHost || !runtime.webServer.server) {
      publishStatus();
      return;
    }
    try {
      await runtime.webServer.stop();
      await runtime.webServer.start();
    } catch {
      runtimeAccess = previousAccess;
      runtime.webServer.host = previousHost;
      runtime.webServer.bindHostMode = previousBindHostMode;
      runtime.webServer.channels = previousChannels;
      try {
        await runtime.webServer.start();
      } catch {}
    }
    publishStatus();
  }

  const commands = {
    'agy-daddy.web.status': async () => getStatus()
  };
  runtime.hostProxy = createHostProxy({ host, commands });

  const getHealth = async () => {
    let origin = null;
    if (typeof host?.rpc?.getOrigin === 'function') {
      try {
        origin = await host.rpc.getOrigin();
      } catch {
        origin = null;
      }
    }
    runtime.lastHubOrigin = origin || null;
    if (origin && Date.now() - discoveredSessionRootsUpdatedAt > SESSION_ROOTS_TTL_MS) {
      try {
        const listRes = await harnessAdapter.listSessions({ limit: 500 });
        if (listRes?.ok && Array.isArray(listRes.sessions)) {
          refreshSessionRoots(listRes.sessions);
        }
      } catch {
        // Soft-ignore session root discovery failure on health check
      }
    }
    const configuredAllowedRoots = getConfiguredAllowedRoots();
    const defaultSessionPath = workspaceMetaStore.getState().defaultSessionPath;
    return {
      ok: true,
      rpcConnected: Boolean(origin),
      hubOrigin: origin || null,
      allowedRoots: getAllowedRoots(),
      configuredAllowedRoots,
      defaultSessionPath
    };
  };

  runtime.webServer = createWebServer({
    host: resolveBindHost({ channels: runtimeAccess.channels, mode: runtimeAccess.bindHostMode }),
    bindHostMode: runtimeAccess.bindHostMode,
    channels: runtimeAccess.channels,
    permissionLevel: runtimeAccess.permissionLevel,
    tunnelHostname: runtimeAccess.tunnelHostname,
    getChannels: () => runtimeAccess.channels,
    getPermissionLevel: () => runtimeAccess.permissionLevel,
    getTunnelHostname: () => runtimeAccess.tunnelHostname,
    port: listenPort,
    pairingToken,
    pluginVersion: PLUGIN_VERSION,
    staticDir,
    harnessAdapter,
    workspaceService,
    workspaceMetaStore,
    sessionOrgBridge,
    refreshSessionRoots,
    onReadStateChanged: () => {
      if (typeof host?.state?.set === 'function') {
        host.state.set('state:session.readState@1', workspaceMetaStore.getReadStateSnapshot());
      }
    },
    hostProxy: runtime.hostProxy,
    getHealth
  });

  try {
    await getHealth();
    const startInfo = await runtime.webServer.start();

    if (typeof host?.storage?.writeJson === 'function') {
      host.storage.writeJson('web-config.json', {
        ...webConfig,
        token: pairingToken,
        port: startInfo.port,
        updatedAt: new Date().toISOString()
      });
    }

    if (typeof host?.events?.onAny === 'function') {
      runtime.disposeOnAny = host.events.onAny((ev) => {
        if (!runtime.webServer || !ev) return;
        if (ev.kind === 'state') {
          if (ev.topicOrKey === 'state:web.status@1') return;
          if (ev.topicOrKey === 'state:session.readState@1') {
            const externalMap = ev.payload?.sessionReadState ?? ev.payload;
            workspaceMetaStore.mergeExternalReadState(externalMap);
            runtime.webServer.broadcast('state.patch', {
              key: ev.topicOrKey,
              value: workspaceMetaStore.getReadStateSnapshot(),
              meta: ev.meta
            });
            return;
          }
          runtime.webServer.broadcast('state.patch', {
            key: ev.topicOrKey,
            value: ev.payload,
            meta: ev.meta
          });
          return;
        }
        runtime.webServer.broadcast('host.event', {
          topic: ev.topicOrKey,
          payload: ev.payload,
          meta: ev.meta
        });
      });
    }

    if (typeof host?.settings?.onChange === 'function') {
      runtime.disposeSettings = host.settings.onChange(() => {
        void reconcileAccess();
      });
    }

    if (typeof host?.services?.provide === 'function') {
      runtime.disposeService = await host.services.provide('web-harness', {
        listSessions: (opts = {}) => harnessAdapter.listSessions(opts),
        getSessionOrg: () => sessionOrgBridge.getOrg(),
        togglePin: (body = {}) => sessionOrgBridge.togglePin(body),
        mutateGroup: (body = {}) => sessionOrgBridge.mutateGroup(body),
        getSessionDetail: (cascadeId) => harnessAdapter.getSessionDetail(cascadeId),
        getSessionDelta: (cascadeId, opts = {}) => harnessAdapter.pollDelta(cascadeId, opts),
        createSession: (opts = {}) => harnessAdapter.createSession(opts),
        sendMessage: (cascadeId, payload = {}) => harnessAdapter.sendMessage(cascadeId, payload),
        cancelSession: (cascadeId) => harnessAdapter.cancelSession(cascadeId),
        approveStep: (cascadeId, stepIdx, decision, payload = {}) =>
          harnessAdapter.approveStep(cascadeId, stepIdx, decision, payload),
        answerQuestion: (cascadeId, stepIdx, answers, payload = {}) =>
          harnessAdapter.answerQuestion(cascadeId, stepIdx, answers, payload),
        listModels: () => harnessAdapter.listModels(),
        getStatus
      }, { realm: 'node', version: '1.0.0' });
    }

    if (typeof host?.state?.get === 'function') {
      try {
        const existingState = await Promise.resolve(host.state.get('state:session.readState@1'));
        const existingVal = existingState && typeof existingState === 'object' && 'value' in existingState
          ? existingState.value
          : existingState;
        if (existingVal && typeof existingVal === 'object') {
          workspaceMetaStore.mergeExternalReadState(existingVal.sessionReadState ?? existingVal);
        }
      } catch {
        // Ignore initial state read failures
      }
    }

    if (typeof host?.state?.set === 'function') {
      host.state.set('state:web.status@1', buildPublicStatus(runtime));
      host.state.set('state:session.readState@1', workspaceMetaStore.getReadStateSnapshot());
    }

    return getStatus();
  } catch (err) {
    await deactivate();
    throw err;
  }
}

/**
 * Cleanly stop the WebServer and release all bus/service registrations.
 */
async function deactivate() {
  const runtime = activeRuntime;
  if (!runtime) return;
  activeRuntime = null;

  try {
    if (typeof runtime.disposeOnAny === 'function') {
      runtime.disposeOnAny();
    }
  } catch {}
  runtime.disposeOnAny = null;

  try {
    if (typeof runtime.disposeSettings === 'function') {
      runtime.disposeSettings();
    }
  } catch {}
  runtime.disposeSettings = null;

  try {
    if (typeof runtime.disposeService === 'function') {
      runtime.disposeService();
    }
  } catch {}
  runtime.disposeService = null;

  try {
    if (runtime.webServer) {
      await runtime.webServer.stop();
    }
  } catch {}
  runtime.webServer = null;
}

module.exports = {
  activate,
  deactivate,
  readAccessSettings
};
