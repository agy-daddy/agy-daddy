'use strict';

/**
 * Shadow DOM isolated stylesheets for @agy-daddy/plugin-viewer.
 * Uses Antigravity host CSS variables with strictly compliant semantic colors.
 */

const VIEWER_HEADER_STYLES = `
:host {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 6px;
  flex-shrink: 0;
  font-family: var(--ag-font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 11px;
  color: var(--ag-text-primary, #e4e4e7);
  box-sizing: border-box;
}
* {
  box-sizing: border-box;
}
.agy-v-capsule {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.agy-v-pill-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  border: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.22));
  background: var(--ag-bg-subcard, rgba(161, 161, 170, 0.1));
  color: var(--ag-text-secondary, #a1a1aa);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
}
.agy-v-pill-btn:hover {
  border-color: var(--ag-accent-border-hover, rgba(161, 161, 170, 0.4));
  background: var(--ag-accent-bg-hover, rgba(161, 161, 170, 0.16));
  color: var(--ag-text-primary, #e4e4e7);
}
.agy-v-pill-btn[data-active="true"] {
  border-color: var(--ag-effective-accent, #a1a1aa);
  background: var(--ag-accent-bg, rgba(255, 255, 255, 0.12));
  color: var(--ag-text-primary, #f4f4f5);
  font-weight: 600;
}
.agy-v-stat-add {
  color: #16a34a;
  font-weight: 600;
}
.agy-v-stat-del {
  color: #dc2626;
  font-weight: 600;
}
`;

const VIEWER_STAGE_STYLES = `
:host {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  flex: 1 1 auto;
  overflow: hidden;
  font-family: var(--ag-font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 12px;
  color: var(--ag-text-primary, #e4e4e7);
  background: var(--ag-bg-panel, #101010);
  box-sizing: border-box;
}
* {
  box-sizing: border-box;
}
.agy-v-stage-root {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  outline: none;
  position: relative;
}
.agy-v-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.16));
  background: var(--ag-bg-card, #191919);
  flex-shrink: 0;
}
.agy-v-toolbar-spacer {
  flex: 1 1 auto;
}
.agy-v-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border-radius: 5px;
  border: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.22));
  background: var(--ag-bg-subcard, rgba(161, 161, 170, 0.08));
  color: var(--ag-text-primary, #e4e4e7);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.agy-v-btn:hover:not(:disabled) {
  background: var(--ag-accent-bg-hover, rgba(161, 161, 170, 0.16));
  border-color: var(--ag-accent-border-hover, rgba(161, 161, 170, 0.36));
}
.agy-v-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.agy-v-btn[data-active="true"] {
  border-color: var(--ag-effective-accent, #a1a1aa);
  background: var(--ag-accent-bg, rgba(255, 255, 255, 0.14));
  font-weight: 600;
}
.agy-v-input,
.agy-v-select {
  height: 24px;
  padding: 0 8px;
  border-radius: 5px;
  border: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.22));
  background: var(--ag-bg-input, rgba(255, 255, 255, 0.06));
  color: var(--ag-text-primary, #e4e4e7);
  font-size: 11px;
  outline: none;
}
.agy-v-input:focus,
.agy-v-select:focus {
  border-color: var(--ag-effective-accent, #a1a1aa);
}
.agy-v-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  border: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.2));
  background: var(--ag-bg-subcard, rgba(161, 161, 170, 0.08));
  color: var(--ag-text-secondary, #a1a1aa);
}
.agy-v-banner-warn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  font-size: 11px;
  background: rgba(245, 158, 11, 0.14);
  border-bottom: 1px solid var(--ag-ring-warn, #f59e0b);
  color: var(--ag-text-primary, #e4e4e7);
  flex-shrink: 0;
}
.agy-v-card-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 10px;
  padding: 24px 16px;
  margin: auto;
  max-width: 420px;
}
.agy-v-card {
  width: 100%;
  padding: 16px;
  border-radius: 8px;
  border: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.2));
  background: var(--ag-bg-card, #191919);
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.agy-v-card-danger {
  background: rgba(239, 68, 68, 0.14);
  border-color: var(--ag-ring-danger, #ef4444);
}
.agy-v-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ag-text-primary, #e4e4e7);
}
.agy-v-card-desc {
  font-size: 11px;
  color: var(--ag-text-secondary, #a1a1aa);
  line-height: 1.5;
}
.agy-v-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

/* Media Viewer */
.agy-v-media-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  gap: 10px;
}
.agy-v-media-video-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  background: #09090b;
  border-radius: 6px;
  border: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.16));
  overflow: hidden;
  min-height: 160px;
  max-height: 360px;
}
.agy-v-media-el {
  max-width: 100%;
  max-height: 360px;
  width: 100%;
  outline: none;
}
.agy-v-waveform-wrap {
  position: relative;
  height: 64px;
  border-radius: 6px;
  border: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.18));
  background: var(--ag-bg-card, #191919);
  cursor: pointer;
  overflow: hidden;
  flex-shrink: 0;
}
.agy-v-waveform-canvas {
  width: 100%;
  height: 100%;
  display: block;
}
.agy-v-marker-pin {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--ag-effective-accent, #e4e4e7);
  cursor: pointer;
}
.agy-v-marker-pin[data-tone="warn"] {
  background: var(--ag-ring-warn, #f59e0b);
}
.agy-v-marker-pin[data-tone="danger"] {
  background: var(--ag-ring-danger, #ef4444);
}
.agy-v-marker-pin[data-tone="info"] {
  background: #16a34a;
}
.agy-v-markers-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.16));
  border-radius: 6px;
  padding: 8px;
  background: var(--ag-bg-card, #191919);
}
.agy-v-marker-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  background: var(--ag-bg-subcard, rgba(255, 255, 255, 0.04));
}

/* CSV Viewer */
.agy-v-csv-viewport {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  position: relative;
  background: var(--ag-bg-panel, #101010);
}
.agy-v-csv-spacer {
  position: relative;
  width: max-content;
  min-width: 100%;
}
.agy-v-csv-table {
  border-collapse: collapse;
  font-family: var(--ag-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  width: max-content;
  min-width: 100%;
}
.agy-v-csv-thead {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--ag-bg-card, #191919);
}
.agy-v-csv-th,
.agy-v-csv-td {
  height: 28px;
  max-height: 28px;
  padding: 0 8px;
  border-bottom: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.14));
  border-right: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.1));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 240px;
  text-align: left;
  cursor: pointer;
}
.agy-v-csv-th {
  font-weight: 600;
  color: var(--ag-text-primary, #e4e4e7);
}
.agy-v-csv-rownum {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--ag-bg-card, #191919);
  color: var(--ag-text-muted, #91919a);
  width: 56px;
  min-width: 56px;
  text-align: right;
}
.agy-v-csv-thead .agy-v-csv-rownum {
  z-index: 4;
}
.agy-v-csv-mark {
  background: rgba(245, 158, 11, 0.35);
  color: inherit;
  border-radius: 2px;
}
.agy-v-popover {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: min(440px, calc(100% - 24px));
  max-height: 55%;
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  border: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.28));
  background: var(--ag-bg-card, #191919);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  z-index: 10;
  overflow: hidden;
}
.agy-v-popover-body {
  padding: 10px;
  overflow: auto;
  font-family: var(--ag-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
}

/* SVG Viewer */
.agy-v-svg-canvas {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  user-select: none;
}
.agy-v-svg-canvas:active {
  cursor: grabbing;
}
.agy-v-svg-canvas[data-bg="checkerboard"] {
  background-color: #1c1c1f;
  background-image:
    linear-gradient(45deg, rgba(255, 255, 255, 0.06) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(255, 255, 255, 0.06) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(255, 255, 255, 0.06) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(255, 255, 255, 0.06) 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
.agy-v-svg-canvas[data-bg="light"] {
  background: #ffffff;
}
.agy-v-svg-canvas[data-bg="dark"] {
  background: #18181b;
}
.agy-v-svg-img {
  display: block;
  pointer-events: none;
  max-width: none;
  max-height: none;
  transform-origin: center center;
}
.agy-v-source-pre {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 12px;
  font-family: var(--ag-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre;
}

/* Font Viewer */
.agy-v-font-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.agy-v-font-body[data-backdrop="light"] {
  background: #ffffff;
  color: #18181b;
}
.agy-v-font-body[data-backdrop="dark"] {
  background: #101010;
  color: #f4f4f5;
}
.agy-v-font-waterfall {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.agy-v-font-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(161, 161, 170, 0.16);
}
.agy-v-font-size-tag {
  font-size: 10px;
  opacity: 0.65;
  font-family: var(--ag-font-mono, ui-monospace, monospace);
}
.agy-v-glyph-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(36px, 1fr));
  gap: 4px;
}
.agy-v-glyph-cell {
  border: 1px solid rgba(161, 161, 170, 0.22);
  border-radius: 4px;
  padding: 6px 2px;
  text-align: center;
  font-size: 18px;
}

/* Git Diff Viewer */
.agy-v-diff-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  font-family: var(--ag-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  line-height: 1.5;
}
.agy-v-hunk-bar {
  padding: 4px 10px;
  background: var(--ag-bg-subcard, rgba(161, 161, 170, 0.08));
  border-top: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.16));
  border-bottom: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.16));
  color: var(--ag-text-secondary, #a1a1aa);
  font-size: 11px;
}
.agy-v-diff-expand {
  width: 100%;
  border: none;
  border-bottom: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.14));
  background: var(--ag-bg-subcard, rgba(161, 161, 170, 0.05));
  color: var(--ag-text-secondary, #a1a1aa);
  padding: 3px 10px;
  text-align: left;
  font-size: 11px;
  cursor: pointer;
}
.agy-v-diff-expand:hover {
  color: var(--ag-text-primary, #e4e4e7);
  background: var(--ag-accent-bg, rgba(255, 255, 255, 0.08));
}
.agy-v-diff-line {
  display: grid;
  grid-template-columns: 42px 42px 18px 1fr;
  align-items: start;
  padding: 0 8px 0 0;
  border-left: 3px solid transparent;
  white-space: pre-wrap;
  word-break: break-all;
}
.agy-v-diff-line[data-type="add"] {
  background: rgba(34, 197, 94, 0.12);
  border-left-color: #16a34a;
}
.agy-v-diff-line[data-type="del"] {
  background: rgba(239, 68, 68, 0.12);
  border-left-color: #dc2626;
}
.agy-v-diff-split-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  border-bottom: 1px solid rgba(161, 161, 170, 0.08);
}
.agy-v-diff-split-cell {
  display: grid;
  grid-template-columns: 40px 16px 1fr;
  border-left: 3px solid transparent;
  border-right: 1px solid rgba(161, 161, 170, 0.12);
  white-space: pre-wrap;
  word-break: break-all;
}
.agy-v-diff-split-cell[data-type="add"] {
  background: rgba(34, 197, 94, 0.12);
  border-left-color: #16a34a;
}
.agy-v-diff-split-cell[data-type="del"] {
  background: rgba(239, 68, 68, 0.12);
  border-left-color: #dc2626;
}
.agy-v-ln {
  color: var(--ag-text-muted, #91919a);
  text-align: right;
  padding-right: 6px;
  user-select: none;
}
.agy-v-sigil {
  text-align: center;
  user-select: none;
  opacity: 0.8;
}
.agy-v-word-add {
  background: rgba(34, 197, 94, 0.28);
  border-radius: 2px;
}
.agy-v-word-del {
  background: rgba(239, 68, 68, 0.28);
  border-radius: 2px;
}
.agy-v-drawer-list {
  max-height: 210px;
  overflow-y: auto;
  border-bottom: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.18));
  background: var(--ag-bg-card, #191919);
  flex-shrink: 0;
}
.agy-v-drawer-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  border-bottom: 1px solid rgba(161, 161, 170, 0.1);
  background: transparent;
  color: var(--ag-text-primary, #e4e4e7);
  padding: 6px 10px;
  text-align: left;
  font-size: 11px;
  cursor: pointer;
}
.agy-v-drawer-item:hover,
.agy-v-drawer-item[data-selected="true"] {
  background: var(--ag-accent-bg, rgba(255, 255, 255, 0.08));
}
.agy-v-status-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 700;
  border: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.24));
  flex-shrink: 0;
}
`;

const VIEWER_DRAWER_STYLES = `
:host {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 260px;
  flex: 1 1 auto;
  overflow: hidden;
  border-top: 1px solid var(--ag-border-card, rgba(161, 161, 170, 0.2));
  background: var(--ag-bg-panel, #101010);
  color: var(--ag-text-primary, #e4e4e7);
  font-family: var(--ag-font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
  font-size: 12px;
  box-sizing: border-box;
}
` + VIEWER_STAGE_STYLES;

module.exports = {
  VIEWER_HEADER_STYLES,
  VIEWER_STAGE_STYLES,
  VIEWER_DRAWER_STYLES
};
