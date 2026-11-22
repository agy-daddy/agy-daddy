'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getStateDir, getPluginDataDir, getLegacyStateDir, isTestMode } = require('./paths');
const { safeReadJsonSync, safeWriteJsonSync } = require('./storage');

const LEGACY_FILE_MAPPINGS = [
  { legacyFile: 'token-pricing-ledger.json', pluginId: 'agy-daddy.usage', targetFile: 'token-pricing-ledger.json' },
  { legacyFile: 'custom-plan.json', pluginId: 'agy-daddy.usage', targetFile: 'custom-plan.json' },
  { legacyFile: 'remote-config.json', pluginId: 'agy-daddy.remote', targetFile: 'remote-config.json' },
  { legacyFile: 'remote-tunnel-state.json', pluginId: 'agy-daddy.remote', targetFile: 'remote-tunnel-state.json' },
  { legacyFile: 'zh-translation-cache.json', pluginId: 'agy-daddy.zh-cn', targetFile: 'zh-translation-cache.json' },
  { legacyFile: 'custom-conversation-titles.json', pluginId: 'agy-daddy.zh-cn', targetFile: 'custom-conversation-titles.json' },
  { legacyFile: 'proxy.json', pluginId: 'agy-daddy.proxy', targetFile: 'proxy-legacy.json' }
];

function getMigrationMarkerPath(options = {}) {
  return path.join(getStateDir(options), '.migrated-from-legacy.json');
}

function migrateLegacyData(options = {}) {
  const legacyDir = getLegacyStateDir(options);
  const stateDir = getStateDir(options);
  const markerPath = getMigrationMarkerPath(options);

  if (!legacyDir || !fs.existsSync(legacyDir)) {
    return {
      ok: true,
      skipped: true,
      reason: 'legacy_dir_not_found',
      legacyDir,
      copied: []
    };
  }

  if (!options.force && fs.existsSync(markerPath)) {
    const prev = safeReadJsonSync(markerPath, null, { quarantineCorrupt: false });
    return {
      ok: true,
      skipped: true,
      alreadyMigrated: true,
      legacyDir,
      marker: prev.data,
      copied: []
    };
  }

  const dryRun = options.dryRun === true;
  const overwrite = options.overwrite === true;
  const plan = [];

  const queueJsonCopy = (srcPath, destPath, transformFn = null) => {
    if (!fs.existsSync(srcPath)) return;
    if (!overwrite && fs.existsSync(destPath)) {
      plan.push({ src: srcPath, dest: destPath, status: 'kept_existing' });
      return;
    }
    const readRes = safeReadJsonSync(srcPath, null, { quarantineCorrupt: false });
    if (!readRes.ok || readRes.data === null) {
      plan.push({ src: srcPath, dest: destPath, status: 'skipped_invalid', error: readRes.error });
      return;
    }
    const outData = typeof transformFn === 'function' ? transformFn(readRes.data) : readRes.data;
    if (!outData) return;
    if (!dryRun) {
      const writeRes = safeWriteJsonSync(destPath, outData);
      if (!writeRes.ok) {
        plan.push({ src: srcPath, dest: destPath, status: 'error', error: writeRes.error });
        return;
      }
    }
    plan.push({ src: srcPath, dest: destPath, status: dryRun ? 'would_copy' : 'copied' });
  };

  for (const map of LEGACY_FILE_MAPPINGS) {
    const src = path.join(legacyDir, map.legacyFile);
    const dest = path.join(getPluginDataDir(map.pluginId, options), map.targetFile);
    queueJsonCopy(src, dest);
  }

  // 拆分 modules.json 至 proxy 与 zh-cn 插件
  const modulesSrc = path.join(legacyDir, 'modules.json');
  if (fs.existsSync(modulesSrc)) {
    queueJsonCopy(
      modulesSrc,
      path.join(getPluginDataDir('agy-daddy.proxy', options), 'config.json'),
      (raw) => (raw?.modules?.proxy ? { ...raw.modules.proxy, migratedFrom: modulesSrc } : null)
    );
    queueJsonCopy(
      modulesSrc,
      path.join(getPluginDataDir('agy-daddy.zh-cn', options), 'config.json'),
      (raw) => (raw?.modules?.chinese ? { ...raw.modules.chinese, migratedFrom: modulesSrc } : null)
    );
  }

  // 拆分 settings.json 至底座与 cli / composer
  const settingsSrc = path.join(legacyDir, 'settings.json');
  if (fs.existsSync(settingsSrc)) {
    queueJsonCopy(settingsSrc, path.join(stateDir, 'host-settings.json'));
    queueJsonCopy(
      settingsSrc,
      path.join(getPluginDataDir('agy-daddy.cli', options), 'settings.json'),
      (raw) => {
        const ui = raw?.uiPreferences || {};
        return {
          terminalApp: ui.terminalApp || 'auto',
          customTerminalPath: ui.customTerminalPath || '',
          cliSkipPermissions: Boolean(ui.cliSkipPermissions),
          cliDefaultModel: ui.cliDefaultModel || '',
          cliMuxHost: ui.cliMuxHost || ''
        };
      }
    );
    queueJsonCopy(
      settingsSrc,
      path.join(getPluginDataDir('agy-daddy.composer', options), 'settings.json'),
      (raw) => {
        const ui = raw?.uiPreferences || {};
        return {
          quickPrompts: Array.isArray(ui.quickPrompts) ? ui.quickPrompts : null,
          autoAccept: ui.autoAccept === true,
          ghostSuggest: ui.ghostSuggest !== false,
          autoCompact: ui.autoCompact !== false
        };
      }
    );
  }

  const marker = {
    schemaVersion: 1,
    migratedAt: new Date().toISOString(),
    legacyDir,
    dryRun,
    items: plan
  };
  if (!dryRun) {
    safeWriteJsonSync(markerPath, marker);
  }

  return {
    ok: true,
    skipped: false,
    dryRun,
    legacyDir,
    copied: plan
  };
}

function detectLegacySuite(options = {}) {
  const home = options.homeDir || os.homedir();
  const user = (options.username || path.basename(home) || 'user').replace(/[^a-zA-Z0-9._-]/g, '');
  const launchAgentPath = options.launchAgentPath
    || path.join(home, 'Library', 'LaunchAgents', `com.${user}.ag-live-helper.plist`);
  const cliSymlinkPath = options.cliSymlinkPath
    || path.join(home, '.local', 'bin', 'ag-context-meter');
  const legacyDir = getLegacyStateDir(options);

  const launchAgentExists = Boolean(launchAgentPath && fs.existsSync(launchAgentPath));
  let cliSymlinkTarget = null;
  try {
    const lst = fs.lstatSync(cliSymlinkPath);
    if (lst.isSymbolicLink()) cliSymlinkTarget = fs.readlinkSync(cliSymlinkPath);
    else if (lst.isFile()) cliSymlinkTarget = cliSymlinkPath;
  } catch {}

  const runningLiveHostPids = [];
  let psOut = '';
  if (typeof options.psOutput === 'string') {
    psOut = options.psOutput;
  } else if (!isTestMode() && process.platform === 'darwin') {
    try {
      psOut = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {}
  }
  for (const line of psOut.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    if (/antigravity-suite\/live-host\.js/.test(m[2])) {
      runningLiveHostPids.push(Number(m[1]));
    }
  }

  return {
    detected: Boolean(launchAgentExists || cliSymlinkTarget || runningLiveHostPids.length || (legacyDir && fs.existsSync(legacyDir))),
    launchAgent: { exists: launchAgentExists, path: launchAgentPath },
    cliSymlink: { exists: Boolean(cliSymlinkTarget), path: cliSymlinkPath, target: cliSymlinkTarget },
    legacyStateDir: { exists: Boolean(legacyDir && fs.existsSync(legacyDir)), path: legacyDir },
    runningLiveHostPids
  };
}

module.exports = {
  LEGACY_FILE_MAPPINGS,
  getMigrationMarkerPath,
  migrateLegacyData,
  detectLegacySuite
};
