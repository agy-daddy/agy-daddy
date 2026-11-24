'use strict';

const CONTEXT_PANEL_CSS = `
/* Context Panel — Flat hairline-divided layout with @container responsiveness */

#agy-context-panel {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.ag-ctx-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 10px;
}

.ag-ctx-model-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.ag-ctx-model {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ag-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ag-ctx-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid var(--ag-border-card);
  background: var(--ag-bg-subcard);
  color: var(--ag-text-secondary);
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background-color 140ms var(--ag-ease-out), border-color 140ms var(--ag-ease-out), color 140ms var(--ag-ease-out);
}

.ag-ctx-refresh:hover {
  background: var(--ag-bg-control-hover);
  border-color: var(--ag-accent-border);
  color: var(--ag-text-primary);
}

.ag-ctx-refresh:focus-visible {
  outline: 2px solid var(--ag-focus-ring);
  outline-offset: 2px;
}

.ag-ctx-section {
  padding: 10px 0;
  border-top: 1px solid var(--ag-border-subcard);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.ag-ctx-sec-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.ag-ctx-sec-title {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--ag-text-secondary);
}

.ag-ctx-sec-meta {
  font-size: 11px;
  color: var(--ag-text-muted);
  white-space: nowrap;
}

.ag-ctx-hero-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.ag-ctx-hero-val {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--ag-text-primary);
}

.ag-ctx-hero-budget {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--ag-text-muted);
  letter-spacing: 0;
}

.ag-ctx-hero-pct {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ag-text-secondary);
}

.ag-ctx-hero-pct[data-tone="warn"] {
  color: var(--ag-ring-warn, #f59e0b);
}

.ag-ctx-hero-pct[data-tone="danger"] {
  color: var(--ag-ring-danger, #ef4444);
}

.ag-ctx-track {
  position: relative;
  width: 100%;
  height: 6px;
  border-radius: 999px;
  background: var(--ag-bg-control);
  overflow: visible;
}

.ag-ctx-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--ag-text-primary);
  transition: width 240ms var(--ag-ease-out);
}

.ag-ctx-fill[data-tone="warn"] {
  background: var(--ag-ring-warn, #f59e0b);
}

.ag-ctx-fill[data-tone="danger"] {
  background: var(--ag-ring-danger, #ef4444);
}

.ag-ctx-tick {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 1.5px;
  border-radius: 1px;
  background: var(--ag-text-muted);
  opacity: 0.45;
  pointer-events: none;
}

.ag-ctx-tick[data-kind="cliff"] {
  opacity: 0.65;
}

.ag-ctx-metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px 10px;
}

@container (max-width: 339px) {
  .ag-ctx-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 12px;
  }
}

.ag-ctx-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ag-ctx-metric-label {
  font-size: 10.5px;
  color: var(--ag-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ag-ctx-metric-val {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ag-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ag-ctx-subline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px 10px;
  font-size: 11px;
  color: var(--ag-text-muted);
}

.ag-ctx-alerts {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.ag-ctx-empty {
  padding: 14px 4px 6px;
  border-top: 1px solid var(--ag-border-subcard);
  font-size: 12px;
  color: var(--ag-text-muted);
}

.ag-ctx-help {
  margin-top: 2px;
  padding-top: 8px;
  border-top: 1px solid var(--ag-border-subcard);
  font-size: 11px;
  color: var(--ag-text-muted);
}

.ag-ctx-help summary {
  cursor: pointer;
  list-style: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--ag-text-muted);
  user-select: none;
  transition: color 140ms var(--ag-ease-out);
}

.ag-ctx-help summary::-webkit-details-marker {
  display: none;
}

.ag-ctx-help summary:hover {
  color: var(--ag-text-secondary);
}

.ag-ctx-help-list {
  margin: 6px 0 0;
  padding-left: 14px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  line-height: 1.45;
}
`.trim();

module.exports = {
  CONTEXT_PANEL_CSS
};
