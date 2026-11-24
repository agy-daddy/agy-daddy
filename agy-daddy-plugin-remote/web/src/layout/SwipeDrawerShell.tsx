import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import styles from './SwipeDrawerShell.module.css';

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
    target.closest('[data-hscroll="1"], pre, code, .xterm, input, textarea, select')
  );
}

export function SwipeDrawerShell({
  leftOpen,
  rightOpen,
  onSetLeft,
  onSetRight,
  leftContent,
  rightContent,
  children
}: SwipeDrawerShellProps) {
  const gestureRef = useRef<{
    x: number;
    y: number;
    dead: boolean;
  } | null>(null);

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

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    gestureRef.current = {
      x: t.clientX,
      y: t.clientY,
      dead: isInHorizontalDeadZone(e.target)
    };
  };

  const onTouchEnd = (e: TouchEvent) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g || g.dead || e.changedTouches.length !== 1) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - g.x;
    const dy = t.clientY - g.y;
    if (Math.abs(dx) < 56 || Math.abs(dy) > Math.abs(dx) * 0.75) return;

    if (dx > 0) {
      if (rightOpen) onSetRight(false);
      else if (!leftOpen && g.x < 120) onSetLeft(true);
    } else {
      if (leftOpen) onSetLeft(false);
      else if (!rightOpen && g.x > window.innerWidth - 120) onSetRight(true);
    }
  };

  return (
    <div
      className="ag-shell"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {children}

      {(leftOpen || rightOpen) && (
        <div
          className={styles.backdrop}
          aria-hidden="true"
          onClick={() => {
            onSetLeft(false);
            onSetRight(false);
          }}
        />
      )}

      <aside
        className={`${styles.drawer} ${styles.left} ${leftOpen ? styles.leftOpen : ''}`}
        aria-hidden={!leftOpen}
        data-testid="left-drawer"
      >
        {leftContent}
      </aside>

      <aside
        className={`${styles.drawer} ${styles.right} ${rightOpen ? styles.rightOpen : ''}`}
        aria-hidden={!rightOpen}
        data-testid="right-drawer"
      >
        {rightContent}
      </aside>
    </div>
  );
}
