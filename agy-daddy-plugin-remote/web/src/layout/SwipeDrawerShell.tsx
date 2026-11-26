import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useI18n } from '../i18n';
import styles from './SwipeDrawerShell.module.css';

const DRAWER_HINT_STORAGE_KEY = 'agy_remote_drawer_hint_v1';

export interface SwipeDrawerShellProps {
  leftOpen: boolean;
  rightOpen: boolean;
  onSetLeft: (open: boolean) => void;
  onSetRight: (open: boolean) => void;
  leftContent: ComponentChildren;
  rightContent: ComponentChildren;
  children: ComponentChildren;
}

function isInHorizontalDeadZone(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest('[data-hscroll="1"], pre, code, .xterm, input, textarea, select, [role="slider"]')
  );
}

function isHintDismissed(): boolean {
  try {
    return window.localStorage?.getItem(DRAWER_HINT_STORAGE_KEY) === '1';
  } catch {
    return true;
  }
}

function markHintDismissed(): void {
  try {
    window.localStorage?.setItem(DRAWER_HINT_STORAGE_KEY, '1');
  } catch {}
}

type GesturePhase = 'IDLE' | 'PENDING_LOCK' | 'DRAGGING' | 'ABORTED_VERTICAL';

export function SwipeDrawerShell({
  leftOpen,
  rightOpen,
  onSetLeft,
  onSetRight,
  leftContent,
  rightContent,
  children
}: SwipeDrawerShellProps) {
  const { t } = useI18n();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const leftRef = useRef<HTMLElement | null>(null);
  const rightRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  const [showHint, setShowHint] = useState<boolean>(() => !isHintDismissed());
  const [hintTopPx, setHintTopPx] = useState<number | null>(null);

  const stateRef = useRef({ leftOpen, rightOpen, onSetLeft, onSetRight });
  stateRef.current = { leftOpen, rightOpen, onSetLeft, onSetRight };

  const dismissHint = () => {
    markHintDismissed();
    setShowHint(false);
  };

  useEffect(() => {
    if (!showHint || leftOpen || rightOpen) return;
    const shellEl = shellRef.current;
    if (!shellEl) return;

    const updateHintTop = () => {
      const scroller = shellEl.querySelector('[data-testid="chat-scroller"]');
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        if (rect.top > 0) {
          setHintTopPx(Math.round(rect.top + 8));
          return;
        }
      }
      const strip = shellEl.querySelector('[data-testid="change-review-strip"]');
      if (strip) {
        const rect = strip.getBoundingClientRect();
        if (rect.bottom > 0) {
          setHintTopPx(Math.round(rect.bottom + 8));
          return;
        }
      }
      setHintTopPx(null);
    };

    updateHintTop();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateHintTop) : null;
    ro?.observe(shellEl);
    const mainEl = shellEl.querySelector('main');
    const scrollerEl = shellEl.querySelector('[data-testid="chat-scroller"]');
    if (mainEl) ro?.observe(mainEl);
    if (scrollerEl) ro?.observe(scrollerEl);
    const mo =
      typeof MutationObserver !== 'undefined' && mainEl
        ? new MutationObserver(updateHintTop)
        : null;
    if (mo && mainEl) mo.observe(mainEl, { childList: true });
    window.addEventListener('resize', updateHintTop);

    return () => {
      ro?.disconnect();
      mo?.disconnect();
      window.removeEventListener('resize', updateHintTop);
    };
  }, [showHint, leftOpen, rightOpen]);

  useEffect(() => {
    if ((leftOpen || rightOpen) && showHint) {
      markHintDismissed();
      setShowHint(false);
    }
  }, [leftOpen, rightOpen, showHint]);

  useEffect(() => {
    if (!leftOpen && !rightOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (leftOpen) onSetLeft(false);
        if (rightOpen) onSetRight(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [leftOpen, rightOpen, onSetLeft, onSetRight]);

  useEffect(() => {
    const shellEl = shellRef.current;
    if (!shellEl) return;

    let phase: GesturePhase = 'IDLE';
    let targetSide: 'left' | 'right' | null = null;
    let initialOpen = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastTime = 0;
    let drawerWidth = 340;
    let rafId = 0;
    let pendingOffset = 0;
    let pendingProgress = 0;

    const clearDomVars = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      for (const el of [leftRef.current, rightRef.current]) {
        if (el) {
          delete el.dataset.dragging;
          el.style.removeProperty('--drawer-drag-x');
        }
      }
      if (backdropRef.current) {
        delete backdropRef.current.dataset.dragging;
        backdropRef.current.style.removeProperty('--backdrop-progress');
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const { leftOpen: lOpen, rightOpen: rOpen } = stateRef.current;
      const vw = window.innerWidth || 390;
      const inDeadZone = isInHorizontalDeadZone(e.target);

      if (lOpen) {
        if (inDeadZone && e.target instanceof Element) {
          const scroller = e.target.closest('[data-hscroll="1"], pre, code, .xterm');
          if (scroller && scroller.scrollWidth > scroller.clientWidth) return;
        }
        targetSide = 'left';
        initialOpen = true;
      } else if (rOpen) {
        if (inDeadZone && e.target instanceof Element) {
          const scroller = e.target.closest('[data-hscroll="1"], pre, code, .xterm');
          if (scroller && scroller.scrollWidth > scroller.clientWidth) return;
        }
        targetSide = 'right';
        initialOpen = true;
      } else {
        if (inDeadZone) return;
        if (touch.clientX <= 28) {
          targetSide = 'left';
          initialOpen = false;
        } else if (touch.clientX >= vw - 28) {
          targetSide = 'right';
          initialOpen = false;
        } else {
          return;
        }
      }

      const panel = targetSide === 'left' ? leftRef.current : rightRef.current;
      drawerWidth = Math.max(240, panel?.offsetWidth || Math.min(vw * 0.86, 360));
      startX = touch.clientX;
      startY = touch.clientY;
      lastX = touch.clientX;
      lastTime = performance.now();
      phase = 'PENDING_LOCK';
    };

    const onTouchMove = (e: TouchEvent) => {
      if (phase === 'IDLE' || phase === 'ABORTED_VERTICAL' || !targetSide || e.touches.length !== 1) {
        return;
      }
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (phase === 'PENDING_LOCK') {
        const dist = Math.hypot(dx, dy);
        if (dist < 8) return;
        if (Math.abs(dy) > Math.abs(dx) * 0.85) {
          phase = 'ABORTED_VERTICAL';
          return;
        }
        // Check intended direction so edge swipe away from screen doesn't lock
        if (!initialOpen) {
          if (targetSide === 'left' && dx <= 0) {
            phase = 'ABORTED_VERTICAL';
            return;
          }
          if (targetSide === 'right' && dx >= 0) {
            phase = 'ABORTED_VERTICAL';
            return;
          }
        }
        phase = 'DRAGGING';
        const panel = targetSide === 'left' ? leftRef.current : rightRef.current;
        if (panel) panel.dataset.dragging = '1';
        if (backdropRef.current) backdropRef.current.dataset.dragging = '1';
      }

      if (phase !== 'DRAGGING') return;
      if (e.cancelable) e.preventDefault();

      lastX = touch.clientX;
      lastTime = performance.now();

      const rubberBand = (excess: number) => Math.min(18, Math.max(-18, excess * 0.18));
      let offsetPx = 0;
      let progress = 0;

      if (targetSide === 'left') {
        if (initialOpen) {
          offsetPx = dx > 0 ? rubberBand(dx) : Math.max(-drawerWidth, dx);
          progress = Math.max(0, Math.min(1, 1 + offsetPx / drawerWidth));
        } else {
          offsetPx = dx > drawerWidth ? drawerWidth + rubberBand(dx - drawerWidth) : Math.max(0, dx);
          progress = Math.max(0, Math.min(1, offsetPx / drawerWidth));
        }
      } else {
        if (initialOpen) {
          offsetPx = dx < 0 ? rubberBand(dx) : Math.min(drawerWidth, dx);
          progress = Math.max(0, Math.min(1, 1 - offsetPx / drawerWidth));
        } else {
          offsetPx = dx < -drawerWidth ? -drawerWidth + rubberBand(dx + drawerWidth) : Math.min(0, dx);
          progress = Math.max(0, Math.min(1, Math.abs(offsetPx) / drawerWidth));
        }
      }

      pendingOffset = offsetPx;
      pendingProgress = progress;

      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          const panel = targetSide === 'left' ? leftRef.current : rightRef.current;
          if (panel) {
            panel.style.setProperty('--drawer-drag-x', `${pendingOffset.toFixed(1)}px`);
          }
          if (backdropRef.current) {
            backdropRef.current.style.setProperty(
              '--backdrop-progress',
              pendingProgress.toFixed(3)
            );
          }
        });
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (phase !== 'DRAGGING' || !targetSide) {
        phase = 'IDLE';
        targetSide = null;
        clearDomVars();
        return;
      }
      const endX = e.changedTouches[0]?.clientX ?? lastX;
      const dx = endX - startX;
      const dt = Math.max(16, performance.now() - lastTime);
      const vx = (endX - lastX) / dt;
      const side = targetSide;
      const wasOpen = initialOpen;

      phase = 'IDLE';
      targetSide = null;
      clearDomVars();

      const { onSetLeft: setLeft, onSetRight: setRight } = stateRef.current;
      const progress = Math.abs(dx) / drawerWidth;

      if (side === 'left') {
        if (wasOpen) {
          if (dx < 0 && (progress >= 0.35 || vx <= -0.42)) setLeft(false);
        } else if (dx > 0 && (progress >= 0.35 || vx >= 0.42)) {
          setLeft(true);
        }
      } else {
        if (wasOpen) {
          if (dx > 0 && (progress >= 0.35 || vx >= 0.42)) setRight(false);
        } else if (dx < 0 && (progress >= 0.35 || vx <= -0.42)) {
          setRight(true);
        }
      }
    };

    shellEl.addEventListener('touchstart', onTouchStart, { passive: true });
    shellEl.addEventListener('touchmove', onTouchMove, { passive: false });
    shellEl.addEventListener('touchend', onTouchEnd, { passive: true });
    shellEl.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      clearDomVars();
      shellEl.removeEventListener('touchstart', onTouchStart);
      shellEl.removeEventListener('touchmove', onTouchMove);
      shellEl.removeEventListener('touchend', onTouchEnd);
      shellEl.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  const anyOpen = leftOpen || rightOpen;

  return (
    <div ref={shellRef} className="ag-shell">
      {children}

      {!anyOpen && (
        <>
          <div className={`${styles.edgeHandle} ${styles.edgeHandleLeft}`} aria-hidden="true">
            <span className={styles.edgeBar} />
          </div>
          <div className={`${styles.edgeHandle} ${styles.edgeHandleRight}`} aria-hidden="true">
            <span className={styles.edgeBar} />
          </div>
        </>
      )}

      {showHint && !anyOpen && (
        <div
          className={styles.hintBar}
          role="note"
          data-testid="drawer-edge-hint"
          style={hintTopPx !== null ? ({ '--hint-top': `${hintTopPx}px` } as Record<string, string>) : undefined}
        >
          <span className={styles.hintText}>{t('drawer.edgeHint')}</span>
          <button
            type="button"
            className={styles.hintBtn}
            onClick={dismissHint}
            data-testid="drawer-edge-hint-dismiss"
          >
            {t('drawer.edgeHintDismiss')}
          </button>
        </div>
      )}

      <div
        ref={backdropRef}
        className={`${styles.backdrop} ${anyOpen ? styles.backdropVisible : ''}`}
        aria-hidden="true"
        onClick={() => {
          onSetLeft(false);
          onSetRight(false);
        }}
      />

      <aside
        ref={leftRef}
        className={`${styles.drawer} ${styles.left} ${leftOpen ? styles.leftOpen : ''}`}
        aria-hidden={!leftOpen}
        data-testid="left-drawer"
      >
        {leftContent}
      </aside>

      <aside
        ref={rightRef}
        className={`${styles.drawer} ${styles.right} ${rightOpen ? styles.rightOpen : ''}`}
        aria-hidden={!rightOpen}
        data-testid="right-drawer"
      >
        {rightContent}
      </aside>
    </div>
  );
}
