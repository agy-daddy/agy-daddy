'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { ERROR_CODES, TOKEN_HEADER_CANONICAL } = require('../src/constants');
const { resolveRealPath } = require('../src/path-guard');
const { createCsvEngine } = require('../src/csv-engine');
const {
  LOOPBACK_HOST,
  redactGatewayUrl,
  parseHttpByteRange,
  createGatewayServer
} = require('../src/gateway-server');
const { activate, deactivate } = require('../src/node');

function rawHttpRequest({ port, method = 'GET', reqPath = '/', headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('gateway-server: refuses non-loopback bindHost and redacts query tokens in logs', () => {
  assert.throws(() => createGatewayServer({ bindHost: '0.0.0.0' }), /FATAL_INVALID_BIND_HOST/);
  assert.equal(
    redactGatewayUrl('/v1/stream/abc?t=secret123&foo=bar'),
    '/v1/stream/abc?t=[REDACTED]&foo=bar'
  );
});

test('gateway-server: parseHttpByteRange supports RFC 9110 single ranges & 64-bit safe integers', () => {
  assert.deepEqual(parseHttpByteRange(undefined, 1000), { present: false });
  assert.deepEqual(parseHttpByteRange('bytes=0-9', 1000), {
    present: true,
    satisfiable: true,
    start: 0,
    end: 9,
    length: 10
  });
  assert.deepEqual(parseHttpByteRange('bytes=990-9999', 1000), {
    present: true,
    satisfiable: true,
    start: 990,
    end: 999,
    length: 10
  });
  assert.deepEqual(parseHttpByteRange('bytes=950-', 1000), {
    present: true,
    satisfiable: true,
    start: 950,
    end: 999,
    length: 50
  });
  assert.deepEqual(parseHttpByteRange('bytes=-100', 1000), {
    present: true,
    satisfiable: true,
    start: 900,
    end: 999,
    length: 100
  });
  // Large 4GB+ offset
  const bigSize = 5 * 1024 * 1024 * 1024;
  assert.deepEqual(parseHttpByteRange(`bytes=${bigSize - 100}-`, bigSize), {
    present: true,
    satisfiable: true,
    start: bigSize - 100,
    end: bigSize - 1,
    length: 100
  });
  // Unsatisfiable / multi-range
  assert.equal(parseHttpByteRange('bytes=1000-', 1000).satisfiable, false);
  assert.equal(parseHttpByteRange('bytes=20-10', 1000).satisfiable, false);
  assert.equal(parseHttpByteRange('bytes=0-1, 2-3', 1000).satisfiable, false);
});

test('gateway-server: enforces 5 security gates, HTTP 206 Range streaming, SVG sanitization, and TOCTOU', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-viewer-gw-'));
  const ws = path.join(tmp, 'ws');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);

  const mediaPath = path.join(ws, 'sample.mp4');
  const mediaBytes = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  fs.writeFileSync(mediaPath, mediaBytes);

  const svgPath = path.join(ws, 'icon.svg');
  fs.writeFileSync(
    svgPath,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="alert(1)">'
    + '<script>alert(2)</script><foreignObject><div>x</div></foreignObject>'
    + '<a href="javascript:alert(3)"><rect width="10" height="10" onclick="evil()"/></a>'
    + '<use href="#safe-id"/><image href="https://evil.example/a.png"/>'
    + '<image href="data:image/png;base64,AAAA"/></svg>',
    'utf8'
  );

  const csvPath = path.join(ws, 'table.csv');
  fs.writeFileSync(csvPath, 'id,name\n1,alice\n2,bob\n', 'utf8');

  const realWs = resolveRealPath(ws);
  const csvEngine = createCsvEngine();
  const gw = createGatewayServer({
    resolveAllowedRoots: async () => [realWs],
    csvEngine
  });

  try {
    const status = await gw.start({ portMode: 'auto' });
    assert.equal(status.ok, true);
    assert.equal(status.running, true);
    assert.equal(status.host, LOOPBACK_HOST);
    assert.ok(status.port > 0);
    assert.equal('secret' in status, false);
    assert.equal('token' in status, false);

    const origin = 'https://127.0.0.1:9222';
    const mediaTicket = await gw.issueTicket({
      filePath: mediaPath,
      purpose: 'media',
      clientOrigin: origin
    });
    assert.equal(mediaTicket.ok, true);

    // Gate B: Disallow POST
    const postRes = await rawHttpRequest({
      port: status.port,
      method: 'POST',
      reqPath: `/v1/stream/${mediaTicket.ticketId}`,
      headers: { Host: `127.0.0.1:${status.port}`, Origin: origin }
    });
    assert.equal(postRes.status, 405);
    assert.equal(postRes.headers.allow, 'GET, HEAD, OPTIONS');

    // Gate C: Reject localhost or evil Host header
    const badHost = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${mediaTicket.token}`,
      headers: { Host: `localhost:${status.port}`, Origin: origin }
    });
    assert.equal(badHost.status, 403);
    assert.equal(JSON.parse(badHost.body.toString()).errorCode, ERROR_CODES.INVALID_HOST_HEADER);

    // Gate D: Reject evil Origin, null Origin, cross-site no-cors
    const badOrigin = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${mediaTicket.token}`,
      headers: { Host: `127.0.0.1:${status.port}`, Origin: 'https://evil.com' }
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(JSON.parse(badOrigin.body.toString()).errorCode, ERROR_CODES.FORBIDDEN_ORIGIN);

    const nullOrigin = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${mediaTicket.token}`,
      headers: { Host: `127.0.0.1:${status.port}`, Origin: 'null' }
    });
    assert.equal(nullOrigin.status, 403);

    const noCors = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${mediaTicket.token}`,
      headers: { Host: `127.0.0.1:${status.port}`, 'Sec-Fetch-Site': 'cross-site' }
    });
    assert.equal(noCors.status, 403);
    assert.equal(JSON.parse(noCors.body.toString()).errorCode, ERROR_CODES.CROSS_SITE_NO_CORS_BLOCKED);

    // Gate E: Missing / wrong token
    const badTok = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/stream/${mediaTicket.ticketId}?t=wrong-token`,
      headers: { Host: `127.0.0.1:${status.port}`, Origin: origin }
    });
    assert.equal(badTok.status, 403);
    assert.equal(JSON.parse(badTok.body.toString()).errorCode, ERROR_CODES.INVALID_OR_EXPIRED_TICKET);

    // Valid HTTP 206 partial content
    const rangeRes = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${encodeURIComponent(mediaTicket.token)}`,
      headers: {
        Host: `127.0.0.1:${status.port}`,
        Origin: origin,
        Range: 'bytes=10-19'
      }
    });
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers['content-range'], `bytes 10-19/${mediaBytes.length}`);
    assert.equal(rangeRes.headers['accept-ranges'], 'bytes');
    assert.equal(rangeRes.headers['x-content-type-options'], 'nosniff');
    assert.equal(rangeRes.body.toString(), 'ABCDEFGHIJ');

    // Out-of-range -> 416
    const oobRange = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${encodeURIComponent(mediaTicket.token)}`,
      headers: {
        Host: `127.0.0.1:${status.port}`,
        Origin: origin,
        Range: 'bytes=999-1005'
      }
    });
    assert.equal(oobRange.status, 416);
    assert.equal(oobRange.headers['content-range'], `bytes */${mediaBytes.length}`);

    // CSV endpoint rejects query ?t= and requires X-Viewer-Token header
    const csvTicket = await gw.issueTicket({
      filePath: csvPath,
      purpose: 'csv',
      clientOrigin: origin
    });
    const csvQueryTok = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/csv/${csvTicket.ticketId}/meta?t=${encodeURIComponent(csvTicket.token)}`,
      headers: { Host: `127.0.0.1:${status.port}`, Origin: origin }
    });
    assert.equal(csvQueryTok.status, 403);

    const csvHeaderTok = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/csv/${csvTicket.ticketId}/meta`,
      headers: {
        Host: `127.0.0.1:${status.port}`,
        Origin: origin,
        [TOKEN_HEADER_CANONICAL]: csvTicket.token
      }
    });
    assert.equal(csvHeaderTok.status, 200);
    const csvMeta = JSON.parse(csvHeaderTok.body.toString());
    assert.equal(csvMeta.ok, true);
    assert.deepEqual(csvMeta.headers, ['id', 'name']);

    // SVG sanitization endpoint
    const svgTicket = await gw.issueTicket({
      filePath: svgPath,
      purpose: 'svg',
      clientOrigin: origin
    });
    const svgRes = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/svg/${svgTicket.ticketId}?mode=sanitized`,
      headers: {
        Host: `127.0.0.1:${status.port}`,
        Origin: origin,
        [TOKEN_HEADER_CANONICAL]: svgTicket.token
      }
    });
    assert.equal(svgRes.status, 200);
    const svgJson = JSON.parse(svgRes.body.toString());
    assert.equal(svgJson.ok, true);
    assert.equal(svgJson.naturalWidth, 100);
    assert.equal(svgJson.naturalHeight, 100);
    assert.equal(svgJson.content.includes('<script'), false);
    assert.equal(svgJson.content.includes('foreignObject'), false);
    assert.equal(svgJson.content.includes('onload'), false);
    assert.equal(svgJson.content.includes('onclick'), false);
    assert.equal(svgJson.content.includes('javascript:'), false);
    assert.equal(svgJson.content.includes('https://evil.example'), false);
    assert.equal(svgJson.content.includes('#safe-id'), true);
    assert.equal(svgJson.content.includes('data:image/png;base64,AAAA'), true);

    // TOCTOU symlink swap after ticket issuance
    const swapTarget = path.join(ws, 'swap.mp4');
    fs.writeFileSync(swapTarget, 'hello');
    const swapTicket = await gw.issueTicket({
      filePath: swapTarget,
      purpose: 'media',
      clientOrigin: origin
    });
    fs.unlinkSync(swapTarget);
    const outsideSecret = path.join(outside, 'secret.bin');
    fs.writeFileSync(outsideSecret, 'TOPSECRET');
    fs.symlinkSync(outsideSecret, swapTarget);

    const toctouRes = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/stream/${swapTicket.ticketId}?t=${encodeURIComponent(swapTicket.token)}`,
      headers: { Host: `127.0.0.1:${status.port}`, Origin: origin }
    });
    assert.equal(toctouRes.status, 403);
    assert.equal(JSON.parse(toctouRes.body.toString()).errorCode, ERROR_CODES.SYMLINK_ESCAPE);
  } finally {
    await gw.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('gateway-server: fixed port falls back to ephemeral port on EADDRINUSE', async () => {
  const occupied = http.createServer((_req, res) => res.end('busy'));
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const busyPort = occupied.address().port;

  const prevTestMode = process.env.AGY_DADDY_TEST_MODE;
  const prevNodeEnv = process.env.NODE_ENV;
  const gw = createGatewayServer({ resolveAllowedRoots: async () => [] });
  try {
    // Pass explicitTestPort to exercise EADDRINUSE fallback path deterministically
    const status = await gw.start({ portMode: 'fixed', explicitTestPort: busyPort });
    assert.equal(status.ok, true);
    assert.equal(status.running, true);
    assert.equal(status.portFallback, true);
    assert.equal(status.fallbackReason, 'EADDRINUSE');
    assert.notEqual(status.port, busyPort);
  } finally {
    process.env.AGY_DADDY_TEST_MODE = prevTestMode;
    process.env.NODE_ENV = prevNodeEnv;
    await gw.stop();
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test('node.js: activate/deactivate lifecycle, Bridge routes, markers store, and enabled=false shutdown', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-viewer-node-'));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  const csvFile = path.join(ws, 'big.csv');
  fs.writeFileSync(csvFile, 'a,b\n1,2\n3,4\n', 'utf8');

  const routes = new Map();
  const commands = new Map();
  const states = new Map();
  let settingsListeners = [];
  let storageData = {};
  let currentSettings = {
    enabled: true,
    allowedRoots: [ws]
  };

  const mockHost = {
    settings: {
      get: () => ({ ...currentSettings }),
      onChange: (fn) => {
        settingsListeners.push(fn);
        return () => { settingsListeners = settingsListeners.filter((f) => f !== fn); };
      },
      async update(patch) {
        currentSettings = { ...currentSettings, ...patch };
        return { ok: true, values: currentSettings };
      }
    },
    storage: {
      readJson: (name, fallback) => ({ ok: true, exists: Boolean(storageData[name]), data: storageData[name] ?? fallback }),
      writeJson: (name, val) => { storageData[name] = val; return { ok: true }; }
    },
    bridge: {
      async registerRoute(subPath, handler) {
        routes.set(subPath, handler);
        return () => routes.delete(subPath);
      }
    },
    services: {
      async provide() { return () => {}; }
    },
    commands: {
      async register(id, handler) {
        commands.set(id, handler);
        return () => commands.delete(id);
      }
    },
    state: {
      set(k, v) { states.set(k, v); },
      get(k) { return states.get(k); }
    },
    events: { emit() {} },
    rpc: { async getOrigin() { return 'https://127.0.0.1:9222'; } }
  };

  try {
    await activate(mockHost);
    assert.ok(routes.has('/file/inspect'));
    assert.ok(routes.has('/gateway/ticket'));
    assert.ok(routes.has('/gateway/revoke'));
    assert.ok(routes.has('/gateway/status'));
    assert.ok(routes.has('/diff/file'));
    assert.ok(routes.has('/diff/workspace'));
    assert.ok(routes.has('/diff/context'));
    assert.ok(routes.has('/markers/get'));
    assert.ok(routes.has('/markers/save'));

    const inspectOk = await routes.get('/file/inspect')({ rawPath: csvFile });
    assert.equal(inspectOk.ok, true);
    assert.equal(inspectOk.authorized, true);
    assert.equal(inspectOk.category, 'csv');
    assert.equal(inspectOk.estimatedLines, 3);

    const inspectOut = await routes.get('/file/inspect')({ rawPath: '/etc/passwd' });
    assert.equal(inspectOut.ok, true);
    assert.equal(inspectOut.authorized, false);

    // Markers persistence
    const saveRes = await routes.get('/markers/save')({
      filePath: csvFile,
      markers: [{ id: 'm1', timeSec: 12.3456, label: 'cue 1', tone: 'warn' }]
    });
    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.savedCount, 1);
    const getRes = await routes.get('/markers/get')({ filePath: csvFile });
    assert.equal(getRes.markers.length, 1);
    assert.equal(getRes.markers[0].timeSec, 12.346);

    // Disable plugin via settings
    for (const fn of settingsListeners) fn({ ...currentSettings, enabled: false });
    await new Promise((r) => setTimeout(r, 30));
    const gwOff = await routes.get('/gateway/status')({});
    assert.equal(gwOff.running, false);
  } finally {
    await deactivate();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
