'use strict';

const fs = require('fs');
const path = require('path');
const { fork, spawn } = require('child_process');
const { getStateDir, getPluginsDir, assertSafePluginId, getHostSettingsPath, isTestMode } = require('./paths');
const { PluginDataStore, safeReadJsonSync, safeWriteJsonSync, withFileLockSync } = require('./storage');
const { FourRealmBus } = require('./bus');
const { DynamicBridgeServer } = require('./bridge');
const { createRpcTransport, createScopedRpcClient } = require('./rpc');
const { loadAnchorsRegistry } = require('./anchors');
const { CdpInjector, DEFAULT_HOST_BUNDLE_PATH } = require('./injector');
const {
  readInstalledIndex,
  readManifestFromDir,
  sortPluginsByDependency,
  installPlugin,
  enablePlugin,
  disablePlugin,
  uninstallPlugin,
  rollbackPlugin,
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
const { runDoctor, exportDiagnosticBundle } = require('./doctor');
const { MarketplaceStatsService } = require('./marketplace-stats');

const WORKER_SCRIPT = path.resolve(__dirname, 'plugin-worker.js');

const HOST_CONTROL_ROUTE_ALLOWLIST = Object.freeze([
  '/host/health',
  '/host/plugins',
  '/host/plugins/toggle',
  '/host/plugins/install',
  '/host/plugins/uninstall',
  '/host/plugins/rollback',
  '/host/reload',
  '/host/reload-all',
  '/host/anchors',
  '/host/bus/call',
  '/host/settings',
  '/host/host-settings',
  '/host/commands/run',
  '/host/marketplace/stats',
  '/host/diagnostics/export'
]);

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
  autoSyncNativeOnInstall: true
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

  return {
    themeMode,
    heatPreset,
    customColors,
    topbarPins,
    topbarOrder,
    maxVisibleUnits,
    showTopbarEntry,
    injectNativeSettings,
    autoSyncNativeOnInstall
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

class AgyDaddyDaemon {
  constructor(options = {}) {
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
      getPluginSettings: (pluginId) => this.getPluginSettings(pluginId)
    });
    this.activePlugins = new Map(); // pluginId -> record
    this.commands = new Map();      // commandId -> { pluginId, commandId, handler }
    this.settingsListeners = new Map(); // pluginId -> Set<fn>
    this.crashTracker = new Map();  // pluginId -> number[] timestamps
    this.crashWindowMs = Number(options.crashWindowMs) > 0 ? Number(options.crashWindowMs) : 60000;
    this.maxCrashes = Number(options.maxCrashes) > 0 ? Number(options.maxCrashes) : 3;
    this.running = false;
    this.lockAcquired = false;
  }

  getHostSettings() {
    const filePath = getHostSettingsPath({ stateDir: this.stateDir });
    const res = safeReadJsonSync(filePath, null, { quarantineCorrupt: true });
    return normalizeHostSettings(res.data || {}, DEFAULT_HOST_SETTINGS);
  }

  saveHostSettings(patch = {}) {
    const filePath = getHostSettingsPath({ stateDir: this.stateDir });
    const current = this.getHostSettings();
    const next = normalizeHostSettings(patch, current);
    const wr = withFileLockSync(filePath, () => safeWriteJsonSync(filePath, next));
    if (!wr.ok) {
      return { ok: false, error: wr.error || 'Failed to save host settings', values: current };
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

  recordPluginFailure(pluginId, err) {
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
    return {
      active: Boolean(active),
      crashesInWindow: list.length,
      circuitOpen: list.length >= this.maxCrashes,
      nodeIsolation: active?.trustPolicy?.nodeIsolation || null,
      lastError: active?.lastError || null
    };
  }

  buildInProcessHostApi(pluginId, manifest, trustPolicy, record = null) {
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
      }
    };
  }

  async spawnWorkerPlugin(pluginId, pluginDir, manifest, trustPolicy, bridgeTokenOverride = null) {
    const bridgeToken = bridgeTokenOverride || this.bridge.issuePluginToken(pluginId);
    const worker = fork(WORKER_SCRIPT, [], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, AGY_DADDY_WORKER: '1', AGY_DADDY_PLUGIN_ID: pluginId }
    });

    const pendingBridge = new Map();
    const pendingService = new Map();
    const pendingCommand = new Map();
    let seq = 0;

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
      if (msg.type === 'ipc-call') {
        const reply = (result, error = null) => {
          if (worker.connected) {
            worker.send({ type: 'ipc-reply', id: msg.id, result, error });
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
            reply(await rpc.call(payload.method, payload.body, { timeoutMs: payload.timeoutMs }));
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
          } else {
            throw new Error(`Unknown worker IPC action: ${action}`);
          }
        } catch (err) {
          reply(null, err?.message || String(err));
        }
      }
    });

    const settingsSchema = this.loadPluginSettingsSchema(pluginId, manifest, pluginDir);
    const settingsValues = this.getPluginSettings(pluginId, { manifest, installPath: pluginDir, schema: settingsSchema });

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

    worker.on('exit', (code, signal) => {
      for (const [, p] of pendingBridge) { clearTimeout(p.timer); p.reject(new Error('Worker exited')); }
      for (const [, p] of pendingService) { clearTimeout(p.timer); p.reject(new Error('Worker exited')); }
      for (const [, p] of pendingCommand) { clearTimeout(p.timer); p.reject(new Error('Worker exited')); }
      pendingBridge.clear();
      pendingService.clear();
      pendingCommand.clear();
      if (this.running && !worker._intentionalStop) {
        this.recordPluginFailure(pluginId, new Error(`Worker crashed (code=${code}, signal=${signal})`));
        this.bus.disposePlugin(pluginId);
        this.bridge.unregisterPluginRoutes(pluginId);
        this.unregisterPluginCommands(pluginId);
        this.settingsListeners.delete(pluginId);
        this.activePlugins.delete(pluginId);
      }
    });

    return { worker };
  }

  async activatePlugin(record) {
    const manifest = readManifestFromDir(record.installPath);
    const trustPolicy = evaluateTrustPolicy(manifest, record.trustLevel || 'T2', record.grantedPermissions || []);
    if (!trustPolicy.allowed) {
      throw new Error(`Permission denied for ${manifest.id}: ${trustPolicy.denied.join(', ')}`);
    }

    const health = this.getPluginHealth(manifest.id);
    if (health.circuitOpen) {
      throw new Error(`CIRCUIT_OPEN: ${manifest.id} disabled after ${this.maxCrashes} crashes`);
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
      this.recordPluginFailure(manifest.id, err);
      this.bus.disposePlugin(manifest.id);
      this.bridge.unregisterPluginRoutes(manifest.id);
      this.unregisterPluginCommands(manifest.id);
      this.settingsListeners.delete(manifest.id);
      throw err;
    }
  }

  async deactivatePlugin(pluginId) {
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
            displayName: this.pickLocaleText(manifest.displayName, manifest.id),
            description: this.pickLocaleText(manifest.description, ''),
            version: manifest.version,
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
          displayName: entry.name || entry.id,
          description: entry.description || '',
          version: entry.version || '1.0.0',
          trustLevel: entry.trustLevel || 'T0',
          hasNative: false,
          permissions: [],
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
        settingsSchema,
        settingsValues: redacted.values,
        settingsSecretState: redacted.secretState,
        commands: Array.isArray(manifest?.contributes?.commands) ? manifest.contributes.commands : [],
        topbarUnits: Array.isArray(manifest?.contributes?.['topbar.units']) ? manifest.contributes['topbar.units'] : [],
        health: this.getPluginHealth(rec.id)
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
        settingsSchema,
        settingsValues: redacted.values,
        settingsSecretState: redacted.secretState,
        commands: Array.isArray(entry.manifest?.contributes?.commands) ? entry.manifest.contributes.commands : [],
        topbarUnits: Array.isArray(entry.manifest?.contributes?.['topbar.units']) ? entry.manifest.contributes['topbar.units'] : [],
        health: this.getPluginHealth(id)
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
    return { ok: true, plugins: items, catalog, marketStats };
  }

  registerDefaultHostRoutes() {
    this.bridge.registerHostRoute('/host/health', async () => {
      return await runDoctor({ ...this.options, skipCdp: true });
    });
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
      const updatedRec = nextEnabled
        ? enablePlugin(pluginId, this.options)
        : disablePlugin(pluginId, this.options);
      const reload = await this.reloadPlugin(pluginId);
      return { ok: true, plugin: updatedRec, reload, ...this.buildPluginManagePayload() };
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
      const reload = await this.reloadPlugin(res.plugin.id);
      return {
        ok: true,
        plugin: res.plugin,
        nativeSync: res.nativeSync,
        reload,
        ...this.buildPluginManagePayload()
      };
    });
    this.bridge.registerHostRoute('/host/plugins/uninstall', async (body) => {
      const pluginId = String(body?.pluginId || '').trim();
      if (!pluginId) throw new Error('pluginId is required');
      const idx = readInstalledIndex(this.options);
      const rec = idx.plugins?.[pluginId];
      if (rec) {
        let manifest = this.activePlugins.get(pluginId)?.manifest || null;
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
      await this.deactivatePlugin(pluginId);
      await this.injector.reloadPlugin(pluginId, null);
      const rmRes = uninstallPlugin(pluginId, {
        ...this.options,
        confirmNativeDelete: Boolean(body?.confirmNativeDelete)
      });
      return { ...rmRes, ...this.buildPluginManagePayload() };
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
        return this.saveHostSettings(body?.values || body?.patch || {});
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
        ...(hasLiveCdp ? { cdpSnapshot } : {})
      });
      return {
        ok: Boolean(exp.ok),
        path: exp.path || outPath,
        report: exp.report || exp.bundle
      };
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
    const res = await this.injector.injectAllActiveTargets(Array.from(this.activePlugins.values()), opts);
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
    return res;
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
      for (const id of new Set([...this.activePlugins.keys(), ...this.crashTracker.keys()])) {
        this.resetPluginCircuit(id);
      }
    }

    const records = Array.isArray(this.options.plugins)
      ? this.options.plugins.filter((p) => p && p.enabled !== false)
      : Object.values(readInstalledIndex(this.options).plugins || {}).filter((p) => p && p.enabled !== false);

    for (const pluginId of Array.from(this.activePlugins.keys()).reverse()) {
      await this.deactivatePlugin(pluginId);
    }

    const loadable = [];
    const activationErrors = [];
    for (const rec of records) {
      if (!rec.installPath || !fs.existsSync(rec.installPath)) continue;
      try {
        const realInstallRoot = fs.realpathSync(rec.installPath);
        const prefix = realInstallRoot.endsWith(path.sep) ? realInstallRoot : `${realInstallRoot}${path.sep}`;
        for (const cachedKey of Object.keys(require.cache)) {
          if (cachedKey === realInstallRoot || cachedKey.startsWith(prefix)) {
            delete require.cache[cachedKey];
          }
        }
      } catch {}
      try {
        const manifest = readManifestFromDir(rec.installPath);
        if (manifest.main) {
          try {
            const mainResolved = require.resolve(path.resolve(rec.installPath, manifest.main));
            delete require.cache[mainResolved];
          } catch {}
        }
        loadable.push({ record: rec, manifest });
      } catch (err) {
        activationErrors.push({ id: rec.id || path.basename(rec.installPath), error: err?.message || String(err) });
      }
    }

    const sorted = sortPluginsByDependency(loadable);
    const reloadedPlugins = [];
    for (const item of sorted) {
      try {
        await this.activatePlugin(item.record);
        reloadedPlugins.push(item.manifest.id);
      } catch (err) {
        activationErrors.push({ id: item.manifest.id, error: err?.message || String(err) });
      }
    }

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
          env: { ...process.env }
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

    try {
      this.registerDefaultHostRoutes();
      const bridgeInfo = await this.bridge.start(0);

      const records = Array.isArray(this.options.plugins)
        ? this.options.plugins
        : Object.values(readInstalledIndex(this.options).plugins || {}).filter((p) => p && p.enabled !== false);

      const loadable = [];
      for (const rec of records) {
        try {
          if (!rec.installPath || !fs.existsSync(rec.installPath)) continue;
          const manifest = readManifestFromDir(rec.installPath);
          loadable.push({ record: rec, manifest });
        } catch {}
      }

      const sorted = sortPluginsByDependency(loadable);
      const activationErrors = [];
      for (const item of sorted) {
        try {
          await this.activatePlugin(item.record);
        } catch (err) {
          activationErrors.push({ id: item.manifest.id, error: err?.message || String(err) });
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
    try {
      await this.injector.disposeAll();
    } catch {}
    for (const pluginId of Array.from(this.activePlugins.keys()).reverse()) {
      await this.deactivatePlugin(pluginId);
    }
    await this.bridge.stop();
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
