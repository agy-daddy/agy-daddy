'use strict';

/**
 * Light DOM CSS injected via ctx.styles.inject to toggle between Enhanced and Native sidebar views
 * without removing native DOM nodes.
 */
const HOST_TOGGLE_CSS = `
[data-agy-sidebar-mode="enhanced"] > *:not(#agy-sidebar-enhanced-root):not([data-agy-keep-native-header="1"]) {
  display: none !important;
}
#agy-sidebar-enhanced-root {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
}
#agy-sidebar-enhanced-root[hidden] {
  display: none !important;
}
`;

/**
 * Shadow DOM stylesheet aligned with Antigravity native sidebar tokens & flat chrome
 * (no purple accent overrides, proper topbar/traffic-light inset, hover-revealed row actions).
 */
const SHADOW_CSS = `
:host {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  font-family: var(--ag-font-sans, system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif);
  font-size: 13px;
  line-height: 1.4;
  color: var(--sidebar-foreground, var(--foreground, var(--ag-text-primary, currentColor)));
  background: transparent;
  box-sizing: border-box;
}

* {
  box-sizing: border-box;
}

.agy-sb-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding-top: var(--agy-sb-top-inset, 40px);
  overflow: hidden;
}

.agy-sb-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 8px 6px;
  flex-shrink: 0;
}

.agy-sb-top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-height: 26px;
}

.agy-sb-mode-pill {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border-radius: 6px;
  background: var(--sidebar-muted, rgba(128, 128, 128, 0.08));
}

.agy-sb-mode-btn {
  border: none;
  background: transparent;
  color: var(--muted-foreground, var(--ag-text-muted, #8e8e98));
  font-size: 11px;
  font-weight: 400;
  padding: 2px 7px;
  border-radius: 4px;
  cursor: pointer;
  line-height: 1.35;
  transition: background-color 120ms ease, color 120ms ease;
}

.agy-sb-mode-btn:hover {
  color: var(--sidebar-foreground, var(--foreground, currentColor));
}

.agy-sb-mode-btn[data-active="true"] {
  background: var(--sidebar-secondary, rgba(128, 128, 128, 0.16));
  color: var(--sidebar-foreground, var(--foreground, currentColor));
  font-weight: 500;
}

.agy-sb-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
}

.agy-sb-btn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted-foreground, var(--ag-text-muted, #8e8e98));
  border-radius: 6px;
  padding: 3px 7px;
  font-size: 11px;
  font-weight: 400;
  cursor: pointer;
  line-height: 1.3;
  transition: background-color 120ms ease, color 120ms ease;
}

.agy-sb-btn:hover:not(:disabled) {
  background: var(--sidebar-muted, rgba(128, 128, 128, 0.1));
  color: var(--sidebar-foreground, var(--foreground, currentColor));
}

.agy-sb-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.agy-sb-btn-danger {
  color: var(--ag-ring-danger, #ef4444);
}

.agy-sb-btn-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.12);
  color: var(--ag-ring-danger, #ef4444);
}

.agy-sb-search {
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: var(--sidebar-muted, rgba(128, 128, 128, 0.08));
  color: var(--sidebar-foreground, var(--foreground, currentColor));
  font-size: 12px;
  line-height: 1.35;
  outline: none;
  transition: background-color 120ms ease, border-color 120ms ease;
}

.agy-sb-search::placeholder {
  color: var(--muted-foreground, var(--ag-text-muted, #8e8e98));
}

.agy-sb-search:focus {
  border-color: var(--border, rgba(128, 128, 128, 0.24));
  background: var(--sidebar-secondary, rgba(128, 128, 128, 0.12));
}

.agy-sb-banner {
  margin: 4px 8px 0;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.18));
  background: var(--sidebar-muted, rgba(128, 128, 128, 0.08));
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
}

.agy-sb-banner[data-tone="warn"] {
  border-color: rgba(245, 158, 11, 0.4);
  background: rgba(245, 158, 11, 0.08);
}

.agy-sb-banner[data-tone="error"] {
  border-color: rgba(239, 68, 68, 0.4);
  background: rgba(239, 68, 68, 0.08);
}

.agy-sb-banner-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.agy-sb-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 2px 8px 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agy-sb-section-title {
  font-size: 11px;
  font-weight: 500;
  color: var(--muted-foreground, var(--ag-text-muted, #8e8e98));
  padding: 8px 6px 2px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.agy-sb-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
  position: relative;
  border: 1px solid transparent;
  color: var(--sidebar-foreground, var(--foreground, currentColor));
  transition: background-color 120ms ease, color 120ms ease;
}

.agy-sb-row:hover {
  background: var(--sidebar-muted, rgba(128, 128, 128, 0.09));
}

.agy-sb-row[data-active="true"] {
  background: var(--sidebar-secondary, rgba(128, 128, 128, 0.16));
  font-weight: 500;
}

.agy-sb-row[data-dragging="true"] {
  opacity: 0.55;
  border-style: dashed;
  border-color: var(--border, rgba(128, 128, 128, 0.35));
}

.agy-sb-row[data-drop-position="before"]::before,
.agy-sb-row[data-drop-position="after"]::after {
  content: "";
  position: absolute;
  left: 6px;
  right: 6px;
  height: 2px;
  border-radius: 1px;
  background: var(--foreground, currentColor);
  opacity: 0.7;
}

.agy-sb-row[data-drop-position="before"]::before {
  top: -1px;
}

.agy-sb-row[data-drop-position="after"]::after {
  bottom: -1px;
}

.agy-sb-row[data-drop-position="inside"] {
  border-color: var(--border, rgba(128, 128, 128, 0.35));
  background: var(--sidebar-secondary, rgba(128, 128, 128, 0.14));
}

.agy-sb-indent-1 {
  padding-left: 16px;
}

.agy-sb-indent-2 {
  padding-left: 26px;
}

.agy-sb-indent-3 {
  padding-left: 36px;
}

.agy-sb-handle {
  border: none;
  background: transparent;
  color: var(--muted-foreground, var(--ag-text-muted, #8e8e98));
  cursor: grab;
  width: 0;
  padding: 0;
  opacity: 0;
  overflow: hidden;
  font-size: 11px;
  line-height: 1;
  flex-shrink: 0;
  transition: width 120ms ease, opacity 120ms ease;
}

.agy-sb-row:hover .agy-sb-handle,
.agy-sb-row:focus-within .agy-sb-handle {
  width: 12px;
  padding: 2px 1px;
  opacity: 0.65;
}

.agy-sb-caret {
  width: 14px;
  text-align: center;
  font-size: 11px;
  color: var(--muted-foreground, var(--ag-text-muted, #8e8e98));
  flex-shrink: 0;
}

.agy-sb-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agy-sb-subpath {
  font-size: 11px;
  color: var(--muted-foreground, var(--ag-text-muted, #8e8e98));
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agy-sb-count {
  font-size: 11px;
  color: var(--muted-foreground, var(--ag-text-muted, #8e8e98));
  padding: 0 2px;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.agy-sb-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.2));
  color: var(--muted-foreground, var(--ag-text-muted, #8e8e98));
  flex-shrink: 0;
}

.agy-sb-badge[data-tone="warn"] {
  border-color: rgba(245, 158, 11, 0.4);
  color: #f59e0b;
}

.agy-sb-badge[data-tone="danger"] {
  border-color: rgba(239, 68, 68, 0.4);
  color: #ef4444;
}

.agy-sb-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--foreground, currentColor);
  opacity: 0.75;
  flex-shrink: 0;
}

.agy-sb-icon-btn {
  border: none;
  background: transparent;
  color: var(--muted-foreground, var(--ag-text-muted, #8e8e98));
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1;
  opacity: 0;
  transition: opacity 120ms ease, background-color 120ms ease, color 120ms ease;
}

.agy-sb-row:hover .agy-sb-icon-btn,
.agy-sb-row:focus-within .agy-sb-icon-btn,
.agy-sb-icon-btn:focus-visible {
  opacity: 1;
}

.agy-sb-icon-btn:hover:not(:disabled) {
  background: var(--sidebar-secondary, rgba(128, 128, 128, 0.16));
  color: var(--sidebar-foreground, var(--foreground, currentColor));
}

.agy-sb-icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.agy-sb-drop-slot {
  min-height: 24px;
  border: 1px dashed transparent;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 2px 8px 2px 26px;
  color: var(--muted-foreground, var(--ag-text-muted, #8e8e98));
  opacity: 0.65;
  font-size: 11px;
  margin: 0;
}

.agy-sb-shell[data-dragging-active="true"] .agy-sb-drop-slot,
.agy-sb-drop-slot[data-slot="ungrouped"] {
  min-height: 36px;
  justify-content: center;
  padding: 4px 8px;
  border-color: var(--border, rgba(128, 128, 128, 0.3));
  opacity: 1;
  margin: 4px 0;
}

.agy-sb-drop-slot[data-slot="ungrouped"] {
  min-height: 44px;
}

.agy-sb-menu {
  margin: 2px 8px 6px 24px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(128, 128, 128, 0.2));
  background: var(--popover, var(--ag-bg-card, #1c1c1e));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agy-sb-menu-item {
  border: none;
  background: transparent;
  color: var(--sidebar-foreground, var(--foreground, currentColor));
  text-align: left;
  padding: 5px 8px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
}

.agy-sb-menu-item:hover:not(:disabled) {
  background: var(--sidebar-muted, rgba(128, 128, 128, 0.12));
}

.agy-sb-menu-item:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.agy-sidebar-shortcut-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--sidebar-secondary, rgba(128, 128, 128, 0.16));
  border: 1px solid var(--border, rgba(128, 128, 128, 0.24));
  color: var(--sidebar-foreground, var(--foreground, currentColor));
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
}
`;

module.exports = {
  HOST_TOGGLE_CSS,
  SHADOW_CSS
};
