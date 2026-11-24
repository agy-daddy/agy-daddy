'use strict';

const HELLO_TEMPLATE_STYLES = `
/* Example Hello Plugin Styles (auto-follows host --ag-* theme tokens) */

.agy-hello-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--ag-bg-card, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--ag-border-card, rgba(255, 255, 255, 0.09));
  color: var(--ag-text-primary, #ececef);
}

.agy-hello-greeting {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ag-custom-token-accent, var(--ag-text-primary, #18181b));
}

.agy-hello-meta {
  font-size: 11px;
  color: var(--ag-text-muted, #a1a1aa);
}

.agy-hello-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
`.trim();

module.exports = {
  HELLO_TEMPLATE_STYLES
};
