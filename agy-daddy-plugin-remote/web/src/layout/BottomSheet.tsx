import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { useI18n } from '../i18n';
import styles from './BottomSheet.module.css';

export interface BottomSheetProps {
  open: boolean;
  title: string;
  subtitle?: string;
  headerLeft?: ComponentChildren;
  headerActions?: ComponentChildren;
  testId?: string;
  ariaLabel?: string;
  maxHeightCss?: string;
  onClose: () => void;
  children: ComponentChildren;
}

export function BottomSheet({
  open,
  title,
  subtitle,
  headerLeft,
  headerActions,
  testId,
  ariaLabel,
  maxHeightCss,
  onClose,
  children
}: BottomSheetProps) {
  const { t } = useI18n();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    startY: number;
    startX: number;
    startTime: number;
    lastY: number;
    lastTime: number;
    active: boolean;
    aborted: boolean;
    fromHandle: boolean;
    rafId: number;
    pendingDy: number;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const sheetEl = sheetRef.current;
    const backdropEl = backdropRef.current;
    if (!sheetEl) return;

    const resetDragStyles = () => {
      delete sheetEl.dataset.dragging;
      sheetEl.style.removeProperty('--sheet-drag-y');
      backdropEl?.style.removeProperty('--sheet-backdrop-progress');
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const target = e.target as Element | null;
      const fromHandle = Boolean(
        target?.closest(`.${styles.handleWrap}, .${styles.header}`)
      );
      const bodyScrollTop = bodyRef.current ? bodyRef.current.scrollTop : 0;
      if (!fromHandle && bodyScrollTop > 2) return;
      if (!fromHandle && target?.closest('input, textarea, select, [data-hscroll="1"]')) return;

      const touch = e.touches[0];
      const now = performance.now();
      dragRef.current = {
        startY: touch.clientY,
        startX: touch.clientX,
        startTime: now,
        lastY: touch.clientY,
        lastTime: now,
        active: fromHandle,
        aborted: false,
        fromHandle,
        rafId: 0,
        pendingDy: 0
      };
      if (fromHandle) {
        sheetEl.dataset.dragging = '1';
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const d = dragRef.current;
      if (!d || d.aborted || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const dy = touch.clientY - d.startY;
      const dx = touch.clientX - d.startX;

      if (!d.active) {
        if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * 0.9) {
          d.aborted = true;
          resetDragStyles();
          return;
        }
        if (dy < 6) {
          if (dy < -8) {
            d.aborted = true;
            resetDragStyles();
          }
          return;
        }
        if ((bodyRef.current?.scrollTop || 0) > 2) {
          d.aborted = true;
          return;
        }
        d.active = true;
        sheetEl.dataset.dragging = '1';
      }

      if (e.cancelable) e.preventDefault();
      d.lastY = touch.clientY;
      d.lastTime = performance.now();
      const clampedDy = dy < 0 ? Math.max(-14, dy * 0.16) : dy;
      d.pendingDy = clampedDy;

      if (!d.rafId) {
        d.rafId = requestAnimationFrame(() => {
          d.rafId = 0;
          sheetEl.style.setProperty('--sheet-drag-y', `${d.pendingDy.toFixed(1)}px`);
          if (backdropEl) {
            const h = Math.max(240, sheetEl.offsetHeight || 400);
            const prog = Math.max(0.15, Math.min(1, 1 - Math.max(0, d.pendingDy) / h));
            backdropEl.style.setProperty('--sheet-backdrop-progress', prog.toFixed(3));
          }
        });
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      if (d.rafId) cancelAnimationFrame(d.rafId);
      if (!d.active || d.aborted) {
        resetDragStyles();
        return;
      }
      const endY = e.changedTouches[0]?.clientY ?? d.lastY;
      const dy = endY - d.startY;
      const dt = Math.max(16, performance.now() - d.lastTime);
      const vy = (endY - d.lastY) / dt;
      resetDragStyles();
      if (dy > 88 || vy > 0.45) {
        onClose();
      }
    };

    sheetEl.addEventListener('touchstart', onTouchStart, { passive: true });
    sheetEl.addEventListener('touchmove', onTouchMove, { passive: false });
    sheetEl.addEventListener('touchend', onTouchEnd, { passive: true });
    sheetEl.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      if (dragRef.current?.rafId) cancelAnimationFrame(dragRef.current.rafId);
      dragRef.current = null;
      sheetEl.removeEventListener('touchstart', onTouchStart);
      sheetEl.removeEventListener('touchmove', onTouchMove);
      sheetEl.removeEventListener('touchend', onTouchEnd);
      sheetEl.removeEventListener('touchcancel', onTouchEnd);
      resetDragStyles();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className={styles.backdrop}
      data-hscroll="1"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel || title}
      data-testid={testId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className={styles.sheet}
        style={maxHeightCss ? { maxHeight: maxHeightCss } : undefined}
      >
        <div className={styles.handleWrap} data-testid={testId ? `${testId}-handle` : undefined}>
          <span className={styles.handle} aria-hidden="true" />
        </div>

        <div className={styles.header}>
          <div className={styles.headerLeft}>
            {headerLeft}
            <div className={styles.titleGroup}>
              <h2 className={styles.title}>{title}</h2>
              {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
            </div>
          </div>
          <div className={styles.headerRight}>
            {headerActions}
            <button
              type="button"
              className={styles.closeBtn}
              aria-label={t('common.close')}
              data-testid={testId ? `${testId}-close` : undefined}
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </div>

        <div ref={bodyRef} className={styles.body}>
          {children}
        </div>
      </div>
    </div>
  );
}
