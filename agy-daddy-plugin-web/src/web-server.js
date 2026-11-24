'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const url = require('node:url');

const { normalizeInputRoot, isForbiddenSystemRoot } = require('./workspace-service');
const {
  DEFAULT_CONFIRM_TTL_MS,
  LOOPBACK_BIND_HOST,
  assertBindableHost,
  buildChannelUrls,
  classifyRequestChannel,
  createConfirmToken,
  isChannelAllowed,
  isPermissionAtLeast,
  normalizeBindHostMode,
  normalizeChannelConfig,
  normalizePermissionLevel,
  normalizeTunnelHostname,
  resolveBindHost,
  resolvePrimaryChannel,
  verifyConfirmToken
} = require('./channel-config');

const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_RING_BUFFER_SIZE = 200;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_DELTA_POLL_INTERVAL_MS = 350;

const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob: data:; object-src 'self' blob:; frame-ancestors 'none'"
});

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
});

function normalizeConnectHost(host) {
  const clean = String(host || LOOPBACK_BIND_HOST).trim().toLowerCase();
  if (clean === '0.0.0.0' || clean === '::' || clean === '*') return LOOPBACK_BIND_HOST;
  return clean || LOOPBACK_BIND_HOST;
}

function safeTokenEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader) {
  const out = Object.create(null);
  const raw = String(cookieHeader || '');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function parseHostHeader(raw, defaultPort) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const parsed = new URL(`http://${text}`);
    return {
      hostname: parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
      port: Number(parsed.port) || Number(defaultPort) || 0
    };
  } catch {
    return null;
  }
}

/**
 * Same-origin rule for the write CSRF gate. Loopback keeps the historical
 * loopback-origin rule; every other channel must match the request Host
 * header exactly, which is what LAN IPs, `*.ts.net` and tunnel hostnames all
 * satisfy in a browser.
 */
function isLoopbackSameOrigin(originHeader, serverPort, reqHostHeader, channel = 'loopback') {
  if (!originHeader) return true;
  let parsed;
  try {
    parsed = new URL(String(originHeader));
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) return false;
  const originPort = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
  const hostHeader = parseHostHeader(reqHostHeader, originPort);
  if (hostHeader && hostHeader.hostname === hostname && hostHeader.port === originPort) {
    return true;
  }
  if (channel !== 'loopback') return false;
  if (!ALLOWED_LOOPBACK_HOSTS.has(hostname) && hostname !== 'localhost') return false;
  const expectedPort = serverPort ? String(serverPort) : '';
  if (expectedPort && originPort !== expectedPort) return false;
  return true;
}

/**
 * Required permission tier per route for non-loopback channels.
 *   L0 read-only · L1 chat/session lifecycle · L2 workspace + host admin
 */
function requiredPermissionFor(method, pathname) {
  if (READ_METHODS.has(method)) return 'L0';
  if (pathname === '/api/v1/confirm') return 'L1';
  if (pathname.startsWith('/api/v1/sessions')) return 'L1';
  if (pathname.startsWith('/api/v1/composer')) return 'L1';
  return 'L2';
}

function isPlainObject(val) {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function extractPatch(body) {
  if (!isPlainObject(body)) return null;
  if ('patch' in body) {
    return isPlainObject(body.patch) ? body.patch : null;
  }
  if ('values' in body) {
    return isPlainObject(body.values) ? body.values : null;
  }
  return body;
}

function readJsonBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  const contentLen = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(contentLen) && contentLen > maxBytes) {
    return Promise.reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' }));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) {
          reject(Object.assign(new Error('INVALID_JSON'), { statusCode: 400, code: 'INVALID_JSON' }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('INVALID_JSON'), { statusCode: 400, code: 'INVALID_JSON' }));
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

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

function sendActionResult(res, result, defaultOkStatus = 200) {
  if (result && result.ok === false) {
    const status = Number.isInteger(result.statusCode) ? result.statusCode : 400;
    const body = { ...result };
    delete body.statusCode;
    sendJson(res, status, body);
    return;
  }
  sendJson(res, defaultOkStatus, isPlainObject(result) ? result : { ok: true, data: result });
}

function formatSseFrame({ id, event, data }) {
  const lines = [];
  if (id !== undefined && id !== null) lines.push(`id: ${id}`);
  if (event) lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data === undefined ? null : data)}`);
  return `${lines.join('\n')}\n\n`;
}

/**
 * Multi-channel HTTP + SSE gateway server for agy-daddy-plugin-web.
 *
 * Channels: loopback (default), lan, tailscale, bonjour, cloudflare.
 * Loopback keeps the historical full read/write behaviour; every other
 * channel is gated by a permission tier (L0 read-only / L1 chat / L2 full).
 */
class WebServer {
  constructor(options = {}) {
    this.channels = normalizeChannelConfig(options.channels);
    this.getChannels = typeof options.getChannels === 'function' ? options.getChannels : null;
    this.bindHostMode = normalizeBindHostMode(options.bindHostMode);
    const initialHost = options.host === undefined || options.host === null
      ? resolveBindHost({ channels: this.channels, mode: this.bindHostMode })
      : String(options.host).trim();
    this.host = assertBindableHost(initialHost, this.channels, this.bindHostMode);
    this.requestedPort = Number.isInteger(options.port) ? options.port : 18767;
    this.pairingToken = typeof options.pairingToken === 'string' && options.pairingToken
      ? options.pairingToken
      : crypto.randomBytes(32).toString('hex');
    this.sessionSecret = typeof options.sessionSecret === 'string' && options.sessionSecret
      ? options.sessionSecret
      : crypto.randomBytes(32).toString('hex');
    this.permissionLevel = normalizePermissionLevel(
      options.permissionLevel === undefined ? 'L0' : options.permissionLevel
    );
    this.getPermissionLevel = typeof options.getPermissionLevel === 'function'
      ? options.getPermissionLevel
      : null;
    this.confirmSecret = typeof options.confirmSecret === 'string' && options.confirmSecret
      ? options.confirmSecret
      : this.sessionSecret;
    this.tunnelHostname = normalizeTunnelHostname(options.tunnelHostname);
    this.getTunnelHostname = typeof options.getTunnelHostname === 'function'
      ? options.getTunnelHostname
      : null;
    // Test seam: production always classifies from the socket + headers.
    this.resolveChannel = typeof options.resolveChannel === 'function' ? options.resolveChannel : null;
    this.harnessAdapter = options.harnessAdapter || null;
    this.workspaceService = options.workspaceService || null;
    this.workspaceMetaStore = options.workspaceMetaStore || null;
    this.sessionOrgBridge = options.sessionOrgBridge || null;
    this.refreshSessionRoots = typeof options.refreshSessionRoots === 'function'
      ? options.refreshSessionRoots
      : null;
    this.onReadStateChanged = typeof options.onReadStateChanged === 'function'
      ? options.onReadStateChanged
      : null;
    this.hostProxy = options.hostProxy || null;
    this.getHealthOverride = typeof options.getHealth === 'function' ? options.getHealth : null;
    this.pluginVersion = String(options.pluginVersion || '1.0.0');
    this.staticDir = options.staticDir ? path.resolve(options.staticDir) : '';
    this.maxBodyBytes = Number(options.maxBodyBytes) > 0 ? Number(options.maxBodyBytes) : DEFAULT_MAX_BODY_BYTES;
    this.ringBufferSize = Number.isInteger(options.ringBufferSize) && options.ringBufferSize > 0
      ? options.ringBufferSize
      : DEFAULT_RING_BUFFER_SIZE;
    this.heartbeatIntervalMs = Number(options.heartbeatIntervalMs) > 0
      ? Number(options.heartbeatIntervalMs)
      : DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (options.deltaPollIntervalMs === 0 || options.deltaPollIntervalMs === false) {
      this.deltaPollIntervalMs = 0;
    } else if (options.deltaPollIntervalMs !== undefined) {
      const parsedDelta = Number(options.deltaPollIntervalMs);
      this.deltaPollIntervalMs = Number.isFinite(parsedDelta) && parsedDelta > 0 ? parsedDelta : 0;
    } else {
      this.deltaPollIntervalMs = DEFAULT_DELTA_POLL_INTERVAL_MS;
    }

    this.server = null;
    this.port = null;
    this._sockets = new Set();
    this._sseClients = new Set();
    this._sessionPollers = new Map();
    this._ringBuffer = [];
    this._nextEventId = 0;
  }

  _resolveChannels() {
    return this.getChannels ? normalizeChannelConfig(this.getChannels()) : this.channels;
  }

  _resolvePermissionLevel() {
    return normalizePermissionLevel(
      this.getPermissionLevel ? this.getPermissionLevel() : this.permissionLevel
    );
  }

  _resolveTunnelHostname() {
    return normalizeTunnelHostname(
      this.getTunnelHostname ? this.getTunnelHostname() : this.tunnelHostname
    );
  }

  /**
   * Apply a live access-policy change. Returns true when the listen address
   * must be rebound (channel or bind-host change).
   */
  updateAccessConfig({ channels, bindHostMode, permissionLevel, tunnelHostname } = {}) {
    const nextChannels = channels === undefined ? this.channels : normalizeChannelConfig(channels);
    const nextMode = bindHostMode === undefined ? this.bindHostMode : normalizeBindHostMode(bindHostMode);
    const rebind = JSON.stringify(nextChannels) !== JSON.stringify(this.channels)
      || nextMode !== this.bindHostMode;

    // Validate the whole policy before committing, so a rejected change cannot
    // leave channels and the listen address out of sync.
    const nextHost = rebind
      ? assertBindableHost(
        resolveBindHost({ channels: nextChannels, mode: nextMode }),
        nextChannels,
        nextMode
      )
      : this.host;

    this.channels = nextChannels;
    this.bindHostMode = nextMode;
    this.host = nextHost;
    if (permissionLevel !== undefined) {
      this.permissionLevel = normalizePermissionLevel(permissionLevel);
    }
    if (tunnelHostname !== undefined) {
      this.tunnelHostname = normalizeTunnelHostname(tunnelHostname);
    }
    return { rebind, host: this.host };
  }

  getLocalUrl() {
    if (!this.port) return '';
    const connectHost = normalizeConnectHost(this.host);
    const formattedHost = connectHost === '::1' ? '[::1]' : connectHost;
    return `http://${formattedHost}:${this.port}`;
  }

  getPairingUrl() {
    const base = this.getLocalUrl();
    return base ? `${base}/?token=${encodeURIComponent(this.pairingToken)}` : '';
  }

  getChannelUrls() {
    return buildChannelUrls({
      port: this.port,
      token: this.pairingToken,
      channels: this._resolveChannels(),
      connectHost: normalizeConnectHost(this.host),
      hostName: os.hostname(),
      tunnelHostname: this._resolveTunnelHostname()
    });
  }

  getAccessStatus() {
    const channels = this._resolveChannels();
    const urls = this.getChannelUrls();
    const { primaryChannel, primaryUrl } = resolvePrimaryChannel(urls, channels);
    const permissionLevel = this._resolvePermissionLevel();
    return {
      bindHost: this.host,
      connectHost: normalizeConnectHost(this.host),
      channels: { ...channels },
      activeChannels: Object.keys(channels).filter((key) => channels[key] === true),
      urls,
      primaryChannel,
      primaryUrl,
      permissionLevel,
      allowRemoteWrite: isPermissionAtLeast(permissionLevel, 'L1'),
      tunnelHostname: this._resolveTunnelHostname()
    };
  }

  broadcast(eventName, data, { sessionId } = {}) {
    const id = ++this._nextEventId;
    const entry = {
      id,
      event: String(eventName || 'message'),
      data: data === undefined ? null : data,
      sessionId: sessionId ? String(sessionId) : null
    };
    this._ringBuffer.push(entry);
    while (this._ringBuffer.length > this.ringBufferSize) {
      this._ringBuffer.shift();
    }

    const frame = formatSseFrame(entry);
    for (const client of Array.from(this._sseClients)) {
      if (client.sessionId && entry.sessionId && client.sessionId !== entry.sessionId) {
        continue;
      }
      client.write(frame);
    }
    return id;
  }

  async start() {
    // Re-validate the chosen listen address against the live channel policy;
    // recomputing it here would silently discard an explicitly configured host.
    // Address changes are owned by updateAccessConfig().
    const liveChannels = this._resolveChannels();
    this.host = assertBindableHost(this.host, liveChannels, this.bindHostMode);
    if (this.server) {
      return { host: this.host, port: this.port, url: this.getLocalUrl(), pairingUrl: this.getPairingUrl() };
    }

    const srv = http.createServer((req, res) => {
      void this._handleRequest(req, res);
    });

    srv.on('connection', (socket) => {
      this._sockets.add(socket);
      socket.on('close', () => this._sockets.delete(socket));
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        srv.removeListener('listening', onListen);
        reject(err);
      };
      const onListen = () => {
        srv.removeListener('error', onError);
        const addr = srv.address();
        this.server = srv;
        this.port = addr && typeof addr === 'object' ? addr.port : this.requestedPort;
        resolve();
      };
      srv.once('error', onError);
      srv.once('listening', onListen);
      srv.listen(this.requestedPort, this.host);
    });

    return {
      host: this.host,
      port: this.port,
      url: this.getLocalUrl(),
      pairingUrl: this.getPairingUrl(),
      ...this.getAccessStatus()
    };
  }

  async stop() {
    this._stopAllSessionPollers();
    for (const client of Array.from(this._sseClients)) {
      client.close();
    }
    this._sseClients.clear();

    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.port = null;

    try { srv.closeIdleConnections?.(); } catch {}
    try { srv.closeAllConnections?.(); } catch {}
    for (const sock of Array.from(this._sockets)) {
      try { sock.destroy(); } catch {}
    }
    this._sockets.clear();

    await new Promise((resolve) => srv.close(() => resolve()));
  }

  _authenticateApiRequest(req) {
    const authHeader = String(req.headers?.authorization || '');
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      const token = authHeader.slice(7).trim();
      if (safeTokenEqual(token, this.pairingToken)) {
        return { ok: true, mode: 'bearer' };
      }
      return { ok: false };
    }

    const cookies = parseCookies(req.headers?.cookie);
    if (safeTokenEqual(cookies.agy_web_sid, this.sessionSecret)) {
      return { ok: true, mode: 'cookie' };
    }
    return { ok: false };
  }

  async _handleRequest(req, res) {
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const urlObj = new URL(req.url || '/', `http://${this.host === '::1' ? '[::1]' : this.host}`);
      const pathname = urlObj.pathname;
      const channel = this.resolveChannel
        ? this.resolveChannel(req)
        : classifyRequestChannel(req, { tunnelHostname: this._resolveTunnelHostname() });
      const channels = this._resolveChannels();

      if (!isChannelAllowed(channel, channels)) {
        sendJson(res, 403, {
          ok: false,
          error: 'CHANNEL_DISABLED',
          channel,
          allowedChannels: Object.keys(channels).filter((key) => channels[key] === true)
        });
        return;
      }

      if (method === 'GET' && pathname === '/' && urlObj.searchParams.has('token')) {
        const providedToken = urlObj.searchParams.get('token') || '';
        if (!safeTokenEqual(providedToken, this.pairingToken)) {
          sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
          return;
        }
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': this._buildSessionCookie(channel),
          ...SECURITY_HEADERS
        });
        res.end();
        return;
      }

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const auth = this._authenticateApiRequest(req);
        if (!auth.ok) {
          sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
          return;
        }
        if (auth.mode === 'cookie' && WRITE_METHODS.has(method)) {
          const csrf = String(req.headers['x-agy-csrf'] || '').trim();
          const originOk = isLoopbackSameOrigin(
            req.headers.origin,
            this.port,
            req.headers.host,
            channel
          );
          if (!csrf || !originOk) {
            sendJson(res, 403, { ok: false, error: 'CSRF_REQUIRED' });
            return;
          }
        }
        await this._handleApiRequest(req, res, method, urlObj, channel);
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        this._serveStatic(res, method, pathname);
        return;
      }

      sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
    } catch (err) {
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      sendJson(res, status, {
        ok: false,
        error: err?.code || err?.message || 'INTERNAL_ERROR'
      });
    }
  }

  _requireDep(dep, name) {
    if (!dep) {
      throw Object.assign(new Error(`${name}_UNAVAILABLE`), { statusCode: 503, code: `${name}_UNAVAILABLE` });
    }
    return dep;
  }

  _buildSessionCookie(channel) {
    // Every channel is a first-party context (the console is served from the
    // same host the browser navigated to), so SameSite=Strict stays correct and
    // Strict + HttpOnly is what blocks cross-site cookie attachment.
    // Secure is added only for the HTTPS tunnel channel: on plain http LAN the
    // Secure attribute would make browsers drop the cookie entirely.
    const secure = channel === 'cloudflare' ? '; Secure' : '';
    return `agy_web_sid=${encodeURIComponent(this.sessionSecret)}; HttpOnly; SameSite=Strict${secure}; Path=/`;
  }

  _confirmActionId(method, pathname) {
    return `${method} ${pathname}`;
  }

  _requireChannelPermission(req, res, method, pathname, channel) {
    if (channel === 'loopback') return true;
    const required = requiredPermissionFor(method, pathname);
    const current = this._resolvePermissionLevel();
    if (!isPermissionAtLeast(current, required)) {
      sendJson(res, 403, {
        ok: false,
        error: 'PERMISSION_DENIED',
        required,
        current,
        channel
      });
      return false;
    }
    // Minting a confirm token cannot itself require one, and it mutates no state.
    if (required !== 'L0' && channel === 'cloudflare' && pathname !== '/api/v1/confirm') {
      const action = this._confirmActionId(method, pathname);
      const provided = String(req.headers['x-agy-confirm'] || '').trim();
      if (provided && verifyConfirmToken(provided, this.confirmSecret, { action })) {
        return true;
      }
      sendJson(res, 403, {
        ok: false,
        error: 'CONFIRMATION_REQUIRED',
        channel,
        action,
        confirmToken: createConfirmToken(this.confirmSecret, { action }),
        confirmHint: '公网 Cloudflare 通道执行写操作需要二次确认'
      });
      return false;
    }
    return true;
  }

  async _handleApiRequest(req, res, method, urlObj, channel = 'loopback') {
    const pathname = urlObj.pathname;

    if (!this._requireChannelPermission(req, res, method, pathname, channel)) {
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/web/status') {
      sendJson(res, 200, {
        ok: true,
        running: Boolean(this.server && this.port),
        host: this.host,
        port: this.port,
        url: this.getLocalUrl(),
        pairingUrl: this.getPairingUrl(),
        channel,
        ...this.getAccessStatus()
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/confirm') {
      const body = await readJsonBody(req, this.maxBodyBytes);
      const action = String(body.action || '').trim();
      if (!action) {
        sendJson(res, 400, { ok: false, error: 'MISSING_ACTION' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        action,
        confirmToken: createConfirmToken(this.confirmSecret, { action }),
        expiresInMs: DEFAULT_CONFIRM_TTL_MS
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/health') {
      let health = { ok: true, rpcConnected: Boolean(this.harnessAdapter), hubOrigin: null };
      if (this.getHealthOverride) {
        health = await this.getHealthOverride();
      } else if (typeof this.harnessAdapter?.getHealth === 'function') {
        health = await this.harnessAdapter.getHealth();
      }
      sendJson(res, 200, { ok: true, ...health, pluginVersion: this.pluginVersion });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/stream') {
      this._handleSseStream(req, res, urlObj);
      return;
    }

    try {
      if (method === 'GET' && pathname === '/api/v1/sessions') {
        const adapter = this._requireDep(this.harnessAdapter, 'HARNESS_ADAPTER');
        const limitRaw = urlObj.searchParams.get('limit');
        const limit = limitRaw !== null ? Number(limitRaw) : 50;
        const includeInternal = urlObj.searchParams.get('includeInternal') === '1'
          || urlObj.searchParams.get('includeInternal') === 'true';
        const result = await adapter.listSessions({ limit: Number.isFinite(limit) && limit > 0 ? limit : 50 });
        if (result?.ok !== false && Array.isArray(result?.sessions)) {
          this.refreshSessionRoots?.(result.sessions);
          if (this.workspaceMetaStore) {
            const enrichedRes = typeof this.workspaceMetaStore.enrichSessionsWithMeta === 'function'
              ? this.workspaceMetaStore.enrichSessionsWithMeta(result.sessions, { includeInternal })
              : {
                  sessions: this.workspaceMetaStore.enrichSessions(result.sessions, { includeInternal }),
                  hiddenInternalCount: 0
                };
            let sessions = Array.isArray(enrichedRes?.sessions) ? enrichedRes.sessions : [];
            const hiddenInternalCount = Number.isFinite(Number(enrichedRes?.hiddenInternalCount))
              ? Number(enrichedRes.hiddenInternalCount)
              : 0;
            const projectIdFilter = urlObj.searchParams.get('projectId');
            if (projectIdFilter) {
              sessions = projectIdFilter === '__none__'
                ? sessions.filter((s) => !s.projectId)
                : sessions.filter((s) => s.projectId === projectIdFilter);
            }
            sendActionResult(res, { ...result, sessions, hiddenInternalCount });
            return;
          }
        }
        sendActionResult(res, result);
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/sessions') {
        const adapter = this._requireDep(this.harnessAdapter, 'HARNESS_ADAPTER');
        const body = await readJsonBody(req, this.maxBodyBytes);
        const nowIso = new Date().toISOString();
        const cleanTitle = typeof body.title === 'string' ? body.title.trim() : '';

        if (!this.workspaceMetaStore) {
          if (body.projectId) {
            this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
          }
          const result = await adapter.createSession(body);
          sendActionResult(res, {
            ...result,
            createdTime: result?.createdTime || nowIso,
            lastModifiedTime: result?.lastModifiedTime || nowIso,
            status: result?.status || 'CASCADE_RUN_STATUS_IDLE',
            stepCount: Number.isFinite(Number(result?.stepCount)) ? Number(result.stepCount) : 0,
            title: result?.title || cleanTitle,
            hasTitle: Boolean(result?.title || cleanTitle)
          });
          return;
        }

        const cleanProjectId = typeof body.projectId === 'string' && body.projectId.trim()
          ? body.projectId.trim()
          : null;
        let resolvedWorkspaceUri = typeof body.workspaceUri === 'string' && body.workspaceUri.trim()
          ? body.workspaceUri.trim()
          : undefined;
        let resolvedProject = null;

        if (cleanProjectId) {
          resolvedProject = this.workspaceMetaStore.getProjectById(cleanProjectId, {
            workspaceUri: resolvedWorkspaceUri
          });
          if (!resolvedProject && !resolvedWorkspaceUri) {
            sendJson(res, 404, { ok: false, error: 'PROJECT_NOT_FOUND' });
            return;
          }
          if (!resolvedWorkspaceUri && resolvedProject?.rootPath) {
            resolvedWorkspaceUri = url.pathToFileURL(resolvedProject.rootPath).href;
          }
        } else if (!resolvedWorkspaceUri) {
          const defaultPath = this.workspaceMetaStore.getState().defaultSessionPath;
          if (defaultPath && !isForbiddenSystemRoot(defaultPath)) {
            if (body.standalone !== false) {
              try {
                fs.mkdirSync(defaultPath, { recursive: true });
              } catch {
                // Keep URL derivation even if dir cannot be created in mocked envs
              }
            }
            try {
              if (body.standalone || fs.existsSync(defaultPath)) {
                resolvedWorkspaceUri = url.pathToFileURL(defaultPath).href;
              }
            } catch {
              // Ignore fs check failure
            }
          }
        }

        const result = await adapter.createSession({
          ...(cleanTitle ? { title: cleanTitle } : {}),
          ...(resolvedWorkspaceUri ? { workspaceUri: resolvedWorkspaceUri } : {})
        });
        let assignedProjectId = cleanProjectId;
        if (result?.ok !== false && result?.cascadeId) {
          this.workspaceMetaStore.recordUserCreatedSession?.(result.cascadeId);
          this.workspaceMetaStore.markSessionRead?.(result.cascadeId, { lastReadStepCount: 0 });
          this.onReadStateChanged?.();
          if (cleanProjectId && resolvedProject) {
            const assignRes = this.workspaceMetaStore.assignSessionProject(result.cascadeId, cleanProjectId, {
              workspaceUri: resolvedWorkspaceUri
            });
            if (assignRes?.ok !== false && assignRes?.projectId) {
              assignedProjectId = assignRes.projectId;
            }
          } else if (body.standalone === true) {
            this.workspaceMetaStore.assignSessionProject(result.cascadeId, null);
          }
        }
        const finalWorkspaceUri = resolvedWorkspaceUri || result?.workspaceUri || null;
        sendActionResult(res, {
          ...result,
          ...(finalWorkspaceUri ? { workspaceUri: finalWorkspaceUri } : {}),
          projectId: assignedProjectId || result?.projectId || null,
          projectName: resolvedProject?.name || null,
          createdTime: result?.createdTime || nowIso,
          lastModifiedTime: result?.lastModifiedTime || nowIso,
          status: result?.status || 'CASCADE_RUN_STATUS_IDLE',
          stepCount: Number.isFinite(Number(result?.stepCount)) ? Number(result.stepCount) : 0,
          title: result?.title || cleanTitle,
          hasTitle: Boolean(result?.title || cleanTitle)
        });
        return;
      }

      if (method === 'GET' && (pathname === '/api/sessions/org' || pathname === '/api/v1/sessions/org')) {
        if (this.sessionOrgBridge) {
          sendActionResult(res, this.sessionOrgBridge.getOrg());
          return;
        }
        if (typeof this.harnessAdapter?.getSessionOrg === 'function') {
          sendActionResult(res, await this.harnessAdapter.getSessionOrg());
          return;
        }
        sendJson(res, 200, { ok: true, groups: [], projects: [], pins: { sessions: [], projects: [], groups: [] } });
        return;
      }

      if (method === 'POST' && (pathname === '/api/sessions/pin' || pathname === '/api/v1/sessions/pin')) {
        const body = await readJsonBody(req, this.maxBodyBytes);
        if (this.sessionOrgBridge) {
          sendActionResult(res, this.sessionOrgBridge.togglePin(body));
          return;
        }
        if (typeof this.harnessAdapter?.togglePin === 'function') {
          sendActionResult(res, await this.harnessAdapter.togglePin(body));
          return;
        }
        sendJson(res, 503, { ok: false, error: 'SESSION_ORG_UNAVAILABLE' });
        return;
      }

      if (method === 'POST' && (pathname === '/api/sessions/groups' || pathname === '/api/v1/sessions/groups')) {
        const body = await readJsonBody(req, this.maxBodyBytes);
        if (this.sessionOrgBridge) {
          sendActionResult(res, this.sessionOrgBridge.mutateGroup(body));
          return;
        }
        if (typeof this.harnessAdapter?.mutateGroup === 'function') {
          sendActionResult(res, await this.harnessAdapter.mutateGroup(body));
          return;
        }
        sendJson(res, 503, { ok: false, error: 'SESSION_ORG_UNAVAILABLE' });
        return;
      }

      let match;
      if (method === 'PUT' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/pin$/))) {
        const store = this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
        const id = decodeURIComponent(match[1]);
        const body = await readJsonBody(req, this.maxBodyBytes);
        const result = store.setSessionPin(id, Boolean(body.pinned));
        sendActionResult(res, result);
        return;
      }

      if (method === 'PUT' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/project$/))) {
        const store = this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
        const id = decodeURIComponent(match[1]);
        const body = await readJsonBody(req, this.maxBodyBytes);
        const result = store.assignSessionProject(id, body.projectId ?? null);
        sendActionResult(res, result);
        return;
      }

      if (method === 'PUT' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/read$/))) {
        const store = this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
        const id = decodeURIComponent(match[1]);
        const body = await readJsonBody(req, this.maxBodyBytes);
        const result = store.markSessionRead(id, {
          lastReadStepCount: body.lastReadStepCount,
          lastReadAt: body.lastReadAt
        });
        if (result?.ok !== false) {
          this.onReadStateChanged?.();
          this.broadcast('state.patch', {
            key: 'state:session.readState@1',
            value: store.getReadStateSnapshot()
          });
        }
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/))) {
        const adapter = this._requireDep(this.harnessAdapter, 'HARNESS_ADAPTER');
        const id = decodeURIComponent(match[1]);
        const result = await adapter.getSessionDetail(id);
        if (!result) {
          sendJson(res, 404, { ok: false, error: 'SESSION_NOT_FOUND' });
          return;
        }
        sendActionResult(res, result);
        return;
      }

      if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/))) {
        const adapter = this._requireDep(this.harnessAdapter, 'HARNESS_ADAPTER');
        const id = decodeURIComponent(match[1]);
        const body = await readJsonBody(req, this.maxBodyBytes);
        const hasText = typeof body.text === 'string' && body.text.trim().length > 0;
        const hasImages = Array.isArray(body.images) && body.images.length > 0;
        if (!hasText && !hasImages) {
          sendJson(res, 400, { ok: false, error: 'INVALID_MESSAGE_TEXT' });
          return;
        }
        const result = await adapter.sendMessage(id, body);
        sendActionResult(res, result);
        if (this._sessionPollers.has(id)) {
          void this._pollSessionDelta(id);
        }
        return;
      }

      if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/cancel$/))) {
        const adapter = this._requireDep(this.harnessAdapter, 'HARNESS_ADAPTER');
        const id = decodeURIComponent(match[1]);
        await readJsonBody(req, this.maxBodyBytes);
        const result = await adapter.cancelSession(id);
        sendActionResult(res, result);
        if (this._sessionPollers.has(id)) {
          void this._pollSessionDelta(id);
        }
        return;
      }

      if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/steps\/(\d+)\/approve$/))) {
        const id = decodeURIComponent(match[1]);
        const stepIdx = Number(match[2]);
        const body = await readJsonBody(req, this.maxBodyBytes);
        if (typeof this.harnessAdapter?.approveStep === 'function') {
          const result = await this.harnessAdapter.approveStep(id, stepIdx, body.decision, body.payload);
          if (result && result.ok === true) {
            sendActionResult(res, result);
            if (this._sessionPollers.has(id)) {
              void this._pollSessionDelta(id);
            }
            return;
          }
          const status = Number.isInteger(result?.statusCode) ? result.statusCode : 501;
          const payload = { ...result };
          delete payload.statusCode;
          sendJson(res, status, {
            ok: false,
            supported: false,
            error: payload.error || 'APPROVAL_RPC_UNAVAILABLE_IN_2_34',
            ...payload
          });
          return;
        }
        sendJson(res, 501, {
          ok: false,
          supported: false,
          error: 'APPROVAL_RPC_UNAVAILABLE_IN_2_34'
        });
        return;
      }

      if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/steps\/(\d+)\/answer$/))) {
        const adapter = this._requireDep(this.harnessAdapter, 'HARNESS_ADAPTER');
        const id = decodeURIComponent(match[1]);
        const stepIdx = Number(match[2]);
        const body = await readJsonBody(req, this.maxBodyBytes);
        if (typeof adapter.answerQuestion !== 'function') {
          sendJson(res, 501, { ok: false, supported: false, error: 'ANSWER_QUESTION_UNAVAILABLE' });
          return;
        }
        const result = await adapter.answerQuestion(id, stepIdx, body.answers ?? [], body.payload ?? {});
        sendActionResult(res, result);
        if (this._sessionPollers.has(id)) {
          void this._pollSessionDelta(id);
        }
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/models') {
        const adapter = this._requireDep(this.harnessAdapter, 'HARNESS_ADAPTER');
        const result = await adapter.listModels();
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/fs/tree') {
        const ws = this._requireDep(this.workspaceService, 'WORKSPACE_SERVICE');
        const root = urlObj.searchParams.get('root') || '';
        const relPath = urlObj.searchParams.get('path') || '';
        const depthRaw = urlObj.searchParams.get('depth');
        const depth = depthRaw !== null ? Number(depthRaw) : 2;
        const result = await ws.listTree({ root, path: relPath, depth: Number.isFinite(depth) ? depth : 2 });
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/fs/read') {
        const ws = this._requireDep(this.workspaceService, 'WORKSPACE_SERVICE');
        const root = urlObj.searchParams.get('root') || '';
        const relPath = urlObj.searchParams.get('path') || '';
        const result = await ws.readFile({ root, path: relPath });
        sendActionResult(res, result);
        return;
      }

      if (method === 'PUT' && pathname === '/api/v1/fs/write') {
        const ws = this._requireDep(this.workspaceService, 'WORKSPACE_SERVICE');
        const body = await readJsonBody(req, this.maxBodyBytes);
        const result = await ws.writeFile({ root: body.root, path: body.path, content: body.content });
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/git/diff') {
        const ws = this._requireDep(this.workspaceService, 'WORKSPACE_SERVICE');
        const root = urlObj.searchParams.get('root') || '';
        const relPath = urlObj.searchParams.get('path') || undefined;
        const result = await ws.getGitDiff({ root, path: relPath });
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/artifacts/previewers') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const result = await proxy.getArtifactPreviewers();
        sendActionResult(res, result);
        return;
      }

      if ((method === 'GET' || method === 'HEAD') && (match = pathname.match(/^\/api\/v1\/artifacts\/([^/]+)\/raw$/))) {
        const ws = this._requireDep(this.workspaceService, 'WORKSPACE_SERVICE');
        const sessionId = decodeURIComponent(match[1]);
        const file = urlObj.searchParams.get('file') || '';
        const result = await ws.readArtifactRaw(sessionId, file);
        if (!result || result.ok === false) {
          sendActionResult(res, result);
          return;
        }
        const mime = String(result.mime || 'application/octet-stream');
        const contentType = mime.startsWith('text/') || mime === 'image/svg+xml'
          ? `${mime}; charset=utf-8`
          : mime;
        const safeBasename = path.basename(String(result.name || file || 'artifact')).replace(/["\\\r\n]/g, '_');
        let rawCsp = "default-src 'none'; frame-ancestors 'self'";
        if (mime === 'text/html' || mime === 'image/svg+xml') {
          rawCsp = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'";
        } else if (mime === 'application/pdf') {
          rawCsp = "default-src 'none'; object-src 'self'; frame-ancestors 'self'";
        }
        const buf = Buffer.isBuffer(result.buffer)
          ? result.buffer
          : Buffer.from(result.buffer || '');
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': String(buf.length),
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Cache-Control': 'no-store',
          'Content-Disposition': `inline; filename="${safeBasename}"`,
          'Content-Security-Policy': rawCsp
        });
        if (method === 'HEAD') {
          res.end();
          return;
        }
        res.end(buf);
        return;
      }

      if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/artifacts\/([^/]+)\/plugin-preview$/))) {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const sessionId = decodeURIComponent(match[1]);
        const body = await readJsonBody(req, this.maxBodyBytes);
        const result = await proxy.renderPluginArtifactPreview({
          pluginId: body.pluginId,
          sessionId,
          file: body.file,
          mime: body.mime
        });
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/artifacts') {
        const ws = this._requireDep(this.workspaceService, 'WORKSPACE_SERVICE');
        const sessionId = urlObj.searchParams.get('sessionId') || '';
        const file = urlObj.searchParams.get('file') || '';
        const result = file
          ? await ws.readArtifact(sessionId, file)
          : await ws.listArtifacts(sessionId);
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/projects') {
        const store = this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
        let sessions = [];
        if (typeof this.harnessAdapter?.listSessions === 'function') {
          try {
            const listRes = await this.harnessAdapter.listSessions({ limit: 500 });
            if (listRes?.ok !== false && Array.isArray(listRes?.sessions)) {
              sessions = listRes.sessions;
              this.refreshSessionRoots?.(sessions);
            }
          } catch {
            // Soft-ignore session listing failure when computing project list
          }
        }
        sendActionResult(res, store.listProjectsAndGroups(sessions));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/projects') {
        const store = this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
        const body = await readJsonBody(req, this.maxBodyBytes);
        sendActionResult(res, store.createProject(body));
        return;
      }

      if (method === 'PATCH' && (match = pathname.match(/^\/api\/v1\/projects\/([^/]+)$/))) {
        const store = this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
        const id = decodeURIComponent(match[1]);
        const body = await readJsonBody(req, this.maxBodyBytes);
        sendActionResult(res, store.updateProject(id, body));
        return;
      }

      if (method === 'DELETE' && (match = pathname.match(/^\/api\/v1\/projects\/([^/]+)$/))) {
        const store = this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
        const id = decodeURIComponent(match[1]);
        sendActionResult(res, store.deleteProject(id));
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/project-groups') {
        const store = this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
        const listed = store.listProjectsAndGroups([]);
        sendActionResult(res, { ok: true, groups: listed.groups });
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/project-groups') {
        const store = this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
        const body = await readJsonBody(req, this.maxBodyBytes);
        sendActionResult(res, store.createGroup(body));
        return;
      }

      if (method === 'PATCH' && (match = pathname.match(/^\/api\/v1\/project-groups\/([^/]+)$/))) {
        const store = this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
        const id = decodeURIComponent(match[1]);
        const body = await readJsonBody(req, this.maxBodyBytes);
        sendActionResult(res, store.updateGroup(id, body));
        return;
      }

      if (method === 'DELETE' && (match = pathname.match(/^\/api\/v1\/project-groups\/([^/]+)$/))) {
        const store = this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
        const id = decodeURIComponent(match[1]);
        sendActionResult(res, store.deleteGroup(id));
        return;
      }

      if (method === 'PUT' && pathname === '/api/v1/workspace/default-path') {
        const store = this._requireDep(this.workspaceMetaStore, 'WORKSPACE_META_STORE');
        const body = await readJsonBody(req, this.maxBodyBytes);
        const result = store.setDefaultSessionPath(body.defaultSessionPath ?? body.path ?? '');
        sendActionResult(res, result);
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/workspace/authorize-root') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const body = await readJsonBody(req, this.maxBodyBytes);
        const normalized = normalizeInputRoot(body?.root);
        if (!normalized) {
          sendJson(res, 400, { ok: false, error: 'INVALID_ROOT' });
          return;
        }
        if (isForbiddenSystemRoot(normalized)) {
          sendJson(res, 403, { ok: false, error: 'FORBIDDEN_SYSTEM_ROOT' });
          return;
        }
        let realRoot;
        try {
          realRoot = fs.realpathSync(normalized);
        } catch {
          sendJson(res, 404, { ok: false, error: 'ROOT_NOT_FOUND' });
          return;
        }
        if (isForbiddenSystemRoot(realRoot)) {
          sendJson(res, 403, { ok: false, error: 'FORBIDDEN_SYSTEM_ROOT' });
          return;
        }
        let st;
        try {
          st = fs.statSync(realRoot);
        } catch {
          sendJson(res, 404, { ok: false, error: 'ROOT_NOT_FOUND' });
          return;
        }
        if (!st.isDirectory()) {
          sendJson(res, 400, { ok: false, error: 'ROOT_NOT_DIRECTORY' });
          return;
        }

        const currentSettings = await proxy.getPluginSettings('agy-daddy.web');
        const existingRoots = Array.isArray(currentSettings?.values?.allowedRoots)
          ? currentSettings.values.allowedRoots
          : [];
        const caseInsensitive = process.platform === 'darwin' || process.platform === 'win32';
        const seen = new Set();
        const nextRoots = [];
        for (const entry of [...existingRoots, realRoot]) {
          if (typeof entry !== 'string' || !entry.trim()) continue;
          const normEntry = normalizeInputRoot(entry) || entry.trim();
          const key = caseInsensitive ? normEntry.toLowerCase() : normEntry;
          if (seen.has(key)) continue;
          seen.add(key);
          nextRoots.push(entry === realRoot ? realRoot : normEntry);
        }

        const saveRes = await proxy.setPluginSettings('agy-daddy.web', { allowedRoots: nextRoots });
        if (saveRes?.ok === false) {
          sendActionResult(res, saveRes);
          return;
        }
        sendJson(res, 200, { ok: true, root: realRoot, allowedRoots: nextRoots });
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/host/locale') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const result = await proxy.getHostLocale();
        sendActionResult(res, result);
        return;
      }

      if (method === 'PUT' && pathname === '/api/v1/host/locale') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const body = await readJsonBody(req, this.maxBodyBytes);
        const rawLocale = body?.locale ?? body?.lang;
        const result = await proxy.setHostLocale(rawLocale);
        if (result?.ok !== false) {
          this.broadcast('state.patch', {
            key: 'state:host.locale@1',
            value: {
              bcp47: result.locale,
              locale: result.locale,
              lang: result.hostLang
            }
          });
        }
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/host/plugins') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const scope = urlObj.searchParams.get('scope') || undefined;
        const result = scope ? await proxy.getPlugins({ scope }) : await proxy.getPlugins();
        sendActionResult(res, result);
        return;
      }

      if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/host\/plugins\/([^/]+)\/([^/]+)$/))) {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const pluginId = decodeURIComponent(match[1]);
        const action = decodeURIComponent(match[2]);
        const body = await readJsonBody(req, this.maxBodyBytes);
        const result = await proxy.pluginAction(pluginId, action, body);
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/host/settings') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const result = await proxy.getHostSettings();
        sendActionResult(res, result);
        return;
      }

      if (method === 'PUT' && pathname === '/api/v1/host/settings') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const body = await readJsonBody(req, this.maxBodyBytes);
        const patch = extractPatch(body);
        if (!patch) {
          sendJson(res, 400, { ok: false, error: 'INVALID_SETTINGS_PATCH' });
          return;
        }
        const result = await proxy.setHostSettings(patch);
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && (match = pathname.match(/^\/api\/v1\/host\/plugins\/([^/]+)\/settings$/))) {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const pluginId = decodeURIComponent(match[1]);
        const scope = urlObj.searchParams.get('scope') || undefined;
        const result = scope
          ? await proxy.getPluginSettings(pluginId, { scope })
          : await proxy.getPluginSettings(pluginId);
        sendActionResult(res, result);
        return;
      }

      if (method === 'PUT' && (match = pathname.match(/^\/api\/v1\/host\/plugins\/([^/]+)\/settings$/))) {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const pluginId = decodeURIComponent(match[1]);
        const body = await readJsonBody(req, this.maxBodyBytes);
        const patch = extractPatch(body);
        if (!patch) {
          sendJson(res, 400, { ok: false, error: 'INVALID_SETTINGS_PATCH' });
          return;
        }
        const result = await proxy.setPluginSettings(pluginId, patch);
        sendActionResult(res, result);
        return;
      }

      if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/host\/commands\/([^/]+)$/))) {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const cmdId = decodeURIComponent(match[1]);
        const body = await readJsonBody(req, this.maxBodyBytes);
        const result = await proxy.runCommand(cmdId, body);
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/host/doctor') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const result = await proxy.getDoctor();
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/topbar') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const result = await proxy.getTopbar();
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/remote/status') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const result = await proxy.getRemoteStatus();
        sendActionResult(res, result);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/composer/state') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const result = await proxy.getComposerState();
        sendActionResult(res, result);
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/composer/optimize') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const body = await readJsonBody(req, this.maxBodyBytes);
        const result = await proxy.optimizePrompt(body.text || '');
        sendActionResult(res, result);
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/composer/export') {
        const proxy = this._requireDep(this.hostProxy, 'HOST_PROXY');
        const body = await readJsonBody(req, this.maxBodyBytes);
        let events = Array.isArray(body.events) ? body.events : null;
        if (!events && body.cascadeId && this.harnessAdapter) {
          try {
            const detail = await this.harnessAdapter.getSessionDetail(body.cascadeId);
            events = detail?.events || [];
          } catch {
            events = [];
          }
        }
        const result = await proxy.exportSessionMarkdown({
          cascadeId: body.cascadeId,
          title: body.title,
          events: events || []
        });
        sendActionResult(res, result);
        return;
      }

      sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
    } catch (err) {
      const isHarnessRoute = pathname.startsWith('/api/v1/sessions') || pathname === '/api/v1/models';
      const defaultStatus = isHarnessRoute ? 502 : 500;
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : defaultStatus;
      sendJson(res, status, {
        ok: false,
        error: err?.code || err?.message || 'INTERNAL_ERROR',
        ...(err?.code && err?.message && err.message !== err.code ? { message: err.message } : {})
      });
    }
  }

  _handleSseStream(req, res, urlObj) {
    const sessionId = String(urlObj.searchParams.get('sessionId') || '').trim() || null;
    const rawLastId = req.headers['last-event-id'] ?? urlObj.searchParams.get('lastEventId');

    req.setTimeout?.(0);
    res.setTimeout?.(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...SECURITY_HEADERS
    });
    res.write(': connected\n\n');

    if (rawLastId !== undefined && rawLastId !== null && String(rawLastId).trim() !== '') {
      const lastId = Number(rawLastId);
      if (Number.isInteger(lastId) && lastId >= 0) {
        if (this._ringBuffer.length > 0) {
          const oldestId = this._ringBuffer[0].id;
          const latestId = this._ringBuffer[this._ringBuffer.length - 1].id;
          if (lastId < oldestId - 1 || lastId > latestId) {
            res.write(formatSseFrame({
              event: 'session.resync',
              data: {
                reason: 'OUT_OF_WINDOW',
                lastEventId: lastId,
                oldestBufferedId: oldestId,
                latestEventId: latestId
              }
            }));
          } else {
            for (const entry of this._ringBuffer) {
              if (entry.id <= lastId) continue;
              if (sessionId && entry.sessionId && sessionId !== entry.sessionId) continue;
              res.write(formatSseFrame(entry));
            }
          }
        } else if (this._nextEventId > 0 && lastId !== this._nextEventId) {
          res.write(formatSseFrame({
            event: 'session.resync',
            data: {
              reason: 'OUT_OF_WINDOW',
              lastEventId: lastId,
              oldestBufferedId: null,
              latestEventId: this._nextEventId
            }
          }));
        }
      }
    }

    let closed = false;
    let heartbeatTimer = null;
    const client = {
      sessionId,
      write(chunk) {
        if (!closed && !res.writableEnded) {
          try { res.write(chunk); } catch { client.close(); }
        }
      },
      close() {
        if (closed) return;
        closed = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        thisRef._sseClients.delete(client);
        if (sessionId) {
          thisRef._maybeStopSessionPoller(sessionId);
        }
        try { if (!res.writableEnded) res.end(); } catch {}
      }
    };
    const thisRef = this;
    this._sseClients.add(client);
    if (sessionId) {
      this._ensureSessionPoller(sessionId);
    }

    heartbeatTimer = setInterval(() => {
      client.write(formatSseFrame({ event: 'heartbeat', data: { ts: Date.now() } }));
    }, this.heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    req.on('close', () => client.close());
    res.on('close', () => client.close());
    res.on('error', () => client.close());
  }

  _ensureSessionPoller(sessionId) {
    if (!sessionId || this.deltaPollIntervalMs <= 0 || typeof this.harnessAdapter?.pollDelta !== 'function') {
      return;
    }
    if (this._sessionPollers.has(sessionId)) return;
    const entry = {
      timer: null,
      running: false,
      lastStatus: undefined,
      pending: false
    };
    entry.timer = setInterval(() => {
      void this._pollSessionDelta(sessionId);
    }, this.deltaPollIntervalMs);
    entry.timer.unref?.();
    this._sessionPollers.set(sessionId, entry);
  }

  _maybeStopSessionPoller(sessionId) {
    if (!sessionId) return;
    for (const client of this._sseClients) {
      if (client.sessionId === sessionId) return;
    }
    const entry = this._sessionPollers.get(sessionId);
    if (!entry) return;
    if (entry.timer) clearInterval(entry.timer);
    this._sessionPollers.delete(sessionId);
  }

  _stopAllSessionPollers() {
    for (const entry of this._sessionPollers.values()) {
      if (entry.timer) clearInterval(entry.timer);
    }
    this._sessionPollers.clear();
  }

  async _pollSessionDelta(sessionId) {
    const entry = this._sessionPollers.get(sessionId);
    if (!entry || typeof this.harnessAdapter?.pollDelta !== 'function') return;
    if (entry.running) {
      entry.pending = true;
      return;
    }
    entry.running = true;
    try {
      const res = await this.harnessAdapter.pollDelta(sessionId);
      if (this._sessionPollers.get(sessionId) !== entry) return;
      if (res && (res.hasChanges || res.status !== entry.lastStatus)) {
        const wasRunning = typeof entry.lastStatus === 'string' && /RUNNING|GENERATING/i.test(entry.lastStatus);
        const isRunningNow = typeof res.status === 'string' && /RUNNING|GENERATING/i.test(res.status);
        entry.lastStatus = res.status;
        this.broadcast('session.delta', {
          cascadeId: sessionId,
          status: res.status,
          totalSteps: res.totalSteps,
          stepOffset: res.stepOffset,
          events: res.events || []
        }, { sessionId });
        if (wasRunning && !isRunningNow && this.workspaceMetaStore) {
          this.workspaceMetaStore.recordSessionCompletion?.(sessionId, { stepCount: res.totalSteps });
          this.onReadStateChanged?.();
          this.broadcast('state.patch', {
            key: 'state:session.readState@1',
            value: {
              ...(this.workspaceMetaStore.getReadStateSnapshot?.() || {}),
              completedSessionId: sessionId
            }
          });
        }
      }
    } catch {
      // Transient poll errors should not break future ticks.
    } finally {
      entry.running = false;
      if (entry.pending && this._sessionPollers.get(sessionId) === entry) {
        entry.pending = false;
        void this._pollSessionDelta(sessionId);
      }
    }
  }

  _serveStatic(res, method, pathname) {
    if (!this.staticDir || !fs.existsSync(this.staticDir)) {
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
      return;
    }

    const realRoot = fs.realpathSync(this.staticDir);
    let cleanRel = '/';
    try {
      cleanRel = decodeURIComponent(pathname || '/');
    } catch {
      sendJson(res, 400, { ok: false, error: 'INVALID_PATH' });
      return;
    }

    const normalizedRel = cleanRel.replace(/^\/+/, '');
    const candidate = path.resolve(realRoot, normalizedRel || 'index.html');
    const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
    if (candidate !== realRoot && !candidate.startsWith(rootPrefix)) {
      sendJson(res, 403, { ok: false, error: 'FORBIDDEN' });
      return;
    }

    let targetFile = null;
    if (fs.existsSync(candidate)) {
      const realTarget = fs.realpathSync(candidate);
      if (realTarget === realRoot || realTarget.startsWith(rootPrefix)) {
        const st = fs.statSync(realTarget);
        if (st.isFile()) {
          targetFile = realTarget;
        } else if (st.isDirectory()) {
          const dirIndex = path.join(realTarget, 'index.html');
          if (fs.existsSync(dirIndex) && fs.statSync(dirIndex).isFile()) {
            targetFile = fs.realpathSync(dirIndex);
          }
        }
      }
    }

    if (!targetFile && !path.extname(normalizedRel)) {
      const spaIndex = path.join(realRoot, 'index.html');
      if (fs.existsSync(spaIndex) && fs.statSync(spaIndex).isFile()) {
        targetFile = fs.realpathSync(spaIndex);
      }
    }

    if (!targetFile || (!targetFile.startsWith(rootPrefix) && targetFile !== realRoot)) {
      sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
      return;
    }

    const ext = path.extname(targetFile).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const relFromRoot = path.relative(realRoot, targetFile).split(path.sep).join('/');
    const isImmutableAsset = relFromRoot.startsWith('assets/');
    const content = fs.readFileSync(targetFile);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': String(content.length),
      ...SECURITY_HEADERS,
      'Cache-Control': isImmutableAsset ? 'public, max-age=31536000, immutable' : 'no-store'
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    res.end(content);
  }
}

function createWebServer(options = {}) {
  return new WebServer(options);
}

module.exports = {
  ALLOWED_LOOPBACK_HOSTS,
  SECURITY_HEADERS,
  isLoopbackSameOrigin,
  requiredPermissionFor,
  WebServer,
  createWebServer
};
