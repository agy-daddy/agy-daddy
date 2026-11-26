'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { isTestMode, getStateDir } = require('./paths');
const { safeReadJsonSync, safeWriteJsonSync, withFileLockSync } = require('./storage');

const CUSTOMIZATION_TYPES = Object.freeze(['plugin', 'skill', 'rule', 'hook', 'mcp']);
const CUSTOMIZATION_SCOPES = Object.freeze(['global', 'workspace']);
const DEFAULT_TOKEN_BUDGET = 20000;
const MAX_MCP_BACKUPS = 10;

const KNOWN_MCP_PLUGIN_TOOLS = Object.freeze({
  'agy-fast': Object.freeze({
    fast: Object.freeze(['batch_search', 'apply_edits', 'read_slices', 'quick_outline', 'run_checks'])
  })
});

function isPlainObj(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function createCodedError(code, message, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

function assertSafeItemName(name, label = 'name') {
  const clean = String(name || '').trim();
  if (
    !clean
    || clean === '.'
    || clean === '..'
    || clean.includes('..')
    || clean.includes('/')
    || clean.includes('\\')
    || clean.includes('\0')
  ) {
    throw createCodedError('INVALID_NAME', `Invalid ${label}: ${String(name)}`);
  }
  return clean;
}

function assertInsideRoot(rootDir, targetPath) {
  const rootAbs = path.resolve(rootDir);
  const abs = path.resolve(rootDir, targetPath);
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : `${rootAbs}${path.sep}`;
  if (abs !== rootAbs && !abs.startsWith(prefix)) {
    throw createCodedError('UNSAFE_PATH', `Path escapes root directory: ${targetPath}`);
  }
  return abs;
}

function resolveGeminiConfigDir(options = {}) {
  if (options.geminiConfigDir) return path.resolve(options.geminiConfigDir);
  if (process.env.AGY_DADDY_GEMINI_CONFIG_DIR) {
    return path.resolve(process.env.AGY_DADDY_GEMINI_CONFIG_DIR);
  }
  if (options.homeDir) {
    return path.join(path.resolve(options.homeDir), '.gemini', 'config');
  }
  if (options.nativePluginsDir) {
    return path.dirname(path.resolve(options.nativePluginsDir));
  }
  if (isTestMode()) {
    return path.join(getStateDir(options), 'gemini-config');
  }
  return path.join(os.homedir(), '.gemini', 'config');
}

function fileUriToPath(rawUri, platform = process.platform) {
  const raw = String(rawUri || '').trim();
  if (!raw) return null;
  if (!raw.startsWith('file://')) {
    return path.resolve(raw);
  }
  try {
    const parsed = new URL(raw);
    let p = decodeURIComponent(parsed.pathname || '');
    if (platform === 'win32' && /^\/[A-Za-z]:/.test(p)) {
      p = p.slice(1);
    }
    return p ? path.resolve(p) : null;
  } catch {
    return null;
  }
}

function extractTrajectoryWorkspacePaths(entry, platform = process.platform) {
  if (!isPlainObj(entry)) return [];
  const rawList = [];
  const collect = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (!isPlainObj(item)) continue;
      if (item.workspaceFolderAbsoluteUri) rawList.push(item.workspaceFolderAbsoluteUri);
      if (item.gitRootAbsoluteUri) rawList.push(item.gitRootAbsoluteUri);
      if (item.workspacePath) rawList.push(item.workspacePath);
      if (item.workspaceUri) rawList.push(item.workspaceUri);
    }
  };
  collect(entry.workspaces);
  collect(entry.trajectoryMetadata?.workspaces);
  if (Array.isArray(entry.trajectoryMetadata?.workspaceUris)) {
    rawList.push(...entry.trajectoryMetadata.workspaceUris);
  }
  collect(entry.trajectory?.metadata?.workspaces);
  if (Array.isArray(entry.trajectory?.metadata?.workspaceUris)) {
    rawList.push(...entry.trajectory.metadata.workspaceUris);
  }
  for (const key of ['workspacePath', 'workspaceUri', 'cwd', 'rootPath']) {
    if (entry[key]) rawList.push(entry[key]);
  }
  const out = [];
  const seen = new Set();
  for (const raw of rawList) {
    const converted = fileUriToPath(raw, platform);
    if (converted && !seen.has(converted)) {
      seen.add(converted);
      out.push(converted);
    }
  }
  return out;
}

async function detectActiveWorkspaceRoot(options = {}) {
  const explicit = options.workspaceRoot || options.workspacePath;
  if (typeof explicit === 'string' && explicit.trim()) {
    return { root: path.resolve(explicit.trim()), source: 'explicit' };
  }

  if (options.rpcTransport && typeof options.rpcTransport.call === 'function' && options.skipRpc !== true) {
    try {
      const resp = await options.rpcTransport.call('GetAllCascadeTrajectories', {}, {
        timeoutMs: Number(options.rpcTimeoutMs) > 0 ? Number(options.rpcTimeoutMs) : 3000,
        retryOnTimeout: false
      });
      const rawSummaries = resp?.trajectorySummaries || resp?.trajectories || {};
      const entries = Array.isArray(rawSummaries)
        ? rawSummaries
        : (isPlainObj(rawSummaries) ? Object.values(rawSummaries) : []);

      entries.sort((a, b) => {
        const runningA = String(a?.status || '').includes('RUNNING') ? 1 : 0;
        const runningB = String(b?.status || '').includes('RUNNING') ? 1 : 0;
        if (runningB !== runningA) return runningB - runningA;
        const tA = Date.parse(a?.lastModifiedTime || '') || 0;
        const tB = Date.parse(b?.lastModifiedTime || '') || 0;
        return tB - tA;
      });

      const fsImpl = options.fs || fs;
      for (const entry of entries) {
        const candidates = extractTrajectoryWorkspacePaths(entry, options.platform);
        for (const cand of candidates) {
          try {
            if (fsImpl.existsSync(cand) && fsImpl.statSync(cand).isDirectory()) {
              return { root: cand, source: 'rpc-trajectory' };
            }
          } catch {}
        }
      }
    } catch {}
  }

  if (typeof options.fallbackWorkspaceRoot === 'string' && options.fallbackWorkspaceRoot.trim()) {
    return { root: path.resolve(options.fallbackWorkspaceRoot.trim()), source: 'fallback' };
  }

  return { root: null, source: 'none' };
}

function resolveScopePaths(scope, options = {}) {
  if (scope === 'global') {
    const rootDir = resolveGeminiConfigDir(options);
    const pluginsDir = options.nativePluginsDir
      ? path.resolve(options.nativePluginsDir)
      : path.join(rootDir, 'plugins');
    return {
      scope: 'global',
      rootDir,
      baseDir: rootDir,
      pluginsDir,
      skillsDir: path.join(rootDir, 'skills'),
      rulesDir: path.join(rootDir, 'rules'),
      hooksDir: path.join(rootDir, 'hooks'),
      hooksFile: path.join(rootDir, 'hooks.json'),
      mcpConfigPath: path.join(rootDir, 'mcp_config.json'),
      configJsonPath: path.join(rootDir, 'config.json'),
      skillsJsonPath: path.join(rootDir, 'skills.json'),
      pluginsJsonPath: path.join(rootDir, 'plugins.json'),
      rulesJsonPath: path.join(rootDir, 'rules.json')
    };
  }
  if (scope === 'workspace') {
    const rawRoot = options.workspaceRoot || options.workspacePath || options.fallbackWorkspaceRoot;
    const workspaceRoot = rawRoot ? path.resolve(String(rawRoot)) : null;
    const agentsDir = workspaceRoot ? path.join(workspaceRoot, '.agents') : null;
    return {
      scope: 'workspace',
      workspaceRoot,
      rootDir: agentsDir,
      baseDir: agentsDir,
      pluginsDir: agentsDir ? path.join(agentsDir, 'plugins') : null,
      skillsDir: agentsDir ? path.join(agentsDir, 'skills') : null,
      rulesDir: agentsDir ? path.join(agentsDir, 'rules') : null,
      hooksDir: agentsDir ? path.join(agentsDir, 'hooks') : null,
      hooksFile: agentsDir ? path.join(agentsDir, 'hooks.json') : null,
      mcpConfigPath: agentsDir ? path.join(agentsDir, 'mcp_config.json') : null,
      configJsonPath: agentsDir ? path.join(agentsDir, 'config.json') : null,
      skillsJsonPath: agentsDir ? path.join(agentsDir, 'skills.json') : null,
      pluginsJsonPath: agentsDir ? path.join(agentsDir, 'plugins.json') : null,
      rulesJsonPath: agentsDir ? path.join(agentsDir, 'rules.json') : null
    };
  }
  throw createCodedError('INVALID_SCOPE', `Unsupported customization scope: ${String(scope)}`);
}

function estimateTokens(value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value || '');
  return Math.ceil(Buffer.byteLength(str, 'utf8') / 4);
}

function unquoteYamlScalar(raw) {
  const s = String(raw || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    return s
      .slice(1, -1)
      .split(',')
      .map((item) => unquoteYamlScalar(item))
      .filter((v) => v !== '');
  }
  return s;
}

function parseFrontmatter(markdownText) {
  const text = String(markdownText || '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { data: {}, body: text };

  const rawYaml = match[1];
  const body = text.slice(match[0].length);
  const lines = rawYaml.split(/\r?\n/);
  const data = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2].trim();
    if (rest === '>-' || rest === '>' || rest === '|' || rest === '|-') {
      const collected = [];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        if (!nextLine.trim()) {
          collected.push('');
          j += 1;
          continue;
        }
        if (/^\s+/.test(nextLine)) {
          collected.push(nextLine.trim());
          j += 1;
          continue;
        }
        break;
      }
      i = j - 1;
      data[key] = rest.startsWith('|')
        ? collected.join('\n').trim()
        : collected.filter(Boolean).join(' ').trim();
    } else if (rest === '') {
      const arr = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+(.+)$/.test(lines[j])) {
        arr.push(unquoteYamlScalar(lines[j].replace(/^\s*-\s+/, '')));
        j += 1;
      }
      if (arr.length > 0) {
        i = j - 1;
        data[key] = arr;
      } else {
        data[key] = '';
      }
    } else {
      data[key] = unquoteYamlScalar(rest);
    }
  }

  return { data, body };
}

function matchesPatternList(name, patterns = []) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  for (const raw of patterns) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const pat = raw.trim();
    if (pat === name) return true;
    try {
      const re = new RegExp(`^(?:${pat})$`);
      if (re.test(name)) return true;
    } catch {}
  }
  return false;
}

function readJsonQuiet(filePath, fallback = null) {
  if (!filePath) return fallback;
  const res = safeReadJsonSync(filePath, fallback, { quarantineCorrupt: false });
  return res.ok && res.exists ? res.data : fallback;
}

function inspectEntrySymlink(entryPath) {
  try {
    const lst = fs.lstatSync(entryPath);
    if (!lst.isSymbolicLink()) {
      return { isSymlink: false, symlinkTarget: null, brokenSymlink: false, isDirectory: lst.isDirectory() };
    }
    const symlinkTarget = fs.readlinkSync(entryPath);
    let brokenSymlink = false;
    let isDirectory = false;
    try {
      const st = fs.statSync(entryPath);
      isDirectory = st.isDirectory();
    } catch {
      brokenSymlink = true;
    }
    return { isSymlink: true, symlinkTarget, brokenSymlink, isDirectory };
  } catch {
    return { isSymlink: false, symlinkTarget: null, brokenSymlink: false, isDirectory: false };
  }
}

function readPluginManifestInfo(pluginDir) {
  const candidates = [
    path.join(pluginDir, 'plugin.json'),
    path.join(pluginDir, '.antigravity-plugin', 'plugin.json'),
    path.join(pluginDir, '.gemini-plugin', 'plugin.json'),
    path.join(pluginDir, 'agy-plugin.json')
  ];
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      const parsed = readJsonQuiet(cand, null);
      if (isPlainObj(parsed)) {
        return { manifest: parsed, manifestPath: cand };
      }
    }
  }
  return { manifest: null, manifestPath: null };
}

function buildMcpServerSummary(serverName, srvDef, meta) {
  const def = isPlainObj(srvDef) ? srvDef : {};
  const tools = isPlainObj(def.tools) ? def.tools : {};
  const toolNames = Object.keys(tools);
  const eagerTools = [];
  const lazyTools = [];
  for (const tName of toolNames) {
    const tCfg = tools[tName];
    if (isPlainObj(tCfg) && tCfg.eager === true) {
      eagerTools.push(tName);
    } else {
      lazyTools.push(tName);
    }
  }

  let toolLoading = 'lazy';
  if (eagerTools.length > 0 && lazyTools.length === 0) toolLoading = 'eager';
  else if (eagerTools.length > 0 && lazyTools.length > 0) toolLoading = 'mixed';

  const transport = def.command ? 'stdio' : (def.url || def.serverUrl ? 'http' : 'unknown');
  const serialized = JSON.stringify(def);
  const estimatedConfigBytes = Buffer.byteLength(serialized, 'utf8');

  return {
    id: meta.pluginName
      ? `${meta.scope}:plugin:${meta.pluginName}:${serverName}`
      : `${meta.scope}:${serverName}`,
    type: 'mcp',
    scope: meta.scope,
    source: meta.pluginName ? `plugin:${meta.pluginName}` : 'standalone',
    pluginName: meta.pluginName || null,
    serverName,
    configPath: meta.configPath,
    transport,
    command: typeof def.command === 'string' ? def.command : null,
    args: Array.isArray(def.args) ? [...def.args] : [],
    url: typeof def.url === 'string' ? def.url : (typeof def.serverUrl === 'string' ? def.serverUrl : null),
    envKeys: isPlainObj(def.env) ? Object.keys(def.env) : [],
    headerKeys: isPlainObj(def.headers) ? Object.keys(def.headers) : [],
    disabled: Boolean(def.disabled),
    enabled: !def.disabled,
    tools,
    toolNames,
    eagerTools,
    lazyTools,
    toolLoading,
    estimatedConfigBytes,
    estimatedConfigTokens: estimateTokens(serialized)
  };
}

function scanMcpConfigFile(configPath, meta) {
  const data = readJsonQuiet(configPath, null);
  if (!isPlainObj(data) || !isPlainObj(data.mcpServers)) return [];
  return Object.entries(data.mcpServers).map(([serverName, srvDef]) => (
    buildMcpServerSummary(serverName, srvDef, { ...meta, configPath })
  ));
}

function scanPluginsInScope(scope, paths, configData, pluginsManifest) {
  const items = [];
  const mcpServers = [];
  if (!paths.pluginsDir || !fs.existsSync(paths.pluginsDir)) {
    return { plugins: items, mcpServers };
  }

  const excludePatterns = Array.isArray(pluginsManifest?.exclude) ? pluginsManifest.exclude : [];
  const entries = fs.readdirSync(paths.pluginsDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const pluginPath = path.join(paths.pluginsDir, ent.name);
    const linkInfo = inspectEntrySymlink(pluginPath);
    if (!linkInfo.isDirectory && !linkInfo.brokenSymlink) continue;

    const { manifest, manifestPath } = linkInfo.brokenSymlink
      ? { manifest: null, manifestPath: null }
      : readPluginManifestInfo(pluginPath);

    const skillsSubDir = path.join(pluginPath, 'skills');
    const rulesSubDir = path.join(pluginPath, 'rules');
    const hooksSubFile = path.join(pluginPath, 'hooks.json');
    const mcpSubFile = fs.existsSync(path.join(pluginPath, 'mcp_config.json'))
      ? path.join(pluginPath, 'mcp_config.json')
      : (fs.existsSync(path.join(pluginPath, 'mcp.json')) ? path.join(pluginPath, 'mcp.json') : null);

    const bundledSkills = (!linkInfo.brokenSymlink && fs.existsSync(skillsSubDir))
      ? fs.readdirSync(skillsSubDir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.') && (d.isDirectory() || d.isSymbolicLink())).map((d) => d.name).sort()
      : [];
    const bundledRules = (!linkInfo.brokenSymlink && fs.existsSync(rulesSubDir))
      ? fs.readdirSync(rulesSubDir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => d.name).sort()
      : [];
    const hasHooks = !linkInfo.brokenSymlink && fs.existsSync(hooksSubFile);
    const pluginMcpServers = (!linkInfo.brokenSymlink && mcpSubFile)
      ? scanMcpConfigFile(mcpSubFile, { scope, pluginName: ent.name })
      : [];
    mcpServers.push(...pluginMcpServers);

    const cfgEntry = isPlainObj(configData?.plugins?.[ent.name]) ? configData.plugins[ent.name] : null;
    let enabled = manifest?.disabled !== true;
    if (matchesPatternList(ent.name, excludePatterns)) enabled = false;
    if (cfgEntry && typeof cfgEntry.enabled === 'boolean') enabled = cfgEntry.enabled;

    items.push({
      id: `${scope}:plugin:${ent.name}`,
      type: 'plugin',
      name: ent.name,
      displayName: manifest?.displayName || manifest?.name || ent.name,
      version: manifest?.version || null,
      description: manifest?.description || '',
      managedBy: manifest?.managedBy || null,
      scope,
      path: pluginPath,
      manifestPath,
      enabled,
      isSymlink: linkInfo.isSymlink,
      symlinkTarget: linkInfo.symlinkTarget,
      brokenSymlink: linkInfo.brokenSymlink,
      assets: {
        skills: bundledSkills,
        rules: bundledRules,
        hasHooks,
        mcpConfigPath: mcpSubFile,
        mcpServers: pluginMcpServers.map((s) => s.serverName)
      }
    });
  }

  return { plugins: items, mcpServers };
}

function scanSkillsInScope(scope, paths, configData, skillsManifest) {
  const items = [];
  if (!paths.skillsDir || !fs.existsSync(paths.skillsDir)) return items;

  const excludePatterns = Array.isArray(skillsManifest?.exclude) ? skillsManifest.exclude : [];
  const entries = fs.readdirSync(paths.skillsDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const skillPath = path.join(paths.skillsDir, ent.name);
    const linkInfo = inspectEntrySymlink(skillPath);
    if (!linkInfo.isDirectory && !linkInfo.brokenSymlink) continue;

    const skillMdPath = path.join(skillPath, 'SKILL.md');
    let frontmatter = {};
    const hasSkillMd = !linkInfo.brokenSymlink && fs.existsSync(skillMdPath);
    if (hasSkillMd) {
      try {
        frontmatter = parseFrontmatter(fs.readFileSync(skillMdPath, 'utf8')).data;
      } catch {}
    }

    const cfgEntry = isPlainObj(configData?.skills?.[ent.name]) ? configData.skills[ent.name] : null;
    let enabled = frontmatter.disabled !== true;
    if (matchesPatternList(ent.name, excludePatterns)) enabled = false;
    if (cfgEntry && typeof cfgEntry.enabled === 'boolean') enabled = cfgEntry.enabled;

    items.push({
      id: `${scope}:skill:${ent.name}`,
      type: 'skill',
      name: ent.name,
      displayName: typeof frontmatter.name === 'string' && frontmatter.name ? frontmatter.name : ent.name,
      description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
      scope,
      path: skillPath,
      skillMdPath: hasSkillMd ? skillMdPath : null,
      hasSkillMd,
      hasScripts: !linkInfo.brokenSymlink && fs.existsSync(path.join(skillPath, 'scripts')),
      hasReferences: !linkInfo.brokenSymlink && fs.existsSync(path.join(skillPath, 'references')),
      enabled,
      isSymlink: linkInfo.isSymlink,
      symlinkTarget: linkInfo.symlinkTarget,
      brokenSymlink: linkInfo.brokenSymlink
    });
  }

  return items;
}

function scanRulesInScope(scope, paths, configData, rulesManifest) {
  const items = [];
  const excludePatterns = Array.isArray(rulesManifest?.exclude) ? rulesManifest.exclude : [];

  const addRuleFile = (filePath, name, sourceKind) => {
    const linkInfo = inspectEntrySymlink(filePath);
    if (linkInfo.brokenSymlink) {
      items.push({
        id: `${scope}:rule:${name}`,
        type: 'rule',
        name,
        scope,
        source: sourceKind,
        path: filePath,
        trigger: 'unknown',
        description: '',
        bytes: 0,
        estimatedTokens: 0,
        enabled: false,
        isSymlink: linkInfo.isSymlink,
        symlinkTarget: linkInfo.symlinkTarget,
        brokenSymlink: true
      });
      return;
    }
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { return; }
    const { data: fm } = parseFrontmatter(content);
    const bytes = Buffer.byteLength(content, 'utf8');
    const cfgEntry = isPlainObj(configData?.rules?.[name]) ? configData.rules[name] : null;
    let enabled = fm.disabled !== true;
    if (matchesPatternList(name, excludePatterns)) enabled = false;
    if (cfgEntry && typeof cfgEntry.enabled === 'boolean') enabled = cfgEntry.enabled;

    items.push({
      id: `${scope}:rule:${name}`,
      type: 'rule',
      name,
      scope,
      source: sourceKind,
      path: filePath,
      trigger: typeof fm.trigger === 'string' ? fm.trigger : (fm.alwaysApply === false ? 'manual' : 'always_on'),
      description: typeof fm.description === 'string' ? fm.description : '',
      globs: fm.globs || null,
      bytes,
      estimatedTokens: estimateTokens(content),
      enabled,
      isSymlink: linkInfo.isSymlink,
      symlinkTarget: linkInfo.symlinkTarget,
      brokenSymlink: false
    });
  };

  if (paths.rulesDir && fs.existsSync(paths.rulesDir)) {
    for (const ent of fs.readdirSync(paths.rulesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith('.')) continue;
      if (!ent.name.toLowerCase().endsWith('.md')) continue;
      addRuleFile(path.join(paths.rulesDir, ent.name), ent.name, 'rules-dir');
    }
  }

  const rootDocBase = scope === 'workspace' ? paths.workspaceRoot : paths.rootDir;
  if (rootDocBase && fs.existsSync(rootDocBase)) {
    for (const docName of ['AGENTS.md', 'GEMINI.md']) {
      const candidate = path.join(rootDocBase, docName);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        addRuleFile(candidate, docName, 'root-doc');
      }
    }
  }

  return items;
}

function scanHooksInScope(scope, paths) {
  const items = [];
  if (paths.hooksFile && fs.existsSync(paths.hooksFile)) {
    const parsed = readJsonQuiet(paths.hooksFile, null);
    if (isPlainObj(parsed)) {
      const hookMap = isPlainObj(parsed.hooks) && !('enabled' in parsed) ? parsed.hooks : parsed;
      for (const [hookName, def] of Object.entries(hookMap)) {
        if (!isPlainObj(def) && !Array.isArray(def)) continue;
        const events = isPlainObj(def)
          ? Object.keys(def).filter((k) => k !== 'enabled' && Array.isArray(def[k]))
          : [];
        items.push({
          id: `${scope}:hook:${hookName}`,
          type: 'hook',
          name: hookName,
          scope,
          path: paths.hooksFile,
          events,
          enabled: isPlainObj(def) && typeof def.enabled === 'boolean' ? def.enabled : true
        });
      }
    }
  }
  if (paths.hooksDir && fs.existsSync(paths.hooksDir)) {
    for (const ent of fs.readdirSync(paths.hooksDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith('.')) continue;
      items.push({
        id: `${scope}:hook-file:${ent.name}`,
        type: 'hook',
        name: ent.name,
        scope,
        path: path.join(paths.hooksDir, ent.name),
        events: [],
        enabled: true,
        isFile: true
      });
    }
  }
  return items;
}

async function scanCustomizations(options = {}) {
  const wsInfo = await detectActiveWorkspaceRoot(options);
  const globalPaths = resolveScopePaths('global', options);
  const globalConfig = readJsonQuiet(globalPaths.configJsonPath, {}) || {};
  const globalSkillsManifest = readJsonQuiet(globalPaths.skillsJsonPath, {}) || {};
  const globalPluginsManifest = readJsonQuiet(globalPaths.pluginsJsonPath, {}) || {};
  const globalRulesManifest = readJsonQuiet(globalPaths.rulesJsonPath, {}) || {};

  const globalPluginScan = scanPluginsInScope('global', globalPaths, globalConfig, globalPluginsManifest);
  const globalSkills = scanSkillsInScope('global', globalPaths, globalConfig, globalSkillsManifest);
  const globalRules = scanRulesInScope('global', globalPaths, globalConfig, globalRulesManifest);
  const globalHooks = scanHooksInScope('global', globalPaths);
  const globalStandaloneMcp = scanMcpConfigFile(globalPaths.mcpConfigPath, { scope: 'global', pluginName: null });

  let workspacePaths = null;
  let workspaceExists = false;
  let agentsExists = false;
  let wsPluginScan = { plugins: [], mcpServers: [] };
  let wsSkills = [];
  let wsRules = [];
  let wsHooks = [];
  let wsStandaloneMcp = [];

  if (wsInfo.root) {
    workspacePaths = resolveScopePaths('workspace', { ...options, workspaceRoot: wsInfo.root });
    workspaceExists = fs.existsSync(wsInfo.root);
    agentsExists = Boolean(workspacePaths.rootDir && fs.existsSync(workspacePaths.rootDir));
    const wsConfig = readJsonQuiet(workspacePaths.configJsonPath, {}) || {};
    const wsSkillsManifest = readJsonQuiet(workspacePaths.skillsJsonPath, {}) || {};
    const wsPluginsManifest = readJsonQuiet(workspacePaths.pluginsJsonPath, {}) || {};
    const wsRulesManifest = readJsonQuiet(workspacePaths.rulesJsonPath, {}) || {};

    wsPluginScan = scanPluginsInScope('workspace', workspacePaths, wsConfig, wsPluginsManifest);
    wsSkills = scanSkillsInScope('workspace', workspacePaths, wsConfig, wsSkillsManifest);
    wsRules = scanRulesInScope('workspace', workspacePaths, wsConfig, wsRulesManifest);
    wsHooks = scanHooksInScope('workspace', workspacePaths);
    wsStandaloneMcp = scanMcpConfigFile(workspacePaths.mcpConfigPath, { scope: 'workspace', pluginName: null });
  }

  const plugins = [...globalPluginScan.plugins, ...wsPluginScan.plugins];
  const skills = [...globalSkills, ...wsSkills];
  const rules = [...globalRules, ...wsRules];
  const hooks = [...globalHooks, ...wsHooks];
  const mcpServers = [
    ...globalStandaloneMcp,
    ...globalPluginScan.mcpServers,
    ...wsStandaloneMcp,
    ...wsPluginScan.mcpServers
  ];

  const sumRuleTokens = (arr) => arr.reduce((acc, r) => acc + (r.enabled ? (r.estimatedTokens || 0) : 0), 0);
  const sumRuleBytes = (arr) => arr.reduce((acc, r) => acc + (r.enabled ? (r.bytes || 0) : 0), 0);

  const globalCount = globalPluginScan.plugins.length
    + globalSkills.length
    + globalRules.length
    + globalHooks.length
    + globalStandaloneMcp.length
    + globalPluginScan.mcpServers.length;
  const workspaceCount = wsPluginScan.plugins.length
    + wsSkills.length
    + wsRules.length
    + wsHooks.length
    + wsStandaloneMcp.length
    + wsPluginScan.mcpServers.length;

  return {
    ok: true,
    scannedAt: new Date().toISOString(),
    workspace: {
      root: wsInfo.root,
      source: wsInfo.source,
      exists: workspaceExists,
      agentsDir: workspacePaths?.rootDir || null,
      agentsExists
    },
    paths: {
      global: globalPaths,
      workspace: workspacePaths
    },
    summary: {
      total: globalCount + workspaceCount,
      byScope: {
        global: globalCount,
        workspace: workspaceCount
      },
      byType: {
        plugins: plugins.length,
        skills: skills.length,
        rules: rules.length,
        hooks: hooks.length,
        mcpServers: mcpServers.length
      },
      rulesBudget: {
        limitTokens: DEFAULT_TOKEN_BUDGET,
        globalBytes: sumRuleBytes(globalRules),
        globalEstimatedTokens: sumRuleTokens(globalRules),
        workspaceBytes: sumRuleBytes(wsRules),
        workspaceEstimatedTokens: sumRuleTokens(wsRules)
      }
    },
    items: {
      plugins,
      skills,
      rules,
      hooks,
      mcpServers
    }
  };
}

function writeJsonPreservingMode(targetPath, data, defaultMode = null) {
  let mode = defaultMode;
  try {
    if (fs.existsSync(targetPath)) {
      mode = fs.statSync(targetPath).mode & 0o777;
    }
  } catch {}
  const res = safeWriteJsonSync(targetPath, data);
  if (res.ok && typeof mode === 'number') {
    try { fs.chmodSync(targetPath, mode); } catch {}
  }
  return res;
}

function updateExcludeInManifest(manifestPath, itemName, enabled) {
  return withFileLockSync(manifestPath, () => {
    const existing = readJsonQuiet(manifestPath, {});
    const next = isPlainObj(existing) ? { ...existing } : {};
    const exclude = Array.isArray(next.exclude) ? next.exclude.filter((x) => typeof x === 'string') : [];
    const filtered = exclude.filter((pat) => pat !== itemName);
    if (!enabled) {
      filtered.push(itemName);
    }
    if (filtered.length > 0) {
      next.exclude = filtered;
    } else {
      delete next.exclude;
    }
    const writeRes = safeWriteJsonSync(manifestPath, next);
    if (!writeRes.ok) throw createCodedError('WRITE_FAILED', writeRes.error);
    return { manifestPath, exclude: next.exclude || [] };
  });
}

function resolveMcpTargetPath(params, options = {}) {
  if (typeof params.mcpConfigPath === 'string' && params.mcpConfigPath.trim()) {
    const resolved = path.resolve(params.mcpConfigPath.trim());
    return {
      mcpConfigPath: resolved,
      pluginDir: path.dirname(resolved),
      pluginName: params.pluginName ? assertSafeItemName(params.pluginName, 'pluginName') : null,
      scope: params.scope || 'custom'
    };
  }
  const scope = params.scope || 'global';
  const scopePaths = resolveScopePaths(scope, options);
  if (scope === 'workspace' && !scopePaths.rootDir) {
    throw createCodedError('WORKSPACE_REQUIRED', 'workspaceRoot is required for workspace scope');
  }
  if (params.pluginName) {
    const pluginName = assertSafeItemName(params.pluginName, 'pluginName');
    const pluginDir = assertInsideRoot(scopePaths.pluginsDir, pluginName);
    const preferred = path.join(pluginDir, 'mcp_config.json');
    const fallback = path.join(pluginDir, 'mcp.json');
    const mcpConfigPath = fs.existsSync(preferred) || !fs.existsSync(fallback) ? preferred : fallback;
    return { mcpConfigPath, pluginDir, pluginName, scope };
  }
  return {
    mcpConfigPath: scopePaths.mcpConfigPath,
    pluginDir: null,
    pluginName: null,
    scope
  };
}

function setCustomizationEnabled(params = {}, options = {}) {
  const type = String(params.type || '').trim().toLowerCase();
  if (!CUSTOMIZATION_TYPES.includes(type)) {
    throw createCodedError('INVALID_TYPE', `Unsupported customization type: ${String(params.type)}`);
  }
  const scope = String(params.scope || 'global').trim().toLowerCase();
  if (!CUSTOMIZATION_SCOPES.includes(scope)) {
    throw createCodedError('INVALID_SCOPE', `Unsupported customization scope: ${String(params.scope)}`);
  }
  if (typeof params.enabled !== 'boolean') {
    throw createCodedError('INVALID_ENABLED', 'enabled must be a boolean');
  }
  const enabled = params.enabled;
  const scopePaths = resolveScopePaths(scope, { ...options, workspaceRoot: params.workspaceRoot || options.workspaceRoot });
  if (scope === 'workspace' && !scopePaths.workspaceRoot) {
    throw createCodedError('WORKSPACE_REQUIRED', 'workspaceRoot is required for workspace scope');
  }

  if (type === 'mcp') {
    const serverName = assertSafeItemName(params.serverName || params.name, 'serverName');
    const target = resolveMcpTargetPath({ ...params, scope }, { ...options, workspaceRoot: scopePaths.workspaceRoot });
    if (!fs.existsSync(target.mcpConfigPath)) {
      return { ok: false, code: 'NOT_FOUND', error: `mcp_config.json not found: ${target.mcpConfigPath}` };
    }
    return withFileLockSync(target.mcpConfigPath, () => {
      const cfg = readJsonQuiet(target.mcpConfigPath, null);
      if (!isPlainObj(cfg) || !isPlainObj(cfg.mcpServers) || !isPlainObj(cfg.mcpServers[serverName])) {
        return { ok: false, code: 'NOT_FOUND', error: `MCP server not found: ${serverName}` };
      }
      cfg.mcpServers[serverName] = {
        ...cfg.mcpServers[serverName],
        disabled: !enabled
      };
      const wr = writeJsonPreservingMode(target.mcpConfigPath, cfg);
      if (!wr.ok) throw createCodedError('WRITE_FAILED', wr.error);
      return {
        ok: true,
        type,
        scope,
        name: serverName,
        pluginName: target.pluginName,
        enabled,
        configPath: target.mcpConfigPath,
        updatedAt: new Date().toISOString()
      };
    });
  }

  const safeName = assertSafeItemName(params.name, `${type} name`);

  if (type === 'hook') {
    if (!fs.existsSync(scopePaths.hooksFile)) {
      return { ok: false, code: 'NOT_FOUND', error: `hooks.json not found: ${scopePaths.hooksFile}` };
    }
    return withFileLockSync(scopePaths.hooksFile, () => {
      const hooksCfg = readJsonQuiet(scopePaths.hooksFile, null);
      if (!isPlainObj(hooksCfg)) {
        return { ok: false, code: 'INVALID_CONFIG', error: `Invalid hooks.json: ${scopePaths.hooksFile}` };
      }
      const container = isPlainObj(hooksCfg.hooks) && !('enabled' in hooksCfg) ? hooksCfg.hooks : hooksCfg;
      if (!isPlainObj(container[safeName])) {
        return { ok: false, code: 'NOT_FOUND', error: `Hook not found: ${safeName}` };
      }
      container[safeName] = { ...container[safeName], enabled };
      const wr = writeJsonPreservingMode(scopePaths.hooksFile, hooksCfg);
      if (!wr.ok) throw createCodedError('WRITE_FAILED', wr.error);
      return {
        ok: true,
        type,
        scope,
        name: safeName,
        enabled,
        configPath: scopePaths.hooksFile,
        updatedAt: new Date().toISOString()
      };
    });
  }

  const bucketMap = { plugin: 'plugins', skill: 'skills', rule: 'rules' };
  const manifestMap = {
    plugin: scopePaths.pluginsJsonPath,
    skill: scopePaths.skillsJsonPath,
    rule: scopePaths.rulesJsonPath
  };
  const bucket = bucketMap[type];
  const manifestPath = manifestMap[type];

  const writeToManifestOnly = params.targetManifest === 'skills.json'
    || params.targetManifest === 'plugins.json'
    || params.targetManifest === 'rules.json';

  let manifestSync = null;
  if (manifestPath && (writeToManifestOnly || fs.existsSync(manifestPath))) {
    manifestSync = updateExcludeInManifest(manifestPath, safeName, enabled);
  }

  if (writeToManifestOnly) {
    return {
      ok: true,
      type,
      scope,
      name: safeName,
      enabled,
      configPath: manifestPath,
      manifestSync,
      updatedAt: new Date().toISOString()
    };
  }

  return withFileLockSync(scopePaths.configJsonPath, () => {
    const cfg = readJsonQuiet(scopePaths.configJsonPath, {}) || {};
    const nextCfg = isPlainObj(cfg) ? { ...cfg } : {};
    const currentBucket = isPlainObj(nextCfg[bucket]) ? { ...nextCfg[bucket] } : {};
    const existingEntry = isPlainObj(currentBucket[safeName]) ? { ...currentBucket[safeName] } : {};
    currentBucket[safeName] = { ...existingEntry, enabled };
    nextCfg[bucket] = currentBucket;

    const wr = writeJsonPreservingMode(
      scopePaths.configJsonPath,
      nextCfg,
      scope === 'global' ? 0o600 : null
    );
    if (!wr.ok) throw createCodedError('WRITE_FAILED', wr.error);
    return {
      ok: true,
      type,
      scope,
      name: safeName,
      enabled,
      configPath: scopePaths.configJsonPath,
      manifestSync,
      updatedAt: new Date().toISOString()
    };
  });
}

function removeTargetPathSafe(targetPath) {
  const lst = fs.lstatSync(targetPath);
  if (lst.isSymbolicLink() || lst.isFile()) {
    fs.unlinkSync(targetPath);
    return { wasSymlink: lst.isSymbolicLink() };
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
  return { wasSymlink: false };
}

function getTypeDir(scopePaths, type) {
  if (type === 'plugin') return scopePaths.pluginsDir;
  if (type === 'skill') return scopePaths.skillsDir;
  if (type === 'rule') return scopePaths.rulesDir;
  throw createCodedError('INVALID_TYPE', `Install/uninstall/migrate does not support type: ${type}`);
}

function copyOrLinkAsset({ sourcePath, targetPath, mode, isDir }) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (mode === 'symlink') {
    const linkType = isDir ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file';
    fs.symlinkSync(sourcePath, targetPath, linkType);
    return;
  }
  if (isDir) {
    fs.cpSync(sourcePath, targetPath, { recursive: true, dereference: true });
  } else {
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function installCustomization(params = {}, options = {}) {
  const type = String(params.type || '').trim().toLowerCase();
  if (!['plugin', 'skill', 'rule'].includes(type)) {
    throw createCodedError('INVALID_TYPE', `Unsupported install type: ${String(params.type)}`);
  }
  const scope = String(params.scope || 'global').trim().toLowerCase();
  if (!CUSTOMIZATION_SCOPES.includes(scope)) {
    throw createCodedError('INVALID_SCOPE', `Unsupported customization scope: ${String(params.scope)}`);
  }
  const mode = String(params.mode || 'copy').trim().toLowerCase();
  if (!['copy', 'symlink'].includes(mode)) {
    throw createCodedError('INVALID_MODE', `Unsupported install mode: ${mode}`);
  }
  const rawSource = String(params.sourcePath || '').trim();
  if (!rawSource) {
    throw createCodedError('SOURCE_REQUIRED', 'sourcePath is required');
  }
  const sourcePath = path.resolve(rawSource);
  if (!fs.existsSync(sourcePath)) {
    return { ok: false, code: 'SOURCE_NOT_FOUND', error: `Source path does not exist: ${sourcePath}` };
  }
  const srcStat = fs.statSync(sourcePath);
  const isDir = srcStat.isDirectory();
  if ((type === 'plugin' || type === 'skill') && !isDir) {
    throw createCodedError('INVALID_SOURCE', `${type} sourcePath must be a directory: ${sourcePath}`);
  }

  const scopePaths = resolveScopePaths(scope, { ...options, workspaceRoot: params.workspaceRoot || options.workspaceRoot });
  if (scope === 'workspace' && !scopePaths.workspaceRoot) {
    throw createCodedError('WORKSPACE_REQUIRED', 'workspaceRoot is required for workspace scope');
  }
  const typeDir = getTypeDir(scopePaths, type);
  const safeName = assertSafeItemName(params.name || path.basename(sourcePath), `${type} name`);
  const targetPath = assertInsideRoot(typeDir, safeName);

  let exists = false;
  try {
    fs.lstatSync(targetPath);
    exists = true;
  } catch {}

  if (exists) {
    if (!params.overwrite) {
      return { ok: false, code: 'ALREADY_EXISTS', error: `${type} already exists at ${targetPath}`, targetPath };
    }
    removeTargetPathSafe(targetPath);
  }

  const effectiveSource = mode === 'copy' ? fs.realpathSync(sourcePath) : sourcePath;
  copyOrLinkAsset({ sourcePath: effectiveSource, targetPath, mode, isDir });

  let enabledResult = null;
  if (typeof params.enabled === 'boolean') {
    enabledResult = setCustomizationEnabled(
      { type, name: safeName, scope, enabled: params.enabled, workspaceRoot: scopePaths.workspaceRoot },
      options
    );
  }

  return {
    ok: true,
    type,
    name: safeName,
    scope,
    mode,
    sourcePath: effectiveSource,
    targetPath,
    ...(enabledResult ? { configUpdate: enabledResult } : {})
  };
}

function cleanupConfigForRemovedItem(scopePaths, type, safeName) {
  const bucketMap = { plugin: 'plugins', skill: 'skills', rule: 'rules' };
  const bucket = bucketMap[type];
  if (bucket && scopePaths.configJsonPath && fs.existsSync(scopePaths.configJsonPath)) {
    withFileLockSync(scopePaths.configJsonPath, () => {
      const cfg = readJsonQuiet(scopePaths.configJsonPath, null);
      if (isPlainObj(cfg) && isPlainObj(cfg[bucket]) && Object.prototype.hasOwnProperty.call(cfg[bucket], safeName)) {
        delete cfg[bucket][safeName];
        writeJsonPreservingMode(scopePaths.configJsonPath, cfg, scopePaths.scope === 'global' ? 0o600 : null);
      }
    });
  }
  const manifestPath = type === 'plugin'
    ? scopePaths.pluginsJsonPath
    : (type === 'skill' ? scopePaths.skillsJsonPath : scopePaths.rulesJsonPath);
  if (manifestPath && fs.existsSync(manifestPath)) {
    updateExcludeInManifest(manifestPath, safeName, true);
  }
}

function uninstallCustomization(params = {}, options = {}) {
  const type = String(params.type || '').trim().toLowerCase();
  if (!['plugin', 'skill', 'rule'].includes(type)) {
    throw createCodedError('INVALID_TYPE', `Unsupported uninstall type: ${String(params.type)}`);
  }
  const scope = String(params.scope || 'global').trim().toLowerCase();
  if (!CUSTOMIZATION_SCOPES.includes(scope)) {
    throw createCodedError('INVALID_SCOPE', `Unsupported customization scope: ${String(params.scope)}`);
  }
  const safeName = assertSafeItemName(params.name, `${type} name`);
  const scopePaths = resolveScopePaths(scope, { ...options, workspaceRoot: params.workspaceRoot || options.workspaceRoot });
  if (scope === 'workspace' && !scopePaths.workspaceRoot) {
    throw createCodedError('WORKSPACE_REQUIRED', 'workspaceRoot is required for workspace scope');
  }
  const typeDir = getTypeDir(scopePaths, type);
  const targetPath = assertInsideRoot(typeDir, safeName);

  let exists = false;
  try {
    fs.lstatSync(targetPath);
    exists = true;
  } catch {}
  if (!exists) {
    return { ok: false, code: 'NOT_FOUND', error: `${type} not found: ${targetPath}` };
  }

  const { wasSymlink } = removeTargetPathSafe(targetPath);
  if (params.cleanConfig !== false) {
    cleanupConfigForRemovedItem(scopePaths, type, safeName);
  }

  return {
    ok: true,
    type,
    name: safeName,
    scope,
    removedPath: targetPath,
    wasSymlink
  };
}

function migrateCustomizationToWorkspace(params = {}, options = {}) {
  const type = String(params.type || '').trim().toLowerCase();
  if (!['plugin', 'skill', 'rule'].includes(type)) {
    throw createCodedError('INVALID_TYPE', `Unsupported migration type: ${String(params.type)}`);
  }
  const safeName = assertSafeItemName(params.name, `${type} name`);
  const direction = params.direction === 'to-global' ? 'to-global' : 'to-workspace';
  const fromScope = direction === 'to-workspace' ? 'global' : 'workspace';
  const toScope = direction === 'to-workspace' ? 'workspace' : 'global';
  const mode = String(params.mode || 'copy').trim().toLowerCase();
  if (!['copy', 'symlink'].includes(mode)) {
    throw createCodedError('INVALID_MODE', `Unsupported migration mode: ${mode}`);
  }

  const wsRoot = params.workspaceRoot || options.workspaceRoot || options.fallbackWorkspaceRoot;
  if (!wsRoot) {
    throw createCodedError('WORKSPACE_REQUIRED', 'workspaceRoot is required for migration');
  }
  const resolvedWsRoot = path.resolve(String(wsRoot));
  if (!fs.existsSync(resolvedWsRoot) || !fs.statSync(resolvedWsRoot).isDirectory()) {
    return { ok: false, code: 'WORKSPACE_NOT_FOUND', error: `Workspace directory does not exist: ${resolvedWsRoot}` };
  }

  const srcPaths = resolveScopePaths(fromScope, { ...options, workspaceRoot: resolvedWsRoot });
  const srcTypeDir = getTypeDir(srcPaths, type);
  const srcPath = assertInsideRoot(srcTypeDir, safeName);
  if (!fs.existsSync(srcPath)) {
    return { ok: false, code: 'SOURCE_NOT_FOUND', error: `Source ${type} not found in ${fromScope}: ${srcPath}` };
  }

  const installRes = installCustomization({
    type,
    name: safeName,
    sourcePath: srcPath,
    scope: toScope,
    mode,
    overwrite: Boolean(params.overwrite),
    workspaceRoot: resolvedWsRoot
  }, options);

  if (!installRes.ok) return installRes;

  let disabledGlobal = false;
  if (direction === 'to-workspace' && params.disableGlobal === true) {
    setCustomizationEnabled({ type, name: safeName, scope: 'global', enabled: false }, options);
    disabledGlobal = true;
  }

  return {
    ok: true,
    type,
    name: safeName,
    direction,
    fromScope,
    toScope,
    mode,
    sourcePath: installRes.sourcePath,
    targetPath: installRes.targetPath,
    disabledGlobal
  };
}

function getMcpBackupsDir(targetKey, options = {}) {
  const safeKey = String(targetKey || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(getStateDir(options), 'mcp-backups', safeKey);
}

function computeMcpBackupTargetKey(target) {
  const hash = crypto.createHash('sha1').update(path.resolve(target.mcpConfigPath)).digest('hex').slice(0, 10);
  const label = target.pluginName ? `plugin-${target.pluginName}` : `${target.scope}-root`;
  return `${label}-${hash}`;
}

function pruneMcpBackups(backupRoot, maxKeep = MAX_MCP_BACKUPS) {
  if (!fs.existsSync(backupRoot)) return;
  const entries = [];
  for (const ent of fs.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dirPath = path.join(backupRoot, ent.name);
    let createdAtMs = 0;
    try {
      const meta = readJsonQuiet(path.join(dirPath, 'meta.json'), null);
      createdAtMs = Date.parse(meta?.createdAt || '') || fs.statSync(dirPath).mtimeMs || 0;
    } catch {}
    entries.push({ name: ent.name, dirPath, createdAtMs });
  }
  entries.sort((a, b) => (b.createdAtMs !== a.createdAtMs ? b.createdAtMs - a.createdAtMs : b.name.localeCompare(a.name)));
  for (let i = maxKeep; i < entries.length; i += 1) {
    try { fs.rmSync(entries[i].dirPath, { recursive: true, force: true }); } catch {}
  }
}

function backupMcpConfig(target, reason, options = {}) {
  const targetKey = computeMcpBackupTargetKey(target);
  const backupRoot = getMcpBackupsDir(targetKey, options);
  const existed = fs.existsSync(target.mcpConfigPath);
  const now = new Date();
  const backupId = `${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const backupDir = path.join(backupRoot, backupId);
  fs.mkdirSync(backupDir, { recursive: true });
  if (existed) {
    fs.copyFileSync(target.mcpConfigPath, path.join(backupDir, 'mcp_config.json'));
  }
  const meta = {
    schemaVersion: 1,
    backupId,
    targetKey,
    mcpConfigPath: target.mcpConfigPath,
    pluginName: target.pluginName || null,
    scope: target.scope,
    existedBefore: existed,
    reason: String(reason || 'mcp-policy'),
    createdAt: now.toISOString()
  };
  safeWriteJsonSync(path.join(backupDir, 'meta.json'), meta);
  pruneMcpBackups(backupRoot);
  return meta;
}

function listMcpConfigBackups(params = {}, options = {}) {
  const target = resolveMcpTargetPath(params, options);
  const targetKey = computeMcpBackupTargetKey(target);
  const backupRoot = getMcpBackupsDir(targetKey, options);
  if (!fs.existsSync(backupRoot)) return [];
  const list = [];
  for (const ent of fs.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const meta = readJsonQuiet(path.join(backupRoot, ent.name, 'meta.json'), null);
    if (isPlainObj(meta)) list.push(meta);
  }
  list.sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0));
  return list;
}

function rollbackMcpConfig(params = {}, options = {}) {
  const target = resolveMcpTargetPath(params, options);
  const targetKey = computeMcpBackupTargetKey(target);
  const backupRoot = getMcpBackupsDir(targetKey, options);
  const backups = listMcpConfigBackups(params, options);
  const chosen = params.backupId
    ? backups.find((b) => b.backupId === params.backupId)
    : backups[0];
  if (!chosen) {
    return { ok: false, code: 'NO_BACKUP', error: 'No MCP config backup available for rollback' };
  }

  return withFileLockSync(target.mcpConfigPath, () => {
    const backupFile = path.join(backupRoot, chosen.backupId, 'mcp_config.json');
    if (chosen.existedBefore && fs.existsSync(backupFile)) {
      const content = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
      const wr = writeJsonPreservingMode(target.mcpConfigPath, content);
      if (!wr.ok) throw createCodedError('WRITE_FAILED', wr.error);
    } else if (!chosen.existedBefore && fs.existsSync(target.mcpConfigPath)) {
      fs.unlinkSync(target.mcpConfigPath);
    }
    try { fs.rmSync(path.join(backupRoot, chosen.backupId), { recursive: true, force: true }); } catch {}
    return {
      ok: true,
      rolledBack: true,
      backupId: chosen.backupId,
      mcpConfigPath: target.mcpConfigPath,
      existedBefore: Boolean(chosen.existedBefore)
    };
  });
}

function expandPluginRootInValue(value, pluginDir) {
  if (!pluginDir || typeof value !== 'string') return value;
  return value.replace(/\$\{PLUGIN_ROOT\}|\$PLUGIN_ROOT/g, pluginDir);
}

function probeMcpServerTools(serverDef, options = {}) {
  if (!isPlainObj(serverDef) || !serverDef.command) {
    return Promise.resolve({ ok: false, error: 'Only stdio MCP servers can be probed', tools: [] });
  }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000;
  const pluginDir = options.pluginDir || null;
  const cmd = expandPluginRootInValue(serverDef.command, pluginDir);
  const args = (Array.isArray(serverDef.args) ? serverDef.args : []).map((a) => expandPluginRootInValue(a, pluginDir));
  const env = { ...process.env, ...(isPlainObj(serverDef.env) ? serverDef.env : {}) };

  return new Promise((resolve) => {
    let settled = false;
    let outBuf = '';
    let errBuf = '';
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, error: err?.message || String(err), tools: [] });
      return;
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `MCP probe timeout (${timeoutMs}ms)`, tools: [] });
    }, timeoutMs);

    const handleFrame = (msg) => {
      if (!isPlainObj(msg)) return;
      if (msg.id === 2) {
        const tools = Array.isArray(msg.result?.tools) ? msg.result.tools : [];
        finish({ ok: true, tools });
      }
    };

    child.stdout.on('data', (chunk) => {
      outBuf += chunk.toString('utf8');
      while (outBuf.length > 0) {
        const clMatch = outBuf.match(/^Content-Length:\s*(\d+)\r?\n\r?\n/i);
        if (clMatch) {
          const len = Number(clMatch[1]);
          const hdrLen = clMatch[0].length;
          if (outBuf.length < hdrLen + len) break;
          const body = outBuf.slice(hdrLen, hdrLen + len);
          outBuf = outBuf.slice(hdrLen + len);
          try { handleFrame(JSON.parse(body)); } catch {}
          continue;
        }
        const nlIdx = outBuf.indexOf('\n');
        if (nlIdx === -1) break;
        const line = outBuf.slice(0, nlIdx).trim();
        outBuf = outBuf.slice(nlIdx + 1);
        if (!line) continue;
        try { handleFrame(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on('data', (c) => { errBuf += c.toString('utf8'); });
    child.on('error', (err) => finish({ ok: false, error: err?.message || String(err), tools: [] }));
    child.on('close', () => {
      if (!settled) {
        finish({ ok: false, error: errBuf.trim() || 'MCP probe closed before tools/list', tools: [] });
      }
    });

    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agy-daddy', version: '1.0.0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    ];
    for (const req of requests) {
      child.stdin.write(`${JSON.stringify(req)}\n`);
    }
  });
}

function normalizeToolSchemasInput(serverName, srvDef, rawSchemas, explicitToolNames, pluginName) {
  const byName = new Map();

  if (Array.isArray(rawSchemas)) {
    for (const item of rawSchemas) {
      if (isPlainObj(item) && typeof item.name === 'string' && item.name.trim()) {
        byName.set(item.name.trim(), item);
      }
    }
  } else if (isPlainObj(rawSchemas)) {
    for (const [name, schemaObj] of Object.entries(rawSchemas)) {
      if (isPlainObj(schemaObj)) {
        byName.set(name, { name, ...schemaObj });
      }
    }
  }

  if (isPlainObj(srvDef?.tools)) {
    for (const [name, toolCfg] of Object.entries(srvDef.tools)) {
      if (!byName.has(name)) {
        byName.set(name, { name, ...(isPlainObj(toolCfg) ? toolCfg : {}) });
      }
    }
  }

  if (Array.isArray(explicitToolNames)) {
    for (const name of explicitToolNames) {
      if (typeof name === 'string' && name.trim() && !byName.has(name.trim())) {
        byName.set(name.trim(), { name: name.trim() });
      }
    }
  }

  if (byName.size === 0 && pluginName && KNOWN_MCP_PLUGIN_TOOLS[pluginName]?.[serverName]) {
    for (const name of KNOWN_MCP_PLUGIN_TOOLS[pluginName][serverName]) {
      byName.set(name, { name });
    }
  }

  return Array.from(byName.values());
}

function buildProxySchema(serverName, toolSchemas = []) {
  const compactTools = toolSchemas.map((t) => {
    const props = isPlainObj(t.inputSchema?.properties) ? t.inputSchema.properties : {};
    const requiredSet = new Set(Array.isArray(t.inputSchema?.required) ? t.inputSchema.required : []);
    const params = Object.entries(props).map(([pName, pSchema]) => ({
      name: pName,
      type: pSchema?.type || (Array.isArray(pSchema?.enum) ? 'enum' : 'any'),
      required: requiredSet.has(pName)
    }));
    const summary = String(t.description || t.summary || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return {
      name: t.name,
      summary,
      params
    };
  });

  const json = {
    schemaVersion: 1,
    server: serverName,
    dispatch: 'call_mcp_tool',
    tools: compactTools
  };

  const mdLines = [
    `### MCP Proxy Schema: \`${serverName}\` (lazy via \`call_mcp_tool\`)`,
    ''
  ];
  for (const ct of compactTools) {
    const sig = ct.params
      .map((p) => `${p.name}${p.required ? '' : '?'}:${p.type}`)
      .join(', ');
    mdLines.push(`- \`${ct.name}({ ${sig} })\`${ct.summary ? ` — ${ct.summary}` : ''}`);
  }
  const markdown = mdLines.join('\n') + '\n';

  const rawJsonStr = JSON.stringify(toolSchemas);
  const proxyJsonStr = JSON.stringify(json);
  const rawBytes = Buffer.byteLength(rawJsonStr, 'utf8');
  const proxyBytes = Buffer.byteLength(proxyJsonStr, 'utf8');
  const rawTokens = estimateTokens(rawJsonStr);
  const proxyTokens = estimateTokens(proxyJsonStr);

  return {
    json,
    markdown,
    stats: {
      toolCount: compactTools.length,
      rawBytes,
      rawTokens,
      proxyBytes,
      proxyTokens,
      markdownTokens: estimateTokens(markdown),
      savedTokens: Math.max(0, rawTokens - proxyTokens)
    }
  };
}

function normalizeMcpPolicyMode(rawMode) {
  const m = String(rawMode || '').trim().toLowerCase();
  if (['eager', 'force-eager', 'force_eager'].includes(m)) return 'force-eager';
  if (['lazy', 'force-lazy', 'force_lazy'].includes(m)) return 'force-lazy';
  if (['smart-lazy', 'smart_lazy', 'smart'].includes(m)) return 'smart-lazy';
  if (['proxy', 'proxy-schema', 'proxy_schema'].includes(m)) return 'proxy-schema';
  throw createCodedError('INVALID_MODE', `Unsupported MCP policy mode: ${String(rawMode)}`);
}

async function applyMcpPolicy(params = {}, options = {}) {
  const mode = normalizeMcpPolicyMode(params.mode);
  const target = resolveMcpTargetPath(params, options);
  if (!fs.existsSync(target.mcpConfigPath)) {
    return { ok: false, code: 'NOT_FOUND', error: `mcp_config.json not found: ${target.mcpConfigPath}` };
  }

  const initialCfg = readJsonQuiet(target.mcpConfigPath, null);
  if (!isPlainObj(initialCfg) || !isPlainObj(initialCfg.mcpServers)) {
    return { ok: false, code: 'INVALID_CONFIG', error: `Invalid mcp_config.json: ${target.mcpConfigPath}` };
  }

  const allServers = Object.keys(initialCfg.mcpServers);
  const requestedServer = params.serverName ? String(params.serverName).trim() : null;
  const targetServers = requestedServer ? [requestedServer] : allServers;
  for (const sName of targetServers) {
    if (!isPlainObj(initialCfg.mcpServers[sName])) {
      return { ok: false, code: 'NOT_FOUND', error: `MCP server not found: ${sName}` };
    }
  }

  const probedByServer = {};
  if (params.probeTools === true) {
    for (const sName of targetServers) {
      const res = await probeMcpServerTools(initialCfg.mcpServers[sName], {
        pluginDir: target.pluginDir,
        timeoutMs: params.probeTimeoutMs
      });
      if (res.ok && res.tools.length > 0) {
        probedByServer[sName] = res.tools;
      }
    }
  }

  const tokenBudget = Number(params.tokenBudget) > 0 ? Number(params.tokenBudget) : DEFAULT_TOKEN_BUDGET;
  const lazyStyle = params.lazyStyle === 'explicit-false' || params.preserveToolKeys === true
    ? 'explicit-false'
    : 'strip-tools';

  const backup = params.skipBackup === true ? null : backupMcpConfig(target, `policy:${mode}`, options);

  return withFileLockSync(target.mcpConfigPath, () => {
    const cfg = readJsonQuiet(target.mcpConfigPath, null);
    if (!isPlainObj(cfg) || !isPlainObj(cfg.mcpServers)) {
      throw createCodedError('INVALID_CONFIG', `Invalid mcp_config.json: ${target.mcpConfigPath}`);
    }

    const serverResults = {};
    const writtenFiles = [];
    let totalRawTokens = 0;
    let totalEagerTokensAfter = 0;

    for (const sName of targetServers) {
      const srv = { ...cfg.mcpServers[sName] };
      const providedSchemas = isPlainObj(params.toolSchemasByServer)
        ? params.toolSchemasByServer[sName]
        : params.toolSchemas;
      const rawSchemas = probedByServer[sName] || providedSchemas;
      const toolList = normalizeToolSchemasInput(sName, srv, rawSchemas, params.tools, target.pluginName);

      const perToolTokens = new Map();
      let serverRawTokens = 0;
      for (const t of toolList) {
        const tok = estimateTokens(t);
        perToolTokens.set(t.name, tok);
        serverRawTokens += tok;
      }
      totalRawTokens += serverRawTokens;

      const existingTools = isPlainObj(srv.tools) ? { ...srv.tools } : {};
      let eagerAfterNames = [];
      let lazyAfterNames = [];

      if (mode === 'force-eager') {
        const nextTools = {};
        for (const t of toolList) {
          nextTools[t.name] = { ...(isPlainObj(existingTools[t.name]) ? existingTools[t.name] : {}), eager: true };
          eagerAfterNames.push(t.name);
        }
        srv.tools = nextTools;
        if (params.enableServer !== false && srv.disabled === true) {
          srv.disabled = false;
        }
      } else if (mode === 'force-lazy' || (mode === 'proxy-schema' && params.setLazy !== false)) {
        if (lazyStyle === 'explicit-false' && toolList.length > 0) {
          const nextTools = {};
          for (const t of toolList) {
            nextTools[t.name] = { ...(isPlainObj(existingTools[t.name]) ? existingTools[t.name] : {}), eager: false };
            lazyAfterNames.push(t.name);
          }
          srv.tools = nextTools;
        } else {
          delete srv.tools;
          lazyAfterNames = toolList.map((t) => t.name);
        }
      } else if (mode === 'smart-lazy') {
        const exceedsBudget = serverRawTokens > tokenBudget;
        if (params.keepEagerUnderBudget === true && toolList.length > 0 && params.force !== true) {
          const priority = new Set(Array.isArray(params.priorityTools) ? params.priorityTools : []);
          const sorted = [...toolList].sort((a, b) => {
            const pA = priority.has(a.name) ? 0 : 1;
            const pB = priority.has(b.name) ? 0 : 1;
            if (pA !== pB) return pA - pB;
            return (perToolTokens.get(a.name) || 0) - (perToolTokens.get(b.name) || 0);
          });
          let used = 0;
          const nextTools = {};
          for (const t of sorted) {
            const cost = perToolTokens.get(t.name) || 0;
            if (used + cost <= tokenBudget) {
              used += cost;
              nextTools[t.name] = { ...(isPlainObj(existingTools[t.name]) ? existingTools[t.name] : {}), eager: true };
              eagerAfterNames.push(t.name);
            } else {
              lazyAfterNames.push(t.name);
              if (lazyStyle === 'explicit-false') {
                nextTools[t.name] = { ...(isPlainObj(existingTools[t.name]) ? existingTools[t.name] : {}), eager: false };
              }
            }
          }
          if (Object.keys(nextTools).length > 0) {
            srv.tools = nextTools;
          } else {
            delete srv.tools;
          }
        } else if (exceedsBudget || params.force !== false) {
          if (lazyStyle === 'explicit-false' && toolList.length > 0) {
            const nextTools = {};
            for (const t of toolList) {
              nextTools[t.name] = { ...(isPlainObj(existingTools[t.name]) ? existingTools[t.name] : {}), eager: false };
              lazyAfterNames.push(t.name);
            }
            srv.tools = nextTools;
          } else {
            delete srv.tools;
            lazyAfterNames = toolList.map((t) => t.name);
          }
        } else {
          // Within budget and force === false: keep existing eager state
          for (const t of toolList) {
            if (isPlainObj(existingTools[t.name]) && existingTools[t.name].eager === true) {
              eagerAfterNames.push(t.name);
            } else {
              lazyAfterNames.push(t.name);
            }
          }
        }
      } else if (mode === 'proxy-schema' && params.setLazy === false) {
        for (const t of toolList) {
          if (isPlainObj(existingTools[t.name]) && existingTools[t.name].eager === true) {
            eagerAfterNames.push(t.name);
          } else {
            lazyAfterNames.push(t.name);
          }
        }
      }

      const eagerTokensAfter = eagerAfterNames.reduce((acc, n) => acc + (perToolTokens.get(n) || 0), 0);
      totalEagerTokensAfter += eagerTokensAfter;

      const shouldGenerateProxy = mode === 'proxy-schema' || mode === 'smart-lazy' || params.generateProxySchema === true;
      let proxySchema = null;
      if (shouldGenerateProxy) {
        const lazyToolSchemas = toolList.filter((t) => !eagerAfterNames.includes(t.name));
        proxySchema = buildProxySchema(sName, lazyToolSchemas.length > 0 ? lazyToolSchemas : toolList);

        const baseDir = target.pluginDir || path.dirname(target.mcpConfigPath);
        if (params.writeProxySchemaFile === true) {
          const schemaFilePath = path.join(baseDir, `proxy-schema.${assertSafeItemName(sName, 'serverName')}.json`);
          const wr = safeWriteJsonSync(schemaFilePath, proxySchema.json);
          if (!wr.ok) throw createCodedError('WRITE_FAILED', wr.error);
          writtenFiles.push(schemaFilePath);
        }
        if (params.writeProxyRule === true) {
          const rulesDir = path.join(baseDir, 'rules');
          fs.mkdirSync(rulesDir, { recursive: true });
          const ruleFilePath = path.join(rulesDir, `mcp-proxy-${assertSafeItemName(sName, 'serverName')}.md`);
          fs.writeFileSync(ruleFilePath, proxySchema.markdown, 'utf8');
          writtenFiles.push(ruleFilePath);
        }
      }

      cfg.mcpServers[sName] = srv;
      serverResults[sName] = {
        serverName: sName,
        summary: buildMcpServerSummary(sName, srv, target),
        eagerToolsAfter: eagerAfterNames,
        lazyToolsAfter: lazyAfterNames,
        rawTokens: serverRawTokens,
        eagerTokensAfter,
        proxySchema
      };
    }

    const wr = writeJsonPreservingMode(target.mcpConfigPath, cfg);
    if (!wr.ok) throw createCodedError('WRITE_FAILED', wr.error);

    return {
      ok: true,
      mode,
      lazyStyle,
      scope: target.scope,
      pluginName: target.pluginName,
      mcpConfigPath: target.mcpConfigPath,
      serverNames: targetServers,
      backup,
      tokenAnalysis: {
        tokenBudget,
        rawTokens: totalRawTokens,
        eagerTokensAfter: totalEagerTokensAfter,
        exceedsBudgetBefore: totalRawTokens > tokenBudget,
        exceedsBudgetAfter: totalEagerTokensAfter > tokenBudget
      },
      writtenFiles,
      servers: serverResults,
      updatedAt: new Date().toISOString()
    };
  });
}

module.exports = {
  CUSTOMIZATION_TYPES,
  CUSTOMIZATION_SCOPES,
  DEFAULT_TOKEN_BUDGET,
  KNOWN_MCP_PLUGIN_TOOLS,
  assertSafeItemName,
  assertInsideRoot,
  resolveGeminiConfigDir,
  fileUriToPath,
  extractTrajectoryWorkspacePaths,
  detectActiveWorkspaceRoot,
  resolveScopePaths,
  estimateTokens,
  parseFrontmatter,
  scanCustomizations,
  setCustomizationEnabled,
  installCustomization,
  uninstallCustomization,
  migrateCustomizationToWorkspace,
  listMcpConfigBackups,
  rollbackMcpConfig,
  probeMcpServerTools,
  buildProxySchema,
  applyMcpPolicy
};
