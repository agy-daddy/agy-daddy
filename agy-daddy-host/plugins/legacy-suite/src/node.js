'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCE_DIR = '/Volumes/external/Projects/antigravity-suite';

const OVERLAY_SPECS = [
  { key: 'meter', files: ['meter-core.js', 'meter-renderer.js'] },
  { key: 'enhancer', files: ['ag-enhancer-overlay.js'] },
  { key: 'pulse', files: ['pulse-capsule-overlay.js'] },
  { key: 'hans', files: ['antigravity-hans-overlay.js'] }
];

const FEATURE_FLAG_MASK_MAP = {
  tokens: 'showTopbarTokens',
  cli: 'showTopbarCli',
  quota: 'showTopbarQuota',
  remote: 'showTopbarRemote',
  composer: 'showComposerQuickBar',
  'chat-nav': 'showChatNavFloat'
};

const PLUGIN_TO_LEGACY_MASK_MAP = {
  'agy-daddy.proxy': ['proxy'],
  'agy-daddy.zh-cn': ['hans'],
  'agy-daddy.cli': ['cli'],
  'agy-daddy.context': ['pulse', 'tokens'],
  'agy-daddy.usage': ['meter'],
  'agy-daddy.chat-nav': ['chat-nav'],
  'agy-daddy.quota': ['quota'],
  'agy-daddy.composer': ['composer', 'enhancer'],
  'agy-daddy.remote': ['remote']
};

function isFullyRetired(activePluginIds = [], extraDisabled = []) {
  const masked = new Set(Array.isArray(extraDisabled) ? extraDisabled : []);
  for (const pid of Array.isArray(activePluginIds) ? activePluginIds : []) {
    const mapped = PLUGIN_TO_LEGACY_MASK_MAP[String(pid)];
    if (Array.isArray(mapped)) {
      for (const key of mapped) masked.add(key);
    }
  }
  const overlayKeys = OVERLAY_SPECS.map((s) => s.key);
  const featureKeys = ['proxy', ...Object.keys(FEATURE_FLAG_MASK_MAP)];
  const remainingOverlays = overlayKeys.filter((k) => !masked.has(k));
  const remainingFeatures = featureKeys.filter((k) => !masked.has(k));
  return {
    retired: remainingOverlays.length === 0 && remainingFeatures.length === 0,
    remainingOverlays,
    remainingFeatures,
    maskedKeys: Array.from(masked)
  };
}

function resolveSourceDir(host) {
  if (process.env.AGY_LEGACY_SUITE_DIR) {
    return path.resolve(process.env.AGY_LEGACY_SUITE_DIR);
  }
  const saved = host?.storage?.readJson('settings.json', {}).data || {};
  if (saved.sourceDir && typeof saved.sourceDir === 'string') {
    return path.resolve(saved.sourceDir);
  }
  return DEFAULT_SOURCE_DIR;
}

function buildFeatureMaskPrelude(disabledModules) {
  const disabled = new Set(Array.isArray(disabledModules) ? disabledModules : []);
  const overrides = {};
  for (const [modName, flagKey] of Object.entries(FEATURE_FLAG_MASK_MAP)) {
    if (disabled.has(modName)) {
      overrides[flagKey] = false;
    }
  }
  if (!Object.keys(overrides).length) return '';
  return `(function(){
    try {
      var cur = {};
      try { cur = JSON.parse(localStorage.getItem('ag_suite_feature_flags') || '{}') || {}; } catch {}
      Object.assign(cur, ${JSON.stringify(overrides)});
      localStorage.setItem('ag_suite_feature_flags', JSON.stringify(cur));
    } catch {}
  })();`;
}

function buildLegacyBundle(sourceDir, disabledModules = []) {
  const disabled = new Set(Array.isArray(disabledModules) ? disabledModules : []);
  const available = fs.existsSync(sourceDir);
  const parts = [];
  const included = [];
  const skipped = [];

  const prelude = buildFeatureMaskPrelude(disabledModules);
  if (prelude) parts.push({ key: 'feature-mask', code: prelude });

  for (const spec of OVERLAY_SPECS) {
    if (disabled.has(spec.key)) {
      skipped.push(spec.key);
      continue;
    }
    const fileCodes = [];
    let allExist = true;
    for (const rel of spec.files) {
      const full = path.join(sourceDir, rel);
      if (!fs.existsSync(full)) {
        allExist = false;
        break;
      }
      fileCodes.push(fs.readFileSync(full, 'utf8'));
    }
    if (allExist && fileCodes.length) {
      parts.push({ key: spec.key, files: spec.files, code: fileCodes.join('\n') });
      included.push(spec.key);
    } else {
      skipped.push(spec.key);
    }
  }

  return {
    ok: available,
    sourceDir,
    disabledModules: Array.from(disabled),
    included,
    skipped,
    parts
  };
}

let activeBridgeHandle = null;
let disposers = [];

async function activate(host) {
  const sourceDir = resolveSourceDir(host);
  let state = host.storage.readJson('settings.json', {}).data || {};
  let disabledModules = Array.isArray(state.disabledModules) ? state.disabledModules : [];

  const serviceMethods = {
    getStatus() {
      const bundle = buildLegacyBundle(sourceDir, disabledModules);
      return {
        sourceDir,
        sourceExists: fs.existsSync(sourceDir),
        disabledModules: [...disabledModules],
        included: bundle.included,
        skipped: bundle.skipped,
        embeddedBridgeActive: Boolean(activeBridgeHandle)
      };
    },
    getBundle(overrideDisabled) {
      const mask = Array.isArray(overrideDisabled) ? overrideDisabled : disabledModules;
      const bundle = buildLegacyBundle(sourceDir, mask);
      return {
        ok: bundle.ok,
        sourceDir: bundle.sourceDir,
        included: bundle.included,
        skipped: bundle.skipped,
        partsCount: bundle.parts.length,
        parts: bundle.parts.map((p) => ({ key: p.key, bytes: Buffer.byteLength(p.code, 'utf8'), code: p.code }))
      };
    },
    setDisabledModules(nextList = []) {
      disabledModules = Array.from(new Set(Array.isArray(nextList) ? nextList.map(String) : []));
      state = { ...state, sourceDir, disabledModules };
      host.storage.writeJson('settings.json', state);
      return { ok: true, disabledModules: [...disabledModules] };
    },
    reconcileWithActivePlugins(activePluginIds = []) {
      const autoMasked = [];
      for (const pid of Array.isArray(activePluginIds) ? activePluginIds : []) {
        const mapped = PLUGIN_TO_LEGACY_MASK_MAP[String(pid)];
        if (Array.isArray(mapped)) autoMasked.push(...mapped);
      }
      if (!autoMasked.length) {
        return { ok: true, disabledModules: [...disabledModules], autoMasked: [] };
      }
      const merged = Array.from(new Set([...disabledModules, ...autoMasked]));
      disabledModules = merged;
      state = { ...state, sourceDir, disabledModules: merged };
      host.storage.writeJson('settings.json', state);
      return { ok: true, disabledModules: [...merged], autoMasked: Array.from(new Set(autoMasked)) };
    },
    isFullyRetired(activePluginIds = []) {
      return isFullyRetired(activePluginIds, disabledModules);
    },
    async startLegacyBridge(options = {}) {
      if (activeBridgeHandle) return { ok: true, port: activeBridgeHandle.port };
      if (process.env.AGY_DADDY_TEST_MODE === '1' || options.dryRun) {
        return { ok: true, dryRun: true, port: 0 };
      }
      const liveHostPath = path.join(sourceDir, 'live-host.js');
      if (!fs.existsSync(liveHostPath)) {
        return { ok: false, error: `Missing ${liveHostPath}` };
      }
      const { startEmbeddedLiveBridge } = require(liveHostPath);
      activeBridgeHandle = await startEmbeddedLiveBridge({
        origin: options.origin || '',
        writeStamp: false,
        embedded: true,
        skipMobileRemote: Boolean(options.skipMobileRemote || disabledModules.includes('remote'))
      });
      return { ok: true, port: activeBridgeHandle.port };
    }
  };

  const stopSvc = host.services.provide('legacy-suite', serviceMethods, { realm: 'node', version: '1.0.0' });
  const stopStatusRoute = await host.bridge.registerRoute('/status', async () => serviceMethods.getStatus());
  const stopBundleRoute = await host.bridge.registerRoute('/bundle', async (body) => serviceMethods.getBundle(body?.disabledModules));
  const stopMaskRoute = await host.bridge.registerRoute('/set-mask', async (body) => serviceMethods.setDisabledModules(body?.disabledModules || []));

  disposers.push(stopSvc, stopStatusRoute, stopBundleRoute, stopMaskRoute);
}

async function deactivate() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
  if (activeBridgeHandle?.stop) {
    try { await activeBridgeHandle.stop({ preserveStamp: true }); } catch {}
    activeBridgeHandle = null;
  }
}

module.exports = {
  DEFAULT_SOURCE_DIR,
  OVERLAY_SPECS,
  FEATURE_FLAG_MASK_MAP,
  PLUGIN_TO_LEGACY_MASK_MAP,
  isFullyRetired,
  buildFeatureMaskPrelude,
  buildLegacyBundle,
  activate,
  deactivate
};
