import React, { useEffect, useState } from 'react';
import type { TranslateFn } from '../i18n';
import type { ProjectGroup, ProjectItem, WorktreeDto } from '../types';
import { suggestSiblingWorktreePath } from './worktreeUtils';
import modalStyles from '../App.module.css';
import styles from './SessionSidebar.module.css';

export interface DeleteGroupConfirmModalProps {
  group: ProjectGroup;
  projectCount: number;
  t: TranslateFn;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteGroupConfirmModal({
  group,
  projectCount,
  t,
  onCancel,
  onConfirm,
}: DeleteGroupConfirmModalProps) {
  return (
    <div
      className={modalStyles.modalBackdrop}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onCancel();
      }}
    >
      <div
        className={modalStyles.confirmDialog}
        role="dialog"
        aria-modal="true"
        data-testid="delete-group-modal"
      >
        <h3 className={modalStyles.confirmTitle}>{t('sidebarOrg.deleteGroupModalTitle')}</h3>
        <p className={modalStyles.confirmDesc}>
          {t('sidebarOrg.deleteGroupModalDesc', {
            name: group.name,
            count: projectCount,
          })}
        </p>
        <div className={modalStyles.confirmFooter}>
          <button
            type="button"
            className={modalStyles.confirmCancelBtn}
            data-testid="delete-group-cancel"
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={modalStyles.confirmDangerBtn}
            data-testid="delete-group-confirm"
            onClick={onConfirm}
          >
            {t('sidebarOrg.deleteGroupModalConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface CreateWorktreeModalProps {
  project: ProjectItem;
  t: TranslateFn;
  onCancel: () => void;
  onSubmit: (payload: {
    root: string;
    path: string;
    branch: string;
    createBranch: boolean;
  }) => Promise<void>;
}

export function CreateWorktreeModal({
  project,
  t,
  onCancel,
  onSubmit,
}: CreateWorktreeModalProps) {
  const repoRoot = project.repoRootPath || project.rootPath || '';
  const [branch, setBranch] = useState('');
  const [wtPath, setWtPath] = useState('');
  const [pathEditedManually, setPathEditedManually] = useState(false);
  const [createBranch, setCreateBranch] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!pathEditedManually) {
      setWtPath(branch.trim() ? suggestSiblingWorktreePath(repoRoot, branch) : '');
    }
  }, [branch, pathEditedManually, repoRoot]);

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (submitting || !wtPath.trim()) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await onSubmit({
        root: repoRoot,
        path: wtPath.trim(),
        branch: branch.trim(),
        createBranch: Boolean(createBranch && branch.trim()),
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={modalStyles.modalBackdrop}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget && !submitting) onCancel();
      }}
    >
      <div
        className={modalStyles.confirmDialog}
        role="dialog"
        aria-modal="true"
        data-testid="create-worktree-modal"
      >
        <h3 className={modalStyles.confirmTitle}>
          {t('worktree.createModalTitle')} · {project.name}
        </h3>
        <form className={styles.worktreeModalForm} onSubmit={(e) => void handleSubmit(e)}>
          <label className={styles.worktreeModalField}>
            <span className={styles.worktreeModalLabel}>{t('worktree.createBranchLabel')}</span>
            <input
              type="text"
              className={styles.formInput}
              placeholder={t('worktree.createBranchPlaceholder')}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              disabled={submitting}
              autoFocus
              data-testid="create-worktree-branch-input"
            />
          </label>
          <label className={styles.worktreeModalField}>
            <span className={styles.worktreeModalLabel}>{t('worktree.createPathLabel')}</span>
            <input
              type="text"
              className={styles.formInput}
              placeholder={t('worktree.createPathPlaceholder')}
              value={wtPath}
              onChange={(e) => {
                setPathEditedManually(true);
                setWtPath(e.target.value);
              }}
              disabled={submitting}
              data-testid="create-worktree-path-input"
            />
          </label>
          <label className={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={createBranch}
              onChange={(e) => setCreateBranch(e.target.checked)}
              disabled={submitting || !branch.trim()}
              data-testid="create-worktree-new-branch-check"
            />
            <span>{t('worktree.createNewBranchCheck')}</span>
          </label>
          {errorMsg && (
            <div className={styles.worktreeModalError} role="alert" data-testid="create-worktree-error">
              {errorMsg}
            </div>
          )}
          <div className={modalStyles.confirmFooter}>
            <button
              type="button"
              className={modalStyles.confirmCancelBtn}
              disabled={submitting}
              data-testid="create-worktree-cancel"
              onClick={onCancel}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className={styles.formSubmitBtn}
              disabled={submitting || !wtPath.trim()}
              data-testid="create-worktree-submit"
            >
              {submitting ? t('sidebar.creating') : t('worktree.createSubmit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export interface RemoveWorktreeConfirmModalProps {
  project: ProjectItem;
  worktree: WorktreeDto;
  t: TranslateFn;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function RemoveWorktreeConfirmModal({
  worktree,
  t,
  onCancel,
  onConfirm,
}: RemoveWorktreeConfirmModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const branchText =
    worktree.branch ||
    (worktree.detached
      ? t('worktree.detachedAt', { sha: worktree.headShort || worktree.head.slice(0, 7) || 'HEAD' })
      : worktree.displayLabel);

  const handleConfirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await onConfirm();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={modalStyles.modalBackdrop}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget && !submitting) onCancel();
      }}
    >
      <div
        className={modalStyles.confirmDialog}
        role="dialog"
        aria-modal="true"
        data-testid="remove-worktree-modal"
      >
        <h3 className={modalStyles.confirmTitle}>{t('worktree.removeModalTitle')}</h3>
        <p className={modalStyles.confirmDesc}>
          {t('worktree.removeModalDesc', {
            branch: branchText,
            path: worktree.path,
          })}
        </p>
        {errorMsg && (
          <div className={styles.worktreeModalError} role="alert" data-testid="remove-worktree-error">
            {errorMsg}
          </div>
        )}
        <div className={modalStyles.confirmFooter}>
          <button
            type="button"
            className={modalStyles.confirmCancelBtn}
            disabled={submitting}
            data-testid="remove-worktree-cancel"
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={modalStyles.confirmDangerBtn}
            disabled={submitting}
            data-testid="remove-worktree-confirm"
            onClick={() => void handleConfirm()}
          >
            {t('worktree.removeModalConfirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
