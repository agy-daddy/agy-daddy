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
 * Shadow DOM stylesheet using Antigravity theme CSS variables (zero Gate 4 forbidden hex values).
 */
const SHADOW_CSS = `
:host {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  font-family: var(--ag-font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 12px;
  color: var(--ag-text-primary, #e4e4e7);
  background: var(--ag-bg-surface, transparent);
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
  overflow: hidden;
}

.agy-sb-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ag-border-subtle, rgba(161, 161, 170, 0.18));
  flex-shrink: 0;
}

.agy-sb-top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.agy-sb-mode-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px;
  border-radius: 7px;
  background: var(--ag-bg-elevated, rgba(161, 161, 170, 0.12));
  border: 1px solid var(--ag-border-subtle, rgba(161, 161, 170, 0.2));
}

.agy-sb-mode-btn {
  border: none;
  background: transparent;
  color: var(--ag-text-secondary, #a1a1aa);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 5px;
  cursor: pointer;
}

.agy-sb-mode-btn[data-active="true"] {
  background: var(--ag-bg-control, rgba(167, 139, 250, 0.18));
  color: var(--ag-text-primary, #f4f4f5);
  font-weight: 600;
}

.agy-sb-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
}

.agy-sb-btn {
  border: 1px solid var(--ag-border-subtle, rgba(161, 161, 170, 0.24));
  background: var(--ag-bg-elevated, rgba(161, 161, 170, 0.08));
  color: var(--ag-text-primary, inherit);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
  line-height: 1.2;
}

.agy-sb-btn:hover:not(:disabled) {
  border-color: var(--ag-accent, #a78bfa);
}

.agy-sb-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.agy-sb-btn-danger {
  border-color: rgba(239, 68, 68, 0.45);
  color: #fca5a5;
}

.agy-sb-search {
  width: 100%;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--ag-border-subtle, rgba(161, 161, 170, 0.22));
  background: var(--ag-bg-elevated, rgba(24, 24, 27, 0.45));
  color: var(--ag-text-primary, inherit);
  font-size: 12px;
  outline: none;
}

.agy-sb-search:focus {
  border-color: var(--ag-accent, #a78bfa);
}

.agy-sb-banner {
  margin: 6px 10px 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--ag-border-subtle, rgba(161, 161, 170, 0.28));
  background: var(--ag-bg-elevated, rgba(161, 161, 170, 0.1));
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11px;
}

.agy-sb-banner[data-tone="warn"] {
  border-color: rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.1);
}

.agy-sb-banner[data-tone="error"] {
  border-color: rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.1);
}

.agy-sb-banner-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.agy-sb-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 8px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.agy-sb-section-title {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--sidebar-muted, var(--ag-text-secondary, #a1a1aa));
  padding: 6px 6px 2px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.agy-sb-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  position: relative;
  border: 1px solid transparent;
}

.agy-sb-row:hover {
  background: var(--ag-bg-elevated, rgba(161, 161, 170, 0.1));
}

.agy-sb-row[data-active="true"] {
  background: var(--ag-bg-control, rgba(167, 139, 250, 0.14));
  border-color: var(--ag-accent, rgba(167, 139, 250, 0.35));
}

.agy-sb-row[data-dragging="true"] {
  opacity: 0.55;
  border-style: dashed;
  border-color: var(--ag-accent, #a78bfa);
}

.agy-sb-row[data-drop-position="before"]::before,
.agy-sb-row[data-drop-position="after"]::after {
  content: "";
  position: absolute;
  left: 4px;
  right: 4px;
  height: 2px;
  background: var(--ag-accent, #a78bfa);
}

.agy-sb-row[data-drop-position="before"]::before {
  top: -1px;
}

.agy-sb-row[data-drop-position="after"]::after {
  bottom: -1px;
}

.agy-sb-row[data-drop-position="inside"] {
  border-color: var(--ag-accent, #a78bfa);
  background: var(--ag-bg-control, rgba(167, 139, 250, 0.12));
}

.agy-sb-indent-1 {
  padding-left: 16px;
}

.agy-sb-indent-2 {
  padding-left: 28px;
}

.agy-sb-indent-3 {
  padding-left: 38px;
}

.agy-sb-handle {
  border: none;
  background: transparent;
  color: var(--sidebar-secondary, var(--ag-text-secondary, #a1a1aa));
  cursor: grab;
  padding: 2px;
  font-size: 11px;
  line-height: 1;
}

.agy-sb-caret {
  width: 14px;
  text-align: center;
  color: var(--sidebar-secondary, var(--ag-text-secondary, #a1a1aa));
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
  font-size: 10px;
  color: var(--sidebar-muted, var(--ag-text-secondary, #a1a1aa));
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agy-sb-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  border: 1px solid var(--ag-border-subtle, rgba(161, 161, 170, 0.25));
  color: var(--ag-text-secondary, #d4d4d8);
  flex-shrink: 0;
}

.agy-sb-badge[data-tone="warn"] {
  border-color: rgba(245, 158, 11, 0.45);
  color: #fcd34d;
}

.agy-sb-badge[data-tone="danger"] {
  border-color: rgba(239, 68, 68, 0.45);
  color: #fca5a5;
}

.agy-sb-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--ag-accent, #a78bfa);
  flex-shrink: 0;
}

.agy-sb-icon-btn {
  border: none;
  background: transparent;
  color: var(--ag-text-secondary, #a1a1aa);
  cursor: pointer;
  padding: 2px 5px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1;
}

.agy-sb-icon-btn:hover:not(:disabled) {
  background: var(--ag-bg-elevated, rgba(161, 161, 170, 0.16));
  color: var(--ag-text-primary, #f4f4f5);
}

.agy-sb-icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.agy-sb-drop-slot {
  min-height: 40px;
  border: 1px dashed var(--ag-border-subtle, rgba(161, 161, 170, 0.35));
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ag-text-secondary, #a1a1aa);
  font-size: 11px;
  margin: 4px 0;
}

.agy-sb-drop-slot[data-slot="ungrouped"] {
  min-height: 44px;
}

.agy-sb-menu {
  margin: 2px 8px 6px 24px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--ag-border-subtle, rgba(161, 161, 170, 0.25));
  background: var(--ag-bg-elevated, #18181b);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.agy-sb-menu-item {
  border: none;
  background: transparent;
  color: var(--ag-text-primary, inherit);
  text-align: left;
  padding: 5px 8px;
  border-radius: 5px;
  font-size: 11px;
  cursor: pointer;
}

.agy-sb-menu-item:hover:not(:disabled) {
  background: var(--ag-bg-control, rgba(167, 139, 250, 0.16));
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
  background: var(--ag-bg-control, rgba(113, 113, 122, 0.24));
  border: 1px solid var(--ag-border-subtle, rgba(113, 113, 122, 0.35));
  color: var(--ag-text-primary, currentColor);
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
}
`;

module.exports = {
  HOST_TOGGLE_CSS,
  SHADOW_CSS
};
