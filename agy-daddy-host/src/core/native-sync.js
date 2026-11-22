'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { isTestMode, getStateDir, getPluginDataDir, assertSafePluginId } = require('./paths');

function getDefaultNativePluginsDir(options = {}) {
  if (options.nativePluginsDir) return path.resolve(options.nativePluginsDir);
  if (process.env.AGY_DADDY_NATIVE_PLUGINS_DIR) return path.resolve(process.env.AGY_DADDY_NATIVE_PLUGINS_DIR);
  if (isTestMode()) {
    return path.join(getStateDir(options), 'native-plugins');
  }
  return path.join(os.homedir(), '.gemini', 'config', 'plugins');
}

function resolveNativePluginFolderName(pluginId) {
  const safeId = assertSafePluginId(pluginId);
  return safeId.startsWith('agy-daddy.') ? safeId.replace(/\./g, '-') : `agy-daddy-${safeId.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
}

function assertInsidePluginRoot(pluginRoot, targetPath) {
  const rootAbs = path.resolve(pluginRoot);
  const abs = path.resolve(pluginRoot, targetPath);
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : `${rootAbs}${path.sep}`;
  if (abs !== rootAbs && !abs.startsWith(prefix)) {
    throw new Error(`Unsafe native asset path escapes plugin root: ${targetPath}`);
  }
  return abs;
}

function syncPluginNativeArtifacts(pluginDir, manifest, options = {}) {
  const nativeSpec = manifest?.contributes?.native;
  if (!nativeSpec || typeof nativeSpec !== 'object') {
    return { ok: true, synced: false, reason: 'NO_NATIVE_CONTRIBUTES' };
  }

  const pluginId = assertSafePluginId(manifest.id);
  const granted = new Set(Array.isArray(options.grantedPermissions) ? options.grantedPermissions : []);
  if (!granted.has('native:install')) {
    return { ok: false, synced: false, reason: 'MISSING_NATIVE_INSTALL_PERMISSION' };
  }

  const nativeBase = getDefaultNativePluginsDir(options);
  const targetDir = path.join(nativeBase, resolveNativePluginFolderName(pluginId));
  fs.mkdirSync(targetDir, { recursive: true });

  const syncedAssets = { rules: [], skills: [], mcp: null, hooks: null };

  // 1. Rules (.md)
  if (Array.isArray(nativeSpec.rules) && nativeSpec.rules.length) {
    const rulesOutDir = path.join(targetDir, 'rules');
    fs.mkdirSync(rulesOutDir, { recursive: true });
    for (const rel of nativeSpec.rules) {
      const src = assertInsidePluginRoot(pluginDir, rel);
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        const dst = path.join(rulesOutDir, path.basename(src));
        fs.copyFileSync(src, dst);
        syncedAssets.rules.push(path.relative(targetDir, dst));
      }
    }
  }

  // 2. Skills (directories or SKILL.md files)
  if (Array.isArray(nativeSpec.skills) && nativeSpec.skills.length) {
    const skillsOutDir = path.join(targetDir, 'skills');
    fs.mkdirSync(skillsOutDir, { recursive: true });
    for (const rel of nativeSpec.skills) {
      const src = assertInsidePluginRoot(pluginDir, rel);
      if (!fs.existsSync(src)) continue;
      const st = fs.statSync(src);
      if (st.isDirectory()) {
        const subEntries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of subEntries) {
          const entryPath = path.join(src, entry.name);
          if (entry.isDirectory()) {
            const dstDir = path.join(skillsOutDir, entry.name);
            fs.cpSync(entryPath, dstDir, { recursive: true });
            syncedAssets.skills.push(path.relative(targetDir, dstDir));
          } else if (entry.name.endsWith('.md')) {
            const dstDir = path.join(skillsOutDir, path.basename(src));
            fs.mkdirSync(dstDir, { recursive: true });
            fs.copyFileSync(entryPath, path.join(dstDir, entry.name));
            syncedAssets.skills.push(path.relative(targetDir, dstDir));
          }
        }
      } else if (st.isFile()) {
        const skillName = path.basename(path.dirname(src)) || 'default';
        const dstDir = path.join(skillsOutDir, skillName);
        fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(src, path.join(dstDir, path.basename(src)));
        syncedAssets.skills.push(path.relative(targetDir, dstDir));
      }
    }
  }

  // 3. Hooks
  if (typeof nativeSpec.hooks === 'string' && nativeSpec.hooks.trim()) {
    const src = assertInsidePluginRoot(pluginDir, nativeSpec.hooks);
    if (fs.existsSync(src)) {
      const dst = path.join(targetDir, 'hooks.json');
      fs.copyFileSync(src, dst);
      syncedAssets.hooks = 'hooks.json';
    }
  }

  // 4. MCP Servers (resolve script paths & inject plugin data dir)
  if (typeof nativeSpec.mcp === 'string' && nativeSpec.mcp.trim()) {
    const src = assertInsidePluginRoot(pluginDir, nativeSpec.mcp);
    if (fs.existsSync(src)) {
      const rawCfg = JSON.parse(fs.readFileSync(src, 'utf8'));
      const dataDir = getPluginDataDir(pluginId, options);
      const serversOut = {};
      for (const [srvName, srvDef] of Object.entries(rawCfg.mcpServers || {})) {
        const args = (Array.isArray(srvDef.args) ? srvDef.args : []).map((arg) => {
          if (typeof arg === 'string' && (arg.startsWith('./') || arg.startsWith('../'))) {
            return assertInsidePluginRoot(pluginDir, arg);
          }
          return arg;
        });
        serversOut[srvName] = {
          ...srvDef,
          command: srvDef.command === 'node' ? (options.runtimePath || process.execPath) : srvDef.command,
          args,
          env: {
            ...(srvDef.env || {}),
            AGY_DADDY_PLUGIN_DATA_DIR: dataDir,
            AGY_DADDY_PLUGIN_ID: pluginId
          }
        };
      }
      const mcpJsonStr = JSON.stringify({ mcpServers: serversOut }, null, 2) + '\n';
      const mcpDst = path.join(targetDir, 'mcp.json');
      const mcpConfigDst = path.join(targetDir, 'mcp_config.json');
      fs.writeFileSync(mcpDst, mcpJsonStr, 'utf8');
      fs.writeFileSync(mcpConfigDst, mcpJsonStr, 'utf8');
      syncedAssets.mcp = 'mcp.json';
      syncedAssets.mcpConfig = 'mcp_config.json';
    }
  }

  const folderName = resolveNativePluginFolderName(pluginId);
  const displayName = (manifest.displayName && typeof manifest.displayName === 'object')
    ? (manifest.displayName['zh-CN'] || manifest.displayName.en || pluginId)
    : (manifest.displayName || pluginId);
  const description = (manifest.description && typeof manifest.description === 'object')
    ? (manifest.description['zh-CN'] || manifest.description.en || displayName)
    : (manifest.description || `${displayName} (synced by Agy-Daddy)`);

  const nativePluginMeta = {
    schemaVersion: 1,
    name: folderName,
    displayName,
    description,
    id: folderName,
    sourcePluginId: pluginId,
    version: manifest.version,
    managedBy: 'agy-daddy',
    syncedAt: new Date().toISOString(),
    assets: syncedAssets
  };
  fs.writeFileSync(path.join(targetDir, 'plugin.json'), JSON.stringify(nativePluginMeta, null, 2) + '\n', 'utf8');

  return {
    ok: true,
    synced: true,
    targetDir,
    assets: syncedAssets
  };
}

function removePluginNativeArtifacts(pluginId, options = {}) {
  const safeId = assertSafePluginId(pluginId);
  const nativeBase = getDefaultNativePluginsDir(options);
  const targetDir = path.join(nativeBase, resolveNativePluginFolderName(safeId));
  const existed = fs.existsSync(targetDir);
  if (existed) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  return { ok: true, removed: existed, targetDir };
}

module.exports = {
  getDefaultNativePluginsDir,
  resolveNativePluginFolderName,
  syncPluginNativeArtifacts,
  removePluginNativeArtifacts
};
