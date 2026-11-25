import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionDetail, SessionEvent } from '../types';
import {
  __resetIdbForTests,
  flushDraftSave,
  flushSnapshotSave,
  loadDraft,
  loadQueue,
  loadSessionsCache,
  loadSessionSnapshot,
  saveDraft,
  saveQueue,
  saveSessionsCache,
  saveSessionSnapshot,
  scheduleDraftSave,
  scheduleSnapshotSave
} from './idb';
import { RemoteStoreController } from './useRemoteStore';

interface PutRecord {
  storeName: string;
  key: string;
  value: unknown;
}

function createFakeIndexedDb() {
  const stores = new Map<string, Map<string, unknown>>();
  const putCalls: PutRecord[] = [];
  let openCalls = 0;
  let failNextOpen = false;
  const openDbs: Array<{
    close: ReturnType<typeof vi.fn>;
    onversionchange: ((ev: Event) => void) | null;
    onclose: ((ev: Event) => void) | null;
  }> = [];

  const fakeIndexedDb = {
    open: vi.fn((_name: string, _version?: number) => {
      openCalls++;
      const req: {
        result: unknown;
        onupgradeneeded: (() => void) | null;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
      } = {
        result: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null
      };

      queueMicrotask(() => {
        if (failNextOpen) {
          failNextOpen = false;
          req.onerror?.();
          return;
        }

        const db = {
          objectStoreNames: {
            contains: (name: string) => stores.has(name)
          },
          createObjectStore: (name: string) => {
            if (!stores.has(name)) {
              stores.set(name, new Map());
            }
          },
          onversionchange: null as ((ev: Event) => void) | null,
          onclose: null as ((ev: Event) => void) | null,
          close: vi.fn(),
          transaction: (storeName: string, _mode: string) => {
            if (!stores.has(storeName)) {
              stores.set(storeName, new Map());
            }
            const storeMap = stores.get(storeName)!;
            const tx: {
              oncomplete: (() => void) | null;
              onerror: (() => void) | null;
              onabort: (() => void) | null;
              objectStore: (name: string) => {
                get: (key: string) => { result: unknown; onsuccess: (() => void) | null; onerror: (() => void) | null };
                put: (value: unknown, key: string) => { onsuccess: (() => void) | null; onerror: (() => void) | null };
              };
            } = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore: () => ({
                get: (key: string) => {
                  const getReq = {
                    result: undefined as unknown,
                    onsuccess: null as (() => void) | null,
                    onerror: null as (() => void) | null
                  };
                  queueMicrotask(() => {
                    getReq.result = storeMap.get(key);
                    getReq.onsuccess?.();
                  });
                  return getReq;
                },
                put: (value: unknown, key: string) => {
                  const putReq = {
                    onsuccess: null as (() => void) | null,
                    onerror: null as (() => void) | null
                  };
                  storeMap.set(key, value);
                  putCalls.push({ storeName, key, value });
                  queueMicrotask(() => {
                    putReq.onsuccess?.();
                    tx.oncomplete?.();
                  });
                  return putReq;
                }
              })
            };
            return tx;
          }
        };

        req.result = db;
        openDbs.push(db);
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });

      return req;
    })
  };

  return {
    fakeIndexedDb,
    stores,
    putCalls,
    openDbs,
    getOpenCalls: () => openCalls,
    setFailNextOpen: (v: boolean) => {
      failNextOpen = v;
    }
  };
}

function makeEvent(seq: number, text = `step-${seq}`): SessionEvent {
  return {
    seq,
    kind: 'user',
    status: 'done',
    rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
    payload: { text }
  };
}

describe('idb singleton, tail snapshot slice, and write throttling/debouncing', () => {
  beforeEach(() => {
    __resetIdbForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetIdbForTests();
    vi.unstubAllGlobals();
  });

  it('keeps indexedDB.open as a single connection across reads/writes and slices the last 30 confirmed steps (seq 20..49)', async () => {
    const idbMock = createFakeIndexedDb();
    vi.stubGlobal('indexedDB', idbMock.fakeIndexedDb);

    // Concurrent reads/writes before openDb resolves should share one indexedDB.open call
    await Promise.all([
      saveSessionsCache([]),
      saveQueue([]),
      loadSessionsCache(),
      loadQueue()
    ]);

    const events: SessionEvent[] = [
      ...Array.from({ length: 50 }, (_, seq) => makeEvent(seq)),
      {
        seq: -1,
        kind: 'user',
        status: 'pending',
        rawType: 'CORTEX_STEP_TYPE_USER_INPUT',
        payload: { text: 'unconfirmed optimistic', clientTempId: 'opt_1', optimistic: true }
      }
    ];
    const detail: SessionDetail = {
      cascadeId: 's-long',
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 50
    };

    await saveSessionSnapshot('s-long', detail, events);
    const loaded = await loadSessionSnapshot('s-long');

    expect(loaded).not.toBeNull();
    expect(loaded?.events).toHaveLength(30);
    expect(loaded?.events.map((e) => e.seq)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 20)
    );
    expect(idbMock.getOpenCalls()).toBe(1);
  });

  it('recovers openDb singleton on open error, onversionchange, and onclose', async () => {
    const idbMock = createFakeIndexedDb();
    vi.stubGlobal('indexedDB', idbMock.fakeIndexedDb);

    // 1. Open error resets dbPromise so next attempt retries
    idbMock.setFailNextOpen(true);
    await saveDraft('s1', 'fallback-mem');
    expect(idbMock.getOpenCalls()).toBe(1);

    await saveDraft('s1', 'persisted-after-retry');
    expect(idbMock.getOpenCalls()).toBe(2);
    expect(await loadDraft('s1')).toBe('persisted-after-retry');

    // 2. onversionchange closes db and resets singleton
    const firstDb = idbMock.openDbs[0];
    firstDb.onversionchange?.(new Event('versionchange'));
    expect(firstDb.close).toHaveBeenCalledTimes(1);

    await saveDraft('s1', 'after-version-change');
    expect(idbMock.getOpenCalls()).toBe(3);

    // 3. onclose resets singleton
    const secondDb = idbMock.openDbs[1];
    secondDb.onclose?.(new Event('close'));
    await loadDraft('s1');
    expect(idbMock.getOpenCalls()).toBe(4);
  });

  it('debounces scheduleDraftSave and prevents stale timers from overwriting synchronous saveDraft clears', async () => {
    vi.useFakeTimers();
    const idbMock = createFakeIndexedDb();
    vi.stubGlobal('indexedDB', idbMock.fakeIndexedDb);

    scheduleDraftSave('s-draft', 'first', 300);
    await vi.advanceTimersByTimeAsync(100);
    scheduleDraftSave('s-draft', 'second', 300);
    await vi.advanceTimersByTimeAsync(200);
    // Only 200ms since 'second' -> no put yet
    expect(idbMock.putCalls.filter((p) => p.storeName === 'drafts')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(idbMock.putCalls.filter((p) => p.storeName === 'drafts')).toHaveLength(1);
    expect(await loadDraft('s-draft')).toBe('second');

    // Cancelling pending timer via immediate saveDraft('')
    scheduleDraftSave('s-draft', 'stale-text', 300);
    await saveDraft('s-draft', '');
    await vi.advanceTimersByTimeAsync(500);
    expect(await loadDraft('s-draft')).toBe('');
  });

  it('store setComposerText 50 times at 20ms intervals triggers <= 2 draft puts and flushDraftSave persists the 50th value', async () => {
    vi.useFakeTimers();
    const idbMock = createFakeIndexedDb();
    vi.stubGlobal('indexedDB', idbMock.fakeIndexedDb);

    const store = new RemoteStoreController();
    for (let i = 1; i <= 50; i++) {
      store.setComposerText(`draft-${i}`);
      await vi.advanceTimersByTimeAsync(20);
    }

    await flushDraftSave();
    const draftPuts = idbMock.putCalls.filter((p) => p.storeName === 'drafts');
    expect(draftPuts.length).toBeLessThanOrEqual(2);
    expect(await loadDraft('')).toBe('draft-50');
    store.destroy();
  });

  it('throttles 100 RUNNING handleSessionDelta frames over 10s to <= 10 snapshot writes and flushes immediately on IDLE', async () => {
    vi.useFakeTimers();
    const idbMock = createFakeIndexedDb();
    vi.stubGlobal('indexedDB', idbMock.fakeIndexedDb);

    const store = new RemoteStoreController();
    // Seed activeSessionId and activeSession without network fetch
    (store as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
      activeSessionId: 's-stream',
      activeSession: {
        cascadeId: 's-stream',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 0
      }
    });

    const handleDelta = (
      store as unknown as { handleSessionDelta: (payload: Record<string, unknown>) => void }
    ).handleSessionDelta.bind(store);

    for (let i = 0; i < 100; i++) {
      handleDelta({
        cascadeId: 's-stream',
        status: 'CASCADE_RUN_STATUS_RUNNING',
        totalSteps: i + 1,
        events: [makeEvent(i, `chunk-${i}`)]
      });
      await vi.advanceTimersByTimeAsync(100);
    }

    const streamingSnapshotPuts = idbMock.putCalls.filter((p) => p.storeName === 'snapshots');
    expect(streamingSnapshotPuts.length).toBeLessThanOrEqual(10);

    // Emit IDLE frame -> immediate flush of latest content
    handleDelta({
      cascadeId: 's-stream',
      status: 'CASCADE_RUN_STATUS_IDLE',
      totalSteps: 101,
      events: [makeEvent(100, 'final-idle-step')]
    });
    await vi.advanceTimersByTimeAsync(0);

    const snap = await loadSessionSnapshot('s-stream');
    expect(snap?.session?.status).toBe('CASCADE_RUN_STATUS_IDLE');
    expect(snap?.events.at(-1)?.seq).toBe(100);
    expect(snap?.events.at(-1)?.payload.text).toBe('final-idle-step');

    // Subsequent idle time must not fire any leftover trailing timer
    const putsAfterIdle = idbMock.putCalls.filter((p) => p.storeName === 'snapshots').length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(idbMock.putCalls.filter((p) => p.storeName === 'snapshots').length).toBe(putsAfterIdle);

    store.destroy();
  });

  it('flushes pending draft and snapshot on selectSession, visibilitychange hidden, and destroy', async () => {
    vi.useFakeTimers();
    const idbMock = createFakeIndexedDb();
    vi.stubGlobal('indexedDB', idbMock.fakeIndexedDb);

    // Also test scheduleSnapshotSave + flushSnapshotSave directly
    scheduleSnapshotSave('s-a', { cascadeId: 's-a', status: 'CASCADE_RUN_STATUS_RUNNING', numTotalSteps: 1 }, [makeEvent(0)]);
    await vi.advanceTimersByTimeAsync(100);
    scheduleSnapshotSave('s-a', { cascadeId: 's-a', status: 'CASCADE_RUN_STATUS_GENERATING', numTotalSteps: 2 }, [makeEvent(0), makeEvent(1)]);
    expect(idbMock.putCalls.filter((p) => p.storeName === 'snapshots')).toHaveLength(1);
    await flushSnapshotSave();
    expect(idbMock.putCalls.filter((p) => p.storeName === 'snapshots')).toHaveLength(2);

    const store = new RemoteStoreController();
    await store.init();
    (store as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
      activeSessionId: 's-1'
    });

    // 1. visibilitychange === 'hidden' flushes pending draft & snapshot
    store.setComposerText('unsaved before background');
    scheduleSnapshotSave(
      's-1',
      { cascadeId: 's-1', status: 'CASCADE_RUN_STATUS_RUNNING', numTotalSteps: 3 },
      [makeEvent(0), makeEvent(1), makeEvent(2)]
    );

    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      configurable: true
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);

    expect(await loadDraft('s-1')).toBe('unsaved before background');
    expect((await loadSessionSnapshot('s-1'))?.events).toHaveLength(3);

    // 2. selectSession flushes previous session's pending draft before switching
    store.setComposerText('switch draft');
    await store.selectSession('s-2');
    expect(await loadDraft('s-1')).toBe('switch draft');

    // 3. destroy() flushes remaining pending draft
    store.setComposerText('draft on destroy');
    store.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(await loadDraft('s-2')).toBe('draft on destroy');

    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      configurable: true
    });
  });
});
