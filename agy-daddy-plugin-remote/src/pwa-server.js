'use strict';

const http = require('node:http');
const {
  DEFAULT_CHANNELS,
  classifyRequestChannel,
  isChannelAllowed,
  safeTokenEqual
} = require('./tunnel-security');
const { generatePwaHtml } = require('./pwa-html');

const MAX_ACTION_BODY_BYTES = 15 * 1024 * 1024;
const PING_GIF_BUFFER = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* http://localhost:* https:; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
});

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

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_ACTION_BODY_BYTES) {
        reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('INVALID_JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

class MobileRemoteServer {
  constructor(options = {}) {
    this.requestedPort = Number.isInteger(options.port) ? options.port : 18765;
    this.host = options.host || '127.0.0.1';
    this.getToken = typeof options.getToken === 'function' ? options.getToken : () => '';
    this.getSnapshot = typeof options.getSnapshot === 'function' ? options.getSnapshot : async () => ({ ok: true, panels: {} });
    this.getChannels = typeof options.getChannels === 'function' ? options.getChannels : () => DEFAULT_CHANNELS;
    this.getTunnelHostname = typeof options.getTunnelHostname === 'function' ? options.getTunnelHostname : () => '';
    this.isWriteEnabled = typeof options.isWriteEnabled === 'function' ? options.isWriteEnabled : () => false;
    this.onAction = typeof options.onAction === 'function' ? options.onAction : async () => ({ ok: true });
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
        const code = err?.statusCode || 500;
        sendJson(res, code, { ok: false, error: err?.message || 'INTERNAL_ERROR' });
      }
    });

    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
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

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...SECURITY_HEADERS
      });
      res.end(generatePwaHtml({ version: '2.0.0' }));
      return;
    }

    if (method === 'GET' && pathname === '/api/ping') {
      sendJson(res, 200, {
        ok: true,
        service: 'agy-daddy-remote',
        channel,
        writeEnabled: Boolean(this.isWriteEnabled())
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/ping-gif') {
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Content-Length': String(PING_GIF_BUFFER.length),
        ...SECURITY_HEADERS
      });
      res.end(PING_GIF_BUFFER);
      return;
    }

    if (method === 'GET' && pathname === '/api/snapshot') {
      const provided = extractRequestToken(req, urlObj);
      if (!safeTokenEqual(provided, this.getToken())) {
        sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        return;
      }
      const { clientId, deviceHint } = this.recordClientVisit(req, channel);
      const snapshot = await this.getSnapshot();
      sendJson(res, 200, { ...snapshot, clientId, deviceHint, channel });
      return;
    }

    if (method === 'GET' && pathname === '/api/devices') {
      const provided = extractRequestToken(req, urlObj);
      if (!safeTokenEqual(provided, this.getToken())) {
        sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        return;
      }
      sendJson(res, 200, { ok: true, ...this.getTrackedDevices() });
      return;
    }

    if (method === 'POST' && pathname === '/api/action') {
      const provided = extractRequestToken(req, urlObj);
      if (!safeTokenEqual(provided, this.getToken())) {
        sendJson(res, 401, { ok: false, error: 'UNAUTHORIZED' });
        return;
      }
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
  MobileRemoteServer,
  buildMobileHtml: generatePwaHtml
};
