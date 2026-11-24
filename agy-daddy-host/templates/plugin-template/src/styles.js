'use strict';

const HELLO_STYLES = `
/* Built-in Example Hello Plugin Styles (auto-follows host --ag-* theme tokens) */

[data-agy-slot="unit:example.hello:hello-badge"] {
  border-color: var(--ag-border-card, rgba(113, 113, 122, 0.24));
  color: var(--ag-custom-token-accent, var(--ag-text-primary, currentColor));
}
`.trim();

module.exports = {
  HELLO_STYLES
};
