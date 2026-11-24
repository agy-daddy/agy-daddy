export const SIDEBAR_MIN = 264;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 268;
export const SIDEBAR_COLLAPSED = 56;
export const SIDEBAR_AUTO_COLLAPSE = 1024;
export const CENTER_MIN = 400;
export const RIGHTBAR_MIN = 300;
export const RIGHTBAR_MAX_RATIO = 0.7;
export const RIGHTBAR_DEFAULT_RATIO = 0.28;

export interface ColumnInputs {
  viewportWidth: number;
  sidebarWidth?: number;
  sidebarCollapsed?: boolean;
  sidebarManualExpand?: boolean;
  rightbarWidth?: number;
  rightbarOpen?: boolean;
}

export interface ColumnLayout {
  sidebar: number;
  center: number;
  rightbar: number;
  sidebarCollapsed: boolean;
  rightbarVisible: boolean;
  rightbarMax: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT;
  return Math.round(clamp(width, SIDEBAR_MIN, SIDEBAR_MAX));
}

/**
 * Pure three-column layout geometry solver.
 * Computes sidebar first (auto-collapsing below 1024px unless manually expanded),
 * then protects center >= 400px by hiding rightbar when available width < 300px.
 */
export function computeColumns(inputs: ColumnInputs): ColumnLayout {
  const viewportWidth = Math.max(0, Math.round(inputs.viewportWidth || 0));
  const autoCollapse = viewportWidth < SIDEBAR_AUTO_COLLAPSE && !inputs.sidebarManualExpand;
  const sidebarCollapsed = inputs.sidebarCollapsed === true || autoCollapse;

  const sidebar = sidebarCollapsed
    ? SIDEBAR_COLLAPSED
    : clampSidebarWidth(inputs.sidebarWidth ?? SIDEBAR_DEFAULT);

  const availableForRight = viewportWidth - sidebar - CENTER_MIN;
  const maxByRatio = Math.floor(viewportWidth * RIGHTBAR_MAX_RATIO);
  const rightbarMax = Math.max(0, Math.min(availableForRight, maxByRatio));

  const wantsRightbar = inputs.rightbarOpen !== false;
  const canShowRightbar =
    wantsRightbar &&
    availableForRight >= RIGHTBAR_MIN &&
    rightbarMax >= RIGHTBAR_MIN;

  let rightbar = 0;
  if (canShowRightbar) {
    const desired = inputs.rightbarWidth ?? Math.round(viewportWidth * RIGHTBAR_DEFAULT_RATIO);
    rightbar = Math.round(clamp(desired, RIGHTBAR_MIN, rightbarMax));
  }

  const center = Math.max(0, viewportWidth - sidebar - rightbar);

  return {
    sidebar,
    center,
    rightbar,
    sidebarCollapsed,
    rightbarVisible: rightbar > 0,
    rightbarMax,
  };
}
