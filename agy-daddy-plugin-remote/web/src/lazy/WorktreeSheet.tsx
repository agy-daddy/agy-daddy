import { useEffect, useRef, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import type { PermissionLevel } from '../types';
import styles from './lazy.module.css';

export interface WorktreeSheetProps {
  open: boolean;
  repoRoot: string;
  repoName: string;
  permissionLevel: PermissionLevel;
  onSubmit: (payload: {
    root: string;
    action: 'add';
    path: string;
    branch?: string;
    createBranch?: boolean;
  }) => Promise<boolean>;
  onClose: () => void;
}

function buildSuggestedSiblingPath(repoRoot: string, branch: string): string {
  const cleanRoot = repoRoot.replace(/\/+$/, '');
  if (!cleanRoot) return '';
  const idx = cleanRoot.lastIndexOf('/');
  const parent = idx > 0 ? cleanRoot.slice(0, idx) : '';
  const base = idx >= 0 ? cleanRoot.slice(idx + 1) : cleanRoot;
  const slug = branch
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = slug || 'wt';
  return parent ? `${parent}/${base}-${suffix}` : `${base}-${suffix}`;
}

export default function WorktreeSheet({
  open,
  repoRoot,
  repoName,
  permissionLevel,
  onSubmit,
  onClose
}: WorktreeSheetProps) {
  const { t } = useI18n();
  const [branch, setBranch] = useState('');
  const [wtPath, setWtPath] = useState(() => buildSuggestedSiblingPath(repoRoot, ''));
  const [pathEdited, setPathEdited] = useState(false);
  const [createBranch, setCreateBranch] = useState(true);
  const [busy, setBusy] = useState(false);

  const prevInitRef = useRef({ open, repoRoot });

  useEffect(() => {
    if (
      open &&
      (!prevInitRef.current.open || prevInitRef.current.repoRoot !== repoRoot)
    ) {
      setBranch('');
      setPathEdited(false);
      setWtPath(buildSuggestedSiblingPath(repoRoot, ''));
      setCreateBranch(true);
    }
    prevInitRef.current = { open, repoRoot };
  }, [open, repoRoot]);

  if (!open) return null;

  const isL2 = permissionLevel === 'L2';
  const canSubmit = isL2 && !busy && Boolean(wtPath.trim());

  const handleBranchInput = (nextBranch: string) => {
    setBranch(nextBranch);
    if (!pathEdited) {
      setWtPath(buildSuggestedSiblingPath(repoRoot, nextBranch));
    }
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const ok = await onSubmit({
        root: repoRoot,
        action: 'add',
        path: wtPath.trim(),
        ...(branch.trim() ? { branch: branch.trim(), createBranch } : {})
      });
      if (ok) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.wtBackdrop} role="dialog" aria-modal="true" onClick={onClose}>
      <form
        className={styles.wtDialog}
        data-testid="worktree-create-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className={styles.wtHead}>
          <strong style={{ fontSize: 15 }}>{t('wtSheet.title')}</strong>
          <button
            type="button"
            className="ag-pill-btn"
            style={{ minWidth: 44, minHeight: 44 }}
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </div>

        <div className={styles.wtField}>
          <span className={styles.wtLabel}>{t('wtSheet.repoLabel')}</span>
          <div className={styles.wtRepoBox} title={repoRoot}>
            <strong>{repoName}</strong>
            <span className={styles.mono}>{repoRoot}</span>
          </div>
        </div>

        <label className={styles.wtField}>
          <span className={styles.wtLabel}>{t('wtSheet.branchLabel')}</span>
          <input
            type="text"
            className="ag-input"
            style={{ minHeight: 44 }}
            placeholder={t('wtSheet.branchPlaceholder')}
            value={branch}
            onInput={(e) => handleBranchInput((e.target as HTMLInputElement).value)}
          />
        </label>

        <label className={styles.wtCheckRow}>
          <input
            type="checkbox"
            checked={createBranch}
            onChange={(e) => setCreateBranch((e.target as HTMLInputElement).checked)}
          />
          <span>{t('wtSheet.createBranch')}</span>
        </label>

        <label className={styles.wtField}>
          <span className={styles.wtLabel}>{t('wtSheet.pathLabel')}</span>
          <input
            type="text"
            className="ag-input"
            style={{ minHeight: 44 }}
            placeholder={t('wtSheet.pathPlaceholder')}
            value={wtPath}
            onInput={(e) => {
              setPathEdited(true);
              setWtPath((e.target as HTMLInputElement).value);
            }}
          />
        </label>

        {!isL2 && (
          <div className="ag-chip" data-tone="warn">
            {t('wtSheet.l2Hint')}
          </div>
        )}

        <div className={styles.wtActions}>
          <button
            type="button"
            className="ag-pill-btn"
            style={{ minHeight: 44 }}
            disabled={busy}
            onClick={onClose}
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="ag-pill-btn ag-pill-btn-primary"
            style={{ minHeight: 44 }}
            disabled={!canSubmit}
            data-testid="worktree-create-submit"
          >
            {busy ? t('wtSheet.creating') : t('wtSheet.submit')}
          </button>
        </div>
      </form>
    </div>
  );
}
