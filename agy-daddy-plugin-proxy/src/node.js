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

let activeGateway = null;
let disposers = [];

function normalizeStoredConfig(rawCfg = {}, legacyCfg = null) {
  const merged = { ...(legacyCfg && typeof legacyCfg === 'object' ? legacyCfg : {}), ...(rawCfg && typeof rawCfg === 'object' ? rawCfg : {}) };
  const rawUpstream = merged.upstreamUrl || merged.httpProxy || merged.proxyUrl || '';
  const hasExplicitMode = merged.mode === 'upstream' || merged.mode === 'direct';
  const mode = hasExplicitMode
    ? merged.mode
    : (merged.enabled === true && rawUpstream ? 'upstream' : 'direct');

  const defaultPort = isTestMode() ? 0 : DEFAULT_GATEWAY_PORT;
  const gatewayPort = Number.isInteger(Number(merged.gatewayPort)) && (Number(merged.gatewayPort) === 0 || (Number(merged.gatewayPort) >= 1024 && Number(merged.gatewayPort) <= 65535))
    ? Number(merged.gatewayPort)
    : defaultPort;

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

async function activate(host) {
  const legacyRes = host.storage.readJson('proxy-legacy.json', null);
  const savedRes = host.storage.readJson('config.json', null);
  let currentConfig = normalizeStoredConfig(savedRes?.data, legacyRes?.data);

  if (currentConfig.gatewayEnabled) {
    activeGateway = new LocalProxyGateway({
      port: currentConfig.gatewayPort,
      mode: currentConfig.mode,
      upstreamUrl: currentConfig.upstreamUrl,
      noProxy: currentConfig.noProxy,
      fallbackToDirectOnUpstreamError: currentConfig.fallbackToDirectOnUpstreamError
    });
    await activeGateway.start(currentConfig.gatewayPort);
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
      if (candidate.gatewayEnabled === false && activeGateway) {
        await activeGateway.stop();
        activeGateway = null;
      } else if (candidate.gatewayEnabled !== false) {
        if (!activeGateway) {
          activeGateway = new LocalProxyGateway({ ...candidate, port: wantPort });
          await activeGateway.start(wantPort);
        } else if (nextPatch.gatewayPort !== undefined && wantPort !== currentConfig.gatewayPort) {
          await activeGateway.stop();
          activeGateway = new LocalProxyGateway({ ...candidate, port: wantPort });
          await activeGateway.start(wantPort);
        } else {
          activeGateway.updateConfig(candidate);
        }
      }

      currentConfig = { ...candidate, gatewayPort: wantPort };
      host.storage.writeJson('config.json', currentConfig);
      return publishStatus(true);
    },
    async switchMode(mode) {
      const nextMode = mode === 'upstream' || mode === 'direct'
        ? mode
        : (currentConfig.mode === 'upstream' ? 'direct' : 'upstream');
      return await serviceMethods.setConfig({ mode: nextMode });
    },
    async probe(opts = {}) {
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
    return [`--proxy-server=${gwUrl}`, '--proxy-bypass-list=<-loopback>'];
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
  const stopConfigRoute = await host.bridge.registerRoute('/config', async () => serviceMethods.getConfig());
  const stopSetConfigRoute = await host.bridge.registerRoute('/set-config', async (body) => await serviceMethods.setConfig(body || {}));
  const stopSwitchRoute = await host.bridge.registerRoute('/switch-mode', async (body) => await serviceMethods.switchMode(body?.mode));
  const stopProbeRoute = await host.bridge.registerRoute('/probe', async (body) => await serviceMethods.probe(body || {}));

  publishStatus(false);

  disposers.push(
    stopArgHook,
    stopEnvHook,
    stopSvc,
    stopStatusRoute,
    stopConfigRoute,
    stopSetConfigRoute,
    stopSwitchRoute,
    stopProbeRoute
  );
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
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
