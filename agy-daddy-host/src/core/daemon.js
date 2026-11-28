'use strict';

const fs = require('fs');
const path = require('path');
const { fork, spawn } = require('child_process');
const { EventEmitter } = require('events');
const { getStateDir, getPluginsDir, assertSafePluginId, getHostSettingsPath, isTestMode } = require('./paths');
const { PluginDataStore, safeReadJsonSync, safeWriteJsonSync, withFileLockSync } = require('./storage');
const { FourRealmBus } = require('./bus');
const { DynamicBridgeServer } = require('./bridge');
const { createRpcTransport, createScopedRpcClient } = require('./rpc');
const { loadAnchorsRegistry } = require('./anchors');
const { CdpInjector, DEFAULT_HOST_BUNDLE_PATH } = require('./injector');
const {
  getInstalledIndexPath,
  readInstalledIndex,
  readManifestFromDir,
  sortPluginsByDependency,
  installPlugin,
  enablePlugin,
  disablePlugin,
  uninstallPlugin,
  rollbackPlugin,
  inspectPluginInstallHealth,
  repairPluginInstall,
  updatePluginNativeConfig,
  rollbackPluginNativeRules,
  inspectPluginNativeStatus,
  listInstalledPlugins,
  loadRegistry
} = require('./installer');
const {
  evaluateTrustPolicy,
  validateSettingsSchema,
  validateSettingsValues,
  redactWriteOnlySettings
} = require('../contracts/manifest-validator');
const { createScopedNetFetch } = require('./plugin-worker');
const { runDoctor, exportDiagnosticBundle, sanitizeHostHealth } = require('./doctor');
const { inspectAntigravityHostProcess } = require('./cdp');
const {
  isolateResidentEnv,
  findAntigravityApp,
  planAntigravityRestart,
  relaunchAntigravityWithCdp
} = require('./lifecycle');
const {
  DirectProxyFallbackServer,
  parseProxyPortFromCommand,
  hasProxyServerArg
} = require('./proxy-fallback');
const { HostHealth } = require('./health-snapshot');
const { MarketplaceStatsService } = require('./marketplace-stats');
const { TrayManager } = require('./tray-manager');
const { OverlayManager } = require('./overlay-manager');
const {
  detectActiveWorkspaceRoot,
  scanCustomizations,
  setCustomizationEnabled,
  installCustomization,
  uninstallCustomization,
  migrateCustomizationToWorkspace,
  applyMcpPolicy,
  rollbackMcpConfig
} = require('./customizations');
const { createWorkspaceOrgRuntime } = require('./workspace-org');

const HOST_ROOT = path.resolve(__dirname, '..', '..');
const WORKER_SCRIPT = path.resolve(__dirname, 'plugin-worker.js');

const HOST_CONTROL_ROUTE_ALLOWLIST = Object.freeze([
  '/host/health',
  '/host/plugins',
  '/host/plugins/toggle',
  '/host/plugins/activate',
  '/host/plugins/repair',
  '/host/plugins/install',
  '/host/plugins/uninstall',
  '/host/plugins/rollback',
  '/host/antigravity/relaunch',
  '/host/reload',
  '/host/reload-all',
  '/host/anchors',
  '/host/bus/call',
  '/host/settings',
  '/host/settings/open',
  '/host/host-settings',
  '/host/commands/run',
  '/host/marketplace/stats',
  '/host/diagnostics/export',
  '/host/tray/menu',
  '/host/tray/invoke',
  '/host/customizations',
  '/host/customizations/toggle',
  '/host/customizations/install',
  '/host/customizations/uninstall',
  '/host/customizations/migrate',
  '/host/customizations/mcp/policy',
  '/host/customizations/mcp/rollback'
]);

const PERMANENT_ACTIVATION_ERROR_CODES = new Set([
  'PERMISSION_DENIED',
  'MANIFEST_INVALID',
  'INSTALL_PATH_MISSING',
  'CIRCUIT_OPEN'
]);

function classifyPluginError(err, stage = 'activate') {
  const message = String(err?.message || err || '未知错误');
  const rawCode = typeof err?.code === 'string' ? err.code : '';
  let code = rawCode || 'ACTIVATE_FAILED';
  let suggestion = '请根据下方错误详情排查配置或依赖后，点击「立即激活」重试。';

  if (rawCode === 'INSTALL_PATH_MISSING' || /INSTALL_PATH_MISSING|installPath.*missing|ENOENT.*(?:agy-plugin\.json|src)/i.test(message)) {
    code = 'INSTALL_PATH_MISSING';
    suggestion = '该插件安装目录或软链目标已不存在（常见于删除 worktree 或移动本地目录）。可在列表或下方诊断区一键修复路径、重新指定目录，或移除该失效记录。';
  } else if (rawCode === 'MANIFEST_INVALID' || /agy-plugin\.json|Invalid manifest/i.test(message)) {
    code = 'MANIFEST_INVALID';
    suggestion = '请检查插件根目录下的 agy-plugin.json 声明是否有效。';
  } else if (rawCode === 'PERMISSION_DENIED' || /Permission denied/i.test(message)) {
    code = 'PERMISSION_DENIED';
    suggestion = '该插件缺少必要权限授权，请重新安装并确认授权或检查信任等级。';
  } else if (rawCode === 'CIRCUIT_OPEN' || /CIRCUIT_OPEN/.test(message)) {
    code = 'CIRCUIT_OPEN';
    suggestion = '插件短时间内多次失败已触发熔断保护，请点击「解除熔断并激活」重试。';
  } else if (rawCode === 'EADDRINUSE' || /EADDRINUSE|GATEWAY_PORT_OCCUPIED|port.*in use/i.test(message)) {
    code = 'PORT_IN_USE';
    suggestion = '插件监听端口已被占用，请在下方配置中修改端口或结束占用进程后重试激活。';
  } else if (/Worker init timeout|Worker exited|Worker crashed/i.test(message)) {
    code = /timeout/i.test(message) ? 'WORKER_TIMEOUT' : 'WORKER_CRASHED';
    suggestion = '插件独立进程启动超时或异常退出，请查看错误详情后尝试重新激活。';
  } else if (stage === 'renderer') {
    code = 'RENDERER_INJECT_FAILED';
    suggestion = '插件后端已运行但页面渲染层注入失败，请点击「重新激活」或「重新载入」重试。';
  }

  return {
    code,
    stage,
    message,
    stack: typeof err?.stack === 'string' ? err.stack : null,
    suggestion,
    at: Date.now()
  };
}

function createScopedHostControl(pluginId, permissions, invokeFn) {
  const perms = Array.isArray(permissions) ? permissions : [];
  if (!perms.includes('host:control')) return undefined;
  return {
    async invoke(routePath, body = {}) {
      const raw = String(routePath || '').trim();
      const normalized = raw.startsWith('/') ? raw : `/${raw}`;
      if (!HOST_CONTROL_ROUTE_ALLOWLIST.includes(normalized)) {
        const err = new Error(`HOST_CONTROL_ROUTE_BLOCKED: ${pluginId} cannot invoke ${normalized}`);
        err.code = 'HOST_CONTROL_ROUTE_BLOCKED';
        throw err;
      }
      return await invokeFn(normalized, body);
    }
  };
}

const DEFAULT_HOST_SETTINGS = Object.freeze({
  themeMode: 'auto',
  heatPreset: 'purple',
  customColors: {},
  topbarPins: {},
  topbarOrder: [],
  maxVisibleUnits: 6,
  showTopbarEntry: true,
  injectNativeSettings: true,
  autoSyncNativeOnInstall: true,
  hideTrayIcon: false
});

const VALID_THEME_MODES = new Set(['auto', 'light', 'dark']);

function isPlainObj(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function tryRebuildHostRenderer(hostBundlePath) {
  const targetBundle = path.resolve(hostBundlePath || DEFAULT_HOST_BUNDLE_PATH);
  const defaultBundle = path.resolve(DEFAULT_HOST_BUNDLE_PATH);
  if (targetBundle !== defaultBundle) {
    return { attempted: false, rebuilt: false };
  }
  const buildScriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'build-renderer.js');
  const runtimeSrcPath = path.resolve(__dirname, '..', 'renderer', 'host-runtime.js');
  if (!fs.existsSync(buildScriptPath) || !fs.existsSync(runtimeSrcPath)) {
    return { attempted: false, rebuilt: false };
  }
  try {
    const resolved = require.resolve(buildScriptPath);
    delete require.cache[resolved];
  } catch {}
  const { buildHostRenderer } = require(buildScriptPath);
  const res = buildHostRenderer();
  return { attempted: true, rebuilt: true, outFile: res.outFile, bytes: res.bytes };
}

function normalizeHostSettings(patch = {}, base = DEFAULT_HOST_SETTINGS) {
  const srcBase = isPlainObj(base) ? base : DEFAULT_HOST_SETTINGS;
  const srcPatch = isPlainObj(patch) ? patch : {};

  const rawTheme = srcPatch.themeMode !== undefined ? srcPatch.themeMode : srcBase.themeMode;
  const themeMode = VALID_THEME_MODES.has(rawTheme) ? rawTheme : DEFAULT_HOST_SETTINGS.themeMode;

  const rawPreset = srcPatch.heatPreset !== undefined ? srcPatch.heatPreset : srcBase.heatPreset;
  const heatPreset = typeof rawPreset === 'string' && rawPreset.trim()
    ? rawPreset.trim()
    : DEFAULT_HOST_SETTINGS.heatPreset;

  let customColors = isPlainObj(srcBase.customColors) ? { ...srcBase.customColors } : {};
  if (srcPatch.customColors !== undefined) {
    if (isPlainObj(srcPatch.customColors)) {
      const keys = Object.keys(srcPatch.customColors);
      if (keys.length === 0) {
        customColors = {};
      } else {
        for (const k of keys) {
          const v = srcPatch.customColors[k];
          if (v === null || v === undefined || v === '') {
            delete customColors[k];
          } else if (typeof v === 'string') {
            customColors[k] = v;
          }
        }
      }
    }
  }

  const topbarPins = isPlainObj(srcBase.topbarPins) ? { ...srcBase.topbarPins } : {};
  if (isPlainObj(srcPatch.topbarPins)) {
    for (const [k, v] of Object.entries(srcPatch.topbarPins)) {
      if (v === null || v === undefined) {
        delete topbarPins[k];
      } else {
        topbarPins[k] = Boolean(v);
      }
    }
  }

  const rawOrder = Array.isArray(srcPatch.topbarOrder)
    ? srcPatch.topbarOrder
    : (Array.isArray(srcBase.topbarOrder) ? srcBase.topbarOrder : []);
  const topbarOrder = Array.from(new Set(rawOrder.filter((x) => typeof x === 'string' && x.trim())));

  const rawMax = srcPatch.maxVisibleUnits !== undefined ? srcPatch.maxVisibleUnits : srcBase.maxVisibleUnits;
  const parsedMax = Number(rawMax);
  const maxVisibleUnits = Number.isFinite(parsedMax) && parsedMax >= 1
    ? Math.min(32, Math.floor(parsedMax))
    : DEFAULT_HOST_SETTINGS.maxVisibleUnits;

  const showTopbarEntry = srcPatch.showTopbarEntry !== undefined
    ? Boolean(srcPatch.showTopbarEntry)
    : (srcBase.showTopbarEntry !== undefined ? Boolean(srcBase.showTopbarEntry) : DEFAULT_HOST_SETTINGS.showTopbarEntry);

  const injectNativeSettings = srcPatch.injectNativeSettings !== undefined
    ? Boolean(srcPatch.injectNativeSettings)
    : (srcBase.injectNativeSettings !== undefined ? Boolean(srcBase.injectNativeSettings) : DEFAULT_HOST_SETTINGS.injectNativeSettings);

  const autoSyncNativeOnInstall = srcPatch.autoSyncNativeOnInstall !== undefined
    ? Boolean(srcPatch.autoSyncNativeOnInstall)
    : (srcBase.autoSyncNativeOnInstall !== undefined ? Boolean(srcBase.autoSyncNativeOnInstall) : DEFAULT_HOST_SETTINGS.autoSyncNativeOnInstall);

  const hideTrayIcon = srcPatch.hideTrayIcon !== undefined
    ? Boolean(srcPatch.hideTrayIcon)
    : (srcBase.hideTrayIcon !== undefined ? Boolean(srcBase.hideTrayIcon) : DEFAULT_HOST_SETTINGS.hideTrayIcon);

  return {
    themeMode,
    heatPreset,
    customColors,
    topbarPins,
    topbarOrder,
    maxVisibleUnits,
    showTopbarEntry,
    injectNativeSettings,
    autoSyncNativeOnInstall,
    hideTrayIcon
  };
}

function computeChangedKeys(prevObj, nextObj) {
  const prev = isPlainObj(prevObj) ? prevObj : {};
  const next = isPlainObj(nextObj) ? nextObj : {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  const changed = [];
  for (const k of keys) {
    if (JSON.stringify(prev[k]) !== JSON.stringify(next[k])) {
      changed.push(k);
    }
  }
  return changed;
}

function resolvePluginSettingsWithDefaults(schema, rawValues = {}) {
  const raw = isPlainObj(rawValues) ? rawValues : {};
  if (!schema || !Array.isArray(schema.fields)) {
    return { ...raw };
  }
  const direct = validateSettingsValues(schema, raw);
  if (direct.ok) {
    return { ...direct.values };
  }
  // 容错：磁盘存在个别脏字段时逐字段回退到 schema 默认值
  const fallback = {};
  for (const field of schema.fields) {
    const single = validateSettingsValues({ fields: [field] }, { [field.key]: raw[field.key] });
    if (single.ok && field.key in single.values) {
      fallback[field.key] = single.values[field.key];
    } else if (field.default !== undefined) {
      fallback[field.key] = field.default;
    }
  }
  return fallback;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireDaemonLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      const payload = { pid: process.pid, startedAt: Date.now() };
      fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      fs.closeSync(fd);
      return payload;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const existing = safeReadJsonSync(lockPath, null, { quarantineCorrupt: false }).data;
      if (existing?.pid && isPidAlive(Number(existing.pid))) {
        const dupErr = new Error(`DAEMON_ALREADY_RUNNING: agy-daddyd is already running (PID ${existing.pid})`);
        dupErr.code = 'DAEMON_ALREADY_RUNNING';
        dupErr.existingPid = existing.pid;
        throw dupErr;
      }
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
  throw new Error(`Failed to acquire daemon lock at ${lockPath}`);
}

function releaseDaemonLock(lockPath, pid = process.pid) {
  try {
    if (!fs.existsSync(lockPath)) return;
    const disk = safeReadJsonSync(lockPath, null, { quarantineCorrupt: false }).data;
    if (!disk || Number(disk.pid) === pid) {
      fs.unlinkSync(lockPath);
    }
  } catch {}
}

class AgyDaddyDaemon extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.stateDir = getStateDir(options);
    this.lockPath = path.join(this.stateDir, 'daemon.lock');
    this.bus = options.bus || new FourRealmBus({ timeoutMs: options.busTimeoutMs || 5000 });
    this.bridge = options.bridge || new DynamicBridgeServer({ origin: options.origin || '*' });
    this.rpcTransport = options.rpcTransport || createRpcTransport(options);
    this.marketplaceStats = options.marketplaceStats || new MarketplaceStatsService({
      stateDir: this.stateDir,
      fetch: options.statsFetch || options.fetch,
      ttlMs: options.marketStatsTtlMs,
      timeoutMs: options.marketStatsTimeoutMs,
      githubToken: options.githubToken,
      allowNetworkInTest: options.allowNetworkInTest
    });
    this.injector = options.injector || new CdpInjector({
      bridgePort: () => this.bridge.port,
      hostToken: () => this.bridge.hostToken,
      stateDir: this.stateDir,
      anchorsPath: this.options.anchorsPath,
      antigravityVersion: this.options.antigravityVersion || '2.33.0',
      bus: this.bus,
      WebSocket: options.WebSocket,
      cdpOptions: options.cdpOptions,
      hostBundlePath: options.hostBundlePath,
      reinjectDebounceMs: options.reinjectDebounceMs,
      getHostSettings: () => this.getHostSettings(),
      getPluginMetaMap: () => this.buildPluginMetaMap(),
      getPluginSettings: (pluginId) => this.getPluginSettings(pluginId),
      onPluginInjectError: (pluginId, err) => this.recordPluginDiagnostic(pluginId, err, 'renderer'),
      onPluginInjectSuccess: (pluginId) => {
        if (this.pluginErrors.get(pluginId)?.stage === 'renderer') {
          this.pluginErrors.delete(pluginId);
        }
      }
    });
    this.activePlugins = new Map(); // pluginId -> record
    this.commands = new Map();      // commandId -> { pluginId, commandId, handler }
    this.settingsListeners = new Map(); // pluginId -> Set<fn>
    this.crashTracker = new Map();  // pluginId -> number[] timestamps
    this.pluginErrors = new Map();  // pluginId -> { code, stage, message, suggestion, at }
    this.health = new HostHealth({
      ...options,
      stateDir: this.stateDir,
      getBridgePort: () => this.bridge.port,
      getSession: (id) => this.injector.sessions?.get(id),
      getPlugins: () => this.getHostHealthPlugins(),
      emit: (event, data) => this.emit(event, data),
      onHistoryError: (result) => this.emit('host-health:persistence-error', result)
    });
    this.injector.on?.('reinjectionFailed', (error) => this.health.recordInjection(error));
    this.injector.on?.('reinjected', ({ targetId }) => this.health.recordInjection({ targetId }));
    this._liveWorkers = new Set();  // tracks all forked plugin workers including in-flight init
    this._activatingInactivePromise = null;
    this.sessionProxyFallback = null; // { server, pluginId, port, reason, since }
    this.pendingHostRestart = null;   // { required: true, reason, pluginId, displayName, action, message, since }
    this.lastHostLaunchUsedProxy = false;
    this.lastHostLaunchProxyPort = null;
    this.crashWindowMs = Number(options.crashWindowMs) > 0 ? Number(options.crashWindowMs) : 60000;
    this.maxCrashes = Number(options.maxCrashes) > 0 ? Number(options.maxCrashes) : 3;
    this.trayManager = options.trayManager || new TrayManager({
      bus: this.bus,
      stateDir: this.stateDir,
      appName: 'Agy-Daddy Launcher',
      recordFailure: (pluginId, err) => this.recordPluginFailure(pluginId, err),
      executeCommand: (cmdId, args, opts) => this.executeCommand(cmdId, args, opts),
      ...(options.trayOptions || {})
    });
    if (typeof this.trayManager.setActionHandlers === 'function') {
      this.trayManager.setActionHandlers({
        executeCommand: (cmdId, args, opts) => this.executeCommand(cmdId, args, opts)
      });
    }
    this.overlayManager = options.overlayManager || new OverlayManager({
      bus: this.bus,
      stateDir: this.stateDir,
      ...(options.overlayOptions || {})
    });
    this.running = false;
    this.lockAcquired = false;
    this.workspaceOrg = options.workspaceOrg || createWorkspaceOrgRuntime();
  }

  getHostHealthPlugins() {
    const installed = this.options.plugins || Object.values(safeReadJsonSync(
      getInstalledIndexPath(this.options), null, { quarantineCorrupt: false }
    ).data?.plugins || {});
    const records = new Map(installed
      .filter((p) => p?.id).map((p) => [p.id, p]));
    for (const [id, plugin] of this.activePlugins) {
      if (!records.has(id)) records.set(id, plugin.record);
    }
    return Array.from(records, ([id, record]) => {
      const active = this.activePlugins.get(id);
      const diagnostic = this.pluginErrors.get(id);
      let manifest = active?.manifest;
      if (!manifest && record?.installPath) {
        try { manifest = readManifestFromDir(record.installPath); } catch {}
      }
      const enabled = record?.enabled !== false;
      let nodeState = 'disabled';
      if (enabled) {
        if (manifest && !manifest.main) nodeState = 'not_applicable';
        else if (active) nodeState = 'active';
        else nodeState = diagnostic ? 'error' : 'inactive';
      }
      return {
        id,
        name: this.pickLocaleText(manifest?.displayName, id),
        enabled,
        manifest,
        nodeState,
        lastError: diagnostic?.message || active?.lastError || null,
        lastErrorStack: diagnostic?.stack || null,
        lastErrorAt: diagnostic?.at || null
      };
    });
  }

  getHostHealth() {
    const snap = this.health.snapshot();
    if (this.trayManager && this.trayManager.managed && typeof this.trayManager.applyHostHealth === 'function') {
      void this.trayManager.applyHostHealth(snap).catch(() => {});
    }
    return snap;
  }

  getDiagnosticHealth() {
    const extraSecrets = [
      this.bridge.hostToken,
      ...(this.bridge.pluginTokens?.values() || []),
      ...(this.options.extraSecrets || [])
    ];
    return sanitizeHostHealth(this.getHostHealth(), {
      ...this.options,
      extraSecrets
    });
  }

  async openPluginSettings(opts = {}) {
    const targetOpts = {
      tab: typeof opts?.tab === 'string' && opts.tab.trim() ? opts.tab.trim() : 'plugins',
      ...(typeof opts?.pluginId === 'string' && opts.pluginId.trim() ? { pluginId: opts.pluginId.trim() } : {})
    };
    if (this.injector && typeof this.injector.openSettingsPanel === 'function') {
      const res = await this.injector.openSettingsPanel(targetOpts).catch(() => ({ ok: false, openedCount: 0 }));
      if ((res?.openedCount || 0) > 0) {
        return { ok: true, via: 'cdp', openedCount: res.openedCount };
      }
    }
    const webCfgPath = path.join(this.stateDir, 'plugins-data', 'agy-daddy.web', 'web-config.json');
    const webCfg = safeReadJsonSync(webCfgPath, null, { quarantineCorrupt: false }).data;
    if (webCfg && Number.isInteger(webCfg.port) && webCfg.token) {
      const url = `http://127.0.0.1:${webCfg.port}/?token=${webCfg.token}#plugins`;
      return { ok: true, via: 'web-url', openedCount: 0, url };
    }
    return { ok: false, via: 'none', openedCount: 0, reason: 'NO_ACTIVE_TARGET' };
  }

  getHostSettings() {
    const filePath = getHostSettingsPath({ stateDir: this.stateDir });
    const res = safeReadJsonSync(filePath, null, { quarantineCorrupt: true });
    return normalizeHostSettings(res.data || {}, DEFAULT_HOST_SETTINGS);
  }

  async syncTrayVisibility(hostSettings = null) {
    const hs = hostSettings || this.getHostSettings();
    let res = { ok: true, skipped: true };
    if (this.trayManager && this.trayManager.managed && typeof this.trayManager.setVisible === 'function') {
      res = await this.trayManager.setVisible(hs.hideTrayIcon !== true);
    }
    if (typeof this.options.onHostSettingsChange === 'function') {
      try {
        this.options.onHostSettingsChange(hs);
      } catch {}
    }
    return res;
  }

  saveHostSettings(patch = {}, opts = {}) {
    const filePath = getHostSettingsPath({ stateDir: this.stateDir });
    const current = this.getHostSettings();
    const next = normalizeHostSettings(patch, current);
    const wr = withFileLockSync(filePath, () => safeWriteJsonSync(filePath, next));
    if (!wr.ok) {
      return { ok: false, error: wr.error || 'Failed to save host settings', values: current };
    }
    if (!opts.skipTraySync) {
      void this.syncTrayVisibility(next).catch(() => {});
    }
    return { ok: true, values: next };
  }

  loadPluginSettingsSchema(pluginId, manifestOverride = null, installPathOverride = null) {
    const active = this.activePlugins.get(pluginId);
    let installPath = installPathOverride || active?.record?.installPath || null;
    if (!installPath) {
      const idxRec = readInstalledIndex(this.options).plugins?.[pluginId];
      installPath = idxRec?.installPath || null;
    }
    let manifest = manifestOverride || active?.manifest || null;
    if (!manifest && installPath && fs.existsSync(installPath)) {
      try { manifest = readManifestFromDir(installPath); } catch {}
    }
    const schemaRel = manifest?.contributes?.settings?.schema;
    if (!schemaRel || !installPath) return null;
    const rootAbs = path.resolve(installPath);
    const schemaPath = path.resolve(rootAbs, schemaRel);
    const rootPrefix = rootAbs.endsWith(path.sep) ? rootAbs : `${rootAbs}${path.sep}`;
    if (schemaPath !== rootAbs && !schemaPath.startsWith(rootPrefix)) return null;
    if (!fs.existsSync(schemaPath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
      const check = validateSettingsSchema(parsed);
      return check.ok ? parsed : null;
    } catch {
      return null;
    }
  }

  getPluginSettings(pluginId, opts = {}) {
    const safeId = assertSafePluginId(pluginId);
    const store = new PluginDataStore(safeId, this.options);
    const raw = store.readJson('settings.json', {}).data || {};
    const schema = opts.schema !== undefined
      ? opts.schema
      : this.loadPluginSettingsSchema(safeId, opts.manifest || null, opts.installPath || null);
    return resolvePluginSettingsWithDefaults(schema, raw);
  }

  onPluginSettingsChange(pluginId, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!this.settingsListeners.has(pluginId)) {
      this.settingsListeners.set(pluginId, new Set());
    }
    const set = this.settingsListeners.get(pluginId);
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.settingsListeners.delete(pluginId);
    };
  }

  async notifyPluginSettingsChange(pluginId, values, changedKeys = [], opts = {}) {
    const safeValues = isPlainObj(values) ? { ...values } : {};
    const keys = Array.isArray(changedKeys) ? [...changedKeys] : [];
    const set = this.settingsListeners.get(pluginId);
    if (set) {
      for (const fn of Array.from(set)) {
        try { fn({ ...safeValues }, [...keys]); } catch {}
      }
    }
    const active = this.activePlugins.get(pluginId);
    const worker = active?.workerHandle?.worker;
    if (worker && worker.connected && !opts.skipWorkerNotify) {
      try {
        worker.send({ type: 'settings-changed', values: safeValues, changedKeys: keys });
      } catch {}
    }
    let rendererNotified = 0;
    if (!opts.skipRendererBroadcast && this.injector && typeof this.injector.notifyPluginSettingsChanged === 'function') {
      try {
        const schema = opts.schema !== undefined ? opts.schema : this.loadPluginSettingsSchema(pluginId);
        const redacted = redactWriteOnlySettings(schema, safeValues);
        const res = await this.injector.notifyPluginSettingsChanged(pluginId, redacted.values, keys, redacted.secretState);
        rendererNotified = Number(res?.notified) || 0;
      } catch {}
    }
    return { rendererNotified };
  }

  async updatePluginSettings(pluginId, patch = {}, opts = {}) {
    const safeId = assertSafePluginId(pluginId);
    const store = new PluginDataStore(safeId, this.options);
    const schema = opts.schema !== undefined
      ? opts.schema
      : this.loadPluginSettingsSchema(safeId, opts.manifest || null, opts.installPath || null);
    const prevValues = this.getPluginSettings(safeId, { ...opts, schema });
    const candidate = { ...prevValues, ...(isPlainObj(patch) ? patch : {}) };

    let nextValues = candidate;
    if (schema) {
      const checked = validateSettingsValues(schema, candidate);
      if (!checked.ok) {
        return { ok: false, errors: checked.errors };
      }
      nextValues = checked.values;
    }

    const changedKeys = computeChangedKeys(prevValues, nextValues);
    const wr = store.writeJson('settings.json', nextValues);
    if (!wr.ok) {
      return { ok: false, errors: [wr.error || 'Failed to write plugin settings'] };
    }
    const notifyRes = await this.notifyPluginSettingsChange(safeId, nextValues, changedKeys, { ...opts, schema });
    return {
      ok: true,
      values: nextValues,
      changedKeys,
      rendererNotified: Number(notifyRes?.rendererNotified) || 0
    };
  }

  registerCommand(pluginId, commandId, handler) {
    const cleanId = String(commandId || '').trim();
    if (!cleanId) throw new Error('commandId must be a non-empty string');
    if (typeof handler !== 'function') throw new Error(`Command handler for ${cleanId} must be a function`);
    const record = { pluginId, commandId: cleanId, handler };
    this.commands.set(cleanId, record);
    return () => {
      if (this.commands.get(cleanId) === record) {
        this.commands.delete(cleanId);
      }
    };
  }

  unregisterPluginCommands(pluginId) {
    let removed = 0;
    for (const [cmdId, rec] of Array.from(this.commands.entries())) {
      if (rec.pluginId === pluginId) {
        this.commands.delete(cmdId);
        removed++;
      }
    }
    return removed;
  }

  async executeCommand(commandId, args = [], opts = {}) {
    const cleanId = String(commandId || '').trim();
    if (!cleanId) throw new Error('commandId is required');
    let rec = opts.pluginId ? this.commands.get(`${opts.pluginId}:${cleanId}`) : null;
    if (!rec) rec = this.commands.get(cleanId);
    if (!rec) {
      const err = new Error(`COMMAND_NOT_FOUND: ${cleanId}`);
      err.code = 'COMMAND_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }
    const result = await rec.handler(...(Array.isArray(args) ? args : []));
    return result === undefined ? null : result;
  }

  recordPluginDiagnostic(pluginId, err, stage = 'activate') {
    const diag = classifyPluginError(err, stage);
    this.pluginErrors.set(pluginId, diag);
    return diag;
  }

  clearPluginDiagnostic(pluginId) {
    this.pluginErrors.delete(pluginId);
  }

  recordPluginFailure(pluginId, err, stage = 'activate') {
    this.recordPluginDiagnostic(pluginId, err, stage);
    const now = Date.now();
    const list = (this.crashTracker.get(pluginId) || []).filter((ts) => now - ts <= this.crashWindowMs);
    list.push(now);
    this.crashTracker.set(pluginId, list);
    const circuitOpen = list.length >= this.maxCrashes;
    if (circuitOpen) {
      this.bus.emitEvent('agy-daddy.host', 'host:plugin-circuit-opened@1', {
        pluginId,
        crashes: list.length,
        windowMs: this.crashWindowMs,
        lastError: err?.message || String(err)
      });
    }
    return { crashes: list.length, circuitOpen };
  }

  resetPluginCircuit(pluginId) {
    const hadRecords = this.crashTracker.has(pluginId);
    this.crashTracker.delete(pluginId);
    this.pluginErrors.delete(pluginId);
    const active = this.activePlugins.get(pluginId);
    if (active && 'lastError' in active) {
      active.lastError = null;
    }
    return { ok: true, pluginId, hadRecords };
  }

  getPluginHealth(pluginId) {
    const now = Date.now();
    const list = (this.crashTracker.get(pluginId) || []).filter((ts) => now - ts <= this.crashWindowMs);
    const active = this.activePlugins.get(pluginId);
    const diag = this.pluginErrors.get(pluginId) || null;
    return {
      active: Boolean(active),
      crashesInWindow: list.length,
      circuitOpen: list.length >= this.maxCrashes,
      nodeIsolation: active?.trustPolicy?.nodeIsolation || null,
      lastError: diag?.message || active?.lastError || null,
      lastErrorCode: diag?.code || null,
      lastErrorStage: diag?.stage || null,
      lastErrorSuggestion: diag?.suggestion || null,
      lastErrorAt: diag?.at || null
    };
  }

  updateLiveSessionFile() {
    try {
      const livePath = path.join(this.stateDir, '.live-session.json');
      if (fs.existsSync(livePath)) {
        const cur = safeReadJsonSync(livePath, null, { quarantineCorrupt: false }).data;
        if (cur && Number(cur.pid) === process.pid) {
          safeWriteJsonSync(livePath, {
            ...cur,
            activePlugins: Array.from(this.activePlugins.keys())
          });
        }
      }
    } catch {}
  }

  async syncPluginMetaToSessions() {
    if (this.injector && typeof this.injector.syncPluginMeta === 'function') {
      return await this.injector.syncPluginMeta(this.buildPluginMetaMap()).catch(() => ({ ok: false, notified: 0 }));
    }
    return { ok: false, notified: 0 };
  }

  buildInProcessHostApi(pluginId, manifest, trustPolicy, record = null) {
    if (!process.env.AGY_DADDY_HOST_DIR) {
      process.env.AGY_DADDY_HOST_DIR = HOST_ROOT;
    }
    const store = new PluginDataStore(pluginId, this.options);
    const perms = trustPolicy.granted || [];
    const daemon = this;
    const rpcClient = createScopedRpcClient(pluginId, perms, this.rpcTransport);
    const installPath = record?.installPath || null;

    return {
      pluginId,
      manifest,
      permissions: [...perms],
      storage: store,
      workspaceOrg: daemon.workspaceOrg,
      bridge: {
        registerRoute(subPath, handler) {
          if (!perms.includes('bridge:route')) {
            throw new Error(`BRIDGE_PERMISSION_DENIED: ${pluginId} lacks bridge:route`);
          }
          return daemon.bridge.registerPluginRoute(pluginId, subPath, handler);
        }
      },
      rpc: rpcClient,
      services: {
        provide: (name, methods, opts = {}) => daemon.bus.provideService(pluginId, name, methods, opts),
        call: (name, method, args = [], opts = {}) => daemon.bus.callService(name, method, args, { ...opts, callerRealm: 'node' }),
        get: (name, opts = {}) => daemon.bus.getServiceProxy(name, { ...opts, callerRealm: 'node' }),
        has: (name) => daemon.bus.hasService(name)
      },
      events: {
        emit: (topic, payload) => daemon.bus.emitEvent(pluginId, topic, payload),
        on: (topic, fn) => daemon.bus.onEvent(pluginId, topic, fn),
        onAny: (fn) => daemon.bus.onAny(pluginId, fn)
      },
      state: {
        set: (key, value) => daemon.bus.setState(pluginId, key, value),
        get: (key) => daemon.bus.getState(key),
        subscribe: (key, fn) => daemon.bus.subscribeState(pluginId, key, fn)
      },
      hooks: {
        register(hookName, fn) {
          if ((hookName === 'hostLaunchArgs' || hookName === 'hostLaunchEnv') && !perms.includes('host:launch-args')) {
            throw new Error(`HOOK_PERMISSION_DENIED: ${pluginId} requires host:launch-args`);
          }
          return daemon.bus.registerHook(pluginId, hookName, fn);
        }
      },
      net: {
        fetch: createScopedNetFetch(pluginId, perms, daemon.bus, daemon.options.fetch)
      },
      control: createScopedHostControl(
        pluginId,
        perms,
        (normalized, body) => daemon.bridge.invokeHostRoute(normalized, body, { pluginId, via: 'host.control' })
      ),
      settings: {
        get() {
          return daemon.getPluginSettings(pluginId, { manifest, installPath });
        },
        async update(patch) {
          const res = await daemon.updatePluginSettings(pluginId, patch, { manifest, installPath });
          if (!res.ok) throw new Error((res.errors || []).join('; ') || 'Invalid settings');
          return res;
        },
        save(values, schema = null) {
          const effectiveSchema = schema || daemon.loadPluginSettingsSchema(pluginId, manifest, installPath);
          const prev = daemon.getPluginSettings(pluginId, { manifest, installPath, schema: effectiveSchema });
          const candidate = { ...prev, ...(isPlainObj(values) ? values : {}) };
          let toSave = candidate;
          if (effectiveSchema) {
            const res = validateSettingsValues(effectiveSchema, candidate);
            if (!res.ok) throw new Error(res.errors.join('; '));
            toSave = res.values;
          }
          const changedKeys = computeChangedKeys(prev, toSave);
          const writeRes = store.writeJson('settings.json', toSave);
          if (writeRes.ok) {
            void daemon.notifyPluginSettingsChange(pluginId, toSave, changedKeys);
          }
          return writeRes;
        },
        onChange(fn) {
          return daemon.onPluginSettingsChange(pluginId, fn);
        }
      },
      commands: {
        register(commandId, handler) {
          return daemon.registerCommand(pluginId, commandId, handler);
        },
        execute(commandId, args = []) {
          return daemon.executeCommand(commandId, args);
        }
      },
      tray: daemon.trayManager.createScopedApi(pluginId, {
        pluginDir: installPath,
        recordFailure: (id, err) => daemon.recordPluginFailure(id, err),
        executeCommand: (cmdId, args, opts) => daemon.executeCommand(cmdId, args, opts)
      }),
      overlay: daemon.overlayManager.createScopedApi(pluginId, {
        pluginDir: installPath,
        permissions: perms
      })
    };
  }

  async spawnWorkerPlugin(pluginId, pluginDir, manifest, trustPolicy, bridgeTokenOverride = null) {
    const bridgeToken = bridgeTokenOverride || this.bridge.issuePluginToken(pluginId);
    const worker = fork(WORKER_SCRIPT, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, AGY_DADDY_WORKER: '1', AGY_DADDY_PLUGIN_ID: pluginId, AGY_DADDY_HOST_DIR: HOST_ROOT }
    });
    this._liveWorkers.add(worker);
    worker.once('exit', () => this._liveWorkers.delete(worker));

    const pendingBridge = new Map();
    const pendingService = new Map();
    const pendingCommand = new Map();
    const pendingTrayClick = new Map();
    const workerOverlayHandles = new Map();
    let seq = 0;

    const hydrateWorkerTrayDef = (raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const cloned = { ...raw };
      if (cloned.hasOnClick) {
        const localItemId = String(cloned.id || '').trim();
        cloned.onClick = (ctx) => {
          const reqId = ++seq;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingTrayClick.delete(reqId);
              reject(new Error(`Worker tray callback timeout: ${localItemId}`));
            }, 10000);
            pendingTrayClick.set(reqId, { resolve, reject, timer });
            worker.send({
              type: 'tray-click',
              reqId,
              itemId: localItemId,
              ctx: { id: ctx.id, fullId: ctx.fullId, pluginId: ctx.pluginId, checked: ctx.checked }
            });
          });
        };
      }
      if (Array.isArray(cloned.submenu)) {
        cloned.submenu = cloned.submenu.map((sub) => hydrateWorkerTrayDef(sub));
      }
      return cloned;
    };

    worker.on('message', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'bridge-reply') {
        const p = pendingBridge.get(msg.reqId);
        if (!p) return;
        pendingBridge.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
        return;
      }
      if (msg.type === 'service-reply') {
        const p = pendingService.get(msg.reqId);
        if (!p) return;
        pendingService.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
        return;
      }
      if (msg.type === 'command-reply') {
        const p = pendingCommand.get(msg.reqId);
        if (!p) return;
        pendingCommand.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
        return;
      }
      if (msg.type === 'tray-click-reply') {
        const p = pendingTrayClick.get(msg.reqId);
        if (!p) return;
        pendingTrayClick.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
        return;
      }
      if (msg.type === 'ipc-call') {
        const reply = (result, error = null, errorCode = null) => {
          if (worker.connected) {
            worker.send({ type: 'ipc-reply', id: msg.id, result, error, ...(errorCode ? { errorCode } : {}) });
          }
        };
        try {
          const { action, payload } = msg;
          const perms = trustPolicy.granted || [];
          if (action === 'registerRoute') {
            if (!perms.includes('bridge:route')) throw new Error('Permission denied: bridge:route');
            const routeTimeoutMs = Math.max(1000, Math.min(60000, Number(payload?.timeoutMs) || 8000));
            this.bridge.registerPluginRoute(pluginId, payload.subPath, (body) => {
              const reqId = ++seq;
              return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  pendingBridge.delete(reqId);
                  reject(new Error('Worker route timeout'));
                }, routeTimeoutMs);
                pendingBridge.set(reqId, { resolve, reject, timer });
                worker.send({ type: 'bridge-invoke', reqId, subPath: payload.subPath, body });
              });
            });
            reply(true);
          } else if (action === 'rpcGetOrigin') {
            const rpc = createScopedRpcClient(pluginId, perms, this.rpcTransport);
            reply(await rpc.getOrigin());
          } else if (action === 'rpcCall') {
            const rpc = createScopedRpcClient(pluginId, perms, this.rpcTransport);
            reply(await rpc.call(payload.method, payload.body, {
              timeoutMs: payload.timeoutMs,
              retryOnTimeout: payload.retryOnTimeout
            }));
          } else if (action === 'provideService') {
            const methodMap = {};
            for (const mName of payload.methodNames || []) {
              methodMap[mName] = (...args) => {
                const reqId = ++seq;
                return new Promise((resolve, reject) => {
                  const timer = setTimeout(() => {
                    pendingService.delete(reqId);
                    reject(new Error('Worker service timeout'));
                  }, 5000);
                  pendingService.set(reqId, { resolve, reject, timer });
                  worker.send({ type: 'service-invoke', reqId, serviceName: payload.name, method: mName, args });
                });
              };
            }
            this.bus.provideService(pluginId, payload.name, methodMap, { realm: 'node', version: payload.version });
            reply(true);
          } else if (action === 'callService') {
            const res = await this.bus.callService(payload.name, payload.method, payload.args || [], payload.opts || {});
            reply(res);
          } else if (action === 'hasService') {
            reply(this.bus.hasService(payload.name));
          } else if (action === 'emitEvent') {
            reply(this.bus.emitEvent(pluginId, payload.topic, payload.payload));
          } else if (action === 'subscribeEvent') {
            this.bus.onEvent(pluginId, payload.topic, (evPayload, meta) => {
              if (worker.connected) worker.send({ type: 'event-deliver', topic: payload.topic, payload: evPayload, meta });
            });
            reply(true);
          } else if (action === 'setState') {
            reply(this.bus.setState(pluginId, payload.key, payload.value));
          } else if (action === 'getState') {
            reply(this.bus.getState(payload.key));
          } else if (action === 'subscribeState') {
            let initial = null;
            this.bus.subscribeState(pluginId, payload.key, (val, meta) => {
              if (meta.replay) initial = { value: val, version: meta.version };
              else if (worker.connected) worker.send({ type: 'state-deliver', key: payload.key, value: val, meta });
            });
            reply(initial);
          } else if (action === 'getSettings') {
            reply(this.getPluginSettings(pluginId, { manifest, installPath: pluginDir }));
          } else if (action === 'updateSettings') {
            const res = await this.updatePluginSettings(pluginId, payload.patch || {}, {
              manifest,
              installPath: pluginDir
            });
            if (!res.ok) throw new Error((res.errors || []).join('; ') || 'Invalid settings');
            reply(res);
          } else if (action === 'registerCommand') {
            this.registerCommand(pluginId, payload.commandId, (...args) => {
              const reqId = ++seq;
              return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  pendingCommand.delete(reqId);
                  reject(new Error(`Worker command timeout: ${payload.commandId}`));
                }, 8000);
                pendingCommand.set(reqId, { resolve, reject, timer });
                worker.send({ type: 'command-invoke', reqId, commandId: payload.commandId, args });
              });
            });
            reply(true);
          } else if (action === 'unregisterCommand') {
            const rec = this.commands.get(payload.commandId);
            if (rec && rec.pluginId === pluginId) {
              this.commands.delete(payload.commandId);
            }
            reply(true);
          } else if (action === 'executeCommand') {
            const res = await this.executeCommand(payload.commandId, payload.args || []);
            reply(res);
          } else if (action === 'registerTrayMenuItem') {
            const hydrated = hydrateWorkerTrayDef(payload.def);
            const handle = this.trayManager.registerPluginMenuItem(pluginId, hydrated, {
              pluginDir,
              executeCommand: (cmdId, args, opts) => this.executeCommand(cmdId, args, opts)
            });
            reply({ id: handle.id, fullId: handle.fullId });
          } else if (action === 'updateTrayMenuItem') {
            const hydratedPatch = hydrateWorkerTrayDef(payload.patch);
            reply(this.trayManager.updatePluginMenuItem(pluginId, payload.itemId, hydratedPatch));
          } else if (action === 'unregisterTrayMenuItem') {
            reply(this.trayManager.unregisterPluginMenuItem(pluginId, payload.itemId));
          } else if (action === 'listTrayMenuItems') {
            reply(this.trayManager.listPluginMenuItems(pluginId));
          } else if (action === 'overlay:isSupported') {
            reply(this.overlayManager.isSupported());
          } else if (action === 'overlay:createWindow') {
            const handle = await this.overlayManager.createWindow(pluginId, payload?.def || {}, {
              pluginDir,
              permissions: perms
            });
            handle.onInteraction((ev) => {
              if (worker.connected) {
                worker.send({ type: 'overlay-interaction', windowId: ev.windowId, event: ev });
              }
            });
            workerOverlayHandles.set(handle.id, handle);
            reply({ id: handle.id, fullId: handle.fullId });
          } else if (action === 'overlay:setScene') {
            const h = workerOverlayHandles.get(payload?.windowId);
            if (!h) throw new Error(`OVERLAY_WINDOW_NOT_FOUND: ${String(payload?.windowId || '')}`);
            reply(await h.setScene(payload?.scene));
          } else if (action === 'overlay:updateState') {
            const h = workerOverlayHandles.get(payload?.windowId);
            if (!h) throw new Error(`OVERLAY_WINDOW_NOT_FOUND: ${String(payload?.windowId || '')}`);
            reply(await h.updateState(payload?.patch || {}));
          } else if (action === 'overlay:setBounds') {
            const h = workerOverlayHandles.get(payload?.windowId);
            if (!h) throw new Error(`OVERLAY_WINDOW_NOT_FOUND: ${String(payload?.windowId || '')}`);
            reply(await h.setBounds(payload?.bounds || {}));
          } else if (action === 'overlay:setVisible') {
            const h = workerOverlayHandles.get(payload?.windowId);
            if (!h) throw new Error(`OVERLAY_WINDOW_NOT_FOUND: ${String(payload?.windowId || '')}`);
            reply(await h.setVisible(Boolean(payload?.visible)));
          } else if (action === 'overlay:listWindows') {
            reply(this.overlayManager.listPluginWindows(pluginId));
          } else if (action === 'overlay:dispose') {
            const h = workerOverlayHandles.get(payload?.windowId);
            workerOverlayHandles.delete(payload?.windowId);
            reply(h ? await h.dispose() : false);
          } else if (action === 'overlay:disposeAll') {
            workerOverlayHandles.clear();
            await this.overlayManager.disposePluginWindows(pluginId);
            reply(true);
          } else if (action === 'hostControl') {
            if (!perms.includes('host:control')) {
              throw Object.assign(new Error(`HOST_CONTROL_PERMISSION_DENIED: ${pluginId} lacks host:control`), {
                code: 'HOST_CONTROL_PERMISSION_DENIED'
              });
            }
            const rawRoute = String(payload?.routePath || '').trim();
            const normalized = rawRoute.startsWith('/') ? rawRoute : `/${rawRoute}`;
            if (!HOST_CONTROL_ROUTE_ALLOWLIST.includes(normalized)) {
              throw Object.assign(new Error(`HOST_CONTROL_ROUTE_BLOCKED: ${pluginId} cannot invoke ${normalized}`), {
                code: 'HOST_CONTROL_ROUTE_BLOCKED'
              });
            }
            reply(await this.bridge.invokeHostRoute(normalized, payload?.body || {}, { pluginId, via: 'host.control' }));
          } else {
            throw new Error(`Unknown worker IPC action: ${action}`);
          }
        } catch (err) {
          reply(null, err?.message || String(err), err?.code || null);
        }
      }
    });

    const settingsSchema = this.loadPluginSettingsSchema(pluginId, manifest, pluginDir);
    const settingsValues = this.getPluginSettings(pluginId, { manifest, installPath: pluginDir, schema: settingsSchema });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Worker init timeout for ${pluginId}`)), 6000);
        const onMsg = (m) => {
          if (m?.type === 'ready') {
            clearTimeout(timer);
            worker.off('message', onMsg);
            worker.off('exit', onExitBeforeReady);
            resolve();
          } else if (m?.type === 'init-error') {
            clearTimeout(timer);
            worker.off('message', onMsg);
            worker.off('exit', onExitBeforeReady);
            reject(new Error(m.error));
          }
        };
        const onExitBeforeReady = (code) => {
          clearTimeout(timer);
          worker.off('message', onMsg);
          reject(new Error(`Worker exited early with code ${code}`));
        };
        worker.on('message', onMsg);
        worker.once('exit', onExitBeforeReady);
        worker.send({
          type: 'init',
          pluginId,
          pluginDir,
          manifest,
          mainPath: manifest.main,
          grantedPermissions: trustPolicy.granted,
          stateDir: this.stateDir,
          bridgePort: this.bridge.port,
          pluginToken: bridgeToken,
          settingsSchema,
          settingsValues
        });
      });
    } catch (err) {
      worker._intentionalStop = true;
      try { worker.kill('SIGKILL'); } catch {}
      throw err;
    }

    if (!this.running) {
      worker._intentionalStop = true;
      try { worker.kill('SIGKILL'); } catch {}
      throw new Error('DAEMON_STOPPED');
    }

    worker.on('exit', (code, signal) => {
      for (const [, p] of pendingBridge) { clearTimeout(p.timer); p.reject(new Error('Worker exited')); }
      for (const [, p] of pendingService) { clearTimeout(p.timer); p.reject(new Error('Worker exited')); }
      for (const [, p] of pendingCommand) { clearTimeout(p.timer); p.reject(new Error('Worker exited')); }
      for (const [, p] of pendingTrayClick) { clearTimeout(p.timer); p.reject(new Error('Worker exited')); }
      pendingBridge.clear();
      pendingService.clear();
      pendingCommand.clear();
      pendingTrayClick.clear();
      if (this.running && !worker._intentionalStop) {
        this.recordPluginFailure(pluginId, new Error(`Worker crashed (code=${code}, signal=${signal})`));
        this.bus.disposePlugin(pluginId);
        this.bridge.unregisterPluginRoutes(pluginId);
        this.unregisterPluginCommands(pluginId);
        this.trayManager.unregisterPluginItems(pluginId);
        workerOverlayHandles.clear();
        void this.overlayManager.disposePluginWindows(pluginId).catch(() => {});
        this.settingsListeners.delete(pluginId);
        this.activePlugins.delete(pluginId);
      }
    });

    return { worker };
  }

  clearPluginRequireCache(installPath) {
    if (!installPath || !fs.existsSync(installPath)) return;
    try {
      const realInstallRoot = fs.realpathSync(installPath);
      const prefix = realInstallRoot.endsWith(path.sep) ? realInstallRoot : `${realInstallRoot}${path.sep}`;
      for (const cachedKey of Object.keys(require.cache)) {
        if (cachedKey === realInstallRoot || cachedKey.startsWith(prefix)) {
          delete require.cache[cachedKey];
        }
      }
    } catch {}
  }

  async activatePlugin(record, opts = {}) {
    const manifest = readManifestFromDir(record.installPath);
    const trustPolicy = evaluateTrustPolicy(manifest, record.trustLevel || 'T2', record.grantedPermissions || []);
    if (!trustPolicy.allowed) {
      const permErr = new Error(`Permission denied for ${manifest.id}: ${trustPolicy.denied.join(', ')}`);
      permErr.code = 'PERMISSION_DENIED';
      if (opts.skipFailureRecord === true) {
        this.recordPluginDiagnostic(manifest.id, permErr, 'activate');
      } else {
        this.recordPluginFailure(manifest.id, permErr, 'activate');
      }
      throw permErr;
    }

    const health = this.getPluginHealth(manifest.id);
    if (health.circuitOpen) {
      const circErr = new Error(`CIRCUIT_OPEN: ${manifest.id} disabled after ${this.maxCrashes} crashes`);
      circErr.code = 'CIRCUIT_OPEN';
      this.recordPluginDiagnostic(manifest.id, circErr, 'activate');
      throw circErr;
    }

    const token = this.bridge.issuePluginToken(manifest.id);
    let modInstance = null;
    let workerHandle = null;

    try {
      if (manifest.main) {
        if (trustPolicy.nodeIsolation === 'worker') {
          workerHandle = await this.spawnWorkerPlugin(manifest.id, record.installPath, manifest, trustPolicy, token);
        } else {
          const entryPath = path.resolve(record.installPath, manifest.main);
          const loaded = require(entryPath);
          const hostApi = this.buildInProcessHostApi(manifest.id, manifest, trustPolicy, record);
          if (typeof loaded?.activate === 'function') {
            await loaded.activate(hostApi);
          }
          modInstance = loaded;
        }
      }

      if (Array.isArray(manifest.contributes?.['tray.menu'])) {
        this.trayManager.registerManifestContributions(manifest.id, manifest, {
          pluginDir: record.installPath,
          executeCommand: (cmdId, args, opts) => this.executeCommand(cmdId, args, opts)
        });
      }

      if (!this.running) {
        throw new Error('DAEMON_STOPPED');
      }

      this.pluginErrors.delete(manifest.id);
      const activeEntry = {
        id: manifest.id,
        record,
        manifest,
        trustPolicy,
        pluginToken: token,
        modInstance,
        workerHandle
      };
      this.activePlugins.set(manifest.id, activeEntry);
      return activeEntry;
    } catch (err) {
      if (workerHandle?.worker) {
        workerHandle.worker._intentionalStop = true;
        try { workerHandle.worker.kill('SIGKILL'); } catch {}
      }
      if (opts.skipFailureRecord === true) {
        this.recordPluginDiagnostic(manifest.id, err, 'activate');
      } else {
        this.recordPluginFailure(manifest.id, err, 'activate');
      }
      this.bus.disposePlugin(manifest.id);
      this.bridge.unregisterPluginRoutes(manifest.id);
      this.unregisterPluginCommands(manifest.id);
      this.trayManager.unregisterPluginItems(manifest.id);
      await this.overlayManager.disposePluginWindows(manifest.id).catch(() => {});
      this.settingsListeners.delete(manifest.id);
      throw err;
    }
  }

  async deactivatePlugin(pluginId, opts = {}) {
    if (opts.clearDiagnostic === true) {
      this.pluginErrors.delete(pluginId);
    }
    const entry = this.activePlugins.get(pluginId);
    if (!entry) return false;
    this.activePlugins.delete(pluginId);

    if (entry.workerHandle?.worker) {
      const w = entry.workerHandle.worker;
      w._intentionalStop = true;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { w.kill('SIGKILL'); } catch {}
          resolve();
        }, 1200);
        w.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          if (w.connected) w.send({ type: 'deactivate' });
          else w.kill();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    } else if (typeof entry.modInstance?.deactivate === 'function') {
      try {
        await entry.modInstance.deactivate();
      } catch {}
    }

    this.bus.disposePlugin(pluginId);
    this.bridge.unregisterPluginRoutes(pluginId);
    this.unregisterPluginCommands(pluginId);
    this.trayManager.unregisterPluginItems(pluginId);
    await this.overlayManager.disposePluginWindows(pluginId).catch(() => {});
    this.settingsListeners.delete(pluginId);
    return true;
  }

  pickLocaleText(val, fallback = '') {
    if (typeof val === 'string') return val;
    if (val && typeof val === 'object') {
      return String(val['zh-CN'] || val.en || Object.values(val)[0] || fallback);
    }
    return fallback;
  }

  buildRegistryMap() {
    const map = new Map();
    try {
      const reg = loadRegistry(this.options);
      for (const entry of Array.isArray(reg?.plugins) ? reg.plugins : []) {
        if (entry?.id) map.set(entry.id, entry);
      }
    } catch {}
    return map;
  }

  listPluginCatalog(installedIds = new Set(), registryById = null) {
    const items = [];
    const seenIds = new Set(installedIds);
    const regMap = registryById || this.buildRegistryMap();
    const hostRoot = path.resolve(__dirname, '..', '..');
    const workspaceRoot = this.options.workspaceRoot
      ? path.resolve(this.options.workspaceRoot)
      : path.resolve(hostRoot, '..');

    if (fs.existsSync(workspaceRoot)) {
      let dirs = [];
      try {
        dirs = fs.readdirSync(workspaceRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name.startsWith('agy-daddy-plugin-') && d.name !== 'agy-daddy-plugin-template');
      } catch {}
      for (const d of dirs) {
        const pluginDir = path.join(workspaceRoot, d.name);
        try {
          const manifest = readManifestFromDir(pluginDir);
          if (seenIds.has(manifest.id)) continue;
          seenIds.add(manifest.id);
          const regEntry = regMap.get(manifest.id);
          items.push({
            id: manifest.id,
            publisher: manifest.publisher || regEntry?.publisher || '',
            displayName: this.pickLocaleText(manifest.displayName, manifest.id),
            description: this.pickLocaleText(manifest.description, ''),
            version: manifest.version,
            category: manifest.category || regEntry?.category || '',
            tags: Array.isArray(manifest.tags)
              ? manifest.tags
              : (Array.isArray(regEntry?.tags) ? regEntry.tags : []),
            icon: manifest.icon || regEntry?.icon || '',
            screenshots: Array.isArray(manifest.screenshots)
              ? manifest.screenshots
              : (Array.isArray(regEntry?.screenshots) ? regEntry.screenshots : []),
            engines: manifest.engines || regEntry?.engines || null,
            trustLevel: manifest.id.startsWith('agy-daddy.') ? 'T0' : 'T1',
            hasNative: Boolean(manifest.contributes?.native),
            permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
            recommendedSpec: `local:${pluginDir}`,
            repo: regEntry?.repo || '',
            npmPackage: regEntry?.npmPackage || '',
            subpath: regEntry?.subpath || '',
            shortName: regEntry?.shortName || ''
          });
        } catch {}
      }
    }

    try {
      const reg = loadRegistry(this.options);
      for (const entry of Array.isArray(reg?.plugins) ? reg.plugins : []) {
        if (!entry?.id || seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
        items.push({
          id: entry.id,
          publisher: entry.publisher || '',
          displayName: entry.name || entry.id,
          description: entry.description || '',
          version: entry.version || '1.0.0',
          category: entry.category || '',
          tags: Array.isArray(entry.tags) ? entry.tags : [],
          icon: entry.icon || '',
          screenshots: Array.isArray(entry.screenshots) ? entry.screenshots : [],
          engines: entry.engines || null,
          trustLevel: entry.trustLevel || 'T0',
          hasNative: Boolean(entry.hasNative),
          permissions: Array.isArray(entry.permissions) ? entry.permissions : [],
          recommendedSpec: entry.shortName || entry.repo || entry.id,
          repo: entry.repo || '',
          npmPackage: entry.npmPackage || '',
          subpath: entry.subpath || '',
          shortName: entry.shortName || ''
        });
      }
    } catch {}

    return items;
  }

  async resolveCustomizationOptions(body = {}) {
    const explicitWs = body?.workspaceRoot || body?.workspacePath || null;
    const baseOpts = {
      ...this.options,
      stateDir: this.stateDir,
      rpcTransport: this.rpcTransport,
      fallbackWorkspaceRoot: this.options.workspaceRoot ? this.getWorkspaceRoot() : undefined
    };
    if (explicitWs) {
      return { ...baseOpts, workspaceRoot: path.resolve(String(explicitWs)) };
    }
    const wsInfo = await detectActiveWorkspaceRoot(baseOpts);
    return {
      ...baseOpts,
      ...(wsInfo.root ? { workspaceRoot: wsInfo.root } : {})
    };
  }

  getWorkspaceRoot() {
    const hostRoot = path.resolve(__dirname, '..', '..');
    return this.options.workspaceRoot
      ? path.resolve(this.options.workspaceRoot)
      : path.resolve(hostRoot, '..');
  }

  getPluginInstallHealth(record) {
    return inspectPluginInstallHealth(record, {
      ...this.options,
      workspaceRoot: this.getWorkspaceRoot()
    });
  }

  recordMissingInstallDiagnostic(record, fallbackId = 'unknown') {
    const pid = record?.id || path.basename(String(record?.installPath || fallbackId));
    const installHealth = this.getPluginInstallHealth({ ...(record || {}), id: pid });
    const msg = installHealth.status === 'broken_symlink' && installHealth.symlinkTarget
      ? `INSTALL_PATH_MISSING: 软链目标已丢失 (${installHealth.symlinkTarget})`
      : `INSTALL_PATH_MISSING: ${record?.installPath || pid}`;
    const missErr = new Error(msg);
    missErr.code = 'INSTALL_PATH_MISSING';
    const diag = this.recordPluginDiagnostic(pid, missErr, 'load');
    return { pid, diag, installHealth };
  }

  buildPluginMetaMap() {
    const payload = this.buildPluginManagePayload();
    const meta = {};
    for (const item of payload.plugins || []) {
      meta[item.id] = {
        id: item.id,
        displayName: item.displayName,
        description: item.description,
        version: item.version,
        trustLevel: item.trustLevel,
        enabled: item.enabled !== false,
        active: Boolean(item.active),
        health: item.health || null,
        installHealth: item.installHealth || null,
        hasNative: Boolean(item.hasNative),
        nativeInfo: item.nativeInfo || null,
        settingsSchema: item.settingsSchema || null,
        settingsValues: item.settingsValues || {},
        settingsSecretState: item.settingsSecretState || {},
        commands: Array.isArray(item.commands) ? item.commands : [],
        topbarUnits: Array.isArray(item.topbarUnits) ? item.topbarUnits : [],
        repo: item.repo || '',
        npmPackage: item.npmPackage || '',
        sourceKind: item.sourceKind || '',
        sourceSpec: item.sourceSpec || '',
        marketStats: item.marketStats || null
      };
    }
    return meta;
  }

  buildPluginManagePayload() {
    const installedList = listInstalledPlugins(this.options);
    const pluginsDir = getPluginsDir(this.options);
    const registryById = this.buildRegistryMap();
    const byId = new Map();

    for (const rec of installedList) {
      let manifest = this.activePlugins.get(rec.id)?.manifest || null;
      if (!manifest && rec.installPath && fs.existsSync(rec.installPath)) {
        try { manifest = readManifestFromDir(rec.installPath); } catch {}
      }
      const activeEntry = this.activePlugins.get(rec.id);
      const rollbackDir = path.join(pluginsDir, '.rollback', `${rec.id}.prev`);
      const settingsSchema = this.loadPluginSettingsSchema(rec.id, manifest, rec.installPath);
      const rawValues = this.getPluginSettings(rec.id, { manifest, installPath: rec.installPath, schema: settingsSchema });
      const redacted = redactWriteOnlySettings(settingsSchema, rawValues);
      const regEntry = registryById.get(rec.id);
      const nativeInfo = manifest?.contributes?.native
        ? inspectPluginNativeStatus(rec.id, manifest, {
            ...this.options,
            pluginDir: rec.installPath,
            nativeConfig: rec.nativeConfig
          })
        : null;
      const installHealth = this.getPluginInstallHealth(rec);
      byId.set(rec.id, {
        id: rec.id,
        displayName: this.pickLocaleText(manifest?.displayName, rec.id),
        description: this.pickLocaleText(manifest?.description, ''),
        version: rec.version || manifest?.version || '1.0.0',
        trustLevel: rec.trustLevel || activeEntry?.trustPolicy?.trustLevel || 'T2',
        badge: rec.badge || activeEntry?.trustPolicy?.badge || '未审核',
        world: activeEntry?.trustPolicy?.world || rec.world || manifest?.world || 'isolated',
        nodeIsolation: activeEntry?.trustPolicy?.nodeIsolation || rec.nodeIsolation || 'worker',
        enabled: rec.enabled !== false,
        active: Boolean(activeEntry),
        hasNative: Boolean(manifest?.contributes?.native || nativeInfo?.synced),
        nativeInfo,
        hasRollback: fs.existsSync(rollbackDir),
        permissions: Array.isArray(rec.grantedPermissions) ? rec.grantedPermissions : (manifest?.permissions || []),
        sourceKind: rec.sourceKind || 'local',
        sourceSpec: rec.sourceSpec || '',
        repo: regEntry?.repo || '',
        npmPackage: regEntry?.npmPackage || '',
        subpath: regEntry?.subpath || '',
        shortName: regEntry?.shortName || '',
        category: manifest?.category || regEntry?.category || '',
        tags: Array.isArray(manifest?.tags)
          ? manifest.tags
          : (Array.isArray(regEntry?.tags) ? regEntry.tags : []),
        settingsSchema,
        settingsValues: redacted.values,
        settingsSecretState: redacted.secretState,
        commands: Array.isArray(manifest?.contributes?.commands) ? manifest.contributes.commands : [],
        topbarUnits: Array.isArray(manifest?.contributes?.['topbar.units']) ? manifest.contributes['topbar.units'] : [],
        health: this.getPluginHealth(rec.id),
        installHealth
      });
    }

    for (const [id, entry] of this.activePlugins.entries()) {
      if (byId.has(id)) continue;
      const installPath = entry.record?.installPath || null;
      const settingsSchema = this.loadPluginSettingsSchema(id, entry.manifest, installPath);
      const rawValues = this.getPluginSettings(id, { manifest: entry.manifest, installPath, schema: settingsSchema });
      const redacted = redactWriteOnlySettings(settingsSchema, rawValues);
      const regEntry = registryById.get(id);
      const nativeInfo = entry.manifest?.contributes?.native
        ? inspectPluginNativeStatus(id, entry.manifest, {
            ...this.options,
            pluginDir: installPath,
            nativeConfig: entry.record?.nativeConfig
          })
        : null;
      byId.set(id, {
        id,
        displayName: this.pickLocaleText(entry.manifest?.displayName, id),
        description: this.pickLocaleText(entry.manifest?.description, ''),
        version: entry.manifest.version,
        trustLevel: entry.trustPolicy.trustLevel,
        badge: entry.trustPolicy.badge,
        world: entry.trustPolicy.world,
        nodeIsolation: entry.trustPolicy.nodeIsolation,
        enabled: true,
        active: true,
        hasNative: Boolean(entry.manifest?.contributes?.native),
        nativeInfo,
        hasRollback: false,
        permissions: Array.isArray(entry.trustPolicy?.granted) ? entry.trustPolicy.granted : [],
        sourceKind: entry.record?.sourceKind || 'memory',
        sourceSpec: entry.record?.sourceSpec || '',
        repo: regEntry?.repo || '',
        npmPackage: regEntry?.npmPackage || '',
        subpath: regEntry?.subpath || '',
        shortName: regEntry?.shortName || '',
        category: entry.manifest?.category || regEntry?.category || '',
        tags: Array.isArray(entry.manifest?.tags)
          ? entry.manifest.tags
          : (Array.isArray(regEntry?.tags) ? regEntry.tags : []),
        settingsSchema,
        settingsValues: redacted.values,
        settingsSecretState: redacted.secretState,
        commands: Array.isArray(entry.manifest?.contributes?.commands) ? entry.manifest.contributes.commands : [],
        topbarUnits: Array.isArray(entry.manifest?.contributes?.['topbar.units']) ? entry.manifest.contributes['topbar.units'] : [],
        health: this.getPluginHealth(id),
        installHealth: { status: 'ok', exists: true, isSymlink: false, symlinkTarget: null, repairCandidates: [] }
      });
    }

    const items = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
    const catalog = this.listPluginCatalog(new Set(byId.keys()), registryById);
    const marketStats = this.marketplaceStats.getCachedStatsForPlugins([...items, ...catalog]);
    for (const item of items) {
      item.marketStats = marketStats[item.id] || null;
    }
    for (const cat of catalog) {
      cat.marketStats = marketStats[cat.id] || null;
    }
    return {
      ok: true,
      plugins: items,
      catalog,
      marketStats,
      hostRestartNotice: this.getHostRestartNotice(),
      proxyFallback: this.getSessionProxyFallbackStatus()
    };
  }

  inspectCurrentHostProcess() {
    try {
      const fn = this.options.inspectHostProcess || inspectAntigravityHostProcess;
      return fn(this.options) || { running: false, pid: null, hasDebugSwitch: false, command: '' };
    } catch {
      return { running: false, pid: null, hasDebugSwitch: false, command: '' };
    }
  }

  readPluginManifestSafe(pluginId, record = null) {
    const active = this.activePlugins.get(pluginId);
    if (active?.manifest) return active.manifest;
    const installPath = record?.installPath;
    if (installPath && fs.existsSync(installPath)) {
      try { return readManifestFromDir(installPath); } catch {}
    }
    return null;
  }

  pluginUsesHostLaunchArgs(pluginId, { manifest = null, record = null } = {}) {
    const active = this.activePlugins.get(pluginId);
    const rec = record || active?.record || readInstalledIndex(this.options).plugins?.[pluginId] || null;
    const man = manifest || this.readPluginManifestSafe(pluginId, rec);
    const manifestPerms = Array.isArray(man?.permissions) ? man.permissions : [];
    const grantedPerms = Array.isArray(rec?.grantedPermissions) ? rec.grantedPermissions : [];
    if (manifestPerms.includes('host:launch-args') || grantedPerms.includes('host:launch-args')) {
      return true;
    }
    for (const hookName of ['hostLaunchArgs', 'hostLaunchEnv']) {
      const entries = this.bus.hooks.get(hookName);
      if (entries) {
        for (const entry of entries) {
          if (entry.pluginId === pluginId) return true;
        }
      }
    }
    return false;
  }

  async detectPluginProxyGatewayPort(pluginId) {
    const proxyState = this.bus.getState('state:proxy.status@1');
    if (proxyState && (proxyState.publisher === pluginId || pluginId === 'agy-daddy.proxy')) {
      const val = proxyState.value;
      if (val && val.listening && Number(val.gatewayPort) > 0) {
        return Number(val.gatewayPort);
      }
      if (val && val.gatewayEnabled === false && !val.listening) {
        return null;
      }
    }
    const entries = this.bus.hooks.get('hostLaunchArgs');
    if (entries) {
      for (const entry of Array.from(entries)) {
        if (entry.pluginId !== pluginId) continue;
        try {
          const out = await entry.fn({ appPath: '/Applications/Antigravity.app' });
          if (Array.isArray(out)) {
            const port = parseProxyPortFromCommand(out.join(' '));
            if (port) return port;
          }
        } catch {}
      }
    }
    const hostProc = this.inspectCurrentHostProcess();
    if (hostProc.running && hasProxyServerArg(hostProc.command)) {
      return parseProxyPortFromCommand(hostProc.command);
    }
    return null;
  }

  getSessionProxyFallbackStatus() {
    if (!this.sessionProxyFallback || !this.sessionProxyFallback.server) {
      return {
        active: false,
        pluginId: null,
        port: null,
        mode: null,
        forcedDirect: false
      };
    }
    const stats = this.sessionProxyFallback.server.getStats();
    return {
      active: Boolean(stats.listening),
      pluginId: this.sessionProxyFallback.pluginId || null,
      port: stats.port || this.sessionProxyFallback.port || null,
      mode: 'direct',
      forcedDirect: true,
      reason: this.sessionProxyFallback.reason || 'plugin_disabled',
      since: this.sessionProxyFallback.since || null,
      stats
    };
  }

  getHostRestartNotice() {
    return this.pendingHostRestart ? { ...this.pendingHostRestart } : null;
  }

  clearPendingHostRestart(pluginId = null) {
    if (!this.pendingHostRestart) return;
    if (!pluginId || this.pendingHostRestart.pluginId === pluginId) {
      this.pendingHostRestart = null;
    }
  }

  async startSessionProxyFallback({ pluginId = 'agy-daddy.proxy', port = 18766, reason = 'plugin_disabled' } = {}) {
    const listenPort = Number(port);
    if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
      return null;
    }
    if (this.sessionProxyFallback?.server && this.sessionProxyFallback.port === listenPort) {
      this.sessionProxyFallback.pluginId = pluginId;
      this.sessionProxyFallback.reason = reason;
      return this.getSessionProxyFallbackStatus();
    }
    await this.stopSessionProxyFallback();
    const server = new DirectProxyFallbackServer({ host: '127.0.0.1', port: listenPort });
    await server.start(listenPort);
    this.sessionProxyFallback = {
      server,
      pluginId,
      port: server.port || listenPort,
      reason,
      since: Date.now()
    };
    return this.getSessionProxyFallbackStatus();
  }

  async stopSessionProxyFallback() {
    const current = this.sessionProxyFallback;
    this.sessionProxyFallback = null;
    if (current?.server) {
      try {
        await current.server.stop();
      } catch {}
    }
  }

  async handleHostProcessLifecycleChange({ running = false, command = '', freshAppStart = false } = {}) {
    if (!running) {
      await this.stopSessionProxyFallback();
      this.clearPendingHostRestart();
      return;
    }
    if (freshAppStart) {
      const cmdHasProxy = hasProxyServerArg(command);
      if (this.sessionProxyFallback && !cmdHasProxy) {
        await this.stopSessionProxyFallback();
      }
      if (this.pendingHostRestart) {
        const pid = this.pendingHostRestart.pluginId;
        const isActive = this.activePlugins.has(pid);
        if ((isActive && cmdHasProxy) || (!isActive && !cmdHasProxy)) {
          this.clearPendingHostRestart();
        }
      }
    }
  }

  registerDefaultHostRoutes() {
    this.bridge.registerHostRoute('/host/health', (_body, ctx) => {
      // Existing host.control consumers expect the doctor envelope.
      return ctx?.via === 'host.control'
        ? runDoctor({ ...this.options, hostHealth: this.getDiagnosticHealth() })
        : this.getHostHealth();
    });
    this.bridge.registerHostRoute('/host/health/runtime-report', (body) => {
      const result = this.health.acceptRuntimeReport(body);
      this.getHostHealth();
      return result;
    });
    this.bridge.registerDiagnosticsHealth?.(() => this.getDiagnosticHealth());
    this.bridge.registerHostRoute('/host/plugins', async () => {
      return this.buildPluginManagePayload();
    });
    this.bridge.registerHostRoute('/host/marketplace/stats', async (body) => {
      const payload = this.buildPluginManagePayload();
      const allEntries = [...(payload.plugins || []), ...(payload.catalog || [])];
      const stats = await this.marketplaceStats.fetchStatsForPlugins(allEntries, {
        forceRefresh: Boolean(body?.forceRefresh)
      });
      return { ok: true, stats, fetchedAt: Date.now() };
    });
    this.bridge.registerHostRoute('/host/plugins/toggle', async (body) => {
      const pluginId = String(body?.pluginId || '').trim();
      if (!pluginId) throw new Error('pluginId is required');
      const nextEnabled = body?.enabled !== false;
      const prevRec = readInstalledIndex(this.options).plugins?.[pluginId] || this.activePlugins.get(pluginId)?.record || null;
      const manifest = this.readPluginManifestSafe(pluginId, prevRec);
      const displayName = this.pickLocaleText(manifest?.displayName, pluginId);
      const usesLaunchArgs = this.pluginUsesHostLaunchArgs(pluginId, { manifest, record: prevRec });

      if (!nextEnabled) {
        const proxyPort = usesLaunchArgs ? await this.detectPluginProxyGatewayPort(pluginId) : null;
        const updatedRec = disablePlugin(pluginId, this.options);
        this.clearPluginDiagnostic(pluginId);
        const reload = await this.reloadPlugin(pluginId);

        const hostProc = this.inspectCurrentHostProcess();
        const hostRunningWithoutProxy = Boolean(hostProc.running && hostProc.command && !hasProxyServerArg(hostProc.command));
        if (proxyPort && !hostRunningWithoutProxy) {
          await this.startSessionProxyFallback({
            pluginId,
            port: proxyPort,
            reason: 'plugin_disabled'
          });
          this.clearPendingHostRestart(pluginId);
        } else if (usesLaunchArgs && !proxyPort && hostProc.running && hasProxyServerArg(hostProc.command)) {
          this.pendingHostRestart = {
            required: true,
            reason: 'launch_args_disable',
            pluginId,
            displayName,
            action: 'disable',
            message: `已停用「${displayName}」，需要重启 Antigravity 清理启动参数才能生效，不重启将无法使用。`,
            since: Date.now()
          };
        } else {
          this.clearPendingHostRestart(pluginId);
        }

        await this.syncPluginMetaToSessions();
        const payload = this.buildPluginManagePayload();
        return {
          ok: true,
          plugin: updatedRec,
          reload,
          hostRestartRequired: Boolean(this.pendingHostRestart?.required),
          ...payload
        };
      }

      const fallbackActiveForPlugin = Boolean(
        this.sessionProxyFallback &&
        (!this.sessionProxyFallback.pluginId || this.sessionProxyFallback.pluginId === pluginId)
      );
      if (this.sessionProxyFallback) {
        await this.stopSessionProxyFallback();
      }

      const updatedRec = enablePlugin(pluginId, this.options);
      const reload = await this.activatePluginById(pluginId, {
        resetCircuit: true,
        enableIfDisabled: false
      });

      const activeManifest = this.readPluginManifestSafe(pluginId, updatedRec);
      const activeUsesLaunchArgs = usesLaunchArgs || this.pluginUsesHostLaunchArgs(pluginId, {
        manifest: activeManifest,
        record: updatedRec
      });
      if (activeUsesLaunchArgs && reload?.active !== false) {
        const hostProc = this.inspectCurrentHostProcess();
        const hostHasProxy = Boolean(hostProc.running && hasProxyServerArg(hostProc.command));
        if (fallbackActiveForPlugin || hostHasProxy) {
          this.clearPendingHostRestart(pluginId);
        } else if (hostProc.running || (this.injector?.sessions?.size || 0) > 0) {
          this.pendingHostRestart = {
            required: true,
            reason: 'launch_args_enable',
            pluginId,
            displayName: this.pickLocaleText(activeManifest?.displayName, displayName),
            action: 'enable',
            message: `已启用「${this.pickLocaleText(activeManifest?.displayName, displayName)}」，需要重启 Antigravity 注入启动参数才能生效，不重启将无法使用。`,
            since: Date.now()
          };
        }
      }

      const payload = this.buildPluginManagePayload();
      return {
        ok: true,
        plugin: updatedRec,
        reload,
        ...(reload?.ok === false && reload?.error ? { activationError: reload.error } : {}),
        hostRestartRequired: Boolean(this.pendingHostRestart?.required),
        ...payload
      };
    });
    this.bridge.registerHostRoute('/host/plugins/activate', async (body) => {
      if (body?.all === true || (!body?.pluginId && body?.all !== false)) {
        const res = await this.ensureEnabledPluginsActivated({
          resetCircuit: body?.resetCircuit !== false,
          injectSessions: true,
          retryTransient: true
        });
        return { ...this.buildPluginManagePayload(), ...res };
      }
      const pluginId = String(body?.pluginId || '').trim();
      if (!pluginId) throw new Error('pluginId is required');
      const res = await this.activatePluginById(pluginId, {
        resetCircuit: body?.resetCircuit !== false,
        enableIfDisabled: body?.enableIfDisabled !== false
      });
      return { ...this.buildPluginManagePayload(), ...res };
    });
    this.bridge.registerHostRoute('/host/plugins/repair', async (body) => {
      const pluginId = String(body?.pluginId || '').trim();
      if (!pluginId) throw new Error('pluginId is required');
      let repairRes;
      try {
        repairRes = await repairPluginInstall(
          pluginId,
          {
            mode: body?.mode,
            spec: body?.spec,
            localPath: body?.localPath,
            copy: Boolean(body?.copy)
          },
          {
            ...this.options,
            workspaceRoot: this.getWorkspaceRoot()
          }
        );
      } catch (err) {
        return {
          ...this.buildPluginManagePayload(),
          ok: false,
          pluginId,
          error: err?.message || String(err)
        };
      }
      if (!repairRes?.ok) {
        return {
          ...this.buildPluginManagePayload(),
          ok: false,
          pluginId,
          error: repairRes?.error || 'REPAIR_FAILED'
        };
      }
      const actRes = await this.activatePluginById(pluginId, {
        resetCircuit: true,
        enableIfDisabled: false
      });
      return {
        ...this.buildPluginManagePayload(),
        ...actRes,
        repaired: true,
        repair: repairRes
      };
    });
    this.bridge.registerHostRoute('/host/plugins/install', async (body) => {
      const spec = String(body?.spec || '').trim();
      if (!spec) throw new Error('spec is required');
      const hostSettings = this.getHostSettings();
      const installOpts = {
        ...this.options,
        copy: Boolean(body?.copy),
        grantedPermissions: Array.isArray(body?.grantedPermissions) ? body.grantedPermissions : [],
        defaultNativeEnabled: hostSettings.autoSyncNativeOnInstall !== false
      };
      if (body?.nativeConfig && typeof body.nativeConfig === 'object') {
        installOpts.nativeConfig = body.nativeConfig;
      }
      if (typeof body?.syncNative === 'boolean') {
        installOpts.syncNative = body.syncNative;
      }
      if (body?.trustLevel) installOpts.trustLevel = String(body.trustLevel);
      let res;
      try {
        res = await installPlugin(spec, installOpts);
      } catch (err) {
        if (err?.code === 'PERMISSION_CONFIRMATION_REQUIRED') {
          return {
            ok: false,
            needsPermissionConfirm: true,
            error: err.message,
            spec,
            trustPolicy: err.trustPolicy
          };
        }
        throw err;
      }
      const usesLaunchArgs = this.pluginUsesHostLaunchArgs(res.plugin.id, {
        manifest: res.manifest,
        record: res.plugin
      });
      if (this.sessionProxyFallback && (this.sessionProxyFallback.pluginId === res.plugin.id || usesLaunchArgs)) {
        await this.stopSessionProxyFallback();
      }
      const reload = await this.reloadPlugin(res.plugin.id);
      const displayName = this.pickLocaleText(res.manifest?.displayName, res.plugin.id);
      if (res.isFirstInstall && usesLaunchArgs) {
        const hostProc = this.inspectCurrentHostProcess();
        const hostAlreadyHasProxy = Boolean(hostProc.running && hasProxyServerArg(hostProc.command));
        if (!hostAlreadyHasProxy) {
          this.pendingHostRestart = {
            required: true,
            reason: 'launch_args_first_install',
            pluginId: res.plugin.id,
            displayName,
            action: 'install',
            isFirstInstall: true,
            message: `首次安装「${displayName}」需要重启 Antigravity 注入启动参数才能生效，不重启将无法使用。`,
            since: Date.now()
          };
        } else {
          this.clearPendingHostRestart(res.plugin.id);
        }
      }
      const payload = this.buildPluginManagePayload();
      return {
        ok: true,
        plugin: res.plugin,
        isFirstInstall: Boolean(res.isFirstInstall),
        nativeSync: res.nativeSync,
        reload,
        hostRestartRequired: Boolean(this.pendingHostRestart?.required),
        ...payload
      };
    });
    this.bridge.registerHostRoute('/host/plugins/uninstall', async (body) => {
      const pluginId = String(body?.pluginId || '').trim();
      if (!pluginId) throw new Error('pluginId is required');
      const idx = readInstalledIndex(this.options);
      const rec = idx.plugins?.[pluginId];
      let manifest = this.activePlugins.get(pluginId)?.manifest || null;
      if (rec) {
        if (!manifest && rec.installPath && fs.existsSync(rec.installPath)) {
          try { manifest = readManifestFromDir(rec.installPath); } catch {}
        }
        const nativeInfo = inspectPluginNativeStatus(pluginId, manifest, {
          ...this.options,
          pluginDir: rec.installPath,
          nativeConfig: rec.nativeConfig
        });
        const hasNative = Boolean(nativeInfo.hasNative || nativeInfo.synced);
        if (hasNative && body?.confirmNativeDelete !== true) {
          return {
            ok: false,
            needsNativeUninstallConfirm: true,
            pluginId,
            nativeInfo,
            error: '该插件包含原生扩展，确认后将删除插件及已注入的原生扩展目录'
          };
        }
      }
      const displayName = this.pickLocaleText(manifest?.displayName, pluginId);
      const usesLaunchArgs = this.pluginUsesHostLaunchArgs(pluginId, { manifest, record: rec });
      if (this.sessionProxyFallback && (!this.sessionProxyFallback.pluginId || this.sessionProxyFallback.pluginId === pluginId)) {
        await this.stopSessionProxyFallback();
      }
      await this.deactivatePlugin(pluginId);
      await this.injector.reloadPlugin(pluginId, null);
      const rmRes = uninstallPlugin(pluginId, {
        ...this.options,
        confirmNativeDelete: Boolean(body?.confirmNativeDelete)
      });
      if (rmRes?.ok && usesLaunchArgs) {
        this.pendingHostRestart = {
          required: true,
          reason: 'launch_args_uninstall',
          pluginId,
          displayName,
          action: 'uninstall',
          message: `已卸载「${displayName}」，需要重启 Antigravity 清理残留启动参数才能生效，不重启将无法使用。`,
          since: Date.now()
        };
      }
      const payload = this.buildPluginManagePayload();
      return {
        ...rmRes,
        hostRestartRequired: Boolean(this.pendingHostRestart?.required),
        ...payload
      };
    });
    this.bridge.registerHostRoute('/host/antigravity/relaunch', async (body) => {
      let res;
      if (typeof this.options.onRelaunchAntigravity === 'function') {
        res = await this.options.onRelaunchAntigravity(body || {});
      } else {
        const env = this.options.env || process.env;
        const plan = planAntigravityRestart({
          allowSelfTerminate: Boolean(body?.force),
          env
        });
        if (!plan.ok) {
          return {
            ok: false,
            relaunched: false,
            ...plan,
            ...this.buildPluginManagePayload()
          };
        }
        const hostProc = this.inspectCurrentHostProcess();
        const appPath = hostProc.appPath || findAntigravityApp({ platform: process.platform, env });
        const spec = await this.collectHostLaunchSpec(appPath);
        if (isTestMode() && typeof this.options.relaunchAntigravity !== 'function') {
          await this.stopSessionProxyFallback();
          this.clearPendingHostRestart();
          return {
            ok: true,
            dryRun: true,
            skipped: true,
            mode: 'test',
            args: spec.args,
            env: spec.env,
            ...this.buildPluginManagePayload()
          };
        }
        const relaunchFn = this.options.relaunchAntigravity || relaunchAntigravityWithCdp;
        res = await relaunchFn({
          appPath,
          proxyEnv: spec.env,
          extraArgs: spec.args,
          onlyIfBare: false,
          allowSelfTerminate: Boolean(body?.force),
          stateDir: this.stateDir,
          env
        });
        if (res?.ok && Array.isArray(res.targets) && res.targets.length > 0 && !this.options.skipInject) {
          await this.injectActiveTargets({ resetCircuitOnLaunch: true }).catch(() => {});
        }
      }
      if (res?.ok) {
        await this.stopSessionProxyFallback();
        this.clearPendingHostRestart();
      }
      return {
        ...(res && typeof res === 'object' ? res : { ok: Boolean(res) }),
        ...this.buildPluginManagePayload()
      };
    });
    this.bridge.registerHostRoute('/host/plugins/native/config', async (body) => {
      const pluginId = String(body?.pluginId || '').trim();
      if (!pluginId) throw new Error('pluginId is required');
      const res = updatePluginNativeConfig(pluginId, body?.config || body?.patch || {}, this.options);
      return { ...res, ...this.buildPluginManagePayload() };
    });
    this.bridge.registerHostRoute('/host/plugins/native/rules/rollback', async (body) => {
      const pluginId = String(body?.pluginId || '').trim();
      if (!pluginId) throw new Error('pluginId is required');
      const res = rollbackPluginNativeRules(pluginId, {
        ...this.options,
        backupId: body?.backupId ? String(body.backupId) : undefined
      });
      return { ...res, ...this.buildPluginManagePayload() };
    });
    this.bridge.registerHostRoute('/host/plugins/rollback', async (body) => {
      const pluginId = String(body?.pluginId || '').trim();
      if (!pluginId) throw new Error('pluginId is required');
      const rbRes = rollbackPlugin(pluginId, this.options);
      const reload = await this.reloadPlugin(pluginId);
      return { ...rbRes, reload, ...this.buildPluginManagePayload() };
    });
    this.bridge.registerHostRoute('/host/reload', async (body) => {
      if (!body?.pluginId) throw new Error('pluginId is required');
      const reload = await this.reloadPlugin(String(body.pluginId), {
        resetCircuit: Boolean(body?.resetCircuit)
      });
      await this.syncPluginMetaToSessions();
      return { ...reload, ...this.buildPluginManagePayload() };
    });
    this.bridge.registerHostRoute('/host/reload-all', async (body) => {
      const reloadRes = await this.reloadAll({
        rebuildRenderer: body?.rebuildRenderer !== false,
        resetCircuit: Boolean(body?.resetCircuit),
        restoreView: body?.restoreView && typeof body.restoreView === 'object' ? body.restoreView : null
      });
      return { ...reloadRes, ...this.buildPluginManagePayload() };
    });
    this.bridge.registerHostRoute('/host/daemon/restart', async (body) => {
      return await this.requestDaemonRestart({
        rebuildRenderer: body?.rebuildRenderer !== false,
        reason: body?.reason ? String(body.reason) : 'ui'
      });
    });
    this.bridge.registerHostRoute('/host/anchors', async () => {
      return { ok: true, data: loadAnchorsRegistry({ stateDir: this.stateDir, anchorsPath: this.options.anchorsPath }) };
    });
    this.bridge.registerHostRoute('/host/bus/call', async (body) => {
      const { service, method, args = [], optional = true } = body || {};
      return await this.bus.callService(service, method, args, { optional, callerRealm: 'page-main' });
    });
    this.bridge.registerHostRoute('/host/host-settings', async (body) => {
      const action = String(body?.action || 'get').toLowerCase();
      if (action === 'save' || action === 'update') {
        const res = this.saveHostSettings(body?.values || body?.patch || {}, { skipTraySync: true });
        if (res?.ok) {
          await this.syncTrayVisibility(res.values).catch(() => {});
        }
        return res;
      }
      return { ok: true, values: this.getHostSettings() };
    });
    this.bridge.registerHostRoute('/host/settings', async (body) => {
      const pluginId = String(body?.pluginId || '').trim();
      if (!pluginId) throw new Error('pluginId is required');
      const action = String(body?.action || 'get').toLowerCase();
      const schema = this.loadPluginSettingsSchema(pluginId);
      if (action === 'update' || action === 'save') {
        const res = await this.updatePluginSettings(pluginId, body?.values || body?.patch || {}, { schema });
        if (!res?.ok) return res;
        const redacted = redactWriteOnlySettings(schema, res.values);
        const hasSecretState = Object.keys(redacted.secretState).length > 0;
        return {
          ...res,
          values: redacted.values,
          ...(hasSecretState ? { secretState: redacted.secretState } : {})
        };
      }
      const redacted = redactWriteOnlySettings(schema, this.getPluginSettings(pluginId, { schema }));
      const hasSecretState = Object.keys(redacted.secretState).length > 0;
      return {
        ok: true,
        values: redacted.values,
        ...(hasSecretState ? { secretState: redacted.secretState } : {}),
        schema
      };
    });
    this.bridge.registerHostRoute('/host/commands/run', async (body) => {
      const commandId = String(body?.commandId || '').trim();
      if (!commandId) throw new Error('commandId is required');
      const args = Array.isArray(body?.args) ? body.args : [];
      const pluginId = body?.pluginId ? String(body.pluginId).trim() : null;
      const result = await this.executeCommand(commandId, args, { pluginId });
      return { ok: true, result };
    });
    this.bridge.registerHostRoute('/host/diagnostics/export', async () => {
      const outPath = path.join(this.stateDir, 'agy-daddy-diagnostic-bundle.json');
      const cdpSnapshot = typeof this.injector?.getActiveCdpSnapshot === 'function'
        ? this.injector.getActiveCdpSnapshot()
        : null;
      const hasLiveCdp = Boolean(cdpSnapshot && (cdpSnapshot.port || cdpSnapshot.targetsCount > 0));
      const exp = await exportDiagnosticBundle(outPath, {
        ...this.options,
        stateDir: this.stateDir,
        hostHealth: this.getHostHealth(),
        ...(hasLiveCdp ? { cdpSnapshot } : {})
      });
      return {
        ok: Boolean(exp.ok),
        path: exp.path || outPath,
        report: exp.report || exp.bundle
      };
    });
    this.bridge.registerHostRoute('/host/tray/menu', async () => {
      const items = this.trayManager.buildMenuModel();
      return {
        ok: true,
        appName: this.trayManager.appName,
        visible: this.trayManager.visible !== false,
        started: Boolean(this.trayManager.started),
        items,
        errors: this.trayManager.getPluginErrors()
      };
    });
    this.bridge.registerHostRoute('/host/tray/invoke', async (body) => {
      const itemId = String(body?.itemId || '').trim();
      if (!itemId) throw new Error('itemId is required');
      return await this.trayManager.handleMenuClick(itemId);
    });
    this.bridge.registerHostRoute('/host/settings/open', async (body) => {
      return await this.openPluginSettings({
        tab: body?.tab || 'plugins',
        pluginId: body?.pluginId
      });
    });

    // Antigravity 多层级自定义项与 MCP 策略管理端点
    this.bridge.registerHostRoute('/host/customizations', async (body) => {
      const custOpts = await this.resolveCustomizationOptions(body);
      return await scanCustomizations(custOpts);
    });
    this.bridge.registerHostRoute('/host/customizations/toggle', async (body) => {
      const custOpts = await this.resolveCustomizationOptions(body);
      return setCustomizationEnabled(body || {}, custOpts);
    });
    this.bridge.registerHostRoute('/host/customizations/install', async (body) => {
      const custOpts = await this.resolveCustomizationOptions(body);
      return installCustomization(body || {}, custOpts);
    });
    this.bridge.registerHostRoute('/host/customizations/uninstall', async (body) => {
      const custOpts = await this.resolveCustomizationOptions(body);
      return uninstallCustomization(body || {}, custOpts);
    });
    this.bridge.registerHostRoute('/host/customizations/migrate', async (body) => {
      const custOpts = await this.resolveCustomizationOptions(body);
      return migrateCustomizationToWorkspace(body || {}, custOpts);
    });
    this.bridge.registerHostRoute('/host/customizations/mcp/policy', async (body) => {
      const custOpts = await this.resolveCustomizationOptions(body);
      return await applyMcpPolicy(body || {}, custOpts);
    });
    this.bridge.registerHostRoute('/host/customizations/mcp/rollback', async (body) => {
      const custOpts = await this.resolveCustomizationOptions(body);
      return rollbackMcpConfig(body || {}, custOpts);
    });

    // 内置插件系统路由（按插件 Token 鉴权，无需声明 bridge:route 权限）
    this.bridge.registerPluginSystemRoute('/__settings', async (body, meta) => {
      const pluginId = meta.pluginId;
      const action = String(body?.action || 'get').toLowerCase();
      const schema = this.loadPluginSettingsSchema(pluginId);
      if (action === 'update' || action === 'save') {
        const res = await this.updatePluginSettings(pluginId, body?.values || body?.patch || {}, { schema });
        if (!res?.ok) return res;
        const redacted = redactWriteOnlySettings(schema, res.values);
        const hasSecretState = Object.keys(redacted.secretState).length > 0;
        return {
          ...res,
          values: redacted.values,
          ...(hasSecretState ? { secretState: redacted.secretState } : {})
        };
      }
      const redacted = redactWriteOnlySettings(schema, this.getPluginSettings(pluginId, { schema }));
      const hasSecretState = Object.keys(redacted.secretState).length > 0;
      return {
        ok: true,
        values: redacted.values,
        ...(hasSecretState ? { secretState: redacted.secretState } : {})
      };
    });
    this.bridge.registerPluginSystemRoute('/__command', async (body, meta) => {
      const commandId = String(body?.commandId || '').trim();
      if (!commandId) throw new Error('commandId is required');
      const args = Array.isArray(body?.args) ? body.args : [];
      const result = await this.executeCommand(commandId, args, { pluginId: meta.pluginId });
      return { ok: true, result };
    });
  }

  async injectActiveTargets(opts = {}) {
    const host = (this.options.inspectHostProcess || inspectAntigravityHostProcess)(this.options);
    if (host?.version) this.injector.antigravityVersion = host.version;
    if (opts.skipActivateInactive !== true) {
      await this.ensureEnabledPluginsActivated({
        resetCircuit: Boolean(opts.resetCircuitOnLaunch),
        retryTransient: true
      }).catch(() => {});
    }
    const res = await this.injector.injectAllActiveTargets(Array.from(this.activePlugins.values()), opts);
    if (host) this.health.observe(host, res.discovery);
    if (res.targetsInjected > 0) this.health.recordInjectedVersion(host?.version);
    for (const { targetId } of res.results || []) this.health.recordInjection({ targetId });
    for (const error of res.errors || []) {
      if (!error.pluginId) this.health.recordInjection(error);
    }
    this.getHostHealth();
    await this.injector.refreshHealthProbes?.(res.discovery?.targets || []);
    this.getHostHealth();
    if (!this.options.origin && opts.lockOrigin === true && Array.isArray(res.results) && res.results.length > 0) {
      for (const r of res.results) {
        try {
          const u = new URL(r.url);
          if (u.origin && /^https:\/\/127\.0\.0\.1:\d+$/.test(u.origin)) {
            this.bridge.setOrigin(u.origin);
            break;
          }
        } catch {}
      }
    }
    if (Array.isArray(res.errors) && res.errors.length > 0) {
      await this.syncPluginMetaToSessions();
    }
    return res;
  }

  async _activateSortedLoadables(sorted, opts = {}) {
    const retryTransient = opts.retryTransient !== false;
    const activated = [];
    const pass1Failures = [];

    for (const item of sorted) {
      try {
        await this.activatePlugin(item.record, { skipFailureRecord: retryTransient });
        activated.push(item.manifest.id);
      } catch (err) {
        const diag = classifyPluginError(err, 'activate');
        pass1Failures.push({ item, err, diag });
      }
    }

    const failed = [];
    if (!retryTransient) {
      for (const f of pass1Failures) {
        failed.push({ id: f.item.manifest.id, error: f.err?.message || String(f.err), code: f.diag.code });
      }
      return { activated, failed };
    }

    const retryList = [];
    for (const f of pass1Failures) {
      if (PERMANENT_ACTIVATION_ERROR_CODES.has(f.diag.code)) {
        this.recordPluginFailure(f.item.manifest.id, f.err, 'activate');
        failed.push({ id: f.item.manifest.id, error: f.err?.message || String(f.err), code: f.diag.code });
      } else {
        retryList.push(f);
      }
    }

    if (retryList.length > 0) {
      const delayMs = Number.isFinite(Number(opts.retryDelayMs))
        ? Math.max(0, Number(opts.retryDelayMs))
        : (isTestMode() ? 20 : 250);
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      for (const f of retryList) {
        this.clearPluginRequireCache(f.item.record.installPath);
        try {
          await this.activatePlugin(f.item.record);
          activated.push(f.item.manifest.id);
        } catch (err2) {
          const diag2 = classifyPluginError(err2, 'activate');
          failed.push({ id: f.item.manifest.id, error: err2?.message || String(err2), code: diag2.code });
        }
      }
    }

    return { activated, failed };
  }

  async activatePluginById(pluginId, opts = {}) {
    const existing = this.activePlugins.get(pluginId);
    const indexRec = readInstalledIndex(this.options).plugins?.[pluginId];
    const optRec = Array.isArray(this.options.plugins)
      ? this.options.plugins.find((p) => p && p.id === pluginId)
      : null;
    let record = indexRec || existing?.record || optRec;
    if (!record) {
      throw new Error(`PLUGIN_NOT_FOUND: ${pluginId}`);
    }

    if (record.enabled === false && opts.enableIfDisabled !== false && indexRec) {
      record = enablePlugin(pluginId, this.options);
    }

    const circuitReset = opts.resetCircuit !== false;
    if (circuitReset) {
      this.resetPluginCircuit(pluginId);
    }

    await this.deactivatePlugin(pluginId);

    if (!record.installPath || !fs.existsSync(record.installPath)) {
      const { diag } = this.recordMissingInstallDiagnostic(record, pluginId);
      this.updateLiveSessionFile();
      await this.injector.reloadPlugin(pluginId, null);
      await this.syncPluginMetaToSessions();
      return {
        ok: false,
        pluginId,
        active: false,
        circuitReset,
        error: diag.message,
        health: this.getPluginHealth(pluginId)
      };
    }

    let entry = null;
    try {
      this.clearPluginRequireCache(record.installPath);
      const manifest = readManifestFromDir(record.installPath);
      entry = await this.activatePlugin(record);
    } catch (err) {
      if (!this.pluginErrors.has(pluginId)) {
        this.recordPluginDiagnostic(pluginId, err, 'load');
      }
      this.updateLiveSessionFile();
      await this.injector.reloadPlugin(pluginId, null);
      await this.syncPluginMetaToSessions();
      return {
        ok: false,
        pluginId,
        active: false,
        circuitReset,
        error: err?.message || String(err),
        health: this.getPluginHealth(pluginId)
      };
    }

    this.updateLiveSessionFile();
    const injectorRes = await this.injector.reloadPlugin(pluginId, entry);
    if (Array.isArray(injectorRes?.errors) && injectorRes.errors.length > 0) {
      this.recordPluginDiagnostic(pluginId, new Error(injectorRes.errors[0].error || 'Renderer inject failed'), 'renderer');
    }
    await this.syncPluginMetaToSessions();
    return {
      ok: injectorRes.ok !== false,
      pluginId,
      active: true,
      circuitReset,
      injector: injectorRes,
      health: this.getPluginHealth(pluginId),
      ...(injectorRes?.errors?.length ? { error: injectorRes.errors[0].error } : {})
    };
  }

  async ensureEnabledPluginsActivated(opts = {}) {
    if (this._activatingInactivePromise) {
      return this._activatingInactivePromise;
    }

    const run = (async () => {
      const rawRecords = Array.isArray(this.options.plugins)
        ? this.options.plugins
        : Object.values(readInstalledIndex(this.options).plugins || {});
      const inactiveEnabled = rawRecords.filter((rec) => rec && rec.id && rec.enabled !== false && !this.activePlugins.has(rec.id));
      if (inactiveEnabled.length === 0) {
        return { ok: true, attempted: 0, activated: [], failed: [] };
      }

      if (opts.resetCircuit === true) {
        for (const rec of inactiveEnabled) {
          this.resetPluginCircuit(rec.id);
        }
      }

      const loadable = [];
      const preloadFailed = [];
      for (const rec of inactiveEnabled) {
        if (!rec.installPath || !fs.existsSync(rec.installPath)) {
          const { diag } = this.recordMissingInstallDiagnostic(rec, rec.id);
          preloadFailed.push({ id: rec.id, error: diag.message, code: 'INSTALL_PATH_MISSING' });
          continue;
        }
        try {
          this.clearPluginRequireCache(rec.installPath);
          const manifest = readManifestFromDir(rec.installPath);
          loadable.push({ record: rec, manifest });
        } catch (err) {
          const manErr = new Error(err?.message || String(err));
          manErr.code = 'MANIFEST_INVALID';
          this.recordPluginDiagnostic(rec.id, manErr, 'load');
          preloadFailed.push({ id: rec.id, error: manErr.message, code: 'MANIFEST_INVALID' });
        }
      }

      const sorted = sortPluginsByDependency(loadable);
      const { activated, failed: actFailed } = await this._activateSortedLoadables(sorted, {
        retryTransient: opts.retryTransient !== false,
        retryDelayMs: opts.retryDelayMs
      });
      const failed = [...preloadFailed, ...actFailed];

      if (activated.length > 0) {
        this.updateLiveSessionFile();
        if (opts.injectSessions === true && this.injector) {
          for (const id of activated) {
            const entry = this.activePlugins.get(id);
            if (entry) {
              await this.injector.reloadPlugin(id, entry).catch((err) => {
                this.recordPluginDiagnostic(id, err, 'renderer');
              });
            }
          }
        }
      }

      if (this.injector?.sessions?.size > 0) {
        await this.syncPluginMetaToSessions();
      }

      return {
        ok: failed.length === 0,
        attempted: inactiveEnabled.length,
        activated,
        failed
      };
    })();

    this._activatingInactivePromise = run;
    try {
      return await run;
    } finally {
      if (this._activatingInactivePromise === run) {
        this._activatingInactivePromise = null;
      }
    }
  }

  async reloadPlugin(pluginId, opts = {}) {
    const existing = this.activePlugins.get(pluginId);
    const indexRec = readInstalledIndex(this.options).plugins?.[pluginId];
    const optRec = Array.isArray(this.options.plugins)
      ? this.options.plugins.find((p) => p && p.id === pluginId)
      : null;
    const record = indexRec || existing?.record || optRec;
    if (!record) {
      throw new Error(`PLUGIN_NOT_FOUND: ${pluginId}`);
    }

    const circuitReset = Boolean(opts && opts.resetCircuit);
    if (circuitReset) {
      this.resetPluginCircuit(pluginId);
    }

    await this.deactivatePlugin(pluginId);

    let entry = null;
    if (record.enabled !== false && record.installPath && fs.existsSync(record.installPath)) {
      try {
        const realInstallRoot = fs.realpathSync(record.installPath);
        const prefix = realInstallRoot.endsWith(path.sep) ? realInstallRoot : `${realInstallRoot}${path.sep}`;
        for (const cachedKey of Object.keys(require.cache)) {
          if (cachedKey === realInstallRoot || cachedKey.startsWith(prefix)) {
            delete require.cache[cachedKey];
          }
        }
      } catch {}
      const manifest = readManifestFromDir(record.installPath);
      if (manifest.main) {
        try {
          const mainResolved = require.resolve(path.resolve(record.installPath, manifest.main));
          delete require.cache[mainResolved];
        } catch {}
      }
      entry = await this.activatePlugin(record);
    }

    const injectorRes = await this.injector.reloadPlugin(pluginId, entry);
    return {
      ok: injectorRes.ok !== false,
      pluginId,
      active: Boolean(entry),
      circuitReset,
      injector: injectorRes
    };
  }

  async reloadAll(opts = {}) {
    const rendererBuild = opts.rebuildRenderer !== false
      ? tryRebuildHostRenderer(this.injector?.hostBundlePath)
      : { attempted: false, rebuilt: false };

    if (opts.resetCircuit) {
      for (const id of new Set([...this.activePlugins.keys(), ...this.crashTracker.keys(), ...this.pluginErrors.keys()])) {
        this.resetPluginCircuit(id);
      }
    }

    const records = Array.isArray(this.options.plugins)
      ? this.options.plugins.filter((p) => p && p.enabled !== false)
      : Object.values(readInstalledIndex(this.options).plugins || {}).filter((p) => p && p.enabled !== false);

    const enabledIds = new Set(records.map((r) => r.id).filter(Boolean));
    for (const errId of Array.from(this.pluginErrors.keys())) {
      if (!enabledIds.has(errId)) {
        this.pluginErrors.delete(errId);
      }
    }

    for (const pluginId of Array.from(this.activePlugins.keys()).reverse()) {
      await this.deactivatePlugin(pluginId);
    }

    const loadable = [];
    const activationErrors = [];
    for (const rec of records) {
      if (!rec.installPath || !fs.existsSync(rec.installPath)) {
        const { pid, diag } = this.recordMissingInstallDiagnostic(rec);
        activationErrors.push({ id: pid, error: diag.message });
        continue;
      }
      this.clearPluginRequireCache(rec.installPath);
      try {
        const manifest = readManifestFromDir(rec.installPath);
        loadable.push({ record: rec, manifest });
      } catch (err) {
        const pid = rec.id || path.basename(rec.installPath);
        const manErr = new Error(err?.message || String(err));
        manErr.code = 'MANIFEST_INVALID';
        this.recordPluginDiagnostic(pid, manErr, 'load');
        activationErrors.push({ id: pid, error: manErr.message });
      }
    }

    const sorted = sortPluginsByDependency(loadable);
    const reloadedPlugins = [];
    for (const item of sorted) {
      if (this.sessionProxyFallback && this.sessionProxyFallback.pluginId === item.manifest.id) {
        await this.stopSessionProxyFallback();
      }
      try {
        await this.activatePlugin(item.record);
        reloadedPlugins.push(item.manifest.id);
      } catch (err) {
        activationErrors.push({ id: item.manifest.id, error: err?.message || String(err) });
      }
    }

    this.updateLiveSessionFile();

    let restoreView = null;
    if (opts.restoreView && typeof opts.restoreView === 'object') {
      const toast = activationErrors.length === 0
        ? {
            tone: 'info',
            text: `已重新载入最新代码（${reloadedPlugins.length} 个插件${rendererBuild.rebuilt ? ' · 渲染层已重建' : ''}）`
          }
        : {
            tone: 'warn',
            text: `已重载 ${reloadedPlugins.length} 个插件，${activationErrors.length} 个加载失败`
          };
      restoreView = {
        ...opts.restoreView,
        open: opts.restoreView.open !== false,
        toast
      };
    }

    const injectorRes = await this.injector.reloadAllSessions(
      Array.from(this.activePlugins.values()),
      { restoreView }
    );

    return {
      ok: activationErrors.length === 0 && injectorRes.ok !== false,
      rendererRebuilt: Boolean(rendererBuild.rebuilt),
      reloadedCount: reloadedPlugins.length,
      reloadedPlugins,
      activationErrors,
      injector: injectorRes
    };
  }

  async requestDaemonRestart(opts = {}) {
    const rendererBuild = opts.rebuildRenderer !== false
      ? tryRebuildHostRenderer(this.injector?.hostBundlePath)
      : { attempted: false, rebuilt: false };
    const delayMs = Number.isFinite(Number(opts.delayMs)) ? Math.max(0, Number(opts.delayMs)) : 120;

    if (typeof this.options.onRestartDaemon === 'function') {
      setTimeout(() => {
        Promise.resolve(this.options.onRestartDaemon({ daemon: this, reason: opts.reason || 'ui' })).catch(() => {});
      }, delayMs);
      return {
        ok: true,
        scheduled: true,
        mode: 'callback',
        pid: process.pid,
        rendererRebuilt: Boolean(rendererBuild.rebuilt)
      };
    }

    if (isTestMode()) {
      return {
        ok: true,
        scheduled: false,
        dryRun: true,
        mode: 'test',
        pid: process.pid,
        rendererRebuilt: Boolean(rendererBuild.rebuilt)
      };
    }

    if (process.env.AGY_DADDY_LAUNCHD === '1') {
      setTimeout(async () => {
        try { await this.stop(); } catch {}
        process.exit(75);
      }, delayMs);
      return {
        ok: true,
        scheduled: true,
        mode: 'launchd',
        pid: process.pid,
        rendererRebuilt: Boolean(rendererBuild.rebuilt)
      };
    }

    const cliPath = path.resolve(__dirname, '..', 'cli.js');
    setTimeout(() => {
      try {
        const child = spawn(process.execPath, [cliPath, 'live', '--replace'], {
          detached: true,
          stdio: 'ignore',
          env: isolateResidentEnv({ ...process.env })
        });
        child.unref();
      } catch {}
    }, delayMs);
    return {
      ok: true,
      scheduled: true,
      mode: 'spawn',
      pid: process.pid,
      rendererRebuilt: Boolean(rendererBuild.rebuilt)
    };
  }

  async collectHostLaunchSpec(appPath = '/Applications/Antigravity.app') {
    const args = ['--remote-debugging-port=0'];
    const env = {};
    const argHooks = await this.bus.runHooks('hostLaunchArgs', { appPath });
    for (const h of argHooks) {
      if (Array.isArray(h.result)) args.push(...h.result);
    }
    const envHooks = await this.bus.runHooks('hostLaunchEnv', { appPath });
    for (const h of envHooks) {
      if (h.result && typeof h.result === 'object') Object.assign(env, h.result);
    }
    const envArgs = [];
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined && v !== null) envArgs.push('--env', `${k}=${String(v)}`);
    }
    this.lastHostLaunchUsedProxy = args.some((a) => String(a).startsWith('--proxy-server='));
    this.lastHostLaunchProxyPort = parseProxyPortFromCommand(args.join(' '));
    return {
      args,
      env,
      macOpenArgs: [...envArgs, '-a', appPath, '--args', ...args]
    };
  }

  async start() {
    if (this.running) return { port: this.bridge.port, hostToken: this.bridge.hostToken };
    acquireDaemonLock(this.lockPath);
    this.lockAcquired = true;
    this.running = true;
    this.health.reset({ pid: process.pid, startedAt: this.health.now() });

    try {
      const host = (this.options.inspectHostProcess || inspectAntigravityHostProcess)(this.options);
      if (host) this.health.observe(host);
      this.registerDefaultHostRoutes();
      const bridgeInfo = await this.bridge.start(0);

      const records = Array.isArray(this.options.plugins)
        ? this.options.plugins.filter((p) => p && p.enabled !== false)
        : Object.values(readInstalledIndex(this.options).plugins || {}).filter((p) => p && p.enabled !== false);

      const loadable = [];
      const preloadErrors = [];
      for (const rec of records) {
        if (!rec.installPath || !fs.existsSync(rec.installPath)) {
          const { pid, diag } = this.recordMissingInstallDiagnostic(rec);
          preloadErrors.push({ id: pid, error: diag.message });
          continue;
        }
        try {
          const manifest = readManifestFromDir(rec.installPath);
          loadable.push({ record: rec, manifest });
        } catch (err) {
          const pid = rec.id || path.basename(rec.installPath);
          const manErr = new Error(err?.message || String(err));
          manErr.code = 'MANIFEST_INVALID';
          this.recordPluginDiagnostic(pid, manErr, 'load');
          preloadErrors.push({ id: pid, error: manErr.message });
        }
      }

      const sorted = sortPluginsByDependency(loadable);
      const { failed: actFailed } = await this._activateSortedLoadables(sorted, {
        retryTransient: this.options.retryTransientOnStart !== false,
        retryDelayMs: this.options.startRetryDelayMs
      });
      const activationErrors = [
        ...preloadErrors,
        ...actFailed.map((f) => ({ id: f.id, error: f.error }))
      ];

      if (host?.running && hasProxyServerArg(host.command)) {
        const runningProxyPort = parseProxyPortFromCommand(host.command);
        const launchSpec = await this.collectHostLaunchSpec().catch(() => ({ args: [] }));
        const hasActiveProxyHook = Array.isArray(launchSpec.args) && launchSpec.args.some((a) => String(a).startsWith('--proxy-server='));
        if (runningProxyPort && !hasActiveProxyHook) {
          try {
            await this.startSessionProxyFallback({
              pluginId: 'agy-daddy.proxy',
              port: runningProxyPort,
              reason: 'host_running_with_proxy_plugin_disabled'
            });
          } catch {}
        }
      }

      safeWriteJsonSync(path.join(this.stateDir, '.live-session.json'), {
        port: bridgeInfo.port,
        pid: process.pid,
        startedAt: Date.now(),
        activePlugins: Array.from(this.activePlugins.keys())
      });

      return { ...bridgeInfo, activationErrors };
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop() {
    this.running = false;
    this.health.reset();
    try {
      await this.injector.disposeAll();
    } catch {}
    await this.stopSessionProxyFallback();
    for (const pluginId of Array.from(this.activePlugins.keys()).reverse()) {
      await this.deactivatePlugin(pluginId);
    }
    try { await this.overlayManager.dispose(); } catch {}
    await this.bridge.stop();
    for (const w of Array.from(this._liveWorkers)) {
      w._intentionalStop = true;
      try { w.kill('SIGKILL'); } catch {}
    }
    this._liveWorkers.clear();
    try {
      const livePath = path.join(this.stateDir, '.live-session.json');
      if (fs.existsSync(livePath)) {
        const d = safeReadJsonSync(livePath, null, { quarantineCorrupt: false }).data;
        if (d && Number(d.pid) === process.pid) fs.unlinkSync(livePath);
      }
    } catch {}
    if (this.lockAcquired) {
      releaseDaemonLock(this.lockPath);
      this.lockAcquired = false;
    }
  }
}

module.exports = {
  DEFAULT_HOST_SETTINGS,
  HOST_CONTROL_ROUTE_ALLOWLIST,
  normalizeHostSettings,
  createScopedHostControl,
  isPidAlive,
  acquireDaemonLock,
  releaseDaemonLock,
  AgyDaddyDaemon
};
