import { useEffect, useRef, useState } from 'preact/hooks';
import { api, getLastL2ConfirmToken } from '../store/api';
import type { PermissionLevel, PtySessionInfo } from '../types';
import styles from './lazy.module.css';

interface PtyTerminalProps {
  rootPath: string;
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

export default function PtyTerminal({
  rootPath,
  sessionId,
  permissionLevel,
  token,
  onShowToast
}: PtyTerminalProps) {
  const [tabs, setTabs] = useState<PtyTab[]>([
    { id: 'pty-1', title: '终端 1', hibernated: false, lastActiveAt: Date.now() }
  ]);
  const [activeTabId, setActiveTabId] = useState('pty-1');
  const [connState, setConnState] = useState<'connecting' | 'open' | 'closed'>('closed');

  const hostRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<{ write: (data: string) => void; dispose: () => void } | null>(null);

  const isL2 = permissionLevel === 'L2';

  // Fetch existing remote PTY sessions on mount
  useEffect(() => {
    if (!isL2) return;
    api
      .listPtySessions()
      .then((res) => {
        const list = Array.isArray(res.sessions) ? res.sessions : [];
        if (list.length > 0) {
          setTabs(
            list.map((s: PtySessionInfo, idx: number) => ({
              id: s.id,
              title: `终端 ${idx + 1}`,
              hibernated: false,
              lastActiveAt: Date.now()
            }))
          );
          setActiveTabId(list[0].id);
        }
      })
      .catch(() => {});
  }, [isL2]);

  // Idle tab hibernation timer
  useEffect(() => {
    if (!isL2) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setTabs((prev) =>
        prev.map((t) =>
          t.id !== activeTabId && !t.hibernated && now - t.lastActiveAt > HIBERNATE_IDLE_MS
            ? { ...t, hibernated: true }
            : t
        )
      );
    }, 15_000);
    return () => clearInterval(timer);
  }, [isL2, activeTabId]);

  useEffect(() => {
    if (!isL2 || !hostRef.current) return;
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
        cwd: rootPath || '',
        sessionId: activeTabId || sessionId || 'pty-1'
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

      ws.onclose = () => {
        if (!disposed) setConnState('closed');
      };
      ws.onerror = () => {
        if (!disposed) onShowToast?.('PTY WebSocket 连接异常');
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
  }, [isL2, activeTabId, rootPath, token]);

  if (!isL2) {
    return (
      <div className="ag-empty" data-testid="pty-l2-locked">
        交互式 PTY 终端仅在 L2 权限下可用（请在宿主机桌面端设置中心开启 L2）。
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
    const nextIdx = tabs.length + 1;
    const id = `pty-${Date.now().toString(36)}`;
    setTabs((prev) => [
      ...prev,
      { id, title: `终端 ${nextIdx}`, hibernated: false, lastActiveAt: Date.now() }
    ]);
    setActiveTabId(id);
  };

  const selectTab = (id: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, hibernated: false, lastActiveAt: Date.now() } : t))
    );
    setActiveTabId(id);
  };

  return (
    <div className={styles.pane} data-testid="pty-terminal">
      <div className={styles.termTabs} data-hscroll="1">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`ag-pill-btn ${t.id === activeTabId ? 'ag-pill-btn-primary' : ''}`}
            onClick={() => selectTab(t.id)}
          >
            {t.title}
            {t.hibernated ? ' (休眠)' : ''}
          </button>
        ))}
        <button type="button" className="ag-pill-btn" onClick={addTab}>
          +
        </button>
        <span className="ag-chip" style={{ marginLeft: 'auto' }}>
          {connState === 'open' ? '已连接' : connState === 'connecting' ? '连接中' : '已断开'}
        </span>
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
