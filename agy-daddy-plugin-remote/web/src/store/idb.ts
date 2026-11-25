import type { QueuedMessage, SessionDetail, SessionEvent, SessionSummary } from '../types';

const DB_NAME = 'agy_remote_v2';
const DB_VERSION = 1;
const MAX_CACHED_SESSIONS = 10;
const MAX_CACHED_STEPS = 30;
const DEFAULT_DRAFT_DEBOUNCE_MS = 300;
const DEFAULT_SNAPSHOT_THROTTLE_MS = 1200;

export interface CachedSessionSnapshot {
  cascadeId: string;
  session: SessionDetail | null;
  events: SessionEvent[];
  savedAt: number;
}

interface PendingDraftEntry {
  key: string;
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingSnapshotEntry {
  cascadeId: string;
  session: SessionDetail | null;
  events: SessionEvent[];
  timer: ReturnType<typeof setTimeout> | null;
}

const memStore = new Map<string, unknown>();
let dbPromise: Promise<IDBDatabase | null> | null = null;
let activeDb: IDBDatabase | null = null;
let dbOpenGen = 0;

const pendingDrafts = new Map<string, PendingDraftEntry>();
const pendingSnapshots = new Map<string, PendingSnapshotEntry>();
const lastSnapshotSaveAt = new Map<string, number>();

function normalizeDraftKey(sessionId: string): string {
  return sessionId || '__global__';
}

function clearPendingDraft(key: string): void {
  const existing = pendingDrafts.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    pendingDrafts.delete(key);
  }
}

function clearPendingSnapshot(cascadeId: string): void {
  const existing = pendingSnapshots.get(cascadeId);
  if (existing) {
    if (existing.timer !== null) {
      clearTimeout(existing.timer);
    }
    pendingSnapshots.delete(cascadeId);
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  const gen = dbOpenGen;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of ['kv', 'snapshots', 'drafts', 'queue']) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name);
          }
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        if (gen !== dbOpenGen) {
          db.close?.();
          resolve(null);
          return;
        }
        activeDb = db;
        db.onversionchange = () => {
          db.close?.();
          if (activeDb === db) activeDb = null;
          dbPromise = null;
        };
        db.onclose = () => {
          if (activeDb === db) activeDb = null;
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        if (gen === dbOpenGen) {
          dbPromise = null;
        }
        resolve(null);
      };
      req.onblocked = () => {
        if (gen === dbOpenGen) {
          dbPromise = null;
        }
        resolve(null);
      };
    } catch {
      if (gen === dbOpenGen) {
        dbPromise = null;
      }
      resolve(null);
    }
  });

  return dbPromise;
}

async function idbGet<T>(storeName: string, key: string): Promise<T | null> {
  const memKey = `${storeName}:${key}`;
  const db = await openDb();
  if (!db) {
    return (memStore.get(memKey) as T | undefined) ?? null;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve((memStore.get(memKey) as T | undefined) ?? null);
      tx.onabort = () => resolve((memStore.get(memKey) as T | undefined) ?? null);
    } catch {
      if (activeDb === db) {
        activeDb = null;
        dbPromise = null;
      }
      resolve((memStore.get(memKey) as T | undefined) ?? null);
    }
  });
}

async function idbSet<T>(storeName: string, key: string, value: T): Promise<void> {
  const memKey = `${storeName}:${key}`;
  memStore.set(memKey, value);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      if (activeDb === db) {
        activeDb = null;
        dbPromise = null;
      }
      resolve();
    }
  });
}

export async function saveSessionsCache(sessions: SessionSummary[]): Promise<void> {
  const trimmed = sessions.slice(0, MAX_CACHED_SESSIONS);
  await idbSet('kv', 'recent_sessions', trimmed);
}

export async function loadSessionsCache(): Promise<SessionSummary[]> {
  return (await idbGet<SessionSummary[]>('kv', 'recent_sessions')) || [];
}

export async function saveSessionSnapshot(
  cascadeId: string,
  session: SessionDetail | null,
  events: SessionEvent[]
): Promise<void> {
  if (!cascadeId) return;
  clearPendingSnapshot(cascadeId);
  lastSnapshotSaveAt.set(cascadeId, Date.now());
  const confirmedEvents = events.filter(
    (ev) => ev.seq >= 0 && ev.payload?.optimistic !== true
  );
  const snap: CachedSessionSnapshot = {
    cascadeId,
    session,
    events: confirmedEvents.slice(-MAX_CACHED_STEPS),
    savedAt: Date.now()
  };
  await idbSet('snapshots', cascadeId, snap);
}

export function scheduleSnapshotSave(
  cascadeId: string,
  session: SessionDetail | null,
  events: SessionEvent[],
  intervalMs = DEFAULT_SNAPSHOT_THROTTLE_MS
): void {
  if (!cascadeId) return;
  if (intervalMs <= 0) {
    void saveSessionSnapshot(cascadeId, session, events);
    return;
  }

  const now = Date.now();
  const lastAt = lastSnapshotSaveAt.get(cascadeId);
  const elapsed = lastAt === undefined ? intervalMs : now - lastAt;

  if (elapsed >= intervalMs) {
    void saveSessionSnapshot(cascadeId, session, events);
    return;
  }

  const existing = pendingSnapshots.get(cascadeId);
  if (existing) {
    existing.session = session;
    existing.events = events;
    return;
  }

  const delay = Math.max(0, intervalMs - elapsed);
  const entry: PendingSnapshotEntry = {
    cascadeId,
    session,
    events,
    timer: null
  };
  entry.timer = setTimeout(() => {
    const current = pendingSnapshots.get(cascadeId);
    if (!current) return;
    pendingSnapshots.delete(cascadeId);
    void saveSessionSnapshot(cascadeId, current.session, current.events);
  }, delay);
  pendingSnapshots.set(cascadeId, entry);
}

export async function flushSnapshotSave(cascadeId?: string): Promise<void> {
  if (cascadeId !== undefined) {
    const pending = pendingSnapshots.get(cascadeId);
    if (!pending) return;
    await saveSessionSnapshot(pending.cascadeId, pending.session, pending.events);
    return;
  }
  const entries = Array.from(pendingSnapshots.values());
  if (entries.length === 0) return;
  await Promise.all(
    entries.map((entry) => saveSessionSnapshot(entry.cascadeId, entry.session, entry.events))
  );
}

export async function loadSessionSnapshot(
  cascadeId: string
): Promise<CachedSessionSnapshot | null> {
  if (!cascadeId) return null;
  return idbGet<CachedSessionSnapshot>('snapshots', cascadeId);
}

export async function saveDraft(sessionId: string, text: string): Promise<void> {
  const key = normalizeDraftKey(sessionId);
  clearPendingDraft(key);
  await idbSet('drafts', key, text);
}

export function scheduleDraftSave(
  sessionId: string,
  text: string,
  delayMs = DEFAULT_DRAFT_DEBOUNCE_MS
): void {
  const key = normalizeDraftKey(sessionId);
  clearPendingDraft(key);
  if (delayMs <= 0) {
    void saveDraft(key, text);
    return;
  }
  const timer = setTimeout(() => {
    pendingDrafts.delete(key);
    void saveDraft(key, text);
  }, delayMs);
  pendingDrafts.set(key, { key, text, timer });
}

export async function flushDraftSave(sessionId?: string): Promise<void> {
  if (sessionId !== undefined) {
    const key = normalizeDraftKey(sessionId);
    const pending = pendingDrafts.get(key);
    if (!pending) return;
    await saveDraft(pending.key, pending.text);
    return;
  }
  const entries = Array.from(pendingDrafts.values());
  if (entries.length === 0) return;
  await Promise.all(entries.map((entry) => saveDraft(entry.key, entry.text)));
}

export async function loadDraft(sessionId: string): Promise<string> {
  return (await idbGet<string>('drafts', normalizeDraftKey(sessionId))) || '';
}

export async function saveQueue(items: QueuedMessage[]): Promise<void> {
  await idbSet('queue', 'pending_messages', items);
}

export async function loadQueue(): Promise<QueuedMessage[]> {
  return (await idbGet<QueuedMessage[]>('queue', 'pending_messages')) || [];
}

export function __resetIdbForTests(): void {
  dbOpenGen++;
  for (const entry of pendingDrafts.values()) {
    clearTimeout(entry.timer);
  }
  pendingDrafts.clear();
  for (const entry of pendingSnapshots.values()) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }
  }
  pendingSnapshots.clear();
  lastSnapshotSaveAt.clear();

  if (activeDb) {
    activeDb.onversionchange = null;
    activeDb.onclose = null;
    activeDb.close?.();
    activeDb = null;
  }
  dbPromise = null;
  memStore.clear();
}
