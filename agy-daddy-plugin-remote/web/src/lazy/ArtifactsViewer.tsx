import { useEffect, useState } from 'preact/hooks';
import { Markdown } from '../chat/Markdown';
import { api } from '../store/api';
import type { ArtifactItem } from '../types';
import styles from './lazy.module.css';

interface ArtifactsViewerProps {
  sessionId: string;
  onShowToast?: (msg: string) => void;
}

export default function ArtifactsViewer({ sessionId, onShowToast }: ArtifactsViewerProps) {
  const [items, setItems] = useState<ArtifactItem[]>([]);
  const [selected, setSelected] = useState<{
    name: string;
    mime: string;
    content?: string;
    dataUrl?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const loadList = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      const res = await api.listArtifacts(sessionId);
      setItems(Array.isArray(res.items) ? res.items : []);
    } catch (err) {
      onShowToast?.(`加载产物列表失败: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const openItem = async (item: ArtifactItem) => {
    setBusy(true);
    try {
      const res = await api.readArtifact(sessionId, item.name);
      setSelected({
        name: res.name || item.name,
        mime: res.mime || item.mime,
        content: res.content,
        dataUrl: res.dataUrl
      });
    } catch (err) {
      onShowToast?.(`读取产物失败: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setSelected(null);
    loadList();
  }, [sessionId]);

  if (!sessionId) {
    return <div className="ag-empty">请先选择一个会话</div>;
  }

  if (selected) {
    const isImg = selected.mime.startsWith('image/');
    const isMd = selected.name.endsWith('.md') || selected.mime === 'text/markdown';
    return (
      <div className={styles.pane} data-testid="artifact-detail">
        <div className={styles.toolbar}>
          <button type="button" className="ag-pill-btn" onClick={() => setSelected(null)}>
            ← 返回
          </button>
          <span className={styles.mono} style={{ flex: 1 }}>
            {selected.name}
          </span>
        </div>
        <div className={styles.scroll}>
          {isImg ? (
            <img
              src={
                selected.dataUrl ||
                `/api/v1/artifacts/${encodeURIComponent(sessionId)}/${encodeURIComponent(selected.name)}`
              }
              alt={selected.name}
              style={{ maxWidth: '100%', borderRadius: 8 }}
            />
          ) : isMd ? (
            <Markdown text={selected.content || ''} />
          ) : (
            <pre className={styles.codeView} data-hscroll="1">
              {selected.content || ''}
            </pre>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.pane} data-testid="artifacts-viewer">
      <div className={styles.toolbar}>
        <span className={styles.mono} style={{ flex: 1 }}>
          brain/{sessionId}
        </span>
        <button type="button" className="ag-pill-btn" onClick={loadList} disabled={busy}>
          刷新
        </button>
      </div>
      <div className={styles.scroll}>
        {items.length === 0 ? (
          <div className="ag-empty">{busy ? '加载中...' : '当前会话暂无产物文件'}</div>
        ) : (
          <div className={styles.list}>
            {items.map((it) => (
              <button
                key={it.name}
                type="button"
                className={styles.itemBtn}
                onClick={() => openItem(it)}
              >
                <span className={styles.mono}>{it.name}</span>
                <span style={{ fontSize: 11, color: 'var(--ag-muted)' }}>
                  {it.size > 1024 ? `${(it.size / 1024).toFixed(1)}K` : `${it.size}B`}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
