import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { ApiError, apiClient } from '../api/client';
import { useI18n } from '../i18n';
import type { TerminalSessionDto } from '../types';
import { AnsiTerminalBuffer, type TerminalSnapshot } from './ansiTerminalBuffer';
import styles from './TerminalPanel.module.css';

const WRITE_LEASE_TTL_MS = 5 * 60 * 1000;
const INPUT_BATCH_MS = 16;
const RESIZE_DEBOUNCE_MS = 120;

export interface TerminalPanelProps {
  activeRoot?: string;
  channel?: string;
  permissionLevel?: string;
  refreshKey?: number | string;
}

function keyEventToTerminalSequence(ev: KeyboardEvent<HTMLDivElement>): string | null {
  if (ev.metaKey) return null;
  if (ev.ctrlKey && !ev.altKey) {
    const ch = ev.key.toLowerCase();
    if (ch.length === 1 && ch >= 'a' && ch <= 'z') {
      return String.fromCharCode(ch.charCodeAt(0) - 96);
    }
    return null;
  }

  switch (ev.key) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\x7f';
    case 'Tab':
      return '\t';
    case 'Escape':
      return '\x1b';
    case 'ArrowUp':
      return '\x1b[A';
    case 'ArrowDown':
      return '\x1b[B';
    case 'ArrowRight':
      return '\x1b[C';
    case 'ArrowLeft':
      return '\x1b[D';
    case 'Home':
      return '\x1b[H';
    case 'End':
      return '\x1b[F';
    case 'Delete':
      return '\x1b[3~';
    default:
      if (!ev.altKey && ev.key.length === 1) {
        return ev.key;
      }
      return null;
  }
}

export function TerminalPanel({
  activeRoot,
  channel = 'loopback',
  permissionLevel = 'L2',
  refreshKey,
}: TerminalPanelProps) {
  const { t } = useI18n();
  const isPermitted = channel === 'loopback' || permissionLevel === 'L2';

  const [sessions, setSessions] = useState<TerminalSessionDto[]>([]);
  const [activeTermId, setActiveTermId] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<'idle' | 'connecting' | 'connected' | 'disconnected'>('idle');
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [quickCmd, setQuickCmd] = useState('');
  const [snapshot, setSnapshot] = useState<TerminalSnapshot>(() => new AnsiTerminalBuffer(80, 24).getSnapshot());

  const screenRef = useRef<HTMLDivElement | null>(null);
  const buffersRef = useRef<Map<string, AnsiTerminalBuffer>>(new Map());
  const seqMapRef = useRef<Map<string, number>>(new Map());
  const pendingInputRef = useRef<string>('');
  const inputFlushTimerRef = useRef<number | null>(null);
  const writeLeaseRef = useRef<{ token: string; expiresAt: number } | null>(null);
  const activeTermIdRef = useRef<string | null>(activeTermId);
  activeTermIdRef.current = activeTermId;

  const getOrCreateBuffer = useCallback((sessionId: string, cols = 80, rows = 24) => {
    let buf = buffersRef.current.get(sessionId);
    if (!buf) {
      buf = new AnsiTerminalBuffer(cols, rows);
      buffersRef.current.set(sessionId, buf);
    }
    return buf;
  }, []);

  const syncSnapshot = useCallback(
    (sessionId: string) => {
      const buf = getOrCreateBuffer(sessionId);
      setSnapshot(buf.getSnapshot());
    },
    [getOrCreateBuffer],
  );

  // Clear cached Cloudflare write lease when channel changes
  useEffect(() => {
    writeLeaseRef.current = null;
  }, [channel]);

  const loadSessions = useCallback(async () => {
    if (!isPermitted) return;
    try {
      const res = await apiClient.listTerminalSessions();
      if (res.runtimeAvailable === false) {
        setUnavailableReason(res.unavailableReason || 'PTY_RUNTIME_UNAVAILABLE');
      } else {
        setUnavailableReason(null);
      }
      const list = res.sessions || [];
      setSessions(list);
      setActiveTermId((prev) => {
        if (prev && list.some((s) => s.sessionId === prev)) return prev;
        return list.find((s) => s.alive)?.sessionId ?? list[0]?.sessionId ?? null;
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setUnavailableReason(err.message || 'PTY_RUNTIME_UNAVAILABLE');
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [isPermitted]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions, refreshKey]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === activeTermId) || null,
    [sessions, activeTermId],
  );

  // Subscribe to SSE output for active terminal
  useEffect(() => {
    if (!isPermitted || !activeTermId) {
      setStreamStatus('idle');
      return;
    }

    const buf = getOrCreateBuffer(
      activeTermId,
      activeSession?.cols || 80,
      activeSession?.rows || 24,
    );
    setSnapshot(buf.getSnapshot());
    setStreamStatus('connecting');

    const afterSeq = seqMapRef.current.get(activeTermId) ?? 0;
    const unsubscribe = apiClient.subscribeTerminalStream(activeTermId, {
      afterSeq,
      onOpen: () => {
        setStreamStatus('connected');
      },
      onError: () => {
        setStreamStatus('disconnected');
      },
      onOutput: (evt) => {
        setStreamStatus('connected');
        if (typeof evt.seq === 'number') {
          seqMapRef.current.set(activeTermId, evt.seq + 1);
        }
        buf.write(evt.chunk || '');
        if (activeTermIdRef.current === activeTermId) {
          setSnapshot(buf.getSnapshot());
        }
      },
      onExit: (evt) => {
        setSessions((prev) =>
          prev.map((s) =>
            s.sessionId === activeTermId
              ? { ...s, alive: false, exitCode: evt.exitCode, signal: evt.signal }
              : s,
          ),
        );
      },
    });

    return () => {
      unsubscribe();
    };
  }, [activeTermId, isPermitted, getOrCreateBuffer, activeSession?.cols, activeSession?.rows]);

  // Auto-scroll screen on output updates
  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [snapshot]);

  // ResizeObserver 120ms debounce
  useEffect(() => {
    const el = screenRef.current;
    if (!isPermitted || !activeTermId || !el || typeof ResizeObserver !== 'function') return;

    let timer: number | null = null;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width < 80 || rect.height < 60) return;
      const cols = Math.max(20, Math.min(240, Math.floor((rect.width - 20) / 7.2)));
      const rows = Math.max(6, Math.min(80, Math.floor((rect.height - 16) / 17)));
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const buf = buffersRef.current.get(activeTermId);
        buf?.resize(cols, rows);
        if (activeTermIdRef.current === activeTermId && buf) {
          setSnapshot(buf.getSnapshot());
        }
        const validLease =
          writeLeaseRef.current && writeLeaseRef.current.expiresAt > Date.now()
            ? writeLeaseRef.current.token
            : undefined;
        void apiClient
          .resizeTerminalSession(activeTermId, cols, rows, {
            confirmToken: validLease,
            onConfirmTokenRenewed: (newToken) => {
              writeLeaseRef.current = {
                token: newToken,
                expiresAt: Date.now() + WRITE_LEASE_TTL_MS,
              };
            },
          })
          .catch(() => {});
      }, RESIZE_DEBOUNCE_MS);
    });

    ro.observe(el);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      ro.disconnect();
    };
  }, [activeTermId, isPermitted]);

  const flushInputQueue = useCallback(async () => {
    inputFlushTimerRef.current = null;
    const sessionId = activeTermIdRef.current;
    const data = pendingInputRef.current;
    pendingInputRef.current = '';
    if (!sessionId || !data || !isPermitted) return;

    const validLease =
      writeLeaseRef.current && writeLeaseRef.current.expiresAt > Date.now()
        ? writeLeaseRef.current.token
        : undefined;

    try {
      await apiClient.sendTerminalInput(sessionId, data, {
        confirmToken: validLease,
        onConfirmTokenRenewed: (newToken) => {
          writeLeaseRef.current = {
            token: newToken,
            expiresAt: Date.now() + WRITE_LEASE_TTL_MS,
          };
        },
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [isPermitted]);

  const enqueueInput = useCallback(
    (data: string) => {
      if (!activeTermIdRef.current || !isPermitted || !data) return;
      pendingInputRef.current += data;
      if (inputFlushTimerRef.current !== null) return;
      inputFlushTimerRef.current = window.setTimeout(() => {
        void flushInputQueue();
      }, INPUT_BATCH_MS);
    },
    [flushInputQueue, isPermitted],
  );

  useEffect(
    () => () => {
      if (inputFlushTimerRef.current !== null) {
        window.clearTimeout(inputFlushTimerRef.current);
      }
    },
    [],
  );

  const handleCreateSession = async () => {
    if (!isPermitted || creating) return;
    setCreating(true);
    setErrorMsg(null);
    try {
      const res = await apiClient.createTerminalSession({
        cwd: activeRoot || undefined,
        cols: 80,
        rows: 24,
      });
      const created = res.session;
      if (res.writeConfirmToken) {
        writeLeaseRef.current = {
          token: res.writeConfirmToken,
          expiresAt: res.writeConfirmExpiresAt || Date.now() + WRITE_LEASE_TTL_MS,
        };
      }
      setUnavailableReason(null);
      setSessions((prev) => [created, ...prev.filter((s) => s.sessionId !== created.sessionId)]);
      seqMapRef.current.set(created.sessionId, 0);
      setActiveTermId(created.sessionId);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setUnavailableReason(err.message || 'PTY_RUNTIME_UNAVAILABLE');
      } else {
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setCreating(false);
    }
  };

  const handleCloseSession = async () => {
    if (!activeTermId || !isPermitted) return;
    const closingId = activeTermId;
    try {
      await apiClient.closeTerminalSession(closingId);
      buffersRef.current.delete(closingId);
      seqMapRef.current.delete(closingId);
      setSessions((prev) => {
        const next = prev.filter((s) => s.sessionId !== closingId);
        setActiveTermId(next[0]?.sessionId ?? null);
        return next;
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleScreenKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (!activeTermId || !isPermitted) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c') {
      const sel = window.getSelection?.()?.toString();
      if (sel) return;
    }
    const seq = keyEventToTerminalSequence(ev);
    if (!seq) return;
    ev.preventDefault();
    enqueueInput(seq);
  };

  if (!isPermitted) {
    return (
      <div className={styles.root} data-testid="terminal-panel">
        <div className={styles.bannerWarn} role="alert" data-testid="terminal-perm-locked">
          {t('terminal.permLocked', { tier: permissionLevel || 'L1' })}
        </div>
      </div>
    );
  }

  if (unavailableReason) {
    return (
      <div className={styles.root} data-testid="terminal-panel">
        <div className={styles.unavailableCard} data-testid="terminal-unavailable-card">
          <h4 className={styles.cardTitle}>{t('terminal.unavailableTitle')}</h4>
          <p className={styles.cardDesc}>{t('terminal.unavailableDesc', { reason: unavailableReason })}</p>
          <button
            type="button"
            className={styles.btn}
            onClick={() => void loadSessions()}
          >
            {t('common.refresh')}
          </button>
        </div>
      </div>
    );
  }

  const statusText =
    activeSession && !activeSession.alive
      ? t('terminal.statusExited', { code: activeSession.exitCode ?? 0 })
      : streamStatus === 'connected'
        ? t('terminal.statusConnected')
        : streamStatus === 'connecting'
          ? t('terminal.statusConnecting')
          : t('terminal.statusDisconnected');

  return (
    <div className={styles.root} data-testid="terminal-panel">
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <select
            className={styles.sessionSelect}
            value={activeTermId ?? ''}
            onChange={(e) => setActiveTermId(e.target.value || null)}
            disabled={sessions.length === 0}
            aria-label={t('terminal.sessionSelect')}
            data-testid="terminal-session-select"
          >
            {sessions.length === 0 ? (
              <option value="">{t('terminal.emptyTitle')}</option>
            ) : (
              sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {(s.shell || 'sh').split('/').pop() || 'sh'} · {s.sessionId.slice(0, 6)}
                </option>
              ))
            )}
          </select>

          {activeTermId && (
            <span className={styles.statusBadge} data-testid="terminal-status-badge">
              <span
                className={`${styles.statusDot} ${
                  streamStatus === 'connected'
                    ? styles.dotConnected
                    : streamStatus === 'connecting'
                      ? styles.dotConnecting
                      : styles.dotDisconnected
                }`}
              />
              <span>{statusText}</span>
            </span>
          )}
        </div>

        <div className={styles.toolbarRight}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={creating || sessions.length >= 8}
            onClick={() => void handleCreateSession()}
            data-testid="terminal-new-btn"
          >
            + {t('terminal.newSession')}
          </button>
          {activeTermId && (
            <>
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  buffersRef.current.get(activeTermId)?.clear();
                  syncSnapshot(activeTermId);
                }}
                data-testid="terminal-clear-btn"
              >
                {t('terminal.clear')}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnDanger}`}
                onClick={() => void handleCloseSession()}
                data-testid="terminal-close-btn"
              >
                {t('terminal.closeSession')}
              </button>
            </>
          )}
        </div>
      </div>

      {errorMsg && (
        <div className={styles.bannerWarn} role="alert" data-testid="terminal-error-banner">
          {errorMsg}
        </div>
      )}

      {!activeTermId ? (
        <div className={styles.emptyCard} data-testid="terminal-empty-card">
          <h4 className={styles.cardTitle}>{t('terminal.emptyTitle')}</h4>
          <p className={styles.cardDesc}>{t('terminal.emptyDesc')}</p>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={creating}
            onClick={() => void handleCreateSession()}
            data-testid="terminal-empty-launch-btn"
          >
            {t('terminal.newSession')}
          </button>
        </div>
      ) : (
        <>
          <div
            ref={screenRef}
            className={styles.screen}
            tabIndex={0}
            role="textbox"
            aria-multiline="true"
            aria-label={t('dock.tab.terminal')}
            onKeyDown={handleScreenKeyDown}
            onPaste={(ev) => {
              const pasted = ev.clipboardData?.getData('text');
              if (pasted) {
                ev.preventDefault();
                enqueueInput(pasted);
              }
            }}
            data-testid="terminal-screen"
          >
            {snapshot.lines.map((line, lineIdx) => (
              <div key={lineIdx} className={styles.line}>
                {line.spans.map((span, spanIdx) => (
                  <span
                    key={spanIdx}
                    style={
                      span.style
                        ? {
                            color: span.style.fg,
                            backgroundColor: span.style.bg,
                            fontWeight: span.style.bold ? 700 : undefined,
                            opacity: span.style.dim ? 0.65 : undefined,
                            fontStyle: span.style.italic ? 'italic' : undefined,
                            textDecoration: span.style.underline ? 'underline' : undefined,
                          }
                        : undefined
                    }
                  >
                    {span.text}
                  </span>
                ))}
                {lineIdx === snapshot.cursorRow && <span className={styles.cursorBlock} aria-hidden="true" />}
              </div>
            ))}
          </div>

          <div className={styles.quickBar}>
            <button type="button" className={styles.quickKeyBtn} onClick={() => enqueueInput('\x03')}>
              Ctrl+C
            </button>
            <button type="button" className={styles.quickKeyBtn} onClick={() => enqueueInput('\x04')}>
              Ctrl+D
            </button>
            <button type="button" className={styles.quickKeyBtn} onClick={() => enqueueInput('\t')}>
              Tab
            </button>
            <button type="button" className={styles.quickKeyBtn} onClick={() => enqueueInput('\x1b')}>
              Esc
            </button>
            <button type="button" className={styles.quickKeyBtn} onClick={() => enqueueInput('\x1b[A')}>
              ↑
            </button>
            <button type="button" className={styles.quickKeyBtn} onClick={() => enqueueInput('\x1b[B')}>
              ↓
            </button>
            <input
              type="text"
              className={styles.quickInput}
              placeholder={t('terminal.inputPlaceholder')}
              value={quickCmd}
              onChange={(e) => setQuickCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && quickCmd) {
                  e.preventDefault();
                  enqueueInput(`${quickCmd}\r`);
                  setQuickCmd('');
                }
              }}
              data-testid="terminal-quick-input"
            />
          </div>
        </>
      )}
    </div>
  );
}
