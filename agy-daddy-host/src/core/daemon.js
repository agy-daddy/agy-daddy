'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { getStateDir, getPluginsDir } = require('./paths');
const { PluginDataStore, safeReadJsonSync, safeWriteJsonSync } = require('./storage');
const { FourRealmBus } = require('./bus');
const { DynamicBridgeServer } = require('./bridge');
const { createRpcTransport, createScopedRpcClient } = require('./rpc');
const { loadAnchorsRegistry } = require('./anchors');
const { CdpInjector } = require('./injector');
const {
  readInstalledIndex,
  readManifestFromDir,
  sortPluginsByDependency,
  installPlugin,
  enablePlugin,
  disablePlugin,
  uninstallPlugin,
  rollbackPlugin,
  listInstalledPlugins,
  loadRegistry
} = require('./installer');
const { evaluateTrustPolicy, validateSettingsValues } = require('../contracts/manifest-validator');
const { createScopedNetFetch } = require('./plugin-worker');
const { runDoctor } = require('./doctor');

const WORKER_SCRIPT = path.resolve(__dirname, 'plugin-worker.js');

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
      reinjectDebounceMs: options.reinjectDebounceMs
    });
    this.activePlugins = new Map(); // pluginId -> record
    this.crashTracker = new Map();  // pluginId -> number[] timestamps
    this.crashWindowMs = Number(options.crashWindowMs) > 0 ? Number(options.crashWindowMs) : 60000;
    this.maxCrashes = Number(options.maxCrashes) > 0 ? Number(options.maxCrashes) : 3;
    this.running = false;
    this.lockAcquired = false;
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

  buildInProcessHostApi(pluginId, manifest, trustPolicy) {
    const store = new PluginDataStore(pluginId, this.options);
    const perms = trustPolicy.granted || [];
    const daemon = this;
    const rpcClient = createScopedRpcClient(pluginId, perms, this.rpcTransport);

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
        on: (topic, fn) => daemon.bus.onEvent(pluginId, topic, fn)
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
      settings: {
        get() {
          return store.readJson('settings.json', {}).data || {};
        },
        save(values, schema = null) {
          let toSave = values;
          if (schema) {
            const res = validateSettingsValues(schema, values);
            if (!res.ok) throw new Error(res.errors.join('; '));
            toSave = res.values;
          }
          return store.writeJson('settings.json', toSave);
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
            this.bridge.registerPluginRoute(pluginId, payload.subPath, (body) => {
              const reqId = ++seq;
              return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                  pendingBridge.delete(reqId);
                  reject(new Error('Worker route timeout'));
                }, 8000);
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
            reply(await rpc.call(payload.method, payload.body));
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
          } else {
            throw new Error(`Unknown worker IPC action: ${action}`);
          }
        } catch (err) {
          reply(null, err?.message || String(err));
        }
      }
    });

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
        mainPath: manifest.main,
        grantedPermissions: trustPolicy.granted,
        stateDir: this.stateDir,
        bridgePort: this.bridge.port,
        pluginToken: bridgeToken
      });
    });

    worker.on('exit', (code, signal) => {
      for (const [, p] of pendingBridge) { clearTimeout(p.timer); p.reject(new Error('Worker exited')); }
      for (const [, p] of pendingService) { clearTimeout(p.timer); p.reject(new Error('Worker exited')); }
      pendingBridge.clear();
      pendingService.clear();
      if (this.running && !worker._intentionalStop) {
        this.recordPluginFailure(pluginId, new Error(`Worker crashed (code=${code}, signal=${signal})`));
        this.bus.disposePlugin(pluginId);
        this.bridge.unregisterPluginRoutes(pluginId);
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
          const hostApi = this.buildInProcessHostApi(manifest.id, manifest, trustPolicy);
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
    return true;
  }

  pickLocaleText(val, fallback = '') {
    if (typeof val === 'string') return val;
    if (val && typeof val === 'object') {
      return String(val['zh-CN'] || val.en || Object.values(val)[0] || fallback);
    }
    return fallback;
  }

  listPluginCatalog(installedIds = new Set()) {
    const items = [];
    const seenIds = new Set(installedIds);
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
          items.push({
            id: manifest.id,
            displayName: this.pickLocaleText(manifest.displayName, manifest.id),
            description: this.pickLocaleText(manifest.description, ''),
            version: manifest.version,
            trustLevel: manifest.id.startsWith('agy-daddy.') ? 'T0' : 'T1',
            hasNative: Boolean(manifest.contributes?.native),
            permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
            recommendedSpec: `local:${pluginDir}`
          });
        } catch {}
      }
    }

    try {
      const reg = loadRegistry(this.options);
      for (const entry of Array.isArray(reg?.plugins) ? reg.plugins : []) {
        if (!entry?.id || entry.id === 'agy-daddy.legacy-suite' || seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
        items.push({
          id: entry.id,
          displayName: entry.name || entry.id,
          description: entry.description || '',
          version: entry.version || '1.0.0',
          trustLevel: entry.trustLevel || 'T0',
          hasNative: false,
          permissions: [],
          recommendedSpec: entry.shortName || entry.repo || entry.id
        });
      }
    } catch {}

    return items;
  }

  buildPluginManagePayload() {
    const installedList = listInstalledPlugins(this.options);
    const pluginsDir = getPluginsDir(this.options);
    const byId = new Map();

    for (const rec of installedList) {
      let manifest = this.activePlugins.get(rec.id)?.manifest || null;
      if (!manifest && rec.installPath && fs.existsSync(rec.installPath)) {
        try { manifest = readManifestFromDir(rec.installPath); } catch {}
      }
      const activeEntry = this.activePlugins.get(rec.id);
      const rollbackDir = path.join(pluginsDir, '.rollback', `${rec.id}.prev`);
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
        hasNative: Boolean(manifest?.contributes?.native),
        hasRollback: fs.existsSync(rollbackDir),
        permissions: Array.isArray(rec.grantedPermissions) ? rec.grantedPermissions : (manifest?.permissions || []),
        sourceKind: rec.sourceKind || 'local',
        sourceSpec: rec.sourceSpec || '',
        health: this.getPluginHealth(rec.id)
      });
    }

    for (const [id, entry] of this.activePlugins.entries()) {
      if (byId.has(id)) continue;
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
        hasRollback: false,
        permissions: Array.isArray(entry.trustPolicy?.granted) ? entry.trustPolicy.granted : [],
        sourceKind: entry.record?.sourceKind || 'memory',
        sourceSpec: entry.record?.sourceSpec || '',
        health: this.getPluginHealth(id)
      });
    }

    const items = Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
    const catalog = this.listPluginCatalog(new Set(byId.keys()));
    return { ok: true, plugins: items, catalog };
  }

  registerDefaultHostRoutes() {
    this.bridge.registerHostRoute('/host/health', async () => {
      return await runDoctor({ ...this.options, skipCdp: true });
    });
    this.bridge.registerHostRoute('/host/plugins', async () => {
      return this.buildPluginManagePayload();
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
      const installOpts = {
        ...this.options,
        copy: Boolean(body?.copy),
        grantedPermissions: Array.isArray(body?.grantedPermissions) ? body.grantedPermissions : []
      };
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
      await this.deactivatePlugin(pluginId);
      await this.injector.reloadPlugin(pluginId, null);
      const rmRes = uninstallPlugin(pluginId, this.options);
      return { ...rmRes, ...this.buildPluginManagePayload() };
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
      const reload = await this.reloadPlugin(String(body.pluginId));
      return { ...reload, ...this.buildPluginManagePayload() };
    });
    this.bridge.registerHostRoute('/host/anchors', async () => {
      return { ok: true, data: loadAnchorsRegistry({ stateDir: this.stateDir, anchorsPath: this.options.anchorsPath }) };
    });
    this.bridge.registerHostRoute('/host/bus/call', async (body) => {
      const { service, method, args = [], optional = true } = body || {};
      return await this.bus.callService(service, method, args, { optional, callerRealm: 'page-main' });
    });
    this.bridge.registerHostRoute('/host/settings', async (body) => {
      const { pluginId, action = 'get', values } = body || {};
      const store = new PluginDataStore(pluginId, this.options);
      if (action === 'save') {
        const active = this.activePlugins.get(pluginId);
        let toSave = values || {};
        const schemaRel = active?.manifest?.contributes?.settings?.schema;
        if (schemaRel && active?.record?.installPath) {
          const schemaPath = path.resolve(active.record.installPath, schemaRel);
          if (fs.existsSync(schemaPath)) {
            const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
            const checked = validateSettingsValues(schema, toSave);
            if (!checked.ok) return { ok: false, errors: checked.errors };
            toSave = checked.values;
          }
        }
        return store.writeJson('settings.json', toSave);
      }
      return { ok: true, values: store.readJson('settings.json', {}).data || {} };
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

  async reloadPlugin(pluginId) {
    const existing = this.activePlugins.get(pluginId);
    const indexRec = readInstalledIndex(this.options).plugins?.[pluginId];
    const record = indexRec || existing?.record;
    if (!record) {
      throw new Error(`PLUGIN_NOT_FOUND: ${pluginId}`);
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
      injector: injectorRes
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
  isPidAlive,
  acquireDaemonLock,
  releaseDaemonLock,
  AgyDaddyDaemon
};
