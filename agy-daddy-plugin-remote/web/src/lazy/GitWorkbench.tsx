import { useEffect, useState } from 'preact/hooks';
import { api } from '../store/api';
import type { GitDiffFile, GitWorktreeInfo, PermissionLevel } from '../types';
import styles from './lazy.module.css';

interface GitWorkbenchProps {
  rootPath: string;
  permissionLevel: PermissionLevel;
  onShowToast?: (msg: string) => void;
  onRefreshDiffBadge?: () => void;
}

export default function GitWorkbench({
  rootPath,
  permissionLevel,
  onShowToast,
  onRefreshDiffBadge
}: GitWorkbenchProps) {
  const [branch, setBranch] = useState('');
  const [files, setFiles] = useState<GitDiffFile[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktreeInfo[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [wtPath, setWtPath] = useState('');
  const [wtBranch, setWtBranch] = useState('');
  const [busy, setBusy] = useState(false);

  const isL2 = permissionLevel === 'L2';

  const refresh = async () => {
    if (!rootPath) return;
    setBusy(true);
    try {
      const [diffRes, wtRes] = await Promise.all([
        api.getGitDiff(rootPath),
        api.getGitWorktrees(rootPath).catch(() => ({ ok: true, worktrees: [] }))
      ]);
      setBranch(diffRes.branch || '');
      setFiles(Array.isArray(diffRes.files) ? diffRes.files : []);
      setWorktrees(Array.isArray(wtRes.worktrees) ? wtRes.worktrees : []);
      onRefreshDiffBadge?.();
    } catch (err) {
      onShowToast?.(`Git 状态获取失败: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    refresh();
  }, [rootPath]);

  const toggleStage = async (file: GitDiffFile) => {
    if (!isL2) return;
    setBusy(true);
    try {
      await api.gitStage(rootPath, [file.path], Boolean(file.staged));
      await refresh();
    } catch (err) {
      onShowToast?.(`暂存失败: ${(err as Error).message}`);
      setBusy(false);
    }
  };

  const handleCommit = async () => {
    if (!isL2 || !commitMsg.trim()) return;
    setBusy(true);
    try {
      await api.gitCommit(rootPath, commitMsg.trim());
      setCommitMsg('');
      onShowToast?.('已提交 Commit');
      await refresh();
    } catch (err) {
      onShowToast?.(`提交失败: ${(err as Error).message}`);
      setBusy(false);
    }
  };

  const handlePush = async () => {
    if (!isL2) return;
    setBusy(true);
    try {
      await api.gitPush(rootPath, undefined, branch || undefined);
      onShowToast?.('Push 成功');
    } catch (err) {
      onShowToast?.(`Push 失败: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateWorktree = async () => {
    if (!isL2 || !wtPath.trim()) return;
    setBusy(true);
    try {
      await api.gitWorktree({
        root: rootPath,
        action: 'create',
        path: wtPath.trim(),
        branch: wtBranch.trim() || undefined,
        createBranch: Boolean(wtBranch.trim())
      });
      setWtPath('');
      setWtBranch('');
      onShowToast?.('Worktree 已创建');
      await refresh();
    } catch (err) {
      onShowToast?.(`创建 Worktree 失败: ${(err as Error).message}`);
      setBusy(false);
    }
  };

  if (!rootPath) {
    return <div className="ag-empty">当前会话未绑定工作区目录</div>;
  }

  return (
    <div className={styles.pane} data-testid="git-workbench">
      <div className={styles.toolbar}>
        <span className="ag-chip">分支: {branch || '--'}</span>
        {!isL2 && (
          <span className="ag-chip" data-tone="warn">
            {permissionLevel} 只读
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button type="button" className="ag-pill-btn" onClick={refresh} disabled={busy}>
          刷新
        </button>
        {isL2 && (
          <button
            type="button"
            className="ag-pill-btn ag-pill-btn-primary"
            disabled={busy}
            onClick={handlePush}
          >
            Push
          </button>
        )}
      </div>

      <div className={styles.scroll}>
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ag-muted)', marginBottom: 6 }}>
            Worktrees ({worktrees.length})
          </div>
          <div className={styles.list}>
            {worktrees.map((wt) => (
              <div key={wt.path} className={styles.itemBtn}>
                <span className={styles.mono}>
                  {wt.branch || wt.head || 'detached'} · {wt.path}
                </span>
                {wt.isCurrent && <span className="ag-chip">当前</span>}
              </div>
            ))}
          </div>
          {isL2 && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <input
                type="text"
                className="ag-input"
                style={{ minHeight: 30, fontSize: 12 }}
                placeholder="Worktree 路径"
                value={wtPath}
                onInput={(e) => setWtPath((e.target as HTMLInputElement).value)}
              />
              <input
                type="text"
                className="ag-input"
                style={{ minHeight: 30, fontSize: 12, maxWidth: 110 }}
                placeholder="分支名"
                value={wtBranch}
                onInput={(e) => setWtBranch((e.target as HTMLInputElement).value)}
              />
              <button
                type="button"
                className="ag-pill-btn"
                disabled={busy || !wtPath.trim()}
                onClick={handleCreateWorktree}
              >
                +新建
              </button>
            </div>
          )}
        </div>

        <div>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ag-muted)', marginBottom: 6 }}>
            工作区变更 ({files.length})
          </div>
          <div className={styles.list}>
            {files.length === 0 ? (
              <div className="ag-empty">无未提交变更</div>
            ) : (
              files.map((f) => (
                <div key={f.path} className={styles.itemBtn}>
                  <span className={styles.mono}>
                    [{f.status || 'M'}] {f.path}
                  </span>
                  {isL2 && (
                    <button
                      type="button"
                      className="ag-pill-btn"
                      disabled={busy}
                      onClick={() => toggleStage(f)}
                    >
                      {f.staged ? 'Unstage' : 'Stage'}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {isL2 && (
        <div className={styles.commentBar}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              className="ag-input"
              placeholder="输入 Commit message..."
              value={commitMsg}
              onInput={(e) => setCommitMsg((e.target as HTMLInputElement).value)}
            />
            <button
              type="button"
              className="ag-pill-btn ag-pill-btn-primary"
              disabled={busy || !commitMsg.trim()}
              onClick={handleCommit}
            >
              Commit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
