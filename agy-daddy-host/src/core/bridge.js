'use strict';

const http = require('http');
const crypto = require('crypto');

const MAX_BODY_BYTES = 1024 * 1024; // 1MB 上限

function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

class DynamicBridgeServer {
  constructor(options = {}) {
    this.allowedOrigin = options.origin || '';
    this.hostToken = options.hostToken || crypto.randomBytes(32).toString('hex');
    this.pluginTokens = new Map(); // pluginId -> token
    this.pluginRoutes = new Map(); // `${pluginId}:${subPath}` -> handler
    this.pluginSystemRoutes = new Map(); // subPath (e.g. '/__settings') -> handler
    this.hostRoutes = new Map();   // `/host/...` -> handler
    this.server = null;
    this.port = 0;
  }

  setOrigin(origin) {
    this.allowedOrigin = String(origin || '').trim();
  }

  issuePluginToken(pluginId) {
    const token = crypto.randomBytes(32).toString('hex');
    this.pluginTokens.set(pluginId, token);
    return token;
  }

  getPluginToken(pluginId) {
    return this.pluginTokens.get(pluginId) || null;
  }

  revokePluginToken(pluginId) {
    this.pluginTokens.delete(pluginId);
  }

  registerHostRoute(fullPath, handler) {
    const normalized = fullPath.startsWith('/') ? fullPath : `/${fullPath}`;
    this.hostRoutes.set(normalized, handler);
    return () => this.hostRoutes.delete(normalized);
  }

  async invokeHostRoute(fullPath, body = {}, ctx = {}) {
    const raw = String(fullPath || '').trim();
    const normalized = raw.startsWith('/') ? raw : `/${raw}`;
    const handler = this.hostRoutes.get(normalized);
    if (!handler) {
      const err = new Error(`HOST_CONTROL_ROUTE_BLOCKED: unknown host route ${normalized}`);
      err.code = 'HOST_CONTROL_ROUTE_BLOCKED';
      throw err;
    }
    const result = await handler(body, { path: normalized, ...ctx });
    return result === undefined ? { ok: true } : result;
  }

  registerPluginRoute(pluginId, subPath, handler) {
    const cleanSub = subPath.startsWith('/') ? subPath : `/${subPath}`;
    const key = `${pluginId}:${cleanSub}`;
    this.pluginRoutes.set(key, handler);
    return () => this.pluginRoutes.delete(key);
  }

  registerPluginSystemRoute(subPath, handler) {
    const cleanSub = subPath.startsWith('/') ? subPath : `/${subPath}`;
    this.pluginSystemRoutes.set(cleanSub, handler);
    return () => {
      if (this.pluginSystemRoutes.get(cleanSub) === handler) {
        this.pluginSystemRoutes.delete(cleanSub);
      }
    };
  }

  unregisterPluginRoutes(pluginId) {
    let removed = 0;
    const prefix = `${pluginId}:`;
    for (const key of Array.from(this.pluginRoutes.keys())) {
      if (key.startsWith(prefix)) {
        this.pluginRoutes.delete(key);
        removed++;
      }
    }
    this.revokePluginToken(pluginId);
    return removed;
  }

  countPluginRoutes(pluginId) {
    let count = 0;
    const prefix = `${pluginId}:`;
    for (const key of this.pluginRoutes.keys()) {
      if (key.startsWith(prefix)) count++;
    }
    return count;
  }

  readJsonBody(req) {
    const MAX_DRAIN_BYTES = MAX_BODY_BYTES * 4;
    const contentLen = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(contentLen) && contentLen > MAX_BODY_BYTES) {
      const err = new Error('Payload Too Large');
      err.statusCode = 413;
      if (contentLen > MAX_DRAIN_BYTES || req.readableEnded) {
        return Promise.reject(err);
      }
      return new Promise((_, reject) => {
        let settled = false;
        let drained = 0;
        const cleanup = () => {
          clearTimeout(timer);
          req.off('data', onData);
          req.off('end', finish);
          req.off('close', finish);
          req.off('error', finish);
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };
        const timer = setTimeout(finish, 1500);
        const onData = (chunk) => {
          drained += chunk.length;
          if (drained > MAX_DRAIN_BYTES) {
            try { req.destroy(); } catch {}
            finish();
          }
        };
        req.on('data', onData);
        req.once('end', finish);
        req.once('close', finish);
        req.once('error', finish);
      });
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let overflow = false;
      let settled = false;
      req.on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          chunks.length = 0;
          overflow = true;
          if (total > MAX_DRAIN_BYTES) {
            settled = true;
            try { req.destroy(); } catch {}
            const err = new Error('Payload Too Large');
            err.statusCode = 413;
            reject(err);
          }
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (settled) return;
        settled = true;
        if (overflow) {
          const err = new Error('Payload Too Large');
          err.statusCode = 413;
          reject(err);
          return;
        }
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          const err = new Error('Invalid JSON payload');
          err.statusCode = 400;
          reject(err);
        }
      });
      req.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  async invokeRoute(req, res, handler, ctx) {
    try {
      const body = await this.readJsonBody(req);
      const result = await handler(body, ctx);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result === undefined ? { ok: true } : result));
    } catch (err) {
      const status = err?.statusCode || 500;
      const headers = status === 413
        ? { 'Content-Type': 'application/json', Connection: 'close' }
        : { 'Content-Type': 'application/json' };
      res.writeHead(status, headers);
      res.end(JSON.stringify({ ok: false, error: err?.message || 'Internal error' }));
    }
  }

  async handleRequest(req, res) {
    const reqOrigin = req.headers.origin;
    if (this.allowedOrigin && this.allowedOrigin !== '*') {
      if (reqOrigin !== this.allowedOrigin) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden origin' }));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', this.allowedOrigin);
      res.setHeader('Vary', 'Origin');
    } else if (reqOrigin) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-AGY-Plugin-Token,X-AGY-Host-Token');
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed' }));
      return;
    }

    const reqUrl = String(req.url || '').split('?')[0];

    // 1. 底座管理端点: /host/*
    if (reqUrl.startsWith('/host/')) {
      const providedHostToken = String(req.headers['x-agy-host-token'] || '');
      if (!safeTokenEqual(providedHostToken, this.hostToken)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Forbidden host token' }));
        return;
      }
      const handler = this.hostRoutes.get(reqUrl);
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Unknown host route: ${reqUrl}` }));
        return;
      }
      await this.invokeRoute(req, res, handler, { path: reqUrl });
      return;
    }

    // 2. 插件命名空间端点: /plugins/<pluginId>/<subPath>
    const m = reqUrl.match(/^\/plugins\/([a-z0-9][a-z0-9.-]*?)(\/.*)$/);
    if (!m) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Not Found' }));
      return;
    }

    const pluginId = m[1];
    const subPath = m[2];
    const expectedToken = this.pluginTokens.get(pluginId);
    const providedToken = String(req.headers['x-agy-plugin-token'] || '');
    if (!expectedToken || !safeTokenEqual(providedToken, expectedToken)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Forbidden token for plugin ${pluginId}` }));
      return;
    }

    const sysHandler = this.pluginSystemRoutes.get(subPath);
    if (sysHandler) {
      await this.invokeRoute(req, res, sysHandler, { pluginId, subPath, system: true });
      return;
    }

    const handler = this.pluginRoutes.get(`${pluginId}:${subPath}`);
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Route not found: ${subPath}` }));
      return;
    }

    await this.invokeRoute(req, res, handler, { pluginId, subPath });
  }

  async start(port = 0) {
    if (this.server) return { port: this.port, hostToken: this.hostToken };
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        this.port = this.server.address().port;
        resolve();
      });
    });
    return { port: this.port, hostToken: this.hostToken };
  }

  async stop() {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.port = 0;
    await new Promise((resolve) => {
      try {
        srv.close(() => resolve());
        try { srv.closeAllConnections?.(); } catch {}
      } catch {
        resolve();
      }
    });
  }
}

module.exports = {
  MAX_BODY_BYTES,
  DynamicBridgeServer
};
