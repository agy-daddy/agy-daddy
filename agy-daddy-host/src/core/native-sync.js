'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { isTestMode, getStateDir, getPluginDataDir, assertSafePluginId } = require('./paths');

const NATIVE_ASSET_KINDS = Object.freeze(['rules', 'skills', 'mcp', 'hooks']);
const MAX_RULES_BACKUPS = 10;

function getDefaultNativePluginsDir(options = {}) {
  if (options.nativePluginsDir) return path.resolve(options.nativePluginsDir);
  if (process.env.AGY_DADDY_NATIVE_PLUGINS_DIR) return path.resolve(process.env.AGY_DADDY_NATIVE_PLUGINS_DIR);
  if (isTestMode()) {
    return path.join(getStateDir(options), 'native-plugins');
  }
  return path.join(os.homedir(), '.gemini', 'config', 'plugins');
}

function getNativeBackupsDir(pluginId, options = {}) {
  const safeId = assertSafePluginId(pluginId);
  return path.join(getStateDir(options), 'native-backups', safeId, 'rules');
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

function computeFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function walkFilesRel(dirPath, baseDir = dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const results = [];
  for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, ent.name);
    if (ent.isDirectory()) {
      results.push(...walkFilesRel(full, baseDir));
    } else if (ent.isFile()) {
      results.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return results.sort();
}

function extractDeclaredNativeSpec(manifest, pluginDir = null) {
  const nativeSpec = manifest?.contributes?.native;
  const declared = {
    hasNative: Boolean(nativeSpec && typeof nativeSpec === 'object'),
    rules: [],
    skills: [],
    mcp: [],
    hooks: []
  };
  if (!declared.hasNative) return declared;

  if (Array.isArray(nativeSpec.rules)) {
    for (const rel of nativeSpec.rules) {
      if (typeof rel === 'string' && rel.trim()) {
        declared.rules.push(path.basename(rel.trim()));
      }
    }
  }

  if (Array.isArray(nativeSpec.skills)) {
    for (const rel of nativeSpec.skills) {
      if (typeof rel !== 'string' || !rel.trim()) continue;
      const trimmed = rel.trim();
      if (pluginDir) {
        try {
          const src = assertInsidePluginRoot(pluginDir, trimmed);
          if (fs.existsSync(src)) {
            const st = fs.statSync(src);
            if (st.isDirectory()) {
              const subEntries = fs.readdirSync(src, { withFileTypes: true });
              let foundSub = false;
              for (const ent of subEntries) {
                if (ent.isDirectory()) {
                  declared.skills.push(ent.name);
                  foundSub = true;
                } else if (ent.name.endsWith('.md')) {
                  declared.skills.push(path.basename(src));
                  foundSub = true;
                  break;
                }
              }
              if (foundSub) continue;
            } else if (st.isFile()) {
              declared.skills.push(path.basename(path.dirname(src)) || path.basename(src));
              continue;
            }
          }
        } catch {}
      }
      declared.skills.push(path.basename(trimmed.replace(/\/+$/, '')) || trimmed);
    }
    declared.skills = Array.from(new Set(declared.skills));
  }

  if (typeof nativeSpec.mcp === 'string' && nativeSpec.mcp.trim()) {
    const trimmed = nativeSpec.mcp.trim();
    let parsedNames = [];
    if (pluginDir) {
      try {
        const src = assertInsidePluginRoot(pluginDir, trimmed);
        if (fs.existsSync(src)) {
          const rawCfg = JSON.parse(fs.readFileSync(src, 'utf8'));
          parsedNames = Object.keys(rawCfg?.mcpServers || {});
        }
      } catch {}
    }
    declared.mcp = parsedNames.length > 0 ? parsedNames : [path.basename(trimmed)];
  }

  if (typeof nativeSpec.hooks === 'string' && nativeSpec.hooks.trim()) {
    declared.hooks = [path.basename(nativeSpec.hooks.trim())];
  }

  return declared;
}

function normalizeNativeConfig(nativeSpec, rawConfig = null, defaultEnabled = true) {
  const hasSpec = Boolean(nativeSpec && typeof nativeSpec === 'object');
  const declaredFlags = {
    rules: Boolean(hasSpec && Array.isArray(nativeSpec.rules) && nativeSpec.rules.length > 0),
    skills: Boolean(hasSpec && Array.isArray(nativeSpec.skills) && nativeSpec.skills.length > 0),
    mcp: Boolean(hasSpec && typeof nativeSpec.mcp === 'string' && nativeSpec.mcp.trim()),
    hooks: Boolean(hasSpec && typeof nativeSpec.hooks === 'string' && nativeSpec.hooks.trim())
  };
  const cfg = {};
  for (const kind of NATIVE_ASSET_KINDS) {
    if (!declaredFlags[kind]) {
      cfg[kind] = false;
    } else if (rawConfig && typeof rawConfig === 'object' && typeof rawConfig[kind] === 'boolean') {
      cfg[kind] = rawConfig[kind];
    } else {
      cfg[kind] = Boolean(defaultEnabled);
    }
  }
  return cfg;
}

function listPluginRulesBackups(pluginId, options = {}) {
  const backupRoot = getNativeBackupsDir(pluginId, options);
  if (!fs.existsSync(backupRoot)) return [];
  const items = [];
  for (const ent of fs.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const metaPath = path.join(backupRoot, ent.name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta && typeof meta === 'object') {
        items.push({
          ...meta,
          backupId: meta.backupId || ent.name
        });
      }
    } catch {}
  }
  items.sort((a, b) => {
    const tA = Date.parse(a.createdAt || '') || 0;
    const tB = Date.parse(b.createdAt || '') || 0;
    if (tB !== tA) return tB - tA;
    return String(b.backupId || '').localeCompare(String(a.backupId || ''));
  });
  return items;
}

function pruneRulesBackups(backupRoot, maxKeep = MAX_RULES_BACKUPS) {
  if (!fs.existsSync(backupRoot)) return;
  const entries = [];
  for (const ent of fs.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dirPath = path.join(backupRoot, ent.name);
    const metaPath = path.join(dirPath, 'meta.json');
    let createdAtMs = 0;
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        createdAtMs = Date.parse(meta?.createdAt || '') || 0;
      }
    } catch {}
    if (!createdAtMs) {
      try { createdAtMs = fs.statSync(dirPath).mtimeMs || 0; } catch {}
    }
    entries.push({ name: ent.name, dirPath, createdAtMs });
  }
  entries.sort((a, b) => {
    if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
    return b.name.localeCompare(a.name);
  });
  for (let i = maxKeep; i < entries.length; i += 1) {
    try { fs.rmSync(entries[i].dirPath, { recursive: true, force: true }); } catch {}
  }
}

function backupPluginRules(pluginId, targetRulesDir, options = {}) {
  const safeId = assertSafePluginId(pluginId);
  const backupRoot = getNativeBackupsDir(safeId, options);
  const existedBefore = fs.existsSync(targetRulesDir) && fs.statSync(targetRulesDir).isDirectory();
  const relFiles = existedBefore ? walkFilesRel(targetRulesDir) : [];
  const existingFiles = relFiles.map((relPath) => ({
    relPath,
    sha256: computeFileSha256(path.join(targetRulesDir, relPath))
  }));

  const existingBackups = listPluginRulesBackups(safeId, options);
  if (Array.isArray(options.incomingFiles) && existedBefore && existingBackups.length > 0) {
    const incomingSorted = options.incomingFiles
      .map((f) => ({ relPath: String(f.name || f.relPath || ''), sha256: String(f.sha256 || '') }))
      .sort((a, b) => a.relPath.localeCompare(b.relPath));
    const sameLength = existingFiles.length === incomingSorted.length;
    const matchesAll = sameLength && existingFiles.every((f, idx) => (
      f.relPath === incomingSorted[idx].relPath && f.sha256 === incomingSorted[idx].sha256
    ));
    if (matchesAll) {
      return {
        created: false,
        skipped: true,
        reason: 'UNCHANGED',
        latestBackup: existingBackups[0]
      };
    }
  }

  fs.mkdirSync(backupRoot, { recursive: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const suffix = crypto.randomBytes(3).toString('hex');
  const backupId = `${stamp}-${suffix}`;
  const backupDir = path.join(backupRoot, backupId);
  const filesDir = path.join(backupDir, 'files');
  fs.mkdirSync(backupDir, { recursive: true });

  if (existedBefore && existingFiles.length > 0) {
    for (const fileInfo of existingFiles) {
      const srcFile = path.join(targetRulesDir, fileInfo.relPath);
      const dstFile = path.join(filesDir, fileInfo.relPath);
      fs.mkdirSync(path.dirname(dstFile), { recursive: true });
      fs.copyFileSync(srcFile, dstFile);
    }
  }

  const meta = {
    schemaVersion: 1,
    backupId,
    pluginId: safeId,
    createdAt: now.toISOString(),
    reason: String(options.reason || (existedBefore ? 'before-rules-update' : 'before-rules-inject')),
    targetRulesDir,
    existedBefore: Boolean(existedBefore && existingFiles.length > 0),
    fileCount: existingFiles.length,
    files: existingFiles,
    injectedFiles: Array.isArray(options.incomingFiles)
      ? options.incomingFiles.map((f) => String(f.name || f.relPath || '')).filter(Boolean)
      : []
  };
  fs.writeFileSync(path.join(backupDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  pruneRulesBackups(backupRoot, Number(options.maxBackups) > 0 ? Number(options.maxBackups) : MAX_RULES_BACKUPS);

  return {
    created: true,
    backup: meta
  };
}

function hasAnyRemainingNativeAssets(targetDir) {
  if (!fs.existsSync(targetDir)) return false;
  const skillsDir = path.join(targetDir, 'skills');
  if (fs.existsSync(skillsDir) && walkFilesRel(skillsDir).length > 0) return true;
  if (fs.existsSync(path.join(targetDir, 'hooks.json'))) return true;
  if (fs.existsSync(path.join(targetDir, 'mcp.json'))) return true;
  if (fs.existsSync(path.join(targetDir, 'mcp_config.json'))) return true;
  return false;
}

function rollbackPluginRules(pluginId, options = {}) {
  const safeId = assertSafePluginId(pluginId);
  const backups = listPluginRulesBackups(safeId, options);
  const backup = options.backupId
    ? backups.find((b) => b.backupId === options.backupId)
    : backups[0];
  if (!backup) {
    return {
      ok: false,
      rolledBack: false,
      error: '没有可撤回的 Rules 备份'
    };
  }

  const nativeBase = getDefaultNativePluginsDir(options);
  const targetDir = path.join(nativeBase, resolveNativePluginFolderName(safeId));
  const targetRulesDir = path.join(targetDir, 'rules');
  const backupRoot = getNativeBackupsDir(safeId, options);
  const backupDir = path.join(backupRoot, backup.backupId);
  const filesDir = path.join(backupDir, 'files');

  if (fs.existsSync(targetRulesDir)) {
    fs.rmSync(targetRulesDir, { recursive: true, force: true });
  }

  let rulesEnabledAfterRollback = false;
  const restoredFiles = [];
  if (backup.existedBefore && Array.isArray(backup.files) && backup.files.length > 0) {
    fs.mkdirSync(targetRulesDir, { recursive: true });
    for (const fileInfo of backup.files) {
      const relPath = typeof fileInfo === 'string' ? fileInfo : fileInfo.relPath;
      if (!relPath) continue;
      const srcFile = path.join(filesDir, relPath);
      const dstFile = path.join(targetRulesDir, relPath);
      if (fs.existsSync(srcFile)) {
        fs.mkdirSync(path.dirname(dstFile), { recursive: true });
        fs.copyFileSync(srcFile, dstFile);
        restoredFiles.push(`rules/${relPath}`);
      }
    }
    rulesEnabledAfterRollback = restoredFiles.length > 0;
  }

  const pluginJsonPath = path.join(targetDir, 'plugin.json');
  if (!rulesEnabledAfterRollback && !hasAnyRemainingNativeAssets(targetDir)) {
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  } else if (fs.existsSync(pluginJsonPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8'));
      meta.assets = meta.assets && typeof meta.assets === 'object' ? meta.assets : {};
      meta.assets.rules = restoredFiles;
      meta.nativeConfig = meta.nativeConfig && typeof meta.nativeConfig === 'object' ? meta.nativeConfig : {};
      meta.nativeConfig.rules = rulesEnabledAfterRollback;
      meta.rolledBackRulesAt = new Date().toISOString();
      fs.writeFileSync(pluginJsonPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    } catch {}
  }

  try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch {}
  try {
    if (fs.existsSync(backupRoot) && fs.readdirSync(backupRoot).length === 0) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
    }
  } catch {}

  return {
    ok: true,
    rolledBack: true,
    id: safeId,
    backupId: backup.backupId,
    existedBefore: Boolean(backup.existedBefore),
    restoredFiles,
    rulesEnabledAfterRollback,
    targetDir,
    remainingBackups: listPluginRulesBackups(safeId, options)
  };
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

  const nativeConfig = normalizeNativeConfig(nativeSpec, options.nativeConfig, options.syncNative !== false);
  const nativeBase = getDefaultNativePluginsDir(options);
  const targetDir = path.join(nativeBase, resolveNativePluginFolderName(pluginId));
  const existedBefore = fs.existsSync(targetDir);

  const syncedAssets = { rules: [], skills: [], mcp: null, hooks: null };
  let rulesBackup = null;

  // 1. Rules (.md) - 注入或更新前先自动备份原有内容（含首次空目录状态）
  const rulesOutDir = path.join(targetDir, 'rules');
  if (nativeConfig.rules && Array.isArray(nativeSpec.rules) && nativeSpec.rules.length) {
    const resolvedRuleSources = [];
    for (const rel of nativeSpec.rules) {
      const src = assertInsidePluginRoot(pluginDir, rel);
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        resolvedRuleSources.push({
          src,
          name: path.basename(src),
          sha256: computeFileSha256(src)
        });
      }
    }
    if (resolvedRuleSources.length > 0) {
      rulesBackup = backupPluginRules(pluginId, rulesOutDir, {
        ...options,
        reason: fs.existsSync(rulesOutDir) ? 'before-rules-update' : 'before-rules-inject',
        incomingFiles: resolvedRuleSources.map(({ name, sha256 }) => ({ name, sha256 }))
      });
      if (fs.existsSync(rulesOutDir)) {
        fs.rmSync(rulesOutDir, { recursive: true, force: true });
      }
      fs.mkdirSync(rulesOutDir, { recursive: true });
      for (const item of resolvedRuleSources) {
        const dst = path.join(rulesOutDir, item.name);
        fs.copyFileSync(item.src, dst);
        syncedAssets.rules.push(path.relative(targetDir, dst).replace(/\\/g, '/'));
      }
    }
  } else if (fs.existsSync(rulesOutDir)) {
    fs.rmSync(rulesOutDir, { recursive: true, force: true });
  }

  // 2. Skills (directories or SKILL.md files)
  const skillsOutDir = path.join(targetDir, 'skills');
  if (nativeConfig.skills && Array.isArray(nativeSpec.skills) && nativeSpec.skills.length) {
    if (fs.existsSync(skillsOutDir)) {
      fs.rmSync(skillsOutDir, { recursive: true, force: true });
    }
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
            syncedAssets.skills.push(path.relative(targetDir, dstDir).replace(/\\/g, '/'));
          } else if (entry.name.endsWith('.md')) {
            const dstDir = path.join(skillsOutDir, path.basename(src));
            fs.mkdirSync(dstDir, { recursive: true });
            fs.copyFileSync(entryPath, path.join(dstDir, entry.name));
            syncedAssets.skills.push(path.relative(targetDir, dstDir).replace(/\\/g, '/'));
          }
        }
      } else if (st.isFile()) {
        const skillName = path.basename(path.dirname(src)) || 'default';
        const dstDir = path.join(skillsOutDir, skillName);
        fs.mkdirSync(dstDir, { recursive: true });
        fs.copyFileSync(src, path.join(dstDir, path.basename(src)));
        syncedAssets.skills.push(path.relative(targetDir, dstDir).replace(/\\/g, '/'));
      }
    }
  } else if (fs.existsSync(skillsOutDir)) {
    fs.rmSync(skillsOutDir, { recursive: true, force: true });
  }

  // 3. Hooks
  const hooksDst = path.join(targetDir, 'hooks.json');
  if (nativeConfig.hooks && typeof nativeSpec.hooks === 'string' && nativeSpec.hooks.trim()) {
    const src = assertInsidePluginRoot(pluginDir, nativeSpec.hooks);
    if (fs.existsSync(src)) {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(src, hooksDst);
      syncedAssets.hooks = 'hooks.json';
    }
  } else if (fs.existsSync(hooksDst)) {
    try { fs.rmSync(hooksDst, { force: true }); } catch {}
  }

  // 4. MCP Servers (resolve script paths & inject plugin data dir)
  const mcpDst = path.join(targetDir, 'mcp.json');
  const mcpConfigDst = path.join(targetDir, 'mcp_config.json');
  if (nativeConfig.mcp && typeof nativeSpec.mcp === 'string' && nativeSpec.mcp.trim()) {
    const src = assertInsidePluginRoot(pluginDir, nativeSpec.mcp);
    if (fs.existsSync(src)) {
      fs.mkdirSync(targetDir, { recursive: true });
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
      fs.writeFileSync(mcpDst, mcpJsonStr, 'utf8');
      fs.writeFileSync(mcpConfigDst, mcpJsonStr, 'utf8');
      syncedAssets.mcp = 'mcp.json';
      syncedAssets.mcpConfig = 'mcp_config.json';
    }
  } else {
    if (fs.existsSync(mcpDst)) {
      try { fs.rmSync(mcpDst, { force: true }); } catch {}
    }
    if (fs.existsSync(mcpConfigDst)) {
      try { fs.rmSync(mcpConfigDst, { force: true }); } catch {}
    }
  }

  const anySynced = syncedAssets.rules.length > 0
    || syncedAssets.skills.length > 0
    || Boolean(syncedAssets.hooks)
    || Boolean(syncedAssets.mcp);

  if (!anySynced) {
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    return {
      ok: true,
      synced: false,
      removed: existedBefore,
      reason: 'ALL_NATIVE_DISABLED',
      targetDir,
      nativeConfig,
      assets: syncedAssets,
      rulesBackup
    };
  }

  fs.mkdirSync(targetDir, { recursive: true });
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
    nativeConfig,
    assets: syncedAssets
  };
  fs.writeFileSync(path.join(targetDir, 'plugin.json'), JSON.stringify(nativePluginMeta, null, 2) + '\n', 'utf8');

  return {
    ok: true,
    synced: true,
    targetDir,
    nativeConfig,
    assets: syncedAssets,
    rulesBackup
  };
}

function inspectPluginNativeStatus(pluginId, manifest = null, options = {}) {
  const safeId = assertSafePluginId(pluginId);
  const nativeBase = getDefaultNativePluginsDir(options);
  const targetDir = path.join(nativeBase, resolveNativePluginFolderName(safeId));
  const declared = extractDeclaredNativeSpec(manifest, options.pluginDir || null);

  let pluginJsonMeta = null;
  const pluginJsonPath = path.join(targetDir, 'plugin.json');
  if (fs.existsSync(pluginJsonPath)) {
    try { pluginJsonMeta = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8')); } catch {}
  }

  const rulesDir = path.join(targetDir, 'rules');
  const skillsDir = path.join(targetDir, 'skills');
  const syncedRules = fs.existsSync(rulesDir) ? walkFilesRel(rulesDir) : [];
  const syncedSkills = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir, { withFileTypes: true }).map((d) => d.name).sort()
    : [];
  const syncedMcp = fs.existsSync(path.join(targetDir, 'mcp.json'));
  const syncedHooks = fs.existsSync(path.join(targetDir, 'hooks.json'));
  const synced = syncedRules.length > 0 || syncedSkills.length > 0 || syncedMcp || syncedHooks;

  const nativeSpec = manifest?.contributes?.native;
  const fallbackConfig = pluginJsonMeta?.nativeConfig || {
    rules: syncedRules.length > 0,
    skills: syncedSkills.length > 0,
    mcp: syncedMcp,
    hooks: syncedHooks
  };
  const config = declared.hasNative
    ? normalizeNativeConfig(nativeSpec, options.nativeConfig || fallbackConfig, true)
    : {
        rules: syncedRules.length > 0,
        skills: syncedSkills.length > 0,
        mcp: syncedMcp,
        hooks: syncedHooks
      };

  const rulesBackups = listPluginRulesBackups(safeId, options);

  return {
    hasNative: declared.hasNative || synced,
    targetDir,
    synced,
    declared,
    config,
    syncedAssets: {
      rules: syncedRules,
      skills: syncedSkills,
      mcp: syncedMcp,
      hooks: syncedHooks
    },
    rulesBackups
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
  let backupsRemoved = false;
  if (options.cleanBackups !== false) {
    const pluginBackupDir = path.join(getStateDir(options), 'native-backups', safeId);
    if (fs.existsSync(pluginBackupDir)) {
      fs.rmSync(pluginBackupDir, { recursive: true, force: true });
      backupsRemoved = true;
    }
  }
  return { ok: true, removed: existed, targetDir, backupsRemoved };
}

module.exports = {
  NATIVE_ASSET_KINDS,
  getDefaultNativePluginsDir,
  getNativeBackupsDir,
  resolveNativePluginFolderName,
  extractDeclaredNativeSpec,
  normalizeNativeConfig,
  listPluginRulesBackups,
  backupPluginRules,
  rollbackPluginRules,
  inspectPluginNativeStatus,
  syncPluginNativeArtifacts,
  removePluginNativeArtifacts
};
