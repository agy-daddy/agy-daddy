import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { ApiError, apiClient } from '../api/client';
import {
  isSameOrInsideClientPath,
  matchWorktreeByLongestPrefix,
  toClientCompareKey,
} from '../harness/worktreeUtils';
import { useI18n } from '../i18n';
import type { TerminalSessionDto, WorktreeDto } from '../types';
import { AnsiTerminalBuffer, type TerminalSnapshot } from './ansiTerminalBuffer';
import styles from './TerminalPanel.module.css';

const WRITE_LEASE_TTL_MS = 5 * 60 * 1000;
const INPUT_BATCH_MS = 16;
const RESIZE_DEBOUNCE_MS = 120;
const EMPTY_WORKTREES: WorktreeDto[] = [];

export interface TerminalPanelProps {
  activeRoot?: string;
  activeBranchLabel?: string | null;
  worktrees?: WorktreeDto[];
  channel?: string;
  permissionLevel?: string;
  refreshKey?: number | string;
}

function doesTerminalBelongToRoot(
  session: TerminalSessionDto,
  activeRoot: string | undefined,
  worktrees: WorktreeDto[],
): boolean {
  if (!activeRoot) return true;
  if (!session.cwd) return false;
  if (worktrees.length > 0) {
    const targetWt = matchWorktreeByLongestPrefix(activeRoot, worktrees);
    const sessionWt = matchWorktreeByLongestPrefix(session.cwd, worktrees);
    if (targetWt) {
      return Boolean(
        sessionWt && toClientCompareKey(sessionWt.path) === toClientCompareKey(targetWt.path),
      );
    }
  }
  return isSameOrInsideClientPath(session.cwd, activeRoot);
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
  activeBranchLabel,
  worktrees = EMPTY_WORKTREES,
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
  const [reconnectNonce, setReconnectNonce] = useState(0);
  const [snapshot, setSnapshot] = useState<TerminalSnapshot>(() => new AnsiTerminalBuffer(80, 24).getSnapshot());

  const screenRef = useRef<HTMLDivElement | null>(null);
  const buffersRef = useRef<Map<string, AnsiTerminalBuffer>>(new Map());
  const seqMapRef = useRef<Map<string, number>>(new Map());
  const pendingInputRef = useRef<string>('');
  const inputFlushTimerRef = useRef<number | null>(null);
  const writeLeaseRef = useRef<{ token: string; expiresAt: number } | null>(null);
  const activeTermIdRef = useRef<string | null>(activeTermId);

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

  const scopedSessions = useMemo(
    () => sessions.filter((s) => doesTerminalBelongToRoot(s, activeRoot, worktrees)),
    [sessions, activeRoot, worktrees],
  );

  const effectiveActiveTermId = useMemo(
    () =>
      activeTermId && scopedSessions.some((s) => s.sessionId === activeTermId)
        ? activeTermId
        : null,
    [activeTermId, scopedSessions],
  );
  activeTermIdRef.current = effectiveActiveTermId;

  const loadSessions = useCallback(async () => {
    if (!isPermitted) return;
    try {
      const res = await apiClient.listTerminalSessions(
        activeRoot ? { cwd: activeRoot } : undefined,
      );
      if (res.runtimeAvailable === false) {
        setUnavailableReason(res.unavailableReason || 'PTY_RUNTIME_UNAVAILABLE');
      } else {
        setUnavailableReason(null);
      }
      const list = (res.sessions || []).filter((s) =>
        doesTerminalBelongToRoot(s, activeRoot, worktrees),
      );
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
  }, [isPermitted, activeRoot, worktrees]);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions, refreshKey]);

  const activeSession = useMemo(
    () => scopedSessions.find((s) => s.sessionId === effectiveActiveTermId) || null,
    [scopedSessions, effectiveActiveTermId],
  );

  // Subscribe to SSE output for active terminal
  useEffect(() => {
    if (!isPermitted || !effectiveActiveTermId) {
      setStreamStatus('idle');
      return;
    }

    const buf = getOrCreateBuffer(
      effectiveActiveTermId,
      activeSession?.cols || 80,
      activeSession?.rows || 24,
    );
    setSnapshot(buf.getSnapshot());
    setStreamStatus('connecting');

    const afterSeq = seqMapRef.current.get(effectiveActiveTermId) ?? 0;
    const unsubscribe = apiClient.subscribeTerminalStream(effectiveActiveTermId, {
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
          seqMapRef.current.set(effectiveActiveTermId, evt.seq + 1);
        }
        buf.write(evt.chunk || '');
        if (activeTermIdRef.current === effectiveActiveTermId) {
          setSnapshot(buf.getSnapshot());
        }
      },
      onExit: (evt) => {
        setSessions((prev) =>
          prev.map((s) =>
            s.sessionId === effectiveActiveTermId
              ? { ...s, alive: false, exitCode: evt.exitCode, signal: evt.signal }
              : s,
          ),
        );
      },
    });

    return () => {
      unsubscribe();
    };
  }, [effectiveActiveTermId, isPermitted, getOrCreateBuffer, activeSession?.cols, activeSession?.rows, reconnectNonce]);

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
        if (!effectiveActiveTermId) return;
        const validLease =
          writeLeaseRef.current && writeLeaseRef.current.expiresAt > Date.now()
            ? writeLeaseRef.current.token
            : undefined;
        void apiClient
          .resizeTerminalSession(effectiveActiveTermId, cols, rows, {
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
  }, [effectiveActiveTermId, isPermitted]);

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
      if (err instanceof ApiError && (err.status === 409 || err.code === 'PTY_CWD_MISMATCH')) {
        setActiveTermId(null);
        void loadSessions();
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [isPermitted, loadSessions]);

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

  const applyCreatedSession = (res: Awaited<ReturnType<typeof apiClient.createTerminalSession>>) => {
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
  };

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
      applyCreatedSession(res);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.code === 'PTY_CWD_MISMATCH')) {
        // Detach stale session ID and isolate into a fresh PTY for the active worktree
        setActiveTermId(null);
        try {
          const retryRes = await apiClient.createTerminalSession({
            cwd: activeRoot || undefined,
            cols: 80,
            rows: 24,
          });
          applyCreatedSession(retryRes);
          return;
        } catch (retryErr) {
          setErrorMsg(retryErr instanceof Error ? retryErr.message : String(retryErr));
          return;
        }
      }
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
    if (!effectiveActiveTermId || !isPermitted) return;
    const closingId = effectiveActiveTermId;
    try {
      await apiClient.closeTerminalSession(closingId);
      buffersRef.current.delete(closingId);
      seqMapRef.current.delete(closingId);
      setSessions((prev) => {
        const next = prev.filter((s) => s.sessionId !== closingId);
        const nextScoped = next.filter((s) => doesTerminalBelongToRoot(s, activeRoot, worktrees));
        setActiveTermId(nextScoped[0]?.sessionId ?? null);
        return next;
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleScreenKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    if (!effectiveActiveTermId || !isPermitted) return;
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

  const branchDisplay =
    activeBranchLabel ||
    (activeRoot ? activeRoot.split('/').filter(Boolean).pop() || activeRoot : '');

  return (
    <div className={styles.root} data-testid="terminal-panel">
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <select
            className={styles.sessionSelect}
            value={effectiveActiveTermId ?? ''}
            onChange={(e) => setActiveTermId(e.target.value || null)}
            disabled={scopedSessions.length === 0}
            aria-label={t('terminal.sessionSelect')}
            data-testid="terminal-session-select"
          >
            {scopedSessions.length === 0 ? (
              <option value="">{t('terminal.emptyTitle')}</option>
            ) : (
              scopedSessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>
                  {(s.shell || 'sh').split('/').pop() || 'sh'} · {s.sessionId.slice(0, 6)}
                </option>
              ))
            )}
          </select>

          {activeRoot && (
            <span
              className={styles.sandboxCapsule}
              title={activeRoot}
              data-testid="terminal-sandbox-capsule"
            >
              {t('terminal.sandboxLabel')}: {branchDisplay}
            </span>
          )}

          {effectiveActiveTermId && (
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

          {effectiveActiveTermId && streamStatus === 'disconnected' && (
            <button
              type="button"
              className={styles.btn}
              onClick={() => {
                setErrorMsg(null);
                setReconnectNonce((n) => n + 1);
              }}
              data-testid="terminal-reconnect-btn"
            >
              {t('terminal.reconnect')}
            </button>
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
          {effectiveActiveTermId && (
            <>
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  buffersRef.current.get(effectiveActiveTermId)?.clear();
                  syncSnapshot(effectiveActiveTermId);
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

      {!effectiveActiveTermId ? (
        <div className={styles.emptyCard} data-testid="terminal-empty-card">
          <h4 className={styles.cardTitle}>
            {activeRoot
              ? t('terminal.emptyWorktreeTitle', { branch: branchDisplay })
              : t('terminal.emptyTitle')}
          </h4>
          <p className={styles.cardDesc}>
            {activeRoot
              ? t('terminal.emptyWorktreeDesc', { path: activeRoot })
              : t('terminal.emptyDesc')}
          </p>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={creating}
            onClick={() => void handleCreateSession()}
            data-testid="terminal-empty-launch-btn"
          >
            {activeRoot
              ? t('terminal.emptyWorktreeTitle', { branch: branchDisplay })
              : t('terminal.newSession')}
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
