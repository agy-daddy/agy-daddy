'use strict';

const COMPOSER_STYLES = `
/* Agy-Daddy Composer Quick Capsule Bar, Perception Hint & Above-Send Icon Optimizer (auto-follows host --ag-* theme tokens) */

@keyframes agy-opt-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

#agy-quick-capsule-bar {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  width: 100%;
  max-height: 36px;
  box-sizing: border-box;
  padding: 2px 2px 6px 2px;
  margin-top: 0;
  margin-bottom: 4px;
  border-top: none;
  background: transparent;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
  white-space: nowrap;
  user-select: none;
  -webkit-user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
}

#agy-quick-capsule-bar::-webkit-scrollbar {
  display: none;
}

#agy-quick-capsule-bar > button,
#agy-quick-capsule-bar > .agy-qcap-btn {
  flex-shrink: 0;
}

#agy-quick-capsule-bar button.agy-qcap-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px 0 8px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 1;
  background: var(--ag-accent-bg, rgba(161, 161, 170, 0.12));
  border: 1px solid var(--ag-accent-border, rgba(161, 161, 170, 0.24));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 1px 2px rgba(0, 0, 0, 0.20);
  color: var(--ag-text-primary, #e4e4e7);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 140ms cubic-bezier(0.22, 1, 0.36, 1), transform 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

html[data-agy-theme="light"] #agy-quick-capsule-bar button.agy-qcap-btn {
  background: var(--ag-accent-bg, rgba(10, 10, 12, 0.055));
  border-color: var(--ag-accent-border, rgba(10, 10, 12, 0.14));
  color: var(--ag-text-primary, #18181b);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85), 0 1px 2px rgba(10, 10, 12, 0.06);
}

#agy-quick-capsule-bar button.agy-qcap-btn .agy-qcap-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--ag-text-muted, #a1a1aa);
  opacity: 0.88;
  transition: color 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

#agy-quick-capsule-bar button.agy-qcap-btn .agy-qcap-icon svg {
  display: block;
}

#agy-quick-capsule-bar button.agy-qcap-btn .agy-qcap-label {
  display: inline-block;
  white-space: nowrap;
  line-height: 1;
}

#agy-quick-capsule-bar button.agy-qcap-btn:hover:not(:disabled) {
  background: var(--ag-accent-bg-hover, rgba(161, 161, 170, 0.20));
  border-color: var(--ag-accent-border-hover, rgba(161, 161, 170, 0.42));
  color: var(--ag-text-primary, #ffffff);
  transform: translateY(-0.5px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 2px 6px rgba(0, 0, 0, 0.26);
}

html[data-agy-theme="light"] #agy-quick-capsule-bar button.agy-qcap-btn:hover:not(:disabled) {
  background: var(--ag-accent-bg-hover, rgba(10, 10, 12, 0.095));
  border-color: var(--ag-accent-border-hover, rgba(10, 10, 12, 0.24));
  color: var(--ag-text-primary, #0a0a0c);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.92), 0 2px 5px rgba(10, 10, 12, 0.09);
}

#agy-quick-capsule-bar button.agy-qcap-btn:hover:not(:disabled) .agy-qcap-icon {
  color: currentColor;
  opacity: 1;
}

#agy-quick-capsule-bar button.agy-qcap-btn:active:not(:disabled) {
  transform: translateY(1px) scale(0.975);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28);
}

html[data-agy-theme="light"] #agy-quick-capsule-bar button.agy-qcap-btn:active:not(:disabled) {
  box-shadow: inset 0 1px 2px rgba(10, 10, 12, 0.14);
}

#agy-quick-capsule-bar button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

#agy-quick-capsule-bar button:focus-visible,
#agy-next-step-ghost:focus-visible,
#agy-next-step-ghost button:focus-visible,
#agy-prompt-opt-wrap button:focus-visible {
  outline: 2px solid var(--ag-focus-ring, rgba(113, 113, 122, 0.45));
  outline-offset: 2px;
}

#agy-quick-capsule-bar button.agy-qcap-btn[data-context-suggested="true"] {
  border-style: dashed;
  border-color: var(--ag-accent-border-hover, rgba(161, 161, 170, 0.42));
  background: var(--ag-bg-subcard, rgba(161, 161, 170, 0.10));
}

#agy-quick-capsule-bar button.agy-qcap-btn[data-risk="warn"] {
  border-color: rgba(245, 158, 11, 0.55);
  background: rgba(245, 158, 11, 0.14);
  color: var(--ag-ring-warn, #f59e0b);
}

#agy-quick-capsule-bar button.agy-qcap-btn[data-risk="danger"] {
  border-color: rgba(239, 68, 68, 0.65);
  background: rgba(239, 68, 68, 0.16);
  color: var(--ag-ring-danger, #ef4444);
}

#agy-quick-capsule-bar button.agy-qcap-btn[data-risk="warn"] .agy-qcap-icon,
#agy-quick-capsule-bar button.agy-qcap-btn[data-risk="danger"] .agy-qcap-icon {
  color: currentColor;
  opacity: 0.95;
}

#agy-qcap-toast {
  position: sticky;
  right: 0;
  z-index: 2;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  height: 23px;
  padding: 0 9px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--ag-text-secondary, #52525b);
  background: var(--ag-bg-panel, var(--background, #18181b));
  border: 1px solid var(--ag-border-card, rgba(113, 113, 122, 0.24));
  white-space: nowrap;
}

#agy-qcap-toast[data-tone="error"] {
  color: var(--ag-ring-danger, #ef4444);
  border-color: rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.12);
}

#agy-qcap-toast[hidden] {
  display: none !important;
}

#agy-next-step-ghost {
  position: sticky;
  right: 0;
  z-index: 2;
  margin-left: auto;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding-left: 8px;
  background: var(--ag-bg-panel, var(--background, #18181b));
  box-shadow: -10px 0 12px -4px var(--ag-bg-panel, var(--background, #18181b));
  white-space: nowrap;
}

#agy-next-step-ghost[hidden] {
  display: none !important;
}

#agy-next-step-ghost .agy-ns-accept {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  border: 1px dashed var(--ag-border-card, rgba(113, 113, 122, 0.36));
  background: var(--ag-bg-subcard, rgba(113, 113, 122, 0.10));
  color: var(--ag-text-secondary, #a1a1aa);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

#agy-next-step-ghost .agy-ns-accept:hover {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.18));
  border-color: var(--ag-accent-border-hover, rgba(113, 113, 122, 0.54));
  color: var(--ag-text-primary, #f4f4f5);
}

#agy-next-step-ghost .agy-ns-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  opacity: 0.85;
}

#agy-next-step-ghost .agy-ns-prefix {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--ag-text-muted, #71717a);
  flex-shrink: 0;
}

#agy-next-step-ghost .agy-ns-text {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ag-text-primary, inherit);
}

#agy-next-step-ghost .agy-ns-kbd {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 500;
  line-height: 1;
  background: var(--ag-bg-control, rgba(113, 113, 122, 0.16));
  border: 1px solid var(--ag-border-subcard, rgba(113, 113, 122, 0.24));
  color: var(--ag-text-muted, #a1a1aa);
  flex-shrink: 0;
}

#agy-next-step-ghost .agy-ns-cycle {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 500;
  border: 1px solid var(--ag-border-subcard, rgba(113, 113, 122, 0.24));
  background: var(--ag-bg-control, rgba(113, 113, 122, 0.08));
  color: var(--ag-text-muted, #a1a1aa);
  cursor: pointer;
  flex-shrink: 0;
}

#agy-next-step-ghost .agy-ns-cycle:hover {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.16));
  color: var(--ag-text-primary, #f4f4f5);
}

#agy-next-step-ghost .agy-ns-cycle[hidden] {
  display: none !important;
}

#agy-prompt-opt-wrap {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  width: 100%;
  box-sizing: border-box;
  padding: 2px 10px 4px 10px;
  margin: 0;
  flex-shrink: 0;
  pointer-events: none;
}

#agy-prompt-opt-wrap button {
  pointer-events: auto;
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid var(--ag-border-card, rgba(113, 113, 122, 0.24));
  background: var(--ag-bg-control, rgba(113, 113, 122, 0.08));
  color: var(--ag-text-secondary, #a1a1aa);
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color 140ms cubic-bezier(0.22, 1, 0.36, 1), border-color 140ms cubic-bezier(0.22, 1, 0.36, 1), color 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms cubic-bezier(0.22, 1, 0.36, 1);
}

#agy-prompt-opt-wrap button:hover:not(:disabled) {
  background: var(--ag-bg-control-hover, rgba(113, 113, 122, 0.18));
  border-color: var(--ag-accent-border-hover, rgba(113, 113, 122, 0.45));
  color: var(--ag-text-primary, #ffffff);
}

#agy-prompt-opt-wrap button:disabled {
  opacity: 0.36;
  cursor: not-allowed;
  pointer-events: none;
}

#agy-prompt-opt-wrap button[data-loading="true"] {
  opacity: 0.92;
  color: var(--ag-text-primary, #e4e4e7);
  cursor: wait;
  pointer-events: none;
}

#agy-prompt-opt-wrap button[hidden],
#agy-prompt-opt-btn[hidden],
#agy-prompt-undo-btn[hidden] {
  display: none !important;
}

#agy-prompt-opt-wrap svg {
  display: block;
  flex-shrink: 0;
}

.agy-opt-spin {
  display: block;
  width: 14px;
  height: 14px;
  transform-origin: center;
  animation: agy-opt-spin 0.75s linear infinite;
  will-change: transform;
  flex-shrink: 0;
}

@media (max-width: 768px), (pointer: coarse) {
  .surface-composer,
  [data-testid="agent-input-box"] {
    margin-bottom: max(14px, env(safe-area-inset-bottom, 0px)) !important;
  }
}
`.trim();

module.exports = {
  COMPOSER_STYLES
};
