'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  DEFAULT_CHANNELS,
  classifyRequestChannel,
  isChannelAllowed,
  normalizePermissionLevel,
  isPermissionAtLeast,
  createConfirmToken,
  verifyConfirmToken,
  safeTokenEqual
} = require('./tunnel-security');
const { generatePwaHtml } = require('./pwa-html');
const { generateTunnelLandingHtml } = require('./tunnel-landing-html');

const MAX_ACTION_BODY_BYTES = 15 * 1024 * 1024;
const PING_GIF_BUFFER = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const FORBIDDEN_SECRET_KEYS = new Set(['pairingUrl', 'pairingToken', 'pcWeb']);

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: http: https: http://127.0.0.1:* http://localhost:*; worker-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
});

const LANDING_SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob: http: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: http: https:; worker-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
});

const STATIC_MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
});

const LEGACY_COMPAT_TEMPLATE = [
  '<template id="agy-legacy-compat" hidden data-token-var="--ag-primary-bg" data-client-header="X-AG-Client-Id" data-client-key="agy_remote_client_id">',
  '<style>/* --ag-primary-bg */</style>',
  '<div id="agy-remote-context-drawer"><div id="agy-remote-context-detail"></div></div>',
  '<button id="agy-switch-channel-btn" type="button"></button>',
  '<button class="agy-speed-probe-btn" data-probe="/api/ping" type="button"></button>',
  '<details class="ctx-help"><summary>renderContextMobile</summary></details>',
  '</template>'
].join('');

function extractRequestToken(req, urlObj) {
  const authHeader = String(req.headers?.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  const headerToken = req.headers?.['x-agy-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }
  return String(urlObj.searchParams.get('token') || urlObj.searchParams.get('t') || '').trim();
}

function stripPairingSecrets(value, seen = new WeakSet()) {
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => stripPairingSecrets(item, seen));
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_SECRET_KEYS.has(k)) continue;
    out[k] = stripPairingSecrets(v, seen);
  }
  return out;
}

function normalizeTreeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((ent) => {
    if (!ent || typeof ent !== 'object') return ent;
    const mapped = {
      ...ent,
      type: ent.type === 'directory' ? 'dir' : ent.type
    };
    if (Array.isArray(ent.children)) {
      mapped.children = normalizeTreeEntries(ent.children);
    }
    return mapped;
  });
}

function sendJson(res, statusCode, payload, extraHeaders = null) {
  if (res.writableEnded) return;
  const sanitized = stripPairingSecrets(payload);
  const body = JSON.stringify(sanitized);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
    ...(extraHeaders || {})
  });
  res.end(body);
}

function sendResult(res, result, defaultOkStatus = 200) {
  if (result && result.ok === false) {
    const status = Number.isInteger(result.statusCode) ? result.statusCode : 400;
    const body = { ...result };
    delete body.statusCode;
    sendJson(res, status, body);
    return;
  }
  const status = result && Number.isInteger(result.statusCode) ? result.statusCode : defaultOkStatus;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const body = { ...result };
    delete body.statusCode;
    sendJson(res, status, body);
    return;
  }
  sendJson(res, status, { ok: true, data: result });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_ACTION_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          resolve({});
          return;
        }
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('INVALID_JSON'), { statusCode: 400 }));
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

function injectLegacyCompatHtml(html) {
  if (!html || html.includes('id="agy-remote-context-drawer"')) {
    return html;
  }
  if (html.includes('</body>')) {
    return html.replace('</body>', `${LEGACY_COMPAT_TEMPLATE}</body>`);
  }
  return `${html}${LEGACY_COMPAT_TEMPLATE}`;
}

function isInsideDir(targetPath, baseDir) {
  const rel = path.relative(baseDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

class MobileRemoteServer {
  constructor(options = {}) {
    this.requestedPort = Number.isInteger(options.port) ? options.port : 18765;
    this.host = options.host || '127.0.0.1';
    this.staticDir = options.staticDir !== undefined
      ? (options.staticDir ? path.resolve(options.staticDir) : '')
      : path.resolve(__dirname, '..', 'dist', 'web');
    this.getToken = typeof options.getToken === 'function' ? options.getToken : () => '';
    this.getConfirmSecret = typeof options.getConfirmSecret === 'function'
      ? options.getConfirmSecret
      : () => String(this.getToken() || 'agy-remote-confirm');
    this.getPermissionLevel = typeof options.getPermissionLevel === 'function'
      ? options.getPermissionLevel
      : () => (this.isWriteEnabled() ? 'L1' : 'L0');
    this.getSnapshot = typeof options.getSnapshot === 'function' ? options.getSnapshot : async () => ({ ok: true, panels: {} });
    this.getChannels = typeof options.getChannels === 'function' ? options.getChannels : () => DEFAULT_CHANNELS;
    this.getChannelEntries = typeof options.getChannelEntries === 'function'
      ? options.getChannelEntries
      : () => ({ tunnelMode: 'quick', writeEnabled: false, entries: [] });
    this.getTunnelHostname = typeof options.getTunnelHostname === 'function' ? options.getTunnelHostname : () => '';
    this.getProxySecret = typeof options.getProxySecret === 'function' ? options.getProxySecret : () => '';
    this.getPcWebProxyTarget = typeof options.getPcWebProxyTarget === 'function' ? options.getPcWebProxyTarget : () => null;
    this.isWriteEnabled = typeof options.isWriteEnabled === 'function' ? options.isWriteEnabled : () => false;
    this.onAction = typeof options.onAction === 'function' ? options.onAction : async () => ({ ok: true });
    this.v1Handlers = options.v1Handlers && typeof options.v1Handlers === 'object' ? options.v1Handlers : {};
    this.sseBroker = options.sseBroker || null;
    this.ptyManager = options.ptyManager || null;
    this.webPush = options.webPush || null;
    this.mobileWorkspace = options.mobileWorkspace || null;
    this.workspaceBrowser = options.workspaceBrowser || null;
    this.remoteProvisioner = options.remoteProvisioner || null;
    this.onPtyUpgrade = typeof options.onPtyUpgrade === 'function' ? options.onPtyUpgrade : null;

    this.server = null;
    this.port = null;
    this.sockets = new Set();
    this.clients = new Map();
    this.devices = new Map();
  }

  recordClientVisit(req, channel) {
    const clientId = String(req.headers?.['x-ag-client-id'] || '').trim() || 'default';
    const deviceHint = String(req.headers?.['x-ag-device-hint'] || req.headers?.['user-agent'] || '').trim() || `device:${channel}`;
    const now = Date.now();
    this.clients.set(clientId, { clientId, deviceHint, channel, lastSeenAt: now });
    const prevDev = this.devices.get(deviceHint) || { deviceHint, channelsSeen: [], clientIds: [], firstSeenAt: now };
    if (!prevDev.channelsSeen.includes(channel)) prevDev.channelsSeen.push(channel);
    if (!prevDev.clientIds.includes(clientId)) prevDev.clientIds.push(clientId);
    prevDev.lastChannel = channel;
    prevDev.lastSeenAt = now;
    this.devices.set(deviceHint, prevDev);
    return { clientId, deviceHint };
  }

  getTrackedDevices() {
    return {
      devices: Array.from(this.devices.values()),
      clients: Array.from(this.clients.values())
    };
  }

  clearTrackedDevices() {
    this.devices.clear();
    this.clients.clear();
  }

  async start() {
    if (this.server) {
      return { host: this.host, port: this.port, url: this.getLocalUrl() };
    }

    this.server = http.createServer(async (req, res) => {
      try {
        await this._handleRequest(req, res);
      } catch (err) {
        const code = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
        sendJson(res, code, { ok: false, error: err?.code || err?.message || 'INTERNAL_ERROR' });
      }
    });

    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    this.server.on('upgrade', (req, socket, head) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      this._handleUpgrade(req, socket, head);
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.removeListener('listening', onListen);
        reject(err);
      };
      const onListen = () => {
        this.server.removeListener('error', onError);
        const addr = this.server.address();
        this.port = addr && typeof addr === 'object' ? addr.port : this.requestedPort;
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListen);
      this.server.listen(this.requestedPort, this.host);
    });

    return {
      host: this.host,
      port: this.port,
      url: this.getLocalUrl()
    };
  }

  getLocalUrl() {
    if (!this.port) return '';
    const connectHost = this.host === '0.0.0.0' ? '127.0.0.1' : this.host;
    return `http://${connectHost}:${this.port}`;
  }

  _resolvePermission() {
    return normalizePermissionLevel(this.getPermissionLevel(), this.isWriteEnabled());
  }

  _authenticate(req, res, urlObj) {
    const provided = extractRequestToken(req, urlObj);
    if (!safeTokenEqual(provided, this.getToken())) {
      sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
      return null;
    }
    return provided;
  }

  _requirePermission(res, minLevel) {
    const current = this._resolvePermission();
    if (!isPermissionAtLeast(current, minLevel)) {
      sendJson(res, 403, {
        ok: false,
        error: 'PERMISSION_DENIED',
        required: minLevel,
        current
      });
      return false;
    }
    return true;
  }

  _requireCloudflareConfirm(req, res, channel, action) {
    if (channel !== 'cloudflare') return true;
    const provided = String(req.headers?.['x-agy-confirm'] || '').trim();
    const secret = String(this.getConfirmSecret() || '');
    if (provided && verifyConfirmToken(provided, secret, { action })) {
      return true;
    }
    const confirmToken = createConfirmToken(secret, { action });
    sendJson(res, 403, {
      ok: false,
      error: 'CONFIRMATION_REQUIRED',
      channel,
      action,
      confirmHint: '公网 Cloudflare 通道执行高危写操作需要二次确认',
      confirmToken
    });
    return false;
  }

  _handleUpgrade(req, socket, head) {
    let urlObj;
    try {
      urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (urlObj.pathname !== '/ws/pty') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const channel = classifyRequestChannel(req, { tunnelHostname: this.getTunnelHostname() });
    if (!isChannelAllowed(channel, this.getChannels())) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const provided = extractRequestToken(req, urlObj);
    if (!safeTokenEqual(provided, this.getToken())) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const perm = this._resolvePermission();
    if (!isPermissionAtLeast(perm, 'L2')) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    if (channel === 'cloudflare') {
      const confirmHeader = String(
        req.headers?.['x-agy-confirm'] || urlObj.searchParams.get('confirm') || ''
      ).trim();
      const secret = String(this.getConfirmSecret() || '');
      if (!confirmHeader || !verifyConfirmToken(confirmHeader, secret, { action: '/ws/pty' })) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    if (this.onPtyUpgrade) {
      this.onPtyUpgrade(req, socket, head, { channel, urlObj });
      return;
    }
    if (this.ptyManager && typeof this.ptyManager.handleUpgrade === 'function') {
      this.ptyManager.handleUpgrade(req, socket, head);
      return;
    }

    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }

  _handlePcWebProxy(req, res, method, urlObj, channel) {
    if (channel !== 'cloudflare' || this.getChannels()?.cloudflare !== true) {
      sendJson(res, 403, { ok: false, error: 'CHANNEL_DISABLED', channel });
      return;
    }

    const target = this.getPcWebProxyTarget();
    const targetRunning = Boolean(target && (target.proxyRunning ?? target.running) && target.port);
    if (!targetRunning) {
      sendJson(res, 503, { ok: false, error: 'PC_WEB_UNAVAILABLE' });
      return;
    }
    if (target.channels?.cloudflare !== true) {
      sendJson(res, 403, { ok: false, error: 'CHANNEL_DISABLED', channel: 'cloudflare' });
      return;
    }

    if (urlObj.pathname === '/pc') {
      res.writeHead(302, {
        Location: `/pc/${urlObj.search || ''}`,
        ...SECURITY_HEADERS
      });
      res.end();
      return;
    }

    const strippedPath = urlObj.pathname.slice(3) || '/';
    const upstreamPath = `${strippedPath}${urlObj.search || ''}`;
    const forwardHeaders = {};
    for (const [key, val] of Object.entries(req.headers || {})) {
      if (val === undefined) continue;
      const lower = key.toLowerCase();
      if (lower.startsWith('x-agy-proxy-') || lower === 'connection') continue;
      forwardHeaders[key] = val;
    }
    forwardHeaders['x-agy-proxy-source'] = 'agy-daddy-remote';
    forwardHeaders['x-agy-proxy-channel'] = 'cloudflare';
    forwardHeaders['x-agy-proxy-prefix'] = '/pc';
    forwardHeaders['x-agy-proxy-secret'] = String(this.getProxySecret() || '');

    req.setTimeout?.(0);
    res.setTimeout?.(0);

    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: target.port,
      method,
      path: upstreamPath,
      headers: forwardHeaders
    }, (proxyRes) => {
      if (res.writableEnded || res.destroyed) {
        proxyRes.destroy();
        return;
      }
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }
      proxyRes.on('data', (chunk) => {
        if (!res.writableEnded && !res.destroyed) {
          res.write(chunk);
        }
      });
      proxyRes.on('end', () => {
        if (!res.writableEnded) res.end();
      });
      proxyRes.on('error', () => {
        if (!res.writableEnded) res.end();
      });
    });

    proxyReq.setTimeout(0);
    const abortUpstream = () => {
      if (!res.writableEnded && !proxyReq.destroyed) {
        proxyReq.destroy();
      }
    };
    res.on('close', abortUpstream);
    req.on('aborted', abortUpstream);
    req.on('error', abortUpstream);
    proxyReq.on('error', () => {
      if (!res.headersSent) {
        sendJson(res, 502, { ok: false, error: 'PC_WEB_PROXY_ERROR' });
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    if (method === 'GET' || method === 'HEAD') {
      proxyReq.end();
    } else {
      req.pipe(proxyReq);
    }
  }

  _tryServeStatic(res, method, pathname) {
    if (!this.staticDir) return false;
    let realStaticDir;
    try {
      realStaticDir = fs.realpathSync(this.staticDir);
    } catch {
      return false;
    }

    const rawRel = pathname === '/' || pathname === '/index.html' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (!rawRel || rawRel.includes('\0')) return false;

    const candidate = path.resolve(realStaticDir, rawRel);
    if (!isInsideDir(candidate, realStaticDir)) return false;

    let realFile;
    let stat;
    try {
      realFile = fs.realpathSync(candidate);
      if (!isInsideDir(realFile, realStaticDir)) return false;
      stat = fs.statSync(realFile);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    const ext = path.extname(realFile).toLowerCase();
    const contentType = STATIC_MIME_TYPES[ext] || 'application/octet-stream';
    const isImmutableAsset = rawRel.startsWith('assets/');
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Cache-Control': isImmutableAsset ? 'public, max-age=31536000, immutable' : 'no-store'
    };

    if (rawRel === 'index.html') {
      const html = injectLegacyCompatHtml(fs.readFileSync(realFile, 'utf8'));
      res.writeHead(200, headers);
      if (method === 'HEAD') {
        res.end();
      } else {
        res.end(html);
      }
      return true;
    }

    const buf = fs.readFileSync(realFile);
    res.writeHead(200, {
      ...headers,
      'Content-Length': String(buf.byteLength)
    });
    if (method === 'HEAD') {
      res.end();
    } else {
      res.end(buf);
    }
    return true;
  }

  async _handleRequest(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = urlObj.pathname;

    // 后端逐通道 403 门禁检查
    const channel = classifyRequestChannel(req, { tunnelHostname: this.getTunnelHostname() });
    if (!isChannelAllowed(channel, this.getChannels())) {
      sendJson(res, 403, { ok: false, error: 'CHANNEL_DISABLED', channel });
      return;
    }

    if (pathname === '/pc' || pathname.startsWith('/pc/')) {
      this._handlePcWebProxy(req, res, method, urlObj, channel);
      return;
    }

    if ((method === 'GET' || method === 'HEAD') && (pathname === '/' || pathname === '/index.html' || pathname === '/entry')) {
      const channelsCfg = this.getChannels();
      const enterConsole = urlObj.searchParams.get('enter') === '1' || urlObj.searchParams.get('direct') === '1';
      const shouldShowLanding =
        (pathname === '/entry' && channelsCfg?.cloudflare === true) ||
        ((pathname === '/' || pathname === '/index.html') && channel === 'cloudflare' && channelsCfg?.cloudflare === true && !enterConsole);

      if (shouldShowLanding) {
        const provided = extractRequestToken(req, urlObj);
        const authenticated = safeTokenEqual(provided, this.getToken());
        const bundle = authenticated
          ? (this.getChannelEntries(provided, { req, channel }) || {})
          : (this.getChannelEntries('', { req, channel, unauthenticated: true }) || {});
        const currentHost = String(req.headers?.host || '').trim();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          ...LANDING_SECURITY_HEADERS
        });
        if (method === 'HEAD') {
          res.end();
          return;
        }
        res.end(generateTunnelLandingHtml({
          version: '2.0.0',
          authenticated,
          writeEnabled: Boolean(bundle.writeEnabled ?? this.isWriteEnabled()),
          tunnelMode: bundle.tunnelMode === 'named' ? 'named' : 'quick',
          currentChannel: channel,
          currentHost,
          entries: authenticated ? (Array.isArray(bundle.entries) ? bundle.entries : []) : []
        }));
        return;
      }

      if (pathname === '/entry') {
        sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
        return;
      }

      if (this._tryServeStatic(res, method, '/index.html')) {
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...SECURITY_HEADERS
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      res.end(generatePwaHtml({ version: '2.0.0' }));
      return;
    }

    // Serve static Vite assets, sw.js, manifest.webmanifest, icon.svg
    if ((method === 'GET' || method === 'HEAD') && !pathname.startsWith('/api/') && !pathname.startsWith('/ws/')) {
      if (this._tryServeStatic(res, method, pathname)) {
        return;
      }
    }

    // Legacy endpoints (Step 1 compatibility)
    if (method === 'GET' && pathname === '/api/channels') {
      const provided = this._authenticate(req, res, urlObj);
      if (!provided) return;
      const bundle = this.getChannelEntries(provided, { req, channel }) || {};
      sendJson(res, 200, {
        ok: true,
        channel,
        permissionLevel: this._resolvePermission(),
        writeEnabled: Boolean(bundle.writeEnabled ?? this.isWriteEnabled()),
        tunnelMode: bundle.tunnelMode === 'named' ? 'named' : 'quick',
        entries: Array.isArray(bundle.entries) ? bundle.entries : []
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/ping') {
      sendJson(res, 200, {
        ok: true,
        service: 'agy-daddy-remote',
        channel,
        permissionLevel: this._resolvePermission(),
        writeEnabled: Boolean(this.isWriteEnabled())
      }, {
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin'
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/ping-gif') {
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': String(PING_GIF_BUFFER.length),
        ...SECURITY_HEADERS,
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin'
      });
      res.end(PING_GIF_BUFFER);
      return;
    }

    if (method === 'GET' && pathname === '/api/snapshot') {
      if (!this._authenticate(req, res, urlObj)) return;
      const { clientId, deviceHint } = this.recordClientVisit(req, channel);
      const snapshot = await this.getSnapshot();
      sendJson(res, 200, { ...snapshot, clientId, deviceHint, channel });
      return;
    }

    if (method === 'GET' && pathname === '/api/devices') {
      if (!this._authenticate(req, res, urlObj)) return;
      sendJson(res, 200, { ok: true, ...this.getTrackedDevices() });
      return;
    }

    if (method === 'POST' && pathname === '/api/action') {
      if (!this._authenticate(req, res, urlObj)) return;
      const { clientId } = this.recordClientVisit(req, channel);
      if (this.isWriteEnabled() !== true) {
        sendJson(res, 403, {
          ok: false,
          error: 'REMOTE_WRITE_DISABLED',
          message: 'Remote write actions are disabled by default'
        });
        return;
      }
      const body = await readJsonBody(req);
      const result = await this.onAction(body, { clientId, channel });
      sendJson(res, 200, result && typeof result === 'object' ? result : { ok: true });
      return;
    }

    // Step 3 Mobile Remote v1 API
    if (pathname.startsWith('/api/v1/')) {
      await this._handleV1Request(req, res, method, urlObj, channel);
      return;
    }

    sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
  }

  async _handleV1Request(req, res, method, urlObj, channel) {
    const pathname = urlObj.pathname;
    if (!this._authenticate(req, res, urlObj)) return;
    const { clientId } = this.recordClientVisit(req, channel);
    const permissionLevel = this._resolvePermission();
    const h = this.v1Handlers;

    if (method === 'GET' && pathname === '/api/v1/bootstrap') {
      if (typeof h.getBootstrap === 'function') {
        const result = await h.getBootstrap({ req, channel, clientId, permissionLevel });
        sendResult(res, result);
        return;
      }
      const snap = await this.getSnapshot();
      sendJson(res, 200, {
        ok: true,
        channel,
        permissionLevel,
        permissionInfo: {
          level: permissionLevel,
          canRead: true,
          canChat: isPermissionAtLeast(permissionLevel, 'L1'),
          canWriteFsGitPty: isPermissionAtLeast(permissionLevel, 'L2'),
          hostOnlyElevation: true,
          levels: [
            { level: 'L0', label: '只读观察', description: '仅查看会话、文件、Diff 与监控面板' },
            { level: 'L1', label: '对话与审批', description: '可发送消息、队列插队、审批步骤与回答提问' },
            { level: 'L2', label: '工作区与终端', description: '允许文件写入、Git 提交推送与 PTY 终端（需宿主机授权）' }
          ]
        },
        writeEnabled: isPermissionAtLeast(permissionLevel, 'L1'),
        models: [],
        modelGroups: [],
        workspaces: this.mobileWorkspace ? this.mobileWorkspace.listRoots().roots : [],
        groups: [],
        projects: [],
        pins: { sessions: [], projects: [], groups: [] },
        vapidPublicKey: this.webPush ? this.webPush.getPublicKey() : null,
        voiceSupported: false,
        telemetry: snap
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/stream') {
      if (!this.sseBroker) {
        sendJson(res, 503, { ok: false, error: 'SSE_BROKER_UNAVAILABLE' });
        return;
      }
      const sessionId = String(urlObj.searchParams.get('sessionId') || '').trim() || null;
      const lastEventId = urlObj.searchParams.get('lastEventId') ?? undefined;
      const stepOffsetRaw = urlObj.searchParams.get('stepOffset');
      const stepOffset = stepOffsetRaw !== null ? Number(stepOffsetRaw) : undefined;
      this.sseBroker.handleStreamRequest(req, res, {
        sessionId,
        clientId,
        channel,
        permissionLevel,
        lastEventId,
        stepOffset
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/confirm') {
      if (!this._requirePermission(res, 'L1')) return;
      const body = await readJsonBody(req);
      const action = String(body.action || '').trim();
      if (!action) {
        sendJson(res, 400, { ok: false, error: 'MISSING_ACTION' });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        action,
        confirmToken: createConfirmToken(String(this.getConfirmSecret() || ''), { action }),
        expiresInMs: 60_000
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/sessions') {
      if (typeof h.listSessions !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SESSIONS_UNAVAILABLE' });
        return;
      }
      const limitRaw = urlObj.searchParams.get('limit');
      const limit = limitRaw !== null ? Number(limitRaw) : 200;
      const includeSubagentsRaw = String(urlObj.searchParams.get('includeSubagents') || '').trim().toLowerCase();
      const includeSubagents = includeSubagentsRaw === 'true' || includeSubagentsRaw === '1';
      const includeArchivedRaw = String(urlObj.searchParams.get('includeArchived') || '').trim().toLowerCase();
      const includeArchived = includeArchivedRaw === 'true' || includeArchivedRaw === '1';
      const result = await h.listSessions({
        limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
        includeSubagents,
        includeArchived
      });
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/sessions') {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.createSession !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SESSIONS_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const result = await h.createSession(body);
      sendResult(res, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/sessions/org') {
      const includeArchivedRaw = String(urlObj.searchParams.get('includeArchived') || '').trim().toLowerCase();
      const includeArchived = includeArchivedRaw === 'true' || includeArchivedRaw === '1';
      if (typeof h.getSessionOrg === 'function') {
        const result = await h.getSessionOrg({ includeArchived });
        sendResult(res, result);
        return;
      }
      sendJson(res, 200, { ok: true, groups: [], projects: [], pins: { sessions: [], projects: [], groups: [] } });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/sessions/pin') {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.togglePin !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SESSION_ORG_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const result = await h.togglePin(body);
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/sessions/groups') {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.mutateGroup !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SESSION_ORG_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const result = await h.mutateGroup(body);
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/sessions/org/reorder') {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.reorderOrg !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SESSION_ORG_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const result = await h.reorderOrg(body);
      sendResult(res, result);
      return;
    }

    let match;
    if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/archive$/))) {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.archiveSession !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SESSION_ORG_UNAVAILABLE' });
        return;
      }
      const id = decodeURIComponent(match[1]);
      const body = await readJsonBody(req);
      const result = await h.archiveSession(id, body);
      sendResult(res, result);
      return;
    }

    if (method === 'DELETE' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/))) {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.deleteSession !== 'function') {
        sendJson(res, 503, {
          ok: false,
          error: 'HOST_DELETE_UNAVAILABLE',
          reasonCode: 'RPC_OFFLINE',
          canFallbackLocalHide: true
        });
        return;
      }
      const id = decodeURIComponent(match[1]);
      const mode = String(urlObj.searchParams.get('mode') || 'auto').trim().toLowerCase();
      const result = await h.deleteSession(id, { mode });
      sendResult(res, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/workspace/browse') {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this.workspaceBrowser) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_BROWSER_UNAVAILABLE' });
        return;
      }
      const rawPath = urlObj.searchParams.get('path') || '';
      const showHidden = urlObj.searchParams.get('showHidden') === '1' || urlObj.searchParams.get('showHidden') === 'true';
      sendResult(res, await this.workspaceBrowser.browse({ path: rawPath, showHidden }));
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/workspace/mkdir') {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (!this.workspaceBrowser) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_BROWSER_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      sendResult(res, await this.workspaceBrowser.mkdir(body));
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/workspace/remote-preflight') {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this.remoteProvisioner) {
        sendJson(res, 503, { ok: false, error: 'REMOTE_PROVISIONER_UNAVAILABLE' });
        return;
      }
      const provider = urlObj.searchParams.get('provider') || '';
      sendResult(res, await this.remoteProvisioner.preflight({ provider }));
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/workspace/github-repos') {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this.remoteProvisioner) {
        sendJson(res, 503, { ok: false, error: 'REMOTE_PROVISIONER_UNAVAILABLE' });
        return;
      }
      const owner = urlObj.searchParams.get('owner') || '';
      const limitParam = urlObj.searchParams.get('limit');
      sendResult(res, await this.remoteProvisioner.listGithubRepos({
        owner,
        limit: limitParam ? Number(limitParam) : undefined
      }));
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/projects/remote-jobs') {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (!this.remoteProvisioner) {
        sendJson(res, 503, { ok: false, error: 'REMOTE_PROVISIONER_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      sendResult(res, await this.remoteProvisioner.startJob(body), 202);
      return;
    }

    if (method === 'GET' && (match = pathname.match(/^\/api\/v1\/projects\/remote-jobs\/([^/]+)$/))) {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this.remoteProvisioner) {
        sendJson(res, 503, { ok: false, error: 'REMOTE_PROVISIONER_UNAVAILABLE' });
        return;
      }
      const jobId = decodeURIComponent(match[1]);
      sendResult(res, this.remoteProvisioner.getJob(jobId));
      return;
    }

    if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/projects\/remote-jobs\/([^/]+)\/cancel$/))) {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this.remoteProvisioner) {
        sendJson(res, 503, { ok: false, error: 'REMOTE_PROVISIONER_UNAVAILABLE' });
        return;
      }
      const jobId = decodeURIComponent(match[1]);
      sendResult(res, await this.remoteProvisioner.cancelJob(jobId));
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/projects') {
      if (typeof h.listProjects === 'function') {
        sendResult(res, await h.listProjects());
        return;
      }
      if (typeof h.getSessionOrg === 'function') {
        sendResult(res, await h.getSessionOrg());
        return;
      }
      sendJson(res, 200, { ok: true, projects: [], groups: [] });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/projects') {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.createProject !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SESSION_ORG_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      sendResult(res, await h.createProject(body));
      return;
    }

    if (method === 'PATCH' && (match = pathname.match(/^\/api\/v1\/projects\/([^/]+)$/))) {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.updateProject !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SESSION_ORG_UNAVAILABLE' });
        return;
      }
      const id = decodeURIComponent(match[1]);
      const body = await readJsonBody(req);
      sendResult(res, await h.updateProject(id, body));
      return;
    }

    if (method === 'DELETE' && (match = pathname.match(/^\/api\/v1\/projects\/([^/]+)$/))) {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.deleteProject !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SESSION_ORG_UNAVAILABLE' });
        return;
      }
      const id = decodeURIComponent(match[1]);
      sendResult(res, await h.deleteProject(id));
      return;
    }

    if (method === 'GET' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/queue$/))) {
      const id = decodeURIComponent(match[1]);
      if (typeof h.listQueue === 'function') {
        const result = await h.listQueue(id);
        sendResult(res, result);
        return;
      }
      const queue = this.sseBroker ? this.sseBroker.listQueue(id) : [];
      sendJson(res, 200, { ok: true, cascadeId: id, queue });
      return;
    }

    if (method === 'DELETE' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/queue\/([^/]+)$/))) {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      const id = decodeURIComponent(match[1]);
      const queueId = decodeURIComponent(match[2]);
      if (typeof h.removeQueuedMessage === 'function') {
        const result = await h.removeQueuedMessage(id, queueId);
        sendResult(res, result);
        return;
      }
      if (!this.sseBroker) {
        sendJson(res, 503, { ok: false, error: 'SSE_BROKER_UNAVAILABLE' });
        return;
      }
      const result = this.sseBroker.removeQueuedMessage(id, queueId);
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/queue\/([^/]+)\/steer$/))) {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      const id = decodeURIComponent(match[1]);
      const queueId = decodeURIComponent(match[2]);
      await readJsonBody(req);
      if (typeof h.steerQueuedMessage === 'function') {
        const result = await h.steerQueuedMessage(id, queueId);
        sendResult(res, result);
        return;
      }
      if (!this.sseBroker || typeof this.sseBroker.steerQueuedMessage !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SSE_BROKER_UNAVAILABLE' });
        return;
      }
      const result = await this.sseBroker.steerQueuedMessage(id, queueId);
      sendResult(res, result);
      return;
    }

    if (method === 'GET' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/))) {
      if (typeof h.getSessionDetail !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SESSIONS_UNAVAILABLE' });
        return;
      }
      const id = decodeURIComponent(match[1]);
      const result = await h.getSessionDetail(id);
      if (!result) {
        sendJson(res, 404, { ok: false, error: 'SESSION_NOT_FOUND' });
        return;
      }
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/))) {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.sendMessage !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SESSIONS_UNAVAILABLE' });
        return;
      }
      const id = decodeURIComponent(match[1]);
      const body = await readJsonBody(req);
      const hasText = typeof body.text === 'string' && body.text.trim().length > 0;
      const hasImages = Array.isArray(body.images) && body.images.length > 0;
      if (!hasText && !hasImages) {
        sendJson(res, 400, { ok: false, error: 'INVALID_MESSAGE_TEXT' });
        return;
      }
      const result = await h.sendMessage(id, body);
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/cancel$/))) {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.cancelSession !== 'function') {
        sendJson(res, 503, { ok: false, error: 'SESSIONS_UNAVAILABLE' });
        return;
      }
      const id = decodeURIComponent(match[1]);
      await readJsonBody(req);
      const result = await h.cancelSession(id);
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/steps\/(\d+)\/approve$/))) {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.approveStep !== 'function') {
        sendJson(res, 503, { ok: false, error: 'APPROVAL_UNAVAILABLE' });
        return;
      }
      const id = decodeURIComponent(match[1]);
      const seq = Number(match[2]);
      const body = await readJsonBody(req);
      const result = await h.approveStep(id, seq, body.decision, body.payload || body);
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && (match = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/steps\/(\d+)\/answer$/))) {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.answerStep !== 'function') {
        sendJson(res, 503, { ok: false, error: 'ANSWER_UNAVAILABLE' });
        return;
      }
      const id = decodeURIComponent(match[1]);
      const seq = Number(match[2]);
      const body = await readJsonBody(req);
      const result = await h.answerStep(id, seq, body.answers, body);
      sendResult(res, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/composer/presets') {
      if (typeof h.getComposerPresets === 'function') {
        const result = await h.getComposerPresets();
        sendResult(res, result);
        return;
      }
      sendJson(res, 200, { ok: true, presets: [], quickPrompts: [], frequentPrompts: [] });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/composer/optimize') {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.optimizePrompt !== 'function') {
        sendJson(res, 503, { ok: false, error: 'COMPOSER_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const result = await h.optimizePrompt(body.text || '', body);
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/orchestrator/thinking') {
      if (!this._requirePermission(res, 'L1')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, `${method} ${pathname}`)) return;
      if (typeof h.updateOrchestratorThinking !== 'function') {
        sendJson(res, 503, { ok: false, error: 'ORCHESTRATOR_CONFIG_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const result = await h.updateOrchestratorThinking(body);
      sendResult(res, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/git/diff') {
      if (!this.mobileWorkspace) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_UNAVAILABLE' });
        return;
      }
      const root = urlObj.searchParams.get('root') || '';
      const relPath = urlObj.searchParams.get('path') || undefined;
      const result = await this.mobileWorkspace.getGitDiff({ root, path: relPath });
      sendResult(res, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/git/worktrees') {
      if (!this.mobileWorkspace) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_UNAVAILABLE' });
        return;
      }
      const root = urlObj.searchParams.get('root') || '';
      const result = await this.mobileWorkspace.listWorktrees({ root });
      if (result && result.ok) {
        const cur = Array.isArray(result.worktrees) ? result.worktrees.find((w) => w.isCurrent) : null;
        sendResult(res, { ...result, current: cur ? cur.path : '' });
        return;
      }
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/git/stage') {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, pathname)) return;
      if (!this.mobileWorkspace) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const result = await this.mobileWorkspace.gitStage({
        root: body.root,
        paths: body.paths,
        unstage: Boolean(body.unstage)
      });
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/git/commit') {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, pathname)) return;
      if (!this.mobileWorkspace) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const result = await this.mobileWorkspace.gitCommit({
        root: body.root,
        message: body.message
      });
      if (result && result.ok && result.commitSha && !result.hash) {
        result.hash = result.commitSha;
      }
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/git/push') {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, pathname)) return;
      if (!this.mobileWorkspace) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const result = await this.mobileWorkspace.gitPush({
        root: body.root,
        remote: body.remote,
        branch: body.branch
      });
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/git/worktree') {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, pathname)) return;
      if (!this.mobileWorkspace) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const rawAction = String(body.action || '').trim().toLowerCase();
      if (rawAction === 'switch') {
        const wtRes = await this.mobileWorkspace.listWorktrees({ root: body.root });
        if (!wtRes.ok) {
          sendResult(res, wtRes);
          return;
        }
        const matched = (wtRes.worktrees || []).find((w) => w.path === body.path);
        if (!matched) {
          sendJson(res, 404, { ok: false, error: 'WORKTREE_NOT_FOUND' });
          return;
        }
        sendJson(res, 200, { ok: true, action: 'switch', current: matched.path, worktrees: wtRes.worktrees });
        return;
      }
      const mappedAction = rawAction === 'create' ? 'add' : rawAction;
      const result = await this.mobileWorkspace.gitWorktree({
        root: body.root,
        action: mappedAction,
        path: body.path,
        branch: body.branch,
        createBranch: Boolean(body.createBranch)
      });
      sendResult(res, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/fs/tree') {
      if (!this.mobileWorkspace) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_UNAVAILABLE' });
        return;
      }
      const root = urlObj.searchParams.get('root') || '';
      const relPath = urlObj.searchParams.get('path') || '';
      const depthRaw = urlObj.searchParams.get('depth');
      const depth = depthRaw !== null ? Number(depthRaw) : 2;
      const result = await this.mobileWorkspace.listTree({
        root,
        path: relPath,
        depth: Number.isFinite(depth) ? depth : 2
      });
      if (result && result.ok) {
        sendResult(res, { ...result, entries: normalizeTreeEntries(result.entries) });
        return;
      }
      sendResult(res, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/fs/read') {
      if (!this.mobileWorkspace) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_UNAVAILABLE' });
        return;
      }
      const root = urlObj.searchParams.get('root') || '';
      const relPath = urlObj.searchParams.get('path') || '';
      const result = await this.mobileWorkspace.readFile({ root, path: relPath });
      sendResult(res, result);
      return;
    }

    if (method === 'PUT' && pathname === '/api/v1/fs/write') {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this._requireCloudflareConfirm(req, res, channel, pathname)) return;
      if (!this.mobileWorkspace) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const result = await this.mobileWorkspace.writeFile({
        root: body.root,
        path: body.path,
        content: body.content
      });
      sendResult(res, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/artifacts') {
      if (!this.mobileWorkspace) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_UNAVAILABLE' });
        return;
      }
      const sessionId = urlObj.searchParams.get('sessionId') || '';
      const file = urlObj.searchParams.get('file') || '';
      if (file) {
        const resArt = await this.mobileWorkspace.readArtifact(sessionId, file, { binary: true });
        if (resArt && resArt.ok && Buffer.isBuffer(resArt.content)) {
          const isImg = String(resArt.mime || '').startsWith('image/');
          sendResult(res, {
            ...resArt,
            ...(isImg
              ? {
                  dataUrl: `data:${resArt.mime};base64,${resArt.content.toString('base64')}`,
                  content: undefined
                }
              : { content: resArt.content.toString('utf8') })
          });
          return;
        }
        sendResult(res, resArt);
        return;
      }
      const result = await this.mobileWorkspace.listArtifacts(sessionId);
      sendResult(res, result);
      return;
    }

    if (method === 'GET' && (match = pathname.match(/^\/api\/v1\/artifacts\/([^/]+)\/(.+)$/))) {
      if (!this.mobileWorkspace) {
        sendJson(res, 503, { ok: false, error: 'WORKSPACE_UNAVAILABLE' });
        return;
      }
      const sessionId = decodeURIComponent(match[1]);
      const name = decodeURIComponent(match[2]);
      const resArt = await this.mobileWorkspace.readArtifact(sessionId, name, { binary: true });
      if (resArt && resArt.ok && Buffer.isBuffer(resArt.content)) {
        const isImg = String(resArt.mime || '').startsWith('image/');
        sendResult(res, {
          ...resArt,
          ...(isImg
            ? {
                dataUrl: `data:${resArt.mime};base64,${resArt.content.toString('base64')}`,
                content: undefined
              }
            : { content: resArt.content.toString('utf8') })
        });
        return;
      }
      sendResult(res, resArt);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/push/vapid-key') {
      if (!this.webPush) {
        sendJson(res, 503, { ok: false, error: 'PUSH_UNAVAILABLE' });
        return;
      }
      const publicKey = this.webPush.getPublicKey();
      sendJson(res, 200, { ok: true, publicKey, vapidPublicKey: publicKey });
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/push/subscribe') {
      if (!this.webPush) {
        sendJson(res, 503, { ok: false, error: 'PUSH_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const sub = body.subscription && typeof body.subscription === 'object' ? body.subscription : body;
      const result = this.webPush.subscribe(sub, { clientId, channel });
      sendResult(res, result);
      return;
    }

    if (method === 'DELETE' && pathname === '/api/v1/push/subscribe') {
      if (!this.webPush) {
        sendJson(res, 503, { ok: false, error: 'PUSH_UNAVAILABLE' });
        return;
      }
      const body = await readJsonBody(req);
      const endpoint = body.endpoint || urlObj.searchParams.get('endpoint') || '';
      const result = this.webPush.unsubscribe(endpoint);
      sendResult(res, result);
      return;
    }

    if (method === 'POST' && pathname === '/api/v1/push/test') {
      if (!this.webPush) {
        sendJson(res, 503, { ok: false, error: 'PUSH_UNAVAILABLE' });
        return;
      }
      await readJsonBody(req);
      const result = await this.webPush.sendTestNotification();
      sendResult(res, result);
      return;
    }

    if (method === 'GET' && pathname === '/api/v1/pty/sessions') {
      if (!this._requirePermission(res, 'L2')) return;
      if (!this.ptyManager) {
        sendJson(res, 503, { ok: false, error: 'PTY_UNAVAILABLE' });
        return;
      }
      const list = this.ptyManager.listSessions().map((s) => ({
        ...s,
        id: s.sessionId || s.id
      }));
      sendJson(res, 200, { ok: true, sessions: list });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
  }

  async stop() {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.port = null;
    try { srv.closeIdleConnections?.(); } catch {}
    try { srv.closeAllConnections?.(); } catch {}
    for (const sock of this.sockets) {
      try { sock.destroy(); } catch {}
    }
    this.sockets.clear();
    await new Promise((resolve) => srv.close(() => resolve()));
  }
}

module.exports = {
  PING_GIF_BUFFER,
  SECURITY_HEADERS,
  stripPairingSecrets,
  MobileRemoteServer,
  buildMobileHtml: generatePwaHtml
};
