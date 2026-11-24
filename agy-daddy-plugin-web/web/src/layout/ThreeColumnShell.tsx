import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useTheme } from '../theme/ThemeProvider';
import {
  CENTER_MIN,
  RIGHTBAR_MIN,
  SIDEBAR_AUTO_COLLAPSE,
  SIDEBAR_DEFAULT,
  clampSidebarWidth,
  computeColumns,
} from './columns';
import styles from './ThreeColumnShell.module.css';

export interface ThreeColumnShellProps {
  topbar?: React.ReactNode;
  sidebar: React.ReactNode;
  sidebarCollapsedContent?: React.ReactNode;
  sidebarFooter?: React.ReactNode;
  sidebarCollapsedFooter?: React.ReactNode;
  onOpenSettings?: () => void;
  center: React.ReactNode;
  rightbar?: React.ReactNode;
  defaultSidebarWidth?: number;
  defaultRightbarWidth?: number;
  defaultRightbarOpen?: boolean;
  rightbarOpen?: boolean;
  onRightbarOpenChange?: (open: boolean) => void;
  sidebarCollapsed?: boolean;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
  viewportWidth?: number;
}

function SettingsGearGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.25" />
      <path d="M13.2 9.9a1.1 1.1 0 0 0 .22 1.21l.04.04a1.33 1.33 0 1 1-1.88 1.88l-.04-.04a1.1 1.1 0 0 0-1.21-.22 1.1 1.1 0 0 0-.67 1.01v.11a1.33 1.33 0 1 1-2.66 0v-.06a1.1 1.1 0 0 0-.72-1.01 1.1 1.1 0 0 0-1.21.22l-.04.04a1.33 1.33 0 1 1-1.88-1.88l.04-.04a1.1 1.1 0 0 0 .22-1.21 1.1 1.1 0 0 0-1.01-.67h-.11a1.33 1.33 0 1 1 0-2.66h.06a1.1 1.1 0 0 0 1.01-.72 1.1 1.1 0 0 0-.22-1.21l-.04-.04a1.33 1.33 0 1 1 1.88-1.88l.04.04a1.1 1.1 0 0 0 1.21.22h.05a1.1 1.1 0 0 0 .67-1.01v-.11a1.33 1.33 0 1 1 2.66 0v.06a1.1 1.1 0 0 0 .67 1.01 1.1 1.1 0 0 0 1.21-.22l.04-.04a1.33 1.33 0 1 1 1.88 1.88l-.04.04a1.1 1.1 0 0 0-.22 1.21v.05a1.1 1.1 0 0 0 1.01.67h.11a1.33 1.33 0 1 1 0 2.66h-.06a1.1 1.1 0 0 0-1.01.67Z" />
    </svg>
  );
}

type DragTarget = 'sidebar' | 'rightbar' | null;

export function ThreeColumnShell({
  topbar,
  sidebar,
  sidebarCollapsedContent,
  sidebarFooter,
  sidebarCollapsedFooter,
  onOpenSettings,
  center,
  rightbar,
  defaultSidebarWidth = SIDEBAR_DEFAULT,
  defaultRightbarWidth,
  defaultRightbarOpen = true,
  rightbarOpen: controlledRightbarOpen,
  onRightbarOpenChange,
  sidebarCollapsed: controlledSidebarCollapsed,
  onSidebarCollapsedChange,
  viewportWidth: controlledViewportWidth,
}: ThreeColumnShellProps) {
  const [measuredViewport, setMeasuredViewport] = useState<number>(() =>
    typeof window !== 'undefined' && window.innerWidth > 0 ? window.innerWidth : 1440,
  );
  const viewportWidth = controlledViewportWidth ?? measuredViewport;

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => clampSidebarWidth(defaultSidebarWidth));
  const [rightbarWidth, setRightbarWidth] = useState<number | undefined>(defaultRightbarWidth);
  const [uncontrolledRightbarOpen, setUncontrolledRightbarOpen] = useState<boolean>(defaultRightbarOpen);
  const [manualCollapsePref, setManualCollapsePref] = useState<boolean | null>(null);
  const [dragging, setDragging] = useState<DragTarget>(null);

  const rightbarOpen = controlledRightbarOpen ?? uncontrolledRightbarOpen;
  const hasRightbarSlot = Boolean(rightbar);

  useEffect(() => {
    if (controlledViewportWidth !== undefined || typeof window === 'undefined') return;
    const handleResize = () => {
      if (window.innerWidth > 0) {
        setMeasuredViewport(window.innerWidth);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [controlledViewportWidth]);

  const effectiveCollapsedProp =
    controlledSidebarCollapsed !== undefined ? controlledSidebarCollapsed : manualCollapsePref ?? undefined;
  const manualExpand =
    viewportWidth < SIDEBAR_AUTO_COLLAPSE && effectiveCollapsedProp === false;

  const layout = useMemo(
    () =>
      computeColumns({
        viewportWidth,
        sidebarWidth,
        sidebarCollapsed: effectiveCollapsedProp,
        sidebarManualExpand: manualExpand,
        rightbarWidth,
        rightbarOpen: hasRightbarSlot && rightbarOpen,
      }),
    [viewportWidth, sidebarWidth, effectiveCollapsedProp, manualExpand, rightbarWidth, hasRightbarSlot, rightbarOpen],
  );

  const setRightbarOpen = useCallback(
    (next: boolean) => {
      if (controlledRightbarOpen === undefined) {
        setUncontrolledRightbarOpen(next);
      }
      onRightbarOpenChange?.(next);
    },
    [controlledRightbarOpen, onRightbarOpenChange],
  );

  const toggleSidebar = useCallback(() => {
    const nextCollapsed = !layout.sidebarCollapsed;
    if (controlledSidebarCollapsed === undefined) {
      setManualCollapsePref(nextCollapsed);
    }
    onSidebarCollapsedChange?.(nextCollapsed);
  }, [layout.sidebarCollapsed, controlledSidebarCollapsed, onSidebarCollapsedChange]);

  const toggleRightbar = useCallback(() => {
    setRightbarOpen(!rightbarOpen);
  }, [rightbarOpen, setRightbarOpen]);

  const dragStateRef = useRef<{ target: DragTarget; startX: number; startWidth: number }>({
    target: null,
    startX: 0,
    startWidth: 0,
  });

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (ev: MouseEvent) => {
      const st = dragStateRef.current;
      if (!st.target) return;
      const delta = ev.clientX - st.startX;
      if (st.target === 'sidebar') {
        setSidebarWidth(clampSidebarWidth(st.startWidth + delta));
      } else if (st.target === 'rightbar') {
        const nextWidth = st.startWidth - delta;
        const maxRight = Math.max(RIGHTBAR_MIN, layout.rightbarMax);
        setRightbarWidth(Math.min(maxRight, Math.max(RIGHTBAR_MIN, Math.round(nextWidth))));
      }
    };

    const handleMouseUp = () => {
      dragStateRef.current.target = null;
      setDragging(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, layout.rightbarMax]);

  const startDrag = (target: Exclude<DragTarget, null>) => (ev: React.MouseEvent<HTMLDivElement>) => {
    ev.preventDefault();
    dragStateRef.current = {
      target,
      startX: ev.clientX,
      startWidth: target === 'sidebar' ? layout.sidebar : layout.rightbar,
    };
    setDragging(target);
  };

  const { t } = useI18n();
  const { drawerDurationMs } = useTheme();
  const centerRef = useRef<HTMLElement | null>(null);
  const prevSidebarWidthRef = useRef<number>(layout.sidebar);
  const [animating, setAnimating] = useState(false);

  useLayoutEffect(() => {
    const prevW = prevSidebarWidthRef.current;
    const nextW = layout.sidebar;
    prevSidebarWidthRef.current = nextW;
    if (dragging || prevW === nextW || !centerRef.current || drawerDurationMs === 0) {
      setAnimating(false);
      return;
    }

    const deltaX = prevW - nextW;
    const el = centerRef.current;
    el.style.transition = 'none';
    el.style.transform = `translate3d(${deltaX}px, 0, 0)`;
    setAnimating(true);

    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        if (!centerRef.current) return;
        centerRef.current.style.transition = '';
        centerRef.current.style.transform = 'translate3d(0, 0, 0)';
      });
    });

    const timer = window.setTimeout(() => {
      setAnimating(false);
    }, drawerDurationMs + 50);

    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      window.clearTimeout(timer);
    };
  }, [layout.sidebar, dragging, drawerDurationMs]);

  const handleCenterTransitionEnd = useCallback((ev: React.TransitionEvent<HTMLElement>) => {
    if (ev.target === centerRef.current && ev.propertyName === 'transform') {
      setAnimating(false);
    }
  }, []);

  const canShowRightToggle =
    hasRightbarSlot && viewportWidth - layout.sidebar - CENTER_MIN >= RIGHTBAR_MIN;

  const expandedSidebarWidth = clampSidebarWidth(sidebarWidth);

  const hasExpandedFooter = Boolean(sidebarFooter || onOpenSettings);
  const hasCollapsedFooter = Boolean(sidebarCollapsedFooter || onOpenSettings);
  const hasCollapsedRail = Boolean(sidebarCollapsedContent || hasCollapsedFooter);

  return (
    <div className={styles.shell} data-testid="three-column-shell">
      <header className={styles.topbar} data-testid="shell-topbar">
        <div className={styles.topbarLeft}>
          <button
            type="button"
            className={`${styles.iconBtn} ${!layout.sidebarCollapsed ? styles.iconBtnActive : ''}`}
            onClick={toggleSidebar}
            title={layout.sidebarCollapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')}
            aria-label={layout.sidebarCollapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')}
            aria-expanded={!layout.sidebarCollapsed}
            data-testid="toggle-sidebar-btn"
          >
            {layout.sidebarCollapsed ? '»' : '«'}
          </button>
        </div>

        <div className={styles.topbarSlot}>{topbar}</div>

        {hasRightbarSlot && (
          <button
            type="button"
            className={`${styles.iconBtn} ${layout.rightbarVisible ? styles.iconBtnActive : ''}`}
            onClick={toggleRightbar}
            disabled={!canShowRightToggle}
            title={
              !canShowRightToggle
                ? t('shell.viewportNarrow')
                : layout.rightbarVisible
                  ? t('shell.hideDock')
                  : t('shell.showDock')
            }
            aria-label={layout.rightbarVisible ? t('shell.hideDock') : t('shell.showDock')}
            aria-expanded={layout.rightbarVisible}
            data-testid="toggle-rightbar-btn"
          >
            {layout.rightbarVisible ? '◨' : '◧'}
          </button>
        )}
      </header>

      <div
        className={`${styles.workspace} ${dragging ? styles.workspaceDragging : ''}`}
        style={{ '--sidebar-expanded-w': `${expandedSidebarWidth}px` } as React.CSSProperties}
        data-testid="shell-workspace"
      >
        <div
          className={[
            styles.sidebarDrawer,
            layout.sidebarCollapsed ? styles.sidebarDrawerCollapsed : '',
            dragging || drawerDurationMs === 0 ? styles.sidebarDrawerNoTransition : '',
            animating ? styles.sidebarAnimating : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-hidden={layout.sidebarCollapsed}
          data-testid="shell-sidebar-drawer"
        >
          <div className={styles.sidebarDrawerContent}>{sidebar}</div>
          {hasExpandedFooter && (
            <div className={styles.sidebarFooter} data-testid="sidebar-footer">
              {sidebarFooter ?? (
                <button
                  type="button"
                  className={styles.settingsFooterBtn}
                  onClick={onOpenSettings}
                  title={t('sidebar.settings')}
                  aria-label={t('sidebar.settings')}
                  tabIndex={layout.sidebarCollapsed ? -1 : 0}
                  data-testid={
                    layout.sidebarCollapsed
                      ? 'bottom-left-settings-expanded-btn'
                      : 'bottom-left-settings-btn'
                  }
                >
                  <SettingsGearGlyph />
                  <span>{t('sidebar.settings')}</span>
                </button>
              )}
            </div>
          )}
        </div>

        <aside
          className={`${styles.sidebar} ${dragging ? styles.sidebarNoTransition : ''}`}
          style={{ width: `${layout.sidebar}px` }}
          data-collapsed={layout.sidebarCollapsed ? 'true' : 'false'}
          data-testid="shell-sidebar"
        >
          <div className={styles.sidebarBody}>
            {hasCollapsedRail && (
              <div
                className={`${styles.collapsedRailLayer} ${
                  layout.sidebarCollapsed ? styles.collapsedRailLayerVisible : ''
                }`}
                aria-hidden={!layout.sidebarCollapsed}
                data-testid="shell-sidebar-rail"
              >
                <div className={styles.collapsedRailBody}>{sidebarCollapsedContent}</div>
                {hasCollapsedFooter && (
                  <div className={styles.collapsedRailFooter} data-testid="sidebar-collapsed-footer">
                    {sidebarCollapsedFooter ?? (
                      <button
                        type="button"
                        className={styles.collapsedSettingsBtn}
                        onClick={onOpenSettings}
                        title={t('sidebar.settings')}
                        aria-label={t('sidebar.settings')}
                        tabIndex={layout.sidebarCollapsed ? 0 : -1}
                        data-testid={
                          layout.sidebarCollapsed
                            ? 'bottom-left-settings-btn'
                            : 'bottom-left-settings-collapsed-btn'
                        }
                      >
                        <SettingsGearGlyph />
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>

        {!layout.sidebarCollapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('shell.resizeSidebar')}
            className={`${styles.resizer} ${dragging === 'sidebar' ? styles.resizerActive : ''}`}
            data-dragging={dragging === 'sidebar' ? 'true' : 'false'}
            data-testid="sidebar-resizer"
            onMouseDown={startDrag('sidebar')}
          />
        )}

        <main
          ref={centerRef}
          onTransitionEnd={handleCenterTransitionEnd}
          className={`${styles.center} ${animating ? styles.centerFlipAnimating : ''}`}
          style={{ minWidth: `${Math.min(CENTER_MIN, Math.max(0, viewportWidth - layout.sidebar))}px` }}
          data-testid="shell-center"
        >
          {center}
        </main>

        {layout.rightbarVisible && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t('shell.resizeRightbar')}
              className={`${styles.resizer} ${dragging === 'rightbar' ? styles.resizerActive : ''}`}
              data-dragging={dragging === 'rightbar' ? 'true' : 'false'}
              data-testid="rightbar-resizer"
              onMouseDown={startDrag('rightbar')}
            />
            <aside
              className={`${styles.rightbar} ${dragging ? styles.rightbarNoTransition : ''}`}
              style={{ width: `${layout.rightbar}px` }}
              data-testid="shell-rightbar"
            >
              <div className={styles.rightbarBody}>{rightbar}</div>
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
