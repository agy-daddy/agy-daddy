export type NotificationPermissionState = NotificationPermission | 'unsupported';

export interface DispatchNotificationInput {
  id: string;
  title: string;
  body: string;
  tag?: string;
  onClick?: () => void;
}

export interface NotificationManager {
  setEnabled: (enabled: boolean) => void;
  isEnabled: () => boolean;
  notify: (input: DispatchNotificationInput) => Notification | null;
  clearDedup: () => void;
}

const DEFAULT_DEDUP_TTL_MS = 5000;
const MAX_DEDUP_ENTRIES = 200;

/**
 * Check whether the browser runtime exposes the Web Notification constructor.
 */
export function isNotificationSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    typeof window.Notification === 'function'
  );
}

/**
 * Safely read the current Web Notification permission without throwing.
 */
export function getNotificationPermission(): NotificationPermissionState {
  if (!isNotificationSupported()) return 'unsupported';
  try {
    return window.Notification.permission;
  } catch {
    return 'unsupported';
  }
}

/**
 * Return true only when the page is hidden or unfocused.
 */
export function isPageInactive(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState === 'hidden') return true;
  try {
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
      return true;
    }
  } catch {
    // Ignore host environment focus probe errors
  }
  return false;
}

/**
 * Request browser notification permission only when supported and currently 'default'.
 * Callers must invoke this only on explicit user intent (toggling on or clicking grant).
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isNotificationSupported()) return 'unsupported';
  const current = getNotificationPermission();
  if (current !== 'default') return current;
  try {
    if (typeof window.Notification.requestPermission !== 'function') {
      return getNotificationPermission();
    }
    const result = await window.Notification.requestPermission();
    return result || getNotificationPermission();
  } catch {
    return getNotificationPermission();
  }
}

/**
 * Create a gated browser Notification manager that strictly obeys plugin enablement,
 * browser permission, page inactivity, and short-window deduplication.
 */
export function createNotificationManager(initialEnabled = false): NotificationManager {
  let enabled = Boolean(initialEnabled);
  const recentIds = new Map<string, number>();

  function pruneDedup(now: number): void {
    for (const [key, ts] of recentIds.entries()) {
      if (now - ts >= DEFAULT_DEDUP_TTL_MS) {
        recentIds.delete(key);
      }
    }
    while (recentIds.size > MAX_DEDUP_ENTRIES) {
      const oldest = recentIds.keys().next().value;
      if (oldest === undefined) break;
      recentIds.delete(oldest);
    }
  }

  return {
    setEnabled(next: boolean): void {
      enabled = Boolean(next);
    },
    isEnabled(): boolean {
      return enabled;
    },
    clearDedup(): void {
      recentIds.clear();
    },
    notify(input: DispatchNotificationInput): Notification | null {
      if (!enabled) return null;
      if (!isNotificationSupported()) return null;
      if (getNotificationPermission() !== 'granted') return null;
      if (!isPageInactive()) return null;

      const now = Date.now();
      pruneDedup(now);
      const prevTs = recentIds.get(input.id);
      if (prevTs !== undefined && now - prevTs < DEFAULT_DEDUP_TTL_MS) {
        return null;
      }
      recentIds.set(input.id, now);

      try {
        const notification = new window.Notification(input.title, {
          body: input.body,
          tag: input.tag || input.id,
        });
        notification.onclick = () => {
          try {
            if (typeof window !== 'undefined' && typeof window.focus === 'function') {
              window.focus();
            }
          } catch {
            // Ignore window focus restrictions
          }
          try {
            notification.close();
          } catch {
            // Ignore close errors
          }
          try {
            input.onClick?.();
          } catch {
            // Ignore navigation callback errors
          }
        };
        return notification;
      } catch {
        return null;
      }
    },
  };
}
