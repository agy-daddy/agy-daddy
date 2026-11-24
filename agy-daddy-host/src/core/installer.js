'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { getStateDir, getPluginsDir, assertSafePluginId } = require('./paths');
const { safeReadJsonSync, safeWriteJsonSync, withFileLockSync } = require('./storage');
const { validateManifest, evaluateTrustPolicy } = require('../contracts/manifest-validator');
const { satisfies, compareSemver, parseSemver } = require('../contracts/semver');
const { extractTarGzToDir } = require('./tar');
const {
  normalizeNativeConfig,
  inspectPluginNativeStatus,
  rollbackPluginRules,
  syncPluginNativeArtifacts,
  removePluginNativeArtifacts
} = require('./native-sync');

const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, '..', '..', 'data', 'registry.json');
const HOST_ROOT_DIR = path.resolve(__dirname, '..', '..');

function loadRegistry(options = {}) {
  const regPath = options.registryPath ? path.resolve(options.registryPath) : DEFAULT_REGISTRY_PATH;
  const res = safeReadJsonSync(regPath, { schemaVersion: 1, plugins: [] }, { quarantineCorrupt: false });
  return res.data || { schemaVersion: 1, plugins: [] };
}

function getInstalledIndexPath(options = {}) {
  return path.join(getStateDir(options), 'installed-plugins.json');
}

function readInstalledIndex(options = {}) {
  const indexPath = getInstalledIndexPath(options);
  const res = safeReadJsonSync(indexPath, { schemaVersion: 1, plugins: {} }, { quarantineCorrupt: true });
  const data = res.data && typeof res.data === 'object' ? res.data : { schemaVersion: 1, plugins: {} };
  if (!data.plugins || typeof data.plugins !== 'object') data.plugins = {};
  return data;
}

function writeInstalledIndex(data, options = {}) {
  const indexPath = getInstalledIndexPath(options);
  return withFileLockSync(indexPath, () => safeWriteJsonSync(indexPath, data));
}

function parseNpmSpec(raw) {
  const body = raw.slice('npm:'.length).trim();
  if (!body) throw new Error('Invalid npm package spec');
  const atIdx = body.startsWith('@') ? body.indexOf('@', 1) : body.indexOf('@');
  if (atIdx > 0) {
    return {
      packageName: body.slice(0, atIdx),
      versionRange: body.slice(atIdx + 1) || '*'
    };
  }
  return { packageName: body, versionRange: '*' };
}

function assertSafeSubpath(subpath) {
  if (typeof subpath !== 'string') {
    throw new Error(`Invalid plugin subpath: ${String(subpath)}`);
  }
  const raw = subpath.trim();
  if (!raw || raw.startsWith('/') || raw.includes('\\') || raw.includes(':') || raw.includes('\0')) {
    throw new Error(`Invalid plugin subpath: ${subpath}`);
  }
  let cleaned = raw;
  while (cleaned.startsWith('./')) {
    cleaned = cleaned.slice(2);
  }
  cleaned = cleaned.replace(/\/+$/, '');
  if (!cleaned || cleaned === '.') {
    throw new Error(`Invalid plugin subpath: ${subpath}`);
  }
  const segments = cleaned.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new Error(`Invalid plugin subpath: ${subpath}`);
  }
  return cleaned;
}

function parseGitRefAndSubpath(fragment) {
  if (fragment === undefined || fragment === null) {
    return { ref: null, subpath: null };
  }
  const raw = String(fragment);
  if (!raw) {
    return { ref: null, subpath: null };
  }
  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) {
    return { ref: raw.trim() || null, subpath: null };
  }
  const ref = raw.slice(0, colonIdx).trim() || null;
  const rawSubpath = raw.slice(colonIdx + 1);
  return {
    ref,
    subpath: assertSafeSubpath(rawSubpath)
  };
}

function parsePluginSource(spec, options = {}) {
  const raw = String(spec || '').trim();
  if (!raw) throw new Error('Plugin source spec cannot be empty');
  const registry = options.registry || loadRegistry(options);

  if (raw.startsWith('local:')) {
    const targetPath = path.resolve(raw.slice('local:'.length).trim());
    return { kind: 'local', path: targetPath, trustLevel: options.trustLevel || 'T2', spec: raw };
  }

  if (raw.startsWith('git:')) {
    const rest = raw.slice('git:'.length).trim();
    const hashIdx = rest.indexOf('#');
    const url = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
    const fragment = hashIdx >= 0 ? rest.slice(hashIdx + 1) : '';
    const { ref, subpath } = parseGitRefAndSubpath(fragment);
    return { kind: 'git', url, ref, subpath, trustLevel: options.trustLevel || 'T2', spec: raw };
  }

  if (raw.startsWith('github:')) {
    const rest = raw.slice('github:'.length).trim();
    const hashIdx = rest.indexOf('#');
    const slug = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
    const fragment = hashIdx >= 0 ? rest.slice(hashIdx + 1) : '';
    const { ref, subpath } = parseGitRefAndSubpath(fragment);
    const url = `https://github.com/${slug.replace(/\.git$/, '')}.git`;
    const isOfficial = slug.startsWith(`${registry.organization || 'agy-daddy'}/`);
    return {
      kind: 'git',
      url,
      ref,
      subpath,
      trustLevel: options.trustLevel || (isOfficial ? 'T0' : 'T2'),
      spec: raw
    };
  }

  if (raw.startsWith('npm:')) {
    const { packageName, versionRange } = parseNpmSpec(raw);
    const isOfficial = packageName.startsWith('@agy-daddy/');
    return {
      kind: 'npm',
      packageName,
      versionRange,
      trustLevel: options.trustLevel || (isOfficial ? 'T0' : 'T2'),
      spec: raw
    };
  }

  if (raw.startsWith('https://') || raw.startsWith('http://') || raw.startsWith('git+')) {
    const clean = raw.replace(/^git\+/, '');
    const hashIdx = clean.indexOf('#');
    const url = hashIdx >= 0 ? clean.slice(0, hashIdx) : clean;
    const fragment = hashIdx >= 0 ? clean.slice(hashIdx + 1) : '';
    const { ref, subpath } = parseGitRefAndSubpath(fragment);
    return { kind: 'git', url, ref, subpath, trustLevel: options.trustLevel || 'T2', spec: raw };
  }

  // 直接传入本地目录路径
  if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')) {
    return { kind: 'local', path: path.resolve(raw), trustLevel: options.trustLevel || 'T2', spec: `local:${path.resolve(raw)}` };
  }

  // 短名或完整 id 查官方注册表
  const regEntry = (registry.plugins || []).find((p) => p.shortName === raw || p.id === raw);
  if (regEntry) {
    if (regEntry.bundledPath) {
      const bundledDir = path.resolve(options.hostRoot || HOST_ROOT_DIR, regEntry.bundledPath);
      if (fs.existsSync(bundledDir)) {
        return {
          kind: 'local',
          path: bundledDir,
          trustLevel: options.trustLevel || regEntry.trustLevel || 'T0',
          registryEntry: regEntry,
          spec: `bundled:${regEntry.id}`
        };
      }
    }
    return {
      kind: 'git',
      url: regEntry.repo,
      ref: null,
      subpath: regEntry.subpath ? assertSafeSubpath(regEntry.subpath) : null,
      trustLevel: options.trustLevel || regEntry.trustLevel || 'T0',
      registryEntry: regEntry,
      spec: `registry:${regEntry.id}`
    };
  }

  throw new Error(`Unknown plugin source or shortName: ${raw}`);
}

function readManifestFromDir(pluginDir) {
  const manifestPath = path.join(pluginDir, 'agy-plugin.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing agy-plugin.json in ${pluginDir}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    throw new Error(`Invalid manifest in ${pluginDir}: ${validation.errors.join('; ')}`);
  }
  return manifest;
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDirSync(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function defaultGitRunner(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }).trim();
}

async function fetchNpmTarballToDir(parsed, stagingDir, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is unavailable for npm installation');
  }
  const registryBase = String(options.npmRegistryUrl || 'https://registry.npmjs.org').replace(/\/+$/, '');
  const metaUrl = `${registryBase}/${encodeURIComponent(parsed.packageName)}`;
  const metaResp = await fetchImpl(metaUrl, { headers: { Accept: 'application/json' } });
  if (!metaResp.ok) {
    throw new Error(`Failed to fetch npm metadata (${metaResp.status}): ${metaUrl}`);
  }
  const meta = await metaResp.json();
  const versions = Object.keys(meta.versions || {}).filter((v) => parseSemver(v));
  const matching = versions
    .filter((v) => satisfies(v, parsed.versionRange || '*'))
    .sort((a, b) => compareSemver(b, a));
  const targetVer = matching[0];
  if (!targetVer) {
    throw new Error(`No matching npm version for ${parsed.packageName}@${parsed.versionRange}`);
  }
  const verObj = meta.versions[targetVer];
  const tarballUrl = verObj?.dist?.tarball;
  if (!tarballUrl) {
    throw new Error(`Missing tarball URL for ${parsed.packageName}@${targetVer}`);
  }
  const tarResp = await fetchImpl(tarballUrl);
  if (!tarResp.ok) {
    throw new Error(`Failed to download tarball (${tarResp.status}): ${tarballUrl}`);
  }
  const tgzBuffer = Buffer.from(await tarResp.arrayBuffer());
  const integrity = verObj?.dist?.integrity;
  if (integrity && typeof integrity === 'string' && integrity.startsWith('sha512-')) {
    const expectedB64 = integrity.slice('sha512-'.length);
    const actualB64 = crypto.createHash('sha512').update(tgzBuffer).digest('base64');
    if (actualB64 !== expectedB64) {
      throw new Error(`npm integrity mismatch for ${parsed.packageName}@${targetVer}`);
    }
  }
  extractTarGzToDir(tgzBuffer, stagingDir, { strip: 1 });
  return { version: targetVer, integrity: integrity || null };
}

function backupForRollback(targetDir, rollbackDir, prevRecord) {
  fs.rmSync(rollbackDir, { recursive: true, force: true });
  if (!fs.existsSync(targetDir)) return null;
  const stat = fs.lstatSync(targetDir);
  if (stat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(targetDir);
    fs.mkdirSync(rollbackDir, { recursive: true });
    safeWriteJsonSync(path.join(rollbackDir, '.symlink-backup.json'), { linkTarget, prevRecord });
  } else {
    copyDirSync(targetDir, rollbackDir);
  }
  return prevRecord || null;
}

async function installPlugin(spec, options = {}) {
  const pluginsDir = getPluginsDir(options);
  fs.mkdirSync(pluginsDir, { recursive: true });

  const parsed = parsePluginSource(spec, options);
  const stagingParent = path.join(pluginsDir, '.staging');
  fs.mkdirSync(stagingParent, { recursive: true });
  const stagingDir = path.join(stagingParent, `stage-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);

  let commitSha = null;
  let npmMeta = null;
  let gitSourceDir = stagingDir;
  let manifest;

  try {
    if (parsed.kind === 'local') {
      if (!fs.existsSync(parsed.path)) {
        throw new Error(`Local plugin path does not exist: ${parsed.path}`);
      }
      manifest = readManifestFromDir(parsed.path);
    } else if (parsed.kind === 'git') {
      const gitRun = options.gitRunner || defaultGitRunner;
      const cloneArgs = ['clone', '--depth', '1'];
      if (parsed.ref) cloneArgs.push('--branch', parsed.ref);
      cloneArgs.push(parsed.url, stagingDir);
      gitRun(cloneArgs);
      commitSha = gitRun(['rev-parse', 'HEAD'], stagingDir);
      if (parsed.subpath) {
        const safeSubpath = assertSafeSubpath(parsed.subpath);
        const resolvedSubdir = path.resolve(stagingDir, safeSubpath);
        const rel = path.relative(stagingDir, resolvedSubdir);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error(`Invalid plugin subpath: ${parsed.subpath}`);
        }
        if (!fs.existsSync(resolvedSubdir) || !fs.statSync(resolvedSubdir).isDirectory()) {
          throw new Error(`Plugin subpath does not exist in repository: ${safeSubpath}`);
        }
        gitSourceDir = resolvedSubdir;
      }
      manifest = readManifestFromDir(gitSourceDir);
    } else if (parsed.kind === 'npm') {
      npmMeta = await fetchNpmTarballToDir(parsed, stagingDir, options);
      manifest = readManifestFromDir(stagingDir);
    }

    const pluginId = assertSafePluginId(manifest.id);
    const trustPolicy = evaluateTrustPolicy(manifest, parsed.trustLevel, options.grantedPermissions || []);
    if (!trustPolicy.allowed) {
      const err = new Error(
        `Trust policy blocked permissions for ${pluginId} (${trustPolicy.trustLevel}): ${trustPolicy.denied.join(', ')}`
      );
      err.code = 'PERMISSION_CONFIRMATION_REQUIRED';
      err.trustPolicy = trustPolicy;
      throw err;
    }

    const targetDir = path.join(pluginsDir, pluginId);
    const rollbackRoot = path.join(pluginsDir, '.rollback');
    const rollbackDir = path.join(rollbackRoot, `${pluginId}.prev`);
    const index = readInstalledIndex(options);
    const prevRecord = index.plugins[pluginId] || null;
    const backedUpPrev = backupForRollback(targetDir, rollbackDir, prevRecord);

    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    if (parsed.kind === 'local' && !options.copy) {
      fs.symlinkSync(parsed.path, targetDir, 'dir');
    } else if (parsed.kind === 'local') {
      copyDirSync(parsed.path, targetDir);
    } else if (parsed.kind === 'git' && parsed.subpath) {
      copyDirSync(gitSourceDir, targetDir);
    } else {
      fs.renameSync(stagingDir, targetDir);
    }

    let initialNativeConfig = null;
    if (manifest?.contributes?.native && typeof manifest.contributes.native === 'object') {
      if (options.nativeConfig && typeof options.nativeConfig === 'object' && !Array.isArray(options.nativeConfig)) {
        initialNativeConfig = normalizeNativeConfig(manifest.contributes.native, options.nativeConfig, true);
      } else if (options.syncNative === false) {
        initialNativeConfig = normalizeNativeConfig(manifest.contributes.native, {}, false);
      } else if (prevRecord?.nativeConfig && typeof prevRecord.nativeConfig === 'object') {
        initialNativeConfig = normalizeNativeConfig(manifest.contributes.native, prevRecord.nativeConfig, true);
      } else {
        initialNativeConfig = normalizeNativeConfig(
          manifest.contributes.native,
          {},
          options.defaultNativeEnabled !== false
        );
      }
    }

    const record = {
      id: pluginId,
      version: manifest.version,
      trustLevel: trustPolicy.trustLevel,
      badge: trustPolicy.badge,
      world: trustPolicy.world,
      nodeIsolation: trustPolicy.nodeIsolation,
      autoUpdateAllowed: trustPolicy.autoUpdateAllowed,
      grantedPermissions: trustPolicy.granted,
      nativeConfig: initialNativeConfig,
      sourceKind: parsed.kind,
      sourceSpec: parsed.spec,
      subpath: parsed.subpath || null,
      installPath: targetDir,
      commitSha: commitSha || null,
      npmIntegrity: npmMeta?.integrity || null,
      enabled: options.enabled !== false,
      previousRecord: backedUpPrev,
      installedAt: new Date().toISOString()
    };

    const nativeSync = options.syncNative === false
      ? { ok: true, synced: false, skipped: true }
      : syncPluginNativeArtifacts(targetDir, manifest, {
          ...options,
          grantedPermissions: trustPolicy.granted,
          nativeConfig: initialNativeConfig
        });

    index.plugins[pluginId] = record;
    writeInstalledIndex(index, options);
    return { ok: true, plugin: record, manifest, trustPolicy, nativeSync };
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
}

async function linkPlugin(localPath, options = {}) {
  return installPlugin(`local:${path.resolve(localPath)}`, {
    ...options,
    trustLevel: options.trustLevel || 'T2'
  });
}

function setPluginEnabled(pluginId, enabled, options = {}) {
  const safeId = assertSafePluginId(pluginId);
  const index = readInstalledIndex(options);
  if (!index.plugins[safeId]) {
    throw new Error(`Plugin not installed: ${safeId}`);
  }
  index.plugins[safeId].enabled = Boolean(enabled);
  index.plugins[safeId].updatedAt = new Date().toISOString();
  writeInstalledIndex(index, options);
  return index.plugins[safeId];
}

function rollbackPlugin(pluginId, options = {}) {
  const safeId = assertSafePluginId(pluginId);
  const pluginsDir = getPluginsDir(options);
  const targetDir = path.join(pluginsDir, safeId);
  const rollbackDir = path.join(pluginsDir, '.rollback', `${safeId}.prev`);
  const index = readInstalledIndex(options);
  const current = index.plugins[safeId];
  if (!current || !fs.existsSync(rollbackDir)) {
    throw new Error(`No rollback snapshot available for ${safeId}`);
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  const symlinkBakPath = path.join(rollbackDir, '.symlink-backup.json');
  let restoredRecord = current.previousRecord || null;
  if (fs.existsSync(symlinkBakPath)) {
    const bak = JSON.parse(fs.readFileSync(symlinkBakPath, 'utf8'));
    fs.symlinkSync(bak.linkTarget, targetDir, 'dir');
    if (bak.prevRecord) restoredRecord = bak.prevRecord;
    fs.rmSync(rollbackDir, { recursive: true, force: true });
  } else {
    fs.renameSync(rollbackDir, targetDir);
  }

  if (restoredRecord) {
    index.plugins[safeId] = {
      ...restoredRecord,
      rolledBackAt: new Date().toISOString()
    };
  } else {
    const manifest = readManifestFromDir(targetDir);
    index.plugins[safeId] = {
      ...current,
      version: manifest.version,
      previousRecord: null,
      rolledBackAt: new Date().toISOString()
    };
  }
  writeInstalledIndex(index, options);
  return { ok: true, plugin: index.plugins[safeId] };
}

function updatePluginNativeConfig(pluginId, configPatch = {}, options = {}) {
  const safeId = assertSafePluginId(pluginId);
  const index = readInstalledIndex(options);
  const record = index.plugins[safeId];
  if (!record) {
    return { ok: false, error: `Plugin not installed: ${safeId}` };
  }
  if (!record.installPath || !fs.existsSync(record.installPath)) {
    return { ok: false, error: `Plugin install path missing for ${safeId}` };
  }
  const manifest = readManifestFromDir(record.installPath);
  if (!manifest?.contributes?.native || typeof manifest.contributes.native !== 'object') {
    return { ok: false, error: `Plugin does not declare native extensions: ${safeId}` };
  }

  const nextConfig = normalizeNativeConfig(
    manifest.contributes.native,
    { ...(record.nativeConfig || {}), ...(configPatch && typeof configPatch === 'object' ? configPatch : {}) },
    true
  );
  const nativeSync = syncPluginNativeArtifacts(record.installPath, manifest, {
    ...options,
    grantedPermissions: Array.isArray(record.grantedPermissions) ? record.grantedPermissions : [],
    nativeConfig: nextConfig
  });
  if (!nativeSync.ok) {
    return { ok: false, error: nativeSync.reason || 'Native sync failed', nativeSync };
  }

  record.nativeConfig = nextConfig;
  record.updatedAt = new Date().toISOString();
  index.plugins[safeId] = record;
  writeInstalledIndex(index, options);

  return {
    ok: true,
    id: safeId,
    nativeConfig: nextConfig,
    nativeSync,
    nativeStatus: inspectPluginNativeStatus(safeId, manifest, {
      ...options,
      pluginDir: record.installPath,
      nativeConfig: nextConfig
    })
  };
}

function rollbackPluginNativeRules(pluginId, options = {}) {
  const safeId = assertSafePluginId(pluginId);
  const index = readInstalledIndex(options);
  const record = index.plugins[safeId];
  if (!record) {
    return { ok: false, rolledBack: false, error: `Plugin not installed: ${safeId}` };
  }

  let manifest = null;
  if (record.installPath && fs.existsSync(record.installPath)) {
    try { manifest = readManifestFromDir(record.installPath); } catch {}
  }

  const res = rollbackPluginRules(safeId, options);
  if (!res.ok) {
    return {
      ...res,
      nativeConfig: record.nativeConfig || null,
      nativeStatus: inspectPluginNativeStatus(safeId, manifest, {
        ...options,
        pluginDir: record.installPath,
        nativeConfig: record.nativeConfig
      })
    };
  }

  const nextConfig = manifest?.contributes?.native
    ? normalizeNativeConfig(
        manifest.contributes.native,
        { ...(record.nativeConfig || {}), rules: Boolean(res.rulesEnabledAfterRollback) },
        true
      )
    : { ...(record.nativeConfig || {}), rules: Boolean(res.rulesEnabledAfterRollback) };

  record.nativeConfig = nextConfig;
  record.updatedAt = new Date().toISOString();
  index.plugins[safeId] = record;
  writeInstalledIndex(index, options);

  return {
    ...res,
    nativeConfig: nextConfig,
    nativeStatus: inspectPluginNativeStatus(safeId, manifest, {
      ...options,
      pluginDir: record.installPath,
      nativeConfig: nextConfig
    })
  };
}

function uninstallPlugin(pluginId, options = {}) {
  const safeId = assertSafePluginId(pluginId);
  const pluginsDir = getPluginsDir(options);
  const index = readInstalledIndex(options);
  const record = index.plugins[safeId];
  if (!record) {
    return { ok: false, error: `Plugin not installed: ${safeId}` };
  }

  let manifest = null;
  if (record.installPath && fs.existsSync(record.installPath)) {
    try { manifest = readManifestFromDir(record.installPath); } catch {}
  }
  const nativeStatus = inspectPluginNativeStatus(safeId, manifest, {
    ...options,
    pluginDir: record.installPath,
    nativeConfig: record.nativeConfig
  });
  const hasNative = Boolean(nativeStatus.hasNative || nativeStatus.synced);

  if (options.requireNativeConfirm === true && !options.confirmNativeDelete && hasNative) {
    return {
      ok: false,
      needsNativeUninstallConfirm: true,
      id: safeId,
      nativeInfo: nativeStatus,
      error: '该插件包含原生扩展，请确认提示后再执行卸载删除'
    };
  }

  const targetDir = path.join(pluginsDir, safeId);
  const rollbackDir = path.join(pluginsDir, '.rollback', `${safeId}.prev`);
  try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(rollbackDir, { recursive: true, force: true }); } catch {}
  const nativeCleanup = removePluginNativeArtifacts(safeId, options);
  delete index.plugins[safeId];
  writeInstalledIndex(index, options);
  return { ok: true, id: safeId, nativeCleanup, hadNative: hasNative };
}

function listInstalledPlugins(options = {}) {
  const index = readInstalledIndex(options);
  return Object.values(index.plugins || {});
}

function sortPluginsByDependency(entries) {
  const byId = new Map();
  const providers = new Map();
  for (const item of entries) {
    byId.set(item.manifest.id, item);
    for (const svc of Object.keys(item.manifest.provides?.services || {})) {
      providers.set(svc, item.manifest.id);
    }
  }
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];

  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) return; // 避免静态环导致无限递归
    visiting.add(id);
    const item = byId.get(id);
    if (item) {
      for (const depSvc of Object.keys(item.manifest.consumes || {})) {
        const providerId = providers.get(depSvc);
        if (providerId && providerId !== id) {
          visit(providerId);
        }
      }
      visiting.delete(id);
      visited.add(id);
      ordered.push(item);
    }
  }

  for (const item of entries) visit(item.manifest.id);
  return ordered;
}

module.exports = {
  DEFAULT_REGISTRY_PATH,
  loadRegistry,
  getInstalledIndexPath,
  readInstalledIndex,
  assertSafeSubpath,
  parseGitRefAndSubpath,
  parsePluginSource,
  readManifestFromDir,
  installPlugin,
  linkPlugin,
  enablePlugin: (id, opts) => setPluginEnabled(id, true, opts),
  disablePlugin: (id, opts) => setPluginEnabled(id, false, opts),
  rollbackPlugin,
  updatePluginNativeConfig,
  rollbackPluginNativeRules,
  inspectPluginNativeStatus,
  uninstallPlugin,
  listInstalledPlugins,
  sortPluginsByDependency
};
