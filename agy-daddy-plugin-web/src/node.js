'use strict';

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createHarnessAdapter } = require('./harness-adapter');
const { createWorkspaceService, normalizeInputRoot, isForbiddenSystemRoot } = require('./workspace-service');
const { createWorkspaceBrowser } = require('./workspace-browser');
const { createRemoteProjectProvisioner } = require('./remote-project-provisioner');
const { createWorkspaceMetaStore, normalizeLocalPath } = require('./workspace-meta-store');
const { createSessionOrgBridge, buildOrgBusSummary, resolveWorkspaceOrg } = require('./session-org-bridge');
const { createHostProxy } = require('./host-proxy');
const { createPtyManager } = require('./pty-manager');
const { createSideChatService } = require('./side-chat-service');
const { createTaskManager } = require('./task-manager');
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

function readDiskSettings(host) {
  const read = host?.storage?.readJson?.('settings.json', {});
  return read?.data && typeof read.data === 'object' ? read.data : {};
}

function readStoredSettings(host) {
  if (typeof host?.settings?.get === 'function') {
    const val = host.settings.get();
    if (val && typeof val === 'object') return val;
  }
  return readDiskSettings(host);
}

function readAndEnsureWebConfig(host) {
  const existing = host?.storage?.readJson?.('web-config.json', {})?.data;
  const cfg = existing && typeof existing === 'object' ? { ...existing } : {};
  let changed = false;
  if (typeof cfg.localToken !== 'string' || !cfg.localToken.trim()) {
    cfg.localToken = (typeof cfg.token === 'string' && cfg.token.trim())
      ? cfg.token.trim()
      : crypto.randomBytes(24).toString('hex');
    changed = true;
  }
  if (typeof cfg.token !== 'string' || !cfg.token.trim()) {
    cfg.token = cfg.localToken;
    changed = true;
  }
  const diskSettings = readDiskSettings(host);
  const diskLegacy = normalizeTunnelHostname(diskSettings?.tunnelHostname);
  if (diskLegacy && diskLegacy !== cfg.legacyTunnelHostname) {
    cfg.legacyTunnelHostname = diskLegacy;
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

function readNotificationSetting(settings) {
  return Boolean(settings?.enableNotifications);
}

function readUiSettingsSnapshot(settings) {
  return {
    theme: settings?.theme,
    colorTheme: settings?.colorTheme,
    drawerSpeed: settings?.drawerSpeed,
    enableNotifications: readNotificationSetting(settings)
  };
}

function buildPublicStatus(runtime) {
  const port = runtime.webServer?.port || null;
  const access = runtime.webServer?.getAccessStatus ? runtime.webServer.getAccessStatus() : null;
  const enableNotifications = runtime.webServer?.getEnableNotifications
    ? Boolean(runtime.webServer.getEnableNotifications())
    : Boolean(runtime.webServer?.enableNotifications);
  return {
    ok: true,
    running: Boolean(runtime.webServer && port),
    host: runtime.webServer?.host || '127.0.0.1',
    port,
    url: runtime.webServer?.getLocalUrl() || '',
    channels: access?.channels || {},
    activeChannels: access?.activeChannels || [],
    urls: access?.urls || {},
    channelEndpoints: access?.channelEndpoints || {},
    primaryChannel: access?.primaryChannel || 'offline',
    primaryUrl: access?.primaryUrl || '',
    permissionLevel: access?.permissionLevel || 'L0',
    allowRemoteWrite: access?.allowRemoteWrite || false,
    tunnelHostname: access?.tunnelHostname || '',
    cloudflareState: access?.cloudflareState || null,
    enableNotifications,
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
  const localToken = webConfig.localToken || webConfig.token;
  const localConfirmSecret = crypto.randomBytes(32).toString('hex');
  let runtimeAccess = readAccessSettings(settings);
  let runtimeEnableNotifications = readNotificationSetting(settings);
  let lastUiSettingsJson = JSON.stringify(readUiSettingsSnapshot(settings));

  let runtime = null;
  const workspaceOrg = resolveWorkspaceOrg(host);
  const worktreeDiscovery = host?.workspaceOrg?.worktreeDiscovery
    || workspaceOrg.createWorktreeDiscoveryService();
  const sessionOrgBridge = createSessionOrgBridge({
    host,
    pluginId: 'agy-daddy.web',
    worktreeDiscovery,
    onOrgChanged: (_org, summary) => {
      if (typeof host?.state?.set === 'function') {
        host.state.set('state:session.org@1', summary);
      }
      if (runtime && activeRuntime === runtime && runtime.webServer) {
        runtime.webServer.broadcast('state.patch', {
          key: 'state:session.org@1',
          value: summary
        });
        runtime.webServer.broadcast('org.updated', summary);
      }
    },
    onExternalOrgChanged: (_org, summary) => {
      if (runtime && activeRuntime === runtime && runtime.webServer) {
        runtime.webServer.broadcast('state.patch', {
          key: 'state:session.org@1',
          value: summary
        });
        runtime.webServer.broadcast('org.updated', summary);
      }
    }
  });
  const workspaceMetaStore = createWorkspaceMetaStore({
    storage: host.storage,
    sessionOrgBridge,
    worktreeDiscovery
  });
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
    const seeds = deduplicateSafeRoots([
      ...getConfiguredAllowedRoots(),
      ...workspaceMetaStore.getProjectRootPaths(),
      defaultSessionPath,
      ...discoveredSessionRoots
    ]);
    return worktreeDiscovery
      ? worktreeDiscovery.getAuthorizedWorktreeRoots(seeds)
      : seeds;
  }

  const brainDir = typeof settings.brainDir === 'string' && settings.brainDir.trim()
    ? settings.brainDir.trim()
    : (process.env.AGY_DADDY_BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity', 'brain'));
  const staticDir = path.resolve(__dirname, '..', 'dist', 'web');

  const harnessAdapter = createHarnessAdapter({ rpc: host.rpc });
  const workspaceService = createWorkspaceService({
    getAllowedRoots,
    brainDir,
    worktreeDiscovery,
    hasRunningSessionInPath: async (targetPath) => {
      if (ptyManager && typeof ptyManager.listSessions === 'function') {
        const ptys = ptyManager.listSessions({ cwd: targetPath });
        if (ptys.length > 0) return true;
      }
      try {
        const listRes = await harnessAdapter.listSessions({ limit: 500 });
        const sessions = Array.isArray(listRes?.sessions) ? listRes.sessions : [];
        return sessions.some((s) => {
          const st = String(s?.status || '');
          const running = Boolean(s?.isRunning || /RUNNING|GENERATING/i.test(st) || s?.notFullyIdle);
          if (!running) return false;
          const rawWs = s.workspacePath || s.workspaceUri || '';
          const normWs = workspaceOrg.normalizeLocalPath(rawWs);
          const normTarget = workspaceOrg.normalizeLocalPath(targetPath);
          return Boolean(normWs && normTarget && workspaceOrg.isSameOrInside(normWs, normTarget));
        });
      } catch {
        return false;
      }
    }
  });
  const workspaceBrowser = createWorkspaceBrowser({
    getDefaultSessionPath: () => workspaceMetaStore.getState().defaultSessionPath,
    getProjectRootPaths: () => workspaceMetaStore.getProjectRootPaths()
  });
  const remoteProvisioner = createRemoteProjectProvisioner({
    getProjectRootPaths: () => workspaceMetaStore.getProjectRootPaths(),
    checkDuplicateProjectFn: (target) => {
      const rawRoot = typeof target === 'string' ? target : target?.rootPath;
      const norm = normalizeLocalPath(rawRoot);
      if (!norm) return null;
      const key = IS_CASE_INSENSITIVE_FS ? norm.toLowerCase() : norm;
      const listed = workspaceMetaStore.listProjectsAndGroups([]);
      return (listed.projects || []).find((p) => {
        const pk = p?.rootPath ? (IS_CASE_INSENSITIVE_FS ? p.rootPath.toLowerCase() : p.rootPath) : '';
        return pk && pk === key;
      }) || null;
    },
    createProjectFn: (payload) => workspaceMetaStore.createProject(payload),
    authorizeRootFn: () => {
      refreshSessionRoots();
      return { ok: true };
    },
    onJobUpdated: (job) => {
      if (runtime && activeRuntime === runtime && runtime.webServer) {
        runtime.webServer.broadcast('project.job', job);
      }
    }
  });
  let ptyManager = null;
  let sideChatService = null;
  let taskManager = null;

  runtime = {
    host,
    webConfig,
    localToken,
    localConfirmSecret,
    pairingToken: localToken,
    confirmSecret: localConfirmSecret,
    proxySecret: '',
    authEpoch: 1,
    tokenSource: 'local',
    legacyTunnelHostname: normalizeTunnelHostname(webConfig.legacyTunnelHostname || runtimeAccess.tunnelHostname),
    effectiveTunnelHostname: normalizeTunnelHostname(runtimeAccess.tunnelHostname || webConfig.legacyTunnelHostname),
    effectiveMountPath: '',
    cloudflareState: null,
    lastHubOrigin: null,
    harnessAdapter,
    workspaceService,
    workspaceBrowser,
    remoteProvisioner,
    workspaceMetaStore,
    sessionOrgBridge,
    ptyManager: null,
    sideChatService: null,
    taskManager: null,
    hostProxy: null,
    webServer: null,
    disposeOnAny: null,
    disposeSettings: null,
    disposeService: null
  };
  activeRuntime = runtime;

  const getStatus = () => ({
    ...buildPublicStatus(runtime),
    authUrls: runtime.webServer?.getChannelUrls({ includeToken: true }) || {},
    pairingUrl: runtime.webServer?.getPairingUrl() || '',
    pairingToken: runtime.pairingToken
  });

  function persistWebConfigToken(nextToken, extra = {}) {
    if (typeof host?.storage?.writeJson !== 'function') return;
    runtime.webConfig = {
      ...runtime.webConfig,
      localToken: runtime.localToken,
      token: nextToken,
      ...(runtime.legacyTunnelHostname ? { legacyTunnelHostname: runtime.legacyTunnelHostname } : {}),
      ...(runtime.webServer?.port ? { port: runtime.webServer.port } : {}),
      ...extra,
      updatedAt: new Date().toISOString()
    };
    host.storage.writeJson('web-config.json', runtime.webConfig);
  }

  function computeCloudflareState(bundle, remoteDeactivated = false) {
    const cfEnabledInWeb = Boolean(runtimeAccess.channels.cloudflare);
    const remoteOnline = Boolean(bundle && bundle.ok && bundle.available && !remoteDeactivated);
    if (remoteOnline) {
      const pubOrigin = normalizeTunnelHostname(bundle.tunnelPublicOrigin);
      const tunnelMode = bundle.tunnelMode === 'named' ? 'named' : 'quick';
      if (bundle.cloudflareEnabled) {
        if (pubOrigin) {
          if (cfEnabledInWeb) {
            return {
              state: {
                mode: 'shared_ready',
                tunnelMode,
                publicOrigin: pubOrigin,
                mountPath: '/pc',
                reasonCode: 'OK',
                tokenSource: 'remote'
              },
              tunnelHostname: pubOrigin,
              mountPath: '/pc'
            };
          }
          return {
            state: {
              mode: 'web_disabled',
              tunnelMode,
              publicOrigin: '',
              mountPath: '/pc',
              reasonCode: 'WEB_CLOUDFLARE_OFF',
              tokenSource: 'remote'
            },
            tunnelHostname: '',
            mountPath: '/pc'
          };
        }
        if (cfEnabledInWeb) {
          const errCode = String(bundle.tunnelConfigError || bundle.tunnelState?.error || '').trim();
          return {
            state: {
              mode: errCode ? 'remote_error' : 'remote_pending',
              tunnelMode,
              publicOrigin: '',
              mountPath: '/pc',
              reasonCode: errCode || 'TUNNEL_STARTING',
              tokenSource: 'remote'
            },
            tunnelHostname: '',
            mountPath: '/pc'
          };
        }
        return {
          state: {
            mode: 'disabled',
            tunnelMode,
            publicOrigin: '',
            mountPath: '/pc',
            reasonCode: 'CHANNEL_DISABLED',
            tokenSource: 'remote'
          },
          tunnelHostname: '',
          mountPath: '/pc'
        };
      }

      if (cfEnabledInWeb) {
        return {
          state: {
            mode: 'remote_tunnel_off',
            tunnelMode,
            publicOrigin: '',
            mountPath: '/pc',
            reasonCode: 'REMOTE_CLOUDFLARE_OFF',
            tokenSource: 'remote'
          },
          tunnelHostname: '',
          mountPath: '/pc'
        };
      }
      return {
        state: {
          mode: 'disabled',
          tunnelMode,
          publicOrigin: '',
          mountPath: '/pc',
          reasonCode: 'CHANNEL_DISABLED',
          tokenSource: 'remote'
        },
        tunnelHostname: '',
        mountPath: '/pc'
      };
    }

    const legacyOrigin = normalizeTunnelHostname(runtimeAccess.tunnelHostname || runtime.legacyTunnelHostname);
    if (cfEnabledInWeb) {
      if (legacyOrigin) {
        return {
          state: {
            mode: 'legacy_standalone',
            tunnelMode: 'named',
            publicOrigin: legacyOrigin,
            mountPath: '/',
            reasonCode: 'LEGACY_HOSTNAME',
            tokenSource: 'local'
          },
          tunnelHostname: legacyOrigin,
          mountPath: ''
        };
      }
      return {
        state: {
          mode: 'remote_unavailable',
          tunnelMode: null,
          publicOrigin: '',
          mountPath: '/',
          reasonCode: 'REMOTE_PLUGIN_OFFLINE',
          tokenSource: 'local'
        },
        tunnelHostname: '',
        mountPath: ''
      };
    }

    return {
      state: {
        mode: 'disabled',
        tunnelMode: null,
        publicOrigin: '',
        mountPath: '/',
        reasonCode: 'CHANNEL_DISABLED',
        tokenSource: 'local'
      },
      tunnelHostname: legacyOrigin,
      mountPath: ''
    };
  }

  let syncChain = Promise.resolve();

  async function runSyncWithRemoteService(statusEventPayload = null) {
    if (activeRuntime !== runtime) return;
    const remoteDeactivated = Boolean(
      statusEventPayload &&
      typeof statusEventPayload === 'object' &&
      statusEventPayload.deactivated === true &&
      statusEventPayload.running === false
    );

    let bundle = null;
    if (!remoteDeactivated && typeof host?.services?.call === 'function') {
      try {
        const res = await host.services.call('remote', 'getSharedAuthBundle', [], { optional: true });
        if (res?.ok && res.value?.available && res.value?.ok) {
          bundle = res.value;
        }
      } catch {}
    }

    const computed = computeCloudflareState(bundle, remoteDeactivated);
    runtime.cloudflareState = computed.state;
    runtime.effectiveTunnelHostname = computed.tunnelHostname;
    runtime.effectiveMountPath = computed.mountPath;

    if (bundle && !remoteDeactivated) {
      const nextToken = typeof bundle.token === 'string' && bundle.token ? bundle.token : runtime.localToken;
      const nextConfirm = typeof bundle.confirmSecret === 'string' && bundle.confirmSecret
        ? bundle.confirmSecret
        : runtime.localConfirmSecret;
      const nextProxySecret = typeof bundle.proxySecret === 'string' ? bundle.proxySecret : '';
      const nextEpoch = Number.isInteger(bundle.authEpoch) ? bundle.authEpoch : runtime.authEpoch;
      const shouldRotateRemote = runtime.tokenSource === 'remote' && (
        runtime.pairingToken !== nextToken ||
        runtime.authEpoch !== nextEpoch
      );
      const tokenChanged = runtime.pairingToken !== nextToken || runtime.tokenSource !== 'remote';

      runtime.pairingToken = nextToken;
      runtime.confirmSecret = nextConfirm;
      runtime.proxySecret = nextProxySecret;
      runtime.authEpoch = nextEpoch;
      runtime.tokenSource = 'remote';

      if (runtime.webServer) {
        runtime.webServer.setAuthMaterial({
          pairingToken: nextToken,
          confirmSecret: nextConfirm,
          proxySecret: nextProxySecret,
          authEpoch: nextEpoch,
          tokenSource: 'remote',
          rotateRemoteSession: shouldRotateRemote
        });
        runtime.webServer.tunnelHostname = computed.tunnelHostname;
        runtime.webServer.cloudflareMountPath = computed.mountPath;
        runtime.webServer.cloudflareState = computed.state;
      }
      if (tokenChanged) {
        persistWebConfigToken(nextToken);
      }
    } else {
      const wasRemote = runtime.tokenSource === 'remote';
      runtime.pairingToken = runtime.localToken;
      runtime.confirmSecret = runtime.localConfirmSecret;
      runtime.proxySecret = '';
      runtime.tokenSource = 'local';

      if (runtime.webServer) {
        runtime.webServer.setAuthMaterial({
          pairingToken: runtime.localToken,
          confirmSecret: runtime.localConfirmSecret,
          proxySecret: '',
          tokenSource: 'local',
          rotateRemoteSession: wasRemote
        });
        runtime.webServer.tunnelHostname = computed.tunnelHostname;
        runtime.webServer.cloudflareMountPath = computed.mountPath;
        runtime.webServer.cloudflareState = computed.state;
      }
      if (wasRemote) {
        persistWebConfigToken(runtime.localToken);
      }
    }

    if (runtime.webServer?.server) {
      publishStatus();
    }
  }

  function syncWithRemoteService(statusEventPayload = null) {
    syncChain = syncChain.then(
      () => runSyncWithRemoteService(statusEventPayload),
      () => runSyncWithRemoteService(statusEventPayload)
    );
    return syncChain;
  }

  let lastPublishedStatusJson = '';

  function publishStatus() {
    const st = buildPublicStatus(runtime);
    const serialized = JSON.stringify(st);
    if (serialized !== lastPublishedStatusJson) {
      lastPublishedStatusJson = serialized;
      if (typeof host?.state?.set === 'function') {
        host.state.set('state:web.status@1', st);
      }
    }
    return st;
  }

  let reconcileChain = Promise.resolve();

  /**
   * Apply a settings change to the live server inside a serial Promise chain.
   * Only a change that alters the listen address needs a rebind; if starting
   * on the new address fails, roll back to `previousHost` and resume listening.
   */
  async function runReconcileAccess() {
    if (activeRuntime !== runtime || !runtime.webServer) return;
    const latestSettings = readStoredSettings(host);
    const next = readAccessSettings(latestSettings);
    const nextEnableNotifications = readNotificationSetting(latestSettings);
    const nextUiSettings = readUiSettingsSnapshot(latestSettings);
    const nextUiSettingsJson = JSON.stringify(nextUiSettings);
    if (nextEnableNotifications !== runtimeEnableNotifications) {
      runtimeEnableNotifications = nextEnableNotifications;
      runtime.webServer.updateNotificationConfig?.({ enableNotifications: nextEnableNotifications });
    }
    if (nextUiSettingsJson !== lastUiSettingsJson) {
      lastUiSettingsJson = nextUiSettingsJson;
      runtime.webServer.broadcast('state.patch', {
        key: 'state:plugin.settings@1',
        value: {
          pluginId: 'agy-daddy.web',
          values: nextUiSettings,
          updatedAt: Date.now()
        }
      });
    }
    const previousAccess = {
      ...runtimeAccess,
      channels: { ...runtimeAccess.channels }
    };
    const previousHost = runtime.webServer.host;
    const previousBindHostMode = runtime.webServer.bindHostMode;
    const previousChannels = { ...runtime.webServer.channels };
    const previousPermissionLevel = runtime.webServer.permissionLevel;
    const previousTunnelHostname = runtime.effectiveTunnelHostname;
    const previousMountPath = runtime.effectiveMountPath;
    const previousCloudflareState = runtime.cloudflareState;
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
    await syncWithRemoteService();
    if (!result.rebind || result.host === previousHost || !runtime.webServer.server) {
      publishStatus();
      return;
    }
    if (runtime.webServer.requestedPort === 0 && runtime.webServer.port > 0) {
      runtime.webServer.requestedPort = runtime.webServer.port;
    }
    try {
      await runtime.webServer.stop();
      if (activeRuntime !== runtime || !runtime.webServer) return;
      await runtime.webServer.start();
    } catch {
      if (activeRuntime !== runtime || !runtime.webServer) return;
      runtimeAccess = previousAccess;
      runtime.effectiveTunnelHostname = previousTunnelHostname;
      runtime.effectiveMountPath = previousMountPath;
      runtime.cloudflareState = previousCloudflareState;
      runtime.webServer.host = previousHost;
      runtime.webServer.bindHostMode = previousBindHostMode;
      runtime.webServer.channels = previousChannels;
      runtime.webServer.permissionLevel = previousPermissionLevel;
      runtime.webServer.tunnelHostname = previousTunnelHostname;
      runtime.webServer.cloudflareMountPath = previousMountPath;
      runtime.webServer.cloudflareState = previousCloudflareState;
      try {
        await runtime.webServer.start();
      } catch {}
    }
    if (activeRuntime === runtime && runtime.webServer) {
      publishStatus();
    }
  }

  function reconcileAccess() {
    reconcileChain = reconcileChain.then(runReconcileAccess, runReconcileAccess);
    return reconcileChain;
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

  await syncWithRemoteService();

  ptyManager = createPtyManager({
    allowedRoots: getAllowedRoots,
    defaultCwd: () => workspaceMetaStore.getState().defaultSessionPath || getAllowedRoots()[0] || '',
    worktreeDiscovery,
    onTaskUpdated: (ev) => {
      runtime.webServer?.broadcast('task.updated', ev);
    }
  });
  sideChatService = createSideChatService({
    rpc: host.rpc,
    harnessAdapter
  });
  taskManager = createTaskManager({
    rpc: host.rpc,
    harnessAdapter,
    ptyManager,
    workspaceMetaStore,
    worktreeDiscovery
  });
  runtime.ptyManager = ptyManager;
  runtime.sideChatService = sideChatService;
  runtime.taskManager = taskManager;
  runtime.disposeWorktreeSub = worktreeDiscovery.onWorktreeUpdated((payload) => {
    runtime.webServer?.broadcast('worktree.updated', payload);
  });

  runtime.webServer = createWebServer({
    host: resolveBindHost({ channels: runtimeAccess.channels, mode: runtimeAccess.bindHostMode }),
    bindHostMode: runtimeAccess.bindHostMode,
    channels: runtimeAccess.channels,
    permissionLevel: runtimeAccess.permissionLevel,
    tunnelHostname: runtime.effectiveTunnelHostname,
    cloudflareMountPath: runtime.effectiveMountPath,
    cloudflareState: runtime.cloudflareState,
    getChannels: () => runtimeAccess.channels,
    getPermissionLevel: () => runtimeAccess.permissionLevel,
    getTunnelHostname: () => runtime.effectiveTunnelHostname,
    getCloudflareMountPath: () => runtime.effectiveMountPath,
    getCloudflareState: () => runtime.cloudflareState,
    enableNotifications: runtimeEnableNotifications,
    getEnableNotifications: () => runtimeEnableNotifications,
    port: listenPort,
    pairingToken: runtime.pairingToken,
    confirmSecret: runtime.confirmSecret,
    proxySecret: runtime.proxySecret,
    authEpoch: runtime.authEpoch,
    tokenSource: runtime.tokenSource,
    pluginVersion: PLUGIN_VERSION,
    staticDir,
    harnessAdapter,
    workspaceService,
    workspaceBrowser,
    remoteProvisioner,
    workspaceMetaStore,
    sessionOrgBridge,
    worktreeDiscovery,
    ptyManager,
    sideChatService,
    taskManager,
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

    persistWebConfigToken(runtime.pairingToken, { port: startInfo.port });

    if (typeof host?.events?.onAny === 'function') {
      runtime.disposeOnAny = host.events.onAny((ev) => {
        if (!runtime.webServer || !ev) return;
        if (ev.kind === 'state') {
          if (ev.topicOrKey === 'state:web.status@1') return;
          if (ev.topicOrKey === 'state:remote.status@1') {
            void syncWithRemoteService(ev.payload);
            runtime.webServer.broadcast('state.patch', {
              key: ev.topicOrKey,
              value: ev.payload,
              meta: ev.meta
            });
            return;
          }
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
          if (ev.topicOrKey === 'state:session.org@1') {
            if (ev.meta?.publisher !== 'agy-daddy.web') {
              sessionOrgBridge.syncFromExternalSignal(ev.payload);
            }
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
        deleteSession: (cascadeId) => harnessAdapter.deleteSession(cascadeId),
        approveStep: (cascadeId, stepIdx, decision, payload = {}) =>
          harnessAdapter.approveStep(cascadeId, stepIdx, decision, payload),
        answerQuestion: (cascadeId, stepIdx, answers, payload = {}) =>
          harnessAdapter.answerQuestion(cascadeId, stepIdx, answers, payload),
        listModels: () => harnessAdapter.listModels(),
        syncChannels: async (remoteChannels = {}) => {
          if (activeRuntime !== runtime || !runtime.webServer) {
            return { ok: false, error: 'WEB_SERVER_UNAVAILABLE' };
          }
          const src = remoteChannels && typeof remoteChannels === 'object' ? remoteChannels : {};
          const patch = {};
          for (const key of ['lan', 'tailscale', 'bonjour', 'cloudflare']) {
            if (src[key] === true) {
              patch[key] = true;
            }
          }
          if (Object.keys(patch).length > 0 && typeof host?.settings?.update === 'function') {
            await host.settings.update(patch);
          }
          await reconcileAccess();
          return getStatus();
        },
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

    publishStatus();
    if (typeof host?.state?.set === 'function') {
      host.state.set('state:session.readState@1', workspaceMetaStore.getReadStateSnapshot());
      host.state.set('state:session.org@1', buildOrgBusSummary(sessionOrgBridge.loadPersistedOrg(), 'agy-daddy.web'));
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
    if (typeof runtime.disposeWorktreeSub === 'function') {
      runtime.disposeWorktreeSub();
    }
  } catch {}
  runtime.disposeWorktreeSub = null;

  try {
    if (runtime.ptyManager) {
      runtime.ptyManager.disposeAll();
    }
  } catch {}
  runtime.ptyManager = null;

  try {
    if (runtime.sessionOrgBridge) {
      runtime.sessionOrgBridge.dispose?.();
    }
  } catch {}

  try {
    if (runtime.remoteProvisioner) {
      runtime.remoteProvisioner.dispose?.();
    }
  } catch {}

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
