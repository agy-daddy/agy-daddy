'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { HOST_API_VERSION } = require('../contracts/constants');
const { getStateDir, getPluginsDir } = require('./paths');
const { safeReadJsonSync, safeWriteJsonSync } = require('./storage');
const { resolveRuntime } = require('./runtime-resolver');
const { fetchHttpJsonLoopback, resolveActiveCdpTarget, inspectAntigravityHostProcess } = require('./cdp');
const { loadAnchorsRegistry } = require('./anchors');
const { listInstalledPlugins, readManifestFromDir } = require('./installer');
const { HostHealth } = require('./health-snapshot');

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
  s = s.replace(/\b(https?:\/\/)[^\s/@]+@/gi, '$1');
  s = s.replace(/\b((?:[\w-]*token|api[_-]?key|secret|password|authorization)\s*(?:=|:)\s*)(?:Bearer\s+)?[^\s,&;]+/gi, '$1<REDACTED>');
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

function sanitizeHostHealth(snapshot, options = {}) {
  const result = sanitizeDiagnosticData(snapshot, options);
  for (const target of [...result.cdp.targets.matched, ...result.cdp.targets.filtered]) {
    if (target.url === null) continue;
    try {
      const parsed = new URL(target.url);
      if (['http:', 'https:'].includes(parsed.protocol)) {
        target.url = parsed.origin + parsed.pathname;
      } else {
        target.url = parsed.protocol + '<REDACTED>';
      }
    } catch {
      target.url = '<REDACTED>';
    }
  }
  return result;
}

async function readRunningHostHealth(stateDir, lock) {
  const { data: session } = safeReadJsonSync(path.join(stateDir, '.live-session.json'), null, { quarantineCorrupt: false });
  if (!Number.isInteger(lock?.pid) || lock.pid <= 0 || lock.pid !== session?.pid ||
      !Number.isInteger(session?.port) || session.port < 1 || session.port > 65535) return null;
  try {
    process.kill(lock.pid, 0);
    const health = await fetchHttpJsonLoopback(session.port, '/diagnostics/health', 1200);
    if (health?.daemon?.pid === lock.pid && health.daemon.bridgePort === session.port &&
        health.antigravity && health.cdp && health.injection && Array.isArray(health.plugins) && health.fault) return health;
  } catch {}
  return null;
}

async function runDoctor(options = {}) {
  const stateDir = getStateDir(options);
  const pluginsDir = getPluginsDir(options);
  const runtime = resolveRuntime(options);
  const anchors = loadAnchorsRegistry({ stateDir, anchorsPath: options.anchorsPath });
  const installedPlugins = listInstalledPlugins(options);

  const daemonLockPath = path.join(stateDir, 'daemon.lock');
  let daemonLock = null;
  if (fs.existsSync(daemonLockPath)) {
    daemonLock = safeReadJsonSync(daemonLockPath, null, { quarantineCorrupt: false }).data;
  }
  let hostHealth = options.hostHealth || await readRunningHostHealth(stateDir, daemonLock);
  let hostProc = hostHealth?.antigravity;
  if (!hostHealth) {
    hostProc = inspectAntigravityHostProcess(options);
    const discovery = options.skipCdp ? {} : await resolveActiveCdpTarget({ timeoutMs: 1200, ...options });
    const plugins = installedPlugins.map((plugin) => {
      let manifest;
      if (plugin.installPath) {
        try { manifest = readManifestFromDir(plugin.installPath); } catch {}
      }
      const display = manifest?.displayName;
      const enabled = plugin.enabled !== false;
      return {
        id: plugin.id, name: (typeof display === 'string' ? display : display?.['zh-CN'] || display?.en) || plugin.id,
        enabled, manifest, nodeState: enabled ? (manifest && !manifest.main ? 'not_applicable' : 'inactive') : 'disabled',
        lastError: null, lastErrorStack: null
      };
    });
    const health = new HostHealth({ ...options, stateDir, getPlugins: () => plugins });
    health.observe(hostProc, discovery);
    hostHealth = sanitizeHostHealth(health.snapshot(), options);
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
    hostHealth,
    antigravity: {
      hostProcess: hostProc,
      cdpPort: options.cdpSnapshot?.port || hostHealth.cdp.port,
      cdpTargetsCount: options.cdpSnapshot?.targetsCount || hostHealth.cdp.targets.matched.length
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
  const sanitized = {
    ...sanitizeDiagnosticData(rawReport, options),
    hostHealth: sanitizeHostHealth(rawReport.hostHealth, options)
  };
  const writeRes = safeWriteJsonSync(outputPath, sanitized);
  return { ...writeRes, path: writeRes.path || path.resolve(outputPath), bundle: sanitized, report: sanitized };
}

module.exports = {
  sanitizeDiagnosticData,
  sanitizeHostHealth,
  runDoctor,
  exportDiagnosticBundle
};
