'use strict';

const path = require('path');
const { PluginDataStore } = require('./storage');

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
  const eventHandlers = new Map();
  const stateHandlers = new Map();
  const pendingRpc = new Map();
  let rpcSeq = 0;
  let pluginMod = null;
  let pluginId = '';

  function sendParent(msg) {
    if (typeof process.send === 'function') {
      process.send(msg);
    }
  }

  function callParent(action, payload) {
    const id = ++rpcSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRpc.delete(id);
        reject(new Error(`Worker IPC timeout: ${action}`));
      }, 8000);
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
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result);
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

    if (msg.type === 'init') {
      pluginId = msg.pluginId;
      const store = new PluginDataStore(pluginId, { stateDir: msg.stateDir });
      const perms = msg.grantedPermissions || [];
      const hostProxy = {
        pluginId,
        permissions: [...perms],
        storage: store,
        bridge: {
          async registerRoute(subPath, handler) {
            const clean = subPath.startsWith('/') ? subPath : `/${subPath}`;
            routeHandlers.set(clean, handler);
            await callParent('registerRoute', { subPath: clean });
            return () => routeHandlers.delete(clean);
          }
        },
        rpc: {
          getOrigin: () => callParent('rpcGetOrigin', {}),
          call: (method, body) => callParent('rpcCall', { method, body })
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
          call: (name, method, args = [], opts = {}) => callParent('callService', { name, method, args, opts })
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
        }
      };

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
