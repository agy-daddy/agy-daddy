import { useEffect, useId, useRef } from 'react';
import type { WriteConfirmChallenge } from '../api/client';
import { useI18n } from '../i18n';
import styles from './WriteConfirmModal.module.css';

export interface WriteConfirmModalProps {
  challenge: WriteConfirmChallenge | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function WriteConfirmModal({ challenge, onConfirm, onCancel }: WriteConfirmModalProps) {
  const { t } = useI18n();
  const titleId = useId();
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!challenge) return undefined;
    confirmBtnRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [challenge, onCancel]);

  if (!challenge) return null;

  return (
    <div
      className={styles.backdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="cloudflare-confirm-modal"
      >
        <div className={styles.header}>
          <h3 id={titleId} className={styles.title}>
            {t('webAccess.confirm.title')}
          </h3>
          <span className={styles.badge}>{t('webAccess.confirm.channelBadge')}</span>
        </div>

        <p className={styles.description}>{t('webAccess.confirm.description')}</p>

        <div className={styles.actionBox}>
          <span className={styles.actionLabel}>{t('webAccess.confirm.actionLabel')}</span>
          <code className={styles.actionCode} data-testid="cloudflare-confirm-action">
            {challenge.action}
          </code>
        </div>

        <div className={styles.footer}>
          <button
            type="button"
            className={styles.cancelBtn}
            onClick={onCancel}
            data-testid="cloudflare-confirm-cancel"
          >
            {t('webAccess.confirm.cancelBtn')}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={styles.confirmBtn}
            onClick={onConfirm}
            data-testid="cloudflare-confirm-submit"
          >
            {t('webAccess.confirm.confirmBtn')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default WriteConfirmModal;
