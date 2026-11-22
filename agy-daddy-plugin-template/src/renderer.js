'use strict';

let disposers = [];

async function mount(ctx) {
  const stopUnit = ctx.topbar.registerUnit({
    id: 'hello-badge',
    order: 90,
    label: 'Hello',
    render(node) {
      if (node.style && typeof node.style.setProperty === 'function') {
        node.style.setProperty('border-color', 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))');
      }
    },
    onClick() {
      void ctx.bridge.post('/greet', {}).catch(() => {});
    }
  });
  disposers.push(stopUnit);
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = { mount, dispose };
