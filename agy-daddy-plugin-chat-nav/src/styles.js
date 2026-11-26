'use strict';

const CHAT_NAV_STYLES = `
/* Agy-Daddy Chat Navigation & Inline File Editor Styles (auto-follows host --ag-* theme tokens) */

#agy-chat-nav-float {
  position: fixed;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 5px 4px;
  border-radius: 11px;
  background: var(--ag-bg-panel, #ffffff);
  border: 1px solid var(--ag-border-panel, rgba(15, 23, 42, 0.12));
  box-shadow: var(--ag-shadow-panel, 0 8px 24px rgba(15, 23, 42, 0.12), 0 1px 4px rgba(15, 23, 42, 0.06));
  backdrop-filter: blur(12px);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
}

#agy-chat-nav-float[data-under-dialog="true"] {
  z-index: 1;
}

#agy-chat-nav-float > button,
#agy-chat-nav-extra > button {
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--ag-text-secondary, #3f3f46);
  cursor: pointer;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

#agy-chat-nav-float > button svg,
#agy-chat-nav-extra > button svg {
  display: block;
  flex-shrink: 0;
  pointer-events: none;
}

#agy-chat-nav-float > button:hover,
#agy-chat-nav-extra > button:hover,
#agy-nav-think[data-active="true"],
#agy-nav-search-toggle[data-active="true"],
#agy-nav-copy-id[data-active="true"],
#agy-nav-export-md[data-active="true"] {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.14));
  color: var(--ag-text-primary, #18181b);
}

#agy-chat-nav-float > button:disabled,
#agy-nav-export-md[data-loading="true"] {
  opacity: 0.55;
  cursor: wait;
}

#agy-export-format-menu {
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 124px;
  padding: 6px;
  border-radius: 10px;
  background: var(--ag-bg-panel, #ffffff);
  border: 1px solid var(--ag-border-panel, rgba(15, 23, 42, 0.12));
  box-shadow: var(--ag-shadow-panel, 0 10px 26px rgba(15, 23, 42, 0.14));
  z-index: 15;
}

#agy-export-format-menu[hidden] {
  display: none !important;
}

.agy-export-format-title {
  padding: 2px 6px 4px 6px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--ag-text-muted, #71717a);
  white-space: nowrap;
}

#agy-export-format-menu button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 9px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--ag-text-primary, #18181b);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  text-align: left;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

#agy-export-format-menu button:hover {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.14));
}

#agy-export-format-menu button:focus-visible {
  outline: 2px solid var(--ag-focus-ring, rgba(113, 113, 122, 0.45));
  outline-offset: 1px;
}

.agy-export-format-ext {
  font-size: 10.5px;
  color: var(--ag-text-muted, #71717a);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.agy-export-format-divider {
  height: 1px;
  margin: 3px 4px;
  background: var(--ag-border-panel, rgba(15, 23, 42, 0.10));
}

#agy-export-format-menu button.agy-export-format-all {
  background: var(--ag-bg-control, rgba(15, 23, 42, 0.055));
  font-weight: 600;
}

#agy-export-format-menu button.agy-export-format-all:hover {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.16));
}

#agy-chat-nav-toast {
  position: absolute;
  right: calc(100% + 8px);
  top: 50%;
  transform: translateY(-50%);
  padding: 5px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  line-height: 1.35;
  white-space: nowrap;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  background: var(--ag-bg-panel, #ffffff);
  border: 1px solid var(--ag-border-panel, rgba(15, 23, 42, 0.12));
  box-shadow: var(--ag-shadow-panel, 0 8px 24px rgba(15, 23, 42, 0.12));
  color: var(--ag-text-primary, #18181b);
  pointer-events: none;
  z-index: 10;
}

#agy-chat-nav-toast[data-tone="error"] {
  color: var(--ag-ring-danger, #ef4444);
  border-color: rgba(239, 68, 68, 0.45);
}

#agy-chat-nav-toast[hidden] {
  display: none !important;
}

#agy-chat-nav-float > button:focus-visible,
#agy-chat-nav-extra > button:focus-visible {
  outline: 2px solid var(--ag-focus-ring, rgba(113, 113, 122, 0.45));
  outline-offset: 1px;
}

#agy-chat-nav-extra {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}

#agy-chat-nav-extra:empty {
  display: none;
}

#agy-chat-search-slot.agy-search-collapsed {
  position: absolute;
  right: calc(100% + 8px);
  bottom: 0;
  opacity: 0;
  pointer-events: none;
  transform: translateX(6px);
  transition: opacity 0.16s ease, transform 0.16s ease;
}

#agy-chat-search-slot.agy-search-open {
  position: absolute;
  right: calc(100% + 8px);
  bottom: 0;
  opacity: 1;
  pointer-events: auto;
  transform: translateX(0);
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.agy-conv-shortcut-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  margin-left: auto;
  background: var(--ag-bg-control, rgba(113, 113, 122, 0.14));
  color: var(--ag-text-primary, #18181b);
  border: 1px solid var(--ag-border-card, rgba(113, 113, 122, 0.24));
}

#agy-file-editor-controls {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 9px;
  margin-left: 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  background: var(--ag-bg-control, rgba(113, 113, 122, 0.10));
  border: none;
  color: var(--ag-text-primary, #18181b);
  cursor: pointer;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

#agy-file-editor-controls:hover {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.18));
}

#agy-file-editor-controls:focus-visible {
  outline: 2px solid var(--ag-focus-ring, rgba(113, 113, 122, 0.45));
  outline-offset: 2px;
}

#agy-inline-file-editor-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  margin: 8px;
  border-radius: 12px;
  background: var(--ag-bg-panel, #ffffff);
  border: 1px solid var(--ag-border-panel, rgba(15, 23, 42, 0.12));
  box-shadow: var(--ag-shadow-panel, 0 8px 24px rgba(15, 23, 42, 0.10));
}

#agy-inline-file-textarea {
  width: 100%;
  min-height: 220px;
  padding: 8px 10px;
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  background: var(--ag-bg-input, rgba(15, 23, 42, 0.04));
  border: 1px solid var(--ag-border-subcard, rgba(15, 23, 42, 0.10));
  color: var(--ag-text-primary, #18181b);
  outline: none;
  resize: vertical;
  box-sizing: border-box;
}

#agy-inline-file-textarea:focus {
  border-color: var(--ag-accent-border-hover, rgba(113, 113, 122, 0.48));
}

#agy-inline-file-save,
#agy-inline-file-done {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  background: var(--ag-bg-control, rgba(113, 113, 122, 0.10));
  border: none;
  color: var(--ag-text-primary, #18181b);
  cursor: pointer;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

#agy-inline-file-save {
  background: var(--ag-primary-bg, #18181b);
  color: var(--ag-primary-fg, #ffffff);
}

#agy-inline-file-save:hover {
  opacity: 0.88;
}

#agy-inline-file-done:hover {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.18));
}

#agy-chat-search-box {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  max-width: calc(var(--agy-chat-area-width, 100vw) - 56px);
  box-sizing: border-box;
  border-radius: 10px;
  background: var(--ag-bg-panel, #ffffff);
  border: 1px solid var(--ag-border-panel, rgba(15, 23, 42, 0.12));
  box-shadow: var(--ag-shadow-panel, 0 10px 26px rgba(15, 23, 42, 0.14));
  color: var(--ag-text-primary, #18181b);
  white-space: nowrap;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
}

#agy-chat-search-input {
  width: 152px;
  min-width: 96px;
  flex: 1 1 152px;
  height: 26px;
  padding: 0 9px;
  border-radius: 7px;
  font-size: 12px;
  background: var(--ag-bg-input, rgba(15, 23, 42, 0.04));
  border: 1px solid var(--ag-border-subcard, rgba(15, 23, 42, 0.10));
  color: var(--ag-text-primary, #18181b);
  outline: none;
}

#agy-chat-search-input:focus {
  border-color: var(--ag-accent-border-hover, rgba(113, 113, 122, 0.45));
}

#agy-chat-search-box button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 999px;
  border: none;
  background: var(--ag-bg-control, rgba(15, 23, 42, 0.055));
  color: var(--ag-text-secondary, #3f3f46);
  font-size: 11px;
  cursor: pointer;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

#agy-chat-search-box button:hover {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.16));
  color: var(--ag-text-primary, #18181b);
}

#agy-chat-search-box button:disabled {
  opacity: 0.38;
  cursor: default;
  pointer-events: none;
}

#agy-chat-search-box button:focus-visible {
  outline: 2px solid var(--ag-focus-ring, rgba(113, 113, 122, 0.45));
  outline-offset: 1px;
}

#agy-chat-search-count {
  font-size: 11px;
  color: var(--ag-text-muted, #71717a);
  min-width: 28px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

#agy-chat-search-count[data-empty="true"] {
  color: var(--ag-ring-danger, #ef4444);
}

::highlight(agy-search-hit) {
  background-color: rgba(250, 204, 21, 0.30);
  color: inherit;
}

::highlight(agy-search-active) {
  background-color: rgba(245, 158, 11, 0.78);
  color: #111827;
}

[data-agy-search-hit="hit"] {
  outline: 1px solid var(--ag-border-card, rgba(113, 113, 122, 0.34));
  background-color: var(--ag-bg-subcard, rgba(113, 113, 122, 0.08));
  border-radius: 6px;
}

[data-agy-search-hit="active"] {
  outline: 1.5px solid var(--ag-ring-warn, #f59e0b);
  outline-offset: 2px;
  background-color: rgba(245, 158, 11, 0.08);
  border-radius: 6px;
}

/* Sticky Code Block Headers & Smart Folding */
[data-agy-code-wrap="1"] {
  overflow: visible !important;
}

[data-agy-code-wrap="1"] > pre {
  overflow-x: auto;
}

.agy-code-header,
[data-agy-code-header="native"],
[data-agy-code-header="injected"] {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 30px;
  padding: 4px 10px;
  background: var(--ag-bg-card, #ffffff);
  border-bottom: 1px solid var(--ag-border-subcard, rgba(15, 23, 42, 0.09));
  backdrop-filter: blur(8px);
  color: var(--ag-text-secondary, #3f3f46);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
  font-size: 11.5px;
  box-sizing: border-box;
}

[data-agy-code-header="injected"] {
  border: 1px solid var(--ag-border-card, rgba(15, 23, 42, 0.10));
  border-bottom: 1px solid var(--ag-border-subcard, rgba(15, 23, 42, 0.09));
  border-top-left-radius: 8px;
  border-top-right-radius: 8px;
}

[data-agy-code-header="static"],
[data-agy-sticky-ended="true"] {
  position: relative;
  top: auto;
}

.agy-code-header[hidden],
.agy-code-fold-btn[hidden],
.agy-code-collapsed-bar[hidden] {
  display: none !important;
}

.agy-code-header-left,
.agy-code-header-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.agy-code-lang {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  font-weight: 600;
  color: var(--ag-text-primary, #18181b);
  text-transform: lowercase;
}

.agy-code-lines {
  font-size: 10.5px;
  color: var(--ag-text-muted, #71717a);
  font-variant-numeric: tabular-nums;
}

.agy-code-fold-btn,
.agy-code-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 7px;
  border-radius: 6px;
  border: none;
  background: var(--ag-bg-control, rgba(113, 113, 122, 0.10));
  color: var(--ag-text-secondary, #3f3f46);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

.agy-code-fold-btn:hover,
.agy-code-copy-btn:hover {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.18));
  color: var(--ag-text-primary, #18181b);
}

.agy-code-fold-btn:focus-visible,
.agy-code-copy-btn:focus-visible,
.agy-code-collapsed-bar:focus-visible {
  outline: 2px solid var(--ag-focus-ring, rgba(113, 113, 122, 0.45));
  outline-offset: 1px;
}

pre[data-agy-code-collapsed="true"] {
  max-height: 0 !important;
  min-height: 0 !important;
  height: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  margin-top: 0 !important;
  margin-bottom: 0 !important;
  overflow: hidden !important;
  border-top: none !important;
  border-bottom: none !important;
  opacity: 0;
  pointer-events: none;
}

.agy-code-collapsed-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 28px;
  padding: 0 12px;
  border: 1px dashed var(--ag-border-card, rgba(113, 113, 122, 0.24));
  border-bottom-left-radius: 8px;
  border-bottom-right-radius: 8px;
  background: var(--ag-bg-subcard, rgba(113, 113, 122, 0.05));
  color: var(--ag-text-muted, #71717a);
  font-size: 11.5px;
  cursor: pointer;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

.agy-code-collapsed-bar:hover {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.14));
  color: var(--ag-text-primary, #18181b);
}

/* Left Conversation Outline Rail & Hover Popover */
#agy-chat-outline-rail {
  position: fixed;
  left: 8px;
  top: 72px;
  width: 18px;
  min-height: 120px;
  z-index: 19;
  display: flex;
  align-items: stretch;
  justify-content: center;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
}

#agy-chat-outline-rail[data-native-rail="true"] {
  position: relative;
  left: auto;
  top: auto;
  height: 100%;
}

#agy-chat-outline-rail[data-under-dialog="true"] {
  z-index: 1;
}

#agy-chat-outline-rail[hidden],
#agy-chat-outline-popover[hidden] {
  display: none !important;
}

.agy-chat-outline-tracks {
  position: relative;
  width: 100%;
  height: 100%;
}

.agy-rail-tick {
  position: absolute;
  left: 2px;
  width: 10px;
  height: 3px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--ag-text-muted, rgba(113, 113, 122, 0.45));
  opacity: 0.52;
  cursor: pointer;
  transform: translateY(-50%);
  transition: width 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms cubic-bezier(0.22, 1, 0.36, 1), background-color 140ms ease;
}

.agy-rail-tick[data-key-question="true"] {
  width: 13px;
  background: var(--ag-ring-warn, #f59e0b);
  opacity: 0.72;
}

.agy-rail-tick:hover,
.agy-rail-tick[data-active="true"] {
  width: 16px;
  opacity: 1;
  background: var(--ag-text-primary, #18181b);
}

.agy-rail-tick[data-key-question="true"][data-active="true"] {
  background: var(--ag-ring-warn, #f59e0b);
}

#agy-chat-outline-popover {
  position: absolute;
  left: calc(100% + 8px);
  top: 0;
  width: 288px;
  max-height: min(460px, 72vh);
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border-radius: 12px;
  background: var(--ag-bg-panel, #ffffff);
  border: 1px solid var(--ag-border-panel, rgba(15, 23, 42, 0.12));
  box-shadow: var(--ag-shadow-panel, 0 12px 30px rgba(15, 23, 42, 0.16));
  backdrop-filter: blur(12px);
  color: var(--ag-text-primary, #18181b);
  z-index: 25;
  box-sizing: border-box;
}

.agy-outline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}

.agy-outline-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--ag-text-primary, #18181b);
}

.agy-outline-filters {
  display: flex;
  align-items: center;
  gap: 4px;
}

.agy-outline-filter-btn {
  height: 22px;
  padding: 0 8px;
  border-radius: 999px;
  border: 1px solid var(--ag-border-card, rgba(113, 113, 122, 0.2));
  background: transparent;
  color: var(--ag-text-secondary, #3f3f46);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 140ms ease, color 140ms ease;
}

.agy-outline-filter-btn[data-active="true"] {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.16));
  color: var(--ag-text-primary, #18181b);
  border-color: var(--ag-accent-border-hover, rgba(113, 113, 122, 0.35));
}

.agy-outline-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  max-height: 360px;
  padding-right: 2px;
}

.agy-outline-item,
.agy-outline-subheading {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 7px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--ag-text-primary, #18181b);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
  transition: background-color 120ms ease;
}

.agy-outline-item:hover,
.agy-outline-subheading:hover,
.agy-outline-item[data-active="true"] {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.14));
}

.agy-outline-idx {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--ag-text-muted, #71717a);
  font-variant-numeric: tabular-nums;
}

.agy-outline-item[data-key-question="true"] .agy-outline-idx {
  color: var(--ag-ring-warn, #f59e0b);
}

.agy-outline-text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agy-outline-code-tag {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--ag-bg-control, rgba(113, 113, 122, 0.12));
  color: var(--ag-text-muted, #71717a);
}

.agy-outline-subheading {
  padding-left: 22px;
  font-size: 11px;
  color: var(--ag-text-secondary, #3f3f46);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agy-outline-empty {
  padding: 14px 8px;
  text-align: center;
  font-size: 11.5px;
  color: var(--ag-text-muted, #71717a);
}
`.trim();

module.exports = {
  CHAT_NAV_STYLES
};
