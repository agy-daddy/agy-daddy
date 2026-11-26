'use strict';

const path = require('path');
const { PluginDataStore } = require('./storage');
const { createWorkspaceOrgRuntime } = require('./workspace-org');

function matchOutboundDomain(hostname, permissions) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  for (const perm of permissions) {
    if (!perm.startsWith('net:outbound:')) continue;
    const rule = perm.slice('net:outbound:'.length).toLowerCase();
    if (rule === '*') return true;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1);
      if (host === rule.slice(2) || host.endsWith(suffix)) return true;
    } else if (host === rule) {
      return true;
    }
  }
  return false;
}

function createScopedNetFetch(pluginId, permissions, bus = null, fetchImpl = globalThis.fetch) {
  const perms = Array.isArray(permissions) ? permissions : [];
  return async function scopedFetch(urlStr, init = {}) {
    let parsed;
    try {
      parsed = new URL(String(urlStr));
    } catch {
      throw new Error(`Invalid URL: ${String(urlStr)}`);
    }
    if (!matchOutboundDomain(parsed.hostname, perms)) {
      throw new Error(`NET_PERMISSION_DENIED: ${pluginId} lacks net:outbound:${parsed.hostname}`);
    }
    if (typeof fetchImpl !== 'function') {
      throw new Error('fetch implementation unavailable');
    }
    if (bus && bus.hasService('proxy')) {
      try {
        const proxyRes = await bus.callService('proxy', 'getAgentOptions', [parsed.href], { optional: true });
        if (proxyRes?.value?.proxyUrl && !init.headers?.['x-agy-proxy-hint']) {
          // 透传代理配置供支持自定义 dispatcher 的环境使用
          init = { ...init, proxyUrl: proxyRes.value.proxyUrl };
        }
      } catch {}
    }
    return fetchImpl(parsed.href, init);
  };
}

if (require.main === module) {
  const routeHandlers = new Map();
  const serviceMethods = new Map();
  const commandHandlers = new Map();
  const trayHandlers = new Map();
  const overlayInteractionHandlers = new Map();
  const eventHandlers = new Map();
  const stateHandlers = new Map();
  const settingsListeners = new Set();
  const pendingRpc = new Map();
  let rpcSeq = 0;
  let pluginMod = null;
  let pluginId = '';
  let currentSettings = {};
  let hostProxyRef = null;

  function sendParent(msg) {
    if (typeof process.send === 'function') {
      process.send(msg);
    }
  }

  function callParent(action, payload, timeoutMs) {
    const id = ++rpcSeq;
    const defaultTimeout = action === 'rpcCall' ? 25000 : 8000;
    const limit = Number(timeoutMs) > 0 ? Math.min(60000, Math.max(1000, Number(timeoutMs))) : defaultTimeout;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRpc.delete(id);
        reject(new Error(`Worker IPC timeout: ${action}`));
      }, limit);
      pendingRpc.set(id, { resolve, reject, timer });
      sendParent({ type: 'ipc-call', id, action, payload });
    });
  }

  process.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ipc-reply') {
      const pending = pendingRpc.get(msg.id);
      if (!pending) return;
      pendingRpc.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const err = new Error(msg.error);
        if (msg.errorCode) err.code = msg.errorCode;
        pending.reject(err);
      } else pending.resolve(msg.result);
      return;
    }

    if (msg.type === 'bridge-invoke') {
      const handler = routeHandlers.get(msg.subPath);
      try {
        if (!handler) throw new Error(`Route not found in worker: ${msg.subPath}`);
        const result = await handler(msg.body, { pluginId, subPath: msg.subPath });
        sendParent({ type: 'bridge-reply', reqId: msg.reqId, result });
      } catch (err) {
        sendParent({ type: 'bridge-reply', reqId: msg.reqId, error: err?.message || String(err) });
      }
      return;
    }

    if (msg.type === 'service-invoke') {
      const methods = serviceMethods.get(msg.serviceName);
      try {
        const fn = methods?.[msg.method];
        if (typeof fn !== 'function') throw new Error(`Method not found: ${msg.serviceName}.${msg.method}`);
        const result = await fn(...(msg.args || []));
        sendParent({ type: 'service-reply', reqId: msg.reqId, result });
      } catch (err) {
        sendParent({ type: 'service-reply', reqId: msg.reqId, error: err?.message || String(err) });
      }
      return;
    }

    if (msg.type === 'command-invoke') {
      const fn = commandHandlers.get(msg.commandId);
      try {
        if (typeof fn !== 'function') throw new Error(`Command not found in worker: ${msg.commandId}`);
        const result = await fn(...(Array.isArray(msg.args) ? msg.args : []));
        sendParent({ type: 'command-reply', reqId: msg.reqId, result: result === undefined ? null : result });
      } catch (err) {
        sendParent({ type: 'command-reply', reqId: msg.reqId, error: err?.message || String(err) });
      }
      return;
    }

    if (msg.type === 'tray-click') {
      const fn = trayHandlers.get(msg.itemId);
      try {
        if (typeof fn !== 'function') throw new Error(`Tray handler not found in worker: ${msg.itemId}`);
        const ctx = {
          ...(msg.ctx || {}),
          update: (patch) => hostProxyRef?.tray?.updateMenuItem(msg.itemId, patch)
        };
        const result = await fn(ctx);
        sendParent({ type: 'tray-click-reply', reqId: msg.reqId, result: result === undefined ? null : result });
      } catch (err) {
        sendParent({ type: 'tray-click-reply', reqId: msg.reqId, error: err?.message || String(err) });
      }
      return;
    }

    if (msg.type === 'settings-changed') {
      currentSettings = msg.values && typeof msg.values === 'object' ? { ...msg.values } : {};
      const changedKeys = Array.isArray(msg.changedKeys) ? [...msg.changedKeys] : [];
      for (const fn of Array.from(settingsListeners)) {
        try { fn({ ...currentSettings }, changedKeys); } catch {}
      }
      return;
    }

    if (msg.type === 'event-deliver') {
      const set = eventHandlers.get(msg.topic);
      if (set) {
        for (const fn of set) {
          try { fn(msg.payload, msg.meta); } catch {}
        }
      }
      return;
    }

    if (msg.type === 'state-deliver') {
      const set = stateHandlers.get(msg.key);
      if (set) {
        for (const fn of set) {
          try { fn(msg.value, msg.meta); } catch {}
        }
      }
      return;
    }

    if (msg.type === 'overlay-interaction') {
      const set = overlayInteractionHandlers.get(msg.windowId);
      if (set) {
        for (const fn of Array.from(set)) {
          try { fn(msg.event); } catch {}
        }
      }
      return;
    }

    if (msg.type === 'init') {
      pluginId = msg.pluginId;
      currentSettings = msg.settingsValues && typeof msg.settingsValues === 'object'
        ? { ...msg.settingsValues }
        : {};
      if (!process.env.AGY_DADDY_HOST_DIR) {
        process.env.AGY_DADDY_HOST_DIR = path.resolve(__dirname, '..', '..');
      }
      const store = new PluginDataStore(pluginId, { stateDir: msg.stateDir });
      const workspaceOrg = createWorkspaceOrgRuntime();
      const perms = msg.grantedPermissions || [];
      const hostProxy = {
        pluginId,
        manifest: msg.manifest || null,
        permissions: [...perms],
        storage: store,
        workspaceOrg,
        bridge: {
          async registerRoute(subPath, handler, opts = {}) {
            const clean = subPath.startsWith('/') ? subPath : `/${subPath}`;
            routeHandlers.set(clean, handler);
            await callParent('registerRoute', { subPath: clean, timeoutMs: opts?.timeoutMs });
            return () => routeHandlers.delete(clean);
          }
        },
        rpc: {
          getOrigin: () => callParent('rpcGetOrigin', {}),
          call: (method, body, opts = {}) => callParent(
            'rpcCall',
            { method, body, timeoutMs: opts?.timeoutMs, retryOnTimeout: opts?.retryOnTimeout },
            opts?.timeoutMs
          )
        },
        services: {
          async provide(name, methods, opts = {}) {
            const mObj = methods?.methods || methods || {};
            serviceMethods.set(name, mObj);
            await callParent('provideService', {
              name,
              version: opts.version || methods?.version || '1.0.0',
              realm: 'node',
              methodNames: Object.keys(mObj)
            });
          },
          call: (name, method, args = [], opts = {}) => callParent('callService', { name, method, args, opts }),
          get: (name, opts = {}) => new Proxy({}, {
            get(_, prop) {
              if (prop === 'then') return undefined;
              return async (...args) => {
                const res = await callParent('callService', { name, method: String(prop), args, opts });
                return res && typeof res === 'object' && 'value' in res ? res.value : res;
              };
            }
          }),
          has: (name) => callParent('hasService', { name })
        },
        events: {
          emit: (topic, payload) => callParent('emitEvent', { topic, payload }),
          on: async (topic, fn) => {
            if (!eventHandlers.has(topic)) eventHandlers.set(topic, new Set());
            eventHandlers.get(topic).add(fn);
            await callParent('subscribeEvent', { topic });
            return () => eventHandlers.get(topic)?.delete(fn);
          }
        },
        state: {
          set: (key, value) => callParent('setState', { key, value }),
          get: (key) => callParent('getState', { key }),
          subscribe: async (key, fn) => {
            if (!stateHandlers.has(key)) stateHandlers.set(key, new Set());
            stateHandlers.get(key).add(fn);
            const current = await callParent('subscribeState', { key });
            if (current) {
              try { fn(current.value, { key, version: current.version, replay: true }); } catch {}
            }
            return () => stateHandlers.get(key)?.delete(fn);
          }
        },
        net: {
          fetch: createScopedNetFetch(pluginId, perms)
        },
        control: perms.includes('host:control')
          ? {
              invoke(routePath, body = {}) {
                const raw = String(routePath || '').trim();
                const normalized = raw.startsWith('/') ? raw : `/${raw}`;
                return callParent('hostControl', { routePath: normalized, body });
              }
            }
          : undefined,
        settings: {
          get() {
            return { ...currentSettings };
          },
          async update(patch) {
            const res = await callParent('updateSettings', { patch: patch || {} });
            if (res && res.values && typeof res.values === 'object') {
              currentSettings = { ...res.values };
            }
            return res;
          },
          async save(values) {
            const res = await callParent('updateSettings', { patch: values || {} });
            if (res && res.values && typeof res.values === 'object') {
              currentSettings = { ...res.values };
            }
            return res;
          },
          onChange(fn) {
            if (typeof fn !== 'function') return () => {};
            settingsListeners.add(fn);
            return () => settingsListeners.delete(fn);
          }
        },
        commands: {
          async register(commandId, handler) {
            if (typeof commandId !== 'string' || !commandId.trim()) {
              throw new Error('commandId must be a non-empty string');
            }
            if (typeof handler !== 'function') {
              throw new Error(`Command handler for ${commandId} must be a function`);
            }
            commandHandlers.set(commandId, handler);
            await callParent('registerCommand', { commandId });
            return () => {
              if (commandHandlers.get(commandId) === handler) {
                commandHandlers.delete(commandId);
              }
              void callParent('unregisterCommand', { commandId }).catch(() => {});
            };
          },
          execute(commandId, args = []) {
            return callParent('executeCommand', { commandId, args: Array.isArray(args) ? args : [] });
          }
        },
        tray: (() => {
          const serializeTrayObj = (obj, fallbackId = '') => {
            if (!obj || typeof obj !== 'object') return obj;
            const out = { ...obj };
            const itemId = typeof out.id === 'string' && out.id.trim() ? out.id.trim() : fallbackId;
            if (typeof out.onClick === 'function') {
              if (itemId) trayHandlers.set(itemId, out.onClick);
              out.hasOnClick = true;
              delete out.onClick;
            }
            if (Array.isArray(out.submenu)) {
              out.submenu = out.submenu.map((sub) => serializeTrayObj(sub));
            }
            return out;
          };
          return {
            async registerMenuItem(def) {
              if (!def || typeof def !== 'object' || typeof def.id !== 'string' || !def.id.trim()) {
                throw new Error('Tray menu item id must be a non-empty string');
              }
              const localId = def.id.trim();
              const payloadDef = serializeTrayObj(def, localId);
              const res = await callParent('registerTrayMenuItem', { def: payloadDef });
              return {
                id: res?.id || localId,
                fullId: res?.fullId || `${pluginId}:${localId}`,
                update: (patch) => hostProxy.tray.updateMenuItem(localId, patch),
                dispose: () => hostProxy.tray.unregisterMenuItem(localId)
              };
            },
            updateMenuItem(itemId, patch) {
              const payloadPatch = serializeTrayObj(patch, itemId);
              return callParent('updateTrayMenuItem', { itemId, patch: payloadPatch });
            },
            unregisterMenuItem(itemId) {
              trayHandlers.delete(itemId);
              return callParent('unregisterTrayMenuItem', { itemId });
            },
            listMenuItems() {
              return callParent('listTrayMenuItems', {});
            }
          };
        })(),
        overlay: {
          isSupported: () => callParent('overlay:isSupported', {}),
          async createWindow(def) {
            const res = await callParent('overlay:createWindow', { def: def || {} });
            const localId = res.id;
            return {
              id: localId,
              fullId: res.fullId,
              setScene: (scene) => callParent('overlay:setScene', { windowId: localId, scene }),
              updateState: (patch) => callParent('overlay:updateState', { windowId: localId, patch }),
              setBounds: (bounds) => callParent('overlay:setBounds', { windowId: localId, bounds }),
              setVisible: (visible) => callParent('overlay:setVisible', { windowId: localId, visible }),
              onInteraction(handler) {
                if (typeof handler !== 'function') return () => {};
                if (!overlayInteractionHandlers.has(localId)) overlayInteractionHandlers.set(localId, new Set());
                overlayInteractionHandlers.get(localId).add(handler);
                return () => overlayInteractionHandlers.get(localId)?.delete(handler);
              },
              dispose: async () => {
                overlayInteractionHandlers.delete(localId);
                return callParent('overlay:dispose', { windowId: localId });
              }
            };
          },
          listWindows: () => callParent('overlay:listWindows', {}),
          disposeAll: async () => {
            overlayInteractionHandlers.clear();
            return callParent('overlay:disposeAll', {});
          }
        }
      };
      hostProxyRef = hostProxy;

      try {
        const entryFile = path.resolve(msg.pluginDir, msg.mainPath);
        pluginMod = require(entryFile);
        if (typeof pluginMod?.activate === 'function') {
          await pluginMod.activate(hostProxy);
        }
        sendParent({ type: 'ready' });
      } catch (err) {
        sendParent({ type: 'init-error', error: err?.stack || err?.message || String(err) });
      }
      return;
    }

    if (msg.type === 'deactivate') {
      try {
        if (typeof pluginMod?.deactivate === 'function') {
          await pluginMod.deactivate();
        }
      } catch {}
      sendParent({ type: 'deactivated' });
      process.exit(0);
    }
  });
}

module.exports = {
  matchOutboundDomain,
  createScopedNetFetch
};
