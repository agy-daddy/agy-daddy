import { describe, it, expect } from 'vitest';
import {
  SIDEBAR_MIN,
  SIDEBAR_MAX,
  SIDEBAR_DEFAULT,
  SIDEBAR_COLLAPSED,
  SIDEBAR_AUTO_COLLAPSE,
  CENTER_MIN,
  RIGHTBAR_MIN,
  RIGHTBAR_MAX_RATIO,
  RIGHTBAR_DEFAULT_RATIO,
  computeColumns,
} from './columns';

describe('Suite F1: columns geometry', () => {
  it('exposes expected layout constants', () => {
    expect(SIDEBAR_MIN).toBe(264);
    expect(SIDEBAR_MAX).toBe(420);
    expect(SIDEBAR_DEFAULT).toBe(268);
    expect(SIDEBAR_COLLAPSED).toBe(56);
    expect(SIDEBAR_AUTO_COLLAPSE).toBe(1024);
    expect(CENTER_MIN).toBe(400);
    expect(RIGHTBAR_MIN).toBe(300);
    expect(RIGHTBAR_MAX_RATIO).toBe(0.7);
    expect(RIGHTBAR_DEFAULT_RATIO).toBe(0.28);
  });

  it('computes 1440px three-column full expand layout with exact widths', () => {
    const layout = computeColumns({
      viewportWidth: 1440,
      rightbarOpen: true,
    });

    expect(layout.sidebarCollapsed).toBe(false);
    expect(layout.sidebar).toBe(268);
    expect(layout.rightbarVisible).toBe(true);
    expect(layout.rightbar).toBe(Math.round(1440 * 0.28));
    expect(layout.center).toBe(1440 - layout.sidebar - layout.rightbar);
    expect(layout.center).toBeGreaterThanOrEqual(CENTER_MIN);
    expect(layout.sidebar + layout.center + layout.rightbar).toBe(1440);
  });

  it('clamps custom sidebar and rightbar widths within bounds', () => {
    const layout = computeColumns({
      viewportWidth: 1440,
      sidebarWidth: 600,
      rightbarWidth: 1200,
      rightbarOpen: true,
    });

    expect(layout.sidebar).toBe(SIDEBAR_MAX);
    expect(layout.center).toBeGreaterThanOrEqual(CENTER_MIN);
    expect(layout.rightbar).toBeLessThanOrEqual(Math.floor(1440 * RIGHTBAR_MAX_RATIO));
    expect(layout.sidebar + layout.center + layout.rightbar).toBe(1440);

    const smallSidebar = computeColumns({
      viewportWidth: 1440,
      sidebarWidth: 100,
      rightbarWidth: 100,
      rightbarOpen: true,
    });
    expect(smallSidebar.sidebar).toBe(SIDEBAR_MIN);
    expect(smallSidebar.rightbar).toBe(RIGHTBAR_MIN);
  });

  it('auto-collapses sidebar to 56px below 1024px unless manually expanded', () => {
    const autoCollapsed = computeColumns({
      viewportWidth: 1000,
      rightbarOpen: true,
    });
    expect(autoCollapsed.sidebarCollapsed).toBe(true);
    expect(autoCollapsed.sidebar).toBe(56);
    expect(autoCollapsed.center).toBeGreaterThanOrEqual(CENTER_MIN);

    const manuallyExpanded = computeColumns({
      viewportWidth: 1000,
      sidebarManualExpand: true,
      rightbarOpen: true,
    });
    expect(manuallyExpanded.sidebarCollapsed).toBe(false);
    expect(manuallyExpanded.sidebar).toBe(SIDEBAR_DEFAULT);
    expect(manuallyExpanded.center).toBeGreaterThanOrEqual(CENTER_MIN);
  });

  it('protects center >= 400px on narrow viewports by hiding rightbar (rightbar=0)', () => {
    const narrow = computeColumns({
      viewportWidth: 740,
      rightbarOpen: true,
    });

    expect(narrow.sidebar).toBe(SIDEBAR_COLLAPSED);
    expect(narrow.rightbar).toBe(0);
    expect(narrow.rightbarVisible).toBe(false);
    expect(narrow.center).toBe(740 - SIDEBAR_COLLAPSED);
    expect(narrow.center).toBeGreaterThanOrEqual(CENTER_MIN);
  });

  it('hides rightbar when explicitly closed', () => {
    const closed = computeColumns({
      viewportWidth: 1440,
      rightbarOpen: false,
    });

    expect(closed.rightbar).toBe(0);
    expect(closed.rightbarVisible).toBe(false);
    expect(closed.center).toBe(1440 - SIDEBAR_DEFAULT);
  });
});
