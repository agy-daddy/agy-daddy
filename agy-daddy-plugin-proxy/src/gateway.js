'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_NO_PROXY,
  normalizeProxyUrl,
  redactProxyUrl,
  parseAndValidateProxyUrl,
  matchesNoProxy
} = require('./proxy-config');
const { connectViaSocks5 } = require('./socks5-client');

function stripHopByHopHeaders(rawHeaders, stripProxyHeaders = true) {
  const out = {};
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    const lk = k.toLowerCase();
    if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding' || lk === 'te' || lk === 'trailer' || lk === 'upgrade') {
      continue;
    }
    if (stripProxyHeaders && (lk === 'proxy-connection' || lk === 'proxy-authenticate' || lk === 'proxy-authorization')) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function buildBasicProxyAuthHeader(username, password) {
  if (!username && !password) return null;
  return 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

function isLoopbackHost(hostname) {
  const clean = String(hostname || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!clean) return false;
  if (clean === 'localhost' || clean === '::1' || clean === '0:0:0:0:0:0:0:1') return true;
  if (clean === '127.0.0.1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  return false;
}

function buildGatewayErrorHeaders(clientReq, extra = {}) {
  const headers = { ...extra };
  const origin = clientReq?.headers?.origin;
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
    headers['Access-Control-Allow-Private-Network'] = 'true';
  }
  return headers;
}

function parseAuthority(rawAuthority, defaultPort = 443) {
  const s = String(rawAuthority || '').trim();
  if (!s) return null;
  if (s.startsWith('[')) {
    const endIdx = s.indexOf(']');
    if (endIdx < 0) return null;
    const host = s.slice(1, endIdx);
    const rest = s.slice(endIdx + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : defaultPort;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port, authority: `[${host}]:${port}` };
  }
  const colon = s.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(s.slice(colon + 1))) {
    const host = s.slice(0, colon);
    const port = Number(s.slice(colon + 1));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host, port, authority: `${host}:${port}` };
  }
  return { host: s, port: defaultPort, authority: `${s}:${defaultPort}` };
}

function connectTcp(host, port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('error', onError);
      socket.off('connect', onConnect);
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { socket.destroy(); } catch {}
      reject(err);
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const timer = setTimeout(() => {
      onError(new Error(`Direct TCP connect timeout to ${host}:${port}`));
    }, timeoutMs);
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

function connectViaHttpTunnel({ upstream, targetHost, targetPort, timeoutMs = 8000 }) {
  const targetAuthority = targetHost.includes(':') ? `[${targetHost}]:${targetPort}` : `${targetHost}:${targetPort}`;
  return new Promise((resolve, reject) => {
    const isTlsUpstream = upstream.protocol === 'https:';
    const socket = isTlsUpstream
      ? tls.connect({ host: upstream.hostname, port: upstream.port, servername: upstream.hostname })
      : net.connect({ host: upstream.hostname, port: upstream.port });

    let settled = false;
    let buf = Buffer.alloc(0);

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { socket.destroy(); } catch {}
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const timer = setTimeout(() => {
      fail(new Error(`Upstream HTTP CONNECT timeout (${upstream.hostname}:${upstream.port})`));
    }, timeoutMs);

    const onError = (err) => fail(err);
    const onClose = () => fail(new Error('Upstream proxy closed connection during CONNECT'));

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        if (buf.length > 32768) fail(new Error('Upstream CONNECT response header too large'));
        return;
      }
      const headStr = buf.subarray(0, headerEnd).toString('latin1');
      const trailing = buf.subarray(headerEnd + 4);
      const statusLine = headStr.split('\r\n')[0] || '';
      const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/i);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
      if (statusCode < 200 || statusCode >= 300) {
        return fail(new Error(`Upstream CONNECT rejected (${statusLine || 'invalid response'})`));
      }

      settled = true;
      cleanup();
      if (trailing.length > 0) {
        socket.unshift(trailing);
      }
      resolve(socket);
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);

    const connectEvent = isTlsUpstream ? 'secureConnect' : 'connect';
    socket.once(connectEvent, () => {
      const auth = buildBasicProxyAuthHeader(upstream.username, upstream.password);
      const lines = [
        `CONNECT ${targetAuthority} HTTP/1.1`,
        `Host: ${targetAuthority}`,
        ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
        'Proxy-Connection: Keep-Alive',
        '',
        ''
      ];
      socket.write(lines.join('\r\n'));
    });
  });
}

class LocalProxyGateway {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this.requestedPort = options.port !== undefined ? Number(options.port) : DEFAULT_GATEWAY_PORT;
    this.port = 0;
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
    this.httpTimeoutMs = Number(options.httpTimeoutMs) > 0 ? Number(options.httpTimeoutMs) : Math.max(this.timeoutMs, 120000);
    this.loopbackHttpTimeoutMs = options.loopbackHttpTimeoutMs !== undefined ? Math.max(0, Number(options.loopbackHttpTimeoutMs) || 0) : 0;
    this.config = {
      mode: options.mode === 'upstream' ? 'upstream' : 'direct',
      upstreamUrl: normalizeProxyUrl(options.upstreamUrl || ''),
      noProxy: options.noProxy !== undefined ? String(options.noProxy) : DEFAULT_NO_PROXY,
      fallbackToDirectOnUpstreamError: Boolean(options.fallbackToDirectOnUpstreamError)
    };
    this.server = null;
    this.sockets = new Set();
    this.stats = {
      totalRequests: 0,
      totalConnects: 0,
      directCount: 0,
      upstreamCount: 0,
      bypassCount: 0,
      fallbackCount: 0,
      errorCount: 0,
      lastError: null
    };
  }

  updateConfig(nextConfig = {}) {
    const nextMode = nextConfig.mode !== undefined
      ? (nextConfig.mode === 'upstream' ? 'upstream' : 'direct')
      : this.config.mode;
    const nextUpstream = nextConfig.upstreamUrl !== undefined
      ? normalizeProxyUrl(nextConfig.upstreamUrl)
      : this.config.upstreamUrl;

    if (nextMode === 'upstream') {
      if (!nextUpstream) {
        throw new Error('upstreamUrl is required when switching gateway to upstream mode');
      }
      const checked = parseAndValidateProxyUrl(nextUpstream);
      if (!checked.ok) {
        throw new Error(checked.error);
      }
    } else if (nextUpstream) {
      const checked = parseAndValidateProxyUrl(nextUpstream);
      if (!checked.ok) {
        throw new Error(checked.error);
      }
    }

    this.config = {
      mode: nextMode,
      upstreamUrl: nextUpstream,
      noProxy: nextConfig.noProxy !== undefined ? String(nextConfig.noProxy) : this.config.noProxy,
      fallbackToDirectOnUpstreamError: nextConfig.fallbackToDirectOnUpstreamError !== undefined
        ? Boolean(nextConfig.fallbackToDirectOnUpstreamError)
        : this.config.fallbackToDirectOnUpstreamError
    };
    return this.getStats();
  }

  resolveRoute(hostname) {
    if (this.config.mode !== 'upstream' || !this.config.upstreamUrl) {
      return { type: 'direct', bypassed: false };
    }
    if (matchesNoProxy(hostname, this.config.noProxy)) {
      return { type: 'direct', bypassed: true };
    }
    const upstream = parseAndValidateProxyUrl(this.config.upstreamUrl);
    if (!upstream.ok) {
      throw new Error(upstream.error);
    }
    return { type: 'upstream', bypassed: false, upstream };
  }

  trackSocket(socket) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    return socket;
  }

  resolveRequestTarget(clientReq) {
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

  sendHttpDirect(target, clientReq, clientRes) {
    const mod = target.url.protocol === 'https:' ? https : http;
    const isLoopback = isLoopbackHost(target.hostname);
    const reqTimeoutMs = isLoopback ? this.loopbackHttpTimeoutMs : this.httpTimeoutMs;
    const upstreamReq = mod.request({
      hostname: target.hostname,
      port: target.port,
      method: clientReq.method,
      path: `${target.url.pathname}${target.url.search}`,
      headers: stripHopByHopHeaders(clientReq.headers, true),
      agent: false
    }, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode || 502, stripHopByHopHeaders(upstreamRes.headers, true));
      upstreamRes.pipe(clientRes);
    });

    if (reqTimeoutMs > 0) {
      upstreamReq.setTimeout(reqTimeoutMs, () => upstreamReq.destroy(new Error('Direct HTTP request timeout')));
    }
    upstreamReq.on('error', (err) => {
      this.stats.errorCount++;
      this.stats.lastError = err.message;
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, buildGatewayErrorHeaders(clientReq, { 'Content-Type': 'text/plain; charset=utf-8' }));
        clientRes.end(`Bad Gateway: ${err.message}`);
      } else {
        clientRes.destroy(err);
      }
    });
    clientReq.pipe(upstreamReq);
  }

  async sendHttpViaSocks5(target, upstream, clientReq, clientRes) {
    clientReq.pause();
    let socksSocket;
    try {
      socksSocket = await connectViaSocks5({
        proxyHost: upstream.hostname,
        proxyPort: upstream.port,
        username: upstream.username,
        password: upstream.password,
        targetHost: target.hostname,
        targetPort: target.port,
        timeoutMs: this.timeoutMs
      });
      this.trackSocket(socksSocket);
    } catch (err) {
      if (this.config.fallbackToDirectOnUpstreamError) {
        this.stats.fallbackCount++;
        this.stats.directCount++;
        clientReq.resume();
        this.sendHttpDirect(target, clientReq, clientRes);
        return;
      }
      clientReq.resume();
      this.stats.errorCount++;
      this.stats.lastError = err.message;
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, buildGatewayErrorHeaders(clientReq, { 'Content-Type': 'text/plain; charset=utf-8' }));
        clientRes.end(`Bad Gateway (SOCKS5): ${err.message}`);
      }
      return;
    }

    const upstreamReq = http.request({
      hostname: target.hostname,
      port: target.port,
      method: clientReq.method,
      path: `${target.url.pathname}${target.url.search}`,
      headers: stripHopByHopHeaders(clientReq.headers, true),
      agent: false,
      createConnection: () => socksSocket
    }, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode || 502, stripHopByHopHeaders(upstreamRes.headers, true));
      upstreamRes.pipe(clientRes);
    });

    if (this.httpTimeoutMs > 0) {
      upstreamReq.setTimeout(this.httpTimeoutMs, () => upstreamReq.destroy(new Error('SOCKS5 HTTP forward timeout')));
    }
    upstreamReq.on('error', (err) => {
      this.stats.errorCount++;
      this.stats.lastError = err.message;
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, buildGatewayErrorHeaders(clientReq, { 'Content-Type': 'text/plain; charset=utf-8' }));
        clientRes.end(`Bad Gateway: ${err.message}`);
      } else {
        clientRes.destroy(err);
      }
    });
    clientReq.resume();
    clientReq.pipe(upstreamReq);
  }

  sendHttpViaHttpUpstream(target, upstream, clientReq, clientRes) {
    const mod = upstream.protocol === 'https:' ? https : http;
    const headers = stripHopByHopHeaders(clientReq.headers, true);
    headers.Host = target.url.host;
    const auth = buildBasicProxyAuthHeader(upstream.username, upstream.password);
    if (auth) {
      headers['Proxy-Authorization'] = auth;
    }

    const forwardPath = `${target.url.protocol}//${target.url.host}${target.url.pathname}${target.url.search}`;
    let settledRes = false;

    const upstreamReq = mod.request({
      hostname: upstream.hostname,
      port: upstream.port,
      method: clientReq.method,
      path: forwardPath,
      headers,
      agent: false
    }, (upstreamRes) => {
      settledRes = true;
      clientRes.writeHead(upstreamRes.statusCode || 502, stripHopByHopHeaders(upstreamRes.headers, true));
      upstreamRes.pipe(clientRes);
    });

    if (this.httpTimeoutMs > 0) {
      upstreamReq.setTimeout(this.httpTimeoutMs, () => upstreamReq.destroy(new Error('HTTP upstream request timeout')));
    }
    upstreamReq.on('error', (err) => {
      if (!settledRes && !clientRes.headersSent && this.config.fallbackToDirectOnUpstreamError && ['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(String(clientReq.method || 'GET').toUpperCase())) {
        this.stats.fallbackCount++;
        this.stats.directCount++;
        this.sendHttpDirect(target, clientReq, clientRes);
        return;
      }
      this.stats.errorCount++;
      this.stats.lastError = err.message;
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, buildGatewayErrorHeaders(clientReq, { 'Content-Type': 'text/plain; charset=utf-8' }));
        clientRes.end(`Bad Gateway (HTTP upstream): ${err.message}`);
      } else {
        clientRes.destroy(err);
      }
    });
    clientReq.pipe(upstreamReq);
  }

  handleHttpRequest(clientReq, clientRes) {
    this.stats.totalRequests++;
    let target;
    try {
      target = this.resolveRequestTarget(clientReq);
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

    let route;
    try {
      route = this.resolveRoute(target.hostname);
    } catch (err) {
      this.stats.errorCount++;
      this.stats.lastError = err.message;
      clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      clientRes.end(`Invalid upstream proxy config: ${err.message}`);
      return;
    }

    if (route.bypassed) this.stats.bypassCount++;
    if (route.type === 'direct') {
      this.stats.directCount++;
      this.sendHttpDirect(target, clientReq, clientRes);
      return;
    }

    this.stats.upstreamCount++;
    if (route.upstream.isSocks) {
      void this.sendHttpViaSocks5(target, route.upstream, clientReq, clientRes);
    } else {
      this.sendHttpViaHttpUpstream(target, route.upstream, clientReq, clientRes);
    }
  }

  async openTunnelSocket(parsedTarget, route) {
    if (route.type === 'direct') {
      return connectTcp(parsedTarget.host, parsedTarget.port, this.timeoutMs);
    }
    try {
      if (route.upstream.isSocks) {
        return await connectViaSocks5({
          proxyHost: route.upstream.hostname,
          proxyPort: route.upstream.port,
          username: route.upstream.username,
          password: route.upstream.password,
          targetHost: parsedTarget.host,
          targetPort: parsedTarget.port,
          timeoutMs: this.timeoutMs
        });
      }
      return await connectViaHttpTunnel({
        upstream: route.upstream,
        targetHost: parsedTarget.host,
        targetPort: parsedTarget.port,
        timeoutMs: this.timeoutMs
      });
    } catch (err) {
      if (this.config.fallbackToDirectOnUpstreamError) {
        this.stats.fallbackCount++;
        return connectTcp(parsedTarget.host, parsedTarget.port, this.timeoutMs);
      }
      throw err;
    }
  }

  async handleConnect(req, clientSocket, head) {
    this.stats.totalConnects++;
    const parsedTarget = parseAuthority(req.url, 443);
    if (!parsedTarget) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    let route;
    try {
      route = this.resolveRoute(parsedTarget.host);
    } catch (err) {
      this.stats.errorCount++;
      this.stats.lastError = err.message;
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }

    if (route.bypassed) this.stats.bypassCount++;
    if (route.type === 'direct') this.stats.directCount++;
    else this.stats.upstreamCount++;

    let tunnelSocket;
    try {
      tunnelSocket = await this.openTunnelSocket(parsedTarget, route);
      this.trackSocket(tunnelSocket);
    } catch (err) {
      this.stats.errorCount++;
      this.stats.lastError = err.message;
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
      return;
    }

    if (clientSocket.destroyed) {
      tunnelSocket.destroy();
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: agy-daddy-proxy\r\n\r\n');
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
  }

  async start(port = this.requestedPort) {
    if (this.server) return this.getStats();
    const listenPort = Number.isInteger(Number(port)) ? Number(port) : DEFAULT_GATEWAY_PORT;
    const srv = http.createServer((req, res) => this.handleHttpRequest(req, res));
    srv.on('connection', (sock) => this.trackSocket(sock));
    srv.on('connect', (req, sock, head) => {
      void this.handleConnect(req, sock, head);
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        if (err?.code === 'EADDRINUSE') {
          const occupied = new Error(`GATEWAY_PORT_OCCUPIED: 127.0.0.1:${listenPort} is already in use`);
          occupied.code = 'GATEWAY_PORT_OCCUPIED';
          occupied.port = listenPort;
          reject(occupied);
          return;
        }
        reject(err);
      };
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
      mode: this.config.mode,
      upstreamUrl: redactProxyUrl(this.config.upstreamUrl),
      hasUpstream: Boolean(this.config.upstreamUrl),
      noProxy: this.config.noProxy,
      fallbackToDirectOnUpstreamError: this.config.fallbackToDirectOnUpstreamError,
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
  LocalProxyGateway,
  parseAuthority,
  buildBasicProxyAuthHeader
};
