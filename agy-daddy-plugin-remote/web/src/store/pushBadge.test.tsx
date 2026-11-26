import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import swCode from '../../public/sw.js?raw';
import { I18nProvider } from '../i18n';
import { CustomMenuSheet } from '../sheets/CustomMenuSheet';
import { ThemeProvider } from '../theme/ThemeProvider';
import { clearAppBadgeSafe, isAppBadgeSupported, setAppBadgeSafe } from './push';
import { RemoteStoreController } from './useRemoteStore';

function setVisibilityState(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: state
  });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    value: state === 'hidden'
  });
}

function loadServiceWorkerHarness(navMock: Record<string, unknown>) {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const clientFocus = vi.fn().mockResolvedValue(undefined);
  const clientPostMessage = vi.fn();
  const openWindow = vi.fn().mockResolvedValue(undefined);

  const selfCtx = {
    location: { origin: 'https://remote.example.com' },
    navigator: navMock,
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn().mockResolvedValue(undefined),
      matchAll: vi.fn().mockResolvedValue([{ focus: clientFocus, postMessage: clientPostMessage }]),
      openWindow
    },
    registration: {
      showNotification
    },
    addEventListener(type: string, fn: (ev: unknown) => void) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    }
  };

  const cachesMock = {
    open: vi.fn().mockResolvedValue({ addAll: vi.fn().mockResolvedValue(undefined) }),
    keys: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(true),
    match: vi.fn().mockResolvedValue(undefined)
  };

  const fn = new Function('self', 'URL', 'Response', 'Promise', 'caches', swCode);
  fn(selfCtx, URL, Response, Promise, cachesMock);

  async function dispatch(type: string, eventObj: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    const ev = {
      ...eventObj,
      waitUntil(p: Promise<unknown>) {
        waits.push(Promise.resolve(p));
      }
    };
    for (const fn of listeners.get(type) || []) {
      fn(ev);
    }
    await Promise.all(waits);
  }

  return {
    dispatch,
    showNotification,
    clientFocus,
    clientPostMessage,
    openWindow
  };
}

describe('App Badging defensive wrapper & Service Worker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('silently degrades on unsupported platforms without throwing', async () => {
    const unsupportedNav = {};
    expect(isAppBadgeSupported(unsupportedNav)).toBe(false);
    await expect(setAppBadgeSafe(3, { navigator: unsupportedNav })).resolves.toBe(false);
    await expect(clearAppBadgeSafe({ navigator: unsupportedNav })).resolves.toBe(false);
  });

  it('calls setAppBadge/clearAppBadge when supported and blocks setAppBadge when disabled', async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    const nav = { setAppBadge, clearAppBadge };

    expect(isAppBadgeSupported(nav)).toBe(true);
    await expect(setAppBadgeSafe(4, { enabled: true, navigator: nav })).resolves.toBe(true);
    expect(setAppBadge).toHaveBeenCalledWith(4);

    // Disabled -> never calls setAppBadge
    setAppBadge.mockClear();
    await expect(setAppBadgeSafe(5, { enabled: false, navigator: nav })).resolves.toBe(false);
    expect(setAppBadge).not.toHaveBeenCalled();

    // Zero count -> calls clearAppBadge instead of setAppBadge
    await expect(setAppBadgeSafe(0, { enabled: true, navigator: nav })).resolves.toBe(true);
    expect(setAppBadge).not.toHaveBeenCalled();
    expect(clearAppBadge).toHaveBeenCalledTimes(1);

    // Errors from browser API are swallowed silently
    const brokenNav = {
      setAppBadge: vi.fn().mockRejectedValue(new Error('NotAllowedError')),
      clearAppBadge: vi.fn(() => {
        throw new Error('SyncError');
      })
    };
    await expect(setAppBadgeSafe(2, { enabled: true, navigator: brokenNav })).resolves.toBe(false);
    await expect(clearAppBadgeSafe({ navigator: brokenNav })).resolves.toBe(false);
  });

  it('sw.js handles push badgeEnabled=true/false, unsupported navigator, and clears badge on notificationclick', async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    const sw = loadServiceWorkerHarness({ setAppBadge, clearAppBadge });

    // 1. Push with badgeEnabled=true & badgeCount=3
    await sw.dispatch('push', {
      data: {
        json: () => ({
          type: 'attention',
          sessionId: 'sess-9',
          title: 'Approval Needed',
          body: 'Run tests?',
          badgeEnabled: true,
          badgeCount: 3
        })
      }
    });
    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    expect(setAppBadge).toHaveBeenCalledWith(3);

    // 2. Push with badgeEnabled=false -> never calls setAppBadge
    setAppBadge.mockClear();
    await sw.dispatch('push', {
      data: {
        json: () => ({
          type: 'attention',
          sessionId: 'sess-9',
          title: 'Done',
          badgeEnabled: false,
          badgeCount: 4
        })
      }
    });
    expect(setAppBadge).not.toHaveBeenCalled();

    // 3. notificationclick -> clears badge, focuses client, posts NAVIGATE_SESSION
    await sw.dispatch('notificationclick', {
      notification: {
        close: vi.fn(),
        data: { sessionId: 'sess-9', url: '/?session=sess-9' }
      }
    });
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
    expect(sw.clientFocus).toHaveBeenCalledTimes(1);
    expect(sw.clientPostMessage).toHaveBeenCalledWith({ type: 'NAVIGATE_SESSION', sessionId: 'sess-9' });

    // 4. Unsupported self.navigator -> silent degradation
    const unsupportedSw = loadServiceWorkerHarness({});
    await expect(
      unsupportedSw.dispatch('push', {
        data: { json: () => ({ title: 'Hi', badgeEnabled: true, badgeCount: 2 }) }
      })
    ).resolves.toBeUndefined();
    expect(unsupportedSw.showNotification).toHaveBeenCalledTimes(1);
  });
});

describe('RemoteStoreController notification settings & App Badge lifecycle', () => {
  beforeEach(() => {
    setVisibilityState('visible');
    window.localStorage?.clear();
  });

  afterEach(() => {
    cleanup();
    setVisibilityState('visible');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('syncs host settings, blocks push subscription when disabled, sets badge in background & clears in foreground', async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'setAppBadge', {
      configurable: true,
      value: setAppBadge
    });
    Object.defineProperty(window.navigator, 'clearAppBadge', {
      configurable: true,
      value: clearAppBadge
    });

    const requestPermission = vi.fn().mockResolvedValue('granted');
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });

    let sseListeners: Record<string, (ev: MessageEvent) => void> = {};
    vi.stubGlobal(
      'EventSource',
      class MockEventSource {
        onopen: (() => void) | null = null;
        onerror: (() => void) | null = null;
        addEventListener(type: string, cb: (ev: MessageEvent) => void) {
          sseListeners[type] = cb;
        }
        close() {}
      }
    );

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/bootstrap')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              channel: 'loopback',
              permissionLevel: 'L1',
              writeEnabled: true,
              models: [{ id: 'g25', shortName: 'G2.5' }],
              workspaces: ['/repo'],
              enablePushNotifications: false,
              enableAppBadge: true,
              notifications: { enablePushNotifications: false, enableAppBadge: true }
            })
        };
      }
      if (url.includes('/api/v1/sessions')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ok: true,
              sessions: [
                { cascadeId: 's1', title: 'S1', status: 'PENDING', needsAttention: true, stepCount: 1 },
                { cascadeId: 's2', title: 'S2', status: 'PENDING', needsAttention: true, stepCount: 1 }
              ]
            })
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, events: [], queue: [] }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    window.history.replaceState(null, '', '/?t=tok-badge');
    const store = new RemoteStoreController();
    await store.init();

    expect(store.getState().enablePushNotifications).toBe(false);
    expect(store.getState().enableAppBadge).toBe(true);

    // 1. Push toggle blocked when host disabled enablePushNotifications
    await store.togglePushSubscription();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(store.getState().toast).toContain('关闭');

    // 2. Send test push blocked when host disabled
    await store.sendTestPush();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/v1/push/test'))).toBe(false);

    // 3. Background visibility with 2 attention sessions -> setAppBadge(2)
    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(2));

    // 4. Foreground visible / focus -> clearAppBadge()
    setVisibilityState('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(clearAppBadge).toHaveBeenCalled());

    // 5. Host toggles enableAppBadge=false via SSE state.patch -> clears badge & blocks future setAppBadge
    clearAppBadge.mockClear();
    setAppBadge.mockClear();
    sseListeners['state.patch']?.({
      data: JSON.stringify({
        key: 'state:remote.notifications@1',
        value: { enablePushNotifications: true, enableAppBadge: false }
      })
    } as MessageEvent);

    expect(store.getState().enablePushNotifications).toBe(true);
    expect(store.getState().enableAppBadge).toBe(false);
    expect(clearAppBadge).toHaveBeenCalledTimes(1);

    setVisibilityState('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(setAppBadge).not.toHaveBeenCalled();

    store.destroy();
  });

  it('CustomMenuSheet disables push controls and displays host-disabled note when enablePushNotifications=false', () => {
    render(
      <I18nProvider locale="zh-CN">
        <ThemeProvider>
          <CustomMenuSheet
            open={true}
            channel="loopback"
            permissionLevel="L1"
            runningTasksCount={0}
            appearance="auto"
            colorTheme="monochrome"
            drawerSpeed="normal"
            soundAlert={true}
            vibrateAlert={true}
            enablePushNotifications={false}
            enableAppBadge={false}
            pushSubscribed={false}
            pushBusy={false}
            onSetAppearance={vi.fn()}
            onSetColorTheme={vi.fn()}
            onSetDrawerSpeed={vi.fn()}
            onSetLocale={vi.fn()}
            onToggleSound={vi.fn()}
            onToggleVibrate={vi.fn()}
            onTogglePush={vi.fn()}
            onTestPush={vi.fn()}
            onOpenChannels={vi.fn()}
            onOpenTasks={vi.fn()}
            onShowToast={vi.fn()}
            onClose={vi.fn()}
          />
        </ThemeProvider>
      </I18nProvider>
    );

    expect(screen.getByTestId('menu-push-toggle-btn')).toBeDisabled();
    expect(screen.getByTestId('menu-push-test-btn')).toBeDisabled();
    expect(screen.getByTestId('menu-push-host-disabled')).toBeInTheDocument();
  });
});
