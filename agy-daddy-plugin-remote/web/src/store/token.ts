const TOKEN_KEY = 'agy_remote_token';
const CID_KEY = 'agy_remote_client_id';
const DID_KEY = 'agy_remote_device_hint';

export interface InitialUrlState {
  token: string;
  sessionId: string;
  enteredFromLanding: boolean;
  switchTicket: string;
}

export function getClientId(): string {
  try {
    const existing = window.sessionStorage?.getItem(CID_KEY);
    if (existing) return existing;
    const next = `cli_${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage?.setItem(CID_KEY, next);
    return next;
  } catch {
    return 'cli_default';
  }
}

export function getDeviceHint(): string {
  try {
    const existing = window.localStorage?.getItem(DID_KEY);
    if (existing) return existing;
    const next = `dev_${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage?.setItem(DID_KEY, next);
    return next;
  } catch {
    return 'dev_default';
  }
}

export function saveToken(token: string): void {
  const clean = token.trim();
  if (!clean) return;
  try {
    window.sessionStorage?.setItem(TOKEN_KEY, clean);
  } catch {}
  try {
    window.localStorage?.setItem(TOKEN_KEY, clean);
  } catch {}
}

export function loadSavedToken(): string {
  try {
    return (
      window.sessionStorage?.getItem(TOKEN_KEY) ||
      window.localStorage?.getItem(TOKEN_KEY) ||
      ''
    );
  } catch {
    return '';
  }
}

export function clearSavedToken(): void {
  try {
    window.sessionStorage?.removeItem(TOKEN_KEY);
    window.localStorage?.removeItem(TOKEN_KEY);
  } catch {}
}

export function scrubSwitchTicketFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('switch_ticket') && !url.searchParams.has('enter')) return;
    url.searchParams.delete('switch_ticket');
    url.searchParams.delete('enter');
    const nextSearch = url.searchParams.toString();
    const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
    window.history?.replaceState?.(null, '', nextUrl);
  } catch {}
}

export function syncSessionUrl(sessionId: string | null | undefined): void {
  try {
    const url = new URL(window.location.href);
    const clean = String(sessionId || '').trim();
    if (clean) {
      if (url.searchParams.get('session') === clean) return;
      url.searchParams.set('session', clean);
    } else {
      if (!url.searchParams.has('session')) return;
      url.searchParams.delete('session');
    }
    const nextSearch = url.searchParams.toString();
    const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
    window.history?.replaceState?.(null, '', nextUrl);
  } catch {}
}

export function extractTokenAndScrubUrl(): InitialUrlState {
  let token = '';
  let sessionId = '';
  let enteredFromLanding = false;
  let switchTicket = '';

  try {
    const url = new URL(window.location.href);
    const urlToken = (url.searchParams.get('t') || url.searchParams.get('token') || '').trim();
    sessionId = (url.searchParams.get('session') || '').trim();
    switchTicket = (url.searchParams.get('switch_ticket') || '').trim();
    enteredFromLanding =
      url.searchParams.get('enter') === '1' || url.searchParams.get('direct') === '1';

    if (urlToken) {
      token = urlToken;
      saveToken(urlToken);
      url.searchParams.delete('t');
      url.searchParams.delete('token');
      const nextSearch = url.searchParams.toString();
      const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
      window.history?.replaceState?.(null, '', nextUrl);
    } else {
      token = loadSavedToken();
    }
  } catch {
    token = loadSavedToken();
  }

  return { token, sessionId, enteredFromLanding, switchTicket };
}
