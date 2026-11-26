import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import { api } from '../store/api';
import type { FsTreeEntry, PermissionLevel } from '../types';
import styles from './lazy.module.css';

interface FileBrowserProps {
  rootPath: string;
  permissionLevel: PermissionLevel;
  inspectTargetFile?: string;
  onShowToast?: (msg: string) => void;
}

const KW_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|`(?:\\.|[^`\n])*`|\b(?:const|let|var|function|return|if|else|for|while|import|export|from|type|interface|async|await|class|def|try|catch|throw|new|true|false|null|undefined)\b)/g;

function highlightLine(line: string): ComponentChildren[] {
  const parts: ComponentChildren[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  KW_RE.lastIndex = 0;
  while ((m = KW_RE.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('//') || tok.startsWith('/*')) {
      parts.push(
        <span key={k++} style={{ color: 'var(--ag-muted)', fontStyle: 'italic' }}>
          {tok}
        </span>
      );
    } else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith('`')) {
      parts.push(
        <span key={k++} style={{ color: 'var(--ag-secondary)' }}>
          {tok}
        </span>
      );
    } else {
      parts.push(
        <strong key={k++} style={{ fontWeight: 600 }}>
          {tok}
        </strong>
      );
    }
    last = m.index + tok.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

export default function FileBrowser({
  rootPath,
  permissionLevel,
  inspectTargetFile,
  onShowToast
}: FileBrowserProps) {
  const { t } = useI18n();
  const [currentDir, setCurrentDir] = useState('');
  const [entries, setEntries] = useState<FsTreeEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftContent, setDraftContent] = useState('');
  const [busy, setBusy] = useState(false);

  const loadDir = async (dirPath: string) => {
    if (!rootPath) return;
    setBusy(true);
    try {
      const res = await api.getFsTree(rootPath, dirPath);
      setCurrentDir(dirPath);
      setEntries(Array.isArray(res.entries) ? res.entries : []);
    } catch (err) {
      onShowToast?.(t('files.loadDirFailed', { msg: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (relPath: string) => {
    if (!rootPath || !relPath) return;
    setBusy(true);
    try {
      const cleanRel = relPath.startsWith(rootPath)
        ? relPath.slice(rootPath.length).replace(/^\/+/, '')
        : relPath;
      const res = await api.readFsFile(rootPath, cleanRel);
      setOpenFile({ path: res.path || cleanRel, content: res.content || '' });
      setDraftContent(res.content || '');
      setEditing(false);
    } catch (err) {
      onShowToast?.(t('files.readFailed', { msg: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    loadDir('');
  }, [rootPath]);

  useEffect(() => {
    if (inspectTargetFile) {
      loadFile(inspectTargetFile);
    }
  }, [inspectTargetFile]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q));
  }, [entries, filter]);

  const saveFile = async () => {
    if (!openFile || permissionLevel !== 'L2') return;
    setBusy(true);
    try {
      await api.writeFsFile(rootPath, openFile.path, draftContent);
      setOpenFile({ path: openFile.path, content: draftContent });
      setEditing(false);
      onShowToast?.(t('files.saved'));
    } catch (err) {
      onShowToast?.(t('files.saveFailed', { msg: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  if (!rootPath) {
    return <div className="ag-empty">{t('lazy.noWorkspace')}</div>;
  }

  if (openFile) {
    const previewLines = !editing ? openFile.content.split('\n').slice(0, 1200) : [];
    return (
      <div className={styles.pane} data-testid="file-preview">
        <div className={styles.toolbar}>
          <button type="button" className="ag-pill-btn" onClick={() => setOpenFile(null)}>
            ← {t('common.back')}
          </button>
          <span className={styles.mono} style={{ flex: 1 }}>
            {openFile.path}
          </span>
          {permissionLevel === 'L2' && !editing && (
            <button
              type="button"
              className="ag-pill-btn ag-pill-btn-primary"
              onClick={() => setEditing(true)}
            >
              {t('files.edit')}
            </button>
          )}
          {editing && (
            <button
              type="button"
              className="ag-pill-btn ag-pill-btn-primary"
              disabled={busy}
              onClick={saveFile}
            >
              {busy ? t('files.saving') : t('files.save')}
            </button>
          )}
        </div>
        <div className={styles.scroll} style={{ display: 'flex', flexDirection: 'column' }}>
          {editing ? (
            <textarea
              className={styles.editor}
              value={draftContent}
              onInput={(e) => setDraftContent((e.target as HTMLTextAreaElement).value)}
            />
          ) : (
            <pre className={styles.codeView} data-hscroll="1">
              {previewLines.map((ln, idx) => (
                <div key={idx}>
                  <span className={styles.lineNo} style={{ display: 'inline-block' }}>
                    {idx + 1}
                  </span>{' '}
                  {highlightLine(ln)}
                </div>
              ))}
            </pre>
          )}
        </div>
      </div>
    );
  }

  const parentDir = currentDir.includes('/')
    ? currentDir.slice(0, currentDir.lastIndexOf('/'))
    : '';

  return (
    <div className={styles.pane} data-testid="file-browser">
      <div className={styles.toolbar}>
        {currentDir && (
          <button type="button" className="ag-pill-btn" onClick={() => loadDir(parentDir)}>
            {t('files.upDir')}
          </button>
        )}
        <input
          type="text"
          className="ag-input"
          placeholder={t('files.filterPlaceholder')}
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
        <button type="button" className="ag-pill-btn" onClick={() => loadDir(currentDir)}>
          {t('common.refresh')}
        </button>
      </div>
      <div className={styles.scroll}>
        {filtered.length === 0 ? (
          <div className="ag-empty">{busy ? t('files.loading') : t('files.emptyDir')}</div>
        ) : (
          <div className={styles.list}>
            {filtered.map((item) => (
              <button
                key={item.path}
                type="button"
                className={styles.itemBtn}
                onClick={() =>
                  item.type === 'dir' ? loadDir(item.path) : loadFile(item.path)
                }
              >
                <span className={styles.mono}>
                  {item.type === 'dir' ? '📁 ' : '📄 '}
                  {item.name}
                </span>
                {item.type === 'file' && item.size != null && (
                  <span style={{ fontSize: 11, color: 'var(--ag-muted)' }}>
                    {item.size > 1024 ? `${(item.size / 1024).toFixed(1)}K` : `${item.size}B`}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
