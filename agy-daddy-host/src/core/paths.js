'use strict';

const os = require('os');
const path = require('path');

function isTestMode() {
  return process.env.AGY_DADDY_TEST_MODE === '1'
    || process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
    || (Array.isArray(process.execArgv) && process.execArgv.includes('--test'));
}

function assertSafePluginId(pluginId) {
  const clean = String(pluginId || '').trim();
  if (!clean || clean.includes('..') || clean.includes('/') || clean.includes('\\')) {
    throw new Error(`Invalid plugin id for path resolution: ${String(pluginId)}`);
  }
  return clean;
}

function getStateDir(options = {}) {
  if (options.stateDir) return path.resolve(options.stateDir);
  if (process.env.AGY_DADDY_STATE_DIR) return path.resolve(process.env.AGY_DADDY_STATE_DIR);
  if (isTestMode()) {
    return path.join(os.tmpdir(), `agy-daddy-test-state-${process.pid}`);
  }
  const home = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'AgyDaddy');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'AgyDaddy');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'agy-daddy');
}

function getPluginsDir(options = {}) {
  if (options.pluginsDir) return path.resolve(options.pluginsDir);
  if (process.env.AGY_DADDY_PLUGINS_DIR) return path.resolve(process.env.AGY_DADDY_PLUGINS_DIR);
  if (isTestMode()) {
    return path.join(getStateDir(options), 'plugins');
  }
  const home = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'AgyDaddy', 'plugins');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'agy-daddy', 'plugins');
}

function getPluginDataDir(pluginId, options = {}) {
  const safeId = assertSafePluginId(pluginId);
  return path.join(getStateDir(options), 'plugins-data', safeId);
}

function getHostSettingsPath(options = {}) {
  return path.join(getStateDir(options), 'host-settings.json');
}

module.exports = {
  isTestMode,
  assertSafePluginId,
  getStateDir,
  getPluginsDir,
  getPluginDataDir,
  getHostSettingsPath
};
