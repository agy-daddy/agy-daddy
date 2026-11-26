import { useState } from 'preact/hooks';
import { type TranslateFn, useI18n } from '../i18n';
import type { PermissionLevel, SessionEvent } from '../types';
import { summarizeToolEvent } from './chatFilter';
import styles from './PendingFloatingCard.module.css';

export interface PendingFloatingCardProps {
  pendingEvent: SessionEvent | null;
  permissionLevel: PermissionLevel;
  onApprove: (seq: number, decision: 'allow' | 'deny') => Promise<void>;
  onAnswer: (seq: number, answers: unknown) => Promise<void>;
  onJumpToStep?: (seq: number) => void;
}

function getPendingPreview(ev: SessionEvent, t: TranslateFn): string {
  const p = ev.payload || {};
  if (ev.kind === 'ask_question') {
    const reqInt =
      p.requestedInteraction && typeof p.requestedInteraction === 'object'
        ? (p.requestedInteraction as Record<string, unknown>)
        : null;
    const nested =
      reqInt?.interaction && typeof reqInt.interaction === 'object'
        ? (reqInt.interaction as Record<string, unknown>)
        : reqInt;
    const askObj =
      nested?.askQuestion && typeof nested.askQuestion === 'object'
        ? (nested.askQuestion as Record<string, unknown>)
        : null;
    const questions =
      (Array.isArray(p.questions) && p.questions.length > 0 && p.questions) ||
      (Array.isArray(askObj?.questions) && askObj.questions) ||
      [];
    const first = questions[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
    if (first && typeof first === 'object') {
      const obj = first as Record<string, unknown>;
      const txt = String(obj.question || obj.prompt || obj.text || '').trim();
      if (txt) return txt;
    }
    return t('pending.questionFallback');
  }

  return summarizeToolEvent(ev, t);
}

export function PendingFloatingCard({
  pendingEvent,
  permissionLevel,
  onApprove,
  onJumpToStep
}: PendingFloatingCardProps) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);

  if (!pendingEvent) return null;

  const isReadOnly = permissionLevel === 'L0';
  const isAsk = pendingEvent.kind === 'ask_question';
  const preview = getPendingPreview(pendingEvent, t);

  const jumpToInlineCard = () => {
    if (onJumpToStep) {
      onJumpToStep(pendingEvent.seq);
      return;
    }
    if (typeof document !== 'undefined') {
      const target = document.querySelector(`[data-testid="step-card-${pendingEvent.seq}"]`);
      if (target && typeof (target as HTMLElement).scrollIntoView === 'function') {
        (target as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  };

  const handleDecision = async (decision: 'allow' | 'deny') => {
    if (isReadOnly || busy) return;
    setBusy(true);
    try {
      await onApprove(pendingEvent.seq, decision);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={styles.floatBar}
      data-testid="pending-floating-card"
      role="region"
      aria-label={t('pending.regionLabel')}
    >
      <button
        type="button"
        className={styles.infoBtn}
        onClick={jumpToInlineCard}
        title={t('pending.jumpTitle')}
      >
        <span className={styles.pulseDot} aria-hidden="true" />
        <div className={styles.infoText}>
          <div className={styles.headLine}>
            <span className={styles.badge}>
              {isAsk ? t('pending.askBadge') : t('pending.approvalBadge')}
            </span>
            <span className={styles.seq}>#{pendingEvent.seq}</span>
            {isReadOnly && <span className={styles.roBadge}>{t('pending.readOnlyBadge')}</span>}
          </div>
          <div className={styles.preview}>{preview}</div>
        </div>
      </button>

      <div className={styles.actions}>
        {isAsk ? (
          <button
            type="button"
            className={`${styles.compactBtn} ${styles.allowBtn}`}
            onClick={jumpToInlineCard}
            data-testid="pending-jump-answer"
          >
            {t('pending.answerBtn')}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`${styles.compactBtn} ${styles.denyBtn}`}
              disabled={isReadOnly || busy}
              aria-label={t('pending.deny')}
              onClick={() => handleDecision('deny')}
              data-testid="pending-quick-deny"
            >
              {t('pending.deny')}
            </button>
            <button
              type="button"
              className={`${styles.compactBtn} ${styles.allowBtn}`}
              disabled={isReadOnly || busy}
              aria-label={t('pending.allow')}
              onClick={() => handleDecision('allow')}
              data-testid="pending-quick-allow"
            >
              {busy ? '...' : t('pending.allow')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
