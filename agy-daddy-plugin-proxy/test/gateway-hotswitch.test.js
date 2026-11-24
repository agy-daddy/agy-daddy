'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { LocalProxyGateway } = require('../src/gateway');
const { probeConnectivity } = require('../src/probe');

function createTargetHttpServer() {
  const hits = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method, url: req.url, host: req.headers.host });
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ ok: true, targetHit: true, url: req.url }));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  return {
    hits,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      for (const s of sockets) try { s.destroy(); } catch {}
      await new Promise((resolve) => {
        server.close(() => resolve());
        try { server.closeAllConnections?.(); } catch {}
      });
    }
  };
}

function createMockHttpUpstreamServer(expectedUser, expectedPass) {
  const httpHits = [];
  const connectHits = [];
  const sockets = new Set();
  const expectedAuth = 'Basic ' + Buffer.from(`${expectedUser}:${expectedPass}`).toString('base64');

  const server = http.createServer((req, res) => {
    const authOk = req.headers['proxy-authorization'] === expectedAuth;
    httpHits.push({ url: req.url, authOk });
    if (!authOk) {
      res.writeHead(407, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('Proxy Auth Required');
      return;
    }
    const u = new URL(req.url);
    const fwd = http.request({
      hostname: u.hostname,
      port: Number(u.port || 80),
      method: req.method,
      path: `${u.pathname}${u.search}`,
      headers: { Host: u.host, Connection: 'close' },
      agent: false
    }, (tRes) => {
      res.writeHead(tRes.statusCode || 200, tRes.headers);
      tRes.pipe(res);
    });
    fwd.on('error', (err) => {
      if (!res.headersSent) { res.writeHead(502); res.end(err.message); }
    });
    req.pipe(fwd);
  });

  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });

  server.on('connect', (req, clientSock, head) => {
    sockets.add(clientSock);
    const authOk = req.headers['proxy-authorization'] === expectedAuth;
    connectHits.push({ authority: req.url, authOk });
    if (!authOk) {
      clientSock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const [host, portStr] = req.url.split(':');
    const upSock = net.connect(Number(portStr || 443), host, () => {
      sockets.add(upSock);
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upSock.write(head);
      upSock.pipe(clientSock);
      clientSock.pipe(upSock);
    });
    const tearDown = () => {
      try { clientSock.destroy(); } catch {}
      try { upSock.destroy(); } catch {}
    };
    upSock.on('error', tearDown);
    clientSock.on('error', tearDown);
  });

  return {
    httpHits,
    connectHits,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      for (const s of sockets) try { s.destroy(); } catch {}
      await new Promise((resolve) => {
        server.close(() => resolve());
        try { server.closeAllConnections?.(); } catch {}
      });
    }
  };
}

function createMockSocks5UpstreamServer(expectedUser, expectedPass) {
  const hits = [];
  const sockets = new Set();

  const server = net.createServer((clientSock) => {
    sockets.add(clientSock);
    clientSock.once('close', () => sockets.delete(clientSock));
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    let authed = false;

    const cleanupHandshake = () => {
      clientSock.off('data', onData);
    };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (stage !== 'piped') {
        if (stage === 'greeting') {
          if (buf.length < 2) return;
          const nMethods = buf[1];
          if (buf.length < 2 + nMethods) return;
          const methods = Array.from(buf.subarray(2, 2 + nMethods));
          buf = buf.subarray(2 + nMethods);
          if (methods.includes(0x02)) {
            stage = 'auth';
            clientSock.write(Buffer.from([0x05, 0x02]));
          } else {
            clientSock.end(Buffer.from([0x05, 0xff]));
            return;
          }
        } else if (stage === 'auth') {
          if (buf.length < 2) return;
          const uLen = buf[1];
          if (buf.length < 3 + uLen) return;
          const pLen = buf[2 + uLen];
          if (buf.length < 3 + uLen + pLen) return;
          const user = buf.subarray(2, 2 + uLen).toString('utf8');
          const pass = buf.subarray(3 + uLen, 3 + uLen + pLen).toString('utf8');
          buf = buf.subarray(3 + uLen + pLen);
          authed = user === expectedUser && pass === expectedPass;
          clientSock.write(Buffer.from([0x01, authed ? 0x00 : 0x01]));
          if (!authed) {
            clientSock.end();
            return;
          }
          stage = 'connect';
        } else if (stage === 'connect') {
          if (buf.length < 5) return;
          const atyp = buf[3];
          let host = '';
          let addrEnd = 0;
          if (atyp === 0x01) {
            if (buf.length < 10) return;
            host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
            addrEnd = 8;
          } else if (atyp === 0x03) {
            const dLen = buf[4];
            if (buf.length < 5 + dLen + 2) return;
            host = buf.subarray(5, 5 + dLen).toString('utf8');
            addrEnd = 5 + dLen;
          } else {
            clientSock.end();
            return;
          }
          const port = buf.readUInt16BE(addrEnd);
          const trailing = buf.subarray(addrEnd + 2);
          stage = 'piped';
          cleanupHandshake();
          hits.push({ host, port, atyp, authed });

          const remote = net.connect(port, host, () => {
            sockets.add(remote);
            clientSock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            if (trailing.length > 0) remote.write(trailing);
            remote.pipe(clientSock);
            clientSock.pipe(remote);
          });
          const tearDown = () => {
            try { clientSock.destroy(); } catch {}
            try { remote.destroy(); } catch {}
          };
          remote.on('error', tearDown);
          clientSock.on('error', tearDown);
          return;
        }
      }
    };
    clientSock.on('data', onData);
  });

  return {
    hits,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    async close() {
      for (const s of sockets) try { s.destroy(); } catch {}
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function sendHttpViaGateway(gatewayPort, targetUrl) {
  const u = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: gatewayPort,
      method: 'GET',
      path: targetUrl,
      headers: { Host: u.host, Connection: 'close' },
      agent: false
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function sendHttpInsideConnectTunnel(gatewayPort, targetHost, targetPort, pathStr) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(gatewayPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    let stage = 'connect';
    let buf = '';
    let body = '';
    sock.on('data', (chunk) => {
      if (stage === 'connect') {
        buf += chunk.toString('latin1');
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const headLine = buf.slice(0, idx).split('\r\n')[0];
        const rest = buf.slice(idx + 4);
        const code = Number((headLine.match(/^HTTP\/\d\.\d\s+(\d{3})/) || [])[1] || 0);
        if (code !== 200) {
          sock.destroy();
          resolve({ tunnelStatus: code, body: headLine });
          return;
        }
        stage = 'http';
        if (rest) body += rest;
        sock.write(`GET ${pathStr} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nConnection: close\r\n\r\n`);
      } else {
        body += chunk.toString('utf8');
      }
    });
    sock.on('end', () => resolve({ tunnelStatus: 200, body }));
    sock.on('error', reject);
  });
}

test('LocalProxyGateway: DIRECT / HTTP upstream / SOCKS5h / CONNECT / NO_PROXY 热切换与故障策略', async () => {
  const target = createTargetHttpServer();
  const httpUp = createMockHttpUpstreamServer('huser', 'hpass');
  const socksUp = createMockSocks5UpstreamServer('suser', 'spass');

  const targetPort = await target.start();
  const httpUpPort = await httpUp.start();
  const socksUpPort = await socksUp.start();

  const gateway = new LocalProxyGateway({
    port: 0,
    mode: 'direct',
    noProxy: 'localhost,bypass.internal'
  });

  try {
    const st0 = await gateway.start(0);
    assert.equal(st0.listening, true);
    assert.ok(st0.port > 0);
    const gwPort = st0.port;

    // 1. DIRECT 模式 HTTP + CONNECT
    const rDirect = await sendHttpViaGateway(gwPort, `http://127.0.0.1:${targetPort}/direct-req`);
    assert.equal(rDirect.statusCode, 200);
    assert.equal(JSON.parse(rDirect.body).url, '/direct-req');
    const cDirect = await sendHttpInsideConnectTunnel(gwPort, '127.0.0.1', targetPort, '/direct-tunnel');
    assert.equal(cDirect.tunnelStatus, 200);
    assert.match(cDirect.body, /\/direct-tunnel/);
    assert.equal(httpUp.httpHits.length, 0);
    assert.equal(socksUp.hits.length, 0);

    // 2. 免重启热切 HTTP Upstream（含 Basic Auth）+ 验证 HTTP 与 CONNECT
    gateway.updateConfig({
      mode: 'upstream',
      upstreamUrl: `http://huser:hpass@127.0.0.1:${httpUpPort}`,
      noProxy: 'no-hit.example'
    });
    const rHttpUp = await sendHttpViaGateway(gwPort, `http://127.0.0.1:${targetPort}/via-http-proxy`);
    assert.equal(rHttpUp.statusCode, 200);
    assert.equal(httpUp.httpHits.length, 1);
    assert.equal(httpUp.httpHits[0].authOk, true);

    const cHttpUp = await sendHttpInsideConnectTunnel(gwPort, '127.0.0.1', targetPort, '/connect-via-http');
    assert.equal(cHttpUp.tunnelStatus, 200);
    assert.match(cHttpUp.body, /\/connect-via-http/);
    assert.equal(httpUp.connectHits.length, 1);
    assert.equal(httpUp.connectHits[0].authOk, true);

    // 3. 免重启热切 SOCKS5h（远程 DNS + RFC 1929 USER/PASS 鉴权）+ 验证 HTTP 与 CONNECT
    gateway.updateConfig({
      mode: 'upstream',
      upstreamUrl: `socks5h://suser:spass@127.0.0.1:${socksUpPort}`,
      noProxy: 'no-hit.example'
    });
    const rSocks = await sendHttpViaGateway(gwPort, `http://localhost:${targetPort}/via-socks5h`);
    assert.equal(rSocks.statusCode, 200);
    assert.equal(socksUp.hits.length, 1);
    assert.equal(socksUp.hits[0].host, 'localhost');
    assert.equal(socksUp.hits[0].atyp, 0x03); // 验证 socks5h 域名远端解析
    assert.equal(socksUp.hits[0].authed, true);

    const cSocks = await sendHttpInsideConnectTunnel(gwPort, 'localhost', targetPort, '/connect-via-socks5h');
    assert.equal(cSocks.tunnelStatus, 200);
    assert.match(cSocks.body, /\/connect-via-socks5h/);
    assert.equal(socksUp.hits.length, 2);

    // 4. NO_PROXY 绕过规则验证：命中 127.0.0.1 时不经上游直接直连
    const prevSocksHits = socksUp.hits.length;
    gateway.updateConfig({
      mode: 'upstream',
      upstreamUrl: `socks5h://suser:spass@127.0.0.1:${socksUpPort}`,
      noProxy: '127.0.0.1'
    });
    const rBypass = await sendHttpViaGateway(gwPort, `http://127.0.0.1:${targetPort}/bypass-me`);
    assert.equal(rBypass.statusCode, 200);
    assert.equal(socksUp.hits.length, prevSocksHits);
    assert.ok(gateway.getStats().bypassCount >= 1);

    // 5. 分层连通性探测（经过 18766 同构本地网关端到端探测目标 HTTP 服务）
    const probeOk = await probeConnectivity({
      config: { mode: 'upstream', upstreamUrl: `socks5h://suser:spass@127.0.0.1:${socksUpPort}`, noProxy: '' },
      gatewayPort: gwPort,
      targetUrl: `http://127.0.0.1:${targetPort}/probe`,
      shellEnvOutput: 'PATH=/usr/bin'
    });
    assert.equal(probeOk.ok, true);
    assert.equal(probeOk.gatewayTcp.ok, true);
    assert.equal(probeOk.upstreamTcp.ok, true);
    assert.equal(probeOk.endToEndHttp.statusCode, 200);

    // 6. 上游端口不可达：默认 fail-closed 返回 502；开启降级后自动 DIRECT 成功
    const deadServer = net.createServer();
    await new Promise((r) => deadServer.listen(0, '127.0.0.1', r));
    const deadPort = deadServer.address().port;
    await new Promise((r) => deadServer.close(r));

    gateway.updateConfig({
      mode: 'upstream',
      upstreamUrl: `socks5h://127.0.0.1:${deadPort}`,
      noProxy: '',
      fallbackToDirectOnUpstreamError: false
    });
    const rFailClosed = await sendHttpViaGateway(gwPort, `http://127.0.0.1:${targetPort}/fail-closed`);
    assert.equal(rFailClosed.statusCode, 502);

    gateway.updateConfig({ fallbackToDirectOnUpstreamError: true });
    const rFallback = await sendHttpViaGateway(gwPort, `http://127.0.0.1:${targetPort}/fallback-direct`);
    assert.equal(rFallback.statusCode, 200);
    assert.ok(gateway.getStats().fallbackCount >= 1);

    // 7. 端口占用检测（EADDRINUSE -> GATEWAY_PORT_OCCUPIED）
    const conflictGw = new LocalProxyGateway({ port: gwPort });
    await assert.rejects(() => conflictGw.start(gwPort), /GATEWAY_PORT_OCCUPIED/);
  } finally {
    await gateway.stop();
    await socksUp.close();
    await httpUp.close();
    await target.close();
  }
});

test('LocalProxyGateway: 回环慢 HTTP POST 不受短 connect timeout 强杀，且 502 错误保留 Origin CORS 头', async () => {
  const slowServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ ok: true, echo: body }));
      }, 260);
    });
  });
  await new Promise((r) => slowServer.listen(0, '127.0.0.1', r));
  const slowPort = slowServer.address().port;

  const deadServer = net.createServer();
  await new Promise((r) => deadServer.listen(0, '127.0.0.1', r));
  const deadPort = deadServer.address().port;
  await new Promise((r) => deadServer.close(r));

  const gw = new LocalProxyGateway({
    port: 0,
    mode: 'direct',
    timeoutMs: 120
  });

  try {
    const st = await gw.start(0);
    const gwPort = st.port;

    const slowRes = await new Promise((resolve, reject) => {
      const payload = JSON.stringify({ text: '慢请求验证' });
      const req = http.request({
        hostname: '127.0.0.1',
        port: gwPort,
        method: 'POST',
        path: `http://127.0.0.1:${slowPort}/optimize-prompt`,
        headers: {
          Host: `127.0.0.1:${slowPort}`,
          Origin: 'https://127.0.0.1:63786',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Connection: 'close'
        },
        agent: false
      }, (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body: out }));
      });
      req.on('error', reject);
      req.end(payload);
    });
    assert.equal(slowRes.statusCode, 200);
    assert.equal(JSON.parse(slowRes.body).ok, true);

    const errRes = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: gwPort,
        method: 'POST',
        path: `http://127.0.0.1:${deadPort}/optimize-prompt`,
        headers: {
          Host: `127.0.0.1:${deadPort}`,
          Origin: 'https://127.0.0.1:63786',
          'Content-Type': 'application/json',
          'Content-Length': 2,
          Connection: 'close'
        },
        agent: false
      }, (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: out }));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.equal(errRes.statusCode, 502);
    assert.equal(errRes.headers['access-control-allow-origin'], 'https://127.0.0.1:63786');
    assert.equal(errRes.headers['access-control-allow-private-network'], 'true');
  } finally {
    await gw.stop();
    await new Promise((r) => slowServer.close(r));
  }
});
