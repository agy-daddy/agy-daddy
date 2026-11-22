'use strict';

const { REALMS } = require('../contracts/constants');

function ensureJsonSerializable(value, label = 'payload') {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error(`${label} is not JSON-serializable`);
    }
    return JSON.parse(serialized);
  } catch (err) {
    throw new Error(`${label} serialization failed: ${err?.message || String(err)}`);
  }
}

class FourRealmBus {
  constructor(options = {}) {
    this.defaultTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000;
    this.eventListeners = new Map(); // topic -> Set<{ pluginId, fn }>
    this.stateStore = new Map();     // key -> { value, version, updatedAt, publisher }
    this.stateListeners = new Map(); // key -> Set<{ pluginId, fn }>
    this.services = new Map();       // name -> { pluginId, realm, version, methods }
    this.realmForwarders = new Map();// realm -> fn(serviceRecord, method, args, opts)
    this.hooks = new Map();          // hookName -> Set<{ pluginId, fn }>
  }

  registerRealmForwarder(realm, fn) {
    if (!REALMS.includes(realm)) {
      throw new Error(`Invalid realm: ${realm}`);
    }
    this.realmForwarders.set(realm, fn);
    return () => {
      if (this.realmForwarders.get(realm) === fn) {
        this.realmForwarders.delete(realm);
      }
    };
  }

  onEvent(pluginId, topic, fn) {
    if (!this.eventListeners.has(topic)) {
      this.eventListeners.set(topic, new Set());
    }
    const entry = { pluginId, fn };
    this.eventListeners.get(topic).add(entry);
    return () => {
      const set = this.eventListeners.get(topic);
      if (set) {
        set.delete(entry);
        if (set.size === 0) this.eventListeners.delete(topic);
      }
    };
  }

  emitEvent(pluginId, topic, payload = null) {
    const cleanPayload = payload === undefined ? null : ensureJsonSerializable(payload, `event:${topic}`);
    const listeners = this.eventListeners.get(topic);
    if (!listeners || listeners.size === 0) return 0;
    let delivered = 0;
    for (const entry of Array.from(listeners)) {
      try {
        entry.fn(cleanPayload, { topic, publisher: pluginId });
        delivered++;
      } catch {
        // 单订阅者失败不扩散
      }
    }
    return delivered;
  }

  setState(pluginId, key, value) {
    const cleanValue = value === undefined ? null : ensureJsonSerializable(value, `state:${key}`);
    const prev = this.stateStore.get(key);
    const next = {
      key,
      value: cleanValue,
      version: prev ? prev.version + 1 : 1,
      updatedAt: Date.now(),
      publisher: pluginId
    };
    this.stateStore.set(key, next);
    const listeners = this.stateListeners.get(key);
    if (listeners) {
      for (const entry of Array.from(listeners)) {
        try {
          entry.fn(next.value, { key, version: next.version, publisher: pluginId, updatedAt: next.updatedAt });
        } catch {}
      }
    }
    return next;
  }

  getState(key) {
    return this.stateStore.get(key) || null;
  }

  subscribeState(pluginId, key, fn) {
    if (!this.stateListeners.has(key)) {
      this.stateListeners.set(key, new Set());
    }
    const entry = { pluginId, fn };
    this.stateListeners.get(key).add(entry);
    const current = this.stateStore.get(key);
    if (current) {
      try {
        fn(current.value, { key, version: current.version, publisher: current.publisher, updatedAt: current.updatedAt, replay: true });
      } catch {}
    }
    return () => {
      const set = this.stateListeners.get(key);
      if (set) {
        set.delete(entry);
        if (set.size === 0) this.stateListeners.delete(key);
      }
    };
  }

  provideService(pluginId, serviceName, methodsOrSpec, options = {}) {
    let realm = options.realm || 'node';
    let version = options.version || '1.0.0';
    let methods = methodsOrSpec;
    if (methodsOrSpec && typeof methodsOrSpec === 'object' && methodsOrSpec.methods) {
      realm = methodsOrSpec.realm || realm;
      version = methodsOrSpec.version || version;
      methods = methodsOrSpec.methods;
    }
    if (!REALMS.includes(realm)) {
      throw new Error(`Invalid service realm for ${serviceName}: ${realm}`);
    }
    const record = {
      name: serviceName,
      pluginId,
      realm,
      version,
      methods: methods && typeof methods === 'object' ? methods : {}
    };
    this.services.set(serviceName, record);
    return () => {
      if (this.services.get(serviceName) === record) {
        this.services.delete(serviceName);
      }
    };
  }

  hasService(serviceName) {
    return this.services.has(serviceName);
  }

  listServices() {
    const out = [];
    for (const s of this.services.values()) {
      out.push({
        name: s.name,
        pluginId: s.pluginId,
        realm: s.realm,
        version: s.version,
        methods: Object.keys(s.methods)
      });
    }
    return out;
  }

  async callService(serviceName, method, args = [], options = {}) {
    const record = this.services.get(serviceName);
    const optional = options.optional === true;
    if (!record) {
      if (optional) return { ok: false, unavailable: true, value: null };
      throw new Error(`SERVICE_UNAVAILABLE: ${serviceName}`);
    }

    const cleanArgs = Array.isArray(args)
      ? args.map((a, idx) => (a === undefined ? null : ensureJsonSerializable(a, `${serviceName}.${method}[${idx}]`)))
      : [];
    const callerRealm = options.callerRealm || record.realm;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.defaultTimeoutMs;

    const execute = async () => {
      if (record.realm !== callerRealm || typeof record.methods[method] !== 'function') {
        const forwarder = this.realmForwarders.get(record.realm);
        if (forwarder) {
          return await forwarder(record, method, cleanArgs, options);
        }
      }
      const fn = record.methods[method];
      if (typeof fn !== 'function') {
        throw new Error(`SERVICE_METHOD_NOT_FOUND: ${serviceName}.${method}`);
      }
      return await fn(...cleanArgs);
    };

    let timer = null;
    try {
      const result = await Promise.race([
        Promise.resolve().then(execute),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`SERVICE_TIMEOUT: ${serviceName}.${method} (${timeoutMs}ms)`)), timeoutMs);
        })
      ]);
      const cleanResult = result === undefined ? null : ensureJsonSerializable(result, `${serviceName}.${method}:result`);
      return { ok: true, unavailable: false, value: cleanResult };
    } catch (err) {
      if (optional && /SERVICE_TIMEOUT|SERVICE_UNAVAILABLE/.test(String(err?.message || ''))) {
        return { ok: false, unavailable: true, error: err.message, value: null };
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  getServiceProxy(serviceName, options = {}) {
    const record = this.services.get(serviceName);
    if (!record) return null;
    const bus = this;
    const methodNames = Object.keys(record.methods);
    const proxy = {};
    for (const m of methodNames) {
      proxy[m] = async (...args) => {
        const res = await bus.callService(serviceName, m, args, options);
        return res.value;
      };
    }
    return proxy;
  }

  registerHook(pluginId, hookName, fn) {
    if (!this.hooks.has(hookName)) {
      this.hooks.set(hookName, new Set());
    }
    const entry = { pluginId, fn };
    this.hooks.get(hookName).add(entry);
    return () => {
      const set = this.hooks.get(hookName);
      if (set) {
        set.delete(entry);
        if (set.size === 0) this.hooks.delete(hookName);
      }
    };
  }

  async runHooks(hookName, input = {}) {
    const entries = this.hooks.get(hookName);
    if (!entries) return [];
    const results = [];
    for (const entry of Array.from(entries)) {
      const out = await entry.fn(input);
      if (out !== undefined && out !== null) {
        results.push({ pluginId: entry.pluginId, result: out });
      }
    }
    return results;
  }

  disposePlugin(pluginId) {
    let removed = 0;
    for (const [topic, set] of this.eventListeners.entries()) {
      for (const entry of Array.from(set)) {
        if (entry.pluginId === pluginId) {
          set.delete(entry);
          removed++;
        }
      }
      if (set.size === 0) this.eventListeners.delete(topic);
    }
    for (const [key, set] of this.stateListeners.entries()) {
      for (const entry of Array.from(set)) {
        if (entry.pluginId === pluginId) {
          set.delete(entry);
          removed++;
        }
      }
      if (set.size === 0) this.stateListeners.delete(key);
    }
    for (const [name, rec] of this.services.entries()) {
      if (rec.pluginId === pluginId) {
        this.services.delete(name);
        removed++;
      }
    }
    for (const [hookName, set] of this.hooks.entries()) {
      for (const entry of Array.from(set)) {
        if (entry.pluginId === pluginId) {
          set.delete(entry);
          removed++;
        }
      }
      if (set.size === 0) this.hooks.delete(hookName);
    }
    return removed;
  }

  countRegistrations(pluginId) {
    let count = 0;
    for (const set of this.eventListeners.values()) {
      for (const e of set) if (e.pluginId === pluginId) count++;
    }
    for (const set of this.stateListeners.values()) {
      for (const e of set) if (e.pluginId === pluginId) count++;
    }
    for (const rec of this.services.values()) {
      if (rec.pluginId === pluginId) count++;
    }
    for (const set of this.hooks.values()) {
      for (const e of set) if (e.pluginId === pluginId) count++;
    }
    return count;
  }
}

module.exports = {
  FourRealmBus,
  ensureJsonSerializable
};
