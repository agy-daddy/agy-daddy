import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import { api, getLastL2ConfirmToken } from '../store/api';
import type { PermissionLevel, PtySessionInfo } from '../types';
import styles from './lazy.module.css';

interface PtyTerminalProps {
  rootPath: string;
  worktreeId?: string | null;
  worktreeBranch?: string | null;
  sessionId: string;
  permissionLevel: PermissionLevel;
  token: string;
  onShowToast?: (msg: string) => void;
}

interface PtyTab {
  id: string;
  title: string;
  hibernated: boolean;
  lastActiveAt: number;
}

const VIRTUAL_KEYS: Array<{ label: string; data: string }> = [
  { label: 'Esc', data: '\x1b' },
  { label: 'Tab', data: '\t' },
  { label: 'Ctrl+C', data: '\x03' },
  { label: 'Ctrl+D', data: '\x04' },
  { label: '↑', data: '\x1b[A' },
  { label: '↓', data: '\x1b[B' },
  { label: '/', data: '/' },
  { label: '-', data: '-' }
];

const HIBERNATE_IDLE_MS = 60_000;

function normalizeComparableCwd(raw: string | null | undefined): string {
  return String(raw || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
}

export function deriveClientWorktreeKey(rootPath: string): string {
  const norm = normalizeComparableCwd(rootPath);
  if (!norm) return 'wt_default';
  let hash = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    hash ^= norm.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `wt_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function makeDefaultSlotId(nsKey: string, seq = 1): string {
  return `pty-${nsKey}-${seq}`;
}

export default function PtyTerminal({
  rootPath,
  worktreeId,
  worktreeBranch,
  permissionLevel,
  token,
  onShowToast
}: PtyTerminalProps) {
  const { t } = useI18n();
  const normRoot = useMemo(() => normalizeComparableCwd(rootPath), [rootPath]);
  const nsKey = useMemo(
    () => (worktreeId && worktreeId.trim() ? worktreeId.trim() : deriveClientWorktreeKey(normRoot)),
    [worktreeId, normRoot]
  );

  const [tabsByNs, setTabsByNs] = useState<Record<string, PtyTab[]>>({});
  const [activeTabByNs, setActiveTabByNs] = useState<Record<string, string>>({});
  const [connState, setConnState] = useState<'connecting' | 'open' | 'closed'>('closed');

  const hostRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<{ write: (data: string) => void; dispose: () => void } | null>(null);

  const isL2 = permissionLevel === 'L2';

  const tabs = useMemo(() => {
    const existing = tabsByNs[nsKey];
    if (existing && existing.length > 0) return existing;
    return [
      {
        id: makeDefaultSlotId(nsKey, 1),
        title: t('pty.tabTitle', { n: 1 }),
        hibernated: false,
        lastActiveAt: Date.now()
      }
    ];
  }, [tabsByNs, nsKey, t]);

  const activeTabId = useMemo(() => {
    const cur = activeTabByNs[nsKey];
    if (cur && tabs.some((tab) => tab.id === cur)) return cur;
    return tabs[0]?.id || makeDefaultSlotId(nsKey, 1);
  }, [activeTabByNs, nsKey, tabs]);

  // Fetch existing remote PTY sessions strictly scoped to current rootPath / worktree
  useEffect(() => {
    if (!isL2 || !normRoot) return;
    let canceled = false;
    api
      .listPtySessions(normRoot)
      .then((res) => {
        if (canceled) return;
        const list = Array.isArray(res.sessions) ? res.sessions : [];
        const matched = list.filter((s: PtySessionInfo) => {
          if (worktreeId && s.worktreeId) {
            return s.worktreeId === worktreeId;
          }
          const sCwd = normalizeComparableCwd(s.realCwd || s.cwd);
          return Boolean(sCwd && sCwd === normRoot);
        });
        if (matched.length > 0) {
          const nextTabs: PtyTab[] = matched.map((s, idx) => ({
            id: s.sessionId || s.id,
            title: t('pty.tabTitle', { n: idx + 1 }),
            hibernated: false,
            lastActiveAt: Date.now()
          }));
          setTabsByNs((prev) => ({ ...prev, [nsKey]: nextTabs }));
          setActiveTabByNs((prev) => ({ ...prev, [nsKey]: nextTabs[0].id }));
        } else {
          const defaultId = makeDefaultSlotId(nsKey, 1);
          setTabsByNs((prev) =>
            prev[nsKey]?.length
              ? prev
              : {
                  ...prev,
                  [nsKey]: [
                    {
                      id: defaultId,
                      title: t('pty.tabTitle', { n: 1 }),
                      hibernated: false,
                      lastActiveAt: Date.now()
                    }
                  ]
                }
          );
          setActiveTabByNs((prev) => (prev[nsKey] ? prev : { ...prev, [nsKey]: defaultId }));
        }
      })
      .catch(() => {});
    return () => {
      canceled = true;
    };
  }, [isL2, normRoot, nsKey, worktreeId]);

  // Idle tab hibernation timer
  useEffect(() => {
    if (!isL2) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setTabsByNs((prev) => {
        const list = prev[nsKey];
        if (!list) return prev;
        let changed = false;
        const nextList = list.map((tab) => {
          if (tab.id !== activeTabId && !tab.hibernated && now - tab.lastActiveAt > HIBERNATE_IDLE_MS) {
            changed = true;
            return { ...tab, hibernated: true };
          }
          return tab;
        });
        return changed ? { ...prev, [nsKey]: nextList } : prev;
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [isL2, activeTabId, nsKey]);

  useEffect(() => {
    if (!isL2 || !normRoot || !activeTabId || !hostRef.current) return;
    let disposed = false;
    let ro: ResizeObserver | null = null;

    const mountTerm = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
        import('@xterm/xterm/css/xterm.css')
      ]);
      if (disposed || !hostRef.current) return;

      hostRef.current.innerHTML = '';
      const computedStyle = getComputedStyle(document.documentElement);
      const termBg = computedStyle.getPropertyValue('--ag-terminal-bg').trim() || undefined;
      const termFg = computedStyle.getPropertyValue('--ag-terminal-fg').trim() || undefined;
      const term = new Terminal({
        fontSize: 12,
        cursorBlink: true,
        theme: {
          background: termBg,
          foreground: termFg
        }
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();
      termRef.current = term;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({
        t: token,
        cols: String(term.cols || 80),
        rows: String(term.rows || 24),
        cwd: normRoot,
        sessionId: activeTabId
      });
      const confirmTok = getLastL2ConfirmToken();
      if (confirmTok) params.set('confirm', confirmTok);

      setConnState('connecting');
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/pty?${params.toString()}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        setConnState('open');
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          term.write(ev.data);
        } else if (ev.data instanceof Blob) {
          ev.data.text().then((txt) => term.write(txt)).catch(() => {});
        }
      };

      ws.onclose = (ev) => {
        if (disposed) return;
        setConnState('closed');
        if (ev?.reason && ev.reason.includes('PTY_CWD_MISMATCH')) {
          const freshId = `pty-${nsKey}-${Date.now().toString(36)}`;
          onShowToast?.(t('pty.cwdMismatchRetry'));
          setTabsByNs((prev) => ({
            ...prev,
            [nsKey]: (prev[nsKey] || tabs).map((tab) =>
              tab.id === activeTabId ? { ...tab, id: freshId, lastActiveAt: Date.now() } : tab
            )
          }));
          setActiveTabByNs((prev) => ({ ...prev, [nsKey]: freshId }));
        }
      };
      ws.onerror = () => {
        if (!disposed) onShowToast?.(t('pty.wsError'));
      };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      const handleResize = () => {
        try {
          fit.fit();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
          }
        } catch {}
      };
      if (typeof ResizeObserver !== 'undefined' && hostRef.current) {
        ro = new ResizeObserver(handleResize);
        ro.observe(hostRef.current);
      }
    };

    mountTerm();

    return () => {
      disposed = true;
      ro?.disconnect();
      wsRef.current?.close();
      wsRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
    };
  }, [isL2, activeTabId, normRoot, nsKey, token]);

  if (!normRoot) {
    return <div className="ag-empty">{t('lazy.noWorkspace')}</div>;
  }

  if (!isL2) {
    return (
      <div className="ag-empty" data-testid="pty-l2-locked">
        {t('pty.l2Locked')}
      </div>
    );
  }

  const sendVirtualKey = (data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  };

  const addTab = () => {
    const current = tabsByNs[nsKey] || tabs;
    const nextIdx = current.length + 1;
    const id = `pty-${nsKey}-${Date.now().toString(36)}`;
    setTabsByNs((prev) => ({
      ...prev,
      [nsKey]: [
        ...(prev[nsKey] || tabs),
        { id, title: t('pty.tabTitle', { n: nextIdx }), hibernated: false, lastActiveAt: Date.now() }
      ]
    }));
    setActiveTabByNs((prev) => ({ ...prev, [nsKey]: id }));
  };

  const selectTab = (id: string) => {
    setTabsByNs((prev) => ({
      ...prev,
      [nsKey]: (prev[nsKey] || tabs).map((tab) =>
        tab.id === id ? { ...tab, hibernated: false, lastActiveAt: Date.now() } : tab
      )
    }));
    setActiveTabByNs((prev) => ({ ...prev, [nsKey]: id }));
  };

  const sandboxDisplay = worktreeBranch ? `${worktreeBranch} · ${normRoot}` : normRoot;

  return (
    <div className={styles.pane} data-testid="pty-terminal">
      <div className={styles.ptySandboxBar} data-testid="pty-sandbox-capsule" title={normRoot}>
        <span className={styles.ptySandboxText}>
          {t('pty.sandboxLabel', { label: sandboxDisplay })}
        </span>
        <span className="ag-chip" style={{ flexShrink: 0 }}>
          {connState === 'open'
            ? t('pty.connected')
            : connState === 'connecting'
              ? t('pty.connecting')
              : t('pty.disconnected')}
        </span>
      </div>

      <div className={styles.termTabs} data-hscroll="1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            style={{ minHeight: 44 }}
            className={`ag-pill-btn ${tab.id === activeTabId ? 'ag-pill-btn-primary' : ''}`}
            onClick={() => selectTab(tab.id)}
          >
            {tab.title}
            {tab.hibernated ? ` (${t('pty.hibernated')})` : ''}
          </button>
        ))}
        <button
          type="button"
          className="ag-pill-btn"
          style={{ minWidth: 44, minHeight: 44 }}
          onClick={addTab}
          aria-label="+"
        >
          +
        </button>
      </div>

      <div ref={hostRef} className={styles.termHost} data-hscroll="1" />

      <div className={styles.vkeyBar} data-hscroll="1" data-testid="pty-virtual-keys">
        {VIRTUAL_KEYS.map((k) => (
          <button
            key={k.label}
            type="button"
            className={styles.vkey}
            onClick={() => sendVirtualKey(k.data)}
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
