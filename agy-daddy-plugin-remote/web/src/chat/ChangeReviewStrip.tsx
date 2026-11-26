import { useMemo } from 'preact/hooks';
import { useI18n } from '../i18n';
import type { SessionEvent } from '../types';
import { collectSessionEditedFiles } from './codeActionUtils';
import styles from './ChangeReviewStrip.module.css';

export interface ChangeReviewStripProps {
  events: SessionEvent[];
  changedFilesCount?: number;
  onReviewFile: (filePath: string) => void;
  onOpenDiffDrawer: () => void;
}

export function ChangeReviewStrip({
  events,
  changedFilesCount = 0,
  onReviewFile,
  onOpenDiffDrawer
}: ChangeReviewStripProps) {
  const { t } = useI18n();
  const editedFiles = useMemo(() => collectSessionEditedFiles(events), [events]);

  const totalCount = Math.max(editedFiles.length, changedFilesCount);
  if (totalCount <= 0) return null;

  const totalAdd = editedFiles.reduce((acc, f) => acc + f.additions, 0);
  const totalDel = editedFiles.reduce((acc, f) => acc + f.deletions, 0);

  return (
    <div
      className={styles.strip}
      role="region"
      aria-label={t('chat.reviewDiff')}
      data-testid="change-review-strip"
    >
      <div className={styles.summary}>
        <span>{t('chat.filesChanged', { count: totalCount })}</span>
        {totalAdd > 0 && <span className={styles.addStat}>+{totalAdd}</span>}
        {totalDel > 0 && <span className={styles.delStat}>-{totalDel}</span>}
      </div>

      <div className={styles.chips} data-hscroll="1">
        {editedFiles.map((file) => (
          <button
            key={file.path}
            type="button"
            className={styles.fileChip}
            onClick={() => onReviewFile(file.path)}
            title={file.path}
            data-testid={`review-file-chip-${file.basename}`}
          >
            <span>{file.basename}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        className={styles.reviewBtn}
        onClick={onOpenDiffDrawer}
        data-testid="change-review-open-btn"
      >
        {t('chat.reviewDiff')}
      </button>
    </div>
  );
}
