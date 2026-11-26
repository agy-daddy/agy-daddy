import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNotificationManager,
  getNotificationPermission,
  isNotificationSupported,
  isPageInactive,
  requestNotificationPermission,
} from './notificationManager';

describe('notificationManager', () => {
  const originalNotification = window.Notification;
  const originalHasFocus = document.hasFocus;
  const originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

  function setVisibility(state: DocumentVisibilityState): void {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: state,
    });
  }

  function installMockNotification(
    permission: NotificationPermission = 'granted',
    requestResult: NotificationPermission = 'granted',
  ) {
    const instances: Array<{
      title: string;
      options?: NotificationOptions;
      close: ReturnType<typeof vi.fn>;
      onclick: ((this: Notification, ev: Event) => unknown) | null;
    }> = [];
    const requestPermission = vi.fn().mockResolvedValue(requestResult);
    const MockNotification = vi.fn().mockImplementation(function (
      this: Record<string, unknown>,
      title: string,
      options?: NotificationOptions,
    ) {
      const rec = {
        title,
        options,
        close: vi.fn(),
        onclick: null as ((this: Notification, ev: Event) => unknown) | null,
      };
      instances.push(rec);
      return rec;
    }) as unknown as typeof Notification;

    Object.defineProperty(MockNotification, 'permission', {
      configurable: true,
      get: () => permission,
    });
    (MockNotification as unknown as { requestPermission: typeof requestPermission }).requestPermission =
      requestPermission;

    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: MockNotification,
    });

    return { MockNotification, requestPermission, instances };
  }

  beforeEach(() => {
    setVisibility('visible');
    document.hasFocus = vi.fn(() => true);
    vi.spyOn(window, 'focus').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      writable: true,
      value: originalNotification,
    });
    document.hasFocus = originalHasFocus;
    if (originalVisibilityDescriptor) {
      Object.defineProperty(document, 'visibilityState', originalVisibilityDescriptor);
    } else {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  it('degrades silently without throwing when Notification API is unsupported', async () => {
    delete (window as { Notification?: unknown }).Notification;

    expect(isNotificationSupported()).toBe(false);
    expect(getNotificationPermission()).toBe('unsupported');
    expect(await requestNotificationPermission()).toBe('unsupported');

    setVisibility('hidden');
    const mgr = createNotificationManager(true);
    expect(() =>
      mgr.notify({ id: 'n1', title: 'Test', body: 'Body' }),
    ).not.toThrow();
    expect(mgr.notify({ id: 'n1', title: 'Test', body: 'Body' })).toBeNull();
  });

  it('requests permission only when current state is default', async () => {
    const { requestPermission } = installMockNotification('default', 'granted');
    expect(await requestNotificationPermission()).toBe('granted');
    expect(requestPermission).toHaveBeenCalledTimes(1);

    const grantedMock = installMockNotification('granted', 'granted');
    expect(await requestNotificationPermission()).toBe('granted');
    expect(grantedMock.requestPermission).not.toHaveBeenCalled();

    const deniedMock = installMockNotification('denied', 'denied');
    expect(await requestNotificationPermission()).toBe('denied');
    expect(deniedMock.requestPermission).not.toHaveBeenCalled();
  });

  it('blocks notifications strictly when disabled even if granted and hidden', () => {
    const { MockNotification } = installMockNotification('granted');
    setVisibility('hidden');
    document.hasFocus = vi.fn(() => false);

    const mgr = createNotificationManager(false);
    const res = mgr.notify({ id: 'blocked', title: 'Done', body: 'Task done' });
    expect(res).toBeNull();
    expect(MockNotification).not.toHaveBeenCalled();
  });

  it('does not notify while page is visible and focused', () => {
    const { MockNotification } = installMockNotification('granted');
    setVisibility('visible');
    document.hasFocus = vi.fn(() => true);

    expect(isPageInactive()).toBe(false);
    const mgr = createNotificationManager(true);
    expect(mgr.notify({ id: 'active-skip', title: 'Done', body: 'Task done' })).toBeNull();
    expect(MockNotification).not.toHaveBeenCalled();
  });

  it('fires when hidden or unfocused, deduplicates, and handles click focus+close+callback', () => {
    const { MockNotification, instances } = installMockNotification('granted');
    setVisibility('visible');
    document.hasFocus = vi.fn(() => false);
    expect(isPageInactive()).toBe(true);

    const onClick = vi.fn();
    const mgr = createNotificationManager(true);
    const n1 = mgr.notify({
      id: 'task:cmd:1:done',
      title: 'Task completed',
      body: 'npm test finished',
      tag: 'task:cmd:1',
      onClick,
    });
    expect(n1).not.toBeNull();
    expect(MockNotification).toHaveBeenCalledTimes(1);
    expect(MockNotification).toHaveBeenCalledWith('Task completed', {
      body: 'npm test finished',
      tag: 'task:cmd:1',
    });

    // Duplicate ID within TTL is suppressed
    const dup = mgr.notify({
      id: 'task:cmd:1:done',
      title: 'Task completed',
      body: 'npm test finished',
    });
    expect(dup).toBeNull();
    expect(MockNotification).toHaveBeenCalledTimes(1);

    // Click focuses window, closes notification, and runs callback
    instances[0].onclick?.call(instances[0] as unknown as Notification, new Event('click'));
    expect(window.focus).toHaveBeenCalledTimes(1);
    expect(instances[0].close).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
