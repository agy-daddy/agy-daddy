'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { HOST_API_VERSION } = require('../contracts/constants');
const { getStateDir, getPluginsDir } = require('./paths');
const { safeReadJsonSync, safeWriteJsonSync } = require('./storage');
const { resolveRuntime } = require('./runtime-resolver');
const { resolveActiveCdpTarget, inspectAntigravityHostProcess } = require('./cdp');
const { loadAnchorsRegistry } = require('./anchors');
const { listInstalledPlugins } = require('./installer');

function sanitizeString(raw, homeDir, extraSecrets = []) {
  let s = String(raw);
  const home = homeDir || os.homedir();
  const user = path.basename(home);
  if (home) {
    s = s.split(home).join('<HOME>');
  }
  if (user && user.length >= 2) {
    s = s.replace(new RegExp(`(/Users/|/home/|\\\\Users\\\\)${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '$1<USER>');
  }
  for (const sec of extraSecrets) {
    if (sec && typeof sec === 'string' && sec.length >= 8) {
      s = s.split(sec).join('<REDACTED>');
    }
  }
  s = s.replace(/\b[0-9a-f]{48,64}\b/gi, '<REDACTED_HEX>');
  return s;
}

const SENSITIVE_KEY_RE = /^(?:token|hostToken|csrfToken|secret|password|tunnelToken|authorization|cookie)$/i;

function sanitizeDiagnosticData(input, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const extraSecrets = Array.isArray(options.extraSecrets) ? options.extraSecrets : [];

  function walk(val, key = '') {
    if (key && SENSITIVE_KEY_RE.test(key)) {
      return val ? '<REDACTED>' : val;
    }
    if (typeof val === 'string') {
      return sanitizeString(val, homeDir, extraSecrets);
    }
    if (Array.isArray(val)) {
      return val.map((item) => walk(item, ''));
    }
    if (val && typeof val === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        out[k] = walk(v, k);
      }
      return out;
    }
    return val;
  }

  return walk(input);
}

async function runDoctor(options = {}) {
  const stateDir = getStateDir(options);
  const pluginsDir = getPluginsDir(options);
  const runtime = resolveRuntime(options);
  const hostProc = inspectAntigravityHostProcess(options);
  const cdpSnap = options.cdpSnapshot && typeof options.cdpSnapshot === 'object' ? options.cdpSnapshot : null;
  const hasCdpSnapshot = Boolean(cdpSnap && (cdpSnap.port || Number(cdpSnap.targetsCount) > 0));
  const cdp = hasCdpSnapshot
    ? {
        port: cdpSnap.port ? Number(cdpSnap.port) : null,
        targetsCount: Number(cdpSnap.targetsCount) || (Array.isArray(cdpSnap.targets) ? cdpSnap.targets.length : 0)
      }
    : (options.skipCdp
        ? { port: null, targets: [] }
        : await resolveActiveCdpTarget({ timeoutMs: 1200, ...options }).catch(() => ({ port: null, targets: [] })));
  const anchors = loadAnchorsRegistry({ stateDir, anchorsPath: options.anchorsPath });
  const installedPlugins = listInstalledPlugins(options);

  const daemonLockPath = path.join(stateDir, 'daemon.lock');
  let daemonLock = null;
  if (fs.existsSync(daemonLockPath)) {
    daemonLock = safeReadJsonSync(daemonLockPath, null, { quarantineCorrupt: false }).data;
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    hostApiVersion: HOST_API_VERSION,
    platform: process.platform,
    arch: process.arch,
    paths: {
      stateDir,
      pluginsDir
    },
    runtime,
    antigravity: {
      hostProcess: hostProc,
      cdpPort: cdp.port || null,
      cdpTargetsCount: Number.isFinite(cdp.targetsCount)
        ? cdp.targetsCount
        : (Array.isArray(cdp.targets) ? cdp.targets.length : 0)
    },
    anchors: {
      schemaVersion: anchors.schemaVersion || 1,
      count: Object.keys(anchors.anchors || {}).length,
      sourcePath: anchors.sourcePath
    },
    plugins: {
      count: installedPlugins.length,
      items: installedPlugins.map((p) => ({
        id: p.id,
        version: p.version,
        trustLevel: p.trustLevel,
        enabled: p.enabled,
        world: p.world,
        nodeIsolation: p.nodeIsolation
      }))
    },
    daemon: {
      lockPresent: Boolean(daemonLock),
      lock: daemonLock
    }
  };
}

async function exportDiagnosticBundle(outputPath, options = {}) {
  const rawReport = await runDoctor(options);
  const sanitized = sanitizeDiagnosticData(rawReport, options);
  const writeRes = safeWriteJsonSync(outputPath, sanitized);
  return { ...writeRes, path: writeRes.path || path.resolve(outputPath), bundle: sanitized, report: sanitized };
}

module.exports = {
  sanitizeDiagnosticData,
  runDoctor,
  exportDiagnosticBundle
};
