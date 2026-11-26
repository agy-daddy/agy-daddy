import { createTranslator, LOCALE_STORAGE_KEY, normalizeLocale } from '../i18n';
import type { SupportedLocale } from '../types';
import { api } from './api';

function getTranslator(locale?: SupportedLocale) {
  const stored =
    typeof window !== 'undefined'
      ? normalizeLocale(window.localStorage?.getItem(LOCALE_STORAGE_KEY))
      : null;
  return createTranslator(locale || stored || 'zh-CN');
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  );
}

export async function getActivePushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    return await reg.pushManager.getSubscription();
  } catch {
    return null;
  }
}

export async function subscribeWebPush(
  vapidKeyHint?: string | null,
  locale?: SupportedLocale
): Promise<PushSubscription> {
  const t = getTranslator(locale);
  if (!isPushSupported()) {
    throw new Error(t('push.unsupported'));
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(t('push.denied'));
  }

  let vapidPublicKey = vapidKeyHint || '';
  if (!vapidPublicKey) {
    const keyRes = await api.getVapidKey();
    vapidPublicKey = keyRes.publicKey || keyRes.vapidPublicKey || '';
  }
  if (!vapidPublicKey) {
    throw new Error(t('push.noVapid'));
  }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const keyBytes = urlBase64ToUint8Array(vapidPublicKey);
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes.buffer as ArrayBuffer
    });
  }
  await api.subscribePush(sub.toJSON());
  return sub;
}

export async function unsubscribeWebPush(): Promise<void> {
  const sub = await getActivePushSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  if (endpoint) {
    await api.unsubscribePush(endpoint).catch(() => {});
  }
}

export interface AppBadgeNavigator {
  setAppBadge?: (contents?: number) => Promise<void> | void;
  clearAppBadge?: () => Promise<void> | void;
}

function resolveBadgeNavigator(customNav?: AppBadgeNavigator | null): AppBadgeNavigator | null {
  if (customNav && typeof customNav === 'object') return customNav;
  if (typeof navigator !== 'undefined' && navigator && typeof navigator === 'object') {
    return navigator as unknown as AppBadgeNavigator;
  }
  return null;
}

export function isAppBadgeSupported(customNav?: AppBadgeNavigator | null): boolean {
  const nav = resolveBadgeNavigator(customNav);
  return Boolean(nav && 'setAppBadge' in nav && typeof nav.setAppBadge === 'function');
}

export async function clearAppBadgeSafe(opts?: {
  navigator?: AppBadgeNavigator | null;
}): Promise<boolean> {
  const nav = resolveBadgeNavigator(opts?.navigator);
  if (!nav || !('clearAppBadge' in nav) || typeof nav.clearAppBadge !== 'function') {
    return false;
  }
  try {
    await Promise.resolve(nav.clearAppBadge());
    return true;
  } catch {
    return false;
  }
}

export async function setAppBadgeSafe(
  count: number,
  opts?: { enabled?: boolean; navigator?: AppBadgeNavigator | null }
): Promise<boolean> {
  if (opts?.enabled === false) {
    return false;
  }
  const nav = resolveBadgeNavigator(opts?.navigator);
  if (!nav) return false;
  const normalized = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (normalized <= 0) {
    return clearAppBadgeSafe({ navigator: nav });
  }
  if (!('setAppBadge' in nav) || typeof nav.setAppBadge !== 'function') {
    return false;
  }
  try {
    await Promise.resolve(nav.setAppBadge(normalized));
    return true;
  } catch {
    return false;
  }
}

export function triggerForegroundAlert(opts: { sound: boolean; vibrate: boolean }): void {
  if (opts.vibrate && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try {
      navigator.vibrate([110, 50, 110]);
    } catch {}
  }

  if (opts.sound && typeof window !== 'undefined') {
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.09);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.17);
      osc.onended = () => {
        ctx.close().catch(() => {});
      };
    } catch {}
  }
}
