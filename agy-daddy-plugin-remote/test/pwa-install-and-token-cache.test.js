'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(PLUGIN_ROOT, 'web', 'public');
const DIST_WEB_DIR = path.join(PLUGIN_ROOT, 'dist', 'web');

const { generateTunnelLandingHtml } = require('../src/tunnel-landing-html');
const { MobileRemoteServer } = require('../src/pwa-server');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  assert.ok(buf.length >= 24, `PNG file too small: ${filePath}`);
  assert.equal(buf.subarray(0, 8).equals(PNG_SIGNATURE), true, `Invalid PNG header: ${filePath}`);
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR', `Missing IHDR chunk: ${filePath}`);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    buf
  };
}

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      agent: false,
      headers: {
        Connection: 'close',
        ...(options.headers || {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buf,
          text: buf.toString('utf8')
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function createLandingDomHarness({ html, initialHref, localStorageData = {}, sessionStorageData = {}, fetchImpl }) {
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Expected inline script in landing HTML');

  const elements = new Map();
  const makeEl = (id) => {
    const attrs = new Map();
    const listeners = new Map();
    return {
      id,
      hidden: id === 'agy-landing-auth-error' || id === 'agy-landing-channels' || id === 'agy-landing-cta-wrap' || id === 'agy-landing-reprobe-btn',
      value: '',
      textContent: '',
      innerHTML: '',
      children: [],
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'hidden') this.hidden = true;
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      removeAttribute(k) {
        attrs.delete(k);
        if (k === 'hidden') this.hidden = false;
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      addEventListener(type, fn) {
        const list = listeners.get(type) || [];
        list.push(fn);
        listeners.set(type, list);
      },
      dispatch(type, ev = {}) {
        for (const fn of listeners.get(type) || []) {
          fn(ev);
        }
      }
    };
  };

  for (const id of [
    'agy-landing-theme-btn',
    'agy-landing-channels',
    'agy-landing-cta-wrap',
    'agy-landing-primary-cta',
    'agy-landing-reprobe-btn',
    'agy-landing-auth-card',
    'agy-landing-token-input',
    'agy-landing-unlock-btn',
    'agy-landing-auth-error',
    'agy-landing-title',
    'agy-landing-subtitle',
    'agy-landing-write-pill',
    'agy-landing-mode-pill',
    'agy-landing-mixed-hint',
    'agy-landing-http-probe-link',
    'agy-landing-footnote'
  ]) {
    elements.set(id, makeEl(id));
  }

  const makeStorage = (seed) => {
    const store = new Map(Object.entries(seed));
    return {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      _store: store
    };
  };

  const localStorage = makeStorage(localStorageData);
  const sessionStorage = makeStorage(sessionStorageData);
  const currentUrl = new URL(initialHref);
  const replacedLocations = [];
  const registeredSw = [];

  const locationObj = {
    get href() { return currentUrl.href; },
    set href(v) {
      const next = new URL(v, currentUrl.origin);
      currentUrl.href = next.href;
      replacedLocations.push(next.pathname + next.search + next.hash);
    },
    get pathname() { return currentUrl.pathname; },
    get search() { return currentUrl.search; },
    get hash() { return currentUrl.hash; },
    get protocol() { return currentUrl.protocol; },
    get origin() { return currentUrl.origin; },
    replace(v) {
      const next = new URL(v, currentUrl.origin);
      currentUrl.href = next.href;
      replacedLocations.push(next.pathname + next.search + next.hash);
    }
  };

  const documentObj = {
    documentElement: makeEl('html'),
    getElementById: (id) => elements.get(id) || null,
    createElement: (tag) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => []
  };

  const windowObj = {
    location: locationObj,
    history: {
      replaceState(_state, _title, nextUrl) {
        const next = new URL(nextUrl, currentUrl.origin);
        currentUrl.href = next.href;
      }
    },
    localStorage,
    sessionStorage
  };

  const navigatorObj = {
    serviceWorker: {
      register: (swPath) => {
        registeredSw.push(swPath);
        return Promise.resolve({});
      }
    }
  };

  const ctx = {
    window: windowObj,
    document: documentObj,
    navigator: navigatorObj,
    localStorage,
    sessionStorage,
    URL,
    URLSearchParams,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    Promise,
    Error
  };

  vm.runInNewContext(scriptMatch[1], ctx);

  return {
    elements,
    localStorage,
    sessionStorage,
    currentUrl,
    replacedLocations,
    registeredSw
  };
}

test('PWA manifest, PNG icons, index.html, and sw.js satisfy Android Chrome WebAPK requirements and sync with dist/web', () => {
  for (const baseDir of [PUBLIC_DIR, DIST_WEB_DIR]) {
    const manifestPath = path.join(baseDir, 'manifest.webmanifest');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.equal(manifest.id, '/');
    assert.equal(manifest.start_url, '/?enter=1');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.display, 'standalone');
    assert.ok(Array.isArray(manifest.icons));

    const icon192 = manifest.icons.find((i) => i.src === '/icon-192.png');
    const icon512 = manifest.icons.find((i) => i.src === '/icon-512.png');
    const iconMaskable = manifest.icons.find((i) => i.src === '/icon-maskable-512.png');

    assert.deepEqual(icon192, { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' });
    assert.deepEqual(icon512, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' });
    assert.deepEqual(iconMaskable, { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' });
    assert.equal(manifest.icons.some((i) => String(i.purpose || '').includes('any maskable')), false);

    const d192 = readPngDimensions(path.join(baseDir, 'icon-192.png'));
    assert.equal(d192.width, 192);
    assert.equal(d192.height, 192);

    const d512 = readPngDimensions(path.join(baseDir, 'icon-512.png'));
    assert.equal(d512.width, 512);
    assert.equal(d512.height, 512);

    const dMask = readPngDimensions(path.join(baseDir, 'icon-maskable-512.png'));
    assert.equal(dMask.width, 512);
    assert.equal(dMask.height, 512);
  }

  // Source web/public and built dist/web must be byte-identical for manifest, sw.js, and icons
  for (const file of ['manifest.webmanifest', 'sw.js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
    const srcBuf = fs.readFileSync(path.join(PUBLIC_DIR, file));
    const distBuf = fs.readFileSync(path.join(DIST_WEB_DIR, file));
    assert.equal(srcBuf.equals(distBuf), true, `Expected dist/web/${file} to match web/public/${file}`);
  }

  for (const htmlPath of [path.join(PLUGIN_ROOT, 'web', 'index.html'), path.join(DIST_WEB_DIR, 'index.html')]) {
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.match(html, /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/);
    assert.match(html, /<link\s+rel="icon"\s+type="image\/png"\s+sizes="192x192"\s+href="\/icon-192\.png"/);
    assert.match(html, /<link\s+rel="apple-touch-icon"\s+href="\/icon-192\.png"/);
    assert.match(html, /<meta\s+name="theme-color"/);
  }

  const swCode = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
  assert.match(swCode, /agy-remote-shell-v3/);
  assert.match(swCode, /agy-remote-assets-v3/);
  assert.match(swCode, /'\/\?enter=1'/);
  assert.match(swCode, /'\/icon-192\.png'/);
  assert.match(swCode, /'\/icon-512\.png'/);
  assert.match(swCode, /'\/icon-maskable-512\.png'/);
  assert.match(swCode, /icon:\s*'\/icon-192\.png'/);
});

test('pwa-server serves manifest, sw.js, and PNG icons unauthenticated with exact MIME types', async () => {
  const server = new MobileRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: DIST_WEB_DIR,
    getToken: () => 'secret-token-123',
    getChannels: () => ({ loopback: true, cloudflare: true })
  });
  const started = await server.start();
  const baseUrl = `http://127.0.0.1:${started.port}`;

  try {
    const checks = [
      ['/manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
      ['/sw.js', 'application/javascript; charset=utf-8'],
      ['/icon-192.png', 'image/png'],
      ['/icon-512.png', 'image/png'],
      ['/icon-maskable-512.png', 'image/png'],
      ['/icon.svg', 'image/svg+xml']
    ];

    for (const [pathname, expectedMime] of checks) {
      const res = await httpRequest(`${baseUrl}${pathname}`, {
        headers: { 'cf-ray': 'test-cf-ray', Host: 'remote.example.com' }
      });
      assert.equal(res.status, 200, `Expected 200 for ${pathname}`);
      assert.equal(res.headers['content-type'], expectedMime, `Unexpected Content-Type for ${pathname}`);
      if (pathname.endsWith('.png')) {
        assert.equal(res.buf.subarray(0, 8).equals(PNG_SIGNATURE), true, `Corrupted PNG bytes for ${pathname}`);
      }
    }
  } finally {
    await server.stop();
  }
});

test('tunnel-landing-html includes PWA head tags, registers SW, persists token, and auto-connects from cached token without loops', async () => {
  const unauthHtml = generateTunnelLandingHtml({
    version: '2.0.0',
    authenticated: false,
    currentChannel: 'cloudflare'
  });

  assert.match(unauthHtml, /<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"/);
  assert.match(unauthHtml, /<link\s+rel="icon"\s+type="image\/png"\s+sizes="192x192"\s+href="\/icon-192\.png"/);
  assert.match(unauthHtml, /<link\s+rel="apple-touch-icon"\s+href="\/icon-192\.png"/);
  assert.match(unauthHtml, /<meta\s+name="theme-color"/);
  assert.match(unauthHtml, /serviceWorker\.register\('\/sw\.js'\)/);

  // 1. Authenticated URL token (?t=...) persists to localStorage & sessionStorage and scrubs URL
  const authHtml = generateTunnelLandingHtml({
    version: '2.0.0',
    authenticated: true,
    currentChannel: 'cloudflare',
    entries: [{ key: 'cloudflare', label: 'Cloudflare', enterUrl: '/?enter=1' }]
  });
  const h1 = createLandingDomHarness({
    html: authHtml,
    initialHref: 'https://remote.example.com/?t=tok_qr_1&session=s9',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ entries: [] }) })
  });
  assert.deepEqual(h1.registeredSw, ['/sw.js']);
  assert.equal(h1.localStorage.getItem('agy_remote_token'), 'tok_qr_1');
  assert.equal(h1.sessionStorage.getItem('agy_remote_token'), 'tok_qr_1');
  assert.equal(h1.currentUrl.search, '?session=s9');

  // 2. Unauthenticated reload at / with cached device token auto-verifies /api/channels & redirects to /?enter=1
  const seenAuthHeaders = [];
  const h2 = createLandingDomHarness({
    html: unauthHtml,
    initialHref: 'https://remote.example.com/?session=s9',
    localStorageData: { agy_remote_token: 'tok_cached_ok' },
    fetchImpl: async (url, init) => {
      seenAuthHeaders.push({ url, auth: init?.headers?.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          channel: 'cloudflare',
          entries: [{ key: 'cloudflare', label: 'Cloudflare', enterUrl: '/?enter=1' }]
        })
      };
    }
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seenAuthHeaders, [{ url: '/api/channels', auth: 'Bearer tok_cached_ok' }]);
  assert.deepEqual(h2.replacedLocations, ['/?session=s9&enter=1']);

  // 3. Unauthenticated /entry with cached device token unlocks channel list in place (no redirect away from /entry)
  const h3 = createLandingDomHarness({
    html: unauthHtml,
    initialHref: 'https://remote.example.com/entry',
    localStorageData: { agy_remote_token: 'tok_cached_ok' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        channel: 'cloudflare',
        writeEnabled: true,
        entries: [{ key: 'cloudflare', label: 'Cloudflare', enterUrl: '/?enter=1' }]
      })
    })
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h3.replacedLocations, []);
  assert.equal(h3.elements.get('agy-landing-auth-card').hidden, true);
  assert.equal(h3.elements.get('agy-landing-channels').hidden, false);

  // 4. Expired cached token (401) stops on input form with clear error and no redirect loop
  const h4 = createLandingDomHarness({
    html: unauthHtml,
    initialHref: 'https://remote.example.com/',
    localStorageData: { agy_remote_token: 'tok_expired' },
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false }) })
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(h4.replacedLocations, []);
  assert.equal(h4.elements.get('agy-landing-auth-card').hidden, false);
  assert.equal(h4.elements.get('agy-landing-auth-error').hidden, false);
  assert.match(h4.elements.get('agy-landing-auth-error').textContent, /失效/);

  // 5. Manual unlock saves token to localStorage and sessionStorage
  const h5 = createLandingDomHarness({
    html: unauthHtml,
    initialHref: 'https://remote.example.com/',
    fetchImpl: async (_url, init) => ({
      ok: init?.headers?.Authorization === 'Bearer tok_manual',
      status: init?.headers?.Authorization === 'Bearer tok_manual' ? 200 : 401,
      json: async () => ({
        ok: true,
        channel: 'cloudflare',
        entries: [{ key: 'cloudflare', label: 'Cloudflare', enterUrl: '/?enter=1' }]
      })
    })
  });
  h5.elements.get('agy-landing-token-input').value = 'tok_manual';
  h5.elements.get('agy-landing-unlock-btn').dispatch('click');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h5.localStorage.getItem('agy_remote_token'), 'tok_manual');
  assert.equal(h5.sessionStorage.getItem('agy_remote_token'), 'tok_manual');
  assert.equal(h5.elements.get('agy-landing-auth-card').hidden, true);
  assert.equal(h5.elements.get('agy-landing-channels').hidden, false);
});
