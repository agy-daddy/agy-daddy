import { useEffect, useMemo, useState } from 'preact/hooks';
import { api } from '../store/api';
import type { GitDiffFile } from '../types';
import styles from './lazy.module.css';

interface DiffViewerProps {
  rootPath: string;
  inspectTargetFile?: string;
  onInjectQuote?: (snippet: string) => void;
  onRefreshDiffBadge?: () => void;
}

interface ParsedDiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk';
  lineNo: number | null;
  text: string;
}

interface ParsedDiffSection {
  file: string;
  lines: ParsedDiffLine[];
}

const DIFF_PAGE_SIZE = 300;

function parseUnifiedDiff(diffText: string): ParsedDiffSection[] {
  if (!diffText) return [];
  const lines = diffText.split('\n');
  const sections: ParsedDiffSection[] = [];
  let cur: ParsedDiffSection | null = null;
  let newLine = 0;

  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      const parts = raw.split(' ');
      const bPart = parts[3] || parts[2] || 'unknown';
      const file = bPart.startsWith('b/') ? bPart.slice(2) : bPart;
      cur = { file, lines: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      if (p && p !== '/dev/null') cur.file = p.startsWith('b/') ? p.slice(2) : p;
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('index ')) continue;

    if (raw.startsWith('@@')) {
      const m = raw.match(/\+(\d+)/);
      newLine = m ? Number(m[1]) : 1;
      cur.lines.push({ type: 'hunk', lineNo: null, text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      cur.lines.push({ type: 'add', lineNo: newLine++, text: raw });
    } else if (raw.startsWith('-')) {
      cur.lines.push({ type: 'del', lineNo: null, text: raw });
    } else {
      cur.lines.push({ type: 'ctx', lineNo: newLine++, text: raw });
    }
  }
  return sections;
}

export default function DiffViewer({
  rootPath,
  inspectTargetFile,
  onInjectQuote,
  onRefreshDiffBadge
}: DiffViewerProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [branch, setBranch] = useState('');
  const [files, setFiles] = useState<GitDiffFile[]>([]);
  const [diffText, setDiffText] = useState('');
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [lineLimits, setLineLimits] = useState<Record<string, number>>({});
  const [selectedLine, setSelectedLine] = useState<{
    file: string;
    line: number;
    code: string;
  } | null>(null);
  const [comment, setComment] = useState('');

  const loadDiff = async () => {
    if (!rootPath) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.getGitDiff(rootPath);
      const nextFiles = Array.isArray(res.files) ? res.files : [];
      const nextDiff = res.diffText || '';
      const parsed = parseUnifiedDiff(nextDiff);
      const firstFile = nextFiles[0]?.path || parsed[0]?.file || 'all';
      setBranch(res.branch || '');
      setFiles(nextFiles);
      setDiffText(nextDiff);
      setSelectedFile((prev) => {
        if (prev === 'all') return prev;
        if (prev && (nextFiles.some((f) => f.path === prev) || parsed.some((s) => s.file === prev))) {
          return prev;
        }
        return firstFile;
      });
      setExpandedFiles(firstFile && firstFile !== 'all' ? { [firstFile]: true } : {});
      setLineLimits({});
      onRefreshDiffBadge?.();
    } catch (err) {
      setError((err as Error).message || '加载 Diff 失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setSelectedFile('');
    loadDiff();
  }, [rootPath]);

  const allSections = useMemo(() => parseUnifiedDiff(diffText), [diffText]);

  useEffect(() => {
    const raw = (inspectTargetFile || '').trim();
    if (!raw) return;
    const clean = raw.replace(/^file:\/\//i, '');
    const candidates = [
      ...files.map((f) => f.path),
      ...allSections.map((s) => s.file)
    ];
    if (candidates.length === 0) return;
    const base = clean.split('/').pop() || clean;
    const match =
      candidates.find((c) => c === clean) ||
      candidates.find((c) => clean.endsWith(`/${c}`) || c.endsWith(`/${clean}`) || clean.endsWith(c)) ||
      candidates.find((c) => (c.split('/').pop() || c) === base);
    if (match) {
      setSelectedFile(match);
      setExpandedFiles({ [match]: true });
    }
  }, [inspectTargetFile, files, allSections]);

  const sectionByFile = useMemo(() => {
    const map = new Map<string, ParsedDiffSection>();
    for (const sec of allSections) map.set(sec.file, sec);
    return map;
  }, [allSections]);

  const visibleSections = useMemo(() => {
    if (!selectedFile || selectedFile === 'all') return allSections;
    return allSections.filter((s) => s.file === selectedFile);
  }, [allSections, selectedFile]);

  const selectLineByElement = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return;
    const row = target.closest('[data-diff-line="1"]');
    if (!row) return;
    const file = row.getAttribute('data-file') || '';
    const idxStr = row.getAttribute('data-idx');
    const sec = sectionByFile.get(file);
    const idx = idxStr !== null ? Number(idxStr) : -1;
    const ln = sec && idx >= 0 ? sec.lines[idx] : null;
    if (ln && ln.lineNo !== null) {
      setSelectedLine({ file, line: ln.lineNo, code: ln.text });
    }
  };

  const toggleAccordion = (file: string) => {
    setExpandedFiles((prev) => ({ ...prev, [file]: !prev[file] }));
  };

  const showMoreLines = (file: string) => {
    setLineLimits((prev) => ({
      ...prev,
      [file]: (prev[file] || DIFF_PAGE_SIZE) + DIFF_PAGE_SIZE
    }));
  };

  const submitComment = () => {
    if (!selectedLine || !onInjectQuote) return;
    const cleanCode = selectedLine.code.replace(/^[+-]/, '').trim();
    const quote = `\`${selectedLine.file}:${selectedLine.line}\`\n> \`${cleanCode}\`\n${comment.trim() || '请检查这一行'}`;
    onInjectQuote(quote);
    setSelectedLine(null);
    setComment('');
  };

  if (!rootPath) {
    return <div className="ag-empty">当前会话未绑定工作区目录</div>;
  }

  const fileOptions =
    files.length > 0 ? files.map((f) => f.path) : allSections.map((s) => s.file);

  return (
    <div className={styles.pane} data-testid="diff-viewer">
      <div className={styles.toolbar}>
        <span className="ag-chip">{branch || 'HEAD'}</span>
        <select
          className={styles.diffSelect}
          aria-label="筛选变更文件"
          value={selectedFile || 'all'}
          onChange={(e) => {
            const val = (e.target as HTMLSelectElement).value;
            setSelectedFile(val);
            if (val === 'all' && allSections[0]) {
              setExpandedFiles({ [allSections[0].file]: true });
            }
          }}
        >
          <option value="all">全部改动 ({fileOptions.length})</option>
          {fileOptions.map((fp) => (
            <option key={fp} value={fp}>
              {fp}
            </option>
          ))}
        </select>
        <button type="button" className="ag-pill-btn" onClick={loadDiff} disabled={loading}>
          {loading ? '…' : '刷新'}
        </button>
      </div>

      <div
        className={styles.scroll}
        onClick={(e) => selectLineByElement(e.target)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            const row = (e.target as Element | null)?.closest?.('[data-diff-line="1"]');
            if (row) {
              e.preventDefault();
              selectLineByElement(row);
            }
          }
        }}
      >
        {error && <div className="ag-empty">{error}</div>}
        {!error && visibleSections.length === 0 && (
          <div className="ag-empty">{loading ? '正在加载 Diff...' : '工作区暂无未提交变更'}</div>
        )}

        {visibleSections.map((sec, sIdx) => {
          const isAllMode = !selectedFile || selectedFile === 'all';
          const isExpanded = !isAllMode || Boolean(expandedFiles[sec.file] ?? sIdx === 0);
          const limit = lineLimits[sec.file] || DIFF_PAGE_SIZE;
          const visibleLines = isExpanded ? sec.lines.slice(0, limit) : [];
          const remaining = isExpanded ? Math.max(0, sec.lines.length - limit) : 0;

          return (
            <div key={sec.file} className={styles.diffBlock}>
              {isAllMode ? (
                <button
                  type="button"
                  className={styles.diffFileHead}
                  aria-expanded={isExpanded}
                  onClick={() => toggleAccordion(sec.file)}
                >
                  <span className={styles.mono}>{sec.file}</span>
                  <span style={{ fontSize: 11, color: 'var(--ag-muted)', flexShrink: 0 }}>
                    {isExpanded ? '▾' : '▸'} {sec.lines.length} 行
                  </span>
                </button>
              ) : (
                <div className={styles.diffFileHead}>
                  <span className={styles.mono}>{sec.file}</span>
                </div>
              )}

              {isExpanded &&
                visibleLines.map((ln, idx) => {
                  const cls =
                    ln.type === 'add'
                      ? styles.diffAdd
                      : ln.type === 'del'
                        ? styles.diffDel
                        : ln.type === 'hunk'
                          ? styles.diffHunk
                          : '';
                  const clickable = ln.type !== 'hunk' && ln.lineNo !== null;
                  return (
                    <div
                      key={idx}
                      role={clickable ? 'button' : undefined}
                      tabIndex={clickable ? 0 : undefined}
                      data-diff-line={clickable ? '1' : undefined}
                      data-file={clickable ? sec.file : undefined}
                      data-line={clickable ? String(ln.lineNo) : undefined}
                      data-idx={clickable ? String(idx) : undefined}
                      className={`${styles.diffLine} ${cls} ${clickable ? styles.diffLineClickable : ''}`}
                    >
                      <span className={styles.lineNo}>{ln.lineNo ?? '··'}</span>
                      <span>{ln.text}</span>
                    </div>
                  );
                })}

              {isExpanded && remaining > 0 && (
                <button
                  type="button"
                  className={styles.loadMoreBtn}
                  onClick={() => showMoreLines(sec.file)}
                >
                  加载更多（剩余 {remaining} 行）
                </button>
              )}
            </div>
          );
        })}
      </div>

      {selectedLine && (
        <div className={styles.commentBar} data-testid="inline-comment-bar">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className={styles.mono}>
              批注 {selectedLine.file}:{selectedLine.line}
            </span>
            <button type="button" className="ag-pill-btn" onClick={() => setSelectedLine(null)}>
              取消
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              className="ag-input"
              placeholder="输入行内批注内容..."
              value={comment}
              onInput={(e) => setComment((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              className="ag-pill-btn ag-pill-btn-primary"
              onClick={submitComment}
            >
              回注对话
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
