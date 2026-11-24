'use strict';

const path = require('path');
const {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_NO_PROXY,
  isTestMode,
  normalizeProxyUrl,
  redactProxyUrl,
  parseAndValidateProxyUrl,
  applyProxyEnvironment,
  buildCliProxyEnv,
  detectLoginShellProxyConflict,
  generateLaunchAgentPlist
} = require('./proxy-config');
const { LocalProxyGateway } = require('./gateway');
const { probeConnectivity } = require('./probe');

const MANAGED_SETTING_KEYS = [
  'gatewayEnabled',
  'mode',
  'upstreamUrl',
  'noProxy',
  'gatewayPort',
  'fallbackToDirectOnUpstreamError'
];

let activeGateway = null;
let disposers = [];
let applyChain = Promise.resolve();

function normalizeStoredConfig(rawCfg = {}, legacyCfg = null) {
  const merged = { ...(legacyCfg && typeof legacyCfg === 'object' ? legacyCfg : {}), ...(rawCfg && typeof rawCfg === 'object' ? rawCfg : {}) };
  const rawUpstream = merged.upstreamUrl || merged.httpProxy || merged.proxyUrl || '';
  const hasExplicitMode = merged.mode === 'upstream' || merged.mode === 'direct';
  const mode = hasExplicitMode
    ? merged.mode
    : (merged.enabled === true && rawUpstream ? 'upstream' : 'direct');

  const parsedPort = Number(merged.gatewayPort);
  const gatewayPort = Number.isInteger(parsedPort) && (parsedPort === 0 || (parsedPort >= 1024 && parsedPort <= 65535))
    ? parsedPort
    : DEFAULT_GATEWAY_PORT;

  return {
    gatewayEnabled: merged.gatewayEnabled !== false,
    mode,
    upstreamUrl: normalizeProxyUrl(rawUpstream),
    noProxy: merged.noProxy !== undefined ? String(merged.noProxy) : (merged.bypassList !== undefined ? String(merged.bypassList) : DEFAULT_NO_PROXY),
    gatewayPort,
    fallbackToDirectOnUpstreamError: Boolean(merged.fallbackToDirectOnUpstreamError)
  };
}

function buildPublicConfigView(cfg, gatewayStats = null) {
  return {
    gatewayEnabled: cfg.gatewayEnabled,
    mode: cfg.mode,
    upstreamUrl: redactProxyUrl(cfg.upstreamUrl),
    hasUpstream: Boolean(cfg.upstreamUrl),
    noProxy: cfg.noProxy,
    gatewayPort: gatewayStats?.port || cfg.gatewayPort,
    fallbackToDirectOnUpstreamError: cfg.fallbackToDirectOnUpstreamError,
    listening: Boolean(gatewayStats?.listening)
  };
}

function resolveListenPort(configuredPort, preferEphemeralInTest = false) {
  if (configuredPort === 0) return 0;
  if (preferEphemeralInTest && isTestMode() && configuredPort === DEFAULT_GATEWAY_PORT) {
    return 0;
  }
  return configuredPort;
}

async function activate(host) {
  let currentConfig = normalizeStoredConfig(host.settings.get());
  let syncingSettings = false;
  let pendingAsyncCount = 0;
  applyChain = Promise.resolve();

  if (currentConfig.gatewayEnabled) {
    const initPort = resolveListenPort(currentConfig.gatewayPort, true);
    activeGateway = new LocalProxyGateway({
      port: initPort,
      mode: currentConfig.mode,
      upstreamUrl: currentConfig.upstreamUrl,
      noProxy: currentConfig.noProxy,
      fallbackToDirectOnUpstreamError: currentConfig.fallbackToDirectOnUpstreamError
    });
    await activeGateway.start(initPort);
  }

  const getLocalGatewayUrl = () => {
    if (!activeGateway || !activeGateway.port) return '';
    return `http://127.0.0.1:${activeGateway.port}`;
  };

  const publishStatus = (notifyChange = false) => {
    const gwStats = activeGateway ? activeGateway.getStats() : null;
    const status = {
      ...buildPublicConfigView(currentConfig, gwStats),
      localGatewayUrl: getLocalGatewayUrl(),
      stats: gwStats
    };
    host.state.set('state:proxy.status@1', status);
    if (notifyChange) {
      host.events.emit('proxy:config-changed@1', status);
    }
    return status;
  };

  async function applyGatewayLifecycleAsync(candidate, { portChanged = false, preferEphemeralInTest = false } = {}) {
    const listenPort = resolveListenPort(candidate.gatewayPort, preferEphemeralInTest);
    if (candidate.gatewayEnabled === false) {
      if (activeGateway) {
        await activeGateway.stop();
        activeGateway = null;
      }
    } else if (!activeGateway) {
      activeGateway = new LocalProxyGateway({ ...candidate, port: listenPort });
      await activeGateway.start(listenPort);
    } else if (portChanged) {
      await activeGateway.stop();
      activeGateway = new LocalProxyGateway({ ...candidate, port: listenPort });
      await activeGateway.start(listenPort);
    } else {
      activeGateway.updateConfig(candidate);
    }
    currentConfig = { ...candidate };
    return publishStatus(true);
  }

  function applySettingsUpdate(nextValues, changedKeys = []) {
    const nextConfig = normalizeStoredConfig(nextValues);
    const portChanged = changedKeys.includes('gatewayPort') && nextConfig.gatewayPort !== currentConfig.gatewayPort;
    const enableChanged = nextConfig.gatewayEnabled !== currentConfig.gatewayEnabled;
    const needsLifecycleChange = enableChanged || portChanged || (nextConfig.gatewayEnabled && !activeGateway);

    if (!needsLifecycleChange && pendingAsyncCount === 0) {
      if (activeGateway) {
        activeGateway.updateConfig(nextConfig);
      }
      currentConfig = { ...nextConfig };
      publishStatus(true);
      return;
    }

    pendingAsyncCount++;
    applyChain = applyChain
      .then(async () => {
        await applyGatewayLifecycleAsync(nextConfig, {
          portChanged,
          preferEphemeralInTest: !portChanged
        });
      })
      .catch(() => {})
      .finally(() => {
        pendingAsyncCount = Math.max(0, pendingAsyncCount - 1);
      });
  }

  const stopSettingsSub = host.settings.onChange((nextValues, changedKeys) => {
    if (syncingSettings) return;
    applySettingsUpdate(nextValues, Array.isArray(changedKeys) ? changedKeys : []);
  });

  const serviceMethods = {
    getStatus() {
      return {
        ...buildPublicConfigView(currentConfig, activeGateway ? activeGateway.getStats() : null),
        localGatewayUrl: getLocalGatewayUrl(),
        stats: activeGateway ? activeGateway.getStats() : null
      };
    },
    getConfig() {
      return buildPublicConfigView(currentConfig, activeGateway ? activeGateway.getStats() : null);
    },
    async setConfig(nextPatch = {}) {
      await applyChain;
      const candidate = {
        ...currentConfig,
        ...nextPatch,
        upstreamUrl: nextPatch.upstreamUrl !== undefined
          ? normalizeProxyUrl(nextPatch.upstreamUrl)
          : currentConfig.upstreamUrl
      };
      if (candidate.mode === 'upstream') {
        const checked = parseAndValidateProxyUrl(candidate.upstreamUrl);
        if (!checked.ok) throw new Error(checked.error);
      } else if (candidate.upstreamUrl) {
        const checked = parseAndValidateProxyUrl(candidate.upstreamUrl);
        if (!checked.ok) throw new Error(checked.error);
      }

      const wantPort = nextPatch.gatewayPort !== undefined ? Number(nextPatch.gatewayPort) : currentConfig.gatewayPort;
      const portChanged = nextPatch.gatewayPort !== undefined && wantPort !== currentConfig.gatewayPort;
      candidate.gatewayPort = wantPort;

      const status = await applyGatewayLifecycleAsync(candidate, {
        portChanged,
        preferEphemeralInTest: !portChanged
      });

      const managedPatch = {};
      for (const k of MANAGED_SETTING_KEYS) {
        if (nextPatch[k] !== undefined) {
          if (k === 'gatewayPort' && (wantPort < 1024 || wantPort > 65535)) continue;
          managedPatch[k] = candidate[k];
        }
      }
      if (Object.keys(managedPatch).length > 0) {
        syncingSettings = true;
        try {
          await host.settings.update(managedPatch);
        } finally {
          syncingSettings = false;
        }
      }

      return status;
    },
    async switchMode(mode) {
      const nextMode = mode === 'upstream' || mode === 'direct'
        ? mode
        : (currentConfig.mode === 'upstream' ? 'direct' : 'upstream');
      return await serviceMethods.setConfig({ mode: nextMode });
    },
    async probe(opts = {}) {
      await applyChain;
      return await probeConnectivity({
        config: currentConfig,
        gatewayPort: activeGateway?.port || 0,
        targetUrl: opts.targetUrl,
        timeoutMs: opts.timeoutMs,
        shellEnvOutput: opts.shellEnvOutput
      });
    },
    getProxyUrl() {
      return getLocalGatewayUrl();
    },
    getCliEnv(baseEnv = {}) {
      const gwUrl = getLocalGatewayUrl();
      if (!gwUrl) return buildCliProxyEnv(baseEnv, { proxyOverride: { enabled: false } });
      return buildCliProxyEnv(baseEnv, {
        overrideExisting: true,
        proxyOverride: {
          enabled: true,
          httpProxy: gwUrl,
          allProxy: gwUrl,
          noProxy: 'localhost,127.0.0.1,::1'
        }
      });
    },
    detectShellConflicts(opts = {}) {
      return detectLoginShellProxyConflict(opts);
    },
    generateLaunchAgentPlist(opts = {}) {
      return generateLaunchAgentPlist({
        ...opts,
        gatewayScriptPath: opts.gatewayScriptPath || path.resolve(__dirname, 'gateway-bin.js'),
        port: opts.port || currentConfig.gatewayPort || DEFAULT_GATEWAY_PORT
      });
    }
  };

  const stopArgHook = host.hooks.register('hostLaunchArgs', () => {
    const gwUrl = getLocalGatewayUrl();
    if (!currentConfig.gatewayEnabled || !gwUrl) return [];
    return [`--proxy-server=${gwUrl}`, '--proxy-bypass-list=localhost;127.0.0.1;[::1];<local>'];
  });

  const stopEnvHook = host.hooks.register('hostLaunchEnv', () => {
    const gwUrl = getLocalGatewayUrl();
    if (!currentConfig.gatewayEnabled || !gwUrl) return {};
    return applyProxyEnvironment({}, {
      overrideExisting: true,
      proxyOverride: {
        enabled: true,
        httpProxy: gwUrl,
        allProxy: gwUrl,
        noProxy: 'localhost,127.0.0.1,::1'
      }
    });
  });

  const stopSvc = host.services.provide('proxy', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopStatusRoute = await host.bridge.registerRoute('/status', async () => serviceMethods.getStatus());
  const stopSwitchRoute = await host.bridge.registerRoute('/switch-mode', async (body) => await serviceMethods.switchMode(body?.mode));
  const stopProbeRoute = await host.bridge.registerRoute('/probe', async (body) => await serviceMethods.probe(body || {}));

  const stopSwitchCmd = host.commands.register('proxy.switch-mode', async (mode) => {
    const status = await serviceMethods.switchMode(mode);
    return {
      ...status,
      message: status.mode === 'upstream' ? '已切换至上游代理转发' : '已切换至直连模式'
    };
  });

  const stopProbeCmd = host.commands.register('proxy.probe', async (opts = {}) => {
    const res = await serviceMethods.probe(opts || {});
    return {
      ...res,
      message: res.ok ? '代理网关连通正常' : (res.error || '探测未通过')
    };
  });

  publishStatus(false);

  disposers.push(
    stopSettingsSub,
    stopArgHook,
    stopEnvHook,
    stopSvc,
    stopStatusRoute,
    stopSwitchRoute,
    stopProbeRoute,
    stopSwitchCmd,
    stopProbeCmd
  );
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
  try { await applyChain; } catch {}
  if (activeGateway) {
    await activeGateway.stop();
    activeGateway = null;
  }
}

module.exports = {
  normalizeStoredConfig,
  activate,
  deactivate
};
