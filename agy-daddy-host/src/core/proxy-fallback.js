'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'proxy-connection'
]);

function stripHopByHopHeaders(headers = {}) {
  const out = {};
  const connTokens = new Set(
    String(headers.connection || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk) || connTokens.has(lk)) continue;
    out[k] = v;
  }
  return out;
}

function parseAuthority(rawAuthority, defaultPort = 443) {
  const raw = String(rawAuthority || '').trim();
  if (!raw) return null;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return null;
    const host = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : defaultPort;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port };
  }
  const idx = raw.lastIndexOf(':');
  if (idx === -1) {
    return { host: raw, port: defaultPort };
  }
  const host = raw.slice(0, idx);
  const port = Number(raw.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function parseProxyPortFromCommand(command = '') {
  const cmd = String(command || '');
  if (!cmd) return null;
  const match = cmd.match(/--proxy-server=(?:"|')?(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})(?:"|'|\s|$)/i);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function hasProxyServerArg(command = '') {
  return /--proxy-server(?:=|\s)/i.test(String(command || ''));
}

function resolveRequestTarget(clientReq) {
  const rawUrl = String(clientReq.url || '');
  if (/^https?:\/\//i.test(rawUrl)) {
    const u = new URL(rawUrl);
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return { url: u, hostname: u.hostname.replace(/^\[|\]$/g, ''), port };
  }
  const hostHeader = String(clientReq.headers.host || '').trim();
  if (!hostHeader) return null;
  const u = new URL(`http://${hostHeader}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`);
  const port = Number(u.port || 80);
  return { url: u, hostname: u.hostname.replace(/^\[|\]$/g, ''), port };
}

/**
 * 停用代理插件后在当前宿主会话期内维持本地固定回环端口（默认 18766）纯直连兜底，
 * 避免仍在运行中的 Antigravity / language_server 因 --proxy-server= 参数无法热撤销而断网。
 */
class DirectProxyFallbackServer {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.requestedPort = Number(options.port) > 0 ? Number(options.port) : 18766;
    this.port = 0;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
    this.httpTimeoutMs = Number(options.httpTimeoutMs) > 0 ? Number(options.httpTimeoutMs) : 120000;
    this.server = null;
    this.sockets = new Set();
    this.stats = {
      totalRequests: 0,
      totalConnects: 0,
      directCount: 0,
      errorCount: 0,
      lastError: null
    };
  }

  trackSocket(socket) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    return socket;
  }

  handleHttpRequest(clientReq, clientRes) {
    this.stats.totalRequests++;
    let target = null;
    try {
      target = resolveRequestTarget(clientReq);
    } catch {
      target = null;
    }
    if (!target || !target.hostname) {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      clientRes.end('Bad Request');
      return;
    }
    if ((target.hostname === '127.0.0.1' || target.hostname === 'localhost') && target.port === this.port) {
      clientRes.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      clientRes.end('Loopback request to proxy port rejected');
      return;
    }

    this.stats.directCount++;
    const mod = target.url.protocol === 'https:' ? https : http;
    const upstreamReq = mod.request({
      hostname: target.hostname,
      port: target.port,
      method: clientReq.method,
      path: `${target.url.pathname}${target.url.search}`,
      headers: stripHopByHopHeaders(clientReq.headers),
      agent: false
    }, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode || 502, stripHopByHopHeaders(upstreamRes.headers));
      upstreamRes.pipe(clientRes);
    });

    upstreamReq.setTimeout(this.httpTimeoutMs, () => {
      upstreamReq.destroy(new Error('Direct fallback HTTP timeout'));
    });
    upstreamReq.on('error', (err) => {
      this.stats.errorCount++;
      this.stats.lastError = err.message;
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        clientRes.end(`Bad Gateway: ${err.message}`);
      } else {
        clientRes.destroy(err);
      }
    });
    clientReq.pipe(upstreamReq);
  }

  handleConnect(req, clientSocket, head) {
    this.stats.totalConnects++;
    const parsedTarget = parseAuthority(req.url, 443);
    if (!parsedTarget) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if ((parsedTarget.host === '127.0.0.1' || parsedTarget.host === 'localhost') && parsedTarget.port === this.port) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    this.stats.directCount++;
    let settled = false;
    const tunnelSocket = net.connect({ host: parsedTarget.host, port: parsedTarget.port });
    this.trackSocket(tunnelSocket);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      this.stats.errorCount++;
      this.stats.lastError = `Direct TCP connect timeout: ${parsedTarget.host}:${parsedTarget.port}`;
      tunnelSocket.destroy();
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
      }
    }, this.timeoutMs);

    tunnelSocket.once('connect', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (clientSocket.destroyed) {
        tunnelSocket.destroy();
        return;
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: agy-daddy-direct-fallback\r\n\r\n');
      if (head && head.length > 0) {
        tunnelSocket.write(head);
      }
      const tearDown = () => {
        if (!clientSocket.destroyed) clientSocket.destroy();
        if (!tunnelSocket.destroyed) tunnelSocket.destroy();
      };
      clientSocket.on('error', tearDown);
      tunnelSocket.on('error', tearDown);
      tunnelSocket.pipe(clientSocket);
      clientSocket.pipe(tunnelSocket);
    });

    tunnelSocket.once('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      this.stats.errorCount++;
      this.stats.lastError = err.message;
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    });
  }

  async start(port = this.requestedPort) {
    if (this.server) return this.getStats();
    const listenPort = Number.isInteger(Number(port)) ? Number(port) : this.requestedPort;
    const srv = http.createServer((req, res) => this.handleHttpRequest(req, res));
    srv.on('connection', (sock) => this.trackSocket(sock));
    srv.on('connect', (req, sock, head) => {
      this.handleConnect(req, sock, head);
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      srv.once('error', onError);
      srv.listen(listenPort, this.host, () => {
        srv.removeListener('error', onError);
        this.server = srv;
        this.port = srv.address().port;
        resolve();
      });
    });

    return this.getStats();
  }

  getStats() {
    return {
      listening: Boolean(this.server),
      host: this.host,
      port: this.port,
      mode: 'direct',
      forcedDirect: true,
      activeConnections: this.sockets.size,
      ...this.stats
    };
  }

  async stop() {
    const srv = this.server;
    this.server = null;
    this.port = 0;
    for (const sock of Array.from(this.sockets)) {
      try { sock.destroy(); } catch {}
    }
    this.sockets.clear();
    if (!srv) return;
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
  DirectProxyFallbackServer,
  parseProxyPortFromCommand,
  hasProxyServerArg
};
