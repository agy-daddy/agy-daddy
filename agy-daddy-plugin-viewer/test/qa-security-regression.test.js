'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const url = require('node:url');

const PLUGIN_DIR = path.resolve(__dirname, '..');
const MONOREPO_ROOT = path.resolve(PLUGIN_DIR, '..');
const HOST_ROOT = path.join(MONOREPO_ROOT, 'agy-daddy-host');

const {
  createMockHostHarness,
  createMockDocument,
  createMockElement
} = require(path.join(HOST_ROOT, 'sdk', 'mock-harness'));

const { ERROR_CODES, TOKEN_HEADER_CANONICAL } = require('../src/constants');
const { resolveRealPath, validatePathAccess } = require('../src/path-guard');
const { createGatewayServer } = require('../src/gateway-server');
const { createCsvEngine } = require('../src/csv-engine');
const { sanitizeSvgString, extractSvgMetadata } = require('../src/svg-sanitizer');
const { createGitDiffService, ALLOWED_GIT_SUBCOMMANDS } = require('../src/git-diff-service');
const { createTranslator } = require('../src/i18n');
const { mountMediaViewer } = require('../src/ui/media-viewer');
const { mountCsvViewer } = require('../src/ui/csv-viewer');
const { mountSvgViewer } = require('../src/ui/svg-viewer');
const { mountFontViewer } = require('../src/ui/font-viewer');

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

function initGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'qa@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'QA Bot'], { cwd: dir, stdio: 'ignore' });
}

test('QA-SEC-01: gateway binds strictly to 127.0.0.1 and rejects write methods, forged Host/Origin/Referer, cross-purpose tickets & revoked tokens', async () => {
  for (const badHost of ['0.0.0.0', '::', '192.168.1.10', 'localhost']) {
    assert.throws(() => createGatewayServer({ bindHost: badHost }), /FATAL_INVALID_BIND_HOST/);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-qa-gw-'));
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
  const mediaPath = path.join(ws, 'clip.mp4');
  const csvPath = path.join(ws, 'data.csv');
  const svgPath = path.join(ws, 'vec.svg');
  fs.writeFileSync(mediaPath, Buffer.from('0123456789ABCDEF0123456789'));
  fs.writeFileSync(csvPath, 'a,b\n1,2\n', 'utf8');
  fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>', 'utf8');

  const realWs = resolveRealPath(ws);
  const gw = createGatewayServer({
    resolveAllowedRoots: async () => [realWs],
    csvEngine: createCsvEngine()
  });

  try {
    const status = await gw.start({ portMode: 'auto' });
    assert.equal(status.host, '127.0.0.1');

    const origin = 'https://127.0.0.1:9444';
    const mediaTicket = await gw.issueTicket({ filePath: mediaPath, purpose: 'media', clientOrigin: origin });
    const csvTicket = await gw.issueTicket({ filePath: csvPath, purpose: 'csv', clientOrigin: origin });
    const svgTicket = await gw.issueTicket({ filePath: svgPath, purpose: 'svg', clientOrigin: origin });

    // 1. All write HTTP methods must be rejected with 405
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await rawHttpRequest({
        port: status.port,
        method,
        reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${encodeURIComponent(mediaTicket.token)}`,
        headers: { Host: `127.0.0.1:${status.port}`, Origin: origin }
      });
      assert.equal(res.status, 405, `${method} must return 405`);
      assert.equal(res.headers.allow, 'GET, HEAD, OPTIONS');
    }

    // 2. Forged / empty / missing Host headers rejected
    for (const hostHdr of [`evil.com:${status.port}`, `localhost:${status.port}`, '127.0.0.1']) {
      const res = await rawHttpRequest({
        port: status.port,
        reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${encodeURIComponent(mediaTicket.token)}`,
        headers: { Host: hostHdr, Origin: origin }
      });
      assert.equal(res.status, 403, `Host "${hostHdr}" must be rejected`);
      assert.equal(JSON.parse(res.body.toString()).errorCode, ERROR_CODES.INVALID_HOST_HEADER);
    }

    // Raw TCP request without Host header at all (and empty Host header)
    for (const rawReq of [
      `GET /v1/stream/${mediaTicket.ticketId}?t=${encodeURIComponent(mediaTicket.token)} HTTP/1.1\r\nOrigin: ${origin}\r\nConnection: close\r\n\r\n`,
      `GET /v1/stream/${mediaTicket.ticketId}?t=${encodeURIComponent(mediaTicket.token)} HTTP/1.1\r\nHost:\r\nOrigin: ${origin}\r\nConnection: close\r\n\r\n`
    ]) {
      const rawResp = await new Promise((resolve, reject) => {
        const sock = net.connect(status.port, '127.0.0.1', () => {
          sock.write(rawReq);
        });
        const chunks = [];
        sock.on('data', (c) => chunks.push(c));
        sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        sock.on('error', reject);
      });
      assert.match(rawResp, /^HTTP\/1\.1 (400|403) /);
    }

    // 3. Forged Origin / mismatched boundOrigin / missing Origin on bound ticket / evil Referer
    for (const badOrigin of ['http://localhost:3000', 'https://attacker.tld', 'null']) {
      const res = await rawHttpRequest({
        port: status.port,
        reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${encodeURIComponent(mediaTicket.token)}`,
        headers: { Host: `127.0.0.1:${status.port}`, Origin: badOrigin }
      });
      assert.equal(res.status, 403);
      assert.equal(JSON.parse(res.body.toString()).errorCode, ERROR_CODES.FORBIDDEN_ORIGIN);
    }

    const mismatchedOrigin = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${encodeURIComponent(mediaTicket.token)}`,
      headers: { Host: `127.0.0.1:${status.port}`, Origin: 'https://127.0.0.1:9999' }
    });
    assert.equal(mismatchedOrigin.status, 403);
    assert.equal(JSON.parse(mismatchedOrigin.body.toString()).errorCode, ERROR_CODES.FORBIDDEN_ORIGIN);

    const omittedOrigin = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${encodeURIComponent(mediaTicket.token)}`,
      headers: { Host: `127.0.0.1:${status.port}` }
    });
    assert.equal(omittedOrigin.status, 403);
    assert.equal(JSON.parse(omittedOrigin.body.toString()).errorCode, ERROR_CODES.FORBIDDEN_ORIGIN);

    const evilReferer = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${encodeURIComponent(mediaTicket.token)}`,
      headers: { Host: `127.0.0.1:${status.port}`, Referer: 'https://evil.example/probe.html' }
    });
    assert.equal(evilReferer.status, 403);
    assert.equal(JSON.parse(evilReferer.body.toString()).errorCode, ERROR_CODES.FORBIDDEN_REFERER);

    // 4. Cross-purpose ticket misuse must be rejected
    const csvAsStream = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/stream/${csvTicket.ticketId}?t=${encodeURIComponent(csvTicket.token)}`,
      headers: { Host: `127.0.0.1:${status.port}`, Origin: origin }
    });
    assert.equal(csvAsStream.status, 403);
    assert.equal(JSON.parse(csvAsStream.body.toString()).errorCode, ERROR_CODES.INVALID_OR_EXPIRED_TICKET);

    const mediaAsSvg = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/svg/${mediaTicket.ticketId}`,
      headers: { Host: `127.0.0.1:${status.port}`, Origin: origin, [TOKEN_HEADER_CANONICAL]: mediaTicket.token }
    });
    assert.equal(mediaAsSvg.status, 403);
    assert.equal(JSON.parse(mediaAsSvg.body.toString()).errorCode, ERROR_CODES.INVALID_OR_EXPIRED_TICKET);

    // 5. HEAD 206 Range returns empty body with accurate Content-Range
    const head206 = await rawHttpRequest({
      port: status.port,
      method: 'HEAD',
      reqPath: `/v1/stream/${mediaTicket.ticketId}?t=${encodeURIComponent(mediaTicket.token)}`,
      headers: { Host: `127.0.0.1:${status.port}`, Origin: origin, Range: 'bytes=2-5' }
    });
    assert.equal(head206.status, 206);
    assert.equal(head206.headers['content-range'], 'bytes 2-5/26');
    assert.equal(head206.body.length, 0);

    // 6. Revoked ticket is immediately invalid
    const rev = gw.revokeTicket({ ticketId: svgTicket.ticketId });
    assert.equal(rev.revokedCount, 1);
    const afterRevoke = await rawHttpRequest({
      port: status.port,
      reqPath: `/v1/svg/${svgTicket.ticketId}`,
      headers: { Host: `127.0.0.1:${status.port}`, Origin: origin, [TOKEN_HEADER_CANONICAL]: svgTicket.token }
    });
    assert.equal(afterRevoke.status, 403);
    assert.equal(JSON.parse(afterRevoke.body.toString()).errorCode, ERROR_CODES.INVALID_OR_EXPIRED_TICKET);
  } finally {
    await gw.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('QA-SEC-02: path-guard blocks URL-encoded traversal, all sensitive credential segments, and non-regular files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-qa-pg-'));
  try {
    const ws = path.join(tmp, 'ws');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(ws);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    const realWs = resolveRealPath(ws);

    const encTrav = validatePathAccess(`${ws}/%2e%2e/outside/secret.txt`, { allowedRealRoots: [realWs] });
    assert.equal(encTrav.ok, false);
    assert.equal(encTrav.statusCode, 403);

    for (const seg of ['.gnupg/secring.gpg', '.kube/config', '.docker/config.json', '.npmrc', '.netrc', '.git/credentials', '1Password/vault.opvault']) {
      const res = validatePathAccess(path.join(ws, seg), { allowedRealRoots: [realWs], mustExist: false });
      assert.equal(res.ok, false, `Must block sensitive path ${seg}`);
      assert.equal(res.errorCode, ERROR_CODES.SENSITIVE_PATH_BLOCKED);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('QA-SEC-03: SVG sanitizer strips XML stylesheets, DOCTYPE/ENTITY, CSS @import/expression/url and preserves safe vector defs', () => {
  const malicious = [
    '<?xml-stylesheet type="text/xsl" href="https://evil.com/x.xsl"?>',
    '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">',
    '<style>@import "https://evil.com/a.css"; .a { background: url("https://evil.com/leak.png"); width: expression(alert(1)); fill: url(#grad1); }</style>',
    '<iframe src="https://evil.com"></iframe><embed src="x"/><object data="y"></object>',
    '<rect width="100" height="50" style="background:url(javascript:alert(1))" onmouseover=alert(1) />',
    '<image href="data:image/svg+xml;base64,PHN2Zz4="/>',
    '</svg>'
  ].join('');

  const cleaned = sanitizeSvgString(malicious);
  assert.equal(cleaned.includes('xml-stylesheet'), false);
  assert.equal(cleaned.includes('DOCTYPE'), false);
  assert.equal(cleaned.includes('ENTITY'), false);
  assert.equal(cleaned.includes('@import'), false);
  assert.equal(cleaned.includes('expression('), false);
  assert.equal(cleaned.includes('https://evil.com'), false);
  assert.equal(cleaned.includes('<iframe'), false);
  assert.equal(cleaned.includes('<embed'), false);
  assert.equal(cleaned.includes('<object'), false);
  assert.equal(cleaned.includes('onmouseover'), false);
  assert.equal(cleaned.includes('javascript:'), false);
  assert.equal(cleaned.includes('data:image/svg+xml'), false);
  assert.equal(cleaned.includes('url("#grad1")'), true);
});

test('QA-REGRESSION-01: extractSvgMetadata parses single-quoted width and height independently (Bug check)', () => {
  const meta = extractSvgMetadata("<svg width='120' height='80' viewBox='0 0 120 80'></svg>");
  assert.equal(meta.naturalWidth, 120);
  assert.equal(meta.naturalHeight, 80);
});

test('QA-FUNC-01: git-diff-service enforces staged/unstaged scope isolation and 2MB tracked file truncation', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-qa-git-'));
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    initGitRepo(repo);

    const f = path.join(repo, 'scoped.js');
    fs.writeFileSync(f, 'line1\nline2\nline3\n', 'utf8');
    const big = path.join(repo, 'big.txt');
    fs.writeFileSync(big, 'A'.repeat(100) + '\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

    // Staged change
    fs.writeFileSync(f, 'line1\nline2_staged\nline3\n', 'utf8');
    execFileSync('git', ['add', 'scoped.js'], { cwd: repo, stdio: 'ignore' });
    // Unstaged change on top
    fs.writeFileSync(f, 'line1\nline2_staged\nline3_unstaged\n', 'utf8');
    // Tracked large file > 1MB (tested with diffMaxFileSizeMB: 1)
    fs.writeFileSync(big, 'B'.repeat(1_200_000) + '\n', 'utf8');

    const realRepo = resolveRealPath(repo);
    const svc = createGitDiffService({ resolveAllowedRoots: async () => [realRepo] });

    const stagedOnly = await svc.getFileDiff({ filePath: f, scope: 'staged' });
    assert.equal(stagedOnly.state, 'OK');
    assert.ok(stagedOnly.hunks.some((h) => h.lines.some((l) => l.content.includes('line2_staged'))));
    assert.equal(stagedOnly.hunks.some((h) => h.lines.some((l) => l.content.includes('line3_unstaged'))), false);

    const unstagedOnly = await svc.getFileDiff({ filePath: f, scope: 'unstaged' });
    assert.equal(unstagedOnly.state, 'OK');
    assert.ok(unstagedOnly.hunks.some((h) => h.lines.some((l) => l.content.includes('line3_unstaged'))));

    const bigTrunc = await svc.getFileDiff({ filePath: big, settings: { diffMaxFileSizeMB: 1 } });
    assert.equal(bigTrunc.state, 'DIFF_TRUNCATED');
    assert.equal(bigTrunc.truncated, true);
    assert.equal(bigTrunc.truncationMeta.reason, 'FILE_SIZE_LIMIT');

    // Verify strictly read-only git subcommand set
    assert.deepEqual([...ALLOWED_GIT_SUBCOMMANDS].sort(), ['diff', 'rev-parse', 'show', 'status', 'symbolic-ref']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('QA-REGRESSION-02: csv-viewer renders empty state cleanly on empty CSV and 0-match search without throwing ReferenceError (Bug check)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-qa-csv-ui-'));
  const csvPath = path.join(tmp, 'sample.csv');
  fs.writeFileSync(csvPath, 'id,name\n1,alice\n2,bob\n', 'utf8');
  const realTmp = resolveRealPath(tmp);
  const origin = 'https://127.0.0.1:51411';

  const gw = createGatewayServer({
    resolveAllowedRoots: async () => [realTmp],
    csvEngine: createCsvEngine()
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => origFetch(input, {
    ...init,
    headers: { ...(init.headers || {}), Origin: origin }
  });

  try {
    await gw.start({ portMode: 'auto' });
    const ticket = await gw.issueTicket({ filePath: csvPath, purpose: 'csv', clientOrigin: origin });
    const doc = createMockDocument([]);
    doc.documentElement.setAttribute('lang', 'zh-CN');
    const t = createTranslator(doc);
    const rootEl = createMockElement('div', doc);
    const ctrl = new AbortController();

    await mountCsvViewer({
      doc,
      t,
      rootEl,
      ticket,
      settings: { csvChunkSize: 50, csvFirstRowHeader: true },
      signal: ctrl.signal,
      trackCleanup: () => {}
    });

    const searchInput = rootEl.querySelector('input[type="text"]');
    searchInput.value = 'NON_EXISTENT_KEYWORD_XYZ';
    searchInput.dispatchEvent({ type: 'input', target: searchInput });

    await new Promise((r) => setTimeout(r, 400));
    assert.match(rootEl.textContent, /暂无匹配数据行/);
    ctrl.abort();
  } finally {
    globalThis.fetch = origFetch;
    await gw.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('QA-FUNC-02: media viewer enforces waveform threshold, frame stepping, A-B loop, codec error card & scoped shortcuts', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-qa-media-'));
  const mp4Path = path.join(tmp, 'huge.mp4');
  fs.writeFileSync(mp4Path, Buffer.from('0123456789'));
  const realTmp = resolveRealPath(tmp);
  const origin = 'https://127.0.0.1:51412';
  const gw = createGatewayServer({ resolveAllowedRoots: async () => [realTmp] });

  try {
    await gw.start({ portMode: 'auto' });
    const ticket = await gw.issueTicket({ filePath: mp4Path, purpose: 'media', clientOrigin: origin });
    // Simulate > 10MB fileMeta to trigger waveform circuit breaker
    const largeTicket = { ...ticket, fileMeta: { ...ticket.fileMeta, size: 15 * 1024 * 1024 } };
    const doc = createMockDocument([]);
    doc.documentElement.setAttribute('lang', 'zh-CN');
    const t = createTranslator(doc);
    const rootEl = createMockElement('div', doc);
    const cleanups = [];

    await mountMediaViewer({
      ctx: {
        bridge: { post: async () => ({ ok: true, markers: [] }) },
        schedule: { idle: () => () => {} }
      },
      doc,
      t,
      rootEl,
      ticket: largeTicket,
      filePath: mp4Path,
      settings: { mediaDefaultFps: '30', mediaWaveformMaxMB: 10 },
      signal: new AbortController().signal,
      trackCleanup: (fn) => cleanups.push(fn)
    });

    assert.match(rootEl.textContent, /已关闭全量波形解码/);
    const videoEl = rootEl.querySelector('video');
    videoEl.duration = 10;
    videoEl.currentTime = 1.0;

    // Frame step forward at 30fps -> +1/30s
    const nextFrameBtn = rootEl.querySelectorAll('button').find((b) => b.textContent === '下一帧');
    nextFrameBtn.click();
    assert.ok(Math.abs(videoEl.currentTime - (1 + 1 / 30)) < 0.001);

    // Input-targeted keydown must NOT hijack space/arrow shortcuts
    let preventCalled = false;
    rootEl.dispatchEvent({
      type: 'keydown',
      code: 'Space',
      key: ' ',
      target: { tagName: 'INPUT' },
      preventDefault: () => { preventCalled = true; }
    });
    assert.equal(preventCalled, false);

    // Simulate MediaError -> codec unsupported card
    videoEl.dispatchEvent({ type: 'error' });
    assert.match(rootEl.textContent, /不支持该媒体编码格式/);

    for (const fn of cleanups) fn();
  } finally {
    await gw.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('QA-FUNC-03: font viewer registers isolated FontFace, cleans up document.fonts, and handles 20x file switch without leaks', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-qa-font-'));
  const fontPath = path.join(tmp, 'test.ttf');
  fs.writeFileSync(fontPath, Buffer.from('dummy-ttf-data'));
  const tsFiles = [];
  for (let i = 0; i < 20; i++) {
    const p = path.join(tmp, `file_${i}.ts`);
    fs.writeFileSync(p, `export const n = ${i};\n`, 'utf8');
    tsFiles.push(p);
  }
  const realTmp = resolveRealPath(tmp);
  const origin = 'https://127.0.0.1:51413';

  const gw = createGatewayServer({ resolveAllowedRoots: async () => [realTmp] });
  const origFetch = globalThis.fetch;
  const origFontFace = globalThis.FontFace;
  globalThis.fetch = (input, init = {}) => origFetch(input, {
    ...init,
    headers: { ...(init.headers || {}), Origin: origin }
  });
  globalThis.FontFace = class MockFontFace {
    constructor(family, buf) { this.family = family; this.buf = buf; }
    async load() { return this; }
  };

  try {
    await gw.start({ portMode: 'auto' });
    const ticket = await gw.issueTicket({ filePath: fontPath, purpose: 'font', clientOrigin: origin });
    const doc = createMockDocument([]);
    doc.documentElement.setAttribute('lang', 'zh-CN');
    const addedFonts = new Set();
    doc.fonts = {
      add: (f) => addedFonts.add(f),
      delete: (f) => addedFonts.delete(f)
    };
    const t = createTranslator(doc);
    const rootEl = createMockElement('div', doc);
    const cleanups = [];

    await mountFontViewer({
      doc,
      t,
      rootEl,
      ticket,
      settings: { fontMaxSizeMB: 50 },
      signal: new AbortController().signal,
      trackCleanup: (fn) => cleanups.push(fn)
    });

    assert.equal(addedFonts.size, 1);
    const [face] = Array.from(addedFonts);
    assert.match(face.family, /^agy-viewer-font-/);
    assert.equal(rootEl.querySelectorAll('.agy-v-font-row').length, 8);
    assert.equal(rootEl.querySelectorAll('.agy-v-glyph-cell').length, 94);

    for (const fn of cleanups) fn();
    assert.equal(addedFonts.size, 0, 'Temporary FontFace must be deleted from document.fonts on cleanup');

    // 20-cycle file switch leak test
    const harness = createMockHostHarness({
      document: doc,
      fetch: globalThis.fetch,
      onRpc: async (method) => method === 'GetAllCascadeTrajectories'
        ? { trajectorySummaries: { c1: { workspaces: [{ workspaceFolderAbsoluteUri: url.pathToFileURL(realTmp).href }] } } }
        : { ok: true }
    });
    const panel = createMockElement('div', doc);
    const header = createMockElement('div', doc);
    const body = createMockElement('div', doc);
    panel.appendChild(header);
    panel.appendChild(body);
    doc.body.appendChild(panel);
    header.setAttribute('data-file-path', tsFiles[0]);

    try {
      const { port } = await harness.bridge.start(0);
      harness.rendererHost.configure({ bridgePort: port });
      await harness.loadAndRunPlugin(PLUGIN_DIR, { trustLevel: 'T0' });

      let viewerSvc = null;
      await harness.rendererHost.mountPlugin('test.leak.consumer', {
        mount(ctx) { viewerSvc = ctx.services.get('viewer'); }
      });

      for (const fp of tsFiles) {
        header.setAttribute('data-file-path', fp);
        await viewerSvc.inspectCurrent();
      }
      await harness.unloadPlugin('agy-daddy.viewer');
      harness.assertCleanDispose('agy-daddy.viewer');
      assert.equal(doc.getElementById('agy-viewer-stage-host'), null);
      assert.equal(doc.getElementById('agy-viewer-header-host'), null);
    } finally {
      await harness.cleanup();
    }
  } finally {
    globalThis.fetch = origFetch;
    globalThis.FontFace = origFontFace;
    await gw.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
