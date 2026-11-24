import type { QueuedMessage, SessionDetail, SessionEvent, SessionSummary } from '../types';

const DB_NAME = 'agy_remote_v2';
const DB_VERSION = 1;
const MAX_CACHED_SESSIONS = 10;
const MAX_CACHED_STEPS = 30;

export interface CachedSessionSnapshot {
  cascadeId: string;
  session: SessionDetail | null;
  events: SessionEvent[];
  savedAt: number;
}

const memStore = new Map<string, unknown>();

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
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
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
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
    } catch {
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
    } catch {
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
  const snap: CachedSessionSnapshot = {
    cascadeId,
    session,
    events: events.slice(0, MAX_CACHED_STEPS),
    savedAt: Date.now()
  };
  await idbSet('snapshots', cascadeId, snap);
}

export async function loadSessionSnapshot(
  cascadeId: string
): Promise<CachedSessionSnapshot | null> {
  if (!cascadeId) return null;
  return idbGet<CachedSessionSnapshot>('snapshots', cascadeId);
}

export async function saveDraft(sessionId: string, text: string): Promise<void> {
  await idbSet('drafts', sessionId || '__global__', text);
}

export async function loadDraft(sessionId: string): Promise<string> {
  return (await idbGet<string>('drafts', sessionId || '__global__')) || '';
}

export async function saveQueue(items: QueuedMessage[]): Promise<void> {
  await idbSet('queue', 'pending_messages', items);
}

export async function loadQueue(): Promise<QueuedMessage[]> {
  return (await idbGet<QueuedMessage[]>('queue', 'pending_messages')) || [];
}
