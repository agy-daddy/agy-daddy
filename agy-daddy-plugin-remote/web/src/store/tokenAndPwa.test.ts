import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import swCode from '../../public/sw.js?raw';
import {
  clearSavedToken,
  extractTokenAndScrubUrl,
  loadSavedToken,
  saveToken,
  scrubSwitchTicketFromUrl
} from './token';
import { RemoteStoreController } from './useRemoteStore';

describe('Token persistence, URL scrubbing, and reload reconnect', () => {
  beforeEach(() => {
    window.localStorage?.clear();
    window.sessionStorage?.clear();
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('scrubSwitchTicketFromUrl removes switch_ticket while preserving or ensuring enter=1', () => {
    window.history.replaceState(null, '', '/?enter=1&switch_ticket=st_abc&session=cid-7');
    scrubSwitchTicketFromUrl();
    expect(window.location.search).toBe('?enter=1&session=cid-7');

    window.history.replaceState(null, '', '/?switch_ticket=st_xyz&session=cid-8');
    scrubSwitchTicketFromUrl();
    const params = new URLSearchParams(window.location.search);
    expect(params.has('switch_ticket')).toBe(false);
    expect(params.get('enter')).toBe('1');
    expect(params.get('session')).toBe('cid-8');

    window.history.replaceState(null, '', '/?enter=1&session=cid-9');
    scrubSwitchTicketFromUrl();
    expect(window.location.search).toBe('?enter=1&session=cid-9');
  });

  it('loadSavedToken prioritizes localStorage, syncs across storages, and isolates storage exceptions', () => {
    window.localStorage.setItem('agy_remote_token', 'tok_device_new');
    window.sessionStorage.setItem('agy_remote_token', 'tok_tab_old');
    expect(loadSavedToken()).toBe('tok_device_new');
    expect(window.sessionStorage.getItem('agy_remote_token')).toBe('tok_device_new');

    window.localStorage.clear();
    window.sessionStorage.setItem('agy_remote_token', 'tok_session_fallback');
    expect(loadSavedToken()).toBe('tok_session_fallback');
    expect(window.localStorage.getItem('agy_remote_token')).toBe('tok_session_fallback');

    // Throwing sessionStorage does not block localStorage read
    const origSessionStorage = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    const origLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const throwingStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      }
    };

    try {
      Object.defineProperty(window, 'sessionStorage', { configurable: true, value: throwingStorage });
      window.localStorage.setItem('agy_remote_token', 'tok_local_only');
      expect(loadSavedToken()).toBe('tok_local_only');

      if (origSessionStorage) Object.defineProperty(window, 'sessionStorage', origSessionStorage);
      Object.defineProperty(window, 'localStorage', { configurable: true, value: throwingStorage });
      window.sessionStorage.setItem('agy_remote_token', 'tok_session_resilient');
      expect(loadSavedToken()).toBe('tok_session_resilient');
    } finally {
      if (origSessionStorage) Object.defineProperty(window, 'sessionStorage', origSessionStorage);
      if (origLocalStorage) Object.defineProperty(window, 'localStorage', origLocalStorage);
    }
  });

  it('extractTokenAndScrubUrl falls back to cached token when URL has no token', () => {
    saveToken('tok_cached_123');
    window.history.replaceState(null, '', '/?enter=1&session=s1');
    const state = extractTokenAndScrubUrl();
    expect(state.token).toBe('tok_cached_123');
    expect(state.enteredFromLanding).toBe(true);
    expect(state.sessionId).toBe('s1');
    expect(window.location.search).toBe('?enter=1&session=s1');
  });

  it('RemoteStoreController.init auto-connects with cached token, preserves token on transient network error, and surfaces authError on 401', async () => {
    window.localStorage.setItem('agy_remote_token', 'tok_reload_1');
    window.history.replaceState(null, '', '/?enter=1');

    vi.stubGlobal(
      'EventSource',
      class MockEventSource {
        addEventListener() {}
        close() {}
      }
    );

    const authHeaders: string[] = [];
    let mode: 'network_fail' | 'unauthorized' | 'ok' = 'network_fail';

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        const auth = headers.get('Authorization') || '';
        if (auth) authHeaders.push(auth);

        if (mode === 'network_fail') {
          throw new TypeError('Failed to fetch');
        }
        if (mode === 'unauthorized') {
          return {
            ok: false,
            status: 401,
            text: async () => JSON.stringify({ ok: false, error: 'UNAUTHORIZED' })
          };
        }
        if (url.includes('/api/v1/bootstrap')) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                ok: true,
                channel: 'cloudflare',
                permissionLevel: 'L1',
                writeEnabled: true,
                models: [{ id: 'g25', shortName: 'G2.5' }],
                workspaces: ['/repo']
              })
          };
        }
        if (url.includes('/api/v1/sessions')) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ok: true, sessions: [] })
          };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
      })
    );

    const ctrl = new RemoteStoreController();
    await ctrl.init();

    // Attempted auto-connection using cached token; transient network error keeps cached token intact
    expect(authHeaders).toContain('Bearer tok_reload_1');
    expect(ctrl.getState().token).toBe('tok_reload_1');
    expect(ctrl.getState().authError).toBe('');
    expect(window.localStorage.getItem('agy_remote_token')).toBe('tok_reload_1');

    // Coming back online retries connectAndSync automatically; 401 exposes authError cleanly
    mode = 'unauthorized';
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => {
      expect(ctrl.getState().authError).not.toBe('');
    });

    // Next valid reconnect clears authError
    mode = 'ok';
    await ctrl.connectAndSync();
    expect(ctrl.getState().authError).toBe('');
    expect(ctrl.getState().bootstrap?.channel).toBe('cloudflare');

    ctrl.destroy();
    clearSavedToken();
  });

  it('sw.js uses /icon-192.png for notifications and isolates "/" and "/?enter=1" navigation caches', async () => {
    const listeners = new Map<string, Array<(ev: unknown) => void>>();
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const putCalls: Array<{ cacheName: string; key: string; body: string }> = [];
    const cacheStore = new Map<string, Response>();

    const makeCache = (cacheName: string) => ({
      addAll: vi.fn().mockResolvedValue(undefined),
      match: vi.fn(async (req: Request | string) => {
        const key = typeof req === 'string' ? req : new URL(req.url).pathname + new URL(req.url).search;
        return cacheStore.get(`${cacheName}:${key}`);
      }),
      put: vi.fn(async (req: Request | string, res: Response) => {
        const key = typeof req === 'string' ? req : new URL(req.url).pathname + new URL(req.url).search;
        const txt = await res.clone().text();
        putCalls.push({ cacheName, key, body: txt });
        cacheStore.set(`${cacheName}:${key}`, new Response(txt, { status: 200 }));
      })
    });

    const cachesMock = {
      open: vi.fn(async (name: string) => makeCache(name)),
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
      match: vi.fn(async (req: Request | string) => {
        const key = typeof req === 'string' ? req : new URL(req.url).pathname + new URL(req.url).search;
        return cacheStore.get(`agy-remote-shell-v3:${key}`);
      })
    };

    const fetchMock = vi.fn(async (req: Request) => {
      const u = new URL(req.url);
      if (u.searchParams.get('enter') === '1') {
        return new Response('console-shell', { status: 200 });
      }
      return new Response('landing-shell', { status: 200 });
    });

    const selfCtx = {
      location: { origin: 'https://remote.example.com' },
      navigator: {},
      skipWaiting: vi.fn(),
      clients: { claim: vi.fn(), matchAll: vi.fn(), openWindow: vi.fn() },
      registration: { showNotification },
      addEventListener(type: string, fn: (ev: unknown) => void) {
        const list = listeners.get(type) || [];
        list.push(fn);
        listeners.set(type, list);
      }
    };

    const fn = new Function('self', 'URL', 'Response', 'Promise', 'caches', 'fetch', swCode);
    fn(selfCtx, URL, Response, Promise, cachesMock, fetchMock);

    // Push uses PNG icon
    const pushWaits: Promise<unknown>[] = [];
    for (const handler of listeners.get('push') || []) {
      handler({
        data: { json: () => ({ title: 'Done', body: 'Ready', sessionId: 's1' }) },
        waitUntil: (p: Promise<unknown>) => pushWaits.push(Promise.resolve(p))
      });
    }
    await Promise.all(pushWaits);
    expect(showNotification).toHaveBeenCalledWith(
      'Done',
      expect.objectContaining({
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: expect.objectContaining({ url: '/?enter=1&session=s1' })
      })
    );

    // Fetch '/' and '/?enter=1' store into isolated keys
    const handleFetch = async (urlStr: string) => {
      let respPromise: Promise<Response> | null = null;
      for (const handler of listeners.get('fetch') || []) {
        handler({
          request: { method: 'GET', mode: 'navigate', url: urlStr },
          respondWith: (p: Promise<Response>) => {
            respPromise = Promise.resolve(p);
          }
        });
      }
      expect(respPromise).not.toBeNull();
      return respPromise!;
    };

    const rLanding = await handleFetch('https://remote.example.com/');
    expect(await rLanding.text()).toBe('landing-shell');
    const rConsole = await handleFetch('https://remote.example.com/?enter=1');
    expect(await rConsole.text()).toBe('console-shell');

    await new Promise((r) => setTimeout(r, 10));
    expect(putCalls.some((c) => c.key === '/' && c.body === 'landing-shell')).toBe(true);
    expect(putCalls.some((c) => c.key === '/?enter=1' && c.body === 'console-shell')).toBe(true);
    expect(cacheStore.get('agy-remote-shell-v3:/')?.status).toBe(200);
    expect(await cacheStore.get('agy-remote-shell-v3:/')?.clone().text()).toBe('landing-shell');
    expect(await cacheStore.get('agy-remote-shell-v3:/?enter=1')?.clone().text()).toBe('console-shell');
  });
});
