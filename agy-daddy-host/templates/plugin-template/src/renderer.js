'use strict';

let disposers = [];

function mount(ctx) {
  const removeUnit = ctx.topbar.registerUnit({
    id: 'hello-badge',
    order: 90,
    label: 'Hello',
    onClick: () => {}
  });
  const stopTimer = ctx.schedule.every(10000, () => {});
  const stopAnchor = ctx.anchors.observe('topbar.rightCluster', () => {});
  const stopState = ctx.state.subscribe('state:hello.greeting@1', () => {});
  disposers.push(removeUnit, stopTimer, stopAnchor, stopState);
}

function dispose() {
  for (const fn of disposers) {
    try { if (typeof fn === 'function') fn(); } catch {}
  }
  disposers = [];
}

module.exports = { mount, dispose };
