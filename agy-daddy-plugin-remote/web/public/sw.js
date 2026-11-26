const SHELL_CACHE = 'agy-remote-shell-v2';
const ASSET_CACHE = 'agy-remote-assets-v2';
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/') || url.pathname === '/entry') {
    return;
  }

  // CacheFirst for hashed Vite assets & static shell icons
  if (url.pathname.startsWith('/assets/') || url.pathname === '/icon.svg' || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const fresh = await fetch(req);
        if (fresh && fresh.ok) {
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      })
    );
    return;
  }

  // NetworkFirst for / and HTML navigation
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put('/', copy)).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match('/');
          return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
        })
    );
  }
});

function resolveBadgeCountFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return 0;
  if (payload.badgeEnabled === false || payload.enableAppBadge === false) return -1;
  const raw = payload.badgeCount ?? payload.unreadCount ?? payload.pendingCount ?? payload.count;
  const parsed = Number(raw);
  if (Number.isFinite(parsed)) {
    return parsed > 0 ? Math.floor(parsed) : 0;
  }
  const hasReminder =
    payload.type === 'attention' ||
    payload.type === 'test' ||
    payload.status === 'DONE' ||
    payload.status === 'PENDING' ||
    payload.status === 'ERROR' ||
    Boolean(payload.title || payload.body);
  return hasReminder ? 1 : 0;
}

function updateSwAppBadge(count) {
  try {
    const nav = typeof self !== 'undefined' ? self.navigator : undefined;
    if (!nav || typeof nav !== 'object') return Promise.resolve();
    if (count > 0 && 'setAppBadge' in nav && typeof nav.setAppBadge === 'function') {
      return Promise.resolve().then(() => nav.setAppBadge(count)).catch(() => {});
    }
    if (count === 0 && 'clearAppBadge' in nav && typeof nav.clearAppBadge === 'function') {
      return Promise.resolve().then(() => nav.clearAppBadge()).catch(() => {});
    }
  } catch {}
  return Promise.resolve();
}

function clearSwAppBadge() {
  try {
    const nav = typeof self !== 'undefined' ? self.navigator : undefined;
    if (!nav || typeof nav !== 'object') return Promise.resolve();
    if ('clearAppBadge' in nav && typeof nav.clearAppBadge === 'function') {
      return Promise.resolve().then(() => nav.clearAppBadge()).catch(() => {});
    }
  } catch {}
  return Promise.resolve();
}

self.addEventListener('push', (event) => {
  let payload = { title: 'Agy-Daddy Remote', body: '会话状态更新' };
  try {
    if (event.data) {
      const parsed = event.data.json();
      if (parsed && typeof parsed === 'object') payload = { ...payload, ...parsed };
    }
  } catch {
    try {
      const txt = event.data ? event.data.text() : '';
      if (txt) payload.body = txt;
    } catch {}
  }
  const sessionId = payload.sessionId || (payload.data && payload.data.sessionId) || '';
  const targetUrl = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/';
  const badgeCount = resolveBadgeCountFromPayload(payload);
  const badgeTask = badgeCount >= 0
    ? updateSwAppBadge(badgeCount)
    : (payload.clearBadge === true ? clearSwAppBadge() : Promise.resolve());
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(payload.title || 'Agy-Daddy Remote', {
        body: payload.body || '',
        icon: '/icon.svg',
        badge: '/icon.svg',
        tag: payload.tag || (sessionId ? `agy-session-${sessionId}` : 'agy-remote'),
        renotify: true,
        data: { url: targetUrl, sessionId }
      }),
      badgeTask
    ])
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const sessionId = data.sessionId || '';
  const targetUrl = data.url || (sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/');

  event.waitUntil(
    Promise.all([
      clearSwAppBadge(),
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
        for (const client of clientList) {
          if ('focus' in client) {
            await client.focus();
            if (sessionId) {
              client.postMessage({ type: 'NAVIGATE_SESSION', sessionId });
            }
            return;
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      })
    ])
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'CLEAR_APP_BADGE') {
    event.waitUntil(clearSwAppBadge());
  }
});
